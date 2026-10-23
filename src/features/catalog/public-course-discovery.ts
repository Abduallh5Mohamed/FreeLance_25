/**
 * M2-22 — anonymous published-course discovery: the production client seam.
 *
 * `src/pages/PublicCourseDiscovery.tsx` mounts through
 * `createProductionPublicCourseDiscoveryController` below. This module owns the
 * WHOLE request lifecycle of the public `/discover` page — the bounded page
 * read, the server-cursor "next page" read, the debounced and bounded search,
 * the exact detail read, duplicate-submit blocking, retained state and the
 * session / list / search / target / dispose fences — and keeps React rendering
 * out of the decision path.
 *
 * The transport, the principal reader, the session notifier and the timer are
 * injected, so the exact production code the page runs is exercised hermetically
 * in `src/tests/m2-public-course-discovery.test.ts` with no DB, no network, no
 * browser and no live app.
 *
 * Contracts verified from source (`docs/streams/server/M2-B14-CONTRACT.md`,
 * implemented in `server/src/routes/public-catalog.ts`):
 *  - `GET /api/public/courses?limit&cursor&q` answers `{ courses, next_cursor }`
 *    for the published, active courses of ACTIVE academies only. `limit` is
 *    1..60 (default 24), `q` is trimmed to 1..100 characters and matches the
 *    course name and subject only, and `cursor` is an opaque position. A
 *    malformed limit, cursor or search term is the documented 400;
 *  - each course is the fixed TEN-field projection `{ course_id, name, subject,
 *    description, grade, tenant_id, business_name, display_name_ar,
 *    display_name_en, accent_color }` — no price, no instructor, no lesson, no
 *    material, no contact detail and no publication or archive flag;
 *  - `GET /api/public/courses/:courseId` answers `{ course }` with the same
 *    projection. An unpublished course, a course of another academy and a
 *    course that does not exist are ONE 404 `Course not found`, so the page
 *    cannot present them differently;
 *  - the surface is ANONYMOUS and read only: no principal is required and none
 *    is consulted, and nothing here enrolls, grants access, delivers a lesson
 *    or a file, notifies anyone or takes payment;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify an
 *    outcome. No status is fabricated and no permission is inferred from an
 *    unrecognized message.
 *
 * Lifetimes fenced here:
 *  - list: every page read advances a generation and takes a single-flight latch
 *    BEFORE the first await, so a double-clicked refresh never sends a second
 *    request and a superseded reply never commits. A "next page" read is only
 *    issued when the server minted a cursor, it appends to the page it was
 *    issued for, and it never runs while another read is in flight;
 *  - search: the typed value is retained immediately, but the READ is debounced
 *    and bounded. Each keystroke advances the search generation, so a debounced
 *    read that fires after a newer keystroke is dropped instead of committing a
 *    page for an obsolete term. A blank term is sent as no filter at all;
 *  - target: a detail reply carrying another course's id is NOT a success for
 *    the course the page is showing, and closing the detail retires it;
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read, on the success and the failure path. A change retires every
 *    in-flight operation, but it does NOT discard the held page: the published
 *    catalogue is public data that is byte-identical for every principal, so
 *    nothing held becomes foreign. No automatic re-read is issued for the same
 *    reason;
 *  - dispose: nothing commits after the page is gone, and the pending debounce
 *    is cancelled.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success and is never a
 *    partially adopted page;
 *  - a failed NEXT page never discards the page already on screen, and a failed
 *    search never silently shows the previous term's rows under the new term;
 *  - the server is the source of truth: the page renders the validated server
 *    rows only, and no local filtering, sorting or page-count arithmetic is
 *    invented to hide what the server did not send.
 */
