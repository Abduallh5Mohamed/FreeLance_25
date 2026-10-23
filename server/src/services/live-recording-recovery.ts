/**
 * WL-P4 — bounded, injected, explicitly invoked recording recovery.
 *
 * One pass over `live_recording_ingests WHERE outcome = 'pending'` that drives
 * the SAME service function a provider callback drives. There is no timer, no
 * startup hook, no self-scheduling, no `setInterval` and no import-time work:
 * a caller decides when a pass happens, how big it may be and how long it may
 * take, and gets a report of what it did.
 *
 * Why a separate pass at all: a provider that never redelivers a `pending` row
 * leaves the event repairable but unrepaired (contract §11.6, R9). This is the
 * repair, and it is deliberately NOT a second writer — it calls
 * `RecordingIngestService.resumePending`, which re-checks the ledger row, the
 * session row, the tenant, the grace window and the caps, then runs the same
 * claim / external / terminal units as `ingest`. The fence, the sink keys and
 * the audit therefore cannot diverge between a callback and a sweep.
 *
 * Pagination is KEYSET over `(occurred_at_ms, id)`, never OFFSET. An offset scan
 * counts a result set that other workers are changing underneath it: every row
 * that settles leaves `WHERE outcome = 'pending'`, so after the page of n rows
 * the row that used to be at offset n+1 shifts to offset n and `OFFSET n`
 * steps straight over it — the scan skips exactly the rows it was meant to
 * repair, and a concurrent insert shifts the window the other way and makes it
 * re-read rows instead. `(occurred_at_ms, id)` is immutable for a row (nothing
 * in this system updates either column) and `id` is the primary key, so it is a
 * total order: "strictly after the last key I saw" means the same thing no
 * matter how many rows left the set. A row inserted mid-pass with an EARLIER
 * occurred_at_ms is not seen by this pass; it is still pending, and the next
 * pass that completes a full sweep starts from the beginning, so nothing is
 * lost — only deferred by one pass. That is stated rather than hidden.
 *
 * CONTINUATION ACROSS INVOCATIONS
 *   A bounded pass cannot finish an arbitrarily large pending set, so the
 *   report carries `continuation` — the key of the last row this pass actually
 *   INSPECTED (not the last one it claimed) — and `sweepComplete`. Pass the
 *   continuation back as `options.after` and the next pass starts strictly
 *   after it instead of re-reading the same head of the set.
 *
 *   WHO PERSISTS IT: the CALLER — the operator command, or the cron the caller
 *   owns. This module keeps no state between calls: no scheduler, no timer, no
 *   `process.on`, no module-level cursor, no automatic retry. `sweepComplete:
 *   true` resets `continuation` to `null`, so the pass after a completed sweep
 *   starts from the beginning and picks up anything inserted behind the scan.
 *
 *   A caller that DISCARDS the continuation re-scans from the start on every
 *   pass. That is exactly the starvation the previous delivery had: the first
 *   batch of permanently ineligible rows was re-read, re-refused, and charged
 *   against the cap for ever. The continuation alone does not fix that (the
 *   caller may ignore it), which is why the ingest service terminalises
 *   proven-ineligible rows inside their fence (`settleTerminal` in
 *   `live-recording-ingest.ts`). The two mechanisms together remove the
 *   starvation: the continuation lets a cooperating caller move on, and the
 *   terminalisation lets a non-cooperating caller make progress too, because a
 *   quarantined row is no longer in `outcome = 'pending'`.
 *
 *   The scan also excludes rows whose lease is still live (the source receives
 *   the pass clock as `nowMs`). Another worker's in-flight row is not this
 *   pass's work and must not consume its budget; the `claimPending` CAS inside
 *   `resumePending` is still the only fence.
 *
 * No blind external resend: the resume re-derives the meter `operationId`
 * (`provider:eventId`) and the library dedupe tuple
 * (`tenant, provider, providerRecordingId`) from the PERSISTED row, so every
 * resend is a keyed resend. The library port must answer `created: false` for
 * the existing asset — that answer is the idempotency proof — and anything it
 * cannot prove (a throw, an absent port) makes the row `deferred`, never
 * `settled`. A `created: true` answer is not a blind duplicate either: it says
 * the earlier attempt never created the asset, and the key it used is the one
 * this call used. There is no retry loop: one attempt per row per pass, bounded
 * by `RECOVERY_MAX_ATTEMPTS_PER_ROW`.
 *
 * No success is inferred. Every counter below comes from an explicit result
 * variant, and a status this module does not recognise is reported as
 * `deferred` — never as done.
 *
 * DURABLE CHECKPOINT (R24) — INJECTED, NOT WIRED BY DEFAULT
 *   `deps.checkpoint` is an optional port that persists the continuation in
 *   `live_recovery_checkpoints` under one fixed server-owned purpose, so a
 *   caller no longer has to carry it between invocations. It is NOT wired by
 *   default: without the port this module behaves exactly as described above,
 *   `options.after` is used directly and the caller-persists limit above still
 *   applies unchanged. The port is also UNPROVEN until the requested migration
 *   `20261023_04_live_recovery_checkpoint.sql` lands; the SQL adapter behind it
 *   degrades every operation to `checkpoint-absent` while the table is missing,
 *   and this pass then reports `checkpoint-unavailable` without scanning.
 *
 *   With the port present the durable cursor — not `options.after` — decides
 *   where the pass starts. An explicit `after` is accepted only when it equals
 *   the claimed cursor byte for byte, and a mismatch refuses the pass instead
 *   of silently starting somewhere the checkpoint did not record. Each fully
 *   inspected page is persisted before the next one is read, so a crash can
 *   replay a page but cannot skip one.
 *
 *   The report carries `checkpoint` (`null` on the checkpoint-free interface)
 *   and four stop reasons that only this path can produce:
 *   `checkpoint-unavailable` (no row, no table, no column),
 *   `cursor-override-rejected`, `checkpoint-advance-failed` (the CAS lost or the
 *   store refused) and `checkpoint-lease-lost` (the lease expired before another
 *   page). `options.shutdown` adds `shutdown-in-progress`: the pass refuses to
 *   start and touches no cursor, because a final recovery pass during shutdown
 *   is exactly what must not happen.
 */

