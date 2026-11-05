import {useEffect,useId,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {listLessonVideos,listLessonVideoOptions,listLessonContents,attachLessonVideo,detachLessonVideo} from '@/lib/api-http';
import {subscribeSessionChange} from '@/lib/session-events';
import {readCourseSessionPrincipal} from './course-management';
import {createLessonVideosController,initialLessonVideosState,type LessonVideosState} from './lesson-videos';
type Target={courseId:string;unitId:string;lessonId:string};
const statuses:Record<string,string>={ready:'معالج وجاهز كمصدر',uploading:'جارٍ رفع المصدر',processing:'جارٍ معالجة المصدر',failed:'فشلت معالجة المصدر',unavailable:'المصدر غير متاح'};
export function LessonVideoManager(props:Target){
  const [open,setOpen]=useState(false);
  return <div className="w-full border-t border-slate-100 pt-2"><Button type="button" size="sm" variant="outline" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'إغلاق فيديوهات الدرس':'إدارة فيديوهات الدرس'}</Button>
    {open?<LessonVideoEditor key={`${props.courseId}/${props.unitId}/${props.lessonId}`} {...props}/>:null}</div>;
}
export function LessonVideoEditor({courseId,unitId,lessonId}:Target){
  const [state,setState]=useState<LessonVideosState>(initialLessonVideosState),[selected,setSelected]=useState(''),[position,setPosition]=useState('0'),[removeId,setRemoveId]=useState<string|null>(null);
  const ref=useRef<ReturnType<typeof createLessonVideosController>|null>(null),formId=useId();
  useEffect(()=>{
    const controller=createLessonVideosController({list:signal=>listLessonVideos(courseId,unitId,lessonId,signal),materials:signal=>listLessonContents(courseId,unitId,lessonId,signal),options:(cursor,signal)=>listLessonVideoOptions(courseId,unitId,lessonId,cursor,signal),
      attach:(input,signal)=>attachLessonVideo(courseId,unitId,lessonId,input,signal),detach:(id,signal)=>detachLessonVideo(courseId,unitId,lessonId,id,signal),
      readPrincipal:()=>{try{return readCourseSessionPrincipal(localStorage);}catch{return null;}},subscribeSession:subscribeSessionChange,
    });
    ref.current=controller;const unsubscribe=controller.subscribe(value=>{setState(value);if(value.phase==='denied'||value.phase==='session-ended'||value.phase==='unavailable'){setSelected('');setPosition('0');setRemoveId(null);}});
    const storage=(event:StorageEvent)=>{if(event.key===null||['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession','supabaseUser'].includes(event.key))controller.invalidate();};
    window.addEventListener('storage',storage);void controller.refresh();
    return()=>{window.removeEventListener('storage',storage);unsubscribe();controller.dispose();ref.current=null;};
  },[courseId,unitId,lessonId]);
  const attached=new Set(state.videos.map(row=>row.video_id.toLowerCase())),options=state.options.filter(row=>!attached.has(row.video_id.toLowerCase()));
  const canWrite=state.phase==='ready'&&!state.busy&&!state.stale,total=state.videos.length+state.materials.length,validSelection=options.some(row=>row.video_id===selected);
  return <section dir="rtl" aria-label="إعداد فيديوهات الدرس" className="mt-3 min-w-0 space-y-3 rounded-lg border border-violet-200 bg-violet-50/40 p-3 text-sm">
    <p className="font-medium">مراجع فيديو الدرس</p><p>هذه إدارة مراجع فقط؛ الربط وحالة المعالجة لا يفعّلان تشغيل الطالب ولا يغيّران تقدمه.</p>
    <div aria-live="polite">{state.busy?<p>جارٍ تنفيذ العملية…</p>:null}{state.notice?<p className="text-emerald-800">{state.notice}</p>:null}{state.error?<p role="alert" className="text-red-700">{state.error}</p>:null}</div>
    <Button type="button" size="sm" variant="outline" disabled={state.busy||state.phase==='session-ended'||state.phase==='denied'} onClick={()=>{setSelected('');setRemoveId(null);void ref.current?.refresh();}}>تحديث فيديوهات الدرس والمواد</Button>
    {state.phase==='ready'?<>
      <p>آخر قراءة: {state.videos.length} فيديو و{state.materials.length} مادة؛ الإجمالي {total} من ٢٠ محتوى.</p>
      <p className="text-xs text-slate-600">الترتيب مشترك مع المواد. الخادم يعيد التحقق عند الحفظ لأن محررًا آخر قد يغيّر المحتوى.</p>
      {!state.videos.length?<p>لا توجد مراجع فيديو مرتبطة بهذا الدرس بعد.</p>:<ol className="max-h-96 space-y-2 overflow-y-auto" aria-label="قائمة مراجع الفيديو">{state.videos.map(row=><li key={row.content_id} className="space-y-2 rounded border bg-white p-2">
        <p dir="auto" className="break-words font-medium">{row.title||'فيديو بدون عنوان متاح'}</p><p>{statuses[row.video_status]} · الموضع {row.display_order}</p>
        <Button type="button" size="sm" variant="outline" disabled={!canWrite} onClick={()=>setRemoveId(row.content_id)}>فك مرجع الفيديو</Button>
        {removeId===row.content_id?<div className="flex flex-wrap items-center gap-2"><p>فك المرجع من الدرس فقط؟ الفيديو الأصلي سيظل محفوظًا.</p><Button type="button" size="sm" disabled={!canWrite} onClick={async()=>{if(await ref.current?.detach(row.content_id))setRemoveId(null);}}>تأكيد فك مرجع الفيديو</Button><Button type="button" size="sm" variant="outline" disabled={state.busy} onClick={()=>setRemoveId(null)}>إلغاء</Button></div>:null}
      </li>)}</ol>}
      <form className="space-y-2 border-t pt-3" onSubmit={async event=>{event.preventDefault();if(await ref.current?.attach(selected,position)){setSelected('');setRemoveId(null);}}}>
        <label htmlFor={`${formId}-video`} className="block">اختر فيديو من نفس الكورس</label><select id={`${formId}-video`} value={validSelection?selected:''} onChange={event=>setSelected(event.target.value)} disabled={!canWrite||total>=20} className="w-full min-w-0 rounded border bg-white p-2"><option value="">اختر الفيديو…</option>{options.map(row=><option key={row.video_id} value={row.video_id}>{row.title||'فيديو بدون عنوان'}</option>)}</select>
        <p className="text-xs text-slate-600">حتى ٢٥ مصدرًا في الصفحة؛ تظهر المصادر المعالجة بلا ارتباط قديم متعارض. المراجع المرتبطة مخفية من الاختيارات.</p>
        {state.optionsError?<p role="alert">{state.optionsError}</p>:!state.busy&&!options.length?<p>لا توجد مصادر قابلة للإضافة في هذه الصفحة. حمّل الصفحة التالية إن وجدت.</p>:null}
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={state.busy||state.stale} onClick={()=>{setSelected('');void ref.current?.options();}}>إعادة تحميل اختيارات الفيديو</Button><Button type="button" size="sm" variant="outline" disabled={state.busy||state.stale||!state.nextCursor} onClick={()=>{setSelected('');void ref.current?.options(true);}}>فيديوهات الصفحة التالية</Button></div>
        <label htmlFor={`${formId}-order`} className="block">موضع الفيديو داخل الدرس</label><input id={`${formId}-order`} inputMode="numeric" dir="ltr" value={position} onChange={event=>setPosition(event.target.value)} disabled={!canWrite} className="w-full rounded border bg-white p-2"/>
        <p className="text-xs text-slate-600">المواضع المستخدمة حسب آخر قراءة: {[...state.videos,...state.materials].map(row=>row.display_order).sort((a,b)=>a-b).join('، ')||'لا يوجد'}.</p>
        <Button type="submit" size="sm" disabled={!canWrite||!validSelection||total>=20}>ربط مرجع الفيديو بالدرس</Button>
      </form>
    </>:null}
  </section>;
}
