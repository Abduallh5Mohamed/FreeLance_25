/**
 * W10-R1 — live session core suite.
 *
 * The suite drives the REAL service over the REAL in-memory adapter. It proves
 * the four properties the delivery claims:
 *
 *  1. the state machine refuses to re-open an ended session;
 *  2. a join ticket is bound to one tenant+session+user+role and expires;
 *  3. a callback is only applied after its signature verifies, only to its own
 *     tenant, only once, and only inside the grace window;
 *  4. attendance merges overlapping presence instead of summing it;
 *  5. every mutation runs in ONE mandatory unit — a failure between the write
 *     and its audit rolls the whole unit back (no half transition, no poisoned
 *     replay marker), concurrent joins cannot exceed capacity, and a callback
 *     that cannot resolve a session never chooses the audit partition.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_JOIN_TICKET_TTL_SECONDS,
    LIVE_TICKET_SECRET_MIN_BYTES,
    createInMemoryLiveSessionStore,
    createLiveSessionCore,
    deriveAttendance,
    evaluateSessionTransition,
    mergeIntervals,
    signJoinTicket,
    verifyJoinTicket,
    type InMemoryLiveSessionStore,
    type LiveSessionCore,
    type LiveSessionStore,
    type LiveSessionUnit,
    type ProviderCallbackInput,
} from '../src/services/live-session-core';

const SECRET = 'x'.repeat(LIVE_TICKET_SECRET_MIN_BYTES);
const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const HOST = 'user-host';
const STUDENT = 'user-student';

interface Harness {
    store: InMemoryLiveSessionStore;
    core: LiveSessionCore;
    clock: { nowMs: number };
    setVerified(value: boolean): void;
}

function harness(options: {
    secret?: string | undefined;
    verified?: boolean;
    graceSeconds?: number;
    /** Observes / fails the REAL staged unit without changing the adapter. */
    wrap?: (unit: LiveSessionUnit) => LiveSessionUnit;
} = {}): Harness {
    const store = createInMemoryLiveSessionStore();
    const clock = { nowMs: 1_000_000 };
    let verified = options.verified ?? true;
    let counter = 0;
    const wrap = options.wrap;
    const storeForCore: LiveSessionStore = wrap
        ? {
            ...store,
            withTransaction: <T>(work: (unit: LiveSessionUnit) => Promise<T>): Promise<T> =>
                store.withTransaction((unit) => work(wrap(unit))),
        }
        : store;
    const core = createLiveSessionCore({
        store: storeForCore,
        verifyCallbackSignature: () => verified,
        ticketSecret: 'secret' in options ? options.secret : SECRET,
        now: () => clock.nowMs,
        idFactory: () => `id-${++counter}`,
        callbackGraceSeconds: options.graceSeconds ?? 300,
    });
    return {
        store,
        core,
        clock,
        setVerified: (value) => { verified = value; },
    };
}

