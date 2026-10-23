/**
 * M2-03 existing material management seam — the smallest production module
 * `src/pages/CourseContentManager.tsx` delegates to.
 *
 * It separates the testable orchestration (course/session/form/operation
 * lifetimes, single-flight writes, stale-reply invalidation, retained form and
 * delete target on failure, honest contract refusal) from React rendering.
 * Transport, the session notifier and the principal reader are injected, so the
 * exact production code the page runs is exercised hermetically in
 * node:test (src/tests/m2-material-management.test.ts) with no DB, network,
 * browser or live app.
 *
 * Contracts verified from source (documented in
 * docs/streams/client/M2-03-CONTRACTS.md):
 *  - GET /materials?course_id returns ONLY `is_published = TRUE` rows, so the
 *    list this page reads is the published projection (server/src/routes/
 *    materials.ts:179-186);
 *  - POST /materials requires course_id + title + material_type, and a
 *    `video` row is REFUSED unless `file_url` starts with `video://`
 *    (materials.ts:412-416). External video links are not accepted at all;
 *  - DELETE /materials/:id is a SOFT UNPUBLISH — `UPDATE course_materials SET
 *    is_published = FALSE` (materials.ts:557-565). It is not a hard delete, and
 *    the page must not claim that it is;
 *  - POST /materials/convert-drive-url is hard-wired to 410 "External video
 *    links are disabled" (materials.ts:577-578) — the Drive-embed conversion
 *    the page used to call cannot succeed for ANY caller. It is therefore not
 *    called: a non-video document link is stored exactly as typed (the server
 *    imposes no scheme restriction on non-video rows), and a video link is
 *    refused honestly instead of being rewritten;
 *  - every failure throws the server's `error` string WITHOUT the status code
 *    (api-http.ts:69-89), so only the documented message may classify it.
 *
 * Lifetimes fenced here:
 *  - course: every selection advance invalidates every in-flight material
 *    reply, so A → B → A can never resurrect the first A's rows, and an empty
 *    selection CLEARS the previous list instead of leaving it on screen;
 *  - session: the canonical principal (reused from the accepted M2-02 reader —
 *    one canonical session lifetime, no 32-bit digest, no historical registry)
 *    is re-read at claim AND commit time;
 *  - form: a submit started by a form incarnation that was since closed,
 *    replaced or reset can never commit, close or clear a newer one;
 *  - operation: a synchronous latch is acquired before the first await, so a
 *    duplicate create/delete fired before the re-render never reaches the
 *    transport, and an older `finally` can never free or clear a newer
 *    operation's latch/busy marker;
 *  - retry: the page's Retry action is dispatched by what is on screen — a
 *    selection that already holds confirmed rows is re-read as a REFRESH (a
 *    failed read is reported beside those rows), a selection with no confirmed
 *    rows is re-read as an initial load with its honest loading/empty/error
 *    outcome.
 *
 * Out of scope by construction: no shared helper/auth/router/backend/package/
 * schema edit, no upload/provider/DRM/M3 feature, no invented video id, no new
 * publishing policy, no local role or financial authority.
 */
import type { Course, CourseMaterial, Grade, Group } from '../../lib/api-http';
import {
  createCourseOperationGuard,
  createCourseSequence,
  createTicketSource,
  readCourseSessionPrincipal,
  type CourseSessionStorage,
} from './course-management';

/**
 * The canonical session reader the page uses. Re-exported so the page imports
 * ONE principal boundary: M2-02's reader holds the single canonical
 * localStorage lifetime (exact canonical comparison, monotonic incarnation),
 * and a second parallel lifetime here would let the two pages disagree about
 * what "the same session" means.
 */
export { readCourseSessionPrincipal };
export type { CourseSessionStorage };

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** The only server-fixed strings these routes send (server/src/routes/
 *  materials.ts). The shared client throws the message alone, so these are the
 *  honest classification signals — a numeric HTTP status is never inferred. */
/** The page's own wording for a body that is not the documented array. */
export const MALFORMED_LIST_MESSAGE = 'استجابة غير صالحة من الخادم';

