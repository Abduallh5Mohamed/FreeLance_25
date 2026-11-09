import assert from 'node:assert/strict';
import test from 'node:test';
import {createAssignmentController,parseAssignmentSnapshot,parseAssignmentAck,parseCandidatePage} from '../features/support/assignment';
import {getSupportAssignment,getSupportAssignmentCandidates,assignSupportTicket,reconcileSupportAssignment,ApiRequestError} from '../lib/api-http';
const key='a1000000-0000-4000-8000-000000000001';
const snapshot=(target:string|null=null,version=0)=>({assignment:{ticket_id:'ticket',assigned_to:target,version},assignee:target?{id:target,name:`Name ${target}`}:null});
const ack=(target:string|null='admin',version=1)=>({assignment:snapshot(target,version).assignment,changed:true,unchanged:false});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
test('assignment read deadline releases the panel and fences an ignored-abort late response',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=fixture(),waiting=deferred();h.deps.read=()=>waiting.promise;
  const work=h.controller.load();t.mock.timers.tick(25000);await new Promise<void>(resolve=>queueMicrotask(resolve));await new Promise<void>(resolve=>queueMicrotask(resolve));
  try{assert.equal(h.controller.getState().phase,'error');assert.equal(h.controller.getState().busyRead,false);}
  finally{waiting.resolve(snapshot('other',5));await work;assert.equal(h.controller.getState().phase,'error');assert.equal(h.calls.some(row=>row?.candidates!==undefined),false);h.controller.dispose();}
});
test('candidate-page deadline releases busy state and ignores a late page',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=fixture();
  h.deps.candidates=async()=>({candidates:Array.from({length:25},(_,n)=>({id:'candidate-'+n,name:'Candidate '+n})),next_cursor:'candidate-24'});
  await h.controller.load();const waiting=deferred();h.deps.candidates=()=>waiting.promise;
  const work=h.controller.loadMore();t.mock.timers.tick(25000);await work;assert.equal(h.controller.getState().busyRead,false);assert.ok(h.controller.getState().readError);
  waiting.resolve({candidates:[{id:'late',name:'Late'}],next_cursor:null});await Promise.resolve();assert.equal(h.controller.getState().candidates.some(x=>x.id==='late'),false);h.controller.dispose();
});
test('confirmed assignment remains confirmed when its fresh read reaches the deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=fixture();await h.controller.load();const waiting=deferred();h.deps.read=()=>waiting.promise;
  const work=h.controller.save('admin');for(let n=0;n<25&&!h.controller.getState().busyRead;n++)await Promise.resolve();assert.equal(h.controller.getState().busyRead,true);
  t.mock.timers.tick(25000);assert.ok(await work);assert.equal(h.controller.getState().phase,'error');assert.match(h.controller.getState().notice!,/قرار التكليف مؤكد/);assert.equal(h.controller.getState().write.uncertain,false);assert.equal(h.stored(),null);
  waiting.resolve(snapshot('other',7));await Promise.resolve();assert.equal(h.controller.getState().snapshot,null);h.controller.dispose();
});
function fixture(saved:string|null=null){
  let stored=saved,identity='admin',state=snapshot();const calls:any[]=[],receipts=new Map<string,any>();
  const deps={readIdentity:()=>identity,readKey:()=>stored,saveKey:(key:string)=>{stored=key;},clearKey:()=>{stored=null;},makeKey:()=>key,
    read:async(_signal:AbortSignal):Promise<any>=>{calls.push('read');return state;},
    candidates:async(after:string|null,_signal:AbortSignal):Promise<any>=>{calls.push({candidates:after});return {candidates:[{id:'admin',name:'Admin'},{id:'other',name:'Other'}],next_cursor:null};},
    send:async(input:any,key:string,_signal:AbortSignal):Promise<any>=>{calls.push({post:input,key});state=snapshot(input.assigned_to,input.expected_version+1);const result=ack(input.assigned_to,state.assignment.version);receipts.set(key,result);return result;},
    reconcile:async(key:string,_signal:AbortSignal):Promise<any>=>{calls.push({check:key});return {...receipts.get(key),unchanged:true};},
  };
  return {deps,calls,receipts,stored:()=>stored,identity:(value:string)=>{identity=value;},setState:(value:ReturnType<typeof snapshot>)=>{state=value;},controller:createAssignmentController('ticket','admin',deps)};
}
test('assignment DTOs reject foreign targets, private fields, malformed versions and ambiguous recipient pages',()=>{
  assert.deepEqual(parseAssignmentSnapshot(snapshot(),'ticket'),snapshot());assert.equal(parseAssignmentAck(ack(),'ticket').changed,true);
  for(const value of [{...snapshot(),phone:'private'},snapshot('admin',NaN),{...snapshot('admin'),assignee:{id:'other',name:'Other'}},{...snapshot(),assignment:{...snapshot().assignment,ticket_id:'foreign'}},snapshot(null,-1)])assert.throws(()=>parseAssignmentSnapshot(value,'ticket'));
  assert.throws(()=>parseAssignmentAck({...ack(),changed:'true'},'ticket'));assert.throws(()=>parseCandidatePage({candidates:[{id:'admin',name:'Name',phone:'private'}],next_cursor:null}));
  assert.throws(()=>parseCandidatePage({candidates:[{id:'admin',name:'A'},{id:'ADMIN',name:'B'}],next_cursor:null}));assert.throws(()=>parseCandidatePage({candidates:[],next_cursor:'admin'}));
});
test('assignment opens read-only and single-flight save uses the displayed version then fresh current state',async()=>{
  const h=fixture();assert.equal(h.calls.length,0);await h.controller.load();const waiting=deferred();h.deps.send=async(input,key)=>{h.calls.push({post:input,key});return waiting.promise;};
  const first=h.controller.save('admin');assert.equal(await h.controller.save('other'),null);assert.equal(h.calls.filter(row=>row.post).length,1);
  h.setState(snapshot('other',2));waiting.resolve(ack('admin',1));assert.ok(await first);
  assert.equal(h.controller.getState().snapshot?.assignee?.id,'other');assert.equal(h.stored(),null);assert.equal(h.controller.getState().write.uncertain,false);h.controller.dispose();
});
test('confirmed assignment with refresh failure stays confirmed and hides obsolete state',async()=>{
  const h=fixture();await h.controller.load();h.deps.read=async()=>{throw Error('read outage');};assert.ok(await h.controller.save('admin'));
  assert.equal(h.controller.getState().phase,'error');assert.equal(h.controller.getState().snapshot,null);assert.equal(h.controller.getState().write.uncertain,false);assert.match(h.controller.getState().notice!,/قرار التكليف مؤكد/);
  assert.equal(h.stored(),null);assert.equal(await h.controller.save('other'),null);assert.equal(h.calls.filter(row=>row.post).length,1);h.controller.dispose();
});
test('reload recovers historical assignment by GET and displays newer state without a second POST',async()=>{
  const h=fixture();await h.controller.load();const original=h.deps.send;h.deps.send=async(input,key,signal)=>{await original(input,key,signal);throw Error('lost acknowledgement');};
  await h.controller.save('admin');assert.equal(h.stored(),key);h.controller.dispose();h.setState(snapshot('other',2));
  const reopened=createAssignmentController('ticket','admin',h.deps);await reopened.load();assert.ok(await reopened.reconcile());assert.equal(h.calls.filter(row=>row.post).length,1);
  assert.equal(reopened.getState().snapshot?.assignment.version,2);assert.equal(reopened.getState().snapshot?.assignee?.id,'other');assert.equal(h.stored(),null);reopened.dispose();
});
test('unknown attempt freezes new decisions; in-memory retry retains exact version, target and key',async()=>{
  const h=fixture();await h.controller.load();let fail=true;const original=h.deps.send;h.deps.send=async(input,key,signal)=>{if(fail){h.calls.push({post:input,key});throw Error('network');}return original(input,key,signal);};
  await h.controller.save('other');assert.equal(h.controller.getState().canRetry,true);assert.equal(await h.controller.save(null),null);assert.equal(h.stored(),key);
  fail=false;assert.ok(await h.controller.retry());const posts=h.calls.filter(row=>row.post);assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);h.controller.dispose();
});
test('missing receipt retains pending key and schema/permission failures never enable fresh decisions',async()=>{
  const h=fixture(key);h.deps.reconcile=async()=>{throw new ApiRequestError('Missing',404,'SUPPORT_ATTEMPT_NOT_FOUND');};await h.controller.load();await h.controller.reconcile();assert.equal(h.stored(),key);assert.equal(h.controller.getState().write.uncertain,true);assert.equal(await h.controller.save('other'),null);
  h.deps.read=async()=>{throw new ApiRequestError('Unavailable',503,'SUPPORT_ASSIGNMENT_UNAVAILABLE');};await h.controller.load();assert.equal(h.controller.getState().phase,'unavailable');assert.equal(h.controller.getState().snapshot,null);h.controller.dispose();
  const denied=fixture();await denied.controller.load();denied.deps.read=async()=>{throw new ApiRequestError('Denied',404);};await denied.controller.load();assert.equal(denied.controller.getState().phase,'denied');assert.equal(denied.controller.getState().snapshot,null);assert.equal(denied.controller.getState().candidates.length,0);denied.controller.dispose();
});
for(const code of ['SUPPORT_ASSIGNMENT_STALE','SUPPORT_TICKET_CLOSED','SUPPORT_ASSIGNEE_UNAVAILABLE'])test(`definitive ${code} clears only rejected intent and reloads before another decision`,async()=>{
  const h=fixture();await h.controller.load();h.deps.send=async()=>{throw new ApiRequestError('Refused',409,code);};h.setState(snapshot('other',4));
  assert.equal(await h.controller.save('admin'),null);assert.equal(h.stored(),null);assert.equal(h.controller.getState().write.uncertain,false);assert.equal(h.controller.getState().snapshot?.assignment.version,4);assert.match(h.controller.getState().notice!,/لم يُنفذ القرار/);h.controller.dispose();
});
test('server closure prevents new decisions even when the parent ticket snapshot was open',async()=>{
  const h=fixture();await h.controller.load();h.deps.send=async()=>{throw new ApiRequestError('Closed',409,'SUPPORT_TICKET_CLOSED');};await h.controller.save('admin');
  assert.equal(h.controller.getState().decisionBlocked,true);assert.equal(await h.controller.save('other'),null);h.controller.dispose();
});
test('generic conflicts and failed local cleanup never silently authorize a new attempt',async()=>{
  const h=fixture();await h.controller.load();h.deps.send=async()=>{throw new ApiRequestError('Conflict',409,'SUPPORT_WRITE_CONFLICT');};await h.controller.save('admin');assert.equal(h.stored(),key);assert.equal(h.controller.getState().write.uncertain,true);h.controller.dispose();
  const cleanup=fixture();await cleanup.controller.load();cleanup.deps.clearKey=()=>{throw Error('storage');};cleanup.deps.send=async()=>{throw new ApiRequestError('Stale',409,'SUPPORT_ASSIGNMENT_STALE');};
  // Capture methods dynamically, matching the actual browser storage wrapper.
  const controller=createAssignmentController('ticket','admin',{...cleanup.deps,clearKey:()=>cleanup.deps.clearKey()});await controller.load();await controller.save('admin');assert.equal(controller.getState().write.blocked,true);assert.equal(controller.getState().write.uncertain,false);assert.equal(await controller.save('other'),null);controller.dispose();cleanup.controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`assignment read cannot apply after ${fence}`,async()=>{
  const h=fixture(),wait=deferred();let signal:AbortSignal|undefined;h.deps.read=async(cancel)=>{signal=cancel;return wait.promise;};const loading=h.controller.load();
  if(fence==='identity')h.identity('other');else if(fence==='event')h.controller.invalidate();else h.controller.dispose();wait.resolve(snapshot('admin',1));await loading;
  assert.equal(h.controller.getState().snapshot,null);assert.equal(h.controller.getState().candidates.length,0);assert.equal(signal?.aborted,true);h.controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`assignment write cannot confirm after ${fence}`,async()=>{
  const h=fixture(),wait=deferred();await h.controller.load();h.deps.send=async()=>wait.promise;const saving=h.controller.save('admin'),reads=h.calls.filter(row=>row==='read').length;
  if(fence==='identity')h.identity('other');else if(fence==='event')h.controller.invalidate();else h.controller.dispose();wait.resolve(ack());assert.equal(await saving,null);
  assert.equal(h.controller.getState().snapshot,null);assert.equal(h.stored(),key);assert.equal(h.calls.filter(row=>row==='read').length,reads);h.controller.dispose();
});
test('candidate paging is explicit and single-flight, with overlap rejection and no writes on invalid selection',async()=>{
  const h=fixture(),wait=deferred(),rows=Array.from({length:25},(_,n)=>({id:`agent-${n}`,name:`Agent ${n}`}));let count=0;
  h.deps.candidates=async after=>{count++;return after?wait.promise:{candidates:rows,next_cursor:rows[24].id};};await h.controller.load();
  assert.equal(await h.controller.save('forged'),null);assert.equal(h.stored(),null);const more=h.controller.loadMore();await h.controller.loadMore();assert.equal(count,2);
  wait.resolve({candidates:[rows[0]],next_cursor:null});await more;assert.equal(h.controller.getState().candidates.length,25);assert.equal(h.controller.getState().nextCursor,rows[24].id);assert.ok(h.controller.getState().readError);h.controller.dispose();
});
test('canonical assignment transport sends only target/version with keyed no-store bearer requests',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];
  (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url,init});return new Response(JSON.stringify(String(url).includes('/candidates')?{candidates:[],next_cursor:null}:init.method==='POST'||String(url).includes('/attempts/')?ack():snapshot()));};
  try{await getSupportAssignment('ticket');await getSupportAssignmentCandidates('ticket','agent-1');await assignSupportTicket('ticket',{assigned_to:'admin',expected_version:0},key);await reconcileSupportAssignment('ticket',key);
    assert.deepEqual(calls.map(row=>row.url),['/api/support-tickets/ticket/assignment','/api/support-tickets/ticket/assignment/candidates?after=agent-1','/api/support-tickets/ticket/assignment',`/api/support-tickets/ticket/assignment/attempts/${key}`]);
    assert.deepEqual(JSON.parse(calls[2].init.body),{assigned_to:'admin',expected_version:0});assert.equal(new Headers(calls[2].init.headers).get('Idempotency-Key'),key);assert.ok(calls.every(row=>row.init.cache==='no-store'&&new Headers(row.init.headers).get('Authorization')==='Bearer synthetic-token'));
  }finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
