/**
 * M2-05 — selected institution identity on the existing instructor dashboard.
 *
 * The smallest production seam `src/pages/InstructorDashboard.tsx` delegates
 * to: it owns the read-only profile request lifecycle (loading / retryable
 * error / unauthorized / denied / no-authorized-workspace states, runtime DTO
 * validation, stale-reply invalidation, session/scope fences and disposal) and
 * keeps React rendering out of the decision path. Transport, the session
 * notifier and the principal reader are injected, so the exact production code
 * the page runs is exercised hermetically in node:test
 * (src/tests/m2-tenant-profile-ui.test.ts) with no DB, network, browser or
 * live app.
 *
 * Contracts verified from source (documented in
 * docs/streams/client/M2-05-CONTRACTS.md):
 *  - GET /api/tenants/me/profile is mounted by the accepted M2-B01 router
 *    (server/src/routes/tenant-self.ts:119-140) on the server-selected tenant
 *    only. The response is the fixed four-field DTO
 *    `{ id, business_name, subject_type, status }` — never a row spread, and
 *    `subject_type` is the existing nullable column returned verbatim;
 *  - the handler's own outcomes are 200, 404 `Tenant membership not found`
 *    (no selected workspace / no server-owned authority) and 500
 *    `Failed to load tenant profile`; the upstream answers are 401
 *    (`Token expired` / `Invalid token` / `No token provided` /
 *    `Session revoked` / `Selected workspace is no longer active`), 403
 *    `Instructor account is administratively suspended` (code
 *    `TENANT_SUSPENDED`) and 409 `Select an instructor workspace first`
 *    (code `STUDENT_SPACE_REQUIRED`); the client matches the transported
 *    `error` message only — the `code` field is discarded with the status.
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status (api-http.ts:69-89), so ONLY these documented messages classify an
 *    outcome — a numeric status is never inferred, and an unavailable
 *    distinction is recorded, not faked;
 *  - the card shows only a server-confirmed profile: no local user name, no
 *    billing DTO, no fallback identity, no client tenant selector
 *    (header/query/body), and institution status is metadata — never payment
 *    or course entitlement.
 *
 * Lifetimes fenced here:
 *  - request: every load advances a monotonic generation, so a reversed or
 *    superseded reply can never commit, and an old `finally` can never release
 *    a newer load's latch;
 *  - session/scope: the canonical principal is re-read at entry AND completion
 *    of every read through the accepted M2-02 reader
 *    (`readCourseSessionPrincipal`); an event retires everything in flight and
 *    clears the private identity BEFORE the new load starts. A change observed
 *    without any event (silent logout/scope swap, server-side session
 *    replacement) is also adopted: the old generation is invalidated, the
 *    identity/error/loading state is cleared, the latch is released and a
 *    retry/new load is usable. A → B → A can never show B's institution and an
 *    old reply can never commit into a newer session;
 *  - a RETIRED read (one whose generation a newer read or write superseded)
 *    observes the canonical principal BEFORE it settles the phase it owns, on
 *    both the success and the failure path: a silent logout during a pending
 *    write can never revive the previous principal's card, draft or phase, and
 *    a retired completion never releases a newer operation's latch (every
 *    operation releases only its own ticket);
 *  - dispose: unmount clears the identity and drops every in-flight reply.
 *
 * M2-06 adds the bounded institution-name edit lifecycle to the SAME seam:
 * one owner-only PATCH through the accepted M2-B02 endpoint, synchronous
 * single-flight, form draft/generation lifetimes, shared read/write ordering
 * (an old GET can never overwrite a confirmed write and an old write can never
 * overwrite a newer read or a newer session), honest transported-message
 * failures, and deliberate read-only reconciliation after an uncertain write.
 * The Profile DTO has no capability field: the owner-only label is UX, the
 * server owner check stays authoritative, and a denied write never erases a
 * valid read-authorized profile.
 *
 * Out of scope by construction: no page/route addition, no billing or
 * paid-access policy, no subject_type → category mapping, no shared
 * auth/error-contract change, no backend/schema/service/provider/network.
 */
import type { TenantProfile, TenantProfileEnvelope } from '../../lib/api-http';
import {
  createCourseOperationGuard,
  createCourseSequence,
  createTicketSource,
} from '../catalog/course-management';

