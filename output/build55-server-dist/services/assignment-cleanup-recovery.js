"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.planTenantOrphanReconciliation = exports.MAX_ORPHAN_MAX_PAGES = exports.DEFAULT_ORPHAN_MAX_PAGES = exports.MAX_ORPHAN_PAGE_SIZE = exports.DEFAULT_ORPHAN_PAGE_SIZE = exports.cleanupProofForRemoval = exports.settleRecordedCleanup = exports.recordCleanupObligation = exports.UNRECORDED_CLEANUP_HANDLE = exports.createAssignmentCleanupRecovery = exports.isAssignmentCleanupRowInvalidError = exports.AssignmentCleanupRowInvalidError = exports.cleanupRemovalInput = exports.cleanupStateForProof = exports.ASSIGNMENT_CLEANUP_PROOFS = exports.ASSIGNMENT_CLEANUP_FAILURES = exports.ASSIGNMENT_CLEANUP_STATES = exports.clampCleanupLeaseMs = exports.clampCleanupRunBudgetMs = exports.clampCleanupMaxItems = exports.clampCleanupMaxPages = exports.clampCleanupPageSize = exports.MAX_CLEANUP_RETRY_DELAY_MS = exports.DEFAULT_CLEANUP_RETRY_DELAY_MS = exports.MAX_CLEANUP_OWNER_LENGTH = exports.MAX_CLEANUP_LEASE_MS = exports.MIN_CLEANUP_LEASE_MS = exports.DEFAULT_CLEANUP_LEASE_MS = exports.MAX_CLEANUP_RUN_BUDGET_MS = exports.DEFAULT_CLEANUP_RUN_BUDGET_MS = exports.MAX_CLEANUP_MAX_ITEMS = exports.DEFAULT_CLEANUP_MAX_ITEMS = exports.MAX_CLEANUP_MAX_PAGES = exports.DEFAULT_CLEANUP_MAX_PAGES = exports.MAX_CLEANUP_PAGE_SIZE = exports.DEFAULT_CLEANUP_PAGE_SIZE = void 0;
exports.normalizeCleanupTarget = normalizeCleanupTarget;
const crypto_1 = require("crypto");
const assignment_storage_1 = require("./assignment-storage");
const assignments_1 = require("./assignments");
/* ------------------------------------------------------------------------- */
/* Bounds                                                                    */
/* ------------------------------------------------------------------------- */
/** Obligations claimed per page when nothing is configured. */
exports.DEFAULT_CLEANUP_PAGE_SIZE = 10;
/** Hard ceiling on one page; an over-large configuration is clamped, never honoured. */
exports.MAX_CLEANUP_PAGE_SIZE = 50;
/** Pages per run when nothing is configured. */
exports.DEFAULT_CLEANUP_MAX_PAGES = 4;
exports.MAX_CLEANUP_MAX_PAGES = 20;
/** Obligations inspected per run when nothing is configured. */
exports.DEFAULT_CLEANUP_MAX_ITEMS = 25;
exports.MAX_CLEANUP_MAX_ITEMS = 200;
/** Wall-clock budget for one run (external deletes are the slow part). */
exports.DEFAULT_CLEANUP_RUN_BUDGET_MS = 5000;
exports.MAX_CLEANUP_RUN_BUDGET_MS = 30000;
/**
 * Claim lease. A run never takes longer than its budget, so this only has to
 * cover it — and `createAssignmentCleanupRecovery` enforces that by raising the
 * effective lease to the run budget, because the two clamps are independent and
 * a shorter configured lease would expire under a live run.
 */
exports.DEFAULT_CLEANUP_LEASE_MS = 30000;
exports.MIN_CLEANUP_LEASE_MS = 5000;
exports.MAX_CLEANUP_LEASE_MS = 300000;
/**
 * Width of the `claim_owner` column (`VARCHAR(64)` in the durable schema). The
 * owner is both stored by the claim and matched by the completion/release
 * fence, so an owner longer than the column cannot round-trip: under a
 * non-strict server the claim would be truncated and every later fence would
 * compare the full value against the stored prefix and answer "not yours",
 * leaving the row leased until expiry. The bound is derived from the schema,
 * not chosen here.
 */
exports.MAX_CLEANUP_OWNER_LENGTH = 64;
/**
 * Retry scheduling for a released obligation (deterministic exponential, never
 * random). This is a *retry delay*, not a retention window: it decides when a
 * still-pending obligation becomes claimable again, and it is capped so a
 * permanently failing row cannot be hammered.
 */
