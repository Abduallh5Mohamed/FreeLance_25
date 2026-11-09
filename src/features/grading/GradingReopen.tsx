import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isGradingId } from './question-grading';
import { useGradingWork, exactGradingObject } from './grading-work-client';
import { GradingWorkNotices } from './GradingAssignments';
type Final = {
    id: string;
    score: string;
    version: number;
    graded_at: string;
    student_name: string | null;
};
type Preview = {
    attempt_id: string;
    version: number;
    old_score: string;
    gradebook_will_withdraw: boolean;
    review_token: string;
};
export function GradingReopen({ versionId, disabled = false }: {
    versionId: string;
    disabled?: boolean;
}) {
    const [items, setItems] = useState<Final[]>([]), [cursor, setCursor] = useState<string | null>(null), [chosen, setChosen] = useState(''), [preview, setPreview] = useState<Preview | null>(null), [reason, setReason] = useState(''), [loading, setLoading] = useState(false), [ended, setEnded] = useState(false);
    const epoch = useRef(0), clear = useCallback(() => { epoch.current++; setItems([]); setPreview(null); setChosen(''); setReason(''); setEnded(true); }, []), client = useGradingWork(clear);
    const load = async (after: string | null = null) => { const ticket = ++epoch.current; setItems([]); setPreview(null); setChosen(''); setLoading(true); try {
        const r = await client.request('/grading/versions/' + versionId + '/finalized' + (after ? '?after=' + after : ''));
        if (!exactGradingObject(r, ['items', 'next_cursor']) || !Array.isArray(r.items) || r.items.length > 25 || r.next_cursor !== null && !isGradingId(r.next_cursor) || r.items.some((i: any) => !exactGradingObject(i, ['id', 'score', 'version', 'graded_at', 'student_name']) || i.student_name !== null && (typeof i.student_name !== 'string' || i.student_name.length > 255) || !isGradingId(i.id) || typeof i.score !== 'string' || !/^\d+\.\d{2}$/.test(i.score) || !Number.isSafeInteger(i.version) || i.version < 1 || typeof i.graded_at !== 'string' || !Number.isFinite(Date.parse(i.graded_at))))
            throw Error('Invalid final list');
        if (ticket === epoch.current) {
            setItems(r.items);
            setCursor(r.next_cursor);
        }
    }
    catch {
        if (ticket === epoch.current)
            client.setError('تعذرت قراءة النتائج النهائية الحالية.');
    }
    finally {
        if (ticket === epoch.current)
            setLoading(false);
    } };
    useEffect(() => { void load(); return () => { epoch.current++; }; }, []);
    const inspect = async (id: string) => { const ticket = ++epoch.current; setPreview(null); setChosen(id); setLoading(true); try {
        const r = await client.request('/grading/attempts/' + id + '/reopen-preview');
        if (!exactGradingObject(r, ['attempt_id', 'version', 'old_score', 'gradebook_will_withdraw', 'review_token']) || r.attempt_id !== id || !Number.isSafeInteger(r.version) || r.version < 1 || typeof r.old_score !== 'string' || !/^\d+\.\d{2}$/.test(r.old_score) || typeof r.gradebook_will_withdraw !== 'boolean' || typeof r.review_token !== 'string' || !/^[a-f\d]{64}$/.test(r.review_token))
            throw Error('Invalid impact');
        if (ticket === epoch.current)
            setPreview(r);
    }
    catch {
        if (ticket === epoch.current)
            client.setError('تعذرت معاينة الأثر أو تغيّر مصدر سجل الدرجات؛ لم نفتح النتيجة.');
    }
    finally {
        if (ticket === epoch.current)
            setLoading(false);
    } };
    if (ended)
        return <p role="alert">تغيرت الجلسة؛ أُخفيت معاينة إعادة التصحيح.</p>;
    const blocked = disabled || loading || client.busy || client.locked;
    return <section aria-label="إعادة مراجعة نتيجة نهائية" className="my-3 space-y-3 rounded border p-3"><h3 className="font-semibold">إعادة مراجعة نتيجة نهائية</h3><p>للمدرس المسؤول فقط، بعد معاينة وسبب مكتوب. تصبح النتيجة معلقة للمراجعة وتُسحب درجتها المثبتة من سجل الدرجات في نفس المعاملة. تبقى المراجعات والتاريخ محفوظين؛ لا تعديل لنسخة الامتحان أو نشر للأسرة.</p><GradingWorkNotices client={client}/><Button variant="outline" disabled={client.busy || disabled} onClick={() => { void load(); }}>تحديث النتائج النهائية لهذه النسخة</Button><select className="m-2 rounded border p-2" aria-label="النتيجة النهائية للمراجعة" value={chosen} disabled={blocked} onChange={e => { if (items.some(i => i.id === e.target.value))
        void inspect(e.target.value); }}><option value="">اختر نتيجة نهائية</option>{items.map((i, n) => <option key={i.id} value={i.id}>{i.student_name ?? 'سجل طالب غير متاح'} — نتيجة {n + 1}: {i.score} — {new Date(i.graded_at).toLocaleString('ar-EG')}</option>)}</select><Button variant="outline" disabled={blocked || !cursor} onClick={() => { void load(cursor); }}>نتائج نهائية تالية</Button>
 {preview ? <><p>الدرجة الحالية {preview.old_score}. {preview.gradebook_will_withdraw ? 'ستُسحب من سجل الدرجات حتى اعتماد التصحيح مجددًا.' : 'لم تكن مرتبطة بدرجة مثبتة في سجل الدرجات؛ لن نحذف صفًا مفترضًا.'}</p><label>سبب إعادة المراجعة<textarea className="block w-full rounded border p-2" aria-label="سبب إعادة مراجعة النهائي" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} disabled={blocked}/></label><Button disabled={blocked || !reason.trim()} onClick={() => { if (!window.confirm('إعادة النتيجة للمراجعة وسحب درجتها المثبتة حتى الاعتماد مجددًا؟'))
        return; const p = preview; void (async () => { if (await client.write('/grading/attempts/' + p.attempt_id + '/reopen', { expected_version: p.version, review_token: p.review_token, reason: reason.trim() }, { kind: 'attempt.reopened', assignment_id: null, question_ref: null, resource_id: p.attempt_id, version: p.version + 1 })) {
        setReason('');
        await load();
    } })(); }}>تأكيد إعادة النتيجة للمراجعة</Button></> : null}</section>;
}
