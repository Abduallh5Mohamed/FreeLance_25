/**
 * M7 O9 — hermetic platform MFA tests (RFC 6238 TOTP core, sealing, step-up,
 * lockout, recovery single-use, route authorization). No database, no network.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { NextFunction, Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    DEFAULT_STEPUP_MAX_AGE_SECONDS,
    LOCKOUT_SECONDS,
    MAX_VERIFY_ATTEMPTS,
    MFA_RATE_LIMITS,
    PlatformMfaStore,
    base32Decode,
    generateRecoveryCodes,
    generateTotpSecret,
    hotpAt,
    mfaKeyFromEnv,
    openSealedValue,
    recoveryCodeHash,
    sealValue,
    signStepUpToken,
    stepForTime,
    totpAtStep,
    verifyStepUpToken,
    verifyTotp,
    verifyTotpReplayChecked,
} from '../src/services/platform-mfa';
import { createPlatformMfaRouter } from '../src/routes/platform-mfa';
import { makeRepository, TEST_SECRET, tokenFor } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const TEST_KEY = Buffer.alloc(32, 7);
const ADMIN_A = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
const ADMIN_B = tokenFor({ id: 'admin-b', role: 'admin', tv: 0 });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const SECRET32 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const FIXED_NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// TOTP core (RFC 4226 test vectors, window/replay, sealing, step-up tokens)
// ---------------------------------------------------------------------------

test('hotpAt reproduces the RFC 4226 SHA-1 test vectors', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    assert.equal(hotpAt(secret, 0), '755224');
    assert.equal(hotpAt(secret, 1), '287082');
    assert.equal(hotpAt(secret, 2), '359152');
    assert.equal(hotpAt(secret, 8), '399871');
    assert.equal(hotpAt(secret, 9), '520489');
});

test('base32 roundtrip and TOTP +-1 window with replay checks', () => {
    const secret = generateTotpSecret((length) => Buffer.alloc(length, 11));
    assert.equal(secret.length, 32);
    const parsed = base32Decode(secret);
    assert.equal(parsed.length, 20);
    const step = 100;
    const code = totpAtStep(parsed, step);
    assert.equal(verifyTotp(parsed, code, step).ok, true);
    const adjacent = verifyTotp(parsed, totpAtStep(parsed, step + 1), step);
    assert.equal(adjacent.ok, true);
    if (adjacent.ok) assert.equal(adjacent.step, step + 1);
    assert.equal(verifyTotp(parsed, totpAtStep(parsed, step + 2), step).ok, false);
    assert.equal(verifyTotpReplayChecked(parsed, code, step, step).ok, false);
    const fresh = verifyTotpReplayChecked(parsed, totpAtStep(parsed, step), step, step - 1);
    assert.equal(fresh.ok, true);
});

test('sealing is roundtrippable and fails closed on wrong key or tampering', () => {
    const sealed = sealValue('top-secret-totp', TEST_KEY);
    assert.equal(openSealedValue(sealed, TEST_KEY), 'top-secret-totp');
    assert.throws(() => openSealedValue(sealed, Buffer.alloc(32, 8)));
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    assert.throws(() => openSealedValue(tampered, TEST_KEY));
    assert.equal(mfaKeyFromEnv({} as NodeJS.ProcessEnv), null);
    assert.equal(mfaKeyFromEnv({ MFA_SECRET_KEY: 'short-key' } as unknown as NodeJS.ProcessEnv), null);
    const key = mfaKeyFromEnv({ MFA_SECRET_KEY: 'k'.repeat(60) } as unknown as NodeJS.ProcessEnv);
    assert.ok(key && key.length >= 32);
});

test('step-up tokens verify in-window and reject tampering/foreign users/expiry', () => {
    const token = signStepUpToken('admin-a', 3, TEST_KEY, 1_000_000_000);
    const parsed = verifyStepUpToken(token, {
        expectedUserId: 'admin-a', currentEpoch: 3, key: TEST_KEY,
        nowMs: 1_000_000_000 + DEFAULT_STEPUP_MAX_AGE_SECONDS * 1000 - 1000,
        maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    });
    assert.equal(parsed.ok, true);
    const foreign = verifyStepUpToken(token, {
        expectedUserId: 'admin-b', currentEpoch: 3, key: TEST_KEY, nowMs: 1_000_000_000,
        maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.reason, 'other_user');
    const stale = verifyStepUpToken(token, {
        expectedUserId: 'admin-a', currentEpoch: 4, key: TEST_KEY, nowMs: 1_000_000_000,
        maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, 'stale_epoch');
    const expired = verifyStepUpToken(token, {
        expectedUserId: 'admin-a', currentEpoch: 3, key: TEST_KEY,
        nowMs: 1_000_000_000 + DEFAULT_STEPUP_MAX_AGE_SECONDS * 1000 + 1000,
        maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.reason, 'expired');
    assert.equal(verifyStepUpToken(`${token}x`, {
        expectedUserId: 'admin-a', currentEpoch: 3, key: TEST_KEY, nowMs: 1_000_000_000,
        maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    }).ok, false);
    assert.equal(verifyStepUpToken('garbage', {
        expectedUserId: 'admin-a', currentEpoch: 3, key: TEST_KEY, nowMs: 1_000_000_000,
        maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    }).ok, false);
});

test('recovery codes are fixed width and hashed deterministically', () => {
    const codes = generateRecoveryCodes(undefined, (length) => Buffer.alloc(length, 9));
    assert.equal(codes.length, 10);
    for (const code of codes) assert.ok(/^[0-9a-f]{20}$/.test(code));
    assert.equal(recoveryCodeHash(codes[0]), recoveryCodeHash(codes[0]));
});

// ---------------------------------------------------------------------------
// Hermetic store + route harness
// ---------------------------------------------------------------------------

interface TestRow {
    user_id: string;
    sealed_secret: string | null;
    status: 'pending' | 'active' | 'disabled';
    last_used_step: number;
    failed_attempts: number;
    locked_until: number | null;
    stepup_epoch: number;
}

interface StoreFixture {
    store: PlatformMfaStore;
    rows: Map<string, TestRow>;
    recoveryHashes: Map<string, string[]>;
}

const makeStore = (): StoreFixture => {
    const rows = new Map<string, TestRow>();
    const recoveryHashes = new Map<string, string[]>();
    const store: PlatformMfaStore = {
        findRow: async (userId) => {
            const row = rows.get(String(userId));
            if (!row) return null;
            return {
                user_id: row.user_id,
                sealed_secret: row.sealed_secret,
                status: row.status,
                last_used_step: row.last_used_step,
                failed_attempts: row.failed_attempts,
                locked_until: row.locked_until === null ? null : new Date(row.locked_until).toISOString(),
                stepup_epoch: row.stepup_epoch,
            };
        },
        upsertPendingSecret: async (userId, sealedSecret) => {
            const previous = rows.get(String(userId));
            rows.set(String(userId), {
                user_id: String(userId),
                sealed_secret: sealedSecret,
                status: 'pending',
                last_used_step: 0,
                failed_attempts: 0,
                locked_until: null,
                stepup_epoch: (previous?.stepup_epoch ?? 0) + 1,
            });
        },
        activate: async (userId) => {
            const row = rows.get(String(userId));
            if (row && row.status === 'pending') row.status = 'active';
        },
        markStepUsed: async (userId, step) => {
            const row = rows.get(String(userId));
            if (!row || row.status === 'disabled' || row.last_used_step >= step) return 0;
            row.last_used_step = step;
            return 1;
        },
        recordFailure: async (userId) => {
            const row = rows.get(String(userId));
            if (!row) return false;
            row.failed_attempts += 1;
            if (row.failed_attempts >= MAX_VERIFY_ATTEMPTS) {
                row.locked_until = FIXED_NOW + LOCKOUT_SECONDS * 1000;
                row.failed_attempts = 0;
            }
            return row.locked_until !== null;
        },
        clearFailures: async (userId) => {
            const row = rows.get(String(userId));
            if (row) {
                row.failed_attempts = 0;
                row.locked_until = null;
            }
        },
        saveRecoveryCodeHashes: async (userId, hashes) => {
            recoveryHashes.set(String(userId), [...(recoveryHashes.get(String(userId)) ?? []), ...hashes]);
        },
        consumeRecoveryCode: async (userId, codeHash) => {
            const stored = recoveryHashes.get(String(userId)) ?? [];
            const index = stored.indexOf(codeHash);
            if (index === -1) return 0;
            stored.splice(index, 1);
            recoveryHashes.set(String(userId), stored);
            return 1;
        },
        currentStepupEpoch: async (userId) => rows.get(String(userId))?.stepup_epoch ?? 1,
        bumpStepupEpoch: async (userId) => {
            const row = rows.get(String(userId));
            if (row) row.stepup_epoch += 1;
            return rows.get(String(userId))?.stepup_epoch ?? 1;
        },
        disable: async (userId) => {
            const row = rows.get(String(userId));
            if (row) {
                row.status = 'disabled';
                row.sealed_secret = null;
                row.last_used_step = 0;
                row.stepup_epoch += 1;
            }
        },
    };
    return { store, rows, recoveryHashes };
};

interface AuditEntry {
    action: string;
    actorUserId: string | null;
    resourceId: string;
    reason: string | null;
}

interface RouteFixture {
    router: Router;
    audits: AuditEntry[];
    state: { failAudit: boolean };
}

interface BuildOptions {
    permission?: (userId: string, permission: string) => Promise<boolean>;
    sealKey?: () => Buffer | null;
}

const buildRouter = (store: PlatformMfaStore, options: BuildOptions = {}): RouteFixture => {
    const audits: AuditEntry[] = [];
    const state = { failAudit: false };
    const router: Router = createPlatformMfaRouter({
        db: {
            query: async (): Promise<unknown[]> => [],
            queryOne: async (): Promise<unknown | null> => null,
            execute: async (): Promise<{ affectedRows: number }> => ({ affectedRows: 1 }),
        },
        store,
        authenticate: createAuthenticateToken(makeRepository({
            'admin-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'admin-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        })),
        requirePlatformPermission: (permission) => async (req, res, next) => {
            const user = (req as { user?: { id?: string } }).user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const allowed = options.permission != null
                ? await options.permission(user.id, permission)
                : user.id === 'admin-a';
            if (allowed) return next();
            res.status(403).json({ error: 'Forbidden' });
        },
        recordAudit: async (input) => {
            if (state.failAudit) throw new Error('audit sink down');
            audits.push({
                action: input.action,
                actorUserId: input.actorUserId,
                resourceId: input.resourceId,
                reason: input.reason ?? null,
            });
        },
        sealKey: options.sealKey ?? (() => TEST_KEY),
        now: () => FIXED_NOW,
        rng: (length) => Buffer.alloc(length, 5),
    });
    return { router, audits, state };
};

interface InvokeOptions {
    method: string;
    url: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
}

interface InvokeResponse {
    statusCode?: number;
    body?: unknown;
}

/** Same bounded-poll technique as the harness invokeRoute, plus headers. */
const invoke = async (router: Router, request: InvokeOptions): Promise<InvokeResponse> => {
    let statusCode: number | undefined;
    let body: unknown;
    const response = {
        status(code: number) { statusCode = code; return response; },
        json(payload: unknown) {
            if (statusCode === undefined) statusCode = 200;
            body = payload;
            return response;
        },
        set() { return response; },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: {
            ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
            ...(request.headers ?? {}),
        },
        body: request.body ?? {},
        query: {},
    } as never;
    await (router as unknown as (r: never, s: never, n: NextFunction) => void)(req, response, () => undefined);
    const deadline = Date.now() + 5000;
    while (statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { statusCode, body };
};

interface Seed {
    secret: string;
    epoch: number;
    status?: 'active' | 'pending';
}

const seedRow = (rows: Map<string, TestRow>, userId: string, seed: Seed, locked = false): void => {
    rows.set(userId, {
        user_id: userId,
        sealed_secret: sealValue(seed.secret, TEST_KEY),
        status: seed.status ?? 'active',
        last_used_step: 0,
        failed_attempts: 0,
        locked_until: locked ? FIXED_NOW + LOCKOUT_SECONDS * 1000 : null,
        stepup_epoch: seed.epoch,
    });
};

const codeFor = (secret: string, step: number): string => totpAtStep(base32Decode(secret), step);
const currentStep = stepForTime(FIXED_NOW);

// --- status / authorization ---

test('mfa status: anonymous is 401 with zero store reads; tenant owner is 403', async () => {
    const fixture = makeStore();
    let storeReads = 0;
    const counted: PlatformMfaStore = {
        ...fixture.store,
        findRow: async (userId) => {
            storeReads += 1;
            return fixture.store.findRow(userId);
        },
    };
    const { router } = buildRouter(counted);
    const anonymous = await invoke(router, { method: 'GET', url: '/status' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(storeReads, 0);
    const denied = await invoke(router, { method: 'GET', url: '/status', token: OWNER_A });
    assert.equal(denied.statusCode, 403);
    assert.equal(storeReads, 0);
});

test('mfa status projects enrolled/locked state without secret material', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 2 });
    const { router } = buildRouter(fixture.store);
    const response = await invoke(router, { method: 'GET', url: '/status', token: ADMIN_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { enrolled: boolean; status: string; locked: boolean; locked_until: string | null };
    assert.equal(body.enrolled, true);
    assert.equal(body.status, 'active');
    assert.equal(body.locked, false);
    assert.equal(body.locked_until, null);
    assert.equal(JSON.stringify(body).includes(SECRET32), false);
});

// --- enroll ---

test('mfa enroll: denies anonymous, non-platform and key-unavailable callers', async () => {
    const fixture = makeStore();
    const anonymous = await invoke(buildRouter(fixture.store).router, {
        method: 'POST', url: '/enroll', body: { reason: 'cross attempt one' },
    });
    assert.equal(anonymous.statusCode, 401);
    const deniedRouter = buildRouter(fixture.store, { permission: async () => false }).router;
    const denied = await invoke(deniedRouter, {
        method: 'POST', url: '/enroll', token: ADMIN_A, body: { reason: 'cross attempt one' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(fixture.rows.size, 0);
    const unavailable = await invoke(
        buildRouter(fixture.store, { sealKey: () => null }).router,
        { method: 'POST', url: '/enroll', token: ADMIN_A, body: { reason: 'sealed key unavailable' } },
    );
    assert.equal(unavailable.statusCode, 503);
    assert.equal(fixture.rows.size, 0);
});

test('mfa enroll: validates the reason and is per-user rate limited', async () => {
    const fixture = makeStore();
    const { router } = buildRouter(fixture.store);
    const invalid = await invoke(router, {
        method: 'POST', url: '/enroll', token: ADMIN_A, body: { reason: 'short' },
    });
    assert.equal(invalid.statusCode, 400);
    for (let index = 0; index < MFA_RATE_LIMITS.enroll.max - 1; index += 1) {
        const ok = await invoke(router, {
            method: 'POST', url: '/enroll', token: ADMIN_A,
            body: { reason: 'rotating sealed secret' },
        });
        assert.equal(ok.statusCode, 200);
    }
    const throttled = await invoke(router, {
        method: 'POST', url: '/enroll', token: ADMIN_A,
        body: { reason: 'rotating sealed secret' },
    });
    assert.equal(throttled.statusCode, 429);
});

test('mfa enroll: stores a pending sealed secret; a non-platform admin is refused', async () => {
    const fixture = makeStore();
    const { router, audits } = buildRouter(fixture.store);
    const first = await invoke(router, {
        method: 'POST', url: '/enroll', token: ADMIN_A,
        body: { reason: 'fresh enrollment for a sensitive role' },
    });
    assert.equal(first.statusCode, 200);
    const row = fixture.rows.get('admin-a');
    assert.ok(row);
    assert.equal(row?.status, 'pending');
    const secret = openSealedValue(row?.sealed_secret ?? '', TEST_KEY);
    assert.ok(/^[A-Z2-7]{32}$/.test(secret));
    const otherAdmin = await invoke(router, {
        method: 'POST', url: '/enroll', token: ADMIN_B,
        body: { reason: 'fresh enrollment for a sensitive role' },
    });
    assert.equal(otherAdmin.statusCode, 403);
    assert.equal(fixture.rows.has('admin-b'), false);
    const enrollmentAudits = audits.filter((entry) => entry.action === 'platform_mfa.enrolled');
    assert.equal(enrollmentAudits.length, 1);
    assert.equal(enrollmentAudits[0]?.resourceId, 'admin-a');
});

test('mfa enroll: audit failure aborts the mutation with 500', async () => {
    const fixture = makeStore();
    const { router, state } = buildRouter(fixture.store);
    state.failAudit = true;
    const response = await invoke(router, {
        method: 'POST', url: '/enroll', token: ADMIN_A,
        body: { reason: 'audit failure rollout' },
    });
    assert.equal(response.statusCode, 500);
    state.failAudit = false;
});

// --- verify ---

test('mfa verify: validates the body and denies unknown/absent enrollments', async () => {
    const fixture = makeStore();
    const { router } = buildRouter(fixture.store);
    const missing = await invoke(router, { method: 'POST', url: '/verify', token: ADMIN_A, body: {} });
    assert.equal(missing.statusCode, 400);
    const notEnrolled = await invoke(router, { method: 'POST', url: '/verify', token: ADMIN_A, body: { code: '123456' } });
    assert.equal(notEnrolled.statusCode, 404);
    const nonPlatform = buildRouter(fixture.store, { permission: async () => false }).router;
    const denied = await invoke(nonPlatform, { method: 'POST', url: '/verify', token: ADMIN_A, body: { code: '123456' } });
    assert.equal(denied.statusCode, 403);
});

test('mfa verify: a correct totp code issues a step-up token; the used step cannot replay', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 1 });
    const { router } = buildRouter(fixture.store);
    const code = codeFor(SECRET32, currentStep);
    const response = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A, body: { code },
    });
    assert.equal(response.statusCode, 200);
    const token = (response.body as { step_up_token?: string }).step_up_token ?? '';
    assert.ok(token.startsWith('su1.'));
    const verified = verifyStepUpToken(token, {
        expectedUserId: 'admin-a', currentEpoch: 1, key: TEST_KEY,
        nowMs: FIXED_NOW, maxAgeSeconds: DEFAULT_STEPUP_MAX_AGE_SECONDS,
    });
    assert.equal(verified.ok, true);
    const replay = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A, body: { code },
    });
    assert.equal(replay.statusCode, 400);
});

