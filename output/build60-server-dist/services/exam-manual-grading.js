"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MANUAL_FEEDBACK_LENGTH = exports.MAX_PENDING_LIMIT = exports.DEFAULT_PENDING_LIMIT = exports.MANUAL_GRADING_POLICY_VERSION = void 0;
exports.validateManualAward = validateManualAward;
exports.planManualAnswerGrade = planManualAnswerGrade;
exports.planAttemptFinalize = planAttemptFinalize;
exports.normalizeAttemptVersion = normalizeAttemptVersion;
exports.projectStoreMutationRejection = projectStoreMutationRejection;
exports.clampPendingLimit = clampPendingLimit;
exports.normalizeOpaqueId = normalizeOpaqueId;
exports.isRecord = isRecord;
const exam_grading_1 = require("./exam-grading");
exports.MANUAL_GRADING_POLICY_VERSION = 1;
exports.DEFAULT_PENDING_LIMIT = 100;
exports.MAX_PENDING_LIMIT = 200;
exports.MAX_MANUAL_FEEDBACK_LENGTH = 2000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Validate one manual award against the pinned question's maximum points. */
function validateManualAward(rawPoints, pinnedPoints, rawFeedback) {
    const maxHundredths = (0, exam_grading_1.toHundredths)(pinnedPoints);
    if (maxHundredths === null)
        return { ok: false, error: 'invalid_pinned_points' };
    let feedback = null;
    if (rawFeedback !== undefined && rawFeedback !== null) {
        if (typeof rawFeedback !== 'string')
            return { ok: false, error: 'invalid_feedback' };
        const trimmed = rawFeedback.trim();
        if (trimmed.length > exports.MAX_MANUAL_FEEDBACK_LENGTH)
            return { ok: false, error: 'feedback_too_long' };
        feedback = trimmed === '' ? null : trimmed;
    }
    const awardedHundredths = (0, exam_grading_1.toHundredths)(rawPoints);
    if (awardedHundredths === null)
        return { ok: false, error: 'invalid_points' };
    if (awardedHundredths > maxHundredths)
        return { ok: false, error: 'points_out_of_range' };
    return { ok: true, value: { awardedHundredths, feedback } };
}
/**
 * Plan one answer grade. Only `pending_review` attempts accept grades, and the
 * next revision is always `max(existing) + 1`. The plan is safe to compute
 * from a pre-transaction read because every revision write CASes on the
 * attempt version and bumps it: a concurrent revision moves the version and
 * the CAS ref lands before a wrong revision number ever reaches storage.
 */
function planManualAnswerGrade(input) {
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
    if (!award.ok)
        return { ok: false, error: award.error };
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
const truthyFlag = (value) => value === true || value === 1;
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
function planAttemptFinalize(input) {
    if (input.attemptStatus !== 'pending_review') {
        return { ok: false, error: 'attempt_not_pending' };
    }
    const autoScoreHundredths = (0, exam_grading_1.toHundredths)(input.autoScore ?? 0);
    if (autoScoreHundredths === null)
        return { ok: false, error: 'invalid_manual_state' };
    const questionByRef = new Map();
    for (const question of input.questions)
        questionByRef.set(question.ref, question);
    const latestByRef = new Map();
    for (const revision of input.latestRevisions)
        latestByRef.set(revision.question_ref, revision);
    const manualRefs = new Set();
    for (const answer of input.answers) {
        if (truthyFlag(answer.manual_review))
            manualRefs.add(answer.question_ref);
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
        if (!question)
            return { ok: false, error: 'invalid_manual_state' };
        const maxHundredths = (0, exam_grading_1.toHundredths)(question.points);
        if (maxHundredths === null)
            return { ok: false, error: 'invalid_pinned_points' };
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
    let passed = null;
    if (input.passingPoints !== undefined && input.passingPoints !== null) {
        const passingHundredths = (0, exam_grading_1.toHundredths)(input.passingPoints);
        if (passingHundredths === null)
            return { ok: false, error: 'invalid_pinned_points' };
        passed = total >= passingHundredths;
    }
    return {
        ok: true,
        plan: { scoreHundredths: total, score: (0, exam_grading_1.formatHundredths)(total), passed },
    };
}
/**
 * Parse the optimistic-version guard input from a stored attempt version. Only
 * non-negative integers are acceptable: a guard computed from anything else
 * would be meaningless, so the caller must fail closed.
 */
function normalizeAttemptVersion(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}
const REJECTION_PROJECTIONS = {
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
function projectStoreMutationRejection(reason) {
    return { ...REJECTION_PROJECTIONS[reason] };
}
/** Bounded page size for the pending queue; null when the value is malformed. */
function clampPendingLimit(raw) {
    if (raw === undefined || raw === null || raw === '')
        return exports.DEFAULT_PENDING_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1)
        return null;
    return Math.min(parsed, exports.MAX_PENDING_LIMIT);
}
/** Bounded opaque id (attempt/question ref). Returns null when malformed. */
function normalizeOpaqueId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9_-]+$/.test(trimmed))
        return null;
    return trimmed;
}
