/**
 * M2-B07 — private academic-period planning catalog: client behaviour.
 *
 * Three layers are exercised against their REAL production code:
 *
 *  1. the TRANSPORT (`src/lib/api-http.ts`) through the real `request` helper,
 *     with only `fetch`/`localStorage`/`window` stubbed — so the canonical path,
 *     the query, the headers and the exact bodies are observed, not described;
 *  2. the PARSER and CONTROLLER (`src/features/tenant/academic-periods.ts`) with
 *     a synthetic transport seam, so every lifecycle fence (read generation,
 *     form generation, confirmed-write epoch, own visible-mutation ticket,
 *     principal observation, disposal) is driven directly;
 *  3. the REAL COMPONENT (`src/features/tenant/AcademicPeriodsCard.tsx`) through
 *     the real React server renderer with the real shared UI primitives, so the
 *     markup and the ACTUAL control callbacks come from the production element
 *     tree.
 *
 * No browser, DOM paint, network, storage service or database is involved, and
 * no request leaves the process.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createMyAcademicPeriod,
  listMyAcademicPeriods,
  updateMyAcademicPeriod,
} from "../lib/api-http";
import {
  ACADEMIC_PERIOD_MALFORMED_MESSAGE,
  ACADEMIC_PERIOD_NAME_INVALID_MESSAGE,
  ACADEMIC_PERIOD_NO_CHANGES_MESSAGE,
  ACADEMIC_PERIOD_RANGE_INVALID_MESSAGE,
  ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE,
  ACADEMIC_PERIOD_PAGE_LIMIT,
  buildAcademicPeriodCreate,
  buildAcademicPeriodPatch,
  classifyAcademicPeriodFailure,
  classifyAcademicPeriodWriteFailure,
  createAcademicPeriodController,
  parseAcademicPeriod,
  parseAcademicPeriodDate,
  parseAcademicPeriodEnvelope,
  parseAcademicPeriodList,
  type AcademicPeriod,
  type AcademicPeriodApi,
  type AcademicPeriodListEnvelope,
  type AcademicPeriodState,
} from "../features/tenant/academic-periods";

// ===========================================================================
// Fixtures
// ===========================================================================

const PERIOD_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const period = (overrides: Partial<AcademicPeriod> = {}): AcademicPeriod => ({
  id: PERIOD_ID,
  name: "الفصل الخريفي",
  starts_on: "2026-09-01",
  ends_on: "2027-01-15",
  is_archived: false,
  created_at: "2026-10-21T08:00:00.000Z",
  updated_at: "2026-10-21T08:00:00.000Z",
  ...overrides,
});

const listEnvelope = (
  periods: AcademicPeriod[] = [period()],
  pagination: { limit: number; offset: number; has_more: boolean } = { limit: 25, offset: 0, has_more: false },
): AcademicPeriodListEnvelope => ({ periods, pagination });

const writeEnvelope = (value: AcademicPeriod = period()) => ({ period: value });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const createSessionSink = () => {
  let listener: (() => void) | null = null;
  return {
    subscribeSession: (l: () => void) => {
      listener = l;
      return () => { listener = null; };
    },
    fire: () => { if (listener) listener(); },
    hasListener: () => listener !== null,
  };
};

interface Harness {
  api: AcademicPeriodApi;
  loads: Array<{ params: { limit: number; offset: number; archived: boolean }; deferred: Deferred<AcademicPeriodListEnvelope> }>;
  creates: Array<{ input: { name: string; starts_on: string; ends_on: string }; deferred: Deferred<any> }>;
  updates: Array<{ id: string; update: Record<string, unknown>; deferred: Deferred<any> }>;
  principal: { value: string | null };
  session: ReturnType<typeof createSessionSink>;
}

const createHarness = (): Harness => {
  const loads: Harness["loads"] = [];
  const creates: Harness["creates"] = [];
  const updates: Harness["updates"] = [];
  const principal = { value: "session:1" };
  const session = createSessionSink();
  const api: AcademicPeriodApi = {
    listPeriods: (params) => {
      const entry = { params, deferred: deferred<AcademicPeriodListEnvelope>() };
      loads.push(entry);
      return entry.deferred.promise;
    },
    createPeriod: (input) => {
      const entry = { input, deferred: deferred<any>() };
      creates.push(entry);
      return entry.deferred.promise;
    },
    updatePeriod: (id, update) => {
      const entry = { id, update, deferred: deferred<any>() };
      updates.push(entry);
      return entry.deferred.promise;
    },
    readPrincipal: () => principal.value,
    subscribeSession: session.subscribeSession,
  };
  return { api, loads, creates, updates, principal, session };
};

/** Opens the controller and settles the first page. */
const openReady = async (harness: Harness, periods: AcademicPeriod[] = [period()]) => {
  const controller = createAcademicPeriodController(harness.api);
  const opening = controller.open();
  harness.loads[0].deferred.resolve(listEnvelope(periods));
  await opening;
  return controller;
};

const stateOf = (controller: { getState(): AcademicPeriodState }): AcademicPeriodState => controller.getState();

// ===========================================================================
// Transport — the real adapters through the real request helper
// ===========================================================================

interface TransportEnv {
  calls: { url: string; init: RequestInit }[];
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
  (globalThis as unknown as { window: unknown }).window = {
    location: { pathname: "/instructor", assign: () => undefined },
  };
  const calls: TransportEnv["calls"] = [];
  return {
    calls,
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
    return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
};

test("transport: the list GET is the canonical bounded, selector-free request", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([period()]) }));

  const body = await listMyAcademicPeriods();

  assert.equal(env.calls.length, 1, "exactly one request");
  assert.equal(env.calls[0].url, "/api/tenants/me/academic-periods?limit=25&offset=0&archived=false");
  assert.equal(env.calls[0].init.method, undefined, "a read: no explicit method override");
  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer token-canonical");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    Object.keys(headers).filter((key) => /tenant|scope|workspace|x-/i.test(key)),
    [],
    "no client tenant selector header",
  );
  assert.equal(/tenant|workspace|scope/i.test(env.calls[0].url.split("?")[1] ?? ""), false, "no tenant selector in the query");
  assert.equal(body.periods.length, 1);
});

test("transport: limit, offset and the archived view are explicit parameters", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([], { limit: 50, offset: 50, has_more: false }) }));

  await listMyAcademicPeriods({ limit: 50, offset: 50, archived: true });

  assert.equal(env.calls[0].url, "/api/tenants/me/academic-periods?limit=50&offset=50&archived=true");
});

test("transport: a missing token sends no Authorization header", async (t) => {
  const env = installTransportEnvironment(null);
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: listEnvelope([]) }));

  await listMyAcademicPeriods();

  const headers = env.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("transport: the create body is exactly the three strict fields", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 201, body: writeEnvelope() }));

  await createMyAcademicPeriod({ name: "الفصل الشتوي", starts_on: "2027-01-20", ends_on: "2027-01-30" });

  assert.equal(env.calls[0].url, "/api/tenants/me/academic-periods");
  assert.equal(env.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), {
    name: "الفصل الشتوي",
    starts_on: "2027-01-20",
    ends_on: "2027-01-30",
  });
});

