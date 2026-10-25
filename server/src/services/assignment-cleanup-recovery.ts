/**
 * Durable, exact-version cleanup recovery for rejected and cancelled assignment
 * submission objects.
 *
 * Why this module exists
 * ----------------------
 * `routes/assignments.ts` already refuses a rejected object and destroys the
 * exact version it verified, and `assignment-scan-worker.ts` quarantines an
 * infected row. In both cases the *obligation* to destroy the bytes lives only
 * inside the request (or the run) that discovered it. If the process dies
 * between the denial and the delete — or the adapter simply cannot delete by
 * version — the only remaining trace is a log line. This module adds a durable
 * obligation record plus a bounded coordinator that finishes the work later.
 *
 * Non-negotiables encoded here
 * ---------------------------
 *  - An obligation names an **exact object version** (`etag` + `sizeBytes`),
 *    never a mutable key. `removeObject(key)` is never called from this module
 *    or from anything it composes.
 *  - A delete is issued only when the adapter declares an exact-version
 *    capability (`supportsExactVersionRemoval`). Otherwise nothing is deleted
 *    and the obligation stays `pending` with `capability_absent` — never a
 *    queued/deleted success claim.
 *  - Identity is re-proven immediately before the delete: the stored key is
 *    re-parsed and must still bind to the recorded tenant / assignment /
 *    enrollment / submission, and a fresh stat must still report the recorded
 *    version. A replacement version is never deleted; it is recorded as
 *    `superseded`.
 *  - External deletion and DB completion are two distinct stages. A crash
 *    between them leaves a `pending` row; the replay re-stats, finds nothing at
 *    the key, and completes on the store's own answer. Not-found is trusted
 *    only when the store (or a fresh stat) says so — never inferred from an
 *    error message.
 *  - The coordinator is explicitly driven. Construction performs no I/O, opens
 *    no timer, starts nothing on import, and requires no durable store to be
 *    present (an absent store is `cleanup-unconfigured`, reported, never faked).
 *
 * No SQL is issued by this module. Every statement lives behind an injected
 * port, because `assignment_submissions` has no obligation/claim/lease columns
 * today: issuing SQL against columns that do not exist would be a fabricated
 * guarantee. The exact DDL and the exact statements a durable adapter must run
 * are delivered in `docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md`.
 *
 * No `any`, no ts-ignore, no network at import, no timer at construction.
 */

import { randomUUID } from 'crypto';
import {
    parseSubmissionStorageKey,
    supportsExactVersionRemoval,
} from './assignment-storage';
import type { AssignmentObjectStore, BoundObjectVersion, QuarantineCleanup } from './assignment-storage';
import { normalizeCleanupReason, normalizeId } from './assignments';
import type { AssignmentCleanupReason } from './assignments';

/* ------------------------------------------------------------------------- */
/* Bounds                                                                    */
/* ------------------------------------------------------------------------- */

/** Obligations claimed per page when nothing is configured. */
export const DEFAULT_CLEANUP_PAGE_SIZE = 10;
/** Hard ceiling on one page; an over-large configuration is clamped, never honoured. */
export const MAX_CLEANUP_PAGE_SIZE = 50;
/** Pages per run when nothing is configured. */
export const DEFAULT_CLEANUP_MAX_PAGES = 4;
export const MAX_CLEANUP_MAX_PAGES = 20;
/** Obligations inspected per run when nothing is configured. */
export const DEFAULT_CLEANUP_MAX_ITEMS = 25;
export const MAX_CLEANUP_MAX_ITEMS = 200;
/** Wall-clock budget for one run (external deletes are the slow part). */
export const DEFAULT_CLEANUP_RUN_BUDGET_MS = 5_000;
export const MAX_CLEANUP_RUN_BUDGET_MS = 30_000;
/**
 * Claim lease. A run never takes longer than its budget, so this only has to
 * cover it — and `createAssignmentCleanupRecovery` enforces that by raising the
 * effective lease to the run budget, because the two clamps are independent and
 * a shorter configured lease would expire under a live run.
 */
export const DEFAULT_CLEANUP_LEASE_MS = 30_000;
export const MIN_CLEANUP_LEASE_MS = 5_000;
export const MAX_CLEANUP_LEASE_MS = 300_000;
/**
 * Width of the `claim_owner` column (`VARCHAR(64)` in the durable schema). The
 * owner is both stored by the claim and matched by the completion/release
 * fence, so an owner longer than the column cannot round-trip: under a
 * non-strict server the claim would be truncated and every later fence would
 * compare the full value against the stored prefix and answer "not yours",
 * leaving the row leased until expiry. The bound is derived from the schema,
 * not chosen here.
 */
export const MAX_CLEANUP_OWNER_LENGTH = 64;
/**
 * Retry scheduling for a released obligation (deterministic exponential, never
 * random). This is a *retry delay*, not a retention window: it decides when a
 * still-pending obligation becomes claimable again, and it is capped so a
 * permanently failing row cannot be hammered.
 */
export const DEFAULT_CLEANUP_RETRY_DELAY_MS = 1_000;
export const MAX_CLEANUP_RETRY_DELAY_MS = 60_000;

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};

export const clampCleanupPageSize = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLEANUP_PAGE_SIZE, 1, MAX_CLEANUP_PAGE_SIZE);

export const clampCleanupMaxPages = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLEANUP_MAX_PAGES, 1, MAX_CLEANUP_MAX_PAGES);

export const clampCleanupMaxItems = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLEANUP_MAX_ITEMS, 1, MAX_CLEANUP_MAX_ITEMS);

export const clampCleanupRunBudgetMs = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLEANUP_RUN_BUDGET_MS, 1, MAX_CLEANUP_RUN_BUDGET_MS);

export const clampCleanupLeaseMs = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLEANUP_LEASE_MS, MIN_CLEANUP_LEASE_MS, MAX_CLEANUP_LEASE_MS);

const clampRetryDelayMs = (configured?: number): number =>
    clampInt(configured, DEFAULT_CLEANUP_RETRY_DELAY_MS, 0, MAX_CLEANUP_RETRY_DELAY_MS);

