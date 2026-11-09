import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, id, principal, scope } from './helpers/student-activity-fixture';
import { createCatalogExamAuthority, parseCatalogExamContext, validateCatalogExamSnapshot } from '../src/services/catalog-exam-access';
import { createExamVersionsRouter, type ExamVersionsDataAccess } from '../src/routes/exam-versions';
import { createExamRouter } from '../src/routes/exams';
import { buildSnapshotEntries } from '../src/services/exam-snapshots';
import { makeReq, runChain, withSilencedErrors } from './helpers/m2-course-lessons-harness';
function world(instant = '2026-11-06T12:00:00.000Z') {
    const base = fixture(), authority = createCatalogExamAuthority();
    const frozen = buildSnapshotEntries([{ source: { questionId: id(31), version: 1, questionType: 'single_choice', questionText: 'Synthetic question', options: ['A', 'B'], correctAnswers: ['A'], points: 1, explanation: null }, position: 1 }]);
    assert.ok(frozen.ok);
    const s = { ...base.s, contextSchema: true, pin: true, bindingTable: true, markerType: 'json', ledgerIndexes: true, failInsert: false, failAudit: false, failCommit: false, failBeforeWrite: false,
        attempts: [] as any[], answers: [] as any[], audits: [] as any[], runs: [] as any[], writes: [] as string[], beforeWrite: null as null | (() => void), afterQuestions: null as null | (() => void),
        header: { id: id(7), exam_id: id(6), tenant_id: 'tenant', version: 1, status: 'published', duration_seconds: 60, opens_at: null as string | null, closes_at: null as string | null, grace_seconds: 0, total_points: '1.00', passing_points: '1.00', scoring_policy: null, published_at: '2026-11-06T00:00:00Z' },
        questions: [{ id: id(30), exam_version_id: id(7), tenant_id: 'tenant', position: 1, question_id: id(31), question_version: 1, question_type: 'single_choice', question_text: 'Synthetic question', options: '["A","B"]', correct_answers: '["A"]', points: '1.00', explanation: null, content_hash: frozen.value[0].contentHash }] as any[] };
    // Keep the base fixture's live gates observable rather than cloning authority.
    const sync = () => { for (const key of ['active', 'suspended', 'version', 'enrolled', 'course', 'lesson', 'released', 'prerequisite', 'schema', 'indexes', 'engine', 'groupCount', 'group', 'bindings', 'assignments', 'exams', 'audiences'])
        (base.s as any)[key] = (s as any)[key]; };
    const metadata = (tables: string[]) => tables.map(table_name => ({ table_name, engine: s.engine }));
    const query = async (sql: string, p: any[] = []): Promise<any[]> => {
        sync();
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q.includes('information_schema.COLUMNS') && q.includes("TABLE_NAME='exam_versioned_attempts'"))
            return s.contextSchema ? [{ column_name: 'catalog_context', data_type: s.markerType }] : [];
        if (q.includes('information_schema.COLUMNS') && q.includes("TABLE_NAME='course_lesson_quiz_versions'"))
            return s.bindingTable ? ['content_id', 'exam_id', 'exam_version_id'].map(column_name => ({ column_name })) : [];
        if (q.includes('information_schema.COLUMNS') && q.includes("IN ('course_lesson_quiz_versions','exam_versions')"))
            return s.schema ? Object.entries({ course_lesson_quiz_versions: ['content_id', 'exam_id', 'exam_version_id'], exam_versions: ['id', 'exam_id', 'tenant_id', 'version', 'status', 'published_at'] }).flatMap(([table_name, columns]) => columns.map(column_name => ({ table_name, column_name }))) : [];
        if (q.includes('information_schema.TABLES') && q.includes("'exam_versioned_attempts'"))
            return metadata(['exam_versioned_attempts', 'exam_version_questions', 'exam_versioned_answers', 'exam_grading_runs']);
        if (q.includes('information_schema.TABLES') && q.includes("'course_lesson_quiz_versions'"))
            return metadata(['course_lesson_quiz_versions', 'exam_versions']);
        if (q.includes('information_schema.STATISTICS') && q.includes("TABLE_NAME='exam_versioned_attempts'"))
            return s.indexes ? [{ index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 }, ...['exam_id', 'student_enrollment_id'].map((column_name, i) => ({ index_name: 'uq_exam_attempt_student', column_name, seq_in_index: i + 1, non_unique: 0 }))] : [];
        if (q.includes('information_schema.STATISTICS') && q.includes("'exam_version_questions'"))
            return s.ledgerIndexes ? [['exam_version_questions', 'PRIMARY', ['id']], ['exam_version_questions', 'uq_exam_version_question', ['exam_version_id', 'position']], ['exam_versioned_answers', 'PRIMARY', ['id']], ['exam_versioned_answers', 'uq_exam_answer', ['attempt_id', 'question_ref']], ['exam_grading_runs', 'PRIMARY', ['id']], ['exam_grading_runs', 'uq_exam_grading_run', ['attempt_id', 'idempotency_key']]].flatMap(([table_name, index_name, columns]) => (columns as string[]).map((column_name, i) => ({ table_name, index_name, column_name, seq_in_index: i + 1, non_unique: 0 }))) : [];
        if (q.includes('information_schema.STATISTICS') && q.includes("'course_lesson_quiz_versions'"))
            return [{ table_name: 'course_lesson_quiz_versions', index_name: 'PRIMARY', column_name: 'content_id', seq_in_index: 1, non_unique: 0 }, { table_name: 'exam_versions', index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 }, ...['exam_id', 'version'].map((column_name, i) => ({ table_name: 'exam_versions', index_name: 'uq_exam_version', column_name, seq_in_index: i + 1, non_unique: 0 }))];
        if (q.includes('information_schema.KEY_COLUMN_USAGE'))
            return [['content_id', 'course_lesson_activities', 'CASCADE'], ['exam_id', 'exams', 'RESTRICT'], ['exam_version_id', 'exam_versions', 'RESTRICT']].map(([column_name, referenced_table, delete_rule]) => ({ column_name, referenced_table, referenced_column: 'id', delete_rule }));
        if (q.startsWith('SELECT content_id FROM course_lesson_quiz_versions'))
            return s.pin ? [{ content_id: id(5) }] : [];
        if (q.startsWith('SELECT q.exam_id'))
            return s.pin && s.header.status === 'published' ? [{ exam_id: id(6), exam_version_id: id(7) }] : [];
        if (q.includes('FROM exam_versions WHERE'))
            return p[0] === s.header.id && p[1] === s.header.exam_id && p[2] === s.header.tenant_id && (!q.includes("status='published'") || s.header.status === 'published') ? [s.header] : [];
        if (q.includes('FROM exam_version_questions')) {
            const rows = structuredClone(s.questions);
            if (q.includes('LIMIT 200'))
                s.afterQuestions?.();
            return rows;
        }
        if (q.includes('FROM exam_versioned_answers a'))
            return s.answers.filter(row => row.attempt_id === p[0]).map(row => ({ question_ref: row.question_ref, valid_ref: row.question_ref, response_json: row.response, response_bytes: Buffer.byteLength(row.response, 'utf8') }));
        if (q.includes('FROM exam_versioned_answers'))
            return s.answers.filter(row => row.attempt_id === p[0]);
        if (q.includes('FROM exam_versioned_attempts')) {
            if (/WHERE exam_id\s*=/.test(q))
                return s.attempts.filter(row => row.exam_id === p[0] && row.student_enrollment_id === p[1] && row.tenant_id === p[2]);
            return s.attempts.filter(row => row.id === p[0] && row.tenant_id === p[1]);
        }
        if (q.startsWith('SELECT id FROM courses WHERE'))
            return s.course ? [{ id: id(1) }] : [];
        if (q.startsWith('SELECT id FROM students WHERE'))
            return s.enrolled && p[0] === scope.enrollmentId && p[1] === principal.id ? [{ id: scope.enrollmentId }] : [];
        if (q.startsWith('SELECT s.id, s.tenant_id')) {
            assert.deepEqual(p, [principal.id, scope.tenantId, scope.enrollmentId]);
            return s.enrolled ? [{ id: scope.enrollmentId, tenant_id: 'tenant', group_id: id(8), branch_id: s.group.branch_id, branch_scope: s.group.branch_scope }] : [];
        }
        return (await base.connection.execute(sql, p))[0];
    };
    const db: ExamVersionsDataAccess = { query: query as any, queryOne: async (sql, p) => (await query(sql, p as any[]))[0] ?? null,
        execute: async (sql, p: any[] = []) => {
            const q = sql.replace(/\s+/g, ' ').trim();
            s.writes.push(q);
            if (q.startsWith('INSERT INTO exam_versioned_attempts')) {
                if (s.failInsert)
                    throw Error('insert');
                assert.ok(q.includes('catalog_context'));
                s.attempts.push({ id: p[0], tenant_id: p[1], exam_id: p[2], exam_version_id: p[3], student_enrollment_id: p[4], student_user_id: p[5], status: 'in_progress', started_at: p[6], deadline_at: p[7], catalog_context: JSON.parse(p[8]), auto_submitted: 0, auto_score: null, score: null, manual_required: 0, grading_fingerprint: null, graded_at: null, passed: null, submitted_at: null, version: 0 });
            }
            else if (q.startsWith('INSERT INTO audit_events')) {
                if (s.failAudit)
                    throw Error('audit');
                s.audits.push(p);
            }
            else if (q.startsWith('INSERT INTO exam_versioned_answers')) {
                const item = { id: p[0], tenant_id: p[1], attempt_id: p[2], exam_version_id: p[3], question_ref: p[4], question_type: p[5], response: p[6] };
                s.answers = s.answers.filter(row => row.attempt_id !== p[2] || row.question_ref !== p[4]);
                s.answers.push(item);
            }
            else if (q.startsWith('UPDATE exam_versioned_attempts')) {
                const row = s.attempts.find(row => row.id === p[8] && row.tenant_id === p[9]);
                if (!row || row.status !== 'in_progress')
                    return { affectedRows: 0 };
                Object.assign(row, { status: p[0], auto_score: p[1], score: p[2], manual_required: p[3], grading_fingerprint: p[4], graded_at: p[5], passed: p[6], auto_submitted: p[7] });
            }
            else if (q.startsWith('INSERT IGNORE INTO exam_grading_runs'))
                s.runs.push(p);
            else
                throw Error('Unexpected mutation ' + q);
            return { affectedRows: 1 };
        } };
    let chain = Promise.resolve();
    const transaction = async <T>(work: (db: ExamVersionsDataAccess) => Promise<T>) => {
        let unlock = () => { };
        const previous = chain;
        chain = new Promise(resolve => { unlock = resolve; });
        await previous;
        const before = structuredClone({ attempts: s.attempts, answers: s.answers, audits: s.audits, runs: s.runs });
        try {
            s.beforeWrite?.();
            const result = await work(db);
            if (s.failCommit)
                throw Object.assign(Error('commit'), { committed: true });
            return result;
        }
        catch (error) {
            if (!(error as any).committed)
                Object.assign(s, before);
            throw error;
        }
        finally {
            unlock();
        }
    };
    const now = () => new Date(instant);
    const router = createExamVersionsRouter({ db, authenticate: (_req, _res, next) => next(), loadActiveTenantAuthority: async () => null, now, transaction, catalog: authority });
    const selectors = { courseId: id(1), lessonId: id(2), contentId: id(5) };
    const call = (method: string, pathName: string, body: any = {}, actor: any = principal) => { const req: any = makeReq({ method, pathName, body }); req.user = actor; return runChain([router], req); };
    const attemptPath = `/catalog/courses/${id(1)}/lessons/${id(2)}/activities/${id(5)}/attempt`;
    return { s, db, authority, selectors, router, call, attemptPath, start: () => call('POST', attemptPath), recover: () => call('GET', attemptPath) };
}
test('catalog start persists its context in the original engine insert; recovery/retry never creates a second attempt', async () => {
    const h = world();
    assert.deepEqual((await h.recover()).body, { attempt: null });
    assert.equal(h.s.writes.length, 0);
    const created = await h.start();
    assert.equal(created.status, 201);
    assert.equal(created.body.attempt.deadline_at, '2026-11-06T12:01:00.000Z');
    assert.equal(created.headers['Cache-Control'], 'no-store');
    assert.equal(h.s.attempts.length, 1);
    assert.equal(h.s.audits.length, 1);
    const context = parseCatalogExamContext(h.s.attempts[0].catalog_context);
    assert.equal(context.contentId, id(5));
    assert.equal(context.enrollmentId, scope.enrollmentId);
    assert.equal(context.snapshotFingerprint.length, 64);
    assert.equal((await h.recover()).body.attempt.id, created.body.attempt.id);
    assert.equal((await h.start()).body.unchanged, true);
    assert.equal(h.s.attempts.length, 1);
    assert.equal(h.s.audits.length, 1);
});
test('fractional start clock returns the same stored UTC seconds and deadline on recovery', async () => {
    const h = world('2026-11-06T12:00:00.987Z');
    const created = await h.start();
    assert.equal(created.status, 201);
    assert.equal(created.body.attempt.started_at, '2026-11-06T12:00:00.000Z');
    assert.equal(created.body.attempt.deadline_at, '2026-11-06T12:01:00.000Z');
    assert.deepEqual((await h.recover()).body.attempt, created.body.attempt);
    assert.deepEqual((await h.start()).body.attempt, created.body.attempt);
    assert.equal(h.s.attempts.length, 1);
});