import {
  PUBLIC_COURSE_MALFORMED_MESSAGE,
  PUBLIC_COURSE_PAGE_LIMIT,
  PUBLIC_COURSE_PAGE_MAX,
  PUBLIC_COURSE_SEARCH_MAX,
  PUBLIC_COURSE_UNAVAILABLE_MESSAGE,
  getPublicCourse,
  listPublicCourses,
  parsePublicCourse,
  parsePublicCourseEnvelope,
  parsePublicCourseList,
  type PublicCourse,
  type PublicCourseEnvelope,
  type PublicCourseListEnvelope,
} from '../../lib/api-http';
import { subscribeSessionChange } from '../../lib/session-events';
import {
  createCourseOperationGuard,
  createTicketSource,
  readCourseSessionPrincipal,
} from './course-management';
import type { CourseSessionStorage } from './course-management';

export {
  PUBLIC_COURSE_MALFORMED_MESSAGE,
  PUBLIC_COURSE_PAGE_LIMIT,
  PUBLIC_COURSE_PAGE_MAX,
  PUBLIC_COURSE_SEARCH_MAX,
  PUBLIC_COURSE_UNAVAILABLE_MESSAGE,
};
export type { PublicCourse, PublicCourseEnvelope, PublicCourseListEnvelope, CourseSessionStorage };

/** The canonical session reader, re-exported so the page imports ONE boundary. */
export { readCourseSessionPrincipal };

/**
 * How long a keystroke waits before it is turned into a read. Long enough that
 * typing a word is one request, short enough that the page still feels live.
 */
export const PUBLIC_COURSE_SEARCH_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

/** Upstream authentication answers. The public read never needs a session, so
 *  these only ever appear when a stale token is attached to the request. */
const SESSION_MESSAGES = new Set<string>([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
]);

/** The one answer for unpublished, foreign and absent — deliberately merged. */
const UNAVAILABLE_MESSAGE = PUBLIC_COURSE_UNAVAILABLE_MESSAGE;

/** Strict query rejections: the server read nothing and wrote nothing. */
const INVALID_MESSAGES = new Set<string>([
  'Invalid public course list limit',
  'Invalid public course list cursor',
  'Invalid public course search term',
]);

/** The bounded read wordings. */
const LIST_FAILED_MESSAGE = 'Failed to load public courses';
const DETAIL_FAILED_MESSAGE = 'Failed to load public course';

export type PublicDiscoveryPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export type PublicDiscoveryFailureReason =
  | 'session'
  | 'unavailable'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface PublicDiscoveryFailure {
  readonly reason: PublicDiscoveryFailureReason;
  readonly message: string;
}

/** Classifies ONLY the documented transported messages of a LIST read. */
export function classifyPublicDiscoveryFailure(cause: unknown): PublicDiscoveryFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (SESSION_MESSAGES.has(message)) return { reason: 'session', message };
  if (INVALID_MESSAGES.has(message)) return { reason: 'invalid', message };
  if (message === LIST_FAILED_MESSAGE || message === DETAIL_FAILED_MESSAGE) {
    return { reason: 'server', message };
  }
  if (message === PUBLIC_COURSE_MALFORMED_MESSAGE) return { reason: 'unknown', message };
  return { reason: 'unknown', message: message || 'تعذّر تحميل الكورسات المنشورة.' };
}

/** Classifies ONLY the documented transported messages of a DETAIL read. */
export function classifyPublicCourseDetailFailure(cause: unknown): PublicDiscoveryFailure {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  if (message === UNAVAILABLE_MESSAGE) return { reason: 'unavailable', message };
  return classifyPublicDiscoveryFailure(cause);
}

// ---------------------------------------------------------------------------
// Search term normalisation (bounded, never sent raw)
// ---------------------------------------------------------------------------

export type PublicSearchTerm =
  | { readonly ok: true; readonly term: string | null }
  | { readonly ok: false; readonly message: string };

export const PUBLIC_COURSE_SEARCH_TOO_LONG_MESSAGE =
  'نص البحث طويل جدًا؛ الحد الأقصى 100 حرف.';

/**
 * Normalises what the user typed into the term the server may receive.
 *
 * A blank (or whitespace-only) value is `null`, which the transport sends as NO
 * filter at all rather than an empty `q`. A term longer than the server ceiling
 * is refused LOCALLY, so an over-long paste never becomes a wasted request.
 */
