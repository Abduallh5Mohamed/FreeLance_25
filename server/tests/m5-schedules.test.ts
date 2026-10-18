import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    expandRecurrence,
    parseCalendarDate,
    daysInMonth,
    normalizeRecurrenceKind,
    sessionDurationMinutes,
    validateCancelInput,
    validateRescheduleInput,
    validateSeriesInput,
} from '../src/services/schedules';
import {
    createSchedulesRouter,
    type ScheduleChangeEvent,
    type ScheduleNotifier,
    type SchedulesDataAccess,
} from '../src/routes/schedules';
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

test('normalizeRecurrenceKind accepts only weekly/monthly', () => {
    assert.equal(normalizeRecurrenceKind('weekly'), 'weekly');
    assert.equal(normalizeRecurrenceKind('monthly'), 'monthly');
    assert.equal(normalizeRecurrenceKind('daily'), null);
    assert.equal(normalizeRecurrenceKind(1), null);
});

test('parseCalendarDate and daysInMonth reject impossible dates', () => {
    assert.deepEqual(parseCalendarDate('2026-02-28'), { year: 2026, month: 2, day: 28 });
    assert.equal(parseCalendarDate('2026-02-29'), null);
    assert.equal(parseCalendarDate('2026-13-01'), null);
    assert.equal(parseCalendarDate('nope'), null);
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2026, 4), 30);
});

test('expandRecurrence expands a weekly rule to the exact Mondays in UTC', () => {
    const occurrences = expandRecurrence({
        kind: 'weekly', weekdays: [1], dayOfMonth: null,
        startsOn: '2026-06-01', endsOn: '2026-06-30', startTime: '10:00', durationMinutes: 60, timezone: 'UTC',
    });
    assert.equal(occurrences.length, 5);
    assert.equal(occurrences[0].startsAt, '2026-06-01T10:00:00.000Z');
    assert.equal(occurrences[0].endsAt, '2026-06-01T11:00:00.000Z');
    assert.equal(occurrences[4].startsAt, '2026-06-29T10:00:00.000Z');
});

test('expandRecurrence keeps the local wall time across a DST boundary', () => {
    const occurrences = expandRecurrence({
        kind: 'weekly', weekdays: [0], dayOfMonth: null,
        startsOn: '2026-03-01', endsOn: '2026-03-15', startTime: '09:00', durationMinutes: 60, timezone: 'America/New_York',
    });
    assert.equal(occurrences.length, 3);
    // 2026-03-01 is EST (UTC-5); 2026-03-15 is EDT (UTC-4) after the 03-08 change.
    assert.equal(occurrences[0].startsAt, '2026-03-01T14:00:00.000Z');
    assert.equal(occurrences[2].startsAt, '2026-03-15T13:00:00.000Z');
});

test('expandRecurrence clamps a monthly day 31 to the month end', () => {
    const occurrences = expandRecurrence({
        kind: 'monthly', weekdays: [], dayOfMonth: 31,
        startsOn: '2026-01-01', endsOn: '2026-04-30', startTime: '08:00', durationMinutes: 30, timezone: 'UTC',
    });
    assert.deepEqual(
        occurrences.map((o) => o.startsAt),
        [
            '2026-01-31T08:00:00.000Z',
            '2026-02-28T08:00:00.000Z',
            '2026-03-31T08:00:00.000Z',
            '2026-04-30T08:00:00.000Z',
        ],
    );
});

test('expandRecurrence fails closed on invalid rules and honours the cap', () => {
    const base = { weekdays: [1], dayOfMonth: null, startsOn: '2026-06-01', endsOn: '2026-06-30', startTime: '10:00', durationMinutes: 60, timezone: 'UTC' } as const;
    assert.deepEqual(expandRecurrence({ ...base, kind: 'weekly', weekdays: [] }), []);
    assert.deepEqual(expandRecurrence({ ...base, kind: 'weekly', timezone: 'Not/AZone' }), []);
    assert.deepEqual(expandRecurrence({ ...base, kind: 'weekly', startTime: '25:00' }), []);
    assert.deepEqual(expandRecurrence({ ...base, kind: 'weekly', endsOn: '2026-05-01' }), []);
    const capped = expandRecurrence({ ...base, kind: 'weekly', endsOn: null }, 2);
    assert.equal(capped.length, 2);
});

