/**
 * M2-07 — tenant branch metadata controls on the existing instructor dashboard.
 *
 * The production seam the dashboard mounts through
 * `src/features/tenant/BranchManager.tsx`: this module owns the WHOLE request
 * and form lifecycle (explicit panel open, one bounded 25-row page, next/first
 * paging, create/rename/archive/reactivate, owner-only labelling, runtime DTO
 * validation, uncertain-write handling, stale-reply invalidation, session and
 * disposal fences) and keeps React rendering out of the decision path.
 *
 * The transport, the principal reader and the session notifier are injected,
 * so the exact production code the dashboard runs is exercised hermetically in
 * node:test (src/tests/m2-tenant-branches-ui.test.ts) with no DB, no network,
 * no browser and no live app.
 *
 * Contracts verified from source (docs/streams/server/M2-B03-CONTRACT.md,
 * accepted under supervisor/151):
 *  - `GET /api/tenants/me/branches?limit=25[&cursor=...]` answers
 *    `{ branches: [...], next_cursor: string | null }`; the branch DTO is the
 *    explicit five fields `{ id, name, status, created_at, updated_at }` — the
 *    row is never spread and `tenant_id` is never exposed;
 *  - `POST /api/tenants/me/branches` takes the strict single-field body
 *    `{ name }` (trimmed to 1..255); duplicate names are ALLOWED;
 *  - `PATCH /api/tenants/me/branches/:branchId` takes `{ name }` and/or
 *    `{ status: 'active' | 'archived' }`, and the response id MUST match the
 *    requested branch id;
 *  - the branch routes are owner-only, resolved from server-side rows: a
 *    membership role label never grants access and a membership instructor
 *    gets 403 `Forbidden`;
 *  - the local billing-only guard answers 403 with the branch-specific
 *    `Branch management is not available while the account is limited to
 *    billing and support` (code `BILLING_ONLY`) — the shared transport keeps
 *    its canonical identity event and redirect untouched;
 *  - the documented failures are 400 `Invalid branch payload` /
 *    `Invalid branch update payload` / `Invalid branch id`, 404
 *    `Tenant membership not found` / `Branch not found`, 409
 *    `Branch was modified concurrently`, 500 `Failed to list branches` /
 *    `Failed to create branch` / `Failed to update branch`, plus the
 *    unchanged upstream 401/suspension answers;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify
 *    an outcome — no status is ever fabricated and a discarded code is never
 *    turned into a permission outcome;
 *  - the accepted migration FILE is NOT applied: a real deployment answers
 *    with a truthful error and no client-side fallback data is invented.
 *
 * Lifetimes fenced here:
 *  - page: every list read advances a page generation, so a reversed or
 *    superseded reply can never commit, and only ONE page (at most
 *    TENANT_BRANCH_PAGE_LIMIT rows) is ever held in memory; the RESPONSE is
 *    validated against the same bound BEFORE any row is traversed or copied,
 *    so an oversized page is a malformed response and never a held page;
 *  - request: every mutation advances its own request generation and takes a
 *    synchronous single-flight latch BEFORE the first await, so a double click
 *    or Enter never sends a second write;
 *  - form: opening, cancelling or invalidating a form advances the form
 *    generation, so a late reply never rewrites or closes a newer form;
 *  - authorization: a DEFINITE read authorization or tenant scope loss (an
 *    expired session, a suspension, the billing-only restriction, the
 *    owner-only denial, a missing workspace) clears the private rows, the
 *    form, the draft, the target and the confirmation and retires every
 *    in-flight operation, so an older write or read can never repopulate the
 *    cleared private state. A retryable read failure keeps the private draft,
 *    because no permission loss was proven;
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read and write (through the accepted M2-02 reader
 *    `readCourseSessionPrincipal`), on the SUCCESS and the FAILURE path, and a
 *    RETIRED operation observes it BEFORE it settles any visible state — a
 *    silent logout can never revive the previous principal's rows or drafts;
 *  - close/dispose: the panel clears the private rows, the drafts and the
 *    cursors and drops every in-flight reply.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success;
 *  - a PATCH response for another branch id is NOT a success for this branch;
 *  - a 500/network/malformed write outcome is UNCERTAIN: the write may have
 *    persisted, nothing is retried automatically, the draft is preserved and a
 *    deliberate list read is offered. A matching name in the list is the
 *    CURRENT state — never proof of the earlier write or its audit — and
 *    because duplicate names are allowed a deliberate create retry may create a
 *    duplicate branch;
 *  - a confirmed success uses the validated server DTO only; at most ONE
 *    bounded refresh follows a confirmed create so the page keeps the server's
 *    canonical ordering.
 *
 * Out of scope by construction: no new route, no backend/schema/migration
 * application, no assignment/student/pricing/OTP/payment rule, no shared
 * auth/error/session change, and no branch capability inferred from a local
 * role, profile or status.
 */
import {
  TENANT_BRANCH_PAGE_LIMIT,
  TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT,
  type TenantBranch,
  type TenantBranchEnvelope,
  type TenantBranchListEnvelope,
  type TenantBranchStatus,
  type TenantInstructorMembership,
  type TenantInstructorMembershipEnvelope,
  type TenantInstructorMembershipListEnvelope,
} from '../../lib/api-http';
import { createCourseOperationGuard, createTicketSource } from '../catalog/course-management';

/**
 * The canonical session reader the dashboard uses. Re-exported so the page
 * imports ONE principal boundary: M2-02's reader holds the single canonical
 * localStorage lifetime, and a second parallel lifetime here would let the two
 * panels disagree about what "the same session" means.
 */
export { readCourseSessionPrincipal } from '../catalog/course-management';
export type { CourseSessionStorage } from '../catalog/course-management';

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

/** The page's own wording for a body that is not the documented envelope. The
 *  server never sends this string, so it can never be confused with a server
 *  classification. */
export const MALFORMED_BRANCH_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Local validation wording: the input never reaches the transport. */
export const BRANCH_NAME_INVALID_MESSAGE =
  'اسم الفرع يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات.';

/** Local warning after a reply that may or may not have persisted server-side. */
export const BRANCH_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ بيانات الفرع. قد تكون التغييرات قد حُفظت على الخادم؛ اقرأ القائمة الحالية للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after the deliberate read-only reconciliation. A matching
 *  branch is the CURRENT state, never proof of the previous write or its
 *  audit. */
export const BRANCH_RECONCILED_MESSAGE =
  'تم عرض القائمة الحالية من الخادم. هذا لا يؤكد نجاح محاولة الحفظ السابقة.';

/** Duplicate names are allowed by the accepted contract, so a deliberate
 *  create retry can create a second branch with the same name. */
export const BRANCH_DUPLICATE_CREATE_WARNING =
  'أسماء الفروع مسموح بتكرارها؛ إعادة محاولة الإنشاء قد تنشئ فرعًا مكررًا.';

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

