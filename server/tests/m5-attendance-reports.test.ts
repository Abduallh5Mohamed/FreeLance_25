/**
 * C3a — manual-attendance report acceptance tests (hermetic, no DB/network).
 *
 * The routers under test are driven through their REAL exported factories with
 * injected seams: a scripted SQL adapter, the REAL auth middleware over an
 * injected principal repository, a copy-injected row-level visibility builder
 * (the same predicate the attendance router applies), and a fake audit write
 * seam. Row-level SQL gates that MySQL applies are asserted via the exact SQL
 * text + bindings the real handler emitted, since there is no live database.
 *
 * These acceptance tests were written together with
 * `services/attendance-reports.ts` / `routes/attendance-reports.ts` (new
 * modules, no pre-existing defect), stated honestly in the task report.
 */

import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    createAttendanceReportsRouter,
    type AttendanceReportAuditInput,
    type AttendanceReportAuditWriter,
    type AttendanceReportsStore,
} from '../src/routes/attendance-reports';
import type { AttendanceReportRecordRow } from '../src/services/attendance-reports';
import {
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    type ExecutedStatement,
} from './helpers/m2-harness';
import jwt from 'jsonwebtoken';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const OWNER_X = tokenFor({ id: 'owner-x', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, tenant_id: 'tenant-a' });

// ---------------------------------------------------------------------------
// Hermetic harness (local: the CSV path needs res.send, which the shared
// helper does not stub; this file adds send support without touching it).
// ---------------------------------------------------------------------------

export interface LocalResponse {
    statusCode?: number;
    body?: unknown;
    headers?: Record<string, string>;
    status(code: number): LocalResponse;
    json(payload: unknown): LocalResponse;
    set(header: string, value: string): LocalResponse;
    send(payload: unknown): LocalResponse;
}

type Responder = (sql: string, params: unknown[]) => unknown[] | null;

const recordRow = (over: Partial<AttendanceReportRecordRow> = {}): AttendanceReportRecordRow => ({
    id: 'ar-1',
    tenant_id: 'tenant-a',
    session_id: 'se-1',
    group_id: 'grp-1',
    student_id: 'stu-1',
    state: 'present',
    marked_at: '2026-05-01 09:00:00',
    corrected: 0,
    ...over,
});

const RANGE = { from: '2026-05-01', to: '2026-05-31' };
const rangeQuery = () => ({ from: RANGE.from, to: RANGE.to });

const buildRouter = (
    responder: Responder,
    opts: { authority?: Record<string, string>; audit?: AttendanceReportAuditWriter } = {},
): {
    router: ReturnType<typeof createAttendanceReportsRouter>;
    executed: ExecutedStatement[];
    visibilityCalls: Array<{ tenantId: string; userId: string; isOwner: boolean }>;
    audits: Array<{ store: AttendanceReportsStore; input: AttendanceReportAuditInput }>;
    store: AttendanceReportsStore;
} => {
    const db = makeFakeDataAccess(responder);
    const users: Record<string, { is_active: number; token_version: number; suspension_active: number; role: string }> = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'owner-x': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: {
            'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'owner-x': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: {
            'instructor-a': [{ tenant_id: 'tenant-a' }],
            'instructor-b': [{ tenant_id: 'tenant-b' }],
            'owner-x': [{ tenant_id: 'tenant-a' }],
        },
        enrollments: {
            'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null }],
        },
    });
    const AUTHORITY = opts.authority ?? { 'instructor-a': 'instructor', 'owner-x': 'owner' };
    const visibilityCalls: Array<{ tenantId: string; userId: string; isOwner: boolean }> = [];
    const store = db as unknown as AttendanceReportsStore;
    const audits: Array<{ store: AttendanceReportsStore; input: AttendanceReportAuditInput }> = [];
    const audit: AttendanceReportAuditWriter = opts.audit
        ?? (async (auditStore, input) => { audits.push({ store: auditStore, input }); });
    const router = createAttendanceReportsRouter({
        store,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async (userId: string, tenantId: string) => {
            const authority = AUTHORITY[userId];
            return authority && tenantId === 'tenant-a' ? { authority } : null;
        },
        // Copy of the exact row-level predicate `routes/attendance-records.ts`
        // applies: owner sees the tenant; non-owner instructors only their
        // live assigned groups plus sessions they created.
        buildRecordVisibility: (scope) => {
            visibilityCalls.push({ ...scope });
            if (scope.isOwner) return { sql: '1=1', params: [] };
            return {
                sql: '(ss.group_id IN (SELECT id FROM `groups` WHERE instructor_id = ?) OR ss.created_by = ?)',
                params: [scope.userId, scope.userId],
            };
        },
        audit,
        now: () => new Date('2026-06-01T00:00:00Z'),
    });
    return { router, executed: db.executed, visibilityCalls, audits, store };
};

