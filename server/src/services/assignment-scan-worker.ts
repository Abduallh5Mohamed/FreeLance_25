/**
 * Bounded, explicitly-driven scan worker for `pending_scan` assignment uploads.
 *
 * The worker closes the gap left by the request-scoped finalize path: a
 * submission whose object was verified but not yet given a trusted verdict sits
 * at `pending_scan` forever unless something scans it out of band. This module
 * is that "something", and it is deliberately *not* self-starting:
 *
 *  - constructing a worker performs no I/O, opens no timer and touches no
 *    store; the process owner (scheduler / startup wiring, outside this scope)
 *    must call `runOnce()` explicitly;
 *  - importing this module has no side effect and starts nothing.
 *
 * Fail-closed rules (the whole point of the worker):
 *
 *  - no scanner ⇒ `aborted: 'scanner_absent'`; nothing is claimed and nothing
 *    becomes clean. Absence of a scanner is never a verdict;
 *  - a scanner error, a thrown adapter, or a wall-clock timeout is *not*
 *    `infected` and *not* `clean`: the row is left untouched and retryable;
 *  - an unconfirmed verdict is retried only within a configured, bounded
 *    attempt cap — never in a random/endless loop, and never softened into a
 *    verdict it did not produce;
 *  - the verdict is bound to the object version the worker stat'ed: the object
 *    is re-stat'ed after the scan and a changed ETag/size discards the verdict
 *    (a verdict for one version must never authorize another);
 *  - the row facts (tenant/assignment/enrollment/submission/extension) are
 *    re-derived from the persisted `storage_key` and must match the row; a
 *    forged or foreign key is never stat'ed;
 *  - an `infected` verdict quarantines the row, and the cleanup destroys
 *    **exactly the version that was scanned** — never "whatever is at the key
 *    now". A mutable-key delete would destroy a concurrent re-upload that no
 *    scanner ever looked at. The delete is therefore gated on a declared
 *    exact-version capability (§`removeScannedObjectVersion`); when the adapter
 *    cannot prove the precondition, nothing is deleted, the row stays
 *    non-readable, and the run reports the cleanup as pending. A lost verdict
 *    write never disables that quarantine, and never downgrades it to a clean
 *    state.
 *
 * Persistence uses **existing columns only** (`scan_status`, `file_size_bytes`,
 * `status`). The claim/write are compare-and-set operations on those columns;
 * no column is invented and no DDL is performed here. Because the schema has
 * no attempt/lease columns, the attempt cap and the claim batch are enforced in
 * memory for one run — see `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` §9 for
 * the exact I2 request that would make exhaustion durable across runs.
 *
 * No `any`, no ts-ignore, no network at import, no timer at construction.
 */

import {
    boundObjectVersion,
    parseSubmissionStorageKey,
    removeScannedObjectVersion,
    runBoundedScan,
    scanTimeoutMs as resolveScanTimeoutMs,
    verifySubmissionStorageKey,
} from './assignment-storage';
import type {
    AssignmentObjectMetadata,
    AssignmentObjectStore,
    MalwareScanner,
    MalwareScanVerdict,
    QuarantineCleanup,
} from './assignment-storage';

/* ------------------------------------------------------------------------- */
/* Bounds                                                                    */
/* ------------------------------------------------------------------------- */

/** Rows claimed per run when no batch size is configured. */
export const DEFAULT_SCAN_BATCH_SIZE = 10;
/** Hard ceiling on one claim; an over-large configuration is clamped, never honoured. */
export const MAX_SCAN_BATCH_SIZE = 50;
/** Objects scanned in parallel when no concurrency is configured. */
export const DEFAULT_SCAN_CONCURRENCY = 2;
/** Hard ceiling on parallel scans inside one run. */
export const MAX_SCAN_CONCURRENCY = 8;

