/**
 * M2-19 — private bounded group weekly schedules: failure and disposal paths
 * (hermetic, behavioral).
 *
 * Contract under test: every failure of a group write leaves ZERO partial
 * writes — no group row changed or created, no audit event recorded, no
 * connection returned to the pool in an unknown state — and every response is
 * a truthful, bounded failure that never carries an internal detail.
 *
 * The uncertain-commit path is the one that matters most: once the commit
 * acknowledgement is lost, whether the write persisted is UNKNOWN, so the
 * handler must neither claim a rollback nor return the connection to the pool.
 *
 * Composition under test is the real production order (real
 * `optionalAuth`/`authenticateToken`, real `requireTeachingWrite('groups')`
 * with an injected repository seam, then the real router from
 * `src/routes/groups.ts`). Only leaf data boundaries are fixtures: the
 * `src/db` adapters, the entitlement guard's repository, and the
 * `src/security/principal-repository` lookups. No express listener, socket,
 * fetch, DB, provider or app startup.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

const TEST_SECRET = 'm2-19-failures-hermetic-jwt-secret-not-a-real-key';
const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

const originalLoad = (Module as any)._load;
const forbiddenCalls: string[] = [];
const unhandledSql: string[] = [];
const interceptionLog: string[] = [];
const normalize = (id: string) => path.resolve(id).toLowerCase();
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const violation = (name: string): never => {
    forbiddenCalls.push(name);
    throw new Error(`HERMETIC_VIOLATION:${name}`);
};

const activeFixture: { db: any } = { db: null };
const poolHolder: { pool: any } = { pool: null };

const requireFixture = (kind: string, sql: string): any => {
    if (!activeFixture.db) {
        unhandledSql.push(`no fixture for ${kind}: ${squash(sql)}`);
        throw new Error('HERMETIC_NO_FIXTURE');
    }
    return activeFixture.db;
};

const dbSentinel = {
    query: async (sql: string, params?: any[]) => requireFixture('query', sql).query(sql, params ?? []),
    queryOne: async (sql: string, params?: any[]) => requireFixture('queryOne', sql).queryOne(sql, params ?? []),
    execute: async (sql: string, params?: any[]) => requireFixture('execute', sql).execute(sql, params ?? []),
    testConnection: async (): Promise<any> => violation('db.testConnection'),
    closePool: async (): Promise<any> => violation('db.closePool'),
    getPool: (): any => {
        if (!poolHolder.pool) {
            unhandledSql.push('getPool called without an active pool fixture');
            throw new Error('HERMETIC_NO_POOL');
        }
        return poolHolder.pool;
    },
};

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

const realTeachingAccess = require('../src/middleware/teaching-access') as any;
const teachingRepositoryHolder: { repo: any } = { repo: null };

const teachingAccessSentinel = {
    ...realTeachingAccess,
    requireTeachingWrite: (area: string) =>
        realTeachingAccess.createRequireTeachingWrite(area, {
            loadSelectedTenantMembership: async (userId: string, tenantId: string) =>
                teachingRepositoryHolder.repo.loadSelectedTenantMembership(userId, tenantId),
            loadStaffPagePermissions: async () => null,
        }),
};

interface Intercepted { id: string; exports: unknown }
const sentinelByPath = new Map<string, Intercepted>();

const registerSentinel = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    sentinelByPath.set(normalize(id), { id, exports });
};

registerSentinel('../src/db', dbSentinel);
registerSentinel('../src/security/principal-repository', principalRepositorySentinel);
registerSentinel('../src/middleware/teaching-access', teachingAccessSentinel);

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
    routeModule = require('../src/routes/groups');
} catch (error) {
    loadError = error;
} finally {
    restoreInterception();
}

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
    assert.deepEqual(unhandledSql, [], 'every SQL statement must be answered by the fixture');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const INSTRUCTOR_A = 'instructor-a';
const GROUP_A1 = '11111111-1111-4111-8111-111111111111';
const GROUP_A2 = '22222222-2222-4222-8222-222222222222';
const COURSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRADE_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface GroupRow {
    id: string;
    name: string;
    description: string | null;
    course_id: string | null;
    grade_id: string | null;
    instructor_id: string;
    max_students: number;
    current_students: number;
    is_active: number;
    schedule_days: unknown;
    schedule_time: unknown;
}

interface State {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    memberRoles: Record<string, Record<string, string>>;
    tenants: Record<string, { status: string; legacy_compat: number; subscription_entitles: number }>;
    groups: GroupRow[];
    courses: Array<{ id: string; tenant_id: string; is_active: number }>;
    grades: Array<{ id: string }>;
    failAcquire: boolean;
    failBegin: boolean;
    failMemberLock: boolean;
    failGroupLock: boolean;
    failInsert: boolean;
    failUpdate: boolean;
    failAudit: boolean;
    failCommit: boolean;
    failRollback: boolean;
    failSelectorRead: boolean;
}

function makeState(): State {
    return {
        users: { [INSTRUCTOR_A]: { is_active: 1, token_version: 0, suspension_active: 0 } },
        instructorAccounts: { [INSTRUCTOR_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { [INSTRUCTOR_A]: [TENANT_A] },
        memberRoles: { [INSTRUCTOR_A]: { [TENANT_A]: 'instructor' } },
        tenants: { [TENANT_A]: { status: 'active', legacy_compat: 1, subscription_entitles: 1 } },
        groups: [
            {
                id: GROUP_A1, name: 'Algebra A', description: 'Evening group',
                course_id: COURSE_A, grade_id: GRADE_1, instructor_id: INSTRUCTOR_A,
                max_students: 25, current_students: 7, is_active: 1,
                schedule_days: ['sat', 'mon'], schedule_time: '18:30:00',
            },
            {
                id: GROUP_A2, name: 'Geometry B', description: null,
                course_id: null, grade_id: null, instructor_id: INSTRUCTOR_A,
                max_students: 30, current_students: 0, is_active: 1,
                schedule_days: null, schedule_time: null,
            },
        ],
        courses: [{ id: COURSE_A, tenant_id: TENANT_A, is_active: 1 }],
        grades: [{ id: GRADE_1 }],
        failAcquire: false,
        failBegin: false,
        failMemberLock: false,
        failGroupLock: false,
        failInsert: false,
        failUpdate: false,
        failAudit: false,
        failCommit: false,
        failRollback: false,
        failSelectorRead: false,
    };
}

interface Call { sql: string; params: any[] }

const COLUMNS =
    'g.id,g.name,g.description,g.course_id,g.grade_id,g.max_students,g.current_students,g.is_active,g.schedule_days,g.schedule_time';
const SELECT_PREFIX = `SELECT ${COLUMNS} FROM \`groups\` g WHERE `;
const GROUP_LOCK_PREFIX =
    `SELECT ${COLUMNS} FROM \`groups\` g JOIN tenant_memberships tm ON tm.user_id=g.instructor_id AND tm.tenant_id=? AND tm.status='active' WHERE g.id=?`;

const COURSE_SELECT = 'SELECT id FROM courses WHERE id=? AND tenant_id=? AND is_active=TRUE';
const GRADE_SELECT = 'SELECT id FROM grades WHERE id=?';
const OWNERSHIP_SELECT_PREFIX = 'SELECT g.id FROM `groups` g WHERE g.id=? AND ';
const DELETE_SQL = 'DELETE FROM `groups` WHERE id = ?';
const MEMBER_LOCK_SELECT =
    'SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.tenant_id=? AND m.status=\'active\' LIMIT 1 FOR UPDATE';
const GROUP_UPDATE_SQL =
    'UPDATE `groups` SET name=?,description=?,course_id=?,grade_id=?,max_students=?,is_active=?,schedule_days=?,schedule_time=?,updated_at=CURRENT_TIMESTAMP WHERE id=?';
const GROUP_INSERT_SQL =
    'INSERT INTO `groups` (id,name,description,course_id,grade_id,instructor_id,max_students,is_active,schedule_days,schedule_time) VALUES (?,?,?,?,?,?,?,?,?,?)';
const AUDIT_SQL =
    'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

const TENANT_PREDICATE =
    "g.instructor_id IN (SELECT user_id FROM tenant_memberships WHERE tenant_id=? AND status='active')";
const SCOPE_PREDICATE = 'g.instructor_id = ?';

interface Harness {
    chain: RequestHandler[];
    auditRows: Call[];
    events: string[];
    connectionCount: () => number;
    releaseCount: () => number;
    destroyCount: () => number;
    rollbackCount: () => number;
    commitCount: () => number;
    groupOf: (id: string) => GroupRow | undefined;
    groupCount: () => number;
}

function buildHarness(state: State): Harness {
    const auditRows: Call[] = [];
    const events: string[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;
    let rollbackCount = 0;
    let commitCount = 0;

    const hasActiveMembership = (userId: string, tenantId: string) =>
        (state.memberships[userId] ?? []).includes(tenantId);

    const readPredicate = (where: string, params: any[]) => {
        const tenantPos = where.indexOf(TENANT_PREDICATE);
        const scopePos = where.indexOf(SCOPE_PREDICATE);
        const ordered = [
            ...(tenantPos >= 0 ? [{ pos: tenantPos, kind: 'tenant' as const }] : []),
            ...(scopePos >= 0 ? [{ pos: scopePos, kind: 'scope' as const }] : []),
        ].sort((a, b) => a.pos - b.pos);
        let cursor = 0;
        let tenantId: string | null = null;
        let scopeId: string | null = null;
        for (const entry of ordered) {
            const value = String(params[cursor++]);
            if (entry.kind === 'tenant') tenantId = value;
            else scopeId = value;
        }
        return { tenantId, scopeId };
    };

    const selectGroups = (where: string, params: any[]): GroupRow[] => {
        const { tenantId, scopeId } = readPredicate(where, params);
        return state.groups.filter((row) =>
            row.is_active === 1 &&
            (tenantId === null || hasActiveMembership(row.instructor_id, tenantId)) &&
            (scopeId === null || row.instructor_id === scopeId));
    };

    const groupById = (id: string) => state.groups.find((row) => row.id === id) ?? null;

    let pendingInsert: GroupRow | null = null;
    let pendingUpdate: { id: string; fields: Partial<GroupRow> } | null = null;
    let pendingAudit: Call[] = [];

    const connectionExecute = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);

        if (n === MEMBER_LOCK_SELECT) {
            events.push('member');
            if (state.failMemberLock) throw new Error('membership lock failed: internal detail leaked');
            const [userId, tenantId] = params.map(String);
            const roleKey = state.memberRoles[userId]?.[tenantId];
            const user = state.users[userId];
            const tenant = state.tenants[tenantId];
            if (!roleKey || !user || !tenant || !hasActiveMembership(userId, tenantId)) return [[], []];
            return [[{ role_key: roleKey, caller_active: user.is_active, tenant_status: tenant.status }], []];
        }

        if (n.startsWith(GROUP_LOCK_PREFIX)) {
            events.push('group-lock');
            if (state.failGroupLock) throw new Error('group lock failed: internal detail leaked');
            const tenantId = String(params[0]);
            const groupId = String(params[1]);
            const scoped = n.includes('AND g.instructor_id=?');
            const scopeId = scoped ? String(params[2]) : null;
            const row = groupById(groupId);
            if (!row || row.is_active !== 1) return [[], []];
            if (!hasActiveMembership(row.instructor_id, tenantId)) return [[], []];
            if (scopeId !== null && row.instructor_id !== scopeId) return [[], []];
            return [[{ ...row }], []];
        }

        if (n === GROUP_INSERT_SQL) {
            events.push('insert');
            if (state.failInsert) throw new Error('insert into groups failed: internal detail leaked');
            const [id, name, description, courseId, gradeId, instructorId, maxStudents, isActive, days, time] = params;
            pendingInsert = {
                id: String(id),
                name: String(name),
                description: description === null ? null : String(description),
                course_id: courseId === null ? null : String(courseId),
                grade_id: gradeId === null ? null : String(gradeId),
                instructor_id: String(instructorId),
                max_students: Number(maxStudents),
                current_students: 0,
                is_active: Number(isActive),
                schedule_days: days,
                schedule_time: time,
            };
            return [{ affectedRows: 1 }, []];
        }

        if (n === GROUP_UPDATE_SQL) {
            events.push('update');
            if (state.failUpdate) throw new Error('ER_LOCK_WAIT_TIMEOUT: update on internal table groups failed');
            const [name, description, courseId, gradeId, maxStudents, isActive, days, time, id] = params;
            pendingUpdate = {
                id: String(id),
                fields: {
                    name: String(name),
                    description: description === null ? null : String(description),
                    course_id: courseId === null ? null : String(courseId),
                    grade_id: gradeId === null ? null : String(gradeId),
                    max_students: Number(maxStudents),
                    is_active: Number(isActive),
                    schedule_days: days,
                    schedule_time: time,
                },
            };
            return [{ affectedRows: 1 }, []];
        }

        if (n === AUDIT_SQL) {
            events.push('audit');
            if (state.failAudit) throw new Error('audit_events insert failed: internal detail leaked');
            pendingAudit.push({ sql, params });
            return [{ affectedRows: 1 }, []];
        }

        throw new Error(`Unhandled group SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        pendingInsert = null;
        pendingUpdate = null;
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
                if (pendingInsert) state.groups.push(pendingInsert);
                if (pendingUpdate) {
                    const row = groupById(pendingUpdate.id);
                    if (row) Object.assign(row, pendingUpdate.fields);
                }
                for (const row of pendingAudit) auditRows.push(row);
                pendingInsert = null;
                pendingUpdate = null;
                pendingAudit = [];
            },
            rollback: async () => {
                events.push('rollback');
                rollbackCount += 1;
                if (state.failRollback) throw new Error('rollback failed: internal detail leaked');
                pendingInsert = null;
                pendingUpdate = null;
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

    activeFixture.db = {
        query: async (sql: string, params: any[]) => {
            const n = squash(sql);
            if (n.startsWith(SELECT_PREFIX) && n.endsWith('ORDER BY g.name')) {
                const where = n.slice(SELECT_PREFIX.length, n.length - ' ORDER BY g.name'.length);
                return selectGroups(where, params).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            }
            throw new Error(`Unhandled group query in hermetic fixture: ${n}`);
        },
        queryOne: async (sql: string, params: any[]) => {
            const n = squash(sql);

            if (n === COURSE_SELECT) {
                if (state.failSelectorRead) throw new Error('courses read failed: internal detail leaked');
                const [id, tenantId] = params.map(String);
                const row = state.courses.find((c) => c.id === id && c.tenant_id === tenantId && c.is_active === 1);
                return row ? { id: row.id } : null;
            }

            if (n === GRADE_SELECT) {
                if (state.failSelectorRead) throw new Error('grades read failed: internal detail leaked');
                const row = state.grades.find((g) => g.id === String(params[0]));
                return row ? { id: row.id } : null;
            }

            if (n.startsWith(SELECT_PREFIX) && n.includes('g.id=? AND ')) {
                const where = n.slice(SELECT_PREFIX.length, n.length - ' LIMIT 1'.length);
                const matches = selectGroups(where.replace('g.id=? AND ', ''), params.slice(1));
                return matches.find((row) => row.id === String(params[0])) ?? null;
            }

            if (n.startsWith(OWNERSHIP_SELECT_PREFIX) && n.endsWith(' LIMIT 1')) {
                const where = n.slice(OWNERSHIP_SELECT_PREFIX.length, n.length - ' LIMIT 1'.length);
                const matches = selectGroups(where, params.slice(1));
                return matches.some((row) => row.id === String(params[0])) ? { id: String(params[0]) } : null;
            }

            throw new Error(`Unhandled group queryOne in hermetic fixture: ${n}`);
        },
        execute: async (sql: string, params: any[]) => {
            const n = squash(sql);
            if (n === DELETE_SQL) {
                const index = state.groups.findIndex((row) => row.id === String(params[0]));
                if (index < 0) return { affectedRows: 0 };
                state.groups.splice(index, 1);
                return { affectedRows: 1 };
            }
            throw new Error(`Unhandled group execute in hermetic fixture: ${n}`);
        },
    };

    identityHolder.users = state.users;
    identityHolder.instructorAccounts = state.instructorAccounts;
    identityHolder.memberships = state.memberships;

    teachingRepositoryHolder.repo = {
        loadSelectedTenantMembership: async (userId: string, tenantId: string) => {
            const roleKey = state.memberRoles[userId]?.[tenantId];
            const user = state.users[userId];
            const tenant = state.tenants[tenantId];
            if (!roleKey || !user || !tenant || !hasActiveMembership(userId, tenantId)) return null;
            return {
                role_key: roleKey,
                user_is_active: user.is_active,
                tenant_status: tenant.status,
                tenant_legacy_compat: tenant.legacy_compat,
                subscription_entitles: tenant.subscription_entitles,
            };
        },
        loadStaffPagePermissions: async () => null,
    };

    return {
        chain: [routeModule.default as Router],
        auditRows,
        events,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
        rollbackCount: () => rollbackCount,
        commitCount: () => commitCount,
        groupOf: (id: string) => groupById(id),
        groupCount: () => state.groups.length,
    };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string>; responseCount: number }

function makeReq(method: string, pathName: string, token: string | null, body: any) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return {
        method,
        url: pathName,
        originalUrl: `/api/groups${pathName === '/' ? '' : pathName}`,
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
const instructorToken = () => sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_A });

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

/** A failure must always answer with the same bounded, detail-free body. */
const FAILURE_BODY = { error: 'Failed to save group' };

