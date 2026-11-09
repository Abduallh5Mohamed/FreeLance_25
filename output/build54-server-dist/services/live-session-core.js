"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIVE_CALLBACK_KINDS = exports.LIVE_TICKET_SECRET_MIN_BYTES = exports.LIVE_TITLE_MAX_LENGTH = exports.MAX_PARTICIPANTS_CEILING = exports.DEFAULT_MAX_PARTICIPANTS = exports.MAX_CALLBACK_GRACE_SECONDS = exports.DEFAULT_CALLBACK_GRACE_SECONDS = exports.MAX_JOIN_TICKET_TTL_SECONDS = exports.DEFAULT_JOIN_TICKET_TTL_SECONDS = exports.PRESENCE_CLOSE_REASONS = exports.LIVE_PARTICIPANT_ROLES = exports.LIVE_SESSION_STATES = void 0;
exports.normalizeLiveSessionState = normalizeLiveSessionState;
exports.normalizeParticipantRole = normalizeParticipantRole;
exports.normalizePresenceCloseReason = normalizePresenceCloseReason;
exports.evaluateSessionTransition = evaluateSessionTransition;
exports.normalizeLiveId = normalizeLiveId;
exports.normalizeProviderKey = normalizeProviderKey;
exports.normalizeBoundedInt = normalizeBoundedInt;
exports.normalizeMaxParticipants = normalizeMaxParticipants;
exports.normalizeTicketTtl = normalizeTicketTtl;
exports.normalizeGraceSeconds = normalizeGraceSeconds;
exports.isValidTicketSecret = isValidTicketSecret;
exports.signJoinTicket = signJoinTicket;
exports.verifyJoinTicket = verifyJoinTicket;
exports.ticketFingerprint = ticketFingerprint;
exports.normalizeCallbackKind = normalizeCallbackKind;
exports.mergeIntervals = mergeIntervals;
exports.deriveAttendance = deriveAttendance;
exports.createLiveSessionCore = createLiveSessionCore;
exports.createInMemoryLiveSessionStore = createInMemoryLiveSessionStore;
/**
 * W10-R1 — provider-neutral live session core.
 *
 * The platform has no live-session model of its own: `online_meetings` only
 * stores a pasted join URL, so host/join/leave, presence and automatic
 * attendance had no server-side authority at all. This module supplies that
 * authority WITHOUT choosing a provider:
 *
 *  - a PURE state machine (`evaluateSessionTransition`) over
 *    `scheduled -> live -> ended` (plus `cancelled`), so an ended session never
 *    silently re-opens;
 *  - a signed join ticket (HMAC-SHA256 over a versioned payload) that binds the
 *    ticket to ONE tenant + session + participant + role + expiry. A ticket is
 *    therefore useless in another tenant and cannot be replayed after expiry;
 *  - a service (`createLiveSessionCore`) that decides join/leave from
 *    SERVER rows only — the caller's tenant is compared with the session row,
 *    never trusted from the request body;
 *  - signed provider callbacks with a durable dedupe ledger, tenant
 *    attribution from the session row, and an explicit grace window for
 *    callbacks that arrive after the session ended;
 *  - a pure attendance derivation (`deriveAttendance`) that merges overlapping
 *    presence intervals instead of summing them, so a rejoin cannot
 *    double-count a second;
 *  - ONE mandatory store unit per mutation. Every write (session insert, state
 *    change, admission, presence, callback marker, audit) runs inside
 *    `store.withTransaction`, so a state write and its audit either both commit
 *    or both roll back, and the callback marker is finalised in the same unit
 *    that applies the transition. A store that cannot provide a unit is
 *    refused with `transaction-required`; there is no autocommit fallback.
 *
 * Deliberate limits (documented, not hidden):
 *  - no provider SDK, no network, no media path, no DRM: this module never
 *    claims that a call actually happened, only that an authorised principal
 *    joined/left or that a VERIFIED callback said so;
 *  - no recording: `live-recording-ingest.ts` owns that boundary;
 *  - the participant row holds ONE presence interval, so a rejoin after a leave
 *    overwrites the earlier interval. That is a data-model limitation stated in
 *    the live contract, not something this module hides. An adapter that also
 *    writes `live_session_presence_intervals` (the OPTIONAL unit methods below)
 *    removes it for attendance; one that does not keeps the limitation;
 *  - capacity admission is delegated to the adapter, which must serialise on
 *    the session row. The service never counts participants from a pre-read;
 *  - presence ordering needs a per-participant EVENT cursor
 *    (`readPresenceCursor`/`advancePresenceCursor`). A store without it cannot
 *    claim ordered callbacks: participant callbacks are ignored with
 *    `ordering-unavailable` instead of being applied blind. The durable session
 *    adapter now implements the cursor, but only when the composition attests
 *    the R22 migration is applied; until then the ports are absent on that store
 *    and ordering stays fail-closed there too;
 *  - a provider participant identity is never matched to `userId` by string
 *    equality. It is resolved through the injected
 *    `resolveProviderParticipant`; without it participant callbacks fail
 *    closed with `mapping-unavailable`, while `session.started`/`ended` keep
 *    working because they never needed a participant;
 *  - no schema is invented: the module exposes a store port plus a reference
 *    in-memory adapter. The durable adapters are separate files
 *    (`live-session-sql.ts`, `live-presence-sql.ts`) and are injected; this
 *    module still imports no database and opens no connection.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
const crypto_1 = require("crypto");
/* =========================================================================
 * Taxonomy
 * ========================================================================= */
exports.LIVE_SESSION_STATES = ['scheduled', 'live', 'ended', 'cancelled'];
function normalizeLiveSessionState(value) {
    if (typeof value !== 'string')
        return null;
    return exports.LIVE_SESSION_STATES.includes(value)
        ? value
        : null;
}
exports.LIVE_PARTICIPANT_ROLES = ['host', 'cohost', 'participant'];
function normalizeParticipantRole(value) {
    if (typeof value !== 'string')
        return null;
    return exports.LIVE_PARTICIPANT_ROLES.includes(value)
        ? value
        : null;
}
/** Matches the `close_reason` ENUM on `live_session_presence_intervals`. */
exports.PRESENCE_CLOSE_REASONS = ['leave', 'callback', 'session-ended'];
function normalizePresenceCloseReason(value) {
    if (typeof value !== 'string')
        return null;
    return exports.PRESENCE_CLOSE_REASONS.includes(value)
        ? value
        : null;
}
/** Forward transitions only. `ended` and `cancelled` are terminal. */
const LEGAL_SESSION_TRANSITIONS = {
    scheduled: ['live', 'cancelled'],
    live: ['ended'],
    ended: [],
    cancelled: [],
};
function evaluateSessionTransition(from, to) {
    const fromState = normalizeLiveSessionState(from);
    const toState = normalizeLiveSessionState(to);
    if (fromState === null || toState === null)
        return { allowed: false, reason: 'unknown-state' };
    if (fromState === toState)
        return { allowed: true, idempotent: true };
    return LEGAL_SESSION_TRANSITIONS[fromState].includes(toState)
        ? { allowed: true, idempotent: false }
        : { allowed: false, reason: 'illegal-transition' };
}
/* =========================================================================
 * Bounds
 * ========================================================================= */
