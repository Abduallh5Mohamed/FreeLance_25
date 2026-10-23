/**
 * Composition root for assignment cleanup + upload/scan recovery.
 *
 * This module is the only place that decides *which* recovery passes can run in
 * a given deployment, and it is deliberately explicit about what it cannot do:
 *
 *  - it performs no I/O at construction or import: no connection, no query, no
 *    timer, no environment read beyond what an injected port already owns;
 *  - it never mounts itself and never starts anything — an owner must call
 *    `runOnce()` from an explicit scheduler (see the delivery doc for the exact
 *    lifecycle hooks);
 *  - an absent dependency is reported as `unconfigured` with a reason, never
 *    simulated. A missing durable store does not become an in-memory queue, a
 *    missing scanner does not become a verdict, and a missing exact-version
 *    delete does not become a key delete;
 *  - `describeReadiness()` is **configuration** readiness. It is not a
 *    verification: nothing here proves the schema, the adapter or the scanner
 *    actually works. That distinction is stated in the type, not just in a
 *    comment.
 *
 * No `any`, no ts-ignore, no network at import, no timer at construction.
 */

import { createAssignmentCleanupRecovery } from './assignment-cleanup-recovery';
import type {
    AssignmentCleanupObligationStore,
    AssignmentCleanupRunReport,
    AssignmentObjectListing,
    AssignmentSubmissionLookup,
} from './assignment-cleanup-recovery';
import { createAssignmentScanWorker } from './assignment-scan-worker';
import type {
    AssignmentScanRunResult,
    AssignmentScanStore,
} from './assignment-scan-worker';
import type { AssignmentObjectStore, MalwareScanner } from './assignment-storage';

/* ------------------------------------------------------------------------- */
/* Readiness                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Why a pass cannot run. Closed union: a caller that wants to explain a status
 * to an operator must be able to match on it, so a free-form string would be
 * useless.
 */
export type AssignmentRecoveryReason =
    /** No durable obligation store: cleanup cannot be recorded, so it is not attempted. */
    | 'cleanup-store-unconfigured'
    /** A durable obligation store was injected but declares itself unusable. */
    | 'cleanup-store-unavailable'
    /** The adapter cannot delete an exact object version: nothing may be deleted. */
    | 'exact-delete-unsupported'
    /** No object store: neither pass can read an object's version, so neither runs. */
    | 'object-store-unconfigured'
    /** No scan store: pending rows cannot be claimed or given a verdict. */
    | 'scan-store-unconfigured'
    /** A fenced scan store was requested and its schema/collation precondition fails. */
    | 'scan-store-unavailable'
    /** No verified scanner: uploaded is never clean. */
    | 'scanner-unconfigured'
    /** No tenant-scoped listing: orphan planning cannot inspect anything. */
    | 'orphan-listing-unconfigured'
    /** No submission lookup: an object can never be proven orphaned. */
    | 'orphan-lookup-unconfigured';

export interface AssignmentRecoveryReadiness {
    /** `configured` only when a durable store **and** an exact-version delete exist. */
    cleanup: 'configured' | 'unconfigured';
    /** `configured` only when a scan store **and** a verified scanner exist. */
    scanRecovery: 'configured' | 'unconfigured';
    /** `configured` only when a tenant listing **and** a submission lookup exist. */
    orphanPlanning: 'configured' | 'unconfigured';
    durableCleanupStore: 'configured' | 'unconfigured';
    exactVersionDelete: 'supported' | 'unsupported' | 'unknown';
    scanner: 'configured' | 'unconfigured';
    /** Which claim discipline the scan pass will actually use. */
    scanClaimFencing: 'fenced' | 'in-run-only' | 'unavailable';
    reasons: {
        cleanup: AssignmentRecoveryReason | null;
        scanRecovery: AssignmentRecoveryReason | null;
        orphanPlanning: AssignmentRecoveryReason | null;
    };
    /** True when at least one pass can do real work. */
    ready: boolean;
    /**
     * Always false, on purpose. Configuration readiness is not operational
     * verification; a truthful `true` would require evidence this module does
     * not collect (a real schema read, a real delete, a real scan).
     */
    verified: false;
}

/* ------------------------------------------------------------------------- */
/* Run report                                                                */
/* ------------------------------------------------------------------------- */

export type AssignmentRecoveryHaltReason =
    /** `stop()` was called before or between passes. */
    | 'stopped'
    /** A run was already in flight; nothing was started. */
    | 'already_running'
    /** Neither pass is configured: the run did nothing, and says so. */
    | 'unconfigured'
    /** Neither pass is usable because an injected adapter declared itself unavailable. */
    | 'unavailable'
    /** The overall budget was exhausted before the second pass. */
    | 'budget_exhausted';

