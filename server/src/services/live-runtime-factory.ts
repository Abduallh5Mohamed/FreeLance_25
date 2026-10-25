/**
 * WL-P7 — live runtime composition.
 *
 * COMPOSITION ONLY. This module wires pieces that other files already own:
 * the durable session/presence store, the durable recording-ingest ledger, the
 * library promotion port, the two services and the recovery pass. It decides no
 * policy, mounts nothing, starts nothing, schedules nothing and opens no
 * connection. There is no `db`/pool import, no statement at import time and no
 * top-level side effect.
 *
 * UNPROVEN AT RUNTIME. No database, no driver, no HTTP mount and no provider was
 * exercised while this file was written. It compiles and it composes; that is
 * the whole claim. Nothing here proves isolation, locking, duplicate-key
 * behaviour, BIGINT mapping or that the injected runner is genuinely
 * connection-bound — the adapters' own headers state the same limit.
 *
 * WHAT A CALLER MUST SUPPLY
 *  - `executor` (required): one connection-bound runner with
 *    `query`/`queryOne`/`execute` and `transaction(work)` that hands `work` the
 *    SAME pooled connection and rolls back + rethrows on a throw. It is used for
 *    sessions, presence and the ingest ledger. This factory never owns a pool.
 *  - `sealedAudit` (required): `recordSealedAuditEvent`. There is no no-op
 *    writer and no plain `audit_events` INSERT anywhere in this lane.
 *  - `libraryRunner` (optional): a runner for `video_assets` promotion. Omitted
 *    ⇒ `executor` is reused (same connection shape); `null` ⇒ the library is
 *    deliberately left unwired and reported `unconfigured`.
 *  - `verifyLiveCallbackSignature` / `verifyRecordingCallbackSignature`
 *    (optional): the provider verifiers. Absent ⇒ a fail-closed `false` is
 *    used, every callback is refused and audited, and the status says so.
 *  - `ticketSecret` (optional): join-ticket HMAC secret. Absent ⇒ the core
 *    refuses issuance with `signing-unconfigured`.
 *  - `resolveProviderParticipant` (optional): trusted provider→participant
 *    mapping for presence callbacks. Absent ⇒ `participant.joined`/`left` fail
 *    closed with `mapping-unavailable`; `session.started`/`ended` are
 *    unaffected. `createInternalUserIdParticipantResolver` is the explicit
 *    opt-in for a provider that genuinely uses the internal user id; it is
 *    never wired automatically.
 *  - `optionalAuthenticate` (optional): only needed to build the HTTP router.
 *    Absent ⇒ no router is constructed (`router: null`).
 *  - `presenceCursor` (optional, default `'unconfigured'`): composition
 *    attestation that `20261023_02_live_callback_presence_contract.sql` (R22
 *    columns + R23 CHECK) is applied. Only `'declared'` attaches the presence
 *    event cursor to the session store. This factory never probes the catalog,
 *    so the attestation is the caller's claim and the runtime re-checks it: a
 *    missing column still fails closed with the typed `schema_unavailable` and a
 *    rollback.
 *
 * READINESS IS REPORTED PER CAPABILITY. `participantMapping`,
 * `presenceOrdering` and `sessionLifecycle` are separate entries, and
 * `liveReady` is `configured` only when all three are. A composition that has a
 * mapping but no R22 cursor is NOT ready, and the status says so instead of
 * letting one green field imply the whole path.
 *
 * METERING IS AN INJECTED PORT, AND THE ORDERING THAT MADE IT UNSAFE IS GONE.
 * The meter used to be deliberately unwired because the ingest metered a
 * synthetic, provider-scoped asset id (the now-DELETED
 * `buildRecordingMeterAssetId`) that `MediaMeteringService` cannot resolve —
 * every recording would have settled as `metering_deferred` and audited it for
 * ever. That ordering was fixed in
 * `live-recording-ingest.ts` (2026-10-23): the ingest now promotes the library
 * FIRST, proves the promoted `video_assets.id`/tenant/owner, and only then
 * meters, keyed on the recording's storage stage rather than the delivery event.
 * `meterStorage` is therefore forwarded when injected and left `undefined` when
 * not. An absent meter is a POLICY state: the ingest reports
 * `metering: 'unconfigured'` with `storageAccounted: false`, never a fake
 * measurement, and `readiness().recordingConfigured` is `unconfigured`. This
 * file creates no meter, no provider client and no timer.
 *
 * RECOVERY IS EXPLICIT — AND INTEGRATION-OPEN. `runRecoveryOnce(options)` is the
 * only entry point. It is never called by construction, never scheduled, has no
 * timer and registers no `process.on` hook. A caller (an operator command or a
 * cron it owns) decides when a bounded pass runs. `options` — including a
 * cross-invocation `after` continuation — is forwarded VERBATIM, and the
 * returned report (including `continuation` / `sweepComplete`) is returned
 * unchanged. Persisting the continuation between invocations is the CALLER's
 * obligation: this factory keeps no cursor and starts no scheduler.
 *
 * Do NOT read that as "L1 is operational". The continuation token exists and is
 * correct, but NOTHING in this lane persists it, so today only the quarantine
 * layer prevents starvation and only for the two provable reasons. Until Codex
 * supplies a durable checkpointing caller, bounded recovery is
 * INTEGRATION-OPEN, not done.
 *
 * READINESS IS SPLIT INTO THREE DIFFERENT QUESTIONS (F1). They used to be one
 * field and that was the defect:
 *   1. CONFIGURATION — are the dependencies wired? That is what the existing
 *      `LiveCapability` entries answer, and `liveReady` is now explicitly
 *      CONFIGURATION-ONLY and conservative (mapping + declared cursor +
 *      lifecycle + non-default verifiers + a valid ticket secret).
 *   2. SCHEMA — does the database actually carry the columns, and is the
 *      presence-event identity collation the one the contract requires? That is
 *      answered only by `verifyLiveSchema(executor)` in `live-session-sql.ts`,
 *      an EXPLICIT asynchronous call this factory never makes: construction
 *      stays I/O-free. A report is accepted only when
 *      `isLiveSchemaReportFor(report, executor)` proves this module produced it
 *      for THIS executor object; a structurally identical literal is refused
 *      with `invalid_deps` rather than trusted.
 *   3. OPERATIONS — has an independent review verified THIS deployment? That is
 *      NOT a record the caller hands over: a caller may only point at a
 *      REFERENCE, and `loadVerifiedOperationalEvidence` asks an injected
 *      trusted server-side resolver to verify it against the exact deployment,
 *      contract and executor, returning a lifetime. The result is a
 *      provenance-checked grant (WeakSet + WeakMap keyed by the executor
 *      object), and `readiness()` re-checks — on every call — that the grant's
 *      `deploymentId` and `executorId` match the SERVER-SIDE COMPOSITION CONTEXT
 *      captured at construction (`deps.compositionContext`), then its contract,
 *      scope and expiry. That context comes from configuration only: never from
 *      a request, and never inferred from the executor/connection object.
 *      No resolver, no grant, wrong executor, missing or mismatched composition
 *      context, wrong contract, out of scope or expired ⇒
 *      `operational: 'not-verified'`. A fabricated object with the right fields
 *      cannot reach `verified`, because nothing in this lane trusts fields as
 *      proof.
 * `readiness()` combines all three into an explicit `fullyReady` verdict and
 * re-evaluates FRESHNESS at call time, so a report that aged out stops counting
 * without anything having to be restarted. `status` remains the
 * construction-time snapshot and must not be read as a runtime verdict.
 *
 * A runtime `schema_unavailable` error observed by the caller can be reported
 * through `noteSchemaUnavailable(area, reason)`; that area then reads
 * `invalidated` until a newer report is applied through `applySchemaReport`.
 * Verification cannot promise that no DDL runs afterwards, and this factory
 * says so instead of implying otherwise.
 *
 * RECOVERY CHECKPOINT (F3) — OFF BY DEFAULT. `recoveryCheckpoint: 'declared'`
 * (plus an owner token) builds the R24 checkpoint store and passes it to the
 * bounded pass, which then persists its cursor after every inspected page and
 * refuses to start anywhere the durable row did not record. Default
 * `'unconfigured'`: nothing is built, `options.after` stays the caller's
 * obligation, and the integration-open limit above is unchanged. The table is
 * REQUESTED, not present, so the store degrades every operation to
 * `checkpoint-absent` and the pass reports `checkpoint-unavailable` without
 * scanning — no substitute cursor is invented.
 *
 * SHUTDOWN (F4) — `beginShutdown()` stops accepting NEW recovery passes (a
 * subsequent `runRecoveryOnce` returns `shutdown-in-progress` and touches no
 * cursor). It drains nothing and closes nothing, because this factory owns no
 * pool and no in-flight promise: draining belongs to the caller that holds
 * them, and a final recovery pass on the way out is exactly what must NOT
 * happen. The ordering is verify → construct → mount → loop, and on the way out
 * stop-new-work → drain → checkpoint/release only while still the owner →
 * close.
 */

