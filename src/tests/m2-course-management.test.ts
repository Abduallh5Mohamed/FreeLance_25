/**
 * M2-02 course management — isolated production-path tests (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/catalog/course-management.ts`
 * that src/pages/Courses.tsx delegates to, imported unchanged. Every test
 * drives the same controller the page creates, with injected fake transports,
 * principal reader and session notifier. Fully isolated: no DB, no network,
 * no browser, no live services, no real localStorage, no dependency install.
 *
 * Behaviours pinned (M2-02 acceptance):
 *  - duplicate create/update/archive suppression (synchronous latch, before
 *    the first await — React state cannot do this);
 *  - stale / reversed / post-dispose / post-session-change replies never
 *    commit, and a superseded operation never clears a NEWER operation's busy
 *    marker (old-finally vs newer busy);
 *  - the form and the editing target survive a failed write, and a retry
 *    sends exactly one more request;
 *  - a failed refresh AFTER a server-confirmed write is reported separately
 *    and never re-opens the form (no duplicate creation);
 *  - a failed archive keeps its target instead of clearing it in `finally`;
 *  - grade name↔id mapping: an edit of a course whose `grade` is stored as a
 *    NAME writes the name back, and an unavailable legacy grade is preserved
 *    instead of being silently nulled;
 *  - strict numeric parsing: malformed / NaN / Infinity / partial reads are
 *    refused instead of being coerced to 0;
 *  - distinct loading / empty / error list states.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live
 * services, and end-to-end authorization (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Course, Grade, Subscription } from "../lib/api";
import {
  COURSE_NOT_FOUND_MESSAGE,
  COURSE_PUBLISHED_MESSAGE,
  COURSE_PUBLICATION_UNCHANGED_MESSAGE,
  COURSE_PUBLICATION_UNEXPECTED_MESSAGE,
  COURSE_UNPUBLISHED_MESSAGE,
  buildCoursePrincipal,
  createCourseManagementController,
  parseCoursePrice,
  readCourseSessionPrincipal,
  resetCourseSessionLifetime,
  resolveCourseGrade,
  toGradeFieldValue,
  validateCourseForm,
  type CourseFormValues,
  type CourseManagementApi,
  type CourseSessionStorage,
  type CourseWritePayload,
} from "../features/catalog/course-management";

/** The page's storage surface, injected: no DOM, no browser, no live app. */
const storageOf = (entries: Record<string, string | null>): CourseSessionStorage => ({
  getItem: (key) => (key in entries ? entries[key] : null),
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** Drains the microtask/macrotask queue once. Used where one operation is
 *  deliberately held open: `waitForIdle()` would wait for it too. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const courseRow = (overrides: Partial<Course> = {}): Course => ({
  id: "c1",
  name: "التاريخ",
  subject: "التاريخ",
  description: "وصف",
  grade: "الصف الأول",
  is_active: true,
  price: 100,
  ...overrides,
});

const gradeRow = (overrides: Partial<Grade> = {}): Grade => ({
  id: "g1",
  name: "الصف الأول",
  display_order: 1,
  is_active: true,
  ...overrides,
});

const form = (overrides: Partial<CourseFormValues> = {}): CourseFormValues => ({
  name: "تاريخ جديد",
  description: "وصف",
  subject: "التاريخ",
  grade_id: "g1",
  subscription_id: "",
  price: "150",
  ...overrides,
});

interface Harness {
  controller: ReturnType<typeof createCourseManagementController>;
  api: CourseManagementApi;
  state: {
    rows: Course[];
    grades: Grade[];
    subscriptions: Subscription[];
    principal: string | null;
    loadCalls: number;
    createCalls: CourseWritePayload[];
    updateCalls: Array<{ id: string; payload: CourseWritePayload }>;
    archiveCalls: string[];
    courseGates: Array<Deferred<Course[]>>;
    writeGates: Array<Deferred<void>>;
    courseImpl: null | (() => Promise<Course[]>);
    failCoursesWith: unknown;
    failGradesWith: unknown;
    failWriteWith: unknown;
    failArchiveWith: unknown;
    sessionListeners: Set<() => void>;
    /** M2-22 publication: the requested ids, in order, for each action. */
    publishCalls: string[];
    unpublishCalls: string[];
    /** What each publication call answers, or throws. */
    publicationImpl: (id: string, state: "draft" | "published") => Promise<unknown>;
  };
  fireSessionChange: () => void;
}
function setup(overrides: {
  rows?: Course[];
  grades?: Grade[];
  subscriptions?: Subscription[];
  /** Set to false to model a deployment that does not wire publication. */
  withPublication?: boolean;
} = {}): Harness {
  const state = {
    rows: overrides.rows ?? [courseRow()],
    grades: overrides.grades ?? [gradeRow()],
    subscriptions: overrides.subscriptions ?? [],
    principal: "tenant-a" as string | null,
    loadCalls: 0,
    createCalls: [] as CourseWritePayload[],
    updateCalls: [] as Array<{ id: string; payload: CourseWritePayload }>,
    archiveCalls: [] as string[],
    courseGates: [] as Array<Deferred<Course[]>>,
    writeGates: [] as Array<Deferred<void>>,
    courseImpl: null as null | (() => Promise<Course[]>),
    failCoursesWith: null as unknown,
    failGradesWith: null as unknown,
    failWriteWith: null as unknown,
    failArchiveWith: null as unknown,
    sessionListeners: new Set<() => void>(),
    publishCalls: [] as string[],
    unpublishCalls: [] as string[],
    publicationImpl: async (id: string, publicationState: "draft" | "published") => ({
      course_id: id,
      publication_state: publicationState,
      published_at: publicationState === "published" ? "2026-10-23T10:00:00.000Z" : null,
    }),
  };

  const takeCourseGate = async (): Promise<Course[]> => {
    if (state.courseImpl) return state.courseImpl();
    const gate = state.courseGates.shift();
    if (gate) return gate.promise;
    if (state.failCoursesWith) throw state.failCoursesWith;
    return state.rows;
  };
  const takeWriteGate = async (): Promise<void> => {
    const gate = state.writeGates.shift();
    if (gate) await gate.promise;
  };

  const api: CourseManagementApi = {
    loadCourses: async () => {
      state.loadCalls += 1;
      return takeCourseGate();
    },
    loadGrades: async () => {
      if (state.failGradesWith) throw state.failGradesWith;
      return state.grades;
    },
    loadSubscriptions: async () => state.subscriptions,
    createCourse: async (payload) => {
      state.createCalls.push(payload);
      await takeWriteGate();
      if (state.failWriteWith) throw state.failWriteWith;
      return "created-id";
    },
    updateCourse: async (id, payload) => {
      state.updateCalls.push({ id, payload });
      await takeWriteGate();
      if (state.failWriteWith) throw state.failWriteWith;
    },
    archiveCourse: async (id) => {
      state.archiveCalls.push(id);
      await takeWriteGate();
      if (state.failArchiveWith) throw state.failArchiveWith;
    },
    readPrincipal: () => state.principal,
    subscribeSession: (listener) => {
      state.sessionListeners.add(listener);
      return () => state.sessionListeners.delete(listener);
    },
    ...(overrides.withPublication === false
      ? {}
      : {
          publishCourse: async (id: string) => {
            state.publishCalls.push(id);
            await takeWriteGate();
            return state.publicationImpl(id, "published");
          },
          unpublishCourse: async (id: string) => {
            state.unpublishCalls.push(id);
            await takeWriteGate();
            return state.publicationImpl(id, "draft");
          },
        }),
  };

  return {
    controller: createCourseManagementController(api),
    api,
    state,
    fireSessionChange: () => {
      for (const listener of [...state.sessionListeners]) listener();
    },
  };
}

// ---------------------------------------------------------------------------
// Numeric parsing contract
// ---------------------------------------------------------------------------

test("price: a valid integer and a valid decimal are accepted", () => {
  assert.deepEqual(parseCoursePrice("150"), { ok: true, value: 150 });
  assert.deepEqual(parseCoursePrice("150.5"), { ok: true, value: 150.5 });
  assert.deepEqual(parseCoursePrice(" .5 "), { ok: true, value: 0.5 });
});

test("price: no price entered keeps the existing behaviour (0), it is not an error", () => {
  assert.deepEqual(parseCoursePrice(""), { ok: true, value: 0 });
  assert.deepEqual(parseCoursePrice("   "), { ok: true, value: 0 });
  assert.deepEqual(parseCoursePrice(null), { ok: true, value: 0 });
});

test("price: partial reads, NaN, Infinity, scientific notation and negatives are refused", () => {
  // parseFloat('12abc') === 12 is exactly the silent partial read refused here.
  assert.deepEqual(parseCoursePrice("12abc"), { ok: false, reason: "malformed" });
  assert.deepEqual(parseCoursePrice("NaN"), { ok: false, reason: "malformed" });
  assert.deepEqual(parseCoursePrice("Infinity"), { ok: false, reason: "malformed" });
  assert.deepEqual(parseCoursePrice("1e3"), { ok: false, reason: "malformed" });
  assert.deepEqual(parseCoursePrice("١٢"), { ok: false, reason: "malformed" });
  assert.deepEqual(parseCoursePrice("-5"), { ok: false, reason: "negative" });
  assert.deepEqual(parseCoursePrice(Number.NaN), { ok: false, reason: "nonfinite" });
  assert.deepEqual(parseCoursePrice(Number.POSITIVE_INFINITY), { ok: false, reason: "nonfinite" });
});

test("form: a malformed price is a field error and never reaches the transport", async () => {
  const h = setup();
  const outcome = await h.controller.submit(form({ price: "12abc" }), null);
  assert.equal(outcome, "invalid");
  assert.equal(h.state.createCalls.length, 0);
  assert.ok(h.controller.getState().fieldErrors.price);
});

test("form: an empty name or subject is a field error and never reaches the transport", async () => {
  const h = setup();
  assert.equal(await h.controller.submit(form({ name: "   " }), null), "invalid");
  assert.equal(await h.controller.submit(form({ subject: "" }), null), "invalid");
  assert.equal(h.state.createCalls.length, 0);
  assert.equal(h.state.updateCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Grade name ↔ id mapping
// ---------------------------------------------------------------------------

test("grade: a selected grade id is written as the stored NAME", () => {
  const grades = [gradeRow({ id: "g1", name: "الصف الأول" })];
  assert.deepEqual(resolveCourseGrade("g1", grades), {
    grade: "الصف الأول",
    available: true,
    preserved: false,
  });
});

test("grade: a legacy NAME held in the grade field still resolves (the old id/name mismatch)", () => {
  const grades = [gradeRow({ id: "g1", name: "الصف الأول" })];
  const resolved = resolveCourseGrade("الصف الأول", grades);
  assert.equal(resolved.grade, "الصف الأول");
  assert.equal(resolved.available, true);
});

test("grade: an unavailable legacy grade is preserved, never silently nulled", () => {
  const grades = [gradeRow({ id: "g1", name: "الصف الأول" })];
  const resolved = resolveCourseGrade("صف قديم", grades, "صف قديم");
  assert.equal(resolved.grade, "صف قديم");
  assert.equal(resolved.available, false);
  assert.equal(resolved.preserved, true);
});

test("grade: an empty selection writes null; a stored name maps back to its id", () => {
  const grades = [gradeRow({ id: "g1", name: "الصف الأول" })];
  assert.equal(resolveCourseGrade("", grades).grade, null);
  assert.equal(toGradeFieldValue("الصف الأول", grades), "g1");
  assert.equal(toGradeFieldValue("g1", grades), "g1");
  assert.equal(toGradeFieldValue("صف قديم", grades), "صف قديم");
});

test("grade: editing a course whose grade is a NAME writes that name back, not null", async () => {
  const h = setup({ grades: [gradeRow({ id: "g1", name: "الصف الأول" })] });
  await h.controller.loadOptions();
  const course = courseRow({ id: "c9", grade: "الصف الأول" });
  // What the page does on edit: map the stored name back to a field value.
  const gradeField = toGradeFieldValue(course.grade, h.controller.getState().grades);
  const outcome = await h.controller.submit(form({ grade_id: gradeField }), course);
  assert.equal(outcome, "updated");
  assert.equal(h.state.updateCalls[0].payload.grade, "الصف الأول");
});

test("grade: updating an unrelated field preserves a grade that is no longer active", async () => {
  const h = setup({ grades: [gradeRow({ id: "g1", name: "الصف الأول" })] });
  await h.controller.loadOptions();
  const course = courseRow({ id: "c9", grade: "صف محذوف" });
  const gradeField = toGradeFieldValue(course.grade, h.controller.getState().grades);
  const outcome = await h.controller.submit(form({ grade_id: gradeField, name: "اسم جديد" }), course);
  assert.equal(outcome, "updated");
  assert.equal(h.state.updateCalls[0].payload.grade, "صف محذوف");
  // The page is told the value was kept, so nothing is hidden from the user.
  assert.equal(h.controller.getState().gradeNotice, "صف محذوف");
});

// ---------------------------------------------------------------------------
// List states
// ---------------------------------------------------------------------------

test("list: a successful load publishes only active courses", async () => {
  const h = setup({
    rows: [courseRow({ id: "c1" }), courseRow({ id: "c2", name: "مؤرشف", is_active: false })],
  });
  await h.controller.load();
  const state = h.controller.getState();
  assert.equal(state.phase, "ready");
  assert.deepEqual(state.courses.map((c) => c.id), ["c1"]);
  assert.equal(state.listError, null);
});

test("mount: the list load and the options read started together both commit", async () => {
  // Regression: sharing one generation sequence between them made the options
  // read invalidate the list load the page starts at the same moment, so the
  // list never left `loading` on a real mount.
  const h = setup({ rows: [courseRow({ id: "c1" })], grades: [gradeRow({ id: "g1" })] });
  await Promise.all([h.controller.load(), h.controller.loadOptions()]);
  const state = h.controller.getState();
  assert.equal(state.phase, "ready");
  assert.deepEqual(state.courses.map((c) => c.id), ["c1"]);
  assert.deepEqual(state.grades, [{ id: "g1", name: "الصف الأول" }]);
});

test("list: an empty result is its own state, never a silent ready list", async () => {
  const h = setup({ rows: [] });
  await h.controller.load();
  assert.equal(h.controller.getState().phase, "empty");
});

test("list: a failed load is an error state with the server message, no rows", async () => {
  const h = setup();
  h.state.failCoursesWith = new Error("Failed to fetch courses");
  await h.controller.load();
  const state = h.controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.listError, "Failed to fetch courses");
  assert.deepEqual(state.courses, []);
});

test("list: a malformed body is an error, never an empty list", async () => {
  const h = setup();
  h.state.rows = null as unknown as Course[];
  await h.controller.load();
  assert.equal(h.controller.getState().phase, "error");
});

test("list: a concurrent duplicate load sends exactly one request", async () => {
  const h = setup();
  const gate = deferred<Course[]>();
  h.state.courseGates.push(gate);
  const first = h.controller.load();
  const second = h.controller.load();
  gate.resolve([courseRow()]);
  await Promise.all([first, second]);
  assert.equal(h.state.loadCalls, 1);
});

test("list: a stale load that resolves after a newer load never commits", async () => {
  const h = setup();
  let calls = 0;
  const gate = deferred<Course[]>();
  // Only the FIRST load is held: the load started by the session change below
  // must resolve normally on its own.
  h.state.courseImpl = async () => {
    calls += 1;
    return calls === 1 ? gate.promise : h.state.rows;
  };
  const stale = h.controller.load();
  // A session change retires the in-flight load and starts a fresh one.
  h.state.rows = [courseRow({ id: "new", name: "كورس المستأجر الجديد" })];
  h.fireSessionChange();
  await flush(); // the stale load is still held open on purpose
  assert.deepEqual(h.controller.getState().courses.map((c) => c.id), ["new"]);
  // The retired reply of the previous principal lands late: it is discarded.
  gate.resolve([courseRow({ id: "old", name: "كورس المستأجر القديم" })]);
  await stale;
  await flush();
  assert.deepEqual(h.controller.getState().courses.map((c) => c.id), ["new"]);
});

test("list: nothing commits after dispose", async () => {
  const h = setup();
  const gate = deferred<Course[]>();
  h.state.courseGates.push(gate);
  const pending = h.controller.load();
  h.controller.dispose();
  gate.resolve([courseRow()]);
  await pending;
  const state = h.controller.getState();
  assert.deepEqual(state.courses, []);
  assert.equal(state.phase, "loading");
});

test("list: a failed options load is reported without blanking the course list", async () => {
  const h = setup();
  await h.controller.load();
  h.state.failGradesWith = new Error("Failed to fetch grades");
  await h.controller.loadOptions();
  const state = h.controller.getState();
  assert.ok(state.optionsError);
  assert.deepEqual(state.grades, []);
  assert.equal(state.phase, "ready");
});

// ---------------------------------------------------------------------------
// Duplicate suppression and write lifecycle
// ---------------------------------------------------------------------------

test("write: a second submit before the first settles never reaches the transport", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.submit(form(), null);
  const second = h.controller.submit(form(), null);
  assert.equal(await second, "duplicate");
  gate.resolve();
  assert.equal(await first, "created");
  await h.controller.waitForIdle();
  assert.equal(h.state.createCalls.length, 1);
});

test("write: create sends the mapped payload and refreshes the list", async () => {
  const h = setup();
  // The page loads the list and the options together on mount.
  await Promise.all([h.controller.load(), h.controller.loadOptions()]);
  h.state.rows = [courseRow({ id: "c1" }), courseRow({ id: "c2", name: "جديد" })];
  const outcome = await h.controller.submit(form({ price: "150.5" }), null);
  assert.equal(outcome, "created");
  assert.deepEqual(h.state.createCalls[0], {
    name: "تاريخ جديد",
    description: "وصف",
    subject: "التاريخ",
    grade: "الصف الأول",
    price: 150.5,
    is_active: true,
  });
  await h.controller.waitForIdle();
  assert.equal(h.controller.getState().courses.length, 2);
  assert.equal(h.controller.getState().savedCourseId, "created-id");
});

test("write: an empty price is still sent as 0 (existing behaviour, unchanged)", async () => {
  const h = setup();
  await h.controller.submit(form({ price: "" }), null);
  assert.equal(h.state.createCalls[0].price, 0);
});

test("write: a failed create keeps the form, and one retry sends exactly one more request", async () => {
  const h = setup();
  h.state.failWriteWith = new Error("Failed to create course");
  const first = await h.controller.submit(form(), null);
  assert.equal(first, "failed");
  assert.equal(h.controller.getState().mutationError, "Failed to create course");
  assert.equal(h.controller.getState().busyKind, null);
  h.state.failWriteWith = null;
  const second = await h.controller.submit(form(), null);
  assert.equal(second, "created");
  assert.equal(h.state.createCalls.length, 2);
});

test("write: a server-confirmed create with a failed refresh is reported separately, never duplicated", async () => {
  const h = setup();
  await h.controller.load();
  const before = h.controller.getState().courses.length;
  const outcome = h.controller.submit(form(), null);
  // The refresh that follows the confirmed write fails.
  h.state.failCoursesWith = new Error("Failed to fetch courses");
  assert.equal(await outcome, "created");
  await h.controller.waitForIdle();
  const state = h.controller.getState();
  assert.equal(state.refreshError, "Failed to fetch courses");
  assert.equal(state.phase, "ready"); // the confirmed list is kept, never wiped
  assert.equal(state.courses.length, before);
  assert.equal(state.mutationError, null);
  // No second write: the form is not re-opened and nothing is re-created.
  assert.equal(h.state.createCalls.length, 1);
});

test("write: a reply that lands after the principal changed is discarded, and busy is released", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  assert.equal(h.controller.getState().busyKind, "create");
  h.state.principal = "tenant-b";
  h.fireSessionChange();
  gate.resolve();
  assert.equal(await pending, "blocked");
  await h.controller.waitForIdle();
  assert.equal(h.controller.getState().busyKind, null);
  assert.equal(h.state.createCalls.length, 1);
});

test("write: nothing commits after dispose", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  h.controller.dispose();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().savedCourseId, null);
});

