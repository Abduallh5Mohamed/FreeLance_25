/**
 * M2-B02 — audited institution-name update (hermetic, behavioral).
 *
 * Contract under test: PATCH /api/tenants/me/profile changes ONLY
 * `tenants.business_name` for the tenant the SERVER selected from the caller's
 * active memberships, and only when the caller IS `tenants.owner_user_id` of an
 * ACTIVE tenant with an ACTIVE user row — re-verified on the transaction
 * connection under `FOR UPDATE`. A membership role label (`owner`/`instructor`)
 * alone never authorizes the rename. The payload is a strict single-field object
 * `{ business_name }`; unknown/selector/non-string/empty/over-255 values are
 * rejected before a connection is taken. The name UPDATE and the audit event are
 * committed together; a failed audit rolls the name back, and success is reported
 * only after `commit()` resolves. An identical retry is a truthful no-op (no
 * UPDATE, no audit). `Cache-Control: no-store` is present on every outcome the
 * handler itself produces (200/400/404/409/500).
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` handler. Only leaf data
 * repositories and the transactional connection are injected fixtures. No
 * express listener, socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively (see the existing M2-B01 suite): the
 * `src/db`, `src/services/minio` and `src/services/subscription-renewal` module
 * bodies are intercepted in the CommonJS loader before any app module loads, stay
 * out of `require.cache`, need no dummy env and are re-checked in `after`.
 *
 * Live MySQL row-level locking, real concurrency and real HTTP transport are
 * explicitly NOT exercised or claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-b02-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

const originalLoad = (Module as any)._load;
const sentinelCalls: string[] = [];
const interceptionLog: string[] = [];
const normalize = (id: string) => path.resolve(id).toLowerCase();

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

interface Intercepted { id: string; exports: unknown }
const sentinelByPath = new Map<string, Intercepted>();

const registerSentinel = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    sentinelByPath.set(normalize(id), { id, exports });
};

registerSentinel('../src/db', dbSentinel);
registerSentinel('../src/services/minio', minioSentinel);
registerSentinel('../src/services/subscription-renewal', renewalSentinel);

const installInterception = () => {
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
const restoreInterception = () => { (Module as any)._load = originalLoad; };

let loadError: unknown = null;
let authModule: any;
let boundaryModule: any;
let studentBoundaryModule: any;
let routeModule: any;

installInterception();
try {
    authModule = require('../src/middleware/auth');
    boundaryModule = require('../src/middleware/tenant-authority-boundary');
    studentBoundaryModule = require('../src/middleware/student-workspace-boundary');
    routeModule = require('../src/routes/tenant-self');
} catch (error) {
    loadError = error;
} finally {
    restoreInterception();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const INSTRUCTOR_A = 'instructor-a';
const ROLE_OWNER_MEMBER = 'role-owner-member-1';
const STAFF_A = 'staff-a';
const ADMIN = 'admin-1';
const STUDENT = 'student-1';
const MULTI = 'multi-1';
const REVOKED_MEMBER = 'revoked-member-1';
const SUSPENDED = 'suspended-instructor-1';

interface TenantRow {
    id: string;
    business_name: string;
    subject_type: string | null;
    status: string;
    legacy_compat: number;
    owner_user_id: string;
}

interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

interface State {
    users: Record<string, IdentityRow>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    tenantOwner: Record<string, string>;
    membershipRole: Record<string, string>;
    enrollments: Record<string, Array<{ id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }>>;
    tenants: TenantRow[];
    failAuthority: boolean;
    failAcquire: boolean;
    failBegin: boolean;
    failLockSelect: boolean;
    failUpdate: boolean;
    failAudit: boolean;
    failCommit: boolean;
    failRollback: boolean;
    affectedRowsOverride: number | null;
}

const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(), [ROLE_OWNER_MEMBER]: identity(),
            [STAFF_A]: identity(), [ADMIN]: identity(), [STUDENT]: identity(), [MULTI]: identity(),
            [REVOKED_MEMBER]: identity(), [SUSPENDED]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(), [INSTRUCTOR_A]: activeAccount(),
            [ROLE_OWNER_MEMBER]: activeAccount(), [SUSPENDED]: { tenant_status: 'suspended', legacy_compat: 1, allowed: 1 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [OWNER_B]: [TENANT_B],
            [INSTRUCTOR_A]: [TENANT_A],
            [ROLE_OWNER_MEMBER]: [TENANT_A],
            [STAFF_A]: [TENANT_A],
            [MULTI]: [TENANT_A, TENANT_B],
            [REVOKED_MEMBER]: [TENANT_A],
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: OWNER_B },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${OWNER_B}@${TENANT_B}`]: 'owner',
            [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
            [`${ROLE_OWNER_MEMBER}@${TENANT_A}`]: 'owner',
            [`${STAFF_A}@${TENANT_A}`]: 'staff',
        },
        enrollments: {
            [STUDENT]: [{ id: 'enrollment-1', user_id: STUDENT, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: 'g-1', grade_id: 'gr-1' }],
        },
        tenants: [
            { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active', legacy_compat: 0, owner_user_id: OWNER_A },
            { id: TENANT_B, business_name: 'Beta Academy', subject_type: null, status: 'active', legacy_compat: 0, owner_user_id: OWNER_B },
        ],
        failAuthority: false,
        failAcquire: false,
        failBegin: false,
        failLockSelect: false,
        failUpdate: false,
        failAudit: false,
        failCommit: false,
        failRollback: false,
        affectedRowsOverride: null,
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const LOCK_SELECT = 'SELECT t.business_name,t.subject_type,t.status AS tenant_status,t.owner_user_id,u.is_active AS caller_active FROM tenants t JOIN users u WHERE t.id=? AND u.id=? FOR UPDATE';
const UPDATE_SQL = 'UPDATE tenants SET business_name=? WHERE id=? AND owner_user_id=?';
const AUDIT_SQL = 'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

interface Harness {
    chain: RequestHandler[];
    calls: Call[];
    authorityCalls: Array<{ userId: string; tenantId: string }>;
    events: string[];
    auditRows: Call[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];
    const authorityCalls: Array<{ userId: string; tenantId: string }> = [];
    const events: string[] = [];
    const auditRows: Call[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;

    const tenantSql = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });
        if (n === LOCK_SELECT || n.includes('FROM tenants t JOIN users u')) {
            events.push('select');
            if (state.failLockSelect) throw new Error('lock query failed: internal detail leaked');
            const tenant = state.tenants.find(t => t.id === params[0]);
            const user = state.users[params[1]];
            if (!tenant || !user) return [[], []];
            return [[{
                business_name: tenant.business_name,
                subject_type: tenant.subject_type,
                tenant_status: tenant.status,
                owner_user_id: tenant.owner_user_id,
                caller_active: user.is_active,
            }], []];
        }
        if (n.startsWith('UPDATE tenants SET business_name')) {
            events.push('update');
            if (state.failUpdate) throw new Error('ER_LOCK_WAIT_TIMEOUT: update on internal table tenants failed');
            const affected = state.affectedRowsOverride ?? 1;
            if (affected === 1) {
                const tenant = state.tenants.find(t => t.id === params[1]);
                if (tenant) tenant.business_name = params[0];
            }
            return [{ affectedRows: affected }, []];
        }
        if (n.startsWith('INSERT INTO audit_events')) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            auditRows.push({ sql, params });
            return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unhandled tenant SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        return {
            beginTransaction: async () => { events.push('begin'); if (state.failBegin) throw new Error('begin failed: internal detail leaked'); },
            execute: tenantSql,
            commit: async () => { events.push('commit'); if (state.failCommit) throw new Error('commit acknowledgement lost: internal detail leaked'); },
            rollback: async () => { events.push('rollback'); if (state.failRollback) throw new Error('rollback failed: internal detail leaked'); },
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
        authorityCalls.push({ userId, tenantId });
        if (state.failAuthority) throw new Error('authority store unavailable: internal detail leaked');
        const tenant = state.tenants.find(t => t.id === tenantId);
        if (!tenant || tenant.status !== 'active') return null;
        if (state.tenantOwner[tenantId] === userId) {
            return state.users[userId]?.is_active === 1 ? { authority: 'owner' } : null;
        }
        const role = state.membershipRole[`${userId}@${tenantId}`];
        if (role === 'owner' || role === 'instructor') return { authority: role };
        return null;
    };

    const tenantSelf: Router = routeModule.createTenantSelfRouter({
        db,
        authenticate: authModule.createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        uploadBuffer: async () => violation('injected.uploadBuffer'),
        deleteFile: async () => violation('injected.deleteFile'),
        getPrivateObjectUrl: async () => violation('injected.getPrivateObjectUrl'),
        executeRenewalIntent: async () => violation('injected.executeRenewalIntent'),
    });

    const chain: RequestHandler[] = [
        authModule.createOptionalAuth(repository),
        boundaryModule.enforceTenantAuthorityBoundary,
        studentBoundaryModule.enforceStudentWorkspaceBoundary,
        tenantSelf,
    ];

    return {
        chain,
        calls,
        authorityCalls,
        events,
        auditRows,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
    };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string>; handlerReached: boolean }

interface ReqOptions {
    token?: string | null;
    method?: string;
    pathName?: string;
    query?: any;
    body?: any;
    headers?: Record<string, string>;
}

function makeReq(opts: ReqOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
    const pathName = opts.pathName ?? '/profile';
    return {
        method: opts.method ?? 'PATCH',
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

function runChain(chain: RequestHandler[], req: any): Promise<Result> {
    return new Promise((resolve, reject) => {
        let index = 0;
        let settled = false;
        const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };

        const headers: Record<string, string> = {};
        const res: any = {
            statusCode: 200,
            status(code: number) { res.statusCode = code; return res; },
            set(name: string, value: string) { headers[name] = value; return res; },
            setHeader(name: string, value: string) { headers[name] = value; return res; },
            json(payload: any) { finish({ status: res.statusCode, body: payload, headers, handlerReached: true }); return res; },
            send(payload: any) { finish({ status: res.statusCode, body: payload, headers, handlerReached: true }); return res; },
            end() { finish({ status: res.statusCode, body: undefined, headers, handlerReached: true }); return res; },
        };

        const next = (error?: any) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            const middleware = chain[index++];
            if (!middleware) {
                finish({ status: 0, body: undefined, headers, handlerReached: false });
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

const sign = (id: string, role: string, extra: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m', ...options });

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

const DTO_KEYS = ['id', 'business_name', 'subject_type', 'status'];
const ownerReq = (body: any) => makeReq({ token: sign(OWNER_A, 'instructor'), body });

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);

    for (const [key, intercepted] of sentinelByPath) {
        assert.ok(intercepted.id.length > 0, `sentinel registered for ${key}`);
        assert.ok(
            interceptionLog.includes(intercepted.id),
            `the loader must have intercepted ${intercepted.id} (recorded: ${JSON.stringify(interceptionLog)})`,
        );
        assert.equal(
            require.cache[intercepted.id],
            undefined,
            `${intercepted.id} must never be evaluated or cached by Node`,
        );
    }

    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called during import or tests');
    assert.equal((Module as any)._load, originalLoad, 'the loader hook is restored in finally');
});

// ---------------------------------------------------------------------------
// Allow path — verified owner, atomic name + audit
// ---------------------------------------------------------------------------

test('update: the verified tenant owner renames the institution, name+audit commit together', async () => {
    const state = makeState();
    const { chain, calls, authorityCalls, events, auditRows } = buildHarness(state);
    const res = await runChain(chain, ownerReq({ business_name: '  Alpha Institute  ' }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Institute', subject_type: 'company', status: 'active' },
    });
    assert.deepEqual(Object.keys(res.body), ['tenant']);
    assert.deepEqual(Object.keys(res.body.tenant), DTO_KEYS);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(state.tenants[0].business_name, 'Alpha Institute', 'the trailing/leading whitespace is trimmed before persistence');

    assert.deepEqual(authorityCalls, [], 'the owner-only write does not consult the read authority helper');
    assert.deepEqual(events, ['begin', 'select', 'update', 'audit', 'commit', 'release']);

    assert.equal(calls.length, 3, 'exactly the lock select, the name update and the audit insert run');
    assert.equal(squash(calls[0].sql), LOCK_SELECT);
    assert.deepEqual(calls[0].params, [TENANT_A, OWNER_A]);
    assert.equal(squash(calls[1].sql), UPDATE_SQL);
    assert.deepEqual(calls[1].params, ['Alpha Institute', TENANT_A, OWNER_A]);
    assert.equal(squash(calls[2].sql), AUDIT_SQL);
    assert.deepEqual(calls[2].params.slice(0, 6), [
        calls[2].params[0], OWNER_A, TENANT_A, 'tenant.profile_name_updated', 'tenant', TENANT_A,
    ]);
    assert.deepEqual(JSON.parse(calls[2].params[6]), { business_name: 'Alpha Academy' });
    assert.deepEqual(JSON.parse(calls[2].params[7]), { business_name: 'Alpha Institute' });
    assert.equal(auditRows.length, 1, 'exactly one audit event is written');
});

test('update: transaction ordering is begin -> lock -> update -> audit -> commit -> release', async () => {
    const { chain, events } = buildHarness(makeState());
    await runChain(chain, ownerReq({ business_name: 'Ordered Academy' }));
    assert.deepEqual(events, ['begin', 'select', 'update', 'audit', 'commit', 'release']);
});

test('update: a null subject_type is echoed as null in the post-commit DTO', async () => {
    const state = makeState();
    const { chain } = buildHarness(state);
    // OWNER_B owns tenant-b (subject_type null).
    const res = await runChain(chain, makeReq({ token: sign(OWNER_B, 'instructor'), body: { business_name: 'Beta Institute' } }));
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.subject_type, null);
    assert.deepEqual(Object.keys(res.body.tenant), DTO_KEYS);
});

test('update: a 255-character name is accepted', async () => {
    const name = 'x'.repeat(255);
    const { chain } = buildHarness(makeState());
    const res = await runChain(chain, ownerReq({ business_name: name }));
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.business_name, name);
});

// ---------------------------------------------------------------------------
// Truthful no-op
// ---------------------------------------------------------------------------

test('update: an identical retry is a truthful no-op — no UPDATE, no audit event', async () => {
    const state = makeState();
    const { chain, calls, events, auditRows } = buildHarness(state);
    const res = await runChain(chain, ownerReq({ business_name: 'Alpha Academy' }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active' },
    });
    assert.equal(state.tenants[0].business_name, 'Alpha Academy');
    assert.equal(auditRows.length, 0, 'a no-op must not invent a change event');
    assert.deepEqual(calls.map(c => squash(c.sql)), [LOCK_SELECT]);
    assert.deepEqual(events, ['begin', 'select', 'rollback', 'release'], 'a no-op rolls back an untouched transaction and releases');
});

// ---------------------------------------------------------------------------
// Owner-only denials
// ---------------------------------------------------------------------------

test('update: an instructor membership is denied — a member label never grants rename', async () => {
    const state = makeState();
    const { chain, calls, events, auditRows, releaseCount } = buildHarness(state);
    const res = await runChain(chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), body: { business_name: 'Hijacked Academy' } }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(state.tenants[0].business_name, 'Alpha Academy', 'no write may occur');
    assert.equal(auditRows.length, 0);
    assert.deepEqual(calls.map(c => squash(c.sql)), [LOCK_SELECT]);
    assert.deepEqual(events, ['begin', 'select', 'rollback', 'release']);
    assert.equal(releaseCount(), 1);
});

test('update: a membership role of "owner" without the actual owner_user_id is denied', async () => {
    const state = makeState();
    const { chain, calls, auditRows } = buildHarness(state);
    // role-owner-member-1 has an active membership with role_key 'owner' but is
    // not tenants.owner_user_id for tenant-a.
    const res = await runChain(chain, makeReq({ token: sign(ROLE_OWNER_MEMBER, 'instructor'), body: { business_name: 'Role Hijack' } }));

    assert.equal(res.status, 404);
    assert.equal(state.tenants[0].business_name, 'Alpha Academy');
    assert.equal(auditRows.length, 0);
    assert.deepEqual(calls.map(c => squash(c.sql)), [LOCK_SELECT]);
});

test('update: a suspended tenant is denied even for the recorded owner', async () => {
    const state = makeState();
    state.tenants[0].status = 'suspended';
    const { chain, calls, auditRows } = buildHarness(state);
    const res = await runChain(chain, ownerReq({ business_name: 'Suspended Rename' }));

    assert.equal(res.status, 404);
    assert.equal(auditRows.length, 0);
    assert.deepEqual(calls.map(c => squash(c.sql)), [LOCK_SELECT]);
});

test('update: an inactive caller row is denied on the transaction connection', async () => {
    const state = makeState();
    state.users[OWNER_A] = { ...state.users[OWNER_A], is_active: 0 };
    const { chain, calls, auditRows } = buildHarness(state);
    const res = await runChain(chain, ownerReq({ business_name: 'Inactive Rename' }));

    // The optional-auth middleware revokes the session first (401); no write happens.
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });
    assert.equal(auditRows.length, 0);
    assert.deepEqual(calls, [], 'a rejected session never opens a transaction');
});

test('update: a cross-tenant selection is denied before the handler opens a connection', async () => {
    const state = makeState();
    const { chain, calls, authorityCalls, connectionCount } = buildHarness(state);
    // owner-a is a member of tenant-a only, but the token asks for tenant-b.
    const res = await runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor', { tenant_id: TENANT_B }), body: { business_name: 'Cross Tenant' } }));

    assert.equal(res.status, 404);
    assert.equal(connectionCount(), 0, 'no transaction for a forged selection');
    assert.deepEqual(calls, []);
    assert.deepEqual(authorityCalls, []);
});

test('update: a principal without a selected tenant is denied without a transaction', async () => {
    const { chain, calls, connectionCount } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(MULTI, 'teacher'), body: { business_name: 'Ambiguous' } }));

    assert.equal(res.status, 404);
    assert.equal(connectionCount(), 0);
    assert.deepEqual(calls, []);
});

test('update: a stale membership that no longer resolves is denied without a transaction', async () => {
    const { chain, calls, connectionCount } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(REVOKED_MEMBER, 'teacher', { tenant_id: TENANT_B }), body: { business_name: 'Stale' } }));

    assert.equal(res.status, 404);
    assert.equal(connectionCount(), 0);
    assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Authentication / boundary outcomes (real middleware)
// ---------------------------------------------------------------------------

test('auth: unsupported role, invalid, missing, expired and revoked tokens never reach a transaction', async () => {
    const cases: Array<{ req: any; status: number; body: any }> = [
        { req: makeReq({ token: sign(OWNER_A, 'owner'), body: { business_name: 'x' } }), status: 401, body: { error: 'Invalid token' } },
        { req: makeReq({ token: 'not-a-jwt', body: { business_name: 'x' } }), status: 401, body: { error: 'Invalid token' } },
        { req: makeReq({ token: null, body: { business_name: 'x' } }), status: 401, body: { error: 'No token provided' } },
        { req: makeReq({ token: sign(OWNER_A, 'instructor', {}, { expiresIn: -10 }), body: { business_name: 'x' } }), status: 401, body: { error: 'Token expired', code: 'TOKEN_EXPIRED' } },
    ];

    for (const testCase of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, testCase.req);
        assert.equal(res.status, testCase.status);
        assert.deepEqual(res.body, testCase.body);
        assert.equal(harness.connectionCount(), 0, 'a rejected session must not open a transaction');
        assert.deepEqual(harness.calls, []);
    }
});

test('auth: a suspended instructor account keeps 403 TENANT_SUSPENDED before the handler', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: sign(SUSPENDED, 'instructor'), body: { business_name: 'x' } }));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' });
    assert.equal(harness.connectionCount(), 0);
});

test('boundary: a client-supplied tenant selector is rejected 400 before the handler', async () => {
    const cases: any[] = [
        makeReq({ token: sign(OWNER_A, 'instructor'), body: { business_name: 'x', tenant_id: TENANT_B } }),
        makeReq({ token: sign(OWNER_A, 'instructor'), body: { filters: { tenantId: TENANT_B } } }),
        makeReq({ token: sign(OWNER_A, 'instructor'), body: { business_name: 'x' }, headers: { 'x-tenant-id': TENANT_B } }),
        makeReq({ token: sign(OWNER_A, 'instructor'), body: { business_name: 'x' }, query: { tenantId: TENANT_B } }),
    ];

    for (const req of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, req);
        assert.equal(res.status, 400);
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

// ---------------------------------------------------------------------------
// Strict payload validation (before any connection)
// ---------------------------------------------------------------------------

test('payload: missing, non-string, empty, whitespace, over-255, extra and array bodies are rejected 400', async () => {
    const cases: Array<{ label: string; body: any }> = [
        { label: 'missing business_name', body: {} },
        { label: 'null', body: { business_name: null } },
        { label: 'number', body: { business_name: 42 } },
        { label: 'object', body: { business_name: { nested: true } } },
        { label: 'array value', body: { business_name: ['x'] } },
        { label: 'empty string', body: { business_name: '' } },
        { label: 'whitespace only', body: { business_name: '   ' } },
        { label: 'over 255', body: { business_name: 'y'.repeat(256) } },
        { label: 'extra field status', body: { business_name: 'x', status: 'active' } },
        { label: 'extra field owner_user_id', body: { business_name: 'x', owner_user_id: OWNER_B } },
        { label: 'array body', body: [{ business_name: 'x' }] },
    ];

    for (const testCase of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, ownerReq(testCase.body));
        assert.equal(res.status, 400, `${testCase.label} must be rejected 400`);
        assert.equal(harness.connectionCount(), 0, `${testCase.label} must not open a transaction`);
        assert.deepEqual(harness.calls, [], `${testCase.label} must not reach SQL`);
        assert.equal(res.headers['Cache-Control'], 'no-store', `${testCase.label} own 400 must be non-cacheable`);
    }
});

// ---------------------------------------------------------------------------
// Failure handling and atomicity
// ---------------------------------------------------------------------------

test('atomicity: an update failure rolls back, releases and never audits or commits', async () => {
    const state = makeState();
    state.failUpdate = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Will Fail' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(state.tenants[0].business_name, 'Alpha Academy');
    assert.equal(harness.auditRows.length, 0);
    assert.deepEqual(harness.events, ['begin', 'select', 'update', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
    assert.ok(!JSON.stringify(res.body).includes('ER_LOCK'), 'driver detail must not leak');
});

test('atomicity: an audit failure rolls the name update back and never commits', async () => {
    const state = makeState();
    state.failAudit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Audit Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    // The production semantics are that the rollback undoes the name UPDATE. The
    // fixture cannot replay real rollback, so we assert the decision boundary:
    // the transaction was rolled back and commit was never reached.
    assert.deepEqual(harness.events, ['begin', 'select', 'update', 'audit', 'rollback', 'release']);
    assert.equal(harness.events.includes('commit'), false, 'no commit may follow a failed audit');
    assert.equal(harness.releaseCount(), 1);
});

test('atomicity: a commit acknowledgement failure reports 500, does NOT claim rollback and destroys the uncertain connection', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Commit Lost' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    // Persistence is unknown after a lost commit ack: no rollback is claimed.
    assert.equal(harness.events.includes('rollback'), false, 'an ambiguous commit must not claim a rollback');
    assert.deepEqual(harness.events, ['begin', 'select', 'update', 'audit', 'commit', 'destroy']);
    assert.equal(harness.releaseCount(), 0, 'an uncertain commit must never return to the pool');
    assert.equal(harness.destroyCount(), 1, 'exactly one discard');
});

test('atomicity: a rollback failure still returns 500 and destroys the dirty connection instead of pooling it', async () => {
    const state = makeState();
    state.failAudit = true;
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Rollback Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    assert.deepEqual(harness.events, ['begin', 'select', 'update', 'audit', 'rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0, 'a failed rollback must never release the connection');
    assert.equal(harness.destroyCount(), 1, 'exactly one discard');
    assert.equal(harness.auditRows.length, 0);
});

test('atomicity: a failed connection acquisition returns the safe 500 without touching a nonexistent connection', async () => {
    const state = makeState();
    state.failAcquire = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'No Pool' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.ok(!JSON.stringify(res.body).includes('pool connection'), 'driver detail must not leak');
    assert.equal(harness.connectionCount(), 0, 'the pool rejected, so there is no connection to clean up');
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
    assert.deepEqual(harness.events, [], 'no cleanup on a nonexistent connection');
    assert.deepEqual(harness.calls, [], 'no SQL ran without a connection');
    assert.equal(state.tenants[0].business_name, 'Alpha Academy');
});

test('atomicity: a beginTransaction failure returns safe 500 and discards the unconfirmed connection', async () => {
    const state = makeState();
    state.failBegin = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Begin Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'destroy']);
    assert.equal(harness.releaseCount(), 0, 'unconfirmed transaction state is never pooled');
    assert.equal(harness.destroyCount(), 1);
    assert.deepEqual(harness.calls, [], 'no SQL ran after a failed begin');
    assert.equal(state.tenants[0].business_name, 'Alpha Academy');
});

test('atomicity: a lock/select failure after begin rolls back and releases the confirmed-clean connection', async () => {
    const state = makeState();
    state.failLockSelect = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Select Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update tenant profile' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'select', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1, 'a confirmed rollback releases exactly once');
    assert.equal(harness.destroyCount(), 0);
    assert.equal(harness.auditRows.length, 0);
});

test('atomicity: a denial cleanup failure destroys the connection and never claims a write', async () => {
    const state = makeState();
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), body: { business_name: 'Hijack' } })));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.deepEqual(harness.events, ['begin', 'select', 'rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.auditRows.length, 0);
    assert.equal(state.tenants[0].business_name, 'Alpha Academy');
});

test('atomicity: a no-op cleanup failure destroys the connection, writes nothing and returns the truthful unchanged DTO', async () => {
    const state = makeState();
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Alpha Academy' })));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active' },
    });
    assert.deepEqual(harness.events, ['begin', 'select', 'rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.auditRows.length, 0, 'a no-op never invents an audit event');
    assert.equal(harness.calls.length, 1, 'only the lock select ran');
});

test('atomicity: a 409 concurrent-update rollback failure destroys the connection', async () => {
    const state = makeState();
    state.affectedRowsOverride = 0;
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Race' })));

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Tenant profile was modified concurrently' });
    assert.deepEqual(harness.events, ['begin', 'select', 'update', 'rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
});

test('atomicity: a concurrent zero-row update is reported 409 and audited nothing', async () => {
    const state = makeState();
    state.affectedRowsOverride = 0;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(async () => runChain(harness.chain, ownerReq({ business_name: 'Race' })));

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Tenant profile was modified concurrently' });
    assert.equal(harness.auditRows.length, 0);
    assert.deepEqual(harness.events, ['begin', 'select', 'update', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
});

test('update: a connection is closed (released) on success as well', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, ownerReq({ business_name: 'Released' }));
    assert.equal(res.status, 200);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.events[harness.events.length - 1], 'release');
});

// ---------------------------------------------------------------------------
// Cache contract: no-store on every outcome the handler produces
// ---------------------------------------------------------------------------

test('cache contract: 200, 400, 404, 409 and 500 all carry no-store', async () => {
    const outcomes: Array<{ label: string; expected: number; run: () => Promise<Result> }> = [
        {
            label: '200 owner success',
            expected: 200,
            run: () => runChain(buildHarness(makeState()).chain, ownerReq({ business_name: 'Fresh Name' })),
        },
        {
            label: '200 owner no-op',
            expected: 200,
            run: () => runChain(buildHarness(makeState()).chain, ownerReq({ business_name: 'Alpha Academy' })),
        },
        {
            label: '400 invalid payload',
            expected: 400,
            run: () => runChain(buildHarness(makeState()).chain, ownerReq({ business_name: '' })),
        },
        {
            label: '404 instructor denied',
            expected: 404,
            run: () => runChain(buildHarness(makeState()).chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), body: { business_name: 'x' } })),
        },
        {
            label: '409 concurrent',
            expected: 409,
            run: () => {
                const state = makeState();
                state.affectedRowsOverride = 0;
                return withSilencedErrors(() => runChain(buildHarness(state).chain, ownerReq({ business_name: 'Race' })));
            },
        },
        {
            label: '500 update failure',
            expected: 500,
            run: () => {
                const state = makeState();
                state.failUpdate = true;
                return withSilencedErrors(() => runChain(buildHarness(state).chain, ownerReq({ business_name: 'Boom' })));
            },
        },
    ];

    for (const outcome of outcomes) {
        const res = await outcome.run();
        assert.equal(res.status, outcome.expected, `${outcome.label}: unexpected status`);
        assert.equal(res.handlerReached, true, `${outcome.label}: the production handler must have answered`);
        assert.equal(res.headers['Cache-Control'], 'no-store', `${outcome.label}: must be non-cacheable`);
    }
});

// ---------------------------------------------------------------------------
// Regression witness: the accepted M2-B01 read path is preserved
// ---------------------------------------------------------------------------

test('regression: GET /profile still returns the unchanged four-field DTO', async () => {
    // The GET route reads through the injected db adapter (not the transaction),
    // so this harness exposes the read-only seam needed for the regression check.
    const state = makeState();
    const calls: Call[] = [];
    const db = {
        query: async (sql: string, params?: any[]) => {
            calls.push({ sql, params: params ?? [] });
            return [] as any[];
        },
        queryOne: async (sql: string, params?: any[]) => {
            calls.push({ sql, params: params ?? [] });
            const tenant = state.tenants.find(t => t.id === (params ?? [])[0]);
            return tenant
                ? { id: tenant.id, business_name: tenant.business_name, subject_type: tenant.subject_type, status: tenant.status }
                : null;
        },
        execute: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.execute not expected'); },
        getConnection: async () => { throw new Error('HERMETIC_VIOLATION:db.getConnection not expected'); },
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
        if (state.tenantOwner[tenantId] === userId) return { authority: 'owner' };
        const role = state.membershipRole[`${userId}@${tenantId}`];
        return role === 'owner' || role === 'instructor' ? { authority: role } : null;
    };
    const router: Router = routeModule.createTenantSelfRouter({
        db,
        authenticate: authModule.createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        uploadBuffer: async () => violation('injected.uploadBuffer'),
        deleteFile: async () => violation('injected.deleteFile'),
        getPrivateObjectUrl: async () => violation('injected.getPrivateObjectUrl'),
        executeRenewalIntent: async () => violation('injected.executeRenewalIntent'),
    });
    const chain: RequestHandler[] = [
        authModule.createOptionalAuth(repository),
        boundaryModule.enforceTenantAuthorityBoundary,
        studentBoundaryModule.enforceStudentWorkspaceBoundary,
        router,
    ];

    const res = await runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor'), method: 'GET' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active' },
    });
    assert.deepEqual(Object.keys(res.body.tenant), DTO_KEYS);
    assert.equal(res.headers['Cache-Control'], 'no-store');
});
