/**
 * M2-05 selected institution identity — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/tenant/profile.ts` that
 * src/pages/InstructorDashboard.tsx delegates to, plus the REAL additive
 * transport `getMyTenantProfile` in src/lib/api-http.ts — both imported
 * unchanged. Fully isolated: no DB, no network, no browser, no live services,
 * no dependency install. The transport seam drives the REAL `request` with a
 * stubbed global fetch/localStorage; the feature seam drives the REAL
 * controller with an injected fake transport, principal reader and session
 * notifier.
 *
 * Behaviours pinned (M2-05 acceptance):
 *  - canonical authenticated request: exact `/tenants/me/profile` path, bearer
 *    header, and NO client tenant selector in header/query/body;
 *  - a missing token fails closed (no Authorization header; the server's
 *    documented 401 answer is the only possible outcome);
 *  - the documented transport error behavior: the server `error` message is
 *    thrown WITHOUT the HTTP status, so only documented messages classify an
 *    outcome; a network failure surfaces as a retryable read error;
 *  - runtime DTO validation: exact valid envelope (including null
 *    subject_type) is accepted; a non-object body, a missing tenant, wrong
 *    field types or an unexpected extra key are a malformed-response error —
 *    never a fabricated institution;
 *  - distinct loading / error+retry / unauthorized / denied /
 *    no-authorized-workspace states, and every failure CLEARS the identity;
 *  - retry is exactly one more read;
 *  - reversed/superseded replies never commit; a reply commits only in its own
 *    generation and canonical principal;
 *  - session change retires in-flight work and clears the private identity
 *    BEFORE the new load starts; A → B → A never mixes identities, and the
 *    accepted M2-02 canonical reader is the seam actually used;
 *  - dispose drops in-flight replies and clears the private identity;
 *  - an old `finally` never releases a newer load's latch.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getMyTenantProfile,
  type TenantProfile,
  type TenantProfileEnvelope,
} from "../lib/api-http";
import {
  classifyTenantProfileFailure,
  createTenantProfileController,
  parseTenantProfileEnvelope,
  MALFORMED_PROFILE_MESSAGE,
  type TenantProfileApi,
} from "../features/tenant/profile";
import {
  readCourseSessionPrincipal,
  resetCourseSessionLifetime,
  type CourseSessionStorage,
} from "../features/catalog/course-management";
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

const validEnvelope = (overrides: Partial<TenantProfile> = {}): TenantProfileEnvelope => ({
  tenant: {
    id: "tenant-1",
    business_name: "أكاديمية النجاح",
    subject_type: "company",
    status: "active",
    ...overrides,
  },
});

const storageOf = (entries: Record<string, string | null>): CourseSessionStorage => ({
  getItem: (key) => (key in entries ? entries[key] : null),
});

/** One rejected call per load attempt, resolved by the test. */
interface DeferredApi {
  api: TenantProfileApi;
  calls: Deferred<TenantProfileEnvelope>[];
}

const createDeferredApi = (): DeferredApi => {
  const calls: Deferred<TenantProfileEnvelope>[] = [];
  return {
    calls,
    api: {
      loadProfile: () => {
        const d = deferred<TenantProfileEnvelope>();
        calls.push(d);
        return d.promise;
      },
    },
  };
};

/** Session notifier the test fires by hand. */
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

const profileControllerApi = (
  deferredApi: DeferredApi,
  getPrincipal: () => string | null,
  sink: ReturnType<typeof createSessionSink>
): TenantProfileApi => ({
  ...deferredApi.api,
  readPrincipal: getPrincipal,
  subscribeSession: sink.subscribeSession,
});

// ===========================================================================
// Transport seam — the REAL getMyTenantProfile through the REAL request
// ===========================================================================

interface TransportEnv {
  calls: { url: string; init: RequestInit }[];
  assignedUrls: string[];
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
    restore: () => {
      (globalThis as unknown as { localStorage: unknown }).localStorage = realLocalStorage ?? undefined;
      (globalThis as unknown as { window: unknown }).window = realWindow;
      globalThis.fetch = realFetch;
    },
  };
};

