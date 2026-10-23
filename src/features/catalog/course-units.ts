/**
 * M2-09 — private course-unit metadata controls inside the EXISTING course
 * details dialog.
 *
 * The production seam the details dialog mounts through
 * `src/features/catalog/CourseUnitManager.tsx`: this module owns the WHOLE
 * request and form lifecycle (explicit panel open, one bounded 25-row page,
 * next/first paging, create/rename/reorder/archive/reactivate, owner-only
 * labelling, runtime DTO validation, uncertain-write handling, stale-reply
 * invalidation, session and disposal fences) and keeps React rendering out of
 * the decision path.
 *
 * The transport, the principal reader and the session notifier are injected,
 * so the exact production code the dialog runs is exercised hermetically in
 * node:test (src/tests/m2-course-unit-ui.test.ts) with no DB, no network, no
 * browser and no live app.
 *
 * Contracts verified from source (docs/streams/server/M2-B04-CONTRACT.md,
 * server/src/routes/course-units.ts, accepted under supervisor/176):
 *  - `GET /api/tenants/me/catalog/courses/:courseId/units?limit=25[&cursor=...]`
 *    answers `{ units: [...], next_cursor: string | null }`; the unit DTO is
 *    the explicit seven fields
 *    `{ id, course_id, name, display_order, status, created_at, updated_at }` —
 *    the row is never spread and no tenant/owner/billing field is exposed;
 *  - `POST .../units` takes the strict body `{ name }` plus an OPTIONAL
 *    `{ display_order }` NUMBER (the server refuses a numeric string, a float
 *    and a boolean); the order defaults to 0; the unit id is server-generated;
 *  - `PATCH .../units/:unitId` takes a non-empty subset of `{ name }`,
 *    `{ display_order }` and `{ status: 'active' | 'archived' }`, and the
 *    response id MUST match the requested unit id;
 *  - the unit routes are owner-only, resolved from server-side rows: a
 *    membership role label never grants access and a membership instructor
 *    gets 403 `Forbidden`. The course must exist, be active and belong to the
 *    selected tenant, so a foreign and an inactive course answer identically;
 *  - the local billing-only guard answers 403 with the unit-specific
 *    `Course unit management is not available while the account is limited to
 *    billing and support` (code `BILLING_ONLY`) — the shared transport keeps
 *    its canonical identity event and redirect untouched;
 *  - the documented failures are 400 `Invalid course id` /
 *    `Invalid course unit id` / `Invalid course unit payload` /
 *    `Invalid course unit update payload` /
 *    `Invalid course unit list limit` /
 *    `Invalid course unit list cursor`, 404 `Tenant membership not found` /
 *    `Course not found` / `Course unit not found`, 409
 *    `Course unit was modified concurrently`, 500 `Failed to list course units`
 *    / `Failed to create course unit` / `Failed to update course unit`, plus
 *    the unchanged upstream 401/suspension answers;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify
 *    an outcome — no status is ever fabricated and a discarded code is never
 *    turned into a permission outcome;
 *  - the accepted migration FILE is NOT applied: a real deployment answers
 *    with a truthful error and no client-side fallback data is invented.
 *
 * Lifetimes fenced here:
 *  - course: the controller is created for ONE course id and that binding is
 *    immutable for the controller's lifetime. A different course is a
 *    different controller, so an old course completion can never affect
 *    another selected course;
 *  - page: every list read advances a page generation, so a reversed or
 *    superseded reply can never commit, and only ONE page (at most
 *    COURSE_UNIT_PAGE_LIMIT rows) is ever held in memory; the RESPONSE is
 *    validated against the same bound BEFORE any row is traversed or copied,
 *    so an oversized page is a malformed response and never a held page;
 *  - request: every mutation advances its own request generation and takes a
 *    synchronous single-flight latch BEFORE the first await, so a double click
 *    or Enter never sends a second write. The latch is released as soon as
 *    the server CONFIRMS the write — BEFORE the bounded follow-up read is
 *    awaited — so an ENABLED control (for example the real row archive
 *    button) is never a silent no-op while the refresh is on the wire. A
 *    second write is still refused while an actual write request is on the
 *    wire, and an older `finally` can never release a NEWER mutation's latch;
 *  - form: opening, cancelling, editing or invalidating a form advances the
 *    form generation, so a late reply never rewrites or closes a newer form
 *    and a newer edit is never overwritten by an older confirmed save;
 *  - authorization: a DEFINITE read authorization or scope loss (an expired
 *    session, a suspension, the billing-only restriction, the owner-only
 *    denial, a missing workspace, a missing course) clears the private rows,
 *    the form, the draft, the target and the confirmation and retires every
 *    in-flight operation, so an older write or read can never repopulate the
 *    cleared private state. A retryable read failure keeps the private draft,
 *    because no permission loss was proven;
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read and write (through the accepted M2-02 reader
 *    `readCourseSessionPrincipal`), on the SUCCESS and the FAILURE path, and a
 *    RETIRED operation observes it BEFORE it settles any visible state — a
 *    silent logout can never revive the previous principal's rows or drafts;
 *  - close/dispose: the panel clears the private rows, the drafts and the
 *    cursors and drops every in-flight reply. The close control stays usable
 *    while a read is on the wire.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success;
 *  - a PATCH response for another unit id is NOT a success for this unit, and
 *    a DTO whose `course_id` is not the bound course is NOT a success either;
 *  - a 500/network/malformed write outcome is UNCERTAIN: the write may have
 *    persisted, nothing is retried automatically, the draft is preserved and a
 *    deliberate list read is offered. A matching name in the list is the
 *    CURRENT state — never proof of the earlier write or its audit — and
 *    because duplicate names are allowed a deliberate create retry may create a
 *    duplicate unit;
 *  - a confirmed success uses the validated server DTO only; at most ONE
 *    bounded first-page read follows a confirmed create or a confirmed reorder
 *    so the panel keeps the server's canonical ordering, and a FAILED follow-up
 *    read never turns the confirmed save into a failed save.
 *
 * Out of scope by construction: no new route, no backend/schema/migration
 * application, no teacher/student assignment, no publication, no payment, no
 * upload rule, no OTP, no shared auth/error/session change, and no unit
 * capability inferred from a local role, a profile, a course selection or a
 * tenant status. The selected course id is a RESOURCE id, never a tenant
 * authority.
 */