/** Claim-store attempts per run (the claim is the only retried store call). */
export const DEFAULT_CLAIM_ATTEMPTS = 3;
export const MAX_CLAIM_ATTEMPTS = 5;
/** Base delay for the deterministic (exponential) claim backoff. */
export const DEFAULT_CLAIM_RETRY_DELAY_MS = 250;
export const MAX_CLAIM_RETRY_DELAY_MS = 5_000;

/**
 * Scan attempts per row inside one run. Default `1`: an unconfirmed verdict is
 * not retried unless the deployment explicitly opts in, so a broken scanner is
 * never hammered.
 */
export const DEFAULT_ATTEMPTS_PER_ROW = 1;
export const MAX_ATTEMPTS_PER_ROW = 5;
/** Base delay for the deterministic row retry backoff. */
export const DEFAULT_ROW_RETRY_DELAY_MS = 250;
export const MAX_ROW_RETRY_DELAY_MS = 5_000;

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};

/** Clamp a configured batch size into `[1, MAX_SCAN_BATCH_SIZE]`. */
export const clampScanBatchSize = (configured?: number): number =>
    clampInt(configured, DEFAULT_SCAN_BATCH_SIZE, 1, MAX_SCAN_BATCH_SIZE);

/** Clamp a configured concurrency into `[1, MAX_SCAN_CONCURRENCY]`. */
export const clampScanConcurrency = (configured?: number): number =>
    clampInt(configured, DEFAULT_SCAN_CONCURRENCY, 1, MAX_SCAN_CONCURRENCY);

const clampClaimAttempts = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLAIM_ATTEMPTS, 1, MAX_CLAIM_ATTEMPTS);

const clampAttemptsPerRow = (configured?: number): number =>
    clampInt(configured, DEFAULT_ATTEMPTS_PER_ROW, 1, MAX_ATTEMPTS_PER_ROW);

const clampClaimRetryDelay = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLAIM_RETRY_DELAY_MS, 0, MAX_CLAIM_RETRY_DELAY_MS);

const clampRowRetryDelay = (configured?: number): number =>
    clampInt(configured, DEFAULT_ROW_RETRY_DELAY_MS, 0, MAX_ROW_RETRY_DELAY_MS);

/* ------------------------------------------------------------------------- */
/* Store contract                                                            */
/* ------------------------------------------------------------------------- */

/** One `pending_scan` row, projected to the facts the worker is allowed to use. */
export interface PendingScanCandidate {
    submissionId: string;
    tenantId: string;
    assignmentId: string;
    enrollmentId: string;
    /** Private, server-generated object key; re-verified before any stat. */
    storageKey: string;
    /** Size persisted by the verifying finalize; the scanned object must match it. */
    fileSizeBytes: number;
}

/**
 * The compare-and-set verdict write. `expectedSizeBytes` is the size of the
 * version that was actually scanned: the write only lands on a row that is
 * still `pending` for that exact size.
 */
export interface ScanVerdictWrite {
    submissionId: string;
    tenantId: string;
    assignmentId: string;
    enrollmentId: string;
    expectedSizeBytes: number;
    scanStatus: 'clean' | 'infected';
}

/**
 * The persistence seam the worker depends on. Both methods are bounded and
 * idempotent by construction: the claim is limited, and the write is a CAS
 * whose `false` answer means "another writer owns this row now".
 */
export interface AssignmentScanStore {
    listPendingScanBatch(input: { limit: number }): Promise<PendingScanCandidate[]>;
    recordScanVerdict(write: ScanVerdictWrite): Promise<boolean>;
}

/* ------------------------------------------------------------------------- */
/* Result contract                                                           */
/* ------------------------------------------------------------------------- */

