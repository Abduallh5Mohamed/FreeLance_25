/**
 * W10-R2 — live recording ingest into the media library.
 *
 * A provider finishes a recording and calls back. Three things must be true
 * before any library row exists, and this module enforces all three in order:
 *
 *  1. the callback is SIGNATURE-VERIFIED by an injected verifier — an
 *     unverified payload is ignored and audited, never ingested;
 *  2. the session is resolved from SERVER rows by the provider room id, and the
 *     tenant comes from that row — a signed tenant claim that disagrees is
 *     rejected, so a recording can never be filed under another tenant;
 *  3. the (tenant, provider, event) and (tenant, provider, recording) pairs are
 *     deduplicated, so a replayed callback or a second event for the same
 *     recording never produces a second library asset.
 *
 * What the ingest produces is a DESCRIPTOR, not an entitlement. A recording
 * lands as `visibility: 'unpublished'` with `accessPolicy: 'deny'`: publishing
 * a class recording is a product/privacy decision (who may watch a recorded
 * lesson, for how long, and whether guardians consented) that this module does
 * NOT take. `planRecordingAsset` therefore always returns `publishable: false`
 * and the caller has to pass an explicit decision to change it.
 *
 * ORDER: LIBRARY FIRST, THEN METERING, AND THE METER IS KEYED BY THE RECORDING
 * (2026-10-23). The meter used to run BEFORE the library write with a synthetic
 * `provider:recording` asset id. That is gone, because a synthetic id is not an
 * ownership proof and because the operation id was `provider:eventId` — so the
 * same recording delivered under a DIFFERENT event charged storage twice.
 *
 * The order is now:
 *
 *   1. idempotent library promotion (create, or read back the existing row);
 *   2. validation of the PROMOTED identity — canonical `assetId`, the tenant it
 *      was filed under, and the owner it was filed for. The port answers with
 *      those facts and the service refuses to meter if any of them disagrees
 *      with this callback;
 *   3. storage metering with that REAL asset id and an operation id built from
 *      `(tenant, provider, providerRecordingId, stage)` — never from the event.
 *      `buildStorageIdempotencyKey` composes `st:{assetId}:{operationId}`, so
 *      two different delivery events for one recording produce the SAME key and
 *      the second is a meter duplicate, not a second charge;
 *   4. the terminal unit.
 *
 * A meter that cannot complete leaves the marker `pending` and hands the lease
 * back, because a library success followed by a meter failure is exactly the
 * crash window this order creates and it must stay repairable. The meter's own
 * idempotency (same key) is what makes the retry safe; this module cannot
 * enforce it and says so.
 *
 * Terminality requires the library AND the storage accounting. A marker becomes
 * `ingested` only when the library answered `created`/`existing` AND the meter
 * recorded or proved a duplicate. Every other case leaves the marker `pending`
 * with its lease released:
 *
 *   - library absent (`unconfigured`) or refused ⇒ `library-*`;
 *   - meter absent ⇒ `metering-unconfigured`;
 *   - meter configured but failed or gave an unusable answer ⇒ `metering-*`.
 *
 * An absent meter is NOT a policy exemption (2026-10-23 correction). It used to
 * report `unconfigured` and settle `ingested` with `storageAccounted: false`,
 * which destroyed the obligation: a same-event retry answers `duplicate` and the
 * recovery pass only scans `pending`, so nothing could ever charge those bytes.
 * The row now stays `pending`, and composing a meter later lets ONE redelivery
 * finish the charge against the same promoted asset and the same
 * recording/stage key.
 *
 * RECOVERY ELIGIBILITY — the exact limit, stated because it is not solved. A
 * row held `pending` for a missing meter is recoverable only while it stays
 * inside the grace window: once `occurredAtMs > endedAtMs + graceMs` the pass
 * quarantines it as `ignored:outside-grace` and the storage accounting is lost
 * for good. Grace and quarantine were deliberately NOT changed to carve out an
 * exception for incomplete accounting — a row that can never be settled must
 * still leave the pending set, or it starves every later row. Until a durable
 * meter outbox exists, "recoverable" therefore means "recoverable before the
 * grace window closes".
 *
 * REPLAY CONTRACT (what is and is not promised). External effects are never
 * rolled back by a database rollback: an asset created before a meter failure
 * stays created, and bytes recorded before a terminal-unit failure stay
 * recorded. What makes the replay safe is that every step is keyed on the
 * RECORDING — library on `(tenant, provider, providerRecordingId)`, meter on
 * `(real assetId, tenant:provider:recording:storage)` — so a replay converges on
 * the same two records instead of creating new ones. If either port loses
 * idempotency, this contract is void, and this module cannot detect that.
 *
 * Split units — what is and is not atomic
 *   The claim unit (ledger row plus its lease owner), the external meter and
 *   library calls, and the terminal unit are THREE SEPARATE UNITS. External
 *   effects are NOT rolled back: an asset created before a terminal-unit
 *   failure stays created. The fence stops two writers from both DECLARING a
 *   terminal transition; it does not undo either writer's irreversible effect.
 *   Sink idempotency is what prevents a duplicate irreversible effect, and it
 *   is a requirement on both ports, not something this module can enforce.
 *
 *   An UNKNOWN external outcome — a throw, or a response that never arrives —
 *   does not authorise a duplicate irreversible effect. The row stays `pending`
 *   with its lease, the lease expires, and only then may another attempt claim
 *   it. That retry is safe only because the meter and the library are key-
 *   idempotent; if either port loses that property this contract is void.
 *
 * What is NOT claimed: there is no durable adapter and no MySQL behaviour is
 * asserted anywhere in this file. The in-memory adapter is a SEAM MODEL — no
 * isolation level, no deadlock, no `ER_DUP_ENTRY`, no crash. A provider replay
 * of a `pending` row now repairs it (fenced claim + idempotent sinks); a row
 * whose provider never redelivers still needs the reconciliation sweep (R9),
 * which does not exist.
 *
 * Durable adapter and bounded recovery (2026-10-23)
 *   `live-recording-ingest-sql.ts` implements this port over ONE injected
 *   connection; `live-recording-recovery.ts` drives `resumePending` below. Two
 *   corrections land here and are visible in the result union:
 *
 *   - a duplicate on a `pending` row is NOT "completed". After a lost insert
 *     the service re-reads the conflicting row inside the SAME unit and either
 *     fences it (`claimPending`) or reports `claim-held`; only a row that is
 *     already terminal is reported as `duplicate`;
 *   - a terminal replay compares the persisted payload (session, recording id,
 *     duration, bytes) with the incoming one and reports `conflict` on a
 *     disagreement instead of calling it a duplicate.
 *
 *   `resumePending` is the recovery entry point. It skips SIGNATURE
 *   VERIFICATION and nothing else: the payload was verified when the marker was
 *   claimed, and the persisted row is the evidence. It still re-reads the
 *   session row by `(tenant, session)`, the tenant, the grace window and the
 *   caps, then drives the same claim / external / terminal units a callback
 *   drives — one writer, one fence, one set of sink keys, one audit shape.
 *
 * Permanently ineligible rows leave the pending set (2026-10-23 correction)
 *   A row can be claimed while the session is still `live` (no grace check at
 *   claim time) and then fail in the library. If the session later `ended`, the
 *   row stays `pending`, every later pass re-reads it, the grace check refuses
 *   it, and — before this correction — nothing settled the marker. Enough such
 *   rows starve every later row for ever, because the bounded sweep restarts at
 *   the beginning each pass.
 *
 *   `runVerified` therefore performs a FENCED terminal transition when, and
 *   only when, it holds the fence and can prove the row can never become
 *   ingestible:
 *
 *   - `outside-grace` → `ignored:outside-grace`, proven by re-reading the
 *     session row inside the same unit: `state === 'ended'`,
 *     `endedAtMs !== null`, `occurredAtMs > endedAtMs + graceMs`. `ended` is
 *     terminal, so `endedAtMs` cannot move later and the proof cannot expire.
 *   - `cancelled` + `session-not-ingestible` → `ignored:session-cancelled`,
 *     proven the same way. `cancelled` is terminal too.
 *
 *   A `scheduled` session is TRANSIENT (it can still go `live`) and stays
 *   `pending`. So do a library throw, a meter error, `claim-held`, an unknown
 *   session, a read failure and the descriptor caps. Nothing here invents a
 *   success: the audit is `live.recording.ignored` with the proof facts, never
 *   `live.recording.ingested`, and a `finalizeIngest` that affects 0 rows
 *   writes no audit at all.
 *
 *   No DDL: `live_recording_ingests.outcome` is `VARCHAR(32)` with no CHECK
 *   (migration 06: "pending is transient; terminal values are written by the
 *   adapter"), so `ignored:outside-grace` (20 chars) and
 *   `ignored:session-cancelled` (25 chars) fit, and
 *   `chk_live_ingest_terminal_release` is satisfied because `finalizeIngest`
 *   clears the lease in the same statement as the outcome.
 *
 * No provider SDK, no network, no media bytes, no DRM, no runtime DDL, no
 * invented schema: the durable tables are the I2 request in the delivery note.
 */
import { createHash, randomUUID } from 'crypto';
import type { AuditRecordInput } from '../security/audit';

/* =========================================================================
 * Bounds
 * ========================================================================= */

export const MAX_RECORDING_SECONDS = 12 * 60 * 60;
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024 * 1024;
export const DEFAULT_RECORDING_GRACE_SECONDS = 6 * 60 * 60;
export const MAX_RECORDING_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const RECORDING_TITLE_MAX_LENGTH = 200;