exports.DEFAULT_JOIN_TICKET_TTL_SECONDS = 900;
exports.MAX_JOIN_TICKET_TTL_SECONDS = 12 * 60 * 60;
exports.DEFAULT_CALLBACK_GRACE_SECONDS = 300;
exports.MAX_CALLBACK_GRACE_SECONDS = 24 * 60 * 60;
exports.DEFAULT_MAX_PARTICIPANTS = 200;
exports.MAX_PARTICIPANTS_CEILING = 5000;
exports.LIVE_TITLE_MAX_LENGTH = 200;
exports.LIVE_TICKET_SECRET_MIN_BYTES = 32;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
function normalizeLiveId(value) {
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
function normalizeBoundedInt(value, fallback, min, max) {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
function normalizeMaxParticipants(value) {
    return normalizeBoundedInt(value, exports.DEFAULT_MAX_PARTICIPANTS, 1, exports.MAX_PARTICIPANTS_CEILING);
}
function normalizeTicketTtl(value) {
    return normalizeBoundedInt(value, exports.DEFAULT_JOIN_TICKET_TTL_SECONDS, 30, exports.MAX_JOIN_TICKET_TTL_SECONDS);
}
function normalizeGraceSeconds(value) {
    return normalizeBoundedInt(value, exports.DEFAULT_CALLBACK_GRACE_SECONDS, 0, exports.MAX_CALLBACK_GRACE_SECONDS);
}
const b64url = (input) => Buffer.from(input).toString('base64url');
const hmac = (secret, payload) => (0, crypto_1.createHmac)('sha256', secret).update(payload, 'utf8').digest('base64url');
const safeEqual = (a, b) => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && (0, crypto_1.timingSafeEqual)(left, right);
};
/** A secret that is too short is refused rather than silently used. */
function isValidTicketSecret(secret) {
    return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= exports.LIVE_TICKET_SECRET_MIN_BYTES;
}
function signJoinTicket(secret, claims) {
    if (!isValidTicketSecret(secret))
        throw new Error('live ticket secret is not configured');
    const payload = b64url(JSON.stringify(claims));
    return `v1.${payload}.${hmac(secret, payload)}`;
}
function parseClaims(value) {
    if (!value || typeof value !== 'object')
        return null;
    const raw = value;
    if (raw.v !== 1)
        return null;
    const tenantId = normalizeLiveId(raw.tenantId);
    const sessionId = normalizeLiveId(raw.sessionId);
    const userId = normalizeLiveId(raw.userId);
    const role = normalizeParticipantRole(raw.role);
    const issuedAtMs = typeof raw.issuedAtMs === 'number' ? Math.trunc(raw.issuedAtMs) : Number.NaN;
    const expiresAtMs = typeof raw.expiresAtMs === 'number' ? Math.trunc(raw.expiresAtMs) : Number.NaN;
    const nonce = typeof raw.nonce === 'string' && raw.nonce.length > 0 && raw.nonce.length <= 64 ? raw.nonce : null;
    if (!tenantId || !sessionId || !userId || !role || !nonce)
        return null;
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs)
        return null;
    return { v: 1, tenantId, sessionId, userId, role, issuedAtMs, expiresAtMs, nonce };
}
/**
 * Verify a ticket. The signature is checked BEFORE any claim is trusted, and
 * the optional `scope` is compared afterwards so a valid ticket for another
 * tenant/session is refused as `wrong-scope` instead of being honoured.
 */
function verifyJoinTicket(secret, token, nowMs, scope) {
    if (!isValidTicketSecret(secret))
        return { ok: false, reason: 'bad-signature' };
    if (typeof token !== 'string')
        return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1')
        return { ok: false, reason: 'malformed' };
    const [, payload, signature] = parts;
    if (!payload || !signature)
        return { ok: false, reason: 'malformed' };
    if (!safeEqual(signature, hmac(secret, payload)))
        return { ok: false, reason: 'bad-signature' };
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    const claims = parseClaims(decoded);
    if (!claims)
        return { ok: false, reason: 'malformed' };
    if (nowMs < claims.issuedAtMs)
        return { ok: false, reason: 'not-yet-valid' };
    if (nowMs >= claims.expiresAtMs)
        return { ok: false, reason: 'expired' };
    if (scope?.tenantId !== undefined && scope.tenantId !== claims.tenantId)
        return { ok: false, reason: 'wrong-scope' };
    if (scope?.sessionId !== undefined && scope.sessionId !== claims.sessionId)
        return { ok: false, reason: 'wrong-scope' };
    if (scope?.userId !== undefined && scope.userId !== claims.userId)
        return { ok: false, reason: 'wrong-scope' };
    return { ok: true, claims };
}
/** Stable digest of a ticket, for the participant row (never the ticket itself). */
function ticketFingerprint(token) {
    return (0, crypto_1.createHash)('sha256').update(token, 'utf8').digest('hex');
}
exports.LIVE_CALLBACK_KINDS = [
    'session.started',
    'session.ended',
    'participant.joined',
    'participant.left',
];
function normalizeCallbackKind(value) {
    if (typeof value !== 'string')
        return null;
    return exports.LIVE_CALLBACK_KINDS.includes(value)
        ? value
        : null;
}
/** Merge overlapping/adjacent intervals; input order is irrelevant. */
function mergeIntervals(intervals) {
    const valid = intervals
        .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs))
        .map((interval) => ({ startMs: Math.trunc(interval.startMs), endMs: Math.trunc(interval.endMs) }))
        .filter((interval) => interval.endMs > interval.startMs)
        .sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
    const merged = [];
    for (const interval of valid) {
        const last = merged[merged.length - 1];
        if (last && interval.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, interval.endMs);
            continue;
        }
        merged.push({ ...interval });
    }
    return merged;
}
const secondsOf = (intervals) => intervals.reduce((sum, interval) => sum + Math.round((interval.endMs - interval.startMs) / 1000), 0);
/**
 * Derive attendance from presence rows. Everything is clamped to the session
 * window, so a participant whose clock drifted before the session started (or
 * after it ended) cannot inflate the figure. A participant with no leave event
 * is counted up to `windowEndMs` only when `countOpenPresence` is true —
 * otherwise an abandoned row would look like permanent attendance.
 *
 * `presenceIntervals` is the FULL history when the adapter can supply it
 * (`listPresenceIntervals`). When it is present, a participant with interval
 * rows is derived from those rows — every rejoin counts, and overlapping
 * periods are still merged, never summed. A participant with no interval rows
 * falls back to the single participant row, so legacy sessions stay readable.
 * When the field is absent the function behaves exactly as before: one
 * interval per participant, and a rejoin has overwritten the earlier one.
 */
