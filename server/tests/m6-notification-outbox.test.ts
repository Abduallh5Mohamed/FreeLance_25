/**
 * M6 P4 + P5 + P7 — event outbox, delivery channels and parent reports
 * (hermetic: no MySQL, no provider, no network; adapters are injected fakes).
 *
 * Covers: idempotent enqueue, bounded-backoff retries, bounce/failed/cancelled
 * states, consent re-check at send time (STOP honored immediately), locale
 * templates with escaped variables, signed expiring links with a dedicated
 * secret (fail closed), channel gates (verified number + opt-in + approved
 * template), PII-free delivery logs/receipts, and parent-report delivery
 * restricted to configured fields over an injected verified link-checker.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    claimDueOutboxIds,
    claimDueOutboxIdsInScope,
    dispatchOutboxRow,
    enqueueOutboxRow,
    enqueueParentReportDelivery,
    LinkSecretMissingError,
    outboxBackoffSeconds,
    outboxRowRenderer,
    recoverStaleSendingRows,
    renderOutboxTemplate,
    resolveLinkSecret,
    signSecureLink,
    STALE_SENDING_MARKER,
    UNKNOWN_OUTCOME_MARKER,
    validateEnqueueInput,
    verifySecureLink,
    buildParentReportVars,
    type DispatchOptions,
    type DeliveryAdapter,
    type OutboxRow,
    type ParentLinkChecker,
} from '../src/services/notification-outbox';
import {
    contactRef,
    gateChannelSend,
    maskPhone,
    redactPiiText,
    sanitizeDeliveryLog,
    sanitizeProof,
    type ChannelSendOutcome,
} from '../src/services/delivery-channels';
import type { NotificationDataAccess } from '../src/services/notification-consent';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);

const LINK_SECRET = 'm6-outbox-link-secret-32-bytes-0123456789abcdef';
const HMAC_KEY = 'm6-outbox-log-hmac-key';
const NOW = () => new Date('2026-10-18T12:00:00.000Z');

// ---------------------------------------------------------------------------
// In-memory outbox store
// ---------------------------------------------------------------------------

/** The real row also carries the schema-managed `updated_at` claim timestamp. */
type FakeOutboxRow = OutboxRow & { updated_at: Date };

interface OutboxState {
    rows: FakeOutboxRow[];
    receipts: { outbox_id: string; outcome: string; proof: string | null; detail: string | null }[];
    executed: { sql: string; params: unknown[]; kind: 'query' | 'queryOne' | 'execute' }[];
    failWith: Error | null;
    seq: number;
    /** L4: simulate a concurrent enqueue where the INSERT loses the unique key. */
    race: { key: string; committed: boolean } | null;
    /** Simulates a lost connection/crash between the adapter result and the state write. */
    failTerminalStatus: boolean;
    /** Simulates a receipt store outage after the terminal state was persisted. */
    failReceipts: boolean;
}

const makeState = (): OutboxState => ({
    rows: [],
    receipts: [],
    executed: [],
    failWith: null,
    seq: 0,
    race: null,
    failTerminalStatus: false,
    failReceipts: false,
});

