import './helpers/isolated-io-guard';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Router } from 'express';
import { createOptionalAuth } from '../src/middleware/auth';
import { createRequireTeachingWrite, TeachingAccessRepository } from '../src/middleware/teaching-access';
import type { PrincipalRepository } from '../src/security/principal-repository';
import type { GroupsDataAccess, GroupsRouterDeps } from '../src/routes/groups';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import { createMeetingsRouter, MeetingsDataAccess, MeetingsRouterDeps } from '../src/routes/meetings';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored after loading');
});

/**
 * The router's transaction seam is the module-level `getPool` import from
 * `../src/db`. That leaf is replaced for this suite, so every write path runs
 * on an injected in-memory connection: no pool, no socket, no real database.
 * `src/routes/groups` is required INSIDE the interception window, so its
 * static `import { getPool } from '../db'` binds to the fixture sentinel.
 */
const originalLoad = (Module as any)._load;
const poolHolder: { pool: any } = { pool: null };
const dbSentinel = { getPool: () => poolHolder.pool };
const sentinelByPath = new Map<string, unknown>();
const registerSentinel = (specifier: string, exports: unknown) => {
    sentinelByPath.set(require.resolve(specifier).toLowerCase(), exports);
};
registerSentinel('../src/db', dbSentinel);

const installInterception = () => {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
        let resolved: string | null = null;
        if (parent && typeof parent.filename === 'string') {
            try { resolved = Module.createRequire(parent.filename).resolve(request); }
            catch { resolved = null; }
        }
        const hit = resolved ? sentinelByPath.get(resolved.toLowerCase()) : undefined;
        if (hit) return hit;
        return originalLoad.apply(this, [request, parent, isMain]);
    };
};

let createGroupsRouter: (deps: GroupsRouterDeps) => Router;
installInterception();
try {
    ({ createGroupsRouter } = require('../src/routes/groups'));
} finally {
    (Module as any)._load = originalLoad;
}

/**
 * The current contract validates ids as UUIDs (a client-supplied id is only a
 * selector), so every fixture id that travels through a URL or a request body
 * is a real UUID. The readable names live in the row names.
 */
const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_A_OWNER = '11111111-1111-4111-8111-111111111112';
const GROUP_A_LEGACY = '11111111-1111-4111-8111-111111111113';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const GROUP_ORPHAN = '33333333-3333-4333-8333-333333333333';
const COURSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COURSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRADE_SHARED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface TestGroup {
    id: string;
    name: string;
    course_id: string | null;
    grade_id: string | null;
    instructor_id: string | null;
    is_active: boolean;
    description?: string | null;
    max_students?: number;
    current_students?: number;
    schedule_days?: string | null;
    schedule_time?: string | null;
}

interface TestMeeting {
    id: string;
    title: string;
    description: string | null;
    meeting_link: string;
    meeting_type: string;
    meeting_password: string | null;
    grade_id: string | null;
    group_id: string | null;
    scheduled_at: string;
    duration_minutes: number;
    is_active: number;
    created_by: string | null;
}

interface FixtureState {
    groups: TestGroup[];
    meetings: TestMeeting[];
    executed: Array<{ sql: string; params: unknown[] }>;
}

