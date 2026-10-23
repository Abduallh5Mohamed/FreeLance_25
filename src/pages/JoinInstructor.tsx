import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { getEnrollmentInviteInfo, requestStudentPasswordReset, submitEnrollmentRequest } from '@/lib/api';
import { subscribeSessionChange } from '@/lib/session-events';
import { createJoinInviteController, reconcileInviteSelection, type JoinInviteForm } from '@/features/enrollment/workflows';

/** The canonical stored identity (api-http writes it under `currentUser`).
 *  Read on demand — never memoized once — so the page never keeps using a
 *  principal that the session no longer is. */
function readStoredIdentity(): { role?: string; id?: string } | null {
  try {
    return JSON.parse(localStorage.getItem('currentUser') || 'null');
  } catch {
    return null;
  }
}

export default function JoinInstructor() {
  const { token = '' } = useParams();
  const [form, setForm] = useState<JoinInviteForm>({ student_name: '', phone: '', guardian_name: '', guardian_phone: '', password: '', grade_id: '', group_id: '', requested_courses: [] });
  const [resetPhone, setResetPhone] = useState('');
  const [currentUser, setCurrentUser] = useState(() => readStoredIdentity());
  const existingStudent = currentUser?.role === 'student';
  // M2-01: journey orchestration (single-flight, stale-reply invalidation,
  // server-authoritative outcomes) lives in the injected production seam.
  const controller = useMemo(() => createJoinInviteController({
    loadInvite: getEnrollmentInviteInfo,
    submitRequest: submitEnrollmentRequest,
    requestReset: requestStudentPasswordReset,
    // A comparable identity KEY only — never the identity itself, never
    // logged. A mutation started under one principal is retired when the
    // principal changes (supervisor/049 identity boundary).
    readIdentity: () => {
      const identity = readStoredIdentity();
      return identity ? `${identity.role ?? 'anon'}:${identity.id ?? ''}` : null;
    },
  }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  // Every route change loads — including the EMPTY token, which must
  // invalidate the previous invitation instead of leaving it on screen.
  useEffect(() => { controller.loadInvite(token); }, [token, controller]);
  useEffect(() => subscribeSessionChange(() => {
    setCurrentUser(readStoredIdentity());
    controller.syncIdentity();
  }), [controller]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => { if (state.phase === 'ready') setForm(current => reconcileInviteSelection(current, state.info)); }, [state.phase, state.info]);
  const groups = useMemo(() => state.info?.groups.filter(g => !form.grade_id || g.grade_id === form.grade_id) || [], [state.info, form.grade_id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await controller.submit(form, { passwordRequired: !existingStudent });
  };

  const requestReset = async () => {
    await controller.requestPasswordReset(resetPhone);
  };

  if (state.submitted) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4" dir="rtl"><Card className="w-full max-w-lg"><CardContent className="space-y-4 p-8 text-center"><h1 className="text-2xl font-bold">تم إرسال طلبك</h1><p>طلبك في انتظار مراجعة المدرس. بعد الموافقة سجّل الدخول برقمك وكلمة المرور من المنصة دون الحاجة للرابط.</p><Button asChild><Link to="/auth">الذهاب لتسجيل الدخول</Link></Button></CardContent></Card></main>;

  return <main className="min-h-screen bg-slate-50 p-4 py-10" dir="rtl"><Card className="mx-auto max-w-2xl"><CardHeader><CardTitle>الانضمام إلى {state.info?.business_name || 'مساحة المدرس'}</CardTitle>{state.info?.subject_type && <p className="font-medium text-indigo-600">المادة: {state.info.subject_type}</p>}<p className="text-sm text-slate-500">بياناتك لا تظهر إلا للمدرس صاحب الرابط وإدارة الدعم المخولة.</p></CardHeader><CardContent>
    {state.actionError && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-red-700">{state.actionError}</p>}
    {state.phase === 'incomplete' ? <p role="alert" className="rounded-md bg-amber-50 p-3 text-amber-800">رابط الانضمام غير مكتمل. اطلب من المدرس رابط انضمام جديدًا.</p> : state.phase === 'loading' ? <p>جارٍ تحميل نموذج التسجيل…</p> : state.phase === 'expired' ? <div role="alert" className="space-y-3 rounded-md bg-amber-50 p-3 text-amber-800"><p>رابط التسجيل غير صالح أو منتهي الصلاحية. اطلب من المدرس رابط انضمام جديدًا.</p>{state.message && <p className="text-xs">{state.message}</p>}<Button type="button" variant="outline" onClick={() => controller.loadInvite(token)}>إعادة تحميل الرابط</Button></div> : state.phase === 'denied' ? <p role="alert" className="rounded-md bg-red-50 p-3 text-red-700">{state.message}</p> : state.phase === 'error' ? <div className="space-y-3"><p role="alert" className="rounded-md bg-red-50 p-3 text-red-700">{state.message}</p><Button type="button" variant="outline" onClick={() => controller.loadInvite(token)}>إعادة تحميل الرابط</Button></div> : state.phase === 'ready' && state.info && <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
      <div><Label htmlFor="join-student-name">اسم الطالب</Label><Input id="join-student-name" required value={form.student_name} onChange={e => setForm({ ...form, student_name: e.target.value })} /></div>
      <div><Label htmlFor="join-phone">رقم الطالب</Label><Input id="join-phone" required dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
      <div><Label htmlFor="join-guardian-name">اسم ولي الأمر</Label><Input id="join-guardian-name" required value={form.guardian_name} onChange={e => setForm({ ...form, guardian_name: e.target.value })} /></div>
      <div><Label htmlFor="join-guardian-phone">رقم ولي الأمر</Label><Input id="join-guardian-phone" required dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={form.guardian_phone} onChange={e => setForm({ ...form, guardian_phone: e.target.value })} /></div>
      <div><Label htmlFor="join-grade">الصف</Label><select id="join-grade" required className="w-full rounded-md border bg-white p-2" value={form.grade_id} onChange={e => setForm({ ...form, grade_id: e.target.value, group_id: '' })}><option value="">اختر الصف</option>{state.info.grades.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      <div><Label htmlFor="join-group">المجموعة</Label><select id="join-group" required className="w-full rounded-md border bg-white p-2" value={form.group_id} onChange={e => setForm({ ...form, group_id: e.target.value })}><option value="">اختر المجموعة</option>{groups.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      {!existingStudent && <div className="md:col-span-2"><Label htmlFor="join-password">كلمة المرور</Label><Input id="join-password" required minLength={10} maxLength={128} type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /><p className="mt-1 text-xs text-slate-500">10 أحرف على الأقل. لا تشاركها مع المدرس أو أي شخص.</p></div>}
      {state.info.courses.length > 0 && <fieldset className="space-y-2 md:col-span-2"><legend className="font-medium">الكورسات المطلوبة</legend>{state.info.courses.map(c => <label key={c.id} className="flex items-center gap-2"><Checkbox checked={form.requested_courses.includes(c.id)} onCheckedChange={checked => setForm({ ...form, requested_courses: checked ? [...form.requested_courses, c.id] : form.requested_courses.filter(x => x !== c.id) })} />{c.name}</label>)}</fieldset>}
      <Button className="md:col-span-2" disabled={state.busyKind !== null}>{state.busyKind === 'submit' ? 'جارٍ الإرسال…' : 'إرسال الطلب للمدرس'}</Button>
      <p className="text-xs text-slate-500 md:col-span-2">{existingStudent ? 'سيُربط الطلب بحسابك الحالي بعد موافقة المدرس.' : 'لديك حساب بالفعل؟ سجّل الدخول أولًا، ثم افتح نفس الرابط للانضمام بنفس الحساب.'}</p>
    </form>}
    {state.phase === 'ready' && state.info && !existingStudent && <div className="mt-6 border-t pt-5"><h2 className="font-semibold">نسيت كلمة المرور؟</h2><p className="mb-3 text-sm text-slate-500">أرسل طلبًا غير كاشف للمدرس صاحب المساحة، ثم استخدم الكود الذي يعطيه لك.</p>{state.resetSent ? <div className="space-y-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800"><p>إذا كان الحساب موجودًا وصل الطلب للمدرس.</p><Button asChild size="sm" variant="outline"><Link to="/student-password-reset">لدي كود الاسترجاع</Link></Button></div> : <div className="flex gap-2"><Input aria-label="رقم هاتف الطالب" dir="ltr" inputMode="tel" placeholder="رقم هاتف الطالب" value={resetPhone} onChange={e => setResetPhone(e.target.value)} /><Button type="button" variant="outline" disabled={state.busyKind !== null} onClick={requestReset}>{state.busyKind === 'reset' ? 'جارٍ الإرسال…' : 'إرسال الطلب'}</Button></div>}</div>}
  </CardContent></Card></main>;
}
