/**
 * M2-B07 — private academic-period planning catalog: parser and controller.
 *
 * This module owns the whole request/draft/decision lifecycle of the period
 * panel. It is INJECTED: it never imports the transport, the session storage or
 * a React runtime, so the same code runs in the dashboard card and in the
 * hermetic tests.
 *
 * What a period IS here: a label plus two DATE-ONLY bounds plus a reversible
 * archive flag. This module deliberately encodes NO product policy beyond that:
 *
 *   * it never attaches an enrollment, a roster, a group, a grade, a course or
 *     a lesson;
 *   * it never defines a student access window, a visibility rule for a student,
 *     a capacity, a price, a fee or a payment;
 *   * it never transitions a period automatically: nothing here reads the clock
 *     to expire, open, close or archive a period, and a period whose `ends_on`
 *     is in the past is simply a period whose `ends_on` is in the past;
 *   * it never rejects a duplicate name or an overlapping range, because no such
 *     policy has been approved — the server accepts both and so does this
 *     controller.
 *
 * The DATE fields are treated as opaque CALENDAR STRINGS (`YYYY-MM-DD`). They
 * are never parsed into a `Date`, never converted to or from UTC, and never
 * given a time: a date-only planning label must not shift by a day because of a
 * browser time zone.
 */
import {
  createCourseOperationGuard,
  createTicketSource,
  type CourseOperationGuard,
} from '../catalog/course-management';

// ---------------------------------------------------------------------------
// Documented wordings
// ---------------------------------------------------------------------------

export const ACADEMIC_PERIOD_MALFORMED_MESSAGE = 'استجابة غير صالحة من الخادم';
export const ACADEMIC_PERIOD_NAME_INVALID_MESSAGE = 'اسم الفترة مطلوب، وحتى 255 حرفًا.';
export const ACADEMIC_PERIOD_DATE_INVALID_MESSAGE = 'التاريخ غير صالح؛ استخدم الصيغة YYYY-MM-DD بتاريخ حقيقي.';
export const ACADEMIC_PERIOD_RANGE_INVALID_MESSAGE = 'تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساويًا له.';
export const ACADEMIC_PERIOD_NO_CHANGES_MESSAGE = 'لا توجد تغييرات لحفظها.';
export const ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE =
  'لم يصل تأكيد الخادم، وقد يكون الحفظ قد تم. المسودة محفوظة هنا؛ راجع الحالة الحالية قبل أي إعادة محاولة.';
export const ACADEMIC_PERIOD_RECONCILED_MESSAGE =
  'هذه قراءة للحالة الحالية فقط؛ لا تؤكد نجاح الحفظ السابق.';
export const ACADEMIC_PERIOD_ARCHIVE_NOTICE =
  'الأرشفة تخفي الفترة من العرض الافتراضي فقط، ويمكن التراجع عنها في أي وقت.';
export const ACADEMIC_PERIOD_PLANNING_NOTICE =
  'فترات تخطيط فقط: لا تسجيل طلاب، ولا صلاحيات وصول، ولا تجديد، ولا دفعات، ولا انتقالات تلقائية بالتواريخ.';
export const ACADEMIC_PERIOD_PAGING_NOTICE =
  'التنقل يعرض صفحة محدودة من الفهرس؛ ولا يمثل لقطة ثابتة له.';

// ---------------------------------------------------------------------------
// Transport classification
// ---------------------------------------------------------------------------

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

/** The period-local billing-only denial (M2-B07 contract). */
const BILLING_ONLY_MESSAGE =
  'Academic period management is not available while the account is limited to billing and support';

/** The owner-only denial for a membership instructor. */
const FORBIDDEN_MESSAGE = 'Forbidden';

/** The period is absent, foreign or archived-out of the requested view. */
const MISSING_PERIOD_MESSAGE = 'Academic period not found';

/** The handler's strict rejections: no connection was taken, nothing written. */
const INVALID_MESSAGES = new Set<string>([
  'Invalid academic period payload',
  'Invalid academic period update payload',
  'Invalid academic period id',
  'Invalid academic period list limit',
  'Invalid academic period list offset',
  'Invalid academic period archive filter',
  'Invalid academic period list query',
]);

/** The handler's 500 wordings. */
const LIST_FAILED_MESSAGE = 'Failed to list academic periods';
const CREATE_FAILED_MESSAGE = 'Failed to create academic period';
const UPDATE_FAILED_MESSAGE = 'Failed to update academic period';

export type AcademicPeriodPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'malformed'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace';

/** Why an outcome was classified. Every value comes from a transported message. */
export type AcademicPeriodFailureReason =
  | 'session'
  | 'suspended'
  | 'billing-only'
  | 'not-owner'
  | 'no-workspace'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface AcademicPeriodFailure {
  readonly phase: AcademicPeriodPhase;
  readonly reason: AcademicPeriodFailureReason;
  readonly message: string;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause ?? '');

