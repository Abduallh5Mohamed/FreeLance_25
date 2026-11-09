"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECORDING_REPLAY_COMPARED_FIELDS = exports.RECORDING_METER_STAGES = exports.RECORDING_VISIBILITIES = exports.RECORDING_ACCESS_POLICIES = exports.RECORDING_INGEST_CLAIM_LEASE_MS = exports.RECORDING_CLAIM_OWNER_MAX_LENGTH = exports.RECORDING_TITLE_MAX_LENGTH = exports.MAX_RECORDING_GRACE_SECONDS = exports.DEFAULT_RECORDING_GRACE_SECONDS = exports.MAX_RECORDING_BYTES = exports.MAX_RECORDING_SECONDS = void 0;
exports.normalizeAccessPolicy = normalizeAccessPolicy;
exports.normalizeRecordingId = normalizeRecordingId;
exports.normalizeProviderKey = normalizeProviderKey;
exports.buildRecordingMeterOperationId = buildRecordingMeterOperationId;
exports.isCanonicalAssetId = isCanonicalAssetId;
exports.buildRecordingAssetDedupeKey = buildRecordingAssetDedupeKey;
exports.normalizeGraceSeconds = normalizeGraceSeconds;
exports.planRecordingAsset = planRecordingAsset;
exports.compareRecordingReplayPayload = compareRecordingReplayPayload;
exports.createRecordingIngestService = createRecordingIngestService;
exports.createInMemoryRecordingIngestStore = createInMemoryRecordingIngestStore;
exports.createInMemoryRecordingLibrary = createInMemoryRecordingLibrary;
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
const crypto_1 = require("crypto");
/* =========================================================================
 * Bounds
 * ========================================================================= */
exports.MAX_RECORDING_SECONDS = 12 * 60 * 60;
exports.MAX_RECORDING_BYTES = 100 * 1024 * 1024 * 1024;
exports.DEFAULT_RECORDING_GRACE_SECONDS = 6 * 60 * 60;
exports.MAX_RECORDING_GRACE_SECONDS = 7 * 24 * 60 * 60;
exports.RECORDING_TITLE_MAX_LENGTH = 200;
/** Upper bound for a claim owner token; the ledger column is sized to match. */
exports.RECORDING_CLAIM_OWNER_MAX_LENGTH = 64;
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
exports.RECORDING_INGEST_CLAIM_LEASE_MS = 5 * 60 * 1000;
/**
 * The access policy a recording is created with. `deny` is the only value this
 * module ever emits on its own; the rest exist so the port can express a later,
 * explicitly decided publication instead of inventing a boolean.
 */
