import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    buildQuestionVisibilityFilter,
    isVersionLocked,
    normalizeBranchScope,
    normalizeQuestionKind,
    normalizeTags,
    validateQuestionImportPayload,
    validateQuestionInput,
} from '../src/services/question-bank';
import { createQuestionBankRouter, type QuestionBankDataAccess } from '../src/routes/question-bank';
import {
    ExecutedStatement,
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
    invokeRoute,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('question kind: normalizes the four supported kinds and rejects junk', () => {
    assert.equal(normalizeQuestionKind('single_choice'), 'single_choice');
    assert.equal(normalizeQuestionKind('multiple_choice'), 'multiple_choice');
    assert.equal(normalizeQuestionKind('true_false'), 'true_false');
    assert.equal(normalizeQuestionKind('essay'), 'essay');
    assert.equal(normalizeQuestionKind('short_answer'), null);
    assert.equal(normalizeQuestionKind(3), null);
    assert.equal(normalizeBranchScope('branch'), 'branch');
    assert.equal(normalizeBranchScope('shared'), null);
});

test('tags: normalized, de-duplicated and bounded', () => {
    assert.deepEqual(normalizeTags(['Math', 'math', '  Algebra ']), ['math', 'algebra']);
    assert.deepEqual(normalizeTags(undefined), []);
    assert.equal(normalizeTags('math'), null);
    assert.equal(normalizeTags(['']), null);
    assert.equal(normalizeTags(new Array(21).fill('x')), null);
});

test('validateQuestionInput: single/multiple choice answer keys are checked against options', () => {
    const single = validateQuestionInput({
        question_type: 'single_choice', question_text: '2+2?', options: ['3', '4'], correct_answers: ['4'], tags: ['math'],
    });
    assert.equal(single.ok, true);
    if (single.ok) { assert.deepEqual(single.value.correctAnswers, ['4']); assert.equal(single.value.points, 1); }

    assert.equal(validateQuestionInput({
        question_type: 'single_choice', question_text: 'x', options: ['a', 'b'], correct_answers: ['a', 'b'],
    }).ok, false, 'single_choice with two answers is rejected');
    assert.equal(validateQuestionInput({
        question_type: 'multiple_choice', question_text: 'x', options: ['a', 'b'], correct_answers: ['c'],
    }).ok, false, 'answer not in options is rejected');
    assert.equal(validateQuestionInput({
        question_type: 'multiple_choice', question_text: 'x', options: ['a', 'a'], correct_answers: ['a'],
    }).ok, false, 'duplicate options are rejected');
    assert.equal(validateQuestionInput({
        question_type: 'single_choice', question_text: 'x', options: ['a'], correct_answers: ['a'],
    }).ok, false, 'fewer than two options is rejected');
});

test('validateQuestionInput: true/false and essay rules', () => {
    const tf = validateQuestionInput({ question_type: 'true_false', question_text: 'Sky is blue?', correct_answers: [true] });
    assert.equal(tf.ok, true);
    if (tf.ok) { assert.deepEqual(tf.value.correctAnswers, ['true']); assert.deepEqual(tf.value.options, []); }
    assert.equal(validateQuestionInput({ question_type: 'true_false', question_text: 'x', correct_answers: ['maybe'] }).ok, false);
    assert.equal(validateQuestionInput({ question_type: 'true_false', question_text: 'x', options: ['a', 'b'], correct_answers: ['true'] }).ok, false);

    const essay = validateQuestionInput({ question_type: 'essay', question_text: 'Discuss', correct_answers: [] });
    assert.equal(essay.ok, true);
    if (essay.ok) assert.deepEqual(essay.value.correctAnswers, []);
});

test('validateQuestionInput: scope and points/bounds', () => {
    assert.equal(validateQuestionInput({ question_type: 'essay', question_text: 'x', branch_scope: 'branch' }).ok, false);
    assert.equal(validateQuestionInput({ question_type: 'essay', question_text: 'x', branch_scope: 'tenant', branch_id: 'br-1' }).ok, false);
    assert.equal(validateQuestionInput({ question_type: 'essay', question_text: 'x', points: 0 }).ok, false);
    assert.equal(validateQuestionInput({ question_type: 'essay', question_text: 'x', points: 1.234 }).ok, false);
    assert.equal(validateQuestionInput({ question_type: 'essay', question_text: 'x', points: 2.5 }).ok, true);
    assert.equal(validateQuestionInput({}).ok, false);
});

test('visibility filter is deny-by-default per scope', () => {
    assert.deepEqual(buildQuestionVisibilityFilter({ tenantId: 't', branchId: null, isOwner: true }), { sql: '1=1', params: [] });
    const branch = buildQuestionVisibilityFilter({ tenantId: 't', branchId: 'br-1', isOwner: false });
    assert.match(branch.sql, /branch_id=\?/);
    assert.deepEqual(branch.params, ['br-1']);
    const tenantOnly = buildQuestionVisibilityFilter({ tenantId: 't', branchId: null, isOwner: false });
    assert.equal(tenantOnly.sql, `branch_scope='tenant'`);
});

test('isVersionLocked fails closed: a published-exam usage locks the version', () => {
    assert.equal(isVersionLocked([]), false);
    assert.equal(isVersionLocked([{ examPublished: false }]), false);
    assert.equal(isVersionLocked([{ examPublished: false }, { examPublished: true }]), true);
});

test('validateQuestionImportPayload: bounded and per-entry validated', () => {
    const good = validateQuestionImportPayload({ questions: [{ question_type: 'essay', question_text: 'x' }] });
    assert.equal(good.ok, true);
    assert.equal(validateQuestionImportPayload({ questions: [] }).ok, false);
    assert.equal(validateQuestionImportPayload({ questions: [{ question_type: 'essay' }] }).ok, false);
    assert.equal(validateQuestionImportPayload({ questions: new Array(201).fill({ question_type: 'essay', question_text: 'x' }) }).ok, false);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const AUTHORITY: Record<string, string> = { 'instructor-a': 'instructor', 'owner-a': 'owner' };

const QUESTION_ROW = {
    id: 'q-1', tenant_id: 'tenant-a', branch_id: null, branch_scope: 'tenant',
    question_type: 'single_choice', question_text: '2+2?', options: '["3","4"]', correct_answers: '["4"]',
    points: 1, explanation: null, tags: '["math"]', current_version: 1, archived_at: null, version: 0,
};

interface Fixtures {
    question?: Record<string, unknown> | null;
    list?: Record<string, unknown>[];
    versions?: Record<string, unknown>[];
    usages?: Record<string, unknown>[];
    branch?: Record<string, unknown>[];
    membership?: Record<string, unknown>[];
}

const build = (
    fixtures: Fixtures,
    opts: { authority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null> } = {},
) => {
    const responder = (sql: string): unknown[] | null => {
        if (sql.includes('FROM question_bank_questions') && sql.includes('id = ?')) {
            return fixtures.question === null ? [] : [fixtures.question ?? QUESTION_ROW];
        }
        if (sql.includes('FROM question_bank_questions')) return fixtures.list ?? [QUESTION_ROW];
        if (sql.includes('FROM question_bank_versions')) return fixtures.versions ?? [{ version: 1, created_at: '2026-01-01 00:00:00' }];
        if (sql.includes('question_bank_version_usages')) return fixtures.usages ?? [];
        if (sql.includes('FROM branches')) return fixtures.branch ?? [{ id: 'br-1', status: 'active' }];
        if (sql.includes('FROM branch_memberships')) return fixtures.membership ?? [{ status: 'active' }];
        return [];
    };
    const db = makeFakeDataAccess(responder);
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
    const loadActiveTenantAuthority = opts.authority ?? (async (userId, tenantId) => {
        const authority = AUTHORITY[userId];
        return authority && tenantId === 'tenant-a' ? { authority } : null;
    });
    const router = createQuestionBankRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        transaction: async <T>(fn: (tx: QuestionBankDataAccess) => Promise<T>) => fn(db),
    });
    return { router, executed: db.executed };
};

const auditAction = (executed: ExecutedStatement[], action: string) =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

async function expectAnonymousDenied(build: () => ReturnType<typeof build>, method: string, url: string) {
    const { router, executed } = build();
    const response = await invokeRoute(router, { method, url });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
}

// ---- GET /questions -------------------------------------------------------

test('list: anonymous is 401 with no data access, and a cross-tenant instructor is 403', async () => {
    await expectAnonymousDenied(() => build({}), 'GET', '/questions');
    const { router } = build({});
    const cross = await invokeRoute(router, { method: 'GET', url: '/questions', token: INSTRUCTOR_B });
    assert.equal(cross.statusCode, 403);
    const student = await invokeRoute(router, { method: 'GET', url: '/questions', token: STUDENT_A });
    assert.equal(student.statusCode, 403);
});

test('list: tenant-scoped and returns projected rows', async () => {
    const { router, executed } = build({ list: [QUESTION_ROW] });
    const response = await invokeRoute(router, { method: 'GET', url: '/questions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    assert.deepEqual(body[0].correct_answers, ['4']);
    assert.equal(body[0].archived, false);
    assert.ok(executed.some((e) => e.sql.includes('WHERE tenant_id = ?') && e.params[0] === 'tenant-a'));
});

test('list: a malformed filter yields 400 and no role leak', async () => {
    const { router } = build({});
    const response = await invokeRoute(router, { method: 'GET', url: '/questions', query: { tag: '' }, token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200, 'empty tag is treated as no filter');
});

// ---- POST /questions ------------------------------------------------------

test('create: rejects an invalid payload with 400 and no write', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/questions', token: INSTRUCTOR_A, body: { question_text: '' } });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO question_bank_questions')), false);
});

