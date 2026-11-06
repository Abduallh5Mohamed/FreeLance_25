import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SecureVideoPlayer } from '@/components/SecureVideoPlayer';
import { listStudentLessonVideos } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createStudentVideos, initialStudentVideos, type StudentVideosState } from './student-lesson-videos';

export function StudentLessonVideos({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="mt-3 border-t pt-3">
    <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق فيديوهات الدرس' : 'عرض فيديوهات الدرس'}</Button>
    {open ? <StudentLessonVideoList key={`${courseId}/${lessonId}`} courseId={courseId} lessonId={lessonId} /> : null}
  </div>;
}
export function StudentLessonVideoList({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [state, setState] = useState<StudentVideosState>(initialStudentVideos);
  const ref = useRef<ReturnType<typeof createStudentVideos> | null>(null);
  useEffect(() => {
    const controller = createStudentVideos(lessonId, {
      list: signal => listStudentLessonVideos(courseId, lessonId, signal),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } },
      subscribeSession: fn => subscribeSessionChange(fn),
    });
    ref.current = controller;
    const unsubscribe = controller.subscribe(setState);
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage); void controller.load();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId, lessonId]);
  return <section dir="rtl" aria-label="فيديوهات الدرس المخصصة لي" className="mt-3 space-y-2 rounded-lg border bg-slate-50 p-3 text-sm">
    <div aria-live="polite">
      {state.phase === 'loading' ? <p>جارٍ التحقق من فيديوهات الدرس…</p> : null}
      {state.message ? <p role="alert" className="text-amber-800">{state.message}</p> : null}
      {state.phase === 'ready' && !state.rows.length ? <p>لا توجد فيديوهات متاحة لك في هذا الدرس حاليًا.</p> : null}
    </div>
    <ul className="space-y-2">{state.rows.map(row => <li key={row.content_id} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-white p-2">
      <span dir="auto">{row.title || 'فيديو الدرس'}</span>
      {row.playback_status === 'session_required' ? <Button type="button" size="sm" disabled={Boolean(state.selected)} onClick={() => ref.current?.select(row.content_id)}>فتح الفيديو</Button>
        : <span className="text-amber-800">تشغيل الفيديو غير متاح حاليًا.</span>}
    </li>)}</ul>
    {['error', 'ready'].includes(state.phase) ? <Button type="button" variant="outline" size="sm" onClick={() => { void ref.current?.load(); }}>تحديث فيديوهات الدرس</Button> : null}
    <p className="text-xs text-muted-foreground">يُتحقق من السماح بالمشاهدة عند فتح الفيديو. المشاهدة لا تسجّل إتمام الدرس تلقائيًا.</p>
    {state.selected ? <SecureVideoPlayer key={state.selected.content_id} catalog={{ course_id: courseId, lesson_id: lessonId, content_id: state.selected.content_id }}
      userId="" studentName="" groupName="" onClose={() => ref.current?.close()} /> : null}
  </section>;
}
