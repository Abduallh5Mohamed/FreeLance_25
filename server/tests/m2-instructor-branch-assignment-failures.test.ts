/**
 * M2-B12 — private instructor branch-assignment: failure, denial, disposal and
 * uncertain-commit behavior (hermetic, behavioral).
 *
 * This suite drives the REAL `createTenantSelfRouter` handlers through the REAL
 * authentication and boundary middleware and injects only leaf data fixtures
 * and a failure-injecting transactional connection. It exists to prove the
 * properties a happy-path suite cannot:
 *
 *  - every strict rejection happens BEFORE a connection is taken;
 *  - every denial and every failure leaves ZERO partial writes, because the
 *    fake transaction buffers the column write and the audit and applies them
 *    only at COMMIT;
 *  - a confirmed rollback (or a read path) releases the connection exactly
 *    once; a failed rollback, a failed `beginTransaction` or an UNCERTAIN commit
 *    destroys it instead and never claims a rollback happened;
 *  - a failed acquisition has nothing to dispose of;
 *  - a throwing `release`/`destroy` is swallowed and cannot change the answer;
 *  - every 500 body is opaque: no thrown message, table name, column name or
 *    stack frame reaches the client.
 *
 * No express listener, socket, fetch, DB, provider or app startup. Live MySQL
 * row-level locking, real concurrency and real HTTP transport are explicitly
 * NOT exercised or claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-b12-failures-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

const originalLoad = (Module as any)._load;

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called by any test in this suite');
});

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

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
    (Module as any)._load = originalLoad;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OWNER_A = 'owner-a';
const INSTRUCTOR_A = 'instructor-a';
const INSTRUCTOR_A2 = 'instructor-a2';

const BRANCH_A1 = 'a0000000-0000-4000-8000-000000000001';
const BRANCH_A2 = 'a0000000-0000-4000-8000-000000000002';
const BRANCH_A3 = 'a0000000-0000-4000-8000-000000000003';

const MEMBER_A1 = 'a1111111-1111-4111-8111-111111111111';
const MEMBER_A2 = 'a2222222-2222-4222-8222-222222222222';

const FAILURE_BODY = { error: 'Failed to assign instructor branch' };
const LIST_FAILURE_BODY = { error: 'Failed to list instructor memberships' };

interface MembershipRow {
    id: string;
    tenant_id: string;
    user_id: string;
    role_key: string;
    status: string;
    branch_id: string | null;
}

interface BranchRow { id: string; tenant_id: string; name: string; status: string }

interface State {
    users: Record<string, { is_active: number }>;
    membershipsByUser: Record<string, string[]>;
    tenantOwner: Record<string, string>;
    membershipRole: Record<string, string>;
    branches: BranchRow[];
    memberships: MembershipRow[];
    // failure injection
    failAcquire: boolean;
    failBegin: boolean;
    failOwnerSelect: boolean;
    failMembershipLock: boolean;
    failBranchLock: boolean;
    failUpdate: boolean;
    failAudit: boolean;
    failReadBack: boolean;
    emptyReadBack: boolean;
    failCommit: boolean;
    failRollback: boolean;
    failRelease: boolean;
    failDestroy: boolean;
    affectedRowsOverride: number | null;
}

function makeState(): State {
    return {
        users: {
            [OWNER_A]: { is_active: 1 },
            [INSTRUCTOR_A]: { is_active: 1 },
            [INSTRUCTOR_A2]: { is_active: 1 },
        },
        membershipsByUser: {
            [OWNER_A]: [TENANT_A],
            [INSTRUCTOR_A]: [TENANT_A],
            [INSTRUCTOR_A2]: [TENANT_A],
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: 'owner-b' },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
            [`${INSTRUCTOR_A2}@${TENANT_A}`]: 'instructor',
        },
        branches: [
            { id: BRANCH_A1, tenant_id: TENANT_A, name: 'North Campus', status: 'active' },
            { id: BRANCH_A2, tenant_id: TENANT_A, name: 'South Campus', status: 'active' },
            { id: BRANCH_A3, tenant_id: TENANT_A, name: 'Archive Campus', status: 'archived' },
        ],
        memberships: [
            { id: MEMBER_A1, tenant_id: TENANT_A, user_id: INSTRUCTOR_A, role_key: 'instructor', status: 'active', branch_id: BRANCH_A1 },
            { id: MEMBER_A2, tenant_id: TENANT_A, user_id: INSTRUCTOR_A2, role_key: 'instructor', status: 'active', branch_id: null },
        ],
        failAcquire: false,
        failBegin: false,
        failOwnerSelect: false,
        failMembershipLock: false,
        failBranchLock: false,
        failUpdate: false,
        failAudit: false,
        failReadBack: false,
        emptyReadBack: false,
        failCommit: false,
        failRollback: false,
        failRelease: false,
        failDestroy: false,
        affectedRowsOverride: null,
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const OWNER_SELECT = 'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';
const OWNER_LOCK_SELECT = `${OWNER_SELECT} FOR UPDATE`;
const LIST_SQL = "SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS branch_name FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id WHERE m.tenant_id=? AND m.role_key=? AND m.status='active' AND u.is_active=1 AND m.id>? ORDER BY m.id ASC LIMIT ?";
const MEMBERSHIP_LOCK_SQL = "SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS current_branch_name FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id WHERE m.id=? AND m.tenant_id=? AND m.role_key=? AND m.status='active' AND u.is_active=1 FOR UPDATE";
const BRANCH_LOCK_SQL = "SELECT b.id,b.name FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? AND b.status='active' FOR UPDATE";
const MEMBERSHIP_UPDATE_SQL = 'UPDATE tenant_memberships SET branch_id=? WHERE id=? AND tenant_id=?';
const MEMBERSHIP_READ_SQL = 'SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS branch_name FROM tenant_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id WHERE m.id=? AND m.tenant_id=? LIMIT 1';
const AUDIT_SQL = 'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

const displayName = (userId: string) => `Instructor ${userId}`;

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

    let pendingWrite: { membershipId: string; branchId: string | null } | null = null;
    let pendingAudit: Call | null = null;

    const membershipRow = (id: string, tenantId: string) =>
        state.memberships.find(m => m.id === id && m.tenant_id === tenantId) ?? null;
    const branchRow = (id: string, tenantId: string) =>
        state.branches.find(b => b.id === id && b.tenant_id === tenantId) ?? null;
    const visibleBranchId = (row: MembershipRow): string | null =>
        pendingWrite && pendingWrite.membershipId === row.id ? pendingWrite.branchId : row.branch_id;

    const projection = (row: MembershipRow, branchNameKey: 'branch_name' | 'current_branch_name') => {
        const effective = visibleBranchId(row);
        const branch = effective ? branchRow(effective, row.tenant_id) : null;
        return {
            membership_id: row.id,
            instructor_id: row.user_id,
            instructor_name: displayName(row.user_id),
            branch_id: effective,
            [branchNameKey]: branch ? branch.name : null,
        };
    };

    const branchSql = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === OWNER_SELECT || n === OWNER_LOCK_SELECT) {
            events.push('owner');
            if (state.failOwnerSelect) throw new Error('owner verification failed: internal detail leaked');
            const user = state.users[params[0]];
            if (!user) return [[], []];
            return [[{ owner_user_id: OWNER_A, tenant_status: 'active', caller_active: user.is_active }], []];
        }

        if (n === LIST_SQL) {
            events.push('list');
            const [tenantId, roleKey, afterId, limit] = params;
            const rows = state.memberships
                .filter(m => m.tenant_id === tenantId && m.role_key === roleKey && m.status === 'active'
                    && state.users[m.user_id]?.is_active === 1 && m.id > afterId)
                .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
                .slice(0, Number(limit))
                .map(m => projection(m, 'branch_name'));
            return [rows, []];
        }

        if (n === MEMBERSHIP_LOCK_SQL) {
            events.push('membership-lock');
            if (state.failMembershipLock) throw new Error('membership lock failed: internal detail leaked');
            const row = membershipRow(String(params[0]), String(params[1]));
            if (!row || row.role_key !== params[2] || row.status !== 'active') return [[], []];
            if (state.users[row.user_id]?.is_active !== 1) return [[], []];
            return [[projection(row, 'current_branch_name')], []];
        }

        if (n === BRANCH_LOCK_SQL) {
            events.push('branch-lock');
            if (state.failBranchLock) throw new Error('branch lock failed: internal detail leaked');
            const row = branchRow(String(params[0]), String(params[1]));
            if (!row || row.status !== 'active') return [[], []];
            return [[{ id: row.id, name: row.name }], []];
        }

        if (n === MEMBERSHIP_UPDATE_SQL) {
            events.push('update');
            if (state.failUpdate) throw new Error('ER_LOCK_DEADLOCK: update on tenant_memberships failed');
            const [branchId, membershipId] = params;
            pendingWrite = { membershipId: String(membershipId), branchId: branchId === null ? null : String(branchId) };
            const affected = state.affectedRowsOverride ?? 1;
            return [{ affectedRows: affected }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            pendingAudit = { sql, params };
            return [{ affectedRows: 1 }, []];
        }

        if (n === MEMBERSHIP_READ_SQL) {
            events.push('read');
            if (state.failReadBack) throw new Error('read-back failed: internal detail leaked');
            if (state.emptyReadBack) return [[], []];
            const row = membershipRow(String(params[0]), String(params[1]));
            if (!row) return [[], []];
            return [[projection(row, 'branch_name')], []];
        }

        throw new Error(`Unhandled instructor branch SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        pendingWrite = null;
        pendingAudit = null;
        return {
            beginTransaction: async () => {
                events.push('begin');
                if (state.failBegin) throw new Error('begin failed: internal detail leaked');
            },
            execute: branchSql,
            commit: async () => {
                events.push('commit');
                // A failed commit acknowledgement is applied NOWHERE: the write
                // stays unknown, which is exactly what the handler must assume.
                if (state.failCommit) throw new Error('commit acknowledgement lost: internal detail leaked');
                if (pendingWrite) {
                    const row = state.memberships.find(m => m.id === pendingWrite!.membershipId);
                    if (row) row.branch_id = pendingWrite.branchId;
                }
                if (pendingAudit) auditRows.push(pendingAudit);
                pendingWrite = null;
                pendingAudit = null;
            },
            rollback: async () => {
                events.push('rollback');
                pendingWrite = null;
                pendingAudit = null;
                if (state.failRollback) throw new Error('rollback failed: internal detail leaked');
            },
            release: () => {
                events.push('release');
                releaseCount += 1;
                if (state.failRelease) throw new Error('release failed: internal detail leaked');
            },
            destroy: () => {
                events.push('destroy');
                destroyCount += 1;
                if (state.failDestroy) throw new Error('destroy failed: internal detail leaked');
            },
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
        findUsersIdentity: async (id: string) => state.users[id] ? { is_active: state.users[id].is_active, token_version: 0, suspension_active: 0 } : null,
        findStaffIdentity: async () => null,
        findInstructorAccount: async () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 }),
        findStudentEnrollments: async () => [],
        findActiveTenantMemberships: async (id: string) => (state.membershipsByUser[id] ?? []).map(tenant_id => ({ tenant_id })),
    };

    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        if (state.tenantOwner[tenantId] === userId) return { authority: 'owner' };
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

function makeReq(opts: { token?: string | null; method?: string; pathName?: string; query?: any; body?: any } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const pathName = opts.pathName ?? '/instructor-memberships';
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

const sign = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m' });

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

const ownerToken = () => sign(OWNER_A, 'instructor');
const assignReq = (membershipId: string, body: any, token = ownerToken()) =>
    makeReq({ token, method: 'PATCH', pathName: `/instructor-memberships/${membershipId}`, body });
const listReq = (query: any = {}, token = ownerToken()) =>
    makeReq({ token, method: 'GET', pathName: '/instructor-memberships', query });

const storedBranchId = (state: State, membershipId: string) =>
    state.memberships.find(m => m.id === membershipId)?.branch_id ?? null;

/** Runs one assign with exactly one failure flag raised. */
const runFailing = async (flag: keyof State, membershipId = MEMBER_A2, branchId: string | null = BRANCH_A2) => {
    const state = makeState();
    (state as any)[flag] = flag === 'affectedRowsOverride' ? 0 : true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, assignReq(membershipId, { branch_id: branchId })));
    return { state, harness, result };
};

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
// Strict selectors — rejected before any connection
// ---------------------------------------------------------------------------