const CREATE_BODY = { name: 'New Group', schedule_days: ['mon'], schedule_time: '10:00' };
const UPDATE_BODY = { schedule_days: ['wed'], schedule_time: '19:00' };

const runFailing = async (
    flag: keyof State,
    options: { method?: string; pathName?: string; body?: any } = {},
) => withSilencedErrors(async () => {
    const state = makeState();
    (state as any)[flag] = true;
    const harness = buildHarness(state);
    const result = await runChain(
        harness.chain,
        makeReq(options.method ?? 'PUT', options.pathName ?? `/${GROUP_A1}`, instructorToken(), options.body ?? UPDATE_BODY),
    );
    return { harness, result, state };
});

/** Every refusal answers identically, writes nothing and commits nothing. */
const assertCleanFailure = (harness: Harness, result: Result, expectedEvents: string[]) => {
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.responseCount, 1);
    assert.equal(harness.auditRows.length, 0, 'no audit event may be recorded');
    assert.equal(harness.commitCount(), 0, 'nothing may be committed');
    assert.deepEqual(harness.events, expectedEvents);
};

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

    for (const specifier of ['../src/db', '../src/security/principal-repository']) {
        const intercepted = sentinelByPath.get(normalize(require.resolve(specifier)))!;
        assert.ok(interceptionLog.includes(intercepted.id), `the loader must have intercepted ${intercepted.id}`);
        assert.equal(require.cache[intercepted.id], undefined, `${intercepted.id} must never be cached by Node`);
    }
    const teaching = sentinelByPath.get(normalize(require.resolve('../src/middleware/teaching-access')))!;
    assert.ok(interceptionLog.includes(teaching.id), 'the route must resolve the injected entitlement guard');

    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
});

