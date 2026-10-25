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

import type { NotificationDataAccess } from './notification-consent';
import {
    LINK_SECRET_MIN_BYTES,
    outboxRowRenderer,
    type OutboxRow,
    type TemplateRenderResult,
} from './notification-outbox';
import {
    STARTUP_REASONS,
    createConsentLedgerGate,
    createNotificationWorker,
    toDeliveryAdapter,
    resolveWorkerLimits,
    type AdapterRegistration,
    type NotificationWorker,
    type ResolvedWorkerLimits,
    type WorkerLimits,
} from './notification-worker';
import type { ConfiguredChannelAdapter, PurposeContactStore } from './delivery-channels';
import {
    runDispatchRecoveryOnce,
    type DispatchRecoveryOptions,
    type DispatchRecoveryReport,
} from './notification-dispatch-recovery';

export class NotificationRuntimeError extends Error {
    constructor(public readonly code: 'invalid_deps', message: string) {
        super(message);
        this.name = 'NotificationRuntimeError';
    }
}

/** The path this readiness verdict covers. Never "all notifications". */
export const NOTIFICATION_RUNTIME_SCOPE = 'notification.outbox-dispatch';

/** A contact-ref HMAC key shorter than this is treated as missing. */
export const MIN_CONTACT_HMAC_KEY_BYTES = 16;

export type NotificationCapability = 'configured' | 'unconfigured';

export type NotificationSchemaAreaState =
    | 'verified'
    | 'absent'
    | 'unavailable'
    | 'invalidated'
    | 'unverified';

export const NOTIFICATION_SCHEMA_MAX_AGE_MS = 15 * 60 * 1000;

/** The three tables the dispatch chain needs; probe is read-only, explicit. */
export const NOTIFICATION_SCHEMA_AREAS = {
    outbox: 'notification_outbox',
    deliveryReceipts: 'notification_delivery_receipts',
    consentLedger: 'notification_consent_events',
} as const;

export type NotificationSchemaArea = keyof typeof NOTIFICATION_SCHEMA_AREAS;

