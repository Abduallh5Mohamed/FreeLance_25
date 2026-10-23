/**
 * M2-21 — private group announcements: the production client seam.
 *
 * `src/pages/Groups.tsx` mounts through `createProductionGroupAnnouncementController`
 * below. This module owns the WHOLE request and form lifecycle of the
 * announcement panel — the bounded page read, the bounded "next page" read, the
 * explicit create/edit/publish/retract actions, the strict canonical form,
 * duplicate-submit blocking, retained retryable drafts, denied/not-found
 * cleanup and the session/principal/selection/list/form/target/dispose fences —
 * and keeps React rendering out of the decision path.
 *
 * The transport, the principal reader and the session notifier are injected, so
 * the exact production code the page runs is exercised hermetically in
 * `src/tests/m2-group-announcements.test.ts` with no DB, no network, no browser
 * and no live app.
 *
 * Contracts verified from source (`docs/streams/server/M2-B13-CONTRACT.md`,
 * implemented in `server/src/routes/groups.ts`):
 *  - `GET /api/groups/:groupId/announcements?limit&cursor` answers
 *    `{ announcements, next_cursor }` for ONE group the caller owns inside the
 *    server-selected tenant. `limit` is 1..100 (default 25) and the cursor is an
 *    opaque position; a malformed limit or cursor is the documented 400;
 *  - each announcement is the fixed EIGHT-field projection `{ id, group_id,
 *    title, body, state, created_at, updated_at, retracted_at }` with SERVER
 *    timestamps;
 *  - `state` is `draft`, `published` or `retracted`. A client may only ASK for
 *    `draft` or `published`; `retracted` is reachable solely through the
 *    explicit retract call, so a retraction can never be forged by writing a
 *    state;
 *  - `POST` requires `title` (1..255 after trimming) and `body` (non-blank, at
 *    most 4000, stored exactly as sent) and defaults `state` to `draft`;
 *  - `PUT` accepts any subset: an ABSENT key KEEPS the stored value, so an empty
 *    patch is a truthful no-op answered with the current stored projection;
 *  - retraction is TERMINAL: an edit of a retracted announcement is a 409 and a
 *    second retraction is a truthful no-op that preserves the original
 *    `retracted_at`;
 *  - a write revalidates the caller's authority AND the target group inside the
 *    same transaction, so a foreign or absent group is one 404 `Group not found`
 *    and a foreign, absent or other-group announcement is one 404
 *    `Announcement not found`;
 *  - the documented failures are 400 `Invalid announcement payload` /
 *    `Invalid announcement title` / `Invalid announcement body` /
 *    `Invalid announcement state` / `Invalid announcement list limit` /
 *    `Invalid announcement list cursor`, 403
 *    `Teaching access is not active for the selected tenant` / `Forbidden`,
 *    404 `Group not found` / `Announcement not found` /
 *    `Tenant membership not found`, 409 `Announcement is retracted` /
 *    `Announcement was modified concurrently`, and the bounded 500
 *    `Failed to list announcements` / `Failed to save announcement`;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify an
 *    outcome. No status is fabricated and no permission is inferred from an
 *    unrecognized message.
 *
 * Lifetimes fenced here:
 *  - selection: the panel always names the group whose announcements it holds.
 *    Selecting another group advances the selection AND the read generation and
 *    clears the held rows, so a late reply for the previous group can never be
 *    shown under the new heading;
 *  - read: every page read advances a generation and takes a single-flight
 *    latch BEFORE the first await, so a double-clicked refresh never sends a
 *    second request and a superseded reply never commits. A "next page" read is
 *    only issued when the server minted a cursor, and it appends to the page it
 *    was issued for — never to a page that was replaced meanwhile;
 *  - write: every mutation advances its own generation and takes ONE shared
 *    single-flight latch BEFORE the first await, so a double-clicked save, a
 *    click plus Enter, or a publish racing a retract never sends a second write;
 *  - form: opening, cancelling or invalidating a form advances the form
 *    generation, so a late reply never rewrites or closes a newer form;
 *  - target: a reply carrying another announcement's id (or another group's id)
 *    is NOT a success for this write;
 *  - authorization: a DEFINITE read/write authorization or tenant-scope loss
 *    (expired session, suspension, teaching denial, missing workspace) clears
 *    the held rows, the form and the draft and retires every in-flight
 *    operation. A retryable failure keeps the draft, because no permission loss
 *    was proven. A 404 removes the vanished row (or clears the whole panel when
 *    the GROUP vanished) and closes a form that targeted it;
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read and write, on the success and the failure path, and a RETIRED
 *    operation observes it BEFORE it settles any visible state;
 *  - dispose: nothing commits after the page is gone.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success;
 *  - a 500/network/malformed write outcome is UNCERTAIN: the write may have
 *    persisted, nothing is retried automatically and the draft is preserved;
 *  - a confirmed success uses the validated server DTO only. No refresh is
 *    issued after a write, so a confirmed write costs exactly one request;
 *  - an action that the current state already satisfies (publishing a published
 *    announcement, retracting a retracted one, saving an unchanged form) sends
 *    NOTHING and claims nothing.
 *
 * PRIVATE management surface only: nothing here sends an email, SMS or push,
 * schedules a delivery (no publish-at, expiry or timezone policy), notifies a
 * recipient, or creates an access, enrollment, role, session, attendance or
 * billing effect.
 */