// ---------------------------------------------------------------------------
// Before the transaction
// ---------------------------------------------------------------------------

test('acquire: an unavailable connection is a clean 500 and no connection exists', async () => {
    const { harness, result } = await runFailing('failAcquire');
    assertCleanFailure(harness, result, []);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
    assert.equal(harness.groupOf(GROUP_A1)!.schedule_time, '18:30:00');
});

test('selector: a failed course read is a clean 500 before any connection is taken', async () => {
    const { harness, result } = await runFailing('failSelectorRead', {
        method: 'POST',
        pathName: '/',
        body: { name: 'New Group', course_id: COURSE_A },
    });
    assertCleanFailure(harness, result, []);
    assert.equal(harness.connectionCount(), 0);
    assert.equal(harness.groupCount(), 2, 'no group is created');
});

test('begin: a failed BEGIN discards the connection instead of returning it', async () => {
    const { harness, result } = await runFailing('failBegin');
    assertCleanFailure(harness, result, ['begin', 'destroy']);
    assert.equal(harness.connectionCount(), 1);
    // The transaction never started, so the connection cannot be trusted.
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.groupOf(GROUP_A1)!.schedule_time, '18:30:00');
});

// ---------------------------------------------------------------------------
// Inside the transaction — each step rolls back and releases
// ---------------------------------------------------------------------------

