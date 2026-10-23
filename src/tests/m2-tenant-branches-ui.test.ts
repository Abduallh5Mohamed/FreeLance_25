/**
 * M2-07 tenant branch metadata UI — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/tenant/branches.ts` that
 * `src/features/tenant/BranchManager.tsx` mounts, plus the REAL additive
 * transport (`listMyTenantBranches`, `createMyTenantBranch`,
 * `updateMyTenantBranch`) in `src/lib/api-http.ts` — both imported unchanged.
 * Fully isolated: no DB, no network, no browser, no live services, no
 * dependency install. The transport seam drives the REAL `request` with a
 * stubbed global fetch/localStorage/window; the feature seam drives the REAL
 * controller with an injected fake transport, principal reader and session
 * notifier.
 *
 * Behaviours pinned (M2-07 contract):
 *  - canonical authenticated request: the exact `/tenants/me/branches` path
 *    family, the bearer header, the bounded `limit` and the encoded cursor,
 *    and NO client tenant selector in header/query/body;
 *  - the strict request bodies: `{ name }` for a create, `{ name }` or
 *    `{ status }` (never both, never anything else) for an update;
 *  - the documented transport error behavior: the server `error` message is
 *    thrown WITHOUT the HTTP status and WITHOUT the `code`, so only documented
 *    messages classify an outcome; the canonical BILLING_ONLY identity event
 *    and the suspension teardown keep working;
 *  - runtime DTO validation: the exact five-field branch DTO and the exact
 *    `{ branches, next_cursor }` / `{ branch }` envelopes are required — an
 *    extra key, a wrong status or a missing field is a malformed response,
 *    never a fabricated branch;
 *  - the owner-only denial is distinguished from the billing-only denial, from
 *    the suspension and from the missing workspace, using only documented
 *    transported messages;
 *  - the panel loads ONLY after an explicit open, exactly one bounded 25-row
 *    page at a time, with next/first paging and no accumulated pages;
 *  - one synchronous mutation flight, no duplicate create/save/status write;
 *  - a PATCH response for another branch id is NOT a success for this branch;
 *  - an unknown write outcome stays explicitly uncertain: no automatic write
 *    retry, the draft is preserved, and a deliberate list read is offered and
 *    is never treated as proof of the write;
 *  - reversed/superseded replies never commit; the canonical principal is
 *    observed at entry AND at completion on the success and the failure path,
 *    and a RETIRED reply observes it BEFORE it settles any visible state;
 *  - a session event, a close and a dispose clear the private rows and drafts
 *    and drop every in-flight reply; an old `finally` never releases a newer
 *    operation's latch.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative). The
 * accepted migration FILE is not applied, so no runtime branch rollout is
 * claimed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignInstructorBranch,
  createMyTenantBranch,
  listMyTenantBranches,
  listMyTenantInstructorMemberships,
  updateMyTenantBranch,
  type TenantBranch,
  type TenantBranchEnvelope,
  type TenantBranchListEnvelope,
  type TenantInstructorMembership,
  type TenantInstructorMembershipEnvelope,
  type TenantInstructorMembershipListEnvelope,
} from "../lib/api-http";
import {
  BRANCH_NAME_INVALID_MESSAGE,
  BRANCH_RECONCILED_MESSAGE,
  BRANCH_WRITE_UNCERTAIN_MESSAGE,
  classifyTenantBranchFailure,
  classifyTenantBranchWriteFailure,
  createTenantBranchController,
  isTenantBranchAuthorizationLoss,
  parseTenantBranch,
  parseTenantBranchEnvelope,
  parseTenantBranchList,
  MALFORMED_BRANCH_MESSAGE,
  type TenantBranchApi,
  type TenantBranchState,
  INSTRUCTOR_ASSIGNMENT_RECONCILED_MESSAGE,
  INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE,
  INSTRUCTOR_LIST_MALFORMED_MESSAGE,
  INSTRUCTOR_SELECTION_INVALID_MESSAGE,
  classifyTenantInstructorListFailure,
  classifyTenantInstructorWriteFailure,
  parseTenantInstructorMembership,
  parseTenantInstructorMembershipEnvelope,
  parseTenantInstructorMembershipList,
} from "../features/tenant/branches";
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

const BRANCH_ID = "3f7c1c6e-6f1a-4a0a-9a2f-0d1c2b3a4e5f";

const branch = (overrides: Partial<TenantBranch> = {}): TenantBranch => ({
  id: BRANCH_ID,
  name: "فرع المعادي",
  status: "active",
  created_at: "2026-10-19T10:00:00.000Z",
  updated_at: "2026-10-19T10:00:00.000Z",
  ...overrides,
});

const listEnvelope = (
  branches: TenantBranch[],
  nextCursor: string | null = null,
): TenantBranchListEnvelope => ({ branches, next_cursor: nextCursor });

const writeEnvelope = (value: TenantBranch): TenantBranchEnvelope => ({ branch: value });

/** The controller harness: every transport call is a deferred the test settles. */
interface Harness {
  api: TenantBranchApi;
  listCalls: { limit: number; cursor: string | null }[];
  lists: Deferred<TenantBranchListEnvelope>[];
  creates: Deferred<TenantBranchEnvelope>[];
  createNames: string[];
  updateCalls: { branchId: string; update: { name?: string; status?: string } }[];
  updates: Deferred<TenantBranchEnvelope>[];
  // M2-B12 — the instructor branch-assignment section.
  instructorListCalls: { limit: number; cursor: string | null }[];
  instructorLists: Deferred<TenantInstructorMembershipListEnvelope>[];
  assignCalls: { membershipId: string; branchId: string | null }[];
  assigns: Deferred<TenantInstructorMembershipEnvelope>[];
}

const createHarness = (): Harness => {
  const listCalls: { limit: number; cursor: string | null }[] = [];
  const lists: Deferred<TenantBranchListEnvelope>[] = [];
  const creates: Deferred<TenantBranchEnvelope>[] = [];
  const createNames: string[] = [];
  const updateCalls: { branchId: string; update: { name?: string; status?: string } }[] = [];
  const updates: Deferred<TenantBranchEnvelope>[] = [];
  const instructorListCalls: { limit: number; cursor: string | null }[] = [];
  const instructorLists: Deferred<TenantInstructorMembershipListEnvelope>[] = [];
  const assignCalls: { membershipId: string; branchId: string | null }[] = [];
  const assigns: Deferred<TenantInstructorMembershipEnvelope>[] = [];
  return {
    listCalls,
    lists,
    creates,
    createNames,
    updateCalls,
    updates,
    instructorListCalls,
    instructorLists,
    assignCalls,
    assigns,
    api: {
      listBranches: (params) => {
        listCalls.push({ limit: params.limit, cursor: params.cursor });
        const d = deferred<TenantBranchListEnvelope>();
        lists.push(d);
        return d.promise;
      },
      createBranch: (name) => {
        createNames.push(name);
        const d = deferred<TenantBranchEnvelope>();
        creates.push(d);
        return d.promise;
      },
      updateBranch: (branchId, update) => {
        updateCalls.push({ branchId, update: { ...update } });
        const d = deferred<TenantBranchEnvelope>();
        updates.push(d);
        return d.promise;
      },
      listInstructorMemberships: (params) => {
        instructorListCalls.push({ limit: params.limit, cursor: params.cursor });
        const d = deferred<TenantInstructorMembershipListEnvelope>();
        instructorLists.push(d);
        return d.promise;
      },
      assignInstructorBranch: (membershipId, branchId) => {
        assignCalls.push({ membershipId, branchId });
        const d = deferred<TenantInstructorMembershipEnvelope>();
        assigns.push(d);
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

test("transport: canonical authenticated GET of the bounded branch list", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([branch()]) }));

  const body = await listMyTenantBranches();

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, "/api/tenants/me/branches?limit=25");
  assert.equal(env.calls[0].init.method, undefined, "a read: no explicit method override");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    Object.keys(headers).filter((key) => /tenant|scope|workspace|x-/i.test(key)),
    [],
    "no client tenant selector header",
  );
  assert.equal(/tenant|workspace/i.test(env.calls[0].url.split("?")[1] ?? ""), false, "no tenant selector in the query");
  assert.equal(body.branches.length, 1);
  assert.equal(body.next_cursor, null);
});