export function normalisePublicSearchTerm(raw: string | null | undefined): PublicSearchTerm {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: true, term: null };
  if (text.length > PUBLIC_COURSE_SEARCH_MAX) {
    return { ok: false, message: PUBLIC_COURSE_SEARCH_TOO_LONG_MESSAGE };
  }
  return { ok: true, term: text };
}

// ---------------------------------------------------------------------------
// Timer seam (so the debounce is testable without real waiting)
// ---------------------------------------------------------------------------

export interface PublicDiscoveryTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: PublicDiscoveryTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type PublicDetailStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export interface PublicCourseDetailState {
  status: PublicDetailStatus;
  /** The course the detail panel is bound to (null when it is closed). */
  courseId: string | null;
  course: PublicCourse | null;
  error: string | null;
}

export interface PublicDiscoveryState {
  phase: PublicDiscoveryPhase;
  courses: PublicCourse[];
  /** The opaque position the server minted, or null when the page is complete. */
  nextCursor: string | null;
  /** True while a bounded "next page" read is in flight. */
  loadingMore: boolean;
  /** What the user typed. Retained even while the read is debounced or refused. */
  searchInput: string;
  /** The term the rows on screen were actually read with (null = unfiltered). */
  appliedSearch: string | null;
  error: string | null;
  reason: PublicDiscoveryFailureReason | null;
  detail: PublicCourseDetailState;
}

const idleDetail = (): PublicCourseDetailState => ({
  status: 'idle',
  courseId: null,
  course: null,
  error: null,
});

const initialState: PublicDiscoveryState = {
  phase: 'idle',
  courses: [],
  nextCursor: null,
  loadingMore: false,
  searchInput: '',
  appliedSearch: null,
  error: null,
  reason: null,
  detail: idleDetail(),
};

/** The explicit result of a read, so the page never guesses from state. */
export type PublicDiscoveryReadOutcome = 'ready' | 'empty' | 'blocked' | 'invalid' | 'failed';
export type PublicDetailOutcome = 'ready' | 'unavailable' | 'blocked' | 'failed' | 'idle';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface PublicCourseDiscoveryApi {
  list(options: {
    limit?: number;
    cursor?: string | null;
    search?: string | null;
  }): Promise<unknown>;
  detail(courseId: string): Promise<unknown>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
  timer?: PublicDiscoveryTimer;
}

export interface PublicCourseDiscoveryController {
  getState(): PublicDiscoveryState;
  subscribe(listener: (state: PublicDiscoveryState) => void): () => void;
  /** Reads the first bounded page with the currently applied term. */
  load(): Promise<PublicDiscoveryReadOutcome>;
  /** A deliberate re-read of the first page of the CURRENT term. */
  refresh(): Promise<PublicDiscoveryReadOutcome>;
  /** Reads the NEXT bounded page when the server minted a cursor. */
  loadMore(): Promise<PublicDiscoveryReadOutcome>;
  /** Records what the user typed and schedules ONE debounced read. */
  setSearch(value: string): void;
  /** Applies the typed term immediately (Enter / explicit submit). */
  applySearch(): Promise<PublicDiscoveryReadOutcome>;
  /** Opens the detail panel for one course and reads it. */
  openDetail(courseId: string): Promise<PublicDetailOutcome>;
  closeDetail(): void;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export function createPublicCourseDiscoveryController(
  api: PublicCourseDiscoveryApi,
): PublicCourseDiscoveryController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: PublicDiscoveryState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  const timer = api.timer ?? defaultTimer;
  /** One list read at a time, shared by the first page, the next page and a
   *  search: a double click or a keystroke during a read never stacks requests. */
  const readGuard = createCourseOperationGuard(tickets);
  /** One detail read at a time. */
  const detailGuard = createCourseOperationGuard(tickets);
  let readGeneration = 0;
  let searchGeneration = 0;
  let detailGeneration = 0;
  let debounceHandle: unknown = null;
  let debouncePending = false;
  let phaseOwner = 0;