import type { RecordingIngestRow, RecordingIngestService, RecordingResumeResult } from './live-recording-ingest';

/* =========================================================================
 * Bounds — every one of them a named constant, every one clampable
 * ========================================================================= */

/** Rows this pass may hand to `resumePending`. Bounds the external work. */
export const RECOVERY_BATCH_CAP = 200;
/** Rows per keyset page. */
export const RECOVERY_PAGE_SIZE = 50;
/**
 * Attempts per row PER PASS. There is no attempts column in the ledger and this
 * pass does not invent one, so a row cannot be retried across passes by
 * counting; the bound exists to stop a broken source (a page that repeats a
 * row) from turning one pass into an unbounded loop. The next pass is the
 * retry.
 */
export const RECOVERY_MAX_ATTEMPTS_PER_ROW = 1;
/** Wall-clock budget for one pass. */
export const RECOVERY_MAX_WALL_CLOCK_MS = 30_000;

/** Clamp ceilings — a caller may ask for more, and gets these instead. */
export const RECOVERY_BATCH_CAP_CEILING = 1_000;
export const RECOVERY_PAGE_SIZE_CEILING = 200;
export const RECOVERY_MAX_ATTEMPTS_PER_ROW_CEILING = 3;
export const RECOVERY_WALL_CLOCK_MS_CEILING = 120_000;

/* =========================================================================
 * Injected ports
 * ========================================================================= */

/** The immutable ordered pair the scan walks. */
export interface RecordingRecoveryCursor {
    occurredAtMs: number;
    id: string;
}

/**
 * The durable state of the ONE global recovery scan.
 *
 * `cursor: null` means "start at the beginning" and is what a completed sweep
 * writes. `owner` and `leaseExpiresAtMs` are written together or not at all,
 * so an owner without an expiry is not a representable state. `rowVersion` is
 * the fencing token every claim/advance/release presents; `sweepGeneration`
 * counts completed sweeps and only a completed sweep increments it.
 */
export interface RecordingRecoveryCheckpointState {
    cursor: RecordingRecoveryCursor | null;
    owner: string | null;
    leaseExpiresAtMs: number | null;
    rowVersion: number;
    sweepGeneration: number;
}

/**
 * Why a checkpoint operation did not happen. The adapter derives these from a
 * re-read of the row, never from a driver message.
 */
export type RecordingRecoveryCheckpointFailure =
    | 'checkpoint-absent'      // table missing (1146 / 42S02)
    | 'schema-unavailable'     // table present, column missing (1054 / 42S22)
    | 'row-missing'            // row vanished between statements
    | 'stale-owner'            // owner column holds another worker
    | 'stale-version'          // row_version advanced since we read it
    | 'stale-generation'       // sweep_generation advanced since we read it
    | 'cursor-mismatch'        // stored cursor is not the one we expected
    | 'lease-expired'          // lease_expires_at_ms <= nowMs
    | 'unknown';

export interface RecordingRecoveryCheckpointClaim {
    claimed: boolean;
    state: RecordingRecoveryCheckpointState | null;
    reason: RecordingRecoveryCheckpointFailure | null;
}

/**
 * The durable checkpoint port. `purpose` is server-owned: every implementation
 * must scan the same fixed key, because a caller-chosen purpose would create a
 * second independent scan of the same workset.
 *
 * `claim` takes the lease and returns the stored state. `advance` moves the
 * cursor by one fully inspected page and returns the new `rowVersion`; a false
 * `advanced` means this pass no longer owns the row and must stop. A failed
 * advance is not retried here. `completeSweep` resets the cursor and increments
 * the generation in one CAS. `release` hands the row back and reports false for
 * an expired or foreign lease — that is the answer, not an error.
 */