const createLiveSession = async (h: Harness, tenantId = TENANT): Promise<string> => {
    const created = await h.core.createSession({
        tenantId,
        hostUserId: HOST,
        title: 'Algebra live',
        provider: 'acme',
        providerRoomId: 'room-1',
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('session was not created');
    return created.id;
};

const callback = (overrides: Partial<ProviderCallbackInput> = {}): ProviderCallbackInput => ({
    provider: 'acme',
    eventId: 'evt-1',
    signature: 'sig',
    providerRoomId: 'room-1',
    kind: 'session.started',
    occurredAtMs: 1_000_000,
    ...overrides,
});

test('the state machine allows only forward moves and treats a repeat as idempotent', () => {
    assert.deepEqual(evaluateSessionTransition('scheduled', 'live'), { allowed: true, idempotent: false });
    assert.deepEqual(evaluateSessionTransition('live', 'ended'), { allowed: true, idempotent: false });
    assert.deepEqual(evaluateSessionTransition('ended', 'ended'), { allowed: true, idempotent: true });
    assert.deepEqual(evaluateSessionTransition('ended', 'live'), { allowed: false, reason: 'illegal-transition' });
    assert.deepEqual(evaluateSessionTransition('cancelled', 'live'), { allowed: false, reason: 'illegal-transition' });
    assert.deepEqual(evaluateSessionTransition('nope', 'live'), { allowed: false, reason: 'unknown-state' });
});

test('a join ticket is signed, scoped and expiring', () => {
    const claims = {
        v: 1 as const,
        tenantId: TENANT,
        sessionId: 's-1',
        userId: STUDENT,
        role: 'participant' as const,
        issuedAtMs: 1_000,
        expiresAtMs: 1_000 + 60_000,
        nonce: 'n-1',
    };
    const token = signJoinTicket(SECRET, claims);

    const ok = verifyJoinTicket(SECRET, token, 2_000, { tenantId: TENANT, sessionId: 's-1', userId: STUDENT });
    assert.equal(ok.ok, true);

    assert.deepEqual(
        verifyJoinTicket(SECRET, token, 2_000, { tenantId: OTHER_TENANT }),
        { ok: false, reason: 'wrong-scope' },
    );
    assert.deepEqual(verifyJoinTicket(SECRET, token, 61_000), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyJoinTicket(SECRET, token, 10), { ok: false, reason: 'not-yet-valid' });
    assert.deepEqual(verifyJoinTicket('y'.repeat(32), token, 2_000), { ok: false, reason: 'bad-signature' });

    const [version, payload, signature] = token.split('.');
    const tampered = `${version}.${payload}.${signature.slice(0, -2)}xx`;
    assert.deepEqual(verifyJoinTicket(SECRET, tampered, 2_000), { ok: false, reason: 'bad-signature' });
    assert.deepEqual(verifyJoinTicket(SECRET, 'not-a-ticket', 2_000), { ok: false, reason: 'malformed' });
});

test('a short or missing signing secret refuses to create or join instead of issuing an unsigned ticket', async () => {
    const missing = harness({ secret: undefined });
    const created = await missing.core.createSession({ tenantId: TENANT, hostUserId: HOST, title: 'x' });
    assert.deepEqual(created, { ok: false, reason: 'signing-unconfigured' });

    const short = harness({ secret: 'too-short' });
    assert.deepEqual(
        await short.core.createSession({ tenantId: TENANT, hostUserId: HOST, title: 'x' }),
        { ok: false, reason: 'signing-unconfigured' },
    );
});

test('join is tenant-scoped, live-only and host-derived', async () => {
    const h = harness();
    const sessionId = await createLiveSession(h);

    // Not live yet.
    assert.deepEqual(
        await h.core.join({ tenantId: TENANT, sessionId, userId: STUDENT }),
        { ok: false, reason: 'session-not-live' },
    );

    // A session of another tenant is reported as missing, not as forbidden.
    assert.deepEqual(
        await h.core.join({ tenantId: OTHER_TENANT, sessionId, userId: STUDENT }),
        { ok: false, reason: 'session-not-found' },
    );

    assert.deepEqual(await h.core.startSession(TENANT, sessionId, HOST), { ok: true, state: 'live' });
    // A non-host can never drive the lifecycle.
    assert.deepEqual(
        await h.core.endSession(TENANT, sessionId, STUDENT),
        { ok: false, reason: 'forbidden', from: 'live' },
    );

    const joined = await h.core.join({ tenantId: TENANT, sessionId, userId: STUDENT, role: 'participant' });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error('join failed');
    assert.equal(joined.role, 'participant');
    assert.ok(joined.expiresAtMs > h.clock.nowMs);
    assert.equal(verifyJoinTicket(SECRET, joined.ticket, h.clock.nowMs, { tenantId: TENANT }).ok, true);

    // The recorded host joins as host regardless of the requested role.
    const hostJoin = await h.core.join({ tenantId: TENANT, sessionId, userId: HOST, role: 'participant' });
    assert.equal(hostJoin.ok, true);
    if (!hostJoin.ok) throw new Error('host join failed');
    assert.equal(hostJoin.role, 'host');

    // A ticket bound to another user is refused.
    const stolen = await h.core.join({
        tenantId: TENANT,
        sessionId,
        userId: 'user-other',
        ticket: joined.ticket,
    });
    assert.deepEqual(stolen, { ok: false, reason: 'ticket-invalid', detail: 'wrong-scope' });
});

test('a full session refuses a new participant but lets an existing one back in', async () => {
    const h = harness();
    const created = await h.core.createSession({
        tenantId: TENANT,
        hostUserId: HOST,
        title: 'Small room',
        maxParticipants: 1,
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('session was not created');
    await h.core.startSession(TENANT, created.id, HOST);

    const first = await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: STUDENT });
    assert.equal(first.ok, true);
    assert.deepEqual(
        await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: 'user-2' }),
        { ok: false, reason: 'session-full' },
    );

    // Leaving frees the slot; the same participant may rejoin.
    assert.deepEqual(await h.core.leave({ tenantId: TENANT, sessionId: created.id, userId: STUDENT }), { ok: true, left: true });
    assert.deepEqual(await h.core.leave({ tenantId: TENANT, sessionId: created.id, userId: STUDENT }), { ok: true, left: false });
    const rejoin = await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: STUDENT });
    assert.equal(rejoin.ok, true);
});

