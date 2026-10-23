/**
 * M2-B06 — shared hermetic harness for the private tenant-branding suites.
 *
 * This module is TEST-ONLY support. It provides:
 *   * positive import interception of the forbidden default modules
 *     (`src/db`, `src/services/minio`, `src/services/subscription-renewal`,
 *     `dotenv`) so the real production modules can be composed without a
 *     database, a provider, an environment file or a listener;
 *   * a synthetic, transaction-aware fixture connection that replays the exact
 *     statements the real branding handlers issue, snapshotting the branding
 *     rows on `beginTransaction` and restoring them on `rollback`, so a leaked
 *     partial state is observable instead of hidden;
 *   * the real production composition (optional auth -> tenant-authority
 *     boundary -> student-workspace boundary -> real tenant-self router with
 *     the real branding router mounted under `/branding`) with only leaf data
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

export const TEST_SECRET = 'm2-b06-hermetic-jwt-secret-not-a-real-key';

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

/** One stored branding row. `updated_at` is the exact stored instant. */
export interface BrandingRow {
  tenant_id: string;
  display_name_ar: string | null;
  display_name_en: string | null;
  accent_color: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The stored instant of a branding row.
 *
 * `epochSeconds` is the exact stored instant — what `UNIX_TIMESTAMP(col)`
 * returns for a TIMESTAMP column, independently of the session time zone.
 *
 * `driverDate` emulates the INSTALLED mysql2 decoder with the pool's
 * `timezone: '+02:00'`: that option makes the driver INTERPRET the wall time it
 * receives, so the Date it hands back is shifted by -2h from the stored
 * instant. The projection below returns BOTH, so a handler that serialized the
 * raw datetime column would answer a shifted instant and the regression is
 * observable instead of hidden.
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
  /** The stored branding rows, keyed by tenant id. Absent key = no row. */
  branding: Record<string, BrandingRow>;
  failAcquire: boolean;
  failBegin: boolean;
  failOwnerSelect: boolean;
  failBrandingSelect: boolean;
  failInsert: boolean;
  failUpdate: boolean;
  failAudit: boolean;
  failReadBack: boolean;
  failCommit: boolean;
  failRollback: boolean;
  /**
   * Emulate a deployment where the migration FILE was never applied: every
   * `tenant_branding` statement throws the real MySQL missing-table error.
   */
  missingSchema: boolean;
  malformedEpoch: MalformedEpoch;
}

export const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
export const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });
/** A synthetic stored instant: 2026-10-21 at HH:MM UTC. */
export const stamp = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 21, hour, minute, 0));

/** The stored branding row of TENANT_A, used by most tests. */
export const BRANDING_A = (): BrandingRow => ({
  tenant_id: TENANT_A,
  display_name_ar: 'أكاديمية أ',
  display_name_en: 'Academy A',
  accent_color: '#1D4ED8',
  created_at: stamp(8, 0),
  updated_at: stamp(8, 0),
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
    // TENANT_B has NO branding row: it is the genuinely-absent case.
    branding: { [TENANT_A]: BRANDING_A() },
    failAcquire: false,
    failBegin: false,
    failOwnerSelect: false,
    failBrandingSelect: false,
    failInsert: false,
    failUpdate: false,
    failAudit: false,
    failReadBack: false,
    failCommit: false,
    failRollback: false,
    missingSchema: false,
    malformedEpoch: 'none',
  };
}

// ---------------------------------------------------------------------------
// The exact statements the real handlers issue
// ---------------------------------------------------------------------------

export const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export const BRANDING_PROJECTION =
  'b.display_name_ar,b.display_name_en,b.accent_color,' +
  'UNIX_TIMESTAMP(b.updated_at) AS updated_at_epoch';

export const OWNER_SELECT =
  'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';
export const BRANDING_SELECT =
  `SELECT ${BRANDING_PROJECTION} FROM tenant_branding b WHERE b.tenant_id=? LIMIT 1`;
export const BRANDING_LOCK_SELECT =
  `SELECT ${BRANDING_PROJECTION} FROM tenant_branding b WHERE b.tenant_id=? FOR UPDATE`;
export const INSERT_SQL =
  'INSERT INTO tenant_branding (tenant_id,display_name_ar,display_name_en,accent_color) VALUES (?,?,?,?)';
