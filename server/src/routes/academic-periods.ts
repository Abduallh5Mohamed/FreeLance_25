/**
 * M2-B07 — private academic-period planning catalog for the VERIFIED
 * institution owner.
 *
 * Contract: docs/streams/server/M2-B07-CONTRACT.md
 * Handoff:  docs/streams/client/M2-13-HANDOFF.md
 *
 * An academic period is PLANNING METADATA: a label plus two date-only bounds,
 * with a reversible archive flag. This module attaches NOTHING to it:
 *
 *   * no enrollment, registration, roster, group, grade, course or lesson link;
 *   * no student access window, no visibility rule for a student, no capacity;
 *   * no invoice, price, payment, fee, discount or subscription effect;
 *   * no automatic date or status transition of any kind — nothing in this
 *     module reads the clock to change a row, and a period that has ended is
 *     simply a period whose `ends_on` is in the past;
 *   * no uniqueness or overlap policy: duplicated names and overlapping ranges
 *     are PERMITTED, because no such product policy has been approved.
 *
 * The module is deliberately self-contained:
 *   * it imports `AuthRequest` as a TYPE only, so it pulls in no
 *     authentication, database, provider or environment module at runtime;
 *   * it has no default export and binds no production adapter — the
 *     transactional connection supplier is injected by the caller;
 *   * every statement runs on the injected connection, so the authorization,
 *     the read and the write share ONE database snapshot and ONE transaction.
 *
 * The tenant is never taken from the request: it is the server-selected scope
 * on the authenticated principal and it is re-verified against the real
 * `tenants.owner_user_id` row.
 *
 * Endpoints (mounted by `tenant-self.ts` under `/academic-periods`, i.e.
 * `/api/tenants/me/academic-periods`):
 *   * `GET   /`     — one bounded page of the private planning catalog;
 *   * `POST  /`     — create one period;
 *   * `PATCH /:id`  — update a nonempty subset, including the reversible
 *                     archive flag.
 *
 * The period DTO is EXACTLY:
 *   `{ id, name, starts_on, ends_on, is_archived, created_at, updated_at }`
 * No row is ever spread: `tenant_id` and every owner/contact/billing column
 * stay server-side.
 */
import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';

/**
 * Minimal transactional connection seam, structurally identical to the
 * tenant-self / course-unit / course-lesson / branding seams. Production binds
 * a real mysql2 PoolConnection (getPool().getConnection()); hermetic tests bind
 * a fixture-backed connection so the real handler and authorization logic runs
 * without a database, a network or a live app startup.
 */
export interface AcademicPeriodConnection {
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
export interface AcademicPeriodsDeps {
  getConnection: () => Promise<AcademicPeriodConnection>;
}

/** A period name is a trimmed free label of 1..255 characters. */
const NAME_MAX = 255;

/** The default and maximum page size of the bounded catalog list. */
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;

/**
 * The largest accepted offset. The catalog is a bounded planning list, not an
 * unbounded history: a client can never ask the server to walk an arbitrary
 * distance into the tenant's rows.
 */
const OFFSET_MAX = 10000;

/** A server-generated period id is a UUID. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A canonical calendar date: exactly `YYYY-MM-DD`, no time, no zone, no
 * offset and no alternative separator.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The three writable-on-create fields, and the four writable-on-update fields.
 */
const CREATE_KEYS: readonly string[] = ['name', 'starts_on', 'ends_on'];
const UPDATE_KEYS: readonly string[] = ['name', 'starts_on', 'ends_on', 'is_archived'];
/** The only query parameters the list accepts. */
const LIST_QUERY_KEYS: readonly string[] = ['limit', 'offset', 'archived'];

/**
 * Render a stored instant as UTC ISO-8601 from its Unix EPOCH SECONDS.
 *
 * The period timestamps are read with `UNIX_TIMESTAMP(col)`, never as a driver
 * datetime value. The installed mysql2 pool is configured with
 * `timezone: '+02:00'`, and the driver uses that value to INTERPRET the wall
 * time it receives: it is a client-side conversion, NOT a
 * `SET SESSION time_zone` statement. A TIMESTAMP stored as `12:00:00` in a UTC
 * session is therefore decoded by that driver as `10:00Z`, which would shift
 * every serialized instant by the offset of the day. Projecting the stored
 * instant as epoch seconds removes the driver interpretation entirely.
 *
 * A missing, malformed, non-positive or unrepresentable epoch is REFUSED: no
 * 1970 instant, no "now" and no null date is ever fabricated for a row that
 * exists.
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
  // for these rows and is refused with the rest of the malformed values.
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const instant = new Date(epoch * 1000);
  if (Number.isNaN(instant.getTime())) return null;
  return instant.toISOString();
};

/**
 * Parse a DATE-ONLY value into the canonical `YYYY-MM-DD` string.
 *
 * The value must be a REAL calendar date in the SQL DATE range (years
 * 1000..9999). The shape alone is not enough: `2026-02-30`, `2026-13-01`,
 * `2026-00-10` and `2026-04-31` all match the pattern but do not exist, and
 * `Date.UTC` silently NORMALIZES them (2026-02-30 becomes 2026-03-02). The
 * value is therefore reconstructed and must round-trip EXACTLY back to the
 * same three components. There is no fallback date and no coerced value.
 *
 * The result is a STRING, never a `Date`: a date-only planning label must not
 * acquire a time, a time zone or a UTC shift on its way to storage.
 */
const parseCanonicalDate = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !DATE_PATTERN.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  if (year < 1000 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return raw;
};

/**
 * Strict name parsing: a string that trims to 1..255 characters.
 *
 * An empty, whitespace-only, non-string, array, number or boolean value is
 * rejected — never coerced. Unicode is permitted and no script or locale is
 * guessed from the field name.
 */
const parseName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > NAME_MAX) return null;
  return name;
};

