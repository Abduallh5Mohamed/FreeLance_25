/**
 * M1 exam-UI isolated regression tests (node:test + tsx).
 *
 * Scope (production code under test): the four scoped exam pages
 *   - src/pages/StudentExams.tsx
 *   - src/pages/StudentExamResults.tsx
 *   - src/pages/ExamReview.tsx
 *   - src/pages/ManualGrading.tsx
 *
 * These tests exercise the exported pure decision logic that the pages use —
 * status classification / start gating, HTTP outcome classification
 * (401/403/404 vs generic error), server-authoritative result normalization,
 * options parsing, and grading score validation. All transport and DOM
 * dependencies are stubbed through synchronous ESM hooks, so no env files,
 * database, network, live services or browser are touched.
 *
 * NOTE: the previous revision of this file used `mock.module`, which does not
 * exist on this Node (v22.22.2); it never executed a single assertion. It is
 * replaced here with the repo's `registerHooks` pattern.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// ---------------------------------------------------------------------------
// Environment isolation (runs before any page module is imported)
// ---------------------------------------------------------------------------

const stubModule = (source: string) => ({
  url: "data:text/javascript," + encodeURIComponent(source),
  shortCircuit: true,
});

// Swallow the pages' console.error noise (load failures are expected in tests).
const originalConsoleError = console.error;
console.error = () => {};

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Vite asset imports have no meaning under node.
    if (/\.(png|svg|jpg|jpeg|gif|webp)$/.test(specifier)) {
      return stubModule("export default 'stub-asset';");
    }
    const resolved = nextResolve(specifier, context);
    const clean = String(resolved.url).split("?")[0].replace(/\\/g, "/");

    // Presentational headers pull in the api-http/env graph; the pages under
    // test do not depend on their behaviour.
    if (
      clean.endsWith("/src/components/StudentHeader.tsx") ||
      clean.endsWith("/src/components/Header.tsx")
    ) {
      return stubModule("export default function Header(){ return null; }");
    }
    // StudentExams imports getStudentExams from the api barrel; stub the barrel
    // so the heavy api-http module (import.meta.env at module scope) is never
    // evaluated. The helpers under test are transport-independent.
    if (clean.endsWith("/src/lib/api.ts")) {
      return stubModule(
        "export const getStudentExams = async () => [];\n" +
        "export const Exam = {};\n" +
        "export const User = {};\n"
      );
    }
    return resolved;
  },
});

// localStorage is read by the pages' hooks/effects; provide a disposable one.
const localStorageStore = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => (localStorageStore.has(key) ? (localStorageStore.get(key) as string) : null),
  setItem: (key: string, value: string) => { localStorageStore.set(key, String(value)); },
  removeItem: (key: string) => { localStorageStore.delete(key); },
  clear: () => localStorageStore.clear(),
  key: (index: number) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() { return localStorageStore.size; },
} as Storage;

// ---------------------------------------------------------------------------
// Import the real page modules (production code under test)
// ---------------------------------------------------------------------------

const studentExamsPage = await import("../pages/StudentExams");
const studentExamResultsPage = await import("../pages/StudentExamResults");
const examReviewPage = await import("../pages/ExamReview");
const manualGradingPage = await import("../pages/ManualGrading");

// ---------------------------------------------------------------------------
// StudentExams.tsx — status classification & start gating
// ---------------------------------------------------------------------------

const {
  computeExamStatus,
  canStartExam,
  sanitizeDateTime,
  parseSafe,
} = studentExamsPage as typeof studentExamsPage & {
  computeExamStatus: (exam: any, now: Date) => string;
  canStartExam: (exam: any) => boolean;
  sanitizeDateTime: (raw?: string) => string | undefined;
  parseSafe: (raw?: string) => Date | null;
};

const NOW = new Date("2026-06-15T12:00:00.000Z");

test("StudentExams.sanitizeDateTime collapses a duplicated leading date and passes through clean input", () => {
  assert.equal(sanitizeDateTime("2026-01-01 2026-01-01 10:00:00"), "2026-01-01 10:00:00");
  assert.equal(sanitizeDateTime("  2026-01-01 10:00:00  "), "2026-01-01 10:00:00");
  assert.equal(sanitizeDateTime(undefined), undefined);
});

test("StudentExams.parseSafe returns null for unusable input and a Date for valid input", () => {
  assert.equal(parseSafe(undefined), null);
  assert.equal(parseSafe("not a date"), null);
  const d = parseSafe("2026-01-01 10:00:00");
  assert.ok(d instanceof Date);
  assert.equal(d?.getUTCFullYear(), 2026);
});

test("StudentExams.computeExamStatus classifies the exam window", () => {
  assert.equal(computeExamStatus({ start_time: "2026-06-01 00:00:00", end_time: "2026-06-30 00:00:00" }, NOW), "available");
  assert.equal(computeExamStatus({ start_time: "2026-07-01 00:00:00", end_time: "2026-07-31 00:00:00" }, NOW), "upcoming");
  assert.equal(computeExamStatus({ start_time: "2026-05-01 00:00:00", end_time: "2026-05-31 00:00:00" }, NOW), "expired");
});

test("StudentExams.computeExamStatus: completed attempts and in-progress expiry", () => {
  // attempted, no in-progress → completed
  assert.equal(computeExamStatus({ attempts: 1 }, NOW), "completed");
  // in-progress inside window → available (resume)
  assert.equal(
    computeExamStatus({ has_in_progress: true, in_progress_started_at: "2026-06-15T11:30:00.000Z", duration_minutes: 60 }, NOW),
    "available"
  );
  // in-progress but own duration elapsed → expired
  assert.equal(
    computeExamStatus({ has_in_progress: true, in_progress_started_at: "2026-06-15T09:00:00.000Z", duration_minutes: 60 }, NOW),
    "expired"
  );
  // in-progress but exam window closed → expired
  assert.equal(
    computeExamStatus({ has_in_progress: true, end_time: "2026-06-01 00:00:00" }, NOW),
    "expired"
  );
});

test("StudentExams.canStartExam allows retry on a completed exam while attempts remain (fixed dead-button defect)", () => {
  // available, attempts remaining → allow
  assert.equal(canStartExam({ status: "available", attempts: 0, maxAttempts: 1 }), true);
  // available, attempts exhausted → reject
  assert.equal(canStartExam({ status: "available", attempts: 1, maxAttempts: 1 }), false);
  // completed but attempts remain → allow retry
  assert.equal(canStartExam({ status: "completed", attempts: 1, maxAttempts: 2 }), true);
  // completed, attempts exhausted → reject
  assert.equal(canStartExam({ status: "completed", attempts: 2, maxAttempts: 2 }), false);
  // in-progress → always allow (resume)
  assert.equal(canStartExam({ status: "available", has_in_progress: true, attempts: 3, maxAttempts: 1 }), true);
  // upcoming / expired → reject
  assert.equal(canStartExam({ status: "upcoming", attempts: 0, maxAttempts: 1 }), false);
  assert.equal(canStartExam({ status: "expired", attempts: 0, maxAttempts: 1 }), false);
});

// ---------------------------------------------------------------------------
// StudentExamResults.tsx — HTTP outcome + server-authoritative normalization
// ---------------------------------------------------------------------------

const { classifyFetchOutcome, normalizeExamResult, sortResultsByDate } =
  studentExamResultsPage as typeof studentExamResultsPage & {
    classifyFetchOutcome: (status: number) => string;
    normalizeExamResult: (r: any) => any;
    sortResultsByDate: (r: any[]) => any[];
  };

test("StudentExamResults.classifyFetchOutcome separates auth/permission from generic failures", () => {
  assert.equal(classifyFetchOutcome(200), "ok");
  assert.equal(classifyFetchOutcome(204), "ok");
  assert.equal(classifyFetchOutcome(401), "unauthorized");
  assert.equal(classifyFetchOutcome(403), "forbidden");
  assert.equal(classifyFetchOutcome(404), "error");
  assert.equal(classifyFetchOutcome(500), "error");
});

test("StudentExamResults.normalizeExamResult keeps the server status authoritative", () => {
  // Backend says passed even though the score is below the passing mark: server wins.
  const passed = normalizeExamResult({
    id: "1", exam_id: "e1", exam_title: "Exam", score: 3, total_marks: 10, passing_marks: 5,
    status: "passed", attempted_at: "2026-06-01T10:00:00.000Z",
  });
  assert.equal(passed.passed, true);
  assert.equal(passed.percentage, 30);

  // pending_review is preserved and not treated as passed.
  const pending = normalizeExamResult({ id: "2", score: 5, total_marks: 10, status: "pending_review", created_at: "2026-06-02T10:00:00.000Z" });
  assert.equal(pending.status, "pending_review");
  assert.equal(pending.passed, false);
  assert.equal(pending.attempted_at, "2026-06-02T10:00:00.000Z"); // created_at fallback
});

test("StudentExamResults.normalizeExamResult derives status only when the backend omits it", () => {
  const derivedPass = normalizeExamResult({ id: "3", score: 8, total_marks: 10, passing_marks: 5 });
  assert.equal(derivedPass.status, "passed");
  const derivedFail = normalizeExamResult({ id: "4", score: 2, total_marks: 10, passing_marks: 5 });
  assert.equal(derivedFail.status, "failed");
  // nested exam object fallback for marks + title
  const nested = normalizeExamResult({ id: "5", score: 1, exam: { total_marks: 4, passing_marks: 2, title: "Nested" } });
  assert.equal(nested.total_marks, 4);
  assert.equal(nested.exam_title, "Nested");
});

test("StudentExamResults.sortResultsByDate orders newest first without mutating the input", () => {
  const input = [
    { attempted_at: "2026-01-01T00:00:00.000Z", id: "old" },
    { attempted_at: "2026-06-01T00:00:00.000Z", id: "new" },
  ];
  const sorted = sortResultsByDate(input as any);
  assert.deepEqual(sorted.map((r: any) => r.id), ["new", "old"]);
  assert.deepEqual(input.map(r => r.id), ["old", "new"]); // input untouched
});

// ---------------------------------------------------------------------------
// ExamReview.tsx — review outcome + options parsing
// ---------------------------------------------------------------------------

const { classifyReviewOutcome, parseOptions, getOptionLabel } =
  examReviewPage as typeof examReviewPage & {
    classifyReviewOutcome: (status: number) => string;
    parseOptions: (options: any) => string[];
    getOptionLabel: (index: number) => string;
  };

test("ExamReview.classifyReviewOutcome distinguishes not-found from auth/permission and generic errors", () => {
  assert.equal(classifyReviewOutcome(200), "ok");
  assert.equal(classifyReviewOutcome(401), "unauthorized");
  assert.equal(classifyReviewOutcome(403), "forbidden");
  assert.equal(classifyReviewOutcome(404), "not_found");
  assert.equal(classifyReviewOutcome(500), "error");
});

test("ExamReview.parseOptions handles array, JSON string and {a,b,c,d} object shapes", () => {
  assert.deepEqual(parseOptions(["x", "y"]), ["x", "y"]);
  assert.deepEqual(parseOptions('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseOptions('{"a":"A","b":"B","c":"C","d":"D"}'), ["A", "B", "C", "D"]);
  assert.deepEqual(parseOptions({ a: "A", b: "B" }), ["A", "B"]);
  assert.deepEqual(parseOptions("not json"), []);
  assert.deepEqual(parseOptions(null), []);
});

test("ExamReview.getOptionLabel maps indices to letters", () => {
  assert.equal(getOptionLabel(0), "A");
  assert.equal(getOptionLabel(1), "B");
  assert.equal(getOptionLabel(3), "D");
});

// ---------------------------------------------------------------------------
// ManualGrading.tsx — score validation, completeness, totals
// ---------------------------------------------------------------------------

const { resolveAssignedScore, isAttemptFullyGraded, calculateTotalScore } =
  manualGradingPage as typeof manualGradingPage & {
    resolveAssignedScore: (raw: string, maxScore: number) => { valid: boolean; value?: number };
    isAttemptFullyGraded: (s: any) => boolean;
    calculateTotalScore: (s: any) => number;
  };

test("ManualGrading.resolveAssignedScore accepts in-range values, allows clearing, rejects out-of-range", () => {
  assert.deepEqual(resolveAssignedScore("5", 10), { valid: true, value: 5 });
  assert.deepEqual(resolveAssignedScore("5.5", 10), { valid: true, value: 5.5 });
  assert.deepEqual(resolveAssignedScore("10", 10), { valid: true, value: 10 });
  // clearing a previously entered score must be possible (previously ignored)
  assert.deepEqual(resolveAssignedScore("", 10), { valid: true, value: undefined });
  // out-of-range / non-numeric → rejected so the controlled input reverts
  assert.equal(resolveAssignedScore("11", 10).valid, false);
  assert.equal(resolveAssignedScore("-1", 10).valid, false);
  assert.equal(resolveAssignedScore("abc", 10).valid, false);
});

test("ManualGrading.isAttemptFullyGraded requires every essay question to have a score", () => {
  assert.equal(isAttemptFullyGraded({ essay_questions: [{ assigned_score: 0 }, { assigned_score: 2 }] }), true);
  assert.equal(isAttemptFullyGraded({ essay_questions: [{ assigned_score: 0 }, {}] }), false);
  assert.equal(isAttemptFullyGraded({ essay_questions: [] }), true);
});

test("ManualGrading.calculateTotalScore sums auto score and essay scores, coercing string auto_score", () => {
  assert.equal(calculateTotalScore({ auto_score: 4, essay_questions: [{ assigned_score: 2 }, { assigned_score: 3 }] }), 9);
  assert.equal(calculateTotalScore({ auto_score: "4" as any, essay_questions: [{ assigned_score: 2 }] }), 6);
  assert.equal(calculateTotalScore({ auto_score: 0, essay_questions: [{}, {}] }), 0);
});

// ---------------------------------------------------------------------------
// Auth contract — every raw protected request must carry the canonical bearer
// (shared transport uses localStorage.authToken => `Authorization: Bearer ...`)
// ---------------------------------------------------------------------------

type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>;

const authedFetchPages: Array<{ name: string; mod: any }> = [
  { name: "ExamReview", mod: examReviewPage },
  { name: "StudentExamResults", mod: studentExamResultsPage },
  { name: "ManualGrading", mod: manualGradingPage },
];

for (const { name, mod } of authedFetchPages) {
  test(`${name}.authedFetch attaches the canonical session bearer to the request`, async () => {
    const authedFetch = mod.authedFetch as AuthedFetch;
    localStorageStore.set("authToken", "tok-abc-123");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;
    try {
      await authedFetch("/api/protected", { headers: { "Content-Type": "application/json" } });
    } finally {
      globalThis.fetch = originalFetch;
      localStorageStore.delete("authToken");
    }
    assert.equal(calls.length, 1);
    const sent = new Headers(calls[0].init?.headers);
    assert.equal(sent.get("Authorization"), "Bearer tok-abc-123");
    // pre-existing headers (e.g. the JSON submit content-type) are preserved
    assert.equal(sent.get("Content-Type"), "application/json");
  });

  test(`${name}.authedFetch fails closed without a session token and fires no request`, async () => {
    const authedFetch = mod.authedFetch as AuthedFetch;
    const MissingAuthTokenError = mod.MissingAuthTokenError;
    localStorageStore.delete("authToken");
    let fired = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fired = true; return new Response("{}"); }) as any;
    try {
      await assert.rejects(
        () => authedFetch("/api/protected"),
        (err: any) => err instanceof MissingAuthTokenError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fired, false);
  });
}

test("ManualGrading.classifySubmitOutcome treats only 2xx as success so a rejected submit keeps the row for retry", () => {
  const classifySubmitOutcome = (manualGradingPage as any).classifySubmitOutcome as (s: number) => string;
  assert.equal(classifySubmitOutcome(200), "success");
  assert.equal(classifySubmitOutcome(204), "success");
  assert.equal(classifySubmitOutcome(401), "unauthorized");
  assert.equal(classifySubmitOutcome(403), "forbidden");
  assert.equal(classifySubmitOutcome(500), "error");
  // a failure must never be treated as success (row retained, input preserved)
  assert.notEqual(classifySubmitOutcome(500), "success");
});

// ---------------------------------------------------------------------------
// ManualGrading — production request adapters & lifecycle controllers.
// These drive the ACTUAL page functions (loadGrades/loadGroups/
// loadPendingAttempts/createLatestRequestGuard/createGradingSubmitter) through
// a mocked global fetch, so the real request + decision paths are exercised
// rather than a re-implementation. No DOM/browser/live service is used.
// ---------------------------------------------------------------------------

const mg = manualGradingPage as any;
const mgLoadGrades = mg.loadGrades as () => Promise<{ outcome: string; rows: any[]; malformed: boolean }>;
const mgLoadGroups = mg.loadGroups as () => Promise<{ outcome: string; rows: any[]; malformed: boolean }>;
const mgLoadPending = mg.loadPendingAttempts as (
  gradeId: string,
  groupId: string,
) => Promise<{ outcome: string; rows: any[]; malformed: boolean }>;

const withFetch = async <T>(
  impl: (url: any, init: any) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

test("ManualGrading.loadGrades/loadGroups commit only an ok array and never place a non-array body into array state", async () => {
  localStorageStore.set("authToken", "tok-grades");
  try {
    const ok = await withFetch(
      async () => new Response(JSON.stringify([{ id: "g1", name: "Grade 1" }]), { status: 200 }),
      () => mgLoadGrades(),
    );
    assert.equal(ok.outcome, "ok");
    assert.equal(ok.malformed, false);
    assert.deepEqual(ok.rows, [{ id: "g1", name: "Grade 1" }]);

    // 401 body is an error OBJECT, not an array → must never reach array state.
    const unauthorized = await withFetch(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      () => mgLoadGrades(),
    );
    assert.equal(unauthorized.outcome, "unauthorized");
    assert.deepEqual(unauthorized.rows, []);
    assert.equal(unauthorized.malformed, false);

    // 2xx but a non-array body → flagged malformed with no rows.
    const malformed = await withFetch(
      async () => new Response(JSON.stringify({ error: "nope" }), { status: 200 }),
      () => mgLoadGroups(),
    );
    assert.equal(malformed.outcome, "ok");
    assert.equal(malformed.malformed, true);
    assert.deepEqual(malformed.rows, []);

    // 500 → error with no rows.
    const failed = await withFetch(
      async () => new Response("boom", { status: 500 }),
      () => mgLoadGroups(),
    );
    assert.equal(failed.outcome, "error");
    assert.deepEqual(failed.rows, []);
  } finally {
    localStorageStore.delete("authToken");
  }
});

test("ManualGrading.loadPendingAttempts scopes the request by grade/group, omits the group for 'all', and surfaces 401", async () => {
  localStorageStore.set("authToken", "tok-pending");
  const urls: string[] = [];
  try {
    const scoped = await withFetch(
      async (url) => { urls.push(String(url)); return new Response(JSON.stringify([{ student_id: "s1" }]), { status: 200 }); },
      () => mgLoadPending("grade-1", "group-2"),
    );
    assert.equal(scoped.outcome, "ok");
    assert.deepEqual(scoped.rows, [{ student_id: "s1" }]);
    assert.ok(urls[0].includes("grade_id=grade-1"));
    assert.ok(urls[0].includes("group_id=group-2"));

    await withFetch(
      async (url) => { urls.push(String(url)); return new Response("[]", { status: 200 }); },
      () => mgLoadPending("grade-1", "all"),
    );
    assert.ok(urls[1].includes("grade_id=grade-1"));
    assert.ok(!urls[1].includes("group_id="));

    const unauthorized = await withFetch(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      () => mgLoadPending("grade-1", "group-2"),
    );
    assert.equal(unauthorized.outcome, "unauthorized");
    assert.deepEqual(unauthorized.rows, []);
  } finally {
    localStorageStore.delete("authToken");
  }
});

test("ManualGrading latest-request guard rejects a superseded, out-of-scope or post-clear pending response", () => {
  const createGuard = mg.createLatestRequestGuard as () => {
    begin: (s: { gradeId: string; groupId: string }) => number | null;
    clear: () => void;
    isCurrent: (t: number, s: { gradeId: string; groupId: string }) => boolean;
  };
  const guard = createGuard();
  const scopeA = { gradeId: "a", groupId: "g1" };
  const scopeB = { gradeId: "b", groupId: "g1" };

  const t1 = guard.begin(scopeA);
  assert.ok(t1 !== null);
  assert.equal(guard.isCurrent(t1 as number, scopeA), true);

  // A newer scope begins → the first response is superseded.
  const t2 = guard.begin(scopeB);
  assert.equal(guard.isCurrent(t1 as number, scopeA), false);
  assert.equal(guard.isCurrent(t2 as number, scopeB), true);

  // Same ticket but a different scope is out-of-scope.
  assert.equal(guard.isCurrent(t2 as number, scopeA), false);

  // Clearing the selection invalidates the in-flight request.
  guard.clear();
  assert.equal(guard.isCurrent(t2 as number, scopeB), false);

  // An empty scope yields no ticket, so no request is started.
  assert.equal(guard.begin({ gradeId: "", groupId: "" }), null);
});

test("ManualGrading grading submitter suppresses duplicates and retains the row on a rejected submit", async () => {
  const submitter = mg.createGradingSubmitter as any;
  const student = {
    student_id: "s1", exam_id: "e1", auto_score: 1, total_marks: 10,
    essay_questions: [{ id: "q1", points: 5, assigned_score: 2 }],
  };
  const requests: string[] = [];
  const removed: string[] = [];
  let resolveSubmit!: (r: { outcome: string; status: number }) => void;

  const controller = submitter(
    {
      getScopeGeneration: () => 1,
      onSubmitted: (s: any) => removed.push(`${s.student_id}-${s.exam_id}`),
    },
    (s: any) => {
      requests.push(`${s.student_id}-${s.exam_id}`);
      return new Promise((res) => { resolveSubmit = res; });
    },
  );

  const first = controller.submit(student);
  // A second submit for the same attempt before the first resolves is suppressed.
  const duplicate = await controller.submit(student);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(requests.length, 1);

  resolveSubmit({ outcome: "error", status: 500 });
  const rejected = await first;
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.result.status, 500);
  assert.deepEqual(removed, []); // row retained for retry

  // A 2xx submit removes the row.
  const okController = submitter(
    {
      getScopeGeneration: () => 1,
      onSubmitted: (s: any) => removed.push(`${s.student_id}-${s.exam_id}`),
    },
    async () => ({ outcome: "success", status: 200 }),
  );
  const success = await okController.submit(student);
  assert.equal(success.kind, "success");
  assert.deepEqual(removed, ["s1-e1"]);
});

test("ManualGrading grading submitter does not delete a row when a success resolves in a later scope", async () => {
  const submitter = mg.createGradingSubmitter as any;
  let generation = 1;
  const removed: string[] = [];
  let resolveSubmit!: (r: { outcome: string; status: number }) => void;
  const controller = submitter(
    {
      getScopeGeneration: () => generation,
      onSubmitted: (s: any) => removed.push(`${s.student_id}-${s.exam_id}`),
    },
    () => new Promise((res) => { resolveSubmit = res; }),
  );
  const student = { student_id: "s1", exam_id: "e1", essay_questions: [{ id: "q1", assigned_score: 2 }] };

  const pending = controller.submit(student);
  generation = 2; // grader switched scope while the submit was in flight
  resolveSubmit({ outcome: "success", status: 200 });
  const result = await pending;
  assert.equal(result.kind, "success");
  assert.deepEqual(removed, []); // must not delete rows from the newer scope
});

test("ManualGrading grading submitter: an A -> B -> A roundtrip is not mistaken for the same scope", async () => {
  // Regression: comparing only grade/group strings treated a late first-A
  // response as current after the grader returned to A, deleting a row the
  // newer A load had just produced.
  const submitter = mg.createGradingSubmitter as any;
  let generation = 1; // scope A, first visit
  const removed: string[] = [];
  const resolvers: Array<(r: { outcome: string; status: number }) => void> = [];
  const controller = submitter(
    {
      getScopeGeneration: () => generation,
      onSubmitted: (s: any) => removed.push(`${s.student_id}-${s.exam_id}`),
    },
    () => new Promise((res) => { resolvers.push(res); }),
  );
  const student = { student_id: "s1", exam_id: "e1", essay_questions: [{ id: "q1", assigned_score: 2 }] };

  const pending = controller.submit(student);
  generation = 2; // switched to B
  generation = 3; // returned to A: same grade/group strings, new generation
  resolvers[0]({ outcome: "success", status: 200 });
  const result = await pending;
  assert.equal(result.kind, "success");
  assert.deepEqual(removed, []); // the newly loaded A row survives

  // A submit that resolves inside its own generation still removes the row.
  generation = 4;
  const sameScope = controller.submit(student);
  resolvers[1]({ outcome: "success", status: 200 });
  assert.equal((await sameScope).kind, "success");
  assert.deepEqual(removed, ["s1-e1"]);
});

test("ManualGrading grading submitter retains the entered scores and the row when the request is rejected", async () => {
  const submitter = mg.createGradingSubmitter as any;
  const removed: string[] = [];
  const controller = submitter(
    {
      getScopeGeneration: () => 7,
      onSubmitted: (s: any) => removed.push(`${s.student_id}-${s.exam_id}`),
    },
    async () => ({ outcome: "rejected" as any, status: 401 } as any),
  );
  const student = {
    student_id: "s9", exam_id: "e9", auto_score: 3, total_marks: 20,
    essay_questions: [{ id: "q1", points: 5, assigned_score: 4 }],
  };

  const result = await controller.submit(student);
  assert.equal(result.kind, "rejected");
  assert.deepEqual(removed, []);
  // the grader's entered score is untouched, so a retry does not lose input
  assert.equal(student.essay_questions[0].assigned_score, 4);
  assert.equal(calculateTotalScore(student), 7);
});

test("ManualGrading grading submitter drives the production submit request and retains the row on 401/403/500", async () => {
  const submitter = mg.createGradingSubmitter as any;
  localStorageStore.set("authToken", "tok-submit");
  const calls: Array<{ url: string; init: any }> = [];
  try {
    for (const status of [401, 403, 500]) {
      const removed: string[] = [];
      const controller = submitter({
        getScopeGeneration: () => 1,
        onSubmitted: (s: any) => removed.push(`${s.student_id}-${s.exam_id}`),
      });
      const student = {
        student_id: "s1", exam_id: "e1", auto_score: 1, total_marks: 10,
        essay_questions: [{ id: "q1", points: 5, assigned_score: 2 }],
      };
      const result = await withFetch<any>(
        async (url, init) => { calls.push({ url: String(url), init }); return new Response("{}", { status }); },
        () => controller.submit(student),
      );
      assert.equal(result.kind, "rejected");
      assert.equal(result.result.status, status);
      assert.deepEqual(removed, []); // input + row retained on every rejection
    }

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok(call.url.endsWith("/manual-grading/submit"));
      const sent = new Headers(call.init?.headers);
      assert.equal(sent.get("Authorization"), "Bearer tok-submit");
      const body = JSON.parse(String(call.init?.body));
      assert.equal(body.exam_id, "e1");
      assert.equal(body.student_id, "s1");
      assert.deepEqual(body.essay_scores, { q1: 2 });
      assert.equal(body.total_score, 3); // auto_score 1 + essay 2
    }
  } finally {
    localStorageStore.delete("authToken");
  }
});

// ---------------------------------------------------------------------------
// ManualGrading — selector (grades/groups) load failures must be visible and
// retryable, never presented as a legitimately empty selector. These drive the
// REAL production adapters (loadGrades/loadGroups) plus the same failure mapper
// the page's fetchGrades/fetchGroups call.
// ---------------------------------------------------------------------------

const describeSelectorLoadFailure = mg.describeSelectorLoadFailure as (
  failure: { outcome: string; malformed: boolean } | { error: unknown },
) => string | null;
const describePendingLoadFailure = mg.describePendingLoadFailure as (
  outcome: string,
  malformed: boolean,
) => string;

const SESSION_EXPIRED = "انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى";
const SELECTORS_FORBIDDEN = "ليست لديك صلاحية عرض بيانات الصفوف والمجموعات";
const SELECTORS_MALFORMED = "بيانات الصفوف والمجموعات غير صالحة";
const SELECTORS_FAILED = "فشل تحميل بيانات الصفوف والمجموعات";

test("ManualGrading.describeSelectorLoadFailure: only a well-formed 2xx array is silent", () => {
  assert.equal(describeSelectorLoadFailure({ outcome: "ok", malformed: false }), null);
  // Every other outcome yields a distinct, actionable message.
  assert.equal(describeSelectorLoadFailure({ outcome: "unauthorized", malformed: false }), SESSION_EXPIRED);
  assert.equal(describeSelectorLoadFailure({ outcome: "forbidden", malformed: false }), SELECTORS_FORBIDDEN);
  assert.equal(describeSelectorLoadFailure({ outcome: "error", malformed: false }), SELECTORS_FAILED);
  assert.equal(describeSelectorLoadFailure({ outcome: "ok", malformed: true }), SELECTORS_MALFORMED);
  // A thrown transport failure (missing token) is reported, not swallowed.
  assert.equal(describeSelectorLoadFailure({ error: new (mg.MissingAuthTokenError)() }), SESSION_EXPIRED);
  assert.equal(describeSelectorLoadFailure({ error: new Error("network down") }), SELECTORS_FAILED);
});

test("ManualGrading selector load: the page's real adapter path surfaces 401/403/500/network/malformed", async () => {
  const cases: Array<{ name: string; impl: () => Promise<Response>; expected: string }> = [
    {
      name: "401",
      impl: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      expected: SESSION_EXPIRED,
    },
    {
      name: "403",
      impl: async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      expected: SELECTORS_FORBIDDEN,
    },
    {
      name: "500",
      impl: async () => new Response("boom", { status: 500 }),
      expected: SELECTORS_FAILED,
    },
    {
      name: "malformed 2xx body",
      impl: async () => new Response(JSON.stringify({ error: "nope" }), { status: 200 }),
      expected: SELECTORS_MALFORMED,
    },
    {
      name: "network failure",
      impl: async () => { throw new Error("network down"); },
      expected: SELECTORS_FAILED,
    },
  ];

  localStorageStore.set("authToken", "tok-selectors");
  try {
    for (const scenario of cases) {
      let failure: string | null = null;
      try {
        const result = await withFetch(scenario.impl, () => mgLoadGrades());
        // The error body must never be handed to array state.
        assert.deepEqual(result.rows, []);
        assert.equal(result.malformed, scenario.name === "malformed 2xx body");
        failure = describeSelectorLoadFailure(result);
      } catch (error) {
        failure = describeSelectorLoadFailure({ error });
      }
      assert.equal(failure, scenario.expected, `${scenario.name} must be surfaced`);
    }

    // Missing token: no request is fired and the failure is surfaced.
    localStorageStore.delete("authToken");
    let fired = false;
    let missingTokenFailure: string | null = null;
    try {
      await withFetch(
        async () => { fired = true; return new Response("[]", { status: 200 }); },
        () => mgLoadGroups(),
      );
    } catch (error) {
      missingTokenFailure = describeSelectorLoadFailure({ error });
    }
    assert.equal(fired, false);
    assert.equal(missingTokenFailure, SESSION_EXPIRED);
  } finally {
    localStorageStore.delete("authToken");
  }
});

test("ManualGrading selector load: a retry after a failure recovers and commits the authoritative rows", async () => {
  localStorageStore.set("authToken", "tok-retry");
  try {
    const failed = await withFetch(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      () => mgLoadGrades(),
    );
    assert.equal(describeSelectorLoadFailure(failed), SESSION_EXPIRED);

    // Retry (as the page's retrySelectors does) → the error clears and rows land.
    const retried = await withFetch(
      async () => new Response(JSON.stringify([{ id: "g1", name: "Grade 1" }]), { status: 200 }),
      () => mgLoadGrades(),
    );
    assert.equal(describeSelectorLoadFailure(retried), null);
    assert.deepEqual(retried.rows, [{ id: "g1", name: "Grade 1" }]);
  } finally {
    localStorageStore.delete("authToken");
  }
});

test("ManualGrading.describePendingLoadFailure: a malformed payload is an error, not an empty list", () => {
  assert.equal(describePendingLoadFailure("unauthorized", false), SESSION_EXPIRED);
  assert.equal(describePendingLoadFailure("forbidden", false), "ليست لديك صلاحية عرض محاولات التصحيح");
  assert.equal(describePendingLoadFailure("ok", true), "استجابة غير صالحة لمحاولات التصحيح");
  assert.equal(describePendingLoadFailure("error", false), "فشل تحميل محاولات الطلاب");
  // The malformed message is distinct from both the auth and the generic failure.
  assert.notEqual(describePendingLoadFailure("ok", true), describePendingLoadFailure("error", false));
});

test.after(() => {
  console.error = originalConsoleError;
});