test("transport: the opaque cursor is sent as an encoded query parameter", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([], "abc") }));

  await listMyTenantBranches({ cursor: "a+b/c=" });

  assert.equal(env.calls[0].url, "/api/tenants/me/branches?limit=25&cursor=a%2Bb%2Fc%3D");
  assert.equal(env.calls[0].url.includes("tenant_id"), false, "no tenant selector");
});

test("transport: a missing token fails closed - no Authorization header is sent", async (t) => {
  const env = installTransportEnvironment(null);
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([]) }));

  await listMyTenantBranches();

  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("transport: the create body is the strict single field { name }", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 201, body: writeEnvelope(branch()) }));

  await createMyTenantBranch("فرع المعادي");

  assert.equal(env.calls[0].url, "/api/tenants/me/branches");
  assert.equal(env.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { name: "فرع المعادي" });
});

test("transport: the update body carries only name or only status", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope(branch()) }));

  await updateMyTenantBranch(BRANCH_ID, { name: "فرع جديد" });
  await updateMyTenantBranch(BRANCH_ID, { status: "archived" });

  assert.equal(env.calls[0].url, `/api/tenants/me/branches/${BRANCH_ID}`);
  assert.equal(env.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { name: "فرع جديد" });
  assert.deepEqual(JSON.parse(String(env.calls[1].init.body)), { status: "archived" });
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
    () => createMyTenantBranch("فرع"),
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
      error: "Branch management is not available while the account is limited to billing and support",
      code: "BILLING_ONLY",
    },
  }));

  const kinds: string[] = [];
  const unsubscribe = subscribeSessionChange((event) => { kinds.push(event.kind); });
  t.after(unsubscribe);

  await assert.rejects(() => listMyTenantBranches(), /limited to billing and support/);

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

  await assert.rejects(() => listMyTenantBranches(), /administratively suspended/);

  assert.deepEqual(kinds, ["logout"], "the shared transport still tears the session down");
  assert.equal(env.store.has("authToken"), false, "the token is cleared by the shared transport");
  assert.deepEqual(env.assignedUrls, ["/auth"]);
});

// ===========================================================================
// Runtime DTO validation
// ===========================================================================

test("dto: the exact five-field branch DTO is accepted", () => {
  const parsed = parseTenantBranch(branch());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.branch, branch());
});

test("dto: a malformed branch is refused - never a fabricated row", () => {
  assert.equal(parseTenantBranch(null).ok, false);
  assert.equal(parseTenantBranch([]).ok, false);
  assert.equal(parseTenantBranch("branch").ok, false);
  assert.equal(parseTenantBranch({ ...branch(), status: "deleted" }).ok, false);
  assert.equal(parseTenantBranch({ ...branch(), tenant_id: "tenant-1" }).ok, false);
  assert.equal(parseTenantBranch({ ...branch(), id: "" }).ok, false);
  assert.equal(parseTenantBranch({ ...branch(), name: "   " }).ok, false);
  const { updated_at: _omitted, ...withoutTimestamp } = branch();
  assert.equal(parseTenantBranch(withoutTimestamp).ok, false);
});

test("dto: the list envelope requires exactly branches and next_cursor", () => {
  const parsed = parseTenantBranchList(listEnvelope([branch()], "cursor-1"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.branches.length, 1);
  assert.equal(parsed.nextCursor, "cursor-1");

  assert.equal(parseTenantBranchList({ branches: [] }).ok, false, "a missing cursor is malformed");
  assert.equal(parseTenantBranchList({ branches: [], next_cursor: 5 }).ok, false);
  assert.equal(parseTenantBranchList({ branches: [], next_cursor: null, extra: 1 }).ok, false);
  assert.equal(parseTenantBranchList({ branches: [branch(), { bad: true }], next_cursor: null }).ok, false);
});

test("dto: the write envelope requires exactly one branch", () => {
  assert.equal(parseTenantBranchEnvelope(writeEnvelope(branch())).ok, true);
  assert.equal(parseTenantBranchEnvelope({ branch: branch(), extra: 1 }).ok, false);
  assert.equal(parseTenantBranchEnvelope({ branches: [] }).ok, false);
  assert.equal(parseTenantBranchEnvelope(null).ok, false);
});

test("classification: the documented messages map to honest outcomes", () => {
  const forbidden = classifyTenantBranchFailure(new Error("Forbidden"));
  assert.equal(forbidden.phase, "denied");
  assert.equal(forbidden.reason, "not-owner");

  const billing = classifyTenantBranchFailure(
    new Error("Branch management is not available while the account is limited to billing and support"),
  );
  assert.equal(billing.phase, "denied");
  assert.equal(billing.reason, "billing-only");

  const expired = classifyTenantBranchFailure(new Error("Token expired"));
  assert.equal(expired.phase, "unauthorized");
  assert.equal(expired.reason, "session");

  const missing = classifyTenantBranchFailure(new Error("Tenant membership not found"));
  assert.equal(missing.phase, "no-workspace");

  const server = classifyTenantBranchFailure(new Error("Failed to list branches"));
  assert.equal(server.phase, "error");
  assert.equal(server.reason, "server");

  const unknown = classifyTenantBranchFailure(new Error("Something else entirely"));
  assert.equal(unknown.phase, "error", "an unknown message is never a permission outcome");
  assert.equal(unknown.reason, "unknown");
});

test("classification: a discarded code alone is never a permission outcome", () => {
  const failure = classifyTenantBranchFailure(new Error("Forbidden"));
  assert.equal(failure.reason, "not-owner");
  const write = classifyTenantBranchWriteFailure(new Error("BILLING_ONLY"));
  assert.equal(write.kind, "uncertain", "a code that never arrives as a message proves nothing");
});

// ===========================================================================
// Controller — the REAL production controller
// ===========================================================================

test("feature: no branch request happens before the panel is explicitly opened", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  await controller.waitForIdle();
  assert.equal(harness.listCalls.length, 0, "a viewer who never opens the panel issues no request");

  const opened = controller.open();
  await flush();
  assert.equal(harness.listCalls.length, 1, "the explicit open issues exactly one bounded read");
  assert.deepEqual(harness.listCalls[0], { limit: 25, cursor: null });

  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().rows.length, 1);
  assert.equal(controller.getState().rows[0].name, "فرع المعادي");
});

