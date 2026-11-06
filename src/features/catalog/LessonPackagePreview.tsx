import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createPackagePreview, initialPackagePreview, lessonPackageReader, type PackageIssue, type PackageKind, type PackagePreviewState } from './lesson-package-preview';
import { LessonPackageReuse } from './LessonPackageReuse';
import { LessonPackageSources } from './LessonPackageSources';

type Props = { courseId: string; unitId: string; lessonId: string; sources: { id: string; title: string }[];
  sourceUnitId?:string; selectedSourceId?:string; onReuseLockChange?:(locked:boolean)=>void };
const kinds: Record<PackageKind, string> = { material: 'مادة', video: 'فيديو', homework: 'واجب', quiz: 'كويز', announcement: 'إعلان' };
const issues: Record<PackageIssue, string> = {
  position: 'الموضع مشغول بمحتوى آخر', 'different-position': 'نفس المرجع موجود في موضع مختلف', occupied: 'الخانة مرتبطة بمصدر آخر',
  unavailable: 'المصدر أو نسخة الكويز غير جاهزة', capacity: 'تجاوز حد ٢٠ مادة وفيديو معًا',
  'restricted-audience': 'الجمهور مقيد بالمجموعات الأصلية؛ يلزم مراجعة الجمهور', draft: 'المصدر مسودة',
  'version-review': 'نسخة الكويز تحتاج اختيارًا صريحًا؛ لا تتجدد محاولات الطالب بإعادة استخدام الامتحان',
  'different-version': 'نسخة الكويز مختلفة في الوجهة', 'publication-review': 'نشر الإعلان لا يُنسخ؛ يلزم معاينة ونشر منفصلان للوجهة',
  'readiness-unverified': 'وجود المرجع لا يثبت جاهزية الملف أو التشغيل أو صلاحية الطالب',
};
export function LessonPackagePreview(props: Props) {
  const [open, setOpen] = useState(false);
  return <div className="w-full border-t pt-2"><Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>معاينة إعادة استخدام حزمة حصة</Button>
    {open ? <LessonPackageSources key={`${props.courseId}/${props.unitId}/${props.lessonId}`} courseId={props.courseId} destinationId={props.lessonId}
      renderSource={(source,onLockChange)=><LessonPackagePreviewEditor key={`${props.courseId}/${props.unitId}/${props.lessonId}/${source.unitId}/${source.lessonId}`} {...props}
        sourceUnitId={source.unitId} selectedSourceId={source.lessonId} sources={[{id:source.lessonId,title:source.title}]} onReuseLockChange={onLockChange}/>}/> : null}
  </div>;
}
export function LessonPackagePreviewEditor({ courseId, unitId, lessonId, sources, sourceUnitId=unitId, selectedSourceId, onReuseLockChange }: Props) {
  const [state, setState] = useState<PackagePreviewState>(initialPackagePreview);
  const [selected, setSelected] = useState(selectedSourceId??'');
  const [reuseLocked,setReuseLocked]=useState(false);
  const onLockChange=useCallback((locked:boolean)=>{setReuseLocked(locked);onReuseLockChange?.(locked);},[onReuseLockChange]);
  const ref = useRef<ReturnType<typeof createPackagePreview> | null>(null);
  const sourceKey = sources.map(row => row.id).join(',');
  useEffect(() => {
    const controller = createPackagePreview({ destinationId: lessonId, sourceIds: sourceKey.split(','), read: lessonPackageReader(courseId, unitId),
      readSource:lessonPackageReader(courseId,sourceUnitId),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, subscribeSession: subscribeSessionChange });
    ref.current = controller;
    const unsubscribe = controller.subscribe(setState);
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage);
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId, unitId, lessonId, sourceUnitId, sourceKey]);
  const result = state.result, current = state.sourceId === selected;
  return <section dir="rtl" className="mt-3 space-y-3 rounded border border-teal-200 bg-teal-50/30 p-3 text-sm" aria-label="معاينة مقارنة حزمة الحصة">
    <p>المصدر والوجهة داخل نفس المقرر، ويمكن أن يكونا في وحدتين مختلفتين. هذه مقارنة إرشادية بقراءات منفصلة، وقد تتغير البيانات بعدها.</p>
    {selectedSourceId?<p dir="auto">الحصة المصدر: {sources.find(row=>row.id===selectedSourceId)?.title}</p>:<label>الحصة المصدر<select className="block w-full rounded border p-2" value={selected} disabled={reuseLocked||state.phase === 'session-ended'} onChange={event => { setSelected(event.target.value); ref.current?.clear(); }}>
      <option value="">اختر حصة</option>{sources.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
    </select></label>}
    {!sources.length ? <p>لا توجد حصة أخرى في الصفحة الحالية للمقارنة.</p> : null}
    <Button type="button" disabled={reuseLocked||!selected || state.phase === 'loading' || state.phase === 'session-ended'} onClick={() => { if(!reuseLocked)void ref.current?.preview(selected); }}>مقارنة الحزمة مع هذه الحصة</Button>
    <div aria-live="polite">{state.phase === 'loading' ? <p role="status">جارٍ قراءة مراجع الحصتين…</p> : null}
      {state.phase === 'error' ? <p role="alert">تعذر التحقق من الحزمتين بالكامل. لا توجد نتيجة مكتملة؛ حدّث المقارنة بعد التحقق من الصلاحيات والمخطط.</p> : null}
      {state.phase === 'session-ended' ? <p role="alert">تغيرت الجلسة؛ أُخفيت المقارنة. افتح الحصص من جديد.</p> : null}</div>
    {current && result ? <>
      <p>المواد والفيديوهات في الوجهة: {result.destinationCount} من ٢٠. العدد المقترح مع المراجع الجديدة: {result.proposedCount}. لا تُستبدل المواضع المشغولة.</p>
      {result.destinationNeedsRepair ? <p role="alert">توجد مراجع غير جاهزة في الوجهة؛ راجعها قبل إعادة الاستخدام.</p> : null}
      {!result.rows.length ? <p>حزمة المصدر فارغة؛ لا توجد مراجع للمقارنة.</p> : null}
      <ul className="space-y-2">{result.rows.map(row => <li className="rounded border bg-white p-2" key={`${row.kind}/${row.sourceId}`}>
        <p dir="auto">{kinds[row.kind]}: {row.title ?? 'مصدر غير متاح'}{row.order === null ? '' : ` — الموضع ${row.order}`} — {row.status === 'conflict' ? 'تعارض يحتاج معالجة' : row.status === 'present' ? 'المرجع موجود بالفعل' : 'مرشح للمراجعة قبل الربط'}</p>
        {row.issues.length ? <ul className="list-inside list-disc">{row.issues.map(issue => <li key={issue}>{issues[issue]}</li>)}</ul> : null}
      </li>)}</ul>
      {result.rows.some(row => row.kind === 'quiz') ? <p>نسخة المصدر: {result.sourceVersion ?? 'غير مثبتة أو غير متاحة'}؛ نسخة الوجهة: {result.destinationVersion ?? 'غير مثبتة أو غير متاحة'}.</p> : null}
      {result.rows.length && state.sourceId ? <LessonPackageReuse key={`${courseId}/${unitId}/${lessonId}/${sourceUnitId}/${state.sourceId}`} courseId={courseId} unitId={unitId} lessonId={lessonId} sourceLessonId={state.sourceId} choices={result.rows} onLockChange={onLockChange} /> : null}
    </> : null}
    <p>المعاينة لا تنسخ شيئًا ولا تنشر إعلانًا. النسخ يتم فقط من قسم المراجع المختارة بعد مراجعة الخادم والتأكيد. لا يُنسخ تقدم أو محاولات أو تسليمات أو صلاحيات أو مواعيد أو شروط سابقة، ولا تُصفّر حدود الامتحان والالتحاق.</p>
  </section>;
}
