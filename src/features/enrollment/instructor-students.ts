/**
 * M2-04 existing instructor enrollment management seam — the smallest
 * production module `src/pages/InstructorStudents.tsx` delegates to.
 *
 * It separates the testable orchestration (per-section read lifetimes,
 * scope/session/form/decision/invitation incarnations, single-flight
 * mutations, retained form and decision target on failure, honest clipboard
 * reporting) from React rendering. Transport, the clipboard surface, the
 * origin and the principal reader are injected, so the EXACT production code
 * the page runs is exercised hermetically in
 * src/tests/m2-instructor-students.test.ts with no DB, network, browser or
 * live app.
 *
 * Contracts verified from source (documented in
 * docs/streams/client/M2-04-CONTRACTS.md):
 *  - GET /instructors/:id/students returns the caller's own students only
 *    (`WHERE s.instructor_id = ?`) with id, name, phone, is_offline,
 *    approval_status, is_active, created_at, grade_name, group_name
 *    (server/src/routes/instructors.ts:229-252). There is no wallet, request or
 *    violation field in that body, which is why each of those is a SEPARATE
 *    read with its own state;
 *  - POST /students requires a name, requires phone + a >=10 character
 *    password for an online student, refuses a group outside the caller's
 *    scope (403), stores `is_offline` as a boolean and `approval_status`
 *    verbatim (server/src/routes/students.ts:297-374). A duplicate phone or
 *    membership is a 409, never a success;
 *  - POST /student-enrollment/invites/rotate REVOKES every previous
 *    unrevoked invite for that instructor inside one transaction before
 *    inserting the new 30-day one (student-enrollment.ts:35-63). A second
 *    rotation therefore invalidates the link the instructor already shared —
 *    which is exactly why it must be single-flight and why a clipboard
 *    failure after a successful rotation may never trigger another rotation;
 *  - GET /student-enrollment/requests is instructor-only, pending first,
 *    limited to 250 (student-enrollment.ts:163-173);
 *  - POST /requests/:id/approve locks the pending row `FOR UPDATE` and answers
 *    404 `Pending request not found` when it is no longer pending
 *    (student-enrollment.ts:175-...); reject requires a reason of at least 3
 *    characters and answers the same 404 (student-enrollment.ts:252-269).
 *    A repeated decision is therefore a STALE target, not a new decision;
 *  - POST /password-resets/:id/approve issues a 15-minute one-time code and
 *    answers 404 `Pending reset request not found` when it is no longer
 *    pending (student-enrollment.ts:330-347). The code is shown once through
 *    the page's existing manual delivery path; no OTP/provider is involved;
 *  - POST /secure-video/instructor/students/:id/suspend clamps the duration to
 *    5..1440 minutes and requires an owned, active student
 *    (secure-video.ts:813-836);
 *  - every failure throws the server's `error` string WITHOUT the status code
 *    (api-http.ts:89), so only the documented message may classify it.
 *
 * Lifetimes fenced here:
 *  - section reads: each of the six reads has its own generation, so a slow
 *    reply can never overwrite a newer one, and a failure NEVER becomes an
 *    empty list or a confirmed zero balance — the last confirmed rows stay on
 *    screen with a separate error beside them;
 *  - scope: a different instructor id clears the previous instructor's
 *    confirmed rows before anything new is read, and the scope itself is a
 *    monotonic LIFETIME — every mutation captures its incarnation and
 *    re-validates it after every await, so A → B → A is a new scope and an
 *    operation started under the first A can never be revived by returning to
 *    that id. A scope change also retires the old scope's latches and busy
 *    state synchronously, so new scope work is never blocked by transport the
 *    retired scope still owes;
 *  - session: the canonical principal (exact canonical comparison, monotonic
 *    incarnation, no lossy digest, no historical registry, token never
 *    returned) is re-read at claim AND commit time; any observed change
 *    retires everything in flight and clears every private output (invite
 *    link, one-time reset code) so nothing from one session can render under
 *    another. An UNANNOUNCED replacement (no session event) is adopted at the
 *    next observation through the same single retirement path;
 *  - refresh: every awaited follow-up read is re-validated (session, scope,
 *    disposal) before the operation returns an outcome the page turns into a
 *    success toast, so a confirmed write is never published in another
 *    session — and never downgraded into a retryable write failure;
 *  - invitation link: the confirmed link has an incarnation; a copy that
 *    started on an older link can never set `inviteCopied` for a newer one;
 *  - form: a submit started by a form incarnation that was since closed,
 *    replaced or edited can never clear or close what the instructor is
 *    typing into now;
 *  - decision: the target request is retained on failure for a deliberate
 *    retry, and a confirmed decision is never re-sent by a duplicate click;
 *  - invitation: rotation is single-flight (it revokes the previous link), and
 *    a clipboard refusal keeps the confirmed link and reports it honestly
 *    instead of claiming a copy or rotating again;
 *  - branch (M2-18): the catalog is read as its OWN bounded section, only
 *    ACTIVE branches are selectable, the draft target is retained on a
 *    retryable failure and cleared on a denial/not-found, a duplicate save
 *    never reaches the transport, and the write is only published when the
 *    server's own projection names the SAME student and the SAME branch —
 *    a reply about any other row is a stale reply, not a success. Permission is
 *    never inferred here: the controller holds no role, profile or status, so
 *    only the server's answer can authorize or refuse;
 *  - operation: every latch is acquired synchronously before the first await,
 *    and an older `finally` can only remove ITS OWN busy entry and release ITS
 *    OWN ticket, never a newer operation's — including one started by the new
 *    scope after a retirement.
 *
 * Out of scope by construction: no shared helper/auth/router/backend/package/
 * schema edit, no new OTP/provider/payment/video policy, no client-side
 * subscription, admission or billing authority, no invented contract field.
 */
import type {
  EnrollmentRequest,
  Group,
  Student,
  StudentBranchAssignment,
  StudentPasswordResetRequest,
  TenantBranch,
  TenantBranchStatus,
  VideoSecurityViolation,
} from '../../lib/api-http';

// ---------------------------------------------------------------------------
// Session boundary
// ---------------------------------------------------------------------------

/**
 * The page's storage surface, injected so the real reader is testable with no
 * DOM, no browser and no live app.
 */
export interface InstructorSessionStorage {
  getItem(key: string): string | null;
}

interface PrincipalInput {
  id?: unknown;
  role?: unknown;
  billingOnly?: unknown;
  token?: unknown;
}

const canonicalPart = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text === '' ? null : text;
};

/** The exact canonical session, or `null` when there is no session at all.
 *  PRIVATE on purpose: it holds the token, so it is never returned. */
const canonicalSessionIdentity = (input: PrincipalInput): string | null => {
  const parts = [
    canonicalPart(input.id),
    canonicalPart(input.role),
    canonicalPart(input.billingOnly),
    canonicalPart(input.token),
  ];
  if (parts.every((part) => part === null)) return null;
  // JSON keeps the encoding unambiguous, so two different sessions cannot
  // collide on a separator forged inside one of the values.
  return JSON.stringify(parts);
};

/**
 * Module-level session lifetime: ONLY the latest canonical value and a
 * monotonic generation — no historical registry, so a return to a previously
 * seen token is a NEW incarnation and consecutive unchanged reads are stable.
 *
 * It is deliberately local to this feature instead of importing the catalog
 * reader: the approved handoff forbids a cross-feature dependency, and the
 * comparison contract (exact canonical equality, monotonic incarnation) is
 * identical. It is not a second shared authority — each page owns its own
 * lifetime and compares only against itself.
 */
let sessionLifetime: { lastCanonical: string | null; generation: number } = {
  lastCanonical: null,
  generation: 0,
};

/** Resets the session lifetime. Test-only, so suites do not bleed
 *  incarnations into each other. */
export function resetInstructorSessionLifetime(): void {
  sessionLifetime = { lastCanonical: null, generation: 0 };
}

/**
 * The ACTUAL production principal reader the page uses: `currentUser`
 * (id / role / billing_only) plus the canonical `authToken`, both read fresh
 * on every call. ANY observed change — including logout and a silent return to
 * a previously seen token — advances the incarnation.
 */
