import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    SnapshotQuestionSource,
    SnapshotTiming,
    buildSnapshotEntries,
    enrollmentMatchesExam,
    evaluateAttemptPhase,
    evaluateAttemptStart,
    evaluateManualSubmit,
    isAttemptExpiryDue,
    isAutoSubmitDue,
    isSnapshotImmutable,
    normalizeId,
    normalizeSnapshotStatus,
    snapshotContentHash,
    validateExamVersionInput,
    type SnapshotQuestionSource,
    type SnapshotTiming,
} from '../src/services/exam-snapshots';
import { createExamVersionsRouter, type ExamVersionsDataAccess } from '../src/routes/exam-versions';
import { computeGradingFingerprint } from '../src/services/exam-grading';
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
// Pure snapshot policy
// ---------------------------------------------------------------------------

test('normalizeId: accepts opaque ids and rejects junk', () => {
    assert.equal(normalizeId('abc-1'), 'abc-1');
    assert.equal(normalizeId('a_b-9'), 'a_b-9');
    assert.equal(normalizeId(''), null);
    assert.equal(normalizeId('has space'), null);
    assert.equal(normalizeId('a'.repeat(65)), null);
    assert.equal(normalizeId(42), null);
});

test('snapshot status helpers are deny-by-default', () => {
    assert.equal(normalizeSnapshotStatus('draft'), 'draft');
    assert.equal(normalizeSnapshotStatus('published'), 'published');
    assert.equal(normalizeSnapshotStatus('anything'), null);
    assert.equal(isSnapshotImmutable('published'), true);
    assert.equal(isSnapshotImmutable('archived'), true);
    assert.equal(isSnapshotImmutable('draft'), false);
});

const SOURCE_SINGLE: SnapshotQuestionSource = {
    questionId: 'q1', version: 1, questionType: 'single_choice', questionText: '2+2?',
    options: ['3', '4'], correctAnswers: ['4'], points: 2, explanation: null,
};
const SOURCE_TF: SnapshotQuestionSource = {
    questionId: 'q2', version: 3, questionType: 'true_false', questionText: 'sky?',
    options: [], correctAnswers: ['true'], points: 1, explanation: 'because',
};
const SOURCE_ESSAY: SnapshotQuestionSource = {
    questionId: 'q3', version: 1, questionType: 'essay', questionText: 'discuss',
    options: [], correctAnswers: [], points: 5, explanation: null,
};

test('validateExamVersionInput: normalizes a valid payload and defaults positions', () => {
    const result = validateExamVersionInput({
        duration_seconds: 1800,
        opens_at: '2026-06-01 09:00:00',
        closes_at: '2026-06-01 10:00:00',
        grace_seconds: 120,
        passing_points: 3.5,
        scoring: { partialCredit: true },
        questions: [{ question_id: 'q1', version: 1 }, { question_id: 'q2', version: 3 }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.durationSeconds, 1800);
    assert.equal(result.value.opensAtUtc, '2026-06-01T09:00:00.000Z');
    assert.equal(result.value.closesAtUtc, '2026-06-01T10:00:00.000Z');
    assert.equal(result.value.graceSeconds, 120);
    assert.equal(result.value.passingPoints, 3.5);
    assert.equal(result.value.scoring.partialCredit, true);
    assert.deepEqual(result.value.questions.map((q) => q.position), [1, 2]);
});

test('validateExamVersionInput: rejects window, duration, grace and scoring violations', () => {
    assert.equal(validateExamVersionInput({ duration_seconds: 59, questions: [{ question_id: 'q', version: 1 }] }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 86401, questions: [{ question_id: 'q', version: 1 }] }).ok, false);
    assert.equal(validateExamVersionInput({
        duration_seconds: 600, opens_at: '2026-06-01 10:00:00', closes_at: '2026-06-01 09:00:00',
        questions: [{ question_id: 'q', version: 1 }],
    }).ok, false, 'closes_at must follow opens_at');
    assert.equal(validateExamVersionInput({ duration_seconds: 600, opens_at: 'not-a-date', questions: [{ question_id: 'q', version: 1 }] }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 600, grace_seconds: 3601, questions: [{ question_id: 'q', version: 1 }] }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 600, scoring: { negativeMarking: true }, questions: [{ question_id: 'q', version: 1 }] }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 600, passing_points: 1.234, questions: [{ question_id: 'q', version: 1 }] }).ok, false);
});

test('validateExamVersionInput: rejects empty, oversized and ambiguous question sets', () => {
    assert.equal(validateExamVersionInput({ duration_seconds: 600, questions: [] }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 600, questions: new Array(201).fill({ question_id: 'q', version: 1 }) }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 600, questions: [{ question_id: 'bad id', version: 1 }] }).ok, false);
    assert.equal(validateExamVersionInput({ duration_seconds: 600, questions: [{ question_id: 'q', version: 0 }] }).ok, false);
    assert.equal(validateExamVersionInput({
        duration_seconds: 600, questions: [{ question_id: 'q', version: 1, position: 1 }, { question_id: 'q2', version: 1, position: 1 }],
    }).ok, false, 'duplicate positions are rejected');
    assert.equal(validateExamVersionInput({
        duration_seconds: 600, questions: [{ question_id: 'q', version: 1, position: 1 }, { question_id: 'q', version: 1, position: 2 }],
    }).ok, false, 'a pinned question version may only appear once');
});

