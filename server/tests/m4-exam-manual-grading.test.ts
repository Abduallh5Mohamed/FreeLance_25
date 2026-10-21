import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    ManualGradingAuditRecord,
    createExamManualGradingRouter,
} from '../src/routes/exam-manual-grading';
import {
    AppendAnswerGradeRevisionInput,
    ExamAuthorityDecision,
    ExamManualGradingAuthority,
    FinalizeAttemptInput,
    ManualAnswerRow,
    ManualGradingAttemptBundle,
    ManualGradingScope,
    ManualGradingStore,
    ManualGradeRevisionRow,
    normalizeAttemptVersion,
    PendingManualAttemptRow,
    PinnedQuestionRow,
    planAttemptFinalize,
    planManualAnswerGrade,
    projectStoreMutationRejection,
    validateManualAward,
} from '../src/services/exam-manual-grading';
import {
    CapturedResponse,
    TEST_SECRET,
    invokeRoute,
    makeRepository,
    tokenFor,
} from './helpers/m2-harness';

/**
 * C1a — manual grading for the NEW versioned exam system (supervisor
 * correction round). The service/route contract under test:
 *
 *  - Every answer-revision write carries the expected attempt status
 *    (`pending_review`) and the expected attempt version; the append
 *    compare-and-swaps on both, succeeds only while the attempt is still
 *    pending at exactly that version, and bumps the attempt version
 *    atomically with the revision insert. Any concurrent finalize therefore
 *    makes every later revision write fail, so no revision can land after
 *    finalize.
 *  - Finalize re-reads the attempt bundle through the transaction-bound store
 *    handle INSIDE the transaction, re-plans the total from exactly what it
 *    read there, and CASes the finalize write on the version from that same
 *    in-transaction read. A revision committed between the re-read and the
 *    write necessarily bumped the version, so the CAS fails: the outcome is
 *    either the total including that revision, or a 409 — never a stale
 *    total reported with success.
 *  - Audit is written through the same transaction seam after a successful
 *    CAS; an audit failure rolls the whole change back.
 *
 * The fake store is STATEFUL and honors that contract: one shared mutable
 * state (single-threaded event loop), a transaction callback runs against the
 * same state with an undo log (rolled back on throw), and one-shot
 * interleaving hooks let tests commit ANOTHER actor's already-committed
 * grade/finalize at precise moments (before the in-tx re-read, before the
 * revision CAS, before the finalize CAS).
 *
 * This proves the code+store CAS contract, NOT any live SQL.
 */

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const TEACHER_X = tokenFor({ id: 'teacher-x', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const OWNER_B = tokenFor({ id: 'owner-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const STUDENT_A = tokenFor({
    id: 'student-a', role: 'student', tv: 0, tenant_id: 'tenant-a', student_enrollment_id: 'enr-a',
});

const USERS: Record<string, { is_active: number; token_version: number; suspension_active: number; role?: string }> = {
    'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'teacher-x': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'owner-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
};

const authRepository = () => makeRepository(USERS, {
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'teacher-x': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'owner-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    memberships: {
        'instructor-a': [{ tenant_id: 'tenant-a' }],
        'owner-a': [{ tenant_id: 'tenant-a' }],
        'teacher-x': [{ tenant_id: 'tenant-a' }],
        'owner-b': [{ tenant_id: 'tenant-b' }],
    },
    enrollments: {
        'student-a': [{
            id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a',
            instructor_id: 'instructor-a', group_id: 'group-a', grade_id: null,
        }],
    },
});

/* -------------------------------------------------------------------------- */
/* Fake store: shared state + CAS + undo-log transactions + interleaving      */
/* -------------------------------------------------------------------------- */

const EXAM_TENANT: Record<string, string> = {
    'exam-a': 'tenant-a',
    'exam-b': 'tenant-a',
    'exam-x': 'tenant-a',
    'exam-bt': 'tenant-b',
};

const GRANTS: Record<string, readonly string[]> = {
    'instructor-a:tenant-a': ['exam-a'],
    'owner-a:tenant-a': ['exam-a', 'exam-b'],
    'teacher-x:tenant-a': ['exam-x'],
    'owner-b:tenant-b': ['exam-bt'],
};

/** One-shot interleaving hooks, fired and awaited by the tx-bound store view. */
interface InterleavingHooks {
    beforeFreshRead?: () => void | Promise<void>;
    beforeAppendCas?: () => void | Promise<void>;
    beforeFinalizeCas?: () => void | Promise<void>;
}

interface AuditRow {
    record: ManualGradingAuditRecord;
    txToken?: symbol;
}

interface Harness {
    store: ManualGradingStore;
    audit: (tx: ManualGradingStore, input: ManualGradingAuditRecord) => Promise<void>;
    transaction: <T>(fn: (tx: ManualGradingStore) => Promise<T>) => Promise<T>;
    authority: ExamManualGradingAuthority;
    hooks: InterleavingHooks;
    flags: { failList: boolean; failNextAudit: boolean };
    audits: AuditRow[];
    attempts: Map<string, PendingManualAttemptRow>;
    questions: Map<string, PinnedQuestionRow[]>;
    answers: Map<string, ManualAnswerRow[]>;
    revisions: Map<string, ManualGradeRevisionRow[]>;
    finalizeCasCalls: { count: number };
    freshReadCalls: { count: number };
    revisionsFor: (attemptId: string) => ManualGradeRevisionRow[];
    latestRevisionOf: (attemptId: string, questionRef: string) => ManualGradeRevisionRow | null;
    auditCount: (action: string) => number;
    versionOf: (attemptId: string) => number | null;
    attemptOf: (attemptId: string) => PendingManualAttemptRow | null;
    commitExternalGrade: (input: {
        attemptId: string; questionRef: string; expectedVersion: number;
        awardedHundredths: number; reviewerUserId: string;
    }) => Promise<boolean>;
    commitExternalFinalize: (input: {
        attemptId: string; expectedVersion: number; reviewerUserId: string;
    }) => Promise<boolean>;
}

const makeHarness = (): Harness => {
    const attempts = new Map<string, PendingManualAttemptRow>();
    const questions = new Map<string, PinnedQuestionRow[]>();
    const answers = new Map<string, ManualAnswerRow[]>();
    const revisions = new Map<string, ManualGradeRevisionRow[]>();
    const audits: AuditRow[] = [];
    const hooks: InterleavingHooks = {};
    const finalizeCasCalls = { count: 0 };
    const freshReadCalls = { count: 0 };
    const flags = { failList: false, failNextAudit: false };

    const revisionsFor = (attemptId: string): ManualGradeRevisionRow[] => revisions.get(attemptId) ?? [];

    const latestRevisionOf = (attemptId: string, questionRef: string): ManualGradeRevisionRow | null => {
        const rows = revisionsFor(attemptId).filter((row) => row.question_ref === questionRef);
        if (rows.length === 0) return null;
        return rows.reduce((latest, row) => (row.revision > latest.revision ? row : latest));
    };

    const bundleFor = (tenantId: string, attemptId: string): ManualGradingAttemptBundle | null => {
        const attempt = attempts.get(attemptId);
        if (!attempt || attempt.tenant_id !== tenantId) return null;
        return {
            attempt: { ...attempt },
            questions: (questions.get(attemptId) ?? []).map((row) => ({ ...row })),
            answers: (answers.get(attemptId) ?? []).map((row) => ({ ...row })),
            latestRevisions: (questions.get(attemptId) ?? [])
                .map((question) => latestRevisionOf(attemptId, question.ref))
                .filter((row): row is ManualGradeRevisionRow => row !== null)
                .map((row) => ({ ...row })),
        };
    };

    /** CAS-guarded revision append against the shared state. */
    const appendRevision = (
        input: AppendAnswerGradeRevisionInput,
        undo: Array<() => void> | null,
    ): { ok: true; newAttemptVersion: number } | { ok: false; reason: string } => {
        const attempt = attempts.get(input.attemptId);
        if (!attempt || attempt.tenant_id !== input.tenantId) return { ok: false, reason: 'attempt_missing' };
        if (attempt.status !== 'pending_review' || attempt.status !== input.expectedAttemptStatus) {
            return { ok: false, reason: 'attempt_not_pending' };
        }
        if (Number(attempt.version) !== input.expectedAttemptVersion) {
            return { ok: false, reason: 'attempt_version_conflict' };
        }
        const rows = revisionsFor(input.attemptId);
        if (rows.some((row) => row.question_ref === input.questionRef && row.revision === input.revision)) {
            return { ok: false, reason: 'duplicate_revision' };
        }
        const row: ManualGradeRevisionRow = {
            question_ref: input.questionRef,
            revision: input.revision,
            awarded_hundredths: input.awardedHundredths,
            reviewer_user_id: input.reviewerUserId,
            feedback: input.feedback,
            created_at: input.createdAt,
        };
        const rowIndex = rows.length;
        rows.push(row);
        revisions.set(input.attemptId, rows);
        attempts.set(input.attemptId, { ...attempt, version: input.expectedAttemptVersion + 1 });
        if (undo) {
            undo.push(() => {
                revisions.get(input.attemptId)?.splice(rowIndex, 1);
                attempts.set(input.attemptId, attempt);
            });
        }
        return { ok: true, newAttemptVersion: input.expectedAttemptVersion + 1 };
    };

    /** CAS-guarded finalize against the shared state. */
    const finalizeRow = (
        input: FinalizeAttemptInput,
        undo: Array<() => void> | null,
    ): { ok: true; newAttemptVersion: number } | { ok: false; reason: string } => {
        const attempt = attempts.get(input.attemptId);
        if (!attempt || attempt.tenant_id !== input.tenantId) return { ok: false, reason: 'attempt_missing' };
        if (attempt.status !== 'pending_review' || attempt.status !== input.expectedAttemptStatus) {
            return { ok: false, reason: 'attempt_not_pending' };
        }
        if (Number(attempt.version) !== input.expectedVersion) {
            return { ok: false, reason: 'attempt_version_conflict' };
        }
        attempts.set(input.attemptId, {
            ...attempt,
            status: 'graded',
            score: (input.scoreHundredths / 100).toFixed(2),
            reviewer_user_id: input.reviewerUserId,
            graded_at: input.gradedAt,
            passed: input.passed === true ? 1 : input.passed === false ? 0 : null,
            version: input.expectedVersion + 1,
        });
        if (undo) {
            undo.push(() => {
                attempts.set(input.attemptId, attempt);
            });
        }
        return { ok: true, newAttemptVersion: input.expectedVersion + 1 };
    };

    const readTxToken = (tx: ManualGradingStore): symbol | undefined => {
        const view = tx as { auditTxToken?: symbol };
        return view.auditTxToken;
    };

    const baseMethods: ManualGradingStore = {
        listPendingAttempts: async (input) => {
            if (flags.failList) {
                flags.failList = false;
                throw new Error('internal secret connection detail');
            }
            const allowed = new Set(input.examIds);
            return Array.from(attempts.values())
                .filter((row) => row.tenant_id === input.tenantId
                    && row.status === 'pending_review'
                    && allowed.has(row.exam_id))
                .sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')))
                .slice(0, input.limit)
                .map((row) => ({ ...row }));
        },
        loadAttemptForGrading: async (input) => bundleFor(input.tenantId, input.attemptId),
        appendAnswerGradeRevision: async (input) => appendRevision(input, null),
        finalizeAttempt: async (input) => finalizeRow(input, null),
    };

    const audit = async (tx: ManualGradingStore, input: ManualGradingAuditRecord): Promise<void> => {
        if (flags.failNextAudit) {
            flags.failNextAudit = false;
            audits.push({ record: input, txToken: readTxToken(tx) });
            throw new Error('audit sink unavailable');
        }
        audits.push({ record: input, txToken: readTxToken(tx) });
    };

    /** The router's real seam: same state, undo log, one-shot hook points. */
    const transaction = async <T>(fn: (tx: ManualGradingStore) => Promise<T>): Promise<T> => {
        const undo: Array<() => void> = [];
        const txToken = Symbol('tx');
        const txView: ManualGradingStore & { auditTxToken?: symbol } = {
            listPendingAttempts: baseMethods.listPendingAttempts,
            loadAttemptForGrading: async (input) => {
                const beforeFreshRead = hooks.beforeFreshRead;
                hooks.beforeFreshRead = undefined;
                await beforeFreshRead?.();
                freshReadCalls.count += 1;
                return bundleFor(input.tenantId, input.attemptId);
            },
            appendAnswerGradeRevision: async (input) => {
                const beforeAppendCas = hooks.beforeAppendCas;
                hooks.beforeAppendCas = undefined;
                await beforeAppendCas?.();
                return appendRevision(input, undo);
            },
            finalizeAttempt: async (input) => {
                const beforeFinalizeCas = hooks.beforeFinalizeCas;
                hooks.beforeFinalizeCas = undefined;
                await beforeFinalizeCas?.();
                finalizeCasCalls.count += 1;
                return finalizeRow(input, undo);
            },
            auditTxToken: txToken,
        };
        try {
            return await fn(txView);
        } catch (error) {
            for (let index = undo.length - 1; index >= 0; index -= 1) undo[index]();
            // SQL rollback also discards an audit row written on this connection
            // before the seam threw; leaving it would fake a committed audit.
            for (let index = audits.length - 1; index >= 0; index -= 1) {
                if (audits[index].txToken === txToken) audits.splice(index, 1);
            }
            throw error;
        }
    };

    /** Another actor's already-committed grade: CAS + bump + its own audit. */
    const commitExternalGrade = async (input: {
        attemptId: string; questionRef: string; expectedVersion: number;
        awardedHundredths: number; reviewerUserId: string;
    }): boolean => {
        const nextRevision = (latestRevisionOf(input.attemptId, input.questionRef)?.revision ?? 0) + 1;
        const outcome = await baseMethods.appendAnswerGradeRevision({
            tenantId: 'tenant-a',
            attemptId: input.attemptId,
            questionRef: input.questionRef,
            revision: nextRevision,
            expectedAttemptStatus: 'pending_review',
            expectedAttemptVersion: input.expectedVersion,
            awardedHundredths: input.awardedHundredths,
            reviewerUserId: input.reviewerUserId,
            feedback: null,
            createdAt: '2026-10-20T09:59:00.000Z',
        });
        if (!outcome.ok) return false;
        audits.push({
            record: {
                actorUserId: input.reviewerUserId,
                tenantId: 'tenant-a',
                action: 'exam_manual_grade.answer',
                resourceType: 'exam_attempt',
                resourceId: input.attemptId,
                oldValue: null,
                newValue: { question_ref: input.questionRef, revision: nextRevision },
            },
        });
        return true;
    };

    /** Another actor's already-committed finalize: re-plan + CAS + audit. */
    const commitExternalFinalize = async (input: {
        attemptId: string; expectedVersion: number; reviewerUserId: string;
    }): boolean => {
        const bundle = bundleFor('tenant-a', input.attemptId);
        if (!bundle) return false;
        const planned = planAttemptFinalize({
            attemptStatus: bundle.attempt.status,
            autoScore: bundle.attempt.auto_score,
            questions: bundle.questions,
            answers: bundle.answers,
            latestRevisions: bundle.latestRevisions,
            passingPoints: bundle.attempt.passing_points,
        });
        if (!planned.ok) return false;
        const outcome = await baseMethods.finalizeAttempt({
            tenantId: 'tenant-a',
            attemptId: input.attemptId,
            expectedAttemptStatus: 'pending_review',
            expectedVersion: input.expectedVersion,
            scoreHundredths: planned.plan.scoreHundredths,
            passed: planned.plan.passed,
            reviewerUserId: input.reviewerUserId,
            gradedAt: '2026-10-20T09:59:00.000Z',
        });
        if (!outcome.ok) return false;
        audits.push({
            record: {
                actorUserId: input.reviewerUserId,
                tenantId: 'tenant-a',
                action: 'exam_manual_grade.finalize',
                resourceType: 'exam_attempt',
                resourceId: input.attemptId,
                oldValue: null,
                newValue: { score_hundredths: planned.plan.scoreHundredths },
            },
        });
        return true;
    };

    return {
        store: baseMethods,
        audit,
        transaction,
        authority: {
            listAuthorizedExamIds: async (scope: ManualGradingScope) =>
                (GRANTS[`${scope.userId}:${scope.tenantId}`] ?? [])
                    .filter((examId) => EXAM_TENANT[examId] === scope.tenantId),
            authorizeExam: async (scope: ManualGradingScope, examId: string): Promise<ExamAuthorityDecision> => {
                if (EXAM_TENANT[examId] !== scope.tenantId) return 'not_found';
                return (GRANTS[`${scope.userId}:${scope.tenantId}`] ?? []).includes(examId) ? 'ok' : 'forbidden';
            },
        },
        hooks,
        flags,
        audits,
        attempts,
        questions,
        answers,
        revisions,
        finalizeCasCalls,
        freshReadCalls,
        revisionsFor,
        latestRevisionOf,
        auditCount: (action) => audits.filter((row) => row.record.action === action).length,
        versionOf: (attemptId) => {
            const attempt = attempts.get(attemptId);
            return attempt ? Number(attempt.version) : null;
        },
        attemptOf: (attemptId) => {
            const attempt = attempts.get(attemptId);
            return attempt ? { ...attempt } : null;
        },
        commitExternalGrade,
        commitExternalFinalize,
    };
};

const seed = (harness: Harness): void => {
    harness.attempts.set('attempt-a1', {
        id: 'attempt-a1', tenant_id: 'tenant-a', exam_id: 'exam-a', exam_version_id: 'version-a',
        student_enrollment_id: 'enr-1', student_user_id: 'student-1', status: 'pending_review',
        submitted_at: '2026-10-20 09:00:00', auto_score: '4.00', score: null,
        manual_required: 1, passing_points: '6.00', version: 3,
    });
    harness.questions.set('attempt-a1', [
        { ref: 'q-obj', position: 1, question_type: 'single_choice', points: '4.00' },
        { ref: 'q-essay', position: 2, question_type: 'essay', points: '5.00' },
    ]);
    harness.answers.set('attempt-a1', [
        {
            question_ref: 'q-obj', question_type: 'single_choice', response: 'b',
            awarded_points: '4.00', is_correct: 1, manual_review: 0,
        },
        {
            question_ref: 'q-essay', question_type: 'essay', response: 'discussion',
            awarded_points: null, is_correct: null, manual_review: 1,
        },
    ]);

    harness.attempts.set('attempt-a2', {
        id: 'attempt-a2', tenant_id: 'tenant-a', exam_id: 'exam-b', exam_version_id: 'version-b',
        student_enrollment_id: 'enr-2', student_user_id: 'student-2', status: 'pending_review',
        submitted_at: '2026-10-20 09:05:00', auto_score: '1.00', score: null,
        manual_required: 1, passing_points: '3.00', version: 1,
    });
    harness.questions.set('attempt-a2', [
        { ref: 'q-essay-b', position: 1, question_type: 'essay', points: '5.00' },
    ]);
    harness.answers.set('attempt-a2', [
        {
            question_ref: 'q-essay-b', question_type: 'essay', response: 'draft',
            awarded_points: null, is_correct: null, manual_review: 1,
        },
    ]);

    harness.attempts.set('attempt-b1', {
        id: 'attempt-b1', tenant_id: 'tenant-b', exam_id: 'exam-bt', exam_version_id: 'version-bt',
        student_enrollment_id: 'enr-b', student_user_id: 'student-b', status: 'pending_review',
        submitted_at: '2026-10-20 09:10:00', auto_score: '2.00', score: null,
        manual_required: 1, passing_points: '4.00', version: 0,
    });
    harness.questions.set('attempt-b1', [
        { ref: 'q-essay-bt', position: 1, question_type: 'essay', points: '5.00' },
    ]);
    harness.answers.set('attempt-b1', [
        {
            question_ref: 'q-essay-bt', question_type: 'essay', response: 'answer',
            awarded_points: null, is_correct: null, manual_review: 1,
        },
    ]);
};

const setup = () => {
    const harness = makeHarness();
    seed(harness);
    const router = createExamManualGradingRouter({
        store: harness.store,
        authenticate: createAuthenticateToken(authRepository()),
        authority: harness.authority,
        audit: harness.audit,
        transaction: harness.transaction,
        now: () => new Date('2026-10-20T10:00:00.000Z'),
    });
    return { harness, router };
};

const bodyOf = (response: CapturedResponse): Record<string, unknown> => {
    const body = response.body;
    assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body), 'expected a JSON object body');
    return body as Record<string, unknown>;
};

