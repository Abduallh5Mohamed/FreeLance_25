import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {getAssignedSupportTickets,type SupportTicket} from '@/lib/api-http';
import {subscribeSessionChange} from '@/lib/session-events';
import {readSupportSessionIdentity} from './session';
import {createAssignedQueue,initialAssignedState,type AssignedState} from './assigned-queue';
const statuses:Record<string,string>={open:'جديدة',waiting_on_support:'بانتظار الدعم',waiting_on_user:'بانتظار المستخدم',resolved:'تم الحل',closed:'مغلقة'};
export function SupportAssignedQueue(props:{busyAssignment:boolean;revision:number;onOpen(ticket:SupportTicket):void}){
  const [open,setOpen]=useState(false);
  return <section className="rounded-xl border bg-white p-4" aria-label="طلباتي المسندة"><Button type="button" variant="outline" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'إغلاق الطلبات المسندة لي':'الطلبات المسندة لي'}</Button>
    {open?<AssignedList {...props}/>:null}</section>;
}
function AssignedList({busyAssignment,revision,onOpen}:{busyAssignment:boolean;revision:number;onOpen(ticket:SupportTicket):void}){
  const [state,setState]=useState<AssignedState>(initialAssignedState),ref=useRef<ReturnType<typeof createAssignedQueue>|null>(null);
  useEffect(()=>{
    const controller=createAssignedQueue({read:(after,signal)=>getAssignedSupportTickets(after,signal),readIdentity:readSupportSessionIdentity});ref.current=controller;
    const unsubscribe=controller.subscribe(setState),end=()=>controller.invalidate(),unsubscribeSession=subscribeSessionChange(end);
    const storage=(event:StorageEvent)=>{if(event.key===null||['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession'].includes(event.key))end();};
    window.addEventListener('storage',storage);
    return()=>{window.removeEventListener('storage',storage);unsubscribeSession();unsubscribe();controller.dispose();ref.current=null;};
  },[]);
  useEffect(()=>{if(busyAssignment)ref.current?.suspend();else void ref.current?.refresh();},[busyAssignment,revision]);
  const unavailable=state.phase==='denied'||state.phase==='session-ended',disabled=state.busy||busyAssignment||unavailable;
  return <div className="mt-3 space-y-3 text-sm" aria-live="polite">
    <p>التذاكر المسندة لحسابك الحالي، بما فيها المحلولة والمغلقة. العرض بترتيب ثابت وليس حسب الأولوية. فتح التفاصيل يعيد التحقق من صلاحيتك.</p>
    <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={()=>{void ref.current?.refresh();}}>تحديث الطلبات المسندة</Button>
    {state.busy?<p>جارٍ تحميل الطلبات المسندة…</p>:null}{state.phase==='suspended'?<p>جارٍ التحقق من تغيير التكليف؛ القائمة السابقة مخفية لحين تحديثها.</p>:null}
    {state.error?<p role="alert">{state.error}</p>:null}{unavailable?<p role="alert">تغيّرت الجلسة أو صلاحية قائمة الطلبات. أعد فتح القائمة للتحقق.</p>:null}
    {state.phase==='ready'&&!state.tickets.length?<p>لا توجد تذاكر مسندة لك حاليًا.</p>:null}
    <ul aria-label="قائمة التذاكر المسندة" className="grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2">{state.tickets.map(ticket=><li key={ticket.id}><button type="button" disabled={disabled} onClick={()=>{const current=ref.current?.select(ticket.id);if(current)onOpen(current);}} className="w-full min-w-0 break-words rounded-lg border p-3 text-right hover:bg-slate-50"><span className="block font-medium">{ticket.subject}</span><span className="block text-xs text-slate-500">{ticket.ticket_number} · {statuses[ticket.status]}</span></button></li>)}</ul>
    {state.nextCursor?<Button type="button" size="sm" variant="outline" disabled={disabled} onClick={()=>{void ref.current?.more();}}>عرض طلبات مسندة إضافية</Button>:null}
  </div>;
}
