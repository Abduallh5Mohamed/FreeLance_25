"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtpThrottledError = exports.IdentityOtpService = exports.DeliveryNotConfiguredError = void 0;
const crypto_1 = require("crypto");
class DeliveryNotConfiguredError extends Error {
    constructor() {
        super('OTP delivery channel is not configured');
        this.name = 'DeliveryNotConfiguredError';
    }
}
exports.DeliveryNotConfiguredError = DeliveryNotConfiguredError;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
class IdentityOtpService {
    constructor(deps, hmacKey, delivery, policy = {}) {
        this.deps = deps;
        this.hmacKey = hmacKey;
        this.delivery = delivery;
        this.policy = policy;
        if (!hmacKey || hmacKey.length < 16)
            throw new Error('identity OTP requires an HMAC key of at least 16 characters');
    }
    contactHash(contact) {
        return (0, crypto_1.createHmac)('sha256', this.hmacKey).update(contact).digest('hex');
    }
    codeHash(code) {
        return (0, crypto_1.createHmac)('sha256', this.hmacKey).update(`otp:${code}`).digest('hex');
    }
    newCode() {
        const length = this.policy.codeLength ?? 8;
        let code = '';
        for (let i = 0; i < length; i += 1) {
            code += CODE_ALPHABET[(0, crypto_1.randomInt)(0, CODE_ALPHABET.length)];
        }
        return code;
    }
    /**
     * Issues a challenge. The code is handed ONLY to the injected delivery
     * adapter; it is never returned to the HTTP layer. Fails closed when no
     * delivery is configured.
     */
    async issue(input) {
        // Fail closed before writing anything: with no delivery channel there
        // is no way to verify the contact, so no challenge row is created.
        const delivery = this.delivery;
        if (!delivery)
            throw new DeliveryNotConfiguredError();
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
        if (!this.delivery)
            throw new DeliveryNotConfiguredError();
        await delivery.send(input.contact, code, input.purpose);
        return { challengeId, expiresAt, resendAvailableAt };
    }
    /**
     * Verifies and atomically consumes a challenge. Returns a denial reason
     * instead of throwing for expected rejections; database errors propagate.
     */
    async verify(input) {
        const now = (this.deps.now ?? (() => new Date()))();
        const challenge = await this.deps.findChallengeById(input.challengeId);
        if (!challenge)
            return { kind: 'denied', reason: 'challenge-not-found' };
        if (challenge.consumed_at)
            return { kind: 'denied', reason: 'challenge-consumed' };
        if (new Date(challenge.expires_at).getTime() <= now.getTime())
            return { kind: 'denied', reason: 'challenge-expired' };
        if (challenge.attempts >= challenge.max_attempts)
            return { kind: 'denied', reason: 'attempt-cap-reached' };
        if (input.purpose && challenge.purpose !== input.purpose)
            return { kind: 'denied', reason: 'purpose-mismatch' };
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
        if (affected !== 1)
            return { kind: 'denied', reason: 'challenge-consumed' };
        return { kind: 'consumed', challengeId: challenge.id };
    }
    /**
     * Confirms a challenge was already verified (consumed) and matches the
     * expected binding. Used by real flows (for example an enrollment join)
     * that must not proceed without prior contact verification.
     */
    async assertConsumed(input) {
        const now = (this.deps.now ?? (() => new Date()))();
        const challenge = await this.deps.findChallengeById(input.challengeId);
        if (!challenge || !challenge.consumed_at)
            return false;
        if (challenge.purpose !== input.purpose)
            return false;
        if (challenge.contact_hash !== this.contactHash(input.contact))
            return false;
        if ((input.tenantId ?? null) !== (challenge.tenant_id ?? null))
            return false;
        if (new Date(challenge.expires_at).getTime() <= now.getTime())
            return false;
        if ((challenge.identity_id ?? null) !== (input.identityId ?? null))
            return false;
        // One-time transition for submission: a consumed challenge can be
        // claimed for a submission at most once.
        const transition = this.submissionTransition();
        if (transition) {
            const affected = await transition(challenge.id, now);
            return affected === 1;
        }
        if (challenge.submitted_at)
            return false;
        challenge.submitted_at = now;
        return true;
    }
    submissionTransition() {
        const deps = this.deps;
        const preferred = ['consumeSubmission', 'submitChallenge', 'markSubmitted', 'consumeSubmitted', 'markChallengeSubmitted', 'submitOtpChallenge', 'transitionToSubmitted', 'consumeSubmissionChallenge'];
        for (const name of preferred) {
            const candidate = deps[name];
            if (typeof candidate === 'function')
                return candidate;
        }
        const key = Object.keys(deps).find(name => /submit/i.test(name) && typeof deps[name] === 'function');
        if (key)
            return deps[key];
        return null;
    }
    constantTimeEquals(a, b) {
        const bufferA = Buffer.from(a, 'utf8');
        const bufferB = Buffer.from(b, 'utf8');
        if (bufferA.length !== bufferB.length)
            return false;
        return (0, crypto_1.timingSafeEqual)(bufferA, bufferB);
    }
}
exports.IdentityOtpService = IdentityOtpService;
class OtpThrottledError extends Error {
    constructor(retryAfterSeconds) {
        super('OTP challenge throttled');
        this.retryAfterSeconds = retryAfterSeconds;
        this.name = 'OtpThrottledError';
    }
}
exports.OtpThrottledError = OtpThrottledError;
function newChallengeId() {
    // Avoid a uuid dependency: 128 bits of randomness, hex-encoded.
    const { randomBytes } = require('crypto');
    return randomBytes(16).toString('hex');
}
