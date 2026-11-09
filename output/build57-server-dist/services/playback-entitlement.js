"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlaybackDeliveryUnavailableError = exports.PLAYBACK_TOKEN_MAX_TTL_SECONDS = exports.PLAYBACK_TOKEN_DEFAULT_TTL_SECONDS = void 0;
exports.parsePlaybackClaims = parsePlaybackClaims;
exports.signPlaybackToken = signPlaybackToken;
exports.verifyPlaybackToken = verifyPlaybackToken;
exports.verifyPlaybackEntitlement = verifyPlaybackEntitlement;
exports.evaluatePlaybackEntitlement = evaluatePlaybackEntitlement;
exports.normalizePlaybackTtl = normalizePlaybackTtl;
exports.createPlaybackEntitlementService = createPlaybackEntitlementService;
exports.createSqlPlaybackEntitlementStore = createSqlPlaybackEntitlementStore;
/**
 * V3 — per-tenant playback entitlement.
 *
 * A short-lived, HMAC-signed playback token is bound to exactly four
 * server-derived facts at issuance:
 *
 *     lessonId + studentEnrollmentId + tenantId + sessionId
 *
 * and to a bounded expiry. Playback is denied unless a token (a) carries a
 * valid signature, (b) is not expired, (c) is not on the revocation list, and
 * (d) matches EVERY bound expectation supplied by the caller. A cross-tenant
 * token therefore denies even when the signature is valid, and revoking a
 * single token (`jti`) denies it immediately.
 *
 * Like the M1 video-access policy, the pure decision and the SQL store live
 * behind injected boundaries, so the exact production rule can be exercised
 * hermetically. The signing secret is supplied as a getter, so the module can
 * be imported before configuration without throwing; a missing/blank secret
 * fails closed (issue refuses, verify denies).
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
const crypto_1 = __importDefault(require("crypto"));
const audit_1 = require("../security/audit");
exports.PLAYBACK_TOKEN_DEFAULT_TTL_SECONDS = 60;
exports.PLAYBACK_TOKEN_MAX_TTL_SECONDS = 300;
/* =========================================================================
 * Token codec (pure)
 * ========================================================================= */
