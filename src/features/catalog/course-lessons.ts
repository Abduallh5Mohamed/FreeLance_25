/**
 * M2-10 — private lesson metadata controls for ONE unit of the EXISTING course
 * details dialog.
 *
 * The production seam the unit panel mounts through
 * `src/features/catalog/CourseLessonManager.tsx`: this module owns the WHOLE
 * request and form lifecycle (explicit panel open, one bounded 25-row page,
 * next/first paging, create, edit title/description/position, archive and
 * reactivate, an explicit selection of VISIBLE rows and ONE atomic batch
 * reorder, owner-only labelling, runtime DTO validation, uncertain-write
 * handling, stale-reply invalidation, session and disposal fences) and keeps
 * React rendering out of the decision path.
 *
 * The transport, the principal reader and the session notifier are injected, so
 * the exact production code the panel runs is exercised hermetically in
 * node:test (src/tests/m2-course-lesson-ui.test.ts) with no DB, no network, no
 * browser and no live app.
 *
 * Contracts verified from source (docs/streams/server/M2-B05-CONTRACT.md,
 * server/src/routes/course-lessons.ts, accepted under supervisor/185):
 *  - `GET .../courses/:courseId/units/:unitId/lessons?limit=25[&cursor=...]`
 *    answers `{ lessons: [...], next_cursor: string | null }`; the lesson DTO is
 *    the explicit EIGHT fields `{ id, unit_id, title, description,
 *    display_order, status, created_at, updated_at }` — the row is never spread
 *    and no tenant/owner/course/billing/content field is exposed;
 *  - `POST .../lessons` takes the strict body `{ title }` plus an OPTIONAL
 *    `description` (`null` or a string of at most 10000 characters) and an
 *    OPTIONAL `display_order` NUMBER (the server refuses a numeric string, a
 *    float and a boolean); the status is always `active` on create; the lesson
 *    id is server-generated;
 *  - `PATCH .../lessons/:lessonId` takes a non-empty subset of `{ title }`,
 *    `{ description }` (`null` clears), `{ display_order }` and
 *    `{ status: 'active' | 'archived' }`, and the response id MUST match the
 *    requested lesson id and the unit;
 *  - `POST .../lessons/reorder` takes ONLY `{ items: [{ id, display_order }] }`
 *    with 1..100 unique canonical ids and answers `{ lessons: [...] }` for the
 *    SELECTED lessons only, in the resulting `(display_order, id)` order;
 *  - the lesson routes are owner-only, resolved from server-side rows: a
 *    membership role label never grants access and a membership instructor gets
 *    403 `Forbidden`. The course must exist, be active and belong to the
 *    selected tenant, and the unit must belong to that course, so a foreign,
 *    inactive or absent course/unit answers identically;
 *  - the local billing-only guard answers 403 with the lesson-specific
 *    `Course lesson management is not available while the account is limited to
 *    billing and support` (code `BILLING_ONLY`) — the shared transport keeps its
 *    canonical identity event and redirect untouched;
 *  - the documented failures are 400 `Invalid course id` /
 *    `Invalid course unit id` / `Invalid course lesson id` /
 *    `Invalid course lesson payload` / `Invalid course lesson update payload` /
 *    `Invalid course lesson reorder payload` / `Invalid course lesson list
 *    limit` / `Invalid course lesson list cursor`, 404
 *    `Tenant membership not found` / `Course not found` /
 *    `Course unit not found` / `Course lesson not found`, 409
 *    `Course lesson was modified concurrently`, 500 `Failed to list course
 *    lessons` / `Failed to create course lesson` / `Failed to update course
 *    lesson` / `Failed to reorder course lessons`, plus the unchanged upstream
 *    401/suspension answers;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify an
 *    outcome — no status is fabricated and a discarded code is never turned into
 *    a permission outcome;
 *  - the accepted migration FILE is NOT applied: a real deployment answers with
 *    a truthful error and no client-side fallback data is invented.
 *
 * Lifetimes fenced here:
 *  - binding: the controller is created for ONE `(courseId, unitId)` pair and
 *    that binding is immutable for its lifetime. The panel is keyed by the unit
 *    id, so a different unit is a different controller and an old unit's
 *    completion can never affect another unit;
 *  - page: every list read advances a page generation, so a reversed or
 *    superseded reply can never commit, and only ONE page (at most
 *    COURSE_LESSON_PAGE_LIMIT rows) is ever held in memory; the RESPONSE is
 *    validated against the same bound BEFORE any row is traversed or copied, so
 *    an oversized page is a malformed response and never a held page;
 *  - selection: the selection is bound to the VISIBLE page instance. It is
 *    cleared whenever the rows are replaced, the panel closes, a permission loss
 *    is observed or the controller is disposed, and it can never contain a
 *    lesson outside the current page or more than COURSE_LESSON_REORDER_LIMIT
 *    ids. A reorder batch is therefore always a subset of the page the user is
 *    looking at;
 *  - request: every mutation advances its own request generation and takes a
 *    synchronous single-flight latch BEFORE the first await, so a double click
 *    or Enter never sends a second write. The latch is released as soon as the
 *    server CONFIRMS the write — BEFORE the bounded follow-up read is awaited —
 *    so an ENABLED control is never a silent no-op while the refresh is on the
 *    wire. A second write is still refused while an actual write request is on
 *    the wire, and an older `finally` can never release a NEWER mutation's
 *    latch;
 *  - form: opening, cancelling, editing, toggling the explicit description clear
 *    or invalidating a form advances the form generation, so a late reply never
 *    rewrites or closes a newer form and a newer edit is never overwritten by an
 *    older confirmed save;
 *  - authorization: a DEFINITE read authorization or scope loss (an expired
 *    session, a suspension, the billing-only restriction, the owner-only
 *    denial, a missing workspace, a missing course, a missing unit) clears the
 *    private rows, the selection, the form, the drafts, the target and the
 *    confirmation and retires every in-flight operation, so an older write or
 *    read can never repopulate the cleared private state. A retryable read
 *    failure keeps the private draft, because no permission loss was proven;
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read and write, on the SUCCESS and the FAILURE path, and a RETIRED
 *    operation observes it BEFORE it settles any visible state — a silent
 *    logout can never revive the previous principal's rows or drafts;
 *  - close/dispose: the panel clears the private rows, the selection, the drafts
 *    and the cursors and drops every in-flight reply. The close control stays
 *    usable while a read is on the wire.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success;
 *  - a PATCH response for another lesson (or another unit) is NOT a success, and
 *    a reorder response that does not carry EXACTLY the requested identity set —
 *    a duplicate, a missing id, a foreign unit or an extra row — is NOT a
 *    success either;
 *  - a 500/network/malformed write outcome is UNCERTAIN: the write may have
 *    persisted, nothing is retried automatically, the draft is preserved and a
 *    deliberate list read is offered. The matching row in the list is the
 *    CURRENT state — never proof of the earlier write or its audit — and
 *    because duplicate titles are allowed a deliberate create retry may create a
 *    duplicate lesson;
 *  - a confirmed success uses the validated server DTO only; at most ONE bounded
 *    first-page read follows a confirmed create or a confirmed reorder (and a
 *    confirmed position change), so the panel keeps the server's canonical
 *    ordering, and a FAILED follow-up read never turns the confirmed save into a
 *    failed save.
 *
 * Out of scope by construction: no new route, no backend/schema/migration
 * application, no lesson delivery/content/asset, no teacher/student assignment,
 * no publication, no progression, no payment, no OTP, no shared
 * auth/error/session change, and no lesson capability inferred from a local
 * role, a profile, a unit selection or a tenant status. The selected course and
 * unit ids are RESOURCE ids, never a tenant authority.
 */
