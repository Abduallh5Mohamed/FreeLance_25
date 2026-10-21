import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    expandRecurrence,
    expandRecurrenceDetailed,
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
    assert.ok(Array.isArray(response.body), 'the series list is a bare array, exactly its pre-batch shape');
    assert.deepEqual(response.body, [{ id: 'ser-1' }]);
    assert.equal(response.headers?.['x-results-truncated'], 'false', 'truncation metadata lives in the response header');
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

// ---------------------------------------------------------------------------
// 2026-10-19 correctness audit: input strictness, storage range, window bounds
// ---------------------------------------------------------------------------

const SERIES_BASE = {
    title: 'T', audience: 'tenant', recurrence: 'weekly', starts_on: '2026-06-01',
    start_time: '09:00', duration_minutes: 60,
} as const;

test('validateSeriesInput rejects blank or non-scalar weekday entries instead of coercing them to Sunday', () => {
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: ['1', ''] }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [' '] }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: '1,,3' }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [[1]] }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [true] }).ok, false);
    const ok = validateSeriesInput({ ...SERIES_BASE, weekdays: ['0', 3, '6'] });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.value.weekdays, [0, 3, 6]);
});

test('validateSeriesInput rejects booleans/arrays as numbers for duration and day_of_month', () => {
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], duration_minutes: true }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], duration_minutes: [60] }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, recurrence: 'monthly', day_of_month: true }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, recurrence: 'monthly', day_of_month: [5] }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], duration_minutes: '90' }).ok, true);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, recurrence: 'monthly', day_of_month: '15' }).ok, true);
});

test('validateSeriesInput does not silently drop non-zero seconds from start_time', () => {
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], start_time: '09:30:45' }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], start_time: '09:30:00' }).ok, true);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], start_time: '9:30' }).ok, true);
});

test('calendar dates outside the DATETIME-safe years are rejected, never formatted as a short year', () => {
    assert.equal(parseCalendarDate('0001-01-01'), null);
    assert.equal(parseCalendarDate('0999-12-31'), null);
    assert.deepEqual(parseCalendarDate('1000-01-01'), { year: 1000, month: 1, day: 1 });
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], starts_on: '0001-01-01' }).ok, false);
    assert.equal(validateSeriesInput({ ...SERIES_BASE, weekdays: [1], ends_on: '0500-01-01' }).ok, false);
});

test('expandRecurrence never emits an instant outside the storable year range', () => {
    const occurrences = expandRecurrence({
        kind: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6], dayOfMonth: null,
        startsOn: '9999-12-25', endsOn: null, startTime: '23:30', durationMinutes: 120, timezone: 'UTC',
    });
    assert.ok(occurrences.length > 0);
    for (const o of occurrences) {
        assert.match(o.startsAt, /^\d{4}-/);
        assert.match(o.endsAt, /^\d{4}-/);
    }
});

test('validateRescheduleInput requires a time of day and a storable, bounded window', () => {
    const ctx = { timezone: 'UTC', durationMinutes: 60 };
    // date-only would silently become midnight
    assert.equal(validateRescheduleInput({ starts_at: '2026-06-02', reason: 'x' }, ctx).ok, false);
    // longer than the 24h session maximum enforced for series
    assert.equal(validateRescheduleInput({ starts_at: '2026-06-02 09:00', ends_at: '2027-06-02 09:00', reason: 'x' }, ctx).ok, false);
    // end spilling past year 9999 would serialize as +010000-...
    assert.equal(validateRescheduleInput({ starts_at: '9999-12-31 23:30', reason: 'x' }, ctx).ok, false);
    // valid exactly-24h window and ordinary window still pass
    assert.equal(validateRescheduleInput({ starts_at: '2026-06-02 09:00', ends_at: '2026-06-03 09:00', reason: 'x' }, ctx).ok, true);
    assert.equal(validateRescheduleInput({ starts_at: '2026-06-02T09:00', reason: 'x' }, ctx).ok, true);
});

