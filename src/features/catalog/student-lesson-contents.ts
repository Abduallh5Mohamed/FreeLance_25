import { ApiRequestError } from '../../lib/api-http';
export interface StudentLessonMaterial { content_id: string; title: string; material_type: string; display_order: number; delivery_status: 'unavailable' | 'pdf_available' }
export interface StudentLessonContentsState {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'locked' | 'denied' | 'unavailable' | 'session-ended';
  rows: StudentLessonMaterial[]; message: string | null;
  downloadingId: string | null; downloadMessage: string | null;
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const exact = (x: unknown, keys: string[]): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(x, key));
export function parseStudentLessonContents(value: unknown, lessonId: string): StudentLessonMaterial[] {
  const bad = () => new Error('استجابة مواد الدرس غير صالحة. أعد التحميل.');
  if (!exact(value, ['lesson_id', 'contents']) || typeof value.lesson_id !== 'string' || value.lesson_id.toLowerCase() !== lessonId.toLowerCase()
    || !Array.isArray(value.contents) || value.contents.length > 20) throw bad();
  const rows = value.contents.map(row => {
    if (!exact(row, ['content_id', 'title', 'material_type', 'display_order', 'delivery_status'])
      || typeof row.content_id !== 'string' || !uuid.test(row.content_id)
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 255
      || typeof row.material_type !== 'string' || !['pdf', 'video', 'presentation', 'link', 'other'].includes(row.material_type)
      || typeof row.display_order !== 'number' || !Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647
      || !['unavailable','pdf_available'].includes(String(row.delivery_status)) || typeof row.delivery_status !== 'string'
      || row.delivery_status === 'pdf_available' && row.material_type !== 'pdf') throw bad();
    return { content_id: row.content_id, title: row.title, material_type: row.material_type,
      display_order: row.display_order, delivery_status: row.delivery_status as StudentLessonMaterial['delivery_status'] };
  });
  if (new Set(rows.map(row => row.content_id.toLowerCase())).size !== rows.length
    || rows.some((row, i) => i > 0 && rows[i - 1].display_order >= row.display_order)) throw bad();
  return rows;
}
export const initialStudentLessonContentsState = (): StudentLessonContentsState => ({ phase: 'idle', rows: [], message: null, downloadingId:null, downloadMessage:null });
export function createStudentLessonContentsController(lessonId: string, deps: {
  list(): Promise<unknown>; readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
  download?(contentId: string, signal: AbortSignal): Promise<Blob>; save?(blob: Blob, contentId: string): void;
}) {
  let state = initialStudentLessonContentsState(), disposed = false, epoch = 0;
  const principal = deps.readPrincipal();
  const lifetime = new AbortController();
  const listeners = new Set<(s: StudentLessonContentsState) => void>();
  const set = (next: StudentLessonContentsState) => { state = next; if (!disposed) listeners.forEach(fn => fn(state)); };
  const invalidate = () => { epoch++; lifetime.abort(); set({ ...initialStudentLessonContentsState(), phase: 'session-ended', rows: [], message: 'تغيّرت الجلسة. أغلق مواد الدرس وافتحها من جديد.' }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  const current = (ticket: number) => {
    if (disposed || ticket !== epoch) return false;
    if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true;
  };
  return {
    getState: () => state,
    subscribe(fn: (s: StudentLessonContentsState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async load() {
      if (disposed || state.phase === 'loading' || state.phase === 'session-ended' || state.downloadingId) return;
      if (!principal || principal !== deps.readPrincipal()) { invalidate(); return; }
      const ticket = ++epoch; set({ ...initialStudentLessonContentsState(), phase: 'loading', rows: [], message: null });
      try {
        const rows = parseStudentLessonContents(await deps.list(), lessonId); if (current(ticket)) set({ ...initialStudentLessonContentsState(), phase: 'ready', rows, message: null });
      } catch (e) {
        if (!current(ticket)) return;
        const phase = e instanceof ApiRequestError ? e.code === 'LESSON_LOCKED' ? 'locked'
          : e.code === 'LESSON_CONTENTS_UNAVAILABLE' ? 'unavailable'
          : [401, 403, 404].includes(e.status) || e.code === 'STUDENT_SPACE_REQUIRED' ? 'denied' : 'error' : 'error';
        set({ ...initialStudentLessonContentsState(), phase, rows: [], message: phase === 'locked' ? 'الدرس لم يعد متاحًا الآن. حدّث مسار التعلّم لمعرفة السبب.'
          : phase === 'unavailable' ? 'عرض مواد الدرس غير متاح حاليًا في هذه البيئة.'
          : phase === 'denied' ? 'لا يمكن عرض مواد هذا الدرس بالحساب ومساحة العمل الحاليين.'
          : 'تعذّر تحميل مواد الدرس. أعد المحاولة.' });
      }
    },
    async download(contentId: string) {
      if (disposed || state.phase !== 'ready' || state.downloadingId || !deps.download || !deps.save
        || !state.rows.some(row => row.content_id === contentId && row.delivery_status === 'pdf_available')) return;
      if (!principal || principal !== deps.readPrincipal()) { invalidate(); return; }
      const ticket=++epoch, operation=new AbortController(), cancel=()=>operation.abort();
      lifetime.signal.addEventListener('abort',cancel,{once:true}); const timer=setTimeout(cancel,120000);
      set({...state,downloadingId:contentId,downloadMessage:null});
      try {
        const blob=await deps.download(contentId,operation.signal); if(!current(ticket)||operation.signal.aborted)return;
        if (!(blob instanceof Blob) || blob.type!=='application/pdf' || blob.size<5 || blob.size>10*1024*1024) throw Error('Invalid PDF download');
        deps.save(blob,contentId);
        if(current(ticket))set({...state,downloadMessage:'تم تجهيز الملف وإرسال طلب التنزيل للمتصفح. لا يُسجّل إتمام الدرس تلقائيًا.'});
      } catch(error) {
        if(!current(ticket))return;
        if(error instanceof ApiRequestError && (['LESSON_LOCKED','LESSON_CONTENTS_UNAVAILABLE','STUDENT_SPACE_REQUIRED'].includes(error.code??'')||[401,403,404].includes(error.status))) {
          set({...initialStudentLessonContentsState(),phase:error.code==='LESSON_LOCKED'?'locked':'denied',message:'لم يعد تنزيل هذه المادة مسموحًا. حدّث مسار التعلّم.'});
        } else {
          const unavailable=error instanceof ApiRequestError && ['MATERIAL_FILE_UNAVAILABLE','MATERIAL_FILE_CHANGED'].includes(error.code??'');
          set({...state,rows:unavailable?state.rows.map(row=>row.content_id===contentId?{...row,delivery_status:'unavailable'}:row):state.rows,
            downloadMessage:unavailable?'تغيّرت إتاحة الملف. حدّث مواد الدرس قبل المحاولة.':'تعذّر تجهيز التنزيل. يمكنك إعادة المحاولة؛ لم يُسجّل إتمام الدرس.'});
        }
      } finally { clearTimeout(timer);lifetime.signal.removeEventListener('abort',cancel);operation.abort();if(current(ticket))set({...state,downloadingId:null}); }
    },
    invalidate,
    dispose() { if (disposed) return; disposed = true; epoch++; lifetime.abort(); unsubscribe(); listeners.clear(); state = initialStudentLessonContentsState(); },
  };
}
