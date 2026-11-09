import {authenticatedApiFetch,readAuthenticatedApiJson,ApiRequestError,type SupportTicket} from '../../lib/api-http';
import {parseAssignedPage} from './assigned-queue';
export interface FollowupFilters {scope:'mine'|'unassigned';status:'needs_support'|'waiting_on_user';min_hours:0|24|72|168}
export interface FollowupPage {tickets:SupportTicket[];next_cursor:string|null;as_of:string;filters:FollowupFilters}
export const defaultFollowupFilters=():FollowupFilters=>({scope:'mine',status:'needs_support',min_hours:24});
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
export function validFollowupFilters(x:unknown):x is FollowupFilters{return exact(x,['scope','status','min_hours'])&&['mine','unassigned'].includes(x.scope as string)&&['needs_support','waiting_on_user'].includes(x.status as string)&&[0,24,72,168].includes(x.min_hours as number);}
const instant=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export function parseFollowupPage(raw:unknown,filters:FollowupFilters,after:string|null):FollowupPage{
    if(!exact(raw,['tickets','next_cursor','as_of','filters'])||!validFollowupFilters(raw.filters)||raw.filters.scope!==filters.scope||raw.filters.status!==filters.status||raw.filters.min_hours!==filters.min_hours
        ||!instant(raw.as_of)||!(raw.next_cursor===null||typeof raw.next_cursor==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(raw.next_cursor)&&raw.next_cursor!==after))throw Error('Invalid follow-up page');
    const tickets=parseAssignedPage({tickets:raw.tickets,next_cursor:null}).tickets;
    if(raw.next_cursor!==null&&tickets.length!==25)throw Error('Invalid follow-up lookahead');
    const statuses=filters.status==='needs_support'?['open','waiting_on_support']:['waiting_on_user'];let last=0;
    for(const t of tickets){const updated=Date.parse(t.updated_at),created=Date.parse(t.created_at);if(!statuses.includes(t.status)||updated<created||updated> Date.parse(raw.as_of)-filters.min_hours*3600000||updated<last)throw Error('Invalid follow-up evidence');last=updated;}
    return{tickets,next_cursor:raw.next_cursor as string|null,as_of:raw.as_of,filters:{...filters}};
}
export async function readFollowup(filters:FollowupFilters,after:string|null,signal:AbortSignal){
    if(!validFollowupFilters(filters)||after!==null&&!/^[A-Za-z0-9_-]{1,512}$/.test(after))throw Error('Invalid follow-up request');
    const query=new URLSearchParams({scope:filters.scope,status:filters.status,min_hours:String(filters.min_hours)});if(after)query.set('after',after);
    const response=await authenticatedApiFetch('/support-tickets/follow-up?'+query.toString(),{signal});const raw=await readAuthenticatedApiJson(response);
    if(!response.ok)throw new ApiRequestError('Follow-up unavailable',response.status,typeof raw?.code==='string'?raw.code:undefined);
    return parseFollowupPage(raw,filters,after);
}
export interface FollowupState {phase:'idle'|'loading'|'ready'|'error'|'denied'|'unavailable'|'suspended'|'session-ended';filters:FollowupFilters;page:FollowupPage|null;cursor:string|null}
export const initialFollowup=():FollowupState=>({phase:'idle',filters:defaultFollowupFilters(),page:null,cursor:null});
export function createFollowupQueue(deps:{read:typeof readFollowup;readIdentity:()=>string|null}){
    let state=initialFollowup(),epoch=0,ended=false,blocked=false,abort:AbortController|null=null;
    const identity=deps.readIdentity(),listeners=new Set<(s:FollowupState)=>void>();
    const set=(s:FollowupState)=>{state=s;listeners.forEach(fn=>fn(s));};
    const cancel=()=>{epoch++;abort?.abort();abort=null;};
    const invalidate=()=>{cancel();ended=true;set({...initialFollowup(),phase:'session-ended'});};
    const alive=()=>{if(ended)return false;if(!identity||identity!==deps.readIdentity()){invalidate();return false;}return true;};
    async function load(cursor:string|null){if(!alive()||blocked||state.phase==='loading')return;const prior=state.page;cancel();const flight=epoch,c=new AbortController();abort=c;
        const filters={...state.filters},current=()=>epoch===flight&&!c.signal.aborted&&alive();
        set({...state,phase:'loading',page:null,cursor});const timer=setTimeout(()=>{if(current()){cancel();set({...state,phase:'error',page:null});}},25000);
        try{const page=await deps.read(filters,cursor,c.signal);if(!current())return;
            if(cursor&&prior&&(page.as_of!==prior.as_of||page.tickets.some(t=>prior.tickets.some(p=>p.id.toLowerCase()===t.id.toLowerCase()))))throw Error('Changed follow-up page');
            set({...state,phase:'ready',page});
        }catch(error){if(current()){const code=error instanceof ApiRequestError?error.status:0;set({...state,page:null,phase:[401,403,404].includes(code)?'denied':error instanceof ApiRequestError&&error.code==='SUPPORT_FOLLOWUP_UNAVAILABLE'?'unavailable':'error'});}}
        finally{clearTimeout(timer);}
    }
    return{subscribe(fn:(s:FollowupState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},refresh:()=>load(null),next:()=>state.page?.next_cursor?load(state.page.next_cursor):Promise.resolve(),
        filters(value:FollowupFilters){if(!alive()||blocked||!validFollowupFilters(value))return;cancel();set({...initialFollowup(),filters:{...value}});void load(null);},
        select(id:string){return alive()&&!blocked&&state.phase==='ready'?state.page?.tickets.find(t=>t.id===id)??null:null;},
        suspend(){if(!alive())return;blocked=true;cancel();set({...state,phase:'suspended',page:null,cursor:null});},
        resume(){if(!alive())return;blocked=false;set({...state,phase:'idle',page:null,cursor:null});void load(null);},
        invalidate,dispose(){ended=true;cancel();listeners.clear();state=initialFollowup();}};
}