/* ------------------------------------------------------------------------- */
/* Obligation identity                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The durable obligation states. Only three exist, and each one is a claim the
 * module can defend:
 *
 *  - `pending`    — work still owed. The bytes may still be at the key.
 *  - `deleted`    — the store (or a fresh stat) proved nothing is at the key for
 *                   the named version any more.
 *  - `superseded` — the named version is no longer the current version at the
 *                   key. Nothing was deleted by this module and the replacement
 *                   is untouched. This is deliberately **not** `deleted`: with a
 *                   versioned bucket the older bytes can still exist, so calling
 *                   it deleted would be a fabricated success.
 */
export const ASSIGNMENT_CLEANUP_STATES = ['pending', 'deleted', 'superseded'] as const;
export type AssignmentCleanupState = (typeof ASSIGNMENT_CLEANUP_STATES)[number];

/** A terminal state (everything that is not `pending`). */
export type AssignmentCleanupTerminalState = Exclude<AssignmentCleanupState, 'pending'>;

/**
 * Why an obligation was handed back to `pending`. Closed union: a free-form
 * reason string would let a store record a failure nobody can classify later.
 * A lost claim is deliberately **not** a failure here — the row is not written
 * at all in that case, it simply returns to `pending` when its lease expires.
 */
export const ASSIGNMENT_CLEANUP_FAILURES = [
    /** The adapter cannot delete by exact version. Nothing was deleted. */
    'capability_absent',
    /** The store threw while stat'ing or deleting. Retryable. */
    'store_error',
    /** The record's key does not bind to its own identifiers. Never deleted. */
    'binding_mismatch',
    /** The store returned a row that is not `pending` for a claim: a store bug. */
    'record_state_invalid',
    /**
     * The record's stored ETag cannot be proven to be the exact version. PAD
     * SPACE collation affects COMPARISON only (trailing spaces are ignored when
     * two values are compared; the stored bytes are NOT trimmed), so a raw
     * mismatch cannot be distinguished from a genuine replacement for a legacy
     * row — and a NO PAD collation today does not prove a legacy row was written
     * under that contract. The row is held `pending`; nothing is deleted and
     * nothing is terminalized. This is an honest, classified hold, never a
     * fabricated provenance verdict, and it fires for every unproven record (even
     * on an exact ETag match) via the provenance gate in `inspectAndDelete`.
     */
    'legacy_etag_unprovable',
] as const;
export type AssignmentCleanupFailure = (typeof ASSIGNMENT_CLEANUP_FAILURES)[number];

/**
 * What proved a terminal state. Recorded verbatim so a later reader can tell a
 * store-confirmed deletion from our own stat, and a deletion from a refusal.
 */
export const ASSIGNMENT_CLEANUP_PROOFS = [
    /** `removeObjectVersion` answered `removed`. */
    'store_removed',
    /** `removeObjectVersion` answered `already_absent` (idempotent replay). */
    'store_already_absent',
    /** A trusted re-stat found nothing at the key. */
    'pre_stat_absent',
    /** `removeObjectVersion` answered `version_replaced`: nothing deleted. */
    'store_version_replaced',
    /** A trusted re-stat found a different version: nothing deleted. */
    'pre_stat_version_replaced',
] as const;
export type AssignmentCleanupProof = (typeof ASSIGNMENT_CLEANUP_PROOFS)[number];

const DELETED_PROOFS: ReadonlySet<AssignmentCleanupProof> = new Set<AssignmentCleanupProof>([
    'store_removed',
    'store_already_absent',
    'pre_stat_absent',
]);

/** The terminal state a proof establishes. */
export const cleanupStateForProof = (proof: AssignmentCleanupProof): AssignmentCleanupTerminalState =>
    (DELETED_PROOFS.has(proof) ? 'deleted' : 'superseded');

/**
 * The immutable identity of one cleanup obligation: one object **version** of
 * one submission. Two obligations for the same submission are legitimate (a
 * rejected upload can be replaced by another rejected upload); two obligations
 * for the same `(submissionId, etag, sizeBytes)` are the same work.
 */
export interface AssignmentCleanupTarget {
    tenantId: string;
    assignmentId: string;
    enrollmentId: string;
    submissionId: string;
    /** Private, server-generated key. Re-parsed and re-bound before any delete. */
    storageKey: string;
    /** Exact version identity, compared byte-for-byte. Never trimmed. */
    etag: string;
    sizeBytes: number;
    reason: AssignmentCleanupReason;
}

const MAX_ETAG_LENGTH = 256;

/**
 * Validate and bind an obligation identity. Returns null when any part is not
 * provable, so a caller can never record (or later delete) a target whose key
 * does not bind to its own identifiers.
 *
 * The ETag is compared and stored **exactly**: no trim, no case folding, no
 * normalisation. An identity that is normalised on one side and not the other
 * stops being an identity.
 */
export function normalizeCleanupTarget(value: unknown): AssignmentCleanupTarget | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;

    const tenantId = normalizeId(record['tenantId']);
    const assignmentId = normalizeId(record['assignmentId']);
    const enrollmentId = normalizeId(record['enrollmentId']);
    const submissionId = normalizeId(record['submissionId']);
    if (!tenantId || !assignmentId || !enrollmentId || !submissionId) return null;

    const storageKey = typeof record['storageKey'] === 'string' ? record['storageKey'] : '';
    const parsed = parseSubmissionStorageKey(storageKey);
    if (!parsed) return null;
    if (parsed.tenantId !== tenantId
        || parsed.assignmentId !== assignmentId
        || parsed.enrollmentId !== enrollmentId
        || parsed.submissionId !== submissionId) {
        return null;
    }

    const etag = record['etag'];
    if (typeof etag !== 'string' || etag.length === 0 || etag.length > MAX_ETAG_LENGTH) return null;

    const sizeBytes = record['sizeBytes'];
    // Safe integer, not merely integer: an unsafe double is not a representable
    // byte count, and two distinct real sizes would collide on one value.
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;

    const reason = normalizeCleanupReason(record['reason']);
    if (!reason) return null;

    return {
        tenantId,
        assignmentId,
        enrollmentId,
        submissionId,
        storageKey,
        etag,
        sizeBytes,
        reason,
    };
}

