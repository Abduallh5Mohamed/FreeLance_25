/**
 * M3 security-review fixes — rejection-path tests.
 *
 * One behavior per finding: F3 (entitlement issuance is access-checked and the
 * verify helper binds the token), F5 (revocation requires ownership or a
 * verified tenant/platform admin), F7 (heartbeats are bound to a server-issued
 * entitlement, clamped, aggregate-capped and rate-limited), F8 (the tenant
 * authority boundary exempts ONLY the signature-verified callbacks), F9 (a
 * dedicated VIDEO_PLAYBACK_SECRET with no JWT fallback, failing closed).
 *
 * Every route test drives the REAL router factory over in-memory seams; the
 * boundary and secret tests drive the REAL middleware / production wiring
 * contract. No database, network, Docker or provider is contacted.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { NextFunction, Response } from 'express';
import { createAuthenticateToken, type AuthRequest } from '../src/middleware/auth';
import { enforceTenantAuthorityBoundary } from '../src/middleware/tenant-authority-boundary';
import type { AuditRecordInput } from '../src/security/audit';
import {
    createPlaybackEntitlementService,
    verifyPlaybackEntitlement,
    type PlaybackEntitlementRecord,
    type PlaybackEntitlementStore,
} from '../src/services/playback-entitlement';
import {
    createVideoAssetLifecycle,
    type AssetUpdate,
    type NewVideoAsset,
    type NewVideoAssetCallback,
    type VideoAssetRecord,
    type VideoAssetStore,
} from '../src/services/video-asset-lifecycle';
import {
    createVideoUsageEventService,
    type NewUsageEventRow,
    type VideoUsageStore,
} from '../src/services/video-usage-events';
import {
    createVideoAssetsRouter,
    type ResolvedLessonAccess,
    type VideoAssetsDeps,
} from '../src/routes/video-assets';
import { TEST_SECRET, makeRepository, tokenFor, invokeRoute } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

/* =========================================================================
 * In-memory seams
 * ========================================================================= */

const seqId = (): (() => string) => {
    let n = 0;
    return () => `id-${++n}`;
};

const makeAssetStore = (): VideoAssetStore => {
    const assets = new Map<string, VideoAssetRecord>();
    const callbacks = new Set<string>();
    return {
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
        recordAudit: async () => {},
    };
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
}

const makeUsageStore = (): UsageHarness => {
    const events = new Map<string, NewUsageEventRow>();
    const keys = new Set<string>();
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
        sumWatchSecondsForEnrollment: async (enrollmentId, sinceMs) =>
            [...events.values()]
                .filter((event) => event.studentEnrollmentId === enrollmentId && event.kind === 'watch' && event.occurredAtMs >= sinceMs)
                .reduce((sum, event) => sum + event.watchSeconds, 0),
        countWatchEventsForEnrollment: async (enrollmentId, sinceMs) =>
            [...events.values()]
                .filter((event) => event.studentEnrollmentId === enrollmentId && event.kind === 'watch' && event.occurredAtMs >= sinceMs)
                .length,
        recordAudit: async () => {},
    };
    return { store, events, keys };
};

/* =========================================================================
 * Fixtures + router builder
 * ========================================================================= */

const USERS = {
    'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    'student-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
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
        'student-b': [{ id: 'enr-b', user_id: 'student-b', tenant_id: 'tenant-a', instructor_id: 'instr-a', group_id: null, grade_id: 'grade-a' }],
    },
};

const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enr-b' });
const INSTRUCTOR_A = tokenFor({ id: 'instr-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_B = tokenFor({ id: 'instr-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });

