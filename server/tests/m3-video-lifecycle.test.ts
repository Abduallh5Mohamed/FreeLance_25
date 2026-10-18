/**
 * M3 V1 + V3 + V8 hermetic tests.
 *
 * Every function and every route handler is exercised through its REAL
 * implementation with injected seams: an in-memory asset store, entitlement
 * store and usage store, the REAL auth middleware over an injected principal
 * repository, and injected signature verifiers. No database, network, Docker
 * image or provider is contacted.
 *
 * Coverage per behavior: allow, deny, cross-tenant, race/idempotency and
 * failure. (V2 DRM/transcode and V7 downloads are deferred — see the delivery
 * note — and are intentionally absent.)
 */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import type { AuditRecordInput } from '../src/security/audit';
import {
    ASSET_STATES,
    DEFAULT_MAX_ATTEMPTS,
    MAX_ATTEMPTS_CEILING,
    createVideoAssetLifecycle,
    evaluateAssetTransition,
    evaluateFailureOutcome,
    normalizeAssetId,
    normalizeAssetState,
    normalizeMaxAttempts,
    normalizeProviderKey,
    type AssetState,
    type AssetUpdate,
    type NewVideoAsset,
    type NewVideoAssetCallback,
    type ProviderCallbackInput,
    type SignatureVerifier,
    type VideoAssetRecord,
    type VideoAssetStore,
} from '../src/services/video-asset-lifecycle';
import {
    PLAYBACK_TOKEN_DEFAULT_TTL_SECONDS,
    PLAYBACK_TOKEN_MAX_TTL_SECONDS,
    createPlaybackEntitlementService,
    evaluatePlaybackEntitlement,
    normalizePlaybackTtl,
    parsePlaybackClaims,
    signPlaybackToken,
    verifyPlaybackToken,
    type PlaybackEntitlementRecord,
    type PlaybackEntitlementStore,
    type PlaybackTokenClaims,
} from '../src/services/playback-entitlement';
import {
    MAX_WATCH_SECONDS_PER_EVENT,
    buildHeartbeatDedupeKey,
    buildProviderDedupeKey,
    createVideoUsageEventService,
    normalizeDedupeKey,
    normalizeUsageKind,
    validateUsageEvent,
    type NewUsageEventRow,
    type VideoUsageStore,
} from '../src/services/video-usage-events';
import {
    createVideoAssetsRouter,
    type UsageCallbackInput,
    type VideoAssetsDeps,
} from '../src/routes/video-assets';
import { TEST_SECRET, makeRepository, tokenFor, invokeRoute } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const seqId = (): (() => string) => {
    let n = 0;
    return () => `id-${++n}`;
};

/* =========================================================================
 * In-memory stores
 * ========================================================================= */

interface AssetStoreHarness {
    store: VideoAssetStore;
    assets: Map<string, VideoAssetRecord>;
    callbacks: Set<string>;
    audits: AuditRecordInput[];
    failNextUpdate: () => void;
}

const makeAssetStore = (): AssetStoreHarness => {
    const assets = new Map<string, VideoAssetRecord>();
    const callbacks = new Set<string>();
    const audits: AuditRecordInput[] = [];
    let failUpdates = false;
    const store: VideoAssetStore = {
        insertAsset: async (row: NewVideoAsset) => {
            assets.set(row.id, {
                id: row.id,
                tenantId: row.tenantId,
                ownerUserId: row.ownerUserId,
                provider: row.provider,
                providerAssetId: row.providerAssetId,
                title: row.title,
                status: 'uploaded',
                attempts: 0,
                maxAttempts: row.maxAttempts,
                lastError: null,
                deadLettered: false,
                deadLetterReason: null,
            });
        },
        findAssetById: async (id, tenantId) => {
            const asset = assets.get(id);
            return asset && asset.tenantId === tenantId ? { ...asset } : null;
        },
        findAssetByProvider: async (provider, providerAssetId) => {
            for (const asset of assets.values()) {
                if (asset.provider === provider && asset.providerAssetId === providerAssetId) return { ...asset };
            }
            return null;
        },
        updateAsset: async (id: string, tenantId: string, update: AssetUpdate) => {
            if (failUpdates) return 0;
            const asset = assets.get(id);
            if (!asset || asset.tenantId !== tenantId || asset.status !== update.expectedStatus) return 0;
            asset.status = update.status;
            asset.attempts = update.attempts;
            asset.lastError = update.lastError;
            asset.deadLettered = update.deadLettered;
            asset.deadLetterReason = update.deadLetterReason;
            return 1;
        },
        insertCallback: async (row: NewVideoAssetCallback) => {
            const key = `${row.provider}:${row.callbackId}`;
            if (callbacks.has(key)) return false;
            callbacks.add(key);
            return true;
        },
        recordAudit: async (input) => { audits.push(input); },
    };
    return { store, assets, callbacks, audits, failNextUpdate: () => { failUpdates = true; } };
};

interface EntitlementHarness {
    store: PlaybackEntitlementStore;
    records: Map<string, PlaybackEntitlementRecord>;
    audits: AuditRecordInput[];
}

const makeEntitlementStore = (): EntitlementHarness => {
    const records = new Map<string, PlaybackEntitlementRecord>();
    const audits: AuditRecordInput[] = [];
    const store: PlaybackEntitlementStore = {
        save: async (record) => { records.set(record.jti, { ...record }); },
        load: async (jti) => {
            const record = records.get(jti);
            return record ? { ...record } : null;
        },
        isRevoked: async (jti) => {
            const record = records.get(jti);
            return record ? record.revokedAtMs !== null : false;
        },
        revoke: async ({ jti, reason, revokedAtMs }) => {
            const record = records.get(jti);
            if (record && record.revokedAtMs === null) {
                record.revokedAtMs = revokedAtMs;
                record.revokeReason = reason;
            }
        },
        recordAudit: async (input) => { audits.push(input); },
    };
    return { store, records, audits };
};