import {
  COURSE_UNIT_PAGE_LIMIT,
  type CourseUnit,
  type CourseUnitEnvelope,
  type CourseUnitListEnvelope,
  type CourseUnitStatus,
} from '../../lib/api-http';
import { createCourseOperationGuard, createTicketSource } from './course-management';

/**
 * The canonical session reader the courses page uses. Re-exported so the
 * dialog imports ONE principal boundary: M2-02's reader holds the single
 * canonical localStorage lifetime, and a second parallel lifetime here would
 * let the two panels disagree about what "the same session" means.
 */
export { readCourseSessionPrincipal } from './course-management';
export type { CourseSessionStorage } from './course-management';

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

/** The page's own wording for a body that is not the documented envelope. The
 *  server never sends this string, so it can never be confused with a server
 *  classification. */
export const MALFORMED_COURSE_UNIT_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Local validation wording: the input never reaches the transport. */
export const COURSE_UNIT_NAME_INVALID_MESSAGE =
  'اسم الوحدة يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات.';

/** Local validation wording for the metadata position. */
export const COURSE_UNIT_ORDER_INVALID_MESSAGE =
  'موضع الوحدة يجب أن يكون رقمًا صحيحًا بين 0 و2147483647.';

/** Local wording when the editor holds no change at all. */
export const COURSE_UNIT_NO_CHANGES_MESSAGE = 'لا توجد تغييرات لحفظها.';

/** Local warning after a reply that may or may not have persisted server-side. */
export const COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ بيانات الوحدة. قد تكون التغييرات قد حُفظت على الخادم؛ اقرأ القائمة الحالية للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after the deliberate read-only reconciliation. A matching
 *  unit is the CURRENT state, never proof of the previous write or its audit. */
export const COURSE_UNIT_RECONCILED_MESSAGE =
  'تم عرض القائمة الحالية من الخادم. هذا لا يؤكد نجاح محاولة الحفظ السابقة.';

/** Duplicate names are allowed by the accepted contract, so a deliberate create
 *  retry can create a second unit with the same name. */
export const COURSE_UNIT_DUPLICATE_CREATE_WARNING =
  'أسماء الوحدات مسموح بتكرارها؛ إعادة محاولة الإنشاء قد تنشئ وحدة مكررة.';

/**
 * The honest paging/reorder notice.
 *
 * The cursor is a POSITION, not a snapshot: `display_order` is mutable, so a
 * unit moved after a page was served can reappear on a later page and a unit
 * moved before the cursor position can be omitted from the remaining pages.
 * The panel says exactly that instead of promising a stable traversal.
 */
export const COURSE_UNIT_PAGING_NOTICE =
  'الصفحة محدودة بـ25 وحدة في كل مرة، والموضع مؤشر لا لقطة ثابتة؛ أي إعادة ترتيب بين قراءتين قد تُظهر وحدة مكررة أو تُخفي وحدة.';

/** The metadata position is a DISPLAY position inside the course. It is not a
 *  lesson unlocking rule, a publication switch or an access policy. */
export const COURSE_UNIT_METADATA_NOTICE =
  'الموضع هنا ترتيب عرض داخل الكورس فقط؛ لا يفتح درسًا ولا ينشر محتوى ولا يغيّر صلاحية الوصول.';

/** Upstream authentication answers — the EXACT messages the shared transport
 *  throws (server/src/middleware/auth.ts). The transport discards the HTTP
 *  status and the `code` field (api-http.ts:69-89), so the classifier matches
 *  the transported `error` string, never a synthetic code. */
const SESSION_INVALID_MESSAGES = new Set<string>([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
]);

/** The account is administratively suspended: the shared transport also tears
 *  the session down (api-http.ts:85-88); the feature records the denial it
 *  can see. The code `TENANT_SUSPENDED` never arrives as `error.message`. */
const SUSPENDED_MESSAGE = 'Instructor account is administratively suspended';

/** No authorized workspace: the handler's 404. It fails closed: no unit rows. */
const NO_WORKSPACE_MESSAGE = 'Tenant membership not found';

/** The accepted unit-local billing-only denial (M2-B04 contract). The shared
 *  transport already applied its canonical identity event and redirect; the
 *  unit feature only records the denial it can see. */
const BILLING_ONLY_MESSAGE =
  'Course unit management is not available while the account is limited to billing and support';

/** The owner-only denial for a membership instructor (M2-B04 contract). */
const FORBIDDEN_MESSAGE = 'Forbidden';

/** The course is absent, foreign or inactive — the server answers identically
 *  for all three, so the client never discloses which one it was. */
const MISSING_COURSE_MESSAGE = 'Course not found';

/** The accepted write-side 404: the unit is absent (or foreign). The server
 *  did not write. */
const MISSING_UNIT_MESSAGE = 'Course unit not found';

/** The accepted concurrent-row outcome: the server rolled back and did not
 *  write, so this is a retryable conflict, not an uncertain write. */
const COURSE_UNIT_CONFLICT_MESSAGE = 'Course unit was modified concurrently';

/** The handler's strict rejections: no connection was taken and nothing was
 *  written. */
const COURSE_UNIT_INVALID_MESSAGES = new Set<string>([
  'Invalid course id',
  'Invalid course unit id',
  'Invalid course unit payload',
  'Invalid course unit update payload',
  'Invalid course unit list limit',
  'Invalid course unit list cursor',
]);

/** The accepted handler 500 wordings. */
const COURSE_UNIT_LIST_FAILED_MESSAGE = 'Failed to list course units';
const COURSE_UNIT_CREATE_FAILED_MESSAGE = 'Failed to create course unit';
const COURSE_UNIT_UPDATE_FAILED_MESSAGE = 'Failed to update course unit';

