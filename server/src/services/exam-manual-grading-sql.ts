/**
 * B2-C-PERSISTENCE — real SQL adapter for `ManualGradingStore`.
 *
 * This file contains SOURCE CODE ONLY. Nothing here connects to a database, is
 * imported by production wiring, or proves that migration
 * `20261021_01_exam_manual_publication.sql` was applied. Every statement is
 * issued through the caller-injected connection-bound transaction runner, so a
 * unit of work (CAS, revision INSERT, audit) uses exactly one connection. There
 * is deliberately no pooled query and no autocommit fallback: a missing runner
 * is rejected at construction.
 *
 * Schema used (read-only inputs):
 *  - `exam_versioned_attempts` (existing status/version/score/passed/graded_at,
 *    plus the new nullable `reviewer_user_id`)
 *  - `exam_versioned_answers` (existing per-question rows; never updated here)
 *  - `exam_manual_answer_revisions` (append-only revision history, UNIQUE
 *    `(attempt_id, question_ref, revision)`)
 *
 * The adapter does not compute a final total: the C1a router recomputes it from
 * the in-transaction re-read and passes `scoreHundredths`. The adapter re-reads
 * the attempt row with `FOR UPDATE` and then the revision rows on that same
 * connection, and writes the total with the version CAS. Any revision that
 * commits before the re-read is visible; one that commits after moves the
 * attempt version and loses the CAS.
 */

import { randomUUID } from 'node:crypto';
import { formatHundredths, toHundredths } from './exam-grading';
import { deterministicScoreId } from './gradebook';
import {
    AppendAnswerGradeRevisionInput,
    DEFAULT_PENDING_LIMIT,
    ExamGradebookProjectionInput,
    ExamGradebookProjectionResult,
    FinalizeAttemptInput,
    ListPendingAttemptsInput,
    MAX_PENDING_LIMIT,
    ManualAnswerRow,
    ManualGradeRevisionRow,
    ManualGradingAttemptBundle,
    ManualGradingStore,
    PendingManualAttemptRow,
    PinnedQuestionRow,
    StoreAppendResult,
    StoreFinalizeResult,
    normalizeAttemptVersion,
} from './exam-manual-grading';

/** The minimal connection surface this adapter needs (mysql2 compatible). */
export interface ExamGradingSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    execute(
        sql: string,
        params?: readonly unknown[],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }>;
}

/**
 * Connection-bound transaction seam. Production binds `db.withTransaction`;
 * tests bind a recording seam. Every statement of one unit of work runs on the
 * exact `conn` object passed to the callback.
 */
export type ExamGradingTransactionRunner = <T>(
    fn: (conn: ExamGradingSqlConnection) => Promise<T>,
) => Promise<T>;

export interface ExamManualGradingAuditInput {
    actorUserId: string;
    tenantId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
}

/**
 * Audit writer bound to the SAME connection as the mutation. There is no
 * default implementation: production MUST inject a sealed writer (for example
 * `recordSealedAuditEvent` from `services/audit-log.ts`) and the adapter calls
 * it only through `writeAudit`, which is bound to the transaction connection.
 *
 * SINGLE-WRITER CONTRACT: the domain service/route layer is the only writer for
 * `exam_manual_grade.answer` and `exam_manual_grade.finalize`. The adapter's
 * mutation methods never write an audit row themselves; the caller invokes
 * `writeAudit` through the transaction-bound handle after a successful state
 * change, inside the same transaction. This makes a second (double) audit
 * impossible and keeps the audit row on the exact same `conn`.
 */
export type ExamManualGradingAuditSink = (
    conn: ExamGradingSqlConnection,
    input: ExamManualGradingAuditInput,
) => Promise<void>;

/** Connection-bound audit writer exposed to the single (domain/route) writer. */
export interface ExamManualGradingAuditExecutor {
    writeAudit(input: ExamManualGradingAuditInput): Promise<void>;
}

export interface ExamManualGradingSqlBoundStore extends ManualGradingStore, ExamManualGradingAuditExecutor {}

export interface ExamManualGradingSqlDeps {
    transaction: ExamGradingTransactionRunner;
    /** REQUIRED sealed, connection-bound writer; no default exists. */
    audit: ExamManualGradingAuditSink;
    idFactory?: () => string;
}