/** Upper bound for a claim owner token; the ledger column is sized to match. */
export const RECORDING_CLAIM_OWNER_MAX_LENGTH = 64;

/**
 * `video_assets.owner_user_id` is `CHAR(36)` and the library port refuses a
 * longer id with `owner_missing`, so an id that cannot be stored is not a
 * usable owner. A value beyond this bound becomes `null` in the descriptor
 * rather than a promotion that is refused later.
 */
const RECORDING_OWNER_USER_ID_MAX_LENGTH = 36;

/**
 * How long a resume claim on a ledger row stays valid.
 *
 * Trade-off: too short and a slow external call can outlive its own lease,
 * letting a second delivery claim the row while the first is still writing
 * (the sinks stay idempotent, but two attempts then race to declare the
 * transition); too long and an attempt that died between the claim and the
 * terminal unit blocks every other delivery for that long. Five minutes is
 * longer than the two external calls are allowed to take and shorter than a
 * provider's usual redelivery backoff.
 */
export const RECORDING_INGEST_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * The access policy a recording is created with. `deny` is the only value this
 * module ever emits on its own; the rest exist so the port can express a later,
 * explicitly decided publication instead of inventing a boolean.
 */
export const RECORDING_ACCESS_POLICIES = ['deny', 'session-participants', 'enrolled', 'tenant-instructors'] as const;
export type RecordingAccessPolicy = (typeof RECORDING_ACCESS_POLICIES)[number];

export const RECORDING_VISIBILITIES = ['unpublished', 'published'] as const;
export type RecordingVisibility = (typeof RECORDING_VISIBILITIES)[number];

export function normalizeAccessPolicy(value: unknown): RecordingAccessPolicy | null {
    if (typeof value !== 'string') return null;
    return (RECORDING_ACCESS_POLICIES as readonly string[]).includes(value)
        ? (value as RecordingAccessPolicy)
        : null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function normalizeRecordingId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return ID_RE.test(trimmed) ? trimmed : null;
}

export function normalizeProviderKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return PROVIDER_KEY_RE.test(trimmed) ? trimmed : null;
}

/* =========================================================================
 * External sink keys (pure, deterministic)
 * ========================================================================= */

/**
 * The stages a recording's storage history is measured in. A closed union, not a
 * free string: the stage is part of the meter's idempotency identity, and an
 * invented stage name would silently become a second charge.
 *
 * IMMUTABLE STAGE MAP — `(tenant, provider, providerRecordingId, stage)` is the
 * storage operation identity. Adding a stage is a schema-visible decision, not a
 * refactor.
 */
export const RECORDING_METER_STAGES = ['storage'] as const;
export type RecordingMeterStage = (typeof RECORDING_METER_STAGES)[number];

/**
 * Meter operation id: the RECORDING's storage stage, never the delivery event.
 *
 * `provider:eventId` was the old key and it was wrong: the same recording
 * delivered under a second provider event charged storage twice. The identity
 * now belongs to `(tenant, provider, providerRecordingId, stage)`, so every
 * delivery of the same recording produces the same id.
 *
 * Bounded to the meter's `OPERATION_ID_RE` (`^[A-Za-z0-9:_.-]{1,200}$`): the
 * readable form is kept when it fits, otherwise a full sha256 digest is used.
 * The tenant prefix stops two tenants' identically-named recordings from
 * collapsing into one meter key.
 */
export function buildRecordingMeterOperationId(input: {
    tenantId: string;
    provider: string;
    providerRecordingId: string;
    stage: RecordingMeterStage;
}): string {
    const raw = `live:${input.stage}:${input.tenantId}:${input.provider}:${input.providerRecordingId}`;
    if (raw.length <= 200) return raw;
    const digest = createHash('sha256').update(raw).digest('hex');
    return `live:${input.stage}:h:${digest}`;
}

/**
 * Is this the meter's notion of a canonical asset id?
 *
 * `ASSET_ID_RE` on the meter side is `^[A-Za-z0-9_-]{1,128}$` — no colon, which
 * is exactly why the old `provider:recording` synthetic id could never be a real
 * asset id. This predicate is used to refuse metering when the library answered
 * with something the meter would reject anyway, so the refusal is a named reason
 * instead of a generic meter error.
 */
export function isCanonicalAssetId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * The library's dedupe key: `(tenantId, provider, providerRecordingId)`,
 * NUL-separated so no component can shift another. `createRecordingAsset` MUST
 * be idempotent on exactly these three values and answer the existing `assetId`
 * with `created: false`. This helper exists so a durable adapter cannot invent a
 * different tuple; the COLUMNS, not this string, are the uniqueness constraint.
 */
export function buildRecordingAssetDedupeKey(tenantId: string, provider: string, providerRecordingId: string): string {
    return `${tenantId}\u0000${provider}\u0000${providerRecordingId}`;
}

function toNonNegativeInt(value: unknown): number | null {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
}

export function normalizeGraceSeconds(value: unknown): number {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_RECORDING_GRACE_SECONDS;
    return Math.min(MAX_RECORDING_GRACE_SECONDS, Math.max(0, parsed));
}

/* =========================================================================
 * Descriptor (pure)
 * ========================================================================= */

export interface RecordingSessionRef {
    id: string;
    tenantId: string;
    title: string;
    state: 'scheduled' | 'live' | 'ended' | 'cancelled';
    endedAtMs: number | null;
    /**
     * The session host the recording belongs to, copied from
     * `live_sessions.host_user_id`. Optional because a session reference can be
     * built without it (the in-memory seam does); absent means "no owner is
     * known", never "use the tenant".
     */
    hostUserId?: string | null;
}

export interface RecordingAssetDescriptor {
    kind: 'live-recording';
    tenantId: string;
    sessionId: string;
    /**
     * The session host, carried because `video_assets.owner_user_id` is
     * `CHAR(36) NOT NULL`: without it the library port refuses every promotion
     * with `owner_missing`. `null` means the session row carried no usable
     * owner — it is never a sentinel, the tenant id or the provider.
     */
    ownerUserId: string | null;
    provider: string;
    providerRecordingId: string;
    title: string;
    durationSeconds: number;
    storageBytes: number;
    /** Always `deny` at ingest; publication is a separate, explicit decision. */
    accessPolicy: RecordingAccessPolicy;
    visibility: RecordingVisibility;
    publishable: boolean;
    sourceEventId: string;
    recordedAtMs: number;
}

export type RecordingPlanRefusal =
    | 'invalid-duration'
    | 'duration-cap'
    | 'invalid-bytes'
    | 'bytes-cap'
    | 'session-not-ingestible';

export type RecordingPlanResult =
    | { ok: true; descriptor: RecordingAssetDescriptor }
    | { ok: false; reason: RecordingPlanRefusal };

/**
 * Build the library descriptor for a verified recording payload. Pure: no
 * store, no clock beyond the supplied values, no decision about publication.
 */
export function planRecordingAsset(input: {
    session: RecordingSessionRef;
    provider: string;
    providerRecordingId: string;
    sourceEventId: string;
    durationSeconds: unknown;
    storageBytes: unknown;
    recordedAtMs: number;
    title?: string | null;
}): RecordingPlanResult {
    const duration = toNonNegativeInt(input.durationSeconds);
    if (duration === null || duration <= 0) return { ok: false, reason: 'invalid-duration' };
    if (duration > MAX_RECORDING_SECONDS) return { ok: false, reason: 'duration-cap' };
    const bytes = toNonNegativeInt(input.storageBytes);
    if (bytes === null) return { ok: false, reason: 'invalid-bytes' };
    if (bytes > MAX_RECORDING_BYTES) return { ok: false, reason: 'bytes-cap' };
    // A cancelled session has no class to publish; a scheduled one never
    // happened. Only a live/ended session can produce an ingestible recording.
    if (input.session.state !== 'ended' && input.session.state !== 'live') {
        return { ok: false, reason: 'session-not-ingestible' };
    }

    // The owner travels with the descriptor because `video_assets.owner_user_id`
    // is NOT NULL: without it the library port refuses every promotion with
    // `owner_missing` and the marker stays pending forever. An id that is
    // absent, malformed or too long for CHAR(36) becomes `null` — never the
    // tenant id, never a sentinel — so the port's refusal stays visible instead
    // of being papered over with a wrong owner.
    const ownerCandidate = normalizeRecordingId(input.session.hostUserId ?? null);
    const ownerUserId = ownerCandidate !== null && ownerCandidate.length <= RECORDING_OWNER_USER_ID_MAX_LENGTH
        ? ownerCandidate
        : null;

    const baseTitle = typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : input.session.title;
    const title = baseTitle.slice(0, RECORDING_TITLE_MAX_LENGTH) || 'Session recording';

    return {
        ok: true,
        descriptor: {
            kind: 'live-recording',
            tenantId: input.session.tenantId,
            sessionId: input.session.id,
            ownerUserId,
            provider: input.provider,
            providerRecordingId: input.providerRecordingId,
            title,
            durationSeconds: duration,
            storageBytes: bytes,
            accessPolicy: 'deny',
            visibility: 'unpublished',
            publishable: false,
            sourceEventId: input.sourceEventId,
            recordedAtMs: input.recordedAtMs,
        },
    };
}

/* =========================================================================
 * Store / library / meter ports
 * ========================================================================= */

export interface RecordingIngestRow {
    id: string;
    tenantId: string;
    sessionId: string;
    provider: string;
    eventId: string;
    providerRecordingId: string;
    durationSeconds: number;
    storageBytes: number;
    occurredAtMs: number;
    outcome: string;
    /**
     * The attempt that currently owns this row, or `null` when no lease is
     * held. Written by the insert (the unique-key insert is the CAS for a first
     * delivery) and by `claimPending` on a resume.
     */
    claimOwner: string | null;
    /** Epoch ms after which another attempt may claim the row. Written with
     *  `claimOwner`, cleared with it; never set one without the other. */
    claimExpiresAtMs: number | null;
}

