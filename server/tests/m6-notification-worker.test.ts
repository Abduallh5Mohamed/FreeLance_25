/**
 * B2-W9 — outbox notification worker (hermetic: no MySQL, no provider, no
 * network, no timers left behind).
 *
 * The worker is exercised through its real lifecycle (`start`/`stop`/
 * `runOnce`), the real `dispatchOutboxRow` claim/dispatch/retry path and the
 * real channel adapters. Only the SQL seam and the transport seam are recorded
 * fakes; no fake decides a policy outcome on the worker's behalf.
 *
 * Covered: import has no side effects, parallel `runOnce` never double
 * dispatches one row, send-time consent withdrawal denies without an adapter
 * call, no-provider adapters answer `unavailable` (never `sent`), ambiguous
 * provider results are quarantined as `unknown` and never retried as unsent,
 * transient vs permanent failures, tenant scope, purpose-scoped contact
 * resolution, stale leases are blocked not stolen, bounded concurrency,
 * `stop()` drains and releases every timer, and logs carry no PII.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    claimDueOutboxIdsInScope,
    dispatchOutboxRow,
    outboxRowRenderer,
    UNKNOWN_OUTCOME_MARKER,
    type DeliveryAdapter,
    type DispatchOptions,
    type OutboxRow,
} from '../src/services/notification-outbox';
import {
    createEmailAdapter,
    createSmsAdapter,
    type ChannelSendOutcome,
    type ConfiguredChannelAdapter,
    type ProviderTransport,
    type PurposeContactStore,
} from '../src/services/delivery-channels';
import {
    createConsentLedgerGate,
    createNotificationWorker,
    toDeliveryAdapter,
    type AdapterRegistration,
    type NotificationWorker,
    type WorkerScheduler,
} from '../src/services/notification-worker';
import type { NotificationDataAccess } from '../src/services/notification-consent';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);

const NOW = (): Date => new Date('2026-10-21T09:00:00.000Z');
const LINK_SECRET = 'b2-w9-worker-link-secret-32-bytes-0123456789abcdef';
const HMAC_KEY = 'b2-w9-worker-log-hmac-key';

// ---------------------------------------------------------------------------
// Recording SQL seam (in-memory outbox; no MySQL)
// ---------------------------------------------------------------------------

type WorkerRow = OutboxRow & { updated_at: Date };

interface Store {
    rows: WorkerRow[];
    receipts: { outbox_id: string; outcome: string; proof: string | null; detail: string | null }[];
    calls: { sql: string; params: unknown[]; kind: 'query' | 'queryOne' | 'execute' }[];
    seq: number;
    /** Forces both concurrent claim reads to observe the same due row. */
    gateClaimRead: boolean;
    /** Mutates the row between the claim and the terminal write (fence probe). */
    beforeFinish: ((row: WorkerRow) => void) | null;
    failFetch: Error | null;
}

const makeStore = (): Store => ({
    rows: [],
    receipts: [],
    calls: [],
    seq: 0,
    gateClaimRead: false,
    beforeFinish: null,
    failFetch: null,
});