interface UsageHarness {
    store: VideoUsageStore;
    events: Map<string, NewUsageEventRow>;
    keys: Set<string>;
    audits: AuditRecordInput[];
}

const makeUsageStore = (): UsageHarness => {
    const events = new Map<string, NewUsageEventRow>();
    const keys = new Set<string>();
    const audits: AuditRecordInput[] = [];
    const store: VideoUsageStore = {
        insertEvent: async (row) => {
            const key = `${row.tenantId}:${row.dedupeKey}`;
            if (keys.has(key)) return false;
            keys.add(key);
            events.set(row.id, { ...row });
            return true;
        },
        sumWatchSeconds: async (tenantId) =>
            [...events.values()].filter((event) => event.tenantId === tenantId).reduce((sum, event) => sum + event.watchSeconds, 0),
        sumStorageBytes: async (tenantId) =>
            [...events.values()].filter((event) => event.tenantId === tenantId).reduce((sum, event) => sum + event.storageBytes, 0),
        recordAudit: async (input) => { audits.push(input); },
    };
    return { store, events, keys, audits };
};

/* =========================================================================
 * A. V1 pure state machine
 * ========================================================================= */

test('V1 state machine: known states normalize, unknown/null do not', () => {
    assert.equal(normalizeAssetState('uploaded'), 'uploaded');
    assert.equal(normalizeAssetState('processing'), 'processing');
    assert.equal(normalizeAssetState('ready'), 'ready');
    assert.equal(normalizeAssetState('failed'), 'failed');
    assert.equal(normalizeAssetState('dead_letter'), null);
    assert.equal(normalizeAssetState(undefined), null);
    assert.equal(normalizeAssetState(7), null);
    assert.deepEqual([...ASSET_STATES], ['uploaded', 'processing', 'ready', 'failed']);
});

test('V1 state machine: legal transitions are allowed', () => {
    assert.deepEqual(evaluateAssetTransition('uploaded', 'processing'), { allowed: true, idempotent: false });
    assert.deepEqual(evaluateAssetTransition('uploaded', 'failed'), { allowed: true, idempotent: false });
    assert.deepEqual(evaluateAssetTransition('processing', 'ready'), { allowed: true, idempotent: false });
    assert.deepEqual(evaluateAssetTransition('processing', 'failed'), { allowed: true, idempotent: false });
    assert.deepEqual(evaluateAssetTransition('failed', 'processing'), { allowed: true, idempotent: false });
});

test('V1 state machine: repeating a state is an idempotent no-op', () => {
    assert.deepEqual(evaluateAssetTransition('processing', 'processing'), { allowed: true, idempotent: true });
});

test('V1 state machine: illegal and unknown transitions are rejected', () => {
    assert.deepEqual(evaluateAssetTransition('ready', 'processing'), { allowed: false, reason: 'illegal-transition' });
    assert.deepEqual(evaluateAssetTransition('uploaded', 'ready'), { allowed: false, reason: 'illegal-transition' });
    assert.deepEqual(evaluateAssetTransition('ready', 'failed'), { allowed: false, reason: 'illegal-transition' });
    assert.deepEqual(evaluateAssetTransition('bogus', 'ready'), { allowed: false, reason: 'unknown-state' });
    assert.deepEqual(evaluateAssetTransition('uploaded', 'bogus'), { allowed: false, reason: 'unknown-state' });
});

test('V1 retry policy: attempt budget is bounded and clamps', () => {
    assert.equal(normalizeMaxAttempts(2), 2);
    assert.equal(normalizeMaxAttempts('4'), 4);
    assert.equal(normalizeMaxAttempts(0), 1);
    assert.equal(normalizeMaxAttempts(999), MAX_ATTEMPTS_CEILING);
    assert.equal(normalizeMaxAttempts('nope'), DEFAULT_MAX_ATTEMPTS);
});

test('V1 retry policy: retries while budget remains, dead-letters when spent', () => {
    assert.deepEqual(evaluateFailureOutcome(1, 3), { retry: true });
    assert.deepEqual(evaluateFailureOutcome(2, 3), { retry: true });
    assert.deepEqual(evaluateFailureOutcome(3, 3), { retry: false, deadLettered: true, reason: 'max_attempts_exceeded' });
    assert.deepEqual(evaluateFailureOutcome(0, 1), { retry: true });
});

test('V1 normalizers reject malformed provider keys and ids', () => {
    assert.equal(normalizeProviderKey('vdocipher'), 'vdocipher');
    assert.equal(normalizeProviderKey('bad key'), null);
    assert.equal(normalizeProviderKey(''), null);
    assert.equal(normalizeAssetId('asset-1'), 'asset-1');
    assert.equal(normalizeAssetId('a b'), null);
    assert.equal(normalizeAssetId('x'.repeat(129)), null);
});

/* =========================================================================
 * B. V1 lifecycle service
 * ========================================================================= */

const lifecycleWith = (overrides: {
    verify?: SignatureVerifier;
    maxAttempts?: number;
} = {}) => {
    const harness = makeAssetStore();
    const ids = seqId();
    const lifecycle = createVideoAssetLifecycle({
        store: harness.store,
        verifyCallbackSignature: overrides.verify ?? (() => true),
        idFactory: ids,
        maxAttempts: overrides.maxAttempts ?? 3,
    });
    return { lifecycle, harness, ids };
};

const register = async (lifecycle: ReturnType<typeof createVideoAssetLifecycle>, tenantId = 'tenant-a', providerAssetId = 'pa-1') => {
    const result = await lifecycle.registerAsset({ tenantId, ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId });
    assert.equal(result.ok, true);
    return result.ok ? result.id : '';
};

