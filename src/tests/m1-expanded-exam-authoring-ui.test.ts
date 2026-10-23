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
import type {
  EditExamOperationState,
  EditExamOperationToken,
  EditExamOperationResult,
} from "../pages/EditExam";

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
  "export const clearAuthToken = () => {};",
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
const {
  buildAuthHeaders: editBuildAuthHeaders,
  buildQuestionListRequestInit,
  buildImageUploadRequestInit: editBuildImageUploadRequestInit,
  buildJsonRequestInit: editBuildJsonRequestInit,
  loadExamQuestions,
  uploadQuestionImage,
  isAuthFailure: editIsAuthFailure,
  ExamHttpError,
  createEditExamRouteLoadGuard,
  createEditExamOperationTracker,
  isEditExamOperationCurrent,
  runEditExamOperation,
} = editExamPage;
const {
  normalizeOptionList,
  buildExamCreatePayload,
  assertMutationSucceeded,
  buildAuthHeaders: examManagerBuildAuthHeaders,
} = examManagerPage;
const {
  computeExamTotals,
  formatExamDateTime,
  buildTeacherExamPayload,
  createExamAuthoringController,
  createExamAuthoringDeps,
  readCurrentIdentity,
  buildAuthHeaders: teacherBuildAuthHeaders,
  buildImageUploadRequestInit: teacherBuildImageUploadRequestInit,
  buildJsonRequestInit: teacherBuildJsonRequestInit,
  isAuthFailure: teacherIsAuthFailure,
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

// ===========================================================================
// Authenticated request construction (backend now requires auth on exam routes)
// ===========================================================================

test("EditExam.buildAuthHeaders attaches the canonical Bearer token from storage", () => {
  localStorage.setItem('authToken', 'tok-abc');
  assert.deepEqual(editBuildAuthHeaders(), { Authorization: 'Bearer tok-abc' });

  localStorage.removeItem('authToken');
  assert.deepEqual(editBuildAuthHeaders(), {}, 'no token => no Authorization header');
});

test("EditExam question-list request carries Authorization", () => {
  localStorage.setItem('authToken', 'tok-load');
  const init = buildQuestionListRequestInit();
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok-load');
  localStorage.removeItem('authToken');
});

test("EditExam image upload request carries Authorization and no Content-Type", () => {
  localStorage.setItem('authToken', 'tok-img');
  const formData = new FormData();
  formData.append('image', 'x');

  const init = editBuildImageUploadRequestInit(formData);
  const headers = init.headers as Record<string, string>;
  assert.equal(init.method, 'POST');
  assert.equal(init.body, formData);
  assert.equal(headers.Authorization, 'Bearer tok-img');
  assert.equal(headers['Content-Type'], undefined, 'the multipart boundary must not be overridden');
  localStorage.removeItem('authToken');
});

test("EditExam.isAuthFailure flags only 401/403 and ExamHttpError carries the status", () => {
  assert.equal(editIsAuthFailure(401), true);
  assert.equal(editIsAuthFailure(403), true);
  assert.equal(editIsAuthFailure(400), false);
  assert.equal(editIsAuthFailure(500), false);

  const err = new ExamHttpError(401, 'Failed to load questions');
  assert.equal(err.status, 401);
  assert.equal(err.name, 'ExamHttpError');
  assert.equal(err instanceof Error, true);
});

test("TeacherExams auth helpers attach the token and classify auth failures", () => {
  localStorage.setItem('authToken', 'tok-teacher');
  assert.deepEqual(teacherBuildAuthHeaders(), { Authorization: 'Bearer tok-teacher' });

  const formData = new FormData();
  const init = teacherBuildImageUploadRequestInit(formData);
  const headers = init.headers as Record<string, string>;
  assert.equal(init.method, 'POST');
  assert.equal(headers.Authorization, 'Bearer tok-teacher');
  assert.equal(headers['Content-Type'], undefined);

  assert.equal(teacherIsAuthFailure(401), true);
  assert.equal(teacherIsAuthFailure(403), true);
  assert.equal(teacherIsAuthFailure(200), false);
  localStorage.removeItem('authToken');
});

// ===========================================================================
// TeacherExams rollback: a failed cleanup must not be reported as success
// ===========================================================================

test("TeacherExams authoring controller surfaces cleanup-failed with the orphan exam id", async () => {
  let deleteCalls = 0;
  const controller = createExamAuthoringController({
    createExam: async () => ({ id: 'exam-orphan' }),
    addQuestion: async () => { throw new Error('question insert failed'); },
    deleteExam: async () => { deleteCalls += 1; throw new Error('rollback delete failed'); },
  });

  const outcome = await controller.submit({}, [{}]);
  assert.equal(outcome.status, 'cleanup-failed');
  if (outcome.status === 'cleanup-failed') {
    assert.equal(outcome.examId, 'exam-orphan');
    assert.equal(outcome.questionsAdded, 0);
    assert.match(outcome.error.message, /question insert failed/);
    assert.match(outcome.cleanupError.message, /rollback delete failed/);
  }
  assert.equal(deleteCalls, 1, 'cleanup is attempted exactly once, never silently retried');
  assert.equal(controller.orphanExamId(), 'exam-orphan');
  assert.equal(controller.isBusy(), false);
});

test("TeacherExams controller refuses to recreate while an orphan is unacknowledged", async () => {
  let createCalls = 0;
  const controller = createExamAuthoringController({
    createExam: async () => { createCalls += 1; return { id: 'exam-1' }; },
    addQuestion: async () => { throw new Error('insert failed'); },
    deleteExam: async () => { throw new Error('cleanup failed'); },
  });

  const first = await controller.submit({}, [{}]);
  assert.equal(first.status, 'cleanup-failed');

  // A blind retry must NOT create a second exam.
  const second = await controller.submit({}, [{}]);
  assert.deepEqual(second, { status: 'orphan-pending', examId: 'exam-1' });
  assert.equal(createCalls, 1, 'no duplicate exam is created while the orphan is pending');

  controller.clearOrphan();
  assert.equal(controller.orphanExamId(), null);
});

test("TeacherExams controller resumes authoring after the orphan is acknowledged", async () => {
  let addCalls = 0;
  const controller = createExamAuthoringController({
    createExam: async () => ({ id: 'exam-x' }),
    addQuestion: async () => {
      addCalls += 1;
      if (addCalls === 1) throw new Error('first insert failed');
      return {};
    },
    deleteExam: async () => { throw new Error('cleanup failed'); },
  });

  const failed = await controller.submit({}, [{}]);
  assert.equal(failed.status, 'cleanup-failed');

  controller.clearOrphan();
  const retried = await controller.submit({}, [{}]);
  assert.equal(retried.status, 'created');
});

// ===========================================================================
// ExamManager: a false api-http mutation result is a failure, not success
// ===========================================================================

test("ExamManager.assertMutationSucceeded treats a false server result as failure", () => {
  assert.doesNotThrow(() => assertMutationSucceeded(true, 'boom'));
  assert.throws(
    () => assertMutationSucceeded(false, 'Failed to delete exam'),
    /Failed to delete exam/,
  );
});

// ===========================================================================
// Production request lifecycle — the real load/upload/mutation calls the pages
// send, driven through an injected fetch (not header-builder parity only).
// ===========================================================================

type Captured = { url: string; init?: RequestInit };

/** Minimal Response-like object; avoids any real network dependency. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

test("EditExam.loadExamQuestions issues the authenticated GET the page sends", async () => {
  localStorage.setItem('authToken', 'tok-load');
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse([{ id: 'q1', options: '{"a":"A"}' }]);
  };

  const rows = await loadExamQuestions('exam-1', fetchImpl);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/exams/exam-1/questions'), 'loads the exam question list');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok-load');
  assert.equal(rows.length, 1);
  localStorage.removeItem('authToken');
});

test("EditExam.loadExamQuestions omits Authorization when no token exists", async () => {
  localStorage.removeItem('authToken');
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse([]);
  };

  await loadExamQuestions('exam-1', fetchImpl);
  const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, undefined, 'no token => no Authorization header');
  assert.ok(!JSON.stringify(headers).includes('null'), 'never sends Bearer null');
});

test("EditExam.loadExamQuestions surfaces 401 as an auth error, not an empty success", async () => {
  localStorage.removeItem('authToken');
  const fetchImpl = async () => jsonResponse({ error: 'unauthorized' }, 401);

  await assert.rejects(
    () => loadExamQuestions('exam-1', fetchImpl),
    (err: unknown) => err instanceof ExamHttpError && err.status === 401,
  );
});

test("EditExam.uploadQuestionImage posts multipart and never treats a rejection as success", async () => {
  localStorage.setItem('authToken', 'tok-img');
  const calls: Captured[] = [];
  const formData = new FormData();
  formData.append('image', 'x');

  const ok = await uploadQuestionImage(formData, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ success: true, imageUrl: '/uploads/x.png' });
  });
  assert.deepEqual(ok, { ok: true, status: 200, imageUrl: '/uploads/x.png' });
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.body, formData);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok-img');
  assert.equal(headers['Content-Type'], undefined, 'the multipart boundary must not be overridden');

  const denied = await uploadQuestionImage(formData, async () => jsonResponse({ error: 'forbidden' }, 403));
  assert.equal(denied.ok, false, 'a 403 is not an upload success');
  assert.equal(denied.status, 403);
  assert.equal(denied.imageUrl, undefined);
  localStorage.removeItem('authToken');
});

test("EditExam.buildJsonRequestInit adds auth only when a token exists", () => {
  localStorage.setItem('authToken', 'tok-json');
  const withToken = editBuildJsonRequestInit('PUT', { a: 1 });
  const headers = withToken.headers as Record<string, string>;
  assert.equal(withToken.method, 'PUT');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, 'Bearer tok-json');
  assert.equal(withToken.body, JSON.stringify({ a: 1 }));

  localStorage.removeItem('authToken');
  const noToken = editBuildJsonRequestInit('POST', {});
  assert.equal((noToken.headers as Record<string, string>).Authorization, undefined);
});

test("ExamManager.buildAuthHeaders never emits Bearer null", () => {
  localStorage.setItem('authToken', 'tok-em');
  assert.deepEqual(examManagerBuildAuthHeaders(), { Authorization: 'Bearer tok-em' });
  localStorage.removeItem('authToken');
  assert.deepEqual(examManagerBuildAuthHeaders(), {}, 'absent token omits the header entirely');
});

test("TeacherExams.buildJsonRequestInit omits Authorization when no token exists", () => {
  localStorage.setItem('authToken', 'tok-teacher-json');
  assert.equal(
    (teacherBuildJsonRequestInit('POST', {}).headers as Record<string, string>).Authorization,
    'Bearer tok-teacher-json',
  );
  localStorage.removeItem('authToken');
  assert.equal(
    (teacherBuildJsonRequestInit('POST', {}).headers as Record<string, string>).Authorization,
    undefined,
  );
});

test("TeacherExams.readCurrentIdentity scopes the session to user + token", () => {
  localStorage.clear();
  assert.equal(readCurrentIdentity(), null);
  localStorage.setItem('currentUser', JSON.stringify({ id: 'u1' }));
  localStorage.setItem('authToken', 'tok-1');
  assert.equal(readCurrentIdentity(), 'u1|tok-1');
  localStorage.removeItem('currentUser');
  assert.equal(readCurrentIdentity(), '|tok-1');
  localStorage.clear();
});

// ===========================================================================
// TeacherExams production deps: the real create/add/delete request lifecycle
// ===========================================================================

test("TeacherExams.createExamAuthoringDeps builds the real create/add/delete requests", async () => {
  localStorage.setItem('authToken', 'tok-author');
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return (init?.method ?? 'GET') === 'DELETE' ? jsonResponse({}, 200) : jsonResponse({ id: 'exam-1' });
  };
  const deps = createExamAuthoringDeps(fetchImpl);

  await deps.createExam({ title: 'T' });
  await deps.addQuestion('exam-1', { question_text: 'q' });
  await deps.deleteExam('exam-1');

  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.endsWith('/exams'));
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer tok-author');
  assert.ok(calls[1].url.endsWith('/exams/exam-1/questions'));
  assert.equal(calls[1].init?.method, 'POST');
  assert.ok(calls[2].url.endsWith('/exams/exam-1'));
  assert.equal(calls[2].init?.method, 'DELETE');
  localStorage.removeItem('authToken');
});

test("TeacherExams.createExamAuthoringDeps omits auth when no token is present", async () => {
  localStorage.removeItem('authToken');
  const calls: Captured[] = [];
  const deps = createExamAuthoringDeps(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ id: 'exam-1' });
  });

  await deps.createExam({});
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.ok(!JSON.stringify(headers).includes('null'), 'never sends Bearer null');
});

test("TeacherExams production deleteExam rejects a failed rollback response", async () => {
  localStorage.setItem('authToken', 'tok-author');
  const deps = createExamAuthoringDeps(async () => jsonResponse({ error: 'nope' }, 500));
  await assert.rejects(() => deps.deleteExam('exam-1'), /Failed to delete exam/);
  localStorage.removeItem('authToken');
});

test("TeacherExams controller keeps the orphan when the production rollback delete is rejected", async () => {
  localStorage.setItem('authToken', 'tok-author');
  localStorage.setItem('currentUser', JSON.stringify({ id: 'user-1' }));
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    if (url.endsWith('/exams') && method === 'POST') return jsonResponse({ id: 'exam-orphan' });
    if (url.endsWith('/questions') && method === 'POST') return jsonResponse({ error: 'insert failed' }, 500);
    if (method === 'DELETE') return jsonResponse({ error: 'cleanup failed' }, 500);
    return jsonResponse({});
  };
  const controller = createExamAuthoringController(createExamAuthoringDeps(fetchImpl));

  const outcome = await controller.submit({ title: 'T' }, [{ q: 1 }]);
  assert.equal(outcome.status, 'cleanup-failed');
  if (outcome.status === 'cleanup-failed') {
    assert.equal(outcome.examId, 'exam-orphan');
    assert.equal(outcome.questionsAdded, 0);
    assert.match(outcome.error.message, /Failed to add question/);
    assert.match(outcome.cleanupError.message, /Failed to delete exam/);
  }
  assert.equal(controller.orphanExamId(), 'exam-orphan');
  assert.equal(calls.filter((c) => c.init?.method === 'DELETE').length, 1, 'cleanup attempted once, never retried');
  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');
});

// ===========================================================================
// TeacherExams controller: the retained orphan is scoped to the acting identity
// ===========================================================================

function orphanControllerFor(identity: { current: string | null }) {
  return createExamAuthoringController({
    createExam: async () => ({ id: 'exam-orphan' }),
    addQuestion: async () => { throw new Error('insert failed'); },
    deleteExam: async () => { throw new Error('cleanup failed'); },
    getIdentity: () => identity.current,
  });
}

test("TeacherExams controller surfaces the orphan to the identity that created it", async () => {
  const identity = { current: 'user-A|tok-A' };
  const controller = orphanControllerFor(identity);

  const outcome = await controller.submit({}, [{}]);
  assert.equal(outcome.status, 'cleanup-failed');
  assert.equal(controller.orphanExamId(), 'exam-orphan');
});

test("TeacherExams controller does not leak an orphan across an identity change", async () => {
  const identity = { current: 'user-A|tok-A' };
  const controller = orphanControllerFor(identity);

  await controller.submit({}, [{}]);
  assert.equal(controller.orphanExamId(), 'exam-orphan');

  // A different user/token must not see the previous user's orphan id.
  identity.current = 'user-B|tok-B';
  assert.equal(controller.orphanExamId(), null, 'a foreign orphan is never surfaced');

  // ...and must not be blocked by it: the new session proceeds with its own submit.
  const second = await controller.submit({}, [{}]);
  assert.equal(second.status, 'cleanup-failed', 'the new identity is not blocked by a foreign orphan');
  assert.equal(controller.orphanExamId(), 'exam-orphan', 'the new identity owns its own orphan');
});

test("TeacherExams controller blocks blind retries within the same identity", async () => {
  const identity = { current: 'user-A|tok-A' };
  const controller = orphanControllerFor(identity);

  await controller.submit({}, [{}]);
  const retry = await controller.submit({}, [{}]);
  assert.deepEqual(retry, { status: 'orphan-pending', examId: 'exam-orphan' });

  controller.clearOrphan();
  assert.equal(controller.orphanExamId(), null);
});

// ===========================================================================
// 008: the authoring operation captures its identity ONCE (before the first
// request) and re-checks it before every later phase and before every outcome.
// The previous code assigned orphanOwner only AFTER a failed cleanup, so an
// A -> B switch mid-flight attributed A's retained exam to B.
// ===========================================================================

const examDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const identityController = (
  identity: { current: string | null },
  deps: { createExam: any; addQuestion: any; deleteExam: any },
) => createExamAuthoringController({ ...deps, getIdentity: () => identity.current });

test("an identity change during create stops the operation before any question write", async () => {
  const identity = { current: 'user-A|tok-A' };
  const createGate = examDeferred<{ id: string }>();
  const calls = { add: 0, del: 0 };
  const controller = identityController(identity, {
    createExam: () => createGate.promise,
    addQuestion: async () => { calls.add += 1; },
    deleteExam: async () => { calls.del += 1; },
  });

  const pending = controller.submit({}, [{ q: 1 }]);
  identity.current = 'user-B|tok-B'; // session changed while create was pending
  createGate.resolve({ id: 'exam-A' });

  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'identity-changed' });
  assert.equal('examId' in outcome, false, 'the exam id never reaches the new session');
  assert.equal(calls.add, 0, 'no question was written under the new identity');
  assert.equal(calls.del, 0, 'no destructive cleanup ran under the new identity');

  // The retained exam is recoverable by its ORIGINAL owner only.
  assert.equal(controller.orphanExamId(), null, 'the new identity sees nothing');
  identity.current = 'user-A|tok-A';
  assert.equal(controller.orphanExamId(), 'exam-A', 'the original owner keeps the recovery id');
});

test("an identity change during a question insert stops before the next write", async () => {
  const identity = { current: 'user-A|tok-A' };
  const addGate = examDeferred<unknown>();
  const calls = { add: 0, del: 0 };
  const controller = identityController(identity, {
    createExam: async () => ({ id: 'exam-A' }),
    addQuestion: async () => { calls.add += 1; await addGate.promise; },
    deleteExam: async () => { calls.del += 1; },
  });

  const pending = controller.submit({}, [{ q: 1 }, { q: 2 }]);
  await tick();
  assert.equal(calls.add, 1, 'the first insert started');
  identity.current = 'user-B|tok-B';
  addGate.resolve(undefined);

  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'identity-changed' });
  assert.equal(calls.add, 1, 'the second insert never ran');
  assert.equal(calls.del, 0);
});

test("an identity change before cleanup prevents the destructive rollback", async () => {
  const identity = { current: 'user-A|tok-A' };
  const addGate = examDeferred<never>();
  const calls = { del: 0 };
  const controller = identityController(identity, {
    createExam: async () => ({ id: 'exam-A' }),
    addQuestion: async () => { await addGate.promise; },
    deleteExam: async () => { calls.del += 1; },
  });

  const pending = controller.submit({}, [{ q: 1 }]);
  await tick();
  identity.current = 'user-B|tok-B';
  addGate.reject(new Error('insert failed'));

  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'identity-changed' });
  assert.equal(calls.del, 0, 'the rollback DELETE never ran under the new identity');
  identity.current = 'user-A|tok-A';
  assert.equal(controller.orphanExamId(), 'exam-A');
});

test("a rollback that completes after an identity change leaves no orphan", async () => {
  const identity = { current: 'user-A|tok-A' };
  const deleteGate = examDeferred<unknown>();
  const calls = { del: 0 };
  const controller = identityController(identity, {
    createExam: async () => ({ id: 'exam-A' }),
    addQuestion: async () => { throw new Error('insert failed'); },
    deleteExam: async () => { calls.del += 1; await deleteGate.promise; },
  });

  const pending = controller.submit({}, [{ q: 1 }]);
  await tick();
  identity.current = 'user-B|tok-B';
  deleteGate.resolve(undefined);

  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'identity-changed' });
  assert.equal(calls.del, 1);
  identity.current = 'user-A|tok-A';
  assert.equal(controller.orphanExamId(), null, 'the exam was deleted, so nothing is retained');
});

test("a save finishing after an identity change is never reported as the new session's success", async () => {
  const identity = { current: 'user-A|tok-A' };
  const addGate = examDeferred<unknown>();
  const controller = identityController(identity, {
    createExam: async () => ({ id: 'exam-A' }),
    addQuestion: async () => { await addGate.promise; },
    deleteExam: async () => {},
  });

  const pending = controller.submit({}, [{ q: 1 }]);
  await tick();
  identity.current = 'user-B|tok-B';
  addGate.resolve(undefined);

  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'identity-changed' }); // NOT 'created'
  assert.equal('examId' in outcome, false);

  // Back in the original session the exam is still known, and it still blocks
  // a duplicate recreation until it is acknowledged.
  identity.current = 'user-A|tok-A';
  assert.deepEqual(await controller.submit({}, [{}]), { status: 'orphan-pending', examId: 'exam-A' });
});

test("a token rotation for the same user counts as an identity change", async () => {
  const identity = { current: null as string | null };
  const createGate = examDeferred<{ id: string }>();
  const calls = { add: 0 };
  const controller = identityController(identity, {
    createExam: () => createGate.promise,
    addQuestion: async () => { calls.add += 1; },
    deleteExam: async () => {},
  });

  // readCurrentIdentity() is `userId|token`: the same user with a rotated token
  // is a different acting identity for an in-flight multi-step save.
  localStorage.setItem('currentUser', JSON.stringify({ id: 'user-1' }));
  localStorage.setItem('authToken', 'tok-1');
  identity.current = readCurrentIdentity();

  const pending = controller.submit({}, [{ q: 1 }]);
  localStorage.setItem('authToken', 'tok-2'); // rotated while create was pending
  identity.current = readCurrentIdentity();
  createGate.resolve({ id: 'exam-1' });

  const outcome = await pending;
  assert.deepEqual(outcome, { status: 'identity-changed' });
  assert.equal(calls.add, 0);

  localStorage.removeItem('authToken');
  localStorage.removeItem('currentUser');
});

// ===========================================================================
// 008: EditExam route-load lifecycle — a scope change retires the previous
// route's data, and a delayed save/upload completion must not reload its old
// exam over the current one.
// ===========================================================================

test("EditExam route guard flags a reset only when the exam scope actually changes", () => {
  const guard = createEditExamRouteLoadGuard();

  assert.equal(guard.begin('exam-A').reset, true); // first load on this route
  assert.equal(guard.begin('exam-A').reset, false); // a same-exam reload keeps the form
  assert.equal(guard.begin('exam-B').reset, true); // A -> B retires A's data
  assert.equal(guard.isScopeCurrent('exam-B'), true);
  assert.equal(guard.isScopeCurrent('exam-A'), false);
});

test("EditExam route guard supersedes an older load on a scope change", () => {
  const guard = createEditExamRouteLoadGuard();
  const first = guard.begin('exam-A');
  const second = guard.begin('exam-B');

  assert.equal(guard.isCurrent(second.token), true);
  assert.equal(guard.isCurrent(first.token), false); // A's late response is dropped

  guard.invalidate(); // unmount
  assert.equal(guard.isCurrent(second.token), false);
});

test("an A -> B route change with a failed question load never keeps A's questions", async () => {
  const guard = createEditExamRouteLoadGuard();
  let exam: string | null = 'exam-A';
  let questions: string[] = ['A-q1', 'A-q2'];

  // Mirrors EditExam.loadExamData exactly: reset on scope change, commit the
  // exam detail only while current, then the questions.
  const load = async (scope: string, getQuestions: () => Promise<string[]>) => {
    const { token, reset } = guard.begin(scope);
    if (reset) {
      exam = null;
      questions = [];
    }
    try {
      const detail = await Promise.resolve(scope);
      if (!guard.isCurrent(token)) return;
      exam = detail;
      const loaded = await getQuestions();
      if (!guard.isCurrent(token)) return;
      questions = loaded;
    } catch {
      if (!guard.isCurrent(token)) return; // a stale failure keeps the current view
    }
  };

  await load('exam-B', async () => { throw new Error('HTTP 500'); });

  assert.equal(exam, 'exam-B'); // B's header is committed
  assert.deepEqual(questions, [], "A's questions were retired and never mixed into B");
});

test("a delayed save completion does not reload its old exam over the current route", () => {
  const guard = createEditExamRouteLoadGuard();
  const loaded: string[] = [];
  const loadExamData = (scope: string) => {
    guard.begin(scope);
    loaded.push(scope);
  };
  // Mirrors the page's reloadSavedScope().
  const reloadSavedScope = (scope: string) => {
    if (guard.isScopeCurrent(scope)) loadExamData(scope);
  };

  loadExamData('exam-A'); // the page shows A
  loadExamData('exam-B'); // the route moved to B while A's save was pending
  reloadSavedScope('exam-A'); // A's save finally completes
  assert.deepEqual(loaded, ['exam-A', 'exam-B'], "A's completion must not reload A over B");

  reloadSavedScope('exam-B'); // B's own save completes normally
  assert.deepEqual(loaded, ['exam-A', 'exam-B', 'exam-B']);
});

// ===========================================================================
// 011/021: per-operation fencing — every save/upload commit (toast, form
// reset/close, image) is gated by a captured route generation + target
// identity, not by reload-only scope equality (which A -> B -> A defeats,
// because the loaded scope legitimately returns to 'A').
// ===========================================================================

test("EditExam route generation changes only on scope change or unmount", () => {
  const guard = createEditExamRouteLoadGuard();
  assert.equal(guard.currentRouteGeneration(), 0);
  guard.begin('exam-A'); // first load on this route
  assert.equal(guard.currentRouteGeneration(), 1);
  guard.begin('exam-A'); // a same-scope reload must NOT supersede in-flight ops
  assert.equal(guard.currentRouteGeneration(), 1);
  guard.begin('exam-B'); // A -> B
  assert.equal(guard.currentRouteGeneration(), 2);
  guard.invalidate(); // unmount
  assert.equal(guard.currentRouteGeneration(), 3);
});

test("EditExam operation token captures scope, kind, route generation, target and form generations", () => {
  const tracker = createEditExamOperationTracker();
  const first = tracker.begin('edit-question', 'q-1', 'exam-A', 3, { editForm: 7 });
  const second = tracker.begin('new-draft', 'new', 'exam-B', 4, { newDraft: 2 });
  assert.equal(first.scope, 'exam-A');
  assert.equal(first.kind, 'edit-question');
  assert.equal(first.routeGeneration, 3);
  assert.equal(first.operation, 1);
  assert.equal(first.target, 'q-1');
  assert.equal(first.editFormGeneration, 7);
  assert.equal(first.newDraftGeneration, undefined);
  assert.equal(second.scope, 'exam-B');
  assert.equal(second.kind, 'new-draft');
  assert.equal(second.routeGeneration, 4);
  assert.equal(second.operation, 2);
  assert.equal(second.target, 'new');
  assert.equal(second.newDraftGeneration, 2);
  assert.equal(second.editFormGeneration, undefined);
});

test("isEditExamOperationCurrent fences by captured operation kind on route generation, scope, target identity and form incarnation", () => {
  const token: EditExamOperationToken = { scope: 'exam-A', kind: 'edit-question', routeGeneration: 1, operation: 1, target: 'q-1', editFormGeneration: 5 };
  assert.equal(
    isEditExamOperationCurrent(token, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-1',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 5,
    }),
    true,
  );
  // Route generation moved (A -> B -> A or unmount) while the scope string
  // legitimately returned to 'exam-A'.
  assert.equal(
    isEditExamOperationCurrent(token, {
      scope: 'exam-A',
      routeGeneration: 2,
      editingQuestionId: 'q-1',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 5,
    }),
    false,
  );
  // Scope moved (A -> B).
  assert.equal(
    isEditExamOperationCurrent(token, {
      scope: 'exam-B',
      routeGeneration: 1,
      editingQuestionId: 'q-1',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 5,
    }),
    false,
  );
  // Target identity moved: the user is editing a different question now.
  assert.equal(
    isEditExamOperationCurrent(token, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-2',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 9,
    }),
    false,
  );
  // Same question reopened after cancel: identity matches but the form
  // incarnation advanced, so the previous session's completion is retired.
  assert.equal(
    isEditExamOperationCurrent(token, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-1',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 9,
    }),
    false,
  );
  // Editor closed while an EDITOR operation was in flight: the operation is
  // retired — closing the editor must NEVER reclassify it as list authority
  // (024). The form generation has moved as well.
  assert.equal(
    isEditExamOperationCurrent(token, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: null,
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 9,
    }),
    false,
  );
  // A 'delete-list' target with NO open edit form is list authority (the list
  // Delete button runs outside any editor, normally with
  // editingQuestionId=null): route/scope fencing alone governs, never the
  // editor form identity.
  const deleteListToken: EditExamOperationToken = { scope: 'exam-A', kind: 'delete-list', routeGeneration: 1, operation: 4, target: 'q-1' };
  assert.equal(
    isEditExamOperationCurrent(deleteListToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: null,
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 9,
    }),
    true,
  );
  // A DIFFERENT open editor keeps the list delete fenced (023).
  assert.equal(
    isEditExamOperationCurrent(deleteListToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-9',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 4,
    }),
    false,
  );
  // The editor for the delete target itself does not fence the list delete.
  assert.equal(
    isEditExamOperationCurrent(deleteListToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-1',
      addingNewQuestion: false,
      newDraftGeneration: 1,
      editFormGeneration: 4,
    }),
    true,
  );
  // A 'new' target requires the draft still open, no edit form taking over,
  // and the SAME draft incarnation the operation started in.
  const newToken: EditExamOperationToken = { scope: 'exam-A', kind: 'new-draft', routeGeneration: 1, operation: 2, target: 'new', newDraftGeneration: 3 };
  assert.equal(
    isEditExamOperationCurrent(newToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: null,
      addingNewQuestion: true,
      newDraftGeneration: 3,
      editFormGeneration: 1,
    }),
    true,
  );
  assert.equal(
    isEditExamOperationCurrent(newToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: null,
      addingNewQuestion: false, // form closed while the upload was in flight
      newDraftGeneration: 4,
      editFormGeneration: 1,
    }),
    false,
  );
  assert.equal(
    isEditExamOperationCurrent(newToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-1', // an edit form took over the screen
      addingNewQuestion: true,
      newDraftGeneration: 3,
      editFormGeneration: 1,
    }),
    false,
  );
  // Closed and reopened within one route: addingNewQuestion is true again,
  // but the draft incarnation advanced — the old upload must be retired.
  assert.equal(
    isEditExamOperationCurrent(newToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: null,
      addingNewQuestion: true,
      newDraftGeneration: 5,
      editFormGeneration: 1,
    }),
    false,
  );
  // A 'details' target only needs the route to be unchanged.
  const detailsToken: EditExamOperationToken = { scope: 'exam-A', kind: 'details', routeGeneration: 1, operation: 3, target: 'details' };
  assert.equal(
    isEditExamOperationCurrent(detailsToken, {
      scope: 'exam-A',
      routeGeneration: 1,
      editingQuestionId: 'q-1',
      addingNewQuestion: true,
      newDraftGeneration: 1,
      editFormGeneration: 1,
    }),
    true,
  );
});

/** Shared harness: mutable operation state + recording sinks. */
function makeOperationHarness(initial: EditExamOperationState) {
  const state: EditExamOperationState = { ...initial };
  const events: string[] = [];
  const reloaded: string[] = [];
  const sinks = {
    commit: (result: EditExamOperationResult) => {
      events.push(`commit:${result.imageUrl ?? result.status}`);
    },
    reject: (result: EditExamOperationResult) => {
      events.push(`reject:${result.status}`);
    },
    reload: (scope: string) => {
      events.push('reload');
      reloaded.push(scope);
    },
  };
  return { state, events, reloaded, sinks };
}

test("EditExam operation commits (toast/form/reload) while it owns the route and target", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });

  const outcome = await runEditExamOperation(
    {
      scope: 'exam-A',
      kind: 'new-draft',
      target: 'new',
      execute: async () => ({ ok: true, status: 200 }),
    },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'committed');
  assert.deepEqual(h.events, ['commit:200', 'reload']);
  assert.deepEqual(h.reloaded, ['exam-A']);
});

