import type {SupportTicket} from '../../lib/api-http';
export interface AssignedPage {tickets:SupportTicket[];next_cursor:string|null}
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,36}$/.test(value);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
const instant=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function parseAssignedPage(value:unknown):AssignedPage{
  if(!exact(value,['tickets','next_cursor'])||!Array.isArray(value.tickets)||value.tickets.length>25||!(value.next_cursor===null||validId(value.next_cursor)))throw Error('Invalid assigned support page');
  const tickets=value.tickets.map(row=>{
    if(!exact(row,['id','ticket_number','category','subject','status','priority','created_at','updated_at'])||!validId(row.id)||typeof row.ticket_number!=='string'||row.ticket_number.length>32||typeof row.subject!=='string'||row.subject.length>200
      ||typeof row.category!=='string'||!['technical','account','billing','content','exam','video','other'].includes(row.category)||typeof row.status!=='string'||!['open','waiting_on_support','waiting_on_user','resolved','closed'].includes(row.status)||typeof row.priority!=='string'||!['low','normal','high','urgent'].includes(row.priority)||!instant(row.created_at)||!instant(row.updated_at))throw Error('Invalid assigned support ticket');
    return row as unknown as SupportTicket;
  });
  if(new Set(tickets.map(row=>row.id.toLowerCase())).size!==tickets.length||value.next_cursor!==null&&(tickets.length!==25||value.next_cursor!==tickets[24].id))throw Error('Invalid assigned support cursor');
  return {tickets,next_cursor:value.next_cursor as string|null};
}
export interface AssignedState {phase:'idle'|'loading'|'ready'|'error'|'unavailable'|'denied'|'session-ended'|'suspended';tickets:SupportTicket[];nextCursor:string|null;busy:boolean;error:string|null}
export const initialAssignedState=():AssignedState=>({phase:'idle',tickets:[],nextCursor:null,busy:false,error:null});
export function createAssignedQueue(deps:{read(after:string|null,signal:AbortSignal):Promise<unknown>;readIdentity():string|null}){
  let state=initialAssignedState(),ended=false,generation=0,abort:AbortController|null=null;
  const identity=deps.readIdentity(),listeners=new Set<(value:AssignedState)=>void>();
  const set=(patch:Partial<AssignedState>)=>{state={...state,...patch};listeners.forEach(fn=>fn(state));};
  const retire=(phase:'denied'|'session-ended')=>{ended=true;generation++;abort?.abort();set({...initialAssignedState(),phase});};
  const alive=()=>{if(ended)return false;if(!identity||identity!==deps.readIdentity()){retire('session-ended');return false;}return true;};
  const current=(epoch:number)=>epoch===generation&&alive();
  const load=async(older:boolean)=>{
    if(!alive()||state.busy||older&&(state.phase!=='ready'||!state.nextCursor))return;
    const after=older?state.nextCursor:null,epoch=++generation;abort?.abort();abort=new AbortController();
    if(!older)set({phase:'loading',tickets:[],nextCursor:null});set({busy:true,error:null});
    try{const page=parseAssignedPage(await deps.read(after,abort.signal));if(!current(epoch))return;
      if(older&&(page.next_cursor===after||page.tickets.some(row=>state.tickets.some(previous=>previous.id.toLowerCase()===row.id.toLowerCase()))))throw Error('Overlapping assigned page');
      set({phase:'ready',tickets:older?[...state.tickets,...page.tickets]:page.tickets,nextCursor:page.next_cursor});
    }catch(error){if(current(epoch)){
      if(error&&typeof error==='object'&&'status'in error&&[401,403,404].includes(Number(error.status)))retire('denied');
      else if(error&&typeof error==='object'&&'code'in error&&error.code==='SUPPORT_ASSIGNED_UNAVAILABLE')set({...initialAssignedState(),phase:'unavailable',error:'قائمة الطلبات المسندة غير مهيأة حاليًا.'});
      else set({phase:older?'ready':'error',error:older?'تعذّر تحميل الطلبات التالية. يمكنك إعادة المحاولة.':'تعذّر تحديث الطلبات المسندة؛ القائمة الحالية غير متاحة.'});
    }}finally{if(current(epoch))set({busy:false});}
  };
  return {getState:()=>state,subscribe(fn:(value:AssignedState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},refresh:()=>load(false),more:()=>load(true),
    select(id:string){return alive()&&state.phase==='ready'&&!state.busy?state.tickets.find(row=>row.id===id)??null:null;},
    suspend(){if(!alive())return;generation++;abort?.abort();set({...initialAssignedState(),phase:'suspended'});},
    invalidate:()=>retire('session-ended'),
    dispose(){ended=true;generation++;abort?.abort();listeners.clear();state={...initialAssignedState(),phase:'session-ended'};},
  };
}