export function readInstructorSessionPrincipal(storage: InstructorSessionStorage): string | null {
  let user: { id?: unknown; role?: unknown; billing_only?: unknown } | null = null;
  let token: string | null = null;
  try {
    const raw = storage.getItem('currentUser');
    user = raw ? (JSON.parse(raw) as { id?: unknown; role?: unknown; billing_only?: unknown }) : null;
  } catch {
    // An unreadable profile behaves like no profile; the token below still
    // scopes the session and the value stays deterministic for comparison.
    user = null;
  }
  try {
    token = storage.getItem('authToken');
  } catch {
    token = null;
  }
  const canonical = canonicalSessionIdentity({
    id: user?.id,
    role: user?.role,
    billingOnly: user?.billing_only,
    token,
  });
  if (canonical === null) {
    if (sessionLifetime.lastCanonical !== null) {
      sessionLifetime.generation += 1;
      sessionLifetime.lastCanonical = null;
    }
    return null;
  }
  if (canonical !== sessionLifetime.lastCanonical) {
    sessionLifetime.generation += 1;
    sessionLifetime.lastCanonical = canonical;
  }
  return `session:${sessionLifetime.generation}`;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** The page's own wording for a body that is not the documented array. */
export const MALFORMED_LIST_MESSAGE = 'استجابة غير صالحة من الخادم';
/** A wallet body whose balance is not a finite number is NOT a zero balance. */
export const MALFORMED_WALLET_MESSAGE = 'تعذر التحقق من الرصيد من الخادم';
export const MALFORMED_RESET_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Exact server strings these routes send (see the header evidence). */
export const DUPLICATE_STUDENT_MESSAGE = 'Student already belongs to this instructor';
export const DUPLICATE_PHONE_MESSAGE = 'رقم الهاتف أو البريد مستخدم بالفعل';
export const STALE_REQUEST_MESSAGE = 'Pending request not found';
export const STALE_RESET_MESSAGE = 'Pending reset request not found';
export const INVALID_GRADE_GROUP_MESSAGE = 'Invalid grade or group';
export const REJECTION_REASON_REQUIRED_MESSAGE = 'Rejection reason is required';
export const INSTRUCTOR_REQUIRED_MESSAGE = 'Instructor access required';
export const WORKSPACE_REQUIRED_MESSAGE = 'Active instructor workspace required';
export const STUDENT_NAME_REQUIRED_MESSAGE = 'اسم الطالب مطلوب';
export const STUDENT_ONLINE_FIELDS_MESSAGE =
  'طالب الأونلاين يحتاج رقم هاتف وكلمة مرور من 10 أحرف على الأقل';
export const STUDENT_GROUP_SCOPE_MESSAGE = 'لا يمكن إضافة الطالب لمجموعة لا تخصك';
export const INVALID_PHONE_MESSAGE = 'Invalid Egyptian mobile number';

/**
 * M2-18 — the exact server strings `PATCH /api/students/:id/branch` answers
 * (server/src/routes/students.ts). They are the ONLY thing that may classify a
 * branch failure: the transport drops the HTTP status and the `code`, so a
 * status is never fabricated on the client and permission is never inferred
 * from a local role, profile or status.
 */
export const STUDENT_BRANCH_FORBIDDEN_MESSAGE = 'Forbidden';
export const TENANT_MEMBERSHIP_NOT_FOUND_MESSAGE = 'Tenant membership not found';
export const STUDENT_NOT_FOUND_MESSAGE = 'Student not found';
export const BRANCH_NOT_FOUND_MESSAGE = 'Branch not found';
export const INVALID_STUDENT_BRANCH_PAYLOAD_MESSAGE = 'Invalid student branch payload';
export const INVALID_STUDENT_ID_MESSAGE = 'Invalid student id';
export const STUDENT_BRANCH_CONFLICT_MESSAGE = 'Student was modified concurrently';

/**
 * `denied` = the caller is not the verified owner of the selected tenant.
 * `not-found` = the target student or the target branch is not there for this
 * tenant (the server answers identically for a foreign and an absent row, so
 * the client must not tell them apart either). `conflict` = the row moved under
 * the write. `invalid` = the payload or the id was malformed.
 */
export type StudentBranchFailureKind = 'denied' | 'not-found' | 'conflict' | 'invalid' | 'error';

export interface StudentBranchFailure {
  readonly kind: StudentBranchFailureKind;
  readonly message: string;
}

export function classifyStudentBranchFailure(cause: unknown): StudentBranchFailure {
  const message =
    cause instanceof Error ? cause.message : String(cause ?? 'حدث خطأ غير معروف');
  if (
    message === STUDENT_BRANCH_FORBIDDEN_MESSAGE ||
    message === TENANT_MEMBERSHIP_NOT_FOUND_MESSAGE
  ) {
    return { kind: 'denied', message };
  }
  if (message === STUDENT_NOT_FOUND_MESSAGE || message === BRANCH_NOT_FOUND_MESSAGE) {
    return { kind: 'not-found', message };
  }
  if (message === STUDENT_BRANCH_CONFLICT_MESSAGE) {
    return { kind: 'conflict', message };
  }
  if (
    message === INVALID_STUDENT_BRANCH_PAYLOAD_MESSAGE ||
    message === INVALID_STUDENT_ID_MESSAGE
  ) {
    return { kind: 'invalid', message };
  }
  return { kind: 'error', message };
}

export type EnrollmentFailureKind = 'duplicate' | 'stale' | 'denied' | 'invalid' | 'error';

export interface EnrollmentFailure {
  readonly kind: EnrollmentFailureKind;
  readonly message: string;
}

export function classifyEnrollmentFailure(cause: unknown): EnrollmentFailure {
  const message =
    cause instanceof Error ? cause.message : String(cause ?? 'حدث خطأ غير معروف');
  if (message === DUPLICATE_STUDENT_MESSAGE || message === DUPLICATE_PHONE_MESSAGE) {
    return { kind: 'duplicate', message };
  }
  if (message === STALE_REQUEST_MESSAGE || message === STALE_RESET_MESSAGE) {
    return { kind: 'stale', message };
  }
  if (
    message === INSTRUCTOR_REQUIRED_MESSAGE ||
    message === WORKSPACE_REQUIRED_MESSAGE ||
    message === STUDENT_GROUP_SCOPE_MESSAGE
  ) {
    return { kind: 'denied', message };
  }
  if (
    message === INVALID_GRADE_GROUP_MESSAGE ||
    message === REJECTION_REASON_REQUIRED_MESSAGE ||
    message === STUDENT_NAME_REQUIRED_MESSAGE ||
    message === STUDENT_ONLINE_FIELDS_MESSAGE ||
    message === INVALID_PHONE_MESSAGE
  ) {
    return { kind: 'invalid', message };
  }
  return { kind: 'error', message };
}

// ---------------------------------------------------------------------------
// Student form contract
// ---------------------------------------------------------------------------

export type StudentKind = 'online' | 'offline';

export interface StudentFormValues {
  name: string;
  student_type: StudentKind | string;
  phone: string;
  guardian_phone: string;
  email: string;
  password: string;
  group_id: string;
}

export interface StudentFieldErrors {
  name?: string;
  phone?: string;
  password?: string;
}

export interface StudentValidation {
  readonly ok: boolean;
  readonly fieldErrors: StudentFieldErrors;
}

/** Mirrors the server's own creation rules (students.ts:310-315) so an
 *  obviously invalid form never reaches the transport. */
export function validateStudentForm(values: StudentFormValues): StudentValidation {
  const online = values.student_type === 'online';
  const fieldErrors: StudentFieldErrors = {};
  if (!(values.name ?? '').trim()) fieldErrors.name = 'اسم الطالب مطلوب.';
  if (online) {
    if (!(values.phone ?? '').trim()) fieldErrors.phone = 'رقم هاتف الطالب مطلوب لطالب الأونلاين.';
    if ((values.password ?? '').length < 10) {
      fieldErrors.password = 'كلمة المرور يجب أن تكون 10 أحرف على الأقل.';
    }
  }
  return { ok: Object.keys(fieldErrors).length === 0, fieldErrors };
}

/** The exact create body the page has always sent: `is_offline` stays a
 *  boolean derived from the selected kind, `approval_status` stays 'approved'
 *  (the server's own default), the group is optional, and an offline student
 *  never sends a password. */
export function buildStudentPayload(values: StudentFormValues): Partial<Student> {
  const online = values.student_type === 'online';
  const name = (values.name ?? '').trim();
  const phone = (values.phone ?? '').trim();
  const email = (values.email ?? '').trim();
  const guardian = (values.guardian_phone ?? '').trim();
  const groupId = (values.group_id ?? '').trim();
  return {
    name,
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(guardian ? { guardian_phone: guardian } : {}),
    ...(groupId ? { group_id: groupId } : {}),
    is_offline: !online,
    ...(online ? { password: values.password } : {}),
    approval_status: 'approved',
  };
}

// ---------------------------------------------------------------------------
// Suspension duration contract
// ---------------------------------------------------------------------------

export const MIN_SUSPENSION_MINUTES = 5;
export const MAX_SUSPENSION_MINUTES = 1440;

const WHOLE_MINUTES = /^\d+$/;

export type SuspensionMinutesResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'out-of-range' };