test('create: a branch outside the caller tenant is denied 403 with no write', async () => {
    const { router, executed } = build({ branch: [] });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/questions', token: INSTRUCTOR_A,
        body: { question_type: 'essay', question_text: 'x', branch_scope: 'branch', branch_id: 'br-x' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO question_bank_questions')), false);
});

test('create: a branch without membership is denied 403', async () => {
    const { router } = build({ branch: [{ id: 'br-1', status: 'active' }], membership: [] });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/questions', token: INSTRUCTOR_A,
        body: { question_type: 'essay', question_text: 'x', branch_scope: 'branch', branch_id: 'br-1' },
    });
    assert.equal(response.statusCode, 403);
});

test('create: writes the head row plus version 1 and audits it', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, {
        method: 'POST', url: '/questions', token: INSTRUCTOR_A,
        body: { question_type: 'single_choice', question_text: '2+2?', options: ['3', '4'], correct_answers: ['4'], tags: ['Math'] },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO question_bank_questions')));
    const version = executed.find((e) => e.sql.includes('INSERT INTO question_bank_versions'));
    assert.ok(version);
    assert.equal(version!.params[3], 1);
    assert.ok(auditAction(executed, 'question_bank.question.create'));
});

test('create: an audit failure aborts with 500 rather than committing unaudited', async () => {
    const db = makeFakeDataAccess(() => []);
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit unavailable');
        return db.execute(sql, params);
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const tx: QuestionBankDataAccess = { query: db.query, queryOne: db.queryOne, execute };
    const router = createQuestionBankRouter({
        db: tx,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: QuestionBankDataAccess) => Promise<T>) => fn(tx),
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/questions', token: INSTRUCTOR_A, body: { question_type: 'essay', question_text: 'x' },
    });
    assert.equal(response.statusCode, 500);
});