test('DST contract is stable: wall time kept across fall-back; gap yields no occurrence, overlap exactly one', () => {
    const rule = {
        kind: 'weekly', weekdays: [0], dayOfMonth: null, startsOn: '2026-10-25', endsOn: '2026-11-08',
        startTime: '09:00', durationMinutes: 60, timezone: 'America/New_York',
    } as const;
    const o = expandRecurrence(rule);
    // 10-25 EDT (UTC-4), 11-01 EST (UTC-5 after fall-back), 11-08 EST
    assert.deepEqual(o.map((x) => x.startsAt), [
        '2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-08T14:00:00.000Z',
    ]);
    // 2026-03-08 02:30 does not exist in America/New_York: the occurrence is
    // rejected (not silently shifted an hour earlier), so only that date drops.
    const gap = expandRecurrence({ ...rule, startsOn: '2026-03-01', endsOn: '2026-03-15', startTime: '02:30' });
    assert.equal(gap.length, 2);
    assert.deepEqual(gap.map((x) => x.startsAt), ['2026-03-01T07:30:00.000Z', '2026-03-15T06:30:00.000Z']);
    const overlap = expandRecurrence({ ...rule, startsOn: '2026-11-01', endsOn: '2026-11-01', startTime: '01:30' });
    assert.equal(overlap.length, 1);
    assert.equal(overlap[0].startsAt, '2026-11-01T05:30:00.000Z');
});

test('expandRecurrenceDetailed reports every nonexistent DST-gap date instead of shifting it', () => {
    const detail = expandRecurrenceDetailed({
        kind: 'weekly', weekdays: [0], dayOfMonth: null, startsOn: '2026-03-01', endsOn: '2026-03-22',
        startTime: '02:30', durationMinutes: 60, timezone: 'America/New_York',
    });
    assert.deepEqual(detail.nonexistentDates, ['2026-03-08']);
    assert.deepEqual(detail.occurrences.map((x) => x.startsAt.slice(0, 10)), ['2026-03-01', '2026-03-15', '2026-03-22']);
    // A rule with no gap date reports nothing so a create is never blocked.
    const clean = expandRecurrenceDetailed({
        kind: 'weekly', weekdays: [1], dayOfMonth: null, startsOn: '2026-03-02', endsOn: '2026-03-23',
        startTime: '02:30', durationMinutes: 60, timezone: 'America/New_York',
    });
    assert.deepEqual(clean.nonexistentDates, []);
    assert.equal(clean.occurrences.length, 4);
});

test('expandRecurrence monthly: leap-year clamp, mid-month start and no duplicate instants', () => {
    const o = expandRecurrence({
        kind: 'monthly', weekdays: [], dayOfMonth: 31, startsOn: '2028-01-15', endsOn: '2028-03-31',
        startTime: '08:00', durationMinutes: 30, timezone: 'UTC',
    });
    assert.deepEqual(o.map((x) => x.startsAt), [
        '2028-01-31T08:00:00.000Z', '2028-02-29T08:00:00.000Z', '2028-03-31T08:00:00.000Z',
    ]);
    const mid = expandRecurrence({
        kind: 'monthly', weekdays: [], dayOfMonth: 10, startsOn: '2026-01-15', endsOn: null,
        startTime: '08:00', durationMinutes: 30, timezone: 'UTC',
    }, 3);
    assert.deepEqual(mid.map((x) => x.startsAt.slice(0, 10)), ['2026-02-10', '2026-03-10', '2026-04-10']);
    assert.equal(new Set(mid.map((x) => x.startsAt)).size, mid.length);
});

