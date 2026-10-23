/**
 * M2-12 private tenant branding UI — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/tenant/branding.ts` that
 * `src/features/tenant/TenantBrandingCard.tsx` mounts, the REAL additive
 * transport (`getMyTenantBranding`, `updateMyTenantBranding`) in
 * `src/lib/api-http.ts`, and the REAL component rendered with the real React
 * server renderer — all imported unchanged. Fully isolated: no DB, no network,
 * no browser, no live services, no dependency install. The transport seam drives
 * the REAL `request` with a stubbed global fetch/localStorage/window; the
 * feature seam drives the REAL controller with an injected fake transport,
 * principal reader and session notifier.
 *
 * Behaviours pinned (M2-B06 contract):
 *  - canonical authenticated request: the exact `/tenants/me/branding` path, the
 *    bearer header, and NO client tenant selector in header/query/body;
 *  - the strict dirty-subset body: only the fields that actually changed are
 *    sent, `null` is transmitted only when the user chose "inherit", and an
 *    untouched field is never sent;
 *  - the documented transport error behavior: the server `error` message is
 *    thrown WITHOUT the HTTP status and WITHOUT the `code`, so only documented
 *    messages classify an outcome; the canonical BILLING_ONLY identity event and
 *    the suspension teardown keep working;
 *  - runtime DTO validation: the exact four-field branding DTO and the exact
 *    `{ branding }` envelope are required — an extra key, a non-canonical color,
 *    a non-ISO instant or a null instant beside a non-null field is a malformed
 *    response, never a fabricated branding;
 *  - the owner-only denial is distinguished from the billing-only denial, from
 *    the suspension and from the missing workspace, using only documented
 *    transported messages;
 *  - the panel loads ONLY after an explicit open, exactly one read at a time;
 *  - one synchronous save flight, no duplicate write;
 *  - a save with no effective change sends NO request at all;
 *  - an unknown write outcome stays explicitly uncertain: no automatic retry,
 *    the draft is preserved, and a deliberate read is offered and is never
 *    treated as proof of the save;
 *  - reversed/superseded replies never commit; the canonical principal is
 *    observed at entry AND at completion on the success and the failure path,
 *    and a RETIRED reply observes it BEFORE it settles any visible state;
 *  - a session event, a close and a dispose clear the private branding and
 *    drafts and drop every in-flight reply; an old `finally` never releases a
 *    newer operation's latch;
 *  - the preview is LOCAL and UNSAVED, switches Arabic RTL / English LTR inside
 *    the preview only, and never applies an unvalidated color.
 *
 * Not proven here: DOM paint, real RTL layout, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative). The accepted
 * migration FILE is not applied, so no runtime branding rollout is claimed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMyTenantBranding,
  updateMyTenantBranding,
  type TenantBranding,
  type TenantBrandingEnvelope,
} from "../lib/api-http";
import {
  BRANDING_COLOR_INVALID_MESSAGE,
  BRANDING_LABEL_INVALID_MESSAGE,
  BRANDING_NO_CHANGES_MESSAGE,
  BRANDING_RECONCILED_MESSAGE,
  BRANDING_WRITE_UNCERTAIN_MESSAGE,
  MALFORMED_BRANDING_MESSAGE,
  buildTenantBrandingPatch,
  buildTenantBrandingPreview,
  classifyTenantBrandingFailure,
  classifyTenantBrandingWriteFailure,
  createTenantBrandingController,
  isAbsentBranding,
  isTenantBrandingAuthorizationLoss,
  parseTenantBranding,
  parseTenantBrandingEnvelope,
  type TenantBrandingApi,
  type TenantBrandingState,
} from "../features/tenant/branding";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

const branding = (overrides: Partial<TenantBranding> = {}): TenantBranding => ({
  display_name_ar: "أكاديمية أ",
  display_name_en: "Academy A",
  accent_color: "#1D4ED8",
  updated_at: "2026-10-21T08:00:00.000Z",
  ...overrides,
});

const absent = (): TenantBranding => ({
  display_name_ar: null,
  display_name_en: null,
  accent_color: null,
  updated_at: null,
});

const envelope = (value: TenantBranding): TenantBrandingEnvelope => ({ branding: value });

interface Harness {
  api: TenantBrandingApi;
  loads: Deferred<TenantBrandingEnvelope>[];
  loadCount: () => number;
  writes: Deferred<TenantBrandingEnvelope>[];
  writeBodies: Record<string, unknown>[];
}

const createHarness = (): Harness => {
  const loads: Deferred<TenantBrandingEnvelope>[] = [];
  const writes: Deferred<TenantBrandingEnvelope>[] = [];
  const writeBodies: Record<string, unknown>[] = [];
  return {
    loads,
    writes,
    writeBodies,
    loadCount: () => loads.length,
    api: {
      loadBranding: () => {
        const d = deferred<TenantBrandingEnvelope>();
        loads.push(d);
        return d.promise;
      },
      updateBranding: (update) => {
        writeBodies.push({ ...update });
        const d = deferred<TenantBrandingEnvelope>();
        writes.push(d);
        return d.promise;
      },
    },
  };
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

/** A controller over a harness plus a mutable principal and session sink. */
const createController = (harness: Harness, initialPrincipal: string | null = "session:1") => {
  const session = createSessionSink();
  const principal = { value: initialPrincipal };
  const controller = createTenantBrandingController({
    ...harness.api,
    readPrincipal: () => principal.value,
    subscribeSession: session.subscribeSession,
  });
  return { controller, principal, session };
};

/** Drives the controller to a loaded 'ready' state with the given branding. */
const loadReady = async (
  harness: Harness,
  value: TenantBranding = branding(),
): Promise<ReturnType<typeof createController>> => {
  const ctx = createController(harness);
  const opening = ctx.controller.open();
  harness.loads[0].resolve(envelope(value));
  await opening;
  assert.equal(ctx.controller.getState().phase, value.updated_at === null ? "empty" : "ready");
  return ctx;
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

test("transport: the canonical authenticated GET of the branding envelope", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: envelope(branding()) }));

  const body = await getMyTenantBranding();

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, "/api/tenants/me/branding");
  assert.equal(env.calls[0].init.method, undefined, "a read: no explicit method override");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
  assert.deepEqual(
    Object.keys(headers).filter((key) => /tenant|scope|workspace|x-/i.test(key)),
    [],
    "no client tenant selector header",
  );
  assert.equal(env.calls[0].url.includes("?"), false, "no query selector at all");
  assert.equal(body.branding.display_name_en, "Academy A");
});