const makeState = (): FixtureState => ({
    groups: [
        { id: GROUP_A, name: 'Alpha', course_id: COURSE_A, grade_id: GRADE_SHARED, instructor_id: 'owner-a', is_active: true },
        { id: GROUP_A_OWNER, name: 'Alpha owner-only', course_id: null, grade_id: GRADE_SHARED, instructor_id: 'owner-a', is_active: true },
        { id: GROUP_A_LEGACY, name: 'Alpha legacy', course_id: COURSE_A, grade_id: GRADE_SHARED, instructor_id: null, is_active: true },
        { id: GROUP_B, name: 'Beta', course_id: COURSE_B, grade_id: GRADE_SHARED, instructor_id: 'owner-b', is_active: true },
        { id: GROUP_ORPHAN, name: 'Orphan', course_id: null, grade_id: GRADE_SHARED, instructor_id: null, is_active: true },
    ],
    meetings: [
        {
            id: 'meeting-a-grade', title: 'Alpha grade-wide', description: null, meeting_link: 'https://meet.example/a',
            meeting_type: 'zoom', meeting_password: null, grade_id: GRADE_SHARED, group_id: null,
            scheduled_at: '2030-01-01 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'owner-a',
        },
        {
            id: 'meeting-b-grade', title: 'Beta grade-wide', description: null, meeting_link: 'https://meet.example/b',
            meeting_type: 'zoom', meeting_password: 'foreign-secret', grade_id: GRADE_SHARED, group_id: null,
            scheduled_at: '2030-01-02 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'owner-b',
        },
        {
            id: 'meeting-a-group', title: 'Alpha group', description: null, meeting_link: 'https://meet.example/ag',
            meeting_type: 'zoom', meeting_password: null, grade_id: GRADE_SHARED, group_id: GROUP_A,
            scheduled_at: '2030-01-03 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'owner-a',
        },
    ],
    executed: [],
});

