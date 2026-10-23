/**
 * M2-21 — private group announcements: FAILURE and DISPOSAL paths
 * (hermetic, behavioral).
 *
 * Contract under test: every failure of an announcement write leaves ZERO
 * partial writes — no announcement row created or changed, no audit event
 * recorded, no connection returned to the pool in an unknown state — and every
 * response is a truthful, bounded failure that never carries an internal detail.
 *
 * The uncertain-commit path is the one that matters most: once the commit
 * acknowledgement is lost, whether the write persisted is UNKNOWN, so the
 * handler must neither claim a rollback nor return the connection to the pool.
 *
 * Composition under test is the real production order (real
 * `optionalAuth`/`authenticateToken` over the real principal resolver, the real
 * `requireTeachingWrite('groups')` guard with an injected repository seam, then
 * the real router from `src/routes/groups.ts`). Only leaf data boundaries are
 * fixtures: the `src/db` adapters, the entitlement guard's repository, and the
 * `src/security/principal-repository` lookups. No express listener, socket,
 * fetch, DB, provider or app startup.
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

const TEST_SECRET = 'm2-21-failures-hermetic-jwt-secret-not-a-real-key';
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
// Shared failure helpers
// ---------------------------------------------------------------------------

const snapshot = (state: State) => JSON.stringify(state.announcements);

interface Attempt {
    result: { status: number; body: any; headers: Record<string, string> };
    state: State;
    harness: Harness;
    before: string;
}

/** Runs ONE request against a state with the given failure flags applied. */
const attempt = async (
    flags: Partial<State>,
    build: (state: State) => any,
): Promise<Attempt> => {
    const state = makeState();
    Object.assign(state, flags);
    const before = snapshot(state);
    const harness = buildHarness(state);
    const result = await withSilencedErrors(() => runChain(harness.chain, build(state)));
    return { result, state, harness, before };
};

/**
 * The invariant every non-committed failure must satisfy: the stored rows are
 * byte-identical to what they were, and no audit event was ever recorded.
 */
const assertNoPartialWrite = ({ state, harness, before }: Attempt) => {
    assert.equal(snapshot(state), before, 'no announcement row may be created, changed or removed');
    assert.equal(harness.auditRows.length, 0, 'no audit event may be recorded');
    assert.equal(state.announcements.length, 4, 'the fixture set is untouched');
};

/** A failure body must be opaque: no driver text, no stack, no internal name. */
const assertOpaque = (body: any) => {
    const text = JSON.stringify(body);
    for (const forbidden of [
        'ER_LOCK', 'deadlock', 'internal detail', 'leaked', 'stack', 'sqlMessage',
        'group_announcements', 'audit_events', 'mysql', 'InnoDB',
    ]) {
        assert.equal(
            text.toLowerCase().includes(forbidden.toLowerCase()),
            false,
            `a failure body must not carry "${forbidden}" (body: ${text})`,
        );
    }
    assert.deepEqual(Object.keys(body), ['error'], 'a failure body carries exactly one field');
};

const SAVE_FAILED = { error: 'Failed to save announcement' };
const LIST_FAILED = { error: 'Failed to list announcements' };
const TEACHING_DENIED = { error: 'Teaching access is not active for the selected tenant' };

// ---------------------------------------------------------------------------
// Create — every failure leaves zero partial writes
// ---------------------------------------------------------------------------

