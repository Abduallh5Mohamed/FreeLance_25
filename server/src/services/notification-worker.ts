/**
 * B2-W9 — notification outbox worker.
 *
 * The worker is the only component that turns due `notification_outbox` rows
 * into adapter sends. It owns an explicit lifecycle and nothing else:
 *
 *  - importing this module performs no I/O, starts no timer and sends nothing;
 *  - `start()` creates exactly one owned timer, `stop()` clears it and drains
 *    the in-flight run within a bound, `runOnce()` performs one bounded pass;
 *  - a pass claims at most `batchSize` rows of ONE tenant (and only channels
 *    with a ready adapter), then dispatches them with `concurrency` workers.
 *
 * It does not implement a second state machine: claiming, consent re-check,
 * retry/backoff, dedupe and receipt writing are the existing
 * `services/notification-outbox.ts` primitives. The worker only adds the
 * send-time authority the outbox cannot own by itself:
 *
 *  - purpose-scoped contact resolution (`resolveContactForSend`), so a row is
 *    never delivered to "any contact on file" for a different purpose;
 *  - an explicit readiness signal per registration, so a channel with no
 *    provider is never claimed and can never report a fake success;
 *  - a wrapper that classifies a thrown adapter error as `unknown` (the
 *    request may be on the wire) instead of replaying it as unsent;
 *  - a lease-bounded stale sweep that only *blocks* abandoned claims with an
 *    exact reason. Leases are fenced by the claim's attempt number in the
 *    outbox writes; no row is ever stolen because it merely looks old.
 *
 * Startup/graceful-shutdown wiring (mounting `start()` after the HTTP server
 * listens and `stop()` in the shutdown hook) belongs to the integration owner;
 * this module only exposes the handshake. See
 * docs/contracts/NOTIFICATION-WORKER-CONTRACT.md.
 */

import { canDeliverTo, type NotificationDataAccess } from './notification-consent';
import {
    claimDueOutboxIdsInScope,
    dispatchOutboxRow,
    outboxRowRenderer,
    recoverStaleSendingRows,
    STALE_SENDING_MARKER,
    type DeliveryAdapter,
    type DispatchOptions,
    type OutboxConsentGate,
    type OutboxRow,
    type TemplateRenderResult,
} from './notification-outbox';
import {
    redactPiiText,
    resolveContactForSend,
    type ChannelSendOutcome,
    type ConfiguredChannelAdapter,
    type ContactResolution,
    type PurposeContactStore,
} from './delivery-channels';

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
/** Must exceed the slowest adapter timeout; the sweep treats it as a bound. */
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MIN_LEASE_MS = 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const MAX_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 1_000;

const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return fallback;
    return Math.min(Math.max(raw, min), max);
};

export interface WorkerLimits {
    batchSize?: number;
    concurrency?: number;
    leaseMs?: number;
    drainTimeoutMs?: number;
    tickMs?: number;
}

export interface ResolvedWorkerLimits {
    batchSize: number;
    concurrency: number;
    leaseMs: number;
    drainTimeoutMs: number;
    tickMs: number;
}