test('buildSnapshotEntries: freezes content and rejects malformed snapshots', () => {
    const good = buildSnapshotEntries([{ source: SOURCE_SINGLE, position: 1 }, { source: SOURCE_TF, position: 2 }, { source: SOURCE_ESSAY, position: 3 }]);
    assert.equal(good.ok, true);
    if (good.ok) {
        assert.equal(good.value.length, 3);
        assert.match(good.value[0].contentHash, /^[a-f0-9]{64}$/);
        assert.equal(good.value[2].correctAnswers.length, 0);
    }
    const twoAnswers = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, correctAnswers: ['3', '4'] }, position: 1 }]);
    assert.equal(twoAnswers.ok, false);
    const notInOptions = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, correctAnswers: ['9'] }, position: 1 }]);
    assert.equal(notInOptions.ok, false);
    const duplicateOptions = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, options: ['3', '3'] }, position: 1 }]);
    assert.equal(duplicateOptions.ok, false);
    const oneOption = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, options: ['3'] }, position: 1 }]);
    assert.equal(oneOption.ok, false);
    const badTf = buildSnapshotEntries([{ source: { ...SOURCE_TF, correctAnswers: ['maybe'] }, position: 1 }]);
    assert.equal(badTf.ok, false);
    const essayWithKey = buildSnapshotEntries([{ source: { ...SOURCE_ESSAY, correctAnswers: ['x'] }, position: 1 }]);
    assert.equal(essayWithKey.ok, false);
    const badType = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, questionType: 'short_answer' as never }, position: 1 }]);
    assert.equal(badType.ok, false);
    const emptyText = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, questionText: '   ' }, position: 1 }]);
    assert.equal(emptyText.ok, false);
    const badPoints = buildSnapshotEntries([{ source: { ...SOURCE_SINGLE, points: 1.234 }, position: 1 }]);
    assert.equal(badPoints.ok, false);
});

test('snapshotContentHash: deterministic over frozen content', () => {
    const base = { ...SOURCE_SINGLE, position: 1 };
    const a = snapshotContentHash(base);
    const b = snapshotContentHash({ ...base });
    const changed = snapshotContentHash({ ...base, questionText: 'different' });
    assert.equal(a, b);
    assert.notEqual(a, changed);
});

// ---------------------------------------------------------------------------
// Timing decisions
// ---------------------------------------------------------------------------

const OPEN_TIMING: SnapshotTiming = { durationSeconds: 3600, opensAtUtc: null, closesAtUtc: null, graceSeconds: 0 };

test('evaluateAttemptStart: deny-by-default on status, prior attempt and window', () => {
    const now = new Date('2026-06-01T10:00:00Z');
    assert.deepEqual(evaluateAttemptStart(OPEN_TIMING, 'draft', false, now), { allowed: false, reason: 'snapshot_not_published' });
    assert.deepEqual(evaluateAttemptStart(OPEN_TIMING, 'published', true, now), { allowed: false, reason: 'already_attempted' });
    const beforeOpen = { ...OPEN_TIMING, opensAtUtc: '2026-06-01T11:00:00Z' };
    assert.deepEqual(evaluateAttemptStart(beforeOpen, 'published', false, now), { allowed: false, reason: 'not_yet_open' });
    const closed = { ...OPEN_TIMING, closesAtUtc: '2026-06-01T10:00:00Z' };
    assert.deepEqual(evaluateAttemptStart(closed, 'published', false, now), { allowed: false, reason: 'closed' });
});

test('evaluateAttemptStart: mints a server deadline clamped to closes_at', () => {
    const now = new Date('2026-06-01T10:00:00Z');
    const open = evaluateAttemptStart(OPEN_TIMING, 'published', false, now);
    assert.equal(open.allowed, true);
    if (open.allowed) {
        assert.equal(open.deadlineUtc, '2026-06-01T11:00:00.000Z');
        assert.equal(open.remainingSeconds, 3600);
    }
    const clamped = evaluateAttemptStart({ ...OPEN_TIMING, closesAtUtc: '2026-06-01T10:30:00Z' }, 'archived', false, now);
    assert.equal(clamped.allowed, true);
    if (clamped.allowed) assert.equal(clamped.deadlineUtc, '2026-06-01T10:30:00.000Z');
});

