import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { makeReq, runChain, squash, withSilencedErrors } from './helpers/m2-course-lessons-harness';
const id = (n: number) => `a2900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const course = id(1), unit = id(2), lesson = id(3), sourceId = id(5), group = id(6);
function fixture() {
    const s = { owner: true, course: true, unit: true, lesson: true, schema: true, indexes: true, fks: true, engine: 'InnoDB', failAudit: false, failCommit: false, acquired: 0,
        bindings: [] as any[], audits: [] as any[], calls: [] as string[], events: [] as string[], candidates: [{ id: 'enrollment-1' }] as any[],
        gates: { publication_state: 'published', lesson_status: 'active', unit_status: 'active', released: 1, prerequisite_lesson_id: null as string | null, previewed_at_epoch: 1793966400 },
        sources: [{ id: sourceId, group_id: group, title: 'إعلان الحصة', body: 'أحضر المذكرة', state: 'draft', tenant_id: 'tenant', group_name: 'المجموعة الأولى', course_id: course, branch_scope: 'tenant', branch_id: null, resolved_branch_id: null, branch_tenant_id: null, branch_status: null }] as any[] };
    const columns: Record<string, string[]> = { course_lesson_announcements: ['id', 'lesson_id', 'announcement_id'], group_announcements: ['id', 'tenant_id', 'group_id', 'title', 'body', 'state'], groups: ['id', 'name', 'course_id', 'branch_id', 'branch_scope'], branches: ['id', 'tenant_id', 'status'], students: ['id', 'user_id', 'tenant_id', 'group_id', 'is_active', 'approval_status', 'enrollment_status', 'enrollment_start_date', 'enrollment_end_date'], users: ['id', 'is_active', 'suspended_until'], student_courses: ['student_id', 'course_id', 'status'], branch_memberships: ['branch_id', 'user_id', 'status', 'role'] };
    let chain = Promise.resolve();
    const getConnection = async () => {
        s.acquired++;
        let before: any, unlock = () => { };
        return {
            beginTransaction: async () => { const old = chain; chain = new Promise(resolve => { unlock = resolve; }); await old; before = structuredClone({ bindings: s.bindings, audits: s.audits }); s.events.push('begin'); },
            execute: async (sql: string, p: any[] = []): Promise<[
                any,
                any
            ]> => {
                const q = squash(sql);
                s.calls.push(q);
                if (q.includes('FROM tenants t JOIN users'))
                    return [[{ owner_user_id: s.owner ? 'owner' : 'foreign', tenant_status: 'active', caller_active: 1 }], []];
                if (q.includes('FROM courses c'))
                    return [s.course && p[0] === course && p[1] === 'tenant' ? [{ id: course, tenant_id: 'tenant' }] : [], []];
                if (q.includes('FROM course_units u'))
                    return [s.unit && p[0] === unit && p[1] === course ? [{ id: unit }] : [], []];
                if (q.startsWith('SELECT l.id FROM course_lessons'))
                    return [s.lesson && p[0] === lesson && p[1] === unit ? [{ id: lesson }] : [], []];
                if (q.includes('information_schema.COLUMNS'))
                    return [s.schema ? Object.entries(columns).flatMap(([table_name, cols]) => cols.map(column_name => ({ table_name, column_name }))) : [], []];
                if (q.includes('information_schema.TABLES'))
                    return [[...Object.keys(columns), 'courses', 'course_units', 'course_lessons', 'tenants', 'audit_events'].map(table_name => ({ table_name, engine: s.engine })), []];
                if (q.includes('information_schema.STATISTICS'))
                    return [s.indexes ? [...['course_lesson_announcements', 'group_announcements', 'groups', 'students'].map(table_name => ({ table_name, index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 })), { table_name: 'course_lesson_announcements', index_name: 'uq_lesson_announcement', column_name: 'lesson_id', seq_in_index: 1, non_unique: 0 }] : [], []];
                if (q.includes('information_schema.KEY_COLUMN_USAGE'))
                    return [s.fks ? [['lesson_id', 'course_lessons'], ['announcement_id', 'group_announcements']].map(([column_name, referenced_table]) => ({ column_name, referenced_table, referenced_column: 'id', delete_rule: 'CASCADE' })) : [], []];
                if (q.includes('FROM group_announcements a')) {
                    assert.deepEqual(p.slice(0, 3), ['tenant', 'tenant', course]);
                    const exact = q.includes('a.id=?');
                    return [s.sources.filter(r => r.tenant_id === 'tenant' && r.course_id === course && ['draft', 'published'].includes(r.state) && (exact ? r.id === p[3] : r.id > p[3])).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 26), []];
                }
                if (q.startsWith('SELECT id,announcement_id'))
                    return [s.bindings.filter(r => p[0] === lesson), []];
                if (q.startsWith('SELECT c.publication_state'))
                    return [[s.gates], []];
                if (q.startsWith('SELECT s.id FROM students')) {
                    assert.deepEqual(p, ['tenant', group, course, s.sources[0].branch_scope, s.sources[0].branch_id]);
                    assert.match(q, /LIMIT 501$/);
                    assert.match(q, /student_courses/);
                    assert.match(q, /NOT \(suspended_until/);
                    return [s.candidates.slice(0, 501), []];
                }
                if (q.startsWith('INSERT INTO course_lesson_announcements')) {
                    s.bindings.push({ id: p[0], announcement_id: p[2] });
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('DELETE FROM course_lesson_announcements')) {
                    s.bindings = s.bindings.filter(r => r.id !== p[0]);
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('INSERT INTO audit_events')) {
                    if (s.failAudit)
                        throw Error('audit');
                    s.audits.push(p);
                    return [{ affectedRows: 1 }, []];
                }
                throw Error('Unexpected synthetic SQL ' + q);
            }, commit: async () => { s.events.push('commit'); before = null; if (s.failCommit)
                throw Error('lost commit'); }, rollback: async () => { s.events.push('rollback'); if (before)
                Object.assign(s, before); }, release: () => { s.events.push('release'); unlock(); }, destroy: () => { s.events.push('destroy'); unlock(); }
        };
    };
    const router = createCourseLessonsRouter({ query: async () => [], getConnection });
    const base = `/courses/${course}/units/${unit}/lessons/${lesson}/announcement`;
    const request = (method = 'GET', suffix = '', body: any = {}, query: any = {}, actor: any = { id: 'owner', tenantId: 'tenant', role: 'instructor' }) => { const req: any = makeReq({ method, pathName: base + suffix, body, query }); req.user = actor; return runChain([router], req); };
    const attach = () => request('POST', '', { source_id: sourceId });
    return { s, request, attach, preview: () => request('GET', '/' + s.bindings[0].id + '/preview') };
}
test('mounted owner selector/reference/preview shows group-only candidates without publishing, delivery or student identities', async () => {
    const h = fixture();
    assert.deepEqual((await h.request()).body, { announcement: null });
    const page = await h.request('GET', '/available-sources');
    assert.equal(page.status, 200);
    assert.ok(!('body' in page.body.sources[0]));
    const bound = await h.attach();
    assert.equal(bound.status, 201);
    assert.equal(bound.headers['Cache-Control'], 'no-store');
    assert.equal(h.s.audits.length, 1);
    assert.equal((await h.attach()).body.unchanged, true);
    assert.equal(h.s.audits.length, 1);
    const preview = await h.preview();
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.body, 'أحضر المذكرة');
    assert.equal(preview.body.preview.candidate_enrollments, 1);
    assert.equal(preview.body.preview.delivery_status, 'unconfigured');
    assert.equal(preview.body.preview.student_visibility, 'unconfigured');
    assert.ok(!JSON.stringify(preview.body).includes('enrollment-1'));
    assert.equal(h.s.sources[0].state, 'draft');
    assert.ok(!h.s.calls.some(q => /^(INSERT|UPDATE|DELETE).*\b(group_announcements|notification|student_courses|fees)\b/.test(q)));
});
for (const gate of ['owner', 'course', 'unit', 'lesson'] as const)
    test(`announcement parent ${gate} remains server authority`, async () => { const h = fixture(); h.s[gate] = false; assert.equal((await h.attach()).status, gate === 'owner' ? 403 : 404); assert.equal(h.s.bindings.length, 0); assert.equal(h.s.audits.length, 0); });
for (const gate of ['schema', 'indexes', 'fks', 'engine'] as const)
    test(`actual ${gate} is required before reference work`, async () => { const h = fixture(); if (gate === 'engine')
        h.s.engine = 'MyISAM';
    else
        h.s[gate] = false; assert.equal((await h.attach()).status, 503); assert.equal(h.s.audits.length, 0); });
test('foreign course/source and retracted sources remain indistinguishable; missing source can still be detached', async () => {
    const h = fixture();
    h.s.sources[0].course_id = id(99);
    assert.equal((await h.attach()).status, 404);
    h.s.sources[0].course_id = course;
    await h.attach();
    const content = h.s.bindings[0].id;
    h.s.sources[0].state = 'retracted';
    assert.equal((await h.request()).body.announcement.source_state, 'unavailable');
    assert.equal((await h.preview()).status, 404);
    assert.equal((await h.request('DELETE', '/' + content)).body.detached, true);
    assert.equal(h.s.sources[0].state, 'retracted');
});
test('pinned detach and preview reject a stale reference without write; absent detach is a truthful no-op', async () => {
    const h = fixture();
    await h.attach();
    const n = h.s.audits.length;
    assert.equal((await h.request('DELETE', '/' + id(80))).status, 409);
    assert.equal((await h.request('GET', '/' + id(80) + '/preview')).status, 409);
    assert.equal(h.s.audits.length, n);
    const idValue = h.s.bindings[0].id;
    await h.request('DELETE', '/' + idValue);
    assert.equal((await h.request('DELETE', '/' + idValue)).body.detached, false);
});
test('preview is bounded, excludes fabricated eligibility and reports release/prerequisite gates explicitly', async () => {
    const h = fixture();
    await h.attach();
    h.s.gates.released = 0;
    h.s.gates.prerequisite_lesson_id = id(90);
    const preview = await h.preview();
    assert.equal(preview.body.preview.lesson_released, false);
    assert.equal(preview.body.preview.prerequisite_required, true);
    assert.equal(h.s.audits.length, 1);
    h.s.candidates = Array.from({ length: 501 }, (_, n) => ({ id: 'enrollment-' + n }));
    const over = await h.preview();
    assert.equal(over.status, 503);
    assert.equal(over.body.code, 'LESSON_ANNOUNCEMENT_PREVIEW_TOO_LARGE');
    assert.ok(!JSON.stringify(over.body).includes('candidate_enrollments'));
});
test('branch-invalid sources are withheld and an empty header page still has a raw keyset cursor', async () => {
    const h = fixture();
    h.s.sources = Array.from({ length: 26 }, (_, n) => ({ ...h.s.sources[0], id: id(100 + n), branch_scope: 'branch', branch_id: id(70), resolved_branch_id: id(70), branch_tenant_id: 'foreign', branch_status: 'active' }));
    const result = await h.request('GET', '/available-sources');
    assert.equal(result.status, 200);
    assert.equal(result.body.sources.length, 0);
    assert.equal(result.body.next_cursor, id(124));
});
test('audit failure rolls back; unknown commit is not success and recovery reads the committed reference', async () => withSilencedErrors(async () => {
    const h = fixture();
    h.s.failAudit = true;
    assert.equal((await h.attach()).status, 500);
    assert.equal(h.s.bindings.length, 0);
    assert.equal(h.s.audits.length, 0);
    const j = fixture();
    j.s.failCommit = true;
    const result = await j.attach();
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'PERSISTENCE_UNCERTAIN');
    j.s.failCommit = false;
    assert.equal((await j.request()).body.announcement.source_id, sourceId);
    assert.equal(j.s.audits.length, 1);
}));
test('invalid selectors/bodies and billing-only requests fail before acquiring a connection', async () => {
    const h = fixture();
    assert.equal((await h.request('POST', '', { source_id: sourceId, tenant_id: 'forged' })).status, 400);
    assert.equal((await h.request('GET', '', {}, { tenant_id: 'forged' })).status, 400);
    assert.equal((await h.request('GET', '', {}, {}, { id: 'owner', tenantId: 'tenant', billingOnly: true })).status, 403);
    assert.equal(h.s.acquired, 0);
});
