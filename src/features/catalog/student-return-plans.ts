import {authenticatedApiFetch,readAuthenticatedApiJson,ApiRequestError} from '../../lib/api-http';
import {readCourseSessionPrincipal} from './course-management';
export interface StudentPlanStep {position:number;available:boolean;lesson_id?:string;title?:string;minutes?:number|null;completed?:boolean}
export interface StudentReturnPlan {id:string;version:number;course_id:string;course_name:string;steps:StudentPlanStep[]}
export interface StudentPlanPage {plans:StudentReturnPlan[];nextCursor:string|null;checkedAt:string}
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact=(x:any,keys:string[])=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const text=(x:unknown)=>typeof x==='string'&&!!x.trim()&&x.length<=255;
const invalid=()=>Error('Invalid student plan');
export function studentReturnPrincipal(storage:Pick<Storage,'getItem'>){let last:string|null=null,generation=0;return()=>{
 let key:string|null=null;try{const base=readCourseSessionPrincipal(storage),space=JSON.parse(storage.getItem('currentStudentSpace')??'null');if(base&&typeof space?.tenant_id==='string'&&space.tenant_id&&typeof space?.student_enrollment_id==='string'&&space.student_enrollment_id)key=JSON.stringify([base,space.tenant_id,space.student_enrollment_id]);}catch{}
 if(last!==key){last=key;generation++;}return key===null?null:'return-space:'+generation;
 };}
export function parseStudentPlans(raw:any,cursor:string|null):StudentPlanPage{
 if(!exact(raw,['plans','next_cursor','checked_at'])||!Array.isArray(raw.plans)||raw.plans.length>5||raw.next_cursor!==null&&(!uuid(raw.next_cursor)||raw.next_cursor===cursor)||typeof raw.checked_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.checked_at)||!Number.isFinite(Date.parse(raw.checked_at)))throw invalid();
 for(const p of raw.plans){if(!exact(p,['id','version','course_id','course_name','steps'])||!uuid(p.id)||!Number.isInteger(p.version)||p.version<1||p.version>2147483647||!uuid(p.course_id)||!text(p.course_name)||!Array.isArray(p.steps)||!p.steps.length||p.steps.length>3)throw invalid();
  p.steps.forEach((s:any,i:number)=>{if(typeof s?.available!=='boolean'||s.position!==i+1||!exact(s,s.available?['position','available','lesson_id','title','minutes','completed']:['position','available']))throw invalid();if(s.available&&(!uuid(s.lesson_id)||!text(s.title)||typeof s.completed!=='boolean'||s.minutes!==null&&(!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>180)))throw invalid();});
  const visible=p.steps.filter((s:any)=>s.available);if(new Set(visible.map((s:any)=>s.lesson_id.toLowerCase())).size!==visible.length)throw invalid();
 }
 if(new Set(raw.plans.map((p:any)=>p.id.toLowerCase())).size!==raw.plans.length)throw invalid();return{plans:raw.plans,nextCursor:raw.next_cursor,checkedAt:raw.checked_at};
}
export async function readStudentPlans(cursor:string|null,signal:AbortSignal){
 if(cursor!==null&&!uuid(cursor))throw invalid();const response=await authenticatedApiFetch('/tenants/me/catalog/my-return-plans'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal,cache:'no-store'});
 const raw=await readAuthenticatedApiJson(response);if(!response.ok)throw new ApiRequestError('Student plans unavailable',response.status);return parseStudentPlans(raw,cursor);
}
export interface StudentPlansState {phase:'idle'|'loading'|'ready'|'error'|'session-ended';page:StudentPlanPage|null}
export const initialStudentPlans=():StudentPlansState=>({phase:'idle',page:null});
export function createStudentPlans(deps:{read:typeof readStudentPlans;readPrincipal:()=>string|null;subscribeSession:(fn:()=>void)=>()=>void}){
 let state=initialStudentPlans(),epoch=0,disposed=false,active:AbortController|null=null;const identity=deps.readPrincipal(),listeners=new Set<(x:StudentPlansState)=>void>();
 const set=(x:StudentPlansState)=>{state=x;if(!disposed)listeners.forEach(fn=>fn(x));};const cancel=()=>{epoch++;active?.abort();active=null;};const invalidate=()=>{cancel();set({phase:'session-ended',page:null});};const unsub=deps.subscribeSession(invalidate);
 const allowed=()=>{if(disposed||state.phase==='session-ended')return false;if(!identity||deps.readPrincipal()!==identity){invalidate();return false;}return true;};
 async function load(cursor:string|null){if(!allowed())return;cancel();const flight=epoch,c=new AbortController();active=c;set({phase:'loading',page:null});const current=()=>!disposed&&epoch===flight&&!c.signal.aborted&&allowed();
  const timer=setTimeout(()=>{if(current()){cancel();set({phase:'error',page:null});}},25000);
  try{const page=await deps.read(cursor,c.signal);if(current())set({phase:'ready',page});}catch{if(current())set({phase:'error',page:null});}finally{clearTimeout(timer);if(active===c)active=null;}
 }
 return{subscribe(fn:(x:StudentPlansState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},first:()=>load(null),next:()=>state.page?.nextCursor?load(state.page.nextCursor):Promise.resolve(),invalidate,dispose(){disposed=true;cancel();unsub();listeners.clear();state=initialStudentPlans();}};
}
