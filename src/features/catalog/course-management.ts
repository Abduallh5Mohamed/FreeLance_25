/**
 * M2-02 course management seam — the smallest production module
 * `src/pages/Courses.tsx` delegates to.
 *
 * It exists to separate the testable orchestration (single-flight writes,
 * stale-reply / session / dispose invalidation, form + delete-target
 * retention on failure, grade name↔id mapping, numeric parsing) from React
 * rendering. No generic framework: transport, the session notifier and the
 * principal reader are injected, so the exact production code the page runs
 * is exercised hermetically in node:test (src/tests/m2-course-management.test.ts)
 * with no DB, network, browser or live app.
 *
 * Contracts (verified from source, documented in
 * docs/streams/client/M2-02-CONTRACTS.md):
 *  - the server is the source of truth: `createCourse` resolves with the new
 *    id, `updateCourse`/`deleteCourse` resolve void; every failure throws the
 *    server's `error` string WITHOUT the status code (api-http.ts:69-89), so
 *    only the documented message may classify a failure (no invented status);
 *  - exactly one write per operation: a synchronous latch is acquired before
 *    the first await, so a duplicate fired before the re-render never reaches
 *    the transport;
 *  - a superseded / reversed / post-dispose reply never commits: every
 *    operation carries a monotonic generation captured from one sequence, and
 *    a session change, a dispose or a newer load invalidates everything in
 *    flight;
 *  - distinct loading / empty / error list states, and a refresh failure is
 *    reported SEPARATELY from a server-confirmed write, so a failed refresh
 *    can never invite a duplicate creation;
 *  - the form and the delete target are retained on failure — the old
 *    `finally` that cleared them is gone;
 *  - `grade` is stored as a NAME, not an id (api-http.ts:627-635), so the id
 *    held by the form is mapped back to the name, and an unavailable legacy
 *    grade is preserved instead of being silently nulled;
 *  - numeric input is parsed strictly: malformed / NaN / Infinity / partial
 *    reads are refused instead of being coerced to 0.
 *
 * M2-22 adds exactly ONE capability to this seam: the explicit publish /
 * unpublish action for the anonymous public catalogue
 * (`docs/streams/server/M2-B14-CONTRACT.md`). It is a DISCOVERY flag only — it
 * never enrolls, grants access, delivers a lesson or a file, notifies anyone or
 * takes payment. It reuses the SAME single write latch, the SAME generation and
 * the SAME principal boundary as the existing writes, keeps the server response
 * authoritative (a record for another course, or one reporting a different
 * state, is never a success), sends NOTHING when the requested state is already
 * the confirmed one, and reports `unavailable` rather than inventing a state
 * when the deployment does not wire the route. Every pre-existing behaviour —
 * the list, the options, the create/edit form, the archive dialog and their
 * fences — is untouched.
 *
 * Out of scope by construction: no shared helper/auth/router/backend/package/
 * schema edit, no new pricing or billing policy, no local role authority.
 */
import type { Course, Grade, Subscription } from '../../lib/api';
import {
  COURSE_PUBLICATION_MALFORMED_MESSAGE,
  parseCoursePublication,
  type CoursePublication,
  type CoursePublicationState,
} from '../../lib/api-http';

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** The only server-fixed strings these routes send (server/src/routes/courses.ts).
 *  The shared client throws the message alone, so these are the honest
 *  classification signals — a numeric HTTP status is never inferred. */
export const COURSE_NOT_FOUND_MESSAGE = 'Course not found';
export const COURSE_NOT_IN_WORKSPACE_MESSAGE = 'Course not found in your workspace';
export const COURSE_TENANT_REQUIRED_MESSAGE = 'An active tenant membership is required';

export type CourseFailureKind = 'unavailable' | 'denied' | 'error';

export interface CourseFailure {
  readonly kind: CourseFailureKind;
  readonly message: string;
}

export function classifyCourseFailure(cause: unknown): CourseFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? 'حدث خطأ غير معروف');
  if (message === COURSE_NOT_FOUND_MESSAGE || message === COURSE_NOT_IN_WORKSPACE_MESSAGE) {
    return { kind: 'unavailable', message };
  }
  if (message === COURSE_TENANT_REQUIRED_MESSAGE) {
    return { kind: 'denied', message };
  }
  return { kind: 'error', message };
}

// ---------------------------------------------------------------------------
// M2-22 — course publication (an explicit DISCOVERY flag only)
// ---------------------------------------------------------------------------

/**
 * Publication is a discovery flag, never an entitlement.
 *
 * Publishing a course makes it appear in the anonymous public catalogue for as
 * long as it is ALSO active. It does not enroll anyone, grant access to a
 * lesson or a file, create a role or a session, notify a recipient or take a
 * payment — this module never does any of those things either.
 *
 * The server's response is authoritative: the returned record — not the
 * requested intent — is what the map below holds and what the screen renders.
 */
export type { CoursePublication, CoursePublicationState };

/**
 * The documented 403 wordings the publication route can answer with
 * (`requireTeachingWrite` and the in-transaction authority revalidation).
 *
 * These are DEFINITE denials: nothing was written, so the action is `failed`
 * and no state is claimed. `classifyCourseFailure` is deliberately left
 * untouched — this set only sharpens the publication path, so no pre-existing
 * M2-02 behaviour changes.
 */
const PUBLICATION_DENIED_MESSAGES: ReadonlySet<string> = new Set([
  'Forbidden',
  'Teaching access is not active for the selected tenant',
]);