import {
  GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE,
  GROUP_ANNOUNCEMENT_PAGE_LIMIT,
  GROUP_ANNOUNCEMENT_PAGE_MAX,
  createGroupAnnouncement,
  listGroupAnnouncements,
  parseGroupAnnouncement,
  parseGroupAnnouncementList,
  retractGroupAnnouncement,
  updateGroupAnnouncement,
  type GroupAnnouncement,
  type GroupAnnouncementState,
  type GroupAnnouncementWrite,
} from '../../lib/api-http';
import { subscribeSessionChange } from '../../lib/session-events';
import {
  createCourseOperationGuard,
  createTicketSource,
  readCourseSessionPrincipal,
} from '../catalog/course-management';
import type { CourseSessionStorage } from '../catalog/course-management';

export {
  GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE,
  GROUP_ANNOUNCEMENT_PAGE_LIMIT,
  GROUP_ANNOUNCEMENT_PAGE_MAX,
};
export type { GroupAnnouncement, GroupAnnouncementState, GroupAnnouncementWrite, CourseSessionStorage };

/**
 * The canonical session reader the page uses. Re-exported so the page imports
 * ONE principal boundary instead of inventing a second localStorage lifetime.
 */
export { readCourseSessionPrincipal };

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

/** Upstream authentication answers (server/src/middleware/auth.ts). */
const SESSION_MESSAGES = new Set<string>([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
]);

/** The account is administratively suspended; the transport also tears down. */
const SUSPENDED_MESSAGE = 'Instructor account is administratively suspended';

/** The teaching-entitlement denial and the generic role denial. */
const DENIED_MESSAGES = new Set<string>([
  'Teaching access is not active for the selected tenant',
  'Forbidden',
]);

/** No authorized workspace was resolved for this request. */
const NO_WORKSPACE_MESSAGES = new Set<string>(['Tenant membership not found']);

/** The group is absent — or foreign, which the server answers identically. */
const GROUP_NOT_FOUND_MESSAGE = 'Group not found';

/** The announcement is absent, foreign or of another group — one answer. */
const ANNOUNCEMENT_NOT_FOUND_MESSAGE = 'Announcement not found';

/** Retraction is terminal, so an edit of a retracted row is refused. */
const RETRACTED_CONFLICT_MESSAGE = 'Announcement is retracted';

/** A concurrent change won the row: nothing was written. */
const CONCURRENT_CONFLICT_MESSAGE = 'Announcement was modified concurrently';

/** Strict payload and query rejections: the server wrote nothing. */
const INVALID_MESSAGES = new Set<string>([
  'Invalid announcement payload',
  'Invalid announcement title',
  'Invalid announcement body',
  'Invalid announcement state',
  'Invalid announcement list limit',
  'Invalid announcement list cursor',
]);

/** The bounded read wording. */
const READ_FAILED_MESSAGE = 'Failed to list announcements';
/** The bounded write wording: a lost commit cannot be told from a rollback. */
const WRITE_FAILED_MESSAGE = 'Failed to save announcement';

export type GroupAnnouncementPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace';

export type GroupAnnouncementFailureReason =
  | 'session'
  | 'suspended'
  | 'denied'
  | 'no-workspace'
  | 'missing'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface GroupAnnouncementFailure {
  readonly phase: GroupAnnouncementPhase;
  readonly reason: GroupAnnouncementFailureReason;
  readonly message: string;
}