test('actual bound attempt read/autosave/submit reuse the existing frozen grading engine and never disclose the answer key', async () => {
    const h = world();
    await h.start();
    const attempt = h.s.attempts[0], path = '/attempts/' + attempt.id;
    const read = await h.call('GET', path);
    assert.equal(read.status, 200);
    assert.equal(read.headers['Cache-Control'], 'no-store');
    assert.ok(!('correct_answers' in read.body.questions[0]));
    const save = await h.call('POST', path + '/autosave', { answers: { [id(30)]: 'A' } });
    assert.equal(save.status, 200);
    assert.equal(h.s.answers.length, 1);
    const resumed = await h.call('GET', path);
    assert.deepEqual(resumed.body.answers, { [id(30)]: 'A' });
    const submit = await h.call('POST', path + '/submit', { answers: { [id(30)]: 'A' } });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.auto_score, 1);
    assert.equal(h.s.runs.length, 1);
    assert.equal(h.s.attempts[0].status, 'graded');
});
for (const gate of ['released', 'prerequisite', 'enrolled', 'course', 'active', 'pin'] as const)
    test(`withdrawn ${gate} denies next read/save/submit without a write`, async () => withSilencedErrors(async () => {
        const h = world();
        await h.start();
        h.s[gate] = false;
        const path = '/attempts/' + h.s.attempts[0].id, before = h.s.writes.length;
        for (const [method, suffix] of [['GET', ''], ['POST', '/autosave'], ['POST', '/submit']])
            assert.ok([403, 404, 500].includes((await h.call(method, path + suffix, { answers: { [id(30)]: 'A' } })).status));
        assert.equal(h.s.writes.length, before);
        assert.equal(h.s.answers.length, 0);
    }));
