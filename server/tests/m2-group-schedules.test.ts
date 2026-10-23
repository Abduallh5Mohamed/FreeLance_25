/**
 * M2-19 — private bounded group weekly schedules (hermetic, behavioral).
 *
 * Contract under test: the EXISTING `/api/groups` mount now serves only the
 * caller's own groups inside the tenant the SERVER selected, and writes one
 * canonical bounded weekly schedule — the seven existing weekday keys
 * `sat|sun|mon|tue|wed|thu|fri` in canonical order without duplicates, and a
 * real `HH:mm` or null. Malformed or foreign course/grade selectors are
 * REJECTED instead of being silently nulled; `null` explicitly clears and an
 * absent key keeps the stored value.
 *
 * Composition under test is the real production order: the real
 * `optionalAuth`/`authenticateToken` over the real principal resolver, the
 * real `requireTeachingWrite('groups')` entitlement guard, and the real router
 * from `src/routes/groups.ts`. Only leaf data boundaries are injected
 * fixtures: the `src/db` adapters and the entitlement guard's repository seam
 * (`createRequireTeachingWrite(area, repository)`), which is the module's own
 * documented injection point — the entitlement DECISION stays the real one.
 * The `src/security/principal-repository` identity lookups are fixtures too.
 * No express listener, socket, fetch, DB, provider or app startup.
 *
 * The guard's production repository imports `src/db` lazily through a native
 * dynamic `import()`, which never passes the CommonJS loader; injecting the
 * repository seam is therefore what keeps the suite hermetic without
 * replacing any decision logic. Import isolation is still proven positively:
 * the intercepted module bodies never enter `require.cache`, need no dummy
 * env, and the hook is asserted restored in `after`.
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

const TEST_SECRET = 'm2-19-hermetic-jwt-secret-not-a-real-key';
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

/** The active per-test fixture. Replaced by `buildHarness` before any request. */
const activeFixture: { db: any } = { db: null };
const poolHolder: { pool: any } = { pool: null };

const requireFixture = (kind: string, sql: string): any => {
    if (!activeFixture.db) {
        unhandledSql.push(`no fixture for ${kind}: ${squash(sql)}`);
        throw new Error('HERMETIC_NO_FIXTURE');
    }
    return activeFixture.db;
};

/**
 * The pool and the non-transactional adapters are leaf data boundaries. The
 * group routes legitimately use `query`/`queryOne`/`execute` for bounded reads,
 * selector validation and delete, and the entitlement guard uses `queryOne`
 * through a lazy import, so these forward to the active fixture instead of
 * refusing. Anything that would need a real service still refuses loudly.
 */
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

/**
 * The entitlement guard is real; only its repository seam is injected. The
 * real module is loaded BEFORE the loader hook is installed, and the sentinel
 * re-exports it with `requireTeachingWrite` bound to the per-test fixture — so
 * `evaluateTeachingEntitlement` and the middleware body stay production code.
 */
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
const TENANT_B = 'tenant-b';
const OWNER_A = 'owner-a';
const INSTRUCTOR_A = 'instructor-a';
const INSTRUCTOR_A2 = 'instructor-a2';
const INSTRUCTOR_B = 'instructor-b';
const OUTSIDER_A = 'outsider-a';
const BILLING_ONLY = 'billing-only-instructor';

const GROUP_A1 = '11111111-1111-4111-8111-111111111111';
const GROUP_A2 = '22222222-2222-4222-8222-222222222222';
const GROUP_A3 = '33333333-3333-4333-8333-333333333333';
const GROUP_B1 = '44444444-4444-4444-8444-444444444444';
const GROUP_ARCHIVED = '55555555-5555-4555-8555-555555555555';
const ABSENT_GROUP = '99999999-9999-4999-8999-999999999999';

const COURSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COURSE_A_ARCHIVED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COURSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ABSENT_COURSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const GRADE_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ABSENT_GRADE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const CANONICAL_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

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
    /** Simulates a membership downgraded between the guard read and the transaction. */
    memberLockDenies: boolean;
    affectedRowsOverride: number | null;
}