test("transport: the update body carries only the fields the caller set", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope() }));

  await updateMyAcademicPeriod(PERIOD_ID, { name: "اسم جديد" });
  await updateMyAcademicPeriod(PERIOD_ID, { is_archived: true });
  await updateMyAcademicPeriod(PERIOD_ID, { starts_on: "2026-10-01", ends_on: "2027-02-01" });

  assert.equal(env.calls[0].url, `/api/tenants/me/academic-periods/${PERIOD_ID}`);
  assert.equal(env.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), { name: "اسم جديد" });
  assert.deepEqual(JSON.parse(String(env.calls[1].init.body)), { is_archived: true });
  assert.deepEqual(JSON.parse(String(env.calls[2].init.body)), { starts_on: "2026-10-01", ends_on: "2027-02-01" });
});

test("transport: the period id is encoded in the path, never in a query", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: true, status: 200, body: writeEnvelope() }));

  await updateMyAcademicPeriod(PERIOD_ID, { name: "x" });

  assert.equal(env.calls[0].url.includes("?"), false, "no query on a write");
});

test("transport: a write error arrives as its message only — no status, no code", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: false, status: 403, body: { error: "Forbidden", code: "SOMETHING" } }));

  await assert.rejects(
    () => createMyAcademicPeriod({ name: "فصل", starts_on: "2026-09-01", ends_on: "2027-01-15" }),
    (error: Error) => {
      assert.equal(error.message, "Forbidden");
      assert.equal(/403/.test(error.message), false, "the discarded status is not invented");
      assert.equal(/SOMETHING/.test(error.message), false, "the discarded code is not invented");
      return true;
    },
  );
});

test("transport: a 500 arrives as its documented message and classifies as uncertain", async (t) => {
  const env = installTransportEnvironment("token-canonical");
  t.after(env.restore);
  stubFetch(env, () => ({ ok: false, status: 500, body: { error: "Failed to create academic period" } }));

  await assert.rejects(
    () => createMyAcademicPeriod({ name: "فصل", starts_on: "2026-09-01", ends_on: "2027-01-15" }),
    (error: Error) => {
      assert.equal(error.message, "Failed to create academic period");
      assert.equal(classifyAcademicPeriodWriteFailure(error).kind, "uncertain");
      return true;
    },
  );
});

// ===========================================================================
// Date-only parsing
// ===========================================================================

test("date: a real calendar date round-trips as the same string", () => {
  for (const value of ["2026-09-01", "2027-01-15", "2028-02-29", "1000-01-01", "9999-12-31"]) {
    assert.equal(parseAcademicPeriodDate(value), value, `${value} must round-trip`);
  }
});

test("date: an impossible calendar date is refused, never normalized", () => {
  for (const value of ["2026-02-30", "2026-04-31", "2027-02-29", "2026-13-01", "2026-00-10", "2026-01-00"]) {
    assert.equal(parseAcademicPeriodDate(value), null, `${value} must be refused`);
  }
});

test("date: a non-canonical shape is refused", () => {
  for (const value of ["2026-9-1", "2026/09/01", "01-09-2026", "2026-09-01T00:00:00Z", "2026-09-01 ", "", 20260901, null, undefined]) {
    assert.equal(parseAcademicPeriodDate(value), null, `${JSON.stringify(value)} must be refused`);
  }
});

test("date: a year outside the SQL DATE range is refused", () => {
  for (const value of ["0999-01-01", "0001-01-01"]) {
    assert.equal(parseAcademicPeriodDate(value), null, `${value} must be refused`);
  }
});

// ===========================================================================
// Parser — the exact DTO
// ===========================================================================

test("parser: the exact seven-field DTO is accepted and copied verbatim", () => {
  const parsed = parseAcademicPeriod(period());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(Object.keys(parsed.period).sort(), [
    "created_at", "ends_on", "id", "is_archived", "name", "starts_on", "updated_at",
  ]);
  assert.equal(parsed.period.starts_on, "2026-09-01");
  assert.equal(typeof parsed.period.starts_on, "string", "a date-only field is never a Date");
  assert.equal(parsed.period.is_archived, false);
});

test("parser: an extra key is a malformed response, not a period", () => {
  const parsed = parseAcademicPeriod({ ...period(), tenant_id: "tenant-a" });
  assert.equal(parsed.ok, false);
});

test("parser: a missing key is a malformed response", () => {
  const sparse: Record<string, unknown> = { ...period() };
  delete sparse.updated_at;
  assert.equal(parseAcademicPeriod(sparse).ok, false);
});

test("parser: a non-UUID id is refused", () => {
  for (const id of ["", "abc", "11111111-1111-1111-1111", 42]) {
    assert.equal(parseAcademicPeriod({ ...period(), id }).ok, false, `id=${JSON.stringify(id)}`);
  }
});

test("parser: a name that is blank or over 255 characters is refused", () => {
  for (const name of ["", "   ", "ا".repeat(256), 42, null]) {
    assert.equal(parseAcademicPeriod({ ...period(), name }).ok, false, `name=${JSON.stringify(name)}`);
  }
  assert.equal(parseAcademicPeriod({ ...period(), name: "ا".repeat(255) }).ok, true);
});

test("parser: a TRANSPORTED name that is not canonical is refused, never normalized", () => {
  // The server canonicalizes every name it stores, so a transported name that
  // carries surrounding whitespace is a value this client cannot confirm. It is
  // REFUSED, never trimmed into a confirmed DTO.
  for (const name of [
    "  October  ",
    " October",
    "October ",
    "\tOctober\n",
    "\u00a0October\u00a0",
    " October\u00a0",
    "\r\nOctober",
  ]) {
    assert.equal(
      parseAcademicPeriod({ ...period(), name }).ok,
      false,
      `name=${JSON.stringify(name)} must be refused, not normalized`,
    );
  }
});