const makeDb = (store: Store): NotificationDataAccess => {
    const barrier = { arrivals: 0, waiting: [] as (() => void)[] };
    const passBarrier = async (): Promise<void> => {
        if (!store.gateClaimRead) return;
        barrier.arrivals += 1;
        if (barrier.arrivals >= 2) barrier.waiting.splice(0).forEach((release) => release());
        else await new Promise<void>((release) => barrier.waiting.push(release));
    };
    const record = (sql: string, params: unknown[], kind: 'query' | 'queryOne' | 'execute'): void => {
        store.calls.push({ sql, params, kind });
    };
    const limitOf = (sql: string): number => {
        const match = sql.match(/LIMIT (\d+)/i);
        return match ? Number(match[1]) : 25;
    };

    const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
        record(sql, params, 'query');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        const limit = limitOf(sql);
        if (upper.includes('FROM NOTIFICATION_OUTBOX') && upper.includes("STATUS = 'SENDING'")) {
            const cutoff = params[0] instanceof Date ? params[0].getTime() : new Date(String(params[0])).getTime();
            return store.rows
                .filter((row) => row.status === 'sending' && row.updated_at.getTime() <= cutoff)
                .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime())
                .slice(0, limit) as T[];
        }
        if (upper.includes('FROM NOTIFICATION_OUTBOX') && upper.includes("STATUS = 'PENDING'")) {
            await passBarrier();
            const dueMs = params[0] instanceof Date ? params[0].getTime() : new Date(String(params[0])).getTime();
            const tenantId = params[1] === undefined ? null : String(params[1]);
            const channelParams = params.slice(2).map((value) => String(value));
            return store.rows
                .filter((row) => row.status === 'pending' && new Date(row.next_attempt_at as Date).getTime() <= dueMs)
                .filter((row) => tenantId === null || row.tenant_id === tenantId)
                .filter((row) => channelParams.length === 0 || channelParams.includes(row.channel))
                .sort((a, b) => new Date(a.next_attempt_at as Date).getTime() - new Date(b.next_attempt_at as Date).getTime())
                .slice(0, limit) as T[];
        }
        throw new Error(`fake db: unhandled SELECT: ${sql}`);
    };

    const queryOne = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        record(sql, params, 'queryOne');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        if (store.failFetch) throw store.failFetch;
        if (upper.includes('FROM NOTIFICATION_OUTBOX WHERE ID = ? AND TENANT_ID = ?')) {
            const row = store.rows.find((candidate) => candidate.id === params[0] && candidate.tenant_id === params[1]);
            return (row ?? null) as T | null;
        }
        if (upper.includes('FROM NOTIFICATION_OUTBOX WHERE ID = ?')) {
            const row = store.rows.find((candidate) => candidate.id === params[0]);
            return (row ?? null) as T | null;
        }
        throw new Error(`fake db: unhandled SELECT: ${sql}`);
    };

    const execute = async (sql: string, params: unknown[] = []): Promise<{ insertId?: number; affectedRows?: number }> => {
        record(sql, params, 'execute');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        if (upper.includes('ATTEMPTS = ATTEMPTS + 1')) {
            const [id, dueAt, tenantId] = params;
            const row = store.rows.find((candidate) => candidate.id === id);
            if (!row || row.status !== 'pending') return { affectedRows: 0, insertId: 0 };
            if (tenantId !== undefined && row.tenant_id !== tenantId) return { affectedRows: 0, insertId: 0 };
            const dueMs = dueAt instanceof Date ? dueAt.getTime() : new Date(String(dueAt)).getTime();
            if (new Date(row.next_attempt_at as Date).getTime() > dueMs) return { affectedRows: 0, insertId: 0 };
            row.status = 'sending';
            row.attempts += 1;
            row.updated_at = NOW();
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('SET LAST_ERROR = ?')) {
            const [marker, id, firstMarker, secondMarker] = params;
            const row = store.rows.find((candidate) => candidate.id === id);
            if (!row || row.status !== 'sending') return { affectedRows: 0, insertId: 0 };
            if (row.last_error === firstMarker || row.last_error === secondMarker) return { affectedRows: 0, insertId: 0 };
            row.last_error = String(marker);
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE NOTIFICATION_OUTBOX SET STATUS')) {
            const [status, nextAttemptAt, lastError, sentStatus, id, fence] = params;
            const row = store.rows.find((candidate) => candidate.id === id);
            if (!row || row.status !== 'sending') return { affectedRows: 0, insertId: 0 };
            // A competing claim that lands *while this dispatcher is inside the
            // adapter* is part of the row's state by the time the terminal
            // UPDATE runs, so the probe must fire before the predicate is
            // evaluated. MySQL evaluates `attempts = ?` and the write atomically
            // under one row lock; evaluating the predicate against the
            // pre-probe snapshot would let the write through and model a store
            // that cannot enforce the fence.
            if (store.beforeFinish) store.beforeFinish(row);
            if (fence !== undefined && row.attempts !== fence) return { affectedRows: 0, insertId: 0 };
            row.status = String(status);
            if (nextAttemptAt !== null) row.next_attempt_at = nextAttemptAt as Date;
            row.last_error = lastError === null ? null : String(lastError);
            row.updated_at = NOW();
            if (sentStatus === 'sent') row.delivered_at = NOW();
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('INSERT INTO NOTIFICATION_DELIVERY_RECEIPTS')) {
            const [id, outboxId, tenantId, channel, outcome, proof, detail] = params;
            store.receipts.push({
                id: String(id), outbox_id: String(outboxId), tenant_id: tenantId === null ? null : String(tenantId),
                channel: String(channel), outcome: String(outcome),
                proof: proof === null ? null : String(proof), detail: detail === null ? null : String(detail),
            });
            return { affectedRows: 1, insertId: 0 };
        }
        throw new Error(`fake db: unhandled WRITE: ${sql}`);
    };

    return { query, queryOne, execute };
};

