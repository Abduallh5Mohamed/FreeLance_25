/**
 * M2-B04 — private course-unit metadata for the VERIFIED institution owner.
 *
 * Contract: docs/streams/server/M2-B04-CONTRACT.md
 * Handoff: docs/streams/server/M2-B04-HANDOFF.md
 *
 * A course unit is private METADATA: a name, a display position and a
 * status. This module adds no teacher assignment, no student entitlement, no
 * publication, no payment and no upload rule, and it never changes the
 * access of an existing course or material. Archiving a unit is a metadata
 * change only.
 *
 * The module is deliberately self-contained:
 *   * it imports `AuthRequest` as a TYPE only, so it pulls in no
 *     authentication, database, provider or environment module at runtime;
 *   * it has no default export and binds no production adapter — the
 *     transactional connection supplier is injected by the caller;
 *   * every statement runs on the injected connection, so the authorization
 *     and the write share ONE database snapshot.
 *
 * The tenant is never taken from the request: it is the server-selected
 * scope on the authenticated principal, it is re-verified against the real
 * `tenants.owner_user_id` row, and every unit row is reached only through
 * its course, which must belong to that selected tenant.
 */
import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';

/**
 * Minimal transactional connection seam, structurally identical to the
 * tenant-self seam. Production binds a real mysql2 PoolConnection
 * (getPool().getConnection()); hermetic tests bind a fixture-backed
 * connection so the real handler and authorization logic runs without a
 * database, a network or a live app startup.
 */
export interface CourseUnitConnection {
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
export interface CourseUnitsDeps {
  getConnection: () => Promise<CourseUnitConnection>;
}

/** A unit status is only 'active' or 'archived'. */
const UNIT_STATUSES: readonly string[] = ['active', 'archived'];
/** A unit name is a trimmed free label of 1..255 characters. */
const UNIT_NAME_MAX = 255;
/** Bounded keyset page: default 25, maximum 100. */
const UNIT_PAGE_DEFAULT = 25;
const UNIT_PAGE_MAX = 100;
/** display_order is a nonnegative signed 32-bit integer. */
const UNIT_DISPLAY_ORDER_MAX = 2147483647;
/** A course id and a unit id are server-generated UUIDs. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The opaque cursor is bounded so a hostile value cannot be used as a probe. */
const CURSOR_MAX_LENGTH = 256;

/**
 * Render a stored instant as UTC ISO-8601 from its Unix EPOCH SECONDS.
 *
 * The unit timestamps are read with `UNIX_TIMESTAMP(col)`, never as a driver
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
 * Explicit unit DTO. The row is never spread: only the seven documented
 * columns are exposed and no tenant, owner, contact or billing field is
 * ever returned. The epoch projection never leaks into the DTO.
 *
 * A row whose epoch projection cannot be rendered truthfully yields NO DTO
 * at all: the caller has to fail the request instead of answering with a
 * fabricated instant or a null date.
 */
const courseUnitDto = (row: any) => {
  const createdAt = toUtcTimestamp(row?.created_at_epoch);
  const updatedAt = toUtcTimestamp(row?.updated_at_epoch);
  if (createdAt === null || updatedAt === null) return null;
  return {
    id: String(row.id),
    course_id: String(row.course_id),
    name: String(row.name),
    display_order: Number(row.display_order),
    status: String(row.status),
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

/**
 * The read projection of a unit row.
 *
 * The two timestamps are projected as epoch seconds (`UNIX_TIMESTAMP`) so
 * the serialized instant never depends on the driver offset; the raw
 * datetime columns are deliberately NOT selected.
 */
const UNIT_PROJECTION =
  'u.id,u.course_id,u.name,u.display_order,u.status,' +
  'UNIX_TIMESTAMP(u.created_at) AS created_at_epoch,' +
  'UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch';

/**
 * Opaque list cursor. It encodes the POSITION of the last row of the
 * previous page — its display order and its id — and nothing else. It never
 * carries authority: the page is still qualified by the course, and the
 * course is still qualified by the server-selected tenant.
 */
const encodeUnitCursor = (displayOrder: number, id: string): string =>
  Buffer.from(`${displayOrder}:${id}`, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const decodeUnitCursor = (cursor: unknown): { displayOrder: number; id: string } | null => {
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
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > UNIT_DISPLAY_ORDER_MAX) return null;
  const id = match[2];
  // The cursor is canonical: only the exact encoding this server mints is
  // accepted, so one position has one representation.
  if (encodeUnitCursor(displayOrder, id) !== cursor) return null;
  return { displayOrder, id };
};

/** Strict page-size parsing: an integer 1..100, default 25. */
const parseUnitLimit = (raw: unknown): number | null => {
  if (raw === undefined) return UNIT_PAGE_DEFAULT;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > UNIT_PAGE_MAX) return null;
  return value;
};

/** Strict unit-name validation: a string that trims to 1..255 characters. */
const parseUnitName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > UNIT_NAME_MAX) return null;
  return name;
};