const makePrincipalRepository = (): PrincipalRepository => ({
    findUsersIdentity: async (id) => id === 'owner-a' || id === 'owner-b' || id === 'teacher-a' || id === 'student-a' || id === 'no-scope'
        ? { is_active: 1, token_version: 0, suspension_active: 0 }
        : null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id) => id === 'owner-a' || id === 'owner-b'
        ? { tenant_status: 'active', legacy_compat: 1, allowed: 1 }
        : null,
    findStudentEnrollments: async (id) => id === 'student-a'
        ? [{ id: 'enrollment-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'owner-a', group_id: GROUP_A, grade_id: GRADE_SHARED }]
        : [],
    findActiveTenantMemberships: async (id) => ({
        'owner-a': [{ tenant_id: 'tenant-a' }],
        'owner-b': [{ tenant_id: 'tenant-b' }],
        'teacher-a': [{ tenant_id: 'tenant-a' }],
    }[id] ?? []),
});

const makeTeachingRepository = (): TeachingAccessRepository => ({
    loadSelectedTenantMembership: async (userId, tenantId) => userId === 'teacher-a' && tenantId === 'tenant-a'
        ? {
            role_key: 'instructor', user_is_active: 1, tenant_status: 'active',
            tenant_legacy_compat: 1, subscription_entitles: 1,
        }
        : null,
    loadStaffPagePermissions: async () => null,
});

const tokenFor = (id: string, role: string, claims: Record<string, unknown> = {}) =>
    jwt.sign({ id, role, tv: 0, ...claims }, TEST_SECRET);

const TEACHER_A = tokenFor('teacher-a', 'teacher', { tenant_id: 'tenant-a' });
const TEACHER_NO_SCOPE = tokenFor('no-scope', 'teacher');
const STUDENT_A = tokenFor('student-a', 'student', { student_enrollment_id: 'enrollment-a' });
const OWNER_A = tokenFor('owner-a', 'instructor');
const OWNER_B = tokenFor('owner-b', 'instructor');

const tenantOwner: Record<string, string> = { 'tenant-a': 'owner-a', 'tenant-b': 'owner-b' };
const courseTenant: Record<string, string> = { [COURSE_A]: 'tenant-a', [COURSE_B]: 'tenant-b' };

const tenantGroupMatches = (group: TestGroup, tenantId: string) => {
    const owner = tenantOwner[tenantId];
    return Boolean(owner)
        && (group.instructor_id === owner || group.instructor_id === null)
        && (group.course_id === null || courseTenant[group.course_id] === tenantId)
        && (group.instructor_id !== null || group.course_id !== null);
};

const inGroupSqlScope = (group: TestGroup, sql: string, params: unknown[], idParamIndex?: number) => {
    if (idParamIndex !== undefined && group.id !== params[idParamIndex]) return false;
    if (sql.includes('t.id = ?')) {
        if (sql.includes('AND g.id = ? AND EXISTS')) {
            const groupIndex = idParamIndex === undefined ? 0 : idParamIndex + 1;
            if (group.id !== params[groupIndex]) return false;
            return tenantGroupMatches(group, String(params[groupIndex + 1]));
        }
        const tenantIndex = idParamIndex === undefined ? 0 : idParamIndex + 1;
        return tenantGroupMatches(group, String(params[tenantIndex]));
    }
    if (sql.includes('g.id = ? AND g.instructor_id = ?')) {
        const scopeIndex = params.length - 2;
        return group.id === params[scopeIndex] && group.instructor_id === params[scopeIndex + 1];
    }
    if (sql.includes('g.instructor_id = ?')) {
        return group.instructor_id === params[params.length - 1];
    }
    return false;
};

const MEMBER_ROLES: Record<string, Record<string, string>> = {
    'teacher-a': { 'tenant-a': 'instructor' },
    'owner-a': { 'tenant-a': 'owner' },
    'owner-b': { 'tenant-b': 'owner' },
};

/**
 * The injected transactional seam. `src/routes/groups` calls the module-level
 * `getPool()` (bound to the sentinel) for every write; this pool hands out an
 * in-memory connection whose statements are answered by the same fixture, and
 * whose commit applies the buffered write. A rollback leaves zero partial
 * writes, exactly as the real transaction contract requires.
 */
const makeConnection = (state: FixtureState) => {
    let pendingName: { id: string; name: string } | null = null;
    return {
        beginTransaction: async () => undefined,
        execute: async (sql: string, params: unknown[]) => {
            state.executed.push({ sql, params });
            // Authority re-read inside the transaction.
            if (sql.includes('FROM tenant_memberships m JOIN users u')) {
                const [userId, tenantId] = params.map(String);
                const role = MEMBER_ROLES[userId]?.[tenantId];
                if (!role) return [[], []];
                return [[{ role_key: role, caller_active: 1, tenant_status: 'active' }], []];
            }
            // Target lock: the row is only visible inside the selected tenant.
            if (sql.includes('FROM `groups` g') && sql.includes('JOIN tenant_memberships')) {
                const [tenantId, groupId, scopeId] = params;
                const group = state.groups.find((candidate) => candidate.id === String(groupId) && candidate.is_active);
                if (!group || !tenantGroupMatches(group, String(tenantId))) return [[], []];
                if (scopeId !== undefined && group.instructor_id !== String(scopeId)) return [[], []];
                return [[{ ...group }], []];
            }
            if (sql.includes('UPDATE `groups`')) {
                const id = String(params[8]);
                const group = state.groups.find((candidate) => candidate.id === id);
                if (!group) return [{ affectedRows: 0 }, []];
                pendingName = { id, name: String(params[0]) };
                return [{ affectedRows: 1 }, []];
            }
            if (sql.includes('INSERT INTO audit_events')) {
                return [{ affectedRows: 1 }, []];
            }
            return [{ affectedRows: 0 }, []];
        },
        commit: async () => {
            if (pendingName) {
                const group = state.groups.find((candidate) => candidate.id === pendingName!.id);
                if (group) group.name = pendingName.name;
                pendingName = null;
            }
        },
        rollback: async () => { pendingName = null; },
        release: () => undefined,
        destroy: () => undefined,
    };
};

const makeGroupsDb = (state: FixtureState, fail = false): GroupsDataAccess => {
    poolHolder.pool = {
        getConnection: async () => {
            if (fail) throw new Error('fixture database failure');
            return makeConnection(state);
        },
    };
    const respond = (sql: string, params: unknown[]) => {
        state.executed.push({ sql, params });
        if (fail) throw new Error('fixture database failure');
        if (sql.includes('SELECT owner_user_id FROM tenants')) {
            const owner_user_id = tenantOwner[String(params[0])];
            return owner_user_id ? [{ owner_user_id }] : [];
        }
        if (sql.includes('SELECT id FROM courses')) {
            const courseId = String(params[0]);
            return courseTenant[courseId] === params[1] ? [{ id: courseId }] : [];
        }
        if (sql.includes('FROM `groups`') || sql.includes('FROM \\`groups\\`')) {
            const matchId = sql.includes('WHERE g.id = ?');
            const idIndex = matchId ? 0 : undefined;
            return state.groups
                .filter((group) => !sql.includes('g.is_active = TRUE') || group.is_active)
                .filter((group) => inGroupSqlScope(group, sql, params, idIndex))
                .map((group) => ({ ...group }));
        }
        return [];
    };

    return {
        query: async <T>(sql: string, params: unknown[] = []) => respond(sql, params) as T[],
        queryOne: async <T>(sql: string, params: unknown[] = []) => {
            const rows = respond(sql, params);
            return (rows[0] ?? null) as T | null;
        },
        execute: async (sql: string, params: unknown[] = []) => {
            state.executed.push({ sql, params });
            if (fail) throw new Error('fixture database failure');
            if (sql.includes('INSERT INTO `groups`')) {
                const [id, name, description, course_id, grade_id, instructor_id, max_students, is_active, schedule_days, schedule_time] = params;
                state.groups.push({
                    id: String(id), name: String(name), description: description as string | null,
                    course_id: course_id as string | null, grade_id: grade_id as string | null,
                    instructor_id: instructor_id as string | null, max_students: Number(max_students),
                    is_active: Boolean(is_active), schedule_days: schedule_days as string | null,
                    schedule_time: schedule_time as string | null,
                });
                return { affectedRows: 1, insertId: 0 };
            }
            if (sql.includes('UPDATE `groups`')) {
                const id = String(params[8]);
                const group = state.groups.find((candidate) => candidate.id === id && inGroupSqlScope(candidate, sql, params.slice(9), undefined));
                if (!group) return { affectedRows: 0, insertId: 0 };
                if (params[0] != null) group.name = String(params[0]);
                return { affectedRows: 1, insertId: 0 };
            }
            if (sql.includes('DELETE g FROM `groups`')) {
                const id = String(params[0]);
                const index = state.groups.findIndex((candidate) => candidate.id === id && inGroupSqlScope(candidate, sql, params.slice(1), undefined));
                if (index < 0) return { affectedRows: 0, insertId: 0 };
                state.groups.splice(index, 1);
                return { affectedRows: 1, insertId: 0 };
            }
            return { affectedRows: 0, insertId: 0 };
        },
    };
};

const makeMeetingsDb = (state: FixtureState, fail = false): MeetingsDataAccess => {
    const respond = (sql: string, params: unknown[]) => {
        state.executed.push({ sql, params });
        if (fail) throw new Error('fixture database failure');
        if (sql.includes('m.is_active = 1')) {
            const [groupId, gradeId, instructorId] = params;
            return state.meetings.filter((meeting) => meeting.is_active === 1
                && meeting.created_by === instructorId
                && ((meeting.group_id !== null && meeting.group_id === groupId)
                    || (meeting.group_id === null && meeting.grade_id === gradeId)));
        }
        if (sql.includes('WHERE m.id = ?')) {
            const [id, creatorId] = params;
            return state.meetings.filter((meeting) => meeting.id === id
                && (!sql.includes('AND m.created_by = ?') || meeting.created_by === creatorId));
        }
        return [];
    };
    return {
        query: async <T>(sql: string, params: unknown[] = []) => respond(sql, params) as T[],
        queryOne: async <T>(sql: string, params: unknown[] = []) => {
            const rows = respond(sql, params);
            return (rows[0] ?? null) as T | null;
        },
        execute: async (sql: string, params: unknown[] = []) => {
            state.executed.push({ sql, params });
            if (fail) throw new Error('fixture database failure');
            return { affectedRows: 1, insertId: 0 };
        },
    };
};

const makeHarness = (options: { failGroups?: boolean; failMeetings?: boolean; failCapability?: boolean } = {}) => {
    const state = makeState();
    const principals = makePrincipalRepository();
    const auth = createOptionalAuth(principals) as RequestHandler;
    const teaching = createRequireTeachingWrite('groups', makeTeachingRepository()) as RequestHandler;
    const groupDeps: GroupsRouterDeps = {
        db: makeGroupsDb(state, options.failGroups),
        optionalAuthenticate: auth,
        authenticate: auth,
        requireTeachingWrite: teaching,
        hasVerifiedPlatformCapability: async () => {
            if (options.failCapability) throw new Error('capability lookup failed');
            return false;
        },
        branchAccess: tenantScopeBranchDeps((type, id) => {
            if (type !== 'group') return null;
            if (id === GROUP_B) return 'tenant-b';
            if (id === GROUP_ORPHAN) return null;
            return 'tenant-a';
        }),
    };
    const meetingDeps: MeetingsRouterDeps = {
        db: makeMeetingsDb(state, options.failMeetings),
        optionalAuthenticate: auth,
        hasVerifiedPlatformCapability: async () => false,
    };
    return { state, groups: createGroupsRouter(groupDeps), meetings: createMeetingsRouter(meetingDeps) };
};

interface InvokeOptions { method: string; url: string; token?: string; body?: unknown }

const invoke = (router: Router, options: InvokeOptions): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ status: 500, body: { error: 'test response timed out' } }), 5000);
        const response: any = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            status(code: number) { this.statusCode = code; return this; },
            set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
            setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
            json(body: unknown) {
                clearTimeout(timeout);
                resolve({ status: this.statusCode, body });
                return this;
            },
        };
        const request = {
            method: options.method,
            url: options.url,
            originalUrl: options.url,
            headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
            body: options.body ?? {},
            params: {},
            query: {},
        };
        (router as unknown as (req: unknown, res: unknown, next: NextFunction) => void)(request, response, () => {});
    });

