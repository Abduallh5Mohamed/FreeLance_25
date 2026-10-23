/**
 * M2-19 — private bounded group weekly schedules: the production client seam.
 *
 * `src/pages/Groups.tsx` mounts through `createGroupScheduleController` below.
 * This module owns the WHOLE request and form lifecycle of the existing group
 * screen — the bounded list read, explicit create/edit/save/cancel, the strict
 * canonical weekday/time form, duplicate-submit blocking, retained retryable
 * drafts, denied/not-found cleanup and the session/scope/form/target/dispose
 * fences — and keeps React rendering out of the decision path.
 *
 * The transport, the principal reader and the session notifier are injected,
 * so the exact production code the page runs is exercised hermetically in
 * `src/tests/m2-group-schedules.test.ts` with no DB, no network, no browser
 * and no live app.
 *
 * Contracts verified from source (`docs/streams/server/M2-B11-CONTRACT.md`,
 * implemented in `server/src/routes/groups.ts`):
 *  - `GET /api/groups` answers a bare array of at most the caller's own groups
 *    inside the server-selected tenant; each row is the explicit ten-field
 *    projection `{ id, name, description, course_id, grade_id, max_students,
 *    current_students, is_active, schedule_days, schedule_time }`;
 *  - `schedule_days` is the seven existing weekday keys
 *    `sat|sun|mon|tue|wed|thu|fri` in canonical order, unique, at most seven;
 *    `schedule_time` is a real `HH:mm` or `null`;
 *  - `POST /api/groups` and `PUT /api/groups/:id` take the strict canonical
 *    body and reject unknown keys, malformed weekdays, a non-`HH:mm` time and
 *    malformed/foreign course or grade selectors — they never silently null a
 *    selector;
 *  - an ABSENT schedule key keeps the stored value; a present `null` clears
 *    it. The controller therefore always sends `schedule_days` and
 *    `schedule_time` EXPLICITLY, so unchecking the last weekday or clearing
 *    the time is a real clear instead of an accidental omission;
 *  - a write revalidates authority and target server-side and answers a
 *    truthful no-op when nothing changed;
 *  - the documented failures are 400 `Invalid group payload` /
 *    `Invalid course selector` / `Invalid grade selector` /
 *    `Invalid schedule days` / `Invalid schedule time` /
 *    `Invalid max students` / `Group name is required`, 403
 *    `Teaching access is not active for the selected tenant` / `Forbidden`,
 *    404 `Group not found` / `Tenant membership not found`, and the bounded
 *    500 `Failed to fetch groups` / `Failed to save group` /
 *    `Failed to delete group`;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify
 *    an outcome. No status is fabricated and no permission is inferred from an
 *    unrecognized message.
 *
 * Lifetimes fenced here:
 *  - read: every list read advances a generation and takes a single-flight
 *    latch BEFORE the first await, so a double-clicked refresh never sends a
 *    second request and a superseded reply never commits;
 *  - write: every mutation advances its own generation and takes ONE shared
 *    single-flight latch BEFORE the first await, so a double-clicked save, a
 *    click plus Enter, or a save racing a delete never sends a second write;
 *  - form: opening, cancelling or invalidating a form advances the form
 *    generation, so a late reply never rewrites or closes a newer form;
 *  - target: an update reply carrying another group's id is NOT a success for
 *    this write;
 *  - authorization: a DEFINITE read/write authorization or tenant-scope loss
 *    (expired session, suspension, teaching denial, missing workspace) clears
 *    the private rows, the form and the draft and retires every in-flight
 *    operation. A retryable failure keeps the draft, because no permission
 *    loss was proven. A 404 removes the vanished row and closes a form that
 *    targeted it;
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
 *    issued after a write, so a confirmed write costs exactly one request.
 *
 * Timetable metadata only: no timezone, recurrence, automatic session,
 * attendance, announcement, enrollment, access or billing semantics.
 */