test('callbacks are applied only after signature verification', async () => {
    const h = harness({ verified: false });
    const sessionId = await createLiveSession(h);

    assert.deepEqual(
        await h.core.applyProviderCallback(callback()),
        { status: 'ignored', reason: 'unverified-signature' },
    );
    const session = await h.core.getSession(TENANT, sessionId);
    assert.equal(session?.state, 'scheduled', 'an unverified callback never moves the session');

    h.setVerified(true);
    const applied = await h.core.applyProviderCallback(callback());
    assert.deepEqual(applied, { status: 'applied', kind: 'session.started', state: 'live' });
    assert.equal((await h.core.getSession(TENANT, sessionId))?.state, 'live');
});

test('a callback is deduplicated, tenant-checked and grace-bounded', async () => {
    const h = harness({ graceSeconds: 60 });
    const sessionId = await createLiveSession(h);

    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ tenantId: OTHER_TENANT })),
        { status: 'rejected', reason: 'cross-tenant' },
    );

    assert.equal((await h.core.applyProviderCallback(callback())).status, 'applied');
    // Same provider event id again: absorbed, never applied twice.
    assert.deepEqual(await h.core.applyProviderCallback(callback()), { status: 'duplicate' });

    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ eventId: 'evt-2', kind: 'session.ended' })),
        { status: 'applied', kind: 'session.ended', state: 'ended' },
    );
    const ended = await h.core.getSession(TENANT, sessionId);
    assert.equal(ended?.state, 'ended');
    assert.equal(ended?.endedAtMs, 1_000_000);

    // A late event outside the grace window is ignored, not silently dropped.
    assert.deepEqual(
        await h.core.applyProviderCallback(callback({
            eventId: 'evt-3',
            kind: 'participant.left',
            providerParticipantId: STUDENT,
            occurredAtMs: 1_000_000 + 61_000,
        })),
        { status: 'ignored', reason: 'outside-grace' },
    );
    // An unknown room is ignored rather than creating a session.
    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ eventId: 'evt-4', providerRoomId: 'room-x' })),
        { status: 'ignored', reason: 'unknown-session' },
    );
});

test('a participant callback only moves a participant we already hold', async () => {
    const h = harness();
    const sessionId = await createLiveSession(h);
    await h.core.startSession(TENANT, sessionId, HOST);
    await h.core.join({ tenantId: TENANT, sessionId, userId: STUDENT });

    assert.deepEqual(
        await h.core.applyProviderCallback(callback({
            eventId: 'evt-p1',
            kind: 'participant.left',
            providerParticipantId: 'never-joined',
        })),
        { status: 'ignored', reason: 'unknown-participant' },
    );

    assert.deepEqual(
        await h.core.applyProviderCallback(callback({
            eventId: 'evt-p2',
            kind: 'participant.left',
            providerParticipantId: STUDENT,
            occurredAtMs: 1_000_000 + 5_000,
        })),
        { status: 'applied', kind: 'participant.left', state: 'live' },
    );
    const participants = h.store.participants.filter((row) => row.sessionId === sessionId);
    assert.equal(participants.length, 1);
    assert.equal(participants[0].leftAtMs, 1_000_000 + 5_000);
});

