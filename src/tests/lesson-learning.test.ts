import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLessonLearning,initialLearning,learningWindow,lessonLearningTransport,parseLessonLearning} from '../features/catalog/lesson-learning';
const id=(n:number)=>`b3700000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const window={group_id:id(70),from:'2026-11-01T00:00:00.000Z',to:'2026-11-07T00:00:00.000Z'};
const sample=()=>({context:{course_id:id(1),lesson_id:id(3),...window},checked_at:'2026-11-07T08:00:00.000Z',group_name:'group',rule_version:'automatic-tags-v1',reason:null,state:'available',graded_attempts:5,automatic_questions:1,unmapped_questions:0,excluded_manual_questions:1,suggestions:[{tag:'<script>fractions</script>',responses:5,not_fully_correct:2,question_count:1,evidence:[{question_ref:id(20),position:1,text:'<script>question</script>',responses:5,not_correct:2}]}]});
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{resolve,promise};};
function fixture(){let identity='A',event=()=>{},read:()=>Promise<any>=async()=>sample(),state=initialLearning();const calls:string[]=[];
 const c=createLessonLearning({groups:async()=>{calls.push('groups');return{groups:[{id:id(70),name:'group'}],nextCursor:id(71)};},read:async()=>{calls.push('read');return read();},readPrincipal:()=>identity,subscribeSession:fn=>{event=fn;return()=>{};}});c.subscribe(x=>state=x);
 return{c,state:()=>state,calls,setRead:(fn:()=>Promise<any>)=>read=fn,event:()=>event(),changeIdentity:()=>identity='B'};
}
test('learning DTO binds cohort/window and rejects private or contradictory evidence',()=>{
 assert.equal(parseLessonLearning(sample(),id(1),id(3),window).suggestions.length,1);
 for(const raw of [{...sample(),context:{...sample().context,group_id:id(99)}},{...sample(),student_id:'private'},{...sample(),graded_attempts:4},{...sample(),suggestions:[{...sample().suggestions[0],responses:4}]},{...sample(),suggestions:[{...sample().suggestions[0],evidence:[{...sample().suggestions[0].evidence[0],correct_answers:['a']}]}]},{...sample(),state:'insufficient'},{...sample(),suggestions:[{...sample().suggestions[0],not_fully_correct:1}]}])assert.throws(()=>parseLessonLearning(raw,id(1),id(3),window));
 assert.throws(()=>learningWindow(id(70),window.to,window.from));assert.throws(()=>learningWindow(id(70),window.from,'2026-12-20T00:00:00.000Z'));
 const absent={...sample(),reason:'no_quiz',state:'insufficient',graded_attempts:null,automatic_questions:null,unmapped_questions:null,excluded_manual_questions:null,suggestions:[]};
 assert.equal(parseLessonLearning(absent,id(1),id(3),window).graded_attempts,null);assert.throws(()=>parseLessonLearning({...absent,graded_attempts:0},id(1),id(3),window));
});
test('only a loaded cohort can be queried; selection/date/page changes clear evidence and local decisions',async()=>{
 const h=fixture();await h.c.first();h.c.change(id(99),window.from,window.to);await h.c.read();assert.deepEqual(h.calls,['groups']);
 h.c.change(id(70),window.from,window.to);await h.c.read();h.c.decide(sample().suggestions[0].tag,'use');assert.equal(Object.keys(h.state().decisions).length,1);
 h.c.change(id(70),window.from,'2026-11-06T00:00:00.000Z');assert.equal(h.state().data,null);assert.deepEqual(h.state().decisions,{});await h.c.next();assert.equal(h.state().groupId,'');h.c.dispose();
});
for(const kind of ['principal','event','dispose','selection'])test(`late learning data is discarded after ${kind}`,async()=>{
 const h=fixture(),d=deferred();await h.c.first();h.c.change(id(70),window.from,window.to);h.setRead(()=>d.promise);const request=h.c.read();
 if(kind==='principal')h.changeIdentity();if(kind==='event')h.event();if(kind==='dispose')h.c.dispose();if(kind==='selection')h.c.change(id(70),window.from,'');
 d.resolve(sample());await request;assert.equal(h.state().data,null);h.c.dispose();
});
test('failure and deadline never leave an old cohort result visible',async t=>{
 const h=fixture();await h.c.first();h.c.change(id(70),window.from,window.to);await h.c.read();h.setRead(async()=>{throw Error('503');});await h.c.read();assert.equal(h.state().data,null);assert.equal(h.state().phase,'error');
 t.mock.timers.enable({apis:['setTimeout']});const d=deferred();h.setRead(()=>d.promise);const work=h.c.read();t.mock.timers.tick(25000);assert.equal(h.state().phase,'error');d.resolve(sample());await work;assert.equal(h.state().data,null);h.c.dispose();
});
function find(n:any,p:(n:any)=>boolean):any{if(!n||typeof n!=='object')return null;if(p(n))return n;for(const child of [n.props?.children].flat(Infinity)){const found=find(child,p);if(found)return found;}return null;}
test('actual learning panel selects group/UTC days, performs private GET and shows escaped authorized evidence',async()=>{
 const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,original=mod._load,file=require.resolve('../features/catalog/LessonLearningEvidence.tsx');
 const previous={fetch:globalThis.fetch,storage:globalThis.localStorage,window:globalThis.window,React:(globalThis as any).React};
 const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],calls:any[]=[],listeners:Function[]=[];let index=0,dirty=true,Panel:any,tree:any;
 (globalThis as any).React=React;(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic':key==='currentUser'?JSON.stringify({id:'owner',role:'instructor'}):null};(globalThis as any).window={addEventListener:(_kind:string,fn:Function)=>listeners.push(fn),removeEventListener:()=>{}};
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(String(url).endsWith('/groups')?{groups:[{id:id(70),name:'group'}],next_cursor:null}:sample()));};
 try{
  delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(x:any)=>{hooks[i]=typeof x==='function'?x(hooks[i]):x;dirty=true;}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);return original.call(this,request,parent,main);};
  Panel=require(file).LessonLearningEvidence;mod._load=original;
  const settle=async()=>{for(let n=0;n<12;n++){if(dirty){index=0;dirty=false;tree=Panel({courseId:id(1),unitId:id(2),lessonId:id(3)});effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}};
  await settle();find(tree,n=>n.type==='select').props.onChange({target:{value:id(70)}});await settle();
  const dates=()=>{const result:any[]=[];function walk(n:any){if(!n||typeof n!=='object')return;if(n.type==='input'&&n.props.type==='date')result.push(n);[n.props?.children].flat(Infinity).forEach(walk);}walk(tree);return result;};
  dates()[0].props.onChange({target:{value:'2026-11-01'}});await settle();dates()[1].props.onChange({target:{value:'2026-11-07'}});await settle();find(tree,n=>n.props?.children==='قراءة أدلة المراجعة').props.onClick();await settle();
  assert.equal(calls.length,2);assert.equal(new URL(calls[1].url,'https://example.invalid').searchParams.get('group_id'),id(70));assert.equal(new URL(calls[1].url,'https://example.invalid').searchParams.get('from'),window.from);assert.ok(calls.every(c=>!c.init.body&&c.init.cache==='no-store'));
  const html=require('react-dom/server').renderToStaticMarkup(tree);assert.match(html,/&lt;script&gt;fractions/);assert.match(html,/&lt;script&gt;question/);
  find(tree,n=>n.props?.children==='أستخدم الوسم في المراجعة').props.onClick();await settle();assert.equal(calls.length,2);
  listeners.forEach(fn=>fn({key:'currentUser'}));await settle();assert.equal(find(tree,n=>n.type==='details'),null);assert.match(require('react-dom/server').renderToStaticMarkup(tree),/أُخفيت/);
 }finally{cleanups.forEach(fn=>fn?.());mod._load=original;delete require.cache[file];globalThis.fetch=previous.fetch;(globalThis as any).localStorage=previous.storage;(globalThis as any).window=previous.window;(globalThis as any).React=previous.React;}
});
test('learning transport validates immutable resource selectors before fetch',()=>{assert.throws(()=>lessonLearningTransport('bad',id(2),id(3)));});