// --- route: race / failure / authority ---
test('schedules: reschedule with a storable-range violation is 400 with no write', async () => {
    const { router, executed } = buildRouter((sql) => (sessionLoad(sql) ? [sessionRecord] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A,
        body: { starts_at: '9999-12-31 23:30', reason: 'x' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE schedule_sessions')), false);
});

const racingRouter = (affectedRows: number, notifier?: ScheduleNotifier) => {
    const base = makeFakeDataAccess((sql) => (sessionLoad(sql) ? [sessionRecord] : []));
    const executed: { sql: string; params: unknown[] }[] = [];
    const db: SchedulesDataAccess = {
        query: base.query,
        queryOne: base.queryOne,
        execute: async (sql: string, params?: unknown[]) => {
            executed.push({ sql, params: params ?? [] });
            if (sql.includes('UPDATE schedule_sessions')) return { affectedRows };
            return { affectedRows: 1 };
        },
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const router = createSchedulesRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        notifications: notifier,
        now: () => new Date('2026-06-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: SchedulesDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed };
};

test('schedules: a lost version race on cancel/reschedule is 409 with no audit and no notification', async () => {
    const events: ScheduleChangeEvent[] = [];
    const notifier: ScheduleNotifier = { notify: async (event) => { events.push(event); } };
    const { router, executed } = racingRouter(0, notifier);
    const cancel = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: { reason: 'x' } });
    assert.equal(cancel.statusCode, 409);
    const resched = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A, body: { starts_at: '2026-06-02 09:00', reason: 'x' },
    });
    assert.equal(resched.statusCode, 409);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO audit_events')), false);
    assert.equal(events.length, 0);
    const update = executed.find((e) => e.sql.includes('UPDATE schedule_sessions'));
    assert.match(update!.sql, /status='scheduled' AND version=\?/);
    assert.equal(update!.params[update!.params.length - 1], 1);
});

test('schedules: a throwing notifier never undoes or hides a committed cancel', async () => {
    const notifier: ScheduleNotifier = { notify: async () => { throw new Error('hook down'); } };
    const { router, executed } = racingRouter(1, notifier);
    const originalError = console.error;
    console.error = () => undefined;
    try {
        const cancel = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: { reason: 'x' } });
        assert.equal(cancel.statusCode, 200);
    } finally {
        console.error = originalError;
    }
    assert.ok(auditAction(executed, 'schedule.session.cancel'));
});

test('schedules: an audit failure on cancel/reschedule aborts the transaction (500, nothing committed, no notification)', async () => {
    const base = makeFakeDataAccess((sql) => (sessionLoad(sql) ? [sessionRecord] : []));
    const committed: string[] = [];
    const rawExecute = async (sql: string): Promise<{ affectedRows?: number }> => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit storage unavailable');
        return { affectedRows: 1 };
    };
    const db: SchedulesDataAccess = { query: base.query, queryOne: base.queryOne, execute: rawExecute };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const events: ScheduleChangeEvent[] = [];
    const router = createSchedulesRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        notifications: { notify: async (e) => { events.push(e); } },
        now: () => new Date('2026-06-01T00:00:00Z'),
        // buffered transaction: writes count as committed only when the callback resolves
        transaction: async <T>(fn: (tx: SchedulesDataAccess) => Promise<T>) => {
            const pending: string[] = [];
            const result = await fn({
                query: db.query,
                queryOne: db.queryOne,
                execute: async (sql, params) => { pending.push(sql); return rawExecute(sql, params); },
            });
            committed.push(...pending);
            return result;
        },
    });
    const originalError = console.error;
    console.error = () => undefined;
    try {
        const cancel = await invokeRoute(router, { method: 'POST', url: '/sessions/se-1/cancel', token: INSTRUCTOR_A, body: { reason: 'x' } });
        assert.equal(cancel.statusCode, 500);
        const resched = await invokeRoute(router, {
            method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A, body: { starts_at: '2026-06-02 09:00', reason: 'x' },
        });
        assert.equal(resched.statusCode, 500);
    } finally {
        console.error = originalError;
    }
    assert.deepEqual(committed, []);
    assert.equal(events.length, 0);
});

test('schedules: a non-owner without branch binding sees only owned groups or own sessions (no tenant-wide grant)', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const list = executed.find((e) => e.sql.includes('FROM schedule_sessions'));
    assert.ok(list);
    assert.match(list!.sql, /instructor_id = \?/);
    assert.match(list!.sql, /created_by = \?/);
    assert.doesNotMatch(list!.sql, /1=1/);
    assert.equal(list!.params[0], 'tenant-a');
});

