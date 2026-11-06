import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createAnnouncementEditor, initialAnnouncementEditor, lessonAnnouncementTransport, type AnnouncementEditorState } from './lesson-announcements';
import { LessonAnnouncementPublication } from './LessonAnnouncementPublication';
export function LessonAnnouncementManager(props: {
    courseId: string;
    unitId: string;
    lessonId: string;
}) {
    const [open, setOpen] = useState(false);
    return <div className="w-full border-t pt-2"><Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق إعلان الحصة' : 'إعداد إعلان الحصة ومعاينته'}</Button>{open ? <LessonAnnouncementEditor key={`${props.courseId}/${props.unitId}/${props.lessonId}`} {...props}/> : null}</div>;
}
export function LessonAnnouncementEditor({ courseId, unitId, lessonId }: {
    courseId: string;
    unitId: string;
    lessonId: string;
}) {
    const [state, setState] = useState<AnnouncementEditorState>(initialAnnouncementEditor), [selected, setSelected] = useState(''), [confirm, setConfirm] = useState(false), ref = useRef<ReturnType<typeof createAnnouncementEditor> | null>(null);
    useEffect(() => {
        const controller = createAnnouncementEditor({ ...lessonAnnouncementTransport(courseId, unitId, lessonId), readPrincipal: () => { try {
                return readCourseSessionPrincipal(localStorage);
            }
            catch {
                return null;
            } }, subscribeSession: subscribeSessionChange });
        ref.current = controller;
        const unsubscribe = controller.subscribe(setState);
        const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key))
            controller.invalidate(); };
        window.addEventListener('storage', storage);
        void controller.load();
        return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
    }, [courseId, unitId, lessonId]);
    const writable = state.phase === 'ready' && !state.busy && !state.uncertain;
    return <section dir="rtl" aria-label="إعلان الحصة ومعاينة الجمهور" className="mt-3 space-y-3 rounded border border-indigo-200 bg-indigo-50/30 p-3 text-sm">
    <p>اختر إعلانًا من مجموعة داخل المقرر. الربط والمعاينة لا يتيحان الإعلان للطلاب ولا يرسلان رسالة. حالة «منشور» للمصدر تعني سجله الإداري داخل المجموعة.</p>
    <div aria-live="polite">{state.busy ? <p>جارٍ التحقق…</p> : null}{state.message ? <p role="status">{state.message}</p> : null}</div>
    {state.current ? <><p dir="auto">{state.current.title ?? 'مصدر الإعلان غير متاح'} — {state.current.group_name ?? 'مجموعة غير متاحة'}</p><Button type="button" disabled={!writable || state.current.source_state === 'unavailable'} onClick={() => { void ref.current?.preview(); }}>معاينة النص والجمهور المرشح</Button>
      <label className="flex gap-2"><input type="checkbox" checked={confirm} disabled={!writable} onChange={e => setConfirm(e.target.checked)}/>فك المرجع فقط مع إبقاء إعلان المجموعة</label><Button type="button" variant="outline" disabled={!writable || !confirm} onClick={() => { setConfirm(false); void ref.current?.detach(); }}>تأكيد فك الربط</Button></> : <>
      <label>إعلان المجموعة<select className="block w-full rounded border p-2" value={selected} disabled={!writable} onChange={e => setSelected(e.target.value)}><option value="">اختر إعلانًا من المقرر</option>{state.options.map(row => <option key={row.source_id} value={row.source_id}>{row.title} — {row.group_name} — {row.source_state === 'draft' ? 'مسودة' : 'منشور إداريًا'}</option>)}</select></label>
      <Button type="button" disabled={!writable || !state.options.some(x => x.source_id === selected)} onClick={() => { void ref.current?.attach(selected); }}>ربط الإعلان بالدرس</Button>{state.cursor && state.options.length < 200 ? <Button type="button" variant="outline" disabled={!writable} onClick={() => { setSelected(''); void ref.current?.more(); }}>المصادر التالية</Button> : null}</>}
    {state.preview ? <article className="space-y-2 rounded border bg-white p-3" aria-label="معاينة إعلان الحصة"><h4 dir="auto">{state.preview.title}</h4><p dir="auto" className="whitespace-pre-wrap">{state.preview.body}</p><p>المجموعة: {state.preview.group_name} — الالتحاقات النشطة المرشحة: {state.preview.candidate_enrollments}.</p><p>المقرر {state.preview.course_published ? 'منشور' : 'غير منشور'}؛ الحصة {state.preview.lesson_active ? 'نشطة' : 'مؤرشفة'}؛ الموعد {state.preview.lesson_released ? 'مفتوح' : 'لم يحن بعد'}.{state.preview.prerequisite_required ? ' يوجد شرط إكمال سابق يُفحص لكل طالب.' : ''}</p><p>العدد لا يشمل إثبات إكمال الشرط السابق لكل طالب. المعاينة وحدها لا تنشر الإعلان ولا ترسل رسالة؛ استخدم قسم الإتاحة المنفصل.</p><time dateTime={state.preview.previewed_at}>{new Date(state.preview.previewed_at).toLocaleString('ar-EG')}</time></article> : null}
    {state.phase==='ready'&&!state.busy&&!state.uncertain&&state.current?<LessonAnnouncementPublication key={state.current.content_id} courseId={courseId} unitId={unitId} lessonId={lessonId} reference={state.current}/>:null}
    <Button type="button" variant="outline" disabled={state.busy || state.phase === 'session-ended'} onClick={() => { setSelected(''); setConfirm(false); void ref.current?.load(); }}>تحديث المرجع والمصادر من الخادم</Button>
  </section>;
}
