import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { LessonPackageSources } from './LessonPackageSources';
import { createPreparation, initialPreparation, preparationReader, type PreparationIssue } from './lesson-preparation';
import { LessonLearningEvidence } from './LessonLearningEvidence';
const principal = () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } };
const issues: Record<PreparationIssue, { title: string; action: string }> = {
  source_unavailable: { title: 'مرجع غير متاح', action: 'راجع ربط المرجع ومصدره داخل إعداد الحصة قبل الاعتماد عليه.' },
  quiz_version_required: { title: 'نسخة الكويز تحتاج مراجعة', action: 'افتح إعداد الكويز واختر نسخة منشورة صراحة؛ الربط وحده لا يكفي.' },
  draft_source: { title: 'المصدر ما زال مسودة', action: 'راجع المحتوى وقرار نشره من محرره؛ الملخص لا ينشر شيئًا.' },
  restricted_audience: { title: 'المصدر له جمهور مقيد', action: 'راجع الجمهور الأصلي؛ وجوده في الحصة لا يوسع وصول الطلاب.' },
};
const kindLabel = { material: 'مادة', video: 'فيديو', homework: 'واجب', quiz: 'كويز', announcement: 'إعلان' };

export function LessonPreparation({ courseId }: { courseId: string }) {
  const [ended, setEnded] = useState(false);
  const onInvalidSession = useCallback(() => setEnded(true), []);
  if (ended) return <p role="alert">تغيرت الجلسة؛ أُخفي اختيار الحصة وملخصها. افتح المقرر من جديد.</p>;
  return <section dir="rtl" aria-label="تحضير المدرس" className="space-y-3 rounded border p-3 text-sm">
    <h4 className="font-semibold">تحضير مختصر قبل الحصة</h4>
    <p>اختر الحصة لمراجعة تجهيزها. الإشارات مبنية على المراجع الحالية فقط، ولا تحكم على قدرة الطالب أو نيته.</p>
    <LessonPackageSources courseId={courseId} destinationId="" renderSource={source =>
      <div key={source.unitId + source.lessonId} className="space-y-3"><LessonPreparationPanel courseId={courseId} unitId={source.unitId} lessonId={source.lessonId} onInvalidSession={onInvalidSession} />
        <LessonLearningEvidence courseId={courseId} unitId={source.unitId} lessonId={source.lessonId} onInvalidSession={onInvalidSession} /></div>} />
  </section>;
}

