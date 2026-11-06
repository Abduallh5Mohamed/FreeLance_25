import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listLessonActivities, listLessonActivitySources, attachLessonActivity, detachLessonActivity } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createActivityEditor, initialActivityEditor, type ActivityEditorState, type ActivityKind } from './lesson-activities';
import { LessonQuizVersionManager } from './LessonQuizVersionManager';
type Target = { courseId: string; unitId: string; lessonId: string };
export function LessonActivityManager(props: Target) {
  const [open, setOpen] = useState(false);
  return <div className="w-full border-t border-slate-100 pt-2">
    <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق واجب وكويز الدرس' : 'إعداد واجب وكويز الدرس'}</Button>
    {open ? <section className="mt-3 space-y-3 rounded-lg border border-teal-200 bg-teal-50/40 p-3 text-sm" dir="rtl" aria-label="تجهيز واجب وكويز الدرس">
      <p>اربط واجبًا وكويزًا من المقرر نفسه. الربط لا ينشر التقييم ولا يفتح محاولة للطالب؛ قواعد الجمهور والمواعيد والتقدم تبقى مستقلة.</p>
      {(['homework', 'quiz'] as const).map(kind => <LessonActivityEditor key={`${props.courseId}/${props.unitId}/${props.lessonId}/${kind}`} {...props} kind={kind} />)}
    </section> : null}
  </div>;
}
export function LessonActivityEditor({ courseId, unitId, lessonId, kind }: Target & { kind: ActivityKind }) {
  const [state, setState] = useState<ActivityEditorState>(initialActivityEditor), [selected, setSelected] = useState(''), [confirm, setConfirm] = useState(false);
  const ref = useRef<ReturnType<typeof createActivityEditor> | null>(null), formId = useId(), label = kind === 'homework' ? 'الواجب' : 'الكويز';
  useEffect(() => {
    const controller = createActivityEditor(kind, {
      list: signal => listLessonActivities(courseId, unitId, lessonId, signal), options: (cursor, signal) => listLessonActivitySources(courseId, unitId, lessonId, kind, cursor, signal),
      attach: (id, signal) => attachLessonActivity(courseId, unitId, lessonId, kind, id, signal), detach: (id, signal) => detachLessonActivity(courseId, unitId, lessonId, kind, id, signal),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, subscribeSession: subscribeSessionChange,
    });
    ref.current = controller;
    const unsubscribe = controller.subscribe(value => { setState(value); if (value.phase === 'session-ended' || value.stale) { setSelected(''); setConfirm(false); } });
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage); void controller.refresh();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId, unitId, lessonId, kind]);
  const writable = state.phase === 'ready' && !state.stale && !state.busy;
  return <section className="space-y-2 rounded border bg-white p-3" aria-label={`ربط ${label}`}>
    <h4 className="font-semibold">{label}</h4>
    <div aria-live="polite">{state.busy ? <p>جارٍ التحقق والحفظ…</p> : null}{state.notice ? <p className="text-emerald-800">{state.notice}</p> : null}{state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}</div>
    <Button type="button" variant="outline" size="sm" disabled={state.busy || state.phase === 'session-ended'} onClick={() => { setSelected(''); setConfirm(false); void ref.current?.refresh(); }}>تحديث {label} ومصادره</Button>
    {state.phase === 'ready' && !state.stale ? state.current ? <>
      <p dir="auto">{state.current.title ?? 'المصدر لم يعد متاحًا'}</p>
      <p>{state.current.source_status === 'draft' ? 'مسودة — الربط لا ينشرها' : state.current.source_status === 'published' ? 'منشور — تظل قواعد التقييم الأصلية مطلوبة' : 'مرجع غير متاح؛ يمكنك فك الربط دون حذف المصدر'}</p>
      {state.current.audience === 'restricted' ? <p>الجمهور مقيد بمجموعة أو فرع؛ الربط لا يوسّع هذا الجمهور.</p> : null}
      {kind === 'quiz' ? <LessonQuizVersionManager key={state.current.content_id} courseId={courseId} unitId={unitId} lessonId={lessonId} contentId={state.current.content_id} /> : null}
      {!confirm ? <Button type="button" variant="outline" size="sm" disabled={!writable} onClick={() => setConfirm(true)}>فك ربط {label}</Button>
        : <div className="flex flex-wrap items-center gap-2"><span>فك المرجع فقط؟ سيبقى التقييم ومحاولاته محفوظين.</span><Button type="button" size="sm" disabled={!writable} onClick={async () => { if (await ref.current?.detach(state.current!.content_id)) setConfirm(false); }}>تأكيد فك الربط</Button><Button type="button" variant="outline" size="sm" disabled={state.busy} onClick={() => setConfirm(false)}>إلغاء</Button></div>}
    </> : <>
      <label htmlFor={formId}>مصدر {label} من المقرر</label>
      <select id={formId} className="w-full rounded border p-2" value={selected} disabled={!writable} onChange={event => setSelected(event.target.value)}>
        <option value="">اختر مصدرًا</option>{state.options.map(row => <option key={row.source_id} value={row.source_id}>{row.title} — {row.source_status === 'draft' ? 'مسودة' : 'منشور'}{row.audience === 'restricted' ? ' — جمهور مقيد' : ''}</option>)}
      </select>
      {!state.options.length ? <p>لا توجد مصادر مؤهلة في هذه الصفحة. جهّز التقييم في المقرر، ثم حدّث المصادر.</p> : null}
      {state.cursor ? <Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={() => { setSelected(''); void ref.current?.more(); }}>المصادر التالية</Button> : null}
      <Button type="button" size="sm" disabled={!writable || !state.options.some(row => row.source_id === selected)} onClick={async () => { if (await ref.current?.attach(selected)) setSelected(''); }}>ربط {label} بالدرس</Button>
    </> : null}
  </section>;
}
