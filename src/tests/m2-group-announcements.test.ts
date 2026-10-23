/**
 * M2-21 private group announcements — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seams
 *  - `src/lib/api-http.ts` (`listGroupAnnouncements`, `createGroupAnnouncement`,
 *    `updateGroupAnnouncement`, `retractGroupAnnouncement`,
 *    `parseGroupAnnouncement`, `parseGroupAnnouncementList`), driven through a
 *    stubbed `fetch`/`localStorage`/`window`;
 *  - `src/features/groups/group-announcements.ts`
 *    (`createGroupAnnouncementController` and its classifiers), driven with an
 *    injected fake transport, principal reader and session notifier.
 *
 * Fully isolated: no DB, no network, no browser, no live services, no install.
 *
 * Behaviours pinned:
 *  - the canonical authenticated requests: `/api/groups/:groupId/announcements`
 *    and its item/retract children, the bearer header, the JSON content type,
 *    the bounded `limit` query and NO client tenant or instructor selector
 *    anywhere in the request;
 *  - the strict canonical write bodies: create sends `title`/`body` (and only
 *    the state the instructor chose), update sends only the keys it was given,
 *    retract sends an empty object;
 *  - the documented transport error behaviour: the server `error` message is
 *    thrown WITHOUT the HTTP status and WITHOUT the `code`, so only documented
 *    messages classify an outcome;
 *  - runtime DTO validation: the exact EIGHT-field projection, a known state
 *    and string-or-null server stamps — an extra key, a missing field, an
 *    unknown state or a numeric stamp is a malformed response, never a
 *    fabricated announcement; the list envelope must be exactly
 *    `{ announcements, next_cursor }`;
 *  - the bounded page lifecycle: only the server's own cursor asks for a next
 *    page, an append lands only on the page it was issued for, and a failed
 *    append never discards the page already held;
 *  - one synchronous flight per read and per write: a double-clicked refresh,
 *    save, publish or retract never sends a second request;
 *  - a write reply for another announcement (or another group) is NOT a success
 *    for this write;
 *  - an action the current state already satisfies (publishing a published
 *    announcement, retracting a retracted one, saving an unchanged edit) sends
 *    NOTHING and claims nothing;
 *  - an unknown write outcome stays explicitly uncertain: no automatic retry,
 *    the draft is preserved;
 *  - a definite authorization/scope loss clears the held rows, the form and the
 *    draft; a 404 removes the vanished row (or clears the whole panel when the
 *    GROUP vanished) and closes a form bound to it;
 *  - selecting another group invalidates the previous page and any in-flight
 *    reply for it;
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
  GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE,
  GROUP_ANNOUNCEMENT_PAGE_LIMIT,
  createGroupAnnouncement,
  listGroupAnnouncements,
  parseGroupAnnouncement,
  parseGroupAnnouncementList,
  retractGroupAnnouncement,
  updateGroupAnnouncement,
  type GroupAnnouncement,
} from "../lib/api-http";
import {
  ANNOUNCEMENT_BODY_INVALID_MESSAGE,
  ANNOUNCEMENT_RETRACTED_MESSAGE,
  ANNOUNCEMENT_TITLE_INVALID_MESSAGE,
  ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE,
  classifyGroupAnnouncementReadFailure,
  classifyGroupAnnouncementWriteFailure,
  createGroupAnnouncementController,
  isGroupAnnouncementAuthorizationLoss,
  type GroupAnnouncementApi,
} from "../features/groups/group-announcements";

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
const OTHER_GROUP_ID = "8b2c3d4e-5f6a-4b2c-9d3e-4f5a6b7c8d9e";
const ANN_1 = "11111111-1111-4111-8111-111111111111";
const ANN_2 = "22222222-2222-4222-8222-222222222222";
const ANN_OTHER = "33333333-3333-4333-8333-333333333333";

const annDto = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: ANN_1,
  group_id: GROUP_ID,
  title: "First session",
  body: "Bring the workbook.",
  state: "draft",
  created_at: "2026-10-23 09:00:00",
  updated_at: "2026-10-23 09:00:00",
  retracted_at: null,
  ...overrides,
});

const parsedAnn = (overrides: Partial<GroupAnnouncement> = {}): GroupAnnouncement => ({
  id: ANN_1,
  group_id: GROUP_ID,
  title: "First session",
  body: "Bring the workbook.",
  state: "draft",
  created_at: "2026-10-23 09:00:00",
  updated_at: "2026-10-23 09:00:00",
  retracted_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Transport environment
// ---------------------------------------------------------------------------

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
      pathname: "/groups",
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

test("transport: the list read sends the bearer token, the bounded limit and no selector", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 200, body: { announcements: [annDto()], next_cursor: null } }),
    async (env) => {
      const page = await listGroupAnnouncements(GROUP_ID);

      assert.equal(env.calls.length, 1);
      assert.equal(env.calls[0].url, `/api/groups/${GROUP_ID}/announcements?limit=${GROUP_ANNOUNCEMENT_PAGE_LIMIT}`);
      assert.equal(headerOf(env.calls[0].init, "Authorization"), "Bearer token-abc");
      assert.equal(headerOf(env.calls[0].init, "Content-Type"), "application/json");
      assert.equal(env.calls[0].init.body, undefined, "a read carries no body");
      assert.equal(env.calls[0].url.includes("tenant"), false);
      assert.equal(env.calls[0].url.includes("instructor"), false);
      assert.deepEqual(page, { announcements: [parsedAnn()], next_cursor: null });
    },
  );
});

test("transport: a supplied cursor is the only way to ask for a next page", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 200, body: { announcements: [], next_cursor: null } }),
    async (env) => {
      await listGroupAnnouncements(GROUP_ID, { limit: 10, cursor: "abc-_9" });
      assert.equal(
        env.calls[0].url,
        `/api/groups/${GROUP_ID}/announcements?limit=10&cursor=abc-_9`,
      );
    },
  );
});

test("transport: create sends the strict canonical body and returns the server DTO", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 201, body: annDto() }),
    async (env) => {
      const created = await createGroupAnnouncement(GROUP_ID, { title: "First session", body: "Bring the workbook." });

      assert.equal(env.calls[0].url, `/api/groups/${GROUP_ID}/announcements`);
      assert.equal(env.calls[0].init.method, "POST");
      assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), {
        title: "First session",
        body: "Bring the workbook.",
      });
      assert.deepEqual(created, parsedAnn());
    },
  );
});

test("transport: update sends ONLY the keys it was given", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 200, body: annDto({ state: "published" }) }),
    async (env) => {
      await updateGroupAnnouncement(GROUP_ID, ANN_1, { state: "published" });

      assert.equal(env.calls[0].url, `/api/groups/${GROUP_ID}/announcements/${ANN_1}`);
      assert.equal(env.calls[0].init.method, "PUT");
      assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { state: "published" });
    },
  );
});

test("transport: retract posts an empty body to the retract action", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 200, body: annDto({ state: "retracted", retracted_at: "2026-10-23 11:00:00" }) }),
    async (env) => {
      const retracted = await retractGroupAnnouncement(GROUP_ID, ANN_1);

      assert.equal(env.calls[0].url, `/api/groups/${GROUP_ID}/announcements/${ANN_1}/retract`);
      assert.equal(env.calls[0].init.method, "POST");
      assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), {});
      assert.equal(retracted.state, "retracted");
      assert.equal(retracted.retracted_at, "2026-10-23 11:00:00");
    },
  );
});

test("transport: the server error message is thrown without the status or the code", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: false, status: 400, body: { error: "Invalid announcement title", code: "SOME_CODE" } }),
    async () => {
      await assert.rejects(
        () => createGroupAnnouncement(GROUP_ID, { title: "", body: "b" }),
        (error: Error) => {
          assert.equal(error.message, "Invalid announcement title");
          assert.equal(error.message.includes("400"), false, "the status is never fabricated into the message");
          assert.equal(error.message.includes("SOME_CODE"), false, "the code is never fabricated into the message");
          return true;
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Runtime DTO validation
// ---------------------------------------------------------------------------

test("parse: the exact eight-field projection is accepted", () => {
  assert.deepEqual(parseGroupAnnouncement(annDto()), parsedAnn());
  assert.deepEqual(
    parseGroupAnnouncement(annDto({ state: "published", retracted_at: null })),
    parsedAnn({ state: "published" }),
  );
  assert.deepEqual(
    parseGroupAnnouncement(annDto({ state: "retracted", retracted_at: "2026-10-23 11:00:00" })),
    parsedAnn({ state: "retracted", retracted_at: "2026-10-23 11:00:00" }),
  );
});

test("parse: an extra key, a missing field, an unknown state or a bad stamp is malformed", () => {
  assert.equal(parseGroupAnnouncement(annDto({ tenant_id: "t" })), null, "an extra key is refused");
  assert.equal(parseGroupAnnouncement(annDto({ instructor_id: "u" })), null);
  const missing = annDto();
  delete (missing as Record<string, unknown>).retracted_at;
  assert.equal(parseGroupAnnouncement(missing), null, "a missing field is refused");
  assert.equal(parseGroupAnnouncement(annDto({ state: "archived" })), null, "an unknown state is refused");
  assert.equal(parseGroupAnnouncement(annDto({ state: 5 })), null);
  assert.equal(parseGroupAnnouncement(annDto({ created_at: 5 })), null, "a numeric stamp is refused");
  assert.equal(parseGroupAnnouncement(annDto({ title: "   " })), null, "a blank title is refused");
  assert.equal(parseGroupAnnouncement(annDto({ body: "   " })), null, "a blank body is refused");
  assert.equal(parseGroupAnnouncement(annDto({ id: "" })), null);
  assert.equal(parseGroupAnnouncement(null), null);
  assert.equal(parseGroupAnnouncement([]), null);
  assert.equal(parseGroupAnnouncement("x"), null);
});

test("parse: the list envelope must be exactly announcements + next_cursor", () => {
  assert.deepEqual(parseGroupAnnouncementList({ announcements: [annDto()], next_cursor: "abc" }), {
    announcements: [parsedAnn()],
    next_cursor: "abc",
  });
  assert.deepEqual(parseGroupAnnouncementList({ announcements: [], next_cursor: null }), {
    announcements: [],
    next_cursor: null,
  });
  assert.equal(parseGroupAnnouncementList({ announcements: [], next_cursor: null, total: 0 }), null);
  assert.equal(parseGroupAnnouncementList({ announcements: [] }), null);
  assert.equal(parseGroupAnnouncementList({ announcements: [annDto({ state: "archived" })], next_cursor: null }), null);
  assert.equal(parseGroupAnnouncementList({ announcements: [annDto()], next_cursor: 5 }), null);
  assert.equal(parseGroupAnnouncementList([annDto()]), null);
  assert.equal(parseGroupAnnouncementList(null), null);
});

test("transport: a malformed 2xx body is a malformed response, never a fabricated announcement", async () => {
  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 201, body: annDto({ tenant_id: "leak" }) }),
    async () => {
      await assert.rejects(
        () => createGroupAnnouncement(GROUP_ID, { title: "t", body: "b" }),
        { message: GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE },
      );
    },
  );

  await withTransport(
    "token-abc",
    () => ({ ok: true, status: 200, body: { announcements: [annDto()] } }),
    async () => {
      await assert.rejects(
        () => listGroupAnnouncements(GROUP_ID),
        { message: GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test("classify: only the documented read messages are classified", () => {
  assert.deepEqual(classifyGroupAnnouncementReadFailure(new Error("Token expired")), {
    phase: "unauthorized", reason: "session", message: "Token expired",
  });
  assert.equal(classifyGroupAnnouncementReadFailure(new Error("Forbidden")).phase, "denied");
  assert.equal(
    classifyGroupAnnouncementReadFailure(new Error("Teaching access is not active for the selected tenant")).reason,
    "denied",
  );
  assert.equal(classifyGroupAnnouncementReadFailure(new Error("Tenant membership not found")).phase, "no-workspace");
  assert.deepEqual(classifyGroupAnnouncementReadFailure(new Error("Group not found")), {
    phase: "error", reason: "missing", message: "Group not found",
  });
  assert.equal(classifyGroupAnnouncementReadFailure(new Error("Failed to list announcements")).reason, "server");
  assert.equal(classifyGroupAnnouncementReadFailure(new Error("Invalid announcement list limit")).reason, "invalid");
  assert.equal(classifyGroupAnnouncementReadFailure(new Error("boom")).reason, "unknown");
  assert.equal(classifyGroupAnnouncementReadFailure(new Error("")).reason, "unknown");
});

test("classify: only the documented write messages are classified", () => {
  assert.equal(classifyGroupAnnouncementWriteFailure(new Error("Session revoked")).kind, "unauthorized");
  assert.equal(classifyGroupAnnouncementWriteFailure(new Error("Forbidden")).kind, "denied");
  assert.deepEqual(
    classifyGroupAnnouncementWriteFailure(new Error("Group not found")).missingTarget,
    "group",
  );
  assert.deepEqual(
    classifyGroupAnnouncementWriteFailure(new Error("Announcement not found")).missingTarget,
    "announcement",
  );
  assert.equal(classifyGroupAnnouncementWriteFailure(new Error("Announcement is retracted")).kind, "conflict");
  assert.equal(
    classifyGroupAnnouncementWriteFailure(new Error("Announcement was modified concurrently")).kind,
    "conflict",
  );
  assert.equal(classifyGroupAnnouncementWriteFailure(new Error("Invalid announcement state")).kind, "invalid");
  assert.equal(classifyGroupAnnouncementWriteFailure(new Error("Failed to save announcement")).kind, "uncertain");
  assert.equal(classifyGroupAnnouncementWriteFailure(new Error("socket hang up")).kind, "uncertain");
});

test("classify: only a definite authorization loss retires the private state", () => {
  assert.equal(isGroupAnnouncementAuthorizationLoss("session"), true);
  assert.equal(isGroupAnnouncementAuthorizationLoss("suspended"), true);
  assert.equal(isGroupAnnouncementAuthorizationLoss("denied"), true);
  assert.equal(isGroupAnnouncementAuthorizationLoss("no-workspace"), true);
  assert.equal(isGroupAnnouncementAuthorizationLoss("server"), false);
  assert.equal(isGroupAnnouncementAuthorizationLoss("unknown"), false);
  assert.equal(isGroupAnnouncementAuthorizationLoss("missing"), false);
  assert.equal(isGroupAnnouncementAuthorizationLoss("invalid"), false);
});

// ---------------------------------------------------------------------------
// Controller harness
// ---------------------------------------------------------------------------

interface FakeApi {
  api: GroupAnnouncementApi;
  calls: { kind: string; args: any[] }[];
  deferreds: Deferred<unknown>[];
  setPrincipal: (value: string | null) => void;
  emitSession: () => void;
  sessionSubscribed: () => boolean;
}

const makeApi = (): FakeApi => {
  const calls: { kind: string; args: any[] }[] = [];
  const deferreds: Deferred<unknown>[] = [];
  let principal: string | null = "user-a";
  let listener: (() => void) | null = null;

  const enqueue = (kind: string, args: any[]): Promise<unknown> => {
    calls.push({ kind, args });
    const d = deferred<unknown>();
    deferreds.push(d);
    return d.promise;
  };

  return {
    calls,
    deferreds,
    api: {
      list: (groupId, options) => enqueue("list", [groupId, options]),
      create: (groupId, write) => enqueue("create", [groupId, write]),
      update: (groupId, announcementId, patch) => enqueue("update", [groupId, announcementId, patch]),
      retract: (groupId, announcementId) => enqueue("retract", [groupId, announcementId]),
      readPrincipal: () => principal,
      subscribeSession: (next) => {
        listener = next;
        return () => { listener = null; };
      },
    },
    setPrincipal: (value) => { principal = value; },
    emitSession: () => { listener?.(); },
    sessionSubscribed: () => listener !== null,
  };
};

const lastDeferred = (fake: FakeApi): Deferred<unknown> => fake.deferreds[fake.deferreds.length - 1];

/** Builds a controller already holding ONE page of two announcements. */
const seeded = async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).resolve({
    announcements: [annDto(), annDto({ id: ANN_2, title: "Exam reminder", state: "published" })],
    next_cursor: null,
  });
  await loading;
  return { fake, controller };
};

