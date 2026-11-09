import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import { createFamilyController, familyTransport, initialFamily, type AttendanceState } from '@/features/family/family-summary';

const attendanceLabels: Record<AttendanceState, string> = { present: 'حاضر', late: 'متأخر', absent: 'غياب مسجل', excused: 'بعذر', unmarked: 'لم يسجل الحضور' };
const actions = {
    check_attendance: 'اسأل ابنك عن الغياب المسجل، واتفقا على التواصل مع المدرس إذا احتاج تعويض ما فاته.',
    confirm_unmarked: 'اسأل المدرس عن الحصص التي لم يسجل حضورها؛ عدم التسجيل لا يعني غياب ابنك.',
    prepare_next_session: 'راجع مع ابنك موعد الحصة القادمة واستعدا لها.',
    contact_teacher: 'راجع المدرس للتأكد من المجموعة الحالية ومواعيدها؛ لا تتوفر أجندة مخولة الآن.',
    no_action: 'لا توجد خطوة متابعة مقترحة من البيانات المتاحة الآن. يمكنك سؤال ابنك عما يحتاجه.',
};
const time = (value: string) => new Date(value).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });
export default function Family() {
    const [state, setState] = useState(initialFamily);
    const controller = useRef<ReturnType<typeof createFamilyController> | null>(null);
    useEffect(() => {
        const c = createFamilyController({ transport: familyTransport, readPrincipal: () => readCourseSessionPrincipal(localStorage), subscribeSession: subscribeSessionChange });
        controller.current = c; const unsubscribe = c.subscribe(setState);
        const storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key)) c.invalidate(); };
        const focus = () => c.clearView();
        const visibility = () => { if (document.visibilityState === 'hidden') c.clearView(); };
        window.addEventListener('storage', storage); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visibility);
        void c.loadLinks();
        return () => { unsubscribe(); c.dispose(); controller.current = null; window.removeEventListener('storage', storage); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); };
    }, []);
    const busy = state.phase === 'loading-links' || state.phase === 'loading-child';
    const summary = state.summary;
    return <main dir="rtl" className="mx-auto min-h-screen max-w-5xl space-y-5 bg-background p-5 text-foreground">
        <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">متابعة الأسرة</h1><Link to="/" className="underline">الرئيسية</Link></div>
        <p>اختر رابط ابن موثّق لعرض ملخصه وحده. كل رابط يخص قيدًا داخل مؤسسة؛ لا ندمج المؤسسات أو نفترض أن رقم الهاتف وحده يسمح بالاطلاع.</p>
        {state.phase === 'session-ended' ? <p role="alert">تغير الحساب أو مساحة العمل؛ أُخفيت بيانات الأسرة. افتح الصفحة من جديد.</p> : <>
            <div className="flex flex-wrap gap-3">
                <Button variant="outline" disabled={busy} onClick={() => { void controller.current?.loadLinks(); }}>تحديث روابط الأبناء</Button>
                <label>الرابط الموثّق <select aria-label="اختيار رابط الابن" className="mx-2 rounded border p-2" value={state.selected ?? ''}
                    onChange={e => { if (e.target.value) void controller.current?.select(e.target.value); }}>
                    <option value="" disabled>اختر رابطًا</option>
                    {state.links.filter(l => l.status === 'active').map((l, i) => <option key={l.id} value={l.id}>رابط ابن موثّق {i + 1}{state.selected === l.id && summary ? ' — ' + summary.child.name : ''}</option>)}
                </select></label>
                <Button disabled={busy || !state.selected} onClick={() => { void controller.current?.refresh(); }}>تحديث ملخص الابن</Button>
            </div>
            {state.links.length === 200 ? <p>نعرض أحدث ٢٠٠ رابط فقط؛ هذه ليست قائمة كاملة بكل الروابط القديمة.</p> : null}
            {state.phase === 'choose' && !state.links.some(l => l.status === 'active') ? <p>لا يوجد رابط نشط متاح. إنشاء الرابط يحتاج تحقق جهة الاتصال المسجلة؛ عرض الصفحة لا ينشئه، وإرسال كود التحقق يتطلب قناة جاهزة.</p> : null}
            {busy ? <p role="status">جارٍ التحقق؛ أُخفي الملخص السابق.</p> : null}
            {state.phase === 'error' ? <p role="alert">{state.issue === 'unavailable'
                ? 'خدمة متابعة الأسرة غير متاحة حاليًا. هذا لا يعني عدم وجود أبناء مربوطين أو عدم وجود حصص. حاول لاحقًا أو راجع مسؤول المؤسسة.'
                : state.issue === 'access_lost'
                    ? 'لم يعد الوصول إلى هذا الملخص متاحًا. أُخفيت بيانات الابن وأُزيل الاختيار؛ حدّث روابط الأبناء لإعادة التحقق.'
                    : 'تعذر التحقق من الملخص أو العلاقة الآن. لا نعرض بيانات قديمة على أنها محدثة. حدّث الروابط أو الملخص للمحاولة من جديد.'}</p> : null}
            {state.phase === 'expired' ? <p role="status">أُخفي الملخص بعد مرور فترة العرض أو مغادرة الصفحة. اضغط تحديث لإعادة التحقق.</p> : null}
            {summary ? <>
                <section className="space-y-2 rounded-xl border bg-card p-5"><h2 className="text-xl font-semibold">{summary.child.name}</h2>
                    <p>{summary.child.group ?? 'المجموعة غير متاحة'} — {summary.child.course ?? 'المقرر غير متاح'}</p>
                    <p>آخر تحقق: <time dateTime={summary.checked_at}>{time(summary.checked_at)} بتوقيت القاهرة</time>. هذه قراءة وقتية، وليست إشعارًا وصل أو متابعة لحظية.</p>
                    <div className="rounded bg-muted p-3"><h3 className="font-semibold">خطوة متابعة واحدة</h3><p>{actions[summary.next_action]}</p></div>
                </section>
                <section className="space-y-3 rounded-xl border p-5"><h2 className="text-lg font-semibold">حضور آخر ٧ أيام</h2>
                    <p>حصص المجموعة الحالية المنتهية فقط، ضمن مدة القيد. هذا ليس تاريخ انتقالات المجموعات؛ بعذر وعدم التسجيل يظهران منفصلين، ولا نستنتج منهما تقصيرًا.</p>
                    {summary.scope === 'no_current_group' ? <p>لا تتوفر مجموعة مخولة لحساب الحضور.</p> : <>
                        <dl className="grid grid-cols-2 gap-2 md:grid-cols-5">{(Object.keys(attendanceLabels) as AttendanceState[]).map(s => <div key={s} className="rounded bg-muted p-3"><dt>{attendanceLabels[s]}</dt><dd className="text-xl font-bold">{summary.attendance.counts[s]}</dd></div>)}</dl>
                        {!summary.attendance.sessions.length ? <p>لا توجد حصص منتهية متاحة في هذه الفترة؛ لا يعني ذلك عدم وجود غياب في فترات أخرى.</p> : <details><summary className="cursor-pointer underline">تفاصيل الحصص ومصدر الملخص</summary><ul className="space-y-2 pt-3">{summary.attendance.sessions.map(s => <li key={s.id}>{s.title} — <time dateTime={s.starts_at}>{time(s.starts_at)}</time> — {attendanceLabels[s.state]}</li>)}</ul></details>}
                    </>}
                </section>
                <section className="space-y-3 rounded-xl border p-5"><h2 className="text-lg font-semibold">أجندة الأيام السبعة القادمة</h2><p>مواعيد المجموعة الحالية فقط، بتوقيت القاهرة. قد يعدّلها المدرس؛ التحديث يعيد قراءة المواعيد، ولا يرسل رسالة أو يحجز حضورًا.</p>
                    {!summary.agenda.length ? <p>لا توجد مواعيد متاحة في الفترة المعروضة.</p> : <ol className="space-y-3">{summary.agenda.map(s => <li key={s.id} className="rounded border p-3"><strong>{s.title}</strong><p><time dateTime={s.starts_at}>{time(s.starts_at)}</time> إلى <time dateTime={s.ends_at}>{time(s.ends_at)}</time></p></li>)}</ol>}
                </section>
                <p className="rounded border p-4">الدرجات غير معروضة هنا لحين إثبات نشرها للأسرة. هذا الملخص لا يقيس الفهم، ولا يعرض مفاتيح الإجابات أو خططًا خاصة بالمدرس.</p>
            </> : null}
        </>}
    </main>;
}
