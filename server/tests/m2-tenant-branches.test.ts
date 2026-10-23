/**
 * M2-B03 — tenant-owned branch metadata (hermetic, behavioral).
 *
 * Contract under test: GET/POST /api/tenants/me/branches and
 * PATCH /api/tenants/me/branches/:branchId manage branch metadata of the
 * tenant the SERVER selected, and only for the VERIFIED owner of that tenant
 * (`tenants.owner_user_id` = caller, tenant active, caller active). The
 * instructor read authority used by the profile endpoints is deliberately NOT
 * extended to branches. Branch metadata carries no assignment, enrollment,
 * pricing or capacity effect: archiving a branch changes metadata only.
 *
 * Composition under test is the real production order (src/index.ts): the real
 * optional-auth middleware, the real tenant-authority and student-workspace
 * boundaries, then the real `createTenantSelfRouter` handlers. Only leaf data
 * repositories and the transactional connection are injected fixtures. No
 * express listener, socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively: the `src/db`, `src/services/minio` and
 * `src/services/subscription-renewal` module bodies are intercepted in the
 * CommonJS loader before any app module loads, stay out of `require.cache`,
 * need no dummy env and are re-checked in `after`.
 *
 * Live MySQL row-level locking, real concurrency, real keyset index usage and
 * real HTTP transport are explicitly NOT exercised or claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-b03-hermetic-jwt-secret-not-a-real-key';
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
const BILLING_ONLY = 'billing-only-instructor-1';
const MULTI = 'multi-1';
const STUDENT = 'student-1';

const BRANCH_A1 = 'a0000000-0000-4000-8000-000000000001';
const BRANCH_A2 = 'a0000000-0000-4000-8000-000000000002';
const BRANCH_A3 = 'a0000000-0000-4000-8000-000000000003';
const BRANCH_B1 = 'b0000000-0000-4000-8000-000000000001';
const ABSENT_BRANCH = 'cccccccc-0000-4000-8000-000000000000';

interface TenantRow {
    id: string;
    business_name: string;
    subject_type: string | null;
    status: string;
    legacy_compat: number;
    owner_user_id: string;
}

interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

interface BranchRow {
    id: string;
    tenant_id: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
}

interface State {
    users: Record<string, IdentityRow>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    tenantOwner: Record<string, string>;
    membershipRole: Record<string, string>;
    enrollments: Record<string, Array<{ id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }>>;
    tenants: TenantRow[];
    branches: BranchRow[];
    branchClock: number;
    failAcquire: boolean;
    failBegin: boolean;
    failOwnerSelect: boolean;
    failList: boolean;
    failInsert: boolean;
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
            [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(),
            [ROLE_OWNER_MEMBER]: identity(), [BILLING_ONLY]: identity(), [MULTI]: identity(), [STUDENT]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(), [INSTRUCTOR_A]: activeAccount(),
            [ROLE_OWNER_MEMBER]: activeAccount(), [MULTI]: activeAccount(),
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
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: OWNER_B },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${OWNER_B}@${TENANT_B}`]: 'owner',
            [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
            [`${ROLE_OWNER_MEMBER}@${TENANT_A}`]: 'owner',
            [`${BILLING_ONLY}@${TENANT_A}`]: 'instructor',
        },
        enrollments: {
            [STUDENT]: [{ id: 'enrollment-1', user_id: STUDENT, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: 'g-1', grade_id: 'gr-1' }],
        },
        tenants: [
            { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active', legacy_compat: 0, owner_user_id: OWNER_A },
            { id: TENANT_B, business_name: 'Beta Academy', subject_type: null, status: 'active', legacy_compat: 0, owner_user_id: OWNER_B },
        ],
        branches: [
            { id: BRANCH_A1, tenant_id: TENANT_A, name: 'North Campus', status: 'active', created_at: '2026-10-19 08:00:00', updated_at: '2026-10-19 08:00:00' },
            { id: BRANCH_A2, tenant_id: TENANT_A, name: 'South Campus', status: 'active', created_at: '2026-10-19 08:01:00', updated_at: '2026-10-19 08:01:00' },
            { id: BRANCH_A3, tenant_id: TENANT_A, name: 'Archive Campus', status: 'archived', created_at: '2026-10-19 08:02:00', updated_at: '2026-10-19 08:02:00' },
            { id: BRANCH_B1, tenant_id: TENANT_B, name: 'Foreign Campus', status: 'active', created_at: '2026-10-19 08:03:00', updated_at: '2026-10-19 08:03:00' },
        ],
        branchClock: 0,
        failAcquire: false,
        failBegin: false,
        failOwnerSelect: false,
        failList: false,
        failInsert: false,
        failAudit: false,
        failCommit: false,
        failRollback: false,
        affectedRowsOverride: null,
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const OWNER_SELECT = 'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';
const OWNER_LOCK_SELECT = `${OWNER_SELECT} FOR UPDATE`;
const LIST_SQL = 'SELECT b.id,b.name,b.status,b.created_at,b.updated_at FROM tenant_branches b WHERE b.tenant_id=? AND b.id>? ORDER BY b.id ASC LIMIT ?';
const BRANCH_SELECT = 'SELECT b.id,b.name,b.status,b.created_at,b.updated_at FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? LIMIT 1';
const BRANCH_LOCK_SELECT = 'SELECT b.id,b.name,b.status,b.created_at,b.updated_at FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? FOR UPDATE';
const INSERT_BRANCH_SQL = 'INSERT INTO tenant_branches (id,tenant_id,name,status) VALUES (?,?,?,?)';
const UPDATE_BRANCH_SQL = 'UPDATE tenant_branches SET name=?,status=? WHERE id=? AND tenant_id=?';
const AUDIT_SQL = 'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';
// The accepted M2-B01/M2-B02 profile statements are answered by the same
// fixture so the untouched profile surface can be witnessed through the real
// production handler.
const PROFILE_LOCK_SELECT = 'SELECT t.business_name,t.subject_type,t.status AS tenant_status,t.owner_user_id,u.is_active AS caller_active FROM tenants t JOIN users u WHERE t.id=? AND u.id=? FOR UPDATE';
const PROFILE_UPDATE_SQL = 'UPDATE tenants SET business_name=? WHERE id=? AND owner_user_id=?';

interface Harness {
    chain: RequestHandler[];
    calls: Call[];
    auditRows: Call[];
    events: string[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];
    const auditRows: Call[] = [];
    const events: string[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;

    const branchRow = (id: string, tenantId: string) =>
        state.branches.find(b => b.id === id && b.tenant_id === tenantId) ?? null;

    const branchSql = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === OWNER_SELECT || n === OWNER_LOCK_SELECT) {
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
            if (state.failList) throw new Error('branch list failed: internal detail leaked');
            const [tenantId, afterId, limit] = params;
            const rows = state.branches
                .filter(b => b.tenant_id === tenantId && b.id > afterId)
                .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
                .slice(0, Number(limit))
                .map(b => ({ ...b }));
            return [rows, []];
        }

        if (n === BRANCH_SELECT || n === BRANCH_LOCK_SELECT) {
            events.push('select');
            const row = branchRow(String(params[0]), String(params[1]));
            return [row ? [{ ...row }] : [], []];
        }

        if (n === INSERT_BRANCH_SQL) {
            events.push('insert');
            if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert on internal table tenant_branches failed');
            const [id, tenantId, name, status] = params;
            state.branchClock += 1;
            const stamp = `2026-10-19 09:${String(state.branchClock).padStart(2, '0')}:00`;
            state.branches.push({ id: String(id), tenant_id: String(tenantId), name: String(name), status: String(status), created_at: stamp, updated_at: stamp });
            return [{ affectedRows: 1, insertId: String(id) }, []];
        }

        if (n === UPDATE_BRANCH_SQL) {
            events.push('update');
            const [name, status, id, tenantId] = params;
            const affected = state.affectedRowsOverride ?? 1;
            if (affected === 1) {
                const row = branchRow(String(id), String(tenantId));
                if (row) {
                    row.name = String(name);
                    row.status = String(status);
                    row.updated_at = '2026-10-19 10:00:00';
                }
            }
            return [{ affectedRows: affected }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            auditRows.push({ sql, params });
            return [{ affectedRows: 1 }, []];
        }

        if (n === PROFILE_LOCK_SELECT) {
            events.push('profile-select');
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

        if (n === PROFILE_UPDATE_SQL) {
            events.push('profile-update');
            const tenant = state.tenants.find(t => t.id === params[1] && t.owner_user_id === params[2]);
            if (!tenant) return [{ affectedRows: 0 }, []];
            tenant.business_name = String(params[0]);
            return [{ affectedRows: 1 }, []];
        }

        throw new Error(`Unhandled branch SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        return {
            beginTransaction: async () => { events.push('begin'); if (state.failBegin) throw new Error('begin failed: internal detail leaked'); },
            execute: branchSql,
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
        auditRows,
        events,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
    };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string>; handlerReached: boolean; responseCount: number }

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
    const pathName = opts.pathName ?? '/branches';
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

function runChain(chain: RequestHandler[], req: any): Promise<Result> {
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

const sign = (id: string, role: string, extra: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m', ...options });

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

const BRANCH_DTO_KEYS = ['id', 'name', 'status', 'created_at', 'updated_at'];
const ownerToken = () => sign(OWNER_A, 'instructor');
const listReq = (query: any = {}) => makeReq({ token: ownerToken(), method: 'GET', pathName: '/branches', query });
const createReq = (body: any) => makeReq({ token: ownerToken(), method: 'POST', pathName: '/branches', body });
const updateReq = (branchId: string, body: any, token = ownerToken()) =>
    makeReq({ token, method: 'PATCH', pathName: `/branches/${branchId}`, body });

/** base64url without padding — the production cursor encoding. */
const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
// GET /branches — owner-only bounded list
// ---------------------------------------------------------------------------