/**
 * Ingest ledger. Two unique keys are required from the durable adapter:
 * `(tenant_id, provider, event_id)` for callback replay and
 * `(tenant_id, provider, provider_recording_id)` for a second event naming the
 * same recording.
 */
/**
 * The unit of work. Every method must run on the SAME connection as the
 * enclosing `withTransaction` unit; a durable adapter that splits them cannot
 * keep the ledger marker and its audit together.
 */
export interface RecordingIngestUnit {
    findSessionByProviderRoom(provider: string, providerRoomId: string): Promise<RecordingSessionRef | null>;
    /**
     * Tenant-scoped session read by id, used by `resumePending`: a persisted
     * ledger row carries `session_id`, not the provider room id, so a resume has
     * no room to resolve. Optional on the port — when absent a resume is
     * refused (`skipped / session-read-unavailable`) because the session row
     * cannot be re-checked, and a resume that cannot re-check the session is
     * exactly the blind replay this path must not become.
     */
    findSessionById?(tenantId: string, sessionId: string): Promise<RecordingSessionRef | null>;
    /** Reads the marker for one provider event, so a replay can tell a settled
     *  row from a `pending` one that still needs repair. */
    findIngest(tenantId: string, provider: string, eventId: string): Promise<RecordingIngestRow | null>;
    /** Returns `{ inserted: false }` when either unique key already exists. The
     *  row carries `claimOwner`/`claimExpiresAtMs`: the unique-key insert is the
     *  CAS for a first delivery, so the inserter legitimately owns the row. */
    insertIngest(row: RecordingIngestRow): Promise<{ inserted: boolean; reason: 'event-replay' | 'recording-exists' | null }>;
    /**
     * Takes ownership of a `pending` row. Durable form, ONE statement:
     *
     *   UPDATE live_recording_ingests
     *      SET claim_owner = ?, claim_expires_at_ms = ?
     *    WHERE id = ? AND outcome = 'pending'
     *      AND (claim_owner IS NULL OR claim_expires_at_ms <= ?)
     *
     * Returns the affected-row count: 1 = this attempt owns the row and may run
     * the external calls; 0 = it does not and must not. Optional on the port —
     * when absent, a `pending` row is NOT resumed (fail closed).
     */
    claimPending?(input: { id: string; owner: string; nowMs: number; leaseUntilMs: number }): Promise<number>;
    /**
     * Guarded transition. Durable form, ONE statement:
     *
     *   UPDATE live_recording_ingests
     *      SET outcome = ?, claim_owner = NULL, claim_expires_at_ms = NULL
     *    WHERE id = ? AND outcome = 'pending' AND claim_owner = ?
     *
     * Returns the affected-row count. Any other outcome value is TERMINAL and a
     * 0 means this attempt lost the row: it must not write a success audit.
     * `outcome: 'pending'` is the RELEASE form — a known non-terminal result
     * hands the row back without waiting out its own lease. It is the only
     * non-terminal use of this statement.
     *
     * Terminal values written by this service: `ingested`, plus the two
     * quarantines `ignored:outside-grace` and `ignored:session-cancelled`
     * (see `RecordingQuarantineReason`). Both fit the `VARCHAR(32)` column and
     * the statement clears the lease, so `chk_live_ingest_terminal_release`
     * holds for them exactly as it does for `ingested`.
     */
    finalizeIngest(input: { id: string; outcome: string; expect: { owner: string } }): Promise<number>;
    recordAudit(input: AuditRecordInput): Promise<void>;
}

export interface RecordingIngestStore extends RecordingIngestUnit {
    /**
     * MANDATORY for every ledger write. Commits when `work` resolves, rolls the
     * whole unit back when it throws. Absent ⇒ the service refuses with
     * `transaction-required` and writes nothing.
     */
    withTransaction?<T>(work: (unit: RecordingIngestUnit) => Promise<T>): Promise<T>;
}

/**
 * What a promotion answered, INCLUDING the facts the meter depends on.
 *
 * `assetId` alone is not enough to meter safely: the meter is charged against a
 * tenant and an asset, so the port must answer with the tenant the row was filed
 * under and the owner it was filed for. The service compares both with this
 * callback's own facts and refuses to meter on a disagreement — an asset owned
 * by someone else is not this recording's asset, even when the id is the one the
 * unique key produced.
 */
export interface RecordingLibraryAsset {
    created: boolean;
    assetId: string;
    /** The tenant the row is filed under, as proven by the port. */
    tenantId: string;
    /** The owner the row carries. Never a sentinel, never the tenant id. */
    ownerUserId: string;
}

export interface RecordingLibraryPort {
    /**
     * Creates the library asset.
     *
     * Dedupe contract — this port MUST be idempotent on
     * `(tenantId, provider, providerRecordingId)` (`buildRecordingAssetDedupeKey`
     * produces that tuple): a second call for the same recording returns the
     * EXISTING `assetId` with `created: false` and writes nothing. Resume and
     * retry are safe only because of this; an adapter that creates a second
     * asset on a retry turns every unknown external outcome into a duplicate
     * irreversible effect.
     *
     * It must also REFUSE rather than answer with another tenant's asset: the
     * global provider-key collision stays fail-closed.
     */
    createRecordingAsset(descriptor: RecordingAssetDescriptor): Promise<RecordingLibraryAsset>;
}

/** Structural port satisfied by `MediaMeteringService`. */
export interface RecordingStorageMeterPort {
    recordVerifiedBytes(input: {
        tenantId: unknown;
        assetId: unknown;
        resultingBytes: unknown;
        operationId: unknown;
        source: unknown;
        occurredAtMs?: unknown;
    }): Promise<{ recorded: boolean; deduplicated: boolean } | { error: string }>;
}

/**
 * What happened to storage accounting.
 *
 *  - `recorded` / `deduplicated` — the meter holds this recording's bytes, and a
 *    replay was absorbed by the idempotency key;
 *  - `deferred` — a meter IS configured and did not complete. Retryable;
 *  - `unconfigured` — no meter is composed. A policy state, not a failure;
 *  - `not-attempted` — there was no proven asset to meter (the library did not
 *    answer). Distinct from `deferred` on purpose: nothing was tried.
 */
export type RecordingMeteringOutcome =
    | 'recorded'
    | 'deduplicated'
    | 'deferred'
    | 'unconfigured'
    | 'not-attempted';

export type RecordingLibraryOutcome = 'created' | 'existing' | 'unconfigured' | 'deferred';

/* =========================================================================
 * Service
 * ========================================================================= */

export type RecordingCallbackInput = {
    provider: string;
    eventId: string;
    signature: string;
    providerRoomId: string;
    providerRecordingId: string;
    durationSeconds: unknown;
    storageBytes: unknown;
    occurredAtMs?: number;
    /** Optional signed tenant claim, verified against the session row. */
    tenantId?: string | null;
    title?: string | null;
};

export type RecordingCallbackResult =
    | {
        status: 'ingested';
        assetId: string | null;
        metering: RecordingMeteringOutcome;
        library: RecordingLibraryOutcome;
        visibility: RecordingVisibility;
        /**
         * Storage accounting, as a positive assertion on the result rather than
         * something the caller has to infer.
         *
         * It is `true` on every `ingested` BY CONSTRUCTION (terminality now
         * requires `recorded`/`deduplicated`), so a caller that reads
         * `status: 'ingested'` and `storageAccounted: true` is reading the same
         * fact twice — which is the point: an unaccounted recording can no
         * longer reach this variant at all, it comes back `deferred` with
         * `metering-unconfigured`.
         */
        storageAccounted: boolean;
    }
    | { status: 'duplicate'; reason: 'event-replay' | 'recording-exists' }
    /**
     * The event is already settled and the payload arriving now describes a
     * DIFFERENT recording: a different session, provider recording id, duration
     * or byte count. That is not a duplicate — a duplicate says "this is the
     * same event again", a conflict says "this event id is being reused for
     * something else". Nothing is re-driven and nothing is overwritten; the
     * stored row stays the record. `fields` names every compared field that
     * disagreed (see `RECORDING_REPLAY_COMPARED_FIELDS`).
     */
    | { status: 'conflict'; reason: 'payload-mismatch'; fields: RecordingReplayMismatchField[] }
    /**
     * NOT a success and NOT terminal. The marker is still `pending` and the
     * event stays repairable by a later delivery. One variant per reason:
     *
     *  - `library-unconfigured` — the required sink was absent; nothing was
     *    written, so settling would be a terminal fake success (D1);
     *  - `library-error` — the required sink threw; the outcome is unknown, so
     *    no irreversible effect may be repeated and no success may be declared;
     *  - `library-owner-mismatch` — the recording's key already belongs to an
     *    asset filed for a DIFFERENT owner in this tenant. Metering it would
     *    charge one person's storage to another, so it stops here;
     *  - `library-cross-tenant` — the global provider key is held by another
     *    tenant. Fail-closed: never the other tenant's asset, never a merge;
     *  - `library-key-collision` — the unique index matched a key that is not
     *    byte-identical (a case-insensitive collation collision). Not a repeat;
     *  - `metering-unconfigured` — no meter is composed. NOT an exemption and
     *    NOT terminal: the storage obligation is outstanding, so the marker
     *    stays `pending` and a later delivery (after a meter is installed)
     *    finishes the charge against the same asset and the same
     *    recording/stage key;
     *  - `metering-error` — the meter answered an error or threw AFTER the asset
     *    existed. Retryable: the retry reuses the same asset id and operation
     *    id, so it converges instead of charging twice;
     *  - `metering-unknown` — the meter answered something that is neither
     *    recorded nor deduplicated. A sink that cannot distinguish
     *    "already applied" from "unknown" is deferred, never assumed;
     *  - `metering-identity-unproven` — the promoted asset could not be proven
     *    (non-canonical id, unproven owner). No metering without an identity;
     *  - `claim-unavailable` — the adapter has no `claimPending`, so a pending
     *    row cannot be fenced; refusing is safer than two unfenced writers;
     *  - `claim-held` — another attempt holds an unexpired lease;
     *  - `claim-lost` — the guarded terminal transition affected 0 rows; the
     *    asset may exist but the ledger transition is not this attempt's.
     */
    | {
        status: 'deferred';
        reason:
            | 'library-unconfigured'
            | 'library-error'
            | 'library-owner-mismatch'
            | 'library-cross-tenant'
            | 'library-key-collision'
            | 'metering-unconfigured'
            | 'metering-error'
            | 'metering-unknown'
            | 'metering-identity-unproven'
            | 'claim-unavailable'
            | 'claim-held'
            | 'claim-lost';
    }
    | {
        status: 'ignored';
        reason:
            | 'unverified-signature'
            | 'malformed'
            | 'unknown-session'
            | 'outside-grace'
            | 'invalid-duration'
            | 'duration-cap'
            | 'invalid-bytes'
            | 'bytes-cap'
            | 'session-not-ingestible';
    }
    | { status: 'rejected'; reason: 'cross-tenant' | 'transaction-required' };