export interface AssignmentRecoveryRunReport {
    halted: AssignmentRecoveryHaltReason | null;
    /** `null` when the cleanup pass did not run (unconfigured or skipped). */
    cleanup: AssignmentCleanupRunReport | null;
    /** `null` when the scan pass did not run (unconfigured or skipped). */
    scan: AssignmentScanRunResult | null;
    elapsedMs: number;
    readiness: AssignmentRecoveryReadiness;
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

export interface AssignmentRecoveryBounds {
    /** Cleanup obligations claimed per page (clamped 1–50). */
    cleanupPageSize?: number;
    /** Cleanup pages per run (clamped 1–20). */
    cleanupMaxPages?: number;
    /** Cleanup obligations inspected per run (clamped 1–200). */
    cleanupMaxItems?: number;
    /** Cleanup wall-clock budget (clamped 1 ms–30 s). */
    cleanupRunBudgetMs?: number;
    /** Cleanup claim lease (clamped 5 s–5 min). */
    cleanupLeaseMs?: number;
    /** Rows claimed per scan pass (clamped 1–50). */
    scanBatchSize?: number;
    /** Parallel scans (clamped 1–8). */
    scanConcurrency?: number;
    /** Scan attempts per row inside one pass (clamped 1–5). */
    scanAttemptsPerRow?: number;
    /** One scan's wall-clock bound (clamped 1–120 s). */
    scanTimeoutMs?: number;
    /** Durable scan claim lease (clamped 5 s–10 min). */
    scanLeaseMs?: number;
    /** Total budget for one `runOnce` across both passes (clamped 1 ms–5 min). */
    totalBudgetMs?: number;
}

export const DEFAULT_RECOVERY_TOTAL_BUDGET_MS = 120_000;
export const MAX_RECOVERY_TOTAL_BUDGET_MS = 300_000;

export interface AssignmentRecoveryFactoryOptions {
    /** Required for any object identity check; absent ⇒ cleanup and scan are unconfigured. */
    objectStore?: AssignmentObjectStore;
    /** Durable obligation store. Absent ⇒ `cleanup-store-unconfigured`. */
    cleanupStore?: AssignmentCleanupObligationStore;
    /** Row store for the scan pass. Absent ⇒ `scan-store-unconfigured`. */
    scanStore?: AssignmentScanStore;
    /** Verified scanner. Absent ⇒ `scanner-unconfigured` (uploaded is never clean). */
    scanner?: MalwareScanner;
    /** Tenant-scoped listing for orphan *planning* only. */
    listing?: AssignmentObjectListing;
    /** Row lookup used by orphan planning. */
    submissionLookup?: AssignmentSubmissionLookup;
    now?: () => Date;
    /** Injected for determinism; defaults to a fresh UUID per pass. */
    newOwnerId?: () => string;
    bounds?: AssignmentRecoveryBounds;
    /** Observability hook. Must never alter an outcome. */
    onError?: (error: unknown) => void;
}

export interface AssignmentRecoveryRuntime {
    /** Declared capability + reasons. Safe to call at any time; no I/O. */
    describeReadiness(): AssignmentRecoveryReadiness;
    /** One bounded pass over both configured recovery paths. Never schedules itself. */
    runOnce(): Promise<AssignmentRecoveryRunReport>;
    /** Cooperative stop: no new pass or cleanup item starts; in-flight work finishes. */
    stop(): void;
    /** Wait for the in-flight run (if any) and return its report; starts nothing. */
    drain(): Promise<AssignmentRecoveryRunReport | null>;
}

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};

/**
 * Compose the recovery runtime. Construction is inert: no port is called, no
 * timer is opened, nothing is claimed.
 */
