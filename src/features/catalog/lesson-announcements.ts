import { ApiRequestError, authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';
const uuid = (x: any) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const bad = () => Error('Invalid lesson announcement response');
export interface AnnouncementSource {
    source_id: string;
    title: string;
    source_state: 'draft' | 'published';
    group_id: string;
    group_name: string;
}
export interface LessonAnnouncement {
    content_id: string;
    source_id: string;
    title: string | null;
    source_state: 'draft' | 'published' | 'unavailable';
    group_id: string | null;
    group_name: string | null;
    student_visibility: 'unconfigured';
}
export interface AnnouncementPreview extends AnnouncementSource {
    content_id: string;
    body: string;
    candidate_enrollments: number;
    course_published: boolean;
    lesson_active: boolean;
    lesson_released: boolean;
    prerequisite_required: boolean;
    previewed_at: string;
    student_visibility: 'unconfigured';
    delivery_status: 'unconfigured';
}
function source(x: any): AnnouncementSource {
    if (!uuid(x.source_id) || !uuid(x.group_id) || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 255 || !['draft', 'published'].includes(x.source_state) || typeof x.group_name !== 'string' || x.group_name.length > 255)
        throw bad();
    return { source_id: x.source_id, title: x.title, source_state: x.source_state, group_id: x.group_id, group_name: x.group_name };
}
export function parseLessonAnnouncement(raw: any): LessonAnnouncement | null {
    if (!exact(raw, ['announcement']))
        throw bad();
    const x = raw.announcement;
    if (x === null)
        return null;
    if (!exact(x, ['content_id', 'source_id', 'title', 'source_state', 'group_id', 'group_name', 'student_visibility']) || !uuid(x.content_id) || !uuid(x.source_id) || x.student_visibility !== 'unconfigured')
        throw bad();
    if (x.source_state === 'unavailable') {
        if (x.title !== null || x.group_id !== null || x.group_name !== null)
            throw bad();
    }
    else
        source(x);
    return { content_id: x.content_id, source_id: x.source_id, title: x.title, source_state: x.source_state, group_id: x.group_id, group_name: x.group_name, student_visibility: 'unconfigured' };
}
export function parseAnnouncementSources(raw: any) {
    if (!exact(raw, ['sources', 'next_cursor']) || !Array.isArray(raw.sources) || raw.sources.length > 25 || raw.next_cursor !== null && !uuid(raw.next_cursor))
        throw bad();
    const rows: AnnouncementSource[] = raw.sources.map((x: any) => { if (!exact(x, ['source_id', 'title', 'source_state', 'group_id', 'group_name']))
        throw bad(); return source(x); });
    if (new Set(rows.map(x => x.source_id.toLowerCase())).size !== rows.length)
        throw bad();
    return { rows, cursor: raw.next_cursor as string | null };
}
export function parseAnnouncementPreview(raw: any, current: LessonAnnouncement): AnnouncementPreview {
    const x = raw?.preview;
    if (!exact(raw, ['preview']) || !exact(x, ['content_id', 'source_id', 'title', 'source_state', 'group_id', 'group_name', 'body', 'candidate_enrollments', 'course_published', 'lesson_active', 'lesson_released', 'prerequisite_required', 'previewed_at', 'student_visibility', 'delivery_status']) || x.content_id !== current.content_id || x.source_id !== current.source_id || x.group_id !== current.group_id || typeof x.body !== 'string' || !x.body.trim() || x.body.length > 4000 || !Number.isInteger(x.candidate_enrollments) || x.candidate_enrollments < 0 || x.candidate_enrollments > 500 || !['course_published', 'lesson_active', 'lesson_released', 'prerequisite_required'].every(k => typeof x[k] === 'boolean') || typeof x.previewed_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x.previewed_at) || !Number.isFinite(Date.parse(x.previewed_at)) || new Date(x.previewed_at).toISOString() !== x.previewed_at || x.student_visibility !== 'unconfigured' || x.delivery_status !== 'unconfigured')
        throw bad();
    return { ...source(x), content_id: x.content_id, body: x.body, candidate_enrollments: x.candidate_enrollments, course_published: x.course_published, lesson_active: x.lesson_active, lesson_released: x.lesson_released, prerequisite_required: x.prerequisite_required, previewed_at: x.previewed_at, student_visibility: 'unconfigured', delivery_status: 'unconfigured' };
}
export function lessonAnnouncementTransport(course: string, unit: string, lesson: string) {
    if (![course, unit, lesson].every(uuid))
        throw bad();
    const base = `/tenants/me/catalog/courses/${course}/units/${unit}/lessons/${lesson}/announcement`;
    const request = async (suffix: string, signal: AbortSignal, method = 'GET', body?: unknown) => { const response = await authenticatedApiFetch(base + suffix, { signal, method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); const raw = await readAuthenticatedApiJson(response); if (!response.ok)
        throw new ApiRequestError('Announcement request failed', response.status, raw && typeof raw.code === 'string' ? raw.code : undefined); return raw; };
    const id = (value: string) => { if (!uuid(value))
        throw bad(); return value; };
    return { read: (s: AbortSignal) => request('', s), sources: (cursor: string | null, s: AbortSignal) => request('/available-sources' + (cursor ? '?cursor=' + id(cursor) : ''), s), attach: (sourceId: string, s: AbortSignal) => request('', s, 'POST', { source_id: id(sourceId) }), detach: (contentId: string, s: AbortSignal) => request('/' + id(contentId), s, 'DELETE'), preview: (contentId: string, s: AbortSignal) => request('/' + id(contentId) + '/preview', s) };
}
export interface AnnouncementEditorState {
    phase: 'idle' | 'ready' | 'error' | 'session-ended';
    busy: boolean;
    uncertain: boolean;
    current: LessonAnnouncement | null;
    options: AnnouncementSource[];
    cursor: string | null;
    preview: AnnouncementPreview | null;
    message: string | null;
}
export const initialAnnouncementEditor = (): AnnouncementEditorState => ({ phase: 'idle', busy: false, uncertain: false, current: null, options: [], cursor: null, preview: null, message: null });
export function createAnnouncementEditor(deps: ReturnType<typeof lessonAnnouncementTransport> & {
    readPrincipal(): string | null;
    subscribeSession(fn: () => void): () => void;
}) {
    let state = initialAnnouncementEditor(), epoch = 0, disposed = false, active: AbortController | null = null;
    const principal = deps.readPrincipal(), listeners = new Set<(s: AnnouncementEditorState) => void>();
    const set = (next: AnnouncementEditorState) => { state = next; if (!disposed)
        listeners.forEach(fn => fn(state)); };
    const invalidate = () => { if (disposed)
        return; epoch++; active?.abort(); set({ ...initialAnnouncementEditor(), phase: 'session-ended', message: 'تغيّرت الجلسة. أعد فتح إعلان الدرس من مساحة المؤسسة الحالية.' }); };
    const current = (n: number) => { if (disposed || n !== epoch)
        return false; if (!principal || principal !== deps.readPrincipal()) {
        invalidate();
        return false;
    } return true; };
    const unsubscribe = deps.subscribeSession(invalidate);
    async function run(write: boolean, work: (signal: AbortSignal, check: () => void) => Promise<void>) {
        if (disposed || state.busy || state.phase === 'session-ended' || !current(epoch))
            return;
        const ticket = ++epoch, cancel = new AbortController();
        active = cancel;
        set({ ...state, busy: true, preview: null, message: null });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = () => { if (!current(ticket) || cancel.signal.aborted)
            throw bad(); };
        try {
            await Promise.race([work(cancel.signal, check), new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel.abort(); reject(bad()); }, 20000); })]);
        }
        catch (error) {
            if (current(ticket)) {
                if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status))
                    set({ ...initialAnnouncementEditor(), phase: 'error', message: 'لم يعد إعلان الدرس متاحًا بالحساب الحالي. أعد فتح المدير بعد تحديث الصلاحيات.' });
                else
                    set({ ...state, phase: write ? 'ready' : 'error', uncertain: write || state.uncertain, preview: null, message: write ? 'تعذّر تأكيد الربط. حدّث الإعلان من الخادم قبل أي إعادة؛ لن نكرر الكتابة آليًا.' : 'تعذّرت القراءة أو المعاينة الحالية. حدّث الإعلان؛ لا يوجد نشر أو إرسال.' });
            }
        }
        finally {
            clearTimeout(timer);
            cancel.abort();
            if (current(ticket))
                set({ ...state, busy: false });
        }
    }
    return { getState: () => state, subscribe(fn: (s: AnnouncementEditorState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
        load: () => run(false, async (signal, check) => { const value = parseLessonAnnouncement(await deps.read(signal)); check(); const page = parseAnnouncementSources(await deps.sources(null, signal)); check(); set({ ...initialAnnouncementEditor(), phase: 'ready', current: value, options: page.rows, cursor: page.cursor, message: 'تمت قراءة المرجع والمصادر الحالية. الربط لا ينشر ولا يرسل إعلانًا.' }); }),
        more() { if (state.phase !== 'ready' || !state.cursor || state.options.length >= 200)
            return Promise.resolve(); const cursor = state.cursor; return run(false, async (signal, check) => { const page = parseAnnouncementSources(await deps.sources(cursor, signal)); check(); const options = [...state.options, ...page.rows]; if (options.length > 200 || new Set(options.map(x => x.source_id)).size !== options.length || page.cursor === cursor)
            throw bad(); set({ ...state, options, cursor: page.cursor, phase: 'ready' }); }); },
        attach(id: string) { if (state.phase !== 'ready' || state.uncertain || state.current || !state.options.some(x => x.source_id === id))
            return Promise.resolve(); return run(true, async (signal, check) => { const raw = await deps.attach(id, signal); check(); if (!exact(raw, ['announcement', 'unchanged']) || typeof raw.unchanged !== 'boolean')
            throw bad(); const value = parseLessonAnnouncement({ announcement: raw.announcement }); if (!value || value.source_id !== id || value.source_state === 'unavailable')
            throw bad(); set({ ...state, current: value, uncertain: false, message: 'تم تأكيد ربط المرجع فقط. يمكنك معاينة محتواه وجمهوره.' }); }); },
        detach() { if (state.phase !== 'ready' || state.uncertain || !state.current)
            return Promise.resolve(); const id = state.current.content_id; return run(true, async (signal, check) => { const raw = await deps.detach(id, signal); check(); if (!exact(raw, ['detached']) || typeof raw.detached !== 'boolean')
            throw bad(); set({ ...state, current: null, uncertain: false, message: 'تم تأكيد فك المرجع المحدد. مصدر الإعلان باقٍ في المجموعة.' }); }); },
        preview() { if (state.phase !== 'ready' || state.uncertain || !state.current || state.current.source_state === 'unavailable')
            return Promise.resolve(); const selected = state.current; return run(false, async (signal, check) => { const preview = parseAnnouncementPreview(await deps.preview(selected.content_id, signal), selected); check(); set({ ...state, preview, message: 'معاينة للحظة القراءة فقط. عدد المرشحين لا يثبت أهلية كل طالب أو وصول رسالة.' }); }); },
        invalidate, dispose() { disposed = true; epoch++; active?.abort(); state = { ...initialAnnouncementEditor(), phase: 'session-ended' }; unsubscribe(); listeners.clear(); },
    };
}
