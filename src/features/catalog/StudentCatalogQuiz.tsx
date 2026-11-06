import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { catalogQuizTransport, createCatalogQuiz, initialQuizState, type QuizState } from './catalog-quiz';
export function StudentCatalogQuiz({ courseId, lessonId, contentId }: {
    courseId: string;
    lessonId: string;
    contentId: string;
}) {
    const [state, setState] = useState<QuizState>(initialQuizState);
    const [confirmed, setConfirmed] = useState(false);
    const ref = useRef<ReturnType<typeof createCatalogQuiz> | null>(null);
    useEffect(() => {
        const controller = createCatalogQuiz({ ...catalogQuizTransport(courseId, lessonId, contentId), readPrincipal: () => { try {
                return readCourseSessionPrincipal(localStorage);
            }
            catch {
                return null;
            } }, subscribeSession: fn => subscribeSessionChange(fn) });
        ref.current = controller;
        const unsubscribe = controller.subscribe(setState);
        const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudent', 'currentStudentSpace', 'student_session', 'offlineStudentSession', 'supabaseUser'].includes(e.key))
            controller.invalidate(); };
        window.addEventListener('storage', storage);
        void controller.recover();
        return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
    }, [courseId, lessonId, contentId]);
    useEffect(() => {
        if (state.phase !== 'ready' || !state.dirty || !state.autoSave || state.attempt?.status !== 'in_progress')
            return;
        const timer = setTimeout(() => { void ref.current?.save(); }, 2000);
        return () => clearTimeout(timer);
    }, [state.phase, state.dirty, state.autoSave, state.draft, state.attempt?.status]);
    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => { if (state.dirty || state.phase === 'busy' || state.phase === 'uncertain') {
            e.preventDefault();
            e.returnValue = '';
        } };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [state.dirty, state.phase]);
    const editable = state.phase === 'ready' && state.attempt?.status === 'in_progress';
    return <section dir="rtl" aria-label="حل كويز الدرس" className="space-y-3 rounded-lg border border-teal-300 p-3">
    <p className="text-xs text-muted-foreground">بدء المحاولة لا يسجّل إتمام الدرس. الوقت والقبول يحددهما الخادم. إغلاق التفاصيل يحذف التعديلات المحلية التي لم يُؤكد حفظها.</p>
    <div aria-live="polite">{['loading', 'busy'].includes(state.phase) ? <p>جارٍ التحقق من حالة الكويز…</p> : null}{state.message ? <p role="status">{state.message}</p> : null}</div>
    {state.phase === 'idle' ? <><p>البدء يشغّل وقت المحاولة ولا يعيد ضبط عدد المحاولات.</p><Button type="button" onClick={() => { void ref.current?.start(); }}>بدء محاولة الكويز</Button></> : null}
    {['ready', 'busy'].includes(state.phase) && state.attempt ? <>
      <p>الموعد المسجل على الخادم، معروض بتوقيت جهازك: <time dateTime={state.attempt.deadline_at}>{new Date(state.attempt.deadline_at).toLocaleString('ar-EG')}</time></p>
      {state.attempt.status === 'pending_review' ? <p>تم التسليم، والنتيجة بانتظار التصحيح اليدوي.</p> : state.attempt.status === 'expired' ? <p>انتهى وقت المحاولة. راجع حالتها المحفوظة.</p> : state.attempt.status === 'graded' ? <p>المحاولة مصححة.{state.attempt.score !== null ? ` الدرجة: ${state.attempt.score}` : ''}</p> : null}
      {state.attempt.questions.map(q => <fieldset key={q.id} disabled={!editable} className="space-y-2 rounded border p-3">
        <legend className="whitespace-pre-wrap" dir="auto">{q.position}. {q.question_text} ({q.points} درجة)</legend>
        {q.question_type === 'essay' ? <textarea aria-label={`إجابة السؤال ${q.position}`} rows={5} maxLength={10000} className="w-full rounded border p-2" value={typeof state.draft[q.id] === 'string' ? state.draft[q.id] as string : ''} onChange={e => ref.current?.edit(q.id, e.target.value)}/>
                    : (q.question_type === 'true_false' ? ['true', 'false'] : q.options).map((option, i) => <label key={i} className="flex items-start gap-2 whitespace-pre-wrap" dir="auto">
            <input type={q.question_type === 'multiple_choice' ? 'checkbox' : 'radio'} name={`quiz-${contentId}-${q.id}`} checked={q.question_type === 'multiple_choice' ? Array.isArray(state.draft[q.id]) && (state.draft[q.id] as string[]).includes(option) : state.draft[q.id] === option} onChange={e => { const previous = Array.isArray(state.draft[q.id]) ? state.draft[q.id] as string[] : []; ref.current?.edit(q.id, q.question_type === 'multiple_choice' ? (e.target.checked ? [...previous, option] : previous.filter(value => value !== option)) : option); }}/>
            {q.question_type === 'true_false' ? (option === 'true' ? 'صح' : 'خطأ') : option}
          </label>)}
        {editable ? <Button type="button" size="sm" variant="outline" onClick={() => ref.current?.edit(q.id, null)}>مسح الإجابة</Button> : null}
      </fieldset>)}
      {editable ? <div className="space-y-3">
        <p>{state.dirty ? 'توجد تعديلات غير مؤكدة الحفظ.' : 'الإجابات المعروضة مطابقة لآخر حالة مؤكدة.'} يتم الحفظ التلقائي بعد التعديل؛ أي نتيجة مجهولة توقف الإرسال الآلي.</p>
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={!state.dirty} onClick={() => { void ref.current?.save(); }}>حفظ الإجابات الآن</Button><Button type="button" variant="outline" disabled={!state.dirty} onClick={() => ref.current?.useServer()}>استخدام آخر إجابات مقروءة من الخادم</Button></div>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>راجعت الإجابات وأريد تسليم المحاولة نهائيًا</label>
        <Button type="button" disabled={!confirmed} onClick={() => { setConfirmed(false); void ref.current?.submit(); }}>تأكيد التسليم النهائي</Button>
      </div> : null}
    </> : null}
    {!['busy', 'loading', 'session-ended', 'denied'].includes(state.phase) ? <Button type="button" variant="outline" onClick={() => { setConfirmed(false); void ref.current?.recover(); }}>فحص الحالة المحفوظة على الخادم</Button> : null}
  </section>;
}