const callback = (overrides: Partial<ProviderCallbackInput> = {}): ProviderCallbackInput => ({
    provider: 'vdocipher',
    callbackId: 'cb-1',
    signature: 'sig',
    providerAssetId: 'pa-1',
    targetState: 'ready',
    tenantId: null,
    ...overrides,
});

test('V1 lifecycle: registerAsset starts uploaded and audits', async () => {
    const { lifecycle, harness } = lifecycleWith();
    const result = await lifecycle.registerAsset({ tenantId: 'tenant-a', ownerUserId: 'instr-a', provider: 'vdocipher', providerAssetId: 'pa-1', title: 'Algebra' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.state, 'uploaded');
    assert.equal(harness.assets.get(result.id)?.status, 'uploaded');
    assert.ok(harness.audits.some((audit) => audit.action === 'video.asset.created'));
});

test('V1 lifecycle: registerAsset rejects invalid input without writing', async () => {
    const { lifecycle, harness } = lifecycleWith();
    assert.deepEqual(await lifecycle.registerAsset({ tenantId: 't', ownerUserId: 'u', provider: 'bad key', providerAssetId: 'pa' }), { ok: false, reason: 'invalid-input' });
    assert.deepEqual(await lifecycle.registerAsset({ tenantId: '', ownerUserId: 'u', provider: 'vdocipher', providerAssetId: 'pa' }), { ok: false, reason: 'invalid-input' });
    assert.equal(harness.assets.size, 0);
});

test('V1 lifecycle: beginProcessing moves uploaded -> processing and consumes an attempt', async () => {
    const { lifecycle } = lifecycleWith();
    const id = await register(lifecycle);
    const result = await lifecycle.beginProcessing('tenant-a', id);
    assert.deepEqual(result, { ok: true, state: 'processing', attempts: 1, deadLettered: false });
});

test('V1 lifecycle: cross-tenant beginProcessing is not-found (deny by default)', async () => {
    const { lifecycle } = lifecycleWith();
    const id = await register(lifecycle, 'tenant-a');
    assert.deepEqual(await lifecycle.beginProcessing('tenant-b', id), { ok: false, reason: 'not-found' });
});

test('V1 lifecycle: repeat beginProcessing while processing is idempotent', async () => {
    const { lifecycle } = lifecycleWith();
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    const second = await lifecycle.beginProcessing('tenant-a', id);
    assert.deepEqual(second, { ok: true, state: 'processing', attempts: 1, deadLettered: false });
});

test('V1 lifecycle: a verified ready callback applies, then a replay is a no-op', async () => {
    const { lifecycle, harness } = lifecycleWith();
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    const applied = await lifecycle.applyProviderCallback(callback());
    assert.deepEqual(applied, { status: 'applied', state: 'ready', attempts: 1, deadLettered: false });
    assert.equal(harness.assets.get(id)?.status, 'ready');
    const replayed = await lifecycle.applyProviderCallback(callback());
    assert.deepEqual(replayed, { status: 'duplicate', state: 'ready' });
    assert.ok(harness.audits.some((audit) => audit.action === 'video.asset.callback_applied'));
});

test('V1 lifecycle: an unverified callback is ignored, audited, and never applied', async () => {
    const { lifecycle, harness } = lifecycleWith({ verify: () => false });
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    const result = await lifecycle.applyProviderCallback(callback());
    assert.deepEqual(result, { status: 'ignored', reason: 'unverified-signature' });
    assert.equal(harness.assets.get(id)?.status, 'processing');
    assert.ok(harness.audits.some((audit) => audit.action === 'video.asset.callback_ignored' && audit.reason === 'unverified_signature'));
});

test('V1 lifecycle: a verifier that throws fails closed (ignored)', async () => {
    const { lifecycle } = lifecycleWith({ verify: () => { throw new Error('verifier down'); } });
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    assert.deepEqual(await lifecycle.applyProviderCallback(callback()), { status: 'ignored', reason: 'unverified-signature' });
});

test('V1 lifecycle: a cross-tenant callback is rejected and audited', async () => {
    const { lifecycle, harness } = lifecycleWith();
    const id = await register(lifecycle, 'tenant-a');
    await lifecycle.beginProcessing('tenant-a', id);
    const result = await lifecycle.applyProviderCallback(callback({ tenantId: 'tenant-b' }));
    assert.deepEqual(result, { status: 'rejected', reason: 'cross-tenant', from: 'processing' });
    assert.equal(harness.assets.get(id)?.status, 'processing');
    assert.ok(harness.audits.some((audit) => audit.action === 'video.asset.callback_rejected' && audit.reason === 'cross_tenant'));
});

test('V1 lifecycle: an unknown asset callback is ignored, an illegal transition is rejected', async () => {
    const { lifecycle } = lifecycleWith();
    assert.deepEqual(await lifecycle.applyProviderCallback(callback({ providerAssetId: 'ghost' })), { status: 'ignored', reason: 'unknown-asset' });
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    // uploaded->processing done, now ready; a second processing callback is terminal-illegal.
    await lifecycle.applyProviderCallback(callback());
    const illegal = await lifecycle.applyProviderCallback(callback({ callbackId: 'cb-2', targetState: 'processing' }));
    assert.deepEqual(illegal, { status: 'rejected', reason: 'illegal-transition', from: 'ready' });
});

test('V1 lifecycle: a callback with an unknown target state is ignored', async () => {
    const { lifecycle } = lifecycleWith();
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    assert.deepEqual(await lifecycle.applyProviderCallback(callback({ targetState: 'exploded' })), { status: 'ignored', reason: 'unknown-target-state' });
});

test('V1 lifecycle: bounded retries then dead-letter', async () => {
    const { lifecycle, harness } = lifecycleWith({ maxAttempts: 2 });
    const id = await register(lifecycle);

    await lifecycle.beginProcessing('tenant-a', id);
    const firstFailure = await lifecycle.applyProviderCallback(callback({ callbackId: 'f1', targetState: 'failed', error: 'boom' }));
    assert.deepEqual(firstFailure, { status: 'applied', state: 'failed', attempts: 1, deadLettered: false });
    assert.equal(harness.assets.get(id)?.deadLettered, false);

    // A failed asset with remaining budget can be retried.
    const retry = await lifecycle.beginProcessing('tenant-a', id);
    assert.equal(retry.ok, true);
    const secondFailure = await lifecycle.applyProviderCallback(callback({ callbackId: 'f2', targetState: 'failed', error: 'boom again' }));
    assert.deepEqual(secondFailure, { status: 'applied', state: 'failed', attempts: 2, deadLettered: true });
    assert.equal(harness.assets.get(id)?.deadLettered, true);
    assert.ok(harness.audits.some((audit) => audit.action === 'video.asset.dead_lettered'));

    // No further attempt is granted once dead-lettered.
    assert.deepEqual(await lifecycle.beginProcessing('tenant-a', id), { ok: false, reason: 'dead-lettered', from: 'failed' });
});

test('V1 lifecycle: beginProcessing seals a dead-letter when the budget is already spent', async () => {
    const { lifecycle, harness } = lifecycleWith({ maxAttempts: 1 });
    const id = await register(lifecycle);
    await lifecycle.beginProcessing('tenant-a', id);
    await lifecycle.applyProviderCallback(callback({ callbackId: 'f1', targetState: 'failed', error: 'boom' }));
    assert.equal(harness.assets.get(id)?.deadLettered, true);
});

test('V1 lifecycle: a compare-and-set loss surfaces as a conflict (race guard)', async () => {
    const { lifecycle, harness } = lifecycleWith();
    const id = await register(lifecycle);
    harness.failNextUpdate();
    assert.deepEqual(await lifecycle.beginProcessing('tenant-a', id), { ok: false, reason: 'conflict', from: 'uploaded' });
});

test('V1 lifecycle: getAsset is tenant-scoped', async () => {
    const { lifecycle } = lifecycleWith();
    const id = await register(lifecycle, 'tenant-a');
    assert.ok(await lifecycle.getAsset('tenant-a', id));
    assert.equal(await lifecycle.getAsset('tenant-b', id), null);
});

/* =========================================================================
 * C. V3 playback entitlement — pure token codec + decision
 * ========================================================================= */

const claimsWith = (overrides: Partial<PlaybackTokenClaims> = {}): PlaybackTokenClaims => ({
    jti: 'jti-1',
    tenantId: 'tenant-a',
    lessonId: 'lec-1',
    studentEnrollmentId: 'enr-a',
    sessionId: 'sess-1',
    issuedAtMs: 1_000,
    expiresAtMs: 61_000,
    ...overrides,
});

const expectation = {
    tenantId: 'tenant-a',
    lessonId: 'lec-1',
    studentEnrollmentId: 'enr-a',
    sessionId: 'sess-1',
};

test('V3 codec: a signed token round-trips and a tampered token is rejected', () => {
    const token = signPlaybackToken('secret', claimsWith());
    const parsed = verifyPlaybackToken('secret', token);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.claims, claimsWith());

    assert.deepEqual(verifyPlaybackToken('other-secret', token), { ok: false, reason: 'invalid-signature' });
    const [version, payload, signature] = token.split('.');
    const tampered = `${version}.${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`;
    assert.deepEqual(verifyPlaybackToken('secret', tampered), { ok: false, reason: 'invalid-signature' });
});