const seed = (store: Store, overrides: Partial<WorkerRow> = {}): WorkerRow => {
    const row: WorkerRow = {
        id: `outbox-${++store.seq}`,
        idempotency_key: `key-${store.seq}`,
        tenant_id: 'tenant-a',
        event_type: 'progress_report',
        purpose: 'progress_report',
        recipient_user_id: 'parent-1',
        recipient_user_type: 'parent',
        channel: 'email',
        locale: 'en',
        template_id: null,
        payload: JSON.stringify({
            student_name: 'Sami', period: 'Oct 2026', summary_text: 'progress ok',
            report_link: '?e=abc', unsubscribe_link: '?u=def',
        }),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        next_attempt_at: NOW(),
        last_error: null,
        delivered_at: null,
        updated_at: NOW(),
        ...overrides,
    };
    store.rows.push(row);
    return row;
};

// ---------------------------------------------------------------------------
// Adapters, registrations, contact store, scheduler
// ---------------------------------------------------------------------------

const recordingAdapter = (
    channel: 'email' | 'sms' | 'whatsapp',
    outcome: ChannelSendOutcome | (() => Promise<ChannelSendOutcome>),
): { adapter: DeliveryAdapter; calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
        calls,
        adapter: {
            channel,
            deliver: async (message) => {
                calls.push(message);
                return typeof outcome === 'function' ? outcome() : outcome;
            },
        },
    };
};

const registration = (adapter: DeliveryAdapter, ready = true): AdapterRegistration => ({
    adapter,
    isReady: () => ready,
});

/** Purpose-scoped contact store: only progress_report may reach this parent. */
const contactStore = (allowedPurpose = 'progress_report'): PurposeContactStore => ({
    findContactForPurpose: async (query) => (
        query.purpose === allowedPurpose && query.userId === 'parent-1' && query.channel === 'email'
            ? { contact: 'parent@example.test', verified: true }
            : null
    ),
});

const consentGate = (allow: boolean | (() => Promise<boolean>)): { canDeliver: (input: { userId: string; userType: string; purpose: string; channel: string }) => Promise<boolean> } => ({
    canDeliver: async () => (typeof allow === 'function' ? allow() : allow),
});