test("write: a superseded operation never clears a newer operation's busy marker", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const stale = h.controller.submit(form(), null);
  // Retire the stale write (session change) and start a NEWER one.
  h.fireSessionChange();
  await flush(); // the stale write is still held open on purpose
  const target = courseRow({ id: "c1" });
  const newerGate = deferred<void>();
  h.state.writeGates.push(newerGate);
  const newer = h.controller.submit(form(), target);
  assert.equal(h.controller.getState().busyKind, "update");
  // The old operation settles late: it must not touch the newer marker.
  gate.resolve();
  await stale;
  assert.equal(h.controller.getState().busyKind, "update");
  newerGate.resolve();
  assert.equal(await newer, "updated");
});

// ---------------------------------------------------------------------------
// Archive (delete) lifecycle
// ---------------------------------------------------------------------------

test("archive: a confirmed archive clears its target and refreshes", async () => {
  const h = setup();
  await h.controller.load();
  const course = courseRow({ id: "c1" });
  h.controller.requestArchive(course);
  assert.equal(h.controller.getState().deleteTarget?.id, "c1");
  assert.equal(await h.controller.confirmArchive(), "archived");
  assert.equal(h.controller.getState().deleteTarget, null);
  assert.deepEqual(h.state.archiveCalls, ["c1"]);
});

