import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { makeReq, runChain, squash, withSilencedErrors, createIsolation, loadAppModules,
  buildHarness, makeState, sign, INSTRUCTOR_A, COURSE_A1, UNIT_A1, LESSON_1, TEST_SECRET } from './helpers/m2-course-lessons-harness';
import path from 'node:path';

const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const course = id(1), unit = id(2), lesson = id(3), material = id(4);
type Binding = { id: string; lesson_id: string; material_id: string; display_order: number };
function fixture() {
  const f = { bindings: [] as Binding[], audit: [] as any[], calls: [] as string[], events: [] as string[],
    owner: true, activeCourse: true, unit: true, lesson: true, schema: true,videoSchema:false,videos:[] as Array<{id:string;video_id:string;display_order:number}>,
    sources: [{ id: material, course_id: course, title: 'ملف الشرح', material_type: 'pdf', file_url: 'private-secret', is_published: 0 }],
    failAudit: false, failCommit: false, failRollback: false, acquired: 0 };
  let snapshot: Binding[] = [], auditSnapshot = 0;
  const connection = {
    beginTransaction: async () => { f.events.push('begin'); snapshot = structuredClone(f.bindings); auditSnapshot = f.audit.length; },
    execute: async (sql: string, p: any[] = []): Promise<[any, any]> => {
      const s = squash(sql); f.calls.push(s);
      if(s.includes("TABLE_NAME='videos'")&&s.includes('information_schema.STATISTICS'))return [[{column_name:'id',seq_in_index:1}],[]];
      if(s.includes("TABLE_NAME='course_lesson_videos'")){
        if(!f.videoSchema)return [[],[]];
        if(s.includes('information_schema.COLUMNS'))return [['id','lesson_id','video_id','display_order'].map(column_name=>({column_name})),[]];
        return [[...(['PRIMARY','uq_lesson_videos_source','uq_lesson_videos_order'] as const).flatMap(index_name=>(index_name==='PRIMARY'?['id']:index_name==='uq_lesson_videos_source'?['lesson_id','video_id']:['lesson_id','display_order']).map((column_name,n)=>({index_name,column_name,seq_in_index:n+1,non_unique:0})))],[]];
      }
      if(s.includes('information_schema.TABLES'))return [['course_lesson_videos','videos','course_lesson_contents','course_lessons','course_units','courses','tenants','users','audit_events','lectures','course_materials'].map(table_name=>({table_name,engine:'InnoDB'})),[]];
      if(s.startsWith('SELECT id,video_id,display_order'))return [f.videos,[]];
      if (s.includes('FROM tenants t JOIN users')) return [[{ owner_user_id: f.owner ? 'owner' : 'other', tenant_status: 'active', caller_active: 1 }], []];
      if (s.includes('FROM courses c')) return [f.activeCourse && p[0] === course ? [{ id: course }] : [], []];
      if (s.includes('FROM course_units u')) return [f.unit && p[0] === unit && p[1] === course ? [{ id: unit }] : [], []];
      if (s.startsWith('SELECT l.id FROM course_lessons')) return [f.lesson && p[0] === lesson && p[1] === unit ? [{ id: lesson }] : [], []];
      if (s.includes('information_schema.COLUMNS')) return [f.schema ? ['id', 'lesson_id', 'material_id', 'display_order'].map(column_name => ({ column_name })) : [], []];
      if (s.includes('FROM course_lesson_contents b')) {
        assert.ok(s.endsWith('LIMIT 21'));
        return [f.bindings.filter(b => b.lesson_id === p[1]).sort((a, b) => a.display_order - b.display_order).slice(0, 21).map(b => {
          const m = f.sources.find(m => m.id === b.material_id && m.course_id === p[0]);
          return { ...b, source_id: m?.id, title: m?.title, material_type: m?.material_type };
        }), []];
      }
      if (s.startsWith('SELECT m.id,m.title,m.material_type,m.is_published')) {
        assert.ok(s.endsWith('LIMIT 26'));
        return [f.sources.filter(m => m.course_id === p[0] && m.id > p[1]).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 26), []];
      }
      if (s.startsWith('SELECT m.id,m.title')) return [f.sources.filter(m => m.id.toLowerCase() === p[0].toLowerCase() && m.course_id === p[1]), []];
      if (s.startsWith('INSERT INTO course_lesson_contents')) { f.bindings.push({ id: p[0], lesson_id: p[1], material_id: p[2], display_order: p[3] }); return [{ affectedRows: 1 }, []]; }
      if (s.startsWith('DELETE FROM course_lesson_contents')) { const before = f.bindings.length; f.bindings = f.bindings.filter(b => !(b.id === p[0] && b.lesson_id === p[1])); return [{ affectedRows: before - f.bindings.length }, []]; }
      if (s.startsWith('INSERT INTO audit_events')) { if (f.failAudit) throw Error('audit failed'); f.audit.push(p); return [{ affectedRows: 1 }, []]; }
      throw Error(`Unexpected SQL: ${s}`);
    },
    commit: async () => { f.events.push('commit'); if (f.failCommit) throw Error('ack lost'); },
    rollback: async () => { f.events.push('rollback'); if (f.failRollback) throw Error('rollback lost'); f.bindings = snapshot; f.audit.length = auditSnapshot; },
    release: () => { f.events.push('release'); }, destroy: () => { f.events.push('destroy'); },
  };
  const router = createCourseLessonsRouter({ getConnection: async () => { f.acquired++; return connection; } });
  const path = `/courses/${course}/units/${unit}/lessons/${lesson}/contents`;
  const request = async (method = 'GET', body: any = {}, suffix = '', user: any = { id: 'owner', tenantId: 'tenant' }, query = {}) => {
    const req: any = makeReq({ method, pathName: path + suffix, body, query }); req.user = user;
    return runChain([router], req);
  };
  return { f, request };
}

