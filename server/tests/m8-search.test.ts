import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { Router } from 'express';
import {
    SEARCH_CANDIDATE_CAP,
    SEARCH_HIT_TITLE_CAP,
    SEARCH_LIKE_ESCAPE,
    SEARCH_PAGE_SIZE_CAP,
    SEARCH_QUERY_MAX_TOKENS,
    buildStaffSearchQuery,
    buildStudentAnnouncementQuery,
    buildStudentSearchQuery,
    countSearchTokens,
    matchScore,
    normalizeSearchText,
    paginateHits,
    parseSearchPagination,
    toSearchHits,
    validateBranchFilter,
    validateSearchQuery,
} from '../src/services/search';
import type { CandidateRow, SearchKind } from '../src/services/search';
import { createSearchRouter, createStudentViewerResolver } from '../src/routes/search';
import type { SearchDataAccess, SearchDeps } from '../src/routes/search';
import { createAuthenticateToken } from '../src/middleware/auth';
import { TEST_SECRET, invokeRoute, makeFakeDataAccess, makeRepository, tokenFor } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const OWNER = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0 });
const STAFF = tokenFor({ id: 'staff-a', role: 'instructor', tv: 0 });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enr-b' });

// ---------------------------------------------------------------------------
// Query normalization (Arabic-aware)
// ---------------------------------------------------------------------------

test('normalizeSearchText strips diacritics/tatweel and folds alef/yaa/taa-marbuta variants', () => {
    // The taa marbuta folds to haa, so the normalized form of العربية is العربيه.
    assert.equal(normalizeSearchText('العَرَبِيَّة'), 'العربيه');
    assert.equal(normalizeSearchText('أإآٱ'), 'اااا');
    assert.equal(normalizeSearchText('ىئ'), 'يي');
    assert.equal(normalizeSearchText('ة'), 'ه');
    assert.equal(normalizeSearchText('mosqueً'), 'mosque');
    assert.equal(normalizeSearchText('Hello WORLD'), 'hello world');
    assert.equal(normalizeSearchText('  a   b  '), 'a b');
    assert.equal(normalizeSearchText(''), '');
});

test('validateSearchQuery enforces the hard length caps', () => {
    assert.deepEqual(validateSearchQuery(42), { ok: false, error: 'q must be a string' });
    assert.deepEqual(validateSearchQuery('a'), { ok: false, error: 'q must be at least 2 characters' });
    assert.deepEqual(validateSearchQuery('ab'), { ok: true, value: 'ab' });
    assert.equal(validateSearchQuery('x'.repeat(100))?.ok, true);
    assert.equal(validateSearchQuery('x'.repeat(101))?.ok, false);
});

test('parseSearchPagination defaults, caps page size and rejects invalid input', () => {
    assert.deepEqual(parseSearchPagination({}), { page: 1, limit: 10 });
    assert.deepEqual(parseSearchPagination({ page: '2', limit: '25' }), { page: 2, limit: 25 });
    assert.equal(parseSearchPagination({ page: '0' }), null);
    assert.equal(parseSearchPagination({ page: '101' }), null);
    assert.equal(parseSearchPagination({ limit: '0' }), null);
    assert.equal(parseSearchPagination({ limit: String(SEARCH_PAGE_SIZE_CAP + 1) }), null);
    assert.equal(parseSearchPagination({ page: 'x' }), null);
    assert.equal(parseSearchPagination({ limit: 12 }), null);
    assert.deepEqual(parseSearchPagination({ page: undefined, limit: '5' }), { page: 1, limit: 5 });
});

test('validateBranchFilter pattern-validates the branch refinement', () => {
    assert.deepEqual(validateBranchFilter('br-1'), { ok: true, value: 'br-1' });
    assert.deepEqual(validateBranchFilter(7), { ok: false, error: 'branch_id must be a string' });
    assert.equal(validateBranchFilter('bad id')?.ok, false);
    assert.equal(validateBranchFilter('bad;id')?.ok, false);
    assert.equal(validateBranchFilter('x'.repeat(65))?.ok, false);
});

// ---------------------------------------------------------------------------
// SQL builders: tenant + visibility gates live in SQL, before ranking
// ---------------------------------------------------------------------------

const staffQuery = (kind: SearchKind, branchId: string | null = null, normalizedQuery = 'math') =>
    buildStaffSearchQuery({ kind, tenantId: 'tenant-a', branchId, normalizedQuery });

test('buildStaffSearchQuery pins the tenant for every staff kind and caps matching candidates', () => {
    for (const kind of ['courses', 'lessons', 'announcements', 'question_bank'] as const) {
        const built = staffQuery(kind);
        assert.ok(built.sql.includes('tenant_id = ?'), `${kind} must pin the tenant in SQL`);
        assert.equal(built.params[0], 'tenant-a');
        assert.ok(built.sql.endsWith(`LIMIT ${SEARCH_CANDIDATE_CAP}`), `${kind} must cap candidates`);
        assert.deepEqual(built.params, ['tenant-a', '%math%'], `${kind} binds the title filter, not the cap`);
    }
    assert.ok(staffQuery('courses').sql.includes('is_active = 1'));
    // Staff (owner) sees EVERY status of her own tenant: no is_published gate.
    assert.ok(!staffQuery('lessons').sql.includes('is_published'));
    assert.ok(staffQuery('lessons').sql.includes('archived_at IS NULL'));
    assert.ok(staffQuery('announcements').sql.includes('FROM announcements a'));
    assert.ok(staffQuery('question_bank').sql.includes('archived_at IS NULL'));
});

test('buildStaffSearchQuery filters the normalized title in SQL before the cap, in id order', () => {
    for (const kind of ['courses', 'lessons', 'announcements', 'question_bank'] as const) {
        const built = staffQuery(kind, null, 'ماث math');
        assert.ok(
            built.sql.includes(`LIKE ? ESCAPE '${SEARCH_LIKE_ESCAPE}'`),
            `${kind} must prefilter the title in SQL`,
        );
        assert.ok(
            built.sql.indexOf('LIKE ?') < built.sql.indexOf('LIMIT'),
            `${kind} must filter before the cap, not after it`,
        );
        assert.match(built.sql, /ORDER BY \w+\.id ASC LIMIT 500$/, `${kind} must order deterministically`);
        assert.deepEqual(built.params.slice(-2), ['%ماث%', '%math%']);
    }

    // The prefilter must run on the projected expression, not on hidden text.
    assert.ok(staffQuery('question_bank').sql.includes('REGEXP_REPLACE(LEFT(qb.question_text, 120)'));
    // SQL normalization mirrors normalizeSearchText: diacritics stripped,
    // alef/taa-marbuta folded, ASCII lowercased.
    const courses = staffQuery('courses').sql;
    assert.ok(courses.includes("REGEXP_REPLACE(c.name, '"));
    assert.ok(courses.includes("'\u0623', '\u0627'"));
    assert.ok(courses.includes("'\u0629', '\u0647'"));
    assert.ok(courses.includes('LOWER('));
});

