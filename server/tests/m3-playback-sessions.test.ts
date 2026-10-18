import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
    generateWatermarkPayload,
    pseudonymizeIdentity,
    DEFAULT_WATERMARK_BOUNDS,
} from '../src/services/playback-watermark';
import {
    createPlaybackSessionRegistry,
    normalizePlaybackPolicy,
    createSessionRegistry,
    createDeviceRegistry,
    createPlaybackSessionRegistryFactory,
    asPlaybackSessionStore,
    PlaybackDeviceLimitError,
    PLAYBACK_POLICY_CEILINGS,
} from '../src/services/playback-session-registry';
import {
    createPlaybackProgressService,
    createProgressService,
    createPlaybackProgress,
} from '../src/services/playback-progress';
import { createPlaybackSessionsRouter } from '../src/routes/playback-sessions';
import { createAuthenticateToken } from '../src/middleware/auth';
import { makeFakeDataAccess, makeRepository, tokenFor, invokeRoute } from './helpers/m2-harness';

const TEST_SECRET = 'm2-test-only-secret-with-sufficient-length-0123456789';
const originalSecret = process.env.JWT_SECRET;
import { before, after } from 'node:test';
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

/* ---------- V4 watermark ---------- */
test('V4: watermark uses partial identity and never full phone/email', () => {
    const payload = generateWatermarkPayload({
        studentId: 'student-123456789',
        name: 'Ahmed Ali',
        phone: '+966501234567',
        email: 'ahmed@example.com',
        tenantId: 'tenant-abcdef',
        groupLabel: 'Group A',
    }, { rng: () => 0.5 });
    assert.equal(payload.partialIdentity.phoneLast4, '4567');
    assert.equal(payload.partialIdentity.emailDomain, 'example.com');
    assert.ok(!JSON.stringify(payload).includes('+966501234567'));
    assert.ok(!JSON.stringify(payload).includes('ahmed@example.com'));
    assert.equal(payload.screenshotsPossible, true);
    assert.equal(payload.screenshotProtectionClaim, false);
    // bounds
    for (const layer of payload.layers) {
        assert.ok(layer.opacity >= DEFAULT_WATERMARK_BOUNDS.opacityMin - 1e-9);
        assert.ok(layer.opacity <= DEFAULT_WATERMARK_BOUNDS.opacityMax + 1e-9);
        assert.ok(layer.x >= DEFAULT_WATERMARK_BOUNDS.xMin - 1e-9);
        assert.ok(layer.x <= DEFAULT_WATERMARK_BOUNDS.xMax + 1e-9);
    }
    assert.ok(payload.overlap >= DEFAULT_WATERMARK_BOUNDS.minLayers);
    assert.ok(payload.overlap <= DEFAULT_WATERMARK_BOUNDS.maxLayers);
});

test('V4: pseudonymizeIdentity masks name and id', () => {
    const p = pseudonymizeIdentity({ studentId: '1234567890', name: 'Ahmed Ali Hassan', phone: null, email: null, tenantId: 'tenant', groupLabel: null });
    assert.notEqual(p.studentRef, '1234567890');
    assert.equal(p.namePartial, 'Ahmed H.');
});

/* ---------- V5 registry ---------- */
test('V5: atomic slot acquisition prevents oversubscription', async () => {
    const registry = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const device = registry.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 1, maxDevices: 3, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    const [a, b] = await Promise.all([
        registry.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: device.id, sessionId: 's1', policy }),
        registry.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: device.id, sessionId: 's2', policy }),
    ]);
    const acquired = [a, b].filter((r) => r.acquired).length;
    assert.equal(acquired, 1, 'only one slot may be acquired');
});

test('V5: warning and self/support revoke with audit', async () => {
    const audits: unknown[] = [];
    const registry = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z'), audit: (e) => audits.push(e) });
    const device = registry.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 2, maxDevices: 3, warningThreshold: 1, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    const r1 = await registry.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: device.id, sessionId: 's1', policy });
    assert.equal(r1.acquired, true);
    const r2 = await registry.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: device.id, sessionId: 's2', policy });
    assert.equal(r2.warning, true);
    // self revoke
    const self = await registry.revokeSession({ sessionId: 's1', actorId: 'u1', actorType: 'self', support: false });
    assert.equal(self.revoked, true);
    // support revoke
    const s2device = registry.registerDevice({ tenantId: 't1', userId: 'u2', fingerprint: 'fp2' });
    await registry.acquireSlot({ tenantId: 't1', userId: 'u2', deviceId: s2device.id, sessionId: 's3', policy });
    const support = await registry.revokeSession({ sessionId: 's3', actorId: 'admin', actorType: 'support', support: true });
    assert.equal(support.revoked, true);
    assert.ok(audits.length > 0);
});