import {
  COURSE_LESSON_PAGE_LIMIT,
  COURSE_LESSON_REORDER_LIMIT,
  type CourseLesson,
  type CourseLessonEnvelope,
  type CourseLessonListEnvelope,
  type CourseLessonReorderEnvelope,
  type CourseLessonStatus,
} from '../../lib/api-http';
import { createCourseOperationGuard, createTicketSource } from './course-management';

/**
 * The canonical session reader the courses page uses. Re-exported so the panel
 * imports ONE principal boundary: M2-02's reader holds the single canonical
 * localStorage lifetime.
 */
export { readCourseSessionPrincipal } from './course-management';
export type { CourseSessionStorage } from './course-management';

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

/** The panel's own wording for a body that is not the documented envelope. The
 *  server never sends this string, so it can never be confused with a server
 *  classification. */
export const MALFORMED_COURSE_LESSON_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Local validation wording: the input never reaches the transport. */
export const COURSE_LESSON_TITLE_INVALID_MESSAGE =
  'عنوان الدرس يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات.';

/** Local validation wording for the optional description. */
export const COURSE_LESSON_DESCRIPTION_INVALID_MESSAGE =
  'وصف الدرس يجب أن يكون نصًا لا يزيد عن 10000 حرف.';

/** Local validation wording for the metadata position. */
export const COURSE_LESSON_ORDER_INVALID_MESSAGE =
  'موضع الدرس يجب أن يكون رقمًا صحيحًا بين 0 و2147483647.';

/** Local wording when the editor holds no change at all. */
export const COURSE_LESSON_NO_CHANGES_MESSAGE = 'لا توجد تغييرات لحفظها.';

/** Local wording when the selection cannot form a batch. */
export const COURSE_LESSON_SELECTION_INVALID_MESSAGE =
  'حدّد درسًا واحدًا على الأقل من الصفحة الحالية (بحد أقصى 25 درسًا) لتنفيذ الترتيب.';

/** Local wording when the reorder drafts hold no change at all. */
export const COURSE_LESSON_REORDER_NO_CHANGES_MESSAGE =
  'لم تتغيّر أي مواضع في التحديد؛ لم يُرسل أي طلب.';

/** Local warning after a reply that may or may not have persisted server-side. */
export const COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ بيانات الدرس. قد تكون التغييرات قد حُفظت على الخادم؛ اقرأ القائمة الحالية للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after the deliberate read-only reconciliation. A matching
 *  lesson is the CURRENT state, never proof of the previous write or its audit. */
export const COURSE_LESSON_RECONCILED_MESSAGE =
  'تم عرض القائمة الحالية من الخادم. هذا لا يؤكد نجاح محاولة الحفظ السابقة.';

/** Duplicate titles are allowed by the accepted contract, so a deliberate create
 *  retry can create a second lesson with the same title. */
export const COURSE_LESSON_DUPLICATE_CREATE_WARNING =
  'عناوين الدروس مسموح بتكرارها؛ إعادة محاولة الإنشاء قد تنشئ درسًا مكررًا.';

/** The honest paging notice: the cursor is a POSITION, not a snapshot. */
export const COURSE_LESSON_PAGING_NOTICE =
  'الصفحة محدودة بـ25 درسًا في كل مرة، والموضع مؤشر لا لقطة ثابتة؛ أي إعادة ترتيب بين قراءتين قد تُظهر درسًا مكررًا أو تُخفي درسًا.';

/** The metadata position is a DISPLAY position inside the unit. It is not a
 *  lesson unlocking rule, a publication switch or an access policy. */
export const COURSE_LESSON_METADATA_NOTICE =
  'الموضع هنا ترتيب عرض داخل الوحدة فقط؛ لا ينشر محتوى ولا يغيّر صلاحية وصول الطالب ولا يفتح مادة.';

/** The archive notice: archiving a lesson is metadata only. */
export const COURSE_LESSON_ARCHIVE_NOTICE =
  'أرشفة الدرس تغيّر بياناته الوصفية فقط؛ لا تحذف محتوى ولا تغيّر صلاحية وصول الطالب.';

/** Upstream authentication answers — the EXACT messages the shared transport
 *  throws (server/src/middleware/auth.ts). The transport discards the HTTP
 *  status and the `code` field, so the classifier matches the transported
 *  `error` string, never a synthetic code. */
const SESSION_INVALID_MESSAGES = new Set<string>([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
]);

/** The account is administratively suspended. */
const SUSPENDED_MESSAGE = 'Instructor account is administratively suspended';

/** No authorized workspace: the handler's 404. It fails closed: no rows. */
const NO_WORKSPACE_MESSAGE = 'Tenant membership not found';

/** The accepted lesson-local billing-only denial (M2-B05 contract). */
const BILLING_ONLY_MESSAGE =
  'Course lesson management is not available while the account is limited to billing and support';

/** The owner-only denial for a membership instructor (M2-B05 contract). */
const FORBIDDEN_MESSAGE = 'Forbidden';

/** The course is absent, foreign or inactive — identical for all three. */
const MISSING_COURSE_MESSAGE = 'Course not found';

/** The parent unit is absent, foreign or belongs to another course. */
const MISSING_UNIT_MESSAGE = 'Course unit not found';

/** The lesson is absent, foreign or belongs to another unit — and the identical
 *  answer for a batch that contains one foreign/missing id. */
const MISSING_LESSON_MESSAGE = 'Course lesson not found';

/** The accepted concurrent-row outcome: the server rolled back and did not
 *  write, so this is a retryable conflict, not an uncertain write. */
const COURSE_LESSON_CONFLICT_MESSAGE = 'Course lesson was modified concurrently';

/** The handler's strict rejections: no connection was taken and nothing was
 *  written. */
const COURSE_LESSON_INVALID_MESSAGES = new Set<string>([
  'Invalid course id',
  'Invalid course unit id',
  'Invalid course lesson id',
  'Invalid course lesson payload',
  'Invalid course lesson update payload',
  'Invalid course lesson reorder payload',
  'Invalid course lesson list limit',
  'Invalid course lesson list cursor',
]);

/** The accepted handler 500 wordings. */
const COURSE_LESSON_LIST_FAILED_MESSAGE = 'Failed to list course lessons';
const COURSE_LESSON_CREATE_FAILED_MESSAGE = 'Failed to create course lesson';
const COURSE_LESSON_UPDATE_FAILED_MESSAGE = 'Failed to update course lesson';
const COURSE_LESSON_REORDER_FAILED_MESSAGE = 'Failed to reorder course lessons';