test('a source change during question acquisition prevents response bytes, and a withdrawal at transaction entry prevents saving', async () => withSilencedErrors(async () => {
    const h = world();
    await h.start();
    const path = '/attempts/' + h.s.attempts[0].id;
    h.s.afterQuestions = () => { h.s.pin = false; };
    assert.equal((await h.call('GET', path)).status, 403);
    h.s.afterQuestions = null;
    h.s.pin = true;
    h.s.beforeWrite = () => { h.s.released = false; };
    const before = h.s.writes.length;
    assert.equal((await h.call('POST', path + '/autosave', { answers: { [id(30)]: 'A' } })).status, 403);
    assert.equal(h.s.writes.length, before);
}));
for (const change of ['hash', 'timing', 'points', 'schema', 'markerType', 'ledgerIndexes'] as const)
    test(`invalid ${change} fails closed at start or on a stored snapshot`, async () => withSilencedErrors(async () => {
        const h = world();
        if (change === 'hash')
            h.s.questions[0].content_hash = 'a'.repeat(64);
        if (change === 'timing')
            h.s.header.opens_at = 'invalid';
        if (change === 'points')
            h.s.header.total_points = '2.00';
        if (change === 'schema')
            h.s.contextSchema = false;
        if (change === 'markerType')
            h.s.markerType = 'text';
        if (change === 'ledgerIndexes')
            h.s.ledgerIndexes = false;
        assert.equal((await h.start()).status, 503);
        assert.equal(h.s.attempts.length, 0);
        assert.equal(h.s.audits.length, 0);
    }));