/** No authorized workspace: the handler's 404 and the student-boundary 409.
 *  Both fail closed: no branch rows. */
const NO_WORKSPACE_MESSAGES = new Set<string>([
  'Tenant membership not found',
  'Select an instructor workspace first',
]);

/** The accepted branch-local billing-only denial (M2-B03 contract). The shared
 *  transport already applied its canonical identity event and redirect; the
 *  branch feature only records the denial it can see. */
const BILLING_ONLY_MESSAGE =
  'Branch management is not available while the account is limited to billing and support';

/** The owner-only denial for a membership instructor (M2-B03 contract). */
const FORBIDDEN_MESSAGE = 'Forbidden';

/** The accepted handler 500 wordings. */
const BRANCH_LIST_FAILED_MESSAGE = 'Failed to list branches';
const BRANCH_CREATE_FAILED_MESSAGE = 'Failed to create branch';
const BRANCH_UPDATE_FAILED_MESSAGE = 'Failed to update branch';

/** The accepted write-side 404: the branch is absent (or foreign — the server
 *  answers identically). The server did not write. */
const BRANCH_NOT_FOUND_MESSAGE = 'Branch not found';

/** The accepted concurrent-row outcome: the server rolled back and did not
 *  write, so this is a retryable conflict, not an uncertain write. */
const BRANCH_CONFLICT_MESSAGE = 'Branch was modified concurrently';

/** The handler's strict payload rejections: no connection was taken. */
const BRANCH_INVALID_PAYLOAD_MESSAGE = 'Invalid branch payload';
const BRANCH_INVALID_UPDATE_PAYLOAD_MESSAGE = 'Invalid branch update payload';
const BRANCH_INVALID_ID_MESSAGE = 'Invalid branch id';

// ---------------------------------------------------------------------------
// M2-B12 — instructor branch-assignment vocabulary (documented messages only)
// ---------------------------------------------------------------------------

/** Local wording for a body that is not the documented instructor envelope. */
export const INSTRUCTOR_LIST_MALFORMED_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Local validation wording: the selection never reaches the transport. */
export const INSTRUCTOR_SELECTION_INVALID_MESSAGE =
  'اختر فرعًا نشطًا من القائمة الحالية قبل الحفظ.';

/** Local warning after an assignment reply that may or may not have persisted. */
export const INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ ربط المدرب بالفرع. قد تكون التغييرات قد حُفظت على الخادم؛ اقرأ القائمة الحالية للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after the deliberate read-only reconciliation. A matching
 *  record is the CURRENT state, never proof of the previous write. */
export const INSTRUCTOR_ASSIGNMENT_RECONCILED_MESSAGE =
  'تم عرض القائمة الحالية من الخادم. هذا لا يؤكد نجاح محاولة الحفظ السابقة.';

/** The accepted instructor-membership list/write wordings. */
const INSTRUCTOR_LIST_FAILED_MESSAGE = 'Failed to list instructor memberships';
const INSTRUCTOR_ASSIGN_FAILED_MESSAGE = 'Failed to assign instructor branch';
const INSTRUCTOR_MEMBERSHIP_NOT_FOUND_MESSAGE = 'Instructor membership not found';
const INSTRUCTOR_MEMBERSHIP_CONFLICT_MESSAGE = 'Instructor membership was modified concurrently';
const INSTRUCTOR_INVALID_ID_MESSAGE = 'Invalid membership id';
const INSTRUCTOR_INVALID_PAYLOAD_MESSAGE = 'Invalid instructor branch assignment payload';
const INSTRUCTOR_INVALID_LIMIT_MESSAGE = 'Invalid instructor membership list limit';
const INSTRUCTOR_INVALID_CURSOR_MESSAGE = 'Invalid instructor membership list cursor';

export type TenantBranchPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace';

/** Why an outcome was classified. Every value comes from a documented
 *  transported message; nothing is guessed from a discarded code. */
export type TenantBranchFailureReason =
  | 'session'
  | 'suspended'
  | 'billing-only'
  | 'not-owner'
  | 'no-workspace'
  | 'missing-branch'
  | 'missing-membership'
  | 'conflict'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface TenantBranchFailure {
  readonly phase: TenantBranchPhase;
  readonly reason: TenantBranchFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a LIST read. A
 * permission outcome is never faked from an unrecognized message: it stays a
 * retryable read error with its actual message on screen.
 */
export function classifyTenantBranchFailure(cause: unknown): TenantBranchFailure {
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
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { phase: 'no-workspace', reason: 'no-workspace', message };
  }
  if (message === BRANCH_LIST_FAILED_MESSAGE) {
    return { phase: 'error', reason: 'server', message };
  }
  return {
    phase: 'error',
    reason: 'unknown',
    message: message || 'فشل تحميل قائمة الفروع',
  };
}

export type TenantBranchWriteKind =
  | 'unauthorized'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'missing'
  | 'uncertain';

/**
 * A DEFINITE loss of the list's read authorization or of the tenant scope.
 *
 * Only the documented denial answers qualify: an expired or invalid session,
 * an administratively suspended account, the billing-only restriction, the
 * owner-only denial and a missing workspace. Every one of them is a server
 * statement that this session may no longer read this tenant's branch list,
 * so the private form, the draft, the target and the confirmation must not
 * stay on screen.
 *
 * A retryable read failure does NOT prove a permission loss: the handler 500
 * (`Failed to list branches`), a network error and an unrecognized message
 * keep the private draft, because the permission was never proven to be
 * gone and the user may deliberately retry.
 */
export function isTenantBranchAuthorizationLoss(reason: TenantBranchFailureReason): boolean {
  return (
    reason === 'session' ||
    reason === 'suspended' ||
    reason === 'billing-only' ||
    reason === 'not-owner' ||
    reason === 'no-workspace'
  );
}

export interface TenantBranchWriteFailure {
  readonly kind: TenantBranchWriteKind;
  readonly reason: TenantBranchFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a WRITE.
 *
 * `uncertain` covers the handler 500 (the client cannot distinguish a
 * confirmed rollback from a lost commit acknowledgement) and every
 * unrecognized/network/transport failure after the request was sent: the
 * write MAY have persisted, so nothing is retried automatically.
 */
export function classifyTenantBranchWriteFailure(cause: unknown): TenantBranchWriteFailure {
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
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { kind: 'denied', reason: 'no-workspace', message };
  }
  if (message === BRANCH_NOT_FOUND_MESSAGE) {
    return { kind: 'missing', reason: 'missing-branch', message };
  }
  if (message === BRANCH_CONFLICT_MESSAGE) {
    return { kind: 'conflict', reason: 'conflict', message };
  }
  if (
    message === BRANCH_INVALID_PAYLOAD_MESSAGE ||
    message === BRANCH_INVALID_UPDATE_PAYLOAD_MESSAGE ||
    message === BRANCH_INVALID_ID_MESSAGE
  ) {
    return { kind: 'invalid', reason: 'invalid', message };
  }
  if (message === BRANCH_CREATE_FAILED_MESSAGE || message === BRANCH_UPDATE_FAILED_MESSAGE) {
    return { kind: 'uncertain', reason: 'server', message };
  }
  return {
    kind: 'uncertain',
    reason: 'unknown',
    message: message || 'فشل غير مؤكد أثناء حفظ بيانات الفرع',
  };
}

