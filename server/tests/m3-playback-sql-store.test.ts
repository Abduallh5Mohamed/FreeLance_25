/**
 * Hermetic tests for the SQL-backed playback session/device and progress stores
 * (F4). No database is contacted: a scripted adapter answers each statement and
 * records the exact SQL the production adapter would emit, so the atomic
 * acquisition critical section (`FOR UPDATE` inside a transaction) and the
 * deny-by-default device ceiling are asserted at the statement boundary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createSqlPlaybackSessionStore,
    PlaybackDeviceLimitError,
    PLAYBACK_POLICY_CEILINGS,
    type PlaybackStoreDb,
} from '../src/services/playback-session-registry';
import { createSqlPlaybackProgressService } from '../src/services/playback-progress';

interface Statement {
    sql: string;
    params: unknown[];
}

interface ScriptedDb {
    db: PlaybackStoreDb;
    statements: Statement[];
    transactions: number;
}

interface ScriptRow {
    rows?: unknown[];
    affectedRows?: number;
}

type Responder = (sql: string, params: unknown[]) => ScriptRow;

function makeScriptedDb(responder: Responder): ScriptedDb {
    const statements: Statement[] = [];
    const state = { transactions: 0 };
    const db: PlaybackStoreDb = {
        query: async <T = unknown>(sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            return (responder(sql, params).rows ?? []) as T[];
        },
        queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            const rows = responder(sql, params).rows ?? [];
            return (rows[0] ?? null) as T | null;
        },
        execute: async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            const responded = responder(sql, params);
            return { affectedRows: responded.affectedRows ?? 1, insertId: 0 };
        },
        transaction: async <T>(fn: (tx: PlaybackStoreDb) => Promise<T>) => {
            state.transactions += 1;
            return fn(db);
        },
    };
    return { db, statements, get transactions() { return state.transactions; } } as ScriptedDb;
}

const sent = (db: ScriptedDb, fragment: string): Statement | undefined =>
    db.statements.find((statement) => statement.sql.includes(fragment));

const DEVICE_ROW = {
    id: 'dev-1',
    tenant_id: 't1',
    user_id: 'u1',
    device_fingerprint: 'fp1',
    device_label: null,
    status: 'active',
    first_seen_at: '2026-01-01 00:00:00',
    last_seen_at: '2026-01-01 00:00:00',
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
};

const SLOT_ROW = {
    id: 'slot-1',
    tenant_id: 't1',
    user_id: 'u1',
    device_id: 'dev-1',
    session_id: 's1',
    status: 'active',
    started_at: '2026-01-01 00:00:00',
    last_heartbeat_at: '2026-01-01 00:00:00',
    ended_at: null,
    ended_reason: null,
};

const policyRow = (overrides: Record<string, unknown> = {}) => ({
    max_concurrent_sessions: 2,
    max_devices: 3,
    warning_threshold: 1,
    self_revoke_allowed: 1,
    support_revoke_allowed: 1,
    ...overrides,
});

/* ---------- policy ---------- */

test('sql store: tenant policy is read from the DB and clamped (F1)', async () => {
    const scripted = makeScriptedDb((sql) =>
        sql.includes('FROM playback_tenant_policies')
            ? { rows: [policyRow({ max_concurrent_sessions: 1000, max_devices: 1000, warning_threshold: 999 })] }
            : { rows: [] },
    );
    const store = createSqlPlaybackSessionStore(scripted.db, { now: () => new Date('2026-01-01T00:00:00Z') });
    const policy = await store.getPolicy('t1');
    assert.equal(policy.tenantId, 't1');
    assert.equal(policy.maxConcurrentSessions, PLAYBACK_POLICY_CEILINGS.maxConcurrentSessions);
    assert.equal(policy.maxDevices, PLAYBACK_POLICY_CEILINGS.maxDevices);
    assert.ok(policy.maxConcurrentSessions < 1000);
});

test('sql store: missing tenant policy falls back to secure defaults', async () => {
    const scripted = makeScriptedDb(() => ({ rows: [] }));
    const store = createSqlPlaybackSessionStore(scripted.db);
    const policy = await store.getPolicy('t1');
    assert.equal(policy.maxConcurrentSessions, 2);
    assert.equal(policy.maxDevices, 3);
    assert.equal(policy.tenantId, 't1');
});

/* ---------- device registration (F10) ---------- */