const stubFetch = (env: TransportEnv, response: () => { ok: boolean; status: number; body: unknown }): void => {
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

test("transport: canonical authenticated GET of the exact profile path", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: validEnvelope() }));

  const body = await getMyTenantProfile();

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, "/api/tenants/me/profile");
  assert.equal(env.calls[0].init.method, undefined, "a read: no explicit method override");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    Object.keys(headers).filter((key) => /tenant|scope|workspace|x-/i.test(key)),
    [],
    "no client tenant selector header"
  );
  assert.equal(env.calls[0].url.includes("?"), false, "no query selector");
  assert.deepEqual(body, { tenant: { id: "tenant-1", business_name: "أكاديمية النجاح", subject_type: "company", status: "active" } });
});

test("transport: missing token fails closed — no Authorization header is sent", async (t) => {
  const env = installTransportEnvironment(null);
  t.after(env.restore);
  stubFetch(env, () => ({ ok: false, status: 401, body: { error: "Invalid token" } }));

  await assert.rejects(() => getMyTenantProfile(), /Invalid token/);

  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined, "no bearer without a token");
});

test("transport: the 404 no-authorized-workspace answer arrives as its message only", async (t) => {
  const env = installTransportEnvironment("token-404");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: false, status: 404, body: { error: "Tenant membership not found" } }));

  await assert.rejects(() => getMyTenantProfile(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal((cause as Error).message, "Tenant membership not found");
    assert.equal((cause as Error & { status?: number }).status, undefined, "the transport discards the numeric status");
    return true;
  });
});

test("transport: the handler 500 wording arrives as its message only", async (t) => {
  const env = installTransportEnvironment("token-500");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: false, status: 500, body: { error: "Failed to load tenant profile" } }));

  await assert.rejects(() => getMyTenantProfile(), /Failed to load tenant profile/);
});

test("transport: the 401 session answers arrive as their documented messages", async (t) => {
  for (const message of [
    "Invalid token",
    "No token provided",
    "Token expired",
    "Session revoked",
    "Selected workspace is no longer active",
  ]) {
    const env = installTransportEnvironment("token-401");
    t.after(env.restore);
    stubFetch(env, () => ({ ok: false, status: 401, body: { error: message, code: "TOKEN_EXPIRED" } }));

    await assert.rejects(() => getMyTenantProfile(), (cause: unknown) => {
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).message, message);
      assert.equal((cause as Error & { code?: string }).code, undefined, "the code field is discarded");
      return true;
    });
  }
});

test("transport: the 409 student-space answer arrives as its documented message", async (t) => {
  const env = installTransportEnvironment("token-409");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 409,
    body: { error: "Select an instructor workspace first", code: "STUDENT_SPACE_REQUIRED" },
  }));

  await assert.rejects(() => getMyTenantProfile(), /Select an instructor workspace first/);
});

test("transport: a network failure is a retryable read error, not a fabricated profile", async (t) => {
  const env = installTransportEnvironment("token-net");
  t.after(env.restore);
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  await assert.rejects(() => getMyTenantProfile(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal((cause as Error).message, "fetch failed");
    return true;
  });
});

// ===========================================================================
// Integrated: the REAL transport answer drives the REAL controller
// ===========================================================================

test("integrated: the transported 401 message (not its discarded code) drives unauthorized", async (t) => {
  const env = installTransportEnvironment("token-expired");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 401,
    body: { error: "Token expired", code: "TOKEN_EXPIRED" },
  }));
  const controller = createTenantProfileController({ loadProfile: () => getMyTenantProfile() });
  t.after(() => controller.dispose());

  await controller.load();
  await controller.waitForIdle();

  assert.equal(env.calls.length, 1, "exactly one transport request");
  assert.equal(controller.getState().phase, "unauthorized");
  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().error, "Token expired");
});