test('buildStaffSearchQuery validates the branch refinement inside SQL', () => {
    const announcements = staffQuery('announcements', 'br-9');
    assert.ok(announcements.sql.includes('a.branch_id IS NULL OR a.branch_id = ?'));
    assert.ok(announcements.sql.includes('FROM branches'));
    assert.ok(announcements.sql.includes("br2.status = 'active'"));
    assert.deepEqual(announcements.params, ['tenant-a', 'br-9', 'br-9', 'tenant-a', '%math%']);

    const questionBank = staffQuery('question_bank', 'br-9');
    assert.ok(questionBank.sql.includes('qb.branch_id IS NULL OR qb.branch_id = ?'));
    assert.ok(questionBank.sql.includes('FROM branches'));
    assert.deepEqual(questionBank.params, ['tenant-a', 'br-9', 'br-9', 'tenant-a', '%math%']);

    const lessons = staffQuery('lessons', 'br-9');
    assert.ok(lessons.sql.includes('FROM `groups`'));
    assert.ok(lessons.sql.includes('lg2.branch_id = ?'));
    assert.ok(lessons.sql.includes("lb2.status = 'active'"));
    assert.ok(lessons.sql.includes('lb2.tenant_id = ?'));
    assert.deepEqual(lessons.params, ['tenant-a', 'br-9', 'tenant-a', '%math%']);

    // Courses are tenant-level: no branch column exists, so no fragment is attached.
    const courses = staffQuery('courses', 'br-9');
    assert.deepEqual(courses.params, ['tenant-a', '%math%']);
    assert.ok(!courses.sql.includes('FROM branches'));
});

test('buildStudentSearchQuery applies the enrollment, publication and tenant gates in SQL', () => {
    for (const kind of ['courses', 'lessons'] as const) {
        const built = buildStudentSearchQuery({
            kind,
            tenantId: 'tenant-b',
            studentUserId: 'st-1',
            normalizedQuery: 'math',
        });
        assert.ok(built.sql.includes('c.tenant_id = ?'));
        assert.ok(built.sql.includes('student_courses'), `${kind} must gate on enrollment in SQL`);
        assert.ok(built.sql.includes('sc.status = \'active\''));
        assert.ok(built.sql.includes('se.user_id = ?'));
        assert.ok(built.sql.includes('se.tenant_id = ?'));
        assert.ok(built.sql.includes("se.approval_status = 'approved'"));
        assert.ok(built.sql.includes("se.enrollment_status = 'active'"));
        assert.ok(built.sql.includes('enrollment_start_date'));
        assert.ok(built.sql.includes('enrollment_end_date'));
        assert.deepEqual(built.params, ['tenant-b', 'st-1', 'tenant-b', '%math%']);
        assert.ok(built.sql.endsWith(`LIMIT ${SEARCH_CANDIDATE_CAP}`));
        assert.ok(built.sql.indexOf('LIKE ?') < built.sql.indexOf('LIMIT'));
        assert.match(built.sql, /ORDER BY \w+\.id ASC LIMIT 500$/);
    }
    const lessons = buildStudentSearchQuery({
        kind: 'lessons',
        tenantId: 'tenant-b',
        studentUserId: 'st-1',
        normalizedQuery: 'math',
    });
    assert.ok(lessons.sql.includes('l.is_published = 1'));
    assert.ok(lessons.sql.includes('l.archived_at IS NULL'));
});

test('buildStudentAnnouncementQuery gates on published status and the viewer audience', () => {
    const withBranch = buildStudentAnnouncementQuery({
        tenantId: 'tenant-a',
        studentBranchId: 'br-1',
        normalizedQuery: 'math',
    });
    assert.ok(withBranch.sql.includes("a.status = 'published'"));
    assert.ok(withBranch.sql.includes("a.audience = 'tenant'"));
    assert.ok(withBranch.sql.includes("a.audience = 'branch' AND a.branch_id = ?"));
    assert.deepEqual(withBranch.params, ['tenant-a', 'br-1', '%math%']);
    assert.ok(withBranch.sql.indexOf('LIKE ?') < withBranch.sql.indexOf('LIMIT'));
    assert.match(withBranch.sql, /ORDER BY a\.id ASC LIMIT 500$/);

    const withoutBranch = buildStudentAnnouncementQuery({
        tenantId: 'tenant-a',
        studentBranchId: null,
        normalizedQuery: 'math',
    });
    assert.ok(withoutBranch.sql.includes("a.audience = 'tenant'"));
    assert.ok(!withoutBranch.sql.includes("a.audience = 'branch'"));
    assert.deepEqual(withoutBranch.params, ['tenant-a', '%math%']);
});

test('LIKE metacharacters and hostile input stay escaped bound parameters', () => {
    const wildcard = staffQuery('courses', null, '50%_off!');
    assert.deepEqual(wildcard.params, ['tenant-a', '%50!%!_off!!%']);

    const hostile = "'; DROP TABLE courses; --";
    const injected = staffQuery('courses', null, hostile);
    assert.ok(!injected.sql.includes('DROP TABLE'));
    assert.deepEqual(
        injected.params,
        ['tenant-a', ...hostile.split(' ').map((token) => `%${token}%`)],
        'the query is bound token by token, never interpolated',
    );
    assert.equal((injected.sql.match(/\?/g) ?? []).length, injected.params.length);
});

test('a query that normalizes to nothing loads no candidates', () => {
    const built = staffQuery('courses', null, '');
    assert.ok(built.sql.includes('AND 1 = 0'));
    assert.deepEqual(built.params, ['tenant-a']);
    assert.ok(built.sql.endsWith(`LIMIT ${SEARCH_CANDIDATE_CAP}`));
});

// ---------------------------------------------------------------------------
// Static generated-SQL invariants
// ---------------------------------------------------------------------------

