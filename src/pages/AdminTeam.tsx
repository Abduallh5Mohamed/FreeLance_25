import { useEffect, useState } from 'react';
import { ShieldCheck, Users } from 'lucide-react';
import Header from '@/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createAdminMember, getAdminMembers, getAdminRoles, updateAdminMember, type AdminMember, type AdminRole } from '@/lib/api';

const roleHelp: Record<string, string> = {
  super_admin: 'كل صلاحيات الإدارة، وإنشاء المسؤولين، ويمكنه اعتماد طلبه بنفسه.',
  operations_admin: 'تهيئة المدرسين ومتابعة التشغيل والمهام، دون إدارة الصلاحيات.',
  billing_admin: 'اشتراكات المنصة والمدفوعات والتقارير المالية والموافقات المالية.',
  support_admin: 'الدعم وقراءة البيانات اللازمة لحل المشكلة دون تعديل مالي.',
  security_admin: 'الحوادث والجلسات والأحداث الأمنية.',
  analyst: 'تحليل الإيراد والنمو والاشتراكات، وإنشاء حسابات وسيناريوهات What-if ورسوم، وتصدير CSV وPDF دون بيانات شخصية.',
};

export default function AdminTeam() {
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '', role_code: '' });
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = async () => {
    try { const [nextMembers, nextRoles] = await Promise.all([getAdminMembers(), getAdminRoles()]); setMembers(nextMembers); setRoles(nextRoles); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحميل فريق الإدارة'); }
  };
  useEffect(() => { void load(); }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      await createAdminMember(form);
      setNotice(`تم إنشاء حساب ${form.name}. يدخل برقم الهاتف وكلمة المرور المحددين.`);
      setForm({ name: '', phone: '', email: '', password: '', role_code: '' });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر إنشاء الحساب'); }
    finally { setBusy(false); }
  };
  const update = async (member: AdminMember, changes: { role_code?: string; is_active?: boolean; password?: string }, reason: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await updateAdminMember(member.id, { ...changes, reason }); setNotice(`تم تحديث حساب ${member.name}.`); setEditId(null); setEditPassword(''); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحديث الحساب'); }
    finally { setBusy(false); }
  };
  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content p-4 md:p-8"><div className="mx-auto max-w-6xl space-y-6">
    <header><h1 className="flex items-center gap-2 text-3xl font-bold"><Users className="text-indigo-600" />فريق الإدارة</h1><p className="mt-2 text-slate-600">الـSuper Admin فقط ينشئ حسابات المسؤولين ويحدد دور كل حساب. كل مسؤول يدخل من شاشة تسجيل الدخول العادية برقم هاتفه وكلمة مروره.</p></header>
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950"><ShieldCheck className="ml-1 inline h-4 w-4" /><strong>قاعدة الموافقات:</strong> الـSuper Admin يستطيع تنفيذ واعتماد كل العمليات بنفسه. باقي المسؤولين لا يعتمدون العملية التي أنشؤوها هم، ويحتاجون مسؤولًا مخولًا آخر.</div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{error}</div>}{notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">{notice}</div>}
    <div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader><CardTitle>إنشاء حساب مسؤول</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}>
      <div className="space-y-1"><Label>اسم المسؤول</Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="الاسم الكامل" /></div>
      <div className="space-y-1"><Label>رقم هاتف تسجيل الدخول</Label><Input dir="ltr" inputMode="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="01xxxxxxxxx" /><p className="text-xs text-slate-500">هذا هو الرقم الذي سيستخدمه المسؤول في شاشة تسجيل الدخول.</p></div>
      <div className="space-y-1"><Label>البريد الإلكتروني (اختياري)</Label><Input dir="ltr" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
      <div className="space-y-1"><Label>كلمة المرور</Label><Input dir="ltr" type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="8 أحرف على الأقل" /><p className="text-xs text-slate-500">سلّمها للمسؤول بطريقة آمنة؛ لا يمكن عرضها بعد الحفظ.</p></div>
      <div className="space-y-1"><Label>الدور الإداري</Label><select className="w-full rounded-md border bg-white p-2" value={form.role_code} onChange={e => setForm({ ...form, role_code: e.target.value })}><option value="">اختر الدور</option>{roles.map(role => <option key={role.code} value={role.code}>{role.name}</option>)}</select>{form.role_code && <p className="text-xs leading-5 text-slate-500">{roleHelp[form.role_code] || 'صلاحيات هذا الدور محددة من سياسة الإدارة.'}</p>}</div>
      <Button type="submit" disabled={busy || form.name.trim().length < 3 || form.phone.trim().length < 6 || form.password.length < 8 || !form.role_code}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء حساب المسؤول'}</Button>
    </form></CardContent></Card>
    <Card><CardHeader><CardTitle>الحسابات الإدارية الحالية</CardTitle><p className="text-sm text-slate-500">يمكن تغيير الدور أو إيقاف الحساب أو تعيين كلمة مرور جديدة. لا يمكن تعطيل حسابك الحالي.</p></CardHeader><CardContent className="space-y-3">{members.map(member => <div key={member.id} className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{member.name}</p><p dir="ltr" className="text-right text-sm text-slate-600">{member.phone || 'بدون هاتف'}</p><p className="text-xs text-slate-500">الدور: {member.roles} · {member.is_active ? 'نشط' : 'موقوف'}</p></div><Button size="sm" variant="outline" onClick={() => { setEditId(editId === member.id ? null : member.id); setEditRole(member.roles.split(',')[0]); setEditPassword(''); }}>إدارة</Button></div>{editId === member.id && <div className="mt-3 space-y-3 border-t pt-3"><div><Label>الدور الجديد</Label><select className="mt-1 w-full rounded-md border bg-white p-2" value={editRole} onChange={e => setEditRole(e.target.value)}>{roles.map(role => <option key={role.code} value={role.code}>{role.name}</option>)}</select></div><div><Label>كلمة مرور جديدة (اختياري)</Label><Input className="mt-1" dir="ltr" type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="اتركها فارغة دون تغيير" /></div><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !editRole || Boolean(editPassword && editPassword.length < 8)} onClick={() => void update(member, { role_code: editRole, ...(editPassword ? { password: editPassword } : {}) }, 'Role or credentials updated by Super Admin')}>حفظ التعديلات</Button><Button size="sm" variant={member.is_active ? 'destructive' : 'default'} disabled={busy} onClick={() => { if (confirm(member.is_active ? 'إيقاف هذا الحساب ومنع تسجيل دخوله؟' : 'إعادة تفعيل هذا الحساب؟')) void update(member, { is_active: !member.is_active }, member.is_active ? 'Disabled by Super Admin' : 'Reactivated by Super Admin'); }}>{member.is_active ? 'إيقاف الحساب' : 'تفعيل الحساب'}</Button></div></div>}</div>)}</CardContent></Card></div>
  </div></main></div>;
}
