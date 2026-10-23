/**
 * M2-21 — private group announcements (hermetic, behavioral).
 *
 * Contract under test: `GET|POST /api/groups/:groupId/announcements`,
 * `PUT /api/groups/:groupId/announcements/:announcementId` and
 * `POST /api/groups/:groupId/announcements/:announcementId/retract` manage a
 * PRIVATE, bounded announcement lifecycle for a group the caller already owns
 * inside the tenant the SERVER selected.
 *
 * Every test here also pins the boundary: the surface sends nothing (no email,
 * SMS or push), schedules nothing (no publish-at, expiry or timezone policy),
 * exposes nothing to a student principal, and creates no session, attendance,
 * enrollment, access, role or billing effect.
 *
 * Composition under test is the real production order: the real
 * `optionalAuth`/`authenticateToken` over the real principal resolver, the real
 * `requireTeachingWrite('groups')` entitlement guard, and the real router from
 * `src/routes/groups.ts`. Only leaf data boundaries are injected fixtures: the
 * `src/db` adapters, the entitlement guard's repository seam
 * (`createRequireTeachingWrite(area, repository)`, the module's own documented
 * injection point — the entitlement DECISION stays the real one) and the
 * `src/security/principal-repository` identity lookups. No express listener,
 * socket, fetch, DB, provider or app startup.
 *
 * The fake transaction BUFFERS the row write and the audit and applies them only
 * at COMMIT, so a rolled-back or uncertain transaction can be proven to leave
 * ZERO partial writes. The read-back overlays the buffered row, exactly as a
 * real transaction sees its own change.
 *
 * Live MySQL row-level locking, real concurrency, real index usage and real HTTP
 * transport are explicitly NOT exercised or claimed.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';

const TEST_SECRET = 'm2-21-hermetic-jwt-secret-not-a-real-key';
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
 * The entitlement guard is real; only its repository seam is injected. The real
 * module is loaded BEFORE the loader hook is installed, and the sentinel
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

const ANN_A1 = 'a0000001-0000-4000-8000-000000000001';
const ANN_A2 = 'a0000002-0000-4000-8000-000000000002';
const ANN_A3 = 'a0000003-0000-4000-8000-000000000003';
const ANN_B1 = 'b0000001-0000-4000-8000-000000000001';
const ABSENT_ANN = 'cccccccc-0000-4000-8000-000000000002';

interface GroupRow {
    id: string;
    name: string;
    instructor_id: string;
    is_active: number;
}

interface AnnouncementRow {
    id: string;
    tenant_id: string;
    instructor_id: string;
    group_id: string;
    title: string;
    body: string;
    state: string;
    created_at: string;
    updated_at: string;
    retracted_at: string | null;
}

interface State {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    memberRoles: Record<string, Record<string, string>>;
    tenants: Record<string, { status: string; legacy_compat: number; subscription_entitles: number }>;
    groups: GroupRow[];
    announcements: AnnouncementRow[];
    failAcquire: boolean;
    failBegin: boolean;
    failMemberLock: boolean;
    failGroupLock: boolean;
    failGroupScope: boolean;
    failList: boolean;
    failAnnouncementLock: boolean;
    failInsert: boolean;
    failUpdate: boolean;
    failRetract: boolean;
    failAudit: boolean;
    failReadBack: boolean;
    emptyReadBack: boolean;
    failCommit: boolean;
    failRollback: boolean;
    failRelease: boolean;
    failDestroy: boolean;
    affectedRowsOverride: number | null;
    memberLockDenies: boolean;
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
            { id: GROUP_A1, name: 'Algebra A', instructor_id: INSTRUCTOR_A, is_active: 1 },
            { id: GROUP_A2, name: 'Geometry B', instructor_id: INSTRUCTOR_A, is_active: 1 },
            { id: GROUP_A3, name: 'Other Instructor', instructor_id: INSTRUCTOR_A2, is_active: 1 },
            { id: GROUP_B1, name: 'Foreign Group', instructor_id: INSTRUCTOR_B, is_active: 1 },
            { id: GROUP_ARCHIVED, name: 'Archived Group', instructor_id: INSTRUCTOR_A, is_active: 0 },
        ],
        announcements: [
            {
                id: ANN_A1, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: GROUP_A1,
                title: 'First session', body: 'Bring the workbook.',
                state: 'draft',
                created_at: '2026-10-21 08:00:00', updated_at: '2026-10-21 08:00:00', retracted_at: null,
            },
            {
                id: ANN_A2, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: GROUP_A1,
                title: 'Exam reminder', body: 'The exam is on Sunday.',
                state: 'published',
                created_at: '2026-10-21 09:00:00', updated_at: '2026-10-21 09:30:00', retracted_at: null,
            },
            {
                id: ANN_A3, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: GROUP_A1,
                title: 'Cancelled class', body: 'No class today.',
                state: 'retracted',
                created_at: '2026-10-21 10:00:00', updated_at: '2026-10-21 10:05:00', retracted_at: '2026-10-21 10:05:00',
            },
            {
                id: ANN_B1, tenant_id: TENANT_B, instructor_id: INSTRUCTOR_B, group_id: GROUP_B1,
                title: 'Foreign announcement', body: 'Not yours.',
                state: 'published',
                created_at: '2026-10-21 11:00:00', updated_at: '2026-10-21 11:00:00', retracted_at: null,
            },
        ],
        failAcquire: false,
        failBegin: false,
        failMemberLock: false,
        failGroupLock: false,
        failGroupScope: false,
        failList: false,
        failAnnouncementLock: false,
        failInsert: false,
        failUpdate: false,
        failRetract: false,
        failAudit: false,
        failReadBack: false,
        emptyReadBack: false,
        failCommit: false,
        failRollback: false,
        failRelease: false,
        failDestroy: false,
        affectedRowsOverride: null,
        memberLockDenies: false,
    };
}

interface Call { sql: string; params: any[] }

const ANN_COLUMNS = 'a.id,a.group_id,a.title,a.body,a.state,a.created_at,a.updated_at,a.retracted_at';
const ANN_LIST_SQL =
    `SELECT ${ANN_COLUMNS} FROM group_announcements a ` +
    'WHERE a.group_id=? AND a.tenant_id=? AND a.id>? ORDER BY a.id ASC LIMIT ?';
const ANN_LOCK_SQL =
    `SELECT ${ANN_COLUMNS} FROM group_announcements a ` +
    'WHERE a.id=? AND a.group_id=? AND a.tenant_id=? FOR UPDATE';
const ANN_READ_SQL =
    `SELECT ${ANN_COLUMNS} FROM group_announcements a ` +
    'WHERE a.id=? AND a.group_id=? AND a.tenant_id=? LIMIT 1';
const ANN_INSERT_SQL =
    'INSERT INTO group_announcements (id,tenant_id,instructor_id,group_id,title,body,state) VALUES (?,?,?,?,?,?,?)';
const ANN_UPDATE_SQL =
    'UPDATE group_announcements SET title=?,body=?,state=?,retracted_at=?,updated_at=CURRENT_TIMESTAMP ' +
    'WHERE id=? AND group_id=? AND tenant_id=?';
const ANN_RETRACT_SQL =
    "UPDATE group_announcements SET state='retracted',retracted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP " +
    "WHERE id=? AND group_id=? AND tenant_id=? AND state<>'retracted'";
const MEMBER_LOCK_SELECT =
    'SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.tenant_id=? AND m.status=\'active\' LIMIT 1 FOR UPDATE';
const GROUP_LOCK_PREFIX =
    'SELECT g.id,g.name,g.description,g.course_id,g.grade_id,g.max_students,g.current_students,g.is_active,g.schedule_days,g.schedule_time FROM `groups` g JOIN tenant_memberships tm ON tm.user_id=g.instructor_id AND tm.tenant_id=? AND tm.status=\'active\' WHERE g.id=?';
const GROUP_SCOPE_PREFIX = 'SELECT g.id FROM `groups` g WHERE g.id=? AND ';
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

    const scopedGroupIds = (where: string, params: any[]): Set<string> => {
        const { tenantId, scopeId } = readPredicate(where, params);
        return new Set(state.groups
            .filter((row) =>
                row.is_active === 1 &&
                (tenantId === null || hasActiveMembership(row.instructor_id, tenantId)) &&
                (scopeId === null || row.instructor_id === scopeId))
            .map((row) => row.id));
    };

    const groupById = (id: string) => state.groups.find((row) => row.id === id) ?? null;
    const announcementById = (id: string, groupId: string, tenantId: string) =>
        state.announcements.find((row) => row.id === id && row.group_id === groupId && row.tenant_id === tenantId) ?? null;

    /** Writes staged inside the open transaction, applied only at COMMIT. */
    let pendingInsert: AnnouncementRow | null = null;
    let pendingUpdate: { id: string; fields: Partial<AnnouncementRow> } | null = null;
    let pendingAudit: Call[] = [];

    /** What the CURRENT transaction sees: the buffered row overlays the stored one. */
    const visible = (row: AnnouncementRow): AnnouncementRow => {
        if (pendingUpdate && pendingUpdate.id === row.id) return { ...row, ...pendingUpdate.fields };
        return row;
    };

    const project = (row: AnnouncementRow) => {
        const effective = visible(row);
        return {
            id: effective.id,
            group_id: effective.group_id,
            title: effective.title,
            body: effective.body,
            state: effective.state,
            created_at: effective.created_at,
            updated_at: effective.updated_at,
            retracted_at: effective.retracted_at,
        };
    };

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
            return [[{ id: row.id, name: row.name, is_active: row.is_active }], []];
        }

        if (n === ANN_LOCK_SQL) {
            events.push('announcement-lock');
            if (state.failAnnouncementLock) throw new Error('announcement lock failed: internal detail leaked');
            const row = announcementById(String(params[0]), String(params[1]), String(params[2]));
            return [row ? [project(row)] : [], []];
        }

        if (n === ANN_INSERT_SQL) {
            events.push('insert');
            if (state.failInsert) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert into group_announcements failed');
            const [id, tenantId, instructorId, groupId, title, body, annState] = params;
            pendingInsert = {
                id: String(id),
                tenant_id: String(tenantId),
                instructor_id: String(instructorId),
                group_id: String(groupId),
                title: String(title),
                body: String(body),
                state: String(annState),
                created_at: '2026-10-23 09:15:00',
                updated_at: '2026-10-23 09:15:00',
                retracted_at: null,
            };
            return [{ affectedRows: 1 }, []];
        }

        if (n === ANN_UPDATE_SQL) {
            events.push('update');
            if (state.failUpdate) throw new Error('ER_LOCK_DEADLOCK: update on group_announcements failed');
            const [title, body, annState, retractedAt, id, groupId, tenantId] = params;
            const affected = state.affectedRowsOverride ?? 1;
            const existing = announcementById(String(id), String(groupId), String(tenantId));
            if (existing && affected === 1) {
                pendingUpdate = {
                    id: String(id),
                    fields: {
                        title: String(title),
                        body: String(body),
                        state: String(annState),
                        retracted_at: retractedAt === null ? null : String(retractedAt),
                        updated_at: '2026-10-23 10:30:00',
                    },
                };
            }
            return [{ affectedRows: affected }, []];
        }

        if (n === ANN_RETRACT_SQL) {
            events.push('retract');
            if (state.failRetract) throw new Error('ER_LOCK_WAIT_TIMEOUT: retract on group_announcements failed');
            const existing = announcementById(String(params[0]), String(params[1]), String(params[2]));
            const affected = state.affectedRowsOverride ?? (existing && existing.state !== 'retracted' ? 1 : 0);
            if (existing && affected === 1) {
                pendingUpdate = {
                    id: existing.id,
                    fields: {
                        state: 'retracted',
                        retracted_at: '2026-10-23 11:00:00',
                        updated_at: '2026-10-23 11:00:00',
                    },
                };
            }
            return [{ affectedRows: affected }, []];
        }

        if (n === ANN_READ_SQL) {
            events.push('read');
            if (state.failReadBack) throw new Error('read-back failed: internal detail leaked');
            if (state.emptyReadBack) return [[], []];
            if (pendingInsert && pendingInsert.id === String(params[0])) return [[project(pendingInsert)], []];
            const row = announcementById(String(params[0]), String(params[1]), String(params[2]));
            return [row ? [project(row)] : [], []];
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
                if (pendingInsert) state.announcements.push(pendingInsert);
                if (pendingUpdate) {
                    const row = state.announcements.find((item) => item.id === pendingUpdate!.id);
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

    poolHolder.pool = {
        getConnection: async () => {
            if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
            return makeConnection();
        },
    };

    /** The non-transactional adapters the bounded reads use. */
    activeFixture.db = {
        query: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n === ANN_LIST_SQL) {
                events.push('list');
                if (state.failList) throw new Error('announcement list failed: internal detail leaked');
                const [groupId, tenantId, afterId, limit] = params;
                return state.announcements
                    .filter((row) => row.group_id === groupId && row.tenant_id === tenantId && row.id > afterId)
                    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                    .slice(0, Number(limit))
                    .map(project);
            }
            throw new Error(`Unhandled group query in hermetic fixture: ${n}`);
        },
        queryOne: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
            if (n.startsWith(GROUP_SCOPE_PREFIX) && n.endsWith(' LIMIT 1')) {
                events.push('group-scope');
                if (state.failGroupScope) throw new Error('group scope read failed: internal detail leaked');
                const where = n.slice(GROUP_SCOPE_PREFIX.length, n.length - ' LIMIT 1'.length);
                const ids = scopedGroupIds(where, params.slice(1));
                const wanted = String(params[0]);
                return ids.has(wanted) ? { id: wanted } : null;
            }
            throw new Error(`Unhandled group queryOne in hermetic fixture: ${n}`);
        },
        execute: async (sql: string, params: any[]) => {
            const n = squash(sql);
            calls.push({ sql, params });
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
        chain: [routeModule.default as RequestHandler],
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
    query?: any;
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
        query: opts.query ?? {},
        // An explicitly supplied body is preserved verbatim — including `null`, `[]`
        // and primitives — because `express.json()` would hand the handler exactly
        // that value. Only an OMITTED body defaults to `{}`.
        body: 'body' in opts ? opts.body : {},
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

const announcementOf = (state: State, id: string): AnnouncementRow | undefined =>
    state.announcements.find((row) => row.id === id);

const DTO_KEYS = [
    'id', 'group_id', 'title', 'body', 'state', 'created_at', 'updated_at', 'retracted_at',
].sort();

const listPath = (groupId: string) => `/${groupId}/announcements`;
const itemPath = (groupId: string, announcementId: string) =>
    `/${groupId}/announcements/${announcementId}`;
const retractPath = (groupId: string, announcementId: string) =>
    `/${groupId}/announcements/${announcementId}/retract`;

const listReq = (groupId = GROUP_A1, query: any = {}, token = instructorToken()) =>
    makeReq({ token, method: 'GET', pathName: listPath(groupId), query });
const createReq = (body: any, groupId = GROUP_A1, token = instructorToken()) =>
    makeReq({ token, method: 'POST', pathName: listPath(groupId), body });
const updateReq = (announcementId: string, body: any, groupId = GROUP_A1, token = instructorToken()) =>
    makeReq({ token, method: 'PUT', pathName: itemPath(groupId, announcementId), body });
const retractReq = (announcementId: string, groupId = GROUP_A1, token = instructorToken()) =>
    makeReq({ token, method: 'POST', pathName: retractPath(groupId, announcementId), body: {} });

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => undefined;
    try { return await fn(); } finally { console.error = original; }
};

