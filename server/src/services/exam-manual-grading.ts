/**
 * C1a — manual grading for the NEW versioned exam system.
 *
 * Pure, deterministic, I/O-free policy for the `pending_review` queue that
 * `services/exam-grading.ts` produces for essay/manual questions. It owns the
 * state rules only:
 *  - an answer may be graded only while the attempt is `pending_review`, and an
 *    attempt may be finalized only once (`pending_review -> graded`);
 *  - an award is an integer number of hundredths in `[0, pinned question points]`;
 *  - every regrade appends revision `N+1` for that (attempt, question) and keeps
 *    the whole revision history;
 *  - the final total is recomputed as exact integer hundredths from the stored
 *    auto score plus the latest manual revision per question, using the same
 *    exact-arithmetic helpers as `services/exam-grading.ts`.
 *
 * RACE CONTRACT (optimistic guard on every mutation, documented for I2):
 *  - Every answer-revision write carries the expected attempt status
 *    (`pending_review`) and the expected attempt version. The store must
 *    compare-and-swap on both: the revision insert and the attempt version
 *    bump happen in one atomic SQL transaction, or the write fails with a
 *    distinguishable reason. A concurrent finalize therefore makes every later
 *    revision write fail — no revision can land after finalize.
 *  - Finalize re-reads the attempt bundle through the transaction-bound store
 *    handle INSIDE the transaction and the total is computed only from what
 *    that read returned; the finalize write CASes on the version read in the
 *    same transaction. A revision committed between the re-read and the write
 *    necessarily bumped the version, so the CAS fails: the outcome is either
 *    the total including the latest revisions or a 409 — never a stale total
 *    reported with success.
 *  - Because every revision write bumps the attempt version, a revision number
 *    planned from a pre-transaction read (`max+1`) is safe: any concurrent
 *    revision moves the version and loses the CAS before it could collide.
 *
 * The persistence contract is the injected `ManualGradingStore`. This module
 * does not implement SQL, mount a router, read a request, a clock or a database.
 * The schema (answer-grade/revision table + attempt reviewer columns) is an I2
 * deliverable; an injected store is not evidence that any SQL works.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { formatHundredths, toHundredths } from './exam-grading';

export const MANUAL_GRADING_POLICY_VERSION = 1;
export const DEFAULT_PENDING_LIMIT = 100;
export const MAX_PENDING_LIMIT = 200;
export const MAX_MANUAL_FEEDBACK_LENGTH = 2000;

export type ManualGradingAttemptStatus = 'in_progress' | 'pending_review' | 'graded' | 'expired';

export interface ManualGradingScope {
    tenantId: string;
    userId: string;
    branchId: string | null;
}

export type ExamAuthorityDecision = 'ok' | 'not_found' | 'forbidden';

/**
 * The injected server-verified course/exam teaching authority. A production
 * implementation must resolve the same relation chain used by
 * `authorizeExamStaff` in `routes/exam-versions.ts` (tenant owner, course
 * instructor, group instructor, branch-scoped instructor) from server rows;
 * role labels are never authority. This module never imports those internals.
 */
export interface ExamManualGradingAuthority {
    /** Exam ids in the selected tenant whose course the caller teaches. Bounded. */
    listAuthorizedExamIds(scope: ManualGradingScope): Promise<readonly string[]>;
    /** Deny-by-default authority over one exam. */
    authorizeExam(scope: ManualGradingScope, examId: string): Promise<ExamAuthorityDecision>;
}

/* ------------------------------------------------------------------------- */
/* Persistence contract (SQL schema belongs to I2)                           */
/* ------------------------------------------------------------------------- */

export interface PendingManualAttemptRow {
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
    /** Attempt reviewer columns expected from I2 (optional until wired). */
    reviewer_user_id?: string | null;
    graded_at?: string | Date | null;
    passed?: boolean | number | null;
    /**
     * Pinned total of the exam version this attempt was taken against. Optional
     * because a store that does not select it simply cannot project the result
     * into a course gradebook (the projection is skipped, never guessed).
     */
    total_points?: number | string | null;
}

export interface PinnedQuestionRow {
    ref: string;
    position: number;
    question_type: string;
    points: number | string;
}

export interface ManualAnswerRow {
    question_ref: string;
    question_type: string;
    response: unknown;
    awarded_points: number | string | null;
    is_correct: boolean | number | null;
    manual_review: boolean | number;
}

/** The latest (highest revision) grade row per (attempt, question). */
export interface ManualGradeRevisionRow {
    question_ref: string;
    revision: number;
    awarded_hundredths: number;
    reviewer_user_id: string;
    feedback: string | null;
    created_at: string | Date;
}

