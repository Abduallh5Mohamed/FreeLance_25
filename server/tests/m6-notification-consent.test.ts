/**
 * M6 P3 — purpose/channel notification consent (hermetic, no MySQL/network).
 *
 * The REAL route factory and the REAL consent service run over an in-memory
 * SQL interpreter (no database, provider or network) with injected deps and
 * clock. Covers allow + deny-by-default + re-consent + append-only history +
 * immediate STOP/unsubscribe + owner/cross-user isolation + validation +
 * storage failure for every handler.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import express, { Router } from 'express';
import type { NextFunction } from 'express';
import { AuthRequest } from '../src/middleware/auth';
import { createNotificationConsentRouter, type ConsentRouteDeps } from '../src/routes/notification-consent';
import {
    canDeliverTo,
    clampConsentHistoryLimit,
    consentAllows,
    defaultConsentFor,
    effectiveConsentMap,
    fetchConsentHistory,
    isConsentAction,
    isConsentPurpose,
    isConsentSource,
    latestConsentEvent,
    parseConsentInput,
    recordChannelStop,
    recordConsent,
    reduceConsentState,
    type ConsentEventRow,
    type NotificationDataAccess,
} from '../src/services/notification-consent';
import { invokeRoute, type CapturedResponse, type ExecutedStatement, type RouteRequest } from './helpers/m2-harness';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);

const LINK_SECRET = 'm6-notification-link-secret-with-32-bytes-0123456789';
const USER_A = '209a70f5-0000-4000-8000-000000000001';
const USER_B = '209a70f5-0000-4000-8000-000000000002';

// ---------------------------------------------------------------------------
// State + fake db
// ---------------------------------------------------------------------------

interface FakeState {
    events: ConsentEventRow[];
    seqCounter: number;
    executed: ExecutedStatement[];
    failWith: Error | null;
}

const makeState = (): FakeState => ({ events: [], seqCounter: 0, executed: [], failWith: null });

const makeFakeDb = (state: FakeState): NotificationDataAccess => {
    const record = (sql: string, params: unknown[], kind: ExecutedStatement['kind']): void => {
        state.executed.push({ sql, params, kind });
        if (state.failWith) throw state.failWith;
    };

    const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
        record(sql, params, 'query');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        if (!upper.includes('FROM NOTIFICATION_CONSENT_EVENTS')) {
            throw new Error(`fake db: unhandled SELECT: ${sql}`);
        }
        const [userId, userType] = params;
        let rows = state.events.filter((row) => row.user_id === userId && row.user_type === userType);
        if (upper.includes('PURPOSE = ?')) {
            const [, , purpose, channel] = params;
            rows = rows.filter((row) => row.purpose === purpose && row.channel === channel);
        }
        rows = [...rows].sort((a, b) => (Number(b.seq ?? 0)) - (Number(a.seq ?? 0)));
        const limitMatch = sql.match(/LIMIT (\d+)/i);
        const limit = limitMatch ? Number(limitMatch[1]) : rows.length;
        return rows.slice(0, limit) as T[];
    };

    const execute = async (sql: string, params: unknown[] = []): Promise<{ insertId?: number; affectedRows?: number }> => {
        record(sql, params, 'execute');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        if (upper.includes('INSERT INTO NOTIFICATION_CONSENT_EVENTS')) {
            const [id, tenantId, userId, userType, purpose, channel, action, source, recordedBy, recordedAt] = params;
            state.events.push({
                id: String(id),
                seq: ++state.seqCounter,
                tenant_id: tenantId === null ? null : String(tenantId),
                user_id: String(userId),
                user_type: String(userType),
                purpose: String(purpose),
                channel: String(channel),
                action: String(action),
                source: String(source),
                recorded_by: recordedBy === null ? null : String(recordedBy),
                recorded_at: recordedAt,
            });
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.startsWith('UPDATE') || upper.includes('DELETE FROM')) {
            throw new Error(`fake db: consent ledger must be append-only, saw: ${sql}`);
        }
        throw new Error(`fake db: unhandled WRITE: ${sql}`);
    };

    const queryOne = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const rows = await query<T>(sql, params);
        return (rows[0] ?? null) as T | null;
    };

    return { query, queryOne, execute };
};

interface Harness {
    router: Router;
    db: NotificationDataAccess;
    state: FakeState;
    tokenFor: (user: { id: string; role: string; tenantId?: string }) => string;
    setLinkSecret: (secret: string | undefined) => void;
}

let linkSecret: string | undefined = LINK_SECRET;

const buildHarness = (state: FakeState): Harness => {
    const db = makeFakeDb(state);
    const tokenMap = new Map<string, { id: string; role: string; tenantId?: string }>();
    const tokenFor = (user: { id: string; role: string; tenantId?: string }): string => {
        const token = `token:${user.id}:${user.role}`;
        tokenMap.set(token, user);
        return token;
    };
    const authenticate = (req: unknown, res: unknown, next: NextFunction): void => {
        const headers = (req as { headers?: Record<string, string> }).headers ?? {};
        const token = typeof headers['authorization'] === 'string' && headers['authorization'].startsWith('Bearer ')
            ? headers['authorization'].slice(7)
            : undefined;
        const user = token ? tokenMap.get(token) : undefined;
        if (!user) {
            (res as CapturedResponse).status(401).json({ error: 'Authentication required' });
            return;
        }
        (req as AuthRequest).user = { id: user.id, email: null, phone: null, role: user.role, tenantId: user.tenantId };
        next();
    };
    const router = createNotificationConsentRouter({
        db,
        authenticate,
        now: () => new Date('2026-10-18T12:00:00.000Z'),
        getLinkSecret: () => linkSecret,
    });
    return {
        router,
        db,
        state,
        tokenFor,
        setLinkSecret: (secret) => { linkSecret = secret; },
    };
};

const withHarness = <T>(seed: (state: FakeState) => void, fn: (h: Harness) => Promise<T>): Promise<T> => {
    const state = makeState();
    seed(state);
    return fn(buildHarness(state));
};

const req = (h: Harness, method: string, url: string, token?: string | null, body?: unknown, query?: Record<string, string>): Promise<CapturedResponse> =>
    invokeRoute(h.router, { method, url, token, body, query } satisfies RouteRequest);

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

test('deny-by-default: in-app allowed, every external channel denied', () => {
    assert.equal(defaultConsentFor('in_app'), true);
    assert.equal(defaultConsentFor('email'), false);
    assert.equal(defaultConsentFor('whatsapp'), false);
    assert.equal(defaultConsentFor('sms'), false);
    assert.equal(consentAllows(null, 'email'), false);
    assert.equal(consentAllows(null, 'in_app'), true);
});

test('latest event wins: a revoke overrides a grant and a grant re-opens', async () => {
    const state = makeState();
    const db = makeFakeDb(state);
    const scope = { userId: USER_A, userType: 'student' };
    await recordConsent(db, { ...scope, purpose: 'progress_report', channel: 'email', action: 'grant', source: 'account_settings', now: () => new Date('2026-10-18T12:00:01.000Z') });
    assert.equal(await canDeliverTo(db, { ...scope, purpose: 'progress_report', channel: 'email' }), true);
    await recordConsent(db, { ...scope, purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'stop_message', recordedBy: 'system', now: () => new Date('2026-10-18T12:00:02.000Z') });
    assert.equal(await canDeliverTo(db, { ...scope, purpose: 'progress_report', channel: 'email' }), false);
    await recordConsent(db, { ...scope, purpose: 'progress_report', channel: 'email', action: 'grant', source: 'account_settings', now: () => new Date('2026-10-18T12:00:03.000Z') });
    assert.equal(await canDeliverTo(db, { ...scope, purpose: 'progress_report', channel: 'email' }), true);
    const history = await fetchConsentHistory(db, { ...scope, limit: 10 });
    assert.equal(history.length, 3);
    const markers = [...history].reverse().map((row) => row.source);
    assert.deepEqual(markers, ['account_settings', 'stop_message', 'account_settings']);
    const appendOnly = state.executed.filter((e) => e.kind === 'execute');
    assert.equal(appendOnly.every((e) => e.sql.includes('INSERT INTO')), true);
    assert.equal(appendOnly.some((e) => /UPDATE|DELETE/i.test(e.sql)), false);
});

test('recordChannelStop revokes every purpose on the channel with a stop source', async () => {
    const state = makeState();
    const db = makeFakeDb(state);
    const events = await recordChannelStop(db, {
        userId: USER_A, userType: 'parent', channel: 'whatsapp', source: 'stop_message', recordedBy: 'system',
        now: () => new Date('2026-10-18T12:00:00.000Z'),
    });
    assert.equal(events.length, 5);
    assert.equal(events.every((e) => e.action === 'revoke' && e.source === 'stop_message' && e.purpose === 'progress_report' || e.action === 'revoke'), true);
    assert.equal(await canDeliverTo(db, { userId: USER_A, userType: 'parent', purpose: 'billing_reminders', channel: 'whatsapp' }), false);
});

test('strict input validation cannot be bypassed by coercion', () => {
    assert.equal(parseConsentInput(null).ok, false);
    assert.equal(parseConsentInput([]).ok, false);
    assert.equal(parseConsentInput({}).ok, false);
    assert.equal(parseConsentInput({ purpose: 'nope', channel: 'email', action: 'grant' }).ok, false);
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'push', action: 'grant' }).ok, false);
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'GRANT' }).ok, false);
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'grant', extra: 1 }).ok, false);
    // consent provenance: an owner can never self-assert system sources
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'stop_message' }).ok, false);
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'unsubscribe_link' }).ok, false);
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'unknown_source' }).ok, false);
    assert.equal(parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'revoke', note: ' ' }).ok, false);
    const good = parseConsentInput({ purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'account_settings', note: 'user preference' });
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.value, { purpose: 'progress_report', channel: 'email', action: 'revoke' });
});

test('enum guards and history-limit clamping deny silently', () => {
    assert.equal(isConsentPurpose('progress_report'), true);
    assert.equal(isConsentPurpose('progress'), false);
    assert.equal(isConsentSource('support'), true);
    assert.equal(isConsentSource('self'), false);
    assert.equal(isConsentAction('grant'), true);
    assert.equal(isConsentAction('deny'), false);
    assert.equal(clampConsentHistoryLimit(undefined), 100);
    assert.equal(clampConsentHistoryLimit('25'), 25);
    assert.equal(clampConsentHistoryLimit('99999'), 200);
    assert.equal(clampConsentHistoryLimit('0'), null);
    assert.equal(clampConsentHistoryLimit('-3'), null);
    assert.equal(clampConsentHistoryLimit('abc'), null);
});

test('reduceConsentState reduces newest-first events to effective state', () => {
    const base = (overrides: Partial<ConsentEventRow>): ConsentEventRow => ({
        id: 'x', seq: 1, tenant_id: null, user_id: USER_A, user_type: 'student',
        purpose: 'progress_report', channel: 'email', action: 'grant', source: 'account_settings',
        recorded_by: null, recorded_at: new Date(), ...overrides,
    });
    const state = reduceConsentState([
        base({ seq: 2, action: 'revoke', source: 'stop_message' }),
        base({ seq: 1, action: 'grant' }),
    ]);
    assert.equal(state['progress_report:email'], false);
    assert.equal(state['progress_report:in_app'], true);
    const empty = reduceConsentState([]);
    assert.equal(empty['progress_report:email'], false);
    assert.equal(empty['announcements:in_app'], true);
});

// ---------------------------------------------------------------------------
// Route behavior
// ---------------------------------------------------------------------------

test('owner records an opt-in, receives resolved state, and state reflects it', async () => {
    await withHarness(() => undefined, async (h) => {
        const student = h.tokenFor({ id: USER_A, role: 'student', tenantId: 'tenant-a' });
        const post = await req(h, 'POST', '/', student, { purpose: 'billing_reminders', channel: 'email', action: 'grant' });
        assert.equal(post.statusCode, 201);
        const inserted = h.state.events[0]!;
        assert.deepEqual(post.body, {
            id: inserted.id,
            purpose: 'billing_reminders',
            channel: 'email',
            action: 'grant',
            source: 'account_settings',
            recorded_at: new Date('2026-10-18T12:00:00.000Z'),
            resolved_state: 'allowed',
        });
        assert.ok(inserted.tenant_id === 'tenant-a');
        const stateRes = await req(h, 'GET', '/state', student);
        assert.equal(stateRes.statusCode, 200);
        const state = (stateRes.body as { state: Record<string, boolean> })['state'];
        assert.equal(state['billing_reminders:email'], true);
        assert.equal(state['progress_report:email'], false);
        const history = await req(h, 'GET', '/', student);
        assert.equal(history.statusCode, 200);
        assert.equal((history.body as unknown[]).length, 1);
        const inserts = h.state.executed.filter((e) => e.kind === 'execute');
        assert.equal(inserts.length, 1);
        assert.ok(inserts[0]!.params.includes(USER_A));
    });
});

test('a second user cannot read, write, or influence the first user via the route', async () => {
    await withHarness((state) => {
        state.events.push({
            id: 'e-a-1', seq: 1, tenant_id: 'tenant-a', user_id: USER_A, user_type: 'student',
            purpose: 'progress_report', channel: 'email', action: 'revoke', source: 'stop_message',
            recorded_by: 'system', recorded_at: new Date(),
        });
    }, async (h) => {
        const userB = h.tokenFor({ id: USER_B, role: 'student', tenantId: 'tenant-b' });
        const history = await req(h, 'GET', '/', userB);
        assert.deepEqual(history.body, []);
        const post = await req(h, 'POST', '/', userB, { purpose: 'progress_report', channel: 'email', action: 'grant' });
        assert.equal(post.statusCode, 201);
        const userARead = h.state.events.filter((e) => e.user_id === USER_A);
        assert.equal(userARead.length, 1);
        assert.equal(userARead[0]!['source'], 'stop_message');
        for (const stmt of h.state.executed) {
            if (stmt.kind !== 'execute') continue;
            assert.equal(String(stmt.params[2]), USER_B);
            assert.ok(!stmt.sql.includes(`user_id = '${USER_A}'`), 'a write must never target another user');
        }
    });
});

test('unauthenticated and ineligible-role callers are denied before any write', async () => {
    await withHarness(() => undefined, async (h) => {
        assert.equal((await req(h, 'GET', '/', null)).statusCode, 401);
        assert.equal((await req(h, 'GET', '/state', null)).statusCode, 401);
        assert.equal((await req(h, 'POST', '/', null, { purpose: 'progress_report', channel: 'email', action: 'grant' })).statusCode, 401);
        assert.equal((await req(h, 'POST', '/stop', null, { channel: 'email' })).statusCode, 401);
        assert.equal(h.state.executed.length, 0);
        const teacher = h.tokenFor({ id: 'teacher-1', role: 'teacher' });
        assert.equal((await req(h, 'GET', '/', teacher)).statusCode, 403);
        assert.equal((await req(h, 'POST', '/', teacher, { purpose: 'progress_report', channel: 'email', action: 'grant' })).statusCode, 403);
        assert.equal(h.state.executed.length, 0);
    });
});

test('malformed bodies are validated without writes', async () => {
    await withHarness(() => undefined, async (h) => {
        const student = h.tokenFor({ id: USER_A, role: 'student' });
        const bodies: unknown[] = [
            null, [], {}, 'str',
            { purpose: 'progress_report' },
            { purpose: 'progress_report', channel: 'email' },
            { purpose: 'progress_report', channel: 'email', action: 'grant', hacker: true },
            { purpose: 'progress_report', channel: 'email', action: 'grant', source: 'stop_message' },
            { purpose: 'progress_report', channel: 'email', action: 'grant', note: 5 },
        ];
        for (const body of bodies) {
            assert.equal((await req(h, 'POST', '/', student, body)).statusCode, 400, JSON.stringify(body));
        }
        assert.equal(h.state.executed.length, 0);
        assert.equal((await req(h, 'POST', '/stop', student, { channel: 'push' })).statusCode, 400);
        assert.equal((await req(h, 'GET', '/', student, undefined, { limit: 'x' })).statusCode, 400);
        assert.equal((await req(h, 'GET', '/', student, undefined, { limit: '0' })).statusCode, 400);
        assert.equal((await req(h, 'GET', '/', student, undefined, { limit: '25' })).statusCode, 200);
        assert.equal(h.state.executed.length, 1);
    });
});

test('STOP route revokes the whole channel immediately', async () => {
    await withHarness((state) => {
        state.events.push({
            id: 'e-a-g', seq: 1, tenant_id: null, user_id: USER_A, user_type: 'student',
            purpose: 'billing_reminders', channel: 'email', action: 'grant', source: 'account_settings',
            recorded_by: USER_A, recorded_at: new Date(),
        });
    }, async (h) => {
        const student = h.tokenFor({ id: USER_A, role: 'student' });
        const stop = await req(h, 'POST', '/stop', student, { channel: 'email', note: 'no more email' });
        assert.equal(stop.statusCode, 200);
        assert.deepEqual(stop.body, { status: 'stopped', channel: 'email', purposes: 5 });
        const scope = { userId: USER_A, userType: 'student' };
        assert.equal(await canDeliverTo(h.db, { ...scope, purpose: 'billing_reminders', channel: 'email' }), false);
        const stateRes = await req(h, 'GET', '/state', student);
        const state = (stateRes.body as { state: Record<string, boolean> })['state'];
        assert.ok(Object.entries(state).every(([key, value]) => (key.endsWith(':email') ? value === false : true)));
    });
});

test('signed unsubscribe link works logged out, appends an unsubscribe_link revoke, and rejects tampering', async () => {
    await withHarness((state) => {
        state.events.push({
            id: 'e-a-g', seq: 1, tenant_id: null, user_id: USER_A, user_type: 'student',
            purpose: 'progress_report', channel: 'email', action: 'grant', source: 'account_settings',
            recorded_by: USER_A, recorded_at: new Date(),
        });
    }, async (h) => {
        const student = h.tokenFor({ id: USER_A, role: 'student' });
        const issued = await req(h, 'POST', '/unsubscribe-link', student, { channel: 'email' });
        assert.equal(issued.statusCode, 200);
        const token = (issued.body as { token: string })['token'];
        // logged-out browser: no bearer token at all
        const unsubscribe = await req(h, 'POST', '/unsubscribe', null, { token });
        assert.equal(unsubscribe.statusCode, 200);
        assert.deepEqual(unsubscribe.body, { status: 'unsubscribed', channel: 'email', purpose: 'all' });
        const scope = { userId: USER_A, userType: 'student' };
        assert.equal(await canDeliverTo(h.db, { ...scope, purpose: 'progress_report', channel: 'email' }), false);
        const last = await latestConsentEvent(h.db, { ...scope, purpose: 'progress_report', channel: 'email' });
        assert.equal(last?.source, 'unsubscribe_link');
        const tampered = `${token.slice(0, -2)}xx`;
        assert.equal((await req(h, 'POST', '/unsubscribe', null, { token: tampered })).statusCode, 403);
        assert.equal((await req(h, 'POST', '/unsubscribe', null, {})).statusCode, 400);
        assert.equal((await req(h, 'POST', '/unsubscribe', null, 'not-an-object')).statusCode, 400);
        const before = h.state.events.length;
        assert.equal((await req(h, 'POST', '/unsubscribe', null, { token: tampered })).statusCode, 403);
        assert.equal(h.state.events.length, before);
    });
});

test('unpurpose unsubscribe payload revokes only that purpose; others stay granted', async () => {
    await withHarness(() => undefined, async (h) => {
        const student = h.tokenFor({ id: USER_A, role: 'student' });
        const issued = await req(h, 'POST', '/unsubscribe-link', student, { channel: 'email', purpose: 'progress_report' });
        const token = (issued.body as { token: string })['token'];
        assert.equal((await req(h, 'POST', '/unsubscribe', null, { token })).statusCode, 200);
        const scopedEvents = h.state.events.filter((e) => e.user_id === USER_A);
        assert.equal(scopedEvents.length, 1);
        assert.deepEqual([scopedEvents[0]!['purpose'], scopedEvents[0]!['channel'], scopedEvents[0]!['action']], ['progress_report', 'email', 'revoke']);
    });
});

test('a missing or short link secret fails closed: links unusable and unsubscribe unavailable', async () => {
    await withHarness(() => undefined, async (h) => {
        h.setLinkSecret(undefined);
        const student = h.tokenFor({ id: USER_A, role: 'student' });
        assert.equal((await req(h, 'POST', '/unsubscribe-link', student, { channel: 'email' })).statusCode, 503);
        assert.equal((await req(h, 'POST', '/unsubscribe', null, { token: 'a.b' })).statusCode, 503);
        assert.equal(h.state.executed.length, 0);
        h.setLinkSecret('short-secret');
        assert.equal((await req(h, 'POST', '/unsubscribe-link', student, { channel: 'email' })).statusCode, 503);
        assert.equal(h.state.executed.length, 0);
        h.setLinkSecret(LINK_SECRET);
    });
});

test('every consent route surfaces a storage failure as 500 without partial effects', async () => {
    await withHarness((state) => {
        state.events.push({
            id: 'e-a-1', seq: 1, tenant_id: null, user_id: USER_A, user_type: 'student',
            purpose: 'progress_report', channel: 'email', action: 'grant', source: 'account_settings',
            recorded_by: USER_A, recorded_at: new Date(),
        });
    }, async (h) => {
        const student = h.tokenFor({ id: USER_A, role: 'student' });
        h.setLinkSecret(LINK_SECRET);
        h.state.failWith = new Error('simulated db outage');
        assert.equal((await req(h, 'GET', '/', student)).statusCode, 500);
        assert.equal((await req(h, 'GET', '/state', student)).statusCode, 500);
        assert.equal((await req(h, 'POST', '/', student, { purpose: 'progress_report', channel: 'email', action: 'grant' })).statusCode, 500);
        assert.equal((await req(h, 'POST', '/stop', student, { channel: 'email' })).statusCode, 500);
        // the link secret is present here, so the signed path fails at verify time
        assert.equal((await req(h, 'POST', '/unsubscribe', null, { token: 'x.y' })).statusCode, 403);
    });
});

test('effectiveConsentMap honors the owner namespace only for eligible types', async () => {
    await withHarness((state) => {
        state.events.push({
            id: 'e-1', seq: 1, tenant_id: null, user_id: USER_A, user_type: 'parent',
            purpose: 'progress_report', channel: 'whatsapp', action: 'grant', source: 'account_settings',
            recorded_by: USER_A, recorded_at: new Date(),
        });
    }, async (h) => {
        const map = await effectiveConsentMap(h.db, USER_A, 'parent');
        assert.equal(map['progress_report:whatsapp'], true);
        assert.equal(map['progress_report:email'], false);
        assert.equal(await fetchConsentHistory(h.db, { userId: USER_A, userType: 'teacher' }).then((rows) => rows.length), 0);
    });
});
