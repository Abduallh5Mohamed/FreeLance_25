import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, listStudentLessonContents } from '../lib/api-http';
import { createStudentLessonContentsController, initialStudentLessonContentsState, parseStudentLessonContents, type StudentLessonContentsState } from '../features/catalog/student-lesson-contents';

const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n = 1) => ({ content_id: id(n), title: 'تدريبات الدرس', material_type: 'pdf', display_order: n - 1, delivery_status: 'unavailable' });
const envelope = (rows: any[] = [row()]) => ({ lesson_id: id(7), contents: rows });
const deferred = () => { let resolve!: (x: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let principal: string | null = 'student-A'; let event = () => {};
  let result: unknown = envelope(); let calls = 0, unsubscribed = 0;
  const deps = { list: async (): Promise<unknown> => { calls++; return result; }, readPrincipal: () => principal,
    subscribeSession: (fn: () => void) => { event = fn; return () => { unsubscribed++; }; } };
  const controller = createStudentLessonContentsController(id(7), deps);
  return { controller, deps, calls: () => calls, unsubscribed: () => unsubscribed,
    result: (value: unknown) => { result = value; }, change: (p: string | null, notify = true) => { principal = p; if (notify) event(); } };
}
test('strict student projection is lesson-bound and has no URL, material/tenant locator or fabricated readiness', () => {
  assert.deepEqual(parseStudentLessonContents(envelope(), id(7)), [row()]);
  for (const value of [null, [], { ...envelope(), tenant_id: id(8) }, { ...envelope(), lesson_id: id(8) },
    envelope([{ ...row(), file_url: 'private' }]), envelope([{ ...row(), material_id: id(5) }]),
    envelope([{ ...row(), delivery_status: 'ready' }]), envelope([{ ...row(), display_order: '0' }]),
    envelope([row(), row()]), envelope([row(2), row()]), envelope(Array.from({ length: 21 }, (_, i) => row(i + 1)))]) {
    assert.throws(() => parseStudentLessonContents(value, id(7)));
  }
});
test('explicit load only; no per-row fetch, automatic completion or delivery request', async () => {
  const h = fixture(); assert.equal(h.calls(), 0); await h.controller.load();
  assert.equal(h.calls(), 1); assert.equal(h.controller.getState().rows.length, 1); assert.equal(h.controller.getState().phase, 'ready'); h.controller.dispose();
});
test('single-flight reads; a fresh empty response removes withdrawn material', async () => {
  const h = fixture(), pending = deferred(); h.deps.list = async () => pending.promise;
  const loading = h.controller.load(); await h.controller.load();
  assert.equal(h.controller.getState().phase, 'loading'); pending.resolve(envelope()); await loading;
  h.deps.list = async () => envelope([]); await h.controller.load(); assert.equal(h.controller.getState().rows.length, 0); h.controller.dispose();
});
for (const failure of [new ApiRequestError('locked', 409, 'LESSON_LOCKED'), new ApiRequestError('unconfigured', 503, 'LESSON_CONTENTS_UNAVAILABLE'),
  new ApiRequestError('revoked', 404), new ApiRequestError('session', 401), new ApiRequestError('role', 403), new Error('network')]) {
  test(`failed read ${failure.message} clears old private rows`, async () => {
    const h = fixture(); await h.controller.load(); h.deps.list = async () => { throw failure; }; await h.controller.load();
    assert.equal(h.controller.getState().rows.length, 0); assert.notEqual(h.controller.getState().phase, 'ready'); assert.ok(h.controller.getState().message); h.controller.dispose();
  });
}
for (const fence of ['event', 'silent', 'ABA', 'dispose']) {
  test(`old response cannot revive private materials after ${fence}`, async () => {
    const h = fixture(), pending = deferred(); h.deps.list = async () => pending.promise;
    const loading = h.controller.load();
    if (fence === 'dispose') h.controller.dispose(); else if (fence === 'ABA') { h.change('B'); h.change('student-A'); } else h.change('B', fence !== 'silent');
    pending.resolve(envelope()); await loading; assert.equal(h.controller.getState().rows.length, 0); h.controller.dispose(); assert.equal(h.unsubscribed(), 1);
  });
}
test('canonical HTTP read sends only bound course/lesson, bearer and no-store', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-token' : null };
  const calls: any[] = []; globalThis.fetch = async (url: any, init: any) => { calls.push([url, init]); return new Response(JSON.stringify(envelope())); };
  try {
    await listStudentLessonContents(id(6), id(7)); assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `/api/student-course-access/courses/${id(6)}/lessons/${id(7)}/contents`);
    assert.equal(new Headers(calls[0][1].headers).get('Authorization'), 'Bearer synthetic-token');
    assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].body, undefined);
  } finally { globalThis.fetch = originalFetch; (globalThis as any).localStorage = originalStorage; }
});

