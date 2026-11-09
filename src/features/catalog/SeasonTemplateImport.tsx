import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {readCourseSessionPrincipal} from './course-management';
import {subscribeSessionChange} from '@/lib/session-events';
import {createTemplateImport,importIntentStore,initialImport,templateImportApi,importKinds} from './season-template-import';
const names={material:'مادة',video:'فيديو',homework:'واجب',quiz:'كويز',announcement:'إعلان'};
export function SeasonTemplateImport({targetCourseId,onLocked}:{targetCourseId:string;onLocked?:(v:boolean)=>void}){
 const [s,set]=useState(initialImport),ref=useRef<ReturnType<typeof createTemplateImport>|null>(null);
 useEffect(()=>{let store:ReturnType<typeof importIntentStore>;try{const account=JSON.parse(localStorage.getItem('currentUser')??'null')?.id;store=importIntentStore(sessionStorage,account);}catch{store={read:()=>{throw Error('Storage unavailable');},write:()=>{throw Error('Storage unavailable');},clear:()=>{throw Error('Storage unavailable');}};}
 const c=createTemplateImport({target:targetCourseId,api:templateImportApi,store,newId:()=>crypto.randomUUID(),readPrincipal:()=>{try{return readCourseSessionPrincipal(localStorage);}catch{return null;}},subscribeSession:subscribeSessionChange});ref.current=c;const unsub=c.subscribe(set);const storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))c.invalidate();};const unload=(e:BeforeUnloadEvent)=>{if(c.locked()){e.preventDefault();e.returnValue='';}};window.addEventListener('storage',storage);window.addEventListener('beforeunload',unload);return()=>{unsub();c.dispose();ref.current=null;window.removeEventListener('storage',storage);window.removeEventListener('beforeunload',unload);};},[targetCourseId]);
 const locked=['saving','uncertain','recovering'].includes(s.phase),busy=locked||s.phase==='loading';useEffect(()=>{onLocked?.(locked);return()=>onLocked?.(false);},[locked,onLocked]);
 if(s.phase==='session-ended')return <p role="alert">لم تعد الجلسة أو صلاحية المقرر متاحة؛ أُخفيت بيانات القالب.</p>;
 return <section className="mt-4 space-y-3 rounded border p-4" aria-label="استيراد قالب للموسم">
  <h3 className="font-semibold">ربط قالب المقرر السابق بمصادر الموسم الجديد</h3>
  <p>اختر نسخة محفوظة صراحة، واربط كل مرجع بمصدر جاهز للإعداد داخل المقرر الجديد. هذه الخطوة تنسخ هيكل القالب ومراجعه المختارة فقط؛ لا تنقل ملفًا أو محاولات أو جمهورًا، ولا تطبق القالب على درس أو تنشره. جهّز مصادر المقرر الجديد من أدواته أولًا.</p>
  {s.message?<p role={s.phase==='uncertain'?'alert':'status'}>{s.message}</p>:null}
  {s.receipt?<p role="status" className="rounded border border-green-300 p-3">تأكد استيراد {s.receipt.reference_count} مراجع إلى قالب مستقل. النتيجة تاريخية؛ اقرأ القالب من مكتبة المقرر لمعرفة حالته الحالية.</p>:null}
  {locked?<Button type="button" disabled={s.phase!=='uncertain'} onClick={()=>{void ref.current?.recover();}}>التحقق من إيصال استيراد القالب</Button>:null}
  <Button type="button" variant="outline" disabled={busy} onClick={()=>{void ref.current?.templates();}}>قراءة قوالب المقرر السابق</Button>
  <label className="block">القالب <select aria-label="قالب الموسم المصدر" disabled={busy} value={s.templateId} onChange={e=>ref.current?.select(e.target.value)}><option disabled value="">اختر قالبًا</option>{s.templates?.items.map(x=><option key={x.id} value={x.id}>{x.name} — آخر مراجعة {x.head_revision}</option>)}</select></label>
  {s.templates?.next_cursor?<Button type="button" variant="outline" disabled={busy} onClick={()=>{void ref.current?.templates(true);}}>قوالب تالية</Button>:null}
  <label className="block">رقم النسخة المختارة <input aria-label="رقم نسخة القالب للموسم" className="m-2 rounded border p-2" inputMode="numeric" value={s.revision} disabled={busy} onChange={e=>ref.current?.change({revision:e.target.value})}/></label>
  <Button type="button" variant="outline" disabled={busy||!s.templateId||!s.revision} onClick={()=>{void ref.current?.source();}}>قراءة النسخة المحددة ومراجعها</Button>
  {s.source?<>
   <p>القالب: {s.source.name} — نسخة {s.source.revision_number}. أرقام الترتيب الأصلية ستبقى كما هي؛ تواريخ النشر والشروط والتقدم لا تنتقل.</p>
   {importKinds.filter(k=>s.source!.references.some(r=>r.kind===k)).map(kind=><div key={kind} className="space-y-2 rounded border p-3"><Button type="button" variant="outline" disabled={busy} onClick={()=>{void ref.current?.choices(kind);}}>قراءة مصادر {names[kind]} المقرر الجديد</Button>
    {s.source!.references.filter(r=>r.kind===kind).map(r=>{const chosen=s.mapping[kind+'/'+r.source_id]??'',page=s.choices[kind];return <label className="block" key={r.source_id}>{names[kind]}: {r.title} — {r.audience==='restricted'?'جمهور محدد':'المقرر'} {r.display_order!==null?'، ترتيب '+r.display_order:''}
     <select className="m-2 max-w-full rounded border p-2" aria-label={'بديل '+r.title} disabled={busy} value={chosen} onChange={e=>ref.current?.map(kind,r.source_id,e.target.value)}><option disabled value="">اختر مصدرًا من المقرر الجديد</option>{chosen&&!page?.items.some(x=>x.id===chosen)?<option value={chosen}>اختيار من صفحة سابقة؛ تحقق من عنوانه في المعاينة</option>:null}{page?.items.map(x=><option key={x.id} value={x.id}>{x.title} — {x.state}، {x.audience==='restricted'?'جمهور محدد':'المقرر'}</option>)}</select></label>;})}
    {s.choices[kind]?.next_cursor?<Button type="button" variant="outline" disabled={busy} onClick={()=>{void ref.current?.choices(kind,true);}}>مصادر {names[kind]} تالية</Button>:null}
   </div>)}
   <label className="block">اسم القالب الجديد <input aria-label="اسم قالب الموسم الجديد" className="m-2 rounded border p-2" maxLength={120} value={s.name} disabled={busy} onChange={e=>ref.current?.change({name:e.target.value})}/></label>
   <label className="block"><input type="checkbox" checked={s.rights} disabled={busy} onChange={e=>ref.current?.change({rights:e.target.checked})}/> أؤكد حق إعادة استخدام القالب والمصادر المختارة داخل المؤسسة.</label>
   <Button type="button" disabled={busy} onClick={()=>{void ref.current?.review();}}>معاينة ربط القالب بالموسم</Button>
  </>:null}
  {s.review?<div className="space-y-2 rounded border p-3"><h4>المعاينة: {s.review.name}</h4><ul>{s.review.items.map(r=><li key={r.kind+'/'+r.source_id}>{names[r.kind]}: {r.title} ← {r.target_title}؛ {r.target_state}، {r.target_audience==='restricted'?'جمهور المصدر الجديد محدد':'جمهور المقرر الجديد'}</li>)}</ul><p>الجمهور الحالي خاص بالمصادر الجديدة ولا يُنسخ من القديم. صلاحية التسليم والنشر تُفحص عند استخدامها لاحقًا.</p><Button type="button" disabled={busy} onClick={()=>{if(window.confirm('حفظ قالب مستقل بالمراجع الجديدة المعروضة، دون تطبيق أو نشر؟'))void ref.current?.apply();}}>تأكيد حفظ قالب الموسم</Button></div>:null}
 </section>;
}
