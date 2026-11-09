import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {subscribeSessionChange} from '@/lib/session-events';
import {readCourseSessionPrincipal} from './course-management';
import {createReturnPlan,initialReturn,returnPlanTransport,returnIntentStore} from './course-return-plan';
import {ReturnPlanFollowUp} from './ReturnPlanFollowUp';
const attendanceLabel={present:'حاضر',absent:'غائب',late:'متأخر',excused:'بعذر',unrecorded:'لم يسجل حضوره'};
const ignoreLock=(_locked:boolean)=>{};
export function CourseReturnPlan({courseId,onLockChange=ignoreLock}:{courseId:string;onLockChange?:(locked:boolean)=>void}){
 const [state,setState]=useState(initialReturn),[confirmed,setConfirmed]=useState(false),[page,setPage]=useState(0);
 const ref=useRef<ReturnType<typeof createReturnPlan>|null>(null);
 useEffect(()=>{
  const store={read:()=>returnIntentStore(sessionStorage,courseId,JSON.parse(localStorage.getItem('currentUser')??'{}').id??'').read(),write:(x:Parameters<ReturnType<typeof returnIntentStore>['write']>[0])=>returnIntentStore(sessionStorage,courseId,JSON.parse(localStorage.getItem('currentUser')??'{}').id??'').write(x),clear:()=>returnIntentStore(sessionStorage,courseId,JSON.parse(localStorage.getItem('currentUser')??'{}').id??'').clear()};
  const c=createReturnPlan({...returnPlanTransport(courseId),intentStore:store,readPrincipal:()=>{try{return readCourseSessionPrincipal(localStorage);}catch{return null;}},subscribeSession:subscribeSessionChange});ref.current=c;
  const unsub=c.subscribe(value=>{setState(value);onLockChange(value.phase!=='session-ended'&&['saving','uncertain','recovering'].includes(value.savePhase));}),storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))c.invalidate();};
  window.addEventListener('storage',storage);void c.first();return()=>{unsub();c.dispose();ref.current=null;onLockChange(false);window.removeEventListener('storage',storage);};
 },[courseId,onLockChange]);
 useEffect(()=>{if(!['saving','uncertain','recovering'].includes(state.savePhase))return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[state.savePhase]);
 useEffect(()=>{setConfirmed(false);},[state.preview]);useEffect(()=>{setPage(0);},[state.data]);
 if(state.phase==='session-ended')return <p role="alert">تغيرت الجلسة؛ أُخفيت بيانات الطالب ومسودة الرجوع.</p>;
 const busy=state.phase==='loading'||['saving','uncertain','recovering'].includes(state.savePhase),data=state.data,preview=state.preview;
 const change=(student=state.enrollmentId,from=state.from,to=state.to)=>ref.current?.change(student,from,to);
 return <section dir="rtl" aria-label="خطة رجوع يراجعها المدرس" className="space-y-3 rounded border p-3 text-sm">
  <h4 className="font-semibold">خطة رجوع صغيرة</h4>
  <p>راجع الحضور الفعلي والتقدم الجديد، ثم اختر حتى ثلاث خطوات. عدم تسجيل الحضور ليس غيابًا، وعدم إكمال درس لا يثبت الغياب أو ضعف الفهم. الغياب بعذر يظهر بحالته دون تصنيف عقابي.</p>
  <label className="block">الطالب<select aria-label="الطالب" disabled={busy} value={state.enrollmentId} onChange={e=>change(e.target.value)} className="block w-full rounded border p-2"><option value="">اختر من الصفحة الحالية</option>{state.students.map(s=><option key={s.enrollment_id} value={s.enrollment_id}>{s.name}</option>)}</select></label>
  <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={()=>{void ref.current?.first();}}>أول صفحة طلاب</Button><Button type="button" variant="outline" disabled={busy||!state.nextCursor} onClick={()=>{void ref.current?.next();}}>الطلاب التاليون</Button></div>
  <label className="block">من يوم UTC (مشمول)<input type="date" disabled={busy} value={state.from.slice(0,10)} onChange={e=>change(state.enrollmentId,e.target.value?e.target.value+'T00:00:00.000Z':'')} /></label>
  <label className="block">إلى يوم UTC (غير مشمول)<input type="date" disabled={busy} value={state.to.slice(0,10)} onChange={e=>change(state.enrollmentId,state.from,e.target.value?e.target.value+'T00:00:00.000Z':'')} /></label>
  <Button type="button" disabled={busy||!state.enrollmentId||!state.from||!state.to} onClick={()=>{void ref.current?.load();}}>قراءة الحضور والتقدم</Button>
  {busy?<p role="status">جارٍ التحقق؛ أُخفيت الأدلة السابقة.</p>:null}
  {state.message?<p role="alert">{state.message}</p>:null}
  {state.saved?<p role="status">تأكد {state.saved.status==='active'?'حفظ الخطة وإتاحتها للقراءة المخولة داخل حساب الطالب':'سحب الخطة'} — النسخة {state.saved.version}. هذه نتيجة تاريخية للعملية، وليست إثباتًا لوصول إشعار أو بقاء نفس الحالة الآن.</p>:null}
  {state.savePhase==='uncertain'?<Button type="button" onClick={()=>{void ref.current?.recover();}}>التحقق من نتيجة الحفظ دون إعادة الكتابة</Button>:null}
  {data?<>
   <h5 className="font-semibold">{data.student.name}</h5><p>آخر قراءة: <time dateTime={data.checked_at}>{new Date(data.checked_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})} القاهرة</time></p>
   <ReturnPlanFollowUp key={data.context.enrollment_id+':'+(state.saved?.version??data.persistence.current?.version??0)} courseId={courseId} enrollmentId={data.context.enrollment_id} locked={busy} />
   <div aria-label="ملخص حالات الحضور المثبتة" className="flex flex-wrap gap-3 rounded bg-muted p-2">
    {(Object.keys(attendanceLabel) as (keyof typeof attendanceLabel)[]).map(kind=><span key={kind}>{attendanceLabel[kind]}: {data.attendance.filter(row=>row.state===kind).length}</span>)}
   </div>
   <details><summary>سجل جلسات المجموعة الحالية في الفترة</summary><p>جلسات المجموعة المنتهية وغير الملغاة فقط، بحد 100 جلسة. لا يوجد ربط آلي بينها وبين دروس الكتالوج.</p>
    {!data.attendance.length?<p>لا توجد جلسات مثبتة بهذه الشروط؛ لا نستنتج منها غيابًا.</p>:<ul>{data.attendance.map(s=><li key={s.session_id}>{s.title} — {s.starts_at} — {attendanceLabel[s.state]}</li>)}</ul>}
   </details>
   <p>تقدم الدروس الجديدة مستقل عن تقدم المحتوى القديم. الإكمال المسجل لا يقيس الفهم. الدروس المقفلة أو المكتملة لا تدخل في هذه المسودة.</p>
   {!data.lessons.length?<p>لا توجد دروس نشطة في المسار الحالي.</p>:null}
   <ul className="space-y-2">{data.lessons.slice(page*25,page*25+25).map(l=><li key={l.lesson_id} className="rounded border p-2">
    <label><input type="checkbox" disabled={busy||l.completed||l.block!==null} checked={state.steps.some(s=>s.lesson_id===l.lesson_id)} onChange={()=>ref.current?.choose(l.lesson_id)} /> {l.title} {l.completed?'— مكتمل':l.block==='not_released'?'— لم يحن موعده':l.block==='prerequisite_incomplete'?'— يتطلب درسًا سابقًا':''}</label>
   </li>)}</ul>
   <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy||page===0} onClick={()=>{if(!busy)setPage(old=>Math.max(0,old-1));}}>دروس سابقة</Button><Button type="button" variant="outline" disabled={busy||(page+1)*25>=data.lessons.length} onClick={()=>{if(!busy)setPage(old=>old+1);}}>دروس تالية</Button></div>
   <h5 className="font-semibold">خطواتك المختارة بالترتيب</h5>
   <ol className="list-decimal ps-5">{state.steps.map(s=><li key={s.lesson_id}>{data.lessons.find(l=>l.lesson_id===s.lesson_id)?.title}
    <label className="block">مدة تقديرية منك بالدقائق (اتركها فارغة إن لم تعرف)<input type="number" min={1} max={180} step={1} disabled={busy} value={s.minutes??''} onChange={e=>ref.current?.duration(s.lesson_id,e.target.value)} /></label>
   </li>)}</ol>
   <Button type="button" disabled={busy||!state.steps.length} onClick={()=>{void ref.current?.preview();}}>معاينة الخطوات الحالية</Button>
   {preview?<div className="space-y-2 rounded border p-2"><p>المعاينة تعيد إثبات القيد النشط في المقرر والموعد والشرط السابق. صلاحية تسليم كل فيديو أو ملف أو نشاط تُفحص من مساره الأصلي عند الاستخدام؛ هذه ليست إذن تشغيل أو تمديد اشتراك.</p>
    <ol className="list-decimal ps-5">{preview.steps.map(s=><li key={s.lesson_id}>{s.title} — {s.minutes===null?'المدة غير معروفة':s.minutes+' دقيقة بتقدير المدرس'}</li>)}</ol>
    {preview.reviewed?<><p role="status">تمت إعادة التحقق ومراجعة المسودة. المراجعة وحدها لا تحفظ ولا ترسل خطة.</p><Button type="button" disabled={busy||preview.persistence.status!=='ready'} onClick={()=>{void ref.current?.save();}}>حفظ الخطة وإتاحتها للطالب</Button></>:<><label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>{if(!busy)setConfirmed(e.target.checked);}} />راجعت الأدلة والخطوات والمدة، واختياري لا يفك أي قفل.</label><Button type="button" disabled={!confirmed||busy} onClick={()=>{if(!confirmed||busy)return;setConfirmed(false);void ref.current?.review();}}>تأكيد مراجعة المسودة</Button></>}
   </div>:null}
   {data.persistence.status==='unavailable'?<p role="alert">حفظ الخطط غير جاهز في هذه البيئة. تظل المسودة محلية، ولا يُفترض أن ملف المخطط مطبق.</p>:<p>نسخة الخطة وقت هذه القراءة: {data.persistence.current?.version??'لم توجد خطة وقت القراءة'}. القراءة لا تتحدث تلقائيًا بعد الحفظ؛ حدّث الأدلة قبل تعديل جديد. تحديث خطة موجودة يحتفظ بمراجعاتها السابقة.</p>}
   {data.persistence.status==='ready'&&data.persistence.current?.status==='active'?<Button type="button" variant="outline" disabled={busy||!!state.saved&&state.saved.version!==data.persistence.current.version} onClick={()=>{if(!busy&&(!state.saved||state.saved.version===data.persistence.current?.version)&&window.confirm('سحب الخطة من حساب الطالب؟'))void ref.current?.withdraw();}}>سحب الخطة المحفوظة</Button>:null}
  </>:null}
  <p>الاختيارات تظل مسودة حتى تأكيد الحفظ. يُحفظ معرف استعلام محلي صغير قبل الكتابة لاسترجاع نتيجتها بعد إعادة الفتح، دون أسماء أو حضور أو محتوى الخطة. لا توجد أسئلة امتحان أو مفاتيح تصحيح أو تعديل حضور أو إكمال أو وصول. الفترة بحد 31 يومًا؛ نقص المصدر أو تجاوز الحدود يوقف القراءة بدل اختراع خطة.</p>
 </section>;
}
