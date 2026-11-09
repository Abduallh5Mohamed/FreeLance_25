import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
export interface LearningWindow { group_id:string;from:string;to:string }
export interface LearningEvidence {question_ref:string;position:number;text:string;responses:number;not_correct:number}
export interface LearningSuggestion {tag:string;responses:number;not_fully_correct:number;question_count:number;evidence:LearningEvidence[]}
export interface LessonLearning {
  context:{course_id:string;lesson_id:string}&LearningWindow; checked_at:string;group_name:string;rule_version:'automatic-tags-v1';reason:null|'no_quiz'|'no_published_version';
  state:'available'|'insufficient';graded_attempts:number|null;automatic_questions:number|null;unmapped_questions:number|null;excluded_manual_questions:number|null;suggestions:LearningSuggestion[];
}
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact=(x:any,keys:string[])=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const iso=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const invalid=()=>Error('Invalid learning evidence');
export function learningWindow(group_id:string,from:string,to:string):LearningWindow {
  if(!uuid(group_id)||!iso(from)||!iso(to)||Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>31*86400000)throw invalid();
  return{group_id:group_id.toLowerCase(),from,to};
}
export function parseLessonLearning(raw:any,courseId:string,lessonId:string,window:LearningWindow):LessonLearning {
  const count=(n:unknown,max:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=max;
  if(!exact(raw,['context','checked_at','group_name','rule_version','reason','state','graded_attempts','automatic_questions','unmapped_questions','excluded_manual_questions','suggestions'])
    ||!exact(raw.context,['course_id','lesson_id','group_id','from','to'])||raw.context.course_id!==courseId||raw.context.lesson_id!==lessonId
    ||Object.keys(window).some(key=>raw.context[key]!==window[key as keyof LearningWindow])||typeof raw.checked_at!=='string'||!Number.isFinite(Date.parse(raw.checked_at))
    ||typeof raw.group_name!=='string'||!raw.group_name.trim()||raw.group_name.length>255||raw.rule_version!=='automatic-tags-v1'||![null,'no_quiz','no_published_version'].includes(raw.reason)
    ||!['available','insufficient'].includes(raw.state)||!Array.isArray(raw.suggestions)||raw.suggestions.length>2)throw invalid();
  if(raw.reason!==null){if(raw.state!=='insufficient'||raw.suggestions.length||[raw.graded_attempts,raw.automatic_questions,raw.unmapped_questions,raw.excluded_manual_questions].some(x=>x!==null))throw invalid();return raw;}
  if(!count(raw.graded_attempts,100)||!count(raw.automatic_questions,200)||!count(raw.unmapped_questions,raw.automatic_questions)||!count(raw.excluded_manual_questions,200-raw.automatic_questions))throw invalid();
  const expected=raw.graded_attempts<5||raw.automatic_questions===raw.unmapped_questions?'insufficient':'available';
  if(raw.state!==expected||raw.state==='insufficient'&&raw.suggestions.length||raw.reason!==null&&(raw.graded_attempts!==0||raw.automatic_questions!==0||raw.excluded_manual_questions!==0))throw invalid();
  for(const s of raw.suggestions){
    if(!exact(s,['tag','responses','not_fully_correct','question_count','evidence'])||typeof s.tag!=='string'||!s.tag.trim()||s.tag.length>48
      ||!count(s.question_count,raw.automatic_questions)||!s.question_count||s.responses!==s.question_count*raw.graded_attempts||!count(s.not_fully_correct,s.responses)||s.not_fully_correct*100<s.responses*40
      ||!Array.isArray(s.evidence)||s.evidence.length!==Math.min(5,s.question_count))throw invalid();
    for(const q of s.evidence)if(!exact(q,['question_ref','position','text','responses','not_correct'])||!uuid(q.question_ref)||!Number.isInteger(q.position)||q.position<1||q.position>200
      ||typeof q.text!=='string'||!q.text.trim()||q.text.length>1000||q.responses!==raw.graded_attempts||!count(q.not_correct,q.responses))throw invalid();
    if(new Set(s.evidence.map((q:LearningEvidence)=>q.question_ref)).size!==s.evidence.length)throw invalid();
  }
  if(new Set(raw.suggestions.map((s:LearningSuggestion)=>s.tag)).size!==raw.suggestions.length)throw invalid();
  return raw;
}
export function lessonLearningTransport(courseId:string,unitId:string,lessonId:string){
  if(![courseId,unitId,lessonId].every(uuid))throw invalid();
  const base=`/tenants/me/catalog/courses/${courseId.toLowerCase()}/units/${unitId.toLowerCase()}/lessons/${lessonId.toLowerCase()}/preparation`;
  async function get(url:string,signal:AbortSignal){const response=await authenticatedApiFetch(url,{signal,cache:'no-store'});const raw=await readAuthenticatedApiJson(response);if(!response.ok)throw new ApiRequestError('Learning evidence unavailable',response.status);return raw;}
  return{
    async groups(cursor:string|null,signal:AbortSignal){if(cursor!==null&&!uuid(cursor))throw invalid();const raw=await get(base+'/groups'+(cursor?'?cursor='+encodeURIComponent(cursor):''),signal);
      if(!exact(raw,['groups','next_cursor'])||!Array.isArray(raw.groups)||raw.groups.length>25||raw.next_cursor!==null&&(!uuid(raw.next_cursor)||raw.next_cursor===cursor)
        ||raw.groups.some((g:any)=>!exact(g,['id','name'])||!uuid(g.id)||typeof g.name!=='string'||!g.name.trim()||g.name.length>255)||new Set(raw.groups.map((g:any)=>g.id.toLowerCase())).size!==raw.groups.length)throw invalid();
      return{groups:raw.groups as {id:string;name:string}[],nextCursor:raw.next_cursor as string|null};
    },
    async read(window:LearningWindow,signal:AbortSignal){const canonical=learningWindow(window.group_id,window.from,window.to);const query=new URLSearchParams({...canonical});return parseLessonLearning(await get(base+'/learning?'+query,signal),courseId.toLowerCase(),lessonId.toLowerCase(),canonical);},
  };
}
/** Plain teacher-selected brief; deliberately excludes questions, answers and IDs. */
export function learningBrief(data:LessonLearning,decisions:Record<string,'use'|'dismiss'>):string {
 const chosen=data.suggestions.filter(s=>decisions[s.tag]==='use');
 if(data.state!=='available'||!chosen.length)throw invalid();
 return [`مسودة تحضير محلية — ${data.group_name}`,`الفترة UTC: ${data.context.from} إلى ${data.context.to}`,`وقت القراءة: ${data.checked_at}`,
  `محاولات مكتملة التصحيح: ${data.graded_attempts}؛ الأعداد أدناه للإجابات، وليست قياسًا للفهم.`,
  ...chosen.map(s=>`- ${s.tag}: ${s.not_fully_correct} من ${s.responses} إجابة لم تسجل صحيحة بالكامل، عبر ${s.question_count} سؤال.`),
  'اختيار المدرس من وسوم النسخة المثبتة؛ ليس تشخيصًا للفهم أو عددًا للطلاب، ولا نشرًا أو إرسالًا للأسرة.'].join('\n');
}
export interface LearningState {phase:'idle'|'loading'|'ready'|'error'|'session-ended';groups:{id:string;name:string}[];nextCursor:string|null;groupId:string;from:string;to:string;data:LessonLearning|null;decisions:Record<string,'use'|'dismiss'>;copyPhase:'idle'|'copying'|'copied'|'error'}
export const initialLearning=():LearningState=>({phase:'idle',groups:[],nextCursor:null,groupId:'',from:'',to:'',data:null,decisions:{},copyPhase:'idle'});
export function createLessonLearning(deps:ReturnType<typeof lessonLearningTransport>&{readPrincipal:()=>string|null;subscribeSession:(fn:()=>void)=>()=>void;copyText?:(text:string)=>Promise<void>}){
  let state=initialLearning(),epoch=0,active:AbortController|null=null,disposed=false;
  const identity=deps.readPrincipal(),listeners=new Set<(value:LearningState)=>void>();
  const set=(x:LearningState)=>{state=x;if(!disposed)listeners.forEach(fn=>fn(x));};
  const cancel=()=>{epoch++;active?.abort();active=null;};
  const invalidate=()=>{cancel();set({...initialLearning(),phase:'session-ended'});};
  const unsub=deps.subscribeSession(invalidate);
  const allowed=()=>{if(disposed||state.phase==='session-ended')return false;if(!identity||identity!==deps.readPrincipal()){invalidate();return false;}return true;};
  async function run(kind:'groups'|'read',cursor:string|null=null){
    if(!allowed())return;
    let window:LearningWindow|null=null;
    if(kind==='read'){try{if(!state.groups.some(g=>g.id===state.groupId))throw invalid();window=learningWindow(state.groupId,state.from,state.to);}catch{cancel();set({...state,phase:'error',data:null,decisions:{}});return;}}
    cancel();const flight=epoch,c=new AbortController();active=c;
    set({...state,phase:'loading',data:null,decisions:{},copyPhase:'idle',...(kind==='groups'?{groups:[],nextCursor:null,groupId:''}:{})});
    const current=()=>!disposed&&epoch===flight&&!c.signal.aborted&&allowed();
    const timer=setTimeout(()=>{if(current()){cancel();set({...state,phase:'error',data:null});}},25000);
    try{if(kind==='groups'){const page=await deps.groups(cursor,c.signal);if(current())set({...state,phase:'ready',...page});}else{const data=await deps.read(window!,c.signal);if(current())set({...state,phase:'ready',data});}}
    catch{if(current())set({...state,phase:'error',data:null});}finally{clearTimeout(timer);if(active===c)active=null;}
  }
  return{
    subscribe(fn:(state:LearningState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},
    first:()=>run('groups'),next:()=>state.nextCursor?run('groups',state.nextCursor):Promise.resolve(),read:()=>run('read'),
    change(groupId:string,from:string,to:string){if(!allowed())return;cancel();set({...state,phase:'ready',groupId,from,to,data:null,decisions:{},copyPhase:'idle'});},
    decide(tag:string,choice:'use'|'dismiss'){if(allowed()&&state.phase==='ready'&&['use','dismiss'].includes(choice)&&state.data?.suggestions.some(s=>s.tag===tag)){cancel();set({...state,decisions:{...state.decisions,[tag]:choice},copyPhase:'idle'});}},
    async copy(){
      if(!allowed()||state.phase!=='ready'||!state.data||state.copyPhase==='copying')return;
      let text:string;try{text=learningBrief(state.data,state.decisions);if(!deps.copyText)throw invalid();}catch{set({...state,copyPhase:'error'});return;}
      cancel();const flight=epoch;set({...state,copyPhase:'copying'});
      const current=()=>!disposed&&flight===epoch&&allowed();
      const timer=setTimeout(()=>{if(current()){cancel();set({...state,copyPhase:'error'});}},10000);
      try{await deps.copyText!(text);if(current())set({...state,copyPhase:'copied'});}
      catch{if(current())set({...state,copyPhase:'error'});}finally{clearTimeout(timer);}
    },
    invalidate,dispose(){disposed=true;cancel();unsub();listeners.clear();state=initialLearning();},
  };
}