/** A 2xx publication body that does not match the fixed projection. */
export const COURSE_PUBLICATION_UNEXPECTED_MESSAGE = COURSE_PUBLICATION_MALFORMED_MESSAGE;

/** Warning after a publication reply that may or may not have persisted. */
export const COURSE_PUBLICATION_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حالة النشر. قد تكون التغييرات قد حُفظت على الخادم؛ أعد تحميل القائمة للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after a confirmed publication. */
export const COURSE_PUBLISHED_MESSAGE = 'تم نشر الكورس في صفحة الاستكشاف العامة.';
/** Local wording after a confirmed withdrawal. */
export const COURSE_UNPUBLISHED_MESSAGE = 'تم إلغاء نشر الكورس.';
/** Local wording when the requested state is already the confirmed one. */
export const COURSE_PUBLICATION_UNCHANGED_MESSAGE = 'حالة النشر مطابقة بالفعل، لذلك لم يُرسل أي طلب.';

/**
 * Reads the publication state a PRIVATE list row carries, if any.
 *
 * `GET /courses` selects the row as-is, so `publication_state` is present only
 * once the M2-22 migration has been applied. An absent or unrecognised value is
 * `null` — "not known" — never a guessed `draft`, because the screen must not
 * claim a state the server did not report.
 */
export function readCoursePublicationState(row: unknown): CoursePublicationState | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as { publication_state?: unknown }).publication_state;
  if (value === 'draft' || value === 'published') return value;
  return null;
}

// ---------------------------------------------------------------------------
// Session principal (canonical boundary, no secret ever stored)
// ---------------------------------------------------------------------------

/** Everything the page can read from the canonical session storage. */
export interface CoursePrincipalInput {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly billingOnly?: unknown;
  /** Workspace/tenant selection, when the page has one. */
  readonly scope?: unknown;
  /** The canonical `authToken` string. It is handed to this module ONLY so the
   *  exact comparison below can be made: it is never returned, rendered,
   *  logged, stored in React state or sent anywhere. */
  readonly token?: string | null;
}

/**
 * EXACT canonical session comparison.
 *
 * History (supervisor/064 → 065):
 *  - 064 replaced a 32-bit djb2 digest (which collided for distinct tokens)
 *    with EXACT equality of the whole canonical session. But it kept a
 *    module-wide REGISTRY that mapped each historical identity back to the
 *    SAME incarnation id. So an observed A → B → A (without a session-bus
 *    notification) restored the original A incarnation, and a write started
 *    under the first A accepted completion after the controller silently
 *    observed B then returned to A.
 *  - 065 requires: ANY observed canonical identity transition (including a
 *    silent return to a previously seen token, and including logout/null)
 *    advances the incarnation. A write started under the first A must be
 *    BLOCKED when the operation observes B then returns to A.
 *
 * What the boundary is now:
 *  - the WHOLE canonical session (id, role, billing flag, scope and the
 *    canonical token) is canonicalised and compared by EXACT equality;
 *  - `buildCoursePrincipal` (test-only builder) maps each DISTINCT canonical
 *    identity to a STABLE incarnation id via a registry: two calls with the
 *    SAME canonical input always produce the SAME key. Different identities
 *    get different keys. This is the "consecutive unchanged reads stable"
 *    part — tests that set `state.principal` directly need stability across
 *    two builds of the same session.
 *  - `readCourseSessionPrincipal` (the REAL production reader) does NOT use
 *    the registry. It holds ONLY the latest canonical value and a monotonic
 *    generation in a module-level lifetime. Consecutive reads of an unchanged
 *    session are stable; ANY observed change (even a return to a previously
 *    seen token) yields a NEW incarnation, so an in-flight write from the
 *    older one can no longer commit under it;
 *  - the token itself never leaves the closure — a retained private comparison
 *    value is not a publication.
 */
const canonicalPart = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text === '' ? null : text;
};

/** The exact canonical session, or `null` when there is no session at all.
 *  PRIVATE on purpose: it holds the token, so it must never be returned. */
const canonicalSessionIdentity = (input: CoursePrincipalInput): string | null => {
  const parts = [
    canonicalPart(input.id),
    canonicalPart(input.role),
    canonicalPart(input.billingOnly),
    canonicalPart(input.scope),
    canonicalPart(input.token),
  ];
  if (parts.every((part) => part === null)) return null;
  // JSON keeps the encoding unambiguous: no separator can be forged by a
  // value that contains it, so two different sessions cannot collide here.
  return JSON.stringify(parts);
};

/** The page's storage surface, injected so the real reader is testable with
 *  no DOM, no browser and no live app. */
export interface CourseSessionStorage {
  getItem(key: string): string | null;
}

/** Reads the canonical session identity from the page's real storage. PRIVATE
 *  on purpose (holds the token). */
const readCanonicalFromStorage = (storage: CourseSessionStorage): string | null => {
  let user: { id?: unknown; role?: unknown; billing_only?: unknown } | null = null;
  let token: string | null = null;
  try {
    const raw = storage.getItem('currentUser');
    user = raw ? (JSON.parse(raw) as { id?: unknown; role?: unknown; billing_only?: unknown }) : null;
  } catch {
    // An unreadable profile behaves like no profile; the token below still
    // scopes the session, and the value stays deterministic for comparison.
    user = null;
  }
  try {
    token = storage.getItem('authToken');
  } catch {
    token = null;
  }
  return canonicalSessionIdentity({
    id: user?.id,
    role: user?.role,
    billingOnly: user?.billing_only,
    token,
  });
};