import type { RequestHandler, Router } from 'express';
import {
    createLiveSessionCore,
    isValidTicketSecret,
    type LiveSessionCore,
    type LiveSessionStore,
    type ResolveProviderParticipant,
    type SignatureVerifier as LiveSignatureVerifier,
} from './live-session-core';
import {
    createLiveSessionSqlStore,
    isLiveSchemaReportFor,
    LIVE_SCHEMA_AREAS,
    LIVE_SCHEMA_CONTRACT_VERSION,
    type LiveSchemaArea,
    type LiveSchemaAreaStatus,
    type LiveSchemaReport,
    type LiveSessionSqlExecutor,
    type LiveSessionSqlStore,
    type PresenceCursorReadiness,
    type SealedAuditWriter,
} from './live-session-sql';
import {
    createRecordingIngestService,
    type RecordingIngestService,
    type RecordingStorageMeterPort,
    type SignatureVerifier as RecordingSignatureVerifier,
} from './live-recording-ingest';
import {
    createRecordingCheckpointSqlStore,
    createRecordingIngestSqlStore,
    type RecordingIngestSqlStore,
} from './live-recording-ingest-sql';
import {
    runRecordingRecoveryOnce,
    type RecordingRecoveryCheckpoint,
    type RecordingRecoveryDeps,
    type RecordingRecoveryOptions,
    type RecordingRecoveryReport,
} from './live-recording-recovery';
import {
    createRecordingLibraryPort,
    type RecordingLibraryPromotionPort,
    type RecordingLibraryRunner,
} from './video-asset-lifecycle';
import { createLiveSessionsRouter } from '../routes/live-sessions';

export type LiveRuntimeErrorCode = 'invalid_deps';

export class LiveRuntimeError extends Error {
    constructor(public readonly code: LiveRuntimeErrorCode, message: string) {
        super(message);
        this.name = 'LiveRuntimeError';
    }
}

/** Per-capability state. `unconfigured` is always accompanied by a reason. */
export type LiveCapability = 'configured' | 'unconfigured';

/**
 * The MAXIMUM age of a schema report before it stops counting. Fifteen minutes,
 * configurable DOWNWARD only (`schemaFreshnessMs`): a report older than this is
 * not evidence about the database that is serving requests now, and a caller
 * must not be able to widen the window by asking for an hour.
 */
export const LIVE_SCHEMA_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * The scope string the TRUSTED verification must cover. It is the only scope
 * this lane accepts, and a verdict that does not list it is not a verdict about
 * the callback path.
 */
export const LIVE_OPERATIONAL_SCOPE = 'live.callback.path';

/**
 * WHERE THIS PROCESS BELIEVES IT IS RUNNING — the server-side composition
 * context, read once at construction from configuration and captured in the
 * closure.
 *
 * Three rules, and they are the point of the type:
 *
 *  - it is NOT populated from a request: not from a header, a query, a body or a
 *    route parameter. A caller who can name its own deployment can satisfy any
 *    deployment check, so the value must come from the same configuration that
 *    builds the pool;
 *  - it is NOT derived from the executor/connection object. A connection knows
 *    which host it reached, not which deployment this process was configured to
 *    serve, and inferring identity from a socket is how two environments end up
 *    sharing one verdict;
 *  - it is compared with `===`, exactly as given. No trimming, no lower-casing,
 *    no "close enough": a mismatch is `not-verified`, never a normalisation.
 *
 * An operational grant is accepted only when BOTH ids match this context, in
 * addition to the executor object, the contract version, the scope and the
 * expiry. Absent context or a mismatch ⇒ `operational: 'not-verified'`.
 */
export interface LiveCompositionContext {
    readonly deploymentId: string;
    readonly executorId: string;
}

/**
 * Normalise a candidate composition context, or `null` when there is none.
 *
 * A value that is not an object, or whose ids are not non-empty strings, is
 * ABSENT rather than defaulted: this function never invents an identity, and it
 * returns a frozen copy so a caller cannot mutate the context after composition.
 * The returned ids are the caller's strings verbatim — emptiness is detected on
 * the trimmed form, comparison later is exact.
 */
const readCompositionContext = (value: unknown): LiveCompositionContext | null => {
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as { deploymentId?: unknown; executorId?: unknown };
    if (typeof candidate.deploymentId !== 'string' || candidate.deploymentId.trim().length === 0) return null;
    if (typeof candidate.executorId !== 'string' || candidate.executorId.trim().length === 0) return null;
    return Object.freeze({
        deploymentId: candidate.deploymentId,
        executorId: candidate.executorId,
    });
};

/**
 * One area's state as `readiness()` reports it.
 *
 * `verified` / `absent` / `unknown` come straight from the report.
 * `invalidated` means a runtime `schema_unavailable` error was reported for that
 * area after the measurement — the error wins over an older green report.
 * `unverified` means no report was ever applied.
 */
export type LiveSchemaAreaState = LiveSchemaAreaStatus | 'invalidated' | 'unverified';

/** Why an area stopped being trustworthy, and when the caller observed it. */
export interface LiveSchemaInvalidation {
    readonly atMs: number;
    readonly reason: string;
}

/**
 * WHAT A CALLER MAY POINT AT — and nothing more.
 *
 * `source` is a REFERENCE (a document id, a ticket, a run id) and `reviewer` is
 * optional metadata. Neither is evidence: a fabricated pair is indistinguishable
 * from a real one by shape, which is exactly why the old shape check was
 * removed. Nothing in this lane treats this object as proof of anything.
 */
export interface OperationalEvidenceReference {
    readonly source: string;
    readonly reviewer?: string;
}

/** What the resolver is being asked to verify against. */
export interface OperationalEvidenceContext {
    readonly deploymentId: string;
    readonly contractVersion: string;
    readonly executorId: string;
    readonly nowMs: number;
}

/**
 * What the TRUSTED resolver answers. It is the only source of `verified: true`
 * in this file, and it must answer the exact deployment, contract and executor
 * it was asked about, with the lifetime it is willing to stand behind.
 *
 * There is no default lifetime here on purpose: how long a review stays true is
 * the resolver's decision, not a constant this lane invents.
 */
export interface OperationalEvidenceVerdict {
    readonly verified: boolean;
    readonly reason: string | null;
    readonly scope: readonly string[];
    readonly deploymentId: string;
    readonly contractVersion: string;
    readonly executorId: string;
    readonly verifiedAtMs: number;
    readonly expiresAtMs: number;
}

/**
 * The injected, SERVER-SIDE trusted verifier.
 *
 * It must be a process that can actually check the referenced record against
 * this deployment (an internal verification service, a signed release record
 * reader, an operator-run attestation store). It must NOT be fed from a browser,
 * a request header or a request body, and this lane does not implement a
 * signature scheme of its own — that would be a second, unproven trust root.
 *
 * Async on purpose: the check is I/O, and readiness stays synchronous by loading
 * the result BEFORE composition.
 */
export type TrustedOperationalEvidenceResolver = (
    reference: OperationalEvidenceReference,
    context: OperationalEvidenceContext,
) => Promise<OperationalEvidenceVerdict>;

/**
 * The loaded, provenance-checked result. Opaque to callers: it is only produced
 * by `loadVerifiedOperationalEvidence` and only accepted for the executor object
 * it was loaded against, so a hand-written object with the same fields is not a
 * grant. `expiresAtMs` is the resolver's lifetime and is re-checked at every
 * `readiness()` call.
 */
