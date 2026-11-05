import {createSupportAttempt,type SupportAttemptState} from './write-attempt';
export interface SupportPrivateNote {id:string;ticket_id:string;author_id:string;author_name:string;body:string;created_at:string}
export interface PrivateNotePage {notes:SupportPrivateNote[];next_cursor:string|null}
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
export function parseSupportPrivateNote(value:unknown,ticketId:string):SupportPrivateNote{
  if(!exact(value,['id','ticket_id','author_id','author_name','body','created_at'])||typeof value.id!=='string'||!uuid.test(value.id)||value.ticket_id!==ticketId
    ||typeof value.author_id!=='string'||!value.author_id||value.author_id.length>36||typeof value.author_name!=='string'||value.author_name.length>255
    ||typeof value.body!=='string'||!value.body.trim()||value.body.length>10000||typeof value.created_at!=='string'
    ||!Number.isFinite(Date.parse(value.created_at))||new Date(value.created_at).toISOString()!==value.created_at)throw Error('استجابة الملاحظة الداخلية غير صالحة.');
  return {id:value.id,ticket_id:ticketId,author_id:value.author_id,author_name:value.author_name,body:value.body,created_at:value.created_at};
}
export function parsePrivateNotePage(value:unknown,ticketId:string):PrivateNotePage{
  if(!exact(value,['notes','next_cursor'])||!Array.isArray(value.notes)||value.notes.length>100||!(value.next_cursor===null||typeof value.next_cursor==='string'&&uuid.test(value.next_cursor)))throw Error('استجابة الملاحظات الداخلية غير صالحة.');
  const notes=value.notes.map(row=>parseSupportPrivateNote(row,ticketId));
  if(new Set(notes.map(row=>row.id)).size!==notes.length||value.next_cursor!==null&&(notes.length!==100||value.next_cursor!==notes[0].id))throw Error('صفحة الملاحظات الداخلية غير صالحة.');
  return {notes,next_cursor:value.next_cursor as string|null};
}
export function parsePrivateNoteAck(value:unknown,ticketId:string){
  if(!exact(value,['note','unchanged'])||typeof value.unchanged!=='boolean')throw Error('تعذّر تأكيد الملاحظة الداخلية.');
  return {note:parseSupportPrivateNote(value.note,ticketId),unchanged:value.unchanged};
}
export interface PrivateNotesState {
  phase:'idle'|'loading'|'ready'|'error'|'unavailable'|'denied'|'session-ended';notes:SupportPrivateNote[];nextCursor:string|null;busyRead:boolean;
  readError:string|null;notice:string|null;write:SupportAttemptState;
}
export const initialPrivateNotesState=():PrivateNotesState=>({phase:'idle',notes:[],nextCursor:null,busyRead:false,readError:null,notice:null,write:{busy:false,uncertain:false,locked:false,error:null,blocked:false}});
export function createPrivateNotesController(ticketId:string,deps:{
  list(before:string|null,signal:AbortSignal):Promise<unknown>;send(body:string,key:string,signal:AbortSignal):Promise<unknown>;reconcile(key:string,signal:AbortSignal):Promise<unknown>;
  readKey():string|null;saveKey(key:string):void;clearKey():void;makeKey():string;readIdentity():string|null;
}){
  let state=initialPrivateNotesState(),generation=0,ended=false,confirmed=false,abort:AbortController|null=null;
  const identity=deps.readIdentity(),listeners=new Set<(value:PrivateNotesState)=>void>();
  const set=(patch:Partial<PrivateNotesState>)=>{state={...state,...patch};listeners.forEach(fn=>fn(state));};
  const retire=(phase:'denied'|'session-ended')=>{ended=true;confirmed=false;generation++;abort?.abort();set({...initialPrivateNotesState(),phase});attempt.invalidate();};
  const alive=()=>{if(ended)return false;if(!identity||identity!==deps.readIdentity()){retire('session-ended');return false;}return true;};
  const current=(ticket:number)=>ticket===generation&&alive();
  const denied=(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'&&[401,403,404].includes(error.status);
  const attempt=createSupportAttempt<string,ReturnType<typeof parsePrivateNoteAck>>({...deps,
    send:async(body,key,signal)=>{const ack=parsePrivateNoteAck(await deps.send(body,key,signal),ticketId);if(ack.note.body!==body)throw Error('Private note body mismatch');return ack;},
    reconcile:async(key,signal)=>parsePrivateNoteAck(await deps.reconcile(key,signal),ticketId),onDenied:()=>retire('denied'),
  });
  const unsubscribe=attempt.subscribe(write=>set({write}));
  const load=async()=>{
    if(!alive()||attempt.getState().busy)return;
    const ticket=++generation;abort?.abort();abort=new AbortController();set({phase:'loading',notes:[],nextCursor:null,busyRead:true,readError:null});
    try{const raw=await deps.list(null,abort.signal);if(!current(ticket))return;const page=parsePrivateNotePage(raw,ticketId);set({phase:'ready',notes:page.notes,nextCursor:page.next_cursor,notice:confirmed?'تم تأكيد حفظ الملاحظة داخل فريق الدعم.':null});}
    catch(error){if(current(ticket)){
      if(denied(error))retire('denied');
      else {const unavailable=!!error&&typeof error==='object'&&'code'in error&&error.code==='SUPPORT_NOTES_UNAVAILABLE';set({phase:unavailable?'unavailable':'error',notes:[],nextCursor:null,readError:unavailable?'الملاحظات الداخلية غير مهيأة حاليًا.':'تعذّر تحميل الملاحظات الداخلية. حدّث القائمة للتحقق.'});}
    }}finally{if(current(ticket))set({busyRead:false});}
  };
  const confirm=async(ack:ReturnType<typeof parsePrivateNoteAck>|null)=>{
    if(!ack||!alive())return null;
    confirmed=true;
    set({notice:'تم تأكيد حفظ الملاحظة داخل فريق الدعم.'});await load();
    if(!alive())return null;
    if(state.phase==='error'||state.phase==='unavailable')set({notice:'حفظ الملاحظة مؤكد، لكن تعذّر تحديث قائمة الملاحظات. حدّث القائمة ولا تعِد إرسالها.'});
    return ack;
  };
  return {getState:()=>state,subscribe(fn:(value:PrivateNotesState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},load,
    async loadOlder(){
      if(!alive()||state.phase!=='ready'||state.busyRead||attempt.getState().busy||!state.nextCursor)return;
      const before=state.nextCursor,ticket=generation;abort?.abort();abort=new AbortController();set({busyRead:true,readError:null});
      try{const raw=await deps.list(before,abort.signal);if(!current(ticket))return;const page=parsePrivateNotePage(raw,ticketId);
        if(page.next_cursor===before||page.notes.some(row=>state.notes.some(existing=>existing.id===row.id)))throw Error('Overlapping private page');
        set({notes:[...page.notes,...state.notes],nextCursor:page.next_cursor});
      }catch(error){if(current(ticket)){if(denied(error))retire('denied');else set({readError:'تعذّر تحميل الملاحظات الأقدم. يمكنك إعادة المحاولة.'});}}
      finally{if(current(ticket))set({busyRead:false});}
    },
    async save(value:string){
      if(!alive()||state.phase!=='ready'||state.busyRead||attempt.getState().busy)return null;
      confirmed=false;
      const body=value.trim();if(!body||body.length>10000){set({notice:'اكتب ملاحظة من ١ إلى ١٠٠٠٠ حرف قبل الحفظ.'});return null;}
      set({notice:null});
      return confirm(await attempt.send(body));
    },
    async reconcile(){if(!alive()||state.busyRead||attempt.getState().busy)return null;confirmed=false;set({notice:null});return confirm(await attempt.reconcile());},
    invalidate:()=>retire('session-ended'),
    dispose(){listeners.clear();unsubscribe();ended=true;generation++;abort?.abort();attempt.dispose();state={...initialPrivateNotesState(),phase:'session-ended'};},
  };
}
