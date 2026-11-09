import { ApiRequestError, authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';
import type { PackageKind } from './lesson-package-preview';
import type { TimingChoice, TimingReview } from './lesson-template-timing';
import { canonicalTiming, parseTimingInstant } from './lesson-template-timing';

export interface TemplateSummary {
  id: string;
  name: string;
  status: 'active' | 'archived';
  head_revision: number;
}
export interface TemplateRevisionSummary {
  revision_number: number;
  source_lesson_id: string;
  reference_count: number;
  media_count: number;
}
export interface ApplicationItem {
  kind: PackageKind;
  source_id: string;
  title: string | null;
  display_order: number | null;
  audience: 'course' | 'restricted' | null;
  source_state: 'draft' | 'published' | 'ready' | null;
  outcome: 'add' | 'present' | 'conflict';
  conflict: string | null;
}
export interface ApplicationReview {
  context: ApplicationContext;
  review_token: string;
  can_apply: boolean;
  items: ApplicationItem[];
  projected_media_count: number;
  timing: TimingReview;
}
export interface ApplicationReceipt {
  context: ApplicationContext;
  operation_id: string;
  created: number;
  existing: number;
  timing: { mode: TimingChoice['mode']; release_at: string | null };
}
export interface ApplicationContext { template_id: string; revision_number: number; lesson_id: string }
function parseContext(raw: any): ApplicationContext {
  if (!exact(raw, ['template_id', 'revision_number', 'lesson_id']) || !uuid(raw.template_id) || !uuid(raw.lesson_id) || !Number.isInteger(raw.revision_number) || raw.revision_number < 1) throw bad();
  return { template_id: raw.template_id, revision_number: raw.revision_number, lesson_id: raw.lesson_id };
}
const sameContext = (a: ApplicationContext, b: ApplicationContext) => a.template_id === b.template_id && a.revision_number === b.revision_number && a.lesson_id === b.lesson_id;

const kinds: PackageKind[] = ['material', 'video', 'homework', 'quiz', 'announcement'];
const conflicts = ['source_unavailable', 'different_position', 'position_occupied', 'slot_occupied', 'capacity'];
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x: any, fields: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === fields.slice().sort().join(',');
const bad = () => Error('Invalid lesson template response');

export function canonicalSelection(rows: { kind: PackageKind; source_id: string }[]) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 23 || rows.some(row => !exact(row, ['kind', 'source_id']) || !kinds.includes(row.kind) || !uuid(row.source_id))) throw bad();
  const copy = rows.map(row => ({ kind: row.kind, source_id: row.source_id.toLowerCase() }))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
  if (new Set(copy.map(row => row.kind + '/' + row.source_id)).size !== copy.length || copy.filter(row => ['material', 'video'].includes(row.kind)).length > 20
    || ['homework', 'quiz', 'announcement'].some(kind => copy.filter(row => row.kind === kind).length > 1)) throw bad();
  return copy;
}