test('list: the verified owner reads only the selected tenant branches', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['branches', 'next_cursor']);
    assert.deepEqual(res.body.branches.map((b: any) => b.id), [BRANCH_A1, BRANCH_A2, BRANCH_A3]);
    assert.deepEqual(Object.keys(res.body.branches[0]), BRANCH_DTO_KEYS);
    assert.equal(res.body.next_cursor, null, 'a short page has no successor cursor');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'list', 'rollback', 'release']);
    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_SELECT, 'the read path verifies the owner without an exclusive lock');
    assert.deepEqual(ownerCall.params, [OWNER_A, TENANT_A]);
    const listCall = harness.calls[1];
    assert.equal(squash(listCall.sql), LIST_SQL);
    assert.deepEqual(listCall.params, [TENANT_A, '', 26], 'the list is tenant-qualified, cursor-bounded and reads one extra row');
    assert.ok(!JSON.stringify(res.body).includes(TENANT_B), 'no other tenant may be disclosed');
    assert.ok(!JSON.stringify(res.body).includes('Foreign Campus'), 'a foreign branch must never be listed');
});

test('list: the page size defaults to 25 and the default page never returns more than 25 rows', async () => {
    const state = makeState();
    for (let index = 0; index < 40; index += 1) {
        state.branches.push({
            id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            tenant_id: TENANT_A, name: `Extra ${index}`, status: 'active',
            created_at: '2026-10-19 08:10:00', updated_at: '2026-10-19 08:10:00',
        });
    }
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());

    assert.equal(res.status, 200);
    assert.equal(res.body.branches.length, 25, 'the default page is bounded to 25 rows');
    assert.equal(res.body.next_cursor, encodeCursor(res.body.branches[24].id), 'a full page mints the next cursor');
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [TENANT_A, '', 26]);
});