import {
  GROUP_SCHEDULE_DAYS,
  GROUP_SCHEDULE_DAY_LABELS,
  GROUP_SCHEDULE_MALFORMED_MESSAGE,
  createGroupSchedule,
  deleteGroupSchedule,
  listGroupSchedules,
  parseGroupSchedule,
  updateGroupSchedule,
  type GroupSchedule,
  type GroupScheduleDay,
  type GroupScheduleWrite,
} from '../../lib/api';
import { subscribeSessionChange } from '../../lib/session-events';
import {
  createCourseOperationGuard,
  createTicketSource,
  readCourseSessionPrincipal,
} from '../catalog/course-management';
import type { CourseSessionStorage } from '../catalog/course-management';

export { GROUP_SCHEDULE_DAYS, GROUP_SCHEDULE_DAY_LABELS, GROUP_SCHEDULE_MALFORMED_MESSAGE };
export type { GroupSchedule, GroupScheduleDay, GroupScheduleWrite, CourseSessionStorage };

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

/** Strict payload rejections: the server took no connection and wrote nothing. */
const INVALID_MESSAGES = new Set<string>([
  'Invalid group payload',
  'Invalid course selector',
  'Invalid grade selector',
  'Invalid schedule days',
  'Invalid schedule time',
  'Invalid max students',
  'Group name is required',
]);

/** The bounded read wordings. */
const READ_FAILED_MESSAGES = new Set<string>(['Failed to fetch groups', 'Failed to fetch group']);
/** The bounded write wording: a lost commit cannot be told from a rollback. */
const WRITE_FAILED_MESSAGE = 'Failed to save group';
/** The bounded delete wording. */
const DELETE_FAILED_MESSAGE = 'Failed to delete group';

export type GroupSchedulePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'unauthorized'
  | 'denied'
  | 'no-workspace';

export type GroupScheduleFailureReason =
  | 'session'
  | 'suspended'
  | 'denied'
  | 'no-workspace'
  | 'missing'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface GroupScheduleFailure {
  readonly phase: GroupSchedulePhase;
  readonly reason: GroupScheduleFailureReason;
  readonly message: string;
}

/** Classifies ONLY the documented transported messages of a READ. */
export function classifyGroupScheduleReadFailure(cause: unknown): GroupScheduleFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_MESSAGES.has(message)) return { phase: 'unauthorized', reason: 'session', message };
  if (message === SUSPENDED_MESSAGE) return { phase: 'denied', reason: 'suspended', message };
  if (DENIED_MESSAGES.has(message)) return { phase: 'denied', reason: 'denied', message };
  if (NO_WORKSPACE_MESSAGES.has(message)) return { phase: 'no-workspace', reason: 'no-workspace', message };
  if (READ_FAILED_MESSAGES.has(message)) return { phase: 'error', reason: 'server', message };
  return { phase: 'error', reason: 'unknown', message: message || 'فشل تحميل المجموعات' };
}

export type GroupScheduleWriteFailureKind =
  | 'unauthorized'
  | 'denied'
  | 'missing'
  | 'invalid'
  | 'uncertain';

export interface GroupScheduleWriteFailure {
  readonly kind: GroupScheduleWriteFailureKind;
  readonly reason: GroupScheduleFailureReason;
  readonly message: string;
}

/**
 * Classifies ONLY the documented transported messages of a WRITE.
 *
 * `uncertain` covers the handler 500 and every unrecognized/network failure
 * after the request was sent: the write may have persisted, so nothing is
 * retried automatically.
 */
export function classifyGroupScheduleWriteFailure(cause: unknown): GroupScheduleWriteFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_MESSAGES.has(message)) return { kind: 'unauthorized', reason: 'session', message };
  if (message === SUSPENDED_MESSAGE) return { kind: 'unauthorized', reason: 'suspended', message };
  if (DENIED_MESSAGES.has(message)) return { kind: 'denied', reason: 'denied', message };
  if (NO_WORKSPACE_MESSAGES.has(message)) return { kind: 'denied', reason: 'no-workspace', message };
  if (message === GROUP_NOT_FOUND_MESSAGE) return { kind: 'missing', reason: 'missing', message };
  if (INVALID_MESSAGES.has(message)) return { kind: 'invalid', reason: 'invalid', message };
  if (message === WRITE_FAILED_MESSAGE || message === DELETE_FAILED_MESSAGE) {
    return { kind: 'uncertain', reason: 'server', message };
  }
  return { kind: 'uncertain', reason: 'unknown', message: message || 'فشل غير مؤكد أثناء حفظ المجموعة' };
}