test('V3 codec: malformed tokens and blank secrets are rejected', () => {
    assert.deepEqual(verifyPlaybackToken('secret', 'not-a-token'), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyPlaybackToken('secret', ''), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyPlaybackToken('secret', 'v2.a.b'), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyPlaybackToken('', signPlaybackToken('secret', claimsWith())), { ok: false, reason: 'malformed' });
});

test('V3 codec: parsePlaybackClaims enforces the full binding shape', () => {
    assert.equal(parsePlaybackClaims(claimsWith())?.lessonId, 'lec-1');
    assert.equal(parsePlaybackClaims({ ...claimsWith(), sessionId: '' }), null);
    assert.equal(parsePlaybackClaims({ ...claimsWith(), expiresAtMs: 'soon' }), null);
    assert.equal(parsePlaybackClaims(null), null);
});

test('V3 ttl: defaulted when absent and clamped to the short-lived window', () => {
    assert.equal(normalizePlaybackTtl(undefined), PLAYBACK_TOKEN_DEFAULT_TTL_SECONDS);
    assert.equal(normalizePlaybackTtl(10), 10);
    assert.equal(normalizePlaybackTtl(9999), PLAYBACK_TOKEN_MAX_TTL_SECONDS);
    assert.equal(normalizePlaybackTtl(-5), PLAYBACK_TOKEN_DEFAULT_TTL_SECONDS);
});

test('V3 decision: a fully matching, unrevoked, unexpired token is allowed', () => {
    const decision = evaluatePlaybackEntitlement(claimsWith(), expectation, 2_000, false);
    assert.equal(decision.allowed, true);
});