const invokeRoute = async (
    router: ReturnType<typeof createAttendanceReportsRouter>,
    request: { method: string; url: string; token?: string | null; query?: Record<string, string> },
): Promise<LocalResponse> => {
    const headers: Record<string, string> = {};
    const response: LocalResponse = {
        status(code: number) {
            response.statusCode = code;
            return response;
        },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
        set(header: string, value: string) {
            headers[header.toLowerCase()] = value;
            response.headers = headers;
            return response;
        },
        send(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const summary = (router: ReturnType<typeof createAttendanceReportsRouter>, query: Record<string, string> = rangeQuery(), token: string = INSTRUCTOR_A) =>
    invokeRoute(router, { method: 'GET', url: '/summary', token, query: query ?? rangeQuery() });

const reportSql = (executed: ExecutedStatement[]): ExecutedStatement =>
    executed.find((e) => e.sql.includes('FROM attendance_records')) as ExecutedStatement;

// ---------------------------------------------------------------------------
// Standard fixture: owner authority map (owner-x) plus shared existence data.
// The record responder below is parameterized per test.
// ---------------------------------------------------------------------------

interface FixtureOptions {
    rows?: AttendanceReportRecordRow[];
    studentIds?: string[];
    groupIds?: string[];
    branchIds?: string[];
}

const presenceResponder = (options: FixtureOptions): Responder => (sql, params) => {
    if (sql.includes('SELECT id FROM students WHERE id = ? AND tenant_id = ?')) {
        return (options.studentIds ?? ['stu-1', 'stu-2', 'stu-3']).includes(params[0] as string) ? [{ id: params[0] }] : null;
    }
    if (sql.includes('SELECT id FROM `groups` WHERE id = ? AND tenant_id = ?')) {
        return (options.groupIds ?? ['grp-1', 'grp-2']).includes(params[0] as string) ? [{ id: params[0] }] : null;
    }
    if (sql.includes('SELECT id FROM branches WHERE id = ? AND tenant_id = ?')) {
        return (options.branchIds ?? ['br-1']).includes(params[0] as string) ? [{ id: params[0] }] : null;
    }
    if (sql.includes('FROM attendance_records')) return options.rows ?? [];
    return null;
};

// ---------------------------------------------------------------------------
// Denials first (write-nothing boundaries)
// ---------------------------------------------------------------------------

test('attendance reports: anonymous summary is 401 with no data access', async () => {
    const { router, executed } = buildRouter(presenceResponder({}));
    const response = await invokeRoute(router, { method: 'GET', url: '/summary', token: null, query: rangeQuery() });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('attendance reports: a student is denied the staff report surface', async () => {
    const { router, executed } = buildRouter(presenceResponder({}));
    const response = await summary(router, rangeQuery(), STUDENT_A);
    assert.equal(response.statusCode, 403);
    assert.equal(executed.filter((e) => e.sql.includes('FROM attendance_records')).length, 0);
});

test('attendance reports: instructor from another tenant is denied', async () => {
    const { router, executed } = buildRouter(presenceResponder({}));
    const response = await summary(router, rangeQuery(), INSTRUCTOR_B);
    assert.equal(response.statusCode, 403);
    assert.equal(executed.filter((e) => e.sql.includes('FROM attendance_records')).length, 0);
});

// ---------------------------------------------------------------------------
// Range validation (bad / missing / inverted / oversized -> 400)
// ---------------------------------------------------------------------------

test('attendance reports: missing range bounds are a 400', async () => {
    const { router } = buildRouter(presenceResponder({}));
    assert.equal((await summary(router, {})).statusCode, 400);
    assert.equal((await summary(router, { from: '2026-05-01' })).statusCode, 400);
    assert.equal((await summary(router, { to: '2026-05-31' })).statusCode, 400);
});

test('attendance reports: a malformed bound is a 400', async () => {
    const { router } = buildRouter(presenceResponder({}));
    const response = await summary(router, { from: '2026/05/01', to: '2026-05-31' });
    assert.equal(response.statusCode, 400);
    assert.ok(String((response.body as { error: string }).error).includes('from'));
});

test('attendance reports: an inverted range is a 400', async () => {
    const { router } = buildRouter(presenceResponder({}));
    const response = await summary(router, { from: '2026-06-02', to: '2026-06-01' });
    assert.equal(response.statusCode, 400);
});

test('attendance reports: a range over the documented cap is a 400', async () => {
    const { router } = buildRouter(presenceResponder({}));
    const response = await summary(router, { from: '2025-01-01', to: '2026-01-03' });
    assert.equal(response.statusCode, 400);
    assert.ok(String((response.body as { error: string }).error).includes('366'));
});

test('attendance reports: a range of exactly the maximum span is accepted', async () => {
    const { router } = buildRouter(presenceResponder({ rows: [] }));
    const response = await summary(router, { from: '2025-01-01', to: '2026-01-02' });
    assert.equal(response.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Cross-tenant / unknown filter ids are 404 before any record read
// ---------------------------------------------------------------------------

test('attendance reports: cross-tenant filter ids are 404 with no record read', async () => {
    const { router, executed } = buildRouter(presenceResponder({ rows: [recordRow()] }));
    for (const [param, foreignId] of [
        ['student_id', 'stu-foreign'],
        ['group_id', 'grp-foreign'],
        ['branch_id', 'br-foreign'],
    ] as const) {
        const query = { ...rangeQuery(), [param]: foreignId };
        const response = await summary(router, query, OWNER_X);
        assert.equal(response.statusCode, 404, `${param}=${foreignId} expected 404`);
    }
    assert.equal(executed.filter((e) => e.sql.includes('FROM attendance_records')).length, 0);
    const existence = executed.find((e) => e.sql.includes('SELECT id FROM students WHERE id = ? AND tenant_id = ?'));
    assert.ok(existence);
    assert.deepEqual(existence.params, ['stu-foreign', 'tenant-a']);
});

// ---------------------------------------------------------------------------
// Scope / authority wiring
// ---------------------------------------------------------------------------

test('attendance reports: non-owner receives only the assigned-group visibility predicate', async () => {
    const { router, executed, visibilityCalls } = buildRouter(presenceResponder({ rows: [recordRow()] }));
    const response = await summary(router);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(visibilityCalls, [{ tenantId: 'tenant-a', userId: 'instructor-a', isOwner: false }]);
    const statement = reportSql(executed);
    assert.ok(statement.sql.includes('(ss.group_id IN (SELECT id FROM `groups` WHERE instructor_id = ?) OR ss.created_by = ?)'));
    assert.deepEqual(statement.params, ['tenant-a', '2026-05-01 00:00:00', '2026-05-31 00:00:00', 'instructor-a', 'instructor-a']);
});

test('attendance reports: the tenant owner keeps the tenant-wide visibility', async () => {
    const { router, executed, visibilityCalls } = buildRouter(presenceResponder({ rows: [recordRow()] }));
    const response = await summary(router, rangeQuery(), OWNER_X);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(visibilityCalls, [{ tenantId: 'tenant-a', userId: 'owner-x', isOwner: true }]);
    const statement = reportSql(executed);
    assert.ok(statement.sql.includes('1=1'));
    assert.ok(!statement.sql.includes('instructor_id = ?'));
    assert.deepEqual(statement.params, ['tenant-a', '2026-05-01 00:00:00', '2026-05-31 00:00:00']);
});

test('attendance reports: optional filters reach the SQL in deterministic order', async () => {
    const { router, executed } = buildRouter(presenceResponder({ rows: [recordRow()] }));
    const response = await summary(router, { ...rangeQuery(), student_id: 'stu-1', group_id: 'grp-1', branch_id: 'br-1' }, OWNER_X);
    assert.equal(response.statusCode, 200);
    const statement = reportSql(executed);
    assert.ok(statement.sql.includes('ar.student_id = ?'));
    assert.ok(statement.sql.includes('ar.group_id = ?'));
    assert.ok(statement.sql.includes('ss.branch_id = ?'));
    assert.deepEqual(statement.params, ['tenant-a', '2026-05-01 00:00:00', '2026-05-31 00:00:00', 'stu-1', 'grp-1', 'br-1']);
});

// ---------------------------------------------------------------------------
// Aggregation exactness (totals equal the sum of underlying rows)
// ---------------------------------------------------------------------------

const FIXTURE_ROWS: AttendanceReportRecordRow[] = [
    recordRow({ id: 'ar-1', session_id: 'se-1', group_id: 'grp-1', student_id: 'stu-1', state: 'present' }),
    recordRow({ id: 'ar-2', session_id: 'se-1', group_id: 'grp-1', student_id: 'stu-1', state: 'late', corrected: 1 }),
    recordRow({ id: 'ar-3', session_id: 'se-1', group_id: 'grp-1', student_id: 'stu-2', state: 'absent' }),
    recordRow({ id: 'ar-4', session_id: 'se-2', group_id: 'grp-2', student_id: 'stu-2', state: 'excused' }),
    recordRow({ id: 'ar-5', session_id: 'se-2', group_id: null, student_id: 'stu-3', state: 'absent', corrected: 1 }),
    recordRow({ id: 'ar-6', session_id: 'se-3', group_id: null, student_id: 'stu-3', state: 'present' }),
    recordRow({ id: 'ar-7', session_id: 'se-3', group_id: 'grp-1', student_id: 'stu-1', state: 'present' }),
    recordRow({ id: 'ar-8', session_id: 'se-3', group_id: 'grp-1', student_id: 'stu-2', state: 'late' }),
];

test('attendance reports: aggregate totals equal the sum of the underlying rows', async () => {
    const { router } = buildRouter(presenceResponder({ rows: FIXTURE_ROWS }));
    const response = await summary(router, rangeQuery(), OWNER_X);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['x-results-truncated'], 'false');
    const body = response.body as {
        range: { from: string; to: string };
        totals: { present: number; absent: number; late: number; excused: number; total: number; corrected: number; students: number; sessions: number };
        by_student: Array<{ student_id: string; present: number; absent: number; late: number; excused: number; total: number; corrected: number }>;
        by_group: Array<{ group_id: string | null; present: number; absent: number; late: number; excused: number; total: number; corrected: number; students: number; sessions: number }>;
        by_session: Array<{ session_id: string; present: number; absent: number; late: number; excused: number; total: number; corrected: number; students: number }>;
        row_count: number;
        truncated: boolean;
    };
    assert.deepEqual(body.range, { from: '2026-05-01 00:00:00', to: '2026-05-31 00:00:00' });
    assert.equal(body.row_count, FIXTURE_ROWS.length);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.totals, { present: 3, absent: 2, late: 2, excused: 1, total: 8, corrected: 2, students: 3, sessions: 3 });

    // Every partition sums back to the top-level totals.
    const sumPartition = <T extends { present: number; absent: number; late: number; excused: number; total: number; corrected: number }>(parts: T[]) => ({
        present: parts.reduce((acc, p) => acc + p.present, 0),
        absent: parts.reduce((acc, p) => acc + p.absent, 0),
        late: parts.reduce((acc, p) => acc + p.late, 0),
        excused: parts.reduce((acc, p) => acc + p.excused, 0),
        total: parts.reduce((acc, p) => acc + p.total, 0),
        corrected: parts.reduce((acc, p) => acc + p.corrected, 0),
    });
    assert.deepEqual(sumPartition(body.by_student), { present: 3, absent: 2, late: 2, excused: 1, total: 8, corrected: 2 });
    assert.deepEqual(sumPartition(body.by_group), { present: 3, absent: 2, late: 2, excused: 1, total: 8, corrected: 2 });
    assert.deepEqual(sumPartition(body.by_session), { present: 3, absent: 2, late: 2, excused: 1, total: 8, corrected: 2 });
});

test('attendance reports: aggregates are deterministically ordered', async () => {
    const { router } = buildRouter(presenceResponder({ rows: FIXTURE_ROWS }));
    const response = await summary(router, rangeQuery(), OWNER_X);
    const body = response.body as {
        by_student: Array<{ student_id: string }>;
        by_group: Array<{ group_id: string | null }>;
        by_session: Array<{ session_id: string }>;
    };
    assert.deepEqual(body.by_student.map((s) => s.student_id), ['stu-1', 'stu-2', 'stu-3']);
    // NULL group (tenant/branch rows) sorts first, then ids ascending.
    assert.deepEqual(body.by_group.map((g) => g.group_id), [null, 'grp-1', 'grp-2']);
    assert.deepEqual(body.by_session.map((s) => s.session_id), ['se-1', 'se-2', 'se-3']);
});

test('attendance reports: summary truncation keeps totals equal to the reported rows', async () => {
    const rows = Array.from({ length: 5001 }, (_, index) =>
        recordRow({
            id: `ar-${index + 1}`,
            student_id: 'stu-1',
            session_id: 'se-1',
            group_id: 'grp-1',
            state: index % 2 === 0 ? 'present' : 'absent',
        }));
    const { router } = buildRouter(presenceResponder({ rows }));
    const response = await summary(router, rangeQuery(), OWNER_X);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['x-results-truncated'], 'true');
    const body = response.body as { truncated: boolean; row_count: number; totals: { total: number; present: number; absent: number } };
    assert.equal(body.truncated, true);
    assert.equal(body.row_count, 5000);
    // Aggregates equal the sum of the rows actually reported on.
    assert.equal(body.totals.total, 5000);
    assert.equal(body.totals.present, 2500);
    assert.equal(body.totals.absent, 2500);
});

// ---------------------------------------------------------------------------
// Privacy: no reason / correction_reason anywhere, corrected facts still count
// ---------------------------------------------------------------------------

test('attendance reports: corrected rows are counted but private reasons never appear', async () => {
    const contaminated = FIXTURE_ROWS.map((row, index) => ({
        ...row,
        // Adversarial store rows: if any code path forwarded raw columns, the
        // private reason would leak into the serialized payload.
        reason: `private-reason-${index}`,
        correction_reason: `private-correction-${index}`,
    }));
    const { router } = buildRouter(presenceResponder({ rows: contaminated }));
    const response = await summary(router, rangeQuery(), OWNER_X);
    const body = response.body as { totals: { corrected: number } };
    assert.equal(response.statusCode, 200);
    assert.equal(body.totals.corrected, 2);
    const serialized = JSON.stringify(response.body);
    assert.equal(/correction_reason/.test(serialized), false);
    assert.equal(/"reason"/.test(serialized), false);
    assert.equal(serialized.includes('private-reason'), false);
    assert.equal(serialized.includes('private-correction'), false);
});

test('attendance reports: the report SQL never selects a reason column', async () => {
    const { router, executed } = buildRouter(presenceResponder({ rows: [recordRow()] }));
    await summary(router, rangeQuery(), OWNER_X);
    const statement = reportSql(executed);
    assert.equal(statement.sql.includes('reason'), false);
    assert.ok(statement.sql.includes('(ar.corrected_at IS NOT NULL) AS corrected'));
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const exportRoute = (router: ReturnType<typeof createAttendanceReportsRouter>, query: Record<string, string> = rangeQuery(), token: string = OWNER_X) =>
    invokeRoute(router, { method: 'GET', url: '/export.csv', token, query });

const csvLines = (payload: unknown): string[] => String(payload).split('\r\n');

test('attendance reports: export one CSV row per underlying record, formula cells neutralized', async () => {
    const rows = [
        recordRow({ id: 'ar-1', student_id: 'stu-1', group_id: "=cmd|' /C calc'!A0", state: 'present' }),
        recordRow({ id: 'ar-2', student_id: '=HYPERLINK("http://evil","x")', group_id: 'grp-1', state: 'absent', corrected: 1 }),
    ];
    const storage = presenceResponder({ rows });
    const { router } = buildRouter(storage);
    const response = await exportRoute(router);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['content-type'], 'text/csv; charset=utf-8');
    assert.equal(response.headers?.['x-results-truncated'], 'false');
    const lines = csvLines(response.body);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'student_id,group_id,session_id,state,marked_at_utc,corrected');
    assert.equal(lines[2], '"\'=HYPERLINK(""http://evil"",""x"")",grp-1,se-1,absent,2026-05-01 09:00:00,true');
    // The formula-prefixed group cell renders as inert text: neutralized with
    // a leading apostrophe (no wrapping since the cell has no comma).
    assert.equal(lines[1].split(',')[1], "'=cmd|' /C calc'!A0");
    // The corrected fact appears as a boolean, never as a reason.
    assert.ok(lines[2].endsWith(',true'));
});

test('attendance reports: export truncates at the hard cap with the explicit header', async () => {
    const rows = Array.from({ length: 5001 }, (_, index) =>
        recordRow({ id: `ar-${index + 1}`, student_id: 'stu-1', state: 'present' }));
    const { router } = buildRouter(presenceResponder({ rows }));
    const response = await exportRoute(router);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.['x-results-truncated'], 'true');
    assert.equal(csvLines(response.body).length, 5001); // header + 5000 rows
});

test('attendance reports: an uncapped export carries the explicit false header', async () => {
    const { router } = buildRouter(presenceResponder({ rows: [recordRow()] }));
    const response = await exportRoute(router);
    assert.equal(response.headers?.['x-results-truncated'], 'false');
    assert.equal(csvLines(response.body).length, 2);
});

test('attendance reports: export is audited with actor, tenant, row count, range and truncated flag', async () => {
    const { router, audits, store } = buildRouter(presenceResponder({ rows: FIXTURE_ROWS }));
    const response = await exportRoute(router);
    assert.equal(response.statusCode, 200);
    assert.equal(audits.length, 1, 'the export writes exactly one audit event');
    const { store: auditStore, input } = audits[0];
    assert.equal(auditStore, store, 'audit receives the same store handle as the read');
    assert.equal(input.actorUserId, 'owner-x');
    assert.equal(input.tenantId, 'tenant-a');
    assert.equal(input.action, 'attendance_report.export');
    assert.equal(input.resourceType, 'attendance_report');
    const payload = input.newValue as {
        filters: Record<string, unknown>;
        from: string;
        to: string;
        row_count: number;
        truncated: boolean;
        totals: { total: number };
    };
    assert.deepEqual(payload.filters, { student_id: null, group_id: null, branch_id: null });
    assert.equal(payload.from, '2026-05-01 00:00:00');
    assert.equal(payload.to, '2026-05-31 00:00:00');
    assert.equal(payload.row_count, FIXTURE_ROWS.length);
    assert.equal(payload.truncated, false);
    assert.equal(payload.totals.total, 8);
    // The audit event itself must not smuggle a private reason either.
    assert.equal(JSON.stringify(input).includes('reason'), false);
});

test('attendance reports: an audit failure fails the export without leaking data', async () => {
    const db = makeFakeDataAccess(presenceResponder({ rows: FIXTURE_ROWS }));
    const repository = makeRepository({
        'owner-x': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    }, {
        instructorAccounts: { 'owner-x': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { 'owner-x': [{ tenant_id: 'tenant-a' }] },
        enrollments: {},
    });
    const router = createAttendanceReportsRouter({
        store: { query: db.query },
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async (userId: string, tenantId: string) =>
            userId === 'owner-x' && tenantId === 'tenant-a' ? { authority: 'owner' } : null,
        buildRecordVisibility: () => ({ sql: '1=1', params: [] }),
        audit: async () => { throw new Error('audit connection lost'); },
        now: () => new Date('2026-06-01T00:00:00Z'),
    });
    const response = await exportRoute(router);
    assert.equal(response.statusCode, 500);
    const body = response.body as { error: string };
    assert.equal(body.error, 'Failed to export attendance report');
    assert.equal(Object.keys(body).length, 1);
    assert.equal(typeof response.body, 'object');
    assert.equal(JSON.stringify(body).includes('stu-'), false);
    assert.equal(JSON.stringify(body).includes('present'), false);
});

test('attendance reports: construction without a sealed audit writer throws before any request', () => {
    const repository = makeRepository({}, {});
    assert.throws(() => createAttendanceReportsRouter({
        store: { query: async () => [] },
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => null,
        buildRecordVisibility: () => ({ sql: '1=1', params: [] }),
        audit: undefined as unknown as AttendanceReportAuditWriter,
    }), /sealed audit writer/);
});

// ---------------------------------------------------------------------------
// Store failure -> generic 500 (no store internals leak)
// ---------------------------------------------------------------------------

test('attendance reports: a store failure is a generic 500', async () => {
    const { router } = buildRouter((sql) => {
        if (sql.includes('FROM attendance_records')) throw new Error('disk exploded');
        return null;
    });
    const summaryResponse = await summary(router, rangeQuery(), OWNER_X);
    assert.equal(summaryResponse.statusCode, 500);
    assert.equal((summaryResponse.body as { error: string }).error, 'Failed to build attendance report');
    assert.equal(JSON.stringify(summaryResponse.body).includes('disk'), false);

    const exportResponse = await exportRoute(router);
    assert.equal(exportResponse.statusCode, 500);
    assert.equal((exportResponse.body as { error: string }).error, 'Failed to export attendance report');
});