test('schedules: an owner is tenant-scoped but sees every session in that tenant', async () => {
    const { router, executed } = buildRouter(() => [], {
        authority: async (_userId: string, tenantId: string) => (tenantId === 'tenant-a' ? { authority: 'owner' } : null),
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const list = executed.find((e) => e.sql.includes('FROM schedule_sessions'));
    assert.match(list!.sql, /tenant_id = \? AND 1=1/);
    assert.deepEqual(list!.params, ['tenant-a']);
});

// ---------------------------------------------------------------------------
// 2026-10-19 exact-assignment boundaries: verified group assignment, not
// tenant/branch membership alone, grants an ordinary instructor sessions.
// ---------------------------------------------------------------------------

/**
 * A non-owner instructor with a live server-verified branch membership
 * (token branch claim re-validated against branch + membership rows on every
 * request). The harness repository answers that branch session lookup.
 */
const BRANCH_BOUND_INSTRUCTOR = tokenFor({
    id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a',
    branch_id: 'br-1', branch_membership_version: 0,
});

const buildBranchBoundRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        {
            instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
            memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] },
        },
    );
    const db = makeFakeDataAccess(responder);
    const router = createSchedulesRouter({
        db,
        authenticate: createAuthenticateToken({
            ...repository,
            findBranchSession: async () => ({
                branch_id: 'br-1', branch_tenant_id: 'tenant-a', branch_status: 'active',
                branch_version: 0, membership_status: 'active', membership_version: 0, membership_role: 'instructor',
            }),
        }),
        loadActiveTenantAuthority: async (_userId: string, tenantId: string) =>
            (tenantId === 'tenant-a' ? { authority: 'instructor' } : null),
        now: () => new Date('2026-06-01T00:00:00Z'),
        transaction: async <T>(fn: (tx: SchedulesDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
};

test('schedules: a verified branch membership alone does not widen a non-owner list beyond assigned groups and own sessions', async () => {
    const { router, executed } = buildBranchBoundRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions', token: BRANCH_BOUND_INSTRUCTOR });
    assert.equal(response.statusCode, 200);
    const list = executed.find((e) => e.sql.includes('FROM schedule_sessions'));
    assert.ok(list);
    // The grant is the live assigned-group subquery plus own creations only.
    assert.match(list!.sql, /group_id IN \(SELECT id FROM `groups` WHERE instructor_id = \?\)/);
    assert.match(list!.sql, /created_by = \?/);
    // Branch membership alone must never be an OR branch of the predicate.
    assert.doesNotMatch(list!.sql, /branch_id = \?/);
    assert.equal(list!.params.includes('br-1'), false);
});

test('schedules: the exact-assignment load for cancel/reschedule carries no branch-membership grant', async () => {
    const { router, executed } = buildBranchBoundRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-foreign/cancel', token: BRANCH_BOUND_INSTRUCTOR, body: { reason: 'x' },
    });
    // A session owned by nobody bound to this instructor is not-found regardless
    // of its branch, so the branch selector cannot confirm or grant it.
    assert.equal(response.statusCode, 404);
    const load = executed.find((e) => sessionLoad(e.sql));
    assert.ok(load);
    assert.doesNotMatch(load!.sql, /branch_id = \?/);
    assert.equal(load!.params.includes('br-1'), false);
});

test('schedules: a cross-branch group selector on the list only narrows, never grants', async () => {
    const { router, executed } = buildBranchBoundRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'GET', url: '/sessions', token: BRANCH_BOUND_INSTRUCTOR,
        query: { group_id: 'grp-other' },
    });
    assert.equal(response.statusCode, 200);
    const list = executed.find((e) => e.sql.includes('FROM schedule_sessions'));
    assert.ok(list);
    // The selector is AND-ed onto the visibility predicate.
    assert.match(list!.sql, /AND group_id = \?/);
    assert.match(list!.sql, /group_id IN \(SELECT id FROM `groups` WHERE instructor_id = \?\)/);
    assert.doesNotMatch(list!.sql, /branch_id = \?/);
    assert.equal(list!.params.includes('grp-other'), true);
});

test('schedules: series create denies a recurrence whose wall time does not exist (DST gap) with 400 and no writes', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/series', token: INSTRUCTOR_A,
        body: {
            title: 'Night class', audience: 'tenant', timezone: 'America/New_York',
            recurrence: 'weekly', weekdays: [0], starts_on: '2026-03-01', ends_on: '2026-03-15',
            start_time: '02:30', duration_minutes: 60,
        },
    });
    assert.equal(response.statusCode, 400);
    assert.match((response.body as { error?: string }).error ?? '', /does not exist/);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO schedule_series')), false);
    assert.equal(executed.some((e) => e.sql.includes('INSERT IGNORE INTO schedule_sessions')), false);
});

const nySessionRecord = { ...sessionRecord, timezone: 'America/New_York' };

