/**
 * B2-C-PERSISTENCE adapter tests for `exam-manual-grading-sql.ts`.
 *
 * HONEST LIMIT: these tests verify the adapter's SQL text, bindings and
 * transaction discipline against a recording, in-memory connection seam. They
 * are NOT a MySQL run and do not prove MySQL lock ordering, FK/CHECK behaviour,
 * collation, or the 8.0.16+ prerequisite. The seam is never described as MySQL.
 *
 * SINGLE-WRITER CONTRACT: the adapter's mutations never write an audit row.
 * The route/service writer calls `writeAudit` on the transaction-bound handle;
 * these tests exercise that exact seam and assert one audit row on the same
 * connection, plus rollback when the audit writer fails.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ExamGradingSqlConnection,
    ExamManualGradingAuditSink,
    ExamManualGradingSqlBoundStore,
    ExamManualGradingSqlError,
    ExamManualGradingSqlStore,
    createExamManualGradingSqlStore,
} from '../src/services/exam-manual-grading-sql';

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

class RecordingConnection implements ExamGradingSqlConnection {
    constructor(readonly id: number, private readonly db: RecordingDb) {}

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
    lastConnId: number | null = null;
    private connectionSeq = 0;
    private committedCount = 0;

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

    readonly runner = async <T>(fn: (conn: ExamGradingSqlConnection) => Promise<T>): Promise<T> => {
        const snapshot = JSON.stringify(this.state);
        const conn = new RecordingConnection(++this.connectionSeq, this);
        this.lastConnId = conn.id;
        try {
            const result = await fn(conn);
            this.commits += 1;
            this.committedCount = this.statements.length;
            return result;
        } catch (error) {
            this.state = JSON.parse(snapshot) as Record<string, unknown>;
            this.rollbacks += 1;
            throw error;
        }
    };

    get committedStatements(): RecordedStatement[] {
        return this.statements.slice(0, this.committedCount);
    }

    allContain(fragment: string): RecordedStatement[] {
        return this.statements.filter((statement) => statement.sql.includes(fragment));
    }

    connIds(): Set<number> {
        return new Set(this.statements.map((statement) => statement.connId));
    }
}

const attemptRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'attempt-1',
    tenant_id: 'tenant-1',
    exam_id: 'exam-1',
    exam_version_id: 'version-1',
    student_enrollment_id: 'enrollment-1',
    student_user_id: 'student-user-1',
    status: 'pending_review',
    submitted_at: '2026-10-21T09:00:00.000Z',
    auto_score: '10.00',
    score: null,
    manual_required: 1,
    passing_points: '5.00',
    version: 5,
    reviewer_user_id: null,
    graded_at: null,
    passed: null,
    ...overrides,
});

/** Test double for the sealed writer: one INSERT on the caller's connection. */
const auditSink = (auditId = 'audit-1'): ExamManualGradingAuditSink => async (conn, _input) => {
    await conn.execute('INSERT INTO audit_events (id) VALUES (?)', [auditId]);
};

const baseDb = (handler: Handler): RecordingDb => new RecordingDb(handler);

const createStore = (
    db: RecordingDb,
    audit: ExamManualGradingAuditSink = auditSink(),
): ExamManualGradingSqlStore => createExamManualGradingSqlStore({
    transaction: db.runner,
    audit,
    idFactory: () => 'revision-id',
});

const appendInput = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 'tenant-1',
    attemptId: 'attempt-1',
    questionRef: 'question-1',
    revision: 1,
    awardedHundredths: 250,
    reviewerUserId: 'teacher-1',
    feedback: null as string | null,
    createdAt: '2026-10-21T10:00:00.000Z',
    expectedAttemptStatus: 'pending_review' as const,
    expectedAttemptVersion: 4,
    ...overrides,
});

const writeAnswerAudit = async (tx: ExamManualGradingSqlBoundStore, input: ReturnType<typeof appendInput>): Promise<void> => {
    await tx.writeAudit({
        actorUserId: input.reviewerUserId,
        tenantId: input.tenantId,
        action: 'exam_manual_grade.answer',
        resourceType: 'exam_attempt',
        resourceId: input.attemptId,
        oldValue: null,
        newValue: {
            question_ref: input.questionRef,
            revision: input.revision,
            awarded_hundredths: input.awardedHundredths,
            status: 'pending_review',
            attempt_version_after: input.expectedAttemptVersion + 1,
        },
    });
};

