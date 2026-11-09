import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import { accountLinkRequest, createLinkWrite, linkRecoveryStore, parseLinkPage, parseLinkReview, parseLinkReceipt, readLinkAvailability, type LinkReceipt, type LinkReview, type LinkWriteState, type LinkAvailability } from './account-link';
const ownerBase = '/tenants/me/catalog/account-link';
function useLinkAvailability(kind: 'owner' | 'student') {
    const [availability, setAvailability] = useState<LinkAvailability | 'loading' | 'unavailable'>('loading');
    useEffect(() => {
        let current = true;
        const c = new AbortController(), identity = principal();
        const timer = setTimeout(() => { if (current) {
            current = false;
            c.abort();
            setAvailability('unavailable');
        } }, 25000);
        const unsubscribe = kind === 'owner' ? subscribeSessionChange(() => { current = false; c.abort(); setAvailability('unavailable'); }) : () => { };
        void readLinkAvailability(kind, c.signal).then(value => { if (current && (kind === 'student' || identity === principal()))
            setAvailability(value); }).catch(() => { if (current)
            setAvailability('unavailable'); }).finally(() => clearTimeout(timer));
        return () => { current = false; c.abort(); clearTimeout(timer); unsubscribe(); };
    }, [kind]);
    return availability;
}
function LinkAvailabilityMessage({ availability }: {
    availability: ReturnType<typeof useLinkAvailability>;
}) {
    return <p role="status">{availability === 'deferred' ? 'ربط الأونلاين مؤجّل حاليًا.' : availability === 'loading' ? 'جارٍ التحقق من إتاحة الربط…' : 'تعذر قراءة إتاحة الربط؛ أعد فتح الصفحة.'}</p>;
}
function principal() {
    try {
        return readCourseSessionPrincipal(localStorage);
    }
    catch {
        return null;
    }
}
function identity() {
    try {
        return JSON.parse(localStorage.getItem('currentUser') ?? 'null');
    }
    catch {
        return null;
    }
}
function useLinkWrite(kind: 'owner' | 'student', invitation = '') {
    const [state, setState] = useState<LinkWriteState>({ phase: 'idle', receipt: null, message: null });
    const ref = useRef<ReturnType<typeof createLinkWrite> | null>(null);
    useEffect(() => {
        if (!identity()?.id || !principal()) {
            setState({ phase: 'idle', receipt: null, message: null });
            return;
        }
        let store: ReturnType<typeof linkRecoveryStore>;
        try {
            store = linkRecoveryStore(sessionStorage, identity()?.id, kind);
        }
        catch {
            const unavailable = () => { throw Error('Recovery unavailable'); };
            store = { read: unavailable, write: unavailable, clear: unavailable };
        }
        const base = kind === 'owner' ? ownerBase : '/student-enrollment/join/' + encodeURIComponent(invitation) + '/account-link';
        const c = createLinkWrite({ store, principal, subscribe: subscribeSessionChange,
            post: (marker, body, signal) => accountLinkRequest(base + (marker.kind === 'owner' ? '/apply' : marker.action === 'withdraw' ? '/' + marker.operation_id + '/withdraw' : ''), body, signal),
            get: (marker, signal) => accountLinkRequest(base + (marker.kind === 'owner' ? '/operations/' : '/') + marker.operation_id, undefined, signal) });
        ref.current = c;
        const unsub = c.subscribe(setState);
        const changed = (e: StorageEvent) => {
            if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key))
                c.invalidate();
        };
        window.addEventListener('storage', changed);
        return () => { unsub(); c.dispose(); ref.current = null; window.removeEventListener('storage', changed); };
    }, [kind, invitation]);
    const busy = ['saving', 'uncertain', 'recovering', 'ended'].includes(state.phase);
    useEffect(() => {
        if (!['saving', 'uncertain', 'recovering'].includes(state.phase))
            return;
        const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [state.phase]);
    return { ref, state, busy };
}
export function AccountLinkOwnerPanel() {
    const { ref, state, busy } = useLinkWrite('owner');
    const availability = useLinkAvailability('owner');
    const [requests, setRequests] = useState<ReturnType<typeof parseLinkPage>>({ items: [], next_cursor: null }), [students, setStudents] = useState<ReturnType<typeof parseLinkPage>>({ items: [], next_cursor: null });
    const [selectedRequest, setRequest] = useState(''), [selectedStudent, setStudent] = useState(''), [review, setReview] = useState<LinkReview | null>(null), [confirmed, setConfirmed] = useState(false), [reading, setReading] = useState(false), [message, setMessage] = useState<string | null>(null);
    const lifetime = useRef<{
        active: boolean;
        principal: string | null;
        epoch: number;
        abort: AbortController | null;
    }>({ active: false, principal: null, epoch: 0, abort: null });
    useEffect(() => { const life = { active: true, principal: principal(), epoch: 0, abort: null as AbortController | null }; lifetime.current = life; return () => { life.active = false; life.epoch++; life.abort?.abort(); }; }, []);
    useEffect(() => {
        setReview(null);
        setConfirmed(false);
        if (state.phase === 'ended') {
            lifetime.current.epoch++;
            lifetime.current.abort?.abort();
            setRequests({ items: [], next_cursor: null });
            setStudents({ items: [], next_cursor: null });
            setRequest('');
            setStudent('');
            setMessage(null);
        }
    }, [state.phase]);
    async function read(work: (signal: AbortSignal) => Promise<() => void>) {
        if (busy || reading)
            return;
        const life = lifetime.current;
        if (!life.active || life.principal !== principal()) {
            ref.current?.invalidate();
            return;
        }
        life.abort?.abort();
        const n = ++life.epoch, c = new AbortController();
        life.abort = c;
        setReading(true);
        setMessage(null);
        setReview(null);
        setConfirmed(false);
        const current = () => life.active && n === life.epoch && life.principal === principal() && !c.signal.aborted;
        const timer = setTimeout(() => {
            if (current()) {
                c.abort();
                life.epoch++;
                setReading(false);
                setMessage('انتهت مهلة القراءة؛ أعد المحاولة بمعاينة جديدة.');
            }
        }, 25000);
        try {
            const apply = await work(c.signal);
            if (current())
                apply();
        }
        catch {
            if (current())
                setMessage('تعذر إثبات البيانات الحالية؛ راجع الجاهزية والتحقق وتطابق هاتف السجل مع الحساب.');
        }
        finally {
            clearTimeout(timer);
            if (current())
                setReading(false);
        }
    }
    async function load(kind?: 'requests' | 'students') {
        setRequest('');
        setStudent('');
        setRequests({ items: [], next_cursor: null });
        setStudents({ items: [], next_cursor: null });
        const rc = kind === 'requests' ? requests.next_cursor : null, sc = kind === 'students' ? students.next_cursor : null;
        await read(async (signal) => { const [r, s] = await Promise.all([accountLinkRequest(ownerBase + '/requests' + (rc ? '?cursor=' + rc : ''), undefined, signal), accountLinkRequest(ownerBase + '/students' + (sc ? '?cursor=' + sc : ''), undefined, signal)]); const a = parseLinkPage(r), b = parseLinkPage(s); return () => { setRequests(a); setStudents(b); }; });
    }
    const choose = () => { setReview(null); setConfirmed(false); setMessage(null); };
    const locked = busy || reading;
    if (state.phase === 'ended')
        return <p role="alert">تغيرت الجلسة؛ أُخفيت بيانات ربط الحساب.</p>;
    if (availability !== 'verification_required')
        return <section dir="rtl" aria-label="ربط الأونلاين بالسجل الموجود" className="mb-6 space-y-3 rounded border p-4"><h2 className="font-bold">ربط حساب الطالب بنفس السجل</h2><LinkAvailabilityMessage availability={availability}/><LinkWriteFeedback state={state} recover={() => void ref.current?.recover()}/></section>;
    return <section dir="rtl" aria-label="ربط الأونلاين بالسجل الموجود" className="mb-6 space-y-3 rounded border border-cyan-200 bg-cyan-50/30 p-4">
  <h2 className="font-bold">ربط حساب الطالب بنفس السجل</h2>
  <p>الطالب يدخل بحسابه ويتحقق من هاتفه ويرسل طلب ربط من رابطك. اختر طلبًا وسجلًا بنفس الهاتف، ثم عاين وأكد. يُربط الحساب بالسجل نفسه دون إنشاء طالب آخر؛ المجموعة والمقررات لا تُضاف هنا. السجل يجب أن يكون بلا حساب أو مجموعة أو فرع أو تعيين مقرر.</p>
  <Button disabled={locked} variant="outline" onClick={() => void load()}>تحميل طلبات الربط والسجلات</Button>
  <label className="block">طلب الطالب<select aria-label="طلب الطالب للربط" disabled={locked} className="block w-full rounded border p-2" value={selectedRequest} onChange={e => { setRequest(e.target.value); choose(); }}><option value="">اختر طلبًا من الصفحة الحالية</option>{requests.items.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
  <Button disabled={locked || !requests.next_cursor} variant="outline" onClick={() => void load('requests')}>طلبات ربط تالية</Button>
  <label className="block">السجل الموجود<select aria-label="السجل الموجود للربط" disabled={locked} className="block w-full rounded border p-2" value={selectedStudent} onChange={e => { setStudent(e.target.value); choose(); }}><option value="">اختر سجلًا من الصفحة الحالية</option>{students.items.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
  <Button disabled={locked || !students.next_cursor} variant="outline" onClick={() => void load('students')}>سجلات ربط تالية</Button>
  <Button disabled={locked || !selectedStudent || !selectedRequest} onClick={() => void read(async (signal) => { const raw = await accountLinkRequest(ownerBase + '/review', { student_id: selectedStudent, request_id: selectedRequest }, signal), preview = parseLinkReview(raw, selectedStudent, selectedRequest); return () => setReview(preview); })}>معاينة ربط الحساب</Button>
  {review ? <div className="space-y-2 rounded border p-3"><p>الحساب: {review.request.name} ← السجل: {review.student.name}</p><p>ستُربط هوية الدخول فقط، ويُحفظ نفس السجل وتاريخه. لا تعيين مجموعة أو مقرر أو تحصيل.</p><label><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)}/>أؤكد أن الحساب والسجل لنفس الطالب وأوافق على الربط المعروض.</label><Button disabled={locked || !confirmed} onClick={() => {
                if (!confirmed || !ref.current)
                    return;
                let operation_id: string;
                try {
                    operation_id = crypto.randomUUID();
                }
                catch {
                    setMessage('تعذر إنشاء معرّف آمن؛ لم يُرسل طلب حفظ.');
                    return;
                }
                setConfirmed(false);
                void ref.current.apply({ kind: 'owner', operation_id, student_id: review.student.id, request_id: review.request.id }, { operation_id, student_id: review.student.id, request_id: review.request.id, review_token: review.review_token, confirmed: true });
            }}>تأكيد ربط الحساب بالسجل</Button></div> : null}
  {message ? <p role="alert">{message}</p> : null}<LinkWriteFeedback state={state} recover={() => void ref.current?.recover()}/>
 </section>;
}
function LinkWriteFeedback({ state, recover }: {
    state: LinkWriteState;
    recover: () => void;
}) {
    return <>{state.message ? <p role="alert">{state.message}</p> : null}{state.receipt ? <p role="status">{'state' in state.receipt && state.receipt.state === 'account_linked' ? 'تأكد ربط الحساب بالسجل؛ الإيصال تاريخي.' : state.receipt.state === 'expired' ? 'انتهت صلاحية الطلب؛ يلزم تحقق وطلب جديد.' : 'state' in state.receipt && state.receipt.state === 'withdrawn' ? 'تأكد سحب طلب الربط.' : 'state' in state.receipt && state.receipt.state === 'linked' ? 'الطلب مرتبط بسجل؛ ارجع لاختيار مساحتك.' : 'تأكد إرسال طلب الربط؛ إيصال تاريخي. اعرض الحالة الحالية للمتابعة.'}</p> : null}{state.phase === 'uncertain' ? <Button onClick={recover}>التحقق من نتيجة الربط دون إعادة الكتابة</Button> : null}</>;
}
function StudentLinkHistory({ receipt }: {
    receipt: LinkReceipt | null;
}) {
    if (!receipt || !('id' in receipt))
        return null;
    return <p role="status">{receipt.state === 'expired' ? 'انتهت صلاحية طلبك؛ يلزم تحقق وطلب جديد.' : receipt.state === 'linked' ? 'تم ربط طلبك بسجل.' : receipt.state === 'withdrawn' ? 'طلبك السابق مسحوب.' : 'طلبك قيد مراجعة المالك؛ يمكنك سحبه.'}</p>;
}
export function AccountLinkStudentPanel({ invitation }: {
    invitation: string;
}) {
    const availability = useLinkAvailability('student');
    const [loadedReceipt, setLoadedReceipt] = useState<LinkReceipt | null>(null);
    const { ref, state, busy } = useLinkWrite('student', invitation), [phone, setPhone] = useState(''), [code, setCode] = useState(''), [challenge, setChallenge] = useState(''), [verified, setVerified] = useState(false), [confirmed, setConfirmed] = useState(false), [reading, setReading] = useState(false), [message, setMessage] = useState<string | null>(null);
    const life = useRef({ active: false, principal: principal(), epoch: 0 });
    useEffect(() => { const current = { active: true, principal: principal(), epoch: 0 }; life.current = current; setPhone(''); setCode(''); setChallenge(''); setVerified(false); setConfirmed(false); setMessage(null); return () => { current.active = false; current.epoch++; }; }, [invitation]);
    useEffect(() => {
        if (['ended', 'saving', 'saved'].includes(state.phase))
            setLoadedReceipt(null);
        if (state.phase === 'ended' || state.phase === 'saved') {
            setPhone('');
            setCode('');
            setChallenge('');
            setVerified(false);
            setConfirmed(false);
            setMessage(null);
        }
    }, [state.phase]);
    const base = '/student-enrollment/join/' + encodeURIComponent(invitation);
    async function otp(verify: boolean, statusOnly = false) {
        if (busy || reading)
            return;
        const current = life.current, n = ++current.epoch, c = new AbortController();
        const valid = () => current.active && n === current.epoch && current.principal === principal() && !c.signal.aborted;
        setReading(true);
        setMessage(null);
        setVerified(false);
        if (!verify) {
            setChallenge('');
            setCode('');
        }
        const timer = setTimeout(() => {
            if (valid()) {
                c.abort();
                current.epoch++;
                setReading(false);
                setMessage('انتهت مهلة التحقق؛ لا توجد نتيجة مؤكدة.');
            }
        }, 25000);
        try {
            const raw = await accountLinkRequest(base + (statusOnly ? '/account-link' : verify ? '/contact-otp/verify' : '/contact-otp'), statusOnly ? undefined : verify ? { phone, challenge_id: challenge, code } : { phone }, c.signal);
            if (valid()) {
                if (statusOnly) {
                    if (!raw || Object.keys(raw).join(',') !== 'request')
                        throw Error('Invalid status');
                    const receipt = raw.request === null ? null : parseLinkReceipt(raw, { kind: 'student', action: 'request', operation_id: raw.request?.id });
                    setLoadedReceipt(receipt);
                    setMessage(receipt ? 'هذه آخر حالة مقروءة لطلبك.' : 'لا يوجد طلب ربط لهذا الحساب على هذا الرابط.');
                }
                else if (verify) {
                    if (!raw || raw.verified !== true || Object.keys(raw).join(',') !== 'verified')
                        throw Error('Invalid verification');
                    setVerified(true);
                    setCode('');
                }
                else {
                    if (typeof raw?.challenge_id !== 'string' || !/^[a-f\d]{32}$/i.test(raw.challenge_id))
                        throw Error('Invalid challenge');
                    setChallenge(raw.challenge_id);
                    setMessage('أُرسل رمز التحقق عبر القناة المعتمدة.');
                }
            }
        }
        catch {
            if (valid())
                setMessage('تعذر التحقق؛ قد تكون خدمة الإرسال غير جاهزة أو البيانات غير صالحة. لم يُرسل طلب ربط.');
        }
        finally {
            clearTimeout(timer);
            if (valid())
                setReading(false);
        }
    }
    if (state.phase === 'ended')
        return <p role="alert">تغيرت الجلسة؛ افتح رابط المدرس بالحساب المطلوب.</p>;
    if (identity()?.role !== 'student' || !principal())
        return <section dir="rtl" className="mb-4 rounded border p-3">{availability !== 'verification_required' ? <LinkAvailabilityMessage availability={availability}/> : <><p>لربط سجل موجود، ادخل أولًا بحساب الطالب ثم ارجع لهذا الرابط.</p><Link to="/auth">دخول حساب الطالب</Link></>}</section>;
    const locked = busy || reading, currentReceipt = loadedReceipt ?? state.receipt, receipt = currentReceipt && 'id' in currentReceipt ? currentReceipt : null;
    if (availability !== 'verification_required')
        return <section dir="rtl" aria-label="طلب ربط حسابي بسجلي" className="mb-4 space-y-3 rounded border p-4"><h2 className="font-bold">ربط حسابي بسجلي</h2><LinkAvailabilityMessage availability={availability}/><StudentLinkHistory receipt={loadedReceipt}/><Button variant="outline" disabled={locked} onClick={() => void otp(false, true)}>عرض حالة طلب الربط الحالي</Button>{receipt?.state === 'pending' ? <Button variant="outline" disabled={locked} onClick={() => void ref.current?.apply({ kind: 'student', action: 'withdraw', operation_id: receipt.id }, { confirmed: true })}>سحب طلب الربط قبل الموافقة</Button> : null}{message ? <p role="alert">{message}</p> : null}<LinkWriteFeedback state={state} recover={() => void ref.current?.recover()}/></section>;
    return <section dir="rtl" aria-label="طلب ربط حسابي بسجلي" className="mb-4 space-y-3 rounded border border-cyan-200 p-4">
  <h2 className="font-bold">عندك سجل بالفعل عند المدرس؟</h2><p>اطلب ربط حسابك بنفس السجل بعد التحقق من هاتف الحساب. المالك يراجع الطلب والسجل المطابق؛ لا يُنشأ طالب آخر ولا تُضاف مقررات بهذه الخطوة. الطلب صالح حتى 24 ساعة أو انتهاء الرابط أيهما أقرب، ويمكن سحبه قبل الربط.</p>
  <Button variant="outline" disabled={locked} onClick={() => void otp(false, true)}>عرض حالة طلب الربط الحالي</Button>
  <StudentLinkHistory receipt={loadedReceipt}/>
  <label className="block">هاتف حساب الطالب<input aria-label="هاتف حساب الطالب للربط" dir="ltr" className="block w-full rounded border p-2" value={phone} disabled={locked} onChange={e => { setPhone(e.target.value); setChallenge(''); setCode(''); setVerified(false); setConfirmed(false); }}/></label>
  <Button disabled={locked || !phone || receipt?.state === 'pending' || receipt?.state === 'linked'} onClick={() => void otp(false)}>إرسال رمز تحقق الربط</Button>
  {challenge && !verified ? <><label className="block">رمز التحقق<input aria-label="رمز تحقق الربط" dir="ltr" value={code} disabled={locked} onChange={e => setCode(e.target.value)} className="block w-full rounded border p-2"/></label><Button disabled={locked || !code} onClick={() => void otp(true)}>تحقق من رمز الربط</Button></> : null}
  {verified ? <><label><input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>أطلب من مالك هذه المؤسسة ربط حسابي بسجلي الموجود المطابق لهاتفي.</label><Button disabled={locked || !confirmed} onClick={() => {
                if (!ref.current || !confirmed)
                    return;
                let operation_id: string;
                try {
                    operation_id = crypto.randomUUID();
                }
                catch {
                    setMessage('تعذر إنشاء معرّف آمن؛ لم يُرسل الطلب.');
                    return;
                }
                setConfirmed(false);
                void ref.current.apply({ kind: 'student', action: 'request', operation_id }, { operation_id, otp_challenge_id: challenge, confirmed: true });
            }}>إرسال طلب ربط السجل الموجود</Button></> : null}
  {receipt?.state === 'pending' ? <Button variant="outline" disabled={locked} onClick={() => void ref.current?.apply({ kind: 'student', action: 'withdraw', operation_id: receipt.id }, { confirmed: true })}>سحب طلب الربط قبل الموافقة</Button> : null}
  {message ? <p role="alert">{message}</p> : null}<LinkWriteFeedback state={state} recover={() => void ref.current?.recover()}/>
 </section>;
}
