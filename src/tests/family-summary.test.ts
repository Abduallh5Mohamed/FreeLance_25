import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canAccessRoute } from '../auth/access-control';
import { ApiRequestError } from '../lib/api-http';
import { createFamilyController, familyTransport, initialFamily, parseFamilyLinks, parseFamilySummary } from '../features/family/family-summary';

const link = (id = 'link-one') => ({ id, tenant_id: 'tenant-one', student_enrollment_id: 'child-one', status: 'active' as const, version: 0, created_at: null });
const rawSummary = () => ({ checked_at: '2026-11-07T10:00:00.000Z',
    window: { from: '2026-10-31T10:00:00.000Z', now: '2026-11-07T10:00:00.000Z', to: '2026-11-14T10:00:00.000Z' },
    child: { name: '<script>child</script>', group: 'Group', course: 'Math' }, scope: 'current_group',
    attendance: { sessions: [{ id: 'past', title: 'Past lesson', starts_at: '2026-11-05T09:00:00.000Z', ends_at: '2026-11-05T10:00:00.000Z', state: 'unmarked' }],
        counts: { present: 0, late: 0, absent: 0, excused: 0, unmarked: 1 } },
    agenda: [{ id: 'next', title: 'Next lesson', starts_at: '2026-11-09T09:00:00.000Z', ends_at: '2026-11-09T10:00:00.000Z' }],
    next_action: 'confirm_unmarked', grades: { status: 'unavailable', reason: 'publication_contract_required' } });
const summary = () => parseFamilySummary(rawSummary());
function fixture() {
    let identity = 'session-A', event = () => {}, state = initialFamily();
    const calls: string[] = [], transport = {
        links: async () => { calls.push('links'); return [link(), link('link-two')]; },
        session: async (id: string) => { calls.push('session:' + id); return { token: 'private-scoped-token', expiresAt: new Date(Date.now() + 900000).toISOString() }; },
        summary: async (token: string) => { assert.equal(token, 'private-scoped-token'); calls.push('summary'); return summary(); },
    };
    const controller = createFamilyController({ transport, readPrincipal: () => identity, subscribeSession: fn => { event = fn; return () => {}; } });
    controller.subscribe(x => state = x);
    return { controller, transport, calls, state: () => state, event: () => event(), changeIdentity: () => { identity = 'session-B'; } };
}
test('strict family DTO rejects leaked private fields, inconsistent counts/actions, duplicates and unknown scopes', () => {
    assert.equal(summary().attendance.counts.unmarked, 1);
    const bad: unknown[] = [ { ...rawSummary(), phone: 'private' }, { ...rawSummary(), next_action: 'check_attendance' },
        { ...rawSummary(), scope: 'all_children' }, { ...rawSummary(), grades: { status: 'ready', score: 99 } },
        { ...rawSummary(), attendance: { ...rawSummary().attendance, counts: { ...rawSummary().attendance.counts, absent: 1 } } },
        { ...rawSummary(), agenda: [rawSummary().agenda[0], rawSummary().agenda[0]] },
        { ...rawSummary(), child: { ...rawSummary().child, parent_phone: 'private' } },
        { ...rawSummary(), scope: 'no_current_group', child: { name: 'Child', group: null, course: null } } ];
    bad.forEach(x => assert.throws(() => parseFamilySummary(x)));
    assert.throws(() => parseFamilyLinks([{ ...link(), contact_hash: 'hidden' }]));
    assert.throws(() => parseFamilyLinks([link(), link()]));
    assert.throws(() => parseFamilyLinks(Array.from({length:201}, (_,i) => link(String(i)))));
});
test('owned verified links must be explicitly selected; refresh failure removes the previous child evidence', async () => {
    const h = fixture(); await h.controller.loadLinks(); assert.equal(h.state().phase, 'choose'); assert.deepEqual(h.calls, ['links']);
    await h.controller.select('foreign'); assert.deepEqual(h.calls, ['links']);
    await h.controller.select('link-one'); assert.equal(h.state().phase, 'ready'); assert.equal(h.state().summary?.next_action, 'confirm_unmarked');
    assert.doesNotMatch(JSON.stringify(h.state()), /private-scoped-token/);
    h.transport.summary = async () => { throw Error('revoked'); }; await h.controller.refresh();
    assert.equal(h.state().phase, 'error'); assert.equal(h.state().summary, null); h.controller.dispose();
});
test('unavailable link service is distinct from an empty family and can recover', async () => {
    const h = fixture(), original = h.transport.links;
    h.transport.links = async () => { throw new ApiRequestError('Unavailable', 503); };
    await h.controller.loadLinks();
    assert.equal(h.state().phase, 'error');
    assert.equal(h.state().issue, 'unavailable');
    assert.equal(h.state().summary, null);
    h.transport.links = async () => [];
    await h.controller.loadLinks();
    assert.equal(h.state().phase, 'choose');
    assert.equal(h.state().issue, null);
    assert.deepEqual(h.state().links, []);
    h.transport.links = original;
    h.controller.dispose();
});