// ---------------------------------------------------------------------------
// Selection and the bounded page
// ---------------------------------------------------------------------------

test("controller: selecting a group reads exactly ONE bounded page", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);

  const loading = controller.select(GROUP_ID);
  assert.equal(controller.getState().phase, "loading");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args, [GROUP_ID, { limit: GROUP_ANNOUNCEMENT_PAGE_LIMIT, cursor: null }]);

  lastDeferred(fake).resolve({ announcements: [annDto()], next_cursor: "next" });
  await loading;

  const state = controller.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.groupId, GROUP_ID);
  assert.deepEqual(state.rows, [parsedAnn()]);
  assert.equal(state.nextCursor, "next");
  assert.equal(fake.calls.length, 1, "a first page costs exactly one request");
});

test("controller: re-selecting the same group does not re-read", async () => {
  const { fake, controller } = await seeded();
  await controller.select(GROUP_ID);
  assert.equal(fake.calls.length, 1);
});

test("controller: selecting another group clears the page and drops the previous reply", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);

  const first = controller.select(GROUP_ID);
  const second = controller.select(OTHER_GROUP_ID);
  // The FIRST reply arrives after the selection moved: it must never be shown.
  fake.deferreds[0].resolve({ announcements: [annDto()], next_cursor: null });
  await first;

  assert.deepEqual(controller.getState().rows, [], "the previous group's rows are gone");
  assert.equal(controller.getState().groupId, OTHER_GROUP_ID);

  fake.deferreds[1].resolve({ announcements: [annDto({ id: ANN_2, group_id: OTHER_GROUP_ID })], next_cursor: null });
  await second;

  assert.deepEqual(controller.getState().rows.map((row) => row.id), [ANN_2]);
});