export type ExamManualGradingSqlErrorCode =
    | 'invalid_runner'
    | 'invalid_audit'
    | 'invalid_attempt_row'
    | 'answer_not_found'
    | 'attempt_not_found'
    | 'reviewer_not_found'
    | 'tenant_not_found'
    | 'foreign_key_violation';

export class ExamManualGradingSqlError extends Error {
    constructor(
        public readonly code: ExamManualGradingSqlErrorCode,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ExamManualGradingSqlError';
    }
}

export interface ExamManualGradingSqlStore extends ManualGradingStore {
    /** Bind every method plus the audit executor to one open transaction. */
    inTransaction(conn: ExamGradingSqlConnection): ExamManualGradingSqlBoundStore;
}

interface AttemptRowDb {
    id: string;
    tenant_id: string;
    exam_id: string;
    exam_version_id: string;
    student_enrollment_id: string;
    student_user_id: string;
    status: string;
    submitted_at: string | Date | null;
    auto_score: number | string | null;
    score: number | string | null;
    manual_required: boolean | number;
    passing_points: number | string | null;
    version: number | string;
    reviewer_user_id?: string | null;
    graded_at?: string | Date | null;
    passed?: boolean | number | null;
    total_points?: number | string | null;
}

interface QuestionRowDb {
    ref: string;
    position: number | string;
    question_type: string;
    points: number | string;
}

interface AnswerRowDb {
    question_ref: string;
    question_type: string;
    response: unknown;
    awarded_points: number | string | null;
    is_correct: boolean | number | null;
    manual_review: boolean | number;
}

interface RevisionRowDb {
    question_ref: string;
    revision: number | string;
    awarded_hundredths: number | string;
    reviewer_user_id: string;
    feedback: string | null;
    created_at: string | Date;
}

const ATTEMPT_COLUMNS = `a.id, a.tenant_id, a.exam_id, a.exam_version_id,
    a.student_enrollment_id, a.student_user_id, a.status, a.submitted_at,
    a.auto_score, a.score, a.manual_required, a.version,
    a.reviewer_user_id, a.graded_at, a.passed, v.total_points`;

const PENDING_SELECT = `SELECT ${ATTEMPT_COLUMNS}, v.passing_points
    FROM exam_versioned_attempts a
    INNER JOIN exam_versions v ON v.id = a.exam_version_id AND v.tenant_id = a.tenant_id
    WHERE a.tenant_id = ? AND a.status = 'pending_review'
      AND a.exam_id IN`;
const PENDING_ORDER = 'ORDER BY a.submitted_at ASC, a.id ASC LIMIT ?';

const ATTEMPT_SELECT = `SELECT ${ATTEMPT_COLUMNS}, v.passing_points
    FROM exam_versioned_attempts a
    INNER JOIN exam_versions v ON v.id = a.exam_version_id AND v.tenant_id = a.tenant_id
    WHERE a.id = ? AND a.tenant_id = ? LIMIT 1`;

const ATTEMPT_FOR_UPDATE_SELECT = `SELECT ${ATTEMPT_COLUMNS}, v.passing_points
    FROM exam_versioned_attempts a
    INNER JOIN exam_versions v ON v.id = a.exam_version_id AND v.tenant_id = a.tenant_id
    WHERE a.id = ? AND a.tenant_id = ? LIMIT 1 FOR UPDATE`;

const LATEST_REVISIONS_SELECT = `SELECT r.question_ref, r.revision, r.awarded_hundredths,
        r.reviewer_user_id, r.feedback, r.created_at
    FROM exam_manual_answer_revisions r
    INNER JOIN (
        SELECT question_ref, MAX(revision) AS max_revision
        FROM exam_manual_answer_revisions
        WHERE tenant_id = ? AND attempt_id = ?
        GROUP BY question_ref
    ) m ON m.question_ref = r.question_ref AND m.max_revision = r.revision
    WHERE r.tenant_id = ? AND r.attempt_id = ?
    ORDER BY r.question_ref ASC`;

const REVISIONS_FOR_UPDATE_SELECT = `SELECT question_ref, revision, awarded_hundredths,
        reviewer_user_id, feedback, created_at
    FROM exam_manual_answer_revisions
    WHERE tenant_id = ? AND attempt_id = ?
    ORDER BY question_ref ASC, revision DESC
    FOR UPDATE`;