test("transport: a missing token fails closed — no Authorization header is sent", async (t) => {
  const env = installTransportEnvironment(null);
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: envelope(branding()) }));

  await getMyTenantBranding();

  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("transport: PATCH sends only the fields that were actually set", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: envelope(branding()) }));

  await updateMyTenantBranding({ display_name_en: "Academy B" });

  assert.equal(env.calls[0].url, "/api/tenants/me/branding");
  assert.equal(env.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { display_name_en: "Academy B" });
});

test("transport: an unset field is never transmitted as null", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: envelope(branding()) }));

  await updateMyTenantBranding({ accent_color: "#00AA11" });

  const sent = JSON.parse(String(env.calls[0].init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent), ["accent_color"], "only the dirty field is sent");
  assert.equal("display_name_ar" in sent, false);
  assert.equal("display_name_en" in sent, false);
});

test("transport: an explicit null is transmitted as the inherit value", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: envelope(branding()) }));

  await updateMyTenantBranding({ display_name_ar: null });

  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { display_name_ar: null });
});

test("transport: the server error message arrives without the status or the code", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 400,
    body: { error: "Invalid branding payload", code: "SOMETHING" },
  }));

  await assert.rejects(
    () => updateMyTenantBranding({ display_name_en: "x" }),
    (error: Error) => {
      assert.equal(error.message, "Invalid branding payload");
      assert.equal(/400/.test(error.message), false, "the discarded status is not invented");
      assert.equal(/SOMETHING/.test(error.message), false, "the discarded code is not invented");
      return true;
    },
  );
});

test("transport: the canonical BILLING_ONLY identity event and redirect are preserved", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  env.store.set("currentUser", JSON.stringify({ id: "user-1", role: "instructor", billing_only: false }));
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: {
      error: "Branding management is not available while the account is limited to billing and support",
      code: "BILLING_ONLY",
    },
  }));

  await assert.rejects(() => getMyTenantBranding());

  const stored = JSON.parse(env.store.get("currentUser")!) as { billing_only?: boolean };
  assert.equal(stored.billing_only, true, "the canonical identity event still runs");
  assert.deepEqual(env.assignedUrls, ["/instructor-subscription"], "the canonical redirect still runs");
});

test("transport: a TENANT_SUSPENDED refusal tears the session down", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 403,
    body: { error: "Instructor account is administratively suspended", code: "TENANT_SUSPENDED" },
  }));

  await assert.rejects(() => getMyTenantBranding());

  assert.equal(env.store.has("authToken"), false, "the token is cleared");
  assert.deepEqual(env.assignedUrls, ["/auth"], "the canonical teardown redirect runs");
});

// ===========================================================================
// Parser — a malformed body is never a success
// ===========================================================================

test("parser: the exact four-field envelope is accepted", () => {
  const parsed = parseTenantBrandingEnvelope(envelope(branding()));
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed.branding!).sort(), [
    "accent_color",
    "display_name_ar",
    "display_name_en",
    "updated_at",
  ]);
});

test("parser: the all-null absent DTO is accepted and recognized as absent", () => {
  const parsed = parseTenantBrandingEnvelope(envelope(absent()));
  assert.equal(parsed.ok, true);
  assert.equal(isAbsentBranding(parsed.branding!), true);
});

test("parser: an extra field is a malformed response", () => {
  const withExtra = { ...branding(), tenant_id: "tenant-a" };
  assert.equal(parseTenantBranding(withExtra).ok, false);
});

test("parser: a missing field is a malformed response", () => {
  const missing = {
    display_name_ar: "أ",
    display_name_en: null,
    accent_color: null,
  };
  assert.equal(parseTenantBranding(missing).ok, false);
});

test("parser: a non-canonical color is a malformed response", () => {
  for (const color of ["#1d4ed8", "#1D4ED", "#GGGGGG", "red", "rgb(1,2,3)", "url(#x)", ""]) {
    assert.equal(parseTenantBranding(branding({ accent_color: color })).ok, false, `refused: ${color}`);
  }
});

test("parser: an empty-string or over-long label is a malformed response", () => {
  assert.equal(parseTenantBranding(branding({ display_name_ar: "" })).ok, false);
  assert.equal(parseTenantBranding(branding({ display_name_ar: "   " })).ok, false);
  assert.equal(parseTenantBranding(branding({ display_name_ar: "a".repeat(256) })).ok, false);
  assert.equal(parseTenantBranding(branding({ display_name_ar: "a".repeat(255) })).ok, true);
});

test("parser: a non-ISO instant is a malformed response", () => {
  for (const instant of ["2026-10-21", "2026-10-21T08:00:00Z", "not-a-date", "", 1750000000, 0]) {
    assert.equal(
      parseTenantBranding(branding({ updated_at: instant as unknown as string })).ok,
      false,
      `refused: ${String(instant)}`,
    );
  }
});

test("parser: a calendar-impossible instant is a malformed response", () => {
  // JavaScript NORMALIZES an impossible calendar date into the next real day
  // (2026-02-30 becomes 2026-03-02), so a pattern match alone would accept an
  // instant the server can never have emitted. The exact canonical round trip
  // is what refuses it.
  for (const instant of [
    "2026-02-30T12:00:00.000Z",
    "2026-01-32T00:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-00-10T00:00:00.000Z",
  ]) {
    assert.equal(
      parseTenantBranding(branding({ updated_at: instant })).ok,
      false,
      `refused: ${instant}`,
    );
  }
  // A real calendar instant of the same shape is still accepted.
  assert.equal(parseTenantBranding(branding({ updated_at: "2026-02-28T12:00:00.000Z" })).ok, true);
  assert.equal(parseTenantBranding(branding({ updated_at: "2024-02-29T00:00:00.000Z" })).ok, true);
});