export interface RecordingRecoveryCheckpoint {
    readonly purpose: string;
    claim(input: { owner: string; nowMs: number; leaseMs: number }): Promise<RecordingRecoveryCheckpointClaim>;
    advance(input: {
        owner: string; expectedRowVersion: number; expectedGeneration: number;
        previousCursor: RecordingRecoveryCursor | null; nextCursor: RecordingRecoveryCursor;
        nowMs: number; leaseMs: number;
    }): Promise<{ advanced: boolean; rowVersion: number | null; reason: RecordingRecoveryCheckpointFailure | null }>;
    completeSweep(input: {
        owner: string; expectedRowVersion: number; expectedGeneration: number;
        previousCursor: RecordingRecoveryCursor | null; nowMs: number; leaseMs: number;
    }): Promise<{ completed: boolean; rowVersion: number | null; sweepGeneration: number | null; reason: RecordingRecoveryCheckpointFailure | null }>;
    release(input: {
        owner: string; expectedRowVersion: number; nowMs: number;
    }): Promise<{ released: boolean; reason: RecordingRecoveryCheckpointFailure | null }>;
}

/**
 * The pass's default checkpoint lease and its ceiling. They mirror the SQL
 * adapter's `CHECKPOINT_DEFAULT_LEASE_MS` / `CHECKPOINT_LEASE_MS_CEILING`; the
 * numbers are repeated rather than imported so the port module never depends on
 * the adapter (the adapter imports this module's types, not the other way).
 * A longer request is clamped here, so the pass never asks for a lease the
 * store will refuse.
 */
const RECOVERY_CHECKPOINT_LEASE_MS = 60_000;
const RECOVERY_CHECKPOINT_LEASE_MS_CEILING = 5 * 60_000;

/**
 * The read side. `listPendingIngests` must return rows STRICTLY AFTER `after`
 * in `(occurred_at_ms, id)` order, or `after === null` for the first page.
 * `nowMs` is the pass clock: the source must exclude a row whose claim lease is
 * still live, because another worker holds it and it is not this pass's work.
 * The SQL adapter's `listPendingIngests` satisfies this structurally.
 */
export interface RecordingRecoveryPendingSource {
    listPendingIngests(input: {
        after: RecordingRecoveryCursor | null;
        limit: number;
        nowMs: number;
    }): Promise<RecordingIngestRow[]>;
}

export interface RecordingRecoveryDeps {
    source: RecordingRecoveryPendingSource;
    /** The SAME service object a provider callback drives. */
    service: Pick<RecordingIngestService, 'resumePending'>;
    now?: () => number;
    /**
     * R24 durable checkpoint. Optional and null by default: absent or null
     * means the pass behaves exactly as it did before the port existed, with
     * `options.after` as the only continuation.
     *
     * `owner` is the caller's worker token and must be stable for the whole
     * pass. `leaseMs` is clamped to the store's ceiling; the default is the
     * store's default. There is no renewal loop — one pass lives inside one
     * lease.
     */
    checkpoint?: { port: RecordingRecoveryCheckpoint; owner: string; leaseMs?: number } | null;
}

export interface RecordingRecoveryOptions {
    batchCap?: number;
    pageSize?: number;
    maxAttemptsPerRow?: number;
    wallClockMs?: number;
    /**
     * The continuation returned by the previous pass (`report.continuation`).
     * The scan starts STRICTLY AFTER this key instead of at the beginning.
     *
     * WHO PERSISTS IT: the CALLER — the operator command or the cron the caller
     * owns. This module holds no state between calls: no scheduler, no timer,
     * no `process.on`, no module-level cursor. A caller that discards the
     * continuation re-scans from the start on every pass; that is permitted,
     * and the fenced terminalisation in the ingest service is what still keeps
     * such a caller from starving newer rows.
     */
    after?: RecordingRecoveryCursor | null;
    /**
     * R24: do not start a new pass. The report is zeroed with
     * `stopReason: 'shutdown-in-progress'` and the checkpoint is not touched at
     * all — no claim, no release. Draining work that is already in flight
     * belongs to the caller; this function never scans after it has released.
     */
    shutdown?: boolean;
}

export type RecordingRecoveryStopReason =
    | 'exhausted'
    | 'batch-cap'
    | 'wall-clock'
    | 'checkpoint-unavailable'
    | 'cursor-override-rejected'
    | 'checkpoint-advance-failed'
    | 'checkpoint-lease-lost'
    | 'shutdown-in-progress';

