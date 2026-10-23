/**
 * M2-18 — private student branch assignment (hermetic, behavioral).
 *
 * Contract under test: PATCH /api/students/:id/branch updates the private
 * branch of ONE student of the tenant the SERVER selected, and only for the
 * VERIFIED owner of that tenant. The body is strictly `{ branch_id }`, where
 * the value is a branch UUID (assign) or `null` (clear). Nothing else is
 * accepted, and nothing else is written.
 *
 * Composition under test is the real production order: the real
 * `optionalAuth`/`authenticateToken` middleware over the real principal
 * resolver, then the real `createStudentsRouter` handler from
 * `src/routes/students.ts`. Only leaf data boundaries are injected fixtures:
 * the `src/db` pool (which supplies the transactional connection) and the
 * `src/security/principal-repository` identity lookups. No express listener,
 * socket, fetch, DB, provider or app startup.
 *
 * Import isolation is proven positively: the `src/db` module body is
 * intercepted in the CommonJS loader before any app module loads, stays out of
 * `require.cache`, needs no dummy env, and is re-checked in `after`.
 *
 * Live MySQL row-level locking, real concurrency, real index usage and real
 * HTTP transport are explicitly NOT exercised or claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-18-hermetic-jwt-secret-not-a-real-key';
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

/**
 * The pool is supplied by the harness below, so the module-level `getPool`
 * import in the route resolves to this fixture and `src/db.ts` (dotenv, pool
 * creation) is never evaluated. `query`/`queryOne`/`execute` are the
 * non-transactional adapters the student-management handlers use; the branch
 * route deliberately does not, so they refuse loudly if it ever does.
 */
const dbSentinel = {
    query: async (): Promise<any> => violation('db.query'),
    queryOne: async (): Promise<any> => violation('db.queryOne'),
    execute: async (): Promise<any> => violation('db.execute'),
    testConnection: async (): Promise<any> => violation('db.testConnection'),
    closePool: async (): Promise<any> => violation('db.closePool'),
    getPool: (): any => poolHolder.pool,
};

/** Replaced by the harness before any request runs. */
const poolHolder: { pool: any } = { pool: null };

/**
 * The principal repository is a leaf data boundary. Replacing it keeps the
 * REAL `optionalAuth`/`authenticateToken`/`resolvePrincipal` code (real JWT
 * verification, real liveness rules, real server-derived tenant selection) and
 * only swaps the SQL lookups for fixtures.
 */
const principalRepository = {
    findUsersIdentity: async (id: string) => identityHolder.users[id] ?? null,
    findStaffIdentity: async (): Promise<any> => null,
    findInstructorAccount: async (id: string) => identityHolder.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id: string) => identityHolder.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id: string) =>
        (identityHolder.memberships[id] ?? []).map((tenant_id) => ({ tenant_id })),
};
const identityHolder: {
    users: Record<string, any>;
    instructorAccounts: Record<string, any>;
    enrollments: Record<string, any[]>;
    memberships: Record<string, string[]>;
} = { users: {}, instructorAccounts: {}, enrollments: {}, memberships: {} };

const principalRepositorySentinel = {
    defaultPrincipalRepository: principalRepository,
};

interface Intercepted { id: string; exports: unknown }
const sentinelByPath = new Map<string, Intercepted>();

const registerSentinel = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    sentinelByPath.set(normalize(id), { id, exports });
};

registerSentinel('../src/db', dbSentinel);
registerSentinel('../src/security/principal-repository', principalRepositorySentinel);

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
let routeModule: any;

installInterception();
try {
    routeModule = require('../src/routes/students');
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
const BILLING_ONLY = 'billing-only-instructor-1';

const STUDENT_A1 = '11111111-1111-4111-8111-111111111111';
const STUDENT_A2 = '22222222-2222-4222-8222-222222222222';
const STUDENT_B1 = '88888888-8888-4888-8888-888888888888';
const BRANCH_A1 = 'a0000000-0000-4000-8000-000000000001';
const BRANCH_A2 = 'a0000000-0000-4000-8000-000000000002';
const BRANCH_ARCHIVED = 'a0000000-0000-4000-8000-000000000003';
const BRANCH_B1 = 'b0000000-0000-4000-8000-000000000001';
const ABSENT_BRANCH = 'cccccccc-0000-4000-8000-000000000000';

interface StudentRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    name: string;
    phone: string;
    is_active: number;
}

