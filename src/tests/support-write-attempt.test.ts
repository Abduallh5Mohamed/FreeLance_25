import assert from 'node:assert/strict';
import test from 'node:test';
import {createSupportAttempt} from '../features/support/write-attempt';
import {parseSupportTicketWrite,parseSupportReplyWrite} from '../features/support/write-result';
import {createSupportTicket,replyToSupportTicket,reconcileSupportTicket,reconcileSupportReply,ApiRequestError} from '../lib/api-http';
const key='a1000000-0000-4000-8000-000000000001';
const deferred=()=>{let resolve!:(x:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
function fixture(saved:string|null=null){
  let identity='owner',stored=saved,made=0;const calls:any[]=[];
  const deps={readKey:()=>stored,saveKey:(value:string)=>{stored=value;},clearKey:()=>{stored=null;},makeKey:()=>{made++;return key;},readIdentity:()=>identity,
    send:async(payload:any,requestId:string,signal:AbortSignal):Promise<any>=>{calls.push({payload,key:requestId,signal});return{confirmed:true};},
    reconcile:async(requestId:string,_signal:AbortSignal):Promise<any>=>{calls.push({check:requestId});return{confirmed:true};}};
  const controller=createSupportAttempt<any,any>(deps);
  return {controller,deps,calls,stored:()=>stored,made:()=>made,identity:(value:string)=>{identity=value;}};
}
test('support attempt persists a key before one request and prevents same-tick duplicate',async()=>{
  const h=fixture(),pending=deferred();h.deps.send=async(payload,requestId,signal)=>{assert.equal(h.stored(),key);h.calls.push({payload,key:requestId,signal});return pending.promise;};
  const first=h.controller.send({body:'synthetic'});assert.equal(await h.controller.send({body:'synthetic'}),null);assert.equal(h.calls.length,1);
  pending.resolve({confirmed:true});assert.deepEqual(await first,{confirmed:true});assert.equal(h.stored(),null);h.controller.dispose();
});
test('unknown response freezes payload and retains exactly the same key across explicit retry',async()=>{
  const h=fixture();h.deps.send=async(payload,requestId)=>{h.calls.push({payload,key:requestId});throw Error('lost response');};
  assert.equal(await h.controller.send({body:'synthetic'}),null);assert.equal(h.controller.getState().uncertain,true);assert.equal(h.controller.getState().locked,true);
  assert.equal(await h.controller.send({body:'changed'}),null);assert.equal(h.calls.length,1);
  h.deps.send=async(payload,requestId)=>{h.calls.push({payload,key:requestId});return{confirmed:true};};
  assert.deepEqual(await h.controller.send({body:'synthetic'}),{confirmed:true});assert.deepEqual(h.calls.map(row=>row.key),[key,key]);assert.equal(h.made(),1);h.controller.dispose();
});
test('reopening recovers only an opaque key; missing receipt does not authorize a new key',async()=>{
  const h=fixture(key);assert.equal(h.controller.getState().uncertain,true);assert.equal(h.controller.getState().locked,false);
  h.deps.reconcile=async()=>{throw new ApiRequestError('Not found',404,'SUPPORT_ATTEMPT_NOT_FOUND');};
  assert.equal(await h.controller.reconcile(),null);assert.equal(h.stored(),key);assert.equal(h.controller.getState().blocked,false);
  await h.controller.send({body:'reentered original'});assert.equal(h.calls[0].key,key);assert.equal(h.made(),0);h.controller.dispose();
});
test('confirmed reconciliation clears the saved key without sending another write',async()=>{
  const h=fixture(key);assert.deepEqual(await h.controller.reconcile(),{confirmed:true});assert.deepEqual(h.calls,[{check:key}]);assert.equal(h.stored(),null);h.controller.dispose();
});
test('storage failure prevents request; cleanup failure preserves confirmed success',async()=>{
  const h=fixture();h.deps.saveKey=()=>{throw Error('storage unavailable');};assert.equal(await h.controller.send({body:'synthetic'}),null);assert.equal(h.calls.length,0);assert.equal(h.controller.getState().uncertain,false);
  const saved=fixture();saved.deps.clearKey=()=>{throw Error('cannot clear');};assert.deepEqual(await saved.controller.send({body:'synthetic'}),{confirmed:true});assert.equal(saved.controller.getState().uncertain,false);assert.equal(saved.controller.getState().blocked,true);
  h.controller.dispose();saved.controller.dispose();
});
for(const fence of ['identity','ABA','dispose'] as const)test(`support attempt cannot confirm after ${fence}`,async()=>{
  const h=fixture(),pending=deferred();let signal:AbortSignal|undefined;
  h.deps.send=async(_payload,_key,cancel)=>{signal=cancel;return pending.promise;};const first=h.controller.send({body:'synthetic'});
  if(fence==='identity')h.identity('other');else if(fence==='ABA'){h.controller.invalidate();h.identity('other');h.identity('owner');}else h.controller.dispose();
  pending.resolve({confirmed:true});assert.equal(await first,null);assert.equal(h.stored(),key);assert.equal(signal?.aborted,true);h.controller.dispose();
});
test('timeout aborts transport but preserves request key for reconciliation',async()=>{
  const h=fixture();const controller=createSupportAttempt({...h.deps,timeoutMs:5,send:async(_body:any,_key:string,signal:AbortSignal)=>{h.calls.push({signal});return new Promise(()=>{});}});
  assert.equal(await controller.send({body:'synthetic'}),null);assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.stored(),key);assert.equal(controller.getState().uncertain,true);controller.dispose();h.controller.dispose();
});
test('lost ticket authority retires the attempt while retaining its opaque recovery key',async()=>{
  const h=fixture(key);let denied=0;
  const controller=createSupportAttempt({...h.deps,onDenied:()=>{denied++;},reconcile:async()=>{throw new ApiRequestError('Ticket not found',404,'SUPPORT_TICKET_NOT_FOUND');}});
  assert.equal(await controller.reconcile(),null);assert.equal(denied,1);assert.equal(controller.getState().blocked,true);assert.equal(h.stored(),key);controller.dispose();h.controller.dispose();
});
const ticket={id:key,ticket_number:'SUP-202611-TEST',user_id:'owner',category:'technical',subject:'Synthetic issue',description:'Synthetic description',status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z'};
const reply={id:key,body:'Synthetic reply',sender_id:'owner',sender_name:'Owner',sender_role:'student',created_at:'2026-11-05T10:00:00Z'};
test('support acknowledgement parsers reject private extras, wrong target and missing confirmed flags',()=>{
  assert.equal(parseSupportTicketWrite({ticket,unchanged:false}).ticket.id,key);
  assert.throws(()=>parseSupportTicketWrite({ticket:{...ticket,user_phone:'private'},unchanged:false}));
  assert.throws(()=>parseSupportReplyWrite({reply,ticket_id:'foreign',ticket_status:'open',unchanged:false},key));
  assert.throws(()=>parseSupportReplyWrite({reply,ticket_id:key,ticket_status:'open'},key));
});
test('canonical support writes and reconciliation preserve headers, target and no-store transport',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];
  (globalThis as any).localStorage={getItem:(name:string)=>name==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url,init});return new Response(JSON.stringify(String(url).includes('reply/')||String(url).endsWith('/replies')
    ?{reply,ticket_id:key,ticket_status:'waiting_on_support',unchanged:false}:{ticket,unchanged:false}));};
  try{
    await createSupportTicket({category:'technical',subject:ticket.subject,description:ticket.description},key);
    await replyToSupportTicket(key,reply.body,key);await reconcileSupportTicket(key);await reconcileSupportReply(key,key);
    assert.equal(calls.length,4);assert.ok(calls.slice(0,2).every(row=>row.init.method==='POST'&&new Headers(row.init.headers).get('Idempotency-Key')===key));
    assert.ok(calls.every(row=>new Headers(row.init.headers).get('Authorization')==='Bearer synthetic-token'&&row.init.cache==='no-store'));
    assert.ok(calls.slice(2).every(row=>!row.init.body&&row.url.includes('/attempts/')));
  }finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