const NOTIFICATION_SCHEMA_AREA_NAMES: readonly NotificationSchemaArea[] = [
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
const schemaReportsByDb = new WeakMap<object, NotificationSchemaReport>();

export interface NotificationSchemaReport {
    readonly checkedAtMs: number;
    readonly areas: Readonly<Record<NotificationSchemaArea, 'verified' | 'absent' | 'unavailable'>>;
}

export interface VerifyNotificationSchemaResult {
    grant: NotificationSchemaReport | null;
    reason: string | null;
}

/**
 * Explicit, READ-ONLY catalog probe of the three tables the dispatch chain
 * needs. Never DDL, never executed by this module on its own: the caller
 * decides when (and whether) verification happens. An unreadable catalog is
 * reported `unavailable` and registered as such — never guessed absent and
 * never assumed verified.
 */
export const verifyNotificationSchema = async (
    db: NotificationDataAccess,
    now: () => number = Date.now,
): Promise<VerifyNotificationSchemaResult> => {
    const areas: Record<NotificationSchemaArea, 'verified' | 'absent' | 'unavailable'> = {
        outbox: 'unavailable',
        deliveryReceipts: 'unavailable',
        consentLedger: 'unavailable',
    };
    for (const area of NOTIFICATION_SCHEMA_AREA_NAMES) {
        try {
            const row = await db.queryOne<{ present: number | string | null }>(
                `SELECT COUNT(*) AS present FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                [NOTIFICATION_SCHEMA_AREAS[area]],
            );
            areas[area] = row && Number(row.present) > 0 ? 'verified' : 'absent';
        } catch {
            areas[area] = 'unavailable';
        }
    }
    const report: NotificationSchemaReport = Object.freeze({
        checkedAtMs: now(),
        areas: Object.freeze(areas),
    });
    schemaReportsByDb.set(db, report);
    return { grant: report, reason: null };
};

/** True only for a report this module produced, FOR THIS db object. */
export const isNotificationSchemaReportFor = (
    report: unknown,
    db: NotificationDataAccess,
): report is NotificationSchemaReport =>
    typeof report === 'object' && report !== null && schemaReportsByDb.get(db) === report;

/** Freshness window: default and maximum, configurable DOWNWARD only. */
const resolveSchemaFreshnessMs = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return NOTIFICATION_SCHEMA_MAX_AGE_MS;
    const truncated = Math.trunc(value);
    return truncated <= 0 ? NOTIFICATION_SCHEMA_MAX_AGE_MS : Math.min(NOTIFICATION_SCHEMA_MAX_AGE_MS, truncated);
};

export interface NotificationRuntimeDeps {
    /** REQUIRED. Bound data access for outbox, receipts and consent pages. */
    db: NotificationDataAccess;
    /** REQUIRED. Purpose-scoped contact authority; no substitute is created. */
    contacts: PurposeContactStore;
    /** Server-resolved tenant; never a request or client value. */
    tenantId: string;
    /** Bounded per LINK_SECRET_MIN_BYTES; shorter is a construction error. */
    linkSecret: string;
    /** Bounded per MIN_CONTACT_HMAC_KEY_BYTES; shorter is a construction error. */
    hmacKey: string;
    /** Configured channel adapters (see delivery-channels.ts factories). */
    adapters?: readonly ConfiguredChannelAdapter[];
    limits?: WorkerLimits;
    now?: () => Date;
    log?: (entry: unknown) => void;
    /** Explicit report from verifyNotificationSchema, bound to THIS db. */
    schemaReport?: NotificationSchemaReport | null;
    /** How long an applied report stays fresh; configurable downward only. */
    schemaFreshnessMs?: number;
}

/** One adapter's wiring as the construction-time snapshot records it. */
export interface NotificationChannelWiring {
    readonly channel: string;
    /** Registered onto the worker (this keeps to the writable, non-duplicate set). */
    readonly wired: boolean;
    /** Exact reason an adapter was not wired or was skipped. */
    readonly reason: string | null;
}

/**
 * The construction-time SNAPSHOT of what was wired. Every field is a
 * configuration fact measured once, at build time; none of them is a runtime
 * verdict — freshness, ready channels and the overall verdict live in
 * `readiness()`, re-evaluated on every call.
 */
export interface NotificationRuntimeStatus {
    readonly scope: typeof NOTIFICATION_RUNTIME_SCOPE;
    readonly tenantId: string;
    readonly channels: readonly NotificationChannelWiring[];
    readonly linkSecretPresent: boolean;
    readonly hmacKeyPresent: boolean;
    readonly limits: ResolvedWorkerLimits;
    readonly schemaAppliedAtMs: number | null;
    readonly schemaFreshnessMs: number;
    /** Worker instance construction succeeded always; the field stays explicit. */
    readonly workerConstructed: true;
    readonly reasons: Readonly<Record<string, string>>;
}

export interface NotificationRuntimeReadiness {
    readonly evaluatedAtMs: number;
    readonly scope: typeof NOTIFICATION_RUNTIME_SCOPE;
    readonly schema: Readonly<Record<NotificationSchemaArea, NotificationSchemaAreaState>>;
    readonly schemaReportPresent: boolean;
    readonly schemaCheckedAtMs: number | null;
    readonly schemaAgeMs: number | null;
    readonly schemaFresh: boolean;
    readonly schemaFreshnessMs: number;
    readonly invalidated: Readonly<Record<string, { atMs: number; reason: string }>>;
    /** Channels whose OWN readiness() says ready at call time. */
    readonly readyChannels: readonly string[];
    /** The overall configuration verdict, schema included. */
    readonly worker: NotificationCapability;
    readonly reasons: Readonly<Record<string, string>>;
}

/** Channels the configured adapters may possibly carry; `ready` decides claimability. */
const POSSIBLE_ADAPTER_CHANNELS: readonly string[] = ['email', 'sms', 'whatsapp'];

export interface NotificationRuntime {
    readonly worker: NotificationWorker;
    readonly status: NotificationRuntimeStatus;
    /**
     * The authoritative verdict, evaluated NOW: configuration + applied schema
     * report + freshness + invalidation. Cheap and side-effect free; call it
     * for any health/readiness surface instead of trusting `status`.
     */
    readiness(): NotificationRuntimeReadiness;
    /**
     * Apply a report produced by `verifyNotificationSchema` for THIS db object.
     * Anything else throws `invalid_deps`. Applying one clears recorded
     * invalidations: a fresh measurement outranks the error it replaces.
     */
    applySchemaReport(report: NotificationSchemaReport): void;
    /**
     * Record a runtime failure on one schema area observed by the caller
     * (typically at a route boundary). That area reads `invalidated` and the
     * verdict drops until a newer report is applied. The area is named BY THE
     * CALLER — never guessed from an error string.
     */
    noteSchemaUnavailable(area: NotificationSchemaArea, reason: string): void;
    /**
     * ONE bounded, tenant-bound recovery pass (see
     * `notification-dispatch-recovery.ts`). Explicit call only; never
     * scheduled; options forwarded verbatim; the report (including the
     * keyset continuation) is returned unchanged.
     */
    runRecoveryOnce(options?: Omit<DispatchRecoveryOptions, 'tenantId'>): Promise<DispatchRecoveryReport>;
}

/**
 * Build the notification runtime. Throws before constructing anything when a
 * mandatory dependency is missing or deformed — there is no partial runtime,
 * no fallback store, no placeholder contact resolver and no fabricated secret.
 */
export const createNotificationRuntime = (deps: NotificationRuntimeDeps): NotificationRuntime => {
    if (!deps || typeof deps !== 'object') {
        throw new NotificationRuntimeError('invalid_deps', 'createNotificationRuntime requires a deps object');
    }
    const dbShaped =
        deps.db !== null && typeof deps.db === 'object'
        && typeof (deps.db as { query?: unknown }).query === 'function'
        && typeof (deps.db as { queryOne?: unknown }).queryOne === 'function'
        && typeof (deps.db as { execute?: unknown }).execute === 'function';
    if (!dbShaped) {
        throw new NotificationRuntimeError(
            'invalid_deps',
            'createNotificationRuntime requires a data access with callable query/queryOne/execute; '
                + 'a placeholder object can never back the outbox, receipts and consent ledger',
        );
    }
    const contactsShaped =
        deps.contacts !== null && typeof deps.contacts === 'object'
        && typeof (deps.contacts as { findContactForPurpose?: unknown }).findContactForPurpose === 'function';
    if (!contactsShaped) {
        throw new NotificationRuntimeError(
            'invalid_deps',
            'createNotificationRuntime requires a purpose-scoped contact store; there is no no-op and no '
                + '"any contact on file" fallback',
        );
    }
    const tenantId = typeof deps.tenantId === 'string' ? deps.tenantId.trim() : '';
    if (tenantId.length === 0) {
        throw new NotificationRuntimeError(
            'invalid_deps',
            `createNotificationRuntime requires a server-resolved tenantId (${STARTUP_REASONS.tenantUnresolved})`,
        );
    }
    if (typeof deps.linkSecret !== 'string' || Buffer.byteLength(deps.linkSecret, 'utf8') < LINK_SECRET_MIN_BYTES) {
        throw new NotificationRuntimeError(
            'invalid_deps',
            `createNotificationRuntime requires a link secret of at least ${LINK_SECRET_MIN_BYTES} bytes `
                + `(${STARTUP_REASONS.linkSecretMissing})`,
        );
    }
    if (typeof deps.hmacKey !== 'string' || Buffer.byteLength(deps.hmacKey, 'utf8') < MIN_CONTACT_HMAC_KEY_BYTES) {
        throw new NotificationRuntimeError(
            'invalid_deps',
            `createNotificationRuntime requires a contact-ref HMAC key of at least `
                + `${MIN_CONTACT_HMAC_KEY_BYTES} bytes (${STARTUP_REASONS.contactHmacKeyMissing})`,
        );
    }

    const limits = resolveWorkerLimits(deps.limits);
    const schemaFreshnessMs = resolveSchemaFreshnessMs(deps.schemaFreshnessMs);
    const log = deps.log ?? ((entry: unknown) => console.info(entry));
    const render: (row: OutboxRow) => TemplateRenderResult = outboxRowRenderer();

    // ---- adapter wiring (explicit readiness; duplicates keep the first) ----
    const channelWiring: NotificationChannelWiring[] = [];
    const registrations: AdapterRegistration[] = [];
    const seenChannels = new Set<string>();
    for (const candidate of deps.adapters ?? []) {
        const isShaped =
            candidate !== null && typeof candidate === 'object'
            && typeof (candidate as { channel?: unknown }).channel === 'string'
            && typeof (candidate as { readiness?: unknown }).readiness === 'function'
            && typeof (candidate as { send?: unknown }).send === 'function';
        if (!isShaped) {
            channelWiring.push({ channel: 'unknown', wired: false, reason: 'adapter-shape-invalid' });
            continue;
        }
        const channel = candidate.channel;
        if (!(POSSIBLE_ADAPTER_CHANNELS as readonly string[]).includes(channel)) {
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
            adapter: toDeliveryAdapter(candidate),
            // The adapter owns the readiness truth; this factory only relays
            // it, deforming to `false` when the adapter misbehaves, so a
            // readiness that is not truthful shape is UNREADY, never ready.
            isReady: (): boolean => {
                try {
                    const state = candidate.readiness();
                    return state !== null && typeof state === 'object' && state.ready === true;
                } catch {
                    return false;
                }
            },
        });
    }

    // ---- compose the worker (never started here; call start() after listen) ----
    const worker = createNotificationWorker({
        db: deps.db,
        scope: { tenantId },
        adapters: registrations,
        contacts: deps.contacts,
        consent: createConsentLedgerGate(deps.db),
        linkSecret: deps.linkSecret,
        hmacKey: deps.hmacKey,
        render,
        now: deps.now,
        log,
        limits: deps.limits,
    });

    // ---- schema report state (provenance-checked; no report ⇒ unverified) ----
    let schemaReport: NotificationSchemaReport | null = null;
    if (deps.schemaReport !== undefined && deps.schemaReport !== null) {
        if (!isNotificationSchemaReportFor(deps.schemaReport, deps.db)) {
            throw new NotificationRuntimeError(
                'invalid_deps',
                'the schema report was not produced by verifyNotificationSchema for THIS db object; '
                    + 'a structurally similar object is not evidence about this connection',
            );
        }
        schemaReport = deps.schemaReport;
    }
    const invalidated = new Map<NotificationSchemaArea, { atMs: number; reason: string }>();

    const status: NotificationRuntimeStatus = {
        scope: NOTIFICATION_RUNTIME_SCOPE,
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

    const getReadyChannels = (): string[] => {
        const ready: string[] = [];
        for (const registration of registrations) {
            if (registration.isReady()) ready.push(registration.adapter.channel);
        }
        return ready;
    };

    const readiness = (): NotificationRuntimeReadiness => {
        const reasons: Record<string, string> = {};
        const now = deps.now ?? (() => new Date());
        const nowMs = now().getTime();
        const schema: Record<NotificationSchemaArea, NotificationSchemaAreaState> = {
            outbox: 'unverified',
            deliveryReceipts: 'unverified',
            consentLedger: 'unverified',
        };
        let schemaPresent = false;
        let schemaCheckedAtMs: number | null = null;
        let schemaAgeMs: number | null = null;
        let schemaFresh = false;
        if (schemaReport !== null) {
            schemaPresent = true;
            schemaCheckedAtMs = schemaReport.checkedAtMs;
            schemaAgeMs = nowMs - schemaReport.checkedAtMs;
            schemaFresh = schemaAgeMs <= schemaFreshnessMs;
            for (const area of NOTIFICATION_SCHEMA_AREA_NAMES) {
                const declared = schemaReport.areas[area];
                if (invalidated.has(area)) schema[area] = 'invalidated';
                else schema[area] = declared;
            }
        }
        const invalidatedOut: Record<string, { atMs: number; reason: string }> = {};
        for (const [area, entry] of invalidated) invalidatedOut[area] = entry;

        // Configuration re-evaluated at call time against the worker's own
        // exact reason codes; a stale or missing schema keeps the verdict
        // conservative even when configuration is otherwise complete.
        const readyChannels = getReadyChannels();
        let workerReady = true;
        if (tenantId.length === 0) {
            reasons[STARTUP_REASONS.tenantUnresolved] = 'no server-resolved tenant for this process';
            workerReady = false;
        }
        if (typeof deps.linkSecret !== 'string' || Buffer.byteLength(deps.linkSecret, 'utf8') < LINK_SECRET_MIN_BYTES) {
            reasons[STARTUP_REASONS.linkSecretMissing] = `link secret is missing or shorter than ${LINK_SECRET_MIN_BYTES} bytes`;
            workerReady = false;
        }
        if (typeof deps.hmacKey !== 'string' || Buffer.byteLength(deps.hmacKey, 'utf8') < MIN_CONTACT_HMAC_KEY_BYTES) {
            reasons[STARTUP_REASONS.contactHmacKeyMissing] =
                `contact-ref HMAC key is missing or shorter than ${MIN_CONTACT_HMAC_KEY_BYTES} bytes`;
            workerReady = false;
        }
        if (readyChannels.length === 0) {
            reasons[STARTUP_REASONS.noReadyChannel] = 'no channel reports its own adapter readiness right now';
            workerReady = false;
        }
        if (schemaReport === null) {
            reasons['schema-unverified'] = 'no schema report was applied; run and apply verifyNotificationSchema';
            workerReady = false;
        } else if (!schemaFresh) {
            reasons['schema-report-stale'] = `the applied schema report is older than ${schemaFreshnessMs} ms`;
            workerReady = false;
        } else {
            for (const area of NOTIFICATION_SCHEMA_AREA_NAMES) {
                if (schema[area] === 'verified') continue;
                workerReady = false;
                reasons[`schema-${area}`] = `table state is ${schema[area]}`;
            }
        }

        return {
            evaluatedAtMs: nowMs,
            scope: NOTIFICATION_RUNTIME_SCOPE,
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
        applySchemaReport: (report: NotificationSchemaReport): void => {
            if (!isNotificationSchemaReportFor(report, deps.db)) {
                throw new NotificationRuntimeError(
                    'invalid_deps',
                    'the schema report was not produced by verifyNotificationSchema for THIS db object',
                );
            }
            schemaReport = report;
            invalidated.clear();
        },
        noteSchemaUnavailable: (area: NotificationSchemaArea, reason: string): void => {
            if (!NOTIFICATION_SCHEMA_AREA_NAMES.includes(area)) {
                throw new NotificationRuntimeError('invalid_deps', `unknown notification schema area: ${String(area)}`);
            }
            const now = deps.now ?? (() => new Date());
            invalidated.set(area, { atMs: now().getTime(), reason: String(reason).slice(0, 160) });
        },
        runRecoveryOnce: async (options?: Omit<DispatchRecoveryOptions, 'tenantId'>): Promise<DispatchRecoveryReport> =>
            // One bounded, tenant-bound pass; forwarded verbatim; the factory
            // keeps no cursor — persisting `report.quarantined.nextAfterId`
            // between invocations is the caller's obligation.
            runDispatchRecoveryOnce(deps.db, { ...(options ?? {}), tenantId }),
    };
};