export const createAssignmentRecoveryRuntime = (
    options: AssignmentRecoveryFactoryOptions,
): AssignmentRecoveryRuntime => {
    const now = options.now ?? ((): Date => new Date());
    const bounds = options.bounds ?? {};
    const totalBudgetMs = clampInt(
        bounds.totalBudgetMs,
        DEFAULT_RECOVERY_TOTAL_BUDGET_MS,
        1,
        MAX_RECOVERY_TOTAL_BUDGET_MS,
    );

    const cleanupRecovery = createAssignmentCleanupRecovery({
        store: options.cleanupStore,
        objectStore: options.objectStore,
        now,
        newOwnerId: options.newOwnerId,
        pageSize: bounds.cleanupPageSize,
        maxPages: bounds.cleanupMaxPages,
        maxItems: bounds.cleanupMaxItems,
        runBudgetMs: bounds.cleanupRunBudgetMs,
        leaseMs: bounds.cleanupLeaseMs,
        onError: options.onError,
    });

    /**
     * Cooperative stop flag shared with the scan pass.
     *
     * Declared before the worker is constructed so it can be handed to it: the
     * scan worker has no stop surface of its own — it exposes only
     * `runOnce()` — so `stop()` used to halt the cleanup pass while the scan
     * pass kept claiming batches and running concurrent scans to completion,
     * and the run then reported `halted: null` as if it had finished cleanly.
     */
    const scanStop = { stopped: false };

    const scanWorker = options.scanStore && options.objectStore
        ? createAssignmentScanWorker({
            store: options.scanStore,
            objectStore: options.objectStore,
            scanner: options.scanner,
            now,
            newOwnerId: options.newOwnerId,
            batchSize: bounds.scanBatchSize,
            concurrency: bounds.scanConcurrency,
            maxAttemptsPerRow: bounds.scanAttemptsPerRow,
            scanTimeoutMs: bounds.scanTimeoutMs,
            leaseMs: bounds.scanLeaseMs,
            onError: options.onError,
            shouldContinue: () => !scanStop.stopped,
        })
        : null;

    let running = false;
    let stopped = false;
    let inFlight: Promise<AssignmentRecoveryRunReport> | null = null;

    /**
     * Existence is not readiness.
     *
     * Every injected surface is checked for the CALLABLE it must actually
     * provide, not merely for being present. A truthy object with the wrong
     * shape used to be reported as `configured`, which is fabricated readiness:
     * the runtime then failed closed per row at best, or reported a discipline
     * (`fenced`) for a pass that could never run. These predicates mirror the
     * downstream capability contracts, so a stub cannot satisfy them by shape
     * alone.
     */
    const hasCallable = (value: unknown, method: string): boolean =>
        typeof value === 'object' && value !== null
        && typeof (value as Record<string, unknown>)[method] === 'function';

    const scannerConfigured = hasCallable(options.scanner, 'scan');
    const scanStoreConfigured = hasCallable(options.scanStore, 'listPendingScanBatch')
        && hasCallable(options.scanStore, 'recordScanVerdict');
    const claimsCapable = hasCallable(options.scanStore?.claims, 'claimBatch');
    const listingConfigured = hasCallable(options.listing, 'list');
    const lookupConfigured = hasCallable(options.submissionLookup, 'find');

    const readiness = (): AssignmentRecoveryReadiness => {
        const capability = cleanupRecovery.describeCapability();
        const durableCleanupStore = capability.durableStore;
        const exactVersionDelete = options.objectStore ? capability.exactVersionDelete : 'unknown';
        const scanner: 'configured' | 'unconfigured' = scannerConfigured ? 'configured' : 'unconfigured';
        const scanStore: 'configured' | 'unconfigured' = scanStoreConfigured ? 'configured' : 'unconfigured';
        const hasObjectStore = options.objectStore !== undefined;
        const cleanupUnavailable = options.cleanupStore?.availability?.mode === 'unavailable';
        const scanUnavailable = options.scanStore?.availability?.mode === 'unavailable';

        const cleanupReason: AssignmentRecoveryReason | null = !hasObjectStore
            ? 'object-store-unconfigured'
            : cleanupUnavailable
                ? 'cleanup-store-unavailable'
                : durableCleanupStore === 'unconfigured'
                    ? 'cleanup-store-unconfigured'
                    : (exactVersionDelete === 'supported' ? null : 'exact-delete-unsupported');
        // A scan pass without an object store cannot prove which version it is
        // scanning, so it is not "configured" no matter what else is injected.
        const scanReason: AssignmentRecoveryReason | null = !hasObjectStore
            ? 'object-store-unconfigured'
            : scanUnavailable
                ? 'scan-store-unavailable'
                : scanStore === 'unconfigured'
                    ? 'scan-store-unconfigured'
                    : (scanner === 'configured' ? null : 'scanner-unconfigured');
        const orphanReason: AssignmentRecoveryReason | null = listingConfigured
            ? (lookupConfigured ? null : 'orphan-lookup-unconfigured')
            : 'orphan-listing-unconfigured';

        return {
            cleanup: cleanupReason === null ? 'configured' : 'unconfigured',
            scanRecovery: scanReason === null ? 'configured' : 'unconfigured',
            orphanPlanning: orphanReason === null ? 'configured' : 'unconfigured',
            durableCleanupStore,
            exactVersionDelete,
            scanner,
            // Mirrors the worker's own rule: a lease the verdict write does not
            // enforce is not fencing, so it is never reported as `fenced`; and a
            // store that refused the durable mode is reported as `unavailable`
            // rather than as the reference fallback.
            //
            // `unavailable` also covers "no scan pass can run at all": with no
            // object store or no scan store there is nothing that could take a
            // claim, so reporting `in-run-only` there described a discipline no
            // pass was following.
            scanClaimFencing: scanUnavailable || scanStore === 'unconfigured' || !hasObjectStore
                ? 'unavailable'
                : claimsCapable
                    && options.scanStore?.capabilities?.fencedVerdictWrite === true
                    ? 'fenced'
                    : 'in-run-only',
            reasons: { cleanup: cleanupReason, scanRecovery: scanReason, orphanPlanning: orphanReason },
            ready: cleanupReason === null || scanReason === null,
            verified: false,
        };
    };

    /**
     * Cooperative stop flag shared with the scan pass.
     *
     * The scan worker has no stop surface of its own — it exposes only
     * `runOnce()` — so `stop()` used to halt the cleanup pass while the scan
     * pass kept claiming batches and running concurrent scans to completion,
     * and the run then reported `halted: null` as if it had finished cleanly.
     * The flag is read by the worker before each batch claim and between
     * batches, so a mid-run stop is both honoured and visible.
     */
    const scanStop = { stopped: false };

    const execute = async (): Promise<AssignmentRecoveryRunReport> => {
        const startedAtMs = now().getTime();
        const current = readiness();
        if (stopped) {
            return { halted: 'stopped', cleanup: null, scan: null, elapsedMs: 0, readiness: current };
        }
        if (!current.ready) {
            // Distinguish "nothing was injected" from "what was injected refused
            // to run": the second is a configuration error an operator must see.
            const anyUnavailable = options.cleanupStore?.availability?.mode === 'unavailable'
                || options.scanStore?.availability?.mode === 'unavailable';
            return {
                halted: anyUnavailable ? 'unavailable' : 'unconfigured',
                cleanup: null,
                scan: null,
                elapsedMs: 0,
                readiness: current,
            };
        }

        let cleanupReport: AssignmentCleanupRunReport | null = null;
        let scanReport: AssignmentScanRunResult | null = null;
        let halted: AssignmentRecoveryHaltReason | null = null;

        // Every child pass is awaited inside this guard, so a rejection is
        // observed here rather than escaping `runOnce()`/`drain()` as an
        // unhandled rejection when the owner calls `runOnce()` without awaiting
        // (the documented usage). The original error is re-thrown after the
        // in-flight bookkeeping is settled, so the caller still sees it.
        try {
            if (current.cleanup === 'configured') {
                cleanupReport = await cleanupRecovery.runOnce();
            }
            if (stopped) {
                halted = 'stopped';
            } else if (current.scanRecovery === 'configured' && scanWorker) {
                if (now().getTime() - startedAtMs >= totalBudgetMs) {
                    // The cleanup pass consumed the whole window; the scan pass is
                    // not started half-way, because a scan is not interruptible.
                    halted = 'budget_exhausted';
                } else {
                    scanReport = await scanWorker.runOnce();
                }
            }
        } catch (error) {
            // A child rejection is a failure of the run, not of the runtime's
            // bookkeeping: `running`/`inFlight` are cleared by the caller's
            // `finally`, and the error reaches the owner unchanged.
            throw error;
        }

        // A stop that arrived while the scan pass was in flight must be visible:
        // `halted: null` used to be reported for a run that was cut short.
        if (halted === null && stopped && scanReport !== null && scanReport.aborted !== 'stopped') {
            halted = 'stopped';
        }

        return {
            halted,
            cleanup: cleanupReport,
            scan: scanReport,
            elapsedMs: now().getTime() - startedAtMs,
            readiness: readiness(),
        };
    };

    const runOnce = async (): Promise<AssignmentRecoveryRunReport> => {
        if (running) {
            return {
                halted: 'already_running',
                cleanup: null,
                scan: null,
                elapsedMs: 0,
                readiness: readiness(),
            };
        }
        running = true;
        const promise = execute().finally(() => {
            running = false;
            inFlight = null;
        });
        inFlight = promise;
        return promise;
    };

    return {
        describeReadiness: readiness,
        runOnce,
        stop: (): void => {
            stopped = true;
            scanStop.stopped = true;
            cleanupRecovery.stop();
        },
        drain: async (): Promise<AssignmentRecoveryRunReport | null> => inFlight,
    };
};