test('schedules: reschedule into a nonexistent local time is 400 with no write', async () => {
    const { router, executed } = buildRouter((sql) => (sessionLoad(sql) ? [nySessionRecord] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A,
        body: { starts_at: '2026-03-08 02:30', reason: 'room change' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE schedule_sessions')), false);
});

test('schedules: reschedule to a valid local time across the gap boundary still succeeds (regression)', async () => {
    const { router, executed } = buildRouter((sql) => (sessionLoad(sql) ? [nySessionRecord] : []));
    const response = await invokeRoute(router, {
        method: 'POST', url: '/sessions/se-1/reschedule', token: INSTRUCTOR_A,
        body: { starts_at: '2026-03-08 03:30', reason: 'room change' },
    });
    assert.equal(response.statusCode, 200);
    const update = executed.find((e) => e.sql.includes('UPDATE schedule_sessions'));
    assert.ok(update);
    assert.equal(update!.params[0], '2026-03-08 07:30:00');
    assert.equal(update!.params[1], '2026-03-08 08:30:00');
});

// ---------------------------------------------------------------------------
// 2026-10-20 T3: bounded time filters, deterministic pagination and an
// explicit truncation indicator on every list feed. Previously each feed was
// ORDER BY ... LIMIT n with no time filter and no truncation signal, so rows
// past the cap silently vanished (the student feed dropped every upcoming
// session once 100 earlier ones existed).
// ---------------------------------------------------------------------------

const STUDENT_FEED_CAP = 100;
const STAFF_SESSIONS_CAP = 500;
const SERIES_LIST_CAP = 200;

/** The LIMIT the route asked MySQL for (the fake data access does not apply it). */
const limitOf = (sql: string): number => {
    const match = /LIMIT (\d+)/.exec(sql);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * Reads the from/to bindings the route emitted for a list query. The route
 * appends `from` before `to`, so a single present bound always occupies the
 * first range slot; the SQL text says which bounds are present.
 */
const rangeBounds = (
    sql: string,
    params: unknown[],
    fromFragment: string,
    toFragment: string,
    startIndex: number,
): { from?: string; to?: string } => {
    const hasFrom = sql.includes(fromFragment);
    const hasTo = sql.includes(toFragment);
    return {
        from: hasFrom ? (params[startIndex] as string) : undefined,
        to: hasTo ? (params[startIndex + (hasFrom ? 1 : 0)] as string) : undefined,
    };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** A real calendar date `addDays` after 2026-01-01, formatted for MySQL UTC text. */
const dateFrom2026 = (addDays: number): string => {
    const d = new Date(Date.UTC(2026, 0, 1 + addDays));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/**
 * A pool of scheduled sessions: `pastCount` consecutive days from 2026-01-01
 * (all before the 2026-06 "future" ones), then `futureCount` June 2026 days.
 */
const sessionPool = (pastCount: number, futureCount: number): { id: string; starts_at: string }[] => [
    ...Array.from({ length: pastCount }, (_, i) => ({
        id: `past-${i + 1}`, starts_at: `${dateFrom2026(i)} 09:00:00`,
    })),
    ...Array.from({ length: futureCount }, (_, i) => ({
        id: `future-${i + 1}`, starts_at: `2026-06-${pad2(i + 1)} 09:00:00`,
    })),
];

/**
 * Emulates the MySQL side of a schedule_sessions list query: applies the
 * route's from/to range bindings, the deterministic ORDER BY and the LIMIT,
 * so truncation behaviour is observable without a database. `fromIndex`/
 * `toIndex` are the positions of the range bindings in the route's param list.
 */
const emulateSessionList = (
    pool: { id: string; starts_at: string }[],
    rangeStartIndex: number,
) => (sql: string, params: unknown[]): unknown[] => {
    if (!sql.includes('FROM schedule_sessions')) return [];
    if (sql.includes('WHERE id = ? AND tenant_id = ?')) return [];
    const { from, to } = rangeBounds(sql, params, 'starts_at >= ?', 'starts_at <= ?', rangeStartIndex);
    const filtered = pool.filter((row) =>
        (from === undefined || row.starts_at >= from) && (to === undefined || row.starts_at <= to));
    const sorted = [...filtered].sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
    return sorted.slice(0, limitOf(sql));
};

const buildFeedRouter = (
    pool: { id: string; starts_at: string }[],
    options: HarnessOptions = {},
) => buildRouter((sql, params) => {
    if (sql.includes('FROM students s LEFT JOIN')) {
        return [{ id: 'enr-a', tenant_id: 'tenant-a', group_id: 'grp-1', branch_id: 'br-1', branch_scope: 'branch' }];
    }
    // Student feed params: [tenantId, branchId, groupId, from?, to?].
    return emulateSessionList(pool, 3)(sql, params);
}, options);

test('schedules: the student feed exposes truncation instead of silently dropping every session past the cap', async () => {
    const { router, executed } = buildFeedRouter(sessionPool(120, 3));
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body), 'the student feed is a bare array, exactly its pre-batch shape');
    assert.equal(response.headers?.['x-results-truncated'], 'true', 'the feed must say it is truncated');
    const body = response.body as { id: string }[];
    assert.equal(body.length, STUDENT_FEED_CAP);
    assert.deepEqual(
        body.map((row) => row.id),
        Array.from({ length: STUDENT_FEED_CAP }, (_, i) => `past-${i + 1}`),
        'the page is the earliest cap rows in deterministic order',
    );
    const feed = executed.find((e) => e.sql.includes('FROM schedule_sessions') && e.sql.includes('status='));
    assert.ok(feed);
    assert.match(feed!.sql, /ORDER BY starts_at ASC, id ASC/);
    assert.equal(limitOf(feed!.sql), STUDENT_FEED_CAP + 1, 'one row past the cap is fetched to detect truncation');
});

test('schedules: the student feed keeps full history reachable through explicit from/to ranges', async () => {
    const { router } = buildFeedRouter(sessionPool(120, 3));
    const toPast = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A, query: { to: '2026-02-15 09:00:00' } });
    assert.equal(toPast.statusCode, 200);
    assert.ok(Array.isArray(toPast.body));
    assert.equal(toPast.headers?.['x-results-truncated'], 'false');
    const pastBody = toPast.body as { id: string }[];
    assert.equal(pastBody.length, 46, '31 January days + 15 February days');

    const fromFuture = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A, query: { from: '2026-06-01' } });
    assert.equal(fromFuture.statusCode, 200);
    assert.equal(fromFuture.headers?.['x-results-truncated'], 'false');
    const futureBody = fromFuture.body as { id: string }[];
    assert.deepEqual(futureBody.map((row) => row.id), ['future-1', 'future-2', 'future-3']);

    const window = await invokeRoute(router, {
        method: 'GET', url: '/student', token: STUDENT_A, query: { from: '2026-01-10 09:00:00', to: '2026-01-12 09:00:00' },
    });
    assert.equal(window.statusCode, 200);
    assert.equal(window.headers?.['x-results-truncated'], 'false');
    const windowBody = window.body as { id: string }[];
    assert.deepEqual(windowBody.map((row) => row.id), ['past-10', 'past-11', 'past-12']);
});