test('sql store: registerDevice creates a row inside a transaction', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('FROM playback_tenant_policies')) return { rows: [policyRow()] };
        if (sql.includes('FROM playback_devices') && sql.includes('FOR UPDATE')) return { rows: [] };
        if (sql.includes('INTO playback_devices')) return { affectedRows: 1 };
        if (sql.includes('FROM playback_devices') && sql.includes('device_fingerprint')) return { rows: [DEVICE_ROW] };
        return { rows: [] };
    });
    const store = createSqlPlaybackSessionStore(scripted.db, { now: () => new Date('2026-01-01T00:00:00Z') });
    const device = await store.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp1' });
    assert.equal(device.id, 'dev-1');
    assert.equal(device.status, 'active');
    assert.equal(device.firstSeenAt, '2026-01-01T00:00:00.000Z');
    assert.equal(scripted.transactions, 1, 'registration must serialize under a transaction');
    assert.ok(sent(scripted, 'FOR UPDATE'), 'registration must lock the user device rows');
    assert.ok(sent(scripted, 'INTO playback_devices'), 'a new device row is inserted');
});

test('sql store: registerDevice rejects a new device past maxDevices (F10)', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('FROM playback_tenant_policies')) return { rows: [policyRow({ max_devices: 1 })] };
        if (sql.includes('FROM playback_devices') && sql.includes('FOR UPDATE')) {
            return { rows: [{ ...DEVICE_ROW, device_fingerprint: 'existing' }] };
        }
        return { rows: [] };
    });
    const store = createSqlPlaybackSessionStore(scripted.db);
    await assert.rejects(
        () => store.registerDevice({ tenantId: 't1', userId: 'u1', fingerprint: 'fp-new' }),
        (error: unknown) => error instanceof PlaybackDeviceLimitError,
    );
    assert.equal(sent(scripted, 'INTO playback_devices'), undefined, 'no row may be inserted past the ceiling');
});

/* ---------- slot acquisition (race-safe) ---------- */

test('sql store: acquireSlot locks, counts and inserts in one transaction', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('SELECT id FROM playback_devices') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'dev-1' }] };
        if (sql.includes('FROM playback_devices WHERE id =')) return { rows: [DEVICE_ROW] };
        if (sql.includes('FROM playback_session_slots WHERE session_id =')) {
            // duplicate check runs before the insert; the post-insert read must see the row
            return sent(scripted, 'INTO playback_session_slots') ? { rows: [SLOT_ROW] } : { rows: [] };
        }
        if (sql.includes('FROM playback_tenant_policies')) return { rows: [policyRow()] };
        if (sql.includes('COUNT(*) AS c FROM playback_devices')) return { rows: [{ c: 1 }] };
        if (sql.includes('COUNT(*) AS c FROM playback_session_slots')) return { rows: [{ c: 0 }] };
        if (sql.includes('INTO playback_session_slots')) return { affectedRows: 1 };
        return { rows: [] };
    });
    const store = createSqlPlaybackSessionStore(scripted.db, { now: () => new Date('2026-01-01T00:00:00Z') });
    const result = await store.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: 'dev-1', sessionId: 's1' });
    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.slot?.sessionId, 's1');
    assert.equal(scripted.transactions, 1, 'acquisition must run inside a transaction');
    assert.ok(sent(scripted, 'FOR UPDATE'), 'acquisition must take a locking read');
    assert.ok(sent(scripted, 'INTO playback_session_slots'), 'the slot insert must be emitted');
});

test('sql store: acquireSlot denies past maxConcurrentSessions without inserting', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('SELECT id FROM playback_devices') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'dev-1' }] };
        if (sql.includes('FROM playback_devices WHERE id =')) return { rows: [DEVICE_ROW] };
        if (sql.includes('FROM playback_session_slots WHERE session_id =')) return { rows: [] };
        if (sql.includes('FROM playback_tenant_policies')) return { rows: [policyRow({ max_concurrent_sessions: 2 })] };
        if (sql.includes('COUNT(*) AS c FROM playback_devices')) return { rows: [{ c: 1 }] };
        if (sql.includes('COUNT(*) AS c FROM playback_session_slots')) return { rows: [{ c: 2 }] };
        return { rows: [] };
    });
    const store = createSqlPlaybackSessionStore(scripted.db);
    const result = await store.acquireSlot({ tenantId: 't1', userId: 'u1', deviceId: 'dev-1', sessionId: 's9' });
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'concurrency_limit');
    assert.equal(sent(scripted, 'INTO playback_session_slots'), undefined, 'no oversubscribing insert');
});

