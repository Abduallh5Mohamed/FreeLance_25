import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DeliveryNotConfiguredError,
    IdentityOtpDeps,
    IdentityOtpService,
    OtpChallengeRow,
    OtpThrottledError,
    type OtpDelivery,
} from '../src/security/identity-otp';

/**
 * S2 closure evidence: the contact-verification challenge lifecycle is real
 * server code with an injected store and an injected delivery adapter. The
 * fake delivery only captures the code so tests can prove it is never stored
 * in plaintext and never leaves through any other channel; no test claims a
 * live SMS/email/WhatsApp provider.
 */

const HMAC_KEY = 'isolated-identity-otp-hmac-key-0001';
const CONTACT = '+201000000123';
const TENANT = 'tenant-otp';

const makeStore = () => {
    const rows: OtpChallengeRow[] = [];
    let clock = new Date('2026-10-17T12:00:00.000Z');
    const deps: IdentityOtpDeps = {
        insertChallenge: async (row) => { rows.push({ ...row, created_at: clock.toISOString() } as OtpChallengeRow); },
        findChallengeById: async (id) => rows.find(row => row.id === id) ?? null,
        findLatestActiveChallenge: async (contactHash, purpose, tenantId) => {
            const matches = rows.filter(row => row.contact_hash === contactHash && row.purpose === purpose
                && (row.tenant_id ?? null) === (tenantId ?? null) && row.consumed_at === null
                && new Date(row.expires_at).getTime() > clock.getTime());
            return matches.length ? matches[matches.length - 1] : null;
        },
        incrementAttempts: async (id) => {
            const row = rows.find(item => item.id === id);
            if (row) row.attempts += 1;
        },
        consumeChallenge: async (id, now) => {
            const row = rows.find(item => item.id === id && item.consumed_at === null);
            if (!row) return 0;
            row.consumed_at = now;
            return 1;
        },
        countRecentChallenges: async (contactHash, purpose, since) => rows.filter(row => row.contact_hash === contactHash
            && row.purpose === purpose && new Date(row.created_at ?? 0) >= since).length,
        now: () => clock,
    };
    return { rows, deps, advance: (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); }, now: () => clock };
};

const makeDelivery = () => {
    const sent: { contact: string; code: string; purpose: string }[] = [];
    const delivery: OtpDelivery = {
        send: async (contact, code, purpose) => { sent.push({ contact, code, purpose }); },
    };
    return { sent, delivery };
};

test('S2: issuance delivers a random code and persists only its HMAC', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].contact, CONTACT);
    assert.equal(sent[0].purpose, 'enrollment_join');
    assert.match(sent[0].code, /^[A-Z2-9]{8}$/);
    assert.equal(store.rows.length, 1);
    const stored = store.rows[0];
    assert.notEqual(stored.code_hash, sent[0].code, 'plaintext code must never be stored');
    assert.equal(stored.attempts, 0);
    assert.equal(stored.consumed_at, null);
    assert.equal(stored.tenant_id, TENANT);
    assert.ok(new Date(stored.expires_at).getTime() > store.now().getTime());
    assert.ok(issued.challengeId);
});

test('S2: the correct code consumes the challenge exactly once', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    const first = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.deepEqual(first, { kind: 'consumed', challengeId: issued.challengeId });

    const replay = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(replay.kind, 'denied');
    assert.equal(replay.kind === 'denied' && replay.reason, 'challenge-consumed');
});

test('S2: a wrong code increments attempts and the cap denies further tries', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery, { maxAttempts: 3 });
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const denied = await service.verify({ challengeId: issued.challengeId, code: 'WRONGCOD', contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
        assert.equal(denied.kind === 'denied' && denied.reason, 'code-mismatch');
    }
    const capped = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(capped.kind === 'denied' && capped.reason, 'attempt-cap-reached');
});

test('S2: expired challenges are denied even with the right code', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery, { ttlSeconds: 60 });
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    store.advance(61);
    const result = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(result.kind === 'denied' && result.reason, 'challenge-expired');
});

test('S2: a challenge cannot be reused across contact, purpose or tenant', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    const otherContact = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: '+201000000999', purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(otherContact.kind === 'denied' && otherContact.reason, 'contact-mismatch');

    const otherPurpose = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'password_recovery', tenantId: TENANT });
    assert.equal(otherPurpose.kind === 'denied' && otherPurpose.reason, 'purpose-mismatch');

    const otherTenant = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: 'tenant-other' });
    assert.equal(otherTenant.kind === 'denied' && otherTenant.reason, 'tenant-mismatch');

    // The failed cross-bindings above must not have consumed the challenge.
    const stillValid = await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(stillValid.kind, 'consumed');
});

test('S2: resend cooldown and the per-contact throttle window both fail closed', async () => {
    const store = makeStore();
    const { delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery, { resendCooldownSeconds: 60, throttleWindowSeconds: 600, throttleMaxChallenges: 2 });
    await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    await assert.rejects(
        service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }),
        (error: unknown) => error instanceof OtpThrottledError);

    store.advance(61);
    await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    store.advance(61);
    await assert.rejects(
        service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }),
        (error: unknown) => error instanceof OtpThrottledError);
});

test('S2: absent delivery fails closed without persisting a challenge', async () => {
    const store = makeStore();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, null);
    await assert.rejects(
        service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }),
        (error: unknown) => error instanceof DeliveryNotConfiguredError);
    assert.equal(store.rows.length, 0);
});

test('S2: database failures propagate instead of being reported as success', async () => {
    const store = makeStore();
    const { delivery } = makeDelivery();
    const failing: IdentityOtpDeps = {
        ...store.deps,
        insertChallenge: async () => { throw new Error('ER_LOCK_WAIT_TIMEOUT'); },
    };
    const service = new IdentityOtpService(failing, HMAC_KEY, delivery);
    await assert.rejects(
        service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }),
        /ER_LOCK_WAIT_TIMEOUT/);
});

test('S2: concurrent verification of one challenge yields exactly one success', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    const results = await Promise.all([
        service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }),
        service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }),
    ]);
    assert.equal(results.filter(result => result.kind === 'consumed').length, 1);
    assert.equal(results.filter(result => result.kind === 'denied').length, 1);
});

test('S2: assertConsumed only accepts a consumed, correctly bound challenge', async () => {
    const store = makeStore();
    const { sent, delivery } = makeDelivery();
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });

    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }), false);
    await service.verify({ challengeId: issued.challengeId, code: sent[0].code, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }), true);
    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: '+201000000999', purpose: 'enrollment_join', tenantId: TENANT }), false);
    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: CONTACT, purpose: 'enrollment_join', tenantId: 'tenant-other' }), false);
    assert.equal(await service.assertConsumed({ challengeId: 'missing', contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }), false);
});