// ---------------------------------------------------------------------------
// Import isolation — positive evidence
// ---------------------------------------------------------------------------

test('import isolation: forbidden module bodies never evaluate, no dummy env', () => {
    assert.equal(loadError, null, `application modules must load through the sentinels: ${String(loadError)}`);
    assert.equal(process.env.MINIO_ACCESS_KEY, undefined);
    assert.equal(process.env.MINIO_SECRET_KEY, undefined);
    assert.equal(process.env.DB_HOST, undefined);

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
    assert.deepEqual(forbiddenCalls, [], 'no forbidden default adapter may be called');
});

// ---------------------------------------------------------------------------
// GET /:groupId/announcements — bounded list
// ---------------------------------------------------------------------------

test('list: the owner-scoped instructor reads a bounded page of one owned group', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, listReq());

        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body), ['announcements', 'next_cursor']);
        assert.deepEqual(
            result.body.announcements.map((row: any) => row.id),
            [ANN_A1, ANN_A2, ANN_A3],
            'every announcement of the owned group, including the retracted one',
        );
        assert.equal(result.body.next_cursor, null, 'a short page has no successor cursor');
        assert.equal(result.headers['cache-control'], 'no-store');

        const scopeCall = harness.calls[0];
        assert.equal(squash(scopeCall.sql).startsWith(GROUP_SCOPE_PREFIX), true);
        const listCall = harness.calls[1];
        assert.equal(squash(listCall.sql), ANN_LIST_SQL);
        assert.deepEqual(
            listCall.params,
            [GROUP_A1, TENANT_A, '', 26],
            'the page is tenant+group qualified, cursor-bounded and reads one extra row',
        );
        assert.equal(harness.connectionCount(), 0, 'a read takes no transactional connection');
    });
});

