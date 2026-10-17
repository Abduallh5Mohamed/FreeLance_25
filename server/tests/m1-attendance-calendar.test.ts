/**
 * M1 attendance business-day calendar — Africa/Cairo (hermetic).
 *
 * Runner: node:test via tsx (`npx tsx --test tests/m1-attendance-calendar.test.ts`).
 * No MySQL, no external network, no .env file, no Docker, no live app boot.
 *
 * Scope of production code exercised:
 *  - the shared attendance business-day helper `server/src/lib/attendance-calendar.ts`
 *    (day-key validation, instant->Cairo-day conversion, default day, schedule
 *    arithmetic) — the backend mirror of `src/lib/attendance-calendar.ts`;
 *  - the REAL attendance router (`createAttendanceRouter`) over an in-memory
 *    data-access adapter and the REAL authentication middleware over an
 *    in-memory PrincipalRepository fixture, with an injected clock, so the
 *    actual route normalization/default-day decisions run end to end.
 *
 * The contract (supervisor/026): Africa/Cairo is the authoritative attendance
 * business timezone for defaults, instant-to-day conversion and
 * scheduled-weekday/previous-day decisions. Explicit YYYY-MM-DD keys are
 * calendar days: preserved unchanged, impossible days rejected. Billing
 * fields (payment_date/payment_month/year) are deliberately untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createAttendanceRouter } from '../src/routes/attendance';
import {
    instantToDayKey,
    isScheduledOnDayKey,
    isValidDayKey,
    normalizeAttendanceDay,
    parseScheduleWeekdays,
    previousScheduledDayKey,
    todayDayKey,
    weekdayOfDayKey,
} from '../src/lib/attendance-calendar';

process.env.JWT_SECRET ??= 'hermetic-cairo-attendance-test-jwt-secret-not-a-real-key';
const TEST_JWT_SECRET = process.env.JWT_SECRET!;

// ---------------------------------------------------------------------------
// In-memory fixture state
// ---------------------------------------------------------------------------

interface AttendanceRow {
    id: string;
    student_id: string;
    attendance_date: string;
    status: string;
}

interface State {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    memberships: Record<string, { tenant_id: string }[]>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    attendance: AttendanceRow[];
    executed: { sql: string; params: unknown[] }[];
}

const makeState = (): State => ({
    users: { 'instr-1': { is_active: 1, token_version: 0, suspension_active: 0 } },
    memberships: { 'instr-1': [{ tenant_id: 'tenant-a' }] },
    instructorAccounts: { 'instr-1': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
    attendance: [],
    executed: [],
});

let state: State = makeState();

// ---------------------------------------------------------------------------
// In-memory data-access adapter mirroring the emitted SQL
// ---------------------------------------------------------------------------

const runSelect = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    state.executed.push({ sql, params });
    const q = sql.replace(/\s+/g, ' ');

    if (q.includes('SELECT sc.id FROM students sc WHERE sc.id = ?')) {
        // The single fixture student belongs to the fixture instructor.
        return params[0] === 's-1' ? [{ id: 's-1' }] : [];
    }
    if (q.includes('SELECT id, group_id FROM students WHERE id = ?')) {
        return params[0] === 's-1' ? [{ id: 's-1', group_id: 'g-1' }] : [];
    }
    if (q.includes('SELECT id FROM attendance WHERE student_id = ?')) {
        // params: [student_id, day]
        const [studentId, day] = params;
        return state.attendance.filter((a) => a.student_id === studentId && a.attendance_date === day);
    }
    if (q.includes('FROM attendance a') && q.includes('s.name as student_name')) {
        const row = state.attendance[state.attendance.length - 1];
        return row ? [{ ...row, student_name: 'Own Student', student_barcode: 'BC-1' }] : [];
    }
    return [];
};

const runWrite = (sql: string, params: unknown[]): { affectedRows: number } => {
    state.executed.push({ sql, params });
    if (sql.includes('INSERT INTO attendance')) {
        // params: [student_id, course_id, group_id, attendance_date, status, notes]
        const [studentId, , groupId, day, status] = params as [string, null, string, string, string];
        state.attendance.push({
            id: `a-${state.attendance.length + 1}`,
            student_id: studentId,
            attendance_date: day,
            status,
        });
        return { affectedRows: 1 };
    }
    return { affectedRows: 1 };
};

const fakeDb = {
    query: async <T>(sql: string, params?: unknown[]) => runSelect(sql, params ?? []) as T[],
    queryOne: async <T>(sql: string, params?: unknown[]) => {
        const rows = runSelect(sql, params ?? []);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    },
    execute: async (sql: string, params?: unknown[]) => runWrite(sql, params ?? []),
};

const principalRepo: PrincipalRepository = {
    findUsersIdentity: async (id) => state.users[id] ?? null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id) => state.instructorAccounts[id] ?? null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async (id) => state.memberships[id] ?? [],
};

const authenticate = createAuthenticateToken(principalRepo);
const optionalAuthenticate = createOptionalAuth(principalRepo);

const buildApp = (now: () => Date): express.Express => {
    const app = express();
    app.use(express.json());
    app.use(
        '/api/attendance',
        createAttendanceRouter({
            db: fakeDb as never,
            authenticate,
            optionalAuthenticate,
            notify: { sendWhatsAppMessage: async () => ({ success: true }) },
            hasVerifiedPlatformCapability: async () => false,
            now,
        }),
    );
    return app;
};

interface Harness {
    base: string;
    close: () => Promise<void>;
}

const harness = async (now: () => Date): Promise<Harness> => {
    const server: Server = createServer(buildApp(now));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections?.();
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
};

const api = async (
    h: Harness,
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${h.base}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sign = (user: { id: string; role: string; tenantId?: string }) =>
    jwt.sign({ id: user.id, role: user.role, tv: 0, tenant_id: user.tenantId ?? null }, TEST_JWT_SECRET);

const INSTRUCTOR = { id: 'instr-1', role: 'instructor', tenantId: 'tenant-a' };

const withClock = async (now: Date, fn: (h: Harness) => Promise<void>): Promise<void> => {
    state = makeState();
    const h = await harness(() => now);
    try {
        await fn(h);
    } finally {
        await h.close();
    }
};

// ---------------------------------------------------------------------------
// Shared helper unit tests
// ---------------------------------------------------------------------------

test('day keys validate as real calendar dates (no rollover)', () => {
    assert.equal(isValidDayKey('2026-10-16'), true);
    assert.equal(isValidDayKey('2028-02-29'), true, 'leap day is valid in a leap year');
    assert.equal(isValidDayKey('2026-02-29'), false, 'non-leap February 29 is rejected');
    assert.equal(isValidDayKey('2026-02-30'), false, 'impossible day is rejected, not rolled over');
    assert.equal(isValidDayKey('2026-13-01'), false);
    assert.equal(isValidDayKey('2026-1-1'), false, 'shape must be strict YYYY-MM-DD');
    assert.equal(isValidDayKey('not-a-day'), false);
    assert.equal(isValidDayKey(null), false);
});

test('instants convert to the Africa/Cairo calendar day they denote', () => {
    // Cairo summer (EEST, UTC+3): 21:30Z is already the next Cairo day.
    assert.equal(instantToDayKey('2026-10-16T21:30:00Z'), '2026-10-17');
    // Cairo winter (EET, UTC+2): 21:30Z is still 23:30 the same Cairo day.
    assert.equal(instantToDayKey('2026-11-16T21:30:00Z'), '2026-11-16');
    // DST-aware: Egypt 2026 DST starts 2026-04-24 00:00 Cairo (UTC+2 -> UTC+3).
    assert.equal(instantToDayKey('2026-04-23T21:30:00Z'), '2026-04-23');
    assert.equal(instantToDayKey('2026-04-24T21:30:00Z'), '2026-04-25');
    assert.equal(instantToDayKey(new Date('2026-10-16T21:30:00Z')), '2026-10-17');
    assert.equal(instantToDayKey('garbage'), null);
});

test('the default day is the current Africa/Cairo day, from the injected clock', () => {
    assert.equal(todayDayKey(new Date('2026-10-16T21:30:00Z')), '2026-10-17');
    assert.equal(todayDayKey(new Date('2026-11-16T21:30:00Z')), '2026-11-16');
});

test('normalizeAttendanceDay preserves explicit keys and converts instants', () => {
    assert.equal(normalizeAttendanceDay('2026-10-16'), '2026-10-16', 'explicit key preserved unchanged');
    assert.equal(normalizeAttendanceDay('2026-02-30'), null, 'impossible key rejected');
    assert.equal(normalizeAttendanceDay('2026-10-16T21:30:00Z'), '2026-10-17');
    assert.equal(normalizeAttendanceDay(new Date('2026-10-16T21:30:00Z')), '2026-10-17');
    assert.equal(normalizeAttendanceDay(undefined), null);
    assert.equal(normalizeAttendanceDay(null), null);
    assert.equal(normalizeAttendanceDay(''), null);
});

test('schedule arithmetic is pure calendar weekday math', () => {
    assert.deepEqual(parseScheduleWeekdays('["mon","WED","bogus"]'), [1, 3]);
    assert.deepEqual(parseScheduleWeekdays('not-json'), []);
    assert.deepEqual(parseScheduleWeekdays(null), []);
    assert.equal(weekdayOfDayKey('2026-10-16'), 5, '2026-10-16 is a Friday');
    assert.equal(isScheduledOnDayKey('2026-10-16', [5]), true);
    assert.equal(isScheduledOnDayKey('2026-10-16', [1, 3]), false);
    // Mon/Wed before Friday 2026-10-16 is Wednesday 2026-10-14.
    assert.equal(previousScheduledDayKey('2026-10-16', [1, 3]), '2026-10-14');
    // Friday-only schedule: the previous session is one week earlier.
    assert.equal(previousScheduledDayKey('2026-10-16', [5]), '2026-10-09');
    assert.equal(previousScheduledDayKey('2026-10-16', []), null);
    assert.equal(previousScheduledDayKey('2026-02-30', [1]), null, 'invalid reference rejected');
});

test('029: parseScheduleWeekdays never throws on valid JSON that is not an array', () => {
    for (const value of ['null', '{}', '42', '"sun"']) {
        assert.deepEqual(parseScheduleWeekdays(value), [], `JSON ${value} must be an empty schedule`);
    }
});

test('029: impossible instant dates are rejected, never rolled over', () => {
    assert.equal(normalizeAttendanceDay('2026-02-30T00:00:00Z'), null, 'impossible day rolled over before the fix');
    assert.equal(normalizeAttendanceDay('2026-13-01T00:00:00Z'), null, 'impossible month rejected');
    assert.equal(normalizeAttendanceDay('2026-02-29T00:00:00Z'), null, 'non-leap February 29 rejected');
    assert.equal(normalizeAttendanceDay('2026-10-16T25:00:00Z'), null, 'impossible hour rejected');
    assert.equal(normalizeAttendanceDay('2028-02-29T12:00:00Z'), '2028-02-29', 'valid leap-day instant still converts');
});

test('029: instant strings must carry an explicit timezone/offset', () => {
    // Offsetless datetimes parse host-locally — rejected rather than silently
    // producing a host-dependent day.
    assert.equal(instantToDayKey('2026-10-16T21:30:00'), null, 'offsetless datetime rejected');
    assert.equal(instantToDayKey('2026-10-16T21:30'), null, 'offsetless datetime rejected');
    assert.equal(normalizeAttendanceDay('2026-10-16T21:30:00'), null);
    assert.equal(instantToDayKey('2026-10-16 21:30:00'), null, 'MySQL-style offsetless datetime rejected');
    // Explicit offsets are honored: 21:30Z is already the next Cairo summer
    // day, while +02:00 keeps the same day in winter.
    assert.equal(instantToDayKey('2026-10-16T21:30:00.500Z'), '2026-10-17', 'fractional seconds accepted');
    assert.equal(instantToDayKey('2026-11-16T21:30:00+02:00'), '2026-11-16', 'explicit +02:00 honored in winter');
    assert.equal(instantToDayKey('2026-04-23T22:30:00+02:00'), '2026-04-23', 'pre-DST explicit +02:00 keeps 2026-04-23');
    assert.equal(instantToDayKey('2026-04-24T00:30:00+02:00'), '2026-04-24', 'wall time just past midnight with the pre-switch offset lands in the post-switch Cairo day');
});

test('029: day keys remain usable instants and impossible keys are rejected', () => {
    assert.equal(instantToDayKey('2026-10-16'), '2026-10-16', 'day key is a deterministic UTC-midnight instant');
    assert.equal(instantToDayKey('2026-02-30'), null, 'impossible day key rejected');
});

// ---------------------------------------------------------------------------
// Route-level tests with an injected clock (real production router)
// ---------------------------------------------------------------------------

test('an absent attendance_date defaults to the Cairo business day of the injected clock', async () => {
    // 21:30Z on 2026-10-16 is already 2026-10-17 in Cairo (UTC+3) while the
    // UTC day is still 2026-10-16 — the old UTC default recorded the wrong
    // day for every operator at this hour.
    await withClock(new Date('2026-10-16T21:30:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), { student_id: 's-1' });
        assert.equal(res.status, 201);
        const insert = state.executed.find((e) => e.sql.includes('INSERT INTO attendance'))!;
        assert.equal(insert.params[3], '2026-10-17');
    });
    // Winter offset (UTC+2): 21:30Z is still the same Cairo day.
    await withClock(new Date('2026-11-16T21:30:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), { student_id: 's-1' });
        assert.equal(res.status, 201);
        const insert = state.executed.find((e) => e.sql.includes('INSERT INTO attendance'))!;
        assert.equal(insert.params[3], '2026-11-16');
    });
});

test('an explicit YYYY-MM-DD key is preserved unchanged, even near Cairo midnight', async () => {
    await withClock(new Date('2026-10-17T21:30:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), {
            student_id: 's-1',
            attendance_date: '2026-10-16',
        });
        assert.equal(res.status, 201);
        const insert = state.executed.find((e) => e.sql.includes('INSERT INTO attendance'))!;
        assert.equal(insert.params[3], '2026-10-16');
    });
});

test('an impossible explicit day key is rejected with 400 and writes nothing', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), {
            student_id: 's-1',
            attendance_date: '2026-02-30',
        });
        assert.equal(res.status, 400);
        assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
    });
});

test('a datetime input records the Cairo day it denotes', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), {
            student_id: 's-1',
            attendance_date: '2026-10-16T21:30:00Z',
        });
        assert.equal(res.status, 201);
        const insert = state.executed.find((e) => e.sql.includes('INSERT INTO attendance'))!;
        assert.equal(insert.params[3], '2026-10-17');
    });
});

test('the duplicate guard compares Cairo days, so a same-Cairo-day mark is a 409', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        // A row already exists on the Cairo day 2026-10-17.
        state.attendance.push({ id: 'a-existing', student_id: 's-1', attendance_date: '2026-10-17', status: 'present' });
        // The instant 2026-10-16T21:30Z denotes Cairo day 2026-10-17, so this
        // must be detected as the same day. Under the old UTC normalization
        // it would have been recorded as 2026-10-16 and silently inserted.
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), {
            student_id: 's-1',
            attendance_date: '2026-10-16T21:30:00Z',
        });
        assert.equal(res.status, 409);
        assert.equal(state.attendance.length, 1, 'no second row for the same Cairo day');
    });
});

test('a date filter normalizes an instant to its Cairo day before querying', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        await api(h, 'GET', '/api/attendance?date=2026-10-16T21:30:00Z', sign(INSTRUCTOR));
        const select = state.executed.find((e) => e.sql.includes('DATE(a.attendance_date) = ?'))!;
        assert.equal(select.params[0], '2026-10-17');
    });
});

test('an invalid date filter is a 400, never a driver error', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        assert.equal((await api(h, 'GET', '/api/attendance?date=2026-02-30', sign(INSTRUCTOR))).status, 400);
    });
});

test('029: an impossible datetime input is a 400 and writes nothing', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), {
            student_id: 's-1',
            attendance_date: '2026-02-30T00:00:00Z',
        });
        assert.equal(res.status, 400, 'an impossible datetime date component is rejected, never rolled over');
        assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
    });
});

test('029: an offsetless datetime input is a 400, never host-dependent', async () => {
    await withClock(new Date('2026-10-16T12:00:00Z'), async (h) => {
        const res = await api(h, 'POST', '/api/attendance', sign(INSTRUCTOR), {
            student_id: 's-1',
            attendance_date: '2026-10-16T21:30:00',
        });
        assert.equal(res.status, 400, 'an offsetless datetime is rejected instead of parsing host-locally');
        assert.equal(state.executed.some((e) => e.sql.includes('INSERT INTO attendance')), false);
    });
});