export const MATERIAL_NOT_FOUND_MESSAGE = 'Material not found';
export const COURSE_NOT_FOUND_MESSAGE = 'Course not found';
export const COURSE_OUT_OF_SCOPE_MESSAGE = 'Course is outside your teaching scope';
export const WORKSPACE_REQUIRED_MESSAGE = 'Workspace access required';
export const GROUPS_OUT_OF_SCOPE_MESSAGE = 'يجب ربط المادة بمجموعة من مجموعاتك فقط';
export const EXTERNAL_VIDEO_CREATE_MESSAGE =
  'External video links are not allowed. Upload the video to the platform.';
export const EXTERNAL_VIDEO_CONVERT_MESSAGE =
  'External video links are disabled. Upload videos to the platform.';

export type MaterialFailureKind = 'unavailable' | 'denied' | 'contract' | 'error';

export interface MaterialFailure {
  readonly kind: MaterialFailureKind;
  readonly message: string;
}

export function classifyMaterialFailure(cause: unknown): MaterialFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? 'حدث خطأ غير معروف');
  if (message === MATERIAL_NOT_FOUND_MESSAGE || message === COURSE_NOT_FOUND_MESSAGE) {
    return { kind: 'unavailable', message };
  }
  if (
    message === WORKSPACE_REQUIRED_MESSAGE ||
    message === COURSE_OUT_OF_SCOPE_MESSAGE ||
    message === GROUPS_OUT_OF_SCOPE_MESSAGE
  ) {
    return { kind: 'denied', message };
  }
  if (message === EXTERNAL_VIDEO_CREATE_MESSAGE || message === EXTERNAL_VIDEO_CONVERT_MESSAGE) {
    return { kind: 'contract', message };
  }
  return { kind: 'error', message };
}

// ---------------------------------------------------------------------------
// File URL contract (the honest external-video refusal)
// ---------------------------------------------------------------------------

/** The only scheme the server accepts for a `video` material. */
export const VIDEO_URL_SCHEME = 'video://';

export type MaterialUrlDecision =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'missing' | 'external-video'; readonly message: string };

/**
 * Decides what is actually sent as `file_url`.
 *
 * The page's placeholder suggests a Google Drive share link, but the server
 * refuses every external video link and the Drive-conversion endpoint is a
 * permanent 410. Rather than inventing an upload, a fake video id or a bypass,
 * a video row is only accepted when it already references the platform's
 * internal `video://` scheme; anything else is refused BEFORE a request is
 * made, with the server's own wording. Non-video documents keep working with
 * the URL the instructor typed (the server has no scheme restriction there).
 */
export function resolveMaterialFileUrl(
  materialType: CourseMaterial['material_type'],
  rawUrl: string | null | undefined
): MaterialUrlDecision {
  const url = (rawUrl ?? '').trim();
  if (!url) return { ok: false, reason: 'missing', message: 'يرجى إدخال رابط الملف.' };
  if (materialType === 'video' && !url.startsWith(VIDEO_URL_SCHEME)) {
    return {
      ok: false,
      reason: 'external-video',
      // Same meaning as the server's own refusal, in the page's language.
      message:
        'روابط الفيديو الخارجية غير مسموحة؛ يجب رفع الفيديو إلى المنصة أولًا. اختر نوع "ملف PDF" أو "عرض تقديمي" للروابط الخارجية.',
    };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Duration parsing contract
// ---------------------------------------------------------------------------

export type MaterialDurationError = 'malformed' | 'nonpositive' | 'nonfinite';

export type MaterialDurationResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly reason: MaterialDurationError };

/** Whole minutes only: the column is an integer and the input has always been
 *  `min="1"`. `parseInt('30abc') === 30` is exactly the partial read this
 *  rejects; blank stays blank (no new default, no invented duration). */
const WHOLE_MINUTES = /^\d+$/;

export function parseMaterialDuration(raw: string | number | null | undefined): MaterialDurationResult {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'nonfinite' };
    if (!Number.isInteger(raw)) return { ok: false, reason: 'malformed' };
    if (raw < 1) return { ok: false, reason: 'nonpositive' };
    return { ok: true, value: raw };
  }
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: undefined };
  if (!WHOLE_MINUTES.test(text)) return { ok: false, reason: 'malformed' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: 'nonfinite' };
  if (value < 1) return { ok: false, reason: 'nonpositive' };
  return { ok: true, value };
}