test('construction fails fast without a transaction runner', () => {
    assert.throws(
        () => createExamManualGradingSqlStore({ audit: auditSink() } as never),
        /transaction runner/,
    );
});

test('construction fails fast without the required audit writer before any write', () => {
    const db = baseDb(async () => {
        throw new Error('no SQL expected');
    });
    assert.throws(
        () => createExamManualGradingSqlStore({ transaction: db.runner } as never),
        (error: unknown) => error instanceof ExamManualGradingSqlError && error.code === 'invalid_audit',
    );
    assert.equal(db.statements.length, 0);
});

test('list pending is tenant- and authorized-exam-scoped in SQL', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('FROM exam_versioned_attempts a')) {
            return {
                rows: [
                    attemptRow(),
                    attemptRow({ id: 'attempt-foreign', tenant_id: 'tenant-other' }),
                ],
            };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const rows = await store.listPendingAttempts({ tenantId: 'tenant-1', examIds: ['exam-1', 'exam-2'], limit: 50 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 'attempt-1');
    const query = db.statements[0];
    assert.ok(query);
    assert.match(query.sql, /a\.tenant_id = \?/);
    assert.match(query.sql, /a\.status = 'pending_review'/);
    assert.match(query.sql, /a\.exam_id IN \(\?, \?\)/);
    assert.deepEqual(query.params, ['tenant-1', 'exam-1', 'exam-2', 50]);
    assert.equal(db.connIds().size, 1);
});

test('append CAS loss returns attempt_version_conflict and writes nothing', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('SET version = version + 1')) return { affectedRows: 0 };
        if (statement.sql.includes('SELECT status, version FROM exam_versioned_attempts')) {
            return { rows: [{ status: 'pending_review', version: 5 }] };
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const result = await store.appendAnswerGradeRevision(appendInput());

    assert.deepEqual(result, { ok: false, reason: 'attempt_version_conflict' });
    assert.equal(db.allContain('INSERT INTO exam_manual_answer_revisions').length, 0);
    assert.equal(db.allContain('INSERT INTO audit_events').length, 0);
    assert.equal(db.rollbacks, 0);
});

test('append success writes the state change, no implicit audit, then exactly one explicit audit on the same conn', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('SET version = version + 1')) {
            db.state['version'] = Number(db.state['version'] ?? 4) + 1;
            return { affectedRows: 1 };
        }
        if (statement.sql.includes('INSERT INTO exam_manual_answer_revisions')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    db.state = { version: 4 };
    const store = createStore(db);
    const input = appendInput({ revision: 3, feedback: 'good' });

    const result = await db.runner(async (conn) => {
        const tx = store.inTransaction(conn);
        const appended = await tx.appendAnswerGradeRevision(input);
        assert.deepEqual(appended, { ok: true, newAttemptVersion: 5 });
        assert.equal(db.allContain('INSERT INTO audit_events').length, 0, 'adapter must not audit by itself');
        await writeAnswerAudit(tx, input);
        assert.equal(db.allContain('INSERT INTO audit_events').length, 1, 'exactly one writer, one row');
        return appended;
    });

    assert.deepEqual(result, { ok: true, newAttemptVersion: 5 });
    const cas = db.allContain('SET version = version + 1')[0];
    assert.ok(cas);
    assert.match(cas.sql, /WHERE id = \? AND tenant_id = \? AND status = \? AND version = \?/);
    assert.deepEqual(cas.params, ['attempt-1', 'tenant-1', 'pending_review', 4]);
    const revision = db.allContain('INSERT INTO exam_manual_answer_revisions')[0];
    assert.ok(revision);
    assert.deepEqual(revision.params.slice(0, 6), ['revision-id', 'tenant-1', 'attempt-1', 'question-1', 3, 250]);
    assert.equal(db.connIds().size, 1);
    assert.equal(db.commits, 1);
});

test('duplicate revision rolls the attempt version bump back', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('SET version = version + 1')) {
            db.state['version'] = 5;
            return { affectedRows: 1 };
        }
        if (statement.sql.includes('INSERT INTO exam_manual_answer_revisions')) {
            const error = new Error('duplicate') as Error & { code: string };
            error.code = 'ER_DUP_ENTRY';
            throw error;
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    db.state = { version: 4 };
    const store = createStore(db);

    const result = await store.appendAnswerGradeRevision(appendInput());

    assert.deepEqual(result, { ok: false, reason: 'duplicate_revision' });
    assert.equal(db.rollbacks, 1);
    assert.equal(db.state['version'], 4);
    assert.equal(db.allContain('INSERT INTO audit_events').length, 0);
});

