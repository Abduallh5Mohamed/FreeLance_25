export interface LessonSupportContext {kind:'catalog_lesson';course_id:string;lesson_id:string;course_name:string;lesson_title:string}
export type SupportContextEnvelope={state:'available'|'none'|'unavailable'|'unconfigured';context:LessonSupportContext|null};
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
export function parseLessonSupportContext(value:unknown,target?:{courseId:string;lessonId:string}):LessonSupportContext{
  if(!exact(value,['kind','course_id','lesson_id','course_name','lesson_title'])||value.kind!=='catalog_lesson'
    ||typeof value.course_id!=='string'||!uuid.test(value.course_id)||typeof value.lesson_id!=='string'||!uuid.test(value.lesson_id)
    ||![value.course_name,value.lesson_title].every(text=>typeof text==='string'&&text.trim().length>0&&text.length<=255)
    ||target&&(value.course_id.toLowerCase()!==target.courseId.toLowerCase()||value.lesson_id.toLowerCase()!==target.lessonId.toLowerCase()))throw Error('تعذّر التحقق من سياق الدرس.');
  return {kind:'catalog_lesson',course_id:value.course_id,lesson_id:value.lesson_id,course_name:value.course_name as string,lesson_title:value.lesson_title as string};
}
export function parseSupportContextEnvelope(value:unknown):SupportContextEnvelope{
  if(!exact(value,['state','context'])||typeof value.state!=='string'||!['available','none','unavailable','unconfigured'].includes(value.state))throw Error('استجابة سياق الدعم غير صالحة.');
  if(value.state==='available')return {state:'available',context:parseLessonSupportContext(value.context)};
  if(value.context!==null)throw Error('استجابة سياق الدعم غير صالحة.');
  return {state:value.state as SupportContextEnvelope['state'],context:null};
}
export function parseSupportDraftTarget(search:string):{kind:'none'}|{kind:'invalid'}|{kind:'lesson';courseId:string;lessonId:string}{
  const params=new URLSearchParams(search);
  if(!params.has('course')&&!params.has('lesson'))return {kind:'none'};
  const course=params.get('course'),lesson=params.get('lesson');
  if(Array.from(params.keys()).some(key=>!['course','lesson'].includes(key))||params.getAll('course').length!==1||params.getAll('lesson').length!==1||!course||!lesson||!uuid.test(course)||!uuid.test(lesson))return {kind:'invalid'};
  return {kind:'lesson',courseId:course.toLowerCase(),lessonId:lesson.toLowerCase()};
}
export interface SupportContextState {phase:'idle'|'loading'|'ready'|'error'|'session-ended';data:SupportContextEnvelope|null;message:string|null}
export const initialSupportContextState=():SupportContextState=>({phase:'idle',data:null,message:null});
export function createSupportContextController(deps:{read(signal:AbortSignal):Promise<unknown>;readIdentity():string|null;onDenied?:()=>void}){
  let state=initialSupportContextState(),epoch=0,ended=false,abort:AbortController|null=null;
  const identity=deps.readIdentity(),listeners=new Set<(value:SupportContextState)=>void>();
  const set=(value:SupportContextState)=>{state=value;listeners.forEach(fn=>fn(state));};
  const invalidate=()=>{ended=true;epoch++;abort?.abort();set({phase:'session-ended',data:null,message:'تغيّرت الجلسة. أعد فتح صفحة الدعم.'});};
  const current=(ticket:number)=>{if(ended||ticket!==epoch)return false;if(!identity||identity!==deps.readIdentity()){invalidate();return false;}return true;};
  return {getState:()=>state,subscribe(fn:(value:SupportContextState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},
    async load(){if(ended)return;const ticket=++epoch;if(!current(ticket))return;abort?.abort();abort=new AbortController();set({phase:'loading',data:null,message:null});
      try{const data=parseSupportContextEnvelope(await deps.read(abort.signal));if(current(ticket))set({phase:'ready',data,message:null});}
      catch(error){if(current(ticket)){
        if(deps.onDenied&&error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'&&[401,403,404].includes(error.status)){invalidate();deps.onDenied();}
        else set({phase:'error',data:null,message:'تعذّر التحقق من سياق الدرس. قد تكون الإتاحة تغيّرت أو الخدمة غير مهيأة.'});
      }}
    },invalidate,dispose(){listeners.clear();invalidate();},
  };
}
