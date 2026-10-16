/**
 * M1 security-UI isolated tests (node:test + tsx).
 *
 * Scope: authenticated security-event submission and honest failure reporting
 * for the frontend security layer (VideoSecurityManager + the shared auth
 * contract used by useSecuritySupervisor), plus the exam submission outcome
 * contract, submission state machine and shared submission controller
 * (examSubmissionResult) used by src/pages/TakeExam.tsx — including
 * request deduplication for same-tick duplicate submissions.
 *
 * These tests are fully isolated: no env files, no database, no network, no
 * real services. `fetch` and `localStorage` are stubbed with disposable values.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  VideoSecurityManager,
  buildSecurityEventRequest,
  type SecurityViolation,
} from "../utils/VideoSecurityManager";
import {
  EXAM_SUBMISSION_NETWORK_ERROR,
  EXAM_SUBMISSION_UNCONFIRMED_ERROR,
  createExamSubmissionController,
  examSubmissionReducer,
  initialExamSubmissionState,
  resolveSubmittedResult,
  runExamSubmission,
  type SubmittedExamResult,
} from "../utils/examSubmissionResult";

interface StoredFetch {
  calls: Array<{ url: string; init?: RequestInit }>;
  responses: Array<{ ok: boolean; status: number }>;
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

function installLocalStorage(token: string | null): void {
  const store = new Map<string, string>();
  if (token !== null) store.set("authToken", token);
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function installFetch(responses: Array<{ ok: boolean; status: number }>): StoredFetch {
  const state: StoredFetch = { calls: [], responses };
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    state.calls.push({ url: String(input), init });
    const next = state.responses.shift() ?? { ok: true, status: 200 };
    return {
      ok: next.ok,
      status: next.status,
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;
  return state;
}

function captureConsoleError(): { messages: unknown[]; restore: () => void } {
  const messages: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args);
  };
  return { messages, restore: () => { console.error = original; } };
}

/** A promise whose settlement is controlled by the test, like a real in-flight API call. */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sampleViolation: SecurityViolation = {
  type: "screenshot",
  details: "PrintScreen attempt",
  timestamp: 1700000000000,
  platform: "desktop",
};

test("security event requests use the central bearer auth contract", () => {
  installLocalStorage("test-token-123");
  const { url, init } = buildSecurityEventRequest("/secure-video/report-violation", {
    sessionId: "sess-1",
    violationType: "devtools_open",
    details: "F12 pressed",
    confidence: "high",
  });

  assert.equal(init.method, "POST");
  assert.ok(url.endsWith("/secure-video/report-violation"), `unexpected url: ${url}`);
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Authorization"], "Bearer test-token-123");
  const body = JSON.parse(String(init.body));
  assert.equal(body.violationType, "devtools_open");
  assert.equal(body.confidence, "high");
});

test("security event requests omit Authorization when no token is stored", () => {
  installLocalStorage(null);
  const { init } = buildSecurityEventRequest("/secure-video/heartbeat", { sessionId: "sess-1" });
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Authorization"], undefined);
});

test("VideoSecurityManager logs violations with authentication", async () => {
  installLocalStorage("dummy-token");
  const fetchState = installFetch([{ ok: true, status: 200 }]);
  const manager = new VideoSecurityManager({
    userId: "user-1",
    videoId: "video-1",
    studentName: "Test Student",
    onViolation: () => { },
    onForceLogout: () => { },
    isHostedVideo: false,
  });

  const logged = await manager.logSecurityEvent(sampleViolation);

  assert.equal(logged, true);
  assert.equal(fetchState.calls.length, 1);
  const call = fetchState.calls[0];
  assert.ok(call.url.endsWith("/videos/security/log"), `unexpected url: ${call.url}`);
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer dummy-token");
  const body = JSON.parse(String(call.init?.body));
  assert.equal(body.activityType, "screenshot");
  assert.equal(body.userId, "user-1");
  assert.equal(body.videoId, "video-1");
  assert.match(String(body.details), /PrintScreen attempt \| Platform: /);
});