test('revision race: the loser of the same expected version maps to conflict without an insert', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('SET version = version + 1')) {
            if (db.state['version'] === statement.params[3]) {
                db.state['version'] = Number(db.state['version']) + 1;
                return { affectedRows: 1 };
            }
            return { affectedRows: 0 };
        }
        if (statement.sql.includes('SELECT status, version FROM exam_versioned_attempts')) {
            return { rows: [{ status: 'pending_review', version: db.state['version'] }] };
        }
        if (statement.sql.includes('INSERT INTO exam_manual_answer_revisions')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    db.state = { version: 4 };
    const store = createStore(db);
    const input = appendInput();

    const first = await db.runner(async (conn) => {
        const tx = store.inTransaction(conn);
        const result = await tx.appendAnswerGradeRevision(input);
        await writeAnswerAudit(tx, input);
        return result;
    });
    const second = await store.appendAnswerGradeRevision(input);

    assert.deepEqual(first, { ok: true, newAttemptVersion: 5 });
    assert.deepEqual(second, { ok: false, reason: 'attempt_version_conflict' });
    assert.equal(db.allContain('INSERT INTO exam_manual_answer_revisions').length, 1);
    assert.equal(db.allContain('INSERT INTO audit_events').length, 1);
});

test('finalize locks the attempt first, re-reads revisions on the same connection, then CASes', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('LIMIT 1 FOR UPDATE')) {
            return { rows: [attemptRow({ version: 7 })] };
        }
        if (statement.sql.includes('FROM exam_manual_answer_revisions') && statement.sql.includes('FOR UPDATE')) {
            return {
                rows: [
                    { question_ref: 'q-1', revision: 2, awarded_hundredths: 300, reviewer_user_id: 'teacher-1', feedback: null, created_at: '2026-10-21T09:30:00.000Z' },
                    { question_ref: 'q-1', revision: 1, awarded_hundredths: 200, reviewer_user_id: 'teacher-1', feedback: null, created_at: '2026-10-21T09:00:00.000Z' },
                ],
            };
        }
        if (statement.sql.includes("SET status = 'graded'")) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const result = await db.runner(async (conn) => {
        const tx = store.inTransaction(conn);
        const finalized = await tx.finalizeAttempt({
            tenantId: 'tenant-1',
            attemptId: 'attempt-1',
            expectedAttemptStatus: 'pending_review',
            expectedVersion: 7,
            scoreHundredths: 1250,
            passed: true,
            reviewerUserId: 'teacher-1',
            gradedAt: '2026-10-21T10:00:00.000Z',
        });
        assert.deepEqual(finalized, { ok: true, newAttemptVersion: 8 });
        assert.equal(db.allContain('INSERT INTO audit_events').length, 0, 'adapter must not audit by itself');
        await tx.writeAudit({
            actorUserId: 'teacher-1',
            tenantId: 'tenant-1',
            action: 'exam_manual_grade.finalize',
            resourceType: 'exam_attempt',
            resourceId: 'attempt-1',
            oldValue: { status: 'pending_review', version: 7 },
            newValue: { status: 'graded', score_hundredths: 1250, passed: true, included_latest_revisions: [{ question_ref: 'q-1', revision: 2 }], version: 8 },
        });
        assert.equal(db.allContain('INSERT INTO audit_events').length, 1);
        return finalized;
    });

    assert.deepEqual(result, { ok: true, newAttemptVersion: 8 });
    const attemptIndex = db.statements.findIndex((statement) => statement.sql.includes('LIMIT 1 FOR UPDATE'));
    const revisionIndex = db.statements.findIndex((statement) => statement.sql.includes('FOR UPDATE')
        && statement.sql.includes('FROM exam_manual_answer_revisions'));
    const updateIndex = db.statements.findIndex((statement) => statement.sql.includes("SET status = 'graded'"));
    const auditIndex = db.statements.findIndex((statement) => statement.sql.includes('INSERT INTO audit_events'));
    assert.ok(attemptIndex >= 0 && attemptIndex < revisionIndex && revisionIndex < updateIndex && updateIndex < auditIndex);
    assert.match(db.statements[revisionIndex]?.sql ?? '', /ORDER BY question_ref ASC, revision DESC/);
    const update = db.statements[updateIndex];
    assert.ok(update);
    assert.match(update.sql, /WHERE id = \? AND tenant_id = \? AND status = \? AND version = \?/);
    assert.deepEqual(update.params, ['12.50', 1, 'teacher-1', '2026-10-21T10:00:00.000Z', 'attempt-1', 'tenant-1', 'pending_review', 7]);
    assert.equal(db.connIds().size, 1);
});

