import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { makeReq, runChain, COURSE_A1, UNIT_A1, LESSON_1, LESSON_2, OWNER_A, TENANT_A, withSilencedErrors } from './helpers/m2-course-lessons-harness';

import { fixture, MATERIAL, OPERATION, uid } from './helpers/lesson-package-fixture';
import {createLessonPackageTemplatesRouter} from '../src/routes/lesson-package-templates';

const owner = () => ({ id: OWNER_A, tenantId: TENANT_A, role: 'instructor' });

test('library and revision paging bind a decimal string LIMIT compatible with actual MySQL prepared statements',async()=>{
 const limits:unknown[]=[];const h=fixture({},deps=>createLessonPackageTemplatesRouter({...deps,getConnection:async()=>{const c=await deps.getConnection();return{...c,execute:async(sql:string,p?:any[])=>{if(sql.includes('LIMIT ?'))limits.push(p?.at(-1));return c.execute(sql,p);}};}}));
 const created=await createTemplate(h.router);assert.equal(created.status,201);
 assert.equal((await request(h.router,'GET',`/courses/${COURSE_A1}/lesson-templates`)).status,200);
 assert.equal((await request(h.router,'GET',`/courses/${COURSE_A1}/lesson-templates/${created.body.template.id}/revisions`)).status,200);
 assert.deepEqual(limits,['26','26']);
});

test('library metadata remains readable without unrelated source schemas while application still fails closed',async()=>{
 let blockSources=false;
 const h=fixture({},deps=>createLessonPackageTemplatesRouter({...deps,getConnection:async()=>{const c=await deps.getConnection();return{...c,execute:async(sql:string,p?:any[])=>{if(blockSources&&sql.includes("TABLE_NAME='course_lesson_videos'"))return [[],[]];return c.execute(sql,p);}};}}));
 const created=await createTemplate(h.router);assert.equal(created.status,201);blockSources=true;
 const listed=await request(h.router,'GET',`/courses/${COURSE_A1}/lesson-templates`);assert.equal(listed.status,200);
 const revisions=await request(h.router,'GET',`/courses/${COURSE_A1}/lesson-templates/${created.body.template.id}/revisions`);assert.equal(revisions.status,200);
 const applied=await withSilencedErrors(()=>request(h.router,'POST',`/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`,{template_id:created.body.template.id,revision_number:1,timing:{mode:'keep'}}));assert.equal(applied.status,503);assert.equal(h.state.bindings[LESSON_2].material.length,0);
 const unavailable=fixture({schema:false});assert.equal((await request(unavailable.router,'GET',`/courses/${COURSE_A1}/lesson-templates`)).status,503);
});

function request(router: any, method: string, pathName: string, body: any = {}, extra: any = {}) {
  if ((method === 'POST' && (pathName.endsWith('/lesson-templates') || pathName.endsWith('/revisions')) || method === 'PATCH') && !Object.hasOwn(body,'operation_id')) body={...body,operation_id:randomUUID()};
  const req: any = makeReq({ method, pathName, body, query: extra.query ?? {}, headers: extra.headers, token: null });
  req.user = extra.user ?? owner();
  req.params = req.params ?? {};
  return runChain([router as RequestHandler], req);
}

async function createTemplate(router: any, name = 'First template') {
  return request(router, 'POST', `/courses/${COURSE_A1}/lesson-templates`, {
    name, source_lesson_id: LESSON_1, selections: [{ kind: 'material', source_id: MATERIAL }],
  });
}

test('lesson template routes require the verified owner and reject selector authority', async () => {
  const h = fixture();
  const foreign = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {}, { user: { id: 'instructor-not-owner', tenantId: TENANT_A } });
  assert.equal(foreign.status, 403);
  const billing = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {}, { user: { ...owner(), billingOnly: true } });
  assert.equal(billing.status, 403);
  const selector = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {}, { user: owner(), headers: { 'x-tenant-id': TENANT_A } });
  assert.equal(selector.status, 400);
});

