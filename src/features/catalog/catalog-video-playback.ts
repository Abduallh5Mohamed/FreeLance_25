import { authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';

export interface CatalogVideoSelection { course_id: string; lesson_id: string; content_id: string }
export interface CatalogPlaybackSession { sessionId: string; sessionToken: string; streamUrl: string; videoId: string; watermarkText?: string }
export interface CatalogPlaybackState {
  phase: 'loading' | 'consent' | 'active' | 'error' | 'session-ended';
  message: string | null;
}
type Reply = { status: number; body: any };
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function catalogSessionBody(selection: CatalogVideoSelection, fingerprint: string, screenRes: string) {
  if (!selection || Object.keys(selection).sort().join(',') !== 'content_id,course_id,lesson_id'
    || !Object.values(selection).every(value => typeof value === 'string' && uuid.test(value))
    || !fingerprint.trim() || fingerprint.length > 256 || !screenRes.trim() || screenRes.length > 64) throw Error('Invalid catalog session');
  return { catalog: { course_id: selection.course_id, lesson_id: selection.lesson_id, content_id: selection.content_id }, fingerprint, screenRes };
}
export function parseCatalogPlaybackSession(data: any, origin: string): CatalogPlaybackSession {
  if (!data || typeof data.sessionId !== 'string' || !uuid.test(data.sessionId) || typeof data.sessionToken !== 'string' || !data.sessionToken || data.sessionToken.length > 8192
    || typeof data.streamUrl !== 'string' || !data.streamUrl.startsWith('/api/secure-video/manifest/')) throw Error('Invalid playback response');
  const url = new URL(data.streamUrl, origin);
  const match = /^\/api\/secure-video\/manifest\/([a-f\d-]{36})\/playlist\.m3u8$/i.exec(url.pathname);
  if (url.origin !== origin || url.hash || url.username || url.password || !match || !uuid.test(match[1])
    || [...url.searchParams.keys()].sort().join(',') !== 'sid,token' || url.searchParams.get('sid') !== data.sessionId
    || url.searchParams.get('token') !== data.sessionToken) throw Error('Invalid playback response');
  const watermark = data.watermark;
  const watermarkText = watermark && ['studentName', 'groupName', 'forensicCode'].every(key => typeof watermark[key] === 'string' && watermark[key].length <= 255)
    && /^[a-f\d]{8}-[a-f\d]{8}$/i.test(watermark.forensicCode)
    ? `${watermark.studentName} • ${watermark.groupName} • ${watermark.forensicCode}` : undefined;
  return { sessionId: data.sessionId, sessionToken: data.sessionToken, streamUrl: url.href, videoId: match[1], ...(watermarkText ? { watermarkText } : {}) };
}
/** Canonical authenticated POST; never forwards a bearer to a returned media URL. */
export async function catalogPlaybackRequest(path: string, body: unknown, signal: AbortSignal): Promise<Reply> {
  if (!['/secure-video/session', '/secure-video/consent', '/secure-video/heartbeat', '/secure-video/refresh-token'].includes(path)) throw Error('Invalid playback endpoint');
  const operation = new AbortController(), abort = () => operation.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) operation.abort();
  const timer = setTimeout(abort, 20000);
  try {
    const response = await authenticatedApiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: operation.signal });
    const data = await readAuthenticatedApiJson(response);
    if (operation.signal.aborted) throw Error('Playback request ended');
    return { status: response.status, body: data };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