export type CourseLessonPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'malformed'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace'
  | 'missing-course'
  | 'missing-unit';

/** Why an outcome was classified. Every value comes from a documented
 *  transported message; nothing is guessed from a discarded code. */
export type CourseLessonFailureReason =
  | 'session'
  | 'suspended'
  | 'billing-only'
  | 'not-owner'
  | 'no-workspace'
  | 'missing-course'
  | 'missing-unit'
  | 'missing-lesson'
  | 'conflict'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface CourseLessonFailure {
  readonly phase: CourseLessonPhase;
  readonly reason: CourseLessonFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a LIST read.
 *
 * A permission outcome is never faked from an unrecognized message: it stays a
 * retryable read error with its actual message on screen.
 */
export function classifyCourseLessonFailure(cause: unknown): CourseLessonFailure {
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
  if (message === MISSING_UNIT_MESSAGE) {
    return { phase: 'missing-unit', reason: 'missing-unit', message };
  }
  if (message === COURSE_LESSON_LIST_FAILED_MESSAGE) {
    return { phase: 'error', reason: 'server', message };
  }
  return {
    phase: 'error',
    reason: 'unknown',
    message: message || 'فشل تحميل دروس الوحدة',
  };
}

export type CourseLessonWriteKind =
  | 'unauthorized'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'missing'
  | 'uncertain';

/**
 * A DEFINITE loss of the list's read authorization or of the tenant/course/unit
 * scope.
 *
 * Only the documented denial answers qualify: an expired or invalid session, an
 * administratively suspended account, the billing-only restriction, the
 * owner-only denial, a missing workspace, a missing course and a missing parent
 * unit. Every one of them is a server statement that this session may no longer
 * read this unit's private lesson metadata, so the private rows, the selection,
 * the form and the confirmation must not stay on screen.
 *
 * A retryable read failure does NOT prove a permission loss: the handler 500
 * (`Failed to list course lessons`), a network error and an unrecognized message
 * keep the private draft.
 */
export function isCourseLessonAuthorizationLoss(reason: CourseLessonFailureReason): boolean {
  return (
    reason === 'session' ||
    reason === 'suspended' ||
    reason === 'billing-only' ||
    reason === 'not-owner' ||
    reason === 'no-workspace' ||
    reason === 'missing-course' ||
    reason === 'missing-unit'
  );
}

export interface CourseLessonWriteFailure {
  readonly kind: CourseLessonWriteKind;
  readonly reason: CourseLessonFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a WRITE.
 *
 * `uncertain` covers the handler 500 (the client cannot distinguish a confirmed
 * rollback from a lost commit acknowledgement) and every unrecognized/network/
 * transport failure after the request was sent: the write MAY have persisted, so
 * nothing is retried automatically.
 */
export function classifyCourseLessonWriteFailure(cause: unknown): CourseLessonWriteFailure {
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
    return { kind: 'denied', reason: 'missing-unit', message };
  }
  if (message === MISSING_LESSON_MESSAGE) {
    return { kind: 'missing', reason: 'missing-lesson', message };
  }
  if (message === COURSE_LESSON_CONFLICT_MESSAGE) {
    return { kind: 'conflict', reason: 'conflict', message };
  }
  if (COURSE_LESSON_INVALID_MESSAGES.has(message)) {
    return { kind: 'invalid', reason: 'invalid', message };
  }
  if (
    message === COURSE_LESSON_CREATE_FAILED_MESSAGE ||
    message === COURSE_LESSON_UPDATE_FAILED_MESSAGE ||
    message === COURSE_LESSON_REORDER_FAILED_MESSAGE
  ) {
    return { kind: 'uncertain', reason: 'server', message };
  }
  return {
    kind: 'uncertain',
    reason: 'unknown',
    message: message || 'فشل غير مؤكد أثناء حفظ بيانات الدرس',
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
 * the server refuses a cursor that is empty, longer than 256 characters or not a
 * string, so a cursor outside that bound is a malformed response and is never
 * sent back to the server.
 */
const CURSOR_MAX_LENGTH = 256;
const isUsableCursor = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && value.length > 0 && value.length <= CURSOR_MAX_LENGTH);

/** A server-generated lesson, unit and course id are UUIDs. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The canonical instant the server emits: `Date#toISOString()` of the projected
 * epoch — exactly `YYYY-MM-DDTHH:MM:SS.sssZ`. A different shape is not the
 * documented projection, so it is a malformed response rather than a date the
 * panel would have to interpret.
 */
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A canonical instant must ALSO be a REAL instant.
 *
 * The shape alone would accept impossible and calendar-overflow values such as
 * `2026-99-99T88:77:66.000Z` or `2026-02-30T00:00:00.000Z`, and the server never
 * emits them: it emits `Date#toISOString()` of the projected epoch. The value is
 * therefore parsed as a real date and must round-trip EXACTLY back to the same
 * canonical string. A non-finite instant, an impossible field and a normalized
 * overflow (`2026-02-30` → `2026-03-02`) are all refused. There is NO fallback
 * date and no coerced value: an unusable instant is a malformed response.
 */
const isCanonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !CANONICAL_ISO_PATTERN.test(value)) return false;
  const instant = new Date(value);
  const time = instant.getTime();
  if (!Number.isFinite(time)) return false;
  return instant.toISOString() === value;
};

/** `display_order` is a nonnegative signed 32-bit integer. */
export const COURSE_LESSON_DISPLAY_ORDER_MAX = 2147483647;

/** The engineering bound on the optional free-text description. */
export const COURSE_LESSON_DESCRIPTION_MAX = 10000;

/** The exact eight server-projected fields, sorted for an exact key check. */
const COURSE_LESSON_KEYS = [
  'created_at',
  'description',
  'display_order',
  'id',
  'status',
  'title',
  'unit_id',
  'updated_at',
];

/**
 * Parses the metadata position the user typed.
 *
 * Only plain decimal digits are accepted: a sign, a decimal point, an exponent,
 * a whitespace-separated value and an Arabic-Indic digit are all refused,
 * because the server itself refuses a numeric string, a float and a boolean. The
 * result is a NUMBER that is already an integer in 0..2147483647, so the
 * transport never has to coerce anything.
 */
export function parseCourseLessonOrder(raw: string): number | null {
  const text = (raw ?? '').trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  if (value < 0 || value > COURSE_LESSON_DISPLAY_ORDER_MAX) return null;
  return value;
}

/** A title is a trimmed free label of 1..255 characters. */
export function parseCourseLessonTitle(raw: string): string | null {
  const title = (raw ?? '').trim();
  if (title.length < 1 || title.length > 255) return null;
  return title;
}

/**
 * A description is free text of at most 10000 characters, stored verbatim. An
 * empty string is a legitimate description; clearing the description is an
 * EXPLICIT `null`, never an inferred empty string.
 */
export function parseCourseLessonDescription(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > COURSE_LESSON_DESCRIPTION_MAX) return null;
  return raw;
}

export type CourseLessonParseResult =
  | { readonly ok: true; readonly lesson: CourseLesson }
  | { readonly ok: false };

