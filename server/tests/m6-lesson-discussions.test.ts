/**
 * M6 P6 — lesson comments and Q&A (hermetic, no MySQL/network).
 *
 * The REAL lesson-discussion router runs over the REAL auth middleware (an
 * injected principal repository) and injected seams: an in-memory discussion
 * store, an injected `resolveLessonAccess`, an in-memory audit sink, an injected
 * clock and a deterministic id factory. Every access decision is server-derived
 * through the resolver, so no request field can widen scope. No database,
 * provider or network is contacted and no .env is read.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import type { AuditRecordInput } from '../src/security/audit';
import {
    DEFAULT_RETENTION_DAYS,
    MAX_BODY_LENGTH,
    MAX_REASON_LENGTH,
    MAX_TITLE_LENGTH,
    clampListLimit,
    computeRetentionExpiry,
    createUserRateLimiter,
    isThreadVisibleToStudent,
    normalizeRetentionDays,
    parseBlock,
    parseCreateThread,
    parseModeration,
    parseReply,
    parseReport,
    projectThread,
    type DiscussionNotificationHook,
    type LessonAccess,
    type LessonAccessPrincipal,
    type LessonDiscussionsStore,
    type ReplyRow,
    type ThreadRow,
} from '../src/services/lesson-discussions';
import { createLessonDiscussionsRouter, hasLessonTenantReach } from '../src/routes/lesson-discussions';
import { TEST_SECRET, invokeRoute, makeRepository, tokenFor } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const LECTURE = 'lecture-1';
const COURSE = 'course-1';
const STUDENT = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const INSTRUCTOR = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: TENANT });
const OTHER_INSTRUCTOR = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0, tenant_id: OTHER_TENANT });
const T0 = new Date('2026-10-18T12:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('parseCreateThread: requires a bounded title and body', () => {
    assert.equal(parseCreateThread({}).ok, false);
    assert.equal(parseCreateThread({ title: '', body: 'x' }).ok, false);
    assert.equal(parseCreateThread({ title: 'x', body: '' }).ok, false);
    assert.equal(parseCreateThread({ title: 'x'.repeat(MAX_TITLE_LENGTH + 1), body: 'b' }).ok, false);
    assert.equal(parseCreateThread({ title: 'x', body: 'b'.repeat(MAX_BODY_LENGTH + 1) }).ok, false);
    const ok = parseCreateThread({ title: '  Question  ', body: '  Help  ' });
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.value.title, 'Question');
        assert.equal(ok.value.body, 'Help');
        assert.equal(ok.value.retentionDays, DEFAULT_RETENTION_DAYS);
    }
});

test('parseReply: trims and bounds the body', () => {
    assert.equal(parseReply({ body: '   ' }).ok, false);
    assert.equal(parseReply({ body: 'b'.repeat(MAX_BODY_LENGTH + 1) }).ok, false);
    const ok = parseReply({ body: '  answer  ' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.body, 'answer');
});

test('parseModeration: hide/delete require a reason, restore forbids one', () => {
    assert.equal(parseModeration({ action: 'nope' }).ok, false);
    assert.equal(parseModeration({ action: 'hide' }).ok, false);
    assert.equal(parseModeration({ action: 'delete' }).ok, false);
    assert.equal(parseModeration({ action: 'restore', reason: 'x' }).ok, false);
    assert.equal(parseModeration({ action: 'hide', reason: 'r'.repeat(MAX_REASON_LENGTH + 1) }).ok, false);
    const hide = parseModeration({ action: 'hide', reason: ' spam ' });
    assert.equal(hide.ok, true);
    if (hide.ok) { assert.equal(hide.value.action, 'hide'); assert.equal(hide.value.reason, 'spam'); }
    const restore = parseModeration({ action: 'restore' });
    assert.equal(restore.ok, true);
    if (restore.ok) assert.equal(restore.value.reason, null);
});

test('parseReport: validates target type, target id and reason', () => {
    assert.equal(parseReport({ target_type: 'bogus', target_id: 't1', reason: 'r' }).ok, false);
    assert.equal(parseReport({ target_type: 'thread', target_id: 'bad id', reason: 'r' }).ok, false);
    assert.equal(parseReport({ target_type: 'thread', target_id: 't1', reason: '' }).ok, false);
    const ok = parseReport({ target_type: 'reply', target_id: 'r1', reason: 'abuse' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.targetType, 'reply');
});

test('parseBlock: requires a valid blocked_user_id', () => {
    assert.equal(parseBlock({}).ok, false);
    assert.equal(parseBlock({ blocked_user_id: 'has space' }).ok, false);
    const ok = parseBlock({ blocked_user_id: 'user-9' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.blockedUserId, 'user-9');
});

test('retention: normalize clamps and expiry adds whole days', () => {
    assert.equal(normalizeRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
    assert.equal(normalizeRetentionDays(0), 1);
    assert.equal(normalizeRetentionDays(99999), 3650);
    assert.equal(normalizeRetentionDays('30'), 30);
    const expiry = computeRetentionExpiry(new Date(T0), 30);
    assert.equal(expiry.getTime() - T0, 30 * 24 * 60 * 60 * 1000);
});

test('clampListLimit: default, clamp and rejection', () => {
    assert.equal(clampListLimit(undefined), 100);
    assert.equal(clampListLimit('25'), 25);
    assert.equal(clampListLimit('1000'), 200);
    assert.equal(clampListLimit('0'), null);
    assert.equal(clampListLimit('abc'), null);
    assert.equal(clampListLimit(['1', '2']), null);
});

test('createUserRateLimiter: budget then reset on the injected clock', () => {
    let nowMs = T0;
    const limiter = createUserRateLimiter({ max: 2, windowMs: 1000, now: () => new Date(nowMs) });
    assert.equal(limiter.tryConsume('a'), true);
    assert.equal(limiter.tryConsume('a'), true);
    assert.equal(limiter.tryConsume('a'), false);
    assert.equal(limiter.tryConsume('b'), true);
    nowMs += 1001;
    assert.equal(limiter.tryConsume('a'), true);
});

test('projectThread: hidden/deleted bodies never reach a student projection', () => {
    const base: ThreadRow = {
        id: 't1', tenant_id: TENANT, lecture_id: LECTURE, course_id: COURSE,
        author_user_id: 'u1', author_role: 'student', title: 'T', body: 'SECRET',
        status: 'hidden', hidden_reason: 'spam', moderated_by: 'm', moderated_at: null,
        deleted_at: null, retention_expires_at: null, reply_count: 2,
        last_activity_at: T0, version: 1,
    };
    assert.equal(projectThread(base, false).body, null);
    assert.equal(projectThread(base, true).body, 'SECRET');
    assert.equal(isThreadVisibleToStudent({ ...base, status: 'open' }), true);
    assert.equal(isThreadVisibleToStudent({ ...base, status: 'open', deleted_at: new Date(T0) }), false);
});

// ---------------------------------------------------------------------------
// Router harness
// ---------------------------------------------------------------------------

interface StoreState {
    threads: ThreadRow[];
    replies: ReplyRow[];
    reports: Record<string, unknown>[];
    blocks: { id: string; tenant_id: string; blocker_user_id: string; blocked_user_id: string; created_at?: string | Date }[];
    calls: { method: string; args: unknown[] }[];
    failWith: Error | null;
    softDeleteEffect: number;
}

const makeThread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
    id: 'thread-1', tenant_id: TENANT, lecture_id: LECTURE, course_id: COURSE,
    author_user_id: 'student-a', author_role: 'student', title: 'Title', body: 'Body',
    status: 'open', hidden_reason: null, moderated_by: null, moderated_at: null,
    deleted_at: null, retention_expires_at: null, reply_count: 0,
    last_activity_at: T0, version: 0, created_at: T0,
    ...over,
});

const makeReply = (over: Partial<ReplyRow> = {}): ReplyRow => ({
    id: 'reply-1', thread_id: 'thread-1', tenant_id: TENANT,
    author_user_id: 'student-a', author_role: 'student', body: 'Answer',
    status: 'visible', hidden_reason: null, moderated_by: null, moderated_at: null,
    deleted_at: null, retention_expires_at: null, created_at: T0,
    ...over,
});

const makeStore = (state: StoreState): LessonDiscussionsStore => {
    const guard = (): void => { if (state.failWith) throw state.failWith; };
    return {
        listThreads: async (tenantId, lectureId, limit) => {
            state.calls.push({ method: 'listThreads', args: [tenantId, lectureId, limit] });
            guard();
            return state.threads.filter((t) => t.tenant_id === tenantId && t.lecture_id === lectureId && t.deleted_at === null).slice(0, limit);
        },
        findThreadById: async (id) => state.threads.find((t) => t.id === id) ?? null,
        listReplies: async (tenantId, threadId, limit) => {
            state.calls.push({ method: 'listReplies', args: [tenantId, threadId, limit] });
            guard();
            return state.replies.filter((r) => r.tenant_id === tenantId && r.thread_id === threadId && r.deleted_at === null).slice(0, limit);
        },
        findReplyById: async (id) => state.replies.find((r) => r.id === id) ?? null,
        insertThread: async (row) => { state.calls.push({ method: 'insertThread', args: [row] }); guard(); state.threads.push({ ...row }); },
        insertReply: async (row, activityAt) => {
            state.calls.push({ method: 'insertReply', args: [row, activityAt] });
            guard();
            state.replies.push({ ...row });
            const thread = state.threads.find((t) => t.id === row.thread_id);
            if (thread) { thread.reply_count += 1; thread.last_activity_at = activityAt; }
        },
        setThreadStatus: async (tenantId, threadId, status, reason, actor, at) => {
            state.calls.push({ method: 'setThreadStatus', args: [tenantId, threadId, status, reason, actor, at] });
            guard();
            const thread = state.threads.find((t) => t.id === threadId && t.tenant_id === tenantId && t.deleted_at === null);
            if (!thread) return 0;
            thread.status = status; thread.hidden_reason = reason; thread.moderated_by = actor; thread.moderated_at = at;
            return 1;
        },
        setReplyStatus: async (tenantId, replyId, status, reason, actor, at) => {
            state.calls.push({ method: 'setReplyStatus', args: [tenantId, replyId, status, reason, actor, at] });
            guard();
            const reply = state.replies.find((r) => r.id === replyId && r.tenant_id === tenantId && r.deleted_at === null);
            if (!reply) return 0;
            reply.status = status; reply.hidden_reason = reason; reply.moderated_by = actor; reply.moderated_at = at;
            return 1;
        },
        softDeleteThread: async (tenantId, threadId, actor, at, retention) => {
            state.calls.push({ method: 'softDeleteThread', args: [tenantId, threadId, actor, at, retention] });
            guard();
            const thread = state.threads.find((t) => t.id === threadId && t.tenant_id === tenantId && t.deleted_at === null);
            if (!thread) return 0;
            thread.status = 'deleted'; thread.deleted_at = at;
            thread.moderated_by = actor; thread.moderated_at = at; thread.retention_expires_at = retention;
            return state.softDeleteEffect;
        },
        softDeleteReply: async (tenantId, replyId, actor, at, retention) => {
            state.calls.push({ method: 'softDeleteReply', args: [tenantId, replyId, actor, at, retention] });
            guard();
            const reply = state.replies.find((r) => r.id === replyId && r.tenant_id === tenantId && r.deleted_at === null);
            if (!reply) return 0;
            reply.status = 'deleted'; reply.deleted_at = at; reply.moderated_by = actor;
            reply.moderated_at = at; reply.retention_expires_at = retention;
            return state.softDeleteEffect;
        },
        insertReport: async (row) => { state.calls.push({ method: 'insertReport', args: [row] }); guard(); state.reports.push({ ...row }); },
        findBlock: async (tenantId, blocker, blocked) =>
            state.blocks.find((b) => b.tenant_id === tenantId && b.blocker_user_id === blocker && b.blocked_user_id === blocked) ?? null,
        listBlocks: async (tenantId, blocker) => {
            state.calls.push({ method: 'listBlocks', args: [tenantId, blocker] });
            guard();
            return state.blocks.filter((b) => b.tenant_id === tenantId && b.blocker_user_id === blocker);
        },
        insertBlock: async (row) => { state.calls.push({ method: 'insertBlock', args: [row] }); guard(); state.blocks.push({ ...row, created_at: T0 }); },
        deleteBlock: async (tenantId, blocker, blocked) => {
            state.calls.push({ method: 'deleteBlock', args: [tenantId, blocker, blocked] });
            guard();
            const index = state.blocks.findIndex((b) => b.tenant_id === tenantId && b.blocker_user_id === blocker && b.blocked_user_id === blocked);
            if (index < 0) return 0;
            state.blocks.splice(index, 1);
            return 1;
        },
    };
};

const allowAccess = (over: Partial<LessonAccess> = {}): LessonAccess => ({
    allowed: true, tenantId: TENANT, courseId: COURSE, branchId: null,
    branchAmbiguous: false, isStaff: false, enrollmentId: 'enr-a', ...over,
});

interface Harness {
    router: ReturnType<typeof createLessonDiscussionsRouter>;
    state: StoreState;
    audits: AuditRecordInput[];
    notifyCalls: string[];
    accessCalls: { principal: LessonAccessPrincipal; lectureId: string }[];
}

interface BuildOptions {
    access?: (principal: LessonAccessPrincipal, lectureId: string) => LessonAccess | Promise<LessonAccess>;
    users?: Record<string, { is_active: number; token_version: number; suspension_active: number; role?: string }>;
    notificationHook?: DiscussionNotificationHook;
    auditFails?: boolean;
    softDeleteEffect?: number;
}

const buildHarness = (state: StoreState, options: BuildOptions = {}): Harness => {
    const users = options.users ?? {
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: {
            'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: { 'instructor-a': [{ tenant_id: TENANT }], 'instructor-b': [{ tenant_id: OTHER_TENANT }] },
        enrollments: {
            'student-a': [{ id: 'enr-a', user_id: 'student-a', tenant_id: TENANT, instructor_id: 'instructor-a', group_id: null, grade_id: null }],
        },
    });
    const audits: AuditRecordInput[] = [];
    const notifyCalls: string[] = [];
    const accessCalls: { principal: LessonAccessPrincipal; lectureId: string }[] = [];
    let counter = 0;
    const notifyCallsHook: DiscussionNotificationHook = options.notificationHook ?? {
        onThreadCreated: async () => { notifyCalls.push('thread'); },
        onReplyCreated: async () => { notifyCalls.push('reply'); },
        onModerated: async () => { notifyCalls.push('moderated'); },
        onReported: async () => { notifyCalls.push('reported'); },
    };
    const router = createLessonDiscussionsRouter({
        store: makeStore(state),
        authenticate: createAuthenticateToken(repository),
        resolveLessonAccess: async (principal, lectureId) => {
            accessCalls.push({ principal, lectureId });
            return options.access ? options.access(principal, lectureId) : allowAccess();
        },
        audit: async (input) => {
            if (options.auditFails) throw new Error('audit sink down');
            audits.push(input);
        },
        notify: notifyCallsHook,
        now: () => new Date(T0),
        idFactory: () => `gen-${++counter}`,
    });
    return { router, state, audits, notifyCalls, accessCalls };
};

const makeState = (over: Partial<StoreState> = {}): StoreState => ({
    threads: [], replies: [], reports: [], blocks: [], calls: [],
    failWith: null, softDeleteEffect: 1, ...over,
});

const request = (h: Harness, method: string, url: string, token?: string | null, body?: unknown, query?: Record<string, string>) =>
    invokeRoute(h.router, { method, url, token, body, query });

// ---------------------------------------------------------------------------
// Authentication + access boundary
// ---------------------------------------------------------------------------

test('auth: anonymous writes/reads are 401 and touch neither store nor audit', async () => {
    const h = buildHarness(makeState());
    assert.equal((await request(h, 'GET', `/lessons/${LECTURE}/threads`)).statusCode, 401);
    assert.equal((await request(h, 'POST', `/lessons/${LECTURE}/threads`, null, { title: 'T', body: 'B' })).statusCode, 401);
    assert.equal((await request(h, 'GET', '/blocks')).statusCode, 401);
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.audits.length, 0);
});

test('access: a denied lesson is 404 with no store read and no enumeration', async () => {
    const h = buildHarness(makeState(), {
        access: () => ({ allowed: false, tenantId: null, courseId: null, branchId: null, branchAmbiguous: false, isStaff: false, enrollmentId: null }),
    });
    const list = await request(h, 'GET', `/lessons/${LECTURE}/threads`, STUDENT);
    assert.equal(list.statusCode, 404);
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.accessCalls.length, 1);
});

test('access: an ambiguous branch scope is denied with 403', async () => {
    const h = buildHarness(makeState(), { access: () => allowAccess({ branchAmbiguous: true }) });
    assert.equal((await request(h, 'GET', `/lessons/${LECTURE}/threads`, STUDENT)).statusCode, 403);
    assert.equal(h.state.calls.length, 0);
});

test('access: a cross-tenant store row is hidden even when the resolver allows the tenant', async () => {
    const h = buildHarness(makeState({ threads: [makeThread({ id: 'thread-x', tenant_id: OTHER_TENANT })] }));
    assert.equal((await request(h, 'GET', '/threads/thread-x', STUDENT)).statusCode, 404);
});

test('H1: tenant reach needs a verified platform capability; an admin role label alone is never enough', async () => {
    const platform = async (id: string): Promise<boolean> => id === 'platform-op';
    // Same server-derived tenant: allowed without any platform capability.
    assert.equal(await hasLessonTenantReach({ id: 'instructor-a', tenantId: TENANT }, TENANT, platform), true);
    // A bare `admin` role label with no tenant (or a different tenant) is denied.
    assert.equal(await hasLessonTenantReach({ id: 'admin-a', tenantId: null }, TENANT, platform), false);
    assert.equal(await hasLessonTenantReach({ id: 'admin-a', tenantId: OTHER_TENANT }, TENANT, platform), false);
    // Cross-tenant reach is allowed only through the verified capability.
    assert.equal(await hasLessonTenantReach({ id: 'platform-op', tenantId: null }, TENANT, platform), true);
    assert.equal(await hasLessonTenantReach({ id: 'platform-op', tenantId: OTHER_TENANT }, TENANT, platform), true);
    // An unverified lookup denies.
    assert.equal(await hasLessonTenantReach({ id: 'admin-a', tenantId: null }, TENANT, async () => false), false);
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test('list: students see only visible threads; hidden ones stay for staff', async () => {
    const state = makeState({
        threads: [
            makeThread({ id: 'open-1', status: 'open' }),
            makeThread({ id: 'hidden-1', status: 'hidden' }),
        ],
    });
    const student = buildHarness(state);
    const studentView = await request(student, 'GET', `/lessons/${LECTURE}/threads`, STUDENT);
    assert.equal(studentView.statusCode, 200);
    assert.deepEqual((studentView.body as { id: string }[]).map((t) => t.id), ['open-1']);
    assert.equal(student.state.calls[0].args[0], TENANT);

    const staffState = makeState({
        threads: [
            makeThread({ id: 'open-1', status: 'open' }),
            makeThread({ id: 'hidden-1', status: 'hidden' }),
        ],
    });
    const staff = buildHarness(staffState, { access: () => allowAccess({ isStaff: true, enrollmentId: null }) });
    const staffView = await request(staff, 'GET', `/lessons/${LECTURE}/threads`, INSTRUCTOR);
    assert.deepEqual((staffView.body as { id: string }[]).map((t) => t.id).sort(), ['hidden-1', 'open-1']);
});

test('list: a caller never receives threads authored by a blocked user', async () => {
    const state = makeState({
        threads: [makeThread({ id: 'by-1', author_user_id: 'user-1' }), makeThread({ id: 'by-2', author_user_id: 'user-2' })],
        blocks: [{ id: 'b1', tenant_id: TENANT, blocker_user_id: 'student-a', blocked_user_id: 'user-1' }],
    });
    const h = buildHarness(state);
    const response = await request(h, 'GET', `/lessons/${LECTURE}/threads`, STUDENT);
    assert.deepEqual((response.body as { id: string }[]).map((t) => t.id), ['by-2']);
});

test('list: an invalid limit is 400 before any store read', async () => {
    const h = buildHarness(makeState());
    assert.equal((await request(h, 'GET', `/lessons/${LECTURE}/threads`, STUDENT, undefined, { limit: 'abc' })).statusCode, 400);
    assert.equal(h.state.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Create thread / reply
// ---------------------------------------------------------------------------

test('create thread: validates, persists, audits and notifies with ids only', async () => {
    const h = buildHarness(makeState());
    const response = await request(h, 'POST', `/lessons/${LECTURE}/threads`, STUDENT, { title: ' Q ', body: ' help ' });
    assert.equal(response.statusCode, 201);
    const body = response.body as { id: string; status: string; body: string };
    assert.equal(body.status, 'open');
    assert.equal(body.body, 'help');
    assert.equal(h.state.threads.length, 1);
    assert.equal(h.state.threads[0].tenant_id, TENANT);
    assert.equal(h.state.threads[0].course_id, COURSE);
    assert.equal(h.audits[0].action, 'thread.create');
    assert.deepEqual(h.notifyCalls, ['thread']);
    assert.equal(JSON.stringify(h.audits[0]).includes('help'), false);
});

test('create thread: an invalid payload is 400 with no write', async () => {
    const h = buildHarness(makeState());
    assert.equal((await request(h, 'POST', `/lessons/${LECTURE}/threads`, STUDENT, { title: '' })).statusCode, 400);
    assert.equal(h.state.threads.length, 0);
    assert.equal(h.audits.length, 0);
});

test('create thread: a failed audit aborts the accepted write (500, no row)', async () => {
    const h = buildHarness(makeState(), { auditFails: true });
    const response = await request(h, 'POST', `/lessons/${LECTURE}/threads`, STUDENT, { title: 'T', body: 'B' });
    assert.equal(response.statusCode, 500);
});

test('create thread: the per-user limiter caps a burst at 10 with a 429', async () => {
    const h = buildHarness(makeState());
    for (let i = 0; i < 10; i += 1) {
        assert.equal((await request(h, 'POST', `/lessons/${LECTURE}/threads`, STUDENT, { title: 'T', body: 'B' })).statusCode, 201);
    }
    assert.equal((await request(h, 'POST', `/lessons/${LECTURE}/threads`, STUDENT, { title: 'T', body: 'B' })).statusCode, 429);
    assert.equal(h.state.threads.length, 10);
});

test('create reply: a student cannot reply to a hidden thread; staff can', async () => {
    const state = makeState({ threads: [makeThread({ id: 'thread-1', status: 'hidden' })] });
    const student = buildHarness(state);
    assert.equal((await request(student, 'POST', '/threads/thread-1/replies', STUDENT, { body: 'hi' })).statusCode, 404);
    assert.equal(student.state.replies.length, 0);

    const staffState = makeState({ threads: [makeThread({ id: 'thread-1', status: 'hidden' })] });
    const staff = buildHarness(staffState, { access: () => allowAccess({ isStaff: true, enrollmentId: null }) });
    const ok = await request(staff, 'POST', '/threads/thread-1/replies', INSTRUCTOR, { body: 'staff note' });
    assert.equal(ok.statusCode, 201);
    assert.equal(staffState.replies.length, 1);
    assert.equal(staff.audits[0].action, 'reply.create');
    assert.deepEqual(staff.notifyCalls, ['reply']);
});

test('create reply: a notification failure never fails the accepted reply', async () => {
    const h = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1' })] }), {
        notificationHook: {
            onThreadCreated: async () => undefined,
            onReplyCreated: async () => { throw new Error('provider down'); },
            onModerated: async () => undefined,
            onReported: async () => undefined,
        },
    });
    assert.equal((await request(h, 'POST', '/threads/thread-1/replies', STUDENT, { body: 'x' })).statusCode, 201);
    assert.equal(h.state.replies.length, 1);
});

// ---------------------------------------------------------------------------
// Deletion / retention
// ---------------------------------------------------------------------------

test('delete thread: the author soft-deletes with a retention window', async () => {
    const h = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1' })] }));
    const response = await request(h, 'DELETE', '/threads/thread-1', STUDENT);
    assert.equal(response.statusCode, 200);
    const body = response.body as { status: string; retention_expires_at: string };
    assert.equal(body.status, 'deleted');
    assert.equal(Date.parse(body.retention_expires_at) - T0, DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    assert.equal(h.audits[0].action, 'thread.delete');
});

test('delete thread: a non-author student is 403; staff may delete', async () => {
    const h = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1', author_user_id: 'someone-else' })] }));
    assert.equal((await request(h, 'DELETE', '/threads/thread-1', STUDENT)).statusCode, 403);
    assert.equal(h.audits.length, 0);

    const staffState = makeState({ threads: [makeThread({ id: 'thread-1', author_user_id: 'someone-else' })] });
    const staff = buildHarness(staffState, { access: () => allowAccess({ isStaff: true, enrollmentId: null }) });
    assert.equal((await request(staff, 'DELETE', '/threads/thread-1', INSTRUCTOR)).statusCode, 200);
    assert.equal(staff.audits[0].action, 'thread.delete');
});

test('delete reply: an already-deleted row is not deleted twice', async () => {
    const h = buildHarness(makeState({ replies: [makeReply({ id: 'reply-1' })], threads: [makeThread({ id: 'thread-1' })], softDeleteEffect: 0 }));
    assert.equal((await request(h, 'DELETE', '/replies/reply-1', STUDENT)).statusCode, 409);
    assert.equal(h.audits.length, 0);
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

test('moderate: a student is 403; staff hide requires a reason', async () => {
    const student = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1' })] }));
    assert.equal((await request(student, 'POST', '/threads/thread-1/moderate', STUDENT, { action: 'hide', reason: 'x' })).statusCode, 403);

    const staff = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1' })] }), { access: () => allowAccess({ isStaff: true, enrollmentId: null }) });
    assert.equal((await request(staff, 'POST', '/threads/thread-1/moderate', INSTRUCTOR, { action: 'hide' })).statusCode, 400);
    assert.equal(staff.state.threads[0].status, 'open');
});

test('moderate: staff hide and restore a thread with an audit trail', async () => {
    const h = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1' })] }), { access: () => allowAccess({ isStaff: true, enrollmentId: null }) });
    const hide = await request(h, 'POST', '/threads/thread-1/moderate', INSTRUCTOR, { action: 'hide', reason: 'spam' });
    assert.equal(hide.statusCode, 200);
    assert.equal((hide.body as { status: string }).status, 'hidden');
    assert.equal(h.state.threads[0].hidden_reason, 'spam');
    assert.equal(h.audits[0].action, 'thread.moderate.hide');

    const restore = await request(h, 'POST', '/threads/thread-1/moderate', INSTRUCTOR, { action: 'restore' });
    assert.equal(restore.statusCode, 200);
    assert.equal(h.state.threads[0].status, 'open');
    assert.equal(h.audits[1].action, 'thread.moderate.restore');
});

test('moderate: a reply can be hidden by staff', async () => {
    const h = buildHarness(makeState({ replies: [makeReply({ id: 'reply-1' })], threads: [makeThread({ id: 'thread-1' })] }), {
        access: () => allowAccess({ isStaff: true, enrollmentId: null }),
    });
    const response = await request(h, 'POST', '/replies/reply-1/moderate', INSTRUCTOR, { action: 'hide', reason: 'off-topic' });
    assert.equal(response.statusCode, 200);
    assert.equal(h.state.replies[0].status, 'hidden');
    assert.equal(h.audits[0].action, 'reply.moderate.hide');
});

// ---------------------------------------------------------------------------
// Reports and blocks
// ---------------------------------------------------------------------------

test('report: own content is rejected; a foreign target is reported and audited', async () => {
    const own = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1', author_user_id: 'student-a' })] }));
    assert.equal((await request(own, 'POST', '/reports', STUDENT, { target_type: 'thread', target_id: 'thread-1', reason: 'x' })).statusCode, 400);

    const state = makeState({
        threads: [makeThread({ id: 'thread-1', author_user_id: 'other' })],
        replies: [makeReply({ id: 'reply-1', author_user_id: 'other' })],
    });
    const h = buildHarness(state);
    const response = await request(h, 'POST', '/reports', STUDENT, { target_type: 'reply', target_id: 'reply-1', reason: 'abuse' });
    assert.equal(response.statusCode, 201);
    assert.equal(h.state.reports.length, 1);
    assert.equal(h.audits[0].action, 'discussion.report');
    assert.deepEqual(h.notifyCalls, ['reported']);
});

test('report: a target outside the caller access is 404', async () => {
    const h = buildHarness(makeState({ threads: [makeThread({ id: 'thread-1', tenant_id: OTHER_TENANT })] }));
    assert.equal((await request(h, 'POST', '/reports', STUDENT, { target_type: 'thread', target_id: 'thread-1', reason: 'x' })).statusCode, 404);
    assert.equal(h.state.reports.length, 0);
});

test('blocks: self-block is rejected and a valid block is idempotent', async () => {
    const h = buildHarness(makeState());
    assert.equal((await request(h, 'POST', '/blocks', STUDENT, { blocked_user_id: 'student-a' })).statusCode, 400);
    const created = await request(h, 'POST', '/blocks', STUDENT, { blocked_user_id: 'user-9' });
    assert.equal(created.statusCode, 201);
    assert.equal((created.body as { created: boolean }).created, true);
    const again = await request(h, 'POST', '/blocks', STUDENT, { blocked_user_id: 'user-9' });
    assert.equal(again.statusCode, 200);
    assert.equal((again.body as { created: boolean }).created, false);
    assert.equal(h.audits.filter((a) => a.action === 'discussion.block').length, 1);
});

test('blocks: a block is tenant-scoped and unblock removes it', async () => {
    const h = buildHarness(makeState());
    assert.equal((await request(h, 'POST', '/blocks', STUDENT, { blocked_user_id: 'user-9' })).statusCode, 201);
    const list = await request(h, 'GET', '/blocks', STUDENT);
    assert.deepEqual((list.body as { blocked_user_id: string }[]).map((r) => r.blocked_user_id), ['user-9']);
    const removed = await request(h, 'DELETE', '/blocks/user-9', STUDENT);
    assert.equal((removed.body as { removed: boolean }).removed, true);
    assert.equal(h.state.blocks.length, 0);
    assert.equal(h.audits.some((a) => a.action === 'discussion.unblock'), true);
});

// ---------------------------------------------------------------------------
// Failure surface
// ---------------------------------------------------------------------------

test('failure: a store error surfaces as 500 without leaking details', async () => {
    const h = buildHarness(makeState({ failWith: new Error('simulated outage'), threads: [makeThread()] }));
    const response = await request(h, 'GET', `/lessons/${LECTURE}/threads`, STUDENT);
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.stringify(response.body).includes('simulated outage'), false);
});

test('the resolver receives the server-derived principal, never a body field', async () => {
    const h = buildHarness(makeState());
    await request(h, 'GET', `/lessons/${LECTURE}/threads`, STUDENT, undefined, { tenant_id: OTHER_TENANT, branch_id: 'br-x' });
    assert.equal(h.accessCalls.length, 1);
    assert.equal(h.accessCalls[0].principal.tenantId, TENANT);
    assert.equal(h.accessCalls[0].principal.id, 'student-a');
    assert.equal(h.accessCalls[0].lectureId, LECTURE);
});
