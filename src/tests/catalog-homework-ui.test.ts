import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError } from '../lib/api-http';
import { catalogHomeworkTransport, parseHomeworkPolicy, parseHomeworkHistory, parseHomeworkRecovery, parseUploadAuthorization, transferHomeworkFile } from '../features/catalog/catalog-homework-api';
import { createCatalogHomework, homeworkKeyStore, homeworkPrincipalReader, initialHomeworkState } from '../features/catalog/catalog-homework';
const id = (n: number) => `b2800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = () => new File([new Uint8Array(2048)], 'hw.pdf', { type: 'application/pdf' });
const policy = () => ({ content_id: id(3), deadline_at: null, late_policy: 'block', resubmission_policy: 'allow', max_submissions: 5, max_file_bytes: 100000, allowed_file_types: ['pdf'], accepting: true, reason: null, upload_configured: true });
const auth = () => ({ method: 'PUT', url: 'https://storage.invalid/private-signed-target', expires_at: new Date(Date.now() + 300000).toISOString(), expires_in_seconds: 300, required_headers: { 'Content-Type': 'application/pdf' }, max_bytes: 100000, max_bytes_enforced: false, max_bytes_enforcement: 'finalize_stat_only' });
const receipt = () => ({ id: id(4), version: 1, status: 'submitted', file_name: 'hw.pdf', file_type: 'application/pdf', file_size_bytes: 0, upload_status: 'pending_upload', scan_status: 'pending' });
const projected = (row: any) => ({ ...row, is_late: false, submitted_at: '2026-11-06T12:00:00.000Z', revoked_at: null });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const s = { principal: 'A', event: () => { }, key: null as string | null, rows: [] as any[], calls: [] as string[], payloads: [] as any[], policy: policy() };
    const deps = { key: { read: () => s.key, save: (key: string) => { s.calls.push('persist-key'); s.key = key; }, clear: (key: string) => { assert.equal(s.key, key); s.key = null; } }, makeKey: () => id(50), readPrincipal: () => s.principal, subscribeSession: (fn: () => void) => { s.event = fn; return () => { s.event = () => { }; }; },
        policy: async (_signal: AbortSignal) => { s.calls.push('policy'); return s.policy; }, mine: async (_signal: AbortSignal) => { s.calls.push('mine'); return s.rows.map(projected); },
        recover: async (key: string, _signal: AbortSignal) => { s.calls.push('recover'); assert.equal(key, id(50)); return s.rows[0] ? { submission: { ...s.rows[0] }, unchanged: true } : { submission: null }; },
        create: async (meta: any, key: string, _signal: AbortSignal) => { s.calls.push('create'); assert.equal(s.key, key); s.payloads.push(meta); const row = receipt(); s.rows = [row]; const { file_name, file_type, ...created } = row; return { ...created, is_late: false, upload: auth() }; },
        authorize: async (_id: string, _signal: AbortSignal) => { s.calls.push('authorize'); return { id: id(4), version: 1, upload_status: 'pending_upload', scan_status: 'pending', upload: auth() }; },
        transfer: async (_auth: any, _file: File, _signal: AbortSignal) => { s.calls.push('transfer'); },
        finalize: async (_id: string, _signal: AbortSignal) => { s.calls.push('finalize'); Object.assign(s.rows[0], { file_size_bytes: 2048, upload_status: 'pending_scan', scan_status: 'pending' }); return { id: id(4), version: 1, status: 'submitted', file_size_bytes: 2048, upload_status: 'pending_scan', scan_status: 'pending' }; },
        cancel: async (_id: string, _signal: AbortSignal) => { s.calls.push('cancel'); s.rows[0].status = 'revoked'; return { id: id(4), status: 'revoked', cancelled: true }; },
    };
    return { s, deps, controller: createCatalogHomework(id(3), deps) };
}
test('strict private DTOs reject source IDs, malformed dates, duplicate history and fake clean states', () => {
    assert.equal(parseHomeworkPolicy(policy(), id(3)).upload_configured, true);
    assert.equal(parseHomeworkRecovery({ submission: null }), null);
    for (const change of [{ assignment_id: id(8) }, { content_id: id(9) }, { deadline_at: '2026-02-30T00:00:00.000Z' }, { max_file_bytes: Infinity }, { accepting: false, reason: null }])
        assert.throws(() => parseHomeworkPolicy({ ...policy(), ...change }, id(3)));
    assert.throws(() => parseHomeworkRecovery({ submission: { ...receipt(), catalog_context: {} }, unchanged: true }));
    assert.throws(() => parseHomeworkRecovery({ submission: { ...receipt(), upload_status: 'finalized' }, unchanged: true }));
    assert.throws(() => parseHomeworkHistory([projected(receipt()), projected(receipt())]));
    assert.throws(() => parseHomeworkHistory([{ ...projected(receipt()), storage_key: 'private' }]));
});
test('opaque request storage contains only the UUID and is isolated by user/workspace/catalog target', () => {
    let space = { tenant_id: 'tenant-a', student_enrollment_id: 'enrollment-a' };
    const saved = new Map<string, string>();
    const local = { getItem: (key: string) => key === 'currentUser' ? JSON.stringify({ id: 'student' }) : JSON.stringify(space) };
    const session = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
    const store = homeworkKeyStore(local, session, id(1), id(2), id(3));
    store.save(id(50));
    assert.deepEqual([...saved.values()], [id(50)]);
    assert.equal(store.read(), id(50));
    assert.throws(() => store.save(id(51)));
    space = { tenant_id: 'tenant-b', student_enrollment_id: 'enrollment-b' };
    assert.throws(() => store.read());
    assert.equal(homeworkKeyStore(local, session, id(1), id(2), id(3)).read(), null);
    space = { tenant_id: 'tenant-a', student_enrollment_id: 'enrollment-a' };
    store.clear(id(50));
    assert.equal(saved.size, 0);
});
test('principal reader detects silent workspace change and ABA without exposing token or workspace text', () => {
    let space = 'A';
    const storage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-token' : key === 'currentUser' ? JSON.stringify({ id: 'student', role: 'student' }) : key === 'currentStudentSpace' ? space : null };
    const read = homeworkPrincipalReader(storage), a = read();
    space = 'B';
    const b = read();
    space = 'A';
    const next = read();
    assert.notEqual(a, b);
    assert.notEqual(a, next);
    assert.ok(!String(a).includes('synthetic-token'));
});
test('mount reads only; create persists identity before POST; transfer and verification are separate explicit actions', async () => {
    const h = fixture();
    await h.controller.load();
    assert.deepEqual(h.s.calls, ['policy', 'mine']);
    h.controller.choose(file());
    await h.controller.create();
    assert.ok(h.s.calls.indexOf('persist-key') < h.s.calls.indexOf('create'));
    assert.equal(h.s.calls.includes('transfer'), false);
    assert.equal(h.controller.getState().selected!.file_name, 'hw.pdf');
    await h.controller.upload();
    assert.equal(h.controller.getState().selected!.upload_status, 'pending_upload');
    assert.equal(h.s.calls.includes('finalize'), false);
    await h.controller.finalize();
    assert.equal(h.controller.getState().selected!.upload_status, 'pending_scan');
    assert.match(h.controller.getState().message!, /لم يُعتمد كملف نظيف/);
    h.controller.dispose();
});
test('unconfigured runtime never creates/signs/uploads and does not use a legacy route', async () => {
    const h = fixture();
    h.s.policy.upload_configured = false;
    await h.controller.load();
    h.controller.choose(file());
    await h.controller.create();
    await h.controller.authorize();
    await h.controller.upload();
    assert.deepEqual(h.s.calls, ['policy', 'mine']);
    h.controller.dispose();
});
test('storage failure blocks creation before sending and keeps it distinct from a failed write', async () => {
    const h = fixture();
    await h.controller.load();
    h.controller.choose(file());
    h.deps.key.save = () => { throw Error('storage'); };
    await h.controller.create();
    assert.equal(h.s.calls.includes('create'), false);
    assert.equal(h.controller.getState().phase, 'error');
    assert.match(h.controller.getState().message!, /لم يُرسل طلب إنشاء/);
    h.controller.dispose();
});
for (const action of ['create', 'transfer', 'finalize', 'cancel'] as const)
    test(`unknown ${action} outcome stops replay and recovery reads the server`, async () => {
        const h = fixture();
        await h.controller.load();
        h.controller.choose(file());
        if (action !== 'create')
            await h.controller.create();
        const original = h.deps[action];
        (h.deps as any)[action] = async (...args: any[]) => { await (original as any)(...args); throw new ApiRequestError('unknown', 503, 'PERSISTENCE_UNCERTAIN'); };
        const invoke = action === 'transfer' ? 'upload' : action;
        await h.controller[invoke]();
        assert.equal(h.controller.getState().phase, 'uncertain');
        const count = h.s.calls.filter(x => x === action).length;
        await h.controller[invoke]();
        assert.equal(h.s.calls.filter(x => x === action).length, count);
        await h.controller.load();
        assert.equal(h.controller.getState().phase, 'ready');
        assert.equal(h.controller.getState().authorized, false);
        assert.equal(h.s.calls.filter(x => x === action).length, count);
        h.controller.dispose();
    });
test('missing receipt is not rollback; only an explicit retry may use the same persisted key', async () => {
    const h = fixture();
    h.s.key = id(50);
    await h.controller.load();
    assert.equal(h.controller.getState().phase, 'uncertain');
    assert.equal(h.controller.getState().retryable, true);
    assert.equal(h.s.calls.includes('create'), false);
    h.controller.choose(file());
    await h.controller.create();
    assert.equal(h.s.key, id(50));
    assert.equal(h.s.calls.filter(x => x === 'persist-key').length, 0);
    assert.equal(h.s.rows.length, 1);
    h.controller.dispose();
});
test('unknown create retains its frozen file metadata; changing it cannot silently reuse the request', async () => {
    const h = fixture();
    await h.controller.load();
    h.controller.choose(file());
    h.deps.create = async () => { throw Error('network'); };
    await h.controller.create();
    await h.controller.load();
    h.controller.choose(new File([new Uint8Array(2048)], 'different.pdf', { type: 'application/pdf' }));
    assert.equal(h.controller.getState().fileName, null);
    assert.equal(h.s.key, id(50));
    h.controller.dispose();
});
for (const trigger of ['event', 'principal', 'dispose'])
    test(`retired ${trigger} response cannot restore receipt, authorization or file`, async () => {
        const h = fixture();
        await h.controller.load();
        h.controller.choose(file());
        const pending = deferred();
        h.deps.create = async () => pending.promise;
        const creation = h.controller.create();
        if (trigger === 'event')
            h.s.event();
        else if (trigger === 'principal')
            h.s.principal = 'B';
        else
            h.controller.dispose();
        const { file_name, file_type, ...raw } = receipt();
        pending.resolve({ ...raw, is_late: false, upload: auth() });
        await creation;
        assert.equal(h.controller.getState().selected, null);
        assert.equal(h.controller.getState().fileName, null);
        assert.equal(h.controller.getState().authorized, false);
        h.controller.dispose();
    });
test('write is single flight and timeout retires a late success without issuing another operation', async () => {
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
    let expire = () => { };
    (globalThis as any).setTimeout = (fn: () => void) => { expire = fn; return 1; };
    (globalThis as any).clearTimeout = () => { };
    const h = fixture();
    try {
        await h.controller.load();
        h.controller.choose(file());
        const pending = deferred();
        let creates = 0;
        h.deps.create = async () => { creates++; return pending.promise; };
        const creation = h.controller.create();
        await h.controller.create();
        assert.equal(creates, 1);
        expire();
        await creation;
        assert.equal(h.controller.getState().phase, 'uncertain');
        const { file_name, file_type, ...raw } = receipt();
        pending.resolve({ ...raw, is_late: false, upload: auth() });
        await new Promise(r => setImmediate(r));
        assert.equal(h.controller.getState().selected, null);
        assert.equal(h.s.calls.includes('transfer'), false);
    }
    finally {
        h.controller.dispose();
        globalThis.setTimeout = set;
        globalThis.clearTimeout = clear;
    }
});
test('revocation clears private state and freezes all later actions', async () => {
    const h = fixture();
    await h.controller.load();
    h.controller.choose(file());
    await h.controller.create();
    h.deps.authorize = async () => { throw new ApiRequestError('withdrawn', 403, 'CATALOG_HOMEWORK_DENIED'); };
    await h.controller.authorize();
    assert.equal(h.controller.getState().phase, 'denied');
    assert.equal(h.controller.getState().selected, null);
    assert.equal(h.controller.getState().fileName, null);
    const count = h.s.calls.length;
    await h.controller.load();
    assert.equal(h.s.calls.length, count);
    h.controller.dispose();
});
test('cancel preserves its receipt; only explicit new-version preparation clears the pointer after fresh policy', async () => {
    const h = fixture();
    await h.controller.load();
    h.controller.choose(file());
    await h.controller.create();
    await h.controller.cancel();
    assert.equal(h.controller.getState().selected!.status, 'revoked');
    assert.equal(h.s.key, id(50));
    await h.controller.newVersion();
    assert.equal(h.s.key, null);
    assert.equal(h.controller.getState().selected, null);
    assert.equal(h.controller.getState().fileName, null);
    h.controller.dispose();
});
test('confirmed quarantine is distinct from clean and cannot be automatically finalized or uploaded again', async () => {
    const h = fixture();
    await h.controller.load();
    h.controller.choose(file());
    await h.controller.create();
    h.deps.finalize = async () => ({ id: id(4), version: 1, status: 'submitted', file_size_bytes: 2048, upload_status: 'quarantined', scan_status: 'infected', error: 'rejected', code: 'scan_infected' } as any);
    await h.controller.finalize();
    assert.equal(h.controller.getState().phase, 'ready');
    assert.equal(h.controller.getState().selected!.upload_status, 'quarantined');
    assert.match(h.controller.getState().message!, /محجور/);
    const count = h.s.calls.length;
    await h.controller.upload();
    await h.controller.finalize();
    assert.equal(h.s.calls.length, count);
    h.controller.dispose();
});
test('file validation clears an invalid selection and never signs or transfers it', async () => {
    const h = fixture();
    await h.controller.load();
    h.controller.choose(file());
    for (const bad of [new File(['small'], 'hw.pdf', { type: 'application/pdf' }), new File([new Uint8Array(2048)], 'evil.exe'), new File([new Uint8Array(2048)], '../hw.pdf', { type: 'application/pdf' })]) {
        h.controller.choose(bad);
        assert.equal(h.controller.getState().fileName, null);
        await h.controller.create();
    }
    assert.equal(h.s.calls.includes('create'), false);
    h.controller.dispose();
});
test('canonical API requests keep bearer in headers and send only metadata/key or empty action body', async () => {
    const oldFetch = globalThis.fetch, oldStorage = globalThis.localStorage, calls: any[] = [];
    (globalThis as any).localStorage = { getItem: () => 'synthetic-token' };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
    try {
        const t = catalogHomeworkTransport(id(1), id(2), id(3)), signal = new AbortController().signal;
        await t.policy(signal);
        await t.mine(signal);
        await t.recover(id(50), signal);
        await t.create({ file_name: 'hw.pdf', file_type: 'application/pdf' }, id(50), signal);
        await t.authorize(id(4), signal);
        await t.finalize(id(4), signal);
        await t.cancel(id(4), signal);
        assert.deepEqual(calls.map(x => x.init.method ?? 'GET'), ['GET', 'GET', 'GET', 'POST', 'POST', 'POST', 'POST']);
        assert.deepEqual(JSON.parse(calls[3].init.body), { file_name: 'hw.pdf', file_type: 'application/pdf' });
        assert.equal(new Headers(calls[3].init.headers).get('Idempotency-Key'), id(50));
        for (const c of calls) {
            assert.equal(c.init.cache, 'no-store');
            assert.equal(new Headers(c.init.headers).get('Authorization'), 'Bearer synthetic-token');
            assert.ok(!String(c.url).includes('synthetic-token'));
        }
    }
    finally {
        globalThis.fetch = oldFetch;
        (globalThis as any).localStorage = oldStorage;
    }
});
test('storage PUT/POST use no bearer, cookies, redirects or referrer; 2xx only confirms transfer', async () => {
    const calls: any[] = [], signal = new AbortController().signal, fetcher: any = async (url: any, init: any) => { calls.push({ url, init }); return new Response('', { status: 200 }); };
    await transferHomeworkFile(parseUploadAuthorization(auth()), file(), signal, 'https://app.invalid', fetcher);
    await transferHomeworkFile(parseUploadAuthorization({ ...auth(), method: 'POST', required_headers: {}, fields: { key: 'private', policy: 'signed' } }), file(), signal, 'https://app.invalid', fetcher);
    for (const c of calls) {
        assert.equal(c.init.credentials, 'omit');
        assert.equal(c.init.redirect, 'error');
        assert.equal(c.init.referrerPolicy, 'no-referrer');
        assert.equal(new Headers(c.init.headers).get('Authorization'), null);
    }
    assert.equal(calls[0].init.body instanceof Blob, true);
    assert.equal(calls[1].init.body instanceof FormData, true);
    assert.equal(calls[1].init.body.get('file').name, 'hw.pdf');
    assert.equal(new Headers(calls[1].init.headers).get('Content-Type'), null);
    assert.throws(() => parseUploadAuthorization({ ...auth(), url: 'https://user:password@storage.invalid/key' }));
    assert.throws(() => parseUploadAuthorization({ ...auth(), required_headers: { Authorization: 'bearer' } }));
    assert.throws(() => parseUploadAuthorization({ ...auth(), method: 'POST', required_headers: {}, fields: { file: 'forged' } }));
    await assert.rejects(transferHomeworkFile(parseUploadAuthorization({ ...auth(), url: 'http://foreign.invalid/key' }), file(), signal, 'https://app.invalid', fetcher));
    await assert.rejects(transferHomeworkFile(parseUploadAuthorization({ ...auth(), expires_at: '2020-01-01T00:00:00.000Z' }), file(), signal, 'https://app.invalid', fetcher));
    assert.equal(calls.length, 2);
});
function loadPanel(state: any) {
    const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load, file = require.resolve('../features/catalog/StudentCatalogHomework.tsx'), effects: Function[] = [], snapshots: any[] = [], ref = { current: null };
    try {
        delete require.cache[file];
        module._load = function (name: string, parent: any, main: boolean) { if (name === 'react' && parent?.filename === file)
            return { ...React, useState: (initial: any) => [typeof initial === 'function' ? state : false, (next: any) => snapshots.push(next)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) }; if (name.startsWith('@/'))
            return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main); return original.call(this, name, parent, main); };
        return { component: require(file), effects, snapshots, React, require };
    }
    finally {
        module._load = original;
        delete require.cache[file];
    }
}
test('actual TSX renders scanner states honestly and escapes filenames without exposing signed URLs', () => {
    const previous = (globalThis as any).React;
    try {
        for (const [upload_status, scan_status, file_size_bytes] of [['pending_upload', 'pending', 0], ['pending_scan', 'pending', 2048], ['finalized', 'clean', 2048], ['quarantined', 'infected', 2048]] as const) {
            const selected = { ...receipt(), file_name: '<script>.pdf', upload_status, scan_status, file_size_bytes };
            const h = loadPanel({ ...initialHomeworkState(), phase: 'ready', policy: policy(), selected, history: [selected] });
            (globalThis as any).React = h.React;
            const html = h.require('react-dom/server').renderToStaticMarkup(h.component.StudentCatalogHomework({ courseId: id(1), lessonId: id(2), contentId: id(3) }));
            assert.match(html, /&lt;script&gt;/);
            assert.ok(!html.includes('https://storage.invalid'));
            if (upload_status === 'pending_scan')
                assert.match(html, /بانتظار فحص موثوق/);
            if (upload_status === 'quarantined')
                assert.match(html, /محجور/);
        }
    }
    finally {
        (globalThis as any).React = previous;
    }
});
test('actual mounted picker/create callbacks send no upload automatically and clear on workspace event', async () => {
    const previous = { fetch: globalThis.fetch, local: globalThis.localStorage, session: globalThis.sessionStorage, window: globalThis.window, React: (globalThis as any).React };
    const values = new Map<string, string>(), calls: any[] = [];
    (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'student', role: 'student' }) : key === 'currentStudentSpace' ? JSON.stringify({ tenant_id: 'tenant', student_enrollment_id: 'enrollment' }) : null };
    (globalThis as any).sessionStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    (globalThis as any).window = { location: { origin: 'https://app.invalid' }, addEventListener() { }, removeEventListener() { } };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); const p = String(url); if (p.endsWith('/submission-policy'))
        return new Response(JSON.stringify(policy())); if (p.endsWith('/mine'))
        return new Response('[]'); const { file_name, file_type, ...raw } = receipt(); return new Response(JSON.stringify({ ...raw, is_late: false, upload: auth() })); };
    let cleanup: Function | undefined;
    try {
        const h = loadPanel({ ...initialHomeworkState(), phase: 'ready', policy: policy() });
        (globalThis as any).React = h.React;
        const tree = h.component.StudentCatalogHomework({ courseId: id(1), lessonId: id(2), contentId: id(3) });
        cleanup = h.effects[0]();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 2);
        assert.ok(calls.every(c => !c.init.method));
        const find = (node: any, predicate: (x: any) => boolean): any => { if (!node || typeof node !== 'object')
            return null; if (predicate(node))
            return node; for (const child of [node.props?.children].flat(3)) {
            const found = find(child, predicate);
            if (found)
                return found;
        } return null; };
        find(tree, n => n.type === 'input' && n.props.type === 'file').props.onChange({ target: { files: [file()] } });
        find(tree, n => n.props?.children === 'تجهيز تسليم الملف').props.onClick();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 3);
        assert.equal(calls[2].init.method, 'POST');
        assert.equal(h.snapshots.at(-1).selected.id, id(4));
        assert.ok([...values.values()].every(value => /^[a-f\d-]{36}$/i.test(value)));
        h.require('../lib/session-events').notifySessionChange('scope');
        assert.equal(h.snapshots.at(-1).selected, null);
        assert.equal(h.snapshots.at(-1).fileName, null);
    }
    finally {
        cleanup?.();
        globalThis.fetch = previous.fetch;
        (globalThis as any).localStorage = previous.local;
        (globalThis as any).sessionStorage = previous.session;
        (globalThis as any).window = previous.window;
        (globalThis as any).React = previous.React;
    }
});