interface BranchRow { id: string; tenant_id: string; name: string; status: string }
interface TenantRow { id: string; owner_user_id: string; status: string }

interface State {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    enrollments: Record<string, any[]>;
    tenants: TenantRow[];
    students: StudentRow[];
    branches: BranchRow[];
    failAcquire: boolean;
    failBegin: boolean;
    failOwnerSelect: boolean;
    failStudentSelect: boolean;
    failBranchSelect: boolean;
    failUpdate: boolean;
    failAudit: boolean;
    failCommit: boolean;
    failRollback: boolean;
    affectedRowsOverride: number | null;
}

const identity = () => ({ is_active: 1, token_version: 0, suspension_active: 0 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(), [BILLING_ONLY]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [OWNER_B]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [INSTRUCTOR_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            // A live instructor whose tenant is neither legacy-compatible nor
            // entitled: the shared middleware marks the principal `billingOnly`
            // and refuses every non-billing path before this handler runs.
            [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [OWNER_B]: [TENANT_B],
            [INSTRUCTOR_A]: [TENANT_A],
            [BILLING_ONLY]: [TENANT_A],
        },
        enrollments: {},
        tenants: [
            { id: TENANT_A, owner_user_id: OWNER_A, status: 'active' },
            { id: TENANT_B, owner_user_id: OWNER_B, status: 'active' },
        ],
        students: [
            { id: STUDENT_A1, tenant_id: TENANT_A, branch_id: null, name: 'Sara Ali', phone: '+201000000001', is_active: 1 },
            { id: STUDENT_A2, tenant_id: TENANT_A, branch_id: BRANCH_A2, name: 'Omar Said', phone: '+201000000002', is_active: 1 },
            // Same id shape, different tenant: a foreign student.
            { id: STUDENT_B1, tenant_id: TENANT_B, branch_id: null, name: 'Foreign', phone: '+201000000003', is_active: 1 },
        ],
        branches: [
            { id: BRANCH_A1, tenant_id: TENANT_A, name: 'North Campus', status: 'active' },
            { id: BRANCH_A2, tenant_id: TENANT_A, name: 'South Campus', status: 'active' },
            { id: BRANCH_ARCHIVED, tenant_id: TENANT_A, name: 'Closed Campus', status: 'archived' },
            { id: BRANCH_B1, tenant_id: TENANT_B, name: 'Foreign Campus', status: 'active' },
        ],
        failAcquire: false,
        failBegin: false,
        failOwnerSelect: false,
        failStudentSelect: false,
        failBranchSelect: false,
        failUpdate: false,
        failAudit: false,
        failCommit: false,
        failRollback: false,
        affectedRowsOverride: null,
    };
}

interface Call { sql: string; params: any[] }
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const OWNER_LOCK_SELECT = 'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE';
const STUDENT_LOCK_SELECT = 'SELECT s.id,s.branch_id FROM students s WHERE s.id=? AND s.tenant_id=? FOR UPDATE';
const BRANCH_LOCK_SELECT = 'SELECT b.id,b.name,b.status FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? FOR UPDATE';
const UPDATE_STUDENT_SQL = 'UPDATE students SET branch_id=? WHERE id=? AND tenant_id=?';
const AUDIT_SQL = 'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

interface Harness {
    chain: RequestHandler[];
    calls: Call[];
    auditRows: Call[];
    events: string[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
    rollbackCount: () => number;
    commitCount: () => number;
}

function buildHarness(state: State): Harness {
    const calls: Call[] = [];
    const auditRows: Call[] = [];
    const events: string[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;
    let rollbackCount = 0;
    let commitCount = 0;

    const studentRow = (id: string, tenantId: string) =>
        state.students.find(s => s.id === id && s.tenant_id === tenantId) ?? null;
    const branchRow = (id: string, tenantId: string) =>
        state.branches.find(b => b.id === id && b.tenant_id === tenantId) ?? null;

    const connectionExecute = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === OWNER_LOCK_SELECT) {
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

        if (n === STUDENT_LOCK_SELECT) {
            events.push('student-select');
            if (state.failStudentSelect) throw new Error('student lock failed: internal detail leaked');
            const row = studentRow(String(params[0]), String(params[1]));
            return [row ? [{ id: row.id, branch_id: row.branch_id }] : [], []];
        }

        if (n === BRANCH_LOCK_SELECT) {
            events.push('branch-select');
            if (state.failBranchSelect) throw new Error('branch lock failed: internal detail leaked');
            const row = branchRow(String(params[0]), String(params[1]));
            return [row ? [{ id: row.id, name: row.name, status: row.status }] : [], []];
        }

        if (n === UPDATE_STUDENT_SQL) {
            events.push('update');
            if (state.failUpdate) throw new Error('ER_LOCK_WAIT_TIMEOUT: update on internal table students failed');
            const [branchId, id, tenantId] = params;
            const affected = state.affectedRowsOverride ?? 1;
            // Buffered, not applied: a real transaction becomes visible only
            // at COMMIT, so a rolled-back write leaves no partial change.
            pendingWrite = {
                id: String(id),
                tenant_id: String(tenantId),
                branch_id: branchId === null ? null : String(branchId),
            };
            return [{ affectedRows: affected }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            pendingAudit.push({ sql, params });
            return [{ affectedRows: 1 }, []];
        }

        throw new Error(`Unhandled student-branch SQL in hermetic fixture: ${n}`);
    };

    /** Writes staged inside the open transaction, applied only at COMMIT. */
    let pendingWrite: { id: string; tenant_id: string; branch_id: string | null } | null = null;
    let pendingAudit: Call[] = [];

    const makeConnection = () => {
        connectionCount += 1;
        pendingWrite = null;
        pendingAudit = [];
        return {
            beginTransaction: async () => {
                events.push('begin');
                if (state.failBegin) throw new Error('begin failed: internal detail leaked');
            },
            execute: connectionExecute,
            commit: async () => {
                events.push('commit');
                commitCount += 1;
                if (state.failCommit) throw new Error('commit acknowledgement lost: internal detail leaked');
                if (pendingWrite) {
                    const row = studentRow(pendingWrite.id, pendingWrite.tenant_id);
                    if (row) row.branch_id = pendingWrite.branch_id;
                }
                for (const row of pendingAudit) auditRows.push(row);
                pendingWrite = null;
                pendingAudit = [];
            },
            rollback: async () => {
                events.push('rollback');
                rollbackCount += 1;
                if (state.failRollback) throw new Error('rollback failed: internal detail leaked');
                pendingWrite = null;
                pendingAudit = [];
            },
            release: () => { events.push('release'); releaseCount += 1; },
            destroy: () => { events.push('destroy'); destroyCount += 1; },
        };
    };

    const pool = {
        getConnection: async () => {
            if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
            return makeConnection();
        },
    };
    poolHolder.pool = pool;

    identityHolder.users = state.users;
    identityHolder.instructorAccounts = state.instructorAccounts;
    identityHolder.enrollments = state.enrollments;
    identityHolder.memberships = state.memberships;

    const chain: RequestHandler[] = [routeModule.default as Router];

    return {
        chain,
        calls,
        auditRows,
        events,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
        rollbackCount: () => rollbackCount,
        commitCount: () => commitCount,
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
    studentId?: string;
    body?: any;
    headers?: Record<string, string>;
}

function makeReq(opts: ReqOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
    const studentId = opts.studentId ?? STUDENT_A1;
    const pathName = opts.pathName ?? `/${studentId}/branch`;
    return {
        method: opts.method ?? 'PATCH',
        url: pathName,
        originalUrl: `/api/students${pathName}`,
        path: pathName,
        headers,
        query: {},
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
            set(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
            setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
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

/**
 * The verified owner signs with a SUPPORTED role. Ownership is never a role
 * label: `resolvePrincipal` only accepts the six supported roles, and the
 * handler re-derives authority from `tenants.owner_user_id` inside the
 * transaction. A token claiming an 'owner' role is an invalid token.
 */
const ownerToken = (extra: Record<string, unknown> = {}) => sign(OWNER_A, 'instructor', { tenant_id: TENANT_A, ...extra });

/** Every test builds its own harness over a fresh state. */
const withState = async <T>(mutate: (state: State) => void, fn: (state: State) => Promise<T>): Promise<T> => {
    const state = makeState();
    mutate(state);
    return fn(state);
};

/**
 * The stored branch of one student of the selected tenant. A row that does not
 * exist at all is reported as `'absent'`, which is deliberately distinct from a
 * stored `null` (a cleared assignment).
 */
const branchOf = (state: State, studentId: string): string | null | 'absent' => {
    const row = state.students.find(s => s.id === studentId && s.tenant_id === TENANT_A);
    return row ? row.branch_id : 'absent';
};

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

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
// PATCH /:id/branch — assign
// ---------------------------------------------------------------------------

test('assign: owner assigns an active same-tenant branch and receives the bounded projection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));

        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body.student).sort(), ['branch_id', 'branch_name', 'student_id']);
        assert.deepEqual(result.body.student, {
            student_id: STUDENT_A1,
            branch_id: BRANCH_A1,
            branch_name: 'North Campus',
        });
        // Exactly one write and exactly one audit event, nothing else.
        assert.equal(branchOf(state, STUDENT_A1), BRANCH_A1);
        assert.equal(harness.auditRows.length, 1);
        assert.equal(harness.auditRows[0].params[3], 'student.branch_assigned');
        assert.equal(harness.auditRows[0].params[4], 'student');
        assert.equal(harness.auditRows[0].params[5], STUDENT_A1);
        assert.equal(harness.auditRows[0].params[6], JSON.stringify({ branch_id: null }));
        assert.equal(harness.auditRows[0].params[7], JSON.stringify({ branch_id: BRANCH_A1 }));
        // The audit actor is the authenticated caller, never a body value.
        assert.equal(harness.auditRows[0].params[1], OWNER_A);
        assert.equal(harness.auditRows[0].params[2], TENANT_A);
        // No student name, phone or any other stored value leaks into the audit.
        const auditText = JSON.stringify(harness.auditRows[0].params);
        assert.equal(auditText.includes('Sara'), false);
        assert.equal(auditText.includes('North Campus'), false);
        assert.equal(auditText.includes('201000000001'), false);
    });
});

test('assign: the write and the audit event are committed together and the connection is released', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));

        assert.equal(result.status, 200);
        assert.deepEqual(harness.events, ['begin', 'owner', 'student-select', 'branch-select', 'update', 'audit', 'commit', 'release']);
        assert.equal(harness.commitCount(), 1);
        assert.equal(harness.rollbackCount(), 0);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(harness.destroyCount(), 0);
        assert.equal(harness.connectionCount(), 1);
    });
});