export type CourseUnitPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'malformed'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace'
  | 'missing-course';

/** Why an outcome was classified. Every value comes from a documented
 *  transported message; nothing is guessed from a discarded code. */
export type CourseUnitFailureReason =
  | 'session'
  | 'suspended'
  | 'billing-only'
  | 'not-owner'
  | 'no-workspace'
  | 'missing-course'
  | 'missing-unit'
  | 'conflict'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface CourseUnitFailure {
  readonly phase: CourseUnitPhase;
  readonly reason: CourseUnitFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a LIST read.
 *
 * A permission outcome is never faked from an unrecognized message: it stays a
 * retryable read error with its actual message on screen.
 */
export function classifyCourseUnitFailure(cause: unknown): CourseUnitFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_INVALID_MESSAGES.has(message)) {
    return { phase: 'unauthorized', reason: 'session', message };
  }
  if (message === SUSPENDED_MESSAGE) {
    return { phase: 'denied', reason: 'suspended', message };
  }
  if (message === BILLING_ONLY_MESSAGE) {
    return { phase: 'denied', reason: 'billing-only', message };
  }
  if (message === FORBIDDEN_MESSAGE) {
    return { phase: 'denied', reason: 'not-owner', message };
  }
  if (message === NO_WORKSPACE_MESSAGE) {
    return { phase: 'no-workspace', reason: 'no-workspace', message };
  }
  if (message === MISSING_COURSE_MESSAGE) {
    return { phase: 'missing-course', reason: 'missing-course', message };
  }
  if (message === COURSE_UNIT_LIST_FAILED_MESSAGE) {
    return { phase: 'error', reason: 'server', message };
  }
  return {
    phase: 'error',
    reason: 'unknown',
    message: message || 'فشل تحميل وحدات الكورس',
  };
}

export type CourseUnitWriteKind =
  | 'unauthorized'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'missing'
  | 'uncertain';

/**
 * A DEFINITE loss of the list's read authorization or of the tenant/course
 * scope.
 *
 * Only the documented denial answers qualify: an expired or invalid session,
 * an administratively suspended account, the billing-only restriction, the
 * owner-only denial, a missing workspace and a missing course. Every one of
 * them is a server statement that this session may no longer read this
 * course's private unit metadata, so the private form, the draft, the target
 * and the confirmation must not stay on screen.
 *
 * A retryable read failure does NOT prove a permission loss: the handler 500
 * (`Failed to list course units`), a network error and an unrecognized message
 * keep the private draft, because the permission was never proven to be gone
 * and the user may deliberately retry.
 */
export function isCourseUnitAuthorizationLoss(reason: CourseUnitFailureReason): boolean {
  return (
    reason === 'session' ||
    reason === 'suspended' ||
    reason === 'billing-only' ||
    reason === 'not-owner' ||
    reason === 'no-workspace' ||
    reason === 'missing-course'
  );
}

export interface CourseUnitWriteFailure {
  readonly kind: CourseUnitWriteKind;
  readonly reason: CourseUnitFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a WRITE.
 *
 * `uncertain` covers the handler 500 (the client cannot distinguish a
 * confirmed rollback from a lost commit acknowledgement) and every
 * unrecognized/network/transport failure after the request was sent: the write
 * MAY have persisted, so nothing is retried automatically.
 */
export function classifyCourseUnitWriteFailure(cause: unknown): CourseUnitWriteFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_INVALID_MESSAGES.has(message)) {
    return { kind: 'unauthorized', reason: 'session', message };
  }
  if (message === SUSPENDED_MESSAGE) {
    return { kind: 'unauthorized', reason: 'suspended', message };
  }
  if (message === BILLING_ONLY_MESSAGE) {
    return { kind: 'denied', reason: 'billing-only', message };
  }
  if (message === FORBIDDEN_MESSAGE) {
    return { kind: 'denied', reason: 'not-owner', message };
  }
  if (message === NO_WORKSPACE_MESSAGE) {
    return { kind: 'denied', reason: 'no-workspace', message };
  }
  if (message === MISSING_COURSE_MESSAGE) {
    return { kind: 'denied', reason: 'missing-course', message };
  }
  if (message === MISSING_UNIT_MESSAGE) {
    return { kind: 'missing', reason: 'missing-unit', message };
  }
  if (message === COURSE_UNIT_CONFLICT_MESSAGE) {
    return { kind: 'conflict', reason: 'conflict', message };
  }
  if (COURSE_UNIT_INVALID_MESSAGES.has(message)) {
    return { kind: 'invalid', reason: 'invalid', message };
  }
  if (message === COURSE_UNIT_CREATE_FAILED_MESSAGE || message === COURSE_UNIT_UPDATE_FAILED_MESSAGE) {
    return { kind: 'uncertain', reason: 'server', message };
  }
  return {
    kind: 'uncertain',
    reason: 'unknown',
    message: message || 'فشل غير مؤكد أثناء حفظ بيانات الوحدة',
  };
}

// ---------------------------------------------------------------------------
// Runtime DTO validation — a missing or malformed body is never a success
// ---------------------------------------------------------------------------

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** The nullable cursor, verbatim: a string or exactly `null`. */
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/**
 * The opaque cursor is bounded so a hostile value cannot be used as a probe:
 * the server refuses a cursor that is empty, longer than 256 characters or
 * not a string, so a cursor outside that bound is a malformed response and is
 * never sent back to the server.
 */
const CURSOR_MAX_LENGTH = 256;
const isUsableCursor = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && value.length > 0 && value.length <= CURSOR_MAX_LENGTH);

/** A server-generated unit id and a server-generated course id are UUIDs. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `display_order` is a nonnegative signed 32-bit integer. */
export const COURSE_UNIT_DISPLAY_ORDER_MAX = 2147483647;

/** The exact seven server-projected fields, sorted for an exact key check. */
const COURSE_UNIT_KEYS = [
  'course_id',
  'created_at',
  'display_order',
  'id',
  'name',
  'status',
  'updated_at',
];

