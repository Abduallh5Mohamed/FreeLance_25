/**
 * M2-10 private lesson-management UI — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/catalog/course-lessons.ts` that
 * `src/features/catalog/CourseLessonManager.tsx` mounts, the REAL additive
 * transport (`listCourseLessons`, `createCourseLesson`, `updateCourseLesson`,
 * `reorderCourseLessons`) in `src/lib/api-http.ts`, the REAL `CourseLessonManager`
 * component and the REAL additive parent mount in `CourseUnitManager.tsx` — all
 * imported unchanged. Fully isolated: no DB, no network, no browser, no live
 * services, no dependency install.
 *
 * The transport seam drives the REAL `request` with a stubbed global fetch /
 * localStorage / window; the feature seam drives the REAL controller with an
 * injected fake transport, principal reader and session notifier; the component
 * seam renders the REAL production components with the REAL React server
 * renderer and invokes the REAL callbacks of the rendered element tree.
 *
 * Behaviours pinned (M2-10 / accepted B05 contract):
 *  - canonical authenticated requests on the exact
 *    `/tenants/me/catalog/courses/:courseId/units/:unitId/lessons` path family,
 *    with the bearer header, the bounded `limit` and NO client tenant selector;
 *  - the strict bodies: `{ title }` (+ optional `description` /`display_order`)
 *    for a create, a non-empty subset of `{ title, description, display_order,
 *    status }` for an update, and ONLY `{ items: [{ id, display_order }] }` for
 *    a reorder;
 *  - the exact eight-key lesson DTO bound to the unit, the exact `{ lessons,
 *    next_cursor }` / `{ lesson }` / `{ lessons }` envelopes, the 25-row response
 *    bound checked BEFORE any row is copied, the 256-character cursor bound and
 *    the exact reorder identity set;
 *  - documented-message classification only: denied / billing-only / suspended /
 *    no-workspace / missing-course / missing-unit / missing-lesson / conflict /
 *    invalid / server / unknown — never a fabricated permission;
 *  - the panel reads ONLY after an explicit open, exactly ONE bounded page at a
 *    time, with next/first paging and no accumulation;
 *  - one synchronous write flight, own-ticket release BEFORE the bounded
 *    follow-up read, and an old `finally` that can never free a newer latch;
 *  - a stale read never overwrites a confirmed write; a confirmed save is never
 *    turned into a failed save by a failed follow-up read;
 *  - uncertain writes preserve the draft, are never retried automatically and
 *    offer only an explicit read reconciliation that never claims success;
 *  - an atomic reorder: all positions validated first, ONE request for the whole
 *    selection, the exact identity set required before applying, no per-row
 *    write and no background fetch per row;
 *  - the real component: RTL markup, bound labels, one submit control per form,
 *    a close control usable while pending, and enabled controls whose real
 *    callbacks actually act (the 179 finding);
 *  - the additive parent mount: no child without an explicit selection, a keyed
 *    child for the selected row, no child in a closed/hidden view, and the
 *    selection cleared on a lost scope or a removed row.
 *
 * Not proven here: DOM paint, real RTL layout, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative). The accepted
 * migration FILE is not applied, so no runtime lesson rollout is claimed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COURSE_LESSON_PAGE_LIMIT,
  COURSE_LESSON_REORDER_LIMIT,
  createCourseLesson,
  listCourseLessons,
  reorderCourseLessons,
  updateCourseLesson,
  type CourseLesson,
  type CourseLessonEnvelope,
  type CourseLessonListEnvelope,
  type CourseLessonReorderEnvelope,
} from "../lib/api-http";
import {
  COURSE_LESSON_DESCRIPTION_INVALID_MESSAGE,
  COURSE_LESSON_DESCRIPTION_MAX,
  COURSE_LESSON_DISPLAY_ORDER_MAX,
  COURSE_LESSON_NO_CHANGES_MESSAGE,
  COURSE_LESSON_ORDER_INVALID_MESSAGE,
  COURSE_LESSON_RECONCILED_MESSAGE,
  COURSE_LESSON_REORDER_NO_CHANGES_MESSAGE,
  COURSE_LESSON_SELECTION_INVALID_MESSAGE,
  COURSE_LESSON_TITLE_INVALID_MESSAGE,
  COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
  MALFORMED_COURSE_LESSON_MESSAGE,
  classifyCourseLessonFailure,
  classifyCourseLessonWriteFailure,
  createCourseLessonController,
  isCourseLessonAuthorizationLoss,
  parseCourseLesson,
  parseCourseLessonDescription,
  parseCourseLessonEnvelope,
  parseCourseLessonList,
  parseCourseLessonOrder,
  parseCourseLessonReorderEnvelope,
  parseCourseLessonTitle,
  type CourseLessonApi,
  type CourseLessonController,
  type CourseLessonState,
} from "../features/catalog/course-lessons";
import type { CourseUnit } from "../lib/api-http";
import type { CourseUnitState } from "../features/catalog/course-units";

// ---------------------------------------------------------------------------
// Deferred + shared helpers
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
const UNIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_UNIT_ID = "ffffffff-eeee-4fff-8aaa-bbbbbbbbbbbb";
const LESSON_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_LESSON_ID = "bbbbbbbb-2222-4222-8222-222222222222";

/** A deterministic, UUID-shaped id for the bounded-page fixtures. */
const lessonIdFor = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const lesson = (overrides: Partial<CourseLesson> = {}): CourseLesson => ({
  id: LESSON_ID,
  unit_id: UNIT_ID,
  title: "الدرس الأول",
  description: null,
  display_order: 0,
  status: "active",
  created_at: "2026-10-21T09:00:00.000Z",
  updated_at: "2026-10-21T09:00:00.000Z",
  ...overrides,
});

const listEnvelope = (
  lessons: CourseLesson[],
  nextCursor: string | null = null,
): CourseLessonListEnvelope => ({ lessons, next_cursor: nextCursor });

const writeEnvelope = (value: CourseLesson): CourseLessonEnvelope => ({ lesson: value });

const reorderEnvelope = (lessons: CourseLesson[]): CourseLessonReorderEnvelope => ({ lessons });

/** The controller harness: every transport call is a deferred the test settles. */
interface Harness {
  api: CourseLessonApi;
  listCalls: { courseId: string; unitId: string; limit: number; cursor: string | null }[];
  lists: Deferred<CourseLessonListEnvelope>[];
  createCalls: {
    courseId: string;
    unitId: string;
    input: { title: string; description?: string | null; display_order?: number };
  }[];
  creates: Deferred<CourseLessonEnvelope>[];
  updateCalls: {
    courseId: string;
    unitId: string;
    lessonId: string;
    update: {
      title?: string;
      description?: string | null;
      display_order?: number;
      status?: string;
    };
  }[];
  updates: Deferred<CourseLessonEnvelope>[];
  reorderCalls: {
    courseId: string;
    unitId: string;
    items: { id: string; display_order: number }[];
  }[];
  reorders: Deferred<CourseLessonReorderEnvelope>[];
}

const createHarness = (): Harness => {
  const listCalls: Harness["listCalls"] = [];
  const lists: Harness["lists"] = [];
  const createCalls: Harness["createCalls"] = [];
  const creates: Harness["creates"] = [];
  const updateCalls: Harness["updateCalls"] = [];
  const updates: Harness["updates"] = [];
  const reorderCalls: Harness["reorderCalls"] = [];
  const reorders: Harness["reorders"] = [];
  return {
    listCalls,
    lists,
    createCalls,
    creates,
    updateCalls,
    updates,
    reorderCalls,
    reorders,
    api: {
      listLessons: (params) => {
        listCalls.push({
          courseId: params.courseId,
          unitId: params.unitId,
          limit: params.limit,
          cursor: params.cursor,
        });
        const d = deferred<CourseLessonListEnvelope>();
        lists.push(d);
        return d.promise;
      },
      createLesson: (courseId, unitId, input) => {
        createCalls.push({ courseId, unitId, input: { ...input } });
        const d = deferred<CourseLessonEnvelope>();
        creates.push(d);
        return d.promise;
      },
      updateLesson: (courseId, unitId, lessonId, update) => {
        updateCalls.push({ courseId, unitId, lessonId, update: { ...update } });
        const d = deferred<CourseLessonEnvelope>();
        updates.push(d);
        return d.promise;
      },
      reorderLessons: (courseId, unitId, items) => {
        reorderCalls.push({
          courseId,
          unitId,
          items: items.map((item) => ({ ...item })),
        });
        const d = deferred<CourseLessonReorderEnvelope>();
        reorders.push(d);
        return d.promise;
      },
    },
  };
};

/** The session notifier the test fires by hand. */
const createSessionSink = () => {
  let listener: (() => void) | null = null;
  return {
    subscribeSession: (l: () => void) => {
      listener = l;
      return () => { listener = null; };
    },
    fire: () => { if (listener) listener(); },
  };
};

