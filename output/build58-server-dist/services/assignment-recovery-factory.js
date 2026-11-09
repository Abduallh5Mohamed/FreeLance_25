"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAssignmentRecoveryRuntime = exports.MAX_RECOVERY_TOTAL_BUDGET_MS = exports.DEFAULT_RECOVERY_TOTAL_BUDGET_MS = void 0;
const assignment_cleanup_recovery_1 = require("./assignment-cleanup-recovery");
const assignment_scan_worker_1 = require("./assignment-scan-worker");
exports.DEFAULT_RECOVERY_TOTAL_BUDGET_MS = 120000;
exports.MAX_RECOVERY_TOTAL_BUDGET_MS = 300000;
const clampInt = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};
/**
 * Compose the recovery runtime. Construction is inert: no port is called, no
 * timer is opened, nothing is claimed.
 */
const createAssignmentRecoveryRuntime = (options) => {
    const now = options.now ?? (() => new Date());
    const bounds = options.bounds ?? {};
    const totalBudgetMs = clampInt(bounds.totalBudgetMs, exports.DEFAULT_RECOVERY_TOTAL_BUDGET_MS, 1, exports.MAX_RECOVERY_TOTAL_BUDGET_MS);
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
    const cleanupRunBudgetMs = Math.min(clampInt(bounds.cleanupRunBudgetMs, assignment_cleanup_recovery_1.DEFAULT_CLEANUP_RUN_BUDGET_MS, 1, assignment_cleanup_recovery_1.MAX_CLEANUP_RUN_BUDGET_MS), totalBudgetMs);
    const cleanupRecovery = (0, assignment_cleanup_recovery_1.createAssignmentCleanupRecovery)({
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
    let scanBudgetDeadlineMs = null;
    let scanBudgetRefused = false;
    const scanShouldContinue = () => {
        if (scanStop.stopped)
            return false;
        if (scanBudgetDeadlineMs !== null && now().getTime() >= scanBudgetDeadlineMs) {
            scanBudgetRefused = true;
            return false;
        }
        return true;
    };
    const scanWorker = options.scanStore && options.objectStore
        ? (0, assignment_scan_worker_1.createAssignmentScanWorker)({
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
    let inFlight = null;
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
    const hasCallable = (value, method) => typeof value === 'object' && value !== null
        && typeof value[method] === 'function';
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
    const readiness = () => {
        const capability = cleanupRecovery.describeCapability();
        const durableCleanupStore = cleanupStoreConfigured ? 'configured' : 'unconfigured';
        const exactVersionDelete = objectStoreConfigured ? capability.exactVersionDelete : 'unknown';
        const scanner = scannerConfigured ? 'configured' : 'unconfigured';
        const scanStore = scanStoreConfigured ? 'configured' : 'unconfigured';
        const cleanupUnavailable = options.cleanupStore?.availability?.mode === 'unavailable';
        const scanUnavailable = options.scanStore?.availability?.mode === 'unavailable';
        const cleanupReason = !objectStoreConfigured
            ? 'object-store-unconfigured'
            : cleanupUnavailable
                ? 'cleanup-store-unavailable'
                : durableCleanupStore === 'unconfigured'
                    ? 'cleanup-store-unconfigured'
                    : (exactVersionDelete === 'supported' ? null : 'exact-delete-unsupported');
        // A scan pass without an object store cannot prove which version it is
        // scanning, so it is not "configured" no matter what else is injected.
        const scanReason = !objectStoreConfigured
            ? 'object-store-unconfigured'
            : scanUnavailable
                ? 'scan-store-unavailable'
                : scanStore === 'unconfigured'
                    ? 'scan-store-unconfigured'
                    : (scanner === 'configured' ? null : 'scanner-unconfigured');
        const orphanReason = listingConfigured
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
    const cleanupCompletedOrBounded = (reason) => reason === null || reason === 'stopped' || reason === 'budget_exhausted';
    const execute = async () => {
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
        let cleanupReport = null;
        let scanReport = null;
        let halted = null;
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
            }
            else if (current.scanRecovery === 'configured' && scanWorker) {
                if (now().getTime() - startedAtMs >= totalBudgetMs) {
                    // The cleanup pass consumed the whole window; the scan pass is
                    // not started half-way, because a scan is not interruptible.
                    halted = 'budget_exhausted';
                }
                else {
                    scanBudgetDeadlineMs = startedAtMs + totalBudgetMs;
                    try {
                        scanReport = await scanWorker.runOnce();
                    }
                    finally {
                        // Cleared even when the pass throws: a stale deadline
                        // would bound the NEXT run by this run's window.
                        scanBudgetDeadlineMs = null;
                    }
                }
            }
        }
        catch (error) {
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
        }
        else if (scanReport !== null && scanReport.aborted !== null && scanReport.aborted !== 'stopped') {
            halted = 'scan_halted';
        }
        else if (halted === null && scanReport !== null && scanReport.aborted === 'stopped') {
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
    const runOnce = async () => {
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
        stop: () => {
            stopped = true;
            scanStop.stopped = true;
            cleanupRecovery.stop();
        },
        drain: async () => inFlight,
    };
};
exports.createAssignmentRecoveryRuntime = createAssignmentRecoveryRuntime;
