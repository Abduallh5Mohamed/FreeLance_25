import { ApiRequestError, authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';
import { parseAnnouncementPreview, type AnnouncementPreview, type LessonAnnouncement } from './lesson-announcements';
const uuid = (x: any) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const iso = (x: any) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const bad = () => Error('Invalid announcement publication response');
export interface AnnouncementPublication {
    id: string;
    content_id: string;
    status: 'published' | 'source_changed';
    published_at: string;
}
export interface PublicationReview {
    preview: AnnouncementPreview;
    review_token: string;
    can_publish: boolean;
    publication: AnnouncementPublication | null;
}
export function parsePublication(raw: any, contentId: string): AnnouncementPublication | null {
    if (!exact(raw, ['publication']))
        throw bad();
    const x = raw.publication;
    if (x === null)
        return null;
    if (!exact(x, ['id', 'content_id', 'status', 'published_at']) || !uuid(x.id) || x.content_id !== contentId || !['published', 'source_changed'].includes(x.status) || !iso(x.published_at))
        throw bad();
    return { id: x.id, content_id: x.content_id, status: x.status, published_at: x.published_at };
}
export function parsePublicationReview(raw: any, reference: LessonAnnouncement): PublicationReview {
    if (!exact(raw, ['preview', 'review_token', 'can_publish', 'publication']) || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token) || typeof raw.can_publish !== 'boolean')
        throw bad();
    const preview = parseAnnouncementPreview({ preview: raw.preview }, reference);
    if (raw.can_publish !== (preview.source_state === 'published' && preview.course_published && preview.lesson_active))
        throw bad();
    return { preview, review_token: raw.review_token, can_publish: raw.can_publish, publication: parsePublication({ publication: raw.publication }, reference.content_id) };
}
export interface StudentAnnouncement {
    content_id: string;
    publication_id: string;
    title: string;
    body: string;
    published_at: string;
}
export function parseStudentAnnouncement(raw: any, lessonId: string): StudentAnnouncement | null {
    if (!exact(raw, ['lesson_id', 'announcement']) || raw.lesson_id !== lessonId)
        throw bad();
    const x = raw.announcement;
    if (x === null)
        return null;
    if (!exact(x, ['content_id', 'publication_id', 'title', 'body', 'published_at']) || !uuid(x.content_id) || !uuid(x.publication_id) || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 255 || typeof x.body !== 'string' || !x.body.trim() || x.body.length > 4000 || !iso(x.published_at))
        throw bad();
    return { content_id: x.content_id, publication_id: x.publication_id, title: x.title, body: x.body, published_at: x.published_at };
}
async function request(path: string, signal: AbortSignal, method = 'GET', body?: unknown) { const response = await authenticatedApiFetch(path, { signal, method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); const data = await readAuthenticatedApiJson(response); if (!response.ok)
    throw new ApiRequestError('Announcement operation failed', response.status, typeof data?.code === 'string' ? data.code : undefined); return data; }
export function announcementPublicationTransport(course: string, unit: string, lesson: string, content: string) {
    if (![course, unit, lesson, content].every(uuid))
        throw bad();
    const base = `/tenants/me/catalog/courses/${course}/units/${unit}/lessons/${lesson}/announcement/${content}`;
    return { read: (s: AbortSignal) => request(base + '/publication', s), review: (s: AbortSignal) => request(base + '/publication-preview', s), publish: (token: string, s: AbortSignal) => { if (!/^[a-f\d]{64}$/.test(token))
            throw bad(); return request(base + '/publication', s, 'POST', { review_token: token }); }, withdraw: (id: string, s: AbortSignal) => { if (!uuid(id))
            throw bad(); return request(base + '/publication/' + id, s, 'DELETE'); } };
}
export function studentAnnouncementTransport(course: string, lesson: string) { if (![course, lesson].every(uuid))
    throw bad(); return (signal: AbortSignal) => request(`/student-course-access/courses/${course}/lessons/${lesson}/announcement`, signal); }
interface Session {
    readPrincipal(): string | null;
    subscribeSession(fn: () => void): () => void;
}
function lifetime<T>(initial: () => T, session: Session, onRetired: () => T) {
    let state = initial(), ended = false, disposed = false, epoch = 0, active: AbortController | null = null;
    const principal = session.readPrincipal(), listeners = new Set<(s: T) => void>();
    const set = (next: T) => { state = next; if (!disposed)
        listeners.forEach(fn => fn(next)); };
    const invalidate = () => { if (disposed)
        return; ended = true; epoch++; active?.abort(); set(onRetired()); };
    const unsubscribe = session.subscribeSession(invalidate);
    const current = (ticket: number) => { if (disposed || ended || ticket !== epoch)
        return false; if (!principal || principal !== session.readPrincipal()) {
        invalidate();
        return false;
    } return true; };
    return { get: () => state, set, invalidate, subscribe(fn: (s: T) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; }, async run(work: (signal: AbortSignal, check: () => void) => Promise<void>, failed: (e: unknown) => void) { if (!current(epoch))
            return; const ticket = ++epoch, cancel = new AbortController(); active = cancel; let timer: ReturnType<typeof setTimeout> | undefined; const check = () => { if (!current(ticket) || cancel.signal.aborted)
            throw bad(); }; try {
            await Promise.race([work(cancel.signal, check), new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel.abort(); reject(bad()); }, 20000); })]);
        }
        catch (e) {
            if (current(ticket))
                failed(e);
        }
        finally {
            clearTimeout(timer);
            cancel.abort();
        } }, dispose() { disposed = true; ended = true; epoch++; active?.abort(); state = onRetired(); unsubscribe(); listeners.clear(); } };
}
export interface PublicationState {
    phase: 'idle' | 'ready' | 'busy' | 'error' | 'session-ended';
    publication: AnnouncementPublication | null;
    review: PublicationReview | null;
    uncertain: boolean;
    message: string | null;
}
export const initialPublicationState = (): PublicationState => ({ phase: 'idle', publication: null, review: null, uncertain: false, message: null });
export function createPublicationController(reference: LessonAnnouncement, deps: ReturnType<typeof announcementPublicationTransport> & Session) {
    const life = lifetime(initialPublicationState, deps, () => ({ ...initialPublicationState(), phase: 'session-ended', message: 'تغيّرت الجلسة. أعد فتح إعلان الحصة.' } as PublicationState));
    async function run(action: 'read' | 'review' | 'publish' | 'withdraw') {
        const previous = life.get();
        if (['busy', 'session-ended'].includes(previous.phase) || previous.uncertain && action !== 'read' || action === 'publish' && (!previous.review?.can_publish || previous.phase !== 'ready') || action === 'withdraw' && (!previous.publication || previous.phase !== 'ready'))
            return;
        const write = action === 'publish' || action === 'withdraw';
        life.set({ ...previous, phase: 'busy', review: action === 'publish' ? previous.review : null, message: null });
        await life.run(async (signal, check) => {
            if (action === 'review') {
                const review = parsePublicationReview(await deps.review(signal), reference);
                check();
                life.set({ phase: 'ready', publication: review.publication, review, uncertain: false, message: 'راجع النص والمجموعة. العضوية تتغير والصلاحيات تُفحص عند قراءة الطالب.' });
                return;
            }
            if (action === 'publish') {
                const raw = await deps.publish(previous.review!.review_token, signal);
                check();
                if (!exact(raw, ['publication', 'unchanged']) || typeof raw.unchanged !== 'boolean')
                    throw bad();
                const publication = parsePublication({ publication: raw.publication }, reference.content_id);
                if (!publication || publication.status !== 'published')
                    throw bad();
                life.set({ phase: 'ready', publication, review: null, uncertain: false, message: 'تم تأكيد إتاحة النسخة المراجَعة داخل الدرس فقط. لم تُرسل رسالة.' });
                return;
            }
            if (action === 'withdraw') {
                const raw = await deps.withdraw(previous.publication!.id, signal);
                check();
                if (!exact(raw, ['withdrawn']) || typeof raw.withdrawn !== 'boolean')
                    throw bad();
                life.set({ phase: 'ready', publication: null, review: null, uncertain: false, message: 'تم تأكيد سحب الإتاحة المحددة. مصدر المجموعة باقٍ.' });
                return;
            }
            const publication = parsePublication(await deps.read(signal), reference.content_id);
            check();
            life.set({ phase: 'ready', publication, review: null, uncertain: false, message: 'تمت قراءة حالة الإتاحة الحالية؛ لم نكرر قرار نشر أو سحب.' });
        }, error => {
            if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
                life.set({ ...initialPublicationState(), phase: 'error', message: 'لم تعد صلاحيات إعلان الحصة متاحة.' });
                return;
            }
            const stale = error instanceof ApiRequestError && error.status === 409;
            life.set({ ...life.get(), phase: 'error', review: null, uncertain: previous.uncertain || write && !stale, message: stale ? 'تغيّر النص أو المرجع أو بيانات المعاينة. اقرأ الحالة ثم عاين من جديد.' : write ? 'تعذّر تأكيد القرار. اقرأ الحالة الحالية قبل أي إعادة؛ لن نكرر الكتابة آليًا.' : 'تعذّرت قراءة الإتاحة أو المعاينة. يمكنك إعادة فحصها.' });
        });
    }
    return { getState: life.get, subscribe: life.subscribe, load: () => run('read'), review: () => run('review'), publish: () => run('publish'), withdraw: () => run('withdraw'), invalidate: life.invalidate, dispose: life.dispose };
}
export interface StudentAnnouncementState {
    phase: 'idle' | 'busy' | 'ready' | 'error' | 'session-ended';
    announcement: StudentAnnouncement | null;
    message: string | null;
}
export const initialStudentAnnouncement = (): StudentAnnouncementState => ({ phase: 'idle', announcement: null, message: null });
export function createStudentAnnouncement(lessonId: string, deps: Session & {
    read(signal: AbortSignal): Promise<unknown>;
}) {
    const life = lifetime(initialStudentAnnouncement, deps, () => ({ ...initialStudentAnnouncement(), phase: 'session-ended', message: 'تغيّرت الجلسة أو مساحة الطالب. أعد فتح الدرس.' } as StudentAnnouncementState));
    return { getState: life.get, subscribe: life.subscribe, invalidate: life.invalidate, dispose: life.dispose, async load() { if (['busy', 'session-ended'].includes(life.get().phase))
            return; life.set({ ...initialStudentAnnouncement(), phase: 'busy' }); await life.run(async (signal, check) => { const announcement = parseStudentAnnouncement(await deps.read(signal), lessonId); check(); life.set({ phase: 'ready', announcement, message: null }); }, () => life.set({ ...initialStudentAnnouncement(), phase: 'error', message: 'تعذّر عرض إعلان مخوّل حاليًا. حدّث مسار التعلّم؛ لا يوجد مسار بديل.' })); } };
}