const makeDb = (state: OutboxState): NotificationDataAccess => {
    const record = (sql: string, params: unknown[], kind: 'query' | 'queryOne' | 'execute'): void => {
        state.executed.push({ sql, params, kind });
        if (state.failWith) throw state.failWith;
    };

    const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
        record(sql, params, 'query');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        const limitMatch = sql.match(/LIMIT (\d+)/i);
        const limit = limitMatch ? Number(limitMatch[1]) : 25;
        if (upper.includes('FROM NOTIFICATION_OUTBOX') && upper.includes("STATUS = 'SENDING'")) {
            const cutoff = params[0] instanceof Date ? params[0].getTime() : new Date(String(params[0])).getTime();
            return state.rows
                .filter((row) => row.status === 'sending' && row.updated_at.getTime() <= cutoff)
                .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime())
                .slice(0, limit) as T[];
        }
        if (upper.includes('FROM NOTIFICATION_OUTBOX')) {
            const nowParam = params[0] instanceof Date ? params[0].getTime() : 0;
            // B2-W9: a tenant-scoped claim binds the tenant as the second param
            // and any channel filter after it.
            const tenant = typeof params[1] === 'string' ? params[1] : null;
            const channels = params.slice(2).map((value) => String(value));
            return state.rows
                .filter((row) => row.status === 'pending' && new Date(row.next_attempt_at as string).getTime() <= nowParam)
                .filter((row) => tenant === null || row.tenant_id === tenant)
                .filter((row) => channels.length === 0 || channels.includes(row.channel))
                .sort((a, b) => String(a.next_attempt_at).localeCompare(String(b.next_attempt_at)))
                .slice(0, limit) as T[];
        }
        throw new Error(`fake db: unhandled SELECT: ${sql}`);
    };

    const queryOne = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        record(sql, params, 'queryOne');
        if (sql.toUpperCase().includes('FROM NOTIFICATION_OUTBOX WHERE IDEMPOTENCY_KEY')) {
            // L4 race: the winner is committed only after the loser's INSERT
            // fails, so the loser's pre-check must not see it yet.
            if (state.race && state.race.key === params[0] && !state.race.committed) return null;
            const row = state.rows.find((candidate) => candidate.idempotency_key === params[0]);
            return (row ?? null) as T | null;
        }
        if (sql.toUpperCase().includes('FROM NOTIFICATION_OUTBOX WHERE ID = ?')) {
            const row = state.rows.find((candidate) => candidate.id === params[0]);
            return (row ?? null) as T | null;
        }
        throw new Error(`fake db: unhandled SELECT: ${sql}`);
    };

    const execute = async (sql: string, params: unknown[] = []): Promise<{ insertId?: number; affectedRows?: number }> => {
        record(sql, params, 'execute');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();
        if (upper.includes('INSERT INTO NOTIFICATION_OUTBOX')) {
            const [id, key, tenantId, eventType, purpose, recipientId, recipientType, channel, locale, templateId, payload, maxAttempts, nextAt] = params;
            if (state.race && state.race.key === String(key) && !state.race.committed) {
                state.race.committed = true;
                const error = new Error('duplicate idempotency key') as Error & { code?: string };
                error.code = 'ER_DUP_ENTRY';
                throw error;
            }
            state.rows.push({
                id: String(id), idempotency_key: String(key), tenant_id: tenantId === null ? null : String(tenantId),
                event_type: String(eventType), purpose: String(purpose),
                recipient_user_id: String(recipientId), recipient_user_type: String(recipientType),
                channel: String(channel), locale: String(locale), template_id: templateId === null ? null : String(templateId),
                payload: String(payload), status: 'pending', attempts: 0, max_attempts: Number(maxAttempts),
                next_attempt_at: nextAt as Date, last_error: null, delivered_at: null, updated_at: NOW(),
            });
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('ATTEMPTS = ATTEMPTS + 1')) {
            const [id, notAfter] = params;
            const row = state.rows.find((candidate) => candidate.id === id);
            if (!row || row.status !== 'pending') return { affectedRows: 0, insertId: 0 };
            const notAfterMs = notAfter instanceof Date ? notAfter.getTime() : new Date(String(notAfter)).getTime();
            if (new Date(row.next_attempt_at as string).getTime() > notAfterMs) return { affectedRows: 0, insertId: 0 };
            row.status = 'sending';
            row.attempts += 1;
            row.updated_at = notAfter instanceof Date ? notAfter : new Date(String(notAfter));
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('SET LAST_ERROR = ?')) {
            const [marker, id, expected, quarantined] = params;
            const row = state.rows.find((candidate) => candidate.id === id);
            if (!row || row.status !== 'sending') return { affectedRows: 0, insertId: 0 };
            if (row.last_error === expected) return { affectedRows: 0, insertId: 0 };
            // B2-W9: an already-quarantined unknown outcome keeps its marker.
            if (quarantined !== undefined && row.last_error === quarantined) return { affectedRows: 0, insertId: 0 };
            row.last_error = String(marker);
            row.updated_at = NOW();
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE NOTIFICATION_OUTBOX SET STATUS')) {
            const [status, nextAttemptAt, lastError, sentStatus, id] = params;
            if (state.failTerminalStatus && status !== 'pending') {
                throw new Error('connection lost before the terminal state write');
            }
            const row = state.rows.find((candidate) => candidate.id === id);
            if (!row || row.status !== 'sending') return { affectedRows: 0, insertId: 0 };
            // Real column contract: next_attempt_at is TIMESTAMP(3) NOT NULL.
            if (nextAttemptAt === null && !upper.includes('NEXT_ATTEMPT_AT = COALESCE(?, NEXT_ATTEMPT_AT)')) {
                throw new Error("Column 'next_attempt_at' cannot be null");
            }
            row.status = String(status);
            if (nextAttemptAt !== null) row.next_attempt_at = nextAttemptAt as Date;
            row.last_error = lastError === null ? null : String(lastError);
            row.updated_at = NOW();
            if (sentStatus === 'sent') row.delivered_at = NOW();
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('INSERT INTO NOTIFICATION_DELIVERY_RECEIPTS')) {
            if (state.failReceipts) throw new Error('receipt store unavailable');
            const [id, outboxId, tenantId, channel, outcome, proof, detail] = params;
            state.receipts.push({
                id: String(id), outbox_id: String(outboxId), tenant_id: tenantId === null ? null : String(tenantId),
                channel: String(channel), outcome: String(outcome), proof: proof === null ? null : String(proof), detail: detail === null ? null : String(detail),
            });
            return { affectedRows: 1, insertId: 0 };
        }
        throw new Error(`fake db: unhandled WRITE: ${sql}`);
    };

    return { query, queryOne, execute };
};

const seedRow = (state: OutboxState, overrides: Partial<FakeOutboxRow> = {}): FakeOutboxRow => {
    const row: FakeOutboxRow = {
        id: `outbox-${++state.seq}`,
        idempotency_key: `key-${state.seq}`,
        tenant_id: 'tenant-a',
        event_type: 'progress_report',
        purpose: 'progress_report',
        recipient_user_id: 'parent-1',
        recipient_user_type: 'parent',
        channel: 'email',
        locale: 'ar',
        template_id: null,
        payload: JSON.stringify({
            student_name: 'Sami', period: 'Sep 2026', summary_text: 'progress ok',
            report_link: '?e=abc', unsubscribe_link: '?u=def',
        }),
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        next_attempt_at: NOW(),
        last_error: null,
        delivered_at: null,
        updated_at: NOW(),
        ...overrides,
    };
    state.rows.push(row);
    return row;
};

const makeAdapter = (channel: 'email' | 'whatsapp' | 'sms', results: ChannelSendOutcome[]): { adapter: DeliveryAdapter; calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
        calls,
        adapter: {
            channel,
            deliver: async (message) => {
                calls.push(message);
                return results.length === 1 ? results[0]! : (results.shift() ?? { outcome: 'failed', reason: 'exhausted' });
            },
        },
    };
};

const makeDispatchOptions = (consentAllowed: boolean, log?: (entry: unknown) => void): DispatchOptions => ({
    consent: { canDeliver: async () => consentAllowed },
    render: outboxRowRenderer(),
    linkSecret: LINK_SECRET,
    now: NOW,
    log,
});

// ---------------------------------------------------------------------------
// P4 — enqueue idempotency, backoff, templates
// ---------------------------------------------------------------------------

