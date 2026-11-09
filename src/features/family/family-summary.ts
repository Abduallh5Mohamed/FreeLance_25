import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';

export interface FamilyLink { id: string; tenant_id: string; student_enrollment_id: string; status: 'active' | 'revoked'; version: number; created_at: string | null }
export type AttendanceState = 'present' | 'late' | 'absent' | 'excused' | 'unmarked';
export interface FamilySession { id: string; title: string; starts_at: string; ends_at: string }
export interface FamilySummary {
    checked_at: string;
    window: { from: string; now: string; to: string };
    child: { name: string; group: string | null; course: string | null };
    scope: 'current_group' | 'no_current_group';
    attendance: { sessions: Array<FamilySession & { state: AttendanceState }>; counts: Record<AttendanceState, number> };
    agenda: FamilySession[];
    next_action: 'check_attendance' | 'confirm_unmarked' | 'prepare_next_session' | 'contact_teacher' | 'no_action';
    grades: { status: 'unavailable'; reason: 'publication_contract_required' };
}
const states: AttendanceState[] = ['present', 'late', 'absent', 'excused', 'unmarked'];
const invalid = () => new Error('Invalid family response');
function object(raw: unknown, keys: string[]): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).sort().join(',') !== [...keys].sort().join(',')) throw invalid();
    return raw as Record<string, unknown>;
}
const id = (x: unknown): x is string => typeof x === 'string' && !!x && x.trim() === x && x.length <= 64;
const title = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x.length <= 255;
const instant = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)
    && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
