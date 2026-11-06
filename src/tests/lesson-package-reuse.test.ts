import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError } from '../lib/api-http';
import { canonicalReuseSelection, createPackageReuse, initialPackageReuse, packageReuseTransport, parseReuseReview, type PackageReuseState } from '../features/catalog/lesson-package-reuse';
const id = (n: number) => `b3200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selected = [{ kind: 'material' as const, source_id: id(10) }];
const review = () => ({ review_token: 'a'.repeat(64), can_apply: true, projected_media_count: 1, items: [{ ...selected[0], title: '<script>source</script>', display_order: 0, audience: 'course', source_state: 'published', outcome: 'add', conflict: null }] });
const receipt = () => ({ operation_id: id(90), created: 1, existing: 0 });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { resolve, promise }; };
function fixture() {
    const s = { principal: 'A', event: () => { }, calls: [] as string[], apply: async () => ({ ...receipt(), replayed: false }), readReceipt: async () => ({ operation: receipt() } as any) };
    const controller = createPackageReuse({ readPrincipal: () => s.principal, subscribeSession: fn => { s.event = fn; return () => { }; }, newOperationId: () => id(90),
        review: async () => { s.calls.push('review'); return review(); }, apply: async () => { s.calls.push('apply'); return s.apply(); }, status: async () => { s.calls.push('status'); return s.readReceipt(); } });
    let latest = initialPackageReuse();
    controller.subscribe(value => { latest = value; });
    return { s, controller, latest: () => latest };
}
test('review parser is exact, selected-reference bound and checks can_apply consistency', () => {
    assert.equal(parseReuseReview(review(), selected).items[0].title, review().items[0].title);
    for (const changed of [{ ...review(), can_apply: false }, { ...review(), projected_media_count: 21 }, { ...review(), secret: 'private' }, { ...review(), items: [{ ...review().items[0], source_id: id(99) }] }, { ...review(), items: [{ ...review().items[0], file_url: 'private' }] }])
        assert.throws(() => parseReuseReview(changed, selected));
    assert.throws(() => canonicalReuseSelection([...selected, ...selected]));
    assert.throws(() => canonicalReuseSelection([]));
});
test('apply needs current server review and explicit approval; confirmed result does not claim refreshed lists', async () => {
    const h = fixture();
    await h.controller.apply(true);
    assert.deepEqual(h.s.calls, []);
    await h.controller.review(selected);
    await h.controller.apply(false);
    assert.deepEqual(h.s.calls, ['review']);
    await h.controller.apply(true);
    assert.equal(h.latest().phase, 'saved');
    assert.equal(h.latest().result!.created, 1);
    assert.equal(h.latest().review, null);
    assert.deepEqual(h.s.calls, ['review', 'apply']);
    h.controller.dispose();
});
test('changing selection clears approval before a new request', async () => { const h = fixture(); await h.controller.review(selected); h.controller.clear(); await h.controller.apply(true); assert.equal(h.latest().review, null); assert.deepEqual(h.s.calls, ['review']); h.controller.dispose(); });
for (const mode of ['network', 'server', 'malformed'])
    test(`uncertain ${mode} write freezes apply and review; GET receipt alone recovers`, async () => {
        const h = fixture();
        h.s.apply = async () => { if (mode === 'network')
            throw Error('lost'); if (mode === 'server')
            throw new ApiRequestError('unknown', 500, 'PERSISTENCE_UNCERTAIN'); return { ...receipt(), created: 23, replayed: false }; };
        await h.controller.review(selected);
        await h.controller.apply(true);
        assert.equal(h.latest().phase, 'uncertain');
        assert.equal(h.latest().operationId, id(90));
        await h.controller.review(selected);
        await h.controller.apply(true);
        assert.deepEqual(h.s.calls, ['review', 'apply']);
        await h.controller.recover();
        assert.equal(h.latest().phase, 'saved');
        assert.deepEqual(h.s.calls, ['review', 'apply', 'status']);
        h.controller.dispose();
    });
test('missing, malformed and failed recovery preserve uncertain state', async () => {
    const h = fixture();
    h.s.apply = async () => { throw Error('lost'); };
    await h.controller.review(selected);
    await h.controller.apply(true);
    for (const response of [{ operation: null }, { operation: { ...receipt(), operation_id: id(99) } }]) {
        h.s.readReceipt = async () => response;
        await h.controller.recover();
        assert.equal(h.latest().phase, 'uncertain');
        assert.equal(h.latest().result, null);
    }
    h.s.readReceipt = async () => { throw Error('offline'); };
    await h.controller.recover();
    assert.equal(h.latest().phase, 'uncertain');
    h.controller.dispose();
});
test('definite conflict drops stale review and requires another review', async () => {
    const h = fixture();
    h.s.apply = async () => { throw new ApiRequestError('changed', 409, 'PACKAGE_REVIEW_CHANGED'); };
    await h.controller.review(selected);
    await h.controller.apply(true);
    assert.equal(h.latest().phase, 'error');
    assert.equal(h.latest().review, null);
    await h.controller.apply(true);
    assert.deepEqual(h.s.calls, ['review', 'apply']);
    h.controller.dispose();
});
for (const reason of ['event', 'principal', 'dispose'])
    test(`late successful write does not expose result after ${reason}`, async () => {
        const h = fixture(), pending = deferred();
        h.s.apply = () => pending.promise;
        await h.controller.review(selected);
        const run = h.controller.apply(true);
        if (reason === 'event')
            h.s.event();
        if (reason === 'principal')
            h.s.principal = 'B';
        if (reason === 'dispose')
            h.controller.dispose();
        pending.resolve({ ...receipt(), replayed: false });
        await run;
        assert.equal(h.latest().result, null);
        assert.notEqual(h.latest().phase, 'saved');
        h.controller.dispose();
    });
test('write timeout becomes uncertain, rejects late success and recovers through same operation id', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(), pending = deferred();
    h.s.apply = () => pending.promise;
    await h.controller.review(selected);
    const run = h.controller.apply(true);
    context.mock.timers.tick(25000);
    assert.equal(h.latest().phase, 'uncertain');
    pending.resolve({ ...receipt(), replayed: false });
    await run;
    assert.equal(h.latest().phase, 'uncertain');
    await h.controller.recover();
    assert.equal(h.latest().phase, 'saved');
    h.controller.dispose();
});
test('actual canonical transport fixes source/destination, posts only explicit inputs, status GET has no write body', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage }, calls: any[] = [];
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : null };
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({})); };
    try {
        const transport = packageReuseTransport(id(1), id(2), id(3), id(4)), signal = new AbortController().signal;
        await transport.review(selected, signal);
        await transport.apply(selected, 'a'.repeat(64), id(90), signal);
        await transport.status(id(90), signal);
        assert.equal(calls[0].url, `/api/tenants/me/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/package-reuse/review`);
        assert.deepEqual(JSON.parse(calls[1].init.body), { source_lesson_id: id(4), selections: selected, review_token: 'a'.repeat(64), operation_id: id(90) });
        assert.equal(calls[2].init.method, 'GET');
        assert.equal(calls[2].init.body, undefined);
        assert.ok(calls.every(call => new Headers(call.init.headers).get('X-Tenant-Id') === null));
        assert.throws(() => packageReuseTransport(id(1), id(2), id(3), id(3)));
    }
    finally {
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
    }
});
const props = { courseId: id(1), unitId: id(2), lessonId: id(3), sourceLessonId: id(4), choices: [{ kind: 'material', sourceId: id(10), title: '<script>source</script>', order: 0, status: 'review', issues: [] }] };
function loadPanel(state: PackageReuseState, confirmed = false) {
    const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load, file = require.resolve('../features/catalog/LessonPackageReuse.tsx');
    const effects: Function[] = [], snapshots: any[] = [], ref = { current: null };
    try {
        delete require.cache[file];
        module._load = function (request: string, parent: any, main: boolean) {
            if (request === 'react' && parent?.filename === file)
                return { ...React, useState: (initial: any) => [typeof initial === 'function' ? state : Array.isArray(initial) ? selected : confirmed, (next: any) => snapshots.push(next)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) };
            if (request.startsWith('@/'))
                return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), request.slice(2)), parent, main);
            return original.call(this, request, parent, main);
        };
        return { component: require(file), React, require, effects, snapshots };
    }
    finally {
        module._load = original;
        delete require.cache[file];
    }
}
function find(node: any, label: string): any { if (!node || typeof node !== 'object')
    return null; if (node.props?.children === label)
    return node; for (const child of [node.props?.children].flat(4)) {
    const found = find(child, label);
    if (found)
        return found;
} return null; }
test('actual UI escapes titles, requires confirmation and truthfully describes source-only reuse and stale lists', () => {
    const previous = (globalThis as any).React;
    try {
        const state = { ...initialPackageReuse(), phase: 'reviewed' as const, review: parseReuseReview(review(), selected) }, h = loadPanel(state);
        (globalThis as any).React = h.React;
        const tree = h.component.LessonPackageReuse(props), html = h.require('react-dom/server').renderToStaticMarkup(tree);
        assert.match(html, /&lt;script&gt;source&lt;\/script&gt;/);
        assert.match(html, /لا يُنسخ المحتوى نفسه/);
        assert.match(html, /لا يلغي عملية حفظ/);
        assert.equal(find(tree, 'تأكيد نسخ المراجع التي تمت مراجعتها').props.disabled, true);
        const saved = loadPanel({ ...initialPackageReuse(), phase: 'saved', result: receipt(), operationId: id(90) });
        (globalThis as any).React = saved.React;
        assert.match(saved.require('react-dom/server').renderToStaticMarkup(saved.component.LessonPackageReuse(props)), /حدّث أقسام الحصة والمقارنة/);
    }
    finally {
        (globalThis as any).React = previous;
    }
});
for (const uncertain of [false, true])
    test(`actual mounted review/apply callbacks ${uncertain ? 'recover lost reply using GET only' : 'send explicit reviewed operation'}`, async () => {
        const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
        let cleanup: Function | undefined;
        const calls: any[] = [];
        (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
        (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
        globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), init });
            if (String(url).endsWith('/review'))
                return new Response(JSON.stringify(review()));
            if (init?.method === 'POST' && uncertain)
                throw Error('lost response');
            const op = init?.method === 'POST' ? JSON.parse(String(init.body)).operation_id : String(url).split('/').at(-1);
            return new Response(JSON.stringify(init?.method === 'POST' ? { ...receipt(), operation_id: op, replayed: false } : { operation: { ...receipt(), operation_id: op } }));
        };
        try {
            const state = initialPackageReuse(), h = loadPanel(state, true);
            const locks:boolean[]=[], mountedProps={...props,onLockChange:(locked:boolean)=>locks.push(locked)};
            (globalThis as any).React = h.React;
            let tree = h.component.LessonPackageReuse(mountedProps);
            cleanup = h.effects[0]();
            assert.equal(calls.length, 0);
            find(tree, 'مراجعة المراجع المختارة على الخادم').props.onClick();
            await new Promise(resolve => setImmediate(resolve));
            Object.assign(state, h.snapshots.filter(x => x && typeof x === 'object').at(-1));
            assert.equal(state.phase, 'reviewed');
            tree = h.component.LessonPackageReuse(mountedProps);
            find(tree, 'تأكيد نسخ المراجع التي تمت مراجعتها').props.onClick();
            await new Promise(resolve => setImmediate(resolve));
            Object.assign(state, h.snapshots.filter(x => x && typeof x === 'object').at(-1));
            assert.equal(state.phase, uncertain ? 'uncertain' : 'saved');
            assert.ok(locks.includes(true));
            assert.equal(locks.at(-1),uncertain);
            if (uncertain) {
                tree = h.component.LessonPackageReuse(mountedProps);
                find(tree, 'التحقق من نتيجة العملية دون إعادة الحفظ').props.onClick();
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(calls[2].init.method, 'GET');
                assert.equal(calls[2].init.body, undefined);
                assert.equal(h.snapshots.filter(x => x && typeof x === 'object').at(-1).phase, 'saved');
                assert.equal(locks.at(-1),false);
            }
            assert.equal(calls.filter(row => row.init.method === 'POST').length, 2);
            h.require('../lib/session-events').notifySessionChange('scope');
            assert.equal(h.snapshots.filter(x => x && typeof x === 'object').at(-1).result, null);
        }
        finally {
            cleanup?.();
            globalThis.fetch = previous.fetch;
            (globalThis as any).localStorage = previous.storage;
            (globalThis as any).window = previous.window;
            (globalThis as any).React = previous.React;
        }
    });
