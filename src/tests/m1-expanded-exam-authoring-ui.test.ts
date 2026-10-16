/**
 * M1 expanded exam-authoring UI — isolated production-path tests
 * (node:test + tsx; this repo has no jsdom/DOM test environment).
 *
 * Scope: the three scoped pages —
 *   src/pages/EditExam.tsx, src/pages/ExamManager.tsx, src/pages/TeacherExams.tsx.
 *
 * What is covered (the real exported production functions, not a copy):
 *  - EditExam: normalizeQuestionOptions (the server `options` column is TEXT,
 *    so it must be parsed before use), normalizePositiveInt (numeric
 *    validation) and the single-flight save guard used by every save handler
 *    (allow / deny-duplicate / failure-releases).
 *  - ExamManager: normalizeOptionList (the listing must not call .map on a
 *    JSON string) and buildExamCreatePayload (the selected group scope must be
 *    forwarded; numeric fields normalized).
 *  - TeacherExams: computeExamTotals, formatExamDateTime,
 *    buildTeacherExamPayload and createExamAuthoringController
 *    (allow / deny-duplicate / failure-with-rollback).
 *
 * Isolation: no env files, no database, no network, no live services, no
 * browser. The page modules and src/lib/api-http.ts evaluate `import.meta.env`
 * at module init, which is absent under plain Node, so the loader hooks below
 * neutralize assets and stub api-http (the pages already guard their own env
 * read the same way the rest of this repo does). Every assertion drives the
 * exported functions with injected fakes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// ---------------------------------------------------------------------------
// Environment isolation (must run before the page modules are imported)
// ---------------------------------------------------------------------------

// The page modules log heavily on load; keep the test output readable.
console.log = () => {};
console.error = () => {};
console.warn = () => {};

// A resolve-only hook. Stubbing through `resolve` (to `data:` modules) keeps
// the default/tsx loader untouched for every real dependency (react, router,
// UI packages, ...) — a `load` hook here would break their CJS handling.
const ASSET_STUB_URL = "data:text/javascript,export default 'stub-asset'";

// src/lib/api-http.ts throws at module init under node (import.meta.env); the
// tests inject contract-accurate fakes into the exported page functions, so an
// inert stub is enough to load the pages.
const API_HTTP_STUB_URL = "data:text/javascript," + encodeURIComponent([
  "export const getCourses = async () => [];",
  "export const getGrades = async () => [];",
  "export const getGroups = async () => [];",
  "export const getExams = async () => [];",
  "export const getExamById = async () => null;",
  "export const getExamQuestions = async () => [];",
  "export const createExam = async () => '';",
  "export const updateExam = async () => true;",
  "export const deleteExam = async () => true;",
].join("\n"));

registerHooks({
  resolve(specifier, context, nextResolve) {
    const clean = specifier.split("?")[0].replace(/\\/g, "/");
    // Vite asset imports have no meaning under node.
    if (/\.(png|jpe?g|svg|gif|webp)$/i.test(clean)) {
      return { url: ASSET_STUB_URL, shortCircuit: true };
    }
    if (clean === "@/lib/api-http" || clean.endsWith("/src/lib/api-http.ts")) {
      return { url: API_HTTP_STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// localStorage is read lazily by the pages (inside handlers/controllers), but
// provide a disposable one so any stray access is safe.
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

const editExamPage = await import("../pages/EditExam");
const examManagerPage = await import("../pages/ExamManager");
const teacherExamsPage = await import("../pages/TeacherExams");

const { normalizeQuestionOptions, normalizePositiveInt, createSingleFlightGuard } = editExamPage;
const { normalizeOptionList, buildExamCreatePayload } = examManagerPage;
const {
  computeExamTotals,
  formatExamDateTime,
  buildTeacherExamPayload,
  createExamAuthoringController,
} = teacherExamsPage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ===========================================================================
// EditExam.tsx
// ===========================================================================

test("EditExam.normalizeQuestionOptions parses the server TEXT options column", () => {
  assert.deepEqual(
    normalizeQuestionOptions('{"a":"A","b":"B","c":"C","d":"D"}'),
    { a: "A", b: "B", c: "C", d: "D" },
  );
  // already-parsed object
  assert.deepEqual(normalizeQuestionOptions({ a: "1" }), { a: "1", b: "", c: "", d: "" });
  // legacy array shape
  assert.deepEqual(normalizeQuestionOptions(["x", "y"]), { a: "x", b: "y", c: "", d: "" });
});

test("EditExam.normalizeQuestionOptions never throws on bad/empty input", () => {
  const empty = { a: "", b: "", c: "", d: "" };
  assert.deepEqual(normalizeQuestionOptions("{not json"), empty);
  assert.deepEqual(normalizeQuestionOptions(null), empty);
  assert.deepEqual(normalizeQuestionOptions(undefined), empty);
  assert.deepEqual(normalizeQuestionOptions(42), empty);
});

test("EditExam.normalizePositiveInt clamps numeric input to a whole number >= 1", () => {
  assert.equal(normalizePositiveInt(""), 1);      // emptied field -> fallback
  assert.equal(normalizePositiveInt("5"), 5);
  assert.equal(normalizePositiveInt("0"), 1);      // deny zero
  assert.equal(normalizePositiveInt("-3"), 1);     // deny negative
  assert.equal(normalizePositiveInt("3.9"), 3);    // whole numbers only
  assert.equal(normalizePositiveInt("abc"), 1);    // deny NaN
  assert.equal(normalizePositiveInt(7), 7);
  assert.equal(normalizePositiveInt("2", 9), 2);
});

test("EditExam.createSingleFlightGuard allows a single in-flight save", async () => {
  const guard = createSingleFlightGuard();
  assert.equal(guard.isBusy(), false);
  const outcome = await guard.run(async () => 42);
  assert.deepEqual(outcome, { status: "ran", value: 42 });
  assert.equal(guard.isBusy(), false);
});

test("EditExam.createSingleFlightGuard denies a duplicate concurrent save", async () => {
  const guard = createSingleFlightGuard();
  const gate = deferred<void>();
  let ran = 0;

  const first = guard.run(async () => { ran += 1; await gate.promise; return "first"; });
  assert.equal(guard.isBusy(), true);

  const second = await guard.run(async () => { ran += 1; return "second"; });
  assert.deepEqual(second, { status: "blocked" });

  gate.resolve();
  const firstOutcome = await first;
  assert.deepEqual(firstOutcome, { status: "ran", value: "first" });
  assert.equal(ran, 1, "the blocked call must not have run its task");
  assert.equal(guard.isBusy(), false);
});

test("EditExam.createSingleFlightGuard releases the lock after a failed save", async () => {
  const guard = createSingleFlightGuard();
  await assert.rejects(guard.run(async () => { throw new Error("server 500"); }), /server 500/);
  assert.equal(guard.isBusy(), false, "a failed save must not wedge the guard");
  const retry = await guard.run(async () => "retry-ok");
  assert.deepEqual(retry, { status: "ran", value: "retry-ok" });
});

// ===========================================================================
// ExamManager.tsx
// ===========================================================================

test("ExamManager.normalizeOptionList renders a JSON-string options column", () => {
  // This is the listing path that previously called `.map` on a string.
  assert.deepEqual(normalizeOptionList('{"a":"A","b":"B","c":"C","d":"D"}'), ["A", "B", "C", "D"]);
  assert.deepEqual(normalizeOptionList(["w", "x", "y", "z"]), ["w", "x", "y", "z"]);
  assert.deepEqual(normalizeOptionList({ a: "only-a" }), ["only-a", "", "", ""]);
});

test("ExamManager.normalizeOptionList degrades safely on bad input", () => {
  assert.deepEqual(normalizeOptionList("not json"), []);
  assert.deepEqual(normalizeOptionList(null), []);
  assert.deepEqual(normalizeOptionList(undefined), []);
});

test("ExamManager.buildExamCreatePayload forwards the selected group scope", () => {
  const base = {
    title: "T",
    description: "",
    course_id: "c1",
    duration_minutes: 60,
    total_marks: 100,
    passing_marks: 50,
    start_time: "2026-01-01 10:00:00",
    end_time: "2026-01-01 11:00:00",
  };
  const withGroups = buildExamCreatePayload(base, ["g1", "g2"]);
  assert.deepEqual(withGroups.group_ids, ["g1", "g2"], "groups must reach the server");
  assert.equal(withGroups.description, null, "empty description normalizes to null");

  const withoutGroups = buildExamCreatePayload(base, []);
  assert.equal(withoutGroups.group_ids, null);
});

test("ExamManager.buildExamCreatePayload normalizes numeric fields", () => {
  const payload = buildExamCreatePayload(
    {
      title: "T",
      description: "d",
      course_id: "c1",
      duration_minutes: 0 as unknown as number, // emptied field
      total_marks: 0,
      passing_marks: 0,
      start_time: null,
      end_time: null,
    },
    ["g1"],
  );
  assert.equal(payload.duration_minutes, 60, "invalid duration falls back to 60");
  assert.equal(payload.total_marks, 1, "invalid total falls back to 1");
  assert.equal(payload.passing_marks, 50, "invalid passing preserves the original 50 fallback");
  assert.equal(payload.is_active, true);
});

// ===========================================================================
// TeacherExams.tsx
// ===========================================================================

test("TeacherExams.computeExamTotals sums marks and derives passing marks", () => {
  assert.deepEqual(computeExamTotals([{ marks: 2 }, { marks: 3 }], "50"), {
    totalMarks: 5,
    passingPercent: 50,
    passingMarks: 3, // ceil(2.5)
  });
  assert.deepEqual(computeExamTotals([], "60"), { totalMarks: 0, passingPercent: 60, passingMarks: 0 });
});

test("TeacherExams.computeExamTotals clamps the passing percentage to 0..100", () => {
  assert.equal(computeExamTotals([{ marks: 10 }], "150").passingPercent, 100);
  assert.equal(computeExamTotals([{ marks: 10 }], "-20").passingPercent, 0);
  assert.equal(computeExamTotals([{ marks: 10 }], "abc").passingPercent, 0);
  assert.equal(computeExamTotals([{ marks: 10 }], "").passingPercent, 0);
});

test("TeacherExams.formatExamDateTime normalizes datetime-local and rejects garbage", () => {
  assert.equal(formatExamDateTime("2025-11-24T13:30"), "2025-11-24 13:30:00");
  assert.equal(formatExamDateTime(""), null);
  assert.equal(formatExamDateTime(undefined), null);
  assert.equal(formatExamDateTime("not-a-date"), null);
});

test("TeacherExams.buildTeacherExamPayload mirrors dates and normalizes duration", () => {
  const payload = buildTeacherExamPayload({
    course_id: "c1",
    grade_id: "g",
    group_ids: ["grp1"],
    title: "T",
    description: null,
    duration_minutes: "0",
    total_marks: 10,
    passing_marks: 5,
    passing_percentage: 50,
    start_time: "2026-01-01 10:00:00",
    end_time: "2026-01-01 11:00:00",
  });
  assert.equal(payload.duration_minutes, 60);
  assert.equal(payload.start_date, payload.start_time);
  assert.equal(payload.end_date, payload.end_time);
  assert.deepEqual(payload.group_ids, ["grp1"]);

  const noGroups = buildTeacherExamPayload({
    course_id: "c1",
    grade_id: null,
    group_ids: [],
    title: "T",
    description: "desc",
    duration_minutes: "45",
    total_marks: 10,
    passing_marks: 5,
    passing_percentage: 50,
    start_time: "2026-01-01 10:00:00",
    end_time: "2026-01-01 11:00:00",
  });
  assert.equal(noGroups.group_ids, null);
  assert.equal(noGroups.grade_id, null);
  assert.equal(noGroups.duration_minutes, 45);
});

test("TeacherExams authoring controller creates the exam and all questions", async () => {
  const calls: string[] = [];
  const controller = createExamAuthoringController({
    createExam: async () => { calls.push("create"); return { id: "exam-1" }; },
    addQuestion: async (examId) => { calls.push(`q:${examId}`); return {}; },
    deleteExam: async () => { calls.push("delete"); return {}; },
  });

  const outcome = await controller.submit({ title: "T" }, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(outcome, { status: "created", examId: "exam-1", questionsAdded: 2 });
  assert.deepEqual(calls, ["create", "q:exam-1", "q:exam-1"]);
  assert.equal(controller.isBusy(), false);
});

test("TeacherExams authoring controller denies a duplicate concurrent submit", async () => {
  const gate = deferred<{ id: string }>();
  let createCalls = 0;
  const controller = createExamAuthoringController({
    createExam: () => { createCalls += 1; return gate.promise; },
    addQuestion: async () => ({}),
    deleteExam: async () => ({}),
  });

  const first = controller.submit({}, []);
  const second = await controller.submit({}, []);
  assert.deepEqual(second, { status: "blocked" });

  gate.resolve({ id: "exam-1" });
  assert.equal((await first).status, "created");
  assert.equal(createCalls, 1, "the duplicate submit must not create a second exam");
});

test("TeacherExams authoring controller rolls back the exam when a question fails", async () => {
  const deleted: string[] = [];
  let addCalls = 0;
  const controller = createExamAuthoringController({
    createExam: async () => ({ id: "exam-9" }),
    addQuestion: async () => {
      addCalls += 1;
      if (addCalls === 2) throw new Error("question insert failed");
      return {};
    },
    deleteExam: async (examId) => { deleted.push(examId); return {}; },
  });

  const outcome = await controller.submit({}, [{}, {}, {}]);
  assert.equal(outcome.status, "rolled-back");
  if (outcome.status === "rolled-back") {
    assert.equal(outcome.examId, "exam-9");
    assert.equal(outcome.questionsAdded, 1);
    assert.match(outcome.error.message, /question insert failed/);
  }
  assert.deepEqual(deleted, ["exam-9"], "the orphan exam must be compensated");
  assert.equal(controller.isBusy(), false);
});

test("TeacherExams authoring controller propagates a create failure and stays reusable", async () => {
  let attempt = 0;
  const controller = createExamAuthoringController({
    createExam: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return { id: "exam-2" };
    },
    addQuestion: async () => ({}),
    deleteExam: async () => ({}),
  });

  await assert.rejects(controller.submit({}, []), /network down/);
  assert.equal(controller.isBusy(), false, "a failed create must release the lock");
  const retry = await controller.submit({}, []);
  assert.equal(retry.status, "created");
});

test("TeacherExams authoring controller rejects a server response without an id", async () => {
  const controller = createExamAuthoringController({
    createExam: async () => ({} as { id: string }),
    addQuestion: async () => ({}),
    deleteExam: async () => ({}),
  });
  await assert.rejects(controller.submit({}, []), /createExam returned no id/);
  assert.equal(controller.isBusy(), false);
});