test("EditExam save finishing after A -> B commits nothing over B", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  // Route moves A -> B while the save is in flight.
  h.state.scope = 'exam-B';
  h.state.routeGeneration = 2;
  h.state.editingQuestionId = 'q-9';
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'no toast, no form close, no reload over B');
});

test("EditExam save finishing after A -> B -> A is still superseded", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  // A -> B -> A: the scope string returns to 'exam-A' (string-only equality
  // would pass), but the route generation has advanced.
  h.state.routeGeneration = 2;
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, []);
});

test("EditExam operation finishing after unmount commits nothing", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'new-draft', target: 'new', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.routeGeneration = 2; // routeGuard.invalidate() on unmount
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, []);
});

test("EditExam upload for a closed new-question form is superseded", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'new-draft', target: 'new', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.addingNewQuestion = false; // form closed while the upload ran
  gate.resolve({ ok: true, status: 200, imageUrl: '/uploads/late.png' });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'the late image never lands in a closed form');
});

test("EditExam out-of-order same-target uploads keep only the newest commit", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const olderGate = deferred<EditExamOperationResult>();
  const newerGate = deferred<EditExamOperationResult>();
  const run = (gate: ReturnType<typeof deferred<EditExamOperationResult>>) =>
    runEditExamOperation(
      { scope: 'exam-A', kind: 'new-draft', target: 'new', execute: () => gate.promise },
      { tracker, readState: () => h.state, sinks: h.sinks },
    );

  const older = run(olderGate); // started first, completes last
  const newer = run(newerGate);

  newerGate.resolve({ ok: true, status: 200, imageUrl: '/uploads/new.png' });
  assert.equal(await newer, 'committed');

  olderGate.resolve({ ok: true, status: 200, imageUrl: '/uploads/old.png' });
  assert.equal(await older, 'superseded', 'the older image must not overwrite the newer one');
  assert.deepEqual(h.events, ['commit:/uploads/new.png', 'reload']);
});

