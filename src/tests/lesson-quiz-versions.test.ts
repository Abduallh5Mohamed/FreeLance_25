import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, readLessonQuizVersion, listLessonQuizVersions, pinLessonQuizVersion, unpinLessonQuizVersion } from '../lib/api-http';
import { createQuizVersionEditor, initialQuizVersionState, parseQuizPin, parseQuizVersions } from '../features/catalog/lesson-quiz-versions';
const id=(n:number)=>`c4000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const version=(n=6)=>({exam_version_id:id(n),version_number:n-5});
const pin=()=>({content_id:id(4),...version(),status:'published' as const});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
  const s={principal:'A',pin:null as any,failRead:false,calls:[] as any[],event:()=>{}};
  const deps={read:async(_signal:AbortSignal)=>{if(s.failRead)throw Error('read');return {pin:s.pin};},versions:async(cursor:string|null,_signal:AbortSignal)=>{s.calls.push({page:cursor});return {versions:[version()],next_cursor:null};},
    pin:async(value:string,_signal:AbortSignal)=>{s.calls.push({pin:value});s.pin=pin();return {pin:s.pin,unchanged:false};},unpin:async(value:string,_signal:AbortSignal)=>{s.calls.push({unpin:value});s.pin=null;return {detached:true,content_id:id(4)};},
    readPrincipal:()=>s.principal,subscribeSession:(fn:()=>void)=>{s.event=fn;return()=>{s.event=()=>{};};}};
  return {s,deps,controller:createQuizVersionEditor(id(4),deps)};
}
test('version/pin DTOs reject private extras, wrong content, unavailable ordinals and invalid pages',()=>{
  assert.equal(parseQuizPin({pin:pin()},id(4))!.version_number,1);
  for(const value of [{...pin(),correct_answers:[]},{...pin(),content_id:id(9)},{...pin(),status:'unavailable'},{...pin(),version_number:'1'}])assert.throws(()=>parseQuizPin({pin:value},id(4)));
  assert.throws(()=>parseQuizVersions({versions:[version(),version()],next_cursor:null},null));assert.throws(()=>parseQuizVersions({versions:[version()],next_cursor:id(6)},null));
  assert.throws(()=>parseQuizVersions({versions:[],next_cursor:id(6)},id(6)));
});
test('editor is inert initially and never auto-pins even a single available version',async()=>{
  const h=fixture();assert.equal(h.s.calls.length,0);assert.equal(await h.controller.pin(id(6)),false);await h.controller.refresh();assert.equal(h.controller.getState().phase,'ready');assert.equal(h.s.pin,null);assert.equal(await h.controller.pin(id(99)),false);assert.equal(h.s.calls.filter(call=>call.pin).length,0);h.controller.dispose();
});
test('pin is single flight and a pinned read does not require a candidate selector to remain available',async()=>{
  const h=fixture();await h.controller.refresh();const wait=deferred();h.deps.pin=async(value,_signal)=>{h.s.calls.push({pin:value});return wait.promise;};
  const saving=h.controller.pin(id(6));assert.equal(await h.controller.pin(id(6)),false);h.s.pin=pin();wait.resolve({pin:pin(),unchanged:false});assert.equal(await saving,true);assert.equal(h.controller.getState().pin!.exam_version_id,id(6));assert.equal(h.s.calls.filter(call=>call.page!==undefined).length,1);
  h.s.pin={...pin(),version_number:null,status:'unavailable'};h.deps.versions=async()=>{throw Error('source withdrawn');};await h.controller.refresh();assert.equal(h.controller.getState().phase,'ready');assert.equal(h.controller.getState().pin!.status,'unavailable');h.controller.dispose();
});
test('confirmed pin and failed read are distinguished; later refresh clears stale warning without another write',async()=>{
  const h=fixture();await h.controller.refresh();h.s.failRead=true;assert.equal(await h.controller.pin(id(6)),true);assert.match(h.controller.getState().notice!,/الحفظ مؤكد/);assert.equal(await h.controller.pin(id(6)),false);
  h.s.failRead=false;await h.controller.refresh();assert.ok(!h.controller.getState().notice!.includes('القائمة لم تتحدث'));assert.equal(h.s.calls.filter(call=>call.pin).length,1);h.controller.dispose();
});
for(const cause of ['uncertain','conflict','malformed'])test(`${cause} pin result prevents resubmission until an explicit fresh read`,async()=>{
  const h=fixture();await h.controller.refresh();h.deps.pin=async(value)=>{h.s.calls.push({pin:value});if(cause==='malformed')return {pin:{...pin(),exam_version_id:id(8)},unchanged:false};throw new ApiRequestError('write',cause==='conflict'?409:500,cause==='uncertain'?'PERSISTENCE_UNCERTAIN':undefined);};
  assert.equal(await h.controller.pin(id(6)),false);assert.equal(h.controller.getState().stale,true);assert.equal(await h.controller.pin(id(6)),false);assert.equal(h.s.calls.filter(call=>call.pin).length,1);h.controller.dispose();
});
for(const trigger of ['event','principal','dispose'])test(`late pin acknowledgement after ${trigger} cannot restore a private selection`,async()=>{
  const h=fixture();await h.controller.refresh();const wait=deferred();let signal:AbortSignal|undefined;h.deps.pin=async(_value,operation)=>{signal=operation;return wait.promise;};const saving=h.controller.pin(id(6));
  if(trigger==='event')h.s.event();else if(trigger==='principal')h.s.principal='B';else h.controller.dispose();wait.resolve({pin:pin(),unchanged:false});assert.equal(await saving,false);assert.equal(h.controller.getState().pin,null);assert.equal(signal!.aborted,true);h.controller.dispose();
});
test('unpin is restricted to the displayed exact version and never deletes an assessment',async()=>{
  const h=fixture();h.s.pin=pin();await h.controller.refresh();assert.equal(await h.controller.unpin(id(8)),false);assert.equal(await h.controller.unpin(id(6)),true);assert.equal(h.controller.getState().pin,null);assert.deepEqual(h.s.calls.filter(call=>call.unpin),[{unpin:id(6)}]);h.controller.dispose();
});
test('paging is explicit, single flight and does not advance after a malformed response',async()=>{
  const h=fixture();const rows=Array.from({length:25},(_,n)=>version(n+6));h.deps.versions=async()=>({versions:rows,next_cursor:id(30)}) as any;await h.controller.refresh();const wait=deferred();let calls=0;h.deps.versions=async(cursor)=>{calls++;assert.equal(cursor,id(30));return wait.promise;};
  const loading=h.controller.more();await h.controller.more();assert.equal(calls,1);wait.resolve({versions:[version()],next_cursor:null});await loading;assert.equal(h.controller.getState().cursor,id(30));h.controller.dispose();
});
test('canonical pin transports send only version identity and use pinned unpin URL with no-store auth',async()=>{
  const previousFetch=globalThis.fetch,previousStorage=globalThis.localStorage,calls:any[]=[];(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-login':null};globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response('{}');};
  try{await readLessonQuizVersion(id(1),id(2),id(3),id(4));await listLessonQuizVersions(id(1),id(2),id(3),id(4),null);await pinLessonQuizVersion(id(1),id(2),id(3),id(4),id(6));await unpinLessonQuizVersion(id(1),id(2),id(3),id(4),id(6));
    const base=`/api/tenants/me/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/activities/quiz/${id(4)}`;assert.deepEqual(calls.map(call=>call.url),[base+'/version',base+'/available-versions',base+'/version',base+'/version/'+id(6)]);assert.deepEqual(JSON.parse(calls[2].init.body),{exam_version_id:id(6)});assert.equal(calls[3].init.method,'DELETE');calls.forEach(call=>{assert.equal(call.init.cache,'no-store');assert.equal(new Headers(call.init.headers).get('Authorization'),'Bearer synthetic-login');});
  }finally{globalThis.fetch=previousFetch;(globalThis as any).localStorage=previousStorage;}
});
test('actual owner version editor opens with reads and its pin button posts the explicit version only',async()=>{
  const require=Module.createRequire(import.meta.url),React=require('react'),module=Module as any,original=module._load,file=require.resolve('../features/catalog/LessonQuizVersionManager.tsx');
  const previousReact=(globalThis as any).React,previousWindow=globalThis.window,previousStorage=globalThis.localStorage,previousFetch=globalThis.fetch;const effects:Function[]=[],snapshots:any[]=[],calls:any[]=[];let stored:any=null,cleanup:Function|undefined,index=0;
  (globalThis as any).React=React;(globalThis as any).window={addEventListener(){},removeEventListener(){}};(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-login':key==='currentUser'?JSON.stringify({id:'owner',role:'instructor'}):null};
  globalThis.fetch=async(url,init)=>{calls.push({url,init});if(init?.method==='POST'){stored=pin();return new Response(JSON.stringify({pin:stored,unchanged:false}));}return new Response(JSON.stringify(String(url).includes('available-versions')?{versions:[version()],next_cursor:null}:{pin:stored}));};
  try{delete require.cache[file];module._load=function(name:string,parent:any,main:boolean){if(name==='react'&&parent?.filename===file)return {...React,useState:()=>{const i=index++;return [i===0?{...initialQuizVersionState(),phase:'ready',stale:false,versions:[version()]}:i===1?id(6):false,(value:any)=>{snapshots[i]=value;}];},useRef:()=>({current:null}),useId:()=>'quiz-version',useEffect:(fn:Function)=>effects.push(fn)};if(name.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),name.slice(2)),parent,main);return original.call(this,name,parent,main);};
    const tree=require(file).LessonQuizVersionEditor({courseId:id(1),unitId:id(2),lessonId:id(3),contentId:id(4)});assert.match(require('react-dom/server').renderToStaticMarkup(tree),/لا يفتح محاولات الطالب/);assert.equal(calls.length,0);cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.filter(call=>call.init?.method==='POST').length,0);
    const find=(node:any):any=>{if(!node||typeof node!=='object')return null;if(node.props?.children==='تثبيت النسخة المختارة')return node;for(const child of [node.props?.children].flat(2)){const result=find(child);if(result)return result;}return null;};await find(tree).props.onClick();assert.equal(calls.filter(call=>call.init?.method==='POST').length,1);assert.deepEqual(JSON.parse(calls.find(call=>call.init?.method==='POST').init.body),{exam_version_id:id(6)});assert.equal(snapshots[0].pin.exam_version_id,id(6));require('../lib/session-events').notifySessionChange('scope');assert.equal(snapshots[0].pin,null);
  }finally{cleanup?.();module._load=original;delete require.cache[file];(globalThis as any).React=previousReact;(globalThis as any).window=previousWindow;(globalThis as any).localStorage=previousStorage;globalThis.fetch=previousFetch;}
});