export type ScanOutcomeCode =
    /** A clean verdict was recorded for the verified object version. */
    | 'clean'
    /**
     * An infected verdict was recorded and the scanned version is provably gone
     * from the key (`removed`, `already_absent`, or the key now holds a
     * different version).
     */
    | 'quarantined'
    /**
     * An infected verdict was recorded — the row is not readable — but the
     * scanned bytes could not be provably destroyed: the adapter cannot delete
     * by exact version, or the delete failed. Version-exact cleanup is pending.
     */
    | 'quarantined_cleanup_pending'
    /** No confirmed verdict (error/timeout/failed). The row stays pending. */
    | 'scan_failed'
    /** The object metadata could not be read. The row stays pending. */
    | 'storage_error'
    /** The object at the key is not the version the row describes. */
    | 'object_changed'
    /** The adapter cannot express a version (no ETag/size); never scanned. */
    | 'unbound_object_version'
    /** The stored key does not match the row facts; never touched. */
    | 'binding_mismatch'
    /** Nothing exists at the key. */
    | 'object_missing'
    /** A verdict existed but the CAS lost; nothing was recorded. */
    | 'verdict_not_recorded';

export type ScanAbortReason =
    /** No verified scanner is injected: nothing claimed, nothing becomes clean. */
    | 'scanner_absent'
    /** The claim store failed after the bounded retry budget. */
    | 'claim_failed'
    /** A run is already in flight in this process. */
    | 'already_running';

export interface ScanOutcome {
    submissionId: string;
    outcome: ScanOutcomeCode;
}

/** What happened to the bytes of an `infected` verdict (one entry per verdict). */
export interface ScanQuarantineCleanup {
    submissionId: string;
    cleanup: QuarantineCleanup;
}

export interface AssignmentScanRunResult {
    aborted: ScanAbortReason | null;
    /** Rows the store returned for this run (before in-run de-duplication). */
    claimed: number;
    clean: number;
    /** Rows left with an infected verdict, including those whose cleanup is pending. */
    quarantined: number;
    /** Rows left pending because no verdict could be recorded (incl. storage errors). */
    failed: number;
    outcomes: ScanOutcome[];
    /**
     * The cleanup result for every infected verdict in this run. `unsupported`
     * and `failed` mean the scanned bytes may still exist at the key: that is a
     * pending cleanup an operator must complete, never a silent success.
     */
    quarantineCleanup: ScanQuarantineCleanup[];
}

/* ------------------------------------------------------------------------- */
/* Worker                                                                    */
/* ------------------------------------------------------------------------- */

export interface AssignmentScanWorkerOptions {
    store: AssignmentScanStore;
    objectStore: AssignmentObjectStore;
    /** Absent ⇒ every run aborts with `scanner_absent` (fail closed). */
    scanner?: MalwareScanner;
    /** Clamped to the shared 1–120 s window by `assignment-storage`. */
    scanTimeoutMs?: number;
    batchSize?: number;
    concurrency?: number;
    /** Scan attempts per row inside one run (default 1). */
    maxAttemptsPerRow?: number;
    /** Claim-store attempts inside one run (default 3). */
    claimAttempts?: number;
    /** Base backoff delay for both the claim and the per-row retry. */
    retryDelayMs?: number;
    /** Injected for deterministic tests; defaults to a real `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
    /** Observability hook. Must never be used to alter the outcome. */
    onError?: (error: unknown) => void;
}

export interface AssignmentScanWorker {
    /** Runs exactly one bounded pass. Never schedules the next one. */
    runOnce(): Promise<AssignmentScanRunResult>;
}

/** Internal per-row result: the reported outcome plus any quarantine cleanup. */
interface CandidateResult {
    outcome: ScanOutcomeCode;
    /** Present only when the row carried an `infected` verdict. */
    cleanup?: QuarantineCleanup;
}

const emptyResult = (aborted: ScanAbortReason | null): AssignmentScanRunResult => ({
    aborted,
    claimed: 0,
    clean: 0,
    quarantined: 0,
    failed: 0,
    outcomes: [],
    quarantineCleanup: [],
});

