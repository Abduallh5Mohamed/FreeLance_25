/**
 * M1 media/socket security regressions (hermetic: no DB, env, or network).
 *
 * Coverage map:
 *  - videos.ts: verified course-upload policy (capability + membership +
 *    ownership) and the tenant-scope predicate.
 *  - rate-limit.ts: trusted-proxy X-Forwarded-For resolution.
 *  - video-security.ts: suspension window evaluation + fail-closed lookup.
 *  - video-processor.ts: pure tenant-scope predicate.
 *  - secure-video.ts: session-creation authorization (no early tenant-only
 *    filter; preview offer short of full content), token/session/asset
 *    binding, and the delivery recheck on manifest/segment/key paths.
 * Premium-lecture router, socket handlers, and static wiring regressions are
 * in the second section below.
 */
import { test } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { RequestHandler, Router } from 'express';
import type { CourseUploadPolicyReader } from '../src/routes/videos';
import type {
    DeliveryAccessDeps,
    DeliverySession,
    SessionAccessDeps,
    SessionEntitlementDecision,
    VideoLessonAssociation,
    VideoParentReader,
} from '../src/routes/secure-video';
import type {
    PlaybackEntitlementRecord,
    PlaybackEntitlementService,
    PlaybackTokenClaims,
} from '../src/services/playback-entitlement';
import { resolveClientAddress, trustedProxyAddresses } from '../src/middleware/rate-limit';
import { evaluateSuspensionWindow, isUserSuspended } from '../src/services/video-security';

/**
 * Routes that (transitively) construct the MinIO client require credentials
 * at import time. Hermetic dummies are set BEFORE those modules load; the
 * MinIO client and the MySQL pool are both lazy, so no connection is opened.
 */
process.env.MINIO_ACCESS_KEY ??= 'test-access-key';
process.env.MINIO_SECRET_KEY ??= 'test-secret-key';

const { evaluateCourseUploadPolicy, VIDEO_UPLOAD_ROLE_KEYS } =
    require('../src/routes/videos') as typeof import('../src/routes/videos');
const { isVideoInTenantScope } =
    require('../src/services/video-processor') as typeof import('../src/services/video-processor');
const {
    evaluateSessionAccess,
    evaluateDeliveryAccess,
    isMediaSessionBound,
    evaluatePreviewOffer,
    createSecureVideoDeliveryRouter,
    evaluateSessionEntitlement,
    resolveVideoLessonAssociation,
} = require('../src/routes/secure-video') as typeof import('../src/routes/secure-video');

const src = (relative: string): string =>
    readFileSync(join(__dirname, '..', 'src', relative), 'utf8');

// ---------------------------------------------------------------------------
// Course upload policy: deny-by-default, capability + membership + ownership
// ---------------------------------------------------------------------------

const policyReader = (fixtures: {
    course?: { id: string; tenant_id: string | null; instructor_id: string | null } | null;
    membershipRoleKey?: string | null;
    tenantOwner?: { id: string } | null;
}): CourseUploadPolicyReader => ({
    loadCourse: async () => fixtures.course ?? null,
    loadActiveTeachingMembership: async () =>
        fixtures.membershipRoleKey ? { role_key: fixtures.membershipRoleKey } : null,
    loadTenantOwner: async () => fixtures.tenantOwner ?? null,
});

const course = { id: 'course-1', tenant_id: 'tenant-1', instructor_id: 'instructor-1' };

test('upload policy: student identity (no teaching membership) is denied', async () => {
    const decision = await evaluateCourseUploadPolicy({ id: 'student-1' }, 'course-1',
        policyReader({ course, membershipRoleKey: null }));
    assert.equal(decision, 'forbidden');
});

test('upload policy: member of another tenant is denied', async () => {
    // A membership in tenant-2 never grants uploads into tenant-1's course.
    const decision = await evaluateCourseUploadPolicy({ id: 'outsider-1' }, 'course-1',
        policyReader({ course, membershipRoleKey: null }));
    assert.equal(decision, 'forbidden');
});

test('upload policy: tenant member without course ownership is denied', async () => {
    // Active teaching membership but neither assigned instructor nor owner.
    const decision = await evaluateCourseUploadPolicy({ id: 'assistant-1' }, 'course-1',
        policyReader({ course, membershipRoleKey: 'instructor', tenantOwner: null }));
    assert.equal(decision, 'forbidden');
});

test('upload policy: non-teaching membership role key is denied', async () => {
    const decision = await evaluateCourseUploadPolicy({ id: 'assistant-1' }, 'course-1',
        policyReader({ course, membershipRoleKey: 'assistant', tenantOwner: null }));
    assert.equal(decision, 'forbidden');
});

test('upload policy: assigned course instructor is allowed', async () => {
    const decision = await evaluateCourseUploadPolicy({ id: 'instructor-1' }, 'course-1',
        policyReader({ course, membershipRoleKey: 'instructor', tenantOwner: null }));
    assert.equal(decision, 'allowed');
});

test('upload policy: tenant owner (even when not assigned) is allowed', async () => {
    const decision = await evaluateCourseUploadPolicy({ id: 'owner-1' }, 'course-1',
        policyReader({ course, membershipRoleKey: 'owner', tenantOwner: { id: 'tenant-1' } }));
    assert.equal(decision, 'allowed');
});

test('upload policy: missing course reports not found (no capability bypass)', async () => {
    const decision = await evaluateCourseUploadPolicy({ id: 'instructor-1' }, 'course-x',
        policyReader({ course: null }));
    assert.equal(decision, 'course_not_found');
});

test('upload policy: course without a tenant is denied (no unowned scope)', async () => {
    const decision = await evaluateCourseUploadPolicy({ id: 'instructor-1' }, 'course-1',
        policyReader({ course: { ...course, tenant_id: null }, membershipRoleKey: 'instructor' }));
    assert.equal(decision, 'forbidden');
});

test('upload policy: only teaching role keys carry the upload capability', () => {
    assert.deepEqual([...VIDEO_UPLOAD_ROLE_KEYS], ['owner', 'instructor']);
});

// ---------------------------------------------------------------------------
// Tenant-scope predicate (video-processor deletes)
// ---------------------------------------------------------------------------

test('tenant scope: equal tenants match, missing/other tenants do not', () => {
    assert.equal(isVideoInTenantScope('tenant-1', 'tenant-1'), true);
    assert.equal(isVideoInTenantScope('tenant-2', 'tenant-1'), false);
    assert.equal(isVideoInTenantScope(null, 'tenant-1'), false);
    assert.equal(isVideoInTenantScope('tenant-1', null), false);
    assert.equal(isVideoInTenantScope(null, undefined), false);
});

// ---------------------------------------------------------------------------
// Rate limiting: X-Forwarded-For is attacker-controlled without a trusted peer
// ---------------------------------------------------------------------------

const fakeReq = (overrides: {
    ip?: string;
    remoteAddress?: string;
    forwardedFor?: string;
}): Parameters<typeof resolveClientAddress>[0] => ({
    ip: overrides.ip,
    socket: { remoteAddress: overrides.remoteAddress } as never,
    headers: overrides.forwardedFor ? { 'x-forwarded-for': overrides.forwardedFor } : {},
} as never);

test('rate limit: XFF is ignored unless the direct peer is a trusted proxy', () => {
    const previous = process.env.TRUSTED_PROXIES;
    try {
        delete process.env.TRUSTED_PROXIES;
        assert.equal(trustedProxyAddresses().size, 0);
        // Untrusted peer: the spoofed header must not influence the key.
        assert.equal(resolveClientAddress(fakeReq({ ip: '9.9.9.9', forwardedFor: '1.2.3.4' })), '9.9.9.9');

        process.env.TRUSTED_PROXIES = '10.0.0.7';
        assert.equal(trustedProxyAddresses().has('10.0.0.7'), true);
        // Trusted peer: the left-most XFF entry becomes the client address.
        assert.equal(
            resolveClientAddress(fakeReq({ ip: '10.0.0.7', forwardedFor: '1.2.3.4, 10.0.0.7' })),
            '1.2.3.4',
        );
        // A different peer still cannot spoof.
        assert.equal(resolveClientAddress(fakeReq({ ip: '8.8.8.8', forwardedFor: '1.2.3.4' })), '8.8.8.8');
    } finally {
        if (previous === undefined) delete process.env.TRUSTED_PROXIES;
        else process.env.TRUSTED_PROXIES = previous;
    }
});

// ---------------------------------------------------------------------------
// Suspension windows: boundary semantics and fail-closed lookup
// ---------------------------------------------------------------------------

test('suspension window: NULL/past/equal are inactive, only the future suspends', () => {
    // Mirrors ACTIVE_SUSPENSION_PREDICATE_SQL (shipped source of truth):
    // suspended_until IS NOT NULL AND suspended_until > UTC_TIMESTAMP().
    const now = new Date('2026-10-13T00:00:00.000Z');
    assert.equal(evaluateSuspensionWindow(null, now).suspended, false);
    assert.equal(evaluateSuspensionWindow('2026-10-12T23:59:59Z', now).suspended, false);
    assert.equal(evaluateSuspensionWindow('2026-10-13T00:00:00Z', now).suspended, false);
    assert.equal(evaluateSuspensionWindow('2026-10-13T00:00:01Z', now).suspended, true);
    // Unparseable value fails closed, matching the shipped predicate mirror.
    assert.equal(evaluateSuspensionWindow(new Date('not-a-date'), now).suspended, true);
});

test('suspension lookup: a future window suspends with its reason', async () => {
    const result = await isUserSuspended('user-1', async () => ({
        suspended_until: '2999-01-01T00:00:00Z',
        suspension_reason: 'security review',
    }));
    assert.equal(result.suspended, true);
    assert.equal(result.reason, 'security review');
});

test('suspension lookup: a reader failure fails CLOSED (never grants playback)', async () => {
    const result = await isUserSuspended('user-1', async () => {
        throw new Error('lookup failed');
    });
    assert.equal(result.suspended, true);
    assert.equal(result.reason, 'suspension_check_unavailable');
});

// ---------------------------------------------------------------------------
// Premium-lecture router: ownership/verified-capability authorization
// (production wiring is the default export; these drive the real handlers
// through injected deps, so no database is touched)
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { createPremiumLectureRouter, type PremiumLectureRouterDeps } from '../src/routes/premium-lectures';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import { createSocketIO, createSocketPrincipalResolver, type SocketDeps } from '../src/services/socket';
import type { PrincipalRepository } from '../src/security/principal-repository';

interface CapturedResponse {
    capturedStatus?: number;
    capturedBody?: unknown;
}

const createResponse = (): { response: CapturedResponse; res: never } => {
    const response: CapturedResponse = {};
    const res = {
        status(code: number) { response.capturedStatus = code; return res; },
        json(body: unknown) { response.capturedBody = body; return res; },
        send(body: unknown) { response.capturedBody = body; return res; },
        set() { return res; },
    };
    return { response, res: res as never };
};

const dispatchAndSettle = async (
    router: unknown,
    req: Record<string, unknown>,
): Promise<{ response: CapturedResponse; nextCalled: boolean }> => {
    const { response, res } = createResponse();
    let nextCalled = false;
    const dispatch = router as (rq: unknown, rs: unknown, nx: unknown) => Promise<void>;
    await dispatch(req, res, () => { nextCalled = true; });
    const deadline = Date.now() + 5000;
    while (response.capturedStatus === undefined && response.capturedBody === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { response, nextCalled };
};

const premiumUsers: Record<string, Record<string, unknown>> = {
    'owner-token': { id: 'owner-1', role: 'instructor', instructorId: 'instructor-1', tenantId: 'tenant-1' },
    'outsider-token': { id: 'outsider-1', role: 'instructor', instructorId: 'instructor-2', tenantId: 'tenant-2' },
    'student-token': { id: 'student-1', role: 'student', studentEnrollmentId: 'student-1', tenantId: 'tenant-1', groupId: 'group-1' },
    'platform-token': { id: 'super-1', role: 'admin' },
};

const premiumAuthenticate = (req: Record<string, any>, res: any, next: () => void) => {
    const token = String(req.headers?.authorization || '').replace('Bearer ', '');
    const user = premiumUsers[token];
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }
    req.user = user;
    next();
};

interface PremiumFixtures {
    payments?: Record<string, Record<string, unknown>>;
    ownedLectures?: string[];
    ownedStudents?: string[];
    ownedGroups?: string[];
    platformAdmins?: string[];
}

const makePremiumDeps = (fixtures: PremiumFixtures = {}) => {
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const deps: PremiumLectureRouterDeps = {
        query: async (sql: string) => { executed.push({ sql }); return [] as never[]; },
        queryOne: async (sql: string, params?: unknown[]) => {
            if (sql.includes('FROM premium_lecture_payments WHERE id')) {
                return (fixtures.payments?.[String(params?.[0])] ?? null) as never;
            }
            // Lecture ownership (LECTURE_OWNERSHIP_SQL): params [lectureId, callerId]
            if (sql.includes('g.id = pl.group_id') && sql.includes('t.owner_user_id = ?')) {
                return (fixtures.ownedLectures?.includes(String(params?.[0])) ? { id: params?.[0] } : null) as never;
            }
            // Student ownership (STUDENT_OWNERSHIP_SQL): params [studentId, callerId]
            if (sql.includes('FROM students s') && sql.includes('t.owner_user_id = ?')) {
                return (fixtures.ownedStudents?.includes(String(params?.[0])) ? { id: params?.[0] } : null) as never;
            }
            // Branch validation for the target group (tenant-level fixture).
            if (sql.includes('SELECT id, branch_id, branch_scope FROM `groups` WHERE id = ?')) {
                return ({ id: String(params?.[0]), branch_id: null, branch_scope: 'tenant' }) as never;
            }
            // Group ownership on create: params [groupId, callerId]
            if (sql.includes('FROM `groups` g') && sql.includes('t.owner_user_id = ?')) {
                return (fixtures.ownedGroups?.includes(String(params?.[0])) ? { id: params?.[0] } : null) as never;
            }
            if (sql.includes('FROM students WHERE id')) {
                return ({ id: String(params?.[0]), grade_id: 'grade-1', group_id: 'group-1' }) as never;
            }
            return null as never;
        },
        execute: async (sql: string, params?: unknown[]) => {
            executed.push({ sql, params });
            return { insertId: 1, affectedRows: 1 };
        },
        authenticate: premiumAuthenticate as PremiumLectureRouterDeps['authenticate'],
        hasPlatformCapability: async (userId: string) => (fixtures.platformAdmins ?? []).includes(userId),
        branchAccess: tenantScopeBranchDeps((type, id) =>
            type === 'premium_lecture' ? 'tenant-a' : null),
    };
    return { deps, executed };
};

const premiumRequest = (token: string | null, overrides: Record<string, unknown> = {}) => ({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: {},
    query: {},
    params: {},
    ...overrides,
});

test('premium payments: anonymous approval is denied with 401', async () => {
    const { deps } = makePremiumDeps({ payments: { 'pay-1': { id: 'pay-1', student_id: 'student-1', premium_lecture_id: 'lecture-1', status: 'pending' } } });
    const router = createPremiumLectureRouter(deps);
    const { response } = await dispatchAndSettle(router, premiumRequest(null, { method: 'POST', url: '/payments/pay-1/approve' }));
    assert.equal(response.capturedStatus, 401);
});

