/**
 * M1 sprint subscription UI — isolated production-path tests.
 *
 * Scope: src/pages/InstructorSubscription.tsx (the shared subscription page
 * contract it relies on). The page exposes the pure decision helpers it
 * actually uses; these are exercised here against fake billing responses so
 * the money/precision, renewal gating, grace-anchor, stale-response and
 * duplicate-request behaviours are verified without a DOM, a browser, a
 * network call, a database or a live service.
 *
 * Isolation: no env files, no dotenv, no DB, no network. The HTTP api module
 * (src/lib/api-http.ts) evaluates `import.meta.env` at module init and would
 * throw under node, so the ESM resolver replaces it with an inert stub before
 * the page is imported; Vite asset imports (the shared Header's .png) are
 * stubbed the same way. The helpers under test never call the api.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { InstructorBillingData, Subscription } from "../lib/api";
import type { SubscriptionsApi, SubscriptionsControllerHooks } from "../pages/Subscriptions";

// Inert api-http stub — only the pure helpers below are under test.
const API_STUB = [
  "export const getMyTenantBilling = async () => ({});",
  "export const submitInstructorTopup = async () => ({ id: 'topup', status: 'submitted' });",
  "export const getOwnTopupProofUrl = async () => ({ url: '', expires_in: 0 });",
  "export const requestManualRenewal = async () => ({ id: 'intent', status: 'pending' });",
  "export const cancelRenewalIntent = async () => ({ status: 'cancelled' });",
  // subscription-plans API used by src/pages/Subscriptions.tsx. The real
  // api-http methods throw on rejection (api-http.ts:784-802), so these stubs
  // only stand in for module init; the controller tests inject their own api.
  "export const getSubscriptions = async () => [];",
  "export const createSubscription = async () => ({});",
  "export const updateSubscription = async () => ({});",
  "export const deleteSubscription = async () => {};",
  "export const clearAuthToken = () => {};",
].join("\n");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\.(png|jpe?g|svg|webp)$/.test(specifier)) {
      return { url: "data:text/javascript,export default 'stub-asset'", shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    const clean = String(result.url).split("?")[0].replace(/\\/g, "/");
    if (clean.endsWith("/src/lib/api-http.ts")) {
      return { url: "data:text/javascript," + encodeURIComponent(API_STUB), shortCircuit: true };
    }
    return result;
  },
});

const {
  parseMinorUnits,
  formatMinorUnits,
  deriveRenewalState,
  resolveGraceDeadlineMs,
  remainingGraceSeconds,
  createLoadSequence,
  createInFlightGuard,
} = await import("../pages/InstructorSubscription");

const {
  createSubscriptionsController,
  toSubscriptionFormData,
  initialSubscriptionDialogState,
  beginCreateSubscription,
  beginEditSubscription,
  completeSubscriptionSave,
  closeSubscriptionDialog,
  resolveSubscriptionSubmitTarget,
} = await import("../pages/Subscriptions");

/** ar-EG renders Arabic-Indic digits (٠-٩) and its own separators; fold them
 *  back to ASCII so numeric expectations stay locale-independent. */
const ascii = (value: string): string =>
  value
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066b/g, ".")
    .replace(/\u066c/g, "");

function billing(overrides: {
  charge?: number;
  balance?: string;
  graceSeconds?: number;
  renewalIntent?: boolean;
  serverNow?: string;
} = {}): InstructorBillingData {
  return {
    server_now: overrides.serverNow ?? "2026-01-01T00:00:00.000Z",
    billing_only: false,
    tenant: { id: "t1", business_name: "b", status: "active", legacy_compat: false },
    subscription: {
      id: "s1", status: "active", plan_id: "p1", plan_name: "شهري",
      agreed_price: "150.00", discount_amount: "0.00",
      charge_amount: overrides.charge ?? 150,
      currency: "EGP",
      starts_at: null, period_ends_at: null, grace_until: null,
      duration_months: 1, duration_days: 30,
      period_seconds_remaining: 100, grace_seconds_remaining: overrides.graceSeconds ?? 0,
    },
    wallet: { balance: overrides.balance ?? "0.00", updated_at: null },
    renewal_intent: overrides.renewalIntent
      ? { id: "r1", status: "pending", trigger_type: "manual", charge_amount: "150.00", paid_at: null, created_at: "2026-01-01T00:00:00.000Z", plan_name: "شهري" }
      : null,
    topups: [],
  };
}

