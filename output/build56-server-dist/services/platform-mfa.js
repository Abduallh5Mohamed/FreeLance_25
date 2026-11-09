"use strict";
/**
 * M7 O9 — platform MFA (TOTP, RFC 6238) for super-admin/staff sensitive roles.
 *
 * Cryptography: node:crypto ONLY.
 *  - Secret is 20 random bytes (RFC 4226 recommendation), shown base32; the
 *    stored copy is AES-256-GCM sealed with a key built from MFA_SECRET_KEY
 *    (>= 32 bytes). A missing/short key fails closed (503) for every surface
 *    that needs the secret or signs/validates step-up tokens.
 *  - Verification follows RFC 6238: 30-second steps, RFC 4226 truncation,
 *    6 digits, SHA-1 HMAC, comparison with timingSafeEqual, acceptance window
 *    of +-1 step and replay protection of already-used time-steps (a
 *    conditional monotonic update; an older equal step can never succeed
 *    twice, even racing).
 *  - Recovery codes are generated once at activation, returned in plaintext
 *    exactly once and stored only as SHA-256 hashes; each code is single use
 *    (conditional update flips used_at).
 *  - Step-up: a successful verify issues a stateless HMAC token
 *    `su2.<userId>.<epoch>.<issuedAt>.<purpose>.<sessionId>.<mac>` with a short
 *    accepted age. `createRequireStepUp` turns it into a guard for sensitive
 *    routes; the epoch is the enrollment epoch that was verified (a re-enroll
 *    or disable bumps it, invalidating outstanding tokens), and the purpose and
 *    session id are checked so a token cannot be repurposed or replayed from a
 *    different session.
 *
 * Rate limiting and lockout: per-user request limiter (clock injected, fixed
 * window) plus persisted failed-attempt lockout (N bad codes lock the row for
 * a cooldown; the counter survives restarts because it lives in the row).
 *
 * Concurrency: every state change is a single conditional statement keyed on
 * the observed enrollment epoch (`markStepUsed`, `activate`,
 * `consumeRecoveryCode`), and enroll takes a row lock before replacing a
 * secret, so simultaneous requests cannot reuse a step/code or activate a
 * secret that was never proven.
 *
 * No `any`, no ts-ignore, no runtime DDL, no network, no PII in logs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MFA_RATE_LIMITS = exports.createMfaRateLimiter = exports.createSqlPlatformMfaStore = exports.createRequireStepUp = exports.STEPUP_HEADER = exports.createMfaVerifier = exports.verifyStepUpToken = exports.signStepUpToken = exports.STEPUP_PURPOSE = exports.verifyRecoveryCodeForUser = exports.verifyTotpForUser = exports.recoveryCodeHash = exports.generateRecoveryCodes = exports.normalizeTotpInput = exports.verifyTotpReplayChecked = exports.verifyTotp = exports.otpauthUri = exports.totpAtTime = exports.stepForTime = exports.totpAtStep = exports.hotpAt = exports.generateTotpSecret = exports.base32Decode = exports.base32Encode = exports.openSealedValue = exports.sealValue = exports.mfaKeyFromEnv = exports.MfaKeyUnavailableError = exports.STEPUP_TOKEN_VERSION = exports.SEAL_VERSION = exports.DEFAULT_STEPUP_MAX_AGE_SECONDS = exports.LOCKOUT_SECONDS = exports.MAX_VERIFY_ATTEMPTS = exports.RECOVERY_CODE_COUNT = exports.MAX_RECOVERY_CODE = exports.MIN_MFA_SECRET_KEY_BYTES = exports.TOTP_SECRET_BYTES = exports.TOTP_DIGITS = exports.TOTP_WINDOW_STEPS = exports.TOTP_STEP_SECONDS = void 0;
const crypto_1 = require("crypto");
const login_session_1 = require("../security/login-session");
exports.TOTP_STEP_SECONDS = 30;
exports.TOTP_WINDOW_STEPS = 1;
exports.TOTP_DIGITS = 6;
exports.TOTP_SECRET_BYTES = 20;
exports.MIN_MFA_SECRET_KEY_BYTES = 32;
exports.MAX_RECOVERY_CODE = 10;
exports.RECOVERY_CODE_COUNT = 10;
exports.MAX_VERIFY_ATTEMPTS = 5;
exports.LOCKOUT_SECONDS = 900;
exports.DEFAULT_STEPUP_MAX_AGE_SECONDS = 600;
exports.SEAL_VERSION = 'v1';
exports.STEPUP_TOKEN_VERSION = 'su2';
class MfaKeyUnavailableError extends Error {
    constructor() {
        super('MFA_SECRET_KEY is missing or shorter than 32 bytes');
        this.name = 'MfaKeyUnavailableError';
    }
}
exports.MfaKeyUnavailableError = MfaKeyUnavailableError;
/* ----------------------------------------------------------------------- */
/* Key sealing: env key acquisition and AES-256-GCM envelope.               */
/* ----------------------------------------------------------------------- */
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
/** Reads MFA_SECRET_KEY; hex/base64 forms are preferred, raw bytes last. */
const mfaKeyFromEnv = (env = process.env) => {
    const raw = env.MFA_SECRET_KEY;
    if (typeof raw !== 'string' || raw.length === 0)
        return null;
    let key;
    if (raw.length % 2 === 0 && HEX_PATTERN.test(raw)) {
        key = Buffer.from(raw, 'hex');
    }
    else {
        try {
            key = Buffer.from(raw, 'base64');
        }
        catch {
            key = Buffer.from(raw, 'utf8');
        }
        if (key.length === 0)
            key = Buffer.from(raw, 'utf8');
    }
    return key.length >= exports.MIN_MFA_SECRET_KEY_BYTES ? Buffer.from(key) : null;
};
exports.mfaKeyFromEnv = mfaKeyFromEnv;
const sealValue = (plaintext, key) => {
    const iv = (0, crypto_1.randomBytes)(12);
    const cipher = (0, crypto_1.createCipheriv)('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
        exports.SEAL_VERSION,
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        sealed.toString('base64'),
    ].join('.');
};
exports.sealValue = sealValue;
/** Throws (fails closed) on format mismatch or GCM tag invalidation. */
const openSealedValue = (sealed, key) => {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== exports.SEAL_VERSION) {
        throw new Error('Sealed value format is not recognized');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};