test('premium payments: an instructor from another tenant is denied with 403', async () => {
    const { deps, executed } = makePremiumDeps({
        payments: { 'pay-1': { id: 'pay-1', student_id: 'student-1', premium_lecture_id: 'lecture-1', status: 'pending' } },
        ownedLectures: [],
    });
    const router = createPremiumLectureRouter(deps);
    const { response } = await dispatchAndSettle(router, premiumRequest('outsider-token', {
        method: 'POST', url: '/payments/pay-1/approve',
        body: { reviewed_by: 'super-1' },
    }));
    assert.equal(response.capturedStatus, 403);
    assert.equal(executed.some((call) => call.sql.includes('UPDATE premium_lecture_payments')), false);
});

test('premium payments: the owning instructor approves and reviewed_by is the VERIFIED identity', async () => {
    const { deps, executed } = makePremiumDeps({
        payments: { 'pay-1': { id: 'pay-1', student_id: 'student-1', premium_lecture_id: 'lecture-1', status: 'pending' } },
        ownedLectures: ['lecture-1'],
    });
    const router = createPremiumLectureRouter(deps);
    // Body carries a forged reviewer id; the server must ignore it.
    const { response } = await dispatchAndSettle(router, premiumRequest('owner-token', {
        method: 'POST', url: '/payments/pay-1/approve',
        body: { reviewed_by: 'someone-else' },
    }));
    assert.equal(response.capturedStatus, 200); // transactional approve answers with explicit 200 + json
    assert.ok((response.capturedBody as { success?: boolean } | undefined)?.success);
    const update = executed.find((call) => call.sql.includes('UPDATE premium_lecture_payments'));
    assert.ok(update);
    assert.deepEqual(update!.params, ['owner-1', 'pay-1']);
    // Duplicate-payment guard uses INSERT IGNORE (unique_student_lecture dedupes retries).
    assert.ok(executed.some((call) => call.sql.includes('INSERT IGNORE INTO premium_lecture_access')));
});

test('premium payments: a verified platform admin may approve any payment', async () => {
    const { deps } = makePremiumDeps({
        payments: { 'pay-2': { id: 'pay-2', student_id: 'student-9', premium_lecture_id: 'lecture-9', status: 'pending' } },
        ownedLectures: [],
        platformAdmins: ['super-1'],
    });
    const router = createPremiumLectureRouter(deps);
    const { response } = await dispatchAndSettle(router, premiumRequest('platform-token', {
        method: 'POST', url: '/payments/pay-2/reject',
        body: { rejection_reason: 'fraud' },
    }));
    assert.equal(response.capturedStatus, undefined); // success path answers with json only
    assert.ok((response.capturedBody as { success?: boolean } | undefined)?.success);
});

test('premium payments: students cannot list payment requests', async () => {
    const { deps } = makePremiumDeps();
    const router = createPremiumLectureRouter(deps);
    const { response } = await dispatchAndSettle(router, premiumRequest('student-token', { method: 'GET', url: '/payments' }));
    assert.equal(response.capturedStatus, 403);
});

test('premium payments: a teacher list is scoped server-side to their own lectures', async () => {
    const { deps, executed } = makePremiumDeps({ ownedLectures: ['lecture-1'] });
    const router = createPremiumLectureRouter(deps);
    const { response } = await dispatchAndSettle(router, premiumRequest('owner-token', { method: 'GET', url: '/payments' }));
    assert.equal(response.capturedStatus, undefined); // list answers with json only
    assert.ok(Array.isArray(response.capturedBody));
    const listCall = executed.find((call) => call.sql.includes('FROM premium_lecture_payments'));
    assert.ok(listCall);
    assert.match(listCall!.sql, /EXISTS \([\s\S]*tt\.owner_user_id = \?/);
});

test('premium lectures: a stranger cannot read a student library, the student can', async () => {
    const { deps } = makePremiumDeps({ ownedStudents: [] });
    const router = createPremiumLectureRouter(deps);
    const stranger = await dispatchAndSettle(router, premiumRequest('outsider-token', { method: 'GET', url: '/student/student-1/purchased' }));
    assert.equal(stranger.response.capturedStatus, 403);

    const self = await dispatchAndSettle(router, premiumRequest('student-token', { method: 'GET', url: '/student/student-1/purchased' }));
    assert.equal(self.response.capturedStatus, undefined); // list answers with json only
    assert.ok(Array.isArray(self.response.capturedBody));
});

test('premium lectures: creation requires ownership of the target group', async () => {
    const { deps, executed } = makePremiumDeps({ ownedGroups: [] });
    const router = createPremiumLectureRouter(deps);
    const denied = await dispatchAndSettle(router, premiumRequest('owner-token', {
        method: 'POST', url: '/',
        body: { title: 'T', video_url: 'video://x', price: 10, group_id: 'group-9' },
    }));
    assert.equal(denied.response.capturedStatus, 403);
    assert.equal(executed.some((call) => call.sql.includes('INSERT INTO premium_lectures')), false);

    const allowed = makePremiumDeps({ ownedGroups: ['group-1'] });
    const router2 = createPremiumLectureRouter(allowed.deps);
    const created = await dispatchAndSettle(router2, premiumRequest('owner-token', {
        method: 'POST', url: '/',
        body: { title: 'T', video_url: 'video://x', price: 10, group_id: 'group-1', is_published: true },
    }));
    assert.equal(created.response.capturedStatus, 201);
    const insert = allowed.executed.find((call) => call.sql.includes('INSERT INTO premium_lectures'));
    assert.ok(insert);
    // created_by is the verified caller, never a body-supplied value.
    assert.equal(insert!.params?.[10], 'owner-1');
});

// ---------------------------------------------------------------------------
// Socket handlers: live identity bridge, receiver authorization, presence scope
// (real handlers over injected deps; the io instance is driven through its
// EventEmitter surface, so no server port is opened)
// ---------------------------------------------------------------------------

const socketLiveRepository: PrincipalRepository = {
    findUsersIdentity: async () => ({ is_active: 1, token_version: 0, suspension_active: 0 }),
    findStaffIdentity: async () => null,
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async () => [],
};

const socketRevokedRepository: PrincipalRepository = {
    ...socketLiveRepository,
    findUsersIdentity: async () => ({ is_active: 1, token_version: 5, suspension_active: 0 }),
};

test('socket handshake: a revoked token resolves to no principal (fail closed)', async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-media-sockets';
    const token = jwt.sign({ id: 'user-1', role: 'student', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const principal = await createSocketPrincipalResolver(socketRevokedRepository)(token);
    assert.equal(principal, null);
});

test('socket handshake: a live token resolves to its principal', async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-media-sockets';
    const token = jwt.sign({ id: 'user-1', role: 'student', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const principal = await createSocketPrincipalResolver(socketLiveRepository)(token);
    assert.deepEqual(principal, { id: 'user-1', role: 'student' });
});

interface FakeSocket {
    id: string;
    userId?: string;
    userRole?: string;
    handshake: { headers: Record<string, string>; auth: Record<string, unknown> };
    handlers: Map<string, (...args: unknown[]) => Promise<void> | void>;
    rooms: string[];
    emitted: Array<{ event: string; payload: unknown }>;
    on(event: string, handler: (...args: unknown[]) => Promise<void> | void): void;
    join(room: string): void;
    emit(event: string, payload?: unknown): void;
}

const makeFakeSocket = (id: string): FakeSocket => ({
    id,
    handshake: { headers: {}, auth: {} },
    handlers: new Map(),
    rooms: [],
    emitted: [],
    on(event: string, handler: (...args: unknown[]) => Promise<void> | void) {
        this.handlers.set(event, handler);
    },
    join(room: string) { this.rooms.push(room); },
    emit(event: string, payload?: unknown) { this.emitted.push({ event, payload }); },
});

const setupSocket = (options: { relationExists: boolean; related: string[]; messageInsertId?: number }) => {
    const httpServer = createServer();
    const executed: string[] = [];
    const insertedMessageReferences: unknown[] = [];
    const dependentMessageWrites: string[] = [];
    const targetedRooms: string[] = [];
    const deps: SocketDeps = {
        query: async (sql: string, params?: unknown[]) => {
            if (sql.includes('INSERT INTO messages')) { executed.push('insert-message'); return [{ insertId: options.messageInsertId ?? 417 }] as never; }
            if (sql.includes('INSERT INTO message_status') || sql.includes('INSERT INTO conversations')) {
                dependentMessageWrites.push(sql.includes('message_status') ? 'status' : 'conversation');
                insertedMessageReferences.push(...(params ?? []).filter((value) => value === 417));
                return [[]] as never;
            }
            if (sql.includes('user_online_status')) { executed.push('insert-presence'); return [[]] as never; }
            // RELATED_USERS_SQL carries the caller id four times.
            if (Array.isArray(params) && params.length === 4 && params.every((p) => p === params[0])) {
                return [options.related.map((user_id) => ({ user_id }))] as never;
            }
            // MESSAGE_RELATION_SQL carries the six sender/receiver bindings.
            if (Array.isArray(params) && params.length === 6) {
                return [options.relationExists ? [{ 1: 1 }] : []] as never;
            }
            return [[]] as never;
        },
        resolvePrincipal: async () => null,
    };
    const io = createSocketIO(deps)(httpServer);
    (io as unknown as { to: (room: string) => { emit: () => void } }).to = (room: string) => {
        targetedRooms.push(room);
        return { emit: () => undefined };
    };
    const connect = (): FakeSocket => {
        const socket = makeFakeSocket('socket-1');
        // The main namespace emits the connection event (socket.io v4 wiring);
        // emitting it there drives the handlers registered via io.on().
        (io.sockets as unknown as { emitReserved: (event: string, socket: unknown) => void })
            .emitReserved('connection', socket);
        socket.userId = 'user-1'; // handshake middleware already resolved identity
        return socket;
    };
    return { io, httpServer, executed, targetedRooms, insertedMessageReferences, dependentMessageWrites, connect };
};

test('socket messaging: a receiver outside the workspace network is denied before any write', async () => {
    const { io, httpServer, executed, connect } = setupSocket({ relationExists: false, related: ['related-1'] });
    const socket = connect();
    await socket.handlers.get('message:send')!({
        senderId: 'user-1', receiverId: 'stranger-1', content: 'x', messageType: 'text',
    });
    assert.deepEqual(socket.emitted.map((entry) => entry.event), ['message:error']);
    assert.equal(executed.includes('insert-message'), false);
    io.close();
    httpServer.close();
});

test('socket messaging: a related receiver gets the message (the write happens)', async () => {
    const { io, httpServer, executed, targetedRooms, insertedMessageReferences, dependentMessageWrites, connect } = setupSocket({ relationExists: true, related: ['related-1'] });
    const socket = connect();
    await socket.handlers.get('message:send')!({
        senderId: 'user-1', receiverId: 'related-1', content: 'x', messageType: 'text',
    });
    assert.ok(executed.includes('insert-message'));
    assert.deepEqual(dependentMessageWrites, ['status', 'conversation']);
    assert.deepEqual(insertedMessageReferences, [417, 417, 417], 'generated numeric ID is reused by message status and both conversation references');
    assert.ok(targetedRooms.includes('user:related-1'));
    io.close();
    httpServer.close();
});

test('socket messaging: invalid generated IDs stop dependent writes and do not emit a sent event', async () => {
    for (const invalidId of [0, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
        const { io, httpServer, dependentMessageWrites, connect } = setupSocket({
            relationExists: true,
            related: ['related-1'],
            messageInsertId: invalidId,
        });
        const socket = connect();
        await socket.handlers.get('message:send')!({
            senderId: 'forged-sender', receiverId: 'related-1', content: 'x', messageType: 'text',
        });
        assert.deepEqual(dependentMessageWrites, [], `invalid insertId ${String(invalidId)} must not be used as a foreign key`);
        assert.deepEqual(socket.emitted.map((entry) => entry.event), ['message:error']);
        io.close();
        httpServer.close();
    }
});

test('socket presence: status is broadcast only to related users, never globally', async () => {
    const { io, httpServer, targetedRooms, connect } = setupSocket({ relationExists: true, related: ['related-1', 'related-2'] });
    const socket = connect();
    await socket.handlers.get('user:connect')!();
    assert.deepEqual(socket.rooms, ['user:user-1']);
    assert.deepEqual([...targetedRooms].sort(), ['user:related-1', 'user:related-2']);
    io.close();
    httpServer.close();
});

// ---------------------------------------------------------------------------
// Static wiring regressions (adapter-level: the shipped route text must keep
// delegating to the verified checks above; no role-claim gate may return)
// ---------------------------------------------------------------------------

test('wiring: video upload/init delegates to the verified policy with no role gate', () => {
    const videos = src('routes/videos.ts');
    assert.match(videos, /evaluateCourseUploadPolicy\(req\.user!, course_id, courseUploadPolicyReader\)/);
    assert.match(videos, /role_key IN \('owner','instructor'\)/);
    assert.doesNotMatch(videos, /requireRoles/);
    assert.doesNotMatch(videos, /role === 'admin' \|\|/);
});

test('wiring: secure-video carries no admin role-claim bypass', () => {
    const secureVideo = src('routes/secure-video.ts');
    assert.doesNotMatch(secureVideo, /\?=1/);
    assert.doesNotMatch(secureVideo, /role !== 'admin'/);
    assert.doesNotMatch(secureVideo, /\['instructor', 'admin'\]/);
    assert.match(secureVideo, /hasVerifiedPlatformCapability/);
});

test('wiring: premium approvals never take reviewed_by from the request body', () => {
    const premium = src('routes/premium-lectures.ts');
    assert.doesNotMatch(premium, /reviewed_by[^\n]*req\.body/);
    assert.match(premium, /SET status = 'approved', reviewed_by = \?, reviewed_at = NOW\(\)/);
});

test('wiring: materials reads stay authenticated and tenant-scoped', () => {
    const materials = src('routes/materials.ts');
    assert.match(materials, /router\.get\('\/', authenticateToken/);
    assert.match(materials, /hasVerifiedPlatformCapability/);
    assert.match(materials, /course_tenant_id/);
});
// ---------------------------------------------------------------------------
// Video access policy (pure production module; injected fixture repository)
// The exported evaluateVideoAccess IS the production policy — the fixture
// repository tests drive it directly, and the SQL adapter tests below drive
// it through the REAL createSqlVideoAccessRepository over a recording
// executor that mirrors the emitted SQL's WHERE semantics.
// ---------------------------------------------------------------------------

import {
    evaluateVideoAccess,
    createSqlVideoAccessRepository,
    type VideoAccessRepository,
    type VideoAccessScope,
    type VideoAccessVideoRow,
    type VideoAccessLectureRow,
    type VideoAccessCourseRow,
    type VideoAccessStudentRow,
} from '../src/security/video-access-policy';

interface ShareFixture {
    lecture_id: string;
    /** Paid perpetual purchase behind the share (buyer is a users.id). */
    purchase?: { buyer_id: string; lecture_id: string } | null;
    /** Status of the exchange request behind the share (real enum values). */
    request_status?: string | null;
    /**
     * Requester of the exchange request. Defaults to the calling instructor
     * (the share's own instructor); set explicitly to model a completed
     * request raised by a DIFFERENT requester.
     */
    request_requester_id?: string;
    /**
     * Lecture the completed request actually granted; null models a
     * new-style request fulfilled by the selected offer instead.
     */
    request_lecture_id?: string | null;
    /** Accepted-offer fulfillment behind a NULL request lecture. */
    fulfilled_by_offer?: boolean;
    is_published?: boolean;
}

interface VideoPolicyFixtures {
    user?: { id: string; role: string; phone: string | null; is_active: boolean | number } | null;
    video?: VideoAccessVideoRow | null;
    lecture?: VideoAccessLectureRow | null;
    course?: VideoAccessCourseRow | null;
    /** Status of the video resource's tenant (denies ownership when not active). */
    tenantStatus?: string;
    /** Caller id that resolves to an ACTIVE authority row in the tenant. */
    authorityUserId?: string | null;
    /** Kind of the authority row ('owner' = verified center owner). */
    authority?: 'owner' | 'instructor';
    share?: ShareFixture | null;
    student?: VideoAccessStudentRow | null;
    /** Group a verified share was published to. */
    publishedGroupId?: string | null;
    /** Exact student purchase license holder (enrollment + video). */
    purchasedBy?: { studentId: string; videoId: string } | null;
}

const defaultLecture = (instructorId: string | null): VideoAccessLectureRow => ({
    id: 'lecture-1',
    instructor_id: instructorId,
    grade_id: 'grade-1',
    group_id: 'group-1',
    is_published: true,
    archived_at: null,
});

const defaultStudent = (overrides: Partial<VideoAccessStudentRow> = {}): VideoAccessStudentRow => ({
    id: 'enroll-1',
    tenant_id: 'tenant-1',
    tenant_status: 'active',
    grade_id: 'grade-1',
    group_id: 'group-1',
    instructor_id: 'teacher-y',
    ...overrides,
});

/**
 * Fixture repository that mirrors the production repository's semantics:
 * the share/publication reads apply the same verified-license predicate the
 * SQL does, so expired/unverified licenses realistically return no row.
 */
const videoAccessRepo = (fixtures: VideoPolicyFixtures = {}): VideoAccessRepository => {
    const verifiedShare = (userId: string, lectureId: string): boolean => {
        const share = fixtures.share;
        if (!share || share.lecture_id !== lectureId) return false;
        if (share.purchase) {
            return share.purchase.buyer_id === userId && share.purchase.lecture_id === lectureId;
        }
        // Approved exchange: the completed request must belong to THIS
        // instructor and grant exactly this lecture; a NULL request lecture
        // is proven only by the accepted-offer fulfillment (never by the
        // completed status alone).
        if (share.request_status !== 'completed') return false;
        if ((share.request_requester_id ?? userId) !== userId) return false;
        if (share.request_lecture_id === null) return share.fulfilled_by_offer === true;
        return (share.request_lecture_id ?? share.lecture_id) === share.lecture_id;
    };
    return {
        loadUser: async () => (fixtures.user === undefined
            ? { id: 'viewer-1', role: 'student', phone: '0100', is_active: 1 }
            : fixtures.user),
        loadVideo: async () => (fixtures.video === undefined
            ? { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: null }
            : fixtures.video),
        hasPlatformCapability: async () => fixtures.user?.id === 'super-1',
        loadLecture: async () => (fixtures.lecture === undefined ? null : fixtures.lecture),
        loadCourse: async () => (fixtures.course === undefined ? null : fixtures.course),
        loadActiveTenantAuthority: async (_userId, tenantId) => {
            if ((fixtures.tenantStatus ?? 'active') !== 'active') return null;
            if (!fixtures.authorityUserId || fixtures.authorityUserId !== _userId || !tenantId) return null;
            return { authority: fixtures.authority ?? 'instructor' };
        },
        loadInstructorShare: async (userId, lectureId) =>
            (verifiedShare(userId, lectureId) ? { id: 'share-1', license_kind: 'purchase' as const } : null),
        loadStudent: async () => (fixtures.student === undefined ? null : fixtures.student),
        loadSharedPublication: async (lectureId, instructorId, groupId) => {
            if (fixtures.publishedGroupId !== groupId) return null;
            if (!fixtures.share || fixtures.share.is_published !== true) return null;
            return verifiedShare(instructorId, lectureId) ? { id: 'pub-1' } : null;
        },
        loadStudentPurchase: async (studentEnrollmentId, videoId) =>
            (fixtures.purchasedBy && fixtures.purchasedBy.studentId === studentEnrollmentId
                && fixtures.purchasedBy.videoId === videoId ? { id: 'license-1' } : null),
    };
};

const studentScope: VideoAccessScope = { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' };

test('video policy: a missing user or video row is denied', async () => {
    assert.equal(await evaluateVideoAccess('ghost', 'video-1', studentScope,
        videoAccessRepo({ user: null })), false);
    assert.equal(await evaluateVideoAccess('viewer-1', 'video-x', studentScope,
        videoAccessRepo({ video: null })), false);
});

test('video policy: a bare admin role claim is denied; the verified platform capability allows', async () => {
    // Role claim alone: no verified capability and no other grant.
    assert.equal(await evaluateVideoAccess('admin-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'admin-1', role: 'admin', phone: null, is_active: 1 },
    })), false);
    // Verified capability (active super_admin or a seeded permission key).
    assert.equal(await evaluateVideoAccess('super-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'super-1', role: 'admin', phone: null, is_active: 1 },
    })), true);
});

test('video policy: a revoked (inactive) user keeps no entitlement', async () => {
    // Even the lecture owner and the verified capability path route through
    // an active identity check first.
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 0 },
        lecture: defaultLecture('teacher-x'),
        authorityUserId: 'teacher-x',
    })), false);
});