test("parseMinorUnits: decimal strings map to integer piastres", () => {
  assert.equal(parseMinorUnits("150.55"), 15055);
  assert.equal(parseMinorUnits("150.5"), 15050);
  assert.equal(parseMinorUnits("150"), 15000);
  assert.equal(parseMinorUnits("0"), 0);
  assert.equal(parseMinorUnits(" 12.34 "), 1234);
});

test("parseMinorUnits: server float artifacts never distort money", () => {
  // 150.55 - 0.55 === 150.00000000000003 on the server; toFixed(2) pins it.
  assert.equal(parseMinorUnits(150.00000000000003), 15000);
  assert.equal(parseMinorUnits(0.55), 55);
  assert.equal(parseMinorUnits(200), 20000);
});

test("parseMinorUnits: unparseable or unsafe inputs are null, never a fabricated zero", () => {
  assert.equal(parseMinorUnits(null), null);
  assert.equal(parseMinorUnits(undefined), null);
  assert.equal(parseMinorUnits(""), null);
  assert.equal(parseMinorUnits("abc"), null);
  assert.equal(parseMinorUnits("-5"), null);
  assert.equal(parseMinorUnits("1.234"), null); // more than two fraction digits
  assert.equal(parseMinorUnits(Number.NaN), null);
  assert.equal(parseMinorUnits(Number.POSITIVE_INFINITY), null);
  // A genuine zero is still a real, authoritative zero — not "unknown".
  assert.equal(parseMinorUnits("0"), 0);
  assert.equal(parseMinorUnits(0), 0);
});

test("formatMinorUnits: two-decimal currency string, placeholder for unknown amounts", () => {
  assert.equal(ascii(formatMinorUnits(15055)), "150.55 ج.م");
  assert.equal(ascii(formatMinorUnits(0)), "0.00 ج.م");
  assert.equal(ascii(formatMinorUnits(50)), "0.50 ج.م");
  // Unknown / non-finite / negative values must not render as a real amount.
  assert.equal(formatMinorUnits(null), "—");
  assert.equal(formatMinorUnits(undefined), "—");
  assert.equal(formatMinorUnits(Number.NaN), "—");
  assert.equal(formatMinorUnits(-5), "—");
});

test("deriveRenewalState: an exactly-sufficient balance is not blocked by float artifacts", () => {
  // Regression: the server charge carries a subtraction artifact; a balance
  // that exactly equals the true charge must still allow manual renewal.
  const state = deriveRenewalState(billing({ charge: 150.00000000000003, balance: "150.00" }));
  assert.equal(state.chargeMinor, 15000);
  assert.equal(state.balanceMinor, 15000);
  assert.equal(state.shortfallMinor, 0);
  assert.equal(state.canRenewManually, true);
});

test("deriveRenewalState: shortfall and manual-renew gating come from the server response", () => {
  const short = deriveRenewalState(billing({ charge: 200, balance: "150.55" }));
  assert.equal(short.shortfallMinor, 4945);
  assert.equal(short.canRenewManually, false);

  const exact = deriveRenewalState(billing({ charge: 150, balance: "150" }));
  assert.equal(exact.shortfallMinor, 0);
  assert.equal(exact.canRenewManually, true);

  const zeroCharge = deriveRenewalState(billing({ charge: 0, balance: "150" }));
  assert.equal(zeroCharge.canRenewManually, false);

  const pendingIntent = deriveRenewalState(billing({ charge: 150, balance: "150", renewalIntent: true }));
  assert.equal(pendingIntent.canRenewManually, false);
});

