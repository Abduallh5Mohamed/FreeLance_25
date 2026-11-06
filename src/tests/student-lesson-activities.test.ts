import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, listStudentLessonActivities, readStudentLessonActivity } from '../lib/api-http';
import { createStudentActivities, initialStudentActivities, parseStudentActivities, parseStudentActivityDetail } from '../features/catalog/student-lesson-activities';
const id = (n: number) => `d3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = () => ({ content_id: id(3), kind: 'homework' as const, title: 'واجب منشور', launch_status: 'unconfigured' as const });
const detail = () => ({ activity: { ...row(), instructions: 'حل التدريبات المحددة', deadline_at: '1970-01-01T00:00:00.000Z' } });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const s = { principal: 'A', calls: [] as string[], event: () => {} };
  const deps = { list: async (_signal: AbortSignal) => { s.calls.push('list'); return { lesson_id: id(2), activities: [row()] }; }, detail: async (_id: string, _signal: AbortSignal) => { s.calls.push('detail'); return detail(); }, readPrincipal: () => s.principal, subscribeSession: (fn: () => void) => { s.event = fn; return () => { s.event = () => {}; }; } };
  return { s, deps, controller: createStudentActivities(id(2), deps) };
}
test('private activity DTOs reject source IDs, launch grants, duplicates, mismatched targets and invalid deadlines', () => {
  assert.equal(parseStudentActivities({ lesson_id: id(2), activities: [row()] }, id(2)).length, 1);
  for (const raw of [{ ...row(), source_id: id(4) }, { ...row(), launch_status: 'available' }]) assert.throws(() => parseStudentActivities({ lesson_id: id(2), activities: [raw] }, id(2)));
  assert.throws(() => parseStudentActivities({ lesson_id: id(2), activities: [row(), row()] }, id(2)));
  for (const change of [{ content_id: id(4) }, { kind: 'quiz' }, { source_id: id(5) }, { deadline_at: '2026-02-30T00:00:00.000Z' }, { instructions: 'x'.repeat(20001) }]) assert.throws(() => parseStudentActivityDetail({ activity: { ...detail().activity, ...change } }, row()));
});
test('quiz attempt_required is only a candidate for fresh proof, while homework cannot advertise quiz launch',()=>{
  const quiz={...row(),kind:'quiz' as const,launch_status:'attempt_required' as const};
  assert.equal(parseStudentActivities({lesson_id:id(2),activities:[quiz]},id(2))[0].launch_status,'attempt_required');
  assert.equal(parseStudentActivityDetail({activity:{...quiz,instructions:null,deadline_at:null}},quiz).kind,'quiz');
  assert.throws(()=>parseStudentActivities({lesson_id:id(2),activities:[{...row(),launch_status:'attempt_required'}]},id(2)));
});
test('homework submission_required mounts only its own candidate and cannot be advertised by a quiz',()=>{
  const homework={...row(),launch_status:'submission_required' as const};
  assert.equal(parseStudentActivities({lesson_id:id(2),activities:[homework]},id(2))[0].launch_status,'submission_required');
  assert.equal(parseStudentActivityDetail({activity:{...homework,instructions:'التعليمات',deadline_at:null}},homework).kind,'homework');
  assert.throws(()=>parseStudentActivities({lesson_id:id(2),activities:[{...homework,kind:'quiz'}]},id(2)));
});
test('reads are explicit, detail is single flight and no API operation starts or completes an assessment', async () => {
  const h = fixture(); assert.equal(h.s.calls.length, 0); await h.controller.open(id(3)); assert.equal(h.s.calls.length, 0);
  await h.controller.load(); const wait = deferred(); h.deps.detail = async () => { h.s.calls.push('detail'); return wait.promise; };
  const opening = h.controller.open(id(3)); await h.controller.open(id(3)); assert.equal(h.s.calls.filter(call => call === 'detail').length, 1);
  wait.resolve(detail()); await opening; assert.equal(h.controller.getState().detail!.instructions, detail().activity.instructions); h.controller.close(); assert.equal(h.controller.getState().detail, null); h.controller.dispose();
});
for (const trigger of ['event', 'principal', 'dispose']) test(`retired ${trigger} detail cannot restore instructions`, async () => {
  const h = fixture(); await h.controller.load(); const wait = deferred(); let signal: AbortSignal | undefined;
  h.deps.detail = async (_id, operation) => { signal = operation; return wait.promise; }; const opening = h.controller.open(id(3));
  if (trigger === 'event') h.s.event(); else if (trigger === 'principal') h.s.principal = 'B'; else h.controller.dispose();
  wait.resolve(detail()); await opening; assert.equal(h.controller.getState().detail, null); assert.equal(signal!.aborted, true); h.controller.dispose();
});
test('revocation clears all private state; an unavailable read offers retry without treating metadata as a launch grant', async () => {
  const h = fixture(); await h.controller.load(); await h.controller.open(id(3));
  h.deps.detail = async () => { throw new ApiRequestError('removed', 404); }; await h.controller.open(id(3)); assert.equal(h.controller.getState().rows.length, 0); assert.equal(h.controller.getState().detail, null); assert.equal(h.controller.getState().phase, 'error');
  await h.controller.load(); h.deps.detail = async () => { throw new ApiRequestError('unavailable', 503); }; await h.controller.open(id(3)); assert.equal(h.controller.getState().detail, null); assert.equal(h.controller.getState().rows.length, 1); h.controller.dispose();
});
test('late metadata after a workspace change cannot expose titles', async () => {
  const h = fixture(), wait = deferred(); h.deps.list = async () => wait.promise;
  const loading = h.controller.load(); h.s.event(); wait.resolve({ lesson_id: id(2), activities: [row()] }); await loading;
  assert.equal(h.controller.getState().rows.length, 0); assert.equal(h.controller.getState().phase, 'session-ended'); h.controller.dispose();
});
test('an aborted detail response is never displayed even if its transport resolves afterward', async () => {
  const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout; let deadline = () => {};
  (globalThis as any).setTimeout = (fn: () => void) => { deadline = fn; return 1; }; (globalThis as any).clearTimeout = () => {};
  const h = fixture();
  try { await h.controller.load(); const wait = deferred(); h.deps.detail = async () => wait.promise; const opening = h.controller.open(id(3)); deadline(); wait.resolve(detail()); await opening; assert.equal(h.controller.getState().detail, null); assert.equal(h.controller.getState().loadingId, null); }
  finally { h.controller.dispose(); globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear; }
});
test('canonical list/detail transports are authenticated no-store GETs with only catalog reference paths', async () => {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage, calls: any[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-login' : null };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
  try {
    await listStudentLessonActivities(id(1), id(2)); await readStudentLessonActivity(id(1), id(2), id(3));
    const base = `/api/student-course-access/courses/${id(1)}/lessons/${id(2)}/activities`;
    assert.deepEqual(calls.map(call => call.url), [base, `${base}/${id(3)}`]);
    for (const call of calls) { assert.equal(call.init.method ?? 'GET', 'GET'); assert.equal(call.init.body, undefined); assert.equal(call.init.cache, 'no-store'); assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer synthetic-login'); }
  } finally { globalThis.fetch = previousFetch; (globalThis as any).localStorage = previousStorage; }
});
function loadPanel(state?: any) {
  const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load;
  const file = require.resolve('../features/catalog/StudentLessonActivities.tsx'), previousReact = (globalThis as any).React;
  const effects: Function[] = [], snapshots: any[] = []; (globalThis as any).React = React;
  try {
    delete require.cache[file]; module._load = function(name: string, parent: any, main: boolean) {
      if (name === 'react' && parent?.filename === file) return { ...React, useState: (initial: any) => [state ?? (typeof initial === 'function' ? initial() : initial), (value: any) => snapshots.push(value)], useRef: () => ({ current: null }), useEffect: (fn: Function) => effects.push(fn) };
      if (name.startsWith('@/')) return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main);
      return original.call(this, name, parent, main);
    };
    return { component: require(file), effects, snapshots, React, require };
  } finally { module._load = original; (globalThis as any).React = previousReact; delete require.cache[file]; }
}
test('actual panel is collapsed initially and authorized instructions render escaped without any legacy launch link', () => {
  const previousReact = (globalThis as any).React;
  try {
    const closed = loadPanel(false); (globalThis as any).React = closed.React;
    const html = closed.require('react-dom/server').renderToStaticMarkup(closed.component.StudentLessonActivities({ courseId: id(1), lessonId: id(2) })); assert.match(html, /عرض واجب وكويز الدرس/); assert.equal(closed.effects.length, 0);
    const ready = loadPanel({ ...initialStudentActivities(), phase: 'ready', rows: [row()], detail: { ...detail().activity, instructions: '<script>private</script>' } }); (globalThis as any).React = ready.React;
    const rendered = ready.require('react-dom/server').renderToStaticMarkup(ready.component.StudentLessonActivityList({ courseId: id(1), lessonId: id(2) }));
    assert.match(rendered, /&lt;script&gt;/); assert.match(rendered, /لا يبدأ محاولة/); assert.ok(!/<a\b|<form\b|<iframe\b/.test(rendered)); assert.ok(!rendered.includes('/exams/'));
  } finally { (globalThis as any).React = previousReact; }
});
test('actual panel effect and detail button perform only their two canonical reads and clear on scope change', async () => {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage, previousWindow = globalThis.window, previousReact = (globalThis as any).React;
  const calls: any[] = []; let cleanup: Function | undefined;
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-login' : key === 'currentUser' ? JSON.stringify({ id: 'student', role: 'student' }) : null };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(String(url).endsWith('/' + id(3)) ? detail() : { lesson_id: id(2), activities: [row()] })); };
  try {
    const view = loadPanel({ ...initialStudentActivities(), phase: 'ready', rows: [row()] }); (globalThis as any).React = view.React;
    const tree = view.component.StudentLessonActivityList({ courseId: id(1), lessonId: id(2) }); assert.equal(calls.length, 0); cleanup = view.effects[0](); await new Promise(resolve => setImmediate(resolve));
    const find = (node: any): any => { if (!node || typeof node !== 'object') return null; if (node.props?.children === 'عرض التعليمات والتفاصيل') return node; for (const child of [node.props?.children].flat(2)) { const result = find(child); if (result) return result; } return null; };
    find(tree).props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2); assert.equal(view.snapshots.at(-1).detail.content_id, id(3)); assert.ok(calls.every(call => !call.init.method || call.init.method === 'GET'));
    view.require('../lib/session-events').notifySessionChange('scope'); assert.equal(view.snapshots.at(-1).detail, null); assert.equal(view.snapshots.at(-1).rows.length, 0);
  } finally { cleanup?.(); globalThis.fetch = previousFetch; (globalThis as any).localStorage = previousStorage; (globalThis as any).window = previousWindow; (globalThis as any).React = previousReact; }
});
