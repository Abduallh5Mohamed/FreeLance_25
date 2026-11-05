import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ApiRequestError,downloadStudentMaterialPdf} from '../lib/api-http';
import {createStudentLessonContentsController,initialStudentLessonContentsState,parseStudentLessonContents} from '../features/catalog/student-lesson-contents';
import {createPdfBrowserSaver} from '../features/catalog/pdf-browser-save';
const id=(n:number)=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const bytes=new TextEncoder().encode('%PDF-1.7\nfixture only\n%%EOF');
const row={content_id:id(1),title:'PDF الدرس',material_type:'pdf',display_order:0,delivery_status:'pdf_available'};
const response=(body:any=bytes,extra:Record<string,string>={})=>new Response(body,{headers:{'Content-Type':'application/pdf','Content-Length':String(bytes.length),
 'Content-Disposition':`attachment; filename="lesson-material-${id(4)}.pdf"`,...extra}});
async function transport(work:(setToken:(token:string)=>void,calls:any[])=>Promise<void>){
 const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage;let token='synthetic-A';const calls:any[]=[];
 (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?token:null};
 globalThis.fetch=async(url:any,init:any)=>{calls.push([url,init]);return response();};
 try{await work(value=>{token=value;},calls);}finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
}
test('canonical authenticated PDF fetch bounds/validates body and keeps bearer out of URL',async()=>transport(async(_setToken,calls)=>{
 const blob=await downloadStudentMaterialPdf(id(2),id(3),id(1));assert.equal(blob.type,'application/pdf');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
 assert.equal(calls[0][0],`/api/student-course-access/courses/${id(2)}/lessons/${id(3)}/contents/${id(1)}/file`);
 assert.equal(new Headers(calls[0][1].headers).get('Authorization'),'Bearer synthetic-A');assert.equal(calls[0][1].cache,'no-store');assert.ok(!calls[0][0].includes('synthetic'));
}));
for(const kind of ['mime','length','oversize','attachment','signature','short','overrun'] as const)test(`binary ${kind} response is refused before browser save`,async()=>transport(async()=>{
 globalThis.fetch=async()=>kind==='mime'?response(bytes,{'Content-Type':'text/html'}):kind==='length'?response(bytes,{'Content-Length':'NaN'}):kind==='oversize'?response(bytes,{'Content-Length':String(11*1024*1024)}):
  kind==='attachment'?response(bytes,{'Content-Disposition':'inline; filename="unsafe.html"'}):kind==='signature'?response(new Uint8Array(bytes.length)):
  kind==='short'?response(bytes.subarray(0,5)):response(new Uint8Array(bytes.length+1));
 await assert.rejects(()=>downloadStudentMaterialPdf(id(2),id(3),id(1)));
}));
test('post-header session change prevents private PDF exposure after body streaming',async()=>transport(async setToken=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;
 globalThis.fetch=async()=>response(new ReadableStream<Uint8Array>({start(controller){stream=controller;}}));
 const reading=downloadStudentMaterialPdf(id(2),id(3),id(1));await new Promise(resolve=>setImmediate(resolve));
 stream.enqueue(bytes.subarray(0,5));await new Promise(resolve=>setImmediate(resolve));setToken('synthetic-B');stream.enqueue(bytes.subarray(5));stream.close();
 await assert.rejects(()=>reading,/Session changed/);
}));
test('HTTP revocation/lock retains machine status without returning JSON as PDF',async()=>transport(async()=>{
 globalThis.fetch=async()=>new Response(JSON.stringify({code:'LESSON_LOCKED',error:'locked'}),{status:409});
 await assert.rejects(()=>downloadStudentMaterialPdf(id(2),id(3),id(1)),e=>e instanceof ApiRequestError&&e.code==='LESSON_LOCKED');
}));
function fixture(){
 let principal:string|null='student-A',event=()=>{};const saves:any[]=[],calls:any[]=[];
 const deps={list:async()=>({lesson_id:id(3),contents:[row]}),readPrincipal:()=>principal,subscribeSession:(fn:()=>void)=>{event=fn;return()=>{};},
  download:async(key:string,signal:AbortSignal):Promise<Blob>=>{calls.push({key,signal});return new Blob([bytes],{type:'application/pdf'});},save:(blob:Blob,key:string)=>{saves.push([blob,key]);}};
 const controller=createStudentLessonContentsController(id(3),deps);
 return{controller,deps,calls,saves,change:(value:string|null,notify=true)=>{principal=value;if(notify)event();}};
}
test('only PDF availability is accepted, with no grant implied for other material kinds',()=>{
 assert.equal(parseStudentLessonContents({lesson_id:id(3),contents:[row]},id(3))[0].delivery_status,'pdf_available');
 assert.throws(()=>parseStudentLessonContents({lesson_id:id(3),contents:[{...row,material_type:'video'}]},id(3)));
});
test('download is explicit, single flight and never records completion',async()=>{
 const h=fixture();await h.controller.load();assert.equal(h.calls.length,0);let resolve!:(value:Blob)=>void;
 h.deps.download=async(key,signal)=>{h.calls.push({key,signal});return new Promise(r=>{resolve=r;});};
 const first=h.controller.download(id(1));await h.controller.download(id(1));await h.controller.load();assert.equal(h.calls.length,1);
 resolve(new Blob([bytes],{type:'application/pdf'}));await first;assert.equal(h.saves.length,1);assert.equal(h.controller.getState().downloadingId,null);
 assert.match(h.controller.getState().downloadMessage!,/طلب التنزيل للمتصفح/);assert.match(h.controller.getState().downloadMessage!,/لا يُسجّل إتمام/);h.controller.dispose();
});
for(const gate of ['LESSON_LOCKED','MATERIAL_FILE_UNAVAILABLE','MATERIAL_FILE_CHANGED','foreign'] as const)test(`download ${gate} removes stale action without saving`,async()=>{
 const h=fixture();await h.controller.load();h.deps.download=async()=>{throw new ApiRequestError('denied',gate==='foreign'?404:gate==='LESSON_LOCKED'||gate==='MATERIAL_FILE_CHANGED'?409:503,gate);};
 await h.controller.download(id(1));assert.equal(h.saves.length,0);
 if(gate==='LESSON_LOCKED'||gate==='foreign')assert.equal(h.controller.getState().rows.length,0);else assert.equal(h.controller.getState().rows[0].delivery_status,'unavailable');h.controller.dispose();
});
for(const gate of ['event','silent','ABA','dispose'])test(`finished bytes cannot start a browser download after ${gate}`,async()=>{
 const h=fixture();await h.controller.load();let resolve!:(blob:Blob)=>void;let signal:AbortSignal|undefined;
 h.deps.download=async(_key,s)=>{signal=s;return new Promise(r=>{resolve=r;});};const downloading=h.controller.download(id(1));
 if(gate==='dispose')h.controller.dispose();else if(gate==='ABA'){h.change('B');h.change('student-A');}else h.change('B',gate!=='silent');
 resolve(new Blob([bytes],{type:'application/pdf'}));await downloading;assert.equal(h.saves.length,0);assert.equal(signal?.aborted,true);h.controller.dispose();
});
test('browser saver uses only a short-lived blob URL and UUID filename, cleaning on disposal',()=>{
 const originalDocument=globalThis.document,create=URL.createObjectURL,revoke=URL.revokeObjectURL;const revoked:string[]=[],anchors:any[]=[];
 (URL as any).createObjectURL=()=> 'blob:synthetic-private';(URL as any).revokeObjectURL=(url:string)=>revoked.push(url);
 (globalThis as any).document={body:{appendChild(){}},createElement(){const a:any={click(){a.clicked=true;},remove(){a.removed=true;}};anchors.push(a);return a;}};
 try{const saver=createPdfBrowserSaver();saver.save(new Blob([bytes],{type:'application/pdf'}),id(1));assert.equal(anchors[0].href,'blob:synthetic-private');assert.equal(anchors[0].download,`lesson-material-${id(1)}.pdf`);assert.equal(anchors[0].clicked,true);assert.equal(anchors[0].removed,true);saver.clear();assert.deepEqual(revoked,['blob:synthetic-private']);}
 finally{(globalThis as any).document=originalDocument;URL.createObjectURL=create;URL.revokeObjectURL=revoke;}
});
test('real student component offers download only for available PDF and dispatches its actual callback',async()=>{
 const require=Module.createRequire(import.meta.url),React=require('react'),internals=Module as any,original=internals._load,oldReact=(globalThis as any).React;
 const file=require.resolve('../features/catalog/StudentLessonMaterials.tsx');const clicked:string[]=[];
 (globalThis as any).React=React;
 try{delete require.cache[file];internals._load=function(name:string,parent:any,main:boolean){
  if(name==='react'&&parent?.filename===file)return{...React,useState:()=>[{...initialStudentLessonContentsState(),phase:'ready',rows:[row]},()=>{}],useEffect(){},useRef:()=>({current:{download:async(key:string)=>clicked.push(key)}})};
  if(name.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),name.slice(2)),parent,main);return original.call(this,name,parent,main);
 };
 const tree=require(file).StudentLessonMaterialList({courseId:id(2),lessonId:id(3)}),html=require('react-dom/server').renderToStaticMarkup(tree);
 assert.match(html,/تنزيل PDF/);assert.ok(!html.includes('href='));
 const walk=(x:any):any[]=>Array.isArray(x)?x.flatMap(walk):x?.props?[x,...walk(x.props.children)]:[];
 const button=walk(tree).find(x=>x.props.children==='تنزيل PDF');await button.props.onClick();assert.deepEqual(clicked,[id(1)]);
 }finally{internals._load=original;(globalThis as any).React=oldReact;delete require.cache[file];}
});