/**
 * Classifies ONLY the documented transported messages of a LIST read.
 *
 * A permission outcome is never faked from an unrecognized message: it stays a
 * retryable read error with its actual message on screen.
 */
export function classifyAcademicPeriodFailure(cause: unknown): AcademicPeriodFailure {
  const message = messageOf(cause);
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
  if (message === LIST_FAILED_MESSAGE) {
    return { phase: 'error', reason: 'server', message };
  }
  return { phase: 'error', reason: 'unknown', message: message || 'فشل تحميل فترات الدراسة' };
}

export type AcademicPeriodWriteKind = 'unauthorized' | 'denied' | 'invalid' | 'missing' | 'uncertain';

export interface AcademicPeriodWriteFailure {
  readonly kind: AcademicPeriodWriteKind;
  readonly reason: AcademicPeriodFailureReason;
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
export function classifyAcademicPeriodWriteFailure(cause: unknown): AcademicPeriodWriteFailure {
  const message = messageOf(cause);
  if (SESSION_INVALID_MESSAGES.has(message)) {
    return { kind: 'unauthorized', reason: 'session', message };
  }
  if (message === SUSPENDED_MESSAGE) {
    return { kind: 'denied', reason: 'suspended', message };
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
  if (INVALID_MESSAGES.has(message)) {
    return { kind: 'invalid', reason: 'invalid', message };
  }
  if (message === MISSING_PERIOD_MESSAGE) {
    return { kind: 'missing', reason: 'unknown', message };
  }
  return { kind: 'uncertain', reason: 'unknown', message: message || 'فشل حفظ فترة الدراسة' };
}

/**
 * A DEFINITE loss of the panel's read authorization or of the tenant scope.
 *
 * Only the documented denial answers qualify. A retryable read failure — the
 * handler 500, a network error, an unrecognized message — does NOT prove a
 * permission loss and keeps the private draft.
 */
export function isAcademicPeriodAuthorizationLoss(reason: AcademicPeriodFailureReason): boolean {
  return (
    reason === 'session' ||
    reason === 'suspended' ||
    reason === 'billing-only' ||
    reason === 'not-owner' ||
    reason === 'no-workspace'
  );
}

// ---------------------------------------------------------------------------
// Bounds and parsers
// ---------------------------------------------------------------------------

/** The bounded page size of the catalog: default 25, maximum 100. */
export const ACADEMIC_PERIOD_PAGE_LIMIT = 25;
export const ACADEMIC_PERIOD_PAGE_MAX = 100;
/** The largest offset the server accepts. */
export const ACADEMIC_PERIOD_OFFSET_MAX = 10000;
/** The engineering bound on a period name. */
export const ACADEMIC_PERIOD_NAME_MAX = 255;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The canonical instant the server emits: `Date#toISOString()` of an epoch. */
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A canonical instant must ALSO be a REAL instant.
 *
 * The shape alone would accept `2026-99-99T88:77:66.000Z` or a normalized
 * overflow, and the server never emits them: it emits `Date#toISOString()` of
 * the projected epoch. The value is therefore parsed and must round-trip
 * EXACTLY. There is NO fallback date and no coerced value.
 */
const isCanonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !CANONICAL_ISO_PATTERN.test(value)) return false;
  const instant = new Date(value);
  const time = instant.getTime();
  if (!Number.isFinite(time)) return false;
  return instant.toISOString() === value;
};

/**
 * A date-only value must be a REAL calendar date in the SQL DATE range.
 *
 * `2026-02-30`, `2026-13-01` and `2026-04-31` match the shape but do not exist,
 * and `Date.UTC` silently NORMALIZES them. The value is reconstructed from its
 * three components and must round-trip EXACTLY. The result is the STRING the
 * server stored — this module never produces a `Date` for a date-only field.
 */
export function parseAcademicPeriodDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !DATE_ONLY_PATTERN.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  if (year < 1000 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return raw;
}

/**
 * A period name is a trimmed free label of 1..255 characters.
 *
 * This is the REQUEST-side rule: the name the user typed is trimmed before it
 * is sent. A name that ARRIVES from the server is held to the stricter
 * canonical rule inside `parseAcademicPeriod` and is REFUSED there, never
 * trimmed into a confirmed period.
 */
export function parseAcademicPeriodName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > ACADEMIC_PERIOD_NAME_MAX) return null;
  return name;
}

