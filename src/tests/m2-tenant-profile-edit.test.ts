/**
 * M2-06 institution-name editor — isolated production-path tests
 * (node:test + tsx).
 *
 * Drives the REAL production seams only:
 *  - `updateMyTenantProfile` in src/lib/api-http.ts through the real canonical
 *    `request` (stubbed fetch/localStorage/window);
 *  - the REAL controller/edit lifecycle in src/features/tenant/profile.ts with
 *    an injected fake transport, principal reader and session notifier.
 *
 * Behaviours pinned:
 *  - exact PATCH `/tenants/me/profile`, canonical bearer, trimmed
 *    `business_name`-only body and no client tenant selector;
 *  - documented transported messages only (the code/status are discarded);
 *  - confirmed success updates the card without an extra GET;
 *  - owner denial / conflict / invalid payload preserve the read-authorized
 *    profile and the draft;
 *  - malformed/500/network replies are uncertain: no success, no automatic
 *    PATCH retry, draft preserved, deliberate GET reconciliation only;
 *  - invalid names never reach the transport;
 *  - synchronous duplicate suppression and own-ticket latch release;
 *  - cancel/reopen form generations and old-GET/new-PATCH ordering;
 *  - session change/silent principal change/dispose/old-finally lifetimes;
 *  - operation-owned lifetime settlement: a retired read never leaves a
 *    phantom `loading` phase and a retired save never leaves the editor
 *    stuck in `saving` (the draft and the real message survive);
 *  - exact institution binding: a well-formed PATCH DTO for another
 *    institution is never committed, and a current read that changes the
 *    confirmed institution invalidates the open form.
 *  - a retired read observes the canonical principal BEFORE it settles the
 *    phase it owns: a silent logout during a pending write never revives the
 *    previous principal's card, draft or phase, and the retired completion
 *    never clears a newer principal's state nor frees its latch.
 *
 * Not claimed: DOM paint, real HTTP/DB, or measurable performance. Request
 * counts are asserted by number, not time.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  updateMyTenantProfile,
  type TenantProfile,
  type TenantProfileEnvelope,
} from "../lib/api-http";
import {
  classifyTenantProfileWriteFailure,
  createTenantProfileController,
  PROFILE_NAME_INVALID_MESSAGE,
  PROFILE_RECONCILED_MESSAGE,
  PROFILE_WRITE_UNCERTAIN_MESSAGE,
  type TenantProfileApi,
  type TenantProfileController,
} from "../features/tenant/profile";
import { subscribeSessionChange } from "../lib/session-events";

// ---------------------------------------------------------------------------
// Harness helpers
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

interface SaveCall {
  name: string;
  deferred: Deferred<TenantProfileEnvelope>;
}

interface Harness {
  api: TenantProfileApi;
  loads: Deferred<TenantProfileEnvelope>[];
  saves: SaveCall[];
  setPrincipal: (value: string | null) => void;
  fireSession: () => void;
}

const createHarness = (initialPrincipal: string | null = "session:a"): Harness => {
  const loads: Deferred<TenantProfileEnvelope>[] = [];
  const saves: SaveCall[] = [];
  let principal = initialPrincipal;
  let listener: (() => void) | null = null;
  const api: TenantProfileApi = {
    loadProfile: () => {
      const d = deferred<TenantProfileEnvelope>();
      loads.push(d);
      return d.promise;
    },
    updateProfile: (name) => {
      const d = deferred<TenantProfileEnvelope>();
      saves.push({ name, deferred: d });
      return d.promise;
    },
    readPrincipal: () => principal,
    subscribeSession: (l) => {
      listener = l;
      return () => { listener = null; };
    },
  };
  return {
    api,
    loads,
    saves,
    setPrincipal: (value) => { principal = value; },
    fireSession: () => { if (listener) listener(); },
  };
};

const loadedController = async (
  harness: Harness,
  t: { after: (fn: () => void) => void }
): Promise<TenantProfileController> => {
  const controller = createTenantProfileController(harness.api);
  t.after(() => controller.dispose());
  const loaded = controller.load();
  await flush();
  harness.loads[0].resolve(validEnvelope());
  await loaded;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  return controller;
};

const openWithDraft = (controller: TenantProfileController, draft: string): void => {
  controller.openEditor();
  controller.updateDraft(draft);
};

// ===========================================================================
// Transport seam — the REAL adapter through the REAL request
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
  const assignments: string[] = [];
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  };
  (globalThis as unknown as { window: unknown }).window = {
    location: {
      pathname: "/instructor",
      assign: (url: string) => { assignments.push(String(url)); },
    },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    assignedUrls: assignments,
    restore: () => {
      (globalThis as unknown as { localStorage: unknown }).localStorage = realLocalStorage ?? undefined;
      (globalThis as unknown as { window: unknown }).window = realWindow;
      globalThis.fetch = realFetch;
    },
  };
};

const stubFetch = (
  env: TransportEnv,
  response: () => { ok: boolean; status: number; body: unknown }
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

test("transport: canonical authenticated PATCH of the exact profile path", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: validEnvelope({ business_name: "اسم جديد" }) }));

  const body = await updateMyTenantProfile("اسم جديد");

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, "/api/tenants/me/profile");
  assert.equal(env.calls[0].init.method, "PATCH");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    Object.keys(headers).filter((key) => /tenant|scope|workspace|x-/i.test(key)),
    [],
    "no client tenant selector header"
  );
  assert.equal(env.calls[0].url.includes("?"), false, "no query selector");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { business_name: "اسم جديد" });
  assert.deepEqual(body, validEnvelope({ business_name: "اسم جديد" }));
});

test("transport: a missing token fails closed with no Authorization header", async (t) => {
  const env = installTransportEnvironment(null);
  t.after(env.restore);
  stubFetch(env, () => ({ ok: false, status: 401, body: { error: "Invalid token" } }));

  await assert.rejects(() => updateMyTenantProfile("اسم"), /Invalid token/);

  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined, "no bearer without a token");
});

test("transport: write errors arrive as their documented message only", async (t) => {
  const env = installTransportEnvironment("token-denied");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 404,
    body: { error: "Tenant membership not found", code: "OWNER_REQUIRED" },
  }));

  await assert.rejects(() => updateMyTenantProfile("اسم"), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal((cause as Error).message, "Tenant membership not found");
    assert.equal((cause as Error & { status?: number }).status, undefined, "status is discarded");
    assert.equal((cause as Error & { code?: string }).code, undefined, "code is discarded");
    return true;
  });
});

test("transport: a network failure arrives as its actual message", async (t) => {
  const env = installTransportEnvironment("token-net");
  t.after(env.restore);
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  await assert.rejects(() => updateMyTenantProfile("اسم"), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal((cause as Error).message, "fetch failed");
    return true;
  });
});

test("transport: a real 403 suspension tears the session down", async (t) => {
  const env = installTransportEnvironment("token-suspended");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: { error: "Instructor account is administratively suspended", code: "TENANT_SUSPENDED" },
  }));
  const events: string[] = [];
  const unsubscribe = subscribeSessionChange((event) => events.push(event.kind));
  t.after(unsubscribe);

  await assert.rejects(() => updateMyTenantProfile("اسم"), /administratively suspended/);

  assert.equal((globalThis.localStorage as Storage).getItem("authToken"), null);
  assert.deepEqual(events, ["logout"]);
  assert.deepEqual(env.assignedUrls, ["/auth"]);
});

// ===========================================================================
// Write failure classification — documented messages, no fabricated status
// ===========================================================================

test("classification: documented write messages map to honest kinds", () => {
  assert.equal(classifyTenantProfileWriteFailure(new Error("Invalid token")).kind, "unauthorized");
  assert.equal(
    classifyTenantProfileWriteFailure(new Error("Instructor account is administratively suspended")).kind,
    "unauthorized"
  );
  assert.equal(classifyTenantProfileWriteFailure(new Error("Tenant membership not found")).kind, "denied");
  assert.equal(
    classifyTenantProfileWriteFailure(new Error("Select an instructor workspace first")).kind,
    "denied"
  );
  assert.equal(
    classifyTenantProfileWriteFailure(new Error("Tenant profile was modified concurrently")).kind,
    "conflict"
  );
  assert.equal(
    classifyTenantProfileWriteFailure(new Error("Invalid profile update payload")).kind,
    "invalid"
  );
  assert.equal(
    classifyTenantProfileWriteFailure(new Error("Failed to update tenant profile")).kind,
    "uncertain"
  );
});

test("classification: a discarded code or unknown message is never interpreted as success or permission", () => {
  for (const message of ["TOKEN_EXPIRED", "TENANT_SUSPENDED", "OWNER_REQUIRED", "fetch failed"]) {
    const failure = classifyTenantProfileWriteFailure(new Error(message));
    assert.equal(failure.kind, "uncertain", `${message} must stay uncertain, not guessed`);
    assert.equal(failure.message, message);
  }
});

// ===========================================================================
// Controller — success, request exactness, single-flight
// ===========================================================================

test("feature: a confirmed save trims the name, updates the card and needs no extra GET", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "  اسم جديد  ");
  const saved = controller.save();
  await flush();
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.saves[0].name, "اسم جديد", "the transport receives the trimmed name only");
  assert.equal(controller.getState().edit.status, "saving");
  assert.equal(controller.getState().profile?.business_name, "أكاديمية النجاح", "no optimistic success");

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم جديد" }));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "اسم جديد");
  assert.equal(controller.getState().edit.status, "closed");
  assert.equal(controller.getState().edit.draft, "");
  assert.equal(controller.getState().edit.error, null);
  assert.equal(controller.getState().edit.notice, null);
  assert.equal(harness.loads.length, 1, "a confirmed PATCH triggers no automatic GET");
});

test("feature: invalid names never reach the transport and the draft is kept", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  for (const invalid of ["", "   ", "a".repeat(256)]) {
    openWithDraft(controller, invalid);
    await controller.save();
    await flush();
    assert.equal(harness.saves.length, 0, "no request for an invalid name");
    assert.equal(controller.getState().edit.status, "editing");
    assert.equal(controller.getState().edit.draft, invalid);
    assert.equal(controller.getState().edit.error, PROFILE_NAME_INVALID_MESSAGE);
    controller.cancelEdit();
  }
});

test("feature: a synchronous duplicate save reaches the transport once and later saves are usable", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم أول");
  const first = controller.save();
  const second = controller.save();
  await flush();
  assert.equal(harness.saves.length, 1, "the second same-tick save is latched away");

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم أول" }));
  await Promise.all([first, second]);
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "اسم أول");

  openWithDraft(controller, "اسم ثان");
  const third = controller.save();
  await flush();
  assert.equal(harness.saves.length, 2, "the first save's own finally released its latch");
  harness.saves[1].deferred.resolve(validEnvelope({ business_name: "اسم ثان" }));
  await third;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "اسم ثان");
});

// ===========================================================================
// Controller — denial and teardown preserve/drop the right state
// ===========================================================================

test("feature: an owner-only denial keeps the read-authorized profile and the draft", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم مرفوض");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.reject(new Error("Tenant membership not found"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready", "a denied write never erases a valid read");
  assert.equal(controller.getState().profile?.business_name, "أكاديمية النجاح");
  assert.equal(controller.getState().edit.status, "editing");
  assert.equal(controller.getState().edit.draft, "اسم مرفوض");
  assert.equal(controller.getState().edit.error, "Tenant membership not found");
  assert.equal(controller.getState().edit.notice, null);
});

test("feature: a 409 concurrent-row answer is a retryable conflict, not an uncertain write", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم متزامن");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.reject(new Error("Tenant profile was modified concurrently"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().edit.status, "editing");
  assert.equal(controller.getState().edit.error, "Tenant profile was modified concurrently");
  assert.equal(controller.getState().edit.notice, null);
});

test("feature: a 401 write answer clears the private profile and draft", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم خاص");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.reject(new Error("Token expired"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "unauthorized");
  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().edit.status, "closed");
  assert.equal(controller.getState().edit.draft, "");
  assert.equal(controller.getState().error, "Token expired");
});

// ===========================================================================
// Controller — uncertain replies and deliberate reconciliation
// ===========================================================================

test("feature: a malformed 2xx body is uncertain; reconcile reads current state without proving the write", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم غير مؤكد");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.resolve({ tenant: { id: "tenant-1" } } as unknown as TenantProfileEnvelope);
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "أكاديمية النجاح", "no success from a malformed body");
  assert.equal(controller.getState().edit.status, "uncertain");
  assert.equal(controller.getState().edit.draft, "اسم غير مؤكد");
  assert.equal(controller.getState().edit.notice, PROFILE_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(harness.saves.length, 1, "no automatic PATCH retry");

  const reconciled = controller.reconcile();
  await flush();
  assert.equal(harness.loads.length, 2, "reconciliation is exactly one deliberate GET");
  harness.loads[1].resolve(validEnvelope({ business_name: "اسم غير مؤكد" }));
  await reconciled;
  await controller.waitForIdle();

  assert.equal(controller.getState().profile?.business_name, "اسم غير مؤكد", "the GET shows current state");
  assert.equal(controller.getState().edit.status, "uncertain", "a matching GET is not proof of the write");
  assert.equal(controller.getState().edit.draft, "اسم غير مؤكد", "the draft is preserved");
  assert.equal(controller.getState().edit.notice, PROFILE_RECONCILED_MESSAGE);
  assert.equal(harness.saves.length, 1, "reconciliation never repeats the PATCH");
});

test("feature: the handler 500 is uncertain and reconciliation issues no duplicate write", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم خادم");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.reject(new Error("Failed to update tenant profile"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().edit.status, "uncertain");
  assert.equal(controller.getState().edit.error, "Failed to update tenant profile");
  assert.equal(controller.getState().edit.notice, PROFILE_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(controller.getState().edit.draft, "اسم خادم");
  assert.equal(harness.saves.length, 1);

  const reconciled = controller.reconcile();
  await flush();
  assert.equal(harness.loads.length, 2);
  harness.loads[1].resolve(validEnvelope());
  await reconciled;
  await controller.waitForIdle();

  assert.equal(harness.saves.length, 1, "only the explicit user save wrote");
});

test("feature: a network failure is uncertain, preserves the draft and starts no retry", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم شبكة");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.reject(new TypeError("fetch failed"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().edit.status, "uncertain");
  assert.equal(controller.getState().edit.error, "fetch failed");
  assert.equal(controller.getState().edit.draft, "اسم شبكة");
  assert.equal(harness.saves.length, 1);

  const reconciled = controller.reconcile();
  await flush();
  assert.equal(harness.loads.length, 2);
  harness.loads[1].reject(new Error("Failed to load tenant profile"));
  await reconciled;
  await controller.waitForIdle();

  assert.equal(harness.saves.length, 1, "a failed reconcile does not write");
  assert.equal(controller.getState().edit.status, "uncertain", "the warning survives a failed read");
  assert.equal(controller.getState().edit.draft, "اسم شبكة");
});

// ===========================================================================
// Controller — form generations, read/write ordering and lifetimes
// ===========================================================================

test("feature: cancel/reopen is not mutated by a late save reply", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم قيد الحفظ");
  const saved = controller.save();
  await flush();
  controller.cancelEdit();
  controller.openEditor();
  controller.updateDraft("مسودة جديدة");
  assert.equal(controller.getState().edit.status, "editing");

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم قيد الحفظ" }));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().profile?.business_name, "اسم قيد الحفظ", "server truth updates the card");
  assert.equal(controller.getState().edit.status, "editing", "the reopened form is not closed");
  assert.equal(controller.getState().edit.draft, "مسودة جديدة", "the newer draft is not overwritten");
});

test("feature: an old save cannot overwrite a newer read completion", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم قديم");
  const saved = controller.save();
  await flush();
  const refreshed = controller.refresh();
  await flush();
  assert.equal(harness.saves.length, 1);
  assert.equal(harness.loads.length, 2);

  harness.loads[1].resolve(validEnvelope({ business_name: "حالة أحدث" }));
  await refreshed;
  await flush();
  assert.equal(controller.getState().profile?.business_name, "حالة أحدث");

  // The still-pending save is settled only after the newer read completed.
  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم قديم" }));
  await saved;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "حالة أحدث", "the old write is dropped");
});

test("feature: an old GET cannot overwrite a confirmed newer write", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم محفوظ");
  const refreshed = controller.refresh();
  await flush();
  const saved = controller.save();
  await flush();
  assert.equal(harness.loads.length, 2);
  assert.equal(harness.saves.length, 1);

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم محفوظ" }));
  await saved;
  await flush();
  assert.equal(controller.getState().profile?.business_name, "اسم محفوظ");
  assert.equal(controller.getState().edit.status, "closed");

  // The still-pending older GET settles only after the write confirmed.
  harness.loads[1].resolve(validEnvelope({ business_name: "حالة قديمة" }));
  await refreshed;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "اسم محفوظ", "the old GET is dropped");
});

test("feature: a session event clears the draft/profile and drops the in-flight save", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "مسودة الجلسة الأولى");
  const saved = controller.save();
  await flush();

  harness.setPrincipal("session:b");
  harness.fireSession();
  assert.equal(controller.getState().profile, null, "identity cleared before the new read");
  assert.equal(controller.getState().edit.status, "closed");
  assert.equal(controller.getState().edit.draft, "");
  await flush();
  assert.equal(harness.loads.length, 2, "the session event starts the bounded new read");

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم الجلسة الأولى" }));
  await saved;
  harness.loads[1].resolve(validEnvelope({ business_name: "اسم الجلسة الثانية" }));
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "اسم الجلسة الثانية");
});

test("feature: a silent principal change drops the save result and clears the private state", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم صامت");
  const saved = controller.save();
  await flush();
  harness.setPrincipal("session:b");

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم صامت" }));
  await saved;
  await flush();

  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().edit.status, "closed");
  assert.equal(controller.getState().edit.draft, "");
});

test("feature: dispose drops the save reply and clears the editor", async (t) => {
  const harness = createHarness();
  const controller = createTenantProfileController(harness.api);
  const loaded = controller.load();
  await flush();
  harness.loads[0].resolve(validEnvelope());
  await loaded;
  await controller.waitForIdle();

  openWithDraft(controller, "اسم بعد الإزالة");
  const saved = controller.save();
  await flush();
  controller.dispose();
  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم بعد الإزالة" }));
  await saved;
  await flush();

  assert.equal(controller.getState().profile, null);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().edit.status, "closed");
  assert.equal(controller.getState().edit.draft, "");
});

test("feature: an old save's finally never releases a newer save's latch", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم أول");
  const first = controller.save();
  await flush();
  assert.equal(harness.saves.length, 1);

  // A session change retires the first save and starts a new read.
  harness.setPrincipal("session:b");
  harness.fireSession();
  await flush();
  harness.loads[1].resolve(validEnvelope({ business_name: "مساحة ب" }));
  await flush();
  assert.equal(controller.getState().phase, "ready");

  openWithDraft(controller, "اسم ثان");
  const second = controller.save();
  await flush();
  assert.equal(harness.saves.length, 2);

  const dropped = controller.save();
  await flush();
  assert.equal(harness.saves.length, 2, "the newer save owns the latch");

  harness.saves[0].deferred.reject(new Error("Token expired"));
  await first;
  await flush();
  const stillDropped = controller.save();
  await flush();
  assert.equal(harness.saves.length, 2, "the retired save's finally did not free the new latch");

  harness.saves[1].deferred.resolve(validEnvelope({ business_name: "اسم ثان" }));
  await Promise.all([second, dropped, stillDropped]);
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "اسم ثان");
});

// ===========================================================================
// Controller — a retired operation settles the state it owns
// ===========================================================================

test("feature: a newer GET that supersedes a pending PATCH leaves a usable editor and the draft", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم جديد");
  const saved = controller.save();
  await flush();
  assert.equal(controller.getState().edit.status, "saving");

  const refreshed = controller.refresh();
  await flush();
  assert.equal(controller.getState().phase, "loading");

  harness.loads[1].resolve(validEnvelope({ business_name: "حالة أحدث" }));
  await refreshed;
  await flush();
  assert.equal(controller.getState().profile?.business_name, "حالة أحدث", "the newer read owns the card");

  // The still-pending PATCH settles after the newer read already committed.
  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم جديد" }));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().profile?.business_name, "حالة أحدث", "the retired write is not committed");
  assert.notEqual(controller.getState().edit.status, "saving", "the editor is usable again");
  assert.equal(controller.getState().edit.status, "editing");
  assert.equal(controller.getState().edit.draft, "اسم جديد", "the draft is preserved");
  assert.equal(controller.getState().edit.error, null, "no failure is invented");
  assert.equal(harness.saves.length, 1, "no automatic PATCH retry");

  // The recovered editor is usable: a deliberate retry is the user's own act.
  const retried = controller.save();
  await flush();
  assert.equal(harness.saves.length, 2, "the deliberate retry reaches the transport");
  assert.equal(harness.saves[1].name, "اسم جديد");
  harness.saves[1].deferred.resolve(validEnvelope({ business_name: "اسم جديد" }));
  await retried;
  await controller.waitForIdle();
  assert.equal(controller.getState().profile?.business_name, "اسم جديد");
  assert.equal(controller.getState().edit.status, "closed");
});

test("feature: a PATCH denial that supersedes an older GET leaves no phantom loading and no lost draft", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم مرفوض");
  const refreshed = controller.refresh();
  await flush();
  assert.equal(controller.getState().phase, "loading");

  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.reject(new Error("Tenant membership not found"));
  await saved;
  await flush();
  assert.equal(controller.getState().edit.status, "editing", "the denial leaves the editor usable");
  assert.equal(controller.getState().edit.error, "Tenant membership not found");

  // The older GET settles after the denial: it must not strand the page.
  harness.loads[1].resolve(validEnvelope({ business_name: "حالة قديمة" }));
  await refreshed;
  await controller.waitForIdle();

  assert.notEqual(controller.getState().phase, "loading", "every request settled, the page is not loading");
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.business_name, "أكاديمية النجاح", "the retired read is not committed");
  assert.equal(controller.getState().edit.status, "editing");
  assert.equal(controller.getState().edit.draft, "اسم مرفوض", "the draft is preserved");
  assert.equal(controller.getState().edit.error, "Tenant membership not found");
});

test("feature: a denial that arrives after a newer read surfaces instead of a stuck saving state", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم مرفوض");
  const saved = controller.save();
  await flush();
  const refreshed = controller.refresh();
  await flush();
  harness.loads[1].resolve(validEnvelope({ business_name: "حالة أحدث" }));
  await refreshed;
  await flush();

  harness.saves[0].deferred.reject(new Error("Tenant membership not found"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().edit.status, "editing", "the editor is usable again");
  assert.equal(controller.getState().edit.error, "Tenant membership not found", "the real message is shown");
  assert.equal(controller.getState().edit.draft, "اسم مرفوض", "the draft is preserved");
  assert.equal(controller.getState().profile?.business_name, "حالة أحدث", "the newer read still owns the card");
  assert.equal(harness.saves.length, 1, "no automatic PATCH retry");
});

test("feature: an unknown outcome that arrives after a newer read stays uncertain without a retry", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم غير مؤكد");
  const saved = controller.save();
  await flush();
  const refreshed = controller.refresh();
  await flush();
  harness.loads[1].resolve(validEnvelope({ business_name: "حالة أحدث" }));
  await refreshed;
  await flush();

  harness.saves[0].deferred.reject(new TypeError("fetch failed"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().edit.status, "uncertain", "an unknown outcome is never a success");
  assert.equal(controller.getState().edit.error, "fetch failed");
  assert.equal(controller.getState().edit.notice, PROFILE_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(controller.getState().edit.draft, "اسم غير مؤكد", "the draft is preserved");
  assert.equal(harness.saves.length, 1, "no automatic PATCH retry");
});

// ===========================================================================
// Controller — the write is bound to the exact confirmed institution
// ===========================================================================

test("feature: a well-formed PATCH DTO for another institution is uncertain and never committed", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم جديد");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.resolve(validEnvelope({ id: "tenant-2", business_name: "اسم مؤسسة أخرى" }));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().profile?.id, "tenant-1", "the foreign profile is never committed");
  assert.equal(controller.getState().profile?.business_name, "أكاديمية النجاح", "the card keeps the confirmed identity");
  assert.equal(controller.getState().edit.status, "uncertain", "a foreign DTO is never a success");
  assert.equal(controller.getState().edit.draft, "اسم جديد", "the draft is preserved");
  assert.equal(controller.getState().edit.notice, PROFILE_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(harness.saves.length, 1, "no automatic PATCH retry");
});

test("feature: a matching server-confirmed DTO for the bound institution commits and closes the form", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم جديد");
  const saved = controller.save();
  await flush();
  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "اسم جديد" }));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().profile?.id, "tenant-1", "the bound institution is committed");
  assert.equal(controller.getState().profile?.business_name, "اسم جديد", "the server's own name is shown");
  assert.equal(controller.getState().edit.status, "closed");
  assert.equal(harness.loads.length, 1, "no extra GET after a confirmed write");
});

test("feature: a current read that changes the confirmed institution invalidates the open form", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "اسم مساحة أخرى");
  const refreshed = controller.refresh();
  await flush();
  harness.loads[1].resolve(validEnvelope({ id: "tenant-9", business_name: "مؤسسة أخرى" }));
  await refreshed;
  await controller.waitForIdle();

  assert.equal(controller.getState().profile?.id, "tenant-9", "the current read owns the identity");
  assert.equal(controller.getState().edit.status, "closed", "the form for the previous institution is invalidated");
  assert.equal(controller.getState().edit.draft, "", "the other institution's draft is not carried over");

  await controller.save();
  await flush();
  assert.equal(harness.saves.length, 0, "no write is sent for an invalidated form");
});

// ===========================================================================
// Controller — a retired read observes the principal before it settles
// ===========================================================================

for (const outcome of ["success", "error"] as const) {
  test(`feature: a retired GET observes a silent logout before it settles the visible state (${outcome})`, async (t) => {
    const harness = createHarness();
    const controller = await loadedController(harness, t);

    openWithDraft(controller, "مسودة خاصة");
    const saved = controller.save();
    await flush();
    const retired = controller.refresh();
    await flush();
    assert.equal(harness.saves.length, 1, "the write is on the wire");
    assert.equal(harness.loads.length, 2, "the read is on the wire");

    // A silent logout: no notifier fires, so the canonical principal is only
    // observable when an operation completes.
    harness.setPrincipal(null);

    if (outcome === "success") {
      harness.loads[1].resolve(validEnvelope({ business_name: "حالة قديمة" }));
    } else {
      harness.loads[1].reject(new Error("fetch failed"));
    }
    await retired;
    await flush();

    const observed = controller.getState();
    assert.equal(observed.profile, null, "a retired GET never revives the previous principal's card");
    assert.equal(observed.edit.draft, "", "the previous principal's private draft is cleared");
    assert.equal(observed.phase, "idle", "the retired phase is not settled as a ready card");
    assert.equal(observed.edit.status, "closed");

    // The still-pending write belongs to the retired principal as well: it
    // never commits and it is never retried automatically.
    harness.saves[0].deferred.resolve(validEnvelope({ business_name: "مسودة خاصة" }));
    await saved;
    await controller.waitForIdle();

    assert.equal(controller.getState().profile, null, "the retired write never commits");
    assert.equal(controller.getState().edit.draft, "", "no private draft survives the change");
    assert.equal(harness.saves.length, 1, "no automatic PATCH retry");
    assert.equal(harness.loads.length, 2, "no automatic extra GET");
  });
}

test("feature: a retired GET that observes a silent change never clears the newer principal's state or latch", async (t) => {
  const harness = createHarness();
  const controller = await loadedController(harness, t);

  openWithDraft(controller, "مسودة الجلسة الأولى");
  const saved = controller.save();
  await flush();
  const retired = controller.refresh();
  await flush();

  // The principal changes silently and the NEW principal's own read starts:
  // it adopts the change and owns the phase, the latch and the visible state.
  harness.setPrincipal("session:b");
  const forNewPrincipal = controller.refresh();
  await flush();
  assert.equal(harness.loads.length, 3, "the new principal's read is on the wire");

  // The retired GET for the previous principal settles late.
  harness.loads[1].resolve(validEnvelope({ business_name: "حالة قديمة" }));
  await retired;
  await flush();

  assert.equal(controller.getState().profile, null, "the retired reply never commits");
  assert.equal(controller.getState().phase, "loading", "the newer read still owns the phase");
  assert.equal(controller.getState().edit.draft, "", "the previous principal's draft is cleared");

  // The newer read's latch is intact: a duplicate read never reaches the wire.
  const dropped = controller.refresh();
  await flush();
  assert.equal(harness.loads.length, 3, "the retired completion did not free the newer read's latch");

  harness.saves[0].deferred.resolve(validEnvelope({ business_name: "مسودة الجلسة الأولى" }));
  await saved;
  harness.loads[2].resolve(validEnvelope({ id: "tenant-2", business_name: "مساحة ب" }));
  await Promise.all([forNewPrincipal, dropped]);
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().profile?.id, "tenant-2", "the newer principal's own identity is shown");
  assert.equal(controller.getState().profile?.business_name, "مساحة ب");
});