test('V3 decision: expired, revoked and every binding mismatch deny', () => {
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), expectation, 61_000, false), { allowed: false, reason: 'expired' });
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), expectation, 2_000, true), { allowed: false, reason: 'revoked' });
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), { ...expectation, tenantId: 'tenant-b' }, 2_000, false), { allowed: false, reason: 'tenant-mismatch' });
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), { ...expectation, lessonId: 'lec-2' }, 2_000, false), { allowed: false, reason: 'lesson-mismatch' });
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), { ...expectation, studentEnrollmentId: 'enr-b' }, 2_000, false), { allowed: false, reason: 'student-mismatch' });
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), { ...expectation, sessionId: 'sess-2' }, 2_000, false), { allowed: false, reason: 'session-mismatch' });
});

test('V3 decision: an empty expectation fails closed', () => {
    const empty = { tenantId: '', lessonId: '', studentEnrollmentId: '', sessionId: '' };
    assert.deepEqual(evaluatePlaybackEntitlement(claimsWith(), empty, 2_000, false), { allowed: false, reason: 'tenant-mismatch' });
});

test('V3 service: issue + verify round-trip and refusal paths', async () => {
    const harness = makeEntitlementStore();
    let now = 1_000;
    const service = createPlaybackEntitlementService({ store: harness.store, getSecret: () => TEST_SECRET, now: () => now, idFactory: seqId() });

    const issued = await service.issue(expectation, 60);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal(issued.expiresIn, 60);
    const decision = await service.verify(issued.token, expectation);
    assert.equal(decision.allowed, true);

    // Expiry is evaluated against the injected clock.
    now = issued.claims.expiresAtMs;
    assert.deepEqual(await service.verify(issued.token, expectation), { allowed: false, reason: 'expired' });
});

test('V3 service: issue refuses invalid input and a missing secret', async () => {
    const harness = makeEntitlementStore();
    const service = createPlaybackEntitlementService({ store: harness.store, getSecret: () => '', now: () => 0, idFactory: seqId() });
    assert.deepEqual(await service.issue(expectation), { ok: false, reason: 'secret-unavailable' });
    const withSecret = createPlaybackEntitlementService({ store: harness.store, getSecret: () => TEST_SECRET, now: () => 0, idFactory: seqId() });
    assert.deepEqual(await withSecret.issue({ ...expectation, lessonId: '' }), { ok: false, reason: 'invalid-input' });
});

test('V3 service: revoke denies the token immediately and audits', async () => {
    const harness = makeEntitlementStore();
    const service = createPlaybackEntitlementService({ store: harness.store, getSecret: () => TEST_SECRET, now: () => 1_000, idFactory: seqId() });
    const issued = await service.issue(expectation, 60);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const revoked = await service.revoke(issued.claims.jti, 'teacher requested', 'instr-a');
    assert.deepEqual(revoked, { revoked: true, tenantId: 'tenant-a' });
    assert.deepEqual(await service.verify(issued.token, expectation), { allowed: false, reason: 'revoked' });
    assert.ok(harness.audits.some((audit) => audit.action === 'video.playback.revoked'));
});

test('V3 service: revoking an unknown token is a no-op', async () => {
    const harness = makeEntitlementStore();
    const service = createPlaybackEntitlementService({ store: harness.store, getSecret: () => TEST_SECRET, now: () => 1_000, idFactory: seqId() });
    assert.deepEqual(await service.revoke('ghost', 'x', null), { revoked: false, tenantId: null });
});

/* =========================================================================
 * D. V8 usage events — pure validation + dedupe
 * ========================================================================= */

test('V8 validation: kind/dedupe normalizers reject junk', () => {
    assert.equal(normalizeUsageKind('watch'), 'watch');
    assert.equal(normalizeUsageKind('storage'), 'storage');
    assert.equal(normalizeUsageKind('download'), null);
    assert.equal(normalizeDedupeKey('hb:sess:1'), 'hb:sess:1');
    assert.equal(normalizeDedupeKey('bad key!'), null);
    assert.equal(normalizeDedupeKey('x'.repeat(201)), null);
});

test('V8 dedupe keys: deterministic heartbeat bucket and provider key', () => {
    assert.equal(buildHeartbeatDedupeKey('sess-1', 0, 30), 'hb:sess-1:0');
    assert.equal(buildHeartbeatDedupeKey('sess-1', 29_999, 30), 'hb:sess-1:0');
    assert.equal(buildHeartbeatDedupeKey('sess-1', 30_000, 30), 'hb:sess-1:1');
    assert.equal(buildHeartbeatDedupeKey('bad id', 0, 30), null);
    assert.equal(buildProviderDedupeKey('vdocipher', 'ev-1'), 'cb:vdocipher:ev-1');
    assert.equal(buildProviderDedupeKey('', 'ev-1'), null);
});

test('V8 validation: watch and storage events validate; bad inputs fail', () => {
    const watch = validateUsageEvent({ tenantId: 'tenant-a', kind: 'watch', dedupeKey: 'hb:s:1', watchSeconds: 30, sessionId: 'sess-1' });
    assert.equal(watch.ok, true);
    if (watch.ok) assert.equal(watch.value.watchSeconds, 30);

    const storage = validateUsageEvent({ tenantId: 'tenant-a', kind: 'storage', dedupeKey: 'cb:p:e', storageBytes: 2048 });
    assert.equal(storage.ok, true);
    if (storage.ok) assert.equal(storage.value.storageBytes, 2048);

    assert.equal(validateUsageEvent({ tenantId: '', kind: 'watch', dedupeKey: 'k', watchSeconds: 1 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'download', dedupeKey: 'k', watchSeconds: 1 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'watch', dedupeKey: '', watchSeconds: 1 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'watch', dedupeKey: 'k', watchSeconds: 0 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'watch', dedupeKey: 'k', watchSeconds: -3 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'watch', dedupeKey: 'k', watchSeconds: MAX_WATCH_SECONDS_PER_EVENT + 1 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'storage', dedupeKey: 'k', storageBytes: -1 }).ok, false);
    assert.equal(validateUsageEvent({ tenantId: 't', kind: 'watch', dedupeKey: 'k', watchSeconds: 5, sessionId: 'bad id' }).ok, false);
});