test('attendance merges overlapping presence instead of summing it', () => {
    const merged = mergeIntervals([
        { startMs: 0, endMs: 10_000 },
        { startMs: 5_000, endMs: 20_000 },
        { startMs: 30_000, endMs: 40_000 },
    ]);
    assert.deepEqual(merged, [
        { startMs: 0, endMs: 20_000 },
        { startMs: 30_000, endMs: 40_000 },
    ]);

    const report = deriveAttendance({
        sessionId: 's-1',
        windowStartMs: 0,
        windowEndMs: 60_000,
        countOpenPresence: false,
        participants: [
            {
                id: 'p-1', tenantId: TENANT, sessionId: 's-1', userId: 'u-1', role: 'participant',
                ticketFingerprint: 'f', joinedAtMs: 0, lastSeenAtMs: 0, leftAtMs: 20_000,
            },
            {
                // Clock anomaly: left before joining. It contributes nothing.
                id: 'p-2', tenantId: TENANT, sessionId: 's-1', userId: 'u-2', role: 'participant',
                ticketFingerprint: 'f', joinedAtMs: 10_000, lastSeenAtMs: 10_000, leftAtMs: 5_000,
            },
            {
                // Still inside, but open presence is not counted in this mode.
                id: 'p-3', tenantId: TENANT, sessionId: 's-1', userId: 'u-3', role: 'host',
                ticketFingerprint: 'f', joinedAtMs: 0, lastSeenAtMs: 0, leftAtMs: null,
            },
        ],
    });

    assert.equal(report.anomalies, 1);
    assert.equal(report.totalCoveredSeconds, 20);
    const byUser = new Map(report.participants.map((entry) => [entry.userId, entry]));
    assert.equal(byUser.get('u-1')?.coveredSeconds, 20);
    assert.equal(byUser.get('u-2')?.coveredSeconds, 0);
    assert.equal(byUser.get('u-2')?.anomaly, true);
    assert.equal(byUser.get('u-3')?.coveredSeconds, 0);

    const open = deriveAttendance({
        sessionId: 's-1',
        windowStartMs: 0,
        windowEndMs: 60_000,
        countOpenPresence: true,
        participants: [{
            id: 'p-3', tenantId: TENANT, sessionId: 's-1', userId: 'u-3', role: 'host',
            ticketFingerprint: 'f', joinedAtMs: 0, lastSeenAtMs: 0, leftAtMs: null,
        }],
    });
    assert.equal(open.totalCoveredSeconds, 60);
});

test('attendance is host data and is clamped to the session window', async () => {
    const h = harness();
    const sessionId = await createLiveSession(h);
    await h.core.startSession(TENANT, sessionId, HOST);
    const joined = await h.core.join({ tenantId: TENANT, sessionId, userId: STUDENT });
    assert.equal(joined.ok, true);

    h.clock.nowMs += 30_000;
    await h.core.leave({ tenantId: TENANT, sessionId, userId: STUDENT });
    await h.core.endSession(TENANT, sessionId, HOST);

    const report = await h.core.attendance(TENANT, sessionId, { countOpenPresence: false });
    assert.ok(report);
    assert.equal(report?.totalCoveredSeconds, 30);
    // Another tenant sees nothing, not even a report shape.
    assert.equal(await h.core.attendance(OTHER_TENANT, sessionId), null);
});

test('ticket TTL is bounded and never exceeds the configured window', async () => {
    const h = harness();
    const sessionId = await createLiveSession(h);
    await h.core.startSession(TENANT, sessionId, HOST);
    const joined = await h.core.join({ tenantId: TENANT, sessionId, userId: STUDENT });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error('join failed');
    assert.equal(joined.expiresAtMs, h.clock.nowMs + DEFAULT_JOIN_TICKET_TTL_SECONDS * 1000);
});

/* =========================================================================
 * Atomicity (acceptance 1)
 * ========================================================================= */

/** Fails the NEXT `recordAudit` inside the real staged unit, i.e. after the
 * state write and before the audit — exactly the half-transition window. */
const failNextAudit = (state: { armed: boolean }): ((unit: LiveSessionUnit) => LiveSessionUnit) =>
    (unit) => ({
        ...unit,
        recordAudit: async (input) => {
            if (state.armed) {
                state.armed = false;
                throw new Error('audit store unavailable');
            }
            return unit.recordAudit(input);
        },
    });

