import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
export const setupActions = ['review_group','assign_instructor','add_students','review_enrollments','review_accounts','review_course_assignments','review_capacity','verify_schedule_source','prepare_sessions','practice_handover'] as const;
export type SetupAction = typeof setupActions[number];
export interface GroupSetupSnapshot {
    group:{id:string;name:string;course_name:string;active:boolean;course_active:boolean;branch_valid:boolean;capacity:number};
    instructor:{status:'active'|'not_assigned'|'unavailable';name:string|null};
    students:{total:number;active:number;inactive:number;offline:number;missing_account:number;missing_course_assignment:number};
    schedule:{status:'available'|'unavailable';sessions:Array<{id:string;title:string;starts_at:string}>};
    issues:SetupAction[];next_action:SetupAction;checked_at:string;readiness:'review_only';
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=255;
const instant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const fail=()=>Error('Invalid group setup evidence');
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.slice().sort().join(','))throw fail();return v as Record<string,unknown>;}
export function parseGroupSetup(raw:unknown,groupId:string):GroupSetupSnapshot{
    const r=object(raw,['group','instructor','students','schedule','issues','next_action','checked_at','readiness']);
    const g=object(r.group,['id','name','course_name','active','course_active','branch_valid','capacity']);
    const i=object(r.instructor,['status','name']),s=object(r.students,['total','active','inactive','offline','missing_account','missing_course_assignment']);
    const schedule=object(r.schedule,['status','sessions']);
    if(!uuid(g.id)||g.id.toLowerCase()!==groupId.toLowerCase()||!text(g.name)||!text(g.course_name)
        ||[g.active,g.course_active,g.branch_valid].some(x=>typeof x!=='boolean')||!Number.isSafeInteger(g.capacity)||(g.capacity as number)<0||(g.capacity as number)>1000000
        ||!['active','not_assigned','unavailable'].includes(String(i.status))||(i.status==='active'?!text(i.name):i.name!==null)
        ||Object.values(s).some(n=>!Number.isInteger(n)||(n as number)<0||(n as number)>500)
        ||Number(s.active)+Number(s.inactive)!==s.total||Number(s.offline)>Number(s.active)||Number(s.missing_account)>Number(s.active)-Number(s.offline)||Number(s.missing_course_assignment)>Number(s.active)
        ||!['available','unavailable'].includes(String(schedule.status))||!Array.isArray(schedule.sessions)||schedule.sessions.length>20
        ||schedule.status==='unavailable'&&schedule.sessions.length!==0||!Array.isArray(r.issues)||!instant(r.checked_at)||r.readiness!=='review_only')throw fail();
    const ids=new Set<string>();
    for(const rawSession of schedule.sessions){const session=object(rawSession,['id','title','starts_at']);if(!uuid(session.id)||ids.has(session.id.toLowerCase())||!text(session.title)||!instant(session.starts_at))throw fail();ids.add(session.id.toLowerCase());}
    const issues:SetupAction[]=[];
    if(!g.active||!g.course_active||!g.branch_valid)issues.push('review_group');
    if(i.status!=='active')issues.push('assign_instructor');
    if(!s.total)issues.push('add_students');else if(!s.active)issues.push('review_enrollments');
    if(s.missing_account)issues.push('review_accounts');if(s.missing_course_assignment)issues.push('review_course_assignments');
    if(Number(g.capacity)===0||Number(s.active)>Number(g.capacity))issues.push('review_capacity');
    if(schedule.status==='unavailable')issues.push('verify_schedule_source');else if(!schedule.sessions.length)issues.push('prepare_sessions');
    if(JSON.stringify(r.issues)!==JSON.stringify(issues)||r.next_action!==(issues[0]??'practice_handover'))throw fail();
    return r as unknown as GroupSetupSnapshot;
}
export async function readGroupSetup(groupId:string,signal:AbortSignal){
    if(!uuid(groupId))throw fail();const response=await authenticatedApiFetch('/tenants/me/catalog/groups/'+encodeURIComponent(groupId)+'/setup',{signal});
    const raw=await readAuthenticatedApiJson(response);if(!response.ok)throw new ApiRequestError('Group setup unavailable',response.status);
    return parseGroupSetup(raw,groupId);
}
export interface GroupSetupState {phase:'idle'|'loading'|'ready'|'error'|'denied'|'session-ended';groupId:string|null;data:GroupSetupSnapshot|null}
export const initialGroupSetup=():GroupSetupState=>({phase:'idle',groupId:null,data:null});
export function createGroupSetup(deps:{read:typeof readGroupSetup;readPrincipal:()=>string|null;subscribeSession:(fn:()=>void)=>()=>void}){
    let state=initialGroupSetup(),epoch=0,disposed=false,active:AbortController|null=null;
    const principal=deps.readPrincipal(),listeners=new Set<(s:GroupSetupState)=>void>();
    const set=(s:GroupSetupState)=>{state=s;if(!disposed)listeners.forEach(fn=>fn(s));};
    const cancel=()=>{epoch++;active?.abort();active=null;};
    const invalidate=()=>{cancel();set({...initialGroupSetup(),phase:'session-ended'});};
    const unsubscribe=deps.subscribeSession(invalidate);
    const allowed=()=>{if(disposed||state.phase==='session-ended')return false;if(!principal||deps.readPrincipal()!==principal){invalidate();return false;}return true;};
    async function select(groupId:string|null){if(!allowed()||groupId!==null&&!uuid(groupId))return;cancel();if(groupId===null){set(initialGroupSetup());return;}
        const flight=epoch,c=new AbortController();active=c;const current=()=>!disposed&&epoch===flight&&!c.signal.aborted&&allowed();
        set({phase:'loading',groupId,data:null});const timer=setTimeout(()=>{if(current()){cancel();set({phase:'error',groupId,data:null});}},25000);
        try{const data=await deps.read(groupId,c.signal);if(current())set({phase:'ready',groupId,data});}
        catch(error){if(current())set({phase:error instanceof ApiRequestError&&[401,403,404].includes(error.status)?'denied':'error',groupId,data:null});}
        finally{clearTimeout(timer);if(active===c)active=null;}
    }
    return{subscribe(fn:(s:GroupSetupState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},select,refresh:()=>select(state.groupId),invalidate,
        dispose(){disposed=true;cancel();unsubscribe();listeners.clear();state=initialGroupSetup();}};
}