function deriveAttendance(input) {
    const start = Math.trunc(input.windowStartMs);
    const end = Math.max(start, Math.trunc(input.windowEndMs));
    const participants = [];
    let anomalies = 0;
    const spansByUser = new Map();
    for (const span of input.presenceIntervals ?? []) {
        if (typeof span.userId !== 'string' || !Number.isFinite(span.startMs))
            continue;
        const existing = spansByUser.get(span.userId);
        if (existing)
            existing.push(span);
        else
            spansByUser.set(span.userId, [span]);
    }
    for (const participant of input.participants) {
        const spans = spansByUser.get(participant.userId);
        if (spans && spans.length > 0) {
            let spanAnomaly = false;
            const raw = [];
            for (const span of spans) {
                const spanStart = Math.trunc(span.startMs);
                const spanEnd = span.endMs === null ? null : Math.trunc(span.endMs);
                if (spanEnd !== null && spanEnd < spanStart)
                    spanAnomaly = true;
                const rawEnd = spanEnd === null
                    ? (input.countOpenPresence ? end : spanStart)
                    : spanEnd;
                // Same clamp as the single-row path; mergeIntervals drops a
                // non-positive span, so an anomaly contributes zero seconds.
                raw.push({
                    startMs: Math.max(start, spanStart),
                    endMs: Math.min(end, rawEnd),
                });
            }
            if (spanAnomaly)
                anomalies += 1;
            const intervals = mergeIntervals(raw);
            participants.push({
                userId: participant.userId,
                role: participant.role,
                intervals,
                coveredSeconds: secondsOf(intervals),
                anomaly: spanAnomaly,
            });
            continue;
        }
        const joined = Math.trunc(participant.joinedAtMs);
        const left = participant.leftAtMs === null ? null : Math.trunc(participant.leftAtMs);
        const anomaly = left !== null && left < joined;
        if (anomaly)
            anomalies += 1;
        const rawEnd = left === null
            ? (input.countOpenPresence ? end : joined)
            : left;
        const intervals = mergeIntervals([{
                startMs: Math.max(start, joined),
                endMs: Math.min(end, rawEnd),
            }]);
        participants.push({
            userId: participant.userId,
            role: participant.role,
            intervals,
            coveredSeconds: secondsOf(intervals),
            anomaly,
        });
    }
    participants.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return {
        sessionId: input.sessionId,
        windowStartMs: start,
        windowEndMs: end,
        participants,
        totalCoveredSeconds: participants.reduce((sum, entry) => sum + entry.coveredSeconds, 0),
        anomalies,
    };
}
function createLiveSessionCore(deps) {
    const store = deps.store;
    const now = deps.now ?? (() => Date.now());
    const idFactory = deps.idFactory ?? crypto_1.randomUUID;
    const ticketTtlSeconds = normalizeTicketTtl(deps.ticketTtlSeconds);
    const graceMs = normalizeGraceSeconds(deps.callbackGraceSeconds) * 1000;
    const configuredMax = normalizeMaxParticipants(deps.maxParticipants);
    /**
     * Every mutation goes through here. The unit is mandatory: a store without
     * `withTransaction` is refused with `transaction-required` and nothing is
     * written. A throw inside `work` propagates after the adapter rolled back,
     * so the caller never sees success for a half-applied unit.
     */
    const runUnit = async (work) => {
        if (typeof store.withTransaction !== 'function') {
            return { committed: false, reason: 'transaction-required' };
        }
        const value = await store.withTransaction(work);
        return { committed: true, value };
    };
    /** A decision taken before any ledger marker exists: one audit, own unit. */
    const decide = async (input, result) => {
        const outcome = await runUnit(async (unit) => {
            await unit.recordAudit(input);
            return result;
        });
        return outcome.committed ? outcome.value : { status: 'rejected', reason: 'transaction-required' };
    };
    /**
     * Close every open presence interval of a session in the CALLER'S unit.
     * Only the two optional presence methods are used, so an adapter without
     * them behaves exactly as before. No audit is written here: the transition
     * that ended the session already audited `live.session.ended`, and a close
     * must not produce a second event for the same fact.
     */
    const closeSessionPresence = async (unit, tenantId, sessionId, leftAtMs) => {
        if (typeof unit.listPresenceIntervals !== 'function' || typeof unit.closePresenceInterval !== 'function') {
            return;
        }
        const intervals = await unit.listPresenceIntervals(sessionId, tenantId);
        const userIds = [...new Set(intervals.filter((interval) => interval.leftAtMs === null).map((interval) => interval.userId))];
        for (const userId of userIds) {
            await unit.closePresenceInterval({
                tenantId,
                sessionId,
                userId,
                leftAtMs,
                reason: 'session-ended',
            });
        }
    };
    /**
     * Finalise a claimed callback marker as an explicit ignore and audit it in
     * the SAME unit. Never used for a success: an ignored event changes no
     * participant state, opens/closes no interval and writes no `applied`
     * audit.
     */
    const ignoreCallback = async (unit, session, markerId, input) => {
        await unit.finalizeCallback(markerId, input.markerOutcome, session.tenantId);
        await unit.recordAudit({
            actorUserId: null,
            tenantId: session.tenantId,
            action: 'live.callback.ignored',
            resourceType: 'live_session',
            resourceId: session.id,
            reason: input.auditReason,
            newValue: input.evidence,
        });
        return { status: 'ignored', reason: input.reason };
    };
    const transition = async (tenantId, sessionId, actorUserId, next) => {
        const safeTenant = normalizeLiveId(tenantId);
        const safeSession = normalizeLiveId(sessionId);
        const safeActor = normalizeLiveId(actorUserId);
        if (!safeTenant || !safeSession || !safeActor)
            return { ok: false, reason: 'not-found' };
        const outcome = await runUnit(async (unit) => {
            const session = await unit.findSession(safeSession, safeTenant);
            if (!session)
                return { ok: false, reason: 'not-found' };
            // Only the recorded host may drive the session lifecycle; the caller
            // identity is the server-derived principal, never a body value.
            if (session.hostUserId !== safeActor)
                return { ok: false, reason: 'forbidden', from: session.state };
            const decision = evaluateSessionTransition(session.state, next);
            if (!decision.allowed)
                return { ok: false, reason: 'illegal-transition', from: session.state };
            if (decision.idempotent)
                return { ok: true, state: session.state };
            const at = now();
            const updated = await unit.updateSessionState(session.id, session.tenantId, session.state, next, next === 'ended' ? at : null);
            if (updated === 0)
                return { ok: false, reason: 'conflict', from: session.state };
            // Same unit as the state write: presence closes with the session,
            // and a failure here rolls the state back with it.
            if (next === 'ended') {
                await closeSessionPresence(unit, session.tenantId, session.id, at);
            }
            await unit.recordAudit({
                actorUserId: safeActor,
                tenantId: session.tenantId,
                action: `live.session.${next}`,
                resourceType: 'live_session',
                resourceId: session.id,
                oldValue: { state: session.state },
                newValue: { state: next },
            });
            return { ok: true, state: next };
        });
        return outcome.committed ? outcome.value : { ok: false, reason: 'transaction-required' };
    };
    return {
        createSession: async (input) => {
            const tenantId = normalizeLiveId(input.tenantId);
            const hostUserId = normalizeLiveId(input.hostUserId);
            const title = typeof input.title === 'string' ? input.title.trim().slice(0, exports.LIVE_TITLE_MAX_LENGTH) : '';
            if (!tenantId || !hostUserId || !title)
                return { ok: false, reason: 'invalid-input' };
            if (!isValidTicketSecret(deps.ticketSecret))
                return { ok: false, reason: 'signing-unconfigured' };
            const provider = input.provider === undefined || input.provider === null ? null : normalizeProviderKey(input.provider);
            const providerRoomId = input.providerRoomId === undefined || input.providerRoomId === null
                ? null
                : normalizeProviderKey(input.providerRoomId);
            if (input.provider !== undefined && input.provider !== null && !provider)
                return { ok: false, reason: 'invalid-input' };
            if (input.providerRoomId !== undefined && input.providerRoomId !== null && !providerRoomId) {
                return { ok: false, reason: 'invalid-input' };
            }
            const at = now();
            const startsAtMs = typeof input.startsAtMs === 'number' && Number.isFinite(input.startsAtMs)
                ? Math.trunc(input.startsAtMs)
                : at;
            const id = idFactory();
            const outcome = await runUnit(async (unit) => {
                await unit.insertSession({
                    id,
                    tenantId,
                    hostUserId,
                    title,
                    provider,
                    providerRoomId,
                    startsAtMs,
                    maxParticipants: input.maxParticipants === undefined
                        ? configuredMax
                        : normalizeMaxParticipants(input.maxParticipants),
                    createdAtMs: at,
                });
                await unit.recordAudit({
                    actorUserId: hostUserId,
                    tenantId,
                    action: 'live.session.created',
                    resourceType: 'live_session',
                    resourceId: id,
                    newValue: { state: 'scheduled', provider, starts_at_ms: startsAtMs },
                });
                return { ok: true, id, state: 'scheduled' };
            });
            return outcome.committed ? outcome.value : { ok: false, reason: 'transaction-required' };
        },
        startSession: (tenantId, sessionId, actorUserId) => transition(tenantId, sessionId, actorUserId, 'live'),
        endSession: (tenantId, sessionId, actorUserId) => transition(tenantId, sessionId, actorUserId, 'ended'),
        cancelSession: (tenantId, sessionId, actorUserId) => transition(tenantId, sessionId, actorUserId, 'cancelled'),
        getSession: async (tenantId, sessionId) => {
            const safeTenant = normalizeLiveId(tenantId);
            const safeSession = normalizeLiveId(sessionId);
            if (!safeTenant || !safeSession)
                return null;
            return store.findSession(safeSession, safeTenant);
        },
        join: async (input) => {
            const tenantId = normalizeLiveId(input.tenantId);
            const sessionId = normalizeLiveId(input.sessionId);
            const userId = normalizeLiveId(input.userId);
            if (!tenantId || !sessionId || !userId)
                return { ok: false, reason: 'invalid-input' };
            // The whole decision runs inside one unit so the capacity count and
            // the participant write cannot be separated by a concurrent join.
            const outcome = await runUnit(async (unit) => {
                const session = await unit.findSession(sessionId, tenantId);
                if (!session) {
                    // A session of another tenant is reported exactly like a
                    // missing one: the caller learns nothing about other tenants.
                    return { ok: false, reason: 'session-not-found' };
                }
                if (session.tenantId !== tenantId)
                    return { ok: false, reason: 'tenant-mismatch' };
                if (session.state === 'ended' || session.state === 'cancelled') {
                    return { ok: false, reason: 'session-ended' };
                }
                const requestedRole = input.role === undefined ? 'participant' : normalizeParticipantRole(input.role);
                if (!requestedRole)
                    return { ok: false, reason: 'role-not-allowed' };
                // Only the recorded host can hold the host role; a body value can
                // never promote a participant.
                const role = session.hostUserId === userId ? 'host' : requestedRole;
                if (session.state !== 'live')
                    return { ok: false, reason: 'session-not-live' };
                if (!isValidTicketSecret(deps.ticketSecret))
                    return { ok: false, reason: 'signing-unconfigured' };
                const at = now();
                let claims = null;
                if (input.ticket !== undefined && input.ticket !== null) {
                    const verified = verifyJoinTicket(deps.ticketSecret, input.ticket, at, {
                        tenantId,
                        sessionId,
                        userId,
                    });
                    if (!verified.ok)
                        return { ok: false, reason: 'ticket-invalid', detail: verified.reason };
                    if (verified.claims.role !== role)
                        return { ok: false, reason: 'ticket-invalid', detail: 'role-mismatch' };
                    claims = verified.claims;
                }
                const ticket = claims
                    ? String(input.ticket)
                    : signJoinTicket(deps.ticketSecret, {
                        v: 1,
                        tenantId,
                        sessionId,
                        userId,
                        role,
                        issuedAtMs: at,
                        expiresAtMs: at + ticketTtlSeconds * 1000,
                        nonce: idFactory(),
                    });
                const expiresAtMs = claims ? claims.expiresAtMs : at + ticketTtlSeconds * 1000;
                // Admission is the adapter's decision: it holds the session row
                // lock, counts DISTINCT active participants and refreshes an
                // existing row instead of inserting a second one.
                const admission = await unit.admitParticipant({
                    tenantId: session.tenantId,
                    sessionId: session.id,
                    userId,
                    role,
                    ticketFingerprint: ticketFingerprint(ticket),
                    id: idFactory(),
                    atMs: at,
                });
                if (!admission.admitted) {
                    return admission.reason === 'session-full'
                        ? { ok: false, reason: 'session-full' }
                        : { ok: false, reason: 'session-not-found' };
                }
                // Same unit as the admission: the interval either exists with
                // the participant row or the join rolls back. A repeat join
                // while still present is "already open" and appends nothing;
                // a rejoin appends a new interval (never overwrites).
                if (typeof unit.openPresenceInterval === 'function') {
                    await unit.openPresenceInterval({
                        id: idFactory(),
                        tenantId: session.tenantId,
                        sessionId: session.id,
                        participantId: admission.participantId,
                        userId,
                        joinedAtMs: at,
                    });
                }
                await unit.recordAudit({
                    actorUserId: userId,
                    tenantId: session.tenantId,
                    action: admission.created ? 'live.participant.joined' : 'live.participant.rejoined',
                    resourceType: 'live_session_participant',
                    resourceId: session.id,
                    newValue: { role, active: admission.activeCount },
                });
                return {
                    ok: true,
                    participantId: admission.participantId,
                    role,
                    ticket,
                    expiresAtMs,
                };
            });
            return outcome.committed ? outcome.value : { ok: false, reason: 'transaction-required' };
        },
        leave: async (input) => {
            const tenantId = normalizeLiveId(input.tenantId);
            const sessionId = normalizeLiveId(input.sessionId);
            const userId = normalizeLiveId(input.userId);
            if (!tenantId || !sessionId || !userId)
                return { ok: false, left: false };
            const outcome = await runUnit(async (unit) => {
                const session = await unit.findSession(sessionId, tenantId);
                if (!session || session.tenantId !== tenantId)
                    return { ok: false, left: false };
                const at = now();
                const affected = await unit.markParticipantLeft(session.id, userId, at, session.tenantId);
                if (affected > 0) {
                    // Same unit as the leave. Closing an interval that is
                    // already closed is a no-op, and the leave audit below is
                    // the ONLY audit for this close.
                    if (typeof unit.closePresenceInterval === 'function') {
                        await unit.closePresenceInterval({
                            tenantId: session.tenantId,
                            sessionId: session.id,
                            userId,
                            leftAtMs: at,
                            reason: 'leave',
                        });
                    }
                    await unit.recordAudit({
                        actorUserId: userId,
                        tenantId: session.tenantId,
                        action: 'live.participant.left',
                        resourceType: 'live_session_participant',
                        resourceId: session.id,
                        newValue: { left_at_ms: at },
                    });
                }
                // Leaving twice is a no-op, not an error: the caller's intent is met.
                return { ok: true, left: affected > 0 };
            });
            return outcome.committed ? outcome.value : { ok: false, left: false, reason: 'transaction-required' };
        },
        applyProviderCallback: async (callback) => {
            const provider = normalizeProviderKey(callback.provider);
            const eventId = normalizeProviderKey(callback.eventId);
            const providerRoomId = normalizeProviderKey(callback.providerRoomId);
            const kind = normalizeCallbackKind(callback.kind);
            // The claim is a COMPARISON input only. It is never used as an audit
            // partition before a trusted session row resolves the tenant, and
            // the bounded copy below is evidence, not a routing key.
            const tenantClaim = typeof callback.tenantId === 'string' && callback.tenantId.trim()
                ? callback.tenantId.trim()
                : null;
            const claimEvidence = tenantClaim === null ? null : tenantClaim.slice(0, 128);
            // 1. Signature first; nothing from an unverified payload is trusted.
            let verified = false;
            try {
                verified = Boolean(await deps.verifyCallbackSignature(callback));
            }
            catch {
                verified = false;
            }
            if (!verified) {
                // No trusted tenant yet ⇒ a GLOBAL security event. Stamping the
                // caller's claim here would let an attacker choose the tenant
                // whose audit partition receives the event.
                return decide({
                    actorUserId: null,
                    tenantId: null,
                    action: 'live.callback.ignored',
                    resourceType: 'live_session',
                    resourceId: providerRoomId ?? 'unknown',
                    reason: 'unverified_signature',
                    newValue: { tenant_claim: claimEvidence },
                }, { status: 'ignored', reason: 'unverified-signature' });
            }
            if (!provider || !eventId || !providerRoomId || !kind) {
                return decide({
                    actorUserId: null,
                    tenantId: null,
                    action: 'live.callback.ignored',
                    resourceType: 'live_session',
                    resourceId: providerRoomId ?? 'unknown',
                    reason: 'malformed_callback',
                    newValue: { tenant_claim: claimEvidence },
                }, { status: 'ignored', reason: 'malformed' });
            }
            const session = await store.findSessionByProvider(provider, providerRoomId);
            if (!session) {
                return decide({
                    actorUserId: null,
                    tenantId: null,
                    action: 'live.callback.ignored',
                    resourceType: 'live_session',
                    resourceId: providerRoomId,
                    reason: 'unknown_session',
                    newValue: { tenant_claim: claimEvidence },
                }, { status: 'ignored', reason: 'unknown-session' });
            }
            // 2. Tenant from the session row; a disagreeing signed claim is
            //    rejected and never applied. This branch audits under the
            //    trusted row tenant only.
            if (tenantClaim !== null && tenantClaim !== session.tenantId) {
                return decide({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.callback.rejected',
                    resourceType: 'live_session',
                    resourceId: session.id,
                    reason: 'cross_tenant',
                    newValue: { tenant_claim: claimEvidence },
                }, { status: 'rejected', reason: 'cross-tenant' });
            }
            const occurredAtMs = typeof callback.occurredAtMs === 'number' && Number.isFinite(callback.occurredAtMs)
                ? Math.trunc(callback.occurredAtMs)
                : now();
            const at = now();
            // Grace: a callback that arrives after the session ended is still
            // applied inside the window, and ignored (not silently dropped)
            // outside it.
            const endedAtMs = session.endedAtMs;
            if (endedAtMs !== null && occurredAtMs > endedAtMs + graceMs) {
                return decide({
                    actorUserId: null,
                    tenantId: session.tenantId,
                    action: 'live.callback.ignored',
                    resourceType: 'live_session',
                    resourceId: session.id,
                    reason: 'outside_grace',
                    newValue: { kind, occurred_at_ms: occurredAtMs, ended_at_ms: endedAtMs },
                }, { status: 'ignored', reason: 'outside-grace' });
            }
            // 3. Claim, apply and finalise are ONE unit. The marker is claimed
            //    as `pending` and can only leave that state inside the same unit
            //    that performs the write; a throw rolls the claim back, so a
            //    replay still finds the work to do.
            const outcome = await runUnit(async (unit) => {
                const current = await unit.findSession(session.id, session.tenantId);
                if (!current)
                    return { status: 'ignored', reason: 'unknown-session' };
                if (kind === 'session.started' || kind === 'session.ended') {
                    const next = kind === 'session.started' ? 'live' : 'ended';
                    const decision = evaluateSessionTransition(current.state, next);
                    const markerId = idFactory();
                    const claimed = await unit.insertCallback({
                        id: markerId,
                        tenantId: current.tenantId,
                        sessionId: current.id,
                        provider,
                        eventId,
                        kind,
                        occurredAtMs,
                        outcome: 'pending',
                    });
                    if (!claimed)
                        return { status: 'duplicate' };
                    if (!decision.allowed) {
                        await unit.finalizeCallback(markerId, 'rejected:illegal-transition', current.tenantId);
                        await unit.recordAudit({
                            actorUserId: null,
                            tenantId: current.tenantId,
                            action: 'live.callback.rejected',
                            resourceType: 'live_session',
                            resourceId: current.id,
                            reason: 'illegal_transition',
                            oldValue: { state: current.state },
                            newValue: { state: next },
                        });
                        return { status: 'rejected', reason: 'illegal-transition' };
                    }
                    if (!decision.idempotent) {
                        const updated = await unit.updateSessionState(current.id, current.tenantId, current.state, next, next === 'ended' ? occurredAtMs : null);
                        if (updated === 0) {
                            // The state moved under the CAS: this callback was
                            // NOT applied, so the marker records the decision
                            // instead of a false `applied`.
                            await unit.finalizeCallback(markerId, 'rejected:illegal-transition', current.tenantId);
                            await unit.recordAudit({
                                actorUserId: null,
                                tenantId: current.tenantId,
                                action: 'live.callback.rejected',
                                resourceType: 'live_session',
                                resourceId: current.id,
                                reason: 'illegal_transition',
                                oldValue: { state: current.state },
                                newValue: { state: next },
                            });
                            return { status: 'rejected', reason: 'illegal-transition' };
                        }
                    }
                    // Only a transition that actually happened closes presence;
                    // an idempotent replay leaves already-closed intervals alone.
                    if (!decision.idempotent && next === 'ended') {
                        await closeSessionPresence(unit, current.tenantId, current.id, occurredAtMs);
                    }
                    await unit.finalizeCallback(markerId, 'applied', current.tenantId);
                    await unit.recordAudit({
                        actorUserId: null,
                        tenantId: current.tenantId,
                        action: 'live.callback.applied',
                        resourceType: 'live_session',
                        resourceId: current.id,
                        newValue: { kind, state: next, event_id: eventId },
                    });
                    return { status: 'applied', kind, state: next };
                }
                // Participant presence from a provider callback. The provider's
                // participant identity is NOT an app user id: it is resolved
                // through the injected, server-established mapping only. There
                // is no equality fallback and no "assume it is the user id".
                const providerParticipantId = callback.providerParticipantId === undefined
                    || callback.providerParticipantId === null
                    ? null
                    : normalizeProviderKey(callback.providerParticipantId);
                const markerId = idFactory();
                const claimed = await unit.insertCallback({
                    id: markerId,
                    tenantId: current.tenantId,
                    sessionId: current.id,
                    provider,
                    eventId,
                    kind,
                    occurredAtMs,
                    outcome: 'pending',
                });
                if (!claimed)
                    return { status: 'duplicate' };
                if (!providerParticipantId) {
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:malformed',
                        reason: 'malformed',
                        auditReason: 'malformed_callback',
                    });
                }
                const resolve = deps.resolveProviderParticipant;
                if (typeof resolve !== 'function') {
                    // Fail closed: no trusted mapping means no write. The
                    // provider identity is kept as bounded evidence, never used
                    // as a participant/user id.
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:mapping-unavailable',
                        reason: 'mapping-unavailable',
                        auditReason: 'mapping_unavailable',
                        evidence: { kind, provider_participant_id: providerParticipantId },
                    });
                }
                const resolved = await resolve({
                    tenantId: current.tenantId,
                    sessionId: current.id,
                    provider,
                    providerParticipantId,
                });
                // Validate the resolver's answer against THIS session and
                // tenant: re-read the participants and require a row whose id
                // AND user id match. A resolver that names a participant of
                // another session or tenant must not authorise a write; it is
                // `unknown-participant`, not a success.
                const participants = await unit.listParticipants(current.id, current.tenantId);
                let participant = null;
                if (resolved !== null) {
                    participant = participants.find((row) => row.id === resolved.participantId
                        && row.userId === resolved.userId) ?? null;
                }
                if (!participant) {
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:unknown-participant',
                        reason: 'unknown-participant',
                        auditReason: 'unknown_participant',
                        evidence: {
                            kind,
                            provider_participant_id: providerParticipantId,
                            resolved_participant_id: resolved?.participantId ?? null,
                        },
                    });
                }
                // Ordering is per participant and runs BEFORE any state change.
                // `lastSeenAtMs` is NOT the authority: it is an activity mark,
                // not an event identity. A store without the cursor cannot
                // claim ordered callbacks, so it is refused, not guessed.
                const readCursor = unit.readPresenceCursor;
                const advanceCursor = unit.advancePresenceCursor;
                if (typeof readCursor !== 'function' || typeof advanceCursor !== 'function') {
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:ordering-unavailable',
                        reason: 'ordering-unavailable',
                        auditReason: 'ordering_unavailable',
                        evidence: { kind, provider_participant_id: providerParticipantId },
                    });
                }
                const cursor = await readCursor(current.tenantId, current.id, participant.id);
                if (cursor !== null && occurredAtMs < cursor.eventAtMs) {
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:stale-event',
                        reason: 'stale-event',
                        auditReason: 'stale_event',
                        evidence: {
                            kind,
                            occurred_at_ms: occurredAtMs,
                            cursor_event_at_ms: cursor.eventAtMs,
                            cursor_event_id: cursor.eventId,
                        },
                    });
                }
                if (cursor !== null && occurredAtMs === cursor.eventAtMs) {
                    // Equal instant: do NOT fabricate a +1ms increment and do
                    // not compare event ids as if they were time. Conservative
                    // refusal keeps state and intervals untouched.
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:ambiguous-event',
                        reason: 'ambiguous-event',
                        auditReason: 'ambiguous_event',
                        evidence: {
                            kind,
                            occurred_at_ms: occurredAtMs,
                            cursor_event_id: cursor.eventId,
                        },
                    });
                }
                const advanced = await advanceCursor({
                    tenantId: current.tenantId,
                    sessionId: current.id,
                    participantId: participant.id,
                    expected: cursor,
                    next: { eventAtMs: occurredAtMs, eventId },
                });
                if (advanced !== 1) {
                    // Another writer advanced the cursor between our read and
                    // the CAS. This event did not win: treat it as stale and
                    // leave state, intervals and the success audit untouched.
                    return ignoreCallback(unit, current, markerId, {
                        markerOutcome: 'ignored:stale-event',
                        reason: 'stale-event',
                        auditReason: 'stale_event',
                        evidence: { kind, occurred_at_ms: occurredAtMs, cursor_cas_rows: advanced },
                    });
                }
                if (kind === 'participant.left') {
                    const left = await unit.markParticipantLeft(current.id, participant.userId, occurredAtMs, current.tenantId);
                    // Same unit as the marker: an interval closes only when the
                    // participant row actually moved to "left". A repeated left
                    // callback closes nothing, so no second close is recorded.
                    if (left > 0 && typeof unit.closePresenceInterval === 'function') {
                        await unit.closePresenceInterval({
                            tenantId: current.tenantId,
                            sessionId: current.id,
                            userId: participant.userId,
                            leftAtMs: occurredAtMs,
                            reason: 'callback',
                        });
                    }
                }
                else {
                    // A verified join for a participant that had left is a
                    // REJOIN: the row is refreshed and a new interval opens.
                    // While still present it is the same period, so nothing is
                    // appended.
                    const wasLeft = participant.leftAtMs !== null;
                    await unit.upsertParticipant({
                        ...participant,
                        // A rejoin starts at the ACCEPTED event instant, not the
                        // pre-read value: the row and the interval opened below
                        // must agree. An active row keeps its original join.
                        joinedAtMs: wasLeft ? occurredAtMs : participant.joinedAtMs,
                        lastSeenAtMs: Math.max(participant.lastSeenAtMs, occurredAtMs),
                        leftAtMs: null,
                    });
                    if (wasLeft && typeof unit.openPresenceInterval === 'function') {
                        await unit.openPresenceInterval({
                            id: idFactory(),
                            tenantId: current.tenantId,
                            sessionId: current.id,
                            participantId: participant.id,
                            userId: participant.userId,
                            joinedAtMs: occurredAtMs,
                        });
                    }
                }
                await unit.finalizeCallback(markerId, 'applied', current.tenantId);
                await unit.recordAudit({
                    actorUserId: null,
                    tenantId: current.tenantId,
                    action: 'live.callback.applied',
                    resourceType: 'live_session_participant',
                    resourceId: current.id,
                    newValue: { kind, user_id: participant.userId, occurred_at_ms: occurredAtMs, applied_at_ms: at },
                });
                return { status: 'applied', kind, state: current.state };
            });
            return outcome.committed ? outcome.value : { status: 'rejected', reason: 'transaction-required' };
        },
        attendance: async (tenantId, sessionId, opts) => {
            const safeTenant = normalizeLiveId(tenantId);
            const safeSession = normalizeLiveId(sessionId);
            if (!safeTenant || !safeSession)
                return null;
            const session = await store.findSession(safeSession, safeTenant);
            if (!session || session.tenantId !== safeTenant)
                return null;
            const participants = await store.listParticipants(session.id, session.tenantId);
            const at = opts?.nowMs !== undefined && Number.isFinite(opts.nowMs) ? Math.trunc(opts.nowMs) : now();
            // Read paths stay unit-free: two tenant-scoped reads. When the
            // adapter stores interval history, attendance runs over ALL of it;
            // otherwise the single participant row is the only source and the
            // documented rejoin limitation applies unchanged.
            const presenceIntervals = typeof store.listPresenceIntervals === 'function'
                ? (await store.listPresenceIntervals(session.id, session.tenantId)).map((interval) => ({
                    userId: interval.userId,
                    startMs: interval.joinedAtMs,
                    endMs: interval.leftAtMs,
                }))
                : undefined;
            return deriveAttendance({
                sessionId: session.id,
                participants,
                windowStartMs: session.startsAtMs,
                windowEndMs: session.endedAtMs ?? at,
                countOpenPresence: opts?.countOpenPresence === true,
                presenceIntervals,
            });
        },
    };
}
const callbackKey = (row) => `${row.tenantId}\u0000${row.provider}\u0000${row.eventId}`;
const presenceCursorKey = (tenantId, sessionId, participantId) => `${tenantId}\u0000${sessionId}\u0000${participantId}`;
const samePresenceCursor = (left, right) => left === null
    ? right === null
    : right !== null && left.eventAtMs === right.eventAtMs && left.eventId === right.eventId;