test("feature: a second open issues no second request", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  await controller.open();
  harness.lists[0].resolve(listEnvelope([]));
  await opened;
  await controller.waitForIdle();

  assert.equal(harness.listCalls.length, 1);
});

test("feature: the owner denial is shown as the server's own answer, not as a paid state", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  assert.equal(state.error, "Forbidden");
  assert.equal(state.rows.length, 0, "a denial never fabricates rows");
});

test("feature: the billing-only denial is distinguished from the owner denial", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].reject(
    new Error("Branch management is not available while the account is limited to billing and support"),
  );
  await opened;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "denied");
  assert.equal(controller.getState().reason, "billing-only");
});

test("feature: a malformed body is an error state, never a fabricated row", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve({ branches: [{ id: "x" }], next_cursor: null } as never);
  await opened;
  await controller.waitForIdle();

  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().error, MALFORMED_BRANCH_MESSAGE);
  assert.equal(controller.getState().rows.length, 0);
});

test("feature: paging holds one bounded page and uses the server cursor", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch({ id: "a" }), branch({ id: "b" })], "cursor-2"));
  await opened;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 2);
  assert.equal(controller.getState().nextCursor, "cursor-2");

  const next = controller.nextPage();
  await flush();
  assert.deepEqual(harness.listCalls[1], { limit: 25, cursor: "cursor-2" });
  harness.lists[1].resolve(listEnvelope([branch({ id: "c" })]));
  await next;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows.length, 1, "the page is replaced, never accumulated");
  assert.equal(controller.getState().rows[0].id, "c");
  assert.equal(controller.getState().hasPreviousPage, true);

  const first = controller.firstPage();
  await flush();
  assert.deepEqual(harness.listCalls[2], { limit: 25, cursor: null });
  harness.lists[2].resolve(listEnvelope([branch({ id: "a" })]));
  await first;
  await controller.waitForIdle();
  assert.equal(controller.getState().hasPreviousPage, false);
});

test("feature: a page without a next cursor issues no request at all", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()], null));
  await opened;
  await controller.waitForIdle();

  await controller.nextPage();
  await flush();
  assert.equal(harness.listCalls.length, 1, "no cursor means no request");
});

test("feature: a double-clicked refresh never reaches the transport twice", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  const dropped = controller.refresh();
  await flush();
  assert.equal(harness.listCalls.length, 1, "the synchronous latch rejects the duplicate");

  harness.lists[0].resolve(listEnvelope([branch()]));
  await Promise.all([opened, dropped]);
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
});

test("feature: a confirmed create uses the server DTO and is followed by one bounded refresh", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  controller.updateDraft("  فرع جديد  ");
  const created = controller.create();
  await flush();
  assert.equal(harness.creates.length, 1);
  assert.equal(harness.createNames[0], "فرع جديد", "the trimmed name is the only field sent");

  const confirmed = branch({ id: "new-branch", name: "فرع جديد" });
  harness.creates[0].resolve(writeEnvelope(confirmed));
  await flush();
  assert.equal(harness.listCalls.length, 2, "exactly one bounded refresh after the confirmed create");
  harness.lists[1].resolve(listEnvelope([confirmed]));
  await created;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.form.mode, "closed", "the confirmed create closes its own form");
  assert.equal(state.mutation.status, "idle");
  assert.equal(state.mutation.error, null);
  assert.equal(state.lastConfirmed?.id, "new-branch");
  assert.equal(state.rows.length, 1);
});

test("feature: a synchronous duplicate create reaches the transport once", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  controller.updateDraft("فرع");
  const first = controller.create();
  const dropped = controller.create();
  await flush();
  assert.equal(harness.creates.length, 1, "the second click never reaches the transport");

  harness.creates[0].resolve(writeEnvelope(branch({ name: "فرع" })));
  await flush();
  harness.lists[1].resolve(listEnvelope([branch({ name: "فرع" })]));
  await Promise.all([first, dropped]);
  await controller.waitForIdle();
  assert.equal(harness.creates.length, 1);
});

test("feature: an invalid name never reaches the transport and keeps the draft", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  controller.updateDraft("   ");
  await controller.create();
  await flush();

  assert.equal(harness.creates.length, 0, "the transport is never reached");
  assert.equal(controller.getState().form.error, BRANCH_NAME_INVALID_MESSAGE);
  assert.equal(controller.getState().form.draft, "   ", "the user's input is preserved");
});

test("feature: a confirmed rename updates the row with the server DTO and issues no extra read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("فرع جديد");
  const saved = controller.saveName();
  await flush();
  assert.equal(harness.updateCalls.length, 1);
  assert.deepEqual(harness.updateCalls[0], { branchId: BRANCH_ID, update: { name: "فرع جديد" } });

  harness.updates[0].resolve(writeEnvelope(branch({ name: "فرع جديد" })));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows[0].name, "فرع جديد");
  assert.equal(harness.listCalls.length, 1, "a confirmed rename needs no extra read");
});

test("feature: an archive sends only the status and updates the row", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  const archived = controller.setStatus(BRANCH_ID, "archived");
  await flush();
  assert.deepEqual(harness.updateCalls[0], { branchId: BRANCH_ID, update: { status: "archived" } });

  harness.updates[0].resolve(writeEnvelope(branch({ status: "archived" })));
  await archived;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows[0].status, "archived");
  assert.equal(harness.listCalls.length, 1);
});

test("feature: a PATCH response for another branch is uncertain and never committed", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("فرع جديد");
  const saved = controller.saveName();
  await flush();
  harness.updates[0].resolve(writeEnvelope(branch({ id: "another-branch", name: "فرع آخر" })));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.notice, BRANCH_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.rows[0].name, "فرع المعادي", "a foreign DTO never overwrites the row");
  assert.equal(state.form.draft, "فرع جديد", "the draft is preserved");
});

test("feature: the handler 500 is uncertain - no automatic write and no automatic read", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  controller.updateDraft("فرع");
  const created = controller.create();
  await flush();
  harness.creates[0].reject(new Error("Failed to create branch"));
  await created;
  await controller.waitForIdle();
  await flush();

  assert.equal(harness.creates.length, 1, "the write is never retried automatically");
  assert.equal(harness.listCalls.length, 1, "no automatic read either");
  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.error, "Failed to create branch");
  assert.equal(state.mutation.notice, BRANCH_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(state.form.draft, "فرع", "the draft is preserved for a deliberate retry");
});

test("feature: the deliberate reconciliation reads the current list and never proves the write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  controller.updateDraft("فرع");
  const created = controller.create();
  await flush();
  harness.creates[0].reject(new Error("Failed to create branch"));
  await created;
  await controller.waitForIdle();

  const reconciled = controller.reconcile();
  await flush();
  assert.equal(harness.listCalls.length, 2, "the deliberate reconciliation is exactly one read");
  harness.lists[1].resolve(listEnvelope([branch({ name: "فرع" })]));
  await reconciled;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "uncertain", "the write stays unproven");
  assert.equal(state.mutation.notice, BRANCH_RECONCILED_MESSAGE);
  assert.equal(harness.creates.length, 1, "no write was repeated");
});