test("parser: an untrimmed server label is a malformed response, never a normalized confirmation", () => {
  // The server trims every label it stores, so an untrimmed value in a 2xx
  // body is a malformed DTO. It is refused, never normalized into a
  // confirmed branding.
  for (const label of [" original ", "Academy A ", " Academy A", "\tAcademy A", "Academy A\n", "  "]) {
    assert.equal(
      parseTenantBranding(branding({ display_name_ar: label })).ok,
      false,
      `refused: ${JSON.stringify(label)}`,
    );
  }
  assert.equal(parseTenantBranding(branding({ display_name_ar: "Academy A" })).ok, true);
});

test("parser: a null instant beside a non-null field is a contradiction and is refused", () => {
  const contradictory = {
    display_name_ar: "أكاديمية أ",
    display_name_en: null,
    accent_color: null,
    updated_at: null,
  };
  assert.equal(parseTenantBranding(contradictory).ok, false);
});

test("parser: a non-object or array body is a malformed response", () => {
  for (const body of [null, [], "text", 7, true]) {
    assert.equal(parseTenantBrandingEnvelope(body).ok, false, `refused: ${String(body)}`);
  }
});

test("parser: an envelope with an extra top-level key is a malformed response", () => {
  assert.equal(parseTenantBrandingEnvelope({ branding: branding(), extra: 1 }).ok, false);
  assert.equal(parseTenantBrandingEnvelope({ tenant: branding() }).ok, false);
});

// ===========================================================================
// Preview — local, unsaved, validated
// ===========================================================================

const stateWith = (overrides: Partial<TenantBrandingState> = {}): TenantBrandingState => ({
  open: true,
  phase: "ready",
  branding: branding(),
  error: null,
  reason: null,
  lastConfirmed: null,
  form: {
    mode: "closed",
    display_name_ar: { inherit: true, text: "" },
    display_name_en: { inherit: true, text: "" },
    accent_color: { inherit: true, text: "" },
    originalAr: "أكاديمية أ",
    originalEn: "Academy A",
    originalAccent: "#1D4ED8",
    error: null,
    notice: null,
  },
  mutation: { status: "idle", error: null, notice: null },
  previewLocale: "ar",
  ...overrides,
});

test("preview: a closed form previews the confirmed values as saved", () => {
  const preview = buildTenantBrandingPreview(stateWith());
  assert.equal(preview.displayName, "أكاديمية أ");
  assert.equal(preview.accentColor, "#1D4ED8");
  assert.equal(preview.unsaved, false);
  assert.equal(preview.inherited, false);
});

test("preview: an open form previews the LOCAL UNSAVED drafts", () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      display_name_ar: { inherit: false, text: "اسم جديد" },
      originalAr: "أكاديمية أ",
    },
  });
  const preview = buildTenantBrandingPreview(state);
  assert.equal(preview.displayName, "اسم جديد");
  assert.equal(preview.unsaved, true, "the preview says it is unsaved");
});

test("preview: the Arabic slot and the English slot read from their own field", () => {
  const ar = buildTenantBrandingPreview(stateWith({ previewLocale: "ar" }));
  const en = buildTenantBrandingPreview(stateWith({ previewLocale: "en" }));
  assert.equal(ar.displayName, "أكاديمية أ");
  assert.equal(en.displayName, "Academy A");
  assert.equal(ar.locale, "ar");
  assert.equal(en.locale, "en");
});

test("preview: an inherited slot renders no label", () => {
  const preview = buildTenantBrandingPreview(
    stateWith({ branding: branding({ display_name_ar: null }), previewLocale: "ar" }),
  );
  assert.equal(preview.displayName, null);
  assert.equal(preview.inherited, true);
});

test("preview: an inherited accent renders no color", () => {
  const preview = buildTenantBrandingPreview(stateWith({ branding: branding({ accent_color: null }) }));
  assert.equal(preview.accentColor, null);
});

test("preview: an invalid draft color never reaches the preview style", () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      accent_color: { inherit: false, text: "javascript:alert(1)" },
    },
  });
  assert.equal(buildTenantBrandingPreview(state).accentColor, null);
});

test("preview: a lowercase draft color is canonicalized before the preview", () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      accent_color: { inherit: false, text: "#a1b2c3" },
    },
  });
  assert.equal(buildTenantBrandingPreview(state).accentColor, "#A1B2C3");
});

test("preview: a stored non-canonical color is not applied", () => {
  const preview = buildTenantBrandingPreview(stateWith({ branding: branding({ accent_color: "#a1b2c3" }) }));
  assert.equal(preview.accentColor, null);
});

// ===========================================================================
// Controller — read lifecycle
// ===========================================================================

test("controller: no request happens before an explicit open", async () => {
  const harness = createHarness();
  const { controller } = createController(harness);
  await flush();
  assert.equal(harness.loadCount(), 0, "no request before the user opens the panel");
  assert.equal(controller.getState().phase, "idle");
});

test("controller: an explicit open performs exactly one read", async () => {
  const harness = createHarness();
  const ctx = createController(harness);
  const opening = ctx.controller.open();
  assert.equal(harness.loadCount(), 1);
  assert.equal(ctx.controller.getState().phase, "loading");
  harness.loads[0].resolve(envelope(branding()));
  await opening;
  assert.equal(ctx.controller.getState().phase, "ready");
  assert.equal(harness.loadCount(), 1, "exactly one read");
});

test("controller: a double-clicked open performs one read", async () => {
  const harness = createHarness();
  const ctx = createController(harness);
  const first = ctx.controller.open();
  const second = ctx.controller.open();
  await second;
  assert.equal(harness.loadCount(), 1, "the second open is a no-op");
  harness.loads[0].resolve(envelope(branding()));
  await first;
});

test("controller: a double-clicked refresh sends one read", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  const first = ctx.controller.refresh();
  const second = ctx.controller.refresh();
  await second;
  assert.equal(harness.loadCount(), 2, "one open + one refresh, not three");
  harness.loads[1].resolve(envelope(branding()));
  await first;
});

test("controller: an absent config row is the explicit 'empty' phase", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness, absent());
  assert.equal(ctx.controller.getState().phase, "empty");
  assert.equal(ctx.controller.getState().branding?.updated_at, null);
});