test("archive: a failed archive keeps its target and message (the old finally cleared both)", async () => {
  const h = setup();
  await h.controller.load();
  const course = courseRow({ id: "c1" });
  h.controller.requestArchive(course);
  h.state.failArchiveWith = new Error("Failed to delete course");
  assert.equal(await h.controller.confirmArchive(), "failed");
  const state = h.controller.getState();
  assert.equal(state.deleteTarget?.id, "c1");
  assert.equal(state.archiveError, "Failed to delete course");
  // Retry the SAME target without re-selecting it.
  h.state.failArchiveWith = null;
  assert.equal(await h.controller.confirmArchive(), "archived");
  assert.deepEqual(h.state.archiveCalls, ["c1", "c1"]);
});

test("archive: a duplicate confirm sends one request and cancel releases the target", async () => {
  const h = setup();
  await h.controller.load();
  h.controller.requestArchive(courseRow({ id: "c1" }));
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.confirmArchive();
  assert.equal(await h.controller.confirmArchive(), "duplicate");
  gate.resolve();
  assert.equal(await first, "archived");
  assert.equal(h.state.archiveCalls.length, 1);

  h.controller.requestArchive(courseRow({ id: "c2" }));
  h.controller.cancelArchive();
  assert.equal(h.controller.getState().deleteTarget, null);
});