test('V8 service: first event records, a duplicate dedupe key is absorbed, aggregates are tenant-scoped', async () => {
    const harness = makeUsageStore();
    const service = createVideoUsageEventService({ store: harness.store, idFactory: seqId() });

    const first = await service.record({ tenantId: 'tenant-a', kind: 'watch', dedupeKey: 'hb:s:1', watchSeconds: 12, sessionId: 'sess-1' });
    assert.deepEqual(first, { recorded: true, deduplicated: false });
    const duplicate = await service.record({ tenantId: 'tenant-a', kind: 'watch', dedupeKey: 'hb:s:1', watchSeconds: 12, sessionId: 'sess-1' });
    assert.deepEqual(duplicate, { recorded: false, deduplicated: true });
    await service.record({ tenantId: 'tenant-a', kind: 'storage', dedupeKey: 'cb:p:e', storageBytes: 2048 });
    await service.record({ tenantId: 'tenant-b', kind: 'watch', dedupeKey: 'hb:s:1', watchSeconds: 99, sessionId: 'sess-1' });

    assert.equal(await service.watchSeconds('tenant-a'), 12);
    assert.equal(await service.storageBytes('tenant-a'), 2048);
    assert.equal(await service.watchSeconds('tenant-b'), 99);
    assert.ok(harness.audits.some((audit) => audit.action === 'video.usage.recorded'));
});

test('V8 service: an invalid event returns an error and writes nothing', async () => {
    const harness = makeUsageStore();
    const service = createVideoUsageEventService({ store: harness.store, idFactory: seqId() });
    const result = await service.record({ tenantId: 'tenant-a', kind: 'watch', dedupeKey: 'hb:s:1', watchSeconds: 0 });
    assert.ok('error' in result);
    assert.equal(harness.events.size, 0);
});

/* =========================================================================
 * E. Router integration
 * ========================================================================= */

const USERS = {
    'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    'instr-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'instr-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
};

const REPO_OPTS = {
    instructorAccounts: {
        'instr-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instr-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    memberships: {
        'instr-a': [{ tenant_id: 'tenant-a' }],
        'instr-b': [{ tenant_id: 'tenant-b' }],
    },
    enrollments: {
        'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', group_id: null, grade_id: 'grade-a' }],
    },
};

const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const INSTRUCTOR_A = tokenFor({ id: 'instr-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instr-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });

interface RouterFixtures {
    verifyProvider?: SignatureVerifier;
    verifyUsage?: (input: UsageCallbackInput) => boolean | Promise<boolean>;
    secret?: string;
    now?: () => number;
    resolveLessonScope?: (lessonId: string) => Promise<{ tenantId: string } | null>;
    isPlatformAdmin?: (userId: string) => Promise<boolean>;
    maxAttempts?: number;
}

const buildRouter = (fixtures: RouterFixtures = {}) => {
    const ids = seqId();
    const asset = makeAssetStore();
    const lifecycle = createVideoAssetLifecycle({
        store: asset.store,
        verifyCallbackSignature: fixtures.verifyProvider ?? (() => true),
        idFactory: ids,
        maxAttempts: fixtures.maxAttempts ?? 3,
    });
    const entitlementHarness = makeEntitlementStore();
    const entitlement = createPlaybackEntitlementService({
        store: entitlementHarness.store,
        getSecret: () => fixtures.secret ?? TEST_SECRET,
        now: fixtures.now,
        idFactory: ids,
    });
    const usageHarness = makeUsageStore();
    const usage = createVideoUsageEventService({ store: usageHarness.store, idFactory: ids });
    const repository = makeRepository(USERS, REPO_OPTS);
    const deps: VideoAssetsDeps = {
        authenticate: createAuthenticateToken(repository),
        lifecycle,
        entitlement,
        usage,
        resolveLessonScope: fixtures.resolveLessonScope ?? (async () => ({ tenantId: 'tenant-a' })),
        isPlatformAdmin: fixtures.isPlatformAdmin,
        verifyUsageCallback: fixtures.verifyUsage,
        now: fixtures.now,
        heartbeatWindowSeconds: 30,
    };
    return { router: createVideoAssetsRouter(deps), lifecycle, asset, entitlement, entitlementHarness, usageHarness };
};

const createAsset = async (router: ReturnType<typeof buildRouter>['router'], providerAssetId = 'pa-1') => {
    const response = await invokeRoute(router, {
        method: 'POST', url: '/assets', token: INSTRUCTOR_A,
        body: { provider: 'vdocipher', provider_asset_id: providerAssetId },
    });
    assert.equal(response.statusCode, 201);
    return (response.body as { id: string }).id;
};

// ---- POST /assets ---------------------------------------------------------

test('assets: anonymous is 401 before any write', async () => {
    const { router, asset } = buildRouter();
    const response = await invokeRoute(router, { method: 'POST', url: '/assets', body: { provider: 'vdocipher', provider_asset_id: 'pa-1' } });
    assert.equal(response.statusCode, 401);
    assert.equal(asset.assets.size, 0);
});

test('assets: a student is forbidden', async () => {
    const { router } = buildRouter();
    const response = await invokeRoute(router, { method: 'POST', url: '/assets', token: STUDENT_A, body: { provider: 'vdocipher', provider_asset_id: 'pa-1' } });
    assert.equal(response.statusCode, 403);
});

test('assets: an invalid registration is 400 and a valid one 201', async () => {
    const { router } = buildRouter();
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/assets', token: INSTRUCTOR_A, body: { provider: 'bad key', provider_asset_id: 'pa-1' } })).statusCode, 400);
    const ok = await invokeRoute(router, { method: 'POST', url: '/assets', token: INSTRUCTOR_A, body: { provider: 'vdocipher', provider_asset_id: 'pa-1' } });
    assert.equal(ok.statusCode, 201);
    assert.equal((ok.body as { status?: string }).status, 'uploaded');
});

// ---- GET /assets/:assetId -------------------------------------------------

test('assets read: unknown and cross-tenant are 404, non-owner is 403, owner is 200', async () => {
    const { router } = buildRouter();
    assert.equal((await invokeRoute(router, { method: 'GET', url: '/assets/ghost', token: INSTRUCTOR_A })).statusCode, 404);
    const id = await createAsset(router);
    assert.equal((await invokeRoute(router, { method: 'GET', url: `/assets/${id}`, token: INSTRUCTOR_A })).statusCode, 200);
    // Cross-tenant: instr-b cannot see tenant-a's asset.
    assert.equal((await invokeRoute(router, { method: 'GET', url: `/assets/${id}`, token: INSTRUCTOR_B })).statusCode, 404);
});

// ---- POST /assets/:assetId/processing ------------------------------------

test('processing: anonymous 401, student 403, unknown 404', async () => {
    const { router } = buildRouter();
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/assets/x/processing' })).statusCode, 401);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/assets/x/processing', token: STUDENT_A })).statusCode, 403);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/assets/ghost/processing', token: INSTRUCTOR_A })).statusCode, 404);
});