/**
 * Parses the metadata position the user typed.
 *
 * Only plain decimal digits are accepted: a sign, a decimal point, an
 * exponent, a whitespace-separated value and an Arabic-Indic digit are all
 * refused, because the server itself refuses a numeric string, a float and a
 * boolean. The result is a NUMBER that is already an integer in
 * 0..2147483647, so the transport never has to coerce anything.
 */
export function parseCourseUnitOrder(raw: string): number | null {
  const text = (raw ?? '').trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  if (value < 0 || value > COURSE_UNIT_DISPLAY_ORDER_MAX) return null;
  return value;
}

export type CourseUnitParseResult =
  | { readonly ok: true; readonly unit: CourseUnit }
  | { readonly ok: false };

/**
 * Validates one unit DTO against the accepted M2-B04 contract: a non-null
 * object whose `id` is a UUID, whose `course_id` is EXACTLY the course this
 * controller is bound to, whose `name` is a trimmed 1..255 string, whose
 * `display_order` is an integer in 0..2147483647, whose `status` is exactly
 * `active` or `archived`, whose two timestamps are strings — and whose key set
 * is EXACTLY the seven projected fields.
 *
 * Anything else — a non-object, a wrong field type, an unknown status, a
 * spread row with an extra key, a unit of another course — is a malformed
 * response, never a fabricated unit.
 */
export function parseCourseUnit(
  body: unknown,
  expectedCourseId: string,
): CourseUnitParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const row = body as Record<string, unknown>;
  const id = row.id;
  const courseId = row.course_id;
  const name = row.name;
  const displayOrder = row.display_order;
  const status = row.status;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (!isNonEmptyString(id) || !UUID_PATTERN.test(id)) return { ok: false };
  // The course binding: a unit of ANOTHER course is never a success here.
  if (courseId !== expectedCourseId) return { ok: false };
  if (typeof name !== 'string') return { ok: false };
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 255) return { ok: false };
  if (typeof displayOrder !== 'number') return { ok: false };
  if (!Number.isInteger(displayOrder)) return { ok: false };
  if (displayOrder < 0 || displayOrder > COURSE_UNIT_DISPLAY_ORDER_MAX) return { ok: false };
  if (status !== 'active' && status !== 'archived') return { ok: false };
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return { ok: false };
  const keys = Object.keys(row).sort();
  if (keys.length !== COURSE_UNIT_KEYS.length) return { ok: false };
  for (let index = 0; index < COURSE_UNIT_KEYS.length; index += 1) {
    if (keys[index] !== COURSE_UNIT_KEYS[index]) return { ok: false };
  }
  return {
    ok: true,
    unit: {
      id,
      course_id: expectedCourseId,
      name,
      display_order: displayOrder,
      status,
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
}

export type CourseUnitListParseResult =
  | { readonly ok: true; readonly units: CourseUnit[]; readonly nextCursor: string | null }
  | { readonly ok: false };

/**
 * Validates the list envelope: exactly `{ units, next_cursor }`, an array of
 * valid unit DTOs of the BOUND course and a cursor that is a string or exactly
 * `null`.
 *
 * The page memory bound is enforced HERE, on the RESPONSE, and not only by the
 * request: a response carrying MORE rows than `COURSE_UNIT_PAGE_LIMIT` is a
 * malformed response. It is rejected BEFORE a single row is traversed or
 * copied, so an oversized page is never held in memory, never silently
 * truncated and never paired with a fabricated cursor. The limit of the
 * request is a promise; the limit of the response is a contract.
 */
export function parseCourseUnitList(
  body: unknown,
  expectedCourseId: string,
): CourseUnitListParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'next_cursor' || keys[1] !== 'units') {
    return { ok: false };
  }
  const list = envelope.units;
  if (!Array.isArray(list)) return { ok: false };
  // The response memory bound, checked BEFORE any row is read or copied.
  if (list.length > COURSE_UNIT_PAGE_LIMIT) return { ok: false };
  const nextCursor = envelope.next_cursor;
  if (!isNullableString(nextCursor)) return { ok: false };
  // The cursor bound is part of the contract, not only of the request.
  if (!isUsableCursor(nextCursor)) return { ok: false };
  const units: CourseUnit[] = [];
  for (const item of list) {
    const parsed = parseCourseUnit(item, expectedCourseId);
    if (!parsed.ok) return { ok: false };
    units.push(parsed.unit);
  }
  return { ok: true, units, nextCursor };
}

export type CourseUnitEnvelopeParseResult =
  | { readonly ok: true; readonly unit: CourseUnit }
  | { readonly ok: false };

/** Validates the `{ unit }` envelope of a confirmed create/update. */
export function parseCourseUnitEnvelope(
  body: unknown,
  expectedCourseId: string,
): CourseUnitEnvelopeParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 1 || keys[0] !== 'unit') return { ok: false };
  return parseCourseUnit(envelope.unit, expectedCourseId);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CourseUnitMutationKind = 'create' | 'edit' | 'status';

export type CourseUnitMutationStatus = 'idle' | 'saving' | 'uncertain';

export interface CourseUnitMutationState {
  status: CourseUnitMutationStatus;
  kind: CourseUnitMutationKind | null;
  /** The unit the mutation targets (null for a create). */
  targetId: string | null;
  /** The actual transported failure message, or local validation wording. */
  error: string | null;
  /** Warning after an uncertain write or a reconciliation read. Never success. */
  notice: string | null;
}

export type CourseUnitFormMode = 'closed' | 'create' | 'edit';

export interface CourseUnitFormState {
  mode: CourseUnitFormMode;
  /** The user's name draft, preserved verbatim on every failed write. */
  nameDraft: string;
  /** The user's metadata-position draft, exactly as typed. */
  orderDraft: string;
  /** The unit the edit form is bound to. */
  targetId: string | null;
  /** The unit name the edit form was opened for (display only). */
  targetName: string | null;
  /** The server-confirmed name the edit form was opened with. */
  originalName: string | null;
  /** The server-confirmed position the edit form was opened with. */
  originalOrder: string | null;
  error: string | null;
}