/**
 * Classifies ONLY the documented transported messages of an INSTRUCTOR
 * MEMBERSHIP LIST read. The shared denial vocabulary (session, suspension,
 * billing-only, owner-only, missing workspace) is the same because it is the
 * same router and the same guard; the list-specific 500 and the two strict
 * query rejections are added.
 */
export function classifyTenantInstructorListFailure(cause: unknown): TenantBranchFailure {
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
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { phase: 'no-workspace', reason: 'no-workspace', message };
  }
  if (message === INSTRUCTOR_LIST_FAILED_MESSAGE) {
    return { phase: 'error', reason: 'server', message };
  }
  if (message === INSTRUCTOR_INVALID_LIMIT_MESSAGE || message === INSTRUCTOR_INVALID_CURSOR_MESSAGE) {
    return { phase: 'error', reason: 'invalid', message };
  }
  return {
    phase: 'error',
    reason: 'unknown',
    message: message || 'فشل تحميل قائمة المدربين',
  };
}

/**
 * Classifies ONLY the documented transported messages of an INSTRUCTOR BRANCH
 * ASSIGNMENT write.
 *
 * `uncertain` covers the handler 500 (the client cannot distinguish a confirmed
 * rollback from a lost commit acknowledgement) and every unrecognized/network/
 * transport failure after the request was sent: the write MAY have persisted,
 * so nothing is retried automatically.
 *
 * `missing` covers both a missing/foreign membership and a missing/foreign/
 * archived branch. The server did not write in either case, so the rows and the
 * selection are preserved for a deliberate retry — a missing target is NOT an
 * authorization loss and must never clear the list.
 */
export function classifyTenantInstructorWriteFailure(cause: unknown): TenantBranchWriteFailure {
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
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { kind: 'denied', reason: 'no-workspace', message };
  }
  if (message === INSTRUCTOR_MEMBERSHIP_NOT_FOUND_MESSAGE) {
    return { kind: 'missing', reason: 'missing-membership', message };
  }
  if (message === BRANCH_NOT_FOUND_MESSAGE) {
    return { kind: 'missing', reason: 'missing-branch', message };
  }
  if (message === INSTRUCTOR_MEMBERSHIP_CONFLICT_MESSAGE) {
    return { kind: 'conflict', reason: 'conflict', message };
  }
  if (message === INSTRUCTOR_INVALID_ID_MESSAGE || message === INSTRUCTOR_INVALID_PAYLOAD_MESSAGE) {
    return { kind: 'invalid', reason: 'invalid', message };
  }
  if (message === INSTRUCTOR_ASSIGN_FAILED_MESSAGE) {
    return { kind: 'uncertain', reason: 'server', message };
  }
  return {
    kind: 'uncertain',
    reason: 'unknown',
    message: message || 'فشل غير مؤكد أثناء حفظ ربط المدرب بالفرع',
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

/** The exact five server-projected fields, sorted for an exact key check. */
const BRANCH_KEYS = ['created_at', 'id', 'name', 'status', 'updated_at'];

export type TenantBranchParseResult =
  | { readonly ok: true; readonly branch: TenantBranch }
  | { readonly ok: false };

/**
 * Validates one branch DTO against the accepted M2-B03 contract: a non-null
 * object whose `id` is a non-empty string, whose `name` is a trimmed 1..255
 * string, whose `status` is exactly `active` or `archived` and whose two
 * timestamps are strings — and whose key set is EXACTLY the five projected
 * fields.
 *
 * Anything else — a non-object, a wrong field type, an unknown status, a
 * spread row with an extra key — is a malformed response, never a fabricated
 * branch.
 */
export function parseTenantBranch(body: unknown): TenantBranchParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const row = body as Record<string, unknown>;
  const id = row.id;
  const name = row.name;
  const status = row.status;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (!isNonEmptyString(id)) return { ok: false };
  if (typeof name !== 'string') return { ok: false };
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 255) return { ok: false };
  if (status !== 'active' && status !== 'archived') return { ok: false };
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return { ok: false };
  const keys = Object.keys(row).sort();
  if (keys.length !== BRANCH_KEYS.length) return { ok: false };
  for (let index = 0; index < BRANCH_KEYS.length; index += 1) {
    if (keys[index] !== BRANCH_KEYS[index]) return { ok: false };
  }
  return {
    ok: true,
    branch: {
      id,
      name,
      status,
      created_at: createdAt,
      updated_at: updatedAt,
    },
  };
}

export type TenantBranchListParseResult =
  | { readonly ok: true; readonly branches: TenantBranch[]; readonly nextCursor: string | null }
  | { readonly ok: false };

/**
 * Validates the list envelope: exactly `{ branches, next_cursor }`, an array of
 * valid branch DTOs and a cursor that is a string or exactly `null`.
 *
 * The page memory bound is enforced HERE, on the RESPONSE, and not only by the
 * request: a response carrying MORE rows than `TENANT_BRANCH_PAGE_LIMIT` is a
 * malformed response. It is rejected BEFORE a single row is traversed or
 * copied, so an oversized page is never held in memory, never silently
 * truncated and never paired with a fabricated cursor. The limit of the
 * request is a promise; the limit of the response is a contract.
 */
export function parseTenantBranchList(body: unknown): TenantBranchListParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'branches' || keys[1] !== 'next_cursor') {
    return { ok: false };
  }
  const list = envelope.branches;
  if (!Array.isArray(list)) return { ok: false };
  // The response memory bound, checked BEFORE any row is read or copied.
  if (list.length > TENANT_BRANCH_PAGE_LIMIT) return { ok: false };
  const nextCursor = envelope.next_cursor;
  if (!isNullableString(nextCursor)) return { ok: false };
  const branches: TenantBranch[] = [];
  for (const item of list) {
    const parsed = parseTenantBranch(item);
    if (!parsed.ok) return { ok: false };
    branches.push(parsed.branch);
  }
  return { ok: true, branches, nextCursor };
}

export type TenantBranchEnvelopeParseResult =
  | { readonly ok: true; readonly branch: TenantBranch }
  | { readonly ok: false };

/** Validates the `{ branch }` envelope of a confirmed create/update. */
export function parseTenantBranchEnvelope(body: unknown): TenantBranchEnvelopeParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 1 || keys[0] !== 'branch') return { ok: false };
  return parseTenantBranch(envelope.branch);
}

/** The exact five server-projected instructor-membership fields, sorted. */
const INSTRUCTOR_MEMBERSHIP_KEYS = [
  'branch_id',
  'branch_name',
  'instructor_id',
  'instructor_name',
  'membership_id',
];