test('video policy: the uploader keeps access while their authority is live', async () => {
    assert.equal(await evaluateVideoAccess('uploader-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'uploader-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: 'uploader-1' },
        authorityUserId: 'uploader-1',
    })), true);
});

test('video policy: an uploader whose membership was revoked is denied', async () => {
    assert.equal(await evaluateVideoAccess('uploader-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'uploader-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: 'uploader-1' },
        authorityUserId: 'owner-1',
    })), false);
});

test('video policy: an unscoped legacy video grants no ownership path', async () => {
    // No video tenant and no course tenant: the assignment cannot be tied to
    // an active tenant authority, so ownership denies (deny-by-default).
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: null, course_id: null, uploaded_by: 'teacher-x' },
        lecture: defaultLecture('teacher-x'),
        authorityUserId: 'teacher-x',
    })), false);
});

test('video policy: same-center teacher X is denied on teacher Y lesson (no blanket membership)', async () => {
    // X and Y teach inside the same center; the lesson belongs to Y and the
    // course is assigned to Y. Membership in that center grants nothing.
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-y'),
        course: { instructor_id: 'teacher-y', tenant_id: 'tenant-1', is_active: 1 },
        authorityUserId: 'owner-1',
    })), false);
});

test('video policy: staff inside the video tenant is denied', async () => {
    assert.equal(await evaluateVideoAccess('staff-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'staff-1', role: 'staff', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-y'),
        course: { instructor_id: 'teacher-y', tenant_id: 'tenant-1', is_active: 1 },
        authorityUserId: 'owner-1',
    })), false);
});

test('video policy: an unrelated or expired membership never grants access', async () => {
    // The authority read returns no row for the caller: a member of another
    // tenant (or one whose membership lapsed) is simply denied — only the
    // verified owner/teaching authority row can speak for the center.
    assert.equal(await evaluateVideoAccess('outsider-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'outsider-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-y'),
        authorityUserId: 'owner-1',
    })), false);
});

test('video policy: own lesson, assigned course, and tenant owner are allowed; a mere member is not', async () => {
    // Own lesson.
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-x'),
        authorityUserId: 'teacher-x',
    })), true);
    // Assigned course instructor (video linked to their active course).
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
        course: { instructor_id: 'teacher-x', tenant_id: 'tenant-1', is_active: 1 },
        authorityUserId: 'teacher-x',
    })), true);
    // Verified tenant owner who owns neither the lesson nor the course.
    assert.equal(await evaluateVideoAccess('owner-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'owner-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-y'),
        course: { instructor_id: 'teacher-y', tenant_id: 'tenant-1', is_active: 1 },
        authorityUserId: 'owner-1',
        authority: 'owner',
    })), true);
    // A teaching member who is NOT the owner of that tenant stays denied.
    assert.equal(await evaluateVideoAccess('member-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'member-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-y'),
        course: { instructor_id: 'teacher-y', tenant_id: 'tenant-1', is_active: 1 },
        authorityUserId: 'member-1',
        authority: 'instructor',
    })), false);
});

test('video policy: a legacy role=teacher who is genuinely assigned is honored (no role-string gate)', async () => {
    // Assignment columns are the schema authority, so the legacy users.role
    // string neither grants nor blocks on its own.
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'teacher', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-x'),
        authorityUserId: 'teacher-x',
    })), true);
    // The same legacy role with NO assignment stays denied.
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'teacher', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-y'),
        authorityUserId: 'owner-1',
    })), false);
});

test('video policy: a stopped (inactive) tenant denies the ownership path', async () => {
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('teacher-x'),
        authorityUserId: 'teacher-x',
        tenantStatus: 'suspended',
    })), false);
});

test('video policy: an archived course grants no course assignment', async () => {
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1', {}, videoAccessRepo({
        user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
        course: { instructor_id: 'teacher-x', tenant_id: 'tenant-1', is_active: 0 },
        authorityUserId: 'teacher-x',
    })), false);
});

test('video policy: a verified paid purchase license allows the buying instructor for that lesson only', async () => {
    // Paid perpetual purchase naming THIS buyer and THIS lesson.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('seller-1'),
        share: { lecture_id: 'lecture-1', purchase: { buyer_id: 'buyer-1', lecture_id: 'lecture-1' } },
    })), true);
    // Buyer mismatch: the purchase names another user.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('seller-1'),
        share: { lecture_id: 'lecture-1', purchase: { buyer_id: 'someone-else', lecture_id: 'lecture-1' } },
    })), false);
    // Resource mismatch: the purchase names another lesson.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('seller-1'),
        share: { lecture_id: 'lecture-1', purchase: { buyer_id: 'buyer-1', lecture_id: 'lecture-9' } },
    })), false);
    // A share for a DIFFERENT lesson never grants this video.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('seller-1'),
        share: { lecture_id: 'lecture-2', purchase: { buyer_id: 'buyer-1', lecture_id: 'lecture-2' } },
    })), false);
});

test('video policy: an approved exchange allows the buyer; an unapproved one does not', async () => {
    // Approved exchange (request completed after approval).
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        lecture: defaultLecture('seller-1'),
        share: { lecture_id: 'lecture-1', request_status: 'completed' },
    })), true);
    // Still open / awaiting / cancelled / expired grants nothing.
    for (const status of ['open', 'awaiting_requester', 'cancelled_by_owner', 'expired', 'failed_insufficient_balance']) {
        assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
            user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
            lecture: defaultLecture('seller-1'),
            share: { lecture_id: 'lecture-1', request_status: status },
        })), false, `exchange request status ${status} must not grant`);
    }
});

test('video policy: a completed exchange request binds the exact requester and the exact lecture', async () => {
    const buyer = { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 };
    const lessonOf = { lecture: defaultLecture('seller-1') };
    // The completed request was raised by a DIFFERENT instructor.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: buyer, ...lessonOf,
        share: { lecture_id: 'lecture-1', request_status: 'completed', request_requester_id: 'stranger-1' },
    })), false);
    // The completed request grants a DIFFERENT lecture.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: buyer, ...lessonOf,
        share: { lecture_id: 'lecture-1', request_status: 'completed', request_lecture_id: 'lecture-9' },
    })), false);
    // New-style request with a NULL lecture is proven by the accepted offer.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: buyer, ...lessonOf,
        share: { lecture_id: 'lecture-1', request_status: 'completed', request_lecture_id: null, fulfilled_by_offer: true },
    })), true);
    // ... and without that fulfillment it is an ambiguous legacy grant.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: buyer, ...lessonOf,
        share: { lecture_id: 'lecture-1', request_status: 'completed', request_lecture_id: null },
    })), false);
    // Mixed case: a non-null request lecture binds EXCLUSIVELY — an accepted
    // offer naming the shared lecture cannot substitute the request's own
    // (different) lecture_id.
    assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
        user: buyer, ...lessonOf,
        share: { lecture_id: 'lecture-1', request_status: 'completed', request_lecture_id: 'lecture-9', fulfilled_by_offer: true },
    })), false);
});

test('video policy: a proven paid purchase survives the request later changing state', async () => {
    const buyer = { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 };
    // The perpetual license binds buyer + lecture only; the originating
    // request's later state must not revoke it.
    for (const status of ['completed', 'expired', 'cancelled_by_requester', 'failed_insufficient_balance']) {
        assert.equal(await evaluateVideoAccess('buyer-1', 'video-1', {}, videoAccessRepo({
            user: buyer,
            lecture: defaultLecture('seller-1'),
            share: {
                lecture_id: 'lecture-1',
                purchase: { buyer_id: 'buyer-1', lecture_id: 'lecture-1' },
                request_status: status,
            },
        })), true, `paid license must survive request status ${status}`);
    }
});

test('video policy: a published lecture allows the student only inside their own tenant scope', async () => {
    const studentUser = { id: 'student-1', role: 'student', phone: '0100', is_active: 1 };
    // Same tenant, published in scope.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: studentUser, lecture: defaultLecture('teacher-y'), student: defaultStudent(),
    })), true);
    // Same lecture, video in another tenant: denied without a license.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: studentUser, lecture: defaultLecture('teacher-y'), student: defaultStudent(),
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null },
    })), false);
    // An unscoped lecture (no grade and no group) is not broadcast.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: studentUser, student: defaultStudent(),
        lecture: { id: 'lecture-1', instructor_id: 'teacher-y', grade_id: null, group_id: null, is_published: true, archived_at: null },
    })), false);
});

test('video policy: an archived lecture is not naturally visible to students', async () => {
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        lecture: { ...defaultLecture('teacher-y'), archived_at: '2026-10-01T00:00:00Z' },
        student: defaultStudent(),
    })), false);
});

test('video policy: a share published to the student group allows the video across tenants', async () => {
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        lecture: { ...defaultLecture('teacher-y'), is_published: false },
        student: defaultStudent(),
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null },
        share: { lecture_id: 'lecture-1', purchase: { buyer_id: 'teacher-y', lecture_id: 'lecture-1' }, is_published: true },
        publishedGroupId: 'group-1',
    })), true);
});

test('video policy: the exact purchased lecture license allows the entitled enrollment even cross-tenant', async () => {
    const studentUser = { id: 'student-1', role: 'student', phone: '0100', is_active: 1 };
    const buyer = {
        user: studentUser,
        student: defaultStudent(),
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null } as VideoAccessVideoRow,
    };
    // The buyer's own license: allowed across the tenant boundary.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope,
        videoAccessRepo({ ...buyer, purchasedBy: { studentId: 'enroll-1', videoId: 'video-1' } })), true);
    // A license held by another enrollment never grants this student
    // (students-only display; no resale inside the buyer center).
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope,
        videoAccessRepo({ ...buyer, purchasedBy: { studentId: 'enroll-2', videoId: 'video-1' } })), false);
    // A license for another video never exposes the rest of the seller tenant.
    assert.equal(await evaluateVideoAccess('student-1', 'video-2', studentScope,
        videoAccessRepo({ ...buyer, purchasedBy: { studentId: 'enroll-1', videoId: 'video-1' } })), false);
});

