import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    DEFAULT_SCORING_POLICY,
    GRADING_POLICY_VERSION,
    computeGradingFingerprint,
    formatHundredths,
    gradeAttempt,
    normalizeAnswerMap,
    normalizeScoringPolicy,
    shouldApplyRegrade,
    toHundredths,
    type GradingQuestion,
} from '../src/services/exam-grading';
import { createExamVersionsRouter, type ExamVersionsDataAccess } from '../src/routes/exam-versions';
import {
    ExecutedStatement,
    TEST_SECRET,
    invokeRoute,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Pure scoring policy
// ---------------------------------------------------------------------------

test('toHundredths: accepts two-decimal values and float-drift-safe sums', () => {
    assert.equal(toHundredths(2), 200);
    assert.equal(toHundredths(0), 0);
    assert.equal(toHundredths('2.50'), 250);
    assert.equal(toHundredths('2.5'), 250);
    assert.equal(toHundredths(2.55), 255);
    assert.equal(toHundredths(0.1 + 0.2), 30);
});

test('toHundredths: fails closed on negatives, three decimals and non-finite values', () => {
    assert.equal(toHundredths(-1), null);
    assert.equal(toHundredths('1.234'), null);
    assert.equal(toHundredths(1.234), null);
    assert.equal(toHundredths(Number.NaN), null);
    assert.equal(toHundredths(Number.POSITIVE_INFINITY), null);
    assert.equal(toHundredths(null), null);
    assert.equal(toHundredths('abc'), null);
    assert.equal(toHundredths({}), null);
});

test('formatHundredths: canonical two-decimal rendering including negatives', () => {
    assert.equal(formatHundredths(250), '2.50');
    assert.equal(formatHundredths(0), '0.00');
    assert.equal(formatHundredths(5), '0.05');
    assert.equal(formatHundredths(-150), '-1.50');
});

test('normalizeScoringPolicy: defaults, snake_case and malformed rejection', () => {
    assert.deepEqual(normalizeScoringPolicy(undefined), { ...DEFAULT_SCORING_POLICY });
    assert.deepEqual(normalizeScoringPolicy(null), { ...DEFAULT_SCORING_POLICY });
    assert.deepEqual(normalizeScoringPolicy({}), { ...DEFAULT_SCORING_POLICY });
    assert.deepEqual(
        normalizeScoringPolicy({ negativeMarking: true, negativeFraction: 0.25, partialCredit: true }),
        { negativeMarking: true, negativeFraction: 0.25, partialCredit: true },
    );
    assert.deepEqual(
        normalizeScoringPolicy({ negative_marking: true, negative_fraction: 0.5 }),
        { negativeMarking: true, negativeFraction: 0.5, partialCredit: false },
    );
    assert.equal(normalizeScoringPolicy({ negativeMarking: true }), null);
    assert.equal(normalizeScoringPolicy({ negativeFraction: 1.5 }), null);
    assert.equal(normalizeScoringPolicy({ negativeFraction: 'abc' }), null);
    assert.equal(normalizeScoringPolicy({ partialCredit: 'yes' }), null);
    assert.equal(normalizeScoringPolicy(42), null);
});

const Q_SINGLE: GradingQuestion = { ref: 'q1', position: 1, questionType: 'single_choice', points: 2, correctAnswers: ['b'] };
const Q_MULTI: GradingQuestion = { ref: 'q2', position: 2, questionType: 'multiple_choice', points: 3, correctAnswers: ['a', 'c'] };
const Q_TF: GradingQuestion = { ref: 'q3', position: 3, questionType: 'true_false', points: 1, correctAnswers: ['true'] };
const Q_ESSAY: GradingQuestion = { ref: 'q4', position: 4, questionType: 'essay', points: 5, correctAnswers: [] };

test('gradeAttempt: all-correct objective answers plus an essay forces manual review', () => {
    const result = gradeAttempt(
        [Q_SINGLE, Q_MULTI, Q_TF, Q_ESSAY],
        { q1: 'b', q2: ['c', 'a'], q3: 'true', q4: 'discussion' },
        DEFAULT_SCORING_POLICY,
    );
    assert.equal(result.autoScoreHundredths, 600);
    assert.equal(result.manualRequired, true);
    assert.equal(result.questions[0].isCorrect, true);
    assert.equal(result.questions[1].isCorrect, true);
    assert.equal(result.questions[3].autoGraded, false);
    assert.equal(result.questions[3].awardedHundredths, null);
});

test('gradeAttempt: wrong and blank objective answers score zero (no negative marking)', () => {
    const wrong = gradeAttempt([Q_SINGLE], { q1: 'a' }, DEFAULT_SCORING_POLICY);
    assert.equal(wrong.autoScoreHundredths, 0);
    assert.equal(wrong.questions[0].isCorrect, false);
    const blank = gradeAttempt([Q_SINGLE], {}, DEFAULT_SCORING_POLICY);
    assert.equal(blank.autoScoreHundredths, 0);
});

test('gradeAttempt: negative marking penalises only fully wrong objective answers', () => {
    const policy = { negativeMarking: true, negativeFraction: 0.5, partialCredit: false };
    const single = gradeAttempt([Q_SINGLE], { q1: 'a' }, policy);
    assert.equal(single.autoScoreHundredths, -100);
    const multi = gradeAttempt([Q_MULTI], { q2: ['b'] }, policy);
    assert.equal(multi.autoScoreHundredths, -150);
});

test('gradeAttempt: multiple_choice is all-or-nothing unless partialCredit is enabled', () => {
    const partial = { negativeMarking: false, negativeFraction: 0, partialCredit: true };
    assert.equal(gradeAttempt([Q_MULTI], { q2: ['a'] }, DEFAULT_SCORING_POLICY).autoScoreHundredths, 0);
    assert.equal(gradeAttempt([Q_MULTI], { q2: ['a'] }, partial).autoScoreHundredths, 150);
    assert.equal(gradeAttempt([Q_MULTI], { q2: ['a', 'b'] }, partial).autoScoreHundredths, 0);
    assert.equal(gradeAttempt([Q_MULTI], { q2: [] }, partial).autoScoreHundredths, 0);
});

test('gradeAttempt: unknown or invalid questions route to manual review, never a wrong auto-award', () => {
    const unknown: GradingQuestion = { ref: 'q9', position: 1, questionType: 'short_answer', points: 1, correctAnswers: [] };
    const badPoints: GradingQuestion = { ref: 'q10', position: 2, questionType: 'single_choice', points: 1.234, correctAnswers: ['a'] };
    const result = gradeAttempt([unknown, badPoints], { q9: 'x', q10: 'a' }, DEFAULT_SCORING_POLICY);
    assert.equal(result.manualRequired, true);
    assert.equal(result.autoScoreHundredths, 0);
    assert.equal(result.questions.every((entry) => entry.autoGraded === false), true);
});

test('gradeAttempt: results are ordered by snapshot position, not input order', () => {
    const result = gradeAttempt([Q_TF, Q_SINGLE], { q1: 'b', q3: 'true' }, DEFAULT_SCORING_POLICY);
    assert.deepEqual(result.questions.map((entry) => entry.ref), ['q1', 'q3']);
});

test('computeGradingFingerprint: deterministic, answer-order independent and input sensitive', () => {
    const questions = [Q_SINGLE, Q_MULTI];
    const base = { versionId: 'ver-1', policy: DEFAULT_SCORING_POLICY, questions };
    const one = computeGradingFingerprint({ ...base, answers: { q1: 'b', q2: ['a', 'c'] } });
    const two = computeGradingFingerprint({ ...base, answers: { q2: ['c', 'a'], q1: 'b' } });
    assert.equal(one, two);
    assert.match(one, /^[a-f0-9]{64}$/);
    assert.notEqual(one, computeGradingFingerprint({ ...base, answers: { q1: 'a', q2: ['a', 'c'] } }));
    assert.notEqual(one, computeGradingFingerprint({ ...base, versionId: 'ver-2', answers: { q1: 'b', q2: ['a', 'c'] } }));
    assert.notEqual(one, computeGradingFingerprint({
        ...base,
        policy: { negativeMarking: true, negativeFraction: 0.5, partialCredit: false },
        answers: { q1: 'b', q2: ['a', 'c'] },
    }));
    assert.equal(GRADING_POLICY_VERSION, 1);
});

test('shouldApplyRegrade: only a changed fingerprint re-applies', () => {
    assert.equal(shouldApplyRegrade(null, 'abc'), true);
    assert.equal(shouldApplyRegrade('abc', 'abc'), false);
    assert.equal(shouldApplyRegrade('abc', 'def'), true);
});

test('normalizeAnswerMap: prototype-safe, drops dunder keys and non-records', () => {
    assert.deepEqual(normalizeAnswerMap(null), {});
    assert.deepEqual(normalizeAnswerMap('x'), {});
    const parsed = JSON.parse('{"__hidden":1,"q1":"b"}') as unknown;
    assert.deepEqual(Object.keys(normalizeAnswerMap(parsed)), ['q1']);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });

const AUTHORITY: Record<string, { tenant: string; authority: string }> = {
    'instructor-a': { tenant: 'tenant-a', authority: 'instructor' },
    'owner-a': { tenant: 'tenant-a', authority: 'owner' },
};

const VERSION_ROW = {
    id: 'ver-1', exam_id: 'exam-1', tenant_id: 'tenant-a', version: 1, status: 'published',
    duration_seconds: 3600, opens_at: null, closes_at: null, grace_seconds: 0,
    total_points: 6, passing_points: 6, scoring_policy: null, published_at: '2026-01-01 00:00:00',
};

const QUESTION_ROWS = [
    {
        id: 'eq-1', exam_version_id: 'ver-1', tenant_id: 'tenant-a', position: 1, question_id: 'q1',
        question_version: 1, source_version_id: 'sv-1', question_type: 'single_choice', question_text: '2+2?',
        options: '["3","4"]', correct_answers: '["4"]', points: 2, explanation: null, content_hash: 'h1',
    },
    {
        id: 'eq-2', exam_version_id: 'ver-1', tenant_id: 'tenant-a', position: 2, question_id: 'q2',
        question_version: 1, source_version_id: 'sv-2', question_type: 'multiple_choice', question_text: 'pick a,c',
        options: '["a","b","c"]', correct_answers: '["a","c"]', points: 3, explanation: null, content_hash: 'h2',
    },
    {
        id: 'eq-3', exam_version_id: 'ver-1', tenant_id: 'tenant-a', position: 3, question_id: 'q3',
        question_version: 1, source_version_id: 'sv-3', question_type: 'true_false', question_text: 'sky blue?',
        options: null, correct_answers: '["true"]', points: 1, explanation: null, content_hash: 'h3',
    },
];

const ATTEMPT_ROW = {
    id: 'attempt-1', tenant_id: 'tenant-a', exam_id: 'exam-1', exam_version_id: 'ver-1',
    student_enrollment_id: 'enr-a', student_user_id: 'student-a', status: 'in_progress',
    started_at: '2026-06-01 09:59:00', deadline_at: '2026-06-01 10:59:00', submitted_at: null,
    auto_submitted: 0, auto_score: null, score: null, manual_required: 0,
    grading_fingerprint: null, graded_at: null, passed: null,
};

const ENROLLMENT_ROW = {
    id: 'enr-a', tenant_id: 'tenant-a', group_id: 'grp-1', branch_id: null, branch_scope: null,
};

const CORRECT_ANSWERS: Record<string, unknown> = { 'eq-1': '4', 'eq-2': ['a', 'c'], 'eq-3': 'true' };

interface Fixtures {
    exam?: Record<string, unknown> | null;
    version?: Record<string, unknown> | null;
    questions?: Record<string, unknown>[];
    attempt?: Record<string, unknown> | null;
    existingAttempt?: Record<string, unknown> | null;
    enrollment?: Record<string, unknown> | null;
    targets?: Record<string, unknown>[];
    storedAnswers?: Record<string, unknown>[];
}

interface BuildOptions {
    auditThrows?: boolean;
    updateAffected?: number;
    now?: Date;
}

const gradingQuestions = (rows: Record<string, unknown>[]) => rows.map((row) => ({
    ref: String(row.id),
    position: Number(row.position),
    questionType: String(row.question_type),
    points: Number(row.points),
    correctAnswers: JSON.parse(String(row.correct_answers)) as string[],
}));

const build = (fixtures: Fixtures = {}, opts: BuildOptions = {}) => {
    const responder = (sql: string, params: unknown[]): unknown[] | null => {
        if (sql.includes('FROM exams e INNER JOIN courses c')) {
            return fixtures.exam === null ? [] : [fixtures.exam ?? { id: params[0] }];
        }
        if (sql.includes('COALESCE(MAX(version)')) return [{ next_version: 1 }];
        if (sql.includes('FROM exam_version_questions')) return fixtures.questions ?? [];
        if (sql.includes('FROM exam_versioned_answers')) return fixtures.storedAnswers ?? [];
        if (sql.includes('exam_grading_runs')) return [];
        if (sql.includes('FROM exam_versioned_attempts')) {
            if (sql.includes('WHERE id = ?')) return fixtures.attempt === null ? [] : [fixtures.attempt ?? ATTEMPT_ROW];
            return fixtures.existingAttempt ? [fixtures.existingAttempt] : [];
        }
        if (sql.includes('FROM exam_versions')) return fixtures.version === null ? [] : [fixtures.version ?? VERSION_ROW];
        if (sql.includes('FROM question_bank_versions')) return [];
        if (sql.includes('FROM exam_groups')) return fixtures.targets ?? [];
        if (sql.includes('FROM students s')) return fixtures.enrollment === null ? [] : [fixtures.enrollment ?? ENROLLMENT_ROW];
        return [];
    };
    const base = makeFakeDataAccess(responder);
    const execute = async (sql: string, params: unknown[] = []) => {
        if (opts.auditThrows && sql.includes('INSERT INTO audit_events')) {
            base.executed.push({ sql, params, kind: 'execute' });
            throw new Error('audit unavailable');
        }
        if (opts.updateAffected !== undefined && sql.includes('UPDATE exam_versioned_attempts')) {
            base.executed.push({ sql, params, kind: 'execute' });
            return { affectedRows: opts.updateAffected };
        }
        return base.execute(sql, params);
    };
    const db: ExamVersionsDataAccess = { query: base.query, queryOne: base.queryOne, execute };
    const repository = makeRepository(
        {
            'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        },
        {
            instructorAccounts: {
                'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: {
                'instructor-a': [{ tenant_id: 'tenant-a' }],
                'owner-a': [{ tenant_id: 'tenant-a' }],
                'instructor-b': [{ tenant_id: 'tenant-b' }],
            },
            enrollments: {
                'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null }],
            },
        },
    );
    const router = createExamVersionsRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async (userId, tenantId) => {
            const entry = AUTHORITY[userId];
            return entry && entry.tenant === tenantId ? { authority: entry.authority } : null;
        },
        now: () => opts.now ?? new Date('2026-06-01T10:00:00Z'),
        transaction: async <T>(fn: (tx: ExamVersionsDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: base.executed };
};

const auditAction = (executed: ExecutedStatement[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

// ---- POST /attempts/:attemptId/submit -------------------------------------

test('submit: anonymous is 401 with no data access', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', body: { answers: {} } });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('submit: a non-owner student is denied 404 with no write', async () => {
    const { router, executed } = build({ attempt: { ...ATTEMPT_ROW, student_enrollment_id: 'enr-x' } });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')), false);
});

test('submit: an unknown answer reference is rejected 400 with no write', async () => {
    const { router, executed } = build({ questions: QUESTION_ROWS });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: { nope: 'x' } } });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')), false);
});

test('submit: an already-submitted attempt is 409', async () => {
    const { router } = build({ attempt: { ...ATTEMPT_ROW, status: 'graded' } });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 409);
});

