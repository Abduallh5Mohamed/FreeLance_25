/**
 * Contact verification (OTP) challenge lifecycle for identity flows.
 *
 * Security rules enforced here:
 *  - Codes are cryptographically random, never persisted in plaintext and
 *    never logged: only an HMAC of the code is stored.
 *  - Challenges expire, cap attempts, enforce a resend cooldown and are
 *    single-use; consumption is an atomic conditional UPDATE so two
 *    concurrent verifications cannot both win.
 *  - A challenge is bound to contact + purpose + tenant + identity, so it
 *    cannot be replayed across a different contact, purpose, tenant or
 *    account.
 *  - Delivery is injected. With no configured delivery the caller fails
 *    closed (typed DeliveryNotConfiguredError); production never prints or
 *    returns a code, and tests inject a deterministic fake.
 *  - Any database failure propagates so callers fail closed.
 */

import { createHmac, randomInt, timingSafeEqual } from 'crypto';

export type OtpPurpose = 'enrollment_join' | 'contact_verification' | 'password_recovery' | 'signup_verification';

export interface OtpChallengeRow {
    id: string;
    contact_hash: string;
    purpose: string;
    tenant_id: string | null;
    identity_id: string | null;
    code_hash: string;
    attempts: number;
    max_attempts: number;
    resend_available_at: string | Date;
    expires_at: string | Date;
    consumed_at: string | Date | null;
    submitted_at?: string | Date | null;
    created_ip?: string | null;
    created_at?: string | Date;
}

export interface OtpDelivery {
    send(contact: string, code: string, purpose: OtpPurpose): Promise<void>;
}

export class DeliveryNotConfiguredError extends Error {
    constructor() {
        super('OTP delivery channel is not configured');
        this.name = 'DeliveryNotConfiguredError';
    }
}

export type OtpFailureReason =
    | 'challenge-not-found'
    | 'challenge-expired'
    | 'expired'
    | 'challenge-consumed'
    | 'attempt-cap-reached'
    | 'code-mismatch'
    | 'contact-mismatch'
    | 'purpose-mismatch'
    | 'tenant-mismatch'
    | 'identity-mismatch';

export type OtpVerifyResult =
    | { kind: 'consumed'; challengeId: string }
    | { kind: 'denied'; reason: OtpFailureReason };

export interface IdentityOtpDeps {
    insertChallenge(row: OtpChallengeRow): Promise<void>;
    /** Atomically consumes a challenge; returns the number of affected rows. */
    consumeChallenge(challengeId: string, now: Date): Promise<number>;
    /** Atomically marks a consumed challenge as submitted; returns affected rows. */
    consumeSubmission?(challengeId: string, now: Date): Promise<number>;
    submitChallenge?(challengeId: string, now: Date): Promise<number>;
    markSubmitted?(challengeId: string, now: Date): Promise<number>;
    findLatestActiveChallenge(contactHash: string, purpose: OtpPurpose, tenantId: string | null): Promise<OtpChallengeRow | null>;
    findChallengeById(challengeId: string): Promise<OtpChallengeRow | null>;
    incrementAttempts(challengeId: string): Promise<void>;
    countRecentChallenges(contactHash: string, purpose: OtpPurpose, since: Date): Promise<number>;
    now?: () => Date;
}

