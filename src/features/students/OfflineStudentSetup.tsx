import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {subscribeSessionChange} from '@/lib/session-events';
import {readCourseSessionPrincipal} from '@/features/catalog/course-management';
import {createOfflineSetup,initialOfflineSetup,offlineSetupStore,offlineSetupTransport} from './offline-setup';
export function OfflineStudentSetup(){
 const [state,setState]=useState(initialOfflineSetup),[student,setStudent]=useState(''),[group,setGroup]=useState(''),[confirmed,setConfirmed]=useState(false);const ref=useRef<ReturnType<typeof createOfflineSetup>|null>(null);
 useEffect(()=>{let store:ReturnType<typeof offlineSetupStore>;try{store=offlineSetupStore(sessionStorage,JSON.parse(localStorage.getItem('currentUser')??'null')?.id);}catch{const unavailable=()=>{throw Error('Recovery storage unavailable');};store={read:unavailable,write:unavailable,clear:unavailable};}
  const c=createOfflineSetup({api:offlineSetupTransport(),store,principal:()=>{try{return readCourseSessionPrincipal(localStorage);}catch{return null;}},subscribe:subscribeSessionChange,newId:()=>crypto.randomUUID()});ref.current=c;const unsub=c.subscribe(setState);const storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))ref.current?.invalidate();};window.addEventListener('storage',storage);void c.load();return()=>{unsub();c.dispose();ref.current=null;window.removeEventListener('storage',storage);};},[]);
 useEffect(()=>{setConfirmed(false);},[state.review]);
 const reload=(kind?:'students'|'groups',next=false)=>{setStudent('');setGroup('');setConfirmed(false);void ref.current?.load(kind,next);};
 const busy=['saving','uncertain','recovering','loading','reviewing'].includes(state.phase);
 useEffect(()=>{if(!['saving','uncertain','recovering'].includes(state.phase))return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[state.phase]);
 if(state.phase==='session-ended')return <p role="alert">تغيرت الجلسة؛ أُخفيت بيانات استكمال السجلات.</p>;
 return <section dir="rtl" aria-label="استكمال سجل أوفلاين" className="mb-6 space-y-3 rounded border p-4">
  <h2 className="font-semibold">استكمل السجل نفسه كطالب أوفلاين</h2><p>لسجل نشط بلا حساب أو مجموعة أو فرع أو تعيين مقرر؛ ومنها سجلات الاستيراد. لا ننسبه لدفعة استيراد بعينها. اختَر المجموعة والمقرر، ثم عاين وأكد. لا إنشاء طالب آخر أو حساب دخول أو تحصيل. هذه الخطوة تدعم المجموعات العامة داخل المؤسسة فقط.</p>
  <Button disabled={busy} variant="outline" onClick={()=>reload()}>تحديث سجلات الاستكمال والمجموعات</Button>
  <label className="block">السجل غير المرتبط<select aria-label="السجل غير المرتبط" className="block w-full rounded border p-2" disabled={busy} value={student} onChange={e=>{setStudent(e.target.value);setConfirmed(false);ref.current?.choose(e.target.value,group);}}><option value="">اختر سجلًا من الصفحة الحالية</option>{state.students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
  <Button disabled={busy||!state.studentCursor} variant="outline" onClick={()=>reload('students',true)}>سجلات تالية</Button>
  <label className="block">المجموعة والمقرر<select aria-label="المجموعة والمقرر" className="block w-full rounded border p-2" disabled={busy} value={group} onChange={e=>{setGroup(e.target.value);setConfirmed(false);ref.current?.choose(student,e.target.value);}}><option value="">اختر مجموعة ومقررها</option>{state.groups.map(g=><option key={g.id} value={g.id}>{g.name} — {g.course_name}</option>)}</select></label>
  <Button disabled={busy||!state.groupCursor} variant="outline" onClick={()=>reload('groups',true)}>مجموعات تالية</Button>
  <Button disabled={busy||!state.selection} onClick={()=>{void ref.current?.review();}}>معاينة استكمال السجل</Button>
  {state.message?<p role="alert">{state.message}</p>:null}
  {state.review?<div className="space-y-2 rounded border p-3"><p>{state.review.student.name} ← {state.review.group.name} — {state.review.course.name}</p><p>القيود النشطة: {state.review.group.active_enrollments} / السعة: {state.review.group.capacity}. سيصبح السجل أوفلاين دون حساب؛ حالته وتاريخه ومحتواه السابق لا يُستبدل.</p><label><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>أؤكد استكمال هذا السجل نفسه أوفلاين وتعيين المجموعة والمقرر المعروضين.</label><Button disabled={busy||!confirmed} onClick={()=>{setConfirmed(false);void ref.current?.apply(confirmed);}}>تأكيد استكمال الأوفلاين</Button></div>:null}
  {state.receipt?<p role="status">تأكد استكمال السجل أوفلاين؛ إيصال تاريخي لا يثبت بقاء نفس التعيين الآن. حدّث مراجعة المجموعة بعد الرجوع إليها.</p>:null}
  {state.phase==='uncertain'?<Button onClick={()=>{void ref.current?.recover();}}>التحقق من نتيجة الاستكمال دون إعادة الكتابة</Button>:null}
 </section>;
}
