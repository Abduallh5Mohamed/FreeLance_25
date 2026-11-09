import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {subscribeSessionChange} from '@/lib/session-events';
import {createStudentPlans,initialStudentPlans,readStudentPlans,studentReturnPrincipal} from './student-return-plans';
export function StudentReturnPlans(){
 const [state,setState]=useState(initialStudentPlans),ref=useRef<ReturnType<typeof createStudentPlans>|null>(null);
 useEffect(()=>{const c=createStudentPlans({read:readStudentPlans,readPrincipal:studentReturnPrincipal(localStorage),subscribeSession:subscribeSessionChange});ref.current=c;const unsub=c.subscribe(setState);
  const storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudent','currentStudentSpace'].includes(e.key))c.invalidate();};window.addEventListener('storage',storage);void c.first();return()=>{unsub();c.dispose();ref.current=null;window.removeEventListener('storage',storage);};
 },[]);
 if(state.phase==='session-ended')return <p role="alert">تغير الحساب أو مساحة الدراسة؛ أُخفيت خطط الرجوع. افتح الصفحة من جديد.</p>;
 return <section dir="rtl" aria-label="خطط الرجوع المحفوظة" className="my-4 space-y-3 rounded border bg-card p-4">
  <h2 className="font-semibold">خطة الرجوع من مدرسك</h2><p>نعرض أحدث نسخة نشطة تخص قيدك الحالي. لا تفتح الخطة درسًا مقفولًا ولا تمد اشتراكًا، والمدة تقدير المدرس وليست قياسًا لفهمك.</p>
  <div className="flex gap-2"><Button type="button" variant="outline" disabled={state.phase==='loading'} onClick={()=>{void ref.current?.first();}}>تحديث خطط الرجوع</Button><Button type="button" variant="outline" disabled={state.phase==='loading'||!state.page?.nextCursor} onClick={()=>{void ref.current?.next();}}>الخطط التالية</Button></div>
  {state.phase==='loading'?<p role="status">جارٍ التحقق؛ أُخفيت الخطط السابقة.</p>:null}
  {state.phase==='error'?<p role="alert">تعذر التحقق من الخطط الحالية. لا نعرض قائمة قديمة على أنها محدثة.</p>:null}
  {state.page?.plans.length===0?<p>لا توجد خطة متاحة في هذه الصفحة. قد توجد صفحات أخرى إذا ظهر زر التالي.</p>:null}
  {state.page?.plans.map(p=><article key={p.id} className="rounded border p-3"><h3 className="font-semibold">{p.course_name} — النسخة {p.version}</h3><ol className="list-decimal space-y-2 ps-5">{p.steps.map(s=><li key={s.position}>{s.available?<>{s.title} — {s.minutes===null?'المدة غير معروفة':s.minutes+' دقيقة بتقدير المدرس'}{s.completed?' — إكمال الدرس مسجل':''}</>:<>هذه الخطوة غير متاحة حاليًا. راجع المدرس دون محاولة تجاوز القفل.</>}</li>)}</ol></article>)}
  {state.page?<><p>آخر تحقق: <time dateTime={state.page.checkedAt}>{new Date(state.page.checkedAt).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})} القاهرة</time>.</p><Link to="/student-content" className="underline">فتح صفحة المحتوى</Link><p>استخدام المحتوى يعيد فحص صلاحياته من مساره الأصلي. عرض الخطة أو إكمال درس لا يسجل بدء الخطة أو إنهاءها تلقائيًا.</p></>:null}
 </section>;
}
