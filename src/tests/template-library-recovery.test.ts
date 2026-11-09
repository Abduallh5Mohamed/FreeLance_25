import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiRequestError} from '../lib/api-http';
import {createTemplateLibrary,initialTemplateLibrary,templateLibraryIntentStore,type LibraryOperationKind} from '../features/catalog/lesson-package-templates';
const id=(n:number)=>`b4700000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function memory(){const map=new Map<string,string>();return{map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};}
function harness(kind:LibraryOperationKind,store=memory()){
 const revision=kind==='revise'?2:1,template={id:id(2),name:'Private name',status:kind==='archive'?'archived' as const:'active' as const,head_revision:revision};
 const outcome=()=>kind==='archive'?{template,unchanged:false}:{template,revision:{revision_number:revision,reference_count:1,media_count:1}};
 let principal='owner',event=()=>{},state=initialTemplateLibrary();
 const s={writes:0,reads:0,statusCalls:0,work:async():Promise<any>=>{throw Error('Lost ACK');},status:async():Promise<any>=>({operation_id:id(9),operation_kind:kind,...outcome(),...(kind==='revise'?{template_id:id(2)}:{})})};
 const c=createTemplateLibrary({intent:templateLibraryIntentStore(store,'owner',id(1)),readPrincipal:()=>principal,subscribeSession:fn=>{event=fn;return()=>{};},newOperationId:()=>id(9),list:async()=>{s.reads++;return{templates:[],nextCursor:null};},revisions:async()=>({revisions:[],nextCursor:null}),create:async()=>{s.writes++;return s.work();},revise:async()=>{s.writes++;return s.work();},archive:async()=>{s.writes++;return s.work();},status:async()=>{s.statusCalls++;return s.status();}});c.subscribe(x=>state=x);
 const write=()=>kind==='create'?c.create('Private name',id(3),[{kind:'material',source_id:id(4)}]):kind==='revise'?c.revise(id(2),1,id(3),[{kind:'material',source_id:id(4)}]):c.archive(id(2));
 return{c,s,write,outcome,store,state:()=>state,replace:()=>{principal='other';},event:()=>event()};
}
test('invalid local inputs never create an orphan recovery marker or issue a request',async()=>{
 const h=harness('create');await h.c.create(' ',id(3),[{kind:'material',source_id:id(4)}]);await h.c.create('Name',id(3),[]);await h.c.revise(id(2),2147483647,id(3),[{kind:'material',source_id:id(4)}]);await h.c.archive('invalid');assert.equal(h.s.writes,0);assert.equal(h.store.map.size,0);assert.equal(h.state().uncertain,false);assert.equal(h.state().operationId,null);h.c.dispose();
});
for(const kind of ['create','revise','archive'] as const)test(`${kind}: saved marker restores GET-only recovery after disposal without names or sources`,async()=>{
 const h=harness(kind);await h.write();assert.equal(h.s.writes,1);assert.equal(h.state().uncertain,true);assert.equal(h.store.map.size,1);assert.doesNotMatch([...h.store.map.values()][0],/Private|name|source|lesson|token/);h.c.dispose();
 const next=harness(kind,h.store);await next.c.refresh();await next.write();assert.equal(next.s.reads,0);assert.equal(next.s.writes,0);await next.c.recover();assert.equal(next.s.statusCalls,1);assert.equal(next.state().saved?.kind,kind);assert.equal(next.state().uncertain,false);assert.equal(next.store.map.size,0);next.c.dispose();
});
test('account/course isolation, exact marker shape and kind-specific bounds fail closed',()=>{
 const store=memory(),a=templateLibraryIntentStore(store,'owner',id(1));a.write({operation_id:id(9),operation_kind:'create',template_id:null,revision_number:1,reference_count:1,media_count:1});assert.equal(templateLibraryIntentStore(store,'other',id(1)).read(),null);assert.equal(templateLibraryIntentStore(store,'owner',id(7)).read(),null);
 for(const patch of [{revision_number:2},{reference_count:0},{media_count:2},{template_id:id(2)},{operation_kind:'foreign'},{token:'forbidden'}]){const bad={...a.read(),...patch};assert.throws(()=>a.write(bad as any));}
 const key=[...store.map.keys()][0];store.map.set(key,'{broken');const h=harness('create',store);assert.equal(h.state().uncertain,true);assert.equal(h.state().operationId,null);h.c.dispose();
});
test('storage refusal prevents POST; confirmed cleanup failure locks writes and preserves receipt through failed status',async()=>{
 const h=harness('create'),remove=h.store.removeItem,set=h.store.setItem;h.store.setItem=()=>{throw Error('storage');};await h.write();assert.equal(h.s.writes,0);h.store.setItem=set;h.s.work=async()=>h.outcome();h.store.removeItem=()=>{throw Error('cleanup');};await h.write();assert.equal(h.state().saved?.kind,'create');assert.equal(h.state().uncertain,true);await h.write();await h.c.refresh();assert.equal(h.s.writes,1);assert.equal(h.s.reads,0);h.s.status=async()=>{throw Error('status');};await h.c.recover();assert.equal(h.state().saved?.name,'Private name');assert.match(h.state().message??'',/الحفظ مؤكد/);h.store.removeItem=remove;h.s.status=async()=>({operation_id:id(9),operation_kind:'create',...h.outcome()});await h.c.recover();assert.equal(h.state().uncertain,false);assert.equal(h.store.map.size,0);h.c.dispose();
});
test('missing or mismatched receipt never clears intent, definite rejection clears only after successful cleanup',async()=>{
 const h=harness('revise');await h.write();for(const value of [null,{operation_id:id(8),operation_kind:'revise'},{operation_id:id(9),operation_kind:'archive'}, {operation_id:id(9),operation_kind:'revise',...h.outcome(),template_id:id(2),revision:{revision_number:9,reference_count:1,media_count:1}}]){h.s.status=async()=>value;await h.c.recover();assert.equal(h.state().uncertain,true);assert.equal(h.store.map.size,1);}h.c.dispose();
 const reject=harness('archive');reject.s.work=async()=>{throw new ApiRequestError('Conflict',409);};await reject.write();assert.equal(reject.state().uncertain,false);assert.equal(reject.store.map.size,0);reject.c.dispose();
});
test('deadline and replaced principal fence late ACK while leaving the original marker recoverable',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness('archive');let resolve!:(x:any)=>void;h.s.work=()=>new Promise(r=>resolve=r);const work=h.write();t.mock.timers.tick(25000);assert.equal(h.state().uncertain,true);resolve(h.outcome());await work;assert.equal(h.state().saved,null);assert.equal(h.store.map.size,1);h.replace();await h.c.recover();assert.equal(h.state().phase,'session-ended');assert.equal(h.state().saved,null);assert.equal(h.store.map.size,1);h.c.dispose();
});
