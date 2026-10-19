import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    AUDIT_CSV_HEADERS,
    CHAIN_HEAD_ROW_ID,
    MAX_CHAIN_VERIFY_ROWS,
    MAX_EXPORT_ROWS,
    MAX_PAGE,
    MAX_PAGE_LIMIT,
    computeEntryHash,
    neutralizeCsvCell,
    parseAuditFilters,
    parseAuditPagination,
    recordSealedAuditEvent,
    toAuditCsv,
    verifyAuditChain,
} from '../src/services/audit-log';
import type {
    AuditChainHeadRow,
    AuditChainRow,
    AuditLogDataAccess,
    SealedAuditRecordInput,
} from '../src/services/audit-log';
import { createAuditLogsRouter } from '../src/routes/audit-logs';
import { TEST_SECRET, invokeRoute, makeRepository, tokenFor } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const ADMIN = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
const OWNER = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const NONPRIVILEGED = tokenFor({ id: 'staff-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });

// ---------------------------------------------------------------------------
// Hash chain core
// ---------------------------------------------------------------------------

const hashInput = {
    prevEntryHash: null as string | null,
    id: 'row-1',
    actorUserId: 'admin-a',
    tenantId: 'tenant-a',
    action: 'announcement.create',
    resourceType: 'announcement',
    resourceId: 'res-1',
    oldValue: null,
    newValue: { title: 'Hello' },
    reason: null as string | null,
};

test('computeEntryHash is deterministic and differs per payload or predecessor', () => {
    const first = computeEntryHash(hashInput);
    assert.equal(first, computeEntryHash({ ...hashInput }));
    assert.notEqual(first, computeEntryHash({ ...hashInput, action: 'announcement.update' }));
    assert.notEqual(first, computeEntryHash({ ...hashInput, prevEntryHash: 'abc' }));
    assert.notEqual(first, computeEntryHash({ ...hashInput, tenantId: 'tenant-b' }));
    // JSON canonicalization: inserted-string vs re-parsed object hash identically
    assert.equal(
        computeEntryHash({ ...hashInput, newValue: '{"title":"Hello"}' as unknown }),
        first,
    );
});

const BASE_INPUT: SealedAuditRecordInput = {
    actorUserId: 'admin-a',
    tenantId: 'tenant-a',
    action: 'audit_log.exported',
    resourceType: 'audit_events',
    resourceId: '*',
    newValue: { row_count: 2 },
    reason: 'Audit log CSV export',
};

/**
 * In-memory fake of the head-anchored append contract: stateful head row,
 * simulated CAS guard semantics and statement recording, so the tests can
 * assert the exact statement order and parameters the append produces.
 */
const makeChainDb = () => {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const state = {
        head: null as { head_seq: number; head_entry_hash: string | null; head_row_id: string | null } | null,
        legacyLeaf: null as { id: string; entry_hash: string; chain_seq: number } | null,
    };
    const casAttempts: Array<{ assignedSeq: number; guardSeq: number }> = [];
    let loseNextCas = false;
    let failRowInserts = false;
    const db = {
        query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
            executed.push({ sql, params });
            if (sql.includes('FROM audit_chain_head')) {
                return (state.head ? [{ ...state.head }] : []) as unknown as T[];
            }
            return (state.legacyLeaf ? [{ ...state.legacyLeaf }] : []) as unknown as T[];
        },
        queryOne: async <T>(): Promise<T | null> => null,
        execute: async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO audit_chain_head')) {
                executed.push({ sql, params });
                state.head = {
                    head_seq: Number(params[1]),
                    head_entry_hash: params[2] as string | null,
                    head_row_id: params[3] as string | null,
                };
                return { affectedRows: 1 };
            }
            if (sql.includes('INSERT INTO audit_events')) {
                executed.push({ sql, params });
                if (failRowInserts) throw new Error('The audit_events insert failed');
                return { affectedRows: 1 };
            }
            if (sql.includes('UPDATE audit_chain_head')) {
                executed.push({ sql, params });
                const [assignedSeq, assignedHash, assignedRowId, , guardSeq] =
                    params as [number, string | null, string | null, string, number];
                casAttempts.push({ assignedSeq: Number(assignedSeq), guardSeq: Number(guardSeq) });
                if (Number(guardSeq) !== state.head?.head_seq) return { affectedRows: 0 };
                if (loseNextCas) {
                    // simulate the concurrent writer winning this guard first
                    loseNextCas = false;
                    state.head = {
                        head_seq: Number(guardSeq) + 1,
                        head_entry_hash: `competitor-${Number(guardSeq) + 1}`,
                        head_row_id: 'competitor-row',
                    };
                    return { affectedRows: 0 };
                }
                state.head = {
                    head_seq: Number(assignedSeq),
                    head_entry_hash: assignedHash,
                    head_row_id: assignedRowId,
                };
                return { affectedRows: 1 };
            }
            executed.push({ sql, params });
            return { affectedRows: 1 };
        },
    };
    return {
        db: db as unknown as AuditLogDataAccess,
        executed,
        state,
        casAttempts,
        advanceHeadWithoutGuard: (nextHash: string) => {
            state.head = {
                head_seq: (state.head?.head_seq ?? 0) + 1,
                head_entry_hash: nextHash,
                head_row_id: 'competitor-row',
            };
        },
        failNextCas: () => { loseNextCas = true; },
        failRowInserts: () => { failRowInserts = true; },
    };
};