test('schedules: the student feed rejects malformed or inverted from/to bounds with 400 and no feed query', async () => {
    for (const query of [
        { from: 'not-a-date' },
        { from: '2026-13-40' },
        { to: '2026-02-30' },
        { from: '2026-06-01', to: '2026-01-01' },
    ]) {
        const { router, executed } = buildFeedRouter(sessionPool(1, 1));
        const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A, query });
        assert.equal(response.statusCode, 400);
        assert.match((response.body as { error?: string }).error ?? '', /^(from|to) must/);
        assert.equal(
            executed.some((e) => e.sql.includes('FROM schedule_sessions')),
            false,
            'no feed query is issued for a rejected range',
        );
    }
});

test('schedules: the student feed orders identical starts_at deterministically by id', async () => {
    const pool = [
        { id: 'se-b', starts_at: '2026-03-01 09:00:00' },
        { id: 'se-a', starts_at: '2026-03-01 09:00:00' },
        { id: 'se-c', starts_at: '2026-02-01 09:00:00' },
    ];
    const { router, executed } = buildFeedRouter(pool);
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body));
    assert.equal(response.headers?.['x-results-truncated'], 'false');
    assert.deepEqual((response.body as { id: string }[]).map((row) => row.id), ['se-c', 'se-a', 'se-b']);
    const feed = executed.find((e) => e.sql.includes('FROM schedule_sessions') && e.sql.includes('status='));
    assert.match(feed!.sql, /ORDER BY starts_at ASC, id ASC/);
});