test('evaluateAttemptPhase / evaluateManualSubmit: open, grace and expired windows', () => {
    const timing: SnapshotTiming = { durationSeconds: 3600, opensAtUtc: null, closesAtUtc: null, graceSeconds: 300 };
    const started = '2026-06-01T09:00:00Z';
    const open = evaluateAttemptPhase(timing, started, new Date('2026-06-01T09:30:00Z'));
    assert.equal(open.phase, 'open');
    assert.equal(isAutoSubmitDue(open), false);
    assert.deepEqual(evaluateManualSubmit(open), { allowed: true, late: false });
    const grace = evaluateAttemptPhase(timing, started, new Date('2026-06-01T10:02:00Z'));
    assert.equal(grace.phase, 'grace');
    assert.equal(isAutoSubmitDue(grace), true);
    assert.deepEqual(evaluateManualSubmit(grace), { allowed: false, reason: 'LATE_REJECTED' });
    const expired = evaluateAttemptPhase(timing, started, new Date('2026-06-01T10:10:00Z'));
    assert.equal(expired.phase, 'expired');
    assert.deepEqual(evaluateManualSubmit(expired), { allowed: false, reason: 'EXPIRED' });
    // Findings #3: the expiry compensation fires only past the whole grace
    // window — inside grace the auto-submit path still owns the attempt.
    assert.equal(isAttemptExpiryDue(open), false);
    assert.equal(isAttemptExpiryDue(grace), false);
    assert.equal(isAttemptExpiryDue(expired), true);
});

test('enrollmentMatchesExam: same tenant, then deny-by-default audience match', () => {
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: [] }, { tenantId: 't', groupId: 'g', branchId: null }), true);
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: [] }, { tenantId: 'x', groupId: 'g', branchId: null }), false);
    const branch = [{ groupId: null, branchId: 'br-1', branchScope: 'branch' }];
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: branch }, { tenantId: 't', groupId: null, branchId: 'br-1' }), true);
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: branch }, { tenantId: 't', groupId: null, branchId: 'br-2' }), false);
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: branch }, { tenantId: 't', groupId: null, branchId: null }), false);
    const group = [{ groupId: 'g-1', branchId: null, branchScope: 'tenant' }];
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: group }, { tenantId: 't', groupId: 'g-1', branchId: null }), true);
    assert.equal(enrollmentMatchesExam({ tenantId: 't', targets: group }, { tenantId: 't', groupId: 'g-2', branchId: null }), false);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const INSTRUCTOR_C = tokenFor({ id: 'instructor-c', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_BR_A = tokenFor({ id: 'instructor-br-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a', branch_id: 'br-1' });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });

const AUTHORITY: Record<string, { tenant: string; authority: string }> = {
    'instructor-a': { tenant: 'tenant-a', authority: 'instructor' },
    'owner-a': { tenant: 'tenant-a', authority: 'owner' },
    'instructor-c': { tenant: 'tenant-a', authority: 'instructor' },
    'instructor-br-a': { tenant: 'tenant-a', authority: 'instructor' },
};

const VERSION_ROW = {
    id: 'ver-1', exam_id: 'exam-1', tenant_id: 'tenant-a', version: 1, status: 'published',
    duration_seconds: 3600, opens_at: null, closes_at: null, grace_seconds: 0,
    total_points: 2, passing_points: 2, scoring_policy: null, published_at: '2026-01-01 00:00:00',
};

const QUESTION_ROWS = [
    {
        id: 'eq-1', exam_version_id: 'ver-1', tenant_id: 'tenant-a', position: 1, question_id: 'q1',
        question_version: 1, source_version_id: 'sv-1', question_type: 'single_choice', question_text: '2+2?',
        options: '["3","4"]', correct_answers: '["4"]', points: 2, explanation: null, content_hash: 'h1',
    },
];

const ATTEMPT_ROW = {
    id: 'attempt-1', tenant_id: 'tenant-a', exam_id: 'exam-1', exam_version_id: 'ver-1',
    student_enrollment_id: 'enr-a', student_user_id: 'student-a', status: 'in_progress',
    started_at: '2026-06-01 10:00:00', deadline_at: '2026-06-01 11:00:00', submitted_at: null,
    auto_submitted: 0, auto_score: null, score: null, manual_required: 0,
    grading_fingerprint: null, graded_at: null, passed: null,
};

const ENROLLMENT_ROW = { id: 'enr-a', tenant_id: 'tenant-a', group_id: 'grp-1', branch_id: null, branch_scope: null };

const QBANK_ROW = {
    source_version_id: 'sv-1', question_id: 'q1', version: 1, question_type: 'single_choice',
    question_text: '2+2?', options: '["3","4"]', correct_answers: '["4"]', points: 2, explanation: null,
};

interface Fixtures {
    exam?: Record<string, unknown> | null;
    version?: Record<string, unknown> | null;
    list?: Record<string, unknown>[] | null;
    questions?: Record<string, unknown>[] | null;
    attempt?: Record<string, unknown> | null;
    existingAttempt?: Record<string, unknown> | null;
    enrollment?: Record<string, unknown> | null;
    targets?: Record<string, unknown>[];
    qbankVersion?: Record<string, unknown> | null;
    storedAnswers?: Record<string, unknown>[] | null;
    teachingGroups?: Record<string, unknown>[] | null;
    courseGroupsInBranch?: Record<string, unknown>[] | null;
    branchMembership?: Record<string, unknown> | null;
    branchRow?: Record<string, unknown> | null;
}

interface BuildOptions {
    updateAffected?: number;
    now?: Date;
    /** Simulates the DB losing the UNIQUE (exam_id, enrollment) insert race. */
    attemptInsertDuplicate?: boolean;
    /** Forces UPDATE exam_versioned_attempts to affect zero rows (lost race). */
    attemptUpdateAffected?: number;
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
    duration_seconds: 3600,
    passing_points: 2,
    questions: [{ question_id: 'q1', version: 1 }],
    ...overrides,
});

