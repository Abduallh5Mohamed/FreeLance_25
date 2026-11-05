import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, getOwnerMaterialFileStatus, uploadOwnerMaterialPdf, revokeOwnerMaterialPdf } from '../lib/api-http';
import { createOwnerPdfController, initialOwnerPdfState, parseOwnerPdfFile, parseOwnerPdfStatus, type OwnerPdfState } from '../features/catalog/material-pdf-upload';
const id=(n:number)=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const file=(state:'clean'|'pending'='clean')=>({file_id:id(1),material_id:id(2),size_bytes:21,upload_status:state==='clean'?'complete':'stored',scan_status:state,source_status:'active'});
const pdf=()=>new Blob(['%PDF-1.7\nfixture only'],{type:'application/pdf'});
function fixture(){
 let principal:string|null='owner-A',event=()=>{},requestIdCount=0;const calls:any[]=[];
 const deps={status:async(_signal:AbortSignal):Promise<unknown>=>{calls.push(['status']);return{file:null,capabilities:{upload:true,scan:true},retry_request_id:null};},
  upload:async(payload:Blob,requestId:string,_signal:AbortSignal):Promise<unknown>=>{calls.push(['upload',payload,requestId]);return{file:file(),unchanged:false};},
  revoke:async(_signal:AbortSignal):Promise<unknown>=>{calls.push(['revoke']);return{file:{...file(),source_status:'revoked'},unchanged:false};},
  readPrincipal:()=>principal,subscribeSession:(fn:()=>void)=>{event=fn;return()=>{calls.push(['unsubscribe']);};},makeRequestId:()=>{requestIdCount++;return id(9);}};
 const controller=createOwnerPdfController(id(2),deps);
 return{controller,deps,calls,keyCount:()=>requestIdCount,change:(value:string|null,notify=true)=>{principal=value;if(notify)event();}};
}
const deferred=()=>{let resolve!:(x:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return{promise,resolve};};
test('strict owner status rejects locator extras, coercible enums, wrong material and bogus retry readiness',()=>{
 assert.deepEqual(parseOwnerPdfFile(file(),id(2)),file());
 for(const value of [{...file(),object_key:'private'},{...file(),material_id:id(3)},{...file(),size_bytes:'20'},
  {...file(),upload_status:['complete']},{...file(),scan_status:['clean']},{...file(),source_status:['active']},
  {...file(),upload_status:'reserved'}])assert.throws(()=>parseOwnerPdfFile(value,id(2)));
 for(const value of [{file:file(),capabilities:{upload:true,scan:true},retry_request_id:id(9)},
  {file:null,capabilities:{upload:false,scan:true},retry_request_id:null},{file:null,capabilities:{upload:true,scan:true},retry_request_id:id(9)}])assert.throws(()=>parseOwnerPdfStatus(value,id(2)));
});
test('explicit load only; unconfigured owner state never sends upload',async()=>{
 const h=fixture();assert.equal(h.calls.length,0);h.deps.status=async()=>({file:null,capabilities:{upload:false,scan:false},retry_request_id:null});await h.controller.load();
 assert.equal(await h.controller.upload(pdf()),false);assert.equal(h.keyCount(),0);h.controller.dispose();
});
test('complete source blocks replacement; pending source needs an owner retry key',async()=>{
 for(const recorded of [file(),file('pending')]){const h=fixture();h.deps.status=async()=>({file:recorded,capabilities:{upload:true,scan:true},retry_request_id:null});await h.controller.load();
  assert.equal(await h.controller.upload(pdf()),false);assert.ok(!h.calls.some(c=>c[0]==='upload'));h.controller.dispose();}
});
test('invalid type, oversize, signature and missing file are rejected before any request',async()=>{
 const h=fixture();await h.controller.load();
 for(const blob of [null,new Blob(['not pdf'],{type:'application/pdf'}),new Blob(['%PDF-x'],{type:'text/html'}),new Blob(['%PDF-',new Uint8Array(10*1024*1024)],{type:'application/pdf'})])assert.equal(await h.controller.upload(blob),false);
 assert.ok(!h.calls.some(c=>c[0]==='upload'));assert.equal(h.keyCount(),0);h.controller.dispose();
});
test('unknown POST outcome blocks another write; explicit status read preserves the same idempotency key',async()=>{
 const h=fixture();await h.controller.load();h.deps.upload=async(payload,key)=>{h.calls.push(['upload',payload,key]);throw Error('network');};
 assert.equal(await h.controller.upload(pdf()),false);assert.equal(h.controller.getState().uncertain,true);assert.equal(await h.controller.upload(pdf()),false);
 await h.controller.load();h.deps.upload=async(payload,key)=>{h.calls.push(['upload',payload,key]);return{file:file(),unchanged:false};};
 assert.equal(await h.controller.upload(pdf()),true);const writes=h.calls.filter(c=>c[0]==='upload');assert.equal(writes.length,2);assert.equal(writes[0][2],writes[1][2]);assert.equal(h.keyCount(),1);h.controller.dispose();
});
test('reserved/stored attempt resumes from private owner status after reopening, using the original request key',async()=>{
 const h=fixture();h.deps.status=async()=>({file:file('pending'),capabilities:{upload:true,scan:true},retry_request_id:id(8)});await h.controller.load();
 assert.equal(await h.controller.upload(pdf()),true);assert.equal(h.calls.find(c=>c[0]==='upload')[2],id(8));assert.equal(h.keyCount(),0);h.controller.dispose();
});
test('confirmed pending scan is distinct from failed write; absent scanner prevents redundant reupload',async()=>{
 const h=fixture();h.deps.status=async()=>({file:null,capabilities:{upload:true,scan:false},retry_request_id:null});await h.controller.load();
 h.deps.upload=async()=>({file:file('pending'),unchanged:false});assert.equal(await h.controller.upload(pdf()),true);
 assert.match(h.controller.getState().notice!,/بانتظار الفحص/);assert.equal(h.controller.getState().uncertain,false);assert.equal(await h.controller.upload(pdf()),false);h.controller.dispose();
});
for(const ack of [{file:{...file(),material_id:id(3)},unchanged:false},{file:file(),success:true},{file:file(),unchanged:'false'},
 {file:{...file(),size_bytes:100},unchanged:false},{file:{...file(),source_status:'revoked'},unchanged:false}])test('malformed or wrong-target acknowledgement never becomes confirmed save',async()=>{
 const h=fixture();await h.controller.load();h.deps.upload=async()=>ack;assert.equal(await h.controller.upload(pdf()),false);assert.equal(h.controller.getState().notice,null);assert.equal(h.controller.getState().uncertain,true);h.controller.dispose();
});
test('upload is single flight through local signature validation and remote request',async()=>{
 const h=fixture();await h.controller.load();const pending=deferred();h.deps.upload=async(payload,key)=>{h.calls.push(['upload',payload,key]);return pending.promise;};
 const first=h.controller.upload(pdf());assert.equal(await h.controller.upload(pdf()),false);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.filter(c=>c[0]==='upload').length,1);
 pending.resolve({file:file(),unchanged:false});assert.equal(await first,true);h.controller.dispose();
});
for(const fence of ['event','silent','ABA','dispose'])test(`pending private response is fenced after ${fence}`,async()=>{
 const h=fixture();const pending=deferred();h.deps.status=async()=>pending.promise;const loading=h.controller.load();
 if(fence==='dispose')h.controller.dispose();else if(fence==='ABA'){h.change('B');h.change('owner-A');}else h.change('B',fence!=='silent');
 pending.resolve({file:file(),capabilities:{upload:true,scan:true},retry_request_id:null});await loading;assert.equal(h.controller.getState().file,null);h.controller.dispose();
});
test('authorization loss clears private state and does not classify a rejected upload as successful',async()=>{
 const h=fixture();await h.controller.load();h.deps.upload=async()=>{throw new ApiRequestError('Forbidden',403);};assert.equal(await h.controller.upload(pdf()),false);
 assert.equal(h.controller.getState().phase,'denied');assert.equal(h.controller.getState().file,null);assert.equal(h.controller.getState().notice,null);h.controller.dispose();
});
test('owner revocation confirms only matching source, then blocks repeat and upload',async()=>{
 const h=fixture();h.deps.status=async()=>({file:file(),capabilities:{upload:false,scan:false},retry_request_id:null});await h.controller.load();
 assert.equal(await h.controller.revoke(),true);assert.equal(h.controller.getState().file?.source_status,'revoked');
 assert.equal(await h.controller.revoke(),false);assert.equal(await h.controller.upload(pdf()),false);
 assert.equal(h.calls.filter(c=>c[0]==='revoke').length,1);h.controller.dispose();
});
test('uncertain revocation requires status reconciliation and fences stale session response',async()=>{
 const h=fixture();h.deps.status=async()=>({file:file(),capabilities:{upload:true,scan:true},retry_request_id:null});await h.controller.load();
 h.deps.revoke=async()=>{throw Error('network');};assert.equal(await h.controller.revoke(),false);assert.equal(h.controller.getState().uncertain,true);
 assert.equal(await h.controller.revoke(),false);await h.controller.load();assert.equal(h.controller.getState().uncertain,false);
 const pending=deferred();h.deps.revoke=async()=>pending.promise;const request=h.controller.revoke();h.change('B');
 pending.resolve({file:{...file(),source_status:'revoked'},unchanged:false});assert.equal(await request,false);assert.equal(h.controller.getState().file,null);h.controller.dispose();
});
test('malformed revocation receipt cannot confirm a withdrawal',async()=>{
 const h=fixture();h.deps.status=async()=>({file:file(),capabilities:{upload:true,scan:true},retry_request_id:null});await h.controller.load();
 h.deps.revoke=async()=>({file:{...file(),file_id:id(7),source_status:'revoked'},unchanged:false});
 assert.equal(await h.controller.revoke(),false);assert.equal(h.controller.getState().uncertain,true);h.controller.dispose();
});
test('canonical HTTP POST is raw PDF with bearer/idempotency key; GET carries no source selector',async()=>{
 const originalFetch=globalThis.fetch,originalStorage=globalThis.localStorage;const calls:any[]=[];const payload=pdf();
 (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};globalThis.fetch=async(url:any,init:any)=>{calls.push([url,init]);return new Response('{}');};
 try{await getOwnerMaterialFileStatus(id(3),id(4),id(5),id(6));await uploadOwnerMaterialPdf(id(3),id(4),id(5),id(6),payload,id(9));await revokeOwnerMaterialPdf(id(3),id(4),id(5),id(6));
  const base=`/api/tenants/me/catalog/courses/${id(3)}/units/${id(4)}/lessons/${id(5)}/contents/${id(6)}/file`;
  assert.deepEqual(calls.map(c=>c[0]),[base,base,base]);const headers=new Headers(calls[1][1].headers);assert.equal(headers.get('Content-Type'),'application/pdf');assert.equal(headers.get('Idempotency-Key'),id(9));assert.equal(headers.get('Authorization'),'Bearer synthetic-token');
  assert.equal(calls[2][1].method,'DELETE');assert.equal(calls[2][1].body,undefined);
  assert.equal(calls[1][1].body,payload);assert.equal(calls[0][1].body,undefined);assert.ok(calls.every(c=>c[1].cache==='no-store'));
 }finally{globalThis.fetch=originalFetch;(globalThis as any).localStorage=originalStorage;}
});