const idsOf = (response: CapturedResponse, key: string): string[] => {
    const value = bodyOf(response)[key];
    assert.ok(Array.isArray(value), `expected ${key} to be an array`);
    return value.map((entry) => {
        assert.ok(typeof entry === 'object' && entry !== null);
        const row = entry as Record<string, unknown>;
        assert.equal(typeof row['id'], 'string');
        return row['id'] as string;
    });
};

const silenceErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = (): void => {};
    try {
        return await fn();
    } finally {
        console.error = original;
    }
};

/* -------------------------------------------------------------------------- */
/* Pure state rules                                                           */
/* -------------------------------------------------------------------------- */

const ESSAY: PinnedQuestionRow = { ref: 'q-essay', position: 2, question_type: 'essay', points: '5.00' };

test('pure: only pending_review accepts answer grades and revisions increment by one', () => {
    const rejected = planManualAnswerGrade({
        attemptStatus: 'graded', manualReview: true, question: ESSAY, existingMaxRevision: 0, points: 1, feedback: null,
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error, 'attempt_not_pending');

    const first = planManualAnswerGrade({
        attemptStatus: 'pending_review', manualReview: true, question: ESSAY, existingMaxRevision: 0, points: 1.5, feedback: '  ok  ',
    });
    assert.equal(first.ok, true);
    if (first.ok) {
        assert.equal(first.plan.revision, 1);
        assert.equal(first.plan.awardedHundredths, 150);
        assert.equal(first.plan.feedback, 'ok');
    }

    const second = planManualAnswerGrade({
        attemptStatus: 'pending_review', manualReview: true, question: ESSAY, existingMaxRevision: 1, points: '2.5', feedback: null,
    });
    assert.equal(second.ok, true);
    if (second.ok) {
        assert.equal(second.plan.revision, 2);
        assert.equal(second.plan.awardedHundredths, 250);
    }

    const objective = planManualAnswerGrade({
        attemptStatus: 'pending_review', manualReview: false, question: ESSAY, existingMaxRevision: 0, points: 1, feedback: null,
    });
    assert.equal(objective.ok, false);
    if (!objective.ok) assert.equal(objective.error, 'question_not_manual_review');
});

test('pure: manual award is integer hundredths inside 0..pinned maximum', () => {
    const zero = validateManualAward(0, '5.00', undefined);
    assert.deepEqual(zero, { ok: true, value: { awardedHundredths: 0, feedback: null } });
    const max = validateManualAward('5.00', '5.00', '');
    assert.deepEqual(max, { ok: true, value: { awardedHundredths: 500, feedback: null } });
    assert.deepEqual(validateManualAward(5.01, '5.00', null), { ok: false, error: 'points_out_of_range' });
    assert.deepEqual(validateManualAward(-1, '5.00', null), { ok: false, error: 'invalid_points' });
    assert.deepEqual(validateManualAward('1.234', '5.00', null), { ok: false, error: 'invalid_points' });
    assert.deepEqual(validateManualAward(1, '5.00', 42), { ok: false, error: 'invalid_feedback' });
    assert.deepEqual(validateManualAward(1, '5.00', 'x'.repeat(2001)), { ok: false, error: 'feedback_too_long' });
});

test('pure: finalize recomputes exact total and refuses an ungraded manual answer', () => {
    const answers: ManualAnswerRow[] = [
        {
            question_ref: 'q-obj', question_type: 'single_choice', response: 'b',
            awarded_points: '4.00', is_correct: 1, manual_review: 0,
        },
        {
            question_ref: 'q-essay', question_type: 'essay', response: 'x',
            awarded_points: null, is_correct: null, manual_review: 1,
        },
    ];
    const questions: PinnedQuestionRow[] = [
        { ref: 'q-obj', position: 1, question_type: 'single_choice', points: '4.00' },
        ESSAY,
    ];
    const incomplete = planAttemptFinalize({
        attemptStatus: 'pending_review', autoScore: '4.00', questions, answers,
        latestRevisions: [], passingPoints: '6.00',
    });
    assert.equal(incomplete.ok, false);
    if (!incomplete.ok) assert.equal(incomplete.error, 'incomplete_manual_grading');

    const complete = planAttemptFinalize({
        attemptStatus: 'pending_review', autoScore: '4.00', questions, answers,
        latestRevisions: [{
            question_ref: 'q-essay', revision: 2, awarded_hundredths: 250,
            reviewer_user_id: 'instructor-a', feedback: null, created_at: '2026-10-20T10:00:00.000Z',
        }],
        passingPoints: '6.00',
    });
    assert.equal(complete.ok, true);
    if (complete.ok) {
        assert.equal(complete.plan.scoreHundredths, 650);
        assert.equal(complete.plan.score, '6.50');
        assert.equal(complete.plan.passed, true);
    }

    const outOfRange = planAttemptFinalize({
        attemptStatus: 'pending_review', autoScore: '4.00', questions, answers,
        latestRevisions: [{
            question_ref: 'q-essay', revision: 1, awarded_hundredths: 501,
            reviewer_user_id: 'instructor-a', feedback: null, created_at: '2026-10-20T10:00:00.000Z',
        }],
    });
    assert.equal(outOfRange.ok, false);
    if (!outOfRange.ok) assert.equal(outOfRange.error, 'invalid_manual_state');
});

test('pure: guard helpers parse expected versions and project CAS rejections', () => {
    assert.deepEqual(
        projectStoreMutationRejection('attempt_version_conflict'),
        { httpStatus: 409, code: 'attempt_version_conflict', error: 'Attempt changed concurrently' },
    );
    assert.deepEqual(
        projectStoreMutationRejection('attempt_not_pending'),
        { httpStatus: 409, code: 'attempt_not_pending', error: 'Attempt is no longer pending review' },
    );
    assert.deepEqual(
        projectStoreMutationRejection('attempt_missing'),
        { httpStatus: 404, code: 'attempt_missing', error: 'Attempt not found' },
    );
    assert.deepEqual(
        projectStoreMutationRejection('duplicate_revision'),
        { httpStatus: 409, code: 'duplicate_revision', error: 'Answer grade changed concurrently' },
    );
    assert.equal(normalizeAttemptVersion(3), 3);
    assert.equal(normalizeAttemptVersion('0'), 0);
    assert.equal(normalizeAttemptVersion(-1), null);
    assert.equal(normalizeAttemptVersion('1.5'), null);
    assert.equal(normalizeAttemptVersion('oops'), null);
    assert.equal(normalizeAttemptVersion(null), null);
});

/* -------------------------------------------------------------------------- */
/* Pending queue scope                                                        */
/* -------------------------------------------------------------------------- */

test('pending queue: a reviewer scoped to one course sees only that course', async () => {
    const { router } = setup();
    const own = await invokeRoute(router, { method: 'GET', url: '/pending', token: INSTRUCTOR_A });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(idsOf(own, 'attempts'), ['attempt-a1']);

    const owner = await invokeRoute(router, { method: 'GET', url: '/pending', token: OWNER_A });
    assert.equal(owner.statusCode, 200);
    assert.deepEqual(idsOf(owner, 'attempts').sort(), ['attempt-a1', 'attempt-a2']);

    const otherTenant = await invokeRoute(router, { method: 'GET', url: '/pending', token: OWNER_B });
    assert.equal(otherTenant.statusCode, 200);
    assert.deepEqual(idsOf(otherTenant, 'attempts'), ['attempt-b1']);
});

test('pending queue: malformed limit is 400 and store failure is a generic 500', async () => {
    const { harness, router } = setup();
    const badLimit = await invokeRoute(router, { method: 'GET', url: '/pending', query: { limit: '0' }, token: INSTRUCTOR_A });
    assert.equal(badLimit.statusCode, 400);

    harness.flags.failList = true;
    const failure = await silenceErrors(() => invokeRoute(router, {
        method: 'GET', url: '/pending', token: INSTRUCTOR_A,
    }));
    assert.equal(failure.statusCode, 500);
    const body = bodyOf(failure);
    assert.equal(body['error'], 'Failed to list pending attempts');
    assert.ok(!JSON.stringify(body).includes('secret'));
});

/* -------------------------------------------------------------------------- */
/* Denials                                                                    */
/* -------------------------------------------------------------------------- */

test('denials: unrelated same-tenant teacher, cross-tenant actor and student are refused', async () => {
    const { harness, router } = setup();

    const unrelatedRead = await invokeRoute(router, {
        method: 'GET', url: '/attempts/attempt-a1', token: TEACHER_X,
    });
    assert.equal(unrelatedRead.statusCode, 403);

    const unrelatedGrade = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: TEACHER_X, body: { points: 1 },
    });
    assert.equal(unrelatedGrade.statusCode, 403);

    const crossTenant = await invokeRoute(router, {
        method: 'GET', url: '/attempts/attempt-a1', token: OWNER_B,
    });
    assert.equal(crossTenant.statusCode, 404);

    for (const request of [
        { method: 'GET', url: '/pending' },
        { method: 'GET', url: '/attempts/attempt-a1' },
        { method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade', body: { points: 1 } },
        { method: 'POST', url: '/attempts/attempt-a1/finalize' },
    ]) {
        const response = await invokeRoute(router, { ...request, token: STUDENT_A });
        assert.equal(response.statusCode, 403, `${request.method} ${request.url} must deny a student`);
    }

    assert.equal(harness.revisionsFor('attempt-a1').length, 0);
    assert.equal(harness.audits.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Grading                                                                    */
/* -------------------------------------------------------------------------- */

test('grade: out-of-range or malformed points are 400 and write nothing', async () => {
    const { harness, router } = setup();
    for (const points of [5.01, -1, '1.234', 'abc']) {
        const response = await invokeRoute(router, {
            method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
            token: INSTRUCTOR_A, body: { points },
        });
        assert.equal(response.statusCode, 400, `points ${String(points)} must be rejected`);
        assert.ok(['invalid_points', 'points_out_of_range'].includes(String(bodyOf(response)['code'])));
    }
    assert.equal(harness.revisionsFor('attempt-a1').length, 0);
    assert.equal(harness.audits.length, 0);
});

test('grade: an objective answer is refused because its auto award already counts (409)', async () => {
    const { harness, router } = setup();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-obj/grade',
        token: INSTRUCTOR_A, body: { points: 1 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'question_not_manual_review');
    assert.equal(harness.revisionsFor('attempt-a1').length, 0);
    assert.equal(harness.audits.length, 0);
});

test('grade: every successful revision CAS-bumps the attempt version and audits', async () => {
    const { harness, router } = setup();
    assert.equal(harness.versionOf('attempt-a1'), 3);

    const first = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 1.5, feedback: 'first pass' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(bodyOf(first)['revision'], 1);
    assert.equal(bodyOf(first)['awarded_points'], '1.50');
    assert.equal(bodyOf(first)['attempt_version'], 4);
    assert.equal(harness.versionOf('attempt-a1'), 4);

    const second = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: '2.5' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(bodyOf(second)['revision'], 2);
    assert.equal(bodyOf(second)['awarded_points'], '2.50');
    assert.equal(harness.versionOf('attempt-a1'), 5);

    const history = harness.revisionsFor('attempt-a1');
    assert.deepEqual(history.map((row) => row.revision), [1, 2]);
    assert.deepEqual(history.map((row) => row.awarded_hundredths), [150, 250]);
    assert.equal(harness.auditCount('exam_manual_grade.answer'), 2);

    const view = await invokeRoute(router, {
        method: 'GET', url: '/attempts/attempt-a1', token: INSTRUCTOR_A,
    });
    assert.equal(view.statusCode, 200);
    const answers = bodyOf(view)['answers'];
    assert.ok(Array.isArray(answers));
    const essay = (answers as Array<Record<string, unknown>>).find((row) => row['question_ref'] === 'q-essay');
    assert.ok(essay);
    assert.equal(essay['latest_revision'], 2);
    assert.equal(essay['latest_awarded_points'], '2.50');
});

test('grade: graded attempt refuses a new revision (409) without a write', async () => {
    const { harness, router } = setup();
    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    harness.attempts.set('attempt-a1', { ...attempt, status: 'graded' });

    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 1 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'attempt_not_pending');
    assert.equal(harness.revisionsFor('attempt-a1').length, 0);
    assert.equal(harness.audits.length, 0);
});

test('grade: a malformed stored attempt version is 409 with no write', async () => {
    const { harness, router } = setup();
    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    harness.attempts.set('attempt-a1', { ...attempt, version: 'oops' });

    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 1 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'invalid_manual_state');
    assert.equal(harness.revisionsFor('attempt-a1').length, 0);
    assert.equal(harness.audits.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Interleaving (a) + (c): racing writers at the revision CAS                 */
/* -------------------------------------------------------------------------- */

test('interleave: a finalize committed between a grade read and its CAS rejects the grade', async () => {
    const { harness, router } = setup();
    harness.revisions.set('attempt-a1', [{
        question_ref: 'q-essay', revision: 1, awarded_hundredths: 250,
        reviewer_user_id: 'reviewer-1', feedback: null, created_at: '2026-10-20T09:30:00.000Z',
    }]);

    harness.hooks.beforeAppendCas = async () => {
        const committed = await harness.commitExternalFinalize({
            attemptId: 'attempt-a1', expectedVersion: 3, reviewerUserId: 'reviewer-2',
        });
        assert.equal(committed, true, 'external finalize must commit during the interleave');
    };

    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 1 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'attempt_not_pending');

    assert.equal(harness.revisionsFor('attempt-a1').length, 1);
    assert.equal(harness.latestRevisionOf('attempt-a1', 'q-essay')?.revision, 1);
    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    assert.equal(attempt.status, 'graded');
    assert.equal(harness.versionOf('attempt-a1'), 4);
    assert.equal(harness.auditCount('exam_manual_grade.answer'), 0);
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 1);
});

test('interleave: two concurrent grades — one wins, the other is 409, history stays consecutive', async () => {
    const { harness, router } = setup();

    harness.hooks.beforeAppendCas = async () => {
        // Another actor's grade of the same answer commits first (its read
        // happened before this request started; it CASes on version 3).
        const committed = await harness.commitExternalGrade({
            attemptId: 'attempt-a1', questionRef: 'q-essay', expectedVersion: 3,
            awardedHundredths: 100, reviewerUserId: 'reviewer-2',
        });
        assert.equal(committed, true, 'the racing external grade must commit during the interleave');
    };

    const loser = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 2 },
    });
    assert.equal(loser.statusCode, 409);
    assert.equal(bodyOf(loser)['code'], 'attempt_version_conflict');
    assert.equal(harness.revisionsFor('attempt-a1').length, 1);
    assert.equal(harness.versionOf('attempt-a1'), 4);

    // The winner's revision is revision 1; a later regrade continues at 2.
    const later = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 2.5 },
    });
    assert.equal(later.statusCode, 200);
    assert.equal(bodyOf(later)['revision'], 2);

    const history = harness.revisionsFor('attempt-a1');
    assert.deepEqual(history.map((row) => row.revision), [1, 2]);
    assert.deepEqual(history.map((row) => row.awarded_hundredths), [100, 250]);
    assert.equal(harness.auditCount('exam_manual_grade.answer'), 2);
});