test('submit: grades the snapshot, writes the award ledger and audits', async () => {
    const { router, executed } = build({ questions: QUESTION_ROWS });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.status, 'graded');
    assert.equal(body.auto_score, 6);
    assert.equal(body.manual_required, false);
    assert.equal(body.late, false);
    const update = executed.find((e) => e.sql.includes('UPDATE exam_versioned_attempts'));
    assert.ok(update);
    assert.equal(update!.params[0], 'graded');
    assert.equal(update!.params[1], '6.00');
    assert.equal(update!.params[6], 1, 'passed flag is set from passing_points');
    assert.equal(executed.filter((e) => e.sql.includes('INSERT INTO exam_versioned_answers')).length, 3);
    assert.ok(executed.some((e) => e.sql.includes('INSERT IGNORE INTO exam_grading_runs')));
    assert.ok(auditAction(executed, 'exam_attempt.submit'));
});

test('submit: an essay routes the attempt to pending_review with no auto score', async () => {
    const essay = {
        id: 'eq-4', exam_version_id: 'ver-1', tenant_id: 'tenant-a', position: 4, question_id: 'q4',
        question_version: 1, source_version_id: 'sv-4', question_type: 'essay', question_text: 'discuss',
        options: null, correct_answers: null, points: 5, explanation: null, content_hash: 'h4',
    };
    const { router, executed } = build({ questions: [...QUESTION_ROWS, essay] });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.status, 'pending_review');
    assert.equal(body.manual_required, true);
    assert.equal(body.auto_score, 6);
    const update = executed.find((e) => e.sql.includes('UPDATE exam_versioned_attempts'));
    assert.equal(update!.params[2], null, 'the recorded score is withheld pending manual review');
    assert.equal(update!.params[6], null, 'the pass flag is unknown pending manual review');
});