/**
 * The canonical session reader the page uses. Re-exported so the page imports
 * ONE principal boundary: M2-02's reader holds the single canonical
 * localStorage lifetime (exact canonical comparison, monotonic incarnation),
 * and a second parallel lifetime here would let the two pages disagree about
 * what "the same session" means.
 */
export { readCourseSessionPrincipal } from '../catalog/course-management';
export type { CourseSessionStorage } from '../catalog/course-management';

// ---------------------------------------------------------------------------
// Failure classification — documented transport messages only
// ---------------------------------------------------------------------------

/** The page's own wording for a body that is not the documented envelope. The
 *  server never sends this string, so it can never be confused with a server
 *  classification. */
export const MALFORMED_PROFILE_MESSAGE = 'استجابة غير صالحة من الخادم';

/** Upstream authentication answers — the EXACT messages the shared transport
 *  throws (server/src/middleware/auth.ts:204/218/220/254/256 and :160). The
 *  transport discards the HTTP status and the `code` field (api-http.ts:69-89),
 *  so the classifier matches the transported `error` string, never a synthetic
 *  code: `TOKEN_EXPIRED`/`SESSION_REVOKED` are `code` values and never arrive
 *  as `error.message`. */
const SESSION_INVALID_MESSAGES = new Set<string>([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
]);

/** The account is suspended: the transport also tears the session down
 *  (api-http.ts:85-88); the feature records the denial it can see. The server's
 *  exact 403 message (auth.ts:138, code `TENANT_SUSPENDED`) is matched
 *  verbatim — the code itself never reaches `error.message`. */
const SUSPENDED_MESSAGE = 'Instructor account is administratively suspended';

/** No authorized workspace: the handler's 404 (admin without tenant scope,
 *  unselected workspace, no server-owned authority, tenant-self.ts:129) and the
 *  student-boundary 409 (a student without a selected space,
 *  student-workspace-boundary.ts:17, code `STUDENT_SPACE_REQUIRED`). Both fail
 *  closed: no identity. */
const NO_WORKSPACE_MESSAGES = new Set<string>([
  'Tenant membership not found',
  'Select an instructor workspace first',
]);

/** The handler's own 500 wording (tenant-self.ts:138). */
const PROFILE_LOAD_FAILED_MESSAGE = 'Failed to load tenant profile';

export type TenantProfilePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace';

/** A retryable read failure: the 500 wording, a transport/network failure, or
 *  any message that is not one of the documented classified strings (recorded
 *  honestly instead of being forced into a known bucket). */
const RETRYABLE_FALLBACK_PHASE: TenantProfilePhase = 'error';

export interface TenantProfileFailure {
  readonly phase: TenantProfilePhase;
  readonly message: string;
}

export function classifyTenantProfileFailure(cause: unknown): TenantProfileFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_INVALID_MESSAGES.has(message)) {
    return { phase: 'unauthorized', message };
  }
  if (message === SUSPENDED_MESSAGE) {
    return { phase: 'denied', message };
  }
  if (NO_WORKSPACE_MESSAGES.has(message)) {
    return { phase: 'no-workspace', message };
  }
  // 500 wording, network failures and every undocumented message stay a
  // retryable read failure with the actual message on screen. A permission or
  // no-workspace outcome is NEVER faked from an unrecognized message.
  return { phase: RETRYABLE_FALLBACK_PHASE, message: message || 'فشل تحميل هوية المساحة' };
}

// ---------------------------------------------------------------------------
// Write failure classification — the same documented messages only
// ---------------------------------------------------------------------------

/** Client-side validation wording: the input never reaches the transport. */
export const PROFILE_NAME_INVALID_MESSAGE =
  'اسم المؤسسة يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات.';

/** Local warning after a reply that may or may not have persisted server-side. */
export const PROFILE_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ الاسم. قد تكون التغييرات قد حُفظت على الخادم؛ اقرأ الحالة الحالية للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after the deliberate read-only reconciliation. A matching GET
 *  is the CURRENT state, never proof of the previous write or its audit. */
export const PROFILE_RECONCILED_MESSAGE =
  'تم عرض الحالة الحالية من الخادم. هذا لا يؤكد نجاح محاولة الحفظ السابقة.';

/** The accepted PATCH handler's own 500 wording (M2-B02 contract). It may be a
 *  failed transaction OR a lost commit acknowledgement, so the client treats it
 *  as uncertain after the request left the page. */
const PROFILE_UPDATE_FAILED_MESSAGE = 'Failed to update tenant profile';

