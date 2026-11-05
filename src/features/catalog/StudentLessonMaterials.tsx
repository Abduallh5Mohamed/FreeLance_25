import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listStudentLessonContents, downloadStudentMaterialPdf } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createStudentLessonContentsController, initialStudentLessonContentsState, type StudentLessonContentsState } from './student-lesson-contents';
import { createPdfBrowserSaver } from './pdf-browser-save';

const types: Record<string, string> = { pdf: 'PDF', video: 'فيديو', presentation: 'عرض', link: 'رابط', other: 'ملف' };
export function StudentLessonMaterials({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="mt-3 border-t pt-3">
    <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق مواد الدرس' : 'عرض مواد الدرس'}</Button>
    {open ? <StudentLessonMaterialList key={`${courseId}/${lessonId}`} courseId={courseId} lessonId={lessonId} /> : null}
  </div>;
}
export function StudentLessonMaterialList({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [state, setState] = useState<StudentLessonContentsState>(initialStudentLessonContentsState);
  const ref = useRef<ReturnType<typeof createStudentLessonContentsController> | null>(null);
  useEffect(() => {
    const saver = createPdfBrowserSaver();
    const controller = createStudentLessonContentsController(lessonId, {
      list: () => listStudentLessonContents(courseId, lessonId),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } },
      subscribeSession: fn => subscribeSessionChange(fn),
      download: (contentId,signal) => downloadStudentMaterialPdf(courseId,lessonId,contentId,signal), save: saver.save,
    });
    ref.current = controller;
    const unsubscribe = controller.subscribe(snapshot => { setState(snapshot); if(['denied','locked','session-ended'].includes(snapshot.phase))saver.clear(); });
    const storage = (event: StorageEvent) => {
      if (event.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(event.key)) controller.invalidate();
    };
    window.addEventListener('storage', storage); void controller.load();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); saver.clear(); ref.current = null; };
  }, [courseId, lessonId]);
  return <section dir="rtl" aria-label="المواد المخصصة لي في الدرس" className="mt-3 space-y-2 rounded-lg border bg-slate-50 p-3 text-sm">
    <div aria-live="polite">
      {state.phase === 'loading' ? <p>جارٍ التحقق من إتاحة مواد الدرس…</p> : null}
      {state.message ? <p role="alert" className="text-amber-800">{state.message}</p> : null}
      {state.downloadMessage ? <p className="text-slate-700">{state.downloadMessage}</p> : null}
      {state.phase === 'ready' && !state.rows.length ? <p>لا توجد مواد منشورة ومخصصة لك في هذا الدرس حاليًا.</p> : null}
    </div>
    {state.rows.length ? <ul className="space-y-2">{state.rows.map(row => <li key={row.content_id} className="rounded border bg-white p-2">
      <p dir="auto" className="break-words font-medium">{row.title}</p>
      <p className="text-xs text-slate-600">{types[row.material_type]} · الموضع {row.display_order}</p>
      {row.delivery_status === 'pdf_available' ? <Button type="button" size="sm" variant="outline" disabled={!!state.downloadingId}
        onClick={() => { void ref.current?.download(row.content_id); }}>{state.downloadingId===row.content_id?'جارٍ تجهيز PDF…':'تنزيل PDF'}</Button>
        : <p className="mt-1 text-xs text-amber-800">فتح هذه المادة غير متاح حاليًا.</p>}
    </li>)}</ul> : null}
    <Button type="button" size="sm" variant="outline" disabled={state.phase === 'loading' || state.phase === 'session-ended' || !!state.downloadingId} onClick={() => { void ref.current?.load(); }}>تحديث مواد الدرس</Button>
  </section>;
}