test("controller: selecting null clears everything and reads nothing", async () => {
  const { fake, controller } = await seeded();
  await controller.select(null);

  const state = controller.getState();
  assert.equal(state.groupId, null);
  assert.equal(state.phase, "idle");
  assert.deepEqual(state.rows, []);
  assert.equal(state.nextCursor, null);
  assert.equal(fake.calls.length, 1, "no request is sent without a group");
});

test("controller: a double-clicked refresh sends ONE request", async () => {
  const { fake, controller } = await seeded();

  const first = controller.refresh();
  const second = controller.refresh();
  await second;

  assert.equal(fake.calls.length, 2, "the second refresh is refused synchronously");
  lastDeferred(fake).resolve({ announcements: [annDto()], next_cursor: null });
  await first;
  assert.equal(controller.getState().phase, "ready");
});

test("controller: loadMore only runs when the server minted a cursor", async () => {
  const { fake, controller } = await seeded();

  await controller.loadMore();
  assert.equal(fake.calls.length, 1, "a complete page asks for nothing");

  const withCursor = makeApi();
  const other = createGroupAnnouncementController(withCursor.api);
  const loading = other.select(GROUP_ID);
  lastDeferred(withCursor).resolve({ announcements: [annDto()], next_cursor: "abc" });
  await loading;

  const more = other.loadMore();
  assert.equal(withCursor.calls.length, 2);
  assert.deepEqual(withCursor.calls[1].args, [GROUP_ID, { limit: GROUP_ANNOUNCEMENT_PAGE_LIMIT, cursor: "abc" }]);
  lastDeferred(withCursor).resolve({
    announcements: [annDto({ id: ANN_2, title: "Second page" })],
    next_cursor: null,
  });
  await more;

  const state = other.getState();
  assert.deepEqual(state.rows.map((row) => row.id), [ANN_1, ANN_2], "the next page appends");
  assert.equal(state.nextCursor, null);
  assert.equal(state.loadingMore, false);
});