test("parser: a canonical TRANSPORTED name is copied verbatim", () => {
  const parsed = parseAcademicPeriod(period({ name: "October" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.period.name, "October", "the confirmed name is copied exactly");
  assert.equal(parsed.period.name.trim(), parsed.period.name, "a confirmed name is already canonical");
});

test("parser: an inner whitespace difference is still a canonical name", () => {
  // Canonical means "exactly its own trimmed form" — it is not a rule about
  // internal spacing, which is a legitimate free label.
  const parsed = parseAcademicPeriod(period({ name: "الفصل الأول" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.period.name, "الفصل الأول");
});

test("parser: an impossible or reversed date is refused", () => {
  assert.equal(parseAcademicPeriod({ ...period(), starts_on: "2026-02-30" }).ok, false);
  assert.equal(parseAcademicPeriod({ ...period(), starts_on: "2027-02-01", ends_on: "2026-09-01" }).ok, false);
});

test("parser: a non-boolean is_archived is refused — never coerced", () => {
  for (const is_archived of [0, 1, "false", "true", null, undefined]) {
    assert.equal(parseAcademicPeriod({ ...period(), is_archived }).ok, false, `is_archived=${JSON.stringify(is_archived)}`);
  }
});

test("parser: a non-canonical or impossible instant is refused", () => {
  for (const value of ["2026-10-21T08:00:00Z", "2026-99-99T88:77:66.000Z", "2026-10-21 08:00:00", 42, null]) {
    assert.equal(parseAcademicPeriod({ ...period(), created_at: value }).ok, false, `created_at=${JSON.stringify(value)}`);
  }
});

test("parser: a non-object is refused", () => {
  for (const body of [null, undefined, "x", 42, [period()], true]) {
    assert.equal(parseAcademicPeriod(body).ok, false);
  }
});

// ===========================================================================
// Parser — the list envelope and its response bound
// ===========================================================================

test("list parser: the exact envelope is accepted", () => {
  const parsed = parseAcademicPeriodList(listEnvelope([period()]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.periods.length, 1);
  assert.deepEqual(parsed.pagination, { limit: 25, offset: 0, has_more: false });
});

test("list parser: an empty page is a valid envelope", () => {
  const parsed = parseAcademicPeriodList(listEnvelope([]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.periods, []);
});

test("list parser: an extra envelope key is refused", () => {
  assert.equal(parseAcademicPeriodList({ ...listEnvelope([]), total: 3 }).ok, false);
});

test("list parser: an extra pagination key is refused", () => {
  assert.equal(
    parseAcademicPeriodList({ periods: [], pagination: { limit: 25, offset: 0, has_more: false, total: 0 } }).ok,
    false,
  );
});

test("list parser: a page larger than the declared limit is refused before any row is copied", () => {
  const rows = [period(), period({ id: OTHER_ID })];
  assert.equal(parseAcademicPeriodList({ periods: rows, pagination: { limit: 1, offset: 0, has_more: true } }).ok, false);
});

test("list parser: a limit outside 1..100 or a negative offset is refused", () => {
  for (const pagination of [
    { limit: 0, offset: 0, has_more: false },
    { limit: 101, offset: 0, has_more: false },
    { limit: 25, offset: -1, has_more: false },
    { limit: 25, offset: 10001, has_more: false },
    { limit: 25.5, offset: 0, has_more: false },
    { limit: 25, offset: 0, has_more: "false" },
  ]) {
    assert.equal(parseAcademicPeriodList({ periods: [], pagination }).ok, false, JSON.stringify(pagination));
  }
});

test("list parser: a non-array periods field is refused", () => {
  assert.equal(parseAcademicPeriodList({ periods: {}, pagination: { limit: 25, offset: 0, has_more: false } }).ok, false);
});

test("list parser: one malformed row fails the WHOLE page — no partial render", () => {
  const parsed = parseAcademicPeriodList(listEnvelope([period(), { ...period(), id: OTHER_ID, starts_on: "2026-02-30" }]));
  assert.equal(parsed.ok, false);
});

test("list parser: one row with a non-canonical name fails the WHOLE page", () => {
  const parsed = parseAcademicPeriodList(listEnvelope([period(), { ...period(), id: OTHER_ID, name: "  October  " }]));
  assert.equal(parsed.ok, false, "no partial page is rendered from a non-canonical name");
});

test("envelope parser: a confirmed period with a non-canonical name is refused", () => {
  assert.equal(parseAcademicPeriodEnvelope(writeEnvelope(period({ name: "  October  " }))).ok, false);
  assert.equal(parseAcademicPeriodEnvelope(writeEnvelope(period({ name: "October" }))).ok, true);
});

test("envelope parser: exactly { period } is required", () => {
  assert.equal(parseAcademicPeriodEnvelope(writeEnvelope()).ok, true);
  assert.equal(parseAcademicPeriodEnvelope({ period: period(), extra: 1 }).ok, false);
  assert.equal(parseAcademicPeriodEnvelope({ periods: [period()] }).ok, false);
  assert.equal(parseAcademicPeriodEnvelope(null).ok, false);
});

// ===========================================================================
// Failure classification
// ===========================================================================

test("classify: the documented read denials map to their phases", () => {
  assert.equal(classifyAcademicPeriodFailure(new Error("Forbidden")).phase, "denied");
  assert.equal(classifyAcademicPeriodFailure(new Error("Tenant membership not found")).phase, "no-workspace");
  assert.equal(classifyAcademicPeriodFailure(new Error("Token expired")).phase, "unauthorized");
  assert.equal(
    classifyAcademicPeriodFailure(
      new Error("Academic period management is not available while the account is limited to billing and support"),
    ).phase,
    "denied",
  );
  assert.equal(classifyAcademicPeriodFailure(new Error("Failed to list academic periods")).reason, "server");
});

test("classify: an unrecognized message is never faked into a permission outcome", () => {
  const failure = classifyAcademicPeriodFailure(new Error("Network request failed"));
  assert.equal(failure.phase, "error");
  assert.equal(failure.reason, "unknown");
  assert.equal(failure.message, "Network request failed", "the real message is shown, not invented");
});

test("classify: a write denial is definite, an unknown outcome is uncertain", () => {
  assert.equal(classifyAcademicPeriodWriteFailure(new Error("Forbidden")).kind, "denied");
  assert.equal(classifyAcademicPeriodWriteFailure(new Error("Academic period not found")).kind, "missing");
  assert.equal(
    classifyAcademicPeriodWriteFailure(new Error("Invalid academic period update payload")).kind,
    "invalid",
  );
  assert.equal(classifyAcademicPeriodWriteFailure(new Error("Failed to update academic period")).kind, "uncertain");
  assert.equal(classifyAcademicPeriodWriteFailure(new Error("boom")).kind, "uncertain");
});

// ===========================================================================
// Form builders
// ===========================================================================

test("form: the dirty subset contains only the fields that really changed", () => {
  const built = buildAcademicPeriodPatch({
    mode: "edit",
    nameDraft: "الفصل الأول",
    startsOnDraft: "2026-09-01",
    endsOnDraft: "2027-01-15",
    targetId: PERIOD_ID,
    originalName: "الفصل الخريفي",
    originalStartsOn: "2026-09-01",
    originalEndsOn: "2027-01-15",
    error: null,
    notice: null,
  });
  assert.equal("message" in built, false);
  if ("message" in built) return;
  assert.deepEqual(built.patch, { name: "الفصل الأول" });
  assert.equal(built.dirtyCount, 1);
});

test("form: a whitespace-only name difference is not a change", () => {
  const built = buildAcademicPeriodPatch({
    mode: "edit",
    nameDraft: "  الفصل الخريفي  ",
    startsOnDraft: "2026-09-01",
    endsOnDraft: "2027-01-15",
    targetId: PERIOD_ID,
    originalName: "الفصل الخريفي",
    originalStartsOn: "2026-09-01",
    originalEndsOn: "2027-01-15",
    error: null,
    notice: null,
  });
  assert.equal("message" in built, false);
  if ("message" in built) return;
  assert.equal(built.dirtyCount, 0);
  assert.deepEqual(built.patch, {});
});

test("form: changing only one date is validated against the other stored bound", () => {
  const built = buildAcademicPeriodPatch({
    mode: "edit",
    nameDraft: "الفصل الخريفي",
    startsOnDraft: "2027-06-01",
    endsOnDraft: "2027-01-15",
    targetId: PERIOD_ID,
    originalName: "الفصل الخريفي",
    originalStartsOn: "2026-09-01",
    originalEndsOn: "2027-01-15",
    error: null,
    notice: null,
  });
  assert.equal("message" in built, true);
  if (!("message" in built)) return;
  assert.equal(built.message, ACADEMIC_PERIOD_RANGE_INVALID_MESSAGE);
});

test("form: an invalid date or name is rejected locally", () => {
  const base = {
    mode: "edit" as const,
    nameDraft: "الفصل",
    startsOnDraft: "2026-09-01",
    endsOnDraft: "2027-01-15",
    targetId: PERIOD_ID,
    originalName: "الفصل",
    originalStartsOn: "2026-09-01",
    originalEndsOn: "2027-01-15",
    error: null,
    notice: null,
  };
  assert.equal(
    (buildAcademicPeriodPatch({ ...base, startsOnDraft: "2026-02-30" }) as { message?: string }).message,
    "التاريخ غير صالح؛ استخدم الصيغة YYYY-MM-DD بتاريخ حقيقي.",
  );
  assert.equal(
    (buildAcademicPeriodPatch({ ...base, nameDraft: "  " }) as { message?: string }).message,
    ACADEMIC_PERIOD_NAME_INVALID_MESSAGE,
  );
});

test("form: the create builder requires all three validated fields", () => {
  const ok = buildAcademicPeriodCreate({
    mode: "create",
    nameDraft: " الفصل الشتوي ",
    startsOnDraft: "2027-01-20",
    endsOnDraft: "2027-01-30",
    targetId: null,
    originalName: null,
    originalStartsOn: null,
    originalEndsOn: null,
    error: null,
    notice: null,
  });
  assert.equal("message" in ok, false);
  if ("message" in ok) return;
  assert.deepEqual(ok.input, { name: "الفصل الشتوي", starts_on: "2027-01-20", ends_on: "2027-01-30" });

  const reversed = buildAcademicPeriodCreate({
    mode: "create",
    nameDraft: "فصل",
    startsOnDraft: "2027-02-01",
    endsOnDraft: "2027-01-01",
    targetId: null,
    originalName: null,
    originalStartsOn: null,
    originalEndsOn: null,
    error: null,
    notice: null,
  });
  assert.equal("message" in reversed, true);
});

test("form: the REQUEST side still trims, while the TRANSPORTED side is refused", () => {
  // The two rules are deliberately different: what the user typed is trimmed
  // before it is sent, but what the server confirms must ALREADY be canonical.
  const built = buildAcademicPeriodCreate({
    mode: "create",
    nameDraft: "  October  ",
    startsOnDraft: "2027-01-20",
    endsOnDraft: "2027-01-30",
    targetId: null,
    originalName: null,
    originalStartsOn: null,
    originalEndsOn: null,
    error: null,
    notice: null,
  });
  assert.equal("message" in built, false);
  if ("message" in built) return;
  assert.deepEqual(built.input, { name: "October", starts_on: "2027-01-20", ends_on: "2027-01-30" });
  assert.equal(
    parseAcademicPeriod({ ...period(), name: built.input.name }).ok,
    true,
    "the trimmed request name is exactly the canonical form the server confirms",
  );
});

// ===========================================================================
// Controller — the bounded read
// ===========================================================================

test("controller: no request is issued before the panel is opened", () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  assert.equal(harness.loads.length, 0);
  assert.equal(stateOf(controller).open, false);
  assert.deepEqual(stateOf(controller).rows, []);
});

test("controller: open issues exactly one bounded read of the first page", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  assert.equal(harness.loads.length, 1, "exactly one read");
  assert.deepEqual(harness.loads[0].params, {
    limit: ACADEMIC_PERIOD_PAGE_LIMIT,
    offset: 0,
    archived: false,
  });
  assert.equal(stateOf(controller).phase, "ready");
  assert.equal(stateOf(controller).rows.length, 1);
  assert.equal(stateOf(controller).hasPreviousPage, false);
});

test("controller: opening an already-open panel does not read again", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  await controller.open();
  assert.equal(harness.loads.length, 1, "no second read for an open panel");
});

test("controller: an empty page is the empty phase, not an error", async () => {
  const harness = createHarness();
  const controller = await openReady(harness, []);
  assert.equal(stateOf(controller).phase, "empty");
  assert.deepEqual(stateOf(controller).rows, []);
});

test("controller: refresh reads the CURRENT page again", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const refreshing = controller.refresh();
  assert.equal(harness.loads.length, 2);
  assert.equal(harness.loads[1].params.offset, 0);
  harness.loads[1].deferred.resolve(listEnvelope([period()]));
  await refreshing;
  assert.equal(stateOf(controller).phase, "ready");
});

test("controller: the page size never exceeds the documented bound", async () => {
  const harness = createHarness();
  await openReady(harness);
  for (const entry of harness.loads) {
    assert.ok(entry.params.limit <= 100, "the page size stays within the server bound");
    assert.equal(entry.params.limit, ACADEMIC_PERIOD_PAGE_LIMIT);
  }
});

// ===========================================================================
// Controller — paging
// ===========================================================================

test("controller: nextPage advances by one page only when has_more is true", async () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  const opening = controller.open();
  harness.loads[0].deferred.resolve(listEnvelope([period()], { limit: 25, offset: 0, has_more: true }));
  await opening;

  const paging = controller.nextPage();
  assert.equal(harness.loads.length, 2);
  assert.equal(harness.loads[1].params.offset, 25);
  harness.loads[1].deferred.resolve(listEnvelope([period({ id: OTHER_ID })], { limit: 25, offset: 25, has_more: false }));
  await paging;
  assert.equal(stateOf(controller).hasPreviousPage, true);
  assert.equal(stateOf(controller).pagination.offset, 25);
});

test("controller: nextPage is a no-op when the server says there is no next page", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  await controller.nextPage();
  assert.equal(harness.loads.length, 1, "no request without has_more");
});