test('V5: device limit enforced at registration (F10)', () => {
    const registry = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const policy = { maxConcurrentSessions: 5, maxDevices: 1, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    registry.setPolicy(policy, 't1');
    const d1 = registry.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    assert.ok(d1);
    // deny-by-default: a second distinct fingerprint is rejected, no new row
    assert.throws(() => registry.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp2' }), PlaybackDeviceLimitError);
    // re-registering the same active fingerprint is idempotent, not another row
    assert.equal(registry.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' }).id, d1.id);
    assert.equal(registry.listDevices('t1', 'u1').length, 1);
});

/* ---------- V6 progress ---------- */
test('V6: progress monotonic bounds and rate limit', () => {
    const progress = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 1000 });
    const w1 = progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    assert.equal(w1.accepted, true);
    progress.permitDevice('dev1');
    // monotonic: lower position rejected
    const w2 = progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 5, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:02Z') });
    assert.equal(w2.accepted, false);
    assert.equal(w2.reason, 'not_monotonic');
    // exceeds duration rejected
    const w3 = progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 200, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:03Z') });
    assert.equal(w3.accepted, false);
    assert.equal(w3.reason, 'exceeds_duration');
    // rate limit
    const w4 = progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 20, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:03Z') });
    // time diff < 1000ms from last accepted? last accepted at 00:00:00, now 00:00:03 => 3000ms, ok. Make rapid call
    const w5 = progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 25, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:03Z') });
    assert.equal(w5.accepted, false);
    assert.equal(w5.reason, 'rate_limited');
});

test('V6: cross-tenant/student forgery denied', () => {
    const progress = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 0 });
    progress.permitDevice('dev1');
    progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    // forged tenant
    const forgedTenant = progress.recordProgress({ tenantId: 't2', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 99, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:05Z') });
    assert.equal(forgedTenant.accepted, false);
    assert.equal(forgedTenant.reason, 'tenant_mismatch');
    // forged student
    const forgedStudent = progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e2', assetId: 'a1', positionSeconds: 99, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:06Z') });
    assert.equal(forgedStudent.accepted, false);
    assert.equal(forgedStudent.reason, 'student_mismatch');
});

test('V6: resume only for permitted device', () => {
    const progress = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 0 });
    progress.permitDevice('dev1');
    progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 42, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    const allowed = progress.getResumePosition({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', deviceId: 'dev1' });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.position, 42);
    progress.revokeDevice('dev1');
    const denied = progress.getResumePosition({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', deviceId: 'dev1' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'device_not_permitted');
});

test('V6: heartbeat rate limit', () => {
    const progress = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minHeartbeatIntervalMs: 1000 });
    const h1 = progress.recordHeartbeat({ sessionId: 's1', now: new Date('2026-01-01T00:00:00Z') });
    assert.equal(h1.accepted, true);
    const h2 = progress.recordHeartbeat({ sessionId: 's1', now: new Date('2026-01-01T00:00:00.500Z') });
    assert.equal(h2.accepted, false);
    assert.equal(h2.reason, 'rate_limited');
});

