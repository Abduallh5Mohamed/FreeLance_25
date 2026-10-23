/**
 * M2-09 private course-unit metadata UI — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/catalog/course-units.ts` that
 * `src/features/catalog/CourseUnitManager.tsx` mounts, plus the REAL additive
 * transport (`listCourseUnits`, `createCourseUnit`, `updateCourseUnit`) in
 * `src/lib/api-http.ts` — both imported unchanged. Fully isolated: no DB, no
 * network, no browser, no live services, no dependency install. The transport
 * seam drives the REAL `request` with a stubbed global fetch/localStorage/
 * window; the feature seam drives the REAL controller with an injected fake
 * transport, principal reader and session notifier; the component seam renders
 * the REAL production component with the REAL React server renderer.
 *
 * Behaviours pinned (M2-09 contract):
 *  - canonical authenticated request: the exact
 *    `/tenants/me/catalog/courses/:courseId/units` path family, the bearer
 *    header, the bounded `limit`, the encoded cursor and NO client tenant
 *    selector in header/query/body — the selected course id is a RESOURCE id;
 *  - the strict request bodies: `{ name }` (+ an OPTIONAL numeric
 *    `display_order`) for a create and a non-empty subset of `{ name }`,
 *    `{ display_order }`, `{ status }` for an update;
 *  - the documented transport error behavior: the server `error` message is
 *    thrown WITHOUT the HTTP status and WITHOUT the `code`, so only documented
 *    messages classify an outcome; the canonical BILLING_ONLY identity event
 *    and the suspension teardown keep working;
 *  - runtime DTO validation: the exact seven-field unit DTO bound to the
 *    course, the exact `{ units, next_cursor }` / `{ unit }` envelopes and the
 *    25-row RESPONSE bound are required — an extra key, a foreign course, a
 *    bad status, a bad position or an oversized page is a malformed response,
 *    never a fabricated unit;
 *  - the owner-only denial, the billing-only denial, the suspension, the
 *    missing workspace and the missing course are distinguished, using only
 *    documented transported messages;
 *  - the panel loads ONLY after an explicit open, exactly one bounded 25-row
 *    page at a time, with next/first paging and no accumulated pages;
 *  - one synchronous mutation flight, no duplicate create/save/status write;
 *  - a PATCH response for another unit — or for another course — is NOT a
 *    success for this write;
 *  - an unknown write outcome stays explicitly uncertain: no automatic write
 *    retry, the draft is preserved, and a deliberate list read is offered and
 *    is never treated as proof of the write;
 *  - a confirmed save is never turned into a failed save by a failed follow-up
 *    read, and at most ONE bounded first-page read follows a confirmed create
 *    or reorder;
 *  - reversed/superseded replies never commit; the canonical principal is
 *    observed at entry AND at completion on the success and the failure path,
 *    and a RETIRED reply observes it BEFORE it settles any visible state;
 *  - a session event, a close and a dispose clear the private rows and drafts
 *    and drop every in-flight reply; an old `finally` never releases a newer
 *    operation's latch; a newer draft is never overwritten by an older
 *    confirmed save.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative). The accepted
 * migration FILE is not applied, so no runtime unit rollout is claimed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCourseUnit,
  listCourseUnits,
  updateCourseUnit,
  type CourseUnit,
  type CourseUnitEnvelope,
  type CourseUnitListEnvelope,
} from "../lib/api-http";
import {
  COURSE_UNIT_DISPLAY_ORDER_MAX,
  COURSE_UNIT_NAME_INVALID_MESSAGE,
  COURSE_UNIT_NO_CHANGES_MESSAGE,
  COURSE_UNIT_ORDER_INVALID_MESSAGE,
  COURSE_UNIT_RECONCILED_MESSAGE,
  COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE,
  MALFORMED_COURSE_UNIT_MESSAGE,
  classifyCourseUnitFailure,
  classifyCourseUnitWriteFailure,
  createCourseUnitController,
  isCourseUnitAuthorizationLoss,
  parseCourseUnit,
  parseCourseUnitEnvelope,
  parseCourseUnitList,
  parseCourseUnitOrder,
  type CourseUnitApi,
  type CourseUnitController,
  type CourseUnitState,
} from "../features/catalog/course-units";
import { subscribeSessionChange } from "../lib/session-events";

// ---------------------------------------------------------------------------
// Deferred + harness helpers
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
const OTHER_UNIT_ID = "ffffffff-eeee-4fff-8aaa-bbbbbbbbbbbb";

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

const listEnvelope = (
  units: CourseUnit[],
  nextCursor: string | null = null,
): CourseUnitListEnvelope => ({ units, next_cursor: nextCursor });

const writeEnvelope = (value: CourseUnit): CourseUnitEnvelope => ({ unit: value });

/** The controller harness: every transport call is a deferred the test settles. */
interface Harness {
  api: CourseUnitApi;
  listCalls: { courseId: string; limit: number; cursor: string | null }[];
  lists: Deferred<CourseUnitListEnvelope>[];
  creates: { courseId: string; name: string; displayOrder?: number }[];
  createDeferreds: Deferred<CourseUnitEnvelope>[];
  updateCalls: {
    courseId: string;
    unitId: string;
    update: { name?: string; display_order?: number; status?: string };
  }[];
  updateDeferreds: Deferred<CourseUnitEnvelope>[];
}

const createHarness = (): Harness => {
  const listCalls: { courseId: string; limit: number; cursor: string | null }[] = [];
  const lists: Deferred<CourseUnitListEnvelope>[] = [];
  const creates: { courseId: string; name: string; displayOrder?: number }[] = [];
  const createDeferreds: Deferred<CourseUnitEnvelope>[] = [];
  const updateCalls: {
    courseId: string;
    unitId: string;
    update: { name?: string; display_order?: number; status?: string };
  }[] = [];
  const updateDeferreds: Deferred<CourseUnitEnvelope>[] = [];
  return {
    listCalls,
    lists,
    creates,
    createDeferreds,
    updateCalls,
    updateDeferreds,
    api: {
      listUnits: (params) => {
        listCalls.push({
          courseId: params.courseId,
          limit: params.limit,
          cursor: params.cursor,
        });
        const d = deferred<CourseUnitListEnvelope>();
        lists.push(d);
        return d.promise;
      },
      createUnit: (courseId, input) => {
        creates.push({
          courseId,
          name: input.name,
          displayOrder: input.display_order,
        });
        const d = deferred<CourseUnitEnvelope>();
        createDeferreds.push(d);
        return d.promise;
      },
      updateUnit: (courseId, unitId, update) => {
        updateCalls.push({ courseId, unitId, update: { ...update } });
        const d = deferred<CourseUnitEnvelope>();
        updateDeferreds.push(d);
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
      (globalThis as unknown as { localStorage: unknown }).localStorage = realLocalStorage ?? undefined;
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

test("transport: canonical authenticated GET of the bounded unit list", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([unit()]) }));

  const body = await listCourseUnits(COURSE_ID);

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(
    env.calls[0].url,
    `/api/tenants/me/catalog/courses/${COURSE_ID}/units?limit=25`,
  );
  assert.equal(env.calls[0].init.method, undefined, "a read: no explicit method override");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
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
  assert.equal(body.units.length, 1);
  assert.equal(body.next_cursor, null);
});