test('groups list for a teacher is limited to the selected tenant owner and tenant-owned courses', async () => {
    const { groups, state } = makeHarness();
    const response = await invoke(groups, { method: 'GET', url: '/', token: TEACHER_A });

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as TestGroup[]).map((group) => group.id).sort(), [GROUP_A, GROUP_A_LEGACY, GROUP_A_OWNER].sort());
    const list = state.executed.find((call) => call.sql.includes('ORDER BY g.name'));
    assert.ok(list?.sql.includes('t.id = ?'));
    assert.deepEqual(list?.params.slice(0, 1), ['tenant-a']);
    assert.match(list?.sql ?? '', /g\.branch_scope/);
});

test('teacher cannot read or mutate another tenant group; mutation SQL is owner-scoped', async () => {
    const { groups, state } = makeHarness();

    const read = await invoke(groups, { method: 'GET', url: `/${GROUP_B}`, token: TEACHER_A });
    assert.equal(read.status, 404);

    const update = await invoke(groups, { method: 'PUT', url: `/${GROUP_B}`, token: TEACHER_A, body: { name: 'Hijack' } });
    assert.equal(update.status, 404);
    const remove = await invoke(groups, { method: 'DELETE', url: `/${GROUP_B}`, token: TEACHER_A });
    assert.equal(remove.status, 404);

    assert.equal(state.executed.some((call) => call.sql.includes('UPDATE `groups`')), false);
    const deleteCall = state.executed.find((call) => call.sql.includes('DELETE g FROM `groups`'));
    assert.ok(deleteCall?.sql.includes('t.id = ?'));
    assert.deepEqual(deleteCall?.params, [GROUP_B, 'tenant-a']);
    assert.ok(state.groups.some((group) => group.id === GROUP_B), 'the cross-tenant group remains unchanged');
});