export type TenantInstructorMembershipParseResult =
  | { readonly ok: true; readonly membership: TenantInstructorMembership }
  | { readonly ok: false };

/**
 * Validates one instructor-membership DTO against the accepted M2-B12
 * contract: a non-null object whose `membership_id` and `instructor_id` are
 * non-empty strings, whose `instructor_name` is a bounded display label, whose
 * branch pair is CONSISTENT (`branch_id` and `branch_name` are either both
 * present or both `null`), and whose key set is EXACTLY the five projected
 * fields.
 *
 * Anything else — a non-object, a wrong field type, a half-populated branch
 * pair, a spread row with an extra key — is a malformed response, never a
 * fabricated record.
 */
export function parseTenantInstructorMembership(body: unknown): TenantInstructorMembershipParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const row = body as Record<string, unknown>;
  const membershipId = row.membership_id;
  const instructorId = row.instructor_id;
  const instructorName = row.instructor_name;
  const branchId = row.branch_id;
  const branchName = row.branch_name;

  if (!isNonEmptyString(membershipId)) return { ok: false };
  if (!isNonEmptyString(instructorId)) return { ok: false };
  if (typeof instructorName !== 'string') return { ok: false };
  if (instructorName.length > 255) return { ok: false };

  const hasBranch = branchId !== null;
  if (hasBranch) {
    if (!isNonEmptyString(branchId)) return { ok: false };
    if (typeof branchName !== 'string') return { ok: false };
    const trimmed = branchName.trim();
    if (trimmed.length < 1 || trimmed.length > 255) return { ok: false };
  } else if (branchName !== null) {
    // A branch NAME without a branch id cannot be the server's projection.
    return { ok: false };
  }

  const keys = Object.keys(row).sort();
  if (keys.length !== INSTRUCTOR_MEMBERSHIP_KEYS.length) return { ok: false };
  for (let index = 0; index < INSTRUCTOR_MEMBERSHIP_KEYS.length; index += 1) {
    if (keys[index] !== INSTRUCTOR_MEMBERSHIP_KEYS[index]) return { ok: false };
  }

  return {
    ok: true,
    membership: {
      membership_id: String(membershipId),
      instructor_id: String(instructorId),
      instructor_name: instructorName,
      branch_id: hasBranch ? String(branchId) : null,
      branch_name: hasBranch ? String(branchName) : null,
    },
  };
}

export type TenantInstructorMembershipListParseResult =
  | { readonly ok: true; readonly memberships: TenantInstructorMembership[]; readonly nextCursor: string | null }
  | { readonly ok: false };

/**
 * Validates the list envelope: exactly `{ memberships, next_cursor }`, an array
 * of valid instructor-membership DTOs and a cursor that is a string or exactly
 * `null`.
 *
 * The page memory bound is enforced HERE, on the RESPONSE, and not only by the
 * request: a response carrying MORE rows than
 * `TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT` is a malformed response. It is
 * rejected BEFORE a single row is traversed or copied, so an oversized page is
 * never held in memory, never silently truncated and never paired with a
 * fabricated cursor.
 */
export function parseTenantInstructorMembershipList(body: unknown): TenantInstructorMembershipListParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 2 || keys[0] !== 'memberships' || keys[1] !== 'next_cursor') {
    return { ok: false };
  }
  const list = envelope.memberships;
  if (!Array.isArray(list)) return { ok: false };
  // The response memory bound, checked BEFORE any row is read or copied.
  if (list.length > TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT) return { ok: false };
  const nextCursor = envelope.next_cursor;
  if (!isNullableString(nextCursor)) return { ok: false };
  const memberships: TenantInstructorMembership[] = [];
  for (const item of list) {
    const parsed = parseTenantInstructorMembership(item);
    if (!parsed.ok) return { ok: false };
    memberships.push(parsed.membership);
  }
  return { ok: true, memberships, nextCursor };
}

export type TenantInstructorMembershipEnvelopeParseResult =
  | { readonly ok: true; readonly membership: TenantInstructorMembership }
  | { readonly ok: false };

/** Validates the `{ membership }` envelope of a confirmed assignment. */
export function parseTenantInstructorMembershipEnvelope(
  body: unknown,
): TenantInstructorMembershipEnvelopeParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== 1 || keys[0] !== 'membership') return { ok: false };
  return parseTenantInstructorMembership(envelope.membership);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type TenantBranchMutationKind = 'create' | 'rename' | 'status';

export type TenantBranchMutationStatus = 'idle' | 'saving' | 'uncertain';

export interface TenantBranchMutationState {
  status: TenantBranchMutationStatus;
  kind: TenantBranchMutationKind | null;
  /** The branch the mutation targets (null for a create). */
  targetId: string | null;
  /** The actual transported failure message, or local validation wording. */
  error: string | null;
  /** Warning after an uncertain write or a reconciliation read. Never success. */
  notice: string | null;
}

export type TenantBranchFormMode = 'closed' | 'create' | 'rename';

export interface TenantBranchFormState {
  mode: TenantBranchFormMode;
  /** The user's draft, preserved verbatim on every failed or uncertain write. */
  draft: string;
  /** The branch the rename form is bound to. */
  targetId: string | null;
  /** The branch name the rename form was opened for (display only). */
  targetName: string | null;
  error: string | null;
}

export interface TenantBranchState {
  /** The panel was explicitly opened by the user. No request happens before. */
  open: boolean;
  phase: TenantBranchPhase;
  /** The bounded current page only (at most TENANT_BRANCH_PAGE_LIMIT rows). */
  rows: TenantBranch[];
  /** The cursor of the NEXT page, or null when the server says there is none. */
  nextCursor: string | null;
  /** True when the current page is not the first page. */
  hasPreviousPage: boolean;
  error: string | null;
  /** Why the current phase was reached, when a failure caused it. */
  reason: TenantBranchFailureReason | null;
  /** The server-confirmed result of the last confirmed write. */
  lastConfirmed: TenantBranch | null;
  form: TenantBranchFormState;
  mutation: TenantBranchMutationState;
  /**
   * M2-B12 — the bounded instructor-membership section of the SAME panel. It
   * has its own page, cursor, generations and mutation latch state, so a
   * superseded instructor reply can never be mistaken for a branch reply and
   * vice versa. It is opened EXPLICITLY: no instructor request happens before.
   */
  instructors: TenantInstructorListState;
}

export type TenantInstructorMutationStatus = 'idle' | 'saving' | 'uncertain';

export interface TenantInstructorMutationState {
  status: TenantInstructorMutationStatus;
  /** The membership the assignment targets (null when idle). */
  targetId: string | null;
  /** The actual transported failure message, or local validation wording. */
  error: string | null;
  /** Warning after an uncertain write or a reconciliation read. Never success. */
  notice: string | null;
}

