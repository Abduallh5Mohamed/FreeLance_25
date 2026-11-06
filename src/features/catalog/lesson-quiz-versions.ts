import { ApiRequestError } from '../../lib/api-http';
export interface QuizVersion { exam_version_id: string; version_number: number }
export interface QuizVersionPin { content_id: string; exam_version_id: string; version_number: number | null; status: 'published' | 'unavailable' }
export interface QuizVersionState { phase: 'idle' | 'ready' | 'error' | 'session-ended'; busy: boolean; stale: boolean; pin: QuizVersionPin | null; versions: QuizVersion[]; cursor: string | null; notice: string | null; error: string | null }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const ordinal = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
const exact = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const bad = () => Error('Invalid quiz version response');
export function parseQuizPin(raw: any, contentId: string): QuizVersionPin | null {
  if (!exact(raw, ['pin'])) throw bad(); if (raw.pin === null) return null;
  const pin = raw.pin;
  if (!exact(pin, ['content_id', 'exam_version_id', 'version_number', 'status']) || pin.content_id !== contentId || !uuid(pin.exam_version_id)
    || (pin.status === 'published' ? !ordinal(pin.version_number) : pin.status !== 'unavailable' || pin.version_number !== null)) throw bad();
  return { content_id: contentId, exam_version_id: pin.exam_version_id, version_number: pin.version_number, status: pin.status };
}
export function parseQuizVersions(raw: any, cursor: string | null) {
  if (!exact(raw, ['versions', 'next_cursor']) || !Array.isArray(raw.versions) || raw.versions.length > 25 || raw.next_cursor !== null && (!uuid(raw.next_cursor) || cursor !== null && raw.next_cursor.toLowerCase() <= cursor.toLowerCase())) throw bad();
  const versions: QuizVersion[] = raw.versions.map((row: any) => { if (!exact(row, ['exam_version_id', 'version_number']) || !uuid(row.exam_version_id) || !ordinal(row.version_number)) throw bad(); return { exam_version_id: row.exam_version_id, version_number: row.version_number }; });
  if (versions.some((row, i) => cursor !== null && row.exam_version_id.toLowerCase() <= cursor.toLowerCase() || i > 0 && versions[i - 1].exam_version_id.toLowerCase() >= row.exam_version_id.toLowerCase())
    || raw.next_cursor !== null && (versions.length !== 25 || raw.next_cursor !== versions[24].exam_version_id)) throw bad();
  return { versions, cursor: raw.next_cursor as string | null };
}
export const initialQuizVersionState = (): QuizVersionState => ({ phase: 'idle', busy: false, stale: true, pin: null, versions: [], cursor: null, notice: null, error: null });
export function createQuizVersionEditor(contentId: string, deps: {
  read(signal: AbortSignal): Promise<unknown>; versions(cursor: string | null, signal: AbortSignal): Promise<unknown>;
  pin(versionId: string, signal: AbortSignal): Promise<unknown>; unpin(versionId: string, signal: AbortSignal): Promise<unknown>;
  readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
}) {
  let state = initialQuizVersionState(), epoch = 0, disposed = false, abort: AbortController | null = null, notice: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const principal = deps.readPrincipal(), listeners = new Set<(state: QuizVersionState) => void>();
  const set = (patch: Partial<QuizVersionState>) => { state = { ...state, ...patch }; if (!disposed) listeners.forEach(fn => fn(state)); };
  const invalidate = () => { if (disposed) return; epoch++; abort?.abort(); clearTimeout(timer); set({ ...initialQuizVersionState(), phase: 'session-ended', error: 'تغيّرت الجلسة. افتح محرر النسخة من جديد.' }); };
  const current = (ticket: number) => { if (disposed || ticket !== epoch) return false; if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true; };
  const unsubscribe = deps.subscribeSession(invalidate);
  const claim = () => { if (disposed || state.busy || state.phase === 'session-ended' || !current(epoch)) return null; abort = new AbortController(); const operation = abort; timer = setTimeout(() => operation.abort(), 20000); set({ busy: true, error: null }); return ++epoch; };
  const validReply = (ticket: number) => { if (!current(ticket)) return false; if (abort!.signal.aborted) throw bad(); return true; };
  const finish = (ticket: number) => { if (current(ticket)) { clearTimeout(timer); set({ busy: false }); } };
  const read = async (ticket: number) => {
    try {
      const pin = parseQuizPin(await deps.read(abort!.signal), contentId); if (!validReply(ticket)) return false;
      const page = pin ? { versions: [], cursor: null } : parseQuizVersions(await deps.versions(null, abort!.signal), null); if (!validReply(ticket)) return false;
      set({ phase: 'ready', stale: false, pin, versions: page.versions, cursor: page.cursor, notice }); return true;
    } catch { if (current(ticket)) set({ phase: 'error', stale: true, pin: null, versions: [], cursor: null, error: 'تعذّر تحديث النسخة. حدّث البيانات قبل أي تعديل.' }); return false; }
  };
  const mutate = async (operation: 'pin' | 'unpin', id: string) => {
    if (state.phase !== 'ready' || state.stale || operation === 'pin' && (state.pin || !state.versions.some(row => row.exam_version_id === id)) || operation === 'unpin' && state.pin?.exam_version_id !== id) return false;
    const ticket = claim(); if (ticket === null) return false; let confirmed = false; notice = null; set({ notice: null });
    try {
      const raw: any = await (operation === 'pin' ? deps.pin(id, abort!.signal) : deps.unpin(id, abort!.signal)); if (!validReply(ticket)) return false;
      if (operation === 'pin') {
        if (!exact(raw, ['pin', 'unchanged']) || typeof raw.unchanged !== 'boolean') throw bad();
        const pin = parseQuizPin({ pin: raw.pin }, contentId); if (!pin || pin.status !== 'published' || pin.exam_version_id.toLowerCase() !== id.toLowerCase()) throw bad();
      } else if (!exact(raw, ['detached', 'content_id']) || typeof raw.detached !== 'boolean' || raw.content_id !== contentId) throw bad();
      confirmed = true; notice = operation === 'pin' ? 'تم تأكيد تثبيت النسخة المختارة. لا يبدأ هذا أي محاولة.' : 'تم تأكيد فك تثبيت النسخة. النسخة ومحاولاتها محفوظة.'; set({ notice });
      await read(ticket); if (current(ticket) && state.stale) set({ notice: 'الحفظ مؤكد، لكن القائمة لم تتحدث. حدّث البيانات ولا تُعد الحفظ.' }); return true;
    } catch (error) { if (current(ticket)) {
      const known = error instanceof ApiRequestError && error.code !== 'PERSISTENCE_UNCERTAIN' && error.status >= 400 && error.status < 500;
      set({ phase: 'error', stale: true, pin: null, versions: [], cursor: null, error: known ? 'تغيّر الربط أو لم تعد النسخة مسموحة. حدّث البيانات قبل أي تعديل.' : 'نتيجة الحفظ غير مؤكدة. حدّث البيانات للتحقق قبل أي محاولة أخرى؛ لم تتم إعادة الإرسال تلقائيًا.' });
    } return confirmed; }
    finally { finish(ticket); }
  };
  return {
    getState: () => state,
    subscribe(fn: (state: QuizVersionState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async refresh() { const ticket = claim(); if (ticket === null) return; try { await read(ticket); } finally { finish(ticket); } },
    async more() { if (state.stale || state.pin || !state.cursor) return; const cursor = state.cursor, ticket = claim(); if (ticket === null) return; try { const page = parseQuizVersions(await deps.versions(cursor, abort!.signal), cursor); if (validReply(ticket)) set({ versions: page.versions, cursor: page.cursor }); } catch { if (current(ticket)) set({ error: 'تعذّر تحميل صفحة النسخ التالية. يمكنك إعادة المحاولة.' }); } finally { finish(ticket); } },
    pin: (id: string) => mutate('pin', id), unpin: (id: string) => mutate('unpin', id), invalidate,
    dispose() { disposed = true; epoch++; abort?.abort(); clearTimeout(timer); unsubscribe(); listeners.clear(); },
  };
}