const allowedLessonAccess = (overrides: Partial<ResolvedLessonAccess> = {}): ResolvedLessonAccess => ({
    tenantId: 'tenant-a',
    isStaff: false,
    lecture: {
        tenantId: 'tenant-a',
        instructorId: 'instr-a',
        groupId: null,
        gradeId: 'grade-a',
        branchId: null,
        branchAmbiguous: false,
        isPublished: true,
        archived: false,
        displayOrder: 0,
    },
    enrollment: {
        id: 'enr-a',
        tenantId: 'tenant-a',
        instructorId: 'instr-a',
        groupId: null,
        gradeId: 'grade-a',
        branchId: null,
    },
    policy: {
        lectureId: 'lec-1',
        courseId: 'course-a',
        tenantId: 'tenant-a',
        releaseMode: 'immediate',
        releaseAtUtc: null,
        releaseTimeZone: 'UTC',
        prerequisiteLectureId: null,
        releasedAtUtc: null,
        isPublished: true,
        archived: false,
        displayOrder: 0,
    },
    prerequisiteCompleted: false,
    now: new Date(0),
    ...overrides,
});

interface RouterFixtures {
    resolveLessonScope?: (lessonId: string) => Promise<ResolvedLessonAccess | null>;
    isPlatformAdmin?: (userId: string) => Promise<boolean>;
    isTenantAdmin?: (userId: string, tenantId: string) => Promise<boolean>;
    now?: () => number;
    heartbeatWindowSeconds?: number;
    heartbeatLimits?: VideoAssetsDeps['heartbeatLimits'];
}

const buildRouter = (fixtures: RouterFixtures = {}) => {
    const ids = seqId();
    const entitlementHarness = makeEntitlementStore();
    const entitlement = createPlaybackEntitlementService({
        store: entitlementHarness.store,
        getSecret: () => TEST_SECRET,
        now: fixtures.now,
        idFactory: ids,
    });
    const usageHarness = makeUsageStore();
    const usage = createVideoUsageEventService({ store: usageHarness.store, idFactory: ids });
    const lifecycle = createVideoAssetLifecycle({
        store: makeAssetStore(),
        verifyCallbackSignature: () => false,
        idFactory: ids,
    });
    const repository = makeRepository(USERS, REPO_OPTS);
    const deps: VideoAssetsDeps = {
        authenticate: createAuthenticateToken(repository),
        lifecycle,
        entitlement,
        usage,
        resolveLessonScope: fixtures.resolveLessonScope ?? (async () => allowedLessonAccess()),
        isPlatformAdmin: fixtures.isPlatformAdmin,
        isTenantAdmin: fixtures.isTenantAdmin,
        now: fixtures.now,
        heartbeatWindowSeconds: fixtures.heartbeatWindowSeconds ?? 30,
        heartbeatLimits: fixtures.heartbeatLimits,
    };
    return { router: createVideoAssetsRouter(deps), entitlement, entitlementHarness, usageHarness };
};

const issue = async (
    router: ReturnType<typeof buildRouter>['router'],
    token: string,
    body: Record<string, unknown> = { lessonId: 'lec-1', sessionId: 'sess-1' },
) => {
    const response = await invokeRoute(router, { method: 'POST', url: '/playback/entitlements', token, body });
    return response;
};

/* =========================================================================
 * F3 — issuance is access-checked; verify helper binds the token
 * ========================================================================= */

test('F3 issuance: the composed policy gates issuance (unpublished/out-of-audience 404, not-released 403)', async () => {
    const unpublished = buildRouter({
        resolveLessonScope: async () => allowedLessonAccess({ lecture: { ...allowedLessonAccess().lecture, isPublished: false } }),
    });
    const hidden = await issue(unpublished.router, STUDENT_A);
    assert.equal(hidden.statusCode, 404);
    assert.equal(unpublished.entitlementHarness.records.size, 0);

    const outOfAudience = buildRouter({
        resolveLessonScope: async () => allowedLessonAccess({
            lecture: { ...allowedLessonAccess().lecture, gradeId: 'grade-z' },
        }),
    });
    assert.equal((await issue(outOfAudience.router, STUDENT_A)).statusCode, 404);
    assert.equal(outOfAudience.entitlementHarness.records.size, 0);

    const notReleased = buildRouter({
        resolveLessonScope: async () => allowedLessonAccess({
            policy: {
                ...allowedLessonAccess().policy,
                releaseMode: 'scheduled',
                releaseAtUtc: new Date(10_000_000).toISOString(),
            },
            now: new Date(0),
        }),
    });
    const early = await issue(notReleased.router, STUDENT_A);
    assert.equal(early.statusCode, 403);
    assert.equal(notReleased.entitlementHarness.records.size, 0);

    const allowed = buildRouter();
    const ok = await issue(allowed.router, STUDENT_A);
    assert.equal(ok.statusCode, 201);
    assert.equal(allowed.entitlementHarness.records.size, 1);
});