/**
 * The exact-version delete input a validated target yields. Never a key-only delete.
 *
 * The ETag is carried RAW — untrimmed, uncase-folded, quotes intact. It is the
 * same bytes the obligation was recorded with and the same bytes the stat proof
 * was compared against, so the precondition names exactly one identity. An
 * earlier revision trimmed it here "so the check and the precondition agree";
 * that made them agree on a *normalized* value that no provider contract proves
 * denotes the same object, and `"e"` versus `"e "` — distinct under the exact
 * NO PAD contract — became one deletable identity.
 */
export const cleanupRemovalInput = (
    target: AssignmentCleanupTarget,
): { objectKey: string; etag: string; sizeBytes: number } => ({
    objectKey: target.storageKey,
    etag: target.etag,
    sizeBytes: target.sizeBytes,
});

/* ------------------------------------------------------------------------- */
/* Durable store contract                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The transaction handle an obligation write may join. Structurally identical
 * to the route's `AssignmentsDataAccess`, so a rejection or a cancellation can
 * record its obligation in the **same** unit of work as the state change (and
 * its audit event) without this module importing the route.
 *
 * `query` is part of the contract on purpose: the idempotent insert has to be
 * classified by reading the row back, and that read must happen on the same
 * transaction as the insert. A store that opened its own transaction for the
 * read-back would not be write-ahead atomic, no matter what the insert did.
 */
export interface AssignmentCleanupTx {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ affectedRows?: number; insertId?: number }>;
}

/** What the durable store answered for a `recordPending` call. */
export type AssignmentCleanupRecordOutcome =
    /** A new obligation row was inserted. */
    | 'recorded'
    /** The exact version already had an obligation; nothing was inserted. */
    | 'existing'
    /** The same submission already has a *different* version pending. */
    | 'conflict';

export interface AssignmentCleanupRecordResult {
    outcome: AssignmentCleanupRecordOutcome;
    /** Row id of the obligation (`null` only when the store cannot answer one). */
    id: string | null;
    /** Fence value read back with the row; required to complete it later. */
    claimVersion: number | null;
}

/** One durable obligation, as the store projects it. */
export interface AssignmentCleanupObligationRecord extends AssignmentCleanupTarget {
    id: string;
    state: AssignmentCleanupState;
    claimOwner: string | null;
    claimVersion: number;
    leaseUntilMs: number | null;
    attempts: number;
    lastFailure: AssignmentCleanupFailure | null;
    createdAtMs: number;
    updatedAtMs: number;
}

/**
 * Stable continuation position: the keyset pair `(created_at_ms, id)`. Never an
 * OFFSET — an offset skips work when earlier rows are completed between pages.
 */
export interface AssignmentCleanupCursor {
    createdAtMs: number;
    id: string;
}

export interface AssignmentCleanupClaimRequest {
    owner: string;
    nowMs: number;
    leaseUntilMs: number;
    limit: number;
    after: AssignmentCleanupCursor | null;
}

export interface AssignmentCleanupCompletionRequest {
    id: string;
    owner: string;
    claimVersion: number;
    nowMs: number;
    state: AssignmentCleanupTerminalState;
    proof: AssignmentCleanupProof;
}

export interface AssignmentCleanupReleaseRequest {
    id: string;
    owner: string;
    claimVersion: number;
    nowMs: number;
    failure: AssignmentCleanupFailure;
    retryAfterMs: number;
}

/** Completion of an obligation that was never claimed (recorded and settled in one request). */
export interface AssignmentCleanupUnclaimedCompletionRequest {
    id: string;
    claimVersion: number;
    nowMs: number;
    state: AssignmentCleanupTerminalState;
    proof: AssignmentCleanupProof;
}

/**
 * Why a durable obligation store cannot be used. A store that reports
 * `unavailable` must never be injected: the coordinator and the factory both
 * read this and refuse to claim, instead of falling back to something weaker
 * that would look durable.
 */
export type AssignmentCleanupStoreUnavailableReason =
    /** The obligation table/columns do not exist yet (schema not declared). */
    | 'schema-not-declared'
    /** The ETag identity column's collation is not proven NO PAD. */
    | 'etag-collation-unverified'
    /** The adapter cannot run one unit of work on one connection. */
    | 'transaction-capability-absent';

export interface AssignmentCleanupStoreAvailability {
    mode: 'durable' | 'unavailable';
    reason: AssignmentCleanupStoreUnavailableReason | null;
}

/**
 * A stored row that cannot be read as a valid obligation record.
 *
 * This is deliberately an error and not a defaulted value. The alternative —
 * coercing an unreadable `object_size_bytes` or `claim_version` to `0` — would
 * either fake a zero-byte object or reset a fence to version zero, and a version
 * zero is exactly what a request-path settlement matches on. A corrupt row must
 * therefore stop the caller *before* it claims, deletes or writes a verdict;
 * there is no safe value to substitute.
 *
 * `field` names the column (or `request.<name>` for a rejected request), and
 * `rowId` is the row's id when it could be read.
 */
export class AssignmentCleanupRowInvalidError extends Error {
    readonly code = 'invalid_row' as const;

    constructor(
        readonly field: string,
        readonly rowId: string | null,
    ) {
        super(
            `assignment cleanup obligation row is invalid: ${field}`
            + (rowId === null ? '' : ` (id ${rowId})`),
        );
        this.name = 'AssignmentCleanupRowInvalidError';
    }
}

export const isAssignmentCleanupRowInvalidError = (
    error: unknown,
): error is AssignmentCleanupRowInvalidError =>
    error instanceof AssignmentCleanupRowInvalidError;

/**
 * The durable obligation store. Every method is a bounded, fenced operation:
 *
 *  - `recordPending` is an idempotent insert on `(submission_id, object_etag,
 *    object_size_bytes)` and accepts the caller's transaction, so a rejection or
 *    cancellation and its obligation commit or roll back together;
 *  - `claimBatch` selects only `pending` rows whose claim is free or whose lease
 *    has expired, ordered by the keyset pair, and stamps owner + version + lease
 *    in one compare-and-set;
 *  - `completeClaim` / `releaseClaim` are fenced on `(id, owner, claim_version)`
 *    **and** an unexpired lease, and answer `false` when the fence is lost;
 *  - `completeUnclaimed` settles a row the request path recorded and finished
 *    without ever claiming it (CAS on `claim_owner IS NULL`).
 *
 * A store that cannot implement any of these must not be injected: an
 * in-process queue is not durable, and this module will not pretend otherwise.
 */