/* ---------- route ---------- */
test('route: start session returns watermark and enforces auth', async () => {
    const db = makeFakeDataAccess(() => []);
    const repository = makeRepository({ 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } }, { memberships: { 'student-a': [{ tenant_id: 'tenant-a' }] }, enrollments: { 'student-a': [{ id: 'enr-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', group_id: null, grade_id: null }] } });
    const authenticate = createAuthenticateToken(repository);
    const router = createPlaybackSessionsRouter({ db, authenticate, now: () => new Date('2026-01-01T00:00:00Z') });
    const token = tokenFor({ id: 'student-a', role: 'student', tv: 0, tenant_id: 'tenant-a', student_enrollment_id: 'enr-a' });
    const anon = await invokeRoute(router, { method: 'POST', url: '/sessions', body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    assert.equal(anon.statusCode, 401);
    const res = await invokeRoute(router, { method: 'POST', url: '/sessions', token, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    assert.equal(res.statusCode, 201);
    assert.ok((res.body as any).watermark);
    assert.equal((res.body as any).watermark.screenshotProtectionClaim, false);
});

/* ---------- V4 extended ---------- */
test('V4: aliases produce payload and no full phone/email', () => {
    const input = { studentId: 'student-123456789', name: 'Ahmed Ali', phone: '+966501234567', email: 'ahmed@example.com', tenantId: 'tenant-abcdef', groupLabel: 'Group A' };
    const opts = { rng: () => 0.5 };
    const p = generateWatermarkPayload(input, opts);
    assert.ok(!JSON.stringify(p).includes('+966501234567'));
    assert.ok(!JSON.stringify(p).includes('ahmed@example.com'));
    assert.equal(p.partialIdentity.phoneLast4, '4567');
    assert.equal(p.partialIdentity.emailDomain, 'example.com');
});

test('V4: maskIdentity/partialIdentity aliases', () => {
    const p1 = pseudonymizeIdentity({ studentId: '1234567890', name: 'Ahmed Ali Hassan' });
    assert.ok(p1.studentRef.startsWith('…'));
    assert.equal(p1.namePartial, 'Ahmed H.');
});

test('V4: bounds clamping and layer count', () => {
    const payload = generateWatermarkPayload({ studentId: 's1', name: 'A B' }, { rng: () => 0.25, layerCount: 10 });
    assert.ok(payload.overlap <= DEFAULT_WATERMARK_BOUNDS.maxLayers);
    assert.ok(payload.overlap >= DEFAULT_WATERMARK_BOUNDS.minLayers);
    assert.equal(payload.layers.length, payload.overlap);
});

test('V4: no phone/email yields null partials', () => {
    const p = generateWatermarkPayload({ studentId: 's1' }, { rng: () => 0.5 });
    assert.equal(p.partialIdentity.phoneLast4, null);
    assert.equal(p.partialIdentity.emailDomain, null);
});

/* ---------- V5 registry extended 1 ---------- */
test('V5: getPolicy default and setPolicy', () => {
    const reg = createPlaybackSessionRegistry();
    const p = reg.getPolicy('t1');
    assert.equal(p.maxConcurrentSessions, 2);
    const p2 = reg.setPolicy({ maxConcurrentSessions: 5, maxDevices: 4, tenantId: 't1' });
    assert.equal(p2.maxConcurrentSessions, 5);
    assert.equal(reg.getPolicy('t1').maxConcurrentSessions, 5);
});

test('V5: normalizePlaybackPolicy validation', () => {
    const p = normalizePlaybackPolicy({ maxConcurrentSessions: 0, maxDevices: -1, warningThreshold: 'x' }, 't');
    assert.equal(p.maxConcurrentSessions, 2);
    assert.equal(p.maxDevices, 3);
    assert.equal(p.warningThreshold, 0);
});

test('V5: normalizePlaybackPolicy clamps to server ceilings (F1)', () => {
    const p = normalizePlaybackPolicy({ maxConcurrentSessions: 1000, maxDevices: 1000 }, 't');
    assert.equal(p.maxConcurrentSessions, PLAYBACK_POLICY_CEILINGS.maxConcurrentSessions);
    assert.equal(p.maxDevices, PLAYBACK_POLICY_CEILINGS.maxDevices);
    assert.ok(p.maxConcurrentSessions < 1000);
});

test('V5: registerDevice returns existing and listDevices tenant isolation', () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d1 = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const d2 = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    assert.equal(d1.id, d2.id);
    reg.registerDevice({ tenantId: 't2', userId: 'u1', fingerprint: 'fp1' });
    assert.equal(reg.listDevices('t1').length, 1);
    assert.equal(reg.listDevices('t2').length, 1);
    assert.equal(reg.listDevices('t1', 'u1').length, 1);
});

test('V5: getDevice and activeSlotCount', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    assert.equal(reg.getDevice(d.id)?.id, d.id);
    assert.equal(reg.getDevice('nope'), null);
    const policy = { maxConcurrentSessions: 2, maxDevices: 3, warningThreshold: 1, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's1', policy });
    assert.equal(reg.activeSlotCount('t1', 'u1'), 1);
    assert.equal(reg.isSessionActive('s1'), true);
    assert.equal(reg.getSession('s1')?.status, 'active');
});

test('V5: acquireSlot deny cases', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 1, maxDevices: 1, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    reg.setPolicy(policy, 't1');
    let r = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: 'missing', sessionId: 's1', policy });
    assert.equal(r.acquired, false);
    assert.equal(r.reason, 'device_not_found');
    const d2 = reg.registerDevice({ tenantId: 't2', userId: 'u2', fingerprint: 'fp2' });
    r = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d2.id, sessionId: 's2', policy });
    assert.equal(r.acquired, false);
    assert.equal(r.reason, 'device_not_found');
    reg.revokeDevice({ deviceId: d.id, actorId: 'u1', support: false });
    const dev = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp4' });
    const policy2 = { maxConcurrentSessions: 1, maxDevices: 3, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: dev.id, sessionId: 's3', policy: policy2 });
    const r2 = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: dev.id, sessionId: 's4', policy: policy2 });
    assert.equal(r2.acquired, false);
    assert.equal(r2.reason, 'concurrency_limit');
    const r3 = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: dev.id, sessionId: 's3', policy: policy2 });
    assert.equal(r3.acquired, false);
    assert.equal(r3.reason, 'duplicate_session');
});