test('F3 verify helper: matching binding allows and every mismatch/blank denies', async () => {
    const harness = makeEntitlementStore();
    const service = createPlaybackEntitlementService({
        store: harness.store,
        getSecret: () => TEST_SECRET,
        now: () => 1_000,
        idFactory: seqId(),
    });
    const issued = await service.issue({
        tenantId: 'tenant-a', lessonId: 'lec-1', studentEnrollmentId: 'enr-a', sessionId: 'sess-1',
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const request = {
        token: issued.token,
        tenantId: 'tenant-a',
        lessonId: 'lec-1',
        studentEnrollmentId: 'enr-a',
        sessionId: 'sess-1',
    };
    assert.equal((await verifyPlaybackEntitlement(service, request)).allowed, true);
    assert.deepEqual(await verifyPlaybackEntitlement(service, { ...request, lessonId: 'lec-2' }), { allowed: false, reason: 'lesson-mismatch' });
    assert.deepEqual(await verifyPlaybackEntitlement(service, { ...request, tenantId: 'tenant-b' }), { allowed: false, reason: 'tenant-mismatch' });
    assert.deepEqual(await verifyPlaybackEntitlement(service, { ...request, studentEnrollmentId: 'enr-b' }), { allowed: false, reason: 'student-mismatch' });
    assert.deepEqual(await verifyPlaybackEntitlement(service, { ...request, sessionId: 'sess-2' }), { allowed: false, reason: 'session-mismatch' });
    // A missing expectation field can never be skipped.
    assert.deepEqual(await verifyPlaybackEntitlement(service, { ...request, sessionId: undefined }), { allowed: false, reason: 'session-mismatch' });
});

/* =========================================================================
 * F5 — revocation ownership / tenant-admin / platform-admin
 * ========================================================================= */

test('F5 revoke: a different enrollment in the same tenant cannot revoke', async () => {
    const { router, entitlementHarness } = buildRouter();
    const issued = await issue(router, STUDENT_A);
    const { jti } = issued.body as { jti: string };
    const denied = await invokeRoute(router, { method: 'POST', url: '/playback/entitlements/revoke', token: STUDENT_B, body: { jti } });
    assert.equal(denied.statusCode, 403);
    assert.equal(entitlementHarness.records.get(jti)?.revokedAtMs, null);
});

test('F5 revoke: a verified tenant admin may revoke; a platform admin may revoke cross-tenant', async () => {
    const tenantAdmin = buildRouter({ isTenantAdmin: async () => true });
    const first = await issue(tenantAdmin.router, STUDENT_A);
    const firstJti = (first.body as { jti: string }).jti;
    assert.equal((await invokeRoute(tenantAdmin.router, { method: 'POST', url: '/playback/entitlements/revoke', token: INSTRUCTOR_A, body: { jti: firstJti } })).statusCode, 200);

    const platform = buildRouter({ isPlatformAdmin: async () => true });
    const second = await issue(platform.router, STUDENT_A);
    const secondJti = (second.body as { jti: string }).jti;
    assert.equal((await invokeRoute(platform.router, { method: 'POST', url: '/playback/entitlements/revoke', token: INSTRUCTOR_B, body: { jti: secondJti } })).statusCode, 200);

    // Without either capability, same-tenant staff are still denied.
    const bare = buildRouter();
    const third = await issue(bare.router, STUDENT_A);
    const thirdJti = (third.body as { jti: string }).jti;
    assert.equal((await invokeRoute(bare.router, { method: 'POST', url: '/playback/entitlements/revoke', token: INSTRUCTOR_A, body: { jti: thirdJti } })).statusCode, 403);
});

/* =========================================================================
 * F7 — heartbeat binding, clamping, aggregate cap, rate limit
 * ========================================================================= */

const heartbeat = (
    router: ReturnType<typeof buildRouter>['router'],
    token: string,
    body: Record<string, unknown>,
) => invokeRoute(router, { method: 'POST', url: '/usage/heartbeat', token, body });

test('F7 heartbeat: a token bound to another lesson/session cannot be replayed', async () => {
    const { router } = buildRouter({ now: () => 1_000 });
    const token = (await issue(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1' })).body as { token: string };
    assert.equal((await heartbeat(router, STUDENT_A, { lessonId: 'lec-2', sessionId: 'sess-1', token: token.token, deltaSeconds: 10 })).statusCode, 403);
    assert.equal((await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-2', token: token.token, deltaSeconds: 10 })).statusCode, 403);
    assert.equal((await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1', deltaSeconds: 10 })).statusCode, 403);
});

test('F7 heartbeat: a client delta is clamped to one dedupe window (no inflation)', async () => {
    const { router, usageHarness } = buildRouter({ now: () => 1_000, heartbeatWindowSeconds: 30 });
    const token = (await issue(router, STUDENT_A)).body as { token: string };
    const response = await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1', token: token.token, deltaSeconds: 3600 });
    assert.equal(response.statusCode, 200);
    const recorded = [...usageHarness.events.values()];
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].watchSeconds, 30);
});

test('F7 heartbeat: a per-enrollment rate limit rejects a burst of distinct sessions', async () => {
    const { router } = buildRouter({
        now: () => 1_000,
        heartbeatWindowSeconds: 30,
        heartbeatLimits: { windowSeconds: 3600, maxEventsPerEnrollment: 2, maxSecondsPerEnrollment: 10_000 },
    });
    const tokens = await Promise.all([
        issue(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1' }),
        issue(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-2' }),
        issue(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-3' }),
    ]);
    const values = tokens.map((response) => (response.body as { token: string }).token);
    assert.equal((await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1', token: values[0], deltaSeconds: 10 })).statusCode, 200);
    assert.equal((await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-2', token: values[1], deltaSeconds: 10 })).statusCode, 200);
    const limited = await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-3', token: values[2], deltaSeconds: 10 });
    assert.equal(limited.statusCode, 429);
    assert.equal((limited.body as { reason?: string }).reason, 'rate-limit');
});

test('F7 heartbeat: the per-enrollment aggregate cap is enforced', async () => {
    const { router } = buildRouter({
        now: () => 1_000,
        heartbeatWindowSeconds: 30,
        heartbeatLimits: { windowSeconds: 3600, maxEventsPerEnrollment: 100, maxSecondsPerEnrollment: 25 },
    });
    const first = (await issue(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1' })).body as { token: string };
    assert.equal((await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-1', token: first.token, deltaSeconds: 30 })).statusCode, 200);
    const second = (await issue(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-2' })).body as { token: string };
    const capped = await heartbeat(router, STUDENT_A, { lessonId: 'lec-1', sessionId: 'sess-2', token: second.token, deltaSeconds: 30 });
    assert.equal(capped.statusCode, 429);
    assert.equal((capped.body as { reason?: string }).reason, 'aggregate-cap');
});

/* =========================================================================
 * F8 — tenant authority boundary exemptions
 * ========================================================================= */

interface BoundaryOutcome {
    statusCode: number;
    nextCalled: boolean;
}

const runBoundary = (overrides: Record<string, unknown> = {}): BoundaryOutcome => {
    const req = {
        headers: {}, method: 'POST', path: '/api/courses', body: {}, query: {},
        ...overrides,
    } as unknown as AuthRequest;
    let statusCode = 200;
    const res = {
        status(code: number) { statusCode = code; return res; },
        json() { return res; },
    } as unknown as Response;
    let nextCalled = false;
    enforceTenantAuthorityBoundary(req, res, (() => { nextCalled = true; }) as NextFunction);
    return { statusCode, nextCalled };
};

test('F8 boundary: tenant selectors stay rejected on every non-callback path', () => {
    assert.deepEqual(runBoundary({ body: { tenant_id: 'tenant-b' } }), { statusCode: 400, nextCalled: false });
    assert.deepEqual(runBoundary({ query: { tenantId: 'tenant-b' } }), { statusCode: 400, nextCalled: false });
    assert.deepEqual(runBoundary({ body: { nested: { tenant: 'tenant-b' } } }), { statusCode: 400, nextCalled: false });
    assert.deepEqual(runBoundary({ path: '/api/video-assets/assets', body: { tenant_id: 'tenant-b' } }), { statusCode: 400, nextCalled: false });
    assert.deepEqual(runBoundary({ path: '/api/video-assets/callbacks/a/b', body: { tenant_id: 'tenant-b' } }), { statusCode: 400, nextCalled: false });
    assert.deepEqual(runBoundary({ path: '/api/video-assets/usage/summary', body: { tenant_id: 'tenant-b' } }), { statusCode: 400, nextCalled: false });
});

test('F8 boundary: only the signature-verified callback paths tolerate a tenant selector', () => {
    assert.deepEqual(runBoundary({ path: '/api/video-assets/callbacks/vdocipher', body: { tenant_id: 'tenant-b' } }), { statusCode: 200, nextCalled: true });
    assert.deepEqual(runBoundary({ originalUrl: '/api/video-assets/callbacks/vdocipher?x=1', body: { tenant_id: 'tenant-b' } }), { statusCode: 200, nextCalled: true });
    assert.deepEqual(runBoundary({ path: '/api/video-assets/usage/provider', body: { tenant_id: 'tenant-b' } }), { statusCode: 200, nextCalled: true });
});

test('F8 boundary: the header selector stays rejected even on a callback path', () => {
    assert.deepEqual(runBoundary({ path: '/api/video-assets/callbacks/vdocipher', headers: { 'x-tenant-id': 'tenant-b' }, body: { tenant_id: 'tenant-b' } }), { statusCode: 400, nextCalled: false });
    assert.deepEqual(runBoundary({ path: '/api/video-assets/usage/provider', headers: { 'x-instructor-id': 'x' } }), { statusCode: 400, nextCalled: false });
});

/* =========================================================================
 * F9 — dedicated playback secret, fail closed
 * ========================================================================= */

test('F9 production wiring: playback tokens use a dedicated secret with no JWT fallback', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'src', 'routes', 'video-assets.ts'), 'utf8');
    assert.ok(source.includes('getSecret: () => process.env.VIDEO_PLAYBACK_SECRET'), 'playback secret must be read from VIDEO_PLAYBACK_SECRET');
    assert.ok(!/getSecret:\s*\(\)\s*=>\s*process\.env\.VIDEO_PLAYBACK_SECRET\s*\|\|/.test(source), 'no JWT_SECRET fallback may remain');
});

test('F9 runtime: with only JWT_SECRET present, playback issuance fails closed', async () => {
    const originalPlayback = process.env.VIDEO_PLAYBACK_SECRET;
    const originalJwt = process.env.JWT_SECRET;
    try {
        delete process.env.VIDEO_PLAYBACK_SECRET;
        process.env.JWT_SECRET = TEST_SECRET;
        const harness = makeEntitlementStore();
        const service = createPlaybackEntitlementService({
            store: harness.store,
            getSecret: () => process.env.VIDEO_PLAYBACK_SECRET,
            now: () => 1_000,
            idFactory: seqId(),
        });
        const issued = await service.issue({
            tenantId: 'tenant-a', lessonId: 'lec-1', studentEnrollmentId: 'enr-a', sessionId: 'sess-1',
        });
        assert.deepEqual(issued, { ok: false, reason: 'secret-unavailable' });
        assert.equal(harness.records.size, 0);
    } finally {
        if (originalPlayback === undefined) delete process.env.VIDEO_PLAYBACK_SECRET;
        else process.env.VIDEO_PLAYBACK_SECRET = originalPlayback;
        if (originalJwt === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalJwt;
    }
});