test('recordSealedAuditEvent bootstraps the anchored head and assigns chain_seq 1', async () => {
    // Legacy database: no head row yet, no sealed rows either.
    const fake = makeChainDb();
    await recordSealedAuditEvent(fake.db, BASE_INPUT);

    // Statement order: locked head read -> legacy leaf read -> head seed ->
    // locked head re-read -> CAS reservation -> sealed row INSERT.
    assert.ok(fake.executed[0].sql.includes('FROM audit_chain_head'));
    assert.ok(fake.executed[0].sql.includes('FOR UPDATE'));
    assert.ok(fake.executed[1].sql.includes('ORDER BY chain_seq DESC, created_at DESC, id DESC'));
    const seed = fake.executed[2];
    assert.ok(seed.sql.includes('INSERT INTO audit_chain_head'));
    assert.deepEqual(seed.params, [CHAIN_HEAD_ROW_ID, 0, null, null]);
    assert.ok(fake.executed[3].sql.includes('FOR UPDATE'));
    const reserve = fake.executed[4];
    assert.ok(reserve.sql.includes('UPDATE audit_chain_head'));
    assert.ok(reserve.sql.includes('WHERE id = ? AND head_seq = ?'));
    assert.ok(reserve.sql.includes('updated_at = CURRENT_TIMESTAMP'));
    const insert = fake.executed[5];
    assert.ok(insert.sql.includes('entry_hash, prev_entry_hash, chain_seq'));
    // genesis link: prev null, sequence starts at 1, payload hash recomputes
    assert.equal(insert.params[10], null);
    assert.equal(insert.params[11], 1);
    const recomputed = computeEntryHash({
        prevEntryHash: null,
        id: String(insert.params[0]),
        actorUserId: insert.params[1] as string,
        tenantId: insert.params[2] as string,
        action: String(insert.params[3]),
        resourceType: String(insert.params[4]),
        resourceId: String(insert.params[5]),
        oldValue: insert.params[6],
        newValue: insert.params[7],
        reason: insert.params[8] as string | null,
    });
    assert.equal(insert.params[9], recomputed);
    // the anchored head advanced onto the new row
    assert.deepEqual(reserve.params, [1, recomputed, String(insert.params[0]), CHAIN_HEAD_ROW_ID, 0]);
    assert.deepEqual(fake.state.head, { head_seq: 1, head_entry_hash: recomputed, head_row_id: String(insert.params[0]) });
});

test('recordSealedAuditEvent seeds the head from a legacy sealed leaf and keeps the link', async () => {
    // Legacy database with sealed row 'legacy-1' (hash L0, seq 0).
    const fake = makeChainDb();
    fake.state.legacyLeaf = { id: 'legacy-1', entry_hash: 'L0', chain_seq: 0 };
    await recordSealedAuditEvent(fake.db, BASE_INPUT);
    // the head seed anchors the legacy leaf; the new row links onto it
    assert.deepEqual(fake.executed[2].params, [CHAIN_HEAD_ROW_ID, 0, 'L0', 'legacy-1']);
    assert.equal(fake.executed[5].params[10], 'L0');
    assert.equal(fake.executed[5].params[11], 1);
    assert.deepEqual(fake.executed[4].params, [
        1,
        fake.executed[5].params[9] as string,
        String(fake.executed[5].params[0]),
        CHAIN_HEAD_ROW_ID,
        0,
    ]);
});