test('generated SQL never selects credential material, never uses SELECT *, and always pins the tenant', () => {
    const generated: string[] = [
        staffQuery('courses').sql,
        staffQuery('lessons', 'br-1').sql,
        staffQuery('announcements', 'br-1').sql,
        staffQuery('question_bank', 'br-1').sql,
        buildStudentSearchQuery({
            kind: 'courses',
            tenantId: 'tenant-a',
            studentUserId: 'st-1',
            normalizedQuery: 'math',
        }).sql,
        buildStudentSearchQuery({
            kind: 'lessons',
            tenantId: 'tenant-a',
            studentUserId: 'st-1',
            normalizedQuery: 'math',
        }).sql,
        buildStudentAnnouncementQuery({
            tenantId: 'tenant-a',
            studentBranchId: 'br-1',
            normalizedQuery: 'math',
        }).sql,
        buildStudentAnnouncementQuery({
            tenantId: 'tenant-a',
            studentBranchId: null,
            normalizedQuery: 'math',
        }).sql,
    ];
    for (const sql of generated) {
        assert.ok(!sql.includes('password'), `credential column must never be selected: ${sql}`);
        assert.ok(!/SELECT\s+\*/i.test(sql), `SELECT * is forbidden: ${sql}`);
        assert.ok(sql.includes('tenant_id = ?') || sql.includes('c.tenant_id = ?') || sql.includes('b.tenant_id = ?'), `tenant pin missing: ${sql}`);
        assert.ok(sql.includes('ORDER BY'), `candidate window must be deterministic: ${sql}`);
    }
});

// ---------------------------------------------------------------------------
// Ranking over already-visible candidates
// ---------------------------------------------------------------------------

test('matchScore ranks exact above prefix above substring above none', () => {
    assert.equal(matchScore('math', 'math'), 3);
    assert.equal(matchScore('math basics', 'math'), 2);
    assert.equal(matchScore('applied math 101', 'math'), 1);
    assert.equal(matchScore('physics', 'math'), 0);
    // Arabic normalization happens before matching: the diacritic-folded title matches.
    assert.equal(matchScore('العَرَبِيَّة', 'العربية'), 3);
    assert.equal(matchScore('الْعَرَبِيَّةُ', 'arabic'), 0);
});

test('toSearchHits maps, scores and drops non-matching rows', () => {
    const rows: CandidateRow[] = [
        { entity_id: 'c-1', title: 'Math Basics' },
        { entity_id: 'c-2', title: 'Physics' },
        { entity_id: 'c-3', title: 42 as unknown as string },
    ];
    const hits = toSearchHits('courses', rows, 'math', SEARCH_HIT_TITLE_CAP);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, 'courses');
    assert.equal(hits[0].id, 'c-1');
    assert.equal(hits[0].title, 'Math Basics');
    assert.equal(hits[0].score, 2 * 1000 + 'Math Basics'.length);
});

test('paginateHits sorts by score and slices the requested page', () => {
    const hits = toSearchHits('courses', [
        { entity_id: 'c-1', title: 'zz math' },
        { entity_id: 'c-2', title: 'aa math' },
        { entity_id: 'c-3', title: 'math' },
        { entity_id: 'c-4', title: 'math advanced topics' },
    ], 'math', SEARCH_HIT_TITLE_CAP);
    const page = paginateHits(hits, { page: 2, limit: 2 });
    assert.equal(page.total, 4);
    assert.equal(page.results.length, 2);
    assert.deepEqual(page.results.map((hit) => hit.id), ['c-2', 'c-1']);
    const overflow = paginateHits(hits, { page: 5, limit: 2 });
    assert.deepEqual(overflow.results, []);
});

// ---------------------------------------------------------------------------
// Route: allow / deny / cross-tenant / validation / failure
// ---------------------------------------------------------------------------

interface RouteFixture {
    authority?: Record<string, string>;
    viewer?: Record<string, { studentUserId: string; branchId: string | null } | null>;
    rowsFor?: (sql: string) => Record<string, unknown>[];
    /** Tenant-visible course rows served by the simulated candidate loader. */
    courseRows?: CandidateRow[];
    failAll?: boolean;
}

/**
 * Test double that models the documented contract of the generated candidate
 * SQL rather than executing it: the per-token LIKE prefilter runs over the
 * normalized title, `ORDER BY <id>` fixes the candidate window and LIMIT caps
 * it. Tenant/visibility gates are NOT modelled: the dataset handed in is
 * already the tenant-visible slice (those gates are asserted separately on the
 * generated SQL).
 */
const simulateCandidateLoad = (
    rows: readonly CandidateRow[],
    sql: string,
    params: readonly unknown[],
): CandidateRow[] => {
    const likeCount = (sql.match(/LIKE \?/g) ?? []).length;
    const tokens = (params.slice(params.length - likeCount) as string[])
        .map((pattern) => pattern.replace(/^%|%$/g, '').replace(/!([!%_])/g, '$1'));
    const usable = sql.includes('AND 1 = 0')
        ? []
        : rows.filter((row) => tokens.every((token) => normalizeSearchText(String(row.title)).includes(token)));
    const ordered = sql.includes('ORDER BY')
        ? [...usable].sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id)))
        : usable;
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? ordered.length);
    return ordered.slice(0, limit);
};

const buildRouter = (fixture: RouteFixture = {}) => {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
        executed.push({ sql, params });
        if (fixture.failAll) throw new Error('database unavailable');
        if (fixture.rowsFor) return fixture.rowsFor(sql) as T[];
        if (fixture.courseRows && sql.includes('FROM courses c')) {
            return simulateCandidateLoad(fixture.courseRows, sql, params) as unknown as T[];
        }
        if (sql.includes('question_bank_questions')) {
            return [{ entity_id: 'qb-1', title: 'Question bank entry' }] as unknown as T[];
        }
        if (sql.includes('FROM lectures l')) {
            return [{ entity_id: 'l-1', title: 'Math lesson one' }] as unknown as T[];
        }
        if (sql.includes('FROM announcements a')) {
            return [{ entity_id: 'a-1', title: 'Math announcement' }] as unknown as T[];
        }
        if (sql.includes('FROM courses c')) {
            return [{ entity_id: 'c-1', title: 'Math course' }] as unknown as T[];
        }
        return [];
    };
    const router: Router = createSearchRouter({
        db: {
            query,
            queryOne: async () => null,
            execute: async () => ({ affectedRows: 1 }),
        },
        authenticate: createAuthenticateToken(makeRepository({
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'staff-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
            'student-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        }, {
            instructorAccounts: {
                'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'staff-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: {
                'owner-a': [{ tenant_id: 'tenant-a' }],
                'staff-a': [{ tenant_id: 'tenant-a' }],
            },
            enrollments: {
                'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'owner-a', group_id: 'grp-1', grade_id: null }],
                'student-b': [{ id: 'enr-b', user_id: 'student-b', tenant_id: 'tenant-b', instructor_id: 'owner-a', group_id: 'grp-2', grade_id: null }],
            },
        })),
        loadActiveTenantAuthority: async (userId) => {
            const authority = fixture.authority?.[userId] ?? (userId === 'owner-a' ? 'owner' : 'instructor');
            return { authority };
        },
        resolveStudentViewer: async (userId) => fixture.viewer?.[userId] ?? null,
    });
    return { router, executed };
};

