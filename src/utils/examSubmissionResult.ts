/**
 * Exam submission outcome contract and submission state machine.
 *
 * Pure helpers shared by the real exam page (src/pages/TakeExam.tsx) and the
 * isolated M1 tests (src/tests/m1-security-ui.test.ts). No application
 * imports, no env, no network — everything here is deterministic logic.
 *
 * Server contract (server/src/routes/exams.ts, submit endpoint): on success
 * the persisted attempt is returned as
 *   { exam_id, student_id, status, completed_at, score, answers,
 *     total_marks, passing_marks, passed }
 * where `status` is one of the persisted exam_attempts statuses
 * 'passed' | 'failed' | 'pending_review'. HTTP rejections and network
 * failures surface as thrown errors from the API client, never as a
 * confirmed attempt.
 */

export type ExamScoreBreakdown = {
  hasEssayQuestions: boolean;
  autoScore: number;
  manualScore: number;
  pendingManualReview: boolean;
};

export type SubmittedExamResult = {
  score: number;
  total: number;
  percentage: number;
  passed: boolean;
} & ExamScoreBreakdown;

/**
 * Status values the server itself persists on an exam attempt and returns
 * from the submit endpoint. Any other status string is not a known
 * persisted-attempt outcome and must not finalize a student result.
 */
export const PERSISTED_ATTEMPT_STATUSES = ['passed', 'failed', 'pending_review'] as const;

export type PersistedAttemptStatus = (typeof PERSISTED_ATTEMPT_STATUSES)[number];