test("feature: a denied write keeps the rows and the draft", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("فرع جديد");
  const saved = controller.saveName();
  await flush();
  harness.updates[0].reject(new Error("Forbidden"));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.mutation.status, "idle", "a definite denial is not an uncertain write");
  assert.equal(state.mutation.error, "Forbidden");
  assert.equal(state.rows.length, 1, "the read-authorized rows survive a denied write");
  assert.equal(state.form.draft, "فرع جديد", "the draft survives a denied write");
});

test("feature: a missing branch is a definite failure, not an uncertain write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("فرع جديد");
  const saved = controller.saveName();
  await flush();
  harness.updates[0].reject(new Error("Branch not found"));
  await saved;
  await controller.waitForIdle();

  assert.equal(controller.getState().mutation.status, "idle");
  assert.equal(controller.getState().mutation.error, "Branch not found");
  assert.equal(controller.getState().mutation.notice, null);
});

test("feature: a network failure is uncertain and never retries the write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
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
  controller.updateDraft("فرع");
  const created = controller.create();
  await flush();
  harness.creates[0].reject(new Error("network down"));
  await created;
  await controller.waitForIdle();
  await flush();

  assert.equal(harness.creates.length, 1);
  assert.equal(controller.getState().mutation.status, "uncertain");
});

test("feature: a reversed reply never commits over the newer page", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantBranchController({
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

  harness.lists[1].resolve(listEnvelope([branch({ id: "newer" })]));
  await flush();
  assert.equal(controller.getState().rows[0].id, "newer");

  harness.lists[0].resolve(listEnvelope([branch({ id: "older" })]));
  await first;
  await flush();
  assert.equal(controller.getState().rows[0].id, "newer", "the older reply is dropped, not merged");
});

test("feature: a retired read observes the principal before settling - silent logout, success path", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const first = controller.open();
  await flush();
  principal = "session:b";
  sink.fire();
  await flush();
  harness.lists[1].resolve(listEnvelope([branch({ id: "newer" })]));
  await flush();
  assert.equal(controller.getState().rows.length, 1);

  // A SILENT logout (no notifier) while the retired reply is on the wire.
  principal = null;
  harness.lists[0].resolve(listEnvelope([branch({ id: "older" })]));
  await first;
  await flush();

  assert.equal(controller.getState().rows.length, 0, "the retired reply cannot revive private rows");
  assert.equal(controller.getState().phase, "idle");
});

test("feature: a retired read observes the principal before settling - silent logout, failure path", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const first = controller.open();
  await flush();
  principal = "session:b";
  sink.fire();
  await flush();
  harness.lists[1].resolve(listEnvelope([branch({ id: "newer" })]));
  await flush();

  principal = null;
  harness.lists[0].reject(new Error("Failed to list branches"));
  await first;
  await flush();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the retired failure cannot revive private rows");
  assert.equal(state.phase, "idle");
  assert.equal(state.error, null);
});

test("feature: a silent principal change at completion clears the private rows", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  principal = null;
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  assert.equal(controller.getState().rows.length, 0);
  assert.equal(controller.getState().phase, "idle");
});

test("feature: a session event clears the rows and drafts and starts a fresh first page", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()], "cursor-2"));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("مسودة");
  assert.equal(controller.getState().form.draft, "مسودة");

  principal = "session:b";
  sink.fire();
  assert.equal(controller.getState().rows.length, 0, "the private rows are cleared");
  assert.equal(controller.getState().form.mode, "closed", "the private draft is cleared");
  await flush();
  assert.equal(harness.listCalls.length, 2);
  assert.deepEqual(harness.listCalls[1], { limit: 25, cursor: null }, "the new session starts at the first page");
});

test("feature: an old finally never releases a newer read's latch", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const first = controller.open();
  await flush();
  sink.fire();
  await flush();
  assert.equal(harness.listCalls.length, 2);

  // The first read is still on the wire; its `finally` must not free the
  // second read's latch.
  const dropped = controller.refresh();
  await flush();
  assert.equal(harness.listCalls.length, 2, "the newer read still owns the latch");

  harness.lists[1].resolve(listEnvelope([branch({ id: "newer" })]));
  await flush();
  // The retired reply arrives late and is dropped.
  harness.lists[0].resolve(listEnvelope([branch({ id: "older" })]));
  await Promise.all([first, dropped]);
  await controller.waitForIdle();
  assert.equal(controller.getState().rows[0].id, "newer");
});

test("feature: a superseded mutation reply never overwrites a newer confirmed write", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  let principal: string | null = "session:a";
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => principal,
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  // A rename is on the wire when the session changes.
  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("اسم session-a");
  const first = controller.saveName();
  await flush();
  assert.equal(harness.updates.length, 1);

  principal = "session:b";
  sink.fire();
  await flush();
  assert.equal(controller.getState().mutation.status, "idle", "the busy state settles truthfully");
  assert.equal(controller.getState().rows.length, 0, "the private rows are cleared");

  harness.lists[1].resolve(listEnvelope([branch()]));
  await flush();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("اسم session-b");
  const second = controller.saveName();
  await flush();
  assert.equal(harness.updates.length, 2);
  harness.updates[1].resolve(writeEnvelope(branch({ name: "اسم session-b" })));
  await second;
  await flush();
  assert.equal(controller.getState().rows[0].name, "اسم session-b");

  // The retired reply arrives late: it must not overwrite the newer confirmed
  // write and must not claim a success.
  harness.updates[0].resolve(writeEnvelope(branch({ name: "اسم session-a" })));
  await first;
  await flush();
  await controller.waitForIdle();

  assert.equal(controller.getState().rows[0].name, "اسم session-b", "the older reply is dropped");
  assert.equal(controller.getState().mutation.status, "idle");
});

test("feature: a cancelled form is not closed or rewritten by a late reply", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("اسم جديد");
  const saved = controller.saveName();
  await flush();

  // The user cancels the rename and opens the create form instead.
  controller.cancelForm();
  controller.openCreateForm();
  controller.updateDraft("فرع جديد");

  harness.updates[0].resolve(writeEnvelope(branch({ name: "اسم جديد" })));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.form.mode, "create", "the newer form is not closed by the late reply");
  assert.equal(state.form.draft, "فرع جديد", "the newer draft is not rewritten");
  assert.equal(state.rows[0].name, "اسم جديد", "the confirmed write is still applied to the row");
});

test("feature: close clears the private rows and retires the request", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();
  controller.openCreateForm();
  controller.updateDraft("مسودة");

  controller.close();
  assert.equal(controller.getState().open, false);
  assert.equal(controller.getState().rows.length, 0);
  assert.equal(controller.getState().form.mode, "closed");
  assert.equal(controller.getState().form.draft, "");
});

test("feature: dispose drops the in-flight reply and clears the private rows", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.dispose();
  assert.equal(controller.getState().rows.length, 0);
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().open, false);
});

// ===========================================================================
// The real component, rendered by the real React server renderer
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Renders the REAL `BranchManager` component with the REAL React server
 * renderer and the REAL shared UI primitives. Only the controller hook
 * snapshot is injected, so the markup comes from the production component
 * while no request, no browser and no live service is involved.
 *
 * The harness is Node-only: it supplies the classic-JSX `React` binding the
 * TSX file needs and restores the module loader and the global afterwards.
 */