/** The DTO shape this module understands. */
export interface AcademicPeriod {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface AcademicPeriodPagination {
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface AcademicPeriodListEnvelope {
  periods: AcademicPeriod[];
  pagination: AcademicPeriodPagination;
}

export interface AcademicPeriodEnvelope {
  period: AcademicPeriod;
}

/** The exact seven server-projected fields, sorted for an exact key check. */
const PERIOD_KEYS = [
  'created_at',
  'ends_on',
  'id',
  'is_archived',
  'name',
  'starts_on',
  'updated_at',
];

export type AcademicPeriodParseResult =
  | { readonly ok: true; readonly period: AcademicPeriod }
  | { readonly ok: false };

/**
 * Validates one period DTO against the M2-B07 contract: a non-null object whose
 * key set is EXACTLY the seven projected fields, whose `id` is a UUID, whose
 * `name` is ALREADY canonical — exactly its own trimmed form, 1..255 characters
 * — whose `starts_on`/`ends_on` are REAL calendar dates that do not reverse,
 * whose `is_archived` is an actual boolean, and whose two timestamps are
 * canonical, real instants.
 *
 * Anything else — a non-object, a wrong type, a spread row with an extra key, a
 * name that is not canonical, a malformed date, a non-boolean archive flag — is
 * a malformed response, never a fabricated or normalized period.
 */
export function parseAcademicPeriod(body: unknown): AcademicPeriodParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  const row = body as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return { ok: false };
  const rawName = row.name;
  if (typeof rawName !== 'string') return { ok: false };
  const name = parseAcademicPeriodName(rawName);
  if (name === null) return { ok: false };
  // A TRANSPORTED name must ALREADY be canonical: it has to be exactly its own
  // trimmed form. A name that carries surrounding whitespace is REFUSED — it is
  // never normalized into a confirmed DTO, because the trimmed value would be a
  // name the server never confirmed. The REQUEST side still trims (see
  // `buildAcademicPeriodCreate` / `buildAcademicPeriodPatch`); only a
  // confirmed answer is held to the canonical form.
  if (rawName !== name) return { ok: false };
  const startsOn = parseAcademicPeriodDate(row.starts_on);
  if (startsOn === null) return { ok: false };
  const endsOn = parseAcademicPeriodDate(row.ends_on);
  if (endsOn === null) return { ok: false };
  // A reversed stored range is a malformed response, never a period to display.
  if (startsOn > endsOn) return { ok: false };
  if (typeof row.is_archived !== 'boolean') return { ok: false };
  if (!isCanonicalInstant(row.created_at)) return { ok: false };
  if (!isCanonicalInstant(row.updated_at)) return { ok: false };
  const keys = Object.keys(row).sort();
  if (keys.length !== PERIOD_KEYS.length) return { ok: false };
  for (let index = 0; index < PERIOD_KEYS.length; index += 1) {
    if (keys[index] !== PERIOD_KEYS[index]) return { ok: false };
  }
  return {
    ok: true,
    period: {
      id,
      name,
      starts_on: startsOn,
      ends_on: endsOn,
      is_archived: row.is_archived,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    },
  };
}

export type AcademicPeriodListParseResult =
  | { readonly ok: true; readonly periods: AcademicPeriod[]; readonly pagination: AcademicPeriodPagination }
  | { readonly ok: false };

/**
 * Validates the list envelope: exactly `{ periods, pagination }`, a pagination
 * object with exactly `{ limit, offset, has_more }`, and a row array that never
 * exceeds the page size the server said it applied.
 *
 * The response bound is checked BEFORE any row is copied, so a hostile or broken
 * server can never hand the panel an unbounded page.
 */
export function parseAcademicPeriodList(body: unknown): AcademicPeriodListParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  const envelope = body as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort();
  if (envelopeKeys.length !== 2 || envelopeKeys[0] !== 'pagination' || envelopeKeys[1] !== 'periods') {
    return { ok: false };
  }
  const rawPagination = envelope.pagination;
  if (typeof rawPagination !== 'object' || rawPagination === null || Array.isArray(rawPagination)) {
    return { ok: false };
  }
  const pagination = rawPagination as Record<string, unknown>;
  const paginationKeys = Object.keys(pagination).sort();
  if (paginationKeys.length !== 3 || paginationKeys[0] !== 'has_more' || paginationKeys[1] !== 'limit' || paginationKeys[2] !== 'offset') {
    return { ok: false };
  }
  const limit = pagination.limit;
  const offset = pagination.offset;
  const hasMore = pagination.has_more;
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return { ok: false };
  if (limit < 1 || limit > ACADEMIC_PERIOD_PAGE_MAX) return { ok: false };
  if (typeof offset !== 'number' || !Number.isInteger(offset)) return { ok: false };
  if (offset < 0 || offset > ACADEMIC_PERIOD_OFFSET_MAX) return { ok: false };
  if (typeof hasMore !== 'boolean') return { ok: false };
  const rawPeriods = envelope.periods;
  if (!Array.isArray(rawPeriods)) return { ok: false };
  // The bound is checked on the RESPONSE, before any row is copied.
  if (rawPeriods.length > limit) return { ok: false };
  const periods: AcademicPeriod[] = [];
  for (const row of rawPeriods) {
    const parsed = parseAcademicPeriod(row);
    if (!parsed.ok) return { ok: false };
    periods.push(parsed.period);
  }
  return { ok: true, periods, pagination: { limit, offset, has_more: hasMore } };
}

