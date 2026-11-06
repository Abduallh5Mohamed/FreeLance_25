import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture as audienceFixture, id, principal, scope } from './helpers/student-activity-fixture';
import { makeReq, runChain, withSilencedErrors } from './helpers/m2-course-lessons-harness';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { createStudentCourseAccessRouter } from '../src/routes/student-course-access';
function world() {
    const base = audienceFixture();
    const s = { ...base.s, owner: true, unit: true, publicationSchema: true, publicationIndex: true, publicationFk: true, failAudit: false, failCommit: false, publications: [] as any[], audits: [] as any[], writes: [] as string[], candidates: [{ id: 'enrollment' }] as any[], ref: { id: id(30), announcement_id: id(31) } as any,
        source: { id: id(31), group_id: id(8), title: 'إعلان مراجع', body: 'النص المراجع', state: 'published', tenant_id: 'tenant', course_id: id(1), group_name: 'المجموعة', branch_scope: 'tenant', branch_id: null, resolved_branch_id: null, branch_tenant_id: null, branch_status: null } as any,
        revision: '2026-11-06 12:00:00.000000', gates: { publication_state: 'published', lesson_status: 'active', unit_status: 'active', released: 1, prerequisite_lesson_id: null, previewed_at_epoch: 1793966400 } };
    const columns: Record<string, string[]> = { course_lesson_announcements: ['id', 'lesson_id', 'announcement_id'], group_announcements: ['id', 'tenant_id', 'group_id', 'title', 'body', 'state', 'updated_at'], groups: ['id', 'name', 'course_id', 'branch_id', 'branch_scope'], branches: ['id', 'tenant_id', 'status'], students: ['id', 'user_id', 'tenant_id', 'group_id', 'is_active', 'approval_status', 'enrollment_status', 'enrollment_start_date', 'enrollment_end_date'], users: ['id', 'is_active', 'suspended_until'], student_courses: ['student_id', 'course_id', 'status'], branch_memberships: ['branch_id', 'user_id', 'status', 'role'] };
    const sync = () => { for (const key of ['active', 'suspended', 'version', 'enrolled', 'course', 'lesson', 'released', 'prerequisite', 'schema', 'indexes', 'engine', 'groupCount', 'group', 'bindings', 'assignments', 'exams', 'audiences'])
        (base.s as any)[key] = (s as any)[key]; };
    const execute = async (sql: string, p: any[] = []): Promise<[
        any,
        any
    ]> => {
        sync();
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q.includes('information_schema.COLUMNS')) {
            if (q.includes("TABLE_NAME='course_lesson_announcement_publications'"))
                return [s.publicationSchema ? [...['id', 'content_id', 'group_id', 'published_at'].map(column_name => ({ table_name: 'course_lesson_announcement_publications', column_name })), { table_name: 'course_lesson_announcement_publications', column_name: 'source_fingerprint', data_type: 'char', max_length: 64, collation_name: 'ascii_bin' }, { table_name: 'group_announcements', column_name: 'updated_at' }] : [], []];
            return [s.schema ? Object.entries(columns).flatMap(([table_name, cols]) => cols.map(column_name => ({ table_name, column_name }))) : [], []];
        }
        if (q.includes('information_schema.TABLES')) {
            if (q.includes("TABLE_NAME='course_lesson_announcement_publications'"))
                return [[{ engine: s.engine }], []];
            const names = [...Object.keys(columns), 'courses', 'course_units', 'course_lessons', 'tenants', 'audit_events', 'course_lesson_completions'];
            return [names.filter(name => q.includes("'" + name + "'")).map(table_name => ({ table_name, engine: s.engine })), []];
        }
        if (q.includes('information_schema.STATISTICS')) {
            if (q.includes("TABLE_NAME='course_lesson_announcement_publications'"))
                return [s.publicationIndex ? [['PRIMARY', 'id'], ['uq_lesson_announcement_publication', 'content_id']].map(([index_name, column_name]) => ({ index_name, column_name, seq_in_index: 1, non_unique: 0 })) : [], []];
            return [s.indexes ? [...['course_lesson_announcements', 'group_announcements', 'groups', 'students'].map(table_name => ({ table_name, index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 })), { table_name: 'course_lesson_announcements', index_name: 'uq_lesson_announcement', column_name: 'lesson_id', seq_in_index: 1, non_unique: 0 }] : [], []];
        }
        if (q.includes('information_schema.KEY_COLUMN_USAGE'))
            return [q.includes("k.TABLE_NAME='course_lesson_announcement_publications'") ? (s.publicationFk ? [{ column_name: 'content_id', referenced_table: 'course_lesson_announcements', referenced_column: 'id', delete_rule: 'CASCADE' }] : []) : [['lesson_id', 'course_lessons'], ['announcement_id', 'group_announcements']].map(([column_name, referenced_table]) => ({ column_name, referenced_table, referenced_column: 'id', delete_rule: 'CASCADE' })), []];
        if (q.includes('FROM tenants t JOIN users'))
            return [[{ owner_user_id: s.owner ? 'owner' : 'foreign', tenant_status: 'active', caller_active: 1 }], []];
        if (q.includes('FROM courses c'))
            return [s.course && p[0] === id(1) ? [{ id: id(1), tenant_id: 'tenant' }] : [], []];
        if (q.includes('FROM course_units u'))
            return [s.unit ? [{ id: id(9) }] : [], []];
        if (q.startsWith('SELECT l.id FROM course_lessons'))
            return [s.lesson ? [{ id: id(2) }] : [], []];
        if (q.startsWith('SELECT id,announcement_id'))
            return [s.ref ? [s.ref] : [], []];
        if (q.includes('FROM group_announcements a'))
            return [s.source.tenant_id === p[0] && s.source.course_id === p[2] && s.source.id === p[3] && ['draft', 'published'].includes(s.source.state) ? [s.source] : [], []];
        if (q.startsWith('SELECT DATE_FORMAT'))
            return [[{ source_revision: s.revision }], []];
        if (q.startsWith('SELECT c.publication_state'))
            return [[s.gates], []];
        if (q.startsWith('SELECT s.id FROM students'))
            return [s.candidates.slice(0, 501), []];
        if (q.startsWith('SELECT id,content_id,group_id,source_fingerprint'))
            return [s.publications.filter(row => row.content_id === p[0]), []];
        if (q.startsWith('INSERT INTO course_lesson_announcement_publications')) {
            s.writes.push(q);
            s.publications.push({ id: p[0], content_id: p[1], group_id: p[2], source_fingerprint: p[3], published_epoch: 1793966400 });
            return [{ affectedRows: 1 }, []];
        }
        if (q.startsWith('DELETE FROM course_lesson_announcement_publications')) {
            s.writes.push(q);
            const before = s.publications.length;
            s.publications = s.publications.filter(row => row.id !== p[0] || row.content_id !== p[1]);
            return [{ affectedRows: before - s.publications.length }, []];
        }
        if (q.startsWith('INSERT INTO audit_events')) {
            if (s.failAudit)
                throw Error('audit');
            s.audits.push(p);
            return [{ affectedRows: 1 }, []];
        }
        return base.connection.execute(sql, p);
    };
    let chain = Promise.resolve();
    const getConnection = async () => { let unlock = () => { }, before: any; return { execute, beginTransaction: async () => { const old = chain; chain = new Promise(resolve => { unlock = resolve; }); await old; before = structuredClone({ publications: s.publications, audits: s.audits }); }, commit: async () => { before = null; if (s.failCommit)
            throw Error('commit'); }, rollback: async () => { if (before)
            Object.assign(s, before); }, release: () => unlock(), destroy: () => unlock() }; };
    const ownerRouter = createCourseLessonsRouter({ query: async () => [], getConnection }), studentRouter = createStudentCourseAccessRouter({ query: async () => [], getConnection });
    const path = `/courses/${id(1)}/units/${id(9)}/lessons/${id(2)}/announcement/${id(30)}`;
    const owner = (method = 'GET', suffix = '/publication', body: any = {}) => { const req: any = makeReq({ method, pathName: path + suffix, body }); req.user = { id: 'owner', tenantId: 'tenant', role: 'instructor' }; return runChain([ownerRouter], req); };
    const student = () => { const req: any = makeReq({ method: 'GET', pathName: `/courses/${id(1)}/lessons/${id(2)}/announcement` }); req.user = principal; return runChain([studentRouter], req); };
    const review = () => owner('GET', '/publication-preview');
    const publish = async () => { const r = await review(); assert.equal(r.status, 200); return owner('POST', '/publication', { review_token: r.body.review_token }); };
    return { s, owner, student, review, publish };
}
test('explicit publication exposes only reviewed text to the actual lesson/group student; private source publication alone does not', async () => {
    const h = world();
    assert.equal((await h.student()).body.announcement, null);
    const result = await h.publish();
    assert.equal(result.status, 201);
    assert.equal(h.s.audits.length, 1);
    const student = await h.student();
    assert.equal(student.status, 200);
    assert.equal(student.headers['Cache-Control'], 'no-store');
    assert.deepEqual(Object.keys(student.body.announcement).sort(), ['body', 'content_id', 'publication_id', 'published_at', 'title']);
    assert.equal(student.body.announcement.body, 'النص المراجع');
    assert.ok(!JSON.stringify(student.body).includes('source_fingerprint'));
    assert.equal(h.s.source.state, 'published');
});
for (const change of ['text', 'revision', 'audience', 'lesson', 'reference'] as const)
    test(`changed ${change} invalidates a reviewed token without mutation`, async () => {
        const h = world(), r = await h.review();
        assert.equal(r.status, 200);
        if (change === 'text')
            h.s.source.body = 'تعديل جديد';
        if (change === 'revision')
            h.s.revision = '2026-11-06 12:01:00.000000';
        if (change === 'audience')
            h.s.candidates.push({ id: 'another' });
        if (change === 'lesson')
            h.s.gates.released = 0;
        if (change === 'reference')
            h.s.ref = { id: id(60), announcement_id: id(31) };
        const result = await h.owner('POST', '/publication', { review_token: r.body.review_token });
        assert.equal(result.status, 409);
        assert.equal(h.s.writes.length, 0);
        assert.equal(h.s.audits.length, 0);
    });