export type SignatureVerifier = (callback: RecordingCallbackInput) => boolean | Promise<boolean>;

/** The closed set of "not done yet" reasons, derived from the result union so the two cannot drift. */
export type RecordingDeferredReason = Extract<RecordingCallbackResult, { status: 'deferred' }>['reason'];

/**
 * Map a library refusal to a named reason by its `code`, WITHOUT importing the
 * concrete error class.
 *
 * The port is structural: this module must not depend on the durable adapter's
 * class. A code that is not in the map — including a non-object throw — is
 * `library-error`, which is the honest answer for "it threw and we do not know
 * why". Mapping the three known collisions separately matters because they need
 * different human actions: a cross-tenant key is a data incident, a case
 * collision is a key-hygiene bug, an owner disagreement is a session-ownership
 * question.
 */
const LIBRARY_FAILURE_BY_CODE: Readonly<Record<string, RecordingDeferredReason>> = Object.freeze({
    cross_tenant_collision: 'library-cross-tenant',
    key_collision: 'library-key-collision',
    unresolved_duplicate: 'library-key-collision',
    owner_missing: 'library-owner-mismatch',
    owner_mismatch: 'library-owner-mismatch',
});

function classifyLibraryFailure(error: unknown): RecordingDeferredReason {
    const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : '';
    return LIBRARY_FAILURE_BY_CODE[code] ?? 'library-error';
}

/**
 * What a terminal replay compares. Exactly these four persisted facts — a
 * redelivery may legitimately carry a different `occurred_at_ms` and a
 * different `title` (neither is part of the recording's identity), so neither
 * is compared.
 */
export const RECORDING_REPLAY_COMPARED_FIELDS = [
    'session',
    'provider_recording_id',
    'duration_seconds',
    'storage_bytes',
] as const;

export type RecordingReplayMismatchField = (typeof RECORDING_REPLAY_COMPARED_FIELDS)[number];

/**
 * Pure: which persisted facts disagree with the incoming descriptor. An empty
 * array means "this really is the same event again". No SQL, no store, no
 * clock — the caller decides what a mismatch means.
 */
export function compareRecordingReplayPayload(
    stored: Pick<RecordingIngestRow, 'sessionId' | 'providerRecordingId' | 'durationSeconds' | 'storageBytes'>,
    incoming: { sessionId: string; providerRecordingId: string; durationSeconds: number; storageBytes: number },
): RecordingReplayMismatchField[] {
    const mismatched: RecordingReplayMismatchField[] = [];
    if (stored.sessionId !== incoming.sessionId) mismatched.push('session');
    if (stored.providerRecordingId !== incoming.providerRecordingId) mismatched.push('provider_recording_id');
    if (stored.durationSeconds !== incoming.durationSeconds) mismatched.push('duration_seconds');
    if (stored.storageBytes !== incoming.storageBytes) mismatched.push('storage_bytes');
    return mismatched;
}

/** The narrow input of the recovery entry point: the persisted key, nothing else. */
export interface RecordingResumeInput {
    tenantId: string;
    provider: string;
    eventId: string;
}

/**
 * Why a resume refused to touch a row. None of these is a success, and none of
 * them changes the marker: the row stays exactly as the last writer left it.
 */
export type RecordingResumeSkipReason =
    /** the (tenant, provider, event) triple is not a legal key */
    | 'malformed'
    /** no ledger row for that key — there is nothing to resume */
    | 'not-found'
    /** the store cannot read the session by id, so the row cannot be re-checked */
    | 'session-read-unavailable'
    /** the session the row points at is gone */
    | 'unknown-session'
    /** the row (or the session) belongs to another tenant */
    | 'tenant-mismatch';

/**
 * The two reasons a PENDING row can be proven permanently ineligible inside a
 * fenced unit, and therefore moved out of the pending set:
 *
 *  - `outside-grace` — the session is `ended`, its `endedAtMs` is set and the
 *    event happened after `endedAtMs + graceMs`. `ended` is terminal in
 *    `LEGAL_SESSION_TRANSITIONS`, so `endedAtMs` cannot move later and the
 *    proof cannot expire.
 *  - `session-cancelled` — `cancelled` is terminal too, so no later transition
 *    can make the row ingestible.
 *
 * A `scheduled` session is NOT here: it is transient (it can go `live`), so a
 * `session-not-ingestible` result on a scheduled session must stay `pending`.
 */
export type RecordingQuarantineReason = 'outside-grace' | 'session-cancelled';

/**
 * `resumePending` speaks the callback result union — it must not invent a
 * second taxonomy for the same states — plus two variants only a resume can
 * produce:
 *
 *  - `skipped`, where nothing was claimed and nothing was written;
 *  - `quarantined`, where this call HELD THE FENCE, proved the row can never
 *    become ingestible, and moved it to a terminal `ignored:*` outcome. It is
 *    not `ingested` and not `deferred`: the row left the pending set without
 *    being ingested, and the recovery reports it as its own counter so an
 *    operator can see exactly that.
 *
 * The callback path deliberately does not expose `quarantined` to the
 * provider — it answers `ignored`, which is what it always answered — but it
 * settles the marker through the same fenced transition.
 */
export type RecordingResumeResult =
    | RecordingCallbackResult
    | { status: 'skipped'; reason: RecordingResumeSkipReason }
    | { status: 'quarantined'; reason: RecordingQuarantineReason };

/** What `runVerified` can answer before the callback path flattens it. */
type RecordingVerifiedOutcome =
    | RecordingCallbackResult
    | { status: 'quarantined'; reason: RecordingQuarantineReason };

export interface RecordingIngestService {
    ingest(callback: RecordingCallbackInput): Promise<RecordingCallbackResult>;
    /**
     * Recovery entry point. Deliberately narrow: it takes the persisted key and
     * NOT a payload, so it cannot be used to inject facts a signature never
     * covered. Signature verification is the one step it skips — the marker was
     * only ever written after a verified callback — and it re-checks everything
     * else (row, session, tenant, grace window, caps) before driving the same
     * three units `ingest` drives.
     *
     * A row it can PROVE permanently ineligible answers
     * `{status:'quarantined', reason}` after a fenced terminal transition; the
     * row is no longer `pending`, so a later pass will not re-list it.
     */
    resumePending(input: RecordingResumeInput): Promise<RecordingResumeResult>;
}

export interface RecordingIngestDeps {
    store: RecordingIngestStore;
    library?: RecordingLibraryPort;
    meterStorage?: RecordingStorageMeterPort;
    verifyCallbackSignature: SignatureVerifier;
    now?: () => number;
    idFactory?: () => string;
    graceSeconds?: number;
}

type IngestUnitOutcome<T> = { committed: true; value: T } | { committed: false; reason: 'transaction-required' };

/** What the claim step decided about the provider event. */
type IngestClaim =
    | { kind: 'claimed'; id: string }
    | { kind: 'resume'; id: string }
    /** Already terminal. The row travels with the decision so the caller can
     *  compare the payload before it calls this a duplicate. */
    | { kind: 'settled'; row: RecordingIngestRow }
    /** Pending, but the adapter cannot fence a resume. Fail closed. */
    | { kind: 'unfenced'; id: string }
    /** Pending and owned by another unexpired lease. Fail closed. */
    | { kind: 'contended'; id: string }
    | { kind: 'duplicate'; reason: 'event-replay' | 'recording-exists' };

/** What the terminal unit decided about this attempt's own transition. */
type IngestSettlement = 'ingested' | 'released' | 'lost';