/**
 * Validates one lesson DTO against the accepted M2-B05 contract: a non-null
 * object whose `id` is a UUID, whose `unit_id` is EXACTLY the unit this
 * controller is bound to, whose `title` is a trimmed 1..255 string, whose
 * `description` is `null` or a string of at most 10000 characters, whose
 * `display_order` is an integer in 0..2147483647, whose `status` is exactly
 * `active` or `archived`, whose two timestamps are canonical ISO instants that
 * are REAL instants (the exact `Date#toISOString()` projection, not only its
 * shape) — and whose key set is EXACTLY the eight projected fields.
 *
 * Anything else — a non-object, a wrong field type, an unknown status, a spread
 * row with an extra key, a lesson of another unit — is a malformed response,
 * never a fabricated lesson.
 */
export function parseCourseLesson(body: unknown, expectedUnitId: string): CourseLessonParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const row = body as Record<string, unknown>;
  const id = row.id;
  const unitId = row.unit_id;
  const title = row.title;
  const description = row.description;
  const displayOrder = row.display_order;
  const status = row.status;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (!isNonEmptyString(id) || !UUID_PATTERN.test(id)) return { ok: false };
  // The unit binding: a lesson of ANOTHER unit is never a success here.
  if (unitId !== expectedUnitId) return { ok: false };
  if (typeof title !== 'string') return { ok: false };
  const trimmedTitle = title.trim();
  if (trimmedTitle.length < 1 || trimmedTitle.length > 255) return { ok: false };
  if (description !== null) {
    if (typeof description !== 'string') return { ok: false };
    if (description.length > COURSE_LESSON_DESCRIPTION_MAX) return { ok: false };
  }
  if (typeof displayOrder !== 'number') return { ok: false };
  if (!Number.isInteger(displayOrder)) return { ok: false };
  if (displayOrder < 0 || displayOrder > COURSE_LESSON_DISPLAY_ORDER_MAX) return { ok: false };
  if (status !== 'active' && status !== 'archived') return { ok: false };
  if (!isCanonicalInstant(createdAt)) return { ok: false };
  if (!isCanonicalInstant(updatedAt)) return { ok: false };
  const keys = Object.keys(row).sort();
  if (keys.length !== COURSE_LESSON_KEYS.length) return { ok: false };
  for (let index = 0; index < COURSE_LESSON_KEYS.length; index += 1) {
    if (keys[index] !== COURSE_LESSON_KEYS[index]) return { ok: false };
  }
  return {
    ok: true,
    lesson: {
      id,
      unit_id: expectedUnitId,
      title,
      description: description as string | null,
      display_order: displayOrder,
      status,
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
}

export type CourseLessonListParseResult =
  | { readonly ok: true; readonly lessons: CourseLesson[]; readonly nextCursor: string | null }
  | { readonly ok: false };

/**
 * Validates the list envelope: exactly `{ lessons, next_cursor }`, an array of
 * valid lesson DTOs of the BOUND unit and a cursor that is a string or exactly
 * `null`.
 *
 * The page memory bound is enforced HERE, on the RESPONSE, and not only by the
 * request: a response carrying MORE rows than `COURSE_LESSON_PAGE_LIMIT` is a
 * malformed response. It is rejected BEFORE a single row is traversed or copied,
 * so an oversized page is never held in memory, never silently truncated and
 * never paired with a fabricated cursor.
 */
export function parseCourseLessonList(
  body: unknown,
  expectedUnitId: string,
): CourseLessonListParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'lessons' || keys[1] !== 'next_cursor') {
    return { ok: false };
  }
  const list = envelope.lessons;
  if (!Array.isArray(list)) return { ok: false };
  // The response memory bound, checked BEFORE any row is read or copied.
  if (list.length > COURSE_LESSON_PAGE_LIMIT) return { ok: false };
  const nextCursor = envelope.next_cursor;
  if (!isNullableString(nextCursor)) return { ok: false };
  if (!isUsableCursor(nextCursor)) return { ok: false };
  const lessons: CourseLesson[] = [];
  for (const item of list) {
    const parsed = parseCourseLesson(item, expectedUnitId);
    if (!parsed.ok) return { ok: false };
    lessons.push(parsed.lesson);
  }
  return { ok: true, lessons, nextCursor };
}

export type CourseLessonEnvelopeParseResult =
  | { readonly ok: true; readonly lesson: CourseLesson }
  | { readonly ok: false };

/** Validates the `{ lesson }` envelope of a confirmed create/update. */
export function parseCourseLessonEnvelope(
  body: unknown,
  expectedUnitId: string,
): CourseLessonEnvelopeParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 1 || keys[0] !== 'lesson') return { ok: false };
  return parseCourseLesson(envelope.lesson, expectedUnitId);
}

export type CourseLessonReorderParseResult =
  | { readonly ok: true; readonly lessons: CourseLesson[] }
  | { readonly ok: false };

/**
 * Validates the `{ lessons }` envelope of a confirmed atomic reorder.
 *
 * The response must be EXACTLY the requested identity set: the same number of
 * rows, every row a valid DTO of the bound unit, no duplicate id, no id that was
 * not requested and no requested id missing. Anything else — a duplicate, an
 * extra row, a foreign unit, a short list — is a malformed response and is
 * rejected BEFORE a single row is applied, so a partial or foreign batch is
 * never presented as a success.
 *
 * The comparison is case-insensitive on the UUID, because a UUID has no case
 * meaning; the returned identity is what is displayed.
 */
export function parseCourseLessonReorderEnvelope(
  body: unknown,
  expectedUnitId: string,
  requestedIds: readonly string[],
): CourseLessonReorderParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 1 || keys[0] !== 'lessons') return { ok: false };
  const list = envelope.lessons;
  if (!Array.isArray(list)) return { ok: false };
  if (requestedIds.length < 1 || requestedIds.length > COURSE_LESSON_REORDER_LIMIT) return { ok: false };
  // The identity-set bound is checked BEFORE any row is traversed or copied.
  if (list.length !== requestedIds.length) return { ok: false };
  const requested = new Set(requestedIds.map((id) => id.toLowerCase()));
  if (requested.size !== requestedIds.length) return { ok: false };
  const seen = new Set<string>();
  const lessons: CourseLesson[] = [];
  for (const item of list) {
    const parsed = parseCourseLesson(item, expectedUnitId);
    if (!parsed.ok) return { ok: false };
    const key = parsed.lesson.id.toLowerCase();
    if (seen.has(key)) return { ok: false };
    if (!requested.has(key)) return { ok: false };
    seen.add(key);
    lessons.push(parsed.lesson);
  }
  if (seen.size !== requested.size) return { ok: false };
  return { ok: true, lessons };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CourseLessonMutationKind = 'create' | 'edit' | 'status' | 'reorder';

export type CourseLessonMutationStatus = 'idle' | 'saving' | 'uncertain';

export interface CourseLessonMutationState {
  status: CourseLessonMutationStatus;
  kind: CourseLessonMutationKind | null;
  /** The lesson the mutation targets (null for a create or a batch). */
  targetId: string | null;
  /** The actual transported failure message, or local validation wording. */
  error: string | null;
  /** Warning after an uncertain write or a reconciliation read. Never success. */
  notice: string | null;
}