export interface RecordingRecoveryReport {
    /** Rows returned by the source, including ones this pass could not use. */
    scanned: number;
    /** Rows whose lease CAS this pass won. */
    claimed: number;
    /**
     * Rows actually driven through the EXTERNAL path (meter / library). A won
     * claim is driven immediately and awaited, so this equals `claimed` minus
     * the rows quarantined before any sink; it is reported separately so a
     * claim that is taken and then abandoned cannot hide.
     */
    resumed: number;
    /** `ingested` — this pass performed the terminal transition. */
    settled: number;
    /** Still `pending`, for a reason that may heal (library, meter, a throw). */
    deferred: number;
    /** Not touched: not claimable, already terminal, refused, or unreadable. */
    skipped: number;
    /** Subset of `skipped`: the row was already terminal. */
    alreadyTerminal: number;
    /** Subset of `skipped`: a terminal replay disagreed with the stored payload. */
    conflicts: number;
    /**
     * Rows this pass moved OUT of the pending set without ingesting them —
     * `{status:'quarantined'}` from the resume. Counted as progress: not
     * `settled` (nothing was ingested) and not `deferred` (the row will not be
     * re-listed). Also counted in `claimed`, because the quarantine transition
     * won the same lease CAS; NOT counted in `resumed`, because no external
     * sink was called.
     */
    quarantined: number;
    pages: number;
    stopReason: RecordingRecoveryStopReason;
    deferredReasons: Readonly<Record<string, number>>;
    skippedReasons: Readonly<Record<string, number>>;
    /** Per-reason split of `quarantined`: `outside-grace` / `session-cancelled`. */
    quarantinedReasons: Readonly<Record<string, number>>;
    /**
     * The key of the LAST ROW ACTUALLY INSPECTED in this pass — not the last
     * one claimed. Pass it back as `options.after` to continue where this pass
     * stopped. `null` when the pass reached the end of the pending set
     * (`sweepComplete`) so the next pass restarts from the beginning, or when
     * there was no earlier continuation and nothing was inspected.
     */
    continuation: RecordingRecoveryCursor | null;
    /**
     * `true` only when this pass reached the END of the pending set: an empty
     * page, or a short page that was fully consumed. A pass stopped by the
     * batch cap or the wall clock is `false` even if it happened to stop on the
     * last row — the caller must not treat a bounded stop as a full sweep.
     */
    sweepComplete: boolean;
    elapsedMs: number;
    /**
     * R24 durable-checkpoint outcome. `null` means this pass ran on the
     * checkpoint-free run-once interface, which stays INTEGRATION-OPEN: the
     * caller persists `continuation` itself or the scan re-reads its head.
     *
     * `persistedPages` counts successful cursor CASes, not pages inspected: the
     * last page of a completed sweep is persisted by `completeSweep` — one CAS
     * that resets the cursor and increments the generation — so it is not
     * counted here. `failure` names the first checkpoint operation that did not
     * happen; it is a classification, never a driver message dump.
     */
    checkpoint: RecordingRecoveryReportCheckpoint | null;
}

/**
 * The failure vocabulary of a report: the port's own classifications plus the
 * two answers that only the PASS can produce.
 *
 * It is a closed union rather than `string` on purpose — a typo in a failure
 * name is then a compile error instead of a new, silently accepted value.
 */
export type RecordingRecoveryReportFailure =
    | RecordingRecoveryCheckpointFailure
    | 'cursor-override-rejected' // `options.after` contradicted the durable row; no work ran
    | 'release-error';           // the release call threw; the row may still be ours

/**
 * What the checkpoint DID, as opposed to what it was asked to do.
 *
 * `claimed: false` means no scan ran at all. `released: false` on a pass that
 * otherwise succeeded means the row was not handed back — an expired or
 * foreign lease answers false, which is a fact about ownership, not an error.
 * `failure` names the FIRST such fact and is never overwritten by a later one.
 */
export interface RecordingRecoveryReportCheckpoint {
    enabled: boolean;
    claimed: boolean;
    persistedPages: number;
    sweepGeneration: number | null;
    rowVersion: number | null;
    released: boolean;
    failure: RecordingRecoveryReportFailure | null;
}

/* =========================================================================
 * Internals
 * ========================================================================= */

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const bump = (counter: Record<string, number>, key: string): void => {
    counter[key] = (counter[key] ?? 0) + 1;
};

/**
 * Cursor equality for the override guard: the `id` is compared BYTE FOR BYTE
 * and the instant numerically. Two cursors that name the same event must
 * compare equal here or a legitimate repeat of the stored continuation would be
 * refused; two that differ by one trailing byte are different positions and
 * must not be. No trimming, no normalisation.
 */
const sameRecoveryCursor = (a: RecordingRecoveryCursor | null, b: RecordingRecoveryCursor | null): boolean => {
    if (a === null || b === null) return a === b;
    return a.occurredAtMs === b.occurredAtMs && a.id === b.id;
};

/**
 * The claimed checkpoint, carried through one pass. `rowVersion` and
 * `generation` are the fencing values the NEXT CAS must present; they are
 * replaced by the value each successful CAS returns, never incremented here —
 * the row is the authority, and a local increment would guess.
 */
