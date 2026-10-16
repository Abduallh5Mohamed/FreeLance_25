/**
 * M1 expanded student-management UI — isolated production-path tests
 * (node:test + tsx, no DOM/jsdom available in this repo).
 *
 * Scope: the three scoped pages — src/pages/Students.tsx,
 * src/pages/OfflineStudents.tsx, src/pages/StudentRegistrationRequests.tsx.
 *
 * What is covered:
 *  - the verified server-contract helpers (online/offline normalization for
 *    the MySQL 0/1 runtime values, search filtering, course_names parsing);
 *  - the mutation controllers actually used by the pages, driven with
 *    injected fakes that reproduce the api-http contract (updateStudent →
 *    boolean, createStudent → id or throw, approve/reject → { message } or
 *    throw): server-authoritative refresh ordering, duplicate-request
 *    single-flight, failure outcomes that keep caller state untouched;
 *  - the registration page data loader: every status is fetched (the
 *    approved/rejected tabs filter client-side), failures propagate.
 *
 * Isolation: no env files, no database, no network, no live services, no
 * real browser. Asset imports and src/lib/api-http.ts are stubbed through
 * synchronous ESM hooks so the page modules load under node; every test
 * injects its own dependencies into the exported page functions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

// ---------------------------------------------------------------------------
// Environment isolation (must run before the page modules are imported)
// ---------------------------------------------------------------------------

const originalConsoleError = console.error;
const capturedConsoleErrors: unknown[][] = [];
console.error = (...args: unknown[]) => {
  capturedConsoleErrors.push(args);
};

// src/lib/api-http.ts throws at module init under node (import.meta.env);
// tests inject their own contract-accurate fakes into the exported page
// functions, so an inert stub is enough to load the pages.
const API_HTTP_STUB_SOURCE = [
  "export const getStudents = async () => [];",
  "export const createStudent = async () => '';",
  "export const updateStudent = async () => true;",
  "export const deleteStudent = async () => true;",
  "export const deleteUserByStudentId = async () => true;",
  "export const getGrades = async () => [];",
  "export const getGroups = async () => [];",
  "export const getCourses = async () => [];",
  "export const getSubscriptions = async () => [];",
  "export const getRegistrationRequests = async () => [];",
  "export const approveRegistrationRequest = async () => ({ message: '' });",
  "export const rejectRegistrationRequest = async () => ({ message: '' });",
].join("\n");

// The hooks run on a separate module-hooks thread, so they must be
// self-contained; they are installed via module.register() with a data: URL
// module. (Synchronous registerHooks() cannot be combined with tsx's async
// loader: passing CommonJS deps such as react through nextLoad yields an
// undefined source that the synchronous validator rejects before the pages
// can be imported.)
const hooksModuleSource = `
const API_HTTP_STUB_SOURCE = ${JSON.stringify(API_HTTP_STUB_SOURCE)};
export async function resolve(specifier, context, nextResolve) {
  // Vite asset imports have no meaning under node.
  if (specifier.endsWith(".png") || specifier.endsWith(".svg") || specifier.endsWith(".jpg")) {
    return { url: "data:text/javascript,export default 'stub-asset'", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  // Vite asset imports have no meaning under node.
  if (url.startsWith("data:")) {
    return { format: "module", shortCircuit: true, source: "export default 'stub-asset';" };
  }
  const clean = url.split("?")[0];
  if (clean.endsWith("/src/lib/api-http.ts")) {
    return { format: "module", shortCircuit: true, source: API_HTTP_STUB_SOURCE };
  }
  return nextLoad(url, context);
}
`;

register("data:text/javascript," + encodeURIComponent(hooksModuleSource));

// localStorage is only read inside component render in these pages, but the
// stubbed api-http/auth graph may touch it; provide a disposable one.
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

const studentsPage = await import("../pages/Students");
const offlinePage = await import("../pages/OfflineStudents");
const registrationPage = await import("../pages/StudentRegistrationRequests");

const {
  isOfflineStudent,
  filterStudentsBySearch,
  splitCourseNames,
  createStudentMutationController,
} = studentsPage as typeof studentsPage & {
  isOfflineStudent: (value: unknown) => boolean;
  filterStudentsBySearch: <T extends { name?: string; email?: string; phone?: string; guardian_phone?: string }>(students: T[], term: string) => T[];
  splitCourseNames: (courseNames?: string | null) => string[];
  createStudentMutationController: typeof import("../pages/Students").createStudentMutationController;
};

const {
  isOfflineStudent: isOfflineStudentOffline,
  filterStudentsBySearch: filterStudentsBySearchOffline,
  splitCourseNames: splitCourseNamesOffline,
  createStudentMutationController: createOfflineStudentMutationController,
} = offlinePage as typeof offlinePage & {
  isOfflineStudent: (value: unknown) => boolean;
  filterStudentsBySearch: <T extends { name?: string; email?: string; phone?: string; guardian_phone?: string }>(students: T[], term: string) => T[];
  splitCourseNames: (courseNames?: string | null) => string[];
  createStudentMutationController: typeof import("../pages/OfflineStudents").createStudentMutationController;
};

const {
  loadRegistrationPageData,
  splitRequestsByStatus,
  createRegistrationDecisionController,
} = registrationPage as typeof registrationPage & {
  loadRegistrationPageData: typeof registrationPage.loadRegistrationPageData;
  splitRequestsByStatus: typeof registrationPage.splitRequestsByStatus;
  createRegistrationDecisionController: typeof registrationPage.createRegistrationDecisionController;
};

// ---------------------------------------------------------------------------
// Shared fixtures / fakes
// ---------------------------------------------------------------------------

interface NotifyCall {
  kind: "success" | "error";
  title: string;
  description: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const studentMutationMessages = {
  successTitle: "ok-title",
  successDescription: "ok-desc",
  failureTitle: "err-title",
  failureDescription: "err-desc",
};

const baseMutationDeps = () => {
  const state = {
    updateCalls: [] as Array<{ id: string; data: Record<string, unknown> }>,
    deleteCalls: [] as string[],
    deleteUserCalls: [] as string[],
    refreshCount: 0,
    notifications: [] as NotifyCall[],
    updateResult: true,
    updateError: null as Error | null,
    deleteResult: true,
    deleteUserResult: true,
    refreshError: null as Error | null,
  };
  const deps = {
    updateStudent: async (id: string, data: Record<string, unknown>) => {
      state.updateCalls.push({ id, data });
      await delay(5);
      if (state.updateError) throw state.updateError;
      return state.updateResult;
    },
    deleteStudent: async (id: string) => {
      state.deleteCalls.push(id);
      await delay(5);
      return state.deleteResult;
    },
    deleteUserByStudentId: async (id: string) => {
      state.deleteUserCalls.push(id);
      await delay(5);
      return state.deleteUserResult;
    },
    refresh: async () => {
      state.refreshCount += 1;
      if (state.refreshError) throw state.refreshError;
    },
    notify: (kind: "success" | "error", title: string, description: string) => {
      state.notifications.push({ kind, title, description });
    },
  };
  return { deps, state };
};

const registrationDeps = () => {
  const state = {
    approveCalls: [] as string[],
    rejectCalls: [] as Array<{ id: string; reason: string }>,
    refreshCount: 0,
    notifications: [] as NotifyCall[],
    approveError: null as Error | null,
    rejectError: null as Error | null,
    approveMessage: "server-accepted",
    rejectMessage: "server-rejected",
    refreshError: null as Error | null,
  };
  const deps = {
    approveRegistrationRequest: async (id: string) => {
      state.approveCalls.push(id);
      await delay(5);
      if (state.approveError) throw state.approveError;
      return { message: state.approveMessage };
    },
    rejectRegistrationRequest: async (id: string, reason: string) => {
      state.rejectCalls.push({ id, reason });
      await delay(5);
      if (state.rejectError) throw state.rejectError;
      return { message: state.rejectMessage };
    },
    refresh: async () => {
      state.refreshCount += 1;
      if (state.refreshError) throw state.refreshError;
    },
    notify: (kind: "success" | "error", title: string, description: string) => {
      state.notifications.push({ kind, title, description });
    },
  };
  return { deps, state };
};

const pendingRequest = {
  id: "req-1",
  name: "سارة",
  phone: "01000000000",
  status: "pending" as const,
};

// ---------------------------------------------------------------------------
// Module surface sanity
// ---------------------------------------------------------------------------

test("pages expose the tested production surface", () => {
  for (const [name, mod] of [
    ["Students", studentsPage],
    ["OfflineStudents", offlinePage],
    ["StudentRegistrationRequests", registrationPage],
  ] as const) {
    assert.equal(typeof (mod as { default: unknown }).default, "function", `${name} default export`);
  }
  assert.equal(typeof isOfflineStudent, "function");
  assert.equal(typeof createStudentMutationController, "function");
  assert.equal(typeof createOfflineStudentMutationController, "function");
  assert.equal(typeof createRegistrationDecisionController, "function");
});

// ---------------------------------------------------------------------------
// Helpers: online/offline normalization (MySQL 0/1 at runtime)
// ---------------------------------------------------------------------------

test("isOfflineStudent normalizes the MySQL 0/1 runtime values", () => {
  assert.equal(isOfflineStudent(1), true);
  assert.equal(isOfflineStudent(true), true);
  assert.equal(isOfflineStudent("1"), true);
  assert.equal(isOfflineStudent(0), false);
  assert.equal(isOfflineStudent(false), false);
  assert.equal(isOfflineStudent(undefined), false);
  assert.equal(isOfflineStudent(null), false);
  assert.equal(isOfflineStudent("true"), false);
});

test("both student pages share the same offline normalization", () => {
  for (const value of [1, 0, true, false, "1", undefined, null]) {
    assert.equal(isOfflineStudent(value), isOfflineStudentOffline(value));
  }
});

test("filterStudentsBySearch matches the fields the API returns", () => {
  const students = [
    { id: "1", name: "أحمد علي", email: "ahmed@example.com", phone: "01011111111", guardian_phone: "01099999999" },
    { id: "2", name: "Sara Mohamed", email: "sara@example.com", phone: "01022222222" },
  ];
  assert.deepEqual(filterStudentsBySearch(students, "").map(s => s.id), ["1", "2"]);
  assert.deepEqual(filterStudentsBySearch(students, "   ").map(s => s.id), ["1", "2"]);
  // case-insensitive name
  assert.deepEqual(filterStudentsBySearch(students, "sara").map(s => s.id), ["2"]);
  // email
  assert.deepEqual(filterStudentsBySearch(students, "ahmed@example.com").map(s => s.id), ["1"]);
  // phone / guardian phone substrings
  assert.deepEqual(filterStudentsBySearch(students, "2222").map(s => s.id), ["2"]);
  assert.deepEqual(filterStudentsBySearch(students, "9999").map(s => s.id), ["1"]);
  // trimmed term
  assert.deepEqual(filterStudentsBySearch(students, "  Sara Mohamed  ").map(s => s.id), ["2"]);
  // no match
  assert.deepEqual(filterStudentsBySearch(students, "لا يوجد"), []);
});

test("filterStudentsBySearch behaves identically on the offline page copy", () => {
  const students = [{ id: "1", name: "مهاب", phone: "01033333333", guardian_phone: "01044444444" }];
  assert.deepEqual(filterStudentsBySearchOffline(students, "مهاب").map(s => s.id), ["1"]);
  assert.deepEqual(filterStudentsBySearchOffline(students, "4444").map(s => s.id), ["1"]);
  assert.deepEqual(filterStudentsBySearchOffline(students, "x"), []);
});

test("splitCourseNames parses the GROUP_CONCAT CSV field", () => {
  assert.deepEqual(splitCourseNames("رياضيات,علوم"), ["رياضيات", "علوم"]);
  assert.deepEqual(splitCourseNames(""), []);
  assert.deepEqual(splitCourseNames(null), []);
  assert.deepEqual(splitCourseNames(undefined), []);
  assert.deepEqual(splitCourseNames(",,,"), []);
  assert.deepEqual(splitCourseNamesOffline("كيمياء"), ["كيمياء"]);
});

// ---------------------------------------------------------------------------
// Students.tsx mutation controller
// ---------------------------------------------------------------------------

test("update success refreshes from the server and notifies once", async () => {
  const { deps, state } = baseMutationDeps();
  const controller = createStudentMutationController(deps);

  const outcome = await controller.update("s1", { name: "New Name" }, studentMutationMessages);

  assert.deepEqual(outcome, { ok: true });
  assert.equal(state.updateCalls.length, 1);
  assert.deepEqual(state.updateCalls[0], { id: "s1", data: { name: "New Name" } });
  assert.equal(state.refreshCount, 1); // server-authoritative refresh happened
  assert.deepEqual(state.notifications, [
    { kind: "success", title: "ok-title", description: "ok-desc" },
  ]);
});

test("update failure (api returns false) keeps the list untouched and reports an error", async () => {
  const { deps, state } = baseMutationDeps();
  state.updateResult = false;
  const controller = createStudentMutationController(deps);

  const outcome = await controller.update("s1", { name: "x" }, studentMutationMessages);

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0); // no refresh without server confirmation
  assert.deepEqual(state.notifications, [
    { kind: "error", title: "err-title", description: "err-desc" },
  ]);
});

test("update thrown server error is surfaced with the server message", async () => {
  const { deps, state } = baseMutationDeps();
  state.updateError = new Error("HTTP 403");
  const controller = createStudentMutationController(deps);

  const outcome = await controller.update("s1", {}, studentMutationMessages);

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0);
  assert.deepEqual(state.notifications, [
    { kind: "error", title: "err-title", description: "HTTP 403" },
  ]);
});

test("duplicate concurrent updates for the same student issue exactly one request", async () => {
  const { deps, state } = baseMutationDeps();
  const controller = createStudentMutationController(deps);

  const [first, second] = await Promise.all([
    controller.update("s1", { name: "a" }, studentMutationMessages),
    controller.update("s1", { name: "b" }, studentMutationMessages),
  ]);

  assert.equal(state.updateCalls.length, 1);
  assert.equal(state.refreshCount, 1);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
});

test("updates for different students are independent", async () => {
  const { deps, state } = baseMutationDeps();
  const controller = createStudentMutationController(deps);

  await Promise.all([
    controller.update("s1", {}, studentMutationMessages),
    controller.update("s2", {}, studentMutationMessages),
  ]);

  assert.equal(state.updateCalls.length, 2);
  assert.equal(state.refreshCount, 2);
});

test("failed update is retried after settling (single-flight map releases)", async () => {
  const { deps, state } = baseMutationDeps();
  state.updateResult = false;
  const controller = createStudentMutationController(deps);

  const first = await controller.update("s1", {}, studentMutationMessages);
  state.updateResult = true;
  const second = await controller.update("s1", {}, studentMutationMessages);

  assert.deepEqual(first, { ok: false });
  assert.deepEqual(second, { ok: true });
  assert.equal(state.updateCalls.length, 2);
});

test("delete and permanent user-delete follow the same server-authoritative contract", async () => {
  const { deps, state } = baseMutationDeps();
  const controller = createStudentMutationController(deps);

  const removeOutcome = await controller.remove("s1", {
    ...studentMutationMessages,
    successTitle: "deleted",
  });
  assert.deepEqual(removeOutcome, { ok: true });
  assert.deepEqual(state.deleteCalls, ["s1"]);
  assert.equal(state.refreshCount, 1);

  state.deleteUserResult = false;
  const removeUserOutcome = await controller.removeUser("s1", studentMutationMessages);
  assert.deepEqual(removeUserOutcome, { ok: false });
  assert.deepEqual(state.deleteUserCalls, ["s1"]);
  assert.equal(state.refreshCount, 1); // still no refresh after the failure
  assert.equal(state.notifications.filter(n => n.kind === "error").length, 1);
});

test("duplicate concurrent permanent deletes issue exactly one request", async () => {
  const { deps, state } = baseMutationDeps();
  const controller = createStudentMutationController(deps);

  await Promise.all([
    controller.removeUser("s1", studentMutationMessages),
    controller.removeUser("s1", studentMutationMessages),
  ]);

  assert.equal(state.deleteUserCalls.length, 1);
  assert.equal(state.refreshCount, 1);
});

// ---------------------------------------------------------------------------
// OfflineStudents.tsx mutation controller (create + update + deletes)
// ---------------------------------------------------------------------------

const offlineDeps = () => {
  const state = {
    createCalls: [] as Array<Partial<Record<string, unknown>>>,
    updateCalls: [] as Array<{ id: string; data: Record<string, unknown> }>,
    deleteCalls: [] as string[],
    deleteUserCalls: [] as string[],
    refreshCount: 0,
    notifications: [] as NotifyCall[],
    createId: "new-student-id",
    createError: null as Error | null,
    updateResult: true,
  };
  const deps = {
    createStudent: async (student: Record<string, unknown>) => {
      state.createCalls.push(student);
      await delay(5);
      if (state.createError) throw state.createError;
      return state.createId;
    },
    updateStudent: async (id: string, data: Record<string, unknown>) => {
      state.updateCalls.push({ id, data });
      await delay(5);
      return state.updateResult;
    },
    deleteStudent: async (id: string) => {
      state.deleteCalls.push(id);
      await delay(5);
      return true;
    },
    deleteUserByStudentId: async (id: string) => {
      state.deleteUserCalls.push(id);
      await delay(5);
      return true;
    },
    refresh: async () => {
      state.refreshCount += 1;
    },
    notify: (kind: "success" | "error", title: string, description: string) => {
      state.notifications.push({ kind, title, description });
    },
  };
  return { deps, state };
};

test("offline create success sends the offline payload and refreshes from the server", async () => {
  const { deps, state } = offlineDeps();
  const controller = createOfflineStudentMutationController(deps);

  const outcome = await controller.create(
    { name: "يونس", phone: "01055555555", guardian_phone: "01066666666", is_offline: true },
    studentMutationMessages
  );

  assert.deepEqual(outcome, { ok: true });
  assert.equal(state.createCalls.length, 1);
  const payload = state.createCalls[0];
  assert.equal(payload.is_offline, true);
  assert.equal(payload.phone, "01055555555");
  assert.equal(state.refreshCount, 1);
  assert.deepEqual(state.notifications, [
    { kind: "success", title: "ok-title", description: "ok-desc" },
  ]);
});

test("offline create failure (duplicate phone server error) keeps the dialog state and reports the server message", async () => {
  const { deps, state } = offlineDeps();
  state.createError = new Error("رقم الهاتف أو البريد مستخدم بالفعل");
  const controller = createOfflineStudentMutationController(deps);

  const outcome = await controller.create(
    { name: "يونس", phone: "01055555555", is_offline: true },
    studentMutationMessages
  );

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0);
  assert.deepEqual(state.notifications, [
    { kind: "error", title: "err-title", description: "رقم الهاتف أو البريد مستخدم بالفعل" },
  ]);
});

test("offline create treats an empty id as failure", async () => {
  const { deps, state } = offlineDeps();
  state.createId = "";
  const controller = createOfflineStudentMutationController(deps);

  const outcome = await controller.create({ name: "x", phone: "1" }, studentMutationMessages);

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0);
  assert.equal(state.notifications.at(-1)?.kind, "error");
});

test("offline update failure keeps outcome false without refreshing", async () => {
  const { deps, state } = offlineDeps();
  state.updateResult = false;
  const controller = createOfflineStudentMutationController(deps);

  const outcome = await controller.update("s9", { name: "y" }, studentMutationMessages);

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0);
  assert.deepEqual(state.notifications, [
    { kind: "error", title: "err-title", description: "err-desc" },
  ]);
});

test("duplicate concurrent creates for the same phone issue exactly one request", async () => {
  const { deps, state } = offlineDeps();
  const controller = createOfflineStudentMutationController(deps);

  const [first, second] = await Promise.all([
    controller.create({ name: "مريم", phone: "01077777777" }, studentMutationMessages),
    controller.create({ name: "مريم", phone: "01077777777" }, studentMutationMessages),
  ]);

  assert.equal(state.createCalls.length, 1);
  assert.equal(state.refreshCount, 1);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
});

test("offline deletes use the same confirmation-driven contract", async () => {
  const { deps, state } = offlineDeps();
  const controller = createOfflineStudentMutationController(deps);

  const removeOutcome = await controller.remove("s1", studentMutationMessages);
  const removeUserOutcome = await controller.removeUser("s1", studentMutationMessages);

  assert.deepEqual(removeOutcome, { ok: true });
  assert.deepEqual(removeUserOutcome, { ok: true });
  assert.deepEqual(state.deleteCalls, ["s1"]);
  assert.deepEqual(state.deleteUserCalls, ["s1"]);
  assert.equal(state.refreshCount, 2);
});

// ---------------------------------------------------------------------------
// StudentRegistrationRequests.tsx
// ---------------------------------------------------------------------------

test("registration page loads every status, not only pending", async () => {
  const calls: unknown[][] = [];
  const requests = [pendingRequest];
  const data = await loadRegistrationPageData({
    getRegistrationRequests: async (...args: unknown[]) => {
      calls.push(args);
      return requests as never;
    },
    getGrades: async () => [{ id: "g1", name: "الصف الثاني" }] as never,
    getGroups: async () => [] as never,
    getCourses: async () => [] as never,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], []); // no status filter: approved/rejected tabs can populate
  assert.deepEqual(data.requests, requests);
  assert.deepEqual(data.grades, [{ id: "g1", name: "الصف الثاني" }]);
});

test("registration load failures propagate to the caller", async () => {
  await assert.rejects(
    loadRegistrationPageData({
      getRegistrationRequests: async () => { throw new Error("HTTP 403"); },
      getGrades: async () => [] as never,
      getGroups: async () => [] as never,
      getCourses: async () => [] as never,
    }),
    /HTTP 403/
  );
});

test("splitRequestsByStatus feeds the three tabs", () => {
  const requests = [
    { ...pendingRequest },
    { ...pendingRequest, id: "req-2", status: "approved" as const },
    { ...pendingRequest, id: "req-3", status: "rejected" as const },
  ];
  const { pending, approved, rejected } = splitRequestsByStatus(requests);
  assert.deepEqual(pending.map(r => r.id), ["req-1"]);
  assert.deepEqual(approved.map(r => r.id), ["req-2"]);
  assert.deepEqual(rejected.map(r => r.id), ["req-3"]);
});

test("approve success refreshes from the server and notifies with the server message", async () => {
  const { deps, state } = registrationDeps();
  const controller = createRegistrationDecisionController(deps);

  const outcome = await controller.approve(pendingRequest);

  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(state.approveCalls, ["req-1"]);
  assert.equal(state.refreshCount, 1);
  assert.deepEqual(state.notifications, [
    { kind: "success", title: "تم قبول الطلب", description: "server-accepted" },
  ]);
});

test("approve of an already-processed request surfaces the server error without a false success", async () => {
  const { deps, state } = registrationDeps();
  state.approveError = new Error("طلب التسجيل غير موجود أو تم معالجته بالفعل");
  const controller = createRegistrationDecisionController(deps);

  const outcome = await controller.approve(pendingRequest);

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0);
  assert.deepEqual(state.notifications, [
    { kind: "error", title: "خطأ", description: "طلب التسجيل غير موجود أو تم معالجته بالفعل" },
  ]);
});

test("duplicate concurrent approve (double click) issues exactly one request", async () => {
  const { deps, state } = registrationDeps();
  const controller = createRegistrationDecisionController(deps);

  const [first, second] = await Promise.all([
    controller.approve(pendingRequest),
    controller.approve(pendingRequest),
  ]);

  assert.equal(state.approveCalls.length, 1);
  assert.equal(state.refreshCount, 1);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
});

test("approve still reports success when the post-decision refresh fails", async () => {
  const { deps, state } = registrationDeps();
  state.refreshError = new Error("HTTP 500");
  const controller = createRegistrationDecisionController(deps);
  capturedConsoleErrors.length = 0;

  const outcome = await controller.approve(pendingRequest);

  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(state.notifications, [
    { kind: "success", title: "تم قبول الطلب", description: "server-accepted" },
  ]);
  // the refresh failure is logged instead of being reported as a failed decision
  assert.ok(capturedConsoleErrors.length > 0);
  capturedConsoleErrors.length = 0;
});

test("reject sends the reason and refreshes only after server confirmation", async () => {
  const { deps, state } = registrationDeps();
  const controller = createRegistrationDecisionController(deps);

  const outcome = await controller.reject(pendingRequest, "بيانات ناقصة");

  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(state.rejectCalls, [{ id: "req-1", reason: "بيانات ناقصة" }]);
  assert.equal(state.refreshCount, 1);
  assert.deepEqual(state.notifications, [
    { kind: "success", title: "تم رفض الطلب", description: "server-rejected" },
  ]);
});

test("reject failure keeps the caller state for retry", async () => {
  const { deps, state } = registrationDeps();
  state.rejectError = new Error("HTTP 500");
  const controller = createRegistrationDecisionController(deps);

  const outcome = await controller.reject(pendingRequest, "سبب");

  assert.deepEqual(outcome, { ok: false });
  assert.equal(state.refreshCount, 0);
  assert.deepEqual(state.notifications, [
    { kind: "error", title: "خطأ", description: "HTTP 500" },
  ]);
});

test("duplicate concurrent reject issues exactly one request", async () => {
  const { deps, state } = registrationDeps();
  const controller = createRegistrationDecisionController(deps);

  await Promise.all([
    controller.reject(pendingRequest, "سبب أ"),
    controller.reject(pendingRequest, "سبب ب"),
  ]);

  assert.equal(state.rejectCalls.length, 1);
  assert.deepEqual(state.rejectCalls[0], { id: "req-1", reason: "سبب أ" });
  assert.equal(state.refreshCount, 1);
});

test("decisions for different requests are independent", async () => {
  const { deps, state } = registrationDeps();
  const controller = createRegistrationDecisionController(deps);

  await Promise.all([
    controller.approve(pendingRequest),
    controller.approve({ ...pendingRequest, id: "req-2" }),
  ]);

  assert.equal(state.approveCalls.length, 2);
  assert.equal(state.refreshCount, 2);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

test("teardown restores console.error", () => {
  console.error = originalConsoleError;
  assert.equal(console.error, originalConsoleError);
});
