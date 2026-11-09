import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {subscribeSessionChange} from '@/lib/session-events';
import {readCourseSessionPrincipal} from '@/features/catalog/course-management';
import {createQuestionGrading,gradingApi,gradingIntentStore,initialGrading} from './question-grading';
import {GradingRubricEditor} from './GradingRubricEditor';
import {GradingAssignmentManager} from './GradingAssignments';
import {GradingReopen} from './GradingReopen';
export function QuestionGrading(){const [open,setOpen]=useState(false);return <section className="mb-6 rounded-xl border bg-card p-4" dir="rtl" aria-label="التصحيح بالسؤال للنسخ المثبتة"><Button type="button" variant="outline" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{open?'إغلاق مساحة التصحيح بالسؤال':'التصحيح بالسؤال — الامتحانات ذات النسخ المثبتة'}</Button>{open?<QuestionGradingPanel/>:null}</section>;}
export function QuestionGradingPanel(){
 const [state,setState]=useState(initialGrading),ref=useRef<ReturnType<typeof createQuestionGrading>|null>(null);
 useEffect(()=>{let account='';try{account=JSON.parse(localStorage.getItem('currentUser')??'null')?.id??'';}catch{}
  let store:ReturnType<typeof gradingIntentStore>;
  try{if(!account)throw Error('Missing account');store=gradingIntentStore(sessionStorage,account);}catch{store={read:()=>{throw Error('Recovery storage unavailable');},write:()=>{throw Error('Recovery storage unavailable');},clear:()=>{throw Error('Recovery storage unavailable');}};}
  const c=createQuestionGrading({api:gradingApi,readPrincipal:()=>readCourseSessionPrincipal(localStorage),subscribeSession:subscribeSessionChange,store,newId:()=>crypto.randomUUID()});ref.current=c;const unsub=c.subscribe(setState);
  const storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))c.invalidate();};const beforeUnload=(e:BeforeUnloadEvent)=>{if(c.locked()){e.preventDefault();e.returnValue='';}};
  window.addEventListener('storage',storage);window.addEventListener('beforeunload',beforeUnload);
  return()=>{unsub();c.dispose();ref.current=null;window.removeEventListener('storage',storage);window.removeEventListener('beforeunload',beforeUnload);};
 },[]);
 const locked=['saving','uncertain','recovering'].includes(state.phase),reading=state.phase==='loading',row=state.page?.answers.find(a=>a.attempt_id===state.selected);
 if(state.phase==='session-ended')return <p role="alert">تغير الحساب أو مساحة العمل؛ أُخفيت إجابات التصحيح. أعد فتح اللوحة للتحقق.</p>;
 return <div className="mt-4 space-y-4 text-sm" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();if(!locked&&!reading)void ref.current?.grade();}}}>
  <p>هذه الرحلة للمدرس المسؤول عن المقرر والمحاولات المعلّقة للمراجعة في نسخ الامتحان المثبتة. نعرض إجابات سؤال واحد دون أسماء الطلاب. إدارة تبويب أو ملكية السنتر لا تمنح صلاحية التصحيح.</p>
  {state.receipt?<div role="status" className="rounded border border-green-300 p-3">الحفظ مؤكد: {state.receipt.kind==='grade'?<>مراجعة السؤال رقم {state.receipt.revision}، الدرجة {state.receipt.awarded_points}؛ ليست نتيجة نهائية.</>:<>اعتماد التصحيح بدرجة {state.receipt.score}. {state.receipt.gradebook_linked?'الربط بسجل الدرجات مؤكد.':'لم يثبت الربط بسجل الدرجات؛ لا ندعي نشرها للأسرة.'}</>} إيصال العملية يثبت النتيجة التاريخية؛ تحديث الإجابات قراءة منفصلة.</div>:null}
  {state.message?<p role={state.phase==='uncertain'||state.phase==='error'?'alert':'status'}>{state.message}</p>:null}
  {locked?<div className="rounded border border-amber-300 p-3"><p>{state.phase==='saving'?'جارٍ الحفظ؛ الإجراءات الأخرى متوقفة.':state.phase==='recovering'?'جارٍ الاستعلام عن الإيصال…':'نتيجة العملية تحتاج التحقق. لا يُعاد إرسال الحفظ تلقائيًا.'}</p><Button type="button" disabled={state.phase!=='uncertain'} onClick={()=>{void ref.current?.recover();}}>التحقق من نتيجة العملية دون إعادة الكتابة</Button></div>:null}
  <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={locked||reading} onClick={()=>{void ref.current?.exams();}}>قراءة الامتحانات المخولة</Button>
   <label>الامتحان <select aria-label="امتحان التصحيح بالسؤال" disabled={locked||reading} value={state.examId??''} onChange={e=>{void ref.current?.selectExam(e.target.value);}}><option value="" disabled>اختر امتحانًا</option>{state.exams?.items.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
   {state.exams?.next_cursor?<Button type="button" variant="outline" disabled={locked||reading} onClick={()=>{void ref.current?.exams(true);}}>امتحانات تالية</Button>:null}
   <label>النسخة المنشورة المثبتة <select aria-label="نسخة امتحان التصحيح" disabled={locked||reading} value={state.versionId??''} onChange={e=>{void ref.current?.selectVersion(e.target.value);}}><option value="" disabled>اختر نسخة</option>{state.versions?.items.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
   {state.versions?.next_cursor&&state.examId?<Button type="button" variant="outline" disabled={locked||reading} onClick={()=>{void ref.current?.selectExam(state.examId!,true);}}>نسخ تالية</Button>:null}
   <label>السؤال المقالي <select aria-label="سؤال التصحيح" disabled={locked||reading} value={state.questionId??''} onChange={e=>{void ref.current?.answers(e.target.value);}}><option value="" disabled>اختر سؤالًا</option>{state.questions?.items.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
  </div>
  {reading?<p role="status">جارٍ التحقق من البيانات الحالية…</p>:null}
  {state.versionId?<GradingReopen key={state.versionId} versionId={state.versionId} disabled={locked||reading}/>:null}
  {state.questionId?<Button type="button" variant="outline" disabled={locked||reading} onClick={()=>{void ref.current?.answers(state.questionId!);}}>تحديث إجابات السؤال</Button>:null}
  {state.page?<>
   <GradingRubricEditor key={state.page.question.id} question={state.page.question} disabled={locked||reading}/>
   <GradingAssignmentManager key={'assignment:'+state.page.question.id} questionId={state.page.question.id} disabled={locked||reading}/>
   <div className="rounded bg-muted p-3"><h3 className="whitespace-pre-wrap font-semibold">{state.page.question.text}</h3><p>الدرجة القصوى من النسخة: {state.page.question.points}</p><p className="whitespace-pre-wrap">{state.page.question.explanation?'شرح السؤال المثبت: '+state.page.question.explanation:'لا يوجد شرح مثبت. لم نولّد معيار تصحيح أو إجابة نموذجية.'}</p><p>الشرح ليس معيارًا معتمدًا متعدد البنود؛ لا تُعدّل نسخة السؤال أثناء التصحيح.</p></div>
   {!state.page.answers.length?<p>لا توجد محاولات معلّقة متاحة لهذا السؤال في هذه الصفحة.</p>:<div className="grid gap-3 md:grid-cols-[220px_1fr]"><ul className="max-h-96 space-y-2 overflow-y-auto">{state.page.answers.map((a,i)=><li key={a.attempt_id}><Button className="w-full" type="button" variant={state.selected===a.attempt_id?'default':'outline'} disabled={locked||reading} onClick={()=>ref.current?.choose(a.attempt_id)}>إجابة {i+1} — {a.revision===null?'لم تُصحح':`مراجعة ${a.revision}: ${a.awarded_points}`}</Button></li>)}</ul>
    {row?<div className="space-y-3 rounded border p-4"><h4 className="font-semibold">إجابة الطالب — الأسماء مخفية</h4>{row.unsupported?<p role="alert">نوع الإجابة أو حجمها غير مدعوم في مساحة النص؛ لم نفتح رابط ملف أو صورة غير متحقق منها.</p>:<p className="whitespace-pre-wrap break-words rounded bg-muted p-3">{row.response||'إجابة نصية فارغة — منح الدرجة قرار المصحح.'}</p>}
     <label className="block">الدرجة <input aria-label="درجة السؤال" className="m-2 rounded border p-2" inputMode="decimal" value={state.points} disabled={locked||reading||row.unsupported} onChange={e=>ref.current?.change(e.target.value,state.feedback)}/></label>
     <label className="block">تعليق المصحح <textarea aria-label="تعليق المصحح" className="block w-full rounded border p-2" maxLength={2000} value={state.feedback} disabled={locked||reading||row.unsupported} onChange={e=>ref.current?.change(state.points,e.target.value)}/></label>
     <div className="flex flex-wrap gap-3"><Button type="button" disabled={locked||reading||row.unsupported} onClick={()=>{void ref.current?.grade();}}>حفظ مراجعة السؤال</Button><Button type="button" variant="outline" disabled={locked||reading} onClick={()=>{void ref.current?.preview();}}>مراجعة اكتمال المحاولة ودرجتها</Button></div><p>Ctrl+Enter لحفظ مراجعة السؤال المختار. الحفظ يضيف مراجعة ولا يعتمد النتيجة النهائية تلقائيًا.</p>
     {state.review?<div className="rounded border p-3">{state.review.complete?<><p>المجموع الحالي بعد إعادة قراءة كل المراجعات: {state.review.score}. الاعتماد يحفظ التصحيح ولا ينشر تقريرًا للأسرة.</p><Button type="button" disabled={locked||reading} onClick={()=>{if(window.confirm('اعتماد التصحيح بالمجموع المعروض؟ إعادة المراجعة لاحقًا تحتاج معاينة أثر وسببًا مسجلًا.'))void ref.current?.finalize();}}>اعتماد التصحيح بالمجموع المعروض</Button></>:<p>المحاولة غير مكتملة التصحيح أو لم تعد معلّقة. راجع بقية الأسئلة؛ لم تُحتسب درجة نهائية مفترضة.</p>}</div>:null}
    </div>:<p>اختر إجابة لبدء المراجعة.</p>}</div>}
   {state.page.next_cursor?<Button type="button" variant="outline" disabled={locked||reading} onClick={()=>{void ref.current?.answers(state.questionId!,true);}}>صفحة الإجابات التالية</Button>:null}
  </>:null}
 </div>;
}