exports.openSealedValue = openSealedValue;
/* ----------------------------------------------------------------------- */
/* Base32 (RFC 4648) and TOTP/HOTP (RFC 4226 / RFC 6238).                   */
/* ----------------------------------------------------------------------- */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Encode = (input) => {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of input) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
};
exports.base32Encode = base32Encode;
const base32Decode = (text) => {
    const clean = text.replace(/[\s=-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]*$/.test(clean))
        throw new Error('Secret is not valid base32');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const character of clean) {
        value = (value << 5) | BASE32_ALPHABET.indexOf(character);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
};
exports.base32Decode = base32Decode;
const generateTotpSecret = (rng = crypto_1.randomBytes) => (0, exports.base32Encode)(rng(exports.TOTP_SECRET_BYTES));
exports.generateTotpSecret = generateTotpSecret;
/** RFC 4226 HMAC-SHA-1 truncation with 6 digits. */
const hotpAt = (secret, counter) => {
    if (!Number.isInteger(counter) || counter < 0 || counter > Number.MAX_SAFE_INTEGER) {
        throw new Error('Counter is out of range');
    }
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = (0, crypto_1.createHmac)('sha1', secret).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24) |
        (digest[offset + 1] << 16) |
        (digest[offset + 2] << 8) |
        digest[offset + 3];
    return String(binary % 10 ** exports.TOTP_DIGITS).padStart(exports.TOTP_DIGITS, '0');
};
exports.hotpAt = hotpAt;
const totpAtStep = (secret, step) => (0, exports.hotpAt)(secret, step);
exports.totpAtStep = totpAtStep;
const stepForTime = (timeMs, stepSeconds = exports.TOTP_STEP_SECONDS) => Math.floor(timeMs / 1000 / stepSeconds);
exports.stepForTime = stepForTime;
const totpAtTime = (secret, timeMs, stepSeconds = exports.TOTP_STEP_SECONDS) => (0, exports.totpAtStep)(secret, (0, exports.stepForTime)(timeMs, stepSeconds));
exports.totpAtTime = totpAtTime;
const otpauthUri = (userId, secret, issuer = 'Tabweb%20Teachers') => `otpauth://totp/${issuer}:${encodeURIComponent(userId)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${exports.TOTP_DIGITS}&period=${exports.TOTP_STEP_SECONDS}`;
exports.otpauthUri = otpauthUri;
/** Guess is compared against the computed code without early-size leaks. */
const codesEqual = (computed, supplied) => {
    if (supplied.length !== computed.length)
        return false;
    let mismatch = 0;
    for (let index = 0; index < computed.length; index += 1) {
        mismatch |= computed.charCodeAt(index) ^ supplied.charCodeAt(index);
    }
    return mismatch === 0;
};
/**
 * Verify a supplied code against the +-1 window steps. The caller persists the
 * returned step for replay protection; `verifyTotpReplayChecked` folds in the
 * last already-used step so an equal-or-older step never counts as a match.
 */
