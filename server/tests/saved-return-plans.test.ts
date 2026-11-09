import assert from 'node:assert/strict';
import test from 'node:test';
import {harness,input} from './helpers/return-plan-fixture';
import {uid} from './helpers/lesson-package-fixture';
import {COURSE_A1,TENANT_A,OWNER_A,makeReq,runChain} from './helpers/m2-course-lessons-harness';
import {createStudentReturnPlansRouter} from '../src/routes/student-return-plans';
const operation=uid(900);
async function prepared(h:ReturnType<typeof harness>,op=operation,version=0){const body={...input(),steps:[{lesson_id:uid(10),minutes:15}]};const r=await h.request('/review',{...body,review_token:(await h.request('/preview',body)).body.review_token});assert.equal(r.status,200);return{...body,review_token:r.body.review_token,operation_id:op,expected_version:version};}
test('saved plan, immutable revision, shared audit and keyed receipt commit together; identical replay is historical',async()=>{
 const h=harness({persistence:true}),body=await prepared(h);const r=await h.request('/save',body);assert.equal(r.status,201);assert.equal(r.body.operation.version,1);assert.equal(h.state.returnHeads.length,1);assert.equal(h.state.returnRevisions.length,1);assert.equal(h.state.audits,1);
 const second=await prepared(h,uid(901),1);assert.equal((await h.request('/save',second)).status,201);assert.equal(h.state.returnRevisions.length,2);assert.equal(h.state.returnHeads[0].version,2);
 const replay=await h.request('/save',body);assert.equal(replay.status,200);assert.equal(replay.body.operation.version,1);assert.equal(h.state.audits,2);assert.equal(h.state.returnRevisions.length,2);
 const changed=await h.request('/save',{...body,steps:[{lesson_id:uid(11),minutes:15}]});assert.equal(changed.status,409);
});
test('competing expected-head saves cannot overwrite a newer plan',async()=>{
 const h=harness({persistence:true}),body=await prepared(h);const results=await Promise.all([h.request('/save',body),h.request('/save',{...body,operation_id:uid(902)})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(h.state.returnRevisions.length,1);assert.equal(h.state.audits,1);
});
test('UUID case variants share one canonical course plan scope',async()=>{
 const h=harness({persistence:true});await h.request('/save',await prepared(h));const second=await prepared(h,uid(904),1);
 const req:any=makeReq({method:'POST',pathName:`/courses/${COURSE_A1.toUpperCase()}/return-plan/save`,body:second});req.user={id:OWNER_A,tenantId:TENANT_A,role:'instructor'};const r=await runChain([h.router],req);await new Promise(resolve=>setImmediate(resolve));assert.equal(r.status,201);assert.equal(h.state.returnHeads.length,1);assert.equal(h.state.returnHeads[0].course_id,COURSE_A1);assert.equal(h.state.returnHeads[0].version,2);
});
test('failed replacement restores the previous current revision and audit',async()=>{
 const h=harness({persistence:true});await h.request('/save',await prepared(h));const second=await prepared(h,uid(905),1);h.s.fail='INSERT INTO course_return_plan_revisions';const r=await h.request('/save',second);assert.equal(r.status,500);assert.equal(h.state.returnHeads[0].version,1);assert.equal(h.state.returnRevisions.length,1);assert.equal(h.state.returnOperations.length,1);assert.equal(h.state.audits,1);
});
for(const failure of ['INSERT INTO course_return_plan_revisions','INSERT INTO audit_events','INSERT INTO course_return_plan_operations'])test(`failure at ${failure} rolls back head/revision/audit/receipt`,async()=>{
 const h=harness({persistence:true}),body=await prepared(h);h.s.fail=failure;const r=await h.request('/save',body);assert.equal(r.status,500);assert.equal(h.state.returnHeads.length,0);assert.equal(h.state.returnRevisions.length,0);assert.equal(h.state.returnOperations.length,0);assert.equal(h.state.audits,0);assert.ok(h.state.events.includes('rollback'));
});
test('lost commit response destroys connection, keeps one durable save and recovers with GET even after enrollment expires',async()=>{
 const h=harness({persistence:true}),body=await prepared(h);h.state.loseCommit=true;const r=await h.request('/save',body);assert.equal(r.status,500);assert.equal(r.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.disposed.at(-1),'destroy');assert.equal(h.state.returnHeads.length,1);
 h.s.enrolled=false;const status=await h.request('/operations/'+operation);assert.equal(status.status,200);assert.equal(status.body.operation.version,1);assert.equal((await h.request('/save',body)).status,200);assert.equal(h.state.audits,1);
 h.state.returnOperations[0].actor_user_id='other-owner';assert.equal((await h.request('/operations/'+operation)).status,409);
});
test('withdrawal appends a revision and historical receipt without removing earlier versions',async()=>{
 const h=harness({persistence:true}),body=await prepared(h);await h.request('/save',body);const withdraw={enrollment_id:body.enrollment_id,operation_id:uid(903),expected_version:1};const r=await h.request('/withdraw',withdraw);assert.equal(r.status,201);assert.equal(r.body.operation.status,'withdrawn');assert.equal(h.state.returnRevisions.length,2);assert.equal(h.state.returnHeads[0].version,2);assert.equal(h.state.returnHeads[0].status,'withdrawn');assert.deepEqual(JSON.parse(h.state.returnRevisions[1].steps),[]);assert.equal((await h.request('/withdraw',withdraw)).status,200);assert.equal(h.state.audits,2);
});
for(const mode of ['missing','types','indexes','fk'])test(`incompatible saved-plan ${mode} prevents writes and draft does not pretend persistence is ready`,async()=>{
 const h=harness({persistence:true});if(mode==='missing')h.s.persistence=false;if(mode==='types')h.s.badStorage=true;if(mode==='indexes')h.s.storageIndexes=false;if(mode==='fk')h.s.storageKeys=false;
 const preview=await h.request();assert.equal(preview.status,200);assert.equal(preview.body.persistence.status,'unavailable');const r=await h.request('/save',{...input(),steps:[{lesson_id:uid(10),minutes:null}],review_token:'a'.repeat(64),expected_version:0,operation_id:operation});assert.equal(r.status,503);assert.equal(h.state.returnHeads.length,0);
});
function studentHarness(){const h=harness({persistence:true},createStudentReturnPlansRouter);h.state.returnHeads.push({id:uid(700),tenant_id:TENANT_A,course_id:COURSE_A1,enrollment_id:'enrollment-one',version:1,status:'active'});h.state.returnRevisions.push({plan_id:uid(700),version:1,status:'active',steps:JSON.stringify([{lesson_id:uid(10),minutes:15}])});
 const read=async(extra:any={})=>{const req:any=makeReq({method:'GET',pathName:'/my-return-plans',body:{},query:extra.query??{},headers:extra.headers??{}});req.user=extra.user??{id:'student-one',role:'student',tenantId:TENANT_A,studentEnrollmentId:'enrollment-one',tokenVersion:0};const r=await runChain([h.router],req);await new Promise(resolve=>setImmediate(resolve));return r;};return{...h,read};}
test('student reads only its current plan; current policy hides revoked lesson identities and titles',async()=>{
 const h=studentHarness();const r=await h.read();assert.equal(r.status,200);assert.equal(r.body.plans.length,1);assert.equal(r.body.plans[0].steps[0].available,true);assert.equal(r.body.plans[0].steps[0].title,'Lesson');
 h.s.proof=false;const locked=await h.read();assert.equal(locked.status,200);assert.deepEqual(locked.body.plans[0].steps,[{position:1,available:false}]);
 for(const field of ['enrollment_id','actor_user_id','from_at','to_at','attendance','review_token'])assert.ok(!JSON.stringify(locked.body).includes('"'+field+'"'));
});
test('withdrawn/foreign-enrollment/unpublished plans never fall back to earlier versions',async()=>{
 const h=studentHarness();h.state.returnHeads[0].status='withdrawn';assert.deepEqual((await h.read()).body.plans,[]);h.state.returnHeads[0].status='active';h.s.published=false;assert.deepEqual((await h.read()).body.plans,[]);h.s.published=true;h.state.returnHeads[0].enrollment_id='other';assert.deepEqual((await h.read()).body.plans,[]);
});
for(const kind of ['staff','token','suspension','scope','selector','corrupt'])test(`student ${kind} cannot disclose saved plan steps`,async()=>{
 const h=studentHarness();let extra:any={};if(kind==='staff')extra.user={id:OWNER_A,role:'instructor',tenantId:TENANT_A};if(kind==='token')extra.user={id:'student-one',role:'student',tenantId:TENANT_A,studentEnrollmentId:'enrollment-one',tokenVersion:99};if(kind==='suspension')h.s.studentActive=false;if(kind==='scope')extra.user={id:'student-one',role:'student',tenantId:TENANT_A};if(kind==='selector')extra.headers={'x-enrollment-id':'other'};if(kind==='corrupt')h.state.returnRevisions[0].steps='[{"lesson_id":"invalid","minutes":15}]';
 const r=await h.read(extra);assert.ok([400,403,404,409,503].includes(r.status));assert.equal(r.body.plans,undefined);
});