/** Opens the panel and settles the first bounded page. */
const openReady = async (
  harness: Harness,
  controller: CourseLessonController,
  lessons: CourseLesson[] = [lesson()],
  nextCursor: string | null = null,
): Promise<void> => {
  const operation = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope(lessons, nextCursor));
  await operation;
};

/** A page of `count` distinct lessons, in display order. */
const pageOf = (count: number): CourseLesson[] =>
  Array.from({ length: count }, (_, index) =>
    lesson({
      id: lessonIdFor(index + 1),
      title: `درس ${index + 1}`,
      display_order: index,
    }),
  );

// ===========================================================================
// Transport seam — the REAL adapters through the REAL request
// ===========================================================================

interface TransportEnv {
  calls: { url: string; init: RequestInit }[];
  assignedUrls: string[];
  store: Map<string, string>;
  restore: () => void;
}

const installTransportEnvironment = (token: string | null): TransportEnv => {
  const store = new Map<string, string>();
  if (token !== null) store.set("authToken", token);
  const realLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
  const assignedUrls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      pathname: "/instructor",
      assign: (url: string) => { assignedUrls.push(String(url)); },
    },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    assignedUrls,
    store,
    restore: () => {
      (globalThis as unknown as { localStorage: unknown }).localStorage =
        realLocalStorage ?? undefined;
      (globalThis as unknown as { window: unknown }).window = realWindow;
      globalThis.fetch = realFetch;
    },
  };
};

const stubFetch = (
  env: TransportEnv,
  response: () => { ok: boolean; status: number; body: unknown },
): void => {
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    env.calls.push({ url: String(url), init });
    const r = response();
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
};

const LESSON_PATH = `/api/tenants/me/catalog/courses/${COURSE_ID}/units/${UNIT_ID}/lessons`;

test("transport: canonical authenticated GET of one bounded lesson page", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([lesson()]) }));

  const body = await listCourseLessons(COURSE_ID, UNIT_ID);

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, `${LESSON_PATH}?limit=25`);
  assert.equal(env.calls[0].init.method, undefined, "a read: no method override");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-lessons");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    Object.keys(headers).filter((key) => /tenant|scope|workspace|x-/i.test(key)),
    [],
    "no client tenant selector header",
  );
  assert.equal(
    /tenant|workspace/i.test(env.calls[0].url.split("?")[1] ?? ""),
    false,
    "no tenant selector in the query",
  );
  assert.equal(body.lessons.length, 1);
  assert.equal(body.next_cursor, null);
});

test("transport: the opaque cursor is an encoded query parameter", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([]) }));

  await listCourseLessons(COURSE_ID, UNIT_ID, { limit: 25, cursor: "3:abc+/=" });

  assert.equal(env.calls[0].url, `${LESSON_PATH}?limit=25&cursor=3%3Aabc%2B%2F%3D`);
  assert.equal(env.calls.length, 1);
});

test("transport: the create body carries only title and the given optionals", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope(lesson()) }));

  await createCourseLesson(COURSE_ID, UNIT_ID, {
    title: "درس",
    description: "وصف",
    display_order: 4,
  });

  assert.equal(env.calls[0].url, LESSON_PATH);
  assert.equal(env.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), {
    title: "درس",
    description: "وصف",
    display_order: 4,
  });
});

test("transport: a create without optionals sends ONLY the title", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope(lesson()) }));

  await createCourseLesson(COURSE_ID, UNIT_ID, { title: "درس" });

  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { title: "درس" });
});

test("transport: the update body is exactly the given subset (null clears)", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope(lesson()) }));

  await updateCourseLesson(COURSE_ID, UNIT_ID, LESSON_ID, { title: "عنوان" });
  await updateCourseLesson(COURSE_ID, UNIT_ID, LESSON_ID, { description: null });
  await updateCourseLesson(COURSE_ID, UNIT_ID, LESSON_ID, { status: "archived" });

  assert.equal(env.calls[0].url, `${LESSON_PATH}/${LESSON_ID}`);
  assert.equal(env.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { title: "عنوان" });
  assert.deepEqual(JSON.parse(String(env.calls[1].init.body)), { description: null });
  assert.deepEqual(JSON.parse(String(env.calls[2].init.body)), { status: "archived" });
});

test("transport: the reorder body is ONLY items with id and display_order", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: reorderEnvelope([lesson()]) }));

  await reorderCourseLessons(COURSE_ID, UNIT_ID, [{ id: LESSON_ID, display_order: 7 }]);

  assert.equal(env.calls[0].url, `${LESSON_PATH}/reorder`);
  assert.equal(env.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), {
    items: [{ id: LESSON_ID, display_order: 7 }],
  });
});

test("transport: the server message is thrown without the status or the code", async (t) => {
  const env = installTransportEnvironment("token-lessons");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: {
      error:
        "Course lesson management is not available while the account is limited to billing and support",
      code: "BILLING_ONLY",
    },
  }));

  await assert.rejects(
    () => listCourseLessons(COURSE_ID, UNIT_ID),
    (cause: unknown) => {
      assert.ok(cause instanceof Error);
      assert.equal(
        cause.message,
        "Course lesson management is not available while the account is limited to billing and support",
      );
      assert.equal(/BILLING_ONLY/.test(cause.message), false, "the code is not transported");
      assert.equal(/403/.test(cause.message), false, "the status is not transported");
      return true;
    },
  );
  assert.equal(classifyCourseLessonFailure(new Error(
    "Course lesson management is not available while the account is limited to billing and support",
  )).reason, "billing-only");
});

// ===========================================================================
// Runtime DTO / envelope validation
// ===========================================================================

test("parse: the position accepts 0..INTMAX digits and nothing else", () => {
  assert.equal(parseCourseLessonOrder("0"), 0);
  assert.equal(parseCourseLessonOrder(" 12 "), 12);
  assert.equal(parseCourseLessonOrder(String(COURSE_LESSON_DISPLAY_ORDER_MAX)),
    COURSE_LESSON_DISPLAY_ORDER_MAX);
  for (const refused of ["", "-1", "1.5", "1e3", String(COURSE_LESSON_DISPLAY_ORDER_MAX + 1),
    "١٢", "0x10", "1 2", "12px"]) {
    assert.equal(parseCourseLessonOrder(refused), null, `"${refused}" is refused`);
  }
});

test("parse: the title is trimmed 1..255", () => {
  assert.equal(parseCourseLessonTitle("  عنوان  "), "عنوان");
  assert.equal(parseCourseLessonTitle("   "), null);
  assert.equal(parseCourseLessonTitle(""), null);
  assert.equal(parseCourseLessonTitle("a".repeat(255)), "a".repeat(255));
  assert.equal(parseCourseLessonTitle("a".repeat(256)), null);
});

test("parse: the description keeps an empty string and refuses an oversized text", () => {
  assert.equal(parseCourseLessonDescription(""), "", "an empty string is a description");
  assert.equal(parseCourseLessonDescription("x".repeat(COURSE_LESSON_DESCRIPTION_MAX)),
    "x".repeat(COURSE_LESSON_DESCRIPTION_MAX));
  assert.equal(parseCourseLessonDescription("x".repeat(COURSE_LESSON_DESCRIPTION_MAX + 1)), null);
});

test("parse: the exact eight-key DTO of the bound unit is accepted", () => {
  const parsed = parseCourseLesson(lesson(), UNIT_ID);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(Object.keys(parsed.lesson).sort(), [
    "created_at", "description", "display_order", "id", "status", "title", "unit_id", "updated_at",
  ]);
  assert.equal(parsed.lesson.unit_id, UNIT_ID);
});

test("parse: an extra key, a foreign unit, a bad instant, a bad status and a bad order are refused", () => {
  const cases: unknown[] = [
    { ...lesson(), tenant_id: "x" },
    lesson({ unit_id: OTHER_UNIT_ID }),
    lesson({ created_at: "2026-10-21 09:00:00" }),
    lesson({ updated_at: "2026-10-21T09:00:00Z" }),
    lesson({ status: "deleted" as never }),
    lesson({ display_order: -1 }),
    lesson({ display_order: 1.5 }),
    lesson({ display_order: COURSE_LESSON_DISPLAY_ORDER_MAX + 1 }),
    lesson({ title: "   " }),
    lesson({ description: 42 as never }),
    { ...lesson(), id: "not-a-uuid" },
    null,
    [],
  ];
  for (const candidate of cases) {
    assert.equal(parseCourseLesson(candidate, UNIT_ID).ok, false);
  }
});

