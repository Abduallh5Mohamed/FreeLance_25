import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '@/lib/api-http';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import { subscribeSessionChange } from '@/lib/session-events';
import { isGradingId } from './question-grading';
import { boundedRequest as boundedCenterRequest } from '@/lib/bounded-request';

type Criterion = { key: string; label: string; max_points: string };
type Rubric = { id: string; question_ref: string; revision: number; criteria: Criterion[]; total_points: string };
type Intent = { operation_id: string; question_ref: string; revision: number };
const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
function parseReceipt(r: any, i: Intent) {
  if (!exact(r, ['operation_id','rubric_id','question_ref','revision']) || r.operation_id !== i.operation_id || r.question_ref !== i.question_ref || r.revision !== i.revision || !isGradingId(r.rubric_id)) throw Error('Invalid rubric receipt');
  return r;
}
function parseRubric(raw: any, question: {id:string;points:string}): Rubric | null {
  if (!exact(raw,['rubric'])) throw Error('Invalid rubric response');
  const r=raw.rubric; if(r===null)return null;
  if(!exact(r,['id','question_ref','revision','criteria','total_points'])||!isGradingId(r.id)||r.question_ref!==question.id||!Number.isSafeInteger(r.revision)||r.revision<1||r.total_points!==question.points||!Array.isArray(r.criteria)||!r.criteria.length||r.criteria.length>20)throw Error('Invalid rubric');
  const keys=new Set<string>();let total=0;
  for(const c of r.criteria){if(!exact(c,['key','label','max_points'])||typeof c.key!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(c.key)||keys.has(c.key)||typeof c.label!=='string'||!c.label.trim()||c.label.length>200||typeof c.max_points!=='string'||!/^\d{1,7}\.\d{2}$/.test(c.max_points)||Number(c.max_points)<=0)throw Error('Invalid criterion');keys.add(c.key);total+=Math.round(Number(c.max_points)*100);}
  if(total!==Math.round(Number(question.points)*100))throw Error('Invalid rubric total');return r;
}