test('a failure between the state write and the audit rolls the whole unit back', async () => {
    const fault = { armed: false };
    const h = harness({ wrap: failNextAudit(fault) });
    const sessionId = await createLiveSession(h);
    assert.equal(h.store.audits.length, 1, 'creation committed its own audit');

    fault.armed = true;
    await assert.rejects(
        () => h.core.startSession(TENANT, sessionId, HOST),
        /audit store unavailable/,
    );
    // Nothing committed: no state move, no audit row.
    assert.equal((await h.core.getSession(TENANT, sessionId))?.state, 'scheduled');
    assert.equal(h.store.audits.length, 1);

    // A later attempt still finishes the work, because the unit left no trace.
    assert.deepEqual(await h.core.startSession(TENANT, sessionId, HOST), { ok: true, state: 'live' });
    assert.equal((await h.core.getSession(TENANT, sessionId))?.state, 'live');
    assert.equal(h.store.audits.length, 2);
});

test('a callback that fails after the marker claim leaves no marker and a replay applies it', async () => {
    const fault = { armed: false };
    const h = harness({ wrap: failNextAudit(fault) });
    const sessionId = await createLiveSession(h);
    const auditsBefore = h.store.audits.length;

    fault.armed = true;
    await assert.rejects(
        () => h.core.applyProviderCallback(callback()),
        /audit store unavailable/,
    );
    // The poisoned-marker bug: the claim must NOT survive the failure.
    assert.equal(h.store.callbacks.length, 0, 'no marker survives a rolled-back unit');
    assert.equal(h.store.audits.length, auditsBefore);
    assert.equal((await h.core.getSession(TENANT, sessionId))?.state, 'scheduled');

    // The replay is not answered `duplicate`; it finishes the work.
    assert.deepEqual(
        await h.core.applyProviderCallback(callback()),
        { status: 'applied', kind: 'session.started', state: 'live' },
    );
    assert.equal((await h.core.getSession(TENANT, sessionId))?.state, 'live');
    assert.equal(h.store.callbacks.length, 1);
    assert.equal(h.store.callbacks[0].outcome, 'applied', 'a committed marker is terminal, never pending');
    assert.equal(h.store.audits.length, auditsBefore + 1);
});

test('a store without a unit is refused with transaction-required and writes nothing', async () => {
    const store = createInMemoryLiveSessionStore();
    const { withTransaction: _omitted, ...unitOnly } = store;
    const core = createLiveSessionCore({
        store: unitOnly,
        verifyCallbackSignature: () => true,
        ticketSecret: SECRET,
        now: () => 1_000_000,
        idFactory: () => 'id-1',
    });

    assert.deepEqual(
        await core.createSession({ tenantId: TENANT, hostUserId: HOST, title: 'x' }),
        { ok: false, reason: 'transaction-required' },
    );
    assert.deepEqual(await core.startSession(TENANT, 's-1', HOST), { ok: false, reason: 'transaction-required' });
    assert.deepEqual(
        await core.join({ tenantId: TENANT, sessionId: 's-1', userId: STUDENT }),
        { ok: false, reason: 'transaction-required' },
    );
    assert.deepEqual(
        await core.leave({ tenantId: TENANT, sessionId: 's-1', userId: STUDENT }),
        { ok: false, left: false, reason: 'transaction-required' },
    );
    assert.deepEqual(
        await core.applyProviderCallback(callback()),
        { status: 'rejected', reason: 'transaction-required' },
    );
    assert.equal(store.sessions.length, 0);
    assert.equal(store.participants.length, 0);
    assert.equal(store.callbacks.length, 0);
    assert.equal(store.audits.length, 0, 'no autocommit fallback wrote an audit');
});

/* =========================================================================
 * Capacity (acceptance 2)
 * ========================================================================= */