const QUESTIONS_SELECT = `SELECT id AS ref, position, question_type, points
    FROM exam_version_questions
    WHERE tenant_id = ? AND exam_version_id = ?
    ORDER BY position ASC`;

const ANSWERS_SELECT = `SELECT question_ref, question_type, response, awarded_points,
        is_correct, manual_review
    FROM exam_versioned_answers
    WHERE tenant_id = ? AND attempt_id = ?
    ORDER BY question_ref ASC`;

const CAS_BUMP = `UPDATE exam_versioned_attempts
    SET version = version + 1
    WHERE id = ? AND tenant_id = ? AND status = ? AND version = ?`;

const CASE_STATE_SELECT = 'SELECT status, version FROM exam_versioned_attempts WHERE id = ? AND tenant_id = ? LIMIT 1';

const FINALIZE_UPDATE = `UPDATE exam_versioned_attempts
    SET status = 'graded', score = ?, passed = ?, reviewer_user_id = ?, graded_at = ?,
        version = version + 1
    WHERE id = ? AND tenant_id = ? AND status = ? AND version = ?`;

const REVISION_INSERT = `INSERT INTO exam_manual_answer_revisions
    (id, tenant_id, attempt_id, question_ref, revision, awarded_hundredths,
     reviewer_user_id, feedback, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/*
 * C1-R gradebook link. The exam's course is resolved from the server rows
 * (`exams.course_id` joined to a tenant-owned course); the enrollment is
 * re-proven to belong to that course before any grade is written, so a
 * finalized attempt can never create a grade in a course its student is not
 * enrolled in. All statements run on the caller's transaction connection.
 */
const EXAM_COURSE_SELECT = `SELECT e.course_id
    FROM exams e INNER JOIN courses c ON c.id = e.course_id
    WHERE e.id = ? AND c.tenant_id = ? LIMIT 1`;

const ENROLLMENT_IN_COURSE_SELECT = `SELECT s.id FROM students s
      LEFT JOIN \`groups\` g ON g.id = s.group_id
      LEFT JOIN student_courses sc ON sc.student_id = s.id AND sc.course_id = ? AND sc.status='active'
     WHERE s.id = ? AND s.tenant_id = ? AND (g.course_id = ? OR sc.course_id IS NOT NULL) LIMIT 1`;

const GRADEBOOK_SCORE_SELECT = `SELECT id, score, max_score
    FROM gradebook_scores WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE`;

const GRADEBOOK_SCORE_INSERT = `INSERT INTO gradebook_scores
    (id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id,
     score, max_score, weight, recorded_by)
    VALUES (?, ?, ?, ?, NULL, 'exam', ?, ?, ?, NULL, ?)`;

const GRADEBOOK_SCORE_UPDATE = `UPDATE gradebook_scores
    SET score = ?, max_score = ?, recorded_by = ?, recorded_at = CURRENT_TIMESTAMP
    WHERE id = ? AND tenant_id = ?`;

const affectedRowsOf = (result: { affectedRows?: number | string }): number => {
    const raw = result.affectedRows;
    if (raw === undefined) {
        throw new Error('exam-manual-grading-sql update did not report an affected-row count');
    }
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error('exam-manual-grading-sql affected-row count was not a safe integer');
    }
    return value;
};

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const isForeignKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2');
};

/**
 * Constraint names from migration `20261021_01_exam_manual_publication.sql`.
 * A proven cause gets its own typed reason; an unknown name is never relabelled
 * as `answer_not_found`.
 */
const FK_REASON_BY_CONSTRAINT: Readonly<Record<string, ExamManualGradingSqlErrorCode>> = {
    fk_manual_revision_answer: 'answer_not_found',
    fk_manual_revision_attempt: 'attempt_not_found',
    fk_manual_revision_reviewer: 'reviewer_not_found',
    fk_manual_revision_tenant: 'tenant_not_found',
    fk_exam_attempts_reviewer: 'reviewer_not_found',
};

const FK_HUMAN_MESSAGE: Readonly<Partial<Record<ExamManualGradingSqlErrorCode, string>>> = {
    answer_not_found: 'the attempt has no answer row for the requested question_ref (foreign key)',
    attempt_not_found: 'the referenced attempt does not exist (foreign key)',
    reviewer_not_found: 'the reviewer user does not exist (foreign key)',
    tenant_not_found: 'the referenced tenant does not exist (foreign key)',
};

