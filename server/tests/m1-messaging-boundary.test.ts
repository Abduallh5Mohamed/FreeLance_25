import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestHandler } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    authorizeMessageParticipant,
    authorizeMessageRecipient,
    validateMessagePayload,
    MESSAGE_TEXT_MAX_LENGTH,
} from '../src/security/message-access-policy';
import { enforceStudentWorkspaceBoundary } from '../src/middleware/student-workspace-boundary';
import { validateAiChatMessage, AI_CHAT_MESSAGE_MAX_LENGTH } from '../src/routes/ai-chat';
import { validateStaffCreate } from '../src/routes/staff';
import { createMessagesRouter, type MessagesRouterDeps } from '../src/routes/messages';
import type { AuthRequest } from '../src/middleware/auth';

// ---------------------------------------------------------------------------
// Pure policy: payload limits, self-send, participant scope
// ---------------------------------------------------------------------------

test('message payload: text requires bounded content, image requires bounded reference', () => {
    assert.equal(validateMessagePayload({ receiverId: 'b', content: '', messageType: 'text' }).ok, false);
    assert.equal(validateMessagePayload({ receiverId: 'b', content: 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH + 1) }).ok, false);
    assert.equal(validateMessagePayload({ receiverId: 'b', content: 'hi' }).ok, true);
    assert.equal(validateMessagePayload({ receiverId: 'b', messageType: 'video', content: 'hi' }).ok, false);
    assert.equal(validateMessagePayload({ receiverId: 'b', messageType: 'image', imageUrl: '' }).ok, false);
    assert.equal(validateMessagePayload({ receiverId: '', content: 'hi' }).ok, false);
});

test('message recipient: self-send is denied before any relation lookup', async () => {
    let called = false;
    const decision = await authorizeMessageRecipient(
        { areMessageRelated: async () => { called = true; return true; } },
        'user-a',
        'user-a',
    );
    assert.equal(decision.allowed, false);
    assert.equal(called, false);
});

test('message recipient: unrelated cross-tenant pair is denied', async () => {
    const decision = await authorizeMessageRecipient(
        { areMessageRelated: async () => false },
        'user-a',
        'stranger-b',
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.error, 'Receiver is outside your workspace network');
});

test('message participant: stranger and missing message are denied', async () => {
    const missing = await authorizeMessageParticipant(
        { findMessageParticipants: async () => null }, '999', 'user-a',
    );
    assert.equal(missing.allowed, false);
    const stranger = await authorizeMessageParticipant(
        { findMessageParticipants: async () => ({ senderId: 'a', receiverId: 'b' }) }, '1', 'stranger',
    );
    assert.equal(stranger.allowed, false);
    const participant = await authorizeMessageParticipant(
        { findMessageParticipants: async () => ({ senderId: 'a', receiverId: 'b' }) }, '1', 'a',
    );
    assert.equal(participant.allowed, true);
});

// ---------------------------------------------------------------------------
// Student workspace boundary: params + receiver keys fail fast
// ---------------------------------------------------------------------------

const boundaryRes = (): { statusCode: number; payload: unknown; status(c: number): unknown; json(p: unknown): unknown } => {
    const res = {
        statusCode: 200, payload: undefined as unknown,
        status(code: number) { res.statusCode = code; return res; },
        json(payload: unknown) { res.payload = payload; return res; },
    };
    return res;
};