test("archive: a reply that lands after dispose is discarded", async () => {
  const h = setup();
  h.controller.requestArchive(courseRow({ id: "c1" }));
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.confirmArchive();
  h.controller.dispose();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.state.archiveCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Delete-target incarnation (supervisor/061 finding 1)
// ---------------------------------------------------------------------------

test("archive: a pending A cannot clear a newer target B when it succeeds", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  h.controller.requestArchive(courseRow({ id: "fixture-A" }));
  const pending = h.controller.confirmArchive();
  // The dialog is closed and a DIFFERENT course is selected while A is
  // still on the wire.
  h.controller.cancelArchive();
  h.controller.requestArchive(courseRow({ id: "fixture-B" }));
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().deleteTarget?.id, "fixture-B");
  assert.equal(h.controller.getState().archiveError, null);
});

test("archive: a pending A cannot write its failure onto a newer target B", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  h.controller.requestArchive(courseRow({ id: "fixture-A" }));
  const pending = h.controller.confirmArchive();
  h.controller.cancelArchive();
  h.controller.requestArchive(courseRow({ id: "fixture-B" }));
  h.state.failArchiveWith = new Error("fixture A failure");
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().deleteTarget?.id, "fixture-B");
  assert.equal(h.controller.getState().archiveError, null);
});

test("archive: A→B→A — the reopened A archives, the retired A commits nothing", async () => {
  const h = setup();
  await h.controller.load();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  h.controller.requestArchive(courseRow({ id: "a" }));
  const stale = h.controller.confirmArchive();
  h.controller.cancelArchive();
  h.controller.requestArchive(courseRow({ id: "b" }));
  // Back to A: a new incarnation, so this one is allowed to commit.
  h.controller.requestArchive(courseRow({ id: "a" }));
  gate.resolve();
  assert.equal(await stale, "blocked");
  assert.equal(h.controller.getState().deleteTarget?.id, "a");
  assert.equal(await h.controller.confirmArchive(), "archived");
  assert.deepEqual(h.state.archiveCalls, ["a", "a"]);
  assert.equal(h.controller.getState().deleteTarget, null);
});

test("archive: cancelling while the request is in flight retires that archive", async () => {
  const h = setup();
  await h.controller.load();
  h.controller.requestArchive(courseRow({ id: "c1" }));
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.confirmArchive();
  // The user dismisses the dialog before the server answers.
  h.controller.cancelArchive();
  gate.resolve();
  assert.equal(await pending, "blocked");
  const state = h.controller.getState();
  assert.equal(state.deleteTarget, null);
  assert.equal(state.archiveError, null);
  assert.equal(state.busyKind, null);
});

test("archive: a session change retires the pending archive and its target", async () => {
  const h = setup();
  await h.controller.load();
  h.controller.requestArchive(courseRow({ id: "c1" }));
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.confirmArchive();
  h.state.principal = "tenant-b";
  h.fireSessionChange();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().deleteTarget, null);
});

