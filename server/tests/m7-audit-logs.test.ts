import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    AUDIT_CSV_HEADERS,
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

test('recordSealedAuditEvent seeds the chain with genesis and links each new row', async () => {
    const inserted: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
        query: async <T>(): Promise<T[]> => (inserted.length
            ? [{ entry_hash: 'leaf-0' } as unknown as T]
            : []),
        queryOne: async <T>(): Promise<T | null> => null,
        execute: async (sql: string, params: unknown[] = []) => {
            inserted.push({ sql, params });
            return { affectedRows: 1 };
        },
    };
    const input: SealedAuditRecordInput = {
        actorUserId: 'admin-a',
        tenantId: 'tenant-a',
        action: 'audit_log.exported',
        resourceType: 'audit_events',
        resourceId: '*',
        newValue: { row_count: 2 },
        reason: 'Audit log CSV export',
    };
    await recordSealedAuditEvent(db, input);
    await recordSealedAuditEvent(db, input);

    const first = inserted[0];
    const second = inserted[1];
    assert.ok(first.sql.includes('entry_hash, prev_entry_hash'));
    // genesis link: no leaf existed for the first row
    assert.equal(first.params[10], null);
    const recomputedFirst = computeEntryHash({
        prevEntryHash: null,
        id: String(first.params[0]),
        actorUserId: first.params[1] as string,
        tenantId: first.params[2] as string,
        action: String(first.params[3]),
        resourceType: String(first.params[4]),
        resourceId: String(first.params[5]),
        oldValue: first.params[6],
        newValue: first.params[7],
        reason: first.params[8] as string | null,
    });
    assert.equal(first.params[9], recomputedFirst);
    assert.equal(second.params[10], 'leaf-0');
    assert.notEqual(second.params[9], first.params[9]);
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

test('verifyAuditChain reports a valid sealed chain', async () => {
    const a = chainRow(1, null);
    const b = chainRow(2, a.entry_hash);
    const c = chainRow(3, b.entry_hash);
    const result = await verifyAuditChain({
        query: async (sql: string): Promise<unknown[]> => {
            if (sql.includes('COUNT(*)')) return [{ unsealed: 0 }];
            return [a, b, c];
        },
    } as never);
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
    assert.equal(result.unsealed, 0);
    assert.equal(result.firstFailure, null);
});

test('verifyAuditChain detects payload tampering and broken links', async () => {
    const a = chainRow(1, null);
    // The row keeps the hash signed for the original action but its stored
    // action was rewritten in place: a genuine payload tamper.
    const b = { ...chainRow(2, a.entry_hash), action: 'announcement.update' };
    const tamperDb = {
        query: async (sql: string): Promise<unknown[]> => {
            if (sql.includes('COUNT(*)')) return [{ unsealed: 3 }];
            return [a, b];
        },
    };
    const tampered = await verifyAuditChain(tamperDb as never);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.firstFailure?.code, 'payload-hash-mismatch');
    assert.equal(tampered.firstFailure?.rowId, 'row-2');
    assert.equal(tampered.checked, 2);
    assert.equal(tampered.unsealed, 3);

    // A re-signed row over a broken predecessor chain must still fail.
    const c = chainRow(3, b.entry_hash);
    const cForged = chainRow(3, 'c-forged-prev', { entry_hash: 'forged' });
    const linkDb = {
        query: async (sql: string): Promise<unknown[]> => {
            if (sql.includes('COUNT(*)')) return [{ unsealed: 0 }];
            return [a, c as AuditChainRow, cForged];
        },
    };
    const brokenLink = await verifyAuditChain(linkDb as never);
    assert.equal(brokenLink.ok, false);
    assert.equal(brokenLink.firstFailure?.code, 'chain-link-mismatch');
});

test('verifyAuditChain is bounded by the scan cap and counts unsealed rows', async () => {
    assert.equal(MAX_CHAIN_VERIFY_ROWS, 20000);
    const a = chainRow(1, null);
    const result = await verifyAuditChain({
        query: async (sql: string): Promise<unknown[]> => {
            if (sql.includes('COUNT(*)')) return [{ unsealed: 7 }];
            return [a];
        },
    } as never);
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
}

const buildRouter = (fixture: RouteFixture = {}) => {
    const executed: Array<{ sql: string; params: unknown[]; kind: string }> = [];
    const auditRecords: SealedAuditRecordInput[] = [];
    const db: AuditLogDataAccess = {
        query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'query' });
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
    assert.deepEqual(ok.body, { ok: true, checked: 0, unsealed: 0, firstFailure: null });
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
    const body = response.body as { ok: boolean; firstFailure?: { code?: string; rowId?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.firstFailure?.code, 'payload-hash-mismatch');
    assert.equal(body.firstFailure?.rowId, 'row-2');
});