test('assign: every outcome carries Cache-Control no-store', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));
        assert.equal(result.headers['cache-control'], 'no-store');
    });
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const denied = await runChain(harness.chain, makeReq({ token: sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_A }), body: { branch_id: BRANCH_A1 } }));
        assert.equal(denied.headers['cache-control'], 'no-store');
    });
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const malformed = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: 'not-a-uuid' } }));
        assert.equal(malformed.headers['cache-control'], 'no-store');
    });
});

test('clear: null clears an assignment and reports a null name', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: ownerToken(),
            body: { branch_id: null },
            studentId: STUDENT_A2,
        }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.student, { student_id: STUDENT_A2, branch_id: null, branch_name: null });
        assert.equal(branchOf(state, STUDENT_A2), null);
        assert.equal(harness.auditRows.length, 1);
        assert.equal(harness.auditRows[0].params[3], 'student.branch_cleared');
        assert.equal(harness.auditRows[0].params[6], JSON.stringify({ branch_id: BRANCH_A2 }));
        assert.equal(harness.auditRows[0].params[7], JSON.stringify({ branch_id: null }));
        assert.deepEqual(harness.events, ['begin', 'owner', 'student-select', 'update', 'audit', 'commit', 'release']);
    });
});

test('clear: clearing a student that already has no branch is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: null } }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.student, { student_id: STUDENT_A1, branch_id: null, branch_name: null });
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0, 'an identical clear audits nothing');
        assert.equal(harness.commitCount(), 0, 'an identical clear commits nothing');
        assert.equal(harness.rollbackCount(), 1);
        assert.deepEqual(harness.events, ['begin', 'owner', 'student-select', 'rollback', 'release']);
    });
});