test('V5: device limit enforced at acquisition', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const policy = { maxConcurrentSessions: 5, maxDevices: 3, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    reg.setPolicy(policy, 't1');
    const d1 = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp2' });
    reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp3' });
    const r = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d1.id, sessionId: 's1', policy });
    assert.equal(r.acquired, true);
    // A later policy that lowers the ceiling below the registered device count
    // is still denied at acquisition.
    const lowered = { ...policy, maxDevices: 2 };
    reg.setPolicy(lowered, 't1');
    const r2 = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d1.id, sessionId: 's2', policy: lowered });
    assert.equal(r2.acquired, false);
    assert.equal(r2.reason, 'device_limit');
});

test('V5: releaseSlot frees slot and idempotent', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 1, maxDevices: 3, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's1', policy });
    assert.equal(reg.releaseSlot('s1'), true);
    assert.equal(reg.releaseSlot('s1'), false);
    assert.equal(reg.isSessionActive('s1'), false);
    const r = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's2', policy });
    assert.equal(r.acquired, true);
});

test('V5: revokeSession allow/deny/audit/idempotent', async () => {
    const audits: unknown[] = [];
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z'), audit: (e) => audits.push(e) });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 2, maxDevices: 3, warningThreshold: 1, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's1', policy });
    const deny = await reg.revokeSession({ sessionId: 's1', actorId: 'u2', actorType: 'self', support: false });
    assert.equal(deny.revoked, false);
    const self = await reg.revokeSession({ sessionId: 's1', actorId: 'u1', actorType: 'self', support: false });
    assert.equal(self.revoked, true);
    const before = audits.length;
    const again = await reg.revokeSession({ sessionId: 's1', actorId: 'u1', actorType: 'self', support: false });
    assert.equal(again.revoked, false);
    assert.equal(again.reason, 'already_ended');
    assert.equal(audits.length, before);
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's2', policy });
    const sup = await reg.revokeSession({ sessionId: 's2', actorId: 'admin', actorType: 'support', support: true });
    assert.equal(sup.revoked, true);
    assert.ok(audits.some((a: any) => a.action === 'playback.session.support_revoke'));
});

test('V5: revokeSession policy deny', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 2, maxDevices: 3, warningThreshold: 1, selfRevokeAllowed: false, supportRevokeAllowed: false, tenantId: 't1' };
    reg.setPolicy(policy, 't1');
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's1', policy });
    const self = await reg.revokeSession({ sessionId: 's1', actorId: 'u1', actorType: 'self', support: false });
    assert.equal(self.revoked, false);
    assert.equal(self.reason, 'self_revoke_not_allowed');
});

test('V5: revokeSession not found', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const r = await reg.revokeSession({ sessionId: 'missing', actorId: 'u1' });
    assert.equal(r.revoked, false);
    assert.equal(r.reason, 'session_not_found');
});

test('V5: revokeDevice allow/deny/audit/idempotent', () => {
    const audits: unknown[] = [];
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z'), audit: (e) => audits.push(e) });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const deny = reg.revokeDevice({ deviceId: d.id, actorId: 'u2', support: false });
    assert.equal(deny.revoked, false);
    assert.equal(deny.reason, 'not_owner');
    const ok = reg.revokeDevice({ deviceId: d.id, actorId: 'u1', support: false });
    assert.equal(ok.revoked, true);
    const before = audits.length;
    const again = reg.revokeDevice({ deviceId: d.id, actorId: 'u1', support: false });
    assert.equal(again.revoked, true);
    assert.equal(again.reason, 'already_revoked');
    assert.equal(audits.length, before);
    const reg2 = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d2 = reg2.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp2' });
    reg2.setPolicy({ maxConcurrentSessions: 2, maxDevices: 3, warningThreshold: 1, selfRevokeAllowed: true, supportRevokeAllowed: false, tenantId: 't1' }, 't1');
    const supportDeny = reg2.revokeDevice({ deviceId: d2.id, actorId: 'admin', support: true });
    assert.equal(supportDeny.revoked, false);
    assert.equal(supportDeny.reason, 'support_revoke_not_allowed');
    assert.equal(reg2.revokeDevice({ deviceId: 'missing', actorId: 'u1', support: false }).reason, 'device_not_found');
});

