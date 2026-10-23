import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { redeemTenantInvitation } from '@/lib/api';
import { createTenantActivationController, parseFragmentToken } from '@/features/enrollment/workflows';

export default function TenantInvitation() {
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState('');
  // M2-01: activation runs through the injected production seam — one request
  // per activation (synchronous latch), server-authoritative outcome only,
  // input retained on failure.
  const controller = useMemo(() => createTenantActivationController({
    redeem: redeemTenantInvitation,
    readToken: () => parseFragmentToken(window.location.hash),
  }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    const onHashChange = () => controller.syncToken();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [controller]);
  useEffect(() => { if (state.status === 'activated') window.history.replaceState(null, '', '/invite'); }, [state.status]);
  useEffect(() => () => controller.dispose(), [controller]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await controller.activate(password, confirmed);
  };

  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4" dir="rtl"><div className="w-full max-w-md space-y-4 rounded-2xl border bg-white p-6 shadow-sm"><h1 className="text-2xl font-bold">تفعيل حساب المدرس</h1>{state.status === 'activated' ? <><p>تم تعيين كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن.</p><Button asChild><Link to="/auth">تسجيل الدخول</Link></Button></> : <form className="space-y-4" onSubmit={submit} noValidate><p className="text-sm text-slate-600">استخدم الدعوة التي أرسلتها لك إدارة المنصة بعد تفعيل اشتراكك.</p>{!state.token && <p role="alert" className="text-red-700">رابط الدعوة غير مكتمل.</p>}{state.message && <p role="alert" className="text-red-700">{state.message}</p>}<div className="space-y-1.5"><Label htmlFor="invite-password">كلمة مرور جديدة</Label><Input id="invite-password" type="password" autoComplete="new-password" placeholder="12 حرفًا على الأقل" value={password} onChange={e => setPassword(e.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="invite-confirm">تأكيد كلمة المرور</Label><Input id="invite-confirm" type="password" autoComplete="new-password" placeholder="أعد إدخال كلمة المرور" value={confirmed} onChange={e => setConfirmed(e.target.value)} /></div><Button type="submit" className="w-full" disabled={state.status === 'activating' || !state.token || password.length < 12 || password !== confirmed}>{state.status === 'activating' ? 'جارٍ التفعيل…' : 'تفعيل الحساب'}</Button></form>}</div></main>;
}