// ---------------------------------------------------------------------------
// Form/dialog incarnation (supervisor/061 finding 3)
// ---------------------------------------------------------------------------

test("form: a newer dialog survives a late success of the older save", async () => {
  const h = setup();
  await Promise.all([h.controller.load(), h.controller.loadOptions()]);
  const firstInstance = h.controller.openForm(null);
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const stale = h.controller.submit(form(), null, firstInstance);
  // While the create is pending the user opens another dialog.
  const secondInstance = h.controller.openForm(courseRow({ id: "c1" }));
  assert.notEqual(secondInstance, firstInstance);
  gate.resolve();
  // The older save is refused: it must not close or reset the newer dialog.
  assert.equal(await stale, "blocked");
  assert.equal(h.controller.isFormCurrent(secondInstance), true);
  assert.equal(h.controller.isFormCurrent(firstInstance), false);
  assert.equal(h.controller.getState().savedCourseId, null);
  // The newer dialog can still save normally.
  assert.equal(await h.controller.submit(form(), courseRow({ id: "c1" }), secondInstance), "updated");
});

test("form: a late failure of the older save never toasts over the newer dialog", async () => {
  const h = setup();
  const firstInstance = h.controller.openForm(null);
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const stale = h.controller.submit(form(), null, firstInstance);
  const secondInstance = h.controller.openForm(null);
  h.state.failWriteWith = new Error("older save failed");
  gate.resolve();
  assert.equal(await stale, "blocked");
  assert.equal(h.controller.getState().mutationError, null);
  assert.equal(h.controller.isFormCurrent(secondInstance), true);
  // A retry inside the NEWER dialog is unaffected and can still fail honestly.
  assert.equal(await h.controller.submit(form(), null, secondInstance), "failed");
  assert.equal(h.controller.getState().mutationError, "older save failed");
});

test("form: closing the dialog retires the save it started", async () => {
  const h = setup();
  const instance = h.controller.openForm(null);
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null, instance);
  h.controller.closeForm();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().savedCourseId, null);
  // A save started after the close never even leaves the page.
  assert.equal(await h.controller.submit(form(), null, instance), "blocked");
  assert.equal(h.state.createCalls.length, 1);
});

test("form: a session change retires the open form and the pending save", async () => {
  const h = setup();
  const instance = h.controller.openForm(courseRow({ id: "c1" }));
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), courseRow({ id: "c1" }), instance);
  h.state.principal = "tenant-b";
  h.fireSessionChange();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.isFormCurrent(instance), false);
  assert.equal(h.controller.getState().mutationError, null);
});

// ---------------------------------------------------------------------------
// Canonical session principal (supervisor/061 → 064 → 065)
//
// 064 replaced a 32-bit djb2 digest (which collided for distinct tokens) with
// EXACT equality of the whole canonical session. But it kept a module-wide
// REGISTRY that mapped each historical identity back to the SAME incarnation
// id, so an observed A → B → A (without a session-bus notification) restored
// the original A incarnation and a write started under the first A accepted
// completion after observing B then returning to A.
//
// 065 removes the registry: the reader holds ONLY the latest canonical value
// and a monotonic generation. ANY observed transition — including a silent
// return to a previously seen token and including logout/null — advances the
// incarnation. Consecutive unchanged reads are stable. `buildCoursePrincipal`
// is now a test-only canonicalizer where each call yields a fresh incarnation
// (two builds of the same session are NOT equal — that is the point); stability
// is proven through the REAL reader `readCourseSessionPrincipal` on the same
// storage surface.
// ---------------------------------------------------------------------------

test("principal: a token rotation with the same id and role changes the principal", () => {
  const identity = { id: "u1", role: "teacher" };
  const before = buildCoursePrincipal({ ...identity, token: "token-one" });
  const after = buildCoursePrincipal({ ...identity, token: "token-two" });
  assert.notEqual(before, after);
});

test("principal: a silent re-login of the same account is not treated as the same session", () => {
  // Same user, same role, no token at all (logged out) — must not match.
  const signedIn = buildCoursePrincipal({ id: "u1", role: "teacher", token: "t" });
  const loggedOut = buildCoursePrincipal({ id: undefined, role: undefined, token: null });
  assert.equal(loggedOut, null);
  assert.notEqual(signedIn, loggedOut);
});

test("principal: the raw token never appears in the comparison key", () => {
  const key = buildCoursePrincipal({ id: "u1", role: "teacher", token: "super-secret-token" });
  assert.ok(key);
  assert.equal(key.includes("super-secret-token"), false);
});

test("principal: the same canonical session produces the same key (065 stability)", () => {
  // `buildCoursePrincipal` is a test-only canonicalizer backed by a registry:
  // two calls with the SAME canonical identity produce the SAME key.
  // The 065 defect was in the REAL reader (`readCourseSessionPrincipal`),
  // not here — the reader observed transitions through the same registry
  // and restored historical identities. The reader now uses its own
  // module-level lifetime (no registry) so observed transitions always
  // advance, while the builder keeps stability for tests that set
  // `state.principal` directly.
  const a = buildCoursePrincipal({ id: "u1", role: "teacher", billingOnly: true, token: "t" });
  const b = buildCoursePrincipal({ id: "u1", role: "teacher", billingOnly: true, token: "t" });
  assert.equal(a, b, "same canonical session must produce the same key from the builder");
});

// ---------------------------------------------------------------------------
// Exact canonical session fence (supervisor/064 → 065)
//
// The previous boundary compared a 32-bit djb2 digest of the token. djb2
// multiplies by 33, so 33*'A' + 'b' === 33*'B' + 'A' === 2243: the two
// genuinely distinct sessions below produced the SAME key, and a write started
// under the first accepted a late completion under the second. The fence is now
// EXACT equality of the whole canonical session, inside a per-reader closure;
// the page and the controller only ever exchange an opaque `session:<n>` id,
// so the token never appears in React state, a message, a log or a test.
// ---------------------------------------------------------------------------

const COLLIDING_A = "fixture-Ab-session";
const COLLIDING_B = "fixture-BA-session";

test("principal: the two fixture tokens that collide under djb2 stay distinct sessions", () => {
  const first = buildCoursePrincipal({ id: "fixture-user", role: "instructor", token: COLLIDING_A });
  const second = buildCoursePrincipal({ id: "fixture-user", role: "instructor", token: COLLIDING_B });
  assert.ok(first && second);
  assert.notEqual(first, second, "a lossy fingerprint must not be the session boundary");
});