const makeScheduler = (): WorkerScheduler & { size: number; fire: () => Promise<void> } => {
    const timers = new Map<number, { handler: () => void; ms: number }>();
    let next = 1;
    return {
        setTimeout(handler: () => void, ms: number): unknown {
            const id = next;
            next += 1;
            timers.set(id, { handler, ms });
            return id;
        },
        clearTimeout(handle: unknown): void {
            timers.delete(Number(handle));
        },
        get size(): number {
            return timers.size;
        },
        async fire(): Promise<void> {
            const due = [...timers.entries()];
            timers.clear();
            for (const [, timer] of due) timer.handler();
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
};

interface Harness {
    store: Store;
    scheduler: ReturnType<typeof makeScheduler>;
    logs: unknown[];
    worker: NotificationWorker;
}

interface HarnessOverrides {
    store?: Store;
    adapters?: readonly AdapterRegistration[];
    contacts?: PurposeContactStore;
    consent?: { canDeliver: (input: { userId: string; userType: string; purpose: string; channel: string }) => Promise<boolean> };
    limits?: { batchSize?: number; concurrency?: number; drainTimeoutMs?: number; tickMs?: number; leaseMs?: number };
    log?: (entry: unknown) => void;
    /** `null` keeps the real timers (needed when a drain timeout must elapse). */
    scheduler?: WorkerScheduler | null;
}

const makeWorker = (overrides: HarnessOverrides = {}): Harness => {
    const store = overrides.store ?? makeStore();
    const scheduler = makeScheduler();
    const logs: unknown[] = [];
    const worker = createNotificationWorker({
        db: makeDb(store),
        scope: { tenantId: 'tenant-a' },
        adapters: overrides.adapters ?? [registration(recordingAdapter('email', { outcome: 'sent', proof: { message_id: 'm-1' } }).adapter)],
        contacts: overrides.contacts ?? contactStore(),
        consent: overrides.consent ?? consentGate(true),
        linkSecret: LINK_SECRET,
        hmacKey: HMAC_KEY,
        render: outboxRowRenderer(),
        now: NOW,
        log: overrides.log ?? ((entry) => logs.push(entry)),
        scheduler: overrides.scheduler === null ? undefined : (overrides.scheduler ?? scheduler),
        limits: overrides.limits,
    });
    return { store, scheduler, logs, worker };
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('importing the worker module has no side effects: nothing runs until start/runOnce', async () => {
    const store = makeStore();
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: { message_id: 'm-1' } });
    seed(store);
    const worker = createNotificationWorker({
        db: makeDb(store),
        scope: { tenantId: 'tenant-a' },
        adapters: [registration(adapter)],
        contacts: contactStore(),
        consent: consentGate(true),
        linkSecret: LINK_SECRET,
        hmacKey: HMAC_KEY,
        now: NOW,
    });
    assert.equal(worker.status().running, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.calls.length, 0, 'constructing a worker must not touch the database');
    assert.equal(calls.length, 0, 'constructing a worker must not send anything');
    assert.equal(store.rows[0]!.status, 'pending');
    const stopped = await worker.stop();
    assert.deepEqual(stopped, { drained: true, inFlight: 0 });
});

test('start() schedules one bounded tick, stop() clears it and nothing runs afterwards', async () => {
    const harness = makeWorker({ limits: { tickMs: 1000 } });
    seed(harness.store);
    harness.worker.start();
    assert.equal(harness.worker.status().running, true);
    assert.equal(harness.scheduler.size, 1, 'exactly one owned timer while running');

    await harness.scheduler.fire();
    assert.equal(harness.store.rows[0]!.status, 'sent');
    assert.equal(harness.scheduler.size, 1, 'the tick reschedules only while running');

    const stopped = await harness.worker.stop();
    assert.deepEqual(stopped, { drained: true, inFlight: 0 });
    assert.equal(harness.scheduler.size, 0, 'stop() must release every timer it owns');
    assert.equal(harness.worker.status().running, false);

    const callsAfterStop = harness.store.calls.length;
    await harness.scheduler.fire();
    assert.equal(harness.store.calls.length, callsAfterStop, 'no tick may run after stop()');
});

test('stop() drains an in-flight send within its bound and reports a stuck adapter as not drained', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { adapter } = recordingAdapter('email', async () => {
        await gate;
        return { outcome: 'sent', proof: { message_id: 'late-1' } };
    });
    const harness = makeWorker({ adapters: [registration(adapter)], limits: { drainTimeoutMs: 20 }, scheduler: null });
    seed(harness.store);
    const run = harness.worker.runOnce();
    const stopped = await harness.worker.stop();
    assert.equal(stopped.drained, false, 'a send that outlives the drain bound must be reported, not hidden');
    release!();
    const result = await run;
    assert.equal(result.counts.sent, 1);
});

