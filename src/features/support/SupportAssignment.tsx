import {useEffect,useId,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {getSupportAssignment,getSupportAssignmentCandidates,assignSupportTicket,reconcileSupportAssignment} from '@/lib/api-http';
import {subscribeSessionChange} from '@/lib/session-events';
import {readSupportSessionIdentity} from './session';
import {createAssignmentController,initialAssignmentState,type AssignmentState} from './assignment';

export function SupportAssignment(props:{ticketId:string;accountId:string;closed:boolean;onActivity?:(busy:boolean)=>void}){
  const [open,setOpen]=useState(false);
  return <div className="mt-4 border-t pt-3"><Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'إغلاق إدارة المسؤول':'مسؤول التذكرة والتحويل'}</Button>
    {open?<AssignmentEditor key={`${props.accountId}/${props.ticketId}`} {...props}/>:null}</div>;
}
function AssignmentEditor({ticketId,accountId,closed,onActivity}:{ticketId:string;accountId:string;closed:boolean;onActivity?:(busy:boolean)=>void}){
  const [state,setState]=useState<AssignmentState>(initialAssignmentState),[target,setTarget]=useState('');
  const field=useId(),ref=useRef<ReturnType<typeof createAssignmentController>|null>(null);
  useEffect(()=>{
    const storageKey=`tabweb.support.attempt.v1.${encodeURIComponent(accountId)}.assign.${encodeURIComponent(ticketId)}`;
    const controller=createAssignmentController(ticketId,accountId,{
      read:signal=>getSupportAssignment(ticketId,signal),candidates:(after,signal)=>getSupportAssignmentCandidates(ticketId,after,signal),
      send:(input,key,signal)=>assignSupportTicket(ticketId,input,key,signal),reconcile:(key,signal)=>reconcileSupportAssignment(ticketId,key,signal),
      readIdentity:readSupportSessionIdentity,makeKey:()=>crypto.randomUUID(),readKey:()=>{if(!accountId)throw Error('Missing account');return sessionStorage.getItem(storageKey);},
      saveKey:key=>{const previous=sessionStorage.getItem(storageKey);if(previous&&previous!==key)throw Error('Pending assignment');sessionStorage.setItem(storageKey,key);},clearKey:()=>sessionStorage.removeItem(storageKey),
    });
    ref.current=controller;const unsubscribe=controller.subscribe(value=>{setState(value);if(value.phase!=='ready')setTarget('');});
    const end=()=>controller.invalidate(),unsubscribeSession=subscribeSessionChange(end);
    const storage=(event:StorageEvent)=>{if(event.key===null||['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession'].includes(event.key))end();};
    window.addEventListener('storage',storage);void controller.load();
    return()=>{window.removeEventListener('storage',storage);unsubscribeSession();unsubscribe();controller.dispose();ref.current=null;};
  },[ticketId,accountId]);
  const busy=state.busyRead||state.write.busy,retired=state.phase==='denied'||state.phase==='session-ended';
  const operate=async(action:()=>unknown)=>{onActivity?.(true);try{await action();}finally{onActivity?.(false);}};
  const canWrite=state.phase==='ready'&&!busy&&!state.decisionBlocked&&!state.write.blocked&&!state.write.uncertain&&!closed&&(state.snapshot?.assignment.version??2147483647)<2147483647;
  return <section dir="rtl" aria-label="إدارة مسؤول التذكرة" className="mt-3 min-w-0 space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
    <p className="font-semibold">مسؤول المتابعة داخل فريق الدعم</p><p>التكليف ينظم المتابعة، ولا يرسل ردًا للطالب أو يغيّر حالة التذكرة.</p>
    <div aria-live="polite">
      {busy?<p>جارٍ التحقق من البيانات…</p>:null}
      {state.notice?<p className="text-emerald-800">{state.notice}</p>:null}
      {state.readError?<p role="alert">{state.readError}</p>:null}{state.write.error?<p role="alert">{state.write.error}</p>:null}
      {state.phase==='unavailable'?<p>إدارة التكليف غير مهيأة حاليًا.</p>:null}
      {state.phase==='denied'?<p role="alert">لم تعد صلاحية إدارة التكليف متاحة للحساب الحالي.</p>:null}
      {state.phase==='session-ended'?<p role="alert">تغيّرت الجلسة. أعد فتح اللوحة للتحقق من الحساب الحالي.</p>:null}
      {closed||state.decisionBlocked?<p>التذكرة مغلقة؛ يمكنك التحقق من قرار سابق دون تكليف جديد.</p>:null}
      {state.snapshot?<p className="break-words">المسؤول الحالي: <strong dir="auto">{state.snapshot.assignee?.name||(state.snapshot.assignment.assigned_to?'المسؤول السابق لم يعد متاحًا للتكليف':'لم يُحدد مسؤول')}</strong></p>:null}
    </div>
    <Button type="button" size="sm" variant="outline" disabled={busy||retired} onClick={()=>{void ref.current?.load();}}>تحديث حالة التكليف</Button>
    {state.write.uncertain?<div className="space-y-2 rounded border border-amber-300 bg-white p-3"><p>نتيجة محاولة التكليف غير مؤكدة. التحقق يستعلم عن القرار السابق، ثم يعرض الحالة الحالية دون قرار جديد.</p>
      <Button type="button" size="sm" disabled={busy||retired||state.write.blocked} onClick={()=>{void operate(()=>ref.current?.reconcile());}}>التحقق من نتيجة التكليف</Button>
      {state.canRetry?<Button type="button" size="sm" variant="outline" disabled={busy||retired||state.write.blocked} onClick={()=>{void operate(()=>ref.current?.retry());}}>إعادة نفس محاولة التكليف</Button>:null}
    </div>:null}
    {state.phase==='ready'?<div className="space-y-2">
      <Button type="button" size="sm" disabled={!canWrite||state.snapshot?.assignment.assigned_to===accountId} onClick={()=>{void operate(()=>ref.current?.save(accountId));}}>تولّي متابعة التذكرة</Button>
      <label htmlFor={field} className="block">المسؤول الجديد</label><select id={field} value={target} onChange={event=>setTarget(event.target.value)} disabled={!canWrite} className="w-full min-w-0 rounded border bg-white p-2"><option value="">اختر مسؤولًا من فريق الدعم</option>{state.candidates.map(row=><option key={row.id} value={row.id}>{row.name||'عضو فريق الدعم'}</option>)}</select>
      {state.nextCursor?<Button type="button" size="sm" variant="outline" disabled={busy||retired} onClick={()=>{void ref.current?.loadMore();}}>عرض مسؤولين إضافيين</Button>:null}
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!canWrite||!target} onClick={()=>{void operate(()=>ref.current?.save(target));}}>حفظ المسؤول المختار</Button>
      <Button type="button" size="sm" variant="outline" disabled={!canWrite||!state.snapshot?.assignment.assigned_to} onClick={()=>{void operate(()=>ref.current?.save(null));}}>إلغاء التكليف</Button></div>
    </div>:null}
  </section>;
}
