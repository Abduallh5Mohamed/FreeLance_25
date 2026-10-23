/**
 * M2-B05 — private course-lesson metadata for the VERIFIED institution owner.
 *
 * Contract: docs/streams/server/M2-B05-CONTRACT.md
 * Handoff:  docs/streams/server/M2-B05-HANDOFF.md
 *
 * A course lesson is private METADATA: a title, an optional description, a
 * display position and a status. This module adds no lesson delivery, no
 * content or asset reference, no student entitlement, no publication, no drip
 * or progression rule, no payment and no upload rule. It never changes the
 * access of an existing course, unit or material, and it never moves a lesson
 * to another unit or a unit to another course. Archiving a lesson is a
 * metadata change only.
 *
 * The module is deliberately self-contained:
 *   * it imports `AuthRequest` as a TYPE only, so it pulls in no
 *     authentication, database, provider or environment module at runtime;
 *   * it has no default export and binds no production adapter — the
 *     transactional connection supplier is injected by the caller;
 *   * every statement of one request runs on the injected connection, so the
 *     authorization, the parent scope proof, the writes and their audit
 *     events share ONE transaction.
 *
 * The tenant is never taken from the request: it is the server-selected
 * scope on the authenticated principal, it is re-verified against the real
 * `tenants.owner_user_id` row, and every lesson row is reached only through
 * its unit and its course, which must belong to that selected tenant.
 */
import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';

/**
 * Minimal transactional connection seam, structurally identical to the
 * course-unit and tenant-self seams. Production binds a real mysql2
 * PoolConnection (getPool().getConnection()); hermetic tests bind a
 * fixture-backed connection so the real handler and authorization logic runs
 * without a database, a network or a live app startup.
 */
export interface CourseLessonConnection {
  beginTransaction(): Promise<void>;
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  /**
   * Discard the physical connection instead of returning it to the shared
   * pool, so an uncertain transaction can never be recycled into a later
   * request.
   */
  destroy(): void;
}

/** The only dependency of this router: a transactional connection supplier. */
export interface CourseLessonsDeps {
  getConnection: () => Promise<CourseLessonConnection>;
}

/** A lesson status is only 'active' or 'archived'. */
const LESSON_STATUSES: readonly string[] = ['active', 'archived'];
/** A lesson title is a trimmed free label of 1..255 characters. */
const TITLE_MAX = 255;
/** An engineering bound on the optional free-text description. */
const DESCRIPTION_MAX = 10000;
/** Bounded keyset page: default 25, maximum 100. */
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
/** display_order is a nonnegative signed 32-bit integer. */
const DISPLAY_ORDER_MAX = 2147483647;
/** A course, unit and lesson id are server-generated UUIDs. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The opaque cursor is bounded so a hostile value cannot be used as a probe. */
const CURSOR_MAX_LENGTH = 256;
/** One atomic reorder batch is bounded to 100 selected lessons. */
const REORDER_MAX_ITEMS = 100;

/**
 * The canonical identity of a lesson UUID.
 *
 * The declared `course_lessons.id` column is `CHAR(36)` in a
 * `utf8mb4_unicode_ci` table, so MySQL compares the id CASE-INSENSITIVELY:
 * an uppercase UUID addresses exactly the same stored row as its lowercase
 * spelling. The identity the server works with must therefore be the SAME for
 * every case variant, otherwise one lesson could be addressed under two
 * identities: two spellings of one id would pass the uniqueness check and
 * reach the locks as two rows, and the locked row could not be found again
 * under the spelling that was requested.
 *
 * The canonical identity is the lowercase form of a VALID uuid. It identifies
 * the addressed ROW; it never rewrites the stored spelling: the response DTO
 * and the audit event keep the stored id.
 */
const canonicalUuidIdentity = (value: string): string => value.toLowerCase();

/**
 * Render a stored instant as UTC ISO-8601 from its Unix EPOCH SECONDS.
 *
 * The lesson timestamps are read with `UNIX_TIMESTAMP(col)`, never as a driver
 * datetime value. The installed mysql2 pool is configured with
 * `timezone: '+02:00'`, and the driver uses that value to INTERPRET the
 * wall time it receives: it is a client-side conversion, NOT a
 * `SET SESSION time_zone` statement, so it does not configure a SQL session
 * offset. A TIMESTAMP stored as `12:00:00` in a UTC session is therefore
 * decoded by that driver as `10:00Z`, which would shift every serialized
 * instant by the offset of the day. Projecting the stored instant as epoch
 * seconds removes the driver interpretation entirely: the serialized value
 * is the stored instant itself and does not depend on the session time
 * zone, on the driver offset or on a daylight-saving transition.
 *
 * A missing, malformed, non-positive or unrepresentable epoch is REFUSED:
 * no 1970 instant, no "now" and no null date is ever fabricated.
 */
const EPOCH_SECONDS_PATTERN = /^-?\d+(?:\.\d+)?$/;

const toUtcTimestamp = (epochSeconds: unknown): string | null => {
  let epoch: number;
  if (typeof epochSeconds === 'number') {
    epoch = epochSeconds;
  } else if (typeof epochSeconds === 'string') {
    const trimmed = epochSeconds.trim();
    if (!EPOCH_SECONDS_PATTERN.test(trimmed)) return null;
    epoch = Number(trimmed);
  } else {
    return null;
  }
  // Epoch 0 (1970-01-01T00:00:00Z) is not a representable TIMESTAMP instant
  // and is refused with the rest of the malformed values.
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const instant = new Date(epoch * 1000);
  if (Number.isNaN(instant.getTime())) return null;
  return instant.toISOString();
};

/**
 * Explicit lesson DTO. The row is never spread: only the ten documented
 * columns are exposed and no tenant, owner, contact, billing, content or
 * asset field is ever returned. The epoch projections never leak into the
 * DTO.
 *
 * `release_at` is `null` when the lesson has NO schedule (released as soon as
 * it is active), which is exactly what a lesson created before M2-23 carries.
 * `prerequisite_lesson_id` is `null` when the lesson has no prerequisite.
 *
 * A row whose epoch projection cannot be rendered truthfully yields NO DTO
 * at all: the caller has to fail the request instead of answering with a
 * fabricated instant or a null date.
 */