/**
 * The read projection of a period row.
 *
 * `starts_on` / `ends_on` are projected with `DATE_FORMAT(...)` so the
 * serialized value is the STORED CALENDAR DATE as a string. Selecting the raw
 * DATE column would hand the value to the driver, which decodes it with the
 * pool's `timezone: '+02:00'` interpretation and would shift it by a day at a
 * month or year boundary; a date-only planning label has no instant to shift.
 *
 * The two timestamps are projected as epoch seconds for the same reason.
 */
const PERIOD_PROJECTION =
  'p.id,p.name,' +
  "DATE_FORMAT(p.starts_on,'%Y-%m-%d') AS starts_on," +
  "DATE_FORMAT(p.ends_on,'%Y-%m-%d') AS ends_on," +
  'p.is_archived,' +
  'UNIX_TIMESTAMP(p.created_at) AS created_at_epoch,' +
  'UNIX_TIMESTAMP(p.updated_at) AS updated_at_epoch';

/**
 * Explicit period DTO built from a STORED row. The row is never spread: only
 * the seven documented fields are exposed.
 *
 * A row whose epoch projection or stored calendar date cannot be rendered
 * truthfully, whose stored name is not already canonical, or whose
 * `is_archived` is not a real 0/1, yields NO DTO at all: the caller has to fail
 * the request instead of answering with a fabricated instant, a guessed date, a
 * normalized name or a coerced boolean.
 */
const academicPeriodDto = (row: any) => {
  const id = row?.id;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  const createdAt = toUtcTimestamp(row?.created_at_epoch);
  const updatedAt = toUtcTimestamp(row?.updated_at_epoch);
  if (createdAt === null || updatedAt === null) return null;
  // The stored dates are re-validated on every read, so a row written by any
  // other path can never be served as a malformed or impossible date.
  const startsOn = parseCanonicalDate(row?.starts_on);
  const endsOn = parseCanonicalDate(row?.ends_on);
  if (startsOn === null || endsOn === null) return null;
  if (startsOn > endsOn) return null;
  const name = row?.name;
  if (typeof name !== 'string') return null;
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > NAME_MAX) return null;
  // The STORED name must ALREADY be canonical: it has to be exactly its own
  // trimmed form. A stored name that carries surrounding whitespace is
  // REFUSED — it is never emitted raw and it is never normalized into a
  // confirmed DTO, because the trimmed value would be a name this server never
  // stored and cannot vouch for. Every write path of this module canonicalizes
  // the name before it is stored, so a non-canonical stored row can only come
  // from outside this module, and the honest answer to it is a refusal.
  if (name !== trimmedName) return null;
  const archived = row?.is_archived;
  if (archived === null || archived === undefined) return null;
  const archivedNumber = Number(archived);
  if (archivedNumber !== 0 && archivedNumber !== 1) return null;
  return {
    id,
    name,
    starts_on: startsOn,
    ends_on: endsOn,
    is_archived: archivedNumber === 1,
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

/** Strict page-size parsing: an integer 1..100, default 25. */
const parseListLimit = (raw: unknown): number | null => {
  if (raw === undefined) return PAGE_DEFAULT;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > PAGE_MAX) return null;
  return value;
};

