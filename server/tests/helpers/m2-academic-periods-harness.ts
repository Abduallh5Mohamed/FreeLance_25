/**
 * M2-B07 — shared hermetic harness for the private academic-period suites.
 *
 * This module is TEST-ONLY support. It provides:
 *   * positive import interception of the forbidden default modules
 *     (`src/db`, `src/services/minio`, `src/services/subscription-renewal`,
 *     `dotenv`) so the real production modules can be composed without a
 *     database, a provider, an environment file or a listener;
 *   * a synthetic, transaction-aware fixture connection that replays the exact
 *     statements the real academic-period handlers issue, snapshotting the
 *     period rows on `beginTransaction` and restoring them on `rollback`, so a
 *     leaked partial state is observable instead of hidden;
 *   * the real production composition (optional auth -> tenant-authority
 *     boundary -> student-workspace boundary -> real tenant-self router with
 *     the real academic-period router mounted under `/academic-periods`) with
 *     only leaf data repositories and the transactional connection injected;
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

export const TEST_SECRET = 'm2-b07-hermetic-jwt-secret-not-a-real-key';

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
export const TENANT_INACTIVE = 'tenant-inactive';
export const OWNER_A = 'owner-a';
export const OWNER_B = 'owner-b';
export const INSTRUCTOR_A = 'instructor-a';
export const ROLE_OWNER_MEMBER = 'role-owner-member-1';
export const BILLING_ONLY = 'billing-only-instructor-1';
export const MULTI = 'multi-1';
export const STUDENT = 'student-1';
export const ADMIN = 'admin-1';
export const NO_SCOPE = 'no-scope-1';

export interface TenantRow {
  id: string;
  business_name: string;
  subject_type: string | null;
  status: string;
  legacy_compat: number;
  owner_user_id: string;
}

export interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

/** One stored academic period. The dates are DATE-ONLY strings. */
export interface PeriodRow {
  id: string;
  tenant_id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_archived: number;
  created_at: Date;
  updated_at: Date;
}

export const DRIVER_OFFSET_SECONDS = 2 * 60 * 60;
export const epochOf = (instant: Date): number => Math.floor(instant.getTime() / 1000);
export const driverDateOf = (instant: Date): Date => new Date(instant.getTime() - DRIVER_OFFSET_SECONDS * 1000);

/**
 * The instant the installed mysql2 driver would hand back for a DATE column
 * holding `dateOnly`, if the raw column were selected instead of the
 * `DATE_FORMAT` projection.
 *
 * A DATE is midnight; the pool's `timezone: '+02:00'` makes the driver
 * INTERPRET that midnight as +02:00 and hand back the equivalent UTC instant,
 * i.e. 22:00Z of the PREVIOUS calendar day. That is exactly the day-shift the
 * `DATE_FORMAT` projection avoids, and it is what a test compares against so
 * the regression is observable instead of hidden.
 */
export const shiftedDateOf = (dateOnly: string): Date => {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - DRIVER_OFFSET_SECONDS * 1000);
};
/** The calendar day a shifted driver value would be serialized as. */
export const shiftedDayOf = (dateOnly: string): string => shiftedDateOf(dateOnly).toISOString().slice(0, 10);

export type MalformedEpoch = 'none' | 'null' | 'zero' | 'nan' | 'text' | 'missing';
export type MalformedDate = 'none' | 'impossible' | 'shifted-object' | 'missing' | 'reversed';

export interface State {
  users: Record<string, IdentityRow>;
  instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
  memberships: Record<string, string[]>;
  tenantOwner: Record<string, string>;
  membershipRole: Record<string, string>;
  enrollments: Record<string, Array<{ id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }>>;
  tenants: TenantRow[];
  /** Every stored period of every tenant, in insertion order. */
  periods: PeriodRow[];
  failAcquire: boolean;
  failBegin: boolean;
  failOwnerSelect: boolean;
  failList: boolean;
  failLockSelect: boolean;
  failInsert: boolean;
  failUpdate: boolean;
  failAudit: boolean;
  failReadBack: boolean;
  failCommit: boolean;
  failRollback: boolean;
  /** Emulate a deployment where the migration FILE was never applied. */
  missingSchema: boolean;
  malformedEpoch: MalformedEpoch;
  malformedDate: MalformedDate;
  /**
   * A malformed projection applied ONLY to the post-write read-back, so the
   * "the DTO is materialized before the commit" branch can be reached without
   * breaking the locked read that precedes the write.
   */
  readBackMalformedEpoch: MalformedEpoch;
  readBackMalformedDate: MalformedDate;
}