test("EditExam recordCompletion rejects an older operation once a newer one completed", () => {
  const tracker = createEditExamOperationTracker();
  const older = tracker.begin('new-draft', 'new', 'exam-A', 1);
  const newer = tracker.begin('new-draft', 'new', 'exam-A', 1);
  assert.equal(tracker.recordCompletion(newer), true);
  assert.equal(tracker.recordCompletion(older), false, 'a newer completion already won');
});

test("EditExam failed save while current toasts and keeps the form (no commit, no reload)", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });

  const outcome = await runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: async () => ({ ok: false, status: 500 }) },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(h.events, ['reject:500'], 'only the failure toast; the edit form and input stay');
  assert.deepEqual(h.reloaded, []);
});

test("EditExam failed save after a route change surfaces nothing", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.scope = 'exam-B';
  h.state.routeGeneration = 2;
  gate.resolve({ ok: false, status: 500 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, []);
});

// ===========================================================================
// 023: list-delete authority and target/draft lifetime incarnations.
// (1) handleDeleteQuestion runs from the list, OUTSIDE any editor
//     (editingQuestionId is normally null): a successful DELETE must commit
//     its reload/toast and a failure must surface — previously both were
//     swallowed as 'superseded' because the question id was required to be
//     the open editor.
// (2) The new-question draft and the question edit form have real lifetimes:
//     close/reopen (or cancel/reopen the same editor) advances the form
//     incarnation, so a completion from the previous form session can never
//     commit into the new one — target equality alone is insufficient.
// (3) Completion bookkeeping records the NEWEST completion per target
//     (success or failure), so an older upload cannot commit after a newer
//     attempt failed and a stale failure cannot toast over a newer success.
// ===========================================================================

