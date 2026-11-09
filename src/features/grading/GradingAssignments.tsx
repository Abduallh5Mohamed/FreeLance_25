import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isGradingId, parseGradingAnswers, type Answers } from './question-grading';
import { useGradingWork, exactGradingObject } from './grading-work-client';
type Client = ReturnType<typeof useGradingWork>;
export function GradingWorkNotices({ client }: {
    client: Client;
}) { return <>{client.error ? <p role="alert">{client.error}</p> : null}{client.notice ? <p role="status">{client.notice}</p> : null}{client.pending ? <div><p>توجد عملية تحتاج إثبات نتيجتها. لن نكررها تلقائيًا.</p><Button disabled={client.busy} onClick={() => { void client.recover(); }}>فحص إيصال التصحيح</Button></div> : null}</>; }
type Management = {
    assignment: {
        id: string;
        assignee_user_id: string;
        rubric_id: string;
        status: 'active' | 'revoked';
        version: number;
        authority_current: boolean;
    } | null;
    candidates: Array<{
        id: string;
        name: string;
    }>;
    rubrics: Array<{
        id: string;
        revision: number;
    }>;
};
export function parseGradingManagement(raw: any): Management {
    if (!exactGradingObject(raw, ['assignment', 'candidates', 'rubrics']) || !Array.isArray(raw.candidates) || raw.candidates.length > 100 || !Array.isArray(raw.rubrics) || raw.rubrics.length > 20)
        throw Error('Invalid management data');
    if (raw.assignment !== null && (!exactGradingObject(raw.assignment, ['id', 'assignee_user_id', 'rubric_id', 'status', 'version', 'authority_current']) || ![raw.assignment.id, raw.assignment.assignee_user_id, raw.assignment.rubric_id].every(isGradingId) || !['active', 'revoked'].includes(raw.assignment.status) || typeof raw.assignment.authority_current !== 'boolean' || !Number.isSafeInteger(raw.assignment.version) || raw.assignment.version < 0))
        throw Error('Invalid assignment');
    for (const r of raw.candidates)
        if (!exactGradingObject(r, ['id', 'name']) || !isGradingId(r.id) || typeof r.name !== 'string' || r.name.length > 255)
            throw Error('Invalid candidate');
    for (const r of raw.rubrics)
        if (!exactGradingObject(r, ['id', 'revision']) || !isGradingId(r.id) || !Number.isSafeInteger(r.revision) || r.revision < 1)
            throw Error('Invalid rubric');
    if (new Set(raw.candidates.map((r: any) => r.id)).size !== raw.candidates.length || new Set(raw.rubrics.map((r: any) => r.id)).size !== raw.rubrics.length)
        throw Error('Duplicate choices');
    return raw;
}
export function GradingAssignmentManager({ questionId, disabled = false }: {
    questionId: string;
    disabled?: boolean;
}) {
    const [data, setData] = useState<Management | null>(null), [target, setTarget] = useState(''), [rubric, setRubric] = useState(''), [loading, setLoading] = useState(false), [ended, setEnded] = useState(false);
    const generation = useRef(0), clear = useCallback(() => { generation.current++; setData(null); setEnded(true); }, []), client = useGradingWork(clear);
    const load = async () => { const ticket = ++generation.current; setLoading(true); setData(null); try {
        const r = parseGradingManagement(await client.request('/grading/questions/' + questionId + '/assignment'));
        if (ticket !== generation.current)
            return;
        setData(r);
        setTarget(r.assignment?.assignee_user_id ?? '');
        setRubric(r.assignment?.rubric_id ?? '');
    }
    catch {
        if (ticket === generation.current)
            client.setError('تعذر إثبات تكليف السؤال؛ لا نعرض تكليفًا قديمًا كحالي.');
    }
    finally {
        if (ticket === generation.current)
            setLoading(false);
    } };
    useEffect(() => { void load(); return () => { generation.current++; }; }, []);
    if (ended)
        return <p role="alert">تغيرت الجلسة؛ أُخفي تكليف السؤال.</p>;
    const blocked = disabled || loading || client.busy || client.locked;
    return <section aria-label="تكليف مصحح السؤال" className="space-y-3 rounded border p-3"><h4 className="font-semibold">تكليف مصحح بالسؤال</h4><p>للمدرس المسؤول عن المقرر فقط. اختيار حساب مدرس نشط داخل المؤسسة لا يمنحه اعتماد النتيجة أو إدارة الطلاب. المعيار المثبت لا يتبدل بإصدار أحدث تلقائيًا.</p><GradingWorkNotices client={client}/><Button variant="outline" disabled={client.busy || disabled} onClick={() => { void load(); }}>تحديث تكليف السؤال</Button>
 {data ? <><p>{data.assignment ? (data.assignment.authority_current ? 'تكليف نشط' : data.assignment.status === 'active' ? 'يحتاج تأكيد المدرس المسؤول الحالي' : 'تكليف مسحوب') + ' — إصدار ' + data.assignment.version : 'لم يكلّف مصحح بهذا السؤال بعد.'}</p><label>المصحح<select className="m-2 rounded border p-2" aria-label="مصحح السؤال" value={target} disabled={blocked} onChange={e => setTarget(e.target.value)}><option value="">اختر حساب مدرس</option>{data.candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>إصدار المعيار<select className="m-2 rounded border p-2" aria-label="معيار التكليف" value={rubric} disabled={blocked} onChange={e => setRubric(e.target.value)}><option value="">اختر إصدارًا محفوظًا</option>{data.rubrics.map(r => <option value={r.id} key={r.id}>إصدار {r.revision}</option>)}</select></label>
 <Button disabled={blocked || !data.candidates.some(c => c.id === target) || !data.rubrics.some(r => r.id === rubric)} onClick={() => { const old = data.assignment; void (async () => { if (await client.write('/grading/questions/' + questionId + '/assignment', { expected_version: old?.version ?? null, assignee_user_id: target, rubric_id: rubric }, { kind: 'assignment.saved', assignment_id: null, question_ref: questionId, resource_id: old?.id ?? null, version: old ? old.version + 1 : 0 }))
            await load(); })(); }}>تأكيد تكليف أو تحويل المصحح</Button>
 <Button variant="outline" disabled={blocked || data.assignment?.status !== 'active'} onClick={() => { const old = data.assignment!; void (async () => { if (await client.write('/grading/questions/' + questionId + '/assignment/revoke', { expected_version: old.version }, { kind: 'assignment.revoked', assignment_id: null, question_ref: questionId, resource_id: old.id, version: old.version + 1 }))
            await load(); })(); }}>سحب تكليف المصحح</Button></> : null}</section>;
}
export type AssignedQuestion = {
    id: string;
    question_ref: string;
    version: number;
    rubric_id: string;
    label: string;
    criteria: Array<{
        key: string;
        label: string;
        max_points: string;
    }>;
    total_points: string;
};
export function parseAssignedQuestions(raw: any): {
    assignments: AssignedQuestion[];
    next_cursor: string | null;
} {
    if (!exactGradingObject(raw, ['assignments', 'next_cursor']) || !Array.isArray(raw.assignments) || raw.assignments.length > 25 || raw.next_cursor !== null && !isGradingId(raw.next_cursor))
        throw Error('Invalid assigned list');
    for (const a of raw.assignments) {
        if (!exactGradingObject(a, ['id', 'question_ref', 'version', 'rubric_id', 'label', 'criteria', 'total_points']) || ![a.id, a.question_ref, a.rubric_id].every(isGradingId) || !Number.isSafeInteger(a.version) || a.version < 0 || typeof a.label !== 'string' || a.label.length > 180 || typeof a.total_points !== 'string' || !/^\d+\.\d{2}$/.test(a.total_points) || !Array.isArray(a.criteria) || !a.criteria.length || a.criteria.length > 20)
            throw Error('Invalid assigned question');
        let total = 0;
        const keys = new Set();
        for (const c of a.criteria) {
            if (!exactGradingObject(c, ['key', 'label', 'max_points']) || typeof c.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(c.key) || keys.has(c.key) || typeof c.label !== 'string' || !c.label.trim() || c.label.length > 200 || typeof c.max_points !== 'string' || !/^\d+\.\d{2}$/.test(c.max_points) || Number(c.max_points) <= 0)
                throw Error('Invalid assigned criterion');
            keys.add(c.key);
            total += Math.round(Number(c.max_points) * 100);
        }
        if (total !== Math.round(Number(a.total_points) * 100))
            throw Error('Invalid assigned total');
    }
    if (new Set(raw.assignments.map((a: any) => a.id)).size !== raw.assignments.length)
        throw Error('Duplicate assignment');
    return raw;
}
export function AssignedGrading() { const [open, setOpen] = useState(false); return <section aria-label="تصحيح الأسئلة المسندة لي" dir="rtl" className="mb-4 rounded border p-4"><h2 className="font-semibold">الأسئلة المسندة لي للتصحيح</h2><Button variant="outline" onClick={() => setOpen(v => !v)}>{open ? 'إغلاق التصحيح المسند' : 'فتح التصحيح المسند لي'}</Button>{open ? <AssignedBody /> : null}</section>; }
function AssignedBody() {
    const [list, setList] = useState<AssignedQuestion[]>([]), [cursor, setCursor] = useState<string | null>(null), [chosen, setChosen] = useState<AssignedQuestion | null>(null), [page, setPage] = useState<Answers | null>(null), [loading, setLoading] = useState(false), [ended, setEnded] = useState(false);
    const generation = useRef(0), clear = useCallback(() => { generation.current++; setList([]); setChosen(null); setPage(null); setEnded(true); }, []), client = useGradingWork(clear);
    const discover = async (after: string | null = null) => { const ticket = ++generation.current; setLoading(true); setChosen(null); setPage(null); setList([]); try {
        const r = parseAssignedQuestions(await client.request('/grading-work/assignments' + (after ? '?after=' + after : '')));
        if (ticket === generation.current) {
            setList(r.assignments);
            setCursor(r.next_cursor);
        }
    }
    catch {
        if (ticket === generation.current)
            client.setError('تعذرت قراءة التكليفات الحالية. لم نستخدم صلاحية عامة بديلة.');
    }
    finally {
        if (ticket === generation.current)
            setLoading(false);
    } };
    const answers = async (a: AssignedQuestion, after: string | null = null) => { const ticket = ++generation.current; setChosen(a); setPage(null); setLoading(true); try {
        const r = parseGradingAnswers(await client.request('/grading-work/' + a.id + '/questions/' + a.question_ref + '/answers' + (after ? '?after=' + after : '')), a.question_ref);
        if (ticket === generation.current)
            setPage(r);
    }
    catch {
        if (ticket === generation.current) {
            setPage(null);
            client.setError('لم تعد إجابات هذا التكليف متاحة؛ حدّث التكليفات.');
        }
    }
    finally {
        if (ticket === generation.current)
            setLoading(false);
    } };
    useEffect(() => { void discover(); return () => { generation.current++; }; }, []);
    useEffect(() => { const hide = () => { generation.current++; setPage(null); setChosen(null); }; const timer = chosen ? setTimeout(hide, 60000) : undefined; const visibility = () => { if (document.visibilityState === 'hidden')
        hide(); }; window.addEventListener('focus', hide); document.addEventListener('visibilitychange', visibility); return () => { if (timer !== undefined)
        clearTimeout(timer); window.removeEventListener('focus', hide); document.removeEventListener('visibilitychange', visibility); }; }, [chosen?.id]);
    if (ended)
        return <p role="alert">تغيرت الجلسة؛ أُخفيت إجابات التكليف.</p>;
    const blocked = loading || client.busy || client.locked;
    return <div className="space-y-3"><p>تراجع السؤال والمعيار المثبتين في تكليفك فقط. الحفظ يضيف مراجعة، والاعتماد النهائي للمدرس المسؤول عن المقرر.</p><GradingWorkNotices client={client}/><Button disabled={client.busy} onClick={() => { void discover(); }}>تحديث تكليفاتي</Button><select className="m-2 rounded border p-2" aria-label="السؤال المسند لي" value={chosen?.id ?? ''} disabled={blocked} onChange={e => { const a = list.find(a => a.id === e.target.value); if (a)
        void answers(a); }}><option value="">اختر سؤالًا مسندًا</option>{list.map((a, i) => <option key={a.id} value={a.id}>{i + 1} — {a.label}</option>)}</select><Button disabled={blocked || !cursor} variant="outline" onClick={() => { void discover(cursor); }}>تكليفات تالية</Button>
 {chosen ? <Button variant="outline" disabled={client.busy} onClick={() => { void answers(chosen); }}>تحديث إجابات التكليف</Button> : null}{chosen && page ? <><h3 className="font-semibold whitespace-pre-wrap">{page.question.text}</h3><ul>{page.answers.map((answer, index) => <li key={answer.attempt_id + ':' + answer.version} className="my-3 rounded border p-3"><h4>إجابة {index + 1} — الأسماء مخفية</h4><p>{answer.revision === null ? 'لم تُحفظ مراجعة بعد.' : 'آخر مراجعة محفوظة: ' + answer.awarded_points + ' — إصدار ' + answer.revision}</p><p className="whitespace-pre-wrap">{answer.unsupported ? 'نوع إجابة غير مدعوم؛ لم نفتح ملفًا خارجيًا.' : answer.response}</p><form onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget), a = chosen, ticket = generation.current; void (async () => { if (await client.write('/grading-work/' + a.id + '/attempts/' + answer.attempt_id + '/grade', { expected_version: answer.version, question_ref: a.question_ref, assignment_version: a.version, marks: a.criteria.map(c => ({ key: c.key, points: String(form.get(c.key) ?? '') })), feedback: String(form.get('feedback') ?? '').trim() || null }, { kind: 'grade', assignment_id: a.id, question_ref: a.question_ref, resource_id: answer.attempt_id, version: answer.version + 1 }) && ticket === generation.current)
        await answers(a); })(); }}><fieldset disabled={blocked || answer.unsupported}>{chosen.criteria.map((c, i) => <label className="block" key={c.key}>{c.label} — الحد {c.max_points}<input required name={c.key} aria-label={'درجة البند ' + (i + 1) + ' لإجابة ' + (index + 1)} inputMode="decimal" className="m-2 rounded border p-2"/></label>)}<label>تعليق المصحح<textarea name="feedback" aria-label={'تعليق إجابة ' + (index + 1)} maxLength={2000} className="block w-full rounded border p-2"/></label><Button>حفظ مراجعة الإجابة {index + 1}</Button></fieldset></form></li>)}</ul>{!page.answers.length ? <p>لا توجد إجابات معلقة للمراجعة في هذه الصفحة.</p> : null}<Button disabled={blocked || !page.next_cursor} variant="outline" onClick={() => { void answers(chosen, page.next_cursor); }}>إجابات التكليف التالية</Button></> : null}</div>;
}