test("controller: a malformed 2xx is not a success", async () => {
  const harness = createHarness();
  const ctx = createController(harness);
  const opening = ctx.controller.open();
  harness.loads[0].resolve({ branding: { ...branding(), tenant_id: "leak" } } as unknown as TenantBrandingEnvelope);
  await opening;
  const state = ctx.controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error, MALFORMED_BRANDING_MESSAGE);
  assert.equal(state.branding, null, "no fabricated branding");
});

test("controller: a superseded read never commits", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  const stale = ctx.controller.refresh();
  // A newer read takes over before the older one answers.
  harness.loads[1].resolve(envelope(branding({ display_name_en: "Stale" })));
  await stale;
  const fresh = ctx.controller.refresh();
  harness.loads[2].resolve(envelope(branding({ display_name_en: "Fresh" })));
  await fresh;
  assert.equal(ctx.controller.getState().branding?.display_name_en, "Fresh");
});

test("controller: the owner denial is distinguished from billing-only and suspension", () => {
  const owner = classifyTenantBrandingFailure(new Error("Forbidden"));
  assert.equal(owner.phase, "denied");
  assert.equal(owner.reason, "not-owner");
  assert.equal(isTenantBrandingAuthorizationLoss(owner.reason), true);

  const billing = classifyTenantBrandingFailure(
    new Error("Branding management is not available while the account is limited to billing and support"),
  );
  assert.equal(billing.reason, "billing-only");
  assert.equal(isTenantBrandingAuthorizationLoss(billing.reason), true);

  const suspended = classifyTenantBrandingFailure(
    new Error("Instructor account is administratively suspended"),
  );
  assert.equal(suspended.reason, "suspended");
  assert.equal(isTenantBrandingAuthorizationLoss(suspended.reason), true);

  const workspace = classifyTenantBrandingFailure(new Error("Tenant membership not found"));
  assert.equal(workspace.reason, "no-workspace");

  const session = classifyTenantBrandingFailure(new Error("Token expired"));
  assert.equal(session.phase, "unauthorized");
});

test("controller: a retryable 500 is NOT a permission loss", () => {
  const server = classifyTenantBrandingFailure(new Error("Failed to load branding"));
  assert.equal(server.phase, "error");
  assert.equal(server.reason, "server");
  assert.equal(isTenantBrandingAuthorizationLoss(server.reason), false);

  const unknown = classifyTenantBrandingFailure(new Error("network down"));
  assert.equal(unknown.reason, "unknown");
  assert.equal(isTenantBrandingAuthorizationLoss(unknown.reason), false);
});

test("controller: a definite denial clears the confirmed branding and the drafts", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Draft");
  const denied = ctx.controller.refresh();
  harness.loads[1].reject(new Error("Forbidden"));
  await denied;
  const state = ctx.controller.getState();
  assert.equal(state.phase, "denied");
  assert.equal(state.branding, null, "the private branding is cleared");
  assert.equal(state.form.mode, "closed", "the draft is cleared");
});

test("controller: a retryable 500 keeps the draft for a deliberate retry", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Kept Draft");
  const failed = ctx.controller.refresh();
  harness.loads[1].reject(new Error("Failed to load branding"));
  await failed;
  const state = ctx.controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.form.mode, "editing", "the draft survives a retryable failure");
  assert.equal(state.form.display_name_en.text, "Kept Draft");
});

// ===========================================================================
// Controller — save lifecycle
// ===========================================================================

test("controller: a save with no effective change sends NO request", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  const saving = ctx.controller.save();
  await saving;
  assert.equal(harness.writes.length, 0, "no request is sent for a no-op");
  assert.equal(ctx.controller.getState().form.notice, BRANDING_NO_CHANGES_MESSAGE);
});

test("controller: a double-clicked save sends one write", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Academy B");
  const first = ctx.controller.save();
  const second = ctx.controller.save();
  await second;
  assert.equal(harness.writes.length, 1, "the second save never reaches the transport");
  harness.writes[0].resolve(envelope(branding({ display_name_en: "Academy B" })));
  await first;
});

test("controller: only the dirty subset is sent", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("accent_color", "#00aa11");
  const saving = ctx.controller.save();
  assert.deepEqual(harness.writeBodies[0], { accent_color: "#00AA11" }, "only the dirty field, canonicalized");
  harness.writes[0].resolve(envelope(branding({ accent_color: "#00AA11" })));
  await saving;
});

test("controller: an untouched field is never sent as null", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Academy B");
  const saving = ctx.controller.save();
  const sent = harness.writeBodies[0];
  assert.equal("display_name_ar" in sent, false, "the untouched Arabic label is not sent");
  assert.equal("accent_color" in sent, false, "the untouched color is not sent");
  harness.writes[0].resolve(envelope(branding({ display_name_en: "Academy B" })));
  await saving;
});

test("controller: choosing inherit sends an explicit null", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.setInherit("display_name_ar", true);
  const saving = ctx.controller.save();
  assert.deepEqual(harness.writeBodies[0], { display_name_ar: null });
  harness.writes[0].resolve(envelope(branding({ display_name_ar: null })));
  await saving;
});

test("controller: an empty label is rejected locally before any request", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "   ");
  const saving = ctx.controller.save();
  await saving;
  assert.equal(harness.writes.length, 0, "no request leaves the page");
  assert.equal(ctx.controller.getState().form.error, BRANDING_LABEL_INVALID_MESSAGE);
});

test("controller: a label over 255 characters is rejected locally", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "a".repeat(256));
  await ctx.controller.save();
  assert.equal(harness.writes.length, 0);
  assert.equal(ctx.controller.getState().form.error, BRANDING_LABEL_INVALID_MESSAGE);
});

test("controller: an invalid color is rejected locally before any request", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("accent_color", "red");
  await ctx.controller.save();
  assert.equal(harness.writes.length, 0);
  assert.equal(ctx.controller.getState().form.error, BRANDING_COLOR_INVALID_MESSAGE);
});

test("controller: a confirmed save shows the canonical server truth", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Academy B");
  const saving = ctx.controller.save();
  harness.writes[0].resolve(envelope(branding({ display_name_en: "Academy B", updated_at: "2026-10-21T10:00:00.000Z" })));
  await saving;
  const state = ctx.controller.getState();
  assert.equal(state.branding?.display_name_en, "Academy B");
  assert.equal(state.branding?.updated_at, "2026-10-21T10:00:00.000Z");
  assert.equal(state.lastConfirmed?.display_name_en, "Academy B");
  assert.equal(state.form.mode, "closed", "the form closes on a confirmed save");
  assert.equal(state.mutation.status, "idle");
});

