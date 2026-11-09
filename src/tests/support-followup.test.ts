import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {ApiRequestError} from '../lib/api-http';
import {createFollowupQueue,defaultFollowupFilters,initialFollowup,parseFollowupPage,readFollowup,type FollowupFilters} from '../features/support/follow-up';
const row=(n=1)=>({id:'ticket-'+n,ticket_number:'T-'+n,category:'technical',subject:'<script>Issue '+n+'</script>',status:'open',priority:'normal',created_at:'2026-11-01T10:00:00.000Z',updated_at:'2026-11-05T10:00:00.000Z'});
const page=(filters=defaultFollowupFilters())=>({tickets:[row()],next_cursor:null,as_of:'2026-11-07T12:00:00.000Z',filters});
function fixture(){let identity='A',state=initialFollowup();const calls:Array<{filters:FollowupFilters;after:string|null}>=[],deps={read:async(filters:FollowupFilters,after:string|null)=>{calls.push({filters,after});return parseFollowupPage(page(filters),filters,after);},readIdentity:()=>identity};
    const c=createFollowupQueue(deps);c.subscribe(x=>state=x);return{c,deps,calls,state:()=>state,identity:()=>{identity='B';}};}
const settle=()=>new Promise<void>(r=>setImmediate(r));
test('follow-up DTO enforces fixed projection, frozen time, exact filters and non-SLA evidence',()=>{
    const f=defaultFollowupFilters();assert.equal(parseFollowupPage(page(),f,null).tickets.length,1);
    for(const raw of [{...page(),actor:'private'},{...page(),filters:{...f,scope:'unassigned'}},{...page(),tickets:[{...row(),description:'private'}]},
        {...page(),tickets:[{...row(),status:'resolved'}]},{...page(),tickets:[{...row(),updated_at:'2026-11-07T11:00:00.000Z'}]},
        {...page(),tickets:[row(),row()]},{...page(),next_cursor:'cursor'},{...page(),as_of:'2026-11-07 12:00:00'}])assert.throws(()=>parseFollowupPage(raw,f,null));
});
test('queue requests only explicitly, suppresses duplicate loads, and only current displayed rows can open detail',async()=>{
    const h=fixture();assert.equal(h.calls.length,0);let resolve!:(x:ReturnType<typeof parseFollowupPage>)=>void,reads=0;h.deps.read=()=>{reads++;return new Promise(r=>resolve=r);};
    const work=h.c.refresh();await h.c.refresh();assert.equal(reads,1);assert.equal(h.state().phase,'loading');assert.equal(h.c.select('ticket-1'),null);resolve(parseFollowupPage(page(),defaultFollowupFilters(),null));await work;
    assert.equal(h.c.select('foreign'),null);assert.equal(h.c.select('ticket-1')?.id,'ticket-1');h.c.dispose();
});
test('changing filters cancels the old read, hides previous rows and fences late replies',async()=>{
    const h=fixture();let resolve!:(x:ReturnType<typeof parseFollowupPage>)=>void;h.deps.read=()=>new Promise(r=>resolve=r);const first=h.c.refresh();
    h.deps.read=async(filters,after)=>parseFollowupPage({...page(filters),tickets:[]},filters,after);h.c.filters({scope:'unassigned',status:'needs_support',min_hours:72});await settle();
    resolve(parseFollowupPage(page(),defaultFollowupFilters(),null));await first;assert.equal(h.state().filters.scope,'unassigned');assert.equal(h.state().page?.tickets.length,0);h.c.dispose();
});
test('local assignment or reply activity suspends browsing and resumes with a new first-page read',async()=>{
    const h=fixture();await h.c.refresh();h.c.suspend();assert.equal(h.state().phase,'suspended');assert.equal(h.c.select('ticket-1'),null);await h.c.refresh();assert.equal(h.calls.length,1);
    h.c.filters({scope:'unassigned',status:'waiting_on_user',min_hours:0});assert.equal(h.state().filters.scope,'mine');h.c.resume();await settle();assert.equal(h.calls.length,2);assert.equal(h.calls[1].after,null);h.c.dispose();
});
test('page replacement is bounded and rejects overlaps or a changed reference time',async()=>{
    const h=fixture(),f=defaultFollowupFilters(),first={...page(),tickets:Array.from({length:25},(_,i)=>row(i)),next_cursor:'opaque-cursor'};
    h.deps.read=async(filters,after)=>parseFollowupPage(after?{...page(),tickets:[row(30)]}:first,filters,after);await h.c.refresh();await h.c.next();assert.equal(h.state().page?.tickets.length,1);assert.equal(h.state().page?.tickets[0].id,'ticket-30');
    await h.c.refresh();h.deps.read=async()=>parseFollowupPage({...page(),tickets:[row(1)]},f,'opaque-cursor');await h.c.next();assert.equal(h.state().phase,'error');assert.equal(h.state().page,null);h.c.dispose();
});
test('denial, source failure, deadlines and silent identity loss never preserve old success',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    for(const error of [new ApiRequestError('denied',404),new ApiRequestError('missing index',503,'SUPPORT_FOLLOWUP_UNAVAILABLE'),Error('network')]){const h=fixture();await h.c.refresh();h.deps.read=async()=>{throw error;};await h.c.refresh();assert.equal(h.state().page,null);h.c.dispose();}
    const h=fixture();let resolve!:(x:ReturnType<typeof parseFollowupPage>)=>void;h.deps.read=()=>new Promise(r=>resolve=r);const work=h.c.refresh();t.mock.timers.tick(25000);assert.equal(h.state().phase,'error');resolve(parseFollowupPage(page(),defaultFollowupFilters(),null));await work;assert.equal(h.state().page,null);h.identity();assert.equal(h.c.select('ticket-1'),null);assert.equal(h.state().phase,'session-ended');h.c.dispose();
});
test('canonical follow-up transport sends only selected filters/cursor, login bearer and no-store',async()=>{
    const old={fetch:globalThis.fetch,storage:globalThis.localStorage},calls:Array<{url:string;init:RequestInit}>=[];
    (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-login':null};
    globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});return new Response(JSON.stringify(page()));};
    try{await readFollowup(defaultFollowupFilters(),null,new AbortController().signal);assert.equal(calls[0].url,'/api/support-tickets/follow-up?scope=mine&status=needs_support&min_hours=24');assert.equal(new Headers(calls[0].init.headers).get('authorization'),'Bearer synthetic-login');assert.equal(calls[0].init.body,undefined);assert.equal(calls[0].init.cache,'no-store');}
    finally{globalThis.fetch=old.fetch;(globalThis as any).localStorage=old.storage;}
});
test('actual follow-up list renders escaped evidence, filters, opens only displayed details and clears on activity',async()=>{
    const require=Module.createRequire(import.meta.url),React=require('react'),mod=Module as any,original=mod._load,file=require.resolve('../features/support/SupportFollowupQueue.tsx');
    const old={fetch:globalThis.fetch,storage:globalThis.localStorage,window:globalThis.window,React:(globalThis as any).React};
    const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],events:Array<{kind:string;fn:Function}>=[],opened:string[]=[],calls:string[]=[];
    let index=0,dirty=true,tree:any,Panel:any;
    (globalThis as any).React=React;(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-login':key==='currentUser'?JSON.stringify({id:'admin',role:'admin'}):null};
    (globalThis as any).window={addEventListener:(kind:string,fn:Function)=>events.push({kind,fn}),removeEventListener:()=>{}};
    globalThis.fetch=async(url)=>{calls.push(String(url));return new Response(JSON.stringify(page()));};
    try{delete require.cache[file];mod._load=function(request:string,parent:any,main:boolean){
        if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(x:any)=>{const next=typeof x==='function'?x(hooks[i]):x;if(next!==hooks[i]){hooks[i]=next;dirty=true;}}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
        if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);return original.call(this,request,parent,main);
    };Panel=require(file).FollowupList;mod._load=original;
        const props={busyActivity:false,revision:0,onOpen:(ticket:any)=>opened.push(ticket.id)};
        const render=async()=>{for(let i=0;i<25;i++){if(dirty){index=0;dirty=false;tree=Panel(props);effects.splice(0).forEach(fn=>fn());}await settle();if(!dirty)break;}};
        const find=(predicate:(n:any)=>boolean)=>{function visit(n:any):any{if(!n||typeof n!=='object')return null;if(predicate(n))return n;for(const c of[n.props?.children].flat(Infinity)){const r=visit(c);if(r)return r;}return null;}return visit(tree);};
        const html=()=>require('react-dom/server').renderToStaticMarkup(tree);
        await render();assert.equal(calls.length,1);assert.match(html(),/&lt;script&gt;Issue/);assert.match(html(),/ليست وعدًا بزمن استجابة/);find(n=>n.type==='button'&&n.props.className?.includes('text-right')).props.onClick();assert.deepEqual(opened,['ticket-1']);
        props.busyActivity=true;dirty=true;await render();assert.doesNotMatch(html(),/Issue 1/);assert.match(html(),/إجراء محلي/);
        props.busyActivity=false;props.revision++;dirty=true;await render();assert.equal(calls.length,2);
        events.find(e=>e.kind==='storage')!.fn({key:'authToken'});await render();assert.doesNotMatch(html(),/Issue 1/);assert.match(html(),/تغيرت الجلسة/);
    }finally{cleanups.forEach(fn=>fn?.());mod._load=original;delete require.cache[file];globalThis.fetch=old.fetch;(globalThis as any).localStorage=old.storage;(globalThis as any).window=old.window;(globalThis as any).React=old.React;}
});
test('actual Support page supplies existing activity and detail authorization rather than an alternate detail entry',()=>{
    const source=readFileSync(new URL('../pages/Support.tsx',import.meta.url),'utf8');assert.match(source,/isAdmin&&!sessionEnded\?<SupportFollowupQueue/);assert.match(source,/busyActivity=\{assignmentActivity>0\|\|submitting\|\|replyAttemptState.busy\|\|createAttemptState.busy\}/);assert.match(source,/revision=\{assignmentRevision\} onOpen=\{openTicket\}/);
});
