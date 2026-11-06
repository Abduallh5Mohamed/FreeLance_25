import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readLessonQuizVersion, listLessonQuizVersions, pinLessonQuizVersion, unpinLessonQuizVersion } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createQuizVersionEditor, initialQuizVersionState, type QuizVersionState } from './lesson-quiz-versions';
type Target = { courseId: string; unitId: string; lessonId: string; contentId: string };
export function LessonQuizVersionManager(props: Target) {
  const [open, setOpen] = useState(false);
  return <div className="mt-2 border-t pt-2"><Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق نسخة كويز الدرس' : 'اختيار نسخة كويز الدرس'}</Button>
    {open ? <LessonQuizVersionEditor key={props.contentId} {...props} /> : null}</div>;
}
export function LessonQuizVersionEditor({ courseId, unitId, lessonId, contentId }: Target) {
  const [state, setState] = useState<QuizVersionState>(initialQuizVersionState), [selected, setSelected] = useState(''), [confirm, setConfirm] = useState(false);
  const ref = useRef<ReturnType<typeof createQuizVersionEditor> | null>(null), fieldId = useId();
  useEffect(() => {
    const controller = createQuizVersionEditor(contentId, { read: signal => readLessonQuizVersion(courseId, unitId, lessonId, contentId, signal), versions: (cursor, signal) => listLessonQuizVersions(courseId, unitId, lessonId, contentId, cursor, signal), pin: (id, signal) => pinLessonQuizVersion(courseId, unitId, lessonId, contentId, id, signal), unpin: (id, signal) => unpinLessonQuizVersion(courseId, unitId, lessonId, contentId, id, signal), readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, subscribeSession: subscribeSessionChange });
    ref.current = controller; const unsubscribe = controller.subscribe(value => { setState(value); if (value.stale || value.phase === 'session-ended') { setSelected(''); setConfirm(false); } });
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage); void controller.refresh();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId, unitId, lessonId, contentId]);
  const writable = state.phase === 'ready' && !state.stale && !state.busy;
  return <section dir="rtl" aria-label="تثبيت نسخة كويز الدرس" className="mt-2 space-y-2 rounded border border-blue-200 bg-blue-50 p-3 text-sm">
    <p>اختر نسخة منشورة صراحةً. إضافة نسخة أحدث للامتحان لا تغيّر اختيار هذه الحصة. تثبيت النسخة لا يفتح محاولات الطالب حاليًا.</p>
    <div aria-live="polite">{state.busy ? <p>جارٍ التحقق والحفظ…</p> : null}{state.notice ? <p className="text-emerald-800">{state.notice}</p> : null}{state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}</div>
    <Button type="button" size="sm" variant="outline" disabled={state.busy || state.phase === 'session-ended'} onClick={() => { setSelected(''); setConfirm(false); void ref.current?.refresh(); }}>تحديث النسخة</Button>
    {state.phase === 'ready' && !state.stale ? state.pin ? <>
      <p>{state.pin.status === 'published' ? `النسخة المثبتة: ${state.pin.version_number}` : 'النسخة المثبتة لم تعد متاحة. لا يتم اختيار بديل تلقائيًا.'}</p>
      {!confirm ? <Button type="button" size="sm" variant="outline" disabled={!writable} onClick={() => setConfirm(true)}>فك تثبيت النسخة</Button> : <div className="flex flex-wrap items-center gap-2"><span>فك هذا الاختيار فقط مع إبقاء النسخة ومحاولاتها؟</span><Button type="button" size="sm" disabled={!writable} onClick={async () => { if (await ref.current?.unpin(state.pin!.exam_version_id)) setConfirm(false); }}>تأكيد فك التثبيت</Button><Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={() => setConfirm(false)}>إلغاء</Button></div>}
    </> : <>
      <label htmlFor={fieldId}>نسخة الامتحان المنشورة</label><select id={fieldId} value={selected} disabled={!writable} className="w-full rounded border p-2" onChange={event => setSelected(event.target.value)}><option value="">اختر نسخة</option>{state.versions.map(row => <option key={row.exam_version_id} value={row.exam_version_id}>نسخة {row.version_number}</option>)}</select>
      {!state.versions.length ? <p>لا توجد نسخ منشورة في هذه الصفحة. جهّز نسخة في إدارة الامتحانات ثم حدّث القائمة.</p> : null}
      {state.cursor ? <Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={() => { setSelected(''); void ref.current?.more(); }}>النسخ التالية</Button> : null}
      <Button type="button" size="sm" disabled={!writable || !state.versions.some(row => row.exam_version_id === selected)} onClick={async () => { if (await ref.current?.pin(selected)) setSelected(''); }}>تثبيت النسخة المختارة</Button>
    </> : null}
  </section>;
}