const validEnqueue = {
    idempotencyKey: 'dup-key-1',
    tenantId: 'tenant-a',
    eventType: 'progress_report',
    purpose: 'progress_report',
    recipientUserId: 'parent-1',
    recipientUserType: 'parent',
    channel: 'email',
    locale: 'ar',
    payload: { student_name: 'Sami' },
};

test('enqueue validates strictly before writing', async () => {
    assert.equal(validateEnqueueInput({ ...validEnqueue, idempotencyKey: '' }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, eventType: '' }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, purpose: '' }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, recipientUserId: '' }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, channel: 'push' }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, locale: 'fr' }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, payload: [] as never }).ok, false);
    assert.equal(validateEnqueueInput({ ...validEnqueue, maxAttempts: 99 }).ok, false);
    assert.equal(validateEnqueueInput(validEnqueue).ok, true);
});

test('enqueue is idempotent on the idempotency key', async () => {
    const state = makeState();
    const db = makeDb(state);
    const first = await enqueueOutboxRow(db, validEnqueue, { now: NOW });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.duplicate, false);
    const second = await enqueueOutboxRow(db, validEnqueue, { now: NOW });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.duplicate, true);
    assert.equal(state.rows.length, 1);
    assert.equal(state.executed.filter((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO notification_outbox')).length, 1);
    const replay = { methods: new Set(state.executed.map((e) => e.sql.match(/UPDATE|INSERT|DELETE/i)?.[0]?.toUpperCase() ?? 'SELECT')) };
    assert.ok(!replay.methods.has('UPDATE'));
    assert.ok(!replay.methods.has('DELETE'));
});

test('L4: a duplicate-key race returns the existing row instead of a 500', async () => {
    const state = makeState();
    const existing = seedRow(state, { id: 'outbox-existing', idempotency_key: 'race-key' });
    state.race = { key: 'race-key', committed: false };
    const db = makeDb(state);
    const result = await enqueueOutboxRow(db, { ...validEnqueue, idempotencyKey: 'race-key' }, { now: NOW });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.duplicate, true);
        assert.equal(result.id, existing.id);
    }
    assert.equal(state.rows.length, 1);
});

test('outbox backoff is bounded and strictly increasing', () => {
    assert.equal(outboxBackoffSeconds(1), 60);
    assert.equal(outboxBackoffSeconds(2), 300);
    assert.equal(outboxBackoffSeconds(4), 7200);
    assert.equal(outboxBackoffSeconds(5), 86400);
    assert.equal(outboxBackoffSeconds(99), 86400);
    assert.equal(outboxBackoffSeconds(0), 60);
    const spikes = [outboxBackoffSeconds(3), outboxBackoffSeconds(5), outboxBackoffSeconds(9)];
    for (const spike of spikes) assert.ok(spike <= 86400);
    assert.equal(outboxBackoffSeconds(2) > outboxBackoffSeconds(1), true);
});

test('claimDueOutboxIds bounds and orders due pending rows', async () => {
    const state = makeState();
    seedRow(state, { idempotency_key: 'k1', next_attempt_at: new Date('2026-10-18T11:00:00.000Z') });
    seedRow(state, { idempotency_key: 'k2', next_attempt_at: new Date('2026-10-18T10:00:00.000Z') });
    seedRow(state, { idempotency_key: 'k3', status: 'sent', next_attempt_at: new Date('2026-10-18T09:00:00.000Z') });
    seedRow(state, { idempotency_key: 'k4', next_attempt_at: new Date('2026-10-18T13:00:00.000Z') });
    const db = makeDb(state);
    const due = await claimDueOutboxIds(db, 1, NOW);
    assert.deepEqual(due, [state.rows[1]!.id]);
    const all = await claimDueOutboxIds(db, 10, NOW);
    assert.equal(all.length, 2);
});

// ---------------------------------------------------------------------------
// Templates: locales, escaping, strict variable handling
// ---------------------------------------------------------------------------

const templateVars = (extra: Record<string, string> = {}): Record<string, unknown> => ({
    student_name: 'Sami',
    period: 'Sep 2026',
    summary_text: 'attendance 4/5; grades B',
    report_link: '?e=abc',
    unsubscribe_link: '?u=def',
    ...extra,
});

test('locale templates render ar and en without substitution leaks', () => {
    const ar = renderOutboxTemplate('progress_report', 'ar', templateVars());
    assert.equal(ar.ok, true);
    if (ar.ok) {
        assert.equal(ar.value.bodyHtml.includes('{'), false);
        assert.equal(ar.value.subject.includes('{'), false);
        assert.ok(ar.value.bodyText.includes('Sami'));
        assert.ok(ar.value.bodyHtml.includes('href="?u=def"'));
    }
    const en = renderOutboxTemplate('progress_report', 'en', templateVars());
    assert.equal(en.ok, true);
});

test('template variables are HTML-escaped in html and neutralized in text', () => {
    const evil = renderOutboxTemplate('progress_report', 'en', templateVars({ student_name: '<script>alert(1)</script>' }));
    assert.equal(evil.ok, true);
    if (evil.ok) {
        assert.ok(evil.value.bodyHtml.includes('&lt;script&gt;'));
        assert.ok(!evil.value.bodyHtml.includes('<script>'));
        assert.ok(!evil.value.bodyText.includes('\u0000'));
    }
});

test('template rendering rejects unknown events/locales/variables', () => {
    assert.equal(renderOutboxTemplate('nope', 'ar', templateVars()).ok, false);
    assert.equal(renderOutboxTemplate('progress_report', 'fr', templateVars()).ok, false);
    assert.equal(renderOutboxTemplate('progress_report', 'ar', { ...templateVars(), hacker: 1 }).ok, false);
    assert.equal(renderOutboxTemplate('progress_report', 'ar', { student_name: 'Sami' }).ok, false);
    assert.equal(renderOutboxTemplate('progress_report', 'ar', templateVars({ student_name: { object: true } as unknown as string })).ok, false);
    assert.equal(renderOutboxTemplate('progress_report', 'ar', null as never).ok, false);
    const ar = renderOutboxTemplate('progress_report', 'ar', templateVars());
    assert.equal(ar.ok, true);
    if (ar.ok) assert.ok(ar.value.bodyHtml.includes('href="?u=def"'));
});