exports.RECORDING_ACCESS_POLICIES = ['deny', 'session-participants', 'enrolled', 'tenant-instructors'];
exports.RECORDING_VISIBILITIES = ['unpublished', 'published'];
function normalizeAccessPolicy(value) {
    if (typeof value !== 'string')
        return null;
    return exports.RECORDING_ACCESS_POLICIES.includes(value)
        ? value
        : null;
}
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
function normalizeRecordingId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return ID_RE.test(trimmed) ? trimmed : null;
}
function normalizeProviderKey(value) {
    if (typeof value !== 'string')
        return null;
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
exports.RECORDING_METER_STAGES = ['storage'];
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
function buildRecordingMeterOperationId(input) {
    const raw = `live:${input.stage}:${input.tenantId}:${input.provider}:${input.providerRecordingId}`;
    if (raw.length <= 200)
        return raw;
    const digest = (0, crypto_1.createHash)('sha256').update(raw).digest('hex');
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
function isCanonicalAssetId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
/**
 * The library's dedupe key: `(tenantId, provider, providerRecordingId)`,
 * NUL-separated so no component can shift another. `createRecordingAsset` MUST
 * be idempotent on exactly these three values and answer the existing `assetId`
 * with `created: false`. This helper exists so a durable adapter cannot invent a
 * different tuple; the COLUMNS, not this string, are the uniqueness constraint.
 */
function buildRecordingAssetDedupeKey(tenantId, provider, providerRecordingId) {
    return `${tenantId}\u0000${provider}\u0000${providerRecordingId}`;
}
/**
 * Strict non-negative integer, digits only.
 *
 * `parseInt('12abc')` returned 12, so a provider `durationSeconds` of
 * `"12abc"` was accepted, persisted and METERED instead of being refused as
 * `invalid-duration`; `"1e21"` returned 1 and `"9007199254740993"` silently
 * became `9007199254740992`, charging the wrong number of bytes.
 */
function toNonNegativeInt(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}
function normalizeGraceSeconds(value) {
    // Digits only: `parseInt('12abc')` returned 12, so a malformed configured
    // grace silently became a real one instead of falling back to the default.
    let parsed;
    if (typeof value === 'number') {
        parsed = Number.isSafeInteger(value) ? value : Number.NaN;
    }
    else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        parsed = Number(value.trim());
    }
    else {
        parsed = Number.NaN;
    }
    if (!Number.isSafeInteger(parsed))
        return exports.DEFAULT_RECORDING_GRACE_SECONDS;
    return Math.min(exports.MAX_RECORDING_GRACE_SECONDS, Math.max(0, parsed));
}
/**
 * Build the library descriptor for a verified recording payload. Pure: no
 * store, no clock beyond the supplied values, no decision about publication.
 */
function planRecordingAsset(input) {
    const duration = toNonNegativeInt(input.durationSeconds);
    if (duration === null || duration <= 0)
        return { ok: false, reason: 'invalid-duration' };
    if (duration > exports.MAX_RECORDING_SECONDS)
        return { ok: false, reason: 'duration-cap' };
    const bytes = toNonNegativeInt(input.storageBytes);
    if (bytes === null)
        return { ok: false, reason: 'invalid-bytes' };
    if (bytes > exports.MAX_RECORDING_BYTES)
        return { ok: false, reason: 'bytes-cap' };
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
    const title = baseTitle.slice(0, exports.RECORDING_TITLE_MAX_LENGTH) || 'Session recording';
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
const LIBRARY_FAILURE_BY_CODE = Object.freeze({
    cross_tenant_collision: 'library-cross-tenant',
    key_collision: 'library-key-collision',
    unresolved_duplicate: 'library-key-collision',
    owner_missing: 'library-owner-mismatch',
    owner_mismatch: 'library-owner-mismatch',
});
function classifyLibraryFailure(error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : '';
    return LIBRARY_FAILURE_BY_CODE[code] ?? 'library-error';
}
/**
 * What a terminal replay compares. Exactly these four persisted facts — a
 * redelivery may legitimately carry a different `occurred_at_ms` and a
 * different `title` (neither is part of the recording's identity), so neither
 * is compared.
 */
exports.RECORDING_REPLAY_COMPARED_FIELDS = [
    'session',
    'provider_recording_id',
    'duration_seconds',
    'storage_bytes',
];
/**
 * Pure: which persisted facts disagree with the incoming descriptor. An empty
 * array means "this really is the same event again". No SQL, no store, no
 * clock — the caller decides what a mismatch means.
 */
function compareRecordingReplayPayload(stored, incoming) {
    const mismatched = [];
    if (stored.sessionId !== incoming.sessionId)
        mismatched.push('session');
    if (stored.providerRecordingId !== incoming.providerRecordingId)
        mismatched.push('provider_recording_id');
    if (stored.durationSeconds !== incoming.durationSeconds)
        mismatched.push('duration_seconds');
    if (stored.storageBytes !== incoming.storageBytes)
        mismatched.push('storage_bytes');
    return mismatched;
}
function createRecordingIngestService(deps) {
    const store = deps.store;
    const now = deps.now ?? (() => Date.now());
    const idFactory = deps.idFactory ?? crypto_1.randomUUID;
    const graceMs = normalizeGraceSeconds(deps.graceSeconds) * 1000;
    const claimLeaseMs = exports.RECORDING_INGEST_CLAIM_LEASE_MS;
    let attemptSeq = 0;
    /**
     * One bounded owner token per `ingest()` call. The counter makes it unique
     * inside this process even if an injected `idFactory` repeats a value; the
     * ledger id keeps two processes apart. It carries no tenant, session or
     * provider data — a ledger id is opaque.
     */
    const nextAttemptOwner = (ledgerId) => {
        attemptSeq += 1;
        const suffix = ledgerId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
        return `att-${attemptSeq}-${suffix}`.slice(0, exports.RECORDING_CLAIM_OWNER_MAX_LENGTH);
    };
    /**
     * Every ledger write goes through here. The unit is mandatory: a store
     * without `withTransaction` is refused and nothing is written, because a
     * marker that commits without its audit is exactly the half-write this
     * correction exists to remove.
     */
    const runUnit = async (work) => {
        if (typeof store.withTransaction !== 'function') {
            return { committed: false, reason: 'transaction-required' };
        }
        const value = await store.withTransaction(work);
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
    const runVerified = async (input) => {
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
        const provesTerminal = (fresh, reason) => reason === 'outside-grace'
            ? fresh.state === 'ended'
                && fresh.endedAtMs !== null
                && occurredAtMs > fresh.endedAtMs + graceMs
            : fresh.state === 'cancelled';
        /** The ledger value for a proven-terminal row. Both fit VARCHAR(32). */
        const terminalOutcome = (reason) => reason === 'outside-grace' ? 'ignored:outside-grace' : 'ignored:session-cancelled';
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
        const settleTerminal = async (reason) => {
            const settled = await runUnit(async (unit) => {
                const row = await unit.findIngest(session.tenantId, provider, eventId);
                if (!row)
                    return 'no-row';
                // Another attempt already moved it: nothing left to settle.
                if (row.outcome !== 'pending')
                    return 'already-terminal';
                if (typeof unit.claimPending !== 'function')
                    return 'unfenced';
                const won = await unit.claimPending({
                    id: row.id,
                    owner: attemptOwner,
                    nowMs: claimAtMs,
                    leaseUntilMs,
                });
                if (won !== 1)
                    return 'contended';
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
                if (affected !== 1)
                    return 'lost';
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
        const fencePending = async (unit, id) => {
            // Fail closed when the adapter has no fence: a pending row stays
            // pending and the next delivery can still repair it.
            if (typeof unit.claimPending !== 'function') {
                return { kind: 'unfenced', id };
            }
            const won = await unit.claimPending({ id, owner: attemptOwner, nowMs: claimAtMs, leaseUntilMs });
            return won === 1 ? { kind: 'resume', id } : { kind: 'contended', id };
        };
        const claim = await runUnit(async (unit) => {
            const existing = await unit.findIngest(session.tenantId, provider, eventId);
            if (existing) {
                if (existing.outcome !== 'pending')
                    return { kind: 'settled', row: existing };
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
            if (inserted.inserted)
                return { kind: 'claimed', id: ledgerId };
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
            if (!raced)
                return { kind: 'duplicate', reason: inserted.reason ?? 'event-replay' };
            if (raced.outcome !== 'pending')
                return { kind: 'settled', row: raced };
            return fencePending(unit, raced.id);
        });
        if (!claim.committed)
            return { status: 'rejected', reason: 'transaction-required' };
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
        let library;
        let assetId = null;
        let promotedTenantId = null;
        let promotedOwnerUserId = null;
        let libraryFailure = null;
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
        }
        else {
            try {
                const stored = await deps.library.createRecordingAsset(descriptor);
                library = stored.created ? 'created' : 'existing';
                assetId = stored.assetId;
                promotedTenantId = stored.tenantId;
                promotedOwnerUserId = stored.ownerUserId;
            }
            catch (error) {
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
        let metering;
        let meteringFailure = null;
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
        }
        else if (!deps.meterStorage) {
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
        }
        else {
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
                }
                else if (metered.recorded === true) {
                    metering = 'recorded';
                }
                else if (metered.deduplicated === true) {
                    metering = 'deduplicated';
                }
                else {
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
            }
            catch {
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
        const deferredReason = libraryFailure ?? meteringFailure;
        const storageAccounted = metering === 'recorded' || metering === 'deduplicated';
        const terminal = deferredReason === null
            && (library === 'created' || library === 'existing')
            && storageAccounted;
        const settled = await runUnit(async (unit) => {
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
                    // `terminal` above requires `storageAccounted`, so this is
                    // always `true` on an `ingested` audit. It is written
                    // explicitly so an operator can read the accounting fact
                    // off the terminal event instead of inferring it, and so a
                    // future change that relaxed terminality would be visible
                    // here rather than silent.
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
        if (!settled.committed)
            return { status: 'rejected', reason: 'transaction-required' };
        if (settled.value === 'lost')
            return { status: 'deferred', reason: 'claim-lost' };
        if (settled.value === 'released')
            return { status: 'deferred', reason: deferredReason ?? 'library-error' };
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
            }
            catch {
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
            if (!provider || !eventId || !tenantId)
                return { status: 'skipped', reason: 'malformed' };
            const existing = await store.findIngest(tenantId, provider, eventId);
            if (!existing)
                return { status: 'skipped', reason: 'not-found' };
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
            if (!session)
                return { status: 'skipped', reason: 'unknown-session' };
            if (session.tenantId !== tenantId)
                return { status: 'skipped', reason: 'tenant-mismatch' };
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
/** The unit surface over one state: in production one connection, here a staged copy. */
function createInMemoryIngestUnit(state, sessions, roomIndex) {
    return {
        findSessionByProviderRoom: async (provider, providerRoomId) => {
            const sessionId = roomIndex.get(`${provider}\u0000${providerRoomId}`);
            if (!sessionId)
                return null;
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
            const row = state.rows.find((entry) => entry.tenantId === tenantId && entry.provider === provider && entry.eventId === eventId);
            return row ? { ...row } : null;
        },
        insertIngest: async (row) => {
            const eventKey = `${row.tenantId}\u0000${row.provider}\u0000${row.eventId}`;
            if (state.eventKeys.has(eventKey))
                return { inserted: false, reason: 'event-replay' };
            const recordingKey = `${row.tenantId}\u0000${row.provider}\u0000${row.providerRecordingId}`;
            if (state.recordingKeys.has(recordingKey))
                return { inserted: false, reason: 'recording-exists' };
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
            if (!row || row.outcome !== 'pending')
                return 0;
            if (row.claimOwner !== null && !(row.claimExpiresAtMs !== null && row.claimExpiresAtMs <= nowMs)) {
                return 0;
            }
            row.claimOwner = owner;
            row.claimExpiresAtMs = leaseUntilMs;
            return 1;
        },
        finalizeIngest: async ({ id, outcome, expect }) => {
            const row = state.rows.find((entry) => entry.id === id);
            if (!row || row.outcome !== 'pending' || row.claimOwner !== expect.owner)
                return 0;
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
function createInMemoryRecordingIngestStore() {
    const rows = [];
    const audits = [];
    const sessions = [];
    const roomIndex = new Map();
    const live = {
        rows,
        audits,
        eventKeys: new Set(),
        recordingKeys: new Set(),
    };
    const unit = createInMemoryIngestUnit(live, sessions, roomIndex);
    let queue = Promise.resolve();
    const withTransaction = (work) => {
        const run = queue.then(async () => {
            const staged = {
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
                hostUserId: ref.hostUserId ?? null,
            });
            roomIndex.set(`${ref.provider}\u0000${ref.providerRoomId}`, ref.id);
        },
        ...unit,
        withTransaction,
    };
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
function createInMemoryRecordingLibrary(idFactory = () => `asset-${Math.random().toString(36).slice(2, 10)}`) {
    const assets = [];
    const ids = new Map();
    return {
        assets,
        createRecordingAsset: async (descriptor) => {
            const key = buildRecordingAssetDedupeKey(descriptor.tenantId, descriptor.provider, descriptor.providerRecordingId);
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
                throw Object.assign(new Error('owner_user_id is NOT NULL and the descriptor carries no owner'), { code: 'owner_missing' });
            }
            const id = idFactory();
            ids.set(key, id);
            assets.push({ ...descriptor });
            return { created: true, assetId: id, tenantId: descriptor.tenantId, ownerUserId: owner };
        },
    };
}
