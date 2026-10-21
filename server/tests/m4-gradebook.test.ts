import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { NextFunction } from 'express';
import type { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    calculateGrade,
    normalizeGradingMode,
    normalizeRoundingMode,
    validateGradebookPolicy,
    validateScoreEntry,
} from '../src/services/gradebook';
import {
    buildProgressReport,
    computeOverallProgress,
    computeProgressStatus,
    filterReportsByBranch,
    filterReportsByTenant,
    isProgressPublished,
    neutralizeCsvCell,
    projectProgressForParent,
    toCsv,
} from '../src/services/progress-reports';
import { createGradebookRouter, type GradebookDataAccess } from '../src/routes/gradebook';
import {
    ExecutedStatement,
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
    invokeRoute,
    findExecuted,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const INSTRUCTOR_C = tokenFor({ id: 'instructor-c', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-s1', tenant_id: 'tenant-a' });

const AUTHORITY: Record<string, string> = { 'instructor-a': 'owner', 'instructor-b': 'owner', 'instructor-c': 'instructor' };

function build(opts: { responder?: (sql: string, params: unknown[]) => unknown[] | null } = {}) {
    const db = makeFakeDataAccess(opts.responder ?? (() => []));
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0 }, 'instructor-b': { is_active: 1, token_version: 0 }, 'instructor-c': { is_active: 1, token_version: 0 }, 'student-a': { is_active: 1, token_version: 0 } },
        {
            instructorAccounts: {
                'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'instructor-c': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }], 'instructor-b': [{ tenant_id: 'tenant-b' }], 'instructor-c': [{ tenant_id: 'tenant-a' }], 'student-a': [{ tenant_id: 'tenant-a' }] },
            enrollments: { 'student-a': [{ id: 'enr-s1', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: null, group_id: null, grade_id: null }] },
        },
    );
    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        const authority = AUTHORITY[userId];
        const tenant = userId === 'instructor-b' ? 'tenant-b' : 'tenant-a';
        return authority && tenantId === tenant ? { authority } : null;
    };
    const router = createGradebookRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        transaction: async <T>(fn: (tx: GradebookDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
}

/** Like the shared harness, but supports `res.send` for the CSV export route. */
async function invokePlain(router: Router, request: { method: string; url: string; token?: string | null; body?: unknown; query?: Record<string, string> }) {
    const headers: Record<string, string> = {};
    const response: any = { statusCode: undefined, body: undefined, headers: undefined };
    response.status = (code: number) => { response.statusCode = code; return response; };
    response.json = (payload: unknown) => { if (response.statusCode === undefined) response.statusCode = 200; response.body = payload; return response; };
    response.set = (header: string, value: string) => { headers[header.toLowerCase()] = value; response.headers = headers; return response; };
    response.send = (payload: unknown) => { if (response.statusCode === undefined) response.statusCode = 200; response.body = payload; return response; };
    const req: any = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 2000;
    while (response.statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response as { statusCode?: number; body?: any; headers?: Record<string, string> };
}

test('normalize modes', () => {
    assert.equal(normalizeGradingMode('points'), 'points');
    assert.equal(normalizeGradingMode('weighted'), 'weighted');
    assert.equal(normalizeGradingMode('x'), null);
    assert.equal(normalizeRoundingMode('half_up'), 'half_up');
    assert.equal(normalizeRoundingMode(''), 'half_up');
});

test('validateGradebookPolicy: weighted requires categories summing to 100', () => {
    assert.equal(validateGradebookPolicy({ mode: 'weighted', categories: [{ name: 'A', weight: 60 }, { name: 'B', weight: 40 }] }).ok, true);
    assert.equal(validateGradebookPolicy({ mode: 'weighted', categories: [{ name: 'A', weight: 60 }] }).ok, false);
    assert.equal(validateGradebookPolicy({}).ok, true);
});

test('validateScoreEntry: valid and invalid', () => {
    assert.equal(validateScoreEntry({ score: 5, max_score: 10 }).ok, true);
    assert.equal(validateScoreEntry({ score: 5 }).ok, false);
});

test('calculateGrade: points mode percentage', () => {
    const g = calculateGrade([{ score: 8, maxScore: 10 }, { score: 4, maxScore: 5 }], { mode: 'points' });
    assert.equal(g.rounded, 80);
});

test('calculateGrade: weighted mode', () => {
    const g = calculateGrade([{ score: 90, maxScore: 100, weight: 40 }, { score: 80, maxScore: 100, weight: 60 }], { mode: 'weighted' });
    assert.equal(g.rounded, 84);
});

test('calculateGrade: weighted mode honors policy category weights', () => {
    const categories = [
        { id: 'cat-1', name: 'Exams', weight: 70 },
        { id: 'cat-2', name: 'Homework', weight: 30 },
    ];
    const g = calculateGrade(
        [
            { categoryId: 'cat-1', score: 80, maxScore: 100, weight: 1 },
            { categoryId: 'cat-2', score: 90, maxScore: 100, weight: 1 },
        ],
        { mode: 'weighted', categories },
    );
    assert.equal(g.rounded, 83, '70% of 80 plus 30% of 90 must beat the unweighted 85');
});

test('calculateGrade: category weighting aggregates every item inside a category', () => {
    const categories = [
        { id: 'cat-1', name: 'Exams', weight: 70 },
        { id: 'cat-2', name: 'Homework', weight: 30 },
    ];
    const g = calculateGrade(
        [
            { categoryId: 'cat-1', score: 80, maxScore: 100, weight: 1 },
            { categoryId: 'cat-1', score: 100, maxScore: 100, weight: 1 },
            { categoryId: 'cat-2', score: 50, maxScore: 100, weight: 1 },
        ],
        { mode: 'weighted', categories },
    );
    assert.equal(g.rounded, 78, 'the category is averaged before its weight is applied');
});

test('calculateGrade: empty categories are excluded from the weighted denominator', () => {
    const categories = [
        { id: 'cat-1', name: 'Exams', weight: 70 },
        { id: 'cat-2', name: 'Homework', weight: 30 },
    ];
    const g = calculateGrade(
        [{ categoryId: 'cat-1', score: 80, maxScore: 100, weight: 1 }],
        { mode: 'weighted', categories },
    );
    assert.equal(g.rounded, 80, 'a category with no valid scores does not drag the grade to zero');
});

test('calculateGrade: weighted entries fall back to entry weights when no policy category has scores', () => {
    const g = calculateGrade(
        [{ score: 90, maxScore: 100, weight: 40 }, { score: 80, maxScore: 100, weight: 60 }],
        { mode: 'weighted', categories: [{ id: 'cat-1', name: 'Exams', weight: 100 }] },
    );
    assert.equal(g.rounded, 84, 'legacy entry-weighted behavior is preserved for uncategorized records');
});

test('calculateGrade is decimal-safe: fixed-point recompute ignores float drift', () => {
    assert.equal(calculateGrade([{ score: 0.1, maxScore: 0.3 }]).rounded, 33.33);
    assert.equal(calculateGrade([{ score: 0.1, maxScore: 0.1 }, { score: 0.2, maxScore: 0.2 }]).rounded, 100);
    const weighted = calculateGrade(
        [{ score: 1, maxScore: 3, weight: 1 }, { score: 1, maxScore: 3, weight: 1 }, { score: 1, maxScore: 2, weight: 1 }],
        { mode: 'weighted' },
    );
    assert.equal(weighted.rounded, 38.89);
});

test('calculateGrade reports pass/fail against the policy threshold', () => {
    assert.equal(calculateGrade([{ score: 8, maxScore: 10 }], { passingScore: 80 }).passed, true);
    assert.equal(calculateGrade([{ score: 7, maxScore: 10 }], { passingScore: 80 }).passed, false);
    assert.equal(calculateGrade([{ score: 7, maxScore: 10 }]).passed, null);
});

test('anonymous denied for policy get', async () => {
    const { router, executed } = build();
    const res = await invokeRoute(router, { method: 'GET', url: '/policy/course-1' });
    assert.equal(res.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous denied for score write', async () => {
    const { router, executed } = build();
    const res = await invokeRoute(router, { method: 'POST', url: '/scores', body: { student_enrollment_id: 'enr', course_id: 'c', score: 1, max_score: 2 } });
    assert.equal(res.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('student cannot reach staff gradebook surfaces', async () => {
    const { router } = build();
    const res = await invokeRoute(router, { method: 'GET', url: '/scores', token: STUDENT_A });
    assert.equal(res.statusCode, 403);
});

test('policy query is scoped to the caller tenant', async () => {
    const { router, executed } = build({ responder: (sql) => sql.includes('FROM courses') ? [{ id: 'course-1', tenant_id: 'tenant-b', instructor_id: null }] : [] });
    const res = await invokeRoute(router, { method: 'GET', url: '/policy/course-1', token: INSTRUCTOR_B });
    assert.equal(res.statusCode, 200);
    const query = findExecuted(executed, 'FROM gradebook_policies');
    assert.deepEqual(query?.params, ['tenant-b', 'course-1'], 'the policy read must bind the caller tenant, never a body/claim tenant');
});

test('policy get is denied for a course that does not exist in the caller tenant', async () => {
    const { router, executed } = build();
    const res = await invokeRoute(router, { method: 'GET', url: '/policy/course-1', token: INSTRUCTOR_A });
    assert.equal(res.statusCode, 404);
    assert.ok(!findExecuted(executed, 'FROM gradebook_policies'), 'a foreign/absent course must be denied before any policy read');
});

test('non-owner instructor cannot set the policy of a course they are not related to', async () => {
    const { router, executed } = build({ responder: (sql) => sql.includes('FROM courses') ? [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'another-instructor' }] : [] });
    const res = await invokeRoute(router, {
        method: 'PUT', url: '/policy/course-1', token: INSTRUCTOR_C,
        body: { mode: 'points', passing_score: 70 },
    });
    assert.equal(res.statusCode, 403);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('gradebook_policies')), 'an unauthorized instructor must not touch the policy');
});

test('non-owner instructor may set the policy of a course they teach through a group', async () => {
    const { router, executed } = build({ responder: (sql) => {
        if (sql.includes('FROM courses')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'another-instructor' }];
        if (sql.includes('FROM `groups`')) return [{ id: 'group-1' }];
        return [];
    } });
    const res = await invokeRoute(router, {
        method: 'PUT', url: '/policy/course-1', token: INSTRUCTOR_C,
        body: { mode: 'points', passing_score: 70 },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(executed.some((e) => e.kind === 'execute' && e.sql.includes('gradebook_policies')));
});

/**
 * A branch-scoped session is authenticated by the real middleware elsewhere;
 * this test drives the router's authority decision with the verified principal
 * shape that middleware produces (tenant + live branch claim).
 */
function buildBranchScoped(opts: { courseHasGroupInBranch: boolean }) {
    const db = makeFakeDataAccess((sql) => {
        if (sql.includes('FROM courses')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'another-instructor' }];
        if (sql.includes('FROM `groups`')) return opts.courseHasGroupInBranch ? [{ id: 'group-1' }] : [];
        if (sql.includes('FROM branches')) return [{ id: 'branch-1', tenant_id: 'tenant-a', status: 'active', version: 1 }];
        if (sql.includes('FROM branch_memberships')) {
            return [{ id: 'bm-1', branch_id: 'branch-1', user_id: 'instructor-d', role: 'instructor', status: 'active', version: 1 }];
        }
        return [];
    });
    const router = createGradebookRouter({
        db,
        authenticate: (req, _res, next) => {
            (req as unknown as { user: unknown }).user = {
                id: 'instructor-d', role: 'instructor', tenantId: 'tenant-a', branchId: 'branch-1',
            };
            next();
        },
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: GradebookDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
}

test('a branch membership alone does not grant authority over an unrelated course', async () => {
    const { router, executed } = buildBranchScoped({ courseHasGroupInBranch: false });
    const res = await invokeRoute(router, {
        method: 'PUT', url: '/policy/course-1',
        body: { mode: 'points', passing_score: 70 },
    });
    assert.equal(res.statusCode, 403, 'the course has no group in the caller branch');
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('gradebook_policies')),
        'no policy write without a course relation');
});

test('a branch membership covers a course that has a group inside that branch', async () => {
    const { router, executed } = buildBranchScoped({ courseHasGroupInBranch: true });
    const res = await invokeRoute(router, {
        method: 'PUT', url: '/policy/course-1',
        body: { mode: 'points', passing_score: 70 },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(executed.some((e) => e.kind === 'execute' && e.sql.includes('gradebook_policies')));
});

test('non-owner instructor score listing is restricted to courses they teach', async () => {
    const { router, executed } = build();
    const res = await invokeRoute(router, { method: 'GET', url: '/scores', token: INSTRUCTOR_C });
    assert.equal(res.statusCode, 200);
    const query = executed.find((e) => e.kind === 'query' && e.sql.includes('FROM gradebook_scores'));
    assert.ok(query && query.sql.includes('instructor_id=?'), 'a non-owner list must bind the instructor relation');
    assert.ok(query!.params.includes('instructor-c'));
});

test('student cannot read the gradebook policy of a course they are not enrolled in', async () => {
    const { router } = build({ responder: (sql) => {
        if (sql.includes('LEFT JOIN')) return [];
        if (sql.includes('FROM students')) return [{ id: 'enr-s1', tenant_id: 'tenant-a' }];
        return [];
    } });
    const res = await invokeRoute(router, { method: 'GET', url: '/me?course_id=course-x', token: STUDENT_A, query: { course_id: 'course-x' } });
    assert.equal(res.statusCode, 404);
});

test('weighted weights policy is visible to the student on /me', async () => {
    const categories = [{ id: 'cat-1', name: 'Exams', weight: 60 }, { id: 'cat-2', name: 'Homework', weight: 40 }];
    const { router } = build({ responder: (sql) => {
        if (sql.includes('FROM students')) return [{ id: 'enr-s1', tenant_id: 'tenant-a' }];
        if (sql.includes('gradebook_policies')) return [{ id: 'pol-1', tenant_id: 'tenant-a', course_id: 'course-1', mode: 'weighted', passing_score: 70, rounding: 'half_up', categories: JSON.stringify(categories) }];
        if (sql.includes('gradebook_scores')) return [{ id: 's1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-s1', course_id: 'course-1', category_id: 'cat-1', item_type: 'exam', item_id: null, score: 90, max_score: 100, weight: 60, recorded_at: '2026-01-01' }];
        return [];
    } });
    const res = await invokeRoute(router, { method: 'GET', url: '/me?course_id=course-1', token: STUDENT_A, query: { course_id: 'course-1' } });
    assert.equal(res.statusCode, 200);
    const body = res.body as any;
    assert.equal(body.policy.mode, 'weighted');
    assert.deepEqual(body.policy.categories, categories);
});

test('staff grade read rejects an enrollment that is not enrolled in the course', async () => {
    const { router, executed } = build({ responder: (sql) => {
        if (sql.includes('FROM courses')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a' }];
        if (sql.includes('LEFT JOIN')) return [];
        if (sql.includes('FROM students')) return [{ id: 'enr-outside', tenant_id: 'tenant-a' }];
        return [];
    } });
    const res = await invokeRoute(router, {
        method: 'GET', url: '/students/enr-outside?course_id=course-1', token: INSTRUCTOR_A, query: { course_id: 'course-1' },
    });
    assert.equal(res.statusCode, 404);
    assert.ok(!findExecuted(executed, 'FROM gradebook_scores'), 'no grade may be computed for a student outside the course');
});

test('staff grade read applies the stored category weights', async () => {
    const categories = [{ id: 'cat-1', name: 'Exams', weight: 70 }, { id: 'cat-2', name: 'Homework', weight: 30 }];
    const { router } = build({ responder: (sql) => {
        if (sql.includes('FROM courses')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a' }];
        if (sql.includes('LEFT JOIN')) return [{ id: 'enr-s1' }];
        if (sql.includes('FROM students')) return [{ id: 'enr-s1', tenant_id: 'tenant-a' }];
        if (sql.includes('gradebook_policies')) return [{ id: 'pol-1', tenant_id: 'tenant-a', course_id: 'course-1', mode: 'weighted', passing_score: 70, rounding: 'half_up', categories: JSON.stringify(categories) }];
        if (sql.includes('gradebook_scores')) return [
            { id: 's1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-s1', course_id: 'course-1', category_id: 'cat-1', item_type: 'exam', item_id: null, score: 80, max_score: 100, weight: 1, recorded_at: '2026-01-01' },
            { id: 's2', tenant_id: 'tenant-a', student_enrollment_id: 'enr-s1', course_id: 'course-1', category_id: 'cat-2', item_type: 'assignment', item_id: null, score: 90, max_score: 100, weight: 1, recorded_at: '2026-01-02' },
        ];
        return [];
    } });
    const res = await invokeRoute(router, {
        method: 'GET', url: '/students/enr-s1?course_id=course-1', token: INSTRUCTOR_A, query: { course_id: 'course-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.body as { grade: { rounded: number; mode: string } };
    assert.equal(body.grade.mode, 'weighted');
    assert.equal(body.grade.rounded, 83);
});

test('CSV export neutralizes formulas and writes an audit row', async () => {
    const rows = [{
        id: 's1', tenant_id: 'tenant-a', student_enrollment_id: '=cmd|calc', course_id: 'course-1',
        category_id: '@SUM(A1)', item_type: 'exam', item_id: null, score: 5, max_score: 10, weight: null,
        recorded_at: '2026-01-01',
    }];
    const { router, executed } = build({ responder: (sql) => {
        if (sql.includes('FROM courses')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a' }];
        if (sql.includes('gradebook_scores')) return rows;
        return [];
    } });
    const res = await invokePlain(router, { method: 'GET', url: '/export?course_id=course-1', token: INSTRUCTOR_A, query: { course_id: 'course-1' } });
    assert.equal(res.statusCode, 200);
    assert.ok(typeof res.body === 'string' && (res.body as string).includes("'=cmd|calc"), 'a formula payload must be prefixed/neutralized');
    assert.ok((res.body as string).includes("'@SUM(A1)"), 'a formula payload must be prefixed/neutralized');
    const audit = executed.find((e: ExecutedStatement) => e.kind === 'execute' && e.sql.includes('INSERT INTO audit_events'));
    assert.ok(audit, 'the export must be audited');
    assert.ok(audit!.params.includes('gradebook.export'));
    assert.equal(res.headers?.['content-type'], 'text/csv');
});

test('CSV export includes the calculated grade and keeps the audit', async () => {
    const categories = [{ id: 'cat-1', name: 'Exams', weight: 70 }, { id: 'cat-2', name: 'Homework', weight: 30 }];
    const scores = [
        { id: 's1', tenant_id: 'tenant-a', student_enrollment_id: 'enr-s1', course_id: 'course-1', category_id: 'cat-1', item_type: 'exam', item_id: null, score: 80, max_score: 100, weight: 1, recorded_at: '2026-01-01' },
        { id: 's2', tenant_id: 'tenant-a', student_enrollment_id: 'enr-s1', course_id: 'course-1', category_id: 'cat-2', item_type: 'assignment', item_id: null, score: 90, max_score: 100, weight: 1, recorded_at: '2026-01-02' },
    ];
    const { router, executed } = build({ responder: (sql) => {
        if (sql.includes('FROM courses')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a' }];
        if (sql.includes('gradebook_policies')) return [{ id: 'pol-1', tenant_id: 'tenant-a', course_id: 'course-1', mode: 'weighted', passing_score: 70, rounding: 'half_up', categories: JSON.stringify(categories) }];
        if (sql.includes('gradebook_scores')) return scores;
        return [];
    } });
    const res = await invokePlain(router, { method: 'GET', url: '/export?course_id=course-1', token: INSTRUCTOR_A, query: { course_id: 'course-1' } });
    assert.equal(res.statusCode, 200);
    const lines = (res.body as string).split('\r\n');
    const header = lines[0].split(',');
    const roundedIndex = header.indexOf('calculated_rounded');
    assert.ok(roundedIndex >= 0, 'the export must expose the calculated grade');
    const row = lines[1].split(',');
    assert.equal(row[roundedIndex], '83');
    const audit = executed.find((e: ExecutedStatement) => e.kind === 'execute' && e.sql.includes('INSERT INTO audit_events'));
    assert.ok(audit, 'the export must stay audited');
    assert.ok(audit!.params.includes('gradebook.export'));
});

test('toCsv quotes separators while still neutralizing formulas', () => {
    const csv = toCsv(['a'], [['=1,2'], ['safe']]);
    assert.equal(csv, "a\r\n\"'=1,2\"\r\nsafe");
});

test('neutralizeCsvCell prefixes every spreadsheet-active leading character', () => {
    for (const dangerous of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\t=cmd', '\r=cmd']) {
        assert.equal(neutralizeCsvCell(dangerous), `'${dangerous}`);
    }
    assert.equal(neutralizeCsvCell('safe'), 'safe');
    assert.equal(neutralizeCsvCell(''), '');
});

test('progress status transitions', () => {
    assert.equal(computeProgressStatus(0, 10), 'not_started');
    assert.equal(computeProgressStatus(3, 10), 'in_progress');
    assert.equal(computeProgressStatus(10, 10), 'completed');
    assert.equal(computeProgressStatus(0, 0), 'not_started');
});

test('overall progress is a weighted average of present components only', () => {
    assert.equal(computeOverallProgress([{ weight: 60, value: 90 }, { weight: 40, value: 80 }]), 86);
    assert.equal(computeOverallProgress([{ weight: 60, value: 90 }, { weight: 40, value: null }]), 90);
    assert.equal(computeOverallProgress([{ weight: 1, value: null }]), null);
});

test('buildProgressReport exposes the canonical field set', () => {
    const report = buildProgressReport({
        studentEnrollmentId: 'enr-1', courseId: 'course-1', courseName: 'Math',
        completedLessons: 3, totalLessons: 10, examAverage: 90, assignmentAverage: 80, overall: 86, status: 'in_progress',
    });
    assert.equal(report.student_enrollment_id, 'enr-1');
    assert.equal(report.status, 'in_progress');
    assert.equal(report.overall, 86);
});

test('reports are tenant- and branch-scoped', () => {
    const rows = [
        { tenantId: 'tenant-a', branchId: 'branch-1' },
        { tenantId: 'tenant-a', branchId: 'branch-2' },
        { tenantId: 'tenant-b', branchId: 'branch-1' },
    ];
    assert.equal(filterReportsByTenant(rows, 'tenant-a').length, 2);
    assert.equal(filterReportsByBranch(filterReportsByTenant(rows, 'tenant-a'), 'branch-1').length, 1);
    assert.equal(filterReportsByBranch(rows, null).length, 3, 'a tenant-wide scope does not narrow by branch');
});

test('parent projection is deny-by-default until published and hides internals', () => {
    const base = {
        studentEnrollmentId: 'enr-1', courseId: 'course-1', courseName: 'Math',
        completedLessons: 3, totalLessons: 10, examAverage: 90, assignmentAverage: 80, overall: 86, status: 'in_progress' as const,
    };
    assert.equal(isProgressPublished(base), false);
    assert.equal(projectProgressForParent(base), null);
    const projected = projectProgressForParent({ ...base, published: true });
    assert.ok(projected);
    assert.ok(!('student_enrollment_id' in projected!) && !('exam_average' in projected!), 'raw internals must not be projected to parents');
    assert.equal(projected!.overall, 86);
});