// ---------------------------------------------------------------------------
// Signed links: dedicated secret, expiry, tamper, fail-closed
// ---------------------------------------------------------------------------

test('resolveLinkSecret fails closed on missing or short secrets', () => {
    assert.equal(resolveLinkSecret(LINK_SECRET), LINK_SECRET);
    assert.throws(() => resolveLinkSecret(undefined), LinkSecretMissingError);
    assert.throws(() => resolveLinkSecret('short'), LinkSecretMissingError);
    assert.throws(() => resolveLinkSecret('='.repeat(31)), LinkSecretMissingError);
    assert.equal(typeof resolveLinkSecret('='.repeat(32)), 'string');
});

test('signed links verify, expire, and reject tampering', () => {
    const token = signSecureLink(
        { kind: 'unsubscribe', ref: 'r1', userId: 'p1', userType: 'parent', purpose: 'progress_report', channel: 'email' },
        LINK_SECRET,
        { ttlSeconds: 3600, now: NOW },
    );
    const ok = verifySecureLink(token, LINK_SECRET, NOW);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.payload.kind, 'unsubscribe');
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.ok(verifySecureLink(tampered, LINK_SECRET, NOW).ok === false);
    const expired = signSecureLink(
        { kind: 'report', ref: 'r2', userId: 'p1', userType: 'parent', purpose: 'progress_report', channel: 'sms' },
        LINK_SECRET,
        { ttlSeconds: 60, now: () => new Date('2026-10-18T00:00:00.000Z') },
    );
    assert.equal(verifySecureLink(expired, LINK_SECRET, NOW).ok, false);
    const badShape = verifySecureLink('etter.btv', LINK_SECRET, NOW);
    assert.equal(badShape.ok, false);
    assert.equal(badShape.ok ? null : badShape.reason, 'signature-mismatch');
});

// ---------------------------------------------------------------------------
// Dispatch: sent, retry ladder, terminal failed, bounced, STOP cancel, idempotency
// ---------------------------------------------------------------------------

test('a sent outcome writes the terminal state, a sanitized receipt and a PII-free log', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: { message_id: 'm1', phone: '+201000000123' } }]);
    const logs: unknown[] = [];
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true, (entry) => logs.push(entry)), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'sent' });
    assert.equal(state.rows[0]!.status, 'sent');
    assert.ok(state.rows[0]!.delivered_at);
    assert.equal(state.receipts.length, 1);
    const receiptProof = JSON.parse(state.receipts[0]!.proof!);
    assert.equal(receiptProof.message_id, 'm1');
    assert.ok(receiptProof.phone === undefined, 'receipt must never carry a phone');
    assert.ok(typeof receiptProof.contact_ref === 'string' && receiptProof.contact_ref.startsWith('ref:'));
    assert.equal(String(logs[0]).includes('+201000000123'), false);
    assert.equal(calls.length, 1);
    const inserts = state.executed.filter((e) => e.sql.includes('INSERT INTO notification_delivery_receipts'));
    assert.equal(inserts.length, state.receipts.length);
});

test('a failed outcome schedules the next attempt with a bounded backoff', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter } = makeAdapter('email', [{ outcome: 'failed', reason: 'provider 500 timeout 01000000123' }]);
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'retry' });
    const row = state.rows[0]!;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(new Date(row.next_attempt_at as Date).getTime(), NOW().getTime() + 60 * 1000);
    assert.equal(state.receipts.length, 1);
    assert.equal(state.receipts[0]!.outcome, 'failed');
    assert.ok(state.receipts[0]!.detail!.includes('••••••'), 'delivery detail must be digit-masked');
    const inserts = state.executed.filter((e) => e.sql.includes('INSERT INTO notification_delivery_receipts'));
    assert.equal(inserts.length, state.receipts.length);
});

test('attempt cap converts a persistent failure into the terminal failed state', async () => {
    const state = makeState();
    seedRow(state, { attempts: 2, max_attempts: 3 });
    const db = makeDb(state);
    const { adapter } = makeAdapter('email', [{ outcome: 'failed', reason: 'down' }]);
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'failed' });
    assert.equal(state.rows[0]!.status, 'failed');
});

test('a bounced outcome is terminal and recorded', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter } = makeAdapter('email', [{ outcome: 'bounced', reason: 'mailbox unknown contact 01000000123' }]);
    const logs: unknown[] = [];
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true, (e) => logs.push(e)), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'bounced' });
    assert.equal(state.rows[0]!.status, 'bounced');
    assert.equal(state.receipts[0]!.outcome, 'bounced');
    assert.equal(JSON.stringify(logs).includes('01000000123'), false);
    assert.equal(JSON.stringify(logs).includes('••••••'), true);
});

test('a consent revoke done after enqueueing is honored at send time without adapter contact', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: {} }]);
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(false), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'cancelled' });
    assert.equal(state.rows[0]!.status, 'cancelled');
    assert.equal(calls.length, 0);
    assert.equal(state.receipts[0]!.outcome, 'cancelled');
});

test('dispatch is idempotent: a non-pending row is skipped and claimed rows cannot double-send', async () => {
    const state = makeState();
    seedRow(state, { status: 'sent' });
    const alsoSending = seedRow(state, { status: 'sending' });
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: {} }]);
    assert.deepEqual(await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY), { dispatched: false, outcome: 'skipped' });
    assert.deepEqual(await dispatchOutboxRow(db, alsoSending.id, [adapter], makeDispatchOptions(true), HMAC_KEY), { dispatched: false, outcome: 'skipped' });
    assert.equal(calls.length, 0);
    assert.equal(state.receipts.length, 0);
});