const buildStaffSessionsRouter = (pool: { id: string; starts_at: string }[]) => buildRouter(
    (sql, params) => emulateSessionList(pool, 1)(sql, params),
    { authority: async (_userId: string, tenantId: string) => (tenantId === 'tenant-a' ? { authority: 'owner' } : null) },
);

test('schedules: the staff session list exposes truncation and pages with from/to', async () => {
    const { router, executed } = buildStaffSessionsRouter(sessionPool(505, 0));
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body), 'the staff session list is a bare array, exactly its pre-batch shape');
    assert.equal(response.headers?.['x-results-truncated'], 'true');
    const body = response.body as { id: string }[];
    assert.equal(body.length, STAFF_SESSIONS_CAP);
    assert.equal(body[0]?.id, 'past-1');
    const list = executed.find((e) => e.sql.includes('FROM schedule_sessions'));
    assert.ok(list);
    assert.match(list!.sql, /ORDER BY starts_at ASC, id ASC/);
    assert.equal(limitOf(list!.sql), STAFF_SESSIONS_CAP + 1);

    const paged = await invokeRoute(router, {
        method: 'GET', url: '/sessions', token: INSTRUCTOR_A,
        query: { from: dateFrom2026(499), to: `${dateFrom2026(504)} 09:00:00` },
    });
    assert.equal(paged.statusCode, 200);
    assert.ok(Array.isArray(paged.body));
    assert.equal(paged.headers?.['x-results-truncated'], 'false');
    const pagedBody = paged.body as { id: string }[];
    assert.deepEqual(pagedBody.map((row) => row.id), ['past-500', 'past-501', 'past-502', 'past-503', 'past-504', 'past-505']);
    const pagedList = executed.filter((e) => e.sql.includes('FROM schedule_sessions')).pop();
    assert.ok(pagedList);
    assert.match(pagedList!.sql, /starts_at >= \?/);
    assert.match(pagedList!.sql, /starts_at <= \?/);
    assert.equal(pagedList!.params[1], `${dateFrom2026(499)} 00:00:00`, 'the date-only bound is normalized to a UTC literal');
    assert.equal(pagedList!.params[2], `${dateFrom2026(504)} 09:00:00`);
});

test('schedules: the staff session list rejects a malformed from bound with 400 and no list query', async () => {
    const { router, executed } = buildStaffSessionsRouter(sessionPool(1, 0));
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions', token: INSTRUCTOR_A, query: { from: 'yesterday' } });
    assert.equal(response.statusCode, 400);
    assert.match((response.body as { error?: string }).error ?? '', /^from must/);
    assert.equal(executed.some((e) => e.sql.includes('FROM schedule_sessions')), false);
});

const seriesPool = (count: number): { id: string; starts_on: string }[] =>
    Array.from({ length: count }, (_, i) => ({
        id: `ser-${String(i + 1).padStart(3, '0')}`,
        starts_on: `2026-01-${pad2((i % 28) + 1)}`,
    }));

const emulateSeriesList = (pool: { id: string; starts_on: string }[]) => (sql: string, params: unknown[]): unknown[] => {
    if (!sql.includes('FROM schedule_series')) return [];
    // Owner series-list params: [tenantId, from?, to?].
    const { from, to } = rangeBounds(sql, params, 'starts_on >= ?', 'starts_on <= ?', 1);
    const filtered = pool.filter((row) =>
        (from === undefined || row.starts_on >= from.slice(0, 10)) && (to === undefined || row.starts_on <= to.slice(0, 10)));
    const sorted = [...filtered].sort((a, b) => b.starts_on.localeCompare(a.starts_on) || b.id.localeCompare(a.id));
    return sorted.slice(0, limitOf(sql));
};

const buildSeriesRouter = (pool: { id: string; starts_on: string }[]) => buildRouter((sql, params) => emulateSeriesList(pool)(sql, params), {
    authority: async (_userId: string, tenantId: string) => (tenantId === 'tenant-a' ? { authority: 'owner' } : null),
});