const invoke = async (
    router: Router,
    request: { method: string; url: string; token?: string; query?: Record<string, string> },
): Promise<{ statusCode?: number; body?: unknown }> => invokeRoute(router, request as never);

test('search: anonymous requests are 401 with zero SQL executed', async () => {
    const { router, executed } = buildRouter();
    const response = await invoke(router, { method: 'GET', url: '/?q=math' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('search: an owner searches her own tenant across kinds, including the question bank', async () => {
    const { router, executed } = buildRouter({
        rowsFor: (sql) => (sql.includes('question_bank_questions')
            ? [{ entity_id: 'qb-1', title: 'Math question' }]
            : []),
    });
    for (const [kind, fragment] of [
        ['courses', 'FROM courses c'],
        ['announcements', 'FROM announcements a'],
        ['question_bank', 'question_bank_questions'],
    ] as const) {
        const response = await invoke(router, {
            method: 'GET',
            url: `/?q=math&kind=${kind}`,
            token: OWNER,
            query: { q: 'math', kind },
        });
        assert.equal(response.statusCode, 200, kind);
        const candidate = executed.find((e) => e.sql.includes(fragment));
        assert.ok(candidate, `expected a ${kind} candidate query`);
        assert.equal(candidate.params[0], 'tenant-a', 'the tenant comes only from the verified principal');
    }
    // The owner sees draft/retracted rows too: no status gate is applied for staff.
    const draftQuery = executed.find((e) => e.sql.includes('FROM announcements a'));
    assert.ok(draftQuery);
    assert.ok(!draftQuery.sql.includes("a.status = 'published'"));
});

test('search: a client-supplied tenant never changes the pinned tenant (cross-tenant attempt)', async () => {
    const { router, executed } = buildRouter();
    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math&tenant_id=tenant-b&branch_id=bad id',
        token: OWNER,
        query: { q: 'math', tenant_id: 'tenant-b', branch_id: 'bad id' },
    });
    assert.equal(response.statusCode, 400, 'the forged branch id is rejected by validation');
    const ok = await invoke(router, {
        method: 'GET',
        url: '/?q=math&tenant_id=tenant-b',
        token: OWNER,
        query: { q: 'math', tenant_id: 'tenant-b' },
    });
    assert.equal(ok.statusCode, 200);
    for (const statement of executed) {
        if (statement.sql.includes('FROM courses c') || statement.sql.includes('FROM lectures l')) {
            assert.equal(statement.params[0], 'tenant-a');
        }
    }
});

test('search: a non-owner staff member is denied (owner-only title search)', async () => {
    const { router, executed } = buildRouter();
    const response = await invoke(router, { method: 'GET', url: '/?q=math', token: STAFF, query: { q: 'math' } });
    assert.equal(response.statusCode, 403);
    assert.ok(!executed.some((e) => e.sql.includes('FROM courses c')));
});

test('search: students get only enrolled, published, in-audience rows gated in SQL', async () => {
    const { router, executed } = buildRouter({
        viewer: { 'student-a': { studentUserId: 'st-1', branchId: 'br-1' } },
    });
    const lessons = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=lessons',
        token: STUDENT_A,
        query: { q: 'math', kind: 'lessons' },
    });
    assert.equal(lessons.statusCode, 200);
    const lessonsSql = executed.find((e) => e.sql.includes('FROM lectures l'));
    assert.ok(lessonsSql);
    assert.ok(lessonsSql.sql.includes('student_courses'));
    assert.ok(lessonsSql.sql.includes('l.is_published = 1'));
    assert.equal(lessonsSql.params[0], 'tenant-a');

    const announcements = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=announcements',
        token: STUDENT_A,
        query: { q: 'math', kind: 'announcements' },
    });
    assert.equal(announcements.statusCode, 200);
    const announcementSql = executed.find((e) => e.sql.includes('FROM announcements a'));
    assert.ok(announcementSql);
    assert.ok(announcementSql.sql.includes("a.status = 'published'"));
    assert.ok(announcementSql.sql.includes('student_courses') === false, 'announcements do not require enrollment');
    assert.deepEqual(announcementSql.params, ['tenant-a', 'br-1', '%math%']);
});

test('search: a student is never offered the question bank', async () => {
    const { router, executed } = buildRouter();
    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=question_bank',
        token: STUDENT_A,
        query: { q: 'math', kind: 'question_bank' },
    });
    assert.equal(response.statusCode, 403);
    assert.ok(!executed.some((e) => e.sql.includes('question_bank_questions')));
});

test('search: a student without an active workspace is 404', async () => {
    const { router } = buildRouter({ viewer: { 'student-a': null } });
    const response = await invoke(router, { method: 'GET', url: '/?q=math', token: STUDENT_A, query: { q: 'math' } });
    assert.equal(response.statusCode, 404);
});

test('search: every student candidate query pins the student own tenant (no foreign titles)', async () => {
    const { router, executed } = buildRouter({
        viewer: { 'student-b': { studentUserId: 'st-9', branchId: null } },
    });
    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math&tenant_id=tenant-a',
        token: STUDENT_B,
        query: { q: 'math', tenant_id: 'tenant-a' },
    });
    assert.equal(response.statusCode, 200);
    const candidates = executed.filter((e) => e.sql.includes('FROM courses c') || e.sql.includes('FROM lectures l'));
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
        assert.equal(candidate.params[0], 'tenant-b', 'a forged tenant id in the query string is ignored');
    }
});