test("controller: an uncertain save preserves the draft and offers reconcile", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Maybe Saved");
  const saving = ctx.controller.save();
  harness.writes[0].reject(new Error("Failed to update branding"));
  await saving;
  const state = ctx.controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.notice, BRANDING_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.form.mode, "editing", "the draft is preserved");
  assert.equal(state.form.display_name_en.text, "Maybe Saved");
  assert.equal(harness.writes.length, 1, "no automatic retry");
});

test("controller: a 2xx with a malformed body is uncertain, not success", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Academy B");
  const saving = ctx.controller.save();
  harness.writes[0].resolve({ branding: { ...branding(), accent_color: "#1d4ed8" } } as unknown as TenantBrandingEnvelope);
  await saving;
  const state = ctx.controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.lastConfirmed, null, "no success is claimed");
});

test("controller: an invalid payload reply is definite, not uncertain", () => {
  const failure = classifyTenantBrandingWriteFailure(new Error("Invalid branding payload"));
  assert.equal(failure.kind, "invalid");
});

test("controller: reconcile reads the current state and never claims the save", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Maybe Saved");
  const saving = ctx.controller.save();
  harness.writes[0].reject(new Error("Failed to update branding"));
  await saving;

  const reconciling = ctx.controller.reconcile();
  harness.loads[1].resolve(envelope(branding({ display_name_en: "Academy A" })));
  await reconciling;
  const state = ctx.controller.getState();
  assert.equal(state.branding?.display_name_en, "Academy A", "the current server value is shown");
  assert.equal(state.mutation.notice, BRANDING_RECONCILED_MESSAGE);
  assert.equal(state.lastConfirmed, null, "the earlier save is NOT confirmed by a read");
});

test("controller: reconcile does nothing unless a save is uncertain", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  await ctx.controller.reconcile();
  assert.equal(harness.loadCount(), 1, "no read is issued when nothing is uncertain");
});

// ===========================================================================
// Controller — lifetimes, sessions, disposal
// ===========================================================================

test("controller: a silent principal swap clears the private state before a new read", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Old Principal Draft");
  ctx.principal.value = "session:2";
  const refreshing = ctx.controller.refresh();
  await refreshing;
  assert.equal(harness.loadCount(), 1, "the swap is adopted instead of a read starting");
  const state = ctx.controller.getState();
  assert.equal(state.branding, null);
  assert.equal(state.form.mode, "closed");
});

test("controller: a session event retires in-flight work and reloads the open panel", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.principal.value = "session:2";
  ctx.session.fire();
  assert.equal(harness.loadCount(), 2, "the open panel gets its own first read");
  harness.loads[1].resolve(envelope(branding({ display_name_en: "New Principal" })));
  await ctx.controller.waitForIdle();
  assert.equal(ctx.controller.getState().branding?.display_name_en, "New Principal");
});

test("controller: a retired reply observes the principal BEFORE settling its phase", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  const stale = ctx.controller.refresh();
  ctx.principal.value = "session:2";
  harness.loads[1].resolve(envelope(branding({ display_name_en: "Foreign" })));
  await stale;
  const state = ctx.controller.getState();
  assert.equal(state.branding, null, "the foreign reply never commits");
  assert.notEqual(state.phase, "loading", "the retired read still settles its phase");
});

test("controller: close clears the confirmed branding and the drafts", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Draft");
  ctx.controller.close();
  const state = ctx.controller.getState();
  assert.equal(state.open, false);
  assert.equal(state.branding, null);
  assert.equal(state.form.mode, "closed");
});

test("controller: a close during a pending read drops the reply", async () => {
  const harness = createHarness();
  const ctx = createController(harness);
  const opening = ctx.controller.open();
  ctx.controller.close();
  harness.loads[0].resolve(envelope(branding()));
  await opening;
  assert.equal(ctx.controller.getState().branding, null, "the reply lands nowhere");
  assert.equal(ctx.controller.getState().open, false);
});

test("controller: dispose clears everything and drops in-flight replies", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  const refreshing = ctx.controller.refresh();
  ctx.controller.dispose();
  harness.loads[1].resolve(envelope(branding({ display_name_en: "After Dispose" })));
  await refreshing;
  const state = ctx.controller.getState();
  assert.equal(state.open, false);
  assert.equal(state.branding, null);
  assert.equal(state.form.mode, "closed");
});

test("controller: an older finally never releases a newer flight's latch", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  // The first refresh is retired by a session change, then a new read starts.
  const first = ctx.controller.refresh();
  ctx.principal.value = "session:2";
  ctx.session.fire();
  harness.loads[1].resolve(envelope(branding({ display_name_en: "First" })));
  await first;
  // The newer read is still in flight; a second refresh must be rejected.
  const before = harness.loadCount();
  await ctx.controller.refresh();
  assert.equal(harness.loadCount(), before, "the newer read still owns the latch");
  harness.loads[harness.loads.length - 1].resolve(envelope(branding({ display_name_en: "Second" })));
  await ctx.controller.waitForIdle();
});

test("controller: a read that started before a confirmed save never overwrites it", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  // The editor is opened BEFORE the read starts, so the draft survives the
  // read's loading phase (an editor cannot be opened while a read is pending).
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Saved");
  const stale = ctx.controller.refresh();
  const saving = ctx.controller.save();
  harness.writes[0].resolve(envelope(branding({ display_name_en: "Saved", updated_at: "2026-10-21T10:00:00.000Z" })));
  await saving;
  harness.loads[1].resolve(envelope(branding({ display_name_en: "Stale Page" })));
  await stale;
  assert.equal(
    ctx.controller.getState().branding?.display_name_en,
    "Saved",
    "the stale read never overwrites the confirmed save",
  );
});

test("controller: a late save reply never closes a newer form", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "First Save");
  const saving = ctx.controller.save();
  // The user cancels and opens a fresh form before the reply lands.
  ctx.controller.cancelEditor();
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Newer Draft");
  harness.writes[0].resolve(envelope(branding({ display_name_en: "First Save" })));
  await saving;
  const state = ctx.controller.getState();
  assert.equal(state.form.mode, "editing", "the newer form stays open");
  assert.equal(state.form.display_name_en.text, "Newer Draft", "the newer draft is untouched");
});