test('text edits/withdrawals hide previously published content until a new explicit review/publication', async () => {
    const h = world();
    await h.publish();
    h.s.source.body = 'نص جديد';
    assert.equal((await h.student()).body.announcement, null);
    assert.equal((await h.owner()).body.publication.status, 'source_changed');
    await h.publish();
    assert.equal((await h.student()).body.announcement.body, 'نص جديد');
    h.s.source.state = 'retracted';
    assert.equal((await h.student()).body.announcement, null);
    const saved = h.s.publications[0].id;
    assert.equal((await h.owner('DELETE', '/publication/' + saved)).body.withdrawn, true);
    assert.equal(h.s.source.state, 'retracted');
});
for (const gate of ['released', 'prerequisite', 'enrolled', 'active', 'suspended', 'course', 'lesson'] as const)
    test(`student ${gate} proof prevents an announcement read`, async () => {
        const h = world();
        await h.publish();
        if (gate === 'suspended')
            h.s.suspended = true;
        else
            h.s[gate] = false;
        const result = await h.student();
        assert.ok([403, 404, 409].includes(result.status));
        assert.ok(!JSON.stringify(result.body).includes('النص المراجع'));
    });
test('a different actual enrollment group never receives the announcement', async () => {
    const h = world();
    await h.publish();
    h.s.group = { ...h.s.group, id: id(70) };
    assert.equal((await h.student()).body.announcement, null);
});
test('new publication pins prevent stale withdrawal; same current reviewed content is a no-op', async () => {
    const h = world();
    await h.publish();
    const old = h.s.publications[0].id;
    assert.equal((await h.publish()).body.unchanged, true);
    assert.equal(h.s.audits.length, 1);
    h.s.source.body = 'نسخة ثانية';
    await h.publish();
    assert.notEqual(h.s.publications[0].id, old);
    const n = h.s.audits.length;
    assert.equal((await h.owner('DELETE', '/publication/' + old)).status, 409);
    assert.equal(h.s.audits.length, n);
    assert.equal((await h.student()).body.announcement.body, 'نسخة ثانية');
});
for (const gate of ['publicationSchema', 'publicationIndex', 'publicationFk', 'owner'] as const)
    test(`missing ${gate} cannot grant publication`, async () => {
        const h = world();
        h.s[gate] = false;
        const result = await h.review();
        assert.equal(result.status, gate === 'owner' ? 403 : 503);
        assert.equal(h.s.publications.length, 0);
    });