/** Module-level session lifetime state. There is exactly ONE canonical session
 *  storage in production (`localStorage`), so a single lifetime is correct for
 *  the real page. The lifetime holds ONLY the latest canonical value and a
 *  monotonic generation — no historical registry, no cache of old identities.
 *  This means returning to a previously seen token after observing a different
 *  one is a NEW incarnation (065), and consecutive unchanged reads are stable.
 *
 *  Tests that need an isolated lifetime per controller create their own
 *  reader closure; the controller's `api.readPrincipal` is the single point
 *  of indirection. */
let sessionLifetime: { lastCanonical: string | null; generation: number } = {
  lastCanonical: null,
  generation: 0,
};

/** Resets the session lifetime to its initial state. Test-only: each test
 *  that injects the real reader into a fresh controller starts from a clean
 *  lifetime so prior tests do not bleed incarnations. */
export function resetCourseSessionLifetime(): void {
  sessionLifetime = { lastCanonical: null, generation: 0 };
}

/**
 * The ACTUAL production principal reader `src/pages/Courses.tsx` uses:
 * `currentUser` (id / role / billing_only) plus the canonical `authToken`.
 * Both are read fresh on every call, so a rotation, a logout or a silent
 * re-login of the same account is seen at claim time AND at commit time.
 *
 * ANY observed canonical identity transition advances the incarnation —
 * including a silent return to a previously seen token and including
 * logout/null. Consecutive unchanged reads are stable. This is the 065
 * contract: an operation that began under one incarnation is blocked from
 * committing after the reader observes a different canonical session, even
 * if the session later returns to the exact same bytes.
 */
export function readCourseSessionPrincipal(storage: CourseSessionStorage): string | null {
  const canonical = readCanonicalFromStorage(storage);
  if (canonical === null) {
    // No session. If we had one, this is an observed transition (logout).
    if (sessionLifetime.lastCanonical !== null) {
      sessionLifetime.generation += 1;
      sessionLifetime.lastCanonical = null;
    }
    return null;
  }
  if (canonical !== sessionLifetime.lastCanonical) {
    // ANY change — including a return to a previously seen token — is a new
    // incarnation. We do NOT remember old identities, so A → B → A gives
    // three distinct incarnations, not two.
    sessionLifetime.generation += 1;
    sessionLifetime.lastCanonical = canonical;
  }
  return `session:${sessionLifetime.generation}`;
}

/**
 * A test-only canonicalizer: returns `null` for no session, or a stable
 * `session:<n>` for any session. Two calls with the SAME canonical identity
 * produce the SAME key (registry-backed stability). Different identities
 * produce different keys. This is what tests that set `state.principal`
 * directly need: building the same session twice yields the same principal.
 *
 * The 065 defect was in the REAL reader (`readCourseSessionPrincipal`),
 * not here: the reader observed transitions through the same registry and
 * restored historical identities. The reader now uses its own module-level
 * lifetime (no registry) so observed transitions always advance.
 *
 * The registry is bounded (SESSION_IDENTITY_MEMORY) to prevent unbounded
 * growth in long-running test suites.
 */
const SESSION_IDENTITY_MEMORY = 256;
const sessionIdentities = new Map<string, number>();
let sessionIncarnation = 0;
export function buildCoursePrincipal(input: CoursePrincipalInput): string | null {
  const identity = canonicalSessionIdentity(input);
  if (identity === null) return null;
  const existing = sessionIdentities.get(identity);
  if (existing !== undefined) return `session:${existing}`;
  const id = ++sessionIncarnation;
  if (sessionIdentities.size >= SESSION_IDENTITY_MEMORY) {
    // Evict the oldest entry to prevent unbounded growth. This is safe because
    // the registry is test-only and the eviction only affects whether a
    // re-introduced identity gets a fresh incarnation (acceptable in tests).
    const firstKey = sessionIdentities.keys().next().value;
    if (firstKey !== undefined) sessionIdentities.delete(firstKey);
  }
  sessionIdentities.set(identity, id);
  return `session:${id}`;
}

// ---------------------------------------------------------------------------
// Numeric parsing contract
// ---------------------------------------------------------------------------

export type CoursePriceError = 'malformed' | 'negative' | 'nonfinite';

export type CoursePriceResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: CoursePriceError };

/** A price the user can actually type: digits with at most one dot. Scientific
 *  notation, thousands separators, currency words and Arabic-Indic digits are
 *  NOT accepted — `parseFloat('12abc') === 12` is exactly the partial read
 *  this rejects. Empty means "no price entered", which the page has always
 *  sent as 0 (existing behaviour, unchanged). */
const STRICT_PRICE = /^-?(?:\d+|\d*\.\d+|\d+\.\d*)$/;

export function parseCoursePrice(raw: string | number | null | undefined): CoursePriceResult {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'nonfinite' };
    if (raw < 0) return { ok: false, reason: 'negative' };
    return { ok: true, value: raw };
  }
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, value: 0 };
  if (!STRICT_PRICE.test(text)) return { ok: false, reason: 'malformed' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: 'nonfinite' };
  if (value < 0) return { ok: false, reason: 'negative' };
  return { ok: true, value };
}

export function describeCoursePriceError(reason: CoursePriceError): string {
  if (reason === 'negative') return 'السعر لا يمكن أن يكون رقمًا سالبًا.';
  if (reason === 'nonfinite') return 'السعر غير صالح؛ أدخل رقمًا محددًا.';
  return 'السعر غير صحيح؛ أدخل رقمًا صالحًا مثل 150 أو 150.5.';
}