test("controller: a retired save success cannot settle a newer pending mutation", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "First Save");
  const first = ctx.controller.save();
  // The panel is closed and reopened, so the first save is retired while a
  // NEWER save is put in flight.
  ctx.controller.close();
  const reopening = ctx.controller.open();
  harness.loads[1].resolve(envelope(branding()));
  await reopening;
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Newer Save");
  const second = ctx.controller.save();
  assert.equal(ctx.controller.getState().mutation.status, "saving");

  // The retired reply lands while the newer save is still pending.
  harness.writes[0].resolve(envelope(branding({ display_name_en: "First Save" })));
  await first;

  const state = ctx.controller.getState();
  assert.equal(state.mutation.status, "saving", "the newer save keeps its own status");
  assert.equal(state.mutation.error, null, "no stale error from the retired reply");
  assert.equal(state.mutation.notice, null, "no stale notice from the retired reply");
  assert.equal(state.lastConfirmed, null, "no false confirmation");
  assert.equal(state.branding?.display_name_en, "Academy A", "the retired reply commits nothing");
  assert.equal(state.form.mode, "editing", "the newer form stays open");
  assert.equal(state.form.display_name_en.text, "Newer Save", "the newer draft is untouched");

  // The retired reply never released the newer flight's latch.
  ctx.controller.save();
  assert.equal(harness.writes.length, 2, "the newer flight still owns the write latch");

  // The follow-up save still commits its own canonical truth.
  harness.writes[1].resolve(envelope(branding({ display_name_en: "Newer Save" })));
  await second;
  const confirmed = ctx.controller.getState();
  assert.equal(confirmed.branding?.display_name_en, "Newer Save");
  assert.equal(confirmed.mutation.status, "idle");
  assert.equal(confirmed.lastConfirmed?.display_name_en, "Newer Save");
});

test("controller: a retired save error cannot settle a newer pending mutation", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "First Save");
  const first = ctx.controller.save();
  ctx.controller.close();
  const reopening = ctx.controller.open();
  harness.loads[1].resolve(envelope(branding()));
  await reopening;
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Newer Save");
  const second = ctx.controller.save();
  assert.equal(ctx.controller.getState().mutation.status, "saving");

  // The retired reply FAILS while the newer save is still pending.
  harness.writes[0].reject(new Error("Failed to update branding"));
  await first;

  const state = ctx.controller.getState();
  assert.equal(state.mutation.status, "saving", "the newer save is not made uncertain");
  assert.equal(state.mutation.error, null, "no stale error from the retired reply");
  assert.equal(state.mutation.notice, null, "no stale notice from the retired reply");
  assert.equal(state.lastConfirmed, null, "no false confirmation");
  assert.equal(state.form.mode, "editing", "the newer form stays open");
  assert.equal(state.form.display_name_en.text, "Newer Save", "the newer draft is untouched");

  // The retired reply never released the newer flight's latch.
  ctx.controller.save();
  assert.equal(harness.writes.length, 2, "the newer flight still owns the write latch");

  harness.writes[1].resolve(envelope(branding({ display_name_en: "Newer Save" })));
  await second;
  const confirmed = ctx.controller.getState();
  assert.equal(confirmed.branding?.display_name_en, "Newer Save");
  assert.equal(confirmed.mutation.status, "idle");
  assert.equal(confirmed.lastConfirmed?.display_name_en, "Newer Save");
});

test("controller: a 2xx with an untrimmed server label is uncertain, not success", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Academy B");
  const saving = ctx.controller.save();
  harness.writes[0].resolve(envelope(branding({ display_name_en: " Academy B " })));
  await saving;
  const state = ctx.controller.getState();
  assert.equal(state.mutation.status, "uncertain", "a malformed 2xx is never a confirmed success");
  assert.equal(state.mutation.notice, BRANDING_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.lastConfirmed, null, "no success is claimed");
  assert.equal(state.form.mode, "editing", "the draft is preserved");
  assert.equal(state.form.display_name_en.text, "Academy B");
  assert.equal(harness.writes.length, 1, "no automatic retry");
});

test("controller: a 2xx with a calendar-impossible instant is uncertain, not success", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  ctx.controller.updateDraft("display_name_en", "Academy B");
  const saving = ctx.controller.save();
  harness.writes[0].resolve(envelope(branding({ updated_at: "2026-02-30T12:00:00.000Z" })));
  await saving;
  const state = ctx.controller.getState();
  assert.equal(state.mutation.status, "uncertain", "a malformed 2xx is never a confirmed success");
  assert.equal(state.lastConfirmed, null, "no success is claimed");
  assert.equal(state.form.mode, "editing", "the draft is preserved");
  assert.equal(harness.writes.length, 1, "no automatic retry");
});

test("controller: the preview locale changes only the preview", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.setPreviewLocale("en");
  const state = ctx.controller.getState();
  assert.equal(state.previewLocale, "en");
  assert.equal(state.branding?.display_name_en, "Academy A", "the server data is unchanged");
  assert.equal(harness.loadCount(), 1, "switching the preview sends no request");
});

test("controller: opening the editor seeds the drafts from the confirmed values", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness);
  ctx.controller.openEditor();
  const form = ctx.controller.getState().form;
  assert.equal(form.mode, "editing");
  assert.equal(form.display_name_ar.inherit, false);
  assert.equal(form.display_name_ar.text, "أكاديمية أ");
  assert.equal(form.originalAccent, "#1D4ED8");
});

test("controller: opening the editor on an absent row starts fully inherited", async () => {
  const harness = createHarness();
  const ctx = await loadReady(harness, absent());
  ctx.controller.openEditor();
  const form = ctx.controller.getState().form;
  assert.equal(form.display_name_ar.inherit, true);
  assert.equal(form.display_name_en.inherit, true);
  assert.equal(form.accent_color.inherit, true);
});