export function describeMaterialDurationError(reason: MaterialDurationError): string {
  if (reason === 'nonpositive') return 'المدة يجب أن تكون دقيقة واحدة على الأقل.';
  if (reason === 'nonfinite') return 'المدة غير صالحة؛ أدخل عددًا صحيحًا من الدقائق.';
  return 'المدة غير صحيحة؛ أدخل عددًا صحيحًا من الدقائق مثل 30.';
}

// ---------------------------------------------------------------------------
// Form validation and payload
// ---------------------------------------------------------------------------

export interface MaterialFormValues {
  title: string;
  description: string;
  material_type: CourseMaterial['material_type'];
  file_url: string;
  duration_minutes: string | number | null;
  is_free: boolean;
  grade_id: string;
  group_ids: string[];
}

export interface MaterialFieldErrors {
  title?: string;
  file_url?: string;
  duration_minutes?: string;
  grade_id?: string;
  group_ids?: string;
  course?: string;
}

export interface MaterialValidation {
  readonly ok: boolean;
  readonly fieldErrors: MaterialFieldErrors;
  /** True when the only reason for refusal is the server's external-video
   *  contract: the page shows it as a contract limitation, not a typo. */
  readonly externalVideoRejected: boolean;
}

export function validateMaterialForm(values: MaterialFormValues): MaterialValidation {
  const fieldErrors: MaterialFieldErrors = {};
  if (!(values.title ?? '').trim()) fieldErrors.title = 'عنوان المحتوى مطلوب.';

  const url = resolveMaterialFileUrl(values.material_type, values.file_url);
  if (url.ok === false) fieldErrors.file_url = url.message;

  const duration = parseMaterialDuration(values.duration_minutes);
  if (duration.ok === false) fieldErrors.duration_minutes = describeMaterialDurationError(duration.reason);

  if (!(values.grade_id ?? '').trim()) fieldErrors.grade_id = 'يرجى اختيار الصف الدراسي.';
  if (!Array.isArray(values.group_ids) || values.group_ids.length === 0) {
    fieldErrors.group_ids = 'يرجى اختيار مجموعة واحدة على الأقل.';
  }

  return {
    ok: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    externalVideoRejected: url.ok === false && url.reason === 'external-video',
  };
}

/** The exact create body the page has always sent, with the verified fixes:
 *  a strictly parsed duration (never a partial `parseInt`), the resolved
 *  file URL, and `is_published` pinned to the server's own published row. */
export interface MaterialWritePayload {
  course_id: string;
  title: string;
  description?: string;
  material_type: CourseMaterial['material_type'];
  file_url?: string;
  duration_minutes?: number;
  is_free: boolean;
  is_published: true;
  display_order: number;
  grade_id: string;
  group_ids: string[];
}

export function buildMaterialPayload(
  values: MaterialFormValues,
  courseId: string,
  displayOrder: number
): MaterialWritePayload {
  const url = resolveMaterialFileUrl(values.material_type, values.file_url);
  const duration = parseMaterialDuration(values.duration_minutes);
  const description = (values.description ?? '').trim();
  return {
    course_id: courseId,
    title: (values.title ?? '').trim(),
    ...(description ? { description } : {}),
    material_type: values.material_type,
    ...(url.ok ? { file_url: url.url } : {}),
    ...(duration.ok && duration.value !== undefined ? { duration_minutes: duration.value } : {}),
    is_free: Boolean(values.is_free),
    is_published: true,
    display_order: Number.isFinite(displayOrder) && displayOrder >= 0 ? Math.floor(displayOrder) : 0,
    grade_id: (values.grade_id ?? '').trim(),
    group_ids: Array.isArray(values.group_ids) ? [...values.group_ids] : [],
  };
}

// ---------------------------------------------------------------------------
// Preview lifetime (the player's ONLY source of truth)
// ---------------------------------------------------------------------------

