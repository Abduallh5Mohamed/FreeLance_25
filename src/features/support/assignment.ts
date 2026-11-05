import {createSupportAttempt,type SupportAttemptState} from './write-attempt';
export interface Assignment {ticket_id:string;assigned_to:string|null;version:number}
export interface Recipient {id:string;name:string}
export interface AssignmentSnapshot {assignment:Assignment;assignee:Recipient|null}
export interface CandidatePage {candidates:Recipient[];next_cursor:string|null}
export interface AssignmentAck {assignment:Assignment;changed:boolean;unchanged:boolean}
export interface AssignmentInput {assigned_to:string|null;expected_version:number}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,36}$/.test(value);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
function assignment(value:unknown,ticketId:string):Assignment{
  if(!exact(value,['ticket_id','assigned_to','version'])||value.ticket_id!==ticketId||!(value.assigned_to===null||id(value.assigned_to))||typeof value.version!=='number'||!Number.isSafeInteger(value.version)||value.version<0||value.version>2147483647)throw Error('Invalid support assignment');
  return {ticket_id:ticketId,assigned_to:value.assigned_to as string|null,version:value.version};
}
function recipient(value:unknown):Recipient{
  if(!exact(value,['id','name'])||!id(value.id)||typeof value.name!=='string'||value.name.length>255)throw Error('Invalid support recipient');
  return {id:value.id,name:value.name};
}
export function parseAssignmentSnapshot(value:unknown,ticketId:string):AssignmentSnapshot{
  if(!exact(value,['assignment','assignee']))throw Error('Invalid support assignment snapshot');
  const state=assignment(value.assignment,ticketId),person=value.assignee===null?null:recipient(value.assignee);
  if(person&&person.id!==state.assigned_to)throw Error('Support assignee mismatch');
  return {assignment:state,assignee:person};
}
export function parseAssignmentAck(value:unknown,ticketId:string):AssignmentAck{
  if(!exact(value,['assignment','changed','unchanged'])||typeof value.changed!=='boolean'||typeof value.unchanged!=='boolean')throw Error('Invalid assignment acknowledgement');
  return {assignment:assignment(value.assignment,ticketId),changed:value.changed,unchanged:value.unchanged};
}
export function parseCandidatePage(value:unknown):CandidatePage{
  if(!exact(value,['candidates','next_cursor'])||!Array.isArray(value.candidates)||value.candidates.length>25||!(value.next_cursor===null||id(value.next_cursor)))throw Error('Invalid recipient page');
  const candidates=value.candidates.map(recipient);
  if(new Set(candidates.map(row=>row.id.toLowerCase())).size!==candidates.length||value.next_cursor!==null&&(candidates.length!==25||value.next_cursor!==candidates[24].id))throw Error('Invalid recipient cursor');
  return {candidates,next_cursor:value.next_cursor as string|null};
}
export const definitiveAssignmentRejection=(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===409&&'code'in error
  &&['SUPPORT_ASSIGNMENT_STALE','SUPPORT_TICKET_CLOSED','SUPPORT_ASSIGNEE_UNAVAILABLE'].includes(String(error.code));
export interface AssignmentState {
  phase:'idle'|'loading'|'ready'|'error'|'unavailable'|'denied'|'session-ended';snapshot:AssignmentSnapshot|null;candidates:Recipient[];nextCursor:string|null;
  busyRead:boolean;readError:string|null;notice:string|null;canRetry:boolean;decisionBlocked:boolean;write:SupportAttemptState;
}
export const initialAssignmentState=():AssignmentState=>({phase:'idle',snapshot:null,candidates:[],nextCursor:null,busyRead:false,readError:null,notice:null,canRetry:false,decisionBlocked:false,write:{busy:false,uncertain:false,locked:false,error:null,blocked:false}});
export function createAssignmentController(ticketId:string,accountId:string,deps:{
  read(signal:AbortSignal):Promise<unknown>;candidates(after:string|null,signal:AbortSignal):Promise<unknown>;
  send(input:AssignmentInput,key:string,signal:AbortSignal):Promise<unknown>;reconcile(key:string,signal:AbortSignal):Promise<unknown>;
  readIdentity():string|null;readKey():string|null;saveKey(key:string):void;clearKey():void;makeKey():string;
}){
  let state=initialAssignmentState(),ended=false,generation=0,abort:AbortController|null=null,pending:AssignmentInput|null=null,confirmed=false,rejected=false;
  const identity=deps.readIdentity(),listeners=new Set<(value:AssignmentState)=>void>();
  const set=(patch:Partial<AssignmentState>)=>{state={...state,...patch};listeners.forEach(fn=>fn(state));};
  const retire=(phase:'denied'|'session-ended')=>{ended=true;generation++;pending=null;abort?.abort();set({...initialAssignmentState(),phase});attempt.invalidate();};
  const alive=()=>{if(ended)return false;if(!identity||identity!==deps.readIdentity()){retire('session-ended');return false;}return true;};
  const current=(epoch:number)=>epoch===generation&&alive();
  const denied=(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&[401,403,404].includes(Number(error.status));
  const attempt=createSupportAttempt<AssignmentInput,AssignmentAck>({...deps,isDefinitiveRejection:definitiveAssignmentRejection,onDenied:()=>retire('denied'),
    send:async(input,key,signal)=>{
      try{const ack=parseAssignmentAck(await deps.send(input,key,signal),ticketId);
        if(ack.assignment.assigned_to?.toLowerCase()!==input.assigned_to?.toLowerCase()||ack.assignment.version!==input.expected_version+(ack.changed?1:0))throw Error('Assignment acknowledgement mismatch');
        return ack;
      }catch(error){if(definitiveAssignmentRejection(error)){rejected=true;if(String((error as {code:unknown}).code)==='SUPPORT_TICKET_CLOSED'&&alive())set({decisionBlocked:true});}throw error;}
    },reconcile:async(key,signal)=>parseAssignmentAck(await deps.reconcile(key,signal),ticketId),
  });
  const unsubscribe=attempt.subscribe(write=>set({write,canRetry:!!pending&&write.uncertain}));
  const load=async()=>{
    if(!alive()||state.busyRead||attempt.getState().busy)return;
    const epoch=++generation;abort?.abort();abort=new AbortController();
    set({phase:'loading',snapshot:null,candidates:[],nextCursor:null,busyRead:true,readError:null});
    try{
      const snapshot=parseAssignmentSnapshot(await deps.read(abort.signal),ticketId);if(!current(epoch))return;
      const page=parseCandidatePage(await deps.candidates(null,abort.signal));if(!current(epoch))return;
      set({phase:'ready',snapshot,candidates:page.candidates,nextCursor:page.next_cursor,notice:confirmed?'تم تأكيد قرار التكليف وعرض الحالة الحالية من الخادم.':state.notice});
    }catch(error){if(current(epoch)){
      if(denied(error))retire('denied');
      else set({phase:!!error&&typeof error==='object'&&'code'in error&&error.code==='SUPPORT_ASSIGNMENT_UNAVAILABLE'?'unavailable':'error',snapshot:null,candidates:[],nextCursor:null,readError:'تعذّر تحميل التكليف والمسؤولين المتاحين. لا يمكن اتخاذ قرار جديد قبل التحديث.'});
    }}finally{if(current(epoch))set({busyRead:false});}
  };
  const finish=async(ack:AssignmentAck|null)=>{
    if(!alive())return null;
    if(ack){pending=null;confirmed=true;set({canRetry:false,notice:'تم تأكيد قرار التكليف. جارٍ التحقق من الحالة الحالية.'});await load();
      if(alive()&&state.phase!=='ready')set({notice:'قرار التكليف مؤكد، لكن تعذّر تحديث الحالة الحالية. لا تُعد إرسال القرار؛ حدّث البيانات.'});
    }else if(rejected){pending=null;confirmed=false;set({canRetry:false,notice:'لم يُنفذ القرار لأن الحالة أو صلاحية المسؤول تغيّرت. راجع الحالة الحالية قبل قرار جديد.'});await load();}
    return ack;
  };
  return {getState:()=>state,subscribe(fn:(value:AssignmentState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},load,
    async loadMore(){
      if(!alive()||state.phase!=='ready'||state.busyRead||attempt.getState().busy||!state.nextCursor)return;
      const after=state.nextCursor,epoch=generation;abort?.abort();abort=new AbortController();set({busyRead:true,readError:null});
      try{const page=parseCandidatePage(await deps.candidates(after,abort.signal));if(!current(epoch))return;
        if(page.next_cursor===after||page.candidates.some(row=>state.candidates.some(old=>old.id.toLowerCase()===row.id.toLowerCase())))throw Error('Overlapping recipient page');
        set({candidates:[...state.candidates,...page.candidates],nextCursor:page.next_cursor});
      }catch(error){if(current(epoch)){if(denied(error))retire('denied');else set({readError:'تعذّر تحميل مسؤولين إضافيين. يمكنك إعادة المحاولة.'});}}
      finally{if(current(epoch))set({busyRead:false});}
    },
    async save(target:string|null){
      if(!alive()||state.phase!=='ready'||!state.snapshot||state.busyRead||state.decisionBlocked||attempt.getState().busy||attempt.getState().uncertain||attempt.getState().blocked)return null;
      if(!(target===null||id(target)&&(target===accountId||state.candidates.some(row=>row.id===target)))||state.snapshot.assignment.version>=2147483647){set({notice:'اختر مسؤولًا متاحًا وحدّث الحالة قبل الحفظ.'});return null;}
      pending={assigned_to:target,expected_version:state.snapshot.assignment.version};confirmed=false;rejected=false;set({notice:null});
      return finish(await attempt.send(pending));
    },
    async retry(){if(!alive()||state.busyRead||!pending||!attempt.getState().uncertain||attempt.getState().busy)return null;rejected=false;return finish(await attempt.send(pending));},
    async reconcile(){if(!alive()||state.busyRead||attempt.getState().busy)return null;rejected=false;return finish(await attempt.reconcile());},
    invalidate:()=>retire('session-ended'),
    dispose(){listeners.clear();unsubscribe();ended=true;generation++;pending=null;abort?.abort();attempt.dispose();state={...initialAssignmentState(),phase:'session-ended'};},
  };
}