export const resolveWorkerLimits = (limits: WorkerLimits = {}): ResolvedWorkerLimits => ({
    batchSize: clampInt(limits.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
    concurrency: clampInt(limits.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    leaseMs: clampInt(limits.leaseMs, DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS),
    drainTimeoutMs: clampInt(limits.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 1, MAX_DRAIN_TIMEOUT_MS),
    tickMs: clampInt(limits.tickMs, DEFAULT_TICK_MS, MIN_TICK_MS, 24 * 60 * 60 * 1000),
});

/** Minimal timer seam so a test can prove every handle is released. */
export interface WorkerScheduler {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface AdapterRegistration {
    readonly adapter: DeliveryAdapter;
    /** Explicit readiness signal; false means "no provider configured". */
    isReady(): boolean;
}

export interface NotificationWorkerScope {
    /** The single tenant this worker serves. Required, never inferred. */
    tenantId: string;
}

export interface NotificationWorkerDeps {
    db: NotificationDataAccess;
    scope: NotificationWorkerScope;
    adapters: readonly AdapterRegistration[];
    /** Purpose-scoped contact authority; the worker fails closed without it. */
    contacts: PurposeContactStore;
    /** Send-time consent gate; must re-read the ledger on every call. */
    consent: OutboxConsentGate;
    /** Dedicated link secret (resolved by the caller via resolveLinkSecret). */
    linkSecret: string;
    /** HMAC key for contact refs in logs; never a contact itself. */
    hmacKey: string;
    render?: (row: OutboxRow) => TemplateRenderResult;
    now?: () => Date;
    log?: (entry: unknown) => void;
    limits?: WorkerLimits;
    scheduler?: WorkerScheduler;
}

export type WorkerRowOutcome =
    | 'sent'
    | 'retry'
    | 'failed'
    | 'bounced'
    | 'cancelled'
    | 'unknown'
    | 'unavailable'
    | 'skipped'
    | 'error';

export interface WorkerRowResult {
    outboxId: string;
    outcome: WorkerRowOutcome;
    reason: string | null;
}

export interface WorkerRunResult {
    claimed: number;
    counts: Record<WorkerRowOutcome, number>;
    rows: WorkerRowResult[];
}

export interface StaleClaimReapResult {
    scanned: number;
    /** Rows blocked for reconciliation; never re-claimed or re-sent here. */
    blocked: { outboxId: string; reason: string }[];
}

export interface NotificationWorker {
    start(): void;
    stop(): Promise<{ drained: boolean; inFlight: number }>;
    runOnce(): Promise<WorkerRunResult>;
    reapStaleClaims(): Promise<StaleClaimReapResult>;
    status(): { running: boolean; inFlight: number; lastRunAt: string | null };
}

const emptyCounts = (): Record<WorkerRowOutcome, number> => ({
    sent: 0,
    retry: 0,
    failed: 0,
    bounced: 0,
    cancelled: 0,
    unknown: 0,
    unavailable: 0,
    skipped: 0,
    error: 0,
});

const defaultScheduler: WorkerScheduler = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const sanitizeReason = (reason: string): string => redactPiiText(reason).slice(0, 200);

/**
 * Consent gate backed by the live consent ledger. Every call is a fresh read
 * of `notification_consent_events`, so a STOP/unsubscribe recorded after the
 * row was queued denies the send immediately before the adapter fires.
 */
export const createConsentLedgerGate = (db: NotificationDataAccess): OutboxConsentGate => ({
    canDeliver: (input) => canDeliverTo(db, {
        userId: input.userId,
        userType: input.userType,
        purpose: input.purpose,
        channel: input.channel,
    }),
});

/**
 * Bridges a provider-backed channel adapter to the outbox adapter shape. The
 * contact is supplied by the worker's purpose-scoped resolver; the bridge never
 * resolves a contact itself and never fabricates a message id.
 *
 * The readiness reason is propagated verbatim: a bridge that replaced
 * "no-provider-configured" with a generic "adapter-not-ready" would write an
 * operator-visible `last_error` that no longer says why the row cannot be
 * delivered. The reason is adapter-authored and bounded (it is redacted again
 * by the outbox before it reaches a log or a receipt).
 */
export const toDeliveryAdapter = (adapter: ConfiguredChannelAdapter): DeliveryAdapter => ({
    channel: adapter.channel,
    deliver: async (message): Promise<ChannelSendOutcome> => {
        const readiness = adapter.readiness();
        if (!readiness.ready) return { outcome: 'unavailable', reason: readiness.reason };
        return adapter.send({
            contact: message.contact ?? '',
            locale: message.row.locale,
            templateId: message.templateId ?? '',
            subject: message.subject,
            bodyText: message.bodyText,
            bodyHtml: message.bodyHtml,
        });
    },
});

export const createNotificationWorker = (deps: NotificationWorkerDeps): NotificationWorker => {
    const limits = resolveWorkerLimits(deps.limits);
    const now = deps.now ?? (() => new Date());
    const log = deps.log ?? ((entry: unknown) => console.info(entry));
    const scheduler = deps.scheduler ?? defaultScheduler;
    const render = deps.render ?? outboxRowRenderer();

    let running = false;
    let timer: unknown = null;
    let lastRunAt: string | null = null;
    const inFlight = new Set<Promise<unknown>>();

    const readyRegistrations = (): AdapterRegistration[] =>
        deps.adapters.filter((registration) => registration.isReady() === true);

    const readyChannels = (): string[] => {
        const channels = new Set<string>();
        for (const registration of readyRegistrations()) channels.add(registration.adapter.channel);
        return [...channels];
    };

    /**
     * Wraps one registration with the worker's send-time authority. The wrapper
     * runs after the outbox has claimed the row and re-checked consent, i.e.
     * immediately before the provider call.
     */
    const buildAdapter = (registration: AdapterRegistration): DeliveryAdapter => ({
        channel: registration.adapter.channel,
        deliver: async (message) => {
            if (!registration.isReady()) return { outcome: 'unavailable', reason: 'adapter-not-ready' };
            const row = message.row;
            let resolved: ContactResolution;
            try {
                resolved = await resolveContactForSend(deps.contacts, {
                    tenantId: row.tenant_id,
                    userId: row.recipient_user_id,
                    userType: row.recipient_user_type,
                    channel: row.channel,
                    purpose: row.purpose,
                });
            } catch {
                // Fail closed: an unreadable contact store is a pre-send failure.
                return { outcome: 'failed', reason: 'contact-lookup-failed' };
            }
            if (!resolved.ok) return { outcome: 'failed', reason: resolved.reason, permanent: true };
            if (row.channel !== 'email' && resolved.verified !== true) {
                return { outcome: 'failed', reason: 'contact-not-verified', permanent: true };
            }
            try {
                return await registration.adapter.deliver({ ...message, contact: resolved.contact });
            } catch {
                // The request may already be on the wire: ambiguous, not unsent.
                return { outcome: 'unknown', reason: 'adapter-transport-error' };
            }
        },
    });

    const buildAdapters = (): DeliveryAdapter[] => {
        const byChannel = new Map<string, DeliveryAdapter>();
        for (const registration of readyRegistrations()) {
            if (byChannel.has(registration.adapter.channel)) continue;
            byChannel.set(registration.adapter.channel, buildAdapter(registration));
        }
        return [...byChannel.values()];
    };

    const dispatchOne = async (
        outboxId: string,
        adapters: readonly DeliveryAdapter[],
        options: DispatchOptions,
    ): Promise<WorkerRowResult> => {
        try {
            const result = await dispatchOutboxRow(deps.db, outboxId, adapters, options, deps.hmacKey);
            return { outboxId, outcome: result.outcome, reason: result.reason ?? null };
        } catch (error) {
            const reason = error instanceof Error && error.message.length > 0 ? error.message : 'unknown-error';
            log({ outboxId, outcome: 'error', reason: sanitizeReason(reason) });
            return { outboxId, outcome: 'error', reason: sanitizeReason(reason) };
        }
    };

    const runPass = async (): Promise<WorkerRunResult> => {
        const counts = emptyCounts();
        const rows: WorkerRowResult[] = [];
        const channels = readyChannels();
        if (channels.length === 0) return { claimed: 0, counts, rows };

        const ids = await claimDueOutboxIdsInScope(deps.db, {
            tenantId: deps.scope.tenantId,
            channels,
            limit: limits.batchSize,
            now,
        });
        if (ids.length === 0) return { claimed: 0, counts, rows };

        const adapters = buildAdapters();
        const options: DispatchOptions = {
            consent: deps.consent,
            render,
            linkSecret: deps.linkSecret,
            now,
            log,
            tenantScope: deps.scope.tenantId,
        };

        for (let start = 0; start < ids.length; start += limits.concurrency) {
            const chunk = ids.slice(start, start + limits.concurrency);
            const settled = await Promise.all(chunk.map((id) => dispatchOne(id, adapters, options)));
            for (const result of settled) {
                counts[result.outcome] += 1;
                rows.push(result);
            }
        }
        lastRunAt = now().toISOString();
        return { claimed: ids.length, counts, rows };
    };

    const track = <T>(promise: Promise<T>): Promise<T> => {
        inFlight.add(promise);
        void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
        return promise;
    };

    const runOnce = (): Promise<WorkerRunResult> => track(runPass());

    const tick = async (): Promise<void> => {
        if (!running) return;
        try {
            await track(runPass());
        } catch (error) {
            const reason = error instanceof Error && error.message.length > 0 ? error.message : 'unknown-error';
            log({ outcome: 'error', reason: sanitizeReason(reason) });
        }
        if (running) schedule();
    };

    const schedule = (): void => {
        timer = scheduler.setTimeout(() => { void tick(); }, limits.tickMs);
    };

    const start = (): void => {
        if (running) return;
        running = true;
        schedule();
    };

    const stop = async (): Promise<{ drained: boolean; inFlight: number }> => {
        running = false;
        if (timer !== null) {
            scheduler.clearTimeout(timer);
            timer = null;
        }
        const pending = [...inFlight];
        if (pending.length === 0) return { drained: true, inFlight: 0 };
        const settled = Promise.allSettled(pending).then(() => 'drained' as const);
        let handle: unknown = null;
        const timedOut = new Promise<'timeout'>((resolve) => {
            handle = scheduler.setTimeout(() => resolve('timeout'), limits.drainTimeoutMs);
        });
        const outcome = await Promise.race([settled, timedOut]);
        if (handle !== null) scheduler.clearTimeout(handle);
        return { drained: outcome === 'drained', inFlight: inFlight.size };
    };

    const reapStaleClaims = async (): Promise<StaleClaimReapResult> => {
        const result = await recoverStaleSendingRows(deps.db, {
            olderThanMs: limits.leaseMs,
            limit: limits.batchSize,
            now,
            log,
        });
        return {
            scanned: result.scanned,
            blocked: result.flagged.map((observation) => ({
                outboxId: observation.outboxId,
                reason: STALE_SENDING_MARKER,
            })),
        };
    };

    const status = (): { running: boolean; inFlight: number; lastRunAt: string | null } => ({
        running,
        inFlight: inFlight.size,
        lastRunAt,
    });

    return { start, stop, runOnce, reapStaleClaims, status };
};