test("parse: a canonical instant must be a REAL instant, not only the right shape", () => {
  // The SHAPE alone would accept these impossible and calendar-overflow values;
  // the server never emits them, so they are malformed responses.
  for (const impossible of [
    "2026-99-99T88:77:66.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-10-21T23:60:00.000Z",
    "2026-10-21T24:00:00.000Z",
  ]) {
    assert.equal(
      parseCourseLesson(lesson({ created_at: impossible }), UNIT_ID).ok,
      false,
      `created_at ${impossible} is refused`,
    );
    assert.equal(
      parseCourseLesson(lesson({ updated_at: impossible }), UNIT_ID).ok,
      false,
      `updated_at ${impossible} is refused`,
    );
  }
  // The valid canonical control still passes.
  assert.equal(parseCourseLesson(lesson(), UNIT_ID).ok, true);
  // A normalized overflow is not silently accepted as the next real day.
  assert.equal(
    parseCourseLesson(lesson({ created_at: "2026-02-30T00:00:00.000Z" }), UNIT_ID).ok,
    false,
  );
});

test("parse: one impossible instant invalidates the whole list, write and reorder envelope", () => {
  const bad = lesson({ updated_at: "2026-02-30T00:00:00.000Z" });

  assert.equal(parseCourseLessonList(listEnvelope([lesson(), bad]), UNIT_ID).ok, false);
  assert.equal(parseCourseLessonEnvelope(writeEnvelope(bad), UNIT_ID).ok, false);
  assert.equal(parseCourseLessonReorderEnvelope(reorderEnvelope([bad]), UNIT_ID, [bad.id]).ok,
    false);
});

test("parse: an oversized page is refused BEFORE any row is copied", () => {
  const oversized = listEnvelope(pageOf(COURSE_LESSON_PAGE_LIMIT + 1));
  assert.equal(parseCourseLessonList(oversized, UNIT_ID).ok, false);
  // One bad row inside a bounded page is also refused.
  const withForeign = pageOf(3);
  withForeign[1] = { ...withForeign[1], unit_id: OTHER_UNIT_ID };
  assert.equal(parseCourseLessonList(listEnvelope(withForeign), UNIT_ID).ok, false);
});

test("parse: the list envelope rejects a bad cursor, an extra key and a non-array", () => {
  assert.equal(parseCourseLessonList({ lessons: [], next_cursor: "x".repeat(257) }, UNIT_ID).ok,
    false);
  assert.equal(parseCourseLessonList({ lessons: [], next_cursor: "" }, UNIT_ID).ok, false);
  assert.equal(parseCourseLessonList({ lessons: [], next_cursor: 3 }, UNIT_ID).ok, false);
  assert.equal(
    parseCourseLessonList({ lessons: [], next_cursor: null, total: 1 }, UNIT_ID).ok,
    false,
  );
  assert.equal(parseCourseLessonList({ lessons: {}, next_cursor: null }, UNIT_ID).ok, false);
  assert.equal(parseCourseLessonList({ lessons: [], next_cursor: "x".repeat(256) }, UNIT_ID).ok,
    true);
});

test("parse: the single envelope is exactly { lesson }", () => {
  assert.equal(parseCourseLessonEnvelope({ lesson: lesson() }, UNIT_ID).ok, true);
  assert.equal(parseCourseLessonEnvelope({ lesson: lesson(), total: 1 }, UNIT_ID).ok, false);
  assert.equal(parseCourseLessonEnvelope({ lessons: [lesson()] }, UNIT_ID).ok, false);
});

test("parse: the reorder envelope must be the exact requested identity set", () => {
  const requested = [LESSON_ID, OTHER_LESSON_ID];
  const row = (id: string, order: number) => lesson({ id, display_order: order });

  assert.equal(
    parseCourseLessonReorderEnvelope(reorderEnvelope([row(LESSON_ID, 1), row(OTHER_LESSON_ID, 2)]),
      UNIT_ID, requested).ok,
    true,
  );
  // A duplicate identity is refused.
  assert.equal(
    parseCourseLessonReorderEnvelope(reorderEnvelope([row(LESSON_ID, 1), row(LESSON_ID, 2)]),
      UNIT_ID, requested).ok,
    false,
  );
  // A short list is refused.
  assert.equal(
    parseCourseLessonReorderEnvelope(reorderEnvelope([row(LESSON_ID, 1)]), UNIT_ID, requested).ok,
    false,
  );
  // An extra identity is refused.
  assert.equal(
    parseCourseLessonReorderEnvelope(
      reorderEnvelope([row(LESSON_ID, 1), row(OTHER_LESSON_ID, 2), row(lessonIdFor(9), 3)]),
      UNIT_ID,
      requested,
    ).ok,
    false,
  );
  // A foreign unit row is refused.
  assert.equal(
    parseCourseLessonReorderEnvelope(
      reorderEnvelope([row(LESSON_ID, 1), { ...row(OTHER_LESSON_ID, 2), unit_id: OTHER_UNIT_ID }]),
      UNIT_ID,
      requested,
    ).ok,
    false,
  );
  // The client batch bound: more than 25 requested ids is refused.
  const tooMany = Array.from({ length: COURSE_LESSON_REORDER_LIMIT + 1 }, (_, i) => lessonIdFor(i + 1));
  assert.equal(
    parseCourseLessonReorderEnvelope(
      reorderEnvelope(tooMany.map((id, i) => row(id, i))),
      UNIT_ID,
      tooMany,
    ).ok,
    false,
  );
});

test("classify: only documented messages classify an outcome", () => {
  assert.deepEqual(classifyCourseLessonFailure(new Error("Token expired")),
    { phase: "unauthorized", reason: "session", message: "Token expired" });
  assert.equal(classifyCourseLessonFailure(new Error("Forbidden")).reason, "not-owner");
  assert.equal(
    classifyCourseLessonFailure(new Error("Instructor account is administratively suspended")).phase,
    "denied",
  );
  assert.equal(classifyCourseLessonFailure(new Error("Tenant membership not found")).phase,
    "no-workspace");
  assert.equal(classifyCourseLessonFailure(new Error("Course not found")).phase, "missing-course");
  assert.equal(classifyCourseLessonFailure(new Error("Course unit not found")).phase, "missing-unit");
  assert.equal(classifyCourseLessonFailure(new Error("Failed to list course lessons")).reason,
    "server");
  // An unrecognized message never becomes a permission outcome.
  const unknown = classifyCourseLessonFailure(new Error("socket hang up"));
  assert.equal(unknown.phase, "error");
  assert.equal(unknown.reason, "unknown");
  assert.equal(unknown.message, "socket hang up");
  assert.equal(isCourseLessonAuthorizationLoss("unknown"), false);
  assert.equal(isCourseLessonAuthorizationLoss("server"), false);
  assert.equal(isCourseLessonAuthorizationLoss("missing-unit"), true);
});

test("classify: a write failure separates definite, retryable and uncertain", () => {
  assert.equal(classifyCourseLessonWriteFailure(new Error("Token expired")).kind, "unauthorized");
  assert.equal(classifyCourseLessonWriteFailure(new Error("Forbidden")).kind, "denied");
  assert.equal(classifyCourseLessonWriteFailure(new Error("Course lesson not found")).kind,
    "missing");
  assert.equal(
    classifyCourseLessonWriteFailure(new Error("Course lesson was modified concurrently")).kind,
    "conflict",
  );
  assert.equal(
    classifyCourseLessonWriteFailure(new Error("Invalid course lesson payload")).kind,
    "invalid",
  );
  assert.equal(
    classifyCourseLessonWriteFailure(new Error("Failed to reorder course lessons")).kind,
    "uncertain",
  );
  assert.equal(classifyCourseLessonWriteFailure(new TypeError("Failed to fetch")).kind,
    "uncertain");
});

// ===========================================================================
// Read lifecycle
// ===========================================================================

test("read: nothing is requested before an explicit open", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    assert.equal(controller.getState().open, false);
    assert.equal(controller.getState().phase, "idle");
    await controller.refresh();
    controller.openCreateForm();
    assert.equal(harness.listCalls.length, 0, "no read before the panel is opened");
    assert.equal(controller.getState().form.mode, "closed");
  } finally {
    controller.dispose();
  }
});

test("read: open issues exactly one bounded page and reports ready", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);

    assert.equal(harness.listCalls.length, 1);
    assert.deepEqual(harness.listCalls[0], {
      courseId: COURSE_ID,
      unitId: UNIT_ID,
      limit: COURSE_LESSON_PAGE_LIMIT,
      cursor: null,
    });
    const state = controller.getState();
    assert.equal(state.phase, "ready");
    assert.equal(state.rows.length, 1);
    assert.equal(state.nextCursor, null);
    assert.equal(state.hasPreviousPage, false);
    assert.equal(controller.courseId, COURSE_ID);
    assert.equal(controller.unitId, UNIT_ID);
  } finally {
    controller.dispose();
  }
});

test("read: an empty page is empty, not an error", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, []);
    assert.equal(controller.getState().phase, "empty");
    assert.deepEqual(controller.getState().rows, []);
    assert.equal(controller.getState().error, null);
  } finally {
    controller.dispose();
  }
});