interface CheckpointRun {
    port: RecordingRecoveryCheckpoint;
    owner: string;
    leaseMs: number;
    rowVersion: number;
    generation: number;
    expiresAtMs: number;
}

interface Tally {
    scanned: number;
    claimed: number;
    resumed: number;
    settled: number;
    deferred: number;
    skipped: number;
    alreadyTerminal: number;
    conflicts: number;
    quarantined: number;
    deferredReasons: Record<string, number>;
    skippedReasons: Record<string, number>;
    quarantinedReasons: Record<string, number>;
}

/**
 * Map one resume result onto the report. The distinction that matters:
 *
 *  - `ingested`                          → claimed, resumed, settled
 *  - `deferred` + a library reason or
 *    `claim-lost`                        → claimed, resumed, deferred (we held
 *                                          the lease and the row stays pending)
 *  - `deferred` + `claim-held` /
 *    `claim-unavailable`                 → skipped (we never held the lease)
 *  - `quarantined`                       → claimed, quarantined (the row left
 *                                          the pending set without being
 *                                          ingested; no external call ran, so
 *                                          not `resumed`)
 *  - `duplicate`                         → already terminal, skipped
 *  - `conflict`                          → skipped, counted as a conflict
 *  - `ignored` / `skipped` / `rejected`  → skipped, with the reason recorded
 *  - anything else                       → deferred (`unrecognised-result`)
 *
 * A result this function does not understand is never counted as done.
 */
const tallyResult = (tally: Tally, result: RecordingResumeResult): void => {
    switch (result.status) {
        case 'ingested':
            tally.claimed += 1;
            tally.resumed += 1;
            tally.settled += 1;
            return;
        case 'deferred':
            if (result.reason === 'claim-held' || result.reason === 'claim-unavailable') {
                tally.skipped += 1;
                bump(tally.skippedReasons, result.reason);
                return;
            }
            tally.claimed += 1;
            tally.resumed += 1;
            tally.deferred += 1;
            bump(tally.deferredReasons, result.reason);
            return;
        case 'quarantined':
            tally.claimed += 1;
            tally.quarantined += 1;
            bump(tally.quarantinedReasons, result.reason);
            return;
        case 'duplicate':
            tally.skipped += 1;
            tally.alreadyTerminal += 1;
            bump(tally.skippedReasons, 'already-terminal');
            return;
        case 'conflict':
            tally.skipped += 1;
            tally.conflicts += 1;
            bump(tally.skippedReasons, 'payload-mismatch');
            return;
        case 'ignored':
            tally.skipped += 1;
            bump(tally.skippedReasons, `ignored:${result.reason}`);
            return;
        case 'skipped':
            tally.skipped += 1;
            bump(tally.skippedReasons, result.reason);
            return;
        case 'rejected':
            tally.skipped += 1;
            bump(tally.skippedReasons, `rejected:${result.reason}`);
            return;
        default:
            // Unreachable for the declared union; a runtime shape from a future
            // adapter lands here, and it is reported as unfinished.
            tally.deferred += 1;
            bump(tally.deferredReasons, 'unrecognised-result');
            return;
    }
};

/* =========================================================================
 * The pass
 * ========================================================================= */

/**
 * Run ONE bounded recovery pass. Returns a report; never schedules itself.
 *
 * Ordering is `(occurred_at_ms, id)` ascending, oldest event first, so the
 * longest-stuck rows are attempted first within a pass and a batch cap trims
 * the newest work rather than starving the oldest.
 *
 * `options.after` is the continuation from the previous pass. This function
 * does not persist it and does not remember it: the caller that wants
 * continuity stores `report.continuation` and hands it back. Every bound below
 * is unchanged — a pass is still capped on rows, page size, attempts and wall
 * clock, and there is no unbounded scan on any path.
 */