test('a missing adapter retries before the attempt cap and fails at it', async () => {
    const state = makeState();
    seedRow(state, { attempts: 0, max_attempts: 2 });
    const db = makeDb(state);
    assert.deepEqual(await dispatchOutboxRow(db, state.rows[0]!.id, [], makeDispatchOptions(true), HMAC_KEY), { dispatched: true, outcome: 'retry' });
    assert.equal(state.rows[0]!.status, 'pending');
    assert.equal(state.receipts.length, 0);
    // exhaust the cap
    state.rows[0]!.status = 'pending';
    state.rows[0]!.next_attempt_at = NOW();
    assert.deepEqual(await dispatchOutboxRow(db, state.rows[0]!.id, [], makeDispatchOptions(true), HMAC_KEY), { dispatched: true, outcome: 'failed' });
    assert.equal(state.rows[0]!.status, 'failed');
});

test('a broken or throwing adapter never crashes the outbox and still logs without PII', async () => {
    const state = makeState();
    seedRow(state, { attempts: 4, max_attempts: 5 });
    const db = makeDb(state);
    const adapter: DeliveryAdapter = {
        channel: 'email',
        deliver: async () => { throw new Error('provider socket flood on +201000000123'); },
    };
    const logs: unknown[] = [];
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true, (e) => logs.push(e)), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'failed' });
    assert.equal(state.rows[0]!.status, 'failed');
    assert.equal(JSON.stringify(logs).includes('+201000000123'), false);
});

// ---------------------------------------------------------------------------
// Crash / lost-response recovery and claim races
// ---------------------------------------------------------------------------

/** Holds both dispatchers at the pre-claim read so they race the claim UPDATE. */
const gateFirstRead = (db: NotificationDataAccess): NotificationDataAccess => {
    let arrivals = 0;
    const waiting: (() => void)[] = [];
    return {
        query: db.query,
        execute: db.execute,
        queryOne: async <T>(sql: string, params?: unknown[]): Promise<T | null> => {
            const result = await db.queryOne<T>(sql, params);
            if (sql.includes('WHERE id = ?')) {
                arrivals += 1;
                if (arrivals >= 2) {
                    waiting.splice(0).forEach((release) => release());
                } else {
                    await new Promise<void>((release) => waiting.push(release));
                }
            }
            return result;
        },
    };
};

const waitUntilSending = async (state: OutboxState): Promise<void> => {
    for (let tick = 0; tick < 50 && state.rows[0]!.status !== 'sending'; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(state.rows[0]!.status, 'sending');
};

test('two dispatchers racing one row: exactly one claim wins, one send and one receipt', async () => {
    const state = makeState();
    seedRow(state);
    const db = gateFirstRead(makeDb(state));
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: { message_id: 'm1' } }]);
    const results = await Promise.all([
        dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
    ]);
    assert.deepEqual(
        results.map((result) => result.outcome).sort(),
        ['sent', 'skipped'],
    );
    assert.equal(calls.length, 1, 'the losing dispatcher must never reach the adapter');
    assert.equal(state.receipts.length, 1, 'exactly one delivery receipt for one external send');
    assert.equal(state.rows[0]!.status, 'sent');
    assert.equal(state.rows[0]!.attempts, 1);
    assert.equal(state.rows[0]!.delivered_at !== null, true);
    assert.equal(state.rows[0]!.next_attempt_at instanceof Date, true, 'NOT NULL next_attempt_at must stay populated');
});

test('a crash after the claim leaves the row in sending; recovery flags it and never resends', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: { message_id: 'm1' } }]);
    state.failTerminalStatus = true;
    await assert.rejects(
        () => dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        /connection lost/,
    );
    assert.equal(calls.length, 1);
    assert.equal(state.rows[0]!.status, 'sending');
    assert.equal(state.receipts.length, 0);
    state.failTerminalStatus = false;

    // The claim timestamp is now older than the recovery lease.
    state.rows[0]!.updated_at = new Date(NOW().getTime() - 20 * 60 * 1000);
    const recovery = await recoverStaleSendingRows(db, { now: NOW });
    assert.equal(recovery.scanned, 1);
    assert.equal(recovery.flagged.length, 1);
    assert.equal(recovery.flagged[0]!.outboxId, state.rows[0]!.id);
    assert.equal(recovery.flagged[0]!.attempts, 1);
    assert.equal(state.rows[0]!.status, 'sending', 'an unknown external outcome must not be resolved as sent or failed');
    assert.equal(state.rows[0]!.last_error, STALE_SENDING_MARKER);
    assert.equal(state.rows[0]!.delivered_at, null);
    assert.equal(calls.length, 1, 'recovery must never call the adapter again');
    assert.equal(state.receipts.length, 0, 'recovery must not invent a delivery outcome');

    // The row stays unclaimable: no unsafe automatic resend of an unknown send.
    assert.deepEqual(
        await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        { dispatched: false, outcome: 'skipped' },
    );
    assert.equal(calls.length, 1);
});

test('a stale flag does not steal a delayed in-flight adapter result', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    let releaseSend: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let deliveries = 0;
    const adapter: DeliveryAdapter = {
        channel: 'email',
        deliver: async () => {
            deliveries += 1;
            await gate;
            return { outcome: 'sent', proof: { message_id: 'late-1' } };
        },
    };
    const inFlight = dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    await waitUntilSending(state);

    // The adapter is still running well past the lease.
    state.rows[0]!.updated_at = new Date(NOW().getTime() - 20 * 60 * 1000);
    const recovery = await recoverStaleSendingRows(db, { now: NOW });
    assert.equal(recovery.flagged.length, 1);
    assert.equal(state.rows[0]!.status, 'sending', 'recovery must not release a claim that may still be in flight');

    releaseSend!();
    assert.deepEqual(await inFlight, { dispatched: true, outcome: 'sent' });
    assert.equal(deliveries, 1);
    assert.equal(state.rows[0]!.status, 'sent');
    assert.equal(state.rows[0]!.last_error, null, 'the authoritative result clears the stale flag');
    assert.equal(state.receipts.length, 1);
    assert.equal(state.receipts[0]!.outcome, 'sent');
});