test("principal: the comparison key is opaque and carries no session material", () => {
  const key = buildCoursePrincipal({ id: "u1", role: "instructor", token: COLLIDING_A });
  assert.match(key ?? "", /^session:\d+$/);
  assert.equal(key?.includes("u1"), false);
  assert.equal(key?.includes("instructor"), false);
  assert.equal(key?.includes(COLLIDING_A), false);
});

test("principal: a user, role, billing or scope change is still its own session", () => {
  const base = { id: "u1", role: "instructor", token: "shared-token" };
  const baseKey = buildCoursePrincipal(base);
  assert.notEqual(buildCoursePrincipal({ ...base, id: "u2" }), baseKey);
  assert.notEqual(buildCoursePrincipal({ ...base, role: "student" }), baseKey);
  assert.notEqual(buildCoursePrincipal({ ...base, billingOnly: true }), baseKey);
  assert.notEqual(buildCoursePrincipal({ ...base, scope: "tenant-b" }), baseKey);
});

test("session fence: a pending write cannot commit under the colliding fixture session", async () => {
  const h = setup();
  const first = buildCoursePrincipal({ id: "fixture-user", role: "instructor", token: COLLIDING_A });
  const second = buildCoursePrincipal({ id: "fixture-user", role: "instructor", token: COLLIDING_B });
  h.state.principal = first;
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  // Same id, same role, a DIFFERENT canonical session while the write is on
  // the wire. The late completion must be refused.
  h.state.principal = second;
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().savedCourseId, null);
  assert.equal(h.state.createCalls.length, 1);
});

test("session fence: a silent re-login of the same account invalidates the pending write", async () => {
  const h = setup();
  const identity = { id: "u1", role: "instructor" };
  h.state.principal = buildCoursePrincipal({ ...identity, token: "old-token" });
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  h.state.principal = buildCoursePrincipal({ ...identity, token: "new-token" });
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().savedCourseId, null);
});

test("session fence: A -> B -> A — the write started under the first A is still foreign", async () => {
  const h = setup();
  const identity = { id: "u1", role: "instructor" };
  const keyA = buildCoursePrincipal({ ...identity, token: "token-A" });
  const keyB = buildCoursePrincipal({ ...identity, token: "token-B" });
  assert.notEqual(keyA, keyB);
  h.state.principal = keyA;
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  h.state.principal = keyB;
  h.fireSessionChange();
  await flush();
  // Back to the exact same canonical session: its key is stable again, but the
  // operations the page started under the first A were retired on the way out.
  h.state.principal = keyA;
  h.fireSessionChange();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().savedCourseId, null);
  assert.equal(h.state.createCalls.length, 1);
});

test("session fence: the write that belongs to the CURRENT session still commits", async () => {
  // Control for the three fences above: exact equality must not become a
  // blanket refusal — an unchanged session still saves normally. The principal
  // is set ONCE and not reassigned: the session has not changed, so the write
  // commits. (Reassigning with a fresh `buildCoursePrincipal` call would be a
  // new observation = a new incarnation under the 065 contract.)
  const h = setup();
  const stable = buildCoursePrincipal({ id: "u1", role: "instructor", token: "stable-token" });
  h.state.principal = stable;
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  // The session is unchanged — do NOT reassign state.principal.
  gate.resolve();
  assert.equal(await pending, "created");
  assert.equal(h.controller.getState().savedCourseId, "created-id");
});

test("session reader: the page's real reader scopes on the canonical token, not on id:role", () => {
  resetCourseSessionLifetime();
  const profile = JSON.stringify({ id: "u1", role: "instructor" });
  // The module-level lifetime tracks the LATEST canonical session. Two reads
  // with DIFFERENT tokens produce distinct principals.
  const storageA = storageOf({ currentUser: profile, authToken: COLLIDING_A });
  const storageB = storageOf({ currentUser: profile, authToken: COLLIDING_B });
  const withA = readCourseSessionPrincipal(storageA);
  const withB = readCourseSessionPrincipal(storageB);
  assert.ok(withA && withB);
  assert.notEqual(withA, withB);
  assert.equal(withA.includes(COLLIDING_A), false);
  // Stability: consecutive reads of the SAME storage with UNCHANGED content
  // return the same incarnation. Switching between A and B and back is a
  // NEW incarnation (065 contract), so we test stability on one storage only.
  assert.equal(readCourseSessionPrincipal(storageB), withB);
});

test("session reader: logged out is null, and an unreadable profile never matches a signed-in one", () => {
  resetCourseSessionLifetime();
  const profile = JSON.stringify({ id: "u1", role: "instructor" });
  assert.equal(readCourseSessionPrincipal(storageOf({})), null);
  assert.equal(readCourseSessionPrincipal(storageOf({ currentUser: null, authToken: null })), null);
  // A token alone is still a session (the profile may simply be unreadable).
  const tokenOnly = readCourseSessionPrincipal(storageOf({ authToken: "t" }));
  assert.ok(tokenOnly);
  // A different canonical (profile + same token) observed through the reader
  // is a distinct incarnation.
  const withProfile = readCourseSessionPrincipal(storageOf({ currentUser: profile, authToken: "t" }));
  assert.ok(withProfile);
  assert.notEqual(withProfile, tokenOnly);
  // A broken profile with the same token: the token still scopes the session.
  const broken = readCourseSessionPrincipal(storageOf({ currentUser: "{not json", authToken: "t" }));
  assert.ok(broken);
  assert.notEqual(broken, withProfile);
});

test("validation: validateCourseForm reports every field it refuses", () => {
  const result = validateCourseForm({ name: "", subject: "", description: "", grade_id: "", subscription_id: "", price: "-1" });
  assert.equal(result.ok, false);
  assert.ok(result.fieldErrors.name);
  assert.ok(result.fieldErrors.subject);
  assert.ok(result.fieldErrors.price);
});

// ---------------------------------------------------------------------------
// Observed session lifetime (supervisor/065)
//
// The 064 correction kept a module-wide REGISTRY that mapped each historical
// identity back to the SAME incarnation id. So an observed A → B → A (without a
// session-bus notification) restored the original A incarnation, and a write
// started under the first A accepted completion after the controller silently
// observed B then returned to A. The 065 contract: ANY observed canonical
// identity transition — including a silent return to a previously seen token,
// and including logout/null — advances the incarnation. These tests inject the
// REAL production reader into the REAL controller through a mutable storage.
// ---------------------------------------------------------------------------

