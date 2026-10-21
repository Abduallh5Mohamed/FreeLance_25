/**
 * C1a — manual grading routes for the NEW versioned exam system.
 *
 * Audience + permission model (deny-by-default):
 *  - Students are refused everywhere: this surface grades staff work and never
 *    exposes a result to the student.
 *  - Every staff read/write is checked against the injected server-verified
 *    course/exam teaching authority (`deps.authority`). Role labels and
 *    client-supplied tenant/branch values are never evidence.
 *  - The pending queue is limited to exam ids the authority returns for the
 *    selected tenant; the store additionally scopes every row by tenant.
 *  - Cross-tenant attempts are answered 404 (never enumerable); unrelated
 *    same-tenant staff are answered 403; a student is answered 403.
 *
 * RACE CONTRACT (see services/exam-manual-grading.ts for the full statement):
 *  - Every answer-revision write CASes on the expected attempt status
 *    (`pending_review`) AND the expected attempt version and bumps the version
 *    atomically with the revision; a lost CAS is a 409 with no write and no
 *    success audit. A finalize that commits under any racing writer therefore
 *    invalidates all later revision writes.
 *  - Finalize re-reads the attempt bundle through the transaction-bound store
 *    handle INSIDE the transaction and computes the total only from that
 *    read; the finalize write CASes on the version from the same read. No
 *    stale total can ever be reported with success.
 *  - Every mutation is audited through `deps.audit` inside the same
 *    `deps.transaction` seam as the store write, so a failed audit rolls the
 *    whole change back. Audit values carry ids, revision numbers, points,
 *    versions and status only — never student identity, answers or feedback
 *    text.
 *
 * The store, the teaching authority, the audit writer and the transaction seam
 * are injected. This module does not mount itself, does not import production
 * wiring, and never runs DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
    ExamAuthorityDecision,
    ExamManualGradingAuthority,
    ManualGradingAttemptBundle,
    ManualGradeErrorCode,
    ManualGradingScope,
    ManualGradingStore,
    PendingManualAttemptRow,
    StoreMutationRejection,
    clampPendingLimit,
    isRecord,
    normalizeAttemptVersion,
    normalizeOpaqueId,
    planAttemptFinalize,
    planManualAnswerGrade,
    projectStoreMutationRejection,
} from '../services/exam-manual-grading';
import { formatHundredths } from '../services/exam-grading';

export interface ManualGradingAuditRecord {
    actorUserId: string;
    tenantId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
}

/**
 * Audit writer. It receives the transaction-bound store so the audit row can be
 * written through the same connection as the mutation. The writer must not be
 * given raw answers, feedback text or student identity.
 */
export type ManualGradingAuditWriter = (
    tx: ManualGradingStore,
    input: ManualGradingAuditRecord,
) => Promise<void>;

export interface ExamManualGradingDeps {
    store: ManualGradingStore;
    authenticate: RequestHandler;
    authority: ExamManualGradingAuthority;
    audit: ManualGradingAuditWriter;
    /** Atomic seam; receives a transaction-bound store (like moderation). */
    transaction: <T>(fn: (tx: ManualGradingStore) => Promise<T>) => Promise<T>;
    now?: () => Date;
}

const projectPendingAttempt = (row: PendingManualAttemptRow) => ({
    id: row.id,
    exam_id: row.exam_id,
    exam_version_id: row.exam_version_id,
    student_enrollment_id: row.student_enrollment_id,
    status: row.status,
    submitted_at: row.submitted_at,
    auto_score: row.auto_score === null ? null : Number(row.auto_score),
    score: row.score === null ? null : Number(row.score),
    manual_required: row.manual_required === true || row.manual_required === 1,
    version: Number(row.version),
});

const projectAttemptForGrading = (bundle: ManualGradingAttemptBundle) => {
    const latest = new Map(bundle.latestRevisions.map((row) => [row.question_ref, row]));
    return {
        attempt: {
            id: bundle.attempt.id,
            exam_id: bundle.attempt.exam_id,
            exam_version_id: bundle.attempt.exam_version_id,
            student_enrollment_id: bundle.attempt.student_enrollment_id,
            status: bundle.attempt.status,
            submitted_at: bundle.attempt.submitted_at,
            auto_score: bundle.attempt.auto_score === null ? null : Number(bundle.attempt.auto_score),
            score: bundle.attempt.score === null ? null : Number(bundle.attempt.score),
            manual_required: bundle.attempt.manual_required === true || bundle.attempt.manual_required === 1,
            version: Number(bundle.attempt.version),
        },
        questions: bundle.questions.map((question) => ({
            ref: question.ref,
            position: Number(question.position),
            question_type: question.question_type,
            points: question.points,
        })),
        answers: bundle.answers.map((answer) => {
            const revision = latest.get(answer.question_ref);
            return {
                question_ref: answer.question_ref,
                question_type: answer.question_type,
                response: answer.response,
                awarded_points: answer.awarded_points,
                is_correct: answer.is_correct === null ? null : (answer.is_correct === true || answer.is_correct === 1),
                manual_review: answer.manual_review === true || answer.manual_review === 1,
                latest_revision: revision ? revision.revision : null,
                latest_awarded_points: revision ? formatHundredths(revision.awarded_hundredths) : null,
            };
        }),
    };
};

