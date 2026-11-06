import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError } from '../lib/api-http';
import { createAnnouncementEditor, initialAnnouncementEditor, lessonAnnouncementTransport, parseLessonAnnouncement, parseAnnouncementPreview, parseAnnouncementSources } from '../features/catalog/lesson-announcements';
const id = (n: number) => `d2900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = () => ({ source_id: id(5), title: 'إعلان <script>خاص</script>', source_state: 'draft', group_id: id(6), group_name: 'مجموعة المقرر' });
const current = () => ({ ...source(), content_id: id(4), student_visibility: 'unconfigured' });
const preview = () => ({ ...current(), body: 'تفاصيل <script>لا تنفّذ</script>', candidate_enrollments: 3, course_published: true, lesson_active: true, lesson_released: false, prerequisite_required: true, previewed_at: '2026-11-06T12:00:00.000Z', delivery_status: 'unconfigured' });
const deferred = () => { let resolve!: (x: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const s = { principal: 'A', event: () => { }, row: null as any, calls: [] as string[] };
    const deps = { readPrincipal: () => s.principal, subscribeSession: (fn: () => void) => { s.event = fn; return () => { s.event = () => { }; }; }, read: async (_signal: AbortSignal) => { s.calls.push('read'); return { announcement: s.row }; }, sources: async (_cursor: string | null, _signal: AbortSignal) => { s.calls.push('sources'); return { sources: [source()], next_cursor: null }; }, attach: async (_id: string, _signal: AbortSignal) => { s.calls.push('attach'); s.row = current(); return { announcement: s.row, unchanged: false }; }, detach: async (_id: string, _signal: AbortSignal) => { s.calls.push('detach'); s.row = null; return { detached: true }; }, preview: async (_id: string, _signal: AbortSignal) => { s.calls.push('preview'); return { preview: preview() }; } };
    return { s, deps, controller: createAnnouncementEditor(deps) };
}
test('private fixed parsers reject student recipients, delivery grants, wrong source and partial counts', () => {
    const value = parseLessonAnnouncement({ announcement: current() })!;
    assert.equal(parseAnnouncementPreview({ preview: preview() }, value).candidate_enrollments, 3);
    for (const change of [{ student_visibility: 'published' }, { source_state: 'unknown' }, { recipient_ids: ['student'] }, { group_id: null }])
        assert.throws(() => parseLessonAnnouncement({ announcement: { ...current(), ...change } }));
    for (const change of [{ source_id: id(99) }, { group_id: id(90) }, { candidate_enrollments: 501 }, { body: 'x'.repeat(4001) }, { previewed_at: '2026-02-30T00:00:00.000Z' }, { delivery_status: 'delivered' }, { recipients: ['private'] }])
        assert.throws(() => parseAnnouncementPreview({ preview: { ...preview(), ...change } }, value));
    assert.throws(() => parseAnnouncementSources({ sources: [source(), source()], next_cursor: null }));
    assert.throws(() => parseAnnouncementSources({ sources: [{ ...source(), body: 'private' }], next_cursor: null }));
});
test('refresh/attach/preview/detach are explicit, and none publishes or sends an announcement', async () => {
    const h = fixture();
    assert.equal(h.s.calls.length, 0);
    await h.controller.load();
    assert.deepEqual(h.s.calls, ['read', 'sources']);
    await h.controller.attach(id(5));
    await h.controller.preview();
    assert.equal(h.controller.getState().preview!.candidate_enrollments, 3);
    await h.controller.detach();
    assert.equal(h.controller.getState().current, null);
    assert.deepEqual(h.s.calls, ['read', 'sources', 'attach', 'preview', 'detach']);
    h.controller.dispose();
});
for (const kind of ['attach', 'detach'] as const)
    test(`unknown ${kind} freezes writes until fresh read without replay`, async () => {
        const h = fixture();
        await h.controller.load();
        if (kind === 'detach')
            await h.controller.attach(id(5));
        const original = h.deps[kind];
        (h.deps as any)[kind] = async (...args: any[]) => { await (original as any)(...args); throw new ApiRequestError('unknown', 500, 'PERSISTENCE_UNCERTAIN'); };
        await (kind === 'attach' ? h.controller.attach(id(5)) : h.controller.detach());
        assert.equal(h.controller.getState().uncertain, true);
        const count = h.s.calls.filter(x => x === kind).length;
        await h.controller.attach(id(5));
        await h.controller.detach();
        assert.equal(h.s.calls.filter(x => x === kind).length, count);
        await h.controller.load();
        assert.equal(h.controller.getState().uncertain, false);
        assert.equal(Boolean(h.controller.getState().current), kind === 'attach');
        h.controller.dispose();
    });
for (const trigger of ['event', 'principal', 'dispose'])
    test(`late ${trigger} preview cannot restore private body or audience`, async () => {
        const h = fixture();
        await h.controller.load();
        await h.controller.attach(id(5));
        const pending = deferred();
        h.deps.preview = async () => pending.promise;
        const work = h.controller.preview();
        if (trigger === 'event')
            h.s.event();
        else if (trigger === 'principal')
            h.s.principal = 'B';
        else
            h.controller.dispose();
        pending.resolve({ preview: preview() });
        await work;
        assert.equal(h.controller.getState().preview, null);
        assert.equal(h.controller.getState().current, null);
        h.controller.dispose();
    });
test('single flight protects writes and a malformed acknowledgement is uncertain rather than confirmed', async () => {
    const h = fixture();
    await h.controller.load();
    const pending = deferred();
    let count = 0;
    h.deps.attach = async () => { count++; return pending.promise; };
    const first = h.controller.attach(id(5));
    await h.controller.attach(id(5));
    assert.equal(count, 1);
    pending.resolve({ announcement: { ...current(), source_id: id(90) }, unchanged: false });
    await first;
    assert.equal(h.controller.getState().uncertain, true);
    assert.equal(h.controller.getState().current, null);
    h.controller.dispose();
});
test('authority denial clears all private rows and preview', async () => {
    const h = fixture();
    await h.controller.load();
    await h.controller.attach(id(5));
    await h.controller.preview();
    h.deps.preview = async () => { throw new ApiRequestError('forbidden', 403); };
    await h.controller.preview();
    assert.equal(h.controller.getState().current, null);
    assert.equal(h.controller.getState().options.length, 0);
    assert.equal(h.controller.getState().preview, null);
    h.controller.dispose();
});
test('timeout stops late preview state and never issues a follow-up operation', async () => {
    const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
    let expire = () => { };
    (globalThis as any).setTimeout = (fn: () => void) => { expire = fn; return 1; };
    (globalThis as any).clearTimeout = () => { };
    const h = fixture();
    try {
        await h.controller.load();
        await h.controller.attach(id(5));
        const pending = deferred();
        h.deps.preview = async () => pending.promise;
        const work = h.controller.preview();
        expire();
        await work;
        assert.equal(h.controller.getState().phase, 'error');
        pending.resolve({ preview: preview() });
        await new Promise(r => setImmediate(r));
        assert.equal(h.controller.getState().preview, null);
    }
    finally {
        h.controller.dispose();
        globalThis.setTimeout = oldSet;
        globalThis.clearTimeout = oldClear;
    }
});
test('canonical transports are owner no-store paths, with no source body update or publish/delivery action', async () => {
    const oldFetch = globalThis.fetch, oldStorage = globalThis.localStorage, calls: any[] = [];
    (globalThis as any).localStorage = { getItem: () => 'synthetic' };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
    try {
        const t = lessonAnnouncementTransport(id(1), id(2), id(3)), s = new AbortController().signal;
        await t.read(s);
        await t.sources(id(20), s);
        await t.attach(id(5), s);
        await t.preview(id(4), s);
        await t.detach(id(4), s);
        assert.deepEqual(calls.map(x => x.init.method), ['GET', 'GET', 'POST', 'GET', 'DELETE']);
        assert.deepEqual(JSON.parse(calls[2].init.body), { source_id: id(5) });
        for (const c of calls) {
            assert.equal(c.init.cache, 'no-store');
            assert.equal(new Headers(c.init.headers).get('Authorization'), 'Bearer synthetic');
            assert.ok(!String(c.url).includes('/publish'));
            assert.ok(!String(c.url).includes('/notifications'));
        }
    }
    finally {
        globalThis.fetch = oldFetch;
        (globalThis as any).localStorage = oldStorage;
    }
});
function loadPanel(state: any) { const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load, file = require.resolve('../features/catalog/LessonAnnouncementManager.tsx'), effects: Function[] = [], snapshots: any[] = [], ref = { current: null }; try {
    delete require.cache[file];
    module._load = function (name: string, parent: any, main: boolean) { if (name === 'react' && parent?.filename === file)
        return { ...React, useState: (initial: any) => [typeof initial === 'function' ? state : initial, (next: any) => snapshots.push(next)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) }; if (name.startsWith('@/'))
        return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main); return original.call(this, name, parent, main); };
    return { component: require(file), effects, snapshots, React, require };
}
finally {
    module._load = original;
    delete require.cache[file];
} }
test('actual preview escapes title/body and labels potential group count without a publish or send button', () => {
    const previous = (globalThis as any).React;
    try {
        const h = loadPanel({ ...initialAnnouncementEditor(), phase: 'ready', current: current(), preview: preview() });
        (globalThis as any).React = h.React;
        const html = h.require('react-dom/server').renderToStaticMarkup(h.component.LessonAnnouncementEditor({ courseId: id(1), unitId: id(2), lessonId: id(3) }));
        assert.match(html, /&lt;script&gt;/);
        assert.match(html, /الالتحاقات النشطة المرشحة/);
        assert.match(html, /المعاينة وحدها لا تنشر الإعلان ولا ترسل رسالة/);
        assert.ok(!html.includes('/publish'));
        assert.ok(!html.includes('recipient_ids'));
    }
    finally {
        (globalThis as any).React = previous;
    }
});
test('actual owner effect and preview callback use canonical reads and clear on session change', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React }, calls: any[] = [];
    let cleanup: Function | undefined;
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(String(url).endsWith('/preview') ? { preview: preview() } : String(url).endsWith('/available-sources') ? { sources: [source()], next_cursor: null } : { announcement: current() })); };
    try {
        const h = loadPanel({ ...initialAnnouncementEditor(), phase: 'ready', current: current() });
        (globalThis as any).React = h.React;
        const tree = h.component.LessonAnnouncementEditor({ courseId: id(1), unitId: id(2), lessonId: id(3) });
        cleanup = h.effects[0]();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 2);
        const find = (node: any): any => { if (!node || typeof node !== 'object')
            return null; if (node.props?.children === 'معاينة النص والجمهور المرشح')
            return node; for (const child of [node.props?.children].flat(3)) {
            const found = find(child);
            if (found)
                return found;
        } return null; };
        find(tree).props.onClick();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 3);
        assert.ok(calls.every(x => x.init.method === 'GET'));
        assert.equal(h.snapshots.at(-1).preview.candidate_enrollments, 3);
        h.require('../lib/session-events').notifySessionChange('scope');
        assert.equal(h.snapshots.at(-1).preview, null);
        assert.equal(h.snapshots.at(-1).current, null);
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