test('schedules: the series list exposes truncation and filters by a starts_on range', async () => {
    const { router, executed } = buildSeriesRouter(seriesPool(205));
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body), 'the series list is a bare array, exactly its pre-batch shape');
    assert.equal(response.headers?.['x-results-truncated'], 'true');
    const body = response.body as { id: string }[];
    assert.equal(body.length, SERIES_LIST_CAP);
    const list = executed.find((e) => e.sql.includes('FROM schedule_series'));
    assert.ok(list);
    assert.match(list!.sql, /ORDER BY starts_on DESC, id DESC/);
    assert.equal(limitOf(list!.sql), SERIES_LIST_CAP + 1);

    const ranged = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A, query: { from: '2026-01-10', to: '2026-01-19' } });
    assert.equal(ranged.statusCode, 200);
    assert.ok(Array.isArray(ranged.body));
    assert.equal(ranged.headers?.['x-results-truncated'], 'false');
    const rangedBody = ranged.body as { id: string }[];
    assert.equal(rangedBody.length, 70, 'series starting on days 10..19, seven per day');
    const rangedList = executed.filter((e) => e.sql.includes('FROM schedule_series')).pop();
    assert.match(rangedList!.sql, /starts_on >= \?/);
    assert.match(rangedList!.sql, /starts_on <= \?/);
    assert.equal(rangedList!.params[1], '2026-01-10 00:00:00');
    assert.equal(rangedList!.params[2], '2026-01-19 00:00:00');
});

test('schedules: the series list rejects an inverted range with 400 and no list query', async () => {
    const { router, executed } = buildSeriesRouter(seriesPool(1));
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A, query: { from: '2026-02-01', to: '2026-01-01' } });
    assert.equal(response.statusCode, 400);
    assert.match((response.body as { error?: string }).error ?? '', /from must not be after to/);
    assert.equal(executed.some((e) => e.sql.includes('FROM schedule_series')), false);
});

// ---------------------------------------------------------------------------
// 2026-10-20 T3c compatibility correction: the first T3 pass raised the
// top-level response shape of the three bare-array lists (student feed, staff
// sessions, series) into envelopes and the truncation metadata must move out
// of the body into the single X-Results-Truncated response header. Every list
// returns exactly its pre-batch shape: a shallow subversion of the array into
// an envelope, or any extra top-level key, must fail these assertions.
// ---------------------------------------------------------------------------

test('schedules: the student feed keeps its pre-batch bare-array shape and exposes truncation only in the header', async () => {
    const { router, executed } = buildFeedRouter(sessionPool(2, 0));
    const response = await invokeRoute(router, { method: 'GET', url: '/student', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body), 'the pre-batch student feed was a bare array');
    assert.deepEqual(
        (response.body as { id: string }[]).map((row) => row.id),
        ['past-1', 'past-2'],
    );
    assert.equal(response.headers?.['x-results-truncated'], 'false', 'the header is always set, true or false');
    const feed = executed.find((e) => e.sql.includes('FROM schedule_sessions') && e.sql.includes('status='));
    assert.ok(feed);
    assert.equal(limitOf(feed!.sql), STUDENT_FEED_CAP + 1, 'the cap+1 bounds fix is retained');
});

test('schedules: the staff session list keeps its pre-batch bare-array shape and exposes truncation only in the header', async () => {
    const { router, executed } = buildStaffSessionsRouter(sessionPool(2, 0));
    const response = await invokeRoute(router, { method: 'GET', url: '/sessions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body), 'the pre-batch staff session list was a bare array');
    assert.deepEqual(
        (response.body as { id: string }[]).map((row) => row.id),
        ['past-1', 'past-2'],
    );
    assert.equal(response.headers?.['x-results-truncated'], 'false', 'the header is always set, true or false');
    const list = executed.find((e) => e.sql.includes('FROM schedule_sessions'));
    assert.ok(list);
    assert.equal(limitOf(list!.sql), STAFF_SESSIONS_CAP + 1, 'the cap+1 bounds fix is retained');
});

test('schedules: the series list keeps its pre-batch bare-array shape and exposes truncation only in the header', async () => {
    const { router, executed } = buildSeriesRouter(seriesPool(2));
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body), 'the pre-batch series list was a bare array');
    assert.deepEqual(
        (response.body as { id: string }[]).map((row) => row.id),
        ['ser-002', 'ser-001'],
        'series ordering stays starts_on DESC, id DESC',
    );
    assert.equal(response.headers?.['x-results-truncated'], 'false', 'the header is always set, true or false');
    const list = executed.find((e) => e.sql.includes('FROM schedule_series'));
    assert.ok(list);
    assert.equal(limitOf(list!.sql), SERIES_LIST_CAP + 1, 'the cap+1 bounds fix is retained');
});