export interface AssignmentCleanupObligationStore {
    recordPending(target: AssignmentCleanupTarget, tx?: AssignmentCleanupTx): Promise<AssignmentCleanupRecordResult>;
    claimBatch(request: AssignmentCleanupClaimRequest): Promise<AssignmentCleanupObligationRecord[]>;
    completeClaim(request: AssignmentCleanupCompletionRequest): Promise<boolean>;
    releaseClaim(request: AssignmentCleanupReleaseRequest): Promise<boolean>;
    completeUnclaimed(request: AssignmentCleanupUnclaimedCompletionRequest): Promise<boolean>;
    /** Declared, never inferred. Absent is read as `durable` for a pure port. */
    availability?: AssignmentCleanupStoreAvailability;
}

/* ------------------------------------------------------------------------- */
/* Result contract                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Why a run ended early. A non-null value always means work may remain; it never
 * means the work that *was* done did not happen.
 */
export type AssignmentCleanupHaltReason =
    /** No durable store was injected: `cleanup-unconfigured`, nothing claimed. */
    | 'store_unconfigured'
    /** A store was injected but declares itself unusable (schema/collation/transaction). */
    | 'store_unavailable'
    /** The adapter cannot delete by exact version: nothing was claimed or deleted. */
    | 'capability_absent'
    /** `claimBatch` threw: the run stopped instead of guessing. */
    | 'claim_store_failed'
    /**
     * A row could not be read as a valid record (unparseable size/version/
     * timestamps, or a broken owner/lease pair). Distinct from
     * `claim_store_failed`: the store worked, the data is corrupt. Nothing was
     * claimed from that page and nothing was deleted.
     */
    | 'invalid_row'
    /** A completion/release CAS answered "not yours": our lease is stale, so the run stopped. */
    | 'claim_lost'
    /** `stop()` was called (before the run, or between pages/items). */
    | 'stopped'
    /** The wall-clock budget or the page/item cap was reached. */
    | 'budget_exhausted'
    /** A run is already in flight in this process. */
    | 'already_running';

export interface AssignmentCleanupCapability {
    /** Declared, never inferred: both the flag and the method must be present. */
    exactVersionDelete: 'supported' | 'unsupported';
    /** `configured` only when a durable store was injected. */
    durableStore: 'configured' | 'unconfigured';
    /**
     * The identity state this module exposes. It is ALWAYS `unverified`: no
     * approved durable per-row provenance contract exists, and no caller
     * declaration, enum, boolean, timestamp cutoff, or in-memory registry may
     * confer trust. A future approved contract (a held schema request for the
     * schema owner) would widen this deliberately; it is not a callable bypass.
     * While `unverified`, deletion is unavailable and every obligation stays
     * pending — see the provenance gate in `inspectAndDelete`.
     */
    recordVersionIdentity: 'unverified';
}

export interface AssignmentCleanupRunReport {
    halted: AssignmentCleanupHaltReason | null;
    /** Rows the store handed us across all pages. */
    claimed: number;
    /** Pages fetched (a page may be shorter than the limit on the last one). */
    pages: number;
    /** Rows actually inspected (`<= claimed`: a stop between pages leaves claims to expire). */
    items: number;
    /** Rows completed as `deleted`. */
    deleted: number;
    /** Rows completed as `superseded` (a replacement version survived). */
    superseded: number;
    /** Rows handed back to `pending` with a failure reason. */
    released: number;
    /** Fenced writes the store refused because the claim had moved on. */
    lostClaims: number;
    /** `items - deleted - superseded`: rows still owing work after this run. */
    pending: number;
    /** One entry per released obligation (bounded by `items`). */
    failures: Array<{ id: string; failure: AssignmentCleanupFailure }>;
    /**
     * Keyset position to resume from. `null` when the pending set was drained,
     * and also when the run halted before completing a single page (there is no
     * position to resume from yet — the next run starts at the beginning).
     */
    continuation: AssignmentCleanupCursor | null;
    elapsedMs: number;
    capability: AssignmentCleanupCapability;
}

const emptyReport = (
    halted: AssignmentCleanupHaltReason | null,
    capability: AssignmentCleanupCapability,
    elapsedMs = 0,
): AssignmentCleanupRunReport => ({
    halted,
    claimed: 0,
    pages: 0,
    items: 0,
    deleted: 0,
    superseded: 0,
    released: 0,
    lostClaims: 0,
    pending: 0,
    failures: [],
    continuation: null,
    elapsedMs,
    capability,
});

/* ------------------------------------------------------------------------- */
/* Coordinator                                                               */
/* ------------------------------------------------------------------------- */

export interface AssignmentCleanupRecoveryOptions {
    /** Absent ⇒ `cleanup-unconfigured`: the run refuses to claim or delete anything. */
    store?: AssignmentCleanupObligationStore;
    /** Absent ⇒ the adapter cannot prove a version, so nothing may be deleted. */
    objectStore?: AssignmentObjectStore;
    /** Stable claim owner. Defaults to a fresh UUID; injected for determinism. */
    owner?: string;
    newOwnerId?: () => string;
    now?: () => Date;
    pageSize?: number;
    maxPages?: number;
    maxItems?: number;
    runBudgetMs?: number;
    leaseMs?: number;
    retryDelayMs?: number;
    /** Observability hook. Must never be used to alter an outcome. */
    onError?: (error: unknown) => void;
}

export interface AssignmentCleanupRecovery {
    /** One bounded pass. Never schedules the next one. */
    runOnce(): Promise<AssignmentCleanupRunReport>;
    /** Cooperative stop: no new page or item starts; the in-flight delete finishes. */
    stop(): void;
    isStopped(): boolean;
    /** Declared capability, safe to read at any time (no I/O). */
    describeCapability(): AssignmentCleanupCapability;
}

/**
 * Build the coordinator. Construction performs no I/O, opens no timer, reads no
 * environment and claims nothing: a coordinator that is constructed and never
 * run is inert.
 */
