/**
 * M2-B01 — selected-tenant profile read (hermetic, behavioral).
 *
 * Contract under test: GET /api/tenants/me/profile returns exactly
 * `{ tenant: { id, business_name, subject_type, status } }` for the tenant the
 * SERVER selected from the caller's active memberships, with
 * `Cache-Control: no-store` on EVERY outcome this handler can produce — 200,
 * the handler's own 404, and both 500 paths — because the directive is applied
 * before the first await (supervisor/099 correction). The route is read-only:
 * no tenant id is accepted from header/query/body, there is no fallback to an
 * arbitrary membership, and no billing, owner, contact or token field is exposed.
 *
 * Composition under test (the real production order, see src/index.ts:112 and
 * :150):
 *   createOptionalAuth(repo) -> enforceTenantAuthorityBoundary
 *     -> enforceStudentWorkspaceBoundary -> createTenantSelfRouter(...)
 * Every module is the real production module; only the leaf data/authority
 * repositories are injected fixtures. No express listener is opened, no app is
 * started, no socket or fetch is used.
 *
 * Import isolation (positive proof, not a log assertion):
 *  - `src/db` (dotenv.config + pool creation + config logging),
 *    `src/services/minio` (client construction, network-interface probing) and
 *    `src/services/subscription-renewal` are intercepted in the CommonJS loader
 *    BEFORE any application module is required;
 *  - the interception is recorded per resolved path, so the test proves those
 *    specifiers were actually requested and satisfied by the sentinel;
 *  - `require.cache` must NOT contain the real modules afterwards: if their
 *    bodies had evaluated, Node would have cached them (and db.ts/minio.ts
 *    would have logged/needed credentials);
 *  - MINIO_* stays undefined for the whole run (no dummy-env masking) and every
 *    sentinel call throws, so a forbidden default adapter being reached is a
 *    hard failure rather than a silent no-op;
 *  - the loader hook is restored in `finally`, including when a module throws;
 *  - the same sentinel-call counter is asserted again in the file-level `after`
 *    hook, so a forbidden adapter reached inside a later test (even with the
 *    throw swallowed by the handler's catch) still fails the run.
 *
 * Evidence classes used below:
 *  - behavioral: the real middleware/handler decision (status, body, headers);
 *  - decision-boundary: the exact SQL text/bindings and the exact
 *    (userId, tenantId) authority probes the real handler executed.
 * Live MySQL row-level filtering, real HTTP transport and real providers are
 * explicitly NOT exercised here and are not claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-b01-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    // Whole-suite proof, not just import time: a forbidden default adapter that
    // was reached inside a later test (even one whose throw was caught by the
    // handler's catch block) is recorded here and fails the run.
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
const STAFF_A = 'staff-a';
const ADMIN = 'admin-1';
const STUDENT = 'student-1';
const PLAIN = 'plain-1';
const MULTI = 'multi-1';
const REVOKED_MEMBER = 'revoked-member-1';
const BILLING_ONLY = 'billing-only-1';
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
    failData: boolean;
    failAuthority: boolean;
}

const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(), [STAFF_A]: identity(),
            [ADMIN]: identity(), [STUDENT]: identity(), [PLAIN]: identity(), [MULTI]: identity(),
            [REVOKED_MEMBER]: identity(), [BILLING_ONLY]: identity(), [SUSPENDED]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(), [INSTRUCTOR_A]: activeAccount(),
            [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
            [SUSPENDED]: { tenant_status: 'suspended', legacy_compat: 1, allowed: 1 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [OWNER_B]: [TENANT_B],
            [INSTRUCTOR_A]: [TENANT_A],
            [STAFF_A]: [TENANT_A],
            [MULTI]: [TENANT_A, TENANT_B],
            [REVOKED_MEMBER]: [TENANT_A],
            [BILLING_ONLY]: [TENANT_A],
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: OWNER_B },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${OWNER_B}@${TENANT_B}`]: 'owner',
            [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
            [`${STAFF_A}@${TENANT_A}`]: 'staff',
            [`${BILLING_ONLY}@${TENANT_A}`]: 'instructor',
        },
        enrollments: {
            [STUDENT]: [{ id: 'enrollment-1', user_id: STUDENT, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: 'g-1', grade_id: 'gr-1' }],
        },
        tenants: [
            { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active', legacy_compat: 0, owner_user_id: OWNER_A },
            { id: TENANT_B, business_name: 'Beta Academy', subject_type: null, status: 'active', legacy_compat: 0, owner_user_id: OWNER_B },
        ],
        failData: false,
        failAuthority: false,
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const PROFILE_SQL = 'SELECT t.id,t.business_name,t.subject_type,t.status FROM tenants t WHERE t.id=? LIMIT 1';
const LEGACY_TENANT_SQL = 'SELECT t.id,t.business_name,t.status,t.legacy_compat,t.owner_user_id FROM tenants t WHERE t.id=? LIMIT 1';

function makeDispatch(state: State) {
    return (sql: string, params: any[]): any => {
        const n = squash(sql);
        if (state.failData) throw new Error('ER_LOCK_WAIT_TIMEOUT: internal table tenants leaked');
        if (n.includes(PROFILE_SQL)) {
            const row = state.tenants.find(t => t.id === params[0]);
            return row
                ? [{ id: row.id, business_name: row.business_name, subject_type: row.subject_type, status: row.status }]
                : [];
        }
        if (n.includes(LEGACY_TENANT_SQL)) {
            const row = state.tenants.find(t => t.id === params[0]);
            return row
                ? [{ id: row.id, business_name: row.business_name, status: row.status, legacy_compat: row.legacy_compat, owner_user_id: row.owner_user_id }]
                : [];
        }
        // Only reached by the regression witness on the pre-existing
        // /subscription route; the profile route must never issue it.
        if (n.includes('FROM tenants t LEFT JOIN tenant_subscriptions s')) {
            return [{ tenant_id: params[0], business_name: 'Alpha Academy' }];
        }
        throw new Error(`Unhandled SQL in hermetic fixture: ${n}`);
    };
}

interface Harness {
    chain: RequestHandler[];
    calls: Call[];
    authorityCalls: Array<{ userId: string; tenantId: string }>;
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];
    const authorityCalls: Array<{ userId: string; tenantId: string }> = [];
    const dispatch = makeDispatch(state);

    const db = {
        query: async (sql: string, params?: any[]) => {
            const bound = params ?? [];
            calls.push({ sql, params: bound });
            return dispatch(sql, bound) as any[];
        },
        queryOne: async (sql: string, params?: any[]) => {
            const rows = await db.query(sql, params);
            return rows.length ? rows[0] : null;
        },
        execute: async (sql: string, params?: any[]) => {
            const bound = params ?? [];
            calls.push({ sql, params: bound });
            return dispatch(sql, bound);
        },
        getConnection: async () => { throw new Error('HERMETIC_VIOLATION:db.getConnection'); },
    };

    const repository = {
        findUsersIdentity: async (id: string) => state.users[id] ?? null,
        findStaffIdentity: async () => null,
        findInstructorAccount: async (id: string) => state.instructorAccounts[id] ?? null,
        findStudentEnrollments: async (id: string) => state.enrollments[id] ?? [],
        findActiveTenantMemberships: async (id: string) => (state.memberships[id] ?? []).map(tenant_id => ({ tenant_id })),
    };

    // Server-owned tenant authority, deny-by-default: verified owner row, or an
    // active membership with role_key owner/instructor inside an active tenant.
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

    return { chain, calls, authorityCalls };
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
                // The chain drained without a response: the handler was never reached.
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

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);

    // No dummy credentials were needed to make the import work.
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
// Allow path
// ---------------------------------------------------------------------------

test('profile: owner of the server-selected tenant gets exactly the four-field DTO with no-store', async () => {
    const state = makeState();
    const { chain, calls, authorityCalls } = buildHarness(state);
    const res = await runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor') }));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
        tenant: { id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active' },
    });
    assert.deepEqual(Object.keys(res.body), ['tenant']);
    assert.deepEqual(Object.keys(res.body.tenant), DTO_KEYS);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    assert.deepEqual(authorityCalls, [{ userId: OWNER_A, tenantId: TENANT_A }], 'authority is probed for the selected tenant only');
    assert.equal(calls.length, 1, 'the profile read is a single statement');
    assert.equal(squash(calls[0].sql), PROFILE_SQL);
    assert.deepEqual(calls[0].params, [TENANT_A]);
    for (const forbiddenColumn of ['legacy_compat', 'owner_user_id', 'owner_name', 'phone', 'email', 'billing']) {
        assert.ok(!squash(calls[0].sql).includes(forbiddenColumn), `the profile projection must not select ${forbiddenColumn}`);
    }
});

test('profile: an active instructor membership reads the same selected tenant', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor') }));

    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.id, TENANT_A);
    assert.deepEqual(authorityCalls, [{ userId: INSTRUCTOR_A, tenantId: TENANT_A }]);
    assert.deepEqual(calls.map(c => squash(c.sql)), [PROFILE_SQL]);
});

test('profile: a null subject_type stays null instead of being dropped or defaulted', async () => {
    const { chain } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(OWNER_B, 'instructor') }));

    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.id, TENANT_B);
    assert.equal(res.body.tenant.subject_type, null);
    assert.deepEqual(Object.keys(res.body.tenant), DTO_KEYS);
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

// ---------------------------------------------------------------------------
// Selection / membership denials (no fallback)
// ---------------------------------------------------------------------------

test('profile: a forged tenant selection is denied without falling back to the real membership', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    // owner-a is only a member of tenant-a but asks for tenant-b.
    const res = await runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor', { tenant_id: TENANT_B }) }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'the own 404 must not be cacheable');
    assert.deepEqual(authorityCalls, [], 'a claim that matches no active membership must not reach authority resolution');
    assert.deepEqual(calls, [], 'no tenant row may be read for a forged selection');
});

test('profile: multiple memberships without a selection are ambiguous and denied', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(MULTI, 'teacher') }));

    assert.equal(res.status, 404);
    assert.deepEqual(authorityCalls, []);
    assert.deepEqual(calls, []);
});

test('profile: a membership that no longer resolves is denied instead of widening scope', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    // The token still selects tenant-b, but the server only lists tenant-a now.
    const res = await runChain(chain, makeReq({ token: sign(REVOKED_MEMBER, 'teacher', { tenant_id: TENANT_B }) }));

    assert.equal(res.status, 404);
    assert.deepEqual(authorityCalls, []);
    assert.deepEqual(calls, []);
});

test('profile: a supported role alone grants no tenant authority', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    // staff-a is an active member of tenant-a with role_key staff: authenticated, but no teaching/owner authority.
    const res = await runChain(chain, makeReq({ token: sign(STAFF_A, 'teacher') }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'the no-authority 404 must not be cacheable');
    assert.deepEqual(authorityCalls, [{ userId: STAFF_A, tenantId: TENANT_A }]);
    assert.deepEqual(calls, [], 'no tenant row may be read without server-owned authority');
});

// ---------------------------------------------------------------------------
// Authentication outcomes (real middleware)
// ---------------------------------------------------------------------------

test('auth: an unsupported JWT role fails 401 before any tenant resolution', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(OWNER_A, 'owner') }));

    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Invalid token' });
    assert.deepEqual(calls, []);
    assert.deepEqual(authorityCalls, []);
});

test('auth: invalid, expired and revoked sessions fail 401 with no data access', async () => {
    // Each harness is kept so the "no data access" claim is asserted on the
    // harnesses that actually served these requests, not on a fresh one.
    const harnesses: Harness[] = [];
    const run = async (state: State, req: any) => {
        const harness = buildHarness(state);
        harnesses.push(harness);
        return runChain(harness.chain, req);
    };

    const invalid = await run(makeState(), makeReq({ token: 'not-a-jwt' }));
    assert.equal(invalid.status, 401);
    assert.deepEqual(invalid.body, { error: 'Invalid token' });

    const missing = await run(makeState(), makeReq({ token: null }));
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, { error: 'No token provided' });

    const expired = await run(makeState(), makeReq({ token: sign(OWNER_A, 'instructor', {}, { expiresIn: -10 }) }));
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.body, { error: 'Token expired', code: 'TOKEN_EXPIRED' });

    const revokedState = makeState();
    revokedState.users[OWNER_A] = { ...revokedState.users[OWNER_A], token_version: 7 };
    const revoked = await run(revokedState, makeReq({ token: sign(OWNER_A, 'instructor') }));
    assert.equal(revoked.status, 401);
    assert.deepEqual(revoked.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });

    const inactiveState = makeState();
    inactiveState.users[OWNER_A] = { ...inactiveState.users[OWNER_A], is_active: 0 };
    const inactive = await run(inactiveState, makeReq({ token: sign(OWNER_A, 'instructor') }));
    assert.equal(inactive.status, 401);
    assert.deepEqual(inactive.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });

    assert.equal(harnesses.length, 5);
    for (const harness of harnesses) {
        assert.deepEqual(harness.calls, [], 'a rejected session must not read tenant data');
        assert.deepEqual(harness.authorityCalls, [], 'a rejected session must not reach authority resolution');
    }
});

test('auth: an administratively suspended instructor account keeps the existing 403 TENANT_SUSPENDED', async () => {
    const { chain, calls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(SUSPENDED, 'instructor') }));

    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' });
    assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Principal classes without a tenant scope
// ---------------------------------------------------------------------------

test('profile: an admin principal carries no tenant scope and gets 404', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(ADMIN, 'admin') }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'the admin 404 must not be cacheable');
    assert.deepEqual(authorityCalls, []);
    assert.deepEqual(calls, []);
});

test('profile: a student without a selected workspace is rejected 409 at the boundary before the handler', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(STUDENT, 'student') }));

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'Select an instructor workspace first', code: 'STUDENT_SPACE_REQUIRED' });
    assert.deepEqual(authorityCalls, []);
    assert.deepEqual(calls, []);
});

test('profile: a student with a selected workspace but no tenant authority gets 404', async () => {
    const { chain, calls, authorityCalls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(STUDENT, 'student', { student_enrollment_id: 'enrollment-1' }) }));

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Tenant membership not found' });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'the student no-authority 404 must not be cacheable');
    assert.deepEqual(authorityCalls, [{ userId: STUDENT, tenantId: TENANT_A }]);
    assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Billing-only policy is preserved, not widened
// ---------------------------------------------------------------------------

test('profile: a billing-only instructor keeps the existing limited profile access', async () => {
    const { chain, calls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(BILLING_ONLY, 'instructor') }));

    assert.equal(res.status, 200, '/api/tenants/me is an existing billing-only path and stays reachable');
    assert.deepEqual(Object.keys(res.body.tenant), DTO_KEYS, 'the limited profile exposes no billing or subscription field');
    assert.deepEqual(calls.map(c => squash(c.sql)), [PROFILE_SQL]);
});

// ---------------------------------------------------------------------------
// Global selector boundary (real composed order, handler never reached)
// ---------------------------------------------------------------------------

test('boundary: spoofed or nested tenant selectors are rejected 400 before the handler', async () => {
    const cases: Array<{ label: string; req: () => any }> = [
        { label: 'x-tenant-id header', req: () => makeReq({ token: sign(OWNER_A, 'instructor'), headers: { 'x-tenant-id': TENANT_B } }) },
        { label: 'x-instructor-id header', req: () => makeReq({ token: sign(OWNER_A, 'instructor'), headers: { 'x-instructor-id': OWNER_B } }) },
        { label: 'query tenant_id', req: () => makeReq({ token: sign(OWNER_A, 'instructor'), query: { tenant_id: TENANT_B } }) },
        { label: 'query tenantId', req: () => makeReq({ token: sign(OWNER_A, 'instructor'), query: { tenantId: TENANT_B } }) },
        { label: 'nested body selector', req: () => makeReq({ token: sign(OWNER_A, 'instructor'), body: { filters: { tenantId: TENANT_B } } }) },
    ];

    for (const testCase of cases) {
        const { chain, calls, authorityCalls } = buildHarness(makeState());
        const res = await runChain(chain, testCase.req());

        assert.equal(res.status, 400, `${testCase.label} must be rejected`);
        assert.equal(res.handlerReached, true, 'the boundary answered the request itself');
        assert.deepEqual(calls, [], `${testCase.label} must not reach any SQL`);
        assert.deepEqual(authorityCalls, [], `${testCase.label} must not reach authority resolution`);
    }
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('profile: a data-access failure returns 500 without leaking internal detail', async () => {
    const state = makeState();
    state.failData = true;
    const { chain } = buildHarness(state);

    const res = await withSilencedErrors(() => runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor') })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to load tenant profile' });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'the data-failure 500 must not be cacheable');
    assert.ok(!JSON.stringify(res.body).includes('ER_LOCK'), 'driver/SQL detail must not reach the client');
    assert.ok(!JSON.stringify(res.body).includes('tenants'), 'internal table names must not reach the client');
});

test('profile: an authority-lookup failure returns 500 without leaking internal detail', async () => {
    const state = makeState();
    state.failAuthority = true;
    const { chain } = buildHarness(state);

    const res = await withSilencedErrors(() => runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor') })));

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Failed to load tenant profile' });
    assert.equal(res.headers['Cache-Control'], 'no-store', 'the authority-failure 500 must not be cacheable');
    assert.ok(!JSON.stringify(res.body).includes('authority'), 'internal failure detail must not reach the client');
});

// ---------------------------------------------------------------------------
// Cache contract: no-store on every outcome this handler produces
// (supervisor/099 correction — 200, own 404, data 500 and authority 500)
// ---------------------------------------------------------------------------

test('cache contract: 200, own 404, data 500 and authority 500 all carry no-store', async () => {
    const outcomes: Array<{ label: string; expected: number; run: () => Promise<Result> }> = [
        {
            label: '200 selected tenant',
            expected: 200,
            run: () => runChain(buildHarness(makeState()).chain, makeReq({ token: sign(OWNER_A, 'instructor') })),
        },
        {
            label: 'own 404 unselected workspace',
            expected: 404,
            run: () => runChain(buildHarness(makeState()).chain, makeReq({ token: sign(MULTI, 'teacher') })),
        },
        {
            label: 'own 404 no server-owned authority',
            expected: 404,
            run: () => runChain(buildHarness(makeState()).chain, makeReq({ token: sign(STAFF_A, 'teacher') })),
        },
        {
            label: 'data 500',
            expected: 500,
            run: () => {
                const state = makeState();
                state.failData = true;
                return withSilencedErrors(() => runChain(buildHarness(state).chain, makeReq({ token: sign(OWNER_A, 'instructor') })));
            },
        },
        {
            label: 'authority 500',
            expected: 500,
            run: () => {
                const state = makeState();
                state.failAuthority = true;
                return withSilencedErrors(() => runChain(buildHarness(state).chain, makeReq({ token: sign(OWNER_A, 'instructor') })));
            },
        },
    ];

    for (const outcome of outcomes) {
        const res = await outcome.run();
        assert.equal(res.status, outcome.expected, `${outcome.label}: unexpected status`);
        assert.equal(res.handlerReached, true, `${outcome.label}: the production handler must have answered`);
        assert.equal(
            res.headers['Cache-Control'],
            'no-store',
            `${outcome.label}: every handler outcome must be non-cacheable, not just success`,
        );
    }
});

// ---------------------------------------------------------------------------
// Regression witness: the pre-existing projection is byte-identical
// ---------------------------------------------------------------------------

test('regression: the existing tenant projection used by billing routes is unchanged', async () => {
    const { chain, calls } = buildHarness(makeState());
    const res = await runChain(chain, makeReq({ token: sign(OWNER_A, 'instructor'), pathName: '/subscription' }));

    assert.equal(res.status, 200);
    assert.equal(squash(calls[0].sql), LEGACY_TENANT_SQL, 'the legacy projection text must stay byte-identical for existing suites');
    assert.deepEqual(calls[0].params, [TENANT_A]);
    assert.ok(!squash(calls[0].sql).includes('subject_type'), 'the legacy projection is intentionally untouched');
});