const build = (fixtures: Fixtures = {}, opts: BuildOptions = {}) => {
    const responder = (sql: string, params: unknown[]): unknown[] | null => {
        if (sql.includes('FROM exams e INNER JOIN courses c')) {
            return fixtures.exam === null
                ? []
                : [fixtures.exam ?? { id: params[0], tenant_id: 'tenant-a', instructor_id: 'instructor-a' }];
        }
        if (sql.includes("`groups` g INNER JOIN courses c ON c.id = g.course_id WHERE g.course_id=? AND g.instructor_id=?")) {
            return fixtures.teachingGroups === undefined ? [] : (fixtures.teachingGroups ?? []);
        }
        if (sql.includes("g.branch_scope='branch'")) {
            return fixtures.courseGroupsInBranch === undefined ? [] : (fixtures.courseGroupsInBranch ?? []);
        }
        if (sql.includes('FROM branch_memberships')) {
            return fixtures.branchMembership === undefined || fixtures.branchMembership === null
                ? [] : [fixtures.branchMembership];
        }
        if (sql.includes('FROM branches')) {
            return fixtures.branchRow === undefined || fixtures.branchRow === null
                ? [] : [fixtures.branchRow];
        }
        if (sql.includes('COALESCE(MAX(version)')) return [{ next_version: 1 }];
        if (sql.includes('FROM exam_version_questions')) return fixtures.questions === null ? [] : (fixtures.questions ?? QUESTION_ROWS);
        if (sql.includes('FROM exam_versioned_answers')) {
            return fixtures.storedAnswers === undefined ? [] : (fixtures.storedAnswers ?? []);
        }
        if (sql.includes('exam_grading_runs')) return [];
        if (sql.includes('FROM exam_versioned_attempts')) {
            if (sql.includes('WHERE id = ?')) {
                if (fixtures.attempt !== undefined) return [fixtures.attempt];
                return [ATTEMPT_ROW];
            }
            return fixtures.existingAttempt ? [fixtures.existingAttempt] : [];
        }
        if (sql.includes('ORDER BY version DESC')) return fixtures.list === null ? [] : (fixtures.list ?? [VERSION_ROW]);
        if (sql.includes('FROM exam_versions')) return fixtures.version === null ? [] : [fixtures.version ?? VERSION_ROW];
        if (sql.includes('FROM question_bank_versions')) return fixtures.qbankVersion === null ? [] : [fixtures.qbankVersion ?? QBANK_ROW];
        if (sql.includes('FROM exam_groups')) return fixtures.targets ?? [];
        if (sql.includes('FROM students s')) return fixtures.enrollment === null ? [] : [fixtures.enrollment ?? ENROLLMENT_ROW];
        return [];
    };
    const base = makeFakeDataAccess(responder);
    const execute = async (sql: string, params: unknown[] = []) => {
        if (opts.attemptInsertDuplicate && sql.includes('INSERT INTO exam_versioned_attempts')) {
            base.executed.push({ sql, params, kind: 'execute' });
            const dup = new Error('Duplicate entry') as NodeJS.ErrnoException;
            dup.code = 'ER_DUP_ENTRY';
            dup.errno = 1062;
            throw dup;
        }
        if (opts.attemptUpdateAffected !== undefined && sql.includes('UPDATE exam_versioned_attempts')) {
            base.executed.push({ sql, params, kind: 'execute' });
            return { affectedRows: opts.attemptUpdateAffected };
        }
        if (opts.updateAffected !== undefined && sql.includes('UPDATE exam_versions')) {
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
            'instructor-c': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'instructor-br-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        },
        {
            instructorAccounts: {
                'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-c': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-br-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: {
                'instructor-a': [{ tenant_id: 'tenant-a' }],
                'owner-a': [{ tenant_id: 'tenant-a' }],
                'instructor-b': [{ tenant_id: 'tenant-b' }],
                'instructor-c': [{ tenant_id: 'tenant-a' }],
                'instructor-br-a': [{ tenant_id: 'tenant-a' }],
            },
            enrollments: {
                'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'grp-1', grade_id: null }],
            },
        },
    );
    const router = createExamVersionsRouter({
        db,
        authenticate: createAuthenticateToken({
            ...repository,
            findBranchSession: async (branchId: string, userId: string) => {
                if (userId !== 'instructor-br-a' || branchId !== 'br-1') return null;
                return {
                    branch_id: 'br-1', branch_tenant_id: 'tenant-a', branch_status: 'active',
                    branch_version: 0, membership_status: 'active', membership_version: 0,
                    membership_role: 'instructor',
                };
            },
        }),
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

// ---- POST /exams/:examId/versions -----------------------------------------

test('create: anonymous 401 with no access, cross-tenant instructor 403', async () => {
    const anon = build({});
    const anonResponse = await invokeRoute(anon.router, { method: 'POST', url: '/exams/exam-1/versions', body: validBody() });
    assert.equal(anonResponse.statusCode, 401);
    assert.equal(anon.executed.length, 0);
    const cross = build({});
    assert.equal((await invokeRoute(cross.router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_B, body: validBody() })).statusCode, 403);
});

test('create: invalid payload is 400 and an unknown exam is 404 with no write', async () => {
    const invalid = build({});
    const bad = await invokeRoute(invalid.router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_A, body: {} });
    assert.equal(bad.statusCode, 400);
    assert.equal(invalid.executed.some((e) => e.sql.includes('INSERT INTO exam_versions')), false);
    const missing = build({ exam: null });
    assert.equal((await invokeRoute(missing.router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_A, body: validBody() })).statusCode, 404);
});

test('create: an unresolvable pinned question version is 400 with no write', async () => {
    const { router, executed } = build({ qbankVersion: null });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_A, body: validBody() });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO exam_versions')), false);
});