/** The accepted write-side 404: not the verified owner (or inactive), with no
 *  write and no audit. It must never erase a valid read-authorized profile. */
const PROFILE_WRITE_NOT_AUTHORIZED_MESSAGE = 'Tenant membership not found';

/** The accepted concurrent-row outcome: the server rolled back and did not
 *  write, so this is a retryable conflict, not an uncertain write. */
const PROFILE_WRITE_CONFLICT_MESSAGE = 'Tenant profile was modified concurrently';

/** The handler's strict payload rejection: no connection was taken. */
const PROFILE_WRITE_INVALID_PAYLOAD_MESSAGE = 'Invalid profile update payload';

export type TenantProfileWriteFailureKind =
  | 'unauthorized'
  | 'denied'
  | 'invalid'
  | 'conflict'
  | 'uncertain';

export interface TenantProfileWriteFailure {
  readonly kind: TenantProfileWriteFailureKind;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported write messages. The transport
 * discards the HTTP status and `code`, so a discarded code is never enough to
 * infer a permission outcome, and no synthetic status is fabricated.
 *
 * `uncertain` covers the handler 500 (presentation cannot distinguish a
 * confirmed rollback from a lost commit acknowledgement) and every
 * unrecognized/network/transport failure after the request was sent.
 */
export function classifyTenantProfileWriteFailure(cause: unknown): TenantProfileWriteFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_INVALID_MESSAGES.has(message) || message === SUSPENDED_MESSAGE) {
    return { kind: 'unauthorized', message };
  }
  if (message === PROFILE_WRITE_NOT_AUTHORIZED_MESSAGE ||
      message === 'Select an instructor workspace first') {
    return { kind: 'denied', message };
  }
  if (message === PROFILE_WRITE_CONFLICT_MESSAGE) {
    return { kind: 'conflict', message };
  }
  if (message === PROFILE_WRITE_INVALID_PAYLOAD_MESSAGE) {
    return { kind: 'invalid', message };
  }
  if (message === PROFILE_UPDATE_FAILED_MESSAGE) {
    return { kind: 'uncertain', message };
  }
  return {
    kind: 'uncertain',
    message: message || 'فشل غير مؤكد أثناء حفظ اسم المؤسسة',
  };
}

// ---------------------------------------------------------------------------
// Runtime DTO validation — a missing or malformed body is an error
// ---------------------------------------------------------------------------

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** The nullable column, verbatim: a string or exactly `null`. */
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

export type TenantProfileParseResult =
  | { readonly ok: true; readonly profile: TenantProfile }
  | { readonly ok: false };

/**
 * Validates the response envelope against the accepted M2-B01 contract:
 * a non-null `tenant` object whose `id`, `business_name` and `status` are
 * non-empty strings and whose `subject_type` is a string or `null`.
 *
 * Anything else — a non-object body, a missing `tenant`, wrong field types, a
 * spread row with unknown extra keys — is a malformed response, never a
 * fabricated institution and never an empty state. Extra keys are rejected
 * rather than silently dropped, so the card can only ever show the exact
 * four-field server projection.
 */