test('video policy: the student path requires the server-selected enrollment and workspace', async () => {
    const studentUser = { id: 'student-1', role: 'student', phone: '0100', is_active: 1 };
    // No enrollment selected.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', {}, videoAccessRepo({
        user: studentUser, lecture: defaultLecture('teacher-y'), student: defaultStudent(),
    })), false);
    // Enrollment that does not belong to the caller.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: studentUser, lecture: defaultLecture('teacher-y'), student: null,
    })), false);
    // Enrollment in a tenant other than the authenticated selected workspace.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1',
        { tenantId: 'tenant-9', studentEnrollmentId: 'enroll-1' }, videoAccessRepo({
            user: studentUser, lecture: defaultLecture('teacher-y'), student: defaultStudent(),
        })), false);
    // Enrollment whose own tenant is stopped.
    assert.equal(await evaluateVideoAccess('student-1', 'video-1', studentScope, videoAccessRepo({
        user: studentUser, lecture: defaultLecture('teacher-y'),
        student: defaultStudent({ tenant_status: 'suspended' }),
    })), false);
});

test('video policy: a student purchase license never grants an instructor (licenses are not interchangeable)', async () => {
    // premium_lecture_access is a STUDENT license; the instructor path is
    // only own/assigned lesson or a verified instructor license.
    assert.equal(await evaluateVideoAccess('teacher-x', 'video-1',
        { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' }, videoAccessRepo({
            user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
            lecture: defaultLecture('teacher-y'),
            purchasedBy: { studentId: 'enroll-1', videoId: 'video-1' },
        })), false);
});

// ---------------------------------------------------------------------------
// SQL adapter tests: the REAL createSqlVideoAccessRepository executed over a
// recording executor that mirrors the emitted SQL's WHERE semantics, so the
// predicates/joins themselves (not fixture results) carry the proof.
// ---------------------------------------------------------------------------

interface SqlStore {
    user?: { id: string; role: string; phone: string | null; is_active: boolean | number } | null;
    video?: VideoAccessVideoRow | null;
    course?: VideoAccessCourseRow | null;
    lecture?: VideoAccessLectureRow | null;
    tenants?: Record<string, { status: string; owner_user_id: string | null }>;
    memberships?: Array<{ tenant_id: string; user_id: string; role_key: string; status: string }>;
    share?: {
        instructor_id: string;
        lecture_id: string;
        purchase_id: string | null;
        /**
         * Shorthand for the common case: a request owned by the share's own
         * instructor naming exactly the shared lecture. An explicit `request`
         * row models requester/lecture binding deviations instead.
         */
        request_status?: string | null;
        /** The exchange request row behind the share (real schema fields). */
        request?: {
            id: number;
            requester_id: string;
            owner_id: string;
            /** NULL for new-style requests fulfilled by the selected offer. */
            lecture_id: string | null;
            status: string | null;
        } | null;
        is_published?: boolean;
    } | null;
    /** Offers on the request (accepted offer = fulfillment binding). */
    offers?: Array<{ id: string; request_id: number; lecture_id: string; status: string }>;
    purchases?: Record<string, { id: string; buyer_id: string; lecture_id: string }>;
    publications?: Array<{ shared_lecture_instructor_id: string; lecture_id: string; group_id: string }>;
    student?: {
        id: string; user_id: string; tenant_id: string | null; tenant_status: string;
        grade_id: string | null; group_id: string | null; instructor_id: string | null;
        is_active: boolean; approval_status: string;
    } | null;
    licenses?: Array<{ student_id: string; video_url: string }>;
}

/** The exchange request row behind a share fixture (shorthand normalized). */
const shareRequestOf = (share: NonNullable<SqlStore['share']>) => (share.request !== undefined
    ? share.request
    : (share.request_status == null ? null : {
        id: 1,
        requester_id: share.instructor_id,
        owner_id: 'seller-1',
        lecture_id: share.lecture_id,
        status: share.request_status,
    }));

/**
 * Mirrors VERIFIED_INSTRUCTOR_LICENSE_SQL's exchange branch over the store:
 * a completed request belonging to the share's own instructor that grants
 * exactly the shared lecture — via the request's own lecture_id, or via an
 * 'accepted' offer on that request when lecture_id is NULL (new-style
 * request fulfilled by the selected offer).
 */
const verifiedExchange = (store: SqlStore, share: NonNullable<SqlStore['share']>): boolean => {
    const request = shareRequestOf(share);
    if (!request || request.status !== 'completed') return false;
    if (request.requester_id !== share.instructor_id) return false;
    if (request.lecture_id == null) {
        return (store.offers ?? []).some((offer) =>
            offer.request_id === request.id && offer.status === 'accepted'
            && offer.lecture_id === share.lecture_id);
    }
    return request.lecture_id === share.lecture_id;
};

/**
 * Recording executor mirroring the production SQL semantics: it captures
 * every (sql, params) pair and answers each query shape exactly as the
 * emitted WHERE clauses would.
 */
const makeSqlExecutor = (store: SqlStore) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const queryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
        calls.push({ sql, params });
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (/FROM users WHERE id = \?$/.test(norm)) return (store.user ?? null) as T | null;
        if (/FROM videos WHERE id = \?$/.test(norm)) return (store.video ?? null) as T | null;
        if (/FROM courses WHERE id = \?$/.test(norm)) return (store.course ?? null) as T | null;
        if (/FROM lectures/.test(norm)) return (store.lecture ?? null) as T | null;
        // Active tenant authority: params [tenantId, ownerUserId, memberUserId, memberTenantId]
        if (/UNION ALL/.test(norm) && /tenant_memberships/.test(norm)) {
            const [tenantId, ownerUserId, memberUserId, memberTenantId] = params as string[];
            const tenant = store.tenants?.[tenantId];
            if (!tenant || tenant.status !== 'active') return null;
            if (tenant.owner_user_id === ownerUserId) return { authority: 'owner' } as T;
            const membership = (store.memberships ?? []).find((m) =>
                m.user_id === memberUserId && m.tenant_id === memberTenantId
                && m.status === 'active' && ['owner', 'instructor'].includes(m.role_key));
            return membership ? { authority: membership.role_key } as T : null;
        }
        // Instructor share: params [userId, lectureId, buyerId, purchaseLectureId]
        if (/FROM instructor_shared_lectures sl/.test(norm) && !/publications pub/.test(norm)) {
            const [userId, lectureId, buyerId, purchaseLectureId] = params as string[];
            const share = store.share;
            if (!share || share.instructor_id !== userId || share.lecture_id !== lectureId) return null;
            // Paid perpetual purchase: exact buyer + exact lecture; the
            // request's later state is deliberately irrelevant.
            if (share.purchase_id) {
                const purchase = store.purchases?.[share.purchase_id];
                if (!purchase || purchase.buyer_id !== buyerId || purchase.lecture_id !== purchaseLectureId) return null;
                return { id: 'share-1', license_kind: 'purchase' } as T;
            }
            // Approved exchange: completed request bound to this instructor
            // and exactly this lecture (own lecture_id or accepted offer).
            return verifiedExchange(store, share) ? { id: 'share-1', license_kind: 'exchange' } as T : null;
        }
        // Publication: params [lectureId, instructorId, groupId, shareUserId, shareLectureId]
        if (/publications pub/.test(norm)) {
            const [lectureId, instructorId, groupId, shareUserId, shareLectureId] = params as string[];
            const share = store.share;
            if (!share || share.is_published !== true) return null;
            if (share.instructor_id !== shareUserId || share.lecture_id !== shareLectureId) return null;
            const verified = share.purchase_id
                ? (() => {
                    const p = store.purchases?.[share.purchase_id];
                    return !!p && p.buyer_id === shareUserId && p.lecture_id === shareLectureId;
                })()
                : verifiedExchange(store, share);
            if (!verified) return null;
            const publication = (store.publications ?? []).find((p) =>
                p.shared_lecture_instructor_id === instructorId && p.lecture_id === lectureId && p.group_id === groupId);
            return publication ? { id: 'pub-1' } as T : null;
        }
        // Student enrollment: params [enrollmentId, userId]
        if (/FROM students s/.test(norm)) {
            const student = store.student;
            if (!student || student.id !== params[0] || student.user_id !== params[1]) return null;
            if (!student.is_active || student.approval_status !== 'approved') return null;
            if (student.tenant_status !== 'active') return null;
            return student as T;
        }
        // Student purchase license: params [enrollmentId, videoId]
        if (/premium_lecture_access/.test(norm)) {
            const videoUrl = `video://${params[1]}`;
            const license = (store.licenses ?? []).find((l) =>
                l.student_id === params[0] && l.video_url === videoUrl);
            return license ? { id: 'license-1' } as T : null;
        }
        return null;
    };
    return { queryOne, calls };
};

/** Drive the REAL policy through the REAL SQL repository over fixtures. */
const runSqlPolicy = (
    store: SqlStore,
    userId: string,
    videoId: string,
    scope: VideoAccessScope,
    platformCapability = false,
) => {
    const { queryOne, calls } = makeSqlExecutor(store);
    const repository = createSqlVideoAccessRepository({
        queryOne,
        hasPlatformCapability: async () => platformCapability,
    });
    return { allowed: evaluateVideoAccess(userId, videoId, scope, repository), calls };
};

const sqlCall = (calls: Array<{ sql: string; params: unknown[] }>, pattern: RegExp) => {
    const found = calls.find((call) => pattern.test(call.sql.replace(/\s+/g, ' ')));
    assert.ok(found, `expected a recorded query matching ${pattern}`);
    return found!;
};

const sqlTenantStore: SqlStore = {
    user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
    video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
    lecture: defaultLecture('teacher-x'),
    tenants: { 'tenant-1': { status: 'active', owner_user_id: 'owner-1' } },
    memberships: [{ tenant_id: 'tenant-1', user_id: 'teacher-x', role_key: 'instructor', status: 'active' }],
};

test('sql adapter: own lesson is allowed through the real repository with active membership', async () => {
    const { allowed, calls } = await runSqlPolicy(sqlTenantStore, 'teacher-x', 'video-1', {});
    assert.equal(await allowed, true);
    const authority = sqlCall(calls, /UNION ALL/);
    assert.match(authority.sql, /tenant_memberships/);
    assert.match(authority.sql, /t\.status = 'active'/);
    assert.match(authority.sql, /u\.is_active = 1/);
    assert.match(authority.sql, /role_key IN \('owner','instructor'\)/);
    assert.deepEqual(authority.params, ['tenant-1', 'teacher-x', 'teacher-x', 'tenant-1']);
});

test('sql adapter: revoked membership and stopped tenant deny the ownership path', async () => {
    // Expired membership row.
    const expired = await runSqlPolicy({
        ...sqlTenantStore,
        memberships: [{ tenant_id: 'tenant-1', user_id: 'teacher-x', role_key: 'instructor', status: 'inactive' }],
    }, 'teacher-x', 'video-1', {});
    assert.equal(await expired.allowed, false);
    // Stopped (non-active) tenant.
    const stopped = await runSqlPolicy({
        ...sqlTenantStore,
        tenants: { 'tenant-1': { status: 'suspended', owner_user_id: 'teacher-x' } },
    }, 'teacher-x', 'video-1', {});
    assert.equal(await stopped.allowed, false);
    // Staff membership is not teaching authority.
    const staff = await runSqlPolicy({
        ...sqlTenantStore,
        memberships: [{ tenant_id: 'tenant-1', user_id: 'teacher-x', role_key: 'staff', status: 'active' }],
    }, 'teacher-x', 'video-1', {});
    assert.equal(await staff.allowed, false);
});

test('sql adapter: the instructor share query joins purchase/request evidence and binds buyer+lesson', async () => {
    const store: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
        share: { instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: 'pur-1', request_status: null },
        purchases: { 'pur-1': { id: 'pur-1', buyer_id: 'buyer-1', lecture_id: 'lecture-1' } },
    };
    const { allowed, calls } = await runSqlPolicy(store, 'buyer-1', 'video-1', {});
    assert.equal(await allowed, true);
    const share = sqlCall(calls, /FROM instructor_shared_lectures sl/);
    assert.match(share.sql, /LEFT JOIN video_purchase_transactions p ON p\.id = sl\.purchase_id/);
    assert.match(share.sql, /LEFT JOIN instructor_video_requests r ON r\.id = sl\.request_id/);
    assert.match(share.sql, /p\.buyer_id = \?/);
    assert.match(share.sql, /p\.lecture_id = \?/);
    assert.match(share.sql, /r\.status = 'completed'/);
    // Exact buyer/lesson bindings (caller twice: share owner + purchase buyer).
    assert.deepEqual(share.params, ['buyer-1', 'lecture-1', 'buyer-1', 'lecture-1']);

    const { queryOne } = makeSqlExecutor(store);
    const repository = createSqlVideoAccessRepository({ queryOne, hasPlatformCapability: async () => false });
    assert.deepEqual(await repository.loadInstructorShare('buyer-1', 'lecture-1'),
        { id: 'share-1', license_kind: 'purchase' });
});

test('sql adapter: purchase buyer/resource mismatch denies through the real repository', async () => {
    const base: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
        share: { instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: 'pur-1', request_status: null },
    };
    // The purchase row names another buyer.
    const wrongBuyer = await runSqlPolicy({
        ...base,
        purchases: { 'pur-1': { id: 'pur-1', buyer_id: 'someone-else', lecture_id: 'lecture-1' } },
    }, 'buyer-1', 'video-1', {});
    assert.equal(await wrongBuyer.allowed, false);
    // The purchase row names another lesson.
    const wrongLesson = await runSqlPolicy({
        ...base,
        purchases: { 'pur-1': { id: 'pur-1', buyer_id: 'buyer-1', lecture_id: 'lecture-9' } },
    }, 'buyer-1', 'video-1', {});
    assert.equal(await wrongLesson.allowed, false);
});

test('sql adapter: an approved exchange license is distinguished from an unapproved one', async () => {
    const base: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
    };
    const approved = await runSqlPolicy({
        ...base,
        share: { instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null, request_status: 'completed' },
    }, 'buyer-1', 'video-1', {});
    assert.equal(await approved.allowed, true);

    const pending = await runSqlPolicy({
        ...base,
        share: { instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null, request_status: 'awaiting_requester' },
    }, 'buyer-1', 'video-1', {});
    assert.equal(await pending.allowed, false);

    const { queryOne } = makeSqlExecutor({ ...base, share: { instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null, request_status: 'completed' } });
    const repository = createSqlVideoAccessRepository({ queryOne, hasPlatformCapability: async () => false });
    assert.deepEqual(await repository.loadInstructorShare('buyer-1', 'lecture-1'),
        { id: 'share-1', license_kind: 'exchange' });
});

test('sql adapter: a completed exchange request from a DIFFERENT requester is rejected', async () => {
    const base: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
    };
    // Completed request, but raised by another instructor: the share row
    // names buyer-1 while the request belongs to stranger-1.
    const wrongRequester: SqlStore = {
        ...base,
        share: {
            instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null,
            request: { id: 7, requester_id: 'stranger-1', owner_id: 'seller-1', lecture_id: 'lecture-1', status: 'completed' },
        },
    };
    const denied = await runSqlPolicy(wrongRequester, 'buyer-1', 'video-1', {});
    assert.equal(await denied.allowed, false);

    const { queryOne } = makeSqlExecutor(wrongRequester);
    const repository = createSqlVideoAccessRepository({ queryOne, hasPlatformCapability: async () => false });
    assert.equal(await repository.loadInstructorShare('buyer-1', 'lecture-1'), null);
});