/**
 * The one material the page is allowed to render in `VideoPlayer`, resolved
 * against the server-confirmed list on EVERY render.
 *
 * The page used to keep a private `{url, title}` copy captured at click time.
 * That copy sat outside every lifetime fence, so after a course switch, an
 * empty selection, a logout or a refresh that removed/unpublished the row the
 * player stayed mounted on a material the current scope no longer contains
 * (supervisor/070). The controller now stores only the material id, retires it
 * on every scope/session transition, and this resolver drops it as soon as the
 * row is no longer a video with a file URL inside THIS list — so a stale URL
 * cannot survive a new scope, and no new player/provider protocol is involved.
 */
export function resolvePreviewMaterial(
  materials: readonly CourseMaterial[],
  previewId: string | null
): CourseMaterial | null {
  if (!previewId) return null;
  const row = materials.find((material) => material && material.id === previewId);
  if (!row || row.material_type !== 'video' || !row.file_url) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type MaterialListPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type MaterialBusyKind = 'create' | 'delete' | 'refresh' | null;
export type MaterialCreateOutcome = 'created' | 'duplicate' | 'invalid' | 'rejected' | 'blocked' | 'failed';
export type MaterialDeleteOutcome = 'unpublished' | 'duplicate' | 'blocked' | 'failed';

export interface MaterialGradeOption {
  readonly id: string;
  readonly name: string;
}

export interface MaterialGroupOption {
  readonly id: string;
  readonly name: string;
  readonly grade_id: string;
}

export interface MaterialManagementState {
  phase: MaterialListPhase;
  materials: CourseMaterial[];
  courses: Course[];
  grades: MaterialGradeOption[];
  groups: MaterialGroupOption[];
  selectedCourse: string;
  busyKind: MaterialBusyKind;
  listError: string | null;
  coursesError: string | null;
  optionsError: string | null;
  createError: string | null;
  deleteError: string | null;
  /** A refresh that failed AFTER the server confirmed the write: reported
   *  separately so the page never presents it as a failed write. */
  refreshError: string | null;
  fieldErrors: MaterialFieldErrors;
  deleteTarget: CourseMaterial | null;
  createdId: string | null;
  /** The material the player may show — an ID only, resolved against
   *  `materials` by `resolvePreviewMaterial`. It is retired by every course and
   *  session transition and by any confirmed list that no longer contains it,
   *  so the player can never outlive its scope or its row. */
  previewMaterialId: string | null;
  /** Set when the external-video contract (not a typo) blocked the write. */
  contractNotice: string | null;
}

export interface MaterialManagementApi {
  loadCourses: () => Promise<Course[]>;
  loadGrades: () => Promise<Grade[]>;
  loadGroups: () => Promise<Group[]>;
  loadMaterials: (courseId: string) => Promise<CourseMaterial[]>;
  createMaterial: (payload: MaterialWritePayload) => Promise<CourseMaterial | void>;
  /** DELETE /materials/:id unpublishes; it never hard-deletes. */
  unpublishMaterial: (id: string) => Promise<void>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface MaterialManagementController {
  getState(): MaterialManagementState;
  subscribe(listener: (state: MaterialManagementState) => void): () => void;
  loadCourses(): Promise<void>;
  loadOptions(): Promise<void>;
  /** Selects a course and loads its published materials. An empty value
   *  DESELECTS: the previous list is cleared, never left on screen. */
  selectCourse(courseId: string): Promise<void>;
  /** Re-reads the current selection (the page's Retry action, on both the
   *  error block and the "list could not be updated" notice). It never erases
   *  a confirmed list: with rows on screen the reply is treated as a refresh
   *  and a failed/malformed read is reported beside those rows. */
  refresh(): Promise<void>;
  /** Opens a page-owned form incarnation; the returned number identifies THIS
   *  form, so a submit started by an older one cannot clear a newer one. */
  openForm(): number;
  closeForm(): void;
  isFormCurrent(instance: number): boolean;
  submit(values: MaterialFormValues, instance?: number): Promise<MaterialCreateOutcome>;
  requestDelete(material: CourseMaterial): void;
  cancelDelete(): void;
  confirmDelete(): Promise<MaterialDeleteOutcome>;
  /** Starts the player for a material of the CURRENT confirmed list. Ignored
   *  for an id that is not a playable video row of this selection. */
  requestPreview(materialId: string): void;
  closePreview(): void;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const initialState: MaterialManagementState = {
  phase: 'idle',
  materials: [],
  courses: [],
  grades: [],
  groups: [],
  selectedCourse: '',
  busyKind: null,
  listError: null,
  coursesError: null,
  optionsError: null,
  createError: null,
  deleteError: null,
  refreshError: null,
  fieldErrors: {},
  deleteTarget: null,
  createdId: null,
  previewMaterialId: null,
  contractNotice: null,
};

const createdIdOf = (created: CourseMaterial | void): string | null => {
  if (created && typeof created === 'object' && typeof created.id === 'string' && created.id) {
    return created.id;
  }
  return null;
};

export function createMaterialManagementController(
  api: MaterialManagementApi
): MaterialManagementController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: MaterialManagementState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** Materials list sequence: every selection and every list/refresh load
   *  advances it; a write only CAPTURES it, so the refresh a write starts can
   *  never invalidate the write that started it. */
  const materialsSequence = createCourseSequence();
  const coursesSequence = createCourseSequence();
  const optionsSequence = createCourseSequence();
  const loadGuard = createCourseOperationGuard(tickets);
  const coursesGuard = createCourseOperationGuard(tickets);
  const optionsGuard = createCourseOperationGuard(tickets);
  const writeGuard = createCourseOperationGuard(tickets);
  /** Ticket that owns `state.busyKind` (`null` when idle): only the owner may
   *  clear it, so a retired operation's late `finally` can never clear a NEWER
   *  operation's busy marker. */
  let busyOwner: number | null = null;
  /** Incarnation of the OPEN create form (page-owned). */
  let formTicket = 0;
  /** Incarnation of the OPEN delete confirmation. */
  let deleteTicket = 0;

  const patch = (changes: Partial<MaterialManagementState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);

  const track = (operation: Promise<unknown>): void => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
  };

  const clearBusy = (ticket: number): void => {
    if (busyOwner === ticket) {
      busyOwner = null;
      patch({ busyKind: null });
    }
  };

  /** A reply may commit only while it is still the one this page is waiting
   *  for: not disposed, same list generation, same canonical principal. */
  const isOperationCurrent = (generation: number, principal: string | null): boolean => {
    if (disposed || !materialsSequence.isCurrent(generation)) return false;
    return readPrincipal() === principal;
  };

  const isCoursesCurrent = (generation: number, principal: string | null): boolean => {
    if (disposed || !coursesSequence.isCurrent(generation)) return false;
    return readPrincipal() === principal;
  };

  const isOptionsCurrent = (generation: number, principal: string | null): boolean => {
    if (disposed || !optionsSequence.isCurrent(generation)) return false;
    return readPrincipal() === principal;
  };

  const isFormCurrent = (instance: number): boolean =>
    !disposed && instance !== 0 && instance === formTicket;

  const isDeleteCurrent = (ticket: number): boolean =>
    !disposed && ticket !== 0 && ticket === deleteTicket && state.deleteTarget !== null;

  /** Discards everything in flight and the latches they hold. */
  const retireInFlight = (): void => {
    materialsSequence.invalidate();
    coursesSequence.invalidate();
    optionsSequence.invalidate();
    loadGuard.release();
    coursesGuard.release();
    optionsGuard.release();
    writeGuard.release();
    formTicket = tickets.next();
    deleteTicket = tickets.next();
    busyOwner = null;
    // A preview belongs to the scope that opened it: it never survives the
    // session/scope that produced it.
    patch({ busyKind: null, previewMaterialId: null });
  };

  const runMaterialsLoad = async (courseId: string, kind: 'list' | 'refresh'): Promise<void> => {
    if (disposed) return;
    if (!courseId) return;
    if (!loadGuard.acquire()) return;
    const ticket = loadGuard.holder();
    const generation = materialsSequence.next();
    const principal = readPrincipal();
    if (kind === 'refresh') {
      busyOwner = ticket;
      patch({ busyKind: 'refresh', refreshError: null });
    } else {
      patch({ phase: 'loading', listError: null, refreshError: null });
    }
    try {
      const rows = await api.loadMaterials(courseId);
      if (!isOperationCurrent(generation, principal) || state.selectedCourse !== courseId) {
        clearBusy(ticket);
        return;
      }
      if (!Array.isArray(rows)) {
        // A malformed body is never an empty list. On a REFRESH it is a refresh
        // failure: the rows on screen are still the server's last confirmed
        // state (the write already succeeded), so they are kept and the failure
        // is reported separately — erasing them would present a confirmed write
        // as a lost one and invite a blind re-creation (supervisor/070).
        if (kind === 'refresh') {
          patch({ refreshError: MALFORMED_LIST_MESSAGE });
        } else {
          patch({
            phase: 'error',
            materials: [],
            listError: MALFORMED_LIST_MESSAGE,
            previewMaterialId: null,
          });
        }
        return;
      }
      const published = rows.filter((row) => row && row.is_published !== false);
      patch({
        phase: published.length > 0 ? 'ready' : 'empty',
        materials: published,
        listError: null,
        refreshError: null,
        // The preview may only point at a row that still exists in the
        // confirmed list (unpublished or removed rows close the player).
        previewMaterialId: resolvePreviewMaterial(published, state.previewMaterialId)
          ? state.previewMaterialId
          : null,
      });
    } catch (cause) {
      if (!isOperationCurrent(generation, principal) || state.selectedCourse !== courseId) {
        clearBusy(ticket);
        return;
      }
      const failure = classifyMaterialFailure(cause);
      if (kind === 'refresh') {
        // The list on screen is still the server's last confirmed state:
        // report the refresh, never rewrite the list, never invite a retry of
        // the write that already succeeded.
        patch({ refreshError: failure.message });
      } else {
        patch({ phase: 'error', materials: [], listError: failure.message });
      }
    } finally {
      clearBusy(ticket);
      loadGuard.release(ticket);
    }
  };

  const loadCourses = async (): Promise<void> => {
    if (disposed) return;
    if (!coursesGuard.acquire()) return;
    const ticket = coursesGuard.holder();
    const generation = coursesSequence.next();
    const principal = readPrincipal();
    try {
      const rows = await api.loadCourses();
      if (!isCoursesCurrent(generation, principal)) return;
      if (!Array.isArray(rows)) {
        patch({ courses: [], coursesError: MALFORMED_LIST_MESSAGE });
        return;
      }
      patch({
        courses: rows.filter((course) => course && course.is_active !== false),
        coursesError: null,
      });
    } catch (cause) {
      if (!isCoursesCurrent(generation, principal)) return;
      patch({ courses: [], coursesError: classifyMaterialFailure(cause).message });
    } finally {
      coursesGuard.release(ticket);
    }
  };

  const loadOptions = async (): Promise<void> => {
    if (disposed) return;
    if (!optionsGuard.acquire()) return;
    const ticket = optionsGuard.holder();
    const generation = optionsSequence.next();
    const principal = readPrincipal();
    try {
      const [grades, groups] = await Promise.all([api.loadGrades(), api.loadGroups()]);
      if (!isOptionsCurrent(generation, principal)) return;
      const activeGrades = (Array.isArray(grades) ? grades : []).filter(
        (grade) => grade && grade.is_active !== false
      );
      const activeGroups = (Array.isArray(groups) ? groups : []).filter(
        (group) => group && group.is_active !== false
      );
      patch({
        grades: activeGrades.map((grade) => ({ id: String(grade.id ?? ''), name: grade.name })),
        groups: activeGroups.map((group) => ({
          id: String(group.id ?? ''),
          name: group.name,
          grade_id: String(group.grade_id ?? ''),
        })),
        optionsError: null,
      });
    } catch (cause) {
      if (!isOptionsCurrent(generation, principal)) return;
      // A failed options read must not blank the list; it only disables the
      // grade/group pickers.
      patch({ optionsError: classifyMaterialFailure(cause).message });
    } finally {
      optionsGuard.release(ticket);
    }
  };

  const selectCourse = async (courseId: string): Promise<void> => {
    if (disposed) return;
    const next = (courseId ?? '').trim();
    // Every in-flight material reply now belongs to a previous selection.
    materialsSequence.invalidate();
    loadGuard.release();
    // A write in flight for the OLD selection is retired by the same
    // transition: it can no longer commit (its generation is gone), so keeping
    // its latch would lock the NEW course behind a request that is already
    // obsolete — the instructor would see a ready form that silently refused
    // every save (supervisor/070). Releasing the latch here is safe because
    // every `finally` releases with its OWN ticket, so the retired operation
    // can never free a newer operation's latch or clear its busy marker.
    writeGuard.release();
    // The page-owned form and delete dialog belong to the previous course.
    formTicket = tickets.next();
    deleteTicket = tickets.next();
    busyOwner = null;
    patch({
      selectedCourse: next,
      materials: [],
      phase: next ? 'loading' : 'idle',
      busyKind: null,
      listError: null,
      refreshError: null,
      createError: null,
      deleteError: null,
      fieldErrors: {},
      deleteTarget: null,
      createdId: null,
      previewMaterialId: null,
      contractNotice: null,
    });
    if (!next) return;
    await runMaterialsLoad(next, 'list');
  };

  const openForm = (): number => {
    if (disposed) return 0;
    formTicket = tickets.next();
    patch({ createError: null, fieldErrors: {}, contractNotice: null });
    return formTicket;
  };

  const closeForm = (): void => {
    formTicket = tickets.next();
  };

  const submit = async (
    values: MaterialFormValues,
    instance?: number
  ): Promise<MaterialCreateOutcome> => {
    if (disposed) return 'blocked';
    // A submit whose form was already closed, replaced or reset never starts.
    if (instance !== undefined && !isFormCurrent(instance)) return 'blocked';
    const courseId = state.selectedCourse;
    if (!courseId) {
      patch({ fieldErrors: { course: 'يرجى اختيار دورة أولًا.' } });
      return 'invalid';
    }
    const validation = validateMaterialForm(values);
    if (!validation.ok) {
      // No request at all for a refused form: the typed values stay on screen.
      patch({ fieldErrors: validation.fieldErrors, createError: null });
      return validation.externalVideoRejected ? 'rejected' : 'invalid';
    }
    if (!writeGuard.acquire()) return 'duplicate';
    const ticket = writeGuard.holder();
    const generation = materialsSequence.current();
    const principal = readPrincipal();
    busyOwner = ticket;
    patch({
      busyKind: 'create',
      createError: null,
      refreshError: null,
      fieldErrors: {},
      contractNotice: null,
    });
    // `display_order` keeps the existing behaviour (append after the current
    // list of THIS course) and is captured before the await.
    const payload = buildMaterialPayload(values, courseId, state.materials.length);
    const canCommit = (): boolean =>
      isOperationCurrent(generation, principal) &&
      state.selectedCourse === courseId &&
      (instance === undefined || isFormCurrent(instance));
    try {
      const created = await api.createMaterial(payload);
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      clearBusy(ticket);
      patch({ createError: null, createdId: createdIdOf(created), contractNotice: null });
      // The server already confirmed the write; the refresh below may fail
      // without ever being reported as a failed create.
      track(runMaterialsLoad(courseId, 'refresh'));
      return 'created';
    } catch (cause) {
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      // Failure keeps the form AND its values: the page leaves them on screen
      // so a deliberate retry is possible.
      clearBusy(ticket);
      const failure = classifyMaterialFailure(cause);
      patch({
        createError: failure.message,
        contractNotice: failure.kind === 'contract' ? failure.message : null,
      });
      return 'failed';
    } finally {
      writeGuard.release(ticket);
    }
  };

  const requestDelete = (material: CourseMaterial): void => {
    if (disposed) return;
    // A NEW target is a NEW dialog incarnation: any unpublish still in flight
    // for the previous one is retired by this advance.
    deleteTicket = tickets.next();
    patch({ deleteTarget: material, deleteError: null });
  };

  const cancelDelete = (): void => {
    deleteTicket = tickets.next();
    patch({ deleteTarget: null, deleteError: null });
  };

  const confirmDelete = async (): Promise<MaterialDeleteOutcome> => {
    const target = state.deleteTarget;
    if (disposed || !target) return 'blocked';
    if (!writeGuard.acquire()) return 'duplicate';
    const ticket = writeGuard.holder();
    const generation = materialsSequence.current();
    const principal = readPrincipal();
    const targetTicket = deleteTicket;
    const courseId = state.selectedCourse;
    busyOwner = ticket;
    patch({ busyKind: 'delete', deleteError: null });
    const canCommit = (): boolean =>
      isOperationCurrent(generation, principal) &&
      state.selectedCourse === courseId &&
      isDeleteCurrent(targetTicket);
    try {
      await api.unpublishMaterial(target.id);
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      // Cleared ONLY on a server-confirmed unpublish of the CURRENT target: a
      // failed unpublish keeps the dialog and its target for a deliberate
      // retry instead of clearing them in `finally`.
      clearBusy(ticket);
      patch({ deleteTarget: null, deleteError: null });
      track(runMaterialsLoad(courseId, 'refresh'));
      return 'unpublished';
    } catch (cause) {
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      clearBusy(ticket);
      patch({ deleteError: classifyMaterialFailure(cause).message });
      return 'failed';
    } finally {
      writeGuard.release(ticket);
    }
  };

  const requestPreview = (materialId: string): void => {
    if (disposed) return;
    // Only a playable row of the CURRENT confirmed list may open the player: no
    // page-owned URL, no id from a previous course.
    if (!resolvePreviewMaterial(state.materials, materialId)) return;
    patch({ previewMaterialId: materialId });
  };

  const closePreview = (): void => {
    if (disposed) return;
    patch({ previewMaterialId: null });
  };

  const refresh = async (): Promise<void> => {
    const courseId = state.selectedCourse;
    if (disposed || !courseId) return;
    // The page's Retry button calls THIS method from two places: the error
    // block (nothing was ever confirmed) and the "list could not be updated"
    // notice (a write was confirmed, the follow-up read was not). Dispatching
    // by what is actually on screen is what makes the second case safe: rows
    // in state are the server's last confirmed state of THIS selection, so a
    // repeated malformed or rejected reply must be reported beside them and
    // never replace them with an error phase and an empty list — that was the
    // blind re-creation invitation supervisor/070 removed from the automatic
    // write-followup path and supervisor/072 found still reachable through
    // this retry. With no confirmed rows there is nothing to protect, so the
    // retry stays an initial load and keeps its honest loading/empty/error
    // outcome instead of a fake successful empty list.
    await runMaterialsLoad(courseId, state.materials.length > 0 ? 'refresh' : 'list');
  };

  const waitForIdle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal: every in-flight reply is foreign, and everything
        // on screen belongs to the previous one.
        retireInFlight();
        patch({
          courses: [],
          grades: [],
          groups: [],
          materials: [],
          selectedCourse: '',
          phase: 'idle',
          listError: null,
          coursesError: null,
          optionsError: null,
          createError: null,
          deleteError: null,
          refreshError: null,
          fieldErrors: {},
          deleteTarget: null,
          createdId: null,
          previewMaterialId: null,
          contractNotice: null,
        });
        track(loadCourses());
        track(loadOptions());
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    loadCourses: () => {
      const operation = loadCourses();
      track(operation);
      return operation;
    },
    loadOptions: () => {
      const operation = loadOptions();
      track(operation);
      return operation;
    },
    selectCourse: (courseId) => {
      const operation = selectCourse(courseId);
      track(operation);
      return operation;
    },
    refresh: () => {
      const operation = refresh();
      track(operation);
      return operation;
    },
    openForm,
    closeForm,
    isFormCurrent,
    submit,
    requestDelete,
    cancelDelete,
    confirmDelete,
    requestPreview,
    closePreview,
    waitForIdle,
    dispose,
  };
}