// ---------------------------------------------------------------------------
// Grade name ↔ id mapping
// ---------------------------------------------------------------------------

export interface CourseGradeOption {
  readonly id: string;
  readonly name: string;
}

export interface CourseGradeResolution {
  /** The value written to `grade` — a grade NAME (the stored contract). */
  readonly grade: string | null;
  /** False when the value could not be matched to a current active grade. */
  readonly available: boolean;
  /** True when a value that could not be matched was kept as-is instead of
   *  being dropped (no silent data deletion). */
  readonly preserved: boolean;
}

/**
 * Resolves the form's `grade_id` field to the NAME the server stores.
 *
 * The field legitimately holds either a grade id (the Select item value) or a
 * legacy NAME (`handleEdit` used to assign `course.grade` to it, which is a
 * name — the mismatch that nulled the grade on every edit save). Resolution
 * therefore tries the id first, then the name. Anything still unmatched is
 * KEPT, never nulled: an archived/deactivated grade must survive an edit of
 * unrelated fields.
 */
export function resolveCourseGrade(
  value: string | null | undefined,
  grades: readonly CourseGradeOption[],
  originalValue?: string | null
): CourseGradeResolution {
  const text = (value ?? '').trim();
  if (!text) return { grade: null, available: true, preserved: false };
  const byId = grades.find((grade) => grade.id && grade.id === text);
  if (byId) return { grade: byId.name, available: true, preserved: false };
  const byName = grades.find((grade) => grade.name && grade.name === text);
  if (byName) return { grade: byName.name, available: true, preserved: true };
  // Unmatched: preserve the value as-is (legacy id of a grade that is no
  // longer active, or the course's own stored value the user did not change).
  return { grade: text, available: false, preserved: true };
}

/** Maps a stored `course.grade` back to the value the grade Select should
 *  show: the matching grade's id when possible, otherwise the raw value so an
 *  unavailable grade stays visible and selectable instead of being cleared. */
export function toGradeFieldValue(
  courseGrade: string | null | undefined,
  grades: readonly CourseGradeOption[]
): string {
  const text = (courseGrade ?? '').trim();
  if (!text) return '';
  const byId = grades.find((grade) => grade.id && grade.id === text);
  if (byId) return byId.id;
  const byName = grades.find((grade) => grade.name && grade.name === text);
  if (byName) return byName.id;
  return text;
}

// ---------------------------------------------------------------------------
// Form validation and payload
// ---------------------------------------------------------------------------

export interface CourseFormValues {
  name: string;
  description: string;
  subject: string;
  grade_id: string;
  subscription_id: string;
  price: string | number | null;
}

export interface CourseFieldErrors {
  name?: string;
  subject?: string;
  price?: string;
}

export interface CourseValidation {
  readonly ok: boolean;
  readonly fieldErrors: CourseFieldErrors;
}

export function validateCourseForm(values: CourseFormValues): CourseValidation {
  const fieldErrors: CourseFieldErrors = {};
  const name = (values.name ?? '').trim();
  const subject = (values.subject ?? '').trim();
  if (!name) fieldErrors.name = 'اسم الكورس مطلوب.';
  if (!subject) fieldErrors.subject = 'المادة مطلوبة.';
  const price = parseCoursePrice(values.price);
  if (price.ok === false) fieldErrors.price = describeCoursePriceError(price.reason);
  return { ok: Object.keys(fieldErrors).length === 0, fieldErrors };
}

/** The exact write body the page has always sent, plus the grade mapping fix.
 *  `subscription_id` is deliberately NOT part of it: the form collects it but
 *  the current contract has no field for it on the course row (reported gap,
 *  not an invented binding). */
export interface CourseWritePayload {
  name: string;
  description: string;
  subject: string;
  grade: string | null;
  price: number;
  is_active?: boolean;
}