const constraintNameOf = (error: unknown): string | null => {
    if (typeof error !== 'object' || error === null) return null;
    const explicit = (error as { constraint?: unknown }).constraint;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const sqlMessage = (error as { sqlMessage?: unknown }).sqlMessage;
    const message = (error as { message?: unknown }).message;
    const text = typeof sqlMessage === 'string' ? sqlMessage : (typeof message === 'string' ? message : '');
    const match = /CONSTRAINT\s+[`"]([A-Za-z0-9_]+)[`"]/.exec(text)
        ?? /CONSTRAINT\s+([A-Za-z0-9_]+)\b/.exec(text);
    return match?.[1] ?? null;
};

/** Map a proven FK failure to its typed reason; unknown names stay generic. */
const classifyForeignKeyError = (error: unknown): ExamManualGradingSqlError => {
    const constraint = constraintNameOf(error);
    const reason = constraint === null ? undefined : FK_REASON_BY_CONSTRAINT[constraint];
    if (reason !== undefined) {
        return new ExamManualGradingSqlError(
            reason,
            FK_HUMAN_MESSAGE[reason] ?? `foreign key ${constraint} failed`,
            error,
        );
    }
    return new ExamManualGradingSqlError(
        'foreign_key_violation',
        `unrecognized foreign key constraint ${constraint ?? '(unnamed)'} failed`,
        error,
    );
};

const toIso = (value: string | Date | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
};

const asRecord = <T extends Record<string, unknown>>(row: T): T => row;

const mapAttempt = (row: AttemptRowDb): PendingManualAttemptRow => ({
    id: row.id,
    tenant_id: row.tenant_id,
    exam_id: row.exam_id,
    exam_version_id: row.exam_version_id,
    student_enrollment_id: row.student_enrollment_id,
    student_user_id: row.student_user_id,
    status: row.status,
    submitted_at: row.submitted_at,
    auto_score: row.auto_score,
    score: row.score,
    manual_required: row.manual_required,
    passing_points: row.passing_points,
    version: row.version,
    reviewer_user_id: row.reviewer_user_id ?? null,
    graded_at: row.graded_at ?? null,
    passed: row.passed ?? null,
    total_points: row.total_points ?? null,
});

const safelyNormalizedVersion = (value: number | string, context: string): number => {
    const normalized = normalizeAttemptVersion(value);
    if (normalized === null) {
        throw new ExamManualGradingSqlError('invalid_attempt_row', `${context} has an invalid version`);
    }
    return normalized;
};

const mapRevision = (row: RevisionRowDb): ManualGradeRevisionRow => {
    const revision = typeof row.revision === 'string' ? Number(row.revision) : row.revision;
    const awarded = typeof row.awarded_hundredths === 'string' ? Number(row.awarded_hundredths) : row.awarded_hundredths;
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(awarded)) {
        throw new ExamManualGradingSqlError('invalid_attempt_row', 'an answer revision row is outside the safe integer range');
    }
    return {
        question_ref: row.question_ref,
        revision,
        awarded_hundredths: awarded,
        reviewer_user_id: row.reviewer_user_id,
        feedback: row.feedback,
        created_at: row.created_at,
    };
};

const latestByQuestion = (rows: readonly RevisionRowDb[]): ManualGradeRevisionRow[] => {
    const seen = new Set<string>();
    const latest: ManualGradeRevisionRow[] = [];
    for (const raw of rows) {
        const row = mapRevision(raw);
        if (seen.has(row.question_ref)) continue;
        seen.add(row.question_ref);
        latest.push(row);
    }
    return latest;
};

const clampListLimit = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_PENDING_LIMIT;
    return Math.min(value, MAX_PENDING_LIMIT);
};

/** Outcome rollback carrier: the transaction MUST roll back the prior CAS bump. */
class AppendRollback extends Error {
    constructor(public readonly result: StoreAppendResult) {
        super('exam manual grading append requires rollback');
        this.name = 'AppendRollback';
    }
}

class ExamManualGradingSqlTransaction implements ExamManualGradingSqlBoundStore {
    constructor(
        private readonly conn: ExamGradingSqlConnection,
        private readonly deps: Required<Pick<ExamManualGradingSqlDeps, 'audit' | 'idFactory'>>,
    ) {}

    /** The ONLY audit path: the required sealed writer, on this transaction's conn. */
    async writeAudit(input: ExamManualGradingAuditInput): Promise<void> {
        await this.deps.audit(this.conn, input);
    }