test('sql adapter: a completed exchange request for a DIFFERENT lecture is rejected', async () => {
    const base: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
    };
    // The completed request grants lecture-9; the share is for lecture-1.
    const denied = await runSqlPolicy({
        ...base,
        share: {
            instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null,
            request: { id: 7, requester_id: 'buyer-1', owner_id: 'seller-1', lecture_id: 'lecture-9', status: 'completed' },
        },
    }, 'buyer-1', 'video-1', {});
    assert.equal(await denied.allowed, false);
});

test('sql adapter: an offer-fulfilled exchange (NULL request lecture) binds the accepted offer exactly', async () => {
    const base: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
    };
    // New-style request: lecture_id NULL, fulfilled by the accepted offer
    // naming exactly the shared lecture -> allowed.
    const share = {
        instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null,
        request: { id: 7, requester_id: 'buyer-1', owner_id: 'seller-1', lecture_id: null, status: 'completed' },
    };
    const fulfilled = await runSqlPolicy({
        ...base, share,
        offers: [{ id: 'off-1', request_id: 7, lecture_id: 'lecture-1', status: 'accepted' }],
    }, 'buyer-1', 'video-1', {});
    assert.equal(await fulfilled.allowed, true);

    // The share SQL really consults the offers table for this binding.
    const shareCall = sqlCall(fulfilled.calls, /FROM instructor_shared_lectures sl/);
    assert.match(shareCall.sql, /FROM instructor_video_offers o/);
    assert.match(shareCall.sql, /o\.status = 'accepted'/);
    assert.match(shareCall.sql, /r\.requester_id = sl\.instructor_id/);
    assert.match(shareCall.sql, /r\.lecture_id IS NOT NULL AND r\.lecture_id = sl\.lecture_id/);

    // Accepted offer for ANOTHER lecture: the grant is not this lecture.
    const wrongOffer = await runSqlPolicy({
        ...base, share,
        offers: [{ id: 'off-1', request_id: 7, lecture_id: 'lecture-9', status: 'accepted' }],
    }, 'buyer-1', 'video-1', {});
    assert.equal(await wrongOffer.allowed, false);

    // Completed request, NULL lecture, but the offer is merely proposed:
    // not yet fulfilled -> blocked.
    const proposed = await runSqlPolicy({
        ...base, share,
        offers: [{ id: 'off-1', request_id: 7, lecture_id: 'lecture-1', status: 'proposed' }],
    }, 'buyer-1', 'video-1', {});
    assert.equal(await proposed.allowed, false);

    // Completed request, NULL lecture, NO offer at all: ambiguous legacy
    // grant -> explicitly blocked.
    const noOffer = await runSqlPolicy({ ...base, share, offers: [] }, 'buyer-1', 'video-1', {});
    assert.equal(await noOffer.allowed, false);
});