function parseTemplate(raw: any, expectArchived = false): TemplateSummary {
  if (!exact(raw, ['id', 'name', 'status', 'head_revision']) || !uuid(raw.id) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120
    || !['active', 'archived'].includes(raw.status) || !Number.isInteger(raw.head_revision) || raw.head_revision < 1 || expectArchived && raw.status !== 'archived') throw bad();
  return { id: raw.id, name: raw.name, status: raw.status, head_revision: raw.head_revision };
}
export function parseTemplateList(raw: any) {
  if (!exact(raw, ['templates', 'next_cursor']) || !Array.isArray(raw.templates) || raw.templates.length > 25
    || raw.next_cursor !== null && (typeof raw.next_cursor !== 'string' || !raw.next_cursor || raw.next_cursor.length > 128)) throw bad();
  return { templates: raw.templates.map((row: any) => parseTemplate(row)), nextCursor: raw.next_cursor as string | null };
}
export function parseRevisionList(raw: any) {
  if (!exact(raw, ['revisions', 'next_cursor']) || !Array.isArray(raw.revisions) || raw.revisions.length > 25
    || raw.next_cursor !== null && (typeof raw.next_cursor !== 'string' || !raw.next_cursor || raw.next_cursor.length > 128)) throw bad();
  const revisions: TemplateRevisionSummary[] = raw.revisions.map((row: any) => {
    if (!exact(row, ['revision_number', 'source_lesson_id', 'reference_count', 'media_count']) || !Number.isInteger(row.revision_number) || row.revision_number < 1
      || !uuid(row.source_lesson_id) || !Number.isInteger(row.reference_count) || row.reference_count < 1 || row.reference_count > 23
      || !Number.isInteger(row.media_count) || row.media_count < 0 || row.media_count > 20) throw bad();
    return { revision_number: row.revision_number, source_lesson_id: row.source_lesson_id, reference_count: row.reference_count, media_count: row.media_count };
  });
  if (new Set(revisions.map(row => row.revision_number)).size !== revisions.length) throw bad();
  return { revisions, nextCursor: raw.next_cursor as string | null };
}
export function parseApplicationReview(raw: any): ApplicationReview {
  if (!exact(raw, ['context', 'review_token', 'can_apply', 'items', 'projected_media_count', 'timing']) || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token)
    || typeof raw.can_apply !== 'boolean' || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 23
    || !Number.isInteger(raw.projected_media_count) || raw.projected_media_count < 0 || raw.projected_media_count > 40) throw bad();
  const items: ApplicationItem[] = raw.items.map((row: any) => {
    if (!exact(row, ['kind', 'source_id', 'title', 'display_order', 'audience', 'source_state', 'outcome', 'conflict'])
      || !kinds.includes(row.kind) || !uuid(row.source_id) || row.title !== null && (typeof row.title !== 'string' || row.title.length > 255)
      || !['course', 'restricted', null].includes(row.audience) || !['draft', 'published', 'ready', null].includes(row.source_state)
      || !['add', 'present', 'conflict'].includes(row.outcome)
      || row.source_state !== null && (row.kind === 'video' ? row.source_state !== 'ready' : !['draft', 'published'].includes(row.source_state))
      || row.audience !== null && (['material', 'video'].includes(row.kind) ? row.audience !== 'course' : row.kind === 'announcement' && row.audience !== 'restricted')
      || (row.outcome === 'conflict' ? !conflicts.includes(row.conflict) : row.conflict !== null)
      || (['material', 'video'].includes(row.kind) ? row.display_order !== null && (!Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647) : row.display_order !== null)
      || row.outcome !== 'conflict' && (row.title === null || row.audience === null || row.source_state === null || ['material', 'video'].includes(row.kind) && row.display_order === null)) throw bad();
    return { kind: row.kind, source_id: row.source_id, title: row.title, display_order: row.display_order, audience: row.audience, source_state: row.source_state, outcome: row.outcome, conflict: row.conflict };
  });
  if (new Set(items.map(row => row.kind + '/' + row.source_id)).size !== items.length) throw bad();
  const timing = raw.timing;
  if (!exact(timing, ['mode', 'current_release_at', 'proposed_release_at']) || !['keep', 'set', 'clear'].includes(timing.mode)
    || ![timing.current_release_at, timing.proposed_release_at].every(value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))) throw bad();
  if (raw.can_apply !== items.every((row: ApplicationItem) => row.outcome !== 'conflict') || raw.can_apply && raw.projected_media_count > 20) throw bad();
  const instant = (value: any) => value === null || typeof value === 'string' && canonicalTiming('set', value).release_at === value;
  if (![timing.current_release_at, timing.proposed_release_at].every(instant) || timing.mode === 'keep' && timing.proposed_release_at !== timing.current_release_at || timing.mode === 'clear' && timing.proposed_release_at !== null || timing.mode === 'set' && timing.proposed_release_at === null) throw bad();
  return { context: parseContext(raw.context), review_token: raw.review_token, can_apply: raw.can_apply, items, projected_media_count: raw.projected_media_count, timing };
}
function parseReceipt(raw: any, operationId: string, count: number, apply: boolean): ApplicationReceipt {
  if (!exact(raw, ['context', 'operation_id', 'created', 'existing', 'timing', ...(apply ? ['replayed'] : [])]) || raw.operation_id !== operationId || !uuid(raw.operation_id)
    || ![raw.created, raw.existing].every(n => Number.isInteger(n) && n >= 0 && n <= 23) || raw.created + raw.existing !== count || apply && typeof raw.replayed !== 'boolean') throw bad();
  if (!exact(raw.timing, ['mode', 'release_at']) || !['keep', 'set', 'clear'].includes(raw.timing.mode)
    || raw.timing.release_at !== null && (typeof raw.timing.release_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.timing.release_at))) throw bad();
  if (raw.timing.release_at !== null && canonicalTiming('set', raw.timing.release_at).release_at !== raw.timing.release_at || raw.timing.mode === 'clear' && raw.timing.release_at !== null) throw bad();
  return { context: parseContext(raw.context), operation_id: raw.operation_id, created: raw.created, existing: raw.existing, timing: raw.timing };
}