    async listPendingAttempts(input: ListPendingAttemptsInput): Promise<PendingManualAttemptRow[]> {
        const examIds = Array.from(new Set(input.examIds.filter((id) => typeof id === 'string' && id.length > 0)));
        if (examIds.length === 0) return [];
        const placeholders = examIds.map(() => '?').join(', ');
        const rows = await this.conn.query<AttemptRowDb>(
            `${PENDING_SELECT} (${placeholders}) ${PENDING_ORDER}`,
            [input.tenantId, ...examIds, clampListLimit(input.limit)],
        );
        return rows.map(mapAttempt).filter((row) => row.tenant_id === input.tenantId && row.status === 'pending_review');
    }

    async loadAttemptForGrading(input: { tenantId: string; attemptId: string }): Promise<ManualGradingAttemptBundle | null> {
        const attemptRows = await this.conn.query<AttemptRowDb>(ATTEMPT_SELECT, [input.attemptId, input.tenantId]);
        const attempt = attemptRows[0];
        if (!attempt || attempt.tenant_id !== input.tenantId) return null;
        return this.loadBundle(attempt);
    }

    private async loadBundle(attempt: AttemptRowDb): Promise<ManualGradingAttemptBundle> {
        // Sequential on the one connection: never issue parallel statements on
        // a transactional MySQL connection.
        const questions = await this.conn.query<QuestionRowDb>(QUESTIONS_SELECT, [
            attempt.tenant_id,
            attempt.exam_version_id,
        ]);
        const answers = await this.conn.query<AnswerRowDb>(ANSWERS_SELECT, [attempt.tenant_id, attempt.id]);
        const revisions = await this.conn.query<RevisionRowDb>(LATEST_REVISIONS_SELECT, [
            attempt.tenant_id,
            attempt.id,
            attempt.tenant_id,
            attempt.id,
        ]);
        const questionsMapped: PinnedQuestionRow[] = questions.map((row) => ({
            ref: row.ref,
            position: typeof row.position === 'string' ? Number(row.position) : row.position,
            question_type: row.question_type,
            points: row.points,
        }));
        const answersMapped: ManualAnswerRow[] = answers.map((row) => asRecord({
            question_ref: row.question_ref,
            question_type: row.question_type,
            response: row.response,
            awarded_points: row.awarded_points,
            is_correct: row.is_correct,
            manual_review: row.manual_review,
        }));
        return {
            attempt: mapAttempt(attempt),
            questions: questionsMapped,
            answers: answersMapped,
            latestRevisions: latestByQuestion(revisions),
        };
    }

    async appendAnswerGradeRevision(input: AppendAnswerGradeRevisionInput): Promise<StoreAppendResult> {
        const result = await this.conn.execute(CAS_BUMP, [
            input.attemptId,
            input.tenantId,
            input.expectedAttemptStatus,
            input.expectedAttemptVersion,
        ]);
        if (affectedRowsOf(result) !== 1) {
            return this.classifyAppendCasFailure(input);
        }
        try {
            await this.conn.execute(REVISION_INSERT, [
                this.deps.idFactory(),
                input.tenantId,
                input.attemptId,
                input.questionRef,
                input.revision,
                input.awardedHundredths,
                input.reviewerUserId,
                input.feedback,
                input.createdAt,
            ]);
        } catch (error) {
            if (isDuplicateError(error)) {
                throw new AppendRollback({ ok: false, reason: 'duplicate_revision' });
            }
            if (isForeignKeyError(error)) throw classifyForeignKeyError(error);
            throw error;
        }
        // No audit here: the domain/route layer is the single writer and calls
        // `writeAudit` on this same transaction-bound handle.
        return { ok: true, newAttemptVersion: input.expectedAttemptVersion + 1 };
    }

    private async readAttemptState(
        tenantId: string,
        attemptId: string,
    ): Promise<{ status: string; version: number } | null> {
        const rows = await this.conn.query<{ status: string; version: number | string }>(CASE_STATE_SELECT, [
            attemptId,
            tenantId,
        ]);
        const row = rows[0];
        if (!row) return null;
        const version = normalizeAttemptVersion(row.version);
        if (version === null) {
            throw new ExamManualGradingSqlError('invalid_attempt_row', 'attempt version is not a safe integer');
        }
        return { status: row.status, version };
    }

