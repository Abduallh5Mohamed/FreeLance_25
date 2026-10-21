import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildTenantCountTimelines,
    countUniqueUsersAt,
    type ActivationEvent,
    type TenantCountTimeline,
} from '../src/services/billing-basis';

const CYCLE = 2_592_000;

function event(tenantId: string, userId: string, teacherId: string, start: number, end: number): ActivationEvent {
    return { tenantId, userId, teacherId, start, end };
}

function timelines(input: unknown): readonly TenantCountTimeline[] {
    const result = buildTenantCountTimelines(input);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

function countAt(timeline: TenantCountTimeline, at: number): number {
    const result = countUniqueUsersAt(timeline, at);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    return result.value;
}

test('empty event stream produces no timelines', () => {
    assert.deepEqual(timelines([]), []);
});

test('200 students with 3 teachers each count once inside one center', () => {
    const events: ActivationEvent[] = [];
    for (let student = 0; student < 200; student += 1) {
        for (let teacher = 0; teacher < 3; teacher += 1) {
            events.push(event('center-a', `student-${student}`, `teacher-${teacher}`, 0, CYCLE));
        }
    }

    const result = timelines(events);
    assert.equal(result.length, 1);
    const timeline = result[0];
    assert.equal(timeline.tenantId, 'center-a');
    assert.deepEqual(timeline.changePoints, [
        { at: 0, count: 200 },
        { at: CYCLE, count: 0 },
    ]);
    assert.equal(countAt(timeline, 0), 200);
    assert.equal(countAt(timeline, CYCLE - 1), 200);
    assert.equal(countAt(timeline, CYCLE), 0);
});

test('overlapping intervals of the same user never double count', () => {
    const result = timelines([
        event('tenant-a', 'user-a', 'teacher-1', 0, 10),
        event('tenant-a', 'user-a', 'teacher-2', 5, 15),
        event('tenant-a', 'user-a', 'teacher-3', 20, 30),
    ]);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].changePoints, [
        { at: 0, count: 1 },
        { at: 15, count: 0 },
        { at: 20, count: 1 },
        { at: 30, count: 0 },
    ]);
});

test('adjacent intervals [a,b) + [b,c) are continuous', () => {
    const result = timelines([
        event('tenant-a', 'user-a', 'teacher-1', 0, 10),
        event('tenant-a', 'user-a', 'teacher-2', 10, 20),
    ]);

    assert.deepEqual(result[0].changePoints, [
        { at: 0, count: 1 },
        { at: 20, count: 0 },
    ]);
    assert.equal(countAt(result[0], 10), 1);
    assert.equal(countAt(result[0], 19), 1);
    assert.equal(countAt(result[0], 20), 0);
});

test('one teacher relation expiring does not drop a user with another active relation', () => {
    const result = timelines([
        event('tenant-a', 'user-a', 'teacher-1', 0, 100),
        event('tenant-a', 'user-a', 'teacher-2', 0, 50),
        event('tenant-a', 'user-a', 'teacher-3', 0, 50),
    ]);

    assert.deepEqual(result[0].changePoints, [
        { at: 0, count: 1 },
        { at: 100, count: 0 },
    ]);
    assert.equal(countAt(result[0], 50), 1);
    assert.equal(countAt(result[0], 99), 1);
});

test('the same user in different tenants is counted once per tenant, never deduplicated across tenants', () => {
    const result = timelines([
        event('tenant-a', 'shared-user', 'teacher-a', 0, 10),
        event('tenant-b', 'shared-user', 'teacher-b', 0, 10),
    ]);

    assert.deepEqual(result.map((timeline) => timeline.tenantId), ['tenant-a', 'tenant-b']);
    for (const timeline of result) {
        assert.deepEqual(timeline.changePoints, [
            { at: 0, count: 1 },
            { at: 10, count: 0 },
        ]);
    }
});

test('unsorted events are normalized into sorted change points', () => {
    const result = timelines([
        event('tenant-a', 'user-a', 'teacher-1', 10, 20),
        event('tenant-a', 'user-b', 'teacher-2', 0, 5),
        event('tenant-a', 'user-a', 'teacher-3', 0, 3),
    ]);

    assert.deepEqual(result[0].changePoints, [
        { at: 0, count: 2 },
        { at: 3, count: 1 },
        { at: 5, count: 0 },
        { at: 10, count: 1 },
        { at: 20, count: 0 },
    ]);
});

test('an end and a start at the same instant do not create a spurious change point', () => {
    const result = timelines([
        event('tenant-a', 'user-a', 'teacher-1', 0, 10),
        event('tenant-a', 'user-b', 'teacher-2', 10, 20),
    ]);

    assert.deepEqual(result[0].changePoints, [
        { at: 0, count: 1 },
        { at: 20, count: 0 },
    ]);
});

test('invalid event streams are rejected with typed errors', () => {
    const cases: Array<{ input: unknown; code: string; eventIndex?: number }> = [
        { input: null, code: 'invalid_events' },
        { input: {}, code: 'invalid_events' },
        { input: [null], code: 'invalid_events', eventIndex: 0 },
        { input: [event('', 'user-a', 'teacher-1', 0, 10)], code: 'invalid_identifier', eventIndex: 0 },
        { input: [event('tenant-a', ' user-a', 'teacher-1', 0, 10)], code: 'invalid_identifier', eventIndex: 0 },
        { input: [event('tenant-a', 'user-a', '', 0, 10)], code: 'invalid_identifier', eventIndex: 0 },
        { input: [{ tenantId: 'tenant-a', userId: 'user-a', teacherId: 'teacher-1', start: -1, end: 10 }], code: 'invalid_instant', eventIndex: 0 },
        { input: [{ tenantId: 'tenant-a', userId: 'user-a', teacherId: 'teacher-1', start: 1.5, end: 10 }], code: 'invalid_instant', eventIndex: 0 },
        { input: [{ tenantId: 'tenant-a', userId: 'user-a', teacherId: 'teacher-1', start: 0, end: Number.NaN }], code: 'invalid_instant', eventIndex: 0 },
        { input: [event('tenant-a', 'user-a', 'teacher-1', 10, 10)], code: 'invalid_interval', eventIndex: 0 },
        { input: [event('tenant-a', 'user-a', 'teacher-1', 10, 5)], code: 'invalid_interval', eventIndex: 0 },
    ];

    for (const testCase of cases) {
        const result = buildTenantCountTimelines(testCase.input);
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error.code, testCase.code);
            if (testCase.eventIndex !== undefined) assert.equal(result.error.eventIndex, testCase.eventIndex);
        }
    }
});

test('countUniqueUsersAt validates its instant and uses half-open boundaries', () => {
    const timeline = timelines([event('tenant-a', 'user-a', 'teacher-1', 10, 20)])[0];

    assert.equal(countAt(timeline, 9), 0);
    assert.equal(countAt(timeline, 10), 1);
    assert.equal(countAt(timeline, 19), 1);
    assert.equal(countAt(timeline, 20), 0);

    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, '10']) {
        const result = countUniqueUsersAt(timeline, invalid);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'invalid_instant');
    }
});
