import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { makeReq, runChain, squash, withSilencedErrors } from './helpers/m2-course-lessons-harness';
const id = (n: number) => `c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const course = id(1), unit = id(2), lesson = id(3), homework = id(4), quiz = id(5);
function fixture() {
  const s = { owner: true, course: true, unit: true, lesson: true, schema: true, engine: 'InnoDB', indexes: true,
    failAudit: false, failInsert: false, failCommit: false, acquired: 0, events: [] as string[], calls: [] as string[], bindings: [] as any[], audits: [] as any[], groups: [] as any[],
    assignments: [{ id: homework, title: 'واجب تجريبي', tenant_id: 'tenant', course_id: course, status: 'draft', archived_at: null, group_id: null, branch_id: null, branch_scope: 'tenant', instructions: 'private instructions' }] as any[],
    exams: [{ id: quiz, title: 'كويز تجريبي', course_id: course, tenant_id: 'tenant', is_active: 1, is_published: 0, correct_answer: 'private answer' }] as any[] };
  let chain = Promise.resolve();
  const getConnection = async () => {
    s.acquired++; let before: any, unlock = () => {};
    return {
      beginTransaction: async () => { const previous = chain; chain = new Promise(resolve => { unlock = resolve; }); await previous; before = structuredClone({ bindings: s.bindings, audits: s.audits }); s.events.push('begin'); },
      execute: async (sql: string, params: any[] = []): Promise<[any, any]> => {
        const q = squash(sql); s.calls.push(q);
        if (q.includes('FROM tenants t JOIN users')) return [[{ owner_user_id: s.owner ? 'owner' : 'foreign', tenant_status: 'active', caller_active: 1 }], []];
        if (q.includes('FROM courses c')) return [s.course && params[0] === course && params[1] === 'tenant' ? [{ id: course, tenant_id: 'tenant' }] : [], []];
        if (q.includes('FROM course_units u')) return [s.unit && params[0] === unit && params[1] === course ? [{ id: unit }] : [], []];
        if (q.startsWith('SELECT l.id FROM course_lessons')) return [s.lesson && params[0] === lesson && params[1] === unit ? [{ id: lesson }] : [], []];
        if (q.includes('information_schema.COLUMNS')) return [s.schema ? Object.entries({ course_lesson_activities: ['id', 'lesson_id', 'kind', 'assignment_id', 'exam_id'], assignments: ['id', 'tenant_id', 'course_id', 'title', 'status', 'archived_at', 'group_id', 'branch_id', 'branch_scope'], exams: ['id', 'course_id', 'title', 'is_active', 'is_published'], exam_groups: ['exam_id', 'group_id'] }).flatMap(([table_name, columns]) => columns.map(column_name => ({ table_name, column_name }))) : [], []];
        if (q.includes('information_schema.TABLES')) return [['course_lesson_activities', 'assignments', 'exams', 'exam_groups', 'course_lessons', 'course_units', 'courses', 'tenants', 'users', 'audit_events', 'groups', 'branches'].map(table_name => ({ table_name, engine: s.engine })), []];
        if (q.includes('information_schema.STATISTICS')) return [s.indexes ? ['course_lesson_activities', 'assignments', 'exams'].flatMap(table_name => [{ table_name, index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 }, ...(table_name === 'course_lesson_activities' ? ['lesson_id', 'kind'].map((column_name, i) => ({ table_name, index_name: 'uq_lesson_activity_kind', column_name, seq_in_index: i + 1, non_unique: 0 })) : [])]) : [], []];
        if (q.startsWith('SELECT id,kind,assignment_id')) return [s.bindings.filter(row => row.lesson_id === params[0]).sort((a, b) => a.kind.localeCompare(b.kind)).slice(0, 3), []];
        if (q.startsWith('SELECT s.id,s.title')) {
          assert.ok(q.includes('s.course_id=?')); assert.ok(q.includes('c.tenant_id=?')); assert.ok(q.includes('LIMIT 26')); assert.ok(!q.includes('SELECT *'));
          const assignment = q.includes('FROM assignments s'), byIds = q.includes('s.id IN');
          const values = params.slice(assignment ? 3 : 2);
          return [(assignment ? s.assignments : s.exams).filter(row => row.course_id === params[1] && row.tenant_id === params[0]
            && (assignment ? row.archived_at === null && ['draft', 'published'].includes(row.status) : row.is_active === 1)
            && (byIds ? values.some(value => value.toLowerCase() === row.id.toLowerCase()) : row.id > values[0])).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 26), []];
        }
        if (q.includes('FROM exam_groups eg LEFT JOIN')) return [s.groups.filter(row => params.includes(row.exam_id)).slice(0, 521), []];
        if (q.includes('FROM `groups` g LEFT JOIN')) return [s.groups.filter(row => params.includes(row.id)).slice(0, 521), []];
        if (q.startsWith('INSERT INTO course_lesson_activities')) { if (s.failInsert) throw Error('insert failed'); s.bindings.push({ id: params[0], lesson_id: params[1], kind: params[2], assignment_id: params[3], exam_id: params[4] }); return [{ affectedRows: 1 }, []]; }
        if (q.startsWith('DELETE FROM course_lesson_activities')) { const before = s.bindings.length; s.bindings = s.bindings.filter(row => !(row.id === params[0] && row.lesson_id === params[1] && row.kind === params[2])); return [{ affectedRows: before - s.bindings.length }, []]; }
        if (q.startsWith('INSERT INTO audit_events')) { if (s.failAudit) throw Error('audit failed'); s.audits.push(params); return [{ affectedRows: 1 }, []]; }
        throw Error('Unexpected synthetic SQL ' + q);
      },
      commit: async () => { s.events.push('commit'); if (s.failCommit) throw Error('lost ack'); },
      rollback: async () => { s.events.push('rollback'); Object.assign(s, before); }, release: () => { s.events.push('release'); unlock(); }, destroy: () => { s.events.push('destroy'); unlock(); },
    };
  };
  const router = createCourseLessonsRouter({ getConnection });
  const request = (method = 'GET', suffix = '', body: any = {}, query: any = {}, user: any = { id: 'owner', role: 'instructor', tenantId: 'tenant' }) => {
    const req: any = makeReq({ method, pathName: `/courses/${course}/units/${unit}/lessons/${lesson}/activities${suffix}`, body, query });
    req.user = user; return runChain([router], req);
  };
  return { s, request };
}
test('activity preparation binds both real source kinds without publishing, attempts, answers or progress writes', async () => {
  const { s, request } = fixture();
  const empty = await request(); assert.deepEqual(empty.body, { activities: [] }); assert.equal(empty.headers['Cache-Control'], 'no-store');
  for (const [kind, source_id] of [['homework', homework], ['quiz', quiz]]) {
    const created = await request('POST', '/' + kind, { source_id }); assert.equal(created.status, 201); assert.equal(created.body.content.source_status, 'draft');
    assert.equal((await request('POST', '/' + kind, { source_id })).body.unchanged, true);
  }
  const read = await request(); assert.equal(read.status, 200); assert.equal(read.body.activities.length, 2); assert.equal(s.audits.length, 2);
  assert.ok(!JSON.stringify(read.body).includes('private')); assert.ok(!s.calls.some(q => /^(INSERT|UPDATE|DELETE).*(exam_attempt|exam_question|assignment_submission|completions)/i.test(q)));
  assert.equal(s.assignments[0].status, 'draft'); assert.equal(s.exams[0].is_published, 0);
});
for (const kind of ['homework', 'quiz']) test(`${kind} selector is bounded and same-course/tenant, with no private source payload`, async () => {
  const { s, request } = fixture(); const rows = kind === 'homework' ? s.assignments : s.exams;
  for (let n = 10; n < 40; n++) rows.push({ ...rows[0], id: id(n) });
  rows.push({ ...rows[0], id: id(90), tenant_id: 'foreign' }, { ...rows[0], id: id(91), course_id: id(99) });
  const first = await request('GET', `/${kind}/available-sources`); assert.equal(first.body.sources.length, 25); assert.ok(first.body.next_cursor);
  assert.deepEqual(Object.keys(first.body.sources[0]), ['source_id', 'title', 'source_status', 'audience']);
  const next = await request('GET', `/${kind}/available-sources`, {}, { cursor: first.body.next_cursor }); assert.equal(next.body.sources.length, 6); assert.equal(next.body.next_cursor, null);
  assert.equal((await request('POST', '/' + kind, { source_id: id(90) })).status, 404); assert.equal((await request('POST', '/' + kind, { source_id: id(91) })).status, 404); assert.equal(s.audits.length, 0);
});
test('paths, exact bodies, identity selectors, billing-only accounts and missing scope deny before connection', async () => {
  const { s, request } = fixture();
  for (const body of [{ source_id: homework, tenant_id: 'foreign' }, { source_id: 'bad' }, [], null]) assert.equal((await request('POST', '/homework', body)).status, 400);
  assert.equal((await request('GET', '/homework/available-sources', {}, { tenant_id: 'foreign' })).status, 400);
  assert.equal((await request('POST', '/other', { source_id: homework })).status, 400);
  assert.equal((await request('GET', '', {}, {}, { id: 'owner', tenantId: 'tenant', billingOnly: true })).status, 403);
  assert.equal((await request('GET', '', {}, {}, { id: 'owner' })).status, 404); assert.equal(s.acquired, 0);
});
for (const cause of ['owner', 'course', 'unit', 'lesson']) test(`activity parent ${cause} is derived from current rows`, async () => {
  const { s, request } = fixture(); (s as any)[cause] = false;
  assert.equal((await request('POST', '/homework', { source_id: homework })).status, cause === 'owner' ? 403 : 404); assert.equal(s.bindings.length, 0); assert.equal(s.audits.length, 0);
});
for (const cause of ['schema', 'indexes', 'engine']) test(`actual ${cause} readiness fails closed`, async () => {
  const { s, request } = fixture(); if (cause === 'engine') s.engine = 'MyISAM'; else s[cause] = false;
  assert.equal((await request('POST', '/quiz', { source_id: quiz })).status, 503); assert.equal(s.bindings.length, 0);
});
test('source audience must stay in the course and have classified live branch facts', async () => {
  const { s, request } = fixture(); const group = { id: id(20), course_id: course, branch_scope: 'branch', branch_id: id(21), resolved_branch_id: id(21), branch_tenant_id: 'tenant', branch_status: 'active', exam_id: quiz };
  s.groups = [group]; Object.assign(s.assignments[0], { group_id: group.id, branch_id: group.branch_id, branch_scope: 'branch' });
  assert.equal((await request('GET', '/quiz/available-sources')).body.sources[0].audience, 'restricted');
  assert.equal((await request('POST', '/homework', { source_id: homework })).status, 201);
  group.branch_status = 'inactive'; assert.equal((await request('POST', '/quiz', { source_id: quiz })).status, 404);
  assert.equal((await request()).body.activities[0].title, null);
  group.branch_status = 'active'; group.course_id = id(90); assert.equal((await request('POST', '/quiz', { source_id: quiz })).status, 404);
});
test('source withdrawal hides titles and detach does not modify the original; stale deletes cannot remove a replacement', async () => {
  const { s, request } = fixture(); const first = await request('POST', '/homework', { source_id: homework });
  s.assignments[0].status = 'closed'; assert.equal((await request()).body.activities[0].title, null);
  assert.equal((await request('DELETE', '/homework/' + id(99))).status, 409); assert.equal(s.bindings.length, 1);
  assert.equal((await request('DELETE', '/homework/' + first.body.content.content_id)).body.detached, true); assert.equal(s.assignments.length, 1); assert.equal(s.assignments[0].status, 'closed');
  assert.equal((await request('DELETE', '/homework/' + first.body.content.content_id)).body.detached, false);
});
test('occupied slots never overwrite implicitly, and concurrent duplicate attachments create one audit', async () => {
  const { s, request } = fixture(); const replies = await Promise.all([request('POST', '/quiz', { source_id: quiz }), request('POST', '/quiz', { source_id: quiz })]);
  assert.deepEqual(replies.map(reply => reply.status), [201, 200]); assert.equal(s.audits.length, 1);
  s.exams.push({ ...s.exams[0], id: id(8) }); assert.equal((await request('POST', '/quiz', { source_id: id(8) })).status, 409); assert.equal(s.bindings[0].exam_id, quiz);
});
for (const failure of ['failInsert', 'failAudit'] as const) test(`activity ${failure} rolls back reference and audit`, async () => withSilencedErrors(async () => {
  const { s, request } = fixture(); s[failure] = true; assert.equal((await request('POST', '/homework', { source_id: homework })).status, 500); assert.equal(s.bindings.length, 0); assert.equal(s.audits.length, 0);
}));
test('unknown commit returns uncertainty, destroys connection and read reconciles without a second insert', async () => withSilencedErrors(async () => {
  const { s, request } = fixture(); s.failCommit = true;
  const result = await request('POST', '/quiz', { source_id: quiz }); assert.equal(result.status, 500); assert.equal(result.body.code, 'PERSISTENCE_UNCERTAIN'); assert.deepEqual(s.events, ['begin', 'commit', 'destroy']);
  s.failCommit = false; const read = await request(); assert.equal(read.body.activities.length, 1); assert.equal(s.audits.length, 1);
}));
test('detach audit failure restores the original reference and existing audit', async () => withSilencedErrors(async () => {
  const { s, request } = fixture(); const created = await request('POST', '/quiz', { source_id: quiz }); s.failAudit = true;
  assert.equal((await request('DELETE', '/quiz/' + created.body.content.content_id)).status, 500); assert.equal(s.bindings.length, 1); assert.equal(s.audits.length, 1);
}));
test('quiz audience proofs are bounded, reject duplicate or excessive groups and batch one versus twenty-five sources', async () => withSilencedErrors(async () => {
  const { s, request } = fixture(); const group = { id: id(30), exam_id: quiz, course_id: course, branch_scope: 'tenant', branch_id: null };
  s.groups = [group]; s.calls = []; await request('GET', '/quiz/available-sources'); const single = s.calls.length;
  for (let n = 10; n < 34; n++) { s.exams.push({ ...s.exams[0], id: id(n) }); s.groups.push({ ...group, exam_id: id(n) }); }
  s.calls = []; assert.equal((await request('GET', '/quiz/available-sources')).body.sources.length, 25); assert.equal(s.calls.length, single);
  s.groups.push({ ...group }); assert.equal((await request('POST', '/quiz', { source_id: quiz })).status, 404);
  s.groups = Array.from({ length: 21 }, (_, n) => ({ ...group, id: id(100 + n) })); assert.equal((await request('POST', '/quiz', { source_id: quiz })).status, 404);
  s.groups = Array.from({ length: 521 }, (_, n) => ({ ...group, id: id(1000 + n) })); assert.equal((await request('POST', '/quiz', { source_id: quiz })).status, 500); assert.equal(s.audits.length, 0);
}));