test('mfa verify: bad codes lock the row for a cooldown', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 1 });
    const { router } = buildRouter(fixture.store);
    for (let index = 0; index < MAX_VERIFY_ATTEMPTS; index += 1) {
        const bad = await invoke(router, {
            method: 'POST', url: '/verify', token: ADMIN_A, body: { code: '111111' },
        });
        assert.equal(bad.statusCode, 400);
    }
    const row = fixture.rows.get('admin-a');
    assert.ok(row && row.locked_until !== null);
    const goodLater = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A,
        body: { code: codeFor(SECRET32, currentStep + 10) },
    });
    assert.equal(goodLater.statusCode, 429);
});

test('mfa verify: pending activation returns recovery codes once and stores hashes only', async () => {
    const pending = makeStore();
    pending.rows.set('admin-a', {
        user_id: 'admin-a',
        sealed_secret: sealValue(SECRET32, TEST_KEY),
        status: 'pending',
        last_used_step: 0,
        failed_attempts: 0,
        locked_until: null,
        stepup_epoch: 1,
    });
    const { router, audits } = buildRouter(pending.store);
    const response = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A,
        body: { code: codeFor(SECRET32, currentStep) },
    });
    assert.equal(response.statusCode, 200);
    const codes = (response.body as { recovery_codes?: string[] }).recovery_codes ?? [];
    assert.equal(codes.length, 10);
    assert.equal(pending.rows.get('admin-a')?.status, 'active');
    assert.ok(audits.some((entry) => entry.action === 'platform_mfa.activated'));
    const stored = pending.recoveryHashes.get('admin-a') ?? [];
    assert.equal(codes.every((code) => stored.includes(recoveryCodeHash(code))), true);
    const again = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A,
        body: { code: codeFor(SECRET32, currentStep) },
    });
    assert.equal(again.statusCode, 400);
});

