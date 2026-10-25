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

import { createDecipheriv, createCipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { validSessionId } from '../security/login-session';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
export const MIN_MFA_SECRET_KEY_BYTES = 32;
export const MAX_RECOVERY_CODE = 10;
export const RECOVERY_CODE_COUNT = 10;
export const MAX_VERIFY_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 900;
export const DEFAULT_STEPUP_MAX_AGE_SECONDS = 600;
export const SEAL_VERSION = 'v1';
export const STEPUP_TOKEN_VERSION = 'su2';

export interface PlatformMfaDb {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    /**
     * Optional single-connection transaction seam. When present the route runs
     * every state mutation AND its sealed audit entry on the same connection,
     * so a failed audit rolls the mutation back instead of leaving half of it
     * committed.
     */
    transaction?: <T>(fn: (tx: PlatformMfaDb) => Promise<T>) => Promise<T>;
}

export class MfaKeyUnavailableError extends Error {
    constructor() {
        super('MFA_SECRET_KEY is missing or shorter than 32 bytes');
        this.name = 'MfaKeyUnavailableError';
    }
}

/* ----------------------------------------------------------------------- */
/* Key sealing: env key acquisition and AES-256-GCM envelope.               */
/* ----------------------------------------------------------------------- */

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** Reads MFA_SECRET_KEY; hex/base64 forms are preferred, raw bytes last. */
export const mfaKeyFromEnv = (env: NodeJS.ProcessEnv = process.env): Buffer | null => {
    const raw = env.MFA_SECRET_KEY;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    let key: Buffer;
    if (raw.length % 2 === 0 && HEX_PATTERN.test(raw)) {
        key = Buffer.from(raw, 'hex');
    } else {
        try {
            key = Buffer.from(raw, 'base64');
        } catch {
            key = Buffer.from(raw, 'utf8');
        }
        if (key.length === 0) key = Buffer.from(raw, 'utf8');
    }
    return key.length >= MIN_MFA_SECRET_KEY_BYTES ? Buffer.from(key) : null;
};

export const sealValue = (plaintext: string, key: Buffer): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
        SEAL_VERSION,
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        sealed.toString('base64'),
    ].join('.');
};