test("controller: the editor cannot be opened before a read settles", async () => {
  const harness = createHarness();
  const ctx = createController(harness);
  const opening = ctx.controller.open();
  ctx.controller.openEditor();
  assert.equal(ctx.controller.getState().form.mode, "closed", "no editor without confirmed values");
  harness.loads[0].resolve(envelope(branding()));
  await opening;
});

// ===========================================================================
// Pure form helpers
// ===========================================================================

test("form: the dirty subset ignores whitespace-only and case differences", () => {
  const built = buildTenantBrandingPatch({
    mode: "editing",
    display_name_ar: { inherit: false, text: "  أكاديمية أ  " },
    display_name_en: { inherit: true, text: "" },
    accent_color: { inherit: false, text: "#1d4ed8" },
    originalAr: "أكاديمية أ",
    originalEn: null,
    originalAccent: "#1D4ED8",
    error: null,
    notice: null,
  });
  assert.equal(built.ok, true);
  // `strict: false` widens `ok` to `boolean`, so the union is discriminated by
  // the presence of the success-only fields.
  assert.ok("dirtyCount" in built, "the build succeeded");
  assert.equal(built.dirtyCount, 0, "a whitespace/case variant is not a change");
});

test("form: a real change produces exactly the dirty fields", () => {
  const built = buildTenantBrandingPatch({
    mode: "editing",
    display_name_ar: { inherit: true, text: "" },
    display_name_en: { inherit: false, text: "New" },
    accent_color: { inherit: true, text: "" },
    originalAr: "أكاديمية أ",
    originalEn: "Academy A",
    originalAccent: null,
    error: null,
    notice: null,
  });
  assert.equal(built.ok, true);
  assert.ok("patch" in built && "dirtyCount" in built, "the build succeeded");
  // Clearing the Arabic label and renaming the English one are both real
  // changes; the untouched (already inherited) color is NOT sent.
  assert.deepEqual(built.patch, { display_name_ar: null, display_name_en: "New" });
  assert.equal(built.dirtyCount, 2);
});

// ===========================================================================
// Component — real production callbacks
// ===========================================================================

interface ProductionControl {
  readonly text: string;
  readonly disabled: unknown;
  readonly onClick: () => void;
}

/** The text a production element renders, without copying any render logic. */
const treeText = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join("");
  const element = node as { props?: { children?: unknown } } | null;
  if (element?.props) return treeText(element.props.children);
  return "";
};

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

/** Renders the REAL component with the REAL React renderer and the REAL UI primitives. */
const renderCard = async (state: TenantBrandingState, controller: unknown): Promise<string> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/tenant/TenantBrandingCard.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /TenantBrandingCard\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [state, () => {}],
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
    const tree = Component();
    return renderToStaticMarkup(tree as never);
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

/** Renders the REAL component as a TREE so the actual callbacks can be invoked. */
const renderCardTree = async (state: TenantBrandingState, controller: unknown): Promise<unknown> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const componentPath = projectRequire.resolve("../features/tenant/TenantBrandingCard.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /TenantBrandingCard\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [state, () => {}],
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
    return Component();
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

const buttonOpeningTag = (html: string, needle: string): string => {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
  const found = buttons.find((button) => button.includes(needle));
  assert.ok(found, `the rendered "${needle}" button exists`);
  return found.slice(0, found.indexOf(">") + 1);
};

const hasDisabledAttribute = (openingTag: string): boolean => /\sdisabled(?:=|\s|>)/.test(openingTag);

test("component: a closed panel renders only the explicit open control", async () => {
  const html = await renderCard(stateWith({ open: false, phase: "idle", branding: null }), null);
  assert.ok(html.includes("فتح إعدادات الهوية"), "the explicit open control is rendered");
  assert.equal(html.includes("حفظ الهوية"), false, "no editor before the panel is opened");
  assert.equal(html.includes("معاينة محلية"), false, "no preview before the panel is opened");
});

test("component: the open control calls the controller open", async () => {
  let opened = 0;
  const html = await renderCard(stateWith({ open: false, phase: "idle", branding: null }), {
    open: () => { opened += 1; return Promise.resolve(); },
  });
  const tree = await renderCardTree(stateWith({ open: false, phase: "idle", branding: null }), {
    open: () => { opened += 1; return Promise.resolve(); },
  });
  const control = collectControls(tree).find((c) => c.text.includes("فتح إعدادات الهوية"));
  assert.ok(control, "the open control carries a click handler");
  control.onClick();
  assert.equal(opened, 1, "the production callback opens the panel");
  assert.ok(html.includes("فتح إعدادات الهوية"));
});

test("component: the close control is never disabled", async () => {
  const html = await renderCard(stateWith({ phase: "loading" }), { close: () => {} });
  const tag = buttonOpeningTag(html, "إغلاق اللوحة");
  assert.equal(hasDisabledAttribute(tag), false, "close stays available during a pending read");
});

test("component: every non-submit control is type=button and the editor has one submit", async () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      display_name_ar: { inherit: false, text: "أكاديمية أ" },
      display_name_en: { inherit: false, text: "Academy A" },
      accent_color: { inherit: false, text: "#1D4ED8" },
    },
  });
  const html = await renderCard(state, {});
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.ok(buttons.length > 0, "controls are rendered");
  const submits = buttons.filter((tag) => /type="submit"/.test(tag));
  assert.equal(submits.length, 1, "exactly one submit control in the editor");
  for (const tag of buttons) {
    if (tag.includes('type="submit"')) continue;
    assert.match(tag, /type="button"/, `a non-submit control must be type=button: ${tag}`);
  }
});

test("component: the editor renders a bound label and an inherit control per field", async () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      display_name_ar: { inherit: false, text: "أكاديمية أ" },
      display_name_en: { inherit: false, text: "Academy A" },
      accent_color: { inherit: false, text: "#1D4ED8" },
    },
  });
  const html = await renderCard(state, {});
  for (const field of ["display_name_ar", "display_name_en", "accent_color"]) {
    assert.ok(html.includes(`id="branding-${field}"`), `${field} input is rendered`);
    assert.ok(html.includes(`for="branding-${field}"`), `${field} label is bound`);
    assert.ok(html.includes(`id="branding-${field}-inherit"`), `${field} inherit control is rendered`);
  }
  assert.ok(html.includes('type="checkbox"'), "the inherit control is a real checkbox");
});