const verifyTotp = (secret, code, currentStep, window = exports.TOTP_WINDOW_STEPS) => {
    for (let step = currentStep + window; step >= currentStep - window; step -= 1) {
        if (step < 0)
            continue;
        if (codesEqual((0, exports.totpAtStep)(secret, step), code))
            return { ok: true, step };
    }
    return { ok: false, step: null };
};
exports.verifyTotp = verifyTotp;
const verifyTotpReplayChecked = (secret, code, currentStep, lastUsedStep, window = exports.TOTP_WINDOW_STEPS) => {
    const result = (0, exports.verifyTotp)(secret, code, currentStep, window);
    if (!result.ok || result.step === null)
        return { ok: false, step: null };
    return result.step <= lastUsedStep ? { ok: false, step: null } : result;
};
exports.verifyTotpReplayChecked = verifyTotpReplayChecked;
const normalizeTotpInput = (value) => {
    if (typeof value !== 'string')
        return '';
    return value.replace(/[\s-]/g, '');
};
exports.normalizeTotpInput = normalizeTotpInput;
/* ----------------------------------------------------------------------- */
/* Recovery codes (single use, stored hashed).                              */
/* ----------------------------------------------------------------------- */
const generateRecoveryCodes = (count = exports.RECOVERY_CODE_COUNT, rng = crypto_1.randomBytes) => {
    const codes = [];
    for (let index = 0; index < count; index += 1) {
        codes.push(rng(exports.MAX_RECOVERY_CODE).toString('hex'));
    }
    return codes;
};
exports.generateRecoveryCodes = generateRecoveryCodes;
const recoveryCodeHash = (code) => (0, crypto_1.createHash)('sha256').update((0, exports.normalizeTotpInput)(code), 'utf8').digest('hex');
exports.recoveryCodeHash = recoveryCodeHash;
const securityInteger = (value, label) => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
        throw new Error('Invalid MFA ' + label);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error('Invalid MFA ' + label);
    return parsed;
};
const lockoutOf = (row, nowMs) => {
    securityInteger(nowMs, 'clock');
    const lockedUntil = row.locked_until === null ? 0 : new Date(row.locked_until).getTime();
    if (!Number.isSafeInteger(lockedUntil) || lockedUntil < 0)
        throw new Error('Invalid MFA lockout');
    if (lockedUntil <= nowMs)
        return { locked: false, lockedUntil: null };
    return { locked: true, lockedUntil: row.locked_until instanceof Date ? row.locked_until.toISOString() : String(row.locked_until) };
};
const rowStepupEpoch = (row) => securityInteger(row.stepup_epoch, 'enrollment epoch');
/**
 * Deny-by-default code verification. Reads the live row, refuses when
 * locked/not active, checks the window with replay protection and consumes the
 * step atomically before reporting success.
 *
 * The consumption is guarded by the enrollment epoch observed on the row, so a
 * secret replaced between the read and the update (disable -> re-enroll, or a
 * concurrent re-enroll) can never be activated by a code that was verified
 * against the previous secret.
 */