test('finalize conflicts when a revision moves the version after the in-transaction re-read', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('LIMIT 1 FOR UPDATE')) return { rows: [attemptRow({ version: 3 })] };
        if (statement.sql.includes('FROM exam_manual_answer_revisions') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [] };
        }
        if (statement.sql.includes("SET status = 'graded'")) return { affectedRows: 0 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    const result = await store.finalizeAttempt({
        tenantId: 'tenant-1',
        attemptId: 'attempt-1',
        expectedAttemptStatus: 'pending_review',
        expectedVersion: 3,
        scoreHundredths: 100,
        passed: null,
        reviewerUserId: 'teacher-1',
        gradedAt: '2026-10-21T10:00:00.000Z',
    });

    assert.deepEqual(result, { ok: false, reason: 'attempt_version_conflict' });
    assert.equal(db.allContain('INSERT INTO audit_events').length, 0);
});

test('audit failure after the state change rolls back every write and the revision row', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('SET version = version + 1')) {
            db.state['version'] = 5;
            return { affectedRows: 1 };
        }
        if (statement.sql.includes('INSERT INTO exam_manual_answer_revisions')) {
            db.state['revision'] = 1;
            return { affectedRows: 1 };
        }
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    db.state = { version: 4 };
    const audit: ExamManualGradingAuditSink = async (conn) => {
        await conn.execute('INSERT INTO audit_events (id) VALUES (?)', ['audit-1']);
        throw new Error('audit down');
    };
    const store = createStore(db, audit);
    const input = appendInput();

    await assert.rejects(
        db.runner(async (conn) => {
            const tx = store.inTransaction(conn);
            const result = await tx.appendAnswerGradeRevision(input);
            assert.equal(result.ok, true);
            await writeAnswerAudit(tx, input);
        }),
        /audit down/,
    );
    assert.equal(db.rollbacks, 1);
    assert.equal(db.state['version'], 4);
    assert.equal(db.state['revision'], undefined);
});

test('the audit writer is bound to the transaction connection and a foreign conn is detectable', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('SET version = version + 1')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO exam_manual_answer_revisions')) return { affectedRows: 1 };
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const audit: ExamManualGradingAuditSink = async (conn) => {
        assert.ok(conn instanceof RecordingConnection);
        assert.equal(conn.id, db.lastConnId, 'the audit writer must receive the transaction connection');
        await conn.execute('INSERT INTO audit_events (id) VALUES (?)', ['audit-1']);
    };
    const store = createStore(db, audit);
    const input = appendInput();

    await db.runner(async (conn) => {
        const tx = store.inTransaction(conn);
        await tx.appendAnswerGradeRevision(input);
        await writeAnswerAudit(tx, input);
    });

    assert.deepEqual([...db.connIds()], [db.lastConnId]);
});

test('finalize audit failure rolls the finalized state back', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('LIMIT 1 FOR UPDATE')) return { rows: [attemptRow({ version: 7 })] };
        if (statement.sql.includes('FROM exam_manual_answer_revisions') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [] };
        }
        if (statement.sql.includes("SET status = 'graded'")) {
            db.state['status'] = 'graded';
            return { affectedRows: 1 };
        }
        if (statement.sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    db.state = { status: 'pending_review', version: 7 };
    const audit: ExamManualGradingAuditSink = async (conn) => {
        await conn.execute('INSERT INTO audit_events (id) VALUES (?)', ['audit-1']);
        throw new Error('audit down');
    };
    const store = createStore(db, audit);

    await assert.rejects(
        db.runner(async (conn) => {
            const tx = store.inTransaction(conn);
            const result = await tx.finalizeAttempt({
                tenantId: 'tenant-1',
                attemptId: 'attempt-1',
                expectedAttemptStatus: 'pending_review',
                expectedVersion: 7,
                scoreHundredths: 1250,
                passed: true,
                reviewerUserId: 'teacher-1',
                gradedAt: '2026-10-21T10:00:00.000Z',
            });
            assert.equal(result.ok, true);
            await tx.writeAudit({
                actorUserId: 'teacher-1',
                tenantId: 'tenant-1',
                action: 'exam_manual_grade.finalize',
                resourceType: 'exam_attempt',
                resourceId: 'attempt-1',
                oldValue: { status: 'pending_review', version: 7 },
                newValue: { status: 'graded', score_hundredths: 1250, passed: true, version: 8 },
            });
        }),
        /audit down/,
    );
    assert.equal(db.rollbacks, 1);
    assert.equal(db.state['status'], 'pending_review');
});