test("integrated: a real 403 suspension message drives denied and tears the session down", async (t) => {
  const env = installTransportEnvironment("token-suspended");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: {
      error: "Instructor account is administratively suspended",
      code: "TENANT_SUSPENDED",
    },
  }));
  const events: string[] = [];
  const unsubscribe = subscribeSessionChange((event) => events.push(event.kind));
  t.after(unsubscribe);
  const controller = createTenantProfileController({ loadProfile: () => getMyTenantProfile() });
  t.after(() => controller.dispose());

  await controller.load();
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "denied");
  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().error, "Instructor account is administratively suspended");
  assert.equal(env.calls.length, 1, "no uncontrolled follow-up request without notifier wiring");
  assert.equal((globalThis.localStorage as Storage).getItem("authToken"), null, "the session token is cleared");
  assert.deepEqual(events, ["logout"], "the canonical teardown notifier fired exactly once");
  assert.deepEqual(env.assignedUrls, ["/auth"], "the suspended session is sent to auth");
});

test("integrated: 403 teardown + logout leaves no stale identity and no uncontrolled reads", async (t) => {
  const env = installTransportEnvironment("token-page");
  t.after(env.restore);
  let mode: "ok" | "suspended" = "ok";
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    env.calls.push({ url: String(_url), init });
    const headers = init.headers as Record<string, string>;
    if (mode === "ok") {
      return { ok: true, status: 200, json: async () => validEnvelope() } as unknown as Response;
    }
    if (headers.Authorization) {
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: "Instructor account is administratively suspended",
          code: "TENANT_SUSPENDED",
        }),
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: "No token provided", code: "TOKEN_EXPIRED" }),
    } as unknown as Response;
  }) as typeof fetch;

  const events: string[] = [];
  const unsubscribeEvents = subscribeSessionChange((event) => events.push(event.kind));
  t.after(unsubscribeEvents);
  const controller = createTenantProfileController({
    loadProfile: () => getMyTenantProfile(),
    readPrincipal: () => (globalThis.localStorage as Storage).getItem("authToken"),
    subscribeSession: (listener) => subscribeSessionChange(() => listener()),
  });
  t.after(() => controller.dispose());

  await controller.load();
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(env.calls.length, 1);

  mode = "suspended";
  await controller.refresh();
  await controller.waitForIdle();

  assert.equal(controller.getState().profile, null, "no A identity survives the suspended session");
  assert.equal(controller.getState().phase, "unauthorized", "the honest no-token read fails closed");
  assert.equal(controller.getState().error, "No token provided");
  assert.equal(env.calls.length, 3, "1 initial + 1 suspended + 1 bounded no-token read; no loop");
  assert.equal((globalThis.localStorage as Storage).getItem("authToken"), null);
  assert.deepEqual(events, ["logout"]);
});

// ===========================================================================
// DTO validation — runtime check of the real envelope
// ===========================================================================

test("dto: the exact server envelope is accepted with its four fields verbatim", () => {
  const parsed = parseTenantProfileEnvelope(validEnvelope());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.profile, {
    id: "tenant-1",
    business_name: "أكاديمية النجاح",
    subject_type: "company",
    status: "active",
  });
});