exports.DEFAULT_CLEANUP_RETRY_DELAY_MS = 1000;
exports.MAX_CLEANUP_RETRY_DELAY_MS = 60000;
const clampInt = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};
const clampCleanupPageSize = (configured) => clampInt(configured, exports.DEFAULT_CLEANUP_PAGE_SIZE, 1, exports.MAX_CLEANUP_PAGE_SIZE);
exports.clampCleanupPageSize = clampCleanupPageSize;
const clampCleanupMaxPages = (configured) => clampInt(configured, exports.DEFAULT_CLEANUP_MAX_PAGES, 1, exports.MAX_CLEANUP_MAX_PAGES);
exports.clampCleanupMaxPages = clampCleanupMaxPages;
const clampCleanupMaxItems = (configured) => clampInt(configured, exports.DEFAULT_CLEANUP_MAX_ITEMS, 1, exports.MAX_CLEANUP_MAX_ITEMS);
exports.clampCleanupMaxItems = clampCleanupMaxItems;
const clampCleanupRunBudgetMs = (configured) => clampInt(configured, exports.DEFAULT_CLEANUP_RUN_BUDGET_MS, 1, exports.MAX_CLEANUP_RUN_BUDGET_MS);
exports.clampCleanupRunBudgetMs = clampCleanupRunBudgetMs;
const clampCleanupLeaseMs = (configured) => clampInt(configured, exports.DEFAULT_CLEANUP_LEASE_MS, exports.MIN_CLEANUP_LEASE_MS, exports.MAX_CLEANUP_LEASE_MS);
exports.clampCleanupLeaseMs = clampCleanupLeaseMs;
const clampRetryDelayMs = (configured) => clampInt(configured, exports.DEFAULT_CLEANUP_RETRY_DELAY_MS, 0, exports.MAX_CLEANUP_RETRY_DELAY_MS);
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
exports.ASSIGNMENT_CLEANUP_STATES = ['pending', 'deleted', 'superseded'];
/**
 * Why an obligation was handed back to `pending`. Closed union: a free-form
 * reason string would let a store record a failure nobody can classify later.
 * A lost claim is deliberately **not** a failure here — the row is not written
 * at all in that case, it simply returns to `pending` when its lease expires.
 */
exports.ASSIGNMENT_CLEANUP_FAILURES = [
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
];
/**
 * What proved a terminal state. Recorded verbatim so a later reader can tell a
 * store-confirmed deletion from our own stat, and a deletion from a refusal.
 */
