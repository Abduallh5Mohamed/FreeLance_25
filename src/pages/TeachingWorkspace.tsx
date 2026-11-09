import { useCallback, useEffect, useRef, useState } from 'react';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import { createTeachingChoices, teachingChoicesReader, type TeachingCourse, type TeachingLesson, type TeachingChoicesState } from '@/features/catalog/teaching-workspace';
import { LessonPreparationPanel } from '@/features/catalog/LessonPreparation';
import { LessonLearningEvidence } from '@/features/catalog/LessonLearningEvidence';
import { CourseReturnPlan } from '@/features/catalog/CourseReturnPlan';

function principal() { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }
function useChoices(courseId?: string) {
  const [state, setState] = useState<TeachingChoicesState<TeachingCourse | TeachingLesson>>({ phase: 'idle', page: null });
  const ref = useRef<ReturnType<typeof createTeachingChoices<TeachingCourse | TeachingLesson>> | null>(null);
  useEffect(() => {
    const c = createTeachingChoices({ read: teachingChoicesReader(courseId), readPrincipal: principal, subscribeSession: subscribeSessionChange });
    ref.current = c; const unsub = c.subscribe(setState); void c.load();
    return () => { unsub(); c.dispose(); ref.current = null; };
  }, [courseId]);
  return { state, load: (cursor = '') => { void ref.current?.load(cursor); } };
}
function ChoicesNotice({ phase }: { phase: string }) {
  return phase === 'loading' ? <p role="status">جارٍ التحقق من الاختيارات الحالية.</p> : phase === 'error' ? <p role="alert">تعذر إثبات الاختيارات الحالية. أُخفيت القائمة السابقة؛ حاول التحديث.</p> : phase === 'session-ended' ? <p role="alert">تغيرت الجلسة. افتح المساحة من جديد.</p> : null;
}
function TeachingCourseWork({ courseId, locked, onLockChange, endSession }: { courseId: string; locked: boolean; onLockChange(locked: boolean): void; endSession(): void }) {
  const { state, load } = useChoices(courseId), [lesson, setLesson] = useState<TeachingLesson | null>(null);
  const choosePage = (cursor = '') => { if (!locked) { setLesson(null); load(cursor); } };
  return <div className="space-y-5">
    <section aria-label="تحضير الحصة" className="space-y-3 rounded border p-4">
      <h2 className="text-xl font-semibold">١ — جهّز حصتك</h2>
      <p>اختر حصة نشطة من مقرر أنت المدرس المسؤول عنه. تظهر المصادر والوسوم بأدلتها؛ لا نستنتج ضعف طالب أو فهمه من المشاهدة.</p>
      <ChoicesNotice phase={state.phase} />
      <label className="block">الحصة<select className="block w-full rounded border p-2" disabled={locked || state.phase !== 'ready'} value={lesson?.id ?? ''} onChange={e => setLesson((state.page?.items as TeachingLesson[]).find(l => l.id === e.target.value) ?? null)}><option value="">اختر الحصة</option>{(state.page?.items as TeachingLesson[] | undefined)?.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}</select></label>
      <div className="flex gap-2"><Button variant="outline" disabled={locked || state.phase === 'loading'} onClick={() => choosePage()}>تحديث وأول صفحة حصص</Button><Button variant="outline" disabled={locked || !state.page?.next_cursor} onClick={() => choosePage(state.page!.next_cursor!)}>الحصص التالية</Button></div>
      {state.phase === 'ready' && !state.page?.items.length ? <p>لا توجد حصص نشطة في هذه الصفحة. إعداد المحتوى لا يتم من مساحة التحضير.</p> : null}
      {lesson ? <div key={lesson.id} className="space-y-3"><LessonPreparationPanel courseId={courseId} unitId={lesson.unit_id} lessonId={lesson.id} onInvalidSession={endSession} /><LessonLearningEvidence courseId={courseId} unitId={lesson.unit_id} lessonId={lesson.id} onInvalidSession={endSession} /></div> : null}
    </section>
    <section className="space-y-3 rounded border p-4"><h2 className="text-xl font-semibold">٢ — راجع رجوع الطالب</h2><CourseReturnPlan courseId={courseId} onLockChange={onLockChange} /></section>
    <section className="space-y-2 rounded border p-4"><h2 className="text-xl font-semibold">٣ — الاستعداد للموسم التالي</h2><p>إعادة استخدام إعدادات المقرر وقوالبه تتم من إدارة مقررات المؤسسة بعد معاينة وتأكيد مستقلين. مسؤولية التدريس لا تمنح ملكية المحتوى أو حق نسخ الطلاب أو الرسوم أو الصلاحيات.</p></section>
  </div>;
}
export default function TeachingWorkspace() {
  const { state, load } = useChoices(), [course, setCourse] = useState<TeachingCourse | null>(null), [locked, setLocked] = useState(false), [ended, setEnded] = useState(false);
  const endSession = useCallback(() => setEnded(true), []), onLockChange = useCallback((value: boolean) => setLocked(value), []);
  useEffect(() => {
    const unsub = subscribeSessionChange(endSession);
    const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key)) endSession(); };
    window.addEventListener('storage', storage); return () => { unsub(); window.removeEventListener('storage', storage); };
  }, [endSession]);
  const choosePage = (cursor = '') => { if (!locked) { setCourse(null); load(cursor); } };
  return <><Header /><main dir="rtl" className="mx-auto min-w-0 max-w-5xl space-y-5 break-words p-5 [&_.flex]:flex-wrap [&_input]:max-w-full [&_select]:min-w-0 [&_select]:max-w-full">
    <h1 className="text-2xl font-bold">مساحة عمل المدرس</h1>
    {ended || state.phase === 'session-ended' ? <p role="alert">تغيرت الجلسة؛ أُخفيت المقررات وأدلة الطلاب. افتح الصفحة من جديد.</p> : <>
      <p>التحضير وخطة الرجوع لمقرراتك الحالية، دون صلاحيات إدارة تبويب أو تشغيل السنتر. كل قراءة وحفظ يعيدان التحقق من مسؤوليتك في الخادم.</p>
      {locked ? <p role="alert">نتيجة حفظ خطة الرجوع قيد التحقق. تغيير المقرر والحصة مقفول حتى إثبات النتيجة؛ لا تكرر الحفظ.</p> : null}
      <ChoicesNotice phase={state.phase} />
      <label className="block">المقرر<select aria-label="المقرر" className="block w-full rounded border p-2" disabled={locked || state.phase !== 'ready'} value={course?.id ?? ''} onChange={e => setCourse((state.page?.items as TeachingCourse[]).find(c => c.id === e.target.value) ?? null)}><option value="">اختر مقررك</option>{(state.page?.items as TeachingCourse[] | undefined)?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <div className="flex gap-2"><Button variant="outline" disabled={locked || state.phase === 'loading'} onClick={() => choosePage()}>تحديث وأول صفحة مقررات</Button><Button variant="outline" disabled={locked || !state.page?.next_cursor} onClick={() => choosePage(state.page!.next_cursor!)}>المقررات التالية</Button></div>
      {state.phase === 'ready' && !state.page?.items.length ? <p>لا توجد مقررات نشطة مسندة لك في هذه الصفحة. عضوية المؤسسة وحدها لا تمنحك مقرراتها.</p> : null}
      {course ? <div key={course.id} className="space-y-4"><h2 className="text-xl font-semibold">{course.name}</h2><TeachingCourseWork courseId={course.id} locked={locked} onLockChange={onLockChange} endSession={endSession} /></div> : null}
    </>}
  </main></>;
}
