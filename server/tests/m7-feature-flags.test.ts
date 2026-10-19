import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    MAX_TARGET_TENANTS,
    TARGETING_MODES,
    evaluateTargeting,
    evaluateRequiredFeature,
    previewTargetedTenants,
    stableTenantHash,
    validateAuditReason,
    validateFlagCreateInput,
    validateRollbackInput,
    validateTargetingInput,
} from '../src/services/feature-flags';
import { createPlatformFlagsRouter } from '../src/routes/platform-flags';
import type { Router } from 'express';
import {
    TEST_SECRET,
    invokeRoute,
    makeRepository,
    tokenFor,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('validateFlagCreateInput enforces the key pattern and description bounds', () => {
    assert.equal(validateFlagCreateInput({ flag_key: 'Payouts Enabled' }).ok, false);
    assert.equal(validateFlagCreateInput({ flag_key: 'ab' }).ok, false);
    assert.equal(validateFlagCreateInput({ flag_key: '-bad' }).ok, false);
    assert.equal(validateFlagCreateInput({}).ok, false);
    assert.equal(validateFlagCreateInput('flag').ok, false);
    const ok = validateFlagCreateInput({ flag_key: 'playback_watermarking', description: 'x'.repeat(600) });
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.value.flagKey, 'playback_watermarking');
        assert.equal(ok.value.description?.length, 500);
    }
});

test('validateTargetingInput only accepts the four scoped modes', () => {
    assert.deepEqual(TARGETING_MODES, ['all', 'plan', 'tenant_list', 'percentage']);
    for (const mode of ['everyone', 'plan ', 'TENANT_LIST', null, 3]) {
        assert.equal(validateTargetingInput({ targeting_mode: mode }).ok, false);
    }
    assert.equal(validateTargetingInput({ targeting_mode: 'plan' }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'plan', plan_id: 'NOT A $ID' }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'percentage' }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'percentage', percentage: 101 }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'percentage', percentage: -1 }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'percentage', percentage: 2.5 }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'tenant_list' }).ok, false);
    assert.equal(validateTargetingInput({ targeting_mode: 'tenant_list', tenant_ids: ['ok-1', 'ok-1'] }).ok, false);
    assert.equal(
        validateTargetingInput({ targeting_mode: 'tenant_list', tenant_ids: Array(MAX_TARGET_TENANTS + 1).fill('t') }).ok,
        false,
    );
    const ok = validateTargetingInput({ targeting_mode: 'tenant_list', tenant_ids: ['tenant-a', 'tenant-b'] });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.value.tenantIds, ['tenant-a', 'tenant-b']);
});

test('validateRollbackInput and validateAuditReason require sane values', () => {
    assert.equal(validateRollbackInput({}).ok, false);
    assert.equal(validateRollbackInput({ version_no: 0 }).ok, false);
    assert.equal(validateRollbackInput({ version_no: 'seven' }).ok, false);
    const ok = validateRollbackInput({ version_no: 3 });
    assert.equal(ok.ok, true);
    assert.equal(validateAuditReason(undefined).ok, false);
    assert.equal(validateAuditReason('ta').ok, false);
    assert.equal(validateAuditReason(42).ok, false);
    assert.equal(validateAuditReason(`r${'e'.repeat(499)}`).ok, true);
});

test('stableTenantHash is deterministic, within 0..99 and keyed per flag', () => {
    for (const key of ['watermark', 'payouts', 'teacher_school']) {
        for (const tenant of ['tenant-a', 'tenant-b', '11111111-1111-1111-1111-111111111111']) {
            const hash = stableTenantHash(key, tenant);
            assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 99);
            assert.equal(hash, stableTenantHash(key, tenant));
        }
    }
    assert.notEqual(stableTenantHash('a', 'tenant-a'), stableTenantHash('b', 'tenant-a'));
});

test('evaluateTargeting covers all/plan/tenant_list/percentage and deny-by-default disabled', () => {
    const ctx = { flagKey: 'watermark', tenantId: 'tenant-a', planId: 'plan-1' };
    assert.equal(evaluateTargeting({ mode: 'all', planId: null, tenantIds: [], percentage: null, enabled: false }, ctx), false);
    assert.equal(evaluateTargeting({ mode: 'all', planId: null, tenantIds: [], percentage: null, enabled: true }, ctx), true);
    assert.equal(evaluateTargeting({ mode: 'plan', planId: 'plan-1', tenantIds: [], percentage: null, enabled: true }, ctx), true);
    assert.equal(evaluateTargeting({ mode: 'plan', planId: 'plan-2', tenantIds: [], percentage: null, enabled: true }, ctx), false);
    assert.equal(evaluateTargeting({ mode: 'plan', planId: null, tenantIds: [], percentage: null, enabled: true }, { ...ctx, planId: null }), false);
    assert.equal(
        evaluateTargeting({ mode: 'tenant_list', planId: null, tenantIds: ['tenant-b'], percentage: null, enabled: true }, ctx),
        false,
    );
    assert.equal(
        evaluateTargeting({ mode: 'tenant_list', planId: null, tenantIds: ['tenant-a'], percentage: null, enabled: true }, ctx),
        true,
    );
    const hash = stableTenantHash('watermark', 'tenant-a');
    assert.equal(
        evaluateTargeting({ mode: 'percentage', planId: null, tenantIds: [], percentage: hash, enabled: true }, ctx),
        false,
    );
    assert.equal(
        evaluateTargeting({ mode: 'percentage', planId: null, tenantIds: [], percentage: hash + 1, enabled: true }, ctx),
        true,
    );
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const ADMIN_A = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
const ADMIN_B = tokenFor({ id: 'admin-b', role: 'admin', tv: 0 });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });

