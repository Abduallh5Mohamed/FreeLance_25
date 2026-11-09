import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError } from '../lib/api-http';
import { catalogQuizTransport, createCatalogQuiz, initialQuizState, parseQuizAttempt, parseQuizRecovery, quizAnswers } from '../features/catalog/catalog-quiz';
const id = (n: number) => `b2600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const question = (n = 5, type = 'single_choice') => ({ id: id(n), position: n, question_type: type, question_text: 'سؤال <script>آمن</script>', options: ['single_choice', 'multiple_choice'].includes(type) ? ['A', 'B'] : [], points: 1 });
const rawAttempt = () => ({ id: id(4), exam_id: id(8), exam_version_id: id(9), student_enrollment_id: 'selected', status: 'in_progress', started_at: '2026-11-06T12:00:00.000Z', deadline_at: '2026-11-06T13:00:00.000Z', submitted_at: null, auto_submitted: false, auto_score: null, score: null, manual_required: false, graded_at: null, passed: null, questions: [question()], answers: {} });
const header = (status = 'in_progress') => ({ attempt: { id: id(4), status, started_at: '2026-11-06T12:00:00.000Z', deadline_at: '2026-11-06T13:00:00.000Z' }, unchanged: true });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const s = { principal: 'A', event: () => { }, exists: false, attempt: rawAttempt(), calls: [] as string[], payloads: [] as any[] };
    const deps = { readPrincipal: () => s.principal, subscribeSession: (fn: () => void) => { s.event = fn; return () => { s.event = () => { }; }; },
        recover: async (_signal: AbortSignal) => { s.calls.push('recover'); return s.exists ? header(s.attempt.status) : { attempt: null }; },
        start: async (_signal: AbortSignal) => { s.calls.push('start'); s.exists = true; return header(); },
        read: async (_id: string, _signal: AbortSignal) => { s.calls.push('read'); return structuredClone(s.attempt); },
        save: async (_id: string, answers: any, _signal: AbortSignal) => { s.calls.push('save'); s.payloads.push(answers); s.attempt.answers = structuredClone(answers); return { ok: true, saved: Object.keys(answers).length }; },
        submit: async (_id: string, answers: any, _signal: AbortSignal) => { s.calls.push('submit'); s.payloads.push(answers); s.attempt.answers = structuredClone(answers); s.attempt.status = 'graded'; s.attempt.score = 1 as any; return { attempt_id: id(4), status: 'graded', auto_score: 1, manual_required: false, late: false }; },
    };
    return { s, deps, controller: createCatalogQuiz(deps) };
}
test('strict parsers reject key disclosure, wrong targets, duplicates, invalid dates and unknown draft references', () => {
    assert.equal(parseQuizRecovery(header())!.id, id(4));
    assert.equal(parseQuizRecovery({ attempt: null }), null);
    for (const bad of [{ ...header(), exam_id: id(8) }, { attempt: { ...header().attempt, correct_answers: ['A'] }, unchanged: true }, { attempt: { ...header().attempt, deadline_at: '2026-02-30T00:00:00.000Z' }, unchanged: true }])
        assert.throws(() => parseQuizRecovery(bad));
    for (const change of [{ id: id(99) }, { correct_answers: ['A'] }, { questions: [{ ...question(), correct_answers: ['A'] }] }, { questions: [question(), question()] }, { answers: { [id(90)]: 'A' } }, { answers: { [id(5)]: 'not an option' } }, { manual_required: 1 }, { score: NaN }])
        assert.throws(() => parseQuizAttempt({ ...rawAttempt(), ...change }, id(4)));
});
test('all question types and explicit null clears follow the existing answer representation and size bound', () => {
    const raw = { ...rawAttempt(), questions: [question(), question(6, 'multiple_choice'), question(7, 'true_false'), question(8, 'essay')] };
    const parsed = parseQuizAttempt(raw, id(4));
    const answers = { [id(5)]: 'A', [id(6)]: ['B'], [id(7)]: 'false', [id(8)]: 'نص مقال' };
    assert.deepEqual(quizAnswers(parsed.questions, answers), answers);
    assert.equal(quizAnswers(parsed.questions, {})[id(5)], null);
    assert.throws(() => quizAnswers(parsed.questions, { [id(6)]: ['B', 'B'] }));
    assert.throws(() => quizAnswers(parsed.questions, { [id(8)]: 'x'.repeat(10001) }));
});
test('mount/recovery never starts; explicit start, clear, save and submit use one existing attempt', async () => {
    const h = fixture();
    await h.controller.recover();
    assert.deepEqual(h.s.calls, ['recover']);
    assert.equal(h.controller.getState().phase, 'idle');
    await h.controller.start();
    assert.equal(h.controller.getState().attempt!.id, id(4));
    h.controller.edit(id(5), 'A');
    await h.controller.save();
    assert.equal(h.controller.getState().dirty, false);
    h.controller.edit(id(5), null);
    assert.equal(h.controller.getState().dirty, true);
    await h.controller.save();
    assert.equal(h.s.payloads.at(-1)[id(5)], null);
    h.controller.edit(id(5), 'A');
    await h.controller.submit();
    assert.equal(h.controller.getState().attempt!.status, 'graded');
    await h.controller.submit();
    assert.equal(h.s.calls.filter(x => x === 'submit').length, 1);
    h.controller.dispose();
});
for (const action of ['start', 'save', 'submit'] as const)
    test(`lost ${action} acknowledgement blocks replay and reconciles by reads`, async () => {
        const h = fixture();
        await h.controller.recover();
        if (action !== 'start') {
            await h.controller.start();
            h.controller.edit(id(5), 'A');
        }
        const original = h.deps[action];
        (h.deps as any)[action] = async (...args: any[]) => { await (original as any)(...args); throw new ApiRequestError('unknown', 503, 'PERSISTENCE_UNCERTAIN'); };
        await h.controller[action]();
        assert.equal(h.controller.getState().phase, 'uncertain');
        const count = h.s.calls.filter(x => x === action).length;
        await h.controller[action]();
        assert.equal(h.s.calls.filter(x => x === action).length, count);
        await h.controller.recover();
        assert.equal(h.controller.getState().phase, 'ready');
        assert.equal(h.controller.getState().autoSave, false);
        assert.equal(h.s.calls.filter(x => x === action).length, count);
        if (action === 'submit')
            assert.equal(h.controller.getState().attempt!.status, 'graded');
        h.controller.dispose();
    });
test('uncommitted save recovery keeps the local draft dirty without rearming autosave; server choice is explicit', async () => {
    const h = fixture();
    await h.controller.recover();
    await h.controller.start();
    h.controller.edit(id(5), 'B');
    h.deps.save = async () => { throw Error('transport'); };
    await h.controller.save();
    await h.controller.recover();
    assert.equal(h.controller.getState().draft[id(5)], 'B');
    assert.equal(h.controller.getState().dirty, true);
    assert.equal(h.controller.getState().autoSave, false);
    h.controller.useServer();
    assert.equal(h.controller.getState().draft[id(5)], null);
    assert.equal(h.controller.getState().dirty, false);
    h.controller.dispose();
});
for (const trigger of ['event', 'principal', 'dispose'])
    test(`late ${trigger} response cannot restore questions, drafts or start a new write`, async () => {
        const h = fixture();
        await h.controller.recover();
        await h.controller.start();
        const wait = deferred();
        let signal: AbortSignal | undefined;
        h.deps.read = async (_id, s) => { signal = s; return wait.promise; };
        const pending = h.controller.recover();
        await new Promise(r => setImmediate(r));
        if (trigger === 'event')
            h.s.event();
        else if (trigger === 'principal')
            h.s.principal = 'B';
        else
            h.controller.dispose();
        wait.resolve(rawAttempt());
        await pending;
        assert.equal(h.controller.getState().attempt, null);
        assert.deepEqual(h.controller.getState().draft, {});
        assert.equal(signal!.aborted, true);
        h.controller.dispose();
    });
test('revocation clears private state and prevents further reads or writes', async () => {
    const h = fixture();
    await h.controller.recover();
    await h.controller.start();
    h.deps.save = async () => { throw new ApiRequestError('withdrawn', 403, 'CATALOG_EXAM_DENIED'); };
    h.controller.edit(id(5), 'A');
    await h.controller.save();
    assert.equal(h.controller.getState().phase, 'denied');
    assert.equal(h.controller.getState().attempt, null);
    assert.deepEqual(h.controller.getState().draft, {});
    const count = h.s.calls.length;
    await h.controller.recover();
    assert.equal(h.s.calls.length, count);
    h.controller.dispose();
});
test('explicit unavailability stays unavailable without a fallback or automatic retry', async () => {
    const h = fixture();
    h.deps.recover = async () => { throw new ApiRequestError('schema', 503, 'CATALOG_ATTEMPT_UNAVAILABLE'); };
    await h.controller.recover();
    assert.equal(h.controller.getState().phase, 'error');
    assert.match(h.controller.getState().message!, /غير جاهز/);
    assert.equal(h.s.calls.filter(x => x === 'start').length, 0);
    h.controller.dispose();
});
test('single flight freezes payload and malformed acknowledgement requires reconciliation', async () => {
    const h = fixture();
    await h.controller.recover();
    await h.controller.start();
    h.controller.edit(id(5), 'A');
    const wait = deferred();
    let sent: any;
    h.deps.save = async (_id, answers) => { sent = answers; return wait.promise; };
    const save = h.controller.save();
    h.controller.edit(id(5), 'B');
    await h.controller.submit();
    assert.equal(sent[id(5)], 'A');
    wait.resolve({ ok: true, saved: 0 });
    await save;
    assert.equal(h.controller.getState().phase, 'uncertain');
    h.controller.dispose();
});
test('confirmed submit with a failed result read never becomes a failed-write message', async () => {
    const h = fixture();
    await h.controller.recover();
    await h.controller.start();
    h.deps.read = async () => { throw Error('read'); };
    await h.controller.submit();
    assert.equal(h.controller.getState().phase, 'error');
    assert.match(h.controller.getState().message!, /تم تأكيد التسليم/);
    assert.equal(h.controller.getState().attempt!.status, 'graded');
    await h.controller.submit();
    assert.equal(h.s.calls.filter(x => x === 'submit').length, 1);
    h.controller.dispose();
});
test('confirmed start with a failed question read never offers a fresh start or reports failed creation', async () => {
    const h = fixture();
    await h.controller.recover();
    h.deps.read = async () => { throw Error('read'); };
    await h.controller.start();
    assert.equal(h.controller.getState().phase, 'error');
    assert.match(h.controller.getState().message!, /تم تأكيد بدء المحاولة/);
    await h.controller.start();
    assert.equal(h.s.calls.filter(x => x === 'start').length, 1);
    h.s.exists = false;
    await h.controller.recover();
    assert.equal(h.controller.getState().phase, 'error');
    h.controller.dispose();
});
test('recovery cannot turn an existing attempt into an idle start offer', async () => {
    const h = fixture();
    await h.controller.recover();
    await h.controller.start();
    h.s.exists = false;
    await h.controller.recover();
    assert.equal(h.controller.getState().phase, 'error');
    await h.controller.start();
    assert.equal(h.s.calls.filter(x => x === 'start').length, 1);
    h.controller.dispose();
});
test('aborted write acknowledgement is uncertain even when the transport resolves later', async () => {
    const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
    let timeout = () => { };
    (globalThis as any).setTimeout = (fn: () => void) => { timeout = fn; return 1; };
    (globalThis as any).clearTimeout = () => { };
    const h = fixture();
    try {
        await h.controller.recover();
        await h.controller.start();
        h.controller.edit(id(5), 'A');
        const wait = deferred();
        h.deps.save = async () => wait.promise;
        const pending = h.controller.save();
        timeout();
        wait.resolve({ ok: true, saved: 1 });
        await pending;
        assert.equal(h.controller.getState().phase, 'uncertain');
        assert.equal(h.controller.getState().dirty, true);
    }
    finally {
        h.controller.dispose();
        globalThis.setTimeout = oldSet;
        globalThis.clearTimeout = oldClear;
    }
});
for (const kind of ['recover', 'save', 'submit-refresh'] as const)
test(`deadline retires stalled ${kind} transport even when it ignores cancellation`, async () => {
    const h = fixture();
    const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
    let timeout = () => {};
    try {
        await h.controller.recover();
        if (kind !== 'recover') await h.controller.start();
        const wait = deferred();
        if (kind === 'recover' || kind === 'submit-refresh') h.deps.recover = async () => wait.promise;
        else { h.controller.edit(id(5), 'A'); h.deps.save = async () => wait.promise; }
        (globalThis as any).setTimeout = (fn: () => void) => { timeout = fn; return 1; };
        (globalThis as any).clearTimeout = () => {};
        const pending = kind === 'save' ? h.controller.save() : kind === 'recover' ? h.controller.recover() : h.controller.submit();
        // Let the confirmed submit enter its follow-up GET before its deadline.
        for (let i = 0; i < 8; i++) await Promise.resolve();
        timeout();
        for (let i = 0; i < 12; i++) await Promise.resolve();
        assert.notEqual(h.controller.getState().phase, 'busy');
        await pending;
        assert.equal(h.controller.getState().phase, kind === 'save' ? 'uncertain' : 'error');
        if (kind === 'submit-refresh') {
            assert.equal(h.controller.getState().attempt?.status, 'graded');
            assert.match(h.controller.getState().message!, /تم تأكيد التسليم/);
        }
        const state = h.controller.getState();
        wait.resolve(kind === 'save' ? { ok: true, saved: 1 } : header());
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.deepEqual(h.controller.getState(), state);
    } finally { h.controller.dispose(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; }
});

test('late save success after a session event cannot restore a private draft', async () => {
    const h = fixture();
    await h.controller.recover();
    await h.controller.start();
    h.controller.edit(id(5), 'A');
    const wait = deferred();
    h.deps.save = async () => wait.promise;
    const pending = h.controller.save();
    h.s.event();
    wait.resolve({ ok: true, saved: 1 });
    await pending;
    assert.equal(h.controller.getState().phase, 'session-ended');
    assert.deepEqual(h.controller.getState().draft, {});
    h.controller.dispose();
});
test('canonical transports carry bearer only in headers and no identity/source/version body selectors', async () => {
    const oldFetch = globalThis.fetch, storage = globalThis.localStorage, calls: any[] = [];
    (globalThis as any).localStorage = { getItem: () => 'synthetic' };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
    try {
        const t = catalogQuizTransport(id(1), id(2), id(3)), s = new AbortController().signal;
        await t.recover(s);
        await t.start(s);
        await t.read(id(4), s);
        await t.save(id(4), { [id(5)]: null }, s);
        await t.submit(id(4), { [id(5)]: 'A' }, s);
        assert.deepEqual(calls.map(c => c.init.method ?? 'GET'), ['GET', 'POST', 'GET', 'POST', 'POST']);
        assert.equal(calls[0].init.body, undefined);
        assert.equal(calls[1].init.body, '{}');
        assert.deepEqual(JSON.parse(calls[4].init.body), { answers: { [id(5)]: 'A' } });
        for (const c of calls) {
            assert.equal(c.init.cache, 'no-store');
            assert.equal(new Headers(c.init.headers).get('Authorization'), 'Bearer synthetic');
            assert.ok(!String(c.url).includes('synthetic'));
        }
        assert.throws(() => catalogQuizTransport('../x', id(2), id(3)));
    }
    finally {
        globalThis.fetch = oldFetch;
        (globalThis as any).localStorage = storage;
    }
});
function loadPanel(state: any) {
    const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load, file = require.resolve('../features/catalog/StudentCatalogQuiz.tsx');
    const effects: Function[] = [], snapshots: any[] = [], ref = { current: null };
    try {
        delete require.cache[file];
        module._load = function (name: string, parent: any, main: boolean) { if (name === 'react' && parent?.filename === file)
            return { ...React, useState: (initial: any) => [typeof initial === 'function' ? state : false, (x: any) => snapshots.push(x)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) }; if (name.startsWith('@/'))
            return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main); return original.call(this, name, parent, main); };
        return { component: require(file), effects, snapshots, React, require };
    }
    finally {
        module._load = original;
        delete require.cache[file];
    }
}
test('actual TSX renders escaped questions, all input kinds, and explicit final confirmation', () => {
    const previous = (globalThis as any).React;
    try {
        const attempt = parseQuizAttempt({ ...rawAttempt(), questions: [question(), question(6, 'multiple_choice'), question(7, 'true_false'), question(8, 'essay')] }, id(4));
        const h = loadPanel({ ...initialQuizState(), phase: 'ready', attempt, draft: attempt.answers });
        (globalThis as any).React = h.React;
        const html = h.require('react-dom/server').renderToStaticMarkup(h.component.StudentCatalogQuiz({ courseId: id(1), lessonId: id(2), contentId: id(3) }));
        assert.match(html, /&lt;script&gt;/);
        assert.match(html, /type="radio"/);
        assert.match(html, /type="checkbox"/);
        assert.match(html, /<textarea/);
        assert.match(html, /تأكيد التسليم النهائي/);
        assert.ok(!html.includes('correct_answers'));
        assert.ok(!html.includes('/exams/'));
    }
    finally {
        (globalThis as any).React = previous;
    }
});
test('actual component mount only reads recovery and clears on workspace change', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
    const calls: any[] = [];
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'student', role: 'student' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ attempt: null })); };
    let cleanups: Function[] = [];
    try {
        const h = loadPanel(initialQuizState());
        (globalThis as any).React = h.React;
        h.component.StudentCatalogQuiz({ courseId: id(1), lessonId: id(2), contentId: id(3) });
        cleanups = h.effects.map(fn => fn()).filter(Boolean);
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.method ?? 'GET', 'GET');
        assert.equal(h.snapshots.at(-1).phase, 'idle');
        h.require('../lib/session-events').notifySessionChange('scope');
        assert.equal(h.snapshots.at(-1).phase, 'session-ended');
        assert.deepEqual(h.snapshots.at(-1).draft, {});
    }
    finally {
        cleanups.forEach(fn => fn());
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
test('actual answer/save/submit callbacks use the catalog controller and guarded engine paths', async () => {
    const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
    const calls: any[] = [], attempt = rawAttempt();
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'student', role: 'student' }) : null };
    (globalThis as any).window = { addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); const p = String(url); if (p.endsWith('/autosave')) {
        attempt.answers = JSON.parse(String(init?.body)).answers;
        return new Response(JSON.stringify({ ok: true, saved: 1 }));
    } if (p.endsWith('/submit')) {
        attempt.status = 'graded';
        return new Response(JSON.stringify({ attempt_id: id(4), status: 'graded', auto_score: 1, manual_required: false, late: false }));
    } return new Response(JSON.stringify(p.endsWith('/attempt') ? header(attempt.status) : attempt)); };
    let cleanup: Function | undefined;
    try {
        const parsed = parseQuizAttempt(attempt, id(4)), h = loadPanel({ ...initialQuizState(), phase: 'ready', attempt: parsed, draft: parsed.answers });
        (globalThis as any).React = h.React;
        const tree = h.component.StudentCatalogQuiz({ courseId: id(1), lessonId: id(2), contentId: id(3) });
        cleanup = h.effects[0]();
        await new Promise(r => setImmediate(r));
        const find = (node: any, predicate: (node: any) => boolean): any => { if (!node || typeof node !== 'object')
            return null; if (predicate(node))
            return node; for (const child of [node.props?.children].flat(3)) {
            const found = find(child, predicate);
            if (found)
                return found;
        } return null; };
        find(tree, n => n.type === 'input' && n.props.type === 'radio').props.onChange({ target: { checked: true } });
        find(tree, n => n.props?.children === 'حفظ الإجابات الآن').props.onClick();
        await new Promise(r => setImmediate(r));
        assert.equal(h.snapshots.at(-1).dirty, false);
        assert.deepEqual(JSON.parse(calls.find(c => String(c.url).endsWith('/autosave')).init.body), { answers: { [id(5)]: 'A' } });
        find(tree, n => n.props?.children === 'تأكيد التسليم النهائي').props.onClick();
        await new Promise(r => setImmediate(r));
        assert.equal(h.snapshots.at(-1).attempt.status, 'graded');
        assert.equal(calls.filter(c => String(c.url).endsWith('/submit')).length, 1);
        assert.ok(calls.every(c => !String(c.url).includes('/exams/')));
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.storage;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