test('submit: a late submit inside the grace window is rejected 403 with no write', async () => {
    const { router, executed } = build(
        { version: { ...VERSION_ROW, grace_seconds: 300 }, attempt: { ...ATTEMPT_ROW, started_at: '2026-06-01 09:00:00' }, questions: QUESTION_ROWS },
        { now: new Date('2026-06-01T10:02:00Z') },
    );
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as Record<string, unknown>).code, 'LATE_REJECTED');
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')), false);
});

test('submit: an expired window is rejected 403', async () => {
    const { router } = build(
        { attempt: { ...ATTEMPT_ROW, started_at: '2026-06-01 09:00:00' }, questions: QUESTION_ROWS },
        { now: new Date('2026-06-01T11:00:00Z') },
    );
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as Record<string, unknown>).code, 'EXPIRED');
});

test('submit: a concurrent submit (zero affected rows) is 409', async () => {
    const { router } = build({ questions: QUESTION_ROWS }, { updateAffected: 0 });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 409);
});

test('submit: an audit failure aborts with 500 rather than committing unaudited', async () => {
    const { router } = build({ questions: QUESTION_ROWS }, { auditThrows: true });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/submit', token: STUDENT_A, body: { answers: CORRECT_ANSWERS } });
    assert.equal(response.statusCode, 500);
});