test('validateSeriesInput rejects malformed recurrences and accepts a weekly rule', () => {
    assert.equal(validateSeriesInput({}).ok, false);
    assert.equal(validateSeriesInput({ title: 'T', audience: 'tenant', recurrence: 'daily', starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 }).ok, false);
    assert.equal(validateSeriesInput({ title: 'T', audience: 'tenant', recurrence: 'weekly', weekdays: [], starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 }).ok, false);
    assert.equal(validateSeriesInput({ title: 'T', audience: 'branch', recurrence: 'weekly', weekdays: [1], starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 }).ok, false);
    assert.equal(validateSeriesInput({ title: 'T', audience: 'tenant', recurrence: 'monthly', day_of_month: 0, starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 }).ok, false);
    assert.equal(validateSeriesInput({ title: 'T', audience: 'tenant', recurrence: 'monthly', day_of_month: 15, starts_on: '2026-06-10', ends_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 }).ok, false);

    const ok = validateSeriesInput({
        title: 'Class', audience: 'group', group_id: 'grp-1', timezone: 'Africa/Cairo',
        recurrence: 'weekly', weekdays: '1,3', starts_on: '2026-06-01', ends_on: '2026-06-30',
        start_time: '09:00', duration_minutes: 90,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.deepEqual(ok.value.weekdays, [1, 3]);
        assert.equal(ok.value.groupId, 'grp-1');
        assert.equal(ok.value.timezone, 'Africa/Cairo');
    }
});

test('validateCancelInput and validateRescheduleInput require a reason', () => {
    assert.equal(validateCancelInput({}).ok, false);
    assert.equal(validateCancelInput({ reason: 'x' }).ok, true);
    assert.equal(validateRescheduleInput({ starts_at: '2026-06-02 09:00' }, { timezone: 'UTC', durationMinutes: 60 }).ok, false);
    const rescheduled = validateRescheduleInput(
        { starts_at: '2026-06-02 09:00', reason: 'conflict' },
        { timezone: 'UTC', durationMinutes: 60 },
    );
    assert.equal(rescheduled.ok, true);
    if (rescheduled.ok) {
        assert.equal(rescheduled.value.startsAt, '2026-06-02T09:00:00.000Z');
        assert.equal(rescheduled.value.endsAt, '2026-06-02T10:00:00.000Z');
    }
    const badWindow = validateRescheduleInput(
        { starts_at: '2026-06-02 09:00', ends_at: '2026-06-02 08:00', reason: 'x' },
        { timezone: 'UTC', durationMinutes: 60 },
    );
    assert.equal(badWindow.ok, false);
});

test('sessionDurationMinutes reads stored UTC instants', () => {
    assert.equal(sessionDurationMinutes('2026-06-01 09:00:00', '2026-06-01 10:30:00'), 90);
    assert.equal(sessionDurationMinutes('2026-06-01 10:00:00', '2026-06-01 09:00:00'), null);
    assert.equal(sessionDurationMinutes('nope', '2026-06-01 09:00:00'), null);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const AUTHORITY: Record<string, string> = { 'instructor-a': 'instructor' };

interface HarnessOptions {
    authority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    notifier?: ScheduleNotifier;
}

const buildRouter = (
    responder: (sql: string, params: unknown[]) => unknown[] | null,
    options: HarnessOptions = {},
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
    const loadActiveTenantAuthority = options.authority ?? (async (userId: string, tenantId: string) => {
        const authority = AUTHORITY[userId];
        return authority && tenantId === 'tenant-a' ? { authority } : null;
    });
    const router = createSchedulesRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        notifications: options.notifier,
        now: () => new Date('2026-06-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: SchedulesDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
};

const auditAction = (executed: { sql: string; params: unknown[] }[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

const branchRow = (sql: string) => sql.includes('FROM branches WHERE id = ?');
const groupRow = (sql: string) => sql.includes('FROM `groups` g LEFT JOIN courses c');
const sessionLoad = (sql: string) => sql.includes('FROM schedule_sessions') && sql.includes('WHERE id = ? AND tenant_id = ?');

// --- list / anonymous / cross-tenant ---
test('schedules: anonymous list is 401 with no data access', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('schedules: a cross-tenant instructor is 403', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 403);
});

test('schedules: list is tenant-scoped and returns rows', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM schedule_series') ? [{ id: 'ser-1' }] : [],
    );
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, [{ id: 'ser-1' }]);
    const list = executed.find((e) => e.sql.includes('FROM schedule_series'));
    assert.ok(list);
    assert.equal(list!.params[0], 'tenant-a');
});

// --- create series ---
test('schedules: create rejects an invalid payload with 400 and no write', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: { title: 'T', audience: 'tenant', recurrence: 'weekly', weekdays: [], starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO schedule_series')), false);
});

test('schedules: create denies a branch outside the tenant with 403', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: { title: 'T', audience: 'branch', branch_id: 'br-x', recurrence: 'weekly', weekdays: [1], starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO schedule_series')), false);
});

test('schedules: create denies a group outside the tenant with 403', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: { title: 'T', audience: 'group', group_id: 'grp-x', recurrence: 'weekly', weekdays: [1], starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO schedule_series')), false);
});

test('schedules: create materializes sessions, audits and notifies', async () => {
    const events: ScheduleChangeEvent[] = [];
    const notifier: ScheduleNotifier = { notify: async (event) => { events.push(event); } };
    const { router, executed } = buildRouter((sql) => (groupRow(sql) ? [{ id: 'grp-1', instructor_id: 'instructor-a', tenant_id: 'tenant-a' }] : []), { notifier });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: {
            title: 'Live', audience: 'group', group_id: 'grp-1', timezone: 'Africa/Cairo',
            recurrence: 'weekly', weekdays: [1], starts_on: '2026-06-01', ends_on: '2026-06-30',
            start_time: '09:00', duration_minutes: 60,
        },
    });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { sessions?: number }).sessions, 5);
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO schedule_series')));
    assert.equal(executed.filter((e) => e.sql.includes('INSERT IGNORE INTO schedule_sessions')).length, 5);
    assert.ok(auditAction(executed, 'schedule.series.create'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'series.created');
    assert.equal(events[0].sessionIds.length, 5);
});