function isPersistedAttemptStatus(value: unknown): value is PersistedAttemptStatus {
  return typeof value === 'string'
    && (PERSISTED_ATTEMPT_STATUSES as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Maps a confirmed server submission into the result shown to the student.
 *
 * Only an explicit, known persisted status with the server's own numeric
 * grade produces a result. There is no client-score fallback: a rejection,
 * network failure, malformed payload, unknown status, or missing grade
 * returns null so the UI keeps the answers and offers a retry instead of
 * presenting a locally computed result.
 *
 * A 'pending_review' attempt stays pending (never a pass) until the server
 * grades it; a valid server grade always overrides the local estimate.
 * The local breakdown is display context only — score/total/passed come
 * from the server response.
 */
export function resolveSubmittedResult(
  local: SubmittedExamResult,
  response: unknown,
): SubmittedExamResult | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const data = response as Record<string, unknown>;

  if (!isPersistedAttemptStatus(data.status)) return null;

  // The server grade is authoritative; a missing or non-numeric grade is a
  // malformed confirmation, not permission to fall back to the local score.
  if (!isFiniteNumber(data.score)) return null;
  if (!isFiniteNumber(data.total_marks)) return null;

  const score = data.score;
  const total = data.total_marks;
  const pendingManualReview = data.status === 'pending_review';

  return {
    score,
    total,
    percentage: total > 0 ? (score / total) * 100 : 0,
    passed: data.status === 'passed',
    hasEssayQuestions: local.hasEssayQuestions,
    autoScore: local.autoScore,
    manualScore: local.manualScore,
    pendingManualReview,
  };
}

// ============================================================
// Submission state machine (pure reducer)
// ============================================================

export type ExamSubmissionPhase = 'idle' | 'submitting' | 'submitted' | 'failed';

export type ExamSubmissionState = {
  phase: ExamSubmissionPhase;
  result: SubmittedExamResult | null;
  error: string | null;
};

export const initialExamSubmissionState: ExamSubmissionState = {
  phase: 'idle',
  result: null,
  error: null,
};

export type ExamSubmissionAction =
  | { type: 'begin' }
  | { type: 'finalize'; result: SubmittedExamResult }
  | { type: 'fail'; error: string };

/**
 * Transitions for one exam attempt submission:
 * - 'begin' starts a submission; an in-flight submission cannot be
 *   duplicated by repeated clicks or a timer auto-submit, and a completed
 *   attempt can never begin again (only a failed attempt may retry).
 * - 'finalize' records a validated server outcome; only an in-flight
 *   submission can be finalized (a late/duplicate response cannot
 *   resurrect or overwrite a completed attempt).
 * - 'fail' records a rejection/network failure/malformed response; the
 *   attempt stays un-finalized (no result is shown, answers are kept by
 *   the page) and a later 'begin' retries. A completed attempt is never
 *   regressed to failed.
 */
export function examSubmissionReducer(
  state: ExamSubmissionState,
  action: ExamSubmissionAction,
): ExamSubmissionState {
  switch (action.type) {
    case 'begin':
      if (state.phase === 'submitting' || state.phase === 'submitted') return state;
      return { phase: 'submitting', result: null, error: null };
    case 'finalize':
      if (state.phase !== 'submitting') return state;
      return { phase: 'submitted', result: action.result, error: null };
    case 'fail':
      if (state.phase === 'submitted') return state;
      return { phase: 'failed', result: null, error: action.error };
    default:
      return state;
  }
}

// ============================================================
// Synchronous submission controller (shared by the real page handler)
// ============================================================

export type ExamSubmissionListener = (state: ExamSubmissionState) => void;

/**
 * Guarded submission state holder shared by src/pages/TakeExam.tsx (the
 * actual submit button handler and the countdown auto-submit) and the
 * isolated M1 tests.
 *
 * The reducer state above is React state: it updates asynchronously, so
 * two handler calls in the same tick — a click plus a timer auto-submit —
 * would both observe a stale 'idle' phase and invoke the submit API twice.
 * This controller adds a synchronous latch that is acquired before any
 * submission side effect (state transition or API invocation) and is the
 * single authority for whether a new attempt may begin.
 */
export type ExamSubmissionController = {
  /** Current state-machine snapshot for rendering. */
  getState: () => ExamSubmissionState;
  /** Subscribe to transitions; returns the unsubscribe function. */
  subscribe: (listener: ExamSubmissionListener) => () => void;
  /**
   * Atomically begins an attempt. Returns false — without any side
   * effect — when a submission is in flight or the attempt is completed,
   * so a same-tick duplicate call cannot invoke the submit API again and
   * a completed attempt can never begin again.
   */
  begin: () => boolean;
  /** Records a validated server outcome; only an in-flight attempt may finalize. */
  finalize: (result: SubmittedExamResult) => void;
  /**
   * Records a rejection/network failure/malformed response and releases
   * the latch so the student can retry. A completed attempt is never
   * regressed to failed.
   */
  fail: (error: string) => void;
};

export function createExamSubmissionController(): ExamSubmissionController {
  let state = initialExamSubmissionState;
  let latch: 'idle' | 'in-flight' | 'completed' = 'idle';
  const listeners = new Set<ExamSubmissionListener>();

  const commit = (next: ExamSubmissionState) => {
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin: () => {
      if (latch !== 'idle') return false;
      latch = 'in-flight';
      commit(examSubmissionReducer(state, { type: 'begin' }));
      return true;
    },
    finalize: (result) => {
      if (latch !== 'in-flight') return;
      latch = 'completed';
      commit(examSubmissionReducer(state, { type: 'finalize', result }));
    },
    fail: (error) => {
      if (latch === 'completed') return;
      if (latch === 'in-flight') latch = 'idle';
      commit(examSubmissionReducer(state, { type: 'fail', error }));
    },
  };
}

// ============================================================
// Guarded submission run (the actual handler orchestration)
// ============================================================

/** Shown when the submit API rejects or the network fails. */
export const EXAM_SUBMISSION_NETWORK_ERROR =
  'حدث خطأ أثناء إرسال الامتحان، إجاباتك محفوظة. يرجى المحاولة مرة أخرى.';

/** Shown when the server did not confirm a persisted attempt. */
export const EXAM_SUBMISSION_UNCONFIRMED_ERROR =
  'لم يؤكد الخادم تسليم الامتحان. إجاباتك محفوظة، يرجى إعادة المحاولة.';

export type ExamSubmissionRun =
  | { status: 'blocked' }
  | { status: 'failed'; error: string; cause?: unknown }
  | { status: 'finalized'; result: SubmittedExamResult };

/**
 * Runs one exam attempt submission through the shared controller:
 * 1. acquires the synchronous latch BEFORE any side effect, so same-tick
 *    duplicate calls (click + timer) and post-completion calls are
 *    blocked without invoking the submit API;
 * 2. a rejection/network failure fails the attempt honestly (message +
 *    cause for diagnostics) and releases the latch so a retry is possible;
 * 3. only a response validated by resolveSubmittedResult finalizes the
 *    attempt with the server's own grade — never the local score.
 */
export async function runExamSubmission(
  controller: ExamSubmissionController,
  submitAttempt: () => Promise<unknown>,
  local: SubmittedExamResult,
): Promise<ExamSubmissionRun> {
  if (!controller.begin()) return { status: 'blocked' };

  let response: unknown;
  try {
    response = await submitAttempt();
  } catch (cause) {
    controller.fail(EXAM_SUBMISSION_NETWORK_ERROR);
    return { status: 'failed', error: EXAM_SUBMISSION_NETWORK_ERROR, cause };
  }

  const finalResult = resolveSubmittedResult(local, response);
  if (!finalResult) {
    // The server did not confirm a recorded attempt: no result is shown,
    // answers stay in place and the student can retry.
    controller.fail(EXAM_SUBMISSION_UNCONFIRMED_ERROR);
    return { status: 'failed', error: EXAM_SUBMISSION_UNCONFIRMED_ERROR };
  }

  controller.finalize(finalResult);
  return { status: 'finalized', result: finalResult };
}