const gradeErrorStatus = (error: ManualGradeErrorCode): number => {
    switch (error) {
        case 'invalid_points':
        case 'points_out_of_range':
        case 'invalid_feedback':
        case 'feedback_too_long':
            return 400;
        default:
            return 409;
    }
};

const gradePlanError = (error: ManualGradeErrorCode): { httpStatus: number; error: string; code: ManualGradeErrorCode } => ({
    httpStatus: gradeErrorStatus(error),
    error: error === 'points_out_of_range'
        ? 'Points are outside the pinned question range'
        : 'Manual grade was rejected',
    code: error,
});

/**
 * Finalize-specific plan projection: a graded attempt is already finalized
 * (idempotent 409), any other refusal keeps the planner's code.
 */
const finalizePlanError = (error: ManualGradeErrorCode, attemptStatus: string): { httpStatus: number; error: string; code: string } => {
    const alreadyFinalized = attemptStatus === 'graded' && error === 'attempt_not_pending';
    if (alreadyFinalized) {
        return { httpStatus: 409, error: 'Attempt is already finalized', code: 'already_finalized' };
    }
    if (error === 'incomplete_manual_grading') {
        return { httpStatus: 409, error: 'Attempt cannot be finalized', code: error };
    }
    return { httpStatus: gradeErrorStatus(error), error: 'Attempt cannot be finalized', code: error };
};

/**
 * One exhaustive outcome per finalize transaction: a committed finalization, a
 * refused plan computed from the in-transaction re-read, or a store CAS
 * refusal. Keeping it a discriminated union means the response branch never
 * reads a value the transaction did not actually set.
 */
type FinalizeTransactionOutcome =
    | {
        kind: 'applied';
        scoreHundredths: number;
        version: number;
        passed: boolean | null;
        includedRevisions: Array<{ question_ref: string; revision: number }>;
    }
    | { kind: 'stale_plan'; attemptStatus: string; error: ManualGradeErrorCode }
    | { kind: 'rejected'; rejection: StoreMutationRejection };