const courseLessonDto = (row: any) => {
  const createdAt = toUtcTimestamp(row?.created_at_epoch);
  const updatedAt = toUtcTimestamp(row?.updated_at_epoch);
  if (createdAt === null || updatedAt === null) return null;
  const releaseAt = releaseInstant(row?.release_at_epoch);
  if (releaseAt === undefined) return null;
  return {
    id: String(row.id),
    unit_id: String(row.unit_id),
    title: String(row.title),
    description: row?.description === null || row?.description === undefined ? null : String(row.description),
    display_order: Number(row.display_order),
    status: String(row.status),
    release_at: releaseAt,
    prerequisite_lesson_id:
      row?.prerequisite_lesson_id === null || row?.prerequisite_lesson_id === undefined
        ? null
        : String(row.prerequisite_lesson_id),
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

/**
 * The read projection of a lesson row.
 *
 * The three instants are projected as epoch seconds (`UNIX_TIMESTAMP`) so
 * the serialized value never depends on the driver offset; the raw
 * datetime columns are deliberately NOT selected.
 */
const LESSON_PROJECTION =
  'l.id,l.unit_id,l.title,l.description,l.display_order,l.status,' +
  'UNIX_TIMESTAMP(l.release_at) AS release_at_epoch,l.prerequisite_lesson_id,' +
  'UNIX_TIMESTAMP(l.created_at) AS created_at_epoch,' +
  'UNIX_TIMESTAMP(l.updated_at) AS updated_at_epoch';

/**
 * Opaque list cursor. It encodes the POSITION of the last row of the
 * previous page — its display order and its id — and nothing else. It never
 * carries authority: the page is still qualified by the unit, the unit is
 * still qualified by the course, and the course is still qualified by the
 * server-selected tenant.
 */
const encodeLessonCursor = (displayOrder: number, id: string): string =>
  Buffer.from(`${displayOrder}:${id}`, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const decodeLessonCursor = (cursor: unknown): { displayOrder: number; id: string } | null => {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(\d{1,10}):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(decoded);
  if (!match) return null;
  const displayOrder = Number(match[1]);
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > DISPLAY_ORDER_MAX) return null;
  const id = match[2];
  // The cursor is canonical: only the exact encoding this server mints is
  // accepted, so one position has one representation.
  if (encodeLessonCursor(displayOrder, id) !== cursor) return null;
  return { displayOrder, id };
};

/** Strict page-size parsing: an integer 1..100, default 25. */
const parseLessonLimit = (raw: unknown): number | null => {
  if (raw === undefined) return PAGE_DEFAULT;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > PAGE_MAX) return null;
  return value;
};

/** Strict title validation: a string that trims to 1..255 characters. */
const parseTitle = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const title = raw.trim();
  if (title.length < 1 || title.length > TITLE_MAX) return null;
  return title;
};

/**
 * Strict description validation: `null` or a string of at most 10000
 * characters. The text is stored verbatim — it is a free description, not a
 * label, so it is never trimmed and no markup/URL rule is inferred here.
 */
const parseDescription = (raw: unknown): string | null | undefined => {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  if (raw.length > DESCRIPTION_MAX) return undefined;
  return raw;
};

/**
 * Strict display-order validation. The value must already BE an integer in
 * 0..2147483647: a numeric string, a float or a boolean is rejected, never
 * coerced.
 */
const parseDisplayOrder = (raw: unknown): number | null => {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw > DISPLAY_ORDER_MAX) return null;
  return raw;
};

/** Strict status validation: exactly 'active' or 'archived'. */
const parseStatus = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !LESSON_STATUSES.includes(raw)) return null;
  return raw;
};

// ---------------------------------------------------------------------------
// M2-23 — explicit UTC release instant and configured prerequisite
// ---------------------------------------------------------------------------

/**
 * A release instant is an EXPLICIT UTC ISO-8601 string with a `Z` designator.
 *
 * A local-time string, a date-only string, an offset other than `Z` and a bare
 * epoch number are all refused: the caller has to state the instant it means in
 * UTC rather than leaving the server to infer a time zone. Nothing here reads
 * the host clock, the server locale or a per-tenant time zone — no timezone
 * policy is invented.
 */
const RELEASE_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * The representable TIMESTAMP range, in epoch seconds: 1970-01-01T00:00:01Z ..
 * 2038-01-19T03:14:07Z. An instant outside it is REFUSED instead of being
 * silently truncated by the column type.
 */
const TIMESTAMP_EPOCH_MIN = 1;
const TIMESTAMP_EPOCH_MAX = 2147483647;

/**
 * A defensive bound on the stored prerequisite chain the handler walks before a
 * write. Every edge this API permits points strictly BACKWARDS under
 * `(display_order, id)`, so a cycle is unreachable through the API; the walk
 * exists to detect one introduced out of band and refuse to extend it. A chain
 * longer than this bound cannot be proven acyclic, so it is refused rather than
 * assumed safe.
 */
const PREREQUISITE_CHAIN_MAX = 512;

type ReleaseParse = { ok: true; epoch: number | null } | { ok: false };

/**
 * Parse an explicit nullable release instant.
 *
 * `null` is the explicit CLEAR ("no schedule" — released immediately). A string
 * is normalised to WHOLE epoch seconds, so a retried request carrying the same
 * instant is a truthful no-op instead of a rewrite that would differ only in a
 * sub-second remainder the TIMESTAMP column cannot store.
 */
const parseReleaseAt = (raw: unknown): ReleaseParse => {
  if (raw === null) return { ok: true, epoch: null };
  if (typeof raw !== 'string') return { ok: false };
  const match = RELEASE_ISO_PATTERN.exec(raw);
  if (!match) return { ok: false };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false };
  if (hour > 23 || minute > 59 || second > 59) return { ok: false };
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(utc);
  // `Date.UTC` normalises an impossible calendar date (2026-02-30 becomes
  // 2026-03-02); a normalised value is not the instant the caller wrote.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { ok: false };
  }
  const epoch = Math.floor(utc / 1000);
  if (!Number.isFinite(epoch) || epoch < TIMESTAMP_EPOCH_MIN || epoch > TIMESTAMP_EPOCH_MAX) {
    return { ok: false };
  }
  return { ok: true, epoch };
};

type PrerequisiteParse = { ok: true; id: string | null } | { ok: false };

/**
 * Parse an explicit nullable prerequisite selector.
 *
 * `null` is the explicit CLEAR ("no prerequisite"). A string must be a uuid and
 * is canonicalised, so the case variants of one id are ONE identity — the
 * declared `utf8mb4_unicode_ci` collation compares them that way, so accepting
 * two spellings as two lessons would let a self-reference slip past a naive
 * equality check.
 */
