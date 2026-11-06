import { ApiRequestError } from '../../lib/api-http';
import { readCourseSessionPrincipal } from './course-management';
import { catalogHomeworkTransport, homeworkUuid, parseHomeworkAuthorization, parseHomeworkCreated, parseHomeworkFinalized, parseHomeworkHistory, parseHomeworkPolicy, parseHomeworkRecovery, type HomeworkPolicy, type HomeworkReceipt, type UploadAuthorization } from './catalog-homework-api';
export interface HomeworkState {
    phase: 'loading' | 'ready' | 'busy' | 'uncertain' | 'error' | 'denied' | 'session-ended';
    policy: HomeworkPolicy | null;
    history: HomeworkReceipt[];
    selected: HomeworkReceipt | null;
    fileName: string | null;
    fileSize: number | null;
    authorized: boolean;
    transferred: boolean;
    retryable: boolean;
    message: string | null;
}
export const initialHomeworkState = (): HomeworkState => ({ phase: 'loading', policy: null, history: [], selected: null, fileName: null, fileSize: null, authorized: false, transferred: false, retryable: false, message: null });
/** Scope selectors only locate the opaque recovery key; the server owns authority. */
export function homeworkKeyStore(local: Pick<Storage, 'getItem'>, session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, course: string, lesson: string, content: string) {
    const scope = () => { const user = JSON.parse(local.getItem('currentUser') ?? 'null'), space = JSON.parse(local.getItem('currentStudentSpace') ?? 'null'); if (typeof user?.id !== 'string' || !user.id || typeof space?.tenant_id !== 'string' || !space.tenant_id || typeof space?.student_enrollment_id !== 'string' || !space.student_enrollment_id)
        throw Error('Select a student workspace'); return [user.id, space.tenant_id, space.student_enrollment_id]; };
    const captured = scope(), slot = 'tabweb.homework.request.v1.' + [...captured, course, lesson, content].map(encodeURIComponent).join('.');
    const check = () => { if (JSON.stringify(scope()) !== JSON.stringify(captured))
        throw Error('Student workspace changed'); };
    return { read() { check(); const key = session.getItem(slot); if (key !== null && !homeworkUuid(key))
            throw Error('Invalid recovery key'); return key; }, save(key: string) { check(); if (!homeworkUuid(key))
            throw Error('Invalid recovery key'); const old = session.getItem(slot); if (old && old !== key)
            throw Error('Existing recovery key'); session.setItem(slot, key); }, clear(key: string) { check(); if (session.getItem(slot) !== key)
            throw Error('Recovery key changed'); session.removeItem(slot); } };
}
/** Compare workspace changes as well as authentication, including silent changes. */
export function homeworkPrincipalReader(storage: Pick<Storage, 'getItem'>) {
    let last: string | null = null, generation = 0;
    return () => { const base = readCourseSessionPrincipal(storage); if (!base)
        return null; const canonical = JSON.stringify([base, storage.getItem('currentStudentSpace'), storage.getItem('currentStudent')]); if (canonical !== last) {
        last = canonical;
        generation++;
    } return `homework-session:${generation}`; };
}
const mime: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip', txt: 'text/plain' };
class HomeworkPreparationError extends Error {
}
export function createCatalogHomework(contentId: string, deps: ReturnType<typeof catalogHomeworkTransport> & {
    key: {
        read(): string | null;
        save(key: string): void;
        clear(key: string): void;
    };
    makeKey(): string;
    readPrincipal(): string | null;
    subscribeSession(fn: () => void): () => void;
    transfer(auth: UploadAuthorization, file: File, signal: AbortSignal): Promise<void>;
}) {
    let state = initialHomeworkState(), file: File | null = null, authorization: UploadAuthorization | null = null, key: string | null = null, frozenMeta: string | null = null;
    let epoch = 0, disposed = false, active: AbortController | null = null;
    const principal = deps.readPrincipal(), listeners = new Set<(s: HomeworkState) => void>();
    const set = (next: HomeworkState) => { state = next; if (!disposed)
        listeners.forEach(fn => fn(state)); };
    const retire = () => { if (disposed)
        return; epoch++; active?.abort(); file = null; authorization = null; frozenMeta = null; set({ ...initialHomeworkState(), phase: 'session-ended', message: 'تغيّرت الجلسة أو مساحة الطالب. افتح الواجب من المساحة الحالية.' }); };
    const current = (ticket: number) => { if (disposed || ticket !== epoch)
        return false; let now: string | null = null; try {
        now = deps.readPrincipal();
    }
    catch { } if (!principal || principal !== now) {
        retire();
        return false;
    } return true; };
    const unsubscribe = deps.subscribeSession(retire);
    const metadata = (f: File) => ({ file_name: f.name.trim(), file_type: f.type.trim() || mime[f.name.split('.').at(-1)?.toLowerCase() ?? ''] || '' });
    const matches = (f: File, row: HomeworkReceipt) => { const m = metadata(f); return m.file_name === row.file_name && m.file_type === row.file_type; };
    const canPending = () => state.selected && state.selected.status !== 'revoked' && state.selected.file_size_bytes === 0;
    const failure = (error: unknown, write: boolean) => {
        authorization = null;
        if (error instanceof HomeworkPreparationError) {
            set({ ...state, phase: 'error', authorized: false, retryable: false, message: 'تعذّر حفظ معرّف الطلب بأمان. لم يُرسل طلب إنشاء؛ أتح تخزين الجلسة واختر مساحة الطالب ثم افحص الحالة.' });
            return;
        }
        if (error instanceof ApiRequestError && ([401].includes(error.status) || error.code === 'CATALOG_HOMEWORK_DENIED' || error.code === 'CLIENT_SESSION_CHANGED' || error.status === 404 && error.code !== 'object_not_found')) {
            file = null;
            frozenMeta = null;
            set({ ...initialHomeworkState(), phase: 'denied', message: 'لم يعد الوصول لهذا الواجب مسموحًا. حدّث مسار التعلّم.' });
            return;
        }
        const unavailable = error instanceof ApiRequestError && ['CATALOG_HOMEWORK_UNAVAILABLE', 'upload_unavailable', 'transaction_unavailable'].includes(error.code ?? '');
        const missing = error instanceof ApiRequestError && error.code === 'object_not_found';
        set({ ...state, phase: write && !unavailable && !missing ? 'uncertain' : 'error', authorized: false, retryable: false, message: unavailable ? 'رفع الواجب غير جاهز حاليًا. لن نستخدم مسارًا بديلًا.' : missing ? 'لم يعثر الخادم على الملف. افحص الحالة، ثم اختر الملف وجدّد إذن الرفع عند الحاجة.' : write ? 'تعذّر تأكيد نتيجة العملية. افحص حالة الخادم قبل أي إعادة؛ لن نكرر الرفع أو الكتابة تلقائيًا.' : 'تعذّر قراءة الحالة. يمكنك فحصها مجددًا دون إنشاء تسليم جديد.' });
    };
    async function run(write: boolean, task: (signal: AbortSignal, check: () => void) => Promise<void>, timeoutMs = 20000) {
        if (disposed || ['busy', 'denied', 'session-ended'].includes(state.phase) || !current(epoch))
            return;
        const ticket = ++epoch, controller = new AbortController();
        active = controller;
        set({ ...state, phase: 'busy', message: null, retryable: false });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = () => { if (!current(ticket) || controller.signal.aborted)
            throw Error('Homework operation retired'); };
        try {
            await Promise.race([task(controller.signal, check), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Homework operation timed out')); }, timeoutMs); })]);
        }
        catch (error) {
            if (current(ticket))
                failure(error, write);
        }
        finally {
            clearTimeout(timer);
            controller.abort();
        }
    }
    async function read(signal: AbortSignal, check: () => void) {
        key = deps.key.read();
        const policy = parseHomeworkPolicy(await deps.policy(signal), contentId);
        check();
        const history = parseHomeworkHistory(await deps.mine(signal));
        check();
        const recovered = key ? parseHomeworkRecovery(await deps.recover(key, signal)) : null;
        check();
        if (recovered) {
            const index = history.findIndex(row => row.id === recovered.id);
            if (index < 0)
                history.unshift(recovered);
            else
                history[index] = recovered;
        }
        const unresolved = Boolean(key && !recovered);
        const selected = unresolved ? null : history.find(row => row.id === state.selected?.id) ?? recovered ?? history[0] ?? null;
        if (selected && file && (!matches(file, selected) || selected.file_size_bytes>0 || selected.status==='revoked'))
            file = null;
        authorization = null;
        set({ phase: unresolved ? 'uncertain' : 'ready', policy, history, selected, fileName: file?.name ?? null, fileSize: file?.size ?? null, authorized: false, transferred: false, retryable: unresolved, message: unresolved ? 'معرّف طلب سابق موجود، لكن لا يظهر له تسليم مؤكد بعد. عدم ظهوره لا يثبت انتهاء الطلب. يمكنك الفحص مجددًا أو إعادة طلب التجهيز بنفس المعرّف ونفس الملف باختيارك.' : 'تمت قراءة حالة الخادم. لم نرفع ملفًا أو نثبت تسليمًا جديدًا.' });
    }
    return {
        getState: () => state, subscribe(fn: (s: HomeworkState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; }, load: () => run(false, read),
        choose(next: File | null) {
            if (!current(epoch) || !(state.phase === 'ready' || state.phase === 'uncertain' && state.retryable))
                return;
            authorization = null;
            if (!next) {
                file = null;
                set({ ...state, fileName: null, fileSize: null, authorized: false });
                return;
            }
            const p = state.policy, m = metadata(next), ext = next.name.split('.').at(-1)?.toLowerCase() ?? '';
            if (!p || !(next instanceof Blob) || !Number.isSafeInteger(next.size) || next.size < 1024 || next.size > p.max_file_bytes || !p.allowed_file_types.includes(ext) || !m.file_name || m.file_name.length > 255 || /[\\/\x00-\x1f]/.test(m.file_name) || !m.file_type || m.file_type.length > 120 || state.selected && !matches(next, state.selected) || frozenMeta && JSON.stringify(m) !== frozenMeta) {
                file = null;
                set({ ...state, fileName: null, fileSize: null, authorized: false, message: 'اختر نفس ملف الطلب المعلّق، وبنوع وحجم ضمن حدود الواجب. لم يُرسل شيء.' });
                return;
            }
            file = next;
            set({ ...state, fileName: next.name, fileSize: next.size, authorized: false, message: 'الملف في ذاكرة الصفحة فقط. لم يُرفع بعد.' });
        },
        select(id: string) { if (state.phase !== 'ready' || !current(epoch))
            return; const row = state.history.find(x => x.id === id); if (!row)
            return; file = null; authorization = null; frozenMeta = null; set({ ...state, selected: row, fileName: null, fileSize: null, authorized: false, transferred: false, message: 'تم اختيار نسخة محفوظة. لم نرسل ملفًا.' }); },
        create() {
            if (!(state.phase === 'ready' || state.phase === 'uncertain' && state.retryable) || state.selected || !file || !state.policy?.upload_configured || !state.policy.accepting)
                return Promise.resolve();
            const chosen = file, m = metadata(chosen);
            return run(true, async (signal, check) => {
                try {
                    const existing = deps.key.read();
                    if (existing !== key)
                        throw Error('Recovery key changed');
                    if (!key) {
                        const generated = deps.makeKey();
                        if (!homeworkUuid(generated))
                            throw Error('Invalid request key');
                        deps.key.save(generated);
                        key = generated;
                    }
                }
                catch {
                    throw new HomeworkPreparationError();
                }
                frozenMeta = JSON.stringify(m);
                check();
                const raw = await deps.create(m, key, signal);
                check();
                const created = parseHomeworkCreated(raw,m);
                if (!matches(chosen, created.submission))
                    throw Error('Recovered file does not match selection');
                authorization = created.upload;
                const history = [created.submission, ...state.history.filter(x => x.id !== created.submission.id)];
                set({ ...state, phase: 'ready', selected: created.submission, history, authorized: Boolean(authorization), transferred: false, message: created.upload ? 'تم تأكيد تجهيز التسليم. اضغط رفع الملف؛ لم تُنقل البيانات بعد.' : 'تم استرجاع التسليم الموجود دون إنشاء آخر. افحص حالته قبل أي رفع.' });
            });
        },
        authorize() { if (state.phase !== 'ready' || !canPending() || !state.policy?.upload_configured)
            return Promise.resolve(); const row = state.selected!; return run(true, async (signal, check) => { const raw = await deps.authorize(row.id, signal); check(); authorization = parseHomeworkAuthorization(raw, row.id, row.version); set({ ...state, phase: 'ready', authorized: true, message: 'تم تجهيز إذن قصير المدة لهذه النسخة. الرفع يحتاج اختيارك.' }); }); },
        upload() { if (state.phase !== 'ready' || !canPending() || !file || !authorization)
            return Promise.resolve(); const selected = file, auth = authorization; authorization = null; return run(true, async (signal, check) => { check(); await deps.transfer(auth, selected, signal); check(); set({ ...state, phase: 'ready', authorized: false, transferred: true, message: 'تم تأكيد نقل الملف فقط. اضغط التحقق والفحص لتحديد حالة التسليم.' }); }, 120000); },
        finalize() { if (state.phase !== 'ready' || !canPending() || !state.policy?.upload_configured)
            return Promise.resolve(); const row = state.selected!; return run(true, async (signal, check) => { const raw = await deps.finalize(row.id, signal); check(); const selected = parseHomeworkFinalized(raw, row); authorization = null; file=null; frozenMeta=null; set({ ...state, phase: 'ready', selected, history: state.history.map(x => x.id === selected.id ? selected : x), fileName:null,fileSize:null,authorized: false, transferred: false, message: selected.upload_status === 'pending_scan' ? 'الملف مستلم وبانتظار فحص موثوق. لم يُعتمد كملف نظيف.' : selected.upload_status === 'quarantined' ? 'الملف محجور بسبب نتيجة الفحص؛ لا يُعامل كتسليم نظيف.' : 'تم تأكيد التحقق من الملف ونتيجة الفحص النظيفة.' }); }, 150000); },
        cancel() { if (state.phase !== 'ready' || !canPending() || !state.policy?.upload_configured)
            return Promise.resolve(); const row = state.selected!; return run(true, async (signal, check) => { const raw: any = await deps.cancel(row.id, signal); check(); if (!raw || Object.keys(raw).sort().join(',') !== 'cancelled,id,status' || raw.id !== row.id || raw.status !== 'revoked' || typeof raw.cancelled !== 'boolean')
            throw Error('Invalid cancel acknowledgement'); const selected = { ...row, status: 'revoked' as const }; file = null; authorization = null; set({ ...state, phase: 'ready', selected, history: state.history.map(x => x.id === row.id ? selected : x), fileName: null, fileSize: null, authorized: false, transferred: false, message: 'تم تأكيد إلغاء النسخة. لا يعني ذلك تأكيد حذف البايتات من التخزين.' }); }); },
        newVersion() { if (state.phase !== 'ready' || !state.selected || state.selected.status !== 'revoked' && state.selected.file_size_bytes === 0)
            return Promise.resolve(); return run(false, async (signal, check) => { const policy = parseHomeworkPolicy(await deps.policy(signal), contentId); check(); if (!policy.accepting || !policy.upload_configured) {
            set({ ...state, phase: 'ready', policy, message: 'الخادم لا يسمح بتجهيز نسخة جديدة حاليًا.' });
            return;
        } if (key)
            deps.key.clear(key); key = null; file = null; authorization = null; frozenMeta = null; set({ ...state, phase: 'ready', policy, selected: null, fileName: null, fileSize: null, authorized: false, transferred: false, message: 'اختر ملف النسخة الجديدة. حدود التسليم يقررها الخادم.' }); }); },
        invalidate: retire, dispose() { disposed = true; epoch++; active?.abort(); file = null; authorization = null; frozenMeta = null; state = { ...initialHomeworkState(), phase: 'session-ended' }; unsubscribe(); listeners.clear(); },
    };
}