test('owner attaches multiple materials; sorted explicit DTO, no URL or progress effects; detach preserves sources', async () => {
  const { f, request } = fixture();
  f.sources.push({ ...f.sources[0], id: id(5), material_type: 'video' });
  const first = await request('POST', { material_id: material, display_order: 2 });
  assert.equal(first.status, 201);
  assert.equal((await request('POST', { material_id: id(5), display_order: 1 })).status, 201);
  const list = await request(); assert.equal(list.status, 200);
  assert.deepEqual(list.body.contents.map((x: any) => x.display_order), [1, 2]);
  assert.deepEqual(Object.keys(list.body.contents[0]).sort(), ['content_id', 'material_id', 'title', 'material_type', 'display_order'].sort());
  assert.ok(!JSON.stringify(list.body).includes('private-secret'));
  assert.equal(list.headers['Cache-Control'], 'no-store');
  assert.equal((await request('DELETE', {}, '/' + first.body.content.content_id)).status, 200);
  assert.equal(f.bindings.length, 1); assert.equal(f.sources.length, 2); assert.equal(f.audit.length, 3);
  assert.deepEqual(f.audit.map(a => a[3]), ['course_lesson_content.attach', 'course_lesson_content.attach', 'course_lesson_content.detach']);
  assert.ok(f.calls.every(s => !s.includes('lesson_completions') && !s.includes('UPDATE course_materials')));
  assert.ok(f.calls.some(s => s === 'SELECT l.id FROM course_lessons l WHERE l.id=? AND l.unit_id=? FOR UPDATE'));
});

test('exact repeat including uppercase source is no-op; occupied position and changed order conflict', async () => {
  const { f, request } = fixture();
  await request('POST', { material_id: material, display_order: 0 });
  const repeat = await request('POST', { material_id: material.toUpperCase(), display_order: 0 });
  assert.equal(repeat.status, 200); assert.equal(repeat.body.unchanged, true);
  assert.equal((await request('POST', { material_id: material, display_order: 1 })).status, 409);
  f.sources.push({ ...f.sources[0], id: id(5) });
  assert.equal((await request('POST', { material_id: id(5), display_order: 0 })).status, 409);
  assert.equal(f.audit.length, 1); assert.equal(f.events.filter(e => e === 'commit').length, 1);
});

