import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {ApiRequestError} from '../lib/api-http';
import {createGroupSetup,initialGroupSetup,parseGroupSetup} from '../features/groups/group-setup';
const id=(n:number)=>`b4000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const raw=(groupId=id(1))=>({group:{id:groupId,name:'<script>Group</script>',course_name:'Math',active:true,course_active:true,branch_valid:true,capacity:30},
    instructor:{status:'active',name:'Teacher'},students:{total:2,active:1,inactive:1,offline:0,missing_account:0,missing_course_assignment:0},
    schedule:{status:'available',sessions:[{id:id(3),title:'Lesson',starts_at:'2026-11-09T10:00:00.000Z'}]},issues:[],next_action:'practice_handover',checked_at:'2026-11-07T10:00:00.000Z',readiness:'review_only'});
function fixture(){let principal='A',event=()=>{},state=initialGroupSetup();const calls:string[]=[],deps={read:async(groupId:string)=>{calls.push(groupId);return parseGroupSetup(raw(groupId),groupId);},readPrincipal:()=>principal,subscribeSession:(fn:()=>void)=>{event=fn;return()=>{};}};
    const c=createGroupSetup(deps);c.subscribe(x=>state=x);return{c,deps,calls,state:()=>state,change:()=>{principal='B';},event:()=>event()};}
test('setup parser rejects another group, private extra fields, fake readiness and inconsistent stage counts/actions',()=>{
    assert.equal(parseGroupSetup(raw(),id(1)).readiness,'review_only');
    const bad=[{...raw(),readiness:'ready'},{...raw(),student_names:['private']},{...raw(),next_action:'add_students'},
        {...raw(),students:{...raw().students,active:2}},{...raw(),instructor:{status:'unavailable',name:'foreign teacher'}},
        {...raw(),schedule:{status:'unavailable',sessions:raw().schedule.sessions}},{...raw(),issues:['prepare_sessions']}];
    bad.forEach(x=>assert.throws(()=>parseGroupSetup(x,id(1))));assert.throws(()=>parseGroupSetup(raw(id(2)),id(1)));
});
test('group change fences late responses and refresh failure clears old evidence',async()=>{
    const h=fixture();let resolve!:(x:ReturnType<typeof parseGroupSetup>)=>void;h.deps.read=()=>new Promise(r=>resolve=r);
    const first=h.c.select(id(1));h.deps.read=async groupId=>parseGroupSetup(raw(groupId),groupId);await h.c.select(id(2));resolve(parseGroupSetup(raw(),id(1)));await first;
    assert.equal(h.state().data?.group.id,id(2));h.deps.read=async()=>{throw Error('unavailable');};await h.c.refresh();assert.equal(h.state().phase,'error');assert.equal(h.state().data,null);h.c.dispose();
});
test('identity events and principal replacement invalidate the lifetime and prevent further requests',async()=>{
    for(const kind of ['event','principal']){const h=fixture();await h.c.select(id(1));if(kind==='event')h.event();else h.change();await h.c.refresh();assert.equal(h.state().phase,'session-ended');assert.equal(h.state().data,null);const count=h.calls.length;await h.c.select(id(2));assert.equal(h.calls.length,count);h.c.dispose();}
});
test('denial, deadline and disposal never preserve stale success or accept a late response',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const h=fixture();h.deps.read=async()=>{throw new ApiRequestError('not owner',403);};await h.c.select(id(1));assert.equal(h.state().phase,'denied');
    let resolve!:(x:ReturnType<typeof parseGroupSetup>)=>void;h.deps.read=()=>new Promise(r=>resolve=r);const work=h.c.refresh();t.mock.timers.tick(25000);assert.equal(h.state().phase,'error');resolve(parseGroupSetup(raw(),id(1)));await work;assert.equal(h.state().data,null);h.c.dispose();
});
test('actual group setup panel uses the canonical read, renders evidence/actions and hides private data on session change',async()=>{
    const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,originalLoad=mod._load,file=require.resolve('../features/groups/GroupSetup.tsx');
    const old={fetch:globalThis.fetch,storage:globalThis.localStorage,window:globalThis.window,React:(globalThis as any).React};
    const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],events:Array<{kind:string;fn:Function}>=[],calls:Array<{url:string;init:RequestInit}>=[],edits:string[]=[];
    let index=0,dirty=true,tree:any,Panel:any;
    (globalThis as any).React=React;(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-login':key==='currentUser'?JSON.stringify({id:'owner',role:'instructor',tenant_id:'tenant'}):null};
    (globalThis as any).window={addEventListener:(kind:string,fn:Function)=>events.push({kind,fn}),removeEventListener:()=>{}};
    globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});return new Response(JSON.stringify(raw()));};
    try{delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){
        if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(x:any)=>{const next=typeof x==='function'?x(hooks[i]):x;if(next!==hooks[i]){hooks[i]=next;dirty=true;}}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
        if(request==='react-router-dom'&&parent?.filename===file)return{Link:(p:any)=>React.createElement('a',{href:p.to},p.children)};
        if(request.startsWith('@/'))return originalLoad.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);
        return originalLoad.call(this,request,parent,main);
    };Panel=require(file).GroupSetup;mod._load=originalLoad;
        const props={groups:[{id:id(1),name:'Group'}],onEdit:(groupId:string)=>edits.push(groupId)};
        const settle=async()=>{for(let i=0;i<25;i++){if(dirty){index=0;dirty=false;tree=Panel(props);effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}};
        const find=(predicate:(n:any)=>boolean)=>{function visit(n:any):any{if(!n||typeof n!=='object')return null;if(predicate(n))return n;for(const c of[n.props?.children].flat(Infinity)){const r=visit(c);if(r)return r;}return null;}return visit(tree);};
        const html=()=>require('react-dom/server').renderToStaticMarkup(tree);
        await settle();assert.equal(calls.length,0);find(n=>n.type==='select').props.onChange({target:{value:id(1)}});await settle();
        assert.equal(calls[0].url,'/api/tenants/me/catalog/groups/'+id(1)+'/setup');assert.equal(calls[0].init.body,undefined);assert.equal(calls[0].init.cache,'no-store');
        assert.match(html(),/&lt;script&gt;Group/);assert.match(html(),/قيود نشطة الآن/);assert.match(html(),/ليست سجل اعتماد/);assert.match(html(),/href="\/instructor-students"/);assert.match(html(),/قيود أوفلاين/);assert.doesNotMatch(html(),/href="\/imports"/);
        find(n=>n.props?.children==='فتح إعداد المجموعة').props.onClick();assert.deepEqual(edits,[id(1)]);
        events.find(e=>e.kind==='storage')!.fn({key:'authToken'});await settle();assert.match(html(),/أُخفيت/);assert.doesNotMatch(html(),/Teacher|Lesson/);
    }finally{cleanups.forEach(fn=>fn?.());mod._load=originalLoad;delete require.cache[file];globalThis.fetch=old.fetch;(globalThis as any).localStorage=old.storage;(globalThis as any).window=old.window;(globalThis as any).React=old.React;}
});
test('current groups page and tenant composition wire the reviewed feature without reserved composition changes',()=>{
    const page=readFileSync(new URL('../pages/Groups.tsx',import.meta.url),'utf8'),server=readFileSync(new URL('../../server/src/routes/tenant-self.ts',import.meta.url),'utf8');
    assert.match(page,/<GroupSetup groups=\{state\.rows\.map/);assert.match(page,/onEdit=\{id => controller\.openEdit\(id\)\}/);
    assert.match(server,/router\.use\('\/catalog', createGroupSetupRouter\(\{ getConnection \}\)\)/);
});