/**
 * The user's explicit, NOT-YET-SENT branch selection for one membership.
 *
 * It is never applied optimistically: a failed or uncertain write leaves the
 * last server-confirmed value on screen and keeps this selection, so the user
 * can deliberately retry without the panel ever showing a value the server did
 * not confirm.
 */
export interface TenantInstructorSelection {
  membershipId: string;
  branchId: string;
}

export interface TenantInstructorListState {
  /** The section was explicitly opened by the user. */
  open: boolean;
  phase: TenantBranchPhase;
  /** The bounded current page only (at most the membership page limit). */
  rows: TenantInstructorMembership[];
  /** The cursor of the NEXT page, or null when the server says there is none. */
  nextCursor: string | null;
  /** True when the current page is not the first page. */
  hasPreviousPage: boolean;
  error: string | null;
  reason: TenantBranchFailureReason | null;
  /** The server-confirmed record of the last confirmed assignment. */
  lastConfirmed: TenantInstructorMembership | null;
  /** The explicit selection awaiting an explicit save, or null. */
  selection: TenantInstructorSelection | null;
  mutation: TenantInstructorMutationState;
}

const closedForm = (): TenantBranchFormState => ({
  mode: 'closed',
  draft: '',
  targetId: null,
  targetName: null,
  error: null,
});

const idleMutation = (): TenantBranchMutationState => ({
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
});

const idleInstructorMutation = (): TenantInstructorMutationState => ({
  status: 'idle',
  targetId: null,
  error: null,
  notice: null,
});

/** The closed instructor section: no row, no cursor, no selection survives it. */
const closedInstructors = (): TenantInstructorListState => ({
  open: false,
  phase: 'idle',
  rows: [],
  nextCursor: null,
  hasPreviousPage: false,
  error: null,
  reason: null,
  lastConfirmed: null,
  selection: null,
  mutation: idleInstructorMutation(),
});

