import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareLessonPackages, createPackagePreview, initialPackagePreview, lessonPackageReader, type PackageSnapshot } from '../features/catalog/lesson-package-preview';
const id = (n: number) => `b3100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const empty = (): PackageSnapshot => ({ materials: [], videos: [], activities: [], announcement: null, quizPin: null });
const material = (n = 10, order = 0) => ({ content_id: id(n + 100), material_id: id(n), title: '<script>material</script>', material_type: 'pdf', display_order: order });
const video = (n = 20, order = 1) => ({ content_id: id(n + 100), video_id: id(n), title: 'video', video_status: 'ready' as const, display_order: order });
const activity = (kind: 'homework' | 'quiz', n = 30) => ({ content_id: id(n + 100), kind, source_id: id(n), title: kind, source_status: 'published' as const, audience: 'restricted' as const });
const announcement = () => ({ content_id: id(150), source_id: id(50), title: 'notice', source_state: 'draft' as const, group_id: id(51), group_name: 'group', student_visibility: 'unconfigured' as const });
const pin = (n = 60) => ({ content_id: id(130), exam_version_id: id(n), version_number: 1, status: 'published' as const });

test('compares all five kinds without mutating references or making an access/copy decision', () => {
  const source = { ...empty(), materials: [material()], videos: [video()], activities: [activity('homework', 31), activity('quiz')], announcement: announcement(), quizPin: pin() };
  const before = JSON.stringify(source), result = compareLessonPackages(source, empty());
  assert.deepEqual(result.rows.map(row => row.kind), ['material', 'video', 'homework', 'quiz', 'announcement']);
  assert.ok(result.rows.every(row => row.status === 'review'));
  assert.equal(result.proposedCount, 2);
  assert.equal(JSON.stringify(source), before);
  assert.ok(!('can_copy' in result));
  assert.deepEqual(result.rows[4].issues, ['restricted-audience', 'publication-review', 'draft']);
  assert.ok(result.rows[3].issues.includes('version-review'));
});
test('same source is present with canonical identity and different position is a conflict', () => {
  const source = { ...empty(), materials: [material()] };
  const destination = { ...empty(), materials: [{ ...material(), material_id: id(10).toUpperCase() }] };
  assert.equal(compareLessonPackages(source, destination).rows[0].status, 'present');
  destination.materials[0].display_order = 3;
  assert.ok(compareLessonPackages(source, destination).rows[0].issues.includes('different-position'));
});
test('material/video share positions and capacity; existing references do not consume new slots', () => {
  const source = { ...empty(), materials: [material(10, 0)] }, destination = { ...empty(), videos: [video(20, 0)] };
  assert.ok(compareLessonPackages(source, destination).rows[0].issues.includes('position'));
  destination.videos = Array.from({ length: 20 }, (_, n) => video(200 + n, n + 1));
  assert.ok(compareLessonPackages(source, destination).rows[0].issues.includes('capacity'));
  assert.equal(compareLessonPackages(source, destination).proposedCount, 21);
  const full = { ...empty(), materials: Array.from({ length: 20 }, (_, n) => material(200 + n, n)) };
  assert.equal(compareLessonPackages(full, full).proposedCount, 20);
  assert.ok(compareLessonPackages(full, full).rows.every(row => row.status === 'present'));
});
for (const side of ['source', 'destination']) test(`rejects corrupt mixed ${side} instead of hiding conflicts`, () => {
  const bad = { ...empty(), materials: [material()], videos: [video(20, 0)] };
  assert.throws(() => compareLessonPackages(side === 'source' ? bad : empty(), side === 'destination' ? bad : empty()));
});
test('occupied activity and announcement slots are reported; drafts/restricted audience remain visible', () => {
  const source = { ...empty(), activities: [{ ...activity('homework'), source_status: 'draft' as const }], announcement: announcement() };
  const destination = { ...empty(), activities: [activity('homework', 32)], announcement: { ...announcement(), source_id: id(53) } };
  const result = compareLessonPackages(source, destination);
  assert.ok(result.rows.every(row => row.status === 'conflict' && row.issues.includes('occupied')));
  assert.ok(result.rows[0].issues.includes('draft'));
  assert.ok(result.rows[0].issues.includes('restricted-audience'));
});
test('unavailable source and destination are not described as ready; exam pin differences never reset allowance', () => {
  const source = { ...empty(), videos: [{ ...video(), title: null, video_status: 'unavailable' as const }], activities: [activity('quiz')], quizPin: pin() };
  const destination = { ...empty(), activities: [activity('quiz')], quizPin: pin(61), announcement: { ...announcement(), source_state: 'unavailable' as const } };
  const result = compareLessonPackages(source, destination);
  assert.ok(result.rows[0].issues.includes('unavailable'));
  assert.ok(result.rows[1].issues.includes('different-version'));
  assert.equal(result.destinationNeedsRepair, true);
  source.quizPin = null as any;
  assert.ok(compareLessonPackages(source, empty()).rows[1].issues.includes('unavailable'));
});

const deferred = () => { let resolve!: (value: PackageSnapshot) => void; const promise = new Promise<PackageSnapshot>(r => { resolve = r; }); return { resolve, promise }; };
function controllerFixture() {
  const state = { principal: 'owner-A', event: () => {}, calls: [] as { lesson: string; signal: AbortSignal }[], reader: async (_id: string, _signal: AbortSignal) => empty() };
  const controller = createPackagePreview({ destinationId: id(3), sourceIds: [id(4), id(5)], readPrincipal: () => state.principal,
    subscribeSession: listener => { state.event = listener; return () => {}; }, read: (lesson, signal) => { state.calls.push({ lesson, signal }); return state.reader(lesson, signal); } });
  let latest = initialPackagePreview(); controller.subscribe(value => { latest = value; });
  return { state, controller, latest: () => latest };
}
test('preview is deliberate, bounded to current choices, and reads both lessons', async () => {
  const h = controllerFixture();
  assert.equal(h.state.calls.length, 0);
  for (const candidate of ['invalid', id(3), id(90)]) { await h.controller.preview(candidate); assert.equal(h.state.calls.length, 0); }
  await h.controller.preview(id(4));
  assert.deepEqual(h.state.calls.map(row => row.lesson), [id(4), id(3)]);
  assert.equal(h.latest().phase, 'ready'); h.controller.dispose();
});
test('a failed refresh removes the previous comparison and aborts sibling reads', async () => {
  const h = controllerFixture(); await h.controller.preview(id(4));
  h.state.reader = async () => { throw Error('unavailable'); };
  await h.controller.preview(id(4));
  assert.equal(h.latest().phase, 'error'); assert.equal(h.latest().result, null);
  assert.ok(h.state.calls.at(-1)!.signal.aborted); h.controller.dispose();
});
for (const reason of ['event', 'principal', 'clear', 'dispose']) test(`late result is discarded after ${reason}`, async () => {
  const h = controllerFixture(), pending = deferred(); h.state.reader = () => pending.promise;
  const run = h.controller.preview(id(4));
  if (reason === 'event') h.state.event();
  if (reason === 'principal') h.state.principal = 'owner-B';
  if (reason === 'clear') h.controller.clear();
  if (reason === 'dispose') h.controller.dispose();
  pending.resolve(empty()); await run;
  assert.equal(h.latest().result, null); assert.notEqual(h.latest().phase, 'ready'); h.controller.dispose();
});
test('a newer source choice fences an older successful reply', async () => {
  const h = controllerFixture(), pending = deferred();
  h.state.reader = lesson => lesson === id(4) ? pending.promise : Promise.resolve(empty());
  const old = h.controller.preview(id(4)); await h.controller.preview(id(5));
  pending.resolve({ ...empty(), materials: [material()] }); await old;
  assert.equal(h.latest().sourceId, id(5)); assert.equal(h.latest().result!.rows.length, 0); h.controller.dispose();
});
test('timeout aborts both reads and a late reply cannot restore the preview', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = controllerFixture(), pending = deferred(); h.state.reader = () => pending.promise;
  const run = h.controller.preview(id(4)); context.mock.timers.tick(25000);
  assert.equal(h.latest().phase, 'error'); assert.ok(h.state.calls.every(row => row.signal.aborted));
  pending.resolve(empty()); await run; assert.equal(h.latest().result, null); h.controller.dispose();
});
test('missing or changed principal cannot start private reference reads', async () => {
  const h = controllerFixture(); h.state.principal = '';
  await h.controller.preview(id(4)); assert.equal(h.state.calls.length, 0); assert.equal(h.latest().phase, 'session-ended'); h.controller.dispose();
});

test('real transport uses only bounded private GETs, including the explicit quiz version', async () => {
  const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage };
  const calls: { url: string; init?: RequestInit }[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : null };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const raw = String(url).endsWith('/contents') ? { contents: [material()] } : String(url).endsWith('/videos') ? { videos: [video()] }
      : String(url).endsWith('/activities') ? { activities: [activity('quiz')] } : String(url).endsWith('/version') ? { pin: pin() } : { announcement: announcement() };
    return new Response(JSON.stringify(raw));
  };
  try {
    const result = await lessonPackageReader(id(1), id(2))(id(4), new AbortController().signal);
    assert.equal(result.quizPin!.version_number, 1); assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.ok(call.url.startsWith(`/api/tenants/me/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(4)}/`));
      assert.equal(call.init?.method ?? 'GET', 'GET'); assert.equal(call.init?.body, undefined);
      assert.equal(new Headers(call.init?.headers).get('X-Tenant-Id'), null);
    }
    assert.throws(() => lessonPackageReader('invalid', id(2)));
  } finally { globalThis.fetch = previous.fetch; (globalThis as any).localStorage = previous.storage; }
});
for (const failure of ['schema', 'malformed', 'foreign-pin']) test(`real reader rejects ${failure} without treating missing data as an empty package`, async () => {
  const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage };
  const calls: string[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : null };
  globalThis.fetch = async url => {
    calls.push(String(url)); const route = String(url).split('/').at(-1);
    const raw = route === 'contents' ? { contents: [] } : route === 'videos' ? { videos: failure === 'malformed' ? [{ ...video(), file_url: 'private' }] : [] }
      : route === 'activities' ? { activities: [activity('quiz')] } : route === 'version' ? { pin: { ...pin(), content_id: id(999) } } : { announcement: null };
    return new Response(JSON.stringify(raw), { status: failure === 'schema' && route === 'videos' ? 503 : 200 });
  };
  try {
    await assert.rejects(() => lessonPackageReader(id(1), id(2))(id(4), new AbortController().signal));
    assert.ok(calls.length <= 5); assert.ok(calls.every(url => url.startsWith('/api/tenants/me/catalog/')));
  } finally { globalThis.fetch = previous.fetch; (globalThis as any).localStorage = previous.storage; }
});

function loadPanel(state: any, selected = '') {
  const require = Module.createRequire(import.meta.url), React = require('react'), module = Module as any, original = module._load;
  const file = require.resolve('../features/catalog/LessonPackagePreview.tsx'), effects: Function[] = [], snapshots: any[] = [], ref = { current: null };
  try {
    delete require.cache[file];
    module._load = function(request: string, parent: any, main: boolean) {
      if (request === 'react' && parent?.filename === file) return { ...React, useCallback:(fn:Function)=>fn, useState: (initial: any) => [typeof initial === 'function' ? state : typeof initial==='boolean'?initial:selected, (next: any) => snapshots.push(next)], useRef: () => ref, useEffect: (fn: Function) => effects.push(fn) };
      if (request.startsWith('@/')) return original.call(this, path.join(fileURLToPath(new URL('..', import.meta.url)), request.slice(2)), parent, main);
      return original.call(this, request, parent, main);
    };
    return { component: require(file), effects, snapshots, require, React };
  } finally { module._load = original; delete require.cache[file]; }
}
const props = { courseId: id(1), unitId: id(2), lessonId: id(3), sources: [{ id: id(4), title: 'source' }] };
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(4)) { const found = find(child, predicate); if (found) return found; }
  return null;
}
test('actual editor renders escaped comparisons, warnings and no copy/publish control', () => {
  const previous = (globalThis as any).React;
  try {
    const h = loadPanel({ phase: 'ready', sourceId: id(4), result: compareLessonPackages({ ...empty(), materials: [material()] }, empty()) }, id(4));
    (globalThis as any).React = h.React;
    const tree = h.component.LessonPackagePreviewEditor(props);
    const html = h.require('react-dom/server').renderToStaticMarkup(tree);
    assert.match(html, /&lt;script&gt;material&lt;\/script&gt;/); assert.match(html, /المعاينة لا تنسخ شيئًا/);
    assert.match(html, /قراءات منفصلة/); assert.ok(!html.includes('dangerouslySetInnerHTML'));
    assert.equal(find(tree, node => node.props?.children === 'نسخ الحزمة'), null);
  } finally { (globalThis as any).React = previous; }
});
for (const fail of [false, true]) test(`actual mounted comparison callback ${fail ? 'clears on partial denial' : 'uses canonical reads and clears on session event'}`, async () => {
  const previous = { fetch: globalThis.fetch, storage: globalThis.localStorage, window: globalThis.window, React: (globalThis as any).React };
  let cleanup: Function | undefined; const calls: string[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic' : key === 'currentUser' ? JSON.stringify({ id: 'owner', role: 'instructor' }) : null };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify(String(url).endsWith('/contents') ? { contents: [material()] }
    : String(url).endsWith('/videos') ? { videos: [] } : String(url).endsWith('/activities') ? { activities: [] } : { announcement: null }), { status: fail && String(url).includes(`/lessons/${id(3)}/announcement`) ? 403 : 200 }); };
  try {
    const state = initialPackagePreview(), h = loadPanel(state, id(4)); (globalThis as any).React = h.React;
    let tree = h.component.LessonPackagePreviewEditor(props); cleanup = h.effects[0]();
    assert.equal(calls.length, 0);
    await find(tree, node => node.props?.children === 'مقارنة الحزمة مع هذه الحصة').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    const latest = h.snapshots.filter(x => x && typeof x === 'object').at(-1);
    assert.equal(calls.length, 8); assert.equal(latest.phase, fail ? 'error' : 'ready');
    if (fail) assert.equal(latest.result, null);
    else { assert.equal(latest.result.rows[0].status, 'present'); h.require('../lib/session-events').notifySessionChange('scope'); assert.equal(h.snapshots.at(-1).result, null); }
    Object.assign(state, latest); tree = h.component.LessonPackagePreviewEditor(props);
    find(tree, node => node.type === 'select').props.onChange({ target: { value: '' } });
    assert.equal(h.snapshots.filter(x => x && typeof x === 'object').at(-1).result, null);
  } finally { cleanup?.(); globalThis.fetch = previous.fetch; (globalThis as any).localStorage = previous.storage; (globalThis as any).window = previous.window; (globalThis as any).React = previous.React; }
});