test("read: the documented denials keep their own phase and clear the rows", async () => {
  const cases: { message: string; phase: string; reason: string }[] = [
    { message: "Token expired", phase: "unauthorized", reason: "session" },
    { message: "Forbidden", phase: "denied", reason: "not-owner" },
    {
      message:
        "Course lesson management is not available while the account is limited to billing and support",
      phase: "denied",
      reason: "billing-only",
    },
    {
      message: "Instructor account is administratively suspended",
      phase: "denied",
      reason: "suspended",
    },
    { message: "Tenant membership not found", phase: "no-workspace", reason: "no-workspace" },
    { message: "Course not found", phase: "missing-course", reason: "missing-course" },
    { message: "Course unit not found", phase: "missing-unit", reason: "missing-unit" },
  ];
  for (const expected of cases) {
    const harness = createHarness();
    const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
    try {
      const operation = controller.open();
      await flush();
      harness.lists[0].reject(new Error(expected.message));
      await operation;
      const state = controller.getState();
      assert.equal(state.phase, expected.phase, expected.message);
      assert.equal(state.reason, expected.reason, expected.message);
      assert.equal(state.error, expected.message, "the server's own message is shown");
      assert.deepEqual(state.rows, [], "a denial never keeps private rows");
      assert.deepEqual(state.selectedIds, []);
      assert.equal(state.form.mode, "closed");
    } finally {
      controller.dispose();
    }
  }
});

test("read: a malformed page is malformed, never an empty list", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    const operation = controller.open();
    await flush();
    harness.lists[0].resolve({ lessons: [{ id: "nope" }] } as never);
    await operation;
    const state = controller.getState();
    assert.equal(state.phase, "malformed");
    assert.equal(state.error, MALFORMED_COURSE_LESSON_MESSAGE);
    assert.deepEqual(state.rows, []);
  } finally {
    controller.dispose();
  }
});

test("read: paging uses the server cursor and the first page drops it", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson()], "cursor-2");

    const nextOperation = controller.nextPage();
    await flush();
    assert.equal(harness.listCalls[1].cursor, "cursor-2");
    assert.equal(harness.listCalls[1].limit, COURSE_LESSON_PAGE_LIMIT);
    harness.lists[1].resolve(listEnvelope([lesson({ id: OTHER_LESSON_ID })]));
    await nextOperation;
    assert.equal(controller.getState().hasPreviousPage, true);

    const firstOperation = controller.firstPage();
    await flush();
    assert.equal(harness.listCalls[2].cursor, null);
    harness.lists[2].resolve(listEnvelope([lesson()]));
    await firstOperation;
    assert.equal(controller.getState().hasPreviousPage, false);
    // No accumulation: the page is replaced, never appended.
    assert.equal(controller.getState().rows.length, 1);
  } finally {
    controller.dispose();
  }
});

test("read: close clears the rows, the selection and the drafts, and drops the reply", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson()]);
    controller.toggleSelection(LESSON_ID);
    controller.openEditForm(LESSON_ID);
    controller.updateTitleDraft("مسودة");
    assert.equal(controller.getState().selectedIds.length, 1);

    const refreshOperation = controller.refresh();
    await flush();
    controller.close();

    assert.equal(controller.getState().open, false);
    assert.deepEqual(controller.getState().rows, []);
    assert.deepEqual(controller.getState().selectedIds, []);
    assert.equal(controller.getState().form.mode, "closed");

    harness.lists[1].resolve(listEnvelope([lesson({ title: "متأخر" })]));
    await refreshOperation;
    assert.deepEqual(controller.getState().rows, [], "a late reply never restores private rows");
  } finally {
    controller.dispose();
  }
});

test("read: a session event clears the private state and re-reads when open", async () => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, {
    ...harness.api,
    subscribeSession: sink.subscribeSession,
  });
  try {
    await openReady(harness, controller, [lesson()]);
    controller.toggleSelection(LESSON_ID);

    sink.fire();
    assert.deepEqual(controller.getState().rows, []);
    assert.deepEqual(controller.getState().selectedIds, []);
    await flush();
    assert.equal(harness.listCalls.length, 2, "one re-read after the session event");
    harness.lists[1].resolve(listEnvelope([]));
    await flush();
    assert.equal(controller.getState().phase, "empty");
  } finally {
    controller.dispose();
  }
});

// ===========================================================================
// Write lifecycle
// ===========================================================================

test("write: an invalid title never reaches the transport", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openCreateForm();
    controller.updateTitleDraft("   ");
    await controller.create();

    assert.equal(harness.createCalls.length, 0);
    assert.equal(controller.getState().form.error, COURSE_LESSON_TITLE_INVALID_MESSAGE);
    assert.equal(controller.getState().form.mode, "create", "the draft survives the refusal");
  } finally {
    controller.dispose();
  }
});

test("write: an invalid position and an oversized description never reach the transport", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);

    controller.openCreateForm();
    controller.updateTitleDraft("درس");
    controller.updateOrderDraft("-3");
    await controller.create();
    assert.equal(harness.createCalls.length, 0);
    assert.equal(controller.getState().form.error, COURSE_LESSON_ORDER_INVALID_MESSAGE);

    controller.updateOrderDraft("3");
    controller.updateDescriptionDraft("x".repeat(COURSE_LESSON_DESCRIPTION_MAX + 1));
    await controller.create();
    assert.equal(harness.createCalls.length, 0);
    assert.equal(controller.getState().form.error, COURSE_LESSON_DESCRIPTION_INVALID_MESSAGE);
  } finally {
    controller.dispose();
  }
});

test("write: a synchronous double submit sends exactly one create", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openCreateForm();
    controller.updateTitleDraft("درس جديد");

    void controller.create();
    void controller.create();
    await flush();

    assert.equal(harness.createCalls.length, 1, "the second click never reaches the transport");
    assert.deepEqual(harness.createCalls[0].input, { title: "درس جديد" });
  } finally {
    controller.dispose();
  }
});

test("write: a confirmed create closes the form and issues ONE bounded follow-up read", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, []);
    controller.openCreateForm();
    controller.updateTitleDraft("درس جديد");
    controller.updateDescriptionDraft("وصف");
    controller.updateOrderDraft("2");

    const operation = controller.create();
    await flush();
    assert.deepEqual(harness.createCalls[0].input, {
      title: "درس جديد",
      description: "وصف",
      display_order: 2,
    });
    assert.equal(controller.getState().mutation.status, "saving");

    harness.creates[0].resolve(writeEnvelope(lesson({ id: OTHER_LESSON_ID, title: "درس جديد" })));
    await flush();
    assert.equal(harness.listCalls.length, 2, "exactly one bounded follow-up read");
    harness.lists[1].resolve(listEnvelope([lesson({ id: OTHER_LESSON_ID, title: "درس جديد" })]));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "idle");
    assert.equal(state.form.mode, "closed");
    assert.equal(state.lastConfirmed?.id, OTHER_LESSON_ID);
    assert.equal(state.rows.length, 1);
  } finally {
    controller.dispose();
  }
});

test("write: a failed follow-up read never turns a confirmed save into a failed save", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, []);
    controller.openCreateForm();
    controller.updateTitleDraft("درس");

    const operation = controller.create();
    await flush();
    harness.creates[0].resolve(writeEnvelope(lesson({ id: OTHER_LESSON_ID, title: "درس" })));
    await flush();
    harness.lists[1].reject(new Error("Failed to list course lessons"));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "idle", "the save stays confirmed");
    assert.equal(state.lastConfirmed?.id, OTHER_LESSON_ID);
    assert.equal(state.refreshError, "Failed to list course lessons");
  } finally {
    controller.dispose();
  }
});

test("write: an unchanged edit sends nothing and says so", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openEditForm(LESSON_ID);
    await controller.save();

    assert.equal(harness.updateCalls.length, 0);
    assert.equal(controller.getState().form.error, COURSE_LESSON_NO_CHANGES_MESSAGE);
    assert.equal(controller.getState().form.mode, "edit");
  } finally {
    controller.dispose();
  }
});

test("write: an explicit clear sends description null, and only the changed subset", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson({ description: "قديم" })]);
    controller.openEditForm(LESSON_ID);
    controller.setClearDescription(true);

    void controller.save();
    await flush();

    assert.deepEqual(harness.updateCalls[0].update, { description: null });
    assert.equal(harness.updateCalls[0].lessonId, LESSON_ID);
  } finally {
    controller.dispose();
  }
});

test("write: a title change sends only the title and no follow-up read", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openEditForm(LESSON_ID);
    controller.updateTitleDraft("عنوان جديد");

    const operation = controller.save();
    await flush();
    assert.deepEqual(harness.updateCalls[0].update, { title: "عنوان جديد" });
    harness.updates[0].resolve(writeEnvelope(lesson({ title: "عنوان جديد" })));
    await operation;

    assert.equal(harness.listCalls.length, 1, "a title-only save needs no re-read");
    assert.equal(controller.getState().rows[0].title, "عنوان جديد");
  } finally {
    controller.dispose();
  }
});

