import { ApiRequestError } from '../../lib/api-http';

export interface LessonMaterialOption { material_id: string; title: string; material_type: string; is_published: boolean }
export interface LessonContent { content_id: string; material_id: string; title: string; material_type: string; display_order: number }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: unknown, keys: string[]): x is Record<string, unknown> => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(x, k));
const validId = (x: unknown): x is string => typeof x === 'string' && uuid.test(x);
const material = (x: Record<string, unknown>) => validId(x.material_id) && typeof x.title === 'string' && !!x.title.trim() && x.title.length <= 255
  && typeof x.material_type === 'string' && ['pdf', 'video', 'presentation', 'link', 'other'].includes(x.material_type);
const order = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 2147483647;
const malformed = () => new Error('استجابة محتويات الدرس غير صالحة؛ حدّث القائمة للتحقق.');
export function parseLessonContent(x: unknown): LessonContent {
  if (!exact(x, ['content_id', 'material_id', 'title', 'material_type', 'display_order']) || !material(x) || !validId(x.content_id) || !order(x.display_order)) throw malformed();
  return { content_id: x.content_id, material_id: x.material_id as string, title: x.title as string, material_type: x.material_type as string, display_order: x.display_order };
}
export function parseLessonContents(x: unknown): LessonContent[] {
  if (!exact(x, ['contents']) || !Array.isArray(x.contents) || x.contents.length > 20) throw malformed();
  const rows = x.contents.map(parseLessonContent);
  for (const key of ['content_id', 'material_id', 'display_order'] as const) {
    if (new Set(rows.map(row => String(row[key]).toLowerCase())).size !== rows.length) throw malformed();
  }
  if (rows.some((row, i) => i > 0 && rows[i - 1].display_order >= row.display_order)) throw malformed();
  return rows;
}
export function parseLessonMaterialOptions(x: unknown, cursor: string | null) {
  if (!exact(x, ['materials', 'next_cursor']) || !Array.isArray(x.materials) || x.materials.length > 25
    || !(x.next_cursor === null || validId(x.next_cursor))) throw malformed();
  const rows: LessonMaterialOption[] = x.materials.map(row => {
    if (!exact(row, ['material_id', 'title', 'material_type', 'is_published']) || !material(row) || typeof row.is_published !== 'boolean') throw malformed();
    return { material_id: row.material_id as string, title: row.title as string, material_type: row.material_type as string, is_published: row.is_published };
  });
  const nextCursor = x.next_cursor as string | null;
  if (rows.some((row, i) => row.material_id.toLowerCase() <= (i ? rows[i - 1].material_id.toLowerCase() : cursor?.toLowerCase() ?? ''))
    || (nextCursor !== null && (rows.length !== 25 || nextCursor.toLowerCase() !== rows[rows.length - 1]?.material_id.toLowerCase()))) throw malformed();
  return { rows, nextCursor };
}
export interface LessonContentsApi {
  list(): Promise<unknown>;
  options(cursor: string | null): Promise<unknown>;
  attach(input: { material_id: string; display_order: number }): Promise<unknown>;
  detach(contentId: string): Promise<unknown>;
  readPrincipal(): string | null;
  subscribeSession(listener: () => void): () => void;
}
export interface LessonContentsState {
  phase: 'idle' | 'ready' | 'error' | 'denied' | 'unavailable' | 'session-ended';
  contents: LessonContent[]; options: LessonMaterialOption[]; nextCursor: string | null;
  busy: boolean; stale: boolean; error: string | null; optionsError: string | null; notice: string | null;
}
export const initialLessonContentsState = (): LessonContentsState => ({ phase: 'idle', contents: [], options: [], nextCursor: null,
  busy: false, stale: true, error: null, optionsError: null, notice: null });