test('a failed receipt insert keeps the terminal sent state and never resends', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: { message_id: 'm1' } }]);
    const logs: unknown[] = [];
    state.failReceipts = true;
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true, (e) => logs.push(e)), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'sent' });
    assert.equal(state.rows[0]!.status, 'sent');
    assert.equal(state.rows[0]!.delivered_at !== null, true);
    assert.equal(state.receipts.length, 0);
    const alert = logs.map((entry) => JSON.stringify(entry)).find((entry) => entry.includes('receipt-persist-failed'));
    assert.ok(alert, 'a lost receipt must be surfaced, never swallowed');
    assert.equal(alert!.includes('+201000000123'), false);

    state.failReceipts = false;
    assert.deepEqual(
        await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        { dispatched: false, outcome: 'skipped' },
    );
    assert.equal(calls.length, 1, 'a terminal row must never be sent twice');
    assert.equal(state.receipts.length, 0);
});

test('a consent ledger failure releases the claim for a bounded retry and never calls the adapter', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: {} }]);
    const options: DispatchOptions = {
        ...makeDispatchOptions(true),
        consent: { canDeliver: async () => { throw new Error('consent ledger down'); } },
    };
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], options, HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'retry' });
    assert.equal(state.rows[0]!.status, 'pending', 'a pre-send failure must not wedge the row in sending');
    assert.equal(state.rows[0]!.attempts, 1);
    assert.equal(new Date(state.rows[0]!.next_attempt_at as Date).getTime(), NOW().getTime() + 60 * 1000);
    assert.match(String(state.rows[0]!.last_error), /consent-check-failed/);
    assert.equal(calls.length, 0);
    assert.equal(state.receipts.length, 0);
});

test('concurrent recovery sweeps flag a stale row once and preserve the claim', async () => {
    const state = makeState();
    seedRow(state, { status: 'sending', attempts: 1, updated_at: new Date(NOW().getTime() - 30 * 60 * 1000) });
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'sent', proof: {} }]);
    const sweeps = await Promise.all([
        recoverStaleSendingRows(db, { now: NOW }),
        recoverStaleSendingRows(db, { now: NOW }),
    ]);
    const flagged = sweeps.flatMap((sweep) => sweep.flagged);
    assert.equal(flagged.length, 1, 'one durable flag per stale row, even with two sweepers');
    assert.equal(sweeps.reduce((total, sweep) => total + sweep.alreadyFlagged, 0), 1);
    assert.equal(state.rows[0]!.status, 'sending');
    assert.equal(state.rows[0]!.last_error, STALE_SENDING_MARKER);

    const repeat = await recoverStaleSendingRows(db, { now: NOW });
    assert.equal(repeat.scanned, 0, 'a flagged row is not re-scanned before another lease window');
    assert.equal(state.receipts.length, 0);
    assert.deepEqual(
        await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        { dispatched: false, outcome: 'skipped' },
    );
    assert.equal(calls.length, 0);
});

test('recovery ignores fresh claims and clamps an unsafe lease', async () => {
    const state = makeState();
    seedRow(state, { status: 'sending', attempts: 1 });
    const db = makeDb(state);
    const fresh = await recoverStaleSendingRows(db, { now: NOW });
    assert.equal(fresh.scanned, 0);
    assert.equal(fresh.flagged.length, 0);
    assert.equal(state.rows[0]!.last_error, null);

    // 30s-old claim: a 0ms lease must be clamped up, so it is still not stale.
    state.rows[0]!.updated_at = new Date(NOW().getTime() - 30 * 1000);
    const clamped = await recoverStaleSendingRows(db, { now: NOW, olderThanMs: 0 });
    assert.equal(clamped.scanned, 0);
    assert.equal(state.rows[0]!.last_error, null);
});

// ---------------------------------------------------------------------------
// P5 — channel gates and PII hygiene
// ---------------------------------------------------------------------------

test('WhatsApp/SMS sends are refused without verified number, opt-in and approved template', async () => {
    const gate = {
        isPhoneVerified: async (input: { phone: string }) => input.phone === '+201000000123',
        isTemplateApproved: async (templateId: string) => templateId === 'tpl_approved',
    };
    const base = { tenantId: 'tenant-a', userId: 'p1', userType: 'parent', phone: '+201000000123', templateId: 'tpl_approved', optIn: true };
    assert.deepEqual(await gateChannelSend(gate, base), { ok: true } as const);
    assert.match(((await gateChannelSend(gate, { ...base, phone: '+209999999999' })) as { reason: string }).reason, /phone-not-verified/);
    assert.strictEqual(({ ok: false, reason: 'phone-missing' } as const).ok, (await gateChannelSend(gate, { ...base, phone: '' })).ok);
    assert.match(((await gateChannelSend(gate, { ...base, optIn: false })) as { reason: string }).reason, /channel-not-opted-in/);
    assert.match(((await gateChannelSend(gate, { ...base, templateId: 'tpl_other' })) as { reason: string }).reason, /template-not-approved/);
    const absent = await gateChannelSend(null, base);
    assert.equal(absent.ok, false);
});
test('no PII survives into refs, masks, proofs or logs', () => {
    const masked = maskPhone('+20 100 000 0123');
    assert.ok(!masked.includes('0100'));
    assert.ok(masked.endsWith('0123'));
    assert.equal(maskPhone('12'), '••••');
    assert.equal(redactPiiText('fail for +201000000123 line\nwrap'), 'fail for +•••••• line wrap');
    assert.deepEqual(sanitizeProof({ phone: '+201000000123', message_id: 'm1', body: 'hi', provider_status: 'ACCEPTED' }).provider_status, 'ACCEPTED');
    assert.equal('phone' in sanitizeProof({ phone: 'x', provider_status: 'ACCEPTED' }), false);
    const log = sanitizeDeliveryLog({ outboxId: 'o1', channel: 'sms', eventType: 'progress_report', outcome: 'failed', reason: 'number rejected', contact: '+201000000123', body: 'the secret text' }, HMAC_KEY);
    assert.ok(!JSON.stringify(log).includes('+201000000123'));
    assert.ok(!JSON.stringify(log).includes('secret text'));
    assert.match(log.contactRef, /^ref:[0-9a-f]{1,24}$/);
    assert.equal(contactRef('+201000000123', HMAC_KEY) === contactRef('+201000000123', HMAC_KEY), true);
    assert.equal(contactRef('+201000000123', HMAC_KEY) === contactRef('+209999999999', HMAC_KEY), false);
});