test('list: an explicit limit is honored and the maximum page size is 100', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({ limit: '2' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.branches.length, 2);
    assert.equal(res.body.next_cursor, encodeCursor(BRANCH_A2));
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [TENANT_A, '', 3]);

    const maxHarness = buildHarness(makeState());
    const maxRes = await runChain(maxHarness.chain, listReq({ limit: '100' }));
    assert.equal(maxRes.status, 200);
    const maxCall = maxHarness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(maxCall?.params, [TENANT_A, '', 101], '100 is the accepted maximum');
});

test('list: an out-of-range or malformed limit is rejected 400 before any database access', async () => {
    const cases = ['0', '101', '1000', 'abc', '-1', '1.5', ' 5', '5 '];
    for (const limit of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, listReq({ limit }));
        assert.equal(res.status, 400, `limit=${limit} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid branch list limit' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.equal(harness.connectionCount(), 0, `limit=${limit} must not open a transaction`);
        assert.deepEqual(harness.calls, []);
    }
});

test('list: a malformed cursor is rejected 400 before any database access', async () => {
    const cases = ['not-base64!!', 'Zm9v', 'YQ', '', 'a'.repeat(200)];
    for (const cursor of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, listReq({ cursor }));
        assert.equal(res.status, 400, `cursor=${cursor} must be rejected 400`);
        assert.deepEqual(res.body, { error: 'Invalid branch list cursor' });
        assert.equal(harness.connectionCount(), 0);
        assert.deepEqual(harness.calls, []);
    }
});

test('list: the cursor is opaque and resumes strictly after the last returned row', async () => {
    const harness = buildHarness(makeState());
    const first = await runChain(harness.chain, listReq({ limit: '2' }));
    assert.deepEqual(first.body.branches.map((b: any) => b.id), [BRANCH_A1, BRANCH_A2]);
    assert.equal(first.body.next_cursor, encodeCursor(BRANCH_A2));

    const second = buildHarness(makeState());
    const res = await runChain(second.chain, listReq({ limit: '2', cursor: first.body.next_cursor }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branches.map((b: any) => b.id), [BRANCH_A3], 'the next page starts after the last returned row');
    assert.equal(res.body.next_cursor, null);

    const listCall = second.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [TENANT_A, BRANCH_A2, 3], 'the cursor is a position bound into the tenant-qualified query');
});

test('list: a cursor is only a position and never discloses another tenant', async () => {
    // A cursor minted for tenant-b's branch id is a valid position, but the
    // page is still qualified by the selected tenant.
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq({ cursor: encodeCursor(BRANCH_B1) }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branches, [], 'the position is past every branch of the selected tenant');
    assert.equal(res.body.next_cursor, null);
    assert.ok(!JSON.stringify(res.body).includes('Foreign Campus'));
    const listCall = harness.calls.find(c => squash(c.sql) === LIST_SQL);
    assert.deepEqual(listCall?.params, [TENANT_A, BRANCH_B1, 26], 'the tenant qualification is not replaced by the cursor');

    // A cursor positioned before the tenant's branches still returns only that
    // tenant's branches.
    const earlier = buildHarness(makeState());
    const earlierRes = await runChain(earlier.chain, listReq({ cursor: encodeCursor('00000000-0000-4000-8000-000000000000') }));
    assert.equal(earlierRes.status, 200);
    assert.deepEqual(earlierRes.body.branches.map((b: any) => b.id), [BRANCH_A1, BRANCH_A2, BRANCH_A3]);
    assert.ok(!JSON.stringify(earlierRes.body).includes('Foreign Campus'));
});

test('list: an instructor membership is denied and no branch is read', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), method: 'GET', pathName: '/branches' }));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.ok(!harness.events.includes('list'), 'no branch row may be read for a non-owner');
    assert.deepEqual(harness.auditRows, []);
});

test('list: a membership role of "owner" without the real owner_user_id is denied', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: sign(ROLE_OWNER_MEMBER, 'instructor'), method: 'GET', pathName: '/branches' }));
    assert.equal(res.status, 403);
    assert.ok(!harness.events.includes('list'));
});

test('list: a suspended tenant is denied for the recorded owner', async () => {
    const state = makeState();
    state.tenants[0].status = 'suspended';
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 403);
    assert.ok(!harness.events.includes('list'));
});

test('list: a principal without a selected tenant is denied 404 without a transaction', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: sign(MULTI, 'teacher'), method: 'GET', pathName: '/branches' }));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(harness.connectionCount(), 0);
    assert.deepEqual(harness.calls, []);
});

// ---------------------------------------------------------------------------
// POST /branches — owner-only create
// ---------------------------------------------------------------------------

test('create: the owner creates a branch and the insert and the audit commit together', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, createReq({ name: '  East Campus  ' }));

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body), ['branch']);
    assert.deepEqual(Object.keys(res.body.branch), BRANCH_DTO_KEYS);
    assert.equal(res.body.branch.name, 'East Campus', 'the stored name is the trimmed value');
    assert.equal(res.body.branch.status, 'active');
    assert.match(res.body.branch.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the branch id is server-generated');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'insert', 'audit', 'select', 'commit', 'release']);

    const ownerCall = harness.calls[0];
    assert.equal(squash(ownerCall.sql), OWNER_LOCK_SELECT, 'a write re-verifies the owner under a lock');
    assert.deepEqual(ownerCall.params, [OWNER_A, TENANT_A]);
    const insertCall = harness.calls[1];
    assert.equal(squash(insertCall.sql), INSERT_BRANCH_SQL);
    assert.equal(insertCall.params[0], res.body.branch.id);
    assert.deepEqual(insertCall.params.slice(1), [TENANT_A, 'East Campus', 'active'], 'the branch is placed in the selected tenant');
    const auditCall = harness.calls[2];
    assert.equal(squash(auditCall.sql), AUDIT_SQL);
    assert.deepEqual(auditCall.params.slice(1, 6), [OWNER_A, TENANT_A, 'tenant.branch_created', 'tenant_branch', res.body.branch.id]);
    assert.equal(auditCall.params[6], null, 'a creation has no previous value');
    assert.deepEqual(JSON.parse(auditCall.params[7]), { name: 'East Campus', status: 'active' });
    assert.equal(harness.auditRows.length, 1, 'exactly one audit event is written');
    assert.equal(state.branches.filter(b => b.tenant_id === TENANT_A && b.name === 'East Campus').length, 1);
});

test('create: duplicate names are allowed — the id is the identity', async () => {
    const state = makeState();
    const first = buildHarness(state);
    const firstRes = await runChain(first.chain, createReq({ name: 'Duplicate Campus' }));
    assert.equal(firstRes.status, 201);

    const second = buildHarness(state);
    const secondRes = await runChain(second.chain, createReq({ name: 'Duplicate Campus' }));
    assert.equal(secondRes.status, 201, 'no uniqueness rule is inferred from the name');
    assert.notEqual(secondRes.body.branch.id, firstRes.body.branch.id, 'each branch keeps its own server-generated id');
    assert.equal(state.branches.filter(b => b.name === 'Duplicate Campus').length, 2);
});

test('create: a 255-character name is accepted and a 256-character name is rejected', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, createReq({ name: 'x'.repeat(255) }));
    assert.equal(res.status, 201);
    assert.equal(res.body.branch.name.length, 255);

    const rejected = buildHarness(makeState());
    const bad = await runChain(rejected.chain, createReq({ name: 'y'.repeat(256) }));
    assert.equal(bad.status, 400);
    assert.equal(rejected.connectionCount(), 0);
});

test('create: an invalid payload is rejected 400 before any connection is taken', async () => {
    const cases: Array<{ label: string; body: any; upstream?: boolean }> = [
        { label: 'missing name', body: {} },
        { label: 'null name', body: { name: null } },
        { label: 'numeric name', body: { name: 42 } },
        { label: 'object name', body: { name: { nested: true } } },
        { label: 'array name', body: { name: ['x'] } },
        { label: 'empty name', body: { name: '' } },
        { label: 'whitespace-only name', body: { name: '   ' } },
        { label: 'over 255', body: { name: 'z'.repeat(256) } },
        { label: 'extra status key', body: { name: 'Campus', status: 'archived' } },
        { label: 'extra tenant selector key', body: { name: 'Campus', tenant_id: TENANT_B }, upstream: true },
        { label: 'array body', body: [{ name: 'Campus' }] },
        { label: 'null body', body: null },
    ];

    for (const testCase of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, createReq(testCase.body));
        assert.equal(res.status, 400, `${testCase.label} must be rejected 400`);
        if (testCase.upstream) {
            // The shared tenant-authority boundary answers a client-supplied
            // selector before the handler; that upstream answer keeps its own
            // pre-existing shape and is not the handler's own 400.
            assert.deepEqual(res.body, { error: 'Tenant context must not be supplied by the client' });
        } else {
            assert.deepEqual(res.body, { error: 'Invalid branch payload' });
            assert.equal(res.headers['Cache-Control'], 'no-store', `${testCase.label} own 400 must be non-cacheable`);
        }
        assert.equal(harness.connectionCount(), 0, `${testCase.label} must not open a transaction`);
        assert.deepEqual(harness.calls, [], `${testCase.label} must not reach SQL`);
    }
});

test('create: a client-supplied tenant selector never places the branch in another tenant', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    // The boundary middleware rejects the selector before the handler; the
    // handler itself also refuses any key other than `name`.
    const res = await runChain(harness.chain, createReq({ name: 'Campus', tenant_id: TENANT_B }));
    assert.equal(res.status, 400);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(state.branches.some(b => b.tenant_id === TENANT_B && b.name === 'Campus'), false);
});

test('create: a non-owner is denied 403 and writes nothing', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), method: 'POST', pathName: '/branches', body: { name: 'Hijack' } }));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.auditRows.length, 0);
    assert.equal(state.branches.some(b => b.name === 'Hijack'), false);
});

// ---------------------------------------------------------------------------
// PATCH /branches/:branchId — rename and archive
// ---------------------------------------------------------------------------

test('update: the owner renames a branch and the change and the audit commit together', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, updateReq(BRANCH_A1, { name: '  North Annex  ' }));

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['branch']);
    assert.deepEqual(Object.keys(res.body.branch), BRANCH_DTO_KEYS);
    assert.equal(res.body.branch.id, BRANCH_A1);
    assert.equal(res.body.branch.name, 'North Annex');
    assert.equal(res.body.branch.status, 'active', 'an unspecified status is unchanged');
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(harness.events, ['begin', 'owner', 'select', 'update', 'audit', 'select', 'commit', 'release']);
    const lockCall = harness.calls[1];
    assert.equal(squash(lockCall.sql), BRANCH_LOCK_SELECT, 'the branch lookup qualifies the id and the tenant');
    assert.deepEqual(lockCall.params, [BRANCH_A1, TENANT_A]);
    const updateCall = harness.calls[2];
    assert.equal(squash(updateCall.sql), UPDATE_BRANCH_SQL);
    assert.deepEqual(updateCall.params, ['North Annex', 'active', BRANCH_A1, TENANT_A]);
    const auditCall = harness.calls[3];
    assert.equal(squash(auditCall.sql), AUDIT_SQL);
    assert.deepEqual(auditCall.params.slice(1, 6), [OWNER_A, TENANT_A, 'tenant.branch_updated', 'tenant_branch', BRANCH_A1]);
    assert.deepEqual(JSON.parse(auditCall.params[6]), { name: 'North Campus', status: 'active' });
    assert.deepEqual(JSON.parse(auditCall.params[7]), { name: 'North Annex', status: 'active' });
});

test('update: the owner archives a branch and can reactivate it', async () => {
    const state = makeState();
    const archiveHarness = buildHarness(state);
    const archived = await runChain(archiveHarness.chain, updateReq(BRANCH_A1, { status: 'archived' }));
    assert.equal(archived.status, 200);
    assert.equal(archived.body.branch.status, 'archived');
    assert.equal(state.branches.find(b => b.id === BRANCH_A1)?.status, 'archived');

    const auditCall = archiveHarness.calls.find(c => squash(c.sql) === AUDIT_SQL);
    assert.deepEqual(JSON.parse(auditCall!.params[6]), { name: 'North Campus', status: 'active' });
    assert.deepEqual(JSON.parse(auditCall!.params[7]), { name: 'North Campus', status: 'archived' });

    const reactHarness = buildHarness(state);
    const reactivated = await runChain(reactHarness.chain, updateReq(BRANCH_A1, { status: 'active' }));
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.branch.status, 'active');
});

test('update: archiving a branch changes metadata only and touches no other table', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    await runChain(harness.chain, updateReq(BRANCH_A1, { status: 'archived' }));
    const statements = harness.calls.map(c => squash(c.sql));
    assert.equal(statements.filter(s => s.startsWith('UPDATE tenant_branches')).length, 1);
    assert.equal(statements.filter(s => s.startsWith('INSERT INTO audit_events')).length, 1);
    assert.ok(!statements.some(s => s.includes('enrollment') || s.includes('wallet') || s.includes('subscription') || s.includes('group')),
        'no assignment, enrollment, group or financial statement may run');
});

test('update: an identical retry is a truthful no-op — no UPDATE, no audit event', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, updateReq(BRANCH_A1, { name: 'North Campus' }));

    assert.equal(res.status, 200);
    assert.equal(res.body.branch.name, 'North Campus');
    assert.equal(res.body.branch.status, 'active');
    assert.equal(harness.auditRows.length, 0, 'a no-op must not invent a change event');
    assert.deepEqual(harness.events, ['begin', 'owner', 'select', 'rollback', 'release']);
    const statements = harness.calls.map(c => squash(c.sql));
    assert.ok(!statements.some(s => s.startsWith('UPDATE tenant_branches')), 'a no-op must not update the row');
});

test('update: a no-op that only repeats the current status also writes and audits nothing', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, updateReq(BRANCH_A1, { status: 'active' }));
    assert.equal(res.status, 200);
    assert.equal(harness.auditRows.length, 0);
    assert.ok(!harness.calls.map(c => squash(c.sql)).some(s => s.startsWith('UPDATE tenant_branches')));
});

test('update: a foreign branch id and an absent id produce the identical not-found result', async () => {
    const foreignHarness = buildHarness(makeState());
    const foreign = await runChain(foreignHarness.chain, updateReq(BRANCH_B1, { name: 'Stolen' }));
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: 'Branch not found' });
    assert.equal(foreign.headers['Cache-Control'], 'no-store');

    const absentHarness = buildHarness(makeState());
    const absent = await runChain(absentHarness.chain, updateReq(ABSENT_BRANCH, { name: 'Missing' }));
    assert.equal(absent.status, 404);
    assert.deepEqual(absent.body, { error: 'Branch not found' }, 'a foreign and an absent id must be indistinguishable');

    assert.equal(foreignHarness.auditRows.length, 0);
    assert.equal(absentHarness.auditRows.length, 0);
    assert.ok(!foreignHarness.calls.map(c => squash(c.sql)).some(s => s.startsWith('UPDATE tenant_branches')));
    assert.ok(!absentHarness.calls.map(c => squash(c.sql)).some(s => s.startsWith('UPDATE tenant_branches')));
});

test('update: an invalid payload is rejected 400 before any connection is taken', async () => {
    const cases: Array<{ label: string; id: string; body: any; upstream?: boolean }> = [
        { label: 'empty update', id: BRANCH_A1, body: {} },
        { label: 'unknown key', id: BRANCH_A1, body: { name: 'X', capacity: 30 } },
        { label: 'tenant selector key', id: BRANCH_A1, body: { name: 'X', tenant_id: TENANT_B }, upstream: true },
        { label: 'invalid status', id: BRANCH_A1, body: { status: 'deleted' } },
        { label: 'non-string status', id: BRANCH_A1, body: { status: 1 } },
        { label: 'null name', id: BRANCH_A1, body: { name: null } },
        { label: 'empty name', id: BRANCH_A1, body: { name: '' } },
        { label: 'whitespace name', id: BRANCH_A1, body: { name: '  ' } },
        { label: 'over 255 name', id: BRANCH_A1, body: { name: 'z'.repeat(256) } },
        { label: 'array body', id: BRANCH_A1, body: [{ name: 'X' }] },
        { label: 'null body', id: BRANCH_A1, body: null },
        { label: 'malformed branch id', id: 'not-a-uuid', body: { name: 'X' } },
    ];

    for (const testCase of cases) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, updateReq(testCase.id, testCase.body));
        assert.equal(res.status, 400, `${testCase.label} must be rejected 400`);
        if (!testCase.upstream) {
            assert.equal(res.headers['Cache-Control'], 'no-store', `${testCase.label} own 400 must be non-cacheable`);
        }
        assert.equal(harness.connectionCount(), 0, `${testCase.label} must not open a transaction`);
        assert.deepEqual(harness.calls, [], `${testCase.label} must not reach SQL`);
    }
});

test('update: a non-owner is denied 403 and writes nothing', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, updateReq(BRANCH_A1, { name: 'Hijack' }, sign(INSTRUCTOR_A, 'instructor')));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.equal(state.branches.find(b => b.id === BRANCH_A1)?.name, 'North Campus');
    assert.equal(harness.auditRows.length, 0);
    assert.ok(!harness.calls.map(c => squash(c.sql)).some(s => s.startsWith('UPDATE tenant_branches')));
});

// ---------------------------------------------------------------------------
// Billing-only denial — enforced locally, before any data access
// ---------------------------------------------------------------------------

test('billingOnly: a billing-only instructor is denied 403 on all three branch routes without any database access', async () => {
    const requests: Array<{ label: string; req: any }> = [
        { label: 'GET /branches', req: makeReq({ token: sign(BILLING_ONLY, 'instructor'), method: 'GET', pathName: '/branches' }) },
        { label: 'POST /branches', req: makeReq({ token: sign(BILLING_ONLY, 'instructor'), method: 'POST', pathName: '/branches', body: { name: 'Campus' } }) },
        { label: 'PATCH /branches/:id', req: makeReq({ token: sign(BILLING_ONLY, 'instructor'), method: 'PATCH', pathName: `/branches/${BRANCH_A1}`, body: { name: 'Campus' } }) },
    ];

    for (const entry of requests) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, 403, `${entry.label} must be denied 403`);
        assert.deepEqual(res.body, {
            error: 'Branch management is not available while the account is limited to billing and support',
            code: 'BILLING_ONLY',
        });
        assert.equal(res.headers['Cache-Control'], 'no-store', `${entry.label} must carry the handler's own no-store`);
        assert.equal(harness.connectionCount(), 0, `${entry.label} must not open a transaction`);
        assert.deepEqual(harness.calls, [], `${entry.label} must not reach SQL`);
        assert.deepEqual(harness.events, [], `${entry.label} must not touch the database at all`);
    }
});