test("supervisor: list delete without an open edit form commits its refresh", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });

  const outcome = await runEditExamOperation(
    { scope: 'exam-A', kind: 'delete-list', target: 'q-1', execute: async () => ({ ok: true, status: 200 }) },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'committed');
  assert.deepEqual(h.events, ['commit:200', 'reload']);
  assert.deepEqual(h.reloaded, ['exam-A']);
});

test("supervisor: a rejected list delete surfaces the failure toast (no silent swallow)", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });

  const outcome = await runEditExamOperation(
    { scope: 'exam-A', kind: 'delete-list', target: 'q-1', execute: async () => ({ ok: false, status: 500 }) },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(h.events, ['reject:500'], 'the list delete failure must reach the user');
  assert.deepEqual(h.reloaded, []);
});

test("supervisor: a list delete finishing after a route change commits nothing", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'delete-list', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.scope = 'exam-B';
  h.state.routeGeneration = 2;
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'no toast and no reload of A over B');
});

test("supervisor: a list delete is still superseded while a DIFFERENT editor is open", async () => {
  // The edit-target checks are NOT weakened: only the no-editor case is list
  // authority. A different open editor keeps the operation fenced.
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-9',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 4,
  });

  const outcome = await runEditExamOperation(
    { scope: 'exam-A', kind: 'delete-list', target: 'q-1', execute: async () => ({ ok: true, status: 200 }) },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'superseded');
  assert.deepEqual(h.events, []);
});