export function createRecordingIngestService(deps: RecordingIngestDeps): RecordingIngestService {
    const store = deps.store;
    const now = deps.now ?? ((): number => Date.now());
    const idFactory = deps.idFactory ?? randomUUID;
    const graceMs = normalizeGraceSeconds(deps.graceSeconds) * 1000;
    const claimLeaseMs = RECORDING_INGEST_CLAIM_LEASE_MS;

    let attemptSeq = 0;
    /**
     * One bounded owner token per `ingest()` call. The counter makes it unique
     * inside this process even if an injected `idFactory` repeats a value; the
     * ledger id keeps two processes apart. It carries no tenant, session or
     * provider data — a ledger id is opaque.
     */
    const nextAttemptOwner = (ledgerId: string): string => {
        attemptSeq += 1;
        const suffix = ledgerId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
        return `att-${attemptSeq}-${suffix}`.slice(0, RECORDING_CLAIM_OWNER_MAX_LENGTH);
    };

    /**
     * Every ledger write goes through here. The unit is mandatory: a store
     * without `withTransaction` is refused and nothing is written, because a
     * marker that commits without its audit is exactly the half-write this
     * correction exists to remove.
     */
    const runUnit = async <T>(work: (unit: RecordingIngestUnit) => Promise<T>): Promise<IngestUnitOutcome<T>> => {
        if (typeof store.withTransaction !== 'function') {
            return { committed: false, reason: 'transaction-required' };
        }
        const value = await store.withTransaction<T>(work);
        return { committed: true, value };
    };

    /**
     * The shared body of a delivery whose facts are already established: a
     * session row (resolved by room for a callback, by id for a resume), a
     * trusted tenant and the recording facts. Signature verification and
     * session resolution stay with the caller; everything below is ONE path, so
     * a resume cannot drift from a callback in its fence, its sink keys or its
     * audit shape.
     */
    const runVerified = async (input: {
        session: RecordingSessionRef;
        provider: string;
        eventId: string;
        providerRecordingId: string;
        durationSeconds: unknown;
        storageBytes: unknown;
        occurredAtMs: number;
        title: string | null;
        nowMs: number;
    }): Promise<RecordingVerifiedOutcome> => {
        const { session, provider, eventId, providerRecordingId } = input;
        const at = input.nowMs;
        const occurredAtMs = input.occurredAtMs;
        const endedAtMs = session.endedAtMs;

        const ledgerId = idFactory();
        const attemptOwner = nextAttemptOwner(ledgerId);
        const claimAtMs = at;
        const leaseUntilMs = claimAtMs + claimLeaseMs;

        /**
         * The terminal proof, evaluated against a session row read INSIDE the
         * fenced unit. `ended` and `cancelled` are terminal in
         * `LEGAL_SESSION_TRANSITIONS` (no transition leaves either), so a proof
         * that holds now still holds later — which is exactly why these two
         * rows may be moved out of `pending` while a `scheduled` row may not.
         */
        const provesTerminal = (fresh: RecordingSessionRef, reason: RecordingQuarantineReason): boolean =>
            reason === 'outside-grace'
                ? fresh.state === 'ended'
                    && fresh.endedAtMs !== null
                    && occurredAtMs > fresh.endedAtMs + graceMs
                : fresh.state === 'cancelled';

        /** The ledger value for a proven-terminal row. Both fit VARCHAR(32). */
        const terminalOutcome = (reason: RecordingQuarantineReason): string =>
            reason === 'outside-grace' ? 'ignored:outside-grace' : 'ignored:session-cancelled';

        /**
         * Move a permanently ineligible PENDING row out of the pending set.
         *
         * Why this exists: a row claimed while the session was still `live`
         * (no grace check at claim time), then failed in the library, stays
         * `pending` after the session `ended`. Every later pass re-reads it,
         * the grace check refuses it, and — before this correction — nothing
         * settled the marker, so the row was re-listed first forever and could
         * consume the whole batch cap. Terminalising it is what makes the
         * bounded sweep self-healing even when a caller discards the
         * continuation.
         *
         * The transition is FENCED: `claimPending` first, then the session is
         * re-read ON THE SAME UNIT, the proof is re-evaluated, and only then
         * does `finalizeIngest` write the terminal outcome. A `0` from either
         * CAS means this attempt does not own the row: no audit, no claim of
         * success, the row is left exactly as the other writer left it.
         *
         * NOT terminalised here: a throw, a meter error, `claim-held`, an
         * unknown session, a read failure, a `scheduled` session, and the
         * descriptor caps. Those are transient (or outside the two reasons this
         * correction is authorised to prove), so they stay `pending`.
         */
        const settleTerminal = async (reason: RecordingQuarantineReason): Promise<RecordingVerifiedOutcome> => {
            type TerminalAttempt =
                | 'quarantined'
                | 'no-row'
                | 'already-terminal'
                | 'unfenced'
                | 'contended'
                | 'not-proven'
                | 'lost';

            const settled = await runUnit<TerminalAttempt>(async (unit) => {
                const row = await unit.findIngest(session.tenantId, provider, eventId);
                if (!row) return 'no-row';
                // Another attempt already moved it: nothing left to settle.
                if (row.outcome !== 'pending') return 'already-terminal';
                if (typeof unit.claimPending !== 'function') return 'unfenced';
                const won = await unit.claimPending({
                    id: row.id,
                    owner: attemptOwner,
                    nowMs: claimAtMs,
                    leaseUntilMs,
                });
                if (won !== 1) return 'contended';
                // Proof must be re-read under the fence; the caller's session
                // read happened outside it. No session port ⇒ no proof.
                if (typeof unit.findSessionById !== 'function') {
                    await unit.finalizeIngest({ id: row.id, outcome: 'pending', expect: { owner: attemptOwner } });
                    return 'not-proven';
                }
                const fresh = await unit.findSessionById(session.tenantId, session.id);
                if (!fresh || fresh.tenantId !== session.tenantId || !provesTerminal(fresh, reason)) {
                    // The reason did not survive the fence: hand the lease back
                    // and leave the marker `pending`.
                    await unit.finalizeIngest({ id: row.id, outcome: 'pending', expect: { owner: attemptOwner } });
                    return 'not-proven';
                }
                const affected = await unit.finalizeIngest({
                    id: row.id,
                    outcome: terminalOutcome(reason),
                    expect: { owner: attemptOwner },
                });
                if (affected !== 1) return 'lost';
                // `live.recording.ignored` — NEVER `live.recording.ingested`.
                // Nothing was ingested; the row is being quarantined, and the
                // audit carries the proof it was quarantined on.
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.ignored',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: reason === 'outside-grace' ? 'outside_grace' : 'session_cancelled',
                    newValue: {
                        session_id: session.id,
                        provider,
                        provider_recording_id: providerRecordingId,
                        ledger_id: row.id,
                        ledger_outcome: terminalOutcome(reason),
                        session_state: fresh.state,
                        ended_at_ms: fresh.endedAtMs,
                        occurred_at_ms: occurredAtMs,
                        grace_ms: graceMs,
                    },
                });
                return 'quarantined';
            });

            if (settled.committed && settled.value === 'quarantined') {
                return { status: 'quarantined', reason };
            }
            if (settled.committed && settled.value === 'contended') {
                return { status: 'deferred', reason: 'claim-held' };
            }
            if (settled.committed && settled.value === 'unfenced') {
                return { status: 'deferred', reason: 'claim-unavailable' };
            }
            if (settled.committed && settled.value === 'lost') {
                return { status: 'deferred', reason: 'claim-lost' };
            }
            // No row (a first delivery refused before any marker existed), a
            // row another attempt already settled, an unprovable reason, or a
            // store without a transaction unit: nothing was written. Report the
            // refusal the way this path always did and leave any marker alone.
            await store.recordAudit({
                actorUserId: null,
                tenantId: session.tenantId,
                action: 'live.recording.ignored',
                resourceType: 'live_recording',
                resourceId: providerRecordingId,
                reason: reason === 'outside-grace' ? 'outside_grace' : 'session_not_ingestible',
                newValue: {
                    session_state: session.state,
                    ended_at_ms: endedAtMs,
                    occurred_at_ms: occurredAtMs,
                    grace_ms: graceMs,
                },
            });
            return {
                status: 'ignored',
                reason: reason === 'outside-grace' ? 'outside-grace' : 'session-not-ingestible',
            };
        };

        if (endedAtMs !== null && occurredAtMs > endedAtMs + graceMs) {
            return settleTerminal('outside-grace');
        }

        const plan = planRecordingAsset({
            session,
            provider,
            providerRecordingId,
            sourceEventId: eventId,
            durationSeconds: input.durationSeconds,
            storageBytes: input.storageBytes,
            recordedAtMs: occurredAtMs,
            title: input.title,
        });
        if (!plan.ok) {
            // A cancelled session is terminal; a scheduled one is not (it can
            // still go `live`), so only `cancelled` is quarantined here. Every
            // other refusal — including the descriptor caps — stays `pending`.
            if (plan.reason === 'session-not-ingestible' && session.state === 'cancelled') {
                return settleTerminal('session-cancelled');
            }
            await store.recordAudit({
                actorUserId: null,
                tenantId: session.tenantId,
                action: 'live.recording.ignored',
                resourceType: 'live_recording',
                resourceId: providerRecordingId,
                reason: plan.reason,
            });
            return { status: 'ignored', reason: plan.reason };
        }
        const descriptor = plan.descriptor;

        // 3. Claim the ledger marker inside ONE unit. The marker is the
        //    callback idempotency key; a `pending` row is a REPAIRABLE claim,
        //    not a duplicate — it means a previous attempt committed the marker
        //    and then failed before its terminal unit, so a replay must finish
        //    the work instead of being refused forever. A resume additionally
        //    needs a FENCE: without one, two deliveries of the same event both
        //    run the external calls and both declare success. The fresh insert
        //    is its own fence (the unique key is the CAS); a resume must win
        //    `claimPending`. `ledgerId` / `attemptOwner` were minted above
        //    because the terminal path needs the same fence token.

        /** Fence a pending row: the CAS, or the honest reason it was not taken. */
        const fencePending = async (unit: RecordingIngestUnit, id: string): Promise<IngestClaim> => {
            // Fail closed when the adapter has no fence: a pending row stays
            // pending and the next delivery can still repair it.
            if (typeof unit.claimPending !== 'function') {
                return { kind: 'unfenced', id };
            }
            const won = await unit.claimPending({ id, owner: attemptOwner, nowMs: claimAtMs, leaseUntilMs });
            return won === 1 ? { kind: 'resume', id } : { kind: 'contended', id };
        };

        const claim = await runUnit<IngestClaim>(async (unit) => {
            const existing = await unit.findIngest(session.tenantId, provider, eventId);
            if (existing) {
                if (existing.outcome !== 'pending') return { kind: 'settled', row: existing };
                return fencePending(unit, existing.id);
            }
            const inserted = await unit.insertIngest({
                id: ledgerId,
                tenantId: session.tenantId,
                sessionId: session.id,
                provider,
                eventId,
                providerRecordingId,
                durationSeconds: descriptor.durationSeconds,
                storageBytes: descriptor.storageBytes,
                occurredAtMs,
                outcome: 'pending',
                claimOwner: attemptOwner,
                claimExpiresAtMs: leaseUntilMs,
            });
            if (inserted.inserted) return { kind: 'claimed', id: ledgerId };
            if (inserted.reason === 'recording-exists') {
                // A second event naming the same recording. It is a genuine
                // duplicate, and there is no row for THIS event to fence.
                return { kind: 'duplicate', reason: 'recording-exists' };
            }
            // The insert lost on the EVENT key. Do not trust the error label:
            // re-read the conflicting row in the SAME unit and decide on its
            // state. A `pending` row is resumable, not completed — collapsing
            // it to `duplicate` here would strand a marker no provider will
            // ever be able to settle.
            const raced = await unit.findIngest(session.tenantId, provider, eventId);
            if (!raced) return { kind: 'duplicate', reason: inserted.reason ?? 'event-replay' };
            if (raced.outcome !== 'pending') return { kind: 'settled', row: raced };
            return fencePending(unit, raced.id);
        });
        if (!claim.committed) return { status: 'rejected', reason: 'transaction-required' };
        const claimValue = claim.value;

        if (claimValue.kind === 'settled') {
            const settledRow = claimValue.row;
            // A settled row is only a duplicate if the payload arriving now
            // describes the SAME recording. A reused event id that disagrees on
            // session, recording id, duration or bytes is a conflict: the
            // stored row is the record and nothing is re-driven.
            const mismatched = compareRecordingReplayPayload(settledRow, {
                sessionId: session.id,
                providerRecordingId,
                durationSeconds: descriptor.durationSeconds,
                storageBytes: descriptor.storageBytes,
            });
            if (mismatched.length > 0) {
                await runUnit(async (unit) => {
                    await unit.recordAudit({
                        actorUserId: null,
                        tenantId: session.tenantId,
                        action: 'live.recording.replay_conflict',
                        resourceType: 'live_recording',
                        resourceId: providerRecordingId,
                        reason: 'payload_mismatch',
                        newValue: {
                            fields: mismatched,
                            stored: {
                                session_id: settledRow.sessionId,
                                provider_recording_id: settledRow.providerRecordingId,
                                duration_seconds: settledRow.durationSeconds,
                                storage_bytes: settledRow.storageBytes,
                                ledger_outcome: settledRow.outcome,
                            },
                            incoming: {
                                session_id: session.id,
                                provider_recording_id: providerRecordingId,
                                duration_seconds: descriptor.durationSeconds,
                                storage_bytes: descriptor.storageBytes,
                            },
                        },
                    });
                });
                return { status: 'conflict', reason: 'payload-mismatch', fields: mismatched };
            }
            await runUnit(async (unit) => {
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.deduplicated',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    newValue: { reason: 'event-replay' },
                });
            });
            return { status: 'duplicate', reason: 'event-replay' };
        }

        if (claimValue.kind === 'duplicate') {
            const reason = claimValue.reason;
            await runUnit(async (unit) => {
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.deduplicated',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    newValue: { reason },
                });
            });
            return { status: 'duplicate', reason };
        }

        if (claimValue.kind === 'unfenced' || claimValue.kind === 'contended') {
            const unfenced = claimValue.kind === 'unfenced';
            const blockedReason = unfenced ? 'claim-unavailable' : 'claim-held';
            await runUnit(async (unit) => {
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: unfenced
                        ? 'live.recording.resume_unfenced'
                        : 'live.recording.resume_contended',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: unfenced ? 'claim_port_absent' : 'claim_held_by_another_attempt',
                    newValue: { ledger_id: claimValue.id, provider, event_id: eventId, ledger_outcome: 'pending' },
                });
            });
            // No external call, no success audit, marker untouched.
            return { status: 'deferred', reason: blockedReason };
        }

        // 4. LIBRARY FIRST — idempotent create, or the readback of the row the
        //    unique key already holds. Nothing is metered before this, because
        //    the meter needs the PROMOTED `video_assets.id`: the old synthetic
        //    `provider:recording` id was not an asset, could not be resolved by
        //    the meter, and proved no ownership at all.
        let library: RecordingLibraryOutcome;
        let assetId: string | null = null;
        let promotedTenantId: string | null = null;
        let promotedOwnerUserId: string | null = null;
        let libraryFailure: RecordingDeferredReason | null = null;
        if (!deps.library) {
            library = 'unconfigured';
            libraryFailure = 'library-unconfigured';
            await store.recordAudit({
                actorUserId: null,
                tenantId: session.tenantId,
                action: 'live.recording.library_unconfigured',
                resourceType: 'live_recording',
                resourceId: providerRecordingId,
                reason: 'library_not_configured',
                newValue: { duration_seconds: descriptor.durationSeconds, visibility: descriptor.visibility },
            });
        } else {
            try {
                const stored = await deps.library.createRecordingAsset(descriptor);
                library = stored.created ? 'created' : 'existing';
                assetId = stored.assetId;
                promotedTenantId = stored.tenantId;
                promotedOwnerUserId = stored.ownerUserId;
            } catch (error) {
                // Fail closed and say WHY. A cross-tenant key, a case-collision
                // and an owner disagreement are different operational facts, and
                // collapsing them into `library_error` hides the one that needs
                // a human.
                library = 'deferred';
                libraryFailure = classifyLibraryFailure(error);
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.library_deferred',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: libraryFailure,
                    newValue: { provider, event_id: eventId },
                });
            }
        }

        // 4b. PROVE the promoted identity before charging anything to it.
        //     Three independent facts, all required: the id is one the meter can
        //     accept (canonical, no colon), the tenant is THIS session's tenant,
        //     and the owner is the owner this descriptor carried. An asset filed
        //     for someone else is not this recording's asset even when the
        //     unique key handed us its id.
        const identityProven = (library === 'created' || library === 'existing')
            && isCanonicalAssetId(assetId)
            && promotedTenantId === session.tenantId
            && descriptor.ownerUserId !== null
            && promotedOwnerUserId === descriptor.ownerUserId;

        // 5. METERING — with the REAL asset id and the RECORDING's stage
        //    identity. `buildStorageIdempotencyKey` composes
        //    `st:{assetId}:{operationId}`, so a second delivery event for the
        //    same recording produces the same key and is a meter duplicate.
        let metering: RecordingMeteringOutcome;
        let meteringFailure: RecordingDeferredReason | null = null;
        if (!identityProven) {
            // No asset, or an asset whose identity this callback cannot prove.
            // Metering is refused rather than attempted against a guess.
            metering = library === 'created' || library === 'existing' ? 'deferred' : 'not-attempted';
            if (metering === 'deferred') {
                meteringFailure = 'metering-identity-unproven';
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.metering_deferred',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: meteringFailure,
                    newValue: {
                        asset_id: assetId,
                        promoted_tenant_matches: promotedTenantId === session.tenantId,
                        owner_present: descriptor.ownerUserId !== null,
                        owner_matches: promotedOwnerUserId === descriptor.ownerUserId,
                    },
                });
            }
        } else if (!deps.meterStorage) {
            // NO METER IS NOT AN EXEMPTION. The old branch reported
            // `unconfigured` and then settled `ingested`, which turned an
            // unaccounted recording into a terminal success: a same-event retry
            // came back `duplicate`, and the recovery pass only scans `pending`,
            // so the storage obligation was destroyed by the very first
            // delivery. `storageAccounted: false` is response and audit data —
            // it is not a durable obligation anybody can act on later.
            //
            // The marker therefore stays `pending` with a typed reason, so that
            // composing a meter later lets ONE redelivery finish the charge
            // against the SAME promoted asset and the SAME recording/stage key.
            metering = 'unconfigured';
            meteringFailure = 'metering-unconfigured';
            await store.recordAudit({
                actorUserId: null,
                tenantId: session.tenantId,
                action: 'live.recording.metering_unconfigured',
                resourceType: 'live_recording',
                resourceId: providerRecordingId,
                reason: 'meter_not_configured',
                newValue: {
                    asset_id: assetId,
                    storage_bytes: descriptor.storageBytes,
                    // The key a later retry will present. Recorded so an
                    // operator can prove the resume converges on one charge.
                    meter_operation_id: buildRecordingMeterOperationId({
                        tenantId: session.tenantId,
                        provider,
                        providerRecordingId,
                        stage: 'storage',
                    }),
                    ledger_outcome: 'pending',
                },
            });
        } else {
            const operationId = buildRecordingMeterOperationId({
                tenantId: session.tenantId,
                provider,
                providerRecordingId,
                stage: 'storage',
            });
            try {
                const metered = await deps.meterStorage.recordVerifiedBytes({
                    tenantId: session.tenantId,
                    // The REAL promoted id, never a synthetic one.
                    assetId,
                    resultingBytes: descriptor.storageBytes,
                    operationId,
                    source: 'provider-callback',
                    occurredAtMs,
                });
                if ('error' in metered) {
                    metering = 'deferred';
                    meteringFailure = 'metering-error';
                    await store.recordAudit({
                        actorUserId: null,
                        tenantId: session.tenantId,
                        action: 'live.recording.metering_deferred',
                        resourceType: 'live_recording',
                        resourceId: providerRecordingId,
                        reason: metered.error,
                        newValue: { asset_id: assetId, operation_id: operationId },
                    });
                } else if (metered.recorded === true) {
                    metering = 'recorded';
                } else if (metered.deduplicated === true) {
                    metering = 'deduplicated';
                } else {
                    // Neither recorded nor deduplicated. A sink that cannot say
                    // which is not a sink that already applied the charge, so it
                    // is deferred — never assumed.
                    metering = 'deferred';
                    meteringFailure = 'metering-unknown';
                    await store.recordAudit({
                        actorUserId: null,
                        tenantId: session.tenantId,
                        action: 'live.recording.metering_deferred',
                        resourceType: 'live_recording',
                        resourceId: providerRecordingId,
                        reason: meteringFailure,
                        newValue: { asset_id: assetId, operation_id: operationId },
                    });
                }
            } catch {
                metering = 'deferred';
                meteringFailure = 'metering-error';
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.metering_deferred',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: 'metering_error',
                    newValue: { asset_id: assetId, operation_id: operationId },
                });
            }
        }

        // 6. Terminal state and its audit commit together, and ONLY for a
        //    transition this attempt actually performed.
        //
        //    `ingested` requires THREE things, and the third is stated twice on
        //    purpose: the library answered, no stage is outstanding, AND storage
        //    accounting is recorded or proven deduplicated. There is no
        //    "unaccounted but terminal" state any more — an absent meter leaves
        //    the row `pending` with `metering-unconfigured`, because a terminal
        //    row cannot be retried (`duplicate`) and the recovery pass only
        //    scans `pending`.
        const deferredReason: RecordingDeferredReason | null = libraryFailure ?? meteringFailure;
        const storageAccounted = metering === 'recorded' || metering === 'deduplicated';
        const terminal = deferredReason === null
            && (library === 'created' || library === 'existing')
            && storageAccounted;

        const settled = await runUnit<IngestSettlement>(async (unit) => {
            if (!terminal) {
                // Release, do not settle. The row stays `pending` and this
                // attempt hands its lease back so a redelivery can retry
                // immediately instead of waiting for the lease to expire.
                // `outcome: 'pending'` is the guarded release form.
                const released = await unit.finalizeIngest({
                    id: claimValue.id,
                    outcome: 'pending',
                    expect: { owner: attemptOwner },
                });
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.deferred',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: deferredReason ?? 'library-error',
                    newValue: {
                        session_id: session.id,
                        provider,
                        provider_recording_id: providerRecordingId,
                        metering,
                        library,
                        asset_id: assetId,
                        // The key a later retry will present. Recorded whenever
                        // an asset was proven — i.e. metering was attempted or
                        // deliberately skipped — so an operator can verify that
                        // the resume converges on ONE charge.
                        meter_operation_id: metering === 'not-attempted'
                            ? null
                            : buildRecordingMeterOperationId({
                                tenantId: session.tenantId,
                                provider,
                                providerRecordingId,
                                stage: 'storage',
                            }),
                        // `unknown` when the release lost the row: another
                        // attempt may already have settled it, so claiming
                        // it is still pending would be a lie.
                        ledger_outcome: released === 1 ? 'pending' : 'unknown',
                        claim_released: released === 1,
                    },
                });
                return 'released';
            }

            const affected = await unit.finalizeIngest({
                id: claimValue.id,
                outcome: 'ingested',
                expect: { owner: attemptOwner },
            });
            if (affected !== 1) {
                // The guarded transition did not happen: the lease expired
                // and another attempt took the row, or this attempt never
                // owned it. The asset may exist (the sink is idempotent) but
                // the LEDGER transition is not ours, so no success audit.
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.finalize_lost',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: 'claim_not_owned',
                    newValue: {
                        ledger_id: claimValue.id,
                        expected_owner: attemptOwner,
                        library,
                        metering,
                        ledger_outcome: 'unknown',
                    },
                });
                return 'lost';
            }

            await unit.recordAudit({
                actorUserId: null,
                tenantId: session.tenantId,
                action: 'live.recording.ingested',
                resourceType: 'live_recording',
                resourceId: assetId ?? providerRecordingId,
                newValue: {
                    session_id: session.id,
                    provider,
                    provider_recording_id: providerRecordingId,
                    duration_seconds: descriptor.durationSeconds,
                    storage_bytes: descriptor.storageBytes,
                    visibility: descriptor.visibility,
                    access_policy: descriptor.accessPolicy,
                    metering,
                    library,
                    asset_id: assetId,
                    // An `ingested` row with `storage_accounted: false` is a
                    // real state (no meter composed) and must be readable as
                    // such: the ledger is terminal, the accounting is not.
                    storage_accounted: storageAccounted,
                    meter_operation_id: storageAccounted
                        ? buildRecordingMeterOperationId({
                            tenantId: session.tenantId,
                            provider,
                            providerRecordingId,
                            stage: 'storage',
                        })
                        : null,
                    ledger_outcome: 'ingested',
                },
            });
            return 'ingested';
        });
        if (!settled.committed) return { status: 'rejected', reason: 'transaction-required' };

        if (settled.value === 'lost') return { status: 'deferred', reason: 'claim-lost' };
        if (settled.value === 'released') return { status: 'deferred', reason: deferredReason ?? 'library-error' };

        return {
            status: 'ingested',
            assetId,
            metering,
            library,
            visibility: descriptor.visibility,
            storageAccounted,
        };
    };

    return {
        ingest: async (callback) => {
            const provider = normalizeProviderKey(callback.provider);
            const eventId = normalizeProviderKey(callback.eventId);
            const providerRoomId = normalizeProviderKey(callback.providerRoomId);
            const providerRecordingId = normalizeProviderKey(callback.providerRecordingId);
            const tenantClaim = typeof callback.tenantId === 'string' && callback.tenantId.trim()
                ? callback.tenantId.trim()
                : null;
            // Comparison input only. Never an audit partition before a trusted
            // session row exists; the bounded copy is evidence, not a routing key.
            const claimEvidence = tenantClaim === null ? null : tenantClaim.slice(0, 128);

            // 1. Signature first. Nothing from an unverified payload is read.
            let verified = false;
            try {
                verified = Boolean(await deps.verifyCallbackSignature(callback));
            } catch {
                verified = false;
            }
            if (!verified) {
                // No trusted tenant yet ⇒ GLOBAL security event. Stamping the
                // caller's claim would let an attacker pick the tenant whose
                // audit partition receives the event.
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: null,
                    action: 'live.recording.ignored',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId ?? 'unknown',
                    reason: 'unverified_signature',
                    newValue: { tenant_claim: claimEvidence },
                });
                return { status: 'ignored', reason: 'unverified-signature' };
            }

            if (!provider || !eventId || !providerRoomId || !providerRecordingId) {
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: null,
                    action: 'live.recording.ignored',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId ?? 'unknown',
                    reason: 'malformed_callback',
                    newValue: { tenant_claim: claimEvidence },
                });
                return { status: 'ignored', reason: 'malformed' };
            }

            const session = await store.findSessionByProviderRoom(provider, providerRoomId);
            if (!session) {
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: null,
                    action: 'live.recording.ignored',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: 'unknown_session',
                    newValue: { tenant_claim: claimEvidence },
                });
                return { status: 'ignored', reason: 'unknown-session' };
            }

            // 2. Tenant from the session row. Every audit below this point is
            //    partitioned by `session.tenantId`, never by the claim.
            if (tenantClaim !== null && tenantClaim !== session.tenantId) {
                await store.recordAudit({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.recording.rejected',
                    resourceType: 'live_recording',
                    resourceId: providerRecordingId,
                    reason: 'cross_tenant',
                    newValue: { tenant_claim: claimEvidence },
                });
                return { status: 'rejected', reason: 'cross-tenant' };
            }

            const at = now();
            const occurredAtMs = typeof callback.occurredAtMs === 'number' && Number.isFinite(callback.occurredAtMs)
                ? Math.trunc(callback.occurredAtMs)
                : at;

            const result = await runVerified({
                session,
                provider,
                eventId,
                providerRecordingId,
                durationSeconds: callback.durationSeconds,
                storageBytes: callback.storageBytes,
                occurredAtMs,
                title: callback.title ?? null,
                nowMs: at,
            });
            // The provider's caller does not need the internal distinction: a
            // quarantined row is still "ignored, not ingested" to a webhook.
            // The MARKER was settled by the same fenced transition either way.
            if (result.status === 'quarantined') {
                return {
                    status: 'ignored',
                    reason: result.reason === 'outside-grace' ? 'outside-grace' : 'session-not-ingestible',
                };
            }
            return result;
        },

        /**
         * Recovery entry point — see `RecordingIngestService.resumePending`.
         *
         * Why skipping the signature is sound: the marker only exists because a
         * signature-verified callback already resolved the session and the
         * tenant, and this function takes a KEY, never a payload, so it cannot
         * be used to inject facts a signature did not cover. The persisted row
         * is the evidence; the session, tenant, grace window and caps are
         * re-checked from server rows before anything is re-driven.
         */
        resumePending: async (input) => {
            const provider = normalizeProviderKey(input.provider);
            const eventId = normalizeProviderKey(input.eventId);
            const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
            if (!provider || !eventId || !tenantId) return { status: 'skipped', reason: 'malformed' };

            const existing = await store.findIngest(tenantId, provider, eventId);
            if (!existing) return { status: 'skipped', reason: 'not-found' };
            if (existing.tenantId !== tenantId || existing.provider !== provider || existing.eventId !== eventId) {
                return { status: 'skipped', reason: 'tenant-mismatch' };
            }
            if (existing.outcome !== 'pending') {
                // Already terminal: nothing is re-driven, and the row — not the
                // caller — is what says so.
                return { status: 'duplicate', reason: 'event-replay' };
            }
            if (typeof store.findSessionById !== 'function') {
                // Without the session row the resume cannot re-check the tenant,
                // the state or the grace window. Refuse rather than replay blind.
                return { status: 'skipped', reason: 'session-read-unavailable' };
            }
            const session = await store.findSessionById(tenantId, existing.sessionId);
            if (!session) return { status: 'skipped', reason: 'unknown-session' };
            if (session.tenantId !== tenantId) return { status: 'skipped', reason: 'tenant-mismatch' };

            return runVerified({
                session,
                provider,
                eventId,
                providerRecordingId: existing.providerRecordingId,
                durationSeconds: existing.durationSeconds,
                storageBytes: existing.storageBytes,
                // The persisted event time, not `now()`: the grace window is
                // about when the recording happened, and re-stamping it would
                // let a resume walk a row past its own window.
                occurredAtMs: existing.occurredAtMs,
                title: null,
                nowMs: now(),
            });
        },
    };
}