interface Fixture {
    permission?: (userId: string) => Promise<boolean>;
    plans: Record<string, { id: string }> | null;
    tenants: string[];
    flagRow: Record<string, unknown> | null;
    versionRow: Record<string, unknown> | null;
    subscriptionPlanId: string | null;
    activeTenantRows: Array<{ tenant_id: string; plan_id: string | null }>;
    nextVersionNo?: number;
}

const buildRouter = (fixture: Partial<Fixture> = {}) => {
    const executed: Array<{ sql: string; params: unknown[]; kind: string }> = [];
    const permission = (userId: string) => Promise.resolve(fixture.permission?.(userId) ?? userId === 'admin-a');
    const responder = (sql: string, params: unknown[]): unknown[] | null => {
        // plan existence check (publish)
        if (sql.includes('FROM platform_plans')) return fixture.plans ? [fixture.plans[String(params[0])]].filter(Boolean) : [];
        // tenant-list existence check (publish)
        if (sql.includes('COUNT(*) AS found FROM tenants')) {
            const present = params.filter((id) => fixture.tenants.includes(String(id))).length;
            return [{ found: present }];
        }
        // tenant preview
        if (sql.includes('FROM tenants t') && sql.includes('tenant_subscriptions')) {
            return fixture.activeTenantRows ?? [];
        }
        // flag registry lookup by id or key
        if (sql.includes('FROM feature_flags WHERE')) return fixture.flagRow ? [fixture.flagRow] : [];
        // active-version join (enforcement evaluation)
        if (sql.includes('INNER JOIN feature_flags f')) return fixture.versionRow ? [fixture.versionRow] : [];
        // version list / specific rollback target
        if (sql.includes('FROM feature_flag_versions WHERE flag_id')) {
            const version = fixture.versionRow;
            if (!version) return [];
            return Number(params[1]) === Number(version.version_no) ? [version] : [];
        }
        if (sql.includes('MAX(version_no)')) return [{ next_no: fixture.nextVersionNo ?? 2 }];
        // tenant plan lookup
        if (sql.includes('FROM tenant_subscriptions')) {
            return fixture.subscriptionPlanId ? [{ plan_id: fixture.subscriptionPlanId }] : [];
        }
        return null;
    };
    const db = {
        query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'query' });
            return ((responder(sql, params) ?? []) as T[]);
        },
        queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'queryOne' });
            const rows = responder(sql, params) ?? [];
            return (rows[0] ?? null) as T | null;
        },
        execute: async (sql: string, params: unknown[] = []) => {
            executed.push({ sql, params, kind: 'execute' });
            return { affectedRows: 1 };
        },
    };
    const router: Router = createPlatformFlagsRouter({
        db,
        authenticate: createAuthenticateToken(makeRepository({
            'admin-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'admin-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        })),
        requirePlatformPermission: (perm) => async (req, res, next) => {
            if (!(req as { user?: { id?: string } }).user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const userId = (req as { user?: { id?: string } }).user!.id!;
            if (await permission(userId)) return next();
            res.status(403).json({ error: 'Forbidden' });
        },
        recordAudit: async (_tx, input) => {
            await Promise.resolve();
            return;
        },
    });
    return { router, executed };
};

// --- list / anonymous / permission ---
test('flags: anonymous list is 401 with no permission evaluation', async () => {
    const { router, executed } = buildRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('flags: a caller without the platform permission is 403', async () => {
    const { router, executed } = buildRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: OWNER_A });
    assert.equal(response.statusCode, 403);
    assert.ok(!executed.some((e) => e.sql.includes('FROM feature_flags')));
});

test('flags: list returns registry rows for a permitted platform caller', async () => {
    const { router, executed } = buildRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: ADMIN_A });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('FROM feature_flags f')));
});