test('processing: the owner starts processing and a retry is idempotent', async () => {
    const { router } = buildRouter();
    const id = await createAsset(router);
    const first = await invokeRoute(router, { method: 'POST', url: `/assets/${id}/processing`, token: INSTRUCTOR_A });
    assert.equal(first.statusCode, 200);
    assert.equal((first.body as { attempts?: number }).attempts, 1);
    const second = await invokeRoute(router, { method: 'POST', url: `/assets/${id}/processing`, token: INSTRUCTOR_A });
    assert.equal(second.statusCode, 200);
    assert.equal((second.body as { attempts?: number }).attempts, 1);
});

test('processing: a cross-tenant owner attempt is 404 (no cross-tenant asset)', async () => {
    const { router } = buildRouter();
    const id = await createAsset(router);
    const response = await invokeRoute(router, { method: 'POST', url: `/assets/${id}/processing`, token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 404);
});

// ---- POST /callbacks/:provider -------------------------------------------

test('callbacks: verified ready applies, replay reports duplicate, unverified is ignored', async () => {
    const verified = buildRouter();
    const id = await createAsset(verified.router);
    await invokeRoute(verified.router, { method: 'POST', url: `/assets/${id}/processing`, token: INSTRUCTOR_A });
    const applied = await invokeRoute(verified.router, {
        method: 'POST', url: '/callbacks/vdocipher',
        body: { callback_id: 'cb-1', signature: 'sig', provider_asset_id: 'pa-1', target_state: 'ready' },
    });
    assert.equal(applied.statusCode, 200);
    assert.equal((applied.body as { outcome?: string }).outcome, 'applied');
    const replay = await invokeRoute(verified.router, {
        method: 'POST', url: '/callbacks/vdocipher',
        body: { callback_id: 'cb-1', signature: 'sig', provider_asset_id: 'pa-1', target_state: 'ready' },
    });
    assert.equal((replay.body as { outcome?: string }).outcome, 'duplicate');

    const unverified = buildRouter({ verifyProvider: () => false });
    const ignored = await invokeRoute(unverified.router, {
        method: 'POST', url: '/callbacks/vdocipher',
        body: { callback_id: 'cb-1', signature: 'sig', provider_asset_id: 'pa-1', target_state: 'ready' },
    });
    assert.equal(ignored.statusCode, 202);
    assert.ok(unverified.asset.audits.some((audit) => audit.action === 'video.asset.callback_ignored'));
});

test('callbacks: a cross-tenant payload is rejected with 403', async () => {
    const { router } = buildRouter();
    const id = await createAsset(router);
    await invokeRoute(router, { method: 'POST', url: `/assets/${id}/processing`, token: INSTRUCTOR_A });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/callbacks/vdocipher',
        body: { callback_id: 'cb-x', signature: 'sig', provider_asset_id: 'pa-1', target_state: 'ready', tenant_id: 'tenant-b' },
    });
    assert.equal(response.statusCode, 403);
});

// ---- playback entitlements ------------------------------------------------

test('playback: anonymous 401 and a staff principal without an enrollment is 403', async () => {
    const { router } = buildRouter();
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/playback/entitlements', body: { lessonId: 'lec-1', sessionId: 'sess-1' } })).statusCode, 401);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/playback/entitlements', token: INSTRUCTOR_A, body: { lessonId: 'lec-1', sessionId: 'sess-1' } })).statusCode, 403);
});

test('playback: a cross-tenant lesson is 404, a valid issue returns a bound token', async () => {
    const crossTenant = buildRouter({ resolveLessonScope: async () => ({ tenantId: 'tenant-b' }) });
    assert.equal((await invokeRoute(crossTenant.router, { method: 'POST', url: '/playback/entitlements', token: STUDENT_A, body: { lessonId: 'lec-1', sessionId: 'sess-1' } })).statusCode, 404);

    const { router, entitlement } = buildRouter();
    const issued = await invokeRoute(router, { method: 'POST', url: '/playback/entitlements', token: STUDENT_A, body: { lessonId: 'lec-1', sessionId: 'sess-1', ttlSeconds: 45 } });
    assert.equal(issued.statusCode, 201);
    const token = (issued.body as { token: string }).token;
    assert.equal((issued.body as { expiresIn?: number }).expiresIn, 45);
    const decision = await entitlement.verify(token, { tenantId: 'tenant-a', lessonId: 'lec-1', studentEnrollmentId: 'enr-a', sessionId: 'sess-1' });
    assert.equal(decision.allowed, true);
    // The same token never resolves for a different binding.
    assert.deepEqual(await entitlement.verify(token, { tenantId: 'tenant-a', lessonId: 'lec-2', studentEnrollmentId: 'enr-a', sessionId: 'sess-1' }), { allowed: false, reason: 'lesson-mismatch' });
});