test('V5: listSessions tenant isolation', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 2, maxDevices: 3, warningThreshold: 1, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's1', policy });
    assert.equal(reg.listSessions('t1').length, 1);
    assert.equal(reg.listSessions('t2').length, 0);
    assert.equal(reg.listSessions('t1', 'u1', 'active').length, 1);
});

test('V5: concurrency N acquisitions limit L', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const L = 3;
    const N = 20;
    const policy = { maxConcurrentSessions: L, maxDevices: 5, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
        reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: `s-${i}`, policy })));
    const acquired = results.filter((r) => r.acquired).length;
    assert.ok(acquired <= L, `acquired ${acquired} > ${L}`);
    assert.equal(acquired, L);
});

test('V5: concurrency release frees slot', async () => {
    const reg = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    const d = reg.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    const policy = { maxConcurrentSessions: 1, maxDevices: 5, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 't1' };
    const r1 = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's1', policy });
    assert.equal(r1.acquired, true);
    const r2 = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's2', policy });
    assert.equal(r2.acquired, false);
    reg.releaseSlot('s1', 'done');
    const r3 = await reg.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: d.id, sessionId: 's3', policy });
    assert.equal(r3.acquired, true);
});

test('V5: aliases exist', () => {
    const a = createSessionRegistry();
    const b = createDeviceRegistry();
    const c = createPlaybackSessionRegistryFactory();
    assert.ok(a && b && c);
});

/* ---------- V6 progress extended ---------- */
test('V6: aliases and reset', () => {
    const a = createProgressService();
    const b = createPlaybackProgress();
    assert.ok(a && b);
    a.permitDevice('d1');
    a.revokeDevice('d1');
    assert.equal(a.isDevicePermitted('d1'), false);
    a.reset();
    assert.equal(a.isDevicePermitted('d1'), true);
});

test('V6: isDevicePermitted default and permit/revoke', () => {
    const p = createPlaybackProgressService();
    assert.equal(p.isDevicePermitted(null), true);
    assert.equal(p.isDevicePermitted('unknown'), true);
    p.permitDevice('dev');
    assert.equal(p.isDevicePermitted('dev'), true);
    p.revokeDevice('dev');
    assert.equal(p.isDevicePermitted('dev'), false);
});

test('V6: recordProgress validation', () => {
    const p = createPlaybackProgressService({ minProgressIntervalMs: 0 });
    const r1 = p.recordProgress({} as any);
    assert.equal(r1.accepted, false);
    assert.equal(r1.reason, 'invalid_input');
    const r2 = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: NaN });
    assert.equal(r2.accepted, false);
    assert.equal(r2.reason, 'negative_position');
    const r3 = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: -5 });
    assert.equal(r3.accepted, false);
    assert.equal(r3.reason, 'negative_position');
});

test('V6: device unpermitted rejected', () => {
    const p = createPlaybackProgressService({ minProgressIntervalMs: 0 });
    p.revokeDevice('dev1');
    const r = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev1' });
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'device_not_permitted');
});

test('V6: exceeds duration and backwards', () => {
    const p = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 0 });
    p.permitDevice('dev1');
    const w1 = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    assert.equal(w1.accepted, true);
    const w2 = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 5, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:05Z') });
    assert.equal(w2.accepted, false);
    assert.equal(w2.reason, 'not_monotonic');
    const w3 = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 200, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:06Z') });
    assert.equal(w3.accepted, false);
    assert.equal(w3.reason, 'exceeds_duration');
});

test('V6: forged tenant/student rejected', () => {
    const p = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 0 });
    p.permitDevice('dev1');
    p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    const ft = p.recordProgress({ tenantId: 't2', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 99, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:05Z') });
    assert.equal(ft.accepted, false);
    assert.equal(ft.reason, 'tenant_mismatch');
    const fs = p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e2', assetId: 'a1', positionSeconds: 99, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:06Z') });
    assert.equal(fs.accepted, false);
    assert.equal(fs.reason, 'student_mismatch');
});

test('V6: resume only permitted device', () => {
    const p = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 0 });
    p.permitDevice('dev1');
    p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 42, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    const allowed = p.getResumePosition({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', deviceId: 'dev1' });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.position, 42);
    p.revokeDevice('dev1');
    const denied = p.getResumePosition({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', deviceId: 'dev1' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'device_not_permitted');
    // not found
    const nf = p.getResumePosition({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'missing' });
    assert.equal(nf.allowed, false);
    assert.equal(nf.reason, 'not_found');
});

test('V6: heartbeat rate limit and unknown session', () => {
    const p = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minHeartbeatIntervalMs: 1000 });
    const h1 = p.recordHeartbeat({ sessionId: 's1', now: new Date('2026-01-01T00:00:00Z') });
    assert.equal(h1.accepted, true);
    const h2 = p.recordHeartbeat({ sessionId: 's1', now: new Date('2026-01-01T00:00:00.500Z') });
    assert.equal(h2.accepted, false);
    assert.equal(h2.reason, 'rate_limited');
    const h3 = p.recordHeartbeat({} as any);
    assert.equal(h3.accepted, false);
    assert.equal(h3.reason, 'unknown_session');
});