export const createAssignmentCleanupRecovery = (
    options: AssignmentCleanupRecoveryOptions,
): AssignmentCleanupRecovery => {
    const store = options.store;
    const objectStore = options.objectStore;
    const now = options.now ?? ((): Date => new Date());
    const owner = options.owner ?? (options.newOwnerId ?? ((): string => randomUUID()))();
    const pageSize = clampCleanupPageSize(options.pageSize);
    const maxPages = clampCleanupMaxPages(options.maxPages);
    const maxItems = clampCleanupMaxItems(options.maxItems);
    const runBudgetMs = clampCleanupRunBudgetMs(options.runBudgetMs);
    /**
     * The lease must cover the whole run budget, not just one page.
     *
     * The item loop is bounded by `runBudgetMs`, so a lease shorter than the
     * budget expires while this run is still inspecting the page it stamped.
     * A second coordinator then sees `lease_until_ms <= now` and claims the same
     * rows; both runs act on the same exact version and this run's later
     * `completeClaim`/`releaseClaim` answer `false`, which is reported as
     * `claim_lost` — a race this process caused, not one it observed.
     *
     * Neither clamp enforces this on its own: `clampCleanupLeaseMs` accepts
     * 5 s–5 min and `clampCleanupRunBudgetMs` accepts 1 ms–30 s, so
     * `leaseMs < runBudgetMs` is reachable through the composition root. The
     * invariant documented on `DEFAULT_CLEANUP_LEASE_MS` ("this only has to
     * cover it") is therefore enforced here, in the only direction that keeps
     * work owned: widen the lease, never shorten the budget. The result stays
     * inside `MAX_CLEANUP_LEASE_MS`, which is what `claimBatch` validates.
     */
    // This is an admission-budget bound, not an I/O deadline. An awaited store
    // or provider call may outlive the lease; expiry/CAS still decides ownership.
    // Never infer cancellation, exclusive execution or operational fencing from
    // Math.max alone. Provenance remains unverified before destructive work.
    const leaseMs = Math.max(clampCleanupLeaseMs(options.leaseMs), runBudgetMs);
    const retryDelayMs = clampRetryDelayMs(options.retryDelayMs);
    const onError = options.onError;

    let running = false;
    let stopped = false;

    const report = (error: unknown): void => {
        if (!onError) return;
        try {
            onError(error);
        } catch {
            // An observability hook must never change the outcome of a run.
        }
    };

    const capability = (): AssignmentCleanupCapability => ({
        exactVersionDelete: objectStore && supportsExactVersionRemoval(objectStore) ? 'supported' : 'unsupported',
        durableStore: store ? 'configured' : 'unconfigured',
        // Always `unverified`: no approved durable provenance contract exists.
        recordVersionIdentity: 'unverified',
    });

    /** Deterministic exponential retry delay; bounded, never random. */
    const retryAfterFor = (attempts: number): number => {
        const exponent = Math.min(Math.max(attempts, 1) - 1, 16);
        return Math.min(MAX_CLEANUP_RETRY_DELAY_MS, retryDelayMs * 2 ** exponent);
    };

    type ItemOutcome =
        | { kind: 'deleted'; proof: AssignmentCleanupProof }
        | { kind: 'superseded'; proof: AssignmentCleanupProof }
        | { kind: 'released'; failure: AssignmentCleanupFailure }
        | { kind: 'lost'; failure: AssignmentCleanupFailure };

    /**
     * PAD SPACE semantics (MySQL `utf8mb4_bin`, PAD SPACE collation): trailing
     * 0x20 spaces are IGNORED IN COMPARISON only — the stored bytes are NOT
     * trimmed. `"e"` and `"e "` compare equal even though they are distinct byte
     * sequences. This is why a legacy recorded ETag cannot be proven to be the
     * exact version: a raw mismatch could be a genuine replacement OR merely a
     * PAD SPACE comparison artifact, and equality in comparison does not tell us
     * which. We therefore never infer provenance from a collation; an explicit,
     * attested exact-version contract is required — see the provenance gate in
     * `inspectAndDelete`.
     */

    /**
     * Validate the record, then REFUSE to act on its identity.
     *
     * No approved durable per-row provenance contract exists, so every
     * obligation is unproven. We validate the target binding and the claim state
     * (a drifted row or a non-pending row is never acted on), then release the
     * record as `legacy_etag_unprovable` BEFORE any stat, absent-object
     * inference, superseded verdict, conditional delete, or terminal settlement.
     * The row stays `pending`; deletion is unavailable.
     */
    const inspectAndDelete = async (
        record: AssignmentCleanupObligationRecord,
    ): Promise<ItemOutcome> => {
        const target = normalizeCleanupTarget(record);
        if (!target) return { kind: 'released', failure: 'binding_mismatch' };
        // The fence value must be usable; a store that reports a non-pending row
        // for a claim has a bug, and guessing would be worse than releasing.
        if (record.state !== 'pending') return { kind: 'released', failure: 'record_state_invalid' };

        // PROVENANCE GATE (unconditional today). No approved durable, per-row
        // provenance contract exists, so EVERY obligation is unproven. We
        // release it here — BEFORE statObject, before any absent-object
        // inference, before a superseded verdict, before a conditional delete,
        // and before any terminal settlement — and leave it `pending`.
        //
        // Why nothing weaker is sound:
        //  - Equal raw ETags do NOT authorize a delete. A legacy stored value
        //    that was PAD SPACE-compared can equal the live replacement once the
        //    original trailing space "disappears" in comparison, so equality
        //    cannot prove the live bytes ARE the recorded version.
        //  - Unequal raw ETags do NOT authorize a `superseded` verdict; the
        //    difference may be a PAD SPACE comparison artifact of the same
        //    recorded version.
        //  - An absent object at the key does NOT prove all historical versions
        //    are absent on versioned storage, so `pre_stat_absent` is not a
        //    valid completion either.
        //  - A NO PAD collation today proves comparison semantics only; it says
        //    nothing about how a historical row was physically written.
        //
        // No caller declaration, enum, boolean, timestamp cutoff, or in-memory
        // registry may confer trust (all rejected). A durable per-row provenance
        // contract is a HELD SCHEMA REQUEST for the schema owner (exact
        // migration + backfill verification; no DDL from this lane). Until it is
        // approved and implemented, deletion is UNAVAILABLE and every obligation
        // stays pending. See
        // docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md.
        return { kind: 'released', failure: 'legacy_etag_unprovable' };
    };

    const runOnce = async (): Promise<AssignmentCleanupRunReport> => {
        const startedAtMs = now().getTime();
        const caps = capability();
        if (running) return emptyReport('already_running', caps);
        if (stopped) return emptyReport('stopped', caps);
        if (!store) return emptyReport('store_unconfigured', caps);
        // An injected store that declares itself unusable is not a weaker store;
        // it is no store. Never claim through it, and never fall back silently.
        if (store.availability?.mode === 'unavailable') return emptyReport('store_unavailable', caps);
        if (caps.exactVersionDelete !== 'supported' || !objectStore) {
            // Claiming an obligation we cannot act on would burn a lease and
            // bump an attempt counter for nothing. Refuse before any write.
            return emptyReport('capability_absent', caps);
        }

        running = true;
        let claimed = 0;
        let pages = 0;
        let items = 0;
        let deleted = 0;
        let superseded = 0;
        let released = 0;
        let lostClaims = 0;
        const failures: Array<{ id: string; failure: AssignmentCleanupFailure }> = [];
        let cursor: AssignmentCleanupCursor | null = null;
        let drained = false;
        let halted: AssignmentCleanupHaltReason | null = null;

        try {
            for (;;) {
                if (stopped) { halted = 'stopped'; break; }
                if (pages >= maxPages || items >= maxItems) { halted = 'budget_exhausted'; break; }
                const elapsed = now().getTime() - startedAtMs;
                if (elapsed >= runBudgetMs) { halted = 'budget_exhausted'; break; }

                const limit = Math.min(pageSize, maxItems - items);
                if (limit <= 0) { halted = 'budget_exhausted'; break; }

                let page: AssignmentCleanupObligationRecord[];
                try {
                    const claimNowMs = now().getTime();
                    page = await store.claimBatch({
                        owner,
                        nowMs: claimNowMs,
                        leaseUntilMs: claimNowMs + leaseMs,
                        limit,
                        after: cursor,
                    });
                } catch (error) {
                    report(error);
                    // A corrupt row is a data fault, not a store fault: the page
                    // transaction rolled back, so nothing was claimed.
                    halted = isAssignmentCleanupRowInvalidError(error) ? 'invalid_row' : 'claim_store_failed';
                    break;
                }
                pages += 1;
                claimed += page.length;
                if (page.length === 0) { drained = true; break; }

                for (const record of page) {
                    if (stopped) { halted = 'stopped'; break; }
                    // The budget is enforced PER ITEM, not only per page. A page
                    // holds up to `pageSize` external stat+delete round-trips, so
                    // checking only at the page boundary let one page run far
                    // past the run budget it was stamped with — a second
                    // coordinator then claimed the same rows while this run was
                    // still deleting them, and its later settlements were
                    // reported as lost claims. The lease side of that is now a
                    // precondition of this loop rather than an assumption: the
                    // effective lease is never shorter than the budget (see
                    // `leaseMs`), so every item that starts here starts under a
                    // live lease. Safety was preserved incidentally by the
                    // store's precondition; the accounting was not honest.
                    const itemElapsed = now().getTime() - startedAtMs;
                    if (itemElapsed >= runBudgetMs) { halted = 'budget_exhausted'; break; }
                    items += 1;
                    const outcome = await inspectAndDelete(record);
                    if (outcome.kind === 'deleted' || outcome.kind === 'superseded') {
                        let settled = false;
                        try {
                            settled = await store.completeClaim({
                                id: record.id,
                                owner,
                                claimVersion: record.claimVersion,
                                nowMs: now().getTime(),
                                state: cleanupStateForProof(outcome.proof),
                                proof: outcome.proof,
                            });
                        } catch (error) {
                            report(error);
                            // A corrupt row must not be reported as a lost claim:
                            // our lease may be perfectly intact, and the caller
                            // needs to know the data is the problem.
                            if (isAssignmentCleanupRowInvalidError(error)) {
                                halted = 'invalid_row';
                                break;
                            }
                            // Any OTHER throw means the CAS was never attempted:
                            // the store failed, it did not refuse our fence. The
                            // row is still ours and still pending, so reporting
                            // `claim_lost` here described a race that never
                            // happened. It is a store failure and the run halts.
                            halted = 'claim_store_failed';
                            break;
                        }
                        if (settled) {
                            if (outcome.kind === 'deleted') deleted += 1;
                            else superseded += 1;
                        } else {
                            // The fence is gone: our lease was taken. Continuing
                            // would let a stale run keep writing.
                            lostClaims += 1;
                            halted = 'claim_lost';
                            break;
                        }
                        continue;
                    }
                    let handedBack = false;
                    try {
                        handedBack = await store.releaseClaim({
                            id: record.id,
                            owner,
                            claimVersion: record.claimVersion,
                            nowMs: now().getTime(),
                            failure: outcome.failure,
                            retryAfterMs: retryAfterFor(record.attempts + 1),
                        });
                    } catch (error) {
                        report(error);
                        if (isAssignmentCleanupRowInvalidError(error)) {
                            halted = 'invalid_row';
                            break;
                        }
                        // Same rule as the completion path: a store throw is not
                        // a lost fence. The claim was never attempted, so the
                        // row is still ours and still pending.
                        halted = 'claim_store_failed';
                        break;
                    }
                    if (handedBack) {
                        released += 1;
                        failures.push({ id: record.id, failure: outcome.failure });
                    } else {
                        lostClaims += 1;
                        halted = 'claim_lost';
                        break;
                    }
                }
                if (halted !== null) break;

                const last = page[page.length - 1];
                cursor = { createdAtMs: last.createdAtMs, id: last.id };
                if (page.length < limit) { drained = true; break; }
            }
        } finally {
            running = false;
        }

        return {
            halted,
            claimed,
            pages,
            items,
            deleted,
            superseded,
            released,
            lostClaims,
            pending: items - deleted - superseded,
            failures,
            continuation: drained ? null : cursor,
            elapsedMs: now().getTime() - startedAtMs,
            capability: caps,
        };
    };

    return {
        runOnce,
        stop: (): void => { stopped = true; },
        isStopped: (): boolean => stopped,
        describeCapability: capability,
    };
};