test("controller: previousPage goes back one page and clamps at the first page", async () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  const opening = controller.open();
  harness.loads[0].deferred.resolve(listEnvelope([period()], { limit: 25, offset: 0, has_more: true }));
  await opening;
  const paging = controller.nextPage();
  harness.loads[1].deferred.resolve(listEnvelope([period({ id: OTHER_ID })], { limit: 25, offset: 25, has_more: true }));
  await paging;

  const back = controller.previousPage();
  assert.equal(harness.loads[2].params.offset, 0);
  harness.loads[2].deferred.resolve(listEnvelope([period()], { limit: 25, offset: 0, has_more: true }));
  await back;
  assert.equal(stateOf(controller).hasPreviousPage, false);

  await controller.previousPage();
  assert.equal(harness.loads.length, 3, "no request below the first page");
});

// ===========================================================================
// Controller — the archived view
// ===========================================================================

test("controller: switching to the archived view reads its first page once", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const switching = controller.setArchivedView(true);
  assert.equal(harness.loads.length, 2);
  assert.deepEqual(harness.loads[1].params, { limit: 25, offset: 0, archived: true });
  harness.loads[1].deferred.resolve(listEnvelope([]));
  await switching;
  assert.equal(stateOf(controller).archivedView, true);
  assert.equal(stateOf(controller).phase, "empty");
});

test("controller: selecting the view that is already active issues no request", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  await controller.setArchivedView(false);
  assert.equal(harness.loads.length, 1);
});

test("controller: switching the view while the panel is closed issues no request", async () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  await controller.setArchivedView(true);
  assert.equal(harness.loads.length, 0, "the flag changes, but nothing is read");
  assert.equal(stateOf(controller).archivedView, true);
});

// ===========================================================================
// Controller — create
// ===========================================================================

test("controller: create with an invalid draft issues NO request and keeps the input", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft("   ");
  controller.updateStartsOnDraft("2026-09-01");
  controller.updateEndsOnDraft("2027-01-15");
  await controller.create();
  assert.equal(harness.creates.length, 0, "local validation precedes the transport");
  assert.equal(stateOf(controller).form.error, ACADEMIC_PERIOD_NAME_INVALID_MESSAGE);
  assert.equal(stateOf(controller).form.nameDraft, "   ", "the draft is preserved verbatim");
});

test("controller: create sends exactly one request with the strict body", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft(" الفصل الشتوي ");
  controller.updateStartsOnDraft("2027-01-20");
  controller.updateEndsOnDraft("2027-01-30");
  const creating = controller.create();
  assert.equal(harness.creates.length, 1);
  assert.deepEqual(harness.creates[0].input, {
    name: "الفصل الشتوي",
    starts_on: "2027-01-20",
    ends_on: "2027-01-30",
  });
  harness.creates[0].deferred.resolve(writeEnvelope(period({ name: "الفصل الشتوي" })));
  await creating;
});