export const UPDATE_SQL =
  'UPDATE tenant_branding SET display_name_ar=?,display_name_en=?,accent_color=? WHERE tenant_id=?';
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
  /** The branding rows a rollback would restore, for leak assertions. */
  committedBranding: () => Record<string, BrandingRow>;
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
  let snapshot: Record<string, BrandingRow> | null = null;
  let auditSnapshot = 0;

  const cloneBranding = (source: Record<string, BrandingRow>): Record<string, BrandingRow> => {
    const copy: Record<string, BrandingRow> = {};
    for (const [key, row] of Object.entries(source)) copy[key] = { ...row };
    return copy;
  };

  /**
   * Project a stored branding row the way the production projection reads it:
   * the instant as epoch seconds, next to the raw datetime column the installed
   * driver would have decoded with its `timezone: '+02:00'` interpretation. The
   * malformed-epoch variants emulate a broken projection so the refusal of an
   * unreadable instant is observable.
   */
  const projectedRow = (row: BrandingRow): any => {
    const projected: any = {
      display_name_ar: row.display_name_ar,
      display_name_en: row.display_name_en,
      accent_color: row.accent_color,
      updated_at: driverDateOf(row.updated_at),
      updated_at_epoch: epochOf(row.updated_at),
    };
    if (state.malformedEpoch === 'null') {
      projected.updated_at_epoch = null;
    } else if (state.malformedEpoch === 'zero') {
      projected.updated_at_epoch = 0;
    } else if (state.malformedEpoch === 'nan') {
      projected.updated_at_epoch = Number.NaN;
    } else if (state.malformedEpoch === 'text') {
      projected.updated_at_epoch = 'not-an-epoch';
    } else if (state.malformedEpoch === 'missing') {
      delete projected.updated_at_epoch;
    }
    return projected;
  };

  /** The real MySQL error a missing table produces. */
  const missingTable = (): never => {
    const error: any = new Error("Table 'tabweb.tenant_branding' doesn't exist");
    error.code = 'ER_NO_SUCH_TABLE';
    error.errno = 1146;
    throw error;
  };

  const brandingSql = async (sql: string, params: any[]): Promise<[any, any]> => {
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

    if (n === BRANDING_SELECT || n === BRANDING_LOCK_SELECT) {
      events.push(n === BRANDING_LOCK_SELECT ? 'branding_lock' : 'branding_select');
      if (state.missingSchema) missingTable();
      if (state.failBrandingSelect) throw new Error('branding read failed: internal detail leaked');
      // `failReadBack` makes the select answer NO row, which is what a broken
      // read-back looks like to the handler after it has already written.
      if (state.failReadBack) return [[], []];
      const row = state.branding[String(params[0])] ?? null;
      return [row ? [projectedRow(row)] : [], []];
    }

    if (n === INSERT_SQL) {
      events.push('insert');
      if (state.missingSchema) missingTable();
      if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert on internal table tenant_branding failed');
      const [tenantId, ar, en, accent] = params;
      const created = stamp(9, 0);
      state.branding[String(tenantId)] = {
        tenant_id: String(tenantId),
        display_name_ar: ar === null || ar === undefined ? null : String(ar),
        display_name_en: en === null || en === undefined ? null : String(en),
        accent_color: accent === null || accent === undefined ? null : String(accent),
        created_at: created,
        updated_at: created,
      };
      return [{ affectedRows: 1 }, []];
    }

    if (n === UPDATE_SQL) {
      events.push('update');
      if (state.missingSchema) missingTable();
      if (state.failUpdate) throw new Error('ER_LOCK_WAIT_TIMEOUT: update on internal table tenant_branding failed');
      const [ar, en, accent, tenantId] = params;
      const row = state.branding[String(tenantId)];
      if (!row) return [{ affectedRows: 0 }, []];
      row.display_name_ar = ar === null || ar === undefined ? null : String(ar);
      row.display_name_en = en === null || en === undefined ? null : String(en);
      row.accent_color = accent === null || accent === undefined ? null : String(accent);
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

    throw new Error(`Unhandled tenant branding SQL in hermetic fixture: ${n}`);
  };

  const makeConnection = () => {
    connectionCount += 1;
    return {
      beginTransaction: async () => {
        events.push('begin');
        if (state.failBegin) throw new Error('begin failed: internal detail leaked');
        // The fixture replays the transaction: the branding rows are
        // snapshotted on begin and restored on rollback, so a leaked partial
        // write is observable instead of hidden.
        snapshot = cloneBranding(state.branding);
        auditSnapshot = auditRows.length;
      },
      execute: brandingSql,
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
          state.branding = cloneBranding(snapshot);
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
    committedBranding: () => cloneBranding(state.branding),
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
  const pathName = opts.pathName ?? '/branding';
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

export const BRANDING_DTO_KEYS = ['accent_color', 'display_name_ar', 'display_name_en', 'updated_at'];
export const BRANDING_FIELDS = ['display_name_ar', 'display_name_en', 'accent_color'];

export const ownerToken = () => sign(OWNER_A, 'instructor');
export const ownerBToken = () => sign(OWNER_B, 'instructor');
export const brandingPath = () => '/branding';

export const getReq = (token: string | null = ownerToken(), query: any = {}) =>
  makeReq({ token, method: 'GET', pathName: brandingPath(), query });
export const patchReq = (body: any, token: string | null = ownerToken()) =>
  makeReq({ token, method: 'PATCH', pathName: brandingPath(), body });

/** Assert a branding DTO is exactly the four documented fields and nothing else. */
export const assertBrandingDto = (dto: any) => {
  assert.deepEqual(Object.keys(dto).sort(), BRANDING_DTO_KEYS);
  assert.ok(dto.display_name_ar === null || typeof dto.display_name_ar === 'string');
  assert.ok(dto.display_name_en === null || typeof dto.display_name_en === 'string');
  assert.ok(dto.accent_color === null || typeof dto.accent_color === 'string');
  if (dto.accent_color !== null) assert.match(dto.accent_color, /^#[0-9A-F]{6}$/);
  if (dto.updated_at !== null) {
    assert.match(dto.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
};

/** The statements a request issued, squashed, for call-order assertions. */
export const squashedCalls = (harness: Harness) => harness.calls.map(call => squash(call.sql));