/** Classifies ONLY the documented transported messages of a READ. */
export function classifyGroupAnnouncementReadFailure(cause: unknown): GroupAnnouncementFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_MESSAGES.has(message)) return { phase: 'unauthorized', reason: 'session', message };
  if (message === SUSPENDED_MESSAGE) return { phase: 'denied', reason: 'suspended', message };
  if (DENIED_MESSAGES.has(message)) return { phase: 'denied', reason: 'denied', message };
  if (NO_WORKSPACE_MESSAGES.has(message)) return { phase: 'no-workspace', reason: 'no-workspace', message };
  if (message === GROUP_NOT_FOUND_MESSAGE) return { phase: 'error', reason: 'missing', message };
  if (INVALID_MESSAGES.has(message)) return { phase: 'error', reason: 'invalid', message };
  if (message === READ_FAILED_MESSAGE) return { phase: 'error', reason: 'server', message };
  return { phase: 'error', reason: 'unknown', message: message || 'تعذّر تحميل الإعلانات.' };
}

export type GroupAnnouncementWriteFailureKind =
  | 'unauthorized'
  | 'denied'
  | 'missing'
  | 'invalid'
  | 'conflict'
  | 'uncertain';

export interface GroupAnnouncementWriteFailure {
  readonly kind: GroupAnnouncementWriteFailureKind;
  readonly reason: GroupAnnouncementFailureReason;
  readonly message: string;
  /** Which resource the 404 named, so the caller can drop exactly that one. */
  readonly missingTarget: 'group' | 'announcement' | null;
}

/**
 * Classifies ONLY the documented transported messages of a WRITE.
 *
 * `uncertain` covers the handler 500 and every unrecognized/network failure
 * after the request was sent: the write may have persisted, so nothing is
 * retried automatically.
 */
export function classifyGroupAnnouncementWriteFailure(cause: unknown): GroupAnnouncementWriteFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  const denied = (kind: GroupAnnouncementWriteFailureKind, reason: GroupAnnouncementFailureReason) =>
    ({ kind, reason, message, missingTarget: null as null });

  if (SESSION_MESSAGES.has(message)) return denied('unauthorized', 'session');
  if (message === SUSPENDED_MESSAGE) return denied('unauthorized', 'suspended');
  if (DENIED_MESSAGES.has(message)) return denied('denied', 'denied');
  if (NO_WORKSPACE_MESSAGES.has(message)) return denied('denied', 'no-workspace');
  if (message === GROUP_NOT_FOUND_MESSAGE) {
    return { kind: 'missing', reason: 'missing', message, missingTarget: 'group' };
  }
  if (message === ANNOUNCEMENT_NOT_FOUND_MESSAGE) {
    return { kind: 'missing', reason: 'missing', message, missingTarget: 'announcement' };
  }
  if (message === RETRACTED_CONFLICT_MESSAGE || message === CONCURRENT_CONFLICT_MESSAGE) {
    return denied('conflict', 'invalid');
  }
  if (INVALID_MESSAGES.has(message)) return denied('invalid', 'invalid');
  if (message === WRITE_FAILED_MESSAGE) return denied('uncertain', 'server');
  return denied('uncertain', 'unknown');
}

/**
 * A DEFINITE loss of read/write authorization or of the tenant scope. Only the
 * documented denial answers qualify; a retryable 500, a network error and an
 * unrecognized message keep the private draft.
 */
export function isGroupAnnouncementAuthorizationLoss(reason: GroupAnnouncementFailureReason): boolean {
  return (
    reason === 'session' ||
    reason === 'suspended' ||
    reason === 'denied' ||
    reason === 'no-workspace'
  );
}

// ---------------------------------------------------------------------------
// Local validation wording (never reaches the transport)
// ---------------------------------------------------------------------------

export const ANNOUNCEMENT_TITLE_MAX = 255;
export const ANNOUNCEMENT_BODY_MAX = 4000;

export const ANNOUNCEMENT_TITLE_INVALID_MESSAGE =
  'عنوان الإعلان يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات.';
export const ANNOUNCEMENT_BODY_INVALID_MESSAGE =
  'نص الإعلان مطلوب ويجب ألا يتجاوز 4000 حرف.';
export const ANNOUNCEMENT_UNCHANGED_MESSAGE =
  'لم يتغيّر شيء، لذلك لم يُرسل أي طلب.';