// ---------------------------------------------------------------------------
// Concurrency, tenant scope, batch bound
// ---------------------------------------------------------------------------

test('two parallel runOnce calls never double dispatch the same row', async () => {
    const harness = makeWorker();
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: { message_id: 'm-1' } });
    harness.store.rows.length = 0;
    const worker = createNotificationWorker({
        db: makeDb(harness.store),
        scope: { tenantId: 'tenant-a' },
        adapters: [registration(adapter)],
        contacts: contactStore(),
        consent: consentGate(true),
        linkSecret: LINK_SECRET,
        hmacKey: HMAC_KEY,
        render: outboxRowRenderer(),
        now: NOW,
    });
    seed(harness.store);
    harness.store.gateClaimRead = true;
    const [first, second] = await Promise.all([worker.runOnce(), worker.runOnce()]);
    assert.equal(calls.length, 1, 'exactly one adapter send for one row');
    assert.equal(harness.store.receipts.length, 1, 'exactly one delivery receipt');
    assert.equal(harness.store.rows[0]!.status, 'sent');
    assert.equal(harness.store.rows[0]!.attempts, 1);
    assert.equal(first.counts.sent + second.counts.sent, 1);
    assert.equal(first.counts.skipped + second.counts.skipped, 1);
});

test('a row from another tenant is never claimed or dispatched', async () => {
    const harness = makeWorker();
    const foreign = seed(harness.store, { tenant_id: 'tenant-b' });
    const result = await harness.worker.runOnce();
    assert.equal(result.claimed, 0);
    assert.equal(harness.store.calls.filter((call) => call.kind === 'execute').length, 0, 'no claim UPDATE for a foreign row');
    assert.equal(foreign.status, 'pending');
    assert.equal(foreign.attempts, 0);
});

test('a tenant-scoped dispatch refuses a foreign row with an exact reason', async () => {
    const store = makeStore();
    const db = makeDb(store);
    const row = seed(store, { tenant_id: 'tenant-b' });
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: {} });
    const options: DispatchOptions = {
        consent: consentGate(true),
        render: outboxRowRenderer(),
        linkSecret: LINK_SECRET,
        now: NOW,
        tenantScope: 'tenant-a',
    };
    const result = await dispatchOutboxRow(db, row.id, [adapter], options, HMAC_KEY);
    assert.deepEqual(result, { dispatched: false, outcome: 'skipped', reason: 'tenant-mismatch' });
    assert.equal(calls.length, 0);
    assert.equal(row.status, 'pending');
    assert.equal(store.receipts.length, 0);
});

test('claimDueOutboxIdsInScope binds tenant and channel into the claim query', async () => {
    const store = makeStore();
    const db = makeDb(store);
    seed(store, { tenant_id: 'tenant-a', channel: 'email' });
    seed(store, { tenant_id: 'tenant-a', channel: 'in_app' });
    seed(store, { tenant_id: 'tenant-b', channel: 'email' });
    const ids = await claimDueOutboxIdsInScope(db, { tenantId: 'tenant-a', channels: ['email'], limit: 10, now: NOW });
    assert.equal(ids.length, 1);
    const claim = store.calls.find((call) => call.kind === 'query');
    assert.ok(claim);
    assert.ok(claim!.sql.includes('tenant_id = ?'), 'the claim must be tenant-scoped in SQL, not filtered afterwards');
    assert.deepEqual(claim!.params.slice(1), ['tenant-a', 'email']);
});