/* =========================================================================
 * Reference adapters (hermetic tests and local composition)
 * ========================================================================= */

export interface InMemoryRecordingIngestStore extends RecordingIngestStore {
    readonly rows: RecordingIngestRow[];
    readonly audits: AuditRecordInput[];
    readonly sessions: RecordingSessionRef[];
    /** Mirrors `live_sessions(provider, provider_room_id)` resolution. */
    seedSession(ref: RecordingSessionRef & { provider: string; providerRoomId: string }): void;
}

interface InMemoryIngestState {
    rows: RecordingIngestRow[];
    audits: AuditRecordInput[];
    eventKeys: Set<string>;
    recordingKeys: Set<string>;
}

/** The unit surface over one state: in production one connection, here a staged copy. */
function createInMemoryIngestUnit(state: InMemoryIngestState, sessions: RecordingSessionRef[], roomIndex: Map<string, string>): RecordingIngestUnit {
    return {
        findSessionByProviderRoom: async (provider, providerRoomId) => {
            const sessionId = roomIndex.get(`${provider}\u0000${providerRoomId}`);
            if (!sessionId) return null;
            const row = sessions.find((session) => session.id === sessionId);
            return row ? { ...row } : null;
        },

        /** Tenant-scoped by id: the read a resume uses, because a ledger row
         *  carries `session_id` and no provider room id. */
        findSessionById: async (tenantId, sessionId) => {
            const row = sessions.find((session) => session.id === sessionId && session.tenantId === tenantId);
            return row ? { ...row } : null;
        },

        findIngest: async (tenantId, provider, eventId) => {
            const row = state.rows.find(
                (entry) => entry.tenantId === tenantId && entry.provider === provider && entry.eventId === eventId,
            );
            return row ? { ...row } : null;
        },

        insertIngest: async (row) => {
            const eventKey = `${row.tenantId}\u0000${row.provider}\u0000${row.eventId}`;
            if (state.eventKeys.has(eventKey)) return { inserted: false, reason: 'event-replay' };
            const recordingKey = `${row.tenantId}\u0000${row.provider}\u0000${row.providerRecordingId}`;
            if (state.recordingKeys.has(recordingKey)) return { inserted: false, reason: 'recording-exists' };
            state.eventKeys.add(eventKey);
            state.recordingKeys.add(recordingKey);
            state.rows.push({ ...row });
            return { inserted: true, reason: null };
        },

        // Mirrors the durable predicate, including its NULL behaviour: a row
        // that has an owner and no expiry is NOT claimable, which is why the
        // schema request requires the two columns to be written together.
        claimPending: async ({ id, owner, nowMs, leaseUntilMs }) => {
            const row = state.rows.find((entry) => entry.id === id);
            if (!row || row.outcome !== 'pending') return 0;
            if (row.claimOwner !== null && !(row.claimExpiresAtMs !== null && row.claimExpiresAtMs <= nowMs)) {
                return 0;
            }
            row.claimOwner = owner;
            row.claimExpiresAtMs = leaseUntilMs;
            return 1;
        },

        finalizeIngest: async ({ id, outcome, expect }) => {
            const row = state.rows.find((entry) => entry.id === id);
            if (!row || row.outcome !== 'pending' || row.claimOwner !== expect.owner) return 0;
            row.outcome = outcome;
            row.claimOwner = null;
            row.claimExpiresAtMs = null;
            return 1;
        },

        recordAudit: async (input) => {
            state.audits.push(input);
        },
    };
}