test("controller: a failed next page keeps the page already held", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).resolve({ announcements: [annDto()], next_cursor: "abc" });
  await loading;

  const more = controller.loadMore();
  lastDeferred(fake).reject(new Error("Failed to list announcements"));
  await more;

  const state = controller.getState();
  assert.deepEqual(state.rows.map((row) => row.id), [ANN_1], "the held page survives");
  assert.equal(state.nextCursor, "abc", "the cursor is kept so the read can be retried");
  assert.equal(state.loadingMore, false);
  assert.equal(state.error, "Failed to list announcements");
});

test("controller: a malformed page is a failed read, never a partial one", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).resolve({ announcements: [annDto(), { id: ANN_2 }], next_cursor: null });
  await loading;

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.deepEqual(state.rows, []);
  assert.equal(state.error, GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE);
});

test("controller: an empty page is its own phase", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).resolve({ announcements: [], next_cursor: null });
  await loading;

  assert.equal(controller.getState().phase, "empty");
  assert.deepEqual(controller.getState().rows, []);
});

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

test("controller: create sends the canonical body and closes the form on success", async () => {
  const { fake, controller } = await seeded();

  controller.openCreate();
  assert.equal(controller.getState().form.mode, "create");
  controller.setField({ title: "  Padded  ", body: "  keep me  ", state: "published" });

  const saving = controller.save();
  assert.deepEqual(fake.calls[1], {
    kind: "create",
    args: [GROUP_ID, { title: "Padded", body: "  keep me  ", state: "published" }],
  });
  lastDeferred(fake).resolve(annDto({ id: ANN_OTHER, title: "Padded", body: "  keep me  ", state: "published" }));
  assert.equal(await saving, "confirmed");

  const state = controller.getState();
  assert.equal(state.form.mode, "closed");
  assert.deepEqual(state.rows.map((row) => row.id), [ANN_1, ANN_2, ANN_OTHER]);
  assert.equal(state.lastConfirmed?.id, ANN_OTHER);
});