/** Warning after a reply that may or may not have persisted server-side. */
export const ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ الإعلان. قد تكون التغييرات قد حُفظت على الخادم؛ أعد تحميل القائمة للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after a confirmed retraction. */
export const ANNOUNCEMENT_RETRACTED_MESSAGE = 'تم سحب الإعلان.';
/** Local wording after a confirmed publication. */
export const ANNOUNCEMENT_PUBLISHED_MESSAGE = 'تم نشر الإعلان.';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type GroupAnnouncementFormMode = 'closed' | 'create' | 'edit';

export interface GroupAnnouncementFormState {
  mode: GroupAnnouncementFormMode;
  /** The announcement an edit form is bound to (null for a create). */
  targetId: string | null;
  title: string;
  /** Held EXACTLY as typed: the server stores the body as sent. */
  body: string;
  /** Only `draft` or `published` is ever selectable. */
  state: 'draft' | 'published';
  error: string | null;
}

export type GroupAnnouncementMutationKind = 'save' | 'publish' | 'retract';

export interface GroupAnnouncementMutationState {
  status: 'idle' | 'saving' | 'uncertain';
  kind: GroupAnnouncementMutationKind | null;
  targetId: string | null;
  error: string | null;
  notice: string | null;
}

export interface GroupAnnouncementPanelState {
  /** The group whose announcements are held (null until one is selected). */
  groupId: string | null;
  phase: GroupAnnouncementPhase;
  rows: GroupAnnouncement[];
  /** The opaque position the server minted, or null when the page is complete. */
  nextCursor: string | null;
  /** True while a bounded "next page" read is in flight. */
  loadingMore: boolean;
  error: string | null;
  reason: GroupAnnouncementFailureReason | null;
  form: GroupAnnouncementFormState;
  mutation: GroupAnnouncementMutationState;
  /** The server-confirmed result of the last confirmed write. */
  lastConfirmed: GroupAnnouncement | null;
}

/** The explicit result of a mutation, so the page never guesses from state. */
export type GroupAnnouncementWriteOutcome =
  | 'confirmed'
  | 'rejected'
  | 'uncertain'
  | 'blocked'
  | 'invalid'
  | 'unchanged'
  | 'idle';

const closedForm = (): GroupAnnouncementFormState => ({
  mode: 'closed',
  targetId: null,
  title: '',
  body: '',
  state: 'draft',
  error: null,
});

const idleMutation = (): GroupAnnouncementMutationState => ({
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
});