test("dto: a null subject_type is accepted verbatim", () => {
  const parsed = parseTenantProfileEnvelope(validEnvelope({ subject_type: null }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.profile.subject_type, null);
});

test("dto: malformed bodies are refused — never a fabricated institution", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    "tenant",
    42,
    [],
    {},
    { tenant: null },
    { tenant: "tenant-1" },
    { tenant: [] },
    { tenant: { ...validEnvelope().tenant, id: "" } },
    { tenant: { ...validEnvelope().tenant, id: 7 } },
    { tenant: { ...validEnvelope().tenant, business_name: "" } },
    { tenant: { ...validEnvelope().tenant, business_name: null } },
    { tenant: { ...validEnvelope().tenant, status: "" } },
    { tenant: { ...validEnvelope().tenant, status: 5 } },
    { tenant: { ...validEnvelope().tenant, subject_type: 7 } },
    { tenant: { ...validEnvelope().tenant, subject_type: undefined } },
    // A row spread: the accepted projection is exactly four fields.
    { tenant: { ...validEnvelope().tenant, owner_user_id: "user-1" } },
    { tenant: { ...validEnvelope().tenant, legacy_compat: true } },
  ];
  for (const body of malformed) {
    const parsed = parseTenantProfileEnvelope(body);
    assert.equal(parsed.ok, false, `must refuse: ${JSON.stringify(body)}`);
  }
});

// ===========================================================================
// Failure classification — documented messages only
// ===========================================================================

test("classification: the documented session answers are unauthorized", () => {
  for (const message of [
    "Invalid token",
    "No token provided",
    "Token expired",
    "Session revoked",
    "Selected workspace is no longer active",
  ]) {
    assert.deepEqual(classifyTenantProfileFailure(new Error(message)), { phase: "unauthorized", message });
  }
});

test("classification: a discarded code alone is never guessed into a permission outcome", () => {
  for (const message of ["TOKEN_EXPIRED", "SESSION_REVOKED"]) {
    assert.deepEqual(classifyTenantProfileFailure(new Error(message)), { phase: "error", message });
  }
});

test("classification: the actual suspension message is denied", () => {
  const message = "Instructor account is administratively suspended";
  assert.deepEqual(classifyTenantProfileFailure(new Error(message)), { phase: "denied", message });
});

test("classification: a discarded suspension code alone fails closed as a read error", () => {
  assert.deepEqual(classifyTenantProfileFailure(new Error("TENANT_SUSPENDED")), {
    phase: "error",
    message: "TENANT_SUSPENDED",
  });
});

test("classification: membership-not-found and student-space are no-authorized-workspace", () => {
  for (const message of ["Tenant membership not found", "Select an instructor workspace first"]) {
    assert.deepEqual(classifyTenantProfileFailure(new Error(message)), { phase: "no-workspace", message });
  }
});

test("classification: a discarded student-space code alone fails closed as a read error", () => {
  assert.deepEqual(classifyTenantProfileFailure(new Error("STUDENT_SPACE_REQUIRED")), {
    phase: "error",
    message: "STUDENT_SPACE_REQUIRED",
  });
});

test("classification: the handler 500 wording is a retryable read error", () => {
  assert.deepEqual(classifyTenantProfileFailure(new Error("Failed to load tenant profile")), {
    phase: "error",
    message: "Failed to load tenant profile",
  });
});

test("classification: an unknown or non-Error failure stays a retryable read error with its actual message", () => {
  assert.deepEqual(classifyTenantProfileFailure(new Error("fetch failed")), { phase: "error", message: "fetch failed" });
  const unknown = classifyTenantProfileFailure("plain string cause");
  assert.equal(unknown.phase, "error");
  assert.equal(unknown.message, "plain string cause");
  const empty = classifyTenantProfileFailure(new Error(""));
  assert.equal(empty.phase, "error");
  assert.ok(empty.message.length > 0, "an empty message never leaves an empty screen");
});

// ===========================================================================
// Feature seam — the REAL controller with injected transport/session/principal
// ===========================================================================

test("feature: a server-confirmed profile commits exactly once, with its fields", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => "session:a", sink)
  );
  t.after(() => controller.dispose());

  const seen: string[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state.phase));
  const loaded = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 1, "one request");
  assert.equal(controller.getState().phase, "loading");
  assert.equal(controller.getState().profile, null, "no identity before the server confirms");

  deferredApi.calls[0].resolve(validEnvelope());
  await loaded;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.deepEqual(controller.getState().profile, {
    id: "tenant-1",
    business_name: "أكاديمية النجاح",
    subject_type: "company",
    status: "active",
  });
  assert.equal(controller.getState().error, null);
  assert.deepEqual(seen, ["idle", "loading", "ready"]);
  unsubscribe();
});