const identity = () => ({ is_active: 1, token_version: 0, suspension_active: 0 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: identity(),
            [INSTRUCTOR_A]: identity(),
            [INSTRUCTOR_A2]: identity(),
            [INSTRUCTOR_B]: identity(),
            [OUTSIDER_A]: identity(),
            [BILLING_ONLY]: identity(),
        },
        instructorAccounts: {
            [OWNER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [INSTRUCTOR_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [INSTRUCTOR_A2]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [INSTRUCTOR_B]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [OUTSIDER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            // Live instructor whose tenant is neither legacy-compatible nor
            // entitled: the shared auth marks the principal `billingOnly` and
            // refuses every non-billing path before this handler runs.
            [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [INSTRUCTOR_A]: [TENANT_A],
            [INSTRUCTOR_A2]: [TENANT_A],
            [INSTRUCTOR_B]: [TENANT_B],
            [OUTSIDER_A]: [TENANT_A],
            [BILLING_ONLY]: [TENANT_A],
        },
        memberRoles: {
            [OWNER_A]: { [TENANT_A]: 'owner' },
            [INSTRUCTOR_A]: { [TENANT_A]: 'instructor' },
            [INSTRUCTOR_A2]: { [TENANT_A]: 'instructor' },
            [INSTRUCTOR_B]: { [TENANT_B]: 'instructor' },
            [OUTSIDER_A]: { [TENANT_A]: 'student' },
            [BILLING_ONLY]: { [TENANT_A]: 'instructor' },
        },
        tenants: {
            [TENANT_A]: { status: 'active', legacy_compat: 1, subscription_entitles: 1 },
            [TENANT_B]: { status: 'active', legacy_compat: 1, subscription_entitles: 1 },
        },
        groups: [
            // A legacy row: a JSON array with a duplicate and an unknown key.
            {
                id: GROUP_A1, name: 'Algebra A', description: 'Evening group',
                course_id: COURSE_A, grade_id: GRADE_1, instructor_id: INSTRUCTOR_A,
                max_students: 25, current_students: 7, is_active: 1,
                schedule_days: ['mon', 'sat', 'sat', 'funday'],
                schedule_time: '18:30:00',
            },
            {
                id: GROUP_A2, name: 'Geometry B', description: null,
                course_id: null, grade_id: null, instructor_id: INSTRUCTOR_A,
                max_students: 30, current_students: 0, is_active: 1,
                schedule_days: null, schedule_time: null,
            },
            {
                id: GROUP_A3, name: 'Other Instructor', description: null,
                course_id: null, grade_id: null, instructor_id: INSTRUCTOR_A2,
                max_students: 30, current_students: 0, is_active: 1,
                schedule_days: ['sun'], schedule_time: '09:00:00',
            },
            {
                id: GROUP_B1, name: 'Foreign Group', description: null,
                course_id: null, grade_id: null, instructor_id: INSTRUCTOR_B,
                max_students: 30, current_students: 0, is_active: 1,
                schedule_days: ['fri'], schedule_time: '20:00:00',
            },
            {
                id: GROUP_ARCHIVED, name: 'Archived Group', description: null,
                course_id: null, grade_id: null, instructor_id: INSTRUCTOR_A,
                max_students: 30, current_students: 0, is_active: 0,
                schedule_days: ['tue'], schedule_time: '07:15:00',
            },
        ],
        courses: [
            { id: COURSE_A, tenant_id: TENANT_A, is_active: 1 },
            { id: COURSE_A_ARCHIVED, tenant_id: TENANT_A, is_active: 0 },
            { id: COURSE_B, tenant_id: TENANT_B, is_active: 1 },
        ],
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
        memberLockDenies: false,
        affectedRowsOverride: null,
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

    const hasActiveMembership = (userId: string, tenantId: string) =>
        (state.memberships[userId] ?? []).includes(tenantId);

    /** Reads the WHERE predicate back out of the emitted SQL, in textual order. */
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

    /** Writes staged inside the open transaction, applied only at COMMIT. */
    let pendingInsert: GroupRow | null = null;
    let pendingUpdate: { id: string; fields: Partial<GroupRow> } | null = null;
    let pendingAudit: Call[] = [];

    const connectionExecute = async (sql: string, params: any[]): Promise<[any, any]> => {
        const n = squash(sql);
        calls.push({ sql, params });

        if (n === MEMBER_LOCK_SELECT) {
            events.push('member');
            if (state.failMemberLock) throw new Error('membership lock failed: internal detail leaked');
            const [userId, tenantId] = params.map(String);
            const roleKey = state.memberRoles[userId]?.[tenantId];
            const user = state.users[userId];
            const tenant = state.tenants[tenantId];
            if (!roleKey || !user || !tenant || !hasActiveMembership(userId, tenantId)) return [[], []];
            return [[{
                role_key: state.memberLockDenies ? 'student' : roleKey,
                caller_active: user.is_active,
                tenant_status: tenant.status,
            }], []];
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
            const affected = state.affectedRowsOverride ?? 1;
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
            return [{ affectedRows: affected }, []];
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
                // The acknowledgement succeeded: only now do the staged writes land.
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

    /** The non-transactional adapters the bounded reads and selector checks use. */
    activeFixture.db = {
        query: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n.startsWith(SELECT_PREFIX) && n.endsWith('ORDER BY g.name')) {
                const where = n.slice(SELECT_PREFIX.length, n.length - ' ORDER BY g.name'.length);
                return selectGroups(where, params)
                    .slice()
                    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            }
            throw new Error(`Unhandled group query in hermetic fixture: ${n}`);
        },
        queryOne: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });

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
                const scopedWhere = where.replace('g.id=? AND ', '');
                const matches = selectGroups(scopedWhere, params.slice(1));
                const wanted = String(params[0]);
                return matches.find((row) => row.id === wanted) ?? null;
            }

            if (n.startsWith(OWNERSHIP_SELECT_PREFIX) && n.endsWith(' LIMIT 1')) {
                const where = n.slice(OWNERSHIP_SELECT_PREFIX.length, n.length - ' LIMIT 1'.length);
                const matches = selectGroups(where, params.slice(1));
                const wanted = String(params[0]);
                return matches.some((row) => row.id === wanted) ? { id: wanted } : null;
            }

            throw new Error(`Unhandled group queryOne in hermetic fixture: ${n}`);
        },
        execute: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n === DELETE_SQL) {
                const id = String(params[0]);
                const index = state.groups.findIndex((row) => row.id === id);
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

    /**
     * The entitlement guard's repository seam: the real middleware and the
     * real `evaluateTeachingEntitlement` consume exactly these rows.
     */
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
    body?: any;
}

function makeReq(opts: ReqOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const pathName = opts.pathName ?? '/';
    return {
        method: opts.method ?? 'GET',
        url: pathName,
        originalUrl: `/api/groups${pathName === '/' ? '' : pathName}`,
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

const sign = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m' });

/** A verified instructor of tenant A: the scope the route derives from the token. */
const instructorToken = (extra: Record<string, unknown> = {}) =>
    sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_A, ...extra });

const withState = async <T>(mutate: (state: State) => void, fn: (state: State) => Promise<T>): Promise<T> => {
    const state = makeState();
    mutate(state);
    return fn(state);
};

const groupOf = (state: State, id: string): GroupRow | undefined => state.groups.find((row) => row.id === id);

const DTO_KEYS = [
    'id', 'name', 'description', 'course_id', 'grade_id',
    'max_students', 'current_students', 'is_active', 'schedule_days', 'schedule_time',
].sort();

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

    // The leaf data boundaries must never be evaluated or cached: their whole
    // module body is what this suite replaces.
    for (const specifier of ['../src/db', '../src/security/principal-repository']) {
        const intercepted = sentinelByPath.get(normalize(require.resolve(specifier)))!;
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

    // The entitlement guard is real production code, loaded on purpose, and
    // the route must have received the repository-injected variant.
    const teaching = sentinelByPath.get(normalize(require.resolve('../src/middleware/teaching-access')))!;
    assert.ok(interceptionLog.includes(teaching.id), 'the route must resolve the injected entitlement guard');
    assert.notEqual(teaching.exports, undefined);

    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
});

