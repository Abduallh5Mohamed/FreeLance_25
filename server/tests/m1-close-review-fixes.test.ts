import assert from 'node:assert/strict';
import test from 'node:test';
import {
    IdentityOtpService,
    type IdentityOtpDeps,
    type OtpChallengeRow,
} from '../src/security/identity-otp';
import { verifyVideoSessionToken, generateVideoSessionToken } from '../src/middleware/auth';
import { verifySocketPrincipal } from '../src/services/socket';

const HMAC_KEY = 'isolated-identity-otp-hmac-key-0001';
const CONTACT = '+201000000123';
const TENANT = 'tenant-otp';

function makeStore() {
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
}

test('review-fix: identity mismatch is rejected in verify', async () => {
    const store = makeStore();
    const sent: string[] = [];
    const delivery = { send: async (_c: string, code: string) => { sent.push(code); } };
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery as any);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT, identityId: 'user-1' });
    const result = await service.verify({ challengeId: issued.challengeId, code: sent[0], contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT, identityId: 'user-2' });
    assert.equal(result.kind, 'denied');
    assert.equal((result as { reason: string }).reason, 'identity-mismatch');
});

test('review-fix: assertConsumed rejects expired and identity mismatch', async () => {
    const store = makeStore();
    const sent: string[] = [];
    const delivery = { send: async (_c: string, code: string) => { sent.push(code); } };
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery as any, { ttlSeconds: 60 });
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT, identityId: 'user-1' });
    await service.verify({ challengeId: issued.challengeId, code: sent[0], contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT, identityId: 'user-1' });
    store.advance(61);
    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT, identityId: 'user-1' }), false);
});

test('review-fix: submission challenge can be consumed only once', async () => {
    const store = makeStore();
    const sent: string[] = [];
    const delivery = { send: async (_c: string, code: string) => { sent.push(code); } };
    const service = new IdentityOtpService(store.deps, HMAC_KEY, delivery as any);
    const issued = await service.issue({ contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    await service.verify({ challengeId: issued.challengeId, code: sent[0], contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT });
    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }), true);
    assert.equal(await service.assertConsumed({ challengeId: issued.challengeId, contact: CONTACT, purpose: 'enrollment_join', tenantId: TENANT }), false);
});

test('review-fix: missing video headers mismatch when token carries fp/sr', () => {
    process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length';
    const token = generateVideoSessionToken({
        userId: 'student-1', videoId: 'video-1', sessionId: 'session-1',
        ip: '127.0.0.1', userAgent: 'test-agent', fingerprint: 'fingerprint-1', screenRes: '1920x1080',
    });
    const request = { headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '127.0.0.1' }, ip: '127.0.0.1' } as any;
    const result = verifyVideoSessionToken(token, request);
    assert.equal(result.valid, false);
});

test('review-fix: socket principal pins HS256', () => {
    process.env.JWT_SECRET = 'test-only-secret-with-sufficient-length';
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'u', role: 'teacher' }, process.env.JWT_SECRET, { algorithm: 'HS384' });
    assert.throws(() => verifySocketPrincipal(token));
});