test('sql store: listDevices and listSessions are tenant-scoped', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('FROM playback_devices')) return { rows: [DEVICE_ROW] };
        if (sql.includes('FROM playback_session_slots')) return { rows: [SLOT_ROW] };
        return { rows: [] };
    });
    const store = createSqlPlaybackSessionStore(scripted.db);
    const devices = await store.listDevices('t1', 'u1');
    const sessions = await store.listSessions('t1', 'u1', 'active');
    assert.equal(devices.length, 1);
    assert.equal(sessions.length, 1);
    const deviceQuery = sent(scripted, 'FROM playback_devices')!;
    assert.deepEqual(deviceQuery.params, ['t1', 'u1']);
    const sessionQuery = sent(scripted, 'FROM playback_session_slots')!;
    assert.deepEqual(sessionQuery.params, ['t1', 'u1', 'active']);
});

/* ---------- progress (F4) ---------- */

const progressRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'prog-1',
    tenant_id: 't1',
    student_enrollment_id: 'e1',
    asset_id: 'a1',
    device_id: 'dev-1',
    session_id: null,
    position_seconds: 10,
    duration_seconds: 100,
    completed: 0,
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
});

test('sql store: recordProgress upserts and rejects non-monotonic writes', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('tenant_id <>')) return { rows: [] };
        if (sql.includes('student_enrollment_id <>')) return { rows: [] };
        if (sql.includes('FROM playback_progress')) return { rows: [progressRow()] };
        if (sql.includes('INTO playback_progress')) return { affectedRows: 1 };
        return { rows: [] };
    });
    const progress = createSqlPlaybackProgressService(scripted.db, {
        now: () => new Date('2026-01-01T00:00:05Z'),
        minProgressIntervalMs: 0,
    });
    const backward = await progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 5, durationSeconds: 100, deviceId: 'dev-1' });
    assert.equal(backward.accepted, false);
    assert.equal(backward.reason, 'not_monotonic');
    assert.equal(sent(scripted, 'INTO playback_progress'), undefined, 'a backward write must not touch the row');
});

test('sql store: recordProgress writes a fresh high-water mark', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('tenant_id <>')) return { rows: [] };
        if (sql.includes('student_enrollment_id <>')) return { rows: [] };
        if (sql.includes('FROM playback_progress')) return { rows: [] };
        if (sql.includes('INTO playback_progress')) return { affectedRows: 1 };
        return { rows: [] };
    });
    const progress = createSqlPlaybackProgressService(scripted.db, { minProgressIntervalMs: 0 });
    const result = await progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 42, durationSeconds: 100, deviceId: 'dev-1' });
    assert.equal(result.accepted, true);
    assert.equal(result.position, 42);
    const upsert = sent(scripted, 'INTO playback_progress')!;
    assert.ok(upsert.sql.includes('GREATEST(position_seconds'), 'the upsert must preserve monotonicity in SQL');
});

test('sql store: recordProgress denies a revoked device', async () => {
    const scripted = makeScriptedDb((sql) => {
        if (sql.includes('FROM playback_devices WHERE id =')) return { rows: [{ status: 'revoked' }] };
        return { rows: [] };
    });
    const progress = createSqlPlaybackProgressService(scripted.db, { minProgressIntervalMs: 0 });
    const result = await progress.recordProgress({ tenantId: 't1', studentEnrollmentId: 'e1', assetId: 'a1', positionSeconds: 10, durationSeconds: 100, deviceId: 'dev-1' });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'device_not_permitted');
});

test('sql store: recordHeartbeat is rate-limited and unknown sessions are denied', async () => {
    const fresh = makeScriptedDb((sql) =>
        sql.includes('last_heartbeat_at FROM playback_session_slots')
            ? { rows: [{ status: 'active', last_heartbeat_at: '2026-01-01 00:00:00' }] }
            : { rows: [] },
    );
    const progress = createSqlPlaybackProgressService(fresh.db, {
        now: () => new Date('2026-01-01T00:00:00Z'),
        minHeartbeatIntervalMs: 2000,
    });
    const limited = await progress.recordHeartbeat({ sessionId: 's1' });
    assert.equal(limited.accepted, false);
    assert.equal(limited.reason, 'rate_limited');

    const missing = makeScriptedDb(() => ({ rows: [] }));
    const progress2 = createSqlPlaybackProgressService(missing.db);
    const unknown = await progress2.recordHeartbeat({ sessionId: 'nope' });
    assert.equal(unknown.accepted, false);
    assert.equal(unknown.reason, 'unknown_session');
});
