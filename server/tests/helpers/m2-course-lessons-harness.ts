/**
 * M2-B05 — shared hermetic harness for the private course-lesson suites.
 *
 * This module is TEST-ONLY support. It provides:
 *   * positive import interception of the forbidden default modules
 *     (`src/db`, `src/services/minio`, `src/services/subscription-renewal`,
 *     `dotenv`) so the real production modules can be composed without a
 *     database, a provider, an environment file or a listener;
 *   * a synthetic, transaction-aware fixture connection that replays the
 *     exact statements the real handlers issue, snapshotting the lesson rows
 *     on `beginTransaction` and restoring them on `rollback`, so a leaked
 *     partial state is observable instead of hidden;
 *   * the real production composition (optional auth -> tenant-authority
 *     boundary -> student-workspace boundary -> real tenant-self router with
 *     the real lesson router mounted under `/catalog`) with only leaf data
 *     repositories and the transactional connection injected;
 *   * request/response plumbing that drives the real Express chain without a
 *     socket.
 *
 * No production handler logic is copied here: the fixture only answers SQL.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

export const TEST_SECRET = 'm2-b05-hermetic-jwt-secret-not-a-real-key';

const normalize = (id: string) => path.resolve(id).toLowerCase();

export interface Isolation {
  /** Every interception that actually happened, in order. */
  interceptionLog: string[];
  /** Every forbidden default adapter that was CALLED (must stay empty). */
  sentinelCalls: string[];
  install(): void;
  restore(): void;
  /** Require one module while the sentinels are installed. */
  load(specifier: string): any;
  /** The resolved ids of the intercepted modules, for assertions. */
  interceptedIds(): string[];
  /** True when the CommonJS loader hook is back to the original. */
  hookRestored(): boolean;
}