test("a rejected security event is reported as failed, not silently accepted", async () => {
  installLocalStorage("dummy-token");
  installFetch([{ ok: false, status: 500 }]);
  const consoleCapture = captureConsoleError();
  const manager = new VideoSecurityManager({
    userId: "user-1",
    videoId: "video-1",
    studentName: "Test Student",
    onViolation: () => { },
    onForceLogout: () => { },
    isHostedVideo: false,
  });

  try {
    const logged = await manager.logSecurityEvent(sampleViolation);
    assert.equal(logged, false, "a rejected event must not be reported as logged");
    assert.ok(
      consoleCapture.messages.length > 0,
      "an HTTP rejection must be logged, not swallowed silently",
    );
  } finally {
    consoleCapture.restore();
  }
});

test("a network failure while logging a violation is reported and does not throw", async () => {
  installLocalStorage("dummy-token");
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const consoleCapture = captureConsoleError();
  const manager = new VideoSecurityManager({
    userId: "user-1",
    videoId: "video-1",
    studentName: "Test Student",
    onViolation: () => { },
    onForceLogout: () => { },
    isHostedVideo: false,
  });

  try {
    const logged = await manager.logSecurityEvent(sampleViolation);
    assert.equal(logged, false);
    assert.ok(consoleCapture.messages.length > 0, "network failures must be reported honestly");
  } finally {
    consoleCapture.restore();
  }
});

// ============================================================
// Exam submission outcome contract (pure resolver, no app imports)
// ============================================================

// Local estimate deliberately disagrees with the server so tests prove the
// server grade wins and the local score is never used as a fallback.
const localResult: SubmittedExamResult = {
  score: 30,
  total: 100,
  percentage: 30,
  passed: true,
  hasEssayQuestions: true,
  autoScore: 30,
  manualScore: 70,
  pendingManualReview: true,
};

test("a valid passed server response finalizes with the server grade, overriding the local score", () => {
  const result = resolveSubmittedResult(localResult, {
    exam_id: "exam-1",
    student_id: "student-1",
    status: "passed",
    completed_at: "2026-10-13T00:00:00.000Z",
    score: 80,
    total_marks: 100,
    passing_marks: 50,
    passed: true,
  });

  assert.ok(result, "a known passed status with a server grade must finalize");
  assert.equal(result.score, 80, "server score must override the local score");
  assert.equal(result.total, 100);
  assert.equal(result.passed, true);
  assert.equal(result.pendingManualReview, false);
  assert.equal(result.percentage, 80);
  // Display context from the local breakdown is retained.
  assert.equal(result.hasEssayQuestions, true);
  assert.equal(result.autoScore, 30);
  assert.equal(result.manualScore, 70);
});

test("a valid failed server response finalizes as failed with the server grade", () => {
  const result = resolveSubmittedResult(localResult, {
    status: "failed",
    score: 20,
    total_marks: 100,
    passed: false,
  });

  assert.ok(result);
  assert.equal(result.score, 20);
  assert.equal(result.passed, false);
  assert.equal(result.pendingManualReview, false);
  assert.equal(result.percentage, 20);
});

test("a pending_review server response stays pending and is never presented as a pass", () => {
  const result = resolveSubmittedResult(localResult, {
    status: "pending_review",
    score: 30,
    total_marks: 100,
    passed: false,
  });

  assert.ok(result);
  assert.equal(result.pendingManualReview, true, "pending essay review must follow the server status");
  assert.equal(result.passed, false, "a pending attempt is not a final grade");
  assert.equal(result.score, 30);
});

test("an unknown status string is not a confirmed outcome", () => {
  for (const status of ["graded", "completed", "submitted", "pending", "", "PASSED", 42, null]) {
    const result = resolveSubmittedResult(localResult, {
      status,
      score: 80,
      total_marks: 100,
      passed: true,
    });
    assert.equal(result, null, `status ${JSON.stringify(status)} must not finalize a result`);
  }
});