const parsePrerequisiteId = (raw: unknown): PrerequisiteParse => {
  if (raw === null) return { ok: true, id: null };
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) return { ok: false };
  return { ok: true, id: canonicalUuidIdentity(raw) };
};

/**
 * Render an optional stored release epoch as a UTC ISO-8601 instant.
 *
 * `null` means "no schedule". `undefined` means the stored value could not be
 * rendered truthfully, and the caller must FAIL the request rather than answer
 * with a fabricated instant or a silently nulled date.
 */
const releaseInstant = (epochSeconds: unknown): string | null | undefined => {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  return toUtcTimestamp(epochSeconds) ?? undefined;
};

/** One selected reorder entry: a canonical id and its new integer position. */
interface ReorderItem {
  id: string;
  displayOrder: number;
}

/**
 * Strict reorder payload: exactly `{items:[{id,display_order}]}` with 1..100
 * unique canonical ids and already-integer positions. Any other key, a
 * duplicate id, a non-integer position or an out-of-range length is
 * rejected — nothing is coerced and nothing is truncated.
 *
 * The uniqueness is checked on the CANONICAL id identity: the case variants
 * of one uuid are one identity (the declared collation compares them that
 * way), so a batch that names the same lesson twice in two spellings is a
 * duplicate batch and is refused HERE — before a connection is taken.
 */
const parseReorderItems = (raw: unknown): ReorderItem[] | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'items') return null;
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  if (items.length < 1 || items.length > REORDER_MAX_ITEMS) return null;
  const parsed: ReorderItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const itemKeys = Object.keys(item);
    if (itemKeys.length !== 2) return null;
    for (const key of itemKeys) {
      if (key !== 'id' && key !== 'display_order') return null;
    }
    const rawId = (item as Record<string, unknown>).id;
    if (typeof rawId !== 'string' || !UUID_PATTERN.test(rawId)) return null;
    // ONE identity per addressed row: the case variants of one uuid name the
    // same lesson, so they are one identity here and a duplicate is refused
    // before any connection is taken.
    const id = canonicalUuidIdentity(rawId);
    if (seen.has(id)) return null;
    seen.add(id);
    const order = parseDisplayOrder((item as Record<string, unknown>).display_order);
    if (order === null) return null;
    parsed.push({ id, displayOrder: order });
  }
  return parsed;
};

/** The outcome of one transactional unit of work. */
interface TxResult {
  status: number;
  body: any;
  /** True only when the work must be committed; denials and no-ops roll back. */
  commit: boolean;
}