test("feature: a malformed body is an error state, never a fabricated identity", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => "session:a", sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve({ tenant: { id: "tenant-1" } } as unknown as TenantProfileEnvelope);
  await loaded;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().error, MALFORMED_PROFILE_MESSAGE);
});

test("feature: a failed read clears a previously confirmed identity", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => "session:a", sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope());
  await loaded;
  assert.equal(controller.getState().phase, "ready");

  const retried = controller.refresh();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "the retry is exactly one more read");
  deferredApi.calls[1].reject(new Error("Failed to load tenant profile"));
  await retried;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().profile, null, "failure clears the private identity");
  assert.equal(controller.getState().error, "Failed to load tenant profile");
});

test("feature: a retry after a failed read re-reads and can confirm a profile", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => "session:a", sink)
  );
  t.after(() => controller.dispose());

  const first = controller.load();
  await flush();
  deferredApi.calls[0].reject(new Error("Failed to load tenant profile"));
  await first;
  assert.equal(controller.getState().phase, "error");

  const retried = controller.refresh();
  await flush();
  assert.equal(deferredApi.calls.length, 2);
  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await retried;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
  assert.equal(controller.getState().error, null);
});

test("feature: a second load while one is on the wire never reaches the transport", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => "session:a", sink)
  );
  t.after(() => controller.dispose());

  const first = controller.load();
  const dropped = controller.refresh();
  await flush();
  assert.equal(deferredApi.calls.length, 1, "the synchronous latch rejects the duplicate before any request");

  deferredApi.calls[0].resolve(validEnvelope());
  await Promise.all([first, dropped]);
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(deferredApi.calls.length, 1);
});

test("feature: a reversed/superseded reply never commits", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const first = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 1);

  // A second EXPLICIT load while one is on the wire is latched away (pinned by
  // the duplicate-suppression test above), so the superseded pair is produced
  // the way production produces it: a session event retires the in-flight
  // read and starts the next one.
  principal = "session:b";
  sink.fire();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "the session event started the superseding read");

  // Reversed completion: the NEWER reply commits first. (`waitForIdle` cannot
  // be used here — it drains every in-flight read, and the older one is
  // deliberately still unsettled; the commit path after a resolve is pure
  // microtasks, so one macrotask flush observes it.)
  deferredApi.calls[1].resolve(validEnvelope({ business_name: "الأحدث" }));
  await flush();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "الأحدث");

  // ...then the older reply arrives late and must not overwrite it.
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "الأقدم" }));
  await first;
  await flush();
  assert.equal(controller.getState().profile?.business_name, "الأحدث", "the older reply is dropped, not merged");
});

test("feature: session change clears the private identity BEFORE the new load starts", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "مساحة أ" }));
  await loaded;
  assert.equal(controller.getState().profile?.business_name, "مساحة أ");

  // The subscriber observes every committed state, so the ordering of the
  // clear versus the new load is observable even though the whole reaction
  // (retire -> clear -> start) runs in one synchronous turn. The first
  // emission is the subscribe-time snapshot ('ready'); what must follow is
  // the clear BEFORE the new load's loading state.
  const seen: string[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state.phase));

  // Another principal takes over (login/scope switch) while nothing is in
  // flight: the identity is cleared synchronously, then a new read starts.
  principal = "session:b";
  sink.fire();
  assert.equal(controller.getState().profile, null, "identity cleared before the new load");
  assert.deepEqual(
    seen.filter((phase, index) => index > 0),
    ["idle", "loading"],
    "the clear is committed before the new load starts"
  );
  await flush();
  assert.equal(deferredApi.calls.length, 2, "a fresh read for the new session");

  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
  unsubscribe();
});