test("supervisor: close and reopen of the new draft retires the old upload", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'new-draft', target: 'new', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  // The page closes and reopens the same draft within one route generation:
  // addingNewQuestion true -> false -> true, and each boundary advances the
  // draft incarnation.
  h.state.addingNewQuestion = false;
  h.state.newDraftGeneration = 2;
  h.state.addingNewQuestion = true;
  h.state.newDraftGeneration = 3;
  gate.resolve({ ok: true, status: 200, imageUrl: 'old-image' });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'the old image never lands in the reopened draft');
});

test("supervisor: cancel and reopen of the same question editor retires the old save", async () => {
  // Same-ID editor ABA: identity matches again after reopen, but the form
  // incarnation advanced, so the previous session's save is retired.
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.editingQuestionId = null;   // cancel
  h.state.editFormGeneration = 2;
  h.state.editingQuestionId = 'q-1';  // reopen the same question
  h.state.editFormGeneration = 3;
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, []);
});

test("supervisor: an older upload cannot commit after a newer attempt failed", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const olderGate = deferred<EditExamOperationResult>();
  const newerGate = deferred<EditExamOperationResult>();
  const run = (gate: ReturnType<typeof deferred<EditExamOperationResult>>) =>
    runEditExamOperation(
      { scope: 'exam-A', kind: 'new-draft', target: 'new', execute: () => gate.promise },
      { tracker, readState: () => h.state, sinks: h.sinks },
    );

  const older = run(olderGate);
  const newer = run(newerGate);

  // The NEWER attempt fails first (and records its completion), then the
  // older upload succeeds: the older success must not overwrite the newer
  // failure outcome.
  newerGate.resolve({ ok: false, status: 500 });
  assert.equal(await newer, 'failed');

  olderGate.resolve({ ok: true, status: 200, imageUrl: '/uploads/old.png' });
  assert.equal(await older, 'superseded');
  assert.deepEqual(h.events, ['reject:500'], 'no stale success commit or toast');
});