/**
 * The unit surface over one state. In production this is one connection inside
 * one transaction; here it is one staged copy of the rows.
 */
function createInMemoryUnit(state) {
    return {
        insertSession: async (row) => {
            state.sessions.push({
                id: row.id,
                tenantId: row.tenantId,
                hostUserId: row.hostUserId,
                title: row.title,
                state: 'scheduled',
                provider: row.provider,
                providerRoomId: row.providerRoomId,
                startsAtMs: row.startsAtMs,
                endedAtMs: null,
                maxParticipants: row.maxParticipants,
                createdAtMs: row.createdAtMs,
            });
        },
        findSession: async (id, tenantId) => {
            const row = state.sessions.find((session) => session.id === id && session.tenantId === tenantId);
            return row ? { ...row } : null;
        },
        findSessionByProvider: async (provider, providerRoomId) => {
            const row = state.sessions.find((session) => session.provider === provider && session.providerRoomId === providerRoomId);
            return row ? { ...row } : null;
        },
        updateSessionState: async (id, tenantId, expectedState, nextState, endedAtMs) => {
            const row = state.sessions.find((session) => session.id === id && session.tenantId === tenantId);
            if (!row || row.state !== expectedState)
                return 0;
            row.state = nextState;
            if (nextState === 'ended')
                row.endedAtMs = endedAtMs;
            return 1;
        },
        admitParticipant: async (input) => {
            // The count is taken HERE, inside the unit, and it counts DISTINCT
            // user ids — never rows and never joins. A caller cannot supply a
            // count, so admission cannot be decided from a pre-read snapshot.
            const session = state.sessions.find((row) => row.id === input.sessionId && row.tenantId === input.tenantId);
            if (!session) {
                return { admitted: false, reason: 'session-not-found', activeCount: 0, maxParticipants: 0 };
            }
            const active = new Set(state.participants
                .filter((row) => row.sessionId === session.id
                && row.tenantId === session.tenantId
                && row.leftAtMs === null)
                .map((row) => row.userId));
            const existing = state.participants.find((row) => row.sessionId === session.id && row.userId === input.userId) ?? null;
            if (existing) {
                const wasActive = existing.leftAtMs === null;
                // A rejoin of a row that already left needs a free slot; a row
                // that is still active is already counted and needs none.
                if (!wasActive && active.size >= session.maxParticipants) {
                    return {
                        admitted: false,
                        reason: 'session-full',
                        activeCount: active.size,
                        maxParticipants: session.maxParticipants,
                    };
                }
                existing.role = input.role;
                existing.ticketFingerprint = input.ticketFingerprint;
                existing.lastSeenAtMs = input.atMs;
                // An active row keeps its original join time (one interval); a
                // row that had left starts a new interval.
                existing.joinedAtMs = wasActive ? existing.joinedAtMs : input.atMs;
                existing.leftAtMs = null;
                return {
                    admitted: true,
                    created: false,
                    participantId: existing.id,
                    activeCount: wasActive ? active.size : active.size + 1,
                    maxParticipants: session.maxParticipants,
                };
            }
            if (active.size >= session.maxParticipants) {
                return {
                    admitted: false,
                    reason: 'session-full',
                    activeCount: active.size,
                    maxParticipants: session.maxParticipants,
                };
            }
            state.participants.push({
                id: input.id,
                tenantId: input.tenantId,
                sessionId: input.sessionId,
                userId: input.userId,
                role: input.role,
                ticketFingerprint: input.ticketFingerprint,
                joinedAtMs: input.atMs,
                lastSeenAtMs: input.atMs,
                leftAtMs: null,
            });
            return {
                admitted: true,
                created: true,
                participantId: input.id,
                activeCount: active.size + 1,
                maxParticipants: session.maxParticipants,
            };
        },
        upsertParticipant: async (row) => {
            const existing = state.participants.find((participant) => participant.sessionId === row.sessionId && participant.userId === row.userId);
            if (existing) {
                existing.role = row.role;
                existing.ticketFingerprint = row.ticketFingerprint;
                existing.lastSeenAtMs = row.lastSeenAtMs;
                // A rejoin starts a NEW presence interval; an active row keeps
                // its original join time so its interval is not restarted.
                existing.joinedAtMs = row.joinedAtMs;
                existing.leftAtMs = row.leftAtMs;
                return { created: false };
            }
            state.participants.push({ ...row });
            return { created: true };
        },
        markParticipantLeft: async (sessionId, userId, leftAtMs) => {
            const row = state.participants.find((participant) => participant.sessionId === sessionId && participant.userId === userId);
            if (!row || row.leftAtMs !== null)
                return 0;
            row.leftAtMs = leftAtMs;
            row.lastSeenAtMs = Math.max(row.lastSeenAtMs, leftAtMs);
            return 1;
        },
        listParticipants: async (sessionId, tenantId) => state.participants
            .filter((participant) => participant.sessionId === sessionId && participant.tenantId === tenantId)
            .map((participant) => ({ ...participant })),
        insertCallback: async (row) => {
            const key = callbackKey(row);
            if (state.callbacks.some((existing) => callbackKey(existing) === key))
                return false;
            state.callbacks.push({ ...row });
            return true;
        },
        finalizeCallback: async (id, outcome) => {
            const row = state.callbacks.find((callback) => callback.id === id);
            if (!row || row.outcome !== 'pending')
                return 0;
            row.outcome = outcome;
            return 1;
        },
        recordAudit: async (input) => {
            state.audits.push(input);
        },
        readPresenceCursor: async (tenantId, sessionId, participantId) => {
            const cursor = state.presenceCursors.get(presenceCursorKey(tenantId, sessionId, participantId));
            return cursor ? { ...cursor } : null;
        },
        advancePresenceCursor: async (input) => {
            const key = presenceCursorKey(input.tenantId, input.sessionId, input.participantId);
            const current = state.presenceCursors.get(key) ?? null;
            // Honest CAS: advance ONLY while the stored cursor is still the
            // value the caller read. A missing cursor and `expected: null`
            // match; anything else is a lost race and returns 0.
            if (!samePresenceCursor(current, input.expected))
                return 0;
            state.presenceCursors.set(key, {
                eventAtMs: input.next.eventAtMs,
                eventId: input.next.eventId,
            });
            return 1;
        },
    };
}
/**
 * A real adapter, not a decision mock: it stores rows, enforces the callback
 * dedupe key, tenant-scopes every read and applies the compare-and-set the
 * service expects.
 *
 * `withTransaction` is a SEAM MODEL, not MySQL proof: the unit runs against a
 * staged copy of the rows, commits by in-place replacement when the work
 * resolves, and discards the copy when it throws. Units are serialised by one
 * in-process queue, which is stronger than the per-session row lock the durable
 * adapter must take. No SQL, no isolation level, no deadlock, no crash.
 */
