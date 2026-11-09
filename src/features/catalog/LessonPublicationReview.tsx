import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readCourseSessionPrincipal } from './course-management';
import { subscribeSessionChange } from '@/lib/session-events';
import { LessonPackageSources } from './LessonPackageSources';
import { lessonPackageReader } from './lesson-package-preview';
import { createPublicationReview, initialPublicationReview } from './lesson-publication-review';

const labels = { material: 'مادة', video: 'فيديو', homework: 'واجب', quiz: 'كويز', announcement: 'إعلان' };
function SelectedReview({ courseId, unitId, lessonId }: { courseId: string; unitId: string; lessonId: string }) {
  const [state, setState] = useState(initialPublicationReview);
  const ref = useRef<ReturnType<typeof createPublicationReview> | null>(null);
  useEffect(() => {
    const controller = createPublicationReview({ read: signal => lessonPackageReader(courseId, unitId)(lessonId, signal),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, subscribeSession: subscribeSessionChange });
    ref.current = controller; const unsubscribe = controller.subscribe(setState);
    const changed = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key)) controller.invalidate(); };
    window.addEventListener('storage', changed); void controller.refresh();
    return () => { window.removeEventListener('storage', changed); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId, unitId, lessonId]);
  return <div aria-label="نتيجة مراجعة الحزمة" className="space-y-3 rounded border p-3" aria-live="polite">
    <Button type="button" variant="outline" disabled={state.phase === 'loading' || state.phase === 'session-ended'} onClick={() => { void ref.current?.refresh(); }}>تحديث مراجعة الحزمة</Button>
    {state.phase === 'loading' ? <p role="status">جارٍ قراءة مراجع الحصة الحالية…</p> : null}
    {state.phase === 'error' ? <p role="alert">تعذرت مراجعة الحزمة كاملة؛ أُزيلت النتيجة السابقة. أعد التحقق.</p> : null}
    {state.phase === 'session-ended' ? <p role="alert">تغيّرت الجلسة؛ أُخفيت مراجعة الحزمة.</p> : null}
    {state.phase === 'ready' ? <>
      <p>آخر قراءة: {state.checkedAt ? new Date(state.checkedAt).toLocaleString('ar-EG') : ''}. القراءات مستقلة؛ هذه ليست لقطة نشر ذرية أو محاكاة لصلاحيات طالب.</p>
      <p>{state.rows.filter(r => r.state === 'blocked').length} مراجع بها مانع معروف — {state.rows.filter(r => r.state === 'review').length} تحتاج مراجعة. لا تعني هذه الأعداد أن التسليم جاهز.</p>
      {!state.rows.length ? <p>الحصة بلا مراجع محتوى؛ لا تعتبرها حزمة مكتملة.</p> : <ul className="space-y-2">{state.rows.map((row, i) => <li key={i} className="rounded border p-3"><strong>{labels[row.kind]}: {row.title}</strong><p>{row.state === 'blocked' ? 'مانع معروف' : 'تحتاج مراجعة'}</p><ul>{row.notes.map(note => <li key={note}>{note}</li>)}</ul></li>)}</ul>}
    </> : null}
  </div>;
}
export function LessonPublicationReview({ courseId }: { courseId: string }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded border p-3" dir="rtl" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer font-semibold">مراجعة حزمة الحصة قبل النشر</summary>
    <p>اختر الحصة لمراجعة موادها وفيديوهاتها وواجبها وكويزها وإعلانها معًا. راجع توقيت الدرس وشرطه ونشر المقرر في إعداداتها، ثم اختبر وصول طالب مخول؛ هذه القراءة لا تنشر أو ترسل أو تمنح وصولًا.</p>
    {open ? <LessonPackageSources courseId={courseId} destinationId="" renderSource={source => <SelectedReview key={source.unitId + source.lessonId} courseId={courseId} unitId={source.unitId} lessonId={source.lessonId} />} /> : null}
  </details>;
}
