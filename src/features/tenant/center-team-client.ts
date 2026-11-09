import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
import { readCourseSessionPrincipal } from '../catalog/course-management';
import { subscribeSessionChange } from '../../lib/session-events';
import { boundedRequest as boundedCenterRequest } from '../../lib/bounded-request';
export { boundedRequest as boundedCenterRequest } from '../../lib/bounded-request';
export const teamUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
export const teamPermissions = ['groups.read','attendance.mark','tasks.manage'] as const;
export const permissionLabels: Record<string,string> = {'groups.read':'قراءة مجموعات الفروع المختارة','attendance.mark':'تسجيل وتصحيح الحضور','tasks.manage':'متابعة طلبات التشغيل المسندة'};
export const taskStatusLabels:Record<string,string>={open:'مفتوح',in_progress:'قيد المتابعة',resolved:'منجز'};
export interface TeamMember { id:string; name:string; permissions:string[]; branch_ids:string[]; status:'active'|'suspended'; version:number }
export interface TeamTask { id:string; branch_id:string; assigned_member_id:string; title:string; status:'open'|'in_progress'|'resolved'; version:number; due_at:string|null; overdue:boolean }
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
export function parseTeamOwner(v:any):{members:TeamMember[];branches:Array<{id:string;name:string}>}{
  if(!object(v)||Object.keys(v).sort().join(',')!=='branches,members'||!Array.isArray(v.members)||v.members.length>100||!Array.isArray(v.branches)||v.branches.length>100)throw Error('Invalid team list');
  for(const b of v.branches)if(!object(b)||Object.keys(b).sort().join(',')!=='id,name'||!teamUuid(b.id)||typeof b.name!=='string'||b.name.length>255)throw Error('Invalid team branch');
  for(const m of v.members)if(!object(m)||Object.keys(m).sort().join(',')!=='branch_ids,id,name,permissions,status,version'||!teamUuid(m.id)||typeof m.name!=='string'||m.name.length>100||!['active','suspended'].includes(m.status)||!Number.isSafeInteger(m.version)||m.version<0||!Array.isArray(m.permissions)||!m.permissions.length||new Set(m.permissions).size!==m.permissions.length||m.permissions.some((p:any)=>!teamPermissions.includes(p))||!Array.isArray(m.branch_ids)||m.branch_ids.length>20||m.branch_ids.some((b:any)=>!teamUuid(b))||new Set(m.branch_ids).size!==m.branch_ids.length)throw Error('Invalid team member');
  if(new Set(v.members.map((m:any)=>m.id)).size!==v.members.length||new Set(v.branches.map((b:any)=>b.id)).size!==v.branches.length)throw Error('Duplicate team IDs');return v;
}
export function parseTeamTasks(v:any):{tasks:TeamTask[];next_cursor:string|null}{
  if(!object(v)||Object.keys(v).sort().join(',')!=='next_cursor,tasks'||!Array.isArray(v.tasks)||v.tasks.length>25)throw Error('Invalid tasks');
  for(const q of v.tasks)if(!object(q)||Object.keys(q).sort().join(',')!=='assigned_member_id,branch_id,due_at,id,overdue,status,title,version'||![q.id,q.branch_id,q.assigned_member_id].every(teamUuid)||typeof q.title!=='string'||q.title.length>200||!['open','in_progress','resolved'].includes(q.status)||!Number.isSafeInteger(q.version)||q.version<0||typeof q.overdue!=='boolean'||q.due_at!==null&&(typeof q.due_at!=='string'||!Number.isFinite(Date.parse(q.due_at))||new Date(q.due_at).toISOString()!==q.due_at))throw Error('Invalid task');
  if(v.next_cursor!==null&&(!teamUuid(v.next_cursor)||v.tasks.length!==25||v.tasks[24].id!==v.next_cursor)||new Set(v.tasks.map((q:any)=>q.id)).size!==v.tasks.length)throw Error('Invalid task cursor');return v;
}
export function parseCenterReceipt(v:any){
  if(!object(v))throw Error('Invalid center receipt');
  if(v.ok===true&&object(v.outcome)&&teamUuid(v.outcome.id)&&teamUuid(v.outcome.student_id)&&['present','absent','late','excused'].includes(v.outcome.state)&&['created','unchanged','corrected'].includes(v.outcome.outcome)&&Object.keys(v).join(',')==='ok,outcome')return v;
  if(Object.keys(v).sort().join(',')!=='id,kind,status,version'||!teamUuid(v.id)||!Number.isSafeInteger(v.version)||v.version<0||!['member.created','member.access','member.password','task.created','task.assigned','task.status','operation.retired'].includes(v.kind)||!['active','suspended','open','in_progress','resolved','retired'].includes(v.status))throw Error('Invalid center receipt');return v;
}
/** One opaque intent per actor. No password, phone, file, notes or scoped token in browser storage. */
export function useCenterTeamClient(onEnd:()=>void){
  const identity=useRef(readCourseSessionPrincipal(localStorage)),ended=useRef(false),flights=useRef(new Set<AbortController>()),writing=useRef(false);
  const actor=JSON.parse(localStorage.getItem('currentUser')??'null')?.id,storeKey='center-team-intent:'+actor;
  const [busy,setBusy]=useState(false),[pending,setPending]=useState<string|null>(()=>{try{const k=sessionStorage.getItem(storeKey);return k&&teamUuid(k)?k:k?'invalid':null;}catch{return'invalid';}}),[notice,setNotice]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  const stop=useCallback(()=>{if(ended.current)return;ended.current=true;flights.current.forEach(c=>c.abort());onEnd();setNotice(null);setError('تغيرت الجلسة؛ أُخفيت بيانات الفريق. افتح الصفحة من جديد.');},[onEnd]);
  useEffect(()=>{ended.current=false;const off=subscribeSessionChange(stop),storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))stop();};window.addEventListener('storage',storage);return()=>{ended.current=true;flights.current.forEach(c=>c.abort());off();window.removeEventListener('storage',storage);};},[stop]);
  const request=useCallback(async(path:string,body?:unknown,key?:string)=>{
    if(ended.current||!identity.current||identity.current!==readCourseSessionPrincipal(localStorage)){stop();throw Error('Session changed');}
    if(!/^\/team\/[A-Za-z0-9/?=&._-]+$/.test(path))throw Error('Invalid center path');
    const c=new AbortController();flights.current.add(c);
    try{return await boundedCenterRequest(c,async()=>{const response=await authenticatedApiFetch('/tenants/me/catalog'+path,{signal:c.signal,...body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',...key?{'Idempotency-Key':key}:{}},body:JSON.stringify(body)}});const raw=await readAuthenticatedApiJson(response);if(ended.current||identity.current!==readCourseSessionPrincipal(localStorage)){stop();throw Error('Session changed');}if(c.signal.aborted)throw Error('Center request interrupted');if(!response.ok)throw new ApiRequestError('Center request failed',response.status,object(raw)?raw.code:undefined);return raw;});}finally{flights.current.delete(c);}
  },[stop]);
  const cleanup=()=>{sessionStorage.removeItem(storeKey);if(sessionStorage.getItem(storeKey)!==null)throw Error('Intent cleanup failed');setPending(null);};
  async function write(path:string,body:unknown){
    if(writing.current||pending||ended.current)return false;writing.current=true;setBusy(true);setNotice(null);setError(null);let key:string|undefined;
    try{key=crypto.randomUUID();sessionStorage.setItem(storeKey,key);if(sessionStorage.getItem(storeKey)!==key)throw Error('Intent unavailable');setPending(key);
      const raw=await request(path,body,key);const receipt=parseCenterReceipt(raw?.receipt??(raw?.id?{ok:true,outcome:{id:raw.id,student_id:body&&typeof body==='object'?(body as any).student_id:null,state:raw.state,outcome:raw.outcome}}:null));
      setNotice(receipt.ok?'تأكد حفظ الحضور. أعد قراءة القائمة لمعرفة الحالة الحالية.':'تأكد حفظ العملية. الإيصال تاريخي؛ أعد قراءة الحالة الحالية.');
      try{cleanup();}catch{setError('الحفظ مؤكد لكن تعذر تنظيف علامة الاسترجاع. لا تعِد الكتابة؛ افحص الإيصال.');}return true;
    }catch(e){if(ended.current)return false;if(e instanceof ApiRequestError&&e.status>=400&&e.status<500){try{cleanup();}catch{}setError('رفض الخادم العملية. راجع الصلاحية أو الإصدار أو البيانات ثم حدّث الحالة.');}else setError(key?'تعذر تأكيد نتيجة الكتابة. افحص إيصال العملية قبل أي إعادة؛ لن نكررها تلقائيًا.':'تعذر حفظ علامة الاسترجاع؛ لم نرسل الطلب.');return false;}
    finally{writing.current=false;if(!ended.current)setBusy(false);}
  }
  async function recover(){if(!pending||!teamUuid(pending)||ended.current)return;setBusy(true);try{const r=await request('/team/operations/'+pending);if(!r.receipt){setError('لا يوجد إيصال ظاهر الآن؛ قد تكون الكتابة معلقة. لا نبدأ عملية أخرى تلقائيًا.');return;}parseCenterReceipt(r.receipt);setNotice('تأكدت نتيجة العملية من إيصالها. حدّث القوائم لمعرفة الحالة الحالية.');cleanup();setError(null);}catch{if(!ended.current)setError('تعذر استرجاع الإيصال. لم نكرر الكتابة.');}finally{if(!ended.current)setBusy(false);}}
  async function retire(){if(!pending||!teamUuid(pending)||ended.current)return;setBusy(true);try{const r=await request('/team/operations/'+pending+'/retire',{}),receipt=parseCenterReceipt(r.receipt);setNotice(receipt.kind==='operation.retired'?'أُغلق معرف الطلب على الخادم؛ لن يقبل كتابة متأخرة به. راجع الحالة قبل طلب جديد.':'العملية كانت محفوظة بالفعل؛ الإيصال تاريخي. راجع الحالة قبل أي طلب جديد.');cleanup();setError(null);}catch{if(!ended.current)setError('تعذر تأكيد إغلاق الطلب؛ علامة الاسترجاع باقية.');}finally{if(!ended.current)setBusy(false);}}
  return{request,write,recover,retire,busy,pending,notice,error,ended:ended.current,setError};
}
