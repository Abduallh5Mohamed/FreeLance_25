import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createLessonLearning, initialLearning, lessonLearningTransport } from './lesson-learning';
const ignoreSession=()=>{};
export function LessonLearningEvidence({courseId,unitId,lessonId,onInvalidSession=ignoreSession}:{courseId:string;unitId:string;lessonId:string;onInvalidSession?:()=>void}){
  const [state,setState]=useState(initialLearning);
  const ref=useRef<ReturnType<typeof createLessonLearning>|null>(null);
  useEffect(()=>{
    const controller=createLessonLearning({...lessonLearningTransport(courseId,unitId,lessonId),readPrincipal:()=>{try{return readCourseSessionPrincipal(localStorage);}catch{return null;}},subscribeSession:subscribeSessionChange,
      copyText:async text=>{if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');await navigator.clipboard.writeText(text);}});
    ref.current=controller;const unsubscribe=controller.subscribe(value=>{setState(value);if(value.phase==='session-ended')onInvalidSession();});
    const storage=(event:StorageEvent)=>{if(event.key===null||['authToken','currentUser','currentStudentSpace'].includes(event.key))controller.invalidate();};
    window.addEventListener('storage',storage);void controller.first();
    return()=>{unsubscribe();controller.dispose();ref.current=null;window.removeEventListener('storage',storage);};
  },[courseId,unitId,lessonId,onInvalidSession]);
  if(state.phase==='session-ended')return <p role="alert">تغيرت الجلسة؛ أُخفيت أدلة التعلم.</p>;
  const busy=state.phase==='loading',data=state.data;
  const change=(group=state.groupId,from=state.from,to=state.to)=>ref.current?.change(group,from,to);
  return <section dir="rtl" aria-label="أدلة مراجعة المجموعة" className="space-y-3 rounded border p-3 text-sm">
    <h5 className="font-semibold">وسوم مقترحة للمراجعة من الكويز</h5>
    <p>المجموعة حسب عضوية الطلاب الحالية، والفترة حسب وقت تسليم المحاولة بتوقيت UTC. تُحسب النسخة المنشورة المثبتة حاليًا لهذه الحصة فقط؛ لا نجمع النسخ القديمة أو المحاولات العامة.</p>
    <label className="block">المجموعة<select value={state.groupId} disabled={busy} onChange={e=>change(e.target.value)} className="block w-full rounded border p-2"><option value="">اختر مجموعة من الصفحة الحالية</option>{state.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
    <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={()=>{void ref.current?.first();}}>أول صفحة مجموعات</Button><Button type="button" variant="outline" disabled={busy||!state.nextCursor} onClick={()=>{void ref.current?.next();}}>المجموعات التالية</Button></div>
    <label className="block">من يوم UTC (مشمول)<input type="date" disabled={busy} value={state.from.slice(0,10)} onChange={e=>change(state.groupId,e.target.value?e.target.value+'T00:00:00.000Z':'')} /></label>
    <label className="block">إلى يوم UTC (غير مشمول)<input type="date" disabled={busy} value={state.to.slice(0,10)} onChange={e=>change(state.groupId,state.from,e.target.value?e.target.value+'T00:00:00.000Z':'')} /></label>
    <p>اختر فترة لا تتجاوز 31 يومًا. تغيير المجموعة أو الفترة يمسح النتائج والاختيارات السابقة.</p>
    <Button type="button" disabled={busy||!state.groupId||!state.from||!state.to} onClick={()=>{void ref.current?.read();}}>قراءة أدلة المراجعة</Button>
    {busy?<p role="status">جارٍ التحقق؛ أُخفيت الأدلة السابقة.</p>:null}
    {state.phase==='error'?<p role="alert">تعذر التحقق من دليل كامل. راجع المجموعة والفترة، أو ضيّق الفترة وحدّث؛ لا نعرض عينة مبتورة كأنها المجموعة كلها.</p>:null}
    {data?<div className="space-y-3">
      <p>المجموعة: {data.group_name} — آخر قراءة: <time dateTime={data.checked_at}>{new Date(data.checked_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})} القاهرة</time></p>
      {data.reason===null?<p>محاولات مكتملة التصحيح: {data.graded_attempts}؛ أسئلة آلية في النسخة: {data.automatic_questions}؛ بلا وسوم موثقة: {data.unmapped_questions}؛ أسئلة يدوية مستبعدة: {data.excluded_manual_questions}.</p>:<p>لم تُحسب أعداد: لا يوجد كويز مربوط أو لا توجد له نسخة منشورة مثبتة حاليًا.</p>}
      <p>نقترح وسمين بحد أقصى عند وجود 5 محاولات مكتملة على الأقل، و40٪ أو أكثر من الإجابات على أسئلته لم تُسجل صحيحة بالكامل. الترتيب بالنسبة ثم العدد ثم اسم الوسم. الإجابة الجزئية قد تدخل في هذا العدد؛ الوسوم من إصدار بنك الأسئلة المثبت، وليست تشخيصًا للمفاهيم أو الطلاب. قد تتكرر الإجابة ضمن أكثر من وسم.</p>
      {data.state==='insufficient'?<p role="status">لا يكفي الدليل: قد لا يوجد كويز بنسخة منشورة، أو عدد كافٍ من المحاولات، أو وسوم مثبتة.</p>:!data.suggestions.length?<p>لا توجد وسوم تتجاوز القاعدة في هذه القراءة؛ هذا لا يثبت إتقان الطلاب.</p>:null}
      {data.suggestions.map(s=><article key={s.tag} className="space-y-2 rounded border p-2">
        <h6 className="font-semibold">{s.tag}</h6><p>{s.not_fully_correct} من {s.responses} إجابة لم تُسجل صحيحة بالكامل، عبر {s.question_count} سؤال.</p>
        <details><summary>فتح دليل الأسئلة من هذه القراءة</summary><p>نعرض أول 5 أسئلة بحد أقصى؛ الأعداد أعلاه محسوبة من كامل المجموعة المحدودة. النص معاينة حتى 1000 حرف. حدّث القراءة قبل الاعتماد عليها بعد أي تعديل.</p><ul>{s.evidence.map(q=><li key={q.question_ref}>السؤال {q.position}: {q.text}<p>{q.not_correct} من {q.responses} إجابة لم تُسجل صحيحة بالكامل.</p></li>)}</ul></details>
        <div className="flex gap-2"><Button type="button" variant="outline" onClick={()=>ref.current?.decide(s.tag,'use')}>أستخدم الوسم في المراجعة</Button><Button type="button" variant="outline" onClick={()=>ref.current?.decide(s.tag,'dismiss')}>أستبعد الاقتراح</Button></div>
        {state.decisions[s.tag]?<p role="status">{state.decisions[s.tag]==='use'?'اخترته للمراجعة.':'استبعدته.'} اختيار محلي يمسح عند التحديث.</p>:null}
      </article>)}
      {data.suggestions.length?<div className="space-y-2 rounded border p-3">
        <h6 className="font-semibold">ملخص التحضير المختار</h6>
        <p>اختر «أستخدم الوسم» أولًا. النسخ يشمل المجموعة والفترة ووقت القراءة والوسوم وأعدادها فقط؛ لا أسئلة أو إجابات أو أسماء طلاب. الأعداد تخص الإجابات والمحاولات المؤهلة لهذه القراءة؛ ليست عدد كل طلاب المجموعة.</p>
        <Button type="button" variant="outline" disabled={state.copyPhase==='copying'||!data.suggestions.some(s=>state.decisions[s.tag]==='use')} onClick={()=>{void ref.current?.copy();}}>نسخ ملخص التحضير</Button>
        {state.copyPhase==='copying'?<p role="status">جارٍ تأكيد النسخ…</p>:state.copyPhase==='copied'?<p role="status">تم نسخ الملخص المختار لهذه القراءة. لم يُحفظ في النظام ولم يُرسل.</p>:state.copyPhase==='error'?<p role="alert">تعذر تأكيد النسخ؛ راجع الحافظة قبل الاعتماد عليها. لا يوجد حفظ أو إرسال.</p>:null}
      </div>:null}
    </div>:null}
    <p>لا تشمل القراءة محاولات قيد الحل أو انتظار التصحيح، ولا الإجابات اليدوية، ولا الأسئلة المتكررة في الدعم. لا تعرض أسماء طلاب أو إجاباتهم أو مفاتيح التصحيح، ولا ترسل تقريرًا للأسرة.</p>
  </section>;
}