test("transport: the opaque cursor is sent as an encoded query parameter", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([], "abc") }));

  await listCourseUnits(COURSE_ID, { cursor: "a+b/c=" });

  assert.equal(
    env.calls[0].url,
    `/api/tenants/me/catalog/courses/${COURSE_ID}/units?limit=25&cursor=a%2Bb%2Fc%3D`,
  );
  assert.equal(env.calls[0].url.includes("tenant_id"), false, "no tenant selector");
});

test("transport: a missing token fails closed - no Authorization header is sent", async (t) => {
  const env = installTransportEnvironment(null);
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([]) }));

  await listCourseUnits(COURSE_ID);

  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("transport: the create body is { name } plus an optional numeric display_order", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 201, body: writeEnvelope(unit()) }));

  await createCourseUnit(COURSE_ID, { name: "الوحدة الأولى" });
  await createCourseUnit(COURSE_ID, { name: "الوحدة الثانية", display_order: 3 });

  assert.equal(
    env.calls[0].url,
    `/api/tenants/me/catalog/courses/${COURSE_ID}/units`,
  );
  assert.equal(env.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { name: "الوحدة الأولى" });
  assert.deepEqual(JSON.parse(String(env.calls[1].init.body)), {
    name: "الوحدة الثانية",
    display_order: 3,
  });
  assert.equal(
    typeof JSON.parse(String(env.calls[1].init.body)).display_order,
    "number",
    "the position is a JSON NUMBER - the server refuses a numeric string",
  );
});

test("transport: the update body carries only the changed subset", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope(unit()) }));

  await updateCourseUnit(COURSE_ID, UNIT_ID, { name: "وحدة جديدة" });
  await updateCourseUnit(COURSE_ID, UNIT_ID, { display_order: 5 });
  await updateCourseUnit(COURSE_ID, UNIT_ID, { status: "archived" });

  assert.equal(
    env.calls[0].url,
    `/api/tenants/me/catalog/courses/${COURSE_ID}/units/${UNIT_ID}`,
  );
  assert.equal(env.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { name: "وحدة جديدة" });
  assert.deepEqual(JSON.parse(String(env.calls[1].init.body)), { display_order: 5 });
  assert.deepEqual(JSON.parse(String(env.calls[2].init.body)), { status: "archived" });
});

test("transport: the write error arrives as its message only - no status, no code", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: { error: "Forbidden", code: "SOMETHING" },
  }));

  await assert.rejects(
    () => createCourseUnit(COURSE_ID, { name: "وحدة" }),
    (error: Error) => {
      assert.equal(error.message, "Forbidden");
      assert.equal(/403/.test(error.message), false, "the discarded status is not invented");
      assert.equal(/SOMETHING/.test(error.message), false, "the discarded code is not invented");
      return true;
    },
  );
});

test("transport: the canonical BILLING_ONLY identity event and redirect are preserved", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  env.store.set(
    "currentUser",
    JSON.stringify({ id: "user-1", role: "instructor", billing_only: false }),
  );
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: {
      error:
        "Course unit management is not available while the account is limited to billing and support",
      code: "BILLING_ONLY",
    },
  }));

  const kinds: string[] = [];
  const unsubscribe = subscribeSessionChange((event) => { kinds.push(event.kind); });
  t.after(unsubscribe);

  await assert.rejects(() => listCourseUnits(COURSE_ID), /limited to billing and support/);

  assert.deepEqual(kinds, ["identity"], "the shared transport still notifies the identity change");
  assert.deepEqual(env.assignedUrls, ["/instructor-subscription"], "the canonical redirect is kept");
  const stored = JSON.parse(env.store.get("currentUser") || "{}");
  assert.equal(stored.billing_only, true);
});

test("transport: the canonical suspension teardown is preserved", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: { error: "Instructor account is administratively suspended", code: "TENANT_SUSPENDED" },
  }));

  const kinds: string[] = [];
  const unsubscribe = subscribeSessionChange((event) => { kinds.push(event.kind); });
  t.after(unsubscribe);

  await assert.rejects(() => listCourseUnits(COURSE_ID), /administratively suspended/);

  assert.deepEqual(kinds, ["logout"], "the shared transport still tears the session down");
});

// ===========================================================================
// Runtime DTO validation
// ===========================================================================

test("dto: the exact seven-field unit DTO of the bound course is accepted", () => {
  const parsed = parseCourseUnit(unit(), COURSE_ID);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.unit.id, UNIT_ID);
    assert.equal(parsed.unit.course_id, COURSE_ID);
    assert.equal(parsed.unit.display_order, 0);
    assert.equal(parsed.unit.status, "active");
  }
});

test("dto: a unit of ANOTHER course is refused - never a fabricated unit", () => {
  assert.equal(
    parseCourseUnit(unit({ course_id: OTHER_COURSE_ID }), COURSE_ID).ok,
    false,
    "a foreign course binding is not a success",
  );
});

test("dto: a malformed unit is refused - never a fabricated row", () => {
  const cases: Array<[string, unknown]> = [
    ["not an object", "unit"],
    ["an array", [unit()]],
    ["a missing id", { ...unit(), id: undefined }],
    ["a non-uuid id", { ...unit(), id: "not-a-uuid" }],
    ["an empty name", { ...unit(), name: "   " }],
    ["a name that is too long", { ...unit(), name: "ا".repeat(256) }],
    ["a numeric string position", { ...unit(), display_order: "3" }],
    ["a fractional position", { ...unit(), display_order: 1.5 }],
    ["a negative position", { ...unit(), display_order: -1 }],
    ["an oversized position", { ...unit(), display_order: COURSE_UNIT_DISPLAY_ORDER_MAX + 1 }],
    ["an unknown status", { ...unit(), status: "published" }],
    ["a non-string timestamp", { ...unit(), updated_at: 1750000000000 }],
    ["a spread row with an extra key", { ...unit(), tenant_id: COURSE_ID }],
  ];
  for (const [label, body] of cases) {
    assert.equal(parseCourseUnit(body, COURSE_ID).ok, false, `${label} is refused`);
  }
});

test("dto: the list envelope requires exactly units and next_cursor", () => {
  assert.equal(parseCourseUnitList(listEnvelope([unit()]), COURSE_ID).ok, true);
  assert.equal(parseCourseUnitList({ units: [], next_cursor: 5 }, COURSE_ID).ok, false);
  assert.equal(parseCourseUnitList({ units: [], next_cursor: null, extra: 1 }, COURSE_ID).ok, false);
  assert.equal(parseCourseUnitList({ units: [], }, COURSE_ID).ok, false);
  assert.equal(parseCourseUnitList({ units: {}, next_cursor: null }, COURSE_ID).ok, false);
  assert.equal(
    parseCourseUnitList({ units: [], next_cursor: "" }, COURSE_ID).ok,
    false,
    "an empty cursor is outside the server's bound",
  );
  assert.equal(
    parseCourseUnitList({ units: [], next_cursor: "c".repeat(257) }, COURSE_ID).ok,
    false,
    "a cursor longer than 256 characters is outside the server's bound",
  );
  assert.equal(
    parseCourseUnitList({ units: [], next_cursor: "c".repeat(256) }, COURSE_ID).ok,
    true,
    "a cursor at the bound is accepted",
  );
});