test("feature: A → B → A never mixes identities, and an old reply never commits into a newer session", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  // Session A's read is held open, then the principal switches to B.
  const readA = controller.load();
  await flush();
  principal = "session:b";
  sink.fire();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "B's read starts only after A is retired");

  // A's late reply must not commit into B.
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "مساحة أ" }));
  await readA.catch(() => {});
  await flush();
  assert.equal(controller.getState().profile, null, "A's reply cannot commit while B is the principal");

  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");

  // Back to A: a NEW incarnation (no remembered old identity).
  principal = "session:a";
  sink.fire();
  await flush();
  assert.equal(deferredApi.calls.length, 3);
  deferredApi.calls[2].resolve(validEnvelope({ business_name: "مساحة أ الثانية" }));
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة أ الثانية");
});

test("feature: a silent principal change at completion clears identity/loading and retry is usable", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "مساحة أ" }));
  await loaded;
  assert.equal(controller.getState().profile?.business_name, "مساحة أ");

  // No session event: the principal is only observed when the next read
  // completes. The old confirmed identity and the loading phase must not
  // survive the observation.
  const refreshed = controller.refresh();
  await flush();
  assert.equal(deferredApi.calls.length, 2);
  principal = "session:b";
  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await refreshed;
  await flush();

  assert.equal(controller.getState().profile, null, "the old private identity is retired");
  assert.equal(controller.getState().phase, "idle", "the retired reply does not leave perpetual loading");
  assert.deepEqual(deferredApi.calls.length, 2, "the foreign reply itself starts no extra read");

  // A usable retry then reads the now-current principal and commits its own
  // server-confirmed identity.
  const retried = controller.refresh();
  await flush();
  assert.equal(deferredApi.calls.length, 3);
  deferredApi.calls[2].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await retried;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
});

test("feature: a silent principal change at entry clears the old identity BEFORE the new load", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "مساحة أ" }));
  await loaded;
  assert.equal(controller.getState().profile?.business_name, "مساحة أ");

  principal = "session:b";
  const next = controller.load();
  // The entry observation is synchronous: A's identity is already gone and
  // the new read owns the latch.
  assert.equal(controller.getState().profile, null, "identity cleared before the new read starts");
  assert.equal(controller.getState().phase, "loading");
  await flush();
  assert.equal(deferredApi.calls.length, 2);

  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await next;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
});

test("feature: a silent error for a replaced principal clears state instead of showing the old error", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "مساحة أ" }));
  await loaded;

  const refreshed = controller.refresh();
  await flush();
  principal = "session:b";
  deferredApi.calls[1].reject(new Error("Failed to load tenant profile"));
  await refreshed;
  await flush();

  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().error, null, "the old principal's failure is not displayed");

  const retried = controller.refresh();
  await flush();
  deferredApi.calls[2].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await retried;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
});

test("feature: silent A → B → A shows each principal's own confirmed identity", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const readA = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope({ business_name: "مساحة أ" }));
  await readA;
  assert.equal(controller.getState().profile?.business_name, "مساحة أ");

  principal = "session:b";
  const readB = controller.refresh();
  await flush();
  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await readB;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");

  principal = "session:a";
  const readAgain = controller.refresh();
  await flush();
  deferredApi.calls[2].resolve(validEnvelope({ business_name: "مساحة أ الثانية" }));
  await readAgain;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "مساحة أ الثانية");
  assert.equal(deferredApi.calls.length, 3, "one bounded read per observed principal change");
});

test("feature: an old finally after a silent change never releases a newer load's latch", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const readA = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 1);

  // Silent change, then an explicit load adopts it and starts B. A is now
  // retired but still unsettled.
  principal = "session:b";
  const readB = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 2);
  const dropped = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "B owns the latch");

  // A's late failure must neither commit nor free B's latch.
  deferredApi.calls[0].reject(new Error("Session revoked"));
  await readA.catch(() => {});
  await flush();
  const stillDropped = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "A's finally left B's latch intact");
  assert.equal(controller.getState().phase, "loading");
  assert.equal(controller.getState().profile, null);

  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await Promise.all([readB, dropped, stillDropped]);
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
});