test('list: the projection is exactly the eight documented fields', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, listReq());

        for (const row of result.body.announcements) {
            assert.deepEqual(Object.keys(row).sort(), DTO_KEYS);
        }
        assert.deepEqual(result.body.announcements[0], {
            id: ANN_A1,
            group_id: GROUP_A1,
            title: 'First session',
            body: 'Bring the workbook.',
            state: 'draft',
            created_at: '2026-10-21 08:00:00',
            updated_at: '2026-10-21 08:00:00',
            retracted_at: null,
        });
        assert.equal(result.body.announcements[2].state, 'retracted');
        assert.equal(result.body.announcements[2].retracted_at, '2026-10-21 10:05:00');

        const text = JSON.stringify(result.body);
        assert.equal(text.includes(TENANT_A), false, 'tenant_id is never disclosed');
        assert.equal(text.includes(INSTRUCTOR_A), false, 'instructor_id is never disclosed');
        assert.equal(text.includes('Foreign announcement'), false, 'a foreign row is never listed');
    });
});

test('list: the page size defaults to 25 and a full page mints the next cursor', async () => {
    await withState((state) => {
        for (let index = 0; index < 40; index += 1) {
            state.announcements.push({
                id: `d0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: GROUP_A1,
                title: `Bulk ${index}`, body: 'body', state: 'draft',
                created_at: '2026-10-22 08:00:00', updated_at: '2026-10-22 08:00:00', retracted_at: null,
            });
        }
    }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, listReq());

        assert.equal(result.status, 200);
        assert.equal(result.body.announcements.length, 25, 'the default page is bounded to 25 rows');
        assert.equal(result.body.next_cursor, encodeCursor(result.body.announcements[24].id));
        const listCall = harness.calls.find((call) => squash(call.sql) === ANN_LIST_SQL);
        assert.deepEqual(listCall?.params, [GROUP_A1, TENANT_A, '', 26]);
    });
});

test('list: a cursor is only a position and never widens the group or tenant bound', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, listReq(GROUP_A1, { cursor: encodeCursor(ANN_B1) }));

        assert.equal(result.status, 200);
        assert.deepEqual(result.body.announcements, [], 'no row of this group sorts after a foreign id');
        assert.equal(JSON.stringify(result.body).includes(ANN_B1), false);
        const listCall = harness.calls.find((call) => squash(call.sql) === ANN_LIST_SQL);
        assert.deepEqual(listCall?.params, [GROUP_A1, TENANT_A, ANN_B1, 26]);
    });
});

test('list: a foreign, archived, other-instructor or absent group is one 404', async () => {
    await withState(() => undefined, async (state) => {
        for (const groupId of [GROUP_B1, GROUP_ARCHIVED, GROUP_A3, ABSENT_GROUP]) {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, listReq(groupId));
            assert.equal(result.status, 404, `${groupId} must not be readable`);
            assert.deepEqual(result.body, { error: 'Group not found' });
            assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_LIST_SQL), false);
        }
    });
});

test('list: an unresolved selected tenant is refused before any announcement read', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, listReq(
            GROUP_A1, {}, sign(INSTRUCTOR_A, 'instructor', { tenant_id: TENANT_B }),
        ));
        assert.equal(result.status, 404);
        assert.deepEqual(result.body, { error: 'Tenant membership not found' });
        assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_LIST_SQL), false);
    });
});

test('list: an unauthenticated read is refused and discloses nothing', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, makeReq({ token: null, method: 'GET', pathName: listPath(GROUP_A1) }));
        assert.equal(result.status, 401);
        assert.equal(harness.calls.length, 0);
        assert.equal(JSON.stringify(result.body).includes(ANN_A1), false);
    });
});

test('list: an invalid limit or cursor is rejected before any read', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { limit: '1.5' }, { limit: '' }]) {
            const result = await runChain(harness.chain, listReq(GROUP_A1, query));
            assert.equal(result.status, 400, `limit ${JSON.stringify(query)} must be rejected`);
            assert.deepEqual(result.body, { error: 'Invalid announcement list limit' });
            assert.equal(result.headers['cache-control'], 'no-store');
        }
        for (const query of [{ cursor: 'not-base64!!' }, { cursor: '' }, { cursor: 'Zm9v' }]) {
            const result = await runChain(harness.chain, listReq(GROUP_A1, query));
            assert.equal(result.status, 400, `cursor ${JSON.stringify(query)} must be rejected`);
            assert.deepEqual(result.body, { error: 'Invalid announcement list cursor' });
        }
        assert.equal(harness.calls.length, 0, 'no query is issued for a malformed selector');
    });
});

// ---------------------------------------------------------------------------
// POST /:groupId/announcements — create
// ---------------------------------------------------------------------------

test('create: a draft announcement is created, audited once and read back with server timestamps', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, createReq({ title: 'New notice', body: 'Please read.' }));

        assert.equal(result.status, 201);
        assert.deepEqual(Object.keys(result.body).sort(), DTO_KEYS);
        assert.equal(result.body.group_id, GROUP_A1);
        assert.equal(result.body.title, 'New notice');
        assert.equal(result.body.body, 'Please read.');
        assert.equal(result.body.state, 'draft', 'the default state is draft');
        assert.equal(result.body.created_at, '2026-10-23 09:15:00', 'the timestamp comes from the server');
        assert.equal(result.body.retracted_at, null);
        assert.equal(result.headers['cache-control'], 'no-store');

        assert.deepEqual(harness.events, ['begin', 'member', 'group-lock', 'insert', 'audit', 'read', 'commit', 'release']);
        assert.equal(harness.auditRows.length, 1, 'exactly one audit event commits');
        assert.equal(state.announcements.length, 5, 'the row is applied at commit');

        const insertCall = harness.calls.find((call) => squash(call.sql) === ANN_INSERT_SQL);
        assert.deepEqual(insertCall?.params.slice(1), [
            TENANT_A, INSTRUCTOR_A, GROUP_A1, 'New notice', 'Please read.', 'draft',
        ]);
    });
});

test('create: an explicit published state is accepted and recorded', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, createReq({ title: 'Live', body: 'Now.', state: 'published' }));
        assert.equal(result.status, 201);
        assert.equal(result.body.state, 'published');
        assert.deepEqual(JSON.parse(harness.auditRows[0].params[7]), { group_id: GROUP_A1, state: 'published' });
    });
});

test('create: the audit never carries the private title or body', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        await runChain(harness.chain, createReq({ title: 'SECRET-TITLE', body: 'SECRET-BODY' }));

        const audit = harness.auditRows[0];
        const [id, actor, tenant, action, resourceType, resourceId, oldValue, newValue] = audit.params;
        assert.equal(typeof id, 'string');
        assert.equal(actor, INSTRUCTOR_A);
        assert.equal(tenant, TENANT_A);
        assert.equal(action, 'group.announcement_created');
        assert.equal(resourceType, 'group_announcement');
        assert.equal(typeof resourceId, 'string');
        assert.equal(oldValue, null);
        assert.deepEqual(JSON.parse(newValue), { group_id: GROUP_A1, state: 'draft' });

        const text = `${oldValue}${newValue}`;
        assert.equal(text.includes('SECRET-TITLE'), false, 'the title must never be copied into the audit');
        assert.equal(text.includes('SECRET-BODY'), false, 'the body must never be copied into the audit');
        for (const forbidden of ['recipient', 'email', 'sms', 'push', 'provider', 'enrollment', 'price']) {
            assert.equal(text.includes(forbidden), false, `the audit must not carry "${forbidden}"`);
        }
    });
});

test('create: every malformed payload is rejected before any connection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const cases: Array<[any, string]> = [
            [null, 'Invalid announcement payload'],
            [[], 'Invalid announcement payload'],
            ['x', 'Invalid announcement payload'],
            [{ body: 'b' }, 'Invalid announcement title'],
            [{ title: 't' }, 'Invalid announcement body'],
            [{ title: 't', body: 'b', group_id: GROUP_A2 }, 'Invalid announcement payload'],
            [{ title: 't', body: 'b', tenant_id: TENANT_B }, 'Invalid announcement payload'],
            [{ title: 't', body: 'b', instructor_id: INSTRUCTOR_A2 }, 'Invalid announcement payload'],
            [{ title: '', body: 'b' }, 'Invalid announcement title'],
            [{ title: '   ', body: 'b' }, 'Invalid announcement title'],
            [{ title: 'x'.repeat(256), body: 'b' }, 'Invalid announcement title'],
            [{ title: 5, body: 'b' }, 'Invalid announcement title'],
            [{ title: 't', body: '' }, 'Invalid announcement body'],
            [{ title: 't', body: '   ' }, 'Invalid announcement body'],
            [{ title: 't', body: 'x'.repeat(4001) }, 'Invalid announcement body'],
            [{ title: 't', body: 5 }, 'Invalid announcement body'],
            [{ title: 't', body: 'b', state: 'retracted' }, 'Invalid announcement state'],
            [{ title: 't', body: 'b', state: 'archived' }, 'Invalid announcement state'],
            [{ title: 't', body: 'b', state: null }, 'Invalid announcement state'],
        ];
        for (const [body, error] of cases) {
            const result = await runChain(harness.chain, createReq(body));
            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be rejected`);
            assert.deepEqual(result.body, { error });
        }
        assert.equal(harness.connectionCount(), 0, 'no connection is taken for a malformed payload');
        assert.equal(state.announcements.length, 4, 'nothing is written');
    });
});

test('create: the accepted title is trimmed and the body is stored exactly', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, createReq({ title: '  Padded  ', body: '  keep me  ' }));
        assert.equal(result.status, 201);
        assert.equal(result.body.title, 'Padded');
        assert.equal(result.body.body, '  keep me  ', 'only the emptiness test trims the body');
    });
});