// ---------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------

test('list: one canonical bounded projection, canonical day order, HH:mm from a TIME echo', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: instructorToken() }));

        assert.equal(result.status, 200);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.ok(Array.isArray(result.body));

        // Only the caller's own active groups, ordered by name.
        assert.deepEqual(result.body.map((g: any) => g.id), [GROUP_A1, GROUP_A2]);

        const [first, second] = result.body;
        assert.deepEqual(Object.keys(first).sort(), DTO_KEYS, 'the DTO carries exactly ten fields');

        // Legacy duplicate + unknown key are dropped, and the surviving keys are
        // re-emitted in the single canonical order.
        assert.deepEqual(first.schedule_days, ['sat', 'mon']);
        assert.equal(first.schedule_time, '18:30');
        assert.deepEqual(second.schedule_days, []);
        assert.equal(second.schedule_time, null);
        assert.equal(first.max_students, 25);
        assert.equal(first.current_students, 7);
        assert.equal(first.is_active, true);
    });
});

test('list: an instructor never sees another instructor or another tenant', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const own = await runChain(harness.chain, makeReq({ token: instructorToken() }));
        const otherInstructor = await runChain(harness.chain, makeReq({
            token: sign(INSTRUCTOR_A2, 'instructor', { tenant_id: TENANT_A }),
        }));

        assert.deepEqual(own.body.map((g: any) => g.id), [GROUP_A1, GROUP_A2]);
        assert.deepEqual(otherInstructor.body.map((g: any) => g.id), [GROUP_A3]);

        const all = JSON.stringify([own.body, otherInstructor.body]);
        assert.equal(all.includes(GROUP_B1), false, 'a group of another tenant must never appear');
        assert.equal(all.includes(GROUP_ARCHIVED), false, 'an inactive group must never appear');
    });
});