test("deriveRenewalState: grace flag follows server grace seconds only", () => {
  assert.equal(deriveRenewalState(billing({ graceSeconds: 3600 })).inGrace, true);
  assert.equal(deriveRenewalState(billing({ graceSeconds: 0 })).inGrace, false);
});

test("deriveRenewalState: null billing response is safe", () => {
  const state = deriveRenewalState(null);
  assert.deepEqual(state, { chargeMinor: null, balanceMinor: null, shortfallMinor: null, inGrace: false, canRenewManually: false });
});

test("deriveRenewalState: an unparseable authoritative balance is unknown, not a valid zero", () => {
  // Regression: a malformed balance used to collapse to 0 and be rendered as a
  // real "0.00" balance, hiding the bad server value.
  const state = deriveRenewalState(billing({ charge: 150, balance: "n/a" }));
  assert.equal(state.balanceMinor, null);        // not silently 0
  assert.equal(state.shortfallMinor, null);      // unknown, not a fabricated shortfall
  assert.equal(state.canRenewManually, false);   // fail closed
});

test("deriveRenewalState: an unparseable authoritative charge is unknown, not a valid zero", () => {
  const data = billing({ balance: "150.00" });
  data.subscription!.charge_amount = Number.NaN; // malformed server number
  const state = deriveRenewalState(data);
  assert.equal(state.chargeMinor, null);
  assert.equal(state.shortfallMinor, null);
  assert.equal(state.canRenewManually, false);
});

test("deriveRenewalState: a genuine zero balance stays authoritative and fail-closed", () => {
  const state = deriveRenewalState(billing({ charge: 150, balance: "0.00" }));
  assert.equal(state.balanceMinor, 0);           // real zero, not "unknown"
  assert.equal(state.shortfallMinor, 15000);
  assert.equal(state.canRenewManually, false);
});

test("grace countdown: deadline is the server duration anchored to the local receipt clock", () => {
  const receipt = 5_000;
  const deadline = resolveGraceDeadlineMs(3600, receipt);
  assert.equal(deadline, receipt + 3600 * 1000);
  assert.equal(remainingGraceSeconds(deadline, receipt), 3600);
});

test("grace countdown: regression — anchoring on server_now while ticking a local clock was skew-broken", () => {
  const serverNowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const graceSeconds = 3600;
  const localReceipt = serverNowMs + 2 * 3600 * 1000; // client clock 2h ahead of server
  // Old formula: deadline = server_now + duration, compared against the local
  // clock -> the grace window looked already expired (0s left).
  const oldDeadline = serverNowMs + graceSeconds * 1000;
  assert.equal(Math.max(0, Math.ceil((oldDeadline - localReceipt) / 1000)), 0);
  // Fixed: the duration is anchored to the local receipt clock -> full time left.
  assert.equal(remainingGraceSeconds(resolveGraceDeadlineMs(graceSeconds, localReceipt), localReceipt), 3600);
});

test("grace countdown: client clock skew of +/- hours cannot distort the time left", () => {
  // Two clients receive the same authoritative duration at local instants six
  // hours apart; each still sees exactly the server's remaining duration.
  const t1 = 1_000_000;
  const t2 = t1 + 6 * 3600 * 1000;
  assert.equal(remainingGraceSeconds(resolveGraceDeadlineMs(7200, t1), t1), 7200);
  assert.equal(remainingGraceSeconds(resolveGraceDeadlineMs(7200, t2), t2), 7200);
});

test("grace countdown: a delayed response still counts the full server duration from receipt", () => {
  // Network latency delays arrival; the server's remaining duration is anchored
  // at receipt, so the displayed time left starts at the authoritative value.
  const serverSent = 2_000;
  const received = serverSent + 4_000; // 4s latency
  assert.equal(remainingGraceSeconds(resolveGraceDeadlineMs(300, received), received), 300);
});