test('create: a foreign, archived, other-instructor or absent group is one 404', async () => {
    await withState(() => undefined, async (state) => {
        for (const groupId of [GROUP_B1, GROUP_ARCHIVED, GROUP_A3, ABSENT_GROUP]) {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, createReq({ title: 't', body: 'b' }, groupId));
            assert.equal(result.status, 404, `${groupId} must not be writable`);
            assert.deepEqual(result.body, { error: 'Group not found' });
            assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_INSERT_SQL), false);
            assert.equal(harness.auditRows.length, 0);
            assert.equal(harness.releaseCount(), 1);
            assert.equal(harness.destroyCount(), 0);
        }
        assert.equal(state.announcements.length, 4, 'no row is written for a foreign group');
    });
});

test('create: a membership downgraded after the guard is refused inside the transaction', async () => {
    await withState((state) => { state.memberLockDenies = true; }, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, createReq({ title: 't', body: 'b' }));

        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { error: 'Teaching access is not active for the selected tenant' });
        assert.equal(harness.events.includes('group-lock'), false, 'authority is revalidated before the target');
        assert.equal(harness.auditRows.length, 0);
        assert.equal(state.announcements.length, 4);
    });
});

test('create: a non-teaching membership and a billing-only account are refused', async () => {
    await withState(() => undefined, async (state) => {
        const outsider = await runChain(buildHarness(state).chain, createReq({ title: 't', body: 'b' }, GROUP_A1, sign(OUTSIDER_A, 'student', { tenant_id: TENANT_A })));
        assert.equal(outsider.status, 403);

        const billingHarness = buildHarness(state);
        const billing = await runChain(billingHarness.chain, createReq({ title: 't', body: 'b' }, GROUP_A1, sign(BILLING_ONLY, 'instructor', { tenant_id: TENANT_A })));
        assert.equal(billing.status, 403);
        assert.equal(billing.body.code, 'BILLING_ONLY');
        assert.equal(billingHarness.connectionCount(), 0, 'the billing-only refusal takes no connection');
        assert.equal(state.announcements.length, 4);
    });
});

