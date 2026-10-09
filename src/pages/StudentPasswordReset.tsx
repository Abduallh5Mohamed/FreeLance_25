import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { completeStudentPasswordReset } from '@/lib/api';

export default function StudentPasswordReset() {
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 10) return setError('كلمة المرور يجب ألا تقل عن 10 أحرف.');
    if (password !== confirm) return setError('كلمتا المرور غير متطابقتين.');
    try {
      setBusy(true); setError('');
      await completeStudentPasswordReset(token.trim(), password);
      navigate('/auth', { replace: true });
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تغيير كلمة المرور'); }
    finally { setBusy(false); }
  };

  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4" dir="rtl"><Card className="w-full max-w-md"><CardHeader><CardTitle>تعيين كلمة مرور جديدة</CardTitle><p className="text-sm text-slate-500">الكود أحادي الاستخدام وصالح لمدة 15 دقيقة فقط.</p></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}>{error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}<div><Label>كود الاسترجاع</Label><Input required dir="ltr" autoComplete="one-time-code" value={token} onChange={e => setToken(e.target.value)} /></div><div><Label>كلمة المرور الجديدة</Label><Input required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div><div><Label>تأكيد كلمة المرور</Label><Input required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></div><Button className="w-full" disabled={busy}>{busy ? 'جارٍ التغيير…' : 'تغيير كلمة المرور'}</Button><Button asChild variant="ghost" className="w-full"><Link to="/auth">العودة لتسجيل الدخول</Link></Button></form></CardContent></Card></main>;
}
