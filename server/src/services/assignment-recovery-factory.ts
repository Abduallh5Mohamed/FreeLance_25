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

import {
    createAssignmentCleanupRecovery,
    DEFAULT_CLEANUP_RUN_BUDGET_MS,
    MAX_CLEANUP_RUN_BUDGET_MS,
} from './assignment-cleanup-recovery';
import type {
    AssignmentCleanupHaltReason,
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
    /**
     * `stop()` was called **and a configured pass was therefore prevented from
     * starting or cut short**: before the run, between the passes, or inside the
     * scan pass (which reads the flag before its claim and between batches).
     * A stop that lands after every configured pass has already finished is not
     * reported — nothing was cut short, and naming it would describe a halt that
     * did not happen.
     */
    | 'stopped'
    /** A run was already in flight; nothing was started. */
    | 'already_running'
    /** Neither pass is configured: the run did nothing, and says so. */
    | 'unconfigured'
    /** Neither pass is usable because an injected adapter declared itself unavailable. */
    | 'unavailable'
    /**
     * The run's total budget ran out: the scan pass was not started, or the scan
     * pass was refused before it claimed/scanned because the window was already
     * gone. Distinct from a pass reaching its own page/item/elapsed cap, which is
     * a bounded completion with a resumable `continuation` — not a halt.
     */
    | 'budget_exhausted'
    /**
     * The cleanup pass was configured and halted for a reason of its own: an
     * unavailable store, a failed claim, a corrupt row, a lost fence. Work may
     * remain and the run did not complete; `cleanup.halted` names the exact
     * cause. This member exists because the alternative — `halted: null` beside
     * a child `halted: 'claim_store_failed'` — reported an unknown outcome as a
     * clean run to any supervisor that reads only `halted`.
     */
    | 'cleanup_halted'
    /**
     * The scan pass was configured and aborted for a reason of its own: a failed
     * claim, a corrupt row, an unavailable store. `scan.aborted` names the exact
     * cause.
     */
    | 'scan_halted';

export interface AssignmentRecoveryRunReport {
    /**
     * Why the run ended early, or `null` when every configured pass either
     * completed or reached its own configured bound (that bounded pass reports
     * its own `halted` and `continuation` in its own report). `null` therefore
     * never conceals a pass that failed: those report `cleanup_halted` /
     * `scan_halted`, and a stop that actually cut something short reports
     * `stopped`.
     */
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
    /**
     * Cleanup wall-clock budget (clamped 1 ms–30 s), additionally capped by
     * `totalBudgetMs`: the first pass may not spend a window the run does not
     * have.
     */
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
    /**
     * Total budget for one `runOnce` across both passes (clamped 1 ms–5 min).
     * Enforced on the cleanup pass (via its run budget), on whether the scan
     * pass starts, and inside the scan pass (its cooperative predicate refuses
     * the batch it is about to scan once the window is gone).
     */
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
    /**
     * Injected for determinism. Each pass resolves its claim owner **once, at
     * construction** (default: a fresh UUID), so every `runOnce()` of one runtime
     * reuses that owner; the per-row claim version — not the owner — is what
     * fences a replayed claim.
     */
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
    /**
     * Cooperative stop, honoured by BOTH passes: no new cleanup page or item and
     * no new scan claim or batch starts. In-flight work finishes — a delete or a
     * scan already running cannot be un-run.
     */
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

    /**
     * The cleanup pass may not outlive the run's total budget.
     *
     * `totalBudgetMs` is documented as the budget "across both passes", but the
     * cleanup pass only ever saw its own `cleanupRunBudgetMs` (default 5 s,
     * ceiling 30 s). With `totalBudgetMs` below that, the *first* pass alone ran
     * past the declared window and the window was then checked only before the
     * second pass — a bound the run had already broken. The configured value is
     * clamped exactly as the coordinator clamps it, then capped by the total.
     */
    const cleanupRunBudgetMs = Math.min(
        clampInt(
            bounds.cleanupRunBudgetMs,
            DEFAULT_CLEANUP_RUN_BUDGET_MS,
            1,
            MAX_CLEANUP_RUN_BUDGET_MS,
        ),
        totalBudgetMs,
    );

    const cleanupRecovery = createAssignmentCleanupRecovery({
        store: options.cleanupStore,
        objectStore: options.objectStore,
        now,
        newOwnerId: options.newOwnerId,
        pageSize: bounds.cleanupPageSize,
        maxPages: bounds.cleanupMaxPages,
        maxItems: bounds.cleanupMaxItems,
        runBudgetMs: cleanupRunBudgetMs,
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

    /**
     * The scan pass's share of the total budget.
     *
     * `totalBudgetMs` used to bound only the *start* of the second pass, so a run
     * with a 1 ms total budget still spent a full scan window inside it (one
     * batch of up to `scanBatchSize` objects, each bounded only by
     * `scanTimeoutMs`, i.e. up to 120 s per wave): the declared bound was
     * enforced once and then ignored for the rest of the run. The deadline is set
     * per run and read by the same predicate as the stop flag, so the scan pass
     * refuses the batch it is about to scan instead of running past the window.
     *
     * `scanBudgetRefused` records *why* the predicate answered `false`. The
     * worker reports `aborted: 'stopped'` for any refusal (it cannot see which
     * predicate fired), so without this the runtime would report `stopped` for a
     * budget stop — one cause's reason returned for another.
     */
    let scanBudgetDeadlineMs: number | null = null;
    let scanBudgetRefused = false;

    const scanShouldContinue = (): boolean => {
        if (scanStop.stopped) return false;
        if (scanBudgetDeadlineMs !== null && now().getTime() >= scanBudgetDeadlineMs) {
            scanBudgetRefused = true;
            return false;
        }
        return true;
    };

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
            shouldContinue: scanShouldContinue,
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
     *
     * The names are the ones on the port types, not abbreviations: the listing
     * and lookup used to be probed under `list`/`find`, which no port declares,
     * so a correct implementation was reported `unconfigured`; and the cleanup
     * store and the object store were not probed at all, so `{}` read as
     * `configured` and the pass then died on a missing method.
     */
    const hasCallable = (value: unknown, method: string): boolean =>
        typeof value === 'object' && value !== null
        && typeof (value as Record<string, unknown>)[method] === 'function';

    const objectStoreConfigured = hasCallable(options.objectStore, 'statObject');
    const cleanupStoreConfigured = hasCallable(options.cleanupStore, 'recordPending')
        && hasCallable(options.cleanupStore, 'claimBatch')
        && hasCallable(options.cleanupStore, 'completeClaim')
        && hasCallable(options.cleanupStore, 'releaseClaim')
        && hasCallable(options.cleanupStore, 'completeUnclaimed');
    const scannerConfigured = hasCallable(options.scanner, 'scan');
    const scanStoreConfigured = hasCallable(options.scanStore, 'listPendingScanBatch')
        && hasCallable(options.scanStore, 'recordScanVerdict');
    // `AssignmentScanClaimStore` is a pair. Probing only `claimBatch` reported
    // `fenced` for a claims object that could take a lease but never hand one
    // back: the worker calls `releaseClaim` on every row that stays pending and
    // on every claim it refuses mid-batch, so a missing release is a lease held
    // until expiry and an under-reported `claimsReleased`, not a fenced run.
    const claimsCapable = hasCallable(options.scanStore?.claims, 'claimBatch')
        && hasCallable(options.scanStore?.claims, 'releaseClaim');
    const listingConfigured = hasCallable(options.listing, 'listTenantObjects');
    const lookupConfigured = hasCallable(options.submissionLookup, 'hasSubmissionForVersion');

    const readiness = (): AssignmentRecoveryReadiness => {
        const capability = cleanupRecovery.describeCapability();
        const durableCleanupStore = cleanupStoreConfigured ? 'configured' : 'unconfigured';
        const exactVersionDelete = objectStoreConfigured ? capability.exactVersionDelete : 'unknown';
        const scanner: 'configured' | 'unconfigured' = scannerConfigured ? 'configured' : 'unconfigured';
        const scanStore: 'configured' | 'unconfigured' = scanStoreConfigured ? 'configured' : 'unconfigured';
        const cleanupUnavailable = options.cleanupStore?.availability?.mode === 'unavailable';
        const scanUnavailable = options.scanStore?.availability?.mode === 'unavailable';

        const cleanupReason: AssignmentRecoveryReason | null = !objectStoreConfigured
            ? 'object-store-unconfigured'
            : cleanupUnavailable
                ? 'cleanup-store-unavailable'
                : durableCleanupStore === 'unconfigured'
                    ? 'cleanup-store-unconfigured'
                    : (exactVersionDelete === 'supported' ? null : 'exact-delete-unsupported');
        // A scan pass without an object store cannot prove which version it is
        // scanning, so it is not "configured" no matter what else is injected.
        const scanReason: AssignmentRecoveryReason | null = !objectStoreConfigured
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
            scanClaimFencing: scanUnavailable || scanStore === 'unconfigured' || !objectStoreConfigured
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
     * A cleanup halt that is neither "drained" (`null`) nor the pass reaching its
     * own configured page/item/elapsed bound (`budget_exhausted`, resumable from
     * `continuation`). Everything else — an unavailable store, a failed claim, a
     * corrupt row, a lost fence — means the pass could not do its work, so the
     * run is not a completed run.
     */
    const cleanupCompletedOrBounded = (reason: AssignmentCleanupHaltReason | null): boolean =>
        reason === null || reason === 'stopped' || reason === 'budget_exhausted';

    const execute = async (): Promise<AssignmentRecoveryRunReport> => {
        const startedAtMs = now().getTime();
        // Per run: a refusal recorded by the previous run must not colour this one.
        scanBudgetRefused = false;
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

        // Every child pass is awaited inside this guard, so its rejection is
        // observed here and re-thrown unchanged: the caller of `runOnce()` /
        // `drain()` sees the ORIGINAL error, and the `finally` in `runOnce` that
        // clears `running`/`inFlight` cannot replace it. This guard does not
        // swallow the error and does not make the returned promise safe to
        // ignore — an owner that neither awaits nor handles it still gets an
        // unhandled rejection, which is the owner's decision, not a silent
        // success manufactured here.
        try {
            if (current.cleanup === 'configured') {
                cleanupReport = await cleanupRecovery.runOnce();
            }
            if (stopped) {
                // A stop between the passes halts the run only when it actually
                // prevented something. With no scan pass configured the cleanup
                // pass was the whole run, so naming `stopped` there described a
                // cut that never happened.
                if (current.scanRecovery === 'configured'
                    || (cleanupReport !== null && cleanupReport.halted === 'stopped')) {
                    halted = 'stopped';
                }
            } else if (current.scanRecovery === 'configured' && scanWorker) {
                if (now().getTime() - startedAtMs >= totalBudgetMs) {
                    // The cleanup pass consumed the whole window; the scan pass is
                    // not started half-way, because a scan is not interruptible.
                    halted = 'budget_exhausted';
                } else {
                    scanBudgetDeadlineMs = startedAtMs + totalBudgetMs;
                    try {
                        scanReport = await scanWorker.runOnce();
                    } finally {
                        // Cleared even when the pass throws: a stale deadline
                        // would bound the NEXT run by this run's window.
                        scanBudgetDeadlineMs = null;
                    }
                }
            }
        } catch (error) {
            // A child rejection is a failure of the run, not of the runtime's
            // bookkeeping: `running`/`inFlight` are cleared by the caller's
            // `finally`, and the error reaches the owner unchanged.
            throw error;
        }

        // A configured pass that halted for a reason of its own is NOT a
        // completed run. `halted: null` used to be returned next to a child
        // `halted: 'claim_store_failed'`, so a supervisor that reads `halted`
        // recorded a clean run whose cleanup store had failed after claiming a
        // page. The child report keeps the exact cause; `halted` names the pass.
        //
        // A child failure outranks a stop that arrived later (the failure is why
        // the work could not be done), and outranks `budget_exhausted` (which
        // only says the scan was not started).
        if (cleanupReport !== null && !cleanupCompletedOrBounded(cleanupReport.halted)) {
            halted = 'cleanup_halted';
        } else if (scanReport !== null && scanReport.aborted !== null && scanReport.aborted !== 'stopped') {
            halted = 'scan_halted';
        } else if (halted === null && scanReport !== null && scanReport.aborted === 'stopped') {
            // The scan pass honoured a refusal. The worker reports
            // `aborted: 'stopped'` for both causes it can see, so the cause is
            // named from the predicate that actually refused: a budget deadline
            // is not a stop, and a stop is not a budget.
            halted = scanBudgetRefused ? 'budget_exhausted' : 'stopped';
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