// ---- GET /questions/:id ---------------------------------------------------

test('read: unknown id is 404 and a malformed id is 404', async () => {
    const unknown = build({ question: null });
    assert.equal((await invokeRoute(unknown.router, { method: 'GET', url: '/questions/missing', token: INSTRUCTOR_A })).statusCode, 404);
    const malformed = build({});
    assert.equal((await invokeRoute(malformed.router, { method: 'GET', url: '/questions/bad%20id', token: INSTRUCTOR_A })).statusCode, 404);
});

test('read: returns the question with its version chain', async () => {
    const { router } = build({ question: QUESTION_ROW });
    const response = await invokeRoute(router, { method: 'GET', url: '/questions/q-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { id?: string }).id, 'q-1');
    assert.deepEqual((response.body as { versions?: unknown[] }).versions, [{ version: 1, created_at: '2026-01-01 00:00:00' }]);
});

// ---- GET /questions/:id/versions -----------------------------------------

test('versions: lists only after the question is visible to the caller', async () => {
    const hidden = build({ question: null });
    assert.equal((await invokeRoute(hidden.router, { method: 'GET', url: '/questions/q-1/versions', token: INSTRUCTOR_A })).statusCode, 404);
    const { router } = build({ question: QUESTION_ROW });
    const response = await invokeRoute(router, { method: 'GET', url: '/questions/q-1/versions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
});

// ---- PATCH /questions/:id -------------------------------------------------

test('edit: unknown is 404 and archived is 409 with no update', async () => {
    const unknown = build({ question: null });
    assert.equal((await invokeRoute(unknown.router, { method: 'PATCH', url: '/questions/q-1', token: INSTRUCTOR_A, body: { question_text: 'y' } })).statusCode, 404);
    const archived = build({ question: { ...QUESTION_ROW, archived_at: '2026-01-01 00:00:00' } });
    const res = await invokeRoute(archived.router, { method: 'PATCH', url: '/questions/q-1', token: INSTRUCTOR_A, body: { question_text: 'y' } });
    assert.equal(res.statusCode, 409);
    assert.equal(archived.executed.some((e) => e.sql.includes('UPDATE question_bank_questions')), false);
});

test('edit: a version used by a published exam is immutable (409, no write)', async () => {
    const { router, executed } = build({ usages: [{ exam_published: 1 }] });
    const response = await invokeRoute(router, { method: 'PATCH', url: '/questions/q-1', token: INSTRUCTOR_A, body: { question_text: 'y' } });
    assert.equal(response.statusCode, 409);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE question_bank_questions')), false);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO question_bank_versions')), false);
});

test('edit: appends version 2 under an optimistic guard and audits it', async () => {
    const { router, executed } = build({ usages: [{ exam_published: 0 }] });
    const response = await invokeRoute(router, { method: 'PATCH', url: '/questions/q-1', token: INSTRUCTOR_A, body: { question_text: 'updated' } });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { current_version?: number }).current_version, 2);
    const update = executed.find((e) => e.sql.includes('UPDATE question_bank_questions'));
    assert.ok(update);
    assert.equal(update!.params[update!.params.length - 1], 1, 'optimistic guard binds the previous version');
    const version = executed.find((e) => e.sql.includes('INSERT INTO question_bank_versions'));
    assert.equal(version!.params[3], 2);
    assert.ok(auditAction(executed, 'question_bank.question.version'));
});

