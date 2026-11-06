import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogSessionBody, parseCatalogPlaybackSession, createCatalogPlayback, catalogPlaybackRequest, type CatalogPlaybackState } from '../features/catalog/catalog-video-playback';
import { createStudentVideos, parseStudentVideos } from '../features/catalog/student-lesson-videos';
import { listStudentLessonVideos } from '../lib/api-http';
const id = (n: number) => `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection = { course_id: id(1), lesson_id: id(2), content_id: id(3) };
const response = (token = 'synthetic-video-token', videoId = id(5)) => ({ sessionId: id(4), sessionToken: token, streamUrl: `/api/secure-video/manifest/${videoId}/playlist.m3u8?sid=${id(4)}&token=${token}`, watermark: { studentName: 'طالب تجريبي', groupName: 'مجموعة تجريبية', forensicCode: 'e1000000-abcdef12' } });
const deferred = () => { let resolve!: (x: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const state = { principal: 'A' as string | null, snapshots: [] as CatalogPlaybackState[], sources: [] as any[], stops: 0, calls: [] as any[], timers: new Map<number, () => void>(), signal: null as AbortSignal | null };
  const deps = {
    fingerprint: 'synthetic-fp', screenRes: '800x600', origin: 'https://example.test', readPrincipal: () => state.principal,
    request: async (path: string, body: any, signal: AbortSignal) => { state.calls.push({ path, body }); state.signal = signal; return { status: 200, body: path === '/secure-video/heartbeat' ? {} : response() }; },
    subscribeSession: (fn: () => void) => { event = fn; return () => { event = () => {}; }; },
    every: (fn: () => void, ms: number) => { state.timers.set(ms, fn); return () => { state.timers.delete(ms); }; },
    source: (session: any, current: () => boolean) => { assert.equal(current(), true); state.sources.push(session); },
    stop: () => { state.stops++; }, state: (snapshot: CatalogPlaybackState) => state.snapshots.push(snapshot),
  };
  let event = () => {};
  const controller = createCatalogPlayback(selection, deps);
  return { state, deps, controller, event: () => event(), phase: () => state.snapshots.at(-1)?.phase };
}
test('catalog body is exact: selectors never include a source, tenant, offer or caller authority', () => {
  assert.deepEqual(catalogSessionBody(selection, 'fp', '800x600'), { catalog: selection, fingerprint: 'fp', screenRes: '800x600' });
  for (const extra of ['videoId', 'tenant_id', 'offerId', 'sourceFingerprint']) assert.throws(() => catalogSessionBody({ ...selection, [extra]: id(9) }, 'fp', '800x600'));
  assert.throws(() => catalogSessionBody({ ...selection, content_id: 'bad' }, 'fp', '800x600'));
});
test('playback response accepts only exact local manifest, matching session/token, never preview or an external source', () => {
  assert.equal(parseCatalogPlaybackSession(response(), 'https://example.test').videoId, id(5));
  for (const streamUrl of ['https://other.test/a.m3u8', '//other.test/a.m3u8', response().streamUrl.replace('/playlist', '/preview/playlist'), response().streamUrl + '&tenant=bad', response().streamUrl + '&sid=bad', response().streamUrl + '#x', response().streamUrl.replace(id(4), id(8)), response().streamUrl.replace('synthetic-video-token', 'wrong')]) {
    assert.throws(() => parseCatalogPlaybackSession({ ...response(), streamUrl }, 'https://example.test'));
  }
});
test('one explicit issue starts heartbeat/refresh; duplicates do not issue sessions; rotation preserves binding', async () => {
  const h = fixture(), wait = deferred(); h.deps.request = async (path, body, signal) => { h.state.calls.push({ path, body }); return wait.promise; };
  const starting = h.controller.start(); await h.controller.start(); assert.equal(h.state.calls.length, 1);
  wait.resolve({ status: 200, body: response() }); await starting;
  assert.equal(h.phase(), 'active'); assert.equal(h.state.timers.size, 2); assert.equal(h.state.sources.length, 1);
  h.deps.request = async (path, body) => { h.state.calls.push({ path, body }); return { status: 200, body: path.endsWith('heartbeat') ? {} : response('rotated') }; };
  h.state.timers.get(40000)!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.sources[1].sessionToken, 'rotated');
  h.state.timers.get(5000)!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.calls.at(-1).body.sessionToken, 'rotated'); h.controller.dispose(); assert.equal(h.state.timers.size, 0);
});
test('consent is explicit, single flight and confirmed before one new catalog request', async () => {
  const h = fixture(); let accepted = false;
  h.deps.request = async (path, body) => {
    h.state.calls.push({ path, body });
    if (path.endsWith('/consent')) { accepted = true; return { status: 200, body: { accepted: true, termsVersion: 'v1' } as any }; }
    return accepted ? { status: 200, body: response() } : { status: 428, body: { code: 'VIDEO_CONSENT_REQUIRED', termsVersion: 'v1' } as any };
  };
  await h.controller.start(); assert.equal(h.phase(), 'consent'); assert.equal(h.state.sources.length, 0);
  await Promise.all([h.controller.accept(), h.controller.accept()]); assert.equal(h.phase(), 'active');
  assert.deepEqual(h.state.calls.map(call => call.path), ['/secure-video/session', '/secure-video/consent', '/secure-video/session']);
  assert.deepEqual(h.state.calls[1].body, { accepted: true, termsVersion: 'v1' }); h.controller.dispose();
});
test('unknown consent acknowledgement stays at consent and does not issue or auto-retry', async () => {
  const h = fixture(); h.deps.request = async path => ({ status: path.endsWith('/session') ? 428 : 200, body: path.endsWith('/session') ? { code: 'VIDEO_CONSENT_REQUIRED', termsVersion: 'v1' } as any : { accepted: false } as any });
  await h.controller.start(); await h.controller.accept(); assert.equal(h.phase(), 'consent'); assert.equal(h.state.sources.length, 0); h.controller.dispose();
});
for (const status of [403, 404, 503]) test(`issue ${status} stops without a generic fallback or logout`, async () => {
  const h = fixture(); h.deps.request = async (path, body) => { h.state.calls.push({ path, body }); return { status, body: {} as any }; };
  await h.controller.start(); assert.equal(h.phase(), 'error'); assert.equal(h.state.sources.length, 0); assert.equal(h.state.calls.length, 1); assert.equal(h.state.timers.size, 0); h.controller.dispose();
});
for (const trigger of ['event', 'principal', 'dispose']) test(`late issuance after ${trigger} cannot attach a source or schedule work`, async () => {
  const h = fixture(), wait = deferred(); h.deps.request = async (_path, _body, signal) => { h.state.signal = signal; return wait.promise; };
  const starting = h.controller.start();
  if (trigger === 'event') h.event(); else if (trigger === 'principal') h.state.principal = 'B'; else h.controller.dispose();
  wait.resolve({ status: 200, body: response() }); await starting;
  assert.equal(h.state.sources.length, 0); assert.equal(h.state.timers.size, 0); assert.equal(h.state.signal!.aborted, true); h.controller.dispose();
});
test('late refresh after session change cannot replace media; heartbeat denial releases media/timers', async () => {
  const h = fixture(); await h.controller.start(); const wait = deferred();
  h.deps.request = async () => wait.promise; h.state.timers.get(40000)!(); h.event();
  wait.resolve({ status: 200, body: response('new') }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.sources.length, 1); assert.equal(h.phase(), 'session-ended'); assert.equal(h.state.timers.size, 0); h.controller.dispose();
  const other = fixture(); await other.controller.start(); other.deps.request = async () => ({ status: 403, body: {} as any });
  other.state.timers.get(5000)!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(other.phase(), 'error'); assert.equal(other.state.timers.size, 0); assert.equal(other.state.stops, 1); other.controller.dispose();
});
test('refresh cannot switch video and a media failure terminates the controller without further requests', async () => {
  const h = fixture(); await h.controller.start(); h.deps.request = async () => ({ status: 200, body: response('new', id(9)) });
  h.state.timers.get(40000)!(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.phase(), 'error'); assert.equal(h.state.sources.length, 1); h.controller.dispose();
  const other = fixture(); await other.controller.start(); other.controller.mediaFailed(); assert.equal(other.phase(), 'error'); assert.equal(other.state.timers.size, 0); other.controller.dispose();
});
const video = () => ({ content_id: id(3), title: 'فيديو التجربة', display_order: 0, playback_status: 'session_required' });
test('metadata parser refuses private locators, invalid readiness, duplicates, wrong lesson and overflow', () => {
  const payload = (rows = [video()]) => ({ lesson_id: id(2), videos: rows });
  assert.equal(parseStudentVideos(payload(), id(2)).length, 1);
  for (const value of [payload([{ ...video(), url: 'private' } as any]), payload([{ ...video(), playback_status: 'ready' }]), payload([video(), video()]), payload(Array.from({ length: 21 }, video))]) assert.throws(() => parseStudentVideos(value, id(2)));
  assert.throws(() => parseStudentVideos(payload(), id(8)));
});
test('metadata is explicit, selection requires a confirmed row and session change removes the selected player', async () => {
  let event = () => {}, calls = 0;
  const c = createStudentVideos(id(2), { list: async () => { calls++; return { lesson_id: id(2), videos: [video()] }; }, readPrincipal: () => 'A', subscribeSession: fn => { event = fn; return () => {}; } });
  assert.equal(calls, 0); c.select(id(3)); assert.equal(c.getState().selected, null);
  await c.load(); c.select(id(9)); assert.equal(c.getState().selected, null); c.select(id(3)); assert.equal(c.getState().selected!.content_id, id(3)); event(); assert.equal(c.getState().selected, null); assert.equal(c.getState().rows.length, 0); c.dispose();
});
test('real canonical transports send the catalog tuple only and protect responses after body consumption', async () => {
  const previousFetch = globalThis.fetch, previousStorage = globalThis.localStorage; let token = 'synthetic-login'; const calls: any[] = [];
  (globalThis as any).localStorage = { getItem: (key: string) => key === 'authToken' ? token : null };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(String(url).endsWith('/session') ? response() : { lesson_id: id(2), videos: [video()] })); };
  try {
    await listStudentLessonVideos(id(1), id(2));
    await catalogPlaybackRequest('/secure-video/session', catalogSessionBody(selection, 'fp', '800x600'), new AbortController().signal);
    assert.equal(calls[0].url, `/api/student-course-access/courses/${id(1)}/lessons/${id(2)}/videos`);
    assert.deepEqual(JSON.parse(calls[1].init.body), { catalog: selection, fingerprint: 'fp', screenRes: '800x600' });
    assert.equal(new Headers(calls[1].init.headers).get('Authorization'), 'Bearer synthetic-login'); assert.equal(calls[1].init.cache, 'no-store');
    globalThis.fetch = async () => ({ status: 200, json: async () => { token = 'new-login'; return response(); } }) as Response;
    await assert.rejects(catalogPlaybackRequest('/secure-video/session', {}, new AbortController().signal));
  } finally { globalThis.fetch = previousFetch; (globalThis as any).localStorage = previousStorage; }
});