test('mfa verify: a recovery code is single use across calls', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 1 });
    let counter = 0;
    const codes = generateRecoveryCodes(undefined, (length) => Buffer.alloc(length, (counter += 1) % 256));
    await fixture.store.saveRecoveryCodeHashes('admin-a', codes.map(recoveryCodeHash));
    const { router } = buildRouter(fixture.store);
    const firstUse = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A,
        body: { recovery_code: codes[0] },
    });
    assert.equal(firstUse.statusCode, 200);
    const secondUse = await invoke(router, {
        method: 'POST', url: '/verify', token: ADMIN_A,
        body: { recovery_code: codes[0] },
    });
    assert.equal(secondUse.statusCode, 400);
    assert.equal((fixture.recoveryHashes.get('admin-a') ?? []).includes(recoveryCodeHash(codes[0])), false);
});

// --- disable ---

test('mfa disable: requires the platform permission and a fresh step-up token', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 1 });
    const { router } = buildRouter(fixture.store);
    const withoutToken = await invoke(router, {
        method: 'POST', url: '/disable', token: ADMIN_A,
        body: { reason: 'offboarding this user' },
    });
    assert.equal(withoutToken.statusCode, 403);
    const deniedRouter = buildRouter(fixture.store, { permission: async () => false }).router;
    const denied = await invoke(deniedRouter, {
        method: 'POST', url: '/disable', token: ADMIN_A,
        body: { reason: 'cross attempt on disable' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(fixture.rows.get('admin-a')?.status, 'active');
});

test('mfa disable: with a valid step-up token the row is disabled, audited, and old tokens die', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 1 });
    const token = signStepUpToken('admin-a', 1, TEST_KEY, FIXED_NOW);
    const { router, audits } = buildRouter(fixture.store);
    const response = await invoke(router, {
        method: 'POST', url: '/disable', token: ADMIN_A,
        body: { reason: 'offboarding request validated' },
        headers: { 'x-mfa-step-up': token },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.rows.get('admin-a')?.status, 'disabled');
    assert.equal(fixture.rows.get('admin-a')?.stepup_epoch, 2);
    assert.ok(audits.some((entry) => entry.action === 'platform_mfa.disabled'));
    const stale = await invoke(router, {
        method: 'POST', url: '/disable', token: ADMIN_A,
        body: { reason: 'trying the stale old token' },
        headers: { 'x-mfa-step-up': token },
    });
    assert.notEqual(stale.statusCode, 200);
});

test('mfa disable: a foreign step-up token is rejected without mutation', async () => {
    const fixture = makeStore();
    seedRow(fixture.rows, 'admin-a', { secret: SECRET32, epoch: 1 });
    const foreign = signStepUpToken('admin-b', 1, TEST_KEY, FIXED_NOW);
    const { router } = buildRouter(fixture.store);
    const response = await invoke(router, {
        method: 'POST', url: '/disable', token: ADMIN_A,
        body: { reason: 'foreign token attempt' },
        headers: { 'x-mfa-step-up': foreign },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(fixture.rows.get('admin-a')?.status, 'active');
});

test('mfa disable: an unknown user reaches 404 with no row created', async () => {
    const fixture = makeStore();
    const token = signStepUpToken('admin-a', 1, TEST_KEY, FIXED_NOW);
    const { router } = buildRouter(fixture.store);
    const response = await invoke(router, {
        method: 'POST', url: '/disable', token: ADMIN_A,
        body: { reason: 'no enrollment anyway' },
        headers: { 'x-mfa-step-up': token },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(fixture.rows.size, 0);
});