/**
 * Whole minutes inside the range the page itself documents. The server would
 * clamp silently (secure-video.ts:820); the page refuses instead, so the
 * instructor never believes a duration was applied that the server changed.
 */
export function parseSuspensionMinutes(raw: string | number | null | undefined): SuspensionMinutesResult {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return { ok: false, reason: 'malformed' };
    if (raw < MIN_SUSPENSION_MINUTES || raw > MAX_SUSPENSION_MINUTES) {
      return { ok: false, reason: 'out-of-range' };
    }
    return { ok: true, value: raw };
  }
  const text = (raw ?? '').trim();
  if (!WHOLE_MINUTES.test(text)) return { ok: false, reason: 'malformed' };
  const value = Number(text);
  if (!Number.isInteger(value)) return { ok: false, reason: 'malformed' };
  if (value < MIN_SUSPENSION_MINUTES || value > MAX_SUSPENSION_MINUTES) {
    return { ok: false, reason: 'out-of-range' };
  }
  return { ok: true, value };
}

export function describeSuspensionMinutesError(
  reason: 'malformed' | 'out-of-range'
): string {
  if (reason === 'out-of-range') {
    return `مدة التعليق يجب أن تكون بين ${MIN_SUSPENSION_MINUTES} و${MAX_SUSPENSION_MINUTES} دقيقة.`;
  }
  return 'مدة التعليق غير صحيحة؛ أدخل عددًا صحيحًا من الدقائق.';
}

// ---------------------------------------------------------------------------
// Invite link contract
// ---------------------------------------------------------------------------

/** `${origin}/join/${token}` — the same path the join route serves. The token
 *  is encoded and never logged; only the finished link is kept in memory. */
export function buildInviteUrl(origin: string, token: string): string | null {
  const trimmed = (token ?? '').trim();
  if (!trimmed) return null;
  const base = (origin ?? '').trim().replace(/\/+$/, '');
  return `${base}/join/${encodeURIComponent(trimmed)}`;
}

// ---------------------------------------------------------------------------
// Reply normalization (a malformed body is never an empty list)
// ---------------------------------------------------------------------------

export interface InstructorStudent {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly is_offline: boolean | null;
  readonly approval_status: string | null;
  readonly is_active: boolean | null;
  readonly created_at: string | null;
  readonly grade_name: string | null;
  readonly group_name: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const booleanOrNull = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

/** `null` means the body was not an array at all (a malformed reply). Rows
 *  without a usable id are dropped because they cannot be keyed or acted on —
 *  the rest of the server array is preserved, never replaced by an invented
 *  empty list. */
export function normalizeStudents(rows: unknown): InstructorStudent[] | null {
  if (!Array.isArray(rows)) return null;
  const students: InstructorStudent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    students.push({
      id,
      name: typeof row.name === 'string' ? row.name : '',
      phone: stringOrNull(row.phone),
      is_offline: booleanOrNull(row.is_offline),
      approval_status: stringOrNull(row.approval_status),
      is_active: booleanOrNull(row.is_active),
      created_at: stringOrNull(row.created_at),
      grade_name: stringOrNull(row.grade_name),
      group_name: stringOrNull(row.group_name),
    });
  }
  return students;
}

/** Same rule for the three record lists the page reads. */
export function normalizeRecords<T extends { id: string }>(rows: unknown): T[] | null {
  if (!Array.isArray(rows)) return null;
  return rows.filter(
    (row): row is T => isRecord(row) && typeof row.id === 'string' && row.id.trim() !== ''
  );
}

// ---------------------------------------------------------------------------
// M2-18 — the bounded active-branch catalog
// ---------------------------------------------------------------------------

/**
 * The hard bound on the selector. It is BOTH the page size the page asks the
 * server for and the ceiling the normalizer enforces, so a body that ignores
 * the requested limit can never grow the selector past it.
 */
export const STUDENT_BRANCH_CATALOG_LIMIT = 25;

/** A server-generated UUID. Mirrors the server's own selector rule so an
 *  obviously malformed choice never reaches the transport. */
const STUDENT_BRANCH_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isStudentBranchId(value: unknown): value is string {
  return typeof value === 'string' && STUDENT_BRANCH_ID_PATTERN.test(value);
}

export interface InstructorBranch {
  readonly id: string;
  readonly name: string;
  readonly status: TenantBranchStatus;
}

export interface BranchCatalog {
  /** Only ACTIVE branches: an archived branch is not a selectable target. */
  readonly branches: InstructorBranch[];
  /** The server declared another page, so this is NOT the whole catalog. */
  readonly hasMore: boolean;
}

/**
 * Reads the `GET /tenants/me/branches` envelope. `null` means the body was not
 * the documented envelope at all — never an empty catalog. Rows without a
 * usable id are dropped, non-active rows are dropped (they are not selectable),
 * and the list is capped at `STUDENT_BRANCH_CATALOG_LIMIT` so the selector
 * stays bounded no matter what the body contains.
 */
export function normalizeBranchCatalog(payload: unknown): BranchCatalog | null {
  if (!isRecord(payload)) return null;
  const rows = payload.branches;
  if (!Array.isArray(rows)) return null;
  const branches: InstructorBranch[] = [];
  for (const row of rows) {
    if (branches.length >= STUDENT_BRANCH_CATALOG_LIMIT) break;
    if (!isRecord(row)) continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    if (row.status !== 'active') continue;
    branches.push({
      id,
      name: typeof row.name === 'string' ? row.name : '',
      status: 'active',
    });
  }
  return { branches, hasMore: payload.next_cursor !== null && payload.next_cursor !== undefined };
}

/**
 * Validates the server's three-field projection against the operation that was
 * actually sent. A reply naming a DIFFERENT student or a DIFFERENT branch is a
 * stale or foreign reply, so it is refused instead of being published as this
 * operation's success. `null` means the body was not the documented projection.
 */
export function readStudentBranchAssignment(
  payload: unknown,
  studentId: string,
  branchId: string | null
): StudentBranchAssignment | null {
  if (!isRecord(payload)) return null;
  const student = payload.student;
  if (!isRecord(student)) return null;
  if (typeof student.student_id !== 'string' || student.student_id !== studentId) return null;
  if (student.branch_id !== branchId) return null;
  if (branchId === null) {
    // Clearing: the name must be null exactly when there is no branch.
    if (student.branch_name !== null && student.branch_name !== undefined) return null;
    return { student_id: studentId, branch_id: null, branch_name: null };
  }
  if (typeof student.branch_name !== 'string') return null;
  return { student_id: studentId, branch_id: branchId, branch_name: student.branch_name };
}

/** A DECIMAL column arrives as a string; anything that is not a finite number
 *  is "unknown", never zero. */