// ---------------------------------------------------------------------------
// P7 — parent report delivery over verified links
// ---------------------------------------------------------------------------

const linkedChecker = (allow: boolean): ParentLinkChecker => ({
    isVerifiedLinkedParent: async (input) => allow && input.tenantId === 'tenant-a' && input.studentEnrollmentId === 'enr-1',
});

const reportBase = {
    tenantId: 'tenant-a',
    parentUserId: 'parent-1',
    studentEnrollmentId: 'enr-1',
    channel: 'email',
    configuredFields: ['student_name', 'attendance_summary', 'grade_summary'],
    summary: {
        period: 'Sep 2026',
        locale: 'ar',
        fields: {
            student_name: 'Sami',
            attendance_summary: 'attendance 4/5',
            grade_summary: 'grades: 88%',
            progress_summary: 'behind on 1 lesson',
        },
    },
    linkSecret: LINK_SECRET,
    baseUrl: 'https://app.test/reports',
};

test('configure-only fields: unconfigured or unallow-listed fields are rejected before any write', () => {
    assert.equal(buildParentReportVars(['student_name', 'secret_workflow'], reportBase.summary, reportBase.baseUrl).ok, false);
    const vars = buildParentReportVars(reportBase.configuredFields, reportBase.summary, reportBase.baseUrl);
    assert.equal(vars.ok, true);
    if (vars.ok) {
        assert.ok(vars.value.summary_text.includes('attendance 4/5'));
        assert.ok(!vars.value.summary_text.includes('behind on 1 lesson'), 'progress_summary is not configured and must not appear');
        assert.ok(!Object.keys(vars.value).some((k) => k === 'progress_summary_only'));
    }
    assert.equal(buildParentReportVars([], reportBase.summary, reportBase.baseUrl).ok, false);
    assert.equal(buildParentReportVars(reportBase.configuredFields, reportBase.summary, '').ok, false);
    assert.equal(buildParentReportVars(reportBase.configuredFields, { ...reportBase.summary, fields: { ...reportBase.summary.fields, grade_summary: undefined } }, reportBase.baseUrl).ok, false);
});

test('a verified linked parent with consent gets exactly one queued report with signed links', async () => {
    const state = makeState();
    const db = makeDb(state);
    const consent = { canDeliver: async () => true };
    const result = await enqueueParentReportDelivery(db, linkedChecker(true), consent, { ...reportBase, now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(state.rows.length, 1);
    const row = state.rows[0]!;
    assert.equal(row.channel, 'email');
    assert.equal(row.recipient_user_type, 'parent');
    const payload = JSON.parse(String(row.payload)) as Record<string, string>;
    assert.ok(payload.summary_text.includes('attendance 4/5'));
    assert.ok(!payload.summary_text.includes('behind on 1 lesson'));
    assert.ok(payload.report_link.includes('?e='));
    assert.ok(payload.unsubscribe_link.includes('?u='));
    const reportToken = payload.report_link.split('?e=')[1]!;
    const verify = verifySecureLink(reportToken, LINK_SECRET, NOW);
    assert.equal(verify.ok, true);
    const rendered = renderOutboxTemplate(row.event_type, row.locale, payload);
    assert.equal(rendered.ok, true);
    const replay = await enqueueParentReportDelivery(db, linkedChecker(true), consent, { ...reportBase, now: NOW });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.duplicate, true);
    assert.equal(state.rows.length, 1);
});

test('an unlinked parent, wrong tenant, and opted-out parent are denied without writes', async () => {
    const state = makeState();
    const db = makeDb(state);
    const consent = { canDeliver: async () => true };
    assert.deepEqual(await enqueueParentReportDelivery(db, linkedChecker(false), consent, { ...reportBase, now: NOW }), { ok: false, reason: 'parent-not-linked' });
    assert.equal(state.rows.length, 0);
    assert.equal(state.executed.length, 0);
    assert.deepEqual(
        await enqueueParentReportDelivery(db, linkedChecker(true), consent, { ...reportBase, tenantId: 'tenant-b', now: NOW }),
        { ok: false, reason: 'parent-not-linked' },
    );
    assert.equal(state.rows.length, 0);
    assert.deepEqual(
        await enqueueParentReportDelivery(db, linkedChecker(true), { canDeliver: async () => false }, { ...reportBase, now: NOW }),
        { ok: false, reason: 'consent-revoked' },
    );
    assert.equal(state.rows.length, 0);
    assert.deepEqual(
        await enqueueParentReportDelivery(db, linkedChecker(true), consent, { ...reportBase, channel: 'push', now: NOW }),
        { ok: false, reason: 'validation-failed', error: 'Unknown delivery channel' },
    );
    assert.equal(state.rows.length, 0);
});

test('consent webhook style: revoking consent then re-granting, dispatch cancels queued rows at send time', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('whatsapp', [{ outcome: 'sent', proof: {} }]);
    state.rows[0]!.channel = 'whatsapp';
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(false), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'cancelled' });
    assert.equal(calls.length, 0);
    state.rows[0]!.status = 'pending';
    state.rows[0]!.next_attempt_at = NOW();
    const regrant = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    assert.deepEqual(regrant, { dispatched: true, outcome: 'sent' });
    assert.equal(state.receipts.at(-1)!.outcome, 'sent');
});

