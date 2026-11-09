import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
export interface OperationsGroup { id: string; name: string; active: boolean; course_name: string; course_active: boolean; branch_scope: 'tenant' | 'active_branch' | 'unavailable'; branch_name: string | null }
export interface CenterOperations { checked_at: string; groups: OperationsGroup[]; next_cursor: string | null; team: { active_memberships: number; teaching_memberships: number; other_memberships: number } }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const name = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 255;
export function parseCenterOperations(raw: any, after: string | null): CenterOperations {
  if (!exact(raw, ['checked_at', 'groups', 'next_cursor', 'team']) || typeof raw.checked_at !== 'string' || !Number.isFinite(Date.parse(raw.checked_at)) || new Date(raw.checked_at).toISOString() !== raw.checked_at
    || !Array.isArray(raw.groups) || raw.groups.length > 25 || !(raw.next_cursor === null || uuid(raw.next_cursor)) || !exact(raw.team, ['active_memberships', 'teaching_memberships', 'other_memberships'])
    || Object.values(raw.team).some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 500)
    || raw.team.teaching_memberships + raw.team.other_memberships !== raw.team.active_memberships) throw Error('Invalid center operations');
  const groups: OperationsGroup[] = raw.groups.map((g: any, i: number) => {
    if (!exact(g, ['id', 'name', 'active', 'course_name', 'course_active', 'branch_scope', 'branch_name']) || !uuid(g.id) || !name(g.name) || !name(g.course_name) || typeof g.active !== 'boolean' || typeof g.course_active !== 'boolean'
      || !['tenant', 'active_branch', 'unavailable'].includes(g.branch_scope) || (g.branch_scope === 'active_branch' ? !name(g.branch_name) : g.branch_name !== null)
      || g.id.toLowerCase() <= (i ? raw.groups[i - 1].id.toLowerCase() : after?.toLowerCase() ?? '')) throw Error('Invalid center group');
    return { ...g };
  });
  if (raw.next_cursor !== null && (groups.length !== 25 || raw.next_cursor !== groups[24].id)) throw Error('Invalid center cursor');
  return { checked_at: raw.checked_at, groups, next_cursor: raw.next_cursor, team: { ...raw.team } };
}
export async function readCenterOperations(after: string | null, signal: AbortSignal): Promise<CenterOperations> {
  if (after !== null && !uuid(after)) throw Error('Invalid cursor');
  const response = await authenticatedApiFetch('/tenants/me/catalog/operations' + (after ? '?groups_after=' + encodeURIComponent(after) : ''), { signal });
  const raw = await readAuthenticatedApiJson(response);
  if (!response.ok) throw new ApiRequestError('Center operations unavailable', response.status);
  return parseCenterOperations(raw, after);
}
export interface OperationsState { phase: 'idle' | 'loading' | 'ready' | 'error' | 'denied' | 'session-ended'; data: CenterOperations | null }
export const initialOperations = (): OperationsState => ({ phase: 'idle', data: null });
export function createCenterOperations(deps: { read: typeof readCenterOperations; readPrincipal(): string | null; subscribeSession(fn: () => void): () => void }) {
  let state = initialOperations(), disposed = false, epoch = 0, currentPage: string | null = null, active: AbortController | null = null;
  const principal = deps.readPrincipal(), listeners = new Set<(s: OperationsState) => void>();
  const set = (s: OperationsState) => { state = s; if (!disposed) listeners.forEach(fn => fn(s)); };
  const cancel = () => { epoch++; active?.abort(); active = null; };
  const invalidate = () => { cancel(); set({ phase: 'session-ended', data: null }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  async function load(after: string | null) {
    if (disposed || state.phase === 'session-ended') return;
    if (!principal || principal !== deps.readPrincipal()) { invalidate(); return; }
    cancel(); const generation = epoch, c = new AbortController(); active = c; currentPage = after;
    const current = () => !disposed && generation === epoch && !c.signal.aborted;
    set({ phase: 'loading', data: null });
    const timeout = setTimeout(() => { if (current()) { cancel(); set({ phase: 'error', data: null }); } }, 25000);
    try { const data = await deps.read(after, c.signal); if (!current()) return; if (principal !== deps.readPrincipal()) { invalidate(); return; } set({ phase: 'ready', data }); }
    catch (error) { if (current()) { if (principal !== deps.readPrincipal()) invalidate(); else set({ phase: error instanceof ApiRequestError && [401, 403, 404].includes(error.status) ? 'denied' : 'error', data: null }); } }
    finally { clearTimeout(timeout); }
  }
  return { subscribe(fn: (s: OperationsState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    first: () => load(null), refresh: () => load(currentPage), next: () => state.phase === 'ready' && state.data?.next_cursor ? load(state.data.next_cursor) : Promise.resolve(),
    invalidate, dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialOperations(); } };
}