export interface OperationalEvidenceGrant {
    readonly source: string;
    readonly reviewer: string;
    readonly scope: readonly string[];
    readonly deploymentId: string;
    readonly contractVersion: string;
    readonly executorId: string;
    readonly verifiedAtMs: number;
    readonly expiresAtMs: number;
}

export interface OperationalEvidenceLoadResult {
    /** `null` whenever the evidence is absent, unverifiable, out of scope or already expired. */
    readonly grant: OperationalEvidenceGrant | null;
    /** Why no grant was produced. A short fact, never a driver dump. */
    readonly reason: string | null;
}

/** Grants produced by `loadVerifiedOperationalEvidence`, by object identity. */
const issuedOperationalGrants = new WeakSet<object>();

/** Grants per executor OBJECT: a grant is not transferable to another connection. */
const operationalGrantsByExecutor = new WeakMap<object, Set<OperationalEvidenceGrant>>();

/** True only for a grant this module produced. */
export const isOperationalEvidenceGrant = (value: unknown): value is OperationalEvidenceGrant =>
    typeof value === 'object' && value !== null && issuedOperationalGrants.has(value);

/** True only for a grant this module produced FOR THIS EXECUTOR OBJECT. */
export const isOperationalEvidenceGrantFor = (
    value: unknown,
    executor: unknown,
): value is OperationalEvidenceGrant => {
    if (!isOperationalEvidenceGrant(value)) return false;
    if (typeof executor !== 'object' || executor === null) return false;
    const issued = operationalGrantsByExecutor.get(executor);
    return issued !== undefined && issued.has(value);
};

const boundedReason = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback;
    const single = value.replace(/\s+/g, ' ').trim();
    if (single.length === 0) return fallback;
    return single.length > 160 ? `${single.slice(0, 160)}…` : single;
};

/**
 * Ask the trusted resolver, then check that its answer is actually about the
 * deployment/contract/executor that was asked about, in scope, and still valid.
 *
 * The deployment and executor identity come from ONE place: `compositionContext`,
 * the server-side context captured at construction. There is no separate
 * `deploymentId`/`executorId` parameter a caller could fill from a request, and
 * nothing here reads identity off the executor/connection object — the context
 * is the only input, and a missing one is a refusal rather than a default.
 *
 * Everything that is not an explicit, matching `verified: true` becomes
 * `{ grant: null, reason }`. A resolver that throws is a refusal, not a pass.
 * No default lifetime is applied: `expiresAtMs` must be finite and later than
 * the reference instant, and that is all this function requires of it.
 */
export async function loadVerifiedOperationalEvidence(input: {
    resolver: TrustedOperationalEvidenceResolver | null | undefined;
    reference: OperationalEvidenceReference | null | undefined;
    executor: unknown;
    compositionContext: LiveCompositionContext | null | undefined;
    contractVersion: string;
    now?: () => number;
}): Promise<OperationalEvidenceLoadResult> {
    const refuse = (reason: string): OperationalEvidenceLoadResult => ({ grant: null, reason });
    if (typeof input.resolver !== 'function') {
        return refuse('no trusted operational verification resolver was injected; a callable dependency is not a verification');
    }
    if (!input.reference || typeof input.reference.source !== 'string' || input.reference.source.trim().length === 0) {
        return refuse('no operational evidence reference was supplied');
    }
    if (typeof input.executor !== 'object' || input.executor === null) {
        return refuse('operational evidence must be bound to an executor object');
    }
    const context = readCompositionContext(input.compositionContext);
    if (context === null) {
        return refuse('no server-side composition context was supplied; deployment and executor identity '
            + 'must come from configuration, not from a request and not from the connection object');
    }
    const readNow = typeof input.now === 'function' ? input.now : Date.now;
    const nowMs = readNow();
    const ask: OperationalEvidenceContext = {
        deploymentId: context.deploymentId,
        contractVersion: input.contractVersion,
        executorId: context.executorId,
        nowMs,
    };

    let verdict: OperationalEvidenceVerdict;
    try {
        verdict = await input.resolver(input.reference, ask);
    } catch (error) {
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? `${String((error as { code?: unknown }).code)}: `
            : '';
        return refuse(`the trusted resolver threw (${code}${boundedReason(
            error && typeof error === 'object' ? (error as { message?: unknown }).message : null,
            'no message',
        )})`);
    }
    if (!verdict || typeof verdict !== 'object') {
        return refuse('the trusted resolver returned no verdict');
    }
    if (verdict.verified !== true) {
        return refuse(`the trusted resolver refused: ${boundedReason(verdict.reason, 'no reason given')}`);
    }
    if (!Array.isArray(verdict.scope) || !verdict.scope.includes(LIVE_OPERATIONAL_SCOPE)) {
        return refuse(`the verdict does not cover the scope "${LIVE_OPERATIONAL_SCOPE}"`);
    }
    if (verdict.deploymentId !== ask.deploymentId
        || verdict.contractVersion !== ask.contractVersion
        || verdict.executorId !== ask.executorId) {
        return refuse('the verdict is about a different deployment, contract or executor');
    }
    if (typeof verdict.verifiedAtMs !== 'number' || !Number.isFinite(verdict.verifiedAtMs)
        || verdict.verifiedAtMs > nowMs) {
        return refuse('the verdict carries no usable verification instant');
    }
    if (typeof verdict.expiresAtMs !== 'number' || !Number.isFinite(verdict.expiresAtMs)
        || verdict.expiresAtMs <= nowMs) {
        return refuse('the verdict is already expired (the resolver must state a lifetime that includes now)');
    }

    const grant: OperationalEvidenceGrant = Object.freeze({
        source: input.reference.source,
        reviewer: typeof input.reference.reviewer === 'string' ? input.reference.reviewer : '',
        scope: Object.freeze([...verdict.scope]),
        deploymentId: verdict.deploymentId,
        contractVersion: verdict.contractVersion,
        executorId: verdict.executorId,
        verifiedAtMs: verdict.verifiedAtMs,
        expiresAtMs: verdict.expiresAtMs,
    });
    issuedOperationalGrants.add(grant);
    const existing = operationalGrantsByExecutor.get(input.executor);
    if (existing) existing.add(grant);
    else operationalGrantsByExecutor.set(input.executor, new Set<OperationalEvidenceGrant>([grant]));
    return { grant, reason: null };
}

/**
 * The authoritative, freshly evaluated verdict. Every call re-reads the clock,
 * so a report that aged out is reported as stale without restarting anything.
 *
 * `scope` is explicit because the name `fullyReady` was too wide: this verdict
 * covers the LIVE PARTICIPANT / SESSION CALLBACK PATH only. It says nothing
 * about library promotion, metering, the recovery checkpoint, or end-to-end
 * recording readiness — those are separate capabilities with separate reasons,
 * and reporting them through this field would be exactly the collapse this
 * correction removes.
 *
 * `fullyReady` is `'configured'` only when ALL of the following hold: the
 * callback-path configuration is complete (mapping, declared cursor, lifecycle,
 * non-default verifiers, a valid ticket secret), a report produced by
 * `verifyLiveSchema` FOR THIS executor was applied, that report's contract
 * version matches, it is still fresh, and `sessionLifecycle`,
 * `presenceOrdering` and `presenceEventIdentity` are all `verified` with no
 * invalidation. Anything less is `unconfigured` with the missing pieces named.
 *
 * `operational` is deliberately a SEPARATE question and is `'verified'` ONLY
 * when a grant produced by the injected trusted resolver is present for this
 * executor, was issued for THIS composition's `deploymentId` AND `executorId`,
 * still inside the lifetime the resolver stated, in scope, and the callback path
 * is otherwise fully ready. A missing composition context is `not-verified`, and
 * so is a grant issued for another deployment — a grant is not transferable
 * between environments. An object that merely LOOKS like evidence cannot reach
 * it, and a callable dependency never proves that a provider's signatures are
 * actually authenticated.
 */
