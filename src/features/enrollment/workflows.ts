/**
 * M2-01 enrollment orchestration seam — the smallest production module the
 * three enrollment journeys (src/pages/JoinInstructor.tsx,
 * src/pages/TenantInvitation.tsx, src/pages/StudentSpaces.tsx) delegate to.
 *
 * It exists to separate the testable orchestration (single-flight, stale-reply
 * invalidation, identity-swap guards) from React rendering. No generic
 * framework: transport, storage and the session notifier are injected, so the
 * exact production code the pages run is exercised hermetically in node:test
 * (src/tests/m2-*.test.ts) with no DB, network, browser or live app.
 *
 * Contracts (verified from source, documented in
 * docs/streams/client/M2-CONTRACTS.md):
 *  - the server is the source of truth: a journey advances only on a
 *    server-confirmed outcome; a thrown api-http error carries the server's
 *    message, not the HTTP status (api-http.ts:69-89);
 *  - exactly one request per operation: a synchronous latch is acquired
 *    before the first await, so a duplicate fired before the re-render never
 *    reaches the transport;
 *  - a superseded/reversed reply never commits: every load/selection carries a
 *    monotonic generation, and dispose() invalidates everything in flight;
 *  - distinct loading / empty / expired / denied / error states, form input
 *    retained on failure (the controllers never own form data);
 *  - no previous identity is displayed after a token swap: when the scoped
 *    profile read fails after the token rotated, the stale identity keys are
 *    removed (the old token is never restored, success is never implied).
 *
 * session-events notification order (M2-CONTRACTS §0): selectStudentSpace
 * persists the new token and notifies 'token' inside api-http; the identity
 * write below happens after that, and only the COMPLETE mutation notifies
 * 'scope' (or 'identity' when the stale identity is discarded).
 */
import type { EnrollmentInviteInfo, Student, StudentSpace } from '../../lib/api';
import { notifySessionChange, type SessionChangeKind } from '../../lib/session-events';

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Server-fixed messages that identify a failure kind on these routes
 *  (M2-CONTRACTS.md §1). The shared HTTP client throws the server's `error`
 *  string without the status code (api-http.ts:69-89), so these documented
 *  strings — and an optional `status` property a transport may attach — are
 *  the only honest classification signals. */
export const INVITE_NOT_FOUND_MESSAGE = 'Invitation is invalid or expired';
export const TENANT_INVITATION_NOT_FOUND_MESSAGE = 'Invitation invalid or expired';
export const JOIN_DENIED_MESSAGE = 'Only students can join an instructor';
export const STUDENT_ACCESS_DENIED_MESSAGE = 'Student access required';

export type EnrollmentFailureKind = 'expired' | 'denied' | 'unavailable' | 'error';

export interface EnrollmentFailure {
  readonly kind: EnrollmentFailureKind;
  readonly message: string;
}

export function classifyEnrollmentFailure(cause: unknown): EnrollmentFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? 'unknown error');
  const status =
    typeof cause === 'object' && cause !== null ? (cause as { status?: unknown }).status : undefined;
  if (
    status === 404 || status === 410 ||
    message === INVITE_NOT_FOUND_MESSAGE || message === TENANT_INVITATION_NOT_FOUND_MESSAGE
  ) {
    return { kind: 'expired', message };
  }
  if (status === 403 || message === JOIN_DENIED_MESSAGE || message === STUDENT_ACCESS_DENIED_MESSAGE) {
    return { kind: 'denied', message };
  }
  if (status === 429 || status === 503) {
    return { kind: 'unavailable', message };
  }
  return { kind: 'error', message };
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

export interface EnrollmentGuard {
  /** Must be called BEFORE the first await: a same-tick duplicate (two
   *  clicks, click + Enter) is rejected before any request leaves the page. */
  acquire(): boolean;
  /** Ticket of the operation that currently owns the latch; `0` when free. */
  holder(): number;
  /** Frees the latch ONLY when `token` still owns it, so a superseded
   *  operation's `finally` can never release a NEWER operation's latch (that
   *  would let a duplicate through while the newer one is in flight).
   *  Called WITHOUT a token it is the unconditional retire used by the
   *  lifecycle paths — route/fragment/identity change and unmount — that
   *  discard the in-flight operation on purpose. */
  release(token?: number): void;
  isBusy(): boolean;
}

