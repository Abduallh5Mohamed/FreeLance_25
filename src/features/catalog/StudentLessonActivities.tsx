import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listStudentLessonActivities, readStudentLessonActivity } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createStudentActivities, initialStudentActivities, type StudentActivityState } from './student-lesson-activities';
import { StudentCatalogQuiz } from './StudentCatalogQuiz';
import { StudentCatalogHomework } from './StudentCatalogHomework';
export function StudentLessonActivities({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="mt-3 border-t pt-3"><Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق تقييمات الدرس' : 'عرض واجب وكويز الدرس'}</Button>
    {open ? <StudentLessonActivityList key={`${courseId}/${lessonId}`} courseId={courseId} lessonId={lessonId} /> : null}</div>;
}
export function StudentLessonActivityList({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [state, setState] = useState<StudentActivityState>(initialStudentActivities), ref = useRef<ReturnType<typeof createStudentActivities> | null>(null);
  useEffect(() => {
    const controller = createStudentActivities(lessonId, { list: signal => listStudentLessonActivities(courseId, lessonId, signal), detail: (id, signal) => readStudentLessonActivity(courseId, lessonId, id, signal),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, subscribeSession: fn => subscribeSessionChange(fn) });
    ref.current = controller; const unsubscribe = controller.subscribe(setState);
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage); void controller.load();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId, lessonId]);
  return <section dir="rtl" aria-label="تقييمات الدرس المخصصة لي" className="mt-3 space-y-3 rounded-lg border bg-slate-50 p-3 text-sm">
    <div aria-live="polite">{state.phase === 'loading' ? <p>جارٍ التحقق من تقييمات الدرس…</p> : null}{state.message ? <p role="alert" className="text-amber-800">{state.message}</p> : null}
      {state.phase === 'ready' && !state.rows.length ? <p>لا توجد تقييمات منشورة ومخصصة لك في هذا الدرس حاليًا.</p> : null}</div>
    <ul className="space-y-2">{state.rows.map(row => <li key={row.content_id} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-white p-2">
      <span dir="auto">{row.kind === 'homework' ? 'واجب' : 'كويز'}: {row.title}</span><Button type="button" size="sm" variant="outline" disabled={Boolean(state.loadingId)} onClick={() => { void ref.current?.open(row.content_id); }}>{state.loadingId === row.content_id ? 'جارٍ تحميل التفاصيل…' : 'عرض التعليمات والتفاصيل'}</Button>
    </li>)}</ul>
    {state.detail ? <article className="space-y-2 rounded border border-teal-200 bg-white p-3" aria-label="تفاصيل التقييم">
      <h4 className="font-semibold" dir="auto">{state.detail.title}</h4>
      {state.detail.instructions ? <p className="whitespace-pre-wrap" dir="auto">{state.detail.instructions}</p> : <p>لا توجد تعليمات إضافية معروضة لهذا التقييم.</p>}
      {state.detail.deadline_at ? <p>الموعد النهائي بتوقيت جهازك: <time dateTime={state.detail.deadline_at}>{new Date(state.detail.deadline_at).toLocaleString('ar-EG')}</time></p> : null}
      <p>عرض التفاصيل لا يبدأ محاولة ولا يسجّل إتمام الدرس.</p>
      {state.detail.kind === 'quiz' && state.detail.launch_status === 'attempt_required' ? <StudentCatalogQuiz key={`${courseId}/${lessonId}/${state.detail.content_id}`} courseId={courseId} lessonId={lessonId} contentId={state.detail.content_id} /> : state.detail.kind === 'homework' && state.detail.launch_status === 'submission_required' ? <StudentCatalogHomework key={`${courseId}/${lessonId}/${state.detail.content_id}`} courseId={courseId} lessonId={lessonId} contentId={state.detail.content_id} /> : <p>بدء الحل والتسليم لهذا التقييم غير متاحين حاليًا.</p>}
      <Button type="button" size="sm" variant="outline" onClick={() => ref.current?.close()}>إغلاق التفاصيل</Button>
    </article> : null}
    {state.phase !== 'session-ended' ? <Button type="button" size="sm" variant="outline" disabled={state.phase === 'loading' || Boolean(state.loadingId)} onClick={() => { void ref.current?.load(); }}>تحديث تقييمات الدرس</Button> : null}
  </section>;
}
