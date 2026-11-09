"use strict";
/**
 * Notification runtime composition — W9-R1/I1 port.
 *
 * COMPOSITION ONLY, mirroring `services/live-runtime-factory.ts`. This module
 * wires pieces that other files already own: the outbox/consent/receipt tables
 * through an injected data access, the contact authority, the consent ledger
 * gate, the configured channel adapters, the worker's explicit startup
 * configuration and the bounded dispatch-recovery pass. It decides no policy,
 * mounts nothing, starts nothing, schedules nothing and opens no connection.
 * Importing it performs no I/O, starts no timer and sends nothing.
 *
 * WHAT A CALLER MUST SUPPLY (headings in `NotificationRuntimeDeps`):
 *  - `db` (REQUIRED): a genuine `NotificationDataAccess` — `query`, `queryOne`
 *    and `execute` all callable. A placeholder object (or one missing a
 *    method) is a construction error, not a readiness state: a factory built
 *    on a fake store can never be permitted to look configured.
 *  - `contacts` (REQUIRED): the purpose-scoped `PurposeContactStore`. There is
 *    no production implementation in this lane (a future opencode batch owns
 *    `notification-contact-sql.ts`, registered, still absent), so NOTHING is
 *    created here as a substitute — without a real store the factory cannot be
 *    constructed, and no no-op contact resolver is invented.
 *  - `adapters`: configured channel adapters from `delivery-channels.ts`
 *    (`createEmailAdapter` / `createSmsAdapter` / `createDeferredChannelAdapter`).
 *    Readiness is THEIR own signal: this factory never probes a provider and
 *    treats a readiness that is not `{ ready: false, reason }`-shaped truth as
 *    unready; a truthy placeholder ("config exists") is never configured.
 *    Duplicates by channel keep the first and note the rest.
 *  - `linkSecret` / `hmacKey` (REQUIRED): bounded per `LINK_SECRET_MIN_BYTES`
 *    and the contact-ref minimum; too short is a construction error and the
 *    reasons stay the worker's exact `STARTUP_REASONS` codes.
 *  - `tenantId` (REQUIRED): the server-resolved tenant; never a request value.
 *
 * READINESS IS SPLIT (as before a single boolean hid misconfiguration):
 *   1. CONFIGURATION — tenant, secrets, and ≥1 channel whose own
 *      `readiness()` says ready right now. `worker.status()` is never trusted
 *      as a runtime verdict; the ready set is re-evaluated per call.
 *   2. SCHEMA — applied only via `verifyNotificationSchema()`, an explicit,
 *      read-only `information_schema` probe that the CALLER decides to run;
 *      construction stays I/O-free. A report is accepted only when this module
 *      produced it FOR THIS db object (provenance-checked: a structurally identical
 *      literal is refused `invalid_deps`, like the live lane). An area can be
 *      `unverified`, `verified`, `absent`, `unavailable` or `invalidated`
 *      (runtime failure reported via `noteSchemaUnavailable`). A missing table
 *      can never be configured, because `verifySchema` never runs by itself.
 *   3. OPERATIONS — deliberately absent. Nothing here proves a live provider
 *      send, a durable sweep or that stop() ever drained; those stay claims a
 *      later authorized verification must make.
 *
 * `readiness().worker` is `'configured'` ONLY when the configuration is
 * complete AND every schema area in scope is `verified`, fresh, and not
 * invalidated. Config-without-schema is `unconfigured` with the gap named.
 *
 * START/STOP ORDER BELONGS TO THE INTEGRATION OWNER (worker contract §9):
 * validate → construct → mount → `worker.start()` after the HTTP server
 * listens; shutdown callers run `worker.stop()` BEFORE the pool closes. This
 * factory exposes the worker object and calls none of its lifecycle methods,
 * owns no timer of its own and never schedules one.
 *
 * RECOVERY IS EXPLICIT: `runRecoveryOnce` forwards ONE bounded pass of
 * `services/notification-dispatch-recovery.ts` verbatim (tenant-bound to this
 * scope), returning its report — including the `nextAfterId` keyset
 * continuation — unchanged. THE CALLER PERSISTS THE CONTINUATION: this factory
 * keeps no cursor, starts no scheduler and never re-sends. Reconciliation of a
 * quarantined row stays the outbox's `reconcileQuarantinedOutboxRow`; nothing
 * here resolves a row by itself.
 *
 * UNPROVEN AT RUNTIME. No database, no adapter, no provider, no worker pass
 * and no sweep was exercised while this file was written. It compiles and
 * composes; that is the whole claim.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotificationRuntime = exports.isNotificationSchemaReportFor = exports.verifyNotificationSchema = exports.NOTIFICATION_SCHEMA_AREAS = exports.NOTIFICATION_SCHEMA_MAX_AGE_MS = exports.MIN_CONTACT_HMAC_KEY_BYTES = exports.NOTIFICATION_RUNTIME_SCOPE = exports.NotificationRuntimeError = void 0;
const notification_outbox_1 = require("./notification-outbox");
const notification_worker_1 = require("./notification-worker");
const notification_dispatch_recovery_1 = require("./notification-dispatch-recovery");
class NotificationRuntimeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'NotificationRuntimeError';
    }
}
exports.NotificationRuntimeError = NotificationRuntimeError;
/** The path this readiness verdict covers. Never "all notifications". */
exports.NOTIFICATION_RUNTIME_SCOPE = 'notification.outbox-dispatch';
/** A contact-ref HMAC key shorter than this is treated as missing. */
exports.MIN_CONTACT_HMAC_KEY_BYTES = 16;
exports.NOTIFICATION_SCHEMA_MAX_AGE_MS = 15 * 60 * 1000;
/** The three tables the dispatch chain needs; probe is read-only, explicit. */
exports.NOTIFICATION_SCHEMA_AREAS = {
    outbox: 'notification_outbox',
    deliveryReceipts: 'notification_delivery_receipts',
    consentLedger: 'notification_consent_events',
};
const NOTIFICATION_SCHEMA_AREA_NAMES = [
    'outbox',
    'deliveryReceipts',
    'consentLedger',
];
/**
 * Provenance for a schema report: registered in a WeakMap keyed by the db
 * object it was measured FOR. Any structurally identical literal handed back
 * to `applySchemaReport` misses the registry and is refused, exactly like the
 * live lane treats look-alike reports.
 */