const initialState: GroupAnnouncementPanelState = {
  groupId: null,
  phase: 'idle',
  rows: [],
  nextCursor: null,
  loadingMore: false,
  error: null,
  reason: null,
  form: closedForm(),
  mutation: idleMutation(),
  lastConfirmed: null,
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface GroupAnnouncementApi {
  list(groupId: string, options: { limit?: number; cursor?: string | null }): Promise<unknown>;
  create(groupId: string, write: GroupAnnouncementWrite): Promise<unknown>;
  update(groupId: string, announcementId: string, patch: GroupAnnouncementWrite): Promise<unknown>;
  retract(groupId: string, announcementId: string): Promise<unknown>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface GroupAnnouncementFormPatch {
  title?: string;
  body?: string;
  state?: 'draft' | 'published';
}

export interface GroupAnnouncementController {
  getState(): GroupAnnouncementPanelState;
  subscribe(listener: (state: GroupAnnouncementPanelState) => void): () => void;
  /** Names the group and reads its first bounded page. */
  select(groupId: string | null): Promise<void>;
  /** A deliberate re-read of the first page of the selected group. */
  refresh(): Promise<void>;
  /** Reads the NEXT bounded page when the server minted a cursor. */
  loadMore(): Promise<void>;
  openCreate(): void;
  openEdit(announcementId: string): void;
  setField(patch: GroupAnnouncementFormPatch): void;
  cancel(): void;
  save(): Promise<GroupAnnouncementWriteOutcome>;
  publish(announcementId: string): Promise<GroupAnnouncementWriteOutcome>;
  retract(announcementId: string): Promise<GroupAnnouncementWriteOutcome>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

/** Applies a canonical server row to the held page (replace in place). */
const withRow = (rows: GroupAnnouncement[], row: GroupAnnouncement): GroupAnnouncement[] => {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  if (index === -1) return [...rows, row];
  const next = rows.slice();
  next[index] = row;
  return next;
};

export function createGroupAnnouncementController(
  api: GroupAnnouncementApi,
): GroupAnnouncementController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: GroupAnnouncementPanelState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** One page read at a time. */
  const readGuard = createCourseOperationGuard(tickets);
  /** ONE write at a time, shared by save/publish/retract: a double click or a
   *  click plus Enter never sends a second write. */
  const writeGuard = createCourseOperationGuard(tickets);
  let readGeneration = 0;
  let writeGeneration = 0;
  let formGeneration = 0;
  let selectionGeneration = 0;
  let mutationOwner = 0;
  let phaseOwner = 0;

  const patch = (changes: Partial<GroupAnnouncementPanelState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<GroupAnnouncementFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<GroupAnnouncementMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  const clearPrivateState = (): Partial<GroupAnnouncementPanelState> => ({
    groupId: null,
    phase: 'idle',
    rows: [],
    nextCursor: null,
    loadingMore: false,
    error: null,
    reason: null,
    form: closedForm(),
    mutation: idleMutation(),
    lastConfirmed: null,
  });

  const retireInFlight = (): void => {
    readGeneration += 1;
    writeGeneration += 1;
    formGeneration += 1;
    selectionGeneration += 1;
    mutationOwner = 0;
    readGuard.release();
    writeGuard.release();
  };

  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    retireInFlight();
    patch(clearPrivateState());
    return true;
  };

  /** A retired operation observes the principal BEFORE settling visible state. */
  const adoptRetiredPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    readGeneration += 1;
    writeGeneration += 1;
    formGeneration += 1;
    selectionGeneration += 1;
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

  const settleReadPhase = (phaseToken: number): void => {
    if (phaseOwner !== phaseToken) return;
    if (state.phase !== 'loading') return;
    patch({ phase: state.rows.length > 0 ? 'ready' : 'idle', error: null, reason: null });
  };

  /**
   * Reads ONE page of the selected group.
   *
   * `cursor` is null for the first page and the server-minted position for a
   * "next page". An append only lands when the reply belongs to the SAME
   * selection AND the SAME read generation it was issued for.
   */
  const runRead = async (cursor: string | null): Promise<void> => {
    if (disposed) return;
    const groupId = state.groupId;
    if (groupId === null) return;
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (!readGuard.acquire()) return;
    const ticket = readGuard.holder();
    const generation = ++readGeneration;
    const selection = selectionGeneration;
    const principal = entryPrincipal;
    const phaseToken = ++phaseOwner;
    const appending = cursor !== null;
    patch(appending
      ? { loadingMore: true, error: null, reason: null }
      : { phase: 'loading', loadingMore: false, error: null, reason: null });
    try {
      const body = await api.list(groupId, {
        limit: GROUP_ANNOUNCEMENT_PAGE_LIMIT,
        cursor,
      });
      if (disposed) return;
      if (generation !== readGeneration || selection !== selectionGeneration || state.groupId !== groupId) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) return;
        if (generation === readGeneration) settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const page = parseGroupAnnouncementList(body);
      if (page === null) {
        // A malformed body is a failed read, never a partially adopted page — and
        // it never discards a page that is already held.
        patch(appending
          ? { loadingMore: false, error: GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE, reason: 'unknown' }
          : {
              phase: 'error',
              rows: [],
              nextCursor: null,
              loadingMore: false,
              error: GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE,
              reason: 'unknown',
            });
        return;
      }
      // Every row is validated by `parseGroupAnnouncementList` BEFORE any row is
      // held: a malformed or oversized body is a failed read, never a partially
      // adopted page.
      const rows = appending ? [...state.rows, ...page.announcements] : page.announcements;
      patch({
        phase: rows.length === 0 ? 'empty' : 'ready',
        rows,
        nextCursor: page.next_cursor,
        loadingMore: false,
        error: null,
        reason: null,
      });
    } catch (cause) {
      if (disposed) return;
      if (generation !== readGeneration || selection !== selectionGeneration || state.groupId !== groupId) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) return;
        if (generation === readGeneration) settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyGroupAnnouncementReadFailure(cause);
      if (isGroupAnnouncementAuthorizationLoss(failure.reason)) {
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: failure.phase,
          error: failure.message,
          reason: failure.reason,
        });
        return;
      }
      if (failure.reason === 'missing') {
        // The group vanished (or is foreign — the server answers the same), so
        // the panel has nothing left to hold.
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: 'error',
          error: failure.message,
          reason: failure.reason,
        });
        return;
      }
      // Retryable: the permission loss is not proven, so a draft survives — and a
      // failed NEXT page never discards the page that is already held.
      patch(appending
        ? { loadingMore: false, error: failure.message, reason: failure.reason }
        : {
            phase: 'error',
            rows: [],
            nextCursor: null,
            loadingMore: false,
            error: failure.message,
            reason: failure.reason,
          });
    } finally {
      readGuard.release(ticket);
    }
  };

  /** Removes one announcement from the held page (after a 404). */
  const dropRow = (announcementId: string): void => {
    const rows = state.rows.filter((row) => row.id !== announcementId);
    const changes: Partial<GroupAnnouncementPanelState> = { rows };
    if (state.form.mode === 'edit' && state.form.targetId === announcementId) {
      formGeneration += 1;
      changes.form = closedForm();
    }
    if (state.phase === 'ready' && rows.length === 0) changes.phase = 'empty';
    patch(changes);
  };

  const settleSupersededWrite = (token: number, cause: unknown | null): void => {
    if (mutationOwner !== token) return;
    if (state.mutation.status !== 'saving') return;
    if (cause !== null) {
      const failure = classifyGroupAnnouncementWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        patchMutation({ status: 'uncertain', error: failure.message, notice: ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE });
        return;
      }
      patchMutation({ status: 'idle', error: failure.message, notice: null });
      return;
    }
    // A newer operation owns the view: no success is claimed.
    patchMutation({ status: 'idle', error: null, notice: null });
  };

  /** The shared write skeleton: latch, generations and every principal fence. */
  const runWrite = async (
    kind: GroupAnnouncementMutationKind,
    targetId: string | null,
    execute: () => Promise<unknown>,
    formToken: number | null,
    expectDtoId: string | null,
    notice: string | null,
  ): Promise<GroupAnnouncementWriteOutcome> => {
    if (disposed) return 'idle';
    const groupId = state.groupId;
    if (groupId === null) return 'idle';
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return 'idle';
    if (disposed) return 'idle';
    // Synchronous single-flight: a second click/Enter never reaches the wire.
    if (!writeGuard.acquire()) return 'blocked';
    const ticket = writeGuard.holder();
    const token = ++writeGeneration;
    const principal = entryPrincipal;
    mutationOwner = token;
    patchMutation({ status: 'saving', kind, targetId, error: null, notice: null });
    try {
      const response = await execute();
      if (disposed) return 'idle';
      if (token !== writeGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return 'idle';
        }
        settleSupersededWrite(token, null);
        return 'idle';
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return 'idle';
      }

      const parsed = parseGroupAnnouncement(response);
      if (parsed === null) {
        mutationOwner = 0;
        patchMutation({ status: 'uncertain', error: null, notice: ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE });
        return 'uncertain';
      }
      if (expectDtoId !== null && parsed.id !== expectDtoId) {
        // A well-formed DTO for ANOTHER announcement is not a success for this write.
        mutationOwner = 0;
        patchMutation({ status: 'uncertain', error: null, notice: ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE });
        return 'uncertain';
      }
      if (parsed.group_id !== groupId) {
        // ... and neither is one for another group.
        mutationOwner = 0;
        patchMutation({ status: 'uncertain', error: null, notice: ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE });
        return 'uncertain';
      }

      mutationOwner = 0;
      patch({ rows: withRow(state.rows, parsed), lastConfirmed: parsed });
      if (kind === 'save' && formToken !== null && formGeneration === formToken) {
        formGeneration += 1;
        patchForm(closedForm());
      }
      patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice });
      return 'confirmed';
    } catch (cause) {
      if (disposed) return 'idle';
      if (token !== writeGeneration) {
        const committedPrincipal = readPrincipal();
        if (committedPrincipal !== principal) {
          adoptPrincipalChange(committedPrincipal);
          return 'idle';
        }
        settleSupersededWrite(token, cause);
        return 'idle';
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return 'idle';
      }
      const failure = classifyGroupAnnouncementWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        // The session/account is gone: the private rows, the form and the draft
        // go, and the phase says WHY so the page never looks merely empty.
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: 'unauthorized',
          error: failure.message,
          reason: failure.reason,
        });
        return 'rejected';
      }
      if (failure.kind === 'missing') {
        mutationOwner = 0;
        if (failure.missingTarget === 'group') {
          // The GROUP vanished: the whole panel goes, and so does any form.
          retireInFlight();
          patch({
            ...clearPrivateState(),
            phase: 'error',
            error: failure.message,
            reason: failure.reason,
          });
          return 'rejected';
        }
        // The announcement vanished (or is foreign — the server answers the same).
        if (targetId !== null) dropRow(targetId);
        patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
        return 'rejected';
      }
      if (failure.kind === 'denied') {
        // A definite denial: the held rows, the form and the draft go.
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: 'denied',
          error: failure.message,
          reason: failure.reason,
        });
        return 'rejected';
      }
      if (failure.kind === 'invalid' || failure.kind === 'conflict') {
        // A refused payload or a lost race wrote nothing: the draft is KEPT so
        // the instructor can correct it, and no retry happens automatically.
        mutationOwner = 0;
        patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
        return 'rejected';
      }
      // Uncertain: the write may have persisted. The draft is preserved and
      // nothing is retried automatically.
      mutationOwner = 0;
      patchMutation({ status: 'uncertain', error: failure.message, notice: ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE });
      return 'uncertain';
    } finally {
      writeGuard.release(ticket);
    }
  };

  /**
   * Builds the strict canonical write body from the current form.
   *
   * The title is trimmed; the body is sent EXACTLY as typed (only the emptiness
   * test trims it), because the server stores it verbatim. `state` is only ever
   * `draft` or `published`. Both fields are ALWAYS sent, so an accidental
   * omission can never silently keep a stale value.
   */
  const buildWrite = (): { write: GroupAnnouncementWrite | null; error: string | null } => {
    const form = state.form;
    const title = form.title.trim();
    if (title.length < 1 || title.length > ANNOUNCEMENT_TITLE_MAX) {
      return { write: null, error: ANNOUNCEMENT_TITLE_INVALID_MESSAGE };
    }
    if (form.body.trim().length < 1 || form.body.length > ANNOUNCEMENT_BODY_MAX) {
      return { write: null, error: ANNOUNCEMENT_BODY_INVALID_MESSAGE };
    }
    return { write: { title, body: form.body, state: form.state }, error: null };
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal (or a logout): every in-flight reply is foreign.
        retireInFlight();
        observedPrincipal = readPrincipal();
        patch(clearPrivateState());
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    patch({ ...clearPrivateState() });
  };

  /** Selects one group and reads its first page. */
  const select = (groupId: string | null): Promise<void> => {
    if (disposed) return Promise.resolve();
    const next = typeof groupId === 'string' && groupId.trim() !== '' ? groupId : null;
    if (next === state.groupId) return Promise.resolve();
    // A different group invalidates the held page, the cursor, the form and any
    // in-flight reply for the previous group.
    selectionGeneration += 1;
    readGeneration += 1;
    formGeneration += 1;
    readGuard.release();
    patch({
      groupId: next,
      phase: next === null ? 'idle' : 'loading',
      rows: [],
      nextCursor: null,
      loadingMore: false,
      error: null,
      reason: null,
      form: closedForm(),
      mutation: idleMutation(),
      lastConfirmed: null,
    });
    if (next === null) return Promise.resolve();
    const operation = runRead(null);
    track(operation);
    return operation;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    select,
    refresh: () => {
      if (disposed) return Promise.resolve();
      if (state.groupId === null) return Promise.resolve();
      const operation = runRead(null);
      track(operation);
      return operation;
    },
    loadMore: () => {
      if (disposed) return Promise.resolve();
      if (state.groupId === null) return Promise.resolve();
      // Only the server's own cursor can ask for a next page, and only once at
      // a time: a double click never fetches the same page twice.
      const cursor = state.nextCursor;
      if (cursor === null) return Promise.resolve();
      if (readGuard.isBusy()) return Promise.resolve();
      const operation = runRead(cursor);
      track(operation);
      return operation;
    },
    openCreate: () => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      if (state.phase !== 'ready' && state.phase !== 'empty') return;
      formGeneration += 1;
      patchForm({ ...closedForm(), mode: 'create', state: 'draft' });
    },
    openEdit: (announcementId) => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      const row = state.rows.find((candidate) => candidate.id === announcementId);
      // The form is bound to an announcement of the CURRENT page only, and a
      // retracted one is terminal so it is never editable.
      if (!row) return;
      if (row.state === 'retracted') return;
      formGeneration += 1;
      patchForm({
        mode: 'edit',
        targetId: row.id,
        title: row.title,
        body: row.body,
        state: row.state === 'published' ? 'published' : 'draft',
        error: null,
      });
    },
    setField: (patchValues) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      // `state` can only ever be one of the two writable values.
      if (patchValues.state !== undefined && patchValues.state !== 'draft' && patchValues.state !== 'published') {
        return;
      }
      patchForm({ ...patchValues, error: null });
    },
    cancel: () => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      formGeneration += 1;
      patchForm(closedForm());
    },
    save: () => {
      if (disposed) return Promise.resolve('idle');
      if (state.form.mode === 'closed') return Promise.resolve('idle');
      if (state.groupId === null) return Promise.resolve('idle');
      if (writeGuard.isBusy()) return Promise.resolve('blocked');
      const isEdit = state.form.mode === 'edit';
      const targetId = state.form.targetId;
      const built = buildWrite();
      if (built.write === null) {
        // Local validation happens BEFORE any request and keeps the input.
        patchForm({ error: built.error });
        return Promise.resolve('invalid');
      }
      const write = built.write;

      if (isEdit && targetId !== null) {
        const current = state.rows.find((row) => row.id === targetId);
        // Truthful no-op: an unchanged edit sends NOTHING and claims nothing.
        if (current && current.title === write.title && current.body === write.body
          && current.state === write.state) {
          formGeneration += 1;
          patchForm(closedForm());
          patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: ANNOUNCEMENT_UNCHANGED_MESSAGE });
          return Promise.resolve('unchanged');
        }
      }

      const formToken = formGeneration;
      const operation = isEdit && targetId !== null
        ? runWrite(
            'save',
            targetId,
            () => api.update(state.groupId as string, targetId, write),
            formToken,
            targetId,
            null,
          )
        : runWrite(
            'save',
            null,
            () => api.create(state.groupId as string, write),
            formToken,
            null,
            null,
          );
      track(operation);
      return operation;
    },
    publish: (announcementId) => {
      if (disposed) return Promise.resolve('idle');
      if (state.groupId === null) return Promise.resolve('idle');
      if (writeGuard.isBusy()) return Promise.resolve('blocked');
      const row = state.rows.find((candidate) => candidate.id === announcementId);
      if (!row) return Promise.resolve('idle');
      // Already published, or retracted (terminal): nothing is sent.
      if (row.state !== 'draft') return Promise.resolve('unchanged');
      const operation = runWrite(
        'publish',
        announcementId,
        () => api.update(state.groupId as string, announcementId, { state: 'published' }),
        null,
        announcementId,
        ANNOUNCEMENT_PUBLISHED_MESSAGE,
      );
      track(operation);
      return operation;
    },
    retract: (announcementId) => {
      if (disposed) return Promise.resolve('idle');
      if (state.groupId === null) return Promise.resolve('idle');
      if (writeGuard.isBusy()) return Promise.resolve('blocked');
      const row = state.rows.find((candidate) => candidate.id === announcementId);
      if (!row) return Promise.resolve('idle');
      // Already retracted: nothing is sent, and the original stamp is kept.
      if (row.state === 'retracted') return Promise.resolve('unchanged');
      const operation = runWrite(
        'retract',
        announcementId,
        () => api.retract(state.groupId as string, announcementId),
        null,
        announcementId,
        ANNOUNCEMENT_RETRACTED_MESSAGE,
      );
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

/** The production wiring the page mounts. Kept here so the page holds no
 *  transport knowledge of its own. */
export function createProductionGroupAnnouncementController(storage?: CourseSessionStorage) {
  return createGroupAnnouncementController({
    list: (groupId, options) => listGroupAnnouncements(groupId, options),
    create: (groupId, write) => createGroupAnnouncement(groupId, write),
    update: (groupId, announcementId, patchValues) =>
      updateGroupAnnouncement(groupId, announcementId, patchValues),
    retract: (groupId, announcementId) => retractGroupAnnouncement(groupId, announcementId),
    readPrincipal: () =>
      readCourseSessionPrincipal(
        storage ?? (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null }),
      ),
    subscribeSession: subscribeSessionChange,
  });
}
