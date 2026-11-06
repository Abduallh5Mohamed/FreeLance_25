import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError } from '../lib/api-http';
import { announcementPublicationTransport, studentAnnouncementTransport, createPublicationController, createStudentAnnouncement, parsePublication, parsePublicationReview, parseStudentAnnouncement, initialPublicationState, initialStudentAnnouncement } from '../features/catalog/announcement-publication';
const id = (n: number) => `b3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = { content_id: id(4), source_id: id(5), group_id: id(6), group_name: 'المجموعة', title: 'عنوان', source_state: 'published' as const, student_visibility: 'unconfigured' as const };
const publication = () => ({ id: id(7), content_id: id(4), status: 'published', published_at: '2026-11-06T12:00:00.000Z' });
const review = () => ({ preview: { ...reference, body: 'نص <script>مراجع</script>', candidate_enrollments: 2, course_published: true, lesson_active: true, lesson_released: false, prerequisite_required: true, previewed_at: '2026-11-06T12:00:00.000Z', delivery_status: 'unconfigured' }, review_token: 'a'.repeat(64), can_publish: true, publication: null as any });
const student = () => ({ lesson_id: id(3), announcement: { content_id: id(4), publication_id: id(7), title: 'عنوان <script>', body: 'نص <script>مراجع</script>', published_at: '2026-11-06T12:00:00.000Z' } });
const deferred = () => { let resolve!: (x: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function ownerFixture() { const s = { principal: 'A', event: () => { }, publication: null as any, calls: [] as string[] }; const deps = { readPrincipal: () => s.principal, subscribeSession: (fn: () => void) => { s.event = fn; return () => { }; }, read: async (_s: AbortSignal) => { s.calls.push('read'); return { publication: s.publication }; }, review: async (_s: AbortSignal) => { s.calls.push('review'); return { ...review(), publication: s.publication }; }, publish: async (token: string, _s: AbortSignal) => { s.calls.push('publish'); assert.equal(token, 'a'.repeat(64)); s.publication = publication(); return { publication: s.publication, unchanged: false }; }, withdraw: async (value: string, _s: AbortSignal) => { s.calls.push('withdraw'); assert.equal(value, id(7)); s.publication = null; return { withdrawn: true }; } }; return { s, deps, controller: createPublicationController(reference, deps) }; }
test('strict publication/review/student projections reject foreign targets, hidden identity and false readiness', () => {
    assert.equal(parsePublication({ publication: publication() }, id(4))!.id, id(7));
    assert.equal(parseStudentAnnouncement(student(), id(3))!.title, student().announcement.title);
    for (const change of [{ id: 'bad' }, { content_id: id(90) }, { source_fingerprint: 'private' }, { published_at: 'invalid' }])
        assert.throws(() => parsePublication({ publication: { ...publication(), ...change } }, id(4)));
    assert.throws(() => parsePublicationReview({ ...review(), can_publish: false }, reference));
    assert.throws(() => parsePublicationReview({ ...review(), review_token: 'bad' }, reference));
    assert.throws(() => parseStudentAnnouncement({ ...student(), announcement: { ...student().announcement, group_id: id(6) } }, id(3)));
});
test('publish requires a fresh review; confirmation and withdrawal use explicit calls without delivery', async () => {
    const h = ownerFixture();
    await h.controller.load();
    await h.controller.publish();
    assert.deepEqual(h.s.calls, ['read']);
    await h.controller.review();
    await h.controller.publish();
    assert.equal(h.controller.getState().publication!.status, 'published');
    assert.equal(h.controller.getState().review, null);
    await h.controller.publish();
    assert.equal(h.s.calls.filter(x => x === 'publish').length, 1);
    await h.controller.withdraw();
    assert.equal(h.controller.getState().publication, null);
    h.controller.dispose();
});
test('unknown publication remains frozen even if its first recovery read fails', async () => {
    const h = ownerFixture();
    await h.controller.load();
    await h.controller.review();
    const original = h.deps.publish;
    h.deps.publish = async (...args) => { await original(...args); throw new ApiRequestError('unknown', 500, 'PERSISTENCE_UNCERTAIN'); };
    await h.controller.publish();
    assert.equal(h.controller.getState().uncertain, true);
    h.deps.read = async () => { throw Error('read'); };
    await h.controller.load();
    assert.equal(h.controller.getState().uncertain, true);
    const count = h.s.calls.length;
    await h.controller.review();
    await h.controller.publish();
    await h.controller.withdraw();
    assert.equal(h.s.calls.length, count);
    h.deps.read = async () => ({ publication: h.s.publication });
    await h.controller.load();
    assert.equal(h.controller.getState().uncertain, false);
    assert.equal(h.controller.getState().publication!.id, id(7));
    h.controller.dispose();
});
test('stale review conflict clears approval and needs another read/review, never automatic retry', async () => {
    const h = ownerFixture();
    await h.controller.load();
    await h.controller.review();
    let count = 0;
    h.deps.publish = async () => { count++; throw new ApiRequestError('stale', 409, 'ANNOUNCEMENT_REVIEW_CHANGED'); };
    await h.controller.publish();
    assert.equal(h.controller.getState().review, null);
    await h.controller.publish();
    assert.equal(count, 1);
    h.controller.dispose();
});
for (const trigger of ['event', 'principal', 'dispose'])
    test(`retired owner ${trigger} cannot accept a late reviewed body or publication`, async () => {
        const h = ownerFixture();
        await h.controller.load();
        const wait = deferred();
        h.deps.review = async () => wait.promise;
        const work = h.controller.review();
        if (trigger === 'event')
            h.s.event();
        else if (trigger === 'principal')
            h.s.principal = 'B';
        else
            h.controller.dispose();
        wait.resolve(review());
        await work;
        assert.equal(h.controller.getState().review, null);
        assert.equal(h.controller.getState().publication, null);
        h.controller.dispose();
    });
test('student reload clears old text before reading and source withdrawal leaves no stale body', async () => {
    let raw: any = student();
    const controller = createStudentAnnouncement(id(3), { read: async () => raw, readPrincipal: () => 'A', subscribeSession: () => () => { } });
    await controller.load();
    assert.ok(controller.getState().announcement);
    const wait = deferred();
    raw = wait.promise;
    const work = controller.load();
    assert.equal(controller.getState().announcement, null);
    wait.resolve({ lesson_id: id(3), announcement: null });
    await work;
    assert.equal(controller.getState().announcement, null);
    controller.dispose();
});
test('student workspace retirement ignores an old response and cannot trigger a read receipt or completion', async () => {
    let event = () => { };
    const wait = deferred();
    let count = 0;
    const controller = createStudentAnnouncement(id(3), { read: async () => { count++; return wait.promise; }, readPrincipal: () => 'A', subscribeSession: fn => { event = fn; return () => { }; } });
    const work = controller.load();
    event();
    wait.resolve(student());
    await work;
    assert.equal(controller.getState().announcement, null);
    await controller.load();
    assert.equal(count, 1);
    controller.dispose();
});
test('single-flight owner write cannot share an approval with another submission', async () => {
    const h = ownerFixture();
    await h.controller.load();
    await h.controller.review();
    const wait = deferred();
    let count = 0;
    h.deps.publish = async () => { count++; return wait.promise; };
    const work = h.controller.publish();
    await h.controller.publish();
    wait.resolve({ publication: publication(), unchanged: false });
    await work;
    assert.equal(count, 1);
    assert.equal(h.controller.getState().review, null);
    h.controller.dispose();
});
test('canonical owner publication and student read send only the review hash and pinned IDs', async () => {
    const oldFetch = globalThis.fetch, oldStorage = globalThis.localStorage, calls: any[] = [];
    (globalThis as any).localStorage = { getItem: () => 'synthetic' };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
    try {
        const t = announcementPublicationTransport(id(1), id(2), id(3), id(4)), signal = new AbortController().signal;
        await t.read(signal);
        await t.review(signal);
        await t.publish('a'.repeat(64), signal);
        await t.withdraw(id(7), signal);
        await studentAnnouncementTransport(id(1), id(3))(signal);
        assert.deepEqual(calls.map(x => x.init.method), ['GET', 'GET', 'POST', 'DELETE', 'GET']);
        assert.deepEqual(JSON.parse(calls[2].init.body), { review_token: 'a'.repeat(64) });
        for (const c of calls) {
            assert.equal(c.init.cache, 'no-store');
            assert.equal(new Headers(c.init.headers).get('Authorization'), 'Bearer synthetic');
            assert.ok(!String(c.url).includes('/notifications'));
        }
    }
    finally {
        globalThis.fetch = oldFetch;
        (globalThis as any).localStorage = oldStorage;
    }
});
function loadPanel(name: string, state: any) { const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load, file = require.resolve('../features/catalog/' + name + '.tsx'), effects: Function[] = [], snapshots: any[] = [], ref = { current: null }; try {
    delete require.cache[file];
    module._load = function (request: string, parent: any, main: boolean) { if (request === 'react' && parent?.filename === file)
        return { ...React, useState: (initial: any) => [typeof initial === 'function' ? state : initial, (next: any) => snapshots.push(next)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) }; if (request.startsWith('@/'))
        return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), request.slice(2)), parent, main); return original.call(this, request, parent, main); };
    return { component: require(file), effects, snapshots, React, require };
}
finally {
    module._load = original;
    delete require.cache[file];
} }
test('actual owner/student UI escapes reviewed text, has deliberate approval and no source IDs or completion control', () => {
    const previous = (globalThis as any).React;
    try {
        const owner = loadPanel('LessonAnnouncementPublication', { ...initialPublicationState(), phase: 'ready', review: review() });
        (globalThis as any).React = owner.React;
        const html = owner.require('react-dom/server').renderToStaticMarkup(owner.component.LessonAnnouncementPublication({ courseId: id(1), unitId: id(2), lessonId: id(3), reference }));
        assert.match(html, /&lt;script&gt;/);
        assert.match(html, /تأكيد إتاحة النسخة المراجَعة/);
        assert.match(html, /type="checkbox"/);
        const reader = loadPanel('StudentLessonAnnouncement', { ...initialStudentAnnouncement(), phase: 'ready', announcement: student().announcement });
        (globalThis as any).React = reader.React;
        const rendered = reader.require('react-dom/server').renderToStaticMarkup(reader.component.StudentLessonAnnouncementBody({ courseId: id(1), lessonId: id(3) }));
        assert.match(rendered, /&lt;script&gt;/);
        assert.ok(!rendered.includes(id(5)));
        assert.match(rendered, /لا تسجّل إتمام الدرس/);
    }
    finally {
        (globalThis as any).React = previous;
    }
});
test('actual owner review/publish callbacks perform their canonical requests and clear on session change', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
    const calls: any[] = [], state: any = { ...initialPublicationState(), phase: 'ready' };
    let cleanup: Function | undefined;
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(String(url).endsWith('publication-preview') ? review() : init?.method === 'POST' ? { publication: publication(), unchanged: false } : { publication: null })); };
    try {
        const h = loadPanel('LessonAnnouncementPublication', state);
        (globalThis as any).React = h.React;
        const props = { courseId: id(1), unitId: id(2), lessonId: id(3), reference };
        let tree = h.component.LessonAnnouncementPublication(props);
        cleanup = h.effects[0]();
        await new Promise(r => setImmediate(r));
        const find = (node: any, label: string): any => { if (!node || typeof node !== 'object')
            return null; if (node.props?.children === label)
            return node; for (const child of [node.props?.children].flat(3)) {
            const value = find(child, label);
            if (value)
                return value;
        } return null; };
        find(tree, 'معاينة النسخة الحالية قبل الإتاحة').props.onClick();
        await new Promise(r => setImmediate(r));
        Object.assign(state, h.snapshots.filter(x => x && typeof x === 'object').at(-1));
        tree = h.component.LessonAnnouncementPublication(props);
        find(tree, 'تأكيد إتاحة النسخة المراجَعة').props.onClick();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 3);
        assert.equal(calls[2].init.method, 'POST');
        h.require('../lib/session-events').notifySessionChange('scope');
        assert.equal(h.snapshots.filter(x => x && typeof x === 'object').at(-1).publication, null);
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
test('actual student mount performs only its private read and discards text on workspace change', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
    const calls: any[] = [];
    let cleanup: Function | undefined;
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'student', role: 'student' }) : key === 'currentStudentSpace' ? JSON.stringify({ tenant_id: 'tenant', student_enrollment_id: 'enrollment' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(student())); };
    try {
        const h = loadPanel('StudentLessonAnnouncement', initialStudentAnnouncement());
        (globalThis as any).React = h.React;
        h.component.StudentLessonAnnouncementBody({ courseId: id(1), lessonId: id(3) });
        cleanup = h.effects[0]();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.method, 'GET');
        assert.equal(h.snapshots.at(-1).announcement.body, student().announcement.body);
        h.require('../lib/session-events').notifySessionChange('scope');
        assert.equal(h.snapshots.at(-1).announcement, null);
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