for (const status of [401, 403, 404]) test(`lost child access ${status} clears evidence and selection until discovery is repeated`, async () => {
    const h = fixture(); await h.controller.loadLinks(); await h.controller.select('link-one');
    h.transport.summary = async () => { throw new ApiRequestError('Lost access', status); };
    await h.controller.refresh();
    assert.equal(h.state().issue, 'access_lost');
    assert.equal(h.state().selected, null);
    assert.equal(h.state().summary, null);
    assert.equal(h.state().links.some(l => l.id === 'link-one'), false);
    const n = h.calls.length; await h.controller.select('link-one'); assert.equal(h.calls.length, n);
    await h.controller.loadLinks(); assert.equal(h.state().issue, null);
    h.controller.dispose();
});

test('switching a child fences late responses and never combines their evidence', async () => {
    const h = fixture(); await h.controller.loadLinks(); let resolve!: (x: ReturnType<typeof summary>) => void;
    h.transport.summary = () => new Promise(r => resolve = r);
    const first = h.controller.select('link-one'); await new Promise(r => setImmediate(r));
    h.transport.summary = async () => ({ ...summary(), child: { ...summary().child, name: 'Second child' } });
    await h.controller.select('link-two'); resolve(summary()); await first;
    assert.equal(h.state().selected, 'link-two'); assert.equal(h.state().summary?.child.name, 'Second child'); h.controller.dispose();
});
test('identity events and same-request principal replacement hide private data and stop further child requests', async () => {
    for (const kind of ['event','principal']) {
        const h = fixture(); await h.controller.loadLinks(); await h.controller.select('link-one');
        if (kind === 'event') h.event(); else { h.changeIdentity(); await h.controller.refresh(); }
        assert.equal(h.state().phase, 'session-ended'); assert.equal(h.state().summary, null); assert.equal(h.state().links.length, 0);
        const calls = h.calls.length; await h.controller.select('link-one'); assert.equal(h.calls.length, calls); h.controller.dispose();
    }
});
test('timeout, display expiry and background clearing require a fresh authorized read rather than showing stale success', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const h = fixture(); await h.controller.loadLinks(); await h.controller.select('link-one');
    t.mock.timers.tick(60000); assert.equal(h.state().phase, 'expired'); assert.equal(h.state().summary, null);
    await h.controller.refresh(); h.controller.clearView(); assert.equal(h.state().summary, null);
    let resolve!: (x: ReturnType<typeof summary>) => void; h.transport.summary = () => new Promise(r => resolve = r);
    const work = h.controller.refresh(); await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(25000);
    assert.equal(h.state().phase, 'error'); resolve(summary()); await work; assert.equal(h.state().summary, null); h.controller.dispose();
});
test('family route is a logged-in self-service page and billing-only identities remain denied', () => {
    for (const role of ['student','teacher','instructor','staff','admin']) assert.equal(canAccessRoute({role}, '/family'), true);
    assert.equal(canAccessRoute(null, '/family'), false); assert.equal(canAccessRoute({role:'instructor',billing_only:true}, '/family'), false);
});
test('canonical transport separates login and scoped credentials without storage, URL tokens or workspace selectors', async () => {
    const original = { fetch: globalThis.fetch, storage: globalThis.localStorage }, calls: Array<{url:string; init:RequestInit}> = [];
    (globalThis as any).localStorage = { getItem: (key:string) => key === 'authToken' ? 'ordinary-login-token' : null, setItem: () => { throw Error('must not store'); } };
    globalThis.fetch = async (url, init = {}) => {
        calls.push({url:String(url),init});
        return new Response(JSON.stringify(String(url).endsWith('/parent-links') ? [link()] : String(url).endsWith('/session')
            ? {token:'pv1.cGF5.c2ln', expires_at:new Date(Date.now()+899000).toISOString(), expires_in:899} : rawSummary()));
    };
    try {
        const signal = new AbortController().signal; await familyTransport.links(signal); const s = await familyTransport.session('link-one',signal); await familyTransport.summary(s.token,signal);
        assert.deepEqual(calls.map(c=>c.url), ['/api/parent-links','/api/parent-links/link-one/session','/api/parent/family-summary']);
        assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer ordinary-login-token');
        assert.equal(new Headers(calls[2].init.headers).get('authorization'), 'Bearer pv1.cGF5.c2ln');
        assert.deepEqual([...new Headers(calls[2].init.headers).keys()], ['authorization']);
        assert.equal(calls[2].init.cache,'no-store'); assert.equal(calls[2].init.credentials,'omit'); assert.equal(calls[2].init.redirect,'error');
        assert.equal(calls[2].init.body, undefined);
    } finally { globalThis.fetch=original.fetch; (globalThis as any).localStorage=original.storage; }
});