test("dto: the write envelope requires exactly one unit", () => {
  assert.equal(parseCourseUnitEnvelope(writeEnvelope(unit()), COURSE_ID).ok, true);
  assert.equal(parseCourseUnitEnvelope({ unit: unit(), other: 1 }, COURSE_ID).ok, false);
  assert.equal(parseCourseUnitEnvelope({ units: [] }, COURSE_ID).ok, false);
});

test("dto: a response page larger than the bound is refused before any row is copied", () => {
  const oversized = Array.from({ length: 26 }, (_, index) =>
    unit({ id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}` }),
  );
  assert.equal(
    parseCourseUnitList(listEnvelope(oversized), COURSE_ID).ok,
    false,
    "26 rows exceed the 25-row response bound",
  );

  const legal = Array.from({ length: 25 }, (_, index) =>
    unit({ id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}` }),
  );
  const parsed = parseCourseUnitList(listEnvelope(legal), COURSE_ID);
  assert.equal(parsed.ok, true, "a legitimate 25-row page is accepted");
  if (parsed.ok) assert.equal(parsed.units.length, 25);
});

test("dto: the position parser refuses everything the server refuses", () => {
  assert.equal(parseCourseUnitOrder("0"), 0);
  assert.equal(parseCourseUnitOrder(" 12 "), 12);
  assert.equal(parseCourseUnitOrder(String(COURSE_UNIT_DISPLAY_ORDER_MAX)), COURSE_UNIT_DISPLAY_ORDER_MAX);
  assert.equal(parseCourseUnitOrder("-1"), null, "a negative position is refused");
  assert.equal(parseCourseUnitOrder("1.5"), null, "a fraction is refused");
  assert.equal(parseCourseUnitOrder("1e3"), null, "an exponent is refused");
  assert.equal(parseCourseUnitOrder("abc"), null);
  assert.equal(parseCourseUnitOrder(""), null);
  assert.equal(parseCourseUnitOrder(" ٣ "), null, "Arabic-Indic digits are refused");
  assert.equal(
    parseCourseUnitOrder(String(COURSE_UNIT_DISPLAY_ORDER_MAX + 1)),
    null,
    "a position above the signed 32-bit maximum is refused",
  );
});

test("classification: the documented messages map to honest outcomes", () => {
  assert.deepEqual(classifyCourseUnitFailure(new Error("Token expired")), {
    phase: "unauthorized",
    reason: "session",
    message: "Token expired",
  });
  assert.deepEqual(classifyCourseUnitFailure(new Error("Forbidden")), {
    phase: "denied",
    reason: "not-owner",
    message: "Forbidden",
  });
  assert.deepEqual(
    classifyCourseUnitFailure(
      new Error(
        "Course unit management is not available while the account is limited to billing and support",
      ),
    ),
    {
      phase: "denied",
      reason: "billing-only",
      message:
        "Course unit management is not available while the account is limited to billing and support",
    },
  );
  assert.deepEqual(classifyCourseUnitFailure(new Error("Tenant membership not found")), {
    phase: "no-workspace",
    reason: "no-workspace",
    message: "Tenant membership not found",
  });
  assert.deepEqual(classifyCourseUnitFailure(new Error("Course not found")), {
    phase: "missing-course",
    reason: "missing-course",
    message: "Course not found",
  });
  assert.deepEqual(classifyCourseUnitFailure(new Error("Failed to list course units")), {
    phase: "error",
    reason: "server",
    message: "Failed to list course units",
  });
  const unknown = classifyCourseUnitFailure(new Error("Something else"));
  assert.equal(unknown.phase, "error");
  assert.equal(unknown.reason, "unknown", "an unrecognized message is never a permission outcome");
});

test("classification: the write failures separate the definite denials from the uncertain ones", () => {
  assert.equal(classifyCourseUnitWriteFailure(new Error("Token expired")).kind, "unauthorized");
  assert.equal(classifyCourseUnitWriteFailure(new Error("Forbidden")).kind, "denied");
  assert.equal(classifyCourseUnitWriteFailure(new Error("Course not found")).kind, "denied");
  assert.equal(
    classifyCourseUnitWriteFailure(new Error("Course unit not found")).kind,
    "missing",
  );
  assert.equal(
    classifyCourseUnitWriteFailure(new Error("Course unit was modified concurrently")).kind,
    "conflict",
  );
  assert.equal(
    classifyCourseUnitWriteFailure(new Error("Invalid course unit update payload")).kind,
    "invalid",
  );
  assert.equal(
    classifyCourseUnitWriteFailure(new Error("Failed to create course unit")).kind,
    "uncertain",
  );
  assert.equal(
    classifyCourseUnitWriteFailure(new Error("Failed to update course unit")).kind,
    "uncertain",
  );
  assert.equal(
    classifyCourseUnitWriteFailure(new Error("network down")).kind,
    "uncertain",
    "an unrecognized failure is uncertain - the write may have persisted",
  );
});

test("classification: the authorization-loss classifier separates the definite denials", () => {
  assert.equal(isCourseUnitAuthorizationLoss("session"), true);
  assert.equal(isCourseUnitAuthorizationLoss("suspended"), true);
  assert.equal(isCourseUnitAuthorizationLoss("billing-only"), true);
  assert.equal(isCourseUnitAuthorizationLoss("not-owner"), true);
  assert.equal(isCourseUnitAuthorizationLoss("no-workspace"), true);
  assert.equal(isCourseUnitAuthorizationLoss("missing-course"), true);
  assert.equal(isCourseUnitAuthorizationLoss("server"), false, "the handler 500 is not a permission loss");
  assert.equal(isCourseUnitAuthorizationLoss("unknown"), false, "an unknown message is not a permission loss");
});

// ===========================================================================
// Controller — the REAL production controller
// ===========================================================================

test("feature: no unit request happens before the panel is explicitly opened", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  await flush();
  assert.equal(harness.listCalls.length, 0, "no request before the explicit open");
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().open, false);
});

test("feature: a second open issues no second request", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  await controller.open();
  await flush();
  assert.equal(harness.listCalls.length, 1, "the panel is opened once");
});

test("feature: the course binding is immutable and carried on every request", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  assert.equal(controller.courseId, COURSE_ID, "the binding is exposed read-only");

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة");
  const created = controller.create();
  await flush();
  harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة" })));
  await flush();
  harness.lists[1].resolve(listEnvelope([unit({ name: "وحدة" })]));
  await created;
  await controller.waitForIdle();

  assert.equal(harness.listCalls[0].courseId, COURSE_ID);
  assert.equal(harness.creates[0].courseId, COURSE_ID);
  assert.equal(controller.courseId, COURSE_ID, "the binding never changes");
});