/**
 * Strict display-order validation. The value must already BE an integer in
 * 0..2147483647: a numeric string, a float or a boolean is rejected, never
 * coerced.
 */
const parseDisplayOrder = (raw: unknown): number | null => {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw > UNIT_DISPLAY_ORDER_MAX) return null;
  return raw;
};

export const createCourseUnitsRouter = (deps: CourseUnitsDeps): Router => {
  const router = Router();
  const { getConnection } = deps;

  /**
   * Local billing-only denial.
   *
   * `middleware/auth.ts` exempts the WHOLE /api/tenants/me prefix from the
   * instructor billing-only path restriction, so merely mounting a route
   * below that prefix does NOT enforce the denial. Each unit route therefore
   * checks `req.user.billingOnly` itself and refuses BEFORE any connection
   * is taken. The shared authentication middleware and its exemptions are
   * not touched.
   */
  const denyBillingOnly = (req: AuthRequest, res: Response): boolean => {
    if (!req.user?.billingOnly) return false;
    res.status(403).json({
      error: 'Course unit management is not available while the account is limited to billing and support',
      code: 'BILLING_ONLY',
    });
    return true;
  };

  /**
   * Verify that the caller is the owner of the SELECTED tenant.
   *
   * The check is resolved from server-side rows only, on the same connection
   * that performs the unit work: the tenant's real `owner_user_id`, its
   * status and the caller's own active user row. A membership role label
   * (`owner`/`instructor`) never grants unit visibility or writes, and a
   * global teacher/admin role is not a tenant owner at all.
   *
   * `lock` selects the rows FOR UPDATE so a write cannot race an ownership
   * change. The list read uses a plain snapshot select inside its own
   * transaction, so the verification and the page read share one snapshot
   * without taking an exclusive lock on a read path.
   */
  const verifyTenantOwner = async (
    connection: CourseUnitConnection,
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
   * tenant is derived from the course on the same connection, so a unit row
   * is never reachable through a foreign or inactive course. A null, foreign
   * and inactive course produce the identical not-found result.
   *
   * `lock` takes the course row FOR UPDATE on a write, so an archive or an
   * ownership change cannot race the write.
   */
  const resolveCourse = async (
    connection: CourseUnitConnection,
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
   * GET /api/tenants/me/catalog/courses/:courseId/units — owner-only bounded
   * list of the private unit metadata of one active course.
   *
   * The list is deterministic PER REQUEST and bounded: rows are ordered by
   * (display_order, id) — a total order over the rows the request reads,
   * which needs no timestamp or timezone interpretation — and read with a
   * keyset cursor, so no page is unbounded and no offset is used. The default
   * page size is 25 and the maximum is 100. The cursor is opaque and only a
   * POSITION: it never carries authority, because the page is still
   * qualified by the course, and the course is still qualified by the
   * selected tenant. Archived units are included: the owner sees the private
   * metadata of the course, and nothing is published.
   *
   * The cursor is a position, NOT a snapshot. `display_order` is mutable, so
   * the pages of one traversal are NOT a snapshot of the course: a unit that
   * is moved after a page was served can reappear on a later page, and a unit
   * that is moved before the cursor position can be omitted from the
   * remaining pages. Each single page is internally consistent and
   * deterministic for the rows it reads, but there is NO cross-request
   * snapshot and no stable-once guarantee under a concurrent reorder. No
   * snapshot token, version policy or ordering freeze is provided here.
   */
  router.get('/courses/:courseId/units', async (req: AuthRequest, res: Response) => {
    // The cache directive is applied before the first await and before any
    // denial, so every outcome this handler produces carries it.
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(400).json({ error: 'Invalid course id' });
    }
    const limit = parseUnitLimit(req.query?.limit);
    if (limit === null) return res.status(400).json({ error: 'Invalid course unit list limit' });
    const rawCursor = req.query?.cursor;
    // An absent cursor starts at the beginning of the course's units. The
    // sentinel order -1 is below every stored display_order, and the empty
    // id sorts before every uuid, so the first page is the whole course.
    const cursor = rawCursor === undefined ? { displayOrder: -1, id: '' } : decodeUnitCursor(rawCursor);
    if (cursor === null) return res.status(400).json({ error: 'Invalid course unit list cursor' });

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    let connection: CourseUnitConnection | null = null;
    let transactionStarted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<boolean> => {
      try {
        await connection!.rollback();
        return true;
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error('Rollback course unit list error (connection will be discarded):', rollbackError);
        return false;
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      // The owner is determined BEFORE the course is looked up, so a
      // non-owner learns nothing about whether a course exists.
      const owner = await verifyTenantOwner(connection, userId, tenantId, false);
      if (!owner) {
        await rollbackOrDiscard();
        return res.status(403).json({ error: 'Forbidden' });
      }
      const course = await resolveCourse(connection, courseId, tenantId, false);
      if (!course) {
        await rollbackOrDiscard();
        return res.status(404).json({ error: 'Course not found' });
      }
      // One extra row is read to learn whether another page exists; only the
      // requested page size is ever returned.
      const [rows] = await connection.execute(
        `SELECT ${UNIT_PROJECTION}
         FROM course_units u
         WHERE u.course_id=? AND (u.display_order>? OR (u.display_order=? AND u.id>?))
         ORDER BY u.display_order ASC, u.id ASC LIMIT ?`,
        [courseId, cursor.displayOrder, cursor.displayOrder, cursor.id, limit + 1]
      );
      const page = (rows as any[]) ?? [];
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      // The DTO is materialized from the epoch projection BEFORE the read
      // transaction is closed. A row whose stored instant cannot be rendered
      // truthfully fails the whole page: a 1970 instant, the current time or
      // a null date is never fabricated.
      const units: any[] = [];
      for (const row of visible) {
        const dto = courseUnitDto(row);
        if (dto === null) {
          console.error('List course units error: unreadable unit timestamp projection');
          await rollbackOrDiscard();
          return res.status(500).json({ error: 'Failed to list course units' });
        }
        units.push(dto);
      }
      await rollbackOrDiscard();
      return res.json({
        units,
        next_cursor:
          hasMore && visible.length > 0
            ? encodeUnitCursor(Number(visible[visible.length - 1].display_order), String(visible[visible.length - 1].id))
            : null,
      });
    } catch (error) {
      if (transactionStarted) {
        console.error('List course units error:', error);
        await rollbackOrDiscard();
      } else {
        // The connection exists but its transaction state is not confirmed.
        // Discard rather than pooling a possibly-dirty session.
        disposal = 'destroy';
        console.error('List course units error before transaction start:', error);
      }
      return res.status(500).json({ error: 'Failed to list course units' });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  });

  /**
   * POST /api/tenants/me/catalog/courses/:courseId/units — create one private
   * unit under an active course of the selected tenant.
   *
   * Owner-only and strict: the payload is `{name}` plus an optional
   * `display_order`, and any other key (a tenant/course/owner selector, a
   * publication or paid field, a status) is rejected before a connection is
   * taken. The name is trimmed to 1..255 characters; the order must already
   * be an integer in 0..2147483647 and defaults to 0. The unit id is
   * server-generated and the course is the one named in the path, so a client
   * can never place a unit under another tenant's course. Duplicate names
   * are allowed and the order may tie: the id is the tie-breaker. The insert
   * and its audit event are committed together, and success is reported only
   * after `commit()` resolves. `Cache-Control: no-store` is set before the
   * first await / any denial.
   */
  router.post('/courses/:courseId/units', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(400).json({ error: 'Invalid course id' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Invalid course unit payload' });
    }
    const keys = Object.keys(body);
    if (keys.length < 1 || keys.length > 2) {
      return res.status(400).json({ error: 'Invalid course unit payload' });
    }
    for (const key of keys) {
      if (key !== 'name' && key !== 'display_order') {
        return res.status(400).json({ error: 'Invalid course unit payload' });
      }
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'name')) {
      return res.status(400).json({ error: 'Invalid course unit payload' });
    }
    const name = parseUnitName((body as Record<string, unknown>).name);
    if (name === null) return res.status(400).json({ error: 'Invalid course unit payload' });
    let displayOrder = 0;
    if (Object.prototype.hasOwnProperty.call(body, 'display_order')) {
      const parsed = parseDisplayOrder((body as Record<string, unknown>).display_order);
      if (parsed === null) return res.status(400).json({ error: 'Invalid course unit payload' });
      displayOrder = parsed;
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    let connection: CourseUnitConnection | null = null;
    let transactionStarted = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<boolean> => {
      try {
        await connection!.rollback();
        return true;
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error('Rollback course unit create error (connection will be discarded):', rollbackError);
        return false;
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      // The owner is determined BEFORE the course is looked up, so a
      // non-owner learns nothing about whether a course exists.
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) {
        await rollbackOrDiscard();
        return res.status(403).json({ error: 'Forbidden' });
      }
      // The course is locked for the write, so an archive or an ownership
      // change cannot race the insert.
      const course = await resolveCourse(connection, courseId, tenantId, true);
      if (!course) {
        await rollbackOrDiscard();
        return res.status(404).json({ error: 'Course not found' });
      }
      const unitId = randomUUID();
      await connection.execute(
        'INSERT INTO course_units (id,course_id,name,display_order,status) VALUES (?,?,?,?,?)',
        [unitId, courseId, name, displayOrder, 'active']
      );
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'course.unit_created', 'course_unit', unitId,
          null, JSON.stringify({ course_id: courseId, name, display_order: displayOrder, status: 'active' })]
      );
      // The row is read back inside the same transaction so the response
      // carries the exact stored instant instead of a guessed one.
      const [rows] = await connection.execute(
        `SELECT ${UNIT_PROJECTION}
         FROM course_units u WHERE u.id=? AND u.course_id=? LIMIT 1`,
        [unitId, courseId]
      );
      const created = (rows as any[])[0];
      if (!created) {
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to create course unit' });
      }
      // The DTO is materialized from the epoch projection INSIDE the
      // transaction and BEFORE the commit: an unreadable stored instant
      // fails the write instead of committing a row whose date could only be
      // guessed.
      const dto = courseUnitDto(created);
      if (dto === null) {
        console.error('Create course unit error: unreadable unit timestamp projection');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to create course unit' });
      }
      commitAttempted = true;
      await connection.commit();
      return res.status(201).json({ unit: dto });
    } catch (error) {
      if (commitAttempted) {
        // The commit acknowledgement was lost: whether the write persisted is
        // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
        // never return this connection to the pool.
        disposal = 'destroy';
        console.error('Create course unit error after commit attempt (persistence uncertain):', error);
      } else if (transactionStarted) {
        console.error('Create course unit error:', error);
        await rollbackOrDiscard();
      } else {
        disposal = 'destroy';
        console.error('Create course unit error before transaction start:', error);
      }
      return res.status(500).json({ error: 'Failed to create course unit' });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  });

  /**
   * PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId — rename,
   * reorder, archive or reactivate one private unit.
   *
   * Owner-only and strict: the body may carry `name`, `display_order` and/or
   * `status` only, an empty update is rejected, `status` must be exactly
   * 'active' or 'archived', and the order must already be an integer in
   * 0..2147483647. The lookup always qualifies BOTH the unit id and the
   * course of the path, so a foreign and an absent unit produce the
   * identical not-found result and no ownership is disclosed. A change to
   * the current values is a truthful no-op: no UPDATE and no audit event. A
   * reordered unit only moves its own metadata position: no other unit is
   * renumbered and no ordering policy is claimed. The update and its audit
   * event are committed together, and success is reported only after
   * `commit()` resolves. `Cache-Control: no-store` is set before the first
   * await / any denial.
   */
  router.patch('/courses/:courseId/units/:unitId', async (req: AuthRequest, res: Response) => {
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
      return res.status(400).json({ error: 'Invalid course unit update payload' });
    }
    const keys = Object.keys(body);
    if (keys.length === 0) return res.status(400).json({ error: 'Invalid course unit update payload' });
    for (const key of keys) {
      if (key !== 'name' && key !== 'display_order' && key !== 'status') {
        return res.status(400).json({ error: 'Invalid course unit update payload' });
      }
    }
    let nextName: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      nextName = parseUnitName((body as Record<string, unknown>).name);
      if (nextName === null) return res.status(400).json({ error: 'Invalid course unit update payload' });
    }
    let nextDisplayOrder: number | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'display_order')) {
      nextDisplayOrder = parseDisplayOrder((body as Record<string, unknown>).display_order);
      if (nextDisplayOrder === null) return res.status(400).json({ error: 'Invalid course unit update payload' });
    }
    let nextStatus: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const rawStatus = (body as Record<string, unknown>).status;
      if (typeof rawStatus !== 'string' || !UNIT_STATUSES.includes(rawStatus)) {
        return res.status(400).json({ error: 'Invalid course unit update payload' });
      }
      nextStatus = rawStatus;
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    let connection: CourseUnitConnection | null = null;
    let transactionStarted = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<boolean> => {
      try {
        await connection!.rollback();
        return true;
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error('Rollback course unit update error (connection will be discarded):', rollbackError);
        return false;
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      // The owner is determined BEFORE the course is looked up, so a
      // non-owner learns nothing about whether a course exists.
      const owner = await verifyTenantOwner(connection, userId, tenantId, true);
      if (!owner) {
        await rollbackOrDiscard();
        return res.status(403).json({ error: 'Forbidden' });
      }
      // The course is locked for the write, so an archive or an ownership
      // change cannot race the update.
      const course = await resolveCourse(connection, courseId, tenantId, true);
      if (!course) {
        await rollbackOrDiscard();
        return res.status(404).json({ error: 'Course not found' });
      }
      // Course-qualified and locked: a foreign unit id is simply not found
      // here, and the row lock serializes concurrent writes on the same unit.
      const [rows] = await connection.execute(
        `SELECT ${UNIT_PROJECTION}
         FROM course_units u WHERE u.id=? AND u.course_id=? FOR UPDATE`,
        [unitId, courseId]
      );
      const current = (rows as any[])[0];
      if (!current) {
        await rollbackOrDiscard();
        return res.status(404).json({ error: 'Course unit not found' });
      }
      const currentName = String(current.name);
      const currentDisplayOrder = Number(current.display_order);
      const currentStatus = String(current.status);
      const finalName = nextName === null ? currentName : nextName;
      const finalDisplayOrder = nextDisplayOrder === null ? currentDisplayOrder : nextDisplayOrder;
      const finalStatus = nextStatus === null ? currentStatus : nextStatus;
      if (finalName === currentName && finalDisplayOrder === currentDisplayOrder && finalStatus === currentStatus) {
        // Truthful no-op: identical values write and audit nothing.
        const currentDto = courseUnitDto(current);
        if (currentDto === null) {
          console.error('Update course unit error: unreadable unit timestamp projection');
          await rollbackOrDiscard();
          return res.status(500).json({ error: 'Failed to update course unit' });
        }
        await rollbackOrDiscard();
        return res.json({ unit: currentDto });
      }
      const [updateResult] = await connection.execute(
        'UPDATE course_units SET name=?,display_order=?,status=? WHERE id=? AND course_id=?',
        [finalName, finalDisplayOrder, finalStatus, unitId, courseId]
      );
      if (Number((updateResult as any)?.affectedRows) !== 1) {
        await rollbackOrDiscard();
        return res.status(409).json({ error: 'Course unit was modified concurrently' });
      }
      await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), userId, tenantId, 'course.unit_updated', 'course_unit', unitId,
          JSON.stringify({ course_id: courseId, name: currentName, display_order: currentDisplayOrder, status: currentStatus }),
          JSON.stringify({ course_id: courseId, name: finalName, display_order: finalDisplayOrder, status: finalStatus })]
      );
      const [updatedRows] = await connection.execute(
        `SELECT ${UNIT_PROJECTION}
         FROM course_units u WHERE u.id=? AND u.course_id=? LIMIT 1`,
        [unitId, courseId]
      );
      const updated = (updatedRows as any[])[0];
      if (!updated) {
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to update course unit' });
      }
      // The DTO is materialized from the epoch projection INSIDE the
      // transaction and BEFORE the commit: an unreadable stored instant
      // fails the write instead of committing a row whose date could only be
      // guessed.
      const dto = courseUnitDto(updated);
      if (dto === null) {
        console.error('Update course unit error: unreadable unit timestamp projection');
        await rollbackOrDiscard();
        return res.status(500).json({ error: 'Failed to update course unit' });
      }
      commitAttempted = true;
      await connection.commit();
      return res.json({ unit: dto });
    } catch (error) {
      if (commitAttempted) {
        // The commit acknowledgement was lost: persistence is UNKNOWN. No
        // rollback is claimed, no silent retry happens, and the connection is
        // discarded instead of returning to the shared pool.
        disposal = 'destroy';
        console.error('Update course unit error after commit attempt (persistence uncertain):', error);
      } else if (transactionStarted) {
        console.error('Update course unit error:', error);
        await rollbackOrDiscard();
      } else {
        disposal = 'destroy';
        console.error('Update course unit error before transaction start:', error);
      }
      return res.status(500).json({ error: 'Failed to update course unit' });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  });

  return router;
};