test("observed lifetime: consecutive reads of an unchanged session are stable", () => {
  resetCourseSessionLifetime();
  const profile = JSON.stringify({ id: "u1", role: "instructor" });
  const storage = storageOf({ currentUser: profile, authToken: "stable-token" });
  const first = readCourseSessionPrincipal(storage);
  const second = readCourseSessionPrincipal(storage);
  assert.ok(first);
  assert.equal(first, second, "consecutive unchanged reads must be stable");
});

test("observed lifetime: a token rotation observed through the reader advances incarnation", () => {
  resetCourseSessionLifetime();
  let token = "token-one";
  const storage: CourseSessionStorage = {
    getItem: (key) => (key === "authToken" ? token : key === "currentUser" ? JSON.stringify({ id: "u1", role: "instructor" }) : null),
  };
  const first = readCourseSessionPrincipal(storage);
  assert.ok(first);
  token = "token-two";
  const after = readCourseSessionPrincipal(storage);
  assert.notEqual(after, first);
  assert.equal(readCourseSessionPrincipal(storage), after, "stable after the rotation");
});

test("observed lifetime: A → B → A through the reader gives three distinct incarnations", () => {
  resetCourseSessionLifetime();
  let token = "token-A";
  const storage: CourseSessionStorage = {
    getItem: (key) => key === "authToken" ? token : key === "currentUser" ? JSON.stringify({ id: "u1", role: "instructor" }) : null,
  };
  const a1 = readCourseSessionPrincipal(storage);
  assert.ok(a1);
  token = "token-B";
  const b = readCourseSessionPrincipal(storage);
  assert.notEqual(b, a1);
  // Return to token-A: under the OLD registry this restored the same key.
  // Under the 065 contract it is a NEW incarnation.
  token = "token-A";
  const a2 = readCourseSessionPrincipal(storage);
  assert.notEqual(a2, a1, "returning to A after observing B is a new incarnation, not the original");
  assert.notEqual(a2, b);
});

test("observed lifetime: A → null → A gives three distinct incarnations", () => {
  resetCourseSessionLifetime();
  // "null" here means the entire storage is cleared (both profile and token),
  // which is the actual logged-out state. Having a profile but no token is
  // still a session in the canonicalizer (the profile parts are non-null).
  let token: string | null = "token-A";
  let profile: string | null = JSON.stringify({ id: "u1", role: "instructor" });
  const storage: CourseSessionStorage = {
    getItem: (key) => key === "authToken" ? token : key === "currentUser" ? profile : null,
  };
  const a1 = readCourseSessionPrincipal(storage);
  assert.ok(a1);
  // Logout: clear both token and profile.
  token = null;
  profile = null;
  const loggedOut = readCourseSessionPrincipal(storage);
  assert.equal(loggedOut, null);
  // Re-login with the same token: new incarnation.
  token = "token-A";
  profile = JSON.stringify({ id: "u1", role: "instructor" });
  const a2 = readCourseSessionPrincipal(storage);
  assert.ok(a2);
  assert.notEqual(a2, a1, "returning to A after logout is a new incarnation");
});

test("observed lifetime: a pending save started under first A is blocked after observing B then returning to A", async () => {
  // This is the EXACT supervisor/065 reproduction: inject the REAL production
  // reader into the REAL controller. Start a deferred save in A; switch storage
  // silently to B; run loadOptions which observes B through the same reader;
  // return storage to A; resolve the first save. Must be BLOCKED.
  resetCourseSessionLifetime();
  let token = "token-A";
  const storage: CourseSessionStorage = {
    getItem: (key) => key === "authToken" ? token : key === "currentUser" ? JSON.stringify({ id: "u1", role: "instructor" }) : null,
  };
  const h = setup();
  h.api.readPrincipal = () => readCourseSessionPrincipal(storage);
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  // Silently observe B through a real production operation.
  token = "token-B";
  await h.controller.loadOptions();
  // Return to A.
  token = "token-A";
  gate.resolve();
  assert.equal(await pending, "blocked", "returning to A after observing B is a new lifetime, not the original operation");
  assert.equal(h.controller.getState().savedCourseId, null);
});

test("observed lifetime: a pending save started under A commits when the session stays A", async () => {
  // Positive control: the reader is injected, the session does NOT change, and
  // the save commits normally.
  resetCourseSessionLifetime();
  let token = "token-A";
  const storage: CourseSessionStorage = {
    getItem: (key) => key === "authToken" ? token : key === "currentUser" ? JSON.stringify({ id: "u1", role: "instructor" }) : null,
  };
  const h = setup();
  h.api.readPrincipal = () => readCourseSessionPrincipal(storage);
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form(), null);
  // No token change, no session change.
  gate.resolve();
  assert.equal(await pending, "created");
  assert.equal(h.controller.getState().savedCourseId, "created-id");
});

// ---------------------------------------------------------------------------
// M2-22 — publication (an explicit discovery flag, not an entitlement)
// ---------------------------------------------------------------------------

test("publication: a confirmed publish is exactly ONE request and the server state is what is held", async () => {
  const h = setup();
  await h.controller.load();

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "published");
  assert.deepEqual(h.state.publishCalls, ["c1"]);
  assert.deepEqual(h.state.unpublishCalls, []);
  assert.equal(h.controller.publicationState("c1"), "published");
  const state = h.controller.getState();
  assert.equal(state.publicationError, null);
  assert.equal(state.publicationNotice, COURSE_PUBLISHED_MESSAGE);
  assert.equal(state.busyKind, null, "the busy marker is cleared");
});

test("publication: a confirmed unpublish is exactly ONE request and reports draft", async () => {
  const h = setup();
  await h.controller.load();
  await h.controller.publish("c1");

  const outcome = await h.controller.unpublish("c1");

  assert.equal(outcome, "unpublished");
  assert.deepEqual(h.state.unpublishCalls, ["c1"]);
  assert.equal(h.controller.publicationState("c1"), "draft");
  assert.equal(h.controller.getState().publicationNotice, COURSE_UNPUBLISHED_MESSAGE);
});

