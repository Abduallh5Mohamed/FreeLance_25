/**
 * M2-23 — hermetic tests for the server-authoritative student learning path.
 *
 * No DB, no network, no browser, no provider and no dotenv: every transport call
 * is a deferred the test settles by hand, and the REAL production module
 * (`src/features/catalog/student-learning-path.ts`) is exercised through the
 * exact seam `src/pages/StudentContent.tsx` mounts.
 *
 * Proven here:
 *  - strict DTO parsing: the exact key sets, the canonical UTC instants, the
 *    accessibility/lock/completion consistency, the privacy rule that a locked
 *    lesson carries no description, the duplicate-id and 500-lesson bounds, and
 *    a completion envelope that must answer the REQUESTED lesson;
 *  - nothing is requested before an explicit open, and the bounded course list
 *    is read before the bounded path;
 *  - the documented refusals keep their own phase (unauthorized / forbidden /
 *    no-workspace / missing-course / malformed / error) and never become a
 *    fabricated permission;
 *  - a course change invalidates every in-flight reply BEFORE the new read, and
 *    one course's lessons can never land under another course's header;
 *  - a stale reply for a previous principal never commits, and a session change
 *    clears the private path;
 *  - ONE completion write at a time: two synchronous calls send exactly one
 *    request; the confirmed instant is the SERVER's; the follow-up read is what
 *    unlocks a dependent lesson; a locked refusal is definite; a 500/network/
 *    malformed outcome is uncertain, is never retried and offers only an
 *    explicit read reconciliation that never claims success;
 *  - the client never sends a tenant, student or enrollment selector.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDENT_COURSE_LIST_MAX,
  STUDENT_PATH_MAX_LESSONS,
  STUDENT_COMPLETION_CONFIRMED_MESSAGE,
  STUDENT_COMPLETION_LOCKED_MESSAGE,
  STUDENT_COMPLETION_RECONCILED_MESSAGE,
  STUDENT_COMPLETION_UNCERTAIN_MESSAGE,
  STUDENT_PATH_ERROR_MESSAGE,
  STUDENT_PATH_FORBIDDEN_MESSAGE,
  STUDENT_PATH_MALFORMED_MESSAGE,
  STUDENT_PATH_MISSING_COURSE_MESSAGE,
  STUDENT_PATH_NO_WORKSPACE_MESSAGE,
  STUDENT_PATH_UNAUTHORIZED_MESSAGE,
  STUDENT_PATH_UNKNOWN_LESSON_MESSAGE,
  createStudentLearningPathController,
  parseStudentCompletionEnvelope,
  parseStudentCourseListEnvelope,
  parseStudentCourseSummary,
  parseStudentLearningPathEnvelope,
  parseStudentLesson,
  parseStudentUnit,
  type StudentLearningPathApi,
  type StudentLearningPathController,
} from "../features/catalog/student-learning-path";
import type {
  StudentCompletionEnvelope,
  StudentCourseListEnvelope,
  StudentLearningPathEnvelope,
} from "../lib/api-http";

// ---------------------------------------------------------------------------
// Deferred + fixtures
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_COURSE_ID = "99999999-8888-4777-8666-555555555555";
const UNIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_UNIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const LESSON_1 = "cccccccc-1111-4111-8111-111111111111";
const LESSON_2 = "cccccccc-2222-4222-8222-222222222222";
const LESSON_3 = "cccccccc-3333-4333-8333-333333333333";

/** Canonical instants, exactly as the server projects them. */
const T0 = "2026-10-01T09:00:00.000Z";
const T1 = "2026-10-02T09:00:00.000Z";
const FUTURE = "2026-12-01T09:00:00.000Z";

const courseSummary = (overrides: Record<string, unknown> = {}) => ({
  course_id: COURSE_ID,
  name: "كورس الرياضيات",
  subject: null,
  grade: null,
  ...overrides,
});

const studentLesson = (overrides: Record<string, unknown> = {}) => ({
  lesson_id: LESSON_1,
  title: "الدرس الأول",
  display_order: 0,
  release_at: null,
  prerequisite_lesson_id: null,
  accessible: true,
  lock_reason: null,
  completed: false,
  completed_at: null,
  description: "وصف خاص",
  ...overrides,
});