export function buildCoursePayload(
  values: CourseFormValues,
  grades: readonly CourseGradeOption[],
  originalGrade?: string | null
): { payload: CourseWritePayload; grade: CourseGradeResolution } {
  const price = parseCoursePrice(values.price);
  const grade = resolveCourseGrade(values.grade_id, grades, originalGrade);
  return {
    grade,
    payload: {
      name: (values.name ?? '').trim(),
      description: (values.description ?? '').trim(),
      subject: (values.subject ?? '').trim(),
      grade: grade.grade,
      price: price.ok ? price.value : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Single-flight latch and generation sequence
// ---------------------------------------------------------------------------

export interface TicketSource {
  next(): number;
}

export function createTicketSource(): TicketSource {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
  };
}

export interface CourseOperationGuard {
  /** Must be called BEFORE the first await: a same-tick duplicate (two
   *  clicks, click + Enter) is rejected before any request leaves the page. */
  acquire(): boolean;
  holder(): number;
  /** Frees the latch ONLY when `token` still owns it, so a superseded
   *  operation's `finally` can never release a NEWER operation's latch. Called
   *  without a token it is the unconditional retire used by the lifecycle
   *  paths (session change, dispose) that discard the in-flight operation. */
  release(token?: number): void;
  isBusy(): boolean;
}

export function createCourseOperationGuard(source: TicketSource): CourseOperationGuard {
  let owner = 0;
  return {
    acquire: () => {
      if (owner !== 0) return false;
      owner = source.next();
      return true;
    },
    holder: () => owner,
    release: (token?: number) => {
      if (token === undefined || token === owner) owner = 0;
    },
    isBusy: () => owner !== 0,
  };
}

/** Monotonic generation for stale-reply invalidation. A reply commits only
 *  while its generation is still current. `current()` captures WITHOUT
 *  advancing — that is what a mutation needs: it is fenced against a later
 *  invalidation instead of invalidating itself. */
export interface CourseSequence {
  next(): number;
  current(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createCourseSequence(): CourseSequence {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
    current: () => latest,
    isCurrent: (token: number) => token === latest,
    invalidate: () => {
      latest += 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type CourseListPhase = 'loading' | 'ready' | 'empty' | 'error';
export type CourseBusyKind = 'create' | 'update' | 'archive' | 'refresh' | 'publication' | null;
export type CourseMutationOutcome = 'created' | 'updated' | 'duplicate' | 'invalid' | 'blocked' | 'failed';
export type CourseArchiveOutcome = 'archived' | 'duplicate' | 'blocked' | 'failed';

/**
 * The explicit result of a publication action.
 *
 * `unchanged` means the requested state is already the confirmed one, so
 * NOTHING was sent. `uncertain` means the reply may or may not have persisted;
 * nothing is retried automatically and the page must not claim either state.
 * `unavailable` means this deployment does not wire the publication route at
 * all — again, nothing was sent.
 */
export type CoursePublicationOutcome =
  | 'published'
  | 'unpublished'
  | 'unchanged'
  | 'duplicate'
  | 'blocked'
  | 'unavailable'
  | 'failed'
  | 'uncertain';

export interface CourseSubscriptionOption {
  readonly id: string;
  readonly name: string;
  readonly price: number;
}

export interface CourseManagementState {
  phase: CourseListPhase;
  courses: Course[];
  grades: CourseGradeOption[];
  subscriptions: CourseSubscriptionOption[];
  busyKind: CourseBusyKind;
  listError: string | null;
  optionsError: string | null;
  mutationError: string | null;
  archiveError: string | null;
  /** A refresh that failed AFTER the server confirmed the write. Reported
   *  separately so the page never re-opens the form for a duplicate write. */
  refreshError: string | null;
  fieldErrors: CourseFieldErrors;
  deleteTarget: Course | null;
  savedCourseId: string | null;
  /** Set when a write persisted a grade that no longer matches an active
   *  grade: the value was kept, and the page says so instead of hiding it. */
  gradeNotice: string | null;
  /**
   * The last SERVER-CONFIRMED publication state per course id.
   *
   * A course is absent from this map when its state is not known — the private
   * list row did not carry one (the M2-22 migration is a file only and may not
   * be applied yet) and no publication action has confirmed it. Absence is
   * "unknown", never "draft".
   */
  publication: Record<string, CoursePublicationState>;
  publicationError: string | null;
  publicationNotice: string | null;
}

export interface CourseManagementApi {
  loadCourses: () => Promise<Course[]>;
  loadGrades: () => Promise<Grade[]>;
  loadSubscriptions?: () => Promise<Subscription[]>;
  createCourse: (payload: CourseWritePayload) => Promise<string>;
  updateCourse: (id: string, payload: CourseWritePayload) => Promise<void>;
  /** DELETE archives (`is_active = 0`); it is never a hard delete. */
  archiveCourse: (id: string) => Promise<void>;
  /**
   * M2-22 publication writes. OPTIONAL on purpose: a deployment that has not
   * shipped the publication route simply does not wire them, and the action
   * then reports `unavailable` without sending anything — it never fabricates
   * a state.
   */
  publishCourse?: (id: string) => Promise<CoursePublication>;
  unpublishCourse?: (id: string) => Promise<CoursePublication>;
  /** Optional reader of the current session principal (tenant/user). A write
   *  started by one principal never commits under another. */
  readPrincipal?: () => string | null;
  /** Optional session notifier subscription; a change retires everything in
   *  flight and reloads the list for the new principal. */
  subscribeSession?: (listener: () => void) => () => void;
}

export interface CourseManagementController {
  getState(): CourseManagementState;
  subscribe(listener: (state: CourseManagementState) => void): () => void;
  load(): Promise<void>;
  loadOptions(): Promise<void>;
  refresh(): Promise<void>;
  /** Opens a page-owned form incarnation: `null` target = create, a course =
   *  edit. The returned number identifies THIS open form/dialog, so a submit
   *  started by an OLDER incarnation can never close or reset a newer one. */
  openForm(target: Course | null): number;
  /** Retires the current form incarnation: the dialog was closed, replaced or
   *  discarded (session change / unmount). */
  closeForm(): void;
  isFormCurrent(instance: number): boolean;
  /** `instance` is the incarnation returned by `openForm`. Omit it only where
   *  the caller has no dialog lifetime (a write is then fenced by generation
   *  and principal alone, the pre-existing behaviour). */
  submit(form: CourseFormValues, target: Course | null, instance?: number): Promise<CourseMutationOutcome>;
  requestArchive(course: Course): void;
  cancelArchive(): void;
  confirmArchive(): Promise<CourseArchiveOutcome>;
  /** Publishes one course into the anonymous public catalogue. */
  publish(courseId: string): Promise<CoursePublicationOutcome>;
  /** Withdraws one course from the anonymous public catalogue. */
  unpublish(courseId: string): Promise<CoursePublicationOutcome>;
  /** The last server-confirmed state of one course, or null when unknown. */
  publicationState(courseId: string): CoursePublicationState | null;
  /** Awaits every operation the controller still has in flight (tests only). */
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const initialState: CourseManagementState = {
  phase: 'loading',
  courses: [],
  grades: [],
  subscriptions: [],
  busyKind: null,
  listError: null,
  optionsError: null,
  mutationError: null,
  archiveError: null,
  refreshError: null,
  fieldErrors: {},
  deleteTarget: null,
  savedCourseId: null,
  gradeNotice: null,
  publication: {},
  publicationError: null,
  publicationNotice: null,
};

export function createCourseManagementController(api: CourseManagementApi): CourseManagementController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: CourseManagementState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** Generations for the list and for writes. Loads advance it; a write only
   *  CAPTURES it, so a concurrent write is never invalidated by the refresh it
   *  starts. The options read keeps its own sequence: it is an independent
   *  dependency, and sharing one sequence made it invalidate the list load the
   *  page starts at the same moment. */
  const sequence = createCourseSequence();
  const optionsSequence = createCourseSequence();
  const loadGuard = createCourseOperationGuard(tickets);
  const optionsGuard = createCourseOperationGuard(tickets);
  const writeGuard = createCourseOperationGuard(tickets);
  /** Ticket that owns `state.busyKind` (`null` when idle): only the owner may
   *  replace or clear it, so a retired operation's late completion can never
   *  clear a NEWER operation's busy marker. */
  let busyOwner: number | null = null;
  /** Incarnation of the OPEN delete dialog. Every `requestArchive` and every
   *  `cancelArchive` advances it, so an archive that was started for an older
   *  target can neither clear a newer target nor write its error onto it
   *  (supervisor/061 finding 1). */
  let deleteTargetTicket = 0;
  /** Incarnation of the OPEN create/edit form. `openForm` advances it, and so
   *  does every close/replace/session change, so a save started under an older
   *  dialog can never close or reset a newer one (supervisor/061 finding 3). */
  let formTicket = 0;

  const patch = (changes: Partial<CourseManagementState>): void => {
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

  /** An operation may commit only while it is still the one the page is
   *  waiting for: not disposed, not superseded, same session principal. */
  const isOperationCurrent = (generation: number, principal: string | null): boolean => {
    if (disposed || !sequence.isCurrent(generation)) return false;
    return readPrincipal() === principal;
  };

  /** Same rule for the independent options read (its own sequence). */
  const isOptionsCurrent = (generation: number, principal: string | null): boolean => {
    if (disposed || !optionsSequence.isCurrent(generation)) return false;
    return readPrincipal() === principal;
  };

  /** Discards every in-flight operation and the latch it holds, and clears
   *  the busy marker it owns — a superseded page must never stay busy. */
  const retireInFlight = (): void => {
    sequence.invalidate();
    optionsSequence.invalidate();
    loadGuard.release();
    optionsGuard.release();
    writeGuard.release();
    // Both page-owned lifetimes are retired too: an in-flight archive can no
    // longer clear the delete target, and an in-flight save can no longer
    // close the form, under the new session.
    deleteTargetTicket = tickets.next();
    formTicket = tickets.next();
    busyOwner = null;
    patch({ busyKind: null });
  };

  /** Opens a form incarnation. Passing the returned value to `submit` is what
   *  fences a late completion away from a NEWER dialog. */
  const openForm = (target: Course | null): number => {
    if (disposed) return 0;
    formTicket = tickets.next();
    // A dialog that opens is authoritative for the editing target it shows.
    if (target) patch({ mutationError: null });
    return formTicket;
  };

  /** Retires the current form incarnation without closing anything the page
   *  owns: a pending save started by it can no longer commit a close/reset. */
  const closeForm = (): void => {
    formTicket = tickets.next();
  };

  const isFormCurrent = (instance: number): boolean =>
    !disposed && instance !== 0 && instance === formTicket;

  /** True only while `ticket` is still the incarnation of the delete dialog
   *  the page is actually showing. */
  const isTargetCurrent = (ticket: number): boolean =>
    !disposed && ticket !== 0 && ticket === deleteTargetTicket && state.deleteTarget !== null;

  const runLoad = async (kind: 'list' | 'refresh'): Promise<void> => {
    if (disposed) return;
    if (!loadGuard.acquire()) return;
    const ticket = loadGuard.holder();
    const generation = sequence.next();
    const principal = readPrincipal();
    if (kind === 'refresh') {
      busyOwner = ticket;
      patch({ busyKind: 'refresh', refreshError: null });
    } else {
      patch({ phase: 'loading', listError: null, refreshError: null });
    }
    try {
      const rows = await api.loadCourses();
      if (!isOperationCurrent(generation, principal)) {
        clearBusy(ticket);
        return;
      }
      if (!Array.isArray(rows)) {
        // A malformed body is never an empty list: fail closed.
        patch({ phase: 'error', courses: [], listError: 'استجابة غير صالحة من الخادم' });
        return;
      }
      const active = rows.filter((course) => course && course.is_active !== false);
      // The private list row carries `publication_state` once the M2-22
      // migration is applied. A confirmed state is never downgraded to unknown
      // by a list that simply does not report one, so the merge keeps what a
      // publication action already confirmed; an entry whose course is no
      // longer listed is pruned.
      const publication: Record<string, CoursePublicationState> = {};
      for (const course of active) {
        const confirmed = readCoursePublicationState(course);
        if (confirmed !== null) publication[course.id] = confirmed;
        else if (state.publication[course.id] !== undefined) {
          publication[course.id] = state.publication[course.id];
        }
      }
      patch({
        phase: active.length > 0 ? 'ready' : 'empty',
        courses: active,
        publication,
        listError: null,
        refreshError: null,
      });
    } catch (cause) {
      if (!isOperationCurrent(generation, principal)) {
        clearBusy(ticket);
        return;
      }
      const failure = classifyCourseFailure(cause);
      if (kind === 'refresh') {
        // The list already on screen is still the server's last confirmed
        // state: report the refresh, never rewrite the list, never re-open a
        // form (that is what invited a duplicate creation).
        patch({ refreshError: failure.message });
      } else {
        patch({ phase: 'error', courses: [], listError: failure.message });
      }
    } finally {
      clearBusy(ticket);
      loadGuard.release(ticket);
    }
  };

  const loadOptions = async (): Promise<void> => {
    if (disposed) return;
    if (!optionsGuard.acquire()) return;
    const ticket = optionsGuard.holder();
    const generation = optionsSequence.next();
    const principal = readPrincipal();
    try {
      const [grades, subscriptions] = await Promise.all([
        api.loadGrades(),
        api.loadSubscriptions ? api.loadSubscriptions() : Promise.resolve([] as Subscription[]),
      ]);
      if (!isOptionsCurrent(generation, principal)) return;
      const activeGrades = (Array.isArray(grades) ? grades : []).filter(
        (grade) => grade && grade.is_active !== false
      );
      const activeSubs = (Array.isArray(subscriptions) ? subscriptions : []).filter(
        (sub) => sub && sub.is_active !== false
      );
      patch({
        grades: activeGrades.map((grade) => ({ id: String(grade.id ?? ''), name: grade.name })),
        subscriptions: activeSubs.map((sub) => ({
          id: String(sub.id ?? ''),
          name: sub.name,
          price: typeof sub.price === 'number' ? sub.price : Number(sub.price ?? 0),
        })),
        optionsError: null,
      });
    } catch (cause) {
      if (!isOptionsCurrent(generation, principal)) return;
      // A failed options load must not blank the list: it only disables the
      // two selects (the page renders them from this state).
      patch({ optionsError: classifyCourseFailure(cause).message });
    } finally {
      optionsGuard.release(ticket);
    }
  };

  const submit = async (
    form: CourseFormValues,
    target: Course | null,
    instance?: number
  ): Promise<CourseMutationOutcome> => {
    if (disposed) return 'blocked';
    // A save whose dialog was already closed or replaced never starts.
    if (instance !== undefined && !isFormCurrent(instance)) return 'blocked';
    const validation = validateCourseForm(form);
    if (!validation.ok) {
      // No request at all for a malformed form: the values stay on screen.
      patch({ fieldErrors: validation.fieldErrors });
      return 'invalid';
    }
    if (!writeGuard.acquire()) return 'duplicate';
    const ticket = writeGuard.holder();
    const generation = sequence.current();
    const principal = readPrincipal();
    const kind: 'create' | 'update' = target ? 'update' : 'create';
    busyOwner = ticket;
    patch({ busyKind: kind, mutationError: null, refreshError: null, fieldErrors: {}, gradeNotice: null });

    const { payload, grade } = buildCoursePayload(form, state.grades, target ? target.grade ?? null : null);
    /** The dialog this save belongs to must still be the open one for its
     *  completion to close or reset anything. */
    const canCommit = (): boolean =>
      isOperationCurrent(generation, principal) &&
      (instance === undefined || isFormCurrent(instance));
    try {
      let savedId: string | null = null;
      if (target) {
        await api.updateCourse(target.id, payload);
        savedId = target.id;
      } else {
        // `is_active` is part of the existing create body only.
        savedId = await api.createCourse({ ...payload, is_active: true });
      }
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      clearBusy(ticket);
      patch({
        mutationError: null,
        savedCourseId: savedId,
        gradeNotice: grade.available || grade.grade === null ? null : grade.grade,
      });
      // The server already confirmed the write; the refresh below can fail
      // without ever re-opening the form.
      track(runLoad('refresh'));
      return target ? 'updated' : 'created';
    } catch (cause) {
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      // Failure keeps the form AND the editing target: the page leaves the
      // dialog open with what the user typed.
      clearBusy(ticket);
      patch({ mutationError: classifyCourseFailure(cause).message });
      return 'failed';
    } finally {
      writeGuard.release(ticket);
    }
  };

  const requestArchive = (course: Course): void => {
    if (disposed) return;
    // A NEW target is a NEW dialog incarnation: any archive still in flight
    // for the previous one is retired by this advance.
    deleteTargetTicket = tickets.next();
    patch({ deleteTarget: course, archiveError: null });
  };

  const cancelArchive = (): void => {
    // Cancelling retires the incarnation as well, so a request that is already
    // on the wire can no longer close, clear or error the dialog the user just
    // dismissed.
    deleteTargetTicket = tickets.next();
    patch({ deleteTarget: null, archiveError: null });
  };

  const confirmArchive = async (): Promise<CourseArchiveOutcome> => {
    const target = state.deleteTarget;
    if (disposed || !target) return 'blocked';
    if (!writeGuard.acquire()) return 'duplicate';
    const ticket = writeGuard.holder();
    const generation = sequence.current();
    const principal = readPrincipal();
    // The incarnation of the dialog this confirmation was fired from.
    const targetTicket = deleteTargetTicket;
    busyOwner = ticket;
    patch({ busyKind: 'archive', archiveError: null });
    /** The archive may touch the dialog only while it is still the CURRENT
     *  target — never after a cancel, a different course, a session change or
     *  a dispose (supervisor/061 finding 1). */
    const canCommit = (): boolean =>
      isOperationCurrent(generation, principal) && isTargetCurrent(targetTicket);
    try {
      await api.archiveCourse(target.id);
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      // Cleared ONLY on a server-confirmed archive of the current target: a
      // failed delete keeps the dialog and its target so the user can retry
      // without re-selecting.
      clearBusy(ticket);
      patch({ deleteTarget: null, archiveError: null, savedCourseId: target.id });
      track(runLoad('refresh'));
      return 'archived';
    } catch (cause) {
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      clearBusy(ticket);
      patch({ archiveError: classifyCourseFailure(cause).message });
      return 'failed';
    } finally {
      writeGuard.release(ticket);
    }
  };

  /**
   * The shared publication skeleton for publish AND unpublish.
   *
   * `next` is the state the caller asked for. The server's answer is
   * authoritative: only a validated record for THIS course reporting THIS state
   * confirms the action. A record for another course, a record reporting a
   * different state, or an unparseable body is `uncertain` — never a success.
   */
  const runPublication = async (
    courseId: string,
    next: CoursePublicationState,
  ): Promise<CoursePublicationOutcome> => {
    if (disposed) return 'blocked';
    const target = typeof courseId === 'string' ? courseId.trim() : '';
    if (target === '') return 'blocked';
    const write = next === 'published' ? api.publishCourse : api.unpublishCourse;
    // Not wired on this deployment: nothing is sent and no state is invented.
    if (!write) return 'unavailable';
    // Truthful no-op: the requested state is already the confirmed one.
    if (state.publication[target] === next) {
      patch({ publicationError: null, publicationNotice: COURSE_PUBLICATION_UNCHANGED_MESSAGE });
      return 'unchanged';
    }
    if (!writeGuard.acquire()) return 'duplicate';
    const ticket = writeGuard.holder();
    const generation = sequence.current();
    const principal = readPrincipal();
    busyOwner = ticket;
    patch({ busyKind: 'publication', publicationError: null, publicationNotice: null });
    const canCommit = (): boolean => isOperationCurrent(generation, principal);
    try {
      const response = await write(target);
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      const parsed = parseCoursePublication(response);
      if (parsed === null || parsed.course_id !== target || parsed.publication_state !== next) {
        // The write may have persisted, but this reply cannot prove it.
        clearBusy(ticket);
        patch({
          publicationError: COURSE_PUBLICATION_UNEXPECTED_MESSAGE,
          publicationNotice: null,
        });
        return 'uncertain';
      }
      clearBusy(ticket);
      patch({
        publication: { ...state.publication, [target]: parsed.publication_state },
        publicationError: null,
        publicationNotice: next === 'published'
          ? COURSE_PUBLISHED_MESSAGE
          : COURSE_UNPUBLISHED_MESSAGE,
      });
      return next === 'published' ? 'published' : 'unpublished';
    } catch (cause) {
      if (!canCommit()) {
        clearBusy(ticket);
        return 'blocked';
      }
      const failure = classifyCourseFailure(cause);
      clearBusy(ticket);
      if (failure.kind === 'unavailable') {
        // The course vanished (or is foreign — the server answers the same), so
        // the held row, its confirmed state and any delete dialog aimed at it
        // go with it.
        const courses = state.courses.filter((course) => course.id !== target);
        const publication = { ...state.publication };
        delete publication[target];
        patch({
          courses,
          publication,
          phase: state.phase === 'ready' && courses.length === 0 ? 'empty' : state.phase,
          deleteTarget: state.deleteTarget && state.deleteTarget.id === target ? null : state.deleteTarget,
          publicationError: failure.message,
          publicationNotice: null,
        });
        return 'failed';
      }
      if (failure.kind === 'denied' || PUBLICATION_DENIED_MESSAGES.has(failure.message)) {
        // A definite denial: no state is claimed and nothing is retried.
        patch({ publicationError: failure.message, publicationNotice: null });
        return 'failed';
      }
      // Uncertain: the write may have persisted, so no state is claimed and
      // nothing is retried automatically.
      patch({
        publicationError: failure.message || COURSE_PUBLICATION_UNCERTAIN_MESSAGE,
        publicationNotice: null,
      });
      return 'uncertain';
    } finally {
      writeGuard.release(ticket);
    }
  };

  const waitForIdle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal: every in-flight reply is foreign, and the list on
        // screen belongs to the previous one.
        retireInFlight();
        patch({
          courses: [],
          grades: [],
          subscriptions: [],
          deleteTarget: null,
          listError: null,
          refreshError: null,
          mutationError: null,
          archiveError: null,
          fieldErrors: {},
          savedCourseId: null,
          gradeNotice: null,
          publication: {},
          publicationError: null,
          publicationNotice: null,
        });
        track(runLoad('list'));
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
    load: () => {
      const operation = runLoad('list');
      track(operation);
      return operation;
    },
    loadOptions: () => {
      const operation = loadOptions();
      track(operation);
      return operation;
    },
    refresh: () => {
      const operation = runLoad('refresh');
      track(operation);
      return operation;
    },
    openForm,
    closeForm,
    isFormCurrent,
    submit,
    requestArchive,
    cancelArchive,
    confirmArchive,
    publish: (courseId) => runPublication(courseId, 'published'),
    unpublish: (courseId) => runPublication(courseId, 'draft'),
    publicationState: (courseId) => {
      const value = state.publication[courseId];
      return value === undefined ? null : value;
    },
    waitForIdle,
    dispose,
  };
}
