import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getOwnerMaterialFileStatus, uploadOwnerMaterialPdf, revokeOwnerMaterialPdf } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createOwnerPdfController, initialOwnerPdfState, type OwnerPdfState } from './material-pdf-upload';
type Target = { courseId: string; unitId: string; lessonId: string; contentId: string; materialId: string };
export function OwnerMaterialPdfManager(props: Target) {
  const [open, setOpen] = useState(false);
  return <div className="mt-2 border-t pt-2">
    <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'إغلاق لوحة PDF' : 'إدارة ملف PDF الخاص'}</Button>
    {open ? <OwnerMaterialPdfEditor key={`${props.courseId}/${props.unitId}/${props.lessonId}/${props.contentId}/${props.materialId}`} {...props} /> : null}
  </div>;
}
export function OwnerMaterialPdfEditor({ courseId, unitId, lessonId, contentId, materialId }: Target) {
  const [state, setState] = useState<OwnerPdfState>(initialOwnerPdfState);
  const [file, setFile] = useState<File | null>(null);
  const ref = useRef<ReturnType<typeof createOwnerPdfController> | null>(null), fieldId = useId();
  useEffect(() => {
    const controller = createOwnerPdfController(materialId, {
      status: signal => getOwnerMaterialFileStatus(courseId, unitId, lessonId, contentId, signal),
      upload: (payload, requestId, signal) => uploadOwnerMaterialPdf(courseId, unitId, lessonId, contentId, payload, requestId, signal),
      revoke: signal => revokeOwnerMaterialPdf(courseId, unitId, lessonId, contentId, signal),
      readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } },
      subscribeSession: fn => subscribeSessionChange(fn), makeRequestId: () => crypto.randomUUID(),
    });
    ref.current = controller;
    const unsubscribe = controller.subscribe(snapshot => { setState(snapshot); if (['denied','session-ended'].includes(snapshot.phase)) setFile(null); });
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession','supabaseUser'].includes(event.key)) controller.invalidate(); };
    window.addEventListener('storage', storage); void controller.load();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
  }, [courseId,unitId,lessonId,contentId,materialId]);
  const canUpload = state.phase === 'ready' && state.uploadConfigured && !state.busy && !state.uncertain
    && (!state.file || state.retryable && state.file.upload_status !== 'complete' && state.file.source_status === 'active'
      && (state.file.upload_status !== 'stored' || state.scanConfigured));
  return <section dir="rtl" aria-label="رفع ملف PDF خاص" className="mt-2 space-y-2 rounded border border-indigo-200 bg-indigo-50/40 p-3 text-sm">
    <p className="font-medium">مصدر PDF الخاص بالمادة</p>
    <p className="text-xs text-slate-600">رفع مصدر أول فقط، حتى 10 ميجابايت. لا يُنشر أو يُسلّم للطالب تلقائيًا، واستبدال مصدر مسجل له مسار مستقل.</p>
    <div aria-live="polite">
      {state.busy ? <p>جارٍ تنفيذ العملية…</p> : null}
      {state.notice ? <p className="text-emerald-700">{state.notice}</p> : null}
      {state.error ? <p role="alert" className="text-red-700">{state.error}</p> : null}
    </div>
    {state.file ? <p>حالة الملف: {state.file.source_status === 'revoked' ? 'مسحوب' : state.file.scan_status === 'rejected' ? 'مرفوض بالفحص'
      : state.file.scan_status === 'clean' ? 'نتيجة فحص مسجلة' : state.file.upload_status === 'reserved' ? 'المحاولة مسجلة؛ التخزين لم يُؤكَّد بعد' : 'محفوظ وبانتظار الفحص'}</p> : null}
    {state.phase === 'ready' && state.file?.source_status === 'active' ? <Button type="button" size="sm" variant="destructive"
      disabled={state.busy || state.uncertain} onClick={() => {
        if (window.confirm('سحب مصدر PDF يمنع تنزيله للطلاب ولن يعيد إتاحته تلقائيًا. هل تريد المتابعة؟')) void ref.current?.revoke();
      }}>سحب إتاحة ملف PDF</Button> : null}
    <Button type="button" size="sm" variant="outline" disabled={state.busy || state.phase === 'session-ended'} onClick={() => { void ref.current?.load(); }}>تحديث حالة ملف PDF</Button>
    {state.phase === 'ready' && !state.uploadConfigured ? <p className="text-amber-800">رفع الملفات الخاصة غير مهيأ حاليًا في هذه البيئة.</p> : null}
    {state.phase === 'ready' && state.uploadConfigured ? <form className="space-y-2" onSubmit={async event => {
      event.preventDefault(); if (await ref.current?.upload(file) && ref.current?.getState().file?.upload_status === 'complete') setFile(null);
    }}>
      {!state.scanConfigured ? <p className="text-amber-800">الفحص غير مهيأ؛ يمكن حفظ الملف وسيظل بانتظار الفحص وغير متاح للطلاب.</p> : null}
      {state.retryable && state.file?.upload_status !== 'complete' ? <p>للاستكمال اختر ملف المحاولة الأصلية نفسه؛ لن تُنشأ نسخة بديلة.</p> : null}
      <label htmlFor={fieldId} className="block">اختيار ملف PDF</label>
      <input id={fieldId} type="file" accept="application/pdf,.pdf" disabled={!canUpload} className="block w-full min-w-0 rounded border bg-white p-2 text-xs" onChange={event => setFile(event.target.files?.[0] ?? null)} />
      <Button type="submit" size="sm" disabled={!canUpload || !file}>{state.retryable ? 'استكمال المحاولة بنفس الملف' : 'رفع ملف PDF'}</Button>
    </form> : null}
  </section>;
}