test('list/detail: an unresolved selected tenant is refused before any group query', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        // The token selects tenant B, but the caller has no membership there,
        // so the server resolves no tenant. There is no tenant boundary to
        // read inside, so both private reads must refuse rather than fall back
        // to instructor-only rows from tenant A.
        const token = sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_B });

        const list = await runChain(harness.chain, makeReq({ token }));
        assert.equal(list.status, 404);
        assert.deepEqual(list.body, { error: 'Tenant membership not found' });
        assert.equal(list.headers['cache-control'], 'no-store');

        const detail = await runChain(harness.chain, makeReq({ token, pathName: `/${GROUP_A1}` }));
        assert.equal(detail.status, 404);
        assert.deepEqual(detail.body, { error: 'Tenant membership not found' });
        assert.equal(detail.headers['cache-control'], 'no-store');

        // No group SELECT (nor any other statement) ran, and no stored value
        // from either tenant was disclosed.
        assert.deepEqual(harness.calls, [], 'no SQL runs for an unresolved selected tenant');
        assert.equal(harness.connectionCount(), 0);
        assert.equal(JSON.stringify([list.body, detail.body]).includes(GROUP_A1), false);
        assert.equal(JSON.stringify([list.body, detail.body]).includes(GROUP_B1), false);

        // A write, by contrast, has no tenant authority at all and is refused
        // before any connection is taken.
        const write = await runChain(harness.chain, makeReq({
            token,
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { schedule_time: '10:00' },
        }));
        assert.equal(write.status, 403);
        assert.deepEqual(write.body, { error: 'Teaching access is not active for the selected tenant' });
        assert.equal(groupOf(state, GROUP_A1)!.schedule_time, '18:30:00');
    });
});

test('list: an unauthenticated read is refused and discloses nothing', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: null }));
        assert.equal(result.status, 401);
        assert.deepEqual(result.body, { error: 'No token provided' });
        assert.equal(JSON.stringify(result.body).includes(GROUP_A1), false);
        assert.equal(harness.connectionCount(), 0);
    });
});

test('detail: one owned group in the bounded canonical projection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            pathName: `/${GROUP_A1}`,
        }));

        assert.equal(result.status, 200);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(result.body).sort(), DTO_KEYS);
        assert.equal(result.body.id, GROUP_A1);
        assert.deepEqual(result.body.schedule_days, ['sat', 'mon']);
        assert.equal(result.body.schedule_time, '18:30');
    });
});

test('detail: a foreign group is indistinguishable from a missing one', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const foreign = await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${GROUP_B1}` }));
        const otherInstructor = await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${GROUP_A3}` }));
        const absent = await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${ABSENT_GROUP}` }));
        const archived = await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${GROUP_ARCHIVED}` }));

        for (const result of [foreign, otherInstructor, absent, archived]) {
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Group not found' });
            assert.equal(result.headers['cache-control'], 'no-store');
        }
        assert.deepEqual(foreign.body, absent.body, 'no cross-tenant existence is disclosed');
        assert.deepEqual(otherInstructor.body, absent.body, 'no cross-instructor existence is disclosed');
    });
});

