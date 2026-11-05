import {ApiRequestError} from '../../lib/api-http';
import {parseLessonContents,type LessonContent} from './lesson-contents';
export interface LessonVideo {content_id:string;video_id:string;title:string|null;video_status:'uploading'|'processing'|'ready'|'failed'|'unavailable';display_order:number}
export interface VideoOption {video_id:string;title:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
const order=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=2147483647;
const malformed=()=>Error('استجابة فيديوهات الدرس غير صالحة. حدّث البيانات للتحقق.');
export function parseLessonVideo(value:unknown):LessonVideo{
  if(!exact(value,['content_id','video_id','title','video_status','display_order'])||!uuid(value.content_id)||!uuid(value.video_id)||!order(value.display_order)
    ||typeof value.video_status!=='string'||!['uploading','processing','ready','failed','unavailable'].includes(value.video_status)
    ||!(value.video_status==='unavailable'?value.title===null:typeof value.title==='string'&&value.title.length<=255))throw malformed();
  return {content_id:value.content_id,video_id:value.video_id,title:value.title as string|null,video_status:value.video_status as LessonVideo['video_status'],display_order:value.display_order};
}
export function parseLessonVideos(value:unknown):LessonVideo[]{
  if(!exact(value,['videos'])||!Array.isArray(value.videos)||value.videos.length>20)throw malformed();
  const rows=value.videos.map(parseLessonVideo);
  for(const key of ['content_id','video_id','display_order'] as const)if(new Set(rows.map(row=>String(row[key]).toLowerCase())).size!==rows.length)throw malformed();
  if(rows.some((row,n)=>n>0&&rows[n-1].display_order>=row.display_order))throw malformed();return rows;
}
export function parseVideoOptions(value:unknown,cursor:string|null){
  if(!exact(value,['videos','next_cursor'])||!Array.isArray(value.videos)||value.videos.length>25||!(value.next_cursor===null||uuid(value.next_cursor)))throw malformed();
  const rows:VideoOption[]=value.videos.map(row=>{if(!exact(row,['video_id','title'])||!uuid(row.video_id)||typeof row.title!=='string'||row.title.length>255)throw malformed();return {video_id:row.video_id,title:row.title};});
  if(rows.some((row,n)=>row.video_id.toLowerCase()<=(n?rows[n-1].video_id.toLowerCase():cursor?.toLowerCase()??''))||value.next_cursor!==null&&(rows.length!==25||value.next_cursor!==rows[24].video_id))throw malformed();
  return {rows,nextCursor:value.next_cursor as string|null};
}
export interface LessonVideosState {
  phase:'idle'|'ready'|'error'|'denied'|'unavailable'|'session-ended';videos:LessonVideo[];materials:LessonContent[];options:VideoOption[];nextCursor:string|null;
  busy:boolean;stale:boolean;error:string|null;optionsError:string|null;notice:string|null;
}
export const initialLessonVideosState=():LessonVideosState=>({phase:'idle',videos:[],materials:[],options:[],nextCursor:null,busy:false,stale:true,error:null,optionsError:null,notice:null});
export function createLessonVideosController(api:{
  list(signal:AbortSignal):Promise<unknown>;materials(signal:AbortSignal):Promise<unknown>;options(cursor:string|null,signal:AbortSignal):Promise<unknown>;
  attach(input:{video_id:string;display_order:number},signal:AbortSignal):Promise<unknown>;detach(id:string,signal:AbortSignal):Promise<unknown>;
  readPrincipal():string|null;subscribeSession(listener:()=>void):()=>void;
}){
  let state=initialLessonVideosState(),epoch=0,ended=false,abort:AbortController|null=null,confirmedNotice:string|null=null;
  const principal=api.readPrincipal(),listeners=new Set<(value:LessonVideosState)=>void>();
  const set=(patch:Partial<LessonVideosState>)=>{state={...state,...patch};listeners.forEach(fn=>fn(state));};
  const retire=(phase:'denied'|'session-ended')=>{ended=true;confirmedNotice=null;epoch++;abort?.abort();set({...initialLessonVideosState(),phase,error:phase==='denied'?'تعذّر إثبات صلاحية الدرس أو المصدر. أغلق اللوحة وافتحها للتحقق.':'تغيّرت الجلسة. أغلق فيديوهات الدرس وافتحها من جديد.'});};
  const current=(ticket:number)=>{if(ended||ticket!==epoch)return false;if(!principal||principal!==api.readPrincipal()){retire('session-ended');return false;}return true;};
  const claim=()=>{if(ended||state.busy)return null;const ticket=++epoch;if(!current(ticket))return null;abort?.abort();abort=new AbortController();set({busy:true,error:null});return ticket;};
  const unsubscribe=api.subscribeSession(()=>retire('session-ended'));
  const failure=(error:unknown,optionsOnly=false)=>{
    if(error instanceof ApiRequestError&&[401,403,404].includes(error.status)){retire('denied');return;}
    if(error instanceof ApiRequestError&&['LESSON_VIDEOS_UNAVAILABLE','LESSON_CONTENTS_UNAVAILABLE'].includes(error.code??'')){set({...initialLessonVideosState(),phase:'unavailable',error:'إعداد فيديوهات الدرس غير مهيأ في هذه البيئة.'});return;}
    if(optionsOnly)set({options:[],nextCursor:null,optionsError:'تعذّر تحميل اختيارات الفيديو. أعد تحميلها دون إعادة الحفظ.'});
    else set({phase:'error',videos:[],materials:[],options:[],nextCursor:null,stale:true,error:'تعذّر تحديث قائمة الفيديوهات والمواد. يلزم تحديثها قبل تعديل جديد.'});
  };
  const read=async(ticket:number)=>{
    set({videos:[],materials:[],options:[],nextCursor:null,stale:true});
    try{const [rawVideos,rawMaterials]=await Promise.all([api.list(abort!.signal),api.materials(abort!.signal)]);if(!current(ticket))return false;
      const videos=parseLessonVideos(rawVideos),materials=parseLessonContents(rawMaterials);
      if(videos.length+materials.length>20||videos.some(video=>materials.some(material=>material.display_order===video.display_order)))throw malformed();
      set({phase:'ready',videos,materials,stale:false,error:null,notice:confirmedNotice});return true;
    }catch(error){if(current(ticket))failure(error);return false;}
  };
  const readOptions=async(ticket:number,cursor:string|null)=>{
    set({options:[],nextCursor:null,optionsError:null});
    try{const raw=await api.options(cursor,abort!.signal);if(!current(ticket))return;const page=parseVideoOptions(raw,cursor);set({options:page.rows,nextCursor:page.nextCursor});}
    catch(error){if(current(ticket))failure(error,true);}
  };
  const mutate=async(kind:'attach'|'detach',id:string,rawOrder?:string)=>{
    if(ended||state.phase!=='ready'||state.stale||state.busy)return false;
    let position=0;
    if(kind==='attach'){
      const raw=rawOrder?.trim()??'';position=Number(raw);
      if(!/^\d+$/.test(raw)||!order(position)){set({error:'اكتب موضعًا صحيحًا كاملًا من صفر إلى 2147483647.'});return false;}
      if(!state.options.some(row=>row.video_id===id)||state.videos.length+state.materials.length>=20||state.videos.some(row=>row.video_id.toLowerCase()===id.toLowerCase())||[...state.videos,...state.materials].some(row=>row.display_order===position)){set({error:'اختر فيديو غير مرتبط وموضعًا غير مستخدم؛ الحد المشترك ٢٠ محتوى.'});return false;}
    }else if(!state.videos.some(row=>row.content_id===id))return false;
    const ticket=claim();if(ticket===null)return false;let confirmed=false;confirmedNotice=null;set({notice:null});
    try{
      const raw=kind==='attach'?await api.attach({video_id:id,display_order:position},abort!.signal):await api.detach(id,abort!.signal);if(!current(ticket))return false;
      if(kind==='attach'){
        if(!exact(raw,['content','unchanged'])||typeof raw.unchanged!=='boolean')throw malformed();const row=parseLessonVideo(raw.content);
        if(row.video_id.toLowerCase()!==id.toLowerCase()||row.display_order!==position||row.video_status!=='ready')throw malformed();
      }else if(!exact(raw,['detached','content_id'])||raw.detached!==true||raw.content_id!==id)throw malformed();
      confirmed=true;confirmedNotice=kind==='attach'?'تم تأكيد ربط مرجع الفيديو بالدرس؛ هذا لا يفعّل تشغيل الطالب.':'تم تأكيد فك مرجع الفيديو؛ الفيديو الأصلي محفوظ.';set({notice:confirmedNotice});
      if(await read(ticket)&&current(ticket))await readOptions(ticket,null);
      if(current(ticket)&&state.stale)set({notice:'الحفظ مؤكد، لكن تعذّر تحديث القائمة. حدّث البيانات ولا تُعد الحفظ.'});
      return true;
    }catch(error){if(!current(ticket))return false;
      if(error instanceof ApiRequestError&&error.code!=='PERSISTENCE_UNCERTAIN'&&(error.status>=400&&error.status<500||error.code==='LESSON_VIDEOS_UNAVAILABLE'))failure(error);
      else set({videos:[],materials:[],options:[],nextCursor:null,stale:true,phase:'error',notice:null,error:'نتيجة الحفظ غير مؤكدة. حدّث القائمة للتحقق قبل أي محاولة أخرى؛ لم تتم إعادة الإرسال تلقائيًا.'});
      return confirmed;
    }finally{if(current(ticket))set({busy:false});}
  };
  return {getState:()=>state,subscribe(fn:(value:LessonVideosState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},
    async refresh(){const ticket=claim();if(ticket===null)return;try{if(await read(ticket)&&current(ticket))await readOptions(ticket,null);}finally{if(current(ticket))set({busy:false});}},
    async options(next=false){if(state.phase!=='ready'||state.stale||next&&!state.nextCursor)return;const cursor=next?state.nextCursor:null,ticket=claim();if(ticket===null)return;try{await readOptions(ticket,cursor);}finally{if(current(ticket))set({busy:false});}},
    attach:(id:string,position:string)=>mutate('attach',id,position),detach:(id:string)=>mutate('detach',id),invalidate:()=>retire('session-ended'),
    dispose(){unsubscribe();ended=true;epoch++;abort?.abort();listeners.clear();state={...initialLessonVideosState(),phase:'session-ended'};},
  };
}
