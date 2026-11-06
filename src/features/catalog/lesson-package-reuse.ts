import { ApiRequestError, authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';
import type { PackageKind } from './lesson-package-preview';
export interface ReuseSelection {
    kind: PackageKind;
    source_id: string;
}
export interface ReuseItem extends ReuseSelection {
    title: string | null;
    display_order: number | null;
    audience: 'course' | 'restricted' | null;
    source_state: 'draft' | 'published' | 'ready' | null;
    outcome: 'add' | 'present' | 'conflict';
    conflict: string | null;
}
export interface ReuseReview {
    review_token: string;
    can_apply: boolean;
    items: ReuseItem[];
    projected_media_count: number;
}
export interface ReuseReceipt {
    operation_id: string;
    created: number;
    existing: number;
}
const kinds: PackageKind[] = ['material', 'video', 'homework', 'quiz', 'announcement'];
const conflicts = ['source_unavailable', 'different_position', 'position_occupied', 'slot_occupied', 'capacity'];
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x: any, fields: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === fields.slice().sort().join(',');
const bad = () => Error('Invalid package reuse response');
export function canonicalReuseSelection(rows: ReuseSelection[]) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 23 || rows.some(row => !exact(row, ['kind', 'source_id']) || !kinds.includes(row.kind) || !uuid(row.source_id)))
        throw bad();
    const copy = rows.map(row => ({ kind: row.kind, source_id: row.source_id.toLowerCase() })).sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
    if (new Set(copy.map(row => row.kind + '/' + row.source_id)).size !== copy.length || copy.filter(row => ['material', 'video'].includes(row.kind)).length > 20
        || ['homework', 'quiz', 'announcement'].some(kind => copy.filter(row => row.kind === kind).length > 1))
        throw bad();
    return copy;
}
export function parseReuseReview(raw: any, selected: ReuseSelection[]): ReuseReview {
    const expected = canonicalReuseSelection(selected);
    if (!exact(raw, ['review_token', 'can_apply', 'items', 'projected_media_count']) || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token)
        || typeof raw.can_apply !== 'boolean' || !Array.isArray(raw.items) || raw.items.length !== expected.length || !Number.isInteger(raw.projected_media_count) || raw.projected_media_count < 0 || raw.projected_media_count > 40)
        throw bad();
    const items: ReuseItem[] = raw.items.map((row: any, index: number) => {
        if (!exact(row, ['kind', 'source_id', 'title', 'display_order', 'audience', 'source_state', 'outcome', 'conflict']) || row.kind !== expected[index].kind || row.source_id !== expected[index].source_id
            || row.title !== null && (typeof row.title !== 'string' || row.title.length > 255) || !['course', 'restricted', null].includes(row.audience)
            || !['draft', 'published', 'ready', null].includes(row.source_state) || !['add', 'present', 'conflict'].includes(row.outcome)
            || row.source_state !== null && (row.kind === 'video' ? row.source_state !== 'ready' : !['draft', 'published'].includes(row.source_state))
            || row.audience !== null && (['material', 'video'].includes(row.kind) ? row.audience !== 'course' : row.kind === 'announcement' && row.audience !== 'restricted')
            || (row.outcome === 'conflict' ? !conflicts.includes(row.conflict) : row.conflict !== null)
            || (['material', 'video'].includes(row.kind) ? row.display_order !== null && (!Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647) : row.display_order !== null)
            || row.outcome !== 'conflict' && (row.title === null || row.audience === null || row.source_state === null || ['material', 'video'].includes(row.kind) && row.display_order === null))
            throw bad();
        return { kind: row.kind, source_id: row.source_id, title: row.title, display_order: row.display_order, audience: row.audience, source_state: row.source_state, outcome: row.outcome, conflict: row.conflict };
    });
    if (raw.can_apply !== items.every(row => row.outcome !== 'conflict') || raw.can_apply && raw.projected_media_count > 20)
        throw bad();
    return { review_token: raw.review_token, can_apply: raw.can_apply, items, projected_media_count: raw.projected_media_count };
}
function receipt(raw: any, operationId: string, count: number, apply: boolean): ReuseReceipt {
    if (!exact(raw, ['operation_id', 'created', 'existing', ...(apply ? ['replayed'] : [])]) || raw.operation_id !== operationId || !uuid(raw.operation_id)
        || ![raw.created, raw.existing].every(n => Number.isInteger(n) && n >= 0 && n <= 23) || raw.created + raw.existing !== count || apply && typeof raw.replayed !== 'boolean')
        throw bad();
    return { operation_id: raw.operation_id, created: raw.created, existing: raw.existing };
}
export function packageReuseTransport(course: string, unit: string, destination: string, source: string) {
    if (![course, unit, destination, source].every(uuid) || destination.toLowerCase() === source.toLowerCase())
        throw bad();
    const base = `/tenants/me/catalog/courses/${course}/units/${unit}/lessons/${destination}/package-reuse`;
    const request = async (suffix: string, signal: AbortSignal, body?: unknown) => {
        const response = await authenticatedApiFetch(base + suffix, { method: body === undefined ? 'GET' : 'POST', signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const raw = await readAuthenticatedApiJson(response);
        if (!response.ok)
            throw new ApiRequestError('Package reuse request failed', response.status, typeof raw?.code === 'string' ? raw.code : undefined);
        return raw;
    };
    return {
        review: (selections: ReuseSelection[], signal: AbortSignal) => request('/review', signal, { source_lesson_id: source.toLowerCase(), selections: canonicalReuseSelection(selections) }),
        apply: (selections: ReuseSelection[], token: string, operationId: string, signal: AbortSignal) => { if (!uuid(operationId) || !/^[a-f\d]{64}$/.test(token))
            throw bad(); return request('', signal, { source_lesson_id: source.toLowerCase(), selections: canonicalReuseSelection(selections), review_token: token, operation_id: operationId }); },
        status: (operationId: string, signal: AbortSignal) => { if (!uuid(operationId))
            throw bad(); return request('/operations/' + operationId, signal); },
    };
}
export interface PackageReuseState {
    phase: 'idle' | 'reviewing' | 'reviewed' | 'applying' | 'recovering' | 'uncertain' | 'saved' | 'error' | 'session-ended';
    review: ReuseReview | null;
    result: ReuseReceipt | null;
    operationId: string | null;
}
export const initialPackageReuse = (): PackageReuseState => ({ phase: 'idle', review: null, result: null, operationId: null });
export function createPackageReuse(deps: ReturnType<typeof packageReuseTransport> & {
    readPrincipal: () => string | null;
    subscribeSession: (listener: () => void) => () => void;
    newOperationId: () => string;
}) {
    let state = initialPackageReuse(), principal = deps.readPrincipal(), epoch = 0, disposed = false, active: AbortController | null = null;
    let selected: ReuseSelection[] = [], pendingCount = 0;
    const listeners = new Set<(state: PackageReuseState) => void>();
    const set = (next: PackageReuseState) => { state = next; if (!disposed)
        listeners.forEach(fn => fn(state)); };
    const cancel = () => { epoch++; active?.abort(); active = null; };
    const invalidate = () => { cancel(); selected = []; set({ ...initialPackageReuse(), phase: 'session-ended' }); };
    const unsubscribe = deps.subscribeSession(invalidate);
    const busy = () => ['reviewing', 'applying', 'recovering'].includes(state.phase);
    async function run(kind: 'review' | 'apply' | 'recover', work: (signal: AbortSignal) => Promise<void>) {
        if (disposed || busy() || state.phase === 'session-ended')
            return;
        if (!principal || deps.readPrincipal() !== principal) {
            invalidate();
            return;
        }
        cancel();
        const flight = epoch, controller = new AbortController();
        active = controller;
        set({ ...state, phase: kind === 'review' ? 'reviewing' : kind === 'apply' ? 'applying' : 'recovering', result: null });
        const current = () => !disposed && epoch === flight && !controller.signal.aborted;
        const timeout = setTimeout(() => { if (current()) {
            cancel();
            set({ ...state, review: null, phase: kind === 'review' ? 'error' : 'uncertain' });
        } }, 25000);
        try {
            await work(controller.signal);
        }
        catch (error) {
            if (current()) {
                if (deps.readPrincipal() !== principal)
                    invalidate();
                else
                    set({ ...state, review: null, result: null, phase: kind === 'recover' || kind === 'apply' && !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) ? 'uncertain' : 'error' });
            }
        }
        finally {
            clearTimeout(timeout);
            if (active === controller)
                active = null;
        }
        return { current, controller };
    }
    // Work checks this guard before publishing any private response or confirmed write.
    const guarded = (signal: AbortSignal) => !disposed && !signal.aborted && deps.readPrincipal() === principal;
    return {
        subscribe(fn: (state: PackageReuseState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
        clear() { if (!busy() && state.phase !== 'uncertain' && state.phase !== 'session-ended') {
            cancel();
            selected = [];
            set(initialPackageReuse());
        } },
        async review(rows: ReuseSelection[]) {
            if (busy() || state.phase === 'uncertain' || state.phase === 'session-ended' || disposed)
                return;
            try {
                selected = canonicalReuseSelection(rows);
            }
            catch {
                set({ ...initialPackageReuse(), phase: 'error' });
                return;
            }
            await run('review', async (signal) => { const review = parseReuseReview(await deps.review(selected, signal), selected); if (!guarded(signal)) {
                if (!disposed && !signal.aborted)
                    invalidate();
                return;
            } set({ ...initialPackageReuse(), phase: 'reviewed', review }); });
        },
        async apply(confirmed: boolean) {
            if (!confirmed || state.phase !== 'reviewed' || !state.review?.can_apply)
                return;
            const review = state.review;
            let operationId: string;
            try {
                operationId = deps.newOperationId();
                if (!uuid(operationId))
                    throw bad();
                operationId = operationId.toLowerCase();
            }
            catch {
                set({ ...initialPackageReuse(), phase: 'error' });
                return;
            }
            pendingCount = selected.length;
            set({ ...state, operationId });
            await run('apply', async (signal) => { const result = receipt(await deps.apply(selected, review.review_token, operationId, signal), operationId, pendingCount, true); if (!guarded(signal)) {
                if (!disposed && !signal.aborted)
                    invalidate();
                return;
            } set({ phase: 'saved', review: null, result, operationId }); });
        },
        async recover() {
            if (state.phase !== 'uncertain' || !state.operationId)
                return;
            const operationId = state.operationId;
            await run('recover', async (signal) => { const raw = await deps.status(operationId, signal); if (!exact(raw, ['operation']))
                throw bad(); const result = raw.operation === null ? null : receipt(raw.operation, operationId, pendingCount, false); if (!guarded(signal)) {
                if (!disposed && !signal.aborted)
                    invalidate();
                return;
            } set({ phase: result ? 'saved' : 'uncertain', review: null, result, operationId }); });
        },
        invalidate, dispose() { disposed = true; cancel(); unsubscribe(); selected = []; listeners.clear(); },
    };
}