/** Throws (fails closed) on format mismatch or GCM tag invalidation. */
export const openSealedValue = (sealed: string, key: Buffer): string => {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== SEAL_VERSION) {
        throw new Error('Sealed value format is not recognized');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

/* ----------------------------------------------------------------------- */
/* Base32 (RFC 4648) and TOTP/HOTP (RFC 4226 / RFC 6238).                   */
/* ----------------------------------------------------------------------- */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (input: Buffer): string => {
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
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
};

export const base32Decode = (text: string): Buffer => {
    const clean = text.replace(/[\s=-]/g, '').toUpperCase();
    if (!/^[A-Z2-7]*$/.test(clean)) throw new Error('Secret is not valid base32');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
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

export const generateTotpSecret = (rng: (length: number) => Buffer = randomBytes): string =>
    base32Encode(rng(TOTP_SECRET_BYTES));

/** RFC 4226 HMAC-SHA-1 truncation with 6 digits. */
export const hotpAt = (secret: Buffer, counter: number): string => {
    if (!Number.isInteger(counter) || counter < 0 || counter > Number.MAX_SAFE_INTEGER) {
        throw new Error('Counter is out of range');
    }
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', secret).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        (digest[offset + 1] << 16) |
        (digest[offset + 2] << 8) |
        digest[offset + 3];
    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

export const totpAtStep = (secret: Buffer, step: number): string => hotpAt(secret, step);

export const stepForTime = (timeMs: number, stepSeconds: number = TOTP_STEP_SECONDS): number =>
    Math.floor(timeMs / 1000 / stepSeconds);

export const totpAtTime = (secret: Buffer, timeMs: number, stepSeconds: number = TOTP_STEP_SECONDS): string =>
    totpAtStep(secret, stepForTime(timeMs, stepSeconds));

export const otpauthUri = (userId: string, secret: string, issuer = 'Tabweb%20Teachers'): string =>
    `otpauth://totp/${issuer}:${encodeURIComponent(userId)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;

/** Guess is compared against the computed code without early-size leaks. */
const codesEqual = (computed: string, supplied: string): boolean => {
    if (supplied.length !== computed.length) return false;
    let mismatch = 0;
    for (let index = 0; index < computed.length; index += 1) {
        mismatch |= computed.charCodeAt(index) ^ supplied.charCodeAt(index);
    }
    return mismatch === 0;
};

export interface TotpWindowCheck {
    ok: boolean;
    step: number | null;
}

/**
 * Verify a supplied code against the +-1 window steps. The caller persists the
 * returned step for replay protection; `verifyTotpReplayChecked` folds in the
 * last already-used step so an equal-or-older step never counts as a match.
 */
export const verifyTotp = (
    secret: Buffer,
    code: string,
    currentStep: number,
    window: number = TOTP_WINDOW_STEPS,
): TotpWindowCheck => {
    for (let step = currentStep + window; step >= currentStep - window; step -= 1) {
        if (step < 0) continue;
        if (codesEqual(totpAtStep(secret, step), code)) return { ok: true, step };
    }
    return { ok: false, step: null };
};

export const verifyTotpReplayChecked = (
    secret: Buffer,
    code: string,
    currentStep: number,
    lastUsedStep: number,
    window: number = TOTP_WINDOW_STEPS,
): TotpWindowCheck => {
    const result = verifyTotp(secret, code, currentStep, window);
    if (!result.ok || result.step === null) return { ok: false, step: null };
    return result.step <= lastUsedStep ? { ok: false, step: null } : result;
};

export const normalizeTotpInput = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.replace(/[\s-]/g, '');
};

/* ----------------------------------------------------------------------- */
/* Recovery codes (single use, stored hashed).                              */
/* ----------------------------------------------------------------------- */

export const generateRecoveryCodes = (
    count: number = RECOVERY_CODE_COUNT,
    rng: (length: number) => Buffer = randomBytes,
): string[] => {
    const codes: string[] = [];
    for (let index = 0; index < count; index += 1) {
        codes.push(rng(MAX_RECOVERY_CODE).toString('hex'));
    }
    return codes;
};

export const recoveryCodeHash = (code: string): string =>
    createHash('sha256').update(normalizeTotpInput(code), 'utf8').digest('hex');

/* ----------------------------------------------------------------------- */
/* Row + store seam.                                                        */
/* ----------------------------------------------------------------------- */

export type MfaStatus = 'pending' | 'active' | 'disabled';

export interface MfaRow {
    user_id: string;
    sealed_secret: string | null;
    status: string;
    last_used_step: number | string | null;
    failed_attempts: number | string | null;
    locked_until: string | Date | null;
    stepup_epoch: number | string | null;
}

export interface PlatformMfaStore {
    findRow(userId: string): Promise<MfaRow | null>;
    /**
     * Install a new pending secret and purge every recovery code of the
     * replaced enrollment. Returns 0 (and writes nothing) when the row is
     * already active, so a concurrent enroll can never rotate an active
     * enrollment; the check runs under a row lock.
     */
    upsertPendingSecret(userId: string, sealedSecret: string): Promise<number>;
    /**
     * pending -> active for the enrollment that was just verified. Returns
     * affected rows; 0 means another request won the transition or the
     * enrollment was replaced meanwhile.
     */
    activate(userId: string, expectedEpoch: number): Promise<number>;
    /**
     * Consume the newest time-step for the given enrollment; returns affected
     * rows (0 => replayed, or the enrollment epoch changed underneath).
     */
    markStepUsed(userId: string, step: number, expectedEpoch: number): Promise<number>;
    /**
     * Increment the failure counter; locks the row for `lockoutSeconds` once
     * MAX_VERIFY_ATTEMPTS is exceeded. Returns true when the row is now locked.
     */
    recordFailure(userId: string, lockoutSeconds: number, nowMs: number): Promise<boolean>;
    clearFailures(userId: string): Promise<void>;
    saveRecoveryCodeHashes(userId: string, hashes: string[]): Promise<void>;
    /** Flip used_at once for the hash; returns affected rows. */
    consumeRecoveryCode(userId: string, codeHash: string): Promise<number>;
    currentStepupEpoch(userId: string): Promise<number>;
    bumpStepupEpoch(userId: string): Promise<number>;
    /** Disable an enrolled row; returns affected rows (0 => nothing enrolled). */
    disable(userId: string, expectedEpoch: number): Promise<number>;
}

export interface LockoutState {
    locked: boolean;
    lockedUntil: string | null;
}

const securityInteger = (value: unknown, label: string): number => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
        throw new Error('Invalid MFA ' + label);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid MFA ' + label);
    return parsed;
};

const lockoutOf = (row: MfaRow, nowMs: number): LockoutState => {
    securityInteger(nowMs, 'clock');
    const lockedUntil = row.locked_until === null ? 0 : new Date(row.locked_until).getTime();
    if (!Number.isSafeInteger(lockedUntil) || lockedUntil < 0) throw new Error('Invalid MFA lockout');
    if (lockedUntil <= nowMs) return { locked: false, lockedUntil: null };
    return { locked: true, lockedUntil: row.locked_until instanceof Date ? row.locked_until.toISOString() : String(row.locked_until) };
};

/* ----------------------------------------------------------------------- */
/* Verification core (shared by the routes and the exposed verifier).        */
/* ----------------------------------------------------------------------- */

export type VerifyDenyReason =
    | 'not_enrolled'
    | 'inactive'
    | 'locked'
    | 'bad_code'
    | 'replayed'
    | 'stale_enrollment'
    | 'key_unavailable'
    | 'store_error';

export type CodeVerifyResult =
    | { ok: true; stepUsed: number; epoch: number }
    | { ok: false; reason: VerifyDenyReason; lockedUntil?: string };

export type RecoveryVerifyResult =
    | { ok: true; epoch: number }
    | { ok: false; reason: VerifyDenyReason; lockedUntil?: string };

export interface MfaVerifyDeps {
    store: PlatformMfaStore;
    sealKey: () => Buffer | null;
    now: () => number;
}

const rowStepupEpoch = (row: MfaRow): number => securityInteger(row.stepup_epoch, 'enrollment epoch');

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
export const verifyTotpForUser = async (
    deps: MfaVerifyDeps,
    userId: string,
    suppliedCode: string,
): Promise<CodeVerifyResult> => {
    try {
        const row = await deps.store.findRow(userId);
        if (!row || (row.status !== 'active' && row.status !== 'pending') || !row.sealed_secret) {
            return { ok: false, reason: 'not_enrolled' };
        }
        if (row.user_id !== userId) return { ok: false, reason: 'store_error' };
        const nowMs = securityInteger(deps.now(), 'clock');
        const state = lockoutOf(row, nowMs);
        if (state.locked) return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil ?? undefined };
        const key = deps.sealKey();
        if (!key) return { ok: false, reason: 'key_unavailable' };
        let secret: Buffer;
        try {
            secret = base32Decode(openSealedValue(row.sealed_secret, key));
        } catch {
            return { ok: false, reason: 'key_unavailable' };
        }
        const epoch = rowStepupEpoch(row);
        const currentStep = stepForTime(nowMs);
        const match = verifyTotpReplayChecked(secret, normalizeTotpInput(suppliedCode), currentStep, securityInteger(row.last_used_step, 'replay step'));
        if (!match.ok || match.step === null) return { ok: false, reason: 'bad_code' };
        const consumed = await deps.store.markStepUsed(userId, match.step, epoch);
        if (consumed === 0) {
            // Distinguish an ordinary replay from a secret that was replaced
            // between the read and the conditional update.
            const fresh = await deps.store.findRow(userId);
            const replaced = !fresh || rowStepupEpoch(fresh) !== epoch || fresh.status === 'disabled';
            return { ok: false, reason: replaced ? 'stale_enrollment' : 'replayed' };
        }
        if (consumed !== 1) return { ok: false, reason: 'store_error' };
        return { ok: true, stepUsed: match.step, epoch };
    } catch (error) {
        console.error('MFA code verification failed:');
        return { ok: false, reason: 'store_error' };
    }
};

/** Single-use recovery code consumption (stored SHA-256 hashes only). */
export const verifyRecoveryCodeForUser = async (
    deps: MfaVerifyDeps,
    userId: string,
    suppliedCode: string,
): Promise<RecoveryVerifyResult> => {
    try {
        const row = await deps.store.findRow(userId);
        if (!row || (row.status !== 'active' && row.status !== 'pending')) return { ok: false, reason: 'not_enrolled' };
        if (row.user_id !== userId) return { ok: false, reason: 'store_error' };
        const nowMs = securityInteger(deps.now(), 'clock');
        const state = lockoutOf(row, nowMs);
        if (state.locked) return { ok: false, reason: 'locked', lockedUntil: state.lockedUntil ?? undefined };
        const epoch = rowStepupEpoch(row);
        const consumed = await deps.store.consumeRecoveryCode(userId, recoveryCodeHash(suppliedCode));
        if (consumed === 0) return { ok: false, reason: 'bad_code' };
        if (consumed !== 1) return { ok: false, reason: 'store_error' };
        return { ok: true, epoch };
    } catch (error) {
        console.error('MFA recovery verification failed:');
        return { ok: false, reason: 'store_error' };
    }
};

/* ----------------------------------------------------------------------- */
/* Step-up token (HMAC, short-lived, epoch + session + purpose bound).      */
/* ----------------------------------------------------------------------- */

/** Single purpose a step-up token may carry; anything else is rejected. */
export const STEPUP_PURPOSE = 'platform_mfa.step_up';

export interface StepUpClaims {
    purpose?: string;
    sessionId?: string;
}

const encodeClaim = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

export const signStepUpToken = (
    userId: string,
    epoch: number,
    key: Buffer,
    nowMs: number,
    claims: StepUpClaims = {},
): string => {
    securityInteger(epoch, 'enrollment epoch');
    securityInteger(nowMs, 'clock');
    if (!Buffer.isBuffer(key) || key.length < MIN_MFA_SECRET_KEY_BYTES) throw new MfaKeyUnavailableError();
    const issuedAt = Math.floor(nowMs / 1000);
    const purpose = claims.purpose ?? STEPUP_PURPOSE;
    const sessionId = claims.sessionId ?? '';
    const mac = createHmac('sha256', key)
        .update(`${STEPUP_TOKEN_VERSION}|${userId}|${epoch}|${issuedAt}|${purpose}|${sessionId}`)
        .digest('base64url');
    return [
        STEPUP_TOKEN_VERSION,
        encodeClaim(userId),
        String(epoch),
        String(issuedAt),
        encodeClaim(purpose),
        encodeClaim(sessionId),
        mac,
    ].join('.');
};

export interface StepUpParse {
    ok: boolean;
    reason?: 'malformed' | 'signature' | 'other_user' | 'expired' | 'stale_epoch' | 'purpose' | 'session';
    issuedAt?: number;
}

/**
 * Constant-time MAC verification; every mismatch path returns a denial.
 * `expectedPurpose` defaults to the only purpose the platform mints, and
 * `expectedSessionId` to the session the caller is authenticated with ('' when
 * the auth layer does not carry one), so a token can never be replayed from a
 * different session or repurposed for another flow.
 */
export const verifyStepUpToken = (
    token: unknown,
    options: {
        expectedUserId: string;
        currentEpoch: number;
        key: Buffer;
        nowMs: number;
        maxAgeSeconds: number;
        expectedPurpose?: string;
        expectedSessionId?: string;
    },
): StepUpParse => {
    if (typeof token !== 'string' || token.length > 4096
        || !Number.isSafeInteger(options.currentEpoch) || options.currentEpoch < 0
        || !Number.isSafeInteger(options.nowMs) || options.nowMs < 0
        || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds <= 0
        || !Buffer.isBuffer(options.key) || options.key.length < MIN_MFA_SECRET_KEY_BYTES) {
        return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 7 || parts[0] !== STEPUP_TOKEN_VERSION) return { ok: false, reason: 'malformed' };
    let userId: string;
    let epoch: number;
    let issuedAt: number;
    let purpose: string;
    let sessionId: string;
    try {
        userId = Buffer.from(parts[1], 'base64url').toString('utf8');
        epoch = Number(parts[2]);
        issuedAt = Number(parts[3]);
        purpose = Buffer.from(parts[4], 'base64url').toString('utf8');
        sessionId = Buffer.from(parts[5], 'base64url').toString('utf8');
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])
        || !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
        return { ok: false, reason: 'malformed' };
    }
    const expectedMac = createHmac('sha256', options.key)
        .update(`${STEPUP_TOKEN_VERSION}|${userId}|${epoch}|${issuedAt}|${purpose}|${sessionId}`)
        .digest('base64url');
    const suppliedMac = Buffer.from(parts[6], 'utf8');
    const expected = Buffer.from(expectedMac, 'utf8');
    if (suppliedMac.length !== expected.length || !timingSafeEqual(suppliedMac, expected)) {
        return { ok: false, reason: 'signature' };
    }
    if (userId !== options.expectedUserId) return { ok: false, reason: 'other_user' };
    if (epoch !== options.currentEpoch) return { ok: false, reason: 'stale_epoch' };
    if (purpose !== (options.expectedPurpose ?? STEPUP_PURPOSE)) return { ok: false, reason: 'purpose' };
    if (sessionId !== (options.expectedSessionId ?? '')) return { ok: false, reason: 'session' };
    const ageSeconds = Math.floor(options.nowMs / 1000) - issuedAt;
    if (ageSeconds < 0 || ageSeconds > options.maxAgeSeconds) return { ok: false, reason: 'expired' };
    return { ok: true, issuedAt };
};

export interface MfaVerifier {
    verifyCode(userId: string, code: unknown): Promise<CodeVerifyResult>;
    verifyRecoveryCode(userId: string, code: unknown): Promise<RecoveryVerifyResult>;
    /** Sign for the enrollment epoch that was actually verified. */
    issueStepUpToken(userId: string, epoch: number, sessionId?: string): Promise<string>;
    currentStepupEpoch(userId: string): Promise<number>;
}

/**
 * Service seam the shared auth middleware can adopt later: after the JWT and
 * platform-permission checks succeed, sensitive routes call
 * `verifier.requireRecentVerification(...)`, and login/mount wiring can call
 * `verifyCode` to enforce mandatory platform MFA without touching auth.ts.
 */
export const createMfaVerifier = (deps: MfaVerifyDeps): MfaVerifier => ({
    verifyCode: (userId, code) => verifyTotpForUser(deps, userId, normalizeTotpInput(code)),
    verifyRecoveryCode: (userId, code) =>
        verifyRecoveryCodeForUser(deps, userId, typeof code === 'string' ? code : ''),
    issueStepUpToken: async (userId, epoch, sessionId) => {
        const key = deps.sealKey();
        if (!key) throw new MfaKeyUnavailableError();
        return signStepUpToken(userId, epoch, key, deps.now(), { sessionId });
    },
    currentStepupEpoch: (userId) => deps.store.currentStepupEpoch(userId),
});

export const STEPUP_HEADER = 'x-mfa-step-up';

export const createRequireStepUp = (
    deps: { store: PlatformMfaStore; sealKey: () => Buffer | null; now: () => number },
) => (maxAgeSeconds: number = DEFAULT_STEPUP_MAX_AGE_SECONDS, purpose: string = STEPUP_PURPOSE) =>
    async (req: Request & { user?: { id?: string; sessionId?: string } | null }, res: Response, next: NextFunction): Promise<void> => {
        const userId = req.user?.id;
        res.set('Cache-Control', 'no-store');
        if (!userId) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const sessionId = req.user?.sessionId;
        if (!validSessionId(sessionId)) {
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
            const verdict = verifyStepUpToken(req.headers?.[STEPUP_HEADER], {
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
        } catch (error) {
            res.status(503).json({ error: 'MFA step-up is unavailable; denied' });
        }
    };

/* ----------------------------------------------------------------------- */
/* SQL store implementation (wired in the production route module).         */
/* ----------------------------------------------------------------------- */

export const createSqlPlatformMfaStore = (db: PlatformMfaDb): PlatformMfaStore => ({
    findRow: async (userId) =>
        db.queryOne<MfaRow>(
            `SELECT user_id, sealed_secret, status, last_used_step, failed_attempts,
                    locked_until, stepup_epoch
             FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`,
            [userId],
        ),
    upsertPendingSecret: async (userId, sealedSecret) => {
        // Row lock first: two concurrent enrolls, or an enroll racing an
        // activation, must not rotate an enrollment that is already active.
        const current = await db.queryOne<{ status: string }>(
            `SELECT status FROM platform_mfa_secrets WHERE user_id = ? FOR UPDATE`,
            [userId],
        );
        if (current?.status === 'active') return 0;
        // A re-enroll invalidates every previously issued recovery code: they
        // were bound to the replaced secret/activation and must never remain
        // a valid second factor across disable -> re-enroll -> re-activate.
        await db.execute(
            `DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?`,
            [userId],
        );
        await db.execute(
            `INSERT INTO platform_mfa_secrets
             (user_id, sealed_secret, status, last_used_step, failed_attempts, locked_until, stepup_epoch)
             VALUES (?, ?, 'pending', 0, 0, NULL,
                     COALESCE((SELECT stepup_epoch FROM (SELECT stepup_epoch FROM platform_mfa_secrets WHERE user_id = ?) prev), 0) + 1)
             ON DUPLICATE KEY UPDATE sealed_secret = VALUES(sealed_secret), status = 'pending',
               last_used_step = 0, failed_attempts = 0, locked_until = NULL,
               stepup_epoch = stepup_epoch + 1`,
            [userId, sealedSecret, userId],
        );
        return 1;
    },
    activate: async (userId, expectedEpoch) => {
        const result = await db.execute(
            `UPDATE platform_mfa_secrets SET status = 'active'
             WHERE user_id = ? AND status = 'pending' AND stepup_epoch = ?`,
            [userId, expectedEpoch],
        );
        return result.affectedRows ?? 0;
    },
    markStepUsed: async (userId, step, expectedEpoch) => {
        const result = await db.execute(
            `UPDATE platform_mfa_secrets
             SET last_used_step = ?
             WHERE user_id = ? AND status IN ('active', 'pending')
               AND stepup_epoch = ? AND last_used_step < ?`,
            [step, userId, expectedEpoch, step],
        );
        return result.affectedRows ?? 0;
    },
    recordFailure: async (userId, lockoutSeconds, nowMs) => {
        const lockAt = new Date(nowMs + lockoutSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
        await db.execute(
            `UPDATE platform_mfa_secrets
             SET locked_until = IF(failed_attempts + 1 >= ?, ?, locked_until),
                 failed_attempts = IF(failed_attempts + 1 >= ?, 0, failed_attempts + 1)
             WHERE user_id = ?`,
            [MAX_VERIFY_ATTEMPTS, lockAt, MAX_VERIFY_ATTEMPTS, userId],
        );
        const rows = await db.query<{ failed: number; locked: string | null }>(
            `SELECT failed_attempts AS failed, locked_until AS locked
             FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`,
            [userId],
        );
        return Boolean(rows[0]?.locked);
    },
    clearFailures: async (userId) => {
        await db.execute(
            `UPDATE platform_mfa_secrets SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?`,
            [userId],
        );
    },
    saveRecoveryCodeHashes: async (userId, hashes) => {
        for (const codeHash of hashes) {
            await db.execute(
                `INSERT INTO platform_mfa_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)`,
                [randomUUID(), userId, codeHash],
            );
        }
    },
    consumeRecoveryCode: async (userId, codeHash) => {
        const result = await db.execute(
            `UPDATE platform_mfa_recovery_codes
             SET used_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
            [userId, codeHash],
        );
        return result.affectedRows ?? 0;
    },
    currentStepupEpoch: async (userId) => {
        const row = await db.queryOne<{ epoch: number | string | null }>(
            `SELECT stepup_epoch AS epoch FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`,
            [userId],
        );
        return securityInteger(row?.epoch, 'enrollment epoch');
    },
    bumpStepupEpoch: async (userId) => {
        await db.execute(
            `UPDATE platform_mfa_secrets SET stepup_epoch = stepup_epoch + 1 WHERE user_id = ?`,
            [userId],
        );
        return createSqlStoreNextEpoch(db, userId);
    },
    disable: async (userId, expectedEpoch) => {
        securityInteger(expectedEpoch, 'expected enrollment epoch');
        const result = await db.execute(
            `UPDATE platform_mfa_secrets
             SET sealed_secret = NULL, status = 'disabled', last_used_step = 0,
                 stepup_epoch = stepup_epoch + 1
             WHERE user_id = ? AND status = 'active' AND stepup_epoch = ?`,
            [userId, expectedEpoch],
        );
        const affected = result.affectedRows ?? 0;
        // Disabling MFA must also invalidate outstanding recovery codes so a
        // later re-enroll cannot inherit them as a second factor. Skipped when
        // nothing was enrolled so a stray call cannot clear a fresh row.
        if (affected > 0) {
            await db.execute(
                `DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?`,
                [userId],
            );
        }
        return affected;
    },
});