export type AcademicPeriodEnvelopeParseResult =
  | { readonly ok: true; readonly period: AcademicPeriod }
  | { readonly ok: false };

/** Validates the single-period envelope: exactly `{ period }`. */
export function parseAcademicPeriodEnvelope(body: unknown): AcademicPeriodEnvelopeParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (keys.length !== 1 || keys[0] !== 'period') return { ok: false };
  return parseAcademicPeriod(envelope.period);
}

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

export type AcademicPeriodFormMode = 'closed' | 'create' | 'edit';

export interface AcademicPeriodFormState {
  mode: AcademicPeriodFormMode;
  /** The user's name draft, preserved verbatim on every failed write. */
  nameDraft: string;
  /** The user's start-date draft, exactly as typed. */
  startsOnDraft: string;
  /** The user's end-date draft, exactly as typed. */
  endsOnDraft: string;
  /** The period the edit form is bound to. */
  targetId: string | null;
  /** The server-confirmed values the edit form was opened with. */
  originalName: string | null;
  originalStartsOn: string | null;
  originalEndsOn: string | null;
  error: string | null;
  notice: string | null;
}

export type AcademicPeriodPatch =
  | { readonly ok: true; readonly patch: { name?: string; starts_on?: string; ends_on?: string }; readonly dirtyCount: number }
  | { readonly ok: false; readonly message: string };

/**
 * Builds the DIRTY SUBSET of an edit form.
 *
 * Only the fields whose EFFECTIVE value differs from the server-confirmed value
 * the form was opened with are sent, so a partial save can never overwrite a
 * field the user did not touch. A whitespace-only difference in the name is NOT
 * a change (the server trims), and a date that differs only in formatting is
 * rejected rather than silently normalized.
 *
 * The DATE RANGE is validated on the MERGED result, exactly like the server:
 * changing only one bound is checked against the other bound as it stands.
 *
 * A form with no real change is reported as such — the caller must then send NO
 * request at all.
 */
export function buildAcademicPeriodPatch(form: AcademicPeriodFormState): AcademicPeriodPatch {
  if (form.mode !== 'edit') return { ok: false, message: ACADEMIC_PERIOD_NAME_INVALID_MESSAGE };

  const name = parseAcademicPeriodName(form.nameDraft);
  if (name === null) return { ok: false, message: ACADEMIC_PERIOD_NAME_INVALID_MESSAGE };
  const startsOn = parseAcademicPeriodDate(form.startsOnDraft.trim());
  if (startsOn === null) return { ok: false, message: ACADEMIC_PERIOD_DATE_INVALID_MESSAGE };
  const endsOn = parseAcademicPeriodDate(form.endsOnDraft.trim());
  if (endsOn === null) return { ok: false, message: ACADEMIC_PERIOD_DATE_INVALID_MESSAGE };
  if (startsOn > endsOn) return { ok: false, message: ACADEMIC_PERIOD_RANGE_INVALID_MESSAGE };

  const patch: { name?: string; starts_on?: string; ends_on?: string } = {};
  let dirtyCount = 0;
  if (name !== form.originalName) {
    patch.name = name;
    dirtyCount += 1;
  }
  if (startsOn !== form.originalStartsOn) {
    patch.starts_on = startsOn;
    dirtyCount += 1;
  }
  if (endsOn !== form.originalEndsOn) {
    patch.ends_on = endsOn;
    dirtyCount += 1;
  }
  return { ok: true, patch, dirtyCount };
}

export type AcademicPeriodCreateResult =
  | { readonly ok: true; readonly input: { name: string; starts_on: string; ends_on: string } }
  | { readonly ok: false; readonly message: string };