export interface LiveRuntimeReadiness {
    readonly evaluatedAtMs: number;
    /** What this verdict covers. Never "everything live". */
    readonly scope: 'live.callback-path';
    readonly schema: Readonly<Record<LiveSchemaArea, LiveSchemaAreaState>>;
    readonly schemaReportPresent: boolean;
    readonly schemaReportAgeMs: number | null;
    readonly schemaFresh: boolean;
    readonly schemaFreshnessMs: number;
    readonly invalidated: Readonly<Record<string, LiveSchemaInvalidation>>;
    readonly fullyReady: LiveCapability;
    /**
     * The RECORDING path, configuration-only: library port + meter port +
     * declared checkpoint. It is a SEPARATE answer on purpose — `operational`
     * below is scoped to `live.callback.path` and never implies that recordings
     * are verified, and this field never implies the callback path is ready.
     */
    readonly recordingConfigured: LiveCapability;
    readonly operational: 'verified' | 'not-verified';
    readonly reasons: Readonly<Record<string, string>>;
}

/**
 * The old shape-only validator is GONE on purpose. It checked that a reviewer
 * string was non-empty, that the scope array contained the scope and that a
 * timestamp was recent — all of which a fabricated object satisfies. It could
 * not distinguish evidence from a description of evidence, so it is replaced by
 * `loadVerifiedOperationalEvidence` + the provenance-checked grant above.
 */

/**
 * The construction-time SNAPSHOT of what was wired. Every field here is a
 * configuration fact measured once, at build time, and none of them is a
 * runtime verdict: freshness, invalidation and the `fullyReady` verdict live in
 * `LiveRuntime.readiness()`, which is re-evaluated on every call.
 */
export interface LiveRuntimeStatus {
    /** Session store + core, over the injected executor. */
    readonly sessions: LiveCapability;
    /** Presence-interval methods on that store. */
    readonly presence: LiveCapability;
    /** Ingest ledger store + ingest service. */
    readonly ingest: LiveCapability;
    /** `video_assets` promotion port (see `libraryRunner`). */
    readonly library: LiveCapability;
    /**
     * Storage metering. `configured` iff `meterStorage` was injected. It says
     * nothing about whether a given recording was metered — that is the ingest
     * result's `metering`/`storageAccounted`, per recording, not a runtime fact.
     */
    readonly metering: LiveCapability;
    /** The explicit `runRecoveryOnce` entry point. */
    readonly recovery: LiveCapability;
    /**
     * Cross-invocation persistence of `report.continuation`, i.e. the R24
     * durable checkpoint. `'configured'` iff `recoveryCheckpoint: 'declared'`
     * was requested AND a checkpoint store was built — the field reports what
     * was built, not what was asked for.
     *
     * It says nothing about the TABLE: the R24 migration is requested and absent,
     * so a configured checkpoint still degrades to `checkpoint-absent` at
     * runtime and the pass reports `checkpoint-unavailable` without scanning.
     * The `recoveryCheckpoint` SCHEMA area is where that is answered, and only
     * `readiness()` combines the two.
     */
    readonly recoveryCheckpoint: LiveCapability;
    /** `checkedAtMs` of the applied schema report, or `null` when none was applied. */
    readonly schemaVerifiedAtMs: number | null;
    /** The contract version of the applied report, or `null`. */
    readonly schemaContract: string | null;
    /** The sealed chain writer, without which construction throws. */
    readonly sealedAudit: LiveCapability;
    /** Provider signature verification. Not one of the seven; a sub-dependency. */
    readonly callbacks: LiveCapability;
    /** Trusted provider→participant mapping for presence callbacks. */
    readonly participantMapping: LiveCapability;
    /**
     * Per-participant presence EVENT ordering: the R22 cursor is declared AND
     * both ports are present on the built store. Definition: `configured` iff
     * `store.presenceCursor === 'declared'` and `readPresenceCursor` /
     * `advancePresenceCursor` are functions on that store. Anything else ⇒
     * participant callbacks fail closed with `ignored:ordering-unavailable`.
     */
    readonly presenceOrdering: LiveCapability;
    /**
     * Session lifecycle writes. Definition: `configured` iff the store exposes
     * `withTransaction`, `insertSession`, `findSession`, `findSessionByProvider`
     * and `updateSessionState` — i.e. a session can be created, located and
     * transitioned, not merely read.
     */
    readonly sessionLifecycle: LiveCapability;
    /**
     * CONFIGURATION ONLY — DEPRECATED AS A VERDICT. `configured` iff the
     * callback path is fully WIRED: `participantMapping`, `presenceOrdering`,
     * `sessionLifecycle`, both provider verifiers non-default, and a valid
     * ticket secret. It deliberately does not mean "the live path works": it
     * says nothing about the database, and the R22 cursor it depends on is a
     * caller attestation.
     *
     * Read `readiness().fullyReady` instead. This field stays for compatibility
     * and is conservative on purpose: a partially-wired composition can never
     * be reported as ready here either.
     */
    readonly liveReady: LiveCapability;
    /** Join-ticket HMAC secret. Sub-dependency of `sessions`. */
    readonly ticketSigning: LiveCapability;
    /** HTTP router. Sub-dependency; needs `optionalAuthenticate`. */
    readonly router: LiveCapability;
    /** Why each `unconfigured` entry is unconfigured. */
    readonly reasons: Readonly<Record<string, string>>;
}

export interface LiveRuntimeDeps {
    /** REQUIRED. One connection-bound runner for sessions, presence and ingest. */
    executor: LiveSessionSqlExecutor;
    /** REQUIRED. The sealed chain writer; no no-op, no plain INSERT. */
    sealedAudit: SealedAuditWriter;
    /**
     * Optional. Omitted ⇒ `executor`. `null` ⇒ leave the library unwired on
     * purpose (the ingest then reports `library_unconfigured` per recording).
     */
    libraryRunner?: RecordingLibraryRunner | null;
    /** Fail-closed `false` when absent. */
    verifyLiveCallbackSignature?: LiveSignatureVerifier;
    /** Fail-closed `false` when absent. */
    verifyRecordingCallbackSignature?: RecordingSignatureVerifier;
    /** Absent/short ⇒ the core refuses ticket issuance. */
    ticketSecret?: string;
    /**
     * OPTIONAL, opt-in. Trusted provider→participant mapping for
     * `participant.joined` / `participant.left`. Absent ⇒ those callbacks fail
     * closed with `mapping-unavailable`; `session.started` / `session.ended`
     * are unaffected. `createInternalUserIdParticipantResolver` is the explicit
     * helper for a provider that genuinely uses the internal user id; it is
     * never wired automatically.
     */
    resolveProviderParticipant?: ResolveProviderParticipant;
    /**
     * OPTIONAL, default `'unconfigured'`. Composition attestation that
     * `server/migrations/20261023_02_live_callback_presence_contract.sql` (R22 +
     * R23) is applied. Set `'declared'` ONLY after that migration lands: it is
     * what enables the presence event cursor on the session store. Without it the
     * cursor ports are absent and participant callbacks fail closed with
     * `ignored:ordering-unavailable`. This factory never probes the catalog.
     */
    presenceCursor?: PresenceCursorReadiness;
    /**
     * The report produced by `verifyLiveSchema(executor)` — and ONLY such a
     * report. It is validated with `isLiveSchemaReportFor(report, executor)`:
     * an object literal that merely has the right shape, or a report measured
     * against a different executor object, is refused with `invalid_deps`.
     * `null`/omitted ⇒ no measurement was applied and `readiness().fullyReady`
     * stays `unconfigured`.
     *
     * This factory never calls the verifier itself: verification is an explicit
     * caller decision and construction performs no I/O.
     */
    schemaReport?: LiveSchemaReport | null;
    /**
     * How long an applied report stays fresh, evaluated at `readiness()` time.
     * Default and maximum `LIVE_SCHEMA_MAX_AGE_MS`; a smaller positive value is
     * honoured, anything else falls back to the maximum. It cannot be widened.
     */
    schemaFreshnessMs?: number;
    /**
     * OPTIONAL, default `'unconfigured'`. `'declared'` builds the R24 durable
     * checkpoint store and hands it to the bounded pass, which then persists its
     * cursor after every inspected page and refuses to start anywhere the
     * durable row did not record. Requires `recoveryCheckpointOwner`; declaring
     * it without an owner throws rather than silently downgrading.
     *
     * The R24 table is REQUESTED and absent, so a declared checkpoint still
     * reports `checkpoint-unavailable` at runtime until the migration lands.
     */
    recoveryCheckpoint?: 'unconfigured' | 'declared';
    /** Stable worker token for the checkpoint lease. Required when declared. */
    recoveryCheckpointOwner?: string;
    /** Clamped by the store to `CHECKPOINT_LEASE_MS_CEILING`. */
    recoveryCheckpointLeaseMs?: number;
    /**
     * WHERE THIS PROCESS RUNS, as far as its own configuration is concerned:
     * `{ deploymentId, executorId }`. Read ONCE here, at construction, frozen,
     * and captured in the closure — later mutation of this object has no effect.
     *
     * It must be populated from the same configuration that builds the pool. It
     * must never be filled from a request (header, query, body, route param) and
     * must never be derived from the executor/connection object: a connection
     * knows which host it reached, not which deployment this process was
     * configured to serve.
     *
     * Omitted, or with an empty/non-string id ⇒ `operational: 'not-verified'`
     * for the lifetime of this runtime, with the reason naming the missing
     * context. It is not a construction error and it is not defaulted.
     */
    compositionContext?: LiveCompositionContext | null;
    /**
     * A grant produced by `loadVerifiedOperationalEvidence` — i.e. the answer of
     * an injected TRUSTED server-side resolver, bound to this executor object,
     * issued for THIS composition's `deploymentId`/`executorId`, still inside
     * the lifetime the resolver stated.
     *
     * Load it explicitly BEFORE composition (the loader is async, readiness is
     * not). Omitted, forged, stale, out-of-scope, issued for another executor or
     * for another deployment ⇒ `readiness().operational` is `'not-verified'`,
     * always. There is no boolean shortcut, no request/browser evidence, and no
     * shape check that a fabricated object could satisfy.
     */
    operationalEvidence?: OperationalEvidenceGrant | null;
    /**
     * OPTIONAL storage meter. Wiring it is only coherent now that the ingest
     * promotes the library FIRST and meters with the PROMOTED `video_assets.id`
     * (2026-10-23): the meter resolves an asset id, and the old synthetic
     * `provider:recording` value was not an asset at all, so every recording
     * would have settled as `metering_deferred` for ever.
     *
     * Absent ⇒ every recording stays PENDING with deferred reason
     * `metering-unconfigured` (lease released, marker retryable), and this
     * runtime reports `metering: 'unconfigured'`. Absence is NOT a policy
     * exemption: an unaccounted recording is never terminal, because a terminal
     * row cannot be retried and the recovery pass only scans `pending`.
     *
     * This factory creates no meter and no provider client; the caller injects
     * the port.
     */
    meterStorage?: RecordingStorageMeterPort | null;
    now?: () => number;
    idFactory?: () => string;
    callbackGraceSeconds?: number;
    recordingGraceSeconds?: number;
    /** Only needed to build the router; absent ⇒ `router: null`. */
    optionalAuthenticate?: RequestHandler;
}