export function createIsolation(): Isolation {
  const interceptionLog: string[] = [];
  const sentinelCalls: string[] = [];
  const originalLoad = (Module as any)._load;

  const violation = (name: string): never => {
    sentinelCalls.push(name);
    throw new Error(`HERMETIC_VIOLATION:${name}`);
  };

  const dbSentinel = {
    query: async (): Promise<any> => violation('db.query'),
    queryOne: async (): Promise<any> => violation('db.queryOne'),
    execute: async (): Promise<any> => violation('db.execute'),
    getPool: (): never => violation('db.getPool'),
  };
  const minioSentinel = {
    BUCKETS: { PAYMENT_PROOFS: 'payment-proofs', LECTURES: 'lectures' },
    uploadBuffer: async (): Promise<any> => violation('minio.uploadBuffer'),
    deleteFile: async (): Promise<any> => violation('minio.deleteFile'),
    getPrivateObjectUrl: async (): Promise<any> => violation('minio.getPrivateObjectUrl'),
  };
  const renewalSentinel = {
    executeRenewalIntent: async (): Promise<any> => violation('renewal.executeRenewalIntent'),
  };
  const dotenvSentinel = {
    config: (): never => violation('dotenv.config'),
  };

  const sentinelByPath = new Map<string, { id: string; exports: unknown }>();
  const register = (absolute: string, exports: unknown) => {
    const id = require.resolve(absolute);
    sentinelByPath.set(normalize(id), { id, exports });
  };

  // Resolved from THIS file: tests/helpers -> server/src/...
  register(path.join(__dirname, '../../src/db'), dbSentinel);
  register(path.join(__dirname, '../../src/services/minio'), minioSentinel);
  register(path.join(__dirname, '../../src/services/subscription-renewal'), renewalSentinel);
  register('dotenv', dotenvSentinel);

  const install = () => {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
      let resolved: string | null = null;
      if (parent && typeof parent.filename === 'string') {
        try { resolved = Module.createRequire(parent.filename).resolve(request); }
        catch { resolved = null; }
      }
      const hit = resolved ? sentinelByPath.get(normalize(resolved)) : undefined;
      if (hit) {
        interceptionLog.push(hit.id);
        return hit.exports;
      }
      return originalLoad.apply(this, [request, parent, isMain]);
    };
  };

  const restore = () => { (Module as any)._load = originalLoad; };

  const load = (specifier: string) => {
    install();
    try {
      return require(specifier);
    } finally {
      restore();
    }
  };

  return {
    interceptionLog,
    sentinelCalls,
    install,
    restore,
    load,
    interceptedIds: () => [...sentinelByPath.values()].map(entry => entry.id),
    hookRestored: () => (Module as any)._load === originalLoad,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixture state
// ---------------------------------------------------------------------------

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';
export const OWNER_A = 'owner-a';
export const OWNER_B = 'owner-b';
export const INSTRUCTOR_A = 'instructor-a';
export const ROLE_OWNER_MEMBER = 'role-owner-member-1';
export const BILLING_ONLY = 'billing-only-instructor-1';
export const MULTI = 'multi-1';
export const STUDENT = 'student-1';
export const ADMIN = 'admin-1';
export const NO_SCOPE = 'no-scope-1';

export const COURSE_A1 = 'a1000000-0000-4000-8000-000000000001';
export const COURSE_A2 = 'a1000000-0000-4000-8000-000000000002';
export const COURSE_B1 = 'b1000000-0000-4000-8000-000000000001';
export const COURSE_NULL = 'c1000000-0000-4000-8000-000000000001';
export const COURSE_INACTIVE = 'c2000000-0000-4000-8000-000000000001';
export const ABSENT_COURSE = 'd1000000-0000-4000-8000-000000000000';

export const UNIT_A1 = 'e1000000-0000-4000-8000-000000000001';
export const UNIT_A1_ARCHIVED = 'e1000000-0000-4000-8000-000000000002';
export const UNIT_A2 = 'e1000000-0000-4000-8000-000000000003';
export const UNIT_B1 = 'f1000000-0000-4000-8000-000000000001';
export const UNIT_C1 = 'f2000000-0000-4000-8000-000000000001';
export const ABSENT_UNIT = 'f3000000-0000-4000-8000-000000000000';

export const LESSON_1 = '11110000-0000-4000-8000-000000000001';
export const LESSON_2 = '11110000-0000-4000-8000-000000000002';
export const LESSON_3 = '11110000-0000-4000-8000-000000000003';
export const LESSON_ARCHIVED = '11110000-0000-4000-8000-000000000004';
export const LESSON_OTHER_UNIT = '22220000-0000-4000-8000-000000000001';
export const LESSON_UNIT_B = '33330000-0000-4000-8000-000000000001';
export const ABSENT_LESSON = '44440000-0000-4000-8000-000000000000';

/**
 * The DECLARED comparison of a lesson id.
 *
 * `course_lessons.id` is `CHAR(36)` in a `utf8mb4_unicode_ci` table (see
 * `server/migrations/20261021_01_course_lessons.sql`), so MySQL compares the
 * id CASE-INSENSITIVELY: an uppercase uuid addresses the very same stored row
 * as its lowercase spelling, and `id IN (…)` matches a row whose stored
 * spelling differs from the bound value.
 *
 * The fixture emulates that DECLARED comparison instead of a byte-exact one.
 * A handler that treats two spellings of one id as two identities is then
 * observable here — an uppercase id reaches the row, a case-variant duplicate
 * is the same identity — instead of being visible only in a real database.
 * The emulation is a comparison rule of the fixture, not a claim that a real
 * MySQL was exercised.
 */
export const sameStoredId = (requested: unknown, stored: unknown): boolean =>
  String(requested).toLowerCase() === String(stored).toLowerCase();

/** The canonical identity of an id under that declared collation. */
export const canonicalStoredId = (value: unknown): string => String(value).toLowerCase();

/** The declared (case-insensitive) ordering of two ids. */
export const compareStoredIds = (left: unknown, right: unknown): number => {
  const a = canonicalStoredId(left);
  const b = canonicalStoredId(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

export interface TenantRow {
  id: string;
  business_name: string;
  subject_type: string | null;
  status: string;
  legacy_compat: number;
  owner_user_id: string;
}

export interface IdentityRow { is_active: number; token_version: number; suspension_active: number }
export interface CourseRow { id: string; tenant_id: string | null; is_active: number }
export interface UnitRow { id: string; course_id: string; name: string; display_order: number; status: string }

export interface LessonRow {
  id: string;
  unit_id: string;
  title: string;
  description: string | null;
  display_order: number;
  status: string;
  release_at?: Date | null;
  prerequisite_lesson_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The stored instant of a lesson.
 *
 * `epochSeconds` is the exact stored instant — what `UNIX_TIMESTAMP(col)`
 * returns for a TIMESTAMP column, independently of the session time zone.
 *
 * `driverDate` emulates the INSTALLED mysql2 decoder with the pool's
 * `timezone: '+02:00'`: that option makes the driver INTERPRET the wall
 * time it receives, so the Date it hands back is shifted by -2h from the
 * stored instant. The projection below returns BOTH, so a handler that
 * serialized the raw datetime column would answer a shifted instant and the
 * regression is observable instead of hidden.
 */
export const DRIVER_OFFSET_SECONDS = 2 * 60 * 60;
export const epochOf = (instant: Date): number => Math.floor(instant.getTime() / 1000);
export const driverDateOf = (instant: Date): Date => new Date(instant.getTime() - DRIVER_OFFSET_SECONDS * 1000);

export type MalformedEpoch = 'none' | 'null' | 'zero' | 'nan' | 'text' | 'missing';

export interface State {
  users: Record<string, IdentityRow>;
  instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
  memberships: Record<string, string[]>;
  tenantOwner: Record<string, string>;
  membershipRole: Record<string, string>;
  enrollments: Record<string, Array<{ id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }>>;
  tenants: TenantRow[];
  courses: CourseRow[];
  units: UnitRow[];
  lessons: LessonRow[];
  lessonClock: number;
  failAcquire: boolean;
  failBegin: boolean;
  failOwnerSelect: boolean;
  failCourseSelect: boolean;
  failUnitSelect: boolean;
  failList: boolean;
  failInsert: boolean;
  failAudit: boolean;
  /** Fail the Nth audit insert (1-based) inside a reorder batch. */
  failAuditAt: number | null;
  failCommit: boolean;
  failRollback: boolean;
  failLessonSelect: boolean;
  failReadBack: boolean;
  failBatchLock: boolean;
  failBatchRead: boolean;
  /** Fail the Nth reorder UPDATE (1-based) inside a batch. */
  failReorderUpdateAt: number | null;
  affectedRowsOverride: number | null;
  malformedEpoch: MalformedEpoch;
}

export const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
export const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });
/** A synthetic stored instant: 2026-10-21 at HH:MM UTC. */
export const stamp = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 21, hour, minute, 0));