export const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
export const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });
export const stamp = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 21, hour, minute, 0));

/** Two stored periods of TENANT_A, deliberately out of `starts_on` order. */
export const PERIOD_AUTUMN = '11111111-1111-4111-8111-111111111111';
export const PERIOD_SPRING = '22222222-2222-4222-8222-222222222222';
export const PERIOD_SUMMER = '33333333-3333-4333-8333-333333333333';
export const PERIOD_OTHER_TENANT = '44444444-4444-4444-8444-444444444444';

export const periodRow = (overrides: Partial<PeriodRow> & { id: string; tenant_id: string }): PeriodRow => ({
  name: 'فصل دراسي',
  starts_on: '2026-09-01',
  ends_on: '2027-01-15',
  is_archived: 0,
  created_at: stamp(8, 0),
  updated_at: stamp(8, 0),
  ...overrides,
});

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
      // explicitly allowed: the authentication middleware marks the principal
      // `billingOnly` instead of denying the request.
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
      { id: TENANT_INACTIVE, business_name: 'Synthetic Academy C', subject_type: 'institute', status: 'suspended', legacy_compat: 1, owner_user_id: OWNER_A },
    ],
    periods: [
      // Deliberately inserted spring-before-autumn so a fixture that returns
      // insertion order would fail the documented `starts_on,id` ordering.
      periodRow({ id: PERIOD_SPRING, tenant_id: TENANT_A, name: 'الفصل الربيعي', starts_on: '2027-02-01', ends_on: '2027-06-10', created_at: stamp(8, 5), updated_at: stamp(8, 5) }),
      periodRow({ id: PERIOD_AUTUMN, tenant_id: TENANT_A, name: 'الفصل الخريفي', starts_on: '2026-09-01', ends_on: '2027-01-15' }),
      periodRow({ id: PERIOD_SUMMER, tenant_id: TENANT_A, name: 'الفصل الصيفي', starts_on: '2027-07-01', ends_on: '2027-08-20', is_archived: 1 }),
      periodRow({ id: PERIOD_OTHER_TENANT, tenant_id: TENANT_B, name: 'فصل مساحة أخرى', starts_on: '2026-09-01', ends_on: '2027-01-15' }),
    ],
    failAcquire: false,
    failBegin: false,
    failOwnerSelect: false,
    failList: false,
    failLockSelect: false,
    failInsert: false,
    failUpdate: false,
    failAudit: false,
    failReadBack: false,
    failCommit: false,
    failRollback: false,
    missingSchema: false,
    malformedEpoch: 'none',
    malformedDate: 'none',
    readBackMalformedEpoch: 'none',
    readBackMalformedDate: 'none',
  };
}

// ---------------------------------------------------------------------------
// The exact statements the real handlers issue
// ---------------------------------------------------------------------------

export const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export const PERIOD_PROJECTION =
  'p.id,p.name,' +
  "DATE_FORMAT(p.starts_on,'%Y-%m-%d') AS starts_on," +
  "DATE_FORMAT(p.ends_on,'%Y-%m-%d') AS ends_on," +
  'p.is_archived,' +
  'UNIX_TIMESTAMP(p.created_at) AS created_at_epoch,' +
  'UNIX_TIMESTAMP(p.updated_at) AS updated_at_epoch';

export const OWNER_SELECT =
  'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';

export const LIST_SQL =
  `SELECT ${PERIOD_PROJECTION} FROM academic_periods p ` +
  'WHERE p.tenant_id=? AND p.is_archived=? ORDER BY p.starts_on ASC, p.id ASC LIMIT ? OFFSET ?';

export const PERIOD_LOCK_SELECT =
  `SELECT ${PERIOD_PROJECTION} FROM academic_periods p WHERE p.id=? AND p.tenant_id=? FOR UPDATE`;

export const PERIOD_READBACK_SELECT =
  `SELECT ${PERIOD_PROJECTION} FROM academic_periods p WHERE p.id=? AND p.tenant_id=? LIMIT 1`;

export const INSERT_SQL =
  'INSERT INTO academic_periods (id,tenant_id,name,starts_on,ends_on,is_archived) VALUES (?,?,?,?,?,?)';

export const UPDATE_SQL =
  'UPDATE academic_periods SET name=?,starts_on=?,ends_on=?,is_archived=? WHERE id=? AND tenant_id=?';

export const AUDIT_SQL =
  'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

