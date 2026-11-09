import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReturnPlan,initialReturn,parseReturnEvidence,returnPlanTransport,validateReturnInput, type ReturnInput, type ReturnEvidence} from '../features/catalog/course-return-plan';
const id=(n:number)=>`b3800000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input=():ReturnInput=>({enrollment_id:'enrollment-one',from:'2026-11-01T00:00:00.000Z',to:'2026-11-07T00:00:00.000Z',steps:[]});
const sample=(i=input(),reviewed=false):ReturnEvidence=>({context:{course_id:id(1),enrollment_id:i.enrollment_id,from:i.from,to:i.to},checked_at:'2026-11-07T10:00:00.000Z',student:{name:'<script>student</script>'},attendance:[{session_id:id(40),title:'session',starts_at:'2026-11-02T10:00:00.000Z',state:'excused'}],lessons:Array.from({length:4},(_,n)=>({lesson_id:id(n+10),title:'<script>lesson '+n+'</script>',completed:false,block:null})),steps:i.steps.map(s=>({...s,title:'<script>lesson '+(Number(s.lesson_id.slice(-2))-10)+'</script>'})),review_token:i.steps.length?'a'.repeat(64):null,reviewed,delivery:'not_sent',persistence:{status:'unavailable',current:null}});
const deferred=()=>{let resolve!:(x:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{resolve,promise};};
function fixture(){let principal='A',event=()=>{},state=initialReturn(),read:(i:ReturnInput)=>Promise<any>=async i=>sample(i);const calls:string[]=[];
 const c=createReturnPlan({roster:async()=>{calls.push('roster');return{students:[{enrollment_id:'enrollment-one',name:'student'}],nextCursor:'next'};},preview:async i=>{calls.push('preview');return read(i);},review:async(i,token)=>{calls.push('review');assert.equal(token,'a'.repeat(64));return sample(i,true);},readPrincipal:()=>principal,subscribeSession:fn=>{event=fn;return()=>{};}});c.subscribe(x=>state=x);
 return{c,state:()=>state,calls,setRead:(fn:typeof read)=>read=fn,event:()=>event(),changeIdentity:()=>principal='B'};
}
test('return input/DTO rejects forged context, private extras, wrong steps and false delivery',()=>{
 const i=input();assert.equal(parseReturnEvidence(sample(),id(1),i,false).attendance[0].state,'excused');
 for(const raw of [{...sample(),student:{name:'student',phone:'private'}},{...sample(),context:{...sample().context,enrollment_id:'other'}},{...sample(),delivery:'sent'},{...sample(),reviewed:true},{...sample(),attendance:[{...sample().attendance[0],state:'risk'}]},{...sample(),lessons:[{...sample().lessons[0],completed:'false'}]}])assert.throws(()=>parseReturnEvidence(raw,id(1),i,false));
 assert.throws(()=>validateReturnInput({...i,to:i.from}));assert.throws(()=>validateReturnInput({...i,steps:[{lesson_id:id(10),minutes:1.5}]}));
});
test('loaded student, at most three selected steps, explicit durations and current preview precede review',async()=>{
 const h=fixture();await h.c.review();assert.deepEqual(h.calls,[]);await h.c.first();h.c.change('enrollment-one',input().from,input().to);await h.c.load();
 h.c.choose(id(10));h.c.choose(id(11));h.c.choose(id(12));h.c.choose(id(13));assert.equal(h.state().steps.length,3);h.c.duration(id(10),'12abc');assert.equal(h.state().steps[0].minutes,null);h.c.duration(id(10),'15');assert.equal(h.state().steps[0].minutes,15);
 await h.c.review();assert.ok(!h.calls.includes('review'));await h.c.preview();await h.c.review();assert.equal(h.state().preview?.reviewed,true);h.c.duration(id(10),'');assert.equal(h.state().preview,null);assert.equal(h.state().steps[0].minutes,null);h.c.dispose();
});
test('student/date/page change clears evidence and reviewed draft; unknown student never queries',async()=>{
 const h=fixture();await h.c.first();h.c.change('other',input().from,input().to);await h.c.load();assert.deepEqual(h.calls,['roster']);
 h.c.change('enrollment-one',input().from,input().to);await h.c.load();h.c.choose(id(10));await h.c.preview();h.c.change('enrollment-one',input().from,'');assert.equal(h.state().data,null);assert.equal(h.state().preview,null);assert.deepEqual(h.state().steps,[]);await h.c.next();assert.equal(h.state().enrollmentId,'');h.c.dispose();
});
for(const mode of ['principal','event','dispose','selection'])test(`late draft cannot restore private context after ${mode}`,async()=>{
 const h=fixture(),d=deferred();await h.c.first();h.c.change('enrollment-one',input().from,input().to);h.setRead(()=>d.promise);const work=h.c.load();
 if(mode==='principal')h.changeIdentity();if(mode==='event')h.event();if(mode==='dispose')h.c.dispose();if(mode==='selection')h.c.change('',input().from,input().to);
 d.resolve(sample());await work;assert.equal(h.state().data,null);h.c.dispose();
});
test('error/deadline clears preview and current evidence instead of reporting a saved plan',async t=>{
 const h=fixture();await h.c.first();h.c.change('enrollment-one',input().from,input().to);await h.c.load();h.setRead(async()=>{throw Error('changed');});await h.c.load();assert.equal(h.state().data,null);assert.equal(h.state().phase,'error');
 t.mock.timers.enable({apis:['setTimeout']});const d=deferred();h.setRead(()=>d.promise);const work=h.c.load();t.mock.timers.tick(25000);assert.equal(h.state().phase,'error');d.resolve(sample());await work;assert.equal(h.state().preview,null);h.c.dispose();
});
function find(n:any,p:(n:any)=>boolean):any{if(!n||typeof n!=='object')return null;if(p(n))return n;for(const child of [n.props?.children].flat(Infinity)){const result=find(child,p);if(result)return result;}return null;}
test('actual mounted return plan selects evidence, previews steps and explicitly rechecks review through canonical HTTP',async()=>{
 const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,original=mod._load,file=require.resolve('../features/catalog/CourseReturnPlan.tsx');
 const previous={fetch:globalThis.fetch,session:globalThis.sessionStorage,storage:globalThis.localStorage,window:globalThis.window,React:(globalThis as any).React};
 const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],calls:any[]=[],events:Function[]=[];let index=0,dirty=true,Panel:any,tree:any;
 (globalThis as any).sessionStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
 (globalThis as any).React=React;(globalThis as any).localStorage={getItem:(k:string)=>k==='authToken'?'synthetic':k==='currentUser'?JSON.stringify({id:'owner',role:'instructor'}):null};(globalThis as any).window={addEventListener:(_k:string,fn:Function)=>events.push(fn),removeEventListener:()=>{}};
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(String(url).endsWith('/students')?{students:[{enrollment_id:'enrollment-one',name:'student'}],next_cursor:null}:sample(JSON.parse(String(init?.body)),String(url).endsWith('/review'))));};
 try{
  delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(x:any)=>{const next=typeof x==='function'?x(hooks[i]):x;if(next!==hooks[i]){hooks[i]=next;dirty=true;}}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);return original.call(this,request,parent,main);};
  Panel=require(file).CourseReturnPlan;mod._load=original;
  const settle=async()=>{for(let n=0;n<15;n++){if(dirty){index=0;dirty=false;tree=Panel({courseId:id(1)});effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}};
  const all=(predicate:(n:any)=>boolean)=>{const rows:any[]=[];function walk(n:any){if(!n||typeof n!=='object')return;if(predicate(n))rows.push(n);[n.props?.children].flat(Infinity).forEach(walk);}walk(tree);return rows;};
  await settle();find(tree,n=>n.type==='select').props.onChange({target:{value:'enrollment-one'}});await settle();all(n=>n.type==='input'&&n.props.type==='date')[0].props.onChange({target:{value:'2026-11-01'}});await settle();all(n=>n.type==='input'&&n.props.type==='date')[1].props.onChange({target:{value:'2026-11-07'}});await settle();find(tree,n=>n.props?.children==='قراءة الحضور والتقدم').props.onClick();await settle();
  assert.match(require('react-dom/server').renderToStaticMarkup(tree),/&lt;script&gt;student/);all(n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange();await settle();find(tree,n=>n.props?.children==='معاينة الخطوات الحالية').props.onClick();await settle();
  const confirm=find(tree,n=>n.props?.children==='تأكيد مراجعة المسودة');assert.equal(confirm.props.disabled,true);all(n=>n.type==='input'&&n.props.type==='checkbox').at(-1).props.onChange({target:{checked:true}});await settle();find(tree,n=>n.props?.children==='تأكيد مراجعة المسودة').props.onClick();await settle();
  assert.equal(calls.length,4);assert.ok(calls.at(-1).url.endsWith('/return-plan/review'));assert.equal(JSON.parse(calls.at(-1).init.body).review_token,'a'.repeat(64));assert.ok(calls.every(c=>c.init.cache==='no-store'));
  assert.match(require('react-dom/server').renderToStaticMarkup(tree),/المراجعة وحدها لا تحفظ/);events.forEach(fn=>fn({key:'currentUser'}));await settle();assert.match(require('react-dom/server').renderToStaticMarkup(tree),/أُخفيت/);assert.equal(find(tree,n=>n.type==='select'),null);
 }finally{cleanups.forEach(fn=>fn?.());mod._load=original;delete require.cache[file];globalThis.fetch=previous.fetch;(globalThis as any).sessionStorage=previous.session;(globalThis as any).localStorage=previous.storage;(globalThis as any).window=previous.window;(globalThis as any).React=previous.React;}
});
test('return transport rejects malformed immutable course binding',()=>{assert.throws(()=>returnPlanTransport('bad'));});
