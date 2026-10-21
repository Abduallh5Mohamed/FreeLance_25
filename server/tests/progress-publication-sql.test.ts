/**
 * B2-C-PERSISTENCE adapter tests for `progress-publication-sql.ts` and
 * `progress-report-source-sql.ts`.
 *
 * HONEST LIMIT: the recording seam verifies SQL text, bindings and transaction
 * discipline only. It is NOT a MySQL run: unique-key arbitration, FK/CHECK,
 * collation and server version behaviour remain unproven.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PROGRESS_PUBLICATION_LIST_CAP,
    ProgressPublicationSqlError,
    createProgressPublicationSqlStore,
    type PublicationAuditSink,
    type PublicationSqlConnection,
} from '../src/services/progress-publication-sql';
import {
    createProgressPublicationService,
    type PublicationTransaction,
} from '../src/services/progress-publication';
import {
    PROGRESS_REPORT_SOURCE_MAX_ROWS,
    PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS,
    ProgressReportSourceUnavailableError,
    ProgressReportSourceSqlError,
    createProgressReportSourceSql,
    type ProgressReportSqlConnection,
} from '../src/services/progress-report-source-sql';

interface RecordedStatement {
    readonly connId: number;
    readonly kind: 'query' | 'execute';
    readonly sql: string;
    readonly params: readonly unknown[];
}

interface HandlerResult {
    readonly rows?: readonly unknown[];
    readonly affectedRows?: number;
}

type Handler = (statement: RecordedStatement, db: RecordingDb) => Promise<HandlerResult>;

class RecordingConnection implements PublicationSqlConnection, ProgressReportSqlConnection {
    constructor(private readonly id: number, private readonly db: RecordingDb) {}

    query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        return this.db.dispatch('query', this.id, sql, params) as Promise<T[]>;
    }

    execute(sql: string, params: readonly unknown[] = []): Promise<{ affectedRows?: number }> {
        return this.db.dispatch('execute', this.id, sql, params) as Promise<{ affectedRows?: number }>;
    }
}

class RecordingDb {
    readonly statements: RecordedStatement[] = [];
    commits = 0;
    rollbacks = 0;
    state: Record<string, unknown> = {};
    private connectionSeq = 0;

    constructor(public handler: Handler) {}

    async dispatch(
        kind: 'query' | 'execute',
        connId: number,
        sql: string,
        params: readonly unknown[],
    ): Promise<unknown> {
        const statement: RecordedStatement = { connId, kind, sql: String(sql), params: [...params] };
        this.statements.push(statement);
        const result = await this.handler(statement, this);
        return kind === 'query' ? (result.rows ?? []) : result;
    }

    readonly runner = async <T>(fn: (conn: RecordingConnection) => Promise<T>): Promise<T> => {
        const snapshot = JSON.stringify(this.state);
        const conn = new RecordingConnection(++this.connectionSeq, this);
        try {
            const result = await fn(conn);
            this.commits += 1;
            return result;
        } catch (error) {
            this.state = JSON.parse(snapshot) as Record<string, unknown>;
            this.rollbacks += 1;
            throw error;
        }
    };

    all(kind: 'query' | 'execute', fragment: string): RecordedStatement[] {
        return this.statements.filter((statement) => statement.kind === kind && statement.sql.includes(fragment));
    }

    get connIds(): Set<number> {
        return new Set(this.statements.map((statement) => statement.connId));
    }
}

const publicationRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    tenant_id: 'tenant-1',
    student_enrollment_id: 'enrollment-1',
    course_id: 'course-1',
    state: 'draft',
    published_by: null,
    published_at: null,
    version: 2,
    ...overrides,
});

const transitionInput = (overrides: Partial<{
    expectedVersion: number;
    nextState: 'draft' | 'published';
    actorUserId: string;
    now: Date;
}> = {}) => ({
    tenantId: 'tenant-1',
    studentEnrollmentId: 'enrollment-1',
    courseId: 'course-1',
    expectedVersion: 2,
    nextState: 'published' as const,
    actorUserId: 'teacher-1',
    now: new Date('2026-10-21T10:00:00.000Z'),
    ...overrides,
});

const auditSink = (): PublicationAuditSink => async (conn, input) => {
    await conn.execute('INSERT INTO audit_events (id, action) VALUES (?, ?)', ['audit-1', input.action]);
};

const createStore = (
    db: RecordingDb,
    audit: PublicationAuditSink = auditSink(),
) => createProgressPublicationSqlStore({ transaction: db.runner, audit, idFactory: () => 'publication-id' });

test('publication construction fails fast without a transaction runner', () => {
    assert.throws(
        () => createProgressPublicationSqlStore({ audit: auditSink() } as never),
        /transaction runner/,
    );
});

test('publication construction fails fast without the required audit writer before any write', () => {
    const db = new RecordingDb(async () => {
        throw new Error('no SQL expected');
    });
    assert.throws(
        () => createProgressPublicationSqlStore({ transaction: db.runner } as never),
        (error: unknown) => error instanceof ProgressPublicationSqlError && error.code === 'invalid_audit',
    );
    assert.equal(db.statements.length, 0);
});

test('publication CAS transition is tenant-scoped, bumps once, and writes no implicit audit', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('UPDATE progress_report_publications')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const affected = await db.runner(async (conn) => {
        const bound = store.inTransaction(conn);
        const result = await bound.transitionPublication(transitionInput());
        assert.equal(db.all('execute', 'INSERT INTO audit_events').length, 0, 'adapter must not audit by itself');
        await bound.writeAudit({
            actorUserId: 'teacher-1',
            tenantId: 'tenant-1',
            action: 'progress_report.publish',
            resourceType: 'progress_report',
            resourceId: 'enrollment-1:course-1',
            oldValue: { state: 'draft', version: 2 },
            newValue: { state: 'published', version: 3 },
        });
        assert.equal(db.all('execute', 'INSERT INTO audit_events').length, 1);
        return result;
    });

    assert.equal(affected, 1);
    const update = db.all('execute', 'UPDATE progress_report_publications')[0];
    assert.ok(update);
    assert.match(update.sql, /WHERE tenant_id = \? AND student_enrollment_id = \? AND course_id = \? AND version = \?/);
    assert.deepEqual(update.params, [
        'published',
        'teacher-1',
        new Date('2026-10-21T10:00:00.000Z'),
        'tenant-1',
        'enrollment-1',
        'course-1',
        2,
    ]);
    const audit = db.all('execute', 'INSERT INTO audit_events')[0];
    assert.ok(audit);
    assert.equal(audit.connId, update.connId);
    assert.equal(db.connIds.size, 1);
    assert.equal(db.commits, 1);
});

test('service publish writes exactly one audit row, on the same connection as the transition', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM progress_report_publications')) return { rows: [publicationRow({ version: 2 })] };
        if (statement.sql.includes('UPDATE progress_report_publications')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);
    const transaction: PublicationTransaction = async (fn) => db.runner(async (conn) => {
        const bound = store.inTransaction(conn);
        return fn({ store: bound, audit: (input) => bound.writeAudit(input) });
    });
    const service = createProgressPublicationService({
        store,
        audit: async () => {},
        transaction,
        now: () => new Date('2026-10-21T10:00:00.000Z'),
    });

    const outcome = await service.publish({
        tenantId: 'tenant-1',
        studentEnrollmentId: 'enrollment-1',
        courseId: 'course-1',
        actorUserId: 'teacher-1',
    });

    assert.equal(outcome.kind, 'published');
    const audits = db.all('execute', 'INSERT INTO audit_events');
    assert.equal(audits.length, 1, 'exactly one audit row for publish');
    assert.equal(audits[0]?.params[1], 'progress_report.publish');
    assert.equal(db.connIds.size, 1);
});

test('service unpublish writes exactly one audit row, on the same connection as the transition', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM progress_report_publications')) return { rows: [publicationRow({ state: 'published', version: 2 })] };
        if (statement.sql.includes('UPDATE progress_report_publications')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);
    const transaction: PublicationTransaction = async (fn) => db.runner(async (conn) => {
        const bound = store.inTransaction(conn);
        return fn({ store: bound, audit: (input) => bound.writeAudit(input) });
    });
    const service = createProgressPublicationService({
        store,
        audit: async () => {},
        transaction,
        now: () => new Date('2026-10-21T10:00:00.000Z'),
    });

    const outcome = await service.unpublish({
        tenantId: 'tenant-1',
        studentEnrollmentId: 'enrollment-1',
        courseId: 'course-1',
        actorUserId: 'teacher-1',
    });

    assert.equal(outcome.kind, 'unpublished');
    const audits = db.all('execute', 'INSERT INTO audit_events');
    assert.equal(audits.length, 1, 'exactly one audit row for unpublish');
    assert.equal(audits[0]?.params[1], 'progress_report.unpublish');
    assert.equal(db.connIds.size, 1);
});

test('publication initial insert race: duplicate key re-read then CAS retry yields one row', async () => {
    let casCalls = 0;
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('UPDATE progress_report_publications')) {
            casCalls += 1;
            return { affectedRows: casCalls === 1 ? 0 : 1 };
        }
        if (statement.sql.includes('INSERT INTO progress_report_publications')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        if (statement.sql.includes('LIMIT 1')) return { rows: [publicationRow({ version: 0 })] };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const affected = await store.transitionPublication(transitionInput({ expectedVersion: 0, nextState: 'draft' }));

    assert.equal(affected, 1);
    assert.equal(casCalls, 2);
    assert.equal(db.all('execute', 'INSERT INTO progress_report_publications').length, 1);
    assert.equal(db.all('query', 'FROM progress_report_publications').length, 1);
    assert.equal(db.commits, 1);
});

test('publication initial insert loser does not overwrite a row created at a different version', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('UPDATE progress_report_publications')) return { affectedRows: 0 };
        if (statement.sql.includes('INSERT INTO progress_report_publications')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        if (statement.sql.includes('LIMIT 1')) return { rows: [publicationRow({ version: 3 })] };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const affected = await store.transitionPublication(transitionInput({ expectedVersion: 0 }));

    assert.equal(affected, 0);
    assert.equal(db.all('execute', 'INSERT INTO audit_events').length, 0);
    assert.equal(db.commits, 1);
});

test('publication wrong version returns 0 and writes no audit event', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('UPDATE progress_report_publications')) return { affectedRows: 0 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    assert.equal(await store.transitionPublication(transitionInput()), 0);
    assert.equal(db.all('execute', 'INSERT INTO audit_events').length, 0);
});

test('publication list is tenant-scoped, optionally course-scoped and capped', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM progress_report_publications')) {
            return {
                rows: [
                    publicationRow(),
                    publicationRow({ tenant_id: 'tenant-other', student_enrollment_id: 'foreign' }),
                ],
            };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const rows = await store.listPublications('tenant-1', 'course-1');

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tenantId, 'tenant-1');
    const query = db.statements[0];
    assert.ok(query);
    assert.match(query.sql, /WHERE tenant_id = \? AND course_id = \?/);
    assert.deepEqual(query.params, ['tenant-1', 'course-1', PROGRESS_PUBLICATION_LIST_CAP]);
});

test('publication rejects a non-safe expectedVersion before any SQL', async () => {
    const db = new RecordingDb(async () => {
        throw new Error('no SQL expected');
    });
    const store = createStore(db);

    await assert.rejects(
        store.transitionPublication(transitionInput({ expectedVersion: 2 ** 53 })),
        (error: unknown) => error instanceof ProgressPublicationSqlError && error.code === 'invalid_version',
    );
    assert.equal(db.statements.length, 0);
});

test('service audit failure rolls the publication state change back', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM progress_report_publications')) return { rows: [publicationRow({ version: 2 })] };
        if (statement.sql.includes('UPDATE progress_report_publications')) {
            db.state['state'] = 'published';
            return { affectedRows: 1 };
        }
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    db.state = { state: 'draft' };
    const audit: PublicationAuditSink = async (conn) => {
        await conn.execute('INSERT INTO audit_events (id) VALUES (?)', ['audit-1']);
        throw new Error('audit down');
    };
    const store = createStore(db, audit);
    const transaction: PublicationTransaction = async (fn) => db.runner(async (conn) => {
        const bound = store.inTransaction(conn);
        return fn({ store: bound, audit: (input) => bound.writeAudit(input) });
    });
    const service = createProgressPublicationService({
        store,
        audit: async () => {},
        transaction,
        now: () => new Date('2026-10-21T10:00:00.000Z'),
    });

    await assert.rejects(service.publish({
        tenantId: 'tenant-1',
        studentEnrollmentId: 'enrollment-1',
        courseId: 'course-1',
        actorUserId: 'teacher-1',
    }), /audit down/);
    assert.equal(db.rollbacks, 1);
    assert.equal(db.state['state'], 'draft');
});

// ---------------------------------------------------------------------------
// progress-report-source-sql
// ---------------------------------------------------------------------------

const enrollmentRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    student_enrollment_id: 'enrollment-1',
    course_id: 'course-1',
    course_name: 'Algebra',
    branch_id: 'branch-1',
    total_lessons: 4,
    completed_lessons: 3,
    ...overrides,
});

const scoreRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    student_enrollment_id: 'enrollment-1',
    course_id: 'course-1',
    category_id: null,
    item_type: 'exam',
    item_id: 'exam-1',
    score: 80,
    max_score: 100,
    weight: null,
    ...overrides,
});

test('report source construction fails fast without a transaction runner', () => {
    assert.throws(() => createProgressReportSourceSql({} as never), /transaction runner/);
});

test('report source applies tenant and branch as SQL constraints, never membership grants', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM students s')) return { rows: [enrollmentRow()] };
        if (statement.sql.includes('FROM gradebook_scores')) {
            return {
                rows: [
                    scoreRow(),
                    scoreRow({ item_id: 'exam-2', score: 90 }),
                    scoreRow({ item_type: 'assignment', item_id: 'assignment-1', score: 10, max_score: 20 }),
                ],
            };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const source = createProgressReportSourceSql({ transaction: db.runner });

    const result = await source.listRecordsResult({
        tenantId: 'tenant-1',
        courseIds: ['course-1'],
        branchId: 'branch-1',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    const record = result.value[0];
    assert.ok(record);
    assert.equal(record.completedLessons, 3);
    assert.equal(record.totalLessons, 4);
    assert.equal(record.examAverage, 85);
    assert.equal(record.assignmentAverage, 50);
    assert.equal(record.overall, null);

    const studentQuery = db.all('query', 'FROM students s')[0];
    assert.ok(studentQuery);
    assert.match(studentQuery.sql, /s\.tenant_id = \?/);
    assert.match(studentQuery.sql, /c\.tenant_id = \?/);
    assert.match(studentQuery.sql, /g\.branch_id = \?/);
    assert.ok(studentQuery.params.includes('tenant-1'));
    assert.ok(studentQuery.params.includes('branch-1'));
    assert.ok(!studentQuery.sql.includes('branch_memberships'));
    const scoreQuery = db.all('query', 'FROM gradebook_scores')[0];
    assert.ok(scoreQuery);
    assert.match(scoreQuery.sql, /tenant_id = \?/);
    assert.equal(db.connIds.size, 1);
});

test('report source maps a missing table to an explicit typed unavailable result', async () => {
    let calls = 0;
    const db = new RecordingDb(async (statement) => {
        calls += 1;
        if (statement.sql.includes('FROM students s')) {
            const error = new Error('missing table') as Error & { code: string; errno: number };
            error.code = 'ER_NO_SUCH_TABLE';
            error.errno = 1146;
            throw error;
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const source = createProgressReportSourceSql({ transaction: db.runner });
    const scope = { tenantId: 'tenant-1', courseIds: ['course-1'], branchId: null };

    const result = await source.listRecordsResult(scope);

    assert.deepEqual(result, { ok: false, code: 'unavailable', detail: 'ER_NO_SUCH_TABLE' });
    await assert.rejects(
        source.listRecords(scope),
        (error: unknown) => error instanceof ProgressReportSourceUnavailableError && error.code === 'unavailable',
    );
    assert.equal(calls, 2);
    assert.ok(db.all('query', 'FROM students s').every((statement) => statement.params[0] === 'tenant-1'));
});

test('report source returns null for an out-of-scope enrollment without a scores query', async () => {
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM students s')) return { rows: [] };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const source = createProgressReportSourceSql({ transaction: db.runner });

    const result = await source.findRecordResult('tenant-1', 'enrollment-missing', 'course-1');

    assert.deepEqual(result, { ok: true, value: null });
    assert.equal(db.all('query', 'FROM gradebook_scores').length, 0);
    const query = db.statements[0];
    assert.ok(query);
    assert.match(query.sql, /s\.id = \?/);
    assert.deepEqual(query.params.slice(-2), ['enrollment-missing', PROGRESS_REPORT_SOURCE_MAX_ROWS + 1]);
});

test('record-list cap: exactly at the cap is complete', async () => {
    const rows = Array.from({ length: PROGRESS_REPORT_SOURCE_MAX_ROWS }, (_, index) => enrollmentRow({
        student_enrollment_id: `enrollment-${index}`,
    }));
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM students s')) return { rows };
        if (statement.sql.includes('FROM gradebook_scores')) return { rows: [] };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const source = createProgressReportSourceSql({ transaction: db.runner });

    const result = await source.listRecordsResult({ tenantId: 'tenant-1', courseIds: ['course-1'], branchId: null });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, PROGRESS_REPORT_SOURCE_MAX_ROWS);
    assert.equal(db.all('query', 'FROM students s')[0]?.params.at(-1), PROGRESS_REPORT_SOURCE_MAX_ROWS + 1);
});

test('record-list cap: cap + 1 is incomplete and never a silently truncated list', async () => {
    const rows = Array.from({ length: PROGRESS_REPORT_SOURCE_MAX_ROWS + 1 }, (_, index) => enrollmentRow({
        student_enrollment_id: `enrollment-${index}`,
    }));
    const db = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM students s')) return { rows };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const source = createProgressReportSourceSql({ transaction: db.runner });

    const result = await source.listRecordsResult({ tenantId: 'tenant-1', courseIds: ['course-1'], branchId: null });

    assert.deepEqual(result, {
        ok: false,
        code: 'incomplete',
        detail: `record list exceeded ${PROGRESS_REPORT_SOURCE_MAX_ROWS} rows`,
    });
    assert.equal(db.all('query', 'FROM gradebook_scores').length, 0, 'no partial aggregate from a truncated list');
});

test('score cap: exactly at the cap is complete, cap + 1 is incomplete', async () => {
    const exactScores = Array.from({ length: PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS }, (_, index) => scoreRow({
        item_id: `exam-${index}`,
        score: 80,
    }));
    const exactDb = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM students s')) return { rows: [enrollmentRow()] };
        if (statement.sql.includes('FROM gradebook_scores')) return { rows: exactScores };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const exact = await createProgressReportSourceSql({ transaction: exactDb.runner }).listRecordsResult({
        tenantId: 'tenant-1',
        courseIds: ['course-1'],
        branchId: null,
    });
    assert.equal(exact.ok, true);
    if (!exact.ok) return;
    assert.equal(exact.value[0]?.examAverage, 80);

    const overScores = [...exactScores, scoreRow({ item_id: 'exam-over', score: 100 })];
    const overDb = new RecordingDb(async (statement) => {
        if (statement.sql.includes('FROM students s')) return { rows: [enrollmentRow()] };
        if (statement.sql.includes('FROM gradebook_scores')) return { rows: overScores };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const over = await createProgressReportSourceSql({ transaction: overDb.runner }).listRecordsResult({
        tenantId: 'tenant-1',
        courseIds: ['course-1'],
        branchId: null,
    });
    assert.deepEqual(over, {
        ok: false,
        code: 'incomplete',
        detail: `score rows exceeded ${PROGRESS_REPORT_SOURCE_MAX_SCORE_ROWS}`,
    });
});

test('invalid COUNT values are a typed incomplete result, never coerced to zero', async () => {
    const invalidValues: unknown[] = [null, undefined, Number.NaN, -1, 1.5, 'abc', '1.5', '', Number.MAX_SAFE_INTEGER + 1];
    for (const invalid of invalidValues) {
        const db = new RecordingDb(async (statement) => {
            if (statement.sql.includes('FROM students s')) {
                return {
                    rows: [enrollmentRow({
                        total_lessons: invalid,
                        completed_lessons: 0,
                    })],
                };
            }
            if (statement.sql.includes('FROM gradebook_scores')) return { rows: [] };
            throw new Error(`unexpected SQL: ${statement.sql}`);
        });
        const source = createProgressReportSourceSql({ transaction: db.runner });
        const result = await source.listRecordsResult({ tenantId: 'tenant-1', courseIds: ['course-1'], branchId: null });
        assert.deepEqual(result, {
            ok: false,
            code: 'incomplete',
            detail: 'total_lessons count is invalid',
        });
    }
});

test('report source rejects an empty tenant before any SQL', async () => {
    const db = new RecordingDb(async () => {
        throw new Error('no SQL expected');
    });
    const source = createProgressReportSourceSql({ transaction: db.runner });

    await assert.rejects(
        source.listRecordsResult({ tenantId: '', courseIds: ['course-1'], branchId: null }),
        (error: unknown) => error instanceof ProgressReportSourceSqlError && error.code === 'invalid_scope',
    );
    assert.equal(db.statements.length, 0);
});