test('student boundary: cross-student body substitution is denied', () => {
    const req = {
        path: '/api/messages/send', body: { receiver_id: 'x', student_id: 'student-b' }, query: {}, params: {},
        user: { id: 'student-a', role: 'student', tenantId: 't-a', studentEnrollmentId: 'enrollment-a', instructorId: 'i-a', groupId: 'g-a', gradeId: 'gr-a' },
    } as unknown as AuthRequest;
    const res = boundaryRes();
    let next = false;
    enforceStudentWorkspaceBoundary(req, res as never, () => { next = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(next, false);
});

test('student boundary: self-echo receiver is denied at the boundary', () => {
    const req = {
        path: '/api/messages/send', body: { receiver_id: 'student-a' }, query: {}, params: {},
        user: { id: 'student-a', role: 'student', tenantId: 't-a', studentEnrollmentId: 'enrollment-a', instructorId: 'i-a', groupId: 'g-a', gradeId: 'gr-a' },
    } as unknown as AuthRequest;
    const res = boundaryRes();
    let next = false;
    enforceStudentWorkspaceBoundary(req, res as never, () => { next = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(next, false);
});

test('student boundary: camelCase workspace substitution is denied', () => {
    const req = {
        path: '/api/x', body: {}, query: { tenantId: 'tenant-b' }, params: {},
        user: { id: 'student-a', role: 'student', tenantId: 'tenant-a', studentEnrollmentId: 'e-a', instructorId: 'i-a', groupId: 'g-a', gradeId: 'gr-a' },
    } as unknown as AuthRequest;
    const res = boundaryRes();
    let next = false;
    enforceStudentWorkspaceBoundary(req, res as never, () => { next = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(next, false);
});

// ---------------------------------------------------------------------------
// AI chat + staff input limits (pure)
// ---------------------------------------------------------------------------

test('ai-chat: empty and overlong messages are rejected', () => {
    assert.equal(validateAiChatMessage('').ok, false);
    assert.equal(validateAiChatMessage('   ').ok, false);
    assert.equal(validateAiChatMessage('x'.repeat(AI_CHAT_MESSAGE_MAX_LENGTH + 1)).ok, false);
    assert.equal(validateAiChatMessage('ما هي أسباب الحملة الفرنسية؟').ok, true);
});

test('staff create: overlong name, bad phone, short password, bad pages rejected', () => {
    assert.equal(validateStaffCreate({ name: 'x'.repeat(101), phone: '+201000000001', password: 'strong-pass-1', accessible_pages: [] }).ok, false);
    assert.equal(validateStaffCreate({ name: 'A', phone: '12', password: 'strong-pass-1' }).ok, false);
    assert.equal(validateStaffCreate({ name: 'A', phone: '+201000000001', password: 'short' }).ok, false);
    assert.equal(validateStaffCreate({ name: 'A', phone: '+201000000001', password: 'strong-pass-1', accessible_pages: ['x'.repeat(65)] }).ok, false);
    assert.equal(validateStaffCreate({ name: 'A', phone: '+201000000001', password: 'strong-pass-1', accessible_pages: ['messages'] }).ok, true);
});

// ---------------------------------------------------------------------------
// Messages router: hermetic behavioral tests over injected fixtures
// ---------------------------------------------------------------------------

interface FixtureState {
    related: Set<string>;
    participants: Record<string, { senderId: string; receiverId: string }>;
    executed: Array<{ sql: string; params: unknown[]; kind: 'query' | 'execute' }>;
}

const pairKey = (a: string, b: string): string => [a, b].sort().join('|');

const makeDeps = (
    users: Record<string, AuthRequest['user']>,
    state: FixtureState,
): { deps: MessagesRouterDeps; state: FixtureState } => {
    const authenticate: RequestHandler = (req, _res, next) => {
        const header = String((req.headers as Record<string, string>).authorization || '');
        const token = header.replace(/^Bearer\s+/i, '');
        (req as AuthRequest).user = users[token] as AuthRequest['user'];
        next();
    };
    const deps: MessagesRouterDeps = {
        authenticate,
        hasVerifiedPlatformCapability: async (userId) => userId === 'platform-admin',
        db: {
            queryRows: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
                state.executed.push({ sql, params, kind: 'query' });
                if (sql.includes('SELECT 1 AS related')) {
                    const [a, b] = params as [string, string];
                    return (state.related.has(pairKey(String(a), String(b))) ? [{ '1': 1 }] : []) as unknown as T[];
                }
                if (sql.includes('SELECT sender_id, receiver_id FROM messages WHERE id = ?')) {
                    const row = state.participants[String(params[0])];
                    return (row ? [{ sender_id: row.senderId, receiver_id: row.receiverId }] : []) as unknown as T[];
                }
                if (sql.includes('FROM users u') && sql.includes('tenant_memberships')) {
                    return [] as unknown as T[];
                }
                if (sql.includes('FROM messages m')) {
                    return [] as unknown as T[];
                }
                return [] as unknown as T[];
            },
            execute: async (sql: string, params: unknown[] = []): Promise<{ affectedRows: number; insertId: number }> => {
                state.executed.push({ sql, params, kind: 'execute' });
                return { affectedRows: 1, insertId: 42 };
            },
        },
    };
    return { deps, state };
};

const invoke = async (
    router: ReturnType<typeof createMessagesRouter>,
    method: string,
    url: string,
    token: string | null,
    body?: unknown,
): Promise<{ status?: number; body?: unknown }> => {
    const response: { status?: number; body?: unknown } = {};
    const res = {
        status(code: number) { response.status = code; return res; },
        setHeader() { return res; },
        header() { return res; },
        json(payload: unknown) {
            if (response.status === undefined) response.status = 200;
            response.body = payload;
            return res;
        },
    };
    const req = {
        method, url, originalUrl: url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: body ?? {},
        query: {}, params: {},
    };
    await (router as unknown as (rq: unknown, rs: unknown, n: () => void) => Promise<void>)(req, res, () => undefined);
    const deadline = Date.now() + 5000;
    while (response.status === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((r) => setImmediate(r));
    }
    return response;
};

const USERS: Record<string, AuthRequest['user']> = {
    'teacher-a': { id: 'teacher-a', role: 'teacher', tenantId: 'tenant-a', email: null, phone: null },
    'teacher-b': { id: 'teacher-b', role: 'teacher', tenantId: 'tenant-b', email: null, phone: null },
    'student-a': { id: 'student-a', role: 'student', tenantId: 'tenant-a', studentEnrollmentId: 'enrollment-a', email: null, phone: null },
};

const freshState = (): FixtureState => ({
    related: new Set([pairKey('teacher-a', 'student-a')]),
    participants: { '7': { senderId: 'teacher-a', receiverId: 'student-a' } },
    executed: [],
});

test('messages read: unrelated cross-tenant peer is denied before any message read', async () => {
    const state = freshState();
    const { deps } = makeDeps(USERS, state);
    const router = createMessagesRouter(deps);
    const res = await invoke(router, 'GET', '/teacher-b', 'teacher-a');
    assert.equal(res.status, 403);
    assert.ok(!state.executed.some((e) => e.sql.includes('FROM messages m')), 'no message rows may be read for an unrelated peer');
});

test('messages send: unrelated receiver is denied with no INSERT', async () => {
    const state = freshState();
    const { deps } = makeDeps(USERS, state);
    const router = createMessagesRouter(deps);
    const res = await invoke(router, 'POST', '/send', 'teacher-a', { receiver_id: 'teacher-b', content: 'hi' });
    assert.equal(res.status, 403);
    assert.ok(!state.executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO messages')));
});

test('messages send: overlong content is rejected with 400 and no INSERT', async () => {
    const state = freshState();
    const { deps } = makeDeps(USERS, state);
    const router = createMessagesRouter(deps);
    const res = await invoke(router, 'POST', '/send', 'teacher-a', { receiver_id: 'student-a', content: 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH + 1) });
    assert.equal(res.status, 400);
    assert.ok(!state.executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO messages')));
});

test('messages send: self-send is rejected with 400 and no INSERT', async () => {
    const state = freshState();
    const { deps } = makeDeps(USERS, state);
    const router = createMessagesRouter(deps);
    const res = await invoke(router, 'POST', '/send', 'teacher-a', { receiver_id: 'teacher-a', content: 'hi' });
    assert.equal(res.status, 400);
    assert.ok(!state.executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO messages')));
});

test('messages edit/delete: stranger gets 404 (no existence oracle)', async () => {
    const state = freshState();
    const { deps } = makeDeps(USERS, state);
    const router = createMessagesRouter(deps);
    const edit = await invoke(router, 'PUT', '/7/edit', 'teacher-b', { content: 'hijack' });
    assert.equal(edit.status, 404);
    const del = await invoke(router, 'DELETE', '/7', 'teacher-b');
    assert.equal(del.status, 404);
    assert.ok(!state.executed.some((e) => e.kind === 'execute' && (e.sql.includes('UPDATE messages') || e.sql.includes('INSERT INTO message_deletions'))));
});

test('messages directory: teacher listing is tenant-scoped in SQL', async () => {
    const state = freshState();
    const { deps } = makeDeps(USERS, state);
    const router = createMessagesRouter(deps);
    const res = await invoke(router, 'GET', '/users/available', 'teacher-a');
    assert.equal(res.status, 200);
    const scoped = state.executed.find((e) => e.sql.includes('FROM users u') && e.sql.includes('tenant_memberships'));
    assert.ok(scoped, 'teacher directory must join tenant_memberships');
    assert.ok(scoped!.params.includes('tenant-a'), 'tenant binding must be the server-derived tenant');
    assert.ok(!scoped!.sql.includes('01024083057'), 'hardcoded teacher identity must not return');
});

// ---------------------------------------------------------------------------
// Static wiring: no hardcoded staff impersonation, rate limits present
// ---------------------------------------------------------------------------

test('wiring: messages REST has no hardcoded staff identity and is rate-limited', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'messages.ts'), 'utf8');
    assert.doesNotMatch(src, /01024083057/);
    assert.doesNotMatch(src, /staff acts as teacher/i);
    assert.match(src, /rateLimit\('messages-send'/);
    assert.match(src, /authorizeMessageRecipient/);
    assert.match(src, /authorizeMessageParticipant/);
});

test('wiring: ai-chat validates length and is rate-limited', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'ai-chat.ts'), 'utf8');
    assert.match(src, /validateAiChatMessage/);
    assert.match(src, /rateLimit\('ai-chat'/);
});

test('wiring: meetings bound title/description/password lengths', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'meetings.ts'), 'utf8');
    assert.match(src, /MEETING_TITLE_MAX_LENGTH/);
    assert.match(src, /MEETING_DESCRIPTION_MAX_LENGTH/);
});
