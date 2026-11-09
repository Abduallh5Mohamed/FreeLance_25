import { authenticatedApiFetch, readAuthenticatedApiJson, ApiRequestError } from '../../lib/api-http';
import type { PackageKind } from './lesson-package-preview';
export type PreparationIssue = 'source_unavailable' | 'quiz_version_required' | 'draft_source' | 'restricted_audience';
export interface PreparationItem {
  binding_id: string; kind: PackageKind; title: string | null; display_order: number | null;
  source_state: 'draft' | 'published' | 'ready' | 'unavailable'; audience: 'course' | 'restricted' | null;
  quiz_version: 'published' | 'missing' | 'unavailable' | null; issue: PreparationIssue | null;
}
export interface Preparation {
  context: { course_id: string; unit_id: string; lesson_id: string }; checked_at: string;
  lesson: { title: string; status: 'active' | 'archived'; unit_status: 'active' | 'archived'; release_at: string | null };
  rule_version: 'preparation-v1'; items: PreparationItem[]; learning_evidence: 'insufficient';
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
const iso = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const invalid = () => Error('Invalid preparation evidence');
const kinds = ['material', 'video', 'homework', 'quiz', 'announcement'];
export function parsePreparation(raw: any, context: Preparation['context']): Preparation {
  if (!exact(raw, ['context', 'checked_at', 'lesson', 'rule_version', 'items', 'learning_evidence']) || !exact(raw.context, ['course_id', 'unit_id', 'lesson_id'])
    || !Object.keys(context).every(key => raw.context[key] === context[key as keyof typeof context] && uuid(raw.context[key]))
    || !iso(raw.checked_at) || raw.rule_version !== 'preparation-v1' || raw.learning_evidence !== 'insufficient'
    || !exact(raw.lesson, ['title', 'status', 'unit_status', 'release_at']) || typeof raw.lesson.title !== 'string' || !raw.lesson.title.trim() || raw.lesson.title.length > 255
    || !['active', 'archived'].includes(raw.lesson.status) || !['active', 'archived'].includes(raw.lesson.unit_status)
    || raw.lesson.release_at !== null && !iso(raw.lesson.release_at) || !Array.isArray(raw.items) || raw.items.length > 23) throw invalid();
  for (const item of raw.items) {
    if (!exact(item, ['binding_id', 'kind', 'title', 'display_order', 'source_state', 'audience', 'quiz_version', 'issue']) || !uuid(item.binding_id) || !kinds.includes(item.kind)
      || !['draft', 'published', 'ready', 'unavailable'].includes(item.source_state) || !['course', 'restricted', null].includes(item.audience)
      || !['published', 'missing', 'unavailable', null].includes(item.quiz_version)
      || (item.source_state === 'unavailable' ? item.title !== null || item.audience !== null || item.quiz_version !== null
        : typeof item.title !== 'string' || !item.title.trim() || item.title.length > 255 || item.audience === null)
      || (['material', 'video'].includes(item.kind) ? !Number.isInteger(item.display_order) || item.display_order < 0 || item.display_order > 2147483647 : item.display_order !== null)
      || (item.kind !== 'quiz' && item.quiz_version !== null) || item.kind === 'quiz' && item.source_state !== 'unavailable' && item.quiz_version === null
      || item.source_state !== 'unavailable' && (item.kind === 'video' ? item.source_state !== 'ready' : !['draft', 'published'].includes(item.source_state))
      || ['material', 'video'].includes(item.kind) && item.audience !== null && item.audience !== 'course'
      || item.kind === 'announcement' && item.audience !== null && item.audience !== 'restricted') throw invalid();
    const issue = item.source_state === 'unavailable' ? 'source_unavailable' : item.kind === 'quiz' && item.quiz_version !== 'published' ? 'quiz_version_required'
      : item.source_state === 'draft' ? 'draft_source' : item.audience === 'restricted' ? 'restricted_audience' : null;
    if (item.issue !== issue) throw invalid();
  }
  const media = raw.items.filter((x: PreparationItem) => x.display_order !== null);
  if (new Set(raw.items.map((x: PreparationItem) => x.binding_id.toLowerCase())).size !== raw.items.length || media.length > 20
    || new Set(media.map((x: PreparationItem) => x.display_order)).size !== media.length
    || ['homework', 'quiz', 'announcement'].some(kind => raw.items.filter((x: PreparationItem) => x.kind === kind).length > 1)) throw invalid();
  // Never pass unexpected raw fields through even if response types evolve.
  return raw as Preparation;
}
export function preparationReader(courseId: string, unitId: string, lessonId: string) {
  if (![courseId, unitId, lessonId].every(uuid)) throw invalid();
  const context = { course_id: courseId.toLowerCase(), unit_id: unitId.toLowerCase(), lesson_id: lessonId.toLowerCase() };
  return async (signal: AbortSignal) => {
    const response = await authenticatedApiFetch(`/tenants/me/catalog/courses/${context.course_id}/units/${context.unit_id}/lessons/${context.lesson_id}/preparation`, { signal, cache: 'no-store' });
    const raw = await readAuthenticatedApiJson(response);
    if (!response.ok) throw new ApiRequestError('Preparation unavailable', response.status);
    return parsePreparation(raw, context);
  };
}
export interface PreparationState {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended'; data: Preparation | null; evidenceId: string | null;
  decisions: Record<string, { choice: 'use' | 'dismiss'; note: string }>;
}
export const initialPreparation = (): PreparationState => ({ phase: 'idle', data: null, evidenceId: null, decisions: {} });
/** Read-only evidence; editorial decisions are session-memory drafts only. */
export function createPreparation(deps: { read: (signal: AbortSignal) => Promise<Preparation>; readPrincipal: () => string | null; subscribeSession: (fn: () => void) => () => void }) {
  let state = initialPreparation(), active: AbortController | null = null, epoch = 0, disposed = false;
  const identity = deps.readPrincipal(), listeners = new Set<(value: PreparationState) => void>();
  const set = (value: PreparationState) => { state = value; if (!disposed) listeners.forEach(fn => fn(value)); };
  const cancel = () => { epoch++; active?.abort(); active = null; };
  const invalidate = () => { cancel(); set({ ...initialPreparation(), phase: 'session-ended' }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  const allowed = () => { if (disposed || state.phase === 'session-ended') return false; if (!identity || deps.readPrincipal() !== identity) { invalidate(); return false; } return true; };
  async function load(evidenceId: string | null) {
    if (!allowed()) return;
    if (evidenceId !== null && !state.data?.items.some(row => row.binding_id === evidenceId)) return;
    cancel(); const flight = epoch, controller = new AbortController(); active = controller;
    set({ ...initialPreparation(), phase: 'loading' });
    const current = () => !disposed && epoch === flight && !controller.signal.aborted && allowed();
    const timer = setTimeout(() => { if (current()) { cancel(); set({ ...initialPreparation(), phase: 'error' }); } }, 25000);
    try {
      const data = await deps.read(controller.signal);
      if (current()) set({ ...initialPreparation(), phase: 'ready', data, evidenceId: data.items.some(row => row.binding_id === evidenceId) ? evidenceId : null });
    } catch { if (current()) set({ ...initialPreparation(), phase: 'error' }); }
    finally { clearTimeout(timer); if (active === controller) active = null; }
  }
  return {
    subscribe(fn: (value: PreparationState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    refresh: () => load(null), openEvidence: (id: string) => load(id),
    decide(id: string, choice: 'use' | 'dismiss', note: string) {
      if (!allowed() || state.phase !== 'ready' || !state.data?.items.some(row => row.binding_id === id && row.issue !== null)
        || !['use', 'dismiss'].includes(choice) || typeof note !== 'string' || note.length > 500) return;
      set({ ...state, decisions: { ...state.decisions, [id]: { choice, note } } });
    },
    invalidate, dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialPreparation(); },
  };
}