// ---------------------------------------------------------------------------
// PUT /:groupId/announcements/:announcementId — edit and publish
// ---------------------------------------------------------------------------

test('update: a title/body edit is audited as an update', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, updateReq(ANN_A1, { title: 'Renamed', body: 'New text.' }));

        assert.equal(result.status, 200);
        assert.equal(result.body.title, 'Renamed');
        assert.equal(result.body.body, 'New text.');
        assert.equal(result.body.state, 'draft', 'the state is kept when it is not sent');
        assert.equal(result.body.updated_at, '2026-10-23 10:30:00');

        assert.deepEqual(harness.events, [
            'begin', 'member', 'group-lock', 'announcement-lock', 'update', 'audit', 'read', 'commit', 'release',
        ]);
        assert.equal(harness.auditRows[0].params[3], 'group.announcement_updated');
        assert.deepEqual(JSON.parse(harness.auditRows[0].params[6]), { state: 'draft' });
        assert.deepEqual(JSON.parse(harness.auditRows[0].params[7]), { state: 'draft' });

        const updateCall = harness.calls.find((call) => squash(call.sql) === ANN_UPDATE_SQL);
        assert.deepEqual(updateCall?.params, ['Renamed', 'New text.', 'draft', null, ANN_A1, GROUP_A1, TENANT_A]);
        assert.equal(announcementOf(state, ANN_A1)?.title, 'Renamed');
    });
});