/** Builds the strict create payload: all three fields, already validated. */
export function buildAcademicPeriodCreate(form: AcademicPeriodFormState): AcademicPeriodCreateResult {
  const name = parseAcademicPeriodName(form.nameDraft);
  if (name === null) return { ok: false, message: ACADEMIC_PERIOD_NAME_INVALID_MESSAGE };
  const startsOn = parseAcademicPeriodDate(form.startsOnDraft.trim());
  if (startsOn === null) return { ok: false, message: ACADEMIC_PERIOD_DATE_INVALID_MESSAGE };
  const endsOn = parseAcademicPeriodDate(form.endsOnDraft.trim());
  if (endsOn === null) return { ok: false, message: ACADEMIC_PERIOD_DATE_INVALID_MESSAGE };
  if (startsOn > endsOn) return { ok: false, message: ACADEMIC_PERIOD_RANGE_INVALID_MESSAGE };
  return { ok: true, input: { name, starts_on: startsOn, ends_on: endsOn } };
}

// ---------------------------------------------------------------------------
// State and controller
// ---------------------------------------------------------------------------

export type AcademicPeriodMutationKind = 'create' | 'edit' | 'archive';
export type AcademicPeriodMutationStatus = 'idle' | 'saving' | 'uncertain';

export interface AcademicPeriodMutationState {
  status: AcademicPeriodMutationStatus;
  kind: AcademicPeriodMutationKind | null;
  /** The period the mutation targets (null for a create). */
  targetId: string | null;
  error: string | null;
  /** A warning after an uncertain write or a reconciliation read. Never success. */
  notice: string | null;
}

export interface AcademicPeriodPagingState {
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AcademicPeriodState {
  /** The panel was explicitly opened by the user. No request happens before. */
  open: boolean;
  phase: AcademicPeriodPhase;
  /** The bounded current page only (at most `pagination.limit` rows). */
  rows: AcademicPeriod[];
  pagination: AcademicPeriodPagingState;
  /** The archived view is a FILTER of the same bounded list. */
  archivedView: boolean;
  /** True when the current page is not the first page. */
  hasPreviousPage: boolean;
  error: string | null;
  reason: AcademicPeriodFailureReason | null;
  /**
   * A failed follow-up read AFTER a confirmed write. It never turns the
   * confirmed save into a failed save.
   */
  refreshError: string | null;
  /** The server-confirmed result of the last confirmed write. */
  lastConfirmed: AcademicPeriod | null;
  form: AcademicPeriodFormState;
  mutation: AcademicPeriodMutationState;
}

const closedForm = (): AcademicPeriodFormState => ({
  mode: 'closed',
  nameDraft: '',
  startsOnDraft: '',
  endsOnDraft: '',
  targetId: null,
  originalName: null,
  originalStartsOn: null,
  originalEndsOn: null,
  error: null,
  notice: null,
});

const idleMutation = (): AcademicPeriodMutationState => ({
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
});

const initialState: AcademicPeriodState = {
  open: false,
  phase: 'idle',
  rows: [],
  pagination: { limit: ACADEMIC_PERIOD_PAGE_LIMIT, offset: 0, hasMore: false },
  archivedView: false,
  hasPreviousPage: false,
  error: null,
  reason: null,
  refreshError: null,
  lastConfirmed: null,
  form: closedForm(),
  mutation: idleMutation(),
};

export interface AcademicPeriodApi {
  listPeriods: (params: { limit: number; offset: number; archived: boolean }) => Promise<AcademicPeriodListEnvelope>;
  /** Owner-only create through the canonical transport. */
  createPeriod?: (input: { name: string; starts_on: string; ends_on: string }) => Promise<AcademicPeriodEnvelope>;
  /** Owner-only update, including the reversible archive flag. */
  updatePeriod?: (
    id: string,
    update: { name?: string; starts_on?: string; ends_on?: string; is_archived?: boolean },
  ) => Promise<AcademicPeriodEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

type ReadMode = 'open' | 'refresh' | 'page' | 'view' | 'post-write' | 'reconcile';

export interface AcademicPeriodController {
  getState(): AcademicPeriodState;
  subscribe(listener: (state: AcademicPeriodState) => void): () => void;
  /** Explicit panel open: exactly ONE bounded page read, never before. */
  open(): Promise<void>;
  /** Closes the panel: the private rows and drafts are cleared. */
  close(): void;
  /** A deliberate read of the CURRENT page (never a write). */
  refresh(): Promise<void>;
  /** The next bounded page, when the server says there is one. */
  nextPage(): Promise<void>;
  /** The previous bounded page. */
  previousPage(): Promise<void>;
  /** Switches between the default and the archived view (one bounded read). */
  setArchivedView(archived: boolean): Promise<void>;
  /** Opens the create form (no request). */
  openCreateForm(): void;
  /** Opens the edit form for a row of the current page (no request). */
  openEditForm(periodId: string): void;
  /** Updates a draft without issuing a request. */
  updateNameDraft(value: string): void;
  updateStartsOnDraft(value: string): void;
  updateEndsOnDraft(value: string): void;
  /** Closes the form; a late reply can never reopen or mutate it. */
  cancelForm(): void;
  /** Explicit single-flight create. */
  create(): Promise<void>;
  /** Explicit single-flight save of the dirty subset. */
  save(): Promise<void>;
  /** Explicit single-flight reversible archive / restore of one period. */
  setArchived(periodId: string, archived: boolean): Promise<void>;
  /** Explicit read of the current state after an uncertain write. */
  reconcile(): Promise<void>;
  /** Discards everything in flight and clears the private state. */
  dispose(): void;
}

export function createAcademicPeriodController(api: AcademicPeriodApi): AcademicPeriodController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: AcademicPeriodState) => void>();
  const tickets = createTicketSource();
  /** One list read at a time. */
  const readGuard: CourseOperationGuard = createCourseOperationGuard(tickets);
  /** One mutation at a time. */
  const writeGuard: CourseOperationGuard = createCourseOperationGuard(tickets);
  let pageGeneration = 0;
  let formGeneration = 0;
  let mutationOwner = 0;
  let confirmedWriteEpoch = 0;
  let phaseOwner = 0;
  let currentOffset = 0;

