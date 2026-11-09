import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authenticatedApiFetch, readAuthenticatedApiJson } from '@/lib/api-http';
import { boundedRequest } from '@/lib/bounded-request';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { parseReturnFollowUp, type ReturnFollowUp } from './return-plan-follow-up';
export function ReturnPlanFollowUp({ courseId, enrollmentId, locked }: { courseId: string; enrollmentId: string; locked: boolean }) {
  const [generation, setGeneration] = useState(0), [data, setData] = useState<ReturnFollowUp | null>(null), [phase, setPhase] = useState('loading');
  useEffect(() => {
    let alive = true, expiry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(), principal = () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } }, identity = principal();
    const invalidate = () => { alive = false; controller.abort(); clearTimeout(expiry); setData(null); setPhase('session-ended'); };
    const unsubscribe = subscribeSessionChange(invalidate);
    setData(null); setPhase('loading');
    void boundedRequest(controller, async () => {
      if (!identity) throw Error('Missing session');
      const r = await authenticatedApiFetch(`/tenants/me/catalog/courses/${courseId}/return-plan/follow-up/${encodeURIComponent(enrollmentId)}`, { signal: controller.signal, cache: 'no-store' });
      const raw = await readAuthenticatedApiJson(r); if (!r.ok) throw Error('Unavailable follow-up'); return parseReturnFollowUp(raw, courseId, enrollmentId);
    }).then(value => {
      if (!alive) return; if (principal() !== identity) { invalidate(); return; }
      setData(value); setPhase('ready'); expiry = setTimeout(() => { setData(null); setPhase('expired'); }, 60000);
    }).catch(() => { if (alive) { setData(null); setPhase(principal() !== identity ? 'session-ended' : 'error'); } });
    const hide = () => { if (document.visibilityState === 'hidden') { alive = false; controller.abort(); setData(null); setPhase('expired'); } };
    document.addEventListener('visibilitychange', hide);
    return () => { alive = false; controller.abort(); clearTimeout(expiry); unsubscribe(); document.removeEventListener('visibilitychange', hide); };
  }, [courseId, enrollmentId, generation]);
  return <aside aria-label="متابعة الخطة المحفوظة" className="space-y-2 rounded border p-3">
    <h5 className="font-semibold">متابعة الخطة المحفوظة حاليًا</h5>
    <Button type="button" variant="outline" disabled={locked || phase === 'loading' || phase === 'session-ended'} onClick={() => setGeneration(n => n + 1)}>تحديث متابعة الخطة</Button>
    {phase === 'loading' ? <p role="status">جارٍ إثبات الخطة والخطوات الحالية.</p> : null}
    {phase === 'error' ? <p role="alert">تعذر إثبات المتابعة الحالية؛ أُخفيت البيانات السابقة.</p> : null}
    {phase === 'expired' ? <p>أُخفيت المتابعة لانتهاء مدة عرضها أو مغادرة الصفحة. حدّثها لقراءة جديدة.</p> : null}
    {phase === 'session-ended' ? <p role="alert">تغيرت الجلسة؛ أُخفيت المتابعة.</p> : null}
    {data ? <><p>وقت القراءة: {new Date(data.checked_at).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })} — القاهرة</p>
      {!data.plan ? <p>لا توجد خطة محفوظة لهذا الطالب في المقرر.</p> : data.plan.status === 'withdrawn' ? <p>الخطة الحالية مسحوبة — النسخة {data.plan.version}. لا نرجع لخطة أقدم.</p> : <><p>نسخة الخطة: {data.plan.version}. الإكمال المسجل للخطوات المتاحة: {data.plan.steps.filter(s => s.available && s.completed).length}؛ خطوات غير متاحة: {data.plan.steps.filter(s => !s.available).length}.</p><ol className="list-decimal ps-5">{data.plan.steps.map(s => <li key={s.position}>{s.available ? `${s.title} — ${s.completed ? 'إكمال مسجل في مسار الدروس الجديد' : 'لم يسجل إكمالها'}` : 'خطوة غير متاحة حاليًا؛ أُخفيت تفاصيلها.'}</li>)}</ol></>}
      <p>هذه متابعة لسجل الدروس الجديد فقط؛ لا تثبت بدء المذاكرة أو الفهم أو انتهاء خطة الرجوع، ولا تغيّر التقدم أو صلاحية الاشتراك.</p></> : null}
  </aside>;
}
