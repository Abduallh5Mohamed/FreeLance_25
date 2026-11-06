import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageSources, initialPackageSources, packageSourceTransport, type PackageSourceRow } from '../features/catalog/lesson-package-sources';
import { createPackagePreview, initialPackagePreview, lessonPackageReader } from '../features/catalog/lesson-package-preview';
const id = (n: number) => `b3300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, status: 'active' | 'archived' = 'active'): PackageSourceRow => ({ id: id(n), title: '<script>source</script>', status });
const empty = () => ({ materials: [], videos: [], activities: [], announcement: null, quizPin: null });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const s = { principal: 'A', event: () => { }, calls: [] as any[], unitReader: async (_cursor: string | null, _signal: AbortSignal) => ({ rows: [row(2), row(5), row(6, 'archived')], cursor: 'u-next' as string | null }),
        lessonReader: async (_unit: string, _cursor: string | null, _signal: AbortSignal) => ({ rows: [row(3), row(4), row(7, 'archived')], cursor: 'l-next' as string | null }) };
    const controller = createPackageSources({ destinationId: id(3), readPrincipal: () => s.principal, subscribeSession: fn => { s.event = fn; return () => { }; },
        units: (cursor, signal) => { s.calls.push({ kind: 'units', cursor, signal }); return s.unitReader(cursor, signal); },
        lessons: (unit, cursor, signal) => { s.calls.push({ kind: 'lessons', unit, cursor, signal }); return s.lessonReader(unit, cursor, signal); } });
    let latest = initialPackageSources();
    controller.subscribe(value => { latest = value; });
    return { s, controller, latest: () => latest };
}
test('loads one deliberate page, only selected active units, and never enumerates all lessons', async () => {
    const h = fixture();
    assert.equal(h.s.calls.length, 0);
    await h.controller.firstUnits();
    assert.equal(h.s.calls.length, 1);
    for (const invalid of [id(90), id(6), ''])
        await h.controller.chooseUnit(invalid);
    assert.equal(h.s.calls.length, 1);
    await h.controller.chooseUnit(id(5));
    assert.equal(h.s.calls.length, 2);
    assert.equal(h.s.calls[1].unit, id(5));
    h.controller.chooseLesson(id(3));
    assert.equal(h.latest().chosen, null);
    h.controller.chooseLesson(id(7));
    assert.equal(h.latest().chosen, null);
    h.controller.chooseLesson(id(4));
    assert.deepEqual(h.latest().chosen, { unitId: id(5), lessonId: id(4), title: row(4).title });
    h.controller.dispose();
});
for (const action of ['unit', 'units-page', 'lessons-page', 'refresh'])
    test(`${action} clears chosen source before loading, so old child/review is unmounted`, async () => {
        const h = fixture();
        await h.controller.firstUnits();
        await h.controller.chooseUnit(id(2));
        h.controller.chooseLesson(id(4));
        const pending = deferred();
        h.s.unitReader = () => pending.promise;
        h.s.lessonReader = () => pending.promise;
        const run = action === 'unit' ? h.controller.chooseUnit(id(5)) : action === 'units-page' ? h.controller.nextUnits() : action === 'lessons-page' ? h.controller.nextLessons() : h.controller.firstUnits();
        assert.equal(h.latest().chosen, null);
        assert.equal(h.latest().lessons.length, 0);
        pending.resolve({ rows: [row(10)], cursor: null });
        await run;
        assert.equal(h.latest().chosen, null);
        h.controller.dispose();
    });
test('paging replaces rows, forwards exact cursor and allows returning to first page without cursor history growth', async () => {
    const h = fixture();
    await h.controller.firstUnits();
    h.s.unitReader = async () => ({ rows: [row(8)], cursor: null });
    await h.controller.nextUnits();
    assert.equal(h.s.calls.at(-1).cursor, 'u-next');
    assert.deepEqual(h.latest().units.map(row => row.id), [id(8)]);
    await h.controller.nextUnits();
    assert.equal(h.s.calls.length, 2);
    await h.controller.firstUnits();
    assert.equal(h.s.calls.at(-1).cursor, null);
    h.controller.dispose();
});
test('save/uncertainty lock prevents changes and reads even through old controller callbacks', async () => {
    const h = fixture();
    await h.controller.firstUnits();
    await h.controller.chooseUnit(id(2));
    h.controller.chooseLesson(id(4));
    h.controller.setLocked(true);
    await h.controller.firstUnits();
    await h.controller.nextUnits();
    await h.controller.chooseUnit(id(5));
    await h.controller.nextLessons();
    h.controller.chooseLesson('');
    assert.equal(h.s.calls.length, 2);
    assert.equal(h.latest().chosen!.lessonId, id(4));
    h.controller.setLocked(false);
    await h.controller.chooseUnit(id(5));
    assert.equal(h.latest().chosen, null);
    h.controller.dispose();
});
for (const reason of ['event', 'principal', 'dispose', 'switch'])
    test(`late lesson page after ${reason} cannot restore old source`, async () => {
        const h = fixture();
        await h.controller.firstUnits();
        const pending = deferred();
        h.s.lessonReader = () => pending.promise;
        const run = h.controller.chooseUnit(id(2));
        if (reason === 'event')
            h.s.event();
        if (reason === 'principal')
            h.s.principal = 'B';
        if (reason === 'dispose')
            h.controller.dispose();
        if (reason === 'switch') {
            h.s.lessonReader = async () => ({ rows: [row(9)], cursor: null });
            await h.controller.chooseUnit(id(5));
        }
        pending.resolve({ rows: [row(4)], cursor: null });
        await run;
        assert.equal(h.latest().chosen, null);
        assert.ok(!h.latest().lessons.some(row => row.id === id(4)));
        h.controller.dispose();
    });
test('failed page clears previous child; invalid duplicate/bound/cursor pages fail closed', async () => {
    for (const mode of ['throw', 'duplicate', 'overflow', 'cursor']) {
        const h = fixture();
        await h.controller.firstUnits();
        await h.controller.chooseUnit(id(2));
        h.controller.chooseLesson(id(4));
        h.s.lessonReader = async () => { if (mode === 'throw')
            throw Error('503'); return { rows: mode === 'duplicate' ? [row(4), row(4)] : mode === 'overflow' ? Array.from({ length: 26 }, (_, n) => row(n + 30)) : [row(4)], cursor: mode === 'cursor' ? 'l-next' : null }; };
        await h.controller.nextLessons();
        assert.equal(h.latest().phase, 'error');
        assert.equal(h.latest().chosen, null);
        assert.equal(h.latest().lessons.length, 0);
        h.controller.dispose();
    }
});
test('deadline clears source and late reply is fenced', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(), pending = deferred();
    h.s.unitReader = () => pending.promise;
    const run = h.controller.firstUnits();
    context.mock.timers.tick(25000);
    assert.equal(h.latest().phase, 'error');
    assert.ok(h.s.calls[0].signal.aborted);
    pending.resolve({ rows: [row(2)], cursor: null });
    await run;
    assert.equal(h.latest().units.length, 0);
    h.controller.dispose();
});
test('clearing a unit during pending load cancels it without leaving controls stuck loading', async () => {
    const h=fixture(); await h.controller.firstUnits(); const pending=deferred(); h.s.lessonReader=()=>pending.promise;
    const run=h.controller.chooseUnit(id(2)); await h.controller.chooseUnit('');
    assert.equal(h.latest().phase,'ready'); assert.equal(h.latest().unitId,null); assert.ok(h.s.calls.at(-1).signal.aborted);
    pending.resolve({rows:[row(4)],cursor:null}); await run; assert.equal(h.latest().lessons.length,0); h.controller.dispose();
});
test('cross-unit comparison uses the source unit only for source reads and destination unit for destination reads', async () => {
    const calls: any[] = [];
    const controller = createPackagePreview({ destinationId: id(3), sourceIds: [id(4)], readPrincipal: () => 'A', subscribeSession: () => () => { },
        read: async (lesson) => { calls.push({ unit: id(2), lesson }); return empty(); }, readSource: async (lesson) => { calls.push({ unit: id(5), lesson }); return empty(); } });
    await controller.preview(id(4));
    assert.deepEqual(calls, [{ unit: id(5), lesson: id(4) }, { unit: id(2), lesson: id(3) }]);
    controller.dispose();
});
const unit = (n: number) => ({ id: id(n), course_id: id(1), name: 'unit', display_order: n, status: 'active', created_at: '2026-11-06T00:00:00.000Z', updated_at: '2026-11-06T00:00:00.000Z' });
const lesson = (n: number, u = 5) => ({ id: id(n), unit_id: id(u), title: 'lesson', description: null, display_order: n, status: 'active', release_at: null, prerequisite_lesson_id: null, created_at: '2026-11-06T00:00:00.000Z', updated_at: '2026-11-06T00:00:00.000Z' });
test('canonical paginated transport fixes course/unit scope, forwards AbortSignal and rejects foreign DTOs', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage };
    const calls: any[] = [];
    let foreign = false;
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : null };
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(String(url).includes('/lessons?') ? { lessons: [{ ...lesson(4), unit_id: foreign ? id(99) : id(5) }], next_cursor: null } : { units: [{ ...unit(5), course_id: foreign ? id(99) : id(1) }], next_cursor: 'opaque' })); };
    try {
        const transport = packageSourceTransport(id(1)), signal = new AbortController().signal;
        await transport.units(null, signal);
        await transport.lessons(id(5), 'opaque', signal);
        assert.equal(calls[0].url, `/api/tenants/me/catalog/courses/${id(1)}/units?limit=25`);
        assert.equal(calls[1].url, `/api/tenants/me/catalog/courses/${id(1)}/units/${id(5)}/lessons?limit=25&cursor=opaque`);
        assert.ok(calls.every(call => call.init.signal === signal && (call.init.method ?? 'GET') === 'GET' && call.init.body === undefined));
        foreign = true;
        await assert.rejects(() => transport.units(null, signal));
        await assert.rejects(() => transport.lessons(id(5), null, signal));
        assert.throws(() => packageSourceTransport('invalid'));
    }
    finally {
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
    }
});
function loadPanel(name: string, state: any) {
    const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load, file = require.resolve('../features/catalog/' + name + '.tsx');
    const effects: Function[] = [], snapshots: any[] = [], ref = { current: null };
    try {
        delete require.cache[file];
        module._load = function (request: string, parent: any, main: boolean) {
            if (request === 'react' && parent?.filename === file)
                return { ...React, useCallback: (fn: Function) => fn, useState: (initial: any) => [typeof initial === 'function' ? state : initial, (next: any) => snapshots.push(next)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) };
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
function find(node: any, predicate: (value: any) => boolean): any { if (!node || typeof node !== 'object')
    return null; if (predicate(node))
    return node; for (const child of [node.props?.children].flat(4)) {
    const value = find(child, predicate);
    if (value)
        return value;
} return null; }
test('actual picker renders archive/self restrictions, escaped names and recovery lock', () => {
    const previous = (globalThis as any).React;
    try {
        const h = loadPanel('LessonPackageSources', { ...initialPackageSources(), phase: 'ready', units: [row(5), row(6, 'archived')], lessons: [row(3), row(4)], unitId: id(5), locked: true });
        (globalThis as any).React = h.React;
        const tree = h.component.LessonPackageSources({ courseId: id(1), destinationId: id(3), renderSource: () => null });
        const html = h.require('react-dom/server').renderToStaticMarkup(tree);
        assert.match(html, /&lt;script&gt;source&lt;\/script&gt;/);
        assert.match(html, /تغيير المصدر متوقف/);
        assert.equal(find(tree, node => node.type === 'option' && node.props.value === id(3)).props.disabled, true);
        assert.equal(find(tree, node => node.type === 'option' && node.props.value === id(6)).props.disabled, true);
    }
    finally {
        (globalThis as any).React = previous;
    }
});
test('actual picker callbacks load only chosen units/lessons and immediately drop selected child on page change', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
    let cleanup: Function | undefined;
    const calls: string[] = [];
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify(String(url).includes('/lessons?') ? { lessons: [lesson(4)], next_cursor: 'next-lessons' } : { units: [unit(5)], next_cursor: 'next-units' })); };
    try {
        const state = initialPackageSources(), h = loadPanel('LessonPackageSources', state);
        (globalThis as any).React = h.React;
        let rendered: any = null, lock: any;
        const props = { courseId: id(1), destinationId: id(3), renderSource: (source: any, onLock: any) => { rendered = source; lock = onLock; return null; } };
        let tree = h.component.LessonPackageSources(props);
        assert.equal(calls.length, 0);
        cleanup = h.effects[0]();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 1);
        Object.assign(state, h.snapshots.at(-1));
        tree = h.component.LessonPackageSources(props);
        find(tree, node => node.type === 'select').props.onChange({ target: { value: id(5) } });
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 2);
        Object.assign(state, h.snapshots.at(-1));
        tree = h.component.LessonPackageSources(props);
        const select = find(tree, node => node.type === 'select' && node.props.children[0].props.children === 'اختر الحصة');
        select.props.onChange({ target: { value: id(4) } });
        Object.assign(state, h.snapshots.at(-1));
        h.component.LessonPackageSources(props);
        assert.equal(rendered.unitId, id(5));
        assert.equal(rendered.lessonId, id(4));
        lock(true);
        Object.assign(state, h.snapshots.at(-1));
        tree = h.component.LessonPackageSources(props);
        find(tree, node => node.props?.children === 'الحصص التالية').props.onClick();
        assert.equal(calls.length, 2);
        lock(false);
        Object.assign(state, h.snapshots.at(-1));
        tree = h.component.LessonPackageSources(props);
        find(tree, node => node.props?.children === 'الحصص التالية').props.onClick();
        assert.equal(h.snapshots.at(-1).chosen, null);
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 3);
        h.require('../lib/session-events').notifySessionChange('scope');
        assert.equal(h.snapshots.at(-1).units.length, 0);
        assert.equal(h.snapshots.at(-1).chosen, null);
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
test('actual comparison editor reads a chosen other unit and leaves destination/reuse path unchanged', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
    let cleanup: Function | undefined;
    const calls: string[] = [];
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify(String(url).endsWith('/contents') ? { contents: [{ content_id: id(110), material_id: id(10), title: 'material', material_type: 'pdf', display_order: 0 }] } : String(url).endsWith('/videos') ? { videos: [] } : String(url).endsWith('/activities') ? { activities: [] } : { announcement: null })); };
    try {
        const state = initialPackagePreview(), h = loadPanel('LessonPackagePreview', state);
        (globalThis as any).React = h.React;
        const props = { courseId: id(1), unitId: id(2), lessonId: id(3), sourceUnitId: id(5), selectedSourceId: id(4), sources: [{ id: id(4), title: 'source' }] };
        // This editor's selection hook is preselected by its immutable source prop.
        let tree = h.component.LessonPackagePreviewEditor(props);
        cleanup = h.effects[0]();
        find(tree, node => node.props?.children === 'مقارنة الحزمة مع هذه الحصة').props.onClick();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 8);
        assert.equal(calls.filter(url => url.includes(`/units/${id(5)}/lessons/${id(4)}/`)).length, 4);
        assert.equal(calls.filter(url => url.includes(`/units/${id(2)}/lessons/${id(3)}/`)).length, 4);
        Object.assign(state, h.snapshots.filter(x => x && typeof x === 'object').at(-1));
        tree = h.component.LessonPackagePreviewEditor(props);
        const reuse = find(tree, node => node.type?.name === 'LessonPackageReuse');
        assert.equal(reuse.props.unitId, id(2));
        assert.equal(reuse.props.sourceLessonId, id(4));
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