test('create: a failed acquisition answers an opaque 500 and takes no transaction', async () => {
    const a = await attempt({ failAcquire: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.equal(a.harness.connectionCount(), 0, 'no connection is taken');
    assert.equal(a.harness.events.includes('begin'), false, 'no transaction is opened');
    assert.equal(a.harness.releaseCount(), 0);
    assert.equal(a.harness.destroyCount(), 0, 'nothing was acquired, so nothing is disposed');
    assertNoPartialWrite(a);
});

test('create: a failed begin destroys the connection without a rollback', async () => {
    const a = await attempt({ failBegin: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.deepEqual(a.harness.events, ['begin', 'destroy'], 'a connection with no transaction is destroyed');
    assert.equal(a.harness.rollbackCount(), 0, 'there is nothing to roll back');
    assert.equal(a.harness.releaseCount(), 0, 'an unknown-state connection is never returned to the pool');
    assertNoPartialWrite(a);
});

test('create: a denied member lock rolls back before the group is touched', async () => {
    const a = await attempt({ memberLockDenies: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 403);
    assert.deepEqual(a.result.body, TEACHING_DENIED);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'rollback', 'release']);
    assert.equal(a.harness.events.includes('group-lock'), false, 'the group is never locked after a denial');
    assert.equal(a.harness.commitCount(), 0);
    assertNoPartialWrite(a);
});

test('create: a failed member lock rolls back and answers an opaque 500', async () => {
    const a = await attempt({ failMemberLock: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('create: a failed group lock rolls back and writes nothing', async () => {
    const a = await attempt({ failGroupLock: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.harness.events.includes('insert'), false);
    assert.equal(a.harness.events.includes('audit'), false);
    assert.deepEqual(a.harness.events.slice(-2), ['rollback', 'release']);
    assertNoPartialWrite(a);
});

test('create: a failed insert rolls back and records no audit', async () => {
    const a = await attempt({ failInsert: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'group-lock', 'insert', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('create: a failed audit discards the buffered announcement', async () => {
    const a = await attempt({ failAudit: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    // The insert was staged inside the transaction and MUST NOT survive the rollback.
    assert.deepEqual(a.harness.events, ['begin', 'member', 'group-lock', 'insert', 'audit', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('create: a failed read-back rolls back the announcement it just wrote', async () => {
    const a = await attempt({ failReadBack: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'group-lock', 'insert', 'audit', 'read', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('create: an empty read-back is refused rather than answered with a fabricated row', async () => {
    const a = await attempt({ emptyReadBack: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.result.body.id, undefined);
    assertNoPartialWrite(a);
});

test('create: an uncertain commit destroys the connection and claims no rollback', async () => {
    const a = await attempt({ failCommit: true }, () => createReq({ title: 'Notice', body: 'Text.' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.harness.commitCount(), 1, 'the commit was attempted');
    assert.equal(a.harness.rollbackCount(), 0, 'a lost acknowledgement must never be reported as rolled back');
    assert.equal(a.harness.destroyCount(), 1, 'the connection is discarded, not returned');
    assert.equal(a.harness.releaseCount(), 0, 'an uncertain connection is never returned to the pool');
    assert.deepEqual(a.harness.events, ['begin', 'member', 'group-lock', 'insert', 'audit', 'read', 'commit', 'destroy']);
    // The fixture applies writes only on an acknowledged commit, so nothing landed
    // here — and the handler cannot claim either way.
    assertNoPartialWrite(a);
});

test('create: a failed rollback escalates to destroy', async () => {
    const a = await attempt(
        { failInsert: true, failRollback: true },
        () => createReq({ title: 'Notice', body: 'Text.' }),
    );

    assert.equal(a.result.status, 500);
    assert.equal(a.harness.rollbackCount(), 1);
    assert.equal(a.harness.destroyCount(), 1, 'a connection whose rollback failed is discarded');
    assert.equal(a.harness.releaseCount(), 0);
    assertNoPartialWrite(a);
});

test('create: a throwing release or destroy never changes the answer', async () => {
    const released = await attempt({ failRelease: true }, () => createReq({ title: 'Notice', body: 'Text.' }));
    assert.equal(released.result.status, 201, 'a disposal failure must not fail a committed write');
    assert.equal(released.harness.releaseCount(), 1);

    const destroyed = await attempt({ failCommit: true, failDestroy: true }, () => createReq({ title: 'Notice', body: 'Text.' }));
    assert.equal(destroyed.result.status, 500, 'a throwing destroy is swallowed by the opaque 500');
    assert.deepEqual(destroyed.result.body, SAVE_FAILED);
    assert.equal(destroyed.harness.destroyCount(), 1);
});

// ---------------------------------------------------------------------------
// Update — every failure leaves the stored row untouched
// ---------------------------------------------------------------------------

test('update: a failed update rolls back and records no audit', async () => {
    const a = await attempt({ failUpdate: true }, () => updateReq(ANN_A1, { title: 'Renamed' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.deepEqual(a.harness.events, [
        'begin', 'member', 'group-lock', 'announcement-lock', 'update', 'rollback', 'release',
    ]);
    assertNoPartialWrite(a);
});

test('update: affectedRows 0 is a 409 conflict and writes nothing', async () => {
    const a = await attempt({ affectedRowsOverride: 0 }, () => updateReq(ANN_A1, { title: 'Renamed' }));

    assert.equal(a.result.status, 409);
    assert.deepEqual(a.result.body, { error: 'Announcement was modified concurrently' });
    assert.equal(a.harness.events.includes('audit'), false, 'a conflict records no audit');
    assert.deepEqual(a.harness.events.slice(-2), ['rollback', 'release']);
    assertNoPartialWrite(a);
});

test('update: a failed audit rolls the edit back', async () => {
    const a = await attempt({ failAudit: true }, () => updateReq(ANN_A1, { title: 'Renamed' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.deepEqual(a.harness.events.slice(-2), ['rollback', 'release']);
    assertNoPartialWrite(a);
    assert.equal(announcementOf(a.state, ANN_A1)?.title, 'First session', 'the stored title is unchanged');
});

test('update: a failed read-back rolls the edit back', async () => {
    const a = await attempt({ failReadBack: true }, () => updateReq(ANN_A1, { title: 'Renamed' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertNoPartialWrite(a);
});

test('update: an uncertain commit destroys the connection', async () => {
    const a = await attempt({ failCommit: true }, () => updateReq(ANN_A1, { state: 'published' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.harness.commitCount(), 1);
    assert.equal(a.harness.rollbackCount(), 0);
    assert.equal(a.harness.destroyCount(), 1);
    assert.equal(a.harness.releaseCount(), 0);
    assertNoPartialWrite(a);
});

test('update: a denied member lock stops before the group or the row is locked', async () => {
    const a = await attempt({ memberLockDenies: true }, () => updateReq(ANN_A1, { title: 'Renamed' }));

    assert.equal(a.result.status, 403);
    assert.deepEqual(a.result.body, TEACHING_DENIED);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

test('update: a failed announcement lock rolls back before any write', async () => {
    const a = await attempt({ failAnnouncementLock: true }, () => updateReq(ANN_A1, { title: 'Renamed' }));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.harness.events.includes('update'), false);
    assert.equal(a.harness.events.includes('audit'), false);
    assertNoPartialWrite(a);
});

// ---------------------------------------------------------------------------
// Retract — every failure leaves the row and its retracted_at untouched
// ---------------------------------------------------------------------------

test('retract: a failed retract rolls back and records no audit', async () => {
    const a = await attempt({ failRetract: true }, () => retractReq(ANN_A2));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertOpaque(a.result.body);
    assert.deepEqual(a.harness.events, [
        'begin', 'member', 'group-lock', 'announcement-lock', 'retract', 'rollback', 'release',
    ]);
    assertNoPartialWrite(a);
    assert.equal(announcementOf(a.state, ANN_A2)?.retracted_at, null, 'no retraction stamp is written');
});

test('retract: affectedRows 0 is a 409 conflict and writes nothing', async () => {
    const a = await attempt({ affectedRowsOverride: 0 }, () => retractReq(ANN_A2));

    assert.equal(a.result.status, 409);
    assert.deepEqual(a.result.body, { error: 'Announcement was modified concurrently' });
    assert.equal(a.harness.events.includes('audit'), false);
    assertNoPartialWrite(a);
});

test('retract: a failed audit rolls the retraction back', async () => {
    const a = await attempt({ failAudit: true }, () => retractReq(ANN_A2));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.deepEqual(a.harness.events.slice(-2), ['rollback', 'release']);
    assertNoPartialWrite(a);
    assert.equal(announcementOf(a.state, ANN_A2)?.state, 'published', 'the row stays published');
});

test('retract: a failed read-back rolls the retraction back', async () => {
    const a = await attempt({ failReadBack: true }, () => retractReq(ANN_A2));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assertNoPartialWrite(a);
});

test('retract: an uncertain commit destroys the connection', async () => {
    const a = await attempt({ failCommit: true }, () => retractReq(ANN_A2));

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, SAVE_FAILED);
    assert.equal(a.harness.commitCount(), 1);
    assert.equal(a.harness.rollbackCount(), 0);
    assert.equal(a.harness.destroyCount(), 1);
    assert.equal(a.harness.releaseCount(), 0);
    assertNoPartialWrite(a);
});

test('retract: a denied member lock stops before the group or the row is locked', async () => {
    const a = await attempt({ memberLockDenies: true }, () => retractReq(ANN_A2));

    assert.equal(a.result.status, 403);
    assert.deepEqual(a.result.body, TEACHING_DENIED);
    assert.deepEqual(a.harness.events, ['begin', 'member', 'rollback', 'release']);
    assertNoPartialWrite(a);
});

// ---------------------------------------------------------------------------
// List — read failures are opaque and disclose nothing
// ---------------------------------------------------------------------------

test('list: a failed group scope read is an opaque 500', async () => {
    const a = await attempt({ failGroupScope: true }, () => listReq());

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, LIST_FAILED);
    assertOpaque(a.result.body);
    assert.equal(a.harness.events.includes('list'), false, 'the page is never read after a failed scope check');
});

test('list: a failed page read is an opaque 500', async () => {
    const a = await attempt({ failList: true }, () => listReq());

    assert.equal(a.result.status, 500);
    assert.deepEqual(a.result.body, LIST_FAILED);
    assertOpaque(a.result.body);
    assert.equal(a.result.body.announcements, undefined, 'no partial page is returned');
    assert.equal(a.result.body.next_cursor, undefined);
});

// ---------------------------------------------------------------------------
// Cross-cutting disposal and response discipline
// ---------------------------------------------------------------------------

test('every failure carries Cache-Control no-store', async () => {
    const cases: Array<[Partial<State>, () => any]> = [
        [{ failAcquire: true }, () => createReq({ title: 'N', body: 'B' })],
        [{ failBegin: true }, () => createReq({ title: 'N', body: 'B' })],
        [{ failMemberLock: true }, () => createReq({ title: 'N', body: 'B' })],
        [{ failGroupLock: true }, () => createReq({ title: 'N', body: 'B' })],
        [{ failInsert: true }, () => createReq({ title: 'N', body: 'B' })],
        [{ failAudit: true }, () => createReq({ title: 'N', body: 'B' })],
        [{ failUpdate: true }, () => updateReq(ANN_A1, { title: 'R' })],
        [{ failRetract: true }, () => retractReq(ANN_A2)],
        [{ failGroupScope: true }, () => listReq()],
        [{ failList: true }, () => listReq()],
    ];
    for (const [flags, build] of cases) {
        const a = await attempt(flags, build);
        assert.equal(
            a.result.headers['cache-control'],
            'no-store',
            `failure ${JSON.stringify(flags)} must be uncacheable`,
        );
    }
});

test('no failure path ever releases and destroys the same connection', async () => {
    const cases: Array<Partial<State>> = [
        { failAcquire: true },
        { failBegin: true },
        { failMemberLock: true },
        { failGroupLock: true },
        { failAnnouncementLock: true },
        { failInsert: true },
        { failUpdate: true },
        { failRetract: true },
        { failAudit: true },
        { failReadBack: true },
        { emptyReadBack: true },
        { failCommit: true },
        { failInsert: true, failRollback: true },
        { failCommit: true, failDestroy: true },
    ];
    for (const flags of cases) {
        for (const build of [
            () => createReq({ title: 'N', body: 'B' }),
            () => updateReq(ANN_A1, { title: 'R' }),
            () => retractReq(ANN_A2),
        ]) {
            const a = await attempt(flags, build);
            const disposals = a.harness.events.filter((event) => event === 'release' || event === 'destroy');
            assert.ok(
                disposals.length <= 1,
                `at most one disposal for ${JSON.stringify(flags)} (saw ${JSON.stringify(a.harness.events)})`,
            );
            assert.equal(
                a.harness.releaseCount() + a.harness.destroyCount(),
                disposals.length,
                'the counters agree with the recorded events',
            );
            if (flags.failAcquire) {
                assert.equal(disposals.length, 0, 'a connection that was never acquired is never disposed');
            } else {
                assert.equal(disposals.length, 1, `exactly one disposal for ${JSON.stringify(flags)}`);
            }
        }
    }
});

test('an uncertain commit never appears as a rolled-back write', async () => {
    for (const build of [
        () => createReq({ title: 'N', body: 'B' }),
        () => updateReq(ANN_A1, { title: 'R' }),
        () => retractReq(ANN_A2),
    ]) {
        const a = await attempt({ failCommit: true }, build);
        assert.equal(a.harness.rollbackCount(), 0, 'a lost acknowledgement is never described as a rollback');
        assert.deepEqual(a.result.body, SAVE_FAILED, 'and the answer stays an opaque failure');
    }
});