test("controller: local validation keeps the input and sends nothing", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();

  controller.setField({ title: "   ", body: "text" });
  assert.equal(await controller.save(), "invalid");
  assert.equal(controller.getState().form.error, ANNOUNCEMENT_TITLE_INVALID_MESSAGE);

  controller.setField({ title: "Title", body: "   " });
  assert.equal(await controller.save(), "invalid");
  assert.equal(controller.getState().form.error, ANNOUNCEMENT_BODY_INVALID_MESSAGE);

  controller.setField({ title: "Title", body: "x".repeat(4001) });
  assert.equal(await controller.save(), "invalid");

  assert.equal(fake.calls.length, 1, "no request is ever sent for an invalid form");
  assert.equal(controller.getState().form.mode, "create", "the form stays open with its input");
  assert.equal(controller.getState().form.title, "Title");
});

test("controller: a double-clicked save sends ONE write", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();
  controller.setField({ title: "Title", body: "Text." });

  const first = controller.save();
  assert.equal(await controller.save(), "blocked");
  assert.equal(fake.calls.length, 2, "the second save never reaches the wire");

  lastDeferred(fake).resolve(annDto({ id: ANN_OTHER, title: "Title", body: "Text." }));
  assert.equal(await first, "confirmed");
});

test("controller: an edit form sends both fields so an omission can never keep a stale value", async () => {
  const { fake, controller } = await seeded();
  controller.openEdit(ANN_1);
  assert.equal(controller.getState().form.mode, "edit");
  assert.equal(controller.getState().form.title, "First session");

  controller.setField({ body: "Updated text." });
  const saving = controller.save();
  assert.deepEqual(fake.calls[1], {
    kind: "update",
    args: [GROUP_ID, ANN_1, { title: "First session", body: "Updated text.", state: "draft" }],
  });
  lastDeferred(fake).resolve(annDto({ body: "Updated text." }));
  assert.equal(await saving, "confirmed");
  assert.equal(controller.getState().form.mode, "closed");
  assert.equal(controller.getState().rows[0].body, "Updated text.");
});

