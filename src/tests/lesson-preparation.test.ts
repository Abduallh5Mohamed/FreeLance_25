import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreparation, initialPreparation, parsePreparation, preparationReader } from '../features/catalog/lesson-preparation';
const id=(n:number)=>`b3600000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={course_id:id(1),unit_id:id(2),lesson_id:id(3)};
const sample=()=>({context,checked_at:'2026-11-07T08:00:00.000Z',rule_version:'preparation-v1',learning_evidence:'insufficient',lesson:{title:'<script>private lesson</script>',status:'active',unit_status:'active',release_at:null},items:[{binding_id:id(10),kind:'material',title:'<script>source</script>',display_order:0,source_state:'draft',audience:'course',quiz_version:null,issue:'draft_source'}]});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve};};
test('strict preparation projection rejects foreign scope, private extras, invented learning claims and inconsistent rules',()=>{
  assert.equal(parsePreparation(sample(),context).items.length,1);
  for(const raw of [ {...sample(),student_id:id(99)}, {...sample(),context:{...context,lesson_id:id(99)}}, {...sample(),learning_evidence:'ready'}, {...sample(),items:[{...sample().items[0],issue:null}]}, {...sample(),items:[{...sample().items[0],file_url:'private'}]}, {...sample(),items:[...sample().items,...sample().items]}, {...sample(),checked_at:'bad'}, {...sample(),items:[{...sample().items[0],display_order:-1}]} ])assert.throws(()=>parsePreparation(raw,context));
});
function fixture(){let principal='A',event=()=>{},read:()=>Promise<any>=async()=>parsePreparation(sample(),context),latest=initialPreparation();let calls=0;
  const c=createPreparation({read:async()=>{calls++;return read();},readPrincipal:()=>principal,subscribeSession:fn=>{event=fn;return()=>{};}});c.subscribe(value=>latest=value);
  return{c,state:()=>latest,calls:()=>calls,setRead:(fn:()=>Promise<any>)=>read=fn,change:()=>principal='B',event:()=>event()};
}
test('evidence is re-read, stale removed references disappear and editorial choices are cleared on refresh',async()=>{
  const h=fixture();await h.c.refresh();h.c.decide(id(10),'use','Teacher correction');assert.equal(h.state().decisions[id(10)].note,'Teacher correction');
  h.setRead(async()=>parsePreparation({...sample(),items:[]},context));await h.c.openEvidence(id(10));assert.equal(h.calls(),2);assert.equal(h.state().evidenceId,null);assert.deepEqual(h.state().decisions,{});h.c.dispose();
});
for(const mode of ['principal','event','dispose'])test(`late preparation reply cannot restore data after ${mode}`,async()=>{
  const h=fixture(),d=deferred();h.setRead(()=>d.promise);const work=h.c.refresh();if(mode==='principal')h.change();if(mode==='event')h.event();if(mode==='dispose')h.c.dispose();d.resolve(parsePreparation(sample(),context));await work;assert.equal(h.state().data,null);h.c.dispose();
});
test('failed refresh removes previous private evidence and superseded requests cannot win',async()=>{
  const h=fixture();await h.c.refresh();h.setRead(async()=>{throw Error('read failed');});await h.c.refresh();assert.equal(h.state().phase,'error');assert.equal(h.state().data,null);
  const d=deferred();h.setRead(()=>d.promise);const first=h.c.refresh();h.setRead(async()=>parsePreparation({...sample(),items:[]},context));await h.c.refresh();d.resolve(parsePreparation(sample(),context));await first;assert.equal(h.state().data?.items.length,0);h.c.dispose();
});
test('read deadline does not retain stale evidence',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=fixture(),d=deferred();h.setRead(()=>d.promise);const work=h.c.refresh();t.mock.timers.tick(25000);assert.equal(h.state().phase,'error');d.resolve(parsePreparation(sample(),context));await work;assert.equal(h.state().data,null);h.c.dispose();
});

function find(n:any,p:(value:any)=>boolean):any{if(!n||typeof n!=='object')return null;if(p(n))return n;for(const child of [n.props?.children].flat(Infinity)){const v=find(child,p);if(v)return v;}return null;}
test('actual mounted panel reads canonical endpoint, opens fresh evidence, records only local decisions and hides on storage change',async()=>{
  const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,original=mod._load,file=require.resolve('../features/catalog/LessonPreparation.tsx');
  const prior={fetch:globalThis.fetch,storage:globalThis.localStorage,window:globalThis.window,React:(globalThis as any).React};
  const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[];let index=0,dirty=true;const calls:any[]=[],events:Function[]=[];
  (globalThis as any).React=React;(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic':key==='currentUser'?JSON.stringify({id:'owner',role:'instructor'}):null};
  (globalThis as any).window={addEventListener:(type:string,fn:Function)=>events.push(fn),removeEventListener:()=>{}};
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(sample()));};
  let Panel:any,tree:any;
  try{
    delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){
      if(request==='react'&&parent?.filename===file)return{...React,useState:(init:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof init==='function'?init():init;return[hooks[i],(v:any)=>{const value=typeof v==='function'?v(hooks[i]):v;if(value!==hooks[i]){hooks[i]=value;dirty=true;}}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++,before=hooks[i];if(!before||deps.some((v,j)=>v!==before[j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
      if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);return original.call(this,request,parent,main);
    };Panel=require(file).LessonPreparationPanel;mod._load=original;
    const settle=async()=>{for(let n=0;n<12;n++){if(dirty){index=0;dirty=false;tree=Panel({courseId:id(1),unitId:id(2),lessonId:id(3)});effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}return tree;};
    await settle();const html=require('react-dom/server').renderToStaticMarkup(tree);assert.match(html,/&lt;script&gt;source/);assert.match(html,/لا يكفي الدليل/);
    find(tree,n=>n.props?.children==='مفيد للتحضير').props.onClick();await settle();assert.equal(calls.length,1);
    find(tree,n=>n.props?.children?.[0]==='فتح الدليل الحالي: ').props.onClick();await settle();assert.equal(calls.length,2);assert.ok(find(tree,n=>n.props?.['aria-label']==='دليل التحضير الحالي'));
    assert.ok(calls.every(c=>c.url===`/api/tenants/me/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/preparation`&&!c.init.body&&c.init.cache==='no-store'));
    events.forEach(fn=>fn({key:'currentUser'}));await settle();assert.equal(find(tree,n=>n.props?.['aria-label']==='دليل التحضير الحالي'),null);assert.match(require('react-dom/server').renderToStaticMarkup(tree),/أُخفي/);
  }finally{cleanups.forEach(fn=>fn?.());mod._load=original;delete require.cache[file];globalThis.fetch=prior.fetch;(globalThis as any).localStorage=prior.storage;(globalThis as any).window=prior.window;(globalThis as any).React=prior.React;}
});
test('canonical reader rejects selectors and preserves private request transport',()=>{assert.throws(()=>preparationReader('bad',id(2),id(3)));});