exports.ASSIGNMENT_CLEANUP_PROOFS = [
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
];
const DELETED_PROOFS = new Set([
    'store_removed',
    'store_already_absent',
    'pre_stat_absent',
]);
/** The terminal state a proof establishes. */
const cleanupStateForProof = (proof) => (DELETED_PROOFS.has(proof) ? 'deleted' : 'superseded');
exports.cleanupStateForProof = cleanupStateForProof;
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
function normalizeCleanupTarget(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    const tenantId = (0, assignments_1.normalizeId)(record['tenantId']);
    const assignmentId = (0, assignments_1.normalizeId)(record['assignmentId']);
    const enrollmentId = (0, assignments_1.normalizeId)(record['enrollmentId']);
    const submissionId = (0, assignments_1.normalizeId)(record['submissionId']);
    if (!tenantId || !assignmentId || !enrollmentId || !submissionId)
        return null;
    const storageKey = typeof record['storageKey'] === 'string' ? record['storageKey'] : '';
    const parsed = (0, assignment_storage_1.parseSubmissionStorageKey)(storageKey);
    if (!parsed)
        return null;
    if (parsed.tenantId !== tenantId
        || parsed.assignmentId !== assignmentId
        || parsed.enrollmentId !== enrollmentId
        || parsed.submissionId !== submissionId) {
        return null;
    }
    const etag = record['etag'];
    if (typeof etag !== 'string' || etag.length === 0 || etag.length > MAX_ETAG_LENGTH)
        return null;
    const sizeBytes = record['sizeBytes'];
    // Safe integer, not merely integer: an unsafe double is not a representable
    // byte count, and two distinct real sizes would collide on one value.
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)
        return null;
    const reason = (0, assignments_1.normalizeCleanupReason)(record['reason']);
    if (!reason)
        return null;
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
const cleanupRemovalInput = (target) => ({
    objectKey: target.storageKey,
    etag: target.etag,
    sizeBytes: target.sizeBytes,
});
exports.cleanupRemovalInput = cleanupRemovalInput;
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
class AssignmentCleanupRowInvalidError extends Error {
    constructor(field, rowId) {
        super(`assignment cleanup obligation row is invalid: ${field}`
            + (rowId === null ? '' : ` (id ${rowId})`));
        this.field = field;
        this.rowId = rowId;
        this.code = 'invalid_row';
        this.name = 'AssignmentCleanupRowInvalidError';
    }
}
exports.AssignmentCleanupRowInvalidError = AssignmentCleanupRowInvalidError;
const isAssignmentCleanupRowInvalidError = (error) => error instanceof AssignmentCleanupRowInvalidError;
exports.isAssignmentCleanupRowInvalidError = isAssignmentCleanupRowInvalidError;
const emptyReport = (halted, capability, elapsedMs = 0) => ({
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
/**
 * Build the coordinator. Construction performs no I/O, opens no timer, reads no
 * environment and claims nothing: a coordinator that is constructed and never
 * run is inert.
 */
const createAssignmentCleanupRecovery = (options) => {
    const store = options.store;
    const objectStore = options.objectStore;
    const now = options.now ?? (() => new Date());
    const owner = options.owner ?? (options.newOwnerId ?? (() => (0, crypto_1.randomUUID)()))();
    const pageSize = (0, exports.clampCleanupPageSize)(options.pageSize);
    const maxPages = (0, exports.clampCleanupMaxPages)(options.maxPages);
    const maxItems = (0, exports.clampCleanupMaxItems)(options.maxItems);
    const runBudgetMs = (0, exports.clampCleanupRunBudgetMs)(options.runBudgetMs);
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
    const leaseMs = Math.max((0, exports.clampCleanupLeaseMs)(options.leaseMs), runBudgetMs);
    const retryDelayMs = clampRetryDelayMs(options.retryDelayMs);
    const onError = options.onError;
    let running = false;
    let stopped = false;
    const report = (error) => {
        if (!onError)
            return;
        try {
            onError(error);
        }
        catch {
            // An observability hook must never change the outcome of a run.
        }
    };
    const capability = () => ({
        exactVersionDelete: objectStore && (0, assignment_storage_1.supportsExactVersionRemoval)(objectStore) ? 'supported' : 'unsupported',
        durableStore: store ? 'configured' : 'unconfigured',
        // Always `unverified`: no approved durable provenance contract exists.
        recordVersionIdentity: 'unverified',
    });
    /** Deterministic exponential retry delay; bounded, never random. */
    const retryAfterFor = (attempts) => {
        const exponent = Math.min(Math.max(attempts, 1) - 1, 16);
        return Math.min(exports.MAX_CLEANUP_RETRY_DELAY_MS, retryDelayMs * 2 ** exponent);
    };
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
    const inspectAndDelete = async (record) => {
        const target = normalizeCleanupTarget(record);
        if (!target)
            return { kind: 'released', failure: 'binding_mismatch' };
        // The fence value must be usable; a store that reports a non-pending row
        // for a claim has a bug, and guessing would be worse than releasing.
        if (record.state !== 'pending')
            return { kind: 'released', failure: 'record_state_invalid' };
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
    const runOnce = async () => {
        const startedAtMs = now().getTime();
        const caps = capability();
        if (running)
            return emptyReport('already_running', caps);
        if (stopped)
            return emptyReport('stopped', caps);
        if (!store)
            return emptyReport('store_unconfigured', caps);
        // An injected store that declares itself unusable is not a weaker store;
        // it is no store. Never claim through it, and never fall back silently.
        if (store.availability?.mode === 'unavailable')
            return emptyReport('store_unavailable', caps);
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
        const failures = [];
        let cursor = null;
        let drained = false;
        let halted = null;
        try {
            for (;;) {
                if (stopped) {
                    halted = 'stopped';
                    break;
                }
                if (pages >= maxPages || items >= maxItems) {
                    halted = 'budget_exhausted';
                    break;
                }
                const elapsed = now().getTime() - startedAtMs;
                if (elapsed >= runBudgetMs) {
                    halted = 'budget_exhausted';
                    break;
                }
                const limit = Math.min(pageSize, maxItems - items);
                if (limit <= 0) {
                    halted = 'budget_exhausted';
                    break;
                }
                let page;
                try {
                    const claimNowMs = now().getTime();
                    page = await store.claimBatch({
                        owner,
                        nowMs: claimNowMs,
                        leaseUntilMs: claimNowMs + leaseMs,
                        limit,
                        after: cursor,
                    });
                }
                catch (error) {
                    report(error);
                    // A corrupt row is a data fault, not a store fault: the page
                    // transaction rolled back, so nothing was claimed.
                    halted = (0, exports.isAssignmentCleanupRowInvalidError)(error) ? 'invalid_row' : 'claim_store_failed';
                    break;
                }
                pages += 1;
                claimed += page.length;
                if (page.length === 0) {
                    drained = true;
                    break;
                }
                for (const record of page) {
                    if (stopped) {
                        halted = 'stopped';
                        break;
                    }
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
                    if (itemElapsed >= runBudgetMs) {
                        halted = 'budget_exhausted';
                        break;
                    }
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
                                state: (0, exports.cleanupStateForProof)(outcome.proof),
                                proof: outcome.proof,
                            });
                        }
                        catch (error) {
                            report(error);
                            // A corrupt row must not be reported as a lost claim:
                            // our lease may be perfectly intact, and the caller
                            // needs to know the data is the problem.
                            if ((0, exports.isAssignmentCleanupRowInvalidError)(error)) {
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
                            if (outcome.kind === 'deleted')
                                deleted += 1;
                            else
                                superseded += 1;
                        }
                        else {
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
                    }
                    catch (error) {
                        report(error);
                        if ((0, exports.isAssignmentCleanupRowInvalidError)(error)) {
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
                    }
                    else {
                        lostClaims += 1;
                        halted = 'claim_lost';
                        break;
                    }
                }
                if (halted !== null)
                    break;
                const last = page[page.length - 1];
                cursor = { createdAtMs: last.createdAtMs, id: last.id };
                if (page.length < limit) {
                    drained = true;
                    break;
                }
            }
        }
        finally {
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
        stop: () => { stopped = true; },
        isStopped: () => stopped,
        describeCapability: capability,
    };
};
exports.createAssignmentCleanupRecovery = createAssignmentCleanupRecovery;
/**
 * The handle for "no obligation was recorded **because no durable store was
 * injected**". Only that case: a store that *was* injected but given no bound
 * target answers `invalid_target`, so it can never be read as this
 * delete-permitting legacy path.
 */
exports.UNRECORDED_CLEANUP_HANDLE = {
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
const recordCleanupObligation = async (store, target, tx) => {
    if (!store)
        return exports.UNRECORDED_CLEANUP_HANDLE;
    // A store was injected and no target was: the identity did not bind. Answer
    // `invalid_target`, never `unconfigured`. `unconfigured` is the one value a
    // caller reads as "the legacy path may delete without a write-ahead row",
    // so returning it here would let an unbound version be deleted with no
    // obligation recorded at all — the exact write-ahead property this function
    // exists to provide.
    if (!target)
        return { id: null, claimVersion: null, recording: 'invalid_target' };
    // An injected durable store failing availability cannot silently drop the
    // write-ahead obligation from a cancellation/verdict transaction.
    if (store.availability?.mode === 'unavailable') {
        if (tx)
            throw new Error('Assignment cleanup obligation store is unavailable');
        return { id: null, claimVersion: null, recording: 'store_unavailable' };
    }
    const toHandle = (result) => ({
        id: result.id,
        claimVersion: result.claimVersion,
        recording: result.outcome,
    });
    if (tx)
        return toHandle(await store.recordPending(target, tx));
    try {
        return toHandle(await store.recordPending(target));
    }
    catch (error) {
        // A corrupt row means we cannot say whether this version is already owed.
        // Report it as its own reason so the caller's log names the real cause,
        // but the answer is the same either way: delete nothing.
        return {
            id: null,
            claimVersion: null,
            recording: (0, exports.isAssignmentCleanupRowInvalidError)(error) ? 'store_invalid_row' : 'record_failed',
        };
    }
};
exports.recordCleanupObligation = recordCleanupObligation;
/**
 * Settle an obligation the request path recorded and finished itself. The CAS
 * is on `claim_owner IS NULL`, so a coordinator that already claimed the row
 * wins and this call is a harmless no-op.
 *
 * Returns false when the settlement did not land; the row then stays `pending`
 * and the coordinator will replay it (and re-derive the same terminal state from
 * the store's own answer).
 */
const settleRecordedCleanup = async (store, handle, proof, nowMs) => {
    if (!store || handle.id === null || handle.claimVersion === null)
        return false;
    try {
        return await store.completeUnclaimed({
            id: handle.id,
            claimVersion: handle.claimVersion,
            nowMs,
            state: (0, exports.cleanupStateForProof)(proof),
            proof,
        });
    }
    catch {
        return false;
    }
};
exports.settleRecordedCleanup = settleRecordedCleanup;
/**
 * Map a capability-gated delete answer to a completion proof. `unsupported` and
 * `failed` produce no proof: those are pending work, not a terminal state.
 */
const cleanupProofForRemoval = (cleanup) => {
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
exports.cleanupProofForRemoval = cleanupProofForRemoval;
/* ------------------------------------------------------------------------- */
/* Bounded, tenant-scoped orphan *planning* (no deletion)                     */
/* ------------------------------------------------------------------------- */
/** Objects listed per page while planning. */
exports.DEFAULT_ORPHAN_PAGE_SIZE = 50;
exports.MAX_ORPHAN_PAGE_SIZE = 200;
/** Pages inspected per planning call. */
exports.DEFAULT_ORPHAN_MAX_PAGES = 2;
exports.MAX_ORPHAN_MAX_PAGES = 20;
/**
 * Plan — never perform — orphan reconciliation for **one tenant**.
 *
 * This function issues no delete of any kind, has no bucket-wide count, and
 * cannot address a key outside `tenants/{tenantId}/assignments/`. It exists so
 * the "objects nobody owns" class is inspectable without a destructive sweep:
 * the deletion step needs a retention decision that belongs to the deployment
 * (see the delivery doc), not to this module.
 */
const planTenantOrphanReconciliation = async (deps, request) => {
    const tenantId = (0, assignments_1.normalizeId)(request.tenantId);
    const prefix = tenantId === null ? '' : `tenants/${tenantId}/assignments/`;
    const pageSize = clampInt(request.pageSize, exports.DEFAULT_ORPHAN_PAGE_SIZE, 1, exports.MAX_ORPHAN_PAGE_SIZE);
    const maxPages = clampInt(request.maxPages, exports.DEFAULT_ORPHAN_MAX_PAGES, 1, exports.MAX_ORPHAN_MAX_PAGES);
    const plan = {
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
    if (!deps.listing) {
        plan.halted = 'listing_unconfigured';
        return plan;
    }
    if (!deps.lookup) {
        plan.halted = 'lookup_unconfigured';
        return plan;
    }
    const listing = deps.listing;
    const lookup = deps.lookup;
    const report = (error) => {
        if (!deps.onError)
            return;
        try {
            deps.onError(error);
        }
        catch {
            // never alter the plan
        }
    };
    let after = null;
    for (let page = 0; page < maxPages; page += 1) {
        let objects;
        try {
            objects = await listing.listTenantObjects({ tenantId, prefix, after, limit: pageSize });
        }
        catch (error) {
            report(error);
            plan.halted = 'listing_failed';
            return plan;
        }
        plan.inspected += objects.length;
        for (const object of objects) {
            const parsed = (0, assignment_storage_1.parseSubmissionStorageKey)(object.objectKey);
            if (!parsed || parsed.tenantId !== tenantId) {
                plan.rejectedKeys += 1;
                continue;
            }
            if (!object.version) {
                plan.unboundVersions += 1;
                continue;
            }
            // A `NaN` cutoff makes every comparison false, which silently
            // disables the retention filter and candidates every unowned object
            // regardless of age. Planning-only — no delete is issued — but the
            // filter must mean what it says, so an unusable cutoff stops the
            // plan instead of widening it.
            if (!Number.isFinite(request.notModifiedSinceMs) || !Number.isFinite(object.lastModifiedMs)) {
                plan.halted = 'invalid_retention_cutoff';
                return plan;
            }
            if (object.lastModifiedMs >= request.notModifiedSinceMs)
                continue;
            let owned;
            try {
                owned = await lookup.hasSubmissionForVersion({
                    tenantId,
                    submissionId: parsed.submissionId,
                    etag: object.version.etag,
                    sizeBytes: object.version.sizeBytes,
                });
            }
            catch (error) {
                report(error);
                plan.halted = 'lookup_failed';
                return plan;
            }
            if (owned)
                continue;
            plan.candidates.push({
                objectKey: object.objectKey,
                version: object.version,
                lastModifiedMs: object.lastModifiedMs,
                reason: 'no-matching-row',
            });
        }
        if (objects.length < pageSize)
            return plan;
        after = objects[objects.length - 1].objectKey;
        if (page === maxPages - 1)
            plan.truncated = true;
    }
    return plan;
};
exports.planTenantOrphanReconciliation = planTenantOrphanReconciliation;