/* ------------------------------------------------------------------------- */
/* Request-path recording (write-ahead)                                      */
/* ------------------------------------------------------------------------- */

/**
 * What the request path could do about an obligation before it attempted a
 * delete. `unconfigured` means no durable store was injected; `record_failed`
 * means one was injected and the write did not land.
 */
export type AssignmentCleanupRecording =
    | 'recorded'
    | 'existing'
    | 'conflict'
    /** No durable store was injected. */
    | 'unconfigured'
    /** A store was injected and the write did not land. */
    | 'record_failed'
    /**
     * The store answered, but the stored row cannot be read as a valid record.
     * The caller must delete nothing: the obligation's state is unprovable.
     */
    | 'store_invalid_row'
    /** A store was injected but declares itself unusable: nothing was written. */
    | 'store_unavailable'
    /**
     * No target was supplied, so no obligation was written: the identity did
     * not bind (see `normalizeCleanupTarget`). Distinct from `unconfigured`,
     * which means *no store was injected* — a caller treats `unconfigured` as
     * the legacy path that may delete without a write-ahead row, so an unbound
     * target must never borrow that value. Nothing may be deleted.
     */
    | 'invalid_target';

/**
 * The handle the request path keeps between recording an obligation and
 * settling it: the store's answer plus the fence (`id` + `claimVersion`) needed
 * to complete it.
 */