test('recordSealedAuditEvent chains onto the anchored head without a legacy leaf read', async () => {
    // Second append: the head row already exists (seq 1, hash of the first row).
    const firstHash = computeEntryHash({
        prevEntryHash: null,
        id: 'row-1',
        actorUserId: 'admin-a',
        tenantId: 'tenant-a',
        action: BASE_INPUT.action,
        resourceType: BASE_INPUT.resourceType,
        resourceId: BASE_INPUT.resourceId,
        oldValue: null,
        newValue: JSON.stringify({ row_count: 2 }),
        reason: BASE_INPUT.reason ?? null,
    });
    const fake = makeChainDb();
    fake.state.head = { head_seq: 1, head_entry_hash: firstHash, head_row_id: 'row-1' };
    await recordSealedAuditEvent(fake.db, BASE_INPUT);
    // no bootstrap: exactly head read -> CAS reserve -> row insert
    assert.equal(fake.executed.length, 3);
    assert.ok(!fake.executed.some((e) => e.sql.includes('ORDER BY chain_seq DESC')));
    const insert = fake.executed[2];
    assert.equal(insert.params[10], firstHash);
    assert.equal(insert.params[11], 2);
    assert.deepEqual(fake.executed[1].params, [2, insert.params[9], String(insert.params[0]), CHAIN_HEAD_ROW_ID, 1]);
});

test('recordSealedAuditEvent retries the CAS until it reserves a fresh sequence', async () => {
    const fake = makeChainDb();
    fake.state.head = { head_seq: 7, head_entry_hash: 'competitor-7', head_row_id: 'competitor-row-7' };
    // simulated concurrent writer: wins the first reservation guard
    fake.failNextCas();
    await recordSealedAuditEvent(fake.db, BASE_INPUT);
    assert.equal(fake.casAttempts.length, 2);
    assert.equal(fake.casAttempts[0].assignedSeq, 8);
    assert.equal(fake.casAttempts[0].guardSeq, 7);
    assert.equal(fake.casAttempts[1].assignedSeq, 9);
    assert.equal(fake.casAttempts[1].guardSeq, 8);
    // the winning attempt inserted seq 9 linked to the competitor's hash
    assert.equal(fake.executed.filter((e) => e.sql.includes('INSERT INTO audit_events')).length, 1);
    const insert = fake.executed.find((e) => e.sql.includes('INSERT INTO audit_events'));
    assert.equal(insert?.params[10], 'competitor-8');
    assert.equal(insert?.params[11], 9);
    assert.deepEqual(fake.state.head, {
        head_seq: 9,
        head_entry_hash: insert?.params[9],
        head_row_id: String(insert?.params[0]),
    });
});

test('recordSealedAuditEvent fails without leaving a phantom head anchor when the row insert fails', async () => {
    const fake = makeChainDb();
    fake.state.head = { head_seq: 4, head_entry_hash: 'h-4', head_row_id: 'row-4' };
    fake.failRowInserts();
    await assert.rejects(() => recordSealedAuditEvent(fake.db, BASE_INPUT), /audit_events insert failed/);
    // the compensated restore put the head back on the pre-append anchor
    const restores = fake.executed.filter((e) =>
        e.sql.includes('UPDATE audit_chain_head') && !e.sql.includes('updated_at = CURRENT_TIMESTAMP'));
    assert.equal(restores.length, 1);
    assert.equal(restores[0].sql.includes('WHERE id = ? AND head_seq = ?'), true);
    assert.deepEqual(restores[0].params, [4, 'h-4', 'row-4', CHAIN_HEAD_ROW_ID, 5]);
    assert.deepEqual(fake.state.head, { head_seq: 4, head_entry_hash: 'h-4', head_row_id: 'row-4' });
});

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

const chainRow = (
    index: number,
    prev: string | null,
    overrides: Partial<AuditChainRow> = {},
): AuditChainRow => {
    const row: AuditChainRow = {
        id: `row-${index}`,
        actor_user_id: 'admin-a',
        tenant_id: 'tenant-a',
        action: 'announcement.create',
        resource_type: 'announcement',
        resource_id: `res-${index}`,
        old_value: null,
        new_value: { title: `t${index}` },
        reason: null,
        entry_hash: '',
        prev_entry_hash: prev,
        chain_seq: 0,
    };
    Object.assign(row, overrides);
    row.entry_hash = computeEntryHash({
        prevEntryHash: row.prev_entry_hash,
        id: row.id,
        actorUserId: row.actor_user_id,
        tenantId: row.tenant_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        oldValue: row.old_value,
        newValue: row.new_value,
        reason: row.reason,
    });
    return row;
};

/** Fake for verifyAuditChain's four queries: walk / unsealed count / head / leaf. */
const verifyChainDb = (fixture: {
    rows: AuditChainRow[];
    unsealed?: number;
    head?: AuditChainHeadRow | null;
    leaf?: { id: string; entry_hash: string; chain_seq: number | string | null } | null;
}) => ({
    query: async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('ORDER BY chain_seq DESC')) return (fixture.leaf ? [fixture.leaf] : []) as unknown as T[];
        if (sql.includes('FROM audit_chain_head')) return (fixture.head ? [fixture.head] : []) as unknown as T[];
        if (sql.includes('COUNT(*)')) return [{ unsealed: fixture.unsealed ?? 0 }] as unknown as T[];
        return fixture.rows as unknown as T[];
    },
}) as unknown as Pick<AuditLogDataAccess, 'query'>;