test("controller: a confirmed create closes the form and reports the server row", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft("الفصل الشتوي");
  controller.updateStartsOnDraft("2027-01-20");
  controller.updateEndsOnDraft("2027-01-30");
  const creating = controller.create();
  harness.creates[0].deferred.resolve(writeEnvelope(period({ name: "الفصل الشتوي" })));
  await creating;
  // The follow-up read is issued by the confirmed write.
  assert.equal(harness.loads.length, 2, "one bounded follow-up read");
  harness.loads[1].deferred.resolve(listEnvelope([period({ name: "الفصل الشتوي" })]));
  await Promise.resolve();
  assert.equal(stateOf(controller).form.mode, "closed");
  assert.equal(stateOf(controller).lastConfirmed?.name, "الفصل الشتوي");
  assert.equal(stateOf(controller).mutation.status, "idle");
});

test("controller: an uncertain create preserves the draft, states uncertainty and retries nothing", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft("الفصل الشتوي");
  controller.updateStartsOnDraft("2027-01-20");
  controller.updateEndsOnDraft("2027-01-30");
  const creating = controller.create();
  harness.creates[0].deferred.reject(new Error("Failed to create academic period"));
  await creating;
  assert.equal(stateOf(controller).mutation.status, "uncertain");
  assert.equal(stateOf(controller).mutation.notice, ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE);
  assert.equal(stateOf(controller).form.mode, "create", "the form stays open with its draft");
  assert.equal(stateOf(controller).form.nameDraft, "الفصل الشتوي");
  assert.equal(harness.creates.length, 1, "nothing is retried automatically");
});

test("controller: a definite create rejection settles to idle with the server message", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft("فصل");
  controller.updateStartsOnDraft("2026-09-01");
  controller.updateEndsOnDraft("2027-01-15");
  const creating = controller.create();
  harness.creates[0].deferred.reject(new Error("Invalid academic period payload"));
  await creating;
  assert.equal(stateOf(controller).mutation.status, "idle");
  assert.equal(stateOf(controller).mutation.error, "Invalid academic period payload");
  assert.equal(stateOf(controller).form.mode, "create", "the draft is kept so it can be corrected");
});

test("controller: a malformed 2xx on a create is UNCERTAIN, never success", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft("فصل");
  controller.updateStartsOnDraft("2026-09-01");
  controller.updateEndsOnDraft("2027-01-15");
  const creating = controller.create();
  harness.creates[0].deferred.resolve({ period: { ...period(), tenant_id: "leak" } });
  await creating;
  assert.equal(stateOf(controller).mutation.status, "uncertain");
  assert.equal(stateOf(controller).mutation.error, ACADEMIC_PERIOD_MALFORMED_MESSAGE);
  assert.equal(stateOf(controller).lastConfirmed, null, "no period is confirmed from a malformed body");
});

test("controller: a read that carries a non-canonical name is malformed, never a confirmed catalog", async () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  const opening = controller.open();
  harness.loads[0].deferred.resolve(listEnvelope([period({ name: "  October  " })]));
  await opening;
  const state = stateOf(controller);
  assert.equal(state.phase, "malformed");
  assert.equal(state.rows.length, 0, "no row is rendered from a non-canonical name");
  assert.equal(state.error, ACADEMIC_PERIOD_MALFORMED_MESSAGE);
  assert.equal(state.lastConfirmed, null, "nothing is confirmed from a non-canonical body");
});

test("controller: a create that confirms with a non-canonical name is UNCERTAIN, never success", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openCreateForm();
  controller.updateNameDraft("فصل");
  controller.updateStartsOnDraft("2026-09-01");
  controller.updateEndsOnDraft("2027-01-15");
  const creating = controller.create();
  harness.creates[0].deferred.resolve({ period: period({ name: "  فصل  " }) });
  await creating;
  const state = stateOf(controller);
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.error, ACADEMIC_PERIOD_MALFORMED_MESSAGE);
  assert.equal(state.lastConfirmed, null, "no period is confirmed from a non-canonical body");
});

test("controller: a save that confirms with a non-canonical name is UNCERTAIN and keeps the draft", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("الفصل الجديد");
  const saving = controller.save();
  harness.updates[0].deferred.resolve({ period: period({ name: "  الفصل الجديد  " }) });
  await saving;
  const state = stateOf(controller);
  assert.equal(state.mutation.status, "uncertain");
  assert.equal(state.mutation.error, ACADEMIC_PERIOD_MALFORMED_MESSAGE);
  assert.equal(state.lastConfirmed, null, "a non-canonical confirmation is never applied");
  assert.equal(state.rows.length, 1, "the held page is not rewritten by a non-canonical answer");
});

// ===========================================================================
// Controller — edit and archive
// ===========================================================================

test("controller: opening the edit form binds the server-confirmed values without a request", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  assert.equal(harness.loads.length, 1, "opening a form reads nothing");
  const form = stateOf(controller).form;
  assert.equal(form.mode, "edit");
  assert.equal(form.nameDraft, "الفصل الخريفي");
  assert.equal(form.startsOnDraft, "2026-09-01");
  assert.equal(form.originalEndsOn, "2027-01-15");
});

test("controller: an unchanged edit issues NO request at all", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  await controller.save();
  assert.equal(harness.updates.length, 0, "a no-op save never reaches the transport");
  assert.equal(stateOf(controller).form.notice, ACADEMIC_PERIOD_NO_CHANGES_MESSAGE);
  assert.equal(stateOf(controller).mutation.status, "idle");
});

test("controller: save sends only the dirty subset", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("الفصل الأول");
  const saving = controller.save();
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.updates[0].id, PERIOD_ID);
  assert.deepEqual(harness.updates[0].update, { name: "الفصل الأول" });
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "الفصل الأول" })));
  await saving;
});

test("controller: a confirmed save updates the held row and closes the form", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("الفصل الأول");
  const saving = controller.save();
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "الفصل الأول" })));
  await saving;
  assert.equal(stateOf(controller).rows[0].name, "الفصل الأول");
  assert.equal(stateOf(controller).form.mode, "closed");
  assert.equal(harness.loads.length, 2, "one bounded follow-up read");
});

test("controller: an uncertain save preserves the draft and the uncertain state", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("الفصل الأول");
  const saving = controller.save();
  harness.updates[0].deferred.reject(new Error("Failed to update academic period"));
  await saving;
  assert.equal(stateOf(controller).mutation.status, "uncertain");
  assert.equal(stateOf(controller).form.mode, "edit");
  assert.equal(stateOf(controller).form.nameDraft, "الفصل الأول");
  assert.equal(harness.updates.length, 1);
});

test("controller: archiving sends exactly { is_archived: true }", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const archiving = controller.setArchived(PERIOD_ID, true);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.updates[0].update, { is_archived: true });
  harness.updates[0].deferred.resolve(writeEnvelope(period({ is_archived: true })));
  await archiving;
  assert.equal(stateOf(controller).mutation.notice !== null, true, "the archive notice is stated");
});

test("controller: archiving an already-archived period issues no request", async () => {
  const harness = createHarness();
  const controller = await openReady(harness, [period({ is_archived: true })]);
  await controller.setArchived(PERIOD_ID, true);
  assert.equal(harness.updates.length, 0);
});