/**
 * A real adapter, not a decision mock. `withTransaction` is a SEAM MODEL, not
 * MySQL proof: the unit runs against a staged copy, commits by in-place
 * replacement when the work resolves and discards the copy when it throws.
 * Units are serialised by one in-process queue — stronger than the row locks a
 * durable adapter must take, and no isolation level, deadlock or crash is
 * modelled.
 */
export function createInMemoryRecordingIngestStore(): InMemoryRecordingIngestStore {
    const rows: RecordingIngestRow[] = [];
    const audits: AuditRecordInput[] = [];
    const sessions: RecordingSessionRef[] = [];
    const roomIndex = new Map<string, string>();
    const live: InMemoryIngestState = {
        rows,
        audits,
        eventKeys: new Set<string>(),
        recordingKeys: new Set<string>(),
    };
    const unit = createInMemoryIngestUnit(live, sessions, roomIndex);
    let queue: Promise<unknown> = Promise.resolve();

    const withTransaction = <T>(work: (unit: RecordingIngestUnit) => Promise<T>): Promise<T> => {
        const run = queue.then(async (): Promise<T> => {
            const staged: InMemoryIngestState = {
                rows: live.rows.map((row) => ({ ...row })),
                audits: live.audits.slice(),
                eventKeys: new Set(live.eventKeys),
                recordingKeys: new Set(live.recordingKeys),
            };
            const value = await work(createInMemoryIngestUnit(staged, sessions, roomIndex));
            live.rows.length = 0;
            live.rows.push(...staged.rows);
            live.audits.length = 0;
            live.audits.push(...staged.audits);
            live.eventKeys = staged.eventKeys;
            live.recordingKeys = staged.recordingKeys;
            return value;
        });
        queue = run.then(() => undefined, () => undefined);
        return run;
    };

    return {
        rows,
        audits,
        sessions,
        seedSession: (ref) => {
            sessions.push({
                id: ref.id,
                tenantId: ref.tenantId,
                title: ref.title,
                state: ref.state,
                endedAtMs: ref.endedAtMs,
            });
            roomIndex.set(`${ref.provider}\u0000${ref.providerRoomId}`, ref.id);
        },
        ...unit,
        withTransaction,
    };
}