test('verifyAuditChain reports a valid sealed chain', async () => {
    const a = chainRow(1, null);
    const b = chainRow(2, a.entry_hash);
    const c = chainRow(3, b.entry_hash);
    // legacy chain: no anchored head row (query returns nothing)
    const result = await verifyAuditChain(verifyChainDb({ rows: [a, b, c] }));
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
    assert.equal(result.unsealed, 0);
    assert.equal(result.firstFailure, null);
    assert.equal(result.headAnchor, null);
});

test('verifyAuditChain validates a sequenced chain against its anchored head', async () => {
    const a = chainRow(1, null, { chain_seq: 1 });
    const b = chainRow(2, a.entry_hash, { chain_seq: 2 });
    const c = chainRow(3, b.entry_hash, { chain_seq: 3 });
    const result = await verifyAuditChain(verifyChainDb({
        rows: [a, b, c],
        head: { head_seq: 3, head_entry_hash: c.entry_hash, head_row_id: 'row-3' },
        leaf: { id: 'row-3', entry_hash: c.entry_hash, chain_seq: 3 },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
    assert.deepEqual(result.headAnchor, {
        headSeq: 3,
        headEntryHash: c.entry_hash,
        leafSeq: 3,
        leafEntryHash: c.entry_hash,
        ok: true,
    });
});

test('verifyAuditChain detects payload tampering and broken links', async () => {
    const a = chainRow(1, null);
    // The row keeps the hash signed for the original action but its stored
    // action was rewritten in place: a genuine payload tamper.
    const b = { ...chainRow(2, a.entry_hash), action: 'announcement.update' };
    const tampered = await verifyAuditChain(verifyChainDb({ rows: [a, b], unsealed: 3 }));
    assert.equal(tampered.ok, false);
    assert.equal(tampered.firstFailure?.code, 'payload-hash-mismatch');
    assert.equal(tampered.firstFailure?.rowId, 'row-2');
    assert.equal(tampered.checked, 2);
    assert.equal(tampered.unsealed, 3);
    assert.equal(tampered.headAnchor, null);

    // A re-signed row over a broken predecessor chain must still fail.
    const c = chainRow(3, b.entry_hash);
    const cForged = chainRow(3, 'c-forged-prev', { entry_hash: 'forged' });
    const brokenLink = await verifyAuditChain(verifyChainDb({ rows: [a, c, cForged] }));
    assert.equal(brokenLink.ok, false);
    assert.equal(brokenLink.firstFailure?.code, 'chain-link-mismatch');
});

test('verifyAuditChain flags a hole in the assigned chain_seq run', async () => {
    // Row with seq 2 was deleted from the middle of the chain: 1 -> 3 jumps.
    const a = chainRow(1, null, { chain_seq: 1 });
    const c = chainRow(3, a.entry_hash, { chain_seq: 3 });
    const result = await verifyAuditChain(verifyChainDb({
        rows: [a, c],
        head: { head_seq: 3, head_entry_hash: c.entry_hash, head_row_id: 'row-3' },
        leaf: { id: 'row-3', entry_hash: c.entry_hash, chain_seq: 3 },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.firstFailure?.code, 'chain-sequence-gap');
    assert.equal(result.firstFailure?.rowId, 'row-3');
    assert.equal(result.firstFailure?.expected, '2');
    assert.equal(result.firstFailure?.actual, '3');
});

test('verifyAuditChain detects tail truncation through the head anchor', async () => {
    const a = chainRow(1, null, { chain_seq: 1 });
    const b = chainRow(2, a.entry_hash, { chain_seq: 2 });
    const c = chainRow(3, b.entry_hash, { chain_seq: 3 });
    // Simulated tamper: row-3 was deleted, but the head still anchors it
    // (walk data shows the stale pre-truncation chain, the leaf read shows
    // the truncated tail) — the anchor comparison must fail the check.
    const result = await verifyAuditChain(verifyChainDb({
        rows: [a, b, c],
        head: { head_seq: 3, head_entry_hash: c.entry_hash, head_row_id: 'row-3' },
        leaf: { id: 'row-2', entry_hash: b.entry_hash, chain_seq: 2 },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.firstFailure?.code, 'head-anchor-mismatch');
    assert.equal(result.firstFailure?.rowId, 'row-3');
    assert.equal(result.firstFailure?.expected, c.entry_hash);
    assert.equal(result.firstFailure?.actual, b.entry_hash);
    assert.deepEqual(result.headAnchor, {
        headSeq: 3,
        headEntryHash: c.entry_hash,
        leafSeq: 2,
        leafEntryHash: b.entry_hash,
        ok: false,
    });
});

test('verifyAuditChain treats legacy seq 0 rows as un-sequenced but sealed', async () => {
    // Mixed legacy run: seq-0 rows keep (created_at, id) ordering and must
    // not trip the sequence-gap check when followed by sequenced rows.
    const a = chainRow(1, null);
    const b = chainRow(2, a.entry_hash);
    const c = chainRow(3, b.entry_hash, { chain_seq: 1 });
    const d = chainRow(4, c.entry_hash, { chain_seq: 2 });
    const result = await verifyAuditChain(verifyChainDb({ rows: [a, b, c, d] }));
    assert.equal(result.ok, true);
    assert.equal(result.checked, 4);
    assert.equal(result.firstFailure, null);
});

test('verifyAuditChain tolerates an empty chain anchored at genesis', async () => {
    const result = await verifyAuditChain(verifyChainDb({
        rows: [],
        head: { head_seq: 0, head_entry_hash: null, head_row_id: null },
        leaf: null,
    }));
    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.headAnchor, {
        headSeq: 0,
        headEntryHash: null,
        leafSeq: null,
        leafEntryHash: null,
        ok: true,
    });
});

test('verifyAuditChain is bounded by the scan cap and counts unsealed rows', async () => {
    assert.equal(MAX_CHAIN_VERIFY_ROWS, 20000);
    const a = chainRow(1, null);
    const result = await verifyAuditChain(verifyChainDb({ rows: [a], unsealed: 7 }));
    assert.equal(result.ok, true);
    assert.equal(result.checked, 1);
    assert.equal(result.unsealed, 7);
});

// ---------------------------------------------------------------------------
// CSV export core
// ---------------------------------------------------------------------------

test('neutralizeCsvCell prefixes every formula-injection leading character', () => {
    assert.equal(neutralizeCsvCell('=1+1'), "'=1+1");
    assert.equal(neutralizeCsvCell("+SUM(A1)"), "'+SUM(A1)");
    assert.equal(neutralizeCsvCell('-2'), "'-2");
    assert.equal(neutralizeCsvCell('@import'), "'@import");
    assert.equal(neutralizeCsvCell('\tchief'), "'\tchief");
    assert.equal(neutralizeCsvCell('\rrow'), "'\rrow");
    assert.equal(neutralizeCsvCell('safe'), 'safe');
});

test('toAuditCsv escapes quotes, commas, newlines and neutralizes formulas', () => {
    const csv = toAuditCsv([
        {
            id: 'r1',
            created_at: '2026-10-18 00:00:00',
            action: 'announcement.create',
            resource_type: 'announcement',
            resource_id: 'res,"1"',
            actor_user_id: 'admin-a',
            tenant_id: 'tenant-a',
            old_value: '=HYPERLINK("http://x","click")',
            new_value: { b: 'line1\nline2' },
            reason: null,
        },
    ]);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], AUDIT_CSV_HEADERS.join(','));
    assert.ok(lines[1].includes(`'=HYPERLINK`), lines[1]);
    assert.ok(lines[1].includes(`"res,""1"""`), lines[1]);
    assert.ok(lines[1].includes('line1\\nline2'), lines[1]);
});

// ---------------------------------------------------------------------------
// Filters + pagination caps
// ---------------------------------------------------------------------------

test('parseAuditFilters accepts safe filters and rejects injections', () => {
    const ok = parseAuditFilters({
        tenant_id: 'tenant-a',
        actor_user_id: 'admin-a',
        action: 'announcement.create',
        resource_type: 'announcement',
        from: '2026-10-01 00:00',
        to: '2026-10-18 23:59:59',
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok ? ok.value : {}, {
        tenantId: 'tenant-a',
        actorUserId: 'admin-a',
        action: 'announcement.create',
        resourceType: 'announcement',
        fromUtc: '2026-10-01 00:00:00',
        toUtc: '2026-10-18 23:59:59',
    });
    assert.equal(parseAuditFilters({ tenant_id: 'tenant-b OR 1=1' }).ok, false);
    assert.equal(parseAuditFilters({ action: 'bad action!' }).ok, false);
    assert.equal(parseAuditFilters({ action: 'a'.repeat(101) }).ok, false);
    assert.equal(parseAuditFilters({ resource_type: 'no/slashes-allowed?' }).ok, false);
    assert.equal(parseAuditFilters({ from: 'junk' }).ok, false);
    assert.equal(parseAuditFilters({ to: '2026-13-40' }).ok, false);
    assert.equal(parseAuditFilters({ from: '2026-10-02', to: '2026-10-01' }).ok, false);
    assert.equal(parseAuditFilters({ actor_user_id: 5 }).ok, false);
});

test('parseAuditPagination enforces capped pages and sizes', () => {
    assert.deepEqual(parseAuditPagination({}), { page: 1, limit: 50 });
    assert.deepEqual(parseAuditPagination({ page: '2', limit: '100' }), { page: 2, limit: 100 });
    assert.equal(parseAuditPagination({ page: '0' }), null);
    assert.equal(parseAuditPagination({ page: 'x' }), null);
    assert.equal(parseAuditPagination({ limit: `${MAX_PAGE_LIMIT + 1}` }), null);
    assert.equal(parseAuditPagination({ page: `${MAX_PAGE + 1}` }), null);
    assert.equal(parseAuditPagination({ limit: '10.5' }), null);
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

interface RouteFixture {
    isPlatformReader?: (userId: string) => Promise<boolean>;
    tenantOwner?: (userId: string, tenantId: string) => Promise<boolean>;
    auditRows?: Array<Record<string, unknown>>;
    auditCount?: number;
    chainRows?: AuditChainRow[];
    unsealed?: number;
    head?: AuditChainHeadRow | null;
    leaf?: { id: string; entry_hash: string; chain_seq: number | string | null } | null;
}

const buildRouter = (fixture: RouteFixture = {}) => {
    const executed: Array<{ sql: string; params: unknown[]; kind: string }> = [];
    const auditRecords: SealedAuditRecordInput[] = [];
    const db: AuditLogDataAccess = {
        query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'query' });
            if (sql.includes('ORDER BY chain_seq DESC')) {
                return (fixture.leaf ? [fixture.leaf] : []) as unknown as T[];
            }
            if (sql.includes('FROM audit_chain_head')) {
                return (fixture.head ? [fixture.head] : []) as unknown as T[];
            }
            if (sql.includes('WHERE entry_hash IS NOT NULL')) {
                return (fixture.chainRows ?? []) as unknown as T[];
            }
            if (sql.includes('COUNT(*) AS total FROM audit_events')) {
                return [{ total: fixture.auditCount ?? (fixture.auditRows?.length ?? 0) }] as unknown as T[];
            }
            if (sql.includes('COUNT(*)')) {
                return [{ unsealed: fixture.unsealed ?? 0 }] as unknown as T[];
            }
            return (fixture.auditRows ?? []) as unknown as T[];
        },
        queryOne: async <T = Record<string, unknown>>(): Promise<T | null> => {
            executed.push({ sql: '(queryOne)', params: [], kind: 'queryOne' });
            return null;
        },
        execute: async (sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'execute' });
            return { affectedRows: 1 };
        },
    };
    const router: Router = createAuditLogsRouter({
        db,
        authenticate: createAuthenticateToken(makeRepository({
            'admin-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'staff-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        }, {
            instructorAccounts: {
                'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'staff-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: {
                'owner-a': [{ tenant_id: 'tenant-a' }],
                'staff-a': [{ tenant_id: 'tenant-a' }],
            },
        })),
        requirePlatformPermission: () => async (req, res, next) => {
            if (!(req as { user?: { id?: string } }).user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            if (await (fixture.isPlatformReader?.(userId(req)) ?? userId(req) === 'admin-a')) return next();
            res.status(403).json({ error: 'Forbidden' });
        },
        isPlatformReader: fixture.isPlatformReader ?? (async () => true),
        tenantOwnerTenantId: fixture.tenantOwner ?? (async (id) => id === 'owner-a'),
        recordAudit: async (_dataAccess, input) => {
            executed.push({ sql: `audit:${input.action}`, params: [], kind: 'audit' });
            auditRecords.push(input);
        },
    });
    return { router, executed, auditRecords };
};

const userId = (req: { user?: { id?: string } }): string => req.user?.id ?? '';

const invoke = async (
    router: Router,
    request: { method: string; url: string; token?: string; query?: Record<string, string> },
): Promise<{ statusCode?: number; body?: unknown }> => invokeRoute(router, request as never);

const invokeExport = async (
    router: Router,
    request: { method: string; url: string; token?: string; query?: Record<string, string> },
): Promise<{ statusCode?: number; body?: string; headers: Record<string, string> }> => {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    let statusCode: number | undefined;
    const res = {
        status(code: number) { statusCode = code; return res; },
        json(payload: unknown) { statusCode ??= 200; body = JSON.stringify(payload); return res; },
        set(header: string, value: string) { headers[header.toLowerCase()] = value; return res; },
        send(payload: string) { body = payload; return res; },
    };
    const tokenPart = request.token ? { authorization: `Bearer ${request.token}` } : {};
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: tokenPart,
        body: {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(req, res, () => {});
    const deadline = Date.now() + 5000;
    while (body === undefined && statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { statusCode, body, headers };
};

const SAMPLE_ROW = (tenantId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'row-1',
    created_at: '2026-10-18 09:00:00',
    action: 'announcement.create',
    resource_type: 'announcement',
    resource_id: 'res-1',
    actor_user_id: 'admin-a',
    actor_name: 'Platform Admin',
    tenant_id: tenantId,
    old_value: null,
    new_value: { title: '=SUBTOTAL(9,range)' },
    reason: null,
    ...extra,
});

// --- scope tests ---
test('audit events: anonymous reads are 401 with no data access', async () => {
    const { router, executed } = buildRouter();
    const response = await invoke(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('audit events: a non-owner tenant member is 403', async () => {
    const { router, executed } = buildRouter({
        tenantOwner: async () => false,
        isPlatformReader: async () => false,
    });
    const response = await invoke(router, { method: 'GET', url: '/', token: NONPRIVILEGED });
    assert.equal(response.statusCode, 403);
    assert.ok(!executed.some((e) => e.sql.includes('audit_events')));
});

test('audit events: a tenant owner is pinned to their own tenant rows', async () => {
    const { router, executed } = buildRouter({
        isPlatformReader: async () => false,
        tenantOwner: async (id) => id === 'owner-a',
        auditRows: [SAMPLE_ROW('tenant-a')],
    });
    const pinned = await invoke(router, {
        method: 'GET', url: '/', token: OWNER,
        query: { tenant_id: 'tenant-b' },
    });
    assert.equal(pinned.statusCode, 200);
    const listSql = executed.find((e) => e.kind === 'query' && e.sql.includes('FROM audit_events a'));
    assert.ok(listSql);
    assert.ok(listSql.sql.includes('tenant_id = ?'));
    assert.equal(listSql.params[0], 'tenant-a');
});

test('audit events: a platform reader may cross tenants and all of them stay valid', async () => {
    const { router, executed } = buildRouter({ auditRows: [SAMPLE_ROW('tenant-b')] });
    const response = await invoke(router, {
        method: 'GET', url: '/', token: ADMIN,
        query: { tenant_id: 'tenant-b', limit: '10' },
    });
    assert.equal(response.statusCode, 200);
    const listSql = executed.find((e) => e.kind === 'query' && e.sql.includes('FROM audit_events a'));
    assert.equal(listSql?.params[0], 'tenant-b');
    const body = response.body as { total?: number };
    assert.equal(body.total, 1);
});

// --- validation ---
test('audit events: malformed filters and pagination are 400', async () => {
    const { router, executed } = buildRouter();
    const badAction = await invoke(router, { method: 'GET', url: '/', token: ADMIN, query: { action: 'drop;"' } });
    assert.equal(badAction.statusCode, 400);
    const badDate = await invoke(router, { method: 'GET', url: '/', token: ADMIN, query: { from: 'yesterday' } });
    assert.equal(badDate.statusCode, 400);
    const badRange = await invoke(router, { method: 'GET', url: '/', token: ADMIN, query: { from: '2026-10-02', to: '2026-10-01' } });
    assert.equal(badRange.statusCode, 400);
    const badLimit = await invoke(router, { method: 'GET', url: '/', token: ADMIN, query: { limit: '150' } });
    assert.equal(badLimit.statusCode, 400);
    const badPage = await invoke(router, { method: 'GET', url: '/', token: ADMIN, query: { page: 'zero' } });
    assert.equal(badPage.statusCode, 400);
    assert.ok(!executed.some((e) => e.kind === 'query' && e.sql.includes('FROM audit_events a')));
});

// --- export ---
test('audit events: export neutralizes formulas, caps rows and audits the export', async () => {
    const { router, executed, auditRecords } = buildRouter({
        auditRows: [SAMPLE_ROW('tenant-b', { old_value: '=cmd|\' /C calc\'!A0' })],
    });
    const result = await invokeExport(router, {
        method: 'GET', url: '/export.csv', token: ADMIN, query: { tenant_id: 'tenant-b' },
    });
    assert.equal(result.statusCode, undefined); // send body wins
    assert.ok(String(result.body).includes(`'=cmd|' /C calc'!A0`), result.body);
    assert.match(result.headers['content-type'] ?? '', /text\/csv/);
    const exportSql = executed.find((e) => e.kind === 'query' && e.sql.includes(`LIMIT ${MAX_EXPORT_ROWS}`));
    assert.ok(exportSql);
    assert.ok(exportSql.sql.includes('SELECT id, action'));
    const exportAudit = auditRecords.find((record) => record.action === 'audit_log.exported');
    assert.ok(exportAudit);
    assert.equal(exportAudit.actorUserId, 'admin-a');
    assert.equal(exportAudit.reason, 'Audit log CSV export');
});

test('audit events: export rejects malformed filters before any read or audit', async () => {
    const { router, executed, auditRecords } = buildRouter();
    const malformed = await invokeExport(router, {
        method: 'GET', url: '/export.csv', token: ADMIN, query: { action: 'drop;"' },
    });
    assert.equal(malformed.statusCode, 400);
    const badRange = await invokeExport(router, {
        method: 'GET', url: '/export.csv', token: ADMIN,
        query: { from: '2026-10-02', to: '2026-10-01' },
    });
    assert.equal(badRange.statusCode, 400);
    assert.ok(!executed.some((e) => e.kind === 'query' && e.sql.includes('FROM audit_events')));
    assert.equal(auditRecords.length, 0);
});

test('audit events: tenant-owner export stays scoped and audited', async () => {
    const { router, auditRecords } = buildRouter({
        isPlatformReader: async () => false,
        tenantOwner: async (id) => id === 'owner-a',
        auditRows: [SAMPLE_ROW('tenant-a')],
    });
    const result = await invokeExport(router, {
        method: 'GET', url: '/export.csv', token: OWNER, query: { tenant_id: 'tenant-b' },
    });
    assert.match(result.body ?? '', /row-1/);
    const exportAudit = auditRecords.find((record) => record.action === 'audit_log.exported');
    assert.ok(exportAudit);
    assert.equal(exportAudit.tenantId, 'tenant-a');
});

// --- append-only + chain verify ---
test('audit events: reads never update or delete audit rows', async () => {
    const { router, executed } = buildRouter({
        auditRows: [SAMPLE_ROW('tenant-b')],
        chainRows: [chainRow(1, null), chainRow(2, chainRow(1, null).entry_hash)],
    });
    await invoke(router, { method: 'GET', url: '/', token: ADMIN });
    await invoke(router, { method: 'GET', url: '/chain/verify', token: ADMIN });
    for (const statement of executed) {
        if (statement.kind === 'execute') {
            assert.ok(!/\bUPDATE\b/i.test(statement.sql), statement.sql);
            assert.ok(!/\bDELETE\b/i.test(statement.sql), statement.sql);
        }
    }
});

test('audit events: chain verification is platform-only', async () => {
    const { router } = buildRouter({
        isPlatformReader: async (id) => id === 'admin-a',
        tenantOwner: async (id) => id === 'owner-a',
    });
    const denied = await invoke(router, { method: 'GET', url: '/chain/verify', token: OWNER });
    assert.equal(denied.statusCode, 403);
    const ok = await invoke(router, { method: 'GET', url: '/chain/verify', token: ADMIN });
    assert.equal(ok.statusCode, 200);
    // legacy chain (no head row): headAnchor is reported as null
    assert.deepEqual(ok.body, { ok: true, checked: 0, unsealed: 0, firstFailure: null, headAnchor: null });
});

test('audit events: chain verification reports tampering through the route', async () => {
    const a = chainRow(1, null);
    const b = chainRow(2, a.entry_hash, { action: 'announcement.update' });
    // the DB row keeps the update-signed hash but its cleared action was
    // rewritten in place (payload tamper) — verification must flag it.
    const tampered = { ...b, action: 'announcement.create' };
    const { router } = buildRouter({ chainRows: [a, tampered] });
    const response = await invoke(router, { method: 'GET', url: '/chain/verify', token: ADMIN });
    assert.equal(response.statusCode, 200);
    const body = response.body as { ok: boolean; firstFailure?: { code?: string; rowId?: string }; headAnchor?: unknown };
    assert.equal(body.ok, false);
    assert.equal(body.firstFailure?.code, 'payload-hash-mismatch');
    assert.equal(body.firstFailure?.rowId, 'row-2');
    assert.equal(body.headAnchor, null);
});

test('audit events: the route exposes the anchored-head verdict', async () => {
    const a = chainRow(1, null, { chain_seq: 1 });
    const b = chainRow(2, a.entry_hash, { chain_seq: 2 });
    const { router } = buildRouter({
        chainRows: [a, b],
        head: { head_seq: 2, head_entry_hash: b.entry_hash, head_row_id: 'row-2' },
        leaf: { id: 'row-1', entry_hash: a.entry_hash, chain_seq: 1 },
    });
    const response = await invoke(router, { method: 'GET', url: '/chain/verify', token: ADMIN });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        ok: false,
        checked: 2,
        unsealed: 0,
        firstFailure: {
            rowIndex: -1,
            rowId: 'row-2',
            code: 'head-anchor-mismatch',
            expected: b.entry_hash,
            actual: a.entry_hash,
        },
        headAnchor: {
            headSeq: 2,
            headEntryHash: b.entry_hash,
            leafSeq: 1,
            leafEntryHash: a.entry_hash,
            ok: false,
        },
    });
});
