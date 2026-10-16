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
import type { InstructorBillingData } from "../lib/api";

// Inert api-http stub — only the pure helpers below are under test.
const API_STUB = [
  "export const getMyTenantBilling = async () => ({});",
  "export const submitInstructorTopup = async () => ({ id: 'topup', status: 'submitted' });",
  "export const getOwnTopupProofUrl = async () => ({ url: '', expires_in: 0 });",
  "export const requestManualRenewal = async () => ({ id: 'intent', status: 'pending' });",
  "export const cancelRenewalIntent = async () => ({ status: 'cancelled' });",
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
  createLoadSequence,
  createInFlightGuard,
} = await import("../pages/InstructorSubscription");

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

test("parseMinorUnits: unparseable or unsafe inputs collapse to 0", () => {
  assert.equal(parseMinorUnits(null), 0);
  assert.equal(parseMinorUnits(undefined), 0);
  assert.equal(parseMinorUnits(""), 0);
  assert.equal(parseMinorUnits("abc"), 0);
  assert.equal(parseMinorUnits("-5"), 0);
  assert.equal(parseMinorUnits("1.234"), 0); // more than two fraction digits
  assert.equal(parseMinorUnits(Number.NaN), 0);
  assert.equal(parseMinorUnits(Number.POSITIVE_INFINITY), 0);
});

test("formatMinorUnits: two-decimal currency string", () => {
  assert.equal(ascii(formatMinorUnits(15055)), "150.55 ج.م");
  assert.equal(ascii(formatMinorUnits(0)), "0.00 ج.م");
  assert.equal(ascii(formatMinorUnits(50)), "0.50 ج.م");
  // Non-finite / negative values must not leak a broken number into the UI.
  assert.equal(ascii(formatMinorUnits(Number.NaN)), "0.00 ج.م");
  assert.equal(ascii(formatMinorUnits(-5)), "0.00 ج.م");
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
  assert.deepEqual(state, { chargeMinor: 0, balanceMinor: 0, shortfallMinor: 0, inGrace: false, canRenewManually: false });
});

test("resolveGraceDeadlineMs: server_now is the authoritative countdown anchor", () => {
  const serverNow = "2026-01-01T00:00:00.000Z";
  assert.equal(resolveGraceDeadlineMs(serverNow, 3600, 999), Date.parse(serverNow) + 3600 * 1000);
});

test("resolveGraceDeadlineMs: falls back to the local clock only when server_now is unusable", () => {
  assert.equal(resolveGraceDeadlineMs(null, 60, 1000), 1000 + 60000);
  assert.equal(resolveGraceDeadlineMs("not-a-date", 60, 1000), 1000 + 60000);
  assert.equal(resolveGraceDeadlineMs(undefined, 60, 1000), 1000 + 60000);
});

test("resolveGraceDeadlineMs: no grace window means no deadline", () => {
  assert.equal(resolveGraceDeadlineMs("2026-01-01T00:00:00.000Z", 0, 5000), 0);
  assert.equal(resolveGraceDeadlineMs("2026-01-01T00:00:00.000Z", -5, 5000), 0);
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