test("supervisor: a stale failure cannot toast over a newer successful result", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: true,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const olderGate = deferred<EditExamOperationResult>();
  const newerGate = deferred<EditExamOperationResult>();
  const run = (gate: ReturnType<typeof deferred<EditExamOperationResult>>) =>
    runEditExamOperation(
      { scope: 'exam-A', kind: 'new-draft', target: 'new', execute: () => gate.promise },
      { tracker, readState: () => h.state, sinks: h.sinks },
    );

  const older = run(olderGate);
  const newer = run(newerGate);

  newerGate.resolve({ ok: true, status: 200, imageUrl: '/uploads/new.png' });
  assert.equal(await newer, 'committed');

  olderGate.resolve({ ok: false, status: 500 });
  assert.equal(await older, 'superseded');
  assert.deepEqual(h.events, ['commit:/uploads/new.png', 'reload'], 'the stale failure toasts nothing');
});

test("supervisor: normal same-scope upload and reload still commit", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 2,
  });

  const outcome = await runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: async () => ({ ok: true, status: 200, imageUrl: '/uploads/ok.png' }) },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'committed');
  assert.deepEqual(h.events, ['commit:/uploads/ok.png', 'reload']);
  assert.deepEqual(h.reloaded, ['exam-A']);
});

// ===========================================================================
// 024: immutable operation kind — authority is captured at start and NEVER
// re-inferred from the current UI. An editor save/upload that started while
// an editor was open stays an editor operation even after the editor closes,
// so it must always require its original target and form incarnation; a list
// delete stays list authority and never requires an open editor.
// ===========================================================================

