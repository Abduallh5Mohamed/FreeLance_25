import { ApiRequestError } from '../../lib/api-http';
export interface StudentLessonVideo { content_id: string; title: string; display_order: number; playback_status: 'session_required' | 'unconfigured' }
export interface StudentVideosState { phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended'; rows: StudentLessonVideo[]; selected: StudentLessonVideo | null; message: string | null }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const initialStudentVideos = (): StudentVideosState => ({ phase: 'idle', rows: [], selected: null, message: null });
export function parseStudentVideos(raw: any, lessonId: string): StudentLessonVideo[] {
  if (!raw || Object.keys(raw).sort().join(',') !== 'lesson_id,videos' || raw.lesson_id !== lessonId || !Array.isArray(raw.videos) || raw.videos.length > 20) throw Error('Invalid lesson videos');
  const rows = raw.videos.map((row: any) => {
    if (!row || Object.keys(row).sort().join(',') !== 'content_id,display_order,playback_status,title'
      || typeof row.content_id !== 'string' || !uuid.test(row.content_id) || typeof row.title !== 'string' || row.title.length > 255
      || !Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647
      || !['session_required', 'unconfigured'].includes(row.playback_status)) throw Error('Invalid lesson video');
    return { content_id: row.content_id, title: row.title, display_order: row.display_order, playback_status: row.playback_status } as StudentLessonVideo;
  });
  if (new Set(rows.map(row => row.content_id.toLowerCase())).size !== rows.length || rows.some((row, i) => i > 0 && rows[i - 1].display_order >= row.display_order)) throw Error('Invalid lesson video order');
  return rows;
}
export function createStudentVideos(lessonId: string, deps: {
  list(signal: AbortSignal): Promise<unknown>; readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
}) {
  let state = initialStudentVideos(), epoch = 0, disposed = false;
  const principal = deps.readPrincipal(), lifetime = new AbortController(), listeners = new Set<(state: StudentVideosState) => void>();
  const set = (next: StudentVideosState) => { state = next; if (!disposed) listeners.forEach(fn => fn(state)); };
  const invalidate = () => { if (disposed) return; epoch++; lifetime.abort(); set({ ...initialStudentVideos(), phase: 'session-ended', message: 'تغيّرت الجلسة. افتح فيديوهات الدرس من مساحة الطالب الحالية.' }); };
  const current = (ticket: number) => { if (disposed || ticket !== epoch) return false; if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true; };
  const unsubscribe = deps.subscribeSession(invalidate);
  return {
    getState: () => state,
    subscribe(fn: (state: StudentVideosState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async load() {
      if (disposed || state.phase === 'loading' || state.phase === 'session-ended' || !current(epoch)) return;
      const ticket = ++epoch; set({ ...initialStudentVideos(), phase: 'loading' });
      try { const rows = parseStudentVideos(await deps.list(lifetime.signal), lessonId); if (current(ticket)) set({ ...initialStudentVideos(), phase: 'ready', rows }); }
      catch (error) {
        if (!current(ticket)) return;
        const denied = error instanceof ApiRequestError && [401, 403, 404].includes(error.status);
        set({ ...initialStudentVideos(), phase: 'error', message: denied ? 'لم تعد فيديوهات هذا الدرس متاحة لك. حدّث مسار التعلّم.' : 'تعذّر عرض فيديوهات الدرس حاليًا. يمكنك إعادة المحاولة.' });
      }
    },
    select(contentId: string) { if (state.phase !== 'ready' || !current(epoch)) return; const selected = state.rows.find(row => row.content_id === contentId && row.playback_status === 'session_required'); if (selected) set({ ...state, selected }); },
    close() { if (!disposed) set({ ...state, selected: null }); },
    invalidate,
    dispose() { disposed = true; epoch++; lifetime.abort(); unsubscribe(); listeners.clear(); },
  };
}