test("write: an order change re-reads the page so the canonical order is shown", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openEditForm(LESSON_ID);
    controller.updateOrderDraft("9");

    const operation = controller.save();
    await flush();
    assert.deepEqual(harness.updateCalls[0].update, { display_order: 9 });
    harness.updates[0].resolve(writeEnvelope(lesson({ display_order: 9 })));
    await flush();
    assert.equal(harness.listCalls.length, 2, "one bounded re-read after a position change");
    harness.lists[1].resolve(listEnvelope([lesson({ display_order: 9 })]));
    await operation;
    assert.equal(controller.getState().rows[0].display_order, 9);
  } finally {
    controller.dispose();
  }
});

test("write: archive and reactivate are separate explicit status writes", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);

    void controller.setStatus(LESSON_ID, "archived");
    await flush();
    assert.deepEqual(harness.updateCalls[0].update, { status: "archived" });
    harness.updates[0].resolve(writeEnvelope(lesson({ status: "archived" })));
    await flush();
    assert.equal(controller.getState().rows[0].status, "archived");

    // A status write for the status the row already has is not sent.
    await controller.setStatus(LESSON_ID, "archived");
    assert.equal(harness.updateCalls.length, 1);

    void controller.setStatus(LESSON_ID, "active");
    await flush();
    assert.deepEqual(harness.updateCalls[1].update, { status: "active" });
    harness.updates[1].resolve(writeEnvelope(lesson({ status: "active" })));
    await flush();
    assert.equal(controller.getState().rows[0].status, "active");
  } finally {
    controller.dispose();
  }
});

test("write: a handler 500 stays uncertain, preserves the draft and is never retried", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openCreateForm();
    controller.updateTitleDraft("درس غير مؤكد");

    const operation = controller.create();
    await flush();
    harness.creates[0].reject(new Error("Failed to create course lesson"));
    await operation;
    await flush();

    const state = controller.getState();
    assert.equal(state.mutation.status, "uncertain");
    assert.equal(state.mutation.notice, COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE);
    assert.equal(state.form.mode, "create", "the draft is preserved");
    assert.equal(state.form.titleDraft, "درس غير مؤكد");
    assert.equal(harness.createCalls.length, 1, "no automatic retry");
  } finally {
    controller.dispose();
  }
});

test("write: a network failure and a malformed 2xx are both uncertain", async () => {
  for (const settle of [
    (harness: Harness) => harness.creates[0].reject(new TypeError("Failed to fetch")),
    (harness: Harness) => harness.creates[0].resolve({ lesson: { id: "bad" } } as never),
  ]) {
    const harness = createHarness();
    const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
    try {
      await openReady(harness, controller);
      controller.openCreateForm();
      controller.updateTitleDraft("درس");
      const operation = controller.create();
      await flush();
      settle(harness);
      await operation;
      assert.equal(controller.getState().mutation.status, "uncertain");
      assert.equal(controller.getState().form.mode, "create");
      assert.equal(harness.createCalls.length, 1);
    } finally {
      controller.dispose();
    }
  }
});

test("write: a 2xx body with an impossible instant is never a confirmed write and is never retried", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openCreateForm();
    controller.updateTitleDraft("درس");
    const operation = controller.create();
    await flush();
    harness.creates[0].resolve(
      writeEnvelope(lesson({ created_at: "2026-99-99T88:77:66.000Z" })),
    );
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "uncertain",
      "a 2xx with an impossible instant is not a confirmation");
    assert.equal(state.lastConfirmed, null, "nothing is confirmed");
    assert.equal(state.form.mode, "create", "the draft is preserved");
    assert.equal(harness.createCalls.length, 1, "the write is never retried");
    assert.equal(harness.listCalls.length, 1, "an unconfirmed write triggers no follow-up read");
  } finally {
    controller.dispose();
  }
});

test("write: a 2xx PATCH with an impossible instant leaves the row untouched and unconfirmed", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openEditForm(LESSON_ID);
    controller.updateTitleDraft("عنوان جديد");

    const operation = controller.save();
    await flush();
    harness.updates[0].resolve(
      writeEnvelope(lesson({ title: "عنوان جديد", updated_at: "2026-02-30T00:00:00.000Z" })),
    );
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "uncertain");
    assert.equal(state.lastConfirmed, null);
    assert.equal(state.rows[0].title, "الدرس الأول", "the row is untouched by the malformed reply");
    assert.equal(harness.updateCalls.length, 1, "the write is never retried");
  } finally {
    controller.dispose();
  }
});

test("reorder: a 2xx batch with an impossible instant is never applied and never retried", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson(), lesson({ id: OTHER_LESSON_ID, display_order: 1 })]);
    controller.toggleSelection(LESSON_ID);
    controller.toggleSelection(OTHER_LESSON_ID);
    controller.openReorderForm();
    controller.updateReorderDraft(LESSON_ID, "5");

    const operation = controller.submitReorder();
    await flush();
    harness.reorders[0].resolve(reorderEnvelope([
      lesson({ display_order: 5, updated_at: "2026-99-99T88:77:66.000Z" }),
      lesson({ id: OTHER_LESSON_ID, display_order: 1 }),
    ]));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "uncertain");
    assert.equal(state.lastReorder, null, "no batch is reported as applied");
    assert.equal(state.rows[0].display_order, 0, "the rows are untouched");
    assert.equal(harness.reorderCalls.length, 1, "the batch is never retried");
  } finally {
    controller.dispose();
  }
});

test("write: a PATCH answered for ANOTHER lesson is not a success for this write", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openEditForm(LESSON_ID);
    controller.updateTitleDraft("عنوان جديد");

    const operation = controller.save();
    await flush();
    harness.updates[0].resolve(writeEnvelope(lesson({ id: OTHER_LESSON_ID, title: "عنوان جديد" })));
    await operation;

    const state = controller.getState();
    assert.equal(state.mutation.status, "uncertain");
    assert.equal(state.lastConfirmed, null);
    assert.equal(state.rows[0].title, "الدرس الأول", "the row is untouched by the foreign reply");
    assert.equal(state.form.mode, "edit", "the draft is preserved");
  } finally {
    controller.dispose();
  }
});

test("write: reconcile is an explicit read that never claims the write succeeded", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openCreateForm();
    controller.updateTitleDraft("درس");
    const operation = controller.create();
    await flush();
    harness.creates[0].reject(new Error("Failed to create course lesson"));
    await operation;
    assert.equal(controller.getState().mutation.status, "uncertain");

    const reconcileOperation = controller.reconcile();
    await flush();
    assert.equal(harness.listCalls.length, 2, "a read, never a write");
    assert.equal(harness.createCalls.length, 1, "the write is never retried");
    harness.lists[1].resolve(listEnvelope([lesson()]));
    await reconcileOperation;

    const state = controller.getState();
    assert.equal(state.mutation.notice, COURSE_LESSON_RECONCILED_MESSAGE);
    assert.equal(state.lastConfirmed, null, "a read is not proof of the previous write");
  } finally {
    controller.dispose();
  }
});

test("write: a confirmed write releases its OWN ticket before the follow-up read", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson()]);
    controller.openCreateForm();
    controller.updateTitleDraft("درس جديد");

    const createOperation = controller.create();
    await flush();
    harness.creates[0].resolve(writeEnvelope(lesson({ id: OTHER_LESSON_ID, title: "درس جديد" })));
    await flush();
    // The bounded follow-up read is still on the wire here.
    assert.equal(harness.listCalls.length, 2);

    // The latch is already free, so an enabled control is not a silent no-op.
    void controller.setStatus(LESSON_ID, "archived");
    await flush();
    assert.equal(harness.updateCalls.length, 1, "the next action reaches the transport");

    harness.updates[0].resolve(writeEnvelope(lesson({ status: "archived" })));
    harness.lists[1].resolve(listEnvelope([lesson({ status: "archived" })]));
    await createOperation;
    await flush();
  } finally {
    controller.dispose();
  }
});

test("write: an older finally never frees a NEWER mutation's latch", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson(), lesson({ id: OTHER_LESSON_ID })]);

    // Write A: confirmed, its follow-up read is still pending.
    controller.openCreateForm();
    controller.updateTitleDraft("درس أ");
    const writeA = controller.create();
    await flush();
    harness.creates[0].resolve(writeEnvelope(lesson({ id: lessonIdFor(77), title: "درس أ" })));
    await flush();
    assert.equal(harness.listCalls.length, 2, "A's follow-up read is pending");

    // Write B starts while A's follow-up read is on the wire.
    void controller.setStatus(LESSON_ID, "archived");
    await flush();
    assert.equal(harness.updateCalls.length, 1);

    // A completes: its `finally` releases A's ALREADY released ticket.
    harness.lists[1].resolve(listEnvelope([lesson(), lesson({ id: OTHER_LESSON_ID })]));
    await writeA;
    await flush();

    // B is still in flight, so a third action must NOT reach the transport.
    void controller.setStatus(OTHER_LESSON_ID, "archived");
    await flush();
    assert.equal(harness.updateCalls.length, 1, "B's latch is still held by B");

    harness.updates[0].resolve(writeEnvelope(lesson({ status: "archived" })));
    await flush();
    // Now the latch is free again.
    void controller.setStatus(OTHER_LESSON_ID, "archived");
    await flush();
    assert.equal(harness.updateCalls.length, 2);
  } finally {
    controller.dispose();
  }
});