test('batch size and concurrency are bounded', async () => {
    const inFlight = { current: 0, max: 0 };
    const { adapter } = recordingAdapter('email', async () => {
        inFlight.current += 1;
        inFlight.max = Math.max(inFlight.max, inFlight.current);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight.current -= 1;
        return { outcome: 'sent', proof: { message_id: 'm' } };
    });
    const harness = makeWorker({ adapters: [registration(adapter)], limits: { batchSize: 3, concurrency: 2 } });
    for (let index = 0; index < 6; index += 1) seed(harness.store);
    const result = await harness.worker.runOnce();
    assert.equal(result.claimed, 3, 'batchSize bounds one tick');
    assert.ok(inFlight.max <= 2, `concurrency must stay <= 2, saw ${inFlight.max}`);
    assert.equal(result.counts.sent, 3);
});

// ---------------------------------------------------------------------------
// Send-time authority: consent, tenant, purpose
// ---------------------------------------------------------------------------

test('consent withdrawn between claim and send denies the row without an adapter call', async () => {
    let allowed = true;
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: {} });
    const harness = makeWorker({
        adapters: [registration(adapter)],
        consent: { canDeliver: async () => allowed },
    });
    const row = seed(harness.store);
    // The row was queued while the recipient was opted in; the STOP arrives
    // after enqueue and before the worker sends.
    allowed = false;
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.cancelled, 1);
    assert.equal(calls.length, 0, 'a revoked recipient must never reach the adapter');
    assert.equal(row.status, 'cancelled');
    assert.equal(row.last_error, 'consent-revoked');
    assert.equal(harness.store.receipts.at(-1)!.outcome, 'cancelled');
});

test('the consent gate re-reads the current ledger on every send decision', async () => {
    const store = makeStore();
    const db = makeDb(store);
    const reads: unknown[][] = [];
    const ledgerDb: NotificationDataAccess = {
        query: db.query,
        execute: db.execute,
        queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
            void sql;
            reads.push(params);
            // Latest event is a revoke: STOP wins immediately.
            return {
                id: 'evt-1', tenant_id: 'tenant-a', user_id: 'parent-1', user_type: 'parent',
                purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'stop_message',
                recorded_by: null, recorded_at: NOW(),
            } as T;
        },
    };
    const gate = createConsentLedgerGate(ledgerDb);
    const input = { userId: 'parent-1', userType: 'parent', purpose: 'progress_report', channel: 'email' };
    assert.equal(await gate.canDeliver(input), false);
    assert.equal(await gate.canDeliver(input), false);
    assert.equal(reads.length, 2, 'every decision is a fresh ledger read, never a cached flag');
});

test('contact resolution is purpose-scoped: a different purpose is denied before the adapter', async () => {
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: {} });
    const harness = makeWorker({ adapters: [registration(adapter)], contacts: contactStore('progress_report') });
    const row = seed(harness.store, { purpose: 'billing_reminders' });
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.failed, 1);
    assert.equal(calls.length, 0, 'a contact registered for another purpose must not be reused');
    assert.equal(row.status, 'failed');
    assert.match(String(row.last_error), /contact-missing/);
});

// ---------------------------------------------------------------------------
// Result taxonomy: unavailable, unknown, transient, permanent
// ---------------------------------------------------------------------------

test('an adapter with no provider reports unavailable and the row is never marked sent', async () => {
    const email = createEmailAdapter();
    const harness = makeWorker({ adapters: [registration(toDeliveryAdapter(email))] });
    const row = seed(harness.store);
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.unavailable, 1);
    assert.equal(row.status, 'pending', 'unavailable is a pre-send outcome: bounded retry, never sent');
    assert.equal(row.delivered_at, null);
    assert.match(String(row.last_error), /no-provider-configured/);
    assert.equal(harness.store.receipts.length, 0, 'no receipt may claim a delivery that never happened');
});

test('an unready adapter registration is never asked to send', async () => {
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: {} });
    const harness = makeWorker({ adapters: [registration(adapter, false)] });
    const row = seed(harness.store);
    const result = await harness.worker.runOnce();
    assert.equal(result.claimed, 0, 'a channel without a ready adapter is not claimed at all');
    assert.equal(calls.length, 0);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
});