test('billingOnly: a normal owner is never affected by the local denial', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, listReq());
    assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Tenant selector boundary
// ---------------------------------------------------------------------------

test('boundary: a client-supplied tenant selector is rejected 400 before the handler on all three routes', async () => {
    const requests: Array<{ label: string; req: any }> = [
        { label: 'GET body selector', req: makeReq({ token: ownerToken(), method: 'GET', pathName: '/branches', body: { tenant_id: TENANT_B } }) },
        { label: 'GET query selector', req: makeReq({ token: ownerToken(), method: 'GET', pathName: '/branches', query: { tenantId: TENANT_B } }) },
        { label: 'GET header selector', req: makeReq({ token: ownerToken(), method: 'GET', pathName: '/branches', headers: { 'x-tenant-id': TENANT_B } }) },
        { label: 'POST body selector', req: makeReq({ token: ownerToken(), method: 'POST', pathName: '/branches', body: { name: 'Campus', tenant_id: TENANT_B } }) },
        { label: 'PATCH body selector', req: makeReq({ token: ownerToken(), method: 'PATCH', pathName: `/branches/${BRANCH_A1}`, body: { name: 'Campus', tenant: TENANT_B } }) },
    ];

    for (const entry of requests) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.status, 400, `${entry.label} must be rejected 400`);
        assert.equal(harness.connectionCount(), 0, `${entry.label} must not open a transaction`);
        assert.deepEqual(harness.calls, []);
    }
});