/**
 * A DEFINITE loss of read/write authorization or of the tenant scope. Only the
 * documented denial answers qualify; a retryable 500, a network error and an
 * unrecognized message keep the private draft.
 */
export function isGroupScheduleAuthorizationLoss(reason: GroupScheduleFailureReason): boolean {
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

export const GROUP_NAME_INVALID_MESSAGE =
  'اسم المجموعة يجب أن يكون بين 1 و255 حرفًا بعد إزالة المسافات.';
export const GROUP_MAX_STUDENTS_INVALID_MESSAGE =
  'الحد الأقصى للطلاب يجب أن يكون عددًا صحيحًا بين 1 و1000.';
export const GROUP_TIME_INVALID_MESSAGE = 'وقت المجموعة يجب أن يكون بصيغة HH:mm أو فارغًا.';

/** Warning after a reply that may or may not have persisted server-side. */
export const GROUP_WRITE_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد حفظ المجموعة. قد تكون التغييرات قد حُفظت على الخادم؛ أعد تحميل القائمة للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** Local wording after a confirmed delete removed a row from the list. */
export const GROUP_DELETED_MESSAGE = 'تم حذف المجموعة بنجاح.';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface GroupScheduleFormState {
  mode: 'closed' | 'create' | 'edit';
  /** The group an edit form is bound to (null for a create). */
  targetId: string | null;
  name: string;
  description: string;
  gradeId: string;
  /** Kept as the raw input text so a bad value is never silently coerced. */
  maxStudents: string;
  isActive: boolean;
  days: GroupScheduleDay[];
  /** `HH:mm` or the empty string (which the write turns into an explicit null). */
  time: string;
  error: string | null;
}

export type GroupScheduleMutationKind = 'save' | 'delete' | 'toggle';

export interface GroupScheduleMutationState {
  status: 'idle' | 'saving' | 'uncertain';
  kind: GroupScheduleMutationKind | null;
  targetId: string | null;
  error: string | null;
  notice: string | null;
}

export interface GroupScheduleState {
  phase: GroupSchedulePhase;
  rows: GroupSchedule[];
  error: string | null;
  reason: GroupScheduleFailureReason | null;
  form: GroupScheduleFormState;
  mutation: GroupScheduleMutationState;
  /** The server-confirmed result of the last confirmed write. */
  lastConfirmed: GroupSchedule | null;
}

/** The explicit result of a mutation, so the page never guesses from state. */
export type GroupScheduleWriteOutcome =
  | 'confirmed'
  | 'rejected'
  | 'uncertain'
  | 'blocked'
  | 'invalid'
  | 'idle';

const closedForm = (): GroupScheduleFormState => ({
  mode: 'closed',
  targetId: null,
  name: '',
  description: '',
  gradeId: '',
  maxStudents: '50',
  isActive: true,
  days: [],
  time: '',
  error: null,
});

const idleMutation = (): GroupScheduleMutationState => ({
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
});

const initialState: GroupScheduleState = {
  phase: 'idle',
  rows: [],
  error: null,
  reason: null,
  form: closedForm(),
  mutation: idleMutation(),
  lastConfirmed: null,
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface GroupScheduleApi {
  list(): Promise<unknown>;
  create(write: GroupScheduleWrite): Promise<unknown>;
  update(id: string, write: GroupScheduleWrite): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface GroupScheduleFormPatch {
  name?: string;
  description?: string;
  gradeId?: string;
  maxStudents?: string;
  isActive?: boolean;
  time?: string;
}

export interface GroupScheduleController {
  getState(): GroupScheduleState;
  subscribe(listener: (state: GroupScheduleState) => void): () => void;
  /** One bounded list read (the page calls it once on mount). */
  load(): Promise<void>;
  /** A deliberate re-read of the current list. */
  refresh(): Promise<void>;
  openCreate(): void;
  openEdit(groupId: string): void;
  setField(patch: GroupScheduleFormPatch): void;
  toggleDay(day: GroupScheduleDay): void;
  cancel(): void;
  save(): Promise<GroupScheduleWriteOutcome>;
  remove(groupId: string): Promise<GroupScheduleWriteOutcome>;
  setActive(groupId: string, active: boolean): Promise<GroupScheduleWriteOutcome>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const byName = (a: GroupSchedule, b: GroupSchedule): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Applies a canonical server row to the held list (replace, or insert+sort). */
const withRow = (rows: GroupSchedule[], row: GroupSchedule): GroupSchedule[] => {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  if (index === -1) return [...rows, row].sort(byName);
  const next = rows.slice();
  next[index] = row;
  return next.sort(byName);
};

export function createGroupScheduleController(api: GroupScheduleApi): GroupScheduleController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: GroupScheduleState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** One list read at a time. */
  const readGuard = createCourseOperationGuard(tickets);
  /** ONE write at a time, shared by save/delete/toggle: a double click or a
   *  click plus Enter never sends a second write. */
  const writeGuard = createCourseOperationGuard(tickets);
  let readGeneration = 0;
  let writeGeneration = 0;
  let formGeneration = 0;
  let mutationOwner = 0;
  let phaseOwner = 0;

  const patch = (changes: Partial<GroupScheduleState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchForm = (changes: Partial<GroupScheduleFormState>): void => {
    patch({ form: { ...state.form, ...changes } });
  };

  const patchMutation = (changes: Partial<GroupScheduleMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  const clearPrivateState = (): Partial<GroupScheduleState> => ({
    phase: 'idle',
    rows: [],
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

  const runRead = async (): Promise<void> => {
    if (disposed) return;
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return;
    if (!readGuard.acquire()) return;
    const ticket = readGuard.holder();
    const generation = ++readGeneration;
    const principal = entryPrincipal;
    const phaseToken = ++phaseOwner;
    patch({ phase: 'loading', error: null, reason: null });
    try {
      const body = await api.list();
      if (disposed) return;
      if (generation !== readGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) return;
        settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const rows = Array.isArray(body) ? body : null;
      if (rows === null) {
        patch({ phase: 'error', rows: [], error: GROUP_SCHEDULE_MALFORMED_MESSAGE, reason: 'unknown' });
        return;
      }
      // Validate every row BEFORE any row is held: a malformed or oversized
      // body is a failed read, never a partially adopted list.
      const parsed: GroupSchedule[] = [];
      for (const item of rows) {
        const row = parseGroupSchedule(item);
        if (row === null) {
          patch({ phase: 'error', rows: [], error: GROUP_SCHEDULE_MALFORMED_MESSAGE, reason: 'unknown' });
          return;
        }
        parsed.push(row);
      }
      patch({
        phase: parsed.length === 0 ? 'empty' : 'ready',
        rows: parsed.sort(byName),
        error: null,
        reason: null,
      });
    } catch (cause) {
      if (disposed) return;
      if (generation !== readGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptRetiredPrincipalChange(observed)) return;
        settleReadPhase(phaseToken);
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return;
      }
      const failure = classifyGroupScheduleReadFailure(cause);
      if (isGroupScheduleAuthorizationLoss(failure.reason)) {
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: failure.phase,
          error: failure.message,
          reason: failure.reason,
        });
        return;
      }
      // Retryable: the permission loss is not proven, so a draft survives.
      patch({ phase: failure.phase, rows: [], error: failure.message, reason: failure.reason });
    } finally {
      readGuard.release(ticket);
    }
  };

  /** Removes one group from the held list (after a confirmed delete or a 404). */
  const dropRow = (groupId: string): void => {
    const rows = state.rows.filter((row) => row.id !== groupId);
    const changes: Partial<GroupScheduleState> = { rows };
    if (state.form.mode === 'edit' && state.form.targetId === groupId) {
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
      const failure = classifyGroupScheduleWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        patch(clearPrivateState());
        return;
      }
      if (failure.kind === 'uncertain') {
        patchMutation({ status: 'uncertain', error: failure.message, notice: GROUP_WRITE_UNCERTAIN_MESSAGE });
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
    kind: GroupScheduleMutationKind,
    targetId: string | null,
    execute: () => Promise<unknown>,
    formToken: number | null,
    expectDtoId: string | null,
  ): Promise<GroupScheduleWriteOutcome> => {
    if (disposed) return 'idle';
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

      if (kind === 'delete') {
        // The delete endpoint answers a message envelope, not a group DTO.
        mutationOwner = 0;
        dropRow(targetId as string);
        patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: GROUP_DELETED_MESSAGE });
        return 'confirmed';
      }

      const parsed = parseGroupSchedule(response);
      if (parsed === null) {
        mutationOwner = 0;
        patchMutation({ status: 'uncertain', error: null, notice: GROUP_WRITE_UNCERTAIN_MESSAGE });
        return 'uncertain';
      }
      if (expectDtoId !== null && parsed.id !== expectDtoId) {
        // A well-formed DTO for ANOTHER group is not a success for this write.
        mutationOwner = 0;
        patchMutation({ status: 'uncertain', error: null, notice: GROUP_WRITE_UNCERTAIN_MESSAGE });
        return 'uncertain';
      }

      mutationOwner = 0;
      patch({ rows: withRow(state.rows, parsed), lastConfirmed: parsed });
      if (kind === 'save' && formToken !== null && formGeneration === formToken) {
        formGeneration += 1;
        patchForm(closedForm());
      }
      patchMutation({ status: 'idle', kind: null, targetId: null, error: null, notice: null });
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
      const failure = classifyGroupScheduleWriteFailure(cause);
      if (failure.kind === 'unauthorized') {
        retireInFlight();
        patch(clearPrivateState());
        return 'rejected';
      }
      if (failure.kind === 'missing') {
        // The target vanished (or is foreign — the server answers the same).
        mutationOwner = 0;
        if (targetId !== null) dropRow(targetId);
        patchMutation({ status: 'idle', kind: null, targetId: null, error: failure.message, notice: null });
        return 'rejected';
      }
      if (failure.kind === 'denied') {
        // A definite denial: the private rows, the form and the draft go.
        retireInFlight();
        patch({
          ...clearPrivateState(),
          phase: 'denied',
          error: failure.message,
          reason: failure.reason,
        });
        return 'rejected';
      }
      if (failure.kind === 'invalid') {
        mutationOwner = 0;
        patchMutation({ status: 'idle', error: failure.message, notice: null });
        return 'rejected';
      }
      // Uncertain: the write may have persisted. The draft is preserved and
      // nothing is retried automatically.
      mutationOwner = 0;
      patchMutation({ status: 'uncertain', error: failure.message, notice: GROUP_WRITE_UNCERTAIN_MESSAGE });
      return 'uncertain';
    } finally {
      writeGuard.release(ticket);
    }
  };

  /**
   * Builds the strict canonical write body from the current form.
   *
   * `schedule_days` and `schedule_time` are ALWAYS present: an empty list and
   * an empty time are explicit clears, never an accidental omission.
   */
  const buildWrite = (): { write: GroupScheduleWrite | null; error: string | null } => {
    const form = state.form;
    const name = form.name.trim();
    if (name.length < 1 || name.length > 255) return { write: null, error: GROUP_NAME_INVALID_MESSAGE };

    const maxText = form.maxStudents.trim();
    const maxStudents = Number(maxText);
    if (maxText === '' || !Number.isInteger(maxStudents) || maxStudents < 1 || maxStudents > 1000) {
      return { write: null, error: GROUP_MAX_STUDENTS_INVALID_MESSAGE };
    }

    const time = form.time.trim();
    if (time !== '' && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      return { write: null, error: GROUP_TIME_INVALID_MESSAGE };
    }

    const description = form.description.trim();
    return {
      write: {
        name,
        description: description === '' ? null : description,
        grade_id: form.gradeId === '' ? null : form.gradeId,
        max_students: maxStudents,
        is_active: form.isActive,
        schedule_days: GROUP_SCHEDULE_DAYS.filter((day) => form.days.includes(day)),
        schedule_time: time === '' ? null : time,
      },
      error: null,
    };
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal (or a logout): every in-flight reply is foreign.
        retireInFlight();
        observedPrincipal = readPrincipal();
        patch(clearPrivateState());
        if (state.rows.length === 0) {
          const operation = runRead();
          track(operation);
        }
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    patch({ ...clearPrivateState() });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    load: () => {
      if (disposed) return Promise.resolve();
      const operation = runRead();
      track(operation);
      return operation;
    },
    refresh: () => {
      if (disposed) return Promise.resolve();
      const operation = runRead();
      track(operation);
      return operation;
    },
    openCreate: () => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      if (state.phase !== 'ready' && state.phase !== 'empty') return;
      formGeneration += 1;
      patchForm({ ...closedForm(), mode: 'create', isActive: true, maxStudents: '50' });
    },
    openEdit: (groupId) => {
      if (disposed) return;
      if (state.form.mode !== 'closed') return;
      const row = state.rows.find((candidate) => candidate.id === groupId);
      // The form is bound to a group of the CURRENT list only.
      if (!row) return;
      formGeneration += 1;
      patchForm({
        mode: 'edit',
        targetId: row.id,
        name: row.name,
        description: row.description ?? '',
        gradeId: row.grade_id ?? '',
        maxStudents: String(row.max_students),
        isActive: row.is_active,
        days: [...row.schedule_days],
        time: row.schedule_time ?? '',
        error: null,
      });
    },
    setField: (patchValues) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      patchForm({ ...patchValues, error: null });
    },
    toggleDay: (day) => {
      if (disposed) return;
      if (state.form.mode === 'closed') return;
      const has = state.form.days.includes(day);
      const days = has ? state.form.days.filter((value) => value !== day) : [...state.form.days, day];
      // Always held in canonical order, never as the click order.
      patchForm({ days: GROUP_SCHEDULE_DAYS.filter((value) => days.includes(value)), error: null });
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
      if (writeGuard.isBusy()) return Promise.resolve('blocked');
      const built = buildWrite();
      if (built.write === null) {
        // Local validation happens BEFORE any request and keeps the input.
        patchForm({ error: built.error });
        return Promise.resolve('invalid');
      }
      const formToken = formGeneration;
      const isEdit = state.form.mode === 'edit';
      const targetId = state.form.targetId;
      const write = built.write;
      const operation = isEdit && targetId !== null
        ? runWrite('save', targetId, () => api.update(targetId, write), formToken, targetId)
        : runWrite('save', null, () => api.create(write), formToken, null);
      track(operation);
      return operation;
    },
    remove: (groupId) => {
      if (disposed) return Promise.resolve('idle');
      if (writeGuard.isBusy()) return Promise.resolve('blocked');
      if (!state.rows.some((row) => row.id === groupId)) return Promise.resolve('idle');
      const operation = runWrite('delete', groupId, () => api.remove(groupId), null, null);
      track(operation);
      return operation;
    },
    setActive: (groupId, active) => {
      if (disposed) return Promise.resolve('idle');
      if (writeGuard.isBusy()) return Promise.resolve('blocked');
      const row = state.rows.find((candidate) => candidate.id === groupId);
      if (!row) return Promise.resolve('idle');
      if (row.is_active === active) return Promise.resolve('idle');
      const operation = runWrite(
        'toggle',
        groupId,
        () => api.update(groupId, { is_active: active }),
        null,
        groupId,
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
export function createProductionGroupScheduleController(storage?: CourseSessionStorage) {
  return createGroupScheduleController({
    list: () => listGroupSchedules(),
    create: (write) => createGroupSchedule(write),
    update: (id, write) => updateGroupSchedule(id, write),
    remove: (id) => deleteGroupSchedule(id),
    readPrincipal: () =>
      readCourseSessionPrincipal(
        storage ?? (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null }),
      ),
    subscribeSession: subscribeSessionChange,
  });
}