async function requestJson(url: string, method: 'GET' | 'POST' | 'PATCH', signal: AbortSignal, body?: unknown) {
  const response = await authenticatedApiFetch(url, {
    method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const raw = await readAuthenticatedApiJson(response);
  if (!response.ok) throw new ApiRequestError('Lesson template request failed', response.status, typeof raw?.code === 'string' ? raw.code : undefined);
  return raw;
}

export type LibraryOperationKind = 'create' | 'revise' | 'archive';
export interface LibraryIntent {
  operation_id:string;operation_kind:LibraryOperationKind;template_id:string|null;
  revision_number:number|null;reference_count:number|null;media_count:number|null;
}
export function templateLibraryIntentStore(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,account:string,courseId:string){
  if(!account||!uuid(courseId))throw bad();
  const key='tabweb.template-library.v1.'+encodeURIComponent(account)+'.'+courseId.toLowerCase();
  const parse=(x:any):LibraryIntent=>{
    const bounded=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isInteger(n)&&n>=min&&n<=max;
    if(!exact(x,['operation_id','operation_kind','template_id','revision_number','reference_count','media_count'])||!uuid(x.operation_id)
      ||!['create','revise','archive'].includes(x.operation_kind)
      ||(x.operation_kind==='create'?x.template_id!==null:!uuid(x.template_id))
      ||(x.operation_kind==='archive'?[x.revision_number,x.reference_count,x.media_count].some(n=>n!==null):
        !bounded(x.revision_number,x.operation_kind==='create'?1:2,x.operation_kind==='create'?1:2147483647)||!bounded(x.reference_count,1,23)||!bounded(x.media_count,0,20)||x.media_count>x.reference_count))throw bad();
    return x;
  };
  return{read():LibraryIntent|null{const raw=storage.getItem(key);return raw===null?null:parse(JSON.parse(raw));},
    write(value:LibraryIntent){storage.setItem(key,JSON.stringify(parse(value)));},clear(){storage.removeItem(key);}};
}
export interface LibraryOutcome { template: TemplateSummary; revision?: { revision_number:number; reference_count:number; media_count:number }; unchanged?:boolean }
export function parseLibraryOutcome(raw:any,kind:LibraryOperationKind):LibraryOutcome {
  const fields=kind==='create'?['template','revision']:kind==='revise'?['template_id','template','revision']:['template','unchanged'];
  if(!exact(raw,fields))throw bad();
  const template=parseTemplate(raw.template,kind==='archive');
  if(kind==='archive') {if(typeof raw.unchanged!=='boolean')throw bad();return{template,unchanged:raw.unchanged};}
  if(template.status!=='active'||kind==='revise'&&raw.template_id!==template.id||!exact(raw.revision,['revision_number','reference_count','media_count'])
    ||!Number.isInteger(raw.revision.revision_number)||raw.revision.revision_number!==template.head_revision
    ||!Number.isInteger(raw.revision.reference_count)||raw.revision.reference_count<1||raw.revision.reference_count>23
    ||!Number.isInteger(raw.revision.media_count)||raw.revision.media_count<0||raw.revision.media_count>20||raw.revision.media_count>raw.revision.reference_count)throw bad();
  return{template,revision:{revision_number:raw.revision.revision_number,reference_count:raw.revision.reference_count,media_count:raw.revision.media_count}};
}
export function templateLibraryTransport(courseId:string) {
  if(!uuid(courseId))throw bad();
  const base=`/tenants/me/catalog/courses/${courseId}/lesson-templates`;
  return {
    list:(cursor:string|null,signal:AbortSignal)=>requestJson(base+'?limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''),'GET',signal).then(parseTemplateList),
    revisions:(templateId:string,cursor:string|null,signal:AbortSignal)=>{if(!uuid(templateId))throw bad();return requestJson(base+'/'+templateId+'/revisions?limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''),'GET',signal).then(parseRevisionList);},
    create:(payload:{name:string;source_lesson_id:string;selections:{kind:PackageKind;source_id:string}[];operation_id:string},signal:AbortSignal)=>{
      if(!uuid(payload.source_lesson_id)||!uuid(payload.operation_id)||typeof payload.name!=='string'||!payload.name.trim()||payload.name.trim().length>120)throw bad();
      return requestJson(base,'POST',signal,{name:payload.name.trim(),source_lesson_id:payload.source_lesson_id.toLowerCase(),selections:canonicalSelection(payload.selections),operation_id:payload.operation_id}).then(raw=>parseLibraryOutcome(raw,'create'));
    },
    revise:(templateId:string,payload:{source_lesson_id:string;selections:{kind:PackageKind;source_id:string}[];expected_revision:number;operation_id:string},signal:AbortSignal)=>{
      if(!uuid(templateId)||!uuid(payload.source_lesson_id)||!uuid(payload.operation_id)||!Number.isInteger(payload.expected_revision)||payload.expected_revision<1)throw bad();
      return requestJson(base+'/'+templateId+'/revisions','POST',signal,{source_lesson_id:payload.source_lesson_id.toLowerCase(),selections:canonicalSelection(payload.selections),expected_revision:payload.expected_revision,operation_id:payload.operation_id}).then(raw=>parseLibraryOutcome(raw,'revise'));
    },
    archive:(templateId:string,operationId:string,signal:AbortSignal)=>{if(!uuid(templateId)||!uuid(operationId))throw bad();return requestJson(base+'/'+templateId,'PATCH',signal,{status:'archived',operation_id:operationId}).then(raw=>parseLibraryOutcome(raw,'archive'));},
    status:async(operationId:string,signal:AbortSignal)=>{if(!uuid(operationId))throw bad();const raw=await requestJson(base+'/operations/'+operationId,'GET',signal);if(!exact(raw,['operation']))throw bad();return raw.operation as any;},
  };
}
export interface TemplateLibraryState {
  phase:'idle'|'loading'|'ready'|'error'|'session-ended'; templates:TemplateSummary[];nextCursor:string|null;
  saving:boolean;recovering:boolean;uncertain:boolean;locked:boolean;operationId:string|null;
  saved:{name:string;head_revision:number;kind:LibraryOperationKind}|null;message:string|null;
}
export const initialTemplateLibrary=():TemplateLibraryState=>({phase:'idle',templates:[],nextCursor:null,saving:false,recovering:false,uncertain:false,locked:false,operationId:null,saved:null,message:null});
export function createTemplateLibrary(deps:ReturnType<typeof templateLibraryTransport>&{
  readPrincipal:()=>string|null;subscribeSession:(listener:()=>void)=>()=>void;newOperationId?:()=>string;
  intent?:ReturnType<typeof templateLibraryIntentStore>;
}) {
  let state=initialTemplateLibrary(),epoch=0,disposed=false,active:AbortController|null=null;
  let pending:{kind:LibraryOperationKind;id:string;templateId?:string;name?:string;revision?:number;count?:number;media?:number}|null=null;
  const principal=deps.readPrincipal(),listeners=new Set<(value:TemplateLibraryState)=>void>();
  try{const old=deps.intent?.read();if(old){pending={kind:old.operation_kind,id:old.operation_id,...old.template_id?{templateId:old.template_id}:{},...old.revision_number!==null?{revision:old.revision_number,count:old.reference_count!,media:old.media_count!}:{}};state={...state,uncertain:true,operationId:old.operation_id,message:'توجد عملية مكتبة محفوظة تحتاج استعلامًا قبل أي كتابة.'};}}
  catch{state={...state,uncertain:true,message:'تعذر إثبات علامة استرجاع المكتبة؛ الكتابة متوقفة.'};}
  const set=(value:TemplateLibraryState)=>{state=value;if(!disposed)listeners.forEach(fn=>fn(state));};
  const cancel=()=>{epoch++;active?.abort();active=null;};
  const invalidate=()=>{cancel();pending=null;set({...initialTemplateLibrary(),phase:'session-ended'});};
  const unsubscribe=deps.subscribeSession(invalidate);
  const alive=(flight:number,c:AbortController)=>!disposed&&epoch===flight&&!c.signal.aborted;
  const valid=(flight:number,c:AbortController)=>{if(!alive(flight,c))return false;if(deps.readPrincipal()!==principal){invalidate();return false;}return true;};
  const permitted=()=>{if(disposed||state.phase==='session-ended')return false;if(!principal||deps.readPrincipal()!==principal){invalidate();return false;}return!state.saving&&!state.uncertain&&!state.locked;};
  async function load(cursor:string|null) {
    if(!permitted())return;cancel();const flight=epoch,c=new AbortController();active=c;
    set({...state,phase:'loading',templates:[],nextCursor:null,message:null});
    const timer=setTimeout(()=>{if(valid(flight,c)){cancel();set({...state,phase:'error',message:'انتهت مهلة قراءة القوالب؛ لا توجد قائمة حالية مؤكدة.'});}},25000);
    try {const page=await deps.list(cursor,c.signal);if(!valid(flight,c))return;
      if(page.nextCursor!==null&&page.nextCursor===cursor||page.templates.length>25||new Set(page.templates.map(x=>x.id.toLowerCase())).size!==page.templates.length)throw bad();
      set({...state,phase:'ready',templates:page.templates,nextCursor:page.nextCursor});
    }catch{if(valid(flight,c))set({...state,phase:'error',message:state.saved?'الحفظ مؤكد، لكن تعذر تحديث قائمة القوالب.':'تعذر قراءة قائمة القوالب الحالية.'});}
    finally{clearTimeout(timer);if(active===c)active=null;}
  }
  function verifyOutcome(value:LibraryOutcome,p:NonNullable<typeof pending>) {
    if(p.templateId&&value.template.id!==p.templateId||p.name&&value.template.name!==p.name||p.revision&&value.revision?.revision_number!==p.revision||p.count!==undefined&&value.revision?.reference_count!==p.count||p.media!==undefined&&value.revision?.media_count!==p.media)throw bad();
    return value;
  }
  const saved=(value:LibraryOutcome,p:NonNullable<typeof pending>)=>{
    let cleaned=true;try{deps.intent?.clear();}catch{cleaned=false;}if(cleaned)pending=null;
    set({...initialTemplateLibrary(),locked:state.locked,uncertain:!cleaned,operationId:cleaned?null:p.id,
      saved:{name:value.template.name,head_revision:value.template.head_revision,kind:p.kind},
      message:cleaned?'الحفظ مؤكد؛ حدّث القائمة لقراءة الحالة الحالية.':'الحفظ مؤكد، لكن تنظيف علامة الاسترجاع لم يكتمل. الكتابة متوقفة حتى تسوية نفس العملية.'});
  };
  async function write(kind:LibraryOperationKind,details:Omit<NonNullable<typeof pending>,'kind'|'id'>,work:(id:string,signal:AbortSignal)=>Promise<LibraryOutcome>){
    if(!permitted())return;let id:string;try{id=(deps.newOperationId?.()??crypto.randomUUID()).toLowerCase();if(!uuid(id))throw bad();}catch{set({...state,message:'تعذر تجهيز معرّف العملية.'});return;}
    const p={kind,id,...details};
    try{deps.intent?.write({operation_id:id,operation_kind:kind,template_id:details.templateId??null,revision_number:details.revision??null,reference_count:details.count??null,media_count:details.media??null});}
    catch{set({...state,message:'تعذر حفظ علامة الاسترجاع؛ لم يُرسل طلب كتابة.'});return;}
    if(!permitted())return;
    cancel();pending=p;const flight=epoch,c=new AbortController();active=c;
    set({...state,saving:true,operationId:id,saved:null,message:null});
    const uncertain=()=>set({...state,saving:false,recovering:false,uncertain:true,message:'نتيجة الحفظ غير محسومة؛ تحقق من سجل نفس العملية دون إعادة الكتابة.'});
    const timer=setTimeout(()=>{if(valid(flight,c)){cancel();uncertain();}},25000);
    try{const outcome=await work(id,c.signal);if(!valid(flight,c))return;
      const value=verifyOutcome(parseLibraryOutcome(kind==='revise'?{...outcome,template_id:outcome.template.id}:outcome,kind),p);saved(value,p);}
    catch(error){if(valid(flight,c)){if(error instanceof ApiRequestError&&error.status>=400&&error.status<500){let cleaned=true;try{deps.intent?.clear();}catch{cleaned=false;}if(cleaned){pending=null;set({...state,saving:false,uncertain:false,operationId:null,message:'رُفضت العملية؛ حدّث البيانات قبل مراجعة جديدة.'});}else uncertain();}else uncertain();}}
    finally{clearTimeout(timer);if(active===c)active=null;}
  }
  return {
    subscribe(fn:(value:TemplateLibraryState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},
    refresh(){return load(null);},next(){return state.phase==='ready'&&state.nextCursor?load(state.nextCursor):Promise.resolve();},
    create(name:string,sourceLessonId:string,selections:{kind:PackageKind;source_id:string}[]){
      if(!permitted())return Promise.resolve();
      try{if(typeof name!=='string'||!name.trim()||name.trim().length>120||!uuid(sourceLessonId))throw bad();selections=canonicalSelection(selections);}
      catch{set({...state,message:'راجع اسم القالب والحصة والمراجع؛ لم يُرسل طلب كتابة.'});return Promise.resolve();}
      return write('create',{name:name.trim(),revision:1,count:selections.length,media:selections.filter(row=>['material','video'].includes(row.kind)).length},(operation_id,signal)=>deps.create({name,source_lesson_id:sourceLessonId,selections,operation_id},signal));
    },
    revise(templateId:string,expectedRevision:number,sourceLessonId:string,selections:{kind:PackageKind;source_id:string}[]){
      if(!permitted())return Promise.resolve();
      try{if(!uuid(templateId)||!uuid(sourceLessonId)||!Number.isInteger(expectedRevision)||expectedRevision<1||expectedRevision>=2147483647)throw bad();selections=canonicalSelection(selections);}
      catch{set({...state,message:'راجع القالب والمراجعة والحصة والمراجع؛ لم يُرسل طلب كتابة.'});return Promise.resolve();}
      return write('revise',{templateId,revision:expectedRevision+1,count:selections.length,media:selections.filter(row=>['material','video'].includes(row.kind)).length},(operation_id,signal)=>deps.revise(templateId,{source_lesson_id:sourceLessonId,selections,expected_revision:expectedRevision,operation_id},signal));
    },
    archive(templateId:string){if(!permitted())return Promise.resolve();if(!uuid(templateId)){set({...state,message:'معرف القالب غير صالح؛ لم يُرسل طلب كتابة.'});return Promise.resolve();}return write('archive',{templateId},(operationId,signal)=>deps.archive(templateId,operationId,signal));},
    async recover(){
      if(disposed||!state.uncertain||state.saving||state.locked||!pending)return;
      if(!principal||deps.readPrincipal()!==principal){invalidate();return;}
      cancel();const p=pending,flight=epoch,c=new AbortController();active=c;set({...state,saving:true,recovering:true});
      const fail=()=>set({...state,saving:false,recovering:false,uncertain:true,message:state.saved?'الحفظ مؤكد؛ تعذر تسوية علامة الاسترجاع. لا تُعد الكتابة.':'لم يظهر حفظ مؤكد بعد؛ لا تُعد العملية.'});
      const timer=setTimeout(()=>{if(valid(flight,c)){cancel();fail();}},25000);
      try{const raw=await deps.status(p.id,c.signal);if(!valid(flight,c))return;if(raw===null){fail();return;}
        if(raw.operation_id!==p.id||raw.operation_kind!==p.kind)throw bad();
        const {operation_id,operation_kind,...value}=raw;saved(verifyOutcome(parseLibraryOutcome(value,p.kind),p),p);
      }catch{if(valid(flight,c))fail();}finally{clearTimeout(timer);if(active===c)active=null;}
    },
    setLocked(locked:boolean){if(!disposed&&state.locked!==locked)set({...state,locked});},
    invalidate,dispose(){disposed=true;cancel();unsubscribe();listeners.clear();pending=null;},
  };
}

export function templateApplicationTransport(courseId: string, unitId: string, lessonId: string) {
  if (![courseId, unitId, lessonId].every(uuid)) throw bad();
  const base = `/tenants/me/catalog/courses/${courseId}/units/${unitId}/lessons/${lessonId}/lesson-template-`;
  const payload = (templateId: string, revisionNumber: number, timing: TimingChoice) => {
    if (!uuid(templateId) || !Number.isInteger(revisionNumber) || revisionNumber < 1) throw bad();
    return { template_id: templateId.toLowerCase(), revision_number: revisionNumber, timing };
  };
  return {
    review: (templateId: string, revisionNumber: number, timing: TimingChoice, signal: AbortSignal) =>
      requestJson(base + 'review', 'POST', signal, payload(templateId, revisionNumber, canonicalTiming(timing.mode, timing.release_at))).then(raw => {
        const review = parseApplicationReview(raw);
        if (!sameContext(review.context, { template_id: templateId.toLowerCase(), revision_number: revisionNumber, lesson_id: lessonId.toLowerCase() })) throw bad();
        return review;
      }),
    apply: (templateId: string, revisionNumber: number, timing: TimingChoice, token: string, operationId: string, expectedCount: number, signal: AbortSignal) => {
      if (!uuid(operationId) || !/^[a-f\d]{64}$/.test(token) || !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 23) throw bad();
      return requestJson(base + 'apply', 'POST', signal, {
        ...payload(templateId, revisionNumber, canonicalTiming(timing.mode, timing.release_at)), review_token: token, operation_id: operationId,
      }).then((raw: any) => {
        const receipt = parseReceipt(raw, operationId, expectedCount, true);
        if (!sameContext(receipt.context, { template_id: templateId.toLowerCase(), revision_number: revisionNumber, lesson_id: lessonId.toLowerCase() })) throw bad();
        return receipt;
      });
    },
    status: (operationId: string, signal: AbortSignal) => {
      if (!uuid(operationId)) throw bad();
      return requestJson(base + 'operations/' + operationId, 'GET', signal).then((raw: any) => {
        if (!exact(raw, ['operation'])) throw bad();
        return raw.operation as any;
      });
    },
  };
}

export interface TemplateApplicationState {
  phase: 'idle' | 'reviewing' | 'reviewed' | 'applying' | 'recovering' | 'uncertain' | 'saved' | 'error' | 'session-ended';
  review: ApplicationReview | null;
  result: ApplicationReceipt | null;
  operationId: string | null;
  templateId: string | null;
  revisionNumber: number | null;
  itemCount: number;
  message: string | null;
}
export const initialTemplateApplication = (): TemplateApplicationState => ({ phase: 'idle', review: null, result: null, operationId: null, templateId: null, revisionNumber: null, itemCount: 0, message: null });

export interface TemplateApplicationIntent {
  operation_id:string;course_id:string;unit_id:string;lesson_id:string;template_id:string;
  revision_number:number;item_count:number;mode:TimingChoice['mode'];release_at:string|null;
}
export function templateApplicationIntentStore(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,account:string,courseId:string){
  if(!account||!uuid(courseId))throw bad();
  const key='tabweb.template-application.v1.'+encodeURIComponent(account)+'.'+courseId.toLowerCase();
  const parse=(raw:unknown):TemplateApplicationIntent=>{
    const x=raw as Record<string,unknown>;
    if(!exact(x,['operation_id','course_id','unit_id','lesson_id','template_id','revision_number','item_count','mode','release_at'])
      ||![x.operation_id,x.course_id,x.unit_id,x.lesson_id,x.template_id].every(uuid)||x.course_id!==courseId.toLowerCase()
      ||!Number.isInteger(x.revision_number)||(x.revision_number as number)<1||(x.revision_number as number)>2147483647
      ||!Number.isInteger(x.item_count)||(x.item_count as number)<1||(x.item_count as number)>23
      ||!['keep','set','clear'].includes(x.mode as string)||x.release_at!==null&&(typeof x.release_at!=='string'||parseTimingInstant(x.release_at)!==x.release_at)
      ||x.mode==='clear'&&x.release_at!==null||x.mode==='set'&&x.release_at===null)throw bad();
    return x as unknown as TemplateApplicationIntent;
  };
  return{read():TemplateApplicationIntent|null{const raw=storage.getItem(key);return raw?parse(JSON.parse(raw)):null;},
    write(value:TemplateApplicationIntent){storage.setItem(key,JSON.stringify(parse(value)));},clear(){storage.removeItem(key);}};
}

export function createTemplateApplication(deps: ReturnType<typeof templateApplicationTransport> & {
  readPrincipal: () => string | null;
  subscribeSession: (listener: () => void) => () => void;
  newOperationId: () => string;
  intent?:ReturnType<typeof templateApplicationIntentStore>;
  destination?:{course_id:string;unit_id:string;lesson_id:string};
}) {
  let state = initialTemplateApplication(), epoch = 0, disposed = false, active: AbortController | null = null;
  const principal = deps.readPrincipal();

  let expectation:{context:ApplicationReview['context'];mode:TimingChoice['mode'];release_at:string|null}|null=null;
  try{
    const pending=deps.intent?.read();
    if(pending){
      if(!deps.destination||pending.course_id!==deps.destination.course_id||pending.unit_id!==deps.destination.unit_id||pending.lesson_id!==deps.destination.lesson_id)throw bad();
      expectation={context:{template_id:pending.template_id,revision_number:pending.revision_number,lesson_id:pending.lesson_id},mode:pending.mode,release_at:pending.release_at};
      state={...state,phase:'uncertain',operationId:pending.operation_id,templateId:pending.template_id,revisionNumber:pending.revision_number,itemCount:pending.item_count,message:'توجد عملية تطبيق محفوظة للتحقق. الاستعلام فقط متاح حتى يثبت الإيصال.'};
    }
  }catch{state={...state,phase:'uncertain',message:'تعذر إثبات سياق الاسترجاع المحفوظ. الكتابة متوقفة.'};}
  const listeners = new Set<(value: TemplateApplicationState) => void>();
  const set = (next: TemplateApplicationState) => { state = next; if (!disposed) listeners.forEach(fn => fn(state)); };
  const cancel = () => { epoch++; active?.abort(); active = null; };
  const invalidate = () => { cancel(); expectation = null; set({ ...initialTemplateApplication(), phase: 'session-ended' }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  const busy = () => ['reviewing', 'applying', 'recovering'].includes(state.phase);
  async function run(kind: 'review' | 'apply' | 'recover', work: (signal: AbortSignal) => Promise<void>) {
    if (disposed || busy() || state.phase === 'session-ended') return;
    if (!principal || deps.readPrincipal() !== principal) return invalidate();
    cancel();
    const flight = epoch, controller = new AbortController(); active = controller;
    set({ ...state, phase: kind === 'review' ? 'reviewing' : kind === 'apply' ? 'applying' : 'recovering', result: kind === 'recover' ? state.result : null, message: null });
    const current = () => !disposed && epoch === flight && !controller.signal.aborted;
    const timer = setTimeout(() => { if (current()) { if (deps.readPrincipal() !== principal) return invalidate(); cancel(); set({ ...state, review: null, phase: kind === 'review' ? 'error' : 'uncertain', message: 'انتهت مهلة الطلب دون نتيجة محسومة' }); } }, 25000);
    try { await work(controller.signal); }
    catch (error) {
      if (current()) {
        if (deps.readPrincipal() !== principal) invalidate();
        else {
          const rejected=kind==='apply'&&error instanceof ApiRequestError&&error.status>=400&&error.status<500;
          let cleaned=true;if(rejected)try{deps.intent?.clear();}catch{cleaned=false;}
          if(rejected&&cleaned){expectation=null;}
          set({ ...state, review: null, result: kind === 'recover' ? state.result : null, phase: !cleaned||kind === 'recover' || kind === 'apply' && !rejected ? 'uncertain' : 'error', message: 'لم يتم تأكيد الطلب. راجع الحالة قبل أي إعادة.' });
        }
      }
    }
    finally { clearTimeout(timer); if (active === controller) active = null; }
  }
  const guarded = (signal: AbortSignal) => !disposed && !signal.aborted && deps.readPrincipal() === principal;
  const confirmResult=(result:ApplicationReceipt,operationId:string)=>{
    let cleaned=true;try{deps.intent?.clear();}catch{cleaned=false;}
    if(cleaned){expectation=null;}
    set({...state,phase:cleaned?'saved':'uncertain',review:null,result,operationId,message:cleaned?'تم تأكيد التطبيق والجدولة معًا':'الحفظ مؤكد؛ تعذر تنظيف علامة الاسترجاع. تحقق من الإيصال قبل كتابة أخرى.'});
  };
  return {
    subscribe(fn: (value: TemplateApplicationState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    clear() { if (!busy() && state.phase !== 'uncertain' && state.phase !== 'session-ended') { cancel(); set(initialTemplateApplication()); } },
    async review(templateId: string, revisionNumber: number, timing: TimingChoice) {
      if (busy() || state.phase === 'uncertain' || state.phase === 'session-ended' || disposed) return;
      await run('review', async signal => {
        const review = await deps.review(templateId, revisionNumber, timing, signal);
        if (!guarded(signal)) { if (!disposed && !signal.aborted) invalidate(); return; }
        const requested = canonicalTiming(timing.mode, timing.release_at);
        if (review.context.template_id !== templateId || review.context.revision_number !== revisionNumber || review.timing.mode !== requested.mode || requested.mode !== 'keep' && review.timing.proposed_release_at !== requested.release_at) throw bad();

        set({ ...initialTemplateApplication(), phase: 'reviewed', review, templateId, revisionNumber, itemCount: review.items.length });
      });
    },
    async apply(confirmed: boolean) {
      if (!confirmed || state.phase !== 'reviewed' || !state.review?.can_apply) return;
      if(!principal||deps.readPrincipal()!==principal)return invalidate();
      const review = state.review, templateId = state.templateId, revisionNumber = state.revisionNumber;
      if (!templateId || !revisionNumber) return;
      let operationId: string;
      try { operationId = deps.newOperationId().toLowerCase(); if (!uuid(operationId)) throw bad(); }
      catch { set({ ...state, phase: 'error', message: 'تعذر إنشاء رقم عملية صالح' }); return; }
      const timing: TimingChoice = {
        mode: review.timing.mode,
        release_at: review.timing.mode === 'set' ? review.timing.proposed_release_at : null,
      };
      expectation={context:review.context,mode:review.timing.mode,release_at:review.timing.proposed_release_at};
      if(deps.intent){
        try{if(!deps.destination||deps.destination.lesson_id!==review.context.lesson_id)throw bad();deps.intent.write({operation_id:operationId,...deps.destination,template_id:templateId,revision_number:revisionNumber,item_count:review.items.length,mode:review.timing.mode,release_at:review.timing.proposed_release_at});}
        catch{set({...state,message:'تعذر حفظ معرّف الاسترجاع؛ لم يُرسل طلب تطبيق.'});return;}
      }
      set({ ...state, operationId });
      await run('apply', async signal => {
        const result = await deps.apply(templateId, revisionNumber, timing, review.review_token, operationId, state.itemCount, signal);
        if (!guarded(signal)) { if (!disposed && !signal.aborted) invalidate(); return; }
        if (!sameContext(result.context, review.context) || result.timing.mode !== review.timing.mode || result.timing.release_at !== review.timing.proposed_release_at || result.created + result.existing !== review.items.length) throw bad();
        confirmResult(result,operationId);
      });
    },
    async recover() {
      if (state.phase !== 'uncertain' || !state.operationId) return;
      const operationId = state.operationId, itemCount = state.itemCount;
      await run('recover', async signal => {
        const raw = await deps.status(operationId, signal);
        if (raw !== null && !exact(raw, ['context', 'operation_id', 'created', 'existing', 'timing'])) throw bad();
        if (!guarded(signal)) { if (!disposed && !signal.aborted) invalidate(); return; }
        const result = raw === null ? null : parseReceipt(raw, operationId, itemCount, false);
        if (result && (!expectation || !sameContext(result.context, expectation.context) || result.timing.mode !== expectation.mode || result.timing.release_at !== expectation.release_at)) throw bad();
        if(result)confirmResult(result,operationId);
        else set({ ...state, phase:'uncertain', review: null, result:state.result, operationId, message:'لا يوجد سجل مؤكد بعد؛ لا تُعد المحاولة' });
      });
    },
    invalidate,
    dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialTemplateApplication(); },
  };
}