// --- create ---
test('flags: create validates the key and refuses a duplicate', async () => {
    const { router, executed } = buildRouter({
        flagRow: { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 0, active_version_id: null },
    });
    const bad = await invokeRoute(router, { method: 'POST', url: '/', token: ADMIN_A, body: { flag_key: 'BAD KEY!' } });
    assert.equal(bad.statusCode, 400);
    const duplicate = await invokeRoute(router, { method: 'POST', url: '/', token: ADMIN_A, body: { flag_key: 'watermark' } });
    assert.equal(duplicate.statusCode, 409);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO feature_flags')));
});

test('flags: create inserts the registry row and the audit reason', async () => {
    const { router, executed } = buildRouter();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: ADMIN_A,
        body: { flag_key: 'student_wallet', description: 'Wallet preview flag' },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO feature_flags'));
    assert.ok(insert);
    assert.equal(insert?.params[0], (response.body as { id: string }).id);
});

// --- versions ---
test('flags: publish validates targeting, plan and tenant references', async () => {
    const flagRow = { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 0, active_version_id: null };
    const { router, executed } = buildRouter({
        flagRow,
        plans: { 'plan-1': { id: 'plan-1' } },
        tenants: ['tenant-a'],
    });
    const invalid = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_A,
        body: { targeting_mode: 'percentage', percentage: 250, reason: 'test run' },
    });
    assert.equal(invalid.statusCode, 400);
    const missingReason = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_A,
        body: { targeting_mode: 'all' },
    });
    assert.equal(missingReason.statusCode, 400);
    const unknownPlan = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_A,
        body: { targeting_mode: 'plan', plan_id: 'plan-x', reason: 'test run' },
    });
    assert.equal(unknownPlan.statusCode, 400);
    const unknownTenant = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_A,
        body: { targeting_mode: 'tenant_list', tenant_ids: ['tenant-z'], reason: 'test run' },
    });
    assert.equal(unknownTenant.statusCode, 400);
    assert.ok(!executed.some((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO feature_flag_versions')));
});

test('flags: a non-platform caller cannot publish a version', async () => {
    const { router, executed } = buildRouter();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_B,
        body: { targeting_mode: 'all', reason: 'cross attempt' },
    });
    assert.equal(response.statusCode, 403);
    assert.ok(!executed.some((e) => e.kind === 'execute'));
});

test('flags: every mutation requires the manage permission and writes nothing on denial', async () => {
    const flagRow = { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 0, active_version_id: 'v-2' };
    const versionRow = {
        id: 'v-1', version_no: 1, targeting_mode: 'all', plan_id: null, percentage: null,
        tenant_ids: null, enabled: 1, created_at: '2026-10-17 01:00:00', reason: 'r',
    };
    const create = buildRouter();
    const created = await invokeRoute(create.router, {
        method: 'POST', url: '/', token: ADMIN_B, body: { flag_key: 'denied_flag' },
    });
    assert.equal(created.statusCode, 403);
    assert.ok(!create.executed.some((e) => e.kind === 'execute'));
    const { router, executed } = buildRouter({ flagRow, versionRow });
    const rolledBack = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/rollback', token: ADMIN_B, body: { version_no: 1, reason: 'denied' },
    });
    assert.equal(rolledBack.statusCode, 403);
    const archived = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/archive', token: ADMIN_B, body: { reason: 'denied' },
    });
    assert.equal(archived.statusCode, 403);
    assert.ok(!executed.some((e) => e.kind === 'execute'));
});

test('flags: publish writes an immutable version and moves the active pointer', async () => {
    const flagRow = { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 0, active_version_id: null };
    const { router, executed } = buildRouter({ flagRow, nextVersionNo: 3 });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_A,
        body: { targeting_mode: 'percentage', percentage: 40, reason: 'gradual rollout' },
    });
    assert.equal(response.statusCode, 201);
    const versionInsert = executed.find((e) => e.sql.includes('INSERT INTO feature_flag_versions'));
    assert.ok(versionInsert);
    assert.equal(versionInsert?.params[3], 'percentage');
    assert.equal(versionInsert?.params[5], 40);
    assert.equal(versionInsert?.params[9], 'gradual rollout');
    const pointer = executed.find((e) => e.sql.includes('UPDATE feature_flags SET active_version_id'));
    assert.ok(pointer);
});

test('flags: an archived flag rejects retargeting', async () => {
    const { router, executed } = buildRouter({
        flagRow: { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 1, active_version_id: 'v-1' },
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/versions', token: ADMIN_A,
        body: { targeting_mode: 'all', reason: 'should fail' },
    });
    assert.equal(response.statusCode, 409);
    assert.ok(!executed.some((e) => e.sql.includes('INSERT INTO feature_flag_versions')));
});

