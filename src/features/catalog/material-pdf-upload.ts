import { ApiRequestError } from '../../lib/api-http';
export interface OwnerPdfFile { file_id: string; material_id: string; size_bytes: number; upload_status: 'reserved' | 'stored' | 'complete'; scan_status: 'pending' | 'clean' | 'rejected'; source_status: 'active' | 'revoked' }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const exact = (x: unknown, keys: string[]): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(x, key));
const bad = () => new Error('استجابة ملف المادة غير صالحة. حدّث الحالة للتحقق.');
export function parseOwnerPdfFile(x: unknown, materialId: string): OwnerPdfFile {
  if (!exact(x, ['file_id','material_id','size_bytes','upload_status','scan_status','source_status'])
    || typeof x.file_id !== 'string' || !uuid.test(x.file_id) || typeof x.material_id !== 'string' || !uuid.test(x.material_id) || x.material_id.toLowerCase() !== materialId.toLowerCase()
    || typeof x.size_bytes !== 'number' || !Number.isSafeInteger(x.size_bytes) || x.size_bytes < 5 || x.size_bytes > 10 * 1024 * 1024
    || typeof x.upload_status !== 'string' || !['reserved','stored','complete'].includes(x.upload_status)
    || typeof x.scan_status !== 'string' || !['pending','clean','rejected'].includes(x.scan_status)
    || typeof x.source_status !== 'string' || !['active','revoked'].includes(x.source_status) || x.upload_status !== 'complete' && x.scan_status !== 'pending') throw bad();
  return { file_id: x.file_id, material_id: x.material_id, size_bytes: x.size_bytes,
    upload_status: x.upload_status as OwnerPdfFile['upload_status'], scan_status: x.scan_status as OwnerPdfFile['scan_status'], source_status: x.source_status as OwnerPdfFile['source_status'] };
}
export function parseOwnerPdfStatus(x: unknown, materialId: string) {
  if (!exact(x, ['file','capabilities','retry_request_id']) || !exact(x.capabilities, ['upload','scan'])
    || typeof x.capabilities.upload !== 'boolean' || typeof x.capabilities.scan !== 'boolean'
    || x.capabilities.scan && !x.capabilities.upload
    || !(x.retry_request_id === null || typeof x.retry_request_id === 'string' && uuid.test(x.retry_request_id))) throw bad();
  const file = x.file === null ? null : parseOwnerPdfFile(x.file, materialId);
  if (x.retry_request_id !== null && (!file || file.upload_status === 'complete' || file.source_status !== 'active')) throw bad();
  return { file, uploadConfigured: x.capabilities.upload, scanConfigured: x.capabilities.scan, retryId: x.retry_request_id as string | null };
}
export interface OwnerPdfState { phase: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable' | 'denied' | 'session-ended';
  file: OwnerPdfFile | null; uploadConfigured: boolean; scanConfigured: boolean; busy: boolean; uncertain: boolean; retryable: boolean; error: string | null; notice: string | null }
export const initialOwnerPdfState = (): OwnerPdfState => ({ phase: 'idle', file: null, uploadConfigured: false, scanConfigured: false,
  busy: false, uncertain: false, retryable: false, error: null, notice: null });