test('update: a draft -> published transition is its own audited action', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, updateReq(ANN_A1, { state: 'published' }));

        assert.equal(result.status, 200);
        assert.equal(result.body.state, 'published');
        assert.equal(harness.auditRows[0].params[3], 'group.announcement_published');
        assert.deepEqual(JSON.parse(harness.auditRows[0].params[6]), { state: 'draft' });
        assert.deepEqual(JSON.parse(harness.auditRows[0].params[7]), { state: 'published' });
    });
});

test('update: re-publishing an already-published announcement is an ordinary edit, not a publish', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, updateReq(ANN_A2, { title: 'Exam reminder v2' }));
        assert.equal(result.status, 200);
        assert.equal(harness.auditRows[0].params[3], 'group.announcement_updated');
    });
});

test('update: an identical payload is a truthful no-op — no write, no audit', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, updateReq(ANN_A1, { title: 'First session', body: 'Bring the workbook.' }));

        assert.equal(result.status, 200);
        assert.equal(result.body.title, 'First session');
        assert.deepEqual(harness.events, [
            'begin', 'member', 'group-lock', 'announcement-lock', 'rollback', 'release',
        ]);
        assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_UPDATE_SQL), false);
        assert.equal(harness.auditRows.length, 0);
        assert.equal(announcementOf(state, ANN_A1)?.updated_at, '2026-10-21 08:00:00');
    });
});