test('selector: every non-UUID membership id is rejected before any connection', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    const shapes = [
        'not-a-uuid',
        'a1111111-1111-4111-8111',
        'a1111111-1111-4111-8111-11111111111g',
        'a1111111-1111-4111-8111-1111111111111',
        '  a1111111-1111-4111-8111-111111111111',
        'a11111111111141118111111111111111',
    ];
    for (const shape of shapes) {
        const res = await runChain(harness.chain, assignReq(shape, { branch_id: BRANCH_A2 }));
        assert.equal(res.status, 400, `membership id ${JSON.stringify(shape)} must be rejected`);
        assert.deepEqual(res.body, { error: 'Invalid membership id' });
        assert.equal(res.headers['Cache-Control'], 'no-store');
    }
    assert.equal(harness.connectionCount(), 0, 'no connection is taken for a malformed selector');

    // An empty id does not match the `/instructor-memberships/:membershipId`
    // route at all, so it can never reach a handler and can never be answered
    // as if it were a real membership.
    const empty = await runChain(harness.chain, assignReq('', { branch_id: BRANCH_A2 }));
    assert.equal(empty.handlerReached, false);
    assert.equal(harness.connectionCount(), 0);
});

test('payload: every malformed body is rejected before any connection', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    const bodies: any[] = [
        null,
        undefined,
        'branch_id',
        42,
        [],
        [BRANCH_A2],
        {},
        { branch_id: undefined },
        { branch_id: 42 },
        { branch_id: true },
        { branch_id: {} },
        { branch_id: [] },
        { branch_id: '' },
        { branch_id: 'not-a-uuid' },
        { branch_id: 'a1111111-1111-4111-8111-11111111111g' },
        { branch_id: BRANCH_A2, membership_id: MEMBER_A2 },
        { branchId: BRANCH_A2 },
        { branch_id: BRANCH_A2, extra: 1 },
    ];
    for (const body of bodies) {
        const res = await runChain(harness.chain, assignReq(MEMBER_A2, body));
        assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected`);
        assert.deepEqual(res.body, { error: 'Invalid instructor branch assignment payload' });
    }
    assert.equal(harness.connectionCount(), 0, 'no connection is taken for a malformed payload');
    assert.equal(storedBranchId(state, MEMBER_A2), null);

    // A client-supplied TENANT selector never reaches this handler at all: the
    // shared tenant-authority boundary refuses it upstream, so the route can
    // never be used to place a record in another tenant.
    const tenantSelector = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2, tenant_id: TENANT_B }));
    assert.equal(tenantSelector.status, 400);
    assert.deepEqual(tenantSelector.body, { error: 'Tenant context must not be supplied by the client' });
    assert.equal(harness.connectionCount(), 0);
});

test('payload: the two documented values — a UUID and an explicit null — are the only accepted ones', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    const assign = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 }));
    assert.equal(assign.status, 200);

    const clear = await runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: null }));
    assert.equal(clear.status, 200);
    assert.equal(clear.body.membership.branch_id, null);

    // The assignment payload can never carry a second field, so a client can
    // never smuggle a role, a status or a tenant selector through this route.
    const updateCalls = harness.calls.filter(c => squash(c.sql) === MEMBERSHIP_UPDATE_SQL);
    assert.equal(updateCalls.length, 2);
    for (const call of updateCalls) {
        assert.equal(call.params.length, 3, 'branch_id, membership id and the selected tenant only');
    }
});

// ---------------------------------------------------------------------------
// Failure and disposal paths
// ---------------------------------------------------------------------------

test('acquire failure: the handler answers an opaque 500 and disposes nothing', async () => {
    const { harness, result, state } = await runFailing('failAcquire');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
    assert.deepEqual(harness.events, []);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
});

test('begin failure: the connection is destroyed, never released, and no rollback is claimed', async () => {
    const { harness, result, state } = await runFailing('failBegin');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('owner verification failure: rollback then a single release, zero writes', async () => {
    const { harness, result, state } = await runFailing('failOwnerSelect');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.destroyCount(), 0);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('membership lock failure: rollback then a single release, zero writes', async () => {
    const { harness, result, state } = await runFailing('failMembershipLock');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'owner', 'membership-lock', 'rollback', 'release']);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
});

test('branch lock failure: rollback then a single release, zero writes', async () => {
    const { harness, result, state } = await runFailing('failBranchLock');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'owner', 'membership-lock', 'branch-lock', 'rollback', 'release']);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('update failure: rollback then a single release, zero writes and zero audits', async () => {
    const { harness, result, state } = await runFailing('failUpdate');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'owner', 'membership-lock', 'branch-lock', 'update', 'rollback', 'release']);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('audit failure: the write is rolled back, so no partial write survives', async () => {
    const { harness, result, state } = await runFailing('failAudit');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, [
        'begin', 'owner', 'membership-lock', 'branch-lock', 'update', 'audit', 'rollback', 'release',
    ]);
    assert.equal(
        storedBranchId(state, MEMBER_A2),
        null,
        'a write whose audit failed must leave the column untouched',
    );
    assert.equal(harness.auditRows.length, 0);
    assert.equal(harness.destroyCount(), 0);
});

test('read-back failure: the transaction is rolled back and nothing is written', async () => {
    const { harness, result, state } = await runFailing('failReadBack');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(harness.events.includes('rollback'), true);
    assert.equal(harness.events.includes('commit'), false, 'an unreadable write is never committed');
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
    assert.equal(harness.releaseCount(), 1);
});

test('empty read-back: an unverifiable write is refused with the opaque 500', async () => {
    const { harness, result, state } = await runFailing('emptyReadBack');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(harness.events.includes('commit'), false);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('concurrent modification: affectedRows 0 answers 409, rolls back and audits nothing', async () => {
    const { harness, result, state } = await runFailing('affectedRowsOverride');

    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { error: 'Instructor membership was modified concurrently' });
    assert.deepEqual(harness.events, [
        'begin', 'owner', 'membership-lock', 'branch-lock', 'update', 'rollback', 'release',
    ]);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
    assert.equal(harness.auditRows.length, 0);
});

test('uncertain commit: the connection is destroyed, never released, and no rollback is claimed', async () => {
    const { harness, result, state } = await runFailing('failCommit');

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events, [
        'begin', 'owner', 'membership-lock', 'branch-lock', 'update', 'audit', 'read', 'commit', 'destroy',
    ]);
    assert.equal(harness.events.includes('rollback'), false, 'an uncertain commit must never claim a rollback');
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(
        storedBranchId(state, MEMBER_A2),
        null,
        'the fixture models an unacknowledged commit: the client must treat the outcome as unknown',
    );
    assert.equal(harness.auditRows.length, 0);
});

test('failed rollback: the connection is destroyed instead of being recycled', async () => {
    const state = makeState();
    state.failAudit = true;
    state.failRollback = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 })));

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.deepEqual(harness.events.slice(-2), ['rollback', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(storedBranchId(state, MEMBER_A2), null);
});

test('a throwing release is swallowed and cannot change the answer', async () => {
    const state = makeState();
    state.failRelease = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 })));

    assert.equal(result.status, 200);
    assert.equal(result.body.membership.branch_id, BRANCH_A2);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
    assert.equal(result.responseCount, 1);
});

test('a throwing destroy is swallowed and cannot change the answer', async () => {
    const state = makeState();
    state.failCommit = true;
    state.failDestroy = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, assignReq(MEMBER_A2, { branch_id: BRANCH_A2 })));

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(result.responseCount, 1);
});

test('every write failure answers the same opaque body with no internal detail', async () => {
    const flags: Array<keyof State> = [
        'failAcquire', 'failBegin', 'failOwnerSelect', 'failMembershipLock',
        'failBranchLock', 'failUpdate', 'failAudit', 'failReadBack',
        'emptyReadBack', 'failCommit',
    ];
    for (const flag of flags) {
        const { result } = await runFailing(flag);
        assert.equal(result.status, 500, `${flag} must answer 500`);
        assert.deepEqual(result.body, FAILURE_BODY, `${flag} must not leak an internal detail`);
        const text = JSON.stringify(result.body);
        for (const forbidden of ['leaked', 'tenant_memberships', 'audit_events', 'tenant_branches', 'ER_', 'stack']) {
            assert.equal(text.includes(forbidden), false, `${flag} must not leak "${forbidden}"`);
        }
    }
});

test('no failing path leaves a partial write behind', async () => {
    const flags: Array<keyof State> = [
        'failBegin', 'failOwnerSelect', 'failMembershipLock', 'failBranchLock',
        'failUpdate', 'failAudit', 'failReadBack', 'emptyReadBack', 'affectedRowsOverride', 'failCommit',
    ];
    for (const flag of flags) {
        const { state, harness } = await runFailing(flag);
        assert.equal(
            storedBranchId(state, MEMBER_A2),
            null,
            `${flag} must leave the stored column untouched`,
        );
        assert.equal(harness.auditRows.length, 0, `${flag} must commit no audit event`);
        // Exactly one disposal per attempt, whichever kind it was.
        assert.equal(
            harness.releaseCount() + harness.destroyCount(),
            flag === 'failBegin' || flag === 'failCommit' ? 1 : 1,
            `${flag} must dispose of the connection exactly once`,
        );
    }
});

test('a clearing write that fails also leaves the stored record untouched', async () => {
    for (const flag of ['failUpdate', 'failAudit', 'failCommit'] as Array<keyof State>) {
        const { state, harness } = await runFailing(flag, MEMBER_A1, null);
        assert.equal(
            storedBranchId(state, MEMBER_A1),
            BRANCH_A1,
            `${flag} must not clear a record whose transaction did not commit`,
        );
        assert.equal(harness.auditRows.length, 0);
    }
});

// ---------------------------------------------------------------------------
// List failures
// ---------------------------------------------------------------------------

test('list: an owner verification failure answers the opaque list 500 and writes nothing', async () => {
    const state = makeState();
    state.failOwnerSelect = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, listReq()));

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, LIST_FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.destroyCount(), 0);
});

test('list: a page failure answers the opaque list 500, rolls back and releases once', async () => {
    const state = makeState();
    // An unhandled statement is a genuine failure of the read path.
    state.memberships.push({
        id: 'e0000000-0000-4000-8000-000000000000',
        tenant_id: TENANT_B, user_id: INSTRUCTOR_A2, role_key: 'instructor', status: 'active', branch_id: null,
    });
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, listReq({ limit: '0' })));

    // A malformed limit is rejected before any connection, so this is a 400.
    assert.equal(result.status, 400);
    assert.equal(harness.connectionCount(), 0);

    // A real read-path failure: the fixture throws on an unanswerable statement.
    const brokenState = makeState();
    const broken = buildHarness(brokenState);
    const originalExecute = (broken as any).chain;
    assert.ok(originalExecute);
    const failing = await withSilencedErrors(async () => {
        // Force the failure by making the page statement unanswerable.
        (brokenState as any).memberships = null;
        return runChain(broken.chain, listReq());
    });
    assert.equal(failing.status, 500);
    assert.deepEqual(failing.body, LIST_FAILURE_BODY);
    assert.equal(failing.body.error.includes('TypeError'), false);
    assert.equal(broken.destroyCount() + broken.releaseCount(), 1);
});

test('list: a failed rollback destroys the connection instead of recycling it', async () => {
    const state = makeState();
    state.failOwnerSelect = true;
    state.failRollback = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, listReq()));

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, LIST_FAILURE_BODY);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
});

test('list: a begin failure destroys the connection and never releases it', async () => {
    const state = makeState();
    state.failBegin = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, listReq()));

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, LIST_FAILURE_BODY);
    assert.deepEqual(harness.events, ['begin', 'destroy']);
    assert.equal(harness.releaseCount(), 0);
});

test('list: an acquisition failure disposes nothing and leaks nothing', async () => {
    const state = makeState();
    state.failAcquire = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, listReq()));

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, LIST_FAILURE_BODY);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
});

test('list: a throwing release on the read path is swallowed', async () => {
    const state = makeState();
    state.failRelease = true;
    const harness = buildHarness(state);
    const result = await withSilencedErrors(async () => runChain(harness.chain, listReq()));

    assert.equal(result.status, 200);
    assert.equal(result.body.memberships.length, 2);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(result.responseCount, 1);
});