export function parseFamilyLinks(raw: unknown): FamilyLink[] {
    if (!Array.isArray(raw) || raw.length > 200) throw invalid();
    const result = raw.map(item => {
        const r = object(item, ['id', 'tenant_id', 'student_enrollment_id', 'status', 'version', 'created_at']);
        if (!id(r.id) || !id(r.tenant_id) || !id(r.student_enrollment_id) || !['active', 'revoked'].includes(String(r.status))
            || !Number.isSafeInteger(r.version) || (r.version as number) < 0
            || r.created_at !== null && (typeof r.created_at !== 'string' || r.created_at.length > 40)) throw invalid();
        return r as unknown as FamilyLink;
    });
    if (new Set(result.map(r => r.id)).size !== result.length) throw invalid();
    return result;
}
export function parseFamilySummary(raw: unknown): FamilySummary {
    const r = object(raw, ['checked_at', 'window', 'child', 'scope', 'attendance', 'agenda', 'next_action', 'grades']);
    const w = object(r.window, ['from', 'now', 'to']), child = object(r.child, ['name', 'group', 'course']);
    const attendance = object(r.attendance, ['sessions', 'counts']), counts = object(attendance.counts, states);
    const grades = object(r.grades, ['status', 'reason']);
    if (!instant(r.checked_at) || !instant(w.from) || !instant(w.now) || !instant(w.to) || r.checked_at !== w.now
        || Date.parse(w.now) - Date.parse(w.from) !== 7 * 86400000 || Date.parse(w.to) - Date.parse(w.now) !== 7 * 86400000
        || !title(child.name) || !['current_group', 'no_current_group'].includes(String(r.scope))
        || grades.status !== 'unavailable' || grades.reason !== 'publication_contract_required'
        || !Array.isArray(attendance.sessions) || attendance.sessions.length > 100 || !Array.isArray(r.agenda) || r.agenda.length > 100) throw invalid();
    if (r.scope === 'current_group' ? !title(child.group) || !title(child.course) : child.group !== null || child.course !== null) throw invalid();
    const seen = new Set<string>(), actual = Object.fromEntries(states.map(s => [s, 0])) as Record<AttendanceState, number>;
    const readSession = (item: unknown, recent: boolean) => {
        const s = object(item, ['id', 'title', 'starts_at', 'ends_at', ...(recent ? ['state'] : [])]);
        if (!id(s.id) || !title(s.title) || !instant(s.starts_at) || !instant(s.ends_at) || s.ends_at <= s.starts_at || seen.has(s.id)
            || s.starts_at < String(recent ? w.from : w.now) || s.starts_at >= String(recent ? w.now : w.to)
            || recent && s.ends_at > String(w.now)) throw invalid();
        seen.add(s.id);
        if (recent) { if (!states.includes(s.state as AttendanceState)) throw invalid(); actual[s.state as AttendanceState]++; }
    };
    attendance.sessions.forEach(s => readSession(s, true)); r.agenda.forEach(s => readSession(s, false));
    if (states.some(s => counts[s] !== actual[s]) || r.scope === 'no_current_group' && (seen.size !== 0)) throw invalid();
    const action = r.scope === 'no_current_group' ? 'contact_teacher' : actual.absent ? 'check_attendance'
        : actual.unmarked ? 'confirm_unmarked' : r.agenda.length ? 'prepare_next_session' : 'no_action';
    if (r.next_action !== action) throw invalid();
    return r as unknown as FamilySummary;
}
export const familyTransport = {
    async links(signal: AbortSignal) {
        const response = await authenticatedApiFetch('/parent-links', { signal });
        const raw = await readAuthenticatedApiJson(response);
        if (!response.ok) throw new ApiRequestError('Family links unavailable', response.status);
        return parseFamilyLinks(raw);
    },
    async session(link: string, signal: AbortSignal) {
        if (!id(link)) throw invalid();
        const response = await authenticatedApiFetch('/parent-links/' + encodeURIComponent(link) + '/session', { method: 'POST', signal });
        const raw = await readAuthenticatedApiJson(response);
        if (!response.ok) throw new ApiRequestError('Family session unavailable', response.status);
        const r = object(raw, ['token', 'expires_at', 'expires_in']);
        if (typeof r.token !== 'string' || !/^pv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(r.token) || r.token.length > 4096
            || !instant(r.expires_at) || !Number.isInteger(r.expires_in) || (r.expires_in as number) < 0 || (r.expires_in as number) > 900
            || Date.parse(r.expires_at) <= Date.now() || Date.parse(r.expires_at) > Date.now() + 900000) throw invalid();
        return { token: r.token, expiresAt: r.expires_at };
    },
    async summary(token: string, signal: AbortSignal) {
        // Deliberately does not use the standard-login bearer or workspace headers.
        // Never put the scoped credential in a URL, storage, state or telemetry.
        const response = await fetch('/api/parent/family-summary', { method: 'GET', signal, cache: 'no-store',
            credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer ' + token } });
        if (!response.ok) throw new ApiRequestError('Family summary unavailable', response.status);
        return parseFamilySummary(await response.json());
    },
};
export interface FamilyState {
    phase: 'idle' | 'loading-links' | 'choose' | 'loading-child' | 'ready' | 'error' | 'expired' | 'session-ended';
    links: FamilyLink[]; selected: string | null; summary: FamilySummary | null;
    issue: 'unavailable' | 'access_lost' | 'request_failed' | null;
}
export const initialFamily = (): FamilyState => ({ phase: 'idle', links: [], selected: null, summary: null, issue: null });
export function createFamilyController(deps: {
    transport: typeof familyTransport; readPrincipal: () => string | null; subscribeSession: (fn: () => void) => () => void;
}) {
    let state = initialFamily(), disposed = false, epoch = 0, request: AbortController | null = null;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    const principal = deps.readPrincipal(), listeners = new Set<(s: FamilyState) => void>();
    const set = (s: FamilyState) => { state = s; if (!disposed) listeners.forEach(fn => fn(s)); };
    const cancel = () => { epoch++; request?.abort(); request = null; if (expiry) clearTimeout(expiry); expiry = null; };
    const invalidate = () => { cancel(); set({ ...initialFamily(), phase: 'session-ended' }); };
    const unsubscribe = deps.subscribeSession(invalidate);
    const allowed = () => {
        if (disposed || state.phase === 'session-ended') return false;
        if (!principal || deps.readPrincipal() !== principal) { invalidate(); return false; }
        return true;
    };
    async function run(link: string | null) {
        if (!allowed() || link !== null && !state.links.some(l => l.id === link && l.status === 'active')) return;
        cancel(); const currentEpoch = epoch, abort = new AbortController(); request = abort;
        const current = () => !disposed && currentEpoch === epoch && !abort.signal.aborted && allowed();
        set({ phase: link === null ? 'loading-links' : 'loading-child', links: link === null ? [] : state.links, selected: link, summary: null, issue: null });
        const timer = setTimeout(() => { if (current()) { cancel(); set({ ...state, phase: 'error', summary: null, issue: 'request_failed' }); } }, 25000);
        try {
            if (link === null) {
                const links = await deps.transport.links(abort.signal);
                if (current()) set({ ...initialFamily(), phase: 'choose', links });
            } else {
                const session = await deps.transport.session(link, abort.signal);
                if (!current()) return;
                const summary = await deps.transport.summary(session.token, abort.signal);
                if (!current()) return;
                const lifetime = Math.min(60000, Date.parse(session.expiresAt) - Date.now());
                if (lifetime <= 0) { set({ ...state, phase: 'expired', summary: null }); return; }
                set({ ...state, phase: 'ready', summary });
                // A bounded display lifetime limits stale private evidence; this
                // is not a real-time revocation subscription or background send.
                expiry = setTimeout(() => { if (current()) { cancel(); set({ ...state, phase: 'expired', summary: null }); } }, lifetime);
            }
        } catch (error) {
            if (current()) {
                const lost = link !== null && error instanceof ApiRequestError && [401, 403, 404].includes(error.status);
                set({ ...state, phase: 'error', summary: null,
                    selected: lost ? null : state.selected,
                    links: lost ? state.links.filter(item => item.id !== link) : state.links,
                    issue: lost ? 'access_lost' : error instanceof ApiRequestError && error.status === 503 ? 'unavailable' : 'request_failed' });
            }
        }
        finally { clearTimeout(timer); }
    }
    return {
        subscribe(fn: (s: FamilyState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
        loadLinks: () => run(null), select: (link: string) => run(link),
        refresh: () => state.selected ? run(state.selected) : run(null),
        clearView() { if (!allowed()) return; cancel(); set({ ...state, phase: 'expired', summary: null }); },
        invalidate,
        dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialFamily(); },
    };
}
