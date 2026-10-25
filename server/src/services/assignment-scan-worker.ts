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
 *    (a verdict for one version must never authorize another). When the row also
 *    records the ETag it was verified against, that ETag is required too, so a
 *    **same-size replacement** can never inherit a verdict produced for its
 *    predecessor;
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
 * Durable claim mode (opt-in, added 2026-10-23). A store may declare
 * `capabilities.fencedVerdictWrite === true` and provide `claims`. The worker
 * then takes an owner + version + lease claim per row and carries that fence
 * into `recordScanVerdict`, so a worker whose lease expired can no longer
 * overwrite the row's new owner. The declaration is required because a lease the
 * write does not enforce is *not* fencing — it only looks like it. When the
 * declaration is absent the worker keeps the in-run guard and reports
 * `claimFencing: 'in-run-only'` instead of pretending otherwise.
 *
 * A store that was asked for the durable mode and cannot provide it reports
 * `availability.mode === 'unavailable'`; the worker then aborts with
 * `store_unavailable` **before claiming anything**. It never degrades silently to
 * the un-fenced reference path, because a run that looks durable and is not is
 * worse than a run that refuses. The reference SQL store below is explicitly
 * `reference-unfenced`; the schema-gated fenced implementation is
 * `createSqlAssignmentScanStore(client, { mode: 'fenced', ... })`.
 *
 * No `any`, no ts-ignore, no network at import, no timer at construction.
 */

import { randomUUID } from 'crypto';
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
// Type-only: the collation verdict is owned by the SQL adapter, and importing it
// as a type keeps this module free of any runtime dependency on that adapter.
import type { AssignmentEtagCollationVerdict } from './assignment-cleanup-sql';

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
 * Lease taken on a durable claim, when the store provides one. The scan itself
 * is bounded by `scanTimeoutMs` (<= 120 s), so a lease that covers several scans
 * is enough; an over-large value is clamped.
 */
export const DEFAULT_SCAN_LEASE_MS = 60_000;
export const MIN_SCAN_LEASE_MS = 5_000;
export const MAX_SCAN_LEASE_MS = 600_000;

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

const clampScanLease = (configured?: number): number =>
    clampInt(configured, DEFAULT_SCAN_LEASE_MS, MIN_SCAN_LEASE_MS, MAX_SCAN_LEASE_MS);

/**
 * Parse a stored integer strictly: digits only, safe-integer range, or nothing.
 *
 * `Number(value)` was the previous behaviour and it accepted `''` and `'  '` as
 * `0`, `'1.5'` as `1.5`, `'0x10'` as `16`, and silently lost precision past
 * `Number.MAX_SAFE_INTEGER`. None of those is a version or a byte count.
 */
const parseScanSafeInt = (value: number | string | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
    if (typeof value !== 'string') return null;
    const digits = value.trim();
    if (!/^-?\d+$/.test(digits)) return null;
    const parsed = Number(digits);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const invalidScanRow = (field: string, rowId: string | null): never => {
    throw new AssignmentScanRowInvalidError(field, rowId);
};

const requireScanSafeInt = (
    value: number | string | null | undefined,
    field: string,
    rowId: string | null,
): number => {
    const parsed = parseScanSafeInt(value);
    if (parsed === null) return invalidScanRow(field, rowId);
    return parsed;
};

/**
 * A driver answer a fenced write can be judged by. An unreported count is not
 * "no rows matched" — it is an unknowable outcome, and claiming either way would
 * be a fabrication.
 */
const scanAffectedRows = (result: { affectedRows?: number } | null | undefined): number => {
    const reported = result?.affectedRows;
    if (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) {
        throw new Error(
            'assignment scan client did not report a usable affectedRows count;'
            + ' a fenced write cannot be confirmed without it',
        );
    }
    return reported;
};

/**
 * The single-row reading of a CAS result.
 *
 * `0` is a genuine miss: another writer owns the row, or the predicate no longer
 * holds. More than one is not a miss — the statement matched rows its identity
 * does not name, which is a fence breach (a dropped tenant/version predicate
 * would look exactly like this). Reading that as `false` would report a breach
 * as an ordinary lost race, so it throws and the caller fails closed.
 */
const scanSingleRow = (result: { affectedRows?: number } | null | undefined): boolean => {
    const affected = scanAffectedRows(result);
    if (affected > 1) {
        throw new Error(
            `assignment scan CAS matched ${affected} rows; its single-row fence was violated`,
        );
    }
    return affected === 1;
};

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
    /**
     * ETag of the object version the row was verified against, when the row
     * records one. A fenced store always sets it; a legacy row (NULL) never
     * does, and a verdict is never inherited from such a row — see the
     * re-scan contract in the delivery doc.
     */
    etag?: string | null;
    /**
     * The durable claim this row was handed out under, when the store provides
     * one. It must travel with the verdict write, or the write is not fenced and
     * a worker whose lease expired could still overwrite the row's owner.
     */
    claim?: ScanClaimFence;
}

