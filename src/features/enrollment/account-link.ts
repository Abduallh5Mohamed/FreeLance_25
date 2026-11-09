import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x);
const exact = (x: unknown, k: string[]): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === k.slice().sort().join(',');
const invalid = () => Error('Invalid account-link response');
export type LinkMarker = {
    kind: 'student';
    action: 'request' | 'withdraw';
    operation_id: string;
} | {
    kind: 'owner';
    operation_id: string;
    student_id: string;
    request_id: string;
};
export type LinkReceipt = {
    id: string;
    state: 'pending' | 'linked' | 'withdrawn' | 'expired';
} | {
    operation_id: string;
    student_id: string;
    request_id: string;
    state: 'account_linked';
};
export interface LinkReview {
    student: {
        id: string;
        name: string;
    };
    request: {
        id: string;
        name: string;
    };
    effect: 'identity_only';
    review_token: string;
}
export type LinkAvailability = 'deferred' | 'verification_required';
export function parseLinkAvailability(raw: unknown): LinkAvailability {
    if (!exact(raw, ['state']) || !['deferred', 'verification_required'].includes(raw.state))
        throw invalid();
    return raw.state;
}
export async function readLinkAvailability(kind: 'owner' | 'student', signal: AbortSignal) {
    if (kind === 'owner')
        return parseLinkAvailability(await accountLinkRequest('/tenants/me/catalog/account-link/capabilities', undefined, signal));
    const base = (import.meta as {
        env?: Record<string, string | undefined>;
    }).env?.VITE_API_URL || '/api';
    const response = await fetch(base + '/student-enrollment/account-link-capabilities', { signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok)
        throw invalid();
    return parseLinkAvailability(await response.json());
}
export function parseLinkMarker(x: unknown): LinkMarker {
    if (!exact(x, (x as any)?.kind === 'student' ? ['kind', 'action', 'operation_id'] : ['kind', 'operation_id', 'student_id', 'request_id']) || !uuid(x.operation_id) || x.kind === 'student' && !['request', 'withdraw'].includes(x.action) || x.kind !== 'student' && (x.kind !== 'owner' || !uuid(x.student_id) || !uuid(x.request_id)))
        throw invalid();
    return x as LinkMarker;
}
export function parseLinkReceipt(raw: unknown, marker: LinkMarker): LinkReceipt | null {
    parseLinkMarker(marker);
    const property = marker.kind === 'student' ? 'request' : 'operation';
    if (!exact(raw, [property]))
        throw invalid();
    const x = raw[property];
    if (x === null)
        return null;
    if (marker.kind === 'student') {
        if (!exact(x, ['id', 'state']) || x.id !== marker.operation_id || !['pending', 'linked', 'withdrawn', 'expired'].includes(x.state) || marker.action === 'withdraw' && x.state !== 'withdrawn')
            throw invalid();
    }
    else if (!exact(x, ['operation_id', 'student_id', 'request_id', 'state']) || x.operation_id !== marker.operation_id || x.student_id !== marker.student_id || x.request_id !== marker.request_id || x.state !== 'account_linked')
        throw invalid();
    return x as LinkReceipt;
}
export async function accountLinkRequest(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await authenticatedApiFetch(path, { signal, cache: 'no-store', ...body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {} });
    const raw = await readAuthenticatedApiJson(response);
    if (!response.ok)
        throw new ApiRequestError('تعذر تنفيذ الربط؛ راجع التحقق وصلاحية الطلب وتطابق السجل.', response.status);
    return raw;
}
export function parseLinkPage(raw: unknown) {
    if (!exact(raw, ['items', 'next_cursor']) || !Array.isArray(raw.items) || raw.items.length > 25 || raw.next_cursor !== null && !uuid(raw.next_cursor) || raw.items.some((x: any) => !exact(x, ['id', 'name']) || !uuid(x.id) || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 255) || new Set(raw.items.map((x: any) => x.id)).size !== raw.items.length)
        throw invalid();
    return raw as {
        items: Array<{
            id: string;
            name: string;
        }>;
        next_cursor: string | null;
    };
}
export function parseLinkReview(raw: unknown, student: string, request: string): LinkReview {
    if (!exact(raw, ['student', 'request', 'effect', 'review_token']) || !exact(raw.student, ['id', 'name']) || !exact(raw.request, ['id', 'name']) || raw.student.id !== student || raw.request.id !== request || [raw.student.name, raw.request.name].some(x => typeof x !== 'string' || !x.trim() || x.length > 255) || raw.effect !== 'identity_only' || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token))
        throw invalid();
    return raw as LinkReview;
}
export function linkRecoveryStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, account: string, kind: 'owner' | 'student') {
    if (!account)
        throw invalid();
    const key = 'tabweb.account-link.v1.' + kind + '.' + encodeURIComponent(account);
    return { read() {
            const raw = storage.getItem(key);
            if (raw === null)
                return null;
            const value = parseLinkMarker(JSON.parse(raw));
            if (value.kind !== kind)
                throw invalid();
            return value;
        }, write(x: LinkMarker) {
            const value = parseLinkMarker(x);
            if (value.kind !== kind)
                throw invalid();
            storage.setItem(key, JSON.stringify(value));
        }, clear() { storage.removeItem(key); } };
}
export interface LinkWriteState {
    phase: 'idle' | 'saving' | 'uncertain' | 'recovering' | 'saved' | 'ended';
    receipt: LinkReceipt | null;
    message: string | null;
}
/** A durable intent holds only IDs. Recovery never repeats a POST. */
export function createLinkWrite(deps: {
    store: ReturnType<typeof linkRecoveryStore>;
    principal: () => string | null;
    subscribe: (fn: () => void) => () => void;
    post: (marker: LinkMarker, body: unknown, signal: AbortSignal) => Promise<unknown>;
    get: (marker: LinkMarker, signal: AbortSignal) => Promise<unknown>;
}) {
    let state: LinkWriteState = { phase: 'idle', receipt: null, message: null }, pending: LinkMarker | null = null, disposed = false, epoch = 0, active: AbortController | null = null;
    const identity = deps.principal(), listeners = new Set<(s: LinkWriteState) => void>();
    const set = (next: LinkWriteState) => {
        state = next;
        if (!disposed)
            listeners.forEach(fn => fn(state));
    };
    const cancel = () => { epoch++; active?.abort(); active = null; };
    const end = () => { cancel(); set({ phase: 'ended', receipt: null, message: null }); };
    const unsub = deps.subscribe(end);
    const alive = () => {
        if (disposed || state.phase === 'ended')
            return false;
        if (!identity || identity !== deps.principal()) {
            end();
            return false;
        }
        return true;
    };
    try {
        pending = deps.store.read();
        if (pending)
            state = { ...state, phase: 'uncertain', message: 'توجد عملية تحتاج استعلامًا قبل أي كتابة.' };
    }
    catch {
        state = { ...state, phase: 'uncertain', message: 'تعذر قراءة علامة الاسترجاع؛ الكتابة متوقفة.' };
    }
    async function run(saving: boolean, body?: unknown) {
        if (!pending || !alive())
            return;
        cancel();
        const n = epoch, c = new AbortController();
        active = c;
        set({ ...state, phase: saving ? 'saving' : 'recovering', receipt: saving ? null : state.receipt, message: null });
        const current = () => !disposed && n === epoch && !c.signal.aborted && alive();
        const fail = () => set({ ...state, phase: 'uncertain', message: state.receipt ? 'الحفظ مؤكد؛ تعذر تسوية علامة الاسترجاع.' : 'النتيجة غير محسومة؛ استخدم الاستعلام دون إعادة الحفظ.' });
        const timer = setTimeout(() => {
            if (current()) {
                cancel();
                fail();
            }
        }, 25000);
        try {
            const raw = await (saving ? deps.post(pending, body, c.signal) : deps.get(pending, c.signal));
            if (!current())
                return;
            const receipt = parseLinkReceipt(raw, pending);
            if (!receipt) {
                fail();
                return;
            }
            set({ ...state, receipt });
            try {
                deps.store.clear();
                pending = null;
                set({ phase: 'saved', receipt, message: 'تأكد الحفظ؛ هذا إيصال تاريخي. حدّث القراءة لمعرفة الحالة الحالية.' });
            }
            catch {
                fail();
            }
        }
        catch (e) {
            if (current()) {
                if (saving && e instanceof ApiRequestError && e.status >= 400 && e.status < 500) {
                    try {
                        deps.store.clear();
                        pending = null;
                        set({ ...state, phase: 'idle', message: e.message });
                    }
                    catch {
                        fail();
                    }
                }
                else
                    fail();
            }
        }
        finally {
            clearTimeout(timer);
            if (active === c)
                active = null;
        }
    }
    return { subscribe(fn: (s: LinkWriteState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
        async apply(marker: LinkMarker, body: unknown) {
            if (!alive() || pending || state.phase === 'uncertain' || state.phase === 'saving' || state.phase === 'recovering')
                return;
            try {
                parseLinkMarker(marker);
                deps.store.write(marker);
            }
            catch {
                set({ ...state, message: 'تعذر حفظ علامة الاسترجاع؛ لم يُرسل طلب كتابة.' });
                return;
            }
            pending = marker;
            if (alive())
                await run(true, body);
        }, async recover() {
            if (alive() && state.phase === 'uncertain' && pending)
                await run(false);
        }, invalidate: end,
        dispose() { disposed = true; cancel(); unsub(); listeners.clear(); state = { phase: 'ended', receipt: null, message: null }; pending = null; } };
}