test('draft source and unpublished/inactive lesson cannot publish; unreleased lessons keep their student lock', async () => {
    const h = world();
    h.s.source.state = 'draft';
    const r = await h.review();
    assert.equal(r.body.can_publish, false);
    assert.equal((await h.owner('POST', '/publication', { review_token: r.body.review_token })).status, 409);
    h.s.source.state = 'published';
    h.s.gates.publication_state = 'draft';
    assert.equal((await h.review()).body.can_publish, false);
    h.s.gates.publication_state = 'published';
    h.s.gates.released = 0;
    h.s.released = false;
    assert.equal((await h.publish()).status, 201);
    assert.equal((await h.student()).status, 409);
});
test('audit failure rolls back and a lost commit response is recovered by read without automatic mutation', async () => withSilencedErrors(async () => {
    const h = world();
    h.s.failAudit = true;
    assert.equal((await h.publish()).status, 500);
    assert.equal(h.s.publications.length, 0);
    const j = world();
    j.s.failCommit = true;
    const r = await j.publish();
    assert.equal(r.body.code, 'PERSISTENCE_UNCERTAIN');
    j.s.failCommit = false;
    assert.equal((await j.owner()).body.publication.status, 'published');
    assert.equal(j.s.audits.length, 1);
}));
test('client content or identity fields are not a publication token and cannot cause any write', async () => {
    const h = world();
    assert.equal((await h.owner('POST', '/publication', { review_token: 'a'.repeat(64), body: 'forged' })).status, 400);
    assert.equal((await h.owner('POST', '/publication', { review_token: 'a'.repeat(64) })).status, 409);
    assert.equal(h.s.writes.length, 0);
});