test("a response without a known status is not confirmed even when it carries passed/score", () => {
  const result = resolveSubmittedResult(localResult, {
    score: 80,
    total_marks: 100,
    passed: true,
  });
  assert.equal(result, null, "a bare passed flag without the persisted status must not finalize");
});

test("a missing or non-numeric server score does not fall back to the local score", () => {
  const missingScore = resolveSubmittedResult(localResult, { status: "passed", total_marks: 100 });
  const stringScore = resolveSubmittedResult(localResult, { status: "passed", score: "80", total_marks: 100 });
  const nanScore = resolveSubmittedResult(localResult, { status: "passed", score: Number.NaN, total_marks: 100 });
  assert.equal(missingScore, null, "a confirmed status without a server grade must not finalize");
  assert.equal(stringScore, null);
  assert.equal(nanScore, null);
});

test("a confirmed status without server total marks is not accepted", () => {
  const missingTotal = resolveSubmittedResult(localResult, { status: "passed", score: 80 });
  const stringTotal = resolveSubmittedResult(localResult, { status: "failed", score: 20, total_marks: "100" });
  assert.equal(missingTotal, null);
  assert.equal(stringTotal, null);
});

test("malformed payloads (rejections, network failures, wrong shapes) never finalize", () => {
  for (const payload of [null, undefined, "", 42, true, [], ["passed"], { error: "Failed to submit exam attempt" }]) {
    assert.equal(
      resolveSubmittedResult(localResult, payload),
      null,
      `payload ${JSON.stringify(payload)} must not finalize`,
    );
  }
});

// ============================================================
// Exam submission state transitions (pure reducer used by TakeExam)
// ============================================================

const confirmedResult: SubmittedExamResult = {
  score: 80,
  total: 100,
  percentage: 80,
  passed: true,
  hasEssayQuestions: false,
  autoScore: 80,
  manualScore: 0,
  pendingManualReview: false,
};

test("a submission already in flight cannot be duplicated by repeated clicks or the timer", () => {
  const submitting = examSubmissionReducer(initialExamSubmissionState, { type: "begin" });
  const duplicate = examSubmissionReducer(submitting, { type: "begin" });
  assert.equal(submitting.phase, "submitting");
  assert.equal(duplicate, submitting, "a second begin while in flight must be a no-op");
});

test("only an in-flight submission can be finalized with a validated server outcome", () => {
  const finalized = examSubmissionReducer(
    examSubmissionReducer(initialExamSubmissionState, { type: "begin" }),
    { type: "finalize", result: confirmedResult },
  );
  assert.equal(finalized.phase, "submitted");
  assert.deepEqual(finalized.result, confirmedResult);
  assert.equal(finalized.error, null);

  const strayFinalize = examSubmissionReducer(initialExamSubmissionState, {
    type: "finalize",
    result: confirmedResult,
  });
  assert.equal(strayFinalize.phase, "idle", "a late/duplicate response must not finalize from idle");
  assert.equal(strayFinalize.result, null);
});

test("a failure keeps the attempt un-finalized and a retry begins a new submission", () => {
  const failed = examSubmissionReducer(
    examSubmissionReducer(initialExamSubmissionState, { type: "begin" }),
    { type: "fail", error: "لم يؤكد الخادم تسليم الامتحان." },
  );
  assert.equal(failed.phase, "failed");
  assert.equal(failed.result, null, "a failed submission must not produce a final result");
  assert.equal(failed.error, "لم يؤكد الخادم تسليم الامتحان.");

  const retried = examSubmissionReducer(failed, { type: "begin" });
  assert.equal(retried.phase, "submitting", "retry after failure must start a new in-flight submission");
  assert.equal(retried.error, null);

  const confirmed = examSubmissionReducer(retried, { type: "finalize", result: confirmedResult });
  assert.equal(confirmed.phase, "submitted");
  assert.deepEqual(confirmed.result, confirmedResult);
});