    private async classifyAppendCasFailure(input: AppendAnswerGradeRevisionInput): Promise<StoreAppendResult> {
        const state = await this.readAttemptState(input.tenantId, input.attemptId);
        if (state === null) return { ok: false, reason: 'attempt_missing' };
        if (state.status !== input.expectedAttemptStatus || state.status !== 'pending_review') {
            return { ok: false, reason: 'attempt_not_pending' };
        }
        return { ok: false, reason: 'attempt_version_conflict' };
    }

    async finalizeAttempt(input: FinalizeAttemptInput): Promise<StoreFinalizeResult> {
        const attemptRows = await this.conn.query<AttemptRowDb>(ATTEMPT_FOR_UPDATE_SELECT, [
            input.attemptId,
            input.tenantId,
        ]);
        const attempt = attemptRows[0];
        if (!attempt || attempt.tenant_id !== input.tenantId) {
            return { ok: false, reason: 'attempt_missing' };
        }
        const currentVersion = safelyNormalizedVersion(attempt.version, 'attempt');
        if (attempt.status !== input.expectedAttemptStatus || attempt.status !== 'pending_review') {
            return { ok: false, reason: 'attempt_not_pending' };
        }
        if (currentVersion !== input.expectedVersion) {
            return { ok: false, reason: 'attempt_version_conflict' };
        }

        // Same connection, after the attempt row lock: the latest revisions
        // seen here are the ones the caller's plan was bound to.
        const revisionRows = await this.conn.query<RevisionRowDb>(REVISIONS_FOR_UPDATE_SELECT, [
            input.tenantId,
            input.attemptId,
        ]);
        const latestRevisions = latestByQuestion(revisionRows);

        let update: { affectedRows?: number | string; insertId?: number | string };
        try {
            update = await this.conn.execute(FINALIZE_UPDATE, [
                formatHundredths(input.scoreHundredths),
                input.passed === null ? null : input.passed ? 1 : 0,
                input.reviewerUserId,
                input.gradedAt,
                input.attemptId,
                input.tenantId,
                input.expectedAttemptStatus,
                input.expectedVersion,
            ]);
        } catch (error) {
            if (isForeignKeyError(error)) throw classifyForeignKeyError(error);
            throw error;
        }
        if (affectedRowsOf(update) !== 1) {
            return { ok: false, reason: 'attempt_version_conflict' };
        }
        // The latest revisions are still returned to the caller so the single
        // (domain/route) audit writer can include them in its one row. No audit
        // is written here.
        void latestRevisions;
        return { ok: true, newAttemptVersion: input.expectedVersion + 1 };
    }