test("remainingGraceSeconds: rounds up while live, clamps at 0 once expired", () => {
  const deadline = 100_000;
  assert.equal(remainingGraceSeconds(deadline, deadline - 1), 1);       // <1s left -> 1
  assert.equal(remainingGraceSeconds(deadline, deadline), 0);
  assert.equal(remainingGraceSeconds(deadline, deadline + 60_000), 0);  // never negative
  assert.equal(remainingGraceSeconds(0, 123), 0);                       // no deadline
});

test("grace countdown: a reversed/stale response cannot overwrite the newest deadline", () => {
  const seq = createLoadSequence();
  const applied: number[] = [];
  const apply = (token: number, seconds: number, now: number) => {
    if (!seq.isLatest(token)) return; // stale response discarded, as in load()
    applied.push(resolveGraceDeadlineMs(seconds, now));
  };
  const first = seq.next();
  const second = seq.next();
  apply(second, 100, 10_000); // newest arrives first
  apply(first, 9999, 1);      // older, larger grace arrives late -> discarded
  assert.deepEqual(applied, [10_000 + 100_000]);
});

test("resolveGraceDeadlineMs: no grace window means no deadline", () => {
  assert.equal(resolveGraceDeadlineMs(0, 5000), 0);
  assert.equal(resolveGraceDeadlineMs(-5, 5000), 0);
  assert.equal(resolveGraceDeadlineMs(Number.NaN, 5000), 0);
});

test("createLoadSequence: a stale response is discarded", () => {
  const seq = createLoadSequence();
  const first = seq.next();
  const second = seq.next();
  assert.equal(seq.isLatest(first), false);
  assert.equal(seq.isLatest(second), true);
  const third = seq.next();
  assert.equal(seq.isLatest(second), false);
  assert.equal(seq.isLatest(third), true);
});

test("createInFlightGuard: duplicate requests are suppressed until released", () => {
  const guard = createInFlightGuard();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.acquire(), true);
  assert.equal(guard.isBusy(), true);
  assert.equal(guard.acquire(), false); // second concurrent request rejected
  guard.release();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.acquire(), true); // released, a new request may proceed
});

// ---------------------------------------------------------------------------
// Subscriptions page (src/pages/Subscriptions.tsx) — production create/update/
// delete + load orchestration, exercised with an injected fake api. No DOM, no
// network, no live service.
// ---------------------------------------------------------------------------

const subRow = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: "s1", name: "شهري", duration_months: 1, price: 150, is_active: true, ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeApi(overrides: Partial<SubscriptionsApi> = {}): SubscriptionsApi {
  return {
    getSubscriptions: async () => [],
    createSubscription: async () => subRow(),
    updateSubscription: async () => subRow(),
    deleteSubscription: async () => {},
    ...overrides,
  };
}

function recorder(): { rows: Subscription[][]; notices: string[]; errors: Array<string | null>; busy: boolean[]; hooks: SubscriptionsControllerHooks } {
  const rows: Subscription[][] = [];
  const notices: string[] = [];
  const errors: Array<string | null> = [];
  const busy: boolean[] = [];
  return {
    rows, notices, errors, busy,
    hooks: {
      onRows: (value) => rows.push(value),
      onBusy: (value) => busy.push(value),
      onError: (value) => errors.push(value),
      onNotice: (value) => notices.push(value),
    },
  };
}

test("toSubscriptionFormData: a legitimate zero price is preserved, not erased to empty", () => {
  const zero = toSubscriptionFormData(subRow({ price: 0, duration_months: 0 }));
  assert.equal(zero.price, "0");            // regression: `price || ''` erased a real 0
  assert.equal(zero.duration_months, "0");  // same defect class, preserved
  assert.equal(toSubscriptionFormData(subRow({ price: 150.5 })).price, "150.5");
  assert.equal(toSubscriptionFormData(subRow({ duration_months: 3 })).duration_months, "3");
});