test('concurrent joins cannot exceed capacity', async () => {
    const h = harness();
    const created = await h.core.createSession({
        tenantId: TENANT,
        hostUserId: HOST,
        title: 'One seat',
        maxParticipants: 1,
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('session was not created');
    await h.core.startSession(TENANT, created.id, HOST);

    // Both joins are issued before either completes.
    const [left, right] = await Promise.all([
        h.core.join({ tenantId: TENANT, sessionId: created.id, userId: 'user-1' }),
        h.core.join({ tenantId: TENANT, sessionId: created.id, userId: 'user-2' }),
    ]);

    const admitted = [left, right].filter((result) => result.ok);
    assert.equal(admitted.length, 1, 'exactly one of two racing joins is admitted');
    const denied = [left, right].find((result) => !result.ok);
    assert.deepEqual(denied, { ok: false, reason: 'session-full' });

    const active = h.store.participants.filter(
        (row) => row.sessionId === created.id && row.leftAtMs === null,
    );
    assert.equal(active.length, 1, 'the active count never exceeds capacity');
});

test('a same-actor rejoin keeps one row and does not double count', async () => {
    const h = harness();
    const created = await h.core.createSession({
        tenantId: TENANT,
        hostUserId: HOST,
        title: 'One seat',
        maxParticipants: 1,
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('session was not created');
    await h.core.startSession(TENANT, created.id, HOST);

    const first = await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: STUDENT });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error('join failed');
    const firstJoinedAtMs = h.store.participants[0].joinedAtMs;

    h.clock.nowMs += 5_000;
    const again = await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: STUDENT });
    assert.equal(again.ok, true);
    if (!again.ok) throw new Error('rejoin failed');
    assert.equal(again.participantId, first.participantId, 'the same row is reused');
    assert.equal(h.store.participants.length, 1, 'a rejoin never inserts a second row');
    assert.equal(h.store.participants[0].joinedAtMs, firstJoinedAtMs, 'an active row keeps its interval');

    // The rejoin consumed no second seat: a distinct actor is still refused.
    assert.deepEqual(
        await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: 'user-2' }),
        { ok: false, reason: 'session-full' },
    );

    // After leaving, a rejoin starts a NEW interval on the same row.
    assert.deepEqual(await h.core.leave({ tenantId: TENANT, sessionId: created.id, userId: STUDENT }), { ok: true, left: true });
    h.clock.nowMs += 5_000;
    const rejoin = await h.core.join({ tenantId: TENANT, sessionId: created.id, userId: STUDENT });
    assert.equal(rejoin.ok, true);
    assert.equal(h.store.participants.length, 1);
    assert.equal(h.store.participants[0].joinedAtMs, h.clock.nowMs, 'a rejoin after leave starts a new interval');
    assert.equal(h.store.participants[0].leftAtMs, null);
});

/* =========================================================================
 * Trusted tenant in the audit partition (acceptance 3)
 * ========================================================================= */

test('an unresolved callback cannot choose the audit partition', async () => {
    const h = harness({ verified: false });
    const sessionId = await createLiveSession(h);
    const base = h.store.audits.length;

    // 1. Unverified signature, attacker-chosen claim.
    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ tenantId: OTHER_TENANT })),
        { status: 'ignored', reason: 'unverified-signature' },
    );
    assert.equal(h.store.audits[base].tenantId, null, 'unverified audit is a global security event');

    // 2. Malformed envelope, same claim.
    h.setVerified(true);
    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ eventId: '', tenantId: OTHER_TENANT })),
        { status: 'ignored', reason: 'malformed' },
    );
    assert.equal(h.store.audits[base + 1].tenantId, null);

    // 3. Unknown session, same claim.
    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ providerRoomId: 'room-x', tenantId: OTHER_TENANT })),
        { status: 'ignored', reason: 'unknown-session' },
    );
    assert.equal(h.store.audits[base + 2].tenantId, null);

    // 4. Verified claim that disagrees with the trusted row: the row tenant wins.
    assert.deepEqual(
        await h.core.applyProviderCallback(callback({ tenantId: OTHER_TENANT })),
        { status: 'rejected', reason: 'cross-tenant' },
    );
    assert.equal(h.store.audits[base + 3].tenantId, TENANT);

    // No audit anywhere in this sequence was written into the attacker's tenant.
    assert.equal(h.store.audits.slice(base).filter((entry) => entry.tenantId === OTHER_TENANT).length, 0);
    // The claim is still recorded as evidence, never as a partition.
    assert.deepEqual(h.store.audits[base].newValue, { tenant_claim: OTHER_TENANT });
    assert.equal((await h.core.getSession(TENANT, sessionId))?.state, 'scheduled');
});
