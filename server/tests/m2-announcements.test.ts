import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    buildVisibleAnnouncementFilter,
    buildVisibleScheduleFilter,
    isAnnouncementVisibleTo,
    isScheduleVisibleTo,
    normalizeAnnouncementAudience,
    validateAnnouncementInput,
    validateScheduleInput,
} from '../src/services/announcements';
import { createAnnouncementsRouter, type AnnouncementsDataAccess } from '../src/routes/announcements';
import {
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
    invokeRoute,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('announcement audience normalizes only tenant/branch', () => {
    assert.equal(normalizeAnnouncementAudience('tenant'), 'tenant');
    assert.equal(normalizeAnnouncementAudience('branch'), 'branch');
    assert.equal(normalizeAnnouncementAudience('group'), null);
    assert.equal(normalizeAnnouncementAudience(42), null);
});

test('validateAnnouncementInput rejects malformed payloads', () => {
    assert.equal(validateAnnouncementInput({}).ok, false);
    assert.equal(validateAnnouncementInput({ title: 'x', body: 'b', audience: 'group' }).ok, false);
    assert.equal(validateAnnouncementInput({ title: 'x', body: 'b', audience: 'branch' }).ok, false);
    assert.equal(validateAnnouncementInput({ title: 'x', body: 'b', audience: 'tenant', branch_id: 'br-1' }).ok, false);
    assert.equal(validateAnnouncementInput({ title: 'x', body: 'b', audit: 'tenant' }).ok, false);
    assert.equal(validateAnnouncementInput({ title: 'x', body: 'b', audience: 'tenant', timezone: 'Not/AZone' }).ok, false);
    assert.equal(validateAnnouncementInput({ title: 'x', body: 'b', audience: 'tenant', publish_at: 'not-a-date' }).ok, false);
});

test('validateAnnouncementInput accepts a tenant announcement and a branch announcement', () => {
    const tenant = validateAnnouncementInput({ title: 'Hi', body: 'Body', audience: 'tenant' });
    assert.equal(tenant.ok, true);
    if (tenant.ok) { assert.equal(tenant.value.branchId, null); assert.equal(tenant.value.publishAt, null); }
    const branch = validateAnnouncementInput({ title: 'Hi', body: 'Body', audience: 'branch', branch_id: 'br-1' });
    assert.equal(branch.ok, true);
    if (branch.ok) assert.equal(branch.value.branchId, 'br-1');
});

test('validateAnnouncementInput converts an authored local publish time to UTC', () => {
    const r = validateAnnouncementInput({ title: 'Hi', body: 'Body', audience: 'tenant', timezone: 'Africa/Cairo', publish_at: '2026-06-01 09:00' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.publishAt, '2026-06-01T06:00:00.000Z');
});

test('validateScheduleInput rejects non-positive windows and bad targets', () => {
    const base = { title: 'Lesson', timezone: 'UTC' };
    assert.equal(validateScheduleInput({ ...base, audience: 'tenant', starts_at: '2026-06-01 10:00', ends_at: '2026-06-01 09:00' }).ok, false);
    assert.equal(validateScheduleInput({ ...base, audience: 'branch', starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00' }).ok, false);
    assert.equal(validateScheduleInput({ ...base, audience: 'group', starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00' }).ok, false);
    assert.equal(validateScheduleInput({ ...base, audience: 'tenant', branch_id: 'br-1', starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00' }).ok, false);
    assert.equal(validateScheduleInput({ ...base, audience: 'tenant', starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00', timezone: 'Nope/Nope' }).ok, false);
});

test('validateScheduleInput converts a Cairo local window to UTC', () => {
    const r = validateScheduleInput({
        title: 'Lesson', audience: 'branch', branch_id: 'br-1', timezone: 'Africa/Cairo',
        starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.value.startsAt, '2026-06-01T06:00:00.000Z');
        assert.equal(r.value.endsAt, '2026-06-01T07:00:00.000Z');
    }
});

test('audience visibility is deny-by-default', () => {
    const viewer = { tenantId: 'tenant-a', branchId: 'br-1', groupId: 'grp-1' };
    assert.equal(isAnnouncementVisibleTo({ tenantId: 'tenant-a', audience: 'tenant', branchId: null }, viewer), true);
    assert.equal(isAnnouncementVisibleTo({ tenantId: 'tenant-a', audience: 'branch', branchId: 'br-1' }, viewer), true);
    assert.equal(isAnnouncementVisibleTo({ tenantId: 'tenant-a', audience: 'branch', branchId: 'br-2' }, viewer), false);
    assert.equal(isAnnouncementVisibleTo({ tenantId: 'tenant-b', audience: 'tenant', branchId: null }, viewer), false);
    assert.equal(isAnnouncementVisibleTo({ tenantId: 'tenant-a', audience: 'bogus', branchId: null }, viewer), false);
    assert.equal(isAnnouncementVisibleTo({ tenantId: 'tenant-a', audience: 'branch', branchId: 'br-1' }, { tenantId: 'tenant-a', branchId: null, groupId: null }), false);
    assert.equal(isScheduleVisibleTo({ tenantId: 'tenant-a', audience: 'group', branchId: null, groupId: 'grp-1' }, viewer), true);
    assert.equal(isScheduleVisibleTo({ tenantId: 'tenant-a', audience: 'group', branchId: null, groupId: 'grp-2' }, viewer), false);
});

test('audience SQL filters are tenant/branch/group scoped with NULL-binding deny', () => {
    const filter = buildVisibleAnnouncementFilter({ tenantId: 'tenant-a', branchId: null, groupId: null });
    assert.match(filter.sql, /audience='tenant'/);
    assert.deepEqual(filter.params, [null]);
    assert.match(buildVisibleScheduleFilter({ tenantId: 'tenant-a', branchId: 'br-1', groupId: 'grp-1' }).sql, /group_id=\?/);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const AUTHORITY: Record<string, string> = { 'instructor-a': 'instructor' };

const buildRouter = (
    responder: (sql: string, params: unknown[]) => unknown[] | null,
    overrides: { authority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null> } = {},
) => {
    const db = makeFakeDataAccess(responder);
    const users = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: {
            'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }], 'instructor-b': [{ tenant_id: 'tenant-b' }] },
        enrollments: {
            'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null }],
        },
    });
    const loadActiveTenantAuthority = overrides.authority ?? (async (userId, tenantId) => {
        const authority = AUTHORITY[userId];
        return authority && tenantId === 'tenant-a' ? { authority } : null;
    });
    const router = createAnnouncementsRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        transaction: async <T>(fn: (tx: AnnouncementsDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
};

const auditAction = (executed: { sql: string; params: unknown[] }[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

const branchRow = (sql: string) => sql.includes('FROM branches WHERE id = ? AND tenant_id = ?');
const groupRow = (sql: string) => sql.includes('FROM `groups` g') && sql.includes('c.tenant_id = ?');

// --- announcements list ---
test('announcements: anonymous list is 401 with no data access', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('announcements: a cross-tenant instructor is 403', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 403);
});

test('announcements: list is tenant-scoped and returns rows', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM announcements WHERE tenant_id=?') ? [{ id: 'an-1' }] : [],
    );
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, [{ id: 'an-1' }]);
    assert.ok(executed.some((e) => e.sql.includes('WHERE tenant_id=?') && e.params[0] === 'tenant-a'));
});

// --- announcements create ---
test('announcements: create rejects an invalid payload with 400 and no write', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: INSTRUCTOR_A, body: { title: '' } });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO announcements')), false);
});

test('announcements: create denies a branch outside the tenant with 403', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { title: 'T', body: 'B', audience: 'branch', branch_id: 'br-x' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO announcements')), false);
});

test('announcements: create writes the row and audits it', async () => {
    const { router, executed } = buildRouter((sql) =>
        branchRow(sql) ? [{ id: 'br-1', status: 'active' }] : [],
    );
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { title: 'Exam', body: 'Tomorrow', audience: 'branch', branch_id: 'br-1' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { status?: string }).status, 'published');
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO announcements')));
    assert.ok(auditAction(executed, 'announcement.create'));
});

// --- announcements edit ---
test('announcements: edit of an unknown id is 404 with no write', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'PATCH', url: '/missing', token: INSTRUCTOR_A, body: { title: 'X' },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE announcements')), false);
});

test('announcements: a retracted announcement cannot be edited (409)', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM announcements WHERE id=?') ? [{ id: 'an-1', tenant_id: 'tenant-a', status: 'retracted', title: 'x', body: 'b', audience: 'tenant', branch_id: null, version: 2 }] : [],
    );
    const response = await invokeRoute(router, {
        method: 'PATCH', url: '/an-1', token: INSTRUCTOR_A, body: { title: 'X' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE announcements')), false);
});

test('announcements: edit updates under an optimistic version guard and audits', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM announcements WHERE id=?')
            ? [{ id: 'an-1', tenant_id: 'tenant-a', status: 'published', title: 'old', body: 'b', audience: 'tenant', branch_id: null, version: 3 }]
            : [],
    );
    const response = await invokeRoute(router, {
        method: 'PATCH', url: '/an-1', token: INSTRUCTOR_A, body: { title: 'new' },
    });
    assert.equal(response.statusCode, 200);
    const update = executed.find((e) => e.sql.includes('UPDATE announcements'));
    assert.ok(update);
    assert.equal(update!.params[update!.params.length - 1], 3);
    assert.ok(auditAction(executed, 'announcement.update'));
});

// --- announcements retract ---
test('announcements: retract of an unknown id is 404', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/missing/retract', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
});

test('announcements: retract is audited', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM announcements WHERE id=?')
            ? [{ id: 'an-1', tenant_id: 'tenant-a', status: 'published', title: 'x', audience: 'tenant', published_at: null, version: 1 }]
            : [],
    );
    const response = await invokeRoute(router, { method: 'POST', url: '/an-1/retract', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { status?: string }).status, 'retracted');
    assert.ok(auditAction(executed, 'announcement.retract'));
});

// --- student announcements ---
test('announcements: a non-student cannot read the student feed (403)', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 403);
});

test('announcements: a student with no active enrollment is 404', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('announcements: a student feed filters by tenant + proven branch in SQL', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) {
            return [{ id: 'enr-a', tenant_id: 'tenant-a', group_id: 'grp-1', branch_id: 'br-1', branch_scope: 'branch' }];
        }
        if (sql.includes('FROM announcements')) return [{ id: 'an-1', audience: 'branch' }];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const feed = executed.find((e) => e.sql.includes('FROM announcements'));
    assert.ok(feed);
    assert.match(feed!.sql, /status='published'/);
    assert.equal(feed!.params[0], 'tenant-a');
    assert.equal(feed!.params[1], 'br-1');
});

// --- schedules ---
test('schedules: create rejects an invalid window with 400', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/schedules', token: INSTRUCTOR_A,
        body: { title: 'S', audience: 'tenant', starts_at: '2026-06-01 10:00', ends_at: '2026-06-01 09:00' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO schedules')), false);
});

test('schedules: create denies a group outside the tenant', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/schedules', token: INSTRUCTOR_A,
        body: { title: 'S', audience: 'group', group_id: 'grp-x', starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO schedules')), false);
});

test('schedules: create stores the UTC window and audits it', async () => {
    const { router, executed } = buildRouter((sql) => (groupRow(sql) ? [{ id: 'grp-1' }] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/schedules', token: INSTRUCTOR_A,
        body: {
            title: 'Live', audience: 'group', group_id: 'grp-1', timezone: 'Africa/Cairo',
            starts_at: '2026-06-01 09:00', ends_at: '2026-06-01 10:00',
        },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO schedules'));
    assert.ok(insert);
    assert.equal(insert!.params[7], '2026-06-01 06:00:00');
    assert.equal(insert!.params[8], '2026-06-01 07:00:00');
    assert.ok(auditAction(executed, 'schedule.create'));
});

test('schedules: cancel of an unknown id is 404 and a cancelled one is 409', async () => {
    const unknown = buildRouter(() => []);
    assert.equal((await invokeRoute(unknown.router, { method: 'POST', url: '/schedules/missing/cancel', token: INSTRUCTOR_A })).statusCode, 404);
    const cancelled = buildRouter((sql) =>
        sql.includes('FROM schedules WHERE id=?') ? [{ id: 'sc-1', tenant_id: 'tenant-a', status: 'cancelled', title: 'x', audience: 'tenant', starts_at: null, version: 1 }] : [],
    );
    assert.equal((await invokeRoute(cancelled.router, { method: 'POST', url: '/schedules/sc-1/cancel', token: INSTRUCTOR_A })).statusCode, 409);
});

test('schedules: cancel is audited', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM schedules WHERE id=?') ? [{ id: 'sc-1', tenant_id: 'tenant-a', status: 'scheduled', title: 'x', audience: 'tenant', starts_at: null, version: 1 }] : [],
    );
    const response = await invokeRoute(router, { method: 'POST', url: '/schedules/sc-1/cancel', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'schedule.cancel'));
});

test('schedules: edit of a cancelled schedule is 409 and no write happens', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM schedules WHERE id=?') ? [{ id: 'sc-1', tenant_id: 'tenant-a', status: 'cancelled', title: 'x', audience: 'tenant', starts_at: null, ends_at: null, timezone: 'UTC', branch_id: null, group_id: null, version: 1 }] : [],
    );
    const response = await invokeRoute(router, { method: 'PATCH', url: '/schedules/sc-1', token: INSTRUCTOR_A, body: { title: 'y' } });
    assert.equal(response.statusCode, 409);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE schedules')), false);
});

test('schedules: student feed returns only the caller audience', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) {
            return [{ id: 'enr-a', tenant_id: 'tenant-a', group_id: 'grp-1', branch_id: null, branch_scope: 'tenant' }];
        }
        if (sql.includes('FROM schedules')) return [{ id: 'sc-1' }];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/schedules/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const feed = executed.find((e) => e.sql.includes('FROM schedules'));
    assert.ok(feed);
    assert.equal(feed!.params[1], null);
    assert.equal(feed!.params[2], 'grp-1');
});

// --- audit failure rolls the mutation back ---
test('announcements: an audit failure fails the create (500) rather than committing unaudited', async () => {
    const db = makeFakeDataAccess(() => []);
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit storage unavailable');
        return db.execute(sql, params);
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const tx: AnnouncementsDataAccess = { query: db.query, queryOne: db.queryOne, execute };
    const router = createAnnouncementsRouter({
        db: tx,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: AnnouncementsDataAccess) => Promise<T>) => fn(tx),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: { title: 'T', body: 'B', audience: 'tenant' },
    });
    assert.equal(response.statusCode, 500);
});