export type CourseLessonFormMode = 'closed' | 'create' | 'edit' | 'reorder';

/** One selected row of the reorder form: its identity and the position typed. */
export interface CourseLessonReorderDraft {
  readonly id: string;
  readonly title: string;
  readonly orderDraft: string;
}

export interface CourseLessonFormState {
  mode: CourseLessonFormMode;
  /** The user's title draft, preserved verbatim on every failed write. */
  titleDraft: string;
  /** The user's description draft, exactly as typed. */
  descriptionDraft: string;
  /** The explicit "clear the description" flag — the ONLY way to send `null`. */
  clearDescription: boolean;
  /** The user's metadata-position draft, exactly as typed. */
  orderDraft: string;
  /** The lesson the edit form is bound to. */
  targetId: string | null;
  /** The lesson title the edit form was opened for (display only). */
  targetTitle: string | null;
  /** The server-confirmed title the edit form was opened with. */
  originalTitle: string | null;
  /** The server-confirmed description the edit form was opened with. */
  originalDescription: string | null;
  /** The server-confirmed position the edit form was opened with. */
  originalOrder: string | null;
  /** The selected rows and their typed positions, in page order. */
  reorderDrafts: CourseLessonReorderDraft[];
  error: string | null;
}

/** The server-confirmed outcome of a reorder batch (never a prediction). */
export interface CourseLessonReorderConfirmation {
  /** How many selected rows the server returned. */
  readonly selected: number;
  /** How many of them changed position (compared with the pre-batch page). */
  readonly changed: number;
}

export interface CourseLessonState {
  /** The panel was explicitly opened by the user. No request happens before. */
  open: boolean;
  phase: CourseLessonPhase;
  /** The bounded current page only (at most COURSE_LESSON_PAGE_LIMIT rows). */
  rows: CourseLesson[];
  /** The cursor of the NEXT page, or null when the server says there is none. */
  nextCursor: string | null;
  /** True when the current page is not the first page. */
  hasPreviousPage: boolean;
  error: string | null;
  /** Why the current phase was reached, when a failure caused it. */
  reason: CourseLessonFailureReason | null;
  /**
   * A failed follow-up read AFTER a confirmed write. It never turns the
   * confirmed save into a failed save: the confirmation and the rows survive,
   * and only this note reports the failed refresh.
   */
  refreshError: string | null;
  /** The server-confirmed result of the last confirmed single-lesson write. */
  lastConfirmed: CourseLesson | null;
  /** The server-confirmed result of the last confirmed reorder batch. */
  lastReorder: CourseLessonReorderConfirmation | null;
  /** The selected rows of the CURRENT page (at most the reorder bound). */
  selectedIds: string[];
  form: CourseLessonFormState;
  mutation: CourseLessonMutationState;
}

const closedForm = (): CourseLessonFormState => ({
  mode: 'closed',
  titleDraft: '',
  descriptionDraft: '',
  clearDescription: false,
  orderDraft: '',
  targetId: null,
  targetTitle: null,
  originalTitle: null,
  originalDescription: null,
  originalOrder: null,
  reorderDrafts: [],
  error: null,
});

const idleMutation = (): CourseLessonMutationState => ({
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
});