export interface AssignmentCleanupHandle {
    id: string | null;
    claimVersion: number | null;
    recording: AssignmentCleanupRecording;
}

/**
 * The handle for "no obligation was recorded **because no durable store was
 * injected**". Only that case: a store that *was* injected but given no bound
 * target answers `invalid_target`, so it can never be read as this
 * delete-permitting legacy path.
 */
export const UNRECORDED_CLEANUP_HANDLE: AssignmentCleanupHandle = {
    id: null,
    claimVersion: null,
    recording: 'unconfigured',
};

/**
 * Record the obligation **before** the bytes are touched, so a crash between the
 * external delete and the DB write leaves a durable row instead of a log line.
 *
 * A `conflict` answer means the same submission already owes cleanup for a
 * different version. That is not an error — the older obligation is still
 * pending — but this call must not claim the new version was queued, so the
 * caller is expected to leave the delete to the coordinator.
 *
 * When `tx` is provided the insert joins the caller's transaction and a failure
 * **propagates**: a rejection/cancellation must roll back rather than commit
 * without its obligation. Without `tx` the insert runs on its own and a failure
 * is reported as `record_failed`, which the caller must treat as "do not delete"
 * (the write-ahead property would be lost).
 */
export const recordCleanupObligation = async (
    store: AssignmentCleanupObligationStore | undefined,
    target: AssignmentCleanupTarget | null,
    tx?: AssignmentCleanupTx,
): Promise<AssignmentCleanupHandle> => {
    if (!store) return UNRECORDED_CLEANUP_HANDLE;
    // A store was injected and no target was: the identity did not bind. Answer
    // `invalid_target`, never `unconfigured`. `unconfigured` is the one value a
    // caller reads as "the legacy path may delete without a write-ahead row",
    // so returning it here would let an unbound version be deleted with no
    // obligation recorded at all — the exact write-ahead property this function
    // exists to provide.
    if (!target) return { id: null, claimVersion: null, recording: 'invalid_target' };
    // An injected durable store failing availability cannot silently drop the
    // write-ahead obligation from a cancellation/verdict transaction.
    if (store.availability?.mode === 'unavailable') {
        if (tx) throw new Error('Assignment cleanup obligation store is unavailable');
        return { id: null, claimVersion: null, recording: 'store_unavailable' };
    }
    const toHandle = (result: AssignmentCleanupRecordResult): AssignmentCleanupHandle => ({
        id: result.id,
        claimVersion: result.claimVersion,
        recording: result.outcome,
    });
    if (tx) return toHandle(await store.recordPending(target, tx));
    try {
        return toHandle(await store.recordPending(target));
    } catch (error) {
        // A corrupt row means we cannot say whether this version is already owed.
        // Report it as its own reason so the caller's log names the real cause,
        // but the answer is the same either way: delete nothing.
        return {
            id: null,
            claimVersion: null,
            recording: isAssignmentCleanupRowInvalidError(error) ? 'store_invalid_row' : 'record_failed',
        };
    }
};

/**
 * Settle an obligation the request path recorded and finished itself. The CAS
 * is on `claim_owner IS NULL`, so a coordinator that already claimed the row
 * wins and this call is a harmless no-op.
 *
 * Returns false when the settlement did not land; the row then stays `pending`
 * and the coordinator will replay it (and re-derive the same terminal state from
 * the store's own answer).
 */
export const settleRecordedCleanup = async (
    store: AssignmentCleanupObligationStore | undefined,
    handle: AssignmentCleanupHandle,
    proof: AssignmentCleanupProof,
    nowMs: number,
): Promise<boolean> => {
    if (!store || handle.id === null || handle.claimVersion === null) return false;
    try {
        return await store.completeUnclaimed({
            id: handle.id,
            claimVersion: handle.claimVersion,
            nowMs,
            state: cleanupStateForProof(proof),
            proof,
        });
    } catch {
        return false;
    }
};

/**
 * Map a capability-gated delete answer to a completion proof. `unsupported` and
 * `failed` produce no proof: those are pending work, not a terminal state.
 */
export const cleanupProofForRemoval = (cleanup: QuarantineCleanup): AssignmentCleanupProof | null => {
    switch (cleanup) {
        case 'removed': return 'store_removed';
        case 'already_absent': return 'store_already_absent';
        case 'version_replaced': return 'store_version_replaced';
        case 'unsupported':
        case 'failed':
        default:
            return null;
    }
};

/* ------------------------------------------------------------------------- */
/* Bounded, tenant-scoped orphan *planning* (no deletion)                     */
/* ------------------------------------------------------------------------- */

/** Objects listed per page while planning. */
export const DEFAULT_ORPHAN_PAGE_SIZE = 50;
export const MAX_ORPHAN_PAGE_SIZE = 200;
/** Pages inspected per planning call. */
export const DEFAULT_ORPHAN_MAX_PAGES = 2;
export const MAX_ORPHAN_MAX_PAGES = 20;