test('member lock: a failed authority re-read rolls back and releases', async () => {
    const { harness, result } = await runFailing('failMemberLock');
    assertCleanFailure(harness, result, ['begin', 'member', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.destroyCount(), 0);
});

test('group lock: a failed target lock rolls back and releases', async () => {
    const { harness, result } = await runFailing('failGroupLock');
    assertCleanFailure(harness, result, ['begin', 'member', 'group-lock', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
});

test('update: a failed UPDATE rolls back, records no audit event and releases', async () => {
    const { harness, result } = await runFailing('failUpdate');
    assertCleanFailure(harness, result, ['begin', 'member', 'group-lock', 'update', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.groupOf(GROUP_A1)!.schedule_time, '18:30:00', 'the row is untouched');
});

test('insert: a failed INSERT creates no group and audits nothing', async () => {
    const { harness, result } = await runFailing('failInsert', {
        method: 'POST',
        pathName: '/',
        body: CREATE_BODY,
    });
    assertCleanFailure(harness, result, ['begin', 'member', 'insert', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.groupCount(), 2, 'no group row survives the rollback');
});

test('audit: a failed audit insert rolls the write back with it (update)', async () => {
    const { harness, result } = await runFailing('failAudit');
    // The UPDATE already ran inside the transaction, but the rollback discards
    // it: the audit event and the write share one atomic unit.
    assertCleanFailure(harness, result, ['begin', 'member', 'group-lock', 'update', 'audit', 'rollback', 'release']);
    assert.equal(harness.rollbackCount(), 1);
    assert.equal(harness.releaseCount(), 1);
    assert.equal(harness.groupOf(GROUP_A1)!.schedule_time, '18:30:00');
    assert.deepEqual(harness.groupOf(GROUP_A1)!.schedule_days, ['sat', 'mon']);
});

test('audit: a failed audit insert rolls the create back with it', async () => {
    const { harness, result } = await runFailing('failAudit', {
        method: 'POST',
        pathName: '/',
        body: CREATE_BODY,
    });
    assertCleanFailure(harness, result, ['begin', 'member', 'insert', 'audit', 'rollback', 'release']);
    assert.equal(harness.groupCount(), 2, 'the created row is discarded with the audit failure');
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
    assert.deepEqual(harness.events, ['begin', 'member', 'group-lock', 'update', 'audit', 'commit', 'destroy']);
});

test('commit: a lost create acknowledgement discards the connection', async () => {
    const { harness, result } = await runFailing('failCommit', {
        method: 'POST',
        pathName: '/',
        body: CREATE_BODY,
    });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, FAILURE_BODY);
    assert.equal(harness.rollbackCount(), 0);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 1);
    assert.deepEqual(harness.events, ['begin', 'member', 'insert', 'audit', 'commit', 'destroy']);
});

test('commit: a lost acknowledgement with a rollback that would also fail still discards', async () => {
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failCommit = true;
        state.failRollback = true;
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq('PUT', `/${GROUP_A1}`, instructorToken(), UPDATE_BODY));

        assert.equal(result.status, 500);
        assert.equal(harness.destroyCount(), 1);
        assert.equal(harness.releaseCount(), 0);
        // The commit path never attempts a rollback at all.
        assert.equal(harness.rollbackCount(), 0);
    });
});