export interface CourseUnitState {
  /** The panel was explicitly opened by the user. No request happens before. */
  open: boolean;
  phase: CourseUnitPhase;
  /** The bounded current page only (at most COURSE_UNIT_PAGE_LIMIT rows). */
  rows: CourseUnit[];
  /** The cursor of the NEXT page, or null when the server says there is none. */
  nextCursor: string | null;
  /** True when the current page is not the first page. */
  hasPreviousPage: boolean;
  error: string | null;
  /** Why the current phase was reached, when a failure caused it. */
  reason: CourseUnitFailureReason | null;
  /**
   * A failed follow-up read AFTER a confirmed write. It never turns the
   * confirmed save into a failed save: the confirmation and the rows survive,
   * and only this note reports the failed refresh.
   */
  refreshError: string | null;
  /** The server-confirmed result of the last confirmed write. */
  lastConfirmed: CourseUnit | null;
  form: CourseUnitFormState;
  mutation: CourseUnitMutationState;
}

const closedForm = (): CourseUnitFormState => ({
  mode: 'closed',
  nameDraft: '',
  orderDraft: '',
  targetId: null,
  targetName: null,
  originalName: null,
  originalOrder: null,
  error: null,
});

const idleMutation = (): CourseUnitMutationState => ({
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
});

