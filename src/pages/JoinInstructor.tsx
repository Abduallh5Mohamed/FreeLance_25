import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { getEnrollmentInviteInfo, requestStudentPasswordReset, submitEnrollmentRequest, type EnrollmentInviteInfo } from '@/lib/api';

export default function JoinInstructor() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<EnrollmentInviteInfo | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetPhone, setResetPhone] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [form, setForm] = useState({ student_name: '', phone: '', guardian_name: '', guardian_phone: '', password: '', grade_id: '', group_id: '', requested_courses: [] as string[] });
  const currentUser = useMemo(() => { try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); } catch { return null; } }, []);
  const existingStudent = currentUser?.role === 'student';

  useEffect(() => {
    getEnrollmentInviteInfo(token).then(setInfo).catch(e => setError(e instanceof Error ? e.message : 'رابط التسجيل غير صالح'));
  }, [token]);
  const groups = useMemo(() => info?.groups.filter(g => !form.grade_id || g.grade_id === form.grade_id) || [], [info, form.grade_id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (!existingStudent && form.password.length < 10) return setError('كلمة المرور يجب ألا تقل عن 10 أحرف.');
    try { setBusy(true); await submitEnrollmentRequest(token, form); setDone(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إرسال الطلب'); }
    finally { setBusy(false); }
  };

  const requestReset = async () => {
    if (!resetPhone.trim()) return;
    try {
      setBusy(true);
      await requestStudentPasswordReset(token, resetPhone.trim());
      setResetSent(true);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إرسال طلب الاسترجاع'); }
    finally { setBusy(false); }
  };

  if (done) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4" dir="rtl"><Card className="w-full max-w-lg"><CardContent className="space-y-4 p-8 text-center"><h1 className="text-2xl font-bold">تم إرسال طلبك</h1><p>طلبك في انتظار مراجعة المدرس. بعد الموافقة سجّل الدخول برقمك وكلمة المرور من المنصة دون الحاجة للرابط.</p><Button asChild><Link to="/auth">الذهاب لتسجيل الدخول</Link></Button></CardContent></Card></main>;

  return <main className="min-h-screen bg-slate-50 p-4 py-10" dir="rtl"><Card className="mx-auto max-w-2xl"><CardHeader><CardTitle>الانضمام إلى {info?.business_name || 'مساحة المدرس'}</CardTitle>{info?.subject_type && <p className="font-medium text-indigo-600">المادة: {info.subject_type}</p>}<p className="text-sm text-slate-500">بياناتك لا تظهر إلا للمدرس صاحب الرابط وإدارة الدعم المخولة.</p></CardHeader><CardContent>
    {error && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-red-700">{error}</p>}
    {!info && !error ? <p>جارٍ تحميل نموذج التسجيل…</p> : info && <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
      <div><Label>اسم الطالب</Label><Input required value={form.student_name} onChange={e => setForm({ ...form, student_name: e.target.value })} /></div>
      <div><Label>رقم الطالب</Label><Input required dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
      <div><Label>اسم ولي الأمر</Label><Input required value={form.guardian_name} onChange={e => setForm({ ...form, guardian_name: e.target.value })} /></div>
      <div><Label>رقم ولي الأمر</Label><Input required dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={form.guardian_phone} onChange={e => setForm({ ...form, guardian_phone: e.target.value })} /></div>
      <div><Label>الصف</Label><select required className="w-full rounded-md border bg-white p-2" value={form.grade_id} onChange={e => setForm({ ...form, grade_id: e.target.value, group_id: '' })}><option value="">اختر الصف</option>{info.grades.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      <div><Label>المجموعة</Label><select required className="w-full rounded-md border bg-white p-2" value={form.group_id} onChange={e => setForm({ ...form, group_id: e.target.value })}><option value="">اختر المجموعة</option>{groups.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      {!existingStudent && <div className="md:col-span-2"><Label>كلمة المرور</Label><Input required minLength={10} maxLength={128} type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /><p className="mt-1 text-xs text-slate-500">10 أحرف على الأقل. لا تشاركها مع المدرس أو أي شخص.</p></div>}
      {info.courses.length > 0 && <fieldset className="space-y-2 md:col-span-2"><legend className="font-medium">الكورسات المطلوبة</legend>{info.courses.map(c => <label key={c.id} className="flex items-center gap-2"><Checkbox checked={form.requested_courses.includes(c.id)} onCheckedChange={checked => setForm({ ...form, requested_courses: checked ? [...form.requested_courses, c.id] : form.requested_courses.filter(x => x !== c.id) })} />{c.name}</label>)}</fieldset>}
      <Button className="md:col-span-2" disabled={busy}>{busy ? 'جارٍ الإرسال…' : 'إرسال الطلب للمدرس'}</Button>
      <p className="text-xs text-slate-500 md:col-span-2">{existingStudent ? 'سيُربط الطلب بحسابك الحالي بعد موافقة المدرس.' : 'لديك حساب بالفعل؟ سجّل الدخول أولًا، ثم افتح نفس الرابط للانضمام بنفس الحساب.'}</p>
    </form>}
    {info && !existingStudent && <div className="mt-6 border-t pt-5"><h2 className="font-semibold">نسيت كلمة المرور؟</h2><p className="mb-3 text-sm text-slate-500">أرسل طلبًا غير كاشف للمدرس صاحب المساحة، ثم استخدم الكود الذي يعطيه لك.</p>{resetSent ? <div className="space-y-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800"><p>إذا كان الحساب موجودًا وصل الطلب للمدرس.</p><Button asChild size="sm" variant="outline"><Link to="/student-password-reset">لدي كود الاسترجاع</Link></Button></div> : <div className="flex gap-2"><Input dir="ltr" inputMode="tel" placeholder="رقم هاتف الطالب" value={resetPhone} onChange={e => setResetPhone(e.target.value)} /><Button type="button" variant="outline" disabled={busy} onClick={requestReset}>إرسال الطلب</Button></div>}</div>}
  </CardContent></Card></main>;
}