const initialState: CourseLessonState = {
  open: false,
  phase: 'idle',
  rows: [],
  nextCursor: null,
  hasPreviousPage: false,
  error: null,
  reason: null,
  refreshError: null,
  lastConfirmed: null,
  lastReorder: null,
  selectedIds: [],
  form: closedForm(),
  mutation: idleMutation(),
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface CourseLessonApi {
  listLessons: (params: {
    courseId: string;
    unitId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CourseLessonListEnvelope>;
  /** Accepted M2-B05 owner-only create through the canonical transport. */
  createLesson?: (
    courseId: string,
    unitId: string,
    input: { title: string; description?: string | null; display_order?: number },
  ) => Promise<CourseLessonEnvelope>;
  /** Accepted M2-B05 owner-only update through the canonical transport. */
  updateLesson?: (
    courseId: string,
    unitId: string,
    lessonId: string,
    update: {
      title?: string;
      description?: string | null;
      display_order?: number;
      status?: CourseLessonStatus;
    },
  ) => Promise<CourseLessonEnvelope>;
  /** Accepted M2-B05 owner-only atomic batch reorder. */
  reorderLessons?: (
    courseId: string,
    unitId: string,
    items: ReadonlyArray<{ id: string; display_order: number }>,
  ) => Promise<CourseLessonReorderEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface CourseLessonController {
  /** The course this controller is bound to. Immutable for its lifetime. */
  readonly courseId: string;
  /** The unit this controller is bound to. Immutable for its lifetime. */
  readonly unitId: string;
  getState(): CourseLessonState;
  subscribe(listener: (state: CourseLessonState) => void): () => void;
  /** Explicit panel open: exactly ONE bounded page read, never before. */
  open(): Promise<void>;
  /** Closes the panel: the private rows, selection and drafts are cleared. */
  close(): void;
  /** A deliberate read of the CURRENT page (never a write). */
  refresh(): Promise<void>;
  /** The next page, using the server's opaque cursor. */
  nextPage(): Promise<void>;
  /** Back to the first page (the cursor is dropped). */
  firstPage(): Promise<void>;
  /** Opens the create form (no request). */
  openCreateForm(): void;
  /** Opens the edit form for a lesson of the current page (no request). */
  openEditForm(lessonId: string): void;
  /** Updates the title draft without issuing a request. */
  updateTitleDraft(value: string): void;
  /** Updates the description draft without issuing a request. */
  updateDescriptionDraft(value: string): void;
  /** Sets the explicit "clear the description" flag (sends `null`). */
  setClearDescription(clear: boolean): void;
  /** Updates the position draft without issuing a request. */
  updateOrderDraft(value: string): void;
  /** Closes the form; a late reply can never reopen or mutate it. */
  cancelForm(): void;
  /** Explicit single-flight create (owner-only, server-authoritative). */
  create(): Promise<void>;
  /** Explicit single-flight save of the title, description and/or position. */
  save(): Promise<void>;
  /** Explicit single-flight archive/reactivation of one lesson. */
  setStatus(lessonId: string, status: CourseLessonStatus): Promise<void>;
  /** Toggles one VISIBLE row in the reorder selection (bounded). */
  toggleSelection(lessonId: string): void;
  /** Clears the whole reorder selection. */
  clearSelection(): void;
  /** Opens the reorder form for the current selection (no request). */
  openReorderForm(): void;
  /** Updates one typed position of the reorder form (no request). */
  updateReorderDraft(lessonId: string, value: string): void;
  /** Validates every position, then sends ONE atomic batch request. */
  submitReorder(): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain write. */
  reconcile(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

type ReadMode = 'open' | 'page' | 'refresh' | 'reconcile' | 'post-write';

/** One validated write request, built from the form/selection state. */
type LessonWriteRequest =
  | {
      readonly kind: 'create';
      readonly body: { title: string; description?: string | null; display_order?: number };
    }
  | {
      readonly kind: 'edit';
      readonly targetId: string;
      readonly body: {
        title?: string;
        description?: string | null;
        display_order?: number;
      };
      /** A position change re-reads the page so the canonical order is shown. */
      readonly refreshAfter: boolean;
    }
  | { readonly kind: 'status'; readonly targetId: string; readonly status: CourseLessonStatus }
  | {
      readonly kind: 'reorder';
      readonly items: ReadonlyArray<{ id: string; display_order: number }>;
      readonly requestedIds: readonly string[];
      /** The positions before the batch, to report the changed count truthfully. */
      readonly before: Readonly<Record<string, number>>;
    };

export function createCourseLessonController(
  courseId: string,
  unitId: string,
  api: CourseLessonApi,
): CourseLessonController {
  // The (course, unit) binding is immutable for the controller's lifetime.
  const boundCourseId = courseId;
  const boundUnitId = unitId;
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: CourseLessonState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** One list read at a time. */
  const readGuard = createCourseOperationGuard(tickets);
  /** One mutation at a time — including a batch reorder. */
  const writeGuard = createCourseOperationGuard(tickets);
  let pageGeneration = 0;
  let requestGeneration = 0;
  let formGeneration = 0;
  let mutationOwner = 0;
  let confirmedWriteEpoch = 0;
  let phaseOwner = 0;
  let currentCursor: string | null = null;

  const patch = (changes: Partial<CourseLessonState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<CourseLessonFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<CourseLessonMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** Clears every private trace of the panel (rows, selection, drafts). */
  const clearPrivateState = (): Partial<CourseLessonState> => ({
    phase: 'idle',
    rows: [],
    nextCursor: null,
    hasPreviousPage: false,
    error: null,
    reason: null,
    refreshError: null,
    lastConfirmed: null,
    lastReorder: null,
    selectedIds: [],
    form: closedForm(),
    mutation: idleMutation(),
  });

  /**
   * Discards everything in flight and the latches they hold. The generations are
   * advanced so a reply that is still on the wire can no longer commit.
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
   * produced no notifier event). The private rows, the selection and the drafts
   * are cleared BEFORE any new read starts, and every in-flight reply is
   * retired.
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
   * Adopts an observed principal change on behalf of a RETIRED operation. A
   * retired operation must observe the canonical principal BEFORE it settles any
   * visible state. The latches are deliberately NOT released here — every
   * operation releases its own ticket in its `finally`.
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

  /** Settles the loading phase a retired read owns. */
  const settleReadPhase = (phaseToken: number): void => {
    if (phaseOwner !== phaseToken) return;
    if (state.phase !== 'loading') return;
    patch({ phase: state.rows.length > 0 ? 'ready' : 'idle', error: null, reason: null });
  };

  /** Applies a server-confirmed lesson to the held page (if it is on it). */
  const applyConfirmedLesson = (lesson: CourseLesson): void => {
    const index = state.rows.findIndex((row) => row.id === lesson.id);
    if (index === -1) {
      patch({ lastConfirmed: lesson });
      return;
    }
    const rows = state.rows.slice();
    rows[index] = lesson;
    patch({ rows, lastConfirmed: lesson });
  };

  const reconcileNoticeIfCurrent = (): void => {
    if (state.mutation.status !== 'uncertain') return;
    patchMutation({ notice: COURSE_LESSON_RECONCILED_MESSAGE });
  };

  const runRead = async (cursor: string | null, mode: ReadMode): Promise<void> => {
    if (disposed) return;
    if (!state.open) return;
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (!readGuard.acquire()) return;
    const ticket = readGuard.holder();
    const generation = ++pageGeneration;
    const epoch = confirmedWriteEpoch;
    const principal = entryPrincipal;
    const phaseToken = ++phaseOwner;
    patch({ phase: 'loading', error: null, reason: null });
    try {
      const body = await api.listLessons({
        courseId: boundCourseId,
        unitId: boundUnitId,
        limit: COURSE_LESSON_PAGE_LIMIT,
        cursor,
      });
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
      // A confirmed write landed while this read was on the wire, so the page it
      // carries is already stale: it is never committed over the confirmed
      // server state.
      if (epoch !== confirmedWriteEpoch) {
        settleReadPhase(phaseToken);
        return;
      }
      const parsed = parseCourseLessonList(body, boundUnitId);
      if (!parsed.ok) {
        if (mode === 'post-write') {
          patch({ refreshError: MALFORMED_COURSE_LESSON_MESSAGE });
          settleReadPhase(phaseToken);
          return;
        }
        patch({
          phase: 'malformed',
          rows: [],
          nextCursor: null,
          hasPreviousPage: false,
          selectedIds: [],
          error: MALFORMED_COURSE_LESSON_MESSAGE,
          reason: 'unknown',
          refreshError: null,
        });
        return;
      }
      currentCursor = cursor;
      patch({
        phase: parsed.lessons.length === 0 ? 'empty' : 'ready',
        rows: parsed.lessons,
        nextCursor: parsed.nextCursor,
        hasPreviousPage: cursor !== null,
        // The selection is bound to the page instance the user saw: a replaced
        // page can never keep a stale selection.
        selectedIds: [],
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
      const failure = classifyCourseLessonFailure(cause);
      if (isCourseLessonAuthorizationLoss(failure.reason)) {
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
        patch({ refreshError: failure.message });
        settleReadPhase(phaseToken);
        return;
      }
      patch({
        phase: failure.phase,
        rows: [],
        nextCursor: null,
        hasPreviousPage: false,
        selectedIds: [],
        error: failure.message,
        reason: failure.reason,
        refreshError: null,
      });
    } finally {
      readGuard.release(ticket);
    }
  };

  /**
   * Settles a mutation that can no longer commit because a newer mutation, a
   * newer page or a session change owns the displayed state. The reply is never
   * committed and never claims success: the busy state is settled truthfully, the
   * draft is preserved and a genuinely unknown write outcome stays explicitly
   * uncertain.
   */
  const settleSupersededMutation = (
    token: number,
    parsedOk: boolean,
    cause: unknown | null,
  ): void => {
    if (mutationOwner !== token) return;
    if (state.mutation.status !== 'saving') return;
    if (cause !== null) {
      const failure = classifyCourseLessonWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        currentCursor = null;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        patchMutation({
          status: 'uncertain',
          error: failure.message,
          notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
      return;
    }
    if (!parsedOk) {
      patchMutation({
        status: 'uncertain',
        error: null,
        notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
      });
      return;
    }
    patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
  };

  const runWrite = async (request: LessonWriteRequest): Promise<void> => {
    if (disposed) return;
    if (request.kind === 'create' && !api.createLesson) return;
    if ((request.kind === 'edit' || request.kind === 'status') && !api.updateLesson) return;
    if (request.kind === 'reorder' && !api.reorderLessons) return;

    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (disposed) return;

    // Synchronous single-flight: a second click/Enter before the first await
    // never reaches the transport.
    if (!writeGuard.acquire()) return;
    const ticket = writeGuard.holder();
    /**
     * The mutation's OWN latch ticket is released AT MOST ONCE: either right
     * after the server confirmed the write — BEFORE the bounded follow-up read is
     * awaited — or in the `finally` of a failed, denied or uncertain write. The
     * ticket source is monotonic, so the older `finally` can never release a
     * NEWER mutation's latch.
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
    mutationOwner = token;
    patchMutation({
      status: 'saving',
      kind: request.kind,
      targetId: request.kind === 'edit' || request.kind === 'status' ? request.targetId : null,
      error: null,
      notice: null,
    });
    try {
      if (request.kind === 'create') {
        const response = await api.createLesson!(boundCourseId, boundUnitId, request.body);
        if (disposed) return;
        if (token !== requestGeneration) {
          const committedPrincipal = readPrincipal();
          if (committedPrincipal !== principal) {
            adoptPrincipalChange(committedPrincipal);
            return;
          }
          const parsed = parseCourseLessonEnvelope(response, boundUnitId);
          settleSupersededMutation(token, parsed.ok, null);
          return;
        }
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        const parsed = parseCourseLessonEnvelope(response, boundUnitId);
        if (!parsed.ok) {
          patchMutation({
            status: 'uncertain',
            error: null,
            notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
          });
          return;
        }
        confirmedWriteEpoch += 1;
        mutationOwner = 0;
        applyConfirmedLesson(parsed.lesson);
        if (formGeneration === formToken) {
          formGeneration += 1;
          patchForm(closedForm());
        }
        patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
        releaseWriteTicket();
        await runRead(null, 'post-write');
        return;
      }

      if (request.kind === 'edit' || request.kind === 'status') {
        const response =
          request.kind === 'edit'
            ? await api.updateLesson!(boundCourseId, boundUnitId, request.targetId, request.body)
            : await api.updateLesson!(boundCourseId, boundUnitId, request.targetId, {
                status: request.status,
              });
        if (disposed) return;
        if (token !== requestGeneration) {
          const committedPrincipal = readPrincipal();
          if (committedPrincipal !== principal) {
            adoptPrincipalChange(committedPrincipal);
            return;
          }
          const parsed = parseCourseLessonEnvelope(response, boundUnitId);
          settleSupersededMutation(token, parsed.ok, null);
          return;
        }
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        const parsed = parseCourseLessonEnvelope(response, boundUnitId);
        if (!parsed.ok) {
          patchMutation({
            status: 'uncertain',
            error: null,
            notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
          });
          return;
        }
        if (parsed.lesson.id !== request.targetId) {
          // A well-formed DTO for ANOTHER lesson is not a success for this
          // write: nothing is committed, the draft is preserved, the write stays
          // explicitly uncertain and no retry is sent.
          patchMutation({
            status: 'uncertain',
            error: null,
            notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
          });
          return;
        }
        confirmedWriteEpoch += 1;
        mutationOwner = 0;
        applyConfirmedLesson(parsed.lesson);
        if (request.kind === 'edit' && formGeneration === formToken) {
          formGeneration += 1;
          patchForm(closedForm());
        }
        patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
        if (request.kind === 'edit' && request.refreshAfter) {
          releaseWriteTicket();
          await runRead(null, 'post-write');
        }
        return;
      }

      // Atomic batch reorder: ONE request for the whole selection.
      const response = await api.reorderLessons!(boundCourseId, boundUnitId, request.items);
      if (disposed) return;
      const parsed = parseCourseLessonReorderEnvelope(
        response,
        boundUnitId,
        request.requestedIds,
      );
      if (token !== requestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededMutation(token, parsed.ok, null);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      if (!parsed.ok) {
        patchMutation({
          status: 'uncertain',
          error: null,
          notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // The server confirmed the batch AND returned exactly the requested
      // identity set: the changed rows are applied and the batch is reported
      // truthfully.
      confirmedWriteEpoch += 1;
      mutationOwner = 0;
      const changed = parsed.lessons.filter(
        (lesson) => request.before[lesson.id.toLowerCase()] !== lesson.display_order,
      ).length;
      const rows = state.rows.map((row) => {
        const updated = parsed.lessons.find(
          (lesson) => lesson.id.toLowerCase() === row.id.toLowerCase(),
        );
        return updated ?? row;
      });
      formGeneration += 1;
      patch({
        rows,
        form: closedForm(),
        selectedIds: [],
        lastConfirmed: null,
        lastReorder: { selected: parsed.lessons.length, changed },
      });
      patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
      releaseWriteTicket();
      // At most ONE bounded first-page read so the panel keeps the server's
      // canonical ordering after a reorder.
      await runRead(null, 'post-write');
    } catch (cause) {
      if (disposed) return;
      if (token !== requestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededMutation(token, false, cause);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyCourseLessonWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        currentCursor = null;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        mutationOwner = 0;
        patchMutation({
          status: 'uncertain',
          error: failure.message,
          notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid/missing: the server did not write. The rows, the
      // selection and the draft are preserved and the user may retry explicitly.
      mutationOwner = 0;
      patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
    } finally {
      releaseWriteTicket();
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        retireInFlight();
        observedPrincipal = readPrincipal();
        currentCursor = null;
        patch(clearPrivateState());
        if (state.open) {
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
    patch({ open: false, ...clearPrivateState() });
  };

  const visibleLesson = (lessonId: string): CourseLesson | null =>
    state.rows.find((candidate) => candidate.id === lessonId) ?? null;

  return {
    courseId: boundCourseId,
    unitId: boundUnitId,
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
        titleDraft: '',
        descriptionDraft: '',
        clearDescription: false,
        orderDraft: '',
        targetId: null,
        targetTitle: null,
        originalTitle: null,
        originalDescription: null,
        originalOrder: null,
        reorderDrafts: [],
        error: null,
      });
    },
    openEditForm: (lessonId) => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      const row = visibleLesson(lessonId);
      // The form is bound to a lesson of the CURRENT page only.
      if (!row) return;
      formGeneration += 1;
      patchForm({
        mode: 'edit',
        titleDraft: row.title,
        descriptionDraft: row.description ?? '',
        clearDescription: false,
        orderDraft: String(row.display_order),
        targetId: row.id,
        targetTitle: row.title,
        originalTitle: row.title,
        originalDescription: row.description,
        originalOrder: String(row.display_order),
        reorderDrafts: [],
        error: null,
      });
    },
    updateTitleDraft: (value) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      formGeneration += 1;
      patchForm({ titleDraft: value, error: null });
    },
    updateDescriptionDraft: (value) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      formGeneration += 1;
      patchForm({ descriptionDraft: value, error: null });
    },
    setClearDescription: (clear) => {
      if (disposed) return;
      if (state.form.mode !== 'edit') return;
      formGeneration += 1;
      patchForm({ clearDescription: clear, error: null });
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
      const title = parseCourseLessonTitle(state.form.titleDraft);
      if (title === null) {
        patchForm({ error: COURSE_LESSON_TITLE_INVALID_MESSAGE });
        return Promise.resolve();
      }
      const body: { title: string; description?: string | null; display_order?: number } = { title };
      const rawDescription = state.form.descriptionDraft;
      if (rawDescription.length > 0) {
        const description = parseCourseLessonDescription(rawDescription);
        if (description === null) {
          patchForm({ error: COURSE_LESSON_DESCRIPTION_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.description = description;
      }
      const rawOrder = state.form.orderDraft.trim();
      if (rawOrder.length > 0) {
        const order = parseCourseLessonOrder(state.form.orderDraft);
        if (order === null) {
          patchForm({ error: COURSE_LESSON_ORDER_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.display_order = order;
      }
      const operation = runWrite({ kind: 'create', body });
      track(operation);
      return operation;
    },
    save: () => {
      if (disposed) return Promise.resolve();
      if (state.form.mode !== 'edit') return Promise.resolve();
      const targetId = state.form.targetId;
      if (!targetId) return Promise.resolve();
      const originalTitle = state.form.originalTitle ?? '';
      const originalDescription = state.form.originalDescription;
      const originalOrder = state.form.originalOrder ?? '';
      const body: { title?: string; description?: string | null; display_order?: number } = {};
      const trimmedTitle = state.form.titleDraft.trim();
      const changedTitle = trimmedTitle !== originalTitle;
      if (changedTitle) {
        const title = parseCourseLessonTitle(state.form.titleDraft);
        if (title === null) {
          patchForm({ error: COURSE_LESSON_TITLE_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.title = title;
      }
      // The description is sent only when the user CHANGED it: an explicit clear
      // sends `null`, a typed value sends the text verbatim (an empty string is a
      // legitimate description, so it is never silently turned into `null`).
      let changedDescription = false;
      if (state.form.clearDescription) {
        if (originalDescription !== null) {
          body.description = null;
          changedDescription = true;
        }
      } else if (state.form.descriptionDraft !== (originalDescription ?? '')) {
        const description = parseCourseLessonDescription(state.form.descriptionDraft);
        if (description === null) {
          patchForm({ error: COURSE_LESSON_DESCRIPTION_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.description = description;
        changedDescription = true;
      }
      const changedOrder = state.form.orderDraft.trim() !== originalOrder;
      if (changedOrder) {
        const order = parseCourseLessonOrder(state.form.orderDraft);
        if (order === null) {
          patchForm({ error: COURSE_LESSON_ORDER_INVALID_MESSAGE });
          return Promise.resolve();
        }
        body.display_order = order;
      }
      if (!changedTitle && !changedDescription && !changedOrder) {
        // Nothing changed: no request is sent at all.
        patchForm({ error: COURSE_LESSON_NO_CHANGES_MESSAGE });
        return Promise.resolve();
      }
      const operation = runWrite({
        kind: 'edit',
        targetId,
        body,
        refreshAfter: changedOrder,
      });
      track(operation);
      return operation;
    },
    setStatus: (lessonId, status) => {
      if (disposed) return Promise.resolve();
      const row = visibleLesson(lessonId);
      if (!row) return Promise.resolve();
      if (row.status === status) return Promise.resolve();
      const operation = runWrite({ kind: 'status', targetId: lessonId, status });
      track(operation);
      return operation;
    },
    toggleSelection: (lessonId) => {
      if (disposed) return;
      // A selection is only ever a row of the CURRENT page.
      if (!visibleLesson(lessonId)) return;
      const selected = state.selectedIds;
      if (selected.includes(lessonId)) {
        patch({ selectedIds: selected.filter((id) => id !== lessonId) });
        return;
      }
      // The client batch bound: the server's 100 is never used to widen it.
      if (selected.length >= COURSE_LESSON_REORDER_LIMIT) return;
      patch({ selectedIds: [...selected, lessonId] });
    },
    clearSelection: () => {
      if (disposed) return;
      if (state.selectedIds.length === 0) return;
      patch({ selectedIds: [] });
    },
    openReorderForm: () => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      const selected = state.selectedIds;
      if (selected.length < 1 || selected.length > COURSE_LESSON_REORDER_LIMIT) {
        // No batch can be formed from this selection: the panel says so and no
        // form (and no request) is opened.
        patchMutation({ error: COURSE_LESSON_SELECTION_INVALID_MESSAGE, notice: null });
        return;
      }
      // The drafts are built from the VISIBLE page order, so the form the user
      // sees is exactly the selection they made.
      const drafts: CourseLessonReorderDraft[] = [];
      for (const row of state.rows) {
        if (!selected.includes(row.id)) continue;
        drafts.push({ id: row.id, title: row.title, orderDraft: String(row.display_order) });
      }
      if (drafts.length !== selected.length) {
        patch({ selectedIds: drafts.map((draft) => draft.id) });
      }
      formGeneration += 1;
      patchForm({
        mode: 'reorder',
        titleDraft: '',
        descriptionDraft: '',
        clearDescription: false,
        orderDraft: '',
        targetId: null,
        targetTitle: null,
        originalTitle: null,
        originalDescription: null,
        originalOrder: null,
        reorderDrafts: drafts,
        error: null,
      });
    },
    updateReorderDraft: (lessonId, value) => {
      if (disposed) return;
      if (state.form.mode !== 'reorder') return;
      const drafts = state.form.reorderDrafts;
      const index = drafts.findIndex((draft) => draft.id === lessonId);
      if (index === -1) return;
      formGeneration += 1;
      const next = drafts.slice();
      next[index] = { ...next[index], orderDraft: value };
      patchForm({ reorderDrafts: next, error: null });
    },
    submitReorder: () => {
      if (disposed) return Promise.resolve();
      if (state.form.mode !== 'reorder') return Promise.resolve();
      const drafts = state.form.reorderDrafts;
      if (drafts.length < 1 || drafts.length > COURSE_LESSON_REORDER_LIMIT) {
        patchForm({ error: COURSE_LESSON_SELECTION_INVALID_MESSAGE });
        return Promise.resolve();
      }
      // EVERY position is validated BEFORE a single byte is sent, and every id
      // must still be a visible row of the bound page.
      const items: { id: string; display_order: number }[] = [];
      const before: Record<string, number> = {};
      const seen = new Set<string>();
      for (const draft of drafts) {
        const row = visibleLesson(draft.id);
        if (!row) {
          patchForm({ error: COURSE_LESSON_SELECTION_INVALID_MESSAGE });
          return Promise.resolve();
        }
        if (seen.has(draft.id)) {
          patchForm({ error: COURSE_LESSON_SELECTION_INVALID_MESSAGE });
          return Promise.resolve();
        }
        seen.add(draft.id);
        const order = parseCourseLessonOrder(draft.orderDraft);
        if (order === null) {
          patchForm({ error: COURSE_LESSON_ORDER_INVALID_MESSAGE });
          return Promise.resolve();
        }
        items.push({ id: draft.id, display_order: order });
        before[draft.id.toLowerCase()] = row.display_order;
      }
      // A batch that changes nothing is not sent at all.
      const changed = items.some((item) => before[item.id.toLowerCase()] !== item.display_order);
      if (!changed) {
        patchForm({ error: COURSE_LESSON_REORDER_NO_CHANGES_MESSAGE });
        return Promise.resolve();
      }
      const operation = runWrite({
        kind: 'reorder',
        items,
        requestedIds: items.map((item) => item.id),
        before,
      });
      track(operation);
      return operation;
    },
    reconcile: () => {
      if (disposed) return Promise.resolve();
      // Deliberate, explicit GET only after an uncertain write. It never retries
      // the write and never claims the write succeeded.
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