export const createCourseLessonsRouter = (deps: CourseLessonsDeps): Router => {
  const router = Router();
  const { getConnection } = deps;

  /**
   * Local billing-only denial.
   *
   * `middleware/auth.ts` exempts the WHOLE /api/tenants/me prefix from the
   * instructor billing-only path restriction, so merely mounting a route
   * below that prefix does NOT enforce the denial. Each lesson route
   * therefore checks `req.user.billingOnly` itself and refuses BEFORE any
   * connection is taken. The shared authentication middleware and its
   * exemptions are not touched.
   */
  const denyBillingOnly = (req: AuthRequest, res: Response): boolean => {
    if (!req.user?.billingOnly) return false;
    res.status(403).json({
      error: 'Course lesson management is not available while the account is limited to billing and support',
      code: 'BILLING_ONLY',
    });
    return true;
  };

  /**
   * Verify that the caller is the owner of the SELECTED tenant.
   *
   * The check is resolved from server-side rows only, on the same connection
   * that performs the lesson work: the tenant's real `owner_user_id`, its
   * status and the caller's own active user row. A membership role label
   * (`owner`/`instructor`) never grants lesson visibility or writes, and a
   * global teacher/admin role is not a tenant owner at all.
   *
   * `lock` selects the rows FOR UPDATE so a write cannot race an ownership
   * change. The list read uses a plain snapshot select inside its own
   * transaction, so the verification and the page read share one snapshot
   * without taking an exclusive lock on a read path.
   */
  const verifyTenantOwner = async (
    connection: CourseLessonConnection,
    userId: string,
    tenantId: string,
    lock: boolean
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`,
      [userId, tenantId]
    );
    const row = (rows as any[])[0];
    if (!row || String(row.owner_user_id) !== userId || row.tenant_status !== 'active' || Number(row.caller_active) !== 1) {
      return null;
    }
    return row;
  };

  /**
   * Resolve the course inside the SELECTED tenant.
   *
   * The course must exist, be active and belong to the selected tenant. The
   * tenant is derived from the course on the same connection, so a lesson row
   * is never reachable through a foreign or inactive course. A null, foreign
   * and inactive course produce the identical not-found result.
   */
  const resolveCourse = async (
    connection: CourseLessonConnection,
    courseId: string,
    tenantId: string,
    lock: boolean
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT c.id,c.tenant_id FROM courses c
       WHERE c.id=? AND c.tenant_id=? AND c.is_active=1${lock ? ' FOR UPDATE' : ''}`,
      [courseId, tenantId]
    );
    return (rows as any[])[0] ?? null;
  };

  /**
   * Resolve the parent unit of the path.
   *
   * The unit must exist AND belong to the course of the path; the course is
   * already tenant-qualified, so the unit is reachable only inside the
   * selected tenant. An ARCHIVED unit is still private owner-manageable
   * metadata, so its status is deliberately not filtered here. A foreign,
   * absent or course-mismatched unit produces the identical not-found result.
   */
  const resolveUnit = async (
    connection: CourseLessonConnection,
    unitId: string,
    courseId: string,
    lock: boolean
  ): Promise<any | null> => {
    const [rows] = await connection.execute(
      `SELECT u.id,u.course_id FROM course_units u
       WHERE u.id=? AND u.course_id=?${lock ? ' FOR UPDATE' : ''}`,
      [unitId, courseId]
    );
    return (rows as any[])[0] ?? null;
  };

  /**
   * Run ONE transactional unit of work on ONE connection.
   *
   * The lifecycle is explicit and identical for every route:
   *   * a failed acquisition performs no cleanup for a connection that does
   *     not exist;
   *   * a failed `beginTransaction` DESTROYS the unconfirmed connection
   *     instead of pooling a possibly-dirty session;
   *   * after the transaction started, a denial / no-op / conflict rolls back
   *     and releases exactly once, and a success commits and releases exactly
   *     once;
   *   * a failed rollback destroys exactly once and never releases;
   *   * a lost commit acknowledgement is an UNCERTAIN persistence state: no
   *     rollback is claimed, no silent retry happens and the connection is
   *     destroyed instead of being returned to the shared pool.
   */
  const runInTransaction = async (
    label: string,
    res: Response,
    work: (connection: CourseLessonConnection) => Promise<TxResult>
  ): Promise<Response> => {
    let connection: CourseLessonConnection | null = null;
    let transactionStarted = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
      try {
        await connection!.rollback();
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error(`Rollback ${label} error (connection will be discarded):`, rollbackError);
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      if (!result.commit) {
        await rollbackOrDiscard();
        return res.status(result.status).json(result.body);
      }
      commitAttempted = true;
      await connection.commit();
      return res.status(result.status).json(result.body);
    } catch (error) {
      if (commitAttempted) {
        // The commit acknowledgement was lost: whether the write persisted is
        // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
        // never return this connection to the pool.
        disposal = 'destroy';
        console.error(`${label} error after commit attempt (persistence uncertain):`, error);
      } else if (transactionStarted) {
        console.error(`${label} error:`, error);
        await rollbackOrDiscard();
      } else {
        // The connection exists but its transaction state is not confirmed.
        // Discard rather than pooling a possibly-dirty session.
        disposal = 'destroy';
        console.error(`${label} error before transaction start:`, error);
      }
      return res.status(500).json({ error: label });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  };

  /**
   * Validate one requested prerequisite for a lesson of the bound course.
   *
   * A prerequisite is valid only when ALL of these hold:
   *   * it is not the target itself (compared on the CANONICAL id identity, so
   *     a case variant of the target's own uuid cannot slip past);
   *   * the row exists and its unit belongs to the SAME course as the target —
   *     a lesson of another course, another tenant or no course at all is
   *     refused identically;
   *   * it is ACTIVE: an archived lesson is not part of the learning path, so it
   *     can never gate one;
   *   * it sorts strictly BEFORE the target under the list's own total order
   *     `(display_order, id)`. This is what makes a cycle unreachable through
   *     this API: every permitted edge points strictly backwards in one fixed
   *     total order.
   *
   * The stored chain is then walked (bounded) so an out-of-band cycle is
   * detected and refused instead of extended.
   *
   * `targetDisplayOrder` is the target's FINAL position, so a patch that moves
   * the target and sets its prerequisite in the same request is judged against
   * the position the row will actually have.
   */
  const resolvePrerequisite = async (
    connection: CourseLessonConnection,
    courseId: string,
    targetLessonId: string,
    targetDisplayOrder: number,
    prerequisiteId: string
  ): Promise<boolean> => {
    const targetIdentity = canonicalUuidIdentity(targetLessonId);
    if (canonicalUuidIdentity(prerequisiteId) === targetIdentity) return false;

    const [rows] = await connection.execute(
      `SELECT l.id,l.status,l.display_order,l.prerequisite_lesson_id,u.course_id
       FROM course_lessons l JOIN course_units u ON u.id=l.unit_id
       WHERE l.id=? LIMIT 1`,
      [prerequisiteId]
    );
    const prerequisite = (rows as any[])[0];
    if (!prerequisite) return false;
    if (String(prerequisite.course_id) !== courseId) return false;
    if (String(prerequisite.status) !== 'active') return false;

    const order = Number(prerequisite.display_order);
    if (!Number.isInteger(order) || order < 0) return false;
    const earlier =
      order < targetDisplayOrder ||
      (order === targetDisplayOrder &&
        canonicalUuidIdentity(String(prerequisite.id)) < targetIdentity);
    if (!earlier) return false;

    const seen = new Set<string>([canonicalUuidIdentity(prerequisiteId)]);
    let cursor: string | null =
      prerequisite.prerequisite_lesson_id === null || prerequisite.prerequisite_lesson_id === undefined
        ? null
        : String(prerequisite.prerequisite_lesson_id);
    let hops = 0;
    while (cursor !== null) {
      // An unprovable chain is refused rather than assumed acyclic.
      if (hops >= PREREQUISITE_CHAIN_MAX) return false;
      hops += 1;
      const identity = canonicalUuidIdentity(cursor);
      if (identity === targetIdentity) return false;
      if (seen.has(identity)) return false;
      seen.add(identity);
      const [chainRows] = await connection.execute(
        'SELECT l.id,l.prerequisite_lesson_id FROM course_lessons l WHERE l.id=? LIMIT 1',
        [cursor]
      );
      const next = (chainRows as any[])[0];
      cursor =
        next && next.prerequisite_lesson_id !== null && next.prerequisite_lesson_id !== undefined
          ? String(next.prerequisite_lesson_id)
          : null;
    }
    return true;
  };

  /**
   * GET /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons —
   * owner-only bounded list of the private lesson metadata of one unit.
   *
   * The list is deterministic PER REQUEST and bounded: rows are ordered by
   * (display_order, id) — a total order over the rows the request reads,
   * which needs no timestamp or timezone interpretation — and read with a
   * keyset cursor, so no page is unbounded and no offset is used. The default
   * page size is 25 and the maximum is 100. The cursor is opaque and only a
   * POSITION: it never carries authority, because the page is still
   * qualified by the unit, the unit by the course and the course by the
   * selected tenant. Archived lessons are included: the owner sees the
   * private metadata of the unit, and nothing is published.
   *
   * The cursor is a position, NOT a snapshot. `display_order` is mutable, so
   * the pages of one traversal are NOT a snapshot of the unit: a lesson that
   * is moved after a page was served can reappear on a later page, and a
   * lesson that is moved before the cursor position can be omitted from the
   * remaining pages. Each single page is internally consistent and
   * deterministic for the rows it reads, but there is NO cross-request
   * snapshot and no stable-once guarantee under a concurrent reorder. No
   * snapshot token, version policy or ordering freeze is provided here.
   */
  router.get('/courses/:courseId/units/:unitId/lessons', async (req: AuthRequest, res: Response) => {
    // The cache directive is applied before the first await and before any
    // denial, so every outcome this handler produces carries it.
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(400).json({ error: 'Invalid course id' });
    }
    const unitId = String(req.params?.unitId ?? '');
    if (!UUID_PATTERN.test(unitId)) {
      return res.status(400).json({ error: 'Invalid course unit id' });
    }
    const limit = parseLessonLimit(req.query?.limit);
    if (limit === null) return res.status(400).json({ error: 'Invalid course lesson list limit' });
    const rawCursor = req.query?.cursor;
    // An absent cursor starts at the beginning of the unit's lessons. The
    // sentinel order -1 is below every stored display_order, and the empty
    // id sorts before every uuid, so the first page is the whole unit.
    const cursor = rawCursor === undefined ? { displayOrder: -1, id: '' } : decodeLessonCursor(rawCursor);
    if (cursor === null) return res.status(400).json({ error: 'Invalid course lesson list cursor' });

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    return runInTransaction('Failed to list course lessons', res, async (connection) => {
      // The owner is determined BEFORE the course is looked up, so a
      // non-owner learns nothing about whether a course exists.
      const owner = await verifyTenantOwner(connection, userId, tenantId, false);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      const course = await resolveCourse(connection, courseId, tenantId, false);
      if (!course) return { status: 404, body: { error: 'Course not found' }, commit: false };
      const unit = await resolveUnit(connection, unitId, courseId, false);
      if (!unit) return { status: 404, body: { error: 'Course unit not found' }, commit: false };
      // One extra row is read to learn whether another page exists; only the
      // requested page size is ever returned.
      const [rows] = await connection.execute(
        `SELECT ${LESSON_PROJECTION}
         FROM course_lessons l
         WHERE l.unit_id=? AND (l.display_order>? OR (l.display_order=? AND l.id>?))
         ORDER BY l.display_order ASC, l.id ASC LIMIT ?`,
        [unitId, cursor.displayOrder, cursor.displayOrder, cursor.id, limit + 1]
      );
      const page = (rows as any[]) ?? [];
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      // The DTO is materialized from the epoch projection BEFORE the read
      // transaction is closed. A row whose stored instant cannot be rendered
      // truthfully fails the whole page: a 1970 instant, the current time or
      // a null date is never fabricated.
      const lessons: any[] = [];
      for (const row of visible) {
        const dto = courseLessonDto(row);
        if (dto === null) {
          console.error('List course lessons error: unreadable lesson timestamp projection');
          return { status: 500, body: { error: 'Failed to list course lessons' }, commit: false };
        }
        lessons.push(dto);
      }
      return {
        status: 200,
        body: {
          lessons,
          next_cursor:
            hasMore && visible.length > 0
              ? encodeLessonCursor(Number(visible[visible.length - 1].display_order), String(visible[visible.length - 1].id))
              : null,
        },
        commit: false,
      };
    });
  });

  /**
   * POST /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons —
   * create one private lesson under a unit of an active course of the
   * selected tenant.
   *
   * Owner-only and strict: the payload is `{title}` plus an optional
   * `description` and an optional `display_order`, and any other key (a
   * tenant/course/unit/owner selector, a content, asset, URL, publication,
   * assignment, progression or paid field, a status) is rejected before a
   * connection is taken. The title is trimmed to 1..255 characters; the
   * description is `null` or at most 10000 characters; the order must already
   * be an integer in 0..2147483647 and defaults to 0. The lesson id is
   * server-generated, the unit and the course are the ones named in the path,
   * and the status is always 'active' on create, so a client can never place
   * a lesson under another tenant's unit. Duplicate titles are allowed and the
   * order may tie: the id is the tie-breaker. The insert and its audit event
   * are committed together, and success is reported only after `commit()`
   * resolves. `Cache-Control: no-store` is set before the first await / any
   * denial.
   */
  router.post('/courses/:courseId/units/:unitId/lessons', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(400).json({ error: 'Invalid course id' });
    }
    const unitId = String(req.params?.unitId ?? '');
    if (!UUID_PATTERN.test(unitId)) {
      return res.status(400).json({ error: 'Invalid course unit id' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid course lesson payload' });
    }
    const keys = Object.keys(body);
    if (keys.length < 1 || keys.length > 5) {
      return res.status(400).json({ error: 'Invalid course lesson payload' });
    }
    for (const key of keys) {
      if (
        key !== 'title' && key !== 'description' && key !== 'display_order' &&
        key !== 'release_at' && key !== 'prerequisite_lesson_id'
      ) {
        return res.status(400).json({ error: 'Invalid course lesson payload' });
      }
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'title')) {
      return res.status(400).json({ error: 'Invalid course lesson payload' });
    }
    const title = parseTitle((body as Record<string, unknown>).title);
    if (title === null) return res.status(400).json({ error: 'Invalid course lesson payload' });
    let description: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const parsed = parseDescription((body as Record<string, unknown>).description);
      if (parsed === undefined) return res.status(400).json({ error: 'Invalid course lesson payload' });
      description = parsed;
    }
    let displayOrder = 0;
    if (Object.prototype.hasOwnProperty.call(body, 'display_order')) {
      const parsed = parseDisplayOrder((body as Record<string, unknown>).display_order);
      if (parsed === null) return res.status(400).json({ error: 'Invalid course lesson payload' });
      displayOrder = parsed;
    }
    // A new lesson has no schedule and no prerequisite unless the caller states
    // one, which is exactly what a lesson created before M2-23 carries.
    let releaseEpoch: number | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'release_at')) {
      const parsed = parseReleaseAt((body as Record<string, unknown>).release_at);
      if (parsed.ok === false) return res.status(400).json({ error: 'Invalid course lesson release' });
      releaseEpoch = parsed.epoch;
    }
    let prerequisiteId: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'prerequisite_lesson_id')) {
      const parsed = parsePrerequisiteId((body as Record<string, unknown>).prerequisite_lesson_id);
      if (parsed.ok === false) return res.status(400).json({ error: 'Invalid course lesson prerequisite' });
      prerequisiteId = parsed.id;
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    return runInTransaction('Failed to create course lesson', res, async (connection) => {
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      // The course and the parent unit are locked for the write, so an
      // archive, a move or an ownership change cannot race the insert.
      const course = await resolveCourse(connection, courseId, tenantId, true);
      if (!course) return { status: 404, body: { error: 'Course not found' }, commit: false };
      const unit = await resolveUnit(connection, unitId, courseId, true);
      if (!unit) return { status: 404, body: { error: 'Course unit not found' }, commit: false };
      const lessonId = randomUUID();
      if (prerequisiteId !== null) {
        // The target's id and position are already known, so the ordering rule
        // is judged against the row that is about to exist.
        const valid = await resolvePrerequisite(connection, courseId, lessonId, displayOrder, prerequisiteId);
        if (!valid) return { status: 400, body: { error: 'Invalid course lesson prerequisite' }, commit: false };
      }
      // The release instant is written with `FROM_UNIXTIME(?)`, never as a
      // driver Date: the pool's `timezone:'+02:00'` would re-interpret a Date
      // on the client side and shift the stored instant. An epoch is
      // unambiguous, and `UNIX_TIMESTAMP(col)` reads it back unchanged.
      const releaseValueSql = releaseEpoch === null ? 'NULL' : 'FROM_UNIXTIME(?)';
      const insertParams: any[] = [
        lessonId, unitId, title, description, displayOrder, 'active',
      ];
      if (releaseEpoch !== null) insertParams.push(releaseEpoch);
      insertParams.push(prerequisiteId);
      await connection.execute(
        'INSERT INTO course_lessons (id,unit_id,title,description,display_order,status,release_at,prerequisite_lesson_id)' +
          ` VALUES (?,?,?,?,?,?,${releaseValueSql},?)`,
        insertParams
      );
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'course.lesson_created', 'course_lesson', lessonId,
          null, JSON.stringify({
            course_id: courseId, unit_id: unitId, lesson_id: lessonId, title, display_order: displayOrder, status: 'active',
            release_at: releaseEpoch === null ? null : toUtcTimestamp(releaseEpoch),
            prerequisite_lesson_id: prerequisiteId,
          })]
      );
      // The row is read back inside the same transaction so the response
      // carries the exact stored instant instead of a guessed one.
      const [rows] = await connection.execute(
        `SELECT ${LESSON_PROJECTION}
         FROM course_lessons l WHERE l.id=? AND l.unit_id=? LIMIT 1`,
        [lessonId, unitId]
      );
      const created = (rows as any[])[0];
      if (!created) {
        return { status: 500, body: { error: 'Failed to create course lesson' }, commit: false };
      }
      // The DTO is materialized from the epoch projection INSIDE the
      // transaction and BEFORE the commit: an unreadable stored instant
      // fails the write instead of committing a row whose date could only be
      // guessed.
      const dto = courseLessonDto(created);
      if (dto === null) {
        console.error('Create course lesson error: unreadable lesson timestamp projection');
        return { status: 500, body: { error: 'Failed to create course lesson' }, commit: false };
      }
      return { status: 201, body: { lesson: dto }, commit: true };
    });
  });

  /**
   * POST /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/reorder
   * — atomically set the display position of up to 100 selected lessons of
   * one unit.
   *
   * The payload is ONLY `{items:[{id,display_order}]}`. Every entry is
   * validated (canonical uuid, unique id, already-integer position in
   * 0..2147483647) BEFORE a connection is taken, so a malformed batch touches
   * nothing. Inside ONE transaction the real owner, the active course and the
   * parent unit are locked, then the target lesson rows are locked in a
   * deterministic id order and ALL ids are proven to belong to the bound unit
   * BEFORE any update or audit: a foreign or missing id in the batch is the
   * identical 404 and rolls the whole batch back — there is no partial
   * success. A selected lesson whose position already equals the requested
   * one is a truthful no-op: no UPDATE and no audit event for that row. Each
   * CHANGED row gets one bounded audit event, and the whole batch commits
   * once. Only the positions of the selected lessons move: no other lesson is
   * renumbered, no other resource order or status is touched and no
   * ordering/normalisation policy is claimed.
   *
   * The response carries the canonical DTO of every SELECTED lesson, ordered
   * deterministically by the resulting (display_order, id) — it is not a
   * whole-catalog read and it is not a cross-request snapshot.
   */
  router.post('/courses/:courseId/units/:unitId/lessons/reorder', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(400).json({ error: 'Invalid course id' });
    }
    const unitId = String(req.params?.unitId ?? '');
    if (!UUID_PATTERN.test(unitId)) {
      return res.status(400).json({ error: 'Invalid course unit id' });
    }
    const items = parseReorderItems(req.body);
    if (items === null) return res.status(400).json({ error: 'Invalid course lesson reorder payload' });

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    // Deterministic batch order: the CANONICAL ids are processed and locked in
    // ascending id order, so two batches over the same set cannot deadlock each
    // other by taking the same rows in a different sequence. The canonical
    // identity is the one the whole batch agrees on, so the order does not
    // depend on the spelling the client used.
    const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ids = ordered.map(item => item.id);

    return runInTransaction('Failed to reorder course lessons', res, async (connection) => {
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      const course = await resolveCourse(connection, courseId, tenantId, true);
      if (!course) return { status: 404, body: { error: 'Course not found' }, commit: false };
      const unit = await resolveUnit(connection, unitId, courseId, true);
      if (!unit) return { status: 404, body: { error: 'Course unit not found' }, commit: false };

      // ONE bounded lock read over the selected rows, in id order. Nothing is
      // updated or audited until every id is proven to belong to this unit.
      const placeholders = ids.map(() => '?').join(',');
      const [lockRows] = await connection.execute(
        `SELECT ${LESSON_PROJECTION}
         FROM course_lessons l WHERE l.unit_id=? AND l.id IN (${placeholders})
         ORDER BY l.id ASC FOR UPDATE`,
        [unitId, ...ids]
      );
      const locked = (lockRows as any[]) ?? [];
      // A foreign, absent or unit-mismatched id in the batch is the SAME
      // not-found answer, and the whole batch is rolled back.
      if (locked.length !== ids.length) {
        return { status: 404, body: { error: 'Course lesson not found' }, commit: false };
      }
      // The locked rows are indexed by their CANONICAL identity, so the row
      // that was addressed by an uppercase id is found again under the
      // identity the batch was parsed with.
      const currentById = new Map<string, any>();
      for (const row of locked) currentById.set(canonicalUuidIdentity(String(row.id)), row);

      const changed: Array<{ id: string; from: number; to: number }> = [];
      for (const item of ordered) {
        const current = currentById.get(item.id);
        // The locked set is proven to cover the batch by the count check
        // above. A row that cannot be found under its canonical identity is a
        // NOT-FOUND batch — the identical answer of an absent id — and never
        // a crash.
        if (!current) {
          return { status: 404, body: { error: 'Course lesson not found' }, commit: false };
        }
        const currentOrder = Number(current.display_order);
        if (currentOrder !== item.displayOrder) {
          // The write and the audit event name the STORED id: the identity of
          // the row that actually changed, not an echo of the spelling the
          // client used.
          changed.push({ id: String(current.id), from: currentOrder, to: item.displayOrder });
        }
      }

      // Every changed row is written with the SAME bounded statement, in the
      // deterministic id order, and each one carries its own audit event.
      for (const entry of changed) {
        const [updateResult] = await connection.execute(
          'UPDATE course_lessons SET display_order=? WHERE id=? AND unit_id=?',
          [entry.to, entry.id, unitId]
        );
        if (Number((updateResult as any)?.affectedRows) !== 1) {
          return { status: 409, body: { error: 'Course lesson was modified concurrently' }, commit: false };
        }
        await connection.execute(
          `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
           VALUES (?,?,?,?,?,?,?,?)`,
          [randomUUID(), userId, tenantId, 'course.lesson_reordered', 'course_lesson', entry.id,
            JSON.stringify({ course_id: courseId, unit_id: unitId, lesson_id: entry.id, display_order: entry.from }),
            JSON.stringify({ course_id: courseId, unit_id: unitId, lesson_id: entry.id, display_order: entry.to })]
        );
      }

      // One bounded read-back of exactly the selected rows, in the resulting
      // (display_order, id) order: the response is the canonical DTO of the
      // selection, never a whole-catalog read.
      const [readRows] = await connection.execute(
        `SELECT ${LESSON_PROJECTION}
         FROM course_lessons l WHERE l.unit_id=? AND l.id IN (${placeholders})
         ORDER BY l.display_order ASC, l.id ASC`,
        [unitId, ...ids]
      );
      const readBack = (readRows as any[]) ?? [];
      if (readBack.length !== ids.length) {
        return { status: 500, body: { error: 'Failed to reorder course lessons' }, commit: false };
      }
      // The DTOs are materialized INSIDE the transaction and BEFORE the
      // commit: an unreadable stored instant fails the batch instead of
      // committing positions whose dates could only be guessed.
      const lessons: any[] = [];
      for (const row of readBack) {
        const dto = courseLessonDto(row);
        if (dto === null) {
          console.error('Reorder course lessons error: unreadable lesson timestamp projection');
          return { status: 500, body: { error: 'Failed to reorder course lessons' }, commit: false };
        }
        lessons.push(dto);
      }
      // A batch of pure no-ops writes nothing: nothing is committed and the
      // current DTOs are still returned truthfully.
      return { status: 200, body: { lessons }, commit: changed.length > 0 };
    });
  });

  /**
   * PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId
   * — retitle, describe, reorder, archive or reactivate one private lesson.
   *
   * Owner-only and strict: the body may carry `title`, `description`,
   * `display_order` and/or `status` only, an empty update is rejected,
   * `status` must be exactly 'active' or 'archived', `description` is `null`
   * or at most 10000 characters, and the order must already be an integer in
   * 0..2147483647. The lookup always qualifies the lesson id AND the unit of
   * the path, so a foreign and an absent lesson produce the identical
   * not-found result and no ownership is disclosed. A change to the current
   * values is a truthful no-op: no UPDATE and no audit event. A reordered
   * lesson only moves its own metadata position: no other lesson is
   * renumbered and no ordering policy is claimed. The update and its audit
   * event are committed together, and success is reported only after
   * `commit()` resolves. `Cache-Control: no-store` is set before the first
   * await / any denial.
   */
  router.patch('/courses/:courseId/units/:unitId/lessons/:lessonId', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(400).json({ error: 'Invalid course id' });
    }
    const unitId = String(req.params?.unitId ?? '');
    if (!UUID_PATTERN.test(unitId)) {
      return res.status(400).json({ error: 'Invalid course unit id' });
    }
    const lessonId = String(req.params?.lessonId ?? '');
    if (!UUID_PATTERN.test(lessonId)) {
      return res.status(400).json({ error: 'Invalid course lesson id' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid course lesson update payload' });
    }
    const keys = Object.keys(body);
    if (keys.length === 0) return res.status(400).json({ error: 'Invalid course lesson update payload' });
    for (const key of keys) {
      if (
        key !== 'title' && key !== 'description' && key !== 'display_order' && key !== 'status' &&
        key !== 'release_at' && key !== 'prerequisite_lesson_id'
      ) {
        return res.status(400).json({ error: 'Invalid course lesson update payload' });
      }
    }
    let nextTitle: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      nextTitle = parseTitle((body as Record<string, unknown>).title);
      if (nextTitle === null) return res.status(400).json({ error: 'Invalid course lesson update payload' });
    }
    // `undefined` means "not supplied"; `null` is the explicit clear.
    let nextDescription: string | null | undefined;
    let descriptionSupplied = false;
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      nextDescription = parseDescription((body as Record<string, unknown>).description);
      if (nextDescription === undefined) return res.status(400).json({ error: 'Invalid course lesson update payload' });
      descriptionSupplied = true;
    }
    let nextDisplayOrder: number | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'display_order')) {
      nextDisplayOrder = parseDisplayOrder((body as Record<string, unknown>).display_order);
      if (nextDisplayOrder === null) return res.status(400).json({ error: 'Invalid course lesson update payload' });
    }
    let nextStatus: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      nextStatus = parseStatus((body as Record<string, unknown>).status);
      if (nextStatus === null) return res.status(400).json({ error: 'Invalid course lesson update payload' });
    }
    // `release_at` is an explicit nullable UTC ISO instant: absent = keep,
    // `null` = clear, a string = set. A malformed value is refused before a
    // connection is taken.
    let nextReleaseEpoch: number | null = null;
    let releaseSupplied = false;
    if (Object.prototype.hasOwnProperty.call(body, 'release_at')) {
      const parsed = parseReleaseAt((body as Record<string, unknown>).release_at);
      if (parsed.ok === false) return res.status(400).json({ error: 'Invalid course lesson release' });
      nextReleaseEpoch = parsed.epoch;
      releaseSupplied = true;
    }
    // `prerequisite_lesson_id` follows the same three-way rule.
    let nextPrerequisiteId: string | null = null;
    let prerequisiteSupplied = false;
    if (Object.prototype.hasOwnProperty.call(body, 'prerequisite_lesson_id')) {
      const parsed = parsePrerequisiteId((body as Record<string, unknown>).prerequisite_lesson_id);
      if (parsed.ok === false) return res.status(400).json({ error: 'Invalid course lesson prerequisite' });
      nextPrerequisiteId = parsed.id;
      prerequisiteSupplied = true;
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    return runInTransaction('Failed to update course lesson', res, async (connection) => {
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      // The course and the parent unit are locked for the write, so an
      // archive, a move or an ownership change cannot race the update.
      const course = await resolveCourse(connection, courseId, tenantId, true);
      if (!course) return { status: 404, body: { error: 'Course not found' }, commit: false };
      const unit = await resolveUnit(connection, unitId, courseId, true);
      if (!unit) return { status: 404, body: { error: 'Course unit not found' }, commit: false };
      // Unit-qualified and locked: a foreign lesson id is simply not found
      // here, and the row lock serializes concurrent writes on the same
      // lesson.
      const [rows] = await connection.execute(
        `SELECT ${LESSON_PROJECTION}
         FROM course_lessons l WHERE l.id=? AND l.unit_id=? FOR UPDATE`,
        [lessonId, unitId]
      );
      const current = (rows as any[])[0];
      if (!current) return { status: 404, body: { error: 'Course lesson not found' }, commit: false };

      const currentTitle = String(current.title);
      const currentDescription = current.description === null || current.description === undefined ? null : String(current.description);
      const currentDisplayOrder = Number(current.display_order);
      const currentStatus = String(current.status);
      const currentReleaseEpoch =
        current.release_at_epoch === null || current.release_at_epoch === undefined
          ? null
          : Number(current.release_at_epoch);
      const currentPrerequisiteId =
        current.prerequisite_lesson_id === null || current.prerequisite_lesson_id === undefined
          ? null
          : canonicalUuidIdentity(String(current.prerequisite_lesson_id));
      const finalTitle = nextTitle === null ? currentTitle : nextTitle;
      const finalDescription = descriptionSupplied ? (nextDescription as string | null) : currentDescription;
      const finalDisplayOrder = nextDisplayOrder === null ? currentDisplayOrder : nextDisplayOrder;
      const finalStatus = nextStatus === null ? currentStatus : nextStatus;
      const finalReleaseEpoch = releaseSupplied ? nextReleaseEpoch : currentReleaseEpoch;
      const finalPrerequisiteId = prerequisiteSupplied ? nextPrerequisiteId : currentPrerequisiteId;

      // The prerequisite is validated against the target's FINAL position, so a
      // request that moves the lesson and sets its prerequisite at the same time
      // is judged against the row that will exist. A stored prerequisite that is
      // being kept unchanged is NOT re-validated: an owner may archive or move an
      // existing prerequisite without this patch refusing an unrelated edit.
      if (prerequisiteSupplied && finalPrerequisiteId !== null) {
        const valid = await resolvePrerequisite(
          connection, courseId, lessonId, finalDisplayOrder, finalPrerequisiteId
        );
        if (!valid) {
          return { status: 400, body: { error: 'Invalid course lesson prerequisite' }, commit: false };
        }
      }

      if (
        finalTitle === currentTitle &&
        finalDescription === currentDescription &&
        finalDisplayOrder === currentDisplayOrder &&
        finalStatus === currentStatus &&
        finalReleaseEpoch === currentReleaseEpoch &&
        finalPrerequisiteId === currentPrerequisiteId
      ) {
        // Truthful no-op: identical values write and audit nothing.
        const currentDto = courseLessonDto(current);
        if (currentDto === null) {
          console.error('Update course lesson error: unreadable lesson timestamp projection');
          return { status: 500, body: { error: 'Failed to update course lesson' }, commit: false };
        }
        return { status: 200, body: { lesson: currentDto }, commit: false };
      }

      // An epoch is written with `FROM_UNIXTIME(?)`, never as a driver Date: the
      // pool's `timezone:'+02:00'` would re-interpret a Date on the client side
      // and shift the stored instant.
      const releaseValueSql = finalReleaseEpoch === null ? 'NULL' : 'FROM_UNIXTIME(?)';
      const updateParams: any[] = [finalTitle, finalDescription, finalDisplayOrder, finalStatus];
      if (finalReleaseEpoch !== null) updateParams.push(finalReleaseEpoch);
      updateParams.push(finalPrerequisiteId, lessonId, unitId);
      const [updateResult] = await connection.execute(
        'UPDATE course_lessons SET title=?,description=?,display_order=?,status=?,' +
          `release_at=${releaseValueSql},prerequisite_lesson_id=? WHERE id=? AND unit_id=?`,
        updateParams
      );
      if (Number((updateResult as any)?.affectedRows) !== 1) {
        return { status: 409, body: { error: 'Course lesson was modified concurrently' }, commit: false };
      }
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'course.lesson_updated', 'course_lesson', lessonId,
          JSON.stringify({
            course_id: courseId, unit_id: unitId, lesson_id: lessonId,
            title: currentTitle, description: currentDescription,
            display_order: currentDisplayOrder, status: currentStatus,
            release_at: currentReleaseEpoch === null ? null : toUtcTimestamp(currentReleaseEpoch),
            prerequisite_lesson_id: currentPrerequisiteId,
          }),
          JSON.stringify({
            course_id: courseId, unit_id: unitId, lesson_id: lessonId,
            title: finalTitle, description: finalDescription,
            display_order: finalDisplayOrder, status: finalStatus,
            release_at: finalReleaseEpoch === null ? null : toUtcTimestamp(finalReleaseEpoch),
            prerequisite_lesson_id: finalPrerequisiteId,
          })]
      );
      const [updatedRows] = await connection.execute(
        `SELECT ${LESSON_PROJECTION}
         FROM course_lessons l WHERE l.id=? AND l.unit_id=? LIMIT 1`,
        [lessonId, unitId]
      );
      const updated = (updatedRows as any[])[0];
      if (!updated) {
        return { status: 500, body: { error: 'Failed to update course lesson' }, commit: false };
      }
      // The DTO is materialized from the epoch projection INSIDE the
      // transaction and BEFORE the commit: an unreadable stored instant
      // fails the write instead of committing a row whose date could only be
      // guessed.
      const dto = courseLessonDto(updated);
      if (dto === null) {
        console.error('Update course lesson error: unreadable lesson timestamp projection');
        return { status: 500, body: { error: 'Failed to update course lesson' }, commit: false };
      }
      return { status: 200, body: { lesson: dto }, commit: true };
    });
  });

  return router;
};