const TOKEN_VERSION = 'v1';
const MAX_TOKEN_LENGTH = 4096;
function toBase64Url(input) {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(input) {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}
function signatureFor(secret, version, payload) {
    return crypto_1.default.createHmac('sha256', secret).update(`${version}.${payload}`).digest();
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
/**
 * Strict millisecond timestamps.
 *
 * `Number(record['issuedAtMs'])` accepted `''`, `null`, `[]`, `true` and `' '`,
 * and `'12.7'`/`'0x10'`/`'1e3'` as valid times — a claim whose expiry the server
 * never actually set. A non-safe-integer or non-digit-string reading is refused
 * so the token cannot be evaluated against a fabricated clock.
 */
function parseEpochMs(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? value : null;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}
/** Structural validation of a decoded payload; no field is trusted by type. */
function parsePlaybackClaims(value) {
    if (!value || typeof value !== 'object')
        return null;
    const record = value;
    const { jti, tenantId, lessonId, studentEnrollmentId, sessionId } = record;
    if (!isNonEmptyString(jti) || !isNonEmptyString(tenantId) || !isNonEmptyString(lessonId)
        || !isNonEmptyString(studentEnrollmentId) || !isNonEmptyString(sessionId)) {
        return null;
    }
    const issuedAtMs = parseEpochMs(record['issuedAtMs']);
    const expiresAtMs = parseEpochMs(record['expiresAtMs']);
    if (issuedAtMs === null || expiresAtMs === null)
        return null;
    // A token whose expiry precedes its issuance is malformed, not merely odd:
    // it would otherwise be denied as `expired` and indistinguishable from a
    // genuinely elapsed token.
    if (expiresAtMs < issuedAtMs)
        return null;
    return { jti, tenantId, lessonId, studentEnrollmentId, sessionId, issuedAtMs, expiresAtMs };
}
function signPlaybackToken(secret, claims) {
    const payload = toBase64Url(Buffer.from(JSON.stringify(claims), 'utf8'));
    const signature = toBase64Url(signatureFor(secret, TOKEN_VERSION, payload));
    return `${TOKEN_VERSION}.${payload}.${signature}`;
}
function verifyPlaybackToken(secret, token) {
    if (!isNonEmptyString(secret) || typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
        return { ok: false, reason: 'malformed' };
    }
    const expected = signatureFor(secret, TOKEN_VERSION, parts[1]);
    let supplied;
    try {
        supplied = fromBase64Url(parts[2]);
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!constantTimeEqual(expected, supplied))
        return { ok: false, reason: 'invalid-signature' };
    let decoded;
    try {
        decoded = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    const claims = parsePlaybackClaims(decoded);
    return claims ? { ok: true, claims } : { ok: false, reason: 'unknown-claims' };
}
/**
 * Verification helper for streaming routes.
 *
 * Delivery handlers (manifest/segment/key, or any other media surface) MUST
 * call this — never `verifyPlaybackToken` directly — so the server-derived
 * session facts are normalized and a malformed/absent binding fails closed
 * instead of being skipped. The expectation is built exclusively from the
 * supplied server state; the token can never widen it.
 */
async function verifyPlaybackEntitlement(service, request) {
    const asString = (value) => (typeof value === 'string' ? value : '');
    return service.verify(request.token, {
        tenantId: asString(request.tenantId),
        lessonId: asString(request.lessonId),
        studentEnrollmentId: asString(request.studentEnrollmentId),
        sessionId: asString(request.sessionId),
    });
}
/**
 * Pure entitlement decision: revocation, expiry and every binding are checked
 * deny-by-default. An absent expected binding denies (a caller that fails to
 * supply the lesson/tenant/student/session never gets a pass).
 */
function evaluatePlaybackEntitlement(claims, expectation, nowMs, revoked) {
    if (revoked)
        return { allowed: false, reason: 'revoked' };
    if (!Number.isFinite(claims.expiresAtMs) || claims.expiresAtMs <= nowMs)
        return { allowed: false, reason: 'expired' };
    if (!isNonEmptyString(expectation.tenantId) || claims.tenantId !== expectation.tenantId) {
        return { allowed: false, reason: 'tenant-mismatch' };
    }
    if (!isNonEmptyString(expectation.lessonId) || claims.lessonId !== expectation.lessonId) {
        return { allowed: false, reason: 'lesson-mismatch' };
    }
    if (!isNonEmptyString(expectation.studentEnrollmentId) || claims.studentEnrollmentId !== expectation.studentEnrollmentId) {
        return { allowed: false, reason: 'student-mismatch' };
    }
    if (!isNonEmptyString(expectation.sessionId) || claims.sessionId !== expectation.sessionId) {
        return { allowed: false, reason: 'session-mismatch' };
    }
    return { allowed: true, claims };
}
/** Clamp a requested TTL into the short-lived window [1, MAX]. */
function normalizePlaybackTtl(ttlSeconds) {
    // Digits only. `parseInt('12abc')` returned 12 and `parseInt(' 30 ')`
    // returned 30, so a caller could smuggle a value past the numeric shape;
    // anything that is not a clean positive integer falls back to the default
    // rather than being partially parsed.
    let parsed;
    if (typeof ttlSeconds === 'number') {
        parsed = Number.isSafeInteger(ttlSeconds) ? ttlSeconds : NaN;
    }
    else if (typeof ttlSeconds === 'string' && /^\d+$/.test(ttlSeconds.trim())) {
        parsed = Number(ttlSeconds.trim());
    }
    else {
        parsed = NaN;
    }
    if (!Number.isFinite(parsed) || parsed <= 0)
        return exports.PLAYBACK_TOKEN_DEFAULT_TTL_SECONDS;
    return Math.min(exports.PLAYBACK_TOKEN_MAX_TTL_SECONDS, parsed);
}
/**
 * Raised when the delivery lookup is unavailable.
 *
 * An empty list is indistinguishable from "no records were ever issued for this
 * session", and a delivery helper that treats it as such would deny a
 * legitimate viewer while reporting a data answer rather than a capability
 * fault. The lookup is either implemented or it refuses.
 */
class PlaybackDeliveryUnavailableError extends Error {
    constructor() {
        super('The playback entitlement store cannot resolve records by session');
    }
}
exports.PlaybackDeliveryUnavailableError = PlaybackDeliveryUnavailableError;
function normalizeId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9_-]+$/.test(trimmed))
        return null;
    return trimmed;
}
function createPlaybackEntitlementService(deps) {
    const now = deps.now ?? (() => Date.now());
    const idFactory = deps.idFactory ?? (() => crypto_1.default.randomUUID());
    const store = deps.store;
    return {
        issue: async (expectation, ttlSeconds) => {
            const tenantId = normalizeId(expectation?.tenantId);
            const lessonId = normalizeId(expectation?.lessonId);
            const studentEnrollmentId = normalizeId(expectation?.studentEnrollmentId);
            const sessionId = normalizeId(expectation?.sessionId);
            if (!tenantId || !lessonId || !studentEnrollmentId || !sessionId) {
                return { ok: false, reason: 'invalid-input' };
            }
            const secret = deps.getSecret()?.trim();
            if (!secret)
                return { ok: false, reason: 'secret-unavailable' };
            const ttl = normalizePlaybackTtl(ttlSeconds);
            const issuedAtMs = now();
            const claims = {
                jti: idFactory(),
                tenantId,
                lessonId,
                studentEnrollmentId,
                sessionId,
                issuedAtMs,
                expiresAtMs: issuedAtMs + ttl * 1000,
            };
            await store.save({ ...claims, revokedAtMs: null, revokeReason: null });
            return { ok: true, token: signPlaybackToken(secret, claims), claims, expiresIn: ttl };
        },
        verify: async (token, expectation) => {
            const secret = deps.getSecret()?.trim();
            // A missing secret is a configuration fault, not a forged token.
            // Reporting it as `invalid-signature` made an unconfigured
            // deployment indistinguishable from an attack in the audit trail.
            if (!secret)
                return { allowed: false, reason: 'secret-unavailable' };
            const parsed = verifyPlaybackToken(secret, token);
            if (!parsed.ok) {
                return { allowed: false, reason: parsed.reason === 'malformed' ? 'malformed' : 'invalid-signature' };
            }
            const revoked = await store.isRevoked(parsed.claims.jti);
            return evaluatePlaybackEntitlement(parsed.claims, expectation, now(), revoked);
        },
        load: async (jti) => {
            const safe = normalizeId(jti);
            return safe ? store.load(safe) : null;
        },
        findBySessionId: async (sessionId) => {
            // Refuse rather than return an empty list: an empty list reads as
            // "this session has no records", which a delivery helper would
            // answer with a denial that looks like data instead of a missing
            // capability. The previous comment promised `store-unavailable`
            // while the code returned `[]`.
            if (!store.findBySessionId)
                throw new PlaybackDeliveryUnavailableError();
            const safe = normalizeId(sessionId);
            if (!safe)
                return [];
            return store.findBySessionId(safe);
        },
        revoke: async (jti, reason, actorUserId) => {
            const safe = normalizeId(jti);
            if (!safe)
                return { revoked: false, tenantId: null };
            const record = await store.load(safe);
            if (!record)
                return { revoked: false, tenantId: null };
            const safeReason = (typeof reason === 'string' && reason.trim() ? reason.trim() : 'revoked').slice(0, 200);
            await store.revoke({ jti: safe, reason: safeReason, revokedAtMs: now() });
            await store.recordAudit({
                actorUserId,
                tenantId: record.tenantId,
                action: 'video.playback.revoked',
                resourceType: 'playback_entitlement',
                resourceId: safe,
                reason: safeReason,
            });
            return { revoked: true, tenantId: record.tenantId };
        },
    };
}
function toEpochMs(value) {
    if (value === null)
        return null;
    const date = value instanceof Date ? value : new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
}
function toMysqlUtc(ms) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
function mapPlaybackRow(row) {
    const issuedAtMs = toEpochMs(row.issued_at);
    const expiresAtMs = toEpochMs(row.expires_at);
    if (issuedAtMs === null || expiresAtMs === null)
        return null;
    return {
        jti: row.jti,
        tenantId: row.tenant_id,
        lessonId: row.lesson_id,
        studentEnrollmentId: row.student_enrollment_id,
        sessionId: row.session_id,
        issuedAtMs,
        expiresAtMs,
        revokedAtMs: toEpochMs(row.revoked_at),
        revokeReason: row.revoke_reason ?? null,
    };
}
const PLAYBACK_ROW_COLUMNS = `jti, tenant_id, lesson_id, student_enrollment_id, session_id,
                        issued_at, expires_at, revoked_at, revoke_reason`;