// ---------------------------------------------------------------------------
// Failure handling, atomicity and cleanup
// ---------------------------------------------------------------------------

test('atomicity: a failed branch insert rolls back, releases and never audits', async () => {
    const state = makeState();
    state.failInsert = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Will Fail' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create branch' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'owner', 'insert', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.auditRows.length, 0);
    assert.equal(state.branches.some(b => b.name === 'Will Fail'), false);
    assert.ok(!JSON.stringify(res.body).includes('ER_LOCK'), 'driver detail must not leak');
});

test('atomicity: a failed audit rolls the branch insert back and never commits', async () => {
    const state = makeState();
    state.failAudit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Audit Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create branch' });
    // The fixture cannot replay a real rollback; the asserted boundary is that
    // the transaction was rolled back and commit was never reached.
    assert.deepEqual(harness.events, ['begin', 'owner', 'insert', 'audit', 'rollback', 'release']);
    assert.equal(harness.events.includes('commit'), false, 'no commit may follow a failed audit');
    assert.equal(harness.releaseCount(), 1);
});

test('atomicity: a lost commit acknowledgement reports 500, claims no rollback and discards the uncertain connection', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Commit Lost' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create branch' });
    assert.equal(harness.events.includes('rollback'), false, 'an ambiguous commit must not claim a rollback');
    assert.deepEqual(harness.events, ['begin', 'owner', 'insert', 'audit', 'select', 'commit', 'destroy']);
    assert.equal(harness.releaseCount(), 0, 'an uncertain commit must never return to the pool');
    assert.equal(harness.destroyCount(), 1, 'exactly one discard');
});

