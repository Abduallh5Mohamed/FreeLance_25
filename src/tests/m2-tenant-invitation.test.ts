/**
 * M2-01 tenant invitation activation — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production orchestration seam src/pages/TenantInvitation.tsx
 * delegates to — `createTenantActivationController`, `parseFragmentToken` and
 * `validateTenantActivation` in src/features/enrollment/workflows.ts. No
 * copied orchestration, no DOM/browser, no env files, no DB, no network, no
 * live services; the redeem transport is an injected fake.
 *
 * Behaviours pinned (M2-CONTRACTS.md §1.7, verified from
 * server/src/routes/tenant-invitations.ts):
 *  - exactly one redeem request per activation: the synchronous latch is
 *    acquired before the first await, so a duplicate fired before the
 *    re-render (double click, double Enter) never reaches the transport;
 *  - only the server's `{ success: true }` activates — anything else fails
 *    closed; success is never inferred from client state;
 *  - 400/404/500 server messages are surfaced verbatim (the shared client
 *    throws the message, not the status);
 *  - validation errors never fire a request;
 *  - the fragment token is read live (lifecycle guard) and never logged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TENANT_INVITATION_NOT_FOUND_MESSAGE,
  createTenantActivationController,
  parseFragmentToken,
  validateTenantActivation,
  type TenantActivationApi,
  type TenantActivationState,
} from "../features/enrollment/workflows";

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

const RECORDED_PASSWORD = "activation-password-1234";

interface RedeemRecorder {
  calls: Array<{ token: string; password: string; deferred: Deferred<{ success?: boolean }> }>;
  api: TenantActivationApi;
}

function createRedeemApi(token = "a".repeat(64)): RedeemRecorder & { setToken: (value: string) => void } {
  const calls: RedeemRecorder["calls"] = [];
  let current = token;
  return {
    calls,
    setToken: (value: string) => {
      current = value;
    },
    api: {
      redeem: (redeemToken, password) => {
        const d = deferred<{ success?: boolean }>();
        calls.push({ token: redeemToken, password, deferred: d });
        return d.promise;
      },
      readToken: () => current,
    },
  };
}

test("fragment token parsing preserves the page's exact semantics", () => {
  assert.equal(parseFragmentToken("#token=abc123"), "abc123");
  assert.equal(parseFragmentToken("#token="), "");
  assert.equal(parseFragmentToken(""), "");
  assert.equal(parseFragmentToken("#token=abc&other=1"), "abc");
  assert.equal(parseFragmentToken("token=abc"), "abc");
  assert.equal(parseFragmentToken("#/invite?token=abc"), "", "a path fragment is not a token query");
});

test("client validation mirrors the server's declared bounds without inventing policy", () => {
  assert.equal(validateTenantActivation("", "x".repeat(12), "x".repeat(12)), "رابط الدعوة غير مكتمل.");
  assert.equal(validateTenantActivation("t", "short", "short"), "كلمة المرور يجب ألا تقل عن 12 حرفًا.");
  assert.equal(validateTenantActivation("t", "x".repeat(129), "x".repeat(129)), "كلمة المرور يجب ألا تزيد عن 128 حرفًا.");
  assert.equal(validateTenantActivation("t", "x".repeat(12), "y".repeat(12)), "كلمتا المرور غير متطابقتين.");
  assert.equal(validateTenantActivation("t", "x".repeat(12), "x".repeat(12)), null);
});

test("a duplicate activation fired before render never reaches the transport", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);
  const states: TenantActivationState["status"][] = [];
  controller.subscribe((state) => states.push(state.status));

  const first = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  const duplicate = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  assert.equal(recorder.calls.length, 1, "exactly one redeem request per activation");
  assert.equal(await duplicate, "duplicate");
  assert.equal(controller.getState().status, "activating");

  recorder.calls[0].deferred.resolve({ success: true });
  assert.equal(await first, "activated");
  assert.equal(controller.getState().status, "activated");
  assert.deepEqual(states, ["activating", "activated"]);

  // A completed activation can never be replayed.
  assert.equal(await controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD), "blocked");
  assert.equal(recorder.calls.length, 1);
});

test("only the server's success flag activates; anything else fails closed", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);

  const failed = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.calls[0].deferred.resolve({ success: false });
  assert.equal(await failed, "failed");
  assert.equal(controller.getState().status, "failed");
  assert.equal(controller.getState().message, "تعذر تفعيل الدعوة");

  const confirmed = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  assert.equal(recorder.calls.length, 2, "a failed activation stays retryable");
  recorder.calls[1].deferred.resolve({ success: true });
  assert.equal(await confirmed, "activated");
  assert.equal(controller.getState().message, null);
});

test("server rejections surface the server's own message", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);

  const expired = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.calls[0].deferred.reject(new Error(TENANT_INVITATION_NOT_FOUND_MESSAGE));
  assert.equal(await expired, "failed");
  assert.equal(controller.getState().status, "failed");
  assert.equal(controller.getState().message, TENANT_INVITATION_NOT_FOUND_MESSAGE);
  assert.equal(controller.getState().failure?.kind, "expired");

  const invalid = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.calls[1].deferred.reject(new Error("Valid invitation token and password of at least 12 characters are required"));
  assert.equal(await invalid, "failed");
  assert.equal(controller.getState().message, "Valid invitation token and password of at least 12 characters are required");
  assert.equal(controller.getState().failure?.kind, "error");
});

test("validation errors never fire a redeem request", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);

  assert.equal(await controller.activate(RECORDED_PASSWORD, "different-password"), "invalid");
  assert.equal(await controller.activate("short", "short"), "invalid");
  assert.equal(recorder.calls.length, 0);
  assert.match(controller.getState().message ?? "", /12/);
  assert.equal(controller.getState().status, "form");
});

test("an incomplete link is reported without a request", async () => {
  const recorder = createRedeemApi("");
  const controller = createTenantActivationController(recorder.api);
  assert.equal(controller.getState().token, "");
  assert.equal(await controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD), "invalid");
  assert.equal(recorder.calls.length, 0);
  assert.equal(controller.getState().message, "رابط الدعوة غير مكتمل.");
});

test("the fragment token is re-read live before activation", async () => {
  const recorder = createRedeemApi("a".repeat(64));
  const controller = createTenantActivationController(recorder.api);

  // Lifecycle guard: the URL fragment changed after mount (token rotation by
  // the sender). The controller re-reads it and uses the new token.
  recorder.setToken("b".repeat(64));
  controller.syncToken();
  assert.equal(controller.getState().token, "b".repeat(64));

  const activating = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  assert.equal(recorder.calls[0].token, "b".repeat(64));
  recorder.calls[0].deferred.resolve({ success: true });
  assert.equal(await activating, "activated");
});

test("no activation fires after unmount", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);
  controller.dispose();
  assert.equal(await controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD), "blocked");
  assert.equal(recorder.calls.length, 0);
});

test("a superseded activation never activates a different fragment token", async () => {
  const recorder = createRedeemApi("a".repeat(64));
  const controller = createTenantActivationController(recorder.api);

  const activating = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].token, "a".repeat(64));

  // The fragment changed while the redeem was in flight: A belongs to the old
  // link, so B must not become activated and must not have its URL wiped.
  recorder.setToken("b".repeat(64));
  controller.syncToken();
  recorder.calls[0].deferred.resolve({ success: true });

  assert.equal(await activating, "blocked");
  assert.notEqual(controller.getState().status, "activated");
  assert.equal(controller.getState().token, "b".repeat(64));
  assert.equal(controller.getState().status, "form", "the new fragment is not stuck on the retired attempt");
  assert.equal(controller.getState().message, null);
});

test("a fragment that returns to the same text still retires the old activation", async () => {
  const recorder = createRedeemApi("tokenA");
  const controller = createTenantActivationController(recorder.api);

  const activating = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.setToken("tokenB");
  controller.syncToken();
  recorder.setToken("tokenA");
  controller.syncToken();

  recorder.calls[0].deferred.resolve({ success: true });
  assert.equal(await activating, "blocked", "A -> B -> A must not revive the old incarnation");
  assert.notEqual(controller.getState().status, "activated");
});

test("a superseded activation failure does not surface an error for the new fragment", async () => {
  const recorder = createRedeemApi("a".repeat(64));
  const controller = createTenantActivationController(recorder.api);

  const activating = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.setToken("b".repeat(64));
  controller.syncToken();
  recorder.calls[0].deferred.reject(new Error(TENANT_INVITATION_NOT_FOUND_MESSAGE));

  assert.equal(await activating, "blocked");
  assert.equal(controller.getState().message, null, "B is never blamed for A's failure");
  assert.equal(controller.getState().status, "form");
  assert.equal(controller.getState().failure, null);
});

test("a retired activation does not block the new fragment's activation", async () => {
  const recorder = createRedeemApi("a".repeat(64));
  const controller = createTenantActivationController(recorder.api);

  const stale = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.setToken("b".repeat(64));
  controller.syncToken();

  const current = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  assert.equal(recorder.calls.length, 2, "the new fragment activates immediately");
  assert.equal(recorder.calls[1].token, "b".repeat(64));

  recorder.calls[1].deferred.resolve({ success: true });
  assert.equal(await current, "activated");

  // The retired attempt settles last: it must neither commit nor release the
  // newer activation's latch.
  recorder.calls[0].deferred.resolve({ success: true });
  assert.equal(await stale, "blocked");
  assert.equal(controller.getState().status, "activated");
  assert.equal(controller.getState().token, "b".repeat(64));
});

test("dispose during activation: the late redeem never commits", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);
  const activating = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  controller.dispose();
  recorder.calls[0].deferred.resolve({ success: true });
  assert.equal(await activating, "blocked");
  assert.notEqual(controller.getState().status, "activated");
});

test("the redeem payload carries the token and password exactly once per attempt", async () => {
  const recorder = createRedeemApi();
  const controller = createTenantActivationController(recorder.api);
  const activating = controller.activate(RECORDED_PASSWORD, RECORDED_PASSWORD);
  recorder.calls[0].deferred.resolve({ success: true });
  await activating;
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].token, "a".repeat(64));
  assert.equal(recorder.calls[0].password, RECORDED_PASSWORD);
});