function render(state?:OwnerPdfState,effects?:(()=>()=>void)[],onSnapshot?:(s:OwnerPdfState)=>void){
 const require=Module.createRequire(import.meta.url),React=require('react'),internals=Module as any,original=internals._load,previous=(globalThis as any).React;
 const filePath=require.resolve('../features/catalog/OwnerMaterialPdfManager.tsx');let index=0;(globalThis as any).React=React;
 try{delete require.cache[filePath];internals._load=function(name:string,parent:any,main:boolean){
  if(name==='react'&&parent?.filename===filePath)return{...React,useState:state?()=>{const slot=index++;return[slot===0?state:null,(s:any)=>{if(slot===0)onSnapshot?.(s);}];}:()=>[false,()=>{}],
   useEffect:(fn:()=>()=>void)=>{effects?.push(fn);},useRef:()=>({current:null}),useId:()=> 'pdf-file-input'};
  if(name.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),name.slice(2)),parent,main);return original.call(this,name,parent,main);
 };
 const module=require(filePath),tree=(state?module.OwnerMaterialPdfEditor:module.OwnerMaterialPdfManager)({courseId:id(3),unitId:id(4),lessonId:id(5),contentId:id(6),materialId:id(2)});
 return require('react-dom/server').renderToStaticMarkup(tree) as string;
 }finally{internals._load=original;(globalThis as any).React=previous;delete require.cache[filePath];}
}
test('real panel is collapsed, owner editor labels pending honestly, and unconfigured state has no upload form',()=>{
 assert.match(render(),/إدارة ملف PDF الخاص/);assert.ok(!render().includes('<form'));
 const disabled=render({...initialOwnerPdfState(),phase:'ready'});assert.match(disabled,/غير مهيأ/);assert.ok(!disabled.includes('<form'));
 const pending=render({...initialOwnerPdfState(),phase:'ready',uploadConfigured:true,scanConfigured:false,file:file('pending') as any,retryable:true});
 assert.match(pending,/بانتظار الفحص/);assert.match(pending,/for="pdf-file-input"/);assert.match(pending,/dir="rtl"/);assert.match(pending,/disabled=""/);
 assert.match(pending,/سحب إتاحة ملف PDF/);
 assert.ok(!render({...initialOwnerPdfState(),phase:'ready',file:{...file(),source_status:'revoked'} as any}).includes('سحب إتاحة ملف PDF'));
});
test('real editor effect wires actual controller and transport, then invalidates through its session instance',async()=>{
 const require=Module.createRequire(import.meta.url),oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,oldWindow=globalThis.window;
 const calls:string[]=[],events=new Set<unknown>();let snapshot=initialOwnerPdfState(),cleanup:(()=>void)|undefined;
 (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':key==='currentUser'?JSON.stringify({id:'synthetic-owner',role:'instructor'}):null};
 (globalThis as any).window={addEventListener:(_:string,fn:unknown)=>events.add(fn),removeEventListener:(_:string,fn:unknown)=>events.delete(fn)};
 globalThis.fetch=async(url:any)=>{calls.push(String(url));return new Response(JSON.stringify({file:null,capabilities:{upload:false,scan:false},retry_request_id:null}));};
 try{const effects:(()=>()=>void)[]=[];render(initialOwnerPdfState(),effects,s=>{snapshot=s;});assert.equal(calls.length,0);cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(snapshot.phase,'ready');assert.equal(snapshot.uploadConfigured,false);assert.equal(calls[0],`/api/tenants/me/catalog/courses/${id(3)}/units/${id(4)}/lessons/${id(5)}/contents/${id(6)}/file`);
  require('../lib/session-events').notifySessionChange('scope');assert.equal(snapshot.phase,'session-ended');assert.equal(snapshot.file,null);cleanup();cleanup=undefined;assert.equal(events.size,0);
 }finally{cleanup?.();globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;(globalThis as any).window=oldWindow;}
});
