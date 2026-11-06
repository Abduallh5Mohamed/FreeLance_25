import { ApiRequestError, authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';
export type QuizStatus = 'in_progress' | 'pending_review' | 'graded' | 'expired';
export type Answer = string | string[] | null;
export interface QuizQuestion {
    id: string;
    position: number;
    question_type: 'single_choice' | 'multiple_choice' | 'true_false' | 'essay';
    question_text: string;
    options: string[];
    points: number;
}
export interface QuizSummary {
    id: string;
    status: QuizStatus;
    started_at: string;
    deadline_at: string;
}
export interface QuizAttempt extends QuizSummary {
    questions: QuizQuestion[];
    answers: Record<string, Answer>;
    score: number | null;
    manual_required: boolean;
}
const record = (x: any): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: any, keys: string[]) => record(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const uuid = (x: any) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const iso = (x: any) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const bad = () => Error('Invalid catalog quiz response');
const summary = (x: any): QuizSummary => {
    if (!record(x) || !uuid(x.id) || !['in_progress', 'pending_review', 'graded', 'expired'].includes(x.status) || !iso(x.started_at) || !iso(x.deadline_at) || Date.parse(x.deadline_at) < Date.parse(x.started_at))
        throw bad();
    return { id: x.id, status: x.status, started_at: x.started_at, deadline_at: x.deadline_at };
};
export function parseQuizRecovery(raw: any): QuizSummary | null {
    if (exact(raw, ['attempt']) && raw.attempt === null)
        return null;
    if (!exact(raw, ['attempt', 'unchanged']) || typeof raw.unchanged !== 'boolean' || !exact(raw.attempt, ['id', 'status', 'started_at', 'deadline_at']))
        throw bad();
    return summary(raw.attempt);
}
export function quizAnswers(questions: QuizQuestion[], raw: any): Record<string, Answer> {
    if (!record(raw) || Object.keys(raw).some(key => !questions.some(q => q.id === key)))
        throw bad();
    const result: Record<string, Answer> = {};
    for (const q of questions) {
        const value = raw[q.id] ?? null;
        if (value !== null) {
            const options = q.question_type === 'true_false' ? ['true', 'false'] : q.options;
            if (q.question_type === 'multiple_choice') {
                if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !options.includes(v)) || new Set(value).size !== value.length)
                    throw bad();
            }
            else if (typeof value !== 'string' || (q.question_type === 'essay' ? value.length > 10000 : !options.includes(value)))
                throw bad();
        }
        result[q.id] = Array.isArray(value) ? [...value] : value;
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > 131072)
        throw bad();
    return result;
}
export function parseQuizAttempt(raw: any, id: string): QuizAttempt {
    const keys = ['id', 'exam_id', 'exam_version_id', 'student_enrollment_id', 'status', 'started_at', 'deadline_at', 'submitted_at', 'auto_submitted', 'auto_score', 'score', 'manual_required', 'graded_at', 'passed', 'questions', 'answers'];
    if (!exact(raw, keys) || raw.id !== id || !uuid(raw.exam_id) || !uuid(raw.exam_version_id) || typeof raw.student_enrollment_id !== 'string' || !raw.student_enrollment_id || raw.student_enrollment_id.length > 64 || !Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > 200)
        throw bad();
    if (typeof raw.auto_submitted !== 'boolean' || typeof raw.manual_required !== 'boolean' || ![null, true, false].includes(raw.passed) || [raw.auto_score, raw.score].some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v))) || [raw.submitted_at, raw.graded_at].some(v => v !== null && !iso(v)))
        throw bad();
    const questions: QuizQuestion[] = raw.questions.map((q: any) => {
        if (!exact(q, ['id', 'position', 'question_type', 'question_text', 'options', 'points']) || !uuid(q.id) || !Number.isInteger(q.position) || q.position < 1 || q.position > 200 || !['single_choice', 'multiple_choice', 'true_false', 'essay'].includes(q.question_type) || typeof q.question_text !== 'string' || q.question_text.length > 10000 || !Array.isArray(q.options) || q.options.length > 50 || q.options.some((v: any) => typeof v !== 'string' || v.length > 1000) || new Set(q.options).size !== q.options.length || typeof q.points !== 'number' || !Number.isFinite(q.points) || q.points < 0)
            throw bad();
        if (['single_choice', 'multiple_choice'].includes(q.question_type) && q.options.length < 2 || ['true_false', 'essay'].includes(q.question_type) && q.options.length)
            throw bad();
        return { id: q.id, position: q.position, question_type: q.question_type, question_text: q.question_text, options: [...q.options], points: q.points };
    });
    if (new Set(questions.map(q => q.id)).size !== questions.length || new Set(questions.map(q => q.position)).size !== questions.length)
        throw bad();
    return { ...summary(raw), questions, answers: quizAnswers(questions, raw.answers), score: raw.score, manual_required: raw.manual_required };
}
async function transport(path: string, signal: AbortSignal, body?: unknown) {
    const response = await authenticatedApiFetch('/exam-versions' + path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await readAuthenticatedApiJson(response);
    if (!response.ok)
        throw new ApiRequestError('Quiz request failed', response.status, record(data) && typeof data.code === 'string' ? data.code : undefined);
    return data;
}
export function catalogQuizTransport(courseId: string, lessonId: string, contentId: string) {
    if (![courseId, lessonId, contentId].every(uuid))
        throw bad();
    const base = `/catalog/courses/${courseId}/lessons/${lessonId}/activities/${contentId}/attempt`;
    const attemptPath = (id: string) => { if (!uuid(id))
        throw bad(); return '/attempts/' + id; };
    return {
        recover: (signal: AbortSignal) => transport(base, signal),
        start: (signal: AbortSignal) => transport(base, signal, {}),
        read: (id: string, signal: AbortSignal) => transport(attemptPath(id), signal),
        save: (id: string, answers: Record<string, Answer>, signal: AbortSignal) => transport(attemptPath(id) + '/autosave', signal, { answers }),
        submit: (id: string, answers: Record<string, Answer>, signal: AbortSignal) => transport(attemptPath(id) + '/submit', signal, { answers }),
    };
}
export interface QuizState {
    phase: 'loading' | 'idle' | 'ready' | 'busy' | 'uncertain' | 'error' | 'denied' | 'session-ended';
    attempt: QuizAttempt | null;
    draft: Record<string, Answer>;
    dirty: boolean;
    autoSave: boolean;
    message: string | null;
}
export const initialQuizState = (): QuizState => ({ phase: 'loading', attempt: null, draft: {}, dirty: false, autoSave: false, message: null });
export function createCatalogQuiz(deps: ReturnType<typeof catalogQuizTransport> & {
    readPrincipal(): string | null;
    subscribeSession(fn: () => void): () => void;
}) {
    let state = initialQuizState(), disposed = false, epoch = 0, abort: AbortController | null = null, knownAttemptId: string | null = null;
    const principal = deps.readPrincipal(), listeners = new Set<(state: QuizState) => void>();
    const set = (next: QuizState) => { state = next; if (!disposed)
        listeners.forEach(fn => fn(state)); };
    const invalidate = () => { if (disposed)
        return; epoch++; abort?.abort(); set({ ...initialQuizState(), phase: 'session-ended', message: 'تغيّرت الجلسة. افتح الكويز من مساحة الطالب الحالية.' }); };
    const current = (ticket: number) => { if (disposed || ticket !== epoch)
        return false; if (!principal || principal !== deps.readPrincipal()) {
        invalidate();
        return false;
    } return true; };
    const unsubscribe = deps.subscribeSession(invalidate);
    const denied = (e: unknown) => e instanceof ApiRequestError && ([401, 404].includes(e.status) || e.status === 403 && !['EXPIRED', 'expired', 'closed', 'not_open', 'late'].includes(e.code ?? '') || e.code === 'CLIENT_SESSION_CHANGED');
    const fail = (e: unknown, write: boolean) => {
        if (denied(e)) {
            set({ ...initialQuizState(), phase: 'denied', message: 'لم يعد الوصول لهذا الكويز مسموحًا. حدّث مسار التعلّم.' });
            return;
        }
        if (e instanceof ApiRequestError && e.code === 'CATALOG_ATTEMPT_UNAVAILABLE') {
            set({ ...state, phase: 'error', autoSave: false, message: 'الكويز غير جاهز للتشغيل حاليًا. افحص الحالة لاحقًا؛ لن ننتقل إلى مسار آخر.' });
            return;
        }
        set({ ...state, phase: write ? 'uncertain' : 'error', message: write ? 'تعذّر تأكيد نتيجة العملية. افحص حالة الخادم قبل أي إعادة؛ لن نكرر الكتابة تلقائيًا.' : 'تعذّر قراءة الكويز. أعد فحص الحالة؛ لم تبدأ محاولة جديدة.' });
    };
    async function run(kind: 'recover' | 'start' | 'save' | 'submit') {
        if (disposed || ['busy', 'session-ended', 'denied'].includes(state.phase) || !current(epoch))
            return;
        if (kind === 'start' && state.phase !== 'idle' || (kind === 'save' || kind === 'submit') && (state.phase !== 'ready' || state.attempt?.status !== 'in_progress'))
            return;
        const previous = state, ticket = ++epoch, operation = new AbortController();
        abort = operation;
        const timer = setTimeout(() => operation.abort(), 20000);
        const write = kind !== 'recover';
        let confirmedWrite: 'start' | 'submit' | null = null;
        set({ ...state, phase: 'busy', message: null });
        try {
            if (kind === 'save' || kind === 'submit') {
                const attempt = previous.attempt!, payload = quizAnswers(attempt.questions, previous.draft);
                const raw = await deps[kind](attempt.id, payload, operation.signal);
                if (!current(ticket))
                    return;
                if (operation.signal.aborted)
                    throw bad();
                if (kind === 'save') {
                    if (!exact(raw, ['ok', 'saved']) || raw.ok !== true || raw.saved !== Object.keys(payload).length)
                        throw bad();
                    set({ ...previous, phase: 'ready', attempt: { ...attempt, answers: payload }, draft: payload, dirty: false, autoSave: false, message: 'تم تأكيد حفظ الإجابات على الخادم.' });
                    return;
                }
                if (!exact(raw, ['attempt_id', 'status', 'auto_score', 'manual_required', 'late']) || raw.attempt_id !== attempt.id || !['graded', 'pending_review'].includes(raw.status) || typeof raw.auto_score !== 'number' || !Number.isFinite(raw.auto_score) || typeof raw.manual_required !== 'boolean' || typeof raw.late !== 'boolean')
                    throw bad();
                confirmedWrite = 'submit';
                // A confirmed submit is retained even if the following read fails.
                set({ ...previous, phase: 'busy', attempt: { ...attempt, status: raw.status, manual_required: raw.manual_required }, dirty: false, message: 'تم تأكيد التسليم. جارٍ قراءة الحالة الحالية…' });
            }
            const header = parseQuizRecovery(await (kind === 'start' ? deps.start(operation.signal) : deps.recover(operation.signal)));
            if (!current(ticket))
                return;
            if (operation.signal.aborted)
                throw bad();
            if (!header) {
                if (kind === 'start' || previous.attempt || knownAttemptId)
                    throw bad();
                set({ ...initialQuizState(), phase: 'idle', message: 'لا توجد محاولة مسجلة. البدء يتم باختيارك.' });
                return;
            }
            if (knownAttemptId && knownAttemptId !== header.id)
                throw bad();
            knownAttemptId = header.id;
            if (kind === 'start')
                confirmedWrite = 'start';
            const attempt = parseQuizAttempt(await deps.read(header.id, operation.signal), header.id);
            if (!current(ticket))
                return;
            if (operation.signal.aborted)
                throw bad();
            const keepLocal = previous.dirty && previous.attempt?.id === attempt.id && attempt.status === 'in_progress';
            const draft = keepLocal ? quizAnswers(attempt.questions, previous.draft) : attempt.answers;
            const dirty = JSON.stringify(draft) !== JSON.stringify(attempt.answers);
            set({ phase: 'ready', attempt, draft, dirty, autoSave: false, message: dirty ? 'تمت قراءة الخادم. تعديلاتك المحلية مختلفة وما زالت غير مؤكدة الحفظ؛ راجعها ثم احفظها باختيارك.' : attempt.status === 'in_progress' ? 'تمت قراءة الإجابات المحفوظة على الخادم.' : 'تمت قراءة حالة المحاولة. لا تبدأ محاولة جديدة.' });
        }
        catch (e) {
            if (current(ticket)) {
                if (denied(e)) {
                    fail(e, false);
                    if (confirmedWrite)
                        set({ ...state, message: confirmedWrite === 'submit' ? 'تم تأكيد التسليم، لكن الوصول إلى تفاصيل الكويز لم يعد مسموحًا.' : 'تم تأكيد بدء المحاولة، لكن الوصول إلى تفاصيل الكويز لم يعد مسموحًا.' });
                }
                else if (confirmedWrite)
                    set({ ...state, phase: 'error', message: confirmedWrite === 'submit' ? 'تم تأكيد التسليم، وتعذّر تحديث تفاصيل النتيجة. افحص الحالة مجددًا.' : 'تم تأكيد بدء المحاولة، وتعذّر تحميل الأسئلة. افحص الحالة دون بدء جديد.' });
                else
                    fail(e, write);
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        getState: () => state,
        subscribe(fn: (state: QuizState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
        recover: () => run('recover'), start: () => run('start'), save: () => run('save'), submit: () => run('submit'),
        edit(id: string, value: Answer) { if (state.phase !== 'ready' || state.attempt?.status !== 'in_progress' || !current(epoch))
            return; try {
            const draft = quizAnswers(state.attempt.questions, { ...state.draft, [id]: value });
            set({ ...state, draft, dirty: JSON.stringify(draft) !== JSON.stringify(state.attempt.answers), autoSave: true, message: 'تعديلات محلية لم يُؤكد حفظها بعد.' });
        }
        catch {
            set({ ...state, message: 'الإجابة تتجاوز الحجم أو الصيغة المسموحة.' });
        } },
        useServer() { if (state.phase === 'ready' && state.attempt && current(epoch))
            set({ ...state, draft: { ...state.attempt.answers }, dirty: false, message: 'تم اختيار الإجابات المقروءة من الخادم.' }); },
        invalidate,
        dispose() { disposed = true; epoch++; abort?.abort(); state = { ...initialQuizState(), phase: 'session-ended' }; unsubscribe(); listeners.clear(); },
    };
}