export interface InMemoryRecordingLibrary extends RecordingLibraryPort {
    readonly assets: RecordingAssetDescriptor[];
}

/**
 * A real adapter: it stores the descriptor and refuses a second asset for the
 * same `buildRecordingAssetDedupeKey(tenantId, provider, providerRecordingId)`
 * tuple, answering the existing id with `created: false`. It grants nothing —
 * every stored asset keeps `visibility: 'unpublished'` and `accessPolicy:
 * 'deny'` until an explicit publication decision is made elsewhere.
 *
 * The id is stored WITH the descriptor and answered verbatim on a repeat. It
 * used to answer `${provider}:${providerRecordingId}` for the existing case,
 * which is a DIFFERENT id from the one minted on creation — so a resume metered
 * a second asset and the seam disagreed with its own first answer.
 */
export function createInMemoryRecordingLibrary(idFactory: () => string = () => `asset-${Math.random().toString(36).slice(2, 10)}`): InMemoryRecordingLibrary {
    const assets: RecordingAssetDescriptor[] = [];
    const ids = new Map<string, string>();
    return {
        assets,
        createRecordingAsset: async (descriptor) => {
            const key = buildRecordingAssetDedupeKey(
                descriptor.tenantId,
                descriptor.provider,
                descriptor.providerRecordingId,
            );
            const existingId = ids.get(key);
            const owner = descriptor.ownerUserId;
            if (existingId !== undefined) {
                // A repeat must still answer with a PROVEN owner, or the service
                // will (correctly) refuse to meter. `null` here models a row
                // whose owner is unknown, not one whose owner is the tenant.
                return {
                    created: false,
                    assetId: existingId,
                    tenantId: descriptor.tenantId,
                    ownerUserId: owner ?? '',
                };
            }
            if (owner === null || owner === undefined) {
                throw Object.assign(
                    new Error('owner_user_id is NOT NULL and the descriptor carries no owner'),
                    { code: 'owner_missing' },
                );
            }
            const id = idFactory();
            ids.set(key, id);
            assets.push({ ...descriptor });
            return { created: true, assetId: id, tenantId: descriptor.tenantId, ownerUserId: owner };
        },
    };
}