/** Owns one selected reference, one login incarnation and all its async work. */
export function createCatalogPlayback(selection: CatalogVideoSelection, deps: {
  fingerprint: string; screenRes: string; origin: string;
  request(path: string, body: unknown, signal: AbortSignal): Promise<Reply>;
  readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
  every(fn: () => void, ms: number): () => void;
  source(session: CatalogPlaybackSession, current: () => boolean): void;
  stop(): void; state(state: CatalogPlaybackState): void;
}) {
  const body = catalogSessionBody(selection, deps.fingerprint, deps.screenRes);
  const principal = deps.readPrincipal(), lifetime = new AbortController();
  let disposed = false, ended = false, busy = false, heartbeatBusy = false, refreshBusy = false;
  let session: CatalogPlaybackSession | null = null, terms: string | null = null;
  let cancelTimers: (() => void)[] = [];
  const publish = (phase: CatalogPlaybackState['phase'], message: string | null = null) => { if (!disposed) deps.state({ phase, message }); };
  const stop = () => { session = null; cancelTimers.forEach(cancel => cancel()); cancelTimers = []; deps.stop(); };
  const invalidate = () => { if (disposed || ended) return; ended = true; lifetime.abort(); stop(); publish('session-ended', 'تغيّرت الجلسة. أغلق الفيديو وافتحه من مساحة الطالب الحالية.'); };
  const current = () => { if (disposed || ended) return false; if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true; };
  const unsubscribe = deps.subscribeSession(invalidate);
  const fail = (message: string) => { if (!current()) return; ended = true; lifetime.abort(); stop(); publish('error', message); };
  const denied = (reply: Reply) => reply.status >= 400 && reply.status < 500
    ? 'لم يعد تشغيل هذا الفيديو مسموحًا. أغلقه وحدّث مسار التعلّم.'
    : 'تشغيل الفيديو غير متاح حاليًا. أغلقه وأعد المحاولة لاحقًا.';
  const heartbeat = async () => {
    if (!current() || !session || heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const reply = await deps.request('/secure-video/heartbeat', { sessionId: session.sessionId, sessionToken: session.sessionToken }, lifetime.signal);
      if (current() && reply.status !== 200) fail(denied(reply));
    } catch { fail('تعذّر التحقق من جلسة الفيديو. توقفت المشاهدة؛ يمكنك فتح الفيديو من جديد.'); }
    finally { heartbeatBusy = false; }
  };
  const refresh = async () => {
    if (!current() || !session || refreshBusy) return;
    refreshBusy = true;
    try {
      const reply = await deps.request('/secure-video/refresh-token', { sessionId: session.sessionId, fingerprint: deps.fingerprint, screenRes: deps.screenRes }, lifetime.signal);
      if (!current()) return;
      if (reply.status !== 200) { fail(denied(reply)); return; }
      const next = parseCatalogPlaybackSession({ ...reply.body, sessionId: session.sessionId }, deps.origin);
      if (next.sessionId !== session.sessionId || next.videoId !== session.videoId) throw Error('Changed playback binding');
      session = next; deps.source(next, current);
    } catch { fail('تعذّر تجديد جلسة الفيديو. توقفت المشاهدة؛ افتحه من جديد.'); }
    finally { refreshBusy = false; }
  };
  const start = async () => {
    if (busy || session || !current()) return;
    busy = true; publish('loading');
    try {
      const reply = await deps.request('/secure-video/session', body, lifetime.signal);
      if (!current()) return;
      if (reply.status === 428 && reply.body?.code === 'VIDEO_CONSENT_REQUIRED' && typeof reply.body.termsVersion === 'string' && reply.body.termsVersion.length > 0 && reply.body.termsVersion.length <= 100) {
        terms = reply.body.termsVersion; publish('consent'); return;
      }
      if (reply.status !== 200) { fail(denied(reply)); return; }
      session = parseCatalogPlaybackSession(reply.body, deps.origin);
      if (!session.watermarkText) throw Error('Missing playback watermark');
      publish('active'); deps.source(session, current);
      if (current()) cancelTimers = [deps.every(() => { void heartbeat(); }, 5000), deps.every(() => { void refresh(); }, 40000)];
    } catch { fail('تعذّر بدء الفيديو الآمن. أغلقه وأعد المحاولة؛ لم يُسجّل إتمام الدرس.'); }
    finally { busy = false; }
  };
  return {
    start, invalidate,
    async accept() {
      if (busy || !terms || !current()) return;
      busy = true; publish('loading');
      try {
        const version = terms, reply = await deps.request('/secure-video/consent', { accepted: true, termsVersion: version }, lifetime.signal);
        if (!current()) return;
        if (reply.status !== 200 || reply.body?.accepted !== true || reply.body?.termsVersion !== version) {
          publish('consent', 'تعذّر تأكيد حفظ الموافقة. يمكنك المحاولة مجددًا.'); return;
        }
        terms = null;
      } catch { if (current()) { publish('consent', 'تعذّر تأكيد حفظ الموافقة. يمكنك المحاولة مجددًا.'); return; } }
      finally { busy = false; }
      if (current() && !terms) await start();
    },
    mediaFailed() { fail('تعذّر تحميل الفيديو أو سُحب الوصول إليه. أغلقه وحدّث مسار التعلّم.'); },
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); stop(); unsubscribe(); },
  };
}
