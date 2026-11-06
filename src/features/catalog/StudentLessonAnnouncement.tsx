import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { homeworkPrincipalReader } from './catalog-homework';
import { createStudentAnnouncement, initialStudentAnnouncement, studentAnnouncementTransport, type StudentAnnouncementState } from './announcement-publication';
export function StudentLessonAnnouncement({ courseId, lessonId }: {
    courseId: string;
    lessonId: string;
}) {
    const [open, setOpen] = useState(false);
    return <div className="mt-3 border-t pt-3"><Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق إعلان الحصة' : 'عرض إعلان الحصة'}</Button>{open ? <StudentLessonAnnouncementBody key={`${courseId}/${lessonId}`} courseId={courseId} lessonId={lessonId}/> : null}</div>;
}
export function StudentLessonAnnouncementBody({ courseId, lessonId }: {
    courseId: string;
    lessonId: string;
}) {
    const [state, setState] = useState<StudentAnnouncementState>(initialStudentAnnouncement), ref = useRef<ReturnType<typeof createStudentAnnouncement> | null>(null);
    useEffect(() => { const principal = homeworkPrincipalReader(localStorage); const controller = createStudentAnnouncement(lessonId, { read: studentAnnouncementTransport(courseId, lessonId), readPrincipal: () => { try {
            return principal();
        }
        catch {
            return null;
        } }, subscribeSession: subscribeSessionChange }); ref.current = controller; const unsubscribe = controller.subscribe(setState); const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace', 'currentStudent', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(e.key))
        controller.invalidate(); }; window.addEventListener('storage', storage); void controller.load(); return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; }; }, [courseId, lessonId]);
    return <section dir="rtl" aria-label="إعلان الحصة المتاح لي" className="mt-3 space-y-2 rounded border bg-slate-50 p-3 text-sm"><div aria-live="polite">{state.phase === 'busy' ? <p>جارٍ التحقق من الإعلان المتاح…</p> : null}{state.message ? <p role="status">{state.message}</p> : null}</div>
    {state.phase === 'ready' ? (state.announcement ? <article><h4 className="font-semibold" dir="auto">{state.announcement.title}</h4><p dir="auto" className="whitespace-pre-wrap">{state.announcement.body}</p><p className="mt-2 text-xs">نُشرت هذه النسخة: <time dateTime={state.announcement.published_at}>{new Date(state.announcement.published_at).toLocaleString('ar-EG')}</time>. قراءتها لا تسجّل إتمام الدرس.</p></article> : <p>لا يوجد إعلان متاح لك في هذا الدرس حاليًا.</p>) : null}
    {state.phase !== 'session-ended' ? <Button type="button" size="sm" variant="outline" disabled={state.phase === 'busy'} onClick={() => { void ref.current?.load(); }}>تحديث الإعلان المتاح</Button> : null}
  </section>;
}
