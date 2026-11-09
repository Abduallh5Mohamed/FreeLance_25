import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import type {SupportTicket} from '@/lib/api-http';
import {subscribeSessionChange} from '@/lib/session-events';
import {readSupportSessionIdentity} from './session';
import {createFollowupQueue,initialFollowup,readFollowup,type FollowupFilters} from './follow-up';

export function SupportFollowupQueue(props:{busyActivity:boolean;revision:number;onOpen(ticket:SupportTicket):void}){
    const [open,setOpen]=useState(false);
    return <section className="rounded-xl border bg-white p-4" aria-label="متابعة طلبات الدعم"><Button variant="outline" type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{open?'إغلاق متابعة الطلبات':'متابعة الطلبات حسب آخر تحديث'}</Button>{open?<FollowupList {...props}/>:null}</section>;
}
export function FollowupList({busyActivity,revision,onOpen}:{busyActivity:boolean;revision:number;onOpen(ticket:SupportTicket):void}){
    const [state,setState]=useState(initialFollowup),ref=useRef<ReturnType<typeof createFollowupQueue>|null>(null);
    useEffect(()=>{const c=createFollowupQueue({read:readFollowup,readIdentity:readSupportSessionIdentity});ref.current=c;const unsub=c.subscribe(setState),unsubSession=subscribeSessionChange(()=>c.invalidate());
        const storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession'].includes(e.key))c.invalidate();};window.addEventListener('storage',storage);
        return()=>{window.removeEventListener('storage',storage);unsubSession();unsub();c.dispose();ref.current=null;};},[]);
    useEffect(()=>{if(busyActivity)ref.current?.suspend();else ref.current?.resume();},[busyActivity,revision]);
    const ended=state.phase==='session-ended',disabled=busyActivity||ended;
    const change=(patch:Partial<FollowupFilters>)=>ref.current?.filters({...state.filters,...patch});
    return <div className="mt-4 space-y-3 text-sm" aria-live="polite">
        <p>الترتيب بالأقدم تحديثًا داخل الفلتر. المدة اختيار متابعة، وليست وعدًا بزمن استجابة أو إثبات انتظار رد. الملاحظات الداخلية وتغيير المسؤول لا يجددان وقت تحديث التذكرة.</p>
        <div className="flex flex-wrap gap-3"><label>المسؤول <select aria-label="مسؤول المتابعة" disabled={disabled} value={state.filters.scope} onChange={e=>change({scope:e.target.value as FollowupFilters['scope']})}><option value="mine">المسند لي</option><option value="unassigned">بلا مسؤول</option></select></label>
            <label>الحالة <select aria-label="حالة المتابعة" disabled={disabled} value={state.filters.status} onChange={e=>change({status:e.target.value as FollowupFilters['status']})}><option value="needs_support">جديدة أو بانتظار الدعم</option><option value="waiting_on_user">بانتظار المستخدم</option></select></label>
            <label>بدون تحديث منذ <select aria-label="مدة عدم التحديث" disabled={disabled} value={state.filters.min_hours} onChange={e=>change({min_hours:Number(e.target.value) as FollowupFilters['min_hours']})}><option value={0}>أي مدة</option><option value={24}>٢٤ ساعة</option><option value={72}>٣ أيام</option><option value={168}>٧ أيام</option></select></label>
            <Button type="button" variant="outline" disabled={disabled||state.phase==='loading'} onClick={()=>{void ref.current?.refresh();}}>تحديث نافذة المتابعة</Button></div>
        {state.phase==='loading'?<p role="status">جارٍ التحقق؛ أُخفيت الصفحة السابقة.</p>:null}
        {state.phase==='suspended'?<p role="status">جارٍ إجراء محلي على الطلبات؛ المتابعة مخفية حتى إعادة التحقق.</p>:null}
        {ended||state.phase==='denied'?<p role="alert">تغيرت الجلسة أو صلاحية المتابعة. أعد فتح القائمة للتحقق.</p>:null}
        {state.phase==='unavailable'?<p role="alert">مصدر المتابعة أو فهرسها غير جاهز. لا نعرض قائمة قديمة أو نتيجة فارغة مفترضة.</p>:null}
        {state.phase==='error'?<p role="alert">تعذر التحقق من الصفحة أو انتهت نافذة التصفح. اضغط تحديث نافذة المتابعة للبدء من جديد.</p>:null}
        {state.page?<><p>مرجع حساب المدة: {new Date(state.page.as_of).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})} القاهرة. الصفحات تحتفظ بهذا المرجع لمدة تصل إلى ٣٠ دقيقة، وليست لقطة ثابتة للتذاكر.</p>
            {!state.page.tickets.length?<p>لا توجد طلبات مطابقة في هذه الصفحة. المحلولة والمغلقة خارج الفلتر، وتغييرات الآخرين تحتاج تحديثًا.</p>:<ul className="grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2">{state.page.tickets.map(t=><li key={t.id}><button className="w-full rounded border p-3 text-right" type="button" disabled={disabled} onClick={()=>{const row=ref.current?.select(t.id);if(row)onOpen(row);}}><strong className="block">{t.subject}</strong><span>{t.ticket_number} — {t.status==='open'?'جديدة':t.status==='waiting_on_support'?'بانتظار الدعم':'بانتظار المستخدم'}</span><span className="block">آخر تحديث منذ {Math.floor((Date.parse(state.page!.as_of)-Date.parse(t.updated_at))/3600000)} ساعة — <time dateTime={t.updated_at}>{new Date(t.updated_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})}</time></span></button></li>)}</ul>}
            {state.page.next_cursor?<Button type="button" variant="outline" disabled={disabled||state.phase==='loading'} onClick={()=>{void ref.current?.next();}}>صفحة المتابعة التالية</Button>:null}</>:null}
        <p>فتح التفاصيل يعيد التحقق من الصلاحية؛ الإسناد أو التحويل يتم من إجراءات الطلب الحالية. لا توجد متابعة تلقائية أو رسالة مرسلة من هذه القائمة.</p>
    </div>;
}
