import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listLessonContents, listLessonMaterialOptions, attachLessonMaterial, detachLessonMaterial } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createLessonContentsController, initialLessonContentsState, type LessonContentsState } from './lesson-contents';
import { OwnerMaterialPdfManager } from './OwnerMaterialPdfManager';

type Binding = { courseId: string; unitId: string; lessonId: string };
const types: Record<string, string> = { pdf: 'PDF', video: 'فيديو', presentation: 'عرض', link: 'رابط', other: 'ملف' };

/** Collapsed by default: rendering a lesson row never fetches its contents. */
export function LessonContentManager(props: Binding) {
  const [open, setOpen] = useState(false);
  return <div className="w-full border-t border-slate-100 pt-2">
    <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? 'إغلاق محتويات الدرس' : 'إدارة محتويات الدرس'}
    </Button>
    {open ? <LessonContentEditor key={`${props.courseId}/${props.unitId}/${props.lessonId}`} {...props} /> : null}
  </div>;
}

export function LessonContentEditor({ courseId, unitId, lessonId }: Binding) {
  const [state, setState] = useState<LessonContentsState>(initialLessonContentsState);
  const [selected, setSelected] = useState('');
  const [position, setPosition] = useState('0');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const controllerRef = useRef<ReturnType<typeof createLessonContentsController> | null>(null);
  const formId = useId();
  useEffect(() => {
    const controller = createLessonContentsController({
      list: () => listLessonContents(courseId, unitId, lessonId),
      options: cursor => listLessonMaterialOptions(courseId, unitId, lessonId, cursor),
      attach: input => attachLessonMaterial(courseId, unitId, lessonId, input),
      detach: id => detachLessonMaterial(courseId, unitId, lessonId, id),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } },
      subscribeSession: listener => subscribeSessionChange(listener),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(snapshot => {
      setState(snapshot);
      if (snapshot.phase === 'session-ended' || snapshot.phase === 'denied' || snapshot.phase === 'unavailable') {
        setSelected(''); setPosition('0'); setRemoveId(null);
      }
    });
    const storage = (event: StorageEvent) => {
      if (event.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(event.key)) controller.invalidate();
    };
    window.addEventListener('storage', storage);
    void controller.refresh();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); controllerRef.current = null; };
  }, [courseId, unitId, lessonId]);
  const attached = new Set(state.contents.map(row => row.material_id.toLowerCase()));
  const options = state.options.filter(row => !attached.has(row.material_id.toLowerCase()));
  const canWrite = state.phase === 'ready' && !state.busy && !state.stale;
  const selectedAvailable = options.some(row => row.material_id === selected);
  return <section dir="rtl" aria-label="مواد الدرس" className="mt-3 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
    <p className="text-sm font-medium">مواد الدرس{state.phase === 'ready' ? ` — ${state.contents.length} من 20` : ''}</p>
    <p className="text-xs text-slate-600">جهّز الدرس بمواد موجودة من نفس الكورس. الربط لا ينشر المادة ولا يفتحها للطالب تلقائيًا.</p>
    <div aria-live="polite" className="space-y-1 text-sm">
      {state.busy ? <p>جارٍ تنفيذ العملية…</p> : null}
      {state.notice ? <p className="text-emerald-700">{state.notice}</p> : null}
      {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
      {state.stale && state.contents.length > 0 ? <p className="text-amber-800">القائمة تحتاج تحديثًا قبل أي تعديل جديد.</p> : null}
    </div>
    <Button type="button" size="sm" variant="outline" disabled={state.busy || state.phase === 'session-ended'} onClick={() => { setSelected(''); setRemoveId(null); void controllerRef.current?.refresh(); }}>تحديث محتويات الدرس</Button>
    {state.phase === 'ready' ? <>
      {state.contents.length === 0 ? <p className="text-sm text-slate-500">لا توجد مواد مرتبطة بهذا الدرس بعد.</p> : <ol className="space-y-2">
        {state.contents.map(row => <li key={row.content_id} className="rounded border bg-white p-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words" dir="auto">{row.title} · {types[row.material_type]} · الموضع {row.display_order}</span>
            <Button type="button" size="sm" variant="outline" disabled={!canWrite} onClick={() => setRemoveId(row.content_id)}>فك الربط</Button>
          </div>
          {row.material_type === 'pdf' ? <OwnerMaterialPdfManager courseId={courseId} unitId={unitId} lessonId={lessonId} contentId={row.content_id} materialId={row.material_id} /> : null}
          {removeId === row.content_id ? <div className="mt-2 flex flex-wrap items-center gap-2">
            <span>فك ربط المادة من هذا الدرس؟ المادة الأصلية ستظل محفوظة.</span>
            <Button type="button" size="sm" disabled={!canWrite} onClick={async () => { if (await controllerRef.current?.detach(row.content_id)) setRemoveId(null); }}>تأكيد فك الربط</Button>
            <Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={() => setRemoveId(null)}>إلغاء</Button>
          </div> : null}
        </li>)}
      </ol>}
      <form className="space-y-2 border-t pt-3" onSubmit={async event => {
        event.preventDefault();
        if (await controllerRef.current?.attach(selected, position)) { setSelected(''); setRemoveId(null); }
      }}>
        <label className="block text-sm" htmlFor={`${formId}-material`}>اختر مادة من الكورس</label>
        <select id={`${formId}-material`} className="w-full min-w-0 rounded border bg-white p-2 text-sm" value={selectedAvailable ? selected : ''} disabled={!canWrite || state.contents.length >= 20} onChange={event => setSelected(event.target.value)}>
          <option value="">اختر المادة…</option>
          {options.map(row => <option key={row.material_id} value={row.material_id}>{row.title} — {types[row.material_type]}{row.is_published ? '' : ' — مسودة'}</option>)}
        </select>
        <p className="text-xs text-slate-500">تُعرض حتى 25 مادة في الصفحة. المواد المرتبطة بالفعل مخفية من الاختيارات.</p>
        {state.optionsError ? <p role="alert" className="text-sm text-amber-800">{state.optionsError}</p> : null}
        {!options.length && !state.busy && !state.optionsError ? <p className="text-sm">لا توجد مواد قابلة للإضافة في هذه الصفحة. أضف مواد للكورس من إدارة المحتوى أو افتح الصفحة التالية إن وجدت.</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={() => { setSelected(''); void controllerRef.current?.options(); }}>إعادة تحميل المواد من البداية</Button>
          <Button type="button" size="sm" variant="outline" disabled={state.busy || !state.nextCursor} onClick={() => { setSelected(''); void controllerRef.current?.options(true); }}>المواد التالية</Button>
        </div>
        <label className="block text-sm" htmlFor={`${formId}-order`}>موضع المادة داخل الدرس</label>
        <input id={`${formId}-order`} inputMode="numeric" className="w-full rounded border p-2 text-sm" dir="ltr" value={position} disabled={!canWrite} onChange={event => setPosition(event.target.value)} />
        <p className="text-xs text-slate-500">اكتب رقمًا صحيحًا غير مستخدم، يبدأ من صفر.</p>
        <Button type="submit" size="sm" disabled={!canWrite || !selectedAvailable || state.contents.length >= 20}>إضافة المادة للدرس</Button>
      </form>
    </> : null}
  </section>;
}
