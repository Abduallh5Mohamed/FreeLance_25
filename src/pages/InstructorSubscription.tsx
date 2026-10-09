import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CalendarClock, CheckCircle2, Clock3, CreditCard, FileUp, Loader2, RefreshCw, ShieldCheck, WalletCards, XCircle } from 'lucide-react';
import Header from '@/components/Header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cancelRenewalIntent, getMyTenantBilling, getOwnTopupProofUrl, requestManualRenewal, submitInstructorTopup, type InstructorBillingData, type InstructorTopupRequest } from '@/lib/api';

const money = (value: string | number | null | undefined) => `${Number(value || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const statusText: Record<string, string> = { active: 'نشط', past_due: 'مستحق', grace_period: 'داخل المهلة', expired: 'منتهي', completed: 'مكتمل', submitted: 'قيد المراجعة', verified: 'معتمد', rejected: 'مرفوض', pending: 'منتظر' };
const purposeText: Record<string, string> = { subscription_renewal: 'تجديد الاشتراك الشهري', other: 'شحن رصيد خدمات' };
const methodText: Record<string, string> = { bank_transfer: 'تحويل بنكي', instapay: 'InstaPay', mobile_wallet: 'محفظة إلكترونية', cash: 'نقدي' };

function Countdown({ seconds }: { seconds: number }) {
  const values = [['يوم', Math.floor(seconds / 86400)], ['ساعة', Math.floor((seconds % 86400) / 3600)], ['دقيقة', Math.floor((seconds % 3600) / 60)], ['ثانية', seconds % 60]] as const;
  return <div className="grid grid-cols-4 gap-2 text-center" dir="ltr">{values.map(([label, value]) => <div key={label} className="rounded-xl border border-red-200 bg-white p-3"><strong className="block text-2xl tabular-nums text-red-700">{String(value).padStart(2, '0')}</strong><span className="text-xs text-slate-500">{label}</span></div>)}</div>;
}

export default function InstructorSubscription() {
  const [data, setData] = useState<InstructorBillingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [graceLeft, setGraceLeft] = useState(0);
  const [graceDeadline, setGraceDeadline] = useState(0);
  const [purpose, setPurpose] = useState<'subscription_renewal' | 'other'>('subscription_renewal');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('instapay');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [notes, setNotes] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const value = await getMyTenantBilling();
      setData(value);
      const seconds = Number(value.subscription?.grace_seconds_remaining || 0);
      setGraceLeft(seconds);
      setGraceDeadline(seconds > 0 ? Date.now() + seconds * 1000 : 0);
      setAmount(current => current || (value.subscription?.charge_amount ? String(value.subscription.charge_amount) : ''));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحميل مركز الدفع'); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (graceDeadline <= 0) return;
    const tick = () => setGraceLeft(Math.max(0, Math.ceil((graceDeadline - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [graceDeadline]);

  const charge = Number(data?.subscription?.charge_amount || 0);
  const balance = Number(data?.wallet.balance || 0);
  const shortfall = Math.max(0, charge - balance);
  const inGrace = Boolean(data?.subscription && Number(data.subscription.grace_seconds_remaining) > 0);
  const canRenewManually = Boolean(data?.subscription && !data.renewal_intent && balance >= charge && charge > 0);

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(null); setSuccess(null);
    try { await action(); setSuccess(message); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر إتمام العملية'); }
    finally { setBusy(false); }
  };

  const submitTopup = async (event: FormEvent) => {
    event.preventDefault();
    if (!proof) return setError('اختر صورة الإيصال أو ملف PDF أولًا.');
    if (purpose === 'subscription_renewal' && !confirmed) return setError('يجب تأكيد فهم قاعدة إذن التجديد قبل الإرسال.');
    if (purpose === 'subscription_renewal' && !window.confirm(`سيُضاف ${money(amount)} إلى رصيدك بعد اعتماد الإدارة، وسيُنشأ إذن واحد لخصم ${money(charge)} عند انتهاء الفترة الحالية فقط. هل تريد المتابعة؟`)) return;
    const form = new FormData();
    form.append('purpose_code', purpose); form.append('amount', amount); form.append('method', method);
    form.append('reference_number', reference.trim()); form.append('paid_at', new Date(paidAt).toISOString());
    form.append('notes', notes.trim()); form.append('proof', proof);
    if (purpose === 'subscription_renewal') form.append('renewal_confirmation', 'CONFIRM_MONTHLY_RENEWAL');
    await run(() => submitInstructorTopup(form), 'تم إرسال الإيصال للمراجعة. لن يتغير الرصيد قبل اعتماد الإدارة.');
    setReference(''); setNotes(''); setProof(null); setConfirmed(false);
    const fileInput = document.getElementById('topup-proof') as HTMLInputElement | null; if (fileInput) fileInput.value = '';
  };

  const openProof = async (topup: InstructorTopupRequest) => {
    try { const result = await getOwnTopupProofUrl(topup.id); window.open(result.url, '_blank', 'noopener,noreferrer'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر فتح الإيصال'); }
  };

  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-6xl space-y-6">
    <header className="flex flex-col justify-between gap-3 md:flex-row md:items-end"><div><p className="text-sm font-semibold text-indigo-600">الفوترة ورصيد خدمات المنصة</p><h1 className="text-3xl font-black text-slate-950">اشتراكي في المنصة</h1><p className="mt-2 max-w-3xl text-slate-600">اشحن رصيد الخدمات وارفع إثبات التحويل في أي وقت. الرصيد ليس أموال طلابك، ولا يُخصم منه التجديد إلا بعد انتهاء فترة اشتراكك.</p></div><Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw className="ml-2 h-4 w-4" />تحديث</Button></header>
    {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />{error}</div>}
    {success && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />{success}</div>}
    {!data && !error && <div className="flex items-center justify-center p-16 text-slate-500"><Loader2 className="ml-2 h-5 w-5 animate-spin" />جاري تحميل بيانات الفوترة...</div>}
    {data && <>
      {data.billing_only && <div className="rounded-2xl border border-red-300 bg-red-50 p-5"><h2 className="flex items-center gap-2 font-bold text-red-900"><ShieldCheck className="h-5 w-5" />وضع الدفع والدعم فقط</h2><p className="mt-2 text-sm leading-7 text-red-800">انتهت مهلة التجديد؛ أدوات التدريس متوقفة مؤقتًا، لكن حسابك وبياناتك لم تُحذف. اشحن الرصيد أو استخدم الرصيد الكافي للتجديد، ويمكنك التواصل مع الدعم.</p></div>}
      {inGrace && <Card className="border-red-300 bg-red-50/60"><CardHeader><CardTitle className="flex items-center gap-2 text-red-900"><Clock3 />مهلة التجديد تنتهي خلال</CardTitle><p className="text-sm text-red-800">أمامك أربعة أيام كاملة من وقت انتهاء الاشتراك. عند اكتمال الرصيد ومع وجود إذن، يحاول النظام التجديد فورًا.</p></CardHeader><CardContent><Countdown seconds={graceLeft} /></CardContent></Card>}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="p-5"><CreditCard className="mb-4 h-6 w-6 text-indigo-600" /><p className="text-sm text-slate-500">الخطة الحالية</p><p className="mt-1 text-xl font-bold">{data.subscription?.plan_name || 'لا توجد خطة'}</p><Badge className="mt-3" variant="outline">{statusText[data.subscription?.status || ''] || data.subscription?.status || 'غير مفعّل'}</Badge></CardContent></Card>
        <Card><CardContent className="p-5"><WalletCards className="mb-4 h-6 w-6 text-emerald-600" /><p className="text-sm text-slate-500">رصيد الخدمات المتاح</p><p className="mt-1 text-2xl font-black text-emerald-700">{money(data.wallet.balance)}</p><p className="mt-2 text-xs text-slate-500">يبقى كاملًا حتى يحين موعد الخصم.</p></CardContent></Card>
        <Card><CardContent className="p-5"><CalendarClock className="mb-4 h-6 w-6 text-amber-600" /><p className="text-sm text-slate-500">الخصم القادم</p><p className="mt-1 text-2xl font-black">{money(charge)}</p><p className="mt-2 text-xs text-slate-500">موعد الانتهاء: {dateTime(data.subscription?.period_ends_at)}</p></CardContent></Card>
        <Card><CardContent className="p-5"><AlertCircle className={`mb-4 h-6 w-6 ${shortfall ? 'text-red-600' : 'text-emerald-600'}`} /><p className="text-sm text-slate-500">المبلغ الناقص للتجديد</p><p className={`mt-1 text-2xl font-black ${shortfall ? 'text-red-700' : 'text-emerald-700'}`}>{money(shortfall)}</p><p className="mt-2 text-xs text-slate-500">لا يوجد خصم جزئي.</p></CardContent></Card>
      </section>
      <Card className={data.renewal_intent ? 'border-indigo-300' : ''}><CardHeader><CardTitle>إذن التجديد</CardTitle></CardHeader><CardContent>{data.renewal_intent ? <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><p className="font-semibold text-indigo-900">يوجد إذن واحد منتظر بقيمة {money(data.renewal_intent.charge_amount)}</p><p className="mt-1 text-sm text-slate-600">سيُستخدم مرة واحدة فقط عند انتهاء الفترة ثم يُغلق. الشحنات الإضافية لا تضيف شهورًا تلقائيًا.</p></div><Button variant="outline" disabled={busy} onClick={() => { if (confirm('إلغاء الإذن لن يسحب أي مبلغ وسيظل رصيدك كاملًا. هل تريد الإلغاء؟')) void run(() => cancelRenewalIntent(data.renewal_intent!.id), 'تم إلغاء إذن التجديد وبقي الرصيد كما هو.'); }}><XCircle className="ml-2 h-4 w-4" />إلغاء الإذن</Button></div> : <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><p className="font-semibold">لا يوجد إذن تجديد منتظر</p><p className="mt-1 text-sm text-slate-600">إذا كانت الفترة سارية سينتظر النظام موعد انتهائها، وإذا كانت منتهية يبدأ من وقت طلبك.</p></div><Button disabled={busy || !canRenewManually} onClick={() => { if (confirm(`تأكيد إنشاء إذن واحد لخصم ${money(charge)}؟`)) void run(requestManualRenewal, 'تم إنشاء إذن التجديد وتنفيذه إذا كان الاشتراك مستحقًا.'); }}>تجديد الآن من الرصيد</Button></div>}</CardContent></Card>
      <div className="grid gap-6 lg:grid-cols-[1.15fr_.85fr]">
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><FileUp className="h-5 w-5 text-indigo-600" />رفع إيصال شحن جديد</CardTitle><p className="text-sm leading-6 text-slate-500">الإدارة تراجع وصول التحويل أولًا. عند الاعتماد يُضاف المبلغ كاملًا إلى رصيد خدماتك.</p></CardHeader><CardContent><form className="space-y-4" onSubmit={submitTopup}>
          <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="topup-purpose">غرض الدفع</Label><select id="topup-purpose" className="h-10 w-full rounded-md border bg-white px-3" value={purpose} onChange={e => { setPurpose(e.target.value as typeof purpose); setConfirmed(false); }}><option value="subscription_renewal">تجديد الاشتراك الشهري</option><option value="other">أخرى — شحن الرصيد فقط</option></select></div><div className="space-y-2"><Label htmlFor="topup-amount">المبلغ بالجنيه</Label><Input id="topup-amount" type="number" min="0.01" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></div></div>
          <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="topup-method">وسيلة الدفع</Label><select id="topup-method" className="h-10 w-full rounded-md border bg-white px-3" value={method} onChange={e => setMethod(e.target.value)}><option value="instapay">InstaPay</option><option value="bank_transfer">تحويل بنكي</option><option value="mobile_wallet">محفظة إلكترونية</option><option value="cash">نقدي</option></select></div><div className="space-y-2"><Label htmlFor="topup-reference">رقم مرجع التحويل</Label><Input id="topup-reference" dir="ltr" minLength={3} maxLength={160} required value={reference} onChange={e => setReference(e.target.value)} placeholder="مثال: 123456789" /></div></div>
          <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="topup-date">تاريخ ووقت التحويل</Label><Input id="topup-date" type="datetime-local" required value={paidAt} onChange={e => setPaidAt(e.target.value)} /></div><div className="space-y-2"><Label htmlFor="topup-proof">الإيصال الخاص</Label><Input id="topup-proof" type="file" required accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setProof(e.target.files?.[0] || null)} /><p className="text-xs text-slate-500">JPEG أو PNG أو WebP أو PDF، بحد أقصى 8MB.</p></div></div>
          <div className="space-y-2"><Label htmlFor="topup-notes">ملاحظات اختيارية</Label><Textarea id="topup-notes" maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="أي تفاصيل تساعد الإدارة على مراجعة التحويل" /></div>
          {purpose === 'subscription_renewal' ? <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><input className="mt-1 h-4 w-4" type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span><strong>أفهم قاعدة التجديد:</strong> اعتماد الإيصال يضيف الرصيد وينشئ إذنًا واحدًا فقط. الخصم بقيمة {money(charge)} يتم عند انتهاء الاشتراك، وليس الآن.</span></label> : <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900"><strong>شحن فقط:</strong> سيُضاف المبلغ إلى الرصيد بعد الاعتماد، ولن ينشئ تجديدًا تلقائيًا.</div>}
          <Button className="w-full" type="submit" disabled={busy || (purpose === 'subscription_renewal' && !confirmed)}>{busy && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}إرسال الإيصال للمراجعة</Button>
        </form></CardContent></Card>
        <Card><CardHeader><CardTitle>كيف تعمل العملية؟</CardTitle></CardHeader><CardContent className="space-y-4 text-sm leading-7 text-slate-700">{['سجّل قيمة التحويل ومرجعه وارفع الإيصال؛ لا يتغير الرصيد عند الرفع.', 'مسؤول مخوّل يتأكد من وصول المبلغ؛ الاعتماد لا يمكن تكراره.', 'بعد الاعتماد يظهر المبلغ في رصيد الخدمات.', 'عند الاستحقاق فقط يُخصم السعر كاملًا؛ وإن لم يكفِ الرصيد تبدأ مهلة أربعة أيام.'].map((text, index) => <div key={text} className="rounded-xl bg-slate-100 p-4"><strong>{index + 1}. </strong>{text}</div>)}<Button asChild variant="outline" className="w-full"><Link to="/instructor-wallet">فتح سجل رصيد الخدمات</Link></Button><Button asChild variant="outline" className="w-full"><Link to="/support">التواصل مع الدعم</Link></Button></CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>سجل طلبات الشحن</CardTitle><p className="text-sm text-slate-500">كل محاولة محفوظة مستقلًا، بما فيها سبب الرفض ووقت المراجعة.</p></CardHeader><CardContent>{data.topups.length === 0 ? <p className="rounded-xl bg-slate-50 p-8 text-center text-slate-500">لم ترسل أي إيصال بعد.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm"><thead><tr className="border-b text-right text-slate-500"><th className="p-3">الغرض</th><th className="p-3">المبلغ</th><th className="p-3">التحويل</th><th className="p-3">الحالة</th><th className="p-3">المراجعة</th><th className="p-3">الإيصال</th></tr></thead><tbody>{data.topups.map(item => <tr key={item.id} className="border-b last:border-0"><td className="p-3 font-semibold">{purposeText[item.purpose_code]}</td><td className="p-3">{money(item.amount)}</td><td className="p-3"><div>{methodText[item.method] || item.method}</div><div className="text-xs text-slate-500">{item.reference_number} · {dateTime(item.paid_at)}</div></td><td className="p-3"><Badge variant={item.status === 'verified' ? 'default' : item.status === 'rejected' ? 'destructive' : 'secondary'}>{statusText[item.status] || item.status}</Badge></td><td className="p-3">{item.rejection_reason ? <span className="text-red-700">{item.rejection_reason}</span> : item.reviewed_at ? dateTime(item.reviewed_at) : 'بانتظار الإدارة'}</td><td className="p-3"><Button size="sm" variant="outline" onClick={() => void openProof(item)}>عرض خاص</Button></td></tr>)}</tbody></table></div>}</CardContent></Card>
    </>}
  </div></main></div>;
}