test('search: malformed query, pagination, kind and branch input are 400', async () => {
    const { router } = buildRouter();
    const cases: Array<[string, string]> = [
        ['/', 'short query'],
        ['/?q=' + 'x'.repeat(101), 'long query'],
        ['/?q=math&page=0', 'page zero'],
        ['/?q=math&limit=100', 'limit over cap'],
        ['/?q=math&kind=users', 'unknown kind'],
        ['/?q=math&branch_id=bad id', 'invalid branch'],
    ];
    for (const [url, label] of cases) {
        const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
        const response = await invoke(router, { method: 'GET', url, token: OWNER, query });
        assert.equal(response.statusCode, 400, label);
    }
});

test('search: database failures surface as 500', async () => {
    const { router } = buildRouter({ failAll: true });
    const response = await invoke(router, { method: 'GET', url: '/?q=math', token: OWNER, query: { q: 'math' } });
    assert.equal(response.statusCode, 500);
});

test('search: Arabic normalization matches folded titles end-to-end', async () => {
    const { router, executed } = buildRouter({
        rowsFor: () => [{ entity_id: 'c-7', title: 'العَرَبِيَّة' }],
    });
    const response = await invoke(router, { method: 'GET', url: '/?q=العربية', token: OWNER, query: { q: 'العربية' } });
    assert.equal(response.statusCode, 200);
    const body = response.body as { results: Array<{ id: string; title: string; score: number }> };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].id, 'c-7');
    // The score tiebreak uses the RAW title length (diacritics included): 12.
    assert.equal(body.results[0].score, 3 * 1000 + 'العَرَبِيَّة'.length);
    // The SQL prefilter receives the folded query (taa marbuta -> haa).
    const candidate = executed.find((statement) => statement.sql.includes('FROM courses c'));
    assert.ok(candidate);
    assert.deepEqual(candidate.params, ['tenant-a', '%العربيه%']);
});