for (const body of [null, [], {}, { material_id: material }, { material_id: material, display_order: '1' },
  { material_id: material, display_order: -1 }, { material_id: material, display_order: 1.2 },
  { material_id: material, display_order: 2147483648 }, { material_id: 'bad', display_order: 0 },
  { material_id: material, display_order: 0, tenant_id: 'foreign' }, { video_asset_id: material, display_order: 0 }]) {
  test(`strict attach rejects ${JSON.stringify(body)} before connection`, async () => {
    const { f, request } = fixture(); assert.equal((await request('POST', body)).status, 400); assert.equal(f.acquired, 0);
  });
}
for (const gate of ['owner', 'activeCourse', 'unit', 'lesson', 'schema'] as const) {
  test(`denied ${gate} produces no content writes or audit`, async () => {
    const { f, request } = fixture(); f[gate] = false;
    const r = await request('POST', { material_id: material, display_order: 0 });
    assert.equal(r.status, gate === 'owner' ? 403 : gate === 'schema' ? 503 : 404);
    assert.equal(r.headers['Cache-Control'], 'no-store'); assert.equal(f.bindings.length, 0); assert.equal(f.audit.length, 0);
    assert.ok(!f.events.includes('commit')); assert.equal(f.events.at(-1), 'release');
  });
}
test('billing-only and missing scope do not acquire a connection', async () => {
  const { f, request } = fixture();
  assert.equal((await request('GET', {}, '', { id: 'owner', tenantId: 'tenant', billingOnly: true })).status, 403);
  assert.equal((await request('GET', {}, '', {})).status, 404); assert.equal(f.acquired, 0);
});
test('material attach shares video positions and the combined twenty-reference ceiling without changing the material DTO',async()=>{
  const {f,request}=fixture();f.videoSchema=true;
  f.videos=[{id:id(80),video_id:id(81),display_order:3}];
  assert.equal((await request('POST',{material_id:material,display_order:3})).status,409);assert.equal(f.audit.length,0);
  assert.equal((await request('POST',{material_id:material,display_order:4})).status,201);
  f.videos=Array.from({length:20},(_,n)=>({id:id(100+n),video_id:id(200+n),display_order:n+10}));
  assert.equal((await request('POST',{material_id:material,display_order:4})).status,409);
  f.bindings=[];assert.equal((await request('POST',{material_id:material,display_order:0})).status,409);
});
test('foreign course material and unknown material both return 404 without writes', async () => {
  for (const foreign of [true, false]) {
    const { f, request } = fixture(); f.sources = foreign ? [{ ...f.sources[0], course_id: id(99) }] : [];
    assert.equal((await request('POST', { material_id: material, display_order: 0 })).status, 404);
    assert.equal(f.audit.length, 0); assert.equal(f.bindings.length, 0);
  }
});
test('twentieth slot accepted, twenty-first refused; overflow and corrupt source fail closed', async () => {
  const { f, request } = fixture();
  for (let n = 0; n < 19; n++) { const source = { ...f.sources[0], id: id(100 + n) }; f.sources.push(source); f.bindings.push({ id: id(200 + n), lesson_id: lesson, material_id: source.id, display_order: n }); }
  assert.equal((await request('POST', { material_id: material, display_order: 19 })).status, 201);
  f.sources.push({ ...f.sources[0], id: id(90) });
  assert.equal((await request('POST', { material_id: id(90), display_order: 20 })).status, 409);
  f.bindings.push({ id: id(91), lesson_id: lesson, material_id: id(90), display_order: 20 });
  assert.equal((await request()).status, 409);
  f.bindings.pop(); f.sources = [];
  assert.equal((await request()).status, 409);
});
test('delete cannot address a binding in another lesson; missing retry does not audit', async () => {
  const { f, request } = fixture();
  f.bindings.push({ id: id(9), lesson_id: id(99), material_id: material, display_order: 0 });
  assert.equal((await request('DELETE', {}, '/' + id(9))).status, 404);
  assert.equal(f.bindings.length, 1); assert.equal(f.audit.length, 0);
});
test('audit failure rolls back attach and detach on the same connection', async () => withSilencedErrors(async () => {
  const { f, request } = fixture(); f.failAudit = true;
  assert.equal((await request('POST', { material_id: material, display_order: 0 })).status, 500); assert.equal(f.bindings.length, 0);
  f.bindings.push({ id: id(9), lesson_id: lesson, material_id: material, display_order: 0 });
  assert.equal((await request('DELETE', {}, '/' + id(9))).status, 500); assert.equal(f.bindings.length, 1);
  assert.equal(f.audit.length, 0); assert.ok(!f.events.includes('commit'));
}));
test('lost commit acknowledgement never reports success, rolls back or retries; connection destroyed', async () => withSilencedErrors(async () => {
  const { f, request } = fixture(); f.failCommit = true;
  const result = await request('POST', { material_id: material, display_order: 0 });
  assert.equal(result.status, 500); assert.equal(result.body.code, 'PERSISTENCE_UNCERTAIN');
  assert.deepEqual(f.events, ['begin', 'commit', 'destroy']); assert.equal(f.acquired, 1);
}));
test('real tenant-self mounting and authentication reach owner guard for every content verb', async () => {
  const isolation = createIsolation(); const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = TEST_SECRET;
  try {
    const modules = loadAppModules(isolation, path.join(__dirname, '../src/routes/tenant-self'));
    for (const resource of ['contents','videos']) for (const method of ['GET', 'POST', 'DELETE']) {
      const h = buildHarness(makeState(), modules);
      const pathName = `/catalog/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_1}/${resource}${method === 'DELETE' ? '/' + id(9) : ''}`;
      const r = await runChain(h.chain, makeReq({ method, pathName, token: sign(INSTRUCTOR_A, 'instructor'),
        body: method === 'POST' ? { [resource==='videos'?'video_id':'material_id']: material, display_order: 0 } : {} }));
      assert.equal(r.status, 403); assert.equal(h.connectionCount(), 1);
      assert.equal(h.auditRows.length, 0); assert.equal(h.commitCount(), 0);
      assert.equal(r.headers['Cache-Control'], 'no-store');
    }
    assert.deepEqual(isolation.sentinelCalls, []); assert.equal(isolation.hookRestored(), true);
  } finally { isolation.restore(); if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; }
});
test('rollback failure discards connection', async () => withSilencedErrors(async () => {
  const { f, request } = fixture(); f.owner = false; f.failRollback = true;
  assert.equal((await request()).status, 403); assert.deepEqual(f.events, ['begin', 'rollback', 'destroy']);
}));

