import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import type { LessonAnnouncement } from './lesson-announcements';
import { announcementPublicationTransport, createPublicationController, initialPublicationState, type PublicationState } from './announcement-publication';
export function LessonAnnouncementPublication({ courseId, unitId, lessonId, reference }: {
    courseId: string;
    unitId: string;
    lessonId: string;
    reference: LessonAnnouncement;
}) {
    const [state, setState] = useState<PublicationState>(initialPublicationState), [confirmed, setConfirmed] = useState(false), ref = useRef<ReturnType<typeof createPublicationController> | null>(null);
    useEffect(() => { const controller = createPublicationController(reference, { ...announcementPublicationTransport(courseId, unitId, lessonId, reference.content_id), readPrincipal: () => { try {
            return readCourseSessionPrincipal(localStorage);
        }
        catch {
            return null;
        } }, subscribeSession: subscribeSessionChange }); ref.current = controller; const unsubscribe = controller.subscribe(value => { setState(value); setConfirmed(false); }); const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key))
        controller.invalidate(); }; window.addEventListener('storage', storage); void controller.load(); return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; }; }, [courseId, unitId, lessonId, reference]);
    const writable = state.phase === 'ready' && !state.uncertain;
    return <section dir="rtl" aria-label="إتاحة إعلان الحصة للطالب" className="space-y-3 rounded border border-emerald-200 bg-white p-3">
    <h4 className="font-semibold">إتاحة الإعلان داخل الدرس</h4><p>دي خطوة منفصلة عن نشر مصدر المجموعة. الطالب يراه فقط مع صلاحية الدرس ونفس المجموعة؛ لا تُرسل رسالة خارجية.</p>
    <div aria-live="polite">{state.phase === 'busy' ? <p>جارٍ التحقق من النسخة الحالية…</p> : null}{state.message ? <p role="status">{state.message}</p> : null}</div>
    {state.publication ? <p>{state.publication.status === 'published' ? 'توجد إتاحة مؤكدة للنسخة المراجَعة.' : 'مصدر الإعلان تغيّر أو سُحب؛ الإعلان محجوب عن الطالب حتى مراجعة جديدة.'}</p> : <p>لا توجد إتاحة مؤكدة معروضة حاليًا.</p>}
    <Button type="button" variant="outline" disabled={state.phase === 'busy' || state.phase === 'session-ended' || state.uncertain} onClick={() => { void ref.current?.review(); }}>معاينة النسخة الحالية قبل الإتاحة</Button>
    {state.review ? <article aria-label="النص المراد إتاحته" className="space-y-2 rounded border p-3"><h5 dir="auto">{state.review.preview.title}</h5><p dir="auto" className="whitespace-pre-wrap">{state.review.preview.body}</p><p>المجموعة: {state.review.preview.group_name} — التحاقات مرشحة وقت المعاينة: {state.review.preview.candidate_enrollments}.</p><p>العضوية متغيرة. موعد الدرس وشرطه السابق يظلان مطلوبين عند فتح الطالب.</p>{!state.review.can_publish ? <p>الإتاحة تتطلب مصدرًا منشورًا إداريًا ومقررًا منشورًا ودرسًا نشطًا. حدّث المصدر ثم أعد المعاينة.</p> : <><label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={!writable} onChange={e => setConfirmed(e.target.checked)}/>راجعت النص والمجموعة وأوافق على إتاحتهما داخل الدرس</label><Button type="button" disabled={!writable || !confirmed} onClick={() => { setConfirmed(false); void ref.current?.publish(); }}>تأكيد إتاحة النسخة المراجَعة</Button></>}</article> : null}
    {state.publication ? <Button type="button" variant="outline" disabled={!writable} onClick={() => { void ref.current?.withdraw(); }}>سحب الإتاحة الحالية من الدرس</Button> : null}
    <Button type="button" variant="outline" disabled={state.phase === 'busy' || state.phase === 'session-ended'} onClick={() => { void ref.current?.load(); }}>قراءة حالة الإتاحة من الخادم</Button>
  </section>;
}