export interface ManualGradingAttemptBundle {
    attempt: PendingManualAttemptRow;
    questions: PinnedQuestionRow[];
    answers: ManualAnswerRow[];
    latestRevisions: ManualGradeRevisionRow[];
}

export interface ListPendingAttemptsInput {
    tenantId: string;
    examIds: readonly string[];
    limit: number;
}

export interface AppendAnswerGradeRevisionInput {
    tenantId: string;
    attemptId: string;
    questionRef: string;
    revision: number;
    awardedHundredths: number;
    reviewerUserId: string;
    feedback: string | null;
    createdAt: string;
    /** CAS: the caller's expected attempt row state. Only `pending_review` grades. */
    expectedAttemptStatus: ManualGradingAttemptStatus;
    /** CAS: the caller's expected attempt row version at the time of the read. */
    expectedAttemptVersion: number;
}

export interface FinalizeAttemptInput {
    tenantId: string;
    attemptId: string;
    /** CAS: the caller's expected attempt row state. Only `pending_review` finalizes. */
    expectedAttemptStatus: ManualGradingAttemptStatus;
    /** CAS: the version read inside the SAME transaction as this write. */
    expectedVersion: number;
    scoreHundredths: number;
    passed: boolean | null;
    reviewerUserId: string;
    gradedAt: string;
}

/** Why a CAS-guarded store mutation refused to write. */
export type StoreAppendRaceReason =
    | 'attempt_missing'
    | 'attempt_not_pending'
    | 'attempt_version_conflict'
    | 'duplicate_revision';

export type StoreFinalizeRaceReason =
    | 'attempt_missing'
    | 'attempt_not_pending'
    | 'attempt_version_conflict';

export type StoreAppendResult =
    | { ok: true; newAttemptVersion: number }
    | { ok: false; reason: StoreAppendRaceReason };

export type StoreFinalizeResult =
    | { ok: true; newAttemptVersion: number }
    | { ok: false; reason: StoreFinalizeRaceReason };

/**
 * Projection of a finalized attempt into the course gradebook.
 *
 * This is the C1-R link between the sealed exam result and the gradebook: the
 * finalize transaction is the ONLY writer, so the grade appears atomically with
 * `status='graded'` and can never exist for an attempt that did not finalize.
 * It is deliberately an optional capability: a store that does not implement it
 * (or does not expose `total_points`) finalizes exactly as before and reports
 * `linked: false`, never a fabricated grade.
 */
export interface ExamGradebookProjectionInput {
    tenantId: string;
    examId: string;
    examVersionId: string;
    attemptId: string;
    enrollmentId: string;
    /** Final total in exact integer hundredths, as planned by finalize. */
    scoreHundredths: number;
    /** Pinned total of the exam version; null/absent means "cannot project". */
    totalPoints: number | string | null | undefined;
    reviewerUserId: string;
}

export type ExamGradebookProjectionSkipReason =
    | 'not_course_scoped'
    | 'student_not_in_course'
    | 'invalid_score';

export type ExamGradebookProjectionResult =
    | { ok: true; linked: true; scoreId: string; corrected: boolean }
    | { ok: true; linked: false; reason: ExamGradebookProjectionSkipReason };

/**
 * Injected persistence contract. Every mutation method MUST run on the
 * transaction handle supplied by the router (`deps.transaction`).
 *
 * I2 obligations behind this interface:
 *  - `appendAnswerGradeRevision` MUST execute, in one SQL transaction: the
 *    CAS predicate (`status = ?` AND `version = ?` on the attempt row:
 *    affected-zero maps to the distinguishable reasons), the revision INSERT
 *    guarded by `UNIQUE (attempt_id, question_ref, revision)`, and the attempt
 *    version bump — atomically with the revision.
 *  - `finalizeAttempt` MUST execute, in one SQL transaction: the same CAS
 *    predicate, the attempt UPDATE to `graded` (score, passed, reviewer,
 *    graded_at, version+1).
 *  - `loadAttemptForGrading`, when reached through the transaction handle, is
 *    the finalize re-read: it MUST be executed under a lock or read
 *    consistently with the subsequent CAS of the same transaction (`SELECT
 *    ... FOR UPDATE` on the attempt row and a consistent read of the latest
 *    revisions). The version CAS is the backstop that closes any residual
 *    window in the no-lock case.
 *  - `recordGradebookScore`, when implemented, MUST run on the same
 *    transaction connection as `finalizeAttempt`, so a gradebook failure rolls
 *    the finalization back instead of leaving a graded attempt without a grade.
 *    It is optional; an absent implementation is reported as `linked: false`.
 *  - No other code path may bump the attempt `version` or transition its
 *    `status`, so the CAS predicates are sound.
 */