test('question/timing fingerprints reject even internally valid snapshot replacement and never reset the exam allowance', async () => withSilencedErrors(async () => {
    const h = world();
    await h.start();
    h.s.header.duration_seconds = 120;
    assert.equal(await h.authority.check(h.db, principal, h.s.attempts[0]), false);
    h.s.header.duration_seconds = 60;
    h.s.attempts[0].catalog_context.lessonId = id(99);
    assert.equal((await h.start()).status, 409);
    assert.equal(h.s.attempts.length, 1);
}));
test('generic versioned and legacy exam endpoints cannot bypass a bound exam', async () => {
    const h = world();
    const generic = await h.call('POST', `/exams/${id(6)}/versions/${id(7)}/attempts`);
    assert.equal(generic.status, 403);
    assert.equal(h.s.attempts.length, 0);
    const legacy = createExamRouter({ db: h.db as any, optionalAuthenticate: (_q, _s, next) => next(), authenticate: (_q, _s, next) => next(), requireTeachingWriteAccess: (_q, _s, next) => next(), catalog: h.authority });
    for (const path of [`/${id(6)}/questions`, `/%30${id(6).slice(1)}/questions`, `/${id(6)}/can-attempt/student`, `/${id(6)}/start/student`, `/${id(6)}/submit/student`, `/${id(6)}/review/student`]) {
        const req: any = makeReq({ method: path.includes('start') || path.includes('submit') ? 'POST' : 'GET', pathName: path });
        req.user = principal;
        assert.equal((await runChain([legacy], req)).status, 403);
    }
});
test('unbound historical attempts are never backfilled or used to create another attempt', async () => {
    const h = world();
    await h.start();
    h.s.attempts[0].catalog_context = null;
    assert.equal((await h.start()).body.code, 'CATALOG_ATTEMPT_UNBOUND');
    assert.equal((await h.call('GET', '/attempts/' + h.s.attempts[0].id)).status, 403);
    assert.equal(h.s.attempts.length, 1);
});
test('concurrent duplicate starts create one attempt/audit, and lost commit response is recovered by a pure GET', async () => {
    const h = world();
    const replies = await Promise.all([h.start(), h.start()]);
    assert.deepEqual(replies.map(row => row.status), [201, 200]);
    assert.equal(h.s.attempts.length, 1);
    assert.equal(h.s.audits.length, 1);
    const uncertain = world();
    uncertain.s.failCommit = true;
    assert.equal((await uncertain.start()).body.code, 'PERSISTENCE_UNCERTAIN');
    uncertain.s.failCommit = false;
    assert.equal((await uncertain.recover()).status, 200);
    assert.equal(uncertain.s.attempts.length, 1);
    assert.equal(uncertain.s.audits.length, 1);
});
for (const failure of ['failInsert', 'failAudit'] as const)
    test(`${failure} cannot leave an acknowledged or partial catalog attempt`, async () => {
        const h = world();
        h.s[failure] = true;
        assert.equal((await h.start()).body.code, 'PERSISTENCE_UNCERTAIN');
        assert.equal(h.s.attempts.length, 0);
        assert.equal(h.s.audits.length, 0);
    });