export function readWalletBalance(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const raw = payload.balance;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type EnrollmentReadPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type EnrollmentBusyKind =
  | 'add'
  | 'decision'
  | 'invite'
  | 'copy'
  | 'reset'
  | 'suspend'
  | 'branch';

export interface EnrollmentBusyEntry {
  readonly kind: EnrollmentBusyKind;
  readonly targetId: string | null;
}

export type AddStudentOutcome =
  | 'created'
  /** Confirmed by the server, but the instructor edited the form while the
   *  request was in flight: the newer input is preserved, nothing is cleared. */
  | 'created-edited'
  /** Confirmed, but the form was already closed or replaced: no newer form is
   *  touched. */
  | 'created-closed'
  | 'duplicate'
  | 'invalid'
  | 'rejected'
  | 'blocked'
  | 'failed';

export type DecisionOutcome =
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'duplicate'
  | 'invalid'
  | 'blocked'
  | 'failed';

export type InviteOutcome = 'rotated' | 'rotated-not-copied' | 'duplicate' | 'blocked' | 'failed';
/** `superseded` = the copy finished, but the link it copied was replaced by a
 *  newer rotation meanwhile, so it says nothing about the CURRENT link. */
export type CopyOutcome = 'copied' | 'unavailable' | 'duplicate' | 'blocked' | 'superseded';
export type ResetOutcome =
  | 'issued'
  | 'issued-not-copied'
  | 'stale'
  | 'duplicate'
  | 'blocked'
  | 'failed';
export type SuspendOutcome = 'suspended' | 'duplicate' | 'invalid' | 'blocked' | 'failed';

/**
 * M2-18 — `assigned`/`cleared` are only returned after the server's own
 * projection named the SAME student and the SAME branch. `not-found` and
 * `denied` clear the draft, because the target or the authority is gone;
 * `conflict` and `failed` keep it so the same save can be retried on purpose.
 */
export type BranchOutcome =
  | 'assigned'
  | 'cleared'
  | 'duplicate'
  | 'denied'
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'blocked'
  | 'failed';

/** The one-time code the instructor must deliver manually. It never leaves
 *  this state object except to the page's existing manual delivery path, is
 *  never logged, and is cleared on every session transition. */
export interface InstructorResetCode {
  readonly requestId: string;
  readonly token: string;
  readonly expiresInMinutes: number;
  readonly copied: boolean;
}

export interface InstructorStudentsState {
  scopeId: string;
  studentsPhase: EnrollmentReadPhase;
  students: InstructorStudent[];
  studentsError: string | null;
  walletPhase: EnrollmentReadPhase;
  /** `null` means "not confirmed by the server" — never a zero balance. */
  walletBalance: number | null;
  walletError: string | null;
  groupsPhase: EnrollmentReadPhase;
  groups: Group[];
  groupsError: string | null;
  requestsPhase: EnrollmentReadPhase;
  requests: EnrollmentRequest[];
  requestsError: string | null;
  resetsPhase: EnrollmentReadPhase;
  resetRequests: StudentPasswordResetRequest[];
  resetsError: string | null;
  violationsPhase: EnrollmentReadPhase;
  violations: VideoSecurityViolation[];
  violationsError: string | null;
  /** M2-18 — the bounded ACTIVE branch catalog, read as its own section. */
  branchesPhase: EnrollmentReadPhase;
  branches: InstructorBranch[];
  branchesError: string | null;
  /** The server declared another page, so the catalog shown is not complete. */
  branchesHasMore: boolean;
  /** The branch the instructor picked for the pending save, and its student. */
  branchDraftStudentId: string | null;
  branchDraftId: string | null;
  branchError: string | null;
  /** Server-confirmed assignments, keyed by student id. The server's own
   *  projection is the only source: nothing here is inferred locally. */
  branchAssignments: Record<string, StudentBranchAssignment>;
  /** Every operation currently in flight, each owned by its own ticket. */
  busy: readonly EnrollmentBusyEntry[];
  fieldErrors: StudentFieldErrors;
  addError: string | null;
  decisionError: string | null;
  /** Retained across a failure so the same target can be retried on purpose. */
  decisionTargetId: string | null;
  inviteUrl: string | null;
  /** `null` = no copy attempted, `true` = the browser confirmed the write,
   *  `false` = the clipboard is unavailable or refused. */
  inviteCopied: boolean | null;
  inviteError: string | null;
  resetCode: InstructorResetCode | null;
  resetActionError: string | null;
  securityError: string | null;
  securityTargetId: string | null;
  createdStudentId: string | null;
}

export interface InstructorStudentsApi {
  loadStudents: (instructorId: string) => Promise<unknown>;
  loadWallet: (instructorId: string) => Promise<unknown>;
  loadGroups: () => Promise<unknown>;
  loadRequests: () => Promise<unknown>;
  loadResetRequests: () => Promise<unknown>;
  loadViolations: () => Promise<unknown>;
  /** M2-18 — one bounded page of the caller's ACTIVE tenant branches. */
  loadBranches: () => Promise<unknown>;
  createStudent: (payload: Partial<Student>) => Promise<unknown>;
  /** Revokes every previous invite — single-flight by contract. */
  rotateInvite: () => Promise<{ id?: unknown; token?: unknown; expires_in_days?: unknown }>;
  approveRequest: (id: string) => Promise<unknown>;
  rejectRequest: (id: string, reason: string) => Promise<unknown>;
  approvePasswordReset: (id: string) => Promise<unknown>;
  suspendStudent: (studentUserId: string, minutes: number, reason: string) => Promise<unknown>;
  /** M2-18 — assign (`branchId` a UUID) or clear (`branchId` null). */
  assignStudentBranch: (studentId: string, branchId: string | null) => Promise<unknown>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
  readOrigin?: () => string;
  clipboard?: { writeText: (text: string) => Promise<void> } | null;
}

export interface InstructorStudentsController {
  getState(): InstructorStudentsState;
  subscribe(listener: (state: InstructorStudentsState) => void): () => void;
  /** Reads all six sections independently. A failing section never clears the
   *  others and never becomes an empty list. */
  loadAll(instructorId?: string): Promise<void>;
  loadStudents(instructorId?: string): Promise<void>;
  loadWallet(instructorId?: string): Promise<void>;
  loadGroups(): Promise<void>;
  loadRequests(): Promise<void>;
  loadResetRequests(): Promise<void>;
  loadViolations(): Promise<void>;
  /** M2-18 — reads the bounded active-branch catalog as its own section. */
  loadBranches(): Promise<void>;
  /** Opens a page-owned form incarnation. */
  openForm(): number;
  closeForm(): void;
  isFormCurrent(instance: number): boolean;
  /** Bumps the form revision: an edit during an in-flight submit keeps the
   *  newer input instead of letting the reply clear it. */
  noteFormEdit(): void;
  formRevision(): number;
  submitStudent(values: StudentFormValues, instance?: number): Promise<AddStudentOutcome>;
  decideRequest(requestId: string, accept: boolean, reason?: string): Promise<DecisionOutcome>;
  rotateInvite(): Promise<InviteOutcome>;
  /** Deliberate copy retry for the CURRENT link. Never rotates. */
  copyInviteLink(): Promise<CopyOutcome>;
  approveReset(requestId: string): Promise<ResetOutcome>;
  clearResetCode(): void;
  suspendStudent(
    violation: VideoSecurityViolation,
    minutes: string | number,
    reason: string
  ): Promise<SuspendOutcome>;
  /** M2-18 — sets the pending save target without sending anything. */
  selectBranch(studentId: string, branchId: string | null): void;
  /** Drops the pending save target (cancel, or after a denial/not-found). */
  clearBranchDraft(): void;
  /** M2-18 — the explicit save. Assigns when `branchId` is a UUID, clears
   *  when it is `null`. */
  assignBranch(studentId: string, branchId: string | null): Promise<BranchOutcome>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const initialState: InstructorStudentsState = {
  scopeId: '',
  studentsPhase: 'idle',
  students: [],
  studentsError: null,
  walletPhase: 'idle',
  walletBalance: null,
  walletError: null,
  groupsPhase: 'idle',
  groups: [],
  groupsError: null,
  requestsPhase: 'idle',
  requests: [],
  requestsError: null,
  resetsPhase: 'idle',
  resetRequests: [],
  resetsError: null,
  violationsPhase: 'idle',
  violations: [],
  violationsError: null,
  branchesPhase: 'idle',
  branches: [],
  branchesError: null,
  branchesHasMore: false,
  branchDraftStudentId: null,
  branchDraftId: null,
  branchError: null,
  branchAssignments: {},
  busy: [],
  fieldErrors: {},
  addError: null,
  decisionError: null,
  decisionTargetId: null,
  inviteUrl: null,
  inviteCopied: null,
  inviteError: null,
  resetCode: null,
  resetActionError: null,
  securityError: null,
  securityTargetId: null,
  createdStudentId: null,
};

/** True when an operation of this kind is in flight (page: disable the
 *  action). */
export function hasBusy(state: InstructorStudentsState, kind: EnrollmentBusyKind): boolean {
  return state.busy.some((entry) => entry.kind === kind);
}

/** True when an operation of this kind is in flight FOR this target. */
export function hasBusyTarget(
  state: InstructorStudentsState,
  kind: EnrollmentBusyKind,
  targetId: string
): boolean {
  return state.busy.some((entry) => entry.kind === kind && entry.targetId === targetId);
}

// ---------------------------------------------------------------------------
// Minimal internal primitives (no cross-feature dependency)
// ---------------------------------------------------------------------------

interface TicketSource {
  next(): number;
}

interface OperationGuard {
  acquire(): boolean;
  holder(): number;
  release(token?: number): void;
}

/**
 * Everything a mutation captured BEFORE its first await, re-validated after
 * every one of them. `scopeIncarnation` is what makes a scope a LIFETIME
 * rather than an id: A → B → A is a new scope, so an operation started under
 * the first A can never be revived by returning to the same instructor id.
 */
interface OperationBinding {
  readonly principal: string | null;
  readonly scope: string;
  readonly scopeIncarnation: number;
}

interface Sequence {
  next(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

const createTicketSource = (): TicketSource => {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
  };
};

/** A latch acquired BEFORE the first await, so a same-tick duplicate click
 *  never reaches the transport. `release(token)` frees it only for its owner. */
const createOperationGuard = (tickets: TicketSource): OperationGuard => {
  let owner = 0;
  return {
    acquire: () => {
      if (owner !== 0) return false;
      owner = tickets.next();
      return true;
    },
    holder: () => owner,
    release: (token?: number) => {
      if (token === undefined || token === owner) owner = 0;
    },
  };
};

/** Monotonic generation for stale-reply invalidation. */
const createSequence = (): Sequence => {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (token: number) => token === latest,
    invalidate: () => {
      latest += 1;
    },
  };
};

type ListSection = 'students' | 'groups' | 'requests' | 'resets' | 'violations';

export function createInstructorStudentsController(
  api: InstructorStudentsApi
): InstructorStudentsController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: InstructorStudentsState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();

  const studentsSequence = createSequence();
  const walletSequence = createSequence();
  const groupsSequence = createSequence();
  const requestsSequence = createSequence();
  const resetsSequence = createSequence();
  const violationsSequence = createSequence();
  const branchesSequence = createSequence();

  const addGuard = createOperationGuard(tickets);
  const decisionGuard = createOperationGuard(tickets);
  const inviteGuard = createOperationGuard(tickets);
  const copyGuard = createOperationGuard(tickets);
  const resetGuard = createOperationGuard(tickets);
  const suspendGuard = createOperationGuard(tickets);
  const branchGuard = createOperationGuard(tickets);

  /** ticket -> entry. An operation may only delete its OWN entry. */
  const operations = new Map<number, EnrollmentBusyEntry>();
  /** Incarnation of the OPEN add-student form (page-owned values). */
  let formTicket = 0;
  let formEdits = 0;
  /** The principal this controller last OBSERVED — the adoption fence. A
   *  replacement the page never announced still retires everything cached. */
  let observedPrincipal: string | null = null;
  let principalObserved = false;
  /** Incarnation of the CURRENT confirmed invite link. A copy that started on
   *  an older link can never certify the newer one. */
  let inviteLink = 0;
  /** Monotonic lifetime of the CURRENT instructor scope. Every scope change
   *  advances it, so an older operation cannot be revived by returning to a
   *  previously seen instructor id (A → B → A). */
  let scopeIncarnation = 0;

  const patch = (changes: Partial<InstructorStudentsState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);

  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation as Promise<unknown>);
    void operation.then(
      () => pending.delete(operation as Promise<unknown>),
      () => pending.delete(operation as Promise<unknown>)
    );
    return operation;
  };

  const beginOperation = (ticket: number, entry: EnrollmentBusyEntry): void => {
    operations.set(ticket, entry);
    patch({ busy: [...operations.values()] });
  };

  const endOperation = (ticket: number): void => {
    if (operations.delete(ticket)) patch({ busy: [...operations.values()] });
  };

  const isCurrent = (sequence: Sequence, generation: number, principal: string | null): boolean => {
    if (disposed || !sequence.isCurrent(generation)) return false;
    // Observing here is deliberate: an unannounced principal replacement is
    // ADOPTED (and everything cached is retired) before any commit, so a reply
    // that belongs to the previous session can never be shown as this one's.
    return observePrincipal() === principal;
  };

  /** Captured before a mutation's first await: identity, scope id AND the
   *  scope's monotonic lifetime. */
  const bindOperation = (): OperationBinding => ({
    principal: observePrincipal(),
    scope: state.scopeId,
    scopeIncarnation,
  });

  /** Re-validated AFTER every awaited step and before any page effect: a
   *  confirmed write must never be published into a different session, a
   *  different instructor scope — including a RETURN to an earlier instructor
   *  id — or a disposed controller. */
  const stillBound = (binding: OperationBinding): boolean => {
    if (disposed) return false;
    if (binding.scopeIncarnation !== scopeIncarnation) return false;
    if (observePrincipal() !== binding.principal) return false;
    return state.scopeId === binding.scope;
  };

  /** Retires the previous scope's in-flight operations synchronously: every
   *  latch is released and every busy entry is dropped, so the NEW scope is
   *  never blocked by transport it does not own. An older `finally` can only
   *  remove its OWN ticket, so it can never release or clear a newer one. */
  const retireScopeOperations = (): void => {
    addGuard.release();
    decisionGuard.release();
    inviteGuard.release();
    copyGuard.release();
    resetGuard.release();
    suspendGuard.release();
    branchGuard.release();
    operations.clear();
    patch({ busy: [] });
  };

  const isFormCurrent = (instance: number): boolean =>
    !disposed && instance !== 0 && instance === formTicket;

  // -------------------------------------------------------------------------
  // Section state helpers
  // -------------------------------------------------------------------------

  const confirmedRows = (section: ListSection): readonly unknown[] => {
    switch (section) {
      case 'students':
        return state.students;
      case 'groups':
        return state.groups;
      case 'requests':
        return state.requests;
      case 'resets':
        return state.resetRequests;
      case 'violations':
        return state.violations;
    }
  };

  /** Loading is only shown when nothing is confirmed: reloading beside
   *  confirmed rows must not blank the section. */
  const beginSection = (section: ListSection): void => {
    const hasRows = confirmedRows(section).length > 0;
    switch (section) {
      case 'students':
        patch(hasRows ? { studentsError: null } : { studentsPhase: 'loading', studentsError: null });
        return;
      case 'groups':
        patch(hasRows ? { groupsError: null } : { groupsPhase: 'loading', groupsError: null });
        return;
      case 'requests':
        patch(hasRows ? { requestsError: null } : { requestsPhase: 'loading', requestsError: null });
        return;
      case 'resets':
        patch(hasRows ? { resetsError: null } : { resetsPhase: 'loading', resetsError: null });
        return;
      case 'violations':
        patch(hasRows ? { violationsError: null } : { violationsPhase: 'loading', violationsError: null });
        return;
    }
  };

  /** A failure keeps the last confirmed rows and reports the error beside
   *  them; only a section with nothing confirmed becomes a full error state. */
  const failSection = (section: ListSection, message: string): void => {
    const hasRows = confirmedRows(section).length > 0;
    switch (section) {
      case 'students':
        patch(hasRows ? { studentsError: message } : { studentsPhase: 'error', studentsError: message });
        return;
      case 'groups':
        patch(hasRows ? { groupsError: message } : { groupsPhase: 'error', groupsError: message });
        return;
      case 'requests':
        patch(hasRows ? { requestsError: message } : { requestsPhase: 'error', requestsError: message });
        return;
      case 'resets':
        patch(hasRows ? { resetsError: message } : { resetsPhase: 'error', resetsError: message });
        return;
      case 'violations':
        patch(hasRows ? { violationsError: message } : { violationsPhase: 'error', violationsError: message });
        return;
    }
  };

  const commitSection = (section: ListSection, rows: readonly unknown[]): void => {
    const phase: EnrollmentReadPhase = rows.length > 0 ? 'ready' : 'empty';
    switch (section) {
      case 'students':
        patch({ students: rows as InstructorStudent[], studentsPhase: phase, studentsError: null });
        return;
      case 'groups':
        patch({ groups: rows as Group[], groupsPhase: phase, groupsError: null });
        return;
      case 'requests':
        patch({ requests: rows as EnrollmentRequest[], requestsPhase: phase, requestsError: null });
        return;
      case 'resets':
        patch({
          resetRequests: rows as StudentPasswordResetRequest[],
          resetsPhase: phase,
          resetsError: null,
        });
        return;
      case 'violations':
        patch({
          violations: rows as VideoSecurityViolation[],
          violationsPhase: phase,
          violationsError: null,
        });
        return;
    }
  };

  const runSectionRead = async (
    section: ListSection,
    sequence: Sequence,
    load: () => Promise<unknown>,
    normalize: (rows: unknown) => unknown[] | null
  ): Promise<void> => {
    if (disposed) return;
    // Adopt an observed identity FIRST: a retirement invalidates every read
    // generation, so taking the generation afterwards keeps this read live.
    const principal = observePrincipal();
    const generation = sequence.next();
    beginSection(section);
    try {
      const body = await load();
      if (!isCurrent(sequence, generation, principal)) return;
      const rows = normalize(body);
      if (rows === null) {
        failSection(section, MALFORMED_LIST_MESSAGE);
        return;
      }
      commitSection(section, rows);
    } catch (cause) {
      if (!isCurrent(sequence, generation, principal)) return;
      failSection(section, classifyEnrollmentFailure(cause).message);
    }
  };

  const runWalletRead = async (instructorId: string): Promise<void> => {
    if (disposed) return;
    const principal = observePrincipal();
    const generation = walletSequence.next();
    const confirmed = state.walletBalance !== null;
    patch(confirmed ? { walletError: null } : { walletPhase: 'loading', walletError: null });
    try {
      const body = await api.loadWallet(instructorId);
      if (!isCurrent(walletSequence, generation, principal)) return;
      const balance = readWalletBalance(body);
      if (balance === null) {
        patch(
          state.walletBalance !== null
            ? { walletError: MALFORMED_WALLET_MESSAGE }
            : { walletPhase: 'error', walletError: MALFORMED_WALLET_MESSAGE }
        );
        return;
      }
      patch({ walletBalance: balance, walletPhase: 'ready', walletError: null });
    } catch (cause) {
      if (!isCurrent(walletSequence, generation, principal)) return;
      const message = classifyEnrollmentFailure(cause).message;
      patch(
        state.walletBalance !== null
          ? { walletError: message }
          : { walletPhase: 'error', walletError: message }
      );
    }
  };

  const scopeOrState = (instructorId?: string): string =>
    (instructorId ?? state.scopeId ?? '').trim();

  /** A different instructor id must not inherit the previous instructor's
   *  confirmed rows or private outputs — and its in-flight operations are
   *  retired, because they belong to a scope that no longer exists. */
  const adoptScope = (instructorId: string): void => {
    if (!instructorId || instructorId === state.scopeId) return;
    // A reply that belongs to the previous scope must not commit into the new
    // one, so every in-flight read generation is retired BEFORE the rows are
    // cleared (the caller starts the new reads afterwards).
    studentsSequence.invalidate();
    walletSequence.invalidate();
    groupsSequence.invalidate();
    requestsSequence.invalidate();
    resetsSequence.invalidate();
    violationsSequence.invalidate();
    branchesSequence.invalidate();
    // The scope is a NEW lifetime, even when the id equals one seen earlier:
    // an older mutation can never be revived by an A → B → A return.
    scopeIncarnation += 1;
    retireScopeOperations();
    // A link belonging to the previous instructor/scope is retired here, so a
    // copy still in flight for it cannot certify anything.
    inviteLink += 1;
    patch({
      scopeId: instructorId,
      studentsPhase: 'idle',
      students: [],
      studentsError: null,
      walletPhase: 'idle',
      walletBalance: null,
      walletError: null,
      groupsPhase: 'idle',
      groups: [],
      groupsError: null,
      requestsPhase: 'idle',
      requests: [],
      requestsError: null,
      resetsPhase: 'idle',
      resetRequests: [],
      resetsError: null,
      violationsPhase: 'idle',
      violations: [],
      violationsError: null,
      branchesPhase: 'idle',
      branches: [],
      branchesError: null,
      branchesHasMore: false,
      branchDraftStudentId: null,
      branchDraftId: null,
      branchError: null,
      branchAssignments: {},
      decisionTargetId: null,
      inviteUrl: null,
      inviteCopied: null,
      resetCode: null,
      securityTargetId: null,
      createdStudentId: null,
    });
  };

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const runStudentsRead = async (instructorId: string): Promise<void> => {
    if (!instructorId) return;
    await runSectionRead('students', studentsSequence, () => api.loadStudents(instructorId), normalizeStudents);
  };

  const runGroupsRead = (): Promise<void> =>
    runSectionRead('groups', groupsSequence, () => api.loadGroups(), (rows) =>
      normalizeRecords<Group>(rows)
    );

  const runRequestsRead = (): Promise<void> =>
    runSectionRead('requests', requestsSequence, () => api.loadRequests(), (rows) =>
      normalizeRecords<EnrollmentRequest>(rows)
    );

  const runResetsRead = (): Promise<void> =>
    runSectionRead('resets', resetsSequence, () => api.loadResetRequests(), (rows) =>
      normalizeRecords<StudentPasswordResetRequest>(rows)
    );

  const runViolationsRead = (): Promise<void> =>
    runSectionRead('violations', violationsSequence, () => api.loadViolations(), (rows) =>
      normalizeRecords<VideoSecurityViolation>(rows)
    );

  /** M2-18 — the bounded active-branch catalog, read as its own section. A
   *  malformed envelope is reported beside any confirmed rows, never turned
   *  into an empty catalog; `hasMore` is preserved so the page can show the
   *  catalog is not complete. */
  const runBranchesRead = async (): Promise<void> => {
    if (disposed) return;
    const principal = observePrincipal();
    const generation = branchesSequence.next();
    const confirmed = state.branches.length > 0;
    patch(confirmed ? { branchesError: null } : { branchesPhase: 'loading', branchesError: null });
    try {
      const body = await api.loadBranches();
      if (!isCurrent(branchesSequence, generation, principal)) return;
      const catalog = normalizeBranchCatalog(body);
      if (catalog === null) {
        patch(
          state.branches.length > 0
            ? { branchesError: MALFORMED_LIST_MESSAGE }
            : { branchesPhase: 'error', branchesError: MALFORMED_LIST_MESSAGE }
        );
        return;
      }
      const phase: EnrollmentReadPhase = catalog.branches.length > 0 ? 'ready' : 'empty';
      patch({
        branches: catalog.branches,
        branchesPhase: phase,
        branchesError: null,
        branchesHasMore: catalog.hasMore,
      });
    } catch (cause) {
      if (!isCurrent(branchesSequence, generation, principal)) return;
      const message = classifyStudentBranchFailure(cause).message;
      patch(
        state.branches.length > 0
          ? { branchesError: message }
          : { branchesPhase: 'error', branchesError: message }
      );
    }
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Discards everything in flight, every latch it holds and every private
   *  output, without touching the server. */
  const retireInFlight = (): void => {
    studentsSequence.invalidate();
    walletSequence.invalidate();
    groupsSequence.invalidate();
    requestsSequence.invalidate();
    resetsSequence.invalidate();
    violationsSequence.invalidate();
    branchesSequence.invalidate();
    addGuard.release();
    decisionGuard.release();
    inviteGuard.release();
    copyGuard.release();
    resetGuard.release();
    suspendGuard.release();
    operations.clear();
    // A session retirement also ends the scope lifetime, so no operation that
    // began under the previous identity can be validated by a later scope.
    scopeIncarnation += 1;
    formTicket = tickets.next();
    formEdits = 0;
    // The retired link can never be certified by a copy that was already
    // running when it was retired.
    inviteLink += 1;
    patch({
      busy: [],
      decisionTargetId: null,
      inviteUrl: null,
      inviteCopied: null,
      resetCode: null,
      securityTargetId: null,
    });
  };

  const applySessionChange = (): void => {
    if (disposed) return;
    // The caller observed the new identity: record it so the same change is
    // not retired twice.
    principalObserved = true;
    observedPrincipal = readPrincipal();
    retireInFlight();
    patch({
      scopeId: '',
      studentsPhase: 'idle',
      students: [],
      studentsError: null,
      walletPhase: 'idle',
      walletBalance: null,
      walletError: null,
      groupsPhase: 'idle',
      groups: [],
      groupsError: null,
      requestsPhase: 'idle',
      requests: [],
      requestsError: null,
      resetsPhase: 'idle',
      resetRequests: [],
      resetsError: null,
      violationsPhase: 'idle',
      violations: [],
      violationsError: null,
      branchesPhase: 'idle',
      branches: [],
      branchesError: null,
      branchesHasMore: false,
      branchDraftStudentId: null,
      branchDraftId: null,
      branchError: null,
      branchAssignments: {},
      addError: null,
      decisionError: null,
      inviteError: null,
      resetActionError: null,
      securityError: null,
      fieldErrors: {},
      createdStudentId: null,
    });
  };

  /**
   * The single adoption point for identity. Every operation entry, every
   * post-await commit and every read commit reads the live principal through
   * here, so a replacement the page never announced (no session event) is
   * retired exactly like an announced one: in-flight work is invalidated, old
   * confirmed rows are dropped and every private output is cleared before the
   * caller can commit under the wrong identity. Consecutive unchanged reads are
   * stable, and A→B→A is two incarnations, so a return to a previous token is a
   * NEW session rather than a silent revival of its old rows.
   */
  const observePrincipal = (): string | null => {
    const current = readPrincipal();
    if (disposed) return current;
    if (!principalObserved) {
      principalObserved = true;
      observedPrincipal = current;
      return current;
    }
    if (current !== observedPrincipal) applySessionChange();
    return current;
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => applySessionChange())
    : null;

  // -------------------------------------------------------------------------
  // Clipboard (honest by construction: absence or refusal is `false`)
  // -------------------------------------------------------------------------

  const writeClipboard = async (text: string): Promise<boolean> => {
    const clipboard = api.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  const submitStudent = async (
    values: StudentFormValues,
    instance?: number
  ): Promise<AddStudentOutcome> => {
    if (disposed) return 'blocked';
    // Adopt an observed identity before anything else: a replacement the page
    // never announced retires the form this submit was typed in.
    const binding = bindOperation();
    const form = instance ?? formTicket;
    if (!isFormCurrent(form)) return 'blocked';
    const validation = validateStudentForm(values);
    if (!validation.ok) {
      patch({ fieldErrors: validation.fieldErrors, addError: null });
      return 'invalid';
    }
    // Synchronous: a same-tick double submit never reaches the transport.
    if (!addGuard.acquire()) return 'duplicate';
    const ticket = addGuard.holder();
    const revision = formEdits;
    beginOperation(ticket, { kind: 'add', targetId: null });
    patch({ addError: null, fieldErrors: {} });
    try {
      const created = await api.createStudent(buildStudentPayload(values));
      if (!stillBound(binding)) return 'blocked';
      const createdId = isRecord(created) && typeof created.id === 'string' ? created.id : null;
      patch({ createdStudentId: createdId });
      // The re-read is a SEPARATE operation: its failure is reported in the
      // list section and never turns this confirmed create into a failure.
      await runStudentsRead(binding.scope);
      // A session/scope replacement during that refresh must not publish this
      // confirmed create as the new session's success.
      if (!stillBound(binding)) return 'blocked';
      if (!isFormCurrent(form)) return 'created-closed';
      if (formEdits !== revision) return 'created-edited';
      return 'created';
    } catch (cause) {
      if (!stillBound(binding)) return 'blocked';
      const failure = classifyEnrollmentFailure(cause);
      patch({ addError: failure.message });
      if (failure.kind === 'duplicate') return 'duplicate';
      if (failure.kind === 'denied') return 'rejected';
      if (failure.kind === 'invalid') return 'invalid';
      return 'failed';
    } finally {
      endOperation(ticket);
      addGuard.release(ticket);
    }
  };

  const decideRequest = async (
    requestId: string,
    accept: boolean,
    reason?: string
  ): Promise<DecisionOutcome> => {
    if (disposed) return 'blocked';
    const id = (requestId ?? '').trim();
    if (!id) return 'invalid';
    const trimmedReason = (reason ?? '').trim();
    // The server requires at least 3 characters (student-enrollment.ts:255).
    if (!accept && trimmedReason.length < 3) return 'invalid';
    const binding = bindOperation();
    if (!decisionGuard.acquire()) return 'duplicate';
    const ticket = decisionGuard.holder();
    beginOperation(ticket, { kind: 'decision', targetId: id });
    patch({ decisionError: null, decisionTargetId: id });
    try {
      if (accept) await api.approveRequest(id);
      else await api.rejectRequest(id, trimmedReason);
      if (!stillBound(binding)) return 'blocked';
      // Server-confirmed: the row is no longer pending. Drop it locally, then
      // re-read for authority; a failed re-read keeps the confirmed removal.
      patch({
        requests: state.requests.filter((request) => request.id !== id),
        decisionTargetId: null,
      });
      await runRequestsRead();
      // The refresh is an await: if the session, scope or controller changed
      // meanwhile, the page must not receive this session's success.
      if (!stillBound(binding)) return 'blocked';
      return accept ? 'approved' : 'rejected';
    } catch (cause) {
      if (!stillBound(binding)) return 'blocked';
      const failure = classifyEnrollmentFailure(cause);
      patch({ decisionError: failure.message });
      if (failure.kind === 'stale') {
        // Already decided elsewhere: the pending row is gone, so it is
        // refreshed instead of being retried as a new decision.
        patch({ decisionTargetId: null });
        await runRequestsRead();
        if (!stillBound(binding)) return 'blocked';
        return 'stale';
      }
      // The target stays set so the SAME request can be retried on purpose.
      if (failure.kind === 'duplicate') return 'duplicate';
      return 'failed';
    } finally {
      endOperation(ticket);
      decisionGuard.release(ticket);
    }
  };

  const rotateInvite = async (): Promise<InviteOutcome> => {
    if (disposed) return 'blocked';
    const binding = bindOperation();
    // Rotation revokes the previous link: a duplicate click must never
    // invalidate a link the instructor already shared.
    if (!inviteGuard.acquire()) return 'duplicate';
    const ticket = inviteGuard.holder();
    beginOperation(ticket, { kind: 'invite', targetId: null });
    patch({ inviteError: null });
    try {
      const invite = await api.rotateInvite();
      if (!stillBound(binding)) return 'blocked';
      const token = isRecord(invite) && typeof invite.token === 'string' ? invite.token : '';
      const origin = api.readOrigin ? api.readOrigin() : '';
      const url = buildInviteUrl(origin, token);
      if (!url) {
        patch({ inviteError: MALFORMED_LIST_MESSAGE });
        return 'failed';
      }
      // The rotation SUCCEEDED: the link is kept even if the copy fails. The
      // new link is a NEW incarnation, so a copy that started on the previous
      // link can never certify it.
      inviteLink += 1;
      const link = inviteLink;
      patch({ inviteUrl: url, inviteCopied: null });
      const copied = await writeClipboard(url);
      if (!stillBound(binding)) return 'blocked';
      if (link !== inviteLink) return 'blocked';
      patch({ inviteCopied: copied });
      return copied ? 'rotated' : 'rotated-not-copied';
    } catch (cause) {
      if (!stillBound(binding)) return 'blocked';
      // A failed rotation leaves the previous link valid, so it is kept.
      patch({ inviteError: classifyEnrollmentFailure(cause).message });
      return 'failed';
    } finally {
      endOperation(ticket);
      inviteGuard.release(ticket);
    }
  };

  const copyInviteLink = async (): Promise<CopyOutcome> => {
    if (disposed) return 'blocked';
    const binding = bindOperation();
    const url = state.inviteUrl;
    if (!url) return 'unavailable';
    if (!copyGuard.acquire()) return 'duplicate';
    const ticket = copyGuard.holder();
    // The copy belongs to THIS link incarnation only.
    const link = inviteLink;
    beginOperation(ticket, { kind: 'copy', targetId: null });
    try {
      const copied = await writeClipboard(url);
      if (!stillBound(binding)) return 'blocked';
      // An older copy may never certify or overwrite a newer rotated link.
      if (link !== inviteLink || state.inviteUrl !== url) return 'superseded';
      patch({ inviteCopied: copied });
      return copied ? 'copied' : 'unavailable';
    } finally {
      endOperation(ticket);
      copyGuard.release(ticket);
    }
  };

  const approveReset = async (requestId: string): Promise<ResetOutcome> => {
    if (disposed) return 'blocked';
    const id = (requestId ?? '').trim();
    if (!id) return 'failed';
    const binding = bindOperation();
    if (!resetGuard.acquire()) return 'duplicate';
    const ticket = resetGuard.holder();
    beginOperation(ticket, { kind: 'reset', targetId: id });
    patch({ resetActionError: null });
    try {
      const result = await api.approvePasswordReset(id);
      if (!stillBound(binding)) return 'blocked';
      const token = isRecord(result) && typeof result.reset_token === 'string' ? result.reset_token : '';
      if (!token) {
        patch({ resetActionError: MALFORMED_RESET_MESSAGE });
        return 'failed';
      }
      const rawMinutes = isRecord(result) ? Number(result.expires_in_minutes) : Number.NaN;
      const expiresInMinutes = Number.isFinite(rawMinutes) ? rawMinutes : 15;
      patch({
        resetCode: { requestId: id, token, expiresInMinutes, copied: false },
        resetActionError: null,
      });
      const copied = await writeClipboard(token);
      if (!stillBound(binding)) return 'blocked';
      patch({
        resetCode: { requestId: id, token, expiresInMinutes, copied },
      });
      await runResetsRead();
      // The private code is already cleared by any retirement; the page must
      // not be told it was issued for the session it now shows.
      if (!stillBound(binding)) return 'blocked';
      return copied ? 'issued' : 'issued-not-copied';
    } catch (cause) {
      if (!stillBound(binding)) return 'blocked';
      const failure = classifyEnrollmentFailure(cause);
      patch({ resetActionError: failure.message });
      if (failure.kind === 'stale') {
        await runResetsRead();
        if (!stillBound(binding)) return 'blocked';
        return 'stale';
      }
      return 'failed';
    } finally {
      endOperation(ticket);
      resetGuard.release(ticket);
    }
  };

  const suspendStudent = async (
    violation: VideoSecurityViolation,
    minutes: string | number,
    reason: string
  ): Promise<SuspendOutcome> => {
    if (disposed) return 'blocked';
    const studentUserId = (violation?.student_user_id ?? '').trim();
    if (!studentUserId) return 'invalid';
    const parsed = parseSuspensionMinutes(minutes);
    if (parsed.ok === false) {
      patch({
        securityError: describeSuspensionMinutesError(parsed.reason),
        securityTargetId: studentUserId,
      });
      return 'invalid';
    }
    const trimmedReason = (reason ?? '').trim();
    if (!trimmedReason) {
      patch({ securityError: 'سبب التعليق مطلوب.', securityTargetId: studentUserId });
      return 'invalid';
    }
    const binding = bindOperation();
    if (!suspendGuard.acquire()) return 'duplicate';
    const ticket = suspendGuard.holder();
    beginOperation(ticket, { kind: 'suspend', targetId: studentUserId });
    patch({ securityError: null, securityTargetId: studentUserId });
    try {
      await api.suspendStudent(studentUserId, parsed.value, trimmedReason.slice(0, 500));
      if (!stillBound(binding)) return 'blocked';
      patch({ securityTargetId: null });
      await runViolationsRead();
      if (!stillBound(binding)) return 'blocked';
      return 'suspended';
    } catch (cause) {
      if (!stillBound(binding)) return 'blocked';
      patch({ securityError: classifyEnrollmentFailure(cause).message });
      return 'failed';
    } finally {
      endOperation(ticket);
      suspendGuard.release(ticket);
    }
  };

  // -------------------------------------------------------------------------
  // M2-18 — Active-branch assignment (planning metadata only)
  // -------------------------------------------------------------------------

  /** Sets the pending save target WITHOUT sending anything. The page owns the
   *  open form; the controller only stores which (student, branch) pair is
   *  armed. A non-UUID branch id is refused so it can never reach transport. */
  const selectBranch = (studentId: string, branchId: string | null): void => {
    if (disposed) return;
    const id = (studentId ?? '').trim();
    if (!id) return;
    const draftId = branchId === null ? null : isStudentBranchId(branchId) ? branchId.trim() : null;
    if (branchId !== null && draftId === null) return;
    patch({ branchDraftStudentId: id, branchDraftId: draftId, branchError: null });
  };

  /** Drops the pending save target (cancel, or after a denial/not-found). */
  const clearBranchDraft = (): void => {
    if (disposed) return;
    patch({ branchDraftStudentId: null, branchDraftId: null, branchError: null });
  };

  /**
   * The explicit save. Assigns when `branchId` is a UUID, clears when it is
   * `null`. The server's own three-field projection is the ONLY source of truth:
   * a reply naming a different student or a different branch is a stale/foreign
   * reply and is refused (never published under the wrong key). `denied` and
   * `not-found` clear the draft because the authority or the target is gone;
   * `conflict` and the transport `error` keep it so the same save can be retried
   * on purpose. A same-tick duplicate never reaches the transport.
   */
  const assignBranch = async (
    studentId: string,
    branchId: string | null
  ): Promise<BranchOutcome> => {
    if (disposed) return 'blocked';
    const id = (studentId ?? '').trim();
    if (!id) return 'invalid';
    if (branchId !== null && !isStudentBranchId(branchId)) return 'invalid';
    const binding = bindOperation();
    // A same-tick duplicate save never reaches the transport.
    if (!branchGuard.acquire()) return 'duplicate';
    const ticket = branchGuard.holder();
    beginOperation(ticket, { kind: 'branch', targetId: id });
    patch({ branchError: null });
    try {
      const reply = await api.assignStudentBranch(id, branchId);
      if (!stillBound(binding)) return 'blocked';
      // The server is authoritative: a reply naming a different student or a
      // different branch (stale/foreign) is refused, so no cached assignment is
      // published under the wrong key.
      const assignment = readStudentBranchAssignment(reply, id, branchId);
      if (assignment === null) return 'conflict';
      patch({
        branchAssignments: { ...state.branchAssignments, [id]: assignment },
        branchDraftStudentId: null,
        branchDraftId: null,
      });
      return branchId === null ? 'cleared' : 'assigned';
    } catch (cause) {
      if (!stillBound(binding)) return 'blocked';
      const failure = classifyStudentBranchFailure(cause);
      patch({ branchError: failure.message });
      if (failure.kind === 'denied') {
        // The authority is gone: drop the draft so it cannot be retried.
        patch({ branchDraftStudentId: null, branchDraftId: null });
        return 'denied';
      }
      if (failure.kind === 'not-found') {
        patch({ branchDraftStudentId: null, branchDraftId: null });
        return 'not-found';
      }
      if (failure.kind === 'conflict') return 'conflict';
      if (failure.kind === 'invalid') return 'invalid';
      // 'error' (refresh/transport) keeps the draft so the same save can be
      // retried on purpose.
      return 'failed';
    } finally {
      endOperation(ticket);
      branchGuard.release(ticket);
    }
  };

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    loadAll: (instructorId) =>
      track(
        (async () => {
          const scope = scopeOrState(instructorId);
          if (!scope || disposed) return;
          adoptScope(scope);
          await Promise.all([
            runStudentsRead(scope),
            runWalletRead(scope),
            runGroupsRead(),
            runRequestsRead(),
            runResetsRead(),
            runViolationsRead(),
            runBranchesRead(),
          ]);
        })()
      ),

    loadStudents: (instructorId) =>
      track(
        (async () => {
          const scope = scopeOrState(instructorId);
          if (!scope) return;
          adoptScope(scope);
          await runStudentsRead(scope);
        })()
      ),

    loadWallet: (instructorId) =>
      track(
        (async () => {
          const scope = scopeOrState(instructorId);
          if (!scope) return;
          adoptScope(scope);
          await runWalletRead(scope);
        })()
      ),

    loadGroups: () => track(runGroupsRead()),
    loadRequests: () => track(runRequestsRead()),
    loadResetRequests: () => track(runResetsRead()),
    loadViolations: () => track(runViolationsRead()),
    loadBranches: () => track(runBranchesRead()),

    openForm: () => {
      formTicket = tickets.next();
      formEdits = 0;
      patch({ fieldErrors: {}, addError: null });
      return formTicket;
    },

    closeForm: () => {
      formTicket = tickets.next();
      formEdits = 0;
      patch({ fieldErrors: {}, addError: null });
    },

    isFormCurrent,

    noteFormEdit: () => {
      formEdits += 1;
    },

    formRevision: () => formEdits,

    submitStudent: (values, instance) => track(submitStudent(values, instance)),
    decideRequest: (requestId, accept, reason) => track(decideRequest(requestId, accept, reason)),
    rotateInvite: () => track(rotateInvite()),
    copyInviteLink: () => track(copyInviteLink()),
    approveReset: (requestId) => track(approveReset(requestId)),
    clearResetCode: () => patch({ resetCode: null }),
    suspendStudent: (violation, minutes, reason) => track(suspendStudent(violation, minutes, reason)),
    selectBranch,
    clearBranchDraft,
    assignBranch: (studentId, branchId) => track(assignBranch(studentId, branchId)),

    waitForIdle: async () => {
      // Settle everything queued so far, including operations that schedule
      // further work (a write followed by its own re-read).
      for (let round = 0; round < 8 && pending.size > 0; round += 1) {
        await Promise.allSettled([...pending]);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (unsubscribeSession) unsubscribeSession();
      studentsSequence.invalidate();
      walletSequence.invalidate();
      groupsSequence.invalidate();
      requestsSequence.invalidate();
      resetsSequence.invalidate();
      violationsSequence.invalidate();
      branchesSequence.invalidate();
      addGuard.release();
      decisionGuard.release();
      inviteGuard.release();
      copyGuard.release();
      resetGuard.release();
      suspendGuard.release();
      branchGuard.release();
      operations.clear();
      listeners.clear();
    },
  };
}