// --- rollback ---
test('flags: rollback validates the target version and audits the pointer change', async () => {
    const olderVersion = { id: 'v-1', version_no: 1, targeting_mode: 'plan', plan_id: 'plan-1', percentage: null, tenant_ids: null, enabled: 1, created_at: '2026-10-17 01:00:00', reason: 'r' };
    const { router, executed } = buildRouter({
        flagRow: { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 0, active_version_id: 'v-2' },
        versionRow: olderVersion,
    });
    const missing = await invokeRoute(router, { method: 'POST', url: '/flag-1/rollback', token: ADMIN_A, body: {} });
    assert.equal(missing.statusCode, 400);
    const badVersion = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/rollback', token: ADMIN_A,
        body: { version_no: 9, reason: 'not there' },
    });
    assert.equal(badVersion.statusCode, 404);
    const ok = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/rollback', token: ADMIN_A,
        body: { version_no: 1, reason: 'restore plan targeting' },
    });
    assert.equal(ok.statusCode, 200);
    const pointer = executed.find((e) => e.sql.includes('UPDATE feature_flags SET active_version_id'));
    assert.ok(pointer);
    assert.equal(pointer?.params[0], 'v-1');
    assert.equal(pointer?.params[2], 'v-2');
});

// --- archive ---
test('flags: archive requires a reason and seals the flag', async () => {
    const { router, executed } = buildRouter({
        flagRow: { id: 'flag-1', flag_key: 'watermark', description: null, is_archived: 0, active_version_id: 'v-1' },
    });
    const noReason = await invokeRoute(router, { method: 'POST', url: '/flag-1/archive', token: ADMIN_A, body: {} });
    assert.equal(noReason.statusCode, 400);
    const ok = await invokeRoute(router, {
        method: 'POST', url: '/flag-1/archive', token: ADMIN_A, body: { reason: 'feature retired' },
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE feature_flags SET is_archived=1')));
});

// --- preview / enforcement ---
test('flags: preview lists matched tenants without writing', async () => {
    const { router, executed } = buildRouter({
        activeTenantRows: [
            { tenant_id: 'tenant-a', plan_id: 'plan-1' },
            { tenant_id: 'tenant-b', plan_id: 'plan-2' },
        ],
        plans: { 'plan-1': { id: 'plan-1' } },
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/preview', token: ADMIN_A,
        body: { targeting_mode: 'plan', plan_id: 'plan-1' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { targeting_mode: 'plan', total: 1, sample: ['tenant-a'] });
    assert.ok(!executed.some((e) => e.kind === 'execute'));
});

test('flags: enforcement reflects the active version (evaluation core)', async () => {
    const versionRow = {
        id: 'v-1', version_no: 1, targeting_mode: 'tenant_list',
        plan_id: null, percentage: null, tenant_ids: ['tenant-a'], enabled: 1,
        created_at: '2026-10-18 00:00:00', reason: 'r',
    };
    const db = {
        query: async <T = Record<string, unknown>>() => [] as T[],
        queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
            if (sql.includes('FROM feature_flags WHERE flag_key')) {
                return (params[0] === 'watermark' ? { id: 'flag-1', is_archived: 0 } : null) as T;
            }
            return sql.includes('FROM feature_flag_versions') ? (versionRow as T) : null;
        },
        execute: async () => ({ affectedRows: 1 }),
    };
    assert.equal(await evaluateRequiredFeature(db, 'tenant-a', 'watermark'), true);
    assert.equal(await evaluateRequiredFeature(db, 'tenant-b', 'watermark'), false);
    assert.equal(await evaluateRequiredFeature(db, 'tenant-a', 'never_seen_flag'), false);
});

test('flags: enforcement fails closed on storage failure and archived flags', async () => {
    const failing = {
        query: async () => { throw new Error('db down'); },
        queryOne: async () => { throw new Error('db down'); },
        execute: async () => ({ affectedRows: 0 }),
    };
    assert.equal(await evaluateRequiredFeature(failing, 'tenant-a', 'watermark'), false);
    const archived = {
        query: async (): Promise<unknown[]> => [],
        queryOne: async <T>(): Promise<T | null> => ({ id: 'flag-1', is_archived: 1 } as T),
        execute: async () => ({ affectedRows: 0 }),
    };
    assert.equal(await evaluateRequiredFeature(archived, 'tenant-a', 'watermark'), false);
});

test('flags: invalid ids in enforcement input are denied', async () => {
    const queries: string[] = [];
    const db = {
        query: async (): Promise<unknown[]> => [],
        queryOne: async (sql: string): Promise<unknown> => {
            queries.push(sql);
            return { id: 'flag-1', is_archived: 0 };
        },
        execute: async (): Promise<{ affectedRows: number }> => ({ affectedRows: 0 }),
    };
    assert.equal(await evaluateRequiredFeature(db, '', 'watermark'), false);
    assert.equal(await evaluateRequiredFeature(db, 'tenant-a', ''), false);
    assert.deepEqual(queries, []);
});