// ---- POST /attempts/:attemptId/regrade ------------------------------------

test('regrade: a student is not authorized 403 and a cross-tenant instructor is 403', async () => {
    const student = build({});
    assert.equal((await invokeRoute(student.router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: STUDENT_A })).statusCode, 403);
    const cross = build({});
    assert.equal((await invokeRoute(cross.router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_B })).statusCode, 403);
});

test('regrade: an in-progress attempt is 409', async () => {
    const { router } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 409);
});

test('regrade: re-applies a changed fingerprint and audits it', async () => {
    const { router, executed } = build({
        attempt: { ...ATTEMPT_ROW, status: 'graded', grading_fingerprint: 'old' },
        questions: QUESTION_ROWS,
        storedAnswers: [
            { id: 'a1', question_ref: 'eq-1', question_type: 'single_choice', response: '"4"', awarded_points: '2.00', is_correct: 1, manual_review: 0 },
            { id: 'a2', question_ref: 'eq-2', question_type: 'multiple_choice', response: '["a","c"]', awarded_points: '3.00', is_correct: 1, manual_review: 0 },
            { id: 'a3', question_ref: 'eq-3', question_type: 'true_false', response: '"true"', awarded_points: '1.00', is_correct: 1, manual_review: 0 },
        ],
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.applied, true);
    assert.equal(body.auto_score, 6);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')));
    assert.ok(auditAction(executed, 'exam_attempt.regrade'));
});

test('regrade: an identical fingerprint is a no-op (no UPDATE) but still audited', async () => {
    const answerMap = { 'eq-1': '4', 'eq-2': ['a', 'c'], 'eq-3': 'true' };
    const fingerprint = computeGradingFingerprint({
        versionId: 'ver-1',
        policy: DEFAULT_SCORING_POLICY,
        questions: gradingQuestions(QUESTION_ROWS),
        answers: answerMap,
    });
    const { router, executed } = build({
        attempt: { ...ATTEMPT_ROW, status: 'graded', grading_fingerprint: fingerprint },
        questions: QUESTION_ROWS,
        storedAnswers: [
            { id: 'a1', question_ref: 'eq-1', question_type: 'single_choice', response: '"4"', awarded_points: '2.00', is_correct: 1, manual_review: 0 },
            { id: 'a2', question_ref: 'eq-2', question_type: 'multiple_choice', response: '["a","c"]', awarded_points: '3.00', is_correct: 1, manual_review: 0 },
            { id: 'a3', question_ref: 'eq-3', question_type: 'true_false', response: '"true"', awarded_points: '1.00', is_correct: 1, manual_review: 0 },
        ],
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.applied, false);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')), false);
    assert.ok(auditAction(executed, 'exam_attempt.regrade'));
});

test('regrade: a concurrent change (zero affected rows) is 409', async () => {
    const { router } = build(
        {
            attempt: { ...ATTEMPT_ROW, status: 'graded', grading_fingerprint: 'old' },
            questions: QUESTION_ROWS,
            storedAnswers: [
                { id: 'a1', question_ref: 'eq-1', question_type: 'single_choice', response: '"4"', awarded_points: '2.00', is_correct: 1, manual_review: 0 },
            ],
        },
        { updateAffected: 0 },
    );
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 409);
});

test('regrade: an unknown attempt is 404', async () => {
    const { router } = build({ attempt: null });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
});
