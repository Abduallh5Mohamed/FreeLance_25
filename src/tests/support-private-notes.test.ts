import assert from 'node:assert/strict';
import test from 'node:test';
import {createPrivateNotesController,parsePrivateNotePage,parsePrivateNoteAck} from '../features/support/private-notes';
import {getSupportPrivateNotes,addSupportPrivateNote,reconcileSupportPrivateNote,ApiRequestError} from '../lib/api-http';
const id=(n:number)=>`e1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const note=(n=1)=>({id:id(n),ticket_id:'ticket',author_id:'support-agent',author_name:'Agent',body:`private ${n}`,created_at:'2026-11-05T10:00:00.000Z'});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};
function fixture(saved:string|null=null){
  let stored=saved,identity='admin';const calls:any[]=[],rows:any[]=[];
  const deps={readIdentity:()=>identity,readKey:()=>stored,saveKey:(key:string)=>{stored=key;},clearKey:()=>{stored=null;},makeKey:()=>id(90),
    list:async(before:string|null,_signal:AbortSignal):Promise<any>=>{calls.push({list:before});return{notes:[...rows],next_cursor:null};},
    send:async(body:string,key:string,_signal:AbortSignal):Promise<any>=>{calls.push({post:key});const saved={...note(),body};rows.push(saved);return{note:saved,unchanged:false};},
    reconcile:async(key:string,_signal:AbortSignal):Promise<any>=>{calls.push({check:key});return{note:rows[0],unchanged:true};},
  };
  const controller=createPrivateNotesController('ticket',deps);return {controller,deps,calls,rows,stored:()=>stored,identity:(next:string)=>{identity=next;}};
}
test('private note parser rejects public-reply shapes, wrong target, contact extras and invalid cursors',()=>{
  assert.equal(parsePrivateNotePage({notes:[note()],next_cursor:null},'ticket').notes.length,1);
  for(const value of [{notes:[{...note(),phone:'private'}],next_cursor:null},{notes:[{...note(),ticket_id:'foreign'}],next_cursor:null},{notes:[note(),note()],next_cursor:null},
    {notes:[note()],next_cursor:id(1)},{notes:[{id:id(1),sender_id:'user',sender_name:'user',body:'reply',created_at:note().created_at}],next_cursor:null},
    {notes:[{...note(),created_at:'not a date'}],next_cursor:null}])assert.throws(()=>parsePrivateNotePage(value,'ticket'));
  assert.throws(()=>parsePrivateNoteAck({note:note(),unchanged:'true'},'ticket'));
});
test('private reader performs no write; duplicate note submit is single flight and refreshes from server',async()=>{
  const h=fixture();assert.equal(h.calls.length,0);await h.controller.load();assert.equal(h.calls.length,1);assert.equal(h.calls[0].list,null);
  const pending=deferred();h.deps.send=async(body,key)=>{h.calls.push({post:key});return pending.promise;};
  const first=h.controller.save('private 1');assert.equal(await h.controller.save('private 1'),null);assert.equal(h.calls.filter(row=>row.post).length,1);
  h.rows.push(note());pending.resolve({note:note(),unchanged:false});assert.ok(await first);assert.equal(h.controller.getState().notes.length,1);assert.equal(h.stored(),null);h.controller.dispose();
});
test('confirmed private save survives refresh failure without becoming a failed write or stale list',async()=>{
  const h=fixture();await h.controller.load();h.deps.list=async()=>{throw Error('read outage');};
  assert.ok(await h.controller.save('private 1'));const state=h.controller.getState();assert.equal(state.phase,'error');assert.equal(state.write.uncertain,false);assert.equal(state.write.error,null);assert.deepEqual(state.notes,[]);assert.match(state.notice!,/حفظ الملاحظة مؤكد/);
  assert.equal(h.calls.filter(row=>row.post).length,1);assert.equal(await h.controller.save('private 1'),null);
  h.deps.list=async()=>({notes:[...h.rows],next_cursor:null});await h.controller.load();assert.equal(h.controller.getState().phase,'ready');assert.equal(h.controller.getState().notice,'تم تأكيد حفظ الملاحظة داخل فريق الدعم.');h.controller.dispose();
});
test('unknown private note result recovers after reopening without another POST',async()=>{
  const h=fixture();await h.controller.load();h.deps.send=async(body,key)=>{h.calls.push({post:key});h.rows.push({...note(),body});throw Error('lost acknowledgement');};
  assert.equal(await h.controller.save('private 1'),null);assert.equal(h.controller.getState().write.uncertain,true);assert.equal(h.stored(),id(90));h.controller.dispose();
  const reopened=createPrivateNotesController('ticket',h.deps);await reopened.load();assert.ok(await reopened.reconcile());assert.equal(reopened.getState().notes.length,1);assert.equal(h.calls.filter(row=>row.post).length,1);assert.equal(h.stored(),null);reopened.dispose();
});
test('denied private refresh clears protected notes; absent schema never enables a write',async()=>{
  const h=fixture();h.rows.push(note());await h.controller.load();h.deps.list=async()=>{throw new ApiRequestError('Not found',404);};await h.controller.load();assert.equal(h.controller.getState().phase,'denied');assert.deepEqual(h.controller.getState().notes,[]);h.controller.dispose();
  const missing=fixture();missing.deps.list=async()=>{throw new ApiRequestError('Unconfigured',503,'SUPPORT_NOTES_UNAVAILABLE');};await missing.controller.load();assert.equal(missing.controller.getState().phase,'unavailable');assert.equal(await missing.controller.save('private'),null);assert.ok(!missing.calls.some(row=>row.post));missing.controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`private notes never apply after ${fence}`,async()=>{
  const h=fixture(),pending=deferred();let signal:AbortSignal|undefined;h.deps.list=async(_before,cancel)=>{signal=cancel;return pending.promise;};const loading=h.controller.load();
  if(fence==='identity')h.identity('other');else if(fence==='event')h.controller.invalidate();else h.controller.dispose();
  pending.resolve({notes:[note()],next_cursor:null});await loading;assert.deepEqual(h.controller.getState().notes,[]);assert.equal(signal?.aborted,true);h.controller.dispose();
});
test('private paging is explicit, bounded, single flight and keeps retry cursor on overlap',async()=>{
  const h=fixture(),pending=deferred();let calls=0;h.deps.list=async(before)=>{calls++;if(!before)return{notes:Array.from({length:100},(_,n)=>note(n+10)),next_cursor:id(10)};return pending.promise;};
  await h.controller.load();const first=h.controller.loadOlder();await h.controller.loadOlder();assert.equal(calls,2);
  pending.resolve({notes:[note(10)],next_cursor:null});await first;assert.equal(h.controller.getState().nextCursor,id(10));assert.equal(h.controller.getState().notes.length,100);assert.ok(h.controller.getState().readError);h.controller.dispose();
});
test('private text validation happens before saving an attempt key or POST',async()=>{
  const h=fixture();await h.controller.load();assert.equal(await h.controller.save('   '),null);assert.equal(await h.controller.save('x'.repeat(10001)),null);assert.equal(h.stored(),null);assert.ok(!h.calls.some(row=>row.post));h.controller.dispose();
});
test('canonical private-note transport is separate from replies and preserves key, target and no-store',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];
  (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url,init});return new Response(JSON.stringify(init.method==='POST'||String(url).includes('/attempts/')?{note:note(),unchanged:false}:{notes:[note()],next_cursor:null}));};
  try{
    await getSupportPrivateNotes('ticket');await addSupportPrivateNote('ticket','private 1',id(90));await reconcileSupportPrivateNote('ticket',id(90));
    assert.deepEqual(calls.map(row=>row.url),['/api/support-tickets/ticket/private-notes','/api/support-tickets/ticket/private-notes',`/api/support-tickets/ticket/private-notes/attempts/${id(90)}`]);
    assert.equal(new Headers(calls[1].init.headers).get('Idempotency-Key'),id(90));assert.deepEqual(JSON.parse(calls[1].init.body),{body:'private 1'});
    assert.ok(calls.every(row=>row.init.cache==='no-store'&&new Headers(row.init.headers).get('Authorization')==='Bearer synthetic-token'));
  }finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