export function makeState(): State {
  return {
    users: {
      [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(),
      [ROLE_OWNER_MEMBER]: identity(), [BILLING_ONLY]: identity(), [MULTI]: identity(),
      [STUDENT]: identity(), [ADMIN]: identity(), [NO_SCOPE]: identity(),
    },
    instructorAccounts: {
      [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(), [INSTRUCTOR_A]: activeAccount(),
      [ROLE_OWNER_MEMBER]: activeAccount(), [MULTI]: activeAccount(), [NO_SCOPE]: activeAccount(),
      // A live instructor account that is neither legacy-compatible nor
      // explicitly allowed: the authentication middleware marks the
      // principal `billingOnly` instead of denying the request.
      [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
    },
    memberships: {
      [OWNER_A]: [TENANT_A],
      [OWNER_B]: [TENANT_B],
      [INSTRUCTOR_A]: [TENANT_A],
      [ROLE_OWNER_MEMBER]: [TENANT_A],
      [BILLING_ONLY]: [TENANT_A],
      [MULTI]: [TENANT_A, TENANT_B],
      [STUDENT]: [],
      [ADMIN]: [],
      [NO_SCOPE]: [],
    },
    tenantOwner: {
      [TENANT_A]: OWNER_A,
      [TENANT_B]: OWNER_B,
    },
    membershipRole: {
      [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
      [`${ROLE_OWNER_MEMBER}@${TENANT_A}`]: 'owner',
      [`${BILLING_ONLY}@${TENANT_A}`]: 'instructor',
      [`${MULTI}@${TENANT_A}`]: 'instructor',
      [`${MULTI}@${TENANT_B}`]: 'instructor',
    },
    enrollments: {
      [STUDENT]: [{ id: 'enrollment-1', user_id: STUDENT, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: 'g-1', grade_id: 'gr-1' }],
    },
    tenants: [
      { id: TENANT_A, business_name: 'Synthetic Academy A', subject_type: 'institute', status: 'active', legacy_compat: 1, owner_user_id: OWNER_A },
      { id: TENANT_B, business_name: 'Synthetic Academy B', subject_type: 'institute', status: 'active', legacy_compat: 1, owner_user_id: OWNER_B },
      { id: 'tenant-inactive', business_name: 'Synthetic Academy C', subject_type: 'institute', status: 'suspended', legacy_compat: 1, owner_user_id: OWNER_A },
    ],
    courses: [
      { id: COURSE_A1, tenant_id: TENANT_A, is_active: 1 },
      { id: COURSE_A2, tenant_id: TENANT_A, is_active: 1 },
      { id: COURSE_B1, tenant_id: TENANT_B, is_active: 1 },
      { id: COURSE_NULL, tenant_id: null, is_active: 1 },
      { id: COURSE_INACTIVE, tenant_id: TENANT_A, is_active: 0 },
    ],
    units: [
      { id: UNIT_A1, course_id: COURSE_A1, name: 'Unit A1', display_order: 0, status: 'active' },
      { id: UNIT_A1_ARCHIVED, course_id: COURSE_A1, name: 'Unit A1 archived', display_order: 1, status: 'archived' },
      { id: UNIT_A2, course_id: COURSE_A2, name: 'Unit A2', display_order: 0, status: 'active' },
      { id: UNIT_B1, course_id: COURSE_B1, name: 'Unit B1', display_order: 0, status: 'active' },
      { id: UNIT_C1, course_id: COURSE_NULL, name: 'Unit C1', display_order: 0, status: 'active' },
    ],
    lessons: [
      {
        id: LESSON_1, unit_id: UNIT_A1, title: 'Lesson one', description: 'First lesson',
        display_order: 0, status: 'active', created_at: stamp(8, 0), updated_at: stamp(8, 0),
      },
      {
        id: LESSON_2, unit_id: UNIT_A1, title: 'Lesson two', description: null,
        display_order: 1, status: 'active', created_at: stamp(8, 5), updated_at: stamp(8, 5),
      },
      {
        id: LESSON_3, unit_id: UNIT_A1, title: 'Lesson three', description: null,
        display_order: 1, status: 'active', created_at: stamp(8, 10), updated_at: stamp(8, 10),
      },
      {
        id: LESSON_ARCHIVED, unit_id: UNIT_A1, title: 'Archived lesson', description: null,
        display_order: 2, status: 'archived', created_at: stamp(8, 15), updated_at: stamp(8, 15),
      },
      {
        id: LESSON_OTHER_UNIT, unit_id: UNIT_A2, title: 'Lesson of another unit', description: null,
        display_order: 0, status: 'active', created_at: stamp(8, 20), updated_at: stamp(8, 20),
      },
      {
        id: LESSON_UNIT_B, unit_id: UNIT_B1, title: 'Lesson of another tenant', description: null,
        display_order: 0, status: 'active', created_at: stamp(8, 25), updated_at: stamp(8, 25),
      },
    ],
    lessonClock: 0,
    failAcquire: false,
    failBegin: false,
    failOwnerSelect: false,
    failCourseSelect: false,
    failUnitSelect: false,
    failList: false,
    failInsert: false,
    failAudit: false,
    failAuditAt: null,
    failCommit: false,
    failRollback: false,
    failLessonSelect: false,
    failReadBack: false,
    failBatchLock: false,
    failBatchRead: false,
    failReorderUpdateAt: null,
    affectedRowsOverride: null,
    malformedEpoch: 'none',
  };
}

// ---------------------------------------------------------------------------
// The exact statements the real handlers issue
// ---------------------------------------------------------------------------

export const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export const LESSON_PROJECTION =
  'l.id,l.unit_id,l.title,l.description,l.display_order,l.status,' +
  'UNIX_TIMESTAMP(l.release_at) AS release_at_epoch,l.prerequisite_lesson_id,' +
  'UNIX_TIMESTAMP(l.created_at) AS created_at_epoch,' +
  'UNIX_TIMESTAMP(l.updated_at) AS updated_at_epoch';

export const OWNER_SELECT =
  'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';
export const COURSE_SELECT = 'SELECT c.id,c.tenant_id FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=1';
export const UNIT_SELECT = 'SELECT u.id,u.course_id FROM course_units u WHERE u.id=? AND u.course_id=?';
export const LIST_SQL =
  `SELECT ${LESSON_PROJECTION} FROM course_lessons l WHERE l.unit_id=? AND (l.display_order>? OR (l.display_order=? AND l.id>?)) ` +
  'ORDER BY l.display_order ASC, l.id ASC LIMIT ?';
export const LESSON_SELECT = `SELECT ${LESSON_PROJECTION} FROM course_lessons l WHERE l.id=? AND l.unit_id=? LIMIT 1`;
export const LESSON_LOCK_SELECT = `SELECT ${LESSON_PROJECTION} FROM course_lessons l WHERE l.id=? AND l.unit_id=? FOR UPDATE`;
export const BATCH_LOCK_PREFIX = `SELECT ${LESSON_PROJECTION} FROM course_lessons l WHERE l.unit_id=? AND l.id IN (`;
export const BATCH_LOCK_SUFFIX = ') ORDER BY l.id ASC FOR UPDATE';
export const BATCH_READ_SUFFIX = ') ORDER BY l.display_order ASC, l.id ASC';
export const INSERT_SQL = 'INSERT INTO course_lessons (id,unit_id,title,description,display_order,status,release_at,prerequisite_lesson_id) VALUES (?,?,?,?,?,?,NULL,?)';
export const INSERT_SQL_WITH_RELEASE = 'INSERT INTO course_lessons (id,unit_id,title,description,display_order,status,release_at,prerequisite_lesson_id) VALUES (?,?,?,?,?,?,FROM_UNIXTIME(?),?)';
export const UPDATE_SQL = 'UPDATE course_lessons SET title=?,description=?,display_order=?,status=?,release_at=NULL,prerequisite_lesson_id=? WHERE id=? AND unit_id=?';
export const UPDATE_SQL_WITH_RELEASE = 'UPDATE course_lessons SET title=?,description=?,display_order=?,status=?,release_at=FROM_UNIXTIME(?),prerequisite_lesson_id=? WHERE id=? AND unit_id=?';
export const REORDER_UPDATE_SQL = 'UPDATE course_lessons SET display_order=? WHERE id=? AND unit_id=?';
export const AUDIT_SQL =
  'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Call { sql: string; params: any[] }

export interface Harness {
  chain: RequestHandler[];
  calls: Call[];
  auditRows: Call[];
  events: string[];
  state: State;
  connectionCount: () => number;
  releaseCount: () => number;
  destroyCount: () => number;
  commitCount: () => number;
  rollbackCount: () => number;
  /** The lesson rows that a rollback would restore, for leak assertions. */
  committedLessons: () => LessonRow[];
}

export interface AppModules {
  auth: any;
  boundary: any;
  studentBoundary: any;
  tenantSelf: any;
}

/** Load the real production modules under the installed sentinels. */
export function loadAppModules(isolation: Isolation, tenantSelfSpecifier: string): AppModules {
  isolation.install();
  try {
    const auth = require(path.join(__dirname, '../../src/middleware/auth'));
    const boundary = require(path.join(__dirname, '../../src/middleware/tenant-authority-boundary'));
    const studentBoundary = require(path.join(__dirname, '../../src/middleware/student-workspace-boundary'));
    const tenantSelf = require(tenantSelfSpecifier);
    return { auth, boundary, studentBoundary, tenantSelf };
  } finally {
    isolation.restore();
  }
}

export function buildHarness(state: State, modules: AppModules): Harness {
  const calls: Call[] = [];
  const auditRows: Call[] = [];
  const events: string[] = [];
  let connectionCount = 0;
  let releaseCount = 0;
  let destroyCount = 0;
  let commitCount = 0;
  let rollbackCount = 0;
  let snapshot: LessonRow[] | null = null;
  let auditSnapshot = 0;
  let auditSequence = 0;
  let reorderSequence = 0;

  const lessonRow = (id: string, unitId: string) =>
    state.lessons.find(l => sameStoredId(l.id, id) && sameStoredId(l.unit_id, unitId)) ?? null;

  /**
   * Project a stored lesson row the way the production projection reads it:
   * the two instants as epoch seconds, next to the raw datetime columns the
   * installed driver would have decoded with its `timezone: '+02:00'`
   * interpretation. The malformed-epoch variants emulate a broken projection
   * so the refusal of an unreadable instant is observable.
   */
  const projectedRow = (row: LessonRow): any => {
    const projected: any = {
      ...row,
      created_at: driverDateOf(row.created_at),
      updated_at: driverDateOf(row.updated_at),
      created_at_epoch: epochOf(row.created_at),
      updated_at_epoch: epochOf(row.updated_at),
      release_at_epoch: row.release_at === null || row.release_at === undefined ? null : epochOf(row.release_at),
      prerequisite_lesson_id: row.prerequisite_lesson_id === undefined ? null : row.prerequisite_lesson_id,
    };
    if (state.malformedEpoch === 'null') {
      projected.created_at_epoch = null;
      projected.updated_at_epoch = null;
    } else if (state.malformedEpoch === 'zero') {
      projected.created_at_epoch = 0;
      projected.updated_at_epoch = 0;
    } else if (state.malformedEpoch === 'nan') {
      projected.created_at_epoch = Number.NaN;
      projected.updated_at_epoch = Number.NaN;
    } else if (state.malformedEpoch === 'text') {
      projected.created_at_epoch = 'not-an-epoch';
      projected.updated_at_epoch = 'not-an-epoch';
    } else if (state.malformedEpoch === 'missing') {
      delete projected.created_at_epoch;
      delete projected.updated_at_epoch;
    }
    return projected;
  };

  const sortedByOrder = (rows: LessonRow[]) =>
    [...rows].sort((x, y) => (x.display_order - y.display_order) || compareStoredIds(x.id, y.id));
  const sortedById = (rows: LessonRow[]) =>
    [...rows].sort((x, y) => compareStoredIds(x.id, y.id));

  const lessonSql = async (sql: string, params: any[]): Promise<[any, any]> => {
    const n = squash(sql);
    calls.push({ sql, params });

    if (n === OWNER_SELECT || n === `${OWNER_SELECT} FOR UPDATE`) {
      events.push('owner');
      if (state.failOwnerSelect) throw new Error('owner verification failed: internal detail leaked');
      const tenant = state.tenants.find(t => t.id === params[1]);
      const user = state.users[params[0]];
      if (!tenant || !user) return [[], []];
      return [[{
        owner_user_id: tenant.owner_user_id,
        tenant_status: tenant.status,
        caller_active: user.is_active,
      }], []];
    }

    if (n === COURSE_SELECT || n === `${COURSE_SELECT} FOR UPDATE`) {
      events.push('course');
      if (state.failCourseSelect) throw new Error('course lookup failed: internal detail leaked');
      const course = state.courses.find(c => sameStoredId(c.id, params[0]) && c.tenant_id === params[1] && c.is_active === 1);
      return [course ? [{ id: course.id, tenant_id: course.tenant_id }] : [], []];
    }

    if (n === UNIT_SELECT || n === `${UNIT_SELECT} FOR UPDATE`) {
      events.push('unit');
      if (state.failUnitSelect) throw new Error('unit lookup failed: internal detail leaked');
      const unit = state.units.find(u => sameStoredId(u.id, params[0]) && sameStoredId(u.course_id, params[1]));
      return [unit ? [{ id: unit.id, course_id: unit.course_id }] : [], []];
    }

    if (n === LIST_SQL) {
      events.push('list');
      if (state.failList) throw new Error('course lesson list failed: internal detail leaked');
      const [unitId, afterOrder, tieOrder, afterId, limit] = params;
      const rows = state.lessons
        .filter(l => sameStoredId(l.unit_id, unitId))
        .filter(l => l.display_order > Number(afterOrder) || (l.display_order === Number(tieOrder) && compareStoredIds(l.id, afterId) > 0))
        .sort((x, y) => (x.display_order - y.display_order) || compareStoredIds(x.id, y.id))
        .slice(0, Number(limit))
        .map(projectedRow);
      return [rows, []];
    }

    if (n === LESSON_LOCK_SELECT) {
      events.push('lesson_lock');
      if (state.failLessonSelect) throw new Error('course lesson lookup failed: internal detail leaked');
      const row = lessonRow(String(params[0]), String(params[1]));
      return [row ? [projectedRow(row)] : [], []];
    }

    if (n === LESSON_SELECT) {
      events.push('lesson_select');
      if (state.failReadBack) return [[], []];
      const row = lessonRow(String(params[0]), String(params[1]));
      return [row ? [projectedRow(row)] : [], []];
    }

    if (n.startsWith(BATCH_LOCK_PREFIX) && n.endsWith(BATCH_LOCK_SUFFIX)) {
      events.push('batch_lock');
      if (state.failBatchLock) throw new Error('batch lock failed: internal detail leaked');
      const unitId = String(params[0]);
      const ids = params.slice(1).map(String);
      // The DECLARED collation: `id IN (…)` matches the row whose stored
      // spelling differs from the bound value only in case.
      const rows = sortedById(state.lessons.filter(l => sameStoredId(l.unit_id, unitId) && ids.some(id => sameStoredId(l.id, id))));
      return [rows.map(projectedRow), []];
    }

    if (n.startsWith(BATCH_LOCK_PREFIX) && n.endsWith(BATCH_READ_SUFFIX)) {
      events.push('batch_read');
      if (state.failBatchRead) return [[], []];
      const unitId = String(params[0]);
      const ids = params.slice(1).map(String);
      const rows = sortedByOrder(state.lessons.filter(l => sameStoredId(l.unit_id, unitId) && ids.some(id => sameStoredId(l.id, id))));
      return [rows.map(projectedRow), []];
    }

    if (n === INSERT_SQL) {
      events.push('insert');
      if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert on internal table course_lessons failed');
      const [id, unitId, title, description, displayOrder, status, prerequisiteId] = params;
      state.lessonClock += 1;
      const created = stamp(9, state.lessonClock);
      state.lessons.push({
        id: String(id), unit_id: String(unitId), title: String(title),
        description: description === null || description === undefined ? null : String(description),
        display_order: Number(displayOrder), status: String(status),
        release_at: null, prerequisite_lesson_id: prerequisiteId === null || prerequisiteId === undefined ? null : String(prerequisiteId),
        created_at: created, updated_at: created,
      });
      return [{ affectedRows: 1, insertId: String(id) }, []];
    }

    if (n === INSERT_SQL_WITH_RELEASE) {
      events.push('insert');
      if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert on internal table course_lessons failed');
      const [id, unitId, title, description, displayOrder, status, releaseEpoch, prerequisiteId] = params;
      state.lessonClock += 1;
      const created = stamp(9, state.lessonClock);
      state.lessons.push({
        id: String(id), unit_id: String(unitId), title: String(title),
        description: description === null || description === undefined ? null : String(description),
        display_order: Number(displayOrder), status: String(status),
        release_at: new Date(Number(releaseEpoch) * 1000),
        prerequisite_lesson_id: prerequisiteId === null || prerequisiteId === undefined ? null : String(prerequisiteId),
        created_at: created, updated_at: created,
      });
      return [{ affectedRows: 1, insertId: String(id) }, []];
    }

    if (n === UPDATE_SQL) {
      events.push('update');
      const [title, description, displayOrder, status, prerequisiteId, id, unitId] = params;
      const affected = state.affectedRowsOverride ?? 1;
      if (affected === 1) {
        const row = lessonRow(String(id), String(unitId));
        if (row) {
          row.title = String(title);
          row.description = description === null || description === undefined ? null : String(description);
          row.display_order = Number(displayOrder);
          row.status = String(status);
          row.prerequisite_lesson_id = prerequisiteId === null || prerequisiteId === undefined ? null : String(prerequisiteId);
          row.updated_at = stamp(10, 0);
        }
      }
      return [{ affectedRows: affected }, []];
    }

    if (n === UPDATE_SQL_WITH_RELEASE) {
      events.push('update');
      const [title, description, displayOrder, status, releaseEpoch, prerequisiteId, id, unitId] = params;
      const affected = state.affectedRowsOverride ?? 1;
      if (affected === 1) {
        const row = lessonRow(String(id), String(unitId));
        if (row) {
          row.title = String(title);
          row.description = description === null || description === undefined ? null : String(description);
          row.display_order = Number(displayOrder);
          row.status = String(status);
          row.release_at = new Date(Number(releaseEpoch) * 1000);
          row.prerequisite_lesson_id = prerequisiteId === null || prerequisiteId === undefined ? null : String(prerequisiteId);
          row.updated_at = stamp(10, 0);
        }
      }
      return [{ affectedRows: affected }, []];
    }

    if (n === REORDER_UPDATE_SQL) {
      reorderSequence += 1;
      events.push('reorder_update');
      if (state.failReorderUpdateAt !== null && reorderSequence === state.failReorderUpdateAt) {
        throw new Error('ER_LOCK_WAIT_TIMEOUT: reorder update on internal table course_lessons failed');
      }
      const [displayOrder, id, unitId] = params;
      const affected = state.affectedRowsOverride ?? 1;
      if (affected === 1) {
        const row = lessonRow(String(id), String(unitId));
        if (row) {
          row.display_order = Number(displayOrder);
          row.updated_at = stamp(11, reorderSequence);
        }
      }
      return [{ affectedRows: affected }, []];
    }

    if (n === AUDIT_SQL) {
      auditSequence += 1;
      events.push('audit');
      if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
      if (state.failAuditAt !== null && auditSequence === state.failAuditAt) {
        throw new Error('audit_events insert failed: internal detail leaked');
      }
      auditRows.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`Unhandled course lesson SQL in hermetic fixture: ${n}`);
  };

  const makeConnection = () => {
    connectionCount += 1;
    return {
      beginTransaction: async () => {
        events.push('begin');
        if (state.failBegin) throw new Error('begin failed: internal detail leaked');
        // The fixture replays the transaction: the lesson rows are snapshotted
        // on begin and restored on rollback, so a partial batch is observable.
        snapshot = state.lessons.map(row => ({ ...row }));
        auditSnapshot = auditRows.length;
      },
      execute: lessonSql,
      commit: async () => {
        events.push('commit');
        if (state.failCommit) throw new Error('commit acknowledgement lost: internal detail leaked');
        commitCount += 1;
        snapshot = null;
      },
      rollback: async () => {
        events.push('rollback');
        rollbackCount += 1;
        if (state.failRollback) throw new Error('rollback failed: internal detail leaked');
        if (snapshot) {
          state.lessons = snapshot.map(row => ({ ...row }));
          snapshot = null;
        }
        // The audit log is transactional too: a rolled-back insert leaves no
        // committed event behind.
        auditRows.length = Math.min(auditRows.length, auditSnapshot);
      },
      release: () => { events.push('release'); releaseCount += 1; },
      destroy: () => { events.push('destroy'); destroyCount += 1; },
    };
  };

  const db = {
    query: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.query not expected'); },
    queryOne: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.queryOne not expected'); },
    execute: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.execute not expected'); },
    getConnection: async () => {
      if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
      return makeConnection();
    },
  };

  const repository = {
    findUsersIdentity: async (id: string) => state.users[id] ?? null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id: string) => state.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id: string) => state.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id: string) => (state.memberships[id] ?? []).map(tenant_id => ({ tenant_id })),
  };

  const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const tenant = state.tenants.find(t => t.id === tenantId);
    if (!tenant || tenant.status !== 'active') return null;
    if (state.tenantOwner[tenantId] === userId) {
      return state.users[userId]?.is_active === 1 ? { authority: 'owner' } : null;
    }
    const role = state.membershipRole[`${userId}@${tenantId}`];
    if (role === 'owner' || role === 'instructor') return { authority: role };
    return null;
  };

  const tenantSelf: Router = modules.tenantSelf.createTenantSelfRouter({
    db,
    authenticate: modules.auth.createAuthenticateToken(repository),
    loadActiveTenantAuthority,
    uploadBuffer: async () => { throw new Error('HERMETIC_VIOLATION:injected.uploadBuffer'); },
    deleteFile: async () => { throw new Error('HERMETIC_VIOLATION:injected.deleteFile'); },
    getPrivateObjectUrl: async () => { throw new Error('HERMETIC_VIOLATION:injected.getPrivateObjectUrl'); },
    executeRenewalIntent: async () => { throw new Error('HERMETIC_VIOLATION:injected.executeRenewalIntent'); },
  });

  const chain: RequestHandler[] = [
    modules.auth.createOptionalAuth(repository),
    modules.boundary.enforceTenantAuthorityBoundary,
    modules.studentBoundary.enforceStudentWorkspaceBoundary,
    tenantSelf,
  ];

  return {
    chain,
    calls,
    auditRows,
    events,
    state,
    connectionCount: () => connectionCount,
    releaseCount: () => releaseCount,
    destroyCount: () => destroyCount,
    commitCount: () => commitCount,
    rollbackCount: () => rollbackCount,
    committedLessons: () => state.lessons.map(row => ({ ...row })),
  };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

export interface Result { status: number; body: any; headers: Record<string, string>; handlerReached: boolean; responseCount: number }

export interface ReqOptions {
  token?: string | null;
  method?: string;
  pathName?: string;
  query?: any;
  body?: any;
  headers?: Record<string, string>;
}

export function makeReq(opts: ReqOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
  const pathName = opts.pathName ?? '/catalog';
  return {
    method: opts.method ?? 'GET',
    url: pathName,
    originalUrl: `/api/tenants/me${pathName}`,
    path: pathName,
    headers,
    query: opts.query ?? {},
    body: opts.body ?? {},
    params: {},
    header(name: string) { return headers[name.toLowerCase()]; },
  };
}

export function runChain(chain: RequestHandler[], req: any): Promise<Result> {
  return new Promise((resolve, reject) => {
    let index = 0;
    let settled = false;
    let responseCount = 0;
    const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };

    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      status(code: number) { res.statusCode = code; return res; },
      set(name: string, value: string) { headers[name] = value; return res; },
      setHeader(name: string, value: string) { headers[name] = value; return res; },
      json(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, handlerReached: true, responseCount }); return res; },
      send(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, handlerReached: true, responseCount }); return res; },
      end() { responseCount += 1; finish({ status: res.statusCode, body: undefined, headers, handlerReached: true, responseCount }); return res; },
    };

    const next = (error?: any) => {
      if (error) { if (!settled) { settled = true; reject(error); } return; }
      const middleware = chain[index++];
      if (!middleware) {
        finish({ status: 0, body: undefined, headers, handlerReached: false, responseCount });
        return;
      }
      try {
        const outcome = (middleware as any)(req, res, next);
        if (outcome && typeof outcome.then === 'function') outcome.catch(next);
      } catch (error) {
        next(error);
      }
    };

    next();
  });
}

