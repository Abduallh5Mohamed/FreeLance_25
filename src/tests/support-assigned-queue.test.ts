import assert from 'node:assert/strict';
import test from 'node:test';
import {createAssignedQueue,parseAssignedPage} from '../features/support/assigned-queue';
import {getAssignedSupportTickets,ApiRequestError} from '../lib/api-http';
const row=(n=1)=>({id:`ticket-${n}`,ticket_number:`SUP-${n}`,subject:`Assigned ${n}`,category:'technical',status:'open',priority:'normal',created_at:'2026-11-05T10:00:00.000Z',updated_at:'2026-11-05T10:00:00.000Z'});
const page=(n=1)=>({tickets:[row(n)],next_cursor:null});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){let identity='admin';const calls:any[]=[];const deps={readIdentity:()=>identity,read:async(after:string|null,_signal:AbortSignal):Promise<any>=>{calls.push(after);return page();}};
  return {deps,calls,identity:(value:string)=>{identity=value;},controller:createAssignedQueue(deps)};
}
test('assigned DTO is fixed and rejects private extras, duplicate rows, coercible enums and bad dates/cursors',()=>{
  assert.equal(parseAssignedPage(page()).tickets.length,1);
  for(const value of [{...page(),assigned_to:'forged'},{tickets:[{...row(),phone:'private'}],next_cursor:null},{tickets:[row(),row()],next_cursor:null},{tickets:[{...row(),status:['open']}],next_cursor:null},
    {tickets:[{...row(),created_at:'not a date'}],next_cursor:null},{tickets:[row()],next_cursor:'ticket-1'}])assert.throws(()=>parseAssignedPage(value));
});
test('queue reads only explicitly, is single-flight and exposes selection only from its verified current page',async()=>{
  const h=fixture(),wait=deferred();assert.equal(h.calls.length,0);h.deps.read=async after=>{h.calls.push(after);return wait.promise;};
  const first=h.controller.refresh();await h.controller.refresh();assert.equal(h.calls.length,1);assert.equal(h.controller.select('ticket-1'),null);wait.resolve(page());await first;
  assert.equal(h.controller.select('foreign'),null);assert.equal(h.controller.select('ticket-1')?.subject,'Assigned 1');h.controller.dispose();
});
test('refresh immediately hides stale rows and failed refresh never describes an obsolete list as current',async()=>{
  const h=fixture();await h.controller.refresh();const wait=deferred();h.deps.read=async()=>wait.promise;const updating=h.controller.refresh();assert.equal(h.controller.getState().tickets.length,0);assert.equal(h.controller.select('ticket-1'),null);
  wait.resolve({bad:'response'});await updating;assert.equal(h.controller.getState().phase,'error');assert.equal(h.controller.getState().tickets.length,0);assert.ok(h.controller.getState().error);h.controller.dispose();
});
test('assignment activity retires an older list read; completion refresh does not restore transferred rows',async()=>{
  const h=fixture(),wait=deferred();h.deps.read=async()=>wait.promise;const first=h.controller.refresh();h.controller.suspend();assert.equal(h.controller.getState().phase,'suspended');
  h.deps.read=async()=>({tickets:[],next_cursor:null});await h.controller.refresh();wait.resolve(page());await first;assert.equal(h.controller.getState().tickets.length,0);assert.equal(h.controller.getState().phase,'ready');h.controller.dispose();
});
test('keyset paging is single-flight, rejects overlap and preserves a failed next-page cursor',async()=>{
  const h=fixture(),wait=deferred(),rows=Array.from({length:25},(_,n)=>row(n));let calls=0;
  h.deps.read=async after=>{calls++;return after?wait.promise:{tickets:rows,next_cursor:rows[24].id};};await h.controller.refresh();const more=h.controller.more();await h.controller.more();assert.equal(calls,2);
  wait.resolve(page(0));await more;assert.equal(h.controller.getState().tickets.length,25);assert.equal(h.controller.getState().nextCursor,rows[24].id);assert.ok(h.controller.getState().error);h.controller.dispose();
});
test('successful next-page append does not issue mutations or lose the last page',async()=>{
  const h=fixture(),rows=Array.from({length:25},(_,n)=>row(n));h.deps.read=async after=>after?page(30):{tickets:rows,next_cursor:rows[24].id};
  await h.controller.refresh();await h.controller.more();assert.equal(h.controller.getState().tickets.length,26);assert.equal(h.controller.getState().nextCursor,null);h.controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`assigned response and actions are fenced after ${fence}`,async()=>{
  const h=fixture(),wait=deferred();let signal:AbortSignal|undefined;h.deps.read=async(_after,cancel)=>{signal=cancel;return wait.promise;};const loading=h.controller.refresh();
  if(fence==='identity')h.identity('other');else if(fence==='event')h.controller.invalidate();else h.controller.dispose();wait.resolve(page());await loading;
  assert.equal(h.controller.getState().tickets.length,0);assert.equal(h.controller.select('ticket-1'),null);assert.equal(signal?.aborted,true);h.controller.dispose();
});
test('permission revocation and missing schema clear rows, and silent identity change prevents opening old rows',async()=>{
  const h=fixture();await h.controller.refresh();h.deps.read=async()=>{throw new ApiRequestError('Denied',404);};await h.controller.more();await h.controller.refresh();assert.equal(h.controller.getState().phase,'denied');assert.equal(h.controller.getState().tickets.length,0);h.controller.dispose();
  const missing=fixture();await missing.controller.refresh();missing.deps.read=async()=>{throw new ApiRequestError('Unavailable',503,'SUPPORT_ASSIGNED_UNAVAILABLE');};await missing.controller.refresh();assert.equal(missing.controller.getState().phase,'unavailable');assert.equal(missing.controller.getState().tickets.length,0);missing.controller.dispose();
  const silent=fixture();await silent.controller.refresh();silent.identity('other');assert.equal(silent.controller.select('ticket-1'),null);assert.equal(silent.controller.getState().tickets.length,0);silent.controller.dispose();
});
test('canonical assigned API sends only an optional cursor, bearer and no-store without an actor selector',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url,init});return new Response(JSON.stringify(page()));};
  try{await getAssignedSupportTickets();await getAssignedSupportTickets('ticket-1');assert.deepEqual(calls.map(row=>row.url),['/api/support-tickets/assigned','/api/support-tickets/assigned?after=ticket-1']);
    assert.ok(calls.every(row=>row.init.cache==='no-store'&&new Headers(row.init.headers).get('Authorization')==='Bearer synthetic-token'&&!row.init.body&&(!row.init.method||row.init.method==='GET')));
  }finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