/** Owner + version of a durable claim. The pair is the fence. */
export interface ScanClaimFence {
    owner: string;
    version: number;
}

/**
 * The compare-and-set verdict write. `expectedSizeBytes` is the size of the
 * version that was actually scanned: the write only lands on a row that is
 * still `pending` for that exact size. When `claim` is present the store MUST
 * also require that it still owns the claim (same owner, same version, lease not
 * expired) **in the same statement** — a fence checked before the write but not
 * inside it narrows the window without closing it. `expectedEtag` binds the
 * verdict to the exact object version, so a same-size replacement can never
 * inherit a verdict produced for its predecessor.
 */
export interface ScanVerdictWrite {
    submissionId: string;
    tenantId: string;
    assignmentId: string;
    enrollmentId: string;
    expectedSizeBytes: number;
    /** ETag the row was verified against; required by a fenced store. */
    expectedEtag?: string;
    scanStatus: 'clean' | 'infected';
    claim?: ScanClaimFence;
}

/**
 * Durable claim surface. Optional: without it the worker runs with the in-run
 * guard only (`already_running` + de-duplication), which is all the current
 * schema can support.
 */
export interface AssignmentScanClaimStore {
    /** Claim at most `limit` pending rows with owner + version + lease, in one CAS. */
    claimBatch(request: {
        owner: string;
        nowMs: number;
        leaseUntilMs: number;
        limit: number;
    }): Promise<PendingScanCandidate[]>;
    /** Hand a claimed row back without a verdict (CAS on owner + version + lease). */
    releaseClaim(request: {
        submissionId: string;
        tenantId: string;
        assignmentId: string;
        enrollmentId: string;
        owner: string;
        version: number;
        nowMs: number;
        retryAfterMs: number;
        failure: string;
    }): Promise<boolean>;
}

/** What the store declares about itself. Declared, never inferred. */
export interface AssignmentScanStoreCapabilities {
    /**
     * True only when `recordScanVerdict` enforces `claim` inside the same
     * statement. A store that ignores the fence must declare `false`, and the
     * worker then refuses to take durable claims (a lease nobody enforces is
     * worse than no lease: it looks like fencing).
     */
    fencedVerdictWrite: boolean;
}

/**
 * What the store is. `reference-unfenced` is the historical two-statement store:
 * correct, but only de-duplicated inside one process. `unavailable` means a
 * durable store was requested and its schema/collation precondition does not
 * hold — the worker must then abort instead of silently running unfenced.
 */
export type AssignmentScanStoreMode = 'fenced' | 'reference-unfenced' | 'unavailable';

export type AssignmentScanStoreUnavailableReason =
    /** The 20261023_05 columns/index are not declared present. */
    | 'schema-not-declared'
    /** The ETag column's collation is not proven NO PAD, so equality is not exact. */
    | 'etag-collation-unverified';

export interface AssignmentScanStoreAvailability {
    mode: AssignmentScanStoreMode;
    reason: AssignmentScanStoreUnavailableReason | null;
}

/**
 * The persistence seam the worker depends on. Both methods are bounded and
 * idempotent by construction: the claim is limited, and the write is a CAS
 * whose `false` answer means "another writer owns this row now".
 */
export interface AssignmentScanStore {
    listPendingScanBatch(input: { limit: number }): Promise<PendingScanCandidate[]>;
    recordScanVerdict(write: ScanVerdictWrite): Promise<boolean>;
    /** Absent ⇒ un-fenced claim mode (current schema). */
    capabilities?: AssignmentScanStoreCapabilities;
    /** Present only together with `capabilities.fencedVerdictWrite === true`. */
    claims?: AssignmentScanClaimStore;
    /** Declared. Absent is read as the historical reference store. */
    availability?: AssignmentScanStoreAvailability;
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
    /**
     * A row could not be read as a valid claim candidate (unparseable version or
     * size, or a broken claim/lease pair). Retrying cannot fix it, so the run
     * stops on the first occurrence instead of burning the retry budget.
     */
    | 'invalid_row'
    /** A durable store was requested but its schema/collation precondition fails. */
    | 'store_unavailable'
    /** A run is already in flight in this process. */
    | 'already_running'
    /**
     * The composing runtime asked the pass to stop. No verdict was recorded and
     * every claimed row was handed back, so nothing is left half-scanned.
     */
    | 'stopped';

/**
 * A scan row that cannot be read as a valid candidate.
 *
 * The specific hazard this prevents: `Number(row.scan_claim_version ?? 0) + 1`
 * turns an unreadable version into `1`, which *resets* the fence to the value a
 * first claim would have. A row whose version cannot be read must never be
 * claimed, because the stamp would silently hand out a weaker claim than the row
 * has already seen.
 */
export class AssignmentScanRowInvalidError extends Error {
    readonly code = 'invalid_row' as const;