const renderBranchManager = async (snapshot: TenantBranchState): Promise<string> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/tenant/BranchManager.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /BranchManager\.tsx$/.test(parent?.filename || "")) {
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
    const tree = Component();
    return renderToStaticMarkup(tree as never);
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
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

test("component: the status action is enabled after a definite conflict and disabled while the flight is real", async () => {
  const pending = deferred<TenantBranchEnvelope>();
  const controller = createTenantBranchController({
    readPrincipal: () => "session:a",
    listBranches: async () => listEnvelope([branch()]),
    updateBranch: () => pending.promise,
  });
  try {
    await controller.open();
    const flight = controller.setStatus(BRANCH_ID, "archived");
    await flush();

    // A REAL saving flight: the action is disabled, so a duplicate click
    // cannot start a second write.
    assert.equal(controller.getState().mutation.status, "saving");
    const savingTag = buttonOpeningTag(await renderBranchManager(controller.getState()), "أرشفة");
    assert.equal(hasDisabledAttribute(savingTag), true, "a real saving flight disables the action");

    pending.reject(new Error("Branch was modified concurrently"));
    await flight;
    await controller.waitForIdle();

    // The definite conflict: the row is NOT latched disabled, so a
    // deliberate retry is possible without an unrelated operation first.
    const afterConflict = controller.getState();
    assert.equal(afterConflict.mutation.status, "idle");
    assert.equal(afterConflict.mutation.error, "Branch was modified concurrently");
    const idleTag = buttonOpeningTag(await renderBranchManager(afterConflict), "أرشفة");
    assert.equal(
      hasDisabledAttribute(idleTag),
      false,
      "the deliberate retry is not disabled after a definite conflict",
    );
    assert.match(
      await renderBranchManager(afterConflict),
      /Branch was modified concurrently/,
      "the conflict message stays visible",
    );
  } finally {
    controller.dispose();
  }
});

test("feature: a duplicate status click while the flight is real reaches the transport once", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  const first = controller.setStatus(BRANCH_ID, "archived");
  await flush();
  const dropped = controller.setStatus(BRANCH_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the second click never reaches the transport");

  harness.updates[0].resolve(writeEnvelope(branch({ status: "archived" })));
  await Promise.all([first, dropped]);
  await controller.waitForIdle();
  assert.equal(harness.updateCalls.length, 1);
});

// ===========================================================================
// Correction (supervisor/161) — the response page bound, the read
// authorization loss and the deliberate status retry
// ===========================================================================

test("dto: a response page larger than the bound is malformed - it is refused before any row is copied", () => {
  const oversized = Array.from({ length: 26 }, (_, index) => branch({ id: `branch-${index}` }));
  assert.equal(
    parseTenantBranchList(listEnvelope(oversized)).ok,
    false,
    "26 rows exceed the 25-row response bound",
  );

  const legal = Array.from({ length: 25 }, (_, index) => branch({ id: `branch-${index}` }));
  const parsed = parseTenantBranchList(listEnvelope(legal));
  assert.equal(parsed.ok, true, "a legitimate 25-row page is accepted");
  if (parsed.ok) assert.equal(parsed.branches.length, 25);
});

test("feature: an oversized response page never reaches the held page", async (t) => {
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    readPrincipal: () => "session:a",
    listBranches: async () => listEnvelope(Array.from({ length: 26 }, (_, index) => branch({ id: `b-${index}` }))),
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  await controller.open();
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error, MALFORMED_BRANCH_MESSAGE, "an oversized page is a malformed response");
  assert.equal(state.rows.length, 0, "no row of an oversized page is ever held");
  assert.equal(state.nextCursor, null);
});

test("feature: a definite read authorization loss clears the private form, the draft and the confirmation", async (t) => {
  const cases = [
    ["Token expired", "unauthorized", "session"],
    ["Forbidden", "denied", "not-owner"],
  ] as const;

  for (const [message, phase, reason] of cases) {
    const harness = createHarness();
    const sink = createSessionSink();
    const controller = createTenantBranchController({
      ...harness.api,
      readPrincipal: () => "session:a",
      subscribeSession: sink.subscribeSession,
    });
    t.after(() => controller.dispose());

    const opened = controller.open();
    await flush();
    harness.lists[0].resolve(listEnvelope([branch()]));
    await opened;
    await controller.waitForIdle();

    // A server-confirmed write leaves a confirmation behind.
    const archived = controller.setStatus(BRANCH_ID, "archived");
    await flush();
    harness.updates[0].resolve(writeEnvelope(branch({ status: "archived" })));
    await archived;
    await controller.waitForIdle();
    assert.equal(controller.getState().lastConfirmed?.id, BRANCH_ID);

    // A private rename draft.
    controller.openRenameForm(BRANCH_ID);
    controller.updateDraft("مسودة خاصة");
    assert.equal(controller.getState().form.draft, "مسودة خاصة");

    // The next list read loses the authorization.
    const refresh = controller.refresh();
    await flush();
    harness.lists[1].reject(new Error(message));
    await refresh;
    await controller.waitForIdle();

    const state = controller.getState();
    assert.equal(state.rows.length, 0, "the private rows are cleared");
    assert.equal(state.form.mode, "closed", "the private form is closed, not rendered");
    assert.equal(state.form.draft, "", "the private draft is cleared");
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
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("مسودة تبقى");

  const refresh = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Failed to list branches"));
  await refresh;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.reason, "server");
  assert.equal(state.form.mode, "rename", "a retryable failure does not close the form");
  assert.equal(state.form.draft, "مسودة تبقى", "a retryable failure keeps the draft");
});

test("feature: the authorization-loss classifier separates the definite denials from the retryable failures", () => {
  assert.equal(isTenantBranchAuthorizationLoss("session"), true);
  assert.equal(isTenantBranchAuthorizationLoss("suspended"), true);
  assert.equal(isTenantBranchAuthorizationLoss("billing-only"), true);
  assert.equal(isTenantBranchAuthorizationLoss("not-owner"), true);
  assert.equal(isTenantBranchAuthorizationLoss("no-workspace"), true);
  assert.equal(isTenantBranchAuthorizationLoss("server"), false, "the handler 500 is not a permission loss");
  assert.equal(isTenantBranchAuthorizationLoss("unknown"), false, "an unknown message is not a permission loss");
});

test("feature: a late pending mutation never repopulates the state cleared by an authorization loss", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("مسودة");
  const saved = controller.saveName();
  await flush();
  assert.equal(harness.updateCalls.length, 1, "the write is on the wire");

  const refresh = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Token expired"));
  await refresh;
  assert.equal(controller.getState().rows.length, 0, "the loss cleared the private rows");
  assert.equal(controller.getState().form.mode, "closed", "the loss closed the private form");

  // The write confirms itself late: it must not revive the cleared state.
  harness.updates[0].resolve(writeEnvelope(branch({ name: "مسودة" })));
  await saved;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the late write does not restore the private rows");
  assert.equal(state.form.mode, "closed", "the late write does not reopen the private form");
  assert.equal(state.form.draft, "");
  assert.equal(state.lastConfirmed, null, "the late write claims no confirmation");
  assert.equal(state.mutation.status, "idle");
});