const dedupeBySubmissionId = (candidates: readonly PendingScanCandidate[]): PendingScanCandidate[] => {
    const seen = new Set<string>();
    const unique: PendingScanCandidate[] = [];
    for (const candidate of candidates) {
        if (seen.has(candidate.submissionId)) continue;
        seen.add(candidate.submissionId);
        unique.push(candidate);
    }
    return unique;
};

export const createAssignmentScanWorker = (
    options: AssignmentScanWorkerOptions,
): AssignmentScanWorker => {
    const { store, objectStore, scanner, onError } = options;

    const batchSize = clampScanBatchSize(options.batchSize);
    const concurrency = clampScanConcurrency(options.concurrency);
    const claimAttempts = clampClaimAttempts(options.claimAttempts);
    const attemptsPerRow = clampAttemptsPerRow(options.maxAttemptsPerRow);
    const claimRetryDelayMs = clampClaimRetryDelay(options.retryDelayMs);
    const rowRetryDelayMs = clampRowRetryDelay(options.retryDelayMs);
    const scanWindowMs = resolveScanTimeoutMs(options.scanTimeoutMs);
    const sleep = options.sleep
        ?? ((ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

    let running = false;

    const report = (error: unknown): void => {
        if (!onError) return;
        try {
            onError(error);
        } catch {
            // An observability hook must never change the outcome of a run.
        }
    };

    /**
     * Claim one bounded batch. The retry is bounded and the backoff is
     * deterministic (base × 2^n), so a flapping store cannot spin.
     */
    const claimBatch = async (): Promise<PendingScanCandidate[] | null> => {
        for (let attempt = 1; attempt <= claimAttempts; attempt += 1) {
            try {
                return await store.listPendingScanBatch({ limit: batchSize });
            } catch (error) {
                report(error);
            }
            if (attempt < claimAttempts) {
                await sleep(claimRetryDelayMs * 2 ** (attempt - 1));
            }
        }
        return null;
    };

    /**
     * Scan one verified object version, retrying an unconfirmed verdict only
     * within the configured cap. Returns null when no verdict was produced;
     * a `failed` verdict or a thrown/timed-out adapter is never reinterpreted.
     */
    const scanVerifiedObject = async (
        verifiedScanner: MalwareScanner,
        candidate: PendingScanCandidate,
        metadata: AssignmentObjectMetadata,
        extension: string,
    ): Promise<MalwareScanVerdict | null> => {
        for (let attempt = 1; attempt <= attemptsPerRow; attempt += 1) {
            try {
                const verdict = await runBoundedScan(
                    verifiedScanner,
                    {
                        objectKey: candidate.storageKey,
                        sizeBytes: metadata.sizeBytes,
                        contentType: metadata.contentType,
                        extension,
                        etag: metadata.etag,
                    },
                    scanWindowMs,
                );
                if (verdict.verdict !== 'failed') return verdict;
                report(new Error(`Malware scanner reported failed: ${verdict.reason}`));
            } catch (error) {
                report(error);
            }
            if (attempt < attemptsPerRow) {
                await sleep(rowRetryDelayMs * 2 ** (attempt - 1));
            }
        }
        return null;
    };

    const processCandidate = async (candidate: PendingScanCandidate): Promise<CandidateResult> => {
        // The persisted key is the only source of object identity. Re-derive
        // every fact from it and require the row to agree before touching
        // storage: a forged/foreign key is never stat'ed.
        const parsed = parseSubmissionStorageKey(candidate.storageKey);
        if (!parsed) return { outcome: 'binding_mismatch' };
        const bound = verifySubmissionStorageKey(candidate.storageKey, {
            tenantId: candidate.tenantId,
            assignmentId: candidate.assignmentId,
            enrollmentId: candidate.enrollmentId,
            submissionId: candidate.submissionId,
            fileExtension: parsed.fileExtension,
        });
        if (!bound) return { outcome: 'binding_mismatch' };

        let metadata: AssignmentObjectMetadata | null;
        try {
            metadata = await objectStore.statObject(candidate.storageKey);
        } catch (error) {
            report(error);
            return { outcome: 'storage_error' };
        }
        if (!metadata) return { outcome: 'object_missing' };
        // An adapter that cannot express a version cannot prove which bytes a
        // verdict would describe, so nothing is scanned or recorded.
        const scanned = boundObjectVersion(metadata);
        if (!scanned) return { outcome: 'unbound_object_version' };
        // The row's verified size is the version the finalize path recorded; a
        // different object must never be scanned under the old row.
        if (scanned.sizeBytes !== candidate.fileSizeBytes) return { outcome: 'object_changed' };

        if (!scanner) return { outcome: 'scan_failed' };
        const verdict = await scanVerifiedObject(scanner, candidate, metadata, parsed.fileExtension);
        if (!verdict) return { outcome: 'scan_failed' };

        // A verdict belongs to the version it was produced from. Re-stat and
        // require the same ETag and size; otherwise the verdict is discarded.
        let current: AssignmentObjectMetadata | null;
        try {
            current = await objectStore.statObject(candidate.storageKey);
        } catch (error) {
            report(error);
            return { outcome: 'storage_error' };
        }
        if (!current) return { outcome: 'object_missing' };
        const currentVersion = boundObjectVersion(current);
        if (!currentVersion || currentVersion.version !== scanned.version) {
            return { outcome: 'object_changed' };
        }

        const scanStatus = verdict.verdict === 'infected' ? 'infected' : 'clean';
        let recorded = false;
        let writeFailed = false;
        try {
            recorded = await store.recordScanVerdict({
                submissionId: candidate.submissionId,
                tenantId: candidate.tenantId,
                assignmentId: candidate.assignmentId,
                enrollmentId: candidate.enrollmentId,
                expectedSizeBytes: scanned.sizeBytes,
                scanStatus,
            });
        } catch (error) {
            writeFailed = true;
            report(error);
        }

        if (scanStatus === 'clean') {
            if (writeFailed) return { outcome: 'scan_failed' };
            return { outcome: recorded ? 'clean' : 'verdict_not_recorded' };
        }

        // Quarantine cleanup. The row is (or will be, by its owner) non-readable
        // whatever happens here; the only question left is whether *these* bytes
        // can be provably destroyed.
        //
        // The delete is bound to the scanned version, not to the key: a
        // concurrent re-upload between the re-stat above and this call must
        // survive. When the adapter cannot enforce that precondition the helper
        // answers `unsupported` and no delete is issued at all — a mutable-key
        // delete would destroy bytes no scanner ever looked at.
        //
        // This runs even when the verdict write lost its race or threw: a row
        // write failure must never leave known-malware bytes in place. The
        // outcome still reports the write failure, so nothing is upgraded.
        const cleanup = await removeScannedObjectVersion(
            objectStore,
            { objectKey: candidate.storageKey, etag: scanned.etag, sizeBytes: scanned.sizeBytes },
            report,
        );

        if (writeFailed) return { outcome: 'scan_failed', cleanup };
        if (!recorded) return { outcome: 'verdict_not_recorded', cleanup };
        return {
            outcome: cleanup === 'unsupported' || cleanup === 'failed'
                ? 'quarantined_cleanup_pending'
                : 'quarantined',
            cleanup,
        };
    };

    /** Bounded worker pool: at most `limit` candidates in flight at once. */
    const runPool = async (candidates: readonly PendingScanCandidate[]): Promise<CandidateResult[]> => {
        const results = new Array<CandidateResult>(candidates.length);
        let cursor = 0;
        const runners = Array.from(
            { length: Math.min(concurrency, candidates.length) },
            async (): Promise<void> => {
                for (;;) {
                    const index = cursor;
                    cursor += 1;
                    if (index >= candidates.length) return;
                    const candidate = candidates[index];
                    results[index] = await processCandidate(candidate);
                }
            },
        );
        await Promise.all(runners);
        return results;
    };

    const runOnce = async (): Promise<AssignmentScanRunResult> => {
        // Absence of a scanner is a fail-closed abort, not an empty success:
        // no claim is issued, so no row can be touched or turned clean.
        if (!scanner) return emptyResult('scanner_absent');
        if (running) return emptyResult('already_running');
        running = true;
        try {
            const claimedRows = await claimBatch();
            if (claimedRows === null) return emptyResult('claim_failed');
            const unique = dedupeBySubmissionId(claimedRows);
            const results = await runPool(unique);
            const outcomes: ScanOutcome[] = unique.map((candidate, index) => ({
                submissionId: candidate.submissionId,
                outcome: results[index].outcome,
            }));
            return {
                aborted: null,
                claimed: claimedRows.length,
                clean: results.filter((entry) => entry.outcome === 'clean').length,
                quarantined: results.filter(
                    (entry) => entry.outcome === 'quarantined'
                        || entry.outcome === 'quarantined_cleanup_pending',
                ).length,
                failed: results.filter(
                    (entry) => entry.outcome === 'scan_failed' || entry.outcome === 'storage_error',
                ).length,
                outcomes,
                quarantineCleanup: unique.flatMap((candidate, index) => {
                    const cleanup = results[index].cleanup;
                    return cleanup === undefined
                        ? []
                        : [{ submissionId: candidate.submissionId, cleanup }];
                }),
            };
        } finally {
            running = false;
        }
    };

    return { runOnce };
};

/* ------------------------------------------------------------------------- */
/* SQL store over existing columns                                           */
/* ------------------------------------------------------------------------- */

/** The minimal data-access surface the SQL store needs (injected). */
export interface AssignmentScanSqlClient {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ affectedRows?: number; insertId?: number }>;
}

interface PendingScanRow {
    id: string;
    tenant_id: string;
    assignment_id: string;
    student_enrollment_id: string;
    storage_key: string;
    file_size_bytes: number | string;
}

/**
 * Production store. Both statements use columns that exist in
 * `assignment_submissions` (migration `20261018_08`): `scan_status`,
 * `file_size_bytes` and `status`. Nothing is invented, and no DDL is issued.
 *
 * The claim deliberately spans tenants (the worker is a server-owned
 * background pass, not a principal-scoped request) and excludes revoked rows
 * so a teacher revocation can never be scanned back to life. The limit is a
 * clamped integer literal, never raw caller input.
 */
export const createSqlAssignmentScanStore = (client: AssignmentScanSqlClient): AssignmentScanStore => ({
    listPendingScanBatch: async ({ limit }) => {
        const bounded = clampScanBatchSize(limit);
        const rows = await client.query<PendingScanRow>(
            `SELECT id,tenant_id,assignment_id,student_enrollment_id,storage_key,file_size_bytes
             FROM assignment_submissions
             WHERE scan_status='pending' AND file_size_bytes>0 AND status<>'revoked'
             ORDER BY submitted_at ASC, id ASC
             LIMIT ${bounded}`,
        );
        return rows.map((row) => ({
            submissionId: row.id,
            tenantId: row.tenant_id,
            assignmentId: row.assignment_id,
            enrollmentId: row.student_enrollment_id,
            storageKey: row.storage_key,
            fileSizeBytes: Number(row.file_size_bytes),
        }));
    },

    recordScanVerdict: async (write) => {
        const result = await client.execute(
            `UPDATE assignment_submissions
             SET scan_status=?
             WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
               AND scan_status='pending' AND file_size_bytes=?
               AND status<>'revoked'`,
            [
                write.scanStatus,
                write.submissionId,
                write.tenantId,
                write.assignmentId,
                write.enrollmentId,
                write.expectedSizeBytes,
            ],
        );
        return (result.affectedRows ?? 0) > 0;
    },
});