test("controller: restore sends { is_archived: false }", async () => {
  const harness = createHarness();
  const controller = await openReady(harness, [period({ is_archived: true })]);
  const restoring = controller.setArchived(PERIOD_ID, false);
  assert.deepEqual(harness.updates[0].update, { is_archived: false });
  harness.updates[0].deferred.resolve(writeEnvelope(period({ is_archived: false })));
  await restoring;
});

test("controller: archiving a period that is not on the page issues no request", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  await controller.setArchived(OTHER_ID, true);
  assert.equal(harness.updates.length, 0);
});

// ===========================================================================
// Controller — latches and races
// ===========================================================================

test("controller: a double click issues exactly one write", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("الفصل الأول");
  const first = controller.save();
  const second = controller.save();
  assert.equal(harness.updates.length, 1, "the latch rejects the same-tick duplicate");
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "الفصل الأول" })));
  await Promise.all([first, second]);
});

test("controller: a double click on archive issues exactly one write", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const first = controller.setArchived(PERIOD_ID, true);
  const second = controller.setArchived(PERIOD_ID, true);
  assert.equal(harness.updates.length, 1);
  harness.updates[0].deferred.resolve(writeEnvelope(period({ is_archived: true })));
  await Promise.all([first, second]);
});

test("controller: a read that started before a confirmed save never overwrites it", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const stale = controller.refresh();
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("محفوظ");
  const saving = controller.save();
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "محفوظ" })));
  await saving;
  // The stale page arrives AFTER the confirmed write.
  harness.loads[1].deferred.resolve(listEnvelope([period({ name: "قديم" })]));
  await stale;
  assert.equal(stateOf(controller).rows[0].name, "محفوظ", "the stale read never overwrites the confirmed save");
});

test("controller: a new form cannot be opened while a write is in flight", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("محفوظ");
  const saving = controller.save();
  // The latch owns the form for the duration of the write, so a second form
  // cannot be opened on top of it — the reply therefore has nothing newer to
  // close.
  controller.openCreateForm();
  assert.equal(stateOf(controller).form.mode, "edit", "the in-flight form is not replaced");
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "محفوظ" })));
  await saving;
  assert.equal(stateOf(controller).form.mode, "closed", "the save closes the form it belonged to");
  // Once the write has settled, a new form opens normally.
  controller.openCreateForm();
  assert.equal(stateOf(controller).form.mode, "create");
});

test("controller: cancelling a form during a save never reopens it, and the save is still reported", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("محفوظ");
  const saving = controller.save();
  // The form generation advances, so the late reply may not close (or reopen)
  // a form that no longer exists — but the CONFIRMED row is still reported.
  controller.cancelForm();
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "محفوظ" })));
  await saving;
  assert.equal(stateOf(controller).form.mode, "closed");
  assert.equal(stateOf(controller).lastConfirmed?.name, "محفوظ", "the confirmed save is still shown");
  assert.equal(stateOf(controller).rows[0].name, "محفوظ");
});

test("controller: a retired write reply cannot change the visible state", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("محفوظ");
  const saving = controller.save();
  // A session change retires the in-flight write.
  harness.principal.value = "session:2";
  harness.session.fire();
  harness.updates[0].deferred.resolve(writeEnvelope(period({ name: "محفوظ" })));
  await saving;
  assert.equal(stateOf(controller).mutation.status, "idle", "the retired reply never claims a save");
  assert.equal(stateOf(controller).lastConfirmed, null);
  assert.equal(stateOf(controller).rows.length, 0, "the private rows stay cleared");
});

test("controller: a retired read reply observes the principal before settling", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const stale = controller.refresh();
  // The session changes silently (no notifier), so the reply itself must notice.
  harness.principal.value = "session:9";
  harness.loads[1].deferred.resolve(listEnvelope([period()]));
  await stale;
  assert.equal(stateOf(controller).rows.length, 0, "a reply for a retired principal commits nothing");
});

test("controller: close clears the private rows and drafts", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("مسودة");
  controller.close();
  const state = stateOf(controller);
  assert.equal(state.open, false);
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.form.nameDraft, "");
});

test("controller: close during a read retires it", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const stale = controller.refresh();
  controller.close();
  harness.loads[1].deferred.resolve(listEnvelope([period()]));
  await stale;
  assert.deepEqual(stateOf(controller).rows, [], "a closed panel never receives rows");
});

test("controller: dispose clears everything and ignores later work", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.dispose();
  const state = stateOf(controller);
  assert.equal(state.open, false);
  assert.deepEqual(state.rows, []);
  assert.equal(harness.session.hasListener(), false, "the session subscription is released");
  await controller.open();
  assert.equal(harness.loads.length, 1, "a disposed controller reads nothing");
});

// ===========================================================================
// Controller — session and reconciliation
// ===========================================================================

test("controller: a session change clears the private state and states the reason", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  harness.principal.value = "session:2";
  harness.session.fire();
  const state = stateOf(controller);
  assert.deepEqual(state.rows, []);
  assert.equal(state.form.mode, "closed");
  assert.equal(state.phase, "unauthorized");
});

test("controller: a read denial clears the private rows", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  const refreshing = controller.refresh();
  harness.loads[1].deferred.reject(new Error("Forbidden"));
  await refreshing;
  const state = stateOf(controller);
  assert.equal(state.phase, "denied");
  assert.deepEqual(state.rows, [], "a denial never leaves private rows on screen");
});

test("controller: a retryable read failure keeps the panel in the error phase", async () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  const opening = controller.open();
  harness.loads[0].deferred.reject(new Error("Network request failed"));
  await opening;
  const state = stateOf(controller);
  assert.equal(state.phase, "error");
  assert.equal(state.error, "Network request failed");
  assert.equal(state.open, true, "the panel stays open so the user can retry");
});

test("controller: a malformed list is the malformed phase, never a partial page", async () => {
  const harness = createHarness();
  const controller = createAcademicPeriodController(harness.api);
  const opening = controller.open();
  // A deliberately malformed body: the cast is the point of the test, because
  // the transport type promises a well-formed envelope that a broken server can
  // still violate.
  harness.loads[0].deferred.resolve({
    periods: [{ id: "x" }],
    pagination: { limit: 25, offset: 0, has_more: false },
  } as unknown as AcademicPeriodListEnvelope);
  await opening;
  assert.equal(stateOf(controller).phase, "malformed");
  assert.deepEqual(stateOf(controller).rows, []);
});

test("controller: reconcile shows the current state and never confirms the earlier save", async () => {
  const harness = createHarness();
  const controller = await openReady(harness);
  controller.openEditForm(PERIOD_ID);
  controller.updateNameDraft("محفوظ");
  const saving = controller.save();
  harness.updates[0].deferred.reject(new Error("Failed to update academic period"));
  await saving;
  assert.equal(stateOf(controller).mutation.status, "uncertain");

  const reconciling = controller.reconcile();
  harness.loads[1].deferred.resolve(listEnvelope([period({ name: "الحالة الحالية" })]));
  await reconciling;
  assert.equal(stateOf(controller).rows[0].name, "الحالة الحالية");
  assert.equal(stateOf(controller).lastConfirmed, null, "a read never proves the earlier save succeeded");
  assert.notEqual(stateOf(controller).mutation.notice, null, "the read is labelled as a read");
});

// ===========================================================================
// The real component — markup
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