/**
 * A tenant-scoped object listing. The adapter is asked for a prefix the planner
 * derives itself (`tenants/{tenantId}/assignments/`), and every returned key is
 * re-parsed and rejected when it belongs to another tenant — so a listing bug
 * can never widen the plan beyond one tenant.
 */
export interface AssignmentObjectListing {
    listTenantObjects(request: {
        tenantId: string;
        prefix: string;
        after: string | null;
        limit: number;
    }): Promise<Array<{ objectKey: string; version: BoundObjectVersion | null; lastModifiedMs: number }>>;
}

/** Row lookup used to decide whether an object still belongs to a submission. */
export interface AssignmentSubmissionLookup {
    hasSubmissionForVersion(request: {
        tenantId: string;
        submissionId: string;
        etag: string;
        sizeBytes: number;
    }): Promise<boolean>;
}

export interface AssignmentOrphanPlan {
    tenantId: string;
    /** Derived prefix, echoed so a caller can see exactly what was listed. */
    prefix: string;
    /** Objects returned by the listing across pages. */
    inspected: number;
    /** Objects with no matching row for their exact version. Nothing is deleted. */
    candidates: Array<{
        objectKey: string;
        version: BoundObjectVersion;
        lastModifiedMs: number;
        reason: 'no-matching-row';
    }>;
    /** Objects skipped because their key did not bind to the requested tenant. */
    rejectedKeys: number;
    /** Objects without a provable version (never a deletion candidate). */
    unboundVersions: number;
    halted:
        | 'invalid_tenant'
        | 'listing_unconfigured'
        | 'lookup_unconfigured'
        | 'listing_failed'
        | 'lookup_failed'
        /** The retention cutoff or an object timestamp was unusable (e.g. NaN). */
        | 'invalid_retention_cutoff'
        | 'budget_exhausted'
        | null;
    /** True when the page cap or the caller's cutoff stopped the scan early. */
    truncated: boolean;
}

export interface AssignmentOrphanPlanRequest {
    tenantId: string;
    /**
     * Only objects last modified strictly before this instant are considered.
     * Required, with no default: a retention window is a deployment policy, and
     * inventing one here would silently authorize deletions nobody agreed to.
     */
    notModifiedSinceMs: number;
    pageSize?: number;
    maxPages?: number;
}

/**
 * Plan — never perform — orphan reconciliation for **one tenant**.
 *
 * This function issues no delete of any kind, has no bucket-wide count, and
 * cannot address a key outside `tenants/{tenantId}/assignments/`. It exists so
 * the "objects nobody owns" class is inspectable without a destructive sweep:
 * the deletion step needs a retention decision that belongs to the deployment
 * (see the delivery doc), not to this module.
 */
export const planTenantOrphanReconciliation = async (
    deps: { listing?: AssignmentObjectListing; lookup?: AssignmentSubmissionLookup; onError?: (error: unknown) => void },
    request: AssignmentOrphanPlanRequest,
): Promise<AssignmentOrphanPlan> => {
    const tenantId = normalizeId(request.tenantId);
    const prefix = tenantId === null ? '' : `tenants/${tenantId}/assignments/`;
    const pageSize = clampInt(request.pageSize, DEFAULT_ORPHAN_PAGE_SIZE, 1, MAX_ORPHAN_PAGE_SIZE);
    const maxPages = clampInt(request.maxPages, DEFAULT_ORPHAN_MAX_PAGES, 1, MAX_ORPHAN_MAX_PAGES);
    const plan: AssignmentOrphanPlan = {
        tenantId: tenantId ?? '',
        prefix,
        inspected: 0,
        candidates: [],
        rejectedKeys: 0,
        unboundVersions: 0,
        halted: null,
        truncated: false,
    };
    if (tenantId === null) {
        plan.halted = 'invalid_tenant';
        return plan;
    }
    if (!deps.listing) { plan.halted = 'listing_unconfigured'; return plan; }
    if (!deps.lookup) { plan.halted = 'lookup_unconfigured'; return plan; }
    const listing = deps.listing;
    const lookup = deps.lookup;
    const report = (error: unknown): void => {
        if (!deps.onError) return;
        try {
            deps.onError(error);
        } catch {
            // never alter the plan
        }
    };

    let after: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
        let objects: Awaited<ReturnType<AssignmentObjectListing['listTenantObjects']>>;
        try {
            objects = await listing.listTenantObjects({ tenantId, prefix, after, limit: pageSize });
        } catch (error) {
            report(error);
            plan.halted = 'listing_failed';
            return plan;
        }
        plan.inspected += objects.length;
        for (const object of objects) {
            const parsed = parseSubmissionStorageKey(object.objectKey);
            if (!parsed || parsed.tenantId !== tenantId) {
                plan.rejectedKeys += 1;
                continue;
            }
            if (!object.version) { plan.unboundVersions += 1; continue; }
            // A `NaN` cutoff makes every comparison false, which silently
            // disables the retention filter and candidates every unowned object
            // regardless of age. Planning-only — no delete is issued — but the
            // filter must mean what it says, so an unusable cutoff stops the
            // plan instead of widening it.
            if (!Number.isFinite(request.notModifiedSinceMs) || !Number.isFinite(object.lastModifiedMs)) {
                plan.halted = 'invalid_retention_cutoff';
                return plan;
            }
            if (object.lastModifiedMs >= request.notModifiedSinceMs) continue;
            let owned: boolean;
            try {
                owned = await lookup.hasSubmissionForVersion({
                    tenantId,
                    submissionId: parsed.submissionId,
                    etag: object.version.etag,
                    sizeBytes: object.version.sizeBytes,
                });
            } catch (error) {
                report(error);
                plan.halted = 'lookup_failed';
                return plan;
            }
            if (owned) continue;
            plan.candidates.push({
                objectKey: object.objectKey,
                version: object.version,
                lastModifiedMs: object.lastModifiedMs,
                reason: 'no-matching-row',
            });
        }
        if (objects.length < pageSize) return plan;
        after = objects[objects.length - 1].objectKey;
        if (page === maxPages - 1) plan.truncated = true;
    }
    return plan;
};