test('search: pagination is applied over ranked candidates', async () => {
    const { router } = buildRouter({
        rowsFor: (sql) => (sql.includes('FROM courses c')
            ? [
                { entity_id: 'c-1', title: 'math zeta' },
                { entity_id: 'c-2', title: 'math beta' },
                { entity_id: 'c-3', title: 'math alpha' },
            ]
            : []),
    });
    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math&page=1&limit=2',
        token: OWNER,
        query: { q: 'math', page: '1', limit: '2' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as { results: Array<{ id: string }>; total: number };
    assert.equal(body.total, 3);
    assert.equal(body.results.length, 2);
    assert.deepEqual(body.results.map((hit) => hit.id), ['c-3', 'c-2']);
});

// ---------------------------------------------------------------------------
// Recall beyond the candidate cap + deterministic pagination
// ---------------------------------------------------------------------------

const catalogRows = (length: number, title: (index: number) => string): CandidateRow[] =>
    Array.from({ length }, (_, index) => ({
        entity_id: `c-${String(index).padStart(4, '0')}`,
        title: title(index),
    }));

test('search: a valid match beyond the first 500 unrelated rows is still returned', async () => {
    const rows = catalogRows(600, (index) => `unrelated catalog entry ${index}`);
    rows[550] = { entity_id: 'c-0550', title: 'Advanced Math seminar' };
    const { router, executed } = buildRouter({ courseRows: rows });

    const response = await invoke(router, { method: 'GET', url: '/?q=math', token: OWNER, query: { q: 'math' } });

    assert.equal(response.statusCode, 200);
    const body = response.body as { results: Array<{ id: string }>; total: number };
    assert.deepEqual(body.results.map((hit) => hit.id), ['c-0550']);
    assert.equal(body.total, 1);
    // The cap must be applied to rows that already passed the title filter.
    const candidate = executed.find((statement) => statement.sql.includes('FROM courses c'));
    assert.ok(candidate);
    assert.ok(candidate.sql.includes('LIKE ?'), 'the title filter must run in SQL');
    assert.ok(
        candidate.sql.indexOf('LIKE ?') < candidate.sql.indexOf('LIMIT'),
        'the title filter must precede the candidate cap',
    );
    assert.ok(candidate.sql.includes('ORDER BY c.id ASC'), 'the candidate window must be deterministic');
});

test('search: tied scores paginate deterministically across pages', async () => {
    const rows = ['c-5', 'c-3', 'c-1', 'c-6', 'c-2', 'c-4'].map((id) => ({ entity_id: id, title: 'math' }));
    const { router } = buildRouter({ courseRows: rows });

    const pages: string[][] = [];
    for (const page of ['1', '2', '3']) {
        const response = await invoke(router, {
            method: 'GET',
            url: `/?q=math&page=${page}&limit=2`,
            token: OWNER,
            query: { q: 'math', page, limit: '2' },
        });
        assert.equal(response.statusCode, 200);
        const body = response.body as { results: Array<{ id: string }>; total: number; truncated: boolean };
        assert.equal(body.total, 6);
        assert.equal(body.truncated, false);
        pages.push(body.results.map((hit) => hit.id));
    }

    assert.deepEqual(pages, [['c-1', 'c-2'], ['c-3', 'c-4'], ['c-5', 'c-6']]);
    assert.equal(new Set(pages.flat()).size, 6, 'no row is repeated or skipped between pages');
});

test('search: the candidate cap is reported as truncation instead of a false total', async () => {
    const rows = catalogRows(600, (index) => `math unit ${index}`);
    const { router } = buildRouter({ courseRows: rows });

    const capped = await invoke(router, {
        method: 'GET',
        url: '/?q=math&limit=5',
        token: OWNER,
        query: { q: 'math', limit: '5' },
    });
    const cappedBody = capped.body as { total: number; results: unknown[]; truncated: boolean };
    assert.equal(cappedBody.total, SEARCH_CANDIDATE_CAP);
    assert.equal(cappedBody.results.length, 5);
    assert.equal(cappedBody.truncated, true, 'a capped total must be flagged, not presented as complete');

    const small = buildRouter({ courseRows: catalogRows(3, (index) => `math unit ${index}`) });
    const smallResponse = await invoke(small.router, {
        method: 'GET',
        url: '/?q=math',
        token: OWNER,
        query: { q: 'math' },
    });
    const smallBody = smallResponse.body as { total: number; truncated: boolean };
    assert.equal(smallBody.total, 3);
    assert.equal(smallBody.truncated, false);
});

// ---------------------------------------------------------------------------
// W1 — the production resolver seam: students.id is NOT users.id
// ---------------------------------------------------------------------------

/** users.id of the student principal (the value the service filter expects). */
const STUDENT_USERS_ID = 'student-a';
/** students.id of the enrollment row: deliberately different from users.id. */
const STUDENT_ROW_ID = 'enr-a';
const STUDENT_TENANT = 'tenant-a';

interface StudentViewerRow {
    user_id: string;
    tenant_id: string;
    branch_id: string | null;
    branch_scope: string | null;
    /** Mirrors the resolver's enrollment gates; undefined means the gate passes. */
    is_active?: number;
    approval_status?: string;
    enrollment_status?: string | null;
    enrollment_start_date?: string | null;
    enrollment_end_date?: string | null;
}

const STUDENT_VIEWER_ROW: StudentViewerRow = {
    user_id: STUDENT_USERS_ID,
    tenant_id: STUDENT_TENANT,
    branch_id: 'br-1',
    branch_scope: 'branch',
};

/** Candidate row carrying the row-level gates the generated SQL applies. */
interface SeamCatalogRow extends CandidateRow {
    tenant_id?: string;
    is_active?: number;
    is_published?: number;
    archived_at?: string | null;
    status?: string;
    audience?: string;
    branch_id?: string | null;
}

const STUDENT_CATALOG: SeamCatalogRow[] = [{ entity_id: 'c-100', title: 'Math course' }];

const studentSeamAuth = createAuthenticateToken(makeRepository({
    'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    'student-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
}, {
    enrollments: {
        'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'owner-a', group_id: 'grp-1', grade_id: null }],
        'student-b': [{ id: 'enr-b', user_id: 'student-b', tenant_id: 'tenant-b', instructor_id: 'owner-a', group_id: 'grp-2', grade_id: null }],
    },
}));

/**
 * Mirrors the resolver's enrollment WHERE clause (`STUDENT_VIEWER_SQL`): a
 * students row counts only when it is active, approved, in an active
 * enrollment and inside its enrollment window. An absent gate field passes,
 * so the shared positive fixtures keep serving exactly as before.
 */
const enrollmentRowIsVisible = (row: StudentViewerRow): boolean => {
    const now = Date.now();
    return (row.is_active ?? 1) === 1
        && (row.approval_status ?? 'approved') === 'approved'
        && (row.enrollment_status === undefined || row.enrollment_status === null || row.enrollment_status === 'active')
        && (row.enrollment_start_date === undefined || row.enrollment_start_date === null
            || new Date(row.enrollment_start_date).getTime() <= now)
        && (row.enrollment_end_date === undefined || row.enrollment_end_date === null
            || new Date(row.enrollment_end_date).getTime() > now);
};

/**
 * Scripted data access for the real resolver + real service seam. It mirrors
 * only the documented row-level gates of the statements the seam drives — the
 * resolver's enrollment WHERE clause, the tenant/enrollment/active pins of the
 * student course and lesson candidates and the published/audience gates of the
 * student announcement query. Every served/denied decision is made from the
 * bound parameters (which table is read and which user/tenant/branch is
 * pinned); the SQL itself is never interpreted or re-generated.
 */
const makeStudentSeamDataAccess = (
    viewerRows: readonly StudentViewerRow[],
    catalog: readonly SeamCatalogRow[] = STUDENT_CATALOG,
    announcements: readonly SeamCatalogRow[] = [],
    lessons: readonly SeamCatalogRow[] = [],
): ReturnType<typeof makeFakeDataAccess> =>
    makeFakeDataAccess((sql, params) => {
        if (sql.includes('FROM students s')) {
            const [userId, tenantId] = params as string[];
            return viewerRows.filter((row) =>
                row.user_id === userId
                && row.tenant_id === tenantId
                && enrollmentRowIsVisible(row));
        }
        if (sql.includes('FROM lectures l')) {
            // Student lesson candidates: tenant pin, enrollment EXISTS (the
            // catalog is this user's enrolled set), l.is_published = 1 and
            // l.archived_at IS NULL — all applied by MySQL before the cap.
            return params[0] === STUDENT_TENANT && params[1] === STUDENT_USERS_ID
                ? lessons.filter((row) => (row.is_published ?? 1) === 1 && (row.archived_at ?? null) === null)
                : [];
        }
        if (sql.includes('FROM courses c')) {
            // Student course candidates: tenant pin, enrollment EXISTS and
            // c.is_active = 1.
            return params[0] === STUDENT_TENANT && params[1] === STUDENT_USERS_ID
                ? catalog.filter((row) => (row.is_active ?? 1) === 1)
                : [];
        }
        if (sql.includes('FROM announcements a')) {
            // Student announcements: a.tenant_id pin, a.status = 'published'
            // and the audience gate around the bound branch. Without a proven
            // branch the generated SQL binds none and only tenant rows match.
            const boundBranch = sql.includes("a.audience = 'branch'") ? (params[1] as string) : null;
            return announcements.filter((row) =>
                (row.tenant_id ?? STUDENT_TENANT) === params[0]
                && (row.status ?? 'published') === 'published'
                && (row.audience === 'tenant'
                    || (row.audience === 'branch' && boundBranch !== null && row.branch_id === boundBranch)));
        }
        return [];
    });

const makeStudentSeamRouter = (
    resolveStudentViewer: SearchDeps['resolveStudentViewer'],
    dataAccess: SearchDataAccess,
): Router => createSearchRouter({
    db: dataAccess,
    authenticate: studentSeamAuth,
    loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
    resolveStudentViewer,
});

test('W1: the production student resolver returns users.id, not the students.id row id', async () => {
    assert.notEqual(STUDENT_ROW_ID, STUDENT_USERS_ID);
    const dataAccess = makeStudentSeamDataAccess([STUDENT_VIEWER_ROW]);
    const resolveStudentViewer = createStudentViewerResolver(dataAccess);

    // The resolver itself returns the users identity, while `grp` still
    // supplies the branch refinement.
    assert.deepEqual(
        await resolveStudentViewer(STUDENT_USERS_ID, STUDENT_TENANT),
        { studentUserId: STUDENT_USERS_ID, branchId: 'br-1' },
    );
    const viewerStatement = dataAccess.executed.find((statement) => statement.sql.includes('FROM students s'));
    assert.ok(viewerStatement, 'the real resolver must read the enrollment row');
    assert.deepEqual(viewerStatement.params, [STUDENT_USERS_ID, STUDENT_TENANT]);
    assert.ok(viewerStatement.sql.includes('SELECT s.user_id'), 'the resolver projects users.id');

    // Drive the real resolver + real service through the real route.
    const router = makeStudentSeamRouter(resolveStudentViewer, dataAccess);
    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math',
        token: STUDENT_A,
        query: { q: 'math' },
    });
    assert.equal(response.statusCode, 200);
    const candidate = dataAccess.executed.find((statement) => statement.sql.includes('FROM courses c'));
    assert.ok(candidate, 'the student branch must build a candidate query');
    // The captured binding is the value the service filter receives.
    assert.equal(candidate.params[1], STUDENT_USERS_ID);
    assert.notEqual(candidate.params[1], STUDENT_ROW_ID);
});

