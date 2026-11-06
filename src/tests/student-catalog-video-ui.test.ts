import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialStudentVideos } from '../features/catalog/student-lesson-videos';
const require = Module.createRequire(import.meta.url), React = require('react');
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const id = (n: number) => `e2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection = { course_id: id(1), lesson_id: id(2), content_id: id(3) };
const row = { content_id: id(3), title: 'فيديو تجريبي', display_order: 0, playback_status: 'session_required' };
function loadWithHooks(relative: string, state?: any) {
  const file = require.resolve(relative), module = Module as any, original = module._load;
  const effects: any[] = [], snapshots: any[] = [], children: any[] = [];
  const previousReact = (globalThis as any).React;
  (globalThis as any).React = React;
  let stateIndex = 0;
  class Hls {
    static Events = { MANIFEST_PARSED: 'ready', ERROR: 'error' };
    static isSupported() { return true; }
    static instances: Hls[] = [];
    handlers = new Map<string, Function>(); source = ''; destroyed = false;
    constructor() { Hls.instances.push(this); }
    on(name: string, fn: Function) { this.handlers.set(name, fn); }
    loadSource(url: string) { this.source = url; }
    attachMedia() {}
    destroy() { this.destroyed = true; }
  }
  try {
    delete require.cache[file];
    module._load = function(name: string, parent: any, main: boolean) {
      if (name === 'react' && parent?.filename === file) return { ...React,
        useState: (initial: any) => { const i = stateIndex++, value = typeof initial === 'function' ? initial() : initial; return [typeof state === 'function' ? state(i, value) : state ?? value, (next: any) => { snapshots[i] = next; }]; },
        useRef: (initial: any) => ({ current: initial }), useEffect: (fn: any) => effects.push(fn), useCallback: (fn: any) => fn };
      if (name === 'react-router-dom') return { useNavigate: () => () => {} };
      if (name === 'hls.js') return { __esModule: true, default: Hls };
      if (name === '@/components/SecureVideoPlayer' && parent?.filename === file) return { SecureVideoPlayer: (props: any) => { children.push(props); return React.createElement('div', { 'data-player': 'catalog' }); } };
      if (name.startsWith('@/')) return original.call(this, path.join(sourceRoot, name.slice(2)), parent, main);
      return original.call(this, name, parent, main);
    };
    return { component: require(file), effects, snapshots, children, Hls };
  } finally { module._load = original; (globalThis as any).React = previousReact; delete require.cache[file]; }
}
function browserFixture() {
  const keys = ['window', 'navigator', 'localStorage', 'React'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const events = new Set<Function>(), timers = new Map<number, Function>();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Synthetic desktop' } });
  (globalThis as any).window = {
    crypto: { randomUUID: () => id(9) }, screen: { width: 800, height: 600 }, location: { origin: 'https://example.test' },
    addEventListener: (_name: string, fn: Function) => events.add(fn), removeEventListener: (_name: string, fn: Function) => events.delete(fn),
    setInterval: (fn: Function, ms: number) => { timers.set(ms, fn); return ms; }, clearInterval: (ms: number) => timers.delete(ms),
  };
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? 'synthetic-login' : key === 'currentUser' ? JSON.stringify({ id: 'synthetic-student', role: 'student' }) : null };
  (globalThis as any).React = React;
  return { events, timers, restore: () => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; } } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function findVideo(tree: any): any {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === 'video') return tree;
  for (const child of [tree.props?.children].flat(2)) { const found = findVideo(child); if (found) return found; }
  return null;
}
function findButton(tree: any, text: string): any {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === 'button' && tree.props?.children === text) return tree;
  for (const child of [tree.props?.children].flat(2)) { const found = findButton(child, text); if (found) return found; }
  return null;
}
test('real panel is collapsed initially and selected rows pass only the catalog tuple to the player', () => {
  const browser = browserFixture();
  try {
    const closed = loadWithHooks('../features/catalog/StudentLessonVideos.tsx', false);
    const html = require('react-dom/server').renderToStaticMarkup(closed.component.StudentLessonVideos({ courseId: id(1), lessonId: id(2) }));
    assert.match(html, /عرض فيديوهات الدرس/); assert.equal(closed.effects.length, 0);
    const ready = loadWithHooks('../features/catalog/StudentLessonVideos.tsx', { ...initialStudentVideos(), phase: 'ready', rows: [row], selected: row });
    const rendered = require('react-dom/server').renderToStaticMarkup(ready.component.StudentLessonVideoList({ courseId: id(1), lessonId: id(2) }));
    assert.match(rendered, /فتح الفيديو/); assert.match(rendered, /لا تسجّل إتمام الدرس/);
    assert.deepEqual(ready.children[0].catalog, selection); assert.equal(ready.children[0].videoId, undefined); assert.equal(ready.children[0].directUrl, undefined);
    const unavailable = loadWithHooks('../features/catalog/StudentLessonVideos.tsx', { ...initialStudentVideos(), phase: 'ready', rows: [{ ...row, playback_status: 'unconfigured' }] });
    const unavailableHtml = require('react-dom/server').renderToStaticMarkup(unavailable.component.StudentLessonVideoList({ courseId: id(1), lessonId: id(2) }));
    assert.match(unavailableHtml, /تشغيل الفيديو غير متاح/); assert.ok(!/>فتح الفيديو<\/button>/.test(unavailableHtml));
  } finally { browser.restore(); }
});
test('actual student panel effect reads the canonical endpoint and scope change removes all references', async () => {
  const browser = browserFixture(), previousFetch = globalThis.fetch; let cleanup: Function | undefined;
  const calls: string[] = [];
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify({ lesson_id: id(2), videos: [row] })); };
  try {
    const view = loadWithHooks('../features/catalog/StudentLessonVideos.tsx');
    view.component.StudentLessonVideoList({ courseId: id(1), lessonId: id(2) });
    assert.equal(calls.length, 0); cleanup = view.effects[0](); await tick();
    assert.equal(view.snapshots[0].phase, 'ready'); assert.deepEqual(calls, [`/api/student-course-access/courses/${id(1)}/lessons/${id(2)}/videos`]);
    require('../lib/session-events').notifySessionChange('scope'); assert.equal(view.snapshots[0].phase, 'session-ended'); assert.equal(view.snapshots[0].rows.length, 0);
    cleanup(); cleanup = undefined; assert.equal(browser.events.size, 0);
  } finally { cleanup?.(); globalThis.fetch = previousFetch; browser.restore(); }
});
for (const late of [false, true]) test(`actual SecureVideoPlayer catalog effect ${late ? 'discards a retired response' : 'attaches private HLS and tears it down on scope change'}`, async () => {
  const browser = browserFixture(), previousFetch = globalThis.fetch; let cleanup: Function | undefined, release: Function = () => {};
  const calls: any[] = [], wait = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init }); if (late) await wait;
    return new Response(JSON.stringify({ sessionId: id(4), sessionToken: 'synthetic-video', streamUrl: `/api/secure-video/manifest/${id(5)}/playlist.m3u8?sid=${id(4)}&token=synthetic-video`, watermark: { studentName: 'طالب تجريبي', groupName: 'مجموعة تجريبية', forensicCode: 'e2000000-abcdef12' } }));
  };
  const video = { currentTime: 0, paused: true, src: '', pauses: 0, loads: 0, pause() { this.pauses++; }, removeAttribute() { this.src = ''; }, load() { this.loads++; } };
  try {
    const view = loadWithHooks('../components/SecureVideoPlayer.tsx');
    const tree = view.component.SecureVideoPlayer({ catalog: selection, userId: '', studentName: '', groupName: '', onClose() {} });
    findVideo(tree).ref.current = video;
    const effect = view.effects.find(fn => fn.toString().includes('createCatalogPlayback'));
    assert.ok(effect); cleanup = effect();
    if (late) { cleanup(); cleanup = undefined; release(); }
    await tick(); await tick();
    assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].init.body).catalog, selection); assert.equal(JSON.parse(calls[0].init.body).videoId, undefined);
    if (late) { assert.equal(view.Hls.instances.length, 0); assert.equal(browser.timers.size, 0); }
    else {
      assert.equal(view.Hls.instances.length, 1); const hls = view.Hls.instances[0];
      assert.match(hls.source, /^https:\/\/example.test\/api\/secure-video\/manifest\//);
      hls.handlers.get('ready')!(); assert.equal(view.snapshots[2], false); assert.equal(browser.timers.size, 2);
      require('../lib/session-events').notifySessionChange('scope'); assert.equal(hls.destroyed, true); assert.equal(browser.timers.size, 0); assert.ok(video.pauses > 0);
    }
  } finally { release(); cleanup?.(); globalThis.fetch = previousFetch; browser.restore(); }
});
test('actual player consent button confirms consent and then issues the catalog session, never a legacy request', async () => {
  const browser = browserFixture(), previousFetch = globalThis.fetch; let cleanup: Function | undefined;
  let consented = false; const calls: any[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith('/consent')) { consented = true; return new Response(JSON.stringify({ accepted: true, termsVersion: 'v1' })); }
    if (!consented) return new Response(JSON.stringify({ code: 'VIDEO_CONSENT_REQUIRED', termsVersion: 'v1' }), { status: 428 });
    return new Response(JSON.stringify({ sessionId: id(4), sessionToken: 'synthetic-video', streamUrl: `/api/secure-video/manifest/${id(5)}/playlist.m3u8?sid=${id(4)}&token=synthetic-video`, watermark: { studentName: '', groupName: '', forensicCode: 'e2000000-abcdef12' } }));
  };
  try {
    const view = loadWithHooks('../components/SecureVideoPlayer.tsx', (index: number, initial: any) => index === 21 ? true : initial);
    const tree = view.component.SecureVideoPlayer({ catalog: selection, userId: '', studentName: '', groupName: '', onClose() {} });
    findVideo(tree).ref.current = { currentTime: 0, paused: true, pause() {}, removeAttribute() {}, load() {} };
    cleanup = view.effects.find(fn => fn.toString().includes('createCatalogPlayback'))(); await tick();
    assert.equal(view.Hls.instances.length, 0); assert.equal(calls.length, 1);
    await findButton(tree, 'أوافق وأتابع').props.onClick();
    assert.deepEqual(calls.map(call => call.url), ['/api/secure-video/session', '/api/secure-video/consent', '/api/secure-video/session']);
    assert.deepEqual(calls[1].body, { accepted: true, termsVersion: 'v1' }); assert.deepEqual(calls[2].body.catalog, selection); assert.equal(calls[2].body.videoId, undefined);
    assert.equal(view.Hls.instances.length, 1);
  } finally { cleanup?.(); globalThis.fetch = previousFetch; browser.restore(); }
});