test('retry: assigning the branch the student already has is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: ownerToken(),
            body: { branch_id: BRANCH_A2 },
            studentId: STUDENT_A2,
        }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.student, { student_id: STUDENT_A2, branch_id: BRANCH_A2, branch_name: 'South Campus' });
        assert.equal(branchOf(state, STUDENT_A2), BRANCH_A2);
        assert.equal(harness.auditRows.length, 0, 'an identical retry audits nothing');
        assert.equal(harness.commitCount(), 0, 'an identical retry commits nothing');
        assert.equal(harness.rollbackCount(), 1);
        assert.deepEqual(harness.events, ['begin', 'owner', 'student-select', 'branch-select', 'rollback', 'release']);
    });
});

test('projection: the response never carries a stored student value', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));
        const text = JSON.stringify(result.body);
        assert.equal(text.includes('Sara'), false);
        assert.equal(text.includes('201000000001'), false);
        assert.equal(text.includes('is_active'), false);
        assert.equal(text.includes('tenant'), false);
    });
});

// ---------------------------------------------------------------------------
// PATCH /:id/branch — owner authority is re-resolved inside the transaction
// ---------------------------------------------------------------------------

test('authority: a non-owner member of the same tenant is refused and writes nothing', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_A }),
            body: { branch_id: BRANCH_A1 },
        }));

        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { error: 'Forbidden' });
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0);
        assert.equal(harness.rollbackCount(), 1);
        assert.deepEqual(harness.events, ['begin', 'owner', 'rollback', 'release']);
    });
});