test('W1: an enrolled student with students.id != users.id sees her courses and her group branch', async () => {
    const dataAccess = makeStudentSeamDataAccess([STUDENT_VIEWER_ROW]);
    const router = makeStudentSeamRouter(createStudentViewerResolver(dataAccess), dataAccess);

    const courses = await invoke(router, {
        method: 'GET',
        url: '/?q=math',
        token: STUDENT_A,
        query: { q: 'math' },
    });
    assert.equal(courses.statusCode, 200);
    const body = courses.body as { results: Array<{ id: string; title: string }>; total: number };
    assert.deepEqual(body.results.map((hit) => hit.id), ['c-100']);
    assert.equal(body.total, 1);

    const announcements = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=announcements',
        token: STUDENT_A,
        query: { q: 'math', kind: 'announcements' },
    });
    assert.equal(announcements.statusCode, 200);
    const announcementStatement = dataAccess.executed.find((statement) => statement.sql.includes('FROM announcements a'));
    assert.ok(announcementStatement);
    // branch_scope='branch' still resolves branch_id through the group join.
    assert.deepEqual(announcementStatement.params, ['tenant-a', 'br-1', '%math%']);
});

test('W1: a student without a row in her own tenant still gets nothing (guards unchanged)', async () => {
    // (a) no enrollment row for the principal at all.
    const missing = makeStudentSeamDataAccess([STUDENT_VIEWER_ROW]);
    const missingRouter = makeStudentSeamRouter(createStudentViewerResolver(missing), missing);
    const missingResponse = await invoke(missingRouter, {
        method: 'GET',
        url: '/?q=math',
        token: STUDENT_B,
        query: { q: 'math' },
    });
    assert.equal(missingResponse.statusCode, 404);
    assert.ok(!missing.executed.some((statement) => statement.sql.includes('FROM courses c')));

    // (b) the row exists only in a foreign tenant: the tenant pin still denies.
    const foreign = makeStudentSeamDataAccess([{
        user_id: 'student-b',
        tenant_id: 'tenant-a',
        branch_id: 'br-9',
        branch_scope: 'branch',
    }]);
    const foreignRouter = makeStudentSeamRouter(createStudentViewerResolver(foreign), foreign);
    const foreignResponse = await invoke(foreignRouter, {
        method: 'GET',
        url: '/?q=math',
        token: STUDENT_B,
        query: { q: 'math' },
    });
    assert.equal(foreignResponse.statusCode, 404);
    assert.ok(!foreign.executed.some((statement) => statement.sql.includes('FROM courses c')));
});

test('W1: a failing enrollment read fails closed instead of returning an empty result', async () => {
    const dataAccess = makeFakeDataAccess((sql) => {
        if (sql.includes('FROM students s')) throw new Error('database unavailable');
        return [];
    });
    const router = makeStudentSeamRouter(createStudentViewerResolver(dataAccess), dataAccess);
    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math',
        token: STUDENT_A,
        query: { q: 'math' },
    });
    assert.equal(response.statusCode, 500);
    assert.ok(!dataAccess.executed.some((statement) => statement.sql.includes('FROM courses c')));
});