test("publication: an already-confirmed state is a truthful no-op that sends NOTHING", async () => {
  const h = setup();
  await h.controller.load();
  await h.controller.publish("c1");
  const afterFirst = h.state.publishCalls.length;

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "unchanged");
  assert.equal(h.state.publishCalls.length, afterFirst, "no second request");
  assert.equal(h.controller.getState().publicationNotice, COURSE_PUBLICATION_UNCHANGED_MESSAGE);
  // Unpublishing a course that is already draft is likewise a no-op.
  await h.controller.unpublish("c1");
  const afterUnpublish = h.state.unpublishCalls.length;
  assert.equal(await h.controller.unpublish("c1"), "unchanged");
  assert.equal(h.state.unpublishCalls.length, afterUnpublish);
});

test("publication: a state reported for ANOTHER course is not a success for this one", async () => {
  const h = setup();
  await h.controller.load();
  h.state.publicationImpl = async (_id, publicationState) => ({
    course_id: "c2",
    publication_state: publicationState,
    published_at: "2026-10-23T10:00:00.000Z",
  });

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "uncertain");
  assert.equal(h.controller.publicationState("c1"), null, "no state is claimed");
  assert.equal(h.controller.getState().publicationError, COURSE_PUBLICATION_UNEXPECTED_MESSAGE);
});

test("publication: a record reporting a DIFFERENT state than requested is not a success", async () => {
  const h = setup();
  await h.controller.load();
  // Asked to publish; the server answered "draft".
  h.state.publicationImpl = async (id) => ({
    course_id: id,
    publication_state: "draft",
    published_at: null,
  });

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "uncertain");
  assert.equal(h.controller.publicationState("c1"), null);
});

test("publication: an unparseable body is uncertain, never a fabricated state", async () => {
  for (const body of [
    null,
    {},
    { course_id: "c1", publication_state: "published" },
    { course_id: "c1", publication_state: "unpublished", published_at: null },
    { course_id: "c1", publication_state: "published", published_at: null, extra: 1 },
    { course_id: "", publication_state: "published", published_at: null },
  ]) {
    const h = setup();
    await h.controller.load();
    h.state.publicationImpl = async () => body;

    const outcome = await h.controller.publish("c1");

    assert.equal(outcome, "uncertain", `body ${JSON.stringify(body)} must not confirm`);
    assert.equal(h.controller.publicationState("c1"), null);
    assert.equal(h.controller.getState().publicationError, COURSE_PUBLICATION_UNEXPECTED_MESSAGE);
  }
});

test("publication: a duplicate click never sends a second write", async () => {
  const h = setup();
  await h.controller.load();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const first = h.controller.publish("c1");
  const second = h.controller.publish("c1");

  assert.equal(await second, "duplicate");
  gate.resolve();
  assert.equal(await first, "published");
  assert.equal(h.state.publishCalls.length, 1);
});

test("publication: a vanished course is dropped from the list with its state", async () => {
  const h = setup();
  await h.controller.load();
  h.state.publicationImpl = async () => { throw new Error(COURSE_NOT_FOUND_MESSAGE); };

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "failed");
  const state = h.controller.getState();
  assert.deepEqual(state.courses, [], "the vanished row is gone");
  assert.equal(state.phase, "empty");
  assert.equal(h.controller.publicationState("c1"), null);
  assert.equal(state.publicationError, COURSE_NOT_FOUND_MESSAGE);
});

test("publication: a denial is reported and no state is claimed", async () => {
  const h = setup();
  await h.controller.load();
  h.state.publicationImpl = async () => { throw new Error("Forbidden"); };

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "failed");
  assert.equal(h.controller.publicationState("c1"), null);
  assert.equal(h.controller.getState().publicationError, "Forbidden");
  assert.deepEqual(h.controller.getState().courses, [courseRow()], "the row stays");
});

test("publication: a 500 is UNCERTAIN — no state is claimed and nothing is retried", async () => {
  const h = setup();
  await h.controller.load();
  h.state.publicationImpl = async () => { throw new Error("Failed to update course publication"); };

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "uncertain");
  assert.equal(h.controller.publicationState("c1"), null);
  assert.equal(h.controller.getState().publicationError, "Failed to update course publication");
  assert.equal(h.state.publishCalls.length, 1, "exactly one attempt");
});

test("publication: a deployment that does not wire it sends NOTHING and invents no state", async () => {
  const h = setup({ withPublication: false });
  await h.controller.load();

  const outcome = await h.controller.publish("c1");

  assert.equal(outcome, "unavailable");
  assert.equal(h.controller.publicationState("c1"), null);
  assert.equal(h.controller.getState().publicationError, null);
});

test("publication: the private list row seeds a KNOWN state and an absent column stays UNKNOWN", async () => {
  const withColumn = setup({
    rows: [
      { ...courseRow(), publication_state: "published" } as Course,
      courseRow({ id: "c2" }),
    ],
  });
  await withColumn.controller.load();
  assert.equal(withColumn.controller.publicationState("c1"), "published");
  // The M2-22 migration is a file only, so a row without the column is NOT
  // reported as draft — it is simply unknown.
  assert.equal(withColumn.controller.publicationState("c2"), null);
});

test("publication: a list that does not report the column never erases a confirmed state", async () => {
  const h = setup();
  await h.controller.load();
  await h.controller.publish("c1");
  assert.equal(h.controller.publicationState("c1"), "published");

  await h.controller.refresh();

  assert.equal(h.controller.publicationState("c1"), "published", "the confirmed state survives");
});

test("publication: a reply observed after a session change never commits", async () => {
  const h = setup();
  await h.controller.load();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const pending = h.controller.publish("c1");
  // The reader alone observes the new session: no notification is fired.
  h.state.principal = "tenant-b";
  gate.resolve();

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.publicationState("c1"), null);
  assert.equal(h.state.publishCalls.length, 1);
});

test("publication: a session change clears the held publication state with the list", async () => {
  const h = setup();
  await h.controller.load();
  await h.controller.publish("c1");
  assert.equal(h.controller.publicationState("c1"), "published");

  h.fireSessionChange();

  assert.equal(h.controller.publicationState("c1"), null);
  assert.equal(h.controller.getState().publicationNotice, null);
  assert.equal(h.controller.getState().publicationError, null);
});

test("publication: nothing commits after dispose", async () => {
  const h = setup();
  await h.controller.load();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const pending = h.controller.publish("c1");
  h.controller.dispose();
  gate.resolve();

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.publicationState("c1"), null);
});

test("publication: a blank id sends nothing", async () => {
  const h = setup();
  await h.controller.load();

  assert.equal(await h.controller.publish("   "), "blocked");
  assert.equal(await h.controller.unpublish(""), "blocked");
  assert.deepEqual(h.state.publishCalls, []);
  assert.deepEqual(h.state.unpublishCalls, []);
});