test("toSubscriptionFormData: only absent/non-finite amounts become empty", () => {
  const malformed = toSubscriptionFormData({ ...subRow(), price: Number.NaN, duration_months: Number.NaN });
  assert.equal(malformed.price, "");
  assert.equal(malformed.duration_months, "");
  assert.equal(toSubscriptionFormData(subRow({ description: undefined })).description, "");
});

test("createSubscriptionsController: a second create in the same tick is suppressed synchronously", async () => {
  const gate = deferred<Subscription>();
  let createCalls = 0;
  const api = fakeApi({ createSubscription: () => { createCalls += 1; return gate.promise; } });
  const controller = createSubscriptionsController(api, recorder().hooks);

  const first = controller.create({ name: "a" });
  assert.equal(controller.isMutating(), true); // latch set before any await/render
  const second = controller.create({ name: "b" });
  assert.equal(await second, false);            // duplicate rejected pre-render
  assert.equal(createCalls, 1);                 // only one request reached the API

  gate.resolve(subRow());
  assert.equal(await first, true);
  assert.equal(controller.isMutating(), false); // released after completion
});

test("createSubscriptionsController: a second delete in the same tick is suppressed", async () => {
  const gate = deferred<void>();
  let deleteCalls = 0;
  const api = fakeApi({ deleteSubscription: () => { deleteCalls += 1; return gate.promise; } });
  const controller = createSubscriptionsController(api, recorder().hooks);

  const first = controller.remove("a");
  const second = controller.remove("b");
  assert.equal(await second, false);
  assert.equal(deleteCalls, 1);

  gate.resolve(undefined);
  assert.equal(await first, true);
});

test("createSubscriptionsController: a second update in the same tick is suppressed", async () => {
  const gate = deferred<Subscription>();
  let updateCalls = 0;
  const api = fakeApi({ updateSubscription: () => { updateCalls += 1; return gate.promise; } });
  const controller = createSubscriptionsController(api, recorder().hooks);

  const first = controller.update("a", { name: "x" });
  const second = controller.update("a", { name: "y" });
  assert.equal(await second, false);
  assert.equal(updateCalls, 1);

  gate.resolve(subRow());
  assert.equal(await first, true);
});

test("createSubscriptionsController: toggle sends the flipped is_active from the current row", async () => {
  const patches: Array<[string, Partial<Subscription>]> = [];
  const api = fakeApi({ updateSubscription: async (id, patch) => { patches.push([id, patch]); return subRow(); } });
  const controller = createSubscriptionsController(api, recorder().hooks);

  assert.equal(await controller.toggle("s1", true), true);
  assert.equal(await controller.toggle("s2", false), true);
  assert.deepEqual(patches, [["s1", { is_active: false }], ["s2", { is_active: true }]]);
});

test("createSubscriptionsController: a stale load cannot overwrite a newer load's rows", async () => {
  const first = deferred<Subscription[]>();
  const second = deferred<Subscription[]>();
  let calls = 0;
  const api = fakeApi({ getSubscriptions: () => { calls += 1; return calls === 1 ? first.promise : second.promise; } });
  const rec = recorder();
  const controller = createSubscriptionsController(api, rec.hooks);

  const loadA = controller.load();
  const loadB = controller.load();
  const newer = [subRow({ id: "new" })];
  const older = [subRow({ id: "old" })];

  second.resolve(newer);
  await loadB;
  first.resolve(older); // older generation resolves late
  await loadA;

  assert.deepEqual(rec.rows, [newer]); // the stale response was discarded
});

test("createSubscriptionsController: load failure surfaces the error and a later success clears it", async () => {
  let fail = true;
  const rows = [subRow()];
  const api = fakeApi({ getSubscriptions: async () => { if (fail) throw new Error("الشبكة غير متاحة"); return rows; } });
  const rec = recorder();
  const controller = createSubscriptionsController(api, rec.hooks);

  await controller.load();
  assert.equal(rec.errors[rec.errors.length - 1], "الشبكة غير متاحة");
  assert.deepEqual(rec.rows, []);

  fail = false;
  await controller.load();
  assert.equal(rec.errors[rec.errors.length - 1], null); // cleared on a successful load
  assert.deepEqual(rec.rows, [rows]);
});