test('create, list, revise and archive keep immutable revisions inside the same course', async () => {
  const h = fixture();
  const created = await createTemplate(h.router);
  assert.equal(created.status, 201);
  const templateId = created.body.template.id;
  assert.equal(created.body.template.head_revision, 1);

  const listed = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {});
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.templates.map((row: any) => row.id), [templateId]);

  const duplicate = await createTemplate(h.router);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'TEMPLATE_NAME_EXISTS');

  const revised = await request(h.router, 'POST', `/courses/${COURSE_A1}/lesson-templates/${templateId}/revisions`, {
    source_lesson_id: LESSON_1, selections: [{ kind: 'material', source_id: MATERIAL }], expected_revision: 1,
  });
  assert.equal(revised.status, 201);
  assert.equal(revised.body.revision.revision_number, 2);

  const revisions = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates/${templateId}/revisions`, {});
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.body.revisions.map((row: any) => row.revision_number), [1, 2]);

  const archived = await request(h.router, 'PATCH', `/courses/${COURSE_A1}/lesson-templates/${templateId}`, { status: 'archived' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.template.status, 'archived');

  const after = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {});
  assert.equal(after.body.templates.length, 0);
  const applyArchived = await request(h.router, 'POST', `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`, {
    template_id: templateId, revision_number: 2, timing: { mode: 'keep' },
  });
  assert.equal(applyArchived.status, 409);
  assert.equal(applyArchived.body.code, 'TEMPLATE_ARCHIVED');
});

test('review/apply is explicit, timing changes only the destination, and replay does not duplicate references', async () => {
  const h = fixture();
  const created = await createTemplate(h.router);
  const templateId = created.body.template.id;
  const reviewPath = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`;
  const applyPath = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-apply`;

  const review = await request(h.router, 'POST', reviewPath, { template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' } });
  assert.equal(review.status, 200);
  assert.equal(review.body.can_apply, true);
  assert.equal(review.body.items[0].outcome, 'add');
  assert.equal(review.body.items[0].audience, 'course');
  assert.equal(review.body.timing.current_release_at, null);
  assert.equal(review.body.timing.proposed_release_at, '2026-12-01T10:00:00.000Z');

  const wrongToken = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' },
    review_token: 'f'.repeat(64), operation_id: OPERATION,
  });
  assert.equal(wrongToken.status, 409);
  assert.equal(wrongToken.body.code, 'TEMPLATE_REVIEW_CHANGED');

  const applied = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' },
    review_token: review.body.review_token, operation_id: OPERATION,
  });
  assert.equal(applied.status, 201);
  assert.deepEqual({ created: applied.body.created, existing: applied.body.existing, replayed: applied.body.replayed }, { created: 1, existing: 0, replayed: false });
  assert.equal(h.state.release.get(LESSON_2), Math.floor(Date.parse('2026-12-01T10:00:00Z') / 1000));
  assert.equal(h.state.release.get(LESSON_1), 1_700_000_000);
  assert.equal(h.state.bindings[LESSON_2].material.length, 1);
  assert.equal(h.state.audits, 2);

  const replay = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' },
    review_token: review.body.review_token, operation_id: OPERATION,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(h.state.bindings[LESSON_2].material.length, 1);

  const reusedIdentity = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'clear', release_at: null },
    review_token: review.body.review_token, operation_id: OPERATION,
  });
  assert.equal(reusedIdentity.status, 409);
  assert.equal(reusedIdentity.body.code, 'TEMPLATE_OPERATION_CONFLICT');
  assert.equal(h.state.bindings[LESSON_2].material.length, 1);

  const status = await request(h.router, 'GET', `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-operations/${OPERATION}`, {});
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.operation.created, 1);

  const cleared = await request(h.router, 'POST', reviewPath, { template_id: templateId, revision_number: 1, timing: { mode: 'clear', release_at: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.items[0].outcome, 'present');
  const clearApply = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'clear', release_at: null },
    review_token: cleared.body.review_token, operation_id: uid(91),
  });
  assert.equal(clearApply.status, 201);
  assert.equal(clearApply.body.created, 0);
  assert.equal(clearApply.body.existing, 1);
  assert.equal(h.state.release.get(LESSON_2), null);
});

test('templates from another course or tenant are not addressable', async () => {
  const h = fixture();
  const created = await createTemplate(h.router);
  const templateId = created.body.template.id;
  const review = await request(h.router, 'POST', `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`, {
    template_id: templateId, revision_number: 1, timing: { mode: 'keep' },
  });
  assert.equal(review.status, 200);
  h.state.templates[0].tenant_id = 'tenant-b';
  const foreign = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates/${templateId}/revisions`, {});
  assert.equal(foreign.status, 404);
});