test('detail: a non-uuid id is a 404 before any query runs', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: '/not-a-uuid' }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Group not found' });
        assert.deepEqual(harness.calls, [], 'no SQL runs for a malformed selector');
    });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test('create: 201 with the exact DTO, canonical days and one sanitized audit event', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'POST',
            body: {
                name: '  Physics A  ',
                description: 'Intro group',
                course_id: COURSE_A,
                grade_id: GRADE_1,
                max_students: 20,
                schedule_days: ['mon', 'sat'],
                schedule_time: '17:05',
            },
        }));

        assert.equal(result.status, 201);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(result.body).sort(), DTO_KEYS);
        assert.equal(result.body.name, 'Physics A', 'the name is trimmed');
        assert.deepEqual(result.body.schedule_days, ['sat', 'mon'], 'days are stored in canonical order');
        assert.equal(result.body.schedule_time, '17:05');
        assert.equal(result.body.current_students, 0);
        assert.equal(result.body.is_active, true);

        // Exactly one group row and exactly one audit event.
        assert.equal(state.groups.filter((g) => g.name === 'Physics A').length, 1);
        assert.equal(harness.auditRows.length, 1);
        const audit = harness.auditRows[0];
        assert.equal(audit.params[1], INSTRUCTOR_A, 'the actor is the authenticated caller');
        assert.equal(audit.params[2], TENANT_A, 'the tenant is the server-derived selection');
        assert.equal(audit.params[3], 'group.created');
        assert.equal(audit.params[4], 'group');
        assert.equal(audit.params[5], result.body.id);
        assert.equal(audit.params[6], null);
        assert.equal(audit.params[7], JSON.stringify({ schedule_days: ['sat', 'mon'], schedule_time: '17:05' }));
        assert.deepEqual(harness.events, ['begin', 'member', 'insert', 'audit', 'commit', 'release']);
        assert.equal(harness.commitCount(), 1);
        assert.equal(harness.releaseCount(), 1);
        assert.equal(harness.destroyCount(), 0);
    });
});

test('create: an explicit null stores the empty canonical schedule', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'POST',
            body: { name: 'No Schedule', schedule_days: null, schedule_time: null },
        }));

        assert.equal(result.status, 201);
        assert.deepEqual(result.body.schedule_days, []);
        assert.equal(result.body.schedule_time, null);
        assert.equal(harness.auditRows[0].params[7], JSON.stringify({ schedule_days: [], schedule_time: null }));
    });
});

test('create: an omitted schedule stores the empty canonical defaults', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'POST',
            body: { name: 'Bare Group' },
        }));

        assert.equal(result.status, 201);
        assert.deepEqual(result.body.schedule_days, []);
        assert.equal(result.body.schedule_time, null);
        assert.equal(result.body.max_students, 30, 'the existing default is preserved');
    });
});

test('create: every malformed weekday shape is refused', async () => {
    const malformed: any[] = [
        'mon',
        { day: 'mon' },
        42,
        true,
        ['funday'],
        ['MON'],
        ['mon', 'mon'],
        ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'extra'],
        [null],
        ['mon', 1],
    ];
    for (const schedule_days of malformed) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const before = state.groups.length;
            const result = await runChain(harness.chain, makeReq({
                token: instructorToken(),
                method: 'POST',
                body: { name: 'Bad Days', schedule_days },
            }));

            assert.equal(result.status, 400, `schedule_days ${JSON.stringify(schedule_days)} must be refused`);
            assert.deepEqual(result.body, { error: 'Invalid schedule days' });
            assert.equal(harness.connectionCount(), 0, 'no connection is taken for a malformed body');
            assert.equal(state.groups.length, before, 'no group is created');
        });
    }
});

test('create: only a real 24-hour HH:mm or null is accepted as a time', async () => {
    const malformed: any[] = [
        '7:30', '17:5', '24:00', '23:60', '17:05:00', '1705', '', ' noon', '17:05 ', 1705, true, [], {},
    ];
    for (const schedule_time of malformed) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, makeReq({
                token: instructorToken(),
                method: 'POST',
                body: { name: 'Bad Time', schedule_time },
            }));

            assert.equal(result.status, 400, `schedule_time ${JSON.stringify(schedule_time)} must be refused`);
            assert.deepEqual(result.body, { error: 'Invalid schedule time' });
            assert.equal(harness.connectionCount(), 0);
        });
    }
});

