/**
 * M2-18 — private student branch assignment: failure and disposal paths
 * (hermetic, behavioral).
 *
 * Contract under test: every failure of PATCH /api/students/:id/branch leaves
 * ZERO partial writes — no student row changed, no audit event recorded, no
 * connection leaked back into the pool in an unknown state — and every
 * response is a truthful, bounded failure that never carries an internal
 * detail.
 *
 * The uncertain-commit path is the one that matters most: once the commit
 * acknowledgement is lost, whether the write persisted is UNKNOWN, so the
 * handler must neither claim a rollback nor return the connection to the pool.
 *
 * Composition under test is the real production order (real
 * `optionalAuth`/`authenticateToken`, then the real handler from
 * `src/routes/students.ts`). Only leaf data boundaries are injected fixtures:
 * the `src/db` pool and the `src/security/principal-repository` lookups. No
 * express listener, socket, fetch, DB, provider or app startup.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-18-failures-hermetic-jwt-secret-not-a-real-key';
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
    testConnection: async (): Promise<any> => violation('db.testConnection'),
    closePool: async (): Promise<any> => violation('db.closePool'),
    getPool: (): any => poolHolder.pool,
};

const poolHolder: { pool: any } = { pool: null };

const identityHolder: {
    users: Record<string, any>;
    instructorAccounts: Record<string, any>;
    enrollments: Record<string, any[]>;
    memberships: Record<string, string[]>;
} = { users: {}, instructorAccounts: {}, enrollments: {}, memberships: {} };

const principalRepositorySentinel = {
    defaultPrincipalRepository: {
        findUsersIdentity: async (id: string) => identityHolder.users[id] ?? null,
        findStaffIdentity: async (): Promise<any> => null,
        findInstructorAccount: async (id: string) => identityHolder.instructorAccounts[id] ?? null,
        findStudentEnrollments: async (id: string) => identityHolder.enrollments[id] ?? [],
        findActiveTenantMemberships: async (id: string) =>
            (identityHolder.memberships[id] ?? []).map((tenant_id) => ({ tenant_id })),
    },
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
const OWNER_A = 'owner-a';
const STUDENT_A1 = '11111111-1111-4111-8111-111111111111';
const BRANCH_A1 = 'a0000000-0000-4000-8000-000000000001';

interface State {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    tenants: Array<{ id: string; owner_user_id: string; status: string }>;
    students: Array<{ id: string; tenant_id: string; branch_id: string | null }>;
    branches: Array<{ id: string; tenant_id: string; name: string; status: string }>;
    failAcquire: boolean;
    failBegin: boolean;
    failOwnerSelect: boolean;
    failStudentSelect: boolean;
    failBranchSelect: boolean;
    failUpdate: boolean;
    failAudit: boolean;
    failCommit: boolean;
    failRollback: boolean;
}

function makeState(): State {
    return {
        users: { [OWNER_A]: { is_active: 1, token_version: 0, suspension_active: 0 } },
        instructorAccounts: { [OWNER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { [OWNER_A]: [TENANT_A] },
        tenants: [{ id: TENANT_A, owner_user_id: OWNER_A, status: 'active' }],
        students: [{ id: STUDENT_A1, tenant_id: TENANT_A, branch_id: null }],
        branches: [{ id: BRANCH_A1, tenant_id: TENANT_A, name: 'North Campus', status: 'active' }],
        failAcquire: false,
        failBegin: false,
        failOwnerSelect: false,
        failStudentSelect: false,
        failBranchSelect: false,
        failUpdate: false,
        failAudit: false,
        failCommit: false,
        failRollback: false,
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
    events: string[];
    auditRows: Call[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
    rollbackCount: () => number;
    commitCount: () => number;
    branchOf: (studentId: string) => string | null | 'absent';
}

function buildHarness(state: State): Harness {
    const events: string[] = [];
    const auditRows: Call[] = [];
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
            // The write is BUFFERED, not applied: a real transaction only
            // becomes visible at COMMIT. Applying it immediately would make the
            // fixture lie about atomicity.
            pendingWrite = {
                id: String(id),
                tenant_id: String(tenantId),
                branch_id: branchId === null ? null : String(branchId),
            };
            return [{ affectedRows: 1 }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            // Buffered for the same reason as the write.
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
                // The acknowledgement succeeded: now the staged writes land.
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
                // The staged writes are discarded: nothing partial survives.
                pendingWrite = null;
                pendingAudit = [];
            },
            release: () => { events.push('release'); releaseCount += 1; },
            destroy: () => { events.push('destroy'); destroyCount += 1; },
        };
    };

    poolHolder.pool = {
        getConnection: async () => {
            if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
            return makeConnection();
        },
    };

    identityHolder.users = state.users;
    identityHolder.instructorAccounts = state.instructorAccounts;
    identityHolder.memberships = state.memberships;

    return {
        chain: [routeModule.default as Router],
        events,
        auditRows,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
        rollbackCount: () => rollbackCount,
        commitCount: () => commitCount,
        branchOf: (studentId: string) => {
            const row = state.students.find(s => s.id === studentId && s.tenant_id === TENANT_A);
            return row ? row.branch_id : 'absent';
        },
    };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string>; responseCount: number }

function makeReq(token: string | null, body: any = { branch_id: BRANCH_A1 }) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const pathName = `/${STUDENT_A1}/branch`;
    return {
        method: 'PATCH',
        url: pathName,
        originalUrl: `/api/students${pathName}`,
        path: pathName,
        headers,
        query: {},
        body,
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
            json(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, responseCount }); return res; },
            send(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, responseCount }); return res; },
            end() { responseCount += 1; finish({ status: res.statusCode, body: undefined, headers, responseCount }); return res; },
        };

        const next = (error?: any) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            const middleware = chain[index++];
            if (!middleware) { finish({ status: 0, body: undefined, headers, responseCount }); return; }
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
const ownerToken = () => sign(OWNER_A, 'instructor', { tenant_id: TENANT_A });

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

/** A failure must always answer with the same bounded, detail-free body. */
const FAILURE_BODY = { error: 'Failed to update student branch' };