/* -------------------------------------------------------------------------- */
/* Finalize                                                                   */
/* -------------------------------------------------------------------------- */

test('finalize: recomputes the total from an in-transaction read and finalizes once', async () => {
    const { harness, router } = setup();
    const graded = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
        token: INSTRUCTOR_A, body: { points: 2.5 },
    });
    assert.equal(graded.statusCode, 200);
    assert.equal(harness.versionOf('attempt-a1'), 4);

    const finalized = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(finalized.statusCode, 200);
    const body = bodyOf(finalized);
    assert.equal(body['status'], 'graded');
    assert.equal(body['score'], '6.50');
    assert.equal(body['score_hundredths'], 650);
    assert.equal(body['passed'], true);
    assert.equal(body['version'], 5);
    assert.deepEqual(body['included_revisions'], [{ question_ref: 'q-essay', revision: 1 }]);

    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    assert.equal(attempt.status, 'graded');
    assert.equal(attempt.score, '6.50');
    assert.equal(Number(attempt.version), 5);
    assert.equal(attempt.reviewer_user_id, 'instructor-a');
    assert.equal(harness.freshReadCalls.count, 1);
    assert.equal(harness.finalizeCasCalls.count, 1);
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 1);

    const second = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(second.statusCode, 409);
    assert.equal(bodyOf(second)['code'], 'already_finalized');
    assert.equal(harness.finalizeCasCalls.count, 1);
    assert.equal(harness.freshReadCalls.count, 2);
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 1);
});