test("a failure cannot regress or overwrite a completed attempt", () => {
  const submitted = examSubmissionReducer(
    examSubmissionReducer(initialExamSubmissionState, { type: "begin" }),
    { type: "finalize", result: confirmedResult },
  );
  const afterFailure = examSubmissionReducer(submitted, { type: "fail", error: "late error" });
  assert.equal(afterFailure, submitted, "a completed attempt must stay submitted");
});

test("a pre-flight rejection (missing student identity) records a failure without finalizing", () => {
  const rejected = examSubmissionReducer(initialExamSubmissionState, {
    type: "fail",
    error: "تعذر تسليم الامتحان: لم يتم تحديد هوية الطالب.",
  });
  assert.equal(rejected.phase, "failed");
  assert.equal(rejected.result, null);
  assert.equal(rejected.error, "تعذر تسليم الامتحان: لم يتم تحديد هوية الطالب.");
});

test("a completed attempt cannot begin again", () => {
  const submitted = examSubmissionReducer(
    examSubmissionReducer(initialExamSubmissionState, { type: "begin" }),
    { type: "finalize", result: confirmedResult },
  );
  const again = examSubmissionReducer(submitted, { type: "begin" });
  assert.equal(again, submitted, "a completed (submitted) attempt must not transition back to submitting");
});

// ============================================================
// Shared submission controller — the actual handler orchestration
// used by TakeExam's submit button and countdown auto-submit.
// Deferred mocked submit promises prove request deduplication that a
// pure reducer-only test cannot: the latch is acquired synchronously
// before any side effect.
// ============================================================

const validServerResponse = {
  exam_id: "exam-1",
  student_id: "student-1",
  status: "passed",
  completed_at: "2026-10-13T00:00:00.000Z",
  score: 90,
  total_marks: 100,
  passing_marks: 50,
  passed: true,
};

test("two simultaneous submission runs invoke the submit API exactly once", async () => {
  const controller = createExamSubmissionController();
  const deferred = createDeferred<unknown>();
  let apiCalls = 0;
  const submitAttempt = () => {
    apiCalls += 1;
    return deferred.promise;
  };

  // Same tick — a click plus the countdown auto-submit landing before React
  // rerenders with the new phase. The old captured-phase check could not
  // stop this; the synchronous latch must.
  const first = runExamSubmission(controller, submitAttempt, localResult);
  const second = runExamSubmission(controller, submitAttempt, localResult);

  assert.equal(apiCalls, 1, "the second same-tick call must be blocked before invoking the submit API");

  const secondRun = await second;
  assert.equal(secondRun.status, "blocked");
  assert.equal(controller.getState().phase, "submitting");

  deferred.resolve(validServerResponse);
  const firstRun = await first;
  assert.equal(firstRun.status, "finalized");
  assert.equal(apiCalls, 1);

  const state = controller.getState();
  assert.equal(state.phase, "submitted");
  assert.equal(state.result?.score, 90, "the server grade overrides the local score");
  assert.equal(state.result?.total, 100);
  assert.equal(state.error, null);
});

test("a completed attempt never submits again", async () => {
  const controller = createExamSubmissionController();
  let apiCalls = 0;
  const submitAttempt = () => {
    apiCalls += 1;
    return Promise.resolve(validServerResponse);
  };

  const first = await runExamSubmission(controller, submitAttempt, localResult);
  assert.equal(first.status, "finalized");
  assert.equal(apiCalls, 1);

  // A late click or timer tick after completion must not resubmit.
  const second = await runExamSubmission(controller, submitAttempt, localResult);
  assert.equal(second.status, "blocked");
  assert.equal(apiCalls, 1, "a completed attempt must not invoke the submit API again");
  assert.equal(controller.getState().phase, "submitted");

  controller.finalize({ ...confirmedResult, score: 100 });
  assert.equal(
    controller.getState().result?.score,
    90,
    "a late/duplicate finalize must not overwrite the completed attempt",
  );
});