test("controller: an unchanged edit sends NOTHING and claims nothing", async () => {
  const { fake, controller } = await seeded();
  controller.openEdit(ANN_1);

  assert.equal(await controller.save(), "unchanged");
  assert.equal(fake.calls.length, 1, "no request is sent for a truthful no-op");
  assert.equal(controller.getState().form.mode, "closed");
});

test("controller: a retracted announcement is never opened for edit", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).resolve({
    announcements: [annDto({ state: "retracted", retracted_at: "2026-10-23 11:00:00" })],
    next_cursor: null,
  });
  await loading;

  controller.openEdit(ANN_1);
  assert.equal(controller.getState().form.mode, "closed", "retraction is terminal");
});

test("controller: a write reply for ANOTHER announcement is not a success", async () => {
  const { fake, controller } = await seeded();
  controller.openEdit(ANN_1);
  controller.setField({ title: "Renamed" });

  const saving = controller.save();
  lastDeferred(fake).resolve(annDto({ id: ANN_OTHER, title: "Renamed" }));
  assert.equal(await saving, "uncertain");

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.notice, ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.form.mode, "edit", "the draft is preserved");
  assert.equal(state.rows[0].title, "First session", "no foreign row is applied");
});

test("controller: a write reply for ANOTHER group is not a success", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();
  controller.setField({ title: "Title", body: "Text." });

  const saving = controller.save();
  lastDeferred(fake).resolve(annDto({ id: ANN_OTHER, group_id: OTHER_GROUP_ID }));
  assert.equal(await saving, "uncertain");
  assert.equal(controller.getState().rows.length, 2, "nothing is inserted");
});

// ---------------------------------------------------------------------------
// Publish / retract
// ---------------------------------------------------------------------------