/** Owner reference criteria only. Saving never grades answers or changes an exam. */
export function GradingRubricEditor({question,disabled=false}:{question:{id:string;points:string};disabled?:boolean}){
  const [rubric,setRubric]=useState<Rubric|null>(null),[criteria,setCriteria]=useState<Criterion[]>([{key:'criterion_1',label:'',max_points:question.points}]),[busy,setBusy]=useState(false),[unavailable,setUnavailable]=useState(true),[ended,setEnded]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState<Intent|null>(null),[locked,setLocked]=useState(false);
  const principal=useRef(readCourseSessionPrincipal(localStorage)),dead=useRef(false),flights=useRef(new Set<AbortController>()),working=useRef(false),key=useRef('');
  const end=()=>{dead.current=true;flights.current.forEach(c=>c.abort());setRubric(null);setCriteria([]);setEnded(true);};
  useEffect(()=>{dead.current=false;const actor=JSON.parse(localStorage.getItem('currentUser')??'null')?.id;key.current='grading-rubric-intent:'+actor;
    try{if(!isGradingId(actor))throw Error('Missing identity');const raw=sessionStorage.getItem(key.current);if(raw){const i=JSON.parse(raw);if(!exact(i,['operation_id','question_ref','revision'])||!isGradingId(i.operation_id)||!isGradingId(i.question_ref)||!Number.isSafeInteger(i.revision)||i.revision<1)throw Error('Invalid intent');setPending(i);setLocked(true);}}catch{setLocked(true);setMessage('تعذرت قراءة علامة الاسترجاع؛ لن نرسل حفظًا جديدًا.');}
    const off=subscribeSessionChange(end),storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))end();};window.addEventListener('storage',storage);void load();return()=>{dead.current=true;flights.current.forEach(c=>c.abort());off();window.removeEventListener('storage',storage);};
  },[]);
  async function request(path:string,body?:unknown){
    if(dead.current||!principal.current||principal.current!==readCourseSessionPrincipal(localStorage)){end();throw Error('Session changed');}
    const c=new AbortController();flights.current.add(c);try{return await boundedCenterRequest(c,async()=>{const response=await authenticatedApiFetch('/tenants/me/catalog/grading/'+path,{signal:c.signal,...body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}}),raw=await readAuthenticatedApiJson(response);if(dead.current||principal.current!==readCourseSessionPrincipal(localStorage)){end();throw Error('Session changed');}if(!response.ok)throw new ApiRequestError('Rubric request rejected',response.status);return raw;});}finally{flights.current.delete(c);}
  }
  async function load(){if(working.current||dead.current)return;working.current=true;setBusy(true);setUnavailable(true);setRubric(null);try{const r=parseRubric(await request('questions/'+question.id+'/rubric'),question);if(dead.current)return;setRubric(r);setCriteria(r?.criteria??[{key:'criterion_1',label:'',max_points:question.points}]);setUnavailable(false);}catch{if(!dead.current)setMessage('تعذرت قراءة المعيار الحالي؛ لم نعرض نسخة قديمة أو نسمح بحفظ مبني عليها.');}finally{working.current=false;if(!dead.current)setBusy(false);}}
  function cleanup(){sessionStorage.removeItem(key.current);if(sessionStorage.getItem(key.current)!==null)throw Error('Cleanup failed');setPending(null);setLocked(false);}
  async function save(){if(disabled||working.current||dead.current||locked||unavailable)return;const i:Intent={operation_id:crypto.randomUUID(),question_ref:question.id,revision:(rubric?.revision??0)+1};
    try{sessionStorage.setItem(key.current,JSON.stringify(i));if(sessionStorage.getItem(key.current)!==JSON.stringify(i))throw Error('Storage failed');}catch{setMessage('تعذر حفظ علامة الاسترجاع؛ لم يُرسل الطلب.');return;}
    working.current=true;setBusy(true);setLocked(true);setPending(i);setMessage('');try{const raw=await request('questions/'+question.id+'/rubric',{operation_id:i.operation_id,expected_revision:i.revision-1,criteria});parseReceipt(raw.receipt,i);if(dead.current)return;setMessage('تأكد حفظ إصدار المعيار. تحديث قراءته خطوة منفصلة؛ لم تتغير إجابات أو درجات سابقة.');try{cleanup();}catch{setMessage('الحفظ مؤكد لكن علامة الاسترجاع لم تُنظف؛ افحص الإيصال ولا تعِد الحفظ.');}setUnavailable(true);}catch(e){if(dead.current)return;if(e instanceof ApiRequestError&&[400,401,403,404,409].includes(e.status)){try{cleanup();}catch{}setUnavailable(true);setRubric(null);setMessage('رفض الخادم الحفظ. حدّث المعيار والصلاحية قبل قرار جديد.');}else setMessage('نتيجة حفظ المعيار غير محسومة. افحص الإيصال دون إعادة إرسال الحفظ.');}finally{working.current=false;if(!dead.current)setBusy(false);}
  }
  async function recover(){if(working.current||dead.current||!pending)return;working.current=true;setBusy(true);try{const raw=await request('rubric-operations/'+pending.operation_id);parseReceipt(raw.receipt,pending);if(dead.current)return;setMessage('تأكدت نتيجة الحفظ من الإيصال التاريخي. حدّث قراءة المعيار الحالي.');cleanup();setUnavailable(true);}catch{if(!dead.current)setMessage('لم يثبت الإيصال بعد. لم نكرر الحفظ وعلامة الاسترجاع باقية.');}finally{working.current=false;if(!dead.current)setBusy(false);}}
  if(ended)return<p role="alert">تغيرت الجلسة؛ أُخفي معيار التصحيح.</p>;
  return<section aria-label="معيار تصحيح السؤال" className="space-y-3 rounded border p-3"><h4 className="font-semibold">معيار السؤال — إصدار مرجعي محفوظ</h4><p>مجموع البنود يجب أن يساوي {question.points}. حفظ معيار جديد لا يغير نسخة السؤال أو درجات سابقة ولا يمنح صلاحية لمصحح.</p>{message?<p role="status">{message}</p>:null}
    {pending?<Button disabled={busy} onClick={()=>{void recover();}}>فحص إيصال معيار التصحيح</Button>:null}
    <Button variant="outline" disabled={busy||disabled} onClick={()=>{void load();}}>تحديث معيار السؤال</Button><p>{rubric?'الإصدار المقروء: '+rubric.revision:unavailable?'لا يوجد معيار حالي مثبت في هذه القراءة.':'لا يوجد إصدار محفوظ بعد.'}</p>
    <fieldset disabled={busy||disabled||locked||unavailable} className="space-y-2">{criteria.map((c,index)=><div key={c.key} className="flex flex-wrap gap-2"><label>البند {index+1}<input aria-label={'وصف بند '+(index+1)} maxLength={200} value={c.label} onChange={e=>setCriteria(rows=>rows.map((r,n)=>n===index?{...r,label:e.target.value}:r))}/></label><label>درجته<input aria-label={'درجة بند '+(index+1)} inputMode="decimal" value={c.max_points} onChange={e=>setCriteria(rows=>rows.map((r,n)=>n===index?{...r,max_points:e.target.value}:r))}/></label><Button variant="outline" disabled={criteria.length===1} onClick={()=>setCriteria(rows=>rows.filter((_,n)=>n!==index))}>حذف البند {index+1}</Button></div>)}<Button variant="outline" disabled={criteria.length>=20} onClick={()=>setCriteria(rows=>[...rows,{key:'criterion_'+crypto.randomUUID().replace(/-/g,'').slice(0,20),label:'',max_points:'0.00'}])}>إضافة بند للمعيار</Button><Button onClick={()=>{void save();}}>حفظ إصدار معيار السؤال</Button></fieldset>
  </section>;
}