export function createOwnerPdfController(materialId: string, deps: {
  status(signal: AbortSignal): Promise<unknown>; upload(file: Blob, requestId: string, signal: AbortSignal): Promise<unknown>;
  revoke(signal: AbortSignal): Promise<unknown>;
  readPrincipal(): string | null; subscribeSession(fn: () => void): () => void; makeRequestId(): string;
}) {
  let state = initialOwnerPdfState(), epoch = 0, disposed = false, requestId: string | null = null;
  const principal = deps.readPrincipal(), abort = new AbortController(), listeners = new Set<(s: OwnerPdfState) => void>();
  const set = (patch: Partial<OwnerPdfState>) => { state = { ...state, ...patch }; if (!disposed) listeners.forEach(fn => fn(state)); };
  const invalidate = () => { epoch++; requestId = null; abort.abort(); set({ ...initialOwnerPdfState(), phase: 'session-ended', error: 'تغيّرت الجلسة. أغلق لوحة الملف وافتحها من جديد.' }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  const current = (ticket: number) => {
    if (disposed || ticket !== epoch) return false;
    if (!principal || principal !== deps.readPrincipal()) { invalidate(); return false; } return true;
  };
  const claim = () => {
    if (disposed || state.busy || state.phase === 'session-ended') return null;
    if (!principal || principal !== deps.readPrincipal()) { invalidate(); return null; }
    set({ busy: true, error: null }); return ++epoch;
  };
  const denied = (e: unknown) => e instanceof ApiRequestError && [401,403,404].includes(e.status);
  const resetFailure = (e: unknown) => {
    if (denied(e)) { requestId = null; set({ ...initialOwnerPdfState(), phase: 'denied', error: 'لا يمكن إدارة ملف هذه المادة بالحساب الحالي.' }); }
    else set({ ...initialOwnerPdfState(), phase: e instanceof ApiRequestError && e.code === 'MATERIAL_FILE_UPLOAD_UNAVAILABLE' ? 'unavailable' : 'error',
      error: 'تعذّر تحميل حالة الملف أو أن الرفع غير متاح في هذه البيئة.' });
  };
  return {
    getState: () => state,
    subscribe(fn: (s: OwnerPdfState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async load() {
      const ticket = claim(); if (ticket === null) return;
      set({ phase: 'loading', file: null, uploadConfigured: false, scanConfigured: false });
      try {
        const result = parseOwnerPdfStatus(await deps.status(abort.signal), materialId); if (!current(ticket)) return;
        requestId = result.retryId ?? (result.file ? null : requestId);
        set({ phase: 'ready', file: result.file, uploadConfigured: result.uploadConfigured, scanConfigured: result.scanConfigured,
          uncertain: false, retryable: !!requestId, error: null });
      } catch (e) { if (current(ticket)) resetFailure(e); }
      finally { if (current(ticket)) set({ busy: false }); }
    },
    async upload(file: Blob | null): Promise<boolean> {
      if (state.phase !== 'ready' || !state.uploadConfigured || state.uncertain
        || state.file && (state.file.upload_status === 'complete' || !state.retryable || state.file.source_status !== 'active'
          || state.file.upload_status === 'stored' && !state.scanConfigured)) return false;
      const ticket = claim(); if (ticket === null) return false;
      let sent = false;
      try {
        if (!file || !Number.isSafeInteger(file.size) || file.size < 5 || file.size > 10 * 1024 * 1024 || !['','application/pdf'].includes(file.type)) throw new Error('اختر PDF بحجم لا يتجاوز 10 ميجابايت.');
        const prefix = new Uint8Array(await file.slice(0,5).arrayBuffer()); if (!current(ticket)) return false;
        if (new TextDecoder().decode(prefix) !== '%PDF-') throw new Error('الملف المختار لا يحمل توقيع PDF الصحيح.');
        requestId ??= deps.makeRequestId(); if (!uuid.test(requestId)) { requestId = null; throw new Error('تعذّر تجهيز معرّف محاولة الرفع.'); }
        set({ retryable: true, notice: null }); sent = true;
        const result = await deps.upload(file, requestId, abort.signal); if (!current(ticket)) return false;
        if (!exact(result, ['file','unchanged']) || typeof result.unchanged !== 'boolean') throw bad();
        const saved = parseOwnerPdfFile(result.file, materialId);
        if (saved.upload_status === 'reserved' || saved.scan_status === 'rejected' || saved.source_status !== 'active'
          || saved.size_bytes !== file.size || state.file && saved.file_id !== state.file.file_id) throw bad();
        set({ file: saved, uncertain: false, notice: saved.scan_status === 'clean' ? 'تم تسجيل الملف ونتيجة فحصه. إتاحة التنزيل للطالب لها إعدادها المنفصل.'
          : 'تم حفظ الملف، وهو بانتظار الفحص ولن يُسلَّم للطلاب قبل اكتماله.' });
        return true;
      } catch (e) {
        if (!current(ticket)) return false;
        if (denied(e)) resetFailure(e);
        else set({ uncertain: sent, notice: null, error: sent ? 'تعذّر تأكيد نتيجة المحاولة. حدّث الحالة قبل الاستكمال، واستخدم الملف الأصلي نفسه.'
          : e instanceof Error ? e.message : 'تعذّر تجهيز الملف.' });
        return false;
      } finally { if (current(ticket)) set({ busy: false }); }
    },
    async revoke(): Promise<boolean> {
      if (state.phase !== 'ready' || !state.file || state.file.source_status !== 'active' || state.uncertain) return false;
      const ticket = claim(); if (ticket === null) return false;
      const previous = state.file;
      try {
        const response = await deps.revoke(abort.signal); if (!current(ticket)) return false;
        if (!exact(response, ['file','unchanged']) || typeof response.unchanged !== 'boolean') throw bad();
        const saved = parseOwnerPdfFile(response.file, materialId);
        if (saved.file_id !== previous.file_id || saved.size_bytes !== previous.size_bytes || saved.source_status !== 'revoked') throw bad();
        requestId = null;
        set({ file: saved, retryable: false, uncertain: false, error: null,
          notice: 'تم سحب مصدر PDF. لن يُعرض للتنزيل في القراءات التالية.' });
        return true;
      } catch (e) {
        if (!current(ticket)) return false;
        if (denied(e)) resetFailure(e);
        else set({ uncertain: true, error: 'تعذّر تأكيد نتيجة السحب. حدّث حالة الملف قبل أي إجراء آخر.', notice: null });
        return false;
      } finally { if (current(ticket)) set({ busy: false }); }
    },
    invalidate,
    dispose() { if (disposed) return; disposed = true; epoch++; requestId = null; abort.abort(); unsubscribe(); listeners.clear(); state = initialOwnerPdfState(); },
  };
}
