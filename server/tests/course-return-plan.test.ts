import assert from 'node:assert/strict';
import test from 'node:test';
import {createCourseReturnPlanRouter,parseReturnInput} from '../src/routes/course-return-plan';
import {fixture,uid} from './helpers/lesson-package-fixture';
import {makeReq,runChain,COURSE_A1,OWNER_A,TENANT_A} from './helpers/m2-course-lessons-harness';
import {base,from,input,harness} from './helpers/return-plan-fixture';

test('return payload requires exact bounded scope, dates, steps and known-or-null duration',()=>{
 assert.ok(parseReturnInput(input()));for(const raw of [{...input(),tenant_id:TENANT_A},{...input(),to:from},{...input(),to:'2026-12-20T00:00:00.000Z'},{...input(),enrollment_id:' '},{...input(),steps:[{lesson_id:uid(10),minutes:1.5}]},{...input(),steps:[{lesson_id:uid(10),minutes:181}]},{...input(),steps:[{lesson_id:uid(10),minutes:10},{lesson_id:uid(10),minutes:null}]}])assert.equal(parseReturnInput(raw),null);
 assert.equal(parseReturnInput({...input(),review_token:'a'.repeat(64)},true),null);
});
test('actual roster and preview distinguish excused/unrecorded attendance from independent catalog progress',async()=>{
 const h=harness(),list=await h.request('/students');assert.equal(list.status,200);assert.deepEqual(list.body.students,[{enrollment_id:'enrollment-one',name:'Synthetic student'}]);
 const r=await h.request();assert.equal(r.status,200);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.body.attendance[0].state,'excused');assert.equal(r.body.lessons[0].completed,false);assert.equal(r.body.steps.length,0);assert.equal(r.body.review_token,null);assert.equal(r.body.delivery,'not_sent');
 h.s.attendanceState='unrecorded';assert.equal((await h.request()).body.attendance[0].state,'unrecorded');h.s.sessions=0;assert.deepEqual((await h.request()).body.attendance,[]);assert.equal(h.state.audits,0);
});
test('selected steps require a current server review and do not create completion/access/submission writes',async()=>{
 const h=harness(),body={...input(),steps:[{lesson_id:uid(10),minutes:15},{lesson_id:uid(11),minutes:null}]};
 const preview=await h.request('/preview',body);assert.equal(preview.status,200);assert.equal(preview.body.steps[1].minutes,null);assert.match(preview.body.review_token,/^[a-f\d]{64}$/);
 const reviewed=await h.request('/review',{...body,review_token:preview.body.review_token});assert.equal(reviewed.status,200);assert.equal(reviewed.body.reviewed,true);assert.equal(reviewed.body.delivery,'not_sent');assert.equal(h.state.audits,0);
 for(const field of ['user_id','phone','email','correct_answers','response','reason'])assert.ok(!JSON.stringify(reviewed.body).includes('"'+field+'"'));assert.ok(h.s.sql.every(q=>q.startsWith('SELECT ')));
});
for(const change of ['attendance','completed','locked','shared_proof','duration'])test(`review rechecks ${change} and refuses a stale or ineligible plan`,async()=>{
 const h=harness(),body={...input(),steps:[{lesson_id:uid(10),minutes:10}]};const first=await h.request('/preview',body);assert.equal(first.status,200);
 if(change==='attendance')h.s.attendanceState='present';if(change==='completed')h.s.completed=true;if(change==='locked')h.s.locked=true;if(change==='shared_proof')h.s.proof=false;if(change==='duration')body.steps[0].minutes=20;
 const r=await h.request('/review',{...body,review_token:first.body.review_token});assert.equal(r.status,409);assert.equal(h.state.audits,0);
});
for(const boundary of ['owner','student','course','selector','billing','query','unpublished'])test(`return-plan ${boundary} boundary denies private draft evidence`,async()=>{
 const h=harness();let extra:any={},body:any=input();if(boundary==='owner')h.s.owner=false;if(boundary==='student')h.s.enrolled=false;if(boundary==='course')extra.user={id:OWNER_A,tenantId:'foreign'};
 if(boundary==='selector')extra.headers={'x-enrollment-id':'enrollment-one'};if(boundary==='billing')extra.user={id:OWNER_A,tenantId:TENANT_A,billingOnly:true};if(boundary==='query')extra.query={student_id:'other'};if(boundary==='unpublished')h.s.published=false;
 const r=await h.request('/preview',body,extra);assert.ok([400,403,404].includes(r.status));assert.equal(r.body.attendance,undefined);assert.equal(h.state.audits,0);
});
for(const kind of ['schema','attendance_bound','lesson_bound','roster_bound','cleanup'])test(`${kind} fails closed or discards unsafe read connection`,async()=>{
 const h=harness();if(kind==='schema')h.s.schema=false;if(kind==='attendance_bound')h.s.sessions=101;if(kind==='lesson_bound')h.s.lessons=501;if(kind==='roster_bound')h.s.students=27;if(kind==='cleanup')h.s.cleanupFail=true;
 const r=await h.request(kind==='roster_bound'?'/students':'/preview');if(kind==='cleanup'){assert.equal(r.status,200);assert.equal(h.s.disposed.at(-1),'destroy');}else{assert.equal(r.status,503);assert.equal(r.body.lessons,undefined);}assert.equal(h.state.audits,0);
});
