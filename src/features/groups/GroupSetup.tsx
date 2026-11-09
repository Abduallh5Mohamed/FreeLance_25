import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {subscribeSessionChange} from '@/lib/session-events';
import {readCourseSessionPrincipal} from '@/features/catalog/course-management';
import {createGroupSetup,initialGroupSetup,readGroupSetup,type SetupAction} from './group-setup';

const labels:Record<SetupAction,string>={
    review_group:'راجع فتح المجموعة والمقرر وصحة نطاق الفرع.',assign_instructor:'راجع تعيين مدرس نشط ومخول داخل المؤسسة.',
    add_students:'أضف طلاب المجموعة أو راجع ملف الاستيراد وعينة النتائج.',review_enrollments:'راجع حالة القيود وموافقتها ومدتها؛ لا يوجد قيد نشط حاليًا.',
    review_accounts:'راجع الحسابات غير المتاحة لطلاب الأونلاين ذوي القيود النشطة؛ سجل الاستيراد لا ينشئ حسابًا، وطالب الأوفلاين لا يحتاج حساب دخول.',
    review_course_assignments:'راجع تعيين المقرر للطلاب ذوي القيود النشطة؛ المجموعة وحدها لا تمنح الاشتراك.',
    review_capacity:'راجع السعة؛ قيمتها تحتاج تحديدًا أو أن القيود النشطة تتجاوزها.',verify_schedule_source:'تعذر إثبات مصدر الحصص الفعلية؛ لا نعتبر المواعيد الأسبوعية حصصًا مولدة.',
    prepare_sessions:'لا توجد حصص مجموعة فعلية في الأيام السبعة القادمة. راجع احتياجك للمواعيد.',
    practice_handover:'لم تظهر نواقص في الفحوص المعروضة. جرّب المهمة مع مستخدم بديل له صلاحية مستقلة.',
};
export function GroupSetup({groups,onEdit}:{groups:Array<{id:string;name:string}>;onEdit:(id:string)=>void}){
    const [state,setState]=useState(initialGroupSetup),[practice,setPractice]=useState<'not_tried'|'needed_help'|'completed'>('not_tried');
    const controller=useRef<ReturnType<typeof createGroupSetup>|null>(null);
    useEffect(()=>{const c=createGroupSetup({read:readGroupSetup,readPrincipal:()=>readCourseSessionPrincipal(localStorage),subscribeSession:subscribeSessionChange});controller.current=c;const unsubscribe=c.subscribe(setState);
        const storage=(e:StorageEvent)=>{if(e.key===null||['authToken','currentUser','currentStudentSpace'].includes(e.key))c.invalidate();};window.addEventListener('storage',storage);
        return()=>{unsubscribe();c.dispose();controller.current=null;window.removeEventListener('storage',storage);};},[]);
    useEffect(()=>{setPractice('not_tried');},[state.groupId,state.phase]);
    useEffect(()=>{if(state.groupId&&!groups.some(g=>g.id===state.groupId))void controller.current?.select(null);},[groups,state.groupId]);
    const data=state.data;
    if(state.phase==='session-ended')return <p role="alert">تغير الحساب أو مساحة العمل؛ أُخفيت مراجعة تشغيل المجموعة. افتح الصفحة من جديد.</p>;
    return <section dir="rtl" aria-label="بدء تشغيل مجموعة" className="mb-6 space-y-4 rounded-xl border bg-card p-5">
        <h2 className="text-xl font-semibold">ابدأ تشغيل مجموعة واحدة</h2>
        <p>مراجعة لمالك المؤسسة من البيانات الحالية. اختَر مجموعة، عالج الخطوة التالية من شاشتها الأصلية، ثم حدّث المراجعة. هذه الفحوص لا تنشئ حسابًا أو اشتراكًا أو صلاحية أو تحصيلًا.</p>
        <div className="flex flex-wrap items-center gap-3"><label>المجموعة <select aria-label="مجموعة بدء التشغيل" className="mx-2 rounded border p-2" value={state.groupId??''} onChange={e=>{void controller.current?.select(e.target.value||null);}}>
            <option value="">اختر مجموعة للمراجعة</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
            <Button variant="outline" disabled={!state.groupId||state.phase==='loading'} onClick={()=>{void controller.current?.refresh();}}>إعادة فحص المجموعة</Button></div>
        {!groups.length?<p>أنشئ مجموعة من زر إضافة مجموعة أولًا. اختيارها هنا لا ينقل بيانات من أي منصة.</p>:null}
        {state.phase==='loading'?<p role="status">جارٍ التحقق؛ أُخفيت المراجعة السابقة.</p>:null}
        {state.phase==='denied'?<p role="alert">المراجعة متاحة لمالك المؤسسة الحالي فقط، أو لم تعد المجموعة متاحة في هذه المساحة.</p>:null}
        {state.phase==='error'?<p role="alert">تعذر إثبات الحالة الحالية؛ قد يكون المصدر غير جاهز أو تجاوز حدود القراءة. لا نعرض أعدادًا قديمة أو أصفارًا مفترضة.</p>:null}
        {data?<>
            <div className="rounded bg-muted p-4"><h3 className="font-semibold">خطوتك التالية — {data.group.name}</h3><p>{labels[data.next_action]}</p><p className="text-sm">{data.group.course_name} — آخر فحص {new Date(data.checked_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})} القاهرة</p></div>
            <dl className="grid gap-3 md:grid-cols-3">{[
                ['سجلات الطلاب في المجموعة',data.students.total],['قيود نشطة الآن',data.students.active],['قيود غير نشطة الآن',data.students.inactive],
                ['قيود أوفلاين نشطة دون اشتراط حساب دخول',data.students.offline],['قيود أونلاين نشطة وحسابها غير متاح',data.students.missing_account],['قيود نشطة دون تعيين مقرر نشط',data.students.missing_course_assignment],['السعة المحددة',data.group.capacity||'تحتاج مراجعة'],
            ].map(([label,value])=><div key={label} className="rounded border p-3"><dt>{label}</dt><dd className="text-xl font-semibold">{value}</dd></div>)}</dl>
            <p>المدرس: {data.instructor.status==='active'?data.instructor.name:data.instructor.status==='not_assigned'?'غير معين':'التعيين الحالي غير متاح أو غير مخول'}. لا نكشف أسماء تعيينات غير مخولة.</p>
            {data.issues.length?<ul className="list-disc space-y-2 ps-5">{data.issues.map(issue=><li key={issue}>{labels[issue]}</li>)}</ul>:<p>لا توجد نواقص ضمن هذه الفحوص فقط؛ هذا ليس قبول تشغيل أو تسليم للمحتوى.</p>}
            <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={()=>onEdit(data.group.id)}>فتح إعداد المجموعة</Button><Link className="underline" to="/instructor-students">إضافة الطلاب واستيراد السجلات وطلبات الحسابات</Link><Link className="underline" to="/students">مراجعة القيود الحالية</Link><Link className="underline" to="/courses">المقرر وحزمة الحصة</Link><Link className="underline" to="/instructor#center-operations">مراجعة تشغيل المؤسسة والعضويات الحالية</Link><Link className="underline" to="/attendance">الحضور والمواعيد</Link></div>
            <p>استيراد CSV/XLSX ينشئ سجلات فقط؛ لا يربطها بهذه المجموعة ولا يحولها إلى حسابات أو اشتراكات. الإضافة اليدوية بمسارها الحالي تتيح اختيار أوفلاين دون حساب أو أونلاين بحساب. راجع التعيين للمقرر منفصلًا ثم ارجع وأعد الفحص. رابط انضمام الطالب يحتاج تحقق اتصال فعليًا قبل الموافقة؛ لا نعتبر غياب مزود التحقق نجاحًا.</p>
            <div><h3 className="font-semibold">حصص فعلية خلال الأيام السبعة القادمة</h3>{data.schedule.status==='unavailable'?<p>المصدر غير متاح للتحقق. لا نعتبر ذلك عدم وجود حصص.</p>:!data.schedule.sessions.length?<p>لا توجد حصص مجموعة فعلية في هذه النافذة. المواعيد الأسبوعية في بطاقة المجموعة تظل إعدادًا منفصلًا.</p>:<ul className="space-y-1">{data.schedule.sessions.map(s=><li key={s.id}>{s.title} — <time dateTime={s.starts_at}>{new Date(s.starts_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'})} القاهرة</time></li>)}</ul>}</div>
            <details className="rounded border p-3"><summary className="cursor-pointer font-semibold">تجربة تسليم المهمة لمستخدم بديل</summary><ol className="list-decimal space-y-2 ps-5 pt-3"><li>جهز حسابًا مستقلًا وصلاحيات مناسبة من مسار الأدوار؛ لا تشارك كلمة مرورك.</li><li>اختبر ببيانات مصطنعة: يفتح البديل مجموعته المسموحة ويحدد موعد الحصة، ويجد مسار تسجيل الحضور دون مساعدة.</li><li>تأكد أنه لا يستطيع فتح مجموعة غير مسموحة. الاختبار اليدوي لا يغير قواعد الصلاحيات.</li></ol>
                <label>نتيجة تجربتك المحلية <select className="m-2 rounded border p-2" aria-label="تجربة المستخدم البديل" value={practice} onChange={e=>setPractice(e.target.value as typeof practice)}><option value="not_tried">لم نجرب بعد</option><option value="needed_help">احتاج مساعدة</option><option value="completed">أنجز المهمة في تجربتنا</option></select></label><p>هذه ملاحظة في ذاكرة الصفحة فقط؛ ليست سجل اعتماد أو قياسًا مثبتًا لتوفير الوقت.</p></details>
        </>:null}
    </section>;
}