test('schema absence fails closed instead of creating partial template writes', async () => {
  const h = fixture({ schema: false });
  const response = await withSilencedErrors(() => createTemplate(h.router));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'LESSON_TEMPLATES_UNAVAILABLE');
  assert.equal(h.state.templates.length, 0);
  assert.equal(h.state.audits, 0);
});

const libraryPath = `/courses/${COURSE_A1}/lesson-templates`;
const applicationPath = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-`;
const createBody = (operation_id = OPERATION) => ({ name:'Recoverable',source_lesson_id:LESSON_1,selections:[{kind:'material',source_id:MATERIAL}],operation_id });
async function prepared(h: ReturnType<typeof fixture>, timing:any={mode:'set',release_at:'2026-12-01T10:00:00Z'}) {
  const created=await createTemplate(h.router); assert.equal(created.status,201);
  const body={template_id:created.body.template.id,revision_number:1,timing};
  const review=await request(h.router,'POST',applicationPath+'review',body); assert.equal(review.status,200);
  return {...body,review_token:review.body.review_token,operation_id:OPERATION};
}

for(const kind of ['create','revise','archive'] as const) {
  test(`${kind}: lost commit ACK preserves one durable operation; GET recovers and exact replay adds no write`,async()=>{
    const h=fixture();let path=libraryPath,method='POST',body:any=createBody();
    if(kind!=='create') {
      const first=await createTemplate(h.router);assert.equal(first.status,201);path+='/'+first.body.template.id;
      if(kind==='revise'){path+='/revisions';body={source_lesson_id:LESSON_1,selections:createBody().selections,expected_revision:1,operation_id:OPERATION};}
      else {method='PATCH';body={status:'archived',operation_id:OPERATION};}
    }
    h.state.loseCommit=true;
    const response=await withSilencedErrors(()=>request(h.router,method,path,body));
    assert.equal(response.status,500);assert.equal(response.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.state.events.at(-1),'destroy');
    const before=structuredClone({templates:h.state.templates,revisions:h.state.revisions,audits:h.state.audits});
    const status=await request(h.router,'GET',libraryPath+'/operations/'+OPERATION);
    assert.equal(status.status,200);assert.equal(status.body.operation.operation_kind,kind);assert.equal(status.body.operation.operation_id,OPERATION);
    const replay=await request(h.router,method,path,body);assert.equal(replay.status,200);
    assert.deepEqual({templates:h.state.templates,revisions:h.state.revisions,audits:h.state.audits},before);
    assert.equal(h.state.libraryOperations.filter(row=>row.operation_id===OPERATION).length,1);
    h.state.libraryOperations.find(row=>row.operation_id===OPERATION).actor_user_id='another-owner';
    assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION)).status,409);
  });
}
test('library operation is payload/kind bound and concurrent identical creates commit once',async()=>{
  const h=fixture(),body=createBody();
  const responses=await Promise.all([request(h.router,'POST',libraryPath,body),request(h.router,'POST',libraryPath,body)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);assert.equal(h.state.audits,1);assert.equal(h.state.templates.length,1);
  assert.equal((await request(h.router,'POST',libraryPath,{...body,name:'Changed'})).status,409);
  assert.notEqual((await request(h.router,'PATCH',libraryPath+'/'+h.state.templates[0].id,{status:'archived',operation_id:OPERATION})).status,200);
  assert.equal(h.state.templates[0].status,'active');
});
test('already archived receipt is committed without another audit',async()=>{
  const h=fixture();const c=await createTemplate(h.router);const path=libraryPath+'/'+c.body.template.id;
  await request(h.router,'PATCH',path,{status:'archived'});
  const r=await request(h.router,'PATCH',path,{status:'archived',operation_id:OPERATION});assert.equal(r.body.unchanged,true);
  assert.equal(h.state.audits,2);assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION)).body.operation.unchanged,true);
});
for(const failure of ['INSERT INTO lesson_package_template_revisions','INSERT INTO audit_events','INSERT INTO lesson_template_library_operations']) {
  test(`create failure at ${failure} restores template, version, references, audit and receipt`,async()=>{
    const h=fixture();h.state.failSQL=failure;
    const r=await withSilencedErrors(()=>createTemplate(h.router));assert.equal(r.status,500);
    for(const rows of [h.state.templates,h.state.revisions,h.state.references,h.state.libraryOperations])assert.equal(rows.length,0);
    assert.equal(h.state.audits,0);assert.ok(h.state.events.includes('rollback'));
  });
}
for(const failure of ['INSERT INTO course_lesson_contents','UPDATE course_lessons SET release_at','INSERT INTO audit_events','INSERT INTO lesson_template_operations']) {
  test(`apply failure at ${failure} restores every reference, timing, audit and receipt`,async()=>{
    const h=fixture(),body=await prepared(h);const before=structuredClone({bindings:h.state.bindings,release:h.state.release,audits:h.state.audits});h.state.failSQL=failure;
    const r=await withSilencedErrors(()=>request(h.router,'POST',applicationPath+'apply',body));assert.equal(r.status,500);
    assert.deepEqual({bindings:h.state.bindings,release:h.state.release,audits:h.state.audits},before);assert.equal(h.state.operations.length,0);assert.ok(h.state.events.includes('rollback'));
  });
}
test('apply lost commit recovers exact destination/version/timing; replay is single mutation',async()=>{
  const h=fixture(),body=await prepared(h);h.state.loseCommit=true;
  const r=await withSilencedErrors(()=>request(h.router,'POST',applicationPath+'apply',body));assert.equal(r.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.state.events.at(-1),'destroy');
  const status=await request(h.router,'GET',applicationPath+'operations/'+OPERATION);assert.equal(status.body.operation.context.template_id,body.template_id);assert.equal(status.body.operation.context.lesson_id,LESSON_2);
  assert.equal((await request(h.router,'POST',applicationPath+'apply',body)).status,200);assert.equal(h.state.operations.length,1);assert.equal(h.state.audits,2);
});
for(const corrupt of [
  (h:any)=>h.state.references[0].display_order=null,
  (h:any)=>h.state.references[0].display_order=1.5,
  (h:any)=>h.state.references[0].display_order=-1,
  (h:any)=>h.state.references[0].display_order=2147483648,
  (h:any)=>h.state.references[0].display_order='0',
  (h:any)=>h.state.references[0].kind='homework',
  (h:any)=>h.state.references.push({...h.state.references[0],source_id:uid(99)}),
  (h:any)=>h.state.revisions[0].reference_count=2,
  (h:any)=>h.state.revisions[0].media_count=0,
  (h:any)=>h.state.revisions[0].content_hash='0'.repeat(64),
  (h:any)=>h.state.revisions[0].id='invalid',
]) test('corrupt saved snapshot is rejected before mutation',async()=>{
  const h=fixture(),body=await prepared(h);corrupt(h);
  const r=await withSilencedErrors(()=>request(h.router,'POST',applicationPath+'apply',body));assert.equal(r.status,500);assert.equal(h.state.operations.length,0);assert.equal(h.state.bindings[LESSON_2].material.length,0);assert.equal(h.state.audits,1);
});
for(const override of [
  (row:any)=>({...row,data_type:'varchar',max_length:1,is_nullable:'YES'}),
  (row:any)=>row.column_name==='name'?{...row,max_length:1}:row,
  (row:any)=>row.column_name==='content_hash'?{...row,collation_name:'utf8mb4_general_ci'}:row,
  (row:any)=>row.column_name==='display_order'?{...row,is_nullable:'NO'}:row,
  (row:any)=>row.column_name==='kind'?{...row,column_type:"enum('material')"}:row,
])test('incompatible physical template column contract fails closed',async()=>{
  const h=fixture();h.state.columnOverride=override;assert.equal((await createTemplate(h.router)).status,503);assert.equal(h.state.templates.length,0);
});
for(const option of ['indexes','foreignKeys','engine'] as const)test(`missing ${option} fails closed`,async()=>{
  const h=fixture();if(option==='engine')h.state.engine='MyISAM';else h.state[option]=false;
  assert.equal((await createTemplate(h.router)).status,503);assert.equal(h.state.templates.length,0);
});
test('all five kinds preserve their audience and positions; no pin/publication/history is copied',async()=>{
  const h=fixture(),source=h.state.bindings[LESSON_1];source.video.push({id:uid(120),source_id:uid(20),display_order:1});
  source.activity.push({id:uid(130),kind:'homework',source_id:uid(30),display_order:null},{id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});
  source.announcement.push({id:uid(150),source_id:uid(50),display_order:null});
  const selections=[{kind:'material',source_id:MATERIAL},...['video','homework','quiz','announcement'].map((kind,i)=>({kind,source_id:uid((i+2)*10)}))];
  const c=await request(h.router,'POST',libraryPath,{...createBody(),selections});assert.equal(c.status,201);assert.equal(c.body.revision.reference_count,5);
  const body={template_id:c.body.template.id,revision_number:1,timing:{mode:'keep'}};
  const review=await request(h.router,'POST',applicationPath+'review',body);assert.equal(review.status,200);assert.equal(review.body.can_apply,true);assert.equal(review.body.items.find((r:any)=>r.kind==='announcement').audience,'restricted');
  const applied=await request(h.router,'POST',applicationPath+'apply',{...body,review_token:review.body.review_token,operation_id:uid(91)});assert.equal(applied.status,201);assert.equal(applied.body.created,5);assert.equal(h.state.bindings[LESSON_2].video[0].display_order,1);assert.equal(h.state.audits,2);
});
test('changed source facts or destination positions invalidate review without partial effects',async()=>{
  for(const change of ['title','destination']) {
    const h=fixture(),body=await prepared(h);
    if(change==='title')h.state.title='Changed';else h.state.bindings[LESSON_2].material.push({id:uid(88),source_id:uid(89),display_order:0});
    const r=await request(h.router,'POST',applicationPath+'apply',body);assert.equal(r.status,409);assert.equal(h.state.operations.length,0);assert.equal(h.state.audits,1);
  }
});

for(const kind of ['revise','archive'])for(const failure of ['INSERT INTO audit_events','INSERT INTO lesson_template_library_operations'])test(`${kind} rolls back head/status and version rows on ${failure}`,async()=>{
  const h=fixture(),c=await createTemplate(h.router),templateId=c.body.template.id;
  const before=structuredClone({templates:h.state.templates,revisions:h.state.revisions,references:h.state.references,libraryOperations:h.state.libraryOperations,audits:h.state.audits});
  h.state.failSQL=failure;
  const r=await withSilencedErrors(()=>request(h.router,kind==='revise'?'POST':'PATCH',libraryPath+'/'+templateId+(kind==='revise'?'/revisions':''),kind==='revise'?{source_lesson_id:LESSON_1,selections:createBody().selections,expected_revision:1}:{status:'archived'}));
  assert.equal(r.status,500);assert.deepEqual({templates:h.state.templates,revisions:h.state.revisions,references:h.state.references,libraryOperations:h.state.libraryOperations,audits:h.state.audits},before);
});
test('competing revisions use the expected head; one version advances with no stale audit or receipt',async()=>{
  const h=fixture(),c=await createTemplate(h.router),path=libraryPath+'/'+c.body.template.id+'/revisions';
  const body={source_lesson_id:LESSON_1,selections:createBody().selections,expected_revision:1};
  const results=await Promise.all([request(h.router,'POST',path,body),request(h.router,'POST',path,body)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(h.state.templates[0].head_revision,2);assert.equal(h.state.revisions.length,2);assert.equal(h.state.audits,2);assert.equal(h.state.libraryOperations.length,2);
});
test('timing and audience changes make the review stale; no mutation or receipt is produced',async()=>{
  for(const kind of ['timing','audience']) {
    const h=fixture();
    if(kind==='timing') {const body=await prepared(h);h.state.release.set(LESSON_2,1800000000);const r=await request(h.router,'POST',applicationPath+'apply',body);assert.equal(r.status,409);assert.equal(h.state.release.get(LESSON_2),1800000000);}
    else {
      h.state.bindings[LESSON_1].activity.push({id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});
      const c=await request(h.router,'POST',libraryPath,{...createBody(),selections:[{kind:'quiz',source_id:uid(40)}]});assert.equal(c.status,201);
      const body={template_id:c.body.template.id,revision_number:1,timing:{mode:'keep'}};
      const review=await request(h.router,'POST',applicationPath+'review',body);assert.equal(review.status,200);
      h.state.quizGroups=[{id:uid(70),exam_id:uid(40),course_id:COURSE_A1,branch_scope:'tenant',branch_id:null}];
      const r=await request(h.router,'POST',applicationPath+'apply',{...body,review_token:review.body.review_token,operation_id:OPERATION});assert.equal(r.status,409);assert.equal(h.state.bindings[LESSON_2].activity.length,0);
    }
    assert.equal(h.state.operations.length,0);assert.equal(h.state.audits,1);assert.equal(h.state.bindings[LESSON_2].material.length,0);
  }
});
for(const kind of ['position','capacity','singleton','unavailable'])test(`template final-state ${kind} conflict has no partial effects`,async()=>{
  const h=fixture();let selected:any=createBody().selections;
  if(kind==='singleton'){h.state.bindings[LESSON_1].activity.push({id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});selected=[{kind:'quiz',source_id:uid(40)}];}
  const c=await request(h.router,'POST',libraryPath,{...createBody(),selections:selected});assert.equal(c.status,201);
  if(kind==='position')h.state.bindings[LESSON_2].material.push({id:uid(110),source_id:uid(100),display_order:0});
  if(kind==='capacity')h.state.bindings[LESSON_2].material=Array.from({length:20},(_,i)=>({id:uid(i+110),source_id:uid(i+210),display_order:i+1}));
  if(kind==='singleton')h.state.bindings[LESSON_2].activity.push({id:uid(141),kind:'quiz',source_id:uid(41),display_order:null});
  if(kind==='unavailable')h.state.available=false;
  const before=structuredClone({bindings:h.state.bindings,release:h.state.release});const body={template_id:c.body.template.id,revision_number:1,timing:{mode:'clear',release_at:null}};
  const review=await request(h.router,'POST',applicationPath+'review',body);assert.equal(review.status,200);assert.equal(review.body.can_apply,false);
  const r=await request(h.router,'POST',applicationPath+'apply',{...body,review_token:review.body.review_token,operation_id:uid(91)});assert.equal(r.status,409);assert.deepEqual({bindings:h.state.bindings,release:h.state.release},before);assert.equal(h.state.operations.length,0);assert.equal(h.state.audits,1);
});
test('receipt lookup remains private and malformed operation inputs never write',async()=>{
  const h=fixture();
  assert.equal((await request(h.router,'POST',libraryPath,{...createBody(),operation_id:null})).status,400);
  const c=await createTemplate(h.router);assert.equal(c.status,201);
  assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION,{}, {user:{...owner(),tenantId:'foreign'}})).status,403);
  assert.equal((await request(h.router,'GET',`/courses/${uid(999)}/lesson-templates/operations/${OPERATION}`)).status,404);
  assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION)).body.operation,null);
  assert.equal(h.state.audits,1);assert.equal(h.state.templates.length,1);
});