test('finalize: a revision committed before the transaction re-read is included in the total', async () => {
    const { harness, router } = setup();
    // The racing grade commits exactly when finalize's in-transaction re-read
    // starts: the pre-transaction bundle never saw it, but the re-read must.
    harness.hooks.beforeFreshRead = async () => {
        const committed = await harness.commitExternalGrade({
            attemptId: 'attempt-a1', questionRef: 'q-essay', expectedVersion: 3,
            awardedHundredths: 250, reviewerUserId: 'reviewer-2',
        });
        assert.equal(committed, true, 'the racing grade must commit before the fresh read');
    };

    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(response.statusCode, 200);
    const body = bodyOf(response);
    assert.equal(body['score_hundredths'], 650);
    assert.equal(body['score'], '6.50');
    assert.equal(body['version'], 5);
    assert.deepEqual(body['included_revisions'], [{ question_ref: 'q-essay', revision: 1 }]);

    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    assert.equal(attempt.status, 'graded');
    assert.equal(attempt.score, '6.50');
    assert.equal(harness.freshReadCalls.count, 1);
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 1);
    assert.equal(harness.auditCount('exam_manual_grade.answer'), 1);
});

test('finalize: a revision committed between the re-read and the CAS yields 409, never a stale total', async () => {
    const { harness, router } = setup();
    // A complete (gradeable) attempt is required to reach the finalize CAS at
    // all: without revision 1 the in-transaction plan refuses as incomplete
    // before any CAS and the interleaving would never be exercised.
    harness.revisions.set('attempt-a1', [{
        question_ref: 'q-essay', revision: 1, awarded_hundredths: 100,
        reviewer_user_id: 'reviewer-1', feedback: null, created_at: '2026-10-20T09:30:00.000Z',
    }]);
    harness.hooks.beforeFinalizeCas = async () => {
        const committed = await harness.commitExternalGrade({
            attemptId: 'attempt-a1', questionRef: 'q-essay', expectedVersion: 3,
            awardedHundredths: 250, reviewerUserId: 'reviewer-2',
        });
        assert.equal(committed, true, 'the racing grade must commit before the finalize CAS');
    };

    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'attempt_version_conflict');
    assert.equal(bodyOf(response)['score_hundredths'], undefined);
    assert.equal(harness.freshReadCalls.count, 1);
    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    assert.equal(attempt.status, 'pending_review');
    assert.equal(harness.versionOf('attempt-a1'), 4);
    assert.equal(harness.revisionsFor('attempt-a1').length, 2);
    assert.equal(harness.latestRevisionOf('attempt-a1', 'q-essay')?.revision, 2);
    assert.equal(harness.latestRevisionOf('attempt-a1', 'q-essay')?.awarded_hundredths, 250);
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 0);

    // A retry must finalize with the NEW revision included (never a stale total).
    const retry = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(bodyOf(retry)['score_hundredths'], 650);
    const finalized = harness.attemptOf('attempt-a1');
    assert.ok(finalized);
    assert.equal(finalized.status, 'graded');
    assert.equal(finalized.score, '6.50');
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 1);
});