export interface LiveRuntime {
    readonly core: LiveSessionCore;
    readonly ingest: RecordingIngestService;
    readonly sessionStore: LiveSessionSqlStore;
    readonly ingestStore: RecordingIngestSqlStore;
    readonly library: RecordingLibraryPromotionPort | null;
    readonly status: LiveRuntimeStatus;
    /** Built only when `optionalAuthenticate` was supplied. */
    readonly router: Router | null;
    /**
     * THE authoritative verdict, evaluated NOW. Configuration + applied schema
     * report + freshness + invalidation, with `fullyReady` and `operational` as
     * two separate answers. Cheap and side-effect free; call it whenever a
     * status or a health endpoint needs to know, not once at startup.
     */
    readiness(nowMs?: number): LiveRuntimeReadiness;
    /**
     * Apply a newer report produced by `verifyLiveSchema` for THIS executor.
     * Throws `invalid_deps` for anything else. Applying one clears the
     * invalidations recorded before it: a fresh measurement is newer than the
     * error it replaces.
     */
    applySchemaReport(report: LiveSchemaReport): void;
    /**
     * Record a runtime `schema_unavailable` failure for one area (typically
     * caught at the route boundary). That area reads `invalidated` and
     * `fullyReady` drops until a newer report is applied.
     *
     * The area is named by the CALLER that observed the error: this factory does
     * not guess it from a message string, because a guess would be wrong exactly
     * when it matters.
     */
    noteSchemaUnavailable(area: LiveSchemaArea, reason: string): void;
    /**
     * Stop accepting NEW recovery passes. Idempotent. It does not drain, cancel
     * or close anything — this factory owns no pool and no in-flight promise —
     * and it never runs a final pass. Call it first in shutdown, then drain what
     * you hold, then release the checkpoint (the in-flight pass does that as it
     * finishes) and close the pool you own.
     */
    beginShutdown(): void;
    /**
     * ONE bounded recovery pass over pending ingest rows. Explicit call only:
     * never scheduled, never started here, no timer.
     *
     * `options` is forwarded VERBATIM — including a cross-invocation `after`
     * continuation when the recovery source supports one — and the returned
     * report (including `continuation` / `sweepComplete`) is returned
     * unchanged. THE CALLER OWNS PERSISTING THE CONTINUATION: this factory
     * starts no scheduler and keeps no cursor of its own, so a caller that
     * discards it re-creates the starvation the continuation exists to fix.
     */
    runRecoveryOnce(options?: RecordingRecoveryOptions): Promise<RecordingRecoveryReport>;
}

/** Zero-argument function: assignable to either verifier, and always refuses. */
const DENY_ALL_SIGNATURES = (): boolean => false;

/**
 * Is this verifier the fail-closed default (or absent)?
 *
 * Compared by IDENTITY against the module's own deny-all function, and the
 * argument is typed `unknown` so the comparison is a value comparison rather
 * than a function-signature one. A caller that passes its own always-false
 * function is NOT the default and cannot be detected here — which is exactly
 * why a callable dependency never earns an operational verdict.
 */
const isDefaultVerifier = (verifier: unknown): boolean =>
    verifier === undefined || verifier === null || verifier === DENY_ALL_SIGNATURES;

/**
 * Freshness window: default and maximum, configurable DOWNWARD only.
 * A non-finite, non-positive or unreadable value falls back to the maximum
 * rather than to "forever".
 */
const resolveFreshnessMs = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return LIVE_SCHEMA_MAX_AGE_MS;
    const truncated = Math.trunc(value);
    if (truncated <= 0) return LIVE_SCHEMA_MAX_AGE_MS;
    return Math.min(LIVE_SCHEMA_MAX_AGE_MS, truncated);
};

/**
 * The ONLY route to `operational: 'verified'`. It starts from provenance, not
 * from fields, and it never trusts the grant to describe itself.
 *
 * Order matters, and each step closes a different hole:
 *
 *  1. provenance — was this object produced by the trusted loader, FOR THIS
 *     executor object? A look-alike with the right fields fails here however
 *     complete it looks.
 *  2. COMPOSITION CONTEXT — do the grant's `deploymentId` and `executorId` match
 *     the server-side context captured at construction? This is the step that
 *     stops a grant issued for staging from verifying production, and it is
 *     deliberately NOT satisfied by the grant's own fields or by anything read
 *     off the connection. Absent context is `not-verified`, never a default.
 *  3. contract version, then 4. scope, then 5. the resolver's own expiry,
 *     evaluated at the instant of the call.
 *
 * Every comparison is `===` on the caller's own strings. Nothing is trimmed,
 * lower-cased or normalised: two ids that differ by one byte are two ids.
 */
