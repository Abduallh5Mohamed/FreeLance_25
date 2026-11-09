import { authenticatedApiFetch,readAuthenticatedApiJson,ApiRequestError } from '../../lib/api-http';
export interface ReturnStep {lesson_id:string;minutes:number|null}
export interface ReturnInput {enrollment_id:string;from:string;to:string;steps:ReturnStep[]}
export interface SavedReturnHeader {id:string;version:number;status:'active'|'withdrawn'}
export interface SavedReturnReceipt {operation_id:string;plan_id:string;version:number;status:'active'|'withdrawn'}
export interface ReturnEvidence {
 context:{course_id:string;enrollment_id:string;from:string;to:string};checked_at:string;student:{name:string};
 attendance:{session_id:string;title:string;starts_at:string;state:'present'|'absent'|'late'|'excused'|'unrecorded'}[];
 lessons:{lesson_id:string;title:string;completed:boolean;block:null|'not_released'|'prerequisite_incomplete'}[];
 steps:(ReturnStep&{title:string})[];review_token:string|null;reviewed:boolean;delivery:'not_sent';persistence:{status:'ready'|'unavailable';current:SavedReturnHeader|null};
}
const identity=(x:unknown):x is string=>typeof x==='string'&&!!x&&x.trim()===x&&x.length<=64;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact=(x:any,keys:string[])=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const text=(x:unknown,max=255)=>typeof x==='string'&&!!x.trim()&&x.length<=max;
const iso=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const bad=()=>Error('Invalid return plan');
export function validateReturnInput(input:ReturnInput){
 if(!identity(input.enrollment_id)||!iso(input.from)||!iso(input.to)||!input.from.endsWith('.000Z')||!input.to.endsWith('.000Z')||Date.parse(input.to)<=Date.parse(input.from)||Date.parse(input.to)-Date.parse(input.from)>31*86400000
  ||!Array.isArray(input.steps)||input.steps.length>3||input.steps.some(s=>!exact(s,['lesson_id','minutes'])||!uuid(s.lesson_id)||s.minutes!==null&&(!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>180))||new Set(input.steps.map(s=>s.lesson_id.toLowerCase())).size!==input.steps.length)throw bad();
 return input;
}
export function parseReturnEvidence(raw:any,courseId:string,input:ReturnInput,reviewed:boolean):ReturnEvidence{
 if(!exact(raw,['context','checked_at','student','attendance','lessons','steps','review_token','reviewed','delivery','persistence'])||!exact(raw.context,['course_id','enrollment_id','from','to'])||raw.context.course_id!==courseId
  ||raw.context.enrollment_id!==input.enrollment_id||raw.context.from!==input.from||raw.context.to!==input.to||!iso(raw.checked_at)||!exact(raw.student,['name'])||!text(raw.student.name)
  ||!Array.isArray(raw.attendance)||raw.attendance.length>100||!Array.isArray(raw.lessons)||raw.lessons.length>500||!Array.isArray(raw.steps)||raw.steps.length!==input.steps.length||raw.reviewed!==reviewed||raw.delivery!=='not_sent'
  ||(input.steps.length?typeof raw.review_token!=='string'||!/^[a-f\d]{64}$/.test(raw.review_token):raw.review_token!==null))throw bad();
 if(!exact(raw.persistence,['status','current'])||!['ready','unavailable'].includes(raw.persistence.status)||raw.persistence.status==='unavailable'&&raw.persistence.current!==null)throw bad();
 if(raw.persistence.current!==null){const h=raw.persistence.current;if(!exact(h,['id','version','status'])||!uuid(h.id)||!Number.isInteger(h.version)||h.version<1||h.version>2147483647||!['active','withdrawn'].includes(h.status))throw bad();}
 for(const row of raw.attendance)if(!exact(row,['session_id','title','starts_at','state'])||!uuid(row.session_id)||!text(row.title,200)||!iso(row.starts_at)||Date.parse(row.starts_at)<Date.parse(input.from)||Date.parse(row.starts_at)>=Date.parse(input.to)||!['present','absent','late','excused','unrecorded'].includes(row.state))throw bad();
 for(const row of raw.lessons)if(!exact(row,['lesson_id','title','completed','block'])||!uuid(row.lesson_id)||!text(row.title)||typeof row.completed!=='boolean'||![null,'not_released','prerequisite_incomplete'].includes(row.block))throw bad();
 if(new Set(raw.attendance.map((s:any)=>s.session_id.toLowerCase())).size!==raw.attendance.length||new Set(raw.lessons.map((s:any)=>s.lesson_id.toLowerCase())).size!==raw.lessons.length)throw bad();
 raw.steps.forEach((row:any,i:number)=>{const candidate=raw.lessons.find((l:any)=>l.lesson_id===row.lesson_id);if(!exact(row,['lesson_id','title','minutes'])||row.lesson_id!==input.steps[i].lesson_id||row.minutes!==input.steps[i].minutes||!candidate||candidate.title!==row.title||candidate.completed||candidate.block!==null)throw bad();});
 return raw;
}
export function returnPlanTransport(courseId:string){
 if(!uuid(courseId))throw bad();const base=`/tenants/me/catalog/courses/${courseId.toLowerCase()}/return-plan`;
 async function request(url:string,signal:AbortSignal,body?:unknown){const response=await authenticatedApiFetch(url,{signal,cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const raw=await readAuthenticatedApiJson(response);if(!response.ok)throw new ApiRequestError('Return plan unavailable',response.status);return raw;}
 return{
  async roster(cursor:string|null,signal:AbortSignal){if(cursor!==null&&!identity(cursor))throw bad();const raw=await request(base+'/students'+(cursor?'?cursor='+encodeURIComponent(cursor):''),signal);
   if(!exact(raw,['students','next_cursor'])||!Array.isArray(raw.students)||raw.students.length>25||raw.next_cursor!==null&&(!identity(raw.next_cursor)||raw.next_cursor===cursor)||raw.students.some((s:any)=>!exact(s,['enrollment_id','name'])||!identity(s.enrollment_id)||!text(s.name))||new Set(raw.students.map((s:any)=>s.enrollment_id)).size!==raw.students.length)throw bad();return{students:raw.students as {enrollment_id:string;name:string}[],nextCursor:raw.next_cursor as string|null};},
  async preview(input:ReturnInput,signal:AbortSignal){validateReturnInput(input);return parseReturnEvidence(await request(base+'/preview',signal,input),courseId.toLowerCase(),input,false);},
  async review(input:ReturnInput,token:string,signal:AbortSignal){validateReturnInput(input);if(!input.steps.length||!/^[a-f\d]{64}$/.test(token))throw bad();return parseReturnEvidence(await request(base+'/review',signal,{...input,review_token:token}),courseId.toLowerCase(),input,true);},
  async save(input:ReturnInput,token:string,expectedVersion:number,operationId:string,signal:AbortSignal){validateReturnInput(input);if(!input.steps.length||!/^[a-f\d]{64}$/.test(token)||!uuid(operationId)||!Number.isInteger(expectedVersion)||expectedVersion<0)throw bad();const raw=await request(base+'/save',signal,{...input,review_token:token,expected_version:expectedVersion,operation_id:operationId});return parseSavedReceipt(raw,operationId);},
  async withdraw(enrollmentId:string,expectedVersion:number,operationId:string,signal:AbortSignal){if(!identity(enrollmentId)||!uuid(operationId)||!Number.isInteger(expectedVersion)||expectedVersion<1)throw bad();return parseSavedReceipt(await request(base+'/withdraw',signal,{enrollment_id:enrollmentId,expected_version:expectedVersion,operation_id:operationId}),operationId);},
  async status(operationId:string,signal:AbortSignal){if(!uuid(operationId))throw bad();const raw=await request(base+'/operations/'+operationId,signal);if(!exact(raw,['operation']))throw bad();return raw.operation===null?null:parseSavedReceipt(raw,operationId);},
 };
}
export function parseSavedReceipt(raw:any,operationId:string):SavedReturnReceipt{
 if(!exact(raw,['operation'])||!exact(raw.operation,['operation_id','plan_id','version','status']))throw bad();const r=raw.operation;
 if(r.operation_id!==operationId||!uuid(r.plan_id)||!Number.isInteger(r.version)||r.version<1||r.version>2147483647||!['active','withdrawn'].includes(r.status))throw bad();return r;
}
export interface ReturnState {phase:'idle'|'loading'|'ready'|'error'|'session-ended';students:{enrollment_id:string;name:string}[];nextCursor:string|null;enrollmentId:string;from:string;to:string;steps:ReturnStep[];data:ReturnEvidence|null;preview:ReturnEvidence|null;message:string|null;savePhase:'idle'|'saving'|'uncertain'|'recovering'|'confirmed';operationId:string|null;saved:SavedReturnReceipt|null}
export const initialReturn=():ReturnState=>({phase:'idle',students:[],nextCursor:null,enrollmentId:'',from:'',to:'',steps:[],data:null,preview:null,message:null,savePhase:'idle',operationId:null,saved:null});
type ReturnTransport=ReturnType<typeof returnPlanTransport>;
export interface ReturnIntent {operationId:string;version:number;status:'active'|'withdrawn';planId:string|null}
export function returnIntentStore(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,courseId:string,ownerId:string){
 if(!uuid(courseId)||!identity(ownerId))throw bad();const key='tabweb:return-operation:'+JSON.stringify([courseId.toLowerCase(),ownerId]);return{
  read():ReturnIntent|null{const raw=storage.getItem(key);if(raw===null)return null;const x=JSON.parse(raw);if(!exact(x,['operationId','version','status','planId'])||!uuid(x.operationId)||!Number.isInteger(x.version)||x.version<1||!['active','withdrawn'].includes(x.status)||x.planId!==null&&!uuid(x.planId))throw bad();return x;},
  write(value:ReturnIntent){storage.setItem(key,JSON.stringify(value));},clear(){storage.removeItem(key);},
 };
}
export function createReturnPlan(deps:Pick<ReturnTransport,'roster'|'preview'|'review'>&Partial<Pick<ReturnTransport,'save'|'withdraw'|'status'>>&{readPrincipal:()=>string|null;subscribeSession:(fn:()=>void)=>()=>void;newOperationId?:()=>string;intentStore?:ReturnType<typeof returnIntentStore>}){
 let state=initialReturn(),epoch=0,active:AbortController|null=null,disposed=false;const identity=deps.readPrincipal(),listeners=new Set<(x:ReturnState)=>void>();
 const set=(x:ReturnState)=>{state=x;if(!disposed)listeners.forEach(fn=>fn(x));};const cancel=()=>{epoch++;active?.abort();active=null;};
 let pending:{version:number;status:'active'|'withdrawn';planId:string|null}|null=null;
 const invalidate=()=>{cancel();pending=null;set({...initialReturn(),phase:'session-ended'});};const unsub=deps.subscribeSession(invalidate);
 const allowed=(storage=false)=>{if(disposed||state.phase==='session-ended')return false;if(!identity||deps.readPrincipal()!==identity){invalidate();return false;}return storage||!['saving','uncertain','recovering'].includes(state.savePhase);};
 const input=():ReturnInput=>({enrollment_id:state.enrollmentId,from:state.from,to:state.to,steps:state.steps.map(s=>({...s}))});
 async function run(kind:'roster'|'preview'|'review',cursor:string|null=null,empty=false){
  if(!allowed())return;let payload=input(),token=state.preview?.review_token;
  if(kind!=='roster'){try{if(!state.students.some(s=>s.enrollment_id===payload.enrollment_id))throw bad();if(empty)payload.steps=[];validateReturnInput(payload);if(kind==='review'&&(!token||!state.preview||state.preview.reviewed||!payload.steps.length))return;}catch{cancel();set({...state,phase:'error',data:null,preview:null,steps:[],message:'راجع الطالب والفترة والخطوات قبل القراءة.'});return;}}
  cancel();const flight=epoch,c=new AbortController();active=c;set({...state,phase:'loading',data:null,preview:null,message:null,...(kind==='roster'?{students:[],nextCursor:null,enrollmentId:'',steps:[]}:{})});
  const current=()=>!disposed&&epoch===flight&&!c.signal.aborted&&allowed();const fail=()=>set({...state,phase:'error',data:null,preview:null,steps:[],message:'تعذر إثبات الأدلة الحالية أو تغيرت الخطوات؛ أعد القراءة والمراجعة.'});
  const timer=setTimeout(()=>{if(current()){cancel();fail();}},25000);
  try{if(kind==='roster'){const page=await deps.roster(cursor,c.signal);if(current())set({...state,phase:'ready',...page});}
   else{const data=kind==='review'?await deps.review(payload,token!,c.signal):await deps.preview(payload,c.signal);if(current())set({...state,phase:'ready',data,steps:payload.steps,preview:payload.steps.length?data:null});}}
  catch{if(current())fail();}finally{clearTimeout(timer);if(active===c)active=null;}
 }
 function edit(steps:ReturnStep[]){cancel();set({...state,phase:'ready',steps,preview:null,message:null});}
 try{const old=deps.intentStore?.read();if(old){pending={version:old.version,status:old.status,planId:old.planId};state={...state,savePhase:'uncertain',operationId:old.operationId,message:'توجد عملية سابقة تحتاج استعلامًا قبل أي حفظ جديد.'};}}catch{state={...state,savePhase:'uncertain',message:'تعذر قراءة معرف العملية السابقة؛ أصلح التخزين وأعد فتح اللوحة قبل الحفظ.'};}
 const verifyReceipt=(receipt:SavedReturnReceipt)=>{if(!pending||receipt.operation_id!==state.operationId||receipt.version!==pending.version||receipt.status!==pending.status||pending.planId!==null&&receipt.plan_id!==pending.planId)throw bad();return receipt;};
 async function storage(kind:'save'|'withdraw'|'recover'){
  if(kind==='recover'){if(!allowed(true)||state.savePhase!=='uncertain'||!state.operationId||!pending||!deps.status)return;}
  else if(!allowed()||state.phase!=='ready'||!state.data||state.data.persistence.status!=='ready'||kind==='save'&&(!state.preview?.reviewed||!deps.save)||kind==='withdraw'&&(!deps.withdraw||state.data.persistence.current?.status!=='active'))return;
  const snapshot=state.preview,head=state.data?.persistence.current,payload=input();let operationId=state.operationId;
  if(kind!=='recover'){try{operationId=(deps.newOperationId?.()??crypto.randomUUID()).toLowerCase();if(!uuid(operationId))throw bad();pending={version:(head?.version??0)+1,status:kind==='save'?'active':'withdrawn',planId:head?.id??null};deps.intentStore?.write({operationId,...pending});}catch{pending=null;set({...state,message:'تعذر حفظ معرف العملية؛ لم يُرسل طلب كتابة.'});return;}}
  cancel();const flight=epoch,c=new AbortController();active=c;set({...state,savePhase:kind==='recover'?'recovering':'saving',operationId,saved:kind==='recover'?state.saved:null,message:null});
  const current=()=>!disposed&&epoch===flight&&!c.signal.aborted&&allowed(true);
  const uncertain=()=>set({...state,savePhase:'uncertain',message:state.saved?'الحفظ مؤكد، لكن تنظيف معرف الاستعلام لم يكتمل. تحقق من نفس العملية قبل أي كتابة جديدة.':'نتيجة الحفظ غير محسومة. تحقق من نفس العملية دون إعادة الكتابة أو إغلاق سياقها.'});
  const timer=setTimeout(()=>{if(current()){cancel();uncertain();}},25000);
  try{const receipt=kind==='recover'?await deps.status!(operationId!,c.signal):kind==='save'?await deps.save!(payload,snapshot!.review_token!,head?.version??0,operationId!,c.signal):await deps.withdraw!(payload.enrollment_id,head!.version,operationId!,c.signal);
   if(!current())return;if(!receipt){uncertain();return;}verifyReceipt(receipt);let cleared=true;try{deps.intentStore?.clear();}catch{cleared=false;}if(cleared)pending=null;set({...state,savePhase:cleared?'confirmed':'uncertain',saved:receipt,preview:null,message:cleared?'الحفظ مؤكد في السجل. حدّث الأدلة قبل تعديل جديد؛ تأكيد الحفظ لا يثبت تحديث بقية القوائم أو وصول إشعار.':'الحفظ مؤكد، لكن تعذر تنظيف معرف الاستعلام المحلي. الكتابة متوقفة حتى تسوية نفس العملية؛ لا تعتبره فشل كتابة.'});
  }catch(error){if(current()){if(kind!=='recover'&&error instanceof ApiRequestError&&error.status>=400&&error.status<500){try{deps.intentStore?.clear();pending=null;set({...state,savePhase:'idle',operationId:null,preview:null,message:'رُفض الحفظ أو تغيرت النسخة؛ أعد قراءة الأدلة والمراجعة.'});}catch{uncertain();}}else uncertain();}}
  finally{clearTimeout(timer);if(active===c)active=null;}
 }
 return{
  subscribe(fn:(x:ReturnState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},first:()=>run('roster'),next:()=>state.nextCursor?run('roster',state.nextCursor):Promise.resolve(),load:()=>run('preview',null,true),preview:()=>run('preview'),review:()=>run('review'),
  change(enrollmentId:string,from:string,to:string){if(allowed()){cancel();pending=null;set({...state,phase:'ready',enrollmentId,from,to,steps:[],data:null,preview:null,message:null,savePhase:'idle',operationId:null,saved:null});}},
  choose(lessonId:string){if(!allowed()||state.phase!=='ready'||!state.data)return;const lesson=state.data.lessons.find(l=>l.lesson_id===lessonId);if(!lesson||lesson.completed||lesson.block)return;const has=state.steps.some(s=>s.lesson_id===lessonId);if(!has&&state.steps.length===3){set({...state,message:'اختر ثلاث خطوات بحد أقصى.'});return;}edit(has?state.steps.filter(s=>s.lesson_id!==lessonId):[...state.steps,{lesson_id:lessonId,minutes:null}]);},
  duration(lessonId:string,value:string){if(!allowed()||state.phase!=='ready'||!state.steps.some(s=>s.lesson_id===lessonId))return;const minutes=value===''?null:/^[1-9]\d{0,2}$/.test(value)?Number(value):NaN;if(minutes!==null&&(!Number.isInteger(minutes)||minutes>180)){set({...state,preview:null,message:'المدة عدد صحيح من 1 إلى 180 دقيقة، أو فارغة إذا لم تكن معروفة.'});return;}edit(state.steps.map(s=>s.lesson_id===lessonId?{...s,minutes}:s));},
  save:()=>storage('save'),withdraw:()=>storage('withdraw'),recover:()=>storage('recover'),
  invalidate,dispose(){disposed=true;cancel();pending=null;unsub();listeners.clear();state=initialReturn();},
 };
}