test("write: a stale read never overwrites a newer confirmed write", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson()]);

    // Read R1 starts BEFORE the write.
    const staleRead = controller.refresh();
    await flush();
    assert.equal(harness.listCalls.length, 2);

    // A confirmed write lands while R1 is on the wire.
    controller.openEditForm(LESSON_ID);
    controller.updateTitleDraft("مؤكد");
    const write = controller.save();
    await flush();
    harness.updates[0].resolve(writeEnvelope(lesson({ title: "مؤكد" })));
    await write;

    // R1 now answers with a stale page.
    harness.lists[1].resolve(listEnvelope([lesson({ title: "قديم" })]));
    await staleRead;
    await flush();

    assert.equal(controller.getState().rows[0].title, "مؤكد",
      "the stale page never overwrites the confirmed write");
  } finally {
    controller.dispose();
  }
});

// ===========================================================================
// Atomic reorder
// ===========================================================================

test("reorder: only a row of the current page can be selected", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson()]);
    controller.toggleSelection(OTHER_LESSON_ID);
    assert.deepEqual(controller.getState().selectedIds, [], "an invisible id is ignored");

    controller.toggleSelection(LESSON_ID);
    assert.deepEqual(controller.getState().selectedIds, [LESSON_ID]);
    controller.toggleSelection(LESSON_ID);
    assert.deepEqual(controller.getState().selectedIds, []);
  } finally {
    controller.dispose();
  }
});

test("reorder: an empty selection opens no form and issues no request", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    controller.openReorderForm();

    assert.equal(controller.getState().form.mode, "closed");
    assert.equal(controller.getState().mutation.error, COURSE_LESSON_SELECTION_INVALID_MESSAGE);
    assert.equal(harness.reorderCalls.length, 0);
  } finally {
    controller.dispose();
  }
});

test("reorder: an invalid position blocks the whole batch", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson(), lesson({ id: OTHER_LESSON_ID, display_order: 1 })]);
    controller.toggleSelection(LESSON_ID);
    controller.toggleSelection(OTHER_LESSON_ID);
    controller.openReorderForm();
    controller.updateReorderDraft(LESSON_ID, "7");
    controller.updateReorderDraft(OTHER_LESSON_ID, "-1");

    await controller.submitReorder();

    assert.equal(harness.reorderCalls.length, 0, "no partial batch is ever sent");
    assert.equal(controller.getState().form.error, COURSE_LESSON_ORDER_INVALID_MESSAGE);
    assert.equal(controller.getState().form.mode, "reorder");
  } finally {
    controller.dispose();
  }
});

test("reorder: a batch that changes nothing is not sent", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson(), lesson({ id: OTHER_LESSON_ID, display_order: 1 })]);
    controller.toggleSelection(LESSON_ID);
    controller.toggleSelection(OTHER_LESSON_ID);
    controller.openReorderForm();

    await controller.submitReorder();

    assert.equal(harness.reorderCalls.length, 0);
    assert.equal(controller.getState().form.error, COURSE_LESSON_REORDER_NO_CHANGES_MESSAGE);
  } finally {
    controller.dispose();
  }
});

test("reorder: ONE atomic request for the whole 25-row selection", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    const page = pageOf(COURSE_LESSON_REORDER_LIMIT);
    await openReady(harness, controller, page);
    for (const row of page) controller.toggleSelection(row.id);
    assert.equal(controller.getState().selectedIds.length, COURSE_LESSON_REORDER_LIMIT);

    controller.openReorderForm();
    assert.equal(controller.getState().form.reorderDrafts.length, COURSE_LESSON_REORDER_LIMIT);
    controller.updateReorderDraft(page[0].id, "99");

    const operation = controller.submitReorder();
    await flush();

    assert.equal(harness.reorderCalls.length, 1, "exactly one batch request");
    assert.equal(harness.reorderCalls[0].items.length, COURSE_LESSON_REORDER_LIMIT);
    assert.equal(harness.updateCalls.length, 0, "no per-row write loop");
    assert.deepEqual(harness.reorderCalls[0].items[0], {
      id: page[0].id,
      display_order: 99,
    });

    harness.reorders[0].resolve(
      reorderEnvelope(
        harness.reorderCalls[0].items.map((item) =>
          lesson({ id: item.id, display_order: item.display_order })),
      ),
    );
    await flush();
    harness.lists[1].resolve(listEnvelope(page));
    await operation;

    const state = controller.getState();
    assert.equal(state.lastReorder?.selected, COURSE_LESSON_REORDER_LIMIT);
    assert.equal(state.lastReorder?.changed, 1, "only the changed row is counted");
    assert.deepEqual(state.selectedIds, []);
    assert.equal(state.form.mode, "closed");
  } finally {
    controller.dispose();
  }
});

test("reorder: a response that is not the exact identity set is uncertain", async () => {
  for (const answer of [
    // A short list.
    (items: { id: string; display_order: number }[]) =>
      reorderEnvelope([lesson({ id: items[0].id, display_order: 5 })]),
    // A duplicate identity.
    (items: { id: string; display_order: number }[]) =>
      reorderEnvelope([
        lesson({ id: items[0].id, display_order: 5 }),
        lesson({ id: items[0].id, display_order: 6 }),
      ]),
    // An extra identity.
    (items: { id: string; display_order: number }[]) =>
      reorderEnvelope([
        ...items.map((item) => lesson({ id: item.id, display_order: item.display_order })),
        lesson({ id: lessonIdFor(90), display_order: 9 }),
      ]),
  ]) {
    const harness = createHarness();
    const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
    try {
      await openReady(harness, controller, [
        lesson(),
        lesson({ id: OTHER_LESSON_ID, display_order: 1 }),
      ]);
      controller.toggleSelection(LESSON_ID);
      controller.toggleSelection(OTHER_LESSON_ID);
      controller.openReorderForm();
      controller.updateReorderDraft(LESSON_ID, "5");

      const operation = controller.submitReorder();
      await flush();
      harness.reorders[0].resolve(answer(harness.reorderCalls[0].items) as never);
      await operation;

      const state = controller.getState();
      assert.equal(state.mutation.status, "uncertain");
      assert.equal(state.lastReorder, null, "a foreign/partial batch is never a success");
      assert.equal(state.rows[0].display_order, 0, "nothing is applied");
      assert.equal(harness.reorderCalls.length, 1, "no retry");
    } finally {
      controller.dispose();
    }
  }
});

test("reorder: the selection is cleared by a page change and by close", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller, [lesson()], "cursor-2");
    controller.toggleSelection(LESSON_ID);
    assert.equal(controller.getState().selectedIds.length, 1);

    const nextOperation = controller.nextPage();
    await flush();
    harness.lists[1].resolve(listEnvelope([lesson({ id: OTHER_LESSON_ID })]));
    await nextOperation;
    assert.deepEqual(controller.getState().selectedIds, [],
      "the selection is bound to the page instance the user saw");

    controller.toggleSelection(OTHER_LESSON_ID);
    controller.close();
    assert.deepEqual(controller.getState().selectedIds, []);
  } finally {
    controller.dispose();
  }
});

// ===========================================================================
// The real component, rendered by the real React server renderer
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

const lessonState = (overrides: Partial<CourseLessonState> = {}): CourseLessonState => ({
  open: true,
  phase: "ready",
  rows: [lesson()],
  nextCursor: null,
  hasPreviousPage: false,
  error: null,
  reason: null,
  refreshError: null,
  lastConfirmed: null,
  lastReorder: null,
  selectedIds: [],
  form: {
    mode: "closed",
    titleDraft: "",
    descriptionDraft: "",
    clearDescription: false,
    orderDraft: "",
    targetId: null,
    targetTitle: null,
    originalTitle: null,
    originalDescription: null,
    originalOrder: null,
    reorderDrafts: [],
    error: null,
  },
  mutation: { status: "idle", kind: null, targetId: null, error: null, notice: null },
  ...overrides,
});

/**
 * Renders the REAL `CourseLessonManager` with the REAL React server renderer and
 * the REAL shared UI primitives. Only the hook snapshot is injected, so the
 * markup comes from the production component while no request, no browser and no
 * live service is involved.
 */
const renderLessonPanel = async (snapshot: CourseLessonState): Promise<string> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/catalog/CourseLessonManager.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /CourseLessonManager\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [snapshot, () => {}],
          useRef: () => ({ current: null }),
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(this, path.resolve(SRC_ROOT, specifier.slice(2)), parent, isMain);
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    // The component binds its hooks at load time, so the module is loaded again
    // for every snapshot: a cached module would keep rendering the FIRST one.
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (...args: unknown[]) => unknown;
    (globalThis as { React?: unknown }).React = React;
    const tree = Component({ courseId: COURSE_ID, unitId: UNIT_ID, unitName: "الوحدة الأولى" });
    return renderToStaticMarkup(tree as never);
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

