/**
 * M1 reactive session/identity/scope contract — hermetic bus + real writer
 * tests.
 *
 * Runner: node:test via tsx (`npx tsx --test src/tests/m1-session-contract.test.ts`).
 * No DOM/jsdom, no env files, no database, no network, no live services, no
 * application startup.
 *
 * Scope of production code exercised: the shared same-document notification
 * contract `src/lib/session-events.ts` (supervisor/026, task
 * client-m1-contract-session-20261017-01) — the module the canonical
 * token/identity/scope writers in api-http.ts, the header logout paths,
 * useSecuritySupervisor, SecureVideoPlayer and StudentSpaces publish to, and
 * that AuthGuard, Header, the meeting pages and SecureVideoPlayer subscribe
 * to. The REAL api-http canonical writers (signIn, signUp, setAuthToken,
 * clearAuthToken, selectStudentSpace) are exercised with an injected
 * in-memory localStorage and a stubbed fetch transport — bus dispatch alone
 * is not accepted as proof of the integration (supervisor/029).
 *
 * The contract rules pinned here:
 *  - the event detail carries ONLY the change kind — never a token, user,
 *    private link or any other secret (subscribers re-read canonical storage);
 *  - a notification reaches every current subscriber synchronously, so a
 *    same-document mutation invalidates cached state before a stale response
 *    can commit;
 *  - unsubscribe is honoured immediately, so a retired view never reacts;
 *  - a throwing subscriber can never break the mutation that just completed
 *    or the other subscribers;
 *  - no storage, polling or global monkeypatching: the module is inert
 *    between notifications;
 *  - login is atomic: a subscriber NEVER observes a token without its
 *    identity, and a bare token write never notifies;
 *  - the token-rotation writer (selectStudentSpace) notifies AFTER its
 *    complete mutation, even when the caller's identity update later fails.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
    notifySessionChange,
    subscribeSessionChange,
    type SessionChangeKind,
} from "../lib/session-events";
import {
    clearAuthToken,
    selectStudentSpace,
    setAuthToken,
    signIn,
} from "../lib/api-http";

// ---------------------------------------------------------------------------
// Injected in-memory storage + transport for the REAL canonical writers.
// ---------------------------------------------------------------------------

interface SessionSnapshot {
    kind: SessionChangeKind;
    token: string | null;
    user: string | null;
    student: string | null;
}

const installSessionEnvironment = (initial: Record<string, string> = {}) => {
    const store = new Map<string, string>(Object.entries(initial));
    const fetchCalls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const realLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() { return store.size; },
    };
    const realFetch = globalThis.fetch;
    return {
        store,
        fetchCalls,
        setFetchResponse: (body: unknown) => {
            globalThis.fetch = (async (input, init) => {
                fetchCalls.push({ input, init });
                return ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
            }) as typeof fetch;
        },
        restore: () => {
            (globalThis as unknown as { localStorage: unknown }).localStorage = realLocalStorage ?? undefined;
            globalThis.fetch = realFetch;
        },
    };
};

test("a notification reaches every current subscriber with only the kind", () => {
    const seen: SessionChangeKind[] = [];
    const unsubscribeA = subscribeSessionChange((event) => seen.push(event.kind));
    const unsubscribeB = subscribeSessionChange(() => seen.push("login"));

    notifySessionChange("login");

    assert.deepEqual(seen, ["login", "login"]);
    unsubscribeA();
    unsubscribeB();
});

test("the event detail carries only the kind — never token, user or link data", () => {
    let payload: Record<string, unknown> | null = null;
    const unsubscribe = subscribeSessionChange((event) => {
        payload = event as unknown as Record<string, unknown>;
    });

    notifySessionChange("logout");
    const keys = Object.keys(payload as unknown as Record<string, unknown>);

    assert.deepEqual(keys, ["kind"], "the payload shape is exactly { kind }");
    assert.equal((payload as unknown as { kind: string }).kind, "logout");
    unsubscribe();
});

test("every documented change kind flows through the contract", () => {
    const kinds: SessionChangeKind[] = [];
    const unsubscribe = subscribeSessionChange((event) => kinds.push(event.kind));

    for (const kind of ["login", "token", "identity", "logout", "scope"] as const) {
        notifySessionChange(kind);
    }

    assert.deepEqual(kinds, ["login", "token", "identity", "logout", "scope"]);
    unsubscribe();
});

test("unsubscribe is honoured immediately — a retired view never reacts", () => {
    let calls = 0;
    const unsubscribe = subscribeSessionChange(() => { calls += 1; });

    notifySessionChange("identity");
    assert.equal(calls, 1);

    unsubscribe();
    notifySessionChange("identity");
    assert.equal(calls, 1, "no reaction after unsubscribe");
});

test("a throwing subscriber never breaks the notifier or other subscribers", () => {
    const order: string[] = [];
    const unsubscribeBroken = subscribeSessionChange(() => {
        order.push("broken");
        throw new Error("subscriber exploded");
    });
    const unsubscribeHealthy = subscribeSessionChange(() => order.push("healthy"));

    assert.doesNotThrow(() => notifySessionChange("logout"), "the mutation that just completed must not be broken by a subscriber");
    assert.deepEqual(order, ["broken", "healthy"], "every subscriber still runs");

    unsubscribeBroken();
    unsubscribeHealthy();
});

test("notify with no subscribers is an inert no-op", () => {
    assert.doesNotThrow(() => notifySessionChange("scope"));
});

test("double unsubscribe and double subscribe are safe", () => {
    const listener = () => {};
    const unsubscribe = subscribeSessionChange(listener);
    unsubscribe();
    assert.doesNotThrow(() => unsubscribe(), "a second unsubscribe is a no-op");

    let calls = 0;
    const listener2 = () => { calls += 1; };
    const unsub2 = subscribeSessionChange(listener2);
    notifySessionChange("login");
    assert.equal(calls, 1);
    unsub2();
});

// ---------------------------------------------------------------------------
// Real canonical writers (supervisor/029: bus dispatch alone is not proof).
// The REAL api-http module is imported; only localStorage and fetch are
// injected. No storage monkeypatching inside the production code itself.
// ---------------------------------------------------------------------------

test("signIn notifies login only after the complete mutation — atomic login", async () => {
    const env = installSessionEnvironment();
    try {
        const seen: SessionSnapshot[] = [];
        const unsubscribe = subscribeSessionChange((event) => {
            seen.push({
                kind: event.kind,
                token: localStorage.getItem("authToken"),
                user: localStorage.getItem("currentUser"),
                student: localStorage.getItem("currentStudent"),
            });
        });
        env.setFetchResponse({ user: { id: "u-1", role: "student" }, token: "tok-login" });

        const result = await signIn("01000000000", "password-123");

        assert.equal(result.error, null);
        assert.equal(localStorage.getItem("authToken"), "tok-login");
        assert.equal(
            seen.length,
            1,
            "exactly one notification for the whole login mutation — never an intermediate token-only state",
        );
        assert.equal(seen[0].kind, "login");
        assert.equal(seen[0].token, "tok-login");
        assert.ok(seen[0].user, "the subscriber observes the token AND its identity together");
        unsubscribe();
    } finally {
        env.restore();
    }
});

test("signIn omits a stale Authorization header so expired sessions cannot block a fresh login", async () => {
    const env = installSessionEnvironment({ authToken: "expired-token" });
    try {
        env.setFetchResponse({ user: { id: "u-2", role: "admin" }, token: "fresh-token" });

        const result = await signIn("01000000000", "password-123");

        assert.equal(result.error, null);
        assert.equal(env.fetchCalls.length, 1);
        const headers = env.fetchCalls[0].init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, undefined);
        assert.equal(localStorage.getItem("authToken"), "fresh-token");
    } finally {
        env.restore();
    }
});

test("a bare setAuthToken write never notifies — login stays atomic", () => {
    const env = installSessionEnvironment();
    try {
        let notifications = 0;
        const unsubscribe = subscribeSessionChange(() => { notifications += 1; });

        setAuthToken("bare-token");

        assert.equal(notifications, 0, "setAuthToken is a storage writer, not a complete session mutation");
        assert.equal(localStorage.getItem("authToken"), "bare-token");
        unsubscribe();
    } finally {
        env.restore();
    }
});

test("selectStudentSpace notifies the token rotation after its complete mutation", async () => {
    const env = installSessionEnvironment({ authToken: "tok-old" });
    try {
        const seen: SessionSnapshot[] = [];
        const unsubscribe = subscribeSessionChange((event) => {
            seen.push({
                kind: event.kind,
                token: localStorage.getItem("authToken"),
                user: localStorage.getItem("currentUser"),
                student: localStorage.getItem("currentStudent"),
            });
        });
        env.setFetchResponse({ token: "tok-rotated", tenant_id: "t-1", student_enrollment_id: "e-1" });

        const result = await selectStudentSpace("e-1");

        assert.equal(result.token, "tok-rotated");
        assert.equal(localStorage.getItem("authToken"), "tok-rotated");
        assert.equal(seen.length, 1, "the rotation writer notifies exactly once, after the write");
        assert.equal(seen[0].kind, "token");
        assert.equal(seen[0].token, "tok-rotated", "the subscriber sees the rotated token");
        unsubscribe();
    } finally {
        env.restore();
    }
});

test("clearAuthToken notifies logout only after every session key is removed", () => {
    const env = installSessionEnvironment({
        authToken: "tok-1",
        currentUser: '{"id":"u-1"}',
        currentStudent: '{"id":"s-1"}',
    });
    try {
        const seen: SessionSnapshot[] = [];
        const unsubscribe = subscribeSessionChange((event) => {
            seen.push({
                kind: event.kind,
                token: localStorage.getItem("authToken"),
                user: localStorage.getItem("currentUser"),
                student: localStorage.getItem("currentStudent"),
            });
        });

        clearAuthToken();

        assert.deepEqual(seen, [
            { kind: "logout", token: null, user: null, student: null },
        ], "the subscriber observes a fully torn-down session, never a partial one");
        unsubscribe();
    } finally {
        env.restore();
    }
});

test("a failed login notifies nothing — no session state may leak on failure", async () => {
    const env = installSessionEnvironment();
    try {
        let notifications = 0;
        const unsubscribe = subscribeSessionChange(() => { notifications += 1; });
        // The request helper throws on a non-ok response.
        globalThis.fetch = (async () =>
            ({ ok: false, status: 401, json: async () => ({ error: "بيانات الدخول غير صحيحة" }) }) as unknown as Response) as typeof fetch;

        const result = await signIn("01000000000", "wrong-password");

        assert.equal(result.user, null);
        assert.equal(result.error, "بيانات الدخول غير صحيحة");
        assert.equal(notifications, 0, "a failed login must not notify any session change");
        assert.equal(localStorage.getItem("authToken"), null);
        unsubscribe();
    } finally {
        env.restore();
    }
});
