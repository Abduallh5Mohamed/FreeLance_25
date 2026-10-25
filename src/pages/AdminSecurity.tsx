import PlatformMfaPanel from '@/components/PlatformMfaPanel';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import Header from '@/components/Header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAdminSecurity, type AdminSecurityData } from '@/lib/api';

export default function AdminSecurity() {
  const loadSequence = useRef(0);
  const [data, setData] = useState<AdminSecurityData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const sequence = ++loadSequence.current;
    setData(null); setLoading(true); setError(null);
    try { const next = await getAdminSecurity(); if (!next || !next.summary || !Array.isArray(next.events)) throw new Error('تعذر تأكيد سجل الأمان'); if (sequence === loadSequence.current) setData(next); }
    catch (cause) { if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : 'تعذر تحميل سجل الأمان'); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { loadSequence.current += 1; }; }, []);
  const cards = data ? [
    ['أحداث خلال 24 ساعة', data.summary.events_24h],
    ['تغييرات حسابات الإدارة', data.summary.admin_changes_24h],
    ['قرارات مالية مسجلة', data.summary.financial_changes_24h],
  ] : [];
  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-7xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-600">الأمان والتدقيق</p><h1 className="flex items-center gap-2 text-3xl font-bold"><ShieldCheck className="text-indigo-600" />سجل أنشطة الإدارة</h1><p className="mt-2 text-slate-600">يعرض من نفّذ الإجراء ومتى وعلى أي مورد. كلمات المرور والرموز والبيانات البنكية السرية لا تُعرض هنا.</p></div><Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={`ml-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />تحديث</Button></header><PlatformMfaPanel />
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-950"><strong>مهم:</strong> سجل التدقيق للمراجعة والتحقيق، وليس زرًا لتنفيذ قرارات مالية أو تعديل الحسابات. أي إجراء يتم من صفحة الفريق أو المالية حسب الصلاحية.</div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
    <section className="grid gap-4 md:grid-cols-3">{cards.map(([label, value]) => <Card key={String(label)}><CardContent className="p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-3xl font-bold">{Number(value).toLocaleString('ar-EG')}</p></CardContent></Card>)}</section>
    <Card><CardHeader><CardTitle>أحدث الأحداث</CardTitle></CardHeader><CardContent className="space-y-3">{loading ? <p role="status">جارٍ تحميل الأحداث…</p> : !data ? <p>لم يتم تأكيد سجل الأحداث.</p> : !data.events.length ? <p className="py-8 text-center text-slate-500">لا توجد أحداث مسجلة.</p> : data.events.map(event => <div key={event.id} className="rounded-xl border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong dir="ltr">{event.action}</strong><Badge variant="outline">{event.resource_type}</Badge></div><p className="mt-2 text-sm text-slate-600">المنفذ: {event.actor_name || 'النظام'} · المورد: <span dir="ltr">{event.resource_id}</span>{event.business_name ? ` · ${event.business_name}` : ''}</p>{event.reason && <p className="mt-1 text-sm text-slate-600">السبب: {event.reason}</p>}<p className="mt-2 text-xs text-slate-400">{new Date(event.created_at).toLocaleString('ar-EG')}</p></div>)}</CardContent></Card>
  </div></main></div>;
}
