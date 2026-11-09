import assert from 'node:assert/strict';
import test from 'node:test';
import { createLessonPreparationRouter } from '../src/routes/lesson-preparation';
import { fixture, MATERIAL, uid } from './helpers/lesson-package-fixture';
import { makeReq, runChain, COURSE_A1, UNIT_A1, LESSON_1, OWNER_A, TENANT_A } from './helpers/m2-course-lessons-harness';
const route = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_1}/preparation`;
function harness() {
  const calls = { acquire:0, rollback:0, destroy:0, release:0, sql:[] as string[], fail:'', cleanupFails:false, parent:false, owner:true };
  const h = fixture({}, deps => createLessonPreparationRouter({ getConnection: async () => {
    calls.acquire++; const connection = await deps.getConnection();
    return { ...connection,
      execute:async(sql:string,p:any[]=[]) => {
        const q=sql.replace(/\s+/g,' ').trim();calls.sql.push(q);assert.match(q,/^SELECT /);
        if(calls.fail && q.includes(calls.fail))throw Object.assign(Error('missing source schema'),{code:'ER_BAD_FIELD_ERROR'});
        if(!calls.owner&&q.startsWith('SELECT u.id AS teaching_user_id'))return [[],[]];
        if(calls.parent&&q.startsWith('SELECT l.id,l.unit_id,l.title'))return [[],[]];
        return connection.execute(sql,p);
      },
      commit:async()=>{throw Error('Read route must not commit');},
      rollback:async()=>{calls.rollback++;await connection.rollback();if(calls.cleanupFails)throw Error('cleanup');},
      destroy:()=>{calls.destroy++;connection.destroy();},release:()=>{calls.release++;connection.release();},
    };
  } }));
  const request=async(path=route,extra:any={})=>{
    const req:any=makeReq({method:'GET',pathName:path,body:extra.body??{},query:extra.query??{},headers:extra.headers??{}});
    req.user=extra.user??{id:OWNER_A,tenantId:TENANT_A,role:'instructor'};
    const response=await runChain([h.router],req);
    await new Promise(resolve=>setImmediate(resolve));
    return response;
  };
  return {...h,calls,request};
}
test('mounted read is owner/course/lesson bound, fixed no-store DTO, and never writes or commits',async()=>{
  const h=harness(),r=await h.request();assert.equal(r.status,200);assert.equal(r.headers['Cache-Control'],'no-store');
  assert.deepEqual(r.body.context,{course_id:COURSE_A1,unit_id:UNIT_A1,lesson_id:LESSON_1});assert.equal(r.body.items.length,1);assert.equal(r.body.items[0].title,'Synthetic material');assert.equal(r.body.items[0].issue,null);
  assert.equal(r.body.learning_evidence,'insufficient');assert.equal(h.calls.rollback,1);assert.equal(h.calls.release,1);assert.equal(h.calls.destroy,0);assert.equal(h.state.audits,0);
  for(const field of ['source_id','tenant_id','owner_user_id','file_url','body','student_id','exam_version_id'])assert.ok(!JSON.stringify(r.body).includes('"'+field+'"'));
});
for(const boundary of ['owner','course','unit','lesson','billing','tenant','selector','query','body','identity'])test(`preparation rejects ${boundary} without source read`,async()=>{
  const h=harness();let path=route,extra:any={};
  if(boundary==='owner')h.calls.owner=false;
  if(boundary==='course')path=route.replace(COURSE_A1,uid(800));
  if(boundary==='unit')path=route.replace(UNIT_A1,uid(801));
  if(boundary==='lesson')h.calls.parent=true;
  if(boundary==='billing')extra.user={id:OWNER_A,tenantId:TENANT_A,billingOnly:true};
  if(boundary==='tenant')extra.user={id:OWNER_A,tenantId:'foreign'};
  if(boundary==='selector')extra.headers={'x-tenant-id':TENANT_A};
  if(boundary==='query')extra.query={group_id:uid(70),from:'2026-11-01'};
  if(boundary==='body')extra.body={student_id:uid(999)};
  if(boundary==='identity')extra.user={};
  const r=await h.request(path,extra);assert.ok([400,403,404].includes(r.status));assert.ok(!h.calls.sql.some(q=>q.includes('FROM course_materials')));assert.equal(h.state.audits,0);
});
test('withdrawn source loses title and evidence; empty lesson never becomes a student zero or readiness grant',async()=>{
  const h=harness();h.state.available=false;const r=await h.request();assert.equal(r.status,200);assert.equal(r.body.items[0].title,null);assert.equal(r.body.items[0].issue,'source_unavailable');
  h.state.bindings[LESSON_1].material=[];const empty=await h.request();assert.equal(empty.status,200);assert.deepEqual(empty.body.items,[]);assert.equal(empty.body.learning_evidence,'insufficient');
});
test('all five kinds yield source policy evidence; quiz pin and restricted audiences remain separate',async()=>{
  const h=harness(),b=h.state.bindings[LESSON_1];b.video.push({id:uid(120),source_id:uid(20),display_order:1});b.activity.push({id:uid(130),source_id:uid(30),kind:'homework',display_order:null},{id:uid(140),source_id:uid(40),kind:'quiz',display_order:null});b.announcement.push({id:uid(150),source_id:uid(50),display_order:null});
  let r=await h.request();assert.equal(r.status,200);assert.equal(r.body.items.length,5);assert.equal(r.body.items.find((x:any)=>x.kind==='quiz').issue,'quiz_version_required');assert.equal(r.body.items.find((x:any)=>x.kind==='announcement').issue,'draft_source');
  h.state.pin={content_id:uid(140),exam_id:uid(40),exam_version_id:uid(80)};h.state.quizGroups=[{id:uid(70),exam_id:uid(40),course_id:COURSE_A1,branch_scope:'tenant',branch_id:null}];
  r=await h.request();assert.equal(r.status,200);const quiz=r.body.items.find((x:any)=>x.kind==='quiz');assert.equal(quiz.quiz_version,'published');assert.equal(quiz.issue,'restricted_audience');assert.equal(h.state.audits,0);
});
for(const failure of ['schema','index','material','corrupt','overflow','cleanup'])test(`preparation ${failure} does not invent a current result or recycle an unsafe transaction`,async()=>{
  const h=harness();if(failure==='schema')h.state.schema=false;if(failure==='index')h.state.indexes=false;if(failure==='material')h.calls.fail='FROM course_materials';
  if(failure==='corrupt')h.state.bindings[LESSON_1].material[0].display_order=-1;
  if(failure==='overflow')h.state.bindings[LESSON_1].material=Array.from({length:21},(_,i)=>({id:uid(i+200),source_id:MATERIAL,display_order:i}));
  if(failure==='cleanup')h.calls.cleanupFails=true;
  const r=await h.request();if(failure==='cleanup'){assert.equal(r.status,200);assert.equal(h.calls.destroy,1);assert.equal(h.calls.release,0);}else{assert.ok([500,503].includes(r.status));assert.equal(r.body.items,undefined);}
  assert.equal(h.state.audits,0);assert.equal(h.calls.rollback,1);
});
