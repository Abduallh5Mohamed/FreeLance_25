import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { NextFunction } from 'express';
import { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    analyzeStudentCsv,
    hashCsvContent,
    MAX_CSV_BYTES,
    MAX_CSV_ROWS,
    neutralizeCsvCell,
    parseStudentCsv,
    planImport,
    toRejectedReportCsv,
    validateStudentRow,
} from '../src/services/student-csv-import';
import { createStudentImportRouter, type StudentImportDataAccess } from '../src/routes/student-import';
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
// Parser + validation (pure)
// ---------------------------------------------------------------------------

test('parse: rejects missing/oversized/empty input and bad headers', () => {
    assert.equal(parseStudentCsv(undefined).ok, false);
    assert.equal(parseStudentCsv('   ').ok, false);
    assert.equal(parseStudentCsv(`name\n${'x'.repeat(MAX_CSV_BYTES)}`).ok, false);
    assert.equal(parseStudentCsv('phone\n0100').ok, false, 'missing required name column');
    assert.equal(parseStudentCsv('name,name\nA,B').ok, false, 'duplicate column');
    assert.equal(parseStudentCsv('name,password\nA,secret').ok, false, 'forbidden column');
    assert.equal(parseStudentCsv('name,unknown_col\nA,B').ok, false, 'unknown column');
    assert.equal(parseStudentCsv('name').ok, false, 'no data rows');
});

test('parse: reads quoted fields, escaped quotes and embedded commas', () => {
    const parsed = parseStudentCsv('name,notes\n"Smith, John","said ""hi"""\n');
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
        assert.deepEqual(parsed.headers, ['name', 'notes']);
        assert.deepEqual(parsed.records, [['Smith, John', 'said "hi"']]);
    }
});

test('parse: enforces the row limit', () => {
    const rows = ['name'];
    for (let i = 0; i < MAX_CSV_ROWS + 1; i += 1) rows.push(`S${i}`);
    assert.equal(parseStudentCsv(rows.join('\n')).ok, false);
});

test('validate row: rejects bad types and reports errors per row', () => {
    const headers = ['name', 'phone', 'email'];
    assert.deepEqual(validateStudentRow(headers, ['', '010', 'a@b.com'], 2).errors.length > 0, true);
    assert.deepEqual(validateStudentRow(headers, ['Ravi', 'not-a-phone', 'a@b.com'], 2).errors, ['phone is not a valid number']);
    assert.deepEqual(validateStudentRow(headers, ['Ravi', '0100000000', 'nope'], 2).errors, ['email is not valid']);
    const ok = validateStudentRow(headers, ['Ravi', '0100 000 0000', 'ravi@example.com'], 2);
    assert.ok(ok.row);
    assert.equal(ok.row!.key, '01000000000');
});

test('analyze: flags in-file duplicates and existing duplicates', async () => {
    const csv = 'name,phone\nA,01000000001\nB,01000000001\nC,01000000003\n';
    const analyzed = await analyzeStudentCsv(csv, async ({ phone }) => phone === '01000000003');
    assert.equal(analyzed.ok, true);
    if (analyzed.ok) {
        assert.equal(analyzed.analysis.rows.length, 3);
        assert.equal(analyzed.analysis.duplicates.length, 2);
        assert.deepEqual(
            analyzed.analysis.duplicates.map((d) => d.reason).sort(),
            ['existing', 'file-duplicate'],
        );
    }
});

test('planImport: applies error / skip / update resolutions', async () => {
    const csv = 'name,phone\nA,01000000001\nB,01000000002\n';
    const analyzed = await analyzeStudentCsv(csv, async ({ phone }) => phone === '01000000002');
    assert.equal(analyzed.ok, true);
    if (!analyzed.ok) return;
    assert.equal(planImport(analyzed.analysis, 'error').ok, false);
    const skipped = planImport(analyzed.analysis, 'skip');
    assert.equal(skipped.ok, true);
    if (skipped.ok) {
        assert.equal(skipped.plan.toInsert.length, 1);
        assert.equal(skipped.plan.toUpdate.length, 0);
        assert.equal(skipped.plan.skipped.length, 1);
    }
    const updated = planImport(analyzed.analysis, 'update');
    assert.equal(updated.ok, true);
    if (updated.ok) {
        assert.equal(updated.plan.toInsert.length, 1);
        assert.equal(updated.plan.toUpdate.length, 1);
    }
});