test('authority: a suspended tenant is refused even for its recorded owner', async () => {
    await withState((state) => { state.tenants[0].status = 'suspended'; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));

        assert.equal(result.status, 403);
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
    });
});

test('authority: a deactivated caller never reaches the transaction', async () => {
    await withState((state) => { state.users[OWNER_A].is_active = 0; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));

        // The shared middleware revokes the session first. The handler's own
        // `caller_active` check is defence in depth for a caller deactivated
        // between authentication and the transaction.
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });
        assert.equal(harness.connectionCount(), 0);
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
    });
});

test('authority: a tenant_id claim the caller has no membership for never resolves a tenant', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: ownerToken({ tenant_id: TENANT_B }),
            body: { branch_id: BRANCH_A1 },
        }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Tenant membership not found' });
        assert.equal(harness.connectionCount(), 0, 'no connection is taken without a selected tenant');
        assert.equal(branchOf(state, STUDENT_A1), null);
    });
});

test('authority: a billed-out instructor is refused by the shared middleware before the handler runs', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: sign(BILLING_ONLY, 'instructor', { tenant_id: TENANT_A }),
            body: { branch_id: BRANCH_A1 },
        }));

        assert.equal(result.status, 403);
        assert.equal(result.body.code, 'BILLING_ONLY');
        assert.equal(harness.connectionCount(), 0);
        assert.equal(branchOf(state, STUDENT_A1), null);
    });
});

// ---------------------------------------------------------------------------
// PATCH /:id/branch — tenant isolation of the target
// ---------------------------------------------------------------------------

test('isolation: a student of another tenant is indistinguishable from a missing one', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const foreign = await runChain(harness.chain, makeReq({
            token: ownerToken(),
            body: { branch_id: BRANCH_A1 },
            studentId: STUDENT_B1,
        }));
        const absent = await runChain(harness.chain, makeReq({
            token: ownerToken(),
            body: { branch_id: BRANCH_A1 },
            studentId: '77777777-7777-4777-8777-777777777777',
        }));

        assert.equal(foreign.status, 404);
        assert.equal(absent.status, 404);
        assert.deepEqual(foreign.body, absent.body, 'no cross-tenant existence is disclosed');
        assert.deepEqual(absent.body, { error: 'Student not found' });
        assert.equal(harness.connectionCount(), 2);
    });
});

test('isolation: the student is always qualified by the server-selected tenant, never by a body field', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: ownerToken(),
            body: { branch_id: BRANCH_A1, tenant_id: TENANT_B },
        }));

        // The extra key is refused outright; a tenant selector in the body is
        // never a way to widen the write.
        assert.equal(result.status, 400);
        assert.equal(harness.connectionCount(), 0);
        assert.equal(branchOf(state, STUDENT_A1), null);
    });
});

// ---------------------------------------------------------------------------
// PATCH /:id/branch — the assign target
// ---------------------------------------------------------------------------

test('target: an archived same-tenant branch is refused exactly like a missing one', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const archived = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_ARCHIVED } }));
        const absent = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: ABSENT_BRANCH } }));

        assert.equal(archived.status, 404);
        assert.equal(absent.status, 404);
        assert.deepEqual(archived.body, absent.body);
        assert.deepEqual(absent.body, { error: 'Branch not found' });
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0, 'a refused target commits nothing');
    });
});

test('target: a branch of another tenant is refused and never resolves a name', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_B1 } }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Branch not found' });
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
    });
});

test('target: the branch name is read under the same lock, inside the same transaction', async () => {
    await withState((state) => {
        state.branches[0].name = 'North Campus (renamed)';
    }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));

        assert.equal(result.status, 200);
        assert.equal(result.body.student.branch_name, 'North Campus (renamed)');
        assert.ok(harness.events.indexOf('branch-select') < harness.events.indexOf('commit'));
    });
});