test('atomicity: an update commit acknowledgement failure is equally uncertain', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, updateReq(BRANCH_A1, { name: 'Commit Lost' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to update branch' });
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
});

test('atomicity: a failed connection acquisition returns the safe 500 without touching a nonexistent connection', async () => {
    const state = makeState();
    state.failAcquire = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'No Pool' })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to create branch' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(harness.connectionCount(), 0);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
    assert.deepEqual(harness.events, [], 'no cleanup on a nonexistent connection');
    assert.ok(!JSON.stringify(res.body).includes('pool connection'), 'driver detail must not leak');
});

test('atomicity: a failed beginTransaction discards the unconfirmed connection', async () => {
    const state = makeState();
    state.failBegin = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Begin Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(harness.events, ['begin', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.deepEqual(harness.calls, []);
});

test('atomicity: a failed rollback destroys the connection instead of pooling it', async () => {
    const state = makeState();
    state.failInsert = true;
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, createReq({ name: 'Rollback Fails' })));

    assert.equal(res.status, 500);
    assert.deepEqual(harness.events, ['begin', 'owner', 'insert', 'rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0, 'a failed rollback must never release the connection');
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.auditRows.length, 0);
});

test('atomicity: a denial cleanup failure destroys the connection and never claims a write', async () => {
    const state = makeState();
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), method: 'POST', pathName: '/branches', body: { name: 'Hijack' } })));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Forbidden' });
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.auditRows.length, 0);
});