const describeOperationalState = (
    grant: unknown,
    executor: unknown,
    compositionContext: LiveCompositionContext | null,
    nowMs: number,
): { ok: boolean; reason: string | null } => {
    if (grant === undefined || grant === null) {
        return {
            ok: false,
            reason: 'no operational verification was loaded; supply the grant returned by '
                + 'loadVerifiedOperationalEvidence, or this stays not-verified',
        };
    }
    if (!isOperationalEvidenceGrantFor(grant, executor)) {
        return {
            ok: false,
            reason: 'the supplied operational evidence was not produced by the trusted resolver for THIS executor; '
                + 'an object that merely has the right fields is not evidence',
        };
    }
    if (compositionContext === null) {
        return {
            ok: false,
            reason: 'this runtime has no server-side composition context (deploymentId + executorId), so no grant '
                + 'can be matched to it; supply it from configuration at construction — not from a request and '
                + 'not from the connection object',
        };
    }
    if (grant.deploymentId !== compositionContext.deploymentId) {
        return {
            ok: false,
            reason: 'the operational verification was issued for a different deployment than this composition runs; '
                + 'a grant is not transferable between deployments',
        };
    }
    if (grant.executorId !== compositionContext.executorId) {
        return {
            ok: false,
            reason: 'the operational verification was issued for a different executor than this composition '
                + 'declares; the executor object alone does not establish which deployment is being served',
        };
    }
    if (grant.contractVersion !== LIVE_SCHEMA_CONTRACT_VERSION) {
        return {
            ok: false,
            reason: `the operational verification covers contract "${grant.contractVersion}", `
                + `this source speaks "${LIVE_SCHEMA_CONTRACT_VERSION}"`,
        };
    }
    if (!grant.scope.includes(LIVE_OPERATIONAL_SCOPE)) {
        return { ok: false, reason: `the operational verification does not cover "${LIVE_OPERATIONAL_SCOPE}"` };
    }
    if (!(grant.expiresAtMs > nowMs)) {
        return {
            ok: false,
            reason: `the operational verification expired at ${String(grant.expiresAtMs)} ms; `
                + 're-run the trusted resolver and load a fresh grant',
        };
    }
    return { ok: true, reason: null };
};

/**
 * EXPLICIT OPT-IN composition for a provider whose setup genuinely uses the
 * INTERNAL user id as its participant identity.
 *
 * It is NEVER wired automatically: `createLiveRuntime` only uses a resolver the
 * caller passes as `resolveProviderParticipant`. This helper performs a real
 * participant lookup by `(sessionId, tenantId, userId)` and returns `null` when
 * no such row exists — it does not assume the provider identity is a user. The
 * core re-validates the answer against the session before any write.
 */
export const createInternalUserIdParticipantResolver = (
    store: Pick<LiveSessionStore, 'listParticipants'>,
): ResolveProviderParticipant => async (input) => {
    const participants = await store.listParticipants(input.sessionId, input.tenantId);
    const row = participants.find((participant) => participant.userId === input.providerParticipantId) ?? null;
    return row === null ? null : { participantId: row.id, userId: row.userId };
};

/**
 * Build the live runtime. Throws before constructing anything when a mandatory
 * dependency is missing — there is no partial runtime and no fallback.
 */