test('hashCsvContent is deterministic and content-sensitive', () => {
    assert.equal(hashCsvContent('a,b'), hashCsvContent('a,b'));
    assert.notEqual(hashCsvContent('a,b'), hashCsvContent('a,c'));
});

test('formula injection is neutralized in report cells', () => {
    assert.equal(neutralizeCsvCell('=1+1'), "'=1+1");
    assert.equal(neutralizeCsvCell('+SUM(A1)'), "'+SUM(A1)");
    assert.equal(neutralizeCsvCell('-2'), "'-2");
    assert.equal(neutralizeCsvCell('@cmd'), "'@cmd");
    assert.equal(neutralizeCsvCell('safe'), 'safe');
    const csv = toRejectedReportCsv([{ rowNumber: 2, errors: ['name is required'], cells: ['=HYPERLINK("x")', 'a,b'] }], ['name', 'notes']);
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
    assert.match(csv, /"a,b"/);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const AUTHORITY: Record<string, string> = { 'instructor-a': 'instructor' };

const buildRouter = (
    responder: (sql: string, params: unknown[]) => unknown[] | null,
    executeOverride?: StudentImportDataAccess['execute'],
) => {
    const base = makeFakeDataAccess(responder);
    const db: StudentImportDataAccess = executeOverride
        ? { query: base.query, queryOne: base.queryOne, execute: executeOverride }
        : base;
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
        enrollments: { 'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null }] },
    });
    const router = createStudentImportRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async (userId, tenantId) =>
            AUTHORITY[userId] && tenantId === 'tenant-a' ? { authority: 'instructor' } : null,
        transaction: async <T>(fn: (tx: StudentImportDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: base.executed };
};

const auditAction = (executed: { sql: string; params: unknown[] }[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

const GOOD_CSV = 'name,phone,email\nRavi,01000000001,ravi@example.com\nMona,01000000002,mona@example.com\n';

// --- preview ---
test('preview: anonymous is 401 with no data access', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/preview', body: { csv: GOOD_CSV } });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('preview: a student is denied 403', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/preview', token: STUDENT_A, body: { csv: GOOD_CSV } });
    assert.equal(response.statusCode, 403);
});

test('preview: a malformed CSV is 400 with no write', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'POST', url: '/preview', token: INSTRUCTOR_A, body: { csv: 'phone\n0100' } });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.kind === 'execute'), false);
});

test('preview: a branch outside the tenant is 403', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/preview', token: INSTRUCTOR_A, body: { csv: GOOD_CSV, branch_id: 'br-x' },
    });
    assert.equal(response.statusCode, 403);
});

test('preview: valid CSV returns counts without writing', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/preview', token: INSTRUCTOR_A, body: { csv: 'name,phone\nA,01000000001\n,01000000002\n' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as { valid_count: number; rejected_count: number };
    assert.equal(body.valid_count, 1);
    assert.equal(body.rejected_count, 1);
    assert.equal(executed.some((e) => e.kind === 'execute'), false);
});

// --- commit ---
test('commit: duplicate resolution "error" rejects the whole import with 409', async () => {
    const responder = (sql: string) => {
        if (sql.includes('FROM students WHERE tenant_id=?')) return [{ id: 'existing-1' }];
        return [];
    };
    const { router, executed } = buildRouter(responder);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/commit', token: INSTRUCTOR_A, body: { csv: GOOD_CSV, duplicate_resolution: 'error' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO students')), false);
});

test('commit: imports rows, writes the batch, audits, and never touches a password column', async () => {
    const { router, executed } = buildRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'POST', url: '/commit', token: INSTRUCTOR_A, body: { csv: GOOD_CSV },
    });
    assert.equal(response.statusCode, 201);
    const body = response.body as { imported_count: number; idempotent: boolean };
    assert.equal(body.imported_count, 2);
    assert.equal(body.idempotent, false);
    const inserts = executed.filter((e) => e.sql.includes('INSERT INTO students'));
    assert.equal(inserts.length, 2);
    for (const insert of inserts) assert.doesNotMatch(insert.sql, /password|hash/i);
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO student_import_batches')));
    assert.ok(auditAction(executed, 'student_import.commit'));
});