test("a rejected submission fails honestly, keeps the attempt retryable, and a retry finalizes", async () => {
  const controller = createExamSubmissionController();
  const deferred = createDeferred<unknown>();
  let apiCalls = 0;
  const submitAttempt = () => {
    apiCalls += 1;
    return apiCalls === 1 ? deferred.promise : Promise.resolve(validServerResponse);
  };

  const first = runExamSubmission(controller, submitAttempt, localResult);
  deferred.reject(new Error("network down"));
  const firstRun = await first;

  assert.equal(firstRun.status, "failed");
  if (firstRun.status !== "failed") throw new Error("unreachable");
  assert.equal(firstRun.error, EXAM_SUBMISSION_NETWORK_ERROR);
  assert.ok(firstRun.cause instanceof Error, "the rejection cause must be carried for honest diagnostics");
  const failedState = controller.getState();
  assert.equal(failedState.phase, "failed");
  assert.equal(failedState.result, null, "a failed submission must not produce a final result (answers are retained)");

  // Retry after failure starts a new in-flight submission and can finalize.
  const retry = await runExamSubmission(controller, submitAttempt, localResult);
  assert.equal(retry.status, "finalized");
  assert.equal(apiCalls, 2);
  assert.equal(controller.getState().phase, "submitted");
});

test("a malformed server response never finalizes and the student can retry", async () => {
  const controller = createExamSubmissionController();
  const deferred = createDeferred<unknown>();
  let apiCalls = 0;
  const submitAttempt = () => {
    apiCalls += 1;
    return apiCalls === 1 ? deferred.promise : Promise.resolve(validServerResponse);
  };

  const first = runExamSubmission(controller, submitAttempt, localResult);
  // A response shaped like an error envelope, not a persisted attempt.
  deferred.resolve({ error: "Failed to submit exam attempt" });
  const firstRun = await first;

  assert.equal(firstRun.status, "failed");
  if (firstRun.status !== "failed") throw new Error("unreachable");
  assert.equal(firstRun.error, EXAM_SUBMISSION_UNCONFIRMED_ERROR);
  assert.equal(firstRun.cause, undefined, "an unconfirmed response carries no network cause");
  assert.equal(controller.getState().phase, "failed");
  assert.equal(controller.getState().result, null);

  const retry = await runExamSubmission(controller, submitAttempt, localResult);
  assert.equal(retry.status, "finalized");
  assert.equal(apiCalls, 2);
  assert.equal(controller.getState().result?.score, 90);
});

test("a pending_review confirmation stays pending through the actual run", async () => {
  const controller = createExamSubmissionController();
  const run = await runExamSubmission(
    controller,
    () => Promise.resolve({ status: "pending_review", score: 30, total_marks: 100, passed: false }),
    localResult,
  );

  assert.equal(run.status, "finalized");
  if (run.status !== "finalized") throw new Error("unreachable");
  assert.equal(run.result.pendingManualReview, true, "pending essay review must follow the server status");
  assert.equal(run.result.passed, false, "a pending attempt is not a final grade");
  assert.equal(run.result.score, 30);
  assert.equal(run.result.total, 100);
});

test("the controller notifies subscribers of submission state transitions", async () => {
  const controller = createExamSubmissionController();
  const observed: string[] = [];
  const unsubscribe = controller.subscribe(() => observed.push(controller.getState().phase));

  const deferred = createDeferred<unknown>();
  const first = runExamSubmission(controller, () => deferred.promise, localResult);
  assert.deepEqual(observed, ["submitting"], "begin must notify before the API settles");

  deferred.resolve(validServerResponse);
  const run = await first;
  assert.equal(run.status, "finalized");
  assert.deepEqual(observed, ["submitting", "submitted"]);

  // Blocked transitions (post-completion begin) must not notify subscribers.
  assert.equal(controller.begin(), false);
  assert.deepEqual(observed, ["submitting", "submitted"]);
  unsubscribe();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
});
