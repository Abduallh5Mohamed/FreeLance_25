import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../lib/api-http';
import {
  canonicalSelection, createTemplateLibrary, initialTemplateLibrary, createTemplateApplication, initialTemplateApplication, parseApplicationReview,
  parseRevisionList, parseTemplateList, templateApplicationTransport, templateLibraryTransport,
} from '../features/catalog/lesson-package-templates';
const id = (n: number) => `b3400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEMPLATE = id(1), MATERIAL = id(10), OPERATION = id(90);
const selected = [{ kind: 'material' as const, source_id: MATERIAL }];
const review = (over: any = {}) => ({
  context:{template_id:TEMPLATE,revision_number:1,lesson_id:id(3)}, review_token: 'a'.repeat(64), can_apply: true, projected_media_count: 1,
  items: [{ kind: 'material', source_id: MATERIAL, title: '<script>source</script>', display_order: 0, audience: 'course', source_state: 'published', outcome: 'add', conflict: null }],
  timing: { mode: 'keep', current_release_at: null, proposed_release_at: null }, ...over,
});
const receipt = (over: any = {}) => ({ context:{template_id:TEMPLATE,revision_number:1,lesson_id:id(3)}, operation_id: OPERATION, created: 1, existing: 0, timing: { mode: 'keep', release_at: null }, replayed: false, ...over });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };

function fixture() {
  const s = {
    principal: 'A', event: () => { }, calls: [] as string[], timing: null as any, binding: null as any,
    apply: async (): Promise<any> => ({ ...receipt() }),
    status: async (): Promise<any> => ({ context:{template_id:TEMPLATE,revision_number:1,lesson_id:id(3)}, operation_id: OPERATION, created: 1, existing: 0, timing: { mode: 'keep', release_at: null } }),
  };
  const controller = createTemplateApplication({
    readPrincipal: () => s.principal,
    subscribeSession: fn => { s.event = fn; return () => { }; },
    newOperationId: () => OPERATION,
    review: async (templateId, revisionNumber, timing) => { s.calls.push('review'); s.binding = { templateId, revisionNumber }; s.timing = timing; return review({context:{template_id:templateId,revision_number:revisionNumber,lesson_id:id(3)}}); },
    apply: async (...args: any[]) => { s.calls.push('apply'); s.timing = args[2]; const value=await s.apply(); return {...value,context:{template_id:s.binding.templateId,revision_number:s.binding.revisionNumber,lesson_id:id(3)}}; },
    status: async () => { s.calls.push('status'); const value=await s.status(); return value===null?null:{...value,context:{template_id:s.binding.templateId,revision_number:s.binding.revisionNumber,lesson_id:id(3)}}; },
  });
  let latest = initialTemplateApplication();
  controller.subscribe(value => { latest = value; });
  return { s, controller, latest: () => latest };
}

test('covering review is exact, reference-bound and consistent with can_apply', () => {
  assert.equal(parseApplicationReview(review()).items[0].title, '<script>source</script>');
  for (const changed of [
    { ...review(), can_apply: false },
    { ...review(), projected_media_count: 41 },
    { ...review(), secret: 'private' },
    { ...review(), items: [{ ...review().items[0], file_url: 'private' }] },
    { ...review(), items: [{ ...review().items[0], outcome: 'conflict', conflict: null }] },
    { ...review(), items: [{ ...review().items[0], outcome: 'add', conflict: 'capacity' }] },
    { ...review(), timing: { mode: 'set', current_release_at: null, proposed_release_at: '2026-11-10T18:00:00Z' } },
    { ...review(), timing: { mode: 'keep', current_release_at: '2026-11-10T18:00:00Z', proposed_release_at: null, extra: 1 } },
  ]) assert.throws(() => parseApplicationReview(changed));
  assert.throws(() => canonicalSelection([...selected, ...selected]));
  assert.throws(() => canonicalSelection([]));
  assert.throws(() => canonicalSelection([{ kind: 'material', source_id: id(10) }, { kind: 'material', source_id: id(11) }, { kind: 'material', source_id: id(12) },
    { kind: 'material', source_id: id(13) }, { kind: 'material', source_id: id(14) }, { kind: 'material', source_id: id(15) }, { kind: 'material', source_id: id(16) },
    { kind: 'material', source_id: id(17) }, { kind: 'material', source_id: id(18) }, { kind: 'material', source_id: id(19) }, { kind: 'material', source_id: id(20) },
    { kind: 'material', source_id: id(21) }, { kind: 'material', source_id: id(22) }, { kind: 'material', source_id: id(23) }, { kind: 'material', source_id: id(24) },
    { kind: 'material', source_id: id(25) }, { kind: 'material', source_id: id(26) }, { kind: 'material', source_id: id(27) }, { kind: 'material', source_id: id(28) },
    { kind: 'material', source_id: id(29) }, { kind: 'material', source_id: id(30) }]));
});

test('list and revision pages are bounded and exact', () => {
  assert.deepEqual(parseTemplateList({ templates: [{ id: TEMPLATE, name: 'x', status: 'active', head_revision: 2 }], next_cursor: null }).templates[0].head_revision, 2);
  assert.deepEqual(parseRevisionList({ revisions: [{ revision_number: 2, source_lesson_id: id(2), reference_count: 1, media_count: 1 }], next_cursor: 'abc' }).nextCursor, 'abc');
  for (const raw of [{ templates: [], next_cursor: null, extra: 1 }, { templates: [{ id: TEMPLATE, name: '', status: 'active', head_revision: 1 }], next_cursor: null }, { templates: [], next_cursor: 5 }])
    assert.throws(() => parseTemplateList(raw));
  for (const raw of [{ revisions: [], next_cursor: null, extra: 1 }, { revisions: [{ revision_number: 0, source_lesson_id: id(2), reference_count: 1, media_count: 1 }], next_cursor: null },
    { revisions: [{ revision_number: 1, source_lesson_id: id(2), reference_count: 0, media_count: 1 }], next_cursor: null }])
    assert.throws(() => parseRevisionList(raw));
});

test('apply requires a current server review and uses the selected template/revision binding', async () => {
  const h = fixture();
  await h.controller.apply(true);
  assert.deepEqual(h.s.calls, []);
  await h.controller.review(TEMPLATE, 7, { mode: 'keep', release_at: null });
  assert.deepEqual(h.s.binding, { templateId: TEMPLATE, revisionNumber: 7 });
  assert.deepEqual(h.s.timing, { mode: 'keep', release_at: null });
  await h.controller.apply(false);
  assert.deepEqual(h.s.calls, ['review']);
  await h.controller.apply(true);
  assert.equal(h.latest().phase, 'saved');
  assert.equal(h.latest().result!.created, 1);
  assert.equal(h.latest().review, null);
  assert.deepEqual(h.s.calls, ['review', 'apply']);
  assert.deepEqual(h.s.timing, { mode: 'keep', release_at: null });
  h.controller.dispose();
});

test('set timing forwards the reviewed instant while keep never invents one', async () => {
  const h = fixture();
  const deps = { token: 'b'.repeat(64) };
  const controller = createTemplateApplication({
    readPrincipal: () => 'A', subscribeSession: () => () => { }, newOperationId: () => OPERATION,
    review: async () => review({review_token:deps.token, timing: { mode: 'set', current_release_at: null, proposed_release_at: '2026-11-10T18:00:00.000Z' } }),
    apply: async (_t, _r, timing, token, operationId, expectedCount) => {
      assert.deepEqual(timing, { mode: 'set', release_at: '2026-11-10T18:00:00.000Z' });
      assert.equal(token, deps.token); assert.equal(expectedCount, 1); assert.equal(operationId, OPERATION);
      return receipt({ timing: { mode: 'set', release_at: '2026-11-10T18:00:00.000Z' } });
    },
    status: async () => null,
  });
  await controller.review(TEMPLATE, 1, { mode: 'set', release_at: '2026-11-10T18:00:00.000Z' });
  await controller.apply(true);
  controller.dispose();
  h.controller.dispose();
});

for (const mode of ['network', 'server', 'malformed'])
  test(`uncertain ${mode} write freezes apply and review; GET receipt alone recovers`, async () => {
    const h = fixture();
    h.s.apply = async () => {
      if (mode === 'network') throw Error('lost');
      if (mode === 'server') throw new ApiRequestError('unknown', 500, 'PERSISTENCE_UNCERTAIN');
      throw Error('malformed response');
    };
    await h.controller.review(TEMPLATE, 3, { mode: 'keep', release_at: null });
    await h.controller.apply(true);
    assert.equal(h.latest().phase, 'uncertain');
    await h.controller.review(TEMPLATE, 3, { mode: 'keep', release_at: null });
    await h.controller.apply(true);
    assert.deepEqual(h.s.calls, ['review', 'apply']);
    await h.controller.recover();
    assert.equal(h.latest().phase, 'saved');
    assert.deepEqual(h.s.calls, ['review', 'apply', 'status']);
    h.controller.dispose();
  });

test('missing or malformed recovery keeps the uncertain state', async () => {
  const h = fixture();
  h.s.apply = async () => { throw Error('lost'); };
  await h.controller.review(TEMPLATE, 1, { mode: 'keep', release_at: null });
  await h.controller.apply(true);
  for (const response of [null, { ...receipt(), operation_id: id(99) }, { ...receipt(), timing: { mode: 'set', release_at: 'bad' } }]) {
    h.s.status = async () => response;
    await h.controller.recover();
    assert.equal(h.latest().phase, 'uncertain');
  }
  h.controller.dispose();
});

test('definite conflict drops the stale review and requires another review', async () => {
  const h = fixture();
  h.s.apply = async () => { throw new ApiRequestError('changed', 409, 'TEMPLATE_REVIEW_CHANGED'); };
  await h.controller.review(TEMPLATE, 1, { mode: 'keep', release_at: null });
  await h.controller.apply(true);
  assert.equal(h.latest().phase, 'error');
  assert.equal(h.latest().review, null);
  await h.controller.apply(true);
  assert.deepEqual(h.s.calls, ['review', 'apply']);
  h.controller.dispose();
});

for (const reason of ['event', 'principal', 'dispose'])
  test(`late successful apply does not expose a result after ${reason}`, async () => {
    const h = fixture(), pending = deferred();
    h.s.apply = () => pending.promise;
    await h.controller.review(TEMPLATE, 1, { mode: 'keep', release_at: null });
    const run = h.controller.apply(true);
    if (reason === 'event') h.s.event();
    if (reason === 'principal') h.s.principal = 'B';
    if (reason === 'dispose') h.controller.dispose();
    pending.resolve(receipt());
    await run;
    assert.equal(h.latest().result, null);
    assert.notEqual(h.latest().phase, 'saved');
    h.controller.dispose();
  });

test('actual canonical transports fix the course and post only reviewed inputs', async () => {
  const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage }, calls: any[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : null };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({})); };
  try {
    const library = templateLibraryTransport(id(1)), application = templateApplicationTransport(id(1), id(2), id(3)), signal = new AbortController().signal;
    await library.create({ name: 'x', source_lesson_id: id(4), selections: selected, operation_id: OPERATION }, signal).catch(() => undefined);
    await library.revisions(TEMPLATE, null, signal).catch(() => undefined);
    await application.review(TEMPLATE, 2, { mode: 'keep', release_at: null }, signal).catch(() => undefined);
    await application.apply(TEMPLATE, 2, { mode: 'set', release_at: '2026-11-10T18:00:00Z' }, 'a'.repeat(64), OPERATION, 1, signal).catch(() => undefined);
    await application.status(OPERATION, signal).catch(() => undefined);
    assert.equal(calls[0].url, `/api/tenants/me/catalog/courses/${id(1)}/lesson-templates`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'x', source_lesson_id: id(4), selections: selected, operation_id: OPERATION });
    assert.equal(calls[1].url, `/api/tenants/me/catalog/courses/${id(1)}/lesson-templates/${TEMPLATE}/revisions?limit=25`);
    assert.deepEqual(JSON.parse(calls[2].init.body), { template_id: TEMPLATE, revision_number: 2, timing: { mode: 'keep', release_at: null } });
    assert.deepEqual(JSON.parse(calls[3].init.body), { template_id: TEMPLATE, revision_number: 2, timing: { mode: 'set', release_at: '2026-11-10T18:00:00.000Z' }, review_token: 'a'.repeat(64), operation_id: OPERATION });
    assert.equal(calls[4].init.method, 'GET');
    assert.equal(calls[4].init.body, undefined);
    assert.ok(calls.every(call => new Headers(call.init.headers).get('X-Tenant-Id') === null));
    assert.throws(() => templateApplicationTransport(id(1), id(2), 'not-a-uuid'));
  } finally {
    globalThis.fetch = previous.fetch;
    (globalThis as any).localStorage = previous.storage;
  }
});

function libraryFixture() {
  const template={id:TEMPLATE,name:'Saved',status:'active' as const,head_revision:1};
  const s={principal:'A',event:()=>{},calls:[] as string[],
    list:async():Promise<any>=>({templates:[template],nextCursor:'next'}),
    outcome:async():Promise<any>=>({template,revision:{revision_number:1,reference_count:1,media_count:1}}),
    status:async():Promise<any>=>({operation_id:OPERATION,operation_kind:'create',template,revision:{revision_number:1,reference_count:1,media_count:1}}),
  };
  const controller=createTemplateLibrary({readPrincipal:()=>s.principal,subscribeSession:fn=>{s.event=fn;return()=>{};},newOperationId:()=>OPERATION,
    list:async()=>{s.calls.push('list');return s.list();},revisions:async()=>({revisions:[],nextCursor:null}),
    create:async body=>{s.calls.push('create');assert.equal(body.operation_id,OPERATION);return s.outcome();},
    revise:async()=>{s.calls.push('revise');return s.outcome();},archive:async()=>{s.calls.push('archive');return s.outcome();},status:async()=>{s.calls.push('status');return s.status();},
  });
  let latest=initialTemplateLibrary();controller.subscribe(value=>latest=value);
  return {s,controller,latest:()=>latest};
}
for(const operation of ['create','revise','archive'] as const)test(`${operation} lost reply preserves operation and freezes navigation until matching GET recovery`,async()=>{
  const h=libraryFixture();h.s.outcome=async()=>{throw Error('persisted but lost response');};
  if(operation==='create')await h.controller.create('Saved',id(4),selected);
  if(operation==='revise')await h.controller.revise(TEMPLATE,1,id(4),selected);
  if(operation==='archive')await h.controller.archive(TEMPLATE);
  assert.equal(h.latest().uncertain,true);assert.equal(h.latest().operationId,OPERATION);assert.equal(h.latest().saving,false);
  await h.controller.refresh();await h.controller.next();await h.controller.create('Other',id(4),selected);assert.deepEqual(h.s.calls,[operation]);
  h.s.status=async()=>null;await h.controller.recover();assert.equal(h.latest().uncertain,true);
  const template={id:TEMPLATE,name:'Saved',status:operation==='archive'?'archived':'active',head_revision:operation==='revise'?2:1};
  h.s.status=async()=>({operation_id:OPERATION,operation_kind:operation,template,...(operation==='archive'?{unchanged:false}:operation==='revise'?{template_id:TEMPLATE,revision:{revision_number:2,reference_count:1,media_count:1}}:{revision:{revision_number:1,reference_count:1,media_count:1}})});
  await h.controller.recover();assert.equal(h.latest().uncertain,false);assert.equal(h.latest().saved?.name,'Saved');assert.equal(h.latest().templates.length,0);
  h.s.list=async()=>{throw Error('list failed after confirmed write');};await h.controller.refresh();assert.equal(h.latest().saved?.name,'Saved');assert.equal(h.latest().phase,'error');h.controller.dispose();
});
for(const kind of ['resolve','reject'])test(`silent principal change during ${kind} list invalidates all private rows`,async()=>{
  const h=libraryFixture();await h.controller.refresh();assert.equal(h.latest().templates.length,1);
  let resolve!:(value:any)=>void,reject!:(reason:any)=>void;h.s.list=()=>new Promise((a,b)=>{resolve=a;reject=b;});
  const pending=h.controller.next();assert.equal(h.latest().templates.length,0);h.s.principal='B';
  if(kind==='resolve')resolve({templates:[],nextCursor:null});else reject(Error('lost'));
  await pending;assert.equal(h.latest().phase,'session-ended');assert.equal(h.latest().templates.length,0);h.controller.dispose();
});
test('library page replacement stays bounded and rejects repeated cursors/duplicate ids',async()=>{
  const h=libraryFixture();await h.controller.refresh();await h.controller.next();assert.equal(h.latest().phase,'error');
  h.s.list=async()=>({templates:Array.from({length:25},(_,i)=>({id:id(i+100),name:'row',head_revision:1,status:'active'})),nextCursor:'page2'});
  await h.controller.refresh();h.s.list=async()=>({templates:[{id:id(200),name:'page2',status:'active',head_revision:1}],nextCursor:null});await h.controller.next();assert.equal(h.latest().templates.length,1);
  h.s.list=async()=>({templates:[{id:TEMPLATE},{id:TEMPLATE}],nextCursor:null});await h.controller.refresh();assert.equal(h.latest().phase,'error');h.controller.dispose();
});
test('library external lock prevents refresh/archive and matching receipt context is required',async()=>{
  const h=libraryFixture();h.controller.setLocked(true);await h.controller.refresh();await h.controller.archive(TEMPLATE);assert.deepEqual(h.s.calls,[]);
  h.controller.setLocked(false);h.s.outcome=async()=>{throw Error('lost');};await h.controller.create('Saved',id(4),selected);
  h.s.status=async()=>({operation_id:id(99),operation_kind:'create'});await h.controller.recover();assert.equal(h.latest().uncertain,true);
  h.s.event();assert.equal(h.latest().phase,'session-ended');assert.equal(h.latest().operationId,null);h.controller.dispose();
});
test('archive deadline is uncertain and does not unlock a second write',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=libraryFixture(),d=deferred();h.s.outcome=()=>d.promise;
  const pending=h.controller.archive(TEMPLATE);t.mock.timers.tick(25000);assert.equal(h.latest().uncertain,true);await h.controller.create('Saved',id(4),selected);assert.deepEqual(h.s.calls,['archive']);
  d.resolve({template:{id:TEMPLATE,name:'Saved',status:'archived',head_revision:1},unchanged:false});await pending;assert.equal(h.latest().uncertain,true);h.controller.dispose();
});
test('mismatched review or receipt cannot be presented as the selected application',async()=>{
  const controller=createTemplateApplication({readPrincipal:()=>'A',subscribeSession:()=>()=>{},newOperationId:()=>OPERATION,
    review:async()=>review({context:{template_id:id(999),revision_number:1,lesson_id:id(3)}}),apply:async()=>receipt(),status:async()=>null});
  let latest=initialTemplateApplication();controller.subscribe(value=>latest=value);await controller.review(TEMPLATE,1,{mode:'keep',release_at:null});assert.equal(latest.phase,'error');controller.dispose();
});