test('commit: a repeat of the same file hash is idempotent (200, no double import)', async () => {
    let stored = false;
    const base = makeFakeDataAccess(() => []);
    const execute: StudentImportDataAccess['execute'] = async (sql, params) => {
        const result = await base.execute(sql, params);
        if (sql.includes('INSERT INTO student_import_batches')) stored = true;
        return result;
    };
    const { router } = buildRouter((sql) => {
        if (sql.includes('FROM student_import_batches') && stored) {
            return [{ id: 'batch-1', imported_count: 2, updated_count: 0, skipped_count: 0, rejected_count: 0 }];
        }
        return [];
    }, execute);
    const first = await invokeRoute(router, { method: 'POST', url: '/commit', token: INSTRUCTOR_A, body: { csv: GOOD_CSV } });
    assert.equal(first.statusCode, 201);
    const insertsAfterFirst = base.executed.filter((e) => e.sql.includes('INSERT INTO students')).length;
    assert.equal(insertsAfterFirst, 2);
    const second = await invokeRoute(router, { method: 'POST', url: '/commit', token: INSTRUCTOR_A, body: { csv: GOOD_CSV } });
    assert.equal(second.statusCode, 200);
    assert.equal((second.body as { idempotent?: boolean }).idempotent, true);
    assert.equal(base.executed.filter((e) => e.sql.includes('INSERT INTO students')).length, 2, 'second commit inserts nothing');
});

test('commit: an audit failure fails the import (500)', async () => {
    const execute: StudentImportDataAccess['execute'] = async (sql, params) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit storage unavailable');
        const base = makeFakeDataAccess(() => []);
        return base.execute(sql, params);
    };
    const { router } = buildRouter(() => [], execute);
    const response = await invokeRoute(router, { method: 'POST', url: '/commit', token: INSTRUCTOR_A, body: { csv: GOOD_CSV } });
    assert.equal(response.statusCode, 500);
});

// --- batches + report ---
test('batches: a cross-tenant instructor is 403', async () => {
    const { router } = buildRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/batches', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 403);
});

test('batches: list is tenant-scoped', async () => {
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM student_import_batches') ? [{ id: 'batch-1' }] : [],
    );
    const response = await invokeRoute(router, { method: 'GET', url: '/batches', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('WHERE tenant_id=?') && e.params[0] === 'tenant-a'));
});

const invokeReport = async (
    router: Router,
    url: string,
    token: string,
): Promise<{ statusCode?: number; body?: string; headers: Record<string, string> }> => {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    let statusCode: number | undefined;
    const res: {
        status(code: number): unknown; json(payload: unknown): unknown;
        set(header: string, value: string): unknown; send(payload: string): unknown;
    } = {
        status(code: number) { statusCode = code; return res; },
        json(payload: unknown) { statusCode ??= 200; body = JSON.stringify(payload); return res; },
        set(header: string, value: string) { headers[header.toLowerCase()] = value; return res; },
        send(payload: string) { body = payload; return res; },
    };
    const req = {
        method: 'GET', url, originalUrl: url,
        headers: { authorization: `Bearer ${token}` }, body: {}, query: {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, res, () => {});
    const deadline = Date.now() + 5000;
    while (body === undefined && statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { statusCode, body, headers };
};

test('report: unknown batch is 404', async () => {
    const { router } = buildRouter(() => []);
    const result = await invokeReport(router, '/batches/nope/report.csv', INSTRUCTOR_A);
    assert.equal(result.statusCode, 404);
});

test('report: exports a formula-safe CSV and audits the export', async () => {
    const batch = {
        id: 'batch-1', tenant_id: 'tenant-a', file_hash: 'h',
        headers: JSON.stringify(['name', 'phone']),
        rejected_rows: JSON.stringify([{ rowNumber: 2, errors: ['name is required'], cells: ['=1+1', '0100'] }]),
    };
    const { router, executed } = buildRouter((sql) =>
        sql.includes('FROM student_import_batches') ? [batch] : [],
    );
    const result = await invokeReport(router, '/batches/batch-1/report.csv', INSTRUCTOR_A);
    assert.equal(result.statusCode, undefined);
    assert.match(String(result.body), /^row,errors,name,phone/);
    assert.match(String(result.body), /'=1\+1/);
    assert.match(result.headers['content-type'] ?? '', /text\/csv/);
    assert.ok(auditAction(executed, 'student_import.report_exported'));
});
