"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLiveRuntime = exports.createInternalUserIdParticipantResolver = exports.isOperationalEvidenceGrantFor = exports.isOperationalEvidenceGrant = exports.LIVE_OPERATIONAL_SCOPE = exports.LIVE_SCHEMA_MAX_AGE_MS = exports.LiveRuntimeError = void 0;
exports.loadVerifiedOperationalEvidence = loadVerifiedOperationalEvidence;
const live_session_core_1 = require("./live-session-core");
const live_session_sql_1 = require("./live-session-sql");
const live_recording_ingest_1 = require("./live-recording-ingest");
const live_recording_ingest_sql_1 = require("./live-recording-ingest-sql");
const live_recording_recovery_1 = require("./live-recording-recovery");
const video_asset_lifecycle_1 = require("./video-asset-lifecycle");
const live_sessions_1 = require("../routes/live-sessions");
class LiveRuntimeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LiveRuntimeError';
    }
}
exports.LiveRuntimeError = LiveRuntimeError;
/**
 * The MAXIMUM age of a schema report before it stops counting. Fifteen minutes,
 * configurable DOWNWARD only (`schemaFreshnessMs`): a report older than this is
 * not evidence about the database that is serving requests now, and a caller
 * must not be able to widen the window by asking for an hour.
 */
exports.LIVE_SCHEMA_MAX_AGE_MS = 15 * 60 * 1000;
/**
 * The scope string the TRUSTED verification must cover. It is the only scope
 * this lane accepts, and a verdict that does not list it is not a verdict about
 * the callback path.
 */
exports.LIVE_OPERATIONAL_SCOPE = 'live.callback.path';
/**
 * Normalise a candidate composition context, or `null` when there is none.
 *
 * A value that is not an object, or whose ids are not non-empty strings, is
 * ABSENT rather than defaulted: this function never invents an identity, and it
 * returns a frozen copy so a caller cannot mutate the context after composition.
 * The returned ids are the caller's strings verbatim — emptiness is detected on
 * the trimmed form, comparison later is exact.
 */
