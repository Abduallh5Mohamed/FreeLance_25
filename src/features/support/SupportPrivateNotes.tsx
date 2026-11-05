import {useEffect,useId,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {getSupportPrivateNotes,addSupportPrivateNote,reconcileSupportPrivateNote} from '@/lib/api-http';
import {subscribeSessionChange} from '@/lib/session-events';
import {readSupportSessionIdentity} from './session';
import {createPrivateNotesController,initialPrivateNotesState,type PrivateNotesState} from './private-notes';

export function SupportPrivateNotes(props:{ticketId:string;accountId:string}){
  const [open,setOpen]=useState(false);
  return <div className="mt-4 border-t pt-3">
    <Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'إغلاق الملاحظات الداخلية':'ملاحظات فريق الدعم'}</Button>
    {open?<PrivateNotesEditor key={`${props.accountId}/${props.ticketId}`} {...props}/>:null}
  </div>;
}
export function PrivateNotesEditor({ticketId,accountId}:{ticketId:string;accountId:string}){
  const [state,setState]=useState<PrivateNotesState>(initialPrivateNotesState),[body,setBody]=useState('');
  const fieldId=useId();
  const ref=useRef<ReturnType<typeof createPrivateNotesController>|null>(null);
  useEffect(()=>{
    const storageKey=`tabweb.support.attempt.v1.${encodeURIComponent(accountId)}.note.${encodeURIComponent(ticketId)}`;
    const controller=createPrivateNotesController(ticketId,{
      list:(before,signal)=>getSupportPrivateNotes(ticketId,before,signal),send:(text,key,signal)=>addSupportPrivateNote(ticketId,text,key,signal),reconcile:(key,signal)=>reconcileSupportPrivateNote(ticketId,key,signal),
      readIdentity:readSupportSessionIdentity,makeKey:()=>crypto.randomUUID(),
      readKey:()=>{if(!accountId)throw Error('Missing account');return sessionStorage.getItem(storageKey);},
      saveKey:key=>{const previous=sessionStorage.getItem(storageKey);if(previous&&previous!==key)throw Error('Pending note attempt');sessionStorage.setItem(storageKey,key);},clearKey:()=>sessionStorage.removeItem(storageKey),
    });
    ref.current=controller;const unsubscribe=controller.subscribe(value=>{setState(value);if(value.phase==='denied'||value.phase==='session-ended')setBody('');});
    const end=()=>controller.invalidate(),unsubscribeSession=subscribeSessionChange(end);
    const storage=(event:StorageEvent)=>{if(event.key===null||['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession'].includes(event.key))end();};
    window.addEventListener('storage',storage);void controller.load();
    return()=>{window.removeEventListener('storage',storage);unsubscribeSession();unsubscribe();controller.dispose();ref.current=null;};
  },[ticketId,accountId]);
  const busy=state.busyRead||state.write.busy,canWrite=state.phase==='ready'&&!busy&&!state.write.blocked;
  return <section dir="rtl" aria-label="ملاحظات داخلية لفريق الدعم" className="mt-3 min-w-0 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
    <p className="font-semibold">ملاحظات داخلية — لفريق الدعم المخوّل فقط</p>
    <p>هذه الملاحظات لا تُرسل لصاحب التذكرة. استخدم خانة الرد العلني للتواصل معه.</p>
    <div aria-live="polite">
      {busy?<p>جارٍ تنفيذ العملية…</p>:null}
      {state.notice?<p className="text-emerald-800">{state.notice}</p>:null}
      {state.readError?<p role="alert" className="text-amber-900">{state.readError}</p>:null}
      {state.write.error?<p role="alert" className="text-red-700">{state.write.error}</p>:null}
      {state.phase==='denied'?<p role="alert">لا تتوفر صلاحية ملاحظات فريق الدعم للحساب الحالي.</p>:null}
      {state.phase==='session-ended'?<p role="alert">تغيّرت الجلسة. أغلق اللوحة وافتحها للتحقق من الحساب الحالي.</p>:null}
    </div>
    {state.notes.length?<ol className="max-h-80 space-y-2 overflow-y-auto" aria-label="قائمة الملاحظات الداخلية">{state.notes.map(note=><li key={note.id} className="break-words rounded border border-amber-200 bg-white p-3">
      <p className="font-medium" dir="auto">{note.author_name||'عضو فريق الدعم'}</p><p className="mt-1 whitespace-pre-wrap" dir="auto">{note.body}</p><p className="mt-1 text-xs text-slate-500">{new Date(note.created_at).toLocaleString('ar-EG')}</p>
    </li>)}</ol>:state.phase==='ready'?<p>لا توجد ملاحظات داخلية حتى الآن.</p>:null}
    {state.nextCursor?<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>{void ref.current?.loadOlder();}}>عرض ملاحظات أقدم</Button>:null}
    <Button type="button" variant="outline" size="sm" disabled={busy||state.phase==='denied'||state.phase==='session-ended'} onClick={()=>{void ref.current?.load();}}>تحديث الملاحظات الداخلية</Button>
    {state.write.uncertain?<div className="space-y-2 rounded border border-amber-300 bg-white p-3"><p>نتيجة محاولة الملاحظة غير مؤكدة. التحقق يستعلم عن نتيجتها دون حفظ ملاحظة جديدة.</p><Button type="button" size="sm" variant="outline" disabled={busy||state.write.blocked||state.phase==='denied'||state.phase==='session-ended'} onClick={async()=>{if(await ref.current?.reconcile())setBody('');}}>التحقق من نتيجة الملاحظة</Button></div>:null}
    {state.phase==='ready'?<form className="space-y-2" onSubmit={async event=>{event.preventDefault();if(await ref.current?.save(body))setBody('');}}>
      <label htmlFor={fieldId} className="block">نص الملاحظة الداخلية</label><Textarea id={fieldId} value={body} onChange={event=>setBody(event.target.value)} disabled={!canWrite||state.write.locked} maxLength={10000} required className="mt-1 min-h-24 bg-white"/>
      <Button type="submit" size="sm" disabled={!canWrite||!body.trim()}>{state.write.uncertain?'إعادة نفس الملاحظة الداخلية':'حفظ ملاحظة داخلية'}</Button>
    </form>:null}
  </section>;
}