export function parseTenantProfileEnvelope(body: unknown): TenantProfileParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false };
  }
  const envelope = body as Record<string, unknown>;
  const tenant = envelope.tenant;
  if (typeof tenant !== 'object' || tenant === null || Array.isArray(tenant)) {
    return { ok: false };
  }
  const row = tenant as Record<string, unknown>;
  // Captured as locals first: a type guard on a dictionary property does not
  // stay narrowed across the later guard calls, so the validated values are
  // read from stable locals.
  const id = row.id;
  const businessName = row.business_name;
  const status = row.status;
  const subjectType = row.subject_type;
  if (!isNonEmptyString(id) || !isNonEmptyString(businessName) || !isNonEmptyString(status)) {
    return { ok: false };
  }
  if (!isNullableString(subjectType)) {
    return { ok: false };
  }
  const keys = Object.keys(row).sort();
  if (keys.length !== 4 || keys[0] !== 'business_name' || keys[1] !== 'id' ||
      keys[2] !== 'status' || keys[3] !== 'subject_type') {
    return { ok: false };
  }
  return {
    ok: true,
    profile: {
      id,
      business_name: businessName,
      subject_type: subjectType,
      status,
    },
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type TenantProfileEditStatus = 'closed' | 'editing' | 'saving' | 'uncertain';

export interface TenantProfileEditState {
  status: TenantProfileEditStatus;
  /** The user's draft, preserved verbatim on every failed or uncertain write. */
  draft: string;
  /** The actual transported failure message, or local validation wording. */
  error: string | null;
  /** Warning after an uncertain write or a reconciliation read. Never success. */
  notice: string | null;
}

const closedEditState = (): TenantProfileEditState => ({
  status: 'closed',
  draft: '',
  error: null,
  notice: null,
});

export interface TenantProfileState {
  phase: TenantProfilePhase;
  /** The server-confirmed identity. Non-null ONLY in phase 'ready'; every
   *  failure, session change and disposal clears it, so a prior session's
   *  institution is never left on screen. */
  profile: TenantProfile | null;
  error: string | null;
  /** M2-06 edit lifecycle. Independent of the read phase so a denied write
   *  never erases a valid read-authorized profile. */
  edit: TenantProfileEditState;
}

export interface TenantProfileApi {
  loadProfile: () => Promise<TenantProfileEnvelope>;
  /** Accepted M2-B02 owner-only PATCH through the canonical transport. */
  updateProfile?: (businessName: string) => Promise<TenantProfileEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface TenantProfileController {
  getState(): TenantProfileState;
  subscribe(listener: (state: TenantProfileState) => void): () => void;
  /** Initial read (mount). */
  load(): Promise<void>;
  /** The page's Retry action. A read-only endpoint: the retry is exactly one
   *  more read, with the same fences as the initial load. */
  refresh(): Promise<void>;
  /** Opens the small name form with the current server-confirmed name. */
  openEditor(): void;
  /** Updates the draft without issuing a request. */
  updateDraft(value: string): void;
  /** Closes the form; a late reply can never reopen or mutate it. */
  cancelEdit(): void;
  /** Explicit single-flight owner-only name save. */
  save(): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain write. It keeps
   *  the draft and notes that the current GET is not proof of the write. */
  reconcile(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const initialState: TenantProfileState = {
  phase: 'idle',
  profile: null,
  error: null,
  edit: closedEditState(),
};

export function createTenantProfileController(
  api: TenantProfileApi
): TenantProfileController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: TenantProfileState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** Shared read/write generation: every GET and every PATCH advances it, so
   *  whichever starts later owns the profile commit. An old GET can never
   *  overwrite a confirmed PATCH and an old PATCH can never overwrite a newer
   *  read (or a newer session). */
  const sequence = createCourseSequence();
  const loadGuard = createCourseOperationGuard(tickets);
  const writeGuard = createCourseOperationGuard(tickets);
  /** Draft/form incarnation: cancel or reopen advances it, so a late reply
   *  never closes, reopens or rewrites a different form generation. */
  let editGeneration = 0;
  /** The exact institution the open form is bound to. It is captured from the
   *  server-confirmed identity when the form opens, so a write is only ever
   *  judged against the institution the user is editing: a well-formed DTO for
   *  another institution is never a success for this form. */
  let editTargetId: string | null = null;
  /** The read that owns the visible loading phase. A newer read takes that
   *  ownership over, so a retired read never settles a newer read's phase. */
  let phaseOwner = 0;

  const patch = (changes: Partial<TenantProfileState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchEdit = (changes: Partial<TenantProfileEditState>): void => {
    patch({ edit: { ...state.edit, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  /** The principal the current state and the in-flight generation belong to.
   *  A change observed without a session event (silent logout/scope swap or a
   *  server-side session replacement) is adopted instead of merely dropping
   *  the reply, so no old private identity and no stuck `loading` survive. */
  let observedPrincipal = readPrincipal();

  /** Discards everything in flight and the latches they hold. */
  const retireInFlight = (): void => {
    sequence.invalidate();
    loadGuard.release();
    writeGuard.release();
    editGeneration += 1;
    editTargetId = null;
  };

  /** Closes the form and forgets its institution binding. A late reply can
   *  never reopen it or write a draft into a newer form. */
  const closeEdit = (): void => {
    editGeneration += 1;
    editTargetId = null;
    patchEdit(closedEditState());
  };

  /**
   * Settles the loading phase a retired read owns.
   *
   * The reply of a retired read is never committed — a newer read or write
   * owns the displayed data — but the page must not stay on a phantom
   * `loading` with a valid profile and a retained draft hidden behind it. The
   * phase is restored only when this read still owns it and nobody else has
   * already settled it, so a newer read or write is never mutated.
   */
  const settleReadPhase = (phaseToken: number): void => {
    if (phaseOwner !== phaseToken) return;
    if (state.phase !== 'loading') return;
    patch({ phase: state.profile ? 'ready' : 'idle', error: null });
  };

  /**
   * Settles a save that can no longer commit because a newer read or write
   * owns the displayed state.
   *
   * The reply is never committed and never claims success: the editor leaves
   * `saving` in a usable, truthful state with the draft preserved, and a
   * genuinely unknown write outcome stays explicitly uncertain. A canceled,
   * reopened or invalidated form is never touched, and no request is sent.
   */
  const settleSupersededSave = (
    editToken: number,
    body: unknown | null,
    cause: unknown | null
  ): void => {
    // A newer form (cancel, reopen, invalidation) owns the editor now.
    if (editGeneration !== editToken) return;
    // Somebody already settled the busy state.
    if (state.edit.status !== 'saving') return;
    if (cause !== null) {
      const failure = classifyTenantProfileWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        // The session is gone: clear the private draft and identity. The
        // transport may already have notified a 403 teardown.
        retireInFlight();
        patch({
          phase: 'unauthorized',
          profile: null,
          error: failure.message,
          edit: closedEditState(),
        });
        return;
      }
      if (failure.kind === 'uncertain') {
        // The write may or may not have persisted: it stays explicitly
        // uncertain, the draft and the confirmed profile are preserved and no
        // automatic PATCH retry is sent.
        patchEdit({
          status: 'uncertain',
          error: failure.message,
          notice: PROFILE_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid: the server did not write. The confirmed
      // profile and the draft are preserved for a deliberate retry.
      patchEdit({ status: 'editing', error: failure.message, notice: null });
      return;
    }
    const parsed = parseTenantProfileEnvelope(body);
    if (!parsed.ok || parsed.profile.id !== editTargetId) {
      // A malformed body or another institution's DTO cannot confirm this
      // write: nothing foreign is committed, the draft is preserved, the
      // write stays explicitly uncertain and no retry is sent.
      patchEdit({
        status: 'uncertain',
        error: null,
        notice: PROFILE_WRITE_UNCERTAIN_MESSAGE,
      });
      return;
    }
    // The server confirmed THIS institution's write, but a newer read or
    // write owns the displayed state, so the card is left untouched. The
    // editor returns to a usable state with the draft preserved: a
    // deliberate re-save stays the user's own act (a server-side no-op when
    // the name already matches). This is not a success claim and not a
    // rollback claim.
    patchEdit({ status: 'editing', error: null, notice: null });
  };

  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    // The old generation can no longer commit; both latches are released so a
    // fresh read/save is immediately usable, and the private draft/profile are
    // cleared before any new load starts.
    retireInFlight();
    patch({ phase: 'idle', profile: null, error: null, edit: closedEditState() });
    return true;
  };

  /**
   * Adopts an observed principal change on behalf of a RETIRED operation.
   *
   * A retired operation (a read whose generation was superseded) must observe
   * the canonical principal BEFORE it settles any visible state: a silent
   * logout or scope swap that happened while its reply was on the wire must
   * never be revived by the phase that read owns, and the previous
   * principal's private card and draft are cleared.
   *
   * The latches are deliberately NOT released here: every operation releases
   * its own ticket in its `finally`, so a retired completion can never free a
   * newer operation's latch. The generation and the form generation are
   * invalidated, so nothing in flight can commit into the changed view.
   */
  const adoptRetiredPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    // Nothing that is in flight may commit into the changed principal's view.
    sequence.invalidate();
    // The open form belonged to the previous principal: a late reply can
    // never close or rewrite a newer form.
    editGeneration += 1;
    editTargetId = null;
    patch({ phase: 'idle', profile: null, error: null, edit: closedEditState() });
    return true;
  };

  const track = (operation: Promise<unknown>): void => {
    pending.add(operation);
    void operation.then(
      () => { pending.delete(operation); },
      () => { pending.delete(operation); }
    );
  };

  const reconcileNoticeIfCurrent = (editToken: number): void => {
    if (editGeneration !== editToken) return;
    if (state.edit.status !== 'uncertain') return;
    patchEdit({ notice: PROFILE_RECONCILED_MESSAGE });
  };

  const runLoad = async (reconcile = false): Promise<void> => {
    if (disposed) return;
    // Entry observation: if the principal changed without a notifier, adopt it
    // (retire the old generation, clear the private identity) BEFORE starting.
    const entryPrincipal = readPrincipal();
    adoptPrincipalChange(entryPrincipal);
    // A read is already on the wire: a second load (e.g. a double-clicked
    // Retry while loading) never reaches the transport.
    if (!loadGuard.acquire()) return;
    const ticket = loadGuard.holder();
    const generation = sequence.next();
    const principal = entryPrincipal;
    const editToken = editGeneration;
    // This read owns the visible loading phase until it settles it.
    const phaseToken = ++phaseOwner;
    patch({ phase: 'loading', error: null });
    try {
      const body = await api.loadProfile();
      if (disposed) return;
      if (!sequence.isCurrent(generation)) {
        // The canonical principal is observed BEFORE any visible state is
        // settled: a silent logout or scope swap that happened while this
        // reply was on the wire must never be revived by the phase this read
        // owns, and the previous principal's card and draft are cleared.
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) {
          return;
        }
        // A newer read or write owns the displayed data, so this reply is
        // never committed. The phase this read owns is still settled, so the
        // page does not stay on a phantom `loading`.
        settleReadPhase(phaseToken);
        return;
      }
      // Completion observation: a principal swapped while the reply was on the
      // wire makes this reply foreign. Adopt the change now, so the view is
      // cleared and retry/new load are usable instead of stuck on `loading`
      // with the previous principal's identity.
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const parsed = parseTenantProfileEnvelope(body);
      if (!parsed.ok) {
        // A missing or malformed body is an error, never fabricated identity.
        patch({ phase: 'error', profile: null, error: MALFORMED_PROFILE_MESSAGE });
        return;
      }
      patch({ phase: 'ready', profile: parsed.profile, error: null });
      // A current read that changes the confirmed institution invalidates an
      // open form: its draft belonged to the previous institution and can
      // never be written to the new one.
      if (editTargetId !== null && editTargetId !== parsed.profile.id) {
        closeEdit();
      }
      if (reconcile) reconcileNoticeIfCurrent(editToken);
    } catch (cause) {
      if (disposed) return;
      if (!sequence.isCurrent(generation)) {
        // The canonical principal is observed BEFORE any visible state is
        // settled, exactly as on the success path: a retired failure must
        // never revive the previous principal's card, draft or phase.
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) {
          return;
        }
        // A retired read never reports its own failure over the newer
        // operation's state; it only settles the phase it owns.
        settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      // Failure CLEARS the identity instead of retaining a prior session's
      // institution.
      const failure = classifyTenantProfileFailure(cause);
      patch({ phase: failure.phase, profile: null, error: failure.message });
    } finally {
      // Only its own ticket: a retired load's `finally` can never release a
      // newer load's latch.
      loadGuard.release(ticket);
    }
  };

  const runSave = async (): Promise<void> => {
    if (disposed) return;
    if (!api.updateProfile) return;
    if (state.edit.status !== 'editing' && state.edit.status !== 'uncertain') return;

    const rawDraft = state.edit.draft;
    const name = rawDraft.trim();
    if (name.length < 1 || name.length > 255) {
      // Local validation happens BEFORE any request and keeps the user's input.
      patchEdit({ status: 'editing', error: PROFILE_NAME_INVALID_MESSAGE, notice: null });
      return;
    }

    // The write is bound to the exact institution the form was opened for AND
    // to the institution the card currently shows. A form whose target is no
    // longer the confirmed identity is invalidated and NO request is sent.
    const targetId = editTargetId;
    if (targetId === null || !state.profile || state.profile.id !== targetId) {
      closeEdit();
      return;
    }

    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (disposed) return;

    // Synchronous single-flight: a second click/Enter before the first await
    // never reaches the transport.
    if (!writeGuard.acquire()) return;
    const ticket = writeGuard.holder();
    const generation = sequence.next();
    const editToken = editGeneration;
    const principal = entryPrincipal;
    patchEdit({ status: 'saving', error: null, notice: null });
    try {
      const body = await api.updateProfile(name);
      if (disposed) return;
      // A newer read, a newer save or a session change owns the profile now.
      if (!sequence.isCurrent(generation)) {
        // The reply is never committed, but the editor must not stay
        // `saving` forever: the operation settles the state it owns.
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededSave(editToken, body, null);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const parsed = parseTenantProfileEnvelope(body);
      if (!parsed.ok) {
        // A 2xx success with a body that cannot be validated is not success.
        if (editGeneration !== editToken) return;
        patchEdit({
          status: 'uncertain',
          error: null,
          notice: PROFILE_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      if (parsed.profile.id !== targetId) {
        // A well-formed DTO for ANOTHER institution is not a success for this
        // form: nothing is committed to the card, the draft is preserved, the
        // write stays explicitly uncertain and no retry is sent.
        if (editGeneration !== editToken) return;
        patchEdit({
          status: 'uncertain',
          error: null,
          notice: PROFILE_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Server-confirmed identity only. The card updates; no extra GET.
      patch({ phase: 'ready', profile: parsed.profile, error: null });
      if (editGeneration === editToken) {
        editTargetId = null;
        patchEdit(closedEditState());
      }
    } catch (cause) {
      if (disposed) return;
      if (!sequence.isCurrent(generation)) {
        // A retired save never reports its own failure over the newer
        // operation's state; it only settles the editor it owns.
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return;
        }
        settleSupersededSave(editToken, null, cause);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyTenantProfileWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        // The session is gone: clear the private draft and identity. The
        // transport may already have notified a 403 teardown.
        retireInFlight();
        patch({
          phase: 'unauthorized',
          profile: null,
          error: failure.message,
          edit: closedEditState(),
        });
        return;
      }
      // A canceled/reopened form is never mutated by a late failure.
      if (editGeneration !== editToken) return;
      if (failure.kind === 'uncertain') {
        // Preserve the draft and the valid read-authorized profile. No
        // automatic PATCH retry; the page offers a deliberate GET reconcile.
        patchEdit({
          status: 'uncertain',
          error: failure.message,
          notice: PROFILE_WRITE_UNCERTAIN_MESSAGE,
        });
        return;
      }
      // Denied/conflict/invalid: the server did not write. Keep the profile
      // and the draft; the user can correct or retry explicitly.
      patchEdit({ status: 'editing', error: failure.message, notice: null });
    } finally {
      // Only its own ticket: an old/retired save never releases a newer save.
      writeGuard.release(ticket);
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal (or a logout): every in-flight reply is foreign,
        // the private identity and draft are cleared BEFORE the new load
        // starts, and the new load is fenced like any other. A → B → A
        // therefore always shows B's or A's own server-confirmed profile,
        // never a mixed one. The observed principal is recorded here so the
        // fresh read is not treated as a second, duplicate change at entry.
        retireInFlight();
        observedPrincipal = readPrincipal();
        patch({ phase: 'idle', profile: null, error: null, edit: closedEditState() });
        track(runLoad());
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    // The view is gone: return to the initial state, so no confirmed
    // institution, failure message, draft or in-flight phase outlives it.
    patch({ phase: 'idle', profile: null, error: null, edit: closedEditState() });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    load: () => {
      const operation = runLoad();
      track(operation);
      return operation;
    },
    refresh: () => {
      const operation = runLoad();
      track(operation);
      return operation;
    },
    openEditor: () => {
      if (disposed) return;
      if (state.phase !== 'ready' || !state.profile) return;
      if (state.edit.status === 'saving' || state.edit.status === 'uncertain') return;
      editGeneration += 1;
      // The form is bound to the exact confirmed institution it was opened
      // for: a write is only ever judged against this identity, and a current
      // read that changes it invalidates the form.
      editTargetId = state.profile.id;
      patchEdit({
        status: 'editing',
        draft: state.profile.business_name,
        error: null,
        notice: null,
      });
    },
    updateDraft: (value) => {
      if (disposed) return;
      if (state.edit.status !== 'editing' && state.edit.status !== 'uncertain') return;
      patchEdit({ status: 'editing', draft: value, error: null, notice: null });
    },
    cancelEdit: () => {
      if (disposed) return;
      if (state.edit.status === 'closed') return;
      closeEdit();
    },
    save: () => {
      const operation = runSave();
      track(operation);
      return operation;
    },
    reconcile: () => {
      if (disposed) return Promise.resolve();
      // Deliberate, explicit GET only after an uncertain write. It never
      // retries the PATCH and never clears the preserved draft.
      if (state.edit.status !== 'uncertain') return Promise.resolve();
      const operation = runLoad(true);
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