// Mount the actual page hooks and click handlers over the canonical HTTP
// transports. This is component evidence, not an actual-browser acceptance.
test('actual family page selects an owned child, renders escaped evidence and clears on background/session events', async () => {
    const require = Module.createRequire(import.meta.url), React = require('react'), mod = Module as any, originalLoad = mod._load;
    const file = require.resolve('../pages/Family.tsx');
    const old = { fetch:globalThis.fetch, storage:globalThis.localStorage, window:globalThis.window, document:globalThis.document, React:(globalThis as any).React };
    const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[],events:Array<{kind:string;fn:Function}>=[], calls:string[]=[];
    let index=0,dirty=true,tree:any,Page:any;
    (globalThis as any).React=React;
    (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'ordinary-login-token':key==='currentUser'?JSON.stringify({id:'parent',role:'student'}):null};
    (globalThis as any).window={addEventListener:(kind:string,fn:Function)=>events.push({kind,fn}),removeEventListener:()=>{}};
    (globalThis as any).document={visibilityState:'visible',addEventListener:(kind:string,fn:Function)=>events.push({kind,fn}),removeEventListener:()=>{}};
    globalThis.fetch=async(url)=>{const u=String(url);calls.push(u);return new Response(JSON.stringify(u.endsWith('/parent-links')?[link()]:u.endsWith('/session')?{token:'pv1.cGF5.c2ln',expires_at:new Date(Date.now()+899000).toISOString(),expires_in:899}:rawSummary()));};
    try {
        delete require.cache[file];
        mod._load=function(request:string,parent:any,main:boolean){
            if(request==='react'&&parent?.filename===file)return{...React,useState:(v:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return[hooks[i],(next:any)=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;dirty=true;}];},useRef:(v:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:v});},useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||deps.some((x,j)=>x!==hooks[i][j])){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
            if(request==='react-router-dom'&&parent?.filename===file)return{Link:(p:any)=>React.createElement('a',{href:p.to},p.children)};
            if(request.startsWith('@/'))return originalLoad.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);
            return originalLoad.call(this,request,parent,main);
        };
        Page=require(file).default;mod._load=originalLoad;
        const settle=async()=>{for(let i=0;i<25;i++){if(dirty){index=0;dirty=false;tree=Page();effects.splice(0).forEach(fn=>fn());}await new Promise(r=>setImmediate(r));if(!dirty)break;}};
        const find=(predicate:(n:any)=>boolean)=>{function visit(n:any):any{if(!n||typeof n!=='object')return null;if(predicate(n))return n;for(const c of [n.props?.children].flat(Infinity)){const r=visit(c);if(r)return r;}return null;}return visit(tree);};
        const html=()=>require('react-dom/server').renderToStaticMarkup(tree);
        await settle();assert.deepEqual(calls,['/api/parent-links']);
        find(n=>n.type==='select').props.onChange({target:{value:'link-one'}});await settle();
        assert.match(html(),/&lt;script&gt;child/);assert.match(html(),/لم يسجل الحضور/);assert.match(html(),/Next lesson/);
        assert.doesNotMatch(html(),/ordinary-login-token|pv1\.|child-one|tenant-one/);
        (globalThis as any).document.visibilityState='hidden';events.find(e=>e.kind==='visibilitychange')!.fn();await settle();assert.doesNotMatch(html(),/Past lesson|Next lesson/);
        events.find(e=>e.kind==='storage')!.fn({key:'authToken'});await settle();assert.match(html(),/أُخفيت بيانات الأسرة/);assert.equal(find(n=>n.type==='select'),null);
    } finally {
        cleanups.forEach(fn=>fn?.());mod._load=originalLoad;delete require.cache[file];globalThis.fetch=old.fetch;
        (globalThis as any).localStorage=old.storage;(globalThis as any).window=old.window;(globalThis as any).document=old.document;(globalThis as any).React=old.React;
    }
});