test('enqueueInput validation failure paths keep the outbox empty', async () => {
    const state = makeState();
    const db = makeDb(state);
    const bad = { ...validEnqueue, recipientUserType: '' };
    assert.equal(validateEnqueueInput(bad).ok, false);
    const result = await enqueueOutboxRow(db, bad as typeof validEnqueue, { now: NOW });
    assert.equal(result.ok, false);
    assert.equal(state.rows.length, 0);
});

// ---------------------------------------------------------------------------
// B2-W9 — unknown / unavailable / permanent outcomes and tenant-scoped claims
// ---------------------------------------------------------------------------

test('B2-W9: an unknown provider outcome is quarantined, never retried as unsent', async () => {
    const state = makeState();
    seedRow(state);
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'unknown', reason: 'gateway timeout after request write' }]);
    const logs: unknown[] = [];
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true, (entry) => logs.push(entry)), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'unknown' });
    const row = state.rows[0]!;
    assert.equal(row.status, 'sending', 'an unknown outcome stays unclaimable instead of returning to pending');
    assert.equal(row.last_error, UNKNOWN_OUTCOME_MARKER);
    assert.equal(row.delivered_at, null);
    assert.equal(row.next_attempt_at instanceof Date, true, 'NOT NULL next_attempt_at stays populated');
    assert.equal(state.receipts.at(-1)!.outcome, 'unknown', 'the ambiguous attempt is receipted for reconciliation');
    assert.equal(JSON.stringify(logs).includes('gateway timeout'), true);
    assert.equal(JSON.stringify(logs).includes('+201000000123'), false);

    // Unclaimable: a later dispatcher pass cannot re-send it.
    assert.deepEqual(
        await dispatchOutboxRow(db, row.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        { dispatched: false, outcome: 'skipped' },
    );
    assert.equal(calls.length, 1);

    // A stale sweep must not overwrite the quarantine reason with its own marker.
    row.updated_at = new Date(NOW().getTime() - 20 * 60 * 1000);
    const sweep = await recoverStaleSendingRows(db, { now: NOW });
    assert.equal(sweep.flagged.length, 0);
    assert.equal(row.last_error, UNKNOWN_OUTCOME_MARKER);
    assert.equal(row.status, 'sending');
});

test('B2-W9: an unavailable adapter retries and fails at the cap, never sent', async () => {
    const state = makeState();
    seedRow(state, { attempts: 0, max_attempts: 2 });
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'unavailable', reason: 'no-provider-configured' }]);
    const first = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    assert.deepEqual(first, { dispatched: true, outcome: 'unavailable' });
    const row = state.rows[0]!;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.delivered_at, null);
    assert.match(String(row.last_error), /no-provider-configured/);
    assert.equal(state.receipts.length, 0, 'a send that never happened leaves no delivery receipt');
    assert.equal(new Date(row.next_attempt_at as Date).getTime(), NOW().getTime() + 60 * 1000);

    row.next_attempt_at = NOW();
    const second = await dispatchOutboxRow(db, row.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    assert.deepEqual(second, { dispatched: true, outcome: 'failed' });
    assert.equal(row.status, 'failed');
    assert.equal(row.delivered_at, null, 'a failed row is never given a delivery timestamp');
    assert.equal(state.receipts.at(-1)!.outcome, 'failed');
    assert.equal(calls.length, 2);
});

test('B2-W9: a permanent failure is terminal on the first attempt', async () => {
    const state = makeState();
    seedRow(state, { attempts: 0, max_attempts: 5 });
    const db = makeDb(state);
    const { adapter, calls } = makeAdapter('email', [{ outcome: 'failed', reason: 'recipient rejected', permanent: true }]);
    const result = await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY);
    assert.deepEqual(result, { dispatched: true, outcome: 'failed' });
    assert.equal(state.rows[0]!.status, 'failed');
    assert.equal(state.rows[0]!.attempts, 1, 'a permanent failure must not burn the retry budget');
    assert.equal(state.receipts.at(-1)!.outcome, 'failed');
    assert.deepEqual(
        await dispatchOutboxRow(db, state.rows[0]!.id, [adapter], makeDispatchOptions(true), HMAC_KEY),
        { dispatched: false, outcome: 'skipped' },
    );
    assert.equal(calls.length, 1);
});

test('B2-W9: claimDueOutboxIdsInScope binds tenant and channel into the claim query', async () => {
    const state = makeState();
    seedRow(state, { tenant_id: 'tenant-a', channel: 'email' });
    seedRow(state, { tenant_id: 'tenant-a', channel: 'sms' });
    seedRow(state, { tenant_id: 'tenant-b', channel: 'email' });
    const db = makeDb(state);
    const ids = await claimDueOutboxIdsInScope(db, { tenantId: 'tenant-a', channels: ['email'], limit: 10, now: NOW });
    assert.deepEqual(ids, [state.rows[0]!.id]);
    const claim = state.executed.find((entry) => entry.kind === 'query');
    assert.ok(claim);
    assert.ok(claim!.sql.includes('tenant_id = ?'));
    assert.deepEqual(claim!.params.slice(1), ['tenant-a', 'email']);
});
