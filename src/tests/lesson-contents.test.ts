import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, listLessonContents, listLessonMaterialOptions, attachLessonMaterial, detachLessonMaterial } from '../lib/api-http';
import { createLessonContentsController, initialLessonContentsState, parseLessonContent, parseLessonContents, parseLessonMaterialOptions, type LessonContentsState } from '../features/catalog/lesson-contents';

const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const content = (n = 1) => ({ content_id: id(n + 100), material_id: id(n), title: 'شرح الدرس', material_type: 'pdf', display_order: n - 1 });
const option = (n = 1) => ({ material_id: id(n), title: 'شرح الدرس', material_type: 'pdf', is_published: false });
const deferred = <T,>() => { let resolve!: (x: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function harness() {
  let principal: string | null = 'A'; let changed = () => {};
  let rows: unknown = { contents: [] }; let sources: unknown = { materials: [option()], next_cursor: null };
  const calls: any[] = [];
  const api = {
    list: async (): Promise<unknown> => { calls.push(['list']); return rows; },
    options: async (cursor: string | null): Promise<unknown> => { calls.push(['options', cursor]); return sources; },
    attach: async (input: any): Promise<unknown> => { calls.push(['attach', input]); return { content: { ...content(), ...input }, unchanged: false }; },
    detach: async (key: string): Promise<unknown> => { calls.push(['detach', key]); return { detached: true, content_id: key }; },
    readPrincipal: () => principal,
    subscribeSession: (fn: () => void) => { changed = fn; return () => { calls.push(['unsubscribe']); }; },
  };
  const controller = createLessonContentsController(api);
  return { api, calls, controller, rows: (x: unknown) => { rows = x; }, sources: (x: unknown) => { sources = x; }, session: (p: string | null, notify = true) => { principal = p; if (notify) changed(); } };
}

test('strict DTOs reject URL extras, duplicate material/order/id, oversized and unsorted data', () => {
  assert.deepEqual(parseLessonContents({ contents: [content()] }), [content()]);
  for (const bad of [null, [], { contents: [], tenant_id: id(9) }, { contents: [content(), content()] },
    { contents: [content(2), content()] }, { contents: [content(), { ...content(2), display_order: 0 }] },
    { contents: Array.from({ length: 21 }, (_, i) => content(i + 1)) }, { contents: [{ ...content(), file_url: 'private' }] }]) assert.throws(() => parseLessonContents(bad));
  for (const bad of [{ ...content(), title: '' }, { ...content(), display_order: '0' }, { ...content(), display_order: -1 }, { ...content(), content_id: 'bad' }]) assert.throws(() => parseLessonContent(bad));
});
test('strict selector parser enforces boolean publication, bounded forward pages and exact cursor', () => {
  assert.deepEqual(parseLessonMaterialOptions({ materials: [option()], next_cursor: null }, null).rows, [option()]);
  const page = Array.from({ length: 25 }, (_, i) => option(i + 1));
  assert.equal(parseLessonMaterialOptions({ materials: page, next_cursor: id(25) }, null).nextCursor, id(25));
  for (const bad of [{ materials: [option()], next_cursor: id(1) }, { materials: [{ ...option(), is_published: 0 }], next_cursor: null },
    { materials: [option(), option()], next_cursor: null }, { materials: [...page, option(26)], next_cursor: null },
    { materials: page, next_cursor: id(24) }, { materials: [{ ...option(), file_url: 'private' }], next_cursor: null }]) assert.throws(() => parseLessonMaterialOptions(bad, null));
  assert.throws(() => parseLessonMaterialOptions({ materials: [option()], next_cursor: null }, id(1)));
});
test('opening controller alone makes no request; explicit refresh loads contents and first options page', async () => {
  const h = harness(); assert.equal(h.calls.length, 0); await h.controller.refresh();
  assert.deepEqual(h.calls, [['list'], ['options', null]]); assert.equal(h.controller.getState().phase, 'ready');
  h.controller.dispose();
});
for (const amount of ['12abc', '1.2', '-1', 'Infinity', '', '2147483648']) {
  test(`invalid position ${JSON.stringify(amount)} never writes`, async () => {
    const h = harness(); await h.controller.refresh(); assert.equal(await h.controller.attach(id(1), amount), false);
    assert.ok(!h.calls.some(x => x[0] === 'attach')); h.controller.dispose();
  });
}
test('attach validates actual option, existing source, position conflicts and cap before request', async () => {
  const h = harness(); h.rows({ contents: [content()] }); await h.controller.refresh();
  assert.equal(await h.controller.attach(id(2), '1'), false);
  assert.equal(await h.controller.attach(id(1), '1'), false);
  h.sources({ materials: [option(2)], next_cursor: null }); await h.controller.options();
  assert.equal(await h.controller.attach(id(2), '0'), false);
  assert.ok(!h.calls.some(x => x[0] === 'attach')); h.controller.dispose();
});
test('single-flight write; confirmed save with failed refresh stays confirmed and prevents stale writes', async () => {
  const h = harness(); await h.controller.refresh(); const pending = deferred<unknown>(); let writes = 0;
  h.api.attach = async () => { writes++; return pending.promise; };
  const saving = h.controller.attach(id(1), '0'); assert.equal(await h.controller.attach(id(1), '0'), false); assert.equal(writes, 1);
  h.api.list = async () => { throw Error('read failed'); };
  pending.resolve({ content: content(), unchanged: false }); assert.equal(await saving, true);
  const s = h.controller.getState(); assert.match(s.notice!, /تم تأكيد/); assert.match(s.error!, /القائمة المعروضة قديمة/); assert.equal(s.stale, true); assert.equal(s.busy, false);
  assert.equal(await h.controller.attach(id(1), '0'), false); assert.equal(writes, 1);
  h.api.list = async () => ({ contents: [content()] }); await h.controller.refresh(); assert.equal(h.controller.getState().stale, false); h.controller.dispose();
});
for (const response of ['network', 'malformed', 'wrong-target', 'commit']) {
  test(`uncertain ${response} never claims save or retries automatically; successful refresh reconciles`, async () => {
    const h = harness(); await h.controller.refresh(); let calls = 0;
    h.api.attach = async () => { calls++;
      if (response === 'network') throw Error('network'); if (response === 'commit') throw new ApiRequestError('lost', 500, 'PERSISTENCE_UNCERTAIN');
      return response === 'malformed' ? { success: true } : { content: content(2), unchanged: false };
    };
    assert.equal(await h.controller.attach(id(1), '0'), false); assert.equal(calls, 1);
    assert.equal(h.controller.getState().notice, null); assert.equal(h.controller.getState().stale, true);
    assert.equal(await h.controller.attach(id(1), '0'), false); assert.equal(calls, 1);
    await h.controller.refresh(); assert.equal(h.controller.getState().stale, false); h.controller.dispose();
  });
}
test('definite conflict preserves current list and permits deliberate retry', async () => {
  const h = harness(); await h.controller.refresh(); h.api.attach = async () => { throw new ApiRequestError('Position conflicts', 409); };
  assert.equal(await h.controller.attach(id(1), '0'), false); assert.equal(h.controller.getState().stale, false); assert.equal(h.controller.getState().busy, false); h.controller.dispose();
});
for (const status of [401, 403, 404, 503]) {
  test(`authorization/schema failure ${status} clears private contents and options`, async () => {
    const h = harness(); h.rows({ contents: [content()] }); await h.controller.refresh();
    h.api.list = async () => { throw new ApiRequestError('unavailable', status, status === 503 ? 'LESSON_CONTENTS_UNAVAILABLE' : undefined); };
    await h.controller.refresh(); assert.equal(h.controller.getState().contents.length, 0); assert.equal(h.controller.getState().options.length, 0);
    assert.equal(h.controller.getState().phase, status === 503 ? 'unavailable' : 'denied'); h.controller.dispose();
  });
}
test('failed options page clears options only; explicit reload starts at beginning', async () => {
  const h = harness(); h.sources({ materials: Array.from({ length: 25 }, (_, i) => option(i + 1)), next_cursor: id(25) }); await h.controller.refresh();
  const old = h.api.options; h.api.options = async () => { throw Error('network'); }; await h.controller.options(true);
  assert.equal(h.controller.getState().options.length, 0); assert.ok(h.controller.getState().optionsError); assert.equal(h.controller.getState().phase, 'ready');
  h.api.options = old; await h.controller.options(); assert.deepEqual(h.calls.at(-1), ['options', null]); h.controller.dispose();
});
test('detach confirms exact binding, refreshes and retains original source semantics', async () => {
  const h = harness(); h.rows({ contents: [content()] }); await h.controller.refresh(); h.rows({ contents: [] });
  assert.equal(await h.controller.detach(id(101)), true); assert.deepEqual(h.calls.filter(x => x[0] === 'detach'), [['detach', id(101)]]);
  assert.match(h.controller.getState().notice!, /المادة الأصلية محفوظة/); h.controller.dispose();
});
for (const fence of ['notify', 'silent-change', 'ABA', 'dispose'] as const) {
  test(`pending private response cannot revive after ${fence}`, async () => {
    const h = harness(); const pending = deferred<unknown>(); h.api.list = async () => pending.promise;
    const loading = h.controller.refresh();
    if (fence === 'dispose') h.controller.dispose();
    else if (fence === 'ABA') { h.session('B'); h.session('A'); }
    else h.session('B', fence !== 'silent-change');
    pending.resolve({ contents: [content()] }); await loading;
    assert.equal(h.controller.getState().contents.length, 0); assert.ok(!h.calls.some(x => x[0] === 'options'));
    h.controller.dispose();
  });
}
test('canonical transport sends correct paths, bearer, strict bodies and no client authority', async () => {
  const oldFetch = globalThis.fetch; const oldStorage = globalThis.localStorage;
  const calls: { url: string; init: RequestInit }[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-token' : null };
  globalThis.fetch = async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({}), { status: 200 }); };
  try {
    await listLessonContents(id(1), id(2), id(3)); await listLessonMaterialOptions(id(1), id(2), id(3), id(4));
    await attachLessonMaterial(id(1), id(2), id(3), { material_id: id(4), display_order: 0, tenant_id: 'discard' } as any);
    await detachLessonMaterial(id(1), id(2), id(3), id(101));
    const base = `/api/tenants/me/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/contents`;
    assert.deepEqual(calls.map(c => c.url), [base, `${base}/available-materials?cursor=${id(4)}`, base, `${base}/${id(101)}`]);
    assert.deepEqual(JSON.parse(calls[2].init.body as string), { material_id: id(4), display_order: 0 });
    assert.equal(calls[3].init.body, undefined);
    assert.ok(calls.every(c => new Headers(c.init.headers).get('Authorization') === 'Bearer synthetic-token' && c.init.cache === 'no-store'));
  } finally { globalThis.fetch = oldFetch; (globalThis as any).localStorage = oldStorage; }
});

// Real component markup and callbacks, with only hook values/controller leaf injected.
function component(state?: LessonContentsState, controller: any = {}, selected = '', removeId: string | null = null,
  effects?: (() => () => void)[], onSnapshot?: (s: LessonContentsState) => void) {
  const require = Module.createRequire(import.meta.url), React = require('react');
  const internals = Module as any, original = internals._load;
  const file = require.resolve('../features/catalog/LessonContentManager.tsx');
  const previousReact = (globalThis as any).React; (globalThis as any).React = React;
  let index = 0; const snapshots = [state, selected, '0', removeId];
  try {
    delete require.cache[file];
    internals._load = function (name: string, parent: any, main: boolean) {
      if (name === 'react' && parent?.filename === file) return { ...React,
        useState: state ? () => { const slot = index++; return [snapshots[slot], (value: any) => { if (slot === 0) onSnapshot?.(value); }]; } : (initial: any) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: (effect: () => () => void) => { effects?.push(effect); }, useRef: () => ({ current: controller }), useId: () => 'content-test' };
      if (name.startsWith('@/')) return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), name.slice(2)), parent, main);
      return original.call(this, name, parent, main);
    };
    const module = require(file);
    const tree = (state ? module.LessonContentEditor : module.LessonContentManager)({ courseId: id(9), unitId: id(8), lessonId: id(7) });
    return { tree, html: require('react-dom/server').renderToStaticMarkup(tree) as string };
  } finally { internals._load = original; (globalThis as any).React = previousReact; delete require.cache[file]; }
}
function nodes(tree: any, predicate: (x: any) => boolean): any[] {
  if (Array.isArray(tree)) return tree.flatMap(x => nodes(x, predicate));
  if (!tree?.props) return []; return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate)];
}
test('real collapsed component exposes opening action and no private rows or form', () => {
  const { html } = component(); assert.match(html, /إدارة محتويات الدرس/); assert.ok(!html.includes('<form')); assert.ok(!html.includes('شرح الدرس'));
});
test('real editor renders RTL bound labels, draft choice, preserved source notice and passes actual form input', async () => {
  const calls: any[] = []; const state = { ...initialLessonContentsState(), phase: 'ready' as const, stale: false, options: [option()] };
  const { tree, html } = component(state, { attach: async (...args: any[]) => { calls.push(args); return true; } }, id(1));
  assert.match(html, /dir="rtl"/); assert.match(html, /مسودة/); assert.match(html, /for="content-test-material"/); assert.match(html, /for="content-test-order"/);
  await nodes(tree, x => x.type === 'form')[0].props.onSubmit({ preventDefault() {} }); assert.deepEqual(calls, [[id(1), '0']]);
});
test('real editor requires explicit detach confirmation and disables stale writes while keeping refresh available', async () => {
  const calls: string[] = []; const state = { ...initialLessonContentsState(), phase: 'ready' as const, stale: false, contents: [content()] };
  const { tree, html } = component(state, { detach: async (key: string) => { calls.push(key); return true; } }, '', id(101));
  assert.match(html, /المادة الأصلية ستظل محفوظة/);
  const confirm = nodes(tree, x => x.props.children === 'تأكيد فك الربط')[0]; await confirm.props.onClick(); assert.deepEqual(calls, [id(101)]);
  const stale = component({ ...state, stale: true, notice: 'تم تأكيد ربط المادة بالدرس.', error: 'القائمة قديمة' }).html;
  assert.match(stale, /تم تأكيد ربط/); assert.match(stale, /القائمة قديمة/);
  const buttons = nodes(component({ ...state, stale: true }).tree, x => x.props.children === 'فك الربط' || x.props.children === 'تحديث محتويات الدرس');
  assert.equal(buttons.find(x => x.props.children === 'فك الربط').props.disabled, true);
  assert.equal(buttons.find(x => x.props.children === 'تحديث محتويات الدرس').props.disabled, false);
});
test('real editor lifecycle wires actual controller and HTTP to its bound lesson, then retires on session change', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage, originalWindow = globalThis.window;
  const events = new Set<unknown>(); const calls: { url: string; method: string }[] = [];
  let stored = false; let last = initialLessonContentsState(); let cleanup: (() => void) | undefined;
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-owner-token' : key === 'currentUser' ? JSON.stringify({ id: 'synthetic-owner', role: 'instructor' }) : null };
  (globalThis as any).window = { addEventListener: (_: string, fn: unknown) => events.add(fn), removeEventListener: (_: string, fn: unknown) => events.delete(fn) };
  globalThis.fetch = async (url: any, init: any) => {
    const endpoint = String(url); const method = init.method ?? 'GET'; calls.push({ url: endpoint, method });
    let body: any = endpoint.endsWith('available-materials') ? { materials: [option()], next_cursor: null } : { contents: stored ? [content()] : [] };
    if (method === 'POST') { stored = true; body = { content: content(), unchanged: false }; }
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200 });
  };
  try {
    const effects: (() => () => void)[] = [];
    const { tree } = component({ ...initialLessonContentsState(), phase: 'ready', stale: false, options: [option()] }, {}, id(1), null, effects, snapshot => { last = snapshot; });
    assert.equal(calls.length, 0); cleanup = effects[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(last.phase, 'ready'); assert.equal(last.busy, false); assert.equal(events.size, 1);
    await nodes(tree, x => x.type === 'form')[0].props.onSubmit({ preventDefault() {} });
    assert.equal(stored, true); assert.equal(last.contents.length, 1); assert.match(last.notice!, /تم تأكيد/);
    const base = `/api/tenants/me/catalog/courses/${id(9)}/units/${id(8)}/lessons/${id(7)}/contents`;
    assert.deepEqual(calls, [{ url: base, method: 'GET' }, { url: base + '/available-materials', method: 'GET' }, { url: base, method: 'POST' }, { url: base, method: 'GET' }]);
    // The rendered module is loaded through CommonJS; notify its actual module instance.
    Module.createRequire(import.meta.url)('../lib/session-events').notifySessionChange('scope');
    assert.equal(last.phase, 'session-ended'); assert.equal(last.contents.length, 0);
    cleanup(); cleanup = undefined; assert.equal(events.size, 0);
    await nodes(tree, x => x.type === 'form')[0].props.onSubmit({ preventDefault() {} }); assert.equal(calls.length, 4);
  } finally { cleanup?.(); globalThis.fetch = originalFetch; (globalThis as any).localStorage = originalStorage; (globalThis as any).window = originalWindow; }
});