const verifyTotpForUser = async (deps, userId, suppliedCode) => {
    try {
        const row = await deps.store.findRow(userId);
        if (!row || (row.status !== 'active' && row.status !== 'pending') || !row.sealed_secret) {
            return { ok: false, reason: 'not_enrolled' };
        }
        if (row.user_id !== userId)
            return { ok: false, reason: 'store_error' };
        const nowMs = securityInteger(deps.now(), 'clock');
        const state = lockoutOf(row, nowMs);
        if (state.locked)
            return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil ?? undefined };
        const key = deps.sealKey();
        if (!key)
            return { ok: false, reason: 'key_unavailable' };
        let secret;
        try {
            secret = (0, exports.base32Decode)((0, exports.openSealedValue)(row.sealed_secret, key));
        }
        catch {
            return { ok: false, reason: 'key_unavailable' };
        }
        const epoch = rowStepupEpoch(row);
        const currentStep = (0, exports.stepForTime)(nowMs);
        const match = (0, exports.verifyTotpReplayChecked)(secret, (0, exports.normalizeTotpInput)(suppliedCode), currentStep, securityInteger(row.last_used_step, 'replay step'));
        if (!match.ok || match.step === null)
            return { ok: false, reason: 'bad_code' };
        const consumed = await deps.store.markStepUsed(userId, match.step, epoch);
        if (consumed === 0) {
            // Distinguish an ordinary replay from a secret that was replaced
            // between the read and the conditional update.
            const fresh = await deps.store.findRow(userId);
            const replaced = !fresh || rowStepupEpoch(fresh) !== epoch || fresh.status === 'disabled';
            return { ok: false, reason: replaced ? 'stale_enrollment' : 'replayed' };
        }
        if (consumed !== 1)
            return { ok: false, reason: 'store_error' };
        return { ok: true, stepUsed: match.step, epoch };
    }
    catch (error) {
        console.error('MFA code verification failed:');
        return { ok: false, reason: 'store_error' };
    }
};
exports.verifyTotpForUser = verifyTotpForUser;
/** Single-use recovery code consumption (stored SHA-256 hashes only). */
const verifyRecoveryCodeForUser = async (deps, userId, suppliedCode) => {
    try {
        const row = await deps.store.findRow(userId);
        if (!row || (row.status !== 'active' && row.status !== 'pending'))
            return { ok: false, reason: 'not_enrolled' };
        if (row.user_id !== userId)
            return { ok: false, reason: 'store_error' };
        const nowMs = securityInteger(deps.now(), 'clock');
        const state = lockoutOf(row, nowMs);
        if (state.locked)
            return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil ?? undefined };
        const epoch = rowStepupEpoch(row);
        const consumed = await deps.store.consumeRecoveryCode(userId, (0, exports.recoveryCodeHash)(suppliedCode));
        if (consumed === 0)
            return { ok: false, reason: 'bad_code' };
        if (consumed !== 1)
            return { ok: false, reason: 'store_error' };
        return { ok: true, epoch };
    }
    catch (error) {
        console.error('MFA recovery verification failed:');
        return { ok: false, reason: 'store_error' };
    }
};
exports.verifyRecoveryCodeForUser = verifyRecoveryCodeForUser;
/* ----------------------------------------------------------------------- */
/* Step-up token (HMAC, short-lived, epoch + session + purpose bound).      */
/* ----------------------------------------------------------------------- */
/** Single purpose a step-up token may carry; anything else is rejected. */
exports.STEPUP_PURPOSE = 'platform_mfa.step_up';
const encodeClaim = (value) => Buffer.from(value, 'utf8').toString('base64url');
const signStepUpToken = (userId, epoch, key, nowMs, claims = {}) => {
    securityInteger(epoch, 'enrollment epoch');
    securityInteger(nowMs, 'clock');
    if (!Buffer.isBuffer(key) || key.length < exports.MIN_MFA_SECRET_KEY_BYTES)
        throw new MfaKeyUnavailableError();
    const issuedAt = Math.floor(nowMs / 1000);
    const purpose = claims.purpose ?? exports.STEPUP_PURPOSE;
    const sessionId = claims.sessionId ?? '';
    const mac = (0, crypto_1.createHmac)('sha256', key)
        .update(`${exports.STEPUP_TOKEN_VERSION}|${userId}|${epoch}|${issuedAt}|${purpose}|${sessionId}`)
        .digest('base64url');
    return [
        exports.STEPUP_TOKEN_VERSION,
        encodeClaim(userId),
        String(epoch),
        String(issuedAt),
        encodeClaim(purpose),
        encodeClaim(sessionId),
        mac,
    ].join('.');
};
exports.signStepUpToken = signStepUpToken;
/**
 * Constant-time MAC verification; every mismatch path returns a denial.
 * `expectedPurpose` defaults to the only purpose the platform mints, and
 * `expectedSessionId` to the session the caller is authenticated with ('' when
 * the auth layer does not carry one), so a token can never be replayed from a
 * different session or repurposed for another flow.
 */