  const patch = (changes: Partial<PublicDiscoveryState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchDetail = (changes: Partial<PublicCourseDetailState>): void => {
    patch({ detail: { ...state.detail, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  const cancelDebounce = (): void => {
    if (debounceHandle !== null) {
      timer.clear(debounceHandle);
      debounceHandle = null;
    }
    debouncePending = false;
  };

  /**
   * Retires every in-flight operation. The held page is deliberately KEPT: the
   * published catalogue is public, so a principal change cannot make a held row
   * foreign — only an in-flight reply becomes unstampable.
   */
  const retireInFlight = (): void => {
    readGeneration += 1;
    searchGeneration += 1;
    detailGeneration += 1;
    readGuard.release();
    detailGuard.release();
    cancelDebounce();
  };

  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    retireInFlight();
    // The page stays as it is; only the notice of a failed read would now be
    // attributed to the wrong session, so it is cleared.
    patch({ loadingMore: false, error: null, reason: null });
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
    patch({ phase: state.courses.length > 0 ? 'ready' : 'idle', error: null, reason: null });
  };

  /**
   * Reads ONE bounded page.
   *
   * `cursor` is null for the first page and the server-minted position for a
   * "next page". `term` is the normalised search term the read belongs to; an
   * append only lands when the reply belongs to the SAME read generation AND
   * the SAME search generation it was issued for.
   */
  const runRead = async (
    cursor: string | null,
    term: string | null,
    searchToken: number,
  ): Promise<PublicDiscoveryReadOutcome> => {
    if (disposed) return 'blocked';
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return 'blocked';
    if (!readGuard.acquire()) return 'blocked';
    const ticket = readGuard.holder();
    const generation = ++readGeneration;
    const principal = entryPrincipal;
    const phaseToken = ++phaseOwner;
    const appending = cursor !== null;
    patch(appending
      ? { loadingMore: true, error: null, reason: null }
      : { phase: 'loading', loadingMore: false, error: null, reason: null });
    try {
      const body = await api.list({
        limit: PUBLIC_COURSE_PAGE_LIMIT,
        cursor,
        search: term,
      });
      if (disposed) return 'blocked';
      if (generation !== readGeneration || searchToken !== searchGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptPrincipalChange(observed)) return 'blocked';
        // A retired read still settles the phase it put the page into: a
        // superseded page must never stay stuck on "loading". `settleReadPhase`
        // is a no-op when a NEWER read has since claimed the phase.
        settleReadPhase(phaseToken);
        return 'blocked';
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return 'blocked';
      }
      const page = parsePublicCourseList(body);
      if (page === null) {
        // A malformed body is a failed read, never a partially adopted page —
        // and it never discards a page that is already held.
        patch(appending
          ? { loadingMore: false, error: PUBLIC_COURSE_MALFORMED_MESSAGE, reason: 'unknown' }
          : {
              phase: 'error',
              courses: [],
              nextCursor: null,
              loadingMore: false,
              appliedSearch: term,
              error: PUBLIC_COURSE_MALFORMED_MESSAGE,
              reason: 'unknown',
            });
        return 'failed';
      }
      // Every row is validated by `parsePublicCourseList` BEFORE any row is
      // held, so a malformed or oversized body is a failed read.
      const courses = appending ? [...state.courses, ...page.courses] : page.courses;
      patch({
        phase: courses.length === 0 ? 'empty' : 'ready',
        courses,
        nextCursor: page.next_cursor,
        loadingMore: false,
        appliedSearch: term,
        error: null,
        reason: null,
      });
      return courses.length === 0 ? 'empty' : 'ready';
    } catch (cause) {
      if (disposed) return 'blocked';
      if (generation !== readGeneration || searchToken !== searchGeneration) {
        const observed = readPrincipal();
        if (observed !== principal && adoptPrincipalChange(observed)) return 'blocked';
        settleReadPhase(phaseToken);
        return 'blocked';
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return 'blocked';
      }
      const failure = classifyPublicDiscoveryFailure(cause);
      // A failed NEXT page never discards the page already held.
      patch(appending
        ? { loadingMore: false, error: failure.message, reason: failure.reason }
        : {
            phase: 'error',
            courses: [],
            nextCursor: null,
            loadingMore: false,
            appliedSearch: term,
            error: failure.message,
            reason: failure.reason,
          });
      return 'failed';
    } finally {
      readGuard.release(ticket);
    }
  };

  /** Issues a first-page read for `term`, advancing the search generation. */
  const startFirstPage = (term: string | null): Promise<PublicDiscoveryReadOutcome> => {
    if (disposed) return Promise.resolve('blocked');
    // A duplicate fired in the same tick is refused BEFORE the search generation
    // advances, so the read that already owns the latch keeps its token and
    // still commits its own reply.
    if (readGuard.isBusy()) return Promise.resolve('blocked');
    // A newer term (or an explicit apply) always supersedes a pending debounce.
    cancelDebounce();
    const searchToken = ++searchGeneration;
    const operation = runRead(null, term, searchToken);
    track(operation);
    return operation;
  };

  const setSearch = (value: string): void => {
    if (disposed) return;
    const raw = typeof value === 'string' ? value : '';
    // The typed value is retained EXACTLY as typed; only the term that is sent
    // is normalised. A refused (over-long) term is reported without a request.
    const normalised = normalisePublicSearchTerm(raw);
    cancelDebounce();
    // Every keystroke retires the previous debounced read, so a timer that fires
    // late can never commit a page for an obsolete term.
    searchGeneration += 1;
    if (normalised.ok === false) {
      patch({ searchInput: raw, error: normalised.message, reason: 'invalid' });
      return;
    }
    patch({ searchInput: raw, error: null, reason: null });
    const term = normalised.term;
    // Debounced read: the generation captured HERE is what the read carries.
    const searchToken = searchGeneration;
    debouncePending = true;
    debounceHandle = timer.set(() => {
      debounceHandle = null;
      if (!debouncePending) return;
      debouncePending = false;
      if (disposed) return;
      if (searchToken !== searchGeneration) return;
      if (term === state.appliedSearch && state.phase !== 'error' && state.phase !== 'idle') {
        // The term did not actually change and the page is already showing it:
        // a truthful no-op sends NOTHING.
        return;
      }
      const operation = runRead(null, term, searchToken);
      track(operation);
    }, PUBLIC_COURSE_SEARCH_DEBOUNCE_MS);
  };

  const applySearch = (): Promise<PublicDiscoveryReadOutcome> => {
    if (disposed) return Promise.resolve('blocked');
    const normalised = normalisePublicSearchTerm(state.searchInput);
    if (normalised.ok === false) {
      cancelDebounce();
      searchGeneration += 1;
      patch({ error: normalised.message, reason: 'invalid' });
      return Promise.resolve('invalid');
    }
    return startFirstPage(normalised.term);
  };

  const openDetail = async (courseId: string): Promise<PublicDetailOutcome> => {
    if (disposed) return 'idle';
    const target = typeof courseId === 'string' ? courseId.trim() : '';
    if (target === '') return 'idle';
    const entryPrincipal = readPrincipal();
    if (adoptPrincipalChange(entryPrincipal)) return 'idle';
    if (!detailGuard.acquire()) return 'blocked';
    const ticket = detailGuard.holder();
    const generation = ++detailGeneration;
    const principal = entryPrincipal;
    // A NEW target is a NEW panel: the previous course is dropped immediately so
    // the page can never show one course under another course's heading.
    patchDetail({ status: 'loading', courseId: target, course: null, error: null });
    try {
      const body = await api.detail(target);
      if (disposed) return 'idle';
      if (generation !== detailGeneration || state.detail.courseId !== target) {
        const observed = readPrincipal();
        if (observed !== principal) adoptPrincipalChange(observed);
        return 'blocked';
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return 'idle';
      }
      const envelope = parsePublicCourseEnvelope(body);
      if (envelope === null || envelope.course.course_id !== target) {
        // A malformed envelope — or a well-formed one for ANOTHER course — is
        // not a success for this read.
        patchDetail({ status: 'error', course: null, error: PUBLIC_COURSE_MALFORMED_MESSAGE });
        return 'failed';
      }
      patchDetail({ status: 'ready', courseId: target, course: envelope.course, error: null });
      return 'ready';
    } catch (cause) {
      if (disposed) return 'idle';
      if (generation !== detailGeneration || state.detail.courseId !== target) {
        const observed = readPrincipal();
        if (observed !== principal) adoptPrincipalChange(observed);
        return 'blocked';
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== principal) {
        adoptPrincipalChange(committedPrincipal);
        return 'idle';
      }
      const failure = classifyPublicCourseDetailFailure(cause);
      if (failure.reason === 'unavailable') {
        // Unpublished, foreign and absent are ONE answer. The page says the
        // course is unavailable and never guesses which of the three it was.
        patchDetail({ status: 'unavailable', course: null, error: failure.message });
        return 'unavailable';
      }
      patchDetail({ status: 'error', course: null, error: failure.message });
      return 'failed';
    } finally {
      detailGuard.release(ticket);
    }
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        // Another principal: every in-flight reply is unstampable, but the
        // public rows on screen remain valid public data.
        retireInFlight();
        observedPrincipal = readPrincipal();
        patch({
          // A read that was interrupted must not leave the page stuck on
          // "loading": it settles to what is actually held.
          phase: state.phase === 'loading'
            ? (state.courses.length > 0 ? 'ready' : 'idle')
            : state.phase,
          loadingMore: false,
          error: null,
          reason: null,
          detail: idleDetail(),
        });
      })
    : undefined;

  const dispose = (): void => {
    disposed = true;
    if (unsubscribeSession) unsubscribeSession();
    retireInFlight();
    patch({ ...initialState, courses: [], detail: idleDetail() });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    load: () => startFirstPage(state.appliedSearch),
    refresh: () => startFirstPage(state.appliedSearch),
    loadMore: () => {
      if (disposed) return Promise.resolve('blocked');
      // Only the server's own cursor can ask for a next page, and only once at
      // a time: a double click never fetches the same page twice.
      const cursor = state.nextCursor;
      if (cursor === null) return Promise.resolve('blocked');
      if (readGuard.isBusy()) return Promise.resolve('blocked');
      const operation = runRead(cursor, state.appliedSearch, searchGeneration);
      track(operation);
      return operation;
    },
    setSearch,
    applySearch,
    openDetail,
    closeDetail: () => {
      if (disposed) return;
      // Closing retires the read, so a reply that is already on the wire can no
      // longer reopen the panel the user just dismissed.
      detailGeneration += 1;
      detailGuard.release();
      patchDetail(idleDetail());
    },
    waitForIdle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    dispose,
  };
}

/**
 * The production wiring the page mounts. Kept here so the page holds no
 * transport knowledge of its own.
 *
 * The page is public, so no principal is required for the READ — but the reader
 * is still wired so a same-document login/logout retires an in-flight reply
 * instead of stamping it with a session that no longer exists.
 */
export function createProductionPublicCourseDiscoveryController(storage?: CourseSessionStorage) {
  return createPublicCourseDiscoveryController({
    list: (options) => listPublicCourses(options),
    detail: (courseId) => getPublicCourse(courseId),
    readPrincipal: () =>
      readCourseSessionPrincipal(
        storage ?? (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null }),
      ),
    subscribeSession: subscribeSessionChange,
  });
}

/**
 * Parses ONE public course from an already-transported body. Re-exported so a
 * page that holds a cached body (for example from a share link) validates it
 * through the SAME strict parser instead of a second, weaker one.
 */
export function readPublicCourse(body: unknown): PublicCourse | null {
  return parsePublicCourse(body);
}