test('teacher can update a tenant-owned group and the lock proves the tenant before the write', async () => {
    const { groups, state } = makeHarness();
    const response = await invoke(groups, { method: 'PUT', url: `/${GROUP_A}`, token: TEACHER_A, body: { name: 'Renamed' } });

    assert.equal(response.status, 200);
    // The target is locked under BOTH the selected tenant and the caller's
    // scope; only a row that lock proves reachable is ever updated.
    const lock = state.executed.find((call) => call.sql.includes('JOIN tenant_memberships')
        && call.sql.includes('tm.tenant_id=?')
        && call.sql.includes('FOR UPDATE'));
    assert.ok(lock, 'the write must lock the target under the selected tenant');
    assert.deepEqual(lock?.params, ['tenant-a', GROUP_A]);
    const update = state.executed.find((call) => call.sql.includes('UPDATE `groups`'));
    assert.ok(update, 'the update runs on the row the lock proved');
    assert.deepEqual(update?.params.slice(-1), [GROUP_A]);
    assert.equal(state.groups.find((group) => group.id === GROUP_A)?.name, 'Renamed');
});

test('creating a group refuses a course from another tenant instead of silently nulling it', async () => {
    const { groups, state } = makeHarness();
    const before = state.groups.length;
    const response = await invoke(groups, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: { name: 'New group', course_id: COURSE_B, grade_id: GRADE_SHARED },
    });

    // M2-B11: a malformed, foreign or archived course selector is a 400 — the
    // create never proceeds with the selector silently dropped.
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Invalid course selector' });
    const courseCheck = state.executed.find((call) => call.sql.includes('SELECT id FROM courses'));
    assert.deepEqual(courseCheck?.params, [COURSE_B, 'tenant-a']);
    assert.equal(state.executed.some((call) => call.sql.includes('INSERT INTO `groups`')), false);
    assert.equal(state.groups.length, before, 'no group is created');
});