test('server-side settlement fingerprint checks preserve withdrawal policy without grading changed snapshots', async () => {
    const h = world();
    await h.start();
    h.s.pin = false;
    assert.equal(await h.authority.checkFrozen(h.db, h.s.attempts[0]), true);
    h.s.header.duration_seconds = 120;
    assert.equal(await h.authority.checkFrozen(h.db, h.s.attempts[0]), false);
});
test('request selectors and workspace mismatch never become authority, and the original close boundary denies start', async () => {
    const h = world();
    assert.equal((await h.call('POST', h.attemptPath, { exam_id: id(6) })).status, 400);
    assert.equal((await h.call('POST', h.attemptPath, {}, { ...principal, studentEnrollmentId: 'foreign' })).status, 404);
    h.s.header.closes_at = '2026-11-06T12:00:00.000Z';
    assert.equal((await h.start()).body.code, 'closed');
    assert.equal(h.s.attempts.length, 0);
});
test('committed autosave and submit with a lost response remain observable, not duplicate writes or fresh attempts', async () => withSilencedErrors(async () => {
    const h = world();
    await h.start();
    const path = '/attempts/' + h.s.attempts[0].id;
    h.s.failCommit = true;
    const save = await h.call('POST', path + '/autosave', { answers: { [id(30)]: 'A' } });
    assert.equal(save.status, 503);
    assert.equal(save.body.code, 'PERSISTENCE_UNCERTAIN');
    h.s.failCommit = false;
    assert.deepEqual((await h.call('GET', path)).body.answers, { [id(30)]: 'A' });
    assert.equal(h.s.answers.length, 1);
    h.s.failCommit = true;
    const submit = await h.call('POST', path + '/submit', { answers: { [id(30)]: 'A' } });
    assert.equal(submit.body.code, 'PERSISTENCE_UNCERTAIN');
    h.s.failCommit = false;
    assert.equal((await h.recover()).body.attempt.status, 'graded');
    assert.equal((await h.call('POST', path + '/submit', { answers: { [id(30)]: 'A' } })).status, 409);
    assert.equal(h.s.runs.length, 1);
    assert.equal(h.s.attempts.length, 1);
}));
test('submit revalidates inside the transaction before any grade/answer/audit is written', async () => withSilencedErrors(async () => {
    const h = world();
    await h.start();
    const before = h.s.writes.length;
    h.s.beforeWrite = () => { h.s.pin = false; };
    assert.equal((await h.call('POST', '/attempts/' + h.s.attempts[0].id + '/submit', { answers: { [id(30)]: 'A' } })).status, 403);
    assert.equal(h.s.writes.length, before);
    assert.equal(h.s.runs.length, 0);
    assert.equal(h.s.attempts[0].status, 'in_progress');
}));
test('a valid replacement question/hash still cannot change the snapshot captured by an existing attempt', async () => {
    const h = world();
    await h.start();
    const changed = buildSnapshotEntries([{ source: { questionId: id(31), version: 1, questionType: 'single_choice', questionText: 'Changed', options: ['A', 'B'], correctAnswers: ['B'], points: 1, explanation: null }, position: 1 }]);
    assert.ok(changed.ok);
    Object.assign(h.s.questions[0], { question_text: 'Changed', correct_answers: '["B"]', content_hash: changed.value[0].contentHash });
    assert.equal(await h.authority.check(h.db, principal, h.s.attempts[0]), false);
});
test('catalog draft recovery is bounded and cannot echo an oversized saved payload', async () => withSilencedErrors(async () => {
    const h = world();
    await h.start();
    h.s.answers.push({ attempt_id: h.s.attempts[0].id, question_ref: id(30), response: JSON.stringify('x'.repeat(131073)) });
    const result = await h.call('GET', '/attempts/' + h.s.attempts[0].id);
    assert.equal(result.status, 500);
    assert.ok(!JSON.stringify(result.body).includes('xxxx'));
}));
test('catalog creation requires an actual transaction seam and never accepts a body-supplied context', async () => {
    const h = world();
    const router = createExamVersionsRouter({ db: h.db, authenticate: (_q, _s, next) => next(), loadActiveTenantAuthority: async () => null, catalog: h.authority });
    const req: any = makeReq({ method: 'POST', pathName: h.attemptPath });
    req.user = principal;
    assert.equal((await runChain([router], req)).status, 503);
    assert.equal(h.s.writes.length, 0);
    assert.equal((await h.call('POST', h.attemptPath, { catalog_context: { userId: 'forged' } })).status, 400);
});