test("feature: logout (no principal) clears the identity and the next read fails closed", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const loaded = controller.load();
  await flush();
  deferredApi.calls[0].resolve(validEnvelope());
  await loaded;
  assert.equal(controller.getState().phase, "ready");

  principal = null;
  sink.fire();
  assert.equal(controller.getState().profile, null, "private identity cleared on logout");
  await flush();
  assert.equal(deferredApi.calls.length, 2, "the honest read is still attempted");

  deferredApi.calls[1].reject(new Error("Session revoked"));
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "unauthorized");
  assert.equal(controller.getState().profile, null);
});

test("feature: an old finally never releases a newer load's latch", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => principal, sink)
  );
  t.after(() => controller.dispose());

  const readA = controller.load();
  await flush();
  // Session change retires A and releases the latch.
  principal = "session:b";
  sink.fire();
  const readB = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 2);

  // A completes: its `finally` releases with A's own ticket only.
  deferredApi.calls[0].reject(new Error("Failed to load tenant profile"));
  await readA.catch(() => {});
  await flush();

  // B is still the owner: a third load must still be rejected by the latch.
  const readC = controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "the retired A's finally did not free B's latch");

  deferredApi.calls[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await readB;
  await readC;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
});

test("feature: dispose drops in-flight replies and clears the private identity", async (t) => {
  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, () => "session:a", sink)
  );

  const loaded = controller.load();
  await flush();
  controller.dispose();
  assert.equal(controller.getState().profile, null, "disposal clears the private identity");

  deferredApi.calls[0].resolve(validEnvelope());
  await loaded;
  await flush();

  assert.equal(controller.getState().profile, null, "a reply after dispose never commits");
  assert.equal(controller.getState().phase, "idle");

  // A disposed controller starts nothing new.
  await controller.load();
  await flush();
  assert.equal(deferredApi.calls.length, 1, "no request after disposal");

  // The session subscription is gone: firing it cannot resurrect the view.
  sink.fire();
  await flush();
  assert.equal(deferredApi.calls.length, 1);
});

test("feature: the accepted M2-02 canonical reader is the seam actually used", async (t) => {
  resetCourseSessionLifetime();
  const entries: Record<string, string | null> = {
    authToken: "token-alpha",
    currentUser: JSON.stringify({ id: "user-1", role: "instructor" }),
  };
  const storage = storageOf(entries);
  const readPrincipal = () => readCourseSessionPrincipal(storage);

  const deferredApi = createDeferredApi();
  const sink = createSessionSink();
  const controller = createTenantProfileController(
    profileControllerApi(deferredApi, readPrincipal, sink)
  );
  t.after(() => controller.dispose());

  const first = controller.load();
  await flush();
  const canonicalBefore = readPrincipal();
  assert.ok(canonicalBefore && canonicalBefore.startsWith("session:"), "a session was observed");

  // A token rotation completes mid-flight: the same document must observe a
  // new principal, so the in-flight reply can no longer commit.
  entries.authToken = "token-beta";
  const rotated = readPrincipal();
  assert.notEqual(rotated, canonicalBefore, "rotation is a new canonical incarnation");

  // The real page reacts to the rotation through the session notifier: the
  // controller retires the old read and re-reads under the new principal.
  sink.fire();
  await flush();
  assert.equal(deferredApi.calls.length, 2, "the controller re-read for the rotated session");

  deferredApi.calls[0].resolve(validEnvelope({ business_name: "قبل التدوير" }));
  await first;
  await flush();
  assert.equal(controller.getState().profile, null, "the pre-rotation reply is dropped");

  deferredApi.calls[1]?.resolve(validEnvelope({ business_name: "بعد التدوير" }));
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "بعد التدوير");
});