export function createEnrollmentGuard(): EnrollmentGuard {
  let owner = 0;
  let tickets = 0;
  return {
    acquire: () => {
      if (owner !== 0) return false;
      tickets += 1;
      owner = tickets;
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
 *  when its generation is still current — a superseded load (invitation
 *  A→B→A), a reversed completion or a post-unmount settlement never commits.
 *  `current()` captures the generation WITHOUT advancing it, which is what a
 *  mutation needs: the mutation is fenced against a later invalidation
 *  instead of invalidating everything before it. */
export function createEnrollmentSequence(): {
  next(): number;
  current(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
} {
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
// Journey 1 — instructor join invitation (src/pages/JoinInstructor.tsx)
// ---------------------------------------------------------------------------

export interface JoinInviteForm {
  student_name: string;
  phone: string;
  guardian_name: string;
  guardian_phone: string;
  password?: string;
  grade_id: string;
  group_id: string;
  requested_courses: string[];
}

export interface JoinInviteApi {
  loadInvite: (token: string) => Promise<EnrollmentInviteInfo>;
  submitRequest: (token: string, form: JoinInviteForm) => Promise<{ message: string }>;
  requestReset: (token: string, phone: string) => Promise<{ message: string }>;
  /** Optional session-identity reader (the page injects the canonical stored
   *  identity; tests inject their own). When supplied, a mutation that
   *  started under one identity never commits after the identity changed —
   *  the password-required precondition it was submitted under no longer
   *  holds. It returns a comparable KEY, never the identity itself. */
  readIdentity?: () => string | null;
}

/** `incomplete` = the route carries no invitation token: the link is broken,
 *  never "loading" and never a retryable server error. */
export type JoinInvitePhase = 'loading' | 'incomplete' | 'ready' | 'expired' | 'denied' | 'error';

export interface JoinInviteState {
  readonly phase: JoinInvitePhase;
  /** Token the current state belongs to. */
  readonly token: string;
  readonly info: EnrollmentInviteInfo | null;
  /** Load-failure message (server's own text). */
  readonly message: string | null;
  readonly failure: EnrollmentFailure | null;
  /** Submit/reset failure message; the form is retained. */
  readonly actionError: string | null;
  readonly busyKind: 'submit' | 'reset' | null;
  /** Server accepted the join request: queued for instructor review — never an
   *  approval (the public 202 message is identical for suppressed
   *  duplicates, M2-CONTRACTS §1.2). */
  readonly submitted: boolean;
  readonly resetSent: boolean;
}

export type JoinSubmitOutcome = 'submitted' | 'blocked' | 'invalid' | 'failed';
export type PasswordResetOutcome = 'sent' | 'blocked' | 'invalid' | 'failed';

export interface JoinInviteController {
  getState: () => JoinInviteState;
  subscribe: (listener: (state: JoinInviteState) => void) => () => void;
  loadInvite: (token: string) => Promise<void>;
  submit: (form: JoinInviteForm, options?: { passwordRequired?: boolean }) => Promise<JoinSubmitOutcome>;
  requestPasswordReset: (phone: string) => Promise<PasswordResetOutcome>;
  /** Re-reads the session identity. A change retires every in-flight
   *  mutation: it started under a principal that is no longer the one using
   *  the page. Called by the page on the session-change contract. */
  syncIdentity: () => void;
  /** Unmount: nothing in flight may commit afterwards. */
  dispose: () => void;
}

function isInviteInfo(value: unknown): value is EnrollmentInviteInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EnrollmentInviteInfo>;
  return (
    typeof candidate.business_name === 'string' &&
    typeof candidate.expires_at === 'string' &&
    Array.isArray(candidate.grades) &&
    Array.isArray(candidate.groups) &&
    Array.isArray(candidate.courses)
  );
}

/**
 * Drops grade/group/course selections the loaded invitation no longer offers
 * (e.g. after a token change A→B→A). Returns the SAME object when everything
 * still matches, so the page may call it on every info commit without render
 * loops. The server re-validates the submitted selection (student-enrollment.ts:
 * 118-122); this only avoids sending a doomed request and hides options the
 * new invitation does not contain.
 */
export function reconcileInviteSelection(form: JoinInviteForm, info: EnrollmentInviteInfo | null): JoinInviteForm {
  if (!info) return form;
  const gradeId = info.grades.some((grade) => grade.id === form.grade_id) ? form.grade_id : '';
  const groupId = info.groups.some((group) => group.id === form.group_id && group.grade_id === gradeId)
    ? form.group_id
    : '';
  const requestedCourses = form.requested_courses.filter((id) => info.courses.some((course) => course.id === id));
  if (
    gradeId === form.grade_id &&
    groupId === form.group_id &&
    requestedCourses.length === form.requested_courses.length
  ) {
    return form;
  }
  return { ...form, grade_id: gradeId, group_id: groupId, requested_courses: requestedCourses };
}

const initialJoinInviteState: JoinInviteState = {
  phase: 'loading',
  token: '',
  info: null,
  message: null,
  failure: null,
  actionError: null,
  busyKind: null,
  submitted: false,
  resetSent: false,
};

export function createJoinInviteController(api: JoinInviteApi): JoinInviteController {
  let state = initialJoinInviteState;
  let disposed = false;
  let identity = api.readIdentity?.() ?? null;
  /** Guard ticket that currently owns `state.busyKind` (`null` when idle).
   *  Only the owner may clear or replace the busy marker, so a retired
   *  operation's late completion can never clear a NEWER operation's busy
   *  state — the same fencing the ticket-scoped latch release guarantees
   *  (supervisor/049). */
  let busyOwner: number | null = null;
  const guard = createEnrollmentGuard();
  const sequence = createEnrollmentSequence();
  const listeners = new Set<(state: JoinInviteState) => void>();

  const patch = (changes: Partial<JoinInviteState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  /** Retires every in-flight operation AND the latch it holds. A superseded
   *  mutation must not keep the journey busy: the new route must be able to
   *  act immediately, and the old operation's `finally` cannot release the
   *  new operation's ticket (it no longer owns it). */
  const retireInFlight = (): void => {
    sequence.invalidate();
    guard.release();
  };

  /** A mutation may commit only while it is still the operation the page is
   *  waiting for: not disposed, not superseded by a newer generation, still
   *  the same invitation token, and still the same session identity. */
  const isMutationCurrent = (generation: number, token: string, principal: string | null): boolean => {
    if (disposed || !sequence.isCurrent(generation) || state.token !== token) return false;
    // Completion honors the ACTUAL injected identity, not only the copy the
    // same-document session bus last cached: a silent replacement (a storage
    // write that bypassed notifySessionChange) still forfeits the commit
    // (supervisor/051). Without the seam the cached copy is the best oracle.
    const currentIdentity = api.readIdentity ? api.readIdentity() : identity;
    return currentIdentity === principal;
  };

  /** An operation that settled as OBSOLETE (a superseded route, disposal, or a
   *  silently replaced principal — supervisor/051/054) has SETTLED: it must
   *  not strand the journey in a permanent busy state, because the page
   *  disables its controls from `busyKind` and the operation will never run
   *  again. The marker is cleared ONLY while this operation still owns it —
   *  a newer operation owns its own marker and is never reset from here (its
   *  latch is already protected by the ticket-scoped release in the
   *  `finally`). The cached principal is at the same time refreshed from the
   *  ACTUAL injected reader, so a deliberate retry by the CURRENT principal
   *  is not misclassified as obsolete — without a reload, without a
   *  session-bus event and with NO automatic replay of any request. */
  const retireObsoleteBusy = (ticket: number): void => {
    if (api.readIdentity) identity = api.readIdentity();
    if (busyOwner === ticket) {
      busyOwner = null;
      patch({ busyKind: null });
    }
  };

  const loadInvite = async (token: string): Promise<void> => {
    // ANY route change — including an EMPTY token (the link lost its segment)
    // — retires the previous invitation and everything in flight on it. The
    // old token's success/error may never land under a different route.
    retireInFlight();
    if (disposed) return;
    const tokenText = token.trim();
    // Previous invitation data is cleared synchronously with the new token:
    // no stale business name, grades, groups or success state may remain
    // visible under a different invitation.
    patch({
      phase: tokenText ? 'loading' : 'incomplete',
      token: tokenText,
      info: null,
      message: tokenText ? null : 'رابط الانضمام غير مكتمل.',
      failure: null,
      actionError: null,
      busyKind: null,
      submitted: false,
      resetSent: false,
    });
    // A route change already retired the in-flight operation and its marker:
    // no stale ticket may still be considered the busy owner.
    busyOwner = null;
    // An incomplete link is a client-side fact: never a request, never a
    // retryable server error.
    if (!tokenText) return;
    const generation = sequence.next();
    try {
      const info = await api.loadInvite(token);
      if (!sequence.isCurrent(generation)) return; // superseded (A→B→A, reversed completion, unmount)
      if (!isInviteInfo(info)) {
        // A malformed body is not an invitation; fail closed instead of
        // rendering an empty form.
        const failure: EnrollmentFailure = { kind: 'error', message: 'استجابة غير صالحة من الخادم' };
        patch({ phase: 'error', info: null, message: failure.message, failure });
        return;
      }
      patch({ phase: 'ready', info, message: null, failure: null });
    } catch (cause) {
      if (!sequence.isCurrent(generation)) return; // a stale failure must not clobber newer state
      const failure = classifyEnrollmentFailure(cause);
      patch({
        phase: failure.kind === 'expired' ? 'expired' : failure.kind === 'denied' ? 'denied' : 'error',
        info: null,
        message: failure.message,
        failure,
      });
    }
  };

  const submit = async (
    form: JoinInviteForm,
    options?: { passwordRequired?: boolean },
  ): Promise<JoinSubmitOutcome> => {
    if (disposed || state.submitted) return 'blocked';
    if (state.phase !== 'ready' || !state.info) return 'blocked'; // no request without a current invitation
    if (options?.passwordRequired) {
      const length = (form.password ?? '').length;
      if (length < 10 || length > 128) {
        patch({ actionError: 'كلمة المرور يجب ألا تقل عن 10 أحرف.' });
        return 'invalid';
      }
    }
    if (reconcileInviteSelection(form, state.info) !== form) {
      // The selection is no longer part of the loaded contract: do not send a
      // request the server must reject; the page keeps the form values.
      patch({ actionError: 'اختيار الصف أو المجموعة لم يعد مطابقًا للدعوة المحمَّلة.' });
      return 'invalid';
    }
    if (!guard.acquire()) return 'blocked'; // synchronous single-flight: duplicate rejected before render
    const ticket = guard.holder();
    // Re-read the ACTUAL principal at the operation boundary: a silent
    // replacement that happened BEFORE this operation must not let a stale
    // cached copy misclassify this deliberate new operation as obsolete
    // (supervisor/054). Nothing else is in flight while we hold the latch.
    if (api.readIdentity) identity = api.readIdentity();
    // Captured BEFORE the await: this submit belongs to THIS invitation,
    // THIS generation and THIS principal. A later route/identity change
    // retires it (supervisor/049 counterexamples 1 and 2).
    const generation = sequence.current();
    const token = state.token;
    const principal = identity;
    busyOwner = ticket;
    patch({ busyKind: 'submit', actionError: null });
    try {
      await api.submitRequest(token, form);
      if (!isMutationCurrent(generation, token, principal)) {
        // The invitation, generation or principal changed under the request:
        // its success belongs to the old context and must not commit. The
        // operation has SETTLED — retire its busy marker so the journey is
        // not left busy forever (supervisor/054).
        retireObsoleteBusy(ticket);
        return 'blocked';
      }
      // 202 + the server's public message = the request is queued for the
      // instructor's review (M2-CONTRACTS §1.2). Nothing is approved here.
      busyOwner = null;
      patch({ submitted: true, busyKind: null });
      return 'submitted';
    } catch (cause) {
      if (!isMutationCurrent(generation, token, principal)) {
        retireObsoleteBusy(ticket);
        return 'blocked';
      }
      // The form values stay in the page; only the error is surfaced.
      busyOwner = null;
      patch({ busyKind: null, actionError: classifyEnrollmentFailure(cause).message });
      return 'failed';
    } finally {
      // Ticket-scoped: an old finally never releases a newer operation.
      guard.release(ticket);
    }
  };

  const requestPasswordReset = async (phone: string): Promise<PasswordResetOutcome> => {
    const trimmed = phone.trim();
    if (disposed) return 'blocked';
    if (!trimmed) {
      patch({ actionError: 'أدخل رقم هاتف الطالب أولًا.' });
      return 'invalid';
    }
    if (state.phase !== 'ready' || !state.info) return 'blocked';
    if (!guard.acquire()) return 'blocked'; // same latch as submit: one operation at a time
    const ticket = guard.holder();
    // Same operation-boundary re-read as submit: a principal replaced before
    // this reset starts must not misclassify it (supervisor/054).
    if (api.readIdentity) identity = api.readIdentity();
    const generation = sequence.current();
    const token = state.token;
    const principal = identity;
    busyOwner = ticket;
    patch({ busyKind: 'reset', actionError: null });
    try {
      await api.requestReset(token, trimmed);
      if (!isMutationCurrent(generation, token, principal)) {
        // Obsolete: no stale commit — and the settled operation must not
        // leave the journey busy (supervisor/054).
        retireObsoleteBusy(ticket);
        return 'blocked';
      }
      busyOwner = null;
      patch({ resetSent: true, busyKind: null });
      return 'sent';
    } catch (cause) {
      if (!isMutationCurrent(generation, token, principal)) {
        retireObsoleteBusy(ticket);
        return 'blocked';
      }
      busyOwner = null;
      patch({ busyKind: null, actionError: classifyEnrollmentFailure(cause).message });
      return 'failed';
    } finally {
      guard.release(ticket);
    }
  };

  const syncIdentity = (): void => {
    const next = api.readIdentity?.() ?? null;
    if (next === identity) return;
    identity = next;
    // A different principal must never inherit the previous one's in-flight
    // mutation: retire them and drop the busy marker they left behind. The
    // terminal submitted/resetSent flags stay: they are facts about what the
    // server already accepted for THIS link, and clearing them would invite
    // a duplicate request under the new identity.
    retireInFlight();
    busyOwner = null;
    patch({ busyKind: null, actionError: null });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadInvite,
    submit,
    requestPasswordReset,
    syncIdentity,
    dispose: () => {
      disposed = true;
      retireInFlight();
    },
  };
}

// ---------------------------------------------------------------------------
// Journey 2 — tenant invitation activation (src/pages/TenantInvitation.tsx)
// ---------------------------------------------------------------------------

export interface TenantActivationApi {
  redeem: (token: string, password: string) => Promise<{ success?: boolean }>;
  /** Live fragment-token source; the page injects window.location.hash. */
  readToken: () => string;
}

export type TenantActivationStatus = 'form' | 'activating' | 'activated' | 'failed';

export interface TenantActivationState {
  readonly status: TenantActivationStatus;
  readonly token: string;
  /** Validation or server-failure message. */
  readonly message: string | null;
  readonly failure: EnrollmentFailure | null;
}

export type TenantActivationOutcome = 'activated' | 'blocked' | 'duplicate' | 'invalid' | 'failed';

/** Reads the invitation token from the URL fragment (`#token=…`), preserving
 *  the exact semantics the page had. The token is never logged. */
export function parseFragmentToken(hash: string): string {
  const query = hash.startsWith('#') ? hash.slice(1) : hash;
  return new URLSearchParams(query).get('token') || '';
}

/** Client-side mirror of the server's declared bounds (M2-CONTRACTS §1.7);
 *  the server remains the authority and re-validates the token and password. */
export function validateTenantActivation(token: string, password: string, confirmed: string): string | null {
  if (!token) return 'رابط الدعوة غير مكتمل.';
  if (password.length < 12) return 'كلمة المرور يجب ألا تقل عن 12 حرفًا.';
  if (password.length > 128) return 'كلمة المرور يجب ألا تزيد عن 128 حرفًا.';
  if (password !== confirmed) return 'كلمتا المرور غير متطابقتين.';
  return null;
}

export interface TenantActivationController {
  getState: () => TenantActivationState;
  subscribe: (listener: (state: TenantActivationState) => void) => () => void;
  /** Lifecycle guard: re-reads the fragment token (hashchange) before use. */
  syncToken: () => void;
  activate: (password: string, confirmed: string) => Promise<TenantActivationOutcome>;
  dispose: () => void;
}

export function createTenantActivationController(api: TenantActivationApi): TenantActivationController {
  let state: TenantActivationState = {
    status: 'form',
    token: api.readToken(),
    message: null,
    failure: null,
  };
  let disposed = false;
  const guard = createEnrollmentGuard();
  const sequence = createEnrollmentSequence();
  const listeners = new Set<(state: TenantActivationState) => void>();

  const patch = (changes: Partial<TenantActivationState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const syncToken = (): void => {
    const token = api.readToken();
    // Every fragment lifecycle event retires the activation bound to the
    // PREVIOUS fragment — including when the text is identical (A → B → A
    // must not revive an old activation), because the fragment is the
    // authority and a lifecycle event means the document's invitation may
    // have been replaced. Any in-flight redeem then loses both its
    // generation and the latch it holds, so the page is usable immediately.
    sequence.invalidate();
    guard.release();
    const status = state.status === 'activating' ? 'form' : state.status;
    if (token !== state.token || status !== state.status) {
      patch({ token, status, message: null, failure: null });
    }
  };

  const activate = async (password: string, confirmed: string): Promise<TenantActivationOutcome> => {
    if (disposed) return 'blocked';
    if (state.status === 'activating') return 'duplicate';
    if (state.status === 'activated') return 'blocked';
    syncToken(); // lifecycle guard: re-read the fragment before every attempt
    if (disposed) return 'blocked';
    const token = state.token;
    const validation = validateTenantActivation(token, password, confirmed);
    if (validation) {
      patch({ status: 'form', message: validation, failure: null });
      return 'invalid';
    }
    if (!guard.acquire()) return 'duplicate'; // synchronous single-flight: no second redeem before render
    const ticket = guard.holder();
    const generation = sequence.current();
    patch({ status: 'activating', message: null, failure: null });
    try {
      const result = await api.redeem(token, password);
      if (disposed || !sequence.isCurrent(generation) || state.token !== token) {
        // The fragment changed under the request: this success belongs to the
        // OLD invitation and must never activate — nor let the page wipe —
        // the link that is displayed now (supervisor/049 counterexample 2).
        return 'blocked';
      }
      // { success: true } from the server is the ONLY activation signal
      // (tenant-invitations.ts:31); anything else fails closed.
      if (!result || result.success !== true) {
        const failure: EnrollmentFailure = { kind: 'error', message: 'تعذر تفعيل الدعوة' };
        patch({ status: 'failed', message: failure.message, failure });
        return 'failed';
      }
      patch({ status: 'activated', message: null, failure: null });
      return 'activated';
    } catch (cause) {
      if (disposed || !sequence.isCurrent(generation) || state.token !== token) return 'blocked';
      const failure = classifyEnrollmentFailure(cause);
      patch({ status: 'failed', message: failure.message, failure });
      return 'failed';
    } finally {
      // Ticket-scoped: an old finally never releases a newer activation.
      guard.release(ticket);
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncToken,
    activate,
    dispose: () => {
      disposed = true;
      sequence.invalidate();
      guard.release();
    },
  };
}

// ---------------------------------------------------------------------------
// Journey 3 — student space selection (src/pages/StudentSpaces.tsx)
// ---------------------------------------------------------------------------

/** Minimal storage seam (the page injects a localStorage adapter; tests inject
 *  an in-memory map). Keys match the canonical session keys in api-http.ts. */
export interface EnrollmentStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const CURRENT_STUDENT_KEY = 'currentStudent';
export const CURRENT_STUDENT_SPACE_KEY = 'currentStudentSpace';

export interface StudentSpacesApi {
  loadSpaces: () => Promise<StudentSpace[]>;
  selectSpace: (studentEnrollmentId: string) => Promise<{
    token: string;
    tenant_id: string;
    student_enrollment_id: string;
  }>;
  loadProfile: () => Promise<Student & { tenant_id: string; business_name: string }>;
}

export interface StudentSpacesHooks {
  storage: EnrollmentStorage;
  /** Defaults to the real session bus; injected in tests. */
  notify?: (kind: SessionChangeKind) => void;
  /** Called after a complete, server-confirmed selection (the page navigates). */
  onSelected?: () => void;
  /** Reader for the canonical auth token (api-http stores it under
   *  `authToken`; `selectStudentSpace` writes the rotated token there,
   *  api-http.ts:2278). When supplied, the identity may only be persisted
   *  while the token in storage is EXACTLY the one this selection rotated
   *  to — a logout, another session's login or a server-side revocation
   *  replaced it, and writing then would persist a previous identity under a
   *  session that is no longer ours. Returns the token only for comparison;
   *  it is never stored, logged or returned by the controller. */
  readAuthToken?: () => string | null;
}

export type StudentSpacesPhase = 'loading' | 'ready' | 'empty' | 'error';

export interface StudentSpacesState {
  readonly phase: StudentSpacesPhase;
  readonly spaces: StudentSpace[];
  /** List-read failure message. */
  readonly message: string | null;
  readonly failure: EnrollmentFailure | null;
  /** Row currently being opened (single in-flight selection). */
  readonly selectingId: string | null;
  /** Selection / profile failure message; the list stays usable. */
  readonly selectionError: string | null;
  /** The token was already rotated for this enrollment but the scoped profile
   *  read failed: retry the profile read only — never re-select, never restore
   *  the old token. */
  readonly pendingIdentityLoad: boolean;
}

export type StudentSpaceSelectOutcome = 'selected' | 'blocked' | 'duplicate' | 'failed' | 'profile-failed';
export type StudentIdentityRetryOutcome = 'selected' | 'blocked' | 'duplicate' | 'failed';

export interface StudentSpacesController {
  getState: () => StudentSpacesState;
  subscribe: (listener: (state: StudentSpacesState) => void) => () => void;
  loadSpaces: () => Promise<void>;
  select: (space: StudentSpace) => Promise<StudentSpaceSelectOutcome>;
  retryIdentityLoad: () => Promise<StudentIdentityRetryOutcome>;
  /** Unmount: nothing in flight may commit afterwards. */
  dispose: () => void;
}

type StudentProfile = Student & { tenant_id: string; business_name: string };

function isStudentProfile(value: unknown): value is StudentProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StudentProfile>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.tenant_id === 'string' &&
    typeof candidate.business_name === 'string'
  );
}

const initialStudentSpacesState: StudentSpacesState = {
  phase: 'loading',
  spaces: [],
  message: null,
  failure: null,
  selectingId: null,
  selectionError: null,
  pendingIdentityLoad: false,
};

export function createStudentSpacesController(
  api: StudentSpacesApi,
  hooks: StudentSpacesHooks,
): StudentSpacesController {
  const notify = hooks.notify ?? notifySessionChange;
  let state = initialStudentSpacesState;
  let disposed = false;
  let pendingEnrollmentId: string | null = null;
  /** The token OUR rotation wrote, kept so a retry can prove the session is
   *  still the one the pending identity belongs to. */
  let pendingRotationToken: string | null = null;
  const guard = createEnrollmentGuard();
  const sequence = createEnrollmentSequence();
  const listeners = new Set<(state: StudentSpacesState) => void>();

  const patch = (changes: Partial<StudentSpacesState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  /** External-session boundary: true while the token in storage is still the
   *  one this selection rotated to. Without the injected reader the boundary
   *  cannot be evaluated at all and is skipped rather than guessed. */
  const isRotationTokenCurrent = (rotationToken: string): boolean =>
    !hooks.readAuthToken || hooks.readAuthToken() === rotationToken;

  const loadSpaces = async (): Promise<void> => {
    const generation = sequence.next();
    // Explicit loading state: an empty list may only render AFTER the read
    // completed — never while it is in flight.
    patch({ phase: 'loading', spaces: [], message: null, failure: null, selectionError: null, pendingIdentityLoad: false });
    try {
      const spaces = await api.loadSpaces();
      if (!sequence.isCurrent(generation)) return;
      if (!Array.isArray(spaces)) {
        // A malformed non-array body is invalid server data, not "no
        // membership": conflating the two hid the failure.
        const failure: EnrollmentFailure = { kind: 'error', message: 'استجابة غير صالحة من الخادم' };
        patch({ phase: 'error', spaces: [], message: failure.message, failure });
        return;
      }
      patch({ phase: spaces.length ? 'ready' : 'empty', spaces, message: null, failure: null });
    } catch (cause) {
      if (!sequence.isCurrent(generation)) return;
      const failure = classifyEnrollmentFailure(cause);
      patch({ phase: 'error', spaces: [], message: failure.message, failure });
    }
  };

  /** Drops the stored identity — but ONLY while storage still holds exactly
   *  the identity that existed when this selection began (`baselineStudent` /
   *  `baselineSpace`). The caller captured that baseline synchronously, before
   *  any await, so it represents the previous space's stale identity. If
   *  either key has since changed, a DIFFERENT (newer) session installed its
   *  own identity; an obsolete operation must then neither erase it nor notify
   *  (supervisor/051). Returns whether the discard actually happened. */
  const discardStoredIdentity = (baselineStudent: string | null, baselineSpace: string | null): boolean => {
    if (
      hooks.storage.getItem(CURRENT_STUDENT_KEY) !== baselineStudent ||
      hooks.storage.getItem(CURRENT_STUDENT_SPACE_KEY) !== baselineSpace
    ) {
      return false;
    }
    hooks.storage.removeItem(CURRENT_STUDENT_KEY);
    hooks.storage.removeItem(CURRENT_STUDENT_SPACE_KEY);
    notify('identity');
    return true;
  };

  /** Persists the scoped profile as the canonical identity. Only the server's
   *  profile (enrollment id matching the rotation response) may commit; a
   *  mismatch fails closed. */
  const commitIdentity = (profile: StudentProfile, enrollmentId: string): boolean => {
    if (!isStudentProfile(profile) || profile.id !== enrollmentId) return false;
    hooks.storage.setItem(CURRENT_STUDENT_KEY, JSON.stringify(profile));
    // The stored space row is derived from the server profile, never from the
    // clicked list row (that row came from the previous token's list).
    hooks.storage.setItem(
      CURRENT_STUDENT_SPACE_KEY,
      JSON.stringify({
        student_enrollment_id: enrollmentId,
        tenant_id: profile.tenant_id,
        business_name: profile.business_name,
        grade_id: profile.grade_id ?? null,
        group_id: profile.group_id ?? null,
        grade_name: profile.grade_name ?? null,
        group_name: profile.group_name ?? null,
      }),
    );
    // Same-document scope change: notify only after the complete identity
    // mutation, so subscribers cached for the previous space react before a
    // stale response can commit (session-events contract, M2-CONTRACTS §0).
    notify('scope');
    return true;
  };

  const select = async (space: StudentSpace): Promise<StudentSpaceSelectOutcome> => {
    if (disposed) return 'blocked';
    if (state.phase !== 'ready') return 'blocked'; // a selection needs the loaded list
    if (state.selectingId) return 'duplicate'; // synchronous single-flight across rows
    if (!guard.acquire()) return 'duplicate';
    const generation = sequence.next();
    // Captured synchronously, before any await: the identity that sits in
    // storage when this selection begins (the previous space's stale identity).
    // Every identity cleanup below may only ERASE storage while it still holds
    // exactly this baseline; a changed key means a newer session owns it.
    const baselineStudent = hooks.storage.getItem(CURRENT_STUDENT_KEY);
    const baselineSpace = hooks.storage.getItem(CURRENT_STUDENT_SPACE_KEY);
    patch({ selectingId: space.student_enrollment_id, selectionError: null, pendingIdentityLoad: false });
    try {
      const rotation = await api.selectSpace(space.student_enrollment_id);
      if (!sequence.isCurrent(generation)) return 'blocked'; // superseded/disposed: never commit
      let profile: StudentProfile;
      try {
        profile = await api.loadProfile();
      } catch (cause) {
        // The token rotation already committed (selectStudentSpace persisted
        // it and notified 'token'). The stored identity belongs to the
        // PREVIOUS space, so it is discarded — but ONLY while storage still
        // holds exactly the identity this selection started beside (a genuine
        // own-rotation / stale-identity failure). If either key changed, a
        // newer session installed its own identity and the operation is
        // obsolete: it must leave that identity untouched (never erase it),
        // never restore the old token, imply no success and expose no stale
        // pending action (supervisor/051).
        if (sequence.isCurrent(generation)) {
          if (discardStoredIdentity(baselineStudent, baselineSpace)) {
            pendingEnrollmentId = space.student_enrollment_id;
            pendingRotationToken = rotation.token;
            const failure = classifyEnrollmentFailure(cause);
            patch({ selectingId: null, selectionError: failure.message, pendingIdentityLoad: true });
          } else {
            pendingEnrollmentId = null;
            pendingRotationToken = null;
            patch({
              selectingId: null,
              selectionError: 'تم تغيير الجلسة. أعد تحميل بيانات المساحة.',
              pendingIdentityLoad: false,
            });
          }
        }
        return 'profile-failed';
      }
      if (!sequence.isCurrent(generation)) return 'blocked';
      // The session may have been replaced while the profile was in flight
      // (logout in this document, another tab's login, server-side
      // revocation). Committing the identity then would place a previous
      // space's identity under a token that is not ours, so fail closed.
      if (!isRotationTokenCurrent(rotation.token)) {
        // The session was replaced while the profile read was in flight, so
        // this success must NOT be committed and the journey must NOT
        // navigate. The only storage question left is cleanup: if the identity
        // is still the stale baseline (no newer session claimed it) the stale
        // identity is discarded exactly as before; if a newer session replaced
        // it, this obsolete operation must NOT erase it (supervisor/051) and
        // must not expose a stale pending action.
        if (discardStoredIdentity(baselineStudent, baselineSpace)) {
          pendingEnrollmentId = space.student_enrollment_id;
          pendingRotationToken = rotation.token;
          patch({
            selectingId: null,
            selectionError: 'تم تغيير الجلسة. أعد تحميل بيانات المساحة.',
            pendingIdentityLoad: true,
          });
        } else {
          pendingEnrollmentId = null;
          pendingRotationToken = null;
          patch({
            selectingId: null,
            selectionError: 'تم تغيير الجلسة. أعد تحميل بيانات المساحة.',
            pendingIdentityLoad: false,
          });
        }
        return 'profile-failed';
      }
      if (!commitIdentity(profile, rotation.student_enrollment_id)) {
        // The scoped profile does not match the rotation: fail closed. We are
        // inside the session we own, so the stale baseline may be discarded —
        // unless a newer session already replaced it, in which case we leave it.
        if (discardStoredIdentity(baselineStudent, baselineSpace)) {
          pendingEnrollmentId = space.student_enrollment_id;
          pendingRotationToken = rotation.token;
          patch({ selectingId: null, selectionError: 'استجابة غير صالحة من الخادم', pendingIdentityLoad: true });
        } else {
          pendingEnrollmentId = null;
          pendingRotationToken = null;
          patch({ selectingId: null, selectionError: 'استجابة غير صالحة من الخادم', pendingIdentityLoad: false });
        }
        return 'profile-failed';
      }
      pendingEnrollmentId = null;
      pendingRotationToken = null;
      patch({ selectingId: null, selectionError: null, pendingIdentityLoad: false });
      hooks.onSelected?.();
      return 'selected';
    } catch (cause) {
      // The rotation itself failed: the token is untouched and the previous
      // identity is still valid, so only the error is surfaced.
      if (!sequence.isCurrent(generation)) return 'blocked';
      const failure = classifyEnrollmentFailure(cause);
      patch({ selectingId: null, selectionError: failure.message, pendingIdentityLoad: false });
      return 'failed';
    } finally {
      guard.release();
    }
  };

  const retryIdentityLoad = async (): Promise<StudentIdentityRetryOutcome> => {
    if (disposed) return 'blocked';
    const enrollmentId = pendingEnrollmentId;
    if (!state.pendingIdentityLoad || !enrollmentId) return 'blocked';
    // The pending identity belongs to the rotation that produced it. Reading
    // the profile under a foreign token would fetch ANOTHER session's
    // identity, so the retry is refused before any request leaves. It must NOT
    // erase the current session's identity when it refuses (supervisor/051).
    if (!isRotationTokenCurrent(pendingRotationToken ?? '')) {
      patch({
        selectingId: null,
        selectionError: 'تم تغيير الجلسة. أعد تحميل بيانات المساحة.',
        pendingIdentityLoad: true,
      });
      return 'blocked';
    }
    if (!guard.acquire()) return 'duplicate';
    const generation = sequence.next();
    patch({ selectingId: enrollmentId, selectionError: null });
    try {
      const profile = await api.loadProfile();
      if (!sequence.isCurrent(generation)) return 'blocked';
      // The retry belongs to the rotation that produced the pending identity;
      // if the token is no longer that one, the retry is refused instead of
      // writing an identity into a session we do not own — and it must NOT
      // erase the current session's identity when it refuses (supervisor/051).
      if (!isRotationTokenCurrent(pendingRotationToken ?? '')) {
        patch({
          selectingId: null,
          selectionError: 'تم تغيير الجلسة. أعد تحميل بيانات المساحة.',
          pendingIdentityLoad: true,
        });
        return 'blocked';
      }
      if (!commitIdentity(profile, enrollmentId)) {
        patch({ selectingId: null, selectionError: 'استجابة غير صالحة من الخادم', pendingIdentityLoad: true });
        return 'failed';
      }
      pendingEnrollmentId = null;
      pendingRotationToken = null;
      patch({ selectingId: null, selectionError: null, pendingIdentityLoad: false });
      hooks.onSelected?.();
      return 'selected';
    } catch (cause) {
      if (!sequence.isCurrent(generation)) return 'blocked';
      const failure = classifyEnrollmentFailure(cause);
      patch({ selectingId: null, selectionError: failure.message, pendingIdentityLoad: true });
      return 'failed';
    } finally {
      guard.release();
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadSpaces,
    select,
    retryIdentityLoad,
    dispose: () => {
      disposed = true;
      sequence.invalidate();
      guard.release();
    },
  };
}