const unit = (lessons: unknown, overrides: Record<string, unknown> = {}) => ({
  unit_id: UNIT_ID,
  name: "الوحدة الأولى",
  display_order: 0,
  lessons,
  ...overrides,
});

const listEnvelope = (courses: unknown[]): StudentCourseListEnvelope =>
  ({ courses, truncated: false }) as StudentCourseListEnvelope;

const pathEnvelope = (units: unknown[], overrides: Record<string, unknown> = {}) =>
  ({ course: courseSummary(), units, truncated: false, ...overrides }) as unknown as StudentLearningPathEnvelope;

const completionEnvelope = (lessonId: string, at: string): StudentCompletionEnvelope =>
  ({ completion: { lesson_id: lessonId, completed_at: at } }) as StudentCompletionEnvelope;

/** A lesson id shaped like a canonical UUID. */
const lessonIdFor = (index: number): string =>
  `dddddddd-0000-4000-8000-${String(index).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// The controller harness
// ---------------------------------------------------------------------------

interface Harness {
  api: StudentLearningPathApi;
  lists: Deferred<StudentCourseListEnvelope>[];
  pathCalls: string[];
  paths: Deferred<StudentLearningPathEnvelope>[];
  completionCalls: { courseId: string; lessonId: string }[];
  completions: Deferred<StudentCompletionEnvelope>[];
  principal: { value: string | null };
  fireSession: () => void;
  subscribed: () => boolean;
}

const createHarness = (principal: string | null = "student-token-1"): Harness => {
  const lists: Deferred<StudentCourseListEnvelope>[] = [];
  const pathCalls: string[] = [];
  const paths: Deferred<StudentLearningPathEnvelope>[] = [];
  const completionCalls: { courseId: string; lessonId: string }[] = [];
  const completions: Deferred<StudentCompletionEnvelope>[] = [];
  const state = { value: principal };
  let listener: (() => void) | null = null;
  return {
    lists,
    pathCalls,
    paths,
    completionCalls,
    completions,
    principal: state,
    fireSession: () => { if (listener) listener(); },
    subscribed: () => listener !== null,
    api: {
      listCourses: () => {
        const entry = deferred<StudentCourseListEnvelope>();
        lists.push(entry);
        return entry.promise;
      },
      getPath: (courseId) => {
        pathCalls.push(courseId);
        const entry = deferred<StudentLearningPathEnvelope>();
        paths.push(entry);
        return entry.promise;
      },
      completeLesson: (courseId, lessonId) => {
        completionCalls.push({ courseId, lessonId });
        const entry = deferred<StudentCompletionEnvelope>();
        completions.push(entry);
        return entry.promise;
      },
      readPrincipal: () => state.value,
      subscribeSession: (l) => {
        listener = l;
        return () => { listener = null; };
      },
    },
  };
};

/** Opens the path and settles the bounded list and the first course path. */
const openReady = async (
  harness: Harness,
  controller: StudentLearningPathController,
  units: unknown[] = [unit([studentLesson()])],
): Promise<void> => {
  const operation = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([courseSummary()]));
  await flush();
  harness.paths[0].resolve(pathEnvelope(units));
  await operation;
};

// ===========================================================================
// Strict DTO parsing
// ===========================================================================

test("parse: the four-key course summary is accepted and a foreign key is refused", () => {
  assert.deepEqual(parseStudentCourseSummary(courseSummary()), {
    course_id: COURSE_ID,
    name: "كورس الرياضيات",
    subject: null,
    grade: null,
  });
  for (const refused of [
    { ...courseSummary(), tenant_id: "x" },
    { ...courseSummary(), course_id: "not-a-uuid" },
    { ...courseSummary(), name: "" },
    { ...courseSummary(), name: "   " },
    { ...courseSummary(), subject: 5 },
    { course_id: COURSE_ID, name: "كورس" },
    null,
    [],
  ]) {
    assert.equal(parseStudentCourseSummary(refused), null, "the body is refused whole");
  }
});

test("parse: the ten-key lesson is accepted and its consistency is enforced", () => {
  const parsed = parseStudentLesson(studentLesson());
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "accessible",
    "completed",
    "completed_at",
    "description",
    "display_order",
    "lesson_id",
    "lock_reason",
    "prerequisite_lesson_id",
    "release_at",
    "title",
  ]);
  assert.equal(parsed.lesson_id, LESSON_1);
  assert.equal(parsed.accessible, true);

  const unreleased = parseStudentLesson(
    studentLesson({ accessible: false, lock_reason: "not_released", description: null }),
  );
  assert.equal(unreleased?.lock_reason, "not_released");
  assert.equal(unreleased?.description, null, "a locked lesson carries no private wording");

  for (const refused of [
    { ...studentLesson(), tenant_id: "x" }, // an extra key
    { ...studentLesson(), description: undefined }, // a missing key
    { ...studentLesson(), lesson_id: "not-a-uuid" },
    { ...studentLesson(), display_order: -1 },
    { ...studentLesson(), display_order: 1.5 },
    { ...studentLesson(), release_at: "2026-11-01T09:00:00Z" }, // not canonical
    { ...studentLesson(), release_at: "2026-11-01" },
    { ...studentLesson(), prerequisite_lesson_id: "nope" },
    { ...studentLesson(), prerequisite_lesson_id: LESSON_1 }, // a self-gate
    { ...studentLesson(), accessible: "true" },
    { ...studentLesson(), accessible: false, lock_reason: null }, // locked with no reason
    { ...studentLesson(), accessible: true, lock_reason: "not_released" }, // a reason on an open lesson
    { ...studentLesson(), lock_reason: "some_other_reason" },
    // The privacy rule: the server withholds a locked description, so a body
    // that leaks one is malformed rather than a lesson to render.
    { ...studentLesson(), accessible: false, lock_reason: "not_released", description: "نص خاص" },
    { ...studentLesson(), completed: true, completed_at: null },
    { ...studentLesson(), completed: false, completed_at: T0 },
    { ...studentLesson(), completed_at: "2026-10-01T09:00:00Z" },
  ]) {
    assert.equal(parseStudentLesson(refused), null, "the lesson is refused whole");
  }
});

test("parse: the unit keeps its bounded lessons and refuses a bad shape", () => {
  assert.ok(parseStudentUnit(unit([studentLesson()])));
  for (const refused of [
    unit([studentLesson()], { extra: 1 }),
    unit("not-an-array"),
    unit([studentLesson({ lesson_id: "x" })]),
    unit([], { unit_id: "x" }),
    unit([], { display_order: -3 }),
  ]) {
    assert.equal(parseStudentUnit(refused), null);
  }
});

test("parse: the course list is bounded, key-exact and duplicate-free", () => {
  assert.deepEqual(parseStudentCourseListEnvelope(listEnvelope([courseSummary()])), {
    courses: [
      { course_id: COURSE_ID, name: "كورس الرياضيات", subject: null, grade: null },
    ],
    truncated: false,
  });
  assert.equal(
    parseStudentCourseListEnvelope(listEnvelope([courseSummary(), courseSummary()])),
    null,
    "a duplicate course is malformed",
  );
  assert.equal(
    parseStudentCourseListEnvelope(
      listEnvelope(
        Array.from({ length: STUDENT_COURSE_LIST_MAX + 1 }, (_, index) =>
          courseSummary({ course_id: lessonIdFor(index) }),
        ),
      ),
    ),
    null,
    "an oversized list is refused BEFORE any row is copied",
  );
  for (const refused of [
    { courses: [courseSummary()] },
    { courses: [], truncated: "no" },
    { courses: [], truncated: false, extra: 1 },
    [],
    null,
  ]) {
    assert.equal(parseStudentCourseListEnvelope(refused), null);
  }
});

test("parse: the path is bounded, key-exact and duplicate-free", () => {
  const parsed = parseStudentLearningPathEnvelope(pathEnvelope([unit([studentLesson()])]));
  assert.ok(parsed);
  assert.equal(parsed.course.course_id, COURSE_ID);
  assert.equal(parsed.units.length, 1);

  assert.equal(
    parseStudentLearningPathEnvelope(
      pathEnvelope([
        unit([studentLesson()]),
        unit([studentLesson()], { unit_id: OTHER_UNIT_ID }),
      ]),
    ),
    null,
    "the same lesson in two units is malformed",
  );
  assert.equal(
    parseStudentLearningPathEnvelope(
      pathEnvelope([unit([studentLesson()]), unit([studentLesson()])]),
    ),
    null,
    "the same unit twice is malformed",
  );
  assert.equal(
    parseStudentLearningPathEnvelope(
      pathEnvelope([
        unit(
          Array.from({ length: STUDENT_PATH_MAX_LESSONS + 1 }, (_, index) =>
            studentLesson({ lesson_id: lessonIdFor(index) }),
          ),
        ),
      ]),
    ),
    null,
    "an oversized path is refused before any row is held",
  );
  for (const refused of [
    { course: courseSummary(), units: [], truncated: false, extra: 1 },
    { course: courseSummary(), units: [] },
    { course: null, units: [], truncated: false },
  ]) {
    assert.equal(parseStudentLearningPathEnvelope(refused), null);
  }
});

test("parse: the completion envelope must answer the REQUESTED lesson", () => {
  assert.deepEqual(parseStudentCompletionEnvelope(completionEnvelope(LESSON_1, T1), LESSON_1), {
    lesson_id: LESSON_1,
    completed_at: T1,
  });
  assert.equal(
    parseStudentCompletionEnvelope(completionEnvelope(LESSON_2, T1), LESSON_1),
    null,
    "a completion for another lesson is not a success for this write",
  );
  for (const refused of [
    completionEnvelope(LESSON_1, "2026-10-02T09:00:00Z"),
    completionEnvelope(LESSON_1, "2026-10-02"),
    { completion: { lesson_id: LESSON_1, completed_at: T1, student_id: "x" } },
    { completion: { lesson_id: LESSON_1 } },
    { completion: null },
    { lesson_id: LESSON_1, completed_at: T1 },
    null,
  ]) {
    assert.equal(parseStudentCompletionEnvelope(refused, LESSON_1), null);
  }
});

// ===========================================================================
// Reading the path
// ===========================================================================

test("read: nothing is requested before an explicit open", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    assert.equal(harness.lists.length, 0);
    assert.equal(harness.pathCalls.length, 0);
    assert.equal(controller.getState().phase, "idle");
    assert.equal(controller.getState().open, false);
  } finally {
    controller.dispose();
  }
});

test("read: open reads the bounded list then the first course path", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    assert.equal(harness.lists.length, 1, "exactly one bounded course list");
    assert.deepEqual(harness.pathCalls, [COURSE_ID], "the first enrolled course is opened");
    const state = controller.getState();
    assert.equal(state.open, true);
    assert.equal(state.coursesPhase, "ready");
    assert.equal(state.courseId, COURSE_ID);
    assert.equal(state.phase, "ready");
    assert.equal(state.units.length, 1);
    assert.equal(state.units[0].lessons[0].title, "الدرس الأول");
  } finally {
    controller.dispose();
  }
});

test("read: no enrolled course is an empty list, not an error and not a path read", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    const operation = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([]));
    await operation;

    assert.equal(controller.getState().coursesPhase, "empty");
    assert.equal(controller.getState().courseId, null);
    assert.equal(harness.pathCalls.length, 0, "an empty list has nothing to open");
  } finally {
    controller.dispose();
  }
});

test("read: a course with no active lesson is empty, not an error", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller, []);
    assert.equal(controller.getState().phase, "empty");
    assert.deepEqual(controller.getState().units, []);
  } finally {
    controller.dispose();
  }
});

test("read: the documented refusals keep their own phase and clear the private path", async () => {
  const cases: { message: string; coursesPhase: string; error: string }[] = [
    { message: "Authentication required", coursesPhase: "unauthorized", error: STUDENT_PATH_UNAUTHORIZED_MESSAGE },
    { message: "Token expired", coursesPhase: "unauthorized", error: STUDENT_PATH_UNAUTHORIZED_MESSAGE },
    { message: "Selected workspace is no longer active", coursesPhase: "unauthorized", error: STUDENT_PATH_UNAUTHORIZED_MESSAGE },
    { message: "Student access required", coursesPhase: "forbidden", error: STUDENT_PATH_FORBIDDEN_MESSAGE },
    { message: "Select an instructor workspace first", coursesPhase: "no-workspace", error: STUDENT_PATH_NO_WORKSPACE_MESSAGE },
    { message: "Failed to load courses", coursesPhase: "error", error: STUDENT_PATH_ERROR_MESSAGE },
  ];

  for (const entry of cases) {
    const harness = createHarness();
    const controller = createStudentLearningPathController(harness.api);
    try {
      const operation = controller.open();
      await flush();
      harness.lists[0].reject(new Error(entry.message));
      await operation;

      const state = controller.getState();
      assert.equal(state.coursesPhase, entry.coursesPhase, `${entry.message} keeps its own phase`);
      assert.equal(state.coursesError, entry.error);
      assert.deepEqual(state.courses, [], "a refusal never leaves rows behind");
      assert.equal(harness.pathCalls.length, 0);
    } finally {
      controller.dispose();
    }
  }
});

test("read: a malformed list is malformed, never an empty list", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    const operation = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([{ ...courseSummary(), tenant_id: "x" }]));
    await operation;

    assert.equal(controller.getState().coursesPhase, "malformed");
    assert.equal(controller.getState().coursesError, STUDENT_PATH_MALFORMED_MESSAGE);
    assert.deepEqual(controller.getState().courses, []);
  } finally {
    controller.dispose();
  }
});

test("read: a path for ANOTHER course is not a success", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    const operation = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([courseSummary()]));
    await flush();
    harness.paths[0].resolve(
      pathEnvelope([unit([studentLesson()])], { course: courseSummary({ course_id: OTHER_COURSE_ID }) }),
    );
    await operation;

    const state = controller.getState();
    assert.equal(state.phase, "malformed");
    assert.deepEqual(state.units, [], "another course's lessons are never shown");
  } finally {
    controller.dispose();
  }
});

test("read: a missing course keeps its own phase", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    const operation = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([courseSummary()]));
    await flush();
    harness.paths[0].reject(new Error("Course not found"));
    await operation;

    assert.equal(controller.getState().phase, "missing-course");
    assert.equal(controller.getState().error, STUDENT_PATH_MISSING_COURSE_MESSAGE);
    assert.deepEqual(controller.getState().units, []);
  } finally {
    controller.dispose();
  }
});

test("read: a locked lesson keeps its reason and carries no description", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller, [
      unit([
        studentLesson({ lesson_id: LESSON_1, title: "متاح", description: "نص عام" }),
        studentLesson({
          lesson_id: LESSON_2,
          title: "لم يُتح",
          display_order: 1,
          release_at: FUTURE,
          accessible: false,
          lock_reason: "not_released",
          description: null,
        }),
        studentLesson({
          lesson_id: LESSON_3,
          title: "مرهون",
          display_order: 2,
          prerequisite_lesson_id: LESSON_1,
          accessible: false,
          lock_reason: "prerequisite_incomplete",
          description: null,
        }),
      ]),
    ]);

    const lessons = controller.getState().units[0].lessons;
    assert.equal(lessons[0].description, "نص عام");
    assert.equal(lessons[1].lock_reason, "not_released");
    assert.equal(lessons[1].description, null, "the private wording of a locked lesson is absent");
    assert.equal(lessons[1].release_at, FUTURE);
    assert.equal(lessons[2].lock_reason, "prerequisite_incomplete");
    assert.equal(lessons[2].description, null);
    assert.equal(lessons[2].prerequisite_lesson_id, LESSON_1);
  } finally {
    controller.dispose();
  }
});

test("read: a course change drops the old path BEFORE the new read and fences the stale reply", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const operation = controller.selectCourse(OTHER_COURSE_ID);
    // The old course's lessons are gone before any reply arrives.
    assert.equal(controller.getState().courseId, OTHER_COURSE_ID);
    assert.deepEqual(controller.getState().units, []);
    assert.equal(controller.getState().phase, "loading");

    await flush();
    harness.paths[1].resolve(
      pathEnvelope([unit([studentLesson({ lesson_id: LESSON_2, title: "درس الكورس الثاني" })])], {
        course: courseSummary({ course_id: OTHER_COURSE_ID, name: "كورس آخر" }),
      }),
    );
    await operation;

    assert.equal(controller.getState().course?.course_id, OTHER_COURSE_ID);
    assert.equal(controller.getState().units[0].lessons[0].title, "درس الكورس الثاني");
  } finally {
    controller.dispose();
  }
});

test("read: a reply for a previous course never lands after a target change", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    const opening = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([courseSummary(), courseSummary({ course_id: OTHER_COURSE_ID, name: "آخر" })]));
    await flush();
    // The first course's path is now on the wire; the user switches away.
    const switching = controller.selectCourse(OTHER_COURSE_ID);
    await flush();
    harness.paths[1].resolve(
      pathEnvelope([unit([studentLesson({ title: "الثاني" })])], {
        course: courseSummary({ course_id: OTHER_COURSE_ID }),
      }),
    );
    await switching;
    // The FIRST course's reply arrives late: it must be discarded.
    harness.paths[0].resolve(pathEnvelope([unit([studentLesson({ title: "الأول" })])]));
    await opening;

    assert.equal(controller.getState().courseId, OTHER_COURSE_ID);
    assert.equal(controller.getState().units[0].lessons[0].title, "الثاني");
  } finally {
    controller.dispose();
  }
});

test("read: a reply for a previous principal never commits", async () => {
  const harness = createHarness("student-a");
  const controller = createStudentLearningPathController(harness.api);
  try {
    const operation = controller.open();
    await flush();
    // The session silently becomes another principal while the list is on the wire.
    harness.principal.value = "student-b";
    harness.lists[0].resolve(listEnvelope([courseSummary()]));
    await operation;

    const state = controller.getState();
    assert.deepEqual(state.courses, [], "another principal's list is never shown");
    assert.equal(harness.pathCalls.length, 0);
  } finally {
    controller.dispose();
  }
});

test("read: a session change clears the private path", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);
    assert.equal(controller.getState().units.length, 1);
    assert.equal(harness.subscribed(), true, "the controller subscribes to the session");

    harness.principal.value = null;
    harness.fireSession();

    const state = controller.getState();
    assert.deepEqual(state.courses, []);
    assert.deepEqual(state.units, []);
    assert.equal(state.courseId, null);
    assert.equal(state.phase, "idle");
  } finally {
    controller.dispose();
  }
});

test("read: dispose clears everything, retires the reply and resolves waitForIdle", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  await openReady(harness, controller);

  const pending = controller.refreshPath();
  await flush();
  controller.dispose();
  harness.paths[1].resolve(pathEnvelope([unit([studentLesson({ title: "متأخر" })])]));
  await pending;
  await controller.waitForIdle();

  assert.equal(controller.getState().open, false);
  assert.deepEqual(controller.getState().units, []);
  assert.deepEqual(controller.getState().courses, []);
});

// ===========================================================================
// Completing a lesson
// ===========================================================================

test("complete: two synchronous calls send exactly ONE write", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const first = controller.completeLesson(LESSON_1);
    const second = controller.completeLesson(LESSON_1);
    await flush();

    assert.equal(harness.completionCalls.length, 1, "the second click never reaches the transport");
    assert.deepEqual(harness.completionCalls[0], { courseId: COURSE_ID, lessonId: LESSON_1 });
    assert.deepEqual(Object.keys(harness.completionCalls[0]).sort(), ["courseId", "lessonId"],
      "no tenant, student or enrollment selector is ever sent");

    harness.completions[0].resolve(completionEnvelope(LESSON_1, T1));
    await flush();
    harness.paths[1].resolve(pathEnvelope([unit([studentLesson({ completed: true, completed_at: T1 })])]));
    await Promise.all([first, second]);

    const state = controller.getState();
    assert.equal(state.mutation.status, "saved");
    assert.equal(state.mutation.notice, STUDENT_COMPLETION_CONFIRMED_MESSAGE);
    assert.deepEqual(state.lastCompletion, { lesson_id: LESSON_1, completed_at: T1 });
  } finally {
    controller.dispose();
  }
});

test("complete: the SERVER instant is what is recorded, and the unlock comes from the re-read", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller, [
      unit([
        studentLesson({ lesson_id: LESSON_1, title: "أول" }),
        studentLesson({
          lesson_id: LESSON_2,
          title: "ثاني",
          display_order: 1,
          prerequisite_lesson_id: LESSON_1,
          accessible: false,
          lock_reason: "prerequisite_incomplete",
          description: null,
        }),
      ]),
    ]);

    const operation = controller.completeLesson(LESSON_1);
    await flush();
    harness.completions[0].resolve(completionEnvelope(LESSON_1, T1));
    await flush();

    // The confirmed instant is applied, but accessibility is NOT inferred here:
    // the dependent lesson is still locked until the server says otherwise.
    let lessons = controller.getState().units[0].lessons;
    assert.equal(lessons[0].completed, true);
    assert.equal(lessons[0].completed_at, T1);
    assert.equal(lessons[1].accessible, false, "the client never decides that an edge is satisfied");

    assert.equal(harness.pathCalls.length, 2, "ONE bounded follow-up read");
    harness.paths[1].resolve(
      pathEnvelope([
        unit([
          studentLesson({ lesson_id: LESSON_1, title: "أول", completed: true, completed_at: T1 }),
          studentLesson({
            lesson_id: LESSON_2,
            title: "ثاني",
            display_order: 1,
            prerequisite_lesson_id: LESSON_1,
            description: "صار متاحًا",
          }),
        ]),
      ]),
    );
    await operation;

    lessons = controller.getState().units[0].lessons;
    assert.equal(lessons[1].accessible, true, "the server unlocked the dependent lesson");
    assert.equal(lessons[1].description, "صار متاحًا");
  } finally {
    controller.dispose();
  }
});

test("complete: a locked refusal is definite, not uncertain", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller, [
      unit([
        studentLesson({
          lesson_id: LESSON_2,
          accessible: false,
          lock_reason: "not_released",
          release_at: FUTURE,
          description: null,
        }),
      ]),
    ]);

    const operation = controller.completeLesson(LESSON_2);
    await flush();
    harness.completions[0].reject(new Error("Lesson is not accessible yet"));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "failed");
    assert.equal(state.mutation.error, STUDENT_COMPLETION_LOCKED_MESSAGE);
    assert.equal(harness.pathCalls.length, 1, "a definite refusal triggers no follow-up read");
    assert.equal(harness.completions.length, 1, "and is never retried");
  } finally {
    controller.dispose();
  }
});

test("complete: a 500 is UNCERTAIN, preserves the path and is never retried", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const operation = controller.completeLesson(LESSON_1);
    await flush();
    harness.completions[0].reject(new Error("Failed to record lesson completion"));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "uncertain");
    assert.equal(state.mutation.error, STUDENT_COMPLETION_UNCERTAIN_MESSAGE);
    assert.equal(state.units.length, 1, "the path is preserved for the deliberate reconciliation");
    assert.equal(state.units[0].lessons[0].completed, false, "nothing is claimed");
    assert.equal(harness.completions.length, 1, "no automatic retry");
  } finally {
    controller.dispose();
  }
});

test("complete: a malformed 2xx is a failure, never a confirmed completion", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const operation = controller.completeLesson(LESSON_1);
    await flush();
    // The envelope answers ANOTHER lesson.
    harness.completions[0].resolve(completionEnvelope(LESSON_2, T1));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "failed");
    assert.equal(state.mutation.error, STUDENT_PATH_MALFORMED_MESSAGE);
    assert.equal(state.units[0].lessons[0].completed, false);
    assert.equal(harness.pathCalls.length, 1, "a malformed body triggers no follow-up read");
  } finally {
    controller.dispose();
  }
});

test("complete: a lesson outside the shown path is refused locally", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    await controller.completeLesson(LESSON_2);
    assert.equal(harness.completionCalls.length, 0, "no request for an unknown target");
    assert.equal(controller.getState().mutation.status, "failed");
    assert.equal(controller.getState().mutation.error, STUDENT_PATH_UNKNOWN_LESSON_MESSAGE);
  } finally {
    controller.dispose();
  }
});

test("complete: an authorization loss during the write clears the private path", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const operation = controller.completeLesson(LESSON_1);
    await flush();
    harness.completions[0].reject(new Error("Token expired"));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "failed");
    assert.equal(state.mutation.error, STUDENT_PATH_UNAUTHORIZED_MESSAGE);
    assert.deepEqual(state.units, [], "a lost session leaves no private path");
    assert.equal(state.courseId, null);
  } finally {
    controller.dispose();
  }
});

test("complete: a failed follow-up read never turns the confirmed completion into a failure", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const operation = controller.completeLesson(LESSON_1);
    await flush();
    harness.completions[0].resolve(completionEnvelope(LESSON_1, T1));
    await flush();
    harness.paths[1].reject(new Error("Failed to load learning path"));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "saved", "the completion is confirmed");
    assert.equal(state.lastCompletion?.completed_at, T1);
    assert.equal(state.refreshError, STUDENT_PATH_ERROR_MESSAGE, "only the refresh is reported as failed");
  } finally {
    controller.dispose();
  }
});

test("complete: reconcile is an explicit read that never claims the write succeeded", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const write = controller.completeLesson(LESSON_1);
    await flush();
    harness.completions[0].reject(new Error("Failed to record lesson completion"));
    await write;
    assert.equal(controller.getState().mutation.status, "uncertain");

    const reconcile = controller.reconcile();
    await flush();
    harness.paths[1].resolve(pathEnvelope([unit([studentLesson({ completed: false })])]));
    await reconcile;

    const state = controller.getState();
    assert.equal(state.mutation.notice, STUDENT_COMPLETION_RECONCILED_MESSAGE);
    assert.equal(state.mutation.status, "idle");
    assert.equal(state.units[0].lessons[0].completed, false, "the re-read shows the CURRENT state only");
    assert.equal(harness.completions.length, 1, "the reconciliation never retries the write");
  } finally {
    controller.dispose();
  }
});

test("complete: a second lesson can be completed after the first is confirmed", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller, [
      unit([
        studentLesson({ lesson_id: LESSON_1, title: "أول" }),
        studentLesson({ lesson_id: LESSON_2, title: "ثاني", display_order: 1 }),
      ]),
    ]);

    const first = controller.completeLesson(LESSON_1);
    await flush();
    harness.completions[0].resolve(completionEnvelope(LESSON_1, T1));
    await flush();
    harness.paths[1].resolve(
      pathEnvelope([
        unit([
          studentLesson({ lesson_id: LESSON_1, title: "أول", completed: true, completed_at: T1 }),
          studentLesson({ lesson_id: LESSON_2, title: "ثاني", display_order: 1 }),
        ]),
      ]),
    );
    await first;

    const second = controller.completeLesson(LESSON_2);
    await flush();
    assert.equal(harness.completionCalls.length, 2, "the latch was released on confirmation");
    harness.completions[1].resolve(completionEnvelope(LESSON_2, T1));
    await flush();
    harness.paths[2].resolve(pathEnvelope([unit([studentLesson()])]));
    await second;

    assert.equal(controller.getState().mutation.status, "saved");
  } finally {
    controller.dispose();
  }
});

test("read: a double open issues exactly one bounded list read", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    const first = controller.open();
    const second = controller.open();
    await flush();

    assert.equal(harness.lists.length, 1, "the single-flight latch refuses the second read");
    harness.lists[0].resolve(listEnvelope([courseSummary()]));
    await flush();
    harness.paths[0].resolve(pathEnvelope([unit([studentLesson()])]));
    await Promise.all([first, second]);

    assert.equal(controller.getState().phase, "ready");
    assert.equal(harness.pathCalls.length, 1);
  } finally {
    controller.dispose();
  }
});

test("read: waitForIdle waits for a read that is still on the wire", async () => {
  const harness = createHarness();
  const controller = createStudentLearningPathController(harness.api);
  try {
    await openReady(harness, controller);

    const refresh = controller.refreshPath();
    let settled = false;
    const idle = controller.waitForIdle().then(() => { settled = true; });
    await flush();
    assert.equal(settled, false, "the read is still pending");

    harness.paths[1].resolve(pathEnvelope([unit([studentLesson({ title: "محدَّث" })])]));
    await Promise.all([refresh, idle]);

    assert.equal(settled, true);
    assert.equal(controller.getState().units[0].lessons[0].title, "محدَّث");
  } finally {
    controller.dispose();
  }
});