const cardState = (overrides: Partial<AcademicPeriodState> = {}): AcademicPeriodState => ({
  open: true,
  phase: "ready",
  rows: [period()],
  pagination: { limit: 25, offset: 0, hasMore: false },
  archivedView: false,
  hasPreviousPage: false,
  error: null,
  reason: null,
  refreshError: null,
  lastConfirmed: null,
  form: {
    mode: "closed",
    nameDraft: "",
    startsOnDraft: "",
    endsOnDraft: "",
    targetId: null,
    originalName: null,
    originalStartsOn: null,
    originalEndsOn: null,
    error: null,
    notice: null,
  },
  mutation: { status: "idle", kind: null, targetId: null, error: null, notice: null },
  ...overrides,
});

/**
 * Loads the REAL component with only its hooks injected, and runs `run` INSIDE
 * the scope where the hook shim is installed and `globalThis.React` is bound —
 * the component's JSX resolves `React` at render time, so the render must happen
 * before the scope is restored.
 */
const withCard = <T,>(
  hooks: { useState: () => unknown; useRef: () => unknown; useEffect: () => void },
  run: (Component: (...args: unknown[]) => unknown, projectRequire: NodeRequire) => T,
): T => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const componentPath = projectRequire.resolve("../features/tenant/AcademicPeriodsCard.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /AcademicPeriodsCard\.tsx$/.test(parent?.filename || "")) {
        return { ...React, ...hooks };
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
    return run(Component, projectRequire);
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

const renderCard = async (snapshot: AcademicPeriodState): Promise<string> =>
  withCard(
    {
      useState: () => [snapshot, () => undefined],
      useRef: () => ({ current: null }),
      useEffect: () => undefined,
    },
    (Component, projectRequire) => {
      const { renderToStaticMarkup } = projectRequire("react-dom/server");
      return renderToStaticMarkup(Component() as never);
    },
  );

const renderCardTree = async (controller: { getState(): AcademicPeriodState }) =>
  withCard(
    {
      useState: () => [controller.getState(), () => undefined],
      useRef: () => ({ current: controller }),
      useEffect: () => undefined,
    },
    (Component) => Component(),
  );

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

const collectControls = (node: unknown, found: ProductionControl[] = []): ProductionControl[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectControls(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (typeof element.props.onClick === "function") {
    found.push({
      text: treeText(node).trim(),
      disabled: element.props.disabled,
      onClick: element.props.onClick as () => void,
    });
  }
  collectControls(element.props.children, found);
  return found;
};

const controlByText = (controls: ProductionControl[], text: string): ProductionControl => {
  const found = controls.find((control) => control.text === text);
  assert.ok(found, `a control labelled ${JSON.stringify(text)} must exist (saw ${JSON.stringify(controls.map(c => c.text))})`);
  return found!;
};

/**
 * The SUBMIT control carries no `onClick` — it is a real form submit. It is
 * collected by its `type` prop so its label and its latched `disabled` state can
 * be asserted without pretending a click is what submits the form.
 */
const collectSubmits = (node: unknown, found: ProductionControl[] = []): ProductionControl[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectSubmits(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (element.props.type === "submit") {
    found.push({
      text: treeText(node).trim(),
      disabled: element.props.disabled,
      onClick: () => undefined,
    });
  }
  collectSubmits(element.props.children, found);
  return found;
};

/** Every production form of the tree, by its real `onSubmit` handler. */
const collectForms = (node: unknown, found: Array<(event: unknown) => void> = []): Array<(event: unknown) => void> => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectForms(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (typeof element.props.onSubmit === "function") {
    found.push(element.props.onSubmit as (event: unknown) => void);
  }
  collectForms(element.props.children, found);
  return found;
};

/** A submit event the component's handler understands, without a DOM. */
const submitEvent = () => ({ preventDefault: () => undefined });

const buttonsOf = (html: string): string[] => html.match(/<button\b[^>]*>/g) ?? [];

test("component: the closed panel issues no submit and offers the explicit open control", async () => {
  const html = await renderCard(cardState({ open: false }));
  assert.equal(buttonsOf(html).length, 1, "only the open control is rendered");
  assert.equal(html.includes('type="submit"'), false, "no submit exists before the panel is opened");
  assert.equal(html.includes("فتح فترات الدراسة"), true);
  assert.equal(html.includes("الفصل الخريفي"), false, "no private row is rendered for a closed panel");
});

test("component: the panel is opened explicitly and never auto-reads", async () => {
  const html = await renderCard(cardState({ open: false }));
  assert.equal(html.includes("الفصل الخريفي"), false);
  assert.equal(html.includes("فتح فترات الدراسة"), true);
});

test("component: every rendered button carries an explicit type", async () => {
  const html = await renderCard(cardState());
  for (const button of buttonsOf(html)) {
    assert.ok(
      button.includes('type="button"') || button.includes('type="submit"'),
      `every button needs an explicit type, saw ${button}`,
    );
  }
});

test("component: an open form has exactly ONE submit and every other control is type=button", async () => {
  const html = await renderCard(
    cardState({
      form: {
        ...cardState().form,
        mode: "create",
        nameDraft: "الفصل الشتوي",
        startsOnDraft: "2027-01-20",
        endsOnDraft: "2027-01-30",
      },
    }),
  );
  const buttons = buttonsOf(html);
  const submits = buttons.filter((button) => button.includes('type="submit"'));
  assert.equal(submits.length, 1, "exactly one submit control");
  assert.equal(buttons.length - submits.length, buttons.filter((b) => b.includes('type="button"')).length);
});

test("component: the close control is never disabled, even while a write is pending", async () => {
  const controller = createStubController(cardState({
    mutation: { status: "saving", kind: "edit", targetId: PERIOD_ID, error: null, notice: null },
  }));
  const controls = collectControls(await renderCardTree(controller));
  const close = controlByText(controls, "إغلاق اللوحة");
  assert.equal(Boolean(close.disabled), false, "a pending write never locks the panel shut");
  close.onClick();
  assert.deepEqual(controller.calls, ["close"], "the close control really closes");
});

test("component: the dates are rendered as date-only strings inside an ltr span", async () => {
  const html = await renderCard(cardState());
  assert.equal(html.includes('dir="ltr">2026-09-01<'), true, "the start date is a date-only string");
  assert.equal(html.includes('dir="ltr">2027-01-15<'), true, "the end date is a date-only string");
  assert.equal(/2026-09-01T/.test(html), false, "no date is rendered as an instant");
});

test("component: the planning-only limitation is stated on the card", async () => {
  const html = await renderCard(cardState());
  assert.equal(html.includes("لا تسجيل طلاب"), true);
  assert.equal(html.includes("ولا صلاحيات وصول"), true);
  assert.equal(html.includes("ولا انتقالات تلقائية بالتواريخ"), true);
});

test("component: the archived badge distinguishes the two states", async () => {
  const active = await renderCard(cardState());
  assert.equal(active.includes("نشطة"), true);
  const archived = await renderCard(cardState({ rows: [period({ is_archived: true })] }));
  assert.equal(archived.includes("مؤرشفة"), true);
});

test("component: the paging controls reflect the server state", async () => {
  const first = await renderCard(cardState());
  const firstControls = await renderCardTree(createStubController(cardState()));
  const previous = controlByText(collectControls(firstControls), "السابق");
  assert.equal(Boolean(previous.disabled), true, "there is no previous page on the first page");
  const next = controlByText(collectControls(firstControls), "التالي");
  assert.equal(Boolean(next.disabled), true, "there is no next page when has_more is false");

  const withMore = await renderCardTree(createStubController(cardState({
    pagination: { limit: 25, offset: 25, hasMore: true },
    hasPreviousPage: true,
  })));
  const controls = collectControls(withMore);
  assert.equal(Boolean(controlByText(controls, "السابق").disabled), false);
  assert.equal(Boolean(controlByText(controls, "التالي").disabled), false);
  assert.ok(first.length > 0);
});

test("component: the archived view toggle exposes its selected state", async () => {
  const html = await renderCard(cardState({ archivedView: true }));
  assert.equal(html.includes('aria-pressed="true"'), true, "the active view is announced");
  assert.equal(html.includes('aria-pressed="false"'), true);
});

test("component: an error, a notice and a confirmation are rendered in a live region", async () => {
  const html = await renderCard(cardState({
    mutation: { status: "uncertain", kind: "edit", targetId: PERIOD_ID, error: null, notice: ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE },
    lastConfirmed: period({ name: "محفوظ" }),
  }));
  assert.equal(html.includes('aria-live="polite"'), true);
  assert.equal(html.includes(ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE), true);
  assert.equal(html.includes("أكّد الخادم حفظ الفترة"), true);
});

test("component: the denial message is the server wording, not a local guess", async () => {
  const html = await renderCard(cardState({ phase: "denied", rows: [], error: "Forbidden" }));
  assert.equal(html.includes("الخادم هو المرجع"), true);
});

// ===========================================================================
// The real component — actual callbacks
// ===========================================================================

/** A controller-shaped stub whose methods record what the markup called. */
const createStubController = (snapshot: AcademicPeriodState) => {
  const calls: string[] = [];
  const controller = {
    getState: () => snapshot,
    subscribe: () => () => undefined,
    open: async () => { calls.push("open"); },
    close: () => { calls.push("close"); },
    refresh: async () => { calls.push("refresh"); },
    nextPage: async () => { calls.push("nextPage"); },
    previousPage: async () => { calls.push("previousPage"); },
    setArchivedView: async (archived: boolean) => { calls.push(`view:${archived}`); },
    openCreateForm: () => { calls.push("openCreateForm"); },
    openEditForm: (id: string) => { calls.push(`openEditForm:${id}`); },
    updateNameDraft: (value: string) => { calls.push(`name:${value}`); },
    updateStartsOnDraft: (value: string) => { calls.push(`starts:${value}`); },
    updateEndsOnDraft: (value: string) => { calls.push(`ends:${value}`); },
    cancelForm: () => { calls.push("cancelForm"); },
    create: async () => { calls.push("create"); },
    save: async () => { calls.push("save"); },
    setArchived: async (id: string, archived: boolean) => { calls.push(`archive:${id}:${archived}`); },
    reconcile: async () => { calls.push("reconcile"); },
    dispose: () => { calls.push("dispose"); },
    calls,
  };
  return controller;
};

test("component callback: the open control really calls open()", async () => {
  const controller = createStubController(cardState({ open: false }));
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "فتح فترات الدراسة").onClick();
  assert.deepEqual(controller.calls, ["open"]);
});

test("component callback: the archive control calls setArchived with the row and the flipped flag", async () => {
  const controller = createStubController(cardState());
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "أرشفة").onClick();
  assert.deepEqual(controller.calls, [`archive:${PERIOD_ID}:true`]);
});

test("component callback: the restore control calls setArchived with false", async () => {
  const controller = createStubController(cardState({ rows: [period({ is_archived: true })] }));
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "استعادة").onClick();
  assert.deepEqual(controller.calls, [`archive:${PERIOD_ID}:false`]);
});