const fkError = (constraint: string): Error => {
    const error = new Error(
        `Cannot add or update a child row: a foreign key constraint fails (\`db\`.\`table\`, CONSTRAINT \`${constraint}\` FOREIGN KEY (\`x\`) REFERENCES \`y\` (\`id\`))`,
    ) as Error & { code: string; sqlMessage: string };
    error.code = 'ER_NO_REFERENCED_ROW_2';
    error.sqlMessage = error.message;
    return error;
};

const rejectingOnRevisionFk = (constraint: string): RecordingDb => baseDb(async (statement) => {
    if (statement.sql.includes('SET version = version + 1')) return { affectedRows: 1 };
    if (statement.sql.includes('INSERT INTO exam_manual_answer_revisions')) throw fkError(constraint);
    if (statement.sql.includes('SELECT status, version FROM exam_versioned_attempts')) {
        return { rows: [{ status: 'pending_review', version: 5 }] };
    }
    throw new Error(`unexpected SQL: ${statement.sql}`);
});

test('FK mapping: answer constraint is answer_not_found', async () => {
    const store = createStore(rejectingOnRevisionFk('fk_manual_revision_answer'));
    await assert.rejects(
        store.appendAnswerGradeRevision(appendInput({ questionRef: 'missing-question' })),
        (error: unknown) => error instanceof ExamManualGradingSqlError && error.code === 'answer_not_found',
    );
});

test('FK mapping: attempt constraint is attempt_not_found, never answer_not_found', async () => {
    const store = createStore(rejectingOnRevisionFk('fk_manual_revision_attempt'));
    await assert.rejects(
        store.appendAnswerGradeRevision(appendInput()),
        (error: unknown) => error instanceof ExamManualGradingSqlError && error.code === 'attempt_not_found',
    );
});

test('FK mapping: reviewer constraint is reviewer_not_found', async () => {
    const store = createStore(rejectingOnRevisionFk('fk_manual_revision_reviewer'));
    await assert.rejects(
        store.appendAnswerGradeRevision(appendInput()),
        (error: unknown) => error instanceof ExamManualGradingSqlError && error.code === 'reviewer_not_found',
    );
});

test('FK mapping: tenant constraint is tenant_not_found', async () => {
    const store = createStore(rejectingOnRevisionFk('fk_manual_revision_tenant'));
    await assert.rejects(
        store.appendAnswerGradeRevision(appendInput()),
        (error: unknown) => error instanceof ExamManualGradingSqlError && error.code === 'tenant_not_found',
    );
});

test('FK mapping: unknown constraint stays a generic typed error, never answer_not_found', async () => {
    const store = createStore(rejectingOnRevisionFk('fk_some_future_constraint'));
    await assert.rejects(
        store.appendAnswerGradeRevision(appendInput()),
        (error: unknown) => error instanceof ExamManualGradingSqlError
            && error.code === 'foreign_key_violation'
            && /fk_some_future_constraint/.test(error.message),
    );
});

test('FK mapping: finalize reviewer constraint is reviewer_not_found', async () => {
    const db = baseDb(async (statement) => {
        if (statement.sql.includes('LIMIT 1 FOR UPDATE')) return { rows: [attemptRow({ version: 7 })] };
        if (statement.sql.includes('FROM exam_manual_answer_revisions') && statement.sql.includes('FOR UPDATE')) {
            return { rows: [] };
        }
        if (statement.sql.includes("SET status = 'graded'")) {
            throw fkError('fk_exam_attempts_reviewer');
        }
        throw new Error(`unexpected SQL: ${statement.sql}`);
    });
    const store = createStore(db);

    await assert.rejects(
        store.finalizeAttempt({
            tenantId: 'tenant-1',
            attemptId: 'attempt-1',
            expectedAttemptStatus: 'pending_review',
            expectedVersion: 7,
            scoreHundredths: 1250,
            passed: true,
            reviewerUserId: 'missing-teacher',
            gradedAt: '2026-10-21T10:00:00.000Z',
        }),
        (error: unknown) => error instanceof ExamManualGradingSqlError && error.code === 'reviewer_not_found',
    );
});