export async function runRecordingRecoveryOnce(
    deps: RecordingRecoveryDeps,
    options: RecordingRecoveryOptions = {},
): Promise<RecordingRecoveryReport> {
    const batchCap = clampInt(options.batchCap, RECOVERY_BATCH_CAP, 1, RECOVERY_BATCH_CAP_CEILING);
    const pageSize = clampInt(options.pageSize, RECOVERY_PAGE_SIZE, 1, RECOVERY_PAGE_SIZE_CEILING);
    const maxAttemptsPerRow = clampInt(
        options.maxAttemptsPerRow,
        RECOVERY_MAX_ATTEMPTS_PER_ROW,
        1,
        RECOVERY_MAX_ATTEMPTS_PER_ROW_CEILING,
    );
    const wallClockMs = clampInt(options.wallClockMs, RECOVERY_MAX_WALL_CLOCK_MS, 1, RECOVERY_WALL_CLOCK_MS_CEILING);
    const now = deps.now ?? ((): number => Date.now());
    const startedAt = now();

    const tally: Tally = {
        scanned: 0,
        claimed: 0,
        resumed: 0,
        settled: 0,
        deferred: 0,
        skipped: 0,
        alreadyTerminal: 0,
        conflicts: 0,
        quarantined: 0,
        deferredReasons: {},
        skippedReasons: {},
        quarantinedReasons: {},
    };

    const attempts = new Map<string, number>();
    /**
     * Start where the caller's persisted continuation says, not at the
     * beginning. `null` is the documented full-sweep reset. With a durable
     * checkpoint this value is REPLACED by the claimed row below: `after` is
     * then an override request, not the authority.
     */
    let cursor: RecordingRecoveryCursor | null = options.after ?? null;
    /**
     * The last row this pass actually LOOKED AT — claimed, skipped, quarantined
     * or deferred, but inspected either way. Initialised to the incoming
     * continuation so a pass that inspects nothing (an immediately expired wall
     * clock) does not make the caller lose its place.
     */
    let lastInspected: RecordingRecoveryCursor | null = options.after ?? null;
    let pages = 0;
    /**
     * Rows this pass has looked at, including ones it refused to drive. The
     * budget is spent on ROWS, not on resume calls, so a source that ignores
     * `after` and keeps returning the same page still terminates: the page is
     * counted, the attempt cap skips the repeats, and the batch cap ends the
     * pass. Bounding only the calls would spin forever on a broken listing.
     */
    let consumed = 0;
    let stopReason: RecordingRecoveryStopReason = 'exhausted';
    /** Set only where the scan genuinely reached the end of the pending set. */
    let sweepComplete = false;
    /**
     * The position the DURABLE row is believed to hold — the value the next CAS
     * must present as `previousCursor`. It moves only after a CAS succeeds, so a
     * failed write can never leave this pass believing it persisted a position
     * it did not.
     */
    let storedCursor: RecordingRecoveryCursor | null = options.after ?? null;
    /**
     * Set when a failed CAS proved this pass no longer owns the row. Cleanup
     * must not write to a row another worker holds.
     */
    let ownershipLost = false;
    /** Guarantees the `finally` cleanup performs at most ONE release attempt. */
    let releaseAttempted = false;

    const checkpointDeps = deps.checkpoint ?? null;
    const checkpointLeaseMs = checkpointDeps === null
        ? null
        : clampInt(
            checkpointDeps.leaseMs,
            RECOVERY_CHECKPOINT_LEASE_MS,
            1,
            RECOVERY_CHECKPOINT_LEASE_MS_CEILING,
        );

    const checkpoint: RecordingRecoveryReportCheckpoint | null = checkpointDeps === null
        ? null
        : {
            enabled: true,
            claimed: false,
            persistedPages: 0,
            sweepGeneration: null,
            rowVersion: null,
            released: false,
            failure: null,
        };

    /**
     * One place builds the report, so every early return reports the same facts.
     *
     * DELIBERATE ALIASING: the `checkpoint` field is the SAME object `releaseOnce`
     * mutates, not a copy. Every exit runs `finally` AFTER this function has
     * returned, so a snapshot taken here would always say `released: false` and
     * lose the cleanup outcome. Sharing the reference is what lets the release
     * result reach the caller. Do not freeze or spread this object without
     * moving the release before the report is built.
     *
     * `elapsedMs` therefore measures the SCAN, not the cleanup that follows it.
     */
    const buildReport = (): RecordingRecoveryReport => ({
        scanned: tally.scanned,
        claimed: tally.claimed,
        resumed: tally.resumed,
        settled: tally.settled,
        deferred: tally.deferred,
        skipped: tally.skipped,
        alreadyTerminal: tally.alreadyTerminal,
        conflicts: tally.conflicts,
        quarantined: tally.quarantined,
        pages,
        stopReason,
        deferredReasons: tally.deferredReasons,
        skippedReasons: tally.skippedReasons,
        quarantinedReasons: tally.quarantinedReasons,
        // A completed sweep resets the continuation so the next pass starts at
        // the beginning again (a row inserted mid-pass with an earlier key is
        // picked up then). A bounded stop returns the last inspected key.
        continuation: sweepComplete ? null : lastInspected,
        sweepComplete,
        elapsedMs: now() - startedAt,
        checkpoint,
    });

    /**
     * Shutdown is a REFUSAL, not a shortcut: no claim, no release, no scan, no
     * cursor movement. Draining work that is already in flight belongs to the
     * caller that holds the in-flight promise; this function never scans after
     * it has released, and it must not start a fresh pass on the way out.
     */
    if (options.shutdown === true) {
        stopReason = 'shutdown-in-progress';
        return buildReport();
    }

    /**
     * Move the durable cursor to `target`. `false` means the CAS lost — another
     * worker, an expired lease, or a cursor that moved — and the pass must stop
     * immediately: reading another page after a lost fence would be work this
     * worker may no longer persist.
     */
    const persistCursor = async (run: CheckpointRun, target: RecordingRecoveryCursor): Promise<boolean> => {
        const result = await run.port.advance({
            owner: run.owner,
            expectedRowVersion: run.rowVersion,
            expectedGeneration: run.generation,
            previousCursor: storedCursor,
            nextCursor: target,
            nowMs: now(),
            leaseMs: run.leaseMs,
        });
        if (!result.advanced || result.rowVersion === null) {
            stopReason = 'checkpoint-advance-failed';
            // A lost CAS means this pass does not own the row any more, so the
            // cleanup in `finally` must not write to it.
            ownershipLost = true;
            if (checkpoint !== null && checkpoint.failure === null) {
                checkpoint.failure = result.reason ?? 'unknown';
            }
            return false;
        }
        run.rowVersion = result.rowVersion;
        if (checkpoint !== null) {
            checkpoint.rowVersion = result.rowVersion;
            checkpoint.persistedPages += 1;
        }
        storedCursor = target;
        cursor = target;
        return true;
    };

    /**
     * Close the sweep in ONE CAS: reset the cursor and increment the generation
     * together. Not "advance then reset" — two statements would let a crash land
     * between them and leave a generation that claims a reset the cursor does
     * not reflect.
     */
    const completeSweepAt = async (run: CheckpointRun): Promise<boolean> => {
        const result = await run.port.completeSweep({
            owner: run.owner,
            expectedRowVersion: run.rowVersion,
            expectedGeneration: run.generation,
            previousCursor: storedCursor,
            nowMs: now(),
            leaseMs: run.leaseMs,
        });
        if (!result.completed || result.rowVersion === null || result.sweepGeneration === null) {
            stopReason = 'checkpoint-advance-failed';
            ownershipLost = true;
            if (checkpoint !== null && checkpoint.failure === null) {
                checkpoint.failure = result.reason ?? 'unknown';
            }
            return false;
        }
        run.rowVersion = result.rowVersion;
        run.generation = result.sweepGeneration;
        if (checkpoint !== null) {
            checkpoint.rowVersion = result.rowVersion;
            checkpoint.sweepGeneration = result.sweepGeneration;
        }
        storedCursor = null;
        return true;
    };

    /** Claim the row, or explain why no scan can run. */
    let run: CheckpointRun | null = null;

    /**
     * ONE bounded release attempt, used by the `finally` below and by nothing
     * else.
     *
     * It runs on EVERY exit — a returned report, a thrown `listPendingIngests`,
     * a thrown checkpoint operation — because the cleanup guarantee has to hold
     * when the pass fails, not only when it succeeds. Four rules keep it from
     * making things worse:
     *
     *  - at most one attempt, ever (`releaseAttempted`): no retry loop, and no
     *    renewal, so a lease is never extended by cleanup;
     *  - it does nothing once `ownershipLost` is set: a failed CAS already
     *    proved another worker holds the row, and writing to it would be a write
     *    against someone else's lease;
     *  - it does nothing once the local lease deadline has passed: a lease that
     *    expired cannot be released or renewed without a re-claim, so asking
     *    would be a renewal in disguise;
     *  - it never throws. A release failure is recorded on the report
     *    (`released: false` plus a `failure`), and the ORIGINAL error — if the
     *    pass is already unwinding — continues untouched.
     *
     * It mutates the shared `checkpoint` object, so the outcome is visible on the
     * report the caller already holds (see `buildReport`).
     */
    const releaseOnce = async (): Promise<void> => {
        if (run === null || checkpoint === null || releaseAttempted) return;
        releaseAttempted = true;
        if (ownershipLost) return;
        if (now() >= run.expiresAtMs) {
            if (checkpoint.failure === null) checkpoint.failure = 'lease-expired';
            return;
        }
        try {
            const release = await run.port.release({
                owner: run.owner,
                expectedRowVersion: run.rowVersion,
                nowMs: now(),
            });
            checkpoint.released = release.released;
            if (!release.released && checkpoint.failure === null) {
                checkpoint.failure = release.reason ?? 'unknown';
            }
        } catch {
            // The row may still be ours, but the release did not happen. Record
            // it on the report; never replace the caller's error with this one.
            if (checkpoint.failure === null) checkpoint.failure = 'release-error';
        }
    };

    try {
        if (checkpointDeps !== null && checkpoint !== null && checkpointLeaseMs !== null) {
            const claimedAtMs = now();
            const claim = await checkpointDeps.port.claim({
                owner: checkpointDeps.owner,
                nowMs: claimedAtMs,
                leaseMs: checkpointLeaseMs,
            });
            if (!claim.claimed || claim.state === null) {
                stopReason = 'checkpoint-unavailable';
                checkpoint.failure = claim.reason ?? 'unknown';
                return buildReport();
            }
            checkpoint.claimed = true;
            checkpoint.rowVersion = claim.state.rowVersion;
            checkpoint.sweepGeneration = claim.state.sweepGeneration;
            run = {
                port: checkpointDeps.port,
                owner: checkpointDeps.owner,
                leaseMs: checkpointLeaseMs,
                rowVersion: claim.state.rowVersion,
                generation: claim.state.sweepGeneration,
                expiresAtMs: claimedAtMs + checkpointLeaseMs,
            };
            // The durable row decides where the pass starts. An explicit `after` is
            // an OVERRIDE and is accepted only when it names the stored position
            // exactly; a caller must not be able to skip work, and a stale value
            // must not rewind a concurrent worker. A refusal does no work at all.
            if ('after' in options && !sameRecoveryCursor(options.after ?? null, claim.state.cursor)) {
                stopReason = 'cursor-override-rejected';
                checkpoint.failure = 'cursor-override-rejected';
                // No explicit release: `finally` releases once, and only while the
                // row is still ours.
                return buildReport();
            }
            cursor = claim.state.cursor;
            lastInspected = claim.state.cursor;
            storedCursor = claim.state.cursor;
        }

        while (true) {
            if (consumed >= batchCap) {
                stopReason = 'batch-cap';
                break;
            }
            if (now() - startedAt >= wallClockMs) {
                stopReason = 'wall-clock';
                break;
            }
            // Ownership and time are checked before every ADDITIONAL page: a lease
            // that expired mid-pass cannot advance, release or renew without a fresh
            // claim, so another page would be work this worker cannot persist.
            if (run !== null && now() >= run.expiresAtMs) {
                stopReason = 'checkpoint-lease-lost';
                break;
            }

            const page = await deps.source.listPendingIngests({ after: cursor, limit: pageSize, nowMs: now() });
            pages += 1;
            if (page.length === 0) {
                // Nothing left from the stored position. With a checkpoint this is
                // still a durable transition: the reset is the CAS that clears the
                // cursor and bumps the generation.
                if (run !== null && !await completeSweepAt(run)) break;
                sweepComplete = true;
                break;
            }

            let stoppedMidPage = false;
            for (const row of page) {
                if (consumed >= batchCap) {
                    stopReason = 'batch-cap';
                    stoppedMidPage = true;
                    break;
                }
                if (now() - startedAt >= wallClockMs) {
                    stopReason = 'wall-clock';
                    stoppedMidPage = true;
                    break;
                }

                consumed += 1;
                tally.scanned += 1;
                lastInspected = { occurredAtMs: row.occurredAtMs, id: row.id };

                const used = attempts.get(row.id) ?? 0;
                if (used >= maxAttemptsPerRow) {
                    tally.skipped += 1;
                    bump(tally.skippedReasons, 'attempt-cap');
                    continue;
                }
                attempts.set(row.id, used + 1);

                let result: RecordingResumeResult;
                try {
                    // The service re-checks the row, the session, the tenant, the
                    // grace window and the caps, and fences with the same CAS a
                    // callback uses. A row it cannot claim is skipped there.
                    result = await deps.service.resumePending({
                        tenantId: row.tenantId,
                        provider: row.provider,
                        eventId: row.eventId,
                    });
                } catch {
                    // Unknown outcome: the marker was not moved by this call, so it
                    // stays resumable. Reported as deferred — never as done. It is
                    // deliberately not counted as `claimed`: the throw may have
                    // landed before or after the claim unit, and the lease on the
                    // row — not this report — is the record of who holds it.
                    tally.deferred += 1;
                    bump(tally.deferredReasons, 'resume-error');
                    continue;
                }

                tallyResult(tally, result);
            }

            const lastRow = page[page.length - 1];
            const pageEnd: RecordingRecoveryCursor = { occurredAtMs: lastRow.occurredAtMs, id: lastRow.id };
            const shortPage = page.length < pageSize;

            if (stoppedMidPage) {
                // Only the prefix that was actually inspected is persisted. The rows
                // after `lastInspected` were never looked at, so writing `pageEnd`
                // here would skip them — the one thing a crash must never do.
                if (run !== null && lastInspected !== null && !sameRecoveryCursor(lastInspected, storedCursor)) {
                    await persistCursor(run, lastInspected);
                }
                break;
            }

            if (run !== null) {
                if (shortPage) {
                    // The last page IS the end of the sweep: one CAS resets the
                    // cursor and bumps the generation. Advancing first would need a
                    // second CAS and leave a window in which a crash stores a
                    // position the next pass would then have to re-read.
                    if (!await completeSweepAt(run)) break;
                    sweepComplete = true;
                    break;
                }
                if (!await persistCursor(run, pageEnd)) break;
                continue;
            }

            cursor = pageEnd;
            // A short page is the end of the pending set as of this pass.
            if (shortPage) {
                sweepComplete = true;
                break;
            }
        }

        // No release here: `finally` owns it, exactly once, on every exit.
        return buildReport();
    } finally {
        await releaseOnce();
    }
}