test('update: an empty body is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, updateReq(ANN_A1, {}));
        assert.equal(result.status, 200);
        assert.equal(harness.auditRows.length, 0);
        assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_UPDATE_SQL), false);
    });
});

test('update: a retracted announcement is terminal', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, updateReq(ANN_A3, { title: 'Try again' }));

        assert.equal(result.status, 409);
        assert.deepEqual(result.body, { error: 'Announcement is retracted' });
        assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_UPDATE_SQL), false);
        assert.equal(harness.auditRows.length, 0);
        assert.equal(announcementOf(state, ANN_A3)?.title, 'Cancelled class');
    });
});

test('update: an absent, foreign or other-group announcement is one 404', async () => {
    await withState(() => undefined, async (state) => {
        for (const [groupId, announcementId] of [
            [GROUP_A1, ABSENT_ANN],
            [GROUP_A1, ANN_B1],
            [GROUP_A2, ANN_A1],
        ] as Array<[string, string]>) {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, updateReq(announcementId, { title: 'x' }, groupId));
            assert.equal(result.status, 404, `${groupId}/${announcementId} must not be writable`);
            assert.deepEqual(result.body, { error: 'Announcement not found' });
            assert.equal(harness.auditRows.length, 0);
            assert.equal(
                harness.calls.some((call) => squash(call.sql) === ANN_UPDATE_SQL),
                false,
                'a refused target never reaches the write',
            );
        }

        // A group outside the caller's writable set fails one step earlier. The body is
        // the SAME one used for archived, other-instructor and absent groups (see the
        // create suite), so this 404 discloses nothing about the group's existence.
        const foreign = await runChain(buildHarness(state).chain, updateReq(ANN_B1, { title: 'x' }, GROUP_B1));
        assert.equal(foreign.status, 404);
        assert.deepEqual(foreign.body, { error: 'Group not found' });
        assert.equal(state.announcements.length, 4, 'no announcement is touched through a foreign group');
    });
});