test('schedules: create of a group owned by another instructor is 403', async () => {
    const { router } = buildRouter((sql) => (groupRow(sql) ? [{ id: 'grp-9', instructor_id: 'other', tenant_id: 'tenant-a' }] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: { title: 'T', audience: 'group', group_id: 'grp-9', recurrence: 'weekly', weekdays: [1], starts_on: '2026-06-01', start_time: '09:00', duration_minutes: 60 },
    });
    assert.equal(response.statusCode, 403);
});

// --- cancel ---
const sessionRecord = {
    id: 'se-1', tenant_id: 'tenant-a', branch_id: null, group_id: 'grp-1', title: 'x',
    audience: 'group', timezone: 'UTC', starts_at: '2026-06-01 09:00:00', ends_at: '2026-06-01 10:00:00',
    status: 'scheduled', created_by: 'instructor-a', version: 1,
};

test('schedules: cancel of an unknown id is 404 and a cancelled one is 409', async () => {
    const unknown = buildRouter(() => []);
    assert.equal((await invokeRoute(unknown.router, { method: 'POST', url: '/sessions/missing/cancel', token: INSTRUCTOR_A, body: { reason: 'x' } })).statusCode, 404);
    const cancelled = buildRouter((sql) => (sessionLoad(sql) ? [{ ...sessionRecord, status: 'cancelled' }] : []));
    assert.equal((await invokeRoute(cancelled.router, { method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: { reason: 'x' } })).statusCode, 409);
    const noReason = buildRouter((sql) => (sessionLoad(sql) ? [sessionRecord] : []));
    assert.equal((await invokeRoute(noReason.router, { method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: {} })).statusCode, 400);
});

