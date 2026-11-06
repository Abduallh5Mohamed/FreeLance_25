import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivityEditor, initialActivityEditor, parseActivity, parseActivityList, parseActivitySources } from '../features/catalog/lesson-activities';
import { ApiRequestError, listLessonActivities, listLessonActivitySources, attachLessonActivity, detachLessonActivity } from '../lib/api-http';
const id = (n: number) => `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = (n = 4) => ({ source_id: id(n), title: 'واجب الدرس', source_status: 'draft' as const, audience: 'course' as const });
const content = () => ({ content_id: id(9), kind: 'homework' as const, ...source() });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const s = { principal: 'A', rows: [] as any[], calls: [] as any[], failRead: false, event: () => {} };
  const deps = {
    readPrincipal: () => s.principal, subscribeSession: (fn: () => void) => { s.event = fn; return () => { s.event = () => {}; }; },
    list: async (_signal: AbortSignal) => { if (s.failRead) throw Error('read failed'); return { activities: s.rows }; },
    options: async (cursor: string | null, _signal: AbortSignal) => { s.calls.push({ page: cursor }); return { sources: [source()], next_cursor: null }; },
    attach: async (sourceId: string, _signal: AbortSignal) => { s.calls.push({ attach: sourceId }); s.rows = [content()]; return { content: content(), unchanged: false }; },
    detach: async (contentId: string, _signal: AbortSignal) => { s.calls.push({ detach: contentId }); s.rows = []; return { detached: true, kind: 'homework' }; },
  };
  return { s, deps, controller: createActivityEditor('homework', deps) };
}
test('activity parsers refuse private fields, duplicate slots, invalid IDs and dishonest unavailable metadata', () => {
  assert.equal(parseActivity(content()).source_status, 'draft');
  for (const row of [{ ...content(), answers: [] }, { ...content(), content_id: [id(9)] }, { ...content(), source_status: 'unavailable' }, { ...content(), audience: 'unknown' }]) assert.throws(() => parseActivity(row));
  assert.throws(() => parseActivityList({ activities: [content(), { ...content(), content_id: id(10) }] }));
  assert.throws(() => parseActivitySources({ sources: [source(), source()], next_cursor: null }, null));
  assert.throws(() => parseActivitySources({ sources: [source(6)], next_cursor: id(5) }, null));
  assert.throws(() => parseActivitySources({ sources: [], next_cursor: id(5) }, id(5)));
});
test('editor is inert until opened; selection must be present in the authorized page', async () => {
  const h = fixture(); assert.equal(h.s.calls.length, 0); assert.equal(await h.controller.attach(id(4)), false);
  await h.controller.refresh(); assert.equal(h.controller.getState().phase, 'ready'); assert.equal(await h.controller.attach(id(90)), false); assert.equal(h.s.calls.length, 1); h.controller.dispose();
});
test('binding is single flight, then a confirmed detach preserves the original assessment', async () => {
  const h = fixture(); await h.controller.refresh(); const wait = deferred();
  h.deps.attach = async (sourceId, _signal) => { h.s.calls.push({ attach: sourceId }); return wait.promise; };
  const saving = h.controller.attach(id(4)); assert.equal(await h.controller.attach(id(4)), false);
  h.s.rows = [content()]; wait.resolve({ content: content(), unchanged: false }); assert.equal(await saving, true); assert.equal(h.controller.getState().current!.content_id, id(9));
  assert.equal(await h.controller.detach(id(90)), false); assert.equal(await h.controller.detach(id(9)), true); assert.equal(h.controller.getState().current, null);
  assert.deepEqual(h.s.calls.filter(call => call.attach || call.detach), [{ attach: id(4) }, { detach: id(9) }]); h.controller.dispose();
});
test('confirmed save with failed refresh is not a failed write and later refresh clears the obsolete stale warning', async () => {
  const h = fixture(); await h.controller.refresh(); h.s.failRead = true;
  assert.equal(await h.controller.attach(id(4)), true); assert.match(h.controller.getState().notice!, /الحفظ مؤكد/); assert.equal(h.controller.getState().stale, true);
  assert.equal(await h.controller.attach(id(4)), false); h.s.failRead = false; await h.controller.refresh();
  assert.equal(h.controller.getState().stale, false); assert.ok(!h.controller.getState().notice!.includes('القائمة لم تتحدث')); h.controller.dispose();
});
for (const reason of ['unknown', 'malformed', 'conflict']) test(`${reason} result blocks further writes until explicit read, with no automatic resend`, async () => {
  const h = fixture(); await h.controller.refresh();
  h.deps.attach = async (_id, _signal) => { h.s.calls.push({ attach: id(4) }); if (reason === 'malformed') return { content: { ...content(), kind: 'quiz' }, unchanged: false } as any; throw reason === 'conflict' ? new ApiRequestError('changed', 409) : new ApiRequestError('uncertain', 500, 'PERSISTENCE_UNCERTAIN'); };
  assert.equal(await h.controller.attach(id(4)), false); assert.equal(h.controller.getState().stale, true); assert.equal(await h.controller.attach(id(4)), false); assert.equal(h.s.calls.filter(call => call.attach).length, 1); h.controller.dispose();
});
for (const trigger of ['event', 'principal', 'dispose']) test(`a late binding acknowledgement cannot update a retired ${trigger} editor`, async () => {
  const h = fixture(); await h.controller.refresh(); const wait = deferred(); let signal: AbortSignal | undefined;
  h.deps.attach = async (_id, operation) => { signal = operation; return wait.promise; };
  const saving = h.controller.attach(id(4));
  if (trigger === 'event') h.s.event(); else if (trigger === 'principal') h.s.principal = 'B'; else h.controller.dispose();
  wait.resolve({ content: content(), unchanged: false }); assert.equal(await saving, false); assert.equal(h.controller.getState().current, null); assert.equal(signal!.aborted, true); h.controller.dispose();
});
test('source pagination is explicit, single flight and preserves the cursor on a malformed page', async () => {
  const h = fixture(); h.deps.options = async () => ({ sources: [source()], next_cursor: id(4) }) as any;
  await h.controller.refresh(); const wait = deferred(); let pages = 0;
  h.deps.options = async cursor => { pages++; assert.equal(cursor, id(4)); return wait.promise; };
  const loading = h.controller.more(); await h.controller.more(); assert.equal(pages, 1); wait.resolve({ sources: [source()], next_cursor: id(4) }); await loading;
  assert.equal(h.controller.getState().cursor, id(4)); assert.equal(h.controller.getState().options[0].source_id, id(4)); h.controller.dispose();
});
test('canonical activity transports use exact paths, source-only body, pinned deletion and no-store authentication', async () => {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage; const calls: any[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-login' : null };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
  try {
    await listLessonActivities(id(1), id(2), id(3)); await listLessonActivitySources(id(1), id(2), id(3), 'homework', id(4));
    await attachLessonActivity(id(1), id(2), id(3), 'homework', id(4)); await detachLessonActivity(id(1), id(2), id(3), 'homework', id(9));
    const base = `/api/tenants/me/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/activities`;
    assert.deepEqual(calls.map(call => call.url), [base, `${base}/homework/available-sources?cursor=${id(4)}`, `${base}/homework`, `${base}/homework/${id(9)}`]);
    assert.deepEqual(JSON.parse(calls[2].init.body), { source_id: id(4) }); assert.equal(calls[3].init.method, 'DELETE');
    calls.forEach(call => { assert.equal(call.init.cache, 'no-store'); assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer synthetic-login'); });
  } finally { globalThis.fetch = previousFetch; (globalThis as any).localStorage = previousStorage; }
});

test('actual activity editor effect and attach button use the canonical transport and confirmed refresh', async () => {
  const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, originalLoad = module._load;
  const file = require.resolve('../features/catalog/LessonActivityManager.tsx'), previousReact = (globalThis as any).React, previousWindow = globalThis.window, previousStorage = globalThis.localStorage, previousFetch = globalThis.fetch;
  const effects: Function[] = [], snapshots: any[] = [], calls: any[] = []; let rows: any[] = [], cleanup: Function | undefined, stateIndex = 0;
  (globalThis as any).React = React;
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-login' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === 'POST') { rows = [content()]; return new Response(JSON.stringify({ content: content(), unchanged: false })); }
    return new Response(JSON.stringify(String(url).includes('available-sources') ? { sources: [source()], next_cursor: null } : { activities: rows }));
  };
  try {
    delete require.cache[file];
    module._load = function(name: string, parent: any, main: boolean) {
      if (name === 'react' && parent?.filename === file) return { ...React, useState: () => { const i = stateIndex++; return [i === 0 ? { ...initialActivityEditor(), phase: 'ready', stale: false, options: [source()] } : i === 1 ? id(4) : false, (value: any) => { snapshots[i] = value; }]; }, useRef: () => ({ current: null }), useId: () => 'activity-source', useEffect: (fn: Function) => effects.push(fn) };
      if (name.startsWith('@/')) return originalLoad.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main);
      return originalLoad.call(this, name, parent, main);
    };
    const component = require(file), tree = component.LessonActivityEditor({ courseId: id(1), unitId: id(2), lessonId: id(3), kind: 'homework' });
    const html = require('react-dom/server').renderToStaticMarkup(tree); assert.match(html, /ربط الواجب بالدرس/); assert.equal(calls.length, 0);
    cleanup = effects[0](); await new Promise(resolve => setImmediate(resolve)); assert.equal(snapshots[0].phase, 'ready');
    const find = (node: any): any => { if (!node || typeof node !== 'object') return null; if (node.props?.children === 'ربط ' || Array.isArray(node.props?.children) && node.props.children.join('') === 'ربط الواجب بالدرس') return node; for (const child of [node.props?.children].flat(2)) { const result = find(child); if (result) return result; } return null; };
    await find(tree).props.onClick(); assert.equal(calls.filter(call => call.init?.method === 'POST').length, 1); assert.equal(snapshots[0].current.content_id, id(9));
    require('../lib/session-events').notifySessionChange('scope'); assert.equal(snapshots[0].phase, 'session-ended'); assert.equal(snapshots[0].current, null);
    stateIndex = 0; effects.length = 0;
  } finally { cleanup?.(); module._load = originalLoad; delete require.cache[file]; (globalThis as any).React = previousReact; (globalThis as any).window = previousWindow; (globalThis as any).localStorage = previousStorage; globalThis.fetch = previousFetch; }
});