test("feature: an authorized retry after a denial works normally again", async (t) => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
  });
  t.after(() => controller.dispose());

  const opened = controller.open();
  await flush();
  harness.lists[0].resolve(listEnvelope([branch()]));
  await opened;
  await controller.waitForIdle();

  const denied = controller.refresh();
  await flush();
  harness.lists[1].reject(new Error("Forbidden"));
  await denied;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "denied");

  const retry = controller.refresh();
  await flush();
  harness.lists[2].resolve(listEnvelope([branch()]));
  await retry;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "ready", "the authorized retry restores the panel");
  assert.equal(state.rows.length, 1);
  controller.openRenameForm(BRANCH_ID);
  controller.updateDraft("اسم جديد");
  assert.equal(state.form.mode, "closed", "the form was closed while the access was lost");
  assert.equal(controller.getState().form.mode, "rename", "the form opens again after the authorized retry");
  assert.equal(controller.getState().form.draft, "اسم جديد");
});

// ===========================================================================
// M2-B12 — instructor branch-assignment organization metadata
// ===========================================================================

const MEMBERSHIP_ID = "a1111111-1111-4111-8111-111111111111";
const MEMBERSHIP_ID_2 = "a2222222-2222-4222-8222-222222222222";
const BRANCH_ID_2 = "a0000000-0000-4000-8000-000000000002";
const BRANCH_ID_ARCHIVED = "a0000000-0000-4000-8000-000000000003";

const membership = (
  overrides: Partial<TenantInstructorMembership> = {},
): TenantInstructorMembership => ({
  membership_id: MEMBERSHIP_ID,
  instructor_id: "instructor-1",
  instructor_name: "أحمد المدرب",
  branch_id: BRANCH_ID,
  branch_name: "فرع المعادي",
  ...overrides,
});

const membershipListEnvelope = (
  memberships: TenantInstructorMembership[],
  nextCursor: string | null = null,
): TenantInstructorMembershipListEnvelope => ({ memberships, next_cursor: nextCursor });

const membershipWriteEnvelope = (
  value: TenantInstructorMembership,
): TenantInstructorMembershipEnvelope => ({ membership: value });

const branch2 = branch({ id: BRANCH_ID_2, name: "فرع ثانٍ" });
const archivedBranch = branch({ id: BRANCH_ID_ARCHIVED, name: "فرع مؤرشف", status: "archived" });

/**
 * Opens the instructor section and settles BOTH reads it starts: the bounded
 * instructor page and — because the branch page was never read — the branch page
 * the selector needs.
 */
const openInstructorSection = async (
  controller: ReturnType<typeof createTenantBranchController>,
  harness: Harness,
  options: {
    branches?: TenantBranch[];
    memberships?: TenantInstructorMembership[];
    nextCursor?: string | null;
  } = {},
): Promise<void> => {
  const operation = controller.openInstructors();
  harness.lists[0].resolve(listEnvelope(options.branches ?? [branch(), branch2, archivedBranch]));
  harness.instructorLists[0].resolve(
    membershipListEnvelope(options.memberships ?? [membership()], options.nextCursor ?? null),
  );
  await operation;
  await controller.waitForIdle();
};

// ---------------------------------------------------------------------------
// Transport — the REAL adapters through the REAL request
// ---------------------------------------------------------------------------

test("M2-B12 transport: canonical authenticated GET of the bounded instructor page", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: membershipListEnvelope([membership()]) }));

  const body = await listMyTenantInstructorMemberships();

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, "/api/tenants/me/instructor-memberships?limit=25");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
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
  assert.equal(body.memberships.length, 1);
  assert.equal(body.next_cursor, null);
});

test("M2-B12 transport: the opaque instructor cursor is an encoded query parameter", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: membershipListEnvelope([], "abc") }));

  await listMyTenantInstructorMemberships({ cursor: "a+b/c=" });

  assert.equal(
    env.calls[0].url,
    "/api/tenants/me/instructor-memberships?limit=25&cursor=a%2Bb%2Fc%3D",
  );
  assert.equal(env.calls[0].url.includes("tenant_id"), false, "no tenant selector");
});

test("M2-B12 transport: the assignment body is the strict single field { branch_id }", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: membershipWriteEnvelope(membership()) }));

  await assignInstructorBranch(MEMBERSHIP_ID, BRANCH_ID);
  await assignInstructorBranch(MEMBERSHIP_ID, null);

  assert.equal(env.calls[0].url, `/api/tenants/me/instructor-memberships/${MEMBERSHIP_ID}`);
  assert.equal(env.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { branch_id: BRANCH_ID });
  assert.deepEqual(
    JSON.parse(String(env.calls[1].init.body)),
    { branch_id: null },
    "a clear is an explicit null, never an omission",
  );
});

test("M2-B12 transport: the assignment error arrives as its message only", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({
    ok: false,
    status: 404,
    body: { error: "Branch not found", code: "SOMETHING" },
  }));

  await assert.rejects(
    () => assignInstructorBranch(MEMBERSHIP_ID, BRANCH_ID),
    (error: Error) => {
      assert.equal(error.message, "Branch not found");
      assert.equal(/404/.test(error.message), false, "the discarded status is not invented");
      assert.equal(/SOMETHING/.test(error.message), false, "the discarded code is not invented");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Runtime DTO validation
// ---------------------------------------------------------------------------

test("M2-B12 parse: the canonical five-field record is accepted and nothing else", () => {
  const parsed = parseTenantInstructorMembership(membership());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.membership, membership());
    assert.deepEqual(Object.keys(parsed.membership).sort(), [
      "branch_id",
      "branch_name",
      "instructor_id",
      "instructor_name",
      "membership_id",
    ]);
  }

  const rejected: unknown[] = [
    null,
    [],
    "membership",
    {},
    membership({ membership_id: "" }),
    membership({ instructor_id: "" }),
    { ...membership(), instructor_name: 5 },
    { ...membership(), branch_id: 5 },
    { ...membership(), branch_id: null },
    { ...membership(), branch_name: null },
    { ...membership(), branch_name: "" },
    { ...membership(), extra: 1 },
    { ...membership(), tenant_id: "tenant-a" },
  ];
  for (const body of rejected) {
    assert.equal(parseTenantInstructorMembership(body).ok, false, `${JSON.stringify(body)} must be rejected`);
  }

  // The two documented shapes are exactly "recorded" and "not recorded".
  assert.equal(parseTenantInstructorMembership(membership({ branch_id: null, branch_name: null })).ok, true);
});