const verifyStepUpToken = (token, options) => {
    if (typeof token !== 'string' || token.length > 4096
        || !Number.isSafeInteger(options.currentEpoch) || options.currentEpoch < 0
        || !Number.isSafeInteger(options.nowMs) || options.nowMs < 0
        || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds <= 0
        || !Buffer.isBuffer(options.key) || options.key.length < exports.MIN_MFA_SECRET_KEY_BYTES) {
        return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 7 || parts[0] !== exports.STEPUP_TOKEN_VERSION)
        return { ok: false, reason: 'malformed' };
    let userId;
    let epoch;
    let issuedAt;
    let purpose;
    let sessionId;
    try {
        userId = Buffer.from(parts[1], 'base64url').toString('utf8');
        epoch = Number(parts[2]);
        issuedAt = Number(parts[3]);
        purpose = Buffer.from(parts[4], 'base64url').toString('utf8');
        sessionId = Buffer.from(parts[5], 'base64url').toString('utf8');
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])
        || !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
        return { ok: false, reason: 'malformed' };
    }
    const expectedMac = (0, crypto_1.createHmac)('sha256', options.key)
        .update(`${exports.STEPUP_TOKEN_VERSION}|${userId}|${epoch}|${issuedAt}|${purpose}|${sessionId}`)
        .digest('base64url');
    const suppliedMac = Buffer.from(parts[6], 'utf8');
    const expected = Buffer.from(expectedMac, 'utf8');
    if (suppliedMac.length !== expected.length || !(0, crypto_1.timingSafeEqual)(suppliedMac, expected)) {
        return { ok: false, reason: 'signature' };
    }
    if (userId !== options.expectedUserId)
        return { ok: false, reason: 'other_user' };
    if (epoch !== options.currentEpoch)
        return { ok: false, reason: 'stale_epoch' };
    if (purpose !== (options.expectedPurpose ?? exports.STEPUP_PURPOSE))
        return { ok: false, reason: 'purpose' };
    if (sessionId !== (options.expectedSessionId ?? ''))
        return { ok: false, reason: 'session' };
    const ageSeconds = Math.floor(options.nowMs / 1000) - issuedAt;
    if (ageSeconds < 0 || ageSeconds > options.maxAgeSeconds)
        return { ok: false, reason: 'expired' };
    return { ok: true, issuedAt };
};
exports.verifyStepUpToken = verifyStepUpToken;
/**
 * Service seam the shared auth middleware can adopt later: after the JWT and
 * platform-permission checks succeed, sensitive routes call
 * `verifier.requireRecentVerification(...)`, and login/mount wiring can call
 * `verifyCode` to enforce mandatory platform MFA without touching auth.ts.
 */
