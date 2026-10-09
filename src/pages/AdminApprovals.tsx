import { useEffect, useState } from 'react';
import Header from '@/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { approveAdminApproval, getAdminApprovals, rejectAdminApproval, type AdminApproval } from '@/lib/api';

export default function AdminApprovals() {
  const [approvals, setApprovals] = useState<AdminApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const load = async () => {
    try { setError(null); setApprovals(await getAdminApprovals()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحميل طلبات الموافقة'); }
  };
  useEffect(() => { void load(); }, []);
  const decide = async (id: string, approve: boolean) => {
    if (!approve && reason.trim().length < 3) { setError('اكتب سبب الرفض أولًا'); return; }
    if (approve && !confirm('هل راجعت المبلغ والسبب؟ سيتم تعديل رصيد الخدمات وتسجيل الحركة فور الاعتماد.')) return;
    setBusy(true);
    try {
      if (approve) await approveAdminApproval(id);
      else await rejectAdminApproval(id, reason.trim());
      setReason(''); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تنفيذ القرار'); }
    finally { setBusy(false); }
  };
  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-4xl space-y-6"><header><h1 className="text-3xl font-bold">الموافقات الإدارية</h1><p className="mt-2 text-slate-600">الـSuper Admin يستطيع اعتماد أي طلب، بما فيه طلبه. باقي المسؤولين يحتاجون مسؤولًا مخولًا آخر. جميع القرارات تُسجل في سجل التدقيق.</p></header>{error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{error}</div>}<Button variant="outline" onClick={load}>تحديث</Button><div className="space-y-3">{approvals.length === 0 ? <p className="rounded-lg border bg-white p-8 text-center text-slate-500">لا توجد طلبات موافقة معلّقة.</p> : approvals.map(a => { const value = typeof a.requested_value === 'string' ? JSON.parse(a.requested_value) : a.requested_value; return <Card key={a.id}><CardHeader><CardTitle className="text-lg">{a.action_key === 'service_credit.credit' ? 'إضافة رصيد خدمات' : 'خصم رصيد خدمات'} — {value.amount} ج.م</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-slate-600">المدرس: {a.resource_id}</p><p>السبب: {a.reason}</p><p className="text-xs text-slate-500">مقدم الطلب: {a.requested_by} · {new Date(a.created_at).toLocaleString('ar-EG')}</p><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void decide(a.id, true)}>اعتماد</Button><Input className="w-52" placeholder="سبب الرفض" value={reason} onChange={e => setReason(e.target.value)} /><Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => void decide(a.id, false)}>رفض</Button></div></CardContent></Card>; })}</div></div></main></div>;
}