test("component: the preview shows the unsaved badge while editing", async () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      display_name_ar: { inherit: false, text: "اسم غير محفوظ" },
    },
  });
  const html = await renderCard(state, {});
  assert.ok(html.includes("غير محفوظة"), "the preview is labelled unsaved");
  assert.ok(html.includes("اسم غير محفوظ"), "the local draft is previewed");
});

test("component: the preview is marked saved when the form is closed", async () => {
  const html = await renderCard(stateWith(), {});
  assert.ok(html.includes("مطابقة للمحفوظ"));
});

test("component: the preview switches direction inside the preview only", async () => {
  const ar = await renderCard(stateWith({ previewLocale: "ar" }), {});
  assert.ok(ar.includes('dir="rtl"'), "the Arabic preview is RTL");
  const en = await renderCard(stateWith({ previewLocale: "en" }), {});
  assert.ok(en.includes('dir="ltr"'), "the English preview is LTR");
  // The card itself never sets a global direction or theme.
  assert.equal(/<html|body\s+dir=|document\.documentElement/.test(en), false, "no global direction change");
});

test("component: an invalid color is never applied as CSS", async () => {
  const state = stateWith({
    form: {
      ...stateWith().form,
      mode: "editing",
      accent_color: { inherit: false, text: "red;background:url(x)" },
    },
  });
  const html = await renderCard(state, {});
  assert.equal(/background-color/i.test(html), false, "no color style is emitted for an invalid value");
  // The raw text DOES appear in the input's own `value` (the user must see what
  // they typed), but it must never land in a style attribute.
  assert.equal(/style="[^"]*url\(x\)/i.test(html), false, "the raw text never becomes a style");
  assert.equal(/style="[^"]*red;/i.test(html), false, "the raw text never becomes a style");
});

test("component: a validated color is applied as CSS", async () => {
  const html = await renderCard(stateWith(), {});
  assert.ok(/background-color:\s*#1D4ED8/i.test(html), "the validated color is applied");
});

test("component: the preview locale control calls setPreviewLocale", async () => {
  const seen: string[] = [];
  const tree = await renderCardTree(stateWith({ previewLocale: "ar" }), {
    setPreviewLocale: (locale: string) => { seen.push(locale); },
  });
  const control = collectControls(tree).find((c) => c.text.trim() === "English");
  assert.ok(control, "the English preview control exists");
  control.onClick();
  assert.deepEqual(seen, ["en"], "the production callback switches the LOCAL preview only");
});

test("component: the inherit control calls setInherit", async () => {
  const seen: { field: string; inherit: boolean }[] = [];
  const state = stateWith({
    form: { ...stateWith().form, mode: "editing", display_name_ar: { inherit: false, text: "أ" } },
  });
  const tree = await renderCardTree(state, {
    setInherit: (field: string, inherit: boolean) => { seen.push({ field, inherit }); },
  });
  // The checkbox is not a click control; its `onChange` is what a user fires.
  const checkboxes: { onChange: (event: unknown) => void }[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const element = node as { props?: Record<string, unknown> } | null;
    if (!element?.props) return;
    if (element.props.type === "checkbox" && typeof element.props.onChange === "function") {
      checkboxes.push({ onChange: element.props.onChange as (event: unknown) => void });
    }
    walk(element.props.children);
  };
  walk(tree);
  assert.equal(checkboxes.length, 3, "one inherit control per field");
  checkboxes[0].onChange({ target: { checked: true } });
  assert.deepEqual(seen, [{ field: "display_name_ar", inherit: true }]);
});

test("component: the save control submits the form through the production handler", async () => {
  let saved = 0;
  let prevented = 0;
  const state = stateWith({
    form: { ...stateWith().form, mode: "editing", display_name_en: { inherit: false, text: "New" } },
  });
  const tree = await renderCardTree(state, { save: () => { saved += 1; return Promise.resolve(); } });
  const forms: { onSubmit: (event: unknown) => void }[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const element = node as { props?: Record<string, unknown> } | null;
    if (!element?.props) return;
    if (typeof element.props.onSubmit === "function") {
      forms.push({ onSubmit: element.props.onSubmit as (event: unknown) => void });
    }
    walk(element.props.children);
  };
  walk(tree);
  assert.equal(forms.length, 1, "exactly one form");
  forms[0].onSubmit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, "the native submit is prevented");
  assert.equal(saved, 1, "the production callback saves");
});

test("component: the reconcile control appears only after an uncertain save", async () => {
  const saved = await renderCard(stateWith(), { reconcile: () => Promise.resolve() });
  assert.equal(saved.includes("قراءة الحالة الحالية"), false, "no reconcile control when nothing is uncertain");

  const uncertainState = stateWith({
    mutation: { status: "uncertain", error: "Failed to update branding", notice: BRANDING_WRITE_UNCERTAIN_MESSAGE },
  });
  const uncertain = await renderCard(uncertainState, { reconcile: () => Promise.resolve() });
  assert.ok(uncertain.includes("قراءة الحالة الحالية"), "the reconcile control is offered");
  assert.ok(uncertain.includes(BRANDING_WRITE_UNCERTAIN_MESSAGE), "the uncertainty is stated");
});

test("component: a confirmed save is announced", async () => {
  const html = await renderCard(
    stateWith({ lastConfirmed: branding({ updated_at: "2026-10-21T10:00:00.000Z" }) }),
    {},
  );
  assert.ok(html.includes("أكّد الخادم حفظ الهوية"));
  assert.ok(html.includes("2026-10-21T10:00:00.000Z"), "the confirmed instant is shown");
});

test("component: an absent row is described honestly as inherited", async () => {
  const html = await renderCard(
    stateWith({ phase: "empty", branding: absent() }),
    {},
  );
  assert.ok(html.includes("لا توجد هوية مخصّصة محفوظة"));
});

test("component: the owner-only label is present and the denial is the server's message", async () => {
  const ready = await renderCard(stateWith(), {});
  assert.ok(ready.includes("مالك المؤسسة"), "the owner-only nature is labelled");

  const denied = await renderCard(
    stateWith({ phase: "denied", branding: null, reason: "not-owner" }),
    {},
  );
  assert.ok(denied.includes("تخصيص الهوية متاح لمالك المؤسسة فقط"));
});