export interface ManualGradingStore {
    listPendingAttempts(input: ListPendingAttemptsInput): Promise<PendingManualAttemptRow[]>;
    /** Loads the attempt, its pinned questions, answers and latest revisions. */
    loadAttemptForGrading(input: { tenantId: string; attemptId: string }): Promise<ManualGradingAttemptBundle | null>;
    appendAnswerGradeRevision(input: AppendAnswerGradeRevisionInput): Promise<StoreAppendResult>;
    finalizeAttempt(input: FinalizeAttemptInput): Promise<StoreFinalizeResult>;
    /** Optional C1-R gradebook link, bound to the same transaction. */
    recordGradebookScore?(input: ExamGradebookProjectionInput): Promise<ExamGradebookProjectionResult>;
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

export type ManualGradeErrorCode =
    | 'attempt_not_pending'
    | 'question_not_manual_review'
    | 'invalid_points'
    | 'points_out_of_range'
    | 'invalid_feedback'
    | 'feedback_too_long'
    | 'invalid_pinned_points'
    | 'invalid_revision_state'
    | 'incomplete_manual_grading'
    | 'invalid_manual_state';

export interface ManualAwardValue {
    awardedHundredths: number;
    feedback: string | null;
}

export type ManualAwardResult =
    | { ok: true; value: ManualAwardValue }
    | { ok: false; error: ManualGradeErrorCode };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one manual award against the pinned question's maximum points. */
export function validateManualAward(
    rawPoints: unknown,
    pinnedPoints: number | string,
    rawFeedback: unknown,
): ManualAwardResult {
    const maxHundredths = toHundredths(pinnedPoints);
    if (maxHundredths === null) return { ok: false, error: 'invalid_pinned_points' };

    let feedback: string | null = null;
    if (rawFeedback !== undefined && rawFeedback !== null) {
        if (typeof rawFeedback !== 'string') return { ok: false, error: 'invalid_feedback' };
        const trimmed = rawFeedback.trim();
        if (trimmed.length > MAX_MANUAL_FEEDBACK_LENGTH) return { ok: false, error: 'feedback_too_long' };
        feedback = trimmed === '' ? null : trimmed;
    }

    const awardedHundredths = toHundredths(rawPoints);
    if (awardedHundredths === null) return { ok: false, error: 'invalid_points' };
    if (awardedHundredths > maxHundredths) return { ok: false, error: 'points_out_of_range' };
    return { ok: true, value: { awardedHundredths, feedback } };
}

export interface ManualGradePlan {
    questionRef: string;
    revision: number;
    awardedHundredths: number;
    feedback: string | null;
}

export type ManualGradePlanResult =
    | { ok: true; plan: ManualGradePlan }
    | { ok: false; error: ManualGradeErrorCode };

/**
 * Plan one answer grade. Only `pending_review` attempts accept grades, and the
 * next revision is always `max(existing) + 1`. The plan is safe to compute
 * from a pre-transaction read because every revision write CASes on the
 * attempt version and bumps it: a concurrent revision moves the version and
 * the CAS ref lands before a wrong revision number ever reaches storage.
 */
export function planManualAnswerGrade(input: {
    attemptStatus: string;
    /** True only for an answer the auto-grader routed to manual review. */
    manualReview: boolean;
    question: PinnedQuestionRow;
    existingMaxRevision: number;
    points: unknown;
    feedback: unknown;
}): ManualGradePlanResult {
    if (input.attemptStatus !== 'pending_review') {
        return { ok: false, error: 'attempt_not_pending' };
    }
    if (!input.manualReview) {
        return { ok: false, error: 'question_not_manual_review' };
    }
    if (!Number.isSafeInteger(input.existingMaxRevision) || input.existingMaxRevision < 0) {
        return { ok: false, error: 'invalid_revision_state' };
    }
    const award = validateManualAward(input.points, input.question.points, input.feedback);
    if (!award.ok) return { ok: false, error: award.error };
    return {
        ok: true,
        plan: {
            questionRef: input.question.ref,
            revision: input.existingMaxRevision + 1,
            awardedHundredths: award.value.awardedHundredths,
            feedback: award.value.feedback,
        },
    };
}

export interface ManualFinalizePlan {
    scoreHundredths: number;
    score: string;
    passed: boolean | null;
}

export type ManualFinalizeResult =
    | { ok: true; plan: ManualFinalizePlan }
    | { ok: false; error: ManualGradeErrorCode };

const truthyFlag = (value: boolean | number): boolean => value === true || value === 1;

/**
 * Plan the single finalization of a `pending_review` attempt.
 *
 * The total is exact integer hundredths: the stored auto score (objective
 * awards only) plus the latest manual revision of every manual-review answer.
 * A manual-review answer without a revision is refused rather than silently
 * scored as zero (empty-answer scoring is a held policy item). Every revision
 * is re-checked against its pinned maximum before it can move the total.
 *
 * The finalize router calls this on the bundle re-read INSIDE the transaction,
 * so the reported total is computed from the revisions the same transaction
 * verified and CAS-guarded.
 */
export function planAttemptFinalize(input: {
    attemptStatus: string;
    autoScore: number | string | null;
    questions: readonly PinnedQuestionRow[];
    answers: readonly ManualAnswerRow[];
    latestRevisions: readonly ManualGradeRevisionRow[];
    passingPoints?: number | string | null;
}): ManualFinalizeResult {
    if (input.attemptStatus !== 'pending_review') {
        return { ok: false, error: 'attempt_not_pending' };
    }
    const autoScoreHundredths = toHundredths(input.autoScore ?? 0);
    if (autoScoreHundredths === null) return { ok: false, error: 'invalid_manual_state' };

    const questionByRef = new Map<string, PinnedQuestionRow>();
    for (const question of input.questions) questionByRef.set(question.ref, question);

    const latestByRef = new Map<string, ManualGradeRevisionRow>();
    for (const revision of input.latestRevisions) latestByRef.set(revision.question_ref, revision);

    const manualRefs = new Set<string>();
    for (const answer of input.answers) {
        if (truthyFlag(answer.manual_review)) manualRefs.add(answer.question_ref);
    }
    for (const questionRef of manualRefs) {
        if (!latestByRef.has(questionRef)) {
            return { ok: false, error: 'incomplete_manual_grading' };
        }
    }

    let total = autoScoreHundredths;
    for (const revision of latestByRef.values()) {
        // A manual revision may only replace a manual award. Grading an
        // objective answer here would double-count its stored auto award.
        if (!manualRefs.has(revision.question_ref)) {
            return { ok: false, error: 'invalid_manual_state' };
        }
        const question = questionByRef.get(revision.question_ref);
        if (!question) return { ok: false, error: 'invalid_manual_state' };
        const maxHundredths = toHundredths(question.points);
        if (maxHundredths === null) return { ok: false, error: 'invalid_pinned_points' };
        if (!Number.isSafeInteger(revision.awarded_hundredths)
            || revision.awarded_hundredths < 0
            || revision.awarded_hundredths > maxHundredths) {
            return { ok: false, error: 'invalid_manual_state' };
        }
        total += revision.awarded_hundredths;
    }
    if (!Number.isSafeInteger(total) || total < 0) {
        return { ok: false, error: 'invalid_manual_state' };
    }

    let passed: boolean | null = null;
    if (input.passingPoints !== undefined && input.passingPoints !== null) {
        const passingHundredths = toHundredths(input.passingPoints);
        if (passingHundredths === null) return { ok: false, error: 'invalid_pinned_points' };
        passed = total >= passingHundredths;
    }
    return {
        ok: true,
        plan: { scoreHundredths: total, score: formatHundredths(total), passed },
    };
}

/**
 * Parse the optimistic-version guard input from a stored attempt version. Only
 * non-negative integers are acceptable: a guard computed from anything else
 * would be meaningless, so the caller must fail closed.
 */
export function normalizeAttemptVersion(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

export interface StoreMutationRejection {
    httpStatus: number;
    code: StoreAppendRaceReason | StoreFinalizeRaceReason;
    error: string;
}

const REJECTION_PROJECTIONS: Record<StoreAppendRaceReason | StoreFinalizeRaceReason, StoreMutationRejection> = {
    attempt_missing: { httpStatus: 404, code: 'attempt_missing', error: 'Attempt not found' },
    attempt_not_pending: {
        httpStatus: 409,
        code: 'attempt_not_pending',
        error: 'Attempt is no longer pending review',
    },
    attempt_version_conflict: {
        httpStatus: 409,
        code: 'attempt_version_conflict',
        error: 'Attempt changed concurrently',
    },
    duplicate_revision: {
        httpStatus: 409,
        code: 'duplicate_revision',
        error: 'Answer grade changed concurrently',
    },
};

/** Map a CAS refusal reason to a stable HTTP projection (fail closed, 409/404). */
export function projectStoreMutationRejection(
    reason: StoreAppendRaceReason | StoreFinalizeRaceReason,
): StoreMutationRejection {
    return { ...REJECTION_PROJECTIONS[reason] };
}

/** Bounded page size for the pending queue; null when the value is malformed. */
export function clampPendingLimit(raw: unknown): number | null {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_PENDING_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, MAX_PENDING_LIMIT);
}

/** Bounded opaque id (attempt/question ref). Returns null when malformed. */
export function normalizeOpaqueId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
    return trimmed;
}

export { isRecord };