test('rollback: a failed rollback on a not-found refusal still answers the refusal', async () => {
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failRollback = true;
        const harness = buildHarness(state);
        // An absent group is the refusal that reaches the rollback. The
        // rollback itself fails, so the connection cannot be reused — but the
        // refusal it was answering is still the truthful response.
        const result = await runChain(
            harness.chain,
            makeReq('PUT', '/99999999-9999-4999-8999-999999999999', instructorToken(), UPDATE_BODY),
        );

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Group not found' });
        assert.equal(harness.destroyCount(), 1, 'a connection whose rollback failed must be destroyed');
        assert.equal(harness.releaseCount(), 0);
        assert.equal(harness.auditRows.length, 0);
    });
});

test('rollback: a failed rollback on a failure path still answers 500 and destroys', async () => {
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failUpdate = true;
        state.failRollback = true;
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq('PUT', `/${GROUP_A1}`, instructorToken(), UPDATE_BODY));

        assert.equal(result.status, 500);
        assert.deepEqual(result.body, FAILURE_BODY);
        assert.equal(harness.destroyCount(), 1, 'a connection whose rollback failed must be destroyed');
        assert.equal(harness.releaseCount(), 0);
        assert.equal(harness.groupOf(GROUP_A1)!.schedule_time, '18:30:00', 'the discarded transaction leaves no partial write');
        assert.equal(harness.auditRows.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting guarantees
// ---------------------------------------------------------------------------

test('every failure path answers with the same bounded body and no internal detail', async () => {
    // `failInsert` only exists on the create path, so each flag is driven
    // through the write it actually belongs to.
    const cases: Array<{ flag: keyof State; options?: { method?: string; pathName?: string; body?: any } }> = [
        { flag: 'failAcquire' },
        { flag: 'failBegin' },
        { flag: 'failMemberLock' },
        { flag: 'failGroupLock' },
        { flag: 'failInsert', options: { method: 'POST', pathName: '/', body: CREATE_BODY } },
        { flag: 'failUpdate' },
        { flag: 'failAudit' },
        { flag: 'failCommit' },
    ];
    for (const { flag, options } of cases) {
        const { result } = await runFailing(flag, options);
        assert.equal(result.status, 500, `${flag} must fail`);
        assert.deepEqual(result.body, FAILURE_BODY, `${flag} must not leak an internal detail`);
        const text = JSON.stringify(result.body);
        assert.equal(text.includes('leaked'), false, `${flag} must not leak the thrown message`);
        assert.equal(text.includes('tenant_memberships'), false);
        assert.equal(text.includes('audit_events'), false);
        assert.equal(text.includes('groups'), false);
        assert.equal(text.includes('stack'), false);
    }
});

test('no failure path ever leaks a stored group value', async () => {
    for (const flag of ['failUpdate', 'failAudit', 'failCommit'] as Array<keyof State>) {
        const { result } = await runFailing(flag);
        const text = JSON.stringify(result.body);
        assert.equal(text.includes('Algebra'), false);
        assert.equal(text.includes(GROUP_A1), false);
        assert.equal(text.includes(INSTRUCTOR_A), false);
        assert.equal(text.includes(TENANT_A), false);
    }
});

test('a refused write never leaves the transaction buffers behind', async () => {
    // A create whose audit fails must not leave a staged row for a later request.
    await withSilencedErrors(async () => {
        const state = makeState();
        state.failAudit = true;
        const harness = buildHarness(state);
        await runChain(harness.chain, makeReq('POST', '/', instructorToken(), CREATE_BODY));
        assert.equal(harness.groupCount(), 2);

        // The same harness now succeeds: exactly one row is added, not two.
        state.failAudit = false;
        const second = await runChain(harness.chain, makeReq('POST', '/', instructorToken(), CREATE_BODY));
        assert.equal(second.status, 201);
        assert.equal(harness.groupCount(), 3, 'exactly one row is added by one successful create');
        assert.equal(harness.auditRows.length, 1);
    });
});