test('finalize: an ungraded manual answer is refused (409) after the in-transaction re-read', async () => {
    const { harness, router } = setup();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'incomplete_manual_grading');
    assert.equal(harness.finalizeCasCalls.count, 0);
    assert.equal(harness.freshReadCalls.count, 1);
    assert.equal(harness.audits.length, 0);
    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    assert.equal(attempt.status, 'pending_review');
    assert.equal(harness.versionOf('attempt-a1'), 3);
});

test('finalize: a finalize committed by another actor before the re-read is 409 with no double audit', async () => {
    const { harness, router } = setup();
    harness.revisions.set('attempt-a1', [{
        question_ref: 'q-essay', revision: 1, awarded_hundredths: 250,
        reviewer_user_id: 'reviewer-1', feedback: null, created_at: '2026-10-20T09:30:00.000Z',
    }]);
    harness.hooks.beforeFreshRead = async () => {
        const committed = await harness.commitExternalFinalize({
            attemptId: 'attempt-a1', expectedVersion: 3, reviewerUserId: 'reviewer-2',
        });
        assert.equal(committed, true, 'the racing external finalize must commit during the interleave');
    };

    const response = await invokeRoute(router, {
        method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response)['code'], 'already_finalized');
    assert.equal(harness.finalizeCasCalls.count, 0);
    assert.equal(harness.auditCount('exam_manual_grade.finalize'), 1);
    const finalizes = harness.audits.filter((row) => row.record.action === 'exam_manual_grade.finalize');
    assert.equal(finalizes[0].record.actorUserId, 'reviewer-2');
    const attempt = harness.attemptOf('attempt-a1');
    assert.ok(attempt);
    assert.equal(attempt.status, 'graded');
    assert.equal(harness.versionOf('attempt-a1'), 4);
    assert.equal(attempt.score, '6.50');
});