    constructor(
        readonly field: string,
        readonly rowId: string | null,
    ) {
        super(
            `assignment scan row is invalid: ${field}`
            + (rowId === null ? '' : ` (id ${rowId})`),
        );
        this.name = 'AssignmentScanRowInvalidError';
    }
}

export const isAssignmentScanRowInvalidError = (
    error: unknown,
): error is AssignmentScanRowInvalidError =>
    error instanceof AssignmentScanRowInvalidError;

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
    /**
     * Which claim discipline this run actually used. `fenced` means a durable
     * owner + version + lease was taken and enforced by the verdict write;
     * `in-run-only` means the only guard was the in-process `already_running`
     * flag and de-duplication — two processes may scan the same row, and a
     * worker whose lease would have expired can still write; `unavailable`
     * means a durable store was requested and refused, so nothing ran at all.
     * Reported so no caller can mistake one for the other.
     */
    claimFencing: 'fenced' | 'in-run-only' | 'unavailable';
    /** Rows the store returned for this run (before in-run de-duplication). */
    claimed: number;
    clean: number;
    /** Rows left with an infected verdict, including those whose cleanup is pending. */
    quarantined: number;
    /**
     * Rows left at `pending_scan` by this pass — exactly the `ROW_STAYS_PENDING`
     * outcomes, including storage errors, a binding mismatch, a changed or
     * missing object, and a verdict the CAS refused. `clean + quarantined +
     * failed` is the number of rows processed.
     */
    failed: number;
    outcomes: ScanOutcome[];
    /**
     * The cleanup result for every infected verdict in this run. `unsupported`
     * and `failed` mean the scanned bytes may still exist at the key: that is a
     * pending cleanup an operator must complete, never a silent success.
     */
    quarantineCleanup: ScanQuarantineCleanup[];
    /** Fenced claims handed back for a retry (always 0 in `in-run-only` mode). */
    claimsReleased: number;
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
    /** Durable claim owner. Defaults to a fresh UUID; injected for determinism. */
    owner?: string;
    newOwnerId?: () => string;
    /** Lease taken on a durable claim (clamped to 5 s–10 min). */
    leaseMs?: number;
    /** Injected clock, used only for claim/lease arithmetic. */
    now?: () => Date;
    /** Injected for deterministic tests; defaults to a real `setTimeout`. */
    sleep?: (ms: number) => Promise<void>;
    /** Observability hook. Must never be used to alter the outcome. */
    onError?: (error: unknown) => void;
    /**
     * Cooperative cancellation, read before each claim and between batches.
     * Supplied by the composing runtime so a `stop()` reaches the scan pass,
     * which has no stop surface of its own. Advisory: a scan already in
     * flight cannot be un-run.
     */
    shouldContinue?: () => boolean;
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

const emptyResult = (
    aborted: ScanAbortReason | null,
    claimFencing: 'fenced' | 'in-run-only' | 'unavailable',
): AssignmentScanRunResult => ({
    aborted,
    claimFencing,
    claimed: 0,
    clean: 0,
    quarantined: 0,
    failed: 0,
    outcomes: [],
    quarantineCleanup: [],
    claimsReleased: 0,
});

/**
 * Outcomes that leave the row at `pending_scan` (nothing was recorded). Only
 * these hand a durable claim back; a terminal outcome consumed the claim
 * because the row moved off `pending_scan` in the same statement.
 */
const ROW_STAYS_PENDING: ReadonlySet<ScanOutcomeCode> = new Set<ScanOutcomeCode>([
    'scan_failed',
    'storage_error',
    'object_changed',
    'unbound_object_version',
    'binding_mismatch',
    'object_missing',
    'verdict_not_recorded',
]);

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
    const leaseMs = clampScanLease(options.leaseMs);
    const now = options.now ?? ((): Date => new Date());
    const owner = options.owner ?? (options.newOwnerId ?? ((): string => randomUUID()))();
    /**
     * Durable claims are used only when the store both provides them **and**
     * declares that its verdict write enforces the fence. A lease that the write
     * ignores is not fencing: it would let a worker whose lease expired write
     * over the row's new owner, while looking safe.
     */
    const durableClaims = store.claims && store.capabilities?.fencedVerdictWrite === true
        ? store.claims
        : null;
    /**
     * A store that was asked for a durable mode and refused is not a weaker
     * store — it is no store. Reporting `unavailable` here is what stops the run
     * from silently degrading to the un-fenced reference behaviour.
     */
    const storeUnavailable = store.availability?.mode === 'unavailable';
    const claimFencing: 'fenced' | 'in-run-only' | 'unavailable' = storeUnavailable
        ? 'unavailable'
        : (durableClaims ? 'fenced' : 'in-run-only');
    const sleep = options.sleep
        ?? ((ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

    let running = false;

    /**
     * Cooperative cancellation, supplied by the composing runtime.
     *
     * The worker exposes only `runOnce()` and no stop surface of its own, so a
     * `stop()` on the runtime used to be invisible here: the pass kept claiming
     * batches and running concurrent scans to completion. This predicate is
     * read before each claim and between batches; it is advisory by design,
     * because a scan already in flight cannot be un-run.
     */
    const shouldContinue = options.shouldContinue ?? ((): boolean => true);

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
     *
     * With a fenced durable store the claim stamps owner + version + lease in one
     * CAS, and every candidate carries that fence to its verdict write. Without
     * one, the claim is the historical read-only batch: correct, but only
     * de-duplicated inside this process.
     */
    /**
     * Why the last claim attempt gave up. `null` until a claim fails, so the
     * caller can distinguish a transport/store failure (retryable) from a corrupt
     * row (not retryable) without guessing.
     */
    let claimAbort: ScanAbortReason | null = null;

    const claimBatch = async (): Promise<PendingScanCandidate[] | null> => {
        // Reset per call. A stale value from an earlier `runOnce()` otherwise
        // poisons the abort reason of every later run: one corrupt row followed
        // by one transient store failure reports `invalid_row` forever, and a
        // supervisor that halts on `invalid_row` stops scanning permanently.
        claimAbort = null;
        for (let attempt = 1; attempt <= claimAttempts; attempt += 1) {
            // Read before *every* claim, including a retry. A stop that lands
            // during the backoff used to be followed by another claim anyway,
            // which took a fresh lease on up to `batchSize` rows for a run the
            // caller had already cancelled; only the post-claim release loop
            // could hand them back, and a process that died there held them
            // until the lease expired. `stopped` is reported instead of
            // `claim_failed` so a drain is never mistaken for a broken store.
            if (!shouldContinue()) {
                claimAbort = 'stopped';
                return null;
            }
            try {
                if (durableClaims) {
                    const claimNowMs = now().getTime();
                    return await durableClaims.claimBatch({
                        owner,
                        nowMs: claimNowMs,
                        leaseUntilMs: claimNowMs + leaseMs,
                        limit: batchSize,
                    });
                }
                return await store.listPendingScanBatch({ limit: batchSize });
            } catch (error) {
                report(error);
                // A corrupt row will still be corrupt after three sleeps. Stop
                // here and say so, instead of reporting `claim_failed` for a
                // failure no retry could have fixed.
                if (isAssignmentScanRowInvalidError(error)) {
                    claimAbort = 'invalid_row';
                    return null;
                }
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
        // A row that also records its ETag pins the exact version. A different
        // object of the *same size* is a replacement, not the version this row
        // describes: scanning it and recording the verdict would let a same-size
        // replacement inherit a verdict produced for its predecessor.
        if (typeof candidate.etag === 'string' && scanned.etag !== candidate.etag) {
            return { outcome: 'object_changed' };
        }

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

        // Only a verdict the scanner actually produced may become a
        // `scan_status`. `scanVerifiedObject` never returns `failed`, but a
        // default arm of "not infected ⇒ clean" is precisely the shape of an
        // uploaded⇒clean shortcut: a `failed` that escaped, or a third verdict
        // added later, would be persisted as clean. Fail closed — the row stays
        // `pending_scan`.
        const scanStatus: 'clean' | 'infected' | null = verdict.verdict === 'infected'
            ? 'infected'
            : (verdict.verdict === 'clean' ? 'clean' : null);
        if (scanStatus === null) return { outcome: 'scan_failed' };
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
                // The version the verdict belongs to. A fenced store requires it
                // in the CAS; the un-fenced reference store must see exactly the
                // historical shape, so it is only added when the row recorded one.
                ...(typeof candidate.etag === 'string' ? { expectedEtag: candidate.etag } : {}),
                // The fence travels with the write only when the store hands one
                // out; an un-fenced store must see exactly the historical shape.
                ...(candidate.claim ? { claim: candidate.claim } : {}),
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
        // A durable store whose precondition fails is a hard stop: never fall
        // back to the un-fenced reference path, which would look durable.
        if (storeUnavailable) return emptyResult('store_unavailable', claimFencing);
        // Absence of a scanner is a fail-closed abort, not an empty success:
        // no claim is issued, so no row can be touched or turned clean.
        if (!scanner) return emptyResult('scanner_absent', claimFencing);
        if (running) return emptyResult('already_running', claimFencing);
        // A stop that arrived before this pass claimed anything: no claim is
        // issued, so no row is touched and no lease is taken.
        if (!shouldContinue()) return emptyResult('stopped', claimFencing);
        running = true;
        try {
            const claimedRows = await claimBatch();
            if (claimedRows === null) return emptyResult(claimAbort ?? 'claim_failed', claimFencing);
            // A stop that landed after the claim but before the pool: the batch
            // is released rather than held, so the lease is handed back and no
            // row is scanned under a cancelled run. The scan pool is skipped,
            // not interrupted — a scan already in flight cannot be un-run.
            if (!shouldContinue()) {
                let released = 0;
                if (durableClaims) {
                    for (const candidate of dedupeBySubmissionId(claimedRows)) {
                        const fence = candidate.claim;
                        if (!fence) continue;
                        try {
                            const handedBack = await durableClaims.releaseClaim({
                                submissionId: candidate.submissionId,
                                tenantId: candidate.tenantId,
                                assignmentId: candidate.assignmentId,
                                enrollmentId: candidate.enrollmentId,
                                owner: fence.owner,
                                version: fence.version,
                                nowMs: now().getTime(),
                                retryAfterMs: rowRetryDelayMs,
                                failure: 'stopped',
                            });
                            if (handedBack) released += 1;
                        } catch (error) {
                            report(error);
                        }
                    }
                }
                return {
                    aborted: 'stopped',
                    claimFencing,
                    claimed: claimedRows.length,
                    clean: 0,
                    quarantined: 0,
                    failed: 0,
                    outcomes: [],
                    quarantineCleanup: [],
                    claimsReleased: released,
                };
            }
            const unique = dedupeBySubmissionId(claimedRows);
            const results = await runPool(unique);
            const outcomes: ScanOutcome[] = unique.map((candidate, index) => ({
                submissionId: candidate.submissionId,
                outcome: results[index].outcome,
            }));
            // A row that recorded no verdict is still `pending_scan` and still
            // ours; hand the claim back explicitly instead of holding a lease
            // until it expires. A terminal outcome consumed the claim, because
            // the row left `pending_scan` in the same fenced statement.
            let claimsReleased = 0;
            if (durableClaims) {
                for (let index = 0; index < unique.length; index += 1) {
                    const candidate = unique[index];
                    const fence = candidate.claim;
                    if (!fence) continue;
                    if (!ROW_STAYS_PENDING.has(results[index].outcome)) continue;
                    try {
                        const handedBack = await durableClaims.releaseClaim({
                            submissionId: candidate.submissionId,
                            tenantId: candidate.tenantId,
                            assignmentId: candidate.assignmentId,
                            enrollmentId: candidate.enrollmentId,
                            owner: fence.owner,
                            version: fence.version,
                            nowMs: now().getTime(),
                            retryAfterMs: rowRetryDelayMs,
                            failure: results[index].outcome,
                        });
                        if (handedBack) claimsReleased += 1;
                    } catch (error) {
                        report(error);
                    }
                }
            }
            return {
                aborted: null,
                claimFencing,
                claimed: claimedRows.length,
                clean: results.filter((entry) => entry.outcome === 'clean').length,
                quarantined: results.filter(
                    (entry) => entry.outcome === 'quarantined'
                        || entry.outcome === 'quarantined_cleanup_pending',
                ).length,
                // Every row left at `pending_scan` is a failure of this pass,
                // and `ROW_STAYS_PENDING` is the exact set of them. Counting
                // only `scan_failed`/`storage_error` made a pass that left ten
                // rows on `binding_mismatch`/`object_changed` report
                // `aborted: null, failed: 0` — indistinguishable from an empty
                // pass. With the full set, `clean + quarantined + failed` equals
                // the number of rows processed, and `outcomes[]` still carries
                // each exact code.
                failed: results.filter((entry) => ROW_STAYS_PENDING.has(entry.outcome)).length,
                outcomes,
                quarantineCleanup: unique.flatMap((candidate, index) => {
                    const cleanup = results[index].cleanup;
                    return cleanup === undefined
                        ? []
                        : [{ submissionId: candidate.submissionId, cleanup }];
                }),
                claimsReleased,
            };
        } finally {
            running = false;
        }
    };

    return { runOnce };
};

/* ------------------------------------------------------------------------- */
/* SQL stores                                                                */
/* ------------------------------------------------------------------------- */

/** The minimal data-access surface both SQL stores need (injected). */
export interface AssignmentScanSqlClient {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ affectedRows?: number; insertId?: number }>;
}

/**
 * One unit of work on one connection. Required by the fenced claim: it selects a
 * page `FOR UPDATE SKIP LOCKED` and stamps each row, and a split across two
 * connections would hand the same row to two workers.
 */
export type AssignmentScanSqlTransaction = <T>(
    fn: (tx: AssignmentScanSqlClient) => Promise<T>,
) => Promise<T>;

interface PendingScanRow {
    id: string;
    tenant_id: string;
    assignment_id: string;
    student_enrollment_id: string;
    storage_key: string;
    file_size_bytes: number | string;
    object_etag?: string | null;
    scan_claim_version?: number | string;
}

/**
 * The migration owner's declaration that `20261023_05` landed: the claim/attempt
 * columns exist **and** the ETag column's collation is proven NO PAD. Both are
 * literals/verdicts, never booleans, so nobody enables the fenced path by
 * accident.
 */
export interface AssignmentScanFencedSchema {
    fencingColumns: 'declared';
    etagCollation: AssignmentEtagCollationVerdict;
}

export interface AssignmentScanFencedOptions {
    mode: 'fenced';
    schema: AssignmentScanFencedSchema;
    transaction: AssignmentScanSqlTransaction;
    /** Injected clock for the lease comparisons. */
    now?: () => Date;
}

/**
 * Reference mode: the historical two-statement store over columns that exist in
 * `assignment_submissions` (migration `20261018_08`). Correct, but explicitly
 * **not** durable: it declares `fencedVerdictWrite: false`, provides no claims,
 * and reports `reference-unfenced`, so no caller can read it as a lease.
 *
 * The claim deliberately spans tenants (the worker is a server-owned background
 * pass, not a principal-scoped request) and excludes revoked rows so a teacher
 * revocation can never be scanned back to life. The limit is a clamped integer
 * literal, never raw caller input.
 */
const createReferenceScanStore = (client: AssignmentScanSqlClient): AssignmentScanStore => ({
    availability: { mode: 'reference-unfenced', reason: null },
    capabilities: { fencedVerdictWrite: false },
    listPendingScanBatch: async ({ limit }) => {
        const bounded = clampScanBatchSize(limit);
        const rows = await client.query<PendingScanRow>(
            `SELECT id,tenant_id,assignment_id,student_enrollment_id,storage_key,file_size_bytes
             FROM assignment_submissions
             WHERE scan_status='pending' AND file_size_bytes>0 AND status<>'revoked'
             ORDER BY submitted_at ASC, id ASC
             LIMIT ${bounded}`,
        );
        // A row whose size cannot be read is never defaulted to zero: the SQL
        // already requires `file_size_bytes>0`, so a non-positive or unparseable
        // value is corruption. Throwing makes the worker abort with `invalid_row`
        // (not retryable) instead of scanning a row against a fabricated count.
        return rows.map((row) => {
            const fileSizeBytes = requireScanSafeInt(row.file_size_bytes, 'file_size_bytes', row.id);
            if (fileSizeBytes <= 0) return invalidScanRow('file_size_bytes', row.id);
            return {
                submissionId: row.id,
                tenantId: row.tenant_id,
                assignmentId: row.assignment_id,
                enrollmentId: row.student_enrollment_id,
                storageKey: row.storage_key,
                fileSizeBytes,
            };
        });
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
        return scanSingleRow(result);
    },
});

/**
 * A store that was asked for the durable mode and cannot provide it. Every
 * method refuses; the worker aborts with `store_unavailable` before claiming
 * anything. This exists so "durable was requested" can never degrade into the
 * un-fenced reference path.
 */
const createUnavailableScanStore = (reason: AssignmentScanStoreUnavailableReason): AssignmentScanStore => {
    const refuse = (): never => {
        throw new Error(`fenced assignment scan store is unavailable (${reason}); it must not be used`);
    };
    return {
        availability: { mode: 'unavailable', reason },
        listPendingScanBatch: async () => refuse(),
        recordScanVerdict: async () => refuse(),
    };
};

/**
 * Fenced mode: every statement binds the row's identity, its stored object
 * version (`object_etag` + `file_size_bytes`) and the claim fence
 * (owner + version + unexpired lease) in the same statement, on the same
 * connection.
 *
 * Two behaviours are deliberate:
 *
 *  - the claim requires `object_etag IS NOT NULL`. A legacy row whose ETag was
 *    never recorded cannot bind a verdict to a version, so it is **not** claimed
 *    and **not** trusted; it stays `pending_scan` (unreadable) until it is
 *    re-finalized. There is no backfill and no inference.
 *  - the verdict CAS requires `expectedEtag` and `claim`; without either it
 *    answers `false` instead of writing unfenced through a fenced store.
 */
const createFencedScanStore = (
    client: AssignmentScanSqlClient,
    transaction: AssignmentScanSqlTransaction,
    now: () => Date,
): AssignmentScanStore => {
    const claims: AssignmentScanClaimStore = {
        claimBatch: async ({ owner, leaseUntilMs, limit }) => {
            const bounded = clampScanBatchSize(limit);
            // A lease that has already expired is a claim no verdict can use, and
            // one measured in the wrong unit is worse. Refuse before locking.
            if (typeof owner !== 'string' || owner.length === 0) {
                throw new Error('assignment scan claim request has no owner');
            }
            return transaction(async (tx) => {
                const nowMs = now().getTime();
                if (!Number.isSafeInteger(leaseUntilMs) || leaseUntilMs <= nowMs) {
                    throw new Error('assignment scan claim request has an already-expired lease');
                }
                if (leaseUntilMs - nowMs > MAX_SCAN_LEASE_MS) {
                    throw new Error('assignment scan claim request lease exceeds the maximum');
                }
                const rows = await tx.query<PendingScanRow>(
                    `SELECT id,tenant_id,assignment_id,student_enrollment_id,storage_key,file_size_bytes,
                            object_etag,scan_claim_version
                     FROM assignment_submissions
                     WHERE scan_status='pending' AND file_size_bytes>0 AND status<>'revoked'
                       AND object_etag IS NOT NULL
                       AND (scan_next_attempt_ms IS NULL OR scan_next_attempt_ms <= ?)
                       AND (scan_claim_owner IS NULL OR scan_lease_until_ms <= ?)
                     ORDER BY submitted_at ASC, id ASC
                     LIMIT ?
                     FOR UPDATE SKIP LOCKED`,
                    [nowMs, nowMs, bounded],
                );
                const claimed: PendingScanCandidate[] = [];
                for (const row of rows) {
                    const etag = typeof row.object_etag === 'string' ? row.object_etag : null;
                    // Defensive: the WHERE already excludes NULL, but a row that
                    // somehow lost its ETag must never be claimed as verifiable.
                    if (etag === null) continue;
                    // Never `?? 0`: an unreadable version read as 0 would stamp
                    // version 1 and hand out a fence weaker than the row's own.
                    const currentVersion = requireScanSafeInt(row.scan_claim_version, 'scan_claim_version', row.id);
                    const version = currentVersion + 1;
                    if (!Number.isSafeInteger(version)) return invalidScanRow('scan_claim_version', row.id);
                    const fileSizeBytes = requireScanSafeInt(row.file_size_bytes, 'file_size_bytes', row.id);
                    if (fileSizeBytes <= 0) return invalidScanRow('file_size_bytes', row.id);
                    const stamped = await tx.execute(
                        `UPDATE assignment_submissions
                         SET scan_claim_owner=?, scan_claim_version=?, scan_lease_until_ms=?,
                             scan_next_attempt_ms=NULL
                         WHERE id=? AND scan_status='pending' AND status<>'revoked'
                           AND (scan_claim_owner IS NULL OR scan_lease_until_ms <= ?)`,
                        [owner, version, leaseUntilMs, row.id, nowMs],
                    );
                    // Exactly one row: anything else means we did not win this row.
                    if (!scanSingleRow(stamped)) continue;
                    claimed.push({
                        submissionId: row.id,
                        tenantId: row.tenant_id,
                        assignmentId: row.assignment_id,
                        enrollmentId: row.student_enrollment_id,
                        storageKey: row.storage_key,
                        fileSizeBytes,
                        etag,
                        claim: { owner, version },
                    });
                }
                return claimed;
            });
        },

        releaseClaim: async (request) => {
            const retryAfterMs = Number.isSafeInteger(request.retryAfterMs) && request.retryAfterMs > 0
                ? request.retryAfterMs
                : 0;
            const retryAtMs = request.nowMs + retryAfterMs;
            if (!Number.isSafeInteger(retryAtMs)) {
                throw new Error('assignment scan release request has an out-of-range retry time');
            }
            const result = await client.execute(
                `UPDATE assignment_submissions
                 SET scan_claim_owner=NULL, scan_claim_version=scan_claim_version+1,
                     scan_lease_until_ms=NULL, scan_attempts=scan_attempts+1,
                     scan_last_error=?, scan_next_attempt_ms=?
                 WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
                   AND scan_status='pending' AND status<>'revoked'
                   AND scan_claim_owner=? AND scan_claim_version=? AND scan_lease_until_ms>?`,
                [
                    request.failure,
                    retryAtMs,
                    request.submissionId,
                    request.tenantId,
                    request.assignmentId,
                    request.enrollmentId,
                    request.owner,
                    request.version,
                    request.nowMs,
                ],
            );
            return scanSingleRow(result);
        },
    };

    return {
        availability: { mode: 'fenced', reason: null },
        capabilities: { fencedVerdictWrite: true },
        claims,
        // A fenced store must not expose the un-fenced batch: that path would
        // read rows without taking a claim, which is exactly the guarantee this
        // mode exists to provide.
        listPendingScanBatch: async () => {
            throw new Error('a fenced assignment scan store does not expose an un-fenced batch');
        },
        recordScanVerdict: async (write) => {
            // Without the version and the fence this is not a fenced write.
            if (!write.claim || typeof write.expectedEtag !== 'string') return false;
            // A verdict must bind to a real byte count: binding to a coerced
            // value would match a row whose size we never read.
            if (!Number.isSafeInteger(write.expectedSizeBytes) || write.expectedSizeBytes <= 0) {
                return invalidScanRow('expectedSizeBytes', write.submissionId);
            }
            const result = await client.execute(
                `UPDATE assignment_submissions
                 SET scan_status=?, scan_claim_owner=NULL,
                     scan_claim_version=scan_claim_version+1,
                     scan_lease_until_ms=NULL, scan_last_error=NULL
                 WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
                   AND scan_status='pending' AND file_size_bytes=? AND status<>'revoked'
                   AND object_etag=? AND scan_claim_owner=? AND scan_claim_version=?
                   AND scan_lease_until_ms>?`,
                [
                    write.scanStatus,
                    write.submissionId,
                    write.tenantId,
                    write.assignmentId,
                    write.enrollmentId,
                    write.expectedSizeBytes,
                    write.expectedEtag,
                    write.claim.owner,
                    write.claim.version,
                    now().getTime(),
                ],
            );
            return scanSingleRow(result);
        },
    };
};

/**
 * Build the scan store.
 *
 * Without options this is the historical reference store, byte-for-byte the same
 * two statements, explicitly un-fenced. With `mode: 'fenced'` it is the
 * schema-gated fenced implementation — and when the declared schema or the ETag
 * collation does not hold, the result is an **unavailable** store, never a silent
 * fallback to the reference behaviour.
 */
export const createSqlAssignmentScanStore = (
    client: AssignmentScanSqlClient,
    options?: AssignmentScanFencedOptions,
): AssignmentScanStore => {
    if (!options) return createReferenceScanStore(client);
    if (options.schema.fencingColumns !== 'declared') {
        return createUnavailableScanStore('schema-not-declared');
    }
    if (options.schema.etagCollation.status !== 'no-pad-verified') {
        // Under a PAD SPACE collation `object_etag = ?` is not exact equality,
        // so the verdict could bind to a different version that differs only by
        // trailing spaces. Refuse rather than write a verdict we cannot trust.
        return createUnavailableScanStore('etag-collation-unverified');
    }
    const now = options.now ?? ((): Date => new Date());
    return createFencedScanStore(client, options.transaction, now);
};

/* ------------------------------------------------------------------------- */
/* Statement contract (exported for the migration owner, not executed here)   */
/* ------------------------------------------------------------------------- */

/** The exact statements each mode issues, so the schema contract can be diffed. */
export const ASSIGNMENT_SCAN_STATEMENTS = {
    referenceClaim: `SELECT id,tenant_id,assignment_id,student_enrollment_id,storage_key,file_size_bytes
FROM assignment_submissions
WHERE scan_status='pending' AND file_size_bytes>0 AND status<>'revoked'
ORDER BY submitted_at ASC, id ASC
LIMIT ?`,
    referenceVerdict: `UPDATE assignment_submissions
SET scan_status=?
WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
  AND scan_status='pending' AND file_size_bytes=?
  AND status<>'revoked'`,
    fencedClaimPage: `SELECT id,tenant_id,assignment_id,student_enrollment_id,storage_key,file_size_bytes,
       object_etag,scan_claim_version
FROM assignment_submissions
WHERE scan_status='pending' AND file_size_bytes>0 AND status<>'revoked'
  AND object_etag IS NOT NULL
  AND (scan_next_attempt_ms IS NULL OR scan_next_attempt_ms <= ?)
  AND (scan_claim_owner IS NULL OR scan_lease_until_ms <= ?)
ORDER BY submitted_at ASC, id ASC
LIMIT ?
FOR UPDATE SKIP LOCKED`,
    fencedClaimStamp: `UPDATE assignment_submissions
SET scan_claim_owner=?, scan_claim_version=?, scan_lease_until_ms=?, scan_next_attempt_ms=NULL
WHERE id=? AND scan_status='pending' AND status<>'revoked'
  AND (scan_claim_owner IS NULL OR scan_lease_until_ms <= ?)`,
    fencedVerdict: `UPDATE assignment_submissions
SET scan_status=?, scan_claim_owner=NULL, scan_claim_version=scan_claim_version+1,
    scan_lease_until_ms=NULL, scan_last_error=NULL
WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
  AND scan_status='pending' AND file_size_bytes=? AND status<>'revoked'
  AND object_etag=? AND scan_claim_owner=? AND scan_claim_version=?
  AND scan_lease_until_ms>?`,
    fencedRelease: `UPDATE assignment_submissions
SET scan_claim_owner=NULL, scan_claim_version=scan_claim_version+1,
    scan_lease_until_ms=NULL, scan_attempts=scan_attempts+1,
    scan_last_error=?, scan_next_attempt_ms=?
WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
  AND scan_status='pending' AND status<>'revoked'
  AND scan_claim_owner=? AND scan_claim_version=? AND scan_lease_until_ms>?`,
} as const;

/**
 * Rows the fenced claim never touches, stated once so it cannot drift: a
 * `pending_scan` row with a NULL `object_etag` has no version binding. It is not
 * backfilled, not inferred from a stat, and not scanned — it stays unreadable
 * until it is re-finalized (which records the version it verified).
 */
export const LEGACY_UNBOUND_ETAG_POLICY = 're-finalize-required' as const;