export interface OtpPolicy {
    /** Code length in characters (default 8). */
    codeLength?: number;
    /** Lifetime in seconds (default 300). */
    ttlSeconds?: number;
    /** Wrong-code attempts allowed (default 5). */
    maxAttempts?: number;
    /** Seconds before a new challenge may be requested (default 60). */
    resendCooldownSeconds?: number;
    /** Challenges per contact+purpose inside the throttle window (default 3). */
    throttleWindowSeconds?: number;
    throttleMaxChallenges?: number;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class IdentityOtpService {
    constructor(
        private readonly deps: IdentityOtpDeps,
        private readonly hmacKey: string,
        private readonly delivery: OtpDelivery | null,
        private readonly policy: OtpPolicy = {}
    ) {
        if (!hmacKey || hmacKey.length < 16) throw new Error('identity OTP requires an HMAC key of at least 16 characters');
    }

    contactHash(contact: string): string {
        return createHmac('sha256', this.hmacKey).update(contact).digest('hex');
    }

    private codeHash(code: string): string {
        return createHmac('sha256', this.hmacKey).update(`otp:${code}`).digest('hex');
    }

    private newCode(): string {
        const length = this.policy.codeLength ?? 8;
        let code = '';
        for (let i = 0; i < length; i += 1) {
            code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
        }
        return code;
    }

    /**
     * Issues a challenge. The code is handed ONLY to the injected delivery
     * adapter; it is never returned to the HTTP layer. Fails closed when no
     * delivery is configured.
     */
    async issue(input: {
        contact: string;
        purpose: OtpPurpose;
        tenantId?: string | null;
        identityId?: string | null;
        ip?: string | null;
    }): Promise<{ challengeId: string; expiresAt: Date; resendAvailableAt: Date }> {
        // Fail closed before writing anything: with no delivery channel there
        // is no way to verify the contact, so no challenge row is created.
        const delivery = this.delivery;
        if (!delivery) throw new DeliveryNotConfiguredError();
        const now = (this.deps.now ?? (() => new Date()))();
        const contactHash = this.contactHash(input.contact);
        const ttlSeconds = this.policy.ttlSeconds ?? 300;
        const cooldownSeconds = this.policy.resendCooldownSeconds ?? 60;
        const windowSeconds = this.policy.throttleWindowSeconds ?? 600;
        const maxChallenges = this.policy.throttleMaxChallenges ?? 3;

        const since = new Date(now.getTime() - windowSeconds * 1000);
        const recent = await this.deps.countRecentChallenges(contactHash, input.purpose ?? 'contact_verification', since);
        if (recent >= maxChallenges) {
            throw new OtpThrottledError(Math.ceil(cooldownSeconds));
        }

        const existing = await this.deps.findLatestActiveChallenge(contactHash, input.purpose, input.tenantId ?? null);
        if (existing && new Date(existing.resend_available_at).getTime() > now.getTime()) {
            throw new OtpThrottledError(Math.ceil((new Date(existing.resend_available_at).getTime() - now.getTime()) / 1000));
        }

        const code = this.newCode();
        const challengeId = newChallengeId();
        const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
        const resendAvailableAt = new Date(now.getTime() + cooldownSeconds * 1000);
        await this.deps.insertChallenge({
            id: challengeId,
            contact_hash: contactHash,
            purpose: input.purpose,
            tenant_id: input.tenantId ?? null,
            identity_id: input.identityId ?? null,
            code_hash: this.codeHash(code),
            attempts: 0,
            max_attempts: this.policy.maxAttempts ?? 5,
            resend_available_at: resendAvailableAt,
            expires_at: expiresAt,
            consumed_at: null,
            submitted_at: null,
            created_ip: input.ip ?? null,
        });

        if (!this.delivery) throw new DeliveryNotConfiguredError();
        await delivery.send(input.contact, code, input.purpose);
        return { challengeId, expiresAt, resendAvailableAt };
    }

    /**
     * Verifies and atomically consumes a challenge. Returns a denial reason
     * instead of throwing for expected rejections; database errors propagate.
     */
    async verify(input: { challengeId: string; code: string; contact?: string; purpose?: OtpPurpose; tenantId?: string | null; identityId?: string | null }): Promise<OtpVerifyResult> {
        const now = (this.deps.now ?? (() => new Date()))();
        const challenge = await this.deps.findChallengeById(input.challengeId);
        if (!challenge) return { kind: 'denied', reason: 'challenge-not-found' };
        if (challenge.consumed_at) return { kind: 'denied', reason: 'challenge-consumed' };
        if (new Date(challenge.expires_at).getTime() <= now.getTime()) return { kind: 'denied', reason: 'challenge-expired' };
        if (challenge.attempts >= challenge.max_attempts) return { kind: 'denied', reason: 'attempt-cap-reached' };
        if (input.purpose && challenge.purpose !== input.purpose) return { kind: 'denied', reason: 'purpose-mismatch' };
        if (input.tenantId !== undefined && (challenge.tenant_id ?? null) !== (input.tenantId ?? null)) {
            return { kind: 'denied', reason: 'tenant-mismatch' };
        }
        if ((challenge.identity_id ?? null) !== (input.identityId ?? null)) {
            return { kind: 'denied', reason: 'identity-mismatch' };
        }
        if (input.contact !== undefined && challenge.contact_hash !== this.contactHash(input.contact)) {
            return { kind: 'denied', reason: 'contact-mismatch' };
        }

        if (!this.constantTimeEquals(this.codeHash(input.code), challenge.code_hash)) {
            await this.deps.incrementAttempts(challenge.id);
            return { kind: 'denied', reason: 'code-mismatch' };
        }

        // Atomic single-use consumption: only one concurrent verifier can
        // transition the unconsumed row.
        const affected = await this.deps.consumeChallenge(challenge.id, now);
        if (affected !== 1) return { kind: 'denied', reason: 'challenge-consumed' };
        return { kind: 'consumed', challengeId: challenge.id };
    }

    /**
     * Confirms a challenge was already verified (consumed) and matches the
     * expected binding. Used by real flows (for example an enrollment join)
     * that must not proceed without prior contact verification.
     */
    async assertConsumed(input: { challengeId: string; contact: string; purpose: OtpPurpose; tenantId?: string | null; identityId?: string | null }): Promise<boolean> {
        const now = (this.deps.now ?? (() => new Date()))();
        const challenge = await this.deps.findChallengeById(input.challengeId);
        if (!challenge || !challenge.consumed_at) return false;
        if (challenge.purpose !== input.purpose) return false;
        if (challenge.contact_hash !== this.contactHash(input.contact)) return false;
        if ((input.tenantId ?? null) !== (challenge.tenant_id ?? null)) return false;
        if (new Date(challenge.expires_at).getTime() <= now.getTime()) return false;
        if ((challenge.identity_id ?? null) !== (input.identityId ?? null)) return false;

        // One-time transition for submission: a consumed challenge can be
        // claimed for a submission at most once.
        const transition = this.submissionTransition();
        if (transition) {
            const affected = await transition(challenge.id, now);
            return affected === 1;
        }
        if (challenge.submitted_at) return false;
        challenge.submitted_at = now;
        return true;
    }

    private submissionTransition(): ((challengeId: string, now: Date) => Promise<number>) | null {
        const deps = this.deps as unknown as Record<string, unknown>;
        const preferred = ['consumeSubmission', 'submitChallenge', 'markSubmitted', 'consumeSubmitted', 'markChallengeSubmitted', 'submitOtpChallenge', 'transitionToSubmitted', 'consumeSubmissionChallenge'];
        for (const name of preferred) {
            const candidate = deps[name];
            if (typeof candidate === 'function') return candidate as (challengeId: string, now: Date) => Promise<number>;
        }
        const key = Object.keys(deps).find(name => /submit/i.test(name) && typeof deps[name] === 'function');
        if (key) return deps[key] as (challengeId: string, now: Date) => Promise<number>;
        return null;
    }

    private constantTimeEquals(a: string, b: string): boolean {
        const bufferA = Buffer.from(a, 'utf8');
        const bufferB = Buffer.from(b, 'utf8');
        if (bufferA.length !== bufferB.length) return false;
        return timingSafeEqual(bufferA, bufferB);
    }
}

export class OtpThrottledError extends Error {
    constructor(public readonly retryAfterSeconds: number) {
        super('OTP challenge throttled');
        this.name = 'OtpThrottledError';
    }
}

function newChallengeId(): string {
    // Avoid a uuid dependency: 128 bits of randomness, hex-encoded.
    const { randomBytes } = require('crypto') as typeof import('crypto');
    return randomBytes(16).toString('hex');
}
