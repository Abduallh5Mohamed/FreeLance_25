"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveNotificationWorkerStartup = exports.STARTUP_REASONS = exports.createNotificationWorker = exports.toDeliveryAdapter = exports.createConsentLedgerGate = exports.resolveWorkerLimits = void 0;
const notification_consent_1 = require("./notification-consent");
const notification_outbox_1 = require("./notification-outbox");
const delivery_channels_1 = require("./delivery-channels");
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
/** Must exceed the slowest adapter timeout; the sweep treats it as a bound. */
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MIN_LEASE_MS = 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
const MAX_DRAIN_TIMEOUT_MS = 60000;
const DEFAULT_TICK_MS = 30000;
const MIN_TICK_MS = 1000;
const clampInt = (raw, fallback, min, max) => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw))
        return fallback;
    return Math.min(Math.max(raw, min), max);
};
const resolveWorkerLimits = (limits = {}) => ({
    batchSize: clampInt(limits.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
    concurrency: clampInt(limits.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    leaseMs: clampInt(limits.leaseMs, DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS),
    drainTimeoutMs: clampInt(limits.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, 1, MAX_DRAIN_TIMEOUT_MS),
    tickMs: clampInt(limits.tickMs, DEFAULT_TICK_MS, MIN_TICK_MS, 24 * 60 * 60 * 1000),
});
exports.resolveWorkerLimits = resolveWorkerLimits;
const emptyCounts = () => ({
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
const defaultScheduler = {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle),
};
const sanitizeReason = (reason) => (0, delivery_channels_1.redactPiiText)(reason).slice(0, 200);
/**
 * Consent gate backed by the live consent ledger. Every call is a fresh read
 * of `notification_consent_events`, so a STOP/unsubscribe recorded after the
 * row was queued denies the send immediately before the adapter fires.
 */
const createConsentLedgerGate = (db) => ({
    canDeliver: (input) => (0, notification_consent_1.canDeliverTo)(db, {
        userId: input.userId,
        userType: input.userType,
        purpose: input.purpose,
        channel: input.channel,
    }),
});
exports.createConsentLedgerGate = createConsentLedgerGate;
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
const toDeliveryAdapter = (adapter) => ({
    channel: adapter.channel,
    deliver: async (message) => {
        const readiness = adapter.readiness();
        if (!readiness.ready)
            return { outcome: 'unavailable', reason: readiness.reason };
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
exports.toDeliveryAdapter = toDeliveryAdapter;
const createNotificationWorker = (deps) => {
    const limits = (0, exports.resolveWorkerLimits)(deps.limits);
    const now = deps.now ?? (() => new Date());
    const log = deps.log ?? ((entry) => console.info(entry));
    const scheduler = deps.scheduler ?? defaultScheduler;
    const render = deps.render ?? (0, notification_outbox_1.outboxRowRenderer)();
    let running = false;
    let timer = null;
    let lastRunAt = null;
    const inFlight = new Set();
    const readyRegistrations = () => deps.adapters.filter((registration) => registration.isReady() === true);
    const readyChannels = () => {
        const channels = new Set();
        for (const registration of readyRegistrations())
            channels.add(registration.adapter.channel);
        return [...channels];
    };
    /**
     * Wraps one registration with the worker's send-time authority. The wrapper
     * runs after the outbox has claimed the row and re-checked consent, i.e.
     * immediately before the provider call.
     */
    const buildAdapter = (registration) => ({
        channel: registration.adapter.channel,
        deliver: async (message) => {
            if (!registration.isReady())
                return { outcome: 'unavailable', reason: 'adapter-not-ready' };
            const row = message.row;
            let resolved;
            try {
                resolved = await (0, delivery_channels_1.resolveContactForSend)(deps.contacts, {
                    tenantId: row.tenant_id,
                    userId: row.recipient_user_id,
                    userType: row.recipient_user_type,
                    channel: row.channel,
                    purpose: row.purpose,
                });
            }
            catch {
                // Fail closed: an unreadable contact store is a pre-send failure.
                return { outcome: 'failed', reason: 'contact-lookup-failed' };
            }
            if (!resolved.ok)
                return { outcome: 'failed', reason: resolved.reason, permanent: true };
            if (row.channel !== 'email' && resolved.verified !== true) {
                return { outcome: 'failed', reason: 'contact-not-verified', permanent: true };
            }
            try {
                return await registration.adapter.deliver({ ...message, contact: resolved.contact });
            }
            catch {
                // The request may already be on the wire: ambiguous, not unsent.
                return { outcome: 'unknown', reason: 'adapter-transport-error' };
            }
        },
    });
    const buildAdapters = () => {
        const byChannel = new Map();
        for (const registration of readyRegistrations()) {
            if (byChannel.has(registration.adapter.channel))
                continue;
            byChannel.set(registration.adapter.channel, buildAdapter(registration));
        }
        return [...byChannel.values()];
    };
    const dispatchOne = async (outboxId, adapters, options) => {
        try {
            const result = await (0, notification_outbox_1.dispatchOutboxRow)(deps.db, outboxId, adapters, options, deps.hmacKey);
            return { outboxId, outcome: result.outcome, reason: result.reason ?? null };
        }
        catch (error) {
            const reason = error instanceof Error && error.message.length > 0 ? error.message : 'unknown-error';
            log({ outboxId, outcome: 'error', reason: sanitizeReason(reason) });
            return { outboxId, outcome: 'error', reason: sanitizeReason(reason) };
        }
    };
    const runPass = async () => {
        const counts = emptyCounts();
        const rows = [];
        const channels = readyChannels();
        if (channels.length === 0)
            return { claimed: 0, counts, rows };
        const ids = await (0, notification_outbox_1.claimDueOutboxIdsInScope)(deps.db, {
            tenantId: deps.scope.tenantId,
            channels,
            limit: limits.batchSize,
            now,
        });
        if (ids.length === 0)
            return { claimed: 0, counts, rows };
        const adapters = buildAdapters();
        const options = {
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
    const track = (promise) => {
        inFlight.add(promise);
        void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
        return promise;
    };
    const runOnce = () => track(runPass());
    const tick = async () => {
        if (!running)
            return;
        try {
            await track(runPass());
        }
        catch (error) {
            const reason = error instanceof Error && error.message.length > 0 ? error.message : 'unknown-error';
            log({ outcome: 'error', reason: sanitizeReason(reason) });
        }
        if (running)
            schedule();
    };
    const schedule = () => {
        timer = scheduler.setTimeout(() => { void tick(); }, limits.tickMs);
    };
    const start = () => {
        if (running)
            return;
        running = true;
        schedule();
    };
    const stop = async () => {
        running = false;
        if (timer !== null) {
            scheduler.clearTimeout(timer);
            timer = null;
        }
        const pending = [...inFlight];
        if (pending.length === 0)
            return { drained: true, inFlight: 0 };
        const settled = Promise.allSettled(pending).then(() => 'drained');
        let handle = null;
        const timedOut = new Promise((resolve) => {
            handle = scheduler.setTimeout(() => resolve('timeout'), limits.drainTimeoutMs);
        });
        const outcome = await Promise.race([settled, timedOut]);
        if (handle !== null)
            scheduler.clearTimeout(handle);
        return { drained: outcome === 'drained', inFlight: inFlight.size };
    };
    const reapStaleClaims = async () => {
        // Tenant-bound, exactly like the claim/dispatch path: this worker may
        // not touch rows owned by another tenant's worker, even losslessly.
        const result = await (0, notification_outbox_1.recoverStaleSendingRows)(deps.db, {
            olderThanMs: limits.leaseMs,
            limit: limits.batchSize,
            tenantId: deps.scope.tenantId,
            now,
            log,
        });
        return {
            scanned: result.scanned,
            blocked: result.flagged.map((observation) => ({
                outboxId: observation.outboxId,
                reason: notification_outbox_1.STALE_SENDING_MARKER,
            })),
        };
    };
    const status = () => ({
        running,
        inFlight: inFlight.size,
        lastRunAt,
    });
    return { start, stop, runOnce, reapStaleClaims, status };
};
exports.createNotificationWorker = createNotificationWorker;
// ---------------------------------------------------------------------------
// W9-R1 — startup configuration / readiness (pure: no I/O, no timer, no send)
// ---------------------------------------------------------------------------
/**
 * Exact reason codes the integration owner maps onto its own readiness surface.
 * They are fixed strings on purpose: an operator must be able to tell "no
 * tenant" from "no secret" from "no provider", and a generic "not ready" hides
 * a misconfiguration that otherwise fails at 03:00 as an empty claim loop.
 */
exports.STARTUP_REASONS = {
    tenantUnresolved: 'tenant-unresolved',
    linkSecretMissing: 'link-secret-missing',
    contactHmacKeyMissing: 'contact-hmac-key-missing',
    noReadyChannel: 'no-ready-channel',
};
/** A contact-ref HMAC key shorter than this is treated as missing. */
const MIN_CONTACT_HMAC_KEY_BYTES = 16;
/**
 * Validates everything `createNotificationWorker` needs *before* it is
 * constructed, so a misconfigured process starts with an explicit refusal
 * instead of a worker that silently claims nothing (or, worse, one whose
 * missing link secret only surfaces per row).
 *
 * Callers must not `start()` the worker when `ready` is false; they should
 * report the reasons on their readiness surface and keep serving HTTP.
 */
const resolveNotificationWorkerStartup = (input) => {
    const reasons = [];
    const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
    if (tenantId.length === 0)
        reasons.push(exports.STARTUP_REASONS.tenantUnresolved);
    const rawLinkSecret = input.env.NOTIFICATION_LINK_SECRET;
    const linkSecret = typeof rawLinkSecret === 'string' && Buffer.byteLength(rawLinkSecret, 'utf8') >= notification_outbox_1.LINK_SECRET_MIN_BYTES
        ? rawLinkSecret
        : null;
    if (linkSecret === null)
        reasons.push(exports.STARTUP_REASONS.linkSecretMissing);
    const rawHmacKey = input.env.NOTIFICATION_CONTACT_HMAC_KEY;
    const hmacKey = typeof rawHmacKey === 'string' && Buffer.byteLength(rawHmacKey, 'utf8') >= MIN_CONTACT_HMAC_KEY_BYTES
        ? rawHmacKey
        : null;
    if (hmacKey === null)
        reasons.push(exports.STARTUP_REASONS.contactHmacKeyMissing);
    const channels = [...new Set(input.channels.filter((channel) => typeof channel === 'string' && channel.length > 0))];
    if (channels.length === 0)
        reasons.push(exports.STARTUP_REASONS.noReadyChannel);
    if (reasons.length > 0 || linkSecret === null || hmacKey === null) {
        return { ready: false, reasons };
    }
    return {
        ready: true,
        config: {
            tenantId,
            linkSecret,
            hmacKey,
            channels,
            limits: (0, exports.resolveWorkerLimits)(input.limits),
        },
    };
};
exports.resolveNotificationWorkerStartup = resolveNotificationWorkerStartup;
