export interface ReturnFollowUp {
  context: { course_id: string; enrollment_id: string }; checked_at: string;
  plan: null | { id: string; version: number; status: 'active' | 'withdrawn'; steps: Array<
    { position: number; available: false } | { position: number; available: true; lesson_id: string; title: string; minutes: number | null; completed: boolean }> };
}
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(x);
const exact = (x: any, keys: string[]) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
export function parseReturnFollowUp(raw: any, courseId: string, enrollmentId: string): ReturnFollowUp {
  const fail = () => { throw Error('Invalid follow-up'); };
  if (!exact(raw, ['context', 'checked_at', 'plan']) || !exact(raw.context, ['course_id', 'enrollment_id']) || raw.context.course_id !== courseId || raw.context.enrollment_id !== enrollmentId
    || typeof raw.checked_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.checked_at) || !Number.isFinite(Date.parse(raw.checked_at)) || new Date(raw.checked_at).toISOString() !== raw.checked_at) return fail();
  const p = raw.plan;
  if (p === null) return raw;
  if (!exact(p, ['id', 'version', 'status', 'steps']) || !uuid(p.id) || !Number.isSafeInteger(p.version) || p.version < 1 || p.version > 2147483647
    || !['active', 'withdrawn'].includes(p.status) || !Array.isArray(p.steps) || p.steps.length > 3 || (p.status === 'active' ? p.steps.length === 0 : p.steps.length !== 0)) return fail();
  const ids = new Set();
  for (const [i, s] of p.steps.entries()) {
    if (s?.position !== i + 1 || typeof s.available !== 'boolean') return fail();
    if (!s.available) { if (!exact(s, ['position', 'available'])) return fail(); continue; }
    if (!exact(s, ['position', 'available', 'lesson_id', 'title', 'minutes', 'completed']) || !uuid(s.lesson_id) || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 255
      || s.minutes !== null && (!Number.isSafeInteger(s.minutes) || s.minutes < 1 || s.minutes > 180) || typeof s.completed !== 'boolean' || ids.has(s.lesson_id)) return fail();
    ids.add(s.lesson_id);
  }
  return raw;
}
