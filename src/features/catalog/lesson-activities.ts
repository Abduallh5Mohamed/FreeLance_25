import { ApiRequestError } from '../../lib/api-http';
export type ActivityKind = 'homework' | 'quiz';
export interface ActivitySource { source_id: string; title: string; source_status: 'draft' | 'published'; audience: 'course' | 'restricted' }
export interface LessonActivity { content_id: string; kind: ActivityKind; source_id: string; title: string | null; source_status: 'draft' | 'published' | 'unavailable'; audience: 'course' | 'restricted' | null }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const exact = (row: any, keys: string[]) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).sort().join(',') === [...keys].sort().join(',');
const malformed = () => Error('Invalid lesson activity response');
export function parseActivity(row: any): LessonActivity {
  if (!exact(row, ['content_id', 'kind', 'source_id', 'title', 'source_status', 'audience']) || !validId(row.content_id) || !validId(row.source_id) || !['homework', 'quiz'].includes(row.kind)) throw malformed();
  if (row.source_status === 'unavailable' ? row.title !== null || row.audience !== null
    : !['draft', 'published'].includes(row.source_status) || typeof row.title !== 'string' || row.title.length > 255 || !['course', 'restricted'].includes(row.audience)) throw malformed();
  return { content_id: row.content_id, kind: row.kind, source_id: row.source_id, title: row.title, source_status: row.source_status, audience: row.audience };
}
export function parseActivityList(raw: any): LessonActivity[] {
  if (!exact(raw, ['activities']) || !Array.isArray(raw.activities) || raw.activities.length > 2) throw malformed();
  const rows = raw.activities.map(parseActivity);
  if (new Set(rows.map(row => row.kind)).size !== rows.length || new Set(rows.map(row => row.content_id.toLowerCase())).size !== rows.length) throw malformed();
  return rows;
}
export function parseActivitySources(raw: any, cursor: string | null) {
  if (!exact(raw, ['sources', 'next_cursor']) || !Array.isArray(raw.sources) || raw.sources.length > 25 || raw.next_cursor !== null && (typeof raw.next_cursor !== 'string' || !uuid.test(raw.next_cursor) || cursor !== null && raw.next_cursor.toLowerCase() <= cursor.toLowerCase())) throw malformed();
  const rows: ActivitySource[] = raw.sources.map((row: any) => {
    if (!exact(row, ['source_id', 'title', 'source_status', 'audience']) || !validId(row.source_id) || typeof row.title !== 'string' || row.title.length > 255 || !['draft', 'published'].includes(row.source_status) || !['course', 'restricted'].includes(row.audience)) throw malformed();
    return { source_id: row.source_id, title: row.title, source_status: row.source_status, audience: row.audience };
  });
  if (rows.some((row, i) => i > 0 && rows[i - 1].source_id.toLowerCase() >= row.source_id.toLowerCase() || cursor !== null && row.source_id.toLowerCase() <= cursor.toLowerCase())) throw malformed();
  if (raw.next_cursor !== null && rows.length && raw.next_cursor.toLowerCase() < rows[rows.length - 1].source_id.toLowerCase()) throw malformed();
  return { rows, cursor: raw.next_cursor as string | null };
}
export interface ActivityEditorState { phase: 'idle' | 'ready' | 'error' | 'session-ended'; busy: boolean; stale: boolean; current: LessonActivity | null; options: ActivitySource[]; cursor: string | null; notice: string | null; error: string | null }
export const initialActivityEditor = (): ActivityEditorState => ({ phase: 'idle', busy: false, stale: true, current: null, options: [], cursor: null, notice: null, error: null });
export function createActivityEditor(kind: ActivityKind, deps: {
  list(signal: AbortSignal): Promise<unknown>; options(cursor: string | null, signal: AbortSignal): Promise<unknown>;
  attach(sourceId: string, signal: AbortSignal): Promise<unknown>; detach(contentId: string, signal: AbortSignal): Promise<unknown>;
  readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
}) {
  let state = initialActivityEditor(), ended = false, epoch = 0, abort: AbortController | null = null, confirmedNotice: string | null = null;
  const principal = deps.readPrincipal(), listeners = new Set<(state: ActivityEditorState) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const deadline = () => { const operation = abort!; const timer = setTimeout(() => operation.abort(), 20000); timers.add(timer); return timer; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); };
  const set = (patch: Partial<ActivityEditorState>) => { state = { ...state, ...patch }; if (!ended) listeners.forEach(fn => fn(state)); };
  const invalidate = () => { if (ended) return; epoch++; abort?.abort(); clearTimers(); set({ ...initialActivityEditor(), phase: 'session-ended', error: 'تغيّرت الجلسة. افتح محرر الحصة من جديد.' }); };
  const current = (ticket: number) => { if (ended || ticket !== epoch) return false; if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true; };
  const unsubscribe = deps.subscribeSession(invalidate);
  const claim = () => { if (state.busy || state.phase === 'session-ended' || !current(epoch)) return null; abort = new AbortController(); const ticket = ++epoch; set({ busy: true, error: null }); return ticket; };
  const read = async (ticket: number) => {
    try {
      const rows = parseActivityList(await deps.list(abort!.signal)); if (!current(ticket)) return false; if (abort!.signal.aborted) throw malformed();
      const page = parseActivitySources(await deps.options(null, abort!.signal), null); if (!current(ticket)) return false; if (abort!.signal.aborted) throw malformed();
      set({ phase: 'ready', current: rows.find(row => row.kind === kind) ?? null, options: page.rows, cursor: page.cursor, stale: false, notice: confirmedNotice }); return true;
    } catch { if (current(ticket)) set({ phase: 'error', stale: true, current: null, options: [], cursor: null, error: 'تعذّر تحديث الربط والمصادر. حدّث البيانات قبل أي تعديل.' }); return false; }
  };
  const finish = (ticket: number, timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); if (current(ticket)) set({ busy: false }); };
  const mutate = async (operation: 'attach' | 'detach', id: string) => {
    if (state.phase !== 'ready' || state.stale || operation === 'attach' && (state.current || !state.options.some(row => row.source_id === id)) || operation === 'detach' && state.current?.content_id !== id) return false;
    const ticket = claim(); if (ticket === null) return false;
    const timer = deadline(); let confirmed = false;
    confirmedNotice = null; set({ notice: null });
    try {
      const raw: any = await (operation === 'attach' ? deps.attach(id, abort!.signal) : deps.detach(id, abort!.signal)); if (!current(ticket)) return false;
      if (abort!.signal.aborted) throw malformed();
      if (operation === 'attach') {
        if (!exact(raw, ['content', 'unchanged']) || typeof raw.unchanged !== 'boolean') throw malformed();
        const row = parseActivity(raw.content); if (row.kind !== kind || row.source_id.toLowerCase() !== id.toLowerCase() || row.source_status === 'unavailable') throw malformed();
      } else if (!exact(raw, ['detached', 'kind']) || typeof raw.detached !== 'boolean' || raw.kind !== kind) throw malformed();
      confirmed = true;
      confirmedNotice = operation === 'attach' ? 'تم تأكيد الربط. النشر ومحاولات الطالب تظل خاضعة لقواعد التقييم الأصلية.' : 'تم تأكيد فك الربط. التقييم الأصلي ومحاولاته محفوظة.';
      set({ notice: confirmedNotice });
      await read(ticket);
      if (current(ticket) && state.stale) set({ notice: 'الحفظ مؤكد، لكن القائمة لم تتحدث. حدّث البيانات ولا تُعد الحفظ.' });
      return true;
    } catch (error) {
      if (!current(ticket)) return false;
      const known = error instanceof ApiRequestError && error.code !== 'PERSISTENCE_UNCERTAIN' && error.status >= 400 && error.status < 500;
      set({ phase: 'error', stale: true, current: null, options: [], cursor: null, error: known ? 'الربط أو المصدر تغيّر أو لم يعد مسموحًا. حدّث البيانات قبل المحاولة.' : 'نتيجة الحفظ غير مؤكدة. حدّث القائمة للتحقق قبل أي محاولة أخرى؛ لم تتم إعادة الإرسال تلقائيًا.' });
      return confirmed;
    } finally { finish(ticket, timer); }
  };
  return {
    getState: () => state,
    subscribe(fn: (state: ActivityEditorState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async refresh() { const ticket = claim(); if (ticket === null) return; const timer = deadline(); try { await read(ticket); } finally { finish(ticket, timer); } },
    async more() {
      if (state.stale || !state.cursor) return; const cursor = state.cursor, ticket = claim(); if (ticket === null) return;
      const timer = deadline();
      try { const page = parseActivitySources(await deps.options(cursor, abort!.signal), cursor); if (current(ticket)) { if (abort!.signal.aborted) throw malformed(); set({ options: page.rows, cursor: page.cursor }); } }
      catch { if (current(ticket)) set({ error: 'تعذّر تحميل صفحة المصادر التالية. يمكنك إعادة المحاولة.' }); }
      finally { finish(ticket, timer); }
    },
    attach: (id: string) => mutate('attach', id), detach: (id: string) => mutate('detach', id), invalidate,
    dispose() { ended = true; epoch++; abort?.abort(); clearTimers(); unsubscribe(); listeners.clear(); },
  };
}