test("controller: publish sends the single state change and confirms", async () => {
  const { fake, controller } = await seeded();

  const publishing = controller.publish(ANN_1);
  assert.deepEqual(fake.calls[1], { kind: "update", args: [GROUP_ID, ANN_1, { state: "published" }] });
  lastDeferred(fake).resolve(annDto({ state: "published" }));
  assert.equal(await publishing, "confirmed");
  assert.equal(controller.getState().rows[0].state, "published");
  assert.equal(controller.getState().mutation.notice, "تم نشر الإعلان.");
});

test("controller: publishing an already-published announcement sends nothing", async () => {
  const { fake, controller } = await seeded();
  assert.equal(await controller.publish(ANN_2), "unchanged");
  assert.equal(fake.calls.length, 1);
});

test("controller: retract sends the explicit action and confirms", async () => {
  const { fake, controller } = await seeded();

  const retracting = controller.retract(ANN_1);
  assert.deepEqual(fake.calls[1], { kind: "retract", args: [GROUP_ID, ANN_1] });
  lastDeferred(fake).resolve(annDto({ state: "retracted", retracted_at: "2026-10-23 11:00:00" }));
  assert.equal(await retracting, "confirmed");

  const row = controller.getState().rows[0];
  assert.equal(row.state, "retracted");
  assert.equal(row.retracted_at, "2026-10-23 11:00:00");
  assert.equal(controller.getState().mutation.notice, ANNOUNCEMENT_RETRACTED_MESSAGE);
});

test("controller: retracting an already-retracted announcement sends nothing", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).resolve({
    announcements: [annDto({ state: "retracted", retracted_at: "2026-10-23 11:00:00" })],
    next_cursor: null,
  });
  await loading;

  assert.equal(await controller.retract(ANN_1), "unchanged");
  assert.equal(fake.calls.length, 1, "the original retraction stamp is never re-written");
});

test("controller: a publish racing a retract never sends two writes", async () => {
  const { fake, controller } = await seeded();

  const publishing = controller.publish(ANN_1);
  assert.equal(await controller.retract(ANN_1), "blocked");
  assert.equal(fake.calls.length, 2);

  lastDeferred(fake).resolve(annDto({ state: "published" }));
  assert.equal(await publishing, "confirmed");
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("controller: a denied write clears the held rows, the form and the draft", async () => {
  const { fake, controller } = await seeded();
  controller.openEdit(ANN_1);
  controller.setField({ title: "Renamed" });

  const saving = controller.save();
  lastDeferred(fake).reject(new Error("Teaching access is not active for the selected tenant"));
  assert.equal(await saving, "rejected");

  const state = controller.getState();
  assert.equal(state.phase, "denied");
  assert.deepEqual(state.rows, []);
  assert.equal(state.groupId, null);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.reason, "denied");
});

test("controller: an expired session clears everything and reports unauthorized", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();
  controller.setField({ title: "Title", body: "Text." });

  const saving = controller.save();
  lastDeferred(fake).reject(new Error("Token expired"));
  assert.equal(await saving, "rejected");

  const state = controller.getState();
  assert.equal(state.phase, "unauthorized");
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
});

test("controller: a 404 announcement drops exactly that row and closes its form", async () => {
  const { fake, controller } = await seeded();
  controller.openEdit(ANN_1);
  controller.setField({ title: "Renamed" });

  const saving = controller.save();
  lastDeferred(fake).reject(new Error("Announcement not found"));
  assert.equal(await saving, "rejected");

  const state = controller.getState();
  assert.deepEqual(state.rows.map((row) => row.id), [ANN_2], "only the vanished row goes");
  assert.equal(state.form.mode, "closed");
  assert.equal(state.mutation.error, "Announcement not found");
  assert.equal(state.phase, "ready", "the page itself is still usable");
});

test("controller: a 404 group clears the whole panel", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();
  controller.setField({ title: "Title", body: "Text." });

  const saving = controller.save();
  lastDeferred(fake).reject(new Error("Group not found"));
  assert.equal(await saving, "rejected");

  const state = controller.getState();
  assert.equal(state.groupId, null);
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
});

test("controller: an uncertain 500 keeps the draft and never retries", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();
  controller.setField({ title: "Title", body: "Text." });

  const saving = controller.save();
  lastDeferred(fake).reject(new Error("Failed to save announcement"));
  assert.equal(await saving, "uncertain");

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.notice, ANNOUNCEMENT_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.form.mode, "create", "the draft survives an uncertain write");
  assert.equal(state.form.title, "Title");
  assert.equal(fake.calls.length, 2, "nothing is retried automatically");
});

