import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Router } from 'express';
import { createOptionalAuth } from '../src/middleware/auth';
import { createRequireTeachingWrite, TeachingAccessRepository } from '../src/middleware/teaching-access';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createGroupsRouter, GroupsDataAccess, GroupsRouterDeps } from '../src/routes/groups';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import { createMeetingsRouter, MeetingsDataAccess, MeetingsRouterDeps } from '../src/routes/meetings';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

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
        { id: 'group-a', name: 'Alpha', course_id: 'course-a', grade_id: 'grade-shared', instructor_id: 'owner-a', is_active: true },
        { id: 'group-a-owner', name: 'Alpha owner-only', course_id: null, grade_id: 'grade-shared', instructor_id: 'owner-a', is_active: true },
        { id: 'group-a-legacy', name: 'Alpha legacy', course_id: 'course-a', grade_id: 'grade-shared', instructor_id: null, is_active: true },
        { id: 'group-b', name: 'Beta', course_id: 'course-b', grade_id: 'grade-shared', instructor_id: 'owner-b', is_active: true },
        { id: 'group-orphan', name: 'Orphan', course_id: null, grade_id: 'grade-shared', instructor_id: null, is_active: true },
    ],
    meetings: [
        {
            id: 'meeting-a-grade', title: 'Alpha grade-wide', description: null, meeting_link: 'https://meet.example/a',
            meeting_type: 'zoom', meeting_password: null, grade_id: 'grade-shared', group_id: null,
            scheduled_at: '2030-01-01 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'owner-a',
        },
        {
            id: 'meeting-b-grade', title: 'Beta grade-wide', description: null, meeting_link: 'https://meet.example/b',
            meeting_type: 'zoom', meeting_password: 'foreign-secret', grade_id: 'grade-shared', group_id: null,
            scheduled_at: '2030-01-02 10:00:00', duration_minutes: 60, is_active: 1, created_by: 'owner-b',
        },
        {
            id: 'meeting-a-group', title: 'Alpha group', description: null, meeting_link: 'https://meet.example/ag',
            meeting_type: 'zoom', meeting_password: null, grade_id: 'grade-shared', group_id: 'group-a',
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
        ? [{ id: 'enrollment-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'owner-a', group_id: 'group-a', grade_id: 'grade-shared' }]
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
const courseTenant: Record<string, string> = { 'course-a': 'tenant-a', 'course-b': 'tenant-b' };

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

const makeGroupsDb = (state: FixtureState, fail = false): GroupsDataAccess => {
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
            if (id === 'group-b') return 'tenant-b';
            if (id === 'group-orphan') return null;
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
            status(code: number) { this.statusCode = code; return this; },
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
    assert.deepEqual((response.body as TestGroup[]).map((group) => group.id).sort(), ['group-a', 'group-a-legacy', 'group-a-owner']);
    const list = state.executed.find((call) => call.sql.includes('ORDER BY g.name'));
    assert.ok(list?.sql.includes('t.id = ?'));
    assert.deepEqual(list?.params.slice(0, 1), ['tenant-a']);
    assert.match(list?.sql ?? '', /g\.branch_scope/);
});

test('teacher cannot read or mutate another tenant group; mutation SQL is owner-scoped', async () => {
    const { groups, state } = makeHarness();

    const read = await invoke(groups, { method: 'GET', url: '/group-b', token: TEACHER_A });
    assert.equal(read.status, 404);

    const update = await invoke(groups, { method: 'PUT', url: '/group-b', token: TEACHER_A, body: { name: 'Hijack' } });
    assert.equal(update.status, 404);
    const remove = await invoke(groups, { method: 'DELETE', url: '/group-b', token: TEACHER_A });
    assert.equal(remove.status, 404);

    assert.equal(state.executed.some((call) => call.sql.includes('UPDATE `groups`')), false);
    const deleteCall = state.executed.find((call) => call.sql.includes('DELETE g FROM `groups`'));
    assert.ok(deleteCall?.sql.includes('t.id = ?'));
    assert.deepEqual(deleteCall?.params, ['group-b', 'tenant-a']);
    assert.ok(state.groups.some((group) => group.id === 'group-b'), 'the cross-tenant group remains unchanged');
});

test('teacher can update a tenant-owned group and the UPDATE carries its tenant predicate', async () => {
    const { groups, state } = makeHarness();
    const response = await invoke(groups, { method: 'PUT', url: '/group-a', token: TEACHER_A, body: { name: 'Renamed' } });

    assert.equal(response.status, 200);
    const update = state.executed.find((call) => call.sql.includes('UPDATE `groups`'));
    assert.ok(update?.sql.includes('t.id = ?'));
    assert.deepEqual(update?.params.slice(-1), ['tenant-a']);
    assert.equal(state.groups.find((group) => group.id === 'group-a')?.name, 'Renamed');
});

test('creating a group ignores a course from another tenant and assigns the selected tenant owner', async () => {
    const { groups, state } = makeHarness();
    const response = await invoke(groups, {
        method: 'POST', url: '/', token: TEACHER_A,
        body: { name: 'New group', course_id: 'course-b', grade_id: 'grade-shared' },
    });

    assert.equal(response.status, 201);
    const courseCheck = state.executed.find((call) => call.sql.includes('SELECT id FROM courses'));
    assert.deepEqual(courseCheck?.params, ['course-b', 'tenant-a']);
    const insert = state.executed.find((call) => call.sql.includes('INSERT INTO `groups`'));
    assert.equal(insert?.params[3], null);
    assert.equal(insert?.params[5], 'owner-a');
});

test('student group lookup is restricted to the server-derived active enrollment group', async () => {
    const { groups, state } = makeHarness();
    const own = await invoke(groups, { method: 'GET', url: '/group-a', token: STUDENT_A });
    assert.equal(own.status, 200);
    const foreign = await invoke(groups, { method: 'GET', url: '/group-b', token: STUDENT_A });
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
    assert.deepEqual(feed?.params, ['group-a', 'grade-shared', 'owner-a']);
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