const createSqlStoreNextEpoch = async (db: PlatformMfaDb, userId: string): Promise<number> => {
    const row = await db.queryOne<{ epoch: number | string | null }>(
        `SELECT stepup_epoch AS epoch FROM platform_mfa_secrets WHERE user_id = ? LIMIT 1`,
        [userId],
    );
    return securityInteger(row?.epoch, 'enrollment epoch');
};

/* ----------------------------------------------------------------------- */
/* Per-user fixed-window rate limiter (clock injectable, no persistence).    */
/* ----------------------------------------------------------------------- */

export interface MfaRateLimiter {
    tryConsume(key: string): boolean;
}

export const createMfaRateLimiter = (options: { max: number; windowMs: number; now: () => number }): MfaRateLimiter => {
    const buckets = new Map<string, { windowStart: number; count: number }>();
    return {
        tryConsume: (key: string): boolean => {
            const nowMs = options.now();
            const bucket = buckets.get(key);
            if (!bucket || nowMs - bucket.windowStart >= options.windowMs) {
                buckets.set(key, { windowStart: nowMs, count: 1 });
                return true;
            }
            if (bucket.count >= options.max) return false;
            bucket.count += 1;
            return true;
        },
    };
};

export const MFA_RATE_LIMITS = {
    enroll: { max: 3, windowMs: 15 * 60_000 },
    verify: { max: 8, windowMs: 5 * 60_000 },
    disable: { max: 5, windowMs: 15 * 60_000 },
} as const;
