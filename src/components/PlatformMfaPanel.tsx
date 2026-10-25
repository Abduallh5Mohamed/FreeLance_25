import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AUTH_SESSION_CHANGED_EVENT, clearPlatformStepUp, disablePlatformMfa, enrollPlatformMfa, getPlatformMfaStatus, verifyPlatformMfa, type PlatformMfaStatus } from '@/lib/api';

/** Secrets stay in component memory. Verification never replays a pending mutation. */
export default function PlatformMfaPanel() {
  const id = useId();
  const [status, setStatus] = useState<PlatformMfaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [secret, setSecret] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const perform = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setBusy(true); setError(null); setNotice('');
    try { await action(); }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'تعذّر تنفيذ التحقق. حدّث الحالة قبل إعادة المحاولة.'); }
    finally { if (current === generation.current) { inFlight.current = false; setBusy(false); } }
  };
  const refresh = async () => {
    const current = generation.current;
    const next = await getPlatformMfaStatus();
    if (current === generation.current) setStatus(next);
  };
  useEffect(() => {
    let mounted = true;
    const initialGeneration = generation.current;
    void getPlatformMfaStatus().then(next => { if (mounted && initialGeneration === generation.current) setStatus(next); }).catch(cause => { if (mounted && initialGeneration === generation.current) setError(cause instanceof Error ? cause.message : 'تعذّر تحميل حالة التحقق'); });
    const reset = () => {
      generation.current += 1; clearPlatformStepUp(); inFlight.current = false;
      setStatus(null); setSecret(''); setCodes([]); setCode(''); setReason(''); setNotice(''); setBusy(false);
      setError('تغيّرت جلسة الدخول. أعد تحميل حالة التحقق.');
    };
    const storage = (event: StorageEvent) => { if (event.key === 'authToken' || event.key === null) reset(); };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, reset);
    window.addEventListener('storage', storage);
    return () => { mounted = false; generation.current += 1; window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, reset); window.removeEventListener('storage', storage); };
  }, []);
  const bound = status?.session_bound === true;
  const reasonValid = reason.trim().length >= 8 && reason.trim().length <= 1000;
  const verify = () => perform(async () => {
    const current = generation.current;
    const issued = await verifyPlatformMfa(recovery ? { recovery_code: code } : { code });
    if (current !== generation.current) return;
    setCodes(issued); setCode(''); setSecret('');
    setNotice('تم التحقق مؤقتًا لهذه الجلسة. ارجع للإجراء المطلوب ونفّذه بنفسك.');
    await refresh();
  });
  return <Card><CardHeader><CardTitle>التحقق الإضافي للإجراءات الحساسة</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-slate-600">الحالة: {status ? ({ none: 'غير مفعّل', pending: 'بانتظار تأكيد الإعداد', active: 'مفعّل' }[status.status]) : 'لم يتم تأكيد الحالة'}. الرمز المؤقت يبقى في ذاكرة علامة التبويب ولا يعيد أي إجراء تلقائيًا.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {notice && <p role="status" className="text-emerald-800">{notice}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void perform(refresh)}>تحديث حالة التحقق</Button>
    {status && !bound && <p className="text-amber-800">هذه الجلسة غير مرتبطة بمعرّف جلسة خادمي. التحقق الإضافي غير متاح حتى تتوفر جلسة مدعومة من الخادم.</p>}
    {status?.locked && <p role="alert" className="text-amber-800">التحقق مقفول مؤقتًا. انتظر ثم حدّث الحالة.</p>}
    <fieldset disabled={busy || !bound || codes.length > 0} className="space-y-3">
      <label className="block" htmlFor={id + '-reason'}>سبب إعداد أو تعطيل التحقق (8–1000 حرف)</label>
      <Input id={id + '-reason'} value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} />
      {status?.status !== 'active' && <Button disabled={!reasonValid} onClick={() => void perform(async () => {
        const current = generation.current;
        const result = await enrollPlatformMfa(reason.trim());
        if (current !== generation.current) return;
        setSecret(result.secret); setCodes([]); setCode('');
        setNotice('أضف المفتاح يدويًا في تطبيق المصادقة ثم أدخل الرمز. إعادة الإعداد تستبدل المفتاح السابق.');
        await refresh();
      })}>إعداد تطبيق المصادقة</Button>}
      {secret && <div className="rounded border p-3"><p>مفتاح الإعداد السري — لا تشاركه:</p><code dir="ltr" className="block break-all select-all">{secret}</code><Button variant="outline" onClick={() => setSecret('')}>إخفاء المفتاح</Button></div>}
      {status && status.status !== 'none' && <div className="space-y-2">
        <label className="block" htmlFor={id + '-code'}>{recovery ? 'رمز استرداد يُستخدم مرة واحدة' : 'رمز تطبيق المصادقة'}</label>
        <Input id={id + '-code'} dir="ltr" autoComplete="off" type="password" inputMode={recovery ? 'text' : 'numeric'} value={code} maxLength={128} onChange={event => setCode(event.target.value)} />
        <Button variant="outline" onClick={() => { setRecovery(!recovery); setCode(''); }}>{recovery ? 'استخدام تطبيق المصادقة' : 'استخدام رمز استرداد'}</Button>
        <Button disabled={status.locked || (recovery ? !code.trim() : !/^\d{6}$/.test(code))} onClick={() => void verify()}>تحقق لهذه الجلسة</Button>
      </div>}
      {status?.status === 'active' && <Button variant="destructive" disabled={!reasonValid} onClick={() => {
        if (!window.confirm('تعطيل التحقق الإضافي وإبطال رموز الاسترداد؟ يلزم تحقق حديث أولًا.')) return;
        void perform(async () => { const current = generation.current; await disablePlatformMfa(reason.trim()); if (current !== generation.current) return; setCodes([]); setSecret(''); setCode(''); await refresh(); setNotice('تم تعطيل التحقق الإضافي.'); });
      }}>تعطيل التحقق الإضافي</Button>}
    </fieldset>
    {codes.length > 0 && <section className="rounded border border-amber-300 bg-amber-50 p-4"><h3 className="font-bold">احفظ رموز الاسترداد الآن</h3><p>لن تُعرض مرة أخرى. لا تشاركها أو تحفظها في جهاز مشترك.</p><ul dir="ltr">{codes.map((value, index) => <li key={index}><code className="select-all">{value}</code></li>)}</ul><Button variant="outline" onClick={() => setCodes([])}>حفظتها — إخفاء الرموز</Button></section>}
  </CardContent></Card>;
}
