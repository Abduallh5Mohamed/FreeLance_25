import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { createCenterOperations, initialOperations, readCenterOperations } from './center-operations';
import { GroupSetup } from '@/features/groups/GroupSetup';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import { subscribeSessionChange } from '@/lib/session-events';
import CenterTeamOwner from './CenterTeamOwner';
function OperationsBody() {
  const [state, setState] = useState(initialOperations), ref = useRef<ReturnType<typeof createCenterOperations> | null>(null);
  useEffect(() => {
    const c = createCenterOperations({ read: readCenterOperations, readPrincipal: () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, subscribeSession: subscribeSessionChange });
    ref.current = c; const unsubscribe = c.subscribe(setState);
    const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key)) c.invalidate(); };
    window.addEventListener('storage', storage); void c.first();
    return () => { window.removeEventListener('storage', storage); unsubscribe(); c.dispose(); ref.current = null; };
  }, []);
  return <div className="space-y-4 pt-4">
    <p>مراجعة للمالك من المصادر الحالية. العضوية أو ظهور صفحة في حساب لا يمنح وحده صلاحية إجراء، ولا نحول موظف السنتر إلى موظف منصة.</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={state.phase === 'loading' || state.phase === 'session-ended'} onClick={() => { void ref.current?.first(); }}>أول صفحة مجموعات وتحديث التشغيل</Button><Button variant="outline" disabled={state.phase !== 'ready' || !state.data?.next_cursor} onClick={() => { void ref.current?.next(); }}>مجموعات التشغيل التالية</Button></div>
    {state.phase === 'loading' ? <p role="status">جارٍ مراجعة التشغيل؛ أُخفيت القراءة السابقة.</p> : null}
    {state.phase === 'denied' ? <p role="alert">المراجعة تتطلب جلسة مالك المؤسسة الحالية؛ لا تمنحها صلاحيات موظفي المنصة أو محددات العميل.</p> : null}
    {state.phase === 'error' ? <p role="alert">تعذر إثبات مراجعة التشغيل كاملة. لا نعرض أعدادًا أو مجموعات قديمة على أنها محدثة.</p> : null}
    {state.phase === 'session-ended' ? <p role="alert">تغيرت الجلسة؛ أُخفيت بيانات تشغيل السنتر.</p> : null}
    {state.data ? <>
      <p>آخر قراءة: {new Date(state.data.checked_at).toLocaleString('ar-EG')}. هذه ليست موافقة جاهزية أو قياسًا لتوفير الوقت.</p>
      <p>عضويات المؤسسة النشطة: {state.data.team.active_memberships}؛ منها مالك/مدرس مخول بعضوية تدريس: {state.data.team.teaching_memberships}؛ عضويات أخرى: {state.data.team.other_memberships}. لا يشمل ذلك موظفي المنصة، ولا يثبت صلاحية تنفيذ مهمة أو جاهزية حساب موظف جديد.</p>
      <ul className="space-y-2">{state.data.groups.map(g => <li key={g.id} className="rounded border p-3"><strong>{g.name}</strong><p>{g.course_name} — {g.active && g.course_active ? 'المجموعة والمقرر نشطان' : 'راجع نشاط المجموعة والمقرر'} — {g.branch_scope === 'tenant' ? 'نطاق المؤسسة' : g.branch_scope === 'active_branch' ? g.branch_name : 'الفرع غير متاح؛ راجع النطاق'}</p></li>)}</ul>
      {!state.data.groups.length ? <p>لا توجد مجموعات في هذه الصفحة؛ أنشئ المجموعة واختر مقررها من مسار المجموعات.</p> : null}
      <GroupSetup groups={state.data.groups.map(g => ({ id: g.id, name: g.name }))} onEdit={() => { window.location.assign('/groups'); }} />
    </> : null}
    <nav className="flex flex-wrap gap-4"><Link to="/groups" className="underline">إعداد المجموعات</Link><Link to="/courses" className="underline">المقررات</Link><Link to="/instructor-students" className="underline">الطلاب والاستيراد والحسابات</Link><Link to="/support" className="underline">طلباتي لدعم المنصة</Link></nav>
    <p>لوحة الفروع بهذه الصفحة تدير فروع الإعدادات؛ نطاق فرع المجموعة يُقرأ من نموذج صلاحيات الموارد المنفصل. لا نطابق النموذجين تلقائيًا بالاسم ولا ننقل الصلاحيات بينهما. توزيع طلبات دعم المنصة يخص فريق المنصة المخول؛ لا نفوض موظفي السنتر فيه. موظف السنتر يستخدم حسابًا مستقلًا وصلاحياته المحددة أدناه.</p>
    <CenterTeamOwner />
  </div>;
}
export default function CenterOperations() {
  const [open, setOpen] = useState(false);
  return <section id="center-operations" dir="rtl" aria-label="مركز تشغيل السنتر" className="my-6 rounded-xl border bg-card p-5"><h2 className="text-xl font-semibold">مركز تشغيل السنتر</h2><Button className="mt-3" variant="outline" onClick={() => setOpen(v => !v)}>{open ? 'إغلاق مراجعة التشغيل' : 'فتح مراجعة تشغيل السنتر'}</Button>{open ? <OperationsBody /> : null}</section>;
}