const schemaReportsByDb = new WeakMap();
/**
 * Explicit, READ-ONLY catalog probe of the three tables the dispatch chain
 * needs. Never DDL, never executed by this module on its own: the caller
 * decides when (and whether) verification happens. An unreadable catalog is
 * reported `unavailable` and registered as such — never guessed absent and
 * never assumed verified.
 */
const verifyNotificationSchema = async (db, now = Date.now) => {
    const areas = {
        outbox: 'unavailable',
        deliveryReceipts: 'unavailable',
        consentLedger: 'unavailable',
    };
    for (const area of NOTIFICATION_SCHEMA_AREA_NAMES) {
        try {
            const row = await db.queryOne(`SELECT COUNT(*) AS present FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [exports.NOTIFICATION_SCHEMA_AREAS[area]]);
            areas[area] = row && Number(row.present) > 0 ? 'verified' : 'absent';
        }
        catch {
            areas[area] = 'unavailable';
        }
    }
    const report = Object.freeze({
        checkedAtMs: now(),
        areas: Object.freeze(areas),
    });
    schemaReportsByDb.set(db, report);
    return { grant: report, reason: null };
};
exports.verifyNotificationSchema = verifyNotificationSchema;
/** True only for a report this module produced, FOR THIS db object. */
const isNotificationSchemaReportFor = (report, db) => typeof report === 'object' && report !== null && schemaReportsByDb.get(db) === report;
exports.isNotificationSchemaReportFor = isNotificationSchemaReportFor;
/** Freshness window: default and maximum, configurable DOWNWARD only. */
const resolveSchemaFreshnessMs = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return exports.NOTIFICATION_SCHEMA_MAX_AGE_MS;
    const truncated = Math.trunc(value);
    return truncated <= 0 ? exports.NOTIFICATION_SCHEMA_MAX_AGE_MS : Math.min(exports.NOTIFICATION_SCHEMA_MAX_AGE_MS, truncated);
};
/** Channels the configured adapters may possibly carry; `ready` decides claimability. */
const POSSIBLE_ADAPTER_CHANNELS = ['email', 'sms', 'whatsapp'];
/**
 * Build the notification runtime. Throws before constructing anything when a
 * mandatory dependency is missing or deformed — there is no partial runtime,
 * no fallback store, no placeholder contact resolver and no fabricated secret.
 */
const createNotificationRuntime = (deps) => {
    if (!deps || typeof deps !== 'object') {
        throw new NotificationRuntimeError('invalid_deps', 'createNotificationRuntime requires a deps object');
    }
    const dbShaped = deps.db !== null && typeof deps.db === 'object'
        && typeof deps.db.query === 'function'
        && typeof deps.db.queryOne === 'function'
        && typeof deps.db.execute === 'function';
    if (!dbShaped) {
        throw new NotificationRuntimeError('invalid_deps', 'createNotificationRuntime requires a data access with callable query/queryOne/execute; '
            + 'a placeholder object can never back the outbox, receipts and consent ledger');
    }
    const contactsShaped = deps.contacts !== null && typeof deps.contacts === 'object'
        && typeof deps.contacts.findContactForPurpose === 'function';
    if (!contactsShaped) {
        throw new NotificationRuntimeError('invalid_deps', 'createNotificationRuntime requires a purpose-scoped contact store; there is no no-op and no '
            + '"any contact on file" fallback');
    }
    const tenantId = typeof deps.tenantId === 'string' ? deps.tenantId.trim() : '';
    if (tenantId.length === 0) {
        throw new NotificationRuntimeError('invalid_deps', `createNotificationRuntime requires a server-resolved tenantId (${notification_worker_1.STARTUP_REASONS.tenantUnresolved})`);
    }
    if (typeof deps.linkSecret !== 'string' || Buffer.byteLength(deps.linkSecret, 'utf8') < notification_outbox_1.LINK_SECRET_MIN_BYTES) {
        throw new NotificationRuntimeError('invalid_deps', `createNotificationRuntime requires a link secret of at least ${notification_outbox_1.LINK_SECRET_MIN_BYTES} bytes `
            + `(${notification_worker_1.STARTUP_REASONS.linkSecretMissing})`);
    }
    if (typeof deps.hmacKey !== 'string' || Buffer.byteLength(deps.hmacKey, 'utf8') < exports.MIN_CONTACT_HMAC_KEY_BYTES) {
        throw new NotificationRuntimeError('invalid_deps', `createNotificationRuntime requires a contact-ref HMAC key of at least `
            + `${exports.MIN_CONTACT_HMAC_KEY_BYTES} bytes (${notification_worker_1.STARTUP_REASONS.contactHmacKeyMissing})`);
    }
    const limits = (0, notification_worker_1.resolveWorkerLimits)(deps.limits);
    const schemaFreshnessMs = resolveSchemaFreshnessMs(deps.schemaFreshnessMs);
    const log = deps.log ?? ((entry) => console.info(entry));
    const render = (0, notification_outbox_1.outboxRowRenderer)();
    // ---- adapter wiring (explicit readiness; duplicates keep the first) ----
    const channelWiring = [];
    const registrations = [];
    const seenChannels = new Set();
    for (const candidate of deps.adapters ?? []) {
        const isShaped = candidate !== null && typeof candidate === 'object'
            && typeof candidate.channel === 'string'
            && typeof candidate.readiness === 'function'
            && typeof candidate.send === 'function';
        if (!isShaped) {
            channelWiring.push({ channel: 'unknown', wired: false, reason: 'adapter-shape-invalid' });
            continue;
        }
        const channel = candidate.channel;
        if (!POSSIBLE_ADAPTER_CHANNELS.includes(channel)) {
            channelWiring.push({ channel, wired: false, reason: 'adapter-channel-not-dispatchable' });
            continue;
        }
        if (seenChannels.has(channel)) {
            channelWiring.push({ channel, wired: false, reason: 'adapter-channel-duplicate-ignored' });
            continue;
        }
        seenChannels.add(channel);
        channelWiring.push({ channel, wired: true, reason: null });
        registrations.push({
            adapter: (0, notification_worker_1.toDeliveryAdapter)(candidate),
            // The adapter owns the readiness truth; this factory only relays
            // it, deforming to `false` when the adapter misbehaves, so a
            // readiness that is not truthful shape is UNREADY, never ready.
            isReady: () => {
                try {
                    const state = candidate.readiness();
                    return state !== null && typeof state === 'object' && state.ready === true;
                }
                catch {
                    return false;
                }
            },
        });
    }
    // ---- compose the worker (never started here; call start() after listen) ----
    const worker = (0, notification_worker_1.createNotificationWorker)({
        db: deps.db,
        scope: { tenantId },
        adapters: registrations,
        contacts: deps.contacts,
        consent: (0, notification_worker_1.createConsentLedgerGate)(deps.db),
        linkSecret: deps.linkSecret,
        hmacKey: deps.hmacKey,
        render,
        now: deps.now,
        log,
        limits: deps.limits,
    });
    // ---- schema report state (provenance-checked; no report ⇒ unverified) ----
    let schemaReport = null;
    if (deps.schemaReport !== undefined && deps.schemaReport !== null) {
        if (!(0, exports.isNotificationSchemaReportFor)(deps.schemaReport, deps.db)) {
            throw new NotificationRuntimeError('invalid_deps', 'the schema report was not produced by verifyNotificationSchema for THIS db object; '
                + 'a structurally similar object is not evidence about this connection');
        }
        schemaReport = deps.schemaReport;
    }
    const invalidated = new Map();
    const status = {
        scope: exports.NOTIFICATION_RUNTIME_SCOPE,
        tenantId,
        channels: Object.freeze(channelWiring),
        linkSecretPresent: true,
        hmacKeyPresent: true,
        limits,
        schemaAppliedAtMs: schemaReport?.checkedAtMs ?? null,
        schemaFreshnessMs,
        workerConstructed: true,
        reasons: Object.freeze({}),
    };
    const getReadyChannels = () => {
        const ready = [];
        for (const registration of registrations) {
            if (registration.isReady())
                ready.push(registration.adapter.channel);
        }
        return ready;
    };
    const readiness = () => {
        const reasons = {};
        const now = deps.now ?? (() => new Date());
        const nowMs = now().getTime();
        const schema = {
            outbox: 'unverified',
            deliveryReceipts: 'unverified',
            consentLedger: 'unverified',
        };
        let schemaPresent = false;
        let schemaCheckedAtMs = null;
        let schemaAgeMs = null;
        let schemaFresh = false;
        if (schemaReport !== null) {
            schemaPresent = true;
            schemaCheckedAtMs = schemaReport.checkedAtMs;
            schemaAgeMs = nowMs - schemaReport.checkedAtMs;
            schemaFresh = schemaAgeMs <= schemaFreshnessMs;
            for (const area of NOTIFICATION_SCHEMA_AREA_NAMES) {
                const declared = schemaReport.areas[area];
                if (invalidated.has(area))
                    schema[area] = 'invalidated';
                else
                    schema[area] = declared;
            }
        }
        const invalidatedOut = {};
        for (const [area, entry] of invalidated)
            invalidatedOut[area] = entry;
        // Configuration re-evaluated at call time against the worker's own
        // exact reason codes; a stale or missing schema keeps the verdict
        // conservative even when configuration is otherwise complete.
        const readyChannels = getReadyChannels();
        let workerReady = true;
        if (tenantId.length === 0) {
            reasons[notification_worker_1.STARTUP_REASONS.tenantUnresolved] = 'no server-resolved tenant for this process';
            workerReady = false;
        }
        if (typeof deps.linkSecret !== 'string' || Buffer.byteLength(deps.linkSecret, 'utf8') < notification_outbox_1.LINK_SECRET_MIN_BYTES) {
            reasons[notification_worker_1.STARTUP_REASONS.linkSecretMissing] = `link secret is missing or shorter than ${notification_outbox_1.LINK_SECRET_MIN_BYTES} bytes`;
            workerReady = false;
        }
        if (typeof deps.hmacKey !== 'string' || Buffer.byteLength(deps.hmacKey, 'utf8') < exports.MIN_CONTACT_HMAC_KEY_BYTES) {
            reasons[notification_worker_1.STARTUP_REASONS.contactHmacKeyMissing] =
                `contact-ref HMAC key is missing or shorter than ${exports.MIN_CONTACT_HMAC_KEY_BYTES} bytes`;
            workerReady = false;
        }
        if (readyChannels.length === 0) {
            reasons[notification_worker_1.STARTUP_REASONS.noReadyChannel] = 'no channel reports its own adapter readiness right now';
            workerReady = false;
        }
        if (schemaReport === null) {
            reasons['schema-unverified'] = 'no schema report was applied; run and apply verifyNotificationSchema';
            workerReady = false;
        }
        else if (!schemaFresh) {
            reasons['schema-report-stale'] = `the applied schema report is older than ${schemaFreshnessMs} ms`;
            workerReady = false;
        }
        else {
            for (const area of NOTIFICATION_SCHEMA_AREA_NAMES) {
                if (schema[area] === 'verified')
                    continue;
                workerReady = false;
                reasons[`schema-${area}`] = `table state is ${schema[area]}`;
            }
        }
        return {
            evaluatedAtMs: nowMs,
            scope: exports.NOTIFICATION_RUNTIME_SCOPE,
            schema,
            schemaReportPresent: schemaPresent,
            schemaCheckedAtMs,
            schemaAgeMs,
            schemaFresh,
            schemaFreshnessMs,
            invalidated: invalidatedOut,
            readyChannels,
            worker: workerReady ? 'configured' : 'unconfigured',
            reasons,
        };
    };
    return {
        worker,
        status,
        readiness,
        applySchemaReport: (report) => {
            if (!(0, exports.isNotificationSchemaReportFor)(report, deps.db)) {
                throw new NotificationRuntimeError('invalid_deps', 'the schema report was not produced by verifyNotificationSchema for THIS db object');
            }
            schemaReport = report;
            invalidated.clear();
        },
        noteSchemaUnavailable: (area, reason) => {
            if (!NOTIFICATION_SCHEMA_AREA_NAMES.includes(area)) {
                throw new NotificationRuntimeError('invalid_deps', `unknown notification schema area: ${String(area)}`);
            }
            const now = deps.now ?? (() => new Date());
            invalidated.set(area, { atMs: now().getTime(), reason: String(reason).slice(0, 160) });
        },
        runRecoveryOnce: async (options) => 
        // One bounded, tenant-bound pass; forwarded verbatim; the factory
        // keeps no cursor — persisting `report.quarantined.nextAfterId`
        // between invocations is the caller's obligation.
        (0, notification_dispatch_recovery_1.runDispatchRecoveryOnce)(deps.db, { ...(options ?? {}), tenantId }),
    };
};
exports.createNotificationRuntime = createNotificationRuntime;
