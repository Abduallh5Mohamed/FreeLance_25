import PlatformMfaPanel from '@/components/PlatformMfaPanel';
import { useEffect, useRef, useState } from 'react';
import Header from '@/components/Header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { approveAdminApproval, getAdminApprovals, rejectAdminApproval, type AdminApproval } from '@/lib/api';

export default function AdminApprovals() {
  const [approvals, setApprovals] = useState<AdminApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mutation = useRef(false);
  const loadSequence = useRef(0);
  const [listReady, setListReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setListReady(false);
    try { setError(null); const next = await getAdminApprovals(); if (!Array.isArray(next)) throw new Error('تعذر تأكيد قائمة الطلبات'); if (sequence !== loadSequence.current) return; setApprovals(next); setListReady(true); }
    catch (cause) { if (sequence === loadSequence.current) { setApprovals([]); setError(cause instanceof Error ? cause.message : 'تعذر تحميل طلبات الموافقة'); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { loadSequence.current += 1; }; }, []);
  const decide = async (id: string, approve: boolean) => {
    if (mutation.current || loading || !listReady) return;
    if (!approve && reason.trim().length < 3) { setError('اكتب سبب الرفض أولًا'); return; }
    if (approve && !confirm('هل راجعت المبلغ والسبب؟ سيتم تعديل رصيد الخدمات وتسجيل الحركة فور الاعتماد.')) return;
    mutation.current = true; setBusy(true); setError(null);
    try {
      if (approve) await approveAdminApproval(id);
      else await rejectAdminApproval(id, reason.trim());
      setReason(''); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تنفيذ القرار'); }
    finally { mutation.current = false; setBusy(false); }
  };
  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-4xl space-y-6"><header><h1 className="text-3xl font-bold">الموافقات الإدارية</h1><p className="mt-2 text-slate-600">الـSuper Admin يستطيع اعتماد أي طلب، بما فيه طلبه. باقي المسؤولين يحتاجون مسؤولًا مخولًا آخر. جميع القرارات تُسجل في سجل التدقيق.</p></header><PlatformMfaPanel />{error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{error}</div>}<Button variant="outline" disabled={loading || busy} onClick={load}>تحديث</Button><div className="space-y-3">{loading ? <p role="status">جارٍ تحميل الطلبات…</p> : error && approvals.length === 0 ? <p>تعذّر تأكيد قائمة الطلبات.</p> : approvals.length === 0 ? <p className="rounded-lg border bg-white p-8 text-center text-slate-500">لا توجد طلبات موافقة معلّقة.</p> : approvals.map(a => { let amount: string | null = null; try { const value: unknown = typeof a.requested_value === 'string' ? JSON.parse(a.requested_value) : a.requested_value; if (value && typeof value === 'object' && 'amount' in value && (typeof value.amount === 'string' || typeof value.amount === 'number') && /^\d+(?:\.\d{1,2})?$/.test(String(value.amount))) amount = String(value.amount); } catch { /* Invalid historical payload cannot authorize a decision. */ } const knownAction = ['service_credit.credit', 'service_credit.debit'].includes(a.action_key); return <Card key={a.id}><CardHeader><CardTitle className="text-lg">{a.action_key === 'service_credit.credit' ? 'إضافة رصيد خدمات' : a.action_key === 'service_credit.debit' ? 'خصم رصيد خدمات' : 'نوع طلب غير مدعوم'} — {amount === null ? 'مبلغ غير قابل للتحقق' : amount + ' ج.م'}</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-slate-600">المدرس: {a.resource_id}</p><p>السبب: {a.reason}</p><p className="text-xs text-slate-500">مقدم الطلب: {a.requested_by} · {new Date(a.created_at).toLocaleString('ar-EG')}</p><div className="flex flex-wrap gap-2"><Button disabled={busy || loading || !listReady || amount === null || !knownAction} onClick={() => void decide(a.id, true)}>اعتماد</Button><Input className="w-52" placeholder="سبب الرفض" disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /><Button variant="destructive" disabled={busy || loading || !listReady || reason.trim().length < 3} onClick={() => void decide(a.id, false)}>رفض</Button></div></CardContent></Card>; })}</div></div></main></div>;
}
