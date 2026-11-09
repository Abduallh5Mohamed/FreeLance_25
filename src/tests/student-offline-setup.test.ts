import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfflineSetup, initialOfflineSetup, offlineSetupStore, parseSetupReceipt, parseSetupReview} from '../features/students/offline-setup';
const id=(n:number)=>`b5100000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const selection={student_id:id(1),group_id:id(2),course_id:id(3)};
const review={student:{id:id(1),name:'Record'},group:{id:id(2),name:'Group',capacity:10,active_enrollments:2},course:{id:id(3),name:'Course'},effect:'offline_without_login' as const,review_token:'a'.repeat(64)};
const receipt={...selection,operation_id:id(4),state:'offline_configured' as const};
function fixture(){const values=new Map<string,string>();let principal:string|null='session-A',event=()=>{},state=initialOfflineSetup(),writes=0,reads=0;
 const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 const store=offlineSetupStore(storage,'account-A');
 const api={students:async()=>({items:[{id:id(1),name:'Record'}],next_cursor:null}),groups:async()=>({items:[{id:id(2),name:'Group',course_id:id(3),course_name:'Course'}],next_cursor:null}),review:async()=>review,
 apply:async()=>{writes++;return receipt;},status:async()=>{reads++;return receipt;}};
 const deps={api,store,principal:()=>principal,subscribe:(f:()=>void)=>{event=f;return()=>{};},newId:()=>id(4)};
 const create=()=>{const c=createOfflineSetup(deps);c.subscribe(s=>state=s);return c;};
 return{api,deps,store,storage,values,create,state:()=>state,writes:()=>writes,reads:()=>reads,change:()=>{principal='session-B';event();},prepare:async(c:ReturnType<typeof create>)=>{await c.load();c.choose(id(1),id(2));await c.review();assert.equal(state.phase,'reviewed');}};
}
test('strict review/receipt parsers reject foreign selection, extra account data and full capacity',()=>{
 assert.equal(parseSetupReview(review,selection),review);assert.equal(parseSetupReceipt(receipt),receipt);
 assert.throws(()=>parseSetupReview({...review,course:{id:id(9),name:'Other'}},selection));
 assert.throws(()=>parseSetupReview({...review,group:{...review.group,active_enrollments:10}},selection));
 assert.throws(()=>parseSetupReceipt({...receipt,password:'secret'}));
});
test('opaque recovery marker contains only IDs, rejects extra fields and isolates accounts',()=>{
 const h=fixture();h.store.write({...selection,operation_id:id(4)});assert.equal(h.values.size,1);const raw=[...h.values.values()][0];assert.equal(raw.includes('Record'),false);assert.equal(raw.includes('review_token'),false);
 assert.equal(offlineSetupStore(h.storage,'another-account').read(),null);assert.throws(()=>h.store.write({...selection,operation_id:id(4),name:'extra'} as any));
});
test('lost ACK survives controller recreation and GET-only recovery; no duplicate write',async()=>{
 const h=fixture(),c=h.create();await h.prepare(c);h.api.apply=async()=>{throw Error('lost acknowledgement');};await c.apply(true);assert.equal(h.state().phase,'uncertain');assert.equal(h.values.size,1);c.dispose();
 const restored=h.create();await restored.load();assert.equal(h.state().phase,'uncertain');await restored.apply(true);await restored.recover();assert.equal(h.reads(),1);assert.equal(h.state().phase,'saved');assert.equal(h.values.size,0);assert.equal(h.state().receipt?.student_id,id(1));restored.dispose();
});
test('confirmation, fresh selection and persistence are required before any write',async()=>{
 const h=fixture(),c=h.create();await h.prepare(c);await c.apply(false);assert.equal(h.writes(),0);c.choose(id(1),id(2));await c.apply(true);assert.equal(h.writes(),0);await c.review();
 h.deps.newId=()=>{throw Error('no crypto');};await c.apply(true);assert.equal(h.writes(),0);h.deps.newId=()=>id(4);h.store.write=()=>{throw Error('storage full');};await c.apply(true);assert.equal(h.writes(),0);assert.equal(h.state().phase,'reviewed');c.dispose();
});
test('confirmed save with cleanup failure remains visible and locked across failed recovery',async()=>{
 const h=fixture(),c=h.create();await h.prepare(c);h.store.clear=()=>{throw Error('storage denied');};await c.apply(true);assert.equal(h.state().phase,'uncertain');assert.equal(h.state().receipt?.state,'offline_configured');
 h.api.status=async()=>{throw Error('network');};await c.recover();assert.equal(h.state().receipt?.state,'offline_configured');await c.load();await c.apply(true);assert.equal(h.writes(),1);c.dispose();
});
test('missing or mismatched GET receipt never clears intent or unlocks writing',async()=>{
 for(const answer of [null,{...receipt,student_id:id(9)}]){const h=fixture();h.store.write({...selection,operation_id:id(4)});h.api.status=async()=>answer as any;const c=h.create();await c.recover();assert.equal(h.state().phase,'uncertain');assert.equal(h.values.size,1);assert.equal(h.writes(),0);c.dispose();}
});
test('session replacement hides all evidence and fences late responses',async()=>{
 const h=fixture(),c=h.create();await h.prepare(c);let resolve!:(x:typeof receipt)=>void;h.api.apply=()=>new Promise(r=>resolve=r);const work=c.apply(true);h.change();resolve(receipt);await work;assert.equal(h.state().phase,'session-ended');assert.equal(h.state().review,null);assert.equal(h.state().receipt,null);assert.equal(h.values.size,1);c.dispose();
});
test('deadline retains intent and ignores late success until explicit GET',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=fixture(),c=h.create();await h.prepare(c);let resolve!:(x:typeof receipt)=>void;h.api.apply=()=>new Promise(r=>resolve=r);const work=c.apply(true);t.mock.timers.tick(25000);assert.equal(h.state().phase,'uncertain');resolve(receipt);await work;assert.equal(h.state().receipt,null);await c.recover();assert.equal(h.state().phase,'saved');c.dispose();
});