/** Strict offset parsing: an integer 0..10000, default 0. */
const parseListOffset = (raw: unknown): number | null => {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > OFFSET_MAX) return null;
  return value;
};

/** Strict archive-view parsing: exactly `true` or `false`, default `false`. */
const parseArchivedView = (raw: unknown): boolean | null => {
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
};

/** One transactional outcome: the response, and whether to COMMIT it. */
interface TxResult {
  status: number;
  body: any;
  commit: boolean;
}

export const createAcademicPeriodsRouter = (deps: AcademicPeriodsDeps): Router => {
  const router = Router();
  const { getConnection } = deps;

  /**
   * Local billing-only denial.
   *
   * `middleware/auth.ts` exempts the WHOLE /api/tenants/me prefix from the
   * instructor billing-only path restriction, so merely mounting a route below
   * that prefix does NOT enforce the denial. Every period route therefore
   * checks `req.user.billingOnly` itself and refuses BEFORE any connection is
   * acquired. The shared authentication middleware and its exemptions are not
   * touched.
   */
  const denyBillingOnly = (req: AuthRequest, res: Response): boolean => {
    if (!req.user?.billingOnly) return false;
    res.status(403).json({
      error: 'Academic period management is not available while the account is limited to billing and support',
      code: 'BILLING_ONLY',
    });
    return true;
  };

  /**
   * Verify that the caller is the owner of the SELECTED tenant.
   *
   * The check is resolved from server-side rows only, on the same connection
   * that performs the period work: the tenant's real `owner_user_id`, its
   * status and the caller's own active user row. A membership role label
   * (`owner`/`instructor`) never grants period visibility or writes, and a
   * global teacher/admin role is not a tenant owner at all.
   *
   * `lock` takes the owner row FOR UPDATE. On a write this lock is the
   * serialization evidence for the authorization decision: an ownership or
   * status change cannot interleave between the check and the write. The list
   * read uses a plain snapshot select, so a read never blocks a write and never
   * takes an exclusive lock.
   */
  const verifyTenantOwner = async (
    connection: AcademicPeriodConnection,
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
   * Run ONE transactional unit of work on ONE connection.
   *
   * The lifecycle is explicit and identical for every route:
   *   * a failed acquisition performs no cleanup for a connection that does
   *     not exist;
   *   * a failed `beginTransaction` DESTROYS the unconfirmed connection instead
   *     of pooling a possibly-dirty session;
   *   * after the transaction started, a denial / no-op / not-found rolls back
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
    work: (connection: AcademicPeriodConnection) => Promise<TxResult>
  ): Promise<Response> => {
    let connection: AcademicPeriodConnection | null = null;
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
   * GET /api/tenants/me/academic-periods — ONE bounded page of the private
   * planning catalog of the server-selected tenant, for its verified owner.
   *
   * Owner-only and selector-free: no tenant id is accepted from
   * header/query/body, and there is no fallback to an arbitrary membership. An
   * unknown query key (a tenant/owner selector, a `status`, a `from`/`to`
   * range, a sort override) is rejected rather than ignored, so a caller can
   * never believe it filtered by something the server silently dropped.
   *
   * The list is bounded and deterministic PER REQUEST: rows are ordered by
   * `(starts_on, id)` — a total order over the rows the request reads, which
   * needs no timestamp or timezone interpretation — and read with `LIMIT ?+1
   * OFFSET ?`, so one extra row is read only to learn whether another page
   * exists. There is no total-count query, no unbounded history read and no
   * cross-tenant read.
   *
   * `offset` paging is a POSITION, not a snapshot: `starts_on` and `name` are
   * mutable, so a period created, moved or archived between two page reads can
   * shift the remaining pages. Each single page is internally consistent for
   * the rows it reads, but there is NO cross-request snapshot and no
   * stable-once guarantee. No snapshot token or ordering freeze is provided.
   */
  router.get('/', async (req: AuthRequest, res: Response) => {
    // The cache directive is applied before the first await and before any
    // denial, so every outcome this handler produces carries it.
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const query = (req.query ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(query)) {
      if (!LIST_QUERY_KEYS.includes(key)) {
        return res.status(400).json({ error: 'Invalid academic period list query' });
      }
    }
    const limit = parseListLimit(query.limit);
    if (limit === null) return res.status(400).json({ error: 'Invalid academic period list limit' });
    const offset = parseListOffset(query.offset);
    if (offset === null) return res.status(400).json({ error: 'Invalid academic period list offset' });
    const archived = parseArchivedView(query.archived);
    if (archived === null) return res.status(400).json({ error: 'Invalid academic period archive filter' });

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    return runInTransaction('Failed to list academic periods', res, async (connection) => {
      const owner = await verifyTenantOwner(connection, userId, tenantId, false);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      // One extra row is read to learn whether another page exists; only the
      // requested page size is ever returned.
      const [rows] = await connection.execute(
        `SELECT ${PERIOD_PROJECTION}
         FROM academic_periods p
         WHERE p.tenant_id=? AND p.is_archived=?
         ORDER BY p.starts_on ASC, p.id ASC LIMIT ? OFFSET ?`,
        [tenantId, archived ? 1 : 0, limit + 1, offset]
      );
      const page = (rows as any[]) ?? [];
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      // The DTO is materialized from the epoch/date projection BEFORE the read
      // transaction is closed. A row whose stored instant or calendar date
      // cannot be rendered truthfully fails the whole page: a 1970 instant, the
      // current time, a shifted date or a coerced boolean is never fabricated.
      const periods: any[] = [];
      for (const row of visible) {
        const dto = academicPeriodDto(row);
        if (dto === null) {
          console.error('List academic periods error: unreadable period projection');
          return { status: 500, body: { error: 'Failed to list academic periods' }, commit: false };
        }
        periods.push(dto);
      }
      return {
        status: 200,
        body: { periods, pagination: { limit, offset, has_more: hasMore } },
        commit: false,
      };
    });
  });

  /**
   * POST /api/tenants/me/academic-periods — create one private planning period
   * for the verified owner of the selected tenant.
   *
   * Strict: the body must be a plain object carrying exactly `name`,
   * `starts_on` and `ends_on`. Any other key (a tenant/owner/id/status
   * selector, an enrollment/roster/group/grade/course/lesson link, a price, a
   * fee, an access window or a capacity) is rejected BEFORE any connection is
   * acquired, and so is a missing field, a non-string, a non-canonical or
   * impossible calendar date and a `starts_on` after `ends_on`.
   *
   * Duplicated names and overlapping ranges are PERMITTED: no uniqueness or
   * overlap policy has been approved, so nothing here rejects them and nothing
   * here checks another row. The id is server-generated, so a client can never
   * choose an identity or place a period in another tenant.
   *
   * The insert, exactly ONE bounded audit event, the read-back and the DTO
   * materialization all share ONE transaction, and the DTO is materialized
   * BEFORE the single commit: an unreadable stored instant fails the write
   * instead of committing a row whose dates could only be guessed. Success is
   * reported only after `commit()` resolves, with 201 and `{period}`.
   */
  router.post('/', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const invalid = () => res.status(400).json({ error: 'Invalid academic period payload' });

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
    const keys = Object.keys(body);
    if (keys.length !== CREATE_KEYS.length) return invalid();
    for (const key of keys) {
      if (!CREATE_KEYS.includes(key)) return invalid();
    }
    const record = body as Record<string, unknown>;
    const name = parseName(record.name);
    if (name === null) return invalid();
    const startsOn = parseCanonicalDate(record.starts_on);
    if (startsOn === null) return invalid();
    const endsOn = parseCanonicalDate(record.ends_on);
    if (endsOn === null) return invalid();
    // Canonical `YYYY-MM-DD` strings compare correctly as strings, so this is
    // a real calendar comparison and not a locale or timezone one.
    if (startsOn > endsOn) return invalid();

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    return runInTransaction('Failed to create academic period', res, async (connection) => {
      // The owner is verified BEFORE anything is written, on the same
      // connection and inside the same transaction as the insert.
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      const periodId = randomUUID();
      await connection.execute(
        'INSERT INTO academic_periods (id,tenant_id,name,starts_on,ends_on,is_archived) VALUES (?,?,?,?,?,?)',
        [periodId, tenantId, name, startsOn, endsOn, 0]
      );
      // Exactly ONE bounded audit event for the effective write. It carries the
      // period fields only — never a credential, a student, a billing or an
      // enrollment field.
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'tenant.academic_period_created', 'academic_period', periodId,
          null,
          JSON.stringify({ name, starts_on: startsOn, ends_on: endsOn, is_archived: false })]
      );
      const [readBack] = await connection.execute(
        `SELECT ${PERIOD_PROJECTION} FROM academic_periods p WHERE p.id=? AND p.tenant_id=? LIMIT 1`,
        [periodId, tenantId]
      );
      const stored = (readBack as any[])[0] ?? null;
      if (stored === null) {
        console.error('Create academic period error: period row missing after insert');
        return { status: 500, body: { error: 'Failed to create academic period' }, commit: false };
      }
      const dto = academicPeriodDto(stored);
      if (dto === null) {
        console.error('Create academic period error: unreadable period projection');
        return { status: 500, body: { error: 'Failed to create academic period' }, commit: false };
      }
      // The read-back is the transaction's own view of what it wrote. A
      // mismatch is an internal consistency failure, never a success and never
      // an invented retry or idempotency policy.
      if (dto.name !== name || dto.starts_on !== startsOn || dto.ends_on !== endsOn || dto.is_archived !== false) {
        console.error('Create academic period error: read-back does not match the requested period');
        return { status: 500, body: { error: 'Failed to create academic period' }, commit: false };
      }
      return { status: 201, body: { period: dto }, commit: true };
    });
  });

  /**
   * PATCH /api/tenants/me/academic-periods/:id — update a nonempty subset of
   * `name`, `starts_on`, `ends_on` and `is_archived` for the verified owner of
   * the selected tenant.
   *
   * Strict: any other key (a tenant/owner/id/status selector, an
   * enrollment/roster/group/grade/course/lesson link, a price, a fee, an
   * access window, a capacity) is rejected BEFORE any connection is acquired,
   * and so is an empty body, a non-string name, a non-canonical or impossible
   * calendar date and a non-boolean `is_archived`.
   *
   * The DATE RANGE is validated on the MERGED result: a request that changes
   * only `starts_on` is checked against the STORED `ends_on`, so a partial
   * update can never produce a stored range whose start is after its end.
   *
   * `is_archived` is a REVERSIBLE planning visibility flag: setting it to
   * `true` hides the period from the default catalog view and setting it back
   * to `false` restores it. It is not a cancellation, not a status machine and
   * not an enrollment/access/billing effect, and nothing transitions it
   * automatically. There is no hard delete in this API.
   *
   * A period of ANOTHER tenant, or an absent one, is the identical 404: the row
   * is resolved `WHERE id=? AND tenant_id=?`, so the tenant boundary is part of
   * the lookup and not a post-hoc check.
   *
   * No-op semantics: when the requested EFFECTIVE values equal the stored
   * values, nothing is written, nothing is audited and nothing is committed;
   * the truthful canonical DTO of the current state is returned.
   */
  router.patch('/:id', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const invalid = () => res.status(400).json({ error: 'Invalid academic period update payload' });

    const rawId = String(req.params?.id ?? '');
    if (!UUID_PATTERN.test(rawId)) {
      return res.status(400).json({ error: 'Invalid academic period id' });
    }
    // A UUID has ONE canonical identity: the path id is compared in lowercase
    // so the case variants of one uuid address the same row.
    const periodId = rawId.toLowerCase();

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
    const keys = Object.keys(body);
    if (keys.length === 0) return invalid();
    for (const key of keys) {
      if (!UPDATE_KEYS.includes(key)) return invalid();
    }
    const record = body as Record<string, unknown>;
    const hasName = Object.prototype.hasOwnProperty.call(record, 'name');
    const hasStarts = Object.prototype.hasOwnProperty.call(record, 'starts_on');
    const hasEnds = Object.prototype.hasOwnProperty.call(record, 'ends_on');
    const hasArchived = Object.prototype.hasOwnProperty.call(record, 'is_archived');

    let nextName: string | null = null;
    if (hasName) {
      nextName = parseName(record.name);
      if (nextName === null) return invalid();
    }
    let nextStarts: string | null = null;
    if (hasStarts) {
      nextStarts = parseCanonicalDate(record.starts_on);
      if (nextStarts === null) return invalid();
    }
    let nextEnds: string | null = null;
    if (hasEnds) {
      nextEnds = parseCanonicalDate(record.ends_on);
      if (nextEnds === null) return invalid();
    }
    let nextArchived: boolean | null = null;
    if (hasArchived) {
      if (typeof record.is_archived !== 'boolean') return invalid();
      nextArchived = record.is_archived;
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    return runInTransaction('Failed to update academic period', res, async (connection) => {
      // The owner row is locked for the write, so an ownership or tenant-status
      // change cannot interleave between the authorization and the statement.
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) return { status: 403, body: { error: 'Forbidden' }, commit: false };
      // Tenant-qualified and locked: a foreign period id is simply not found
      // here, and the row lock serializes concurrent writes on the same period.
      const [rows] = await connection.execute(
        `SELECT ${PERIOD_PROJECTION}
         FROM academic_periods p WHERE p.id=? AND p.tenant_id=? FOR UPDATE`,
        [periodId, tenantId]
      );
      const current = (rows as any[])[0] ?? null;
      if (current === null) return { status: 404, body: { error: 'Academic period not found' }, commit: false };
      const currentDto = academicPeriodDto(current);
      if (currentDto === null) {
        console.error('Update academic period error: unreadable period projection');
        return { status: 500, body: { error: 'Failed to update academic period' }, commit: false };
      }

      const finalName = hasName ? (nextName as string) : currentDto.name;
      const finalStarts = hasStarts ? (nextStarts as string) : currentDto.starts_on;
      const finalEnds = hasEnds ? (nextEnds as string) : currentDto.ends_on;
      const finalArchived = hasArchived ? (nextArchived as boolean) : currentDto.is_archived;

      // The MERGED range is validated, so a partial date update can never store
      // a start after its end. This is a payload rejection, not a database
      // error, so the transaction is rolled back and the connection released
      // exactly once — nothing was written.
      if (finalStarts > finalEnds) {
        return { status: 400, body: { error: 'Invalid academic period update payload' }, commit: false };
      }

      if (
        finalName === currentDto.name &&
        finalStarts === currentDto.starts_on &&
        finalEnds === currentDto.ends_on &&
        finalArchived === currentDto.is_archived
      ) {
        // Truthful no-op: no UPDATE, no audit event, no commit.
        return { status: 200, body: { period: currentDto }, commit: false };
      }

      const [updateResult] = await connection.execute(
        'UPDATE academic_periods SET name=?,starts_on=?,ends_on=?,is_archived=? WHERE id=? AND tenant_id=?',
        [finalName, finalStarts, finalEnds, finalArchived ? 1 : 0, periodId, tenantId]
      );
      const affected = Number((updateResult as any)?.affectedRows);
      // The row is locked and a real change was established above, so a
      // multi-row outcome is impossible. A 0 is accepted here because MySQL
      // reports CHANGED rows: the read-back below is the actual proof of what
      // the transaction wrote, and it is what decides success.
      if (affected !== 0 && affected !== 1) {
        console.error('Update academic period error: unexpected affected row count');
        return { status: 500, body: { error: 'Failed to update academic period' }, commit: false };
      }
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'tenant.academic_period_updated', 'academic_period', periodId,
          JSON.stringify({
            name: currentDto.name, starts_on: currentDto.starts_on,
            ends_on: currentDto.ends_on, is_archived: currentDto.is_archived,
          }),
          JSON.stringify({
            name: finalName, starts_on: finalStarts,
            ends_on: finalEnds, is_archived: finalArchived,
          })]
      );
      const [updatedRows] = await connection.execute(
        `SELECT ${PERIOD_PROJECTION} FROM academic_periods p WHERE p.id=? AND p.tenant_id=? LIMIT 1`,
        [periodId, tenantId]
      );
      const updated = (updatedRows as any[])[0] ?? null;
      if (updated === null) {
        console.error('Update academic period error: period row missing after write');
        return { status: 500, body: { error: 'Failed to update academic period' }, commit: false };
      }
      const dto = academicPeriodDto(updated);
      if (dto === null) {
        console.error('Update academic period error: unreadable period projection');
        return { status: 500, body: { error: 'Failed to update academic period' }, commit: false };
      }
      // The DTO is materialized INSIDE the transaction and BEFORE the commit:
      // an unreadable stored instant or date fails the write instead of
      // committing a row that could only be described by guessing.
      if (
        dto.name !== finalName ||
        dto.starts_on !== finalStarts ||
        dto.ends_on !== finalEnds ||
        dto.is_archived !== finalArchived
      ) {
        console.error('Update academic period error: read-back does not match the requested period');
        return { status: 500, body: { error: 'Failed to update academic period' }, commit: false };
      }
      return { status: 200, body: { period: dto }, commit: true };
    });
  });

  return router;
};