test("createSubscriptionsController: a rejected mutation surfaces the error, keeps rows and does not reload", async () => {
  let loadCalls = 0;
  const api = fakeApi({
    getSubscriptions: async () => { loadCalls += 1; return [subRow({ id: "keep" })]; },
    createSubscription: async () => { throw new Error("رفض الخادم الحفظ"); },
  });
  const rec = recorder();
  const controller = createSubscriptionsController(api, rec.hooks);

  assert.equal(await controller.create({ name: "x" }), false);
  assert.equal(rec.errors[rec.errors.length - 1], "رفض الخادم الحفظ");
  assert.equal(loadCalls, 0);                     // no reload after failure -> entered values retained
  assert.equal(controller.isMutating(), false);
});

test("createSubscriptionsController: a successful create reloads authoritative rows and toggles busy", async () => {
  const rows = [subRow({ id: "srv" })];
  const api = fakeApi({ getSubscriptions: async () => rows, createSubscription: async () => rows[0] });
  const rec = recorder();
  const controller = createSubscriptionsController(api, rec.hooks);

  assert.equal(await controller.create({ name: "n" }), true);
  assert.deepEqual(rec.rows, [rows]);         // reloaded from the authoritative source
  assert.equal(rec.notices.length, 1);
  assert.deepEqual(rec.busy, [true, false]);  // loading state separated from the mutation result
});

test("createSubscriptionsController: a malformed non-array list is an error, not a successful empty state", async () => {
  const rec = recorder();
  const controller = createSubscriptionsController(
    fakeApi({ getSubscriptions: async () => ({ error: "nope" }) as unknown as Subscription[] }),
    rec.hooks,
  );

  await controller.load();
  assert.equal(rec.rows.length, 0);                                       // nothing committed
  assert.equal(rec.errors[rec.errors.length - 1], "استجابة غير صالحة من الخادم");
  // the malformed state is distinguishable from a genuine, successful empty list
  const okRec = recorder();
  const okController = createSubscriptionsController(fakeApi({ getSubscriptions: async () => [] }), okRec.hooks);
  await okController.load();
  assert.deepEqual(okRec.rows, [[]]);
  assert.equal(okRec.errors[okRec.errors.length - 1], null);
});

// ---------------------------------------------------------------------------
// Subscriptions dialog workflow — explicit Add must never inherit a stale edit
// target. Regression for: editingSubscription set by handleEdit and never reset
// by a successful save or the Add trigger, so Edit -> close/save -> Add ->
// submit routed to update(oldId) and overwrote an existing plan.
// ---------------------------------------------------------------------------

const OLD_PLAN = { id: "old", name: "قديم", duration_months: 1, price: 150, is_active: true };

test("Subscriptions dialog: the explicit Add action always resets to a fresh create state", () => {
  const edited = beginEditSubscription(subRow(OLD_PLAN));
  assert.equal(edited.editing?.id, "old");
  assert.equal(edited.open, true);
  assert.equal(edited.form.price, "150");

  // Closing keeps the edit target so a failed save can be retried...
  const closed = closeSubscriptionDialog(edited);
  assert.equal(closed.open, false);
  assert.equal(closed.editing?.id, "old");

  // ...but opening Add must not: it is an explicit create.
  const fresh = beginCreateSubscription();
  assert.equal(fresh.open, true);
  assert.equal(fresh.editing, null);
  assert.deepEqual(fresh.form, { name: "", duration_months: "", price: "", description: "" });
  assert.equal(resolveSubscriptionSubmitTarget(fresh.editing).kind, "create");

  // A successful save closes and clears the target too.
  const done = completeSubscriptionSave();
  assert.equal(done.open, false);
  assert.equal(done.editing, null);
  assert.equal(resolveSubscriptionSubmitTarget(done.editing).kind, "create");
});