// ---------------------------------------------------------------------------
// PATCH /:id/branch — strict payload
// ---------------------------------------------------------------------------

test('payload: only the exact single-field shape is accepted', async () => {
    const malformed: any[] = [
        {},
        { branch_id: BRANCH_A1, note: 'x' },
        { branchId: BRANCH_A1 },
        { branch_id: 'not-a-uuid' },
        { branch_id: 42 },
        { branch_id: true },
        { branch_id: [BRANCH_A1] },
        { branch_id: { id: BRANCH_A1 } },
        { branch_id: '' },
        { branch_id: 'a0000000-0000-4000-8000-00000000000' },
        { branch_id: BRANCH_A1 + 'x' },
    ];
    for (const body of malformed) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body }));
            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be refused`);
            assert.deepEqual(result.body, { error: 'Invalid student branch payload' });
            assert.equal(harness.connectionCount(), 0, 'no connection is taken for a malformed payload');
            assert.equal(branchOf(state, STUDENT_A1), null);
            assert.equal(harness.auditRows.length, 0);
        });
    }
});

test('payload: a non-object body is refused before a connection is taken', async () => {
    for (const body of [undefined, null, 'branch', 7, [BRANCH_A1]]) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body }));
            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be refused`);
            assert.equal(harness.connectionCount(), 0);
        });
    }
});

test('payload: a non-uuid student id is refused before a connection is taken', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: ownerToken(),
            body: { branch_id: BRANCH_A1 },
            pathName: '/not-a-uuid/branch',
        }));

        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: 'Invalid student id' });
        assert.equal(harness.connectionCount(), 0);
        assert.equal(branchOf(state, STUDENT_A1), null);
    });
});

test('payload: an unauthenticated request never reaches the transaction', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: null, body: { branch_id: BRANCH_A1 } }));

        assert.equal(result.status, 401);
        assert.equal(harness.connectionCount(), 0);
        assert.equal(branchOf(state, STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
    });
});

// ---------------------------------------------------------------------------
// PATCH /:id/branch — concurrency and disposal
// ---------------------------------------------------------------------------

test('concurrency: a lost update is reported as a conflict, not as a success', async () => {
    await withState((state) => { state.affectedRowsOverride = 0; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));

        assert.equal(result.status, 409);
        assert.deepEqual(result.body, { error: 'Student was modified concurrently' });
        assert.equal(harness.auditRows.length, 0, 'a conflicting write audits nothing');
        assert.equal(harness.commitCount(), 0);
        assert.equal(harness.rollbackCount(), 1);
        assert.equal(harness.releaseCount(), 1);
    });
});

test('assign: reassigning to a different branch rewrites the row and audits the previous id', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const first = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));
        const second = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A2 } }));

        assert.equal(first.status, 200);
        assert.equal(first.body.student.branch_id, BRANCH_A1);
        assert.equal(first.body.student.branch_name, 'North Campus');

        assert.equal(second.status, 200);
        assert.deepEqual(second.body.student, { student_id: STUDENT_A1, branch_id: BRANCH_A2, branch_name: 'South Campus' });
        assert.equal(branchOf(state, STUDENT_A1), BRANCH_A2);

        // One audit event per real change, each naming only the branch ids.
        assert.equal(harness.auditRows.length, 2);
        assert.equal(harness.auditRows[0].params[6], JSON.stringify({ branch_id: null }));
        assert.equal(harness.auditRows[0].params[7], JSON.stringify({ branch_id: BRANCH_A1 }));
        assert.equal(harness.auditRows[1].params[6], JSON.stringify({ branch_id: BRANCH_A1 }));
        assert.equal(harness.auditRows[1].params[7], JSON.stringify({ branch_id: BRANCH_A2 }));
        assert.equal(harness.commitCount(), 2);
        assert.equal(harness.releaseCount(), 2);
        assert.equal(harness.destroyCount(), 0);
    });
});

test('projection: the response envelope carries exactly the student field', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));
        assert.deepEqual(Object.keys(result.body), ['student']);
        assert.equal(harness.auditRows.length, 1);
    });
});

test('disposal: exactly one response is produced per request', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: ownerToken(), body: { branch_id: BRANCH_A1 } }));
        assert.equal(result.responseCount, 1);
        assert.equal(result.handlerReached, true);
    });
});

