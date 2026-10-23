/**
 * M2-19 private bounded group weekly schedules — isolated production-path
 * tests (node:test + tsx).
 *
 * Scope: the REAL production seams
 *  - `src/lib/api.ts` (`listGroupSchedules`, `createGroupSchedule`,
 *    `updateGroupSchedule`, `deleteGroupSchedule`, `parseGroupSchedule`,
 *    `parseGroupScheduleList`, `canonicalGroupDays`, `canonicalGroupTime`),
 *    driven through a stubbed `fetch`/`localStorage`/`window`;
 *  - `src/features/groups/group-schedules.ts` (`createGroupScheduleController`
 *    and its classifiers), driven with an injected fake transport, principal
 *    reader and session notifier.
 *
 * Fully isolated: no DB, no network, no browser, no live services, no install.
 *
 * Behaviours pinned:
 *  - the canonical authenticated requests: `/api/groups` and
 *    `/api/groups/:id`, the bearer header, the JSON content type and NO client
 *    tenant/instructor selector anywhere in the request;
 *  - the strict canonical write body: `schedule_days` is ALWAYS present in
 *    canonical order and `schedule_time` is ALWAYS present as `HH:mm` or
 *    `null`, so unchecking the last weekday or clearing the time is an explicit
 *    clear and never an accidental omission;
 *  - the documented transport error behaviour: the server `error` message is
 *    thrown WITHOUT the HTTP status and WITHOUT the `code`, so only documented
 *    messages classify an outcome; the BILLING_ONLY identity event and the
 *    TENANT_SUSPENDED teardown keep working;
 *  - runtime DTO validation: the exact ten-field projection, canonical unique
 *    weekday keys of at most seven entries, and an `HH:mm`-or-null time — an
 *    extra key, a duplicate day or a `HH:mm:ss` echo is a malformed response,
 *    never a fabricated group;
 *  - one synchronous flight per read and per write: a double-clicked refresh or
 *    save never sends a second request;
 *  - a write reply for another group id is NOT a success for this write;
 *  - an unknown write outcome stays explicitly uncertain: no automatic retry,
 *    the draft is preserved;
 *  - a definite authorization/scope loss clears the private rows, the form and
 *    the draft; a 404 removes the vanished row and closes a form bound to it;
 *  - the canonical principal is observed at entry AND at completion on the
 *    success and the failure path, and a RETIRED reply never repopulates the
 *    cleared state;
 *  - a session event and a dispose clear the private state and drop in-flight
 *    replies.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  GROUP_SCHEDULE_MALFORMED_MESSAGE,
  canonicalGroupDays,
  canonicalGroupTime,
  createGroupSchedule,
  deleteGroupSchedule,
  listGroupSchedules,
  parseGroupSchedule,
  parseGroupScheduleList,
  updateGroupSchedule,
  type GroupSchedule,
} from "../lib/api";
import {
  GROUP_MAX_STUDENTS_INVALID_MESSAGE,
  GROUP_NAME_INVALID_MESSAGE,
  GROUP_TIME_INVALID_MESSAGE,
  GROUP_WRITE_UNCERTAIN_MESSAGE,
  classifyGroupScheduleReadFailure,
  classifyGroupScheduleWriteFailure,
  createGroupScheduleController,
  isGroupScheduleAuthorizationLoss,
  type GroupScheduleApi,
  type GroupScheduleDay,
  type GroupScheduleWrite,
} from "../features/groups/group-schedules";

// ---------------------------------------------------------------------------
// Deferred + flush helpers
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

const GROUP_ID = "3f7c1c6e-6f1a-4a0a-9a2f-0d1c2b3a4e5f";
const OTHER_ID = "7a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d";

const groupDto = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: GROUP_ID,
  name: "Algebra A",
  description: "Evening group",
  course_id: null,
  grade_id: null,
  max_students: 25,
  current_students: 7,
  is_active: true,
  schedule_days: ["sat", "mon"],
  schedule_time: "18:30",
  ...overrides,
});

const parsedGroup = (overrides: Partial<GroupSchedule> = {}): GroupSchedule => ({
  id: GROUP_ID,
  name: "Algebra A",
  description: "Evening group",
  course_id: null,
  grade_id: null,
  max_students: 25,
  current_students: 7,
  is_active: true,
  schedule_days: ["sat", "mon"],
  schedule_time: "18:30",
  ...overrides,
});

// ===========================================================================
// Transport seam — the REAL adapters through the REAL group request
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
  store.set("currentUser", JSON.stringify({ id: "user-1", role: "instructor" }));

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
  }) as unknown as typeof fetch;
};

const withTransport = async <T>(
  token: string | null,
  response: () => { ok: boolean; status: number; body: unknown },
  fn: (env: TransportEnv) => Promise<T>,
): Promise<T> => {
  const env = installTransportEnvironment(token);
  stubFetch(env, response);
  try {
    return await fn(env);
  } finally {
    env.restore();
  }
};

const headerOf = (init: RequestInit, name: string): string | undefined => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers[name];
};

// ---------------------------------------------------------------------------
// Transport: the canonical requests
// ---------------------------------------------------------------------------

test("transport: GET /api/groups sends the bearer token and no client selector", async () => {
  await withTransport("token-abc", () => ({ ok: true, status: 200, body: [groupDto()] }), async (env) => {
    const rows = await listGroupSchedules();

    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].url, "/api/groups");
    assert.equal(headerOf(env.calls[0].init, "Authorization"), "Bearer token-abc");
    assert.equal(headerOf(env.calls[0].init, "Content-Type"), "application/json");
    assert.equal(env.calls[0].init.body, undefined, "a read carries no body");
    assert.equal(env.calls[0].url.includes("tenant"), false);
    assert.equal(env.calls[0].url.includes("instructor"), false);
    assert.deepEqual(rows, [parsedGroup()]);
  });
});

test("transport: POST /api/groups sends the strict canonical body", async () => {
  const body = {
    name: "Physics A",
    description: null,
    grade_id: null,
    max_students: 20,
    is_active: true,
    schedule_days: ["sat", "mon"] as GroupScheduleDay[],
    schedule_time: "17:05",
  };
  await withTransport("token-abc", () => ({ ok: true, status: 201, body: groupDto({ name: "Physics A" }) }), async (env) => {
    await createGroupSchedule(body);

    assert.equal(env.calls[0].url, "/api/groups");
    assert.equal(env.calls[0].init.method, "POST");
    const sent = JSON.parse(String(env.calls[0].init.body));
    assert.deepEqual(sent, body, "exactly the canonical keys, nothing else");
    assert.equal(Object.prototype.hasOwnProperty.call(sent, "tenant_id"), false);
  });
});

test("transport: PUT /api/groups/:id encodes the id and sends an explicit clear", async () => {
  await withTransport("token-abc", () => ({ ok: true, status: 200, body: groupDto() }), async (env) => {
    await updateGroupSchedule("a/b", { schedule_days: [], schedule_time: null });

    assert.equal(env.calls[0].url, "/api/groups/a%2Fb");
    assert.equal(env.calls[0].init.method, "PUT");
    const sent = JSON.parse(String(env.calls[0].init.body));
    assert.deepEqual(sent, { schedule_days: [], schedule_time: null });
    assert.equal("schedule_days" in sent, true, "an empty list is present, not omitted");
    assert.equal("schedule_time" in sent, true, "a null time is present, not omitted");
  });
});

test("transport: DELETE /api/groups/:id is a DELETE and tolerates the message envelope", async () => {
  await withTransport("token-abc", () => ({ ok: true, status: 200, body: { message: "Group deleted successfully" } }), async (env) => {
    await deleteGroupSchedule(GROUP_ID);
    assert.equal(env.calls[0].url, `/api/groups/${GROUP_ID}`);
    assert.equal(env.calls[0].init.method, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// Transport: documented error behaviour
// ---------------------------------------------------------------------------

test("transport: the server message is thrown without the status or the code", async () => {
  await withTransport("token-abc", () => ({ ok: false, status: 400, body: { error: "Invalid schedule days", code: "SOMETHING" } }), async () => {
    await assert.rejects(
      () => updateGroupSchedule(GROUP_ID, { schedule_days: ["sat"] }),
      (error: Error) => {
        assert.equal(error.message, "Invalid schedule days");
        assert.equal(error.message.includes("400"), false);
        assert.equal(error.message.includes("SOMETHING"), false);
        return true;
      },
    );
  });
});

test("transport: a 2xx body that is not the accepted DTO is not a success", async () => {
  await withTransport("token-abc", () => ({ ok: true, status: 200, body: { id: GROUP_ID } }), async () => {
    await assert.rejects(
      () => listGroupSchedules(),
      (error: Error) => {
        assert.equal(error.message, GROUP_SCHEDULE_MALFORMED_MESSAGE);
        return true;
      },
    );
  });
  await withTransport("token-abc", () => ({ ok: true, status: 200, body: [groupDto({ extra: 1 })] }), async () => {
    await assert.rejects(() => listGroupSchedules(), { message: GROUP_SCHEDULE_MALFORMED_MESSAGE });
  });
});

test("transport: BILLING_ONLY marks the identity and redirects to the subscription page", async () => {
  await withTransport("token-abc", () => ({
    ok: false,
    status: 403,
    body: { error: "Subscription grace period ended.", code: "BILLING_ONLY" },
  }), async (env) => {
    await assert.rejects(() => listGroupSchedules(), { message: "Subscription grace period ended." });
    const stored = JSON.parse(env.store.get("currentUser") || "null");
    assert.equal(stored.billing_only, true);
    assert.deepEqual(env.assignedUrls, ["/instructor-subscription"]);
    assert.ok(env.store.has("authToken"), "the billing-only path keeps the session");
  });
});

test("transport: TENANT_SUSPENDED clears the session and redirects to /auth", async () => {
  await withTransport("token-abc", () => ({
    ok: false,
    status: 403,
    body: { error: "Instructor account is administratively suspended", code: "TENANT_SUSPENDED" },
  }), async (env) => {
    await assert.rejects(() => listGroupSchedules(), {
      message: "Instructor account is administratively suspended",
    });
    assert.equal(env.store.has("authToken"), false);
    assert.deepEqual(env.assignedUrls, ["/auth"]);
  });
});

// ---------------------------------------------------------------------------
// Canonical parsing
// ---------------------------------------------------------------------------

test("parse: the exact ten-field DTO is accepted and weekday order is canonicalised", () => {
  const parsed = parseGroupSchedule(groupDto({ schedule_days: ["mon", "sat"] }));
  assert.ok(parsed);
  assert.deepEqual(parsed!.schedule_days, ["sat", "mon"]);
  assert.equal(parsed!.schedule_time, "18:30");
  assert.deepEqual(Object.keys(parsed!).sort(), [
    "course_id", "current_students", "description", "grade_id", "id",
    "is_active", "max_students", "name", "schedule_days", "schedule_time",
  ]);
});

test("parse: an extra key, a missing key or a wrong type is malformed", () => {
  const malformed: unknown[] = [
    groupDto({ tenant_id: "tenant-a" }),
    groupDto({ instructor_id: "instructor-a" }),
    (() => { const { schedule_time, ...rest } = groupDto(); return rest; })(),
    groupDto({ id: "" }),
    groupDto({ name: "   " }),
    groupDto({ max_students: "25" }),
    groupDto({ current_students: null }),
    groupDto({ is_active: 1 }),
    groupDto({ description: 7 }),
    null,
    [],
    "group",
    42,
  ];
  for (const body of malformed) {
    assert.equal(parseGroupSchedule(body), null, `body ${JSON.stringify(body)} must be rejected`);
  }
});

test("parse: weekday duplicates, unknown keys and more than seven are malformed", () => {
  const malformed: unknown[] = [
    ["sat", "sat"],
    ["funday"],
    ["MON"],
    ["sat", "sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    ["sat", "sun", "mon", "tue", "wed", "thu", "fri", "extra"],
    "sat",
    [1],
    [null],
  ];
  for (const days of malformed) {
    assert.equal(parseGroupSchedule(groupDto({ schedule_days: days })), null);
    assert.equal(canonicalGroupDays(days), null);
  }
  assert.deepEqual(canonicalGroupDays([]), []);
  assert.deepEqual(canonicalGroupDays(["fri", "sat"]), ["sat", "fri"]);
});

test("parse: only a real HH:mm or null is a valid time", () => {
  for (const time of ["18:30", "00:00", "23:59", null]) {
    assert.equal(canonicalGroupTime(time), time);
  }
  for (const time of ["18:30:00", "7:30", "24:00", "23:60", "", 1830, true, [], {}]) {
    assert.equal(canonicalGroupTime(time), undefined);
    assert.equal(parseGroupSchedule(groupDto({ schedule_time: time })), null);
  }
});

test("parse: the list body is a bare array of valid DTOs", () => {
  assert.equal(parseGroupScheduleList({ groups: [] }), null);
  assert.equal(parseGroupScheduleList([groupDto(), { id: GROUP_ID }]), null);
  const parsed = parseGroupScheduleList([groupDto(), groupDto({ id: OTHER_ID, name: "Geometry B" })]);
  assert.equal(parsed!.length, 2);
  assert.equal(parsed![1].name, "Geometry B");
});

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

test("classify: only documented messages decide a read outcome", () => {
  assert.equal(classifyGroupScheduleReadFailure(new Error("Token expired")).phase, "unauthorized");
  assert.equal(classifyGroupScheduleReadFailure(new Error("No token provided")).phase, "unauthorized");
  assert.equal(
    classifyGroupScheduleReadFailure(new Error("Instructor account is administratively suspended")).phase,
    "denied",
  );
  assert.equal(
    classifyGroupScheduleReadFailure(new Error("Teaching access is not active for the selected tenant")).phase,
    "denied",
  );
  assert.equal(classifyGroupScheduleReadFailure(new Error("Tenant membership not found")).phase, "no-workspace");
  assert.equal(classifyGroupScheduleReadFailure(new Error("Failed to fetch groups")).phase, "error");
  const unknown = classifyGroupScheduleReadFailure(new Error("socket hang up"));
  assert.equal(unknown.phase, "error");
  assert.equal(unknown.reason, "unknown");
  assert.equal(unknown.message, "socket hang up", "the real message is never replaced");
});

test("classify: a write separates refusal from an uncertain outcome", () => {
  assert.equal(classifyGroupScheduleWriteFailure(new Error("Group not found")).kind, "missing");
  assert.equal(classifyGroupScheduleWriteFailure(new Error("Invalid schedule days")).kind, "invalid");
  assert.equal(classifyGroupScheduleWriteFailure(new Error("Invalid course selector")).kind, "invalid");
  assert.equal(classifyGroupScheduleWriteFailure(new Error("Failed to save group")).kind, "uncertain");
  assert.equal(classifyGroupScheduleWriteFailure(new Error("socket hang up")).kind, "uncertain");
  assert.equal(classifyGroupScheduleWriteFailure(new Error("Forbidden")).kind, "denied");
  assert.equal(classifyGroupScheduleWriteFailure(new Error("Session revoked")).kind, "unauthorized");
});

test("classify: only a definite denial is an authorization loss", () => {
  assert.equal(isGroupScheduleAuthorizationLoss("session"), true);
  assert.equal(isGroupScheduleAuthorizationLoss("suspended"), true);
  assert.equal(isGroupScheduleAuthorizationLoss("denied"), true);
  assert.equal(isGroupScheduleAuthorizationLoss("no-workspace"), true);
  assert.equal(isGroupScheduleAuthorizationLoss("server"), false);
  assert.equal(isGroupScheduleAuthorizationLoss("unknown"), false);
  assert.equal(isGroupScheduleAuthorizationLoss("missing"), false);
  assert.equal(isGroupScheduleAuthorizationLoss("invalid"), false);
});

// ===========================================================================
// Controller harness
// ===========================================================================

interface Harness {
  api: GroupScheduleApi;
  listCalls: number;
  lists: Deferred<unknown>[];
  creates: Deferred<unknown>[];
  createWrites: GroupScheduleWrite[];
  updates: Deferred<unknown>[];
  updateCalls: { id: string; write: GroupScheduleWrite }[];
  removes: Deferred<unknown>[];
  removeIds: string[];
}

const createHarness = (): Harness => {
  const harness: Harness = {
    listCalls: 0,
    lists: [],
    creates: [],
    createWrites: [],
    updates: [],
    updateCalls: [],
    removes: [],
    removeIds: [],
    api: {
      list: () => {
        harness.listCalls += 1;
        const d = deferred<unknown>();
        harness.lists.push(d);
        return d.promise;
      },
      create: (write) => {
        harness.createWrites.push(write);
        const d = deferred<unknown>();
        harness.creates.push(d);
        return d.promise;
      },
      update: (id, write) => {
        harness.updateCalls.push({ id, write });
        const d = deferred<unknown>();
        harness.updates.push(d);
        return d.promise;
      },
      remove: (id) => {
        harness.removeIds.push(id);
        const d = deferred<unknown>();
        harness.removes.push(d);
        return d.promise;
      },
    },
  };
  return harness;
};

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

const loadReady = async (harness: Harness, controller: ReturnType<typeof createGroupScheduleController>, rows: unknown) => {
  const operation = controller.load();
  await flush();
  harness.lists[0].resolve(rows);
  await operation;
};

// ---------------------------------------------------------------------------
// Controller — reads
// ---------------------------------------------------------------------------

test("load: one bounded read commits the canonical rows in server order", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  const operation = controller.load();
  await flush();

  assert.equal(harness.listCalls, 1);
  harness.lists[0].resolve([
    groupDto({ id: OTHER_ID, name: "Geometry B", schedule_days: ["sun"], schedule_time: "09:00" }),
    groupDto(),
  ]);
  await operation;

  const state = controller.getState();
  assert.equal(state.phase, "ready");
  assert.deepEqual(state.rows.map((row) => row.id), [GROUP_ID, OTHER_ID], "rows are ordered by name");
  assert.deepEqual(state.rows[0].schedule_days, ["sat", "mon"]);
  assert.equal(state.rows[0].schedule_time, "18:30");
  assert.equal(state.error, null);
});

test("load: an empty list is the empty phase, not an error", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  const operation = controller.load();
  await flush();
  harness.lists[0].resolve([]);
  await operation;

  assert.equal(controller.getState().phase, "empty");
  assert.deepEqual(controller.getState().rows, []);
});

test("load: a malformed row fails the whole read instead of holding a partial list", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  const operation = controller.load();
  await flush();
  harness.lists[0].resolve([groupDto(), groupDto({ schedule_days: ["sat", "sat"] })]);
  await operation;

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.deepEqual(state.rows, [], "no partial list is held");
  assert.equal(state.error, GROUP_SCHEDULE_MALFORMED_MESSAGE);
});

test("load: a double-clicked read never sends a second request", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  const first = controller.load();
  const second = controller.load();
  await flush();

  assert.equal(harness.listCalls, 1, "the single-flight latch blocks the duplicate");
  harness.lists[0].resolve([groupDto()]);
  await Promise.all([first, second]);
  assert.equal(controller.getState().phase, "ready");
});

test("load: a retryable failure keeps an open draft for a deliberate retry", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);

  controller.openEdit(GROUP_ID);
  controller.setField({ name: "Edited name" });

  const operation = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Failed to fetch groups"));
  await operation;

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error, "Failed to fetch groups");
  assert.equal(state.form.mode, "edit", "the form survives a retryable failure");
  assert.equal(state.form.name, "Edited name", "the draft survives");
});

test("load: a definite denial clears the rows, the form and the draft", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);

  const operation = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Teaching access is not active for the selected tenant"));
  await operation;

  const state = controller.getState();
  assert.equal(state.phase, "denied");
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.reason, "denied");
});

// ---------------------------------------------------------------------------
// Controller — form lifecycle
// ---------------------------------------------------------------------------

test("form: create opens only after a settled read and starts empty", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);

  controller.openCreate();
  assert.equal(controller.getState().form.mode, "closed", "no form before the list settles");

  await loadReady(harness, controller, []);
  controller.openCreate();
  const form = controller.getState().form;
  assert.equal(form.mode, "create");
  assert.equal(form.name, "");
  assert.deepEqual(form.days, []);
  assert.equal(form.time, "");
  assert.equal(form.maxStudents, "50");
});

test("form: edit is bound to a row of the current list and carries its schedule", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);

  controller.openEdit(OTHER_ID);
  assert.equal(controller.getState().form.mode, "closed", "an unknown id never opens a form");

  controller.openEdit(GROUP_ID);
  const form = controller.getState().form;
  assert.equal(form.mode, "edit");
  assert.equal(form.targetId, GROUP_ID);
  assert.equal(form.name, "Algebra A");
  assert.deepEqual(form.days, ["sat", "mon"]);
  assert.equal(form.time, "18:30");
  assert.equal(form.maxStudents, "25");
});

test("form: toggleDay keeps canonical order and is its own inverse", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);

  controller.toggleDay("fri");
  controller.toggleDay("sun");
  assert.deepEqual(controller.getState().form.days, ["sat", "sun", "mon", "fri"], "canonical order");

  controller.toggleDay("fri");
  controller.toggleDay("sun");
  assert.deepEqual(controller.getState().form.days, ["sat", "mon"]);
});

test("form: cancel closes without any request and keeps the rows", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);
  controller.setField({ name: "Discarded" });

  controller.cancel();

  assert.equal(controller.getState().form.mode, "closed");
  assert.equal(controller.getState().rows.length, 1);
  assert.equal(harness.updateCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Controller — writes
// ---------------------------------------------------------------------------

test("save: a create sends the strict canonical body and commits the server DTO", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, []);

  controller.openCreate();
  controller.setField({ name: "  Physics A  ", description: "  Intro  ", maxStudents: "20", time: "17:05" });
  controller.toggleDay("mon");
  controller.toggleDay("sat");

  const operation = controller.save();
  await flush();

  assert.equal(harness.createWrites.length, 1);
  assert.deepEqual(harness.createWrites[0], {
    name: "Physics A",
    description: "Intro",
    grade_id: null,
    max_students: 20,
    is_active: true,
    schedule_days: ["sat", "mon"],
    schedule_time: "17:05",
  });

  harness.creates[0].resolve(groupDto({ id: OTHER_ID, name: "Physics A", schedule_days: ["sat", "mon"], schedule_time: "17:05" }));
  const outcome = await operation;

  assert.equal(outcome, "confirmed");
  const state = controller.getState();
  assert.equal(state.form.mode, "closed");
  assert.deepEqual(state.rows.map((row) => row.id), [OTHER_ID]);
  assert.equal(state.lastConfirmed?.name, "Physics A");
});

test("save: unchecking every day and clearing the time is an explicit clear", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);

  controller.openEdit(GROUP_ID);
  controller.toggleDay("sat");
  controller.toggleDay("mon");
  controller.setField({ time: "" });

  const operation = controller.save();
  await flush();

  const write = harness.updateCalls[0].write;
  assert.equal("schedule_days" in write, true);
  assert.equal("schedule_time" in write, true);
  assert.deepEqual(write.schedule_days, []);
  assert.equal(write.schedule_time, null);

  harness.updates[0].resolve(groupDto({ schedule_days: [], schedule_time: null }));
  assert.equal(await operation, "confirmed");
  assert.deepEqual(controller.getState().rows[0].schedule_days, []);
  assert.equal(controller.getState().rows[0].schedule_time, null);
});

test("save: local validation refuses the request and keeps the input", async () => {
  const cases: Array<{ patch: Record<string, string>; message: string }> = [
    { patch: { name: "   " }, message: GROUP_NAME_INVALID_MESSAGE },
    { patch: { maxStudents: "0" }, message: GROUP_MAX_STUDENTS_INVALID_MESSAGE },
    { patch: { maxStudents: "1001" }, message: GROUP_MAX_STUDENTS_INVALID_MESSAGE },
    { patch: { maxStudents: "12.5" }, message: GROUP_MAX_STUDENTS_INVALID_MESSAGE },
    { patch: { maxStudents: "" }, message: GROUP_MAX_STUDENTS_INVALID_MESSAGE },
    { patch: { time: "7:30" }, message: GROUP_TIME_INVALID_MESSAGE },
    { patch: { time: "24:00" }, message: GROUP_TIME_INVALID_MESSAGE },
  ];
  for (const { patch, message } of cases) {
    const harness = createHarness();
    const controller = createGroupScheduleController(harness.api);
    await loadReady(harness, controller, [groupDto()]);
    controller.openEdit(GROUP_ID);
    controller.setField(patch);

    const outcome = await controller.save();

    assert.equal(outcome, "invalid", `${JSON.stringify(patch)} must be refused locally`);
    assert.equal(controller.getState().form.error, message);
    assert.equal(controller.getState().form.mode, "edit", "the form stays open with the input");
    assert.equal(harness.updateCalls.length, 0, "nothing reaches the transport");
  }
});

test("save: a double-clicked save never sends a second write", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);
  controller.setField({ time: "19:00" });

  const first = controller.save();
  const second = controller.save();
  await flush();

  assert.equal(await second, "blocked");
  assert.equal(harness.updateCalls.length, 1, "the single-flight latch blocks the duplicate");

  harness.updates[0].resolve(groupDto({ schedule_time: "19:00" }));
  assert.equal(await first, "confirmed");
});

test("save: a server refusal keeps the form and the draft for a deliberate retry", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);
  controller.setField({ time: "19:00" });

  const operation = controller.save();
  await flush();
  harness.updates[0].reject(new Error("Invalid schedule time"));
  const outcome = await operation;

  assert.equal(outcome, "rejected");
  const state = controller.getState();
  assert.equal(state.form.mode, "edit");
  assert.equal(state.form.time, "19:00", "the draft is preserved");
  assert.equal(state.mutation.error, "Invalid schedule time");
  assert.equal(state.mutation.status, "idle");
});

test("save: an uncertain 500 is never retried and preserves the draft", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);
  controller.setField({ time: "19:00" });

  const operation = controller.save();
  await flush();
  harness.updates[0].reject(new Error("Failed to save group"));
  const outcome = await operation;

  assert.equal(outcome, "uncertain");
  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.notice, GROUP_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.form.mode, "edit", "the draft survives an unknown outcome");
  assert.equal(harness.updateCalls.length, 1, "nothing is retried automatically");
});

test("save: a 2xx body that cannot be validated is uncertain, not success", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);

  const operation = controller.save();
  await flush();
  harness.updates[0].resolve({ id: GROUP_ID });
  const outcome = await operation;

  assert.equal(outcome, "uncertain");
  assert.equal(controller.getState().mutation.status, "uncertain");
  assert.equal(controller.getState().form.mode, "edit");
});

test("save: a reply for another group id is not a success for this write", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);
  controller.setField({ time: "19:00" });

  const operation = controller.save();
  await flush();
  harness.updates[0].resolve(groupDto({ id: OTHER_ID, schedule_time: "19:00" }));
  const outcome = await operation;

  assert.equal(outcome, "uncertain", "another group's DTO never confirms this write");
  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.form.mode, "edit");
  assert.deepEqual(state.rows.map((row) => row.id), [GROUP_ID], "the held row is untouched");
});

test("save: a denial clears the private state and reports the server message", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);

  const operation = controller.save();
  await flush();
  harness.updates[0].reject(new Error("Teaching access is not active for the selected tenant"));
  const outcome = await operation;

  assert.equal(outcome, "rejected");
  const state = controller.getState();
  assert.equal(state.phase, "denied");
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.error, "Teaching access is not active for the selected tenant");
});

test("save: a 404 removes the vanished row and closes the form bound to it", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto(), groupDto({ id: OTHER_ID, name: "Geometry B" })]);
  controller.openEdit(GROUP_ID);

  const operation = controller.save();
  await flush();
  harness.updates[0].reject(new Error("Group not found"));
  const outcome = await operation;

  assert.equal(outcome, "rejected");
  const state = controller.getState();
  assert.deepEqual(state.rows.map((row) => row.id), [OTHER_ID], "the vanished row is dropped");
  assert.equal(state.form.mode, "closed", "the form bound to it is closed");
  assert.equal(state.mutation.error, "Group not found");
});

// ---------------------------------------------------------------------------
// Controller — delete and status
// ---------------------------------------------------------------------------

test("remove: a confirmed delete drops exactly one row", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto(), groupDto({ id: OTHER_ID, name: "Geometry B" })]);

  const operation = controller.remove(GROUP_ID);
  await flush();
  assert.deepEqual(harness.removeIds, [GROUP_ID]);
  harness.removes[0].resolve({ message: "Group deleted successfully" });

  assert.equal(await operation, "confirmed");
  const state = controller.getState();
  assert.deepEqual(state.rows.map((row) => row.id), [OTHER_ID]);
  assert.equal(state.mutation.notice !== null, true);
});

test("remove: an unknown id and a duplicate click never reach the transport", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);

  assert.equal(await controller.remove(OTHER_ID), "idle");
  assert.equal(harness.removeIds.length, 0);

  const first = controller.remove(GROUP_ID);
  const second = controller.remove(GROUP_ID);
  await flush();
  assert.equal(await second, "blocked");
  assert.equal(harness.removeIds.length, 1);

  harness.removes[0].resolve({ message: "Group deleted successfully" });
  await first;
});

test("setActive: sends only is_active and commits the server DTO", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);

  const operation = controller.setActive(GROUP_ID, false);
  await flush();

  assert.deepEqual(harness.updateCalls[0], { id: GROUP_ID, write: { is_active: false } });
  harness.updates[0].resolve(groupDto({ is_active: false }));
  assert.equal(await operation, "confirmed");
  assert.equal(controller.getState().rows[0].is_active, false);
});

test("setActive: the current state is a truthful no-op", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);

  assert.equal(await controller.setActive(GROUP_ID, true), "idle");
  assert.equal(harness.updateCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Controller — principal, session and dispose fences
// ---------------------------------------------------------------------------

test("principal: a change observed at completion discards the reply and clears the state", async () => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal = "session:1";
  const controller = createGroupScheduleController({
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });

  const operation = controller.load();
  await flush();
  principal = "session:2";
  harness.lists[0].resolve([groupDto()]);
  await operation;

  const state = controller.getState();
  assert.equal(state.phase, "idle", "the foreign reply never commits");
  assert.deepEqual(state.rows, []);
});

test("session: an event retires the in-flight read and clears the private state", async () => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createGroupScheduleController({
    ...harness.api,
    readPrincipal: () => "session:1",
    subscribeSession: sink.subscribeSession,
  });

  const operation = controller.load();
  await flush();
  sink.fire();
  // The event retires the in-flight read AND starts one read for the new
  // session, so the retired reply can never be the state on screen.
  assert.equal(harness.listCalls, 2);

  harness.lists[0].resolve([groupDto()]);
  await operation;

  assert.deepEqual(controller.getState().rows, [], "a retired reply never repopulates the cleared rows");

  // The follow-up read owns the visible state.
  harness.lists[1].resolve([]);
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "empty");
});

test("session: an event during a write discards the reply and claims nothing", async () => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createGroupScheduleController({
    ...harness.api,
    readPrincipal: () => "session:1",
    subscribeSession: sink.subscribeSession,
  });
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);

  const operation = controller.save();
  await flush();
  sink.fire();
  harness.updates[0].resolve(groupDto({ schedule_time: "19:00" }));
  const outcome = await operation;

  assert.notEqual(outcome, "confirmed");
  const state = controller.getState();
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.mutation.status, "idle");
});

test("dispose: nothing commits afterwards and the private state is cleared", async () => {
  const harness = createHarness();
  const controller = createGroupScheduleController(harness.api);
  await loadReady(harness, controller, [groupDto()]);
  controller.openEdit(GROUP_ID);

  const operation = controller.save();
  await flush();
  controller.dispose();
  harness.updates[0].resolve(groupDto({ schedule_time: "19:00" }));
  await operation;

  const state = controller.getState();
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.phase, "idle");

  assert.equal(await controller.save(), "idle");
  assert.equal(await controller.remove(GROUP_ID), "idle");
  assert.equal(harness.updateCalls.length, 1, "no request is issued after dispose");
});