const runFailing = (flag: keyof State, body: any = { branch_id: BRANCH_A1 }) =>
    withSilencedErrors(async () => {
        const state = makeState();
        (state as any)[flag] = true;
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq(ownerToken(), body));
        return { harness, result, state };
    });

/** Every refusal answers identically, carries no-store, and writes nothing. */
const assertCleanFailure = (
    harness: Harness,
    result: Result,
    expectedStatus: number,
    expectedEvents: string[],
) => {
    assert.equal(result.status, expectedStatus);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.responseCount, 1);
    assert.equal(harness.branchOf(STUDENT_A1), null, 'no student row may be changed');
    assert.equal(harness.auditRows.length, 0, 'no audit event may be recorded');
    assert.equal(harness.commitCount(), 0, 'nothing may be committed');
    assert.deepEqual(harness.events, expectedEvents);
};

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env, hook restored', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

    for (const [key, intercepted] of sentinelByPath) {
        assert.ok(interceptionLog.includes(intercepted.id), `the loader must have intercepted ${intercepted.id}`);
        assert.equal(require.cache[intercepted.id], undefined, `${intercepted.id} must never be cached by Node`);
    }
    assert.deepEqual(sentinelCalls, [], 'no forbidden default adapter may be called');
    assert.equal((Module as any)._load, originalLoad, 'the loader hook is restored in finally');
});

// ---------------------------------------------------------------------------
// Before the transaction
// ---------------------------------------------------------------------------

test('acquire: an unavailable connection is a clean 500 and no connection exists', async () => {
    const { harness, result } = await runFailing('failAcquire');
    assertCleanFailure(harness, result, 500, []);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
});

test('begin: a failed BEGIN discards the connection instead of returning it', async () => {
    const { harness, result } = await runFailing('failBegin');
    assertCleanFailure(harness, result, 500, ['begin', 'destroy']);
    assert.equal(harness.connectionCount(), 1);
    // The transaction never started, so the connection cannot be trusted.
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
});

// ---------------------------------------------------------------------------
// Inside the transaction — each step rolls back and releases
// ---------------------------------------------------------------------------