test('the bridge surfaces the adapter readiness reason instead of a generic one', async () => {
    // A registration can be ready while the provider behind it is not (the
    // readiness signal is re-read at send time). The reason the adapter
    // reports is what an operator has to see in last_error.
    const providerless: ConfiguredChannelAdapter = {
        channel: 'email',
        readiness: () => ({ ready: false, reason: 'provider-credentials-missing' }),
        send: async () => {
            throw new Error('send() must not be reached while unready');
        },
    };
    const harness = makeWorker({ adapters: [registration(toDeliveryAdapter(providerless))] });
    const row = seed(harness.store);
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.unavailable, 1);
    assert.equal(row.status, 'pending', 'nothing was transmitted, so the row stays retryable');
    assert.equal(row.delivered_at, null);
    assert.match(String(row.last_error), /provider-credentials-missing/);
    assert.equal(harness.store.receipts.length, 0, 'an unavailable send has no receipt to record');
});

test('an ambiguous provider result is quarantined as unknown and never retried as unsent', async () => {
    const { adapter, calls } = recordingAdapter('email', {
        outcome: 'unknown',
        reason: 'provider timeout after request write',
    });
    const harness = makeWorker({ adapters: [registration(adapter)] });
    const row = seed(harness.store);
    const first = await harness.worker.runOnce();
    assert.equal(first.counts.unknown, 1);
    assert.equal(row.status, 'sending', 'an unknown outcome must stay unclaimable, not pending');
    assert.equal(row.last_error, UNKNOWN_OUTCOME_MARKER);
    assert.equal(row.delivered_at, null);
    assert.equal(harness.store.receipts.at(-1)!.outcome, 'unknown');
    assert.equal(calls.length, 1);

    // A later tick must not pick the quarantined row up again.
    const second = await harness.worker.runOnce();
    assert.equal(second.claimed, 0);
    assert.equal(calls.length, 1, 'an unknown outcome is never re-sent automatically');
});

test('a transport exception is treated as ambiguous, not as definitely unsent', async () => {
    const harness = makeWorker({
        adapters: [registration({
            channel: 'email',
            deliver: async () => { throw new Error('socket closed mid-request'); },
        })],
    });
    const row = seed(harness.store);
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.unknown, 1);
    assert.equal(row.status, 'sending');
    assert.equal(row.last_error, UNKNOWN_OUTCOME_MARKER);
});

test('a transient failure retries with a bounded backoff, then a permanent one is terminal', async () => {
    const outcomes: ChannelSendOutcome[] = [
        { outcome: 'failed', reason: 'provider 503' },
        { outcome: 'failed', reason: 'recipient rejected', permanent: true },
    ];
    const { adapter, calls } = recordingAdapter('email', () => Promise.resolve(outcomes.shift()!));
    const harness = makeWorker({ adapters: [registration(adapter)] });
    const row = seed(harness.store, { max_attempts: 5 });

    const first = await harness.worker.runOnce();
    assert.equal(first.counts.retry, 1);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(new Date(row.next_attempt_at as Date).getTime(), NOW().getTime() + 60_000, 'first backoff step is 60s');

    // Not due yet: nothing may be claimed before next_attempt_at.
    assert.equal((await harness.worker.runOnce()).claimed, 0);

    row.next_attempt_at = NOW();
    const second = await harness.worker.runOnce();
    assert.equal(second.counts.failed, 1, 'a permanent failure is terminal immediately');
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 2);
    assert.equal(calls.length, 2);
    assert.equal((await harness.worker.runOnce()).claimed, 0, 'a terminal row is never retried');
});

// ---------------------------------------------------------------------------
// Lease and fencing
// ---------------------------------------------------------------------------

