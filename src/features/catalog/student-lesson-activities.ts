import { ApiRequestError } from '../../lib/api-http';
export interface StudentActivity { content_id: string; kind: 'homework' | 'quiz'; title: string; launch_status: 'unconfigured' | 'attempt_required' | 'submission_required' }
export interface StudentActivityDetail extends StudentActivity { instructions: string | null; deadline_at: string | null }
export interface StudentActivityState { phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended'; rows: StudentActivity[]; detail: StudentActivityDetail | null; loadingId: string | null; message: string | null }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const exact = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const bad = () => Error('Invalid student activity');
const activity = (row: any): StudentActivity => {
  if (typeof row.content_id !== 'string' || !uuid.test(row.content_id) || !['homework', 'quiz'].includes(row.kind) || typeof row.title !== 'string' || row.title.length > 255 || !['unconfigured',row.kind==='homework'?'submission_required':'attempt_required'].includes(row.launch_status)) throw bad();
  return { content_id: row.content_id, kind: row.kind, title: row.title, launch_status: row.launch_status };
};
export function parseStudentActivities(raw: any, lessonId: string): StudentActivity[] {
  if (!exact(raw, ['lesson_id', 'activities']) || raw.lesson_id !== lessonId || !Array.isArray(raw.activities) || raw.activities.length > 2) throw bad();
  const rows: StudentActivity[] = raw.activities.map((row: any) => { if (!exact(row, ['content_id', 'kind', 'title', 'launch_status'])) throw bad(); return activity(row); });
  if (new Set(rows.map(row => row.kind)).size !== rows.length || new Set(rows.map(row => row.content_id.toLowerCase())).size !== rows.length) throw bad();
  return rows;
}
export function parseStudentActivityDetail(raw: any, selected: StudentActivity): StudentActivityDetail {
  if (!exact(raw, ['activity']) || !exact(raw.activity, ['content_id', 'kind', 'title', 'instructions', 'deadline_at', 'launch_status'])) throw bad();
  const row = raw.activity, parsed = activity(row);
  if (parsed.content_id !== selected.content_id || parsed.kind !== selected.kind || row.instructions !== null && (typeof row.instructions !== 'string' || row.instructions.length > 20000)
    || row.deadline_at !== null && (typeof row.deadline_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.deadline_at) || !Number.isFinite(Date.parse(row.deadline_at)) || new Date(row.deadline_at).toISOString() !== row.deadline_at)
    || row.kind === 'quiz' && (row.instructions !== null || row.deadline_at !== null)) throw bad();
  return { ...parsed, instructions: row.instructions, deadline_at: row.deadline_at };
}
export const initialStudentActivities = (): StudentActivityState => ({ phase: 'idle', rows: [], detail: null, loadingId: null, message: null });
export function createStudentActivities(lessonId: string, deps: {
  list(signal: AbortSignal): Promise<unknown>; detail(contentId: string, signal: AbortSignal): Promise<unknown>;
  readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
}) {
  let state = initialStudentActivities(), epoch = 0, disposed = false, abort: AbortController | null = null;
  const principal = deps.readPrincipal(), listeners = new Set<(state: StudentActivityState) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: StudentActivityState) => { state = next; if (!disposed) listeners.forEach(fn => fn(state)); };
  const invalidate = () => { if (disposed) return; epoch++; abort?.abort(); clearTimeout(timer); set({ ...initialStudentActivities(), phase: 'session-ended', message: 'تغيّرت الجلسة. افتح تقييمات الدرس من مساحة الطالب الحالية.' }); };
  const current = (ticket: number) => { if (disposed || ticket !== epoch) return false; if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true; };
  const unsubscribe = deps.subscribeSession(invalidate);
  const claim = () => { if (disposed || state.phase === 'session-ended' || state.phase === 'loading' || state.loadingId || !current(epoch)) return null; abort = new AbortController(); const operation = abort; timer = setTimeout(() => operation.abort(), 20000); return ++epoch; };
  const failed = (error: unknown) => error instanceof ApiRequestError && ([401, 403, 404, 409].includes(error.status) || error.code === 'STUDENT_SPACE_REQUIRED');
  return {
    getState: () => state,
    subscribe(fn: (state: StudentActivityState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async load() {
      const ticket = claim(); if (ticket === null) return;
      set({ ...initialStudentActivities(), phase: 'loading' });
      try { const rows = parseStudentActivities(await deps.list(abort!.signal), lessonId); if (!current(ticket)) return; if (abort!.signal.aborted) throw bad(); set({ ...initialStudentActivities(), phase: 'ready', rows }); }
      catch (error) { if (current(ticket)) set({ ...initialStudentActivities(), phase: 'error', message: failed(error) ? 'التقييمات لم تعد متاحة لهذا الدرس بالحساب الحالي. حدّث مسار التعلّم.' : 'تعذّر عرض تقييمات الدرس حاليًا. يمكنك إعادة المحاولة.' }); }
      finally { if (current(ticket)) clearTimeout(timer); }
    },
    async open(contentId: string) {
      if (state.phase !== 'ready') return; const selected = state.rows.find(row => row.content_id === contentId); if (!selected) return;
      const ticket = claim(); if (ticket === null) return;
      set({ ...state, loadingId: contentId, detail: null, message: null });
      try { const detail = parseStudentActivityDetail(await deps.detail(contentId, abort!.signal), selected); if (!current(ticket)) return; if (abort!.signal.aborted) throw bad(); set({ ...state, detail }); }
      catch (error) { if (current(ticket)) set(failed(error) ? { ...initialStudentActivities(), phase: 'error', message: 'لم يعد عرض هذا التقييم مسموحًا. حدّث مسار التعلّم.' } : { ...state, detail: null, message: 'تعذّر تحميل التفاصيل. يمكنك المحاولة مجددًا.' }); }
      finally { if (current(ticket)) { clearTimeout(timer); set({ ...state, loadingId: null }); } }
    },
    close() { if (!disposed && !state.loadingId) set({ ...state, detail: null }); }, invalidate,
    dispose() { disposed = true; epoch++; abort?.abort(); clearTimeout(timer); unsubscribe(); listeners.clear(); },
  };
}