export const createLiveRuntime = (deps: LiveRuntimeDeps): LiveRuntime => {
    if (!deps || !deps.executor) {
        throw new LiveRuntimeError(
            'invalid_deps',
            'createLiveRuntime requires a connection-bound executor for sessions, presence and ingest',
        );
    }
    if (typeof deps.sealedAudit !== 'function') {
        throw new LiveRuntimeError(
            'invalid_deps',
            'createLiveRuntime requires a sealed audit writer; there is no no-op and no plain INSERT fallback',
        );
    }

    const { executor, sealedAudit } = deps;
    const now = deps.now;
    const idFactory = deps.idFactory;

    /**
     * The server-side composition context, normalised ONCE and captured here.
     *
     * Reading it at construction rather than at `readiness()` time is deliberate:
     * the identity of this deployment cannot change while the runtime serves
     * requests, and a value re-read per call would be a value something could
     * change per call. A missing context is `null`, which `describeOperationalState`
     * turns into `not-verified` — it is never defaulted and never thrown for.
     */
    const compositionContext = readCompositionContext(deps.compositionContext);

    /**
     * The operational grant, captured ONCE at construction for the same reason
     * the composition context is: `deps` is the caller's object, and reading
     * `deps.operationalEvidence` on every `readiness()` call leaves a channel
     * that can substitute a different grant after composition. The grant is
     * still re-checked on every call (provenance, executor, deployment,
     * contract, scope, expiry), so capturing it removes a mutation channel
     * without weakening a single check — and it matches the documented contract
     * that the grant is loaded BEFORE composition.
     */
    const operationalEvidence: OperationalEvidenceGrant | null = deps.operationalEvidence ?? null;

    /**
     * F1: a schema report is accepted ONLY when this module's verifier produced
     * it for THIS executor object, and only under the contract version this
     * source speaks. A look-alike literal, or a report measured against another
     * connection, is a dependency error — not a warning and not a downgrade.
     */
    const schemaFreshnessMs = resolveFreshnessMs(deps.schemaFreshnessMs);
    const assertUsableReport = (report: LiveSchemaReport): void => {
        if (!isLiveSchemaReportFor(report, executor)) {
            throw new LiveRuntimeError(
                'invalid_deps',
                'the schema report was not produced by verifyLiveSchema for THIS executor object; '
                    + 'a structurally similar object is not evidence about this connection',
            );
        }
        if (report.contractVersion !== LIVE_SCHEMA_CONTRACT_VERSION) {
            throw new LiveRuntimeError(
                'invalid_deps',
                `the schema report speaks contract "${String(report.contractVersion)}", `
                    + `this source speaks "${LIVE_SCHEMA_CONTRACT_VERSION}"`,
            );
        }
    };
    let schemaReport: LiveSchemaReport | null = null;
    if (deps.schemaReport !== undefined && deps.schemaReport !== null) {
        assertUsableReport(deps.schemaReport);
        schemaReport = deps.schemaReport;
    }
    /** Areas a runtime error proved unusable AFTER the report was measured. */
    const invalidated = new Map<LiveSchemaArea, LiveSchemaInvalidation>();

    const sessionStore = createLiveSessionSqlStore({
        executor,
        sealedAudit,
        // Default 'unconfigured': ordered presence callbacks are never enabled
        // without the R22 attestation.
        presenceCursor: deps.presenceCursor,
    });
    const ingestStore = createRecordingIngestSqlStore({ executor, sealedAudit });

    // `null` is a deliberate "do not wire the library"; `undefined` reuses the
    // executor, whose shape already satisfies the library runner port.
    const library = deps.libraryRunner === null
        ? null
        : createRecordingLibraryPort(deps.libraryRunner ?? executor, idFactory);

    const core = createLiveSessionCore({
        store: sessionStore,
        verifyCallbackSignature: deps.verifyLiveCallbackSignature ?? DENY_ALL_SIGNATURES,
        ticketSecret: deps.ticketSecret,
        // Composition only: no resolver ⇒ participant callbacks fail closed.
        resolveProviderParticipant: deps.resolveProviderParticipant,
        now,
        idFactory,
        callbackGraceSeconds: deps.callbackGraceSeconds,
    });

    /**
     * Composition validation, not a null check.
     *
     * A `meterStorage` that was injected but does not implement
     * `recordVerifiedBytes(...)` would be forwarded into the ingest and throw on
     * every recording, where the throw is caught as `deferred` and the row
     * retries for ever against an object that can never succeed. The shape is
     * checked once, here, before it is forwarded — and the same verdict drives
     * readiness, so the two cannot disagree.
     */
    const meterCandidate: unknown = deps.meterStorage;
    const meterPortUsable = typeof meterCandidate === 'object'
        && meterCandidate !== null
        && typeof (meterCandidate as { recordVerifiedBytes?: unknown }).recordVerifiedBytes === 'function';

    const ingest = createRecordingIngestService({
        store: ingestStore,
        library: library ?? undefined,
        // The ingest promotes the library first and meters the PROMOTED id, so
        // this port is now safe to wire. Absent stays absent: `undefined`, never
        // a no-op meter that would fake a measurement. A malformed object is
        // treated exactly like an absent one — composing it could only produce a
        // permanent deferred row.
        meterStorage: meterPortUsable ? meterCandidate as RecordingStorageMeterPort : undefined,
        verifyCallbackSignature: deps.verifyRecordingCallbackSignature ?? DENY_ALL_SIGNATURES,
        now,
        idFactory,
        graceSeconds: deps.recordingGraceSeconds,
    });

    const router = deps.optionalAuthenticate
        ? createLiveSessionsRouter({ core, optionalAuthenticate: deps.optionalAuthenticate })
        : null;

    /**
     * F3: the durable checkpoint is built only when the composition declares it
     * AND supplies the worker token its lease is fenced on. Declaring without an
     * owner throws: a checkpoint nobody can own is not a degraded checkpoint,
     * it is a wiring mistake — and silently falling back to `after` would hide
     * exactly the starvation the checkpoint exists to remove.
     */
    let recoveryCheckpoint: RecordingRecoveryCheckpoint | null = null;
    const checkpointOwner = typeof deps.recoveryCheckpointOwner === 'string'
        ? deps.recoveryCheckpointOwner.trim()
        : '';
    if (deps.recoveryCheckpoint === 'declared') {
        if (checkpointOwner.length === 0) {
            throw new LiveRuntimeError(
                'invalid_deps',
                'recoveryCheckpoint: "declared" requires recoveryCheckpointOwner; the checkpoint lease is fenced on it',
            );
        }
        recoveryCheckpoint = createRecordingCheckpointSqlStore({ executor });
    }

    const presenceConfigured = typeof sessionStore.openPresenceInterval === 'function'
        && typeof sessionStore.closePresenceInterval === 'function'
        && typeof sessionStore.listPresenceIntervals === 'function';
    const libraryConfigured = library !== null;
    /**
     * CONFIGURATION only, and identity-checked: an absent verifier or this
     * module's own deny-all is unconfigured. A caller's always-false function is
     * indistinguishable here — which is why `operational` exists as a separate
     * answer that no callable dependency can satisfy.
     */
    const callbacksConfigured = typeof deps.verifyLiveCallbackSignature === 'function'
        && !isDefaultVerifier(deps.verifyLiveCallbackSignature)
        && typeof deps.verifyRecordingCallbackSignature === 'function'
        && !isDefaultVerifier(deps.verifyRecordingCallbackSignature);
    const participantMappingConfigured = typeof deps.resolveProviderParticipant === 'function';
    // Read off the BUILT store, not off the input: what it will actually do.
    const presenceOrderingConfigured = sessionStore.presenceCursor === 'declared'
        && typeof sessionStore.readPresenceCursor === 'function'
        && typeof sessionStore.advancePresenceCursor === 'function';
    const sessionLifecycleConfigured = typeof sessionStore.withTransaction === 'function'
        && typeof sessionStore.insertSession === 'function'
        && typeof sessionStore.findSession === 'function'
        && typeof sessionStore.findSessionByProvider === 'function'
        && typeof sessionStore.updateSessionState === 'function';
    // The core's own rule, not a second copy of it: a secret it would refuse to
    // sign with is not a configured signer.
    const ticketSigningConfigured = isValidTicketSecret(deps.ticketSecret);
    const recoveryCheckpointConfigured = recoveryCheckpoint !== null;
    const liveReadyConfigured = participantMappingConfigured
        && presenceOrderingConfigured
        && sessionLifecycleConfigured
        && callbacksConfigured
        && ticketSigningConfigured;
    const routerConfigured = router !== null;

    /**
     * The RECORDING path is a SEPARATE capability from the callback path. It is
     * configuration-only: library port present, a USABLE meter port present,
     * checkpoint declared. It says nothing about the provider, the schema, or
     * whether a given recording was actually accounted — and `operational` (which
     * is scoped to `live.callback.path`) never implies it.
     *
     * `meteringConfigured` reuses `meterPortUsable` from composition instead of
     * re-deriving the shape check, so the port that was forwarded and the
     * capability that is reported are the same fact and cannot drift apart.
     */
    const meteringConfigured = meterPortUsable;
    const recordingConfigured: LiveCapability = libraryConfigured && meteringConfigured && recoveryCheckpointConfigured
        ? 'configured'
        : 'unconfigured';

    const reasons: Record<string, string> = {};
    if (deps.meterStorage !== undefined && deps.meterStorage !== null && !meteringConfigured) {
        reasons.metering = 'meterStorage was injected but does not implement recordVerifiedBytes(...); it is '
            + 'treated as ABSENT rather than composed, because a port that can only throw would make every '
            + 'recording retry for ever instead of staying honestly pending. Inject a real MediaMeteringService '
            + 'adapter, or leave it undefined and accept metering-unconfigured.';
    }
    if (!meteringConfigured && (deps.meterStorage === undefined || deps.meterStorage === null)) {
        reasons.metering = 'no meterStorage was injected; every recording stays PENDING with deferred reason '
            + '"metering-unconfigured" and hands its lease back. Absence is not a policy exemption — nothing '
            + 'settles ingested until storage accounting is recorded or proven duplicated, so composing a meter '
            + 'later lets one redelivery finish the charge against the same asset and the same recording/stage '
            + 'key. This factory creates no meter of its own.';
    }
    reasons.recoveryCheckpoint = recoveryCheckpointConfigured
        ? 'the R24 checkpoint store is built and the pass persists its cursor after every inspected page; the '
            + 'TABLE is a request (20261023_04_live_recovery_checkpoint.sql), so until it lands every checkpoint '
            + 'operation degrades to checkpoint-absent and the pass reports checkpoint-unavailable without scanning'
        : 'integration-open: no durable checkpoint is composed, so nothing persists report.continuation between '
            + 'invocations and only the quarantine layer prevents starvation, and only for the two provable reasons';
    if (!recordingConfigured) {
        const missing = [
            libraryConfigured ? null : 'library',
            meteringConfigured ? null : 'metering',
            recoveryCheckpointConfigured ? null : 'recoveryCheckpoint',
        ].filter((name): name is string => name !== null);
        reasons.recordingConfigured = `recording path incomplete: ${missing.join(', ')}`;
    }
    if (!presenceConfigured) {
        reasons.presence = 'the session store does not expose the presence-interval methods';
    }
    if (!libraryConfigured) {
        reasons.library = 'libraryRunner was explicitly null; recordings settle pending with library_unconfigured';
    }
    if (!callbacksConfigured) {
        reasons.callbacks = 'no provider signature verifier supplied (or the fail-closed default is still wired); '
            + 'every callback is refused and audited';
    }
    if (!participantMappingConfigured) {
        reasons.participantMapping = 'no resolveProviderParticipant supplied; participant.joined/left callbacks '
            + 'fail closed with mapping-unavailable until a trusted mapping is composed';
    }
    if (!presenceOrderingConfigured) {
        reasons.presenceOrdering = sessionStore.presenceCursor === 'declared'
            ? 'the session store declared the R22 cursor but does not expose both cursor ports'
            : 'the R22 presence cursor is not declared; set presenceCursor: "declared" only after '
                + '20261023_02_live_callback_presence_contract.sql is applied — participant callbacks fail '
                + 'closed with ignored:ordering-unavailable until then';
    }
    if (!sessionLifecycleConfigured) {
        reasons.sessionLifecycle = 'the session store does not expose every lifecycle write '
            + '(withTransaction, insertSession, findSession, findSessionByProvider, updateSessionState)';
    }
    if (!liveReadyConfigured) {
        const missing = [
            participantMappingConfigured ? null : 'participantMapping',
            presenceOrderingConfigured ? null : 'presenceOrdering',
            sessionLifecycleConfigured ? null : 'sessionLifecycle',
            callbacksConfigured ? null : 'callbacks',
            ticketSigningConfigured ? null : 'ticketSigning',
        ].filter((name): name is string => name !== null);
        reasons.liveReady = 'the live callback path is not fully CONFIGURED: '
            + `${missing.join(', ')} unconfigured. This field is configuration-only; `
            + 'read readiness().fullyReady for the verdict';
    }
    if (!ticketSigningConfigured) {
        reasons.ticketSigning = 'no usable ticketSecret supplied (the core requires at least '
            + 'LIVE_TICKET_SECRET_MIN_BYTES of UTF-8); createSession refuses with signing-unconfigured';
    }
    if (!routerConfigured) {
        reasons.router = 'no optionalAuthenticate supplied; no router was built';
    }

    /**
     * The clock used for freshness and invalidation. An explicit argument wins
     * so a caller can evaluate readiness for a known instant; otherwise the
     * injected clock, otherwise the wall clock.
     */
    const readClock = (explicit?: number): number => {
        if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
        return typeof now === 'function' ? now() : Date.now();
    };

    /**
     * F1: configuration + schema + freshness + invalidation, evaluated NOW.
     * Deliberately recomputed on every call — a verdict frozen at construction
     * would keep saying "verified" long after the report stopped being evidence.
     */
    const evaluateReadiness = (evaluatedAtMs: number): LiveRuntimeReadiness => {
        const reasonsOut: Record<string, string> = {};
        const schema: Record<LiveSchemaArea, LiveSchemaAreaState> = {
            sessionLifecycle: 'unverified',
            presenceOrdering: 'unverified',
            presenceEventIdentity: 'unverified',
            ingestLedger: 'unverified',
            recoveryCheckpoint: 'unverified',
        };
        for (const area of LIVE_SCHEMA_AREAS) {
            const result = schemaReport === null ? undefined : schemaReport.areas[area];
            if (result !== undefined) schema[area] = result.status;
        }
        const invalidationSnapshot: Record<string, LiveSchemaInvalidation> = {};
        for (const [area, record] of invalidated) {
            invalidationSnapshot[area] = record;
            schema[area] = 'invalidated';
        }
        const ageMs = schemaReport === null
            ? null
            : evaluatedAtMs - schemaReport.checkedAtMs;
        const fresh = ageMs !== null && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= schemaFreshnessMs;

        const requiredAreas: readonly LiveSchemaArea[] = [
            'sessionLifecycle',
            'presenceOrdering',
            'presenceEventIdentity',
        ];
        const unverifiedAreas = requiredAreas.filter((area) => schema[area] !== 'verified');
        const schemaReady = schemaReport !== null && fresh && unverifiedAreas.length === 0;

        if (schemaReport === null) {
            reasonsOut.schema = 'no schema report applied: call verifyLiveSchema(executor) explicitly and pass its '
                + 'result; wired dependencies are not a measurement';
        } else if (ageMs !== null && ageMs < 0) {
            reasonsOut.schema = 'the schema report is dated after the evaluation clock; future evidence cannot prove readiness';
        } else if (!fresh) {
            reasonsOut.schema = `the schema report is ${String(ageMs)} ms old, beyond the ${schemaFreshnessMs} ms `
                + 'freshness window';
        } else if (unverifiedAreas.length > 0) {
            reasonsOut.schema = `schema areas not verified: ${
                unverifiedAreas.map((area) => `${area}=${schema[area]}`).join(', ')
            }`;
        }

        // `router` BELONGS in this list, and it was the last false verdict left
        // in the composition. `fullyReady` is scoped to `'live.callback-path'`
        // (see `LiveRuntimeReadiness.scope`), and that path is an HTTP surface:
        // with `router: null` — no `optionalAuthenticate` supplied — no callback
        // can ever reach this process, yet the verdict said `configured` as soon
        // as the five wiring flags and the schema were in place. A composition
        // that cannot receive a callback is not a ready callback path, and
        // `operational` (which requires `fullyReady === 'configured'`) must not
        // become claimable for one either. The recording question is answered
        // separately by `recordingConfigured`, so nothing is lost by naming the
        // missing surface here.
        const missingConfig = [
            participantMappingConfigured ? null : 'participantMapping',
            presenceOrderingConfigured ? null : 'presenceOrdering',
            sessionLifecycleConfigured ? null : 'sessionLifecycle',
            callbacksConfigured ? null : 'callbacks',
            ticketSigningConfigured ? null : 'ticketSigning',
            routerConfigured ? null : 'router',
        ].filter((name): name is string => name !== null);
        const configReady = missingConfig.length === 0;

        const fullyReady: LiveCapability = schemaReady && configReady ? 'configured' : 'unconfigured';
        if (!configReady) {
            reasonsOut.fullyReady = `configuration incomplete: ${missingConfig.join(', ')}`;
        } else if (!schemaReady) {
            reasonsOut.fullyReady = reasonsOut.schema ?? 'schema is not verified';
        }

        const operationalCheck = describeOperationalState(
            operationalEvidence,
            executor,
            compositionContext,
            evaluatedAtMs,
        );
        const operational: 'verified' | 'not-verified' = operationalCheck.ok && fullyReady === 'configured'
            ? 'verified'
            : 'not-verified';
        if (operational !== 'verified') {
            reasonsOut.operational = operationalCheck.reason
                ?? 'configuration or schema is incomplete, so no operational verdict can be claimed';
        }

        return {
            evaluatedAtMs,
            scope: 'live.callback-path',
            schema,
            schemaReportPresent: schemaReport !== null,
            schemaReportAgeMs: ageMs,
            schemaFresh: fresh,
            schemaFreshnessMs,
            invalidated: invalidationSnapshot,
            fullyReady,
            recordingConfigured,
            operational,
            reasons: reasonsOut,
        };
    };

    const status: LiveRuntimeStatus = {
        sessions: 'configured',
        presence: presenceConfigured ? 'configured' : 'unconfigured',
        ingest: 'configured',
        library: libraryConfigured ? 'configured' : 'unconfigured',
        metering: meteringConfigured ? 'configured' : 'unconfigured',
        recovery: 'configured',
        recoveryCheckpoint: recoveryCheckpointConfigured ? 'configured' : 'unconfigured',
        sealedAudit: 'configured',
        callbacks: callbacksConfigured ? 'configured' : 'unconfigured',
        participantMapping: participantMappingConfigured ? 'configured' : 'unconfigured',
        presenceOrdering: presenceOrderingConfigured ? 'configured' : 'unconfigured',
        sessionLifecycle: sessionLifecycleConfigured ? 'configured' : 'unconfigured',
        liveReady: liveReadyConfigured ? 'configured' : 'unconfigured',
        ticketSigning: ticketSigningConfigured ? 'configured' : 'unconfigured',
        router: routerConfigured ? 'configured' : 'unconfigured',
        schemaVerifiedAtMs: schemaReport === null ? null : schemaReport.checkedAtMs,
        schemaContract: schemaReport === null ? null : schemaReport.contractVersion,
        reasons,
    };

    const recoveryDeps: RecordingRecoveryDeps = {
        source: ingestStore,
        service: ingest,
        now,
        checkpoint: recoveryCheckpoint === null
            ? null
            : { port: recoveryCheckpoint, owner: checkpointOwner, leaseMs: deps.recoveryCheckpointLeaseMs },
    };

    /** F4: shutdown stops NEW work. It never runs a final pass. */
    let shuttingDown = false;

    return {
        core,
        ingest,
        sessionStore,
        ingestStore,
        library,
        status,
        router,
        readiness: (atMs?: number): LiveRuntimeReadiness => evaluateReadiness(readClock(atMs)),
        applySchemaReport: (report: LiveSchemaReport): void => {
            assertUsableReport(report);
            schemaReport = report;
            // A newer measurement supersedes the errors it re-checked. It does
            // NOT supersede an error observed after it, which is why the
            // invalidation is cleared here and re-set only by a later failure.
            invalidated.clear();
        },
        noteSchemaUnavailable: (area: LiveSchemaArea, reason: string): void => {
            if (!(LIVE_SCHEMA_AREAS as readonly string[]).includes(area)) {
                throw new LiveRuntimeError('invalid_deps', `"${String(area)}" is not a live schema area`);
            }
            invalidated.set(area, {
                atMs: readClock(),
                reason: typeof reason === 'string' && reason.length > 0 ? reason : 'schema_unavailable',
            });
        },
        beginShutdown: (): void => {
            shuttingDown = true;
        },
        // Explicit call only. No timer, no `process.on`, no start-on-construct.
        // With a checkpoint the durable row decides where the pass starts; the
        // pass itself rejects an `after` that disagrees with it. After
        // `beginShutdown()` the call is refused before it touches a cursor.
        runRecoveryOnce: (options?: RecordingRecoveryOptions): Promise<RecordingRecoveryReport> => {
            const requested: RecordingRecoveryOptions = options ?? {};
            return shuttingDown
                ? runRecordingRecoveryOnce(recoveryDeps, { ...requested, shutdown: true })
                : runRecordingRecoveryOnce(recoveryDeps, requested);
        },
    };
};