test('schedules: cancel is audited with actor/time/reason and notifies', async () => {
    const events: ScheduleChangeEvent[] = [];
    const notifier: ScheduleNotifier = { notify: async (event) => { events.push(event); } };
    const { router, executed } = buildRouter((sql) => (sessionLoad(sql) ? [sessionRecord] : []), { notifier });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: { reason: 'teacher sick' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { status?: string }).status, 'cancelled');
    const update = executed.find((e) => e.sql.includes('UPDATE schedule_sessions'));
    assert.ok(update);
    assert.match(update!.sql, /cancel_reason=\?/);
    assert.match(update!.sql, /cancelled_at=UTC_TIMESTAMP\(\)/);
    const audit = auditAction(executed, 'schedule.session.cancel');
    assert.ok(audit);
    assert.equal(audit!.params[8], 'teacher sick');
    assert.equal(events[0].type, 'session.cancelled');
    assert.equal(events[0].reason, 'teacher sick');
});

test('schedules: a session outside the caller groups is 404 (deny by default)', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: { reason: 'x' } });
    assert.equal(response.statusCode, 404);
    const load = executed.find((e) => sessionLoad(e.sql));
    assert.ok(load);
    assert.match(load!.sql, /instructor_id = \?/);
    assert.equal(load!.params[1], 'tenant-a');
    assert.equal(load!.params[2], 'instructor-a');
});

// --- reschedule ---
test('schedules: reschedule validates, audits before/after and notifies', async () => {
    const events: ScheduleChangeEvent[] = [];
    const notifier: ScheduleNotifier = { notify: async (event) => { events.push(event); } };
    const { router, executed } = buildRouter((sql) => (sessionLoad(sql) ? [sessionRecord] : []), { notifier });
    const invalid = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A, body: { starts_at: 'not-a-time', reason: 'x' },
    });
    assert.equal(invalid.statusCode, 400);

    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A,
        body: { starts_at: '2026-06-02 09:00', reason: 'room double-booked' },
    });
    assert.equal(response.statusCode, 200);
    const update = executed.find((e) => e.sql.includes('UPDATE schedule_sessions'));
    assert.ok(update);
    assert.match(update!.sql, /rescheduled_from=starts_at/);
    assert.equal(update!.params[0], '2026-06-02 09:00:00');
    assert.equal(update!.params[1], '2026-06-02 10:00:00');
    assert.ok(auditAction(executed, 'schedule.session.reschedule'));
    assert.equal(events[0].type, 'session.rescheduled');
});

test('schedules: a cancelled session cannot be rescheduled', async () => {
    const { router } = buildRouter((sql) => (sessionLoad(sql) ? [{ ...sessionRecord, status: 'cancelled' }] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A,
        body: { starts_at: '2026-06-02 09:00', reason: 'x' },
    });
    assert.equal(response.statusCode, 409);
});

// --- student feed ---
test('schedules: a non-student cannot read the student feed (403)', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 403);
});

test('schedules: a student with no active enrollment is 404', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('schedules: a student feed filters by tenant + proven branch + group in SQL', async () => {
    const { router, executed } = buildRouter((sql) => {
        if (sql.includes('FROM students s LEFT JOIN')) {
            return [{ id: 'enr-a', tenant_id: 'tenant-a', group_id: 'grp-1', branch_id: 'br-1', branch_scope: 'branch' }];
        }
        if (sql.includes('FROM schedule_sessions')) return [{ id: 'se-1' }];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const feed = executed.find((e) => e.sql.includes('FROM schedule_sessions') && e.sql.includes('status='));
    assert.ok(feed);
    assert.match(feed!.sql, /status='scheduled'/);
    assert.equal(feed!.params[0], 'tenant-a');
    assert.equal(feed!.params[1], 'br-1');
    assert.equal(feed!.params[2], 'grp-1');
});

// --- audit failure rolls back ---
test('schedules: an audit failure fails the series create (500)', async () => {
    const db = makeFakeDataAccess(() => []);
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit storage unavailable');
        return db.execute(sql, params);
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const tx: SchedulesDataAccess = { query: db.query, queryOne: db.queryOne, execute };
    const router = createSchedulesRouter({
        db: tx,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        now: () => new Date('2026-06-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: SchedulesDataAccess) => Promise<T>) => fn(tx),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: { title: 'T', audience: 'tenant', recurrence: 'weekly', weekdays: [1], starts_on: '2026-06-01', ends_on: '2026-06-08', start_time: '09:00', duration_minutes: 60 },
    });
    assert.equal(response.statusCode, 500);
});
