import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { redeemTenantInvitation } from '@/lib/api';

export default function TenantInvitation() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!token || password.length < 12 || password !== confirmed) return;
    setBusy(true); setError(null);
    try {
      await redeemTenantInvitation(token, password);
      window.history.replaceState(null, '', '/invite');
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تفعيل الدعوة'); }
    finally { setBusy(false); }
  };

  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4" dir="rtl"><div className="w-full max-w-md space-y-4 rounded-2xl border bg-white p-6 shadow-sm"><h1 className="text-2xl font-bold">تفعيل حساب المدرس</h1>{done ? <><p>تم تعيين كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن.</p><Button asChild><Link to="/auth">تسجيل الدخول</Link></Button></> : <><p className="text-sm text-slate-600">استخدم الدعوة التي أرسلتها لك إدارة المنصة بعد تفعيل اشتراكك.</p>{!token && <p role="alert" className="text-red-700">رابط الدعوة غير مكتمل.</p>}{error && <p role="alert" className="text-red-700">{error}</p>}<Input type="password" autoComplete="new-password" placeholder="كلمة مرور جديدة (12 حرفًا على الأقل)" value={password} onChange={e => setPassword(e.target.value)} /><Input type="password" autoComplete="new-password" placeholder="تأكيد كلمة المرور" value={confirmed} onChange={e => setConfirmed(e.target.value)} /><Button onClick={submit} disabled={busy || !token || password.length < 12 || password !== confirmed}>تفعيل الحساب</Button></>}</div></main>;
}