test("controller: a 409 conflict keeps the draft and writes nothing", async () => {
  const { fake, controller } = await seeded();
  controller.openEdit(ANN_1);
  controller.setField({ title: "Renamed" });

  const saving = controller.save();
  lastDeferred(fake).reject(new Error("Announcement is retracted"));
  assert.equal(await saving, "rejected");

  const state = controller.getState();
  assert.equal(state.form.mode, "edit", "the draft is preserved so it can be corrected");
  assert.equal(state.mutation.error, "Announcement is retracted");
  assert.equal(state.rows[0].title, "First session");
});

test("controller: a denied READ clears the private state", async () => {
  const { fake, controller } = await seeded();

  const refreshing = controller.refresh();
  lastDeferred(fake).reject(new Error("Forbidden"));
  await refreshing;

  const state = controller.getState();
  assert.equal(state.phase, "denied");
  assert.deepEqual(state.rows, []);
  assert.equal(state.groupId, null);
});

test("controller: a retryable read failure keeps the selection and reports the error", async () => {
  const fake = makeApi();
  const controller = createGroupAnnouncementController(fake.api);
  const loading = controller.select(GROUP_ID);
  lastDeferred(fake).reject(new Error("Failed to list announcements"));
  await loading;

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.groupId, GROUP_ID, "the selection survives a retryable failure");
  assert.equal(state.error, "Failed to list announcements");
});

// ---------------------------------------------------------------------------
// Principal, session and dispose fences
// ---------------------------------------------------------------------------

test("controller: a principal change at completion discards the reply", async () => {
  const { fake, controller } = await seeded();

  const refreshing = controller.refresh();
  fake.setPrincipal("user-b");
  lastDeferred(fake).resolve({ announcements: [annDto({ id: ANN_OTHER })], next_cursor: null });
  await refreshing;

  const state = controller.getState();
  assert.deepEqual(state.rows, [], "another principal's page is never shown");
  assert.equal(state.groupId, null);
});

test("controller: a principal change at ENTRY clears the state before any request", async () => {
  const { fake, controller } = await seeded();

  fake.setPrincipal("user-b");
  const refreshing = controller.refresh();

  assert.equal(fake.calls.length, 1, "no request is sent for the new principal yet");
  assert.deepEqual(controller.getState().rows, []);
  assert.equal(controller.getState().groupId, null);
  await refreshing;
});

test("controller: a session event clears the private state and drops in-flight replies", async () => {
  const { fake, controller } = await seeded();
  assert.equal(fake.sessionSubscribed(), true);

  const refreshing = controller.refresh();
  fake.emitSession();
  lastDeferred(fake).resolve({ announcements: [annDto()], next_cursor: null });
  await refreshing;

  const state = controller.getState();
  assert.deepEqual(state.rows, [], "a retired reply never repopulates the cleared state");
  assert.equal(state.groupId, null);
  assert.equal(state.form.mode, "closed");
});

test("controller: nothing commits after dispose", async () => {
  const { fake, controller } = await seeded();
  const before = fake.calls.length;

  const refreshing = controller.refresh();
  controller.dispose();
  lastDeferred(fake).resolve({ announcements: [annDto()], next_cursor: null });
  await refreshing;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.deepEqual(state.rows, []);
  assert.equal(state.groupId, null);

  // Every entry point is inert after dispose.
  assert.equal(await controller.save(), "idle");
  assert.equal(await controller.publish(ANN_1), "idle");
  assert.equal(await controller.retract(ANN_1), "idle");
  await controller.loadMore();
  await controller.refresh();
  assert.equal(fake.calls.length, before + 1, "a disposed controller sends nothing more");
});

test("controller: the write latch is shared by save, publish and retract", async () => {
  const { fake, controller } = await seeded();
  controller.openCreate();
  controller.setField({ title: "Title", body: "Text." });

  const publishing = controller.publish(ANN_1);
  assert.equal(await controller.save(), "blocked", "a save racing a publish never reaches the wire");
  assert.equal(await controller.retract(ANN_2), "blocked");
  assert.equal(fake.calls.length, 2, "only the first write reached the wire");

  lastDeferred(fake).resolve(annDto({ state: "published" }));
  assert.equal(await publishing, "confirmed");
});