test("component callback: the edit control opens the form for the row", async () => {
  const controller = createStubController(cardState());
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "تعديل").onClick();
  assert.deepEqual(controller.calls, [`openEditForm:${PERIOD_ID}`]);
});

test("component callback: the create control opens the create form", async () => {
  const controller = createStubController(cardState());
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "إضافة فترة").onClick();
  assert.deepEqual(controller.calls, ["openCreateForm"]);
});

test("component callback: the view toggle calls setArchivedView with the chosen view", async () => {
  const controller = createStubController(cardState());
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "المؤرشفة").onClick();
  assert.deepEqual(controller.calls, ["view:true"]);
});

test("component callback: the paging controls call nextPage and previousPage", async () => {
  const controller = createStubController(cardState({
    pagination: { limit: 25, offset: 25, hasMore: true },
    hasPreviousPage: true,
  }));
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "التالي").onClick();
  controlByText(controls, "السابق").onClick();
  assert.deepEqual(controller.calls, ["nextPage", "previousPage"]);
});

test("component callback: the refresh and close controls work", async () => {
  const controller = createStubController(cardState());
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "تحديث").onClick();
  controlByText(controls, "إغلاق اللوحة").onClick();
  assert.deepEqual(controller.calls, ["refresh", "close"]);
});

test("component callback: the form submit calls create in create mode and save in edit mode", async () => {
  const creating = createStubController(cardState({
    form: { ...cardState().form, mode: "create", nameDraft: "فصل", startsOnDraft: "2026-09-01", endsOnDraft: "2027-01-15" },
  }));
  const createTree = await renderCardTree(creating);
  const createSubmits = collectSubmits(createTree);
  assert.equal(createSubmits.length, 1, "the create form has exactly one submit");
  assert.equal(createSubmits[0].text, "إضافة الفترة");
  const createForms = collectForms(createTree);
  assert.equal(createForms.length, 1);
  createForms[0](submitEvent());
  assert.deepEqual(creating.calls, ["create"]);

  const editing = createStubController(cardState({
    form: { ...cardState().form, mode: "edit", nameDraft: "فصل", startsOnDraft: "2026-09-01", endsOnDraft: "2027-01-15" },
  }));
  const editTree = await renderCardTree(editing);
  const editSubmits = collectSubmits(editTree);
  assert.equal(editSubmits.length, 1, "the edit form has exactly one submit");
  assert.equal(editSubmits[0].text, "حفظ التعديل");
  collectForms(editTree)[0](submitEvent());
  assert.deepEqual(editing.calls, ["save"]);
});

test("component callback: the reconcile control is offered after an uncertain write", async () => {
  const controller = createStubController(cardState({
    mutation: { status: "uncertain", kind: "edit", targetId: PERIOD_ID, error: null, notice: ACADEMIC_PERIOD_WRITE_UNCERTAIN_MESSAGE },
  }));
  const controls = collectControls(await renderCardTree(controller));
  controlByText(controls, "قراءة الحالة الحالية").onClick();
  assert.deepEqual(controller.calls, ["reconcile"]);
});

test("component: no reconcile control is offered when the write is settled", async () => {
  const controller = createStubController(cardState());
  const controls = collectControls(await renderCardTree(controller));
  assert.equal(controls.some((control) => control.text === "قراءة الحالة الحالية"), false);
});

test("component: the form is disabled while a write is pending, but cancel stays available", async () => {
  const controller = createStubController(cardState({
    mutation: { status: "saving", kind: "edit", targetId: PERIOD_ID, error: null, notice: null },
    form: { ...cardState().form, mode: "edit", nameDraft: "فصل", startsOnDraft: "2026-09-01", endsOnDraft: "2027-01-15" },
  }));
  const tree = await renderCardTree(controller);
  const submits = collectSubmits(tree);
  assert.equal(submits.length, 1);
  assert.equal(Boolean(submits[0].disabled), true, "the submit is latched while saving");
  const controls = collectControls(tree);
  assert.equal(Boolean(controlByText(controls, "إلغاء").disabled), true, "cancel is latched with the form");
  assert.equal(Boolean(controlByText(controls, "إغلاق اللوحة").disabled), false, "the panel can always be closed");
});
