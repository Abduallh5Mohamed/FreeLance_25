import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
import { boundedRequest } from '../../lib/bounded-request';

export interface TeachingCourse { id: string; name: string }
export interface TeachingLesson { id: string; unit_id: string; title: string }
export interface TeachingPage<T> { items: T[]; next_cursor: string | null }
const id = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(x);
const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.sort().join(',');
export function parseTeachingPage(raw: any, lessons = false, after = ''): TeachingPage<TeachingCourse | TeachingLesson> {
  if (!exact(raw, ['items', 'next_cursor']) || !Array.isArray(raw.items) || raw.items.length > 25
    || raw.next_cursor !== null && !id(raw.next_cursor)) throw Error('Invalid teaching page');
  for (const [i, item] of raw.items.entries()) {
    const text = lessons ? item?.title : item?.name;
    if (!exact(item, lessons ? ['id', 'unit_id', 'title'] : ['id', 'name']) || !id(item.id) || lessons && !id(item.unit_id)
      || typeof text !== 'string' || !text.trim() || text.length > 255
      || item.id <= (i ? raw.items[i - 1].id : after)) throw Error('Invalid teaching choice');
  }
  if (raw.next_cursor !== null && (raw.items.length !== 25 || raw.next_cursor !== raw.items[24].id)) throw Error('Invalid teaching cursor');
  return raw;
}
export function teachingChoicesReader(courseId?: string) {
  if (courseId !== undefined && !id(courseId)) throw Error('Invalid teaching course');
  return async (cursor: string, signal: AbortSignal) => {
    if (cursor !== '' && !id(cursor)) throw Error('Invalid teaching cursor');
    const response = await authenticatedApiFetch(`/tenants/me/catalog/teaching/courses${courseId ? '/' + courseId + '/lessons' : ''}${cursor ? '?cursor=' + cursor : ''}`, { signal, cache: 'no-store' });
    const raw = await readAuthenticatedApiJson(response);
    if (!response.ok) throw new ApiRequestError('Teaching choices unavailable', response.status);
    return parseTeachingPage(raw, !!courseId, cursor);
  };
}

export interface TeachingChoicesState<T> {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended'; page: TeachingPage<T> | null;
}
/** Scope changes abort and erase prior data, even if a transport ignores cancellation. */
export function createTeachingChoices<T>(deps: {
  read(cursor: string, signal: AbortSignal): Promise<TeachingPage<T>>;
  readPrincipal(): string | null; subscribeSession(fn: () => void): () => void;
}) {
  let state: TeachingChoicesState<T> = { phase: 'idle', page: null }, epoch = 0, dead = false, active: AbortController | null = null;
  const principal = deps.readPrincipal(), listeners = new Set<(s: TeachingChoicesState<T>) => void>();
  const set = (s: TeachingChoicesState<T>) => { state = s; if (!dead) listeners.forEach(fn => fn(s)); };
  const cancel = () => { epoch++; active?.abort(); active = null; };
  const invalidate = () => { cancel(); set({ phase: 'session-ended', page: null }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  async function load(cursor = '') {
    if (dead || state.phase === 'session-ended') return;
    if (!principal || principal !== deps.readPrincipal()) { invalidate(); return; }
    cancel(); const flight = epoch, controller = new AbortController(); active = controller;
    set({ phase: 'loading', page: null });
    const current = () => { if (dead || epoch !== flight) return false; if (principal !== deps.readPrincipal()) { invalidate(); return false; } return true; };
    try { const page = await boundedRequest(controller, () => deps.read(cursor, controller.signal)); if (current()) set({ phase: 'ready', page }); }
    catch { if (current()) set({ phase: 'error', page: null }); }
    finally { if (active === controller) active = null; }
  }
  return {
    load, invalidate,
    subscribe(fn: (s: TeachingChoicesState<T>) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    dispose() { dead = true; cancel(); unsubscribe(); listeners.clear(); state = { phase: 'idle', page: null }; },
  };
}