test("supervisor: editor upload resolving after the editor closed is superseded (024 reproduction)", async () => {
  // Exact 024 reproduction: start editor upload for q-1 with
  // editFormGeneration=0; close the editor (editingQuestionId=null,
  // editFormGeneration advances); resolve the old upload.
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  // The editor closes while the upload is in flight.
  h.state.editingQuestionId = null;
  h.state.editFormGeneration = 1;
  gate.resolve({ ok: true, status: 200, imageUrl: '/uploads/late.png' });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'a closed editor must never reclassify the upload as list authority');
});

test("supervisor: editor save resolving after the editor closed toasts nothing", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.editingQuestionId = null;
  h.state.editFormGeneration = 1;
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'no success toast and no form close over the closed editor');
});

test("supervisor: editor upload resolving after the target switched to another question is superseded", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  // The user switches the editor to another question mid-upload.
  h.state.editingQuestionId = 'q-2';
  h.state.editFormGeneration = 1;
  gate.resolve({ ok: true, status: 200, imageUrl: '/uploads/late.png' });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'the old image must never land in the other question editor');
});

test("supervisor: editor upload resolving after the same question editor reopened is superseded", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  // Cancel and reopen the SAME question: identity matches again, but each
  // boundary advances the form incarnation.
  h.state.editingQuestionId = null;
  h.state.editFormGeneration = 1;
  h.state.editingQuestionId = 'q-1';
  h.state.editFormGeneration = 2;
  gate.resolve({ ok: true, status: 200, imageUrl: '/uploads/late.png' });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'the old image never lands in the reopened editor');
});