/**
 * Renders the REAL component as a REACT TREE with the REAL controller in the
 * ref, so the ACTUAL control callbacks can be invoked exactly as a user click
 * would (the 179 finding: markup alone cannot show a callback).
 */
const renderLessonPanelTree = async (controller: CourseLessonController): Promise<unknown> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const componentPath = projectRequire.resolve("../features/catalog/CourseLessonManager.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /CourseLessonManager\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [controller.getState(), () => {}],
          useRef: () => ({ current: controller }),
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(this, path.resolve(SRC_ROOT, specifier.slice(2)), parent, isMain);
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (...args: unknown[]) => unknown;
    (globalThis as { React?: unknown }).React = React;
    return Component({ courseId: COURSE_ID, unitId: UNIT_ID, unitName: "الوحدة الأولى" });
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

/** The text a production element renders, without copying any render logic. */
const treeText = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join("");
  const element = node as { props?: { children?: unknown } } | null;
  if (element?.props) return treeText(element.props.children);
  return "";
};

interface ProductionControl {
  readonly text: string;
  readonly disabled: unknown;
  readonly onClick: () => void;
}

/** Every production control of the rendered tree that carries a click. */
const collectControls = (node: unknown, found: ProductionControl[] = []): ProductionControl[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectControls(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (typeof element.props.onClick === "function") {
    found.push({
      text: treeText(node),
      disabled: element.props.disabled,
      onClick: element.props.onClick as () => void,
    });
  }
  collectControls(element.props.children, found);
  return found;
};

/** The opening tag of the button whose label carries `needle`. */
const buttonOpeningTag = (html: string, needle: string): string => {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
  const found = buttons.find((button) => button.includes(needle));
  assert.ok(found, `the rendered "${needle}" button exists`);
  return found.slice(0, found.indexOf(">") + 1);
};

/**
 * The HTML `disabled` ATTRIBUTE of a rendered button. Deliberately
 * attribute-shaped, so the shared design-system utility classes
 * (`disabled:pointer-events-none`, `disabled:opacity-50`) are never mistaken for
 * the disabled state of this control.
 */
const hasDisabledAttribute = (openingTag: string): boolean =>
  /\sdisabled(?:=|\s|>)/.test(openingTag);

test("component: a closed panel renders only the explicit open control", async () => {
  const html = await renderLessonPanel(lessonState({ open: false, phase: "idle", rows: [] }));
  assert.ok(html.includes('dir="rtl"'), "the panel is RTL");
  assert.ok(html.includes("فتح لوحة الدروس"), "the explicit open control is present");
  assert.equal(html.includes("الدرس الأول"), false, "no private row before the open");
  assert.equal(html.includes("<form"), false, "no form before the open");
});

test("component: a ready panel renders the rows, the notices and bound labels", async () => {
  const html = await renderLessonPanel(lessonState({
    form: {
      ...lessonState().form,
      mode: "create",
    },
  }));

  assert.ok(html.includes("الدرس الأول"));
  assert.ok(html.includes("الموضع: 0"));
  assert.ok(html.includes('for="course-lesson-title"'), "the title label is bound");
  assert.ok(html.includes('id="course-lesson-title"'));
  assert.ok(html.includes('for="course-lesson-description"'));
  assert.ok(html.includes('for="course-lesson-clear-description"'));
  assert.ok(html.includes('for="course-lesson-order"'));
  assert.ok(html.includes('aria-live="polite"'), "the feedback region is live");
  assert.ok(html.includes("عناوين الدروس مسموح بتكرارها"), "the duplicate-create warning is shown");
});

test("component: exactly one submit control, and it is inside the open form", async () => {
  const html = await renderLessonPanel(lessonState({
    form: { ...lessonState().form, mode: "create" },
  }));

  const submits = html.match(/type="submit"/g) || [];
  assert.equal(submits.length, 1, "one deliberate submit");
  const formStart = html.indexOf("<form");
  const formEnd = html.indexOf("</form>");
  assert.ok(formStart >= 0 && formEnd > formStart);
  assert.ok(html.slice(formStart, formEnd).includes('type="submit"'));

  // Every other button is explicitly type=button, never a browser default submit.
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  const withoutType = buttons.filter((tag) => !/type="(button|submit)"/.test(tag));
  assert.deepEqual(withoutType, [], "no button relies on the browser default");
});

test("component: the close control stays usable while a write is pending", async () => {
  const html = await renderLessonPanel(lessonState({
    mutation: { status: "saving", kind: "edit", targetId: LESSON_ID, error: null, notice: null },
  }));

  const closeTag = buttonOpeningTag(html, "إغلاق اللوحة");
  assert.equal(hasDisabledAttribute(closeTag), false, "close is never latched disabled");
  const archiveTag = buttonOpeningTag(html, "أرشفة");
  assert.equal(hasDisabledAttribute(archiveTag), true, "the row write is disabled while saving");
  // A READ stays available during a write: it is a different flight.
  const refreshTag = buttonOpeningTag(html, "تحديث القائمة");
  assert.equal(hasDisabledAttribute(refreshTag), false, "a read is not latched by a write");
});

test("component: a definite failure keeps its message without latching the row", async () => {
  const html = await renderLessonPanel(lessonState({
    mutation: {
      status: "idle",
      kind: null,
      targetId: null,
      error: "Course lesson was modified concurrently",
      notice: null,
    },
  }));

  assert.ok(html.includes("Course lesson was modified concurrently"));
  const archiveTag = buttonOpeningTag(html, "أرشفة");
  assert.equal(hasDisabledAttribute(archiveTag), false,
    "a definite failure never latches the control disabled");
});

test("component: the reorder form renders one bound input per selected row", async () => {
  const rows = [lesson(), lesson({ id: OTHER_LESSON_ID, title: "الدرس الثاني", display_order: 1 })];
  const html = await renderLessonPanel(lessonState({
    rows,
    selectedIds: [LESSON_ID, OTHER_LESSON_ID],
    form: {
      ...lessonState().form,
      mode: "reorder",
      reorderDrafts: [
        { id: LESSON_ID, title: "الدرس الأول", orderDraft: "0" },
        { id: OTHER_LESSON_ID, title: "الدرس الثاني", orderDraft: "1" },
      ],
    },
  }));

  assert.ok(html.includes(`id="course-lesson-reorder-${LESSON_ID}"`));
  assert.ok(html.includes(`for="course-lesson-reorder-${LESSON_ID}"`));
  assert.ok(html.includes(`id="course-lesson-reorder-${OTHER_LESSON_ID}"`));
  assert.ok(html.includes("دفعة واحدة ذرّية"), "the atomic batch is stated");
});

test("component: an uncertain write offers only an explicit reconciliation read", async () => {
  const html = await renderLessonPanel(lessonState({
    mutation: {
      status: "uncertain",
      kind: "create",
      targetId: null,
      error: null,
      notice: COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE,
    },
  }));

  assert.ok(html.includes(COURSE_LESSON_WRITE_UNCERTAIN_MESSAGE));
  const reconcileTag = buttonOpeningTag(html, "قراءة القائمة الحالية");
  assert.equal(hasDisabledAttribute(reconcileTag), false);
  assert.ok(html.includes("لا تؤكد نجاح الحفظ السابق"));
});

test("component: the real archive control performs the real write", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    const controls = collectControls(await renderLessonPanelTree(controller));
    const archive = controls.find((control) => control.text.includes("أرشفة"));
    assert.ok(archive, "the archive control exists");
    assert.equal(archive.disabled, false, "it is enabled, so it must not be a no-op");

    archive.onClick();
    await flush();

    assert.equal(harness.updateCalls.length, 1, "the click reached the transport");
    assert.deepEqual(harness.updateCalls[0].update, { status: "archived" });
  } finally {
    controller.dispose();
  }
});

test("component: the real close control closes the panel", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    const controls = collectControls(await renderLessonPanelTree(controller));
    const close = controls.find((control) => control.text.includes("إغلاق اللوحة"));
    assert.ok(close);
    assert.equal(Boolean(close.disabled), false, "the close control carries no disabled state");

    close.onClick();
    assert.equal(controller.getState().open, false);
    assert.deepEqual(controller.getState().rows, []);
  } finally {
    controller.dispose();
  }
});