/** One immutable lesson per controller. No request starts until the owner opens its panel. */
export function createLessonContentsController(api: LessonContentsApi) {
  let state = initialLessonContentsState();
  let epoch = 0, disposed = false;
  let principal = api.readPrincipal();
  const listeners = new Set<(s: LessonContentsState) => void>();
  const publish = (patch: Partial<LessonContentsState>) => {
    state = { ...state, ...patch }; if (!disposed) listeners.forEach(fn => fn(state));
  };
  const invalidate = () => { epoch++; publish({ ...initialLessonContentsState(), phase: 'session-ended', error: 'تغيّرت الجلسة. أغلق محتويات الدرس وافتحها من جديد.' }); };
  const unsubscribe = api.subscribeSession(invalidate);
  const current = (ticket: number) => {
    if (disposed || epoch !== ticket) return false;
    if (!principal || api.readPrincipal() !== principal) { invalidate(); return false; }
    return true;
  };
  const claim = () => {
    if (disposed || state.busy || state.phase === 'session-ended') return null;
    if (!principal || api.readPrincipal() !== principal) { invalidate(); return null; }
    publish({ busy: true, error: null }); return ++epoch;
  };
  const denied = (e: unknown) => e instanceof ApiRequestError && [401, 403, 404].includes(e.status);
  const failure = (e: unknown, patch: Partial<LessonContentsState> = {}) => {
    if (denied(e)) { publish({ ...initialLessonContentsState(), phase: 'denied', error: 'لا يمكن إدارة محتويات هذا الدرس بالحساب الحالي.' }); return; }
    if (e instanceof ApiRequestError && e.code === 'LESSON_CONTENTS_UNAVAILABLE') {
      publish({ ...initialLessonContentsState(), phase: 'unavailable', error: 'إدارة محتويات الدرس غير متاحة حاليًا في هذه البيئة.' }); return;
    }
    publish({ error: e instanceof Error ? e.message : 'تعذّرت العملية.', ...patch });
  };
  const read = async (ticket: number) => {
    try {
      const rows = parseLessonContents(await api.list()); if (!current(ticket)) return false;
      publish({ contents: rows, phase: 'ready', stale: false, error: null }); return true;
    } catch (e) { if (current(ticket)) failure(e, { stale: true, phase: state.phase === 'ready' ? 'ready' : 'error' }); return false; }
  };
  const readOptions = async (ticket: number, cursor: string | null) => {
    try {
      const result = parseLessonMaterialOptions(await api.options(cursor), cursor); if (!current(ticket)) return;
      publish({ options: result.rows, nextCursor: result.nextCursor, optionsError: null });
    } catch (e) {
      if (!current(ticket)) return;
      if (denied(e) || e instanceof ApiRequestError && e.code === 'LESSON_CONTENTS_UNAVAILABLE') failure(e);
      else publish({ options: [], nextCursor: null, optionsError: 'تعذّر تحميل اختيارات المواد. أعد تحميل المواد.' });
    }
  };
  const refresh = async () => {
    const ticket = claim(); if (ticket === null) return;
    try { if (await read(ticket) && current(ticket)) await readOptions(ticket, null); }
    finally { if (current(ticket)) publish({ busy: false }); }
  };
  const options = async (next = false) => {
    const cursor = next ? state.nextCursor : null;
    if (next && !cursor || state.phase !== 'ready') return;
    const ticket = claim(); if (ticket === null) return;
    try { await readOptions(ticket, cursor); } finally { if (current(ticket)) publish({ busy: false }); }
  };
  const mutate = async (kind: 'attach' | 'detach', materialId: string, position?: string): Promise<boolean> => {
    if (state.phase !== 'ready' || state.stale) return false;
    let parsedOrder = 0;
    if (kind === 'attach') {
      const raw = position?.trim() ?? '';
      parsedOrder = Number(raw);
      if (!/^\d+$/.test(raw) || !order(parsedOrder)) { publish({ error: 'اكتب ترتيبًا صحيحًا من صفر إلى 2147483647.' }); return false; }
      if (!state.options.some(row => row.material_id === materialId) || state.contents.length >= 20
        || state.contents.some(row => row.material_id.toLowerCase() === materialId.toLowerCase() || row.display_order === parsedOrder)) {
        publish({ error: 'اختر مادة غير مرتبطة وموضعًا غير مستخدم؛ الحد 20 مادة.' }); return false;
      }
    } else if (!state.contents.some(row => row.content_id === materialId)) return false;
    const ticket = claim(); if (ticket === null) return false;
    let confirmed = false;
    try {
      const result = kind === 'attach' ? await api.attach({ material_id: materialId, display_order: parsedOrder }) : await api.detach(materialId);
      if (!current(ticket)) return false;
      if (kind === 'attach') {
        if (!exact(result, ['content', 'unchanged']) || typeof result.unchanged !== 'boolean') throw malformed();
        const row = parseLessonContent(result.content);
        if (row.material_id.toLowerCase() !== materialId.toLowerCase() || row.display_order !== parsedOrder) throw malformed();
      } else if (!exact(result, ['detached', 'content_id']) || result.detached !== true || result.content_id !== materialId) throw malformed();
      confirmed = true;
      publish({ notice: kind === 'attach' ? 'تم تأكيد ربط المادة بالدرس.' : 'تم تأكيد فك الربط؛ المادة الأصلية محفوظة.', stale: true });
      const refreshed = await read(ticket);
      if (!refreshed && current(ticket) && state.phase === 'ready') publish({ error: 'تم تأكيد الحفظ، لكن تعذّر تحديث القائمة. القائمة المعروضة قديمة؛ حدّثها قبل تعديل آخر.' });
      return true;
    } catch (e) {
      if (!current(ticket)) return false;
      const definite = e instanceof ApiRequestError && e.status >= 400 && e.status < 500 && e.code !== 'PERSISTENCE_UNCERTAIN';
      if (definite || e instanceof ApiRequestError && e.code === 'LESSON_CONTENTS_UNAVAILABLE') failure(e);
      else publish({ stale: true, notice: null, error: 'تعذّر تأكيد نتيجة الحفظ. حدّث القائمة للتحقق قبل أي محاولة أخرى.' });
      return confirmed;
    } finally { if (current(ticket)) publish({ busy: false }); }
  };
  return {
    getState: () => state,
    subscribe(fn: (s: LessonContentsState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    refresh, options, attach: (id: string, position: string) => mutate('attach', id, position), detach: (id: string) => mutate('detach', id),
    invalidate,
    dispose() { if (disposed) return; disposed = true; epoch++; unsubscribe(); listeners.clear(); state = initialLessonContentsState(); },
  };
}