test('owner select: a failed owner verification rolls back and releases', async () => {
    const { harness, result } = await runFailing('failOwnerSelect');
    assertCleanFailure(harness, result, 500, ['begin', 'owner', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('student select: a failed student lock rolls back and releases', async () => {
    const { harness, result } = await runFailing('failStudentSelect');
    assertCleanFailure(harness, result, 500, ['begin', 'owner', 'student-select', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
});

test('branch select: a failed branch lock rolls back and releases', async () => {
    const { harness, result } = await runFailing('failBranchSelect');
    assertCleanFailure(harness, result, 500, ['begin', 'owner', 'student-select', 'branch-select', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
});

test('update: a failed UPDATE rolls back, records no audit event and releases', async () => {
    const { harness, result } = await runFailing('failUpdate');
    assertCleanFailure(harness, result, 500, ['begin', 'owner', 'student-select', 'branch-select', 'update', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.branchOf(STUDENT_A1), null);
});

test('audit: a failed audit insert rolls the write back with it', async () => {
    const { harness, result } = await runFailing('failAudit');
    // The UPDATE already ran inside the transaction, but the rollback discards
    // it: the audit event and the write share one atomic unit.
    assertCleanFailure(harness, result, 500, ['begin', 'owner', 'student-select', 'branch-select', 'update', 'audit', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.auditRows.length, 0);
});

// ---------------------------------------------------------------------------
// The uncertain-commit path
// ---------------------------------------------------------------------------

test('commit: a lost commit acknowledgement is never reported as a rollback', async () => {
    const { harness, result } = await runFailing('failCommit');
    // Persistence is UNKNOWN: the handler must not claim a rollback happened,
    // must not retry, and must never return this connection to the pool.
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(harness.rollbackCount(), 0, 'a rollback must never be claimed after a commit attempt');
    assert.equal(harness.releaseCount(), 0, 'a connection of unknown state must never be released');
    assert.equal(harness.destroyCount(), 1, 'the connection must be discarded');
    assert.deepEqual(harness.events, ['begin', 'owner', 'student-select', 'branch-select', 'update', 'audit', 'commit', 'destroy']);
});

test('commit: a lost commit acknowledgement with a rollback that would also fail still discards', async () => {
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failCommit = true;
        state.failRollback = true;
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq(ownerToken()));

        assert.equal(result.status, 500);
        assert.equal(harness.destroyCount(), 1);
        assert.equal(harness.releaseCount(), 0);
        // The commit path never attempts a rollback at all.
        assert.equal(harness.rollbackCount(), 0);
    });
});

test('rollback: a failed rollback on a refusal path still answers the refusal', async () => {
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failRollback = true;
        const harness = buildHarness(state);
        // An absent branch is the refusal that reaches the rollback. The
        // rollback itself fails, so the connection cannot be reused — but the
        // refusal it was answering is still the truthful response.
        const result = await runChain(harness.chain, makeReq(ownerToken(), { branch_id: 'cccccccc-0000-4000-8000-000000000000' }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Branch not found' });
        assert.equal(harness.destroyCount(), 1, 'a connection whose rollback failed must be destroyed');
        assert.equal(harness.releaseCount(), 0);
        assert.equal(harness.branchOf(STUDENT_A1), null);
        assert.equal(harness.auditRows.length, 0);
    });
});

test('rollback: a failed rollback on a failure path still answers 500 and destroys', async () => {
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failUpdate = true;
        state.failRollback = true;
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq(ownerToken()));

        assert.equal(result.status, 500);
        assert.deepEqual(result.body, FAILURE_BODY);
        assert.equal(harness.destroyCount(), 1, 'a connection whose rollback failed must be destroyed');
        assert.equal(harness.releaseCount(), 0);
        assert.equal(harness.branchOf(STUDENT_A1), null, 'the discarded transaction leaves no partial write');
        assert.equal(harness.auditRows.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting guarantees
// ---------------------------------------------------------------------------

test('every failure path answers with the same bounded body and no internal detail', async () => {
    const flags: Array<keyof State> = [
        'failAcquire', 'failBegin', 'failOwnerSelect', 'failStudentSelect',
        'failBranchSelect', 'failUpdate', 'failAudit', 'failCommit',
    ];
    for (const flag of flags) {
        const { result } = await runFailing(flag);
        assert.deepEqual(result.body, FAILURE_BODY, `${flag} must not leak an internal detail`);
        const text = JSON.stringify(result.body);
        assert.equal(text.includes('leaked'), false, `${flag} must not leak the thrown message`);
        assert.equal(text.includes('tenant_branches'), false);
        assert.equal(text.includes('audit_events'), false);
        assert.equal(text.includes('students'), false);
        assert.equal(text.includes('stack'), false);
    }
});

test('no failure path ever leaks a student or branch value', async () => {
    for (const flag of ['failUpdate', 'failAudit', 'failCommit'] as Array<keyof State>) {
        const { result } = await runFailing(flag);
        const text = JSON.stringify(result.body);
        assert.equal(text.includes('North Campus'), false);
        assert.equal(text.includes(BRANCH_A1), false);
        assert.equal(text.includes(STUDENT_A1), false);
    }
});