const readCompositionContext = (value) => {
    if (typeof value !== 'object' || value === null)
        return null;
    const candidate = value;
    if (typeof candidate.deploymentId !== 'string' || candidate.deploymentId.trim().length === 0)
        return null;
    if (typeof candidate.executorId !== 'string' || candidate.executorId.trim().length === 0)
        return null;
    return Object.freeze({
        deploymentId: candidate.deploymentId,
        executorId: candidate.executorId,
    });
};
/** Grants produced by `loadVerifiedOperationalEvidence`, by object identity. */
const issuedOperationalGrants = new WeakSet();
/** Grants per executor OBJECT: a grant is not transferable to another connection. */
const operationalGrantsByExecutor = new WeakMap();
/** True only for a grant this module produced. */
const isOperationalEvidenceGrant = (value) => typeof value === 'object' && value !== null && issuedOperationalGrants.has(value);
exports.isOperationalEvidenceGrant = isOperationalEvidenceGrant;
/** True only for a grant this module produced FOR THIS EXECUTOR OBJECT. */
const isOperationalEvidenceGrantFor = (value, executor) => {
    if (!(0, exports.isOperationalEvidenceGrant)(value))
        return false;
    if (typeof executor !== 'object' || executor === null)
        return false;
    const issued = operationalGrantsByExecutor.get(executor);
    return issued !== undefined && issued.has(value);
};
exports.isOperationalEvidenceGrantFor = isOperationalEvidenceGrantFor;
const boundedReason = (value, fallback) => {
    if (typeof value !== 'string')
        return fallback;
    const single = value.replace(/\s+/g, ' ').trim();
    if (single.length === 0)
        return fallback;
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
async function loadVerifiedOperationalEvidence(input) {
    const refuse = (reason) => ({ grant: null, reason });
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
    const ask = {
        deploymentId: context.deploymentId,
        contractVersion: input.contractVersion,
        executorId: context.executorId,
        nowMs,
    };
    let verdict;
    try {
        verdict = await input.resolver(input.reference, ask);
    }
    catch (error) {
        const code = error && typeof error === 'object' && typeof error.code === 'string'
            ? `${String(error.code)}: `
            : '';
        return refuse(`the trusted resolver threw (${code}${boundedReason(error && typeof error === 'object' ? error.message : null, 'no message')})`);
    }
    if (!verdict || typeof verdict !== 'object') {
        return refuse('the trusted resolver returned no verdict');
    }
    if (verdict.verified !== true) {
        return refuse(`the trusted resolver refused: ${boundedReason(verdict.reason, 'no reason given')}`);
    }
    if (!Array.isArray(verdict.scope) || !verdict.scope.includes(exports.LIVE_OPERATIONAL_SCOPE)) {
        return refuse(`the verdict does not cover the scope "${exports.LIVE_OPERATIONAL_SCOPE}"`);
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
    const grant = Object.freeze({
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
    if (existing)
        existing.add(grant);
    else
        operationalGrantsByExecutor.set(input.executor, new Set([grant]));
    return { grant, reason: null };
}
/** Zero-argument function: assignable to either verifier, and always refuses. */
const DENY_ALL_SIGNATURES = () => false;
/**
 * Is this verifier the fail-closed default (or absent)?
 *
 * Compared by IDENTITY against the module's own deny-all function, and the
 * argument is typed `unknown` so the comparison is a value comparison rather
 * than a function-signature one. A caller that passes its own always-false
 * function is NOT the default and cannot be detected here — which is exactly
 * why a callable dependency never earns an operational verdict.
 */
const isDefaultVerifier = (verifier) => verifier === undefined || verifier === null || verifier === DENY_ALL_SIGNATURES;
/**
 * Freshness window: default and maximum, configurable DOWNWARD only.
 * A non-finite, non-positive or unreadable value falls back to the maximum
 * rather than to "forever".
 */
const resolveFreshnessMs = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return exports.LIVE_SCHEMA_MAX_AGE_MS;
    const truncated = Math.trunc(value);
    if (truncated <= 0)
        return exports.LIVE_SCHEMA_MAX_AGE_MS;
    return Math.min(exports.LIVE_SCHEMA_MAX_AGE_MS, truncated);
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
const describeOperationalState = (grant, executor, compositionContext, nowMs) => {
    if (grant === undefined || grant === null) {
        return {
            ok: false,
            reason: 'no operational verification was loaded; supply the grant returned by '
                + 'loadVerifiedOperationalEvidence, or this stays not-verified',
        };
    }
    if (!(0, exports.isOperationalEvidenceGrantFor)(grant, executor)) {
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
    if (grant.contractVersion !== live_session_sql_1.LIVE_SCHEMA_CONTRACT_VERSION) {
        return {
            ok: false,
            reason: `the operational verification covers contract "${grant.contractVersion}", `
                + `this source speaks "${live_session_sql_1.LIVE_SCHEMA_CONTRACT_VERSION}"`,
        };
    }
    if (!grant.scope.includes(exports.LIVE_OPERATIONAL_SCOPE)) {
        return { ok: false, reason: `the operational verification does not cover "${exports.LIVE_OPERATIONAL_SCOPE}"` };
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
const createInternalUserIdParticipantResolver = (store) => async (input) => {
    const participants = await store.listParticipants(input.sessionId, input.tenantId);
    const row = participants.find((participant) => participant.userId === input.providerParticipantId) ?? null;
    return row === null ? null : { participantId: row.id, userId: row.userId };
};
exports.createInternalUserIdParticipantResolver = createInternalUserIdParticipantResolver;
/**
 * Build the live runtime. Throws before constructing anything when a mandatory
 * dependency is missing — there is no partial runtime and no fallback.
 */
const createLiveRuntime = (deps) => {
    if (!deps || !deps.executor) {
        throw new LiveRuntimeError('invalid_deps', 'createLiveRuntime requires a connection-bound executor for sessions, presence and ingest');
    }
    if (typeof deps.sealedAudit !== 'function') {
        throw new LiveRuntimeError('invalid_deps', 'createLiveRuntime requires a sealed audit writer; there is no no-op and no plain INSERT fallback');
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
    const operationalEvidence = deps.operationalEvidence ?? null;
    /**
     * F1: a schema report is accepted ONLY when this module's verifier produced
     * it for THIS executor object, and only under the contract version this
     * source speaks. A look-alike literal, or a report measured against another
     * connection, is a dependency error — not a warning and not a downgrade.
     */
    const schemaFreshnessMs = resolveFreshnessMs(deps.schemaFreshnessMs);
    const assertUsableReport = (report) => {
        if (!(0, live_session_sql_1.isLiveSchemaReportFor)(report, executor)) {
            throw new LiveRuntimeError('invalid_deps', 'the schema report was not produced by verifyLiveSchema for THIS executor object; '
                + 'a structurally similar object is not evidence about this connection');
        }
        if (report.contractVersion !== live_session_sql_1.LIVE_SCHEMA_CONTRACT_VERSION) {
            throw new LiveRuntimeError('invalid_deps', `the schema report speaks contract "${String(report.contractVersion)}", `
                + `this source speaks "${live_session_sql_1.LIVE_SCHEMA_CONTRACT_VERSION}"`);
        }
    };
    let schemaReport = null;
    if (deps.schemaReport !== undefined && deps.schemaReport !== null) {
        assertUsableReport(deps.schemaReport);
        schemaReport = deps.schemaReport;
    }
    /** Areas a runtime error proved unusable AFTER the report was measured. */
    const invalidated = new Map();
    const sessionStore = (0, live_session_sql_1.createLiveSessionSqlStore)({
        executor,
        sealedAudit,
        // Default 'unconfigured': ordered presence callbacks are never enabled
        // without the R22 attestation.
        presenceCursor: deps.presenceCursor,
    });
    const ingestStore = (0, live_recording_ingest_sql_1.createRecordingIngestSqlStore)({ executor, sealedAudit });
    // `null` is a deliberate "do not wire the library"; `undefined` reuses the
    // executor, whose shape already satisfies the library runner port.
    const library = deps.libraryRunner === null
        ? null
        : (0, video_asset_lifecycle_1.createRecordingLibraryPort)(deps.libraryRunner ?? executor, idFactory);
    const core = (0, live_session_core_1.createLiveSessionCore)({
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
    const meterCandidate = deps.meterStorage;
    const meterPortUsable = typeof meterCandidate === 'object'
        && meterCandidate !== null
        && typeof meterCandidate.recordVerifiedBytes === 'function';
    const ingest = (0, live_recording_ingest_1.createRecordingIngestService)({
        store: ingestStore,
        library: library ?? undefined,
        // The ingest promotes the library first and meters the PROMOTED id, so
        // this port is now safe to wire. Absent stays absent: `undefined`, never
        // a no-op meter that would fake a measurement. A malformed object is
        // treated exactly like an absent one — composing it could only produce a
        // permanent deferred row.
        meterStorage: meterPortUsable ? meterCandidate : undefined,
        verifyCallbackSignature: deps.verifyRecordingCallbackSignature ?? DENY_ALL_SIGNATURES,
        now,
        idFactory,
        graceSeconds: deps.recordingGraceSeconds,
    });
    const router = deps.optionalAuthenticate
        ? (0, live_sessions_1.createLiveSessionsRouter)({ core, optionalAuthenticate: deps.optionalAuthenticate })
        : null;
    /**
     * F3: the durable checkpoint is built only when the composition declares it
     * AND supplies the worker token its lease is fenced on. Declaring without an
     * owner throws: a checkpoint nobody can own is not a degraded checkpoint,
     * it is a wiring mistake — and silently falling back to `after` would hide
     * exactly the starvation the checkpoint exists to remove.
     */
    let recoveryCheckpoint = null;
    const checkpointOwner = typeof deps.recoveryCheckpointOwner === 'string'
        ? deps.recoveryCheckpointOwner.trim()
        : '';
    if (deps.recoveryCheckpoint === 'declared') {
        if (checkpointOwner.length === 0) {
            throw new LiveRuntimeError('invalid_deps', 'recoveryCheckpoint: "declared" requires recoveryCheckpointOwner; the checkpoint lease is fenced on it');
        }
        recoveryCheckpoint = (0, live_recording_ingest_sql_1.createRecordingCheckpointSqlStore)({ executor });
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
    const ticketSigningConfigured = (0, live_session_core_1.isValidTicketSecret)(deps.ticketSecret);
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
    const recordingConfigured = libraryConfigured && meteringConfigured && recoveryCheckpointConfigured
        ? 'configured'
        : 'unconfigured';
    const reasons = {};
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
        ].filter((name) => name !== null);
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
        ].filter((name) => name !== null);
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
    const readClock = (explicit) => {
        if (typeof explicit === 'number' && Number.isFinite(explicit))
            return explicit;
        return typeof now === 'function' ? now() : Date.now();
    };
    /**
     * F1: configuration + schema + freshness + invalidation, evaluated NOW.
     * Deliberately recomputed on every call — a verdict frozen at construction
     * would keep saying "verified" long after the report stopped being evidence.
     */
    const evaluateReadiness = (evaluatedAtMs) => {
        const reasonsOut = {};
        const schema = {
            sessionLifecycle: 'unverified',
            presenceOrdering: 'unverified',
            presenceEventIdentity: 'unverified',
            ingestLedger: 'unverified',
            recoveryCheckpoint: 'unverified',
        };
        for (const area of live_session_sql_1.LIVE_SCHEMA_AREAS) {
            const result = schemaReport === null ? undefined : schemaReport.areas[area];
            if (result !== undefined)
                schema[area] = result.status;
        }
        const invalidationSnapshot = {};
        for (const [area, record] of invalidated) {
            invalidationSnapshot[area] = record;
            schema[area] = 'invalidated';
        }
        const ageMs = schemaReport === null
            ? null
            : evaluatedAtMs - schemaReport.checkedAtMs;
        const fresh = ageMs !== null && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= schemaFreshnessMs;
        const requiredAreas = [
            'sessionLifecycle',
            'presenceOrdering',
            'presenceEventIdentity',
        ];
        const unverifiedAreas = requiredAreas.filter((area) => schema[area] !== 'verified');
        const schemaReady = schemaReport !== null && fresh && unverifiedAreas.length === 0;
        if (schemaReport === null) {
            reasonsOut.schema = 'no schema report applied: call verifyLiveSchema(executor) explicitly and pass its '
                + 'result; wired dependencies are not a measurement';
        }
        else if (ageMs !== null && ageMs < 0) {
            reasonsOut.schema = 'the schema report is dated after the evaluation clock; future evidence cannot prove readiness';
        }
        else if (!fresh) {
            reasonsOut.schema = `the schema report is ${String(ageMs)} ms old, beyond the ${schemaFreshnessMs} ms `
                + 'freshness window';
        }
        else if (unverifiedAreas.length > 0) {
            reasonsOut.schema = `schema areas not verified: ${unverifiedAreas.map((area) => `${area}=${schema[area]}`).join(', ')}`;
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
        ].filter((name) => name !== null);
        const configReady = missingConfig.length === 0;
        const fullyReady = schemaReady && configReady ? 'configured' : 'unconfigured';
        if (!configReady) {
            reasonsOut.fullyReady = `configuration incomplete: ${missingConfig.join(', ')}`;
        }
        else if (!schemaReady) {
            reasonsOut.fullyReady = reasonsOut.schema ?? 'schema is not verified';
        }
        const operationalCheck = describeOperationalState(operationalEvidence, executor, compositionContext, evaluatedAtMs);
        const operational = operationalCheck.ok && fullyReady === 'configured'
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
    const status = {
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
    const recoveryDeps = {
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
        readiness: (atMs) => evaluateReadiness(readClock(atMs)),
        applySchemaReport: (report) => {
            assertUsableReport(report);
            schemaReport = report;
            // A newer measurement supersedes the errors it re-checked. It does
            // NOT supersede an error observed after it, which is why the
            // invalidation is cleared here and re-set only by a later failure.
            invalidated.clear();
        },
        noteSchemaUnavailable: (area, reason) => {
            if (!live_session_sql_1.LIVE_SCHEMA_AREAS.includes(area)) {
                throw new LiveRuntimeError('invalid_deps', `"${String(area)}" is not a live schema area`);
            }
            invalidated.set(area, {
                atMs: readClock(),
                reason: typeof reason === 'string' && reason.length > 0 ? reason : 'schema_unavailable',
            });
        },
        beginShutdown: () => {
            shuttingDown = true;
        },
        // Explicit call only. No timer, no `process.on`, no start-on-construct.
        // With a checkpoint the durable row decides where the pass starts; the
        // pass itself rejects an `after` that disagrees with it. After
        // `beginShutdown()` the call is refused before it touches a cursor.
        runRecoveryOnce: (options) => {
            const requested = options ?? {};
            return shuttingDown
                ? (0, live_recording_recovery_1.runRecordingRecoveryOnce)(recoveryDeps, { ...requested, shutdown: true })
                : (0, live_recording_recovery_1.runRecordingRecoveryOnce)(recoveryDeps, requested);
        },
    };
};
exports.createLiveRuntime = createLiveRuntime;
