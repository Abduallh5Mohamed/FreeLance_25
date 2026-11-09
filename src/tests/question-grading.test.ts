import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {ApiRequestError} from '../lib/api-http';
import {createQuestionGrading,gradingIntentStore,gradingApi,initialGrading,parseGradingAnswers,parseGradingPicker,parseGradingReceipt,type Receipt} from '../features/grading/question-grading';
const id=(n:number)=>`b4200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const answerPage=()=>({question:{id:id(5),version_id:id(4),text:'<script>Question</script>',points:'5.00',explanation:'Pinned explanation'},answers:[{attempt_id:id(7),version:0,response:'private answer',unsupported:false,revision:null,awarded_points:null,feedback:null}],next_cursor:null});
const receipt:Receipt={operation_id:id(20),attempt_id:id(7),kind:'grade',attempt_version:1,question_ref:id(5),revision:1,awarded_points:'4.25',score:null,gradebook_linked:null};
function memory(){const map=new Map<string,string>();return{map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};}
function fixture(storage=memory()){
 let principal='A',event=()=>{},state=initialGrading(),writes=0,statusCalls=0;
 const api:typeof gradingApi={picker:async(level)=>({items:[{id:id(level==='exams'?3:level==='versions'?4:5),label:level}],next_cursor:null}),answers:async()=>parseGradingAnswers(answerPage(),id(5)),
  review:async()=>({attempt_id:id(7),version:0,status:'pending_review',complete:true,score:'6.25',review_token:'a'.repeat(64)}),
  write:async()=>{writes++;throw Error('lost acknowledgement');},operation:async()=>{statusCalls++;return receipt;}};
 const c=createQuestionGrading({api,readPrincipal:()=>principal,subscribeSession:fn=>{event=fn;return()=>{};},store:gradingIntentStore(storage,'owner'),newId:()=>id(20)});c.subscribe(x=>state=x);
 const prepare=async()=>{await c.exams();await c.selectExam(id(3));await c.selectVersion(id(4));await c.answers(id(5));c.choose(id(7));c.change('4.25','private feedback');};
 return{c,api,storage,prepare,state:()=>state,writes:()=>writes,statusCalls:()=>statusCalls,event:()=>event(),identity:()=>{principal='B';}};
}
test('exact grading DTO rejects private identities, unsupported-response leaks, mismatched targets and fabricated receipts',()=>{
 assert.equal(parseGradingAnswers(answerPage(),id(5)).answers[0].response,'private answer');
 for(const raw of [{...answerPage(),student_name:'private'},{...answerPage(),answers:[{...answerPage().answers[0],unsupported:true}]},{...answerPage(),answers:[{...answerPage().answers[0],revision:1,awarded_points:'6.00'}]},{...answerPage(),answers:[...answerPage().answers,...answerPage().answers]}])assert.throws(()=>parseGradingAnswers(raw,id(5)));
 assert.throws(()=>parseGradingAnswers(answerPage(),id(6)));assert.throws(()=>parseGradingReceipt({...receipt,feedback:'private'}));assert.throws(()=>parseGradingReceipt({...receipt,kind:'finalize'}));assert.throws(()=>parseGradingPicker({items:[{id:id(3),label:'Exam',tenant_id:'private'}],next_cursor:null}));
});
test('full numeric input is checked before HTTP and unsupported answers are not gradable',async()=>{
 const h=fixture();await h.prepare();for(const value of ['12abc','1.234','Infinity','-1','5.01','1e0','']){h.c.change(value,'');await h.c.grade();}assert.equal(h.writes(),0);
 h.api.answers=async()=>parseGradingAnswers({...answerPage(),answers:[{...answerPage().answers[0],response:null,unsupported:true}]},id(5));await h.c.answers(id(5));h.c.choose(id(7));h.c.change('1.00','');await h.c.grade();assert.equal(h.writes(),0);h.c.dispose();
});
test('lost save locks navigation and reload recovers by GET with only minimal opaque intent metadata',async()=>{
 const h=fixture();await h.prepare();await h.c.grade();assert.equal(h.writes(),1);assert.equal(h.state().phase,'uncertain');await h.c.exams();await h.c.grade();assert.equal(h.writes(),1);
 assert.doesNotMatch([...h.storage.map.values()][0],/private answer|private feedback|awarded_points|password|token|student/);h.c.dispose();
 const reopened=fixture(h.storage);assert.equal(reopened.state().phase,'uncertain');await reopened.c.recover();assert.equal(reopened.statusCalls(),1);assert.equal(reopened.writes(),0);assert.equal(reopened.state().receipt?.awarded_points,'4.25');assert.equal(reopened.storage.map.size,0);reopened.c.dispose();
});
test('missing or mismatched receipt remains uncertain; storage refusal prevents a write',async()=>{
 const h=fixture();await h.prepare();const original=h.storage.setItem;h.storage.setItem=()=>{throw Error('storage');};await h.c.grade();assert.equal(h.writes(),0);h.storage.setItem=original;await h.c.grade();
 h.api.operation=async()=>null;await h.c.recover();assert.equal(h.state().phase,'uncertain');h.api.operation=async()=>({...receipt,attempt_version:2});await h.c.recover();assert.equal(h.state().phase,'uncertain');h.c.dispose();
});
test('confirmed save survives refresh and marker-cleanup failures without describing it as a failed write',async()=>{
 const h=fixture();await h.prepare();h.api.write=async()=>receipt;h.storage.removeItem=()=>{throw Error('cleanup');};await h.c.grade();assert.equal(h.state().receipt?.revision,1);assert.equal(h.state().phase,'uncertain');assert.equal(h.state().page,null);h.c.dispose();
 const clean=fixture();await clean.prepare();clean.api.write=async()=>receipt;await clean.c.grade();clean.api.answers=async()=>{throw Error('refresh');};await clean.c.answers(id(5));assert.equal(clean.state().receipt?.revision,1);assert.equal(clean.state().phase,'error');clean.c.dispose();
});
test('stale/denied writes discard rejected approval and private drafts; finalization requires fresh preview token',async()=>{
 const h=fixture();await h.prepare();h.api.write=async()=>{throw new ApiRequestError('changed',409);};await h.c.grade();assert.equal(h.state().phase,'error');assert.equal(h.state().feedback,'');assert.equal(h.storage.map.size,0);h.c.dispose();
 const done=fixture();await done.prepare();let kind='';done.api.write=async(k,_id,body:any)=>{kind=k;assert.equal(body.review_token,'a'.repeat(64));assert.equal(body.expected_version,0);return{...receipt,kind:'finalize',question_ref:null,revision:null,awarded_points:null,score:'6.25',gradebook_linked:true};};await done.c.finalize();assert.equal(kind,'');await done.c.preview();await done.c.finalize();assert.equal(kind,'finalize');assert.equal(done.state().receipt?.score,'6.25');done.c.dispose();
});
test('deadline and principal/session changes fence late results and all private grading actions',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=fixture();await h.prepare();let resolve!:(x:Receipt)=>void;h.api.write=()=>new Promise(r=>resolve=r);const work=h.c.grade();t.mock.timers.tick(25000);assert.equal(h.state().phase,'uncertain');resolve(receipt);await work;assert.equal(h.state().receipt,null);h.identity();await h.c.recover();assert.equal(h.state().phase,'session-ended');assert.equal(h.state().page,null);h.event();h.c.dispose();
});
test('canonical transport uses scoped relative routes and keyed body without authority selectors',async()=>{
 const original={fetch:globalThis.fetch,storage:globalThis.localStorage},calls:Array<{url:string;init:RequestInit}>=[];(globalThis as any).localStorage={getItem:(k:string)=>k==='authToken'?'synthetic-login':null};
 globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});return new Response(JSON.stringify(String(url).includes('/grade')&&!String(url).includes('/grading/exams')?{operation:receipt}:{items:[],next_cursor:null}));};
 try{const signal=new AbortController().signal;await gradingApi.picker('exams',null,null,signal);await gradingApi.write('grade',id(7),{operation_id:id(20),expected_version:0,question_ref:id(5),points:'4.25',feedback:null},signal);
  assert.equal(calls[0].url,'/api/tenants/me/catalog/grading/exams');assert.equal(calls[1].url,'/api/tenants/me/catalog/grading/attempts/'+id(7)+'/grade');assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.cache,'no-store');assert.equal(new Headers(calls[1].init.headers).get('authorization'),'Bearer synthetic-login');assert.doesNotMatch(calls[1].init.body as string,/tenant_id|student_id|reviewer_user_id/);
 }finally{globalThis.fetch=original.fetch;(globalThis as any).localStorage=original.storage;}
});
test('actual panel selects pinned scope, writes one revision and reconciles unknown result via canonical GET',async()=>{
 const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,originalLoad=mod._load,file=require.resolve('../features/grading/QuestionGrading.tsx');
 const old={fetch:globalThis.fetch,storage:globalThis.localStorage,session:globalThis.sessionStorage,window:globalThis.window,React:(globalThis as any).React};
 const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],events:Array<{kind:string;fn:Function}>=[],calls:Array<{url:string;init:RequestInit}>=[];const storage=memory();let op='',index=0,dirty=true,tree:any,Panel:any;
 (globalThis as any).React=React;(globalThis as any).sessionStorage=storage;(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-login':key==='currentUser'?JSON.stringify({id:'owner',role:'instructor'}):null};
 (globalThis as any).window={addEventListener:(kind:string,fn:Function)=>events.push({kind,fn}),removeEventListener:()=>{},confirm:()=>true};
 globalThis.fetch=async(url,init:RequestInit={})=>{const u=String(url);calls.push({url:u,init});if(u.endsWith('/grade')){op=JSON.parse(init.body as string).operation_id;throw Error('lost');}if(u.includes('/operations/'))return new Response(JSON.stringify({operation:{...receipt,operation_id:op}}));if(u.endsWith('/answers'))return new Response(JSON.stringify(answerPage()));return new Response(JSON.stringify({items:[{id:id(u.endsWith('/exams')?3:u.endsWith('/versions')?4:5),label:'Scope'}],next_cursor:null}));};
 try{delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(v:any)=>{const next=typeof v==='function'?v(hooks[i]):v;if(next!==hooks[i]){hooks[i]=next;dirty=true;}}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};if(request.startsWith('@/'))return originalLoad.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);return originalLoad.call(this,request,parent,main);};Panel=require(file).QuestionGradingPanel;mod._load=originalLoad;
  const settle=async()=>{for(let i=0;i<25;i++){if(dirty){index=0;dirty=false;tree=Panel();effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}};
  const all=(predicate:(n:any)=>boolean)=>{const found:any[]=[];function visit(n:any){if(!n||typeof n!=='object')return;if(predicate(n))found.push(n);[n.props?.children].flat(Infinity).forEach(visit);}visit(tree);return found;};const find=(predicate:(n:any)=>boolean)=>all(predicate)[0];const html=()=>require('react-dom/server').renderToStaticMarkup(tree);
  await settle();assert.equal(calls.length,0);find(n=>n.props?.children==='قراءة الامتحانات المخولة').props.onClick();await settle();all(n=>n.type==='select')[0].props.onChange({target:{value:id(3)}});await settle();all(n=>n.type==='select')[1].props.onChange({target:{value:id(4)}});await settle();all(n=>n.type==='select')[2].props.onChange({target:{value:id(5)}});await settle();find(n=>Array.isArray(n.props?.children)&&n.props.children[0]==='إجابة ').props.onClick();await settle();
  assert.match(html(),/&lt;script&gt;Question/);find(n=>n.type==='input').props.onChange({target:{value:'4.25'}});await settle();find(n=>n.props?.children==='حفظ مراجعة السؤال').props.onClick();await settle();assert.equal(storage.map.size,1);assert.equal(all(n=>n.type==='select')[0].props.disabled,true);find(n=>n.props?.children==='التحقق من نتيجة العملية دون إعادة الكتابة').props.onClick();await settle();assert.match(html(),/الحفظ مؤكد/);assert.equal(calls.filter(c=>c.url.endsWith('/grade')).length,1);assert.ok(calls.at(-1)!.url.includes('/operations/'));assert.equal(calls.at(-1)!.init.body,undefined);
  events.find(e=>e.kind==='storage')!.fn({key:'authToken'});await settle();assert.doesNotMatch(html(),/private answer/);assert.match(html(),/أُخفيت إجابات التصحيح/);
 }finally{cleanups.forEach(fn=>fn?.());mod._load=originalLoad;delete require.cache[file];globalThis.fetch=old.fetch;(globalThis as any).localStorage=old.storage;(globalThis as any).sessionStorage=old.session;(globalThis as any).window=old.window;(globalThis as any).React=old.React;}
});
test('current production compositions mount workbench beside the unchanged legacy grading path',()=>{
 const client=readFileSync(new URL('../pages/ManualGrading.tsx',import.meta.url),'utf8'),server=readFileSync(new URL('../../server/src/routes/tenant-self.ts',import.meta.url),'utf8');assert.match(client,/<QuestionGrading \/>/);assert.match(server,/createQuestionGradingRouter\(\{ getConnection \}\)/);
});