export const sign = (id: string, role: string, extra: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
  jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m', ...options });

export const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => undefined;
  try { return await fn(); } finally { console.error = original; }
};

/** base64url without padding — the production cursor encoding. */
export const encodeCursor = (displayOrder: number, id: string) =>
  Buffer.from(`${displayOrder}:${id}`, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const LESSON_DTO_KEYS = ['id', 'unit_id', 'title', 'description', 'display_order', 'status', 'release_at', 'prerequisite_lesson_id', 'created_at', 'updated_at'];

export const ownerToken = () => sign(OWNER_A, 'instructor');
export const lessonsPath = (courseId: string, unitId: string) => `/catalog/courses/${courseId}/units/${unitId}/lessons`;
export const lessonPath = (courseId: string, unitId: string, lessonId: string) =>
  `/catalog/courses/${courseId}/units/${unitId}/lessons/${lessonId}`;
export const reorderPath = (courseId: string, unitId: string) =>
  `/catalog/courses/${courseId}/units/${unitId}/lessons/reorder`;

export const listReq = (query: any = {}, courseId = COURSE_A1, unitId = UNIT_A1, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'GET', pathName: lessonsPath(courseId, unitId), query });
export const createReq = (body: any, courseId = COURSE_A1, unitId = UNIT_A1, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'POST', pathName: lessonsPath(courseId, unitId), body });
export const updateReq = (lessonId: string, body: any, courseId = COURSE_A1, unitId = UNIT_A1, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'PATCH', pathName: lessonPath(courseId, unitId, lessonId), body });
export const reorderReq = (body: any, courseId = COURSE_A1, unitId = UNIT_A1, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'POST', pathName: reorderPath(courseId, unitId), body });

/** Assert a DTO is exactly the ten documented fields and nothing else. */
export const assertLessonDto = (dto: any) => {
  assert.deepEqual(Object.keys(dto).sort(), [...LESSON_DTO_KEYS].sort());
  assert.equal(typeof dto.id, 'string');
  assert.equal(typeof dto.unit_id, 'string');
  assert.equal(typeof dto.title, 'string');
  assert.equal(typeof dto.display_order, 'number');
  assert.equal(typeof dto.status, 'string');
  assert.ok(dto.description === null || typeof dto.description === 'string');
  assert.ok(dto.release_at === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(dto.release_at));
  assert.ok(dto.prerequisite_lesson_id === null || typeof dto.prerequisite_lesson_id === 'string');
  assert.match(dto.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(dto.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
};

/** The statements a request issued, squashed, for call-order assertions. */
export const squashedCalls = (harness: Harness) => harness.calls.map(call => squash(call.sql));