test("supervisor: a stale editor failure after the editor closed produces no toast", async () => {
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.editingQuestionId = null;
  h.state.editFormGeneration = 1;
  gate.resolve({ ok: false, status: 500 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, [], 'a stale failure must not toast over the closed editor state');
});

test("supervisor: list delete commits when the editor closes mid-flight (list authority needs no editor)", async () => {
  // The delete-list operation started while the target's editor was open and
  // the editor closed during the flight: list authority must NOT require an
  // editor, so the server outcome and reload still commit.
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'delete-list', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.editingQuestionId = null;
  h.state.editFormGeneration = 1;
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'committed');
  assert.deepEqual(h.events, ['commit:200', 'reload']);
  assert.deepEqual(h.reloaded, ['exam-A']);
});

test("supervisor: list delete is fenced when a different editor opens mid-flight", async () => {
  // Negative counterpart of the list-authority rule: a DIFFERENT open editor
  // keeps the delete fenced (023) so its reload never lands under another
  // question's editor.
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: null,
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 1,
  });
  const gate = deferred<EditExamOperationResult>();

  const pending = runEditExamOperation(
    { scope: 'exam-A', kind: 'delete-list', target: 'q-1', execute: () => gate.promise },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  h.state.editingQuestionId = 'q-9';
  h.state.editFormGeneration = 2;
  gate.resolve({ ok: true, status: 200 });

  assert.equal(await pending, 'superseded');
  assert.deepEqual(h.events, []);
});

test("supervisor: a current editor failure still toasts and keeps the form (control)", async () => {
  // Positive control for the stale-failure rule: while the editor is still
  // open with the same incarnation, a failure toasts and retains input.
  const tracker = createEditExamOperationTracker();
  const h = makeOperationHarness({
    scope: 'exam-A',
    routeGeneration: 1,
    editingQuestionId: 'q-1',
    addingNewQuestion: false,
    newDraftGeneration: 1,
    editFormGeneration: 0,
  });

  const outcome = await runEditExamOperation(
    { scope: 'exam-A', kind: 'edit-question', target: 'q-1', execute: async () => ({ ok: false, status: 500 }) },
    { tracker, readState: () => h.state, sinks: h.sinks },
  );

  assert.equal(outcome, 'failed');
  assert.deepEqual(h.events, ['reject:500'], 'only the failure toast; the edit form and input stay');
  assert.deepEqual(h.reloaded, []);
});