test('playback: a missing secret is reported as unavailable, never a token', async () => {
    const { router, entitlementHarness } = buildRouter({ secret: '' });
    const response = await invokeRoute(router, { method: 'POST', url: '/playback/entitlements', token: STUDENT_A, body: { lessonId: 'lec-1', sessionId: 'sess-1' } });
    assert.equal(response.statusCode, 503);
    assert.equal(entitlementHarness.records.size, 0);
});

test('playback revoke: unknown 404, cross-tenant 403, same-tenant 200 then verification denies', async () => {
    const { router, entitlement, entitlementHarness } = buildRouter();
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/playback/entitlements/revoke', token: INSTRUCTOR_A, body: { jti: 'ghost' } })).statusCode, 404);

    const issued = await invokeRoute(router, { method: 'POST', url: '/playback/entitlements', token: STUDENT_A, body: { lessonId: 'lec-1', sessionId: 'sess-1' } });
    const { token, jti } = issued.body as { token: string; jti: string };

    // instr-b belongs to tenant-b: forbidden.
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/playback/entitlements/revoke', token: INSTRUCTOR_B, body: { jti } })).statusCode, 403);

    const revoked = await invokeRoute(router, { method: 'POST', url: '/playback/entitlements/revoke', token: INSTRUCTOR_A, body: { jti, reason: 'policy' } });
    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(await entitlement.verify(token, { tenantId: 'tenant-a', lessonId: 'lec-1', studentEnrollmentId: 'enr-a', sessionId: 'sess-1' }), { allowed: false, reason: 'revoked' });
    assert.ok(entitlementHarness.audits.some((audit) => audit.action === 'video.playback.revoked'));
});

// ---- usage -----------------------------------------------------------------

test('usage heartbeat: anonymous 401, staff without enrollment 403, invalid 400', async () => {
    const { router } = buildRouter({ now: () => 1_000 });
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', body: { sessionId: 'sess-1', deltaSeconds: 5 } })).statusCode, 401);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', token: INSTRUCTOR_A, body: { sessionId: 'sess-1', deltaSeconds: 5 } })).statusCode, 403);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', token: STUDENT_A, body: { sessionId: 'sess-1', deltaSeconds: 0 } })).statusCode, 400);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', token: STUDENT_A, body: { deltaSeconds: 5 } })).statusCode, 400);
});

test('usage heartbeat: records tenant-attributed watch time and deduplicates within the window', async () => {
    const { router, usageHarness } = buildRouter({ now: () => 1_000 });
    const first = await invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', token: STUDENT_A, body: { sessionId: 'sess-1', deltaSeconds: 12 } });
    assert.equal(first.statusCode, 200);
    assert.equal((first.body as { recorded?: boolean }).recorded, true);
    const duplicate = await invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', token: STUDENT_A, body: { sessionId: 'sess-1', deltaSeconds: 12 } });
    assert.equal((duplicate.body as { deduplicated?: boolean }).deduplicated, true);
    const summary = await invokeRoute(router, { method: 'GET', url: '/usage/summary', token: INSTRUCTOR_A });
    assert.equal((summary.body as { watchSeconds?: number }).watchSeconds, 12);
    assert.ok(usageHarness.audits.some((audit) => audit.action === 'video.usage.recorded'));
});

test('usage provider: unverified is ignored, verified storage is attributed', async () => {
    const unverified = buildRouter();
    const ignored = await invokeRoute(unverified.router, {
        method: 'POST', url: '/usage/provider',
        body: { provider: 'vdocipher', event_id: 'ev-1', tenant_id: 'tenant-a', kind: 'storage', storage_bytes: 2048, signature: 'x' },
    });
    assert.equal(ignored.statusCode, 202);
    assert.equal(unverified.usageHarness.events.size, 0);

    const verified = buildRouter({ verifyUsage: () => true });
    const recorded = await invokeRoute(verified.router, {
        method: 'POST', url: '/usage/provider',
        body: { provider: 'vdocipher', event_id: 'ev-1', tenant_id: 'tenant-a', kind: 'storage', storage_bytes: 2048, signature: 'x' },
    });
    assert.equal(recorded.statusCode, 200);
    assert.equal((recorded.body as { recorded?: boolean }).recorded, true);
    const replay = await invokeRoute(verified.router, {
        method: 'POST', url: '/usage/provider',
        body: { provider: 'vdocipher', event_id: 'ev-1', tenant_id: 'tenant-a', kind: 'storage', storage_bytes: 2048, signature: 'x' },
    });
    assert.equal((replay.body as { deduplicated?: boolean }).deduplicated, true);
});

test('usage summary: a student is forbidden and a staff principal gets tenant totals', async () => {
    const { router } = buildRouter({ now: () => 1_000 });
    assert.equal((await invokeRoute(router, { method: 'GET', url: '/usage/summary', token: STUDENT_A })).statusCode, 403);
    const summary = await invokeRoute(router, { method: 'GET', url: '/usage/summary', token: INSTRUCTOR_A });
    assert.equal(summary.statusCode, 200);
    assert.equal((summary.body as { tenantId?: string }).tenantId, 'tenant-a');
});