export function createExamManualGradingRouter(deps: ExamManualGradingDeps): Router {
    const router = Router();
    const now = deps.now ?? ((): Date => new Date());

    router.use(deps.authenticate);

    const resolveScope = async (req: AuthRequest, res: Response): Promise<ManualGradingScope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (user.role === 'student') {
            res.status(403).json({ error: 'Staff access required' });
            return null;
        }
        if (!user.tenantId) {
            res.status(403).json({ error: 'An active tenant membership is required' });
            return null;
        }
        return { tenantId: user.tenantId, userId: user.id, branchId: user.branchId ?? null };
    };

    const denyExam = (res: Response, decision: ExamAuthorityDecision): void => {
        if (decision === 'not_found') res.status(404).json({ error: 'Attempt not found' });
        else res.status(403).json({ error: 'You are not authorized for this exam' });
    };

    /**
     * Load an attempt and prove both the tenant (store filter) and the injected
     * course/exam authority before revealing anything about it. This read is
     * request authentication, never the source of statement about state: the
     * grade write additionally CASes on the attempt version/status, and the
     * finalize re-reads everything it acts on inside its transaction.
     */
    const requireAttempt = async (
        scope: ManualGradingScope,
        rawAttemptId: unknown,
        res: Response,
    ): Promise<ManualGradingAttemptBundle | null> => {
        const attemptId = normalizeOpaqueId(rawAttemptId);
        if (!attemptId) {
            res.status(404).json({ error: 'Attempt not found' });
            return null;
        }
        const bundle = await deps.store.loadAttemptForGrading({ tenantId: scope.tenantId, attemptId });
        if (!bundle || bundle.attempt.tenant_id !== scope.tenantId) {
            res.status(404).json({ error: 'Attempt not found' });
            return null;
        }
        const decision = await deps.authority.authorizeExam(scope, bundle.attempt.exam_id);
        if (decision !== 'ok') {
            denyExam(res, decision);
            return null;
        }
        return bundle;
    };

    /* ---------------------------------------------------------------------- */
    /* GET /pending — authorized pending_review queue                         */
    /* ---------------------------------------------------------------------- */
    router.get('/pending', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const limit = clampPendingLimit(req.query.limit);
            if (limit === null) return res.status(400).json({ error: 'Invalid limit' });

            const examIds = await deps.authority.listAuthorizedExamIds(scope);
            if (examIds.length === 0) {
                return res.json({ attempts: [], count: 0, limit });
            }
            const allowed = new Set(examIds);
            const rows = await deps.store.listPendingAttempts({
                tenantId: scope.tenantId,
                examIds,
                limit,
            });
            const attempts = rows
                .filter((row) => row.tenant_id === scope.tenantId
                    && row.status === 'pending_review'
                    && allowed.has(row.exam_id))
                .slice(0, limit)
                .map(projectPendingAttempt);
            res.json({ attempts, count: attempts.length, limit });
        } catch (error) {
            console.error('List pending manual grading error:', error);
            res.status(500).json({ error: 'Failed to list pending attempts' });
        }
    });

    /* ---------------------------------------------------------------------- */
    /* GET /attempts/:attemptId — answers for grading                         */
    /* ---------------------------------------------------------------------- */
    router.get('/attempts/:attemptId', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const bundle = await requireAttempt(scope, req.params.attemptId, res);
            if (!bundle) return;
            res.json(projectAttemptForGrading(bundle));
        } catch (error) {
            console.error('Read manual grading attempt error:', error);
            res.status(500).json({ error: 'Failed to load attempt' });
        }
    });

    /* ---------------------------------------------------------------------- */
    /* POST /attempts/:attemptId/answers/:questionRef/grade                   */
    /* ---------------------------------------------------------------------- */
    router.post('/attempts/:attemptId/answers/:questionRef/grade', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const bundle = await requireAttempt(scope, req.params.attemptId, res);
            if (!bundle) return;

            const questionRef = normalizeOpaqueId(req.params.questionRef);
            if (!questionRef) return res.status(404).json({ error: 'Question not found' });
            const question = bundle.questions.find((row) => row.ref === questionRef);
            if (!question) return res.status(404).json({ error: 'Question not found' });
            const answer = bundle.answers.find((row) => row.question_ref === questionRef);
            if (!answer) return res.status(404).json({ error: 'Question not found' });

            const existingMaxRevision = bundle.latestRevisions
                .filter((row) => row.question_ref === questionRef)
                .reduce((max, row) => Math.max(max, Number(row.revision)), 0);
            const body = isRecord(req.body) ? req.body : {};
            const planned = planManualAnswerGrade({
                attemptStatus: bundle.attempt.status,
                manualReview: answer.manual_review === true || answer.manual_review === 1,
                question,
                existingMaxRevision,
                points: body['points'],
                feedback: body['feedback'],
            });
            if (!planned.ok) {
                const projected = gradePlanError(planned.error);
                res.status(projected.httpStatus).json({ error: projected.error, code: projected.code });
                return;
            }
            // Optimistic guard input: the append CAS refuses anything that has
            // moved since this read, including a concurrent finalize, so no
            // revision can land after finalize and no wrong revision number is
            // ever stored (every revision write bumps the attempt version).
            const expectedAttemptVersion = normalizeAttemptVersion(bundle.attempt.version);
            if (expectedAttemptVersion === null) {
                return res.status(409).json({ error: 'Attempt state is invalid', code: 'invalid_manual_state' });
            }

            const plan = planned.plan;
            const createdAt = now().toISOString();
            let appendedVersion: number | null = null;
            let rejection = projectStoreMutationRejection('attempt_version_conflict');
            const applied = await deps.transaction(async (tx) => {
                const result = await tx.appendAnswerGradeRevision({
                    tenantId: scope.tenantId,
                    attemptId: bundle.attempt.id,
                    questionRef: plan.questionRef,
                    revision: plan.revision,
                    awardedHundredths: plan.awardedHundredths,
                    reviewerUserId: scope.userId,
                    feedback: plan.feedback,
                    createdAt,
                    expectedAttemptStatus: 'pending_review',
                    expectedAttemptVersion,
                });
                if (!result.ok) {
                    rejection = projectStoreMutationRejection(result.reason);
                    return false;
                }
                const previous = bundle.latestRevisions.find((row) => row.question_ref === questionRef);
                await deps.audit(tx, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'exam_manual_grade.answer',
                    resourceType: 'exam_attempt',
                    resourceId: bundle.attempt.id,
                    oldValue: previous
                        ? { question_ref: questionRef, revision: previous.revision, awarded_hundredths: previous.awarded_hundredths }
                        : null,
                    newValue: {
                        question_ref: questionRef,
                        revision: plan.revision,
                        awarded_hundredths: plan.awardedHundredths,
                        status: 'pending_review',
                        attempt_version_after: result.newAttemptVersion,
                    },
                });
                appendedVersion = result.newAttemptVersion;
                return true;
            });
            if (!applied) {
                return res.status(rejection.httpStatus).json({ error: rejection.error, code: rejection.code });
            }
            res.json({
                attempt_id: bundle.attempt.id,
                question_ref: plan.questionRef,
                revision: plan.revision,
                awarded_hundredths: plan.awardedHundredths,
                awarded_points: formatHundredths(plan.awardedHundredths),
                attempt_version: appendedVersion,
            });
        } catch (error) {
            console.error('Grade manual answer error:', error);
            res.status(500).json({ error: 'Failed to grade answer' });
        }
    });

    /* ---------------------------------------------------------------------- */
    /* POST /attempts/:attemptId/finalize                                     */
    /* ---------------------------------------------------------------------- */
    router.post('/attempts/:attemptId/finalize', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            // This pre-transaction read proves only tenant + authority. The
            // state, questions, answers and revisions actually used are
            // re-read below, inside the transaction.
            const bundle = await requireAttempt(scope, req.params.attemptId, res);
            if (!bundle) return;

            const outcome = await deps.transaction(async (tx): Promise<FinalizeTransactionOutcome> => {
                // Verify the SAME source inside the same transaction: fresh
                // attempt + latest revisions decide every statement below.
                const fresh = await tx.loadAttemptForGrading({
                    tenantId: scope.tenantId,
                    attemptId: bundle.attempt.id,
                });
                if (!fresh) {
                    return { kind: 'rejected', rejection: projectStoreMutationRejection('attempt_missing') };
                }
                const planned = planAttemptFinalize({
                    attemptStatus: fresh.attempt.status,
                    autoScore: fresh.attempt.auto_score,
                    questions: fresh.questions,
                    answers: fresh.answers,
                    latestRevisions: fresh.latestRevisions,
                    passingPoints: fresh.attempt.passing_points,
                });
                if (!planned.ok) {
                    return { kind: 'stale_plan', attemptStatus: fresh.attempt.status, error: planned.error };
                }
                const expectedVersion = normalizeAttemptVersion(fresh.attempt.version);
                if (expectedVersion === null) {
                    return { kind: 'stale_plan', attemptStatus: fresh.attempt.status, error: 'invalid_manual_state' };
                }
                const result = await tx.finalizeAttempt({
                    tenantId: scope.tenantId,
                    attemptId: bundle.attempt.id,
                    expectedAttemptStatus: 'pending_review',
                    expectedVersion,
                    scoreHundredths: planned.plan.scoreHundredths,
                    passed: planned.plan.passed,
                    reviewerUserId: scope.userId,
                    gradedAt: now().toISOString(),
                });
                if (!result.ok) {
                    return { kind: 'rejected', rejection: projectStoreMutationRejection(result.reason) };
                }
                await deps.audit(tx, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'exam_manual_grade.finalize',
                    resourceType: 'exam_attempt',
                    resourceId: bundle.attempt.id,
                    oldValue: { status: 'pending_review', version: expectedVersion },
                    newValue: {
                        status: 'graded',
                        score_hundredths: planned.plan.scoreHundredths,
                        passed: planned.plan.passed,
                        included_latest_revisions: fresh.latestRevisions.map((row) => ({
                            question_ref: row.question_ref,
                            revision: row.revision,
                        })),
                        version: result.newAttemptVersion,
                    },
                });
                return {
                    kind: 'applied',
                    scoreHundredths: planned.plan.scoreHundredths,
                    version: result.newAttemptVersion,
                    passed: planned.plan.passed,
                    includedRevisions: fresh.latestRevisions.map((row) => ({
                        question_ref: row.question_ref,
                        revision: row.revision,
                    })),
                };
            });
            if (outcome.kind === 'stale_plan') {
                const projected = finalizePlanError(outcome.error, outcome.attemptStatus);
                return res.status(projected.httpStatus).json({ error: projected.error, code: projected.code });
            }
            if (outcome.kind === 'rejected') {
                return res.status(outcome.rejection.httpStatus).json({
                    error: outcome.rejection.error,
                    code: outcome.rejection.code,
                });
            }
            res.json({
                attempt_id: bundle.attempt.id,
                status: 'graded',
                score_hundredths: outcome.scoreHundredths,
                score: formatHundredths(outcome.scoreHundredths),
                passed: outcome.passed,
                version: outcome.version,
                included_revisions: outcome.includedRevisions,
            });
        } catch (error) {
            console.error('Finalize manual grading error:', error);
            res.status(500).json({ error: 'Failed to finalize attempt' });
        }
    });

    return router;
}
