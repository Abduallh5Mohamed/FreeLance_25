import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSupportDraftTarget,parseLessonSupportContext,parseSupportContextEnvelope,createSupportContextController} from '../features/support/lesson-context';
import {getLessonSupportContext,getSupportTicketContext} from '../lib/api-http';
const courseId='b1000000-0000-4000-8000-000000000001',lessonId='c1000000-0000-4000-8000-000000000001';
const context={kind:'catalog_lesson',course_id:courseId,lesson_id:lessonId,course_name:'Synthetic course',lesson_title:'Synthetic lesson'};
const deferred=()=>{let resolve!:(x:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};
test('support draft URLs accept only one exact lesson pair, without authority selectors',()=>{
  assert.deepEqual(parseSupportDraftTarget(''),{kind:'none'});
  assert.deepEqual(parseSupportDraftTarget(`?course=${courseId}&lesson=${lessonId}`),{kind:'lesson',courseId,lessonId});
  for(const search of [`?course=${courseId}`,`?course=bad&lesson=${lessonId}`,`?course=${courseId}&lesson=${lessonId}&tenant_id=foreign`,`?course=${courseId}&course=${courseId}&lesson=${lessonId}`])assert.deepEqual(parseSupportDraftTarget(search),{kind:'invalid'});
});
test('context DTO rejects private fields, wrong target, false availability and invalid titles',()=>{
  assert.deepEqual(parseLessonSupportContext(context,{courseId,lessonId}),context);
  for(const value of [{...context,tenant_id:'private'},{...context,lesson_title:''},{...context,course_name:'x'.repeat(256)}])assert.throws(()=>parseLessonSupportContext(value));
  assert.throws(()=>parseLessonSupportContext(context,{courseId:lessonId,lessonId}));
  assert.throws(()=>parseSupportContextEnvelope({state:'unavailable',context}));
  assert.deepEqual(parseSupportContextEnvelope({state:'unavailable',context:null}),{state:'unavailable',context:null});
});
test('new context read aborts and supersedes an older response',async()=>{
  const first=deferred(),second=deferred(),signals:AbortSignal[]=[];let calls=0;
  const controller=createSupportContextController({readIdentity:()=> 'owner',read:signal=>{signals.push(signal);return ++calls===1?first.promise:second.promise;}});
  const a=controller.load(),b=controller.load();assert.equal(signals[0].aborted,true);
  second.resolve({state:'available',context});await b;
  first.resolve({state:'available',context:{...context,lesson_title:'Stale title'}});await a;
  assert.equal(controller.getState().data?.context?.lesson_title,'Synthetic lesson');controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`private context response is fenced after ${fence}`,async()=>{
  let identity='owner';const pending=deferred();const controller=createSupportContextController({readIdentity:()=>identity,read:async()=>pending.promise});
  const loading=controller.load();if(fence==='identity')identity='other';else if(fence==='event')controller.invalidate();else controller.dispose();
  pending.resolve({state:'available',context});await loading;assert.equal(controller.getState().data,null);controller.dispose();
});
test('a failed refresh clears a previously verified context instead of claiming stale availability',async()=>{
  let fail=false;const controller=createSupportContextController({readIdentity:()=> 'owner',read:async()=>{if(fail)throw Error('withdrawn');return{state:'available',context};}});
  await controller.load();assert.equal(controller.getState().phase,'ready');fail=true;await controller.load();assert.equal(controller.getState().phase,'error');assert.equal(controller.getState().data,null);controller.dispose();
});
test('ticket-context authority loss retires its view; draft not-found remains a context-only failure',async()=>{
  let denied=0;const read=async()=>{throw Object.assign(Error('Not found'),{status:404});};
  const ticket=createSupportContextController({readIdentity:()=> 'owner',read,onDenied:()=>{denied++;}});
  const draft=createSupportContextController({readIdentity:()=> 'owner',read});
  await ticket.load();await draft.load();assert.equal(denied,1);assert.equal(ticket.getState().phase,'session-ended');assert.equal(draft.getState().phase,'error');ticket.dispose();draft.dispose();
});
test('canonical context transport sends only lesson selectors and creates no implicit write',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];
  (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url,init});return new Response(JSON.stringify(String(url).endsWith('/support-context')?{context}:{state:'available',context}));};
  try{
    assert.deepEqual(await getLessonSupportContext(courseId,lessonId),context);assert.equal((await getSupportTicketContext('ticket')).state,'available');
    assert.deepEqual(calls.map(row=>row.url),[`/api/student-course-access/courses/${courseId}/lessons/${lessonId}/support-context`,'/api/support-tickets/ticket/context']);
    assert.ok(calls.every(row=>!row.init.body&&row.init.cache==='no-store'&&new Headers(row.init.headers).get('Authorization')==='Bearer synthetic-token'));
  }finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