test('sql adapter: a non-null request lecture binds exclusively — the offer fallback cannot rescue a mismatched grant', async () => {
    const buyerBase: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
    };
    // MIXED case: the completed request names lecture-9 (NOT the shared
    // lecture-1) while an accepted offer on that same request names
    // lecture-1. The request's own non-null lecture is the binding, so the
    // offer fallback must NOT apply -> denied.
    const mixedShare = {
        instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: null,
        request: { id: 7, requester_id: 'buyer-1', owner_id: 'seller-1', lecture_id: 'lecture-9', status: 'completed' },
    };
    const mixedOffer = [{ id: 'off-1', request_id: 7, lecture_id: 'lecture-1', status: 'accepted' }];

    // Share adapter.
    const deniedShare = await runSqlPolicy({ ...buyerBase, share: mixedShare, offers: mixedOffer }, 'buyer-1', 'video-1', {});
    assert.equal(await deniedShare.allowed, false);
    const shareCall = sqlCall(deniedShare.calls, /FROM instructor_shared_lectures sl/);
    // The shipped predicate really guards the offer fallback with the NULL
    // condition (the recorder must not invent semantics absent from SQL).
    assert.match(shareCall.sql, /r\.lecture_id IS NULL AND EXISTS \(/);
    // The exact non-null equality branch is preserved next to it.
    assert.match(shareCall.sql, /r\.lecture_id IS NOT NULL AND r\.lecture_id = sl\.lecture_id/);

    // Direct adapter read agrees (no policy short-circuit involved).
    const { queryOne } = makeSqlExecutor({ ...buyerBase, share: mixedShare, offers: mixedOffer });
    const repository = createSqlVideoAccessRepository({ queryOne, hasPlatformCapability: async () => false });
    assert.equal(await repository.loadInstructorShare('buyer-1', 'lecture-1'), null);

    // Publication adapter: the same mixed mismatch denies the group read.
    const publicationBase: SqlStore = {
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null },
        lecture: { ...defaultLecture('teacher-y'), is_published: false },
        publications: [{ shared_lecture_instructor_id: 'teacher-y', lecture_id: 'lecture-1', group_id: 'group-1' }],
        student: {
            id: 'enroll-1', user_id: 'student-1', tenant_id: 'tenant-1', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-y',
            is_active: true, approval_status: 'approved',
        },
    };
    const deniedPublication = await runSqlPolicy({
        ...publicationBase,
        share: {
            instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, is_published: true,
            request: { id: 7, requester_id: 'teacher-y', owner_id: 'seller-1', lecture_id: 'lecture-9', status: 'completed' },
        },
        offers: mixedOffer,
    }, 'student-1', 'video-1', { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' });
    assert.equal(await deniedPublication.allowed, false);
    const publicationCall = sqlCall(deniedPublication.calls, /publications pub/);
    assert.match(publicationCall.sql, /r\.lecture_id IS NULL AND EXISTS \(/);

    // Control: the very same store with a NULL request lecture + the same
    // accepted offer IS the legitimate new-style grant (preserved behavior).
    const fulfilled = await runSqlPolicy({
        ...publicationBase,
        share: {
            instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, is_published: true,
            request: { id: 7, requester_id: 'teacher-y', owner_id: 'seller-1', lecture_id: null, status: 'completed' },
        },
        offers: mixedOffer,
    }, 'student-1', 'video-1', { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' });
    assert.equal(await fulfilled.allowed, true);
});

test('sql adapter: a proven paid perpetual license survives the request changing state', async () => {
    const base: SqlStore = {
        user: { id: 'buyer-1', role: 'instructor', phone: null, is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('seller-1'),
        share: { instructor_id: 'buyer-1', lecture_id: 'lecture-1', purchase_id: 'pur-1' },
        purchases: { 'pur-1': { id: 'pur-1', buyer_id: 'buyer-1', lecture_id: 'lecture-1' } },
    };
    for (const status of ['completed', 'expired', 'cancelled_by_requester', 'failed_insufficient_balance']) {
        const laterState = await runSqlPolicy({
            ...base,
            share: {
                ...base.share!,
                request: { id: 7, requester_id: 'buyer-1', owner_id: 'seller-1', lecture_id: 'lecture-1', status },
            },
        }, 'buyer-1', 'video-1', {});
        assert.equal(await laterState.allowed, true,
            `paid perpetual license must survive request status ${status}`);
    }
});

test('sql adapter: publication rejects a wrong-requester or wrong-lecture exchange grant', async () => {
    const base: SqlStore = {
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null },
        lecture: { ...defaultLecture('teacher-y'), is_published: false },
        publications: [{ shared_lecture_instructor_id: 'teacher-y', lecture_id: 'lecture-1', group_id: 'group-1' }],
        student: {
            id: 'enroll-1', user_id: 'student-1', tenant_id: 'tenant-1', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-y',
            is_active: true, approval_status: 'approved',
        },
    };
    const scope: VideoAccessScope = { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' };
    // Sharing instructor's completed request belongs to someone else.
    const wrongRequester = await runSqlPolicy({
        ...base,
        share: {
            instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, is_published: true,
            request: { id: 7, requester_id: 'stranger-1', owner_id: 'seller-1', lecture_id: 'lecture-1', status: 'completed' },
        },
    }, 'student-1', 'video-1', scope);
    assert.equal(await wrongRequester.allowed, false);
    // Completed request grants a different lecture than the published one.
    const wrongLecture = await runSqlPolicy({
        ...base,
        share: {
            instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, is_published: true,
            request: { id: 7, requester_id: 'teacher-y', owner_id: 'seller-1', lecture_id: 'lecture-9', status: 'completed' },
        },
    }, 'student-1', 'video-1', scope);
    assert.equal(await wrongLecture.allowed, false);
    // Offer-fulfilled NULL request lecture with the accepted offer: allowed
    // through the SAME verified predicate the publication read uses.
    const fulfilled = await runSqlPolicy({
        ...base,
        share: {
            instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, is_published: true,
            request: { id: 7, requester_id: 'teacher-y', owner_id: 'seller-1', lecture_id: null, status: 'completed' },
        },
        offers: [{ id: 'off-1', request_id: 7, lecture_id: 'lecture-1', status: 'accepted' }],
    }, 'student-1', 'video-1', scope);
    assert.equal(await fulfilled.allowed, true);
    // And blocked when that fulfillment binding is missing.
    const noOffer = await runSqlPolicy({
        ...base,
        share: {
            instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, is_published: true,
            request: { id: 7, requester_id: 'teacher-y', owner_id: 'seller-1', lecture_id: null, status: 'completed' },
        },
        offers: [],
    }, 'student-1', 'video-1', scope);
    assert.equal(await noOffer.allowed, false);
});

test('sql adapter: publication access depends on the SAME verified license, not a bare publication row', async () => {
    const base: SqlStore = {
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null },
        lecture: { ...defaultLecture('teacher-y'), is_published: false },
        share: { instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: 'pur-1', request_status: null, is_published: true },
        purchases: { 'pur-1': { id: 'pur-1', buyer_id: 'teacher-y', lecture_id: 'lecture-1' } },
        publications: [{ shared_lecture_instructor_id: 'teacher-y', lecture_id: 'lecture-1', group_id: 'group-1' }],
        student: {
            id: 'enroll-1', user_id: 'student-1', tenant_id: 'tenant-1', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-y',
            is_active: true, approval_status: 'approved',
        },
    };
    const scope: VideoAccessScope = { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' };
    const allowed = await runSqlPolicy(base, 'student-1', 'video-1', scope);
    assert.equal(await allowed.allowed, true);
    const publication = sqlCall(allowed.calls, /publications pub/);
    assert.match(publication.sql, /video_purchase_transactions/);
    assert.match(publication.sql, /instructor_video_requests/);

    // Same publication, but the sharing instructor's license is unverified
    // (exchange request never approved): denied.
    const unverified = await runSqlPolicy({
        ...base,
        share: { instructor_id: 'teacher-y', lecture_id: 'lecture-1', purchase_id: null, request_status: 'open', is_published: true },
        purchases: {},
    }, 'student-1', 'video-1', scope);
    assert.equal(await unverified.allowed, false);
});

test('sql adapter: the student read joins the active tenant and binds enrollment+caller', async () => {
    const store: SqlStore = {
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: null, uploaded_by: null },
        lecture: defaultLecture('teacher-y'),
        student: {
            id: 'enroll-1', user_id: 'student-1', tenant_id: 'tenant-1', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-y',
            is_active: true, approval_status: 'approved',
        },
    };
    const { allowed, calls } = await runSqlPolicy(store, 'student-1', 'video-1',
        { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' });
    assert.equal(await allowed, true);
    const student = sqlCall(calls, /FROM students s/);
    assert.match(student.sql, /INNER JOIN tenants t ON t\.id = s\.tenant_id/);
    assert.match(student.sql, /t\.status AS tenant_status/);
    assert.deepEqual(student.params, ['enroll-1', 'student-1']);

    // Stopped tenant on the enrollment denies.
    const stopped = await runSqlPolicy({
        ...store,
        student: { ...store.student!, tenant_status: 'suspended' },
    }, 'student-1', 'video-1', { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' });
    assert.equal(await stopped.allowed, false);
});

test('sql adapter: the student purchase read binds the exact enrollment and exact video', async () => {
    const store: SqlStore = {
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        video: { id: 'video-1', tenant_id: 'tenant-2', course_id: null, uploaded_by: null },
        student: {
            id: 'enroll-1', user_id: 'student-1', tenant_id: 'tenant-1', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-y',
            is_active: true, approval_status: 'approved',
        },
        licenses: [{ student_id: 'enroll-1', video_url: 'video://video-1' }],
    };
    const { allowed, calls } = await runSqlPolicy(store, 'student-1', 'video-1',
        { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' });
    assert.equal(await allowed, true);
    const purchase = sqlCall(calls, /premium_lecture_access pla/);
    assert.match(purchase.sql, /INNER JOIN premium_lectures pl ON pl\.id = pla\.premium_lecture_id/);
    assert.match(purchase.sql, /pl\.video_url = CONCAT\('video:\/\/', \?\)/);
    assert.deepEqual(purchase.params, ['enroll-1', 'video-1']);

    // A license for another video does not widen to it.
    const other = await runSqlPolicy(store, 'student-1', 'video-9',
        { tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' });
    assert.equal(await other.allowed, false);
});

test('wiring: secure-video checkVideoAccess delegates to the pure production policy', () => {
    const secureVideo = src('routes/secure-video.ts');
    assert.match(secureVideo, /evaluateVideoAccess\(userId, videoId, scope, videoAccessRepository\)/);
    // Session creation runs the injectable decision with the server-derived
    // scope (never the body); refresh/heartbeat recheck the same policy.
    assert.match(secureVideo, /evaluateSessionAccess\(video, \{/);
    assert.match(secureVideo, /scope: \{\s*tenantId: req\.user\?\.tenantId,\s*studentEnrollmentId: req\.user\?\.studentEnrollmentId,/);
    assert.match(secureVideo, /checkVideoAccess\(userId, session\.videoId, \{\s*tenantId: req\.user\?\.tenantId,/);
    assert.match(secureVideo, /checkVideoAccess\(session\.userId, session\.videoId, \{\s*tenantId: session\.tenantId,/);
    // The blanket teaching-membership grant and its tenant pre-filter are gone.
    assert.doesNotMatch(secureVideo, /role_key IN \('owner','instructor','teacher','staff'\)/);
    assert.doesNotMatch(secureVideo, /tenant_memberships/);
    assert.doesNotMatch(secureVideo, /SELECT id FROM videos WHERE id=\? AND tenant_id=\?/);
});

test('wiring: the access-policy module is pure (no eager service imports)', () => {
    const policy = src('security/video-access-policy.ts');
    // No import statement of any kind: the module cannot pull db.ts (whose
    // dotenv side effect runs at import), minio.ts, or notifications.ts.
    assert.doesNotMatch(policy, /^\s*import\s/m);
    assert.doesNotMatch(policy, /from '\.\.\//);
    assert.doesNotMatch(policy, /from 'dotenv'/);
    assert.doesNotMatch(policy, /require\(/);
    // Behavior is exported and injectable.
    assert.match(policy, /export const evaluateVideoAccess/);
    assert.match(policy, /export interface VideoAccessRepository/);
    assert.match(policy, /export const createSqlVideoAccessRepository/);
});

test('wiring: instructor shares and student purchases stay distinct license reads', () => {
    const policy = src('security/video-access-policy.ts');
    // Teacher-to-teacher license read joins BOTH evidence tables and binds
    // the exact buyer + lesson (never a bare share row).
    assert.match(policy, /FROM instructor_shared_lectures sl/);
    assert.match(policy, /LEFT JOIN video_purchase_transactions p ON p\.id = sl\.purchase_id/);
    assert.match(policy, /LEFT JOIN instructor_video_requests r ON r\.id = sl\.request_id/);
    assert.match(policy, /p\.buyer_id = \? AND p\.lecture_id = \?/);
    assert.match(policy, /r\.status = 'completed'/);
    // Exchange binding: the completed request belongs to the share's own
    // instructor and grants exactly this lecture — via the request's own
    // lecture_id, or via the accepted offer when it is NULL.
    assert.match(policy, /r\.requester_id = sl\.instructor_id/);
    assert.match(policy, /r\.lecture_id IS NOT NULL AND r\.lecture_id = sl\.lecture_id/);
    assert.match(policy, /SELECT 1 FROM instructor_video_offers o/);
    assert.match(policy, /o\.request_id = r\.id AND o\.status = 'accepted'/);
    // The offer fallback is guarded by the NULL condition: it applies only
    // while the request carries no lecture of its own — the shipped SQL must
    // say so explicitly (no invented semantics, no unguarded OR EXISTS).
    assert.match(policy,
        /\(r\.lecture_id IS NOT NULL AND r\.lecture_id = sl\.lecture_id\)\s*OR \(r\.lecture_id IS NULL AND EXISTS \(/);
    // Student purchase license: exact enrollment joined to the exact video.
    assert.match(policy, /SELECT pla\.id FROM premium_lecture_access pla/);
    assert.match(policy, /pl\.video_url = CONCAT\('video:\/\/', \?\)/);
    // The student purchase read never passes through the instructor table.
    const purchaseStart = policy.indexOf('SELECT pla.id');
    const purchaseRead = policy.slice(purchaseStart, policy.indexOf('LIMIT 1', purchaseStart) + 'LIMIT 1'.length);
    assert.doesNotMatch(purchaseRead, /instructor_shared_lectures/);
    // The verified-license predicate is shared, not duplicated logic per call.
    assert.match(policy, /VERIFIED_INSTRUCTOR_LICENSE_SQL/);
});

// ---------------------------------------------------------------------------
// Secure-video delivery paths: session authorization, token/session binding,
// and the delivery recheck. These drive the REAL exported route helpers over
// injected readers (and the REAL policy over fixture repositories), so no
// application/db/env import and no live service is touched; the shipped route
// wiring itself is asserted by the static regressions at the end.
// ---------------------------------------------------------------------------

import { generateVideoSessionToken, verifyVideoSessionToken } from '../src/middleware/auth';

const sessionAccessDepsFor = (fixtures: { previewOffer?: boolean; allowed?: boolean } = {}) => {
    const previewCalls: Array<{ offerId: string | undefined; videoId: string; userId: string }> = [];
    const accessCalls: Array<{ userId: string; videoId: string; scope: VideoAccessScope }> = [];
    const deps: SessionAccessDeps = {
        hasPreviewOffer: async (offerId, videoId, userId) => {
            previewCalls.push({ offerId, videoId, userId });
            return fixtures.previewOffer === true;
        },
        hasVideoAccess: async (userId, videoId, scope) => {
            accessCalls.push({ userId, videoId, scope });
            return fixtures.allowed === true;
        },
    };
    return { deps, previewCalls, accessCalls };
};

const deliveryAccessDepsFor = (fixtures: { previewOffer?: boolean; allowed?: boolean } = {}) => {
    const previewCalls: Array<{ offerId: string | undefined; videoId: string; userId: string }> = [];
    const scopes: VideoAccessScope[] = [];
    const deps: DeliveryAccessDeps = {
        hasPreviewOffer: async (offerId, videoId, userId) => {
            previewCalls.push({ offerId, videoId, userId });
            // Mirrors the shipped predicate: a missing offer id fails closed.
            if (!offerId) return false;
            return fixtures.previewOffer === true;
        },
        hasVideoAccess: async (_userId, _videoId, scope) => {
            scopes.push(scope);
            return fixtures.allowed === true;
        },
    };
    return { deps, previewCalls, scopes };
};

/** Real production policy behind the injected session/delivery seam. */
const realPolicyAccess = (fixtures: Parameters<typeof videoAccessRepo>[0]): DeliveryAccessDeps['hasVideoAccess'] =>
    (userId, videoId, scope) => evaluateVideoAccess(userId, videoId, scope, videoAccessRepo(fixtures));

const buyerFixtures = (videoId = 'video-1', purchasedBy: { studentId: string; videoId: string } | null = { studentId: 'enroll-1', videoId: 'video-1' }) => ({
    user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
    video: { id: videoId, tenant_id: 'tenant-2', course_id: null, uploaded_by: null } as VideoAccessVideoRow,
    student: defaultStudent(),
    purchasedBy,
});

const sameCenterTeacherFixtures = () => ({
    user: { id: 'teacher-x', role: 'instructor', phone: null, is_active: 1 },
    lecture: defaultLecture('teacher-y'),
    course: { instructor_id: 'teacher-y', tenant_id: 'tenant-1', is_active: 1 },
    authorityUserId: 'owner-1',
});

test('session access: a missing video is reported not found (no tenant guess)', async () => {
    const { deps } = sessionAccessDepsFor({ allowed: true });
    assert.equal(await evaluateSessionAccess(null, { userId: 'student-1', scope: {} }, deps),
        'video_not_found');
});

test('session access: no grant and no offer is denied', async () => {
    const { deps, accessCalls } = sessionAccessDepsFor({ allowed: false });
    assert.equal(await evaluateSessionAccess({ id: 'video-1' }, { userId: 'student-1', scope: studentScope }, deps),
        'no_access');
    // The server-derived scope reached the policy, not a request value.
    assert.deepEqual(accessCalls, [{ userId: 'student-1', videoId: 'video-1', scope: studentScope }]);
});

test('session access: an exact purchased license allows that video only (real policy)', async () => {
    assert.equal(await evaluateSessionAccess({ id: 'video-1' },
        { userId: 'student-1', scope: studentScope },
        { hasPreviewOffer: async () => false, hasVideoAccess: realPolicyAccess(buyerFixtures()) }),
        'allowed');
    // The same buyer posture on another video denies: licenses bind the exact resource.
    assert.equal(await evaluateSessionAccess({ id: 'video-2' },
        { userId: 'student-1', scope: studentScope },
        { hasPreviewOffer: async () => false, hasVideoAccess: realPolicyAccess(buyerFixtures('video-2')) }),
        'no_access');
});

test('session access: a same-center teacher without a per-resource grant is denied (real policy)', async () => {
    // teacher-x teaches inside the center that owns the lesson of teacher-y;
    // a center membership is not an entitlement.
    assert.equal(await evaluateSessionAccess({ id: 'video-1' },
        { userId: 'teacher-x', scope: {} },
        { hasPreviewOffer: async () => false, hasVideoAccess: realPolicyAccess(sameCenterTeacherFixtures()) }),
        'no_access');
});

test('session access: a pending preview offer grants ONLY the truncated preview', async () => {
    const active = sessionAccessDepsFor({ previewOffer: true, allowed: false });
    assert.equal(await evaluateSessionAccess({ id: 'video-1' },
        { userId: 'instructor-2', offerId: 'offer-1', scope: {} }, active.deps), 'preview');
    // The offer is bound to the exact video and caller, and the full-access
    // policy is never consulted for a preview.
    assert.deepEqual(active.previewCalls, [{ offerId: 'offer-1', videoId: 'video-1', userId: 'instructor-2' }]);
    assert.deepEqual(active.accessCalls, []);

    const withdrawn = sessionAccessDepsFor({ previewOffer: false, allowed: true });
    assert.equal(await evaluateSessionAccess({ id: 'video-1' },
        { userId: 'instructor-2', offerId: 'offer-1', scope: {} }, withdrawn.deps), 'preview_unavailable');
    assert.deepEqual(withdrawn.accessCalls, []);
});

test('delivery recheck: a live purchased grant keeps manifest/segment/key serving (real policy)', async () => {
    const session: DeliverySession = {
        userId: 'student-1', videoId: 'video-1', previewOnly: false,
        tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1',
    };
    assert.equal(await evaluateDeliveryAccess(session,
        { hasPreviewOffer: async () => false, hasVideoAccess: realPolicyAccess(buyerFixtures()) }), true);
});

test('delivery recheck: revoking the purchased grant mid-session denies the next delivery', async () => {
    const session: DeliverySession = {
        userId: 'student-1', videoId: 'video-1', previewOnly: false,
        tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1',
    };
    // The license row is gone (purchase revoked) — the still-valid token must
    // not ride on it.
    assert.equal(await evaluateDeliveryAccess(session,
        { hasPreviewOffer: async () => false, hasVideoAccess: realPolicyAccess(buyerFixtures('video-1', null)) }), false);
});

test('delivery recheck: a same-center teacher without a per-resource grant is denied (real policy)', async () => {
    assert.equal(await evaluateDeliveryAccess(
        { userId: 'teacher-x', videoId: 'video-1', previewOnly: false, tenantId: 'tenant-1' },
        { hasPreviewOffer: async () => false, hasVideoAccess: realPolicyAccess(sameCenterTeacherFixtures()) }), false);
});

test('delivery recheck: a preview session lives only while its offer stays proposed', async () => {
    const session: DeliverySession = {
        userId: 'instructor-2', videoId: 'video-1', previewOnly: true,
        offerId: 'offer-1', tenantId: 'tenant-2',
    };
    const active = deliveryAccessDepsFor({ previewOffer: true, allowed: true });
    assert.equal(await evaluateDeliveryAccess(session, active.deps), true);
    assert.deepEqual(active.previewCalls, [{ offerId: 'offer-1', videoId: 'video-1', userId: 'instructor-2' }]);
    // previewOnly is never an authorization bypass: the full-access policy is
    // not consulted for a preview session.
    assert.deepEqual(active.scopes, []);

    const withdrawn = deliveryAccessDepsFor({ previewOffer: false, allowed: true });
    assert.equal(await evaluateDeliveryAccess(session, withdrawn.deps), false);

    // A preview session without its own offer id fails closed.
    const orphan: DeliverySession = { userId: 'instructor-2', videoId: 'video-1', previewOnly: true, tenantId: 'tenant-2' };
    assert.equal(await evaluateDeliveryAccess(orphan, deliveryAccessDepsFor({ previewOffer: true, allowed: true }).deps), false);
});

test('delivery recheck: the recheck uses the scope captured at session creation, never a request value', async () => {
    const { deps, scopes } = deliveryAccessDepsFor({ allowed: true });
    await evaluateDeliveryAccess({
        userId: 'student-1', videoId: 'video-1', previewOnly: false,
        tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1',
    }, deps);
    assert.deepEqual(scopes, [{ tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1' }]);
});

test('media binding: a token minted for one asset never serves another (real JWT round-trip)', () => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-media-binding';
    const req = { headers: { 'x-video-fingerprint': 'fp-1', 'x-screen-resolution': '1920x1080' }, ip: '10.0.0.1' } as never;
    const session = { sessionId: 'sess-1', userId: 'buyer-1', videoId: 'video-1' };
    const token = generateVideoSessionToken({
        userId: 'buyer-1', videoId: 'video-1', sessionId: 'sess-1',
        ip: '10.0.0.1', userAgent: '', fingerprint: 'fp-1', screenRes: '1920x1080',
    });
    const verified = verifyVideoSessionToken(token, req);
    assert.equal(verified.valid, true);
    assert.equal(isMediaSessionBound(verified.decoded, session, 'video-1'), true);
    // The same valid token cannot open an unrelated asset.
    assert.equal(isMediaSessionBound(verified.decoded, session, 'video-2'), false);

    const otherToken = generateVideoSessionToken({
        userId: 'buyer-1', videoId: 'video-2', sessionId: 'sess-1',
        ip: '10.0.0.1', userAgent: '', fingerprint: 'fp-1', screenRes: '1920x1080',
    });
    const other = verifyVideoSessionToken(otherToken, req);
    assert.equal(isMediaSessionBound(other.decoded, session, 'video-1'), false);
});

test('media binding: session/user mismatches deny and a dead session fails closed', () => {
    const decoded = { sid: 'sess-1', sub: 'buyer-1', vid: 'video-1' };
    const session = { sessionId: 'sess-1', userId: 'buyer-1', videoId: 'video-1' };
    assert.equal(isMediaSessionBound({ ...decoded, sid: 'sess-2' }, session, 'video-1'), false);
    assert.equal(isMediaSessionBound({ ...decoded, sub: 'stranger-1' }, session, 'video-1'), false);
    assert.equal(isMediaSessionBound({ ...decoded, vid: 'video-9' }, session, 'video-1'), false);
    assert.equal(isMediaSessionBound(decoded, null, 'video-1'), false);
    assert.equal(isMediaSessionBound(undefined, session, 'video-1'), false);
});

test('preview offer: only the caller\'s own still-proposed offer for exactly this video counts', async () => {
    const reader = async (sql: string, params: unknown[]) => {
        // Mirrors the shipped predicate: offer id + video + caller + proposed.
        const [offerId, videoId, userId] = params as string[];
        if (offerId === 'offer-1' && videoId === 'video-1'
            && (userId === 'requester-1' || userId === 'owner-1')) {
            return { id: offerId };
        }
        return null;
    };
    assert.equal(await evaluatePreviewOffer('offer-1', 'video-1', 'requester-1', reader), true);
    assert.equal(await evaluatePreviewOffer('offer-1', 'video-1', 'owner-1', reader), true);
    assert.equal(await evaluatePreviewOffer('offer-1', 'video-1', 'stranger-1', reader), false);
    assert.equal(await evaluatePreviewOffer('offer-2', 'video-1', 'requester-1', reader), false);
    assert.equal(await evaluatePreviewOffer('offer-1', 'video-9', 'requester-1', reader), false);
    // A missing offer id fails closed.
    assert.equal(await evaluatePreviewOffer(undefined, 'video-1', 'requester-1', reader), false);

    // The shipped predicate text is preserved for the production reader.
    let seen = '';
    await evaluatePreviewOffer('offer-1', 'video-1', 'requester-1', async (sql: string) => {
        seen = sql;
        return { id: 'offer-1' };
    });
    assert.match(seen, /FROM instructor_video_offers o INNER JOIN instructor_video_requests r/);
    assert.match(seen, /o\.status='proposed'/);
    assert.match(seen, /r\.requester_id=\? OR r\.owner_id=\?/);
});

test('wiring: secure-video session creation carries no early tenant-only filter', () => {
    const secureVideo = src('routes/secure-video.ts');
    // The lookup is resource-only; the verified policy decides access, so an
    // exact cross-tenant license is no longer pre-rejected by tenant.
    assert.doesNotMatch(secureVideo, /AND v\.tenant_id=\?/);
    assert.match(secureVideo, /evaluateSessionAccess\(video, \{/);
    assert.match(secureVideo, /scope: \{\s*tenantId: req\.user\?\.tenantId,\s*studentEnrollmentId: req\.user\?\.studentEnrollmentId,/);
});

test('wiring: manifest, segment, and key delivery recheck the grant before any exposure', () => {
    const secureVideo = src('routes/secure-video.ts');
    const manifestAt = secureVideo.indexOf("router.get('/manifest/:videoId/*'");
    const mediaAt = secureVideo.indexOf("router.get('/media/:videoId'");
    const keyAt = secureVideo.indexOf("router.get('/key/:videoId'");
    assert.ok(manifestAt > 0 && mediaAt > 0 && keyAt > 0);
    // Each delivery handler runs the recheck after binding the session and
    // before reading content, minting URLs, or loading the key.
    const handlers: Array<[number, string]> = [
        [manifestAt, 'getObjectBuffer('],
        [mediaAt, 'getObjectStream('],
        [keyAt, 'encryption_key'],
    ];
    for (const [start, contentRead] of handlers) {
        const recheck = secureVideo.indexOf('evaluateDeliveryAccess(', start);
        assert.ok(recheck > start, 'delivery recheck must run inside the handler');
        assert.ok(recheck < secureVideo.indexOf(contentRead, start),
            `the grant must be rechecked before ${contentRead} leaves the server`);
    }
    // Denial kills the session and answers 403 (fail closed).
    assert.match(secureVideo, /killSession\(auth\.sessionId, 'access_revoked'\)/);
    assert.match(secureVideo, /killSession\(sessionId, 'access_revoked'\)/);
    // previewOnly is never an authorization bypass on delivery.
    assert.match(secureVideo, /if \(session\.previewOnly\) \{\s*return deps\.hasPreviewOffer/);
    // Preview sessions stay confined to the truncated preview paths.
    assert.match(secureVideo, /Preview session cannot access full media/);
    // Refresh and heartbeat recheck through the same shared preview predicate.
    assert.match(secureVideo, /evaluatePreviewOffer\(session\.offerId, session\.videoId, userId, queryOne\)/);
    assert.match(secureVideo, /evaluatePreviewOffer\(session\.offerId, session\.videoId, session\.userId, queryOne\)/);
});

// ---------------------------------------------------------------------------
// F3 part 2 — server-owned playback entitlement on protected byte delivery.
//
// These tests drive the REAL session / refresh / manifest / media / key
// handlers built by createSecureVideoDeliveryRouter over injected seams. The
// client contract is unchanged: only `sid` + `token` are presented; the server
// resolves the video's unique lesson and looks up its own entitlement record
// by the session id captured at issuance.
// ---------------------------------------------------------------------------

class DeliveryResponse extends Writable {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string> = {};
    chunks: Buffer[] = [];

    _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
    }

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    json(payload: unknown): this {
        this.statusCode ??= 200;
        this.body = payload;
        this.end();
        return this;
    }

    set(field: string | Record<string, string>, value?: string): this {
        if (typeof field === 'string') {
            this.headers[field.toLowerCase()] = value ?? '';
        } else {
            for (const [key, headerValue] of Object.entries(field)) {
                this.headers[key.toLowerCase()] = headerValue;
            }
        }
        return this;
    }

    send(payload: unknown): this {
        this.statusCode ??= 200;
        if (Buffer.isBuffer(payload)) this.chunks.push(payload);
        else if (typeof payload === 'string') this.chunks.push(Buffer.from(payload));
        else this.body = payload;
        this.end();
        return this;
    }
}

interface DeliveryInvocation {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
}

const invokeDelivery = async (router: Router, invocation: DeliveryInvocation) => {
    const response = new DeliveryResponse();
    const search = invocation.query ? `?${new URLSearchParams(invocation.query).toString()}` : '';
    const url = `${invocation.path}${search}`;
    const request: Record<string, unknown> = {
        method: invocation.method,
        url,
        originalUrl: url,
        headers: { 'user-agent': 'hermetic-agent', ...(invocation.headers ?? {}) },
        body: invocation.body ?? {},
        query: invocation.query ?? {},
        params: {},
    };
    (router as unknown as (req: Record<string, unknown>, res: DeliveryResponse, next: () => void) => void)(
        request, response, () => undefined,
    );
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('delivery route did not settle')), 2000);
        const finish = () => { clearTimeout(timer); resolve(); };
        if (response.writableEnded) return finish();
        response.once('finish', finish);
        response.once('close', finish);
    });
    return {
        status: response.statusCode ?? (response.writableEnded ? 200 : 0),
        body: response.body as Record<string, unknown> | undefined,
        text: Buffer.concat(response.chunks).toString('utf8'),
        chunks: response.chunks,
        headers: response.headers,
    };
};

interface TestSession {
    sessionId: string;
    userId: string;
    videoId: string;
    ip: string;
    userAgent: string;
    fingerprint: string;
    screenRes: string;
    createdAt: number;
    lastHeartbeat: number;
    violationScore: number;
    isActive: boolean;
    previewOnly: boolean;
    offerId?: string;
    studentEnrollmentId?: string;
    tenantId?: string;
    segmentRequests: number[];
    manifestRequests: number[];
    keyRequests: number[];
    activeMediaRequests: number;
}

const makeTestSession = (overrides: Partial<TestSession> = {}): TestSession => ({
    sessionId: 'sess-1',
    userId: 'student-1',
    videoId: 'video-1',
    ip: '10.0.0.1',
    userAgent: 'hermetic-agent',
    fingerprint: 'fp-1',
    screenRes: '1920x1080',
    createdAt: 1_000_000,
    lastHeartbeat: 1_000_000,
    violationScore: 0,
    isActive: true,
    previewOnly: false,
    studentEnrollmentId: 'enroll-1',
    tenantId: 'tenant-1',
    segmentRequests: [],
    manifestRequests: [],
    keyRequests: [],
    activeMediaRequests: 0,
    ...overrides,
});

const makeEntitlementService = (clock: () => number) => {
    const records = new Map<string, PlaybackEntitlementRecord[]>();
    const issued: Array<{ tenantId: string; lessonId: string; studentEnrollmentId: string; sessionId: string }> = [];
    let sequence = 0;
    const service: PlaybackEntitlementService = {
        issue: async (expectation, ttlSeconds) => {
            sequence += 1;
            const issuedAtMs = clock();
            const ttl = typeof ttlSeconds === 'number' ? ttlSeconds : 60;
            const claims: PlaybackTokenClaims = {
                jti: `jti-${sequence}`,
                tenantId: expectation.tenantId,
                lessonId: expectation.lessonId,
                studentEnrollmentId: expectation.studentEnrollmentId,
                sessionId: expectation.sessionId,
                issuedAtMs,
                expiresAtMs: issuedAtMs + ttl * 1000,
            };
            const list = records.get(claims.sessionId) ?? [];
            list.push({ ...claims, revokedAtMs: null, revokeReason: null });
            records.set(claims.sessionId, list);
            issued.push({ ...expectation });
            return { ok: true, token: `token-${sequence}`, claims, expiresIn: ttl };
        },
        verify: async () => ({ allowed: false, reason: 'malformed' }),
        load: async (jti) => {
            for (const list of records.values()) {
                const record = list.find((item) => item.jti === jti);
                if (record) return { ...record };
            }
            return null;
        },
        revoke: async (jti) => {
            for (const list of records.values()) {
                const record = list.find((item) => item.jti === jti);
                if (record) {
                    record.revokedAtMs = clock();
                    return { revoked: true, tenantId: record.tenantId };
                }
            }
            return { revoked: false, tenantId: null };
        },
        findBySessionId: async (sessionId) => (records.get(sessionId) ?? []).map((record) => ({ ...record })),
    };
    return { service, records, issued };
};

const makeEntitlementRecord = (overrides: Partial<PlaybackEntitlementRecord> = {}): PlaybackEntitlementRecord => ({
    jti: 'jti-seed',
    tenantId: 'tenant-1',
    lessonId: 'lesson-1',
    studentEnrollmentId: 'enroll-1',
    sessionId: 'sess-1',
    issuedAtMs: 1_000_000,
    expiresAtMs: 1_300_000,
    revokedAtMs: null,
    revokeReason: null,
    ...overrides,
});

interface DeliveryHarnessOptions {
    session?: TestSession | null;
    tokenValid?: boolean;
    hasVideoAccess?: boolean;
    association?: VideoLessonAssociation;
    records?: PlaybackEntitlementRecord[];
    nowMs?: number;
    issueFails?: boolean;
    branchAllowed?: boolean;
    /**
     * Durable `video_sessions` state for the fixture session. Defaults to
     * `active` when the fixture has a session (a session that was legitimately
     * created and persisted) and `missing` otherwise.
     */
    durableSession?: DurableSessionState;
}

type DurableSessionState = 'active' | 'missing' | 'unavailable';

interface DurableSessionRow {
    sessionId: string;
    userId: string;
    videoId: string;
    isActive: 0 | 1;
}

/**
 * In-memory `video_sessions` table for the delivery harness.
 *
 * The delivery gate reads exactly one column of this table, so a harness whose
 * `queryOne` answers `null` for every lookup can only ever exercise the deny
 * path — it cannot represent a legitimately created session. This table is
 * written by the same statements production uses (the creation INSERT, the
 * `killSession` UPDATE by id, the per-user invalidation) and read back by id.
 * It seeds no default row: an unknown id resolves to `null`, and an inactive
 * row is returned as `is_active = 0`, so the gate still sees the real column.
 */
const createDurableSessionTable = () => {
    const rows = new Map<string, DurableSessionRow>();
    let readFailure: Error | null = null;

    const insert = (row: { sessionId: string; userId: string; videoId: string }) => {
        rows.set(row.sessionId, { ...row, isActive: 1 });
    };

    const deactivate = (sessionId: string): boolean => {
        const row = rows.get(sessionId);
        if (!row) return false;
        row.isActive = 0;
        return true;
    };

    const execute = (sql: string, params: unknown[] = []): { affectedRows: number } | null => {
        const normalized = sql.replace(/\s+/g, ' ');
        if (/INSERT INTO video_sessions/.test(normalized)) {
            insert({ sessionId: String(params[0]), userId: String(params[1]), videoId: String(params[2]) });
            return { affectedRows: 1 };
        }
        if (/UPDATE video_sessions SET is_active\s*=\s*0/.test(normalized)) {
            if (/WHERE id = \?/.test(normalized)) {
                return { affectedRows: deactivate(String(params[1])) ? 1 : 0 };
            }
            if (/WHERE user_id\s*=\s*\?/.test(normalized)) {
                for (const row of rows.values()) {
                    if (row.userId === String(params[0])) row.isActive = 0;
                }
                return { affectedRows: 1 };
            }
        }
        return null;
    };

    const queryOne = (sql: string, params: unknown[] = []): { is_active: number } | null | undefined => {
        if (!/SELECT is_active FROM video_sessions/.test(sql.replace(/\s+/g, ' '))) return undefined;
        if (readFailure) throw readFailure;
        const row = rows.get(String(params[0]));
        return row ? { is_active: row.isActive } : null;
    };

    return {
        rows,
        insert,
        deactivate,
        execute,
        queryOne,
        failReads: (error: Error | null) => { readFailure = error; },
    };
};

const makeDeliveryHarness = (options: DeliveryHarnessOptions = {}) => {
    let nowMs = options.nowMs ?? 1_000_000;
    const session = options.session === undefined ? makeTestSession() : options.session;
    const kills: Array<{ sessionId: string; reason: string }> = [];
    const created: Array<Record<string, unknown>> = [];
    const durableSessions = createDurableSessionTable();
    const durableState: DurableSessionState = options.durableSession ?? (session ? 'active' : 'missing');
    if (session && durableState !== 'missing') {
        durableSessions.insert({ sessionId: session.sessionId, userId: session.userId, videoId: session.videoId });
    }
    if (durableState === 'unavailable') durableSessions.failReads(new Error('session store unavailable'));
    const entitlement = makeEntitlementService(() => nowMs);
    for (const record of options.records ?? []) {
        const list = entitlement.records.get(record.sessionId) ?? [];
        list.push({ ...record });
        entitlement.records.set(record.sessionId, list);
    }
    if (options.issueFails) {
        entitlement.service.issue = async () => ({ ok: false, reason: 'secret-unavailable' });
    }

    const deps: import('../src/routes/secure-video').SecureVideoDeliveryDeps = {
        authenticate: (req, _res, next) => {
            (req as { user?: unknown }).user = {
                id: 'student-1',
                email: null,
                phone: null,
                role: 'student',
                tenantId: 'tenant-1',
                studentEnrollmentId: 'enroll-1',
            };
            next();
        },
        queryOne: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | null> => {
            const durable = durableSessions.queryOne(sql, params ?? []);
            if (durable !== undefined) return durable as T | null;
            const normalized = sql.replace(/\s+/g, ' ');
            if (/FROM video_security_consents/.test(normalized)) return { id: 'consent-1' } as T;
            if (/SELECT v\.\*/.test(normalized) && /FROM videos v/.test(normalized)) {
                return { id: 'video-1', is_encrypted: 1, hls_key: 'hls/key', original_key: 'orig/key' } as T;
            }
            if (/SELECT name, phone FROM users/.test(normalized)) {
                return { name: 'Student', phone: '01001234567' } as T;
            }
            if (/SELECT s\.name, g\.name as group_name/.test(normalized)) {
                return { name: 'Student', group_name: 'Group A' } as T;
            }
            if (/SELECT \* FROM videos/.test(normalized)) {
                return { is_encrypted: 1, hls_key: 'hls/key', original_key: 'orig/key' } as T;
            }
            if (/SELECT encryption_key, is_encrypted/.test(normalized)) {
                return { is_encrypted: 1, encryption_key: '00112233' } as T;
            }
            return null;
        },
        execute: async (sql: string, params?: unknown[]) => durableSessions.execute(sql, params ?? []) ?? { affectedRows: 1 },
        getActiveSession: () => session,
        createVideoSession: async (params) => {
            created.push({ ...params });
            // The durable write the real `createVideoSession` performs before it
            // publishes anything; delivery later reads this row back.
            durableSessions.insert({ sessionId: 'sess-1', userId: params.userId, videoId: params.videoId });
            return { sessionId: 'sess-1', watermarkSeed: 'watermark-seed' };
        },
        killSession: async (sessionId, reason) => { kills.push({ sessionId, reason }); },
        isUserSuspended: async () => ({ suspended: false }),
        generateVideoSessionToken: () => 'session-token',
        verifyVideoSessionToken: (token) => {
            if (options.tokenValid === false) return { valid: false, reason: 'Device fingerprint mismatch' };
            if (!token) return { valid: false, reason: 'Invalid token' };
            return {
                valid: true,
                decoded: { sid: session?.sessionId, sub: session?.userId, vid: session?.videoId, po: session?.previewOnly },
            };
        },
        getClientIp: () => '10.0.0.1',
        hashValue: (value) => `hash:${value}`,
        recordViolation: async () => ({
            suspended: false, score: 0, action: 'none', killed: false,
            restrictions: { qualityCap: null, fullscreenAllowed: true, riskScore: 0 },
        }),
        getThumbnailUrl: async () => 'thumbnail.jpg',
        getUserVideoRestrictions: async () => ({ qualityCap: null, fullscreenAllowed: true, riskScore: 0 }),
        inspectDeliveryRequest: () => ({ allowed: true, release: () => undefined }),
        getObjectBuffer: async () => Buffer.from(
            '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\n480p/segment_0.ts\n',
        ),
        getObjectStream: async () => Readable.from([Buffer.from('segment-bytes')]),
        hasVideoAccess: async () => options.hasVideoAccess ?? true,
        hasPreviewOffer: async () => false,
        resolveBranch: async () => (options.branchAllowed === false
            ? { kind: 'denied', reason: 'membership-missing' }
            : { kind: 'allowed', scope: 'tenant', branchId: null, membershipRole: null, membershipVersion: null, legacyUnclassified: false }),
        resolveVideoLesson: async () => options.association ?? { kind: 'unique', lessonId: 'lesson-1' },
        entitlement: entitlement.service,
        now: () => nowMs,
        issueEntitlementTtlSeconds: 300,
        renewBeforeMs: 120_000,
    };
    return {
        router: createSecureVideoDeliveryRouter(deps),
        kills,
        created,
        entitlement,
        session,
        durableSessions,
        setNow: (value: number) => { nowMs = value; },
    };
};

const mediaQuery = (extra: Record<string, string> = {}) => ({
    sid: 'sess-1', token: 'session-token', ...extra,
});

test('entitlement delivery: an unauthenticated manifest request is denied before any read', async () => {
    const harness = makeDeliveryHarness({ session: null });
    const result = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: {},
    });
    assert.equal(result.status, 401);
    assert.equal(result.chunks.length, 0);
});

test('entitlement delivery: a valid session with no server-owned record is denied on manifest, media and key', async () => {
    for (const request of [
        { method: 'GET' as const, path: '/manifest/video-1/playlist.m3u8', query: mediaQuery() },
        { method: 'GET' as const, path: '/media/video-1', query: mediaQuery({ path: 'segment_0.ts' }) },
        { method: 'GET' as const, path: '/key/video-1', query: mediaQuery() },
    ]) {
        const harness = makeDeliveryHarness();
        const result = await invokeDelivery(harness.router, request);
        assert.equal(result.status, 403, `${request.path} must deny without an entitlement`);
        assert.equal(result.body?.code, 'PLAYBACK_ENTITLEMENT_DENIED');
        assert.equal(result.body?.reason, 'missing');
        assert.deepEqual(harness.kills, [{ sessionId: 'sess-1', reason: 'entitlement_denied' }]);
        assert.equal(result.chunks.length, 0);
    }
});

test('entitlement delivery: a revoked record denies the next request', async () => {
    const harness = makeDeliveryHarness({
        records: [makeEntitlementRecord({ revokedAtMs: 1_000_001 })],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'GET', path: '/media/video-1', query: mediaQuery({ path: 'segment_0.ts' }),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body?.reason, 'revoked');
    assert.equal(result.chunks.length, 0);
});

test('entitlement delivery: an expired record denies', async () => {
    const harness = makeDeliveryHarness({
        records: [makeEntitlementRecord({ expiresAtMs: 999_999 })],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body?.reason, 'expired');
});

test('entitlement delivery: lesson, tenant and enrollment mismatches deny', async () => {
    const cases: Array<{ record: Partial<PlaybackEntitlementRecord>; reason: string }> = [
        { record: { lessonId: 'lesson-other' }, reason: 'lesson-mismatch' },
        { record: { tenantId: 'tenant-other' }, reason: 'tenant-mismatch' },
        { record: { studentEnrollmentId: 'enroll-other' }, reason: 'student-mismatch' },
    ];
    for (const entry of cases) {
        const harness = makeDeliveryHarness({ records: [makeEntitlementRecord(entry.record)] });
        const result = await invokeDelivery(harness.router, {
            method: 'GET', path: '/key/video-1', query: mediaQuery(),
        });
        assert.equal(result.status, 403, entry.reason);
        assert.equal(result.body?.reason, entry.reason);
    }
});

test('entitlement delivery: the existing fingerprint/IP/UA token binding is preserved', async () => {
    const harness = makeDeliveryHarness({
        tokenValid: false,
        records: [makeEntitlementRecord()],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(),
    });
    assert.equal(result.status, 401);
    assert.equal(result.chunks.length, 0);
});

test('entitlement delivery: a valid record serves the manifest, the segment and the key', async () => {
    const harness = makeDeliveryHarness({ records: [makeEntitlementRecord()] });

    const manifest = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(),
    });
    assert.equal(manifest.status, 200);
    assert.match(manifest.text, /\/api\/secure-video\/media\/video-1\?path=480p%2Fsegment_0\.ts/);
    assert.match(manifest.text, /\/api\/secure-video\/key\/video-1/);

    const segment = await invokeDelivery(harness.router, {
        method: 'GET', path: '/media/video-1', query: mediaQuery({ path: '480p/segment_0.ts' }),
    });
    assert.equal(segment.status, 200);
    assert.equal(Buffer.concat(segment.chunks).toString('utf8'), 'segment-bytes');

    const key = await invokeDelivery(harness.router, {
        method: 'GET', path: '/key/video-1', query: mediaQuery(),
    });
    assert.equal(key.status, 200);
    assert.deepEqual(Buffer.concat(key.chunks), Buffer.from('00112233', 'hex'));
});

test('entitlement delivery: an ambiguous parent association denies even with a valid record', async () => {
    const harness = makeDeliveryHarness({
        association: { kind: 'ambiguous', lessonId: null, reason: 'ambiguous-lecture-parents' },
        records: [makeEntitlementRecord()],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body?.code, 'VIDEO_PARENT_AMBIGUOUS');
    assert.equal(result.body?.reason, 'ambiguous-parent');
    assert.deepEqual(harness.kills, [{ sessionId: 'sess-1', reason: 'ambiguous_parent' }]);
});

test('entitlement delivery: a foreign-tenant grant is still denied by the existing access policy', async () => {
    const harness = makeDeliveryHarness({
        hasVideoAccess: false,
        records: [makeEntitlementRecord()],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'GET', path: '/media/video-1', query: mediaQuery({ path: 'segment_0.ts' }),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body?.error, 'Video access was revoked');
    assert.deepEqual(harness.kills, [{ sessionId: 'sess-1', reason: 'access_revoked' }]);
});

test('entitlement delivery: a durable session row that is gone denies the next request', async () => {
    const harness = makeDeliveryHarness({ records: [makeEntitlementRecord()], durableSession: 'missing' });
    for (const request of [
        { method: 'GET' as const, path: '/manifest/video-1/playlist.m3u8', query: mediaQuery() },
        { method: 'GET' as const, path: '/media/video-1', query: mediaQuery({ path: 'segment_0.ts' }) },
        { method: 'GET' as const, path: '/key/video-1', query: mediaQuery() },
    ]) {
        const result = await invokeDelivery(harness.router, request);
        assert.equal(result.status, 401, `${request.path} must deny without a durable session row`);
        assert.equal(result.body?.error, 'session_inactive');
        assert.equal(result.chunks.length, 0);
    }
    const refresh = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/refresh-token',
        body: { sessionId: 'sess-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(refresh.status, 401);
    assert.equal(refresh.body?.sessionToken, undefined);
});

test('entitlement delivery: a durable session killed after issuance denies the next request', async () => {
    const harness = makeDeliveryHarness({ records: [makeEntitlementRecord()] });
    assert.equal(harness.durableSessions.rows.get('sess-1')?.isActive, 1);
    const served = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(),
    });
    assert.equal(served.status, 200, 'positive control: the persisted row authorizes delivery');
    assert.equal(harness.durableSessions.deactivate('sess-1'), true);
    const denied = await invokeDelivery(harness.router, {
        method: 'GET', path: '/media/video-1', query: mediaQuery({ path: 'segment_0.ts' }),
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.chunks.length, 0);
});

test('entitlement delivery: an unreadable durable session store denies instead of serving', async () => {
    const harness = makeDeliveryHarness({ records: [makeEntitlementRecord()], durableSession: 'unavailable' });
    const denied = await invokeDelivery(harness.router, {
        method: 'GET', path: '/key/video-1', query: mediaQuery(),
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.chunks.length, 0);
    harness.durableSessions.failReads(null);
    const recovered = await invokeDelivery(harness.router, {
        method: 'GET', path: '/key/video-1', query: mediaQuery(),
    });
    assert.equal(recovered.status, 200, 'recovery restores delivery');
});

test('entitlement session: a unique lesson issues a record bound to tenant, enrollment, lesson and session', async () => {
    const harness = makeDeliveryHarness();
    const result = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/session',
        body: { videoId: 'video-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(result.status, 200);
    assert.equal(harness.created.length, 1);
    assert.deepEqual(harness.entitlement.issued, [{
        tenantId: 'tenant-1',
        lessonId: 'lesson-1',
        studentEnrollmentId: 'enroll-1',
        sessionId: 'sess-1',
    }]);
    // Creation is durable: the row the route wrote is the row delivery reads.
    assert.equal(harness.durableSessions.rows.get('sess-1')?.isActive, 1);
    const served = await invokeDelivery(harness.router, {
        method: 'GET', path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(),
    });
    assert.equal(served.status, 200);
    assert.match(served.text, /#EXTM3U/);
});

test('entitlement session: ambiguous parents deny before a session is created', async () => {
    const harness = makeDeliveryHarness({
        association: { kind: 'ambiguous', lessonId: null, reason: 'ambiguous-material-parents' },
    });
    const result = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/session',
        body: { videoId: 'video-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(result.status, 403);
    assert.equal(result.body?.code, 'VIDEO_PARENT_AMBIGUOUS');
    assert.equal(harness.created.length, 0);
    assert.equal(harness.entitlement.issued.length, 0);
});

test('entitlement session: an issuance failure returns 503 and kills the session', async () => {
    const harness = makeDeliveryHarness({ issueFails: true });
    const result = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/session',
        body: { videoId: 'video-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(result.status, 503);
    assert.equal(result.body?.code, 'PLAYBACK_UNAVAILABLE');
    assert.deepEqual(harness.kills, [{ sessionId: 'sess-1', reason: 'entitlement_unavailable' }]);
});

test('entitlement refresh: a revoked record denies and kills the session', async () => {
    const harness = makeDeliveryHarness({
        records: [makeEntitlementRecord({ revokedAtMs: 1_000_001 })],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/refresh-token',
        body: { sessionId: 'sess-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(result.status, 403);
    assert.equal(result.body?.code, 'PLAYBACK_ENTITLEMENT_DENIED');
    assert.equal(result.body?.reason, 'revoked');
    assert.deepEqual(harness.kills, [{ sessionId: 'sess-1', reason: 'entitlement_denied' }]);
});

test('entitlement refresh: a valid record near expiry is renewed', async () => {
    const harness = makeDeliveryHarness({
        records: [makeEntitlementRecord({ expiresAtMs: 1_060_000 })],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/refresh-token',
        body: { sessionId: 'sess-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(result.status, 200);
    assert.equal(harness.entitlement.issued.length, 1);
    assert.equal(harness.entitlement.issued[0].lessonId, 'lesson-1');
});

test('entitlement refresh: a valid record outside the renewal window is not re-issued', async () => {
    const harness = makeDeliveryHarness({
        records: [makeEntitlementRecord({ expiresAtMs: 1_200_000 })],
    });
    const result = await invokeDelivery(harness.router, {
        method: 'POST',
        path: '/refresh-token',
        body: { sessionId: 'sess-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(result.status, 200);
    assert.equal(harness.entitlement.issued.length, 0);
});

// ---------------------------------------------------------------------------
// Video parent association: the mapping cases, resolved from rows only.
// ---------------------------------------------------------------------------

const parentReader = (fixtures: {
    video?: {
        id: string; course_id: string | null; tenant_id: string | null;
        lecture_id: string | null; material_id: string | null;
        course_row_id: string | null; course_tenant_id: string | null;
    } | null;
    directLecture?: { id: string; course_id: string; tenant_id: string } | null;
    reverseLectures?: Array<{ id: string; course_id: string; tenant_id: string }>;
    directMaterial?: { id: string; course_id: string; tenant_id: string } | null;
    reverseMaterials?: Array<{ id: string; course_id: string; tenant_id: string }>;
}): VideoParentReader => ({
    queryOne: async <T = unknown>(sql: string): Promise<T | null> => {
        const normalized = sql.replace(/\s+/g, ' ');
        if (/FROM videos v/.test(normalized)) return (fixtures.video ?? null) as T | null;
        if (/FROM lectures l/.test(normalized)) return (fixtures.directLecture ?? null) as T | null;
        if (/FROM course_materials cm/.test(normalized)) return (fixtures.directMaterial ?? null) as T | null;
        return null;
    },
    query: async <T = unknown>(sql: string): Promise<T[]> => {
        const normalized = sql.replace(/\s+/g, ' ');
        if (/WHERE l\.video_url/.test(normalized)) return (fixtures.reverseLectures ?? []) as T[];
        if (/WHERE cm\.material_type/.test(normalized)) return (fixtures.reverseMaterials ?? []) as T[];
        return [];
    },
});

const baseVideo = {
    id: 'video-1',
    course_id: 'course-1',
    tenant_id: 'tenant-1',
    lecture_id: 'lesson-1' as string | null,
    material_id: null as string | null,
    course_row_id: 'course-1',
    course_tenant_id: 'tenant-1',
};

test('video association: one lecture across both link directions resolves uniquely', async () => {
    const association = await resolveVideoLessonAssociation('video-1', parentReader({
        video: baseVideo,
        directLecture: { id: 'lesson-1', course_id: 'course-1', tenant_id: 'tenant-1' },
        reverseLectures: [{ id: 'lesson-1', course_id: 'course-1', tenant_id: 'tenant-1' }],
    }));
    assert.deepEqual(association, { kind: 'unique', lessonId: 'lesson-1' });
});

test('video association: two lectures are ambiguous, never "first match"', async () => {
    const association = await resolveVideoLessonAssociation('video-1', parentReader({
        video: baseVideo,
        directLecture: { id: 'lesson-1', course_id: 'course-1', tenant_id: 'tenant-1' },
        reverseLectures: [
            { id: 'lesson-1', course_id: 'course-1', tenant_id: 'tenant-1' },
            { id: 'lesson-2', course_id: 'course-1', tenant_id: 'tenant-1' },
        ],
    }));
    assert.deepEqual(association, { kind: 'ambiguous', lessonId: null, reason: 'ambiguous-lecture-parents' });
});

test('video association: a dangling lecture id is ambiguous', async () => {
    const association = await resolveVideoLessonAssociation('video-1', parentReader({
        video: { ...baseVideo, lecture_id: 'missing-lesson' },
        directLecture: null,
        reverseLectures: [],
    }));
    assert.deepEqual(association, { kind: 'ambiguous', lessonId: null, reason: 'dangling-lecture-parent' });
});

test('video association: a lecture in another course is conflicting provenance', async () => {
    const association = await resolveVideoLessonAssociation('video-1', parentReader({
        video: baseVideo,
        directLecture: { id: 'lesson-1', course_id: 'course-2', tenant_id: 'tenant-1' },
        reverseLectures: [{ id: 'lesson-1', course_id: 'course-2', tenant_id: 'tenant-1' }],
    }));
    assert.deepEqual(association, { kind: 'ambiguous', lessonId: null, reason: 'conflicting-course-provenance' });
});

test('video association: a course-only (tenant-level) video has no lesson and stays on the access policy', async () => {
    const association = await resolveVideoLessonAssociation('video-1', parentReader({
        video: { ...baseVideo, lecture_id: null },
    }));
    assert.deepEqual(association, { kind: 'none', lessonId: null, reason: 'course-only' });
});

test('video association: a material-only video has no lesson and stays on the access policy', async () => {
    const association = await resolveVideoLessonAssociation('video-1', parentReader({
        video: { ...baseVideo, lecture_id: null, material_id: 'material-1' },
        directMaterial: { id: 'material-1', course_id: 'course-1', tenant_id: 'tenant-1' },
        reverseMaterials: [{ id: 'material-1', course_id: 'course-1', tenant_id: 'tenant-1' }],
    }));
    assert.deepEqual(association, { kind: 'none', lessonId: null, reason: 'material-only' });
});