test('a stale lease is blocked with an exact reason and never stolen', async () => {
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: {} });
    const harness = makeWorker({ adapters: [registration(adapter)] });
    const row = seed(harness.store, {
        status: 'sending',
        attempts: 1,
        updated_at: new Date(NOW().getTime() - 60 * 60 * 1000),
    });
    const reaped = await harness.worker.reapStaleClaims();
    assert.equal(reaped.blocked.length, 1);
    assert.equal(reaped.blocked[0]!.reason, 'stale-claim-unconfirmed');
    assert.equal(row.status, 'sending', 'an old lease is quarantined, never re-claimed');
    assert.equal(row.attempts, 1, 'no attempt is consumed by a sweep');
    assert.equal(calls.length, 0);

    const run = await harness.worker.runOnce();
    assert.equal(run.claimed, 0);
    assert.equal(calls.length, 0, 'a blocked row is not dispatched');
});

test('a superseded claim cannot write a terminal state (attempts fence)', async () => {
    const store = makeStore();
    const db = makeDb(store);
    const row = seed(store);
    store.beforeFinish = (candidate) => {
        // Simulates a competing claimer bumping the attempt counter while the
        // first dispatcher is still inside the adapter.
        candidate.attempts += 1;
    };
    const logs: unknown[] = [];
    const { adapter, calls } = recordingAdapter('email', { outcome: 'sent', proof: { message_id: 'm-1' } });
    const result = await dispatchOutboxRow(db, row.id, [adapter], {
        consent: consentGate(true),
        render: outboxRowRenderer(),
        linkSecret: LINK_SECRET,
        now: NOW,
        log: (entry) => logs.push(entry),
    }, HMAC_KEY);
    assert.equal(result.outcome, 'sent');
    assert.equal(calls.length, 1);
    assert.notEqual(row.status, 'sent', 'a fenced-out writer must not resolve the row');
    assert.equal(row.delivered_at, null);
    assert.ok(logs.some((entry) => JSON.stringify(entry).includes('state-transition-rejected')));
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('worker logs carry no email, phone, OTP, token or message body', async () => {
    const harness = makeWorker({
        adapters: [registration({
            channel: 'email',
            deliver: async () => ({
                outcome: 'failed',
                reason: 'rejected +201000000123 otp 123456 token=abc123 body "Sami progress ok"',
            }),
        })],
    });
    seed(harness.store);
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.retry, 1);
    const serialized = JSON.stringify(harness.logs);
    assert.equal(serialized.includes('+201000000123'), false);
    assert.equal(serialized.includes('01000000123'), false);
    assert.equal(serialized.includes('123456'), false);
    assert.equal(serialized.includes('abc123'), false);
    assert.equal(serialized.includes('parent@example.test'), false);
    assert.equal(serialized.includes('Sami progress ok'), false);
    assert.ok(serialized.includes('••••••'), 'digit runs must be masked, not dropped silently');
});

test('a database read failure is reported per row and never escalates to a send', async () => {
    const harness = makeWorker();
    const row = seed(harness.store);
    harness.store.failFetch = new Error('connection reset');
    const result = await harness.worker.runOnce();
    assert.equal(result.counts.error, 1);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);
    const serialized = JSON.stringify(harness.logs);
    assert.ok(serialized.includes('connection reset'), 'the failure must be visible to operators');
});

// ---------------------------------------------------------------------------
// Channel adapter factories through the real dispatch path
// ---------------------------------------------------------------------------

test('the SMS adapter without a provider is unavailable, with a provider it reports the receipt id', async () => {
    const bare = createSmsAdapter();
    assert.deepEqual(await bare.send({ contact: '+201000000123', locale: 'en', templateId: 'tpl_1', bodyText: 'hi' }), {
        outcome: 'unavailable',
        reason: 'no-provider-configured',
    });
    assert.equal(bare.readiness().ready, false);

    const transport: ProviderTransport = {
        send: async (request) => ({ ok: true, messageId: `sms-${request.channel}-1`, providerStatus: 'ACCEPTED' }),
    };
    const wired = createSmsAdapter({ transport });
    assert.equal(wired.readiness().ready, true);
    const sent = await wired.send({ contact: '+201000000123', locale: 'en', templateId: 'tpl_1', bodyText: 'hi' });
    assert.deepEqual(sent, { outcome: 'sent', proof: { message_id: 'sms-sms-1', provider_status: 'ACCEPTED' } });
});
