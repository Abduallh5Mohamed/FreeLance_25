import { useEffect, useRef, useState } from 'react';
import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '@/lib/api-http';
import { boundedRequest } from '@/lib/bounded-request';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import { subscribeSessionChange } from '@/lib/session-events';
import { isGradingId, parseGradingReceipt } from './question-grading';
export const exactGradingObject = (x: any, k: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...k].sort().join(',');
export type GradingWorkIntent = {
    operation_id: string;
    kind: 'grade' | 'assignment.saved' | 'assignment.revoked' | 'attempt.reopened';
    assignment_id: string | null;
    question_ref: string | null;
    resource_id: string | null;
    version: number;
};
export function parseWorkIntent(i: any): GradingWorkIntent {
    if (!exactGradingObject(i, ['operation_id', 'kind', 'assignment_id', 'question_ref', 'resource_id', 'version']) || !isGradingId(i.operation_id) || !['grade', 'assignment.saved', 'assignment.revoked', 'attempt.reopened'].includes(i.kind) || ![i.assignment_id, i.question_ref, i.resource_id].every(v => v === null || isGradingId(v)) || !Number.isSafeInteger(i.version) || i.version < 0 || i.kind === 'grade' && (!i.assignment_id || !i.question_ref || !i.resource_id))
        throw Error('Invalid grading intent');
    return i;
}
export function parseWorkReceipt(raw: any, i: GradingWorkIntent) {
    if (i.kind === 'grade') {
        const r = parseGradingReceipt(raw);
        if (r.operation_id !== i.operation_id || r.kind !== 'grade' || r.question_ref !== i.question_ref || r.attempt_id !== i.resource_id || r.attempt_version !== i.version)
            throw Error('Mismatched grade receipt');
        return r;
    }
    const keys = i.kind === 'attempt.reopened' ? ['operation_id', 'kind', 'resource_id', 'version', 'old_score', 'gradebook_withdrawn'] : ['operation_id', 'kind', 'question_ref', 'resource_id', 'version'];
    if (!exactGradingObject(raw, keys) || raw.operation_id !== i.operation_id || raw.kind !== i.kind || raw.version !== i.version || !isGradingId(raw.resource_id) || i.resource_id && raw.resource_id !== i.resource_id || i.kind !== 'attempt.reopened' && raw.question_ref !== i.question_ref || i.kind === 'attempt.reopened' && (typeof raw.old_score !== 'string' || !/^\d+\.\d{2}$/.test(raw.old_score) || typeof raw.gradebook_withdrawn !== 'boolean'))
        throw Error('Invalid grading control receipt');
    return raw;
}
export function useGradingWork(onEnd: () => void) {
    const principal = useRef(readCourseSessionPrincipal(localStorage)), dead = useRef(false), working = useRef(false), flights = useRef(new Set<AbortController>()), storeKey = useRef('');
    const [busy, setBusy] = useState(false), [pending, setPending] = useState<GradingWorkIntent | null>(null), [locked, setLocked] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
    const sync = () => { if (dead.current)
        return; try {
        const raw = sessionStorage.getItem(storeKey.current);
        setPending(raw ? parseWorkIntent(JSON.parse(raw)) : null);
        setLocked(!!raw);
    }
    catch {
        setLocked(true);
        setError('تعذرت قراءة علامة الاسترجاع؛ الكتابة متوقفة.');
    } };
    const stop = () => { if (dead.current)
        return; dead.current = true; flights.current.forEach(c => c.abort()); onEnd(); setNotice(''); setError('تغيرت الجلسة؛ أُخفيت بيانات التصحيح.'); };
    useEffect(() => { dead.current = false; try {
        const actor = JSON.parse(localStorage.getItem('currentUser') ?? 'null')?.id;
        if (!isGradingId(actor))
            throw Error('Missing actor');
        storeKey.current = 'grading-work-intent:' + actor;
        const raw = sessionStorage.getItem(storeKey.current);
        if (raw) {
            setPending(parseWorkIntent(JSON.parse(raw)));
            setLocked(true);
        }
    }
    catch {
        setLocked(true);
        setError('تعذرت قراءة علامة الاسترجاع؛ الكتابة متوقفة.');
    } const off = subscribeSessionChange(stop), storage = (e: StorageEvent) => { if (e.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(e.key))
        stop(); }; window.addEventListener('storage', storage); return () => { dead.current = true; flights.current.forEach(c => c.abort()); off(); window.removeEventListener('storage', storage); }; }, [onEnd]);
    async function request(path: string, body?: unknown) { if (dead.current || !principal.current || principal.current !== readCourseSessionPrincipal(localStorage)) {
        stop();
        throw Error('Session changed');
    } if (!/^\/(grading|grading-work)\/[a-zA-Z0-9/?=&._-]+$/.test(path))
        throw Error('Invalid grading path'); const c = new AbortController(); flights.current.add(c); try {
        return await boundedRequest(c, async () => { const r = await authenticatedApiFetch('/tenants/me/catalog' + path, { signal: c.signal, ...body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }), raw = await readAuthenticatedApiJson(r); if (dead.current || principal.current !== readCourseSessionPrincipal(localStorage)) {
            stop();
            throw Error('Session changed');
        } if (!r.ok)
            throw new ApiRequestError('Grading refused', r.status); return raw; });
    }
    finally {
        flights.current.delete(c);
    } }
    useEffect(() => { window.addEventListener('grading-work-intent-change', sync); return () => window.removeEventListener('grading-work-intent-change', sync); }, []);
    function cleanup() { sessionStorage.removeItem(storeKey.current); if (sessionStorage.getItem(storeKey.current) !== null)
        throw Error('Cleanup failed'); setPending(null); setLocked(false); window.dispatchEvent(new Event('grading-work-intent-change')); }
    async function write(path: string, body: any, intent: Omit<GradingWorkIntent, 'operation_id'>) {
        if (dead.current || working.current || locked)
            return false;
        let i: GradingWorkIntent;
        try {
            if (sessionStorage.getItem(storeKey.current) !== null)
                throw Error('Other intent');
            i = parseWorkIntent({ ...intent, operation_id: crypto.randomUUID() });
            sessionStorage.setItem(storeKey.current, JSON.stringify(i));
            if (sessionStorage.getItem(storeKey.current) !== JSON.stringify(i))
                throw Error('Storage refused');
        }
        catch {
            setLocked(true);
            setError('تعذر تأمين علامة العملية؛ لم نرسل حفظًا.');
            return false;
        }
        working.current = true;
        setBusy(true);
        setPending(i);
        setLocked(true);
        window.dispatchEvent(new Event('grading-work-intent-change'));
        setError('');
        setNotice('');
        try {
            const raw = await request(path, { ...body, operation_id: i.operation_id });
            parseWorkReceipt(i.kind === 'grade' ? raw.operation : raw.receipt, i);
            if (dead.current)
                return false;
            setNotice('الحفظ مؤكد بإيصال تاريخي. حدّث البيانات لمعرفة الحالة الحالية.');
            try {
                cleanup();
            }
            catch {
                setError('الحفظ مؤكد لكن العلامة لم تنظف؛ لا تعِد الكتابة.');
            }
            return true;
        }
        catch (e) {
            if (dead.current)
                return false;
            if (e instanceof ApiRequestError && [400, 401, 403, 404, 409].includes(e.status)) {
                try {
                    cleanup();
                }
                catch { }
                setError('رفض الخادم العملية. أعد التحقق من التكليف والصلاحية والإصدار.');
            }
            else
                setError('نتيجة الحفظ غير محسومة. افحص الإيصال دون إعادة إرسال الحفظ.');
            return false;
        }
        finally {
            working.current = false;
            if (!dead.current)
                setBusy(false);
        }
    }
    async function recover() { if (dead.current || working.current || !pending)
        return; working.current = true; setBusy(true); try {
        const p = pending.kind === 'grade' ? '/grading-work/' + pending.assignment_id + '/operations/' + pending.operation_id : '/grading/control-operations/' + pending.operation_id, raw = await request(p);
        parseWorkReceipt(pending.kind === 'grade' ? raw.operation : raw.receipt, pending);
        if (dead.current)
            return;
        setNotice('تأكد الحفظ من الإيصال دون إعادة الكتابة. حدّث القراءة الحالية.');
        cleanup();
        setError('');
    }
    catch {
        if (!dead.current)
            setError('لم يثبت الإيصال أو لم تعد الصلاحية متاحة؛ العلامة باقية ولن نكرر الكتابة.');
    }
    finally {
        working.current = false;
        if (!dead.current)
            setBusy(false);
    } }
    return { request, write, recover, busy, locked, pending, notice, error, setError };
}