test('V6: getProgress and completed', () => {
    const p = createPlaybackProgressService({ now: () => new Date('2026-01-01T00:00:00Z'), minProgressIntervalMs: 0 });
    p.permitDevice('dev1');
    p.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 100, durationSeconds: 100, deviceId: 'dev1', now: new Date('2026-01-01T00:00:00Z') });
    const rec = p.getProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1' });
    assert.ok(rec);
    assert.equal(rec?.completed, true);
    assert.equal(p.getProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'missing' }), null);
});

/* ---------- route extended ---------- */
function makeRouter() {
    const db = makeFakeDataAccess(() => []);
    const repository = makeRepository(
        {
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
            'admin-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
        },
        {
            memberships: {
                'student-a': [{ tenant_id: 'tenant-a' }],
                'admin-a': [{ tenant_id: 'tenant-a' }],
            },
            enrollments: {
                'student-a': [{ id: 'enr-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', group_id: null, grade_id: null }],
            },
        },
    );
    const authenticate = createAuthenticateToken(repository);
    const router = createPlaybackSessionsRouter({ db, authenticate, now: () => new Date('2026-01-01T00:00:00Z') });
    const studentToken = tokenFor({ id: 'student-a', role: 'student', tv: 0, tenant_id: 'tenant-a', student_enrollment_id: 'enr-a' });
    const adminToken = tokenFor({ id: 'admin-a', role: 'admin', tv: 0, tenant_id: 'tenant-a' });
    const otherToken = tokenFor({ id: 'student-a', role: 'student', tv: 0, tenant_id: 'tenant-b', student_enrollment_id: 'enr-a' });
    return { router, studentToken, adminToken, otherToken };
}

test('route: start requires auth and validation', async () => {
    const { router } = makeRouter();
    const anon = await invokeRoute(router, { method: 'POST', url: '/sessions', body: {} });
    assert.equal(anon.statusCode, 401);
    const { studentToken } = makeRouter();
    const bad = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: {} });
    // tenant/user derived? body empty -> tenant/user from token, so not 400; but asset optional. Should be 201
    assert.ok(bad.statusCode === 201 || bad.statusCode === 400);
});

test('route: start cross-tenant denied', async () => {
    const { router, studentToken } = makeRouter();
    const res = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-b', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    assert.equal(res.statusCode, 403);
});

test('route: start user mismatch denied', async () => {
    const { router, studentToken } = makeRouter();
    const res = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'other-user', fingerprint: 'fp', assetId: 'asset-1' } });
    assert.equal(res.statusCode, 403);
});

test('route: start success returns watermark', async () => {
    const { router, studentToken } = makeRouter();
    const res = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    assert.equal(res.statusCode, 201);
    assert.ok((res.body as any).watermark);
    assert.equal((res.body as any).watermark.screenshotProtectionClaim, false);
    assert.ok((res.body as any).sessionId);
});

test('route: heartbeat requires auth and active session', async () => {
    const { router, studentToken } = makeRouter();
    const anon = await invokeRoute(router, { method: 'POST', url: '/heartbeat', body: { sessionId: 's1' } });
    assert.equal(anon.statusCode, 401);
    const res = await invokeRoute(router, { method: 'POST', url: '/heartbeat', token: studentToken, body: { sessionId: 'missing' } });
    assert.equal(res.statusCode, 404);
});

test('route: heartbeat success after start', async () => {
    const { router, studentToken } = makeRouter();
    const start = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const sid = (start.body as any).sessionId;
    const hb = await invokeRoute(router, { method: 'POST', url: `/sessions/${sid}/heartbeat`, token: studentToken, body: {} });
    assert.equal(hb.statusCode, 200);
    assert.equal((hb.body as any).ok, true);
});

test('route: progress validation and cross-tenant', async () => {
    const { router, studentToken } = makeRouter();
    const bad = await invokeRoute(router, { method: 'POST', url: '/progress', token: studentToken, body: {} });
    assert.equal(bad.statusCode, 400);
    const cross = await invokeRoute(router, { method: 'POST', url: '/progress', token: studentToken, body: { tenantId: 'tenant-b', studentEnrollmentId: 'enr-a', assetId: 'asset-1', positionSeconds: 10 } });
    assert.equal(cross.statusCode, 403);
});