function render(state?: StudentLessonContentsState, effects?: (() => () => void)[], onSnapshot?: (s: StudentLessonContentsState) => void) {
  const require = Module.createRequire(import.meta.url), React = require('react');
  const module = Module as any, original = module._load, previousReact = (globalThis as any).React;
  const file = require.resolve('../features/catalog/StudentLessonMaterials.tsx'); (globalThis as any).React = React;
  try {
    delete require.cache[file];
    module._load = function(name: string, parent: any, main: boolean) {
      if (name === 'react' && parent?.filename === file) return { ...React, useState: state ? () => [state, (s: any) => onSnapshot?.(s)] : () => [false, () => {}],
        useRef: () => ({ current: null }), useEffect: (fn: () => () => void) => { effects?.push(fn); } };
      if (name.startsWith('@/')) return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main);
      return original.call(this, name, parent, main);
    };
    const component = require(file), tree = (state ? component.StudentLessonMaterialList : component.StudentLessonMaterials)({ courseId: id(6), lessonId: id(7) });
    return require('react-dom/server').renderToStaticMarkup(tree) as string;
  } finally { module._load = original; (globalThis as any).React = previousReact; delete require.cache[file]; }
}
test('real student panel is collapsed by default; known material displays no fake playback or link', () => {
  const closed = render(); assert.match(closed, /عرض مواد الدرس/); assert.ok(!closed.includes('تدريبات الدرس'));
  const ready = render({ ...initialStudentLessonContentsState(), phase: 'ready', rows: [row()] as any, message: null });
  assert.match(ready, /dir="rtl"/); assert.match(ready, /تدريبات الدرس/); assert.match(ready, /فتح هذه المادة غير متاح/);
  assert.ok(!/<a\b|<video\b|<iframe\b/.test(ready));
});
test('real student panel effect uses actual controller/transport and clears on the actual session event', async () => {
  const require = Module.createRequire(import.meta.url), originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage, originalWindow = globalThis.window;
  const events = new Set<unknown>(); const calls: string[] = []; let snapshot = initialStudentLessonContentsState(); let cleanup: (() => void) | undefined;
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-token' : key === 'currentUser' ? JSON.stringify({ id: 'synthetic-student', role: 'student' }) : null };
  (globalThis as any).window = { addEventListener: (_: string, fn: unknown) => events.add(fn), removeEventListener: (_: string, fn: unknown) => events.delete(fn) };
  globalThis.fetch = async (url: any) => { calls.push(String(url)); return new Response(JSON.stringify(envelope())); };
  try {
    const effects: (() => () => void)[] = []; render(initialStudentLessonContentsState(), effects, s => { snapshot = s; });
    assert.equal(calls.length, 0); cleanup = effects[0](); await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshot.phase, 'ready'); assert.equal(snapshot.rows.length, 1); assert.equal(events.size, 1);
    assert.deepEqual(calls, [`/api/student-course-access/courses/${id(6)}/lessons/${id(7)}/contents`]);
    require('../lib/session-events').notifySessionChange('scope'); assert.equal(snapshot.phase, 'session-ended'); assert.equal(snapshot.rows.length, 0);
    cleanup(); cleanup = undefined; assert.equal(events.size, 0);
  } finally { cleanup?.(); globalThis.fetch = originalFetch; (globalThis as any).localStorage = originalStorage; (globalThis as any).window = originalWindow; }
});