    /**
     * C1-R: project the just-finalized total into the course gradebook on this
     * same transaction. The row id is deterministic over
     * (tenant, enrollment, course, 'exam', exam id), so a repeated finalize
     * (which the CAS already refuses) and any later re-projection target one
     * row instead of appending a duplicate grade.
     *
     * Every skip is explicit and non-destructive: no course, a student outside
     * the course, or a total that cannot be represented means "no grade", never
     * a guessed one. A real write failure throws and rolls the finalization
     * back, so a graded attempt can never commit without its grade.
     */
    async recordGradebookScore(input: ExamGradebookProjectionInput): Promise<ExamGradebookProjectionResult> {
        const courseRows = await this.conn.query<{ course_id: string }>(EXAM_COURSE_SELECT, [
            input.examId,
            input.tenantId,
        ]);
        const courseId = courseRows[0]?.course_id;
        if (!courseId) return { ok: true, linked: false, reason: 'not_course_scoped' };

        const enrolled = await this.conn.query<{ id: string }>(ENROLLMENT_IN_COURSE_SELECT, [
            courseId,
            input.enrollmentId,
            input.tenantId,
            courseId,
        ]);
        if (enrolled.length === 0) return { ok: true, linked: false, reason: 'student_not_in_course' };

        const maxHundredths = toHundredths(input.totalPoints ?? null);
        if (maxHundredths === null || maxHundredths <= 0) {
            return { ok: true, linked: false, reason: 'invalid_score' };
        }
        if (!Number.isSafeInteger(input.scoreHundredths)
            || input.scoreHundredths < 0
            || input.scoreHundredths > maxHundredths) {
            return { ok: true, linked: false, reason: 'invalid_score' };
        }
        const scoreId = deterministicScoreId({
            tenantId: input.tenantId,
            enrollmentId: input.enrollmentId,
            courseId,
            itemType: 'exam',
            itemId: input.examId,
        });
        if (!scoreId) return { ok: true, linked: false, reason: 'invalid_score' };

        const score = formatHundredths(input.scoreHundredths);
        const maxScore = formatHundredths(maxHundredths);
        const existing = await this.conn.query<{ id: string; score: number | string; max_score: number | string }>(
            GRADEBOOK_SCORE_SELECT,
            [scoreId, input.tenantId],
        );
        if (existing.length > 0) {
            const current = existing[0];
            if (Number(current.score) === Number(score) && Number(current.max_score) === Number(maxScore)) {
                return { ok: true, linked: true, scoreId, corrected: false };
            }
            await this.conn.execute(GRADEBOOK_SCORE_UPDATE, [
                score,
                maxScore,
                input.reviewerUserId,
                scoreId,
                input.tenantId,
            ]);
            return { ok: true, linked: true, scoreId, corrected: true };
        }
        try {
            await this.conn.execute(GRADEBOOK_SCORE_INSERT, [
                scoreId,
                input.tenantId,
                input.enrollmentId,
                courseId,
                input.examId,
                score,
                maxScore,
                input.reviewerUserId,
            ]);
        } catch (error) {
            // A concurrent projection of the same item won the primary key.
            // The grade exists, so this attempt is already represented.
            if (isDuplicateError(error)) return { ok: true, linked: true, scoreId, corrected: false };
            throw error;
        }
        return { ok: true, linked: true, scoreId, corrected: false };
    }
}

class ExamManualGradingSqlStoreImpl implements ExamManualGradingSqlStore {
    private readonly audit: ExamManualGradingAuditSink;
    private readonly idFactory: () => string;

    constructor(private readonly deps: ExamManualGradingSqlDeps) {
        if (!deps || typeof deps.transaction !== 'function') {
            throw new ExamManualGradingSqlError(
                'invalid_runner',
                'ExamManualGradingSqlStore requires a connection-bound transaction runner',
            );
        }
        if (typeof deps.audit !== 'function') {
            throw new ExamManualGradingSqlError(
                'invalid_audit',
                'ExamManualGradingSqlStore requires the sealed connection-bound audit writer',
            );
        }
        this.audit = deps.audit;
        this.idFactory = deps.idFactory ?? randomUUID;
    }

    inTransaction(conn: ExamGradingSqlConnection): ExamManualGradingSqlBoundStore {
        return new ExamManualGradingSqlTransaction(conn, {
            audit: this.audit,
            idFactory: this.idFactory,
        });
    }

    listPendingAttempts(input: ListPendingAttemptsInput): Promise<PendingManualAttemptRow[]> {
        return this.deps.transaction((conn) => this.inTransaction(conn).listPendingAttempts(input));
    }

    loadAttemptForGrading(input: { tenantId: string; attemptId: string }): Promise<ManualGradingAttemptBundle | null> {
        return this.deps.transaction((conn) => this.inTransaction(conn).loadAttemptForGrading(input));
    }

    async appendAnswerGradeRevision(input: AppendAnswerGradeRevisionInput): Promise<StoreAppendResult> {
        try {
            return await this.deps.transaction((conn) => this.inTransaction(conn).appendAnswerGradeRevision(input));
        } catch (error) {
            if (error instanceof AppendRollback) return error.result;
            throw error;
        }
    }

    finalizeAttempt(input: FinalizeAttemptInput): Promise<StoreFinalizeResult> {
        return this.deps.transaction((conn) => this.inTransaction(conn).finalizeAttempt(input));
    }
}

/**
 * Build the adapter. Throws before any statement when the transaction runner is
 * absent; no pool, no implicit autocommit path exists in this module.
 */
export const createExamManualGradingSqlStore = (
    deps: ExamManualGradingSqlDeps,
): ExamManualGradingSqlStore => new ExamManualGradingSqlStoreImpl(deps);

export const createBoundExamManualGradingSqlStore = (
    conn: ExamGradingSqlConnection,
    deps: ExamManualGradingSqlDeps,
): ExamManualGradingSqlBoundStore => new ExamManualGradingSqlStoreImpl(deps).inTransaction(conn);