test("M2-B12 parse: the list envelope is exact and the response page is bounded", () => {
  assert.equal(parseTenantInstructorMembershipList(membershipListEnvelope([membership()])).ok, true);
  assert.equal(
    parseTenantInstructorMembershipList(membershipListEnvelope([], "next")).ok,
    true,
  );

  const rejected: unknown[] = [
    null,
    [],
    {},
    { memberships: [] },
    { memberships: [], next_cursor: null, extra: 1 },
    { memberships: "nope", next_cursor: null },
    { memberships: [], next_cursor: 5 },
    { memberships: [membership({ branch_id: null })], next_cursor: null },
  ];
  for (const body of rejected) {
    assert.equal(parseTenantInstructorMembershipList(body).ok, false, `${JSON.stringify(body)} must be rejected`);
  }

  // The page bound is enforced on the RESPONSE, before any row is copied.
  const oversized = Array.from({ length: 26 }, (_, index) => membership({
    membership_id: `a${String(index).padStart(7, "0")}-1111-4111-8111-111111111111`,
  }));
  assert.equal(parseTenantInstructorMembershipList(membershipListEnvelope(oversized)).ok, false);
});

test("M2-B12 parse: the write envelope requires exactly { membership }", () => {
  assert.equal(parseTenantInstructorMembershipEnvelope(membershipWriteEnvelope(membership())).ok, true);
  for (const body of [
    null,
    membership(),
    {},
    { membership: membership(), extra: 1 },
    { membership: membership({ membership_id: "" }) },
  ]) {
    assert.equal(
      parseTenantInstructorMembershipEnvelope(body).ok,
      false,
      `${JSON.stringify(body)} must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Controller — bounded list, explicit selection, explicit save/clear
// ---------------------------------------------------------------------------

test("M2-B12 controller: opening the section reads one bounded page plus the branch page it needs", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);

  await openInstructorSection(controller, harness);

  assert.deepEqual(harness.instructorListCalls, [{ limit: 25, cursor: null }]);
  assert.deepEqual(harness.listCalls, [{ limit: 25, cursor: null }], "the selector page is read exactly once");
  const state = controller.getState();
  assert.equal(state.instructors.open, true);
  assert.equal(state.instructors.phase, "ready");
  assert.equal(state.instructors.rows.length, 1);
  assert.equal(state.instructors.selection, null);
  assert.equal(state.instructors.mutation.status, "idle");
});

test("M2-B12 controller: nothing is requested before the section is opened", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await flush();
  assert.equal(harness.instructorListCalls.length, 0);
  assert.equal(harness.assignCalls.length, 0);
  assert.equal(controller.getState().instructors.open, false);
  assert.deepEqual(controller.getState().instructors.rows, []);
});

test("M2-B12 controller: a selection is bound to an active branch of the CURRENT page", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);

  // An ARCHIVED branch of the current page is refused locally.
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_ARCHIVED);
  assert.equal(controller.getState().instructors.selection, null);
  assert.equal(controller.getState().instructors.mutation.error, INSTRUCTOR_SELECTION_INVALID_MESSAGE);

  // A branch outside the current page is refused locally too.
  controller.selectInstructorBranch(MEMBERSHIP_ID, "ffffffff-0000-4000-8000-000000000000");
  assert.equal(controller.getState().instructors.selection, null);

  // A membership outside the current page cannot be selected at all.
  controller.selectInstructorBranch(MEMBERSHIP_ID_2, BRANCH_ID_2);
  assert.equal(controller.getState().instructors.selection, null);

  // The active branch of the page is accepted, with no request.
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);
  assert.deepEqual(controller.getState().instructors.selection, {
    membershipId: MEMBERSHIP_ID,
    branchId: BRANCH_ID_2,
  });
  assert.equal(controller.getState().instructors.mutation.error, null);
  assert.equal(harness.assignCalls.length, 0);
});

test("M2-B12 controller: selecting the already-recorded branch clears the selection", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);

  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID);
  assert.equal(controller.getState().instructors.selection, null, "there is nothing to send");
  assert.equal(controller.getState().instructors.mutation.error, null);
});

test("M2-B12 controller: save without a selection is a local rejection and sends nothing", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);

  await controller.saveInstructorBranch();
  assert.equal(harness.assignCalls.length, 0);
  assert.equal(controller.getState().instructors.mutation.error, INSTRUCTOR_SELECTION_INVALID_MESSAGE);
});

test("M2-B12 controller: a confirmed save publishes the server DTO and consumes the selection", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);

  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);
  const saving = controller.saveInstructorBranch();
  await flush();

  assert.deepEqual(harness.assignCalls, [{ membershipId: MEMBERSHIP_ID, branchId: BRANCH_ID_2 }]);
  assert.equal(controller.getState().instructors.mutation.status, "saving");
  assert.equal(controller.getState().instructors.mutation.targetId, MEMBERSHIP_ID);

  harness.assigns[0].resolve(membershipWriteEnvelope(
    membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }),
  ));
  await saving;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.mutation.status, "idle");
  assert.equal(state.instructors.selection, null, "the confirmed write consumed the selection");
  assert.deepEqual(state.instructors.rows[0], membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }));
  assert.deepEqual(state.instructors.lastConfirmed, membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }));
});

test("M2-B12 controller: a double click never sends a second assignment", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const first = controller.saveInstructorBranch();
  const second = controller.saveInstructorBranch();
  await flush();

  assert.equal(harness.assignCalls.length, 1, "the single-flight latch blocks the duplicate");
  harness.assigns[0].resolve(membershipWriteEnvelope(membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" })));
  await Promise.all([first, second]);
  await controller.waitForIdle();
  assert.equal(harness.assignCalls.length, 1);
});

test("M2-B12 controller: the panel's single write latch is shared with branch writes", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const archiving = controller.setStatus(BRANCH_ID, "archived");
  await flush();
  assert.equal(harness.updateCalls.length, 1);

  const saving = controller.saveInstructorBranch();
  await flush();
  assert.equal(harness.assignCalls.length, 0, "one write of any kind is in flight at a time");

  harness.updates[0].resolve(writeEnvelope(branch({ status: "archived" })));
  await archiving;
  await controller.waitForIdle();

  // The explicit selection survived the unrelated write.
  assert.deepEqual(controller.getState().instructors.selection, {
    membershipId: MEMBERSHIP_ID,
    branchId: BRANCH_ID_2,
  });
  await saving;
});

test("M2-B12 controller: a DTO for another membership is not a success", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const saving = controller.saveInstructorBranch();
  await flush();
  harness.assigns[0].resolve(membershipWriteEnvelope(
    membership({ membership_id: MEMBERSHIP_ID_2, branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }),
  ));
  await saving;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.mutation.status, "uncertain");
  assert.equal(state.instructors.mutation.notice, INSTRUCTOR_ASSIGNMENT_UNCERTAIN_MESSAGE);
  assert.deepEqual(state.instructors.rows[0], membership(), "the row is never overwritten by a foreign DTO");
  assert.deepEqual(state.instructors.selection, {
    membershipId: MEMBERSHIP_ID,
    branchId: BRANCH_ID_2,
  }, "the selection is retained");
  assert.equal(state.instructors.lastConfirmed, null);
});

test("M2-B12 controller: an uncertain write keeps the selection and never claims success", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const saving = controller.saveInstructorBranch();
  await flush();
  harness.assigns[0].reject(new Error("Failed to assign instructor branch"));
  await saving;
  await controller.waitForIdle();

  let state = controller.getState();
  assert.equal(state.instructors.mutation.status, "uncertain");
  assert.equal(state.instructors.mutation.error, "Failed to assign instructor branch");
  assert.deepEqual(state.instructors.selection, {
    membershipId: MEMBERSHIP_ID,
    branchId: BRANCH_ID_2,
  });
  assert.equal(harness.assignCalls.length, 1, "nothing is retried automatically");

  // A deliberate reconciliation read is offered and never claims the write.
  const reconciling = controller.reconcileInstructors();
  await flush();
  harness.instructorLists[1].resolve(membershipListEnvelope([
    membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }),
  ]));
  await reconciling;
  await controller.waitForIdle();

  state = controller.getState();
  assert.equal(state.instructors.mutation.status, "uncertain", "the write stays uncertain");
  assert.equal(state.instructors.mutation.notice, INSTRUCTOR_ASSIGNMENT_RECONCILED_MESSAGE);
  assert.equal(state.instructors.rows[0].branch_id, BRANCH_ID_2, "the read shows the CURRENT state only");
});

test("M2-B12 controller: a definite target failure keeps the rows and the selection", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const saving = controller.saveInstructorBranch();
  await flush();
  harness.assigns[0].reject(new Error("Branch not found"));
  await saving;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.mutation.status, "idle", "a missing target is a definite, retryable outcome");
  assert.equal(state.instructors.mutation.error, "Branch not found");
  assert.equal(state.instructors.mutation.notice, null);
  assert.equal(state.instructors.rows.length, 1, "a missing target is not an authorization loss");
  assert.deepEqual(state.instructors.selection, {
    membershipId: MEMBERSHIP_ID,
    branchId: BRANCH_ID_2,
  });
  assert.equal(classifyTenantInstructorWriteFailure(new Error("Branch not found")).kind, "missing");
});

test("M2-B12 controller: clear sends an explicit null and publishes the cleared record", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);

  const clearing = controller.clearInstructorBranch(MEMBERSHIP_ID);
  await flush();
  assert.deepEqual(harness.assignCalls, [{ membershipId: MEMBERSHIP_ID, branchId: null }]);

  harness.assigns[0].resolve(membershipWriteEnvelope(
    membership({ branch_id: null, branch_name: null }),
  ));
  await clearing;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.rows[0].branch_id, null);
  assert.equal(state.instructors.rows[0].branch_name, null);
  assert.equal(state.instructors.mutation.status, "idle");
});

test("M2-B12 controller: clearing an already-empty record sends nothing", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness, {
    memberships: [membership({ branch_id: null, branch_name: null })],
  });

  await controller.clearInstructorBranch(MEMBERSHIP_ID);
  assert.equal(harness.assignCalls.length, 0, "there is no write to send");
  assert.equal(controller.getState().instructors.mutation.status, "idle");
});

test("M2-B12 controller: a superseded assignment reply never commits", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const saving = controller.saveInstructorBranch();
  await flush();
  // Closing the section retires the in-flight assignment.
  controller.closeInstructors();
  harness.assigns[0].resolve(membershipWriteEnvelope(
    membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }),
  ));
  await saving;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.open, false);
  assert.deepEqual(state.instructors.rows, [], "a retired reply never repopulates the closed section");
  assert.equal(state.instructors.lastConfirmed, null);
  assert.equal(state.instructors.selection, null);
});

test("M2-B12 controller: a session event clears the instructor rows and selection", async () => {
  const harness = createHarness();
  const sink = createSessionSink();
  const controller = createTenantBranchController({
    ...harness.api,
    readPrincipal: () => "session:1",
    subscribeSession: sink.subscribeSession,
  });
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);
  assert.ok(controller.getState().instructors.selection);

  sink.fire();
  await flush();

  let state = controller.getState();
  assert.deepEqual(state.instructors.rows, [], "the previous principal's rows are gone");
  assert.equal(state.instructors.selection, null, "the previous principal's selection is gone");
  assert.equal(state.instructors.lastConfirmed, null);

  // The new session gets its own bounded first page.
  harness.lists[1].resolve(listEnvelope([branch(), branch2, archivedBranch]));
  harness.instructorLists[1].resolve(membershipListEnvelope([membership()]));
  await controller.waitForIdle();
  state = controller.getState();
  assert.equal(state.instructors.phase, "ready");
  assert.equal(state.instructors.rows.length, 1);
});

test("M2-B12 controller: dispose clears everything and drops an in-flight assignment", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness);
  controller.selectInstructorBranch(MEMBERSHIP_ID, BRANCH_ID_2);

  const saving = controller.saveInstructorBranch();
  await flush();
  controller.dispose();
  harness.assigns[0].resolve(membershipWriteEnvelope(
    membership({ branch_id: BRANCH_ID_2, branch_name: "فرع ثانٍ" }),
  ));
  await saving;

  const state = controller.getState();
  assert.deepEqual(state.instructors.rows, []);
  assert.equal(state.instructors.lastConfirmed, null);
  assert.equal(state.instructors.mutation.status, "idle");
});

test("M2-B12 controller: a denied list clears the private section state", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);

  const opening = controller.openInstructors();
  harness.lists[0].resolve(listEnvelope([branch(), branch2]));
  harness.instructorLists[0].reject(new Error("Forbidden"));
  await opening;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.phase, "denied");
  assert.equal(state.instructors.reason, "not-owner");
  assert.deepEqual(state.instructors.rows, []);
  assert.equal(state.instructors.selection, null);
  assert.equal(
    isTenantBranchAuthorizationLoss(classifyTenantInstructorListFailure(new Error("Forbidden")).reason),
    true,
  );
});

test("M2-B12 controller: a malformed list response is never a success", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);

  const opening = controller.openInstructors();
  harness.lists[0].resolve(listEnvelope([branch(), branch2]));
  harness.instructorLists[0].resolve({
    memberships: [membership()],
    next_cursor: null,
    extra: 1,
  } as unknown as TenantInstructorMembershipListEnvelope);
  await opening;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.phase, "error");
  assert.equal(state.instructors.error, INSTRUCTOR_LIST_MALFORMED_MESSAGE);
  assert.deepEqual(state.instructors.rows, []);
});

test("M2-B12 controller: the instructor page never accumulates and paging uses the server cursor", async () => {
  const harness = createHarness();
  const controller = createTenantBranchController(harness.api);
  await openInstructorSection(controller, harness, {
    memberships: [membership()],
    nextCursor: "cursor-1",
  });
  assert.equal(controller.getState().instructors.nextCursor, "cursor-1");

  const paging = controller.nextInstructorsPage();
  await flush();
  assert.deepEqual(harness.instructorListCalls[1], { limit: 25, cursor: "cursor-1" });
  harness.instructorLists[1].resolve(membershipListEnvelope([membership({ membership_id: MEMBERSHIP_ID_2 })]));
  await paging;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.instructors.rows.length, 1, "the new page replaces the old one");
  assert.equal(state.instructors.rows[0].membership_id, MEMBERSHIP_ID_2);
  assert.equal(state.instructors.hasPreviousPage, true);
  assert.equal(state.instructors.nextCursor, null);

  const back = controller.firstInstructorsPage();
  await flush();
  assert.deepEqual(harness.instructorListCalls[2], { limit: 25, cursor: null });
  harness.instructorLists[2].resolve(membershipListEnvelope([membership()]));
  await back;
  await controller.waitForIdle();
  assert.equal(controller.getState().instructors.hasPreviousPage, false);
});