test('material selector is bounded, private, keyset paged and includes owner drafts without URLs', async () => {
  const { f, request } = fixture();
  for (let n = 10; n < 40; n++) f.sources.push({ ...f.sources[0], id: id(n), is_published: n % 2 });
  f.sources.push({ ...f.sources[0], id: id(99), course_id: id(99) });
  const first = await request('GET', {}, '/available-materials');
  assert.equal(first.status, 200); assert.equal(first.body.materials.length, 25);
  assert.equal(first.body.next_cursor, first.body.materials[24].material_id);
  assert.deepEqual(Object.keys(first.body.materials[0]), ['material_id', 'title', 'material_type', 'is_published']);
  assert.equal(first.body.materials[0].is_published, false);
  assert.ok(!JSON.stringify(first.body).includes('private-secret'));
  const second = await request('GET', {}, '/available-materials', undefined, { cursor: first.body.next_cursor });
  assert.equal(second.body.materials.length, 6); assert.equal(second.body.next_cursor, null);
  assert.ok(second.body.materials.every((m: any) => m.material_id > first.body.next_cursor));
  assert.equal(f.audit.length, 0); assert.ok(!f.events.includes('commit'));
  assert.equal(first.headers['Cache-Control'], 'no-store');
});
test('selector refuses query injection, foreign scope and missing schema without content writes', async () => {
  const { f, request } = fixture();
  for (const query of [{ cursor: ['bad'] }, { cursor: 'bad' }, { tenant_id: 'foreign' }, { limit: 100000 }]) {
    assert.equal((await request('GET', {}, '/available-materials', undefined, query)).status, 400);
  }
  assert.equal(f.acquired, 0);
  f.owner = false; assert.equal((await request('GET', {}, '/available-materials')).status, 403);
  f.owner = true; f.schema = false; assert.equal((await request('GET', {}, '/available-materials')).status, 503);
  assert.equal(f.bindings.length, 0); assert.equal(f.audit.length, 0);
});
