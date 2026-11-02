/**
 * Fees payment workflow — isolated production-path tests (node:test + tsx).
 *
 * Scope: the REAL decision seam `src/features/fees/payment-workflow.ts` that
 * `src/pages/Fees.tsx` mounts, plus the REAL `updateFee` transport in
 * `src/lib/api-http.ts` that seam writes through. Fully isolated: no DOM, no
 * browser, no network, no database, no live service, no dependency install.
 *
 * Behaviours pinned (audit 2026-10-26, finding C):
 *  - the form calls the canonical `updateFee` transport (previously it called
 *    an unimported `updateFee` and a non-existent `fetchFees`, so the first
 *    write failed before touching the database and a fixed first call alone
 *    would report a failure after a successful save);
 *  - an invalid amount (blank, non-numeric, zero, negative, infinite) is
 *    refused LOCALLY with no request;
 *  - the write body is computed from the held fee row: paid amount adds up and
 *    the status transitions to paid/partial exactly as before;
 *  - a confirmed write is NEVER reclassified as a failure by a failed list
 *    refresh: the refresh is a separate, lesser outcome;
 *  - a held latch refuses a duplicate submission with no second write;
 *  - a rejected write propagates as a failure with no retry and no invented
 *    success, and no wallet/balance/refund policy is decided here.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, the server's
 * own authorization and settlement (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  computePaymentWrite,
  parsePaymentAmount,
  runPaymentFlow,
  type PaymentFeeRow,
  type PaymentFlowOutcome,
  type PaymentSeams,
} from "../features/fees/payment-workflow";
import { updateFee } from "../lib/api-http";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('amount gate: blank, non-numeric, zero, negative and infinite values are refused locally', () => {
    for (const raw of ['', '   ', 'abc', '0', '-5', 'Infinity', '-Infinity', 'NaN']) {
        assert.equal(parsePaymentAmount(raw), null, `"${raw}" must be refused`);
    }
});

test('amount gate: a positive decimal is accepted exactly once', () => {
    assert.equal(parsePaymentAmount('150.5'), 150.5);
    assert.equal(parsePaymentAmount(' 40 '), 40);
});

test('amount gate: only the COMPLETE string is a money amount (no prefix, precision or scientific forms)', () => {
    for (const raw of [
        '12abc', // numeric prefix with a suffix
        '12 34',
        '1.234', // server money rejects >2dp
        '1e3', // scientific notation
        '0x10',
        '1,000',
        '.5', // no leading digit
        '1.', // no fraction digits
        '+5',
    ]) {
        assert.equal(parsePaymentAmount(raw), null, `"${raw}" must be refused`);
    }
    // Valid cents (at most two decimals) remain accepted.
    for (const [raw, expected] of [
        ['1', 1],
        ['12.34', 12.34],
        ['0.5', 0.5],
        ['0.01', 0.01],
        ['1000000.99', 1000000.99],
    ] as const) {
        assert.equal(parsePaymentAmount(raw), expected, `"${raw}" must be accepted`);
    }
});

test('write body: the paid amount accumulates and the status transitions on the held row', () => {
    const fee: PaymentFeeRow = { id: 'fee-1', amount: 300, paidAmount: 100 };
    assert.deepEqual(computePaymentWrite(fee, 150, 'cash', 'note', '2026-10-26'), {
        paid_amount: 250,
        status: 'partial',
        payment_date: '2026-10-26',
        payment_method: 'cash',
        notes: 'note',
    });
    assert.deepEqual(computePaymentWrite(fee, 200, 'bank', '', '2026-10-26'), {
        paid_amount: 300,
        status: 'paid',
        payment_date: '2026-10-26',
        payment_method: 'bank',
        notes: '',
    });
    // Overpaying keeps the existing behaviour: the fee is paid.
    assert.equal(computePaymentWrite(fee, 500, 'cash', '', '2026-10-26').status, 'paid');
});

// ---------------------------------------------------------------------------
// The flow over injected seams
// ---------------------------------------------------------------------------

interface Recorder {
    writes: { id: string; body: unknown }[];
    refreshes: number;
    failWrite: boolean;
    failRefresh: boolean;
}

const makeSeams = (recorder: Recorder): PaymentSeams => ({
    updateFee: async (id, body) => {
        recorder.writes.push({ id, body });
        if (recorder.failWrite) throw new Error('server refused the write');
        return { id };
    },
    refresh: async () => {
        recorder.refreshes += 1;
        if (recorder.failRefresh) throw new Error('refresh failed');
    },
    today: () => '2026-10-26',
});

const baseInput = (recorder: Recorder, overrides: Partial<Parameters<typeof runPaymentFlow>[0]> = {}) => ({
    fee: { id: 'fee-1', amount: 300, paidAmount: 100 } as PaymentFeeRow,
    amount: '150',
    paymentMethod: 'cash',
    notes: '',
    seams: makeSeams(recorder),
    ...overrides,
});

test('flow: a valid payment writes once through the seam and then refreshes', async () => {
    const recorder: Recorder = { writes: [], refreshes: 0, failWrite: false, failRefresh: false };
    const outcome = await runPaymentFlow(baseInput(recorder));

    assert.deepEqual(outcome, { kind: 'saved' });
    assert.equal(recorder.writes.length, 1, 'exactly one write');
    assert.equal(recorder.writes[0].id, 'fee-1');
    assert.equal(recorder.refreshes, 1, 'one refresh follows a confirmed write');
});

test('flow: a failed refresh after a confirmed write is a SEPARATE, lesser outcome', async () => {
    // The regression: the old code reported a payment failure when the list
    // refresh failed after the save had already succeeded.
    const recorder: Recorder = { writes: [], refreshes: 0, failWrite: false, failRefresh: true };
    const outcome = await runPaymentFlow(baseInput(recorder));

    assert.deepEqual(outcome, { kind: 'saved-refresh-failed' });
    assert.equal(recorder.writes.length, 1, 'the write still happened');
    assert.equal(recorder.refreshes, 1);
});

test('flow: a rejected write is a failure with no retry and no refresh', async () => {
    const recorder: Recorder = { writes: [], refreshes: 0, failWrite: true, failRefresh: false };
    const outcome = await runPaymentFlow(baseInput(recorder));

    assert.deepEqual(outcome, { kind: 'failed' });
    assert.equal(recorder.writes.length, 1, 'one attempt only');
    assert.equal(recorder.refreshes, 0, 'no refresh follows a failed write');
});

test('flow: an invalid amount sends no request at all', async () => {
    const recorder: Recorder = { writes: [], refreshes: 0, failWrite: false, failRefresh: false };
    for (const amount of ['', 'abc', '0', '-5', '12abc', '1.234', '1e3']) {
        const outcome = await runPaymentFlow(baseInput(recorder, { amount }));
        assert.deepEqual(outcome, { kind: 'invalid-amount' }, `amount "${amount}" must be refused locally`);
    }
    assert.equal(recorder.writes.length, 0, 'no write for an invalid amount');
    assert.equal(recorder.refreshes, 0);
});

test('flow: a held latch refuses a duplicate submission with no second write', async () => {
    const recorder: Recorder = { writes: [], refreshes: 0, failWrite: false, failRefresh: false };
    const outcome = await runPaymentFlow(baseInput(recorder, { busy: true }));

    assert.deepEqual(outcome, { kind: 'duplicate' });
    assert.equal(recorder.writes.length, 0, 'a duplicate submit never writes');
});

test('flow: a vanished fee row is a no-op, not a fabricated write', async () => {
    const recorder: Recorder = { writes: [], refreshes: 0, failWrite: false, failRefresh: false };
    const outcome = await runPaymentFlow(baseInput(recorder, { fee: null }));

    assert.deepEqual(outcome, { kind: 'no-fee' });
    assert.equal(recorder.writes.length, 0);
});

// ---------------------------------------------------------------------------
// The REAL transport the seam writes through
// ---------------------------------------------------------------------------

interface TransportEnv {
    calls: { url: string; init: RequestInit }[];
    restore: () => void;
}

const installTransportEnvironment = (token: string | null): TransportEnv => {
    const store = new Map<string, string>();
    if (token !== null) store.set('authToken', token);
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
        location: { pathname: '/fees', assign: () => undefined },
    };
    const calls: { url: string; init: RequestInit }[] = [];
    return {
        calls,
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

test('transport: the payment write is a canonical authenticated PUT to /fees/:id', async (t) => {
    const env = installTransportEnvironment('token-canonical');
    t.after(env.restore);
    stubFetch(env, () => ({ ok: true, status: 200, body: { id: 'fee-1', status: 'paid' } }));

    const body = computePaymentWrite(
        { id: 'fee-1', amount: 300, paidAmount: 100 },
        200,
        'bank',
        'تحويل',
        '2026-10-26',
    );
    const result = await updateFee('fee-1', body);

    assert.equal(env.calls.length, 1, 'exactly one request');
    assert.equal(env.calls[0].url, '/api/fees/fee-1');
    assert.equal(env.calls[0].init.method, 'PUT');
    // The transport builds a real Headers object, so the assertion reads it
    // the way the application does — not as a plain record.
    const headers = new Headers(env.calls[0].init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer token-canonical');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(env.calls[0].init.body)), body, 'the computed write body is sent verbatim');
    assert.equal(result.id, 'fee-1');
});

test('transport: a server rejection throws the server message verbatim, with no retry', async (t) => {
    const env = installTransportEnvironment('token-canonical');
    t.after(env.restore);
    stubFetch(env, () => ({ ok: false, status: 403, body: { error: 'Forbidden' } }));

    await assert.rejects(
        () => updateFee('fee-1', {
            paid_amount: 250,
            status: 'partial',
            payment_date: '2026-10-26',
            payment_method: 'cash',
            notes: '',
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'Forbidden', 'the documented server message is thrown verbatim');
            return true;
        },
    );
    assert.equal(env.calls.length, 1, 'no automatic retry');
});