const ignoreSession = () => {};
export function LessonPreparationPanel({ courseId, unitId, lessonId, onInvalidSession = ignoreSession }: { courseId: string; unitId: string; lessonId: string; onInvalidSession?: () => void }) {
  const [state, setState] = useState(initialPreparation);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const ref = useRef<ReturnType<typeof createPreparation> | null>(null);
  useEffect(() => {
    const controller = createPreparation({ read: preparationReader(courseId, unitId, lessonId), readPrincipal: principal, subscribeSession: subscribeSessionChange });
    ref.current = controller;
    const unsubscribe = controller.subscribe(next => { setState(next); if (next.phase === 'session-ended') onInvalidSession(); });
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage);
    void controller.refresh();
    return () => { unsubscribe(); controller.dispose(); ref.current = null; window.removeEventListener('storage', storage); };
  }, [courseId, unitId, lessonId, onInvalidSession]);
  useEffect(() => { setNotes({}); }, [state.data]);
  if (state.phase === 'session-ended') return <p role="alert">تغيرت الجلسة؛ أُخفي ملخص التحضير. افتح المقرر من جديد.</p>;
  const data = state.data, busy = state.phase === 'loading';
  const signals = data?.items.filter(row => row.issue !== null) ?? [];
  const evidence = data?.items.find(row => row.binding_id === state.evidenceId);
  return <div className="space-y-3 rounded border p-3">
    <Button type="button" variant="outline" disabled={busy} onClick={() => { void ref.current?.refresh(); }}>تحديث ملخص التحضير</Button>
    {busy ? <p role="status">جارٍ التحقق من أدلة الحصة؛ أُخفي الملخص السابق.</p> : null}
    {state.phase === 'error' ? <p role="alert">تعذر التحقق من الأدلة الحالية. لم نعرض البيانات القديمة؛ حاول التحديث.</p> : null}
    {data ? <>
      <h5 className="font-semibold">{data.lesson.title}</h5>
      <p>تم الفحص: <time dateTime={data.checked_at}>{new Date(data.checked_at).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })} — القاهرة</time></p>
      <p>المراجع المربوطة: {data.items.length}. هذا عدد مراجع الحصة، وليس عدد الطلاب أو اكتمال التعلم.</p>
      {data.lesson.status === 'archived' || data.lesson.unit_status === 'archived' ? <p role="alert">الحصة أو الوحدة مؤرشفة؛ هذا الملخص لا يعيد إتاحتها.</p> : null}
      <p>التوقيت المسجل: {data.lesson.release_at ?? 'بلا توقيت'}. أهلية كل طالب والتسليم يحتاجان تحققًا منفصلًا.</p>
      <div className="rounded bg-muted p-2"><strong>المفاهيم الأكثر احتياجًا للمراجعة: لا يكفي الدليل.</strong><p>لم نربط هنا مفاهيم موثقة بنتائج أسئلة المجموعة خلال فترة محددة. كذلك لم تُحلل الأسئلة المتكررة أو الغياب أو الحالات الفردية.</p></div>
      <p>ترتيب الإشارات: توفر المصدر، ثم نسخة الكويز، ثم المسودة، ثم الجمهور المقيد. لكل مرجع إشارة واحدة بالأولوية السابقة. عدم وجود إشارة لا يعني أن التسليم أو التعلم جاهز.</p>
      {!data.items.length ? <p>لم تُربط مراجع بهذه الحصة. افتح إعداد الحصة لإضافة المحتوى المطلوب.</p> : !signals.length ? <p>لم تظهر مشاكل التجهيز المحددة في هذه القراءة. راجع المحتوى والتسليم بنفسك.</p> : null}
      <ul className="space-y-3">{signals.map(row => <li key={row.binding_id} className="rounded border p-2">
        <strong>{issues[row.issue!].title} — {row.title ?? 'مصدر غير متاح'}</strong>
        <p>{issues[row.issue!].action}</p>
        <Button type="button" variant="outline" onClick={() => { void ref.current?.openEvidence(row.binding_id); }}>فتح الدليل الحالي: {kindLabel[row.kind]}</Button>
        <label className="block">تصحيح أو ملاحظة منك<input className="block w-full rounded border p-2" maxLength={500} value={notes[row.binding_id] ?? ''} onChange={event => setNotes(old => ({ ...old, [row.binding_id]: event.target.value }))} /></label>
        <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => ref.current?.decide(row.binding_id, 'use', notes[row.binding_id] ?? '')}>مفيد للتحضير</Button>
          <Button type="button" variant="outline" onClick={() => ref.current?.decide(row.binding_id, 'dismiss', notes[row.binding_id] ?? '')}>استبعاد الإشارة</Button></div>
        {state.decisions[row.binding_id] ? <p role="status">{state.decisions[row.binding_id].choice === 'use' ? 'اخترت الاستفادة من الإشارة.' : 'استبعدت الإشارة من تحضيرك.'} {state.decisions[row.binding_id].note}</p> : null}
      </li>)}</ul>
      {evidence ? <aside aria-label="دليل التحضير الحالي" className="rounded border p-2">
        <h6 className="font-semibold">الدليل بعد قراءة جديدة: {evidence.title ?? 'المصدر غير متاح الآن'}</h6>
        <p>النوع: {kindLabel[evidence.kind]} — الحالة: {evidence.source_state} — الجمهور: {evidence.audience ?? 'غير مثبت'} — ترتيب المرجع: {evidence.display_order ?? 'لا ينطبق'} — نسخة الكويز: {evidence.quiz_version ?? 'لا ينطبق'}</p>
        <p>قد تختلف هذه القراءة عن السابقة. لا تتضمن رابط ملف أو إجابات أو بيانات طالب؛ أصل المحتوى يُراجع من إعداد الحصة.</p>
      </aside> : null}
      <p>اختياراتك وملاحظاتك مسودة في ذاكرة هذه اللوحة فقط، وتُمسح عند تحديث الأدلة أو تغيير الحصة أو الحساب. لا ترسل رسائل ولا تغير المحتوى، ولم نقس بعد مقدار الوقت الذي توفره.</p>
    </> : null}
  </div>;
}