test('create: a foreign, archived or absent course selector is rejected, never silently nulled', async () => {
    for (const courseId of [COURSE_B, COURSE_A_ARCHIVED, ABSENT_COURSE]) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const before = state.groups.length;
            const result = await runChain(harness.chain, makeReq({
                token: instructorToken(),
                method: 'POST',
                body: { name: 'Selector Group', course_id: courseId },
            }));

            assert.equal(result.status, 400, `course ${courseId} must be refused`);
            assert.deepEqual(result.body, { error: 'Invalid course selector' });
            assert.equal(harness.connectionCount(), 0, 'the selector is validated before any write transaction');
            assert.equal(state.groups.length, before);
        });
    }
});

test('create: an absent grade selector is rejected', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'POST',
            body: { name: 'Selector Group', grade_id: ABSENT_GRADE },
        }));

        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: 'Invalid grade selector' });
        assert.equal(harness.connectionCount(), 0);
    });
});

test('create: unknown keys, a missing name and out-of-range scalars are refused', async () => {
    const malformed: any[] = [
        {},
        { name: '   ' },
        { name: 'x'.repeat(256) },
        { name: 'Group', tenant_id: TENANT_B },
        { name: 'Group', instructor_id: INSTRUCTOR_A2 },
        { name: 'Group', id: GROUP_A1 },
        { name: 'Group', max_students: 0 },
        { name: 'Group', max_students: 1001 },
        { name: 'Group', max_students: 12.5 },
        { name: 'Group', max_students: '20' },
        { name: 'Group', is_active: 1 },
        { name: 'Group', description: 'x'.repeat(2001) },
        { name: 'Group', course_id: 'not-a-uuid' },
        { name: 'Group', grade_id: 7 },
    ];
    for (const body of malformed) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const before = state.groups.length;
            const result = await runChain(harness.chain, makeReq({
                token: instructorToken(),
                method: 'POST',
                body,
            }));

            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be refused`);
            assert.equal(result.headers['cache-control'], 'no-store');
            assert.equal(harness.connectionCount(), 0);
            assert.equal(state.groups.length, before);
        });
    }
});

test('create: a non-teaching member is denied before any connection is taken', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const before = state.groups.length;
        const result = await runChain(harness.chain, makeReq({
            token: sign(OUTSIDER_A, 'instructor', { tenant_id: TENANT_A }),
            method: 'POST',
            body: { name: 'Denied Group' },
        }));

        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { error: 'Teaching access is not active for the selected tenant' });
        assert.equal(harness.connectionCount(), 0);
        assert.equal(state.groups.length, before);
    });
});

test('create: a billed-out instructor is refused by the shared auth before the handler runs', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: sign(BILLING_ONLY, 'instructor', { tenant_id: TENANT_A }),
            method: 'POST',
            body: { name: 'Billed Group' },
        }));

        assert.equal(result.status, 403);
        assert.equal(result.body.code, 'BILLING_ONLY');
        assert.equal(harness.connectionCount(), 0);
    });
});

// ---------------------------------------------------------------------------
// Update — canonical write, omission, clear, no-op
// ---------------------------------------------------------------------------

test('update: changing days and time writes once and audits the schedule transition', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { schedule_days: ['wed', 'sat'], schedule_time: '19:00' },
        }));

        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body).sort(), DTO_KEYS);
        assert.deepEqual(result.body.schedule_days, ['sat', 'wed']);
        assert.equal(result.body.schedule_time, '19:00');

        const stored = groupOf(state, GROUP_A1)!;
        assert.equal(stored.schedule_days, JSON.stringify(['sat', 'wed']));
        assert.equal(stored.schedule_time, '19:00');

        assert.equal(harness.auditRows.length, 1);
        const audit = harness.auditRows[0];
        assert.equal(audit.params[3], 'group.schedule_updated');
        assert.equal(audit.params[4], 'group');
        assert.equal(audit.params[5], GROUP_A1);
        assert.equal(audit.params[6], JSON.stringify({ schedule_days: ['sat', 'mon'], schedule_time: '18:30' }));
        assert.equal(audit.params[7], JSON.stringify({ schedule_days: ['sat', 'wed'], schedule_time: '19:00' }));
        assert.deepEqual(harness.events, ['begin', 'member', 'group-lock', 'update', 'audit', 'commit', 'release']);
        assert.equal(harness.commitCount(), 1);
        assert.equal(harness.releaseCount(), 1);
    });
});

test('update: an absent schedule key keeps the stored value (omission is not a clear)', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { name: 'Algebra A (renamed)' },
        }));

        assert.equal(result.status, 200);
        assert.equal(result.body.name, 'Algebra A (renamed)');
        assert.deepEqual(result.body.schedule_days, ['sat', 'mon'], 'the stored days survive an unrelated edit');
        assert.equal(result.body.schedule_time, '18:30', 'the stored time survives an unrelated edit');
        assert.equal(harness.auditRows[0].params[3], 'group.updated', 'a non-schedule edit is not a schedule event');
    });
});

test('update: an explicit null clears both schedule fields', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { schedule_days: null, schedule_time: null },
        }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.schedule_days, []);
        assert.equal(result.body.schedule_time, null);

        const stored = groupOf(state, GROUP_A1)!;
        assert.equal(stored.schedule_days, JSON.stringify([]));
        assert.equal(stored.schedule_time, null);

        assert.equal(harness.auditRows[0].params[3], 'group.schedule_updated');
        assert.equal(harness.auditRows[0].params[7], JSON.stringify({ schedule_days: [], schedule_time: null }));
    });
});

test('update: an identical retry is a truthful no-op — nothing written, nothing audited', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            // Same canonical days in a different input order, same time.
            body: { schedule_days: ['sat', 'mon'], schedule_time: '18:30' },
        }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.schedule_days, ['sat', 'mon']);
        assert.equal(result.body.schedule_time, '18:30');

        assert.equal(harness.auditRows.length, 0, 'an identical retry audits nothing');
        assert.equal(harness.commitCount(), 0, 'an identical retry commits nothing');
        assert.equal(harness.rollbackCount(), 1);
        assert.equal(harness.releaseCount(), 1);
        assert.deepEqual(harness.events, ['begin', 'member', 'group-lock', 'rollback', 'release']);
    });
});

test('update: a cleared schedule cleared again is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A2}`,
            body: { schedule_days: null, schedule_time: null },
        }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.schedule_days, []);
        assert.equal(result.body.schedule_time, null);
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0);
    });
});