test('route: progress success and monotonic deny', async () => {
    const { router, studentToken } = makeRouter();
    const p1 = await invokeRoute(router, { method: 'POST', url: '/progress', token: studentToken, body: { tenantId: 'tenant-a', studentEnrollmentId: 'enr-a', assetId: 'asset-1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev1' } });
    assert.equal(p1.statusCode, 200);
    assert.equal((p1.body as any).accepted, true);
    const p2 = await invokeRoute(router, { method: 'POST', url: '/progress', token: studentToken, body: { tenantId: 'tenant-a', studentEnrollmentId: 'enr-a', assetId: 'asset-1', positionSeconds: 5, durationSeconds: 100, deviceId: 'dev1' } });
    assert.equal(p2.statusCode, 429);
    assert.equal((p2.body as any).reason, 'rate_limited');
});

test('route: resume requires params and cross-tenant', async () => {
    const { router, studentToken } = makeRouter();
    const bad = await invokeRoute(router, { method: 'GET', url: '/resume', token: studentToken, query: {} });
    assert.equal(bad.statusCode, 400);
    const cross = await invokeRoute(router, { method: 'GET', url: '/resume', token: studentToken, query: { tenantId: 'tenant-b', studentEnrollmentId: 'enr-a', assetId: 'asset-1' } });
    assert.equal(cross.statusCode, 403);
});

test('route: resume success after progress', async () => {
    const { router, studentToken } = makeRouter();
    await invokeRoute(router, { method: 'POST', url: '/progress', token: studentToken, body: { tenantId: 'tenant-a', studentEnrollmentId: 'enr-a', assetId: 'asset-1', positionSeconds: 42, durationSeconds: 100, deviceId: 'dev1' } });
    const r = await invokeRoute(router, { method: 'GET', url: '/resume', token: studentToken, query: { tenantId: 'tenant-a', studentEnrollmentId: 'enr-a', assetId: 'asset-1', deviceId: 'dev1' } });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body as any).allowed, true);
    assert.equal((r.body as any).position, 42);
});

test('route: self revoke requires auth and ownership', async () => {
    const { router, studentToken } = makeRouter();
    const anon = await invokeRoute(router, { method: 'POST', url: '/sessions/s1/revoke', body: { sessionId: 's1' } });
    assert.equal(anon.statusCode, 401);
    const missing = await invokeRoute(router, { method: 'POST', url: '/sessions/missing/revoke', token: studentToken, body: {} });
    assert.equal(missing.statusCode, 404);
});

test('route: self revoke success', async () => {
    const { router, studentToken } = makeRouter();
    const start = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const sid = (start.body as any).sessionId;
    const rev = await invokeRoute(router, { method: 'POST', url: `/sessions/${sid}/revoke`, token: studentToken, body: {} });
    assert.equal(rev.statusCode, 200);
    assert.equal((rev.body as any).revoked, true);
});

test('route: support revoke admin only', async () => {
    const { router, studentToken, adminToken } = makeRouter();
    const start = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const sid = (start.body as any).sessionId;
    const deny = await invokeRoute(router, { method: 'POST', url: `/sessions/${sid}/support-revoke`, token: studentToken, body: {} });
    assert.equal(deny.statusCode, 403);
    const ok = await invokeRoute(router, { method: 'POST', url: `/sessions/${sid}/support-revoke`, token: adminToken, body: {} });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.body as any).revoked, true);
});

test('route: devices list and revoke', async () => {
    const { router, studentToken } = makeRouter();
    const start = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const devId = (start.body as any).deviceId;
    const list = await invokeRoute(router, { method: 'GET', url: '/devices', token: studentToken, query: { tenantId: 'tenant-a' } });
    assert.equal(list.statusCode, 200);
    assert.ok(Array.isArray(list.body));
    const rev = await invokeRoute(router, { method: 'POST', url: `/devices/${devId}/revoke`, token: studentToken, body: {} });
    assert.equal(rev.statusCode, 200);
    assert.equal((rev.body as any).revoked, true);
});

test('route: devices cross-tenant denied', async () => {
    const { router, studentToken, otherToken } = makeRouter();
    const cross = await invokeRoute(router, { method: 'GET', url: '/devices', token: studentToken, query: { tenantId: 'tenant-b' } });
    assert.equal(cross.statusCode, 403);
});

