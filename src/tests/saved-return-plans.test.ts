import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ApiRequestError} from '../lib/api-http';
import {createReturnPlan,initialReturn,returnIntentStore,type ReturnInput,type ReturnEvidence,type SavedReturnReceipt} from '../features/catalog/course-return-plan';
import {createStudentPlans,initialStudentPlans,parseStudentPlans,studentReturnPrincipal} from '../features/catalog/student-return-plans';
const id=(n:number)=>`b3900000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input=():ReturnInput=>({enrollment_id:'enrollment-one',from:'2026-11-01T00:00:00.000Z',to:'2026-11-07T00:00:00.000Z',steps:[]});
const evidence=(i=input(),reviewed=false):ReturnEvidence=>({context:{course_id:id(1),enrollment_id:i.enrollment_id,from:i.from,to:i.to},checked_at:'2026-11-07T10:00:00.000Z',student:{name:'student'},attendance:[],lessons:[{lesson_id:id(10),title:'lesson',completed:false,block:null}],steps:i.steps.map(s=>({...s,title:'lesson'})),review_token:i.steps.length?'a'.repeat(64):null,reviewed,delivery:'not_sent',persistence:{status:'ready',current:null}});
const receipt:SavedReturnReceipt={operation_id:id(900),plan_id:id(700),version:1,status:'active'};
function memory(){const map=new Map<string,string>();return{map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};}
function fixture(store=memory()){
 let identity='A',event=()=>{},state=initialReturn();const s={writes:0,statusCalls:0,preview:async(i:ReturnInput):Promise<ReturnEvidence>=>evidence(i),save:async():Promise<SavedReturnReceipt>=>{s.writes++;throw Error('Lost ACK');},status:async():Promise<SavedReturnReceipt|null>=>{s.statusCalls++;return receipt;}};
 const c=createReturnPlan({roster:async()=>({students:[{enrollment_id:'enrollment-one',name:'student'}],nextCursor:null}),preview:async i=>s.preview(i),review:async i=>evidence(i,true),save:async()=>s.save(),withdraw:async()=>s.save(),status:async()=>s.status(),readPrincipal:()=>identity,subscribeSession:fn=>{event=fn;return()=>{};},intentStore:returnIntentStore(store,id(1),'owner'),newOperationId:()=>id(900)});c.subscribe(x=>state=x);
 const prepare=async()=>{await c.first();c.change('enrollment-one',input().from,input().to);await c.load();c.choose(id(10));await c.preview();await c.review();};
 return{c,s,prepare,state:()=>state,store,event:()=>event(),identity:()=>identity='B'};
}
test('lost save locks all other navigation and recovers after reopening with only a minimal operation marker',async()=>{
 const h=fixture();await h.prepare();await h.c.save();assert.equal(h.s.writes,1);assert.equal(h.state().savePhase,'uncertain');
 h.c.change('other','','');await h.c.first();h.c.choose(id(10));await h.c.save();assert.equal(h.s.writes,1);assert.equal(h.state().enrollmentId,'enrollment-one');
 const marker=[...h.store.map.values()][0];assert.doesNotMatch(marker,/enrollment|student|attendance|lesson_id|from|to"/);h.c.dispose();
 const reopened=fixture(h.store);assert.equal(reopened.state().savePhase,'uncertain');await reopened.c.recover();assert.equal(reopened.state().savePhase,'confirmed');assert.equal(reopened.s.writes,0);assert.equal(reopened.s.statusCalls,1);assert.equal(h.store.map.size,0);reopened.c.dispose();
});
test('missing/mismatched recovery does not permit a new operation; current principal loss clears private data',async()=>{
 const h=fixture();await h.prepare();await h.c.save();h.s.status=async()=>null;await h.c.recover();assert.equal(h.state().savePhase,'uncertain');h.s.status=async()=>({...receipt,version:2});await h.c.recover();assert.equal(h.state().savePhase,'uncertain');h.identity();await h.c.recover();assert.equal(h.state().phase,'session-ended');assert.equal(h.state().data,null);h.c.dispose();
});
test('storage failure prevents writes; confirmed commit survives failed marker cleanup and failed refresh',async()=>{
 const store=memory(),h=fixture(store);await h.prepare();const original=store.setItem,remove=store.removeItem;store.setItem=()=>{throw Error('storage');};await h.c.save();assert.equal(h.s.writes,0);store.setItem=original;h.s.save=async()=>{h.s.writes++;return receipt;};store.removeItem=()=>{throw Error('cleanup');};await h.c.save();assert.equal(h.state().savePhase,'uncertain');assert.equal(h.state().saved?.version,1);assert.equal(h.s.writes,1);
 await h.c.save();await h.c.withdraw();await h.c.load();assert.equal(h.s.writes,1);assert.equal(h.state().savePhase,'uncertain');
 h.s.status=async()=>{throw Error('status unavailable');};await h.c.recover();assert.equal(h.state().saved?.version,1);assert.equal(h.state().savePhase,'uncertain');assert.match(h.state().message??'',/الحفظ مؤكد/);
 h.s.status=async()=>receipt;store.removeItem=remove;await h.c.recover();assert.equal(h.state().savePhase,'confirmed');assert.equal(store.map.size,0);
 h.s.preview=async()=>{throw Error('refresh failed');};await h.c.load();assert.equal(h.state().saved?.version,1);assert.equal(h.state().savePhase,'confirmed');assert.equal(h.state().phase,'error');h.c.dispose();
});
test('definite version conflict drops approval and deadline retains the same saved intent',async t=>{
 const h=fixture();await h.prepare();h.s.save=async()=>{throw new ApiRequestError('changed',409);};await h.c.save();assert.equal(h.state().savePhase,'idle');assert.equal(h.state().preview,null);assert.equal(h.store.map.size,0);await h.c.preview();await h.c.review();
 t.mock.timers.enable({apis:['setTimeout']});let resolve!:(x:SavedReturnReceipt)=>void;h.s.save=()=>new Promise(r=>resolve=r);const work=h.c.save();t.mock.timers.tick(25000);assert.equal(h.state().savePhase,'uncertain');resolve(receipt);await work;assert.equal(h.state().savePhase,'uncertain');assert.equal(h.store.map.size,1);h.c.dispose();
});
const studentPage=()=>({plans:[{id:id(700),version:1,course_id:id(1),course_name:'<script>course</script>',steps:[{position:1,available:true,lesson_id:id(10),title:'<script>lesson</script>',minutes:15,completed:false},{position:2,available:false}]}],next_cursor:null,checked_at:'2026-11-07T10:00:00.000Z'});
test('student DTO rejects leaking unavailable step names, identities or duplicate resource rows',()=>{
 assert.equal(parseStudentPlans(studentPage(),null).plans[0].steps[1].available,false);
 for(const raw of [{...studentPage(),enrollment_id:'private'},{...studentPage(),plans:[{...studentPage().plans[0],steps:[{position:1,available:false,title:'hidden'}]}]},{...studentPage(),plans:[...studentPage().plans,...studentPage().plans]}])assert.throws(()=>parseStudentPlans(raw,null));
});
test('student space changes and failed reads remove earlier plan evidence',async()=>{
 let principal='A',event=()=>{},state=initialStudentPlans(),read=async()=>parseStudentPlans(studentPage(),null);const c=createStudentPlans({read:async()=>read(),readPrincipal:()=>principal,subscribeSession:fn=>{event=fn;return()=>{};}});c.subscribe(x=>state=x);await c.first();assert.equal(state.page?.plans.length,1);read=async()=>{throw Error('unavailable');};await c.first();assert.equal(state.page,null);
 let resolve!:(x:any)=>void;read=()=>new Promise(r=>resolve=r);const work=c.first();principal='B';resolve(parseStudentPlans(studentPage(),null));await work;assert.equal(state.phase,'session-ended');assert.equal(state.page,null);event();c.dispose();
});
test('student principal fences same-token workspace switches',()=>{
 const data=new Map([['authToken','synthetic'],['currentUser',JSON.stringify({id:'student',role:'student'})],['currentStudentSpace',JSON.stringify({tenant_id:'tenant',student_enrollment_id:'one'})]]);const read=studentReturnPrincipal({getItem:k=>data.get(k)??null});const first=read();data.set('currentStudentSpace',JSON.stringify({tenant_id:'tenant',student_enrollment_id:'two'}));assert.notEqual(read(),first);data.set('currentStudentSpace','null');assert.equal(read(),null);
});

// Actual source-file hooks/callbacks through canonical transports, no replacement
// write controller. The generic Link stub avoids a router provider in this test.
async function mounted(name:'CourseReturnPlan'|'StudentReturnPlans',work:(h:any)=>Promise<void>){
 const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,original=mod._load,file=require.resolve('../features/catalog/'+name+'.tsx'),store=memory();
 const previous={fetch:globalThis.fetch,storage:globalThis.localStorage,session:globalThis.sessionStorage,window:globalThis.window,React:(globalThis as any).React};
 const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],events:{kind:string;fn:Function}[]=[],calls:any[]=[];let index=0,dirty=true,Panel:any,tree:any;
 (globalThis as any).React=React;(globalThis as any).sessionStorage=store;(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic':key==='currentUser'?JSON.stringify({id:name==='CourseReturnPlan'?'owner':'student',role:name==='CourseReturnPlan'?'instructor':'student'}):key==='currentStudentSpace'?JSON.stringify({tenant_id:'tenant',student_enrollment_id:'enrollment-one'}):null};(globalThis as any).window={addEventListener:(kind:string,fn:Function)=>events.push({kind,fn}),removeEventListener:()=>{},confirm:()=>true};
 try{delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(x:any)=>{const next=typeof x==='function'?x(hooks[i]):x;if(next!==hooks[i]){hooks[i]=next;dirty=true;}}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};if(request==='react-router-dom'&&parent?.filename===file)return{Link:(p:any)=>React.createElement('a',{href:p.to},p.children)};if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);return original.call(this,request,parent,main);};Panel=require(file)[name];mod._load=original;
  const props:any={courseId:id(1),onLockChange:(x:boolean)=>locks.push(x)},locks:boolean[]=[];
  const settle=async()=>{for(let i=0;i<15;i++){if(dirty){index=0;dirty=false;tree=Panel(props);effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}return tree;};
  const find=(predicate:(n:any)=>boolean)=>{function visit(n:any):any{if(!n||typeof n!=='object')return null;if(predicate(n))return n;for(const c of [n.props?.children].flat(Infinity)){const r=visit(c);if(r)return r;}return null;}return visit(tree);};
  const all=(predicate:(n:any)=>boolean)=>{const result:any[]=[];function visit(n:any){if(!n||typeof n!=='object')return;if(predicate(n))result.push(n);[n.props?.children].flat(Infinity).forEach(visit);}visit(tree);return result;};
  await work({settle,find,all,locks,calls,store,events,render:()=>require('react-dom/server').renderToStaticMarkup(tree),setFetch:(fn:typeof fetch)=>{globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return fn(url,init);};}});
 }finally{cleanups.forEach(fn=>fn?.());mod._load=original;delete require.cache[file];globalThis.fetch=previous.fetch;(globalThis as any).localStorage=previous.storage;(globalThis as any).sessionStorage=previous.session;(globalThis as any).window=previous.window;(globalThis as any).React=previous.React;}
}
test('actual owner save freezes scope/close signal and uses GET recovery without replaying the POST',async()=>mounted('CourseReturnPlan',async h=>{
 let op='';h.setFetch(async(url:any,init:any)=>{const u=String(url);if(u.endsWith('/students'))return new Response(JSON.stringify({students:[{enrollment_id:'enrollment-one',name:'student'}],next_cursor:null}));if(u.endsWith('/save')){op=JSON.parse(init.body).operation_id;throw Error('lost');}if(u.includes('/operations/'))return new Response(JSON.stringify({operation:{...receipt,operation_id:op}}));return new Response(JSON.stringify(evidence(JSON.parse(init.body),u.endsWith('/review'))));});
 await h.settle();h.find((n:any)=>n.type==='select').props.onChange({target:{value:'enrollment-one'}});await h.settle();h.all((n:any)=>n.type==='input'&&n.props.type==='date')[0].props.onChange({target:{value:'2026-11-01'}});await h.settle();h.all((n:any)=>n.type==='input'&&n.props.type==='date')[1].props.onChange({target:{value:'2026-11-07'}});await h.settle();h.find((n:any)=>n.props?.children==='قراءة الحضور والتقدم').props.onClick();await h.settle();h.all((n:any)=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange();await h.settle();h.find((n:any)=>n.props?.children==='معاينة الخطوات الحالية').props.onClick();await h.settle();h.all((n:any)=>n.type==='input'&&n.props.type==='checkbox').at(-1).props.onChange({target:{checked:true}});await h.settle();h.find((n:any)=>n.props?.children==='تأكيد مراجعة المسودة').props.onClick();await h.settle();h.find((n:any)=>n.props?.children==='حفظ الخطة وإتاحتها للطالب').props.onClick();await h.settle();assert.equal(h.locks.at(-1),true);assert.equal(h.find((n:any)=>n.type==='select').props.disabled,true);h.find((n:any)=>n.type==='select').props.onChange({target:{value:'other'}});assert.equal(h.store.map.size,1);
 h.find((n:any)=>n.props?.children==='التحقق من نتيجة الحفظ دون إعادة الكتابة').props.onClick();await h.settle();assert.equal(h.locks.at(-1),false);assert.equal(h.calls.filter((c:any)=>c.url.endsWith('/save')).length,1);assert.equal(h.calls.at(-1).init.body,undefined);assert.equal(h.store.map.size,0);
}));
test('actual student panel displays escaped available evidence and no hidden lesson identity, then clears on scope event',async()=>mounted('StudentReturnPlans',async h=>{
 h.setFetch(async()=>new Response(JSON.stringify(studentPage())));await h.settle();assert.match(h.render(),/&lt;script&gt;lesson/);assert.match(h.render(),/غير متاحة/);assert.doesNotMatch(h.render(),/enrollment-one/);assert.equal(h.calls[0].url,'/api/tenants/me/catalog/my-return-plans');assert.equal(h.calls[0].init.body,undefined);h.events.filter((x:any)=>x.kind==='storage').forEach((x:any)=>x.fn({key:'currentStudentSpace'}));await h.settle();assert.match(h.render(),/أُخفيت/);assert.equal(h.find((n:any)=>n.type==='article'),null);
}));