test('update: the same malformed weekday/time rules apply', async () => {
    const bodies: any[] = [
        { schedule_days: ['mon', 'mon'] },
        { schedule_days: ['funday'] },
        { schedule_days: 'mon' },
        { schedule_time: '18:30:00' },
        { schedule_time: '25:00' },
        { schedule_days: ['sat'], unknown_key: true },
    ];
    for (const body of bodies) {
        await withState(() => undefined, async (state) => {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, makeReq({
                token: instructorToken(),
                method: 'PUT',
                pathName: `/${GROUP_A1}`,
                body,
            }));

            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be refused`);
            assert.equal(harness.connectionCount(), 0);
            assert.deepEqual(groupOf(state, GROUP_A1)!.schedule_days, ['mon', 'sat', 'sat', 'funday'], 'the row is untouched');
        });
    }
});

test('update: a foreign course selector is rejected instead of nulling the stored one', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { course_id: COURSE_B },
        }));

        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: 'Invalid course selector' });
        assert.equal(harness.connectionCount(), 0);
        assert.equal(groupOf(state, GROUP_A1)!.course_id, COURSE_A, 'the stored course is preserved');
    });
});

// ---------------------------------------------------------------------------
// Update — target and authority boundaries
// ---------------------------------------------------------------------------

test('update: a foreign group is indistinguishable from a missing one', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const foreign = await runChain(harness.chain, makeReq({
            token: instructorToken(), method: 'PUT', pathName: `/${GROUP_B1}`, body: { schedule_time: '10:00' },
        }));
        const absent = await runChain(harness.chain, makeReq({
            token: instructorToken(), method: 'PUT', pathName: `/${ABSENT_GROUP}`, body: { schedule_time: '10:00' },
        }));

        assert.equal(foreign.status, 404);
        assert.equal(absent.status, 404);
        assert.deepEqual(foreign.body, absent.body);
        assert.deepEqual(absent.body, { error: 'Group not found' });
        assert.equal(groupOf(state, GROUP_B1)!.schedule_time, '20:00:00', 'the foreign row is untouched');
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0);
    });
});

test('update: an instructor cannot write another instructor group in the same tenant', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A3}`,
            body: { schedule_time: '10:00' },
        }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Group not found' });
        assert.equal(groupOf(state, GROUP_A3)!.schedule_time, '09:00:00');
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0);
    });
});