test("feature: the owner denial is shown as the server's own answer", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].reject(new Error("Forbidden"));
  await opened;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "denied");
  assert.equal(state.reason, "not-owner");
  assert.equal(state.error, "Forbidden", "the server's own message is preserved");
  assert.equal(state.rows.length, 0);
});

test("feature: the billing-only denial is distinguished from the owner denial", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].reject(
    new Error(
      "Course unit management is not available while the account is limited to billing and support",
    ),
  );
  await opened;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "denied");
  assert.equal(state.reason, "billing-only");
  assert.notEqual(state.reason, "not-owner");
});

test("feature: a missing course is a distinct truthful outcome", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].reject(new Error("Course not found"));
  await opened;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "missing-course");
  assert.equal(state.reason, "missing-course");
  assert.equal(state.error, "Course not found");
  assert.equal(state.rows.length, 0);
});

test("feature: a malformed body is a malformed state, never a fabricated row", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve({ units: [{ id: UNIT_ID }], next_cursor: null } as never);
  await opened;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "malformed");
  assert.equal(state.error, MALFORMED_COURSE_UNIT_MESSAGE);
  assert.equal(state.rows.length, 0);
});

test("feature: an oversized response page never reaches the held page", async (t) => {
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    readPrincipal: () => "session:a",
    listUnits: async () =>
      listEnvelope(
        Array.from({ length: 26 }, (_, index) =>
          unit({ id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}` }),
        ),
      ),
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  await controller.open();
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "malformed");
  assert.equal(state.error, MALFORMED_COURSE_UNIT_MESSAGE);
  assert.equal(state.rows.length, 0, "no row of an oversized page is ever held");
  assert.equal(state.nextCursor, null);
});

test("feature: paging holds one bounded page and uses the server cursor", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()], "cursor-2"));
  await opened;
  await controller.waitForIdle();

  assert.equal(harness.listCalls[0].limit, 25, "the bounded page size is requested");
  assert.equal(harness.listCalls[0].cursor, null);
  assert.equal(controller.getState().rows.length, 1, "only one page is held");
  assert.equal(controller.getState().nextCursor, "cursor-2");

  const next = controller.nextPage();
  await flush();
  assert.equal(harness.listCalls[1].cursor, "cursor-2", "the server cursor is used verbatim");
  harness.lists[1].resolve(listEnvelope([unit({ id: OTHER_UNIT_ID })]));
  await next;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows.length, 1, "the pages never accumulate");
  assert.equal(controller.getState().hasPreviousPage, true);

  const first = controller.firstPage();
  await flush();
  assert.equal(harness.listCalls[2].cursor, null, "the first page drops the cursor");
  harness.lists[2].resolve(listEnvelope([unit()]));
  await first;
  await controller.waitForIdle();
  assert.equal(controller.getState().hasPreviousPage, false);
});

test("feature: a page without a next cursor issues no request at all", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()], null));
  await opened;
  await controller.waitForIdle();

  await controller.nextPage();
  await flush();
  assert.equal(harness.listCalls.length, 1, "no request without a cursor");
});

test("feature: a double-clicked refresh never reaches the transport twice", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const first = controller.refresh();
  await flush();
  const dropped = controller.refresh();
  await flush();
  assert.equal(harness.listCalls.length, 2, "the second refresh never reaches the transport");

  harness.lists[1].resolve(listEnvelope([unit()]));
  await Promise.all([first, dropped]);
  await controller.waitForIdle();
  assert.equal(harness.listCalls.length, 2);
});

test("feature: a confirmed create uses the server DTO and is followed by one bounded first-page read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([]));
  await opened;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "empty");

  controller.openCreateForm();
  controller.updateNameDraft("  وحدة جديدة  ");
  const created = controller.create();
  await flush();
  assert.equal(harness.creates.length, 1);
  assert.equal(harness.creates[0].name, "وحدة جديدة", "the trimmed name is sent");
  assert.equal(
    harness.creates[0].displayOrder,
    undefined,
    "an empty position is omitted so the server default applies",
  );

  const confirmed = unit({ name: "وحدة جديدة" });
  harness.createDeferreds[0].resolve(writeEnvelope(confirmed));
  await flush();
  assert.equal(harness.listCalls.length, 2, "exactly one bounded read after the confirmed create");
  assert.equal(harness.listCalls[1].cursor, null, "the follow-up read is the first page");
  harness.lists[1].resolve(listEnvelope([confirmed]));
  await created;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.form.mode, "closed", "the confirmed create closes its own form");
  assert.equal(state.mutation.status, "idle");
  assert.equal(state.mutation.error, null);
  assert.equal(state.lastConfirmed?.id, UNIT_ID);
  assert.equal(state.rows.length, 1);
});

test("feature: a failed follow-up read never turns the confirmed save into a failed save", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة جديدة");
  const created = controller.create();
  await flush();
  harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة جديدة" })));
  await flush();
  assert.equal(harness.listCalls.length, 2);
  harness.lists[1].reject(new Error("Failed to list course units"));
  await created;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle", "the confirmed write is not a failed write");
  assert.equal(state.mutation.error, null, "the follow-up read is not reported as a write failure");
  assert.equal(state.lastConfirmed?.id, UNIT_ID, "the confirmation survives");
  assert.equal(state.refreshError, "Failed to list course units", "the failed refresh is reported apart");
  assert.equal(state.rows.length, 1, "the held page survives the failed refresh");
});

test("feature: a synchronous duplicate create reaches the transport once", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة");
  const first = controller.create();
  const dropped = controller.create();
  await flush();
  assert.equal(harness.creates.length, 1, "the second click never reaches the transport");

  harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة" })));
  await flush();
  harness.lists[1].resolve(listEnvelope([unit({ name: "وحدة" })]));
  await Promise.all([first, dropped]);
  await controller.waitForIdle();
  assert.equal(harness.creates.length, 1);
});

// ---------------------------------------------------------------------------
// 179 regression: a confirmed write must not hold the MUTATION latch across
// the post-confirmation READ. The real enabled row action was silently
// dropped while the bounded follow-up GET was still on the wire.
// ---------------------------------------------------------------------------

test("feature: a confirmed create releases its own write latch before the follow-up read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة جديدة");
  const created = controller.create();
  await flush();
  assert.equal(harness.creates.length, 1);

  harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة جديدة", id: OTHER_UNIT_ID })));
  await flush();
  assert.equal(harness.listCalls.length, 2, "the bounded follow-up read is on the wire");
  assert.equal(controller.getState().mutation.status, "idle", "the confirmed mutation is already idle");
  assert.equal(controller.getState().phase, "loading", "the follow-up read owns the visible phase");

  // The REAL enabled row action must not be a silent no-op while that read
  // is pending: the mutation latch is released, so the write reaches the
  // transport.
  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the enabled action reached the transport");
  assert.deepEqual(harness.updateCalls[0].update, { status: "archived" });

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "archived" })));
  await archived;
  await flush();
  assert.equal(controller.getState().rows[0].status, "archived", "the confirmed archive is applied");

  harness.lists[1].resolve(listEnvelope([unit({ status: "archived" })]));
  await created;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle");
  assert.equal(state.mutation.error, null);
  assert.equal(state.lastConfirmed?.id, UNIT_ID, "the confirmed save stays confirmed");
  assert.equal(state.rows.length, 1);
  assert.equal(harness.listCalls.length, 2, "still exactly one bounded follow-up read");
});

test("feature: a confirmed reorder releases its own write latch before the follow-up read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateOrderDraft("5");
  const saved = controller.save();
  await flush();
  assert.equal(harness.updateCalls.length, 1);
  assert.deepEqual(harness.updateCalls[0].update, { display_order: 5 });

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ display_order: 5 })));
  await flush();
  assert.equal(harness.listCalls.length, 2, "the confirmed reorder is followed by one bounded read");
  assert.equal(controller.getState().mutation.status, "idle", "the confirmed mutation is already idle");

  // The REAL enabled row action must not be a silent no-op while that read
  // is pending.
  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 2, "the enabled action reached the transport");
  assert.deepEqual(harness.updateCalls[1].update, { status: "archived" });

  harness.updateDeferreds[1].resolve(writeEnvelope(unit({ display_order: 5, status: "archived" })));
  await archived;
  await flush();

  harness.lists[1].resolve(listEnvelope([unit({ display_order: 5, status: "archived" })]));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle");
  assert.equal(state.lastConfirmed?.id, UNIT_ID);
  assert.equal(state.rows[0].display_order, 5);
});

test("feature: a write that is really on the wire still excludes a second write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const first = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the first write reached the transport");

  // While the FIRST write request is still on the wire, the real in-flight
  // write exclusion is untouched: a second write never reaches the
  // transport.
  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("اسم");
  const second = controller.save();
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the second write never reaches the transport");

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "archived" })));
  await first;
  await second;
  await controller.waitForIdle();
  assert.equal(harness.updateCalls.length, 1, "no extra write was sent");
});

test("feature: the older finally never releases a newer mutation's latch", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة جديدة");
  const created = controller.create();
  await flush();
  harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة جديدة", id: OTHER_UNIT_ID })));
  await flush();
  assert.equal(harness.listCalls.length, 2, "the follow-up read is on the wire");

  // A NEWER mutation takes the released write latch.
  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the newer mutation took the write latch");

  // The OLDER mutation settles now: its `finally` runs after its follow-up
  // read.
  harness.lists[1].resolve(listEnvelope([unit()]));
  await created;
  await flush();

  // The older `finally` must NOT release the newer mutation's latch.
  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("اسم");
  const blocked = controller.save();
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the newer mutation still holds the write latch");

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "archived" })));
  await archived;
  await blocked;
  await controller.waitForIdle();
  assert.equal(harness.updateCalls.length, 1, "still no extra write");
});

test("feature: a principal change during the pending follow-up read clears the private rows", async (t) => {
  let principal = "session:a";
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة جديدة");
  const created = controller.create();
  await flush();
  harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة جديدة", id: OTHER_UNIT_ID })));
  await flush();
  assert.equal(harness.listCalls.length, 2, "the follow-up read is on the wire");

  // A SILENT principal change while the follow-up read is on the wire: the
  // previous principal's rows and confirmation must not come back.
  principal = "session:b";
  harness.lists[1].resolve(listEnvelope([unit()]));
  await created;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the previous principal's rows are cleared");
  assert.equal(state.lastConfirmed, null, "the previous principal's confirmation is cleared");
  assert.equal(state.form.mode, "closed", "the private form is closed");
});

test("feature: an invalid name never reaches the transport and keeps the draft", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("   ");
  await controller.create();
  await flush();

  assert.equal(harness.creates.length, 0, "the transport is never reached");
  assert.equal(controller.getState().form.error, COURSE_UNIT_NAME_INVALID_MESSAGE);
  assert.equal(controller.getState().form.nameDraft, "   ", "the user's input is preserved");
});

test("feature: an invalid position never reaches the transport and keeps the draft", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([]));
  await opened;
  await controller.waitForIdle();

  controller.openCreateForm();
  controller.updateNameDraft("وحدة");
  controller.updateOrderDraft("1.5");
  await controller.create();
  await flush();

  assert.equal(harness.creates.length, 0, "the transport is never reached");
  assert.equal(controller.getState().form.error, COURSE_UNIT_ORDER_INVALID_MESSAGE);
  assert.equal(controller.getState().form.orderDraft, "1.5", "the user's input is preserved");
});

test("feature: an editor without a change never reaches the transport", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  await controller.save();
  await flush();

  assert.equal(harness.updateCalls.length, 0, "no request without a change");
  assert.equal(controller.getState().form.error, COURSE_UNIT_NO_CHANGES_MESSAGE);
});

test("feature: a confirmed rename sends only the name and updates the row with the server DTO", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("وحدة جديدة");
  const saved = controller.save();
  await flush();
  assert.equal(harness.updateCalls.length, 1);
  assert.deepEqual(harness.updateCalls[0], {
    courseId: COURSE_ID,
    unitId: UNIT_ID,
    update: { name: "وحدة جديدة" },
  });

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة جديدة" })));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows[0].name, "وحدة جديدة");
  assert.equal(harness.listCalls.length, 1, "a confirmed rename needs no extra read");
});

test("feature: a confirmed reorder sends only the position and is followed by one bounded read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateOrderDraft("7");
  const saved = controller.save();
  await flush();
  assert.deepEqual(harness.updateCalls[0], {
    courseId: COURSE_ID,
    unitId: UNIT_ID,
    update: { display_order: 7 },
  });
  assert.equal(
    typeof harness.updateCalls[0].update.display_order,
    "number",
    "the position is a NUMBER, never a numeric string",
  );

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ display_order: 7 })));
  await flush();
  assert.equal(harness.listCalls.length, 2, "exactly one bounded read after the confirmed reorder");
  assert.equal(harness.listCalls[1].cursor, null);
  harness.lists[1].resolve(listEnvelope([unit({ display_order: 7 })]));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows[0].display_order, 7);
});

test("feature: an archive sends only the status and updates the row", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.deepEqual(harness.updateCalls[0], {
    courseId: COURSE_ID,
    unitId: UNIT_ID,
    update: { status: "archived" },
  });

  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "archived" })));
  await archived;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows[0].status, "archived");
  assert.equal(harness.listCalls.length, 1, "a confirmed archive needs no extra read");
});

test("feature: a PATCH response for another unit is uncertain and never committed", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ id: OTHER_UNIT_ID, status: "archived" })));
  await archived;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain", "a foreign unit id is never a success");
  assert.equal(state.mutation.notice, COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.rows[0].status, "active", "the row is not updated by a foreign reply");
  assert.equal(harness.listCalls.length, 1, "no automatic read follows an uncertain write");
});

test("feature: a reply for another course is uncertain and never committed", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].resolve(
    writeEnvelope(unit({ course_id: OTHER_COURSE_ID, status: "archived" })),
  );
  await archived;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.rows[0].status, "active");
});

test("feature: the handler 500 is uncertain - no automatic write and no automatic read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].reject(new Error("Failed to update course unit"));
  await archived;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.error, "Failed to update course unit");
  assert.equal(state.mutation.notice, COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(harness.updateCalls.length, 1, "the write is never retried automatically");
  assert.equal(harness.listCalls.length, 1, "no automatic read follows an uncertain write");
  assert.equal(state.rows.length, 1, "the rows survive an uncertain write");
});

test("feature: the deliberate reconciliation reads the current list and never proves the write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].reject(new Error("Failed to update course unit"));
  await archived;
  await controller.waitForIdle();
  assert.equal(controller.getState().mutation.status, "uncertain");

  const reconciled = controller.reconcile();
  await flush();
  assert.equal(harness.listCalls.length, 2, "the reconciliation is an explicit read");
  harness.lists[1].resolve(listEnvelope([unit({ status: "archived" })]));
  await reconciled;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain", "the read never claims the write succeeded");
  assert.equal(state.mutation.notice, COURSE_UNIT_RECONCILED_MESSAGE);
  assert.equal(state.rows[0].status, "archived", "the CURRENT state is shown");
  assert.equal(harness.updateCalls.length, 1, "the reconciliation is never a write");
});

test("feature: a denied write keeps the rows and the draft", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("وحدة جديدة");
  const saved = controller.save();
  await flush();
  harness.updateDeferreds[0].reject(new Error("Forbidden"));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle", "a definite denial is not an uncertain write");
  assert.equal(state.mutation.error, "Forbidden");
  assert.equal(state.rows.length, 1, "the rows are preserved");
  assert.equal(state.form.mode, "edit", "the form is preserved");
  assert.equal(state.form.nameDraft, "وحدة جديدة", "the draft is preserved");
  assert.equal(harness.listCalls.length, 1, "a denial triggers no read");
});

test("feature: a conflict permits a deliberate retry", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const conflicted = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].reject(new Error("Course unit was modified concurrently"));
  await conflicted;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle", "a definite conflict is retryable, not uncertain");
  assert.equal(state.mutation.error, "Course unit was modified concurrently");
  assert.equal(state.rows.length, 1, "the rows survive a conflict");

  const retry = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 2, "the deliberate retry reaches the transport");
  harness.updateDeferreds[1].resolve(writeEnvelope(unit({ status: "archived" })));
  await retry;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows[0].status, "archived");
});

test("feature: a missing unit is a definite failure, not an uncertain write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].reject(new Error("Course unit not found"));
  await archived;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle", "the server did not write - the failure is definite");
  assert.equal(state.mutation.error, "Course unit not found");
  assert.equal(state.mutation.notice, null, "a definite failure is never an uncertain write");
});

test("feature: a network failure is uncertain and never retries the write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(UNIT_ID, "archived");
  await flush();
  harness.updateDeferreds[0].reject(new Error("network down"));
  await archived;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.notice, COURSE_UNIT_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(harness.updateCalls.length, 1, "the write is never retried automatically");
  assert.equal(harness.listCalls.length, 1, "no automatic read follows an uncertain write");
});

test("feature: a reversed reply never commits over the newer page", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const first = controller.open();
  await flush();
  assert.equal(harness.listCalls.length, 1);

  // A session event retires the in-flight read and starts the next one.
  principal = "session:b";
  sink.fire();
  await flush();
  assert.equal(harness.listCalls.length, 2, "the session event started the superseding read");

  harness.lists[1].resolve(listEnvelope([unit({ name: "الصفحة الأحدث" })]));
  await flush();
  assert.equal(controller.getState().rows[0].name, "الصفحة الأحدث");

  // The reversed page answers LAST: it must never overwrite the newer page.
  harness.lists[0].resolve(listEnvelope([unit({ name: "الصفحة الأقدم" })]));
  await first;
  await flush();
  assert.equal(
    controller.getState().rows[0].name,
    "الصفحة الأحدث",
    "the older reply is dropped, not merged",
  );
});

test("feature: a retired read observes the principal before settling - silent logout, success path", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal = "session:a";
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const refresh = controller.refresh();
  await flush();
  // A silent logout: the principal changed without any notifier event.
  principal = "session:b";
  harness.lists[1].resolve(listEnvelope([unit({ name: "وحدة قديمة" })]));
  await refresh;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the private rows are cleared on the silent principal change");
  assert.equal(state.form.mode, "closed");
  assert.equal(state.lastConfirmed, null);
});

test("feature: a retired read observes the principal before settling - silent logout, failure path", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal = "session:a";
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const refresh = controller.refresh();
  await flush();
  principal = "session:b";
  harness.lists[1].reject(new Error("Failed to list course units"));
  await refresh;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the private rows are cleared on the silent principal change");
  assert.equal(state.phase, "idle", "the retired read never settles a visible failure");
  assert.equal(state.error, null);
});

test("feature: a silent principal change at completion clears the private rows", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal = "session:a";
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  principal = "session:b";
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the reply of a foreign principal never commits");
  assert.equal(state.phase, "idle");
});

test("feature: a session event clears the rows and drafts and starts a fresh first page", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("مسودة");
  sink.fire();
  await flush();
  assert.equal(controller.getState().rows.length, 0, "the private rows are cleared");
  assert.equal(controller.getState().form.mode, "closed", "the private form is closed");
  assert.equal(harness.listCalls.length, 2, "the new session gets its own first page");
  assert.equal(harness.listCalls[1].cursor, null);
  harness.lists[1].resolve(listEnvelope([unit()]));
  await controller.waitForIdle();
});

test("feature: an old finally never releases a newer read's latch", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()], "cursor-2"));
  await opened;
  await controller.waitForIdle();

  const next = controller.nextPage();
  await flush();
  // A session event retires the in-flight read; a NEW read then takes the
  // latch. The retired read's `finally` must not release the new latch.
  sink.fire();
  await flush();
  assert.equal(harness.listCalls.length, 3);
  harness.lists[1].resolve(listEnvelope([unit()]));
  await flush();
  harness.lists[2].resolve(listEnvelope([unit()]));
  await controller.waitForIdle();

  const again = controller.refresh();
  await flush();
  assert.equal(harness.listCalls.length, 4, "the latch was still held after the retired read settled");
  harness.lists[3].resolve(listEnvelope([unit()]));
  await again;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
});

test("feature: a superseded mutation reply never overwrites a newer confirmed write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const first = controller.setStatus(UNIT_ID, "archived");
  await flush();
  // A session event retires the in-flight write, so a second write can start.
  sink.fire();
  await flush();
  harness.lists[1].resolve(listEnvelope([unit()]));
  await flush();

  const second = controller.setStatus(UNIT_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 2);

  harness.updateDeferreds[1].resolve(writeEnvelope(unit({ status: "archived" })));
  await second;
  await flush();
  assert.equal(controller.getState().rows[0].status, "archived");

  // The retired write answers late: it must never overwrite the newer one.
  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "active" })));
  await first;
  await flush();
  await controller.waitForIdle();
  assert.equal(
    controller.getState().rows[0].status,
    "archived",
    "the superseded reply never overwrites the newer confirmed write",
  );
});

test("feature: a newer draft is retained when an older confirmed save arrives", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("الاسم الأول");
  const saved = controller.save();
  await flush();
  assert.equal(harness.updateCalls.length, 1);

  // The user types a NEWER name while the write is on the wire.
  controller.updateNameDraft("اسم أحدث");
  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ name: "الاسم الأول" })));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.form.mode, "edit", "the newer draft keeps its form open");
  assert.equal(state.form.nameDraft, "اسم أحدث", "the newer edit is never overwritten");
  assert.equal(state.rows[0].name, "الاسم الأول", "the confirmed server DTO owns the row");
});

test("feature: close clears the private rows and retires the request", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const pending = controller.refresh();
  await flush();
  controller.close();
  await flush();
  assert.equal(controller.getState().open, false);
  assert.equal(controller.getState().rows.length, 0, "the private rows are cleared");
  assert.equal(controller.getState().phase, "idle");

  harness.lists[1].resolve(listEnvelope([unit()]));
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, "the retired reply never repopulates the panel");
});

test("feature: dispose drops the in-flight reply and clears the private rows", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  const pending = controller.refresh();
  await flush();
  controller.dispose();
  await flush();
  assert.equal(controller.getState().rows.length, 0, "the private rows are cleared");
  assert.equal(controller.getState().open, false);

  harness.lists[1].resolve(listEnvelope([unit()]));
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, "the disposed view never repopulates");
});

test("feature: a definite read authorization loss clears the private form, the draft and the confirmation", async (t) => {
  const cases = [
    ["Token expired", "unauthorized", "session"],
    ["Forbidden", "denied", "not-owner"],
    ["Course not found", "missing-course", "missing-course"],
  ] as const;

  for (const [message, phase, reason] of cases) {
    const harness = createHarness();
    const sink = createSessionSink();
    const controller = createCourseUnitController(COURSE_ID, {
      ...harness.api,
      readPrincipal: () => "session:a",
      subscribeSession: sink.subscribeSession,
    });
    t.after(() => controller.dispose());

    const opened = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([unit()]));
    await opened;
    await controller.waitForIdle();

    // A server-confirmed write leaves a confirmation behind.
    const archived = controller.setStatus(UNIT_ID, "archived");
    await flush();
    harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "archived" })));
    await archived;
    await controller.waitForIdle();
    assert.equal(controller.getState().lastConfirmed?.id, UNIT_ID);

    // A private rename draft.
    controller.openEditForm(UNIT_ID);
    controller.updateNameDraft("مسودة خاصة");
    assert.equal(controller.getState().form.nameDraft, "مسودة خاصة");

    // The next list read loses the authorization.
    const refresh = controller.refresh();
    await flush();
    harness.lists[1].reject(new Error(message));
    await refresh;
    await controller.waitForIdle();

    const state = controller.getState();
    assert.equal(state.rows.length, 0, "the private rows are cleared");
    assert.equal(state.form.mode, "closed", "the private form is closed, not rendered");
    assert.equal(state.form.nameDraft, "", "the private draft is cleared");
    assert.equal(state.form.targetId, null, "the private target is cleared");
    assert.equal(state.lastConfirmed, null, "the confirmation is cleared");
    assert.equal(state.phase, phase, "the truthful failure phase is preserved");
    assert.equal(state.reason, reason);
    assert.equal(state.error, message, "the server's own message is preserved");
  }
});

test("feature: a retryable read failure keeps the private draft - no permission loss is proven", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("مسودة تبقى");

  const refresh = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Failed to list course units"));
  await refresh;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.reason, "server");
  assert.equal(state.form.mode, "edit", "a retryable failure does not close the form");
  assert.equal(state.form.nameDraft, "مسودة تبقى", "a retryable failure keeps the draft");
});

test("feature: a late pending mutation never repopulates the state cleared by an authorization loss", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([unit()]));
  await opened;
  await controller.waitForIdle();

  controller.openEditForm(UNIT_ID);
  controller.updateNameDraft("مسودة");
  const saved = controller.save();
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the write is on the wire");

  const refresh = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Token expired"));
  await refresh;
  await flush();
  assert.equal(controller.getState().rows.length, 0, "the loss cleared the private rows");
  assert.equal(controller.getState().form.mode, "closed", "the loss closed the private form");

  // The write confirms itself late: it must not revive the cleared state.
  harness.updateDeferreds[0].resolve(writeEnvelope(unit({ name: "مسودة" })));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the late write does not restore the private rows");
  assert.equal(state.form.mode, "closed", "the late write does not reopen the private form");
  assert.equal(state.form.nameDraft, "");
  assert.equal(state.lastConfirmed, null, "the late write claims no confirmation");
  assert.equal(state.mutation.status, "idle");
});

// ===========================================================================
// The real component, rendered by the real React server renderer
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Renders the REAL `CourseUnitManager` component with the REAL React server
 * renderer and the REAL shared UI primitives. Only the controller hook
 * snapshot is injected, so the markup comes from the production component
 * while no request, no browser and no live service is involved.
 *
 * The harness is Node-only: it supplies the classic-JSX `React` binding the
 * TSX file needs and restores the module loader and the global afterwards.
 */
const renderCourseUnitManager = async (snapshot: CourseUnitState): Promise<string> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/catalog/CourseUnitManager.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /CourseUnitManager\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [snapshot, () => {}],
          useRef: () => ({ current: null }),
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(
          this,
          path.resolve(SRC_ROOT, specifier.slice(2)),
          parent,
          isMain,
        );
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    // The component binds its hooks at load time, so the module is loaded
    // again for every snapshot: a cached module would keep rendering the
    // FIRST snapshot instead of the state under test.
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (
      ...args: unknown[]
    ) => unknown;
    (globalThis as { React?: unknown }).React = React;
    const tree = Component({ courseId: COURSE_ID });
    return renderToStaticMarkup(tree as never);
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

/**
 * Renders the REAL `CourseUnitManager` component as a REACT TREE — not as
 * markup — with the REAL controller injected into the component's ref.
 *
 * The 179 finding was an ENABLED control whose real callback was a silent
 * no-op, and markup alone cannot show a callback. This harness therefore
 * returns the production element tree so the actual control callback can be
 * invoked, exactly as the user click would.
 */
const renderCourseUnitManagerTree = async (
  controller: CourseUnitController,
): Promise<unknown> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const componentPath = projectRequire.resolve("../features/catalog/CourseUnitManager.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /CourseUnitManager\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          // The LIVE state of the real controller, and the real controller in
          // the ref, so the production callbacks act on it.
          useState: () => [controller.getState(), () => {}],
          useRef: () => ({ current: controller }),
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(
          this,
          path.resolve(SRC_ROOT, specifier.slice(2)),
          parent,
          isMain,
        );
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (
      ...args: unknown[]
    ) => unknown;
    (globalThis as { React?: unknown }).React = React;
    return Component({ courseId: COURSE_ID });
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

/** The text a production element renders, without copying any render logic. */
const treeText = (node: unknown): string => {
  if (typeof node === "string") return node;
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
 * The HTML `disabled` ATTRIBUTE of a rendered button.
 *
 * The check is deliberately attribute-shaped (` disabled`, ` disabled=`,
 * ` disabled>`) so that the shared design-system utility classes
 * (`disabled:pointer-events-none`, `disabled:opacity-50`), which the shared
 * `src/components/ui/button.tsx` emits for EVERY button, are never mistaken
 * for the disabled state of this control.
 */
const hasDisabledAttribute = (openingTag: string): boolean =>
  /\sdisabled(?:=|\s|>)/.test(openingTag);

/** The controller state of an open, ready panel with one unit. */
const readyState = (overrides: Partial<CourseUnitState> = {}): CourseUnitState => ({
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

test("component: the archive action is enabled after a definite conflict and disabled while the flight is real", async () => {
  const pending = deferred<CourseUnitEnvelope>();
  const controller = createCourseUnitController(COURSE_ID, {
    readPrincipal: () => "session:a",
    listUnits: async () => listEnvelope([unit()]),
    updateUnit: () => pending.promise,
  });
  try {
    await controller.open();
    const flight = controller.setStatus(UNIT_ID, "archived");
    await flush();

    // A REAL saving flight: the action is disabled, so a duplicate click
    // cannot start a second write.
    assert.equal(controller.getState().mutation.status, "saving");
    const savingTag = buttonOpeningTag(await renderCourseUnitManager(controller.getState()), "أرشفة");
    assert.equal(hasDisabledAttribute(savingTag), true, "a real saving flight disables the action");

    pending.reject(new Error("Course unit was modified concurrently"));
    await flight;
    await controller.waitForIdle();

    // The definite conflict: the row is NOT latched disabled, so a
    // deliberate retry is possible without an unrelated operation first.
    const afterConflict = controller.getState();
    assert.equal(afterConflict.mutation.status, "idle");
    assert.equal(afterConflict.mutation.error, "Course unit was modified concurrently");
    const idleTag = buttonOpeningTag(await renderCourseUnitManager(afterConflict), "أرشفة");
    assert.equal(
      hasDisabledAttribute(idleTag),
      false,
      "the deliberate retry is not disabled after a definite conflict",
    );
    assert.match(
      await renderCourseUnitManager(afterConflict),
      /Course unit was modified concurrently/,
      "the conflict message stays visible",
    );
  } finally {
    controller.dispose();
  }
});

test("component: the enabled archive control really writes while the follow-up read is pending", async () => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createCourseUnitController(COURSE_ID, {
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  try {
    const opened = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([unit()]));
    await opened;
    await controller.waitForIdle();

    controller.openCreateForm();
    controller.updateNameDraft("وحدة جديدة");
    const created = controller.create();
    await flush();
    harness.createDeferreds[0].resolve(writeEnvelope(unit({ name: "وحدة جديدة", id: OTHER_UNIT_ID })));
    await flush();
    assert.equal(harness.listCalls.length, 2, "the bounded follow-up read is on the wire");
    assert.equal(controller.getState().mutation.status, "idle");

    // The REAL production tree, with the REAL controller in its ref: the
    // actual row control is inspected and its actual callback is invoked.
    const controls = collectControls(await renderCourseUnitManagerTree(controller));
    const archive = controls.find((control) => control.text.includes("أرشفة"));
    assert.ok(archive, "the real row archive control exists");
    assert.notEqual(
      archive.disabled,
      true,
      "the archive control is enabled while the follow-up read is pending",
    );

    archive.onClick();
    await flush();
    assert.equal(
      harness.updateCalls.length,
      1,
      "the enabled control's real callback reached the transport instead of being dropped",
    );
    assert.deepEqual(harness.updateCalls[0].update, { status: "archived" });

    harness.updateDeferreds[0].resolve(writeEnvelope(unit({ status: "archived" })));
    harness.lists[1].resolve(listEnvelope([unit()]));
    await created;
    await controller.waitForIdle();
    assert.equal(controller.getState().rows[0].status, "archived", "the confirmed archive is applied");
  } finally {
    controller.dispose();
  }
});

test("component: the close control stays usable while a read is on the wire", async () => {
  const controller = createCourseUnitController(COURSE_ID, {
    readPrincipal: () => "session:a",
    listUnits: async () => listEnvelope([unit()]),
  });
  try {
    await controller.open();
    await controller.waitForIdle();

    const loading = controller.getState();
    loading.phase = "loading";
    const html = await renderCourseUnitManager(loading);
    const closeTag = buttonOpeningTag(html, "إغلاق اللوحة");
    assert.equal(
      hasDisabledAttribute(closeTag),
      false,
      "a slow read can always be abandoned",
    );
  } finally {
    controller.dispose();
  }
});

test("component: the editor renders both bound fields, the local error and a typed position", async () => {
  const html = await renderCourseUnitManager(
    readyState({
      form: {
        mode: "edit",
        nameDraft: "الوحدة الأولى",
        orderDraft: "3",
        targetId: UNIT_ID,
        targetName: "الوحدة الأولى",
        originalName: "الوحدة الأولى",
        originalOrder: "0",
        error: COURSE_UNIT_ORDER_INVALID_MESSAGE,
      },
    }),
  );

  assert.match(html, /for="course-unit-name"/, "the name input has a bound label");
  assert.match(html, /for="course-unit-order"/, "the position input has a bound label");
  assert.match(html, /id="course-unit-name"/);
  assert.match(html, /id="course-unit-order"/);
  assert.match(html, /value="3"/, "the typed position is rendered");
  assert.match(html, /موضع العرض داخل الكورس/, "the position is labelled as a display position");
  assert.match(
    html,
    /لا يفتح درسًا ولا ينشر محتوى ولا يغيّر صلاحية الوصول/,
    "the metadata position is never presented as a lesson or publication rule",
  );
  assert.match(html, new RegExp(COURSE_UNIT_ORDER_INVALID_MESSAGE));
});

test("component: every non-submit button carries type=button", async () => {
  const html = await renderCourseUnitManager(
    readyState({
      form: {
        mode: "create",
        nameDraft: "وحدة",
        orderDraft: "",
        targetId: null,
        targetName: null,
        originalName: null,
        originalOrder: null,
        error: null,
      },
    }),
  );

  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.ok(buttons.length > 0, "the panel renders buttons");
  const submits = buttons.filter((tag) => /type="submit"/.test(tag));
  assert.equal(submits.length, 1, "exactly one submit button - the form save");
  for (const tag of buttons) {
    if (/type="submit"/.test(tag)) continue;
    assert.match(tag, /type="button"/, "every non-submit button is type=button");
  }
});

test("component: the panel says the honest paging and mutable-cursor notice", async () => {
  const html = await renderCourseUnitManager(readyState());
  assert.match(html, /الموضع هنا ترتيب عرض داخل الكورس فقط/);
  assert.match(html, /الموضع مؤشر لا لقطة ثابتة/);
  assert.match(html, /مالك المؤسسة فقط/, "the owner-only nature is a label, never an inferred permission");
});