test("component: the real selection toggle feeds the reorder form", async () => {
  const harness = createHarness();
  const controller = createCourseLessonController(COURSE_ID, UNIT_ID, harness.api);
  try {
    await openReady(harness, controller);
    const controls = collectControls(await renderLessonPanelTree(controller));
    // The toolbar also carries "ترتيب التحديد" / "إلغاء التحديد", so the ROW
    // toggle is matched by its exact label rather than by a substring.
    const toggle = controls.find((control) => control.text.trim() === "تحديد");
    assert.ok(toggle, "the selection control exists");

    toggle.onClick();
    assert.deepEqual(controller.getState().selectedIds, [LESSON_ID]);

    controller.openReorderForm();
    assert.equal(controller.getState().form.mode, "reorder");
    assert.equal(controller.getState().form.reorderDrafts.length, 1);
  } finally {
    controller.dispose();
  }
});

// ===========================================================================
// The additive parent mount in the REAL CourseUnitManager
// ===========================================================================

const unit = (overrides: Partial<CourseUnit> = {}): CourseUnit => ({
  id: UNIT_ID,
  course_id: COURSE_ID,
  name: "الوحدة الأولى",
  display_order: 0,
  status: "active",
  created_at: "2026-10-20T10:00:00.000Z",
  updated_at: "2026-10-20T10:00:00.000Z",
  ...overrides,
});

const unitState = (overrides: Partial<CourseUnitState> = {}): CourseUnitState => ({
  open: true,
  phase: "ready",
  rows: [unit()],
  nextCursor: null,
  hasPreviousPage: false,
  error: null,
  reason: null,
  refreshError: null,
  lastConfirmed: null,
  form: {
    mode: "closed",
    nameDraft: "",
    orderDraft: "",
    targetId: null,
    targetName: null,
    originalName: null,
    originalOrder: null,
    error: null,
  },
  mutation: { status: "idle", kind: null, targetId: null, error: null, notice: null },
  ...overrides,
});

interface ParentRender {
  html: string;
  selectedWrites: (string | null)[];
}

/**
 * Renders the REAL `CourseUnitManager` with the unit snapshot AND a controlled
 * `lessonUnitId`, so the additive child mount can be observed. The two
 * `useState` calls are served in source order (snapshot, then the selected
 * lesson unit id) and the effects are recorded rather than run, unless the test
 * asks for them.
 */
const renderParent = async (
  snapshot: CourseUnitState,
  lessonUnitId: string | null,
  options: { runEffects?: boolean } = {},
): Promise<ParentRender> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/catalog/CourseUnitManager.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  const selectedWrites: (string | null)[] = [];
  const effects: (() => unknown)[] = [];
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /CourseUnitManager\.tsx$/.test(parent?.filename || "")) {
        let call = 0;
        return {
          ...React,
          useState: () => {
            call += 1;
            if (call === 1) return [snapshot, () => {}];
            return [lessonUnitId, (next: string | null) => { selectedWrites.push(next); }];
          },
          useRef: () => ({ current: null }),
          useEffect: (callback: () => unknown) => { effects.push(callback); },
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(this, path.resolve(SRC_ROOT, specifier.slice(2)), parent, isMain);
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (...args: unknown[]) => unknown;
    (globalThis as { React?: unknown }).React = React;
    const tree = Component({ courseId: COURSE_ID });
    if (options.runEffects) {
      for (const effect of effects) effect();
    }
    return { html: renderToStaticMarkup(tree as never), selectedWrites };
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

test("parent: the unit rows keep their accepted controls and gain a lesson selection", async () => {
  const { html } = await renderParent(unitState(), null);

  // Accepted M2-09 controls are untouched.
  assert.ok(html.includes("تحديث القائمة"));
  assert.ok(html.includes("وحدة جديدة"));
  assert.ok(html.includes("إغلاق اللوحة"));
  assert.ok(html.includes("تعديل"));
  assert.ok(html.includes("أرشفة"));
  // The additive per-row selection.
  assert.ok(html.includes("دروس الوحدة"));
  assert.equal(html.includes('aria-expanded="true"'), false, "no row is expanded yet");
  // No child without an explicit selection.
  assert.equal(html.includes("فتح لوحة الدروس"), false);
});

test("parent: an explicit selection mounts the keyed lesson child for that unit", async () => {
  const { html } = await renderParent(unitState(), UNIT_ID);

  assert.ok(html.includes('aria-expanded="true"'), "the selected row is expanded");
  assert.ok(html.includes("إخفاء الدروس"), "the selection can be collapsed again");
  assert.ok(html.includes("فتح لوحة الدروس"), "the lesson panel is mounted");
  assert.ok(html.includes("دروس الوحدة «الوحدة الأولى»"), "the child is bound to that unit");
});

test("parent: a closed panel never renders the child, even with a stale selection", async () => {
  const { html } = await renderParent(unitState({ open: false, phase: "idle", rows: [] }), UNIT_ID);

  assert.equal(html.includes("فتح لوحة الدروس"), false,
    "a hidden view never retains the private child");
  assert.ok(html.includes("فتح لوحة الوحدات"), "the parent still offers its explicit open");
});

test("parent: the child lifetime effect clears the selection on a lost scope", async () => {
  for (const snapshot of [
    unitState({ phase: "denied", reason: "not-owner", rows: [], error: "Forbidden" }),
    unitState({ phase: "unauthorized", reason: "session", rows: [], error: "Token expired" }),
    unitState({ phase: "malformed", reason: "unknown", rows: [], error: "x" }),
    unitState({ phase: "missing-course", reason: "missing-course", rows: [], error: "x" }),
    unitState({ open: false, phase: "idle", rows: [] }),
  ]) {
    const { selectedWrites } = await renderParent(snapshot, UNIT_ID, { runEffects: true });
    assert.deepEqual(selectedWrites, [null],
      `the selection is cleared for phase ${snapshot.phase} / open=${snapshot.open}`);
  }
});

test("parent: the child lifetime effect clears a row that left the settled page", async () => {
  const { selectedWrites } = await renderParent(
    unitState({ phase: "ready", rows: [unit({ id: OTHER_UNIT_ID })] }),
    UNIT_ID,
    { runEffects: true },
  );
  assert.deepEqual(selectedWrites, [null], "a replaced/removed row unmounts its child");
});

test("parent: the child lifetime effect keeps a selection that is still on the page", async () => {
  const { selectedWrites } = await renderParent(unitState(), UNIT_ID, { runEffects: true });
  assert.deepEqual(selectedWrites, [], "a present row keeps its child mounted");
});

test("parent: a transient loading page does not tear the child down", async () => {
  const { selectedWrites } = await renderParent(
    unitState({ phase: "loading", rows: [] }),
    UNIT_ID,
    { runEffects: true },
  );
  assert.deepEqual(selectedWrites, [], "loading is not a settled page");
});

test("parent: a lost scope renders NO private child BEFORE the passive effect runs", async () => {
  for (const snapshot of [
    unitState({ phase: "denied", reason: "not-owner", rows: [], error: "Forbidden" }),
    unitState({ phase: "unauthorized", reason: "session", rows: [], error: "Token expired" }),
    unitState({ phase: "no-workspace", reason: "no-workspace", rows: [], error: "Tenant membership not found" }),
    unitState({ phase: "missing-course", reason: "missing-course", rows: [], error: "Course not found" }),
    unitState({ phase: "malformed", reason: "unknown", rows: [], error: "malformed" }),
    unitState({ open: false, phase: "idle", rows: [] }),
  ]) {
    // The effects are RECORDED, not run: this is the render itself.
    const { html } = await renderParent(snapshot, UNIT_ID);
    assert.equal(
      html.includes("فتح لوحة الدروس"),
      false,
      `no private child is rendered for phase ${snapshot.phase} / open=${snapshot.open}`,
    );
  }
});

test("parent: a settled page that no longer holds the selected row renders NO child BEFORE the effect runs", async () => {
  for (const snapshot of [
    unitState({ phase: "ready", rows: [unit({ id: OTHER_UNIT_ID })] }),
    unitState({ phase: "empty", rows: [] }),
  ]) {
    const { html } = await renderParent(snapshot, UNIT_ID);
    assert.equal(
      html.includes("فتح لوحة الدروس"),
      false,
      "a replaced or removed row never keeps its private child",
    );
  }
});

test("parent: a permitted parent that still holds the selected row DOES render the child", async () => {
  const ready = await renderParent(unitState(), UNIT_ID);
  assert.ok(ready.html.includes("فتح لوحة الدروس"), "the settled page keeps the child");

  // A transient loading is NOT a settled page: the selected row is retained and
  // the child stays mounted.
  const loading = await renderParent(unitState({ phase: "loading" }), UNIT_ID);
  assert.ok(loading.html.includes("فتح لوحة الدروس"), "a transient loading keeps the child");
});

test("parent: the immutable course and unit ids are what the child receives", async () => {
  const { html } = await renderParent(
    unitState({ rows: [unit({ id: OTHER_UNIT_ID, name: "الوحدة الثانية" })] }),
    OTHER_UNIT_ID,
  );
  assert.ok(html.includes("دروس الوحدة «الوحدة الثانية»"));
  assert.equal(html.includes("دروس الوحدة «الوحدة الأولى»"), false);
});