  const patch = (changes: Partial<AcademicPeriodState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<AcademicPeriodFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<AcademicPeriodMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** Clears every private trace of the panel (rows and drafts). */
  const clearPrivateState = (): Partial<AcademicPeriodState> => ({
    phase: 'idle',
    rows: [],
    pagination: { limit: state.pagination.limit, offset: 0, hasMore: false },
    hasPreviousPage: false,
    error: null,
    reason: null,
    refreshError: null,
    lastConfirmed: null,
    form: closedForm(),
    mutation: idleMutation(),
  });

  /** Discards everything in flight and the latches they hold. */
  const retireInFlight = (): void => {
    pageGeneration += 1;
    formGeneration += 1;
    mutationOwner = 0;
    readGuard.release();
    writeGuard.release();
  };

  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    retireInFlight();
    currentOffset = 0;
    patch(clearPrivateState());
    return true;
  };

  /**
   * Adopts a principal change on behalf of a RETIRED operation. The latches are
   * deliberately NOT released here — every operation releases its own ticket in
   * its `finally`.
   */
  const adoptRetiredPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    pageGeneration += 1;
    formGeneration += 1;
    currentOffset = 0;
    patch(clearPrivateState());
    return true;
  };

  const settleReadPhase = (phaseToken: number): void => {
    if (phaseOwner !== phaseToken) return;
    if (state.phase !== 'loading') return;
    patch({ phase: state.rows.length > 0 ? 'ready' : 'idle', error: null, reason: null });
  };

  /** Applies a server-confirmed period to the held page (if it is on it). */
  const applyConfirmedPeriod = (period: AcademicPeriod): void => {
    const index = state.rows.findIndex((row) => row.id === period.id);
    if (index === -1) {
      patch({ lastConfirmed: period });
      return;
    }
    const rows = state.rows.slice();
    rows[index] = period;
    patch({ rows, lastConfirmed: period });
  };

  const reconcileNoticeIfCurrent = (): void => {
    if (state.mutation.status !== 'uncertain') return;
    patchMutation({ notice: ACADEMIC_PERIOD_RECONCILED_MESSAGE });
  };

  const runRead = async (offset: number, mode: ReadMode): Promise<void> => {
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
      const body = await api.listPeriods({
        limit: ACADEMIC_PERIOD_PAGE_LIMIT,
        offset,
        archived: state.archivedView,
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
      const parsed = parseAcademicPeriodList(body);
      if (!parsed.ok) {
        if (mode === 'post-write') {
          patch({ refreshError: ACADEMIC_PERIOD_MALFORMED_MESSAGE });
          settleReadPhase(phaseToken);
          return;
        }
        patch({
          phase: 'malformed',
          rows: [],
          pagination: { limit: ACADEMIC_PERIOD_PAGE_LIMIT, offset: 0, hasMore: false },
          hasPreviousPage: false,
          error: ACADEMIC_PERIOD_MALFORMED_MESSAGE,
          reason: 'unknown',
          refreshError: null,
        });
        return;
      }
      currentOffset = offset;
      patch({
        phase: parsed.periods.length === 0 ? 'empty' : 'ready',
        rows: parsed.periods,
        pagination: {
          limit: parsed.pagination.limit,
          offset: parsed.pagination.offset,
          hasMore: parsed.pagination.has_more,
        },
        hasPreviousPage: offset > 0,
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
      const failure = classifyAcademicPeriodFailure(cause);
      if (isAcademicPeriodAuthorizationLoss(failure.reason)) {
        retireInFlight();
        currentOffset = 0;
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
        pagination: { limit: ACADEMIC_PERIOD_PAGE_LIMIT, offset: 0, hasMore: false },
        hasPreviousPage: false,
        error: failure.message,
        reason: failure.reason,
        refreshError: null,
      });
    } finally {
      readGuard.release(ticket);
    }
  };

  /**
   * Runs ONE mutation with an OWN visible-mutation ticket.
   *
   * The ticket is what makes a stale reply harmless: if a session change, a
   * close or a disposal retired this operation while it was on the wire, the
   * reply can no longer change the visible save state, the error, the notice,
   * the latch or the form — and its `finally` cannot release a NEWER latch,
   * because the guard releases only when the token still owns it.
   */
  const runWrite = async (
    kind: AcademicPeriodMutationKind,
    targetId: string | null,
    send: () => Promise<AcademicPeriodEnvelope>,
  ): Promise<void> => {
    if (disposed) return;
    if (!state.open) return;
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (!writeGuard.acquire()) return;
    const token = writeGuard.holder();
    const formToken = formGeneration;
    const principal = entryPrincipal;
    mutationOwner = token;
    patchMutation({ status: 'saving', kind, targetId, error: null, notice: null });
    patchForm({ error: null, notice: null });
    try {
      const body = await send();
      if (disposed) return;
      if (mutationOwner !== token) {
        // A lifecycle event retired this operation and already cleared the
        // visible state: the reply must not resurrect it.
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const parsed = parseAcademicPeriodEnvelope(body);
      if (!parsed.ok) {
        // A malformed 2xx after a write is an UNKNOWN outcome, never a success:
        // the server may have committed a row the client cannot describe.
        confirmedWriteEpoch += 1;
        mutationOwner = 0;
        patchMutation({
          status: 'uncertain',
          error: ACADEMIC_PERIOD_MALFORMED_MESSAGE,
          notice: ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // A confirmed write: the page this client holds is now stale.
      confirmedWriteEpoch += 1;
      mutationOwner = 0;
      // Only the form that BELONGED to this write is closed.
      if (formGeneration === formToken) {
        formGeneration += 1;
        patch({ form: closedForm() });
      }
      applyConfirmedPeriod(parsed.period);
      patchMutation({
        status: 'idle',
        kind: null,
        targetId: null,
        error: null,
        notice: kind === 'archive' ? ACADEMIC_PERIOD_ARCHIVE_NOTICE : null,
      });
      // ONE bounded follow-up read of the current page, so the panel shows the
      // server's order and the archive filter as they now are.
      void runRead(currentOffset, 'post-write');
    } catch (cause) {
      if (disposed) return;
      if (mutationOwner !== token) {
        const observed = readPrincipal();
        if (observed !== principal) adoptRetiredPrincipalChange(observed);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyAcademicPeriodWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        currentOffset = 0;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'denied') {
        // A definite denial: the private rows and drafts must not stay visible.
        retireInFlight();
        currentOffset = 0;
        patch({
          ...clearPrivateState(),
          phase: failure.reason === 'no-workspace' ? 'no-workspace' : 'denied',
          error: failure.message,
          reason: failure.reason,
        });
        return;
      }
      if (failure.kind === 'invalid' || failure.kind === 'missing') {
        // A DEFINITE rejection: nothing was written. The draft is preserved so
        // the user can correct it, and nothing is retried automatically.
        mutationOwner = 0;
        patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
        return;
      }
      // `uncertain`: the handler 500, a network failure or an unrecognized
      // message. The write MAY have persisted, so the draft is preserved, the
      // outcome is stated as unknown and nothing is retried.
      mutationOwner = 0;
      patchMutation({
        status: 'uncertain',
        error: null,
        notice: ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE,
      });
    } finally {
      writeGuard.release(token);
    }
  };

  let unsubscribeSession: (() => void) | null = null;

  const controller: AcademicPeriodController = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    async open() {
      if (disposed) return;
      if (state.open) return;
      const entryPrincipal = readPrincipal();
      observedPrincipal = entryPrincipal;
      currentOffset = 0;
      patch({ open: true, ...clearPrivateState() });
      await runRead(0, 'open');
    },

    close() {
      if (disposed) return;
      // Closing clears the private rows and drafts immediately; any reply still
      // on the wire is retired and can no longer commit.
      retireInFlight();
      currentOffset = 0;
      patch({ open: false, ...clearPrivateState() });
    },

    async refresh() {
      await runRead(currentOffset, 'refresh');
    },

    async nextPage() {
      if (!state.open) return;
      if (!state.pagination.hasMore) return;
      const next = currentOffset + ACADEMIC_PERIOD_PAGE_LIMIT;
      if (next > ACADEMIC_PERIOD_OFFSET_MAX) return;
      await runRead(next, 'page');
    },

    async previousPage() {
      if (!state.open) return;
      if (currentOffset === 0) return;
      const previous = Math.max(0, currentOffset - ACADEMIC_PERIOD_PAGE_LIMIT);
      await runRead(previous, 'page');
    },

    async setArchivedView(archived) {
      if (disposed) return;
      if (state.archivedView === archived) return;
      patch({ archivedView: archived });
      currentOffset = 0;
      // Switching the view is ONE bounded read of the first page of that view.
      // When the panel is closed nothing is requested.
      if (!state.open) return;
      await runRead(0, 'view');
    },

    openCreateForm() {
      if (disposed) return;
      if (state.mutation.status === 'saving') return;
      formGeneration += 1;
      patch({
        form: {
          mode: 'create',
          nameDraft: '',
          startsOnDraft: '',
          endsOnDraft: '',
          targetId: null,
          originalName: null,
          originalStartsOn: null,
          originalEndsOn: null,
          error: null,
          notice: null,
        },
      });
    },

    openEditForm(periodId) {
      if (disposed) return;
      if (state.mutation.status === 'saving') return;
      const row = state.rows.find((candidate) => candidate.id === periodId);
      if (!row) return;
      formGeneration += 1;
      patch({
        form: {
          mode: 'edit',
          nameDraft: row.name,
          startsOnDraft: row.starts_on,
          endsOnDraft: row.ends_on,
          targetId: row.id,
          originalName: row.name,
          originalStartsOn: row.starts_on,
          originalEndsOn: row.ends_on,
          error: null,
          notice: null,
        },
      });
    },

    updateNameDraft(value) {
      if (disposed) return;
      patchForm({ nameDraft: value, error: null });
    },

    updateStartsOnDraft(value) {
      if (disposed) return;
      patchForm({ startsOnDraft: value, error: null });
    },

    updateEndsOnDraft(value) {
      if (disposed) return;
      patchForm({ endsOnDraft: value, error: null });
    },

    cancelForm() {
      if (disposed) return;
      formGeneration += 1;
      patch({ form: closedForm() });
    },

    async create() {
      if (state.form.mode !== 'create') return;
      const built = buildAcademicPeriodCreate(state.form);
      // `'message' in built` is the narrowing that works under this project's
      // `strict: false`, where `ok: true | false` widens to `boolean`.
      if ('message' in built) {
        // Local validation happens BEFORE any request and keeps the input.
        patchForm({ error: built.message, notice: null });
        return;
      }
      if (!api.createPeriod) {
        patchForm({ error: ACADEMIC_PERIOD_MALFORMED_MESSAGE, notice: null });
        return;
      }
      await runWrite('create', null, () => api.createPeriod!(built.input));
    },

    async save() {
      if (state.form.mode !== 'edit') return;
      const built = buildAcademicPeriodPatch(state.form);
      if ('message' in built) {
        patchForm({ error: built.message, notice: null });
        return;
      }
      if (built.dirtyCount === 0) {
        // No real change: NO request is issued at all.
        patchForm({ error: null, notice: ACADEMIC_PERIOD_NO_CHANGES_MESSAGE });
        return;
      }
      const targetId = state.form.targetId;
      if (!targetId || !api.updatePeriod) {
        patchForm({ error: ACADEMIC_PERIOD_MALFORMED_MESSAGE, notice: null });
        return;
      }
      await runWrite('edit', targetId, () => api.updatePeriod!(targetId, built.patch));
    },

    async setArchived(periodId, archived) {
      const row = state.rows.find((candidate) => candidate.id === periodId);
      // Archiving an already-archived period is a no-op: NO request.
      if (!row || row.is_archived === archived) return;
      if (!api.updatePeriod) return;
      await runWrite('archive', periodId, () => api.updatePeriod!(periodId, { is_archived: archived }));
    },

    async reconcile() {
      await runRead(currentOffset, 'reconcile');
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      retireInFlight();
      listeners.clear();
      if (unsubscribeSession) unsubscribeSession();
      unsubscribeSession = null;
      state = initialState;
    },
  };

  // A session change (logout, revocation, workspace swap) clears the private
  // rows and drafts immediately. An OPEN panel stays open so the reason is
  // visible instead of silently collapsing into the closed state.
  if (api.subscribeSession) {
    unsubscribeSession = api.subscribeSession(() => {
      if (disposed) return;
      const observed = readPrincipal();
      if (observed === observedPrincipal) return;
      observedPrincipal = observed;
      retireInFlight();
      currentOffset = 0;
      const wasOpen = state.open;
      patch({
        ...clearPrivateState(),
        ...(wasOpen ? { phase: 'unauthorized' as const, reason: 'session' as const } : {}),
      });
    });
  }

  return controller;
}