test('audit failure rolls the answer grade and the finalize fully back', async () => {
    {
        const { harness, router } = setup();
        harness.flags.failNextAudit = true;
        const response = await silenceErrors(() => invokeRoute(router, {
            method: 'POST', url: '/attempts/attempt-a1/answers/q-essay/grade',
            token: INSTRUCTOR_A, body: { points: 2 },
        }));
        assert.equal(response.statusCode, 500);
        assert.equal(harness.revisionsFor('attempt-a1').length, 0);
        assert.equal(harness.audits.length, 0);
        assert.equal(harness.versionOf('attempt-a1'), 3);
    }
    {
        const { harness, router } = setup();
        harness.revisions.set('attempt-a1', [{
            question_ref: 'q-essay', revision: 1, awarded_hundredths: 250,
            reviewer_user_id: 'instructor-a', feedback: null, created_at: '2026-10-20T09:30:00.000Z',
        }]);
        harness.flags.failNextAudit = true;
        const response = await silenceErrors(() => invokeRoute(router, {
            method: 'POST', url: '/attempts/attempt-a1/finalize', token: INSTRUCTOR_A,
        }));
        assert.equal(response.statusCode, 500);
        const attempt = harness.attemptOf('attempt-a1');
        assert.ok(attempt);
        assert.equal(attempt.status, 'pending_review');
        assert.equal(harness.versionOf('attempt-a1'), 3);
        assert.equal(harness.audits.length, 0);
    }
});