test('atomicity: a zero-row update is reported 409 and audited nothing', async () => {
    const state = makeState();
    state.affectedRowsOverride = 0;
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, updateReq(BRANCH_A1, { name: 'Race' }));

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Branch was modified concurrently' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(harness.auditRows.length, 0);
    assert.deepEqual(harness.events, ['begin', 'owner', 'select', 'update', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
});

test('atomicity: a failed list read rolls back and releases the confirmed-clean connection', async () => {
    const state = makeState();
    state.failList = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to list branches' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(harness.events, ['begin', 'owner', 'list', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('atomicity: a failed owner verification rolls back and releases without reading branches', async () => {
    const state = makeState();
    state.failOwnerSelect = true;
    const harness = buildHarness(state);
    const res = await withSilencedErrors(() => runChain(harness.chain, listReq()));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to list branches' });
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.releaseCount(), 1);
    assert.ok(!harness.events.includes('list'));
});

// ---------------------------------------------------------------------------
// Cache contract and response hygiene
// ---------------------------------------------------------------------------

test('cache contract: 200, 201, 400, 403, 404, 409 and 500 all carry no-store', async () => {
    const outcomes: Array<{ label: string; expected: number; run: () => Promise<Result> }> = [
        {
            label: '200 list success',
            expected: 200,
            run: () => runChain(buildHarness(makeState()).chain, listReq()),
        },
        {
            label: '201 create success',
            expected: 201,
            run: () => runChain(buildHarness(makeState()).chain, createReq({ name: 'Fresh Campus' })),
        },
        {
            label: '200 update success',
            expected: 200,
            run: () => runChain(buildHarness(makeState()).chain, updateReq(BRANCH_A1, { name: 'Fresh Campus' })),
        },
        {
            label: '200 update no-op',
            expected: 200,
            run: () => runChain(buildHarness(makeState()).chain, updateReq(BRANCH_A1, { name: 'North Campus' })),
        },
        {
            label: '400 invalid payload',
            expected: 400,
            run: () => runChain(buildHarness(makeState()).chain, createReq({ name: '' })),
        },
        {
            label: '400 invalid limit',
            expected: 400,
            run: () => runChain(buildHarness(makeState()).chain, listReq({ limit: '0' })),
        },
        {
            label: '403 non-owner',
            expected: 403,
            run: () => runChain(buildHarness(makeState()).chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor'), method: 'GET', pathName: '/branches' })),
        },
        {
            label: '403 billing only',
            expected: 403,
            run: () => runChain(buildHarness(makeState()).chain, makeReq({ token: sign(BILLING_ONLY, 'instructor'), method: 'GET', pathName: '/branches' })),
        },
        {
            label: '404 absent branch',
            expected: 404,
            run: () => runChain(buildHarness(makeState()).chain, updateReq(ABSENT_BRANCH, { name: 'Ghost' })),
        },
        {
            label: '409 concurrent update',
            expected: 409,
            run: () => {
                const state = makeState();
                state.affectedRowsOverride = 0;
                return runChain(buildHarness(state).chain, updateReq(BRANCH_A1, { name: 'Race' }));
            },
        },
        {
            label: '500 list failure',
            expected: 500,
            run: () => {
                const state = makeState();
                state.failList = true;
                return withSilencedErrors(() => runChain(buildHarness(state).chain, listReq()));
            },
        },
        {
            label: '500 create failure',
            expected: 500,
            run: () => {
                const state = makeState();
                state.failInsert = true;
                return withSilencedErrors(() => runChain(buildHarness(state).chain, createReq({ name: 'Boom' })));
            },
        },
    ];

    for (const outcome of outcomes) {
        const res = await outcome.run();
        assert.equal(res.status, outcome.expected, `${outcome.label}: unexpected status`);
        assert.equal(res.handlerReached, true, `${outcome.label}: the production handler must have answered`);
        assert.equal(res.headers['Cache-Control'], 'no-store', `${outcome.label}: must be non-cacheable`);
        assert.equal(res.responseCount, 1, `${outcome.label}: exactly one response may be produced`);
    }
});

test('response hygiene: every branch request answers exactly once', async () => {
    const requests: Array<{ label: string; req: any }> = [
        { label: 'list', req: listReq() },
        { label: 'create', req: createReq({ name: 'Campus' }) },
        { label: 'update', req: updateReq(BRANCH_A1, { name: 'Campus' }) },
        { label: 'update no-op', req: updateReq(BRANCH_A1, { name: 'North Campus' }) },
        { label: 'update absent', req: updateReq(ABSENT_BRANCH, { name: 'Campus' }) },
        { label: 'invalid create', req: createReq({}) },
    ];

    for (const entry of requests) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, entry.req);
        assert.equal(res.responseCount, 1, `${entry.label}: exactly one response may be produced`);
        assert.equal(res.handlerReached, true, `${entry.label}: the handler must have answered`);
    }
});

// ---------------------------------------------------------------------------
// Regression witnesses: the accepted M2-B01/M2-B02 profile surface is unchanged
// ---------------------------------------------------------------------------

test('regression: GET /profile still returns the unchanged four-field DTO', async () => {
    const state = makeState();
    const calls: Call[] = [];
    const db = {
        query: async (sql: string, params?: any[]) => { calls.push({ sql, params: params ?? [] }); return [] as any[]; },
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

    const res = await runChain(chain, makeReq({ token: ownerToken(), method: 'GET', pathName: '/profile' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active' },
    });
    assert.deepEqual(Object.keys(res.body.tenant), ['id', 'business_name', 'subject_type', 'status']);
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('regression: PATCH /profile still renames the institution and audits it', async () => {
    const state = makeState();
    const harness = buildHarness(state);
    // The profile write path uses the pool-less transactional seam; the branch
    // fixture answers the profile statements too, so the accepted route is
    // exercised end to end through the same production handler.
    const res = await runChain(harness.chain, makeReq({ token: ownerToken(), method: 'PATCH', pathName: '/profile', body: { business_name: 'Alpha Institute' } }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Institute', subject_type: 'company', status: 'active' },
    });
    assert.equal(res.headers['Cache-Control'], 'no-store');
});
