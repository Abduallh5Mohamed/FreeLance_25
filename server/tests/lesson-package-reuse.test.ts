import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { parsePackageReuseBody } from '../src/services/lesson-package-reuse';
import { makeReq, runChain, squash, withSilencedErrors } from './helpers/m2-course-lessons-harness';
const id = (n: number) => `b3200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const course = id(1), unit = id(2), destination = id(3), sourceLesson = id(4);
const columns: Record<string, string[]> = {
    course_lesson_package_operations: ['tenant_id', 'operation_id', 'actor_user_id', 'course_id', 'lesson_id', 'request_hash', 'created_count', 'existing_count'],
    course_lesson_contents: ['id', 'lesson_id', 'material_id', 'display_order'], course_lesson_videos: ['id', 'lesson_id', 'video_id', 'display_order'],
    course_lesson_activities: ['id', 'lesson_id', 'kind', 'assignment_id', 'exam_id'], assignments: ['id', 'tenant_id', 'course_id', 'title', 'status', 'archived_at', 'group_id', 'branch_id', 'branch_scope'],
    exams: ['id', 'course_id', 'title', 'is_active', 'is_published'], exam_groups: ['exam_id', 'group_id'],
    course_lesson_announcements: ['id', 'lesson_id', 'announcement_id'], group_announcements: ['id', 'tenant_id', 'group_id', 'title', 'body', 'state'],
    groups: ['id', 'name', 'course_id', 'branch_id', 'branch_scope'], branches: ['id', 'tenant_id', 'status'],
    students: ['id', 'user_id', 'tenant_id', 'group_id', 'is_active', 'approval_status', 'enrollment_status', 'enrollment_start_date', 'enrollment_end_date'],
    users: ['id', 'is_active', 'suspended_until'], student_courses: ['student_id', 'course_id', 'status'], branch_memberships: ['branch_id', 'user_id', 'status', 'role'],
    courses: ['id'], course_units: ['id'], course_lessons: ['id'], tenants: ['id'], audit_events: ['id'], videos: ['id'], lectures: ['id'], course_materials: ['id'],
};
const indexes = [
    ...Object.keys(columns).filter(table => !['exam_groups', 'student_courses', 'branch_memberships', 'course_lesson_package_operations'].includes(table)).map(table => [table, 'PRIMARY', ['id']] as const),
    ['course_lesson_package_operations', 'PRIMARY', ['tenant_id', 'operation_id']],
    ['course_lesson_contents', 'uq_lesson_contents_source', ['lesson_id', 'material_id']], ['course_lesson_contents', 'uq_lesson_contents_order', ['lesson_id', 'display_order']],
    ['course_lesson_videos', 'uq_lesson_videos_source', ['lesson_id', 'video_id']], ['course_lesson_videos', 'uq_lesson_videos_order', ['lesson_id', 'display_order']],
    ['course_lesson_activities', 'uq_lesson_activity_kind', ['lesson_id', 'kind']], ['course_lesson_announcements', 'uq_lesson_announcement', ['lesson_id']],
] as const;
const selections = [{ kind: 'material', source_id: id(10) }, { kind: 'video', source_id: id(20) }, { kind: 'homework', source_id: id(30) }, { kind: 'quiz', source_id: id(40) }, { kind: 'announcement', source_id: id(50) }];
function fixture() {
    const s = { owner: true, course: true, unit: true, destination: true, source: true, active: true, schema: true, indexes: true, engine: 'InnoDB', fail: '', failCommit: false, acquired: 0,
        bindings: [
            { kind: 'material', id: id(110), lesson_id: sourceLesson, source_id: id(10), display_order: 0 },
            { kind: 'video', id: id(120), lesson_id: sourceLesson, source_id: id(20), display_order: 1 },
            { kind: 'homework', id: id(130), lesson_id: sourceLesson, source_id: id(30), display_order: null },
            { kind: 'quiz', id: id(140), lesson_id: sourceLesson, source_id: id(40), display_order: null },
            { kind: 'announcement', id: id(150), lesson_id: sourceLesson, source_id: id(50), display_order: null },
        ] as any[], receipts: [] as any[], audits: [] as any[], calls: [] as string[], events: [] as string[], title: 'material', videoReady: true, foreignSource: false, quizGroups: [] as any[], badReceiptType: false,
    };
    const matches = (q: string, field: string, value: string) => {
        const found = q.match(new RegExp(field + "(?: IN \\(([^)]+)\\)|='([^']+)')", 'i'));
        return !found || (found[1] ? [...found[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [found[2]]).includes(value);
    };
    let chain = Promise.resolve();
    const getConnection = async () => {
        s.acquired++;
        let before: any, unlock = () => { };
        return {
            beginTransaction: async () => { const old = chain; chain = new Promise(resolve => { unlock = resolve; }); await old; before = structuredClone({ bindings: s.bindings, receipts: s.receipts, audits: s.audits }); },
            execute: async (sql: string, p: any[] = []): Promise<[
                any,
                any
            ]> => {
                const q = squash(sql);
                s.calls.push(q);
                if (q.includes('FROM tenants t JOIN users'))
                    return [[{ owner_user_id: s.owner ? 'owner' : 'foreign', tenant_status: 'active', caller_active: 1 }], []];
                if (q.startsWith('SELECT c.id,c.tenant_id FROM courses'))
                    return [s.course && p[0] === course && p[1] === 'tenant' ? [{ id: course, tenant_id: 'tenant' }] : [], []];
                if (q.startsWith('SELECT u.id,u.course_id'))
                    return [s.unit && p[0] === unit && p[1] === course ? [{ id: unit, course_id: course, display_order: 0 }] : [], []];
                if (q.startsWith('SELECT l.id FROM course_lessons'))
                    return [s.destination && p[0] === destination && p[1] === unit ? [{ id: destination }] : [], []];
                if (q.includes('information_schema.COLUMNS'))
                    return [s.schema ? Object.entries(columns).filter(([table]) => matches(q, 'TABLE_NAME', table)).flatMap(([table_name, cols]) => cols.map(column_name => ({ table_name, column_name, is_nullable: 'NO', data_type: column_name.endsWith('_count') ? 'int' : ['tenant_id', 'actor_user_id'].includes(column_name) ? 'varchar' : 'char', max_length: s.badReceiptType ? 8 : ['tenant_id', 'actor_user_id', 'request_hash'].includes(column_name) ? 64 : 36, collation_name: 'utf8mb4_bin' }))) : [], []];
                if (q.includes('information_schema.TABLES'))
                    return [Object.keys(columns).filter(table => matches(q, 'TABLE_NAME', table)).map(table_name => ({ table_name, engine: s.engine })), []];
                if (q.includes('information_schema.STATISTICS'))
                    return [s.indexes ? indexes.filter(([table, name]) => matches(q, 'TABLE_NAME', table) && matches(q, 'INDEX_NAME', name)).flatMap(([table_name, index_name, cols]) => cols.map((column_name, i) => ({ table_name, index_name, column_name, seq_in_index: i + 1, non_unique: 0 }))) : [], []];
                if (q.includes('information_schema.KEY_COLUMN_USAGE'))
                    return [[['lesson_id', 'course_lessons'], ['announcement_id', 'group_announcements']].map(([column_name, referenced_table]) => ({ column_name, referenced_table, referenced_column: 'id', delete_rule: 'CASCADE' })), []];
                if (q.startsWith('SELECT l.id,l.unit_id')) {
                    assert.deepEqual(p, [sourceLesson, destination, course]);
                    assert.match(q, /FOR UPDATE$/);
                    return [[...(s.source ? [{ id: sourceLesson, unit_id: id(99), status: s.active ? 'active' : 'archived', unit_status: 'active' }] : []), { id: destination, unit_id: unit, status: 'active', unit_status: 'active' }], []];
                }
                if (q.startsWith('SELECT actor_user_id,course_id'))
                    return [s.receipts.filter(row => row.tenant_id === p[0] && row.operation_id === p[1]), []];
                if (q.startsWith('SELECT id,kind,assignment_id'))
                    return [s.bindings.filter(row => row.lesson_id === p[0] && ['homework', 'quiz'].includes(row.kind)).map(row => ({ id: row.id, kind: row.kind, assignment_id: row.kind === 'homework' ? row.source_id : null, exam_id: row.kind === 'quiz' ? row.source_id : null })), []];
                for (const [table, kind] of [['course_lesson_contents', 'material'], ['course_lesson_videos', 'video'], ['course_lesson_announcements', 'announcement']])
                    if (q.startsWith('SELECT id,') && q.includes(`FROM ${table} WHERE`))
                        return [s.bindings.filter(row => row.lesson_id === p[0] && row.kind === kind).map(row => ({ id: row.id, source_id: row.source_id, display_order: row.display_order })), []];
                if (q.startsWith('SELECT id,title,material_type')) {
                    assert.deepEqual(p, [id(10), course]);
                    return [s.foreignSource ? [] : [{ id: id(10), title: s.title, material_type: 'pdf', is_published: 1 }], []];
                }
                if (q.startsWith('SELECT v.id,v.title')) {
                    assert.deepEqual(p, [id(20), course, 'tenant']);
                    return [s.videoReady ? [{ id: id(20), title: 'video' }] : [], []];
                }
                if (q.startsWith('SELECT id FROM lectures') || q.startsWith('SELECT id FROM course_materials'))
                    return [[], []];
                if (q.startsWith('SELECT s.id,s.title,') && q.includes('FROM assignments'))
                    return [[{ id: id(30), title: 'homework', status: 'published', group_id: null, branch_id: null, branch_scope: 'tenant' }], []];
                if (q.startsWith('SELECT s.id,s.title,') && q.includes('FROM exams'))
                    return [[{ id: id(40), title: 'quiz', is_published: 1 }], []];
                if (q.includes('FROM exam_groups eg'))
                    return [s.quizGroups, []];
                if (q.includes('FROM group_announcements a'))
                    return [[{ id: id(50), title: 'notice', body: 'reviewed body', state: 'draft', tenant_id: 'tenant', group_id: id(70), group_name: 'group', course_id: course, branch_scope: 'tenant', branch_id: null }], []];
                if (q.startsWith('INSERT INTO audit_events')) {
                    if (s.fail === 'audit')
                        throw Error('audit');
                    s.audits.push(p);
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('INSERT INTO course_lesson_package_operations')) {
                    if (s.fail === 'receipt')
                        throw Error('receipt');
                    s.receipts.push(Object.fromEntries(['tenant_id', 'operation_id', 'actor_user_id', 'course_id', 'lesson_id', 'request_hash', 'created_count', 'existing_count'].map((key, i) => [key, p[i]])));
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('INSERT INTO course_lesson_')) {
                    if (s.fail === 'write')
                        throw Error('write');
                    const kind = q.includes('contents') ? 'material' : q.includes('videos') ? 'video' : q.includes('announcements') ? 'announcement' : p[2];
                    s.bindings.push({ id: p[0], lesson_id: p[1], kind, source_id: kind === 'homework' ? p[3] : kind === 'quiz' ? p[4] : p[2], display_order: ['material', 'video'].includes(kind) ? p[3] : null });
                    return [{ affectedRows: 1 }, []];
                }
                throw Error('Unexpected synthetic SQL ' + q);
            },
            commit: async () => { before = null; s.events.push('commit'); if (s.failCommit)
                throw Error('lost commit'); },
            rollback: async () => { s.events.push('rollback'); if (before)
                Object.assign(s, before); }, release: () => { s.events.push('release'); unlock(); }, destroy: () => { s.events.push('destroy'); unlock(); },
        };
    };
    const router = createCourseLessonsRouter({ query: async () => [], getConnection });
    const request = (suffix = '/review', body: any = { source_lesson_id: sourceLesson, selections }, actor: any = { id: 'owner', tenantId: 'tenant', role: 'instructor' }, headers: any = {}) => {
        const req: any = makeReq({ method: suffix.startsWith('/operations/') ? 'GET' : 'POST', pathName: `/courses/${course}/units/${unit}/lessons/${destination}/package-reuse${suffix}`, body, headers });
        req.user = actor;
        return runChain([router], req);
    };
    const review = (chosen = selections) => request('/review', { source_lesson_id: sourceLesson, selections: chosen });
    const apply = async (chosen = selections, operationId = id(90)) => { const r = await review(chosen); assert.equal(r.status, 200); const body = { source_lesson_id: sourceLesson, selections: chosen, review_token: r.body.review_token, operation_id: operationId }; return { body, response: await request('', body) }; };
    return { s, request, review, apply };
}
test('actual review/apply reuses all five reference kinds across same-course units with one atomic receipt/audit', async () => {
    const h = fixture(), review = await h.review();
    assert.equal(review.status, 200);
    assert.equal(review.headers['Cache-Control'], 'no-store');
    assert.equal(review.body.can_apply, true);
    assert.equal(h.s.audits.length, 0);
    const { response, body } = await h.apply();
    assert.equal(response.status, 201);
    assert.equal(response.body.created, 5);
    assert.equal(h.s.bindings.filter(row => row.lesson_id === destination).length, 5);
    assert.equal(h.s.audits.length, 1);
    assert.equal(h.s.receipts.length, 1);
    assert.ok(!h.s.calls.some(sql => /^(INSERT|UPDATE|DELETE).*(quiz_versions|publications|attempts|submissions|progress|enrollments|fees)/.test(sql)));
    assert.equal((await h.request('', body)).body.replayed, true);
    assert.equal(h.s.audits.length, 1);
    const status = await h.request('/operations/' + id(90), {});
    assert.equal(status.body.operation.created, 5);
});
for (const gate of ['owner', 'course', 'unit', 'destination', 'source'] as const)
    test(`owner/parent/source ${gate} gate refuses without writes`, async () => {
        const h = fixture();
        h.s[gate] = false;
        const r = await h.review();
        assert.equal(r.status, gate === 'owner' ? 403 : 404);
        assert.equal(h.s.audits.length, 0);
        assert.equal(h.s.bindings.length, 5);
    });
for (const gate of ['schema', 'indexes', 'engine'] as const)
    test(`absent/invalid ${gate} fails closed`, async () => {
        const h = fixture();
        if (gate === 'engine')
            h.s.engine = 'MyISAM';
        else
            h.s[gate] = false;
        assert.equal((await h.review()).status, 503);
        assert.equal(h.s.audits.length, 0);
    });
test('strict request/identity validation runs before connection acquisition', async () => {
    const h = fixture();
    for (const body of [{}, { source_lesson_id: sourceLesson, selections: [] }, { source_lesson_id: sourceLesson, selections: [selections[0], selections[0]] }, { source_lesson_id: sourceLesson, selections, tenant_id: 'foreign' }])
        assert.equal((await h.request('/review', body)).status, 400);
    assert.equal((await h.request('/review', { source_lesson_id: sourceLesson, selections }, undefined, { 'x-tenant-id': 'foreign' })).status, 400);
    assert.equal(h.s.acquired, 0);
    assert.equal(parsePackageReuseBody({ source_lesson_id: sourceLesson, selections: [{ kind: 'quiz', source_id: id(40) }, { kind: 'quiz', source_id: id(41) }] }, false), null);
});
test('same source lesson and archived source are rejected', async () => { const h = fixture(); assert.equal((await h.request('/review', { source_lesson_id: destination, selections })).status, 400); h.s.active = false; assert.equal((await h.review()).status, 409); });
test('unavailable video/foreign material are conflicts, never a partial copy', async () => { const h = fixture(); h.s.videoReady = false; h.s.foreignSource = true; const r = await h.review(); assert.equal(r.body.can_apply, false); assert.equal(r.body.items.filter((row: any) => row.conflict === 'source_unavailable').length, 2); const a = await h.apply(); assert.equal(a.response.status, 409); assert.equal(h.s.bindings.length, 5); });
for (const scenario of ['position', 'slot', 'moved', 'capacity'])
    test(`final ${scenario} conflict writes nothing`, async () => {
        const h = fixture();
        if (scenario === 'position')
            h.s.bindings.push({ kind: 'video', id: id(201), lesson_id: destination, source_id: id(200), display_order: 0 });
        if (scenario === 'slot')
            h.s.bindings.push({ kind: 'quiz', id: id(201), lesson_id: destination, source_id: id(200), display_order: null });
        if (scenario === 'moved')
            h.s.bindings.push({ kind: 'material', id: id(201), lesson_id: destination, source_id: id(10), display_order: 3 });
        if (scenario === 'capacity')
            h.s.bindings.push(...Array.from({ length: 20 }, (_, n) => ({ kind: 'video', id: id(201 + n), lesson_id: destination, source_id: id(301 + n), display_order: n + 2 })));
        const before = structuredClone(h.s.bindings), a = await h.apply();
        assert.equal(a.response.status, 409);
        assert.deepEqual(h.s.bindings, before);
        assert.equal(h.s.receipts.length, 0);
    });
test('changed reviewed source facts and destination references invalidate review before mutation', async () => {
    const h = fixture(), r = await h.review();
    h.s.title = 'edited';
    const body = { source_lesson_id: sourceLesson, selections, review_token: r.body.review_token, operation_id: id(90) };
    assert.equal((await h.request('', body)).body.code, 'PACKAGE_REVIEW_CHANGED');
    assert.equal(h.s.audits.length, 0);
    const r2 = await h.review();
    h.s.bindings.push({ kind: 'material', id: id(301), lesson_id: destination, source_id: id(300), display_order: 8 });
    assert.equal((await h.request('', { ...body, review_token: r2.body.review_token })).body.code, 'PACKAGE_REVIEW_CHANGED');
    assert.equal(h.s.audits.length, 0);
});
test('selected subset only is copied; already present references consume no new slot', async () => {
    const h = fixture(), chosen = [selections[0]];
    assert.equal((await h.apply(chosen)).response.body.created, 1);
    const next = await h.apply(chosen, id(91));
    assert.equal(next.response.body.created, 0);
    assert.equal(next.response.body.existing, 1);
    assert.equal(h.s.bindings.length, 6);
});
for (const failure of ['write', 'audit', 'receipt'])
    test(`${failure} failure rolls back every reference, receipt and audit`, async () => {
        const h = fixture();
        h.s.fail = failure;
        await withSilencedErrors(async () => assert.equal((await h.apply()).response.status, 500));
        assert.equal(h.s.bindings.length, 5);
        assert.equal(h.s.audits.length, 0);
        assert.equal(h.s.receipts.length, 0);
    });
test('unknown commit is explicit, connection discarded, GET receipt recovers without another write', async () => {
    const h = fixture();
    h.s.failCommit = true;
    const a = await withSilencedErrors(() => h.apply());
    assert.equal(a.response.status, 500);
    assert.equal(a.response.body.code, 'PERSISTENCE_UNCERTAIN');
    assert.ok(h.s.events.includes('destroy'));
    const before = h.s.calls.filter(q => q.startsWith('INSERT')).length;
    assert.equal((await h.request('/operations/' + id(90), {})).body.operation.created, 5);
    assert.equal(h.s.calls.filter(q => q.startsWith('INSERT')).length, before);
    h.s.source = false;
    assert.equal((await h.request('', a.body)).body.replayed, true);
});
test('operation identity is payload/actor/course/lesson bound, even on recovery', async () => {
    const h = fixture(), a = await h.apply();
    assert.equal((await h.request('', { ...a.body, selections: [selections[0]] })).status, 409);
    h.s.receipts[0].actor_user_id = 'other';
    assert.equal((await h.request('/operations/' + id(90), {})).status, 409);
});
test('billing-only/missing identity are denied before acquisition; incompatible receipt types fail closed', async () => {
    const h = fixture(), body = { source_lesson_id: sourceLesson, selections };
    assert.equal((await h.request('/review', body, { id: 'owner', tenantId: 'tenant', billingOnly: true })).status, 403);
    assert.equal((await h.request('/review', body, { id: 'owner' })).status, 404);
    assert.equal(h.s.acquired, 0);
    h.s.badReceiptType = true;
    assert.equal((await h.review()).status, 503);
});
test('restricted audience change invalidates review and corrupt group cannot be copied', async () => {
    const h = fixture();
    h.s.quizGroups = [{ exam_id: id(40), id: id(70), course_id: course, branch_scope: 'tenant', branch_id: null }];
    const r = await h.review();
    assert.equal(r.body.items.find((row: any) => row.kind === 'quiz').audience, 'restricted');
    h.s.quizGroups[0].id = id(71);
    assert.equal((await h.request('', { source_lesson_id: sourceLesson, selections, review_token: r.body.review_token, operation_id: id(90) })).body.code, 'PACKAGE_REVIEW_CHANGED');
    h.s.quizGroups[0].course_id = id(999);
    const r2 = await h.review();
    assert.equal(r2.body.can_apply, false);
    assert.equal(h.s.audits.length, 0);
});
test('concurrent identical operation is one commit; competing stale operation has no partial effect', async () => {
    const h = fixture(), r = await h.review(), body = { source_lesson_id: sourceLesson, selections, review_token: r.body.review_token, operation_id: id(90) };
    const responses = await Promise.all([h.request('', body), h.request('', body), h.request('', { ...body, operation_id: id(91) })]);
    assert.deepEqual(responses.map(r => r.status), [201, 200, 409]);
    assert.equal(h.s.audits.length, 1);
    assert.equal(h.s.receipts.length, 1);
    assert.equal(h.s.bindings.length, 10);
});
