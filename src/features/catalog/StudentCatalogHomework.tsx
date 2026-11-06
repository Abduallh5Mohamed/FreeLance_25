import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { catalogHomeworkTransport, transferHomeworkFile, type HomeworkReceipt } from './catalog-homework-api';
import { createCatalogHomework, homeworkKeyStore, homeworkPrincipalReader, initialHomeworkState, type HomeworkState } from './catalog-homework';
export const homeworkStatus = (row: HomeworkReceipt) => row.status === 'revoked' ? 'ملغى' : ({ pending_upload: 'بانتظار رفع الملف والتحقق منه', pending_scan: 'مستلم وبانتظار فحص موثوق', finalized: 'تم التحقق والفحص النظيف', quarantined: 'محجور؛ غير معتمد كملف نظيف' }[row.upload_status]);
export function StudentCatalogHomework({ courseId, lessonId, contentId }: {
    courseId: string;
    lessonId: string;
    contentId: string;
}) {
    const [state, setState] = useState<HomeworkState>(initialHomeworkState), [confirmCancel, setConfirmCancel] = useState(false);
    const ref = useRef<ReturnType<typeof createCatalogHomework> | null>(null);
    useEffect(() => {
        let store: ReturnType<typeof homeworkKeyStore> | null = null;
        const keyStore = () => store ?? (store = homeworkKeyStore(localStorage, sessionStorage, courseId, lessonId, contentId));
        const controller = createCatalogHomework(contentId, { ...catalogHomeworkTransport(courseId, lessonId, contentId),
            key: { read: () => keyStore().read(), save: key => keyStore().save(key), clear: key => keyStore().clear(key) }, makeKey: () => crypto.randomUUID(),
            readPrincipal: homeworkPrincipalReader(localStorage), subscribeSession: fn => subscribeSessionChange(fn),
            transfer: (auth, file, signal) => transferHomeworkFile(auth, file, signal, window.location.origin) });
        ref.current = controller;
        const unsubscribe = controller.subscribe(setState);
        const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace', 'currentStudent', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(e.key))
            controller.invalidate(); };
        window.addEventListener('storage', storage);
        void controller.load();
        return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
    }, [courseId, lessonId, contentId]);
    useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (state.fileName || ['busy', 'uncertain'].includes(state.phase)) {
        e.preventDefault();
        e.returnValue = '';
    } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [state.fileName, state.phase]);
    const editable = state.phase === 'ready', retryable = state.phase === 'uncertain' && state.retryable;
    const pending = state.selected && state.selected.status !== 'revoked' && state.selected.file_size_bytes === 0;
    return <section dir="rtl" aria-label="تسليم واجب الدرس" className="space-y-3 rounded-lg border border-blue-300 p-3">
    <p className="text-xs text-muted-foreground">كل نسخة تحمل ملفًا واحدًا. تجهيز الطلب ونقل الملف لا يعنيان اعتماد الفحص أو إتمام الدرس. الملف والإذن في ذاكرة الصفحة فقط؛ بعد إغلاقها اختر الملف مجددًا عند الحاجة.</p>
    <div aria-live="polite">{['busy', 'loading'].includes(state.phase) ? <p>جارٍ تنفيذ العملية؛ لا تُعد الإرسال…</p> : null}{state.message ? <p role="status">{state.message}</p> : null}</div>
    {state.policy ? <div className="space-y-1">
      <p>الأنواع المسموحة: {state.policy.allowed_file_types.join('، ')} — الحد الأقصى: {(state.policy.max_file_bytes / 1048576).toLocaleString('ar-EG')} ميجابايت.</p>
      {state.policy.deadline_at ? <p>الموعد بتوقيت جهازك: <time dateTime={state.policy.deadline_at}>{new Date(state.policy.deadline_at).toLocaleString('ar-EG')}</time>؛ قبول التأخير يحدده الخادم.</p> : null}
      {!state.policy.upload_configured ? <p className="text-amber-800">رفع الواجب غير مفعّل حاليًا. يمكنك قراءة حالته؛ لا يوجد إرسال بديل.</p> : null}
      {!state.policy.accepting ? <p>لا يُسمح بتجهيز نسخة جديدة حاليًا بحسب سياسة الواجب وحدود التسليم.</p> : null}
    </div> : null}
    {['ready', 'busy'].includes(state.phase) ? <>
      <ul aria-label="نسخ تسليمي" className="space-y-2">{state.history.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2 rounded border p-2"><span dir="auto">نسخة {row.version}: {row.file_name} — {homeworkStatus(row)}</span><Button type="button" size="sm" variant="outline" disabled={!editable} onClick={() => { setConfirmCancel(false); ref.current?.select(row.id); }}>اختيار النسخة {row.version}</Button></li>)}</ul>
      {state.selected ? <p>النسخة المختارة: {state.selected.version} — {homeworkStatus(state.selected)}.</p> : null}
    </> : null}
    {(editable || retryable) && state.policy?.upload_configured && (!state.selected || pending) ? <div className="space-y-2">
      <label className="block">اختر ملف الواجب<input key={state.selected?.id ?? 'new'} type="file" className="mt-1 block w-full" accept={state.policy.allowed_file_types.map(x => '.' + x).join(',')} onChange={e => ref.current?.choose(e.target.files?.[0] ?? null)}/></label>
      {state.fileName ? <p dir="auto">الملف المحدد: {state.fileName} ({state.fileSize?.toLocaleString('ar-EG')} بايت). لم يُعتمد محتواه بعد.</p> : null}
      {!state.selected ? <Button type="button" disabled={!state.fileName || !state.policy.accepting} onClick={() => { void ref.current?.create(); }}>{retryable ? 'إعادة طلب التجهيز بنفس المعرّف' : 'تجهيز تسليم الملف'}</Button> : null}
      {editable && pending ? <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => { void ref.current?.authorize(); }}>تجديد إذن رفع هذه النسخة</Button>
        <Button type="button" disabled={!state.fileName || !state.authorized} onClick={() => { void ref.current?.upload(); }}>رفع الملف المحدد</Button>
      </div> : null}
      <p className="text-xs text-muted-foreground">إعادة الرفع تستبدل محتوى النسخة غير المثبتة. عند انقطاع الاتصال افحص الملف الموجود على الخادم قبل اختيار إعادة الرفع.</p>
    </div> : null}
    {editable && pending && state.policy?.upload_configured ? <div className="space-y-2">
      <Button type="button" onClick={() => { void ref.current?.finalize(); }}>التحقق من الملف الموجود وفحصه</Button>
      <label className="flex gap-2"><input type="checkbox" checked={confirmCancel} onChange={e => setConfirmCancel(e.target.checked)}/>أريد إلغاء هذه النسخة غير المثبتة</label>
      <Button type="button" variant="outline" disabled={!confirmCancel} onClick={() => { setConfirmCancel(false); void ref.current?.cancel(); }}>تأكيد إلغاء النسخة</Button>
    </div> : null}
    {editable && state.selected && (state.selected.status === 'revoked' || state.selected.file_size_bytes > 0) ? <Button type="button" variant="outline" onClick={() => { setConfirmCancel(false); void ref.current?.newVersion(); }}>مراجعة السماح بتجهيز نسخة جديدة</Button> : null}
    {!['busy', 'loading', 'denied', 'session-ended'].includes(state.phase) ? <Button type="button" variant="outline" onClick={() => { setConfirmCancel(false); void ref.current?.load(); }}>فحص الحالة المحفوظة على الخادم</Button> : null}
  </section>;
}
