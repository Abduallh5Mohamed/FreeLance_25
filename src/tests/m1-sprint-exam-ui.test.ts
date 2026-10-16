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

test.after(() => {
  console.error = originalConsoleError;
});