test('W1: the token bound is enforced explicitly at the limit and one over it', async () => {
    assert.equal(SEARCH_QUERY_MAX_TOKENS, 8);
    const atLimit = Array.from({ length: SEARCH_QUERY_MAX_TOKENS }, (_, index) => `w${index}`).join(' ');
    const overLimit = `${atLimit} w${SEARCH_QUERY_MAX_TOKENS}`;
    assert.equal(countSearchTokens(normalizeSearchText(atLimit)), SEARCH_QUERY_MAX_TOKENS);
    assert.equal(countSearchTokens(normalizeSearchText(overLimit)), SEARCH_QUERY_MAX_TOKENS + 1);
    assert.deepEqual(validateSearchQuery(atLimit), { ok: true, value: atLimit });
    assert.deepEqual(validateSearchQuery(overLimit), {
        ok: false,
        error: `q must contain at most ${SEARCH_QUERY_MAX_TOKENS} words`,
    });

    // Over the bound: the route rejects before any SQL runs.
    const { router, executed } = buildRouter();
    const rejected = await invoke(router, {
        method: 'GET',
        url: `/?q=${encodeURIComponent(overLimit)}`,
        token: OWNER,
        query: { q: overLimit },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(executed.length, 0);

    // At the bound: the search still runs, with exactly one predicate per word.
    const accepted = await invoke(router, {
        method: 'GET',
        url: `/?q=${encodeURIComponent(atLimit)}`,
        token: OWNER,
        query: { q: atLimit },
    });
    assert.equal(accepted.statusCode, 200);
    const statement = executed.find((entry) => entry.sql.includes('FROM courses c'));
    assert.ok(statement);
    assert.equal((statement.sql.match(/LIKE \?/g) ?? []).length, SEARCH_QUERY_MAX_TOKENS);

    // Direct builder callers fail closed; no token is silently dropped.
    assert.throws(
        () => buildStaffSearchQuery({
            kind: 'courses',
            tenantId: 'tenant-a',
            branchId: null,
            normalizedQuery: overLimit,
        }),
        new RegExp(`the bound is ${SEARCH_QUERY_MAX_TOKENS}`),
    );
});

test('W1: an inactive, unapproved or out-of-window enrollment row is denied at the resolver', async () => {
    const denials: Array<[string, Partial<StudentViewerRow>]> = [
        ['a deactivated enrollment', { is_active: 0 }],
        ['an unapproved enrollment', { approval_status: 'pending' }],
        ['a withdrawn enrollment', { enrollment_status: 'withdrawn' }],
        ['an enrollment that has not started', { enrollment_start_date: '2099-01-01 00:00:00' }],
        ['an expired enrollment', { enrollment_end_date: '2020-01-01 00:00:00' }],
    ];
    for (const [label, gate] of denials) {
        const dataAccess = makeStudentSeamDataAccess([{ ...STUDENT_VIEWER_ROW, ...gate }]);
        const router = makeStudentSeamRouter(createStudentViewerResolver(dataAccess), dataAccess);
        const response = await invoke(router, {
            method: 'GET',
            url: '/?q=math',
            token: STUDENT_A,
            query: { q: 'math' },
        });
        assert.equal(response.statusCode, 404, `${label} must not resolve a viewer`);
        assert.ok(
            !dataAccess.executed.some((statement) => statement.sql.includes('FROM courses c')),
            `${label} must never build a candidate query`,
        );
    }
});

test('W1: unpublished and inactive content is denied for the student at the production seam', async () => {
    const catalog: SeamCatalogRow[] = [
        { entity_id: 'c-100', title: 'Math course', tenant_id: STUDENT_TENANT },
        { entity_id: 'c-101', title: 'Math inactive course', tenant_id: STUDENT_TENANT, is_active: 0 },
    ];
    const lessons: SeamCatalogRow[] = [
        { entity_id: 'l-100', title: 'Math lesson', tenant_id: STUDENT_TENANT },
        { entity_id: 'l-101', title: 'Math draft lesson', tenant_id: STUDENT_TENANT, is_published: 0 },
        { entity_id: 'l-102', title: 'Math archived lesson', tenant_id: STUDENT_TENANT, archived_at: '2026-01-01 00:00:00' },
    ];
    const dataAccess = makeStudentSeamDataAccess([STUDENT_VIEWER_ROW], catalog, [], lessons);
    const router = makeStudentSeamRouter(createStudentViewerResolver(dataAccess), dataAccess);

    const courses = await invoke(router, {
        method: 'GET',
        url: '/?q=math',
        token: STUDENT_A,
        query: { q: 'math' },
    });
    assert.equal(courses.statusCode, 200);
    const courseBody = courses.body as { results: Array<{ id: string }>; total: number };
    assert.deepEqual(courseBody.results.map((hit) => hit.id), ['c-100'], 'an inactive course is denied by SQL');
    assert.equal(courseBody.total, 1);

    const lessonResponse = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=lessons',
        token: STUDENT_A,
        query: { q: 'math', kind: 'lessons' },
    });
    assert.equal(lessonResponse.statusCode, 200);
    const lessonBody = lessonResponse.body as { results: Array<{ id: string }>; total: number };
    assert.deepEqual(
        lessonBody.results.map((hit) => hit.id),
        ['l-100'],
        'unpublished and archived lessons are denied by SQL',
    );
    assert.equal(lessonBody.total, 1);
});

test('W1: branch restriction denies other-branch and draft announcements and ignores a forged branch', async () => {
    const announcements: SeamCatalogRow[] = [
        { entity_id: 'a-1', title: 'Math tenant-wide announcement', tenant_id: STUDENT_TENANT, audience: 'tenant', status: 'published' },
        { entity_id: 'a-2', title: 'Math own-branch announcement', tenant_id: STUDENT_TENANT, audience: 'branch', branch_id: 'br-1', status: 'published' },
        { entity_id: 'a-3', title: 'Math other-branch announcement', tenant_id: STUDENT_TENANT, audience: 'branch', branch_id: 'br-9', status: 'published' },
        { entity_id: 'a-4', title: 'Math draft announcement', tenant_id: STUDENT_TENANT, audience: 'tenant', status: 'draft' },
    ];
    const dataAccess = makeStudentSeamDataAccess([STUDENT_VIEWER_ROW], STUDENT_CATALOG, announcements);
    const router = makeStudentSeamRouter(createStudentViewerResolver(dataAccess), dataAccess);

    const response = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=announcements',
        token: STUDENT_A,
        query: { q: 'math', kind: 'announcements' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body as { results: Array<{ id: string }>; total: number };
    assert.deepEqual(
        body.results.map((hit) => hit.id).sort(),
        ['a-1', 'a-2'],
        'only the tenant-wide row and the row of the viewer own branch survive',
    );
    assert.equal(body.total, 2);

    // A forged branch_id in the query string is ignored: the bound branch is
    // the one proven through the viewer's group.
    const forged = await invoke(router, {
        method: 'GET',
        url: '/?q=math&kind=announcements&branch_id=br-9',
        token: STUDENT_A,
        query: { q: 'math', kind: 'announcements', branch_id: 'br-9' },
    });
    assert.equal(forged.statusCode, 200);
    const forgedStatement = dataAccess.executed.filter((statement) => statement.sql.includes('FROM announcements a')).pop();
    assert.ok(forgedStatement);
    assert.deepEqual(forgedStatement.params, [STUDENT_TENANT, 'br-1', '%math%']);
    const forgedBody = forged.body as { results: Array<{ id: string }> };
    assert.deepEqual(forgedBody.results.map((hit) => hit.id).sort(), ['a-1', 'a-2']);

    // A viewer whose group proves no branch only receives tenant-wide rows.
    const noBranch = makeStudentSeamDataAccess([{ ...STUDENT_VIEWER_ROW, branch_scope: 'tenant' }], STUDENT_CATALOG, announcements);
    const noBranchRouter = makeStudentSeamRouter(createStudentViewerResolver(noBranch), noBranch);
    const scoped = await invoke(noBranchRouter, {
        method: 'GET',
        url: '/?q=math&kind=announcements',
        token: STUDENT_A,
        query: { q: 'math', kind: 'announcements' },
    });
    assert.equal(scoped.statusCode, 200);
    const scopedBody = scoped.body as { results: Array<{ id: string }>; total: number };
    assert.deepEqual(scopedBody.results.map((hit) => hit.id), ['a-1']);
    const scopedStatement = noBranch.executed.find((statement) => statement.sql.includes('FROM announcements a'));
    assert.ok(scopedStatement);
    assert.deepEqual(scopedStatement.params, [STUDENT_TENANT, '%math%'], 'no branch is bound when none is proven');
});