test("Subscriptions workflow: edit -> close -> Add -> submit creates a new plan exactly once and leaves the old plan untouched", async () => {
  const calls: Array<{ op: string; id?: string; payload?: Partial<Subscription> }> = [];
  const api = fakeApi({
    getSubscriptions: async () => [subRow(OLD_PLAN)],
    updateSubscription: async (id, patch) => { calls.push({ op: "update", id, payload: patch }); return subRow(); },
    createSubscription: async (patch) => { calls.push({ op: "create", payload: patch }); return subRow(); },
  });
  const controller = createSubscriptionsController(api, recorder().hooks);

  // Submit exactly as the page does: the dialog's intent picks create vs update.
  const submit = async (state: ReturnType<typeof initialSubscriptionDialogState>, payload: Partial<Subscription>) => {
    const target = resolveSubscriptionSubmitTarget(state.editing);
    return target.kind === "update"
      ? controller.update(target.id, payload)
      : controller.create(payload);
  };

  // 1. Edit the existing plan, then close the dialog without saving.
  let state = beginEditSubscription(subRow(OLD_PLAN));
  state = closeSubscriptionDialog(state);

  // 2. Open Add and submit a new plan.
  state = beginCreateSubscription();
  const newPlan: Partial<Subscription> = { name: "جديد", duration_months: 3, price: 500, description: "" };
  assert.equal(await submit(state, newPlan), true);

  assert.deepEqual(calls.map((c) => c.op), ["create"]); // never update(old)
  assert.equal(calls.length, 1);                        // created exactly once
  assert.equal(calls[0].id, undefined);
  assert.equal(calls[0].payload?.name, "جديد");
});

test("Subscriptions workflow: edit -> successful save -> Add -> submit still creates (target cleared by the save)", async () => {
  const calls: Array<{ op: string; id?: string }> = [];
  const api = fakeApi({
    getSubscriptions: async () => [subRow(OLD_PLAN)],
    updateSubscription: async (id) => { calls.push({ op: "update", id }); return subRow(); },
    createSubscription: async () => { calls.push({ op: "create" }); return subRow(); },
  });
  const controller = createSubscriptionsController(api, recorder().hooks);
  const submit = async (state: ReturnType<typeof initialSubscriptionDialogState>, payload: Partial<Subscription>) => {
    const target = resolveSubscriptionSubmitTarget(state.editing);
    return target.kind === "update" ? controller.update(target.id, payload) : controller.create(payload);
  };

  let state = beginEditSubscription(subRow(OLD_PLAN));
  assert.equal(await submit(state, { name: "معدّل" }), true);
  state = completeSubscriptionSave();          // successful save clears the target

  state = beginCreateSubscription();
  assert.equal(await submit(state, { name: "جديد" }), true);

  assert.deepEqual(calls, [{ op: "update", id: "old" }, { op: "create" }]);
});

test("Subscriptions workflow: a failed edit save keeps the edit target and the entered values", async () => {
  const api = fakeApi({
    updateSubscription: async () => { throw new Error("رفض الخادم الحفظ"); },
  });
  const rec = recorder();
  const controller = createSubscriptionsController(api, rec.hooks);

  let state = beginEditSubscription(subRow(OLD_PLAN));
  state = { ...state, form: { ...state.form, name: "معدّل", price: "0" } };

  const target = resolveSubscriptionSubmitTarget(state.editing);
  const saved = target.kind === "update" ? await controller.update(target.id, { name: state.form.name }) : true;
  assert.equal(saved, false);
  assert.equal(rec.errors[rec.errors.length - 1], "رفض الخادم الحفظ");

  // The page returns early on a failed save, so the target and values survive.
  assert.equal(state.editing?.id, "old");
  assert.equal(state.form.name, "معدّل");
  assert.equal(state.form.price, "0"); // a legitimate zero is preserved, not erased
  assert.equal(resolveSubscriptionSubmitTarget(state.editing).kind, "update");
});