function createInMemoryLiveSessionStore() {
    const live = {
        sessions: [],
        participants: [],
        callbacks: [],
        audits: [],
        presenceCursors: new Map(),
    };
    const unit = createInMemoryUnit(live);
    let queue = Promise.resolve();
    const withTransaction = (work) => {
        const run = queue.then(async () => {
            const staged = {
                sessions: live.sessions.map((row) => ({ ...row })),
                participants: live.participants.map((row) => ({ ...row })),
                callbacks: live.callbacks.map((row) => ({ ...row })),
                audits: live.audits.slice(),
                presenceCursors: new Map(live.presenceCursors),
            };
            const value = await work(createInMemoryUnit(staged));
            // Commit in place so the arrays handed out below stay the same objects.
            live.sessions.length = 0;
            live.sessions.push(...staged.sessions);
            live.participants.length = 0;
            live.participants.push(...staged.participants);
            live.callbacks.length = 0;
            live.callbacks.push(...staged.callbacks);
            live.audits.length = 0;
            live.audits.push(...staged.audits);
            // Cursors are not exposed as a mutable array; replace the map so a
            // rolled-back unit leaves the committed cursors untouched.
            live.presenceCursors = staged.presenceCursors;
            return value;
        });
        // A rejected unit must not block the queue: the next unit starts clean.
        queue = run.then(() => undefined, () => undefined);
        return run;
    };
    return {
        sessions: live.sessions,
        participants: live.participants,
        callbacks: live.callbacks,
        audits: live.audits,
        ...unit,
        withTransaction,
    };
}