test('update: a non-uuid id is a 404 before any query runs', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(), method: 'PUT', pathName: '/nope', body: { schedule_time: '10:00' },
        }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Group not found' });
        assert.deepEqual(harness.calls, []);
    });
});

test('update: authority is revalidated on the same connection inside the transaction', async () => {
    await withState((state) => { state.memberLockDenies = true; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { schedule_time: '10:00' },
        }));

        // The entitlement guard passed on its own read; the transactional
        // re-read is the defence-in-depth boundary that stops the write.
        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { error: 'Teaching access is not active for the selected tenant' });
        assert.equal(groupOf(state, GROUP_A1)!.schedule_time, '18:30:00');
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0);
        assert.equal(harness.rollbackCount(), 1);
        assert.deepEqual(harness.events, ['begin', 'member', 'rollback', 'release']);
    });
});

test('update: a lost row is reported as not found, not as a successful write', async () => {
    await withState((state) => { state.affectedRowsOverride = 0; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({
            token: instructorToken(),
            method: 'PUT',
            pathName: `/${GROUP_A1}`,
            body: { schedule_time: '10:00' },
        }));

        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Group not found' });
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.commitCount(), 0);
        assert.equal(harness.rollbackCount(), 1);
        assert.equal(harness.releaseCount(), 1);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting guarantees
// ---------------------------------------------------------------------------

test('delete: only an owned group is deleted, and a foreign one is a 404', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const foreign = await runChain(harness.chain, makeReq({
            token: instructorToken(), method: 'DELETE', pathName: `/${GROUP_B1}`,
        }));
        const otherInstructor = await runChain(harness.chain, makeReq({
            token: instructorToken(), method: 'DELETE', pathName: `/${GROUP_A3}`,
        }));
        assert.equal(foreign.status, 404);
        assert.equal(otherInstructor.status, 404);
        assert.ok(groupOf(state, GROUP_B1));
        assert.ok(groupOf(state, GROUP_A3));

        const own = await runChain(harness.chain, makeReq({
            token: instructorToken(), method: 'DELETE', pathName: `/${GROUP_A2}`,
        }));
        assert.equal(own.status, 200);
        assert.equal(groupOf(state, GROUP_A2), undefined);
    });
});

test('projection: no stored value, tenant or instructor leaks into a response', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const list = await runChain(harness.chain, makeReq({ token: instructorToken() }));
        const detail = await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${GROUP_A1}` }));
        const text = JSON.stringify([list.body, detail.body]);

        assert.equal(text.includes(INSTRUCTOR_A), false, 'the owning instructor id must not leak');
        assert.equal(text.includes(TENANT_A), false, 'the tenant id must not leak');
        assert.equal(text.includes('funday'), false, 'an unknown legacy day must not be echoed');
        assert.equal(text.includes('instructor_id'), false);
        assert.equal(text.includes('18:30:00'), false, 'the TIME echo is normalised away');
    });
});

test('every handler outcome carries Cache-Control no-store', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        // Sequential: one harness shares the transaction staging buffers.
        const outcomes = [
            await runChain(harness.chain, makeReq({ token: instructorToken() })),
            await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${GROUP_A1}` })),
            await runChain(harness.chain, makeReq({ token: instructorToken(), pathName: `/${ABSENT_GROUP}` })),
            await runChain(harness.chain, makeReq({ token: instructorToken(), method: 'POST', body: { name: 'X' } })),
            await runChain(harness.chain, makeReq({ token: instructorToken(), method: 'POST', body: {} })),
            await runChain(harness.chain, makeReq({
                token: instructorToken(), method: 'PUT', pathName: `/${GROUP_A1}`, body: { schedule_days: ['mon', 'mon'] },
            })),
        ];
        for (const result of outcomes) {
            assert.equal(result.headers['cache-control'], 'no-store');
            assert.equal(result.responseCount, 1, 'exactly one response per request');
        }
    });
});