function createSqlPlaybackEntitlementStore(db) {
    return {
        save: async (record) => {
            await db.execute(`INSERT INTO playback_entitlements
                   (jti, tenant_id, lesson_id, student_enrollment_id, session_id, issued_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE jti = jti`, [
                record.jti,
                record.tenantId,
                record.lessonId,
                record.studentEnrollmentId,
                record.sessionId,
                toMysqlUtc(record.issuedAtMs),
                toMysqlUtc(record.expiresAtMs),
            ]);
        },
        load: async (jti) => {
            const row = await db.queryOne(`SELECT ${PLAYBACK_ROW_COLUMNS}
                 FROM playback_entitlements WHERE jti = ? LIMIT 1`, [jti]);
            return row ? mapPlaybackRow(row) : null;
        },
        // Delivery lookup for the existing sid/token media URLs. The table
        // has no session_id index yet (a separate schema task owns
        // migrations); the bounded read keeps the scan small, and a missing
        // record denies rather than skipping the check.
        findBySessionId: async (sessionId) => {
            const rows = await db.query(`SELECT ${PLAYBACK_ROW_COLUMNS}
                 FROM playback_entitlements WHERE session_id = ?
                 ORDER BY issued_at DESC LIMIT 100`, [sessionId]);
            return rows.map(mapPlaybackRow).filter((row) => row !== null);
        },
        isRevoked: async (jti) => {
            const row = await db.queryOne('SELECT revoked_at FROM playback_entitlements WHERE jti = ? LIMIT 1', [jti]);
            return row ? row.revoked_at !== null && row.revoked_at !== undefined : false;
        },
        revoke: async ({ jti, reason, revokedAtMs }) => {
            await db.execute(`UPDATE playback_entitlements
                 SET revoked_at = ?, revoke_reason = ?
                 WHERE jti = ? AND revoked_at IS NULL`, [toMysqlUtc(revokedAtMs), reason, jti]);
        },
        // Durable session-wide revocation. One statement so a revoke cannot
        // leave half a session's records usable, and idempotent so a retried
        // revoke changes nothing on the second pass.
        revokeBySessionId: async ({ sessionId, reason, revokedAtMs }) => {
            const result = await db.execute(`UPDATE playback_entitlements
                 SET revoked_at = ?, revoke_reason = ?
                 WHERE session_id = ? AND revoked_at IS NULL`, [toMysqlUtc(revokedAtMs), reason, sessionId]);
            const affectedRows = result.affectedRows;
            if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                throw new Error('playback-entitlement update did not report a usable affected-row count');
            }
            return affectedRows;
        },
        recordAudit: async (input) => {
            await (0, audit_1.recordAudit)(db.execute, input);
        },
    };
}