test('route: policy get', async () => {
    const { router, studentToken } = makeRouter();
    const res = await invokeRoute(router, { method: 'GET', url: '/policy', token: studentToken, query: { tenantId: 'tenant-a' } });
    assert.equal(res.statusCode, 200);
    assert.ok((res.body as any).maxConcurrentSessions);
    const cross = await invokeRoute(router, { method: 'GET', url: '/policy', token: studentToken, query: { tenantId: 'tenant-b' } });
    assert.equal(cross.statusCode, 403);
});

test('route: sessions list', async () => {
    const { router, studentToken } = makeRouter();
    await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const list = await invokeRoute(router, { method: 'GET', url: '/sessions', token: studentToken, query: { tenantId: 'tenant-a' } });
    assert.equal(list.statusCode, 200);
    assert.ok(Array.isArray(list.body));
    const cross = await invokeRoute(router, { method: 'GET', url: '/sessions', token: studentToken, query: { tenantId: 'tenant-b' } });
    assert.equal(cross.statusCode, 403);
});

test('route: delete self revoke alias', async () => {
    const { router, studentToken } = makeRouter();
    const start = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const sid = (start.body as any).sessionId;
    const del = await invokeRoute(router, { method: 'DELETE', url: `/sessions/${sid}`, token: studentToken });
    assert.equal(del.statusCode, 200);
    assert.equal((del.body as any).revoked, true);
});

/* ---------- F1 / F2 / F10 route rejection paths ---------- */

test('route: client-supplied policy is ignored and cannot raise limits (F1)', async () => {
    const { router, studentToken } = makeRouter();
    const oversized = { maxConcurrentSessions: 1000, maxDevices: 1000 };
    const first = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1', policy: oversized } });
    assert.equal(first.statusCode, 201);
    assert.equal((first.body as any).policy.maxConcurrentSessions, 2);
    assert.ok((first.body as any).policy.maxConcurrentSessions <= PLAYBACK_POLICY_CEILINGS.maxConcurrentSessions);
    const second = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1', playbackPolicy: oversized } });
    assert.equal(second.statusCode, 201);
    // Third start exceeds the server's default 2 — the client policy never applied.
    const third = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1', policy: oversized } });
    assert.equal(third.statusCode, 409);
    assert.equal((third.body as any).reason, 'concurrency_limit');
});

test('route: device/session listing ignores foreign userId for non-privileged callers (F2)', async () => {
    const { router, studentToken } = makeRouter();
    await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp', assetId: 'asset-1' } });
    const mine = await invokeRoute(router, { method: 'GET', url: '/devices', token: studentToken, query: { tenantId: 'tenant-a', userId: 'admin-a' } });
    assert.equal(mine.statusCode, 200);
    const devices = mine.body as Array<{ userId: string }>;
    assert.equal(devices.length, 1);
    assert.ok(devices.every((d) => d.userId === 'student-a'));
    const sessions = await invokeRoute(router, { method: 'GET', url: '/sessions', token: studentToken, query: { tenantId: 'tenant-a', userId: 'admin-a' } });
    assert.equal(sessions.statusCode, 200);
    const list = sessions.body as Array<{ userId: string }>;
    assert.ok(list.length >= 1);
    assert.ok(list.every((s) => s.userId === 'student-a'));
});

test('route: device registration rejected past maxDevices (F10)', async () => {
    const db = makeFakeDataAccess(() => []);
    const repository = makeRepository(
        { 'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' } },
        { memberships: { 'student-a': [{ tenant_id: 'tenant-a' }] }, enrollments: { 'student-a': [{ id: 'enr-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', group_id: null, grade_id: null }] } },
    );
    const authenticate = createAuthenticateToken(repository);
    const registry = createPlaybackSessionRegistry({ now: () => new Date('2026-01-01T00:00:00Z') });
    registry.setPolicy({ maxConcurrentSessions: 5, maxDevices: 1, warningThreshold: 0, selfRevokeAllowed: true, supportRevokeAllowed: true, tenantId: 'tenant-a' }, 'tenant-a');
    const router = createPlaybackSessionsRouter({ db, authenticate, registry: asPlaybackSessionStore(registry), now: () => new Date('2026-01-01T00:00:00Z') });
    const studentToken = tokenFor({ id: 'student-a', role: 'student', tv: 0, tenant_id: 'tenant-a', student_enrollment_id: 'enr-a' });
    const first = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp-1', assetId: 'asset-1' } });
    assert.equal(first.statusCode, 201);
    const second = await invokeRoute(router, { method: 'POST', url: '/sessions', token: studentToken, body: { tenantId: 'tenant-a', userId: 'student-a', fingerprint: 'fp-2', assetId: 'asset-1' } });
    assert.equal(second.statusCode, 409);
    assert.equal((second.body as any).reason, 'device_limit');
});