const initialState: CourseUnitState = {
  open: false,
  phase: 'idle',
  rows: [],
  nextCursor: null,
  hasPreviousPage: false,
  error: null,
  reason: null,
  refreshError: null,
  lastConfirmed: null,
  form: closedForm(),
  mutation: idleMutation(),
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface CourseUnitApi {
  listUnits: (params: {
    courseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CourseUnitListEnvelope>;
  /** Accepted M2-B04 owner-only create through the canonical transport. */
  createUnit?: (courseId: string, input: {
    name: string;
    display_order?: number;
  }) => Promise<CourseUnitEnvelope>;
  /** Accepted M2-B04 owner-only update through the canonical transport. */
  updateUnit?: (
    courseId: string,
    unitId: string,
    update: { name?: string; display_order?: number; status?: CourseUnitStatus },
  ) => Promise<CourseUnitEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface CourseUnitController {
  /** The course this controller is bound to. Immutable for its lifetime. */
  readonly courseId: string;
  getState(): CourseUnitState;
  subscribe(listener: (state: CourseUnitState) => void): () => void;
  /** Explicit panel open: exactly ONE bounded page read, never before. */
  open(): Promise<void>;
  /** Closes the panel: the private rows, drafts and cursors are cleared. */
  close(): void;
  /** A deliberate read of the CURRENT page (never a write). */
  refresh(): Promise<void>;
  /** The next page, using the server's opaque cursor. */
  nextPage(): Promise<void>;
  /** Back to the first page (the cursor is dropped). */
  firstPage(): Promise<void>;
  /** Opens the create form (no request). */
  openCreateForm(): void;
  /** Opens the edit form for a unit of the current page (no request). */
  openEditForm(unitId: string): void;
  /** Updates the name draft without issuing a request. */
  updateNameDraft(value: string): void;
  /** Updates the position draft without issuing a request. */
  updateOrderDraft(value: string): void;
  /** Closes the form; a late reply can never reopen or mutate it. */
  cancelForm(): void;
  /** Explicit single-flight create (owner-only, server-authoritative). */
  create(): Promise<void>;
  /** Explicit single-flight save of the name and/or the position. */
  save(): Promise<void>;
  /** Explicit single-flight archive/reactivation of one unit. */
  setStatus(unitId: string, status: CourseUnitStatus): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain write. */
  reconcile(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

type ReadMode = 'open' | 'page' | 'refresh' | 'reconcile' | 'post-write';

export function createCourseUnitController(
  courseId: string,
  api: CourseUnitApi,
): CourseUnitController {
  // The course binding is immutable for the controller's lifetime.
  const boundCourseId = courseId;
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: CourseUnitState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** One list read at a time: a double-clicked paging button never sends a
   *  second request. */
  const readGuard = createCourseOperationGuard(tickets);
  /** One mutation at a time: a double-clicked save never sends a second
   *  write. */
  const writeGuard = createCourseOperationGuard(tickets);
  /** Page generation: every list read advances it. */
  let pageGeneration = 0;
  /** Request generation: every mutation advances it. */
  let requestGeneration = 0;
  /** Form generation: opening, editing, cancelling or invalidating a form
   *  advances it, so a newer edit is never closed by an older reply. */
  let formGeneration = 0;
  /** The mutation that currently owns the busy presentation. */
  let mutationOwner = 0;
  /** Incremented by every CONFIRMED write: a read that started before it must
   *  not commit its now-stale page. */
  let confirmedWriteEpoch = 0;
  /** The read that owns the visible loading phase. */
  let phaseOwner = 0;
  /** The cursor the current page was read with. */
  let currentCursor: string | null = null;

  const patch = (changes: Partial<CourseUnitState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<CourseUnitFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<CourseUnitMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** Clears every private trace of the panel (rows, drafts, cursors). */
  const clearPrivateState = (): Partial<CourseUnitState> => ({
    phase: 'idle',
    rows: [],
    nextCursor: null,
    hasPreviousPage: false,
    error: null,
    reason: null,
    refreshError: null,
    lastConfirmed: null,
    form: closedForm(),
    mutation: idleMutation(),
  });

  /**
   * Discards everything in flight and the latches they hold. The generations
   * are advanced so a reply that is still on the wire can no longer commit.
   */
  const retireInFlight = (): void => {
    pageGeneration += 1;
    requestGeneration += 1;
    formGeneration += 1;
    mutationOwner = 0;
    readGuard.release();
    writeGuard.release();
  };

  /**
   * Adopts an observed principal change (a silent logout/scope swap that
   * produced no notifier event). The private rows and drafts are cleared
   * BEFORE any new read starts, and every in-flight reply is retired.
   */
  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    retireInFlight();
    currentCursor = null;
    patch(clearPrivateState());
    return true;
  };

  /**
   * Adopts an observed principal change on behalf of a RETIRED operation.
   *
   * A retired operation must observe the canonical principal BEFORE it settles
   * any visible state: a silent logout that happened while its reply was on
   * the wire must never be revived by the phase that read owns.
   *
   * The latches are deliberately NOT released here — every operation releases
   * its own ticket in its `finally`, so a retired completion can never free a
   * newer operation's latch.
   */
  const adoptRetiredPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    pageGeneration += 1;
    requestGeneration += 1;
    formGeneration += 1;
    currentCursor = null;
    patch(clearPrivateState());
    return true;
  };

  const track = (operation: Promise<unknown>): void => {
    pending.add(operation);
    void operation.then(
      () => { pending.delete(operation); },
      () => { pending.delete(operation); },
    );
  };

  /**
   * Settles the loading phase a retired read owns. The reply is never
   * committed (a newer read owns the data), but the page must not stay on a
   * phantom `loading`.
   */
  const settleReadPhase = (phaseToken: number): void => {
    if (phaseOwner !== phaseToken) return;
    if (state.phase !== 'loading') return;
    patch({ phase: state.rows.length > 0 ? 'ready' : 'idle', error: null, reason: null });
  };

  /** Applies a server-confirmed unit to the held page (if it is on it). */
  const applyConfirmedUnit = (unit: CourseUnit): void => {
    const index = state.rows.findIndex((row) => row.id === unit.id);
    if (index === -1) {
      patch({ lastConfirmed: unit });
      return;
    }
    const rows = state.rows.slice();
    rows[index] = unit;
    patch({ rows, lastConfirmed: unit });
  };

  const reconcileNoticeIfCurrent = (): void => {
    if (state.mutation.status !== 'uncertain') return;
    patchMutation({ notice: COURSE_UNIT_RECONCILED_MESSAGE });
  };

  const runRead = async (cursor: string | null, mode: ReadMode): Promise<void> => {
    if (disposed) return;
    if (!state.open) return;
    // Entry observation: if the principal changed without a notifier, adopt it
    // (retire the old generation, clear the private rows) BEFORE starting.
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    // A read is already on the wire: a double-clicked paging or refresh
    // button never reaches the transport.
    if (!readGuard.acquire()) return;
    const ticket = readGuard.holder();
    const generation = ++pageGeneration;
    const epoch = confirmedWriteEpoch;
    const principal = entryPrincipal;
    const phaseToken = ++phaseOwner;
    patch({ phase: 'loading', error: null, reason: null });
    try {
      const body = await api.listUnits({
        courseId: boundCourseId,
        limit: COURSE_UNIT_PAGE_LIMIT,
        cursor,
      });
      if (disposed) return;
      if (generation !== pageGeneration) {
        // The canonical principal is observed BEFORE any visible state is
        // settled: a silent logout or scope swap that happened while this
        // reply was on the wire must never be revived by the phase this read
        // owns, and the previous principal's rows and drafts are cleared.
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) {
          return;
        }
        // A newer read owns the displayed page, so this reply is never
        // committed. The phase this read owns is still settled, so the panel
        // does not stay on a phantom `loading`.
        settleReadPhase(phaseToken);
        return;
      }
      // Completion observation: a principal swapped while the reply was on the
      // wire makes this reply foreign.
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      // A confirmed write landed while this read was on the wire, so the page
      // it carries is already stale: it is never committed over the confirmed
      // server state.
      if (epoch !== confirmedWriteEpoch) {
        settleReadPhase(phaseToken);
        return;
      }
      const parsed = parseCourseUnitList(body, boundCourseId);
      if (!parsed.ok) {
        // A malformed response is NEVER a page of units and never a success.
        if (mode === 'post-write') {
          // The confirmed write stays confirmed; only the follow-up read is
          // reported as failed.
          patch({ refreshError: MALFORMED_COURSE_UNIT_MESSAGE });
          settleReadPhase(phaseToken);
          return;
        }
        patch({
          phase: 'malformed',
          rows: [],
          nextCursor: null,
          hasPreviousPage: false,
          error: MALFORMED_COURSE_UNIT_MESSAGE,
          reason: 'unknown',
          refreshError: null,
        });
        return;
      }
      currentCursor = cursor;
      patch({
        phase: parsed.units.length === 0 ? 'empty' : 'ready',
        rows: parsed.units,
        nextCursor: parsed.nextCursor,
        hasPreviousPage: cursor !== null,
        error: null,
        reason: null,
        refreshError: null,
      });
      if (mode === 'reconcile') reconcileNoticeIfCurrent();
    } catch (cause) {
      if (disposed) return;
      if (generation !== pageGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) {
          return;
        }
        settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      if (epoch !== confirmedWriteEpoch) {
        settleReadPhase(phaseToken);
        return;
      }
      const failure = classifyCourseUnitFailure(cause);
      if (isCourseUnitAuthorizationLoss(failure.reason)) {
        // A DEFINITE loss of the list's authorization or of the tenant/course
        // scope: the private rows, the form, the draft, the target and the
        // confirmation are cleared and every in-flight operation is retired,
        // so an older write or an older read can never repopulate the cleared
        // private state. The truthful failure phase and the server's own
        // message are preserved.
        retireInFlight();
        currentCursor = null;
        patch({
          ...clearPrivateState(),
          phase: failure.phase,
          error: failure.message,
          reason: failure.reason,
        });
        return;
      }
      if (mode === 'post-write') {
        // The write was confirmed by the server: a failed follow-up read never
        // turns it into a failed save. The rows, the confirmation and the
        // phase survive, and only this note reports the failed refresh.
        patch({ refreshError: failure.message });
        settleReadPhase(phaseToken);
        return;
      }
      // A retryable read failure (the handler 500, a network error, an
      // unrecognized message): the permission loss is NOT proven, so the
      // private draft survives for a deliberate retry.
      patch({
        phase: failure.phase,
        rows: [],
        nextCursor: null,
        hasPreviousPage: false,
        error: failure.message,
        reason: failure.reason,
        refreshError: null,
      });
    } finally {
      // Only its own ticket: a retired read's `finally` can never release a
      // newer read's latch.
      readGuard.release(ticket);
    }
  };

  /**
   * Settles a mutation that can no longer commit because a newer mutation, a
   * newer page or a session change owns the displayed state.
   *
   * The reply is never committed and never claims success: the busy state is
   * settled truthfully, the draft is preserved and a genuinely unknown write
   * outcome stays explicitly uncertain.
   */
  const settleSupersededMutation = (
    token: number,
    body: unknown | null,
    cause: unknown | null,
  ): void => {
    if (mutationOwner !== token) return;
    if (state.mutation.status !== 'saving') return;
    if (cause !== null) {
      const failure = classifyCourseUnitWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        // The session is gone: clear the private rows and drafts.
        retireInFlight();
        currentCursor = null;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        patchMutation({
          status: 'uncertain',
          error: failure.message,
          notice: COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid/missing: the server did not write. The rows
      // and the draft are preserved for a deliberate retry.
      patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
      return;
    }
    const parsed = parseCourseUnitEnvelope(body, boundCourseId);
    if (!parsed.ok) {
      patchMutation({
        status: 'uncertain',
        error: null,
        notice: COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE,
      });
      return;
    }
    // The server confirmed the write, but a newer operation owns the view, so
    // the reply is not committed and no success is claimed.
    patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
  };

  const runMutation = async (
    kind: CourseUnitMutationKind,
    targetId: string | null,
    body: { name?: string; display_order?: number; status?: CourseUnitStatus },
    options: { refreshAfter?: boolean } = {},
  ): Promise<void> => {
    if (disposed) return;
    if (kind === 'create' && !api.createUnit) return;
    if (kind !== 'create' && !api.updateUnit) return;

    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (disposed) return;

    // Synchronous single-flight: a second click/Enter before the first await
    // never reaches the transport.
    if (!writeGuard.acquire()) return;
    const ticket = writeGuard.holder();
    /**
     * The mutation's OWN latch ticket is released AT MOST ONCE: either right
     * after the server confirmed the write — BEFORE the bounded follow-up
     * read is awaited — or in the `finally` of a failed, denied or uncertain
     * write.
     *
     * Releasing the ticket early is safe because the ticket source is
     * monotonic: `writeGuard.release(ticket)` only frees the latch while THIS
     * ticket still owns it, so the older `finally` can never release a NEWER
     * mutation's latch.
     */
    let writeTicketReleased = false;
    const releaseWriteTicket = (): void => {
      if (writeTicketReleased) return;
      writeTicketReleased = true;
      writeGuard.release(ticket);
    };
    const token = ++requestGeneration;
    const formToken = formGeneration;
    const principal = entryPrincipal;
    const epoch = confirmedWriteEpoch;
    mutationOwner = token;
    patchMutation({
      status: 'saving',
      kind,
      targetId,
      error: null,
      notice: null,
    });
    try {
      const response =
        kind === 'create'
          ? await api.createUnit!(boundCourseId, body as { name: string; display_order?: number })
          : await api.updateUnit!(boundCourseId, targetId as string, body);
      if (disposed) return;
      if (token !== requestGeneration) {
        // A newer mutation, page or session owns the state now: the reply is
        // never committed and no success is claimed.
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededMutation(token, response, null);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const parsed = parseCourseUnitEnvelope(response, boundCourseId);
      if (!parsed.ok) {
        // A 2xx success with a body that cannot be validated is not success.
        patchMutation({
          status: 'uncertain',
          error: null,
          notice: COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      if (kind !== 'create' && parsed.unit.id !== targetId) {
        // A well-formed DTO for ANOTHER unit is not a success for this write:
        // nothing is committed, the draft is preserved, the write stays
        // explicitly uncertain and no retry is sent.
        patchMutation({
          status: 'uncertain',
          error: null,
          notice: COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Server-authoritative success only.
      confirmedWriteEpoch += 1;
      mutationOwner = 0;
      applyConfirmedUnit(parsed.unit);
      if (kind !== 'status' && formGeneration === formToken) {
        // The form this write belonged to is still the current one, so it
        // closes. A newer EDIT advanced the form generation, so a newer draft
        // is kept and is never overwritten by this older confirmed save. A
        // status write never touches an open form.
        formGeneration += 1;
        patchForm(closedForm());
      }
      patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
      if (kind === 'create' || options.refreshAfter) {
        // The write is DONE and the server confirmed it, so this mutation's
        // OWN latch is settled HERE — BEFORE the bounded follow-up read is
        // awaited. The read is a READ: it never sends a write, never retries
        // one and never holds the write latch, so an ENABLED control (for
        // example the real row archive button) is never a silent no-op while
        // the refresh is on the wire. The real in-flight write exclusion
        // stays intact: a second write is still refused while an actual
        // write request is on the wire.
        releaseWriteTicket();
        // At most ONE bounded first-page read after a confirmed create or a
        // confirmed reorder, so the panel keeps the server's canonical
        // ordering. It is a read, never a second write, and a FAILED refresh
        // never turns the confirmed save into a failed save.
        await runRead(null, 'post-write');
      }
    } catch (cause) {
      if (disposed) return;
      if (token !== requestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededMutation(token, null, cause);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyCourseUnitWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        // The session is gone: clear the private rows and drafts. The
        // transport may already have notified a 403 teardown.
        retireInFlight();
        currentCursor = null;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        // The write may or may not have persisted: it stays explicitly
        // uncertain, the draft and the rows are preserved and NO write is
        // retried automatically.
        mutationOwner = 0;
        patchMutation({
          status: 'uncertain',
          error: failure.message,
          notice: COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid/missing: the server did not write. The rows
      // and the draft are preserved and the user may retry explicitly.
      mutationOwner = 0;
      patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
    } finally {
      // Only its own ticket: a retired mutation's `finally` can never release
      // a newer mutation's latch. It is already released when the write was
      // confirmed and the follow-up read is pending, and releasing twice is a
      // no-op.
      releaseWriteTicket();
    }
  };

  const validateName = (raw: string): string | null => {
    const name = raw.trim();
    if (name.length < 1 || name.length > 255) return null;
    return name;
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal (or a logout): every in-flight reply is foreign,
        // the private rows and drafts are cleared BEFORE any new read starts.
        retireInFlight();
        observedPrincipal = readPrincipal();
        currentCursor = null;
        patch(clearPrivateState());
        if (state.open) {
          // The panel is open, so the new session gets its own first page.
          const operation = runRead(null, 'open');
          track(operation);
        }
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    currentCursor = null;
    // The view is gone: no unit row, draft, cursor or in-flight phase
    // outlives it.
    patch({ open: false, ...clearPrivateState() });
  };

  return {
    courseId: boundCourseId,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    open: () => {
      if (disposed) return Promise.resolve();
      if (state.open) return Promise.resolve();
      patch({ open: true });
      const operation = runRead(null, 'open');
      track(operation);
      return operation;
    },
    close: () => {
      if (disposed) return;
      retireInFlight();
      currentCursor = null;
      patch({ open: false, ...clearPrivateState() });
    },
    refresh: () => {
      if (disposed) return Promise.resolve();
      const operation = runRead(currentCursor, 'refresh');
      track(operation);
      return operation;
    },
    nextPage: () => {
      if (disposed) return Promise.resolve();
      const cursor = state.nextCursor;
      // No cursor: the server said there is no further page, so no request is
      // sent at all.
      if (!cursor) return Promise.resolve();
      const operation = runRead(cursor, 'page');
      track(operation);
      return operation;
    },
    firstPage: () => {
      if (disposed) return Promise.resolve();
      const operation = runRead(null, 'page');
      track(operation);
      return operation;
    },
    openCreateForm: () => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      if (state.phase !== 'ready' && state.phase !== 'empty') return;
      formGeneration += 1;
      patchForm({
        mode: 'create',
        nameDraft: '',
        orderDraft: '',
        targetId: null,
        targetName: null,
        originalName: null,
        originalOrder: null,
        error: null,
      });
    },
    openEditForm: (unitId) => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      const row = state.rows.find((candidate) => candidate.id === unitId);
      // The form is bound to a unit of the CURRENT page only.
      if (!row) return;
      formGeneration += 1;
      patchForm({
        mode: 'edit',
        nameDraft: row.name,
        orderDraft: String(row.display_order),
        targetId: row.id,
        targetName: row.name,
        originalName: row.name,
        originalOrder: String(row.display_order),
        error: null,
      });
    },
    updateNameDraft: (value) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      // A newer edit invalidates the binding of an in-flight write: the newer
      // draft is kept and is never closed by that older reply.
      formGeneration += 1;
      patchForm({ nameDraft: value, error: null });
    },
    updateOrderDraft: (value) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      formGeneration += 1;
      patchForm({ orderDraft: value, error: null });
    },
    cancelForm: () => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      formGeneration += 1;
      patchForm(closedForm());
    },
    create: () => {
      if (disposed) return Promise.resolve();
      if (state.form.mode !== 'create') return Promise.resolve();
      const name = validateName(state.form.nameDraft);
      if (name === null) {
        // Local validation happens BEFORE any request and keeps the input.
        patchForm({ error: COURSE_UNIT_NAME_INVALID_MESSAGE });
        return Promise.resolve();
      }
      const body: { name: string; display_order?: number } = { name };
      const rawOrder = state.form.orderDraft.trim();
      if (rawOrder.length > 0) {
        const order = parseCourseUnitOrder(state.form.orderDraft);
        if (order === null) {
          patchForm({ error: COURSE_UNIT_ORDER_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.display_order = order;
      }
      const operation = runMutation('create', null, body, { refreshAfter: true });
      track(operation);
      return operation;
    },
    save: () => {
      if (disposed) return Promise.resolve();
      if (state.form.mode !== 'edit') return Promise.resolve();
      const targetId = state.form.targetId;
      if (!targetId) return Promise.resolve();
      const originalName = state.form.originalName ?? '';
      const originalOrder = state.form.originalOrder ?? '';
      const body: { name?: string; display_order?: number } = {};
      const trimmedName = state.form.nameDraft.trim();
      const changedName = trimmedName !== originalName;
      if (changedName) {
        const name = validateName(state.form.nameDraft);
        if (name === null) {
          patchForm({ error: COURSE_UNIT_NAME_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.name = name;
      }
      const changedOrder = state.form.orderDraft.trim() !== originalOrder;
      if (changedOrder) {
        const order = parseCourseUnitOrder(state.form.orderDraft);
        if (order === null) {
          patchForm({ error: COURSE_UNIT_ORDER_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.display_order = order;
      }
      if (!changedName && !changedOrder) {
        // Nothing changed: no request is sent at all.
        patchForm({ error: COURSE_UNIT_NO_CHANGES_MESSAGE });
        return Promise.resolve();
      }
      const operation = runMutation('edit', targetId, body, {
        refreshAfter: changedOrder,
      });
      track(operation);
      return operation;
    },
    setStatus: (unitId, status) => {
      if (disposed) return Promise.resolve();
      const row = state.rows.find((candidate) => candidate.id === unitId);
      if (!row) return Promise.resolve();
      if (row.status === status) return Promise.resolve();
      const operation = runMutation('status', unitId, { status });
      track(operation);
      return operation;
    },
    reconcile: () => {
      if (disposed) return Promise.resolve();
      // Deliberate, explicit GET only after an uncertain write. It never
      // retries the write and never claims the write succeeded.
      if (state.mutation.status !== 'uncertain') return Promise.resolve();
      const operation = runRead(currentCursor, 'reconcile');
      track(operation);
      return operation;
    },
    waitForIdle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    dispose,
  };
}