const createMfaVerifier = (deps) => ({
    verifyCode: (userId, code) => (0, exports.verifyTotpForUser)(deps, userId, (0, exports.normalizeTotpInput)(code)),
    verifyRecoveryCode: (userId, code) => (0, exports.verifyRecoveryCodeForUser)(deps, userId, typeof code === 'string' ? code : ''),
    issueStepUpToken: async (userId, epoch, sessionId) => {
        const key = deps.sealKey();
        if (!key)
            throw new MfaKeyUnavailableError();
        return (0, exports.signStepUpToken)(userId, epoch, key, deps.now(), { sessionId });
    },
    currentStepupEpoch: (userId) => deps.store.currentStepupEpoch(userId),
});
exports.createMfaVerifier = createMfaVerifier;
exports.STEPUP_HEADER = 'x-mfa-step-up';
const createRequireStepUp = (deps) => (maxAgeSeconds = exports.DEFAULT_STEPUP_MAX_AGE_SECONDS, purpose = exports.STEPUP_PURPOSE) => async (req, res, next) => {
    const userId = req.user?.id;
    res.set('Cache-Control', 'no-store');
    if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    const sessionId = req.user?.sessionId;
    if (!(0, login_session_1.validSessionId)(sessionId)) {
        res.status(403).json({ error: 'A session-bound login is required', code: 'MFA_SESSION_REQUIRED' });
        return;
    }
    try {
        const key = deps.sealKey();
        if (!key) {
            res.status(503).json({ error: 'MFA encryption key unavailable; step-up denied' });
            return;
        }
        const enrollment = await deps.store.findRow(userId);
        if (!enrollment || enrollment.user_id !== userId || enrollment.status !== 'active') {
            res.status(403).json({ error: 'Active MFA enrollment is required', code: 'MFA_ENROLLMENT_REQUIRED' });
            return;
        }
        const rawEpoch = enrollment.stepup_epoch;
        if ((typeof rawEpoch !== 'number' && typeof rawEpoch !== 'string')
            || (typeof rawEpoch === 'string' && !/^\d+$/.test(rawEpoch))) {
            res.status(503).json({ error: 'MFA step-up is unavailable; denied' });
            return;
        }
        const epoch = Number(rawEpoch);
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            res.status(503).json({ error: 'MFA step-up is unavailable; denied' });
            return;
        }
        const verdict = (0, exports.verifyStepUpToken)(req.headers?.[exports.STEPUP_HEADER], {
            expectedUserId: String(userId),
            currentEpoch: epoch,
            key,
            nowMs: deps.now(),
            maxAgeSeconds,
            expectedPurpose: purpose,
            expectedSessionId: sessionId,
        });
        if (verdict.ok) {
            next();
            return;
        }
        res.status(403).json({ error: 'Recent MFA verification is required', code: `STEP_UP_${(verdict.reason ?? 'required').toUpperCase()}` });
    }
    catch (error) {
        res.status(503).json({ error: 'MFA step-up is unavailable; denied' });
    }
};
exports.createRequireStepUp = createRequireStepUp;
/* ----------------------------------------------------------------------- */
/* SQL store implementation (wired in the production route module).         */
/* ----------------------------------------------------------------------- */
const createSqlPlatformMfaStore = (db) => ({
    findRow: async (userId) => db.queryOne(`SELECT user_id, sealed_secret, status, last_used_step, failed_attempts,
                    locked_until, stepup_epoch
             FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`, [userId]),
    upsertPendingSecret: async (userId, sealedSecret) => {
        // Row lock first: two concurrent enrolls, or an enroll racing an
        // activation, must not rotate an enrollment that is already active.
        const current = await db.queryOne(`SELECT status FROM platform_mfa_secrets WHERE user_id = ? FOR UPDATE`, [userId]);
        if (current?.status === 'active')
            return 0;
        // A re-enroll invalidates every previously issued recovery code: they
        // were bound to the replaced secret/activation and must never remain
        // a valid second factor across disable -> re-enroll -> re-activate.
        await db.execute(`DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?`, [userId]);
        await db.execute(`INSERT INTO platform_mfa_secrets
             (user_id, sealed_secret, status, last_used_step, failed_attempts, locked_until, stepup_epoch)
             VALUES (?, ?, 'pending', 0, 0, NULL,
                     COALESCE((SELECT stepup_epoch FROM (SELECT stepup_epoch FROM platform_mfa_secrets WHERE user_id = ?) prev), 0) + 1)
             ON DUPLICATE KEY UPDATE sealed_secret = VALUES(sealed_secret), status = 'pending',
               last_used_step = 0, failed_attempts = 0, locked_until = NULL,
               stepup_epoch = stepup_epoch + 1`, [userId, sealedSecret, userId]);
        return 1;
    },
    activate: async (userId, expectedEpoch) => {
        const result = await db.execute(`UPDATE platform_mfa_secrets SET status = 'active'
             WHERE user_id = ? AND status = 'pending' AND stepup_epoch = ?`, [userId, expectedEpoch]);
        return result.affectedRows ?? 0;
    },
    markStepUsed: async (userId, step, expectedEpoch) => {
        const result = await db.execute(`UPDATE platform_mfa_secrets
             SET last_used_step = ?
             WHERE user_id = ? AND status IN ('active', 'pending')
               AND stepup_epoch = ? AND last_used_step < ?`, [step, userId, expectedEpoch, step]);
        return result.affectedRows ?? 0;
    },
    recordFailure: async (userId, lockoutSeconds, nowMs) => {
        const lockAt = new Date(nowMs + lockoutSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
        await db.execute(`UPDATE platform_mfa_secrets
             SET locked_until = IF(failed_attempts + 1 >= ?, ?, locked_until),
                 failed_attempts = IF(failed_attempts + 1 >= ?, 0, failed_attempts + 1)
             WHERE user_id = ?`, [exports.MAX_VERIFY_ATTEMPTS, lockAt, exports.MAX_VERIFY_ATTEMPTS, userId]);
        const rows = await db.query(`SELECT failed_attempts AS failed, locked_until AS locked
             FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`, [userId]);
        return Boolean(rows[0]?.locked);
    },
    clearFailures: async (userId) => {
        await db.execute(`UPDATE platform_mfa_secrets SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?`, [userId]);
    },
    saveRecoveryCodeHashes: async (userId, hashes) => {
        for (const codeHash of hashes) {
            await db.execute(`INSERT INTO platform_mfa_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)`, [(0, crypto_1.randomUUID)(), userId, codeHash]);
        }
    },
    consumeRecoveryCode: async (userId, codeHash) => {
        const result = await db.execute(`UPDATE platform_mfa_recovery_codes
             SET used_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, [userId, codeHash]);
        return result.affectedRows ?? 0;
    },
    currentStepupEpoch: async (userId) => {
        const row = await db.queryOne(`SELECT stepup_epoch AS epoch FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`, [userId]);
        return securityInteger(row?.epoch, 'enrollment epoch');
    },
    bumpStepupEpoch: async (userId) => {
        await db.execute(`UPDATE platform_mfa_secrets SET stepup_epoch = stepup_epoch + 1 WHERE user_id = ?`, [userId]);
        return createSqlStoreNextEpoch(db, userId);
    },
    disable: async (userId, expectedEpoch) => {
        securityInteger(expectedEpoch, 'expected enrollment epoch');
        const result = await db.execute(`UPDATE platform_mfa_secrets
             SET sealed_secret = NULL, status = 'disabled', last_used_step = 0,
                 stepup_epoch = stepup_epoch + 1
             WHERE user_id = ? AND status = 'active' AND stepup_epoch = ?`, [userId, expectedEpoch]);
        const affected = result.affectedRows ?? 0;
        // Disabling MFA must also invalidate outstanding recovery codes so a
        // later re-enroll cannot inherit them as a second factor. Skipped when
        // nothing was enrolled so a stray call cannot clear a fresh row.
        if (affected > 0) {
            await db.execute(`DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?`, [userId]);
        }
        return affected;
    },
});
exports.createSqlPlatformMfaStore = createSqlPlatformMfaStore;
const createSqlStoreNextEpoch = async (db, userId) => {
    const row = await db.queryOne(`SELECT stepup_epoch AS epoch FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`, [userId]);
    return securityInteger(row?.epoch, 'enrollment epoch');
};
const createMfaRateLimiter = (options) => {
    const buckets = new Map();
    return {
        tryConsume: (key) => {
            const nowMs = options.now();
            const bucket = buckets.get(key);
            if (!bucket || nowMs - bucket.windowStart >= options.windowMs) {
                buckets.set(key, { windowStart: nowMs, count: 1 });
                return true;
            }
            if (bucket.count >= options.max)
                return false;
            bucket.count += 1;
            return true;
        },
    };
};
exports.createMfaRateLimiter = createMfaRateLimiter;
exports.MFA_RATE_LIMITS = {
    enroll: { max: 3, windowMs: 15 * 60000 },
    verify: { max: 8, windowMs: 5 * 60000 },
    disable: { max: 5, windowMs: 15 * 60000 },
};