/**
 * The provisional M2-B06 branding read, answered here ONLY so the coexistence
 * assertion can drive the real tenant-self router with BOTH mounts live.
 *
 * This suite owns no branding behaviour: the fixture answers the genuinely
 * ABSENT row, which is the truthful answer for a tenant with no branding row,
 * and the branding contract itself stays with its own batch.
 */
export const BRANDING_SELECT =
  'SELECT b.display_name_ar,b.display_name_en,b.accent_color,UNIX_TIMESTAMP(b.updated_at) AS updated_at_epoch FROM tenant_branding b WHERE b.tenant_id=? LIMIT 1';
export const BRANDING_LOCK_SELECT = BRANDING_SELECT.replace(' LIMIT 1', ' FOR UPDATE');

export const PERIOD_DTO_KEYS = ['created_at', 'ends_on', 'id', 'is_archived', 'name', 'starts_on', 'updated_at'];

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
  /** The period rows a rollback would restore, for leak assertions. */
  committedPeriods: () => PeriodRow[];
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
  let snapshot: PeriodRow[] | null = null;
  let auditSnapshot = 0;

  const clonePeriods = (source: PeriodRow[]): PeriodRow[] => source.map(row => ({ ...row }));

  /**
   * Project a stored period row the way the production projection reads it.
   *
   * `starts_on`/`ends_on` are STRINGS, because the handler selects
   * `DATE_FORMAT(...)`. The extra `*_driver` keys carry what the installed
   * driver would have decoded from the raw DATE column, so a handler that
   * accidentally read the raw column instead would answer a shifted day and the
   * regression would be observable.
   */
  const projectedRow = (row: PeriodRow, variant: 'normal' | 'readback' = 'normal'): any => {
    const epochVariant = variant === 'readback' ? state.readBackMalformedEpoch : state.malformedEpoch;
    const dateVariant = variant === 'readback' ? state.readBackMalformedDate : state.malformedDate;
    const projected: any = {
      id: row.id,
      name: row.name,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      is_archived: row.is_archived,
      created_at: driverDateOf(row.created_at),
      created_at_epoch: epochOf(row.created_at),
      updated_at: driverDateOf(row.updated_at),
      updated_at_epoch: epochOf(row.updated_at),
      starts_on_driver: shiftedDateOf(row.starts_on),
      ends_on_driver: shiftedDateOf(row.ends_on),
    };
    if (epochVariant === 'null') {
      projected.updated_at_epoch = null;
    } else if (epochVariant === 'zero') {
      projected.updated_at_epoch = 0;
    } else if (epochVariant === 'nan') {
      projected.updated_at_epoch = Number.NaN;
    } else if (epochVariant === 'text') {
      projected.updated_at_epoch = 'not-an-epoch';
    } else if (epochVariant === 'missing') {
      delete projected.updated_at_epoch;
    }
    if (dateVariant === 'impossible') {
      // A date that cannot exist. `Date` would normalize 2026-02-30 into
      // 2026-03-02, so this proves the handler validates instead of coercing.
      projected.starts_on = '2026-02-30';
    } else if (dateVariant === 'shifted-object') {
      // A driver Date where the projection promises a string.
      projected.starts_on = shiftedDateOf(row.starts_on);
    } else if (dateVariant === 'missing') {
      delete projected.starts_on;
    } else if (dateVariant === 'reversed') {
      // A stored range whose start is after its end.
      projected.starts_on = row.ends_on;
      projected.ends_on = row.starts_on;
    }
    return projected;
  };

  /** The real MySQL error a missing table produces. */
  const missingTable = (): never => {
    const error: any = new Error("Table 'tabweb.academic_periods' doesn't exist");
    error.code = 'ER_NO_SUCH_TABLE';
    error.errno = 1146;
    throw error;
  };

  const periodSql = async (sql: string, params: any[]): Promise<[any, any]> => {
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

    if (n === LIST_SQL) {
      events.push('list');
      if (state.missingSchema) missingTable();
      if (state.failList) throw new Error('period list failed: internal detail leaked');
      const tenantId = String(params[0]);
      const archived = Number(params[1]);
      const take = Number(params[2]);
      const skip = Number(params[3]);
      const matching = state.periods
        .filter(row => row.tenant_id === tenantId && Number(row.is_archived) === archived)
        // The documented total order: starts_on, then id.
        .sort((a, b) => (a.starts_on === b.starts_on ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.starts_on < b.starts_on ? -1 : 1))
        .slice(skip, skip + take);
      return [matching.map(projectedRow), []];
    }

    if (n === PERIOD_LOCK_SELECT || n === PERIOD_READBACK_SELECT) {
      const isReadBack = n === PERIOD_READBACK_SELECT;
      events.push(isReadBack ? 'period_readback' : 'period_lock');
      if (state.missingSchema) missingTable();
      if (state.failLockSelect) throw new Error('period read failed: internal detail leaked');
      // `failReadBack` makes the READ-BACK answer NO row, which is what a
      // broken read-back looks like to the handler after it has already
      // written. The locked read that precedes the write is unaffected, so the
      // "missing row after write" branch is reachable on its own.
      if (isReadBack && state.failReadBack) return [[], []];
      const row = state.periods.find(r => r.id === String(params[0]) && r.tenant_id === String(params[1])) ?? null;
      return [row ? [projectedRow(row, isReadBack ? 'readback' : 'normal')] : [], []];
    }

    if (n === INSERT_SQL) {
      events.push('insert');
      if (state.missingSchema) missingTable();
      if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert on internal table academic_periods failed');
      const [id, tenantId, name, startsOn, endsOn, archived] = params;
      const created = stamp(9, 0);
      state.periods.push({
        id: String(id),
        tenant_id: String(tenantId),
        name: String(name),
        starts_on: String(startsOn),
        ends_on: String(endsOn),
        is_archived: Number(archived),
        created_at: created,
        updated_at: created,
      });
      return [{ affectedRows: 1 }, []];
    }

    if (n === UPDATE_SQL) {
      events.push('update');
      if (state.missingSchema) missingTable();
      if (state.failUpdate) throw new Error('ER_LOCK_WAIT_TIMEOUT: update on internal table academic_periods failed');
      const [name, startsOn, endsOn, archived, id, tenantId] = params;
      const row = state.periods.find(r => r.id === String(id) && r.tenant_id === String(tenantId));
      if (!row) return [{ affectedRows: 0 }, []];
      row.name = String(name);
      row.starts_on = String(startsOn);
      row.ends_on = String(endsOn);
      row.is_archived = Number(archived);
      row.updated_at = stamp(10, 0);
      return [{ affectedRows: 1 }, []];
    }

    if (n === AUDIT_SQL) {
      events.push('audit');
      if (state.missingSchema) missingTable();
      if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
      auditRows.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    }

    if (n === BRANDING_SELECT || n === BRANDING_LOCK_SELECT) {
      events.push('branding_select');
      // The provisional branding mount is answered with the genuinely ABSENT
      // row: this suite proves the mount still routes and answers, and makes no
      // branding claim of its own.
      return [[], []];
    }

    throw new Error(`Unhandled academic period SQL in hermetic fixture: ${n}`);
  };

  const makeConnection = () => {
    connectionCount += 1;
    return {
      beginTransaction: async () => {
        events.push('begin');
        if (state.failBegin) throw new Error('begin failed: internal detail leaked');
        // The fixture replays the transaction: the period rows are snapshotted
        // on begin and restored on rollback, so a leaked partial write is
        // observable instead of hidden.
        snapshot = clonePeriods(state.periods);
        auditSnapshot = auditRows.length;
      },
      execute: periodSql,
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
          state.periods = clonePeriods(snapshot);
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
    committedPeriods: () => clonePeriods(state.periods),
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
  const pathName = opts.pathName ?? '/academic-periods';
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

export const ownerToken = () => sign(OWNER_A, 'instructor');
export const ownerBToken = () => sign(OWNER_B, 'instructor');
export const periodsPath = (suffix = '') => `/academic-periods${suffix}`;

export const getReq = (token: string | null = ownerToken(), query: any = {}) =>
  makeReq({ token, method: 'GET', pathName: periodsPath(), query });
export const postReq = (body: any, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'POST', pathName: periodsPath(), body });
export const patchReq = (id: string, body: any, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'PATCH', pathName: periodsPath(`/${id}`), body });

/** Assert a period DTO is exactly the seven documented fields and nothing else. */
export const assertPeriodDto = (dto: any) => {
  assert.deepEqual(Object.keys(dto).sort(), PERIOD_DTO_KEYS);
  assert.equal(typeof dto.id, 'string');
  assert.match(dto.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof dto.name, 'string');
  assert.match(dto.starts_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(dto.ends_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(dto.starts_on <= dto.ends_on, 'the stored range is never reversed');
  assert.equal(typeof dto.is_archived, 'boolean');
  assert.match(dto.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(dto.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
};

/** The statements a request issued, squashed, for call-order assertions. */
export const squashedCalls = (harness: Harness) => harness.calls.map(call => squash(call.sql));

/** The period names the server returned, in order. */
export const namesOf = (result: Result) => (result.body?.periods ?? []).map((period: any) => period.name);