test('create: snapshots the pinned version, carries source_version_id and audits', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_A, body: validBody() });
    assert.equal(response.statusCode, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.version, 1);
    assert.equal(body.status, 'draft');
    assert.equal(body.total_points, 2);
    const header = executed.find((e) => e.sql.includes('INSERT INTO exam_versions'));
    assert.ok(header);
    assert.equal(header!.params[2], 'tenant-a');
    const question = executed.find((e) => e.sql.includes('INSERT INTO exam_version_questions'));
    assert.ok(question);
    assert.equal(question!.params[6], 'sv-1', 'the snapshot stores the real question_bank_versions.id provenance');
    assert.ok(auditAction(executed, 'exam_version.create'));
});

// ---- GET /exams/:examId/versions ------------------------------------------

test('list: cross-tenant 403, unknown exam 404 and a scoped projection', async () => {
    assert.equal((await invokeRoute(build({}).router, { method: 'GET', url: '/exams/exam-1/versions', token: INSTRUCTOR_B })).statusCode, 403);
    assert.equal((await invokeRoute(build({ exam: null }).router, { method: 'GET', url: '/exams/exam-1/versions', token: INSTRUCTOR_A })).statusCode, 404);
    const { router } = build({});
    const response = await invokeRoute(router, { method: 'GET', url: '/exams/exam-1/versions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    assert.equal(body[0].status, 'published');
});

// ---- GET /exams/:examId/versions/:versionId -------------------------------

test('detail: staff sees the answer key, unknown version is 404 and a student is 403', async () => {
    const { router } = build({});
    const response = await invokeRoute(router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { questions?: Array<Record<string, unknown>> };
    assert.deepEqual(body.questions?.[0].correct_answers, ['4']);
    assert.equal((await invokeRoute(build({ version: null }).router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_A })).statusCode, 404);
    assert.equal((await invokeRoute(build({}).router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: STUDENT_A })).statusCode, 403);
});

// ---- POST /exams/:examId/versions/:versionId/publish ----------------------

test('publish: an already-published or archived version is 409 with no write', async () => {
    const published = build({ version: { ...VERSION_ROW, status: 'published' } });
    assert.equal((await invokeRoute(published.router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/publish', token: INSTRUCTOR_A })).statusCode, 409);
    const archived = build({ version: { ...VERSION_ROW, status: 'archived' } });
    assert.equal((await invokeRoute(archived.router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/publish', token: INSTRUCTOR_A })).statusCode, 409);
    assert.equal(archived.executed.some((e) => e.sql.includes('UPDATE exam_versions')), false);
});

test('publish: freezes the draft, records question-bank usage provenance and audits', async () => {
    const { router, executed } = build({ version: { ...VERSION_ROW, status: 'draft' } });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/publish', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as Record<string, unknown>).status, 'published');
    assert.ok(executed.some((e) => e.sql.includes('UPDATE exam_versions')));
    const usage = executed.find((e) => e.sql.includes('INSERT IGNORE INTO question_bank_version_usages'));
    assert.ok(usage, 'publishing locks the pinned question-bank versions');
    assert.equal(usage!.params[1], 'q1');
    assert.equal(usage!.params[2], 'sv-1');
    assert.ok(auditAction(executed, 'exam_version.publish'));
});

test('publish: a concurrent change (zero affected rows) is 409', async () => {
    const { router } = build({ version: { ...VERSION_ROW, status: 'draft' } }, { updateAffected: 0 });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/publish', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 409);
});

// ---- POST /exams/:examId/versions/:versionId/attempts ---------------------

test('start: anonymous 401 and a non-student instructor 403', async () => {
    const anon = build({});
    const anonResponse = await invokeRoute(anon.router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts' });
    assert.equal(anonResponse.statusCode, 401);
    assert.equal(anon.executed.length, 0);
    const instructor = build({});
    assert.equal((await invokeRoute(instructor.router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: INSTRUCTOR_A })).statusCode, 403);
});

test('start: a student without a live enrollment is 404', async () => {
    const { router } = build({ enrollment: null });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('start: denies a draft snapshot, a prior attempt, and a closed or unopened window', async () => {
    assert.equal((await invokeRoute(build({ version: { ...VERSION_ROW, status: 'draft' } }).router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A })).statusCode, 403);
    assert.equal((await invokeRoute(build({ existingAttempt: { id: 'attempt-0' } }).router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A })).statusCode, 409);
    const unopened = build({ version: { ...VERSION_ROW, opens_at: '2026-07-01 00:00:00' } });
    assert.equal((await invokeRoute(unopened.router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A })).statusCode, 403);
    const closed = build({ version: { ...VERSION_ROW, closes_at: '2026-05-01 00:00:00' } });
    assert.equal((await invokeRoute(closed.router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A })).statusCode, 403);
});

test('start: a student outside the exam audience is denied 404 with no write', async () => {
    const { router, executed } = build({ targets: [{ group_id: 'grp-9', branch_id: null, branch_scope: 'tenant' }] });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO exam_versioned_attempts')), false);
});

test('start: mints a server deadline, binds the student and audits', async () => {
    const { router, executed } = build({ targets: [] });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A });
    assert.equal(response.statusCode, 201);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.status, 'in_progress');
    assert.equal(body.started_at, '2026-06-01T10:00:00.000Z');
    assert.equal(body.deadline_at, '2026-06-01T11:00:00.000Z');
    assert.equal(body.remaining_seconds, 3600);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO exam_versioned_attempts'));
    assert.ok(insert);
    assert.equal(insert!.params[4], 'enr-a', 'attempt is bound to the caller enrollment');
    assert.equal(insert!.params[5], 'student-a');
    assert.equal(insert!.params[7], '2026-06-01 11:00:00', 'the deadline is server-minted');
    assert.ok(auditAction(executed, 'exam_attempt.start'));
});

// ---- GET /attempts/:attemptId ---------------------------------------------

test('read attempt: anonymous 401, malformed id 404 and a non-owner student 404', async () => {
    const anon = build({});
    const anonResponse = await invokeRoute(anon.router, { method: 'GET', url: '/attempts/attempt-1' });
    assert.equal(anonResponse.statusCode, 401);
    assert.equal(anon.executed.length, 0);
    assert.equal((await invokeRoute(build({}).router, { method: 'GET', url: '/attempts/bad%20id', token: STUDENT_A })).statusCode, 404);
    assert.equal((await invokeRoute(build({ attempt: { ...ATTEMPT_ROW, student_enrollment_id: 'enr-x' } }).router, { method: 'GET', url: '/attempts/attempt-1', token: STUDENT_A })).statusCode, 404);
});

test('read attempt: the owner student sees it without the answer key', async () => {
    const { router } = build({});
    const response = await invokeRoute(router, { method: 'GET', url: '/attempts/attempt-1', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { questions?: Array<Record<string, unknown>> };
    assert.equal(body.questions?.length, 1);
    assert.equal('correct_answers' in (body.questions?.[0] ?? {}), false);
});

test('read attempt: tenant staff sees it with the answer key', async () => {
    const { router } = build({});
    const response = await invokeRoute(router, { method: 'GET', url: '/attempts/attempt-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { questions?: Array<Record<string, unknown>> };
    assert.deepEqual(body.questions?.[0].correct_answers, ['4']);
});

// ---- Finding #9: attempt-start duplicate race ------------------------------

test('start: a lost UNIQUE race on the attempt insert surfaces as 409 already_attempted, never a 500', async () => {
    const { router, executed } = build({}, { attemptInsertDuplicate: true });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/attempts', token: STUDENT_A });
    assert.equal(response.statusCode, 409);
    assert.equal((response.body as Record<string, unknown>).code, 'already_attempted', 'the losing concurrent start reports the same denial as the pre-check');
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO exam_versioned_attempts')));
});

// ---- Finding #3: lazy expiry on any touch of a past-grace attempt ----------

test('read attempt: an open-phase attempt is read with no expiry writes', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'GET', url: '/attempts/attempt-1', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')), false);
});

test('read attempt: past the grace deadline the touch expires the attempt (server-minted, audited)', async () => {
    // deadline: 10:00 + 3600s = 11:00, grace 300s -> grace deadline 11:05;
    // reading at 11:06 is past the whole grace window.
    const { router, executed } = build(
        { version: { ...VERSION_ROW, grace_seconds: 300 } },
        { now: new Date('2026-06-01T11:06:00Z') },
    );
    const response = await invokeRoute(router, { method: 'GET', url: '/attempts/attempt-1', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const expiry = executed.find((e) => e.sql.includes('UPDATE exam_versioned_attempts'));
    assert.ok(expiry, 'the touch must run the compensation pass');
    assert.equal(expiry!.params[0], 'expired');
    assert.equal(expiry!.params[7], 1, 'auto_submitted is set by the server, never by the client');
    assert.ok(executed.some((e) => e.sql.includes('INSERT IGNORE INTO exam_grading_runs')), 'the expired attempt is graded in the same pass');
    assert.ok(auditAction(executed, 'exam_attempt.expire'));
});

/* ------------------------------------------------------------------------- */
/* T2 — G-A4-2: staff authority over an exam is server-verified (course/instr) */
/* ------------------------------------------------------------------------- */

/** An exam whose course teacher is someone else than the calling instructor. */
const UNRELATED_COURSE_EXAM = { id: 'exam-1', tenant_id: 'tenant-a', instructor_id: 'instructor-x' };

test('staff exam authority: create is denied 403 for a tenant instructor who does not teach the course', async () => {
    const { router, executed } = build({ exam: UNRELATED_COURSE_EXAM });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_C, body: validBody() });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO exam_versions')), false);
});

test('staff exam authority: reading the answer key without teaching the course is denied 403', async () => {
    const { router } = build({ exam: UNRELATED_COURSE_EXAM });
    const response = await invokeRoute(router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, 403);
    const body = response.body as { questions?: unknown };
    assert.equal(body.questions, undefined, 'no answer key leaks to an instructor outside the course');
});

test('staff exam authority: publish is denied 403 for an instructor outside the course', async () => {
    const { router, executed } = build({ exam: UNRELATED_COURSE_EXAM, version: { ...VERSION_ROW, status: 'draft' } });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions/ver-1/publish', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versions')), false);
});

test('staff exam authority: regrade is denied 403 for an instructor outside the course', async () => {
    const { router, executed } = build({
        exam: UNRELATED_COURSE_EXAM,
        attempt: { ...ATTEMPT_ROW, status: 'graded', version: 3 },
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE exam_versioned_attempts')), false);
});

test('staff exam authority: listing versions and reading a staff attempt are denied 403 outside the course', async () => {
    const listed = build({ exam: UNRELATED_COURSE_EXAM });
    assert.equal((await invokeRoute(listed.router, { method: 'GET', url: '/exams/exam-1/versions', token: INSTRUCTOR_C })).statusCode, 403);
    const attempter = build({ exam: UNRELATED_COURSE_EXAM, attempt: { ...ATTEMPT_ROW, status: 'graded', version: 3 } });
    const readout = await invokeRoute(attempter.router, { method: 'GET', url: '/attempts/attempt-1', token: INSTRUCTOR_C });
    assert.equal(readout.statusCode, 403);
    const body = readout.body as { questions?: unknown };
    assert.equal(body.questions, undefined, 'the staff read must not serve the answer key outside the course');
});

test('staff exam authority: a foreign-tenant exam stays not-found 404 for a same-tenant authority', async () => {
    const { router } = build({ exam: { id: 'exam-1', tenant_id: 'tenant-b', instructor_id: 'instructor-x' } });
    const response = await invokeRoute(router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_C });
    assert.equal(response.statusCode, 404);
});

test('staff exam authority: the tenant owner and the course instructor keep access', async () => {
    const owner = build({ exam: UNRELATED_COURSE_EXAM });
    const ownerRead = await invokeRoute(owner.router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: OWNER_A });
    assert.equal(ownerRead.statusCode, 200);
    const ownerBody = ownerRead.body as { questions?: Array<Record<string, unknown>> };
    assert.deepEqual(ownerBody.questions?.[0].correct_answers, ['4'], 'the owner still sees the answer key');

    const courseInstructor = build({});
    assert.equal((await invokeRoute(courseInstructor.router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_A, body: validBody() })).statusCode, 201);
});

test('staff exam authority: an instructor teaching a group of the course passes', async () => {
    const { router } = build({
        exam: { id: 'exam-1', tenant_id: 'tenant-a', instructor_id: null },
        teachingGroups: [{ id: 'g-1' }],
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
});

test('staff exam authority: a branch-scoped instructor passes only for their own course branch', async () => {
    const membership = { id: 'bm-1', branch_id: 'br-1', user_id: 'instructor-br-a', role: 'instructor', status: 'active', version: 1 };
    const branch = { ...UNRELATED_COURSE_EXAM, instructor_id: null };
    const allowed = await invokeRoute(build({
        exam: branch,
        branchRow: { id: 'br-1', tenant_id: 'tenant-a', status: 'active', version: 1 },
        branchMembership: membership,
        courseGroupsInBranch: [{ id: 'g-1' }],
    }).router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_BR_A });
    assert.equal(allowed.statusCode, 200);

    const denied = await invokeRoute(build({
        exam: branch,
        branchRow: { id: 'br-1', tenant_id: 'tenant-a', status: 'active', version: 1 },
        branchMembership: membership,
    }).router, { method: 'GET', url: '/exams/exam-1/versions/ver-1', token: INSTRUCTOR_BR_A });
    assert.equal(denied.statusCode, 403, 'a course with no group in the instructor branch is denied');
});

/* ------------------------------------------------------------------------- */
/* T2 — G-A2-3: regrade preserves the terminal expired/auto_submitted state   */
/* ------------------------------------------------------------------------- */

const EXPIRED_ATTEMPT = {
    ...ATTEMPT_ROW,
    status: 'expired',
    auto_submitted: 1,
    auto_score: 0,
    score: 0,
    grading_fingerprint: 'expired-fingerprint-that-differs',
    graded_at: '2026-06-01 11:00:00',
    version: 3,
};

test('regrade: an expired, auto-submitted attempt keeps status expired and is guarded by the expected state and version', async () => {
    const { router, executed } = build({
        attempt: { ...EXPIRED_ATTEMPT },
        storedAnswers: [
            { id: 'a1', question_ref: 'eq-1', question_type: 'single_choice', response: '"3"', awarded_points: '0.00', is_correct: 0, manual_review: 0 },
        ],
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.applied, true, 'the changed fingerprint re-applies the grade');
    assert.equal(body.status, 'expired', 'the terminal expired state survives the regrade');
    assert.equal(body.auto_score, 0);

    const update = executed.find((e) => e.sql.includes('UPDATE exam_versioned_attempts'));
    assert.ok(update, 'the regrade writes the recomputed grade');
    assert.equal(update!.params[0], 'expired', 'status is preserved, never reset to graded');
    assert.equal(update!.sql.includes('AND status = ? AND version = ?'), true, 'the UPDATE is guarded by the expected state and version');
    assert.equal(update!.params[9], 'expired', 'the guard carries the expected status');
    assert.equal(update!.params[10], 3, 'the guard carries the expected version');
    assert.equal(update!.sql.includes('auto_submitted'), false, 'auto_submitted is never flipped by a regrade');

    const ledger = executed.find((e) => e.sql.includes('UPDATE exam_versioned_answers'));
    assert.ok(ledger, 'the award ledger is re-applied');
    assert.ok(auditAction(executed, 'exam_attempt.regrade'));
});

test('regrade: a manually submitted graded attempt still re-applies and stays graded', async () => {
    const { router, executed } = build({
        attempt: { ...ATTEMPT_ROW, status: 'graded', auto_submitted: 0, grading_fingerprint: 'old', score: '0.00', auto_score: 0, version: 3 },
        storedAnswers: [
            { id: 'a1', question_ref: 'eq-1', question_type: 'single_choice', response: '"4"', awarded_points: '0.00', is_correct: 0, manual_review: 0 },
        ],
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.applied, true);
    assert.equal(body.status, 'graded');
    const update = executed.find((e) => e.sql.includes('UPDATE exam_versioned_attempts'));
    assert.ok(update);
    assert.equal(update!.params[0], 'graded');
    assert.equal(update!.params[10], 3, 'the version guard carries the expected version');
});

test('regrade: a concurrent change (zero affected rows) is 409 with the state guard', async () => {
    const { router, executed } = build({
        attempt: { ...EXPIRED_ATTEMPT },
        storedAnswers: [
            { id: 'a1', question_ref: 'eq-1', question_type: 'single_choice', response: '"3"', awarded_points: '0.00', is_correct: 0, manual_review: 0 },
        ],
    }, { attemptUpdateAffected: 0 });
    const response = await invokeRoute(router, { method: 'POST', url: '/attempts/attempt-1/regrade', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 409, 'the losing regrade never applies a partial grade');
    assert.equal(executed.some((e) => e.sql.includes('INSERT IGNORE INTO exam_grading_runs')), false, 'no run row is written on a lost guard');
});

/* ------------------------------------------------------------------------- */
/* T2 — G-A2-4: pinning enforces the existing branch visibility filter only   */
/* ------------------------------------------------------------------------- */

test('create: a branch-scoped instructor resolves pins through question_bank_questions with the branch visibility filter', async () => {
    const { router, executed } = build({
        exam: { id: 'exam-1', tenant_id: 'tenant-a', instructor_id: null },
        branchRow: { id: 'br-1', tenant_id: 'tenant-a', status: 'active', version: 1 },
        branchMembership: { id: 'bm-1', branch_id: 'br-1', user_id: 'instructor-br-a', role: 'instructor', status: 'active', version: 1 },
        courseGroupsInBranch: [{ id: 'g-1' }],
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_BR_A, body: validBody() });
    assert.equal(response.statusCode, 201);
    const pin = executed.find((e) => e.sql.includes('FROM question_bank_versions'));
    assert.ok(pin, 'the pin resolver runs');
    assert.equal(pin!.sql.includes('INNER JOIN question_bank_questions'), true, 'visibility is resolved from the branch-scoped question head');
    assert.equal(
        pin!.sql.includes("(branch_scope='tenant' OR (branch_scope='branch' AND branch_id=?))"),
        true,
        'the existing branch visibility filter is enforced on the pin query',
    );
    assert.deepEqual(pin!.params, ['tenant-a', 'q1', 1, 'br-1'], 'the branch filter is bound to the principal branch');
});

test('create: a tenant instructor without branch claims may only pin tenant-scope question versions', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions', token: INSTRUCTOR_A, body: validBody() });
    assert.equal(response.statusCode, 201);
    const pin = executed.find((e) => e.sql.includes('FROM question_bank_versions'));
    assert.ok(pin);
    assert.equal(pin!.sql.includes("branch_scope='tenant'"), true);
    assert.deepEqual(pin!.params, ['tenant-a', 'q1', 1], 'no branch scalar is bound for a non-owner without a branch');
});

test('create: the owner pin query sees every branch of the tenant (filter 1=1)', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/exams/exam-1/versions', token: OWNER_A, body: validBody() });
    assert.equal(response.statusCode, 201);
    const pin = executed.find((e) => e.sql.includes('FROM question_bank_versions'));
    assert.ok(pin);
    assert.equal(pin!.sql.includes('1=1'), true);
});