const initialState: TenantBranchState = {
  open: false,
  phase: 'idle',
  rows: [],
  nextCursor: null,
  hasPreviousPage: false,
  error: null,
  reason: null,
  lastConfirmed: null,
  form: closedForm(),
  mutation: idleMutation(),
  instructors: closedInstructors(),
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface TenantBranchApi {
  listBranches: (params: {
    limit: number;
    cursor: string | null;
  }) => Promise<TenantBranchListEnvelope>;
  /** Accepted M2-B03 owner-only create through the canonical transport. */
  createBranch?: (name: string) => Promise<TenantBranchEnvelope>;
  /** Accepted M2-B03 owner-only update through the canonical transport. */
  updateBranch?: (
    branchId: string,
    update: { name?: string; status?: TenantBranchStatus },
  ) => Promise<TenantBranchEnvelope>;
  /** Accepted M2-B12 owner-only bounded instructor-membership page. */
  listInstructorMemberships?: (params: {
    limit: number;
    cursor: string | null;
  }) => Promise<TenantInstructorMembershipListEnvelope>;
  /** Accepted M2-B12 owner-only assign (uuid) / clear (null) of one record. */
  assignInstructorBranch?: (
    membershipId: string,
    branchId: string | null,
  ) => Promise<TenantInstructorMembershipEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface TenantBranchController {
  getState(): TenantBranchState;
  subscribe(listener: (state: TenantBranchState) => void): () => void;
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
  /** Opens the rename form for a branch of the current page (no request). */
  openRenameForm(branchId: string): void;
  /** Updates the draft without issuing a request. */
  updateDraft(value: string): void;
  /** Closes the form; a late reply can never reopen or mutate it. */
  cancelForm(): void;
  /** Explicit single-flight create (owner-only, server-authoritative). */
  create(): Promise<void>;
  /** Explicit single-flight rename of the branch the form is bound to. */
  saveName(): Promise<void>;
  /** Explicit single-flight archive/reactivation of one branch. */
  setStatus(branchId: string, status: TenantBranchStatus): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain write. */
  reconcile(): Promise<void>;
  // -------------------------------------------------------------------------
  // M2-B12 — instructor branch-assignment section of the SAME panel
  // -------------------------------------------------------------------------
  /**
   * Opens the instructor section: exactly ONE bounded instructor-membership
   * page, plus the bounded branch page the selector needs if it was never read.
   */
  openInstructors(): Promise<void>;
  /** Closes the instructor section: its rows, cursor and selection are cleared. */
  closeInstructors(): void;
  /** A deliberate read of the CURRENT instructor page (never a write). */
  refreshInstructors(): Promise<void>;
  /** The next instructor page, using the server's opaque cursor. */
  nextInstructorsPage(): Promise<void>;
  /** Back to the first instructor page (the cursor is dropped). */
  firstInstructorsPage(): Promise<void>;
  /** Records the explicit branch selection for one membership. No request. */
  selectInstructorBranch(membershipId: string, branchId: string): void;
  /** Drops the unsent selection. */
  cancelInstructorSelection(): void;
  /** Explicit single-flight save of the current selection. */
  saveInstructorBranch(): Promise<void>;
  /** Explicit single-flight clear of one membership's record. */
  clearInstructorBranch(membershipId: string): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain assignment. */
  reconcileInstructors(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

type ReadMode = 'open' | 'page' | 'refresh' | 'reconcile';

export function createTenantBranchController(api: TenantBranchApi): TenantBranchController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: TenantBranchState) => void>();
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
  /** Form generation: opening, cancelling or invalidating a form advances it. */
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
  // M2-B12 — the instructor section's own latches and generations. They are
  // deliberately SEPARATE from the branch page's: a superseded instructor reply
  // can never be committed as a branch page (or vice versa), and opening the
  // instructor section never silently cancels an in-flight branch read.
  const instructorReadGuard = createCourseOperationGuard(tickets);
  let instructorPageGeneration = 0;
  let instructorRequestGeneration = 0;
  let instructorMutationOwner = 0;
  let instructorPhaseOwner = 0;
  let instructorConfirmedEpoch = 0;
  let instructorCursor: string | null = null;

  const patch = (changes: Partial<TenantBranchState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<TenantBranchFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<TenantBranchMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const patchInstructors = (changes: Partial<TenantInstructorListState>): void => {
    patch({ instructors: { ...state.instructors, ...changes } });
  };

  const patchInstructorMutation = (changes: Partial<TenantInstructorMutationState>): void => {
    patchInstructors({ mutation: { ...state.instructors.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** Clears every private trace of the panel (rows, drafts, cursors). */
  const clearPrivateState = (): Partial<TenantBranchState> => ({
    phase: 'idle',
    rows: [],
    nextCursor: null,
    hasPreviousPage: false,
    error: null,
    reason: null,
    lastConfirmed: null,
    form: closedForm(),
    mutation: idleMutation(),
    instructors: closedInstructors(),
  });

  /**
   * Discards everything in flight and the latches they hold. The generations
   * are advanced so a reply that is still on the wire can no longer commit.
   */
  const retireInFlight = (): void => {
    pageGeneration += 1;
    requestGeneration += 1;
    formGeneration += 1;
    instructorPageGeneration += 1;
    instructorRequestGeneration += 1;
    mutationOwner = 0;
    instructorMutationOwner = 0;
    readGuard.release();
    instructorReadGuard.release();
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
    instructorCursor = null;
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
    instructorPageGeneration += 1;
    instructorRequestGeneration += 1;
    currentCursor = null;
    instructorCursor = null;
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

  /** Applies a server-confirmed branch to the held page (if it is on it). */
  const applyConfirmedBranch = (branch: TenantBranch): void => {
    const index = state.rows.findIndex((row) => row.id === branch.id);
    if (index === -1) {
      patch({ lastConfirmed: branch });
      return;
    }
    const rows = state.rows.slice();
    rows[index] = branch;
    patch({ rows, lastConfirmed: branch });
  };

  const reconcileNoticeIfCurrent = (): void => {
    if (state.mutation.status !== 'uncertain') return;
    patchMutation({ notice: BRANCH_RECONCILED_MESSAGE });
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
      const body = await api.listBranches({ limit: TENANT_BRANCH_PAGE_LIMIT, cursor });
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
      const parsed = parseTenantBranchList(body);
      if (!parsed.ok) {
        patch({
          phase: 'error',
          rows: [],
          nextCursor: null,
          hasPreviousPage: false,
          error: MALFORMED_BRANCH_MESSAGE,
          reason: 'unknown',
        });
        return;
      }
      currentCursor = cursor;
      patch({
        phase: parsed.branches.length === 0 ? 'empty' : 'ready',
        rows: parsed.branches,
        nextCursor: parsed.nextCursor,
        hasPreviousPage: cursor !== null,
        error: null,
        reason: null,
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
      const failure = classifyTenantBranchFailure(cause);
      if (isTenantBranchAuthorizationLoss(failure.reason)) {
        // A DEFINITE loss of the list's authorization or of the tenant scope:
        // the private rows, the form, the draft, the target and the
        // confirmation are cleared and every in-flight operation is retired,
        // so an older write or an older read can never repopulate the
        // cleared private state. The truthful failure phase and the server's
        // own message are preserved.
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
      const failure = classifyTenantBranchWriteFailure(cause);
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
          notice: BRANCH_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid/missing: the server did not write. The rows
      // and the draft are preserved for a deliberate retry.
      patchMutation({ status: 'idle', error: failure.message, notice: null });
      return;
    }
    const parsed = parseTenantBranchEnvelope(body);
    if (!parsed.ok) {
      patchMutation({ status: 'uncertain', error: null, notice: BRANCH_WRITE_UNCERTAIN_MESSAGE });
      return;
    }
    // The server confirmed the write, but a newer operation owns the view, so
    // the reply is not committed and no success is claimed.
    patchMutation({ status: 'idle', error: null, notice: null });
  };

  const runMutation = async (
    kind: TenantBranchMutationKind,
    targetId: string | null,
    body: { name?: string; status?: TenantBranchStatus },
  ): Promise<void> => {
    if (disposed) return;
    if (kind === 'create' && !api.createBranch) return;
    if (kind !== 'create' && !api.updateBranch) return;

    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (disposed) return;

    // Synchronous single-flight: a second click/Enter before the first await
    // never reaches the transport.
    if (!writeGuard.acquire()) return;
    const ticket = writeGuard.holder();
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
          ? await api.createBranch!(body.name as string)
          : await api.updateBranch!(targetId as string, body);
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
      const parsed = parseTenantBranchEnvelope(response);
      if (!parsed.ok) {
        // A 2xx success with a body that cannot be validated is not success.
        patchMutation({
          status: 'uncertain',
          error: null,
          notice: BRANCH_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      if (kind !== 'create' && parsed.branch.id !== targetId) {
        // A well-formed DTO for ANOTHER branch is not a success for this
        // write: nothing is committed, the draft is preserved, the write
        // stays explicitly uncertain and no retry is sent.
        patchMutation({
          status: 'uncertain',
          error: null,
          notice: BRANCH_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Server-authoritative success only.
      confirmedWriteEpoch += 1;
      mutationOwner = 0;
      applyConfirmedBranch(parsed.branch);
      if ((kind === 'create' || kind === 'rename') && formGeneration === formToken) {
        // The form this write belonged to is still the current one, so it
        // closes. A status write never touches an open form.
        formGeneration += 1;
        patchForm(closedForm());
      }
      patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
      if (kind === 'create') {
        // At most ONE bounded refresh after a confirmed create, so the page
        // keeps the server's canonical ordering. It is a read, never a second
        // write, and it is issued exactly once per confirmed create.
        await runRead(currentCursor, 'refresh');
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
      const failure = classifyTenantBranchWriteFailure(cause);
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
          notice: BRANCH_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid/missing: the server did not write. The rows
      // and the draft are preserved and the user may retry explicitly.
      mutationOwner = 0;
      patchMutation({ status: 'idle', error: failure.message, notice: null });
    } finally {
      // Only its own ticket: a retired mutation's `finally` can never release
      // a newer mutation's latch.
      writeGuard.release(ticket);
    }
  };

  const validateName = (raw: string): string | null => {
    const name = raw.trim();
    if (name.length < 1 || name.length > 255) return null;
    return name;
  };

  // -------------------------------------------------------------------------
  // M2-B12 — instructor branch-assignment section
  // -------------------------------------------------------------------------

  /**
   * Settles the loading phase a retired instructor read owns, so the section
   * never stays on a phantom `loading` while a newer read owns the data.
   */
  const settleInstructorPhase = (phaseToken: number): void => {
    if (instructorPhaseOwner !== phaseToken) return;
    if (state.instructors.phase !== 'loading') return;
    patchInstructors({
      phase: state.instructors.rows.length > 0 ? 'ready' : 'idle',
      error: null,
      reason: null,
    });
  };

  /** Applies a server-confirmed record to the held instructor page. */
  const applyConfirmedInstructor = (membership: TenantInstructorMembership): void => {
    const index = state.instructors.rows.findIndex(
      (row) => row.membership_id === membership.membership_id,
    );
    if (index === -1) {
      patchInstructors({ lastConfirmed: membership });
      return;
    }
    const rows = state.instructors.rows.slice();
    rows[index] = membership;
    patchInstructors({ rows, lastConfirmed: membership });
  };

  const runInstructorRead = async (cursor: string | null, mode: ReadMode): Promise<void> => {
    if (disposed) return;
    if (!state.instructors.open) return;
    if (!api.listInstructorMemberships) return;
    // Entry observation: a principal that changed without a notifier is adopted
    // (generations retired, private rows cleared) BEFORE the read starts.
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    // One instructor read at a time: a double-clicked paging or refresh button
    // never reaches the transport.
    if (!instructorReadGuard.acquire()) return;
    const ticket = instructorReadGuard.holder();
    const generation = ++instructorPageGeneration;
    const epoch = instructorConfirmedEpoch;
    const principal = entryPrincipal;
    const phaseToken = ++instructorPhaseOwner;
    patchInstructors({ phase: 'loading', error: null, reason: null });
    try {
      const body = await api.listInstructorMemberships({
        limit: TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT,
        cursor,
      });
      if (disposed) return;
      if (generation !== instructorPageGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) {
          return;
        }
        settleInstructorPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      // A confirmed assignment landed while this read was on the wire, so the
      // page it carries is already stale and is never committed over it.
      if (epoch !== instructorConfirmedEpoch) {
        settleInstructorPhase(phaseToken);
        return;
      }
      const parsed = parseTenantInstructorMembershipList(body);
      if (!parsed.ok) {
        patchInstructors({
          phase: 'error',
          rows: [],
          nextCursor: null,
          hasPreviousPage: false,
          error: INSTRUCTOR_LIST_MALFORMED_MESSAGE,
          reason: 'unknown',
        });
        return;
      }
      instructorCursor = cursor;
      patchInstructors({
        phase: parsed.memberships.length === 0 ? 'empty' : 'ready',
        rows: parsed.memberships,
        nextCursor: parsed.nextCursor,
        hasPreviousPage: cursor !== null,
        error: null,
        reason: null,
      });
      if (mode === 'reconcile' && state.instructors.mutation.status === 'uncertain') {
        patchInstructorMutation({ notice: INSTRUCTOR_ASSIGNMENT_RECONCILED_MESSAGE });
      }
    } catch (cause) {
      if (disposed) return;
      if (generation !== instructorPageGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) {
          return;
        }
        settleInstructorPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      if (epoch !== instructorConfirmedEpoch) {
        settleInstructorPhase(phaseToken);
        return;
      }
      const failure = classifyTenantInstructorListFailure(cause);
      if (isTenantBranchAuthorizationLoss(failure.reason)) {
        // A DEFINITE loss of the section's authorization or of the tenant
        // scope: every private row, cursor and selection is cleared and every
        // in-flight operation is retired. The section stays OPEN so the
        // truthful denial is visible, but it holds no private state at all.
        retireInFlight();
        instructorCursor = null;
        patch({
          ...clearPrivateState(),
          instructors: {
            ...closedInstructors(),
            open: true,
            phase: failure.phase,
            error: failure.message,
            reason: failure.reason,
          },
        });
        return;
      }
      // A retryable read failure keeps the explicit selection: no permission
      // loss was proven.
      patchInstructors({
        phase: failure.phase,
        rows: [],
        nextCursor: null,
        hasPreviousPage: false,
        error: failure.message,
        reason: failure.reason,
      });
    } finally {
      instructorReadGuard.release(ticket);
    }
  };

  /**
   * Settles an assignment that can no longer commit because a newer
   * assignment, a newer read or a session change owns the displayed state.
   * The reply is never committed and never claims success.
   */
  const settleSupersededInstructorMutation = (
    token: number,
    body: unknown | null,
    cause: unknown | null,
  ): void => {
    if (instructorMutationOwner !== token) return;
    if (state.instructors.mutation.status !== 'saving') return;
    if (cause !== null) {
      const failure = classifyTenantInstructorWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        instructorCursor = null;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        patchInstructorMutation({
          status: 'uncertain',
          error: failure.message,
          notice: INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE,
        });
        return;
      }
      patchInstructorMutation({ status: 'idle', error: failure.message, notice: null });
      return;
    }
    const parsed = parseTenantInstructorMembershipEnvelope(body);
    if (!parsed.ok) {
      patchInstructorMutation({
        status: 'uncertain',
        error: null,
        notice: INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE,
      });
      return;
    }
    patchInstructorMutation({ status: 'idle', error: null, notice: null });
  };

  const runInstructorAssignment = async (
    membershipId: string,
    branchId: string | null,
  ): Promise<void> => {
    if (disposed) return;
    if (!api.assignInstructorBranch) return;

    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (disposed) return;

    // The SAME single write latch the branch mutations use: one write of any
    // kind is in flight at a time across the whole panel, so a double-clicked
    // save or a save racing a branch rename never sends a second write.
    if (!writeGuard.acquire()) return;
    const ticket = writeGuard.holder();
    const token = ++instructorRequestGeneration;
    const principal = entryPrincipal;
    instructorMutationOwner = token;
    patchInstructorMutation({
      status: 'saving',
      targetId: membershipId,
      error: null,
      notice: null,
    });
    try {
      const response = await api.assignInstructorBranch(membershipId, branchId);
      if (disposed) return;
      if (token !== instructorRequestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededInstructorMutation(token, response, null);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const parsed = parseTenantInstructorMembershipEnvelope(response);
      if (!parsed.ok) {
        // A 2xx success with a body that cannot be validated is not success.
        patchInstructorMutation({
          status: 'uncertain',
          error: null,
          notice: INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE,
        });
        return;
      }
      if (parsed.membership.membership_id !== membershipId) {
        // A well-formed DTO for ANOTHER membership is not a success for this
        // write: nothing is committed, the selection is preserved and the write
        // stays explicitly uncertain.
        patchInstructorMutation({
          status: 'uncertain',
          error: null,
          notice: INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Server-authoritative success only.
      instructorConfirmedEpoch += 1;
      instructorMutationOwner = 0;
      applyConfirmedInstructor(parsed.membership);
      const selection = state.instructors.selection;
      if (selection && selection.membershipId === membershipId) {
        // The confirmed write consumed the selection.
        patchInstructors({ selection: null });
      }
      patchInstructorMutation({ status: 'idle', targetId: null, error: null, notice: null });
    } catch (cause) {
      if (disposed) return;
      if (token !== instructorRequestGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededInstructorMutation(token, null, cause);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyTenantInstructorWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        instructorCursor = null;
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        instructorMutationOwner = 0;
        patchInstructorMutation({
          status: 'uncertain',
          error: failure.message,
          notice: INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid/missing: the server did not write. The rows and
      // the explicit selection are preserved for a deliberate retry.
      instructorMutationOwner = 0;
      patchInstructorMutation({ status: 'idle', error: failure.message, notice: null });
    } finally {
      writeGuard.release(ticket);
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal (or a logout): every in-flight reply is foreign,
        // the private rows and drafts are cleared BEFORE any new read starts.
        const instructorsWereOpen = state.instructors.open;
        retireInFlight();
        observedPrincipal = readPrincipal();
        currentCursor = null;
        instructorCursor = null;
        patch(clearPrivateState());
        if (state.open) {
          // The panel is open, so the new session gets its own first page.
          track(runRead(null, 'open'));
        }
        if (instructorsWereOpen) {
          // The instructor section was open, so the new session gets its own
          // first bounded page — never the previous principal's rows.
          patchInstructors({ open: true });
          track(runInstructorRead(null, 'open'));
        }
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    currentCursor = null;
    instructorCursor = null;
    // The view is gone: no branch row, draft, cursor, instructor row or
    // selection outlives it.
    patch({ open: false, ...clearPrivateState() });
  };

  return {
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
      patchForm({ mode: 'create', draft: '', targetId: null, targetName: null, error: null });
    },
    openRenameForm: (branchId) => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      const row = state.rows.find((candidate) => candidate.id === branchId);
      // The form is bound to a branch of the CURRENT page only.
      if (!row) return;
      formGeneration += 1;
      patchForm({
        mode: 'rename',
        draft: row.name,
        targetId: row.id,
        targetName: row.name,
        error: null,
      });
    },
    updateDraft: (value) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      patchForm({ draft: value, error: null });
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
      const name = validateName(state.form.draft);
      if (name === null) {
        // Local validation happens BEFORE any request and keeps the input.
        patchForm({ error: BRANCH_NAME_INVALID_MESSAGE });
        return Promise.resolve();
      }
      const operation = runMutation('create', null, { name });
      track(operation);
      return operation;
    },
    saveName: () => {
      if (disposed) return Promise.resolve();
      if (state.form.mode !== 'rename') return Promise.resolve();
      const targetId = state.form.targetId;
      if (!targetId) return Promise.resolve();
      const name = validateName(state.form.draft);
      if (name === null) {
        patchForm({ error: BRANCH_NAME_INVALID_MESSAGE });
        return Promise.resolve();
      }
      const operation = runMutation('rename', targetId, { name });
      track(operation);
      return operation;
    },
    setStatus: (branchId, status) => {
      if (disposed) return Promise.resolve();
      const row = state.rows.find((candidate) => candidate.id === branchId);
      if (!row) return Promise.resolve();
      if (row.status === status) return Promise.resolve();
      const operation = runMutation('status', branchId, { status });
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
    // -----------------------------------------------------------------------
    // M2-B12 — instructor branch-assignment section
    // -----------------------------------------------------------------------
    openInstructors: () => {
      if (disposed) return Promise.resolve();
      if (state.instructors.open) return Promise.resolve();
      patchInstructors({ open: true });
      const operations: Promise<void>[] = [];
      // The selector offers the ACTIVE branches of the CURRENT bounded branch
      // page, so a page that was never read is read now — exactly once, through
      // the normal read path, never as a second parallel branch read.
      if (state.phase === 'idle') {
        if (!state.open) patch({ open: true });
        operations.push(runRead(null, 'open'));
      }
      operations.push(runInstructorRead(null, 'open'));
      const combined = Promise.all(operations).then(() => undefined);
      track(combined);
      return combined;
    },
    closeInstructors: () => {
      if (disposed) return;
      // Every in-flight instructor reply is retired and the section's private
      // rows, cursor and selection are dropped.
      instructorPageGeneration += 1;
      instructorRequestGeneration += 1;
      instructorMutationOwner = 0;
      instructorReadGuard.release();
      instructorCursor = null;
      patchInstructors(closedInstructors());
    },
    refreshInstructors: () => {
      if (disposed) return Promise.resolve();
      const operation = runInstructorRead(instructorCursor, 'refresh');
      track(operation);
      return operation;
    },
    nextInstructorsPage: () => {
      if (disposed) return Promise.resolve();
      const cursor = state.instructors.nextCursor;
      // No cursor: the server said there is no further page, so no request is
      // sent at all.
      if (!cursor) return Promise.resolve();
      const operation = runInstructorRead(cursor, 'page');
      track(operation);
      return operation;
    },
    firstInstructorsPage: () => {
      if (disposed) return Promise.resolve();
      const operation = runInstructorRead(null, 'page');
      track(operation);
      return operation;
    },
    selectInstructorBranch: (membershipId, branchId) => {
      if (disposed) return;
      if (!state.instructors.open) return;
      const row = state.instructors.rows.find(
        (candidate) => candidate.membership_id === membershipId,
      );
      // The selection is bound to a membership of the CURRENT instructor page
      // only.
      if (!row) return;
      // The selector can only offer a branch of the CURRENT bounded branch page
      // and only an ACTIVE one: an archived, foreign or unknown id is refused
      // HERE instead of being sent to the server.
      const branch = state.rows.find((candidate) => candidate.id === branchId);
      if (!branch || branch.status !== 'active') {
        patchInstructorMutation({
          status: 'idle',
          targetId: null,
          error: INSTRUCTOR_SELECTION_INVALID_MESSAGE,
          notice: null,
        });
        return;
      }
      if (row.branch_id === branchId) {
        // Already the recorded branch: there is nothing to send.
        patchInstructors({ selection: null });
        patchInstructorMutation({ status: 'idle', targetId: null, error: null, notice: null });
        return;
      }
      patchInstructors({ selection: { membershipId, branchId } });
      patchInstructorMutation({ status: 'idle', targetId: null, error: null, notice: null });
    },
    cancelInstructorSelection: () => {
      if (disposed) return;
      if (!state.instructors.selection) return;
      patchInstructors({ selection: null });
    },
    saveInstructorBranch: () => {
      if (disposed) return Promise.resolve();
      const selection = state.instructors.selection;
      if (!selection) {
        // Local validation happens BEFORE any request and keeps the state.
        patchInstructorMutation({
          status: 'idle',
          targetId: null,
          error: INSTRUCTOR_SELECTION_INVALID_MESSAGE,
          notice: null,
        });
        return Promise.resolve();
      }
      // Re-validate against the CURRENT pages before sending: the membership or
      // the branch may have been superseded since the selection was made.
      const row = state.instructors.rows.find(
        (candidate) => candidate.membership_id === selection.membershipId,
      );
      const branch = state.rows.find((candidate) => candidate.id === selection.branchId);
      if (!row || !branch || branch.status !== 'active') {
        patchInstructorMutation({
          status: 'idle',
          targetId: null,
          error: INSTRUCTOR_SELECTION_INVALID_MESSAGE,
          notice: null,
        });
        return Promise.resolve();
      }
      const operation = runInstructorAssignment(selection.membershipId, selection.branchId);
      track(operation);
      return operation;
    },
    clearInstructorBranch: (membershipId) => {
      if (disposed) return Promise.resolve();
      const row = state.instructors.rows.find(
        (candidate) => candidate.membership_id === membershipId,
      );
      // The clear is bound to a membership of the CURRENT page only.
      if (!row) return Promise.resolve();
      // Nothing is recorded, so there is no write to send.
      if (row.branch_id === null) return Promise.resolve();
      const operation = runInstructorAssignment(membershipId, null);
      track(operation);
      return operation;
    },
    reconcileInstructors: () => {
      if (disposed) return Promise.resolve();
      // Deliberate, explicit GET only after an uncertain assignment. It never
      // retries the write and never claims the write succeeded.
      if (state.instructors.mutation.status !== 'uncertain') return Promise.resolve();
      const operation = runInstructorRead(instructorCursor, 'reconcile');
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