test('student group lookup is restricted to the server-derived active enrollment group', async () => {
    const { groups, state } = makeHarness();
    const own = await invoke(groups, { method: 'GET', url: `/${GROUP_A}`, token: STUDENT_A });
    assert.equal(own.status, 200);
    const foreign = await invoke(groups, { method: 'GET', url: `/${GROUP_B}`, token: STUDENT_A });
    assert.equal(foreign.status, 404);
    assert.ok(state.executed.some((call) => call.sql.includes('g.id = ? AND EXISTS') && call.sql.includes('t.id = ?')));
});

test('missing selected tenant and database failure fail closed for group reads and writes', async () => {
    const noScope = makeHarness();
    const denied = await invoke(noScope.groups, { method: 'GET', url: '/', token: TEACHER_NO_SCOPE });
    assert.equal(denied.status, 403);
    assert.equal(noScope.state.executed.length, 0);

    const failing = makeHarness({ failGroups: true });
    const failed = await invoke(failing.groups, { method: 'GET', url: '/', token: TEACHER_A });
    assert.equal(failed.status, 500);
});

test('student meetings exclude another tenant grade-wide meeting even when grade ids match', async () => {
    const { meetings, state } = makeHarness();
    const response = await invoke(meetings, { method: 'GET', url: '/student/student-a', token: STUDENT_A });

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as TestMeeting[]).map((meeting) => meeting.id).sort(), ['meeting-a-grade', 'meeting-a-group']);
    const feed = state.executed.find((call) => call.sql.includes('m.is_active = 1'));
    assert.ok(feed?.sql.includes('m.created_by = ?'));
    assert.deepEqual(feed?.params, [GROUP_A, GRADE_SHARED, 'owner-a']);
});

test('student cannot fetch another tenant grade-wide meeting by id; owner is in the SELECT predicate', async () => {
    const { meetings, state } = makeHarness();
    const response = await invoke(meetings, { method: 'GET', url: '/meeting-b-grade', token: STUDENT_A });

    assert.equal(response.status, 404);
    const lookup = state.executed.find((call) => call.sql.includes('WHERE m.id = ?'));
    assert.ok(lookup?.sql.includes('AND m.created_by = ?'));
    assert.deepEqual(lookup?.params, ['meeting-b-grade', 'owner-a']);
});

test('group and meeting database failures return errors without widening access', async () => {
    const groupsFail = makeHarness({ failGroups: true });
    assert.equal((await invoke(groupsFail.groups, { method: 'GET', url: '/', token: TEACHER_A })).status, 500);

    const meetingsFail = makeHarness({ failMeetings: true });
    assert.equal((await invoke(meetingsFail.meetings, { method: 'GET', url: '/student/student-a', token: STUDENT_A })).status, 500);
});