test('update: a malformed payload is rejected before any connection', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        for (const body of [
            { state: 'retracted' },
            { state: 'archived' },
            { title: 'x'.repeat(256) },
            { body: '   ' },
            { title: 't', group_id: GROUP_A2 },
            { title: 't', state: 'published', extra: 1 },
        ]) {
            const result = await runChain(harness.chain, updateReq(ANN_A1, body));
            assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be rejected`);
        }
        assert.equal(harness.connectionCount(), 0);
    });
});

// ---------------------------------------------------------------------------
// POST /:groupId/announcements/:announcementId/retract
// ---------------------------------------------------------------------------

test('retract: a published announcement becomes retracted with a server timestamp and one audit', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, retractReq(ANN_A2));

        assert.equal(result.status, 200);
        assert.equal(result.body.state, 'retracted');
        assert.equal(result.body.retracted_at, '2026-10-23 11:00:00');
        assert.equal(result.body.updated_at, '2026-10-23 11:00:00');

        assert.deepEqual(harness.events, [
            'begin', 'member', 'group-lock', 'announcement-lock', 'retract', 'audit', 'read', 'commit', 'release',
        ]);
        const audit = harness.auditRows[0];
        assert.equal(audit.params[3], 'group.announcement_retracted');
        assert.deepEqual(JSON.parse(audit.params[6]), { state: 'published' });
        assert.deepEqual(JSON.parse(audit.params[7]), { state: 'retracted' });
        assert.equal(announcementOf(state, ANN_A2)?.state, 'retracted');
    });
});

test('retract: retracting an already-retracted announcement is a truthful no-op', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const result = await runChain(harness.chain, retractReq(ANN_A3));

        assert.equal(result.status, 200);
        assert.equal(result.body.state, 'retracted');
        assert.equal(result.body.retracted_at, '2026-10-21 10:05:00', 'the original retraction instant is preserved');
        assert.deepEqual(harness.events, [
            'begin', 'member', 'group-lock', 'announcement-lock', 'rollback', 'release',
        ]);
        assert.equal(harness.calls.some((call) => squash(call.sql) === ANN_RETRACT_SQL), false);
        assert.equal(harness.auditRows.length, 0);
    });
});

test('retract: an absent or foreign announcement is one 404', async () => {
    await withState(() => undefined, async (state) => {
        for (const [groupId, announcementId] of [
            [GROUP_A1, ABSENT_ANN],
            [GROUP_A1, ANN_B1],
            [GROUP_A2, ANN_A1],
        ] as Array<[string, string]>) {
            const harness = buildHarness(state);
            const result = await runChain(harness.chain, retractReq(announcementId, groupId));
            assert.equal(result.status, 404);
            assert.deepEqual(result.body, { error: 'Announcement not found' });
            assert.equal(harness.auditRows.length, 0);
            assert.equal(
                harness.calls.some((call) => squash(call.sql) === ANN_RETRACT_SQL),
                false,
                'a refused target never reaches the write',
            );
        }

        const foreign = await runChain(buildHarness(state).chain, retractReq(ANN_B1, GROUP_B1));
        assert.equal(foreign.status, 404);
        assert.deepEqual(foreign.body, { error: 'Group not found' });
        assert.equal(state.announcements.length, 4, 'no announcement is retracted through a foreign group');
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting boundary
// ---------------------------------------------------------------------------

test('every outcome the handlers produce carries Cache-Control no-store', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const outcomes = await withSilencedErrors(async () => Promise.all([
            runChain(harness.chain, listReq()),
            runChain(harness.chain, listReq(GROUP_A1, { limit: '0' })),
            runChain(harness.chain, createReq({ title: 't', body: 'b' })),
            runChain(harness.chain, createReq({})),
            runChain(harness.chain, updateReq(ANN_A1, { title: 'x' })),
            runChain(harness.chain, retractReq(ANN_A2)),
        ]));
        for (const result of outcomes) {
            assert.equal(result.headers['cache-control'], 'no-store');
            assert.equal(result.responseCount, 1, 'exactly one response per request');
        }
    });
});

test('the announcement surface changes no authorization, enrollment or billing input', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        const before = {
            roles: JSON.stringify(state.memberRoles),
            memberships: JSON.stringify(state.memberships),
            users: JSON.stringify(state.users),
            groups: JSON.stringify(state.groups),
        };

        await runChain(harness.chain, createReq({ title: 't', body: 'b' }));
        await runChain(harness.chain, updateReq(ANN_A1, { state: 'published' }));
        await runChain(harness.chain, retractReq(ANN_A2));

        assert.equal(JSON.stringify(state.memberRoles), before.roles, 'no role is written');
        assert.equal(JSON.stringify(state.memberships), before.memberships, 'no membership is written');
        assert.equal(JSON.stringify(state.users), before.users, 'no user is written');
        assert.equal(JSON.stringify(state.groups), before.groups, 'no group row is written');

        // Every audit action stays inside the announcement namespace.
        for (const audit of harness.auditRows) {
            assert.equal(String(audit.params[3]).startsWith('group.announcement_'), true);
            assert.equal(audit.params[4], 'group_announcement');
        }
    });
});

test('the announcement surface never sends, schedules or queues anything', async () => {
    await withState(() => undefined, async (state) => {
        const harness = buildHarness(state);
        await runChain(harness.chain, createReq({ title: 't', body: 'b', state: 'published' }));
        await runChain(harness.chain, updateReq(ANN_A1, { state: 'published' }));

        // Every statement the surface issues is one of the documented
        // announcement/authority statements: no outbox, no recipient, no
        // delivery, no schedule and no provider statement exists at all.
        for (const call of harness.calls) {
            const n = squash(call.sql);
            const allowed = n === MEMBER_LOCK_SELECT
                || n.startsWith(GROUP_LOCK_PREFIX)
                || n === ANN_LOCK_SQL
                || n === ANN_READ_SQL
                || n === ANN_INSERT_SQL
                || n === ANN_UPDATE_SQL
                || n === ANN_RETRACT_SQL
                || n === AUDIT_SQL;
            assert.equal(allowed, true, `unexpected statement: ${n}`);
            for (const forbidden of ['recipient', 'outbox', 'delivery', 'notification', 'email', 'sms', 'push', 'provider']) {
                assert.equal(n.toLowerCase().includes(forbidden), false, `"${forbidden}" must not appear`);
            }
        }
        assert.deepEqual(forbiddenCalls, [], 'no provider adapter may be called');
    });
});