test('edit: a concurrent change (zero affected rows) is 409', async () => {
    const db = makeFakeDataAccess((sql) => (sql.includes('FROM question_bank_questions') ? [QUESTION_ROW] : sql.includes('question_bank_version_usages') ? [] : []));
    const execute = async (sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE question_bank_questions')) return { affectedRows: 0 };
        return db.execute(sql, params);
    };
    const repository = makeRepository(
        { 'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' } },
        { instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } }, memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] } },
    );
    const tx: QuestionBankDataAccess = { query: db.query, queryOne: db.queryOne, execute };
    const router = createQuestionBankRouter({
        db: tx,
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
        transaction: async <T>(fn: (tx: QuestionBankDataAccess) => Promise<T>) => fn(tx),
    });
    const response = await invokeRoute(router, { method: 'PATCH', url: '/questions/q-1', token: INSTRUCTOR_A, body: { question_text: 'y' } });
    assert.equal(response.statusCode, 409);
});

// ---- POST /questions/:id/archive -----------------------------------------

test('archive: unknown is 404, already archived is 409, success is audited', async () => {
    const unknown = build({ question: null });
    assert.equal((await invokeRoute(unknown.router, { method: 'POST', url: '/questions/q-1/archive', token: INSTRUCTOR_A })).statusCode, 404);
    const archived = build({ question: { ...QUESTION_ROW, archived_at: '2026-01-01 00:00:00' } });
    assert.equal((await invokeRoute(archived.router, { method: 'POST', url: '/questions/q-1/archive', token: INSTRUCTOR_A })).statusCode, 409);
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/questions/q-1/archive', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'question_bank.question.archive'));
});

// ---- GET /export ----------------------------------------------------------

test('export: anonymous 401, cross-tenant 403, and a scoped audited payload', async () => {
    await expectAnonymousDenied(() => build({}), 'GET', '/export');
    const cross = build({});
    assert.equal((await invokeRoute(cross.router, { method: 'GET', url: '/export', token: INSTRUCTOR_B })).statusCode, 403);
    const { router, executed } = build({ list: [QUESTION_ROW] });
    const response = await invokeRoute(router, { method: 'GET', url: '/export', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { format_version?: number; questions?: Array<Record<string, unknown>> };
    assert.equal(body.format_version, 1);
    assert.equal(body.questions?.length, 1);
    assert.ok(auditAction(executed, 'question_bank.export'));
});

// ---- POST /import ---------------------------------------------------------

test('import: rejects an invalid payload with 400 and no write', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, { method: 'POST', url: '/import', token: INSTRUCTOR_A, body: { questions: [{ question_type: 'essay' }] } });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO question_bank_questions')), false);
});

test('import: forces the caller tenant and writes one head+version per entry, audited', async () => {
    const { router, executed } = build({});
    const response = await invokeRoute(router, {
        method: 'POST', url: '/import', token: INSTRUCTOR_A,
        body: { questions: [
            { question_type: 'essay', question_text: 'a', tenant_id: 'tenant-b' },
            { question_type: 'true_false', question_text: 'b', correct_answers: ['false'] },
        ] },
    });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { imported?: number }).imported, 2);
    const heads = executed.filter((e) => e.sql.includes('INSERT INTO question_bank_questions'));
    assert.equal(heads.length, 2);
    assert.ok(heads.every((head) => head.params[1] === 'tenant-a'), 'tenant is forced to the principal tenant');
    assert.ok(auditAction(executed, 'question_bank.import'));
});

test('import: a branch outside the tenant is denied 403 with no write', async () => {
    const { router, executed } = build({ branch: [] });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/import', token: INSTRUCTOR_A,
        body: { questions: [{ question_type: 'essay', question_text: 'a', branch_scope: 'branch', branch_id: 'br-x' }] },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO question_bank_questions')), false);
});

test('owner: the tenant owner sees branch questions without a branch membership', async () => {
    const { router } = build({ list: [{ ...QUESTION_ROW, branch_scope: 'branch', branch_id: 'br-9' }] });
    const response = await invokeRoute(router, { method: 'GET', url: '/questions', token: OWNER_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as unknown[]).length, 1);
});
