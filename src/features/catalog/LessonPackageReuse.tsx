import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import type { PackageComparisonRow } from './lesson-package-preview';
import { createPackageReuse, initialPackageReuse, packageReuseTransport, type PackageReuseState, type ReuseSelection } from './lesson-package-reuse';
const labels = { material: 'مادة', video: 'فيديو', homework: 'واجب', quiz: 'كويز', announcement: 'إعلان' };
const conflicts: Record<string, string> = { source_unavailable: 'المصدر غير متاح للربط', different_position: 'المرجع موجود في موضع مختلف', position_occupied: 'الموضع مشغول', slot_occupied: 'الخانة مشغولة بمصدر آخر', capacity: 'تجاوز حد المواد والفيديوهات' };
export function LessonPackageReuse({ courseId, unitId, lessonId, sourceLessonId, choices, onLockChange }: {
    courseId: string;
    unitId: string;
    lessonId: string;
    sourceLessonId: string;
    choices: PackageComparisonRow[];
    onLockChange?:(locked:boolean)=>void;
}) {
    const [state, setState] = useState<PackageReuseState>(initialPackageReuse), [selected, setSelected] = useState<ReuseSelection[]>([]), [confirmed, setConfirmed] = useState(false);
    const ref = useRef<ReturnType<typeof createPackageReuse> | null>(null);
    useEffect(() => {
        const controller = createPackageReuse({ ...packageReuseTransport(courseId, unitId, lessonId, sourceLessonId), newOperationId: () => crypto.randomUUID(),
            readPrincipal: () => { try {
                return readCourseSessionPrincipal(localStorage);
            }
            catch {
                return null;
            } }, subscribeSession: subscribeSessionChange });
        ref.current = controller;
        const unsubscribe = controller.subscribe(value=>{setState(value);onLockChange?.(['applying','recovering','uncertain'].includes(value.phase));});
        const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key))
            controller.invalidate(); };
        window.addEventListener('storage', storage);
        return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; onLockChange?.(false); };
    }, [courseId, unitId, lessonId, sourceLessonId, onLockChange]);
    const busy = ['reviewing', 'applying', 'recovering'].includes(state.phase), frozen = busy || state.phase === 'uncertain' || state.phase === 'session-ended';
    return <section aria-label="نسخ مراجع الحصة بعد مراجعة الخادم" className="space-y-3 rounded border border-amber-300 bg-amber-50 p-3">
    <h4 className="font-semibold">إعادة استخدام المراجع المختارة</h4>
    <p>اختر المراجع، ثم راجع النتيجة الحالية من الخادم. الجمهور يظل جمهور المصدر؛ راجع مجموعاته في إعداد الواجب أو الكويز أو الإعلان. لا يُنسخ المحتوى نفسه أو نشر الإعلان أو نسخة الكويز أو أي سجل طالب.</p>
    <div className="space-y-1">{choices.map(row => {
            const checked = selected.some(value => value.kind === row.kind && value.source_id === row.sourceId);
            return <label className="flex gap-2" key={row.kind + '/' + row.sourceId}><input type="checkbox" checked={checked} disabled={frozen} onChange={e => {
                    ref.current?.clear();
                    setConfirmed(false);
                    setSelected(current => e.target.checked ? [...current, { kind: row.kind, source_id: row.sourceId }] : current.filter(value => !(value.kind === row.kind && value.source_id === row.sourceId)));
                }}/><span dir="auto">{labels[row.kind]}: {row.title ?? 'مصدر غير متاح'}</span></label>;
        })}</div>
    <Button type="button" disabled={frozen || !selected.length} onClick={() => { setConfirmed(false); void ref.current?.review(selected); }}>مراجعة المراجع المختارة على الخادم</Button>
    <div aria-live="polite">{busy ? <p role="status">{state.phase === 'applying' ? 'جارٍ حفظ المراجع المختارة…' : state.phase === 'recovering' ? 'جارٍ قراءة سجل العملية…' : 'جارٍ التحقق من المراجع الحالية…'}</p> : null}
      {state.phase === 'error' ? <p role="alert">لم يتم تأكيد النسخ. حدّث المراجعة؛ قد تكون البيانات أو الصلاحيات أو المخطط غير متاحة.</p> : null}
      {state.phase === 'session-ended' ? <p role="alert">تغيرت الجلسة وأُخفيت التفاصيل. افتح إدارة الحصص من جديد.</p> : null}
      {state.result ? <p role="status">الحفظ مؤكد: أُضيف {state.result.created} مرجعًا، وكان {state.result.existing} موجودًا بالفعل. حدّث أقسام الحصة والمقارنة لقراءة الحالة الحالية؛ نسخة الكويز ونشر الإعلان يحتاجان إجراءً منفصلًا.</p> : null}
    </div>
    {state.review ? <article className="space-y-2 rounded border bg-white p-2" aria-label="المراجعة الخادمية الحالية">
      <p>عدد المواد والفيديوهات بعد الإضافة: {state.review.projected_media_count} من ٢٠.</p>
      <ul>{state.review.items.map(row => <li key={row.kind + '/' + row.source_id} dir="auto">{labels[row.kind]}: {row.title ?? 'مصدر غير متاح'} — {row.outcome === 'add' ? 'إضافة مرجع' : row.outcome === 'present' ? 'موجود بالفعل' : conflicts[row.conflict ?? ''] ?? 'تعارض'}{row.display_order === null ? '' : ` — الموضع ${row.display_order}`} — {row.audience === 'restricted' ? 'جمهور المصدر مقيد بالمجموعات' : row.audience === 'course' ? 'جمهور المقرر وفق شروط المصدر' : 'جمهور غير متحقق'}{row.source_state === 'draft' ? ' — مسودة' : ''}</li>)}</ul>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={frozen || !state.review.can_apply} onChange={e => setConfirmed(e.target.checked)}/>راجعت المصادر والجمهور والمواضع؛ أوافق على إضافة المراجع فقط دون نشر أو توسيع صلاحيات أو إعادة محاولات.</label>
      <Button type="button" disabled={state.phase !== 'reviewed' || !state.review.can_apply || !confirmed} onClick={() => { setConfirmed(false); void ref.current?.apply(confirmed); }}>تأكيد نسخ المراجع التي تمت مراجعتها</Button>
    </article> : null}
    {state.operationId ? <p dir="auto">رقم العملية: {state.operationId}</p> : null}
    {state.phase === 'uncertain' ? <><p role="alert">نتيجة الحفظ غير محسومة. لا تعاود النسخ؛ افحص سجل نفس العملية. غياب السجل في قراءة واحدة لا يؤكد إلغاء العملية.</p><Button type="button" onClick={() => { void ref.current?.recover(); }}>التحقق من نتيجة العملية دون إعادة الحفظ</Button></> : null}
    <p>إغلاق اللوحة أو قطع الاتصال لا يلغي عملية حفظ وصلت للخادم. بعد الحفظ راجع الأقسام مجددًا. حدود محاولات الامتحان والالتحاق وسجلا التقدم لا تتغير.</p>
  </section>;
}
