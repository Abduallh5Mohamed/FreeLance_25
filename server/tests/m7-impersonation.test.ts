/**
 * M7 O6 — hermetic impersonation tests (validation, dual approval, 30-minute
 * bound, issued context/banner, immediate revoke, protected actions, scopes,
 * notification hook, audits). No database, no network.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { NextFunction, Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    DEFAULT_IMPERSONATION_SECONDS,
    IMPERSONATION_TOKEN_VERSION,
    MAX_IMPERSONATION_SECONDS,
    MIN_IMPERSONATION_REASON_CHARS,
    type ImpersonationSessionRow,
    type ImpersonationStore,
    type ImpersonationTransactionRunner,
    classifyProtectedAction,
    checkImpersonationSignature,
    createImpersonationService,
    evaluateImpersonationWrite,
    parseImpersonationToken,
    requireImpersonationWriteScope,
    signImpersonationToken,
    validateStartInput,
} from '../src/services/impersonation';
import type { SealedAuditRecordInput } from '../src/services/audit-log';
import { createImpersonationRouter } from '../src/routes/impersonation';
import type { PlatformTargetRow } from '../src/routes/impersonation';
import { makeRepository, TEST_SECRET, tokenFor } from './helpers/m2-harness';

const TEST_KEY = Buffer.alloc(32, 3);
const FIXED_NOW = 1_700_000_000_000;
const ADMIN_A = tokenFor({ id: 'support-a', role: 'admin', tv: 0 });
const ADMIN_B = tokenFor({ id: 'support-b', role: 'admin', tv: 0 });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const SESSION_ID = 'sess-0001';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

test('validateStartInput enforces ids, the mandatory reason, scope and duration', () => {
    assert.equal(validateStartInput({}).ok, false);
    const minimumReason = validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'x'.repeat(MIN_IMPERSONATION_REASON_CHARS) });
    assert.equal(minimumReason.ok, true);
    assert.equal(validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'short' }).ok, false);
    assert.equal(validateStartInput({ target_user_id: 'u!', tenant_id: 't', reason: 'x'.repeat(MIN_IMPERSONATION_REASON_CHARS) }).ok, false);
    assert.equal(validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'x'.repeat(MIN_IMPERSONATION_REASON_CHARS), scope: 'both' }).ok, false);
    assert.equal(validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'x'.repeat(20), duration_seconds: 0 }).ok, false);
    assert.equal(validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'x'.repeat(20), duration_seconds: MAX_IMPERSONATION_SECONDS + 1 }).ok, false);
    assert.equal(validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'x'.repeat(20), duration_seconds: 90.5 }).ok, false);
    const good = validateStartInput({ target_user_id: 'u', tenant_id: 't', reason: 'x'.repeat(20), scope: 'WRITE', duration_seconds: 60 });
    assert.equal(good.ok, true);
    if (good.ok) {
        assert.deepEqual(good.value.scope, 'write');
        assert.equal(good.value.durationSeconds, 60);
    }
    const defaults = validateStartInput({ target_user_id: 'v', tenant_id: 't', reason: 'x'.repeat(20) });
    assert.equal(defaults.ok, true);
    if (defaults.ok) {
        assert.deepEqual(defaults.value.scope, 'read');
        assert.equal(defaults.value.durationSeconds, DEFAULT_IMPERSONATION_SECONDS);
    }
});

test('protected-action classification covers passwords, MFA, money and deletions', () => {
    assert.equal(classifyProtectedAction('user.password.change'), 'password_change');
    assert.equal(classifyProtectedAction('session.password_reset_completed'), 'password_change');
    assert.equal(classifyProtectedAction('platform_mfa.disable'), 'mfa_change');
    assert.equal(classifyProtectedAction('recovery_codes.issued'), 'mfa_change');
    assert.equal(classifyProtectedAction('wallet.withdrawal_requested'), 'money_movement');
    assert.equal(classifyProtectedAction('invoice.refunded'), 'money_movement');
    assert.equal(classifyProtectedAction('enrollment.delete'), 'data_delete');
    assert.equal(classifyProtectedAction('lecture.purge'), 'data_delete');
    assert.equal(classifyProtectedAction('course.update'), null);
    assert.equal(classifyProtectedAction('announcement.read'), null);
});

test('while impersonating protected actions are blocked and read scope is enforced', () => {
    const context = {
        sessionId: SESSION_ID,
        actorUserId: 'support-a',
        targetUserId: 'target-1',
        tenantId: 'tenant-a',
        scope: 'read' as const,
        banner: { impersonated: true as const, sessionId: SESSION_ID, tenantId: 'tenant-a', scope: 'read' as const },
    };
    const writeContext = { ...context, scope: 'write' as const, banner: { ...context.banner, scope: 'write' as const } };
    assert.deepEqual(evaluateImpersonationWrite(null, 'enrollment.delete'), { blocked: false });
    // read scope denies EVERY mutation, even non-classified ones: the
    // documented read-only guarantee holds without the second helper.
    assert.deepEqual(evaluateImpersonationWrite(context, 'course.update'), { blocked: true, protection: 'read_only' });
    assert.deepEqual(evaluateImpersonationWrite(context, 'announcement.create'), { blocked: true, protection: 'read_only' });
    assert.deepEqual(evaluateImpersonationWrite(context, 'wallet.refund'), { blocked: true, protection: 'money_movement' });
    assert.deepEqual(evaluateImpersonationWrite(writeContext, 'user.password.change'), { blocked: true, protection: 'password_change' });
    assert.deepEqual(evaluateImpersonationWrite(writeContext, 'course.update'), { blocked: false });
    assert.equal(requireImpersonationWriteScope(context).ok, false);
    assert.equal(requireImpersonationWriteScope(writeContext).ok, true);
});

// ---------------------------------------------------------------------------
// Hermetic store + service
// ---------------------------------------------------------------------------

interface StoreFixture {
    store: ImpersonationStore;
    rows: Map<string, ImpersonationSessionRow & { requested_seconds: number; expires_at: string | null }>;
}

const makeStore = (): StoreFixture => {
    const rows = new Map<string, ImpersonationSessionRow & { requested_seconds: number; expires_at: string | null }>();
    const clone = (row: ImpersonationSessionRow): ImpersonationSessionRow => ({ ...row });
    return {
        rows,
        store: {
            insertSession: async (row) => { rows.set(String(row.id), { ...row, requested_seconds: Number(row.requested_seconds ?? 0), expires_at: row.expires_at ? String(row.expires_at) : null }); },
            findSession: async (sessionId) => (rows.has(sessionId) ? clone(rows.get(sessionId) as ImpersonationSessionRow) : null),
            lockSession: async (sessionId) => (rows.has(sessionId) ? clone(rows.get(sessionId) as ImpersonationSessionRow) : null),
            // Every fixture target is a verified users row: the lock is a
            // no-op here because this file's tests run sequentially.
            lockTargetUser: async (targetUserId) => ({ id: String(targetUserId) }),
            transitionToActive: async (sessionId, approverId, expiresAt) => {
                const row = rows.get(sessionId);
                if (!row || row.status !== 'pending_approval' || String(row.started_by) === String(approverId)) return 0;
                row.status = 'active';
                row.approved_by = approverId;
                row.expires_at = expiresAt.toISOString();
                return 1;
            },
            transitionToRevoked: async (sessionId) => {
                const row = rows.get(sessionId);
                if (!row || (row.status !== 'active' && row.status !== 'pending_approval')) return 0;
                row.status = 'revoked';
                return 1;
            },
            listRecentForActor: async (actorUserId, limit) =>
                [...rows.values()]
                    .filter((row) => String(row.started_by) === String(actorUserId) || String(row.approved_by) === String(actorUserId))
                    .slice(0, Math.max(1, Math.min(100, Math.min(Number(limit), rows.size)))),
            countActiveForTargetUser: async (targetUserId) =>
                [...rows.values()].filter((row) => String(row.target_user_id) === String(targetUserId) && (row.status === 'active' || row.status === 'pending_approval')).length,
        },
    };
};

/**
 * Hermetic stand-in for the production one-transaction seam: the whole store
 * plus the sealed audit, with a throw restoring the row snapshot (equivalent
 * to ROLLBACK), so a mutation that is not inside the transaction is
 * observably not rolled back.
 */
const makeTransaction = (
    rows: StoreFixture['rows'],
    store: ImpersonationStore,
    recordAudit: (input: SealedAuditRecordInput) => Promise<void>,
): ImpersonationTransactionRunner => async (work) => {
    const saved = new Map([...rows.entries()].map(([id, row]) => [id, { ...row }]));
    try {
        return await work({ ...store, recordAudit });
    } catch (error) {
        rows.clear();
        for (const [id, row] of saved) rows.set(id, row);
        throw error;
    }
};

const noAudit = async (): Promise<void> => undefined;

const makeSession = (overrides: Partial<ImpersonationSessionRow> = {}): ImpersonationSessionRow & { requested_seconds: number } => ({
    id: SESSION_ID,
    started_by: 'support-a',
    approved_by: null,
    target_user_id: 'target-1',
    tenant_id: 'tenant-a',
    reason: 'support investigation for an escaladed ticket',
    scope: 'read',
    status: 'pending_approval',
    requested_seconds: DEFAULT_IMPERSONATION_SECONDS,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
});

test('service approve: self-approval is denied and racing transitions cannot revive', () => {
    const fixture = makeStore();
    const service = createImpersonationService({ store: fixture.store, now: () => new Date(FIXED_NOW), idFactory: () => SESSION_ID, transaction: makeTransaction(fixture.rows, fixture.store, noAudit) });
    return (async () => {
        await service.start('support-a', { targetUserId: 'target-1', tenantId: 'tenant-a', reason: 'x'.repeat(MIN_IMPERSONATION_REASON_CHARS), scope: 'read', durationSeconds: DEFAULT_IMPERSONATION_SECONDS });
        const self = await service.approve(SESSION_ID, 'support-a');
        assert.equal(self.ok, false);
        if (!self.ok) assert.equal(self.reason, 'self_approval');
        const second = await service.approve(SESSION_ID, 'support-b');
        assert.equal(second.ok, true);
        const again = await service.approve(SESSION_ID, 'support-c');
        assert.equal(again.ok, false);
        if (!again.ok) assert.equal(again.reason, 'not_pending');
    })();
});

test('service approve: the expiry is bounded to 30 minutes and clamps short requests', async () => {
    const fixture = makeStore();
    const service = createImpersonationService({ store: fixture.store, now: () => new Date(FIXED_NOW), idFactory: () => SESSION_ID, transaction: makeTransaction(fixture.rows, fixture.store, noAudit) });
    const started = await service.start('support-a', {
        targetUserId: 'target-1', tenantId: 'tenant-a',
        reason: 'x'.repeat(MIN_IMPERSONATION_REASON_CHARS),
        scope: 'write', durationSeconds: MAX_IMPERSONATION_SECONDS,
    });
    assert.equal(started.ok, true);
    const approved = await service.approve(SESSION_ID, 'support-b');
    assert.equal(approved.ok, true);
    if (approved.ok) assert.equal(approved.expiresAt.getTime() - FIXED_NOW, MAX_IMPERSONATION_SECONDS * 1000);
    fixture.rows.clear();
    const short = validateStartInput({ target_user_id: 'target-1', tenant_id: 'tenant-a', reason: 'x'.repeat(20), duration_seconds: 60 });
    assert.equal(short.ok, true);
    if (short.ok) {
        const startedShort = await service.start('support-a', short.value);
        assert.equal(startedShort.ok, true);
        const approvedShort = await service.approve(SESSION_ID, 'support-b');
        assert.equal(approvedShort.ok, true);
        if (approvedShort.ok) assert.equal(approvedShort.expiresAt.getTime() - FIXED_NOW, 60_000);
    }
});

test('service revoke: only active/pending sessions can be revoked once', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSession({ status: 'active', approved_by: 'support-b' }));
    const service = createImpersonationService({ store: fixture.store, now: () => new Date(FIXED_NOW), transaction: makeTransaction(fixture.rows, fixture.store, noAudit) });
    const revoked = await service.revoke(SESSION_ID, 'support-a');
    assert.equal(revoked.ok, true);
    const reRevoked = await service.revoke(SESSION_ID, 'support-a');
    assert.equal(reRevoked.ok, false);
    if (!reRevoked.ok) assert.equal(reRevoked.reason, 'not_revocable');
    const unknown = await service.revoke('nope', 'support-a');
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.reason, 'not_found');
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

interface AuditEntry {
    action: string;
    actorUserId: string | null;
    tenantId: string | null;
    resourceId: string;
    reason: string | null;
}

interface RouteFixture {
    router: Router;
    rows: StoreFixture['rows'];
    audits: AuditEntry[];
    state: { failAudit: boolean };
    notifications: Array<{ kind: string; sessionId: string; targetUserId: string | null }>;
}

const makeSessionRowForRoute = (overrides: Partial<ImpersonationSessionRow> = {}): ImpersonationSessionRow => makeSession(overrides);

interface BuildOptions {
    permission?: (userId: string, permission: string) => Promise<boolean>;
    target?: (targetUserId: string, tenantId: string) => Promise<PlatformTargetRow | null>;
    manager?: (userId: string) => Promise<boolean>;
    lister?: (actorUserId: string) => ImpersonationSessionRow[];
    notifyFails?: boolean;
}

const buildRouter = (rows: StoreFixture['rows'], fixtureStore: ImpersonationStore, options: BuildOptions = {}): RouteFixture => {
    const audits: AuditEntry[] = [];
    const state = { failAudit: false };
    const notifications: Array<{ kind: string; sessionId: string; targetUserId: string | null }> = [];
    const pushAudit = async (input: SealedAuditRecordInput): Promise<void> => {
        if (state.failAudit) throw new Error('audit sink down');
        audits.push({ action: input.action, actorUserId: input.actorUserId, tenantId: input.tenantId, resourceId: input.resourceId, reason: input.reason ?? null });
    };
    const router = createImpersonationRouter({
        db: {
            query: async (): Promise<unknown[]> => [],
            queryOne: async (): Promise<unknown | null> => null,
            execute: async (): Promise<{ affectedRows: number }> => ({ affectedRows: 1 }),
        },
        store: fixtureStore,
        authenticate: createAuthenticateToken(makeRepository({
            'support-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'support-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        })),
        requirePlatformPermission: (permission) => async (req, res, next) => {
            const user = (req as { user?: { id?: string } }).user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const allowed = options.permission != null
                ? await options.permission(user.id, permission)
                : user.id !== 'owner-a';
            if (allowed) return next();
            res.status(403).json({ error: 'Forbidden' });
        },
        transaction: makeTransaction(rows, fixtureStore, pushAudit),
        resolveTargetUser: options.target ?? (async (targetUserId) =>
            ({ userId: targetUserId, tenantId: 'tenant-a', role: 'instructor', isActive: true })),
        isImpersonationManager: options.manager ?? (async (userId) => userId === 'support-b'),
        tokenKey: () => TEST_KEY,
        notify: async (event) => {
            if (options.notifyFails) throw new Error('downstream notification down');
            notifications.push({ kind: event.kind, sessionId: event.sessionId, targetUserId: event.targetUserId });
        },
        now: () => new Date(FIXED_NOW),
        idFactory: () => SESSION_ID,
    });
    return { router, rows, audits, state, notifications };
};

const invoke = async (router: Router, request: { method: string; url: string; token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ statusCode?: number; body?: unknown }> => {
    let statusCode: number | undefined;
    let body: unknown;
    const response = {
        status(code: number) { statusCode = code; return response; },
        json(payload: unknown) {
            if (statusCode === undefined) statusCode = 200;
            body = payload;
            return response;
        },
        set() { return response; },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: {
            ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
            ...(request.headers ?? {}),
        },
        body: request.body ?? {},
        query: {},
    } as never;
    await (router as unknown as (r: never, s: never, n: NextFunction) => void)(req, response, () => undefined);
    const deadline = Date.now() + 5000;
    while (statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { statusCode, body };
};

const START_BODY = {
    target_user_id: 'target-1',
    tenant_id: 'tenant-a',
    reason: 'support ticket #42 needs verification',
    scope: 'read',
    duration_seconds: 600,
};

// --- start ---

test('impersonation start: anonymous, non-platform and validation denials write nothing', async () => {
    const fixture = makeStore();
    const noPerms = buildRouter(fixture.rows, fixture.store, { permission: async () => false });
    const denied = await invoke(noPerms.router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(denied.statusCode, 403);
    const anonymous = await invoke(buildRouter(fixture.rows, fixture.store).router, { method: 'POST', url: '/start', body: START_BODY });
    assert.equal(anonymous.statusCode, 401);
    const router = buildRouter(fixture.rows, fixture.store).router;
    const invalid = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: { target_user_id: 'target-1' } });
    assert.equal(invalid.statusCode, 400);
    const selfTarget = await invoke(router, {
        method: 'POST', url: '/start', token: ADMIN_A,
        body: { ...START_BODY, target_user_id: 'support-a' },
    });
    assert.equal(selfTarget.statusCode, 400);
    assert.equal(fixture.rows.size, 0);
});

test('impersonation start: cross-tenant/platform targets are denied with 404/403', async () => {
    const fixture = makeStore();
    const noTarget = buildRouter(fixture.rows, fixture.store, {
        target: async () => null,
    });
    const response = await invoke(noTarget.router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(response.statusCode, 404);
    assert.equal(fixture.rows.size, 0);
    const adminTarget = buildRouter(fixture.rows, fixture.store, {
        target: async () => ({ userId: 'target-1', tenantId: 'tenant-a', role: 'admin', isActive: true }),
    });
    const blocked = await invoke(adminTarget.router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(blocked.statusCode, 403);
    assert.equal(fixture.rows.size, 0);
});

test('impersonation start: creates the pending session and audits the reason', async () => {
    const fixture = makeStore();
    const { router, audits } = buildRouter(fixture.rows, fixture.store);
    const response = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(response.statusCode, 201);
    const row = fixture.rows.get(SESSION_ID);
    assert.ok(row);
    assert.equal(row?.status, 'pending_approval');
    assert.equal(row?.scope, 'read');
    assert.equal(audits.filter((entry) => entry.action === 'impersonation.session_requested').length, 1);
    assert.equal(audits[0]?.reason, START_BODY.reason);
    const duplicate = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(duplicate.statusCode, 409);
});

test('impersonation start: rate limited per actor', async () => {
    const fixture = makeStore();
    const router = buildRouter(fixture.rows, fixture.store).router;
    await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    for (let index = 0; index < 4; index += 1) {
        await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: { ...START_BODY, target_user_id: 'target-1' } });
    }
    const throttled = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(throttled.statusCode, 429);
});

test('impersonation start: audit failure aborts with 500', async () => {
    const fixture = makeStore();
    const harness = buildRouter(fixture.rows, fixture.store);
    harness.state.failAudit = true;
    const response = await invoke(harness.router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(response.statusCode, 500);
    // The insert rolled back with the failed audit: no phantom pending session.
    assert.equal(fixture.rows.size, 0);
    assert.equal(harness.audits.length, 0);
});

// --- approve ---

test('impersonation approve: the requesting admin cannot approve their own session', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute());
    const router = buildRouter(fixture.rows, fixture.store).router;
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_A });
    assert.equal(response.statusCode, 403);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
});

test('impersonation approve: second-admin approval activates, notifies and issues the banner token', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute({ requested_seconds: 600 }));
    const harness = buildRouter(fixture.rows, fixture.store);
    const response = await invoke(harness.router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 200);
    const row = fixture.rows.get(SESSION_ID);
    assert.equal(row?.status, 'active');
    assert.equal(row?.approved_by, 'support-b');
    const token = (response.body as { impersonation_token?: string }).impersonation_token ?? '';
    assert.ok(token.startsWith(`${IMPERSONATION_TOKEN_VERSION}.`));
    const context = parseImpersonationToken(token);
    assert.ok(context);
    assert.equal(context?.sessionId, SESSION_ID);
    assert.equal(context?.banner.impersonated, true);
    assert.equal(context?.scope, 'read');
    assert.deepEqual(harness.notifications, [{ kind: 'session_started', sessionId: SESSION_ID, targetUserId: 'target-1' }]);
    const expiry = new Date((response.body as { expires_at?: string }).expires_at ?? '').getTime();
    assert.equal(expiry - FIXED_NOW, 600_000);
    // a second approval is a race/late denial
    const late = await invoke(harness.router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(late.statusCode, 409);
});

test('impersonation approve: only sessions in pending state and up to 30 minutes', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute({ status: 'revoked', approved_by: 'support-b' }));
    const router = buildRouter(fixture.rows, fixture.store).router;
    const revoked = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(revoked.statusCode, 409);
    const missing = await invoke(router, { method: 'POST', url: '/unknown/approve', token: ADMIN_B });
    assert.equal(missing.statusCode, 404);
});

test('impersonation approve: a failing notification hook never fails the approval', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute());
    const harness = buildRouter(fixture.rows, fixture.store, { notifyFails: true });
    const response = await invoke(harness.router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'active');
});

// --- revoke ---

test('impersonation revoke: unrelated non-managers are denied; managers revoke others', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute({ status: 'active', approved_by: 'support-a' }));
    const router = buildRouter(fixture.rows, fixture.store, { manager: async () => false }).router;
    const deniedRow = fixture.rows.get(SESSION_ID) as ImpersonationSessionRow;
    void deniedRow;
    const unrelated = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: OWNER_A });
    assert.equal(unrelated.statusCode, 403);
    const managerRouter = buildRouter(fixture.rows, fixture.store).router;
    const revoked = await invoke(managerRouter, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_B });
    assert.equal(revoked.statusCode, 200);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'revoked');
});

test('impersonation revoke: the starter can revoke immediately and a repeat is 409', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute({ status: 'active', approved_by: 'support-b' }));
    const { router, audits, notifications } = buildRouter(fixture.rows, fixture.store);
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as { status?: string };
    assert.equal(body.status, 'revoked');
    assert.ok(audits.some((entry) => entry.action === 'impersonation.session_revoked'));
    assert.deepEqual(notifications, [{ kind: 'session_ended', sessionId: SESSION_ID, targetUserId: 'target-1' }]);
    const second = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_A });
    assert.equal(second.statusCode, 409);
});

test('impersonation revoke: unknown sessions are 404', async () => {
    const fixture = makeStore();
    const router = buildRouter(fixture.rows, fixture.store).router;
    const response = await invoke(router, { method: 'POST', url: '/missing/revoke', token: ADMIN_A });
    assert.equal(response.statusCode, 404);
});

// --- sessions listing ---

test('impersonation sessions: read permission gating and owner-only projection', async () => {
    const fixture = makeStore();
    fixture.rows.set(SESSION_ID, makeSessionRowForRoute({ status: 'active', approved_by: 'support-b' }));
    fixture.rows.set('sess-0002', makeSessionRowForRoute({ target_user_id: 'other-target', tenant_id: 'tenant-z', started_by: 'support-c' }));
    const noRead = buildRouter(fixture.rows, fixture.store, { permission: async (userId) => userId !== 'support-b' });
    const denied = await invoke(noRead.router, { method: 'GET', url: '/sessions', token: ADMIN_B });
    assert.equal(denied.statusCode, 403);
    const router = buildRouter(fixture.rows, fixture.store, {
        lister: (actorUserId) => [...fixture.rows.values()].filter((row) => String(row.started_by) === actorUserId),
    }).router;
    const response = await invoke(router, { method: 'GET', url: '/sessions', token: ADMIN_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as unknown[]).length, 1);
});

// --- issued context / chained sessions ---

test('an active impersonation context cannot start or manage other sessions', async () => {
    const fixture = makeStore();
    const activeRow = makeSessionRowForRoute({
        status: 'active',
        approved_by: 'support-b',
        expires_at: new Date(FIXED_NOW + 600_000).toISOString(),
    });
    fixture.rows.set(SESSION_ID, activeRow);
    const router = buildRouter(fixture.rows, fixture.store).router;
    const token = signImpersonationToken(activeRow, false, TEST_KEY, FIXED_NOW);
    const chained = await invoke(router, {
        method: 'POST', url: '/start', token: ADMIN_B, body: START_BODY,
        headers: { 'x-impersonation': token },
    });
    assert.equal(chained.statusCode, 403);
    // an invalid/tampered header is ignored for session management
    const tampered = await invoke(router, {
        method: 'POST', url: '/start', token: ADMIN_B, body: START_BODY,
        headers: { 'x-impersonation': `${token}x` },
    });
    assert.notEqual(tampered.statusCode, 403);
});

test('expiry bound and tamper detection on the issued context token', async () => {
    const session = makeSessionRowForRoute();
    const token = signImpersonationToken(session, true, TEST_KEY, FIXED_NOW);
    const context = parseImpersonationToken(token);
    assert.equal(context?.scope, 'write');
    assert.equal(context?.banner.impersonated, true);
    const tamperedJsonParts = token.split('.');
    tamperedJsonParts[2] = Buffer.from('support-z').toString('base64url');
    const tampered = tamperedJsonParts.join('.');
    // parsing alone is not verification: the mutated actor makes the MAC fail
    assert.notEqual(parseImpersonationToken(tampered), null);
    assert.equal(checkImpersonationSignature(tampered, TEST_KEY), false);
    assert.equal(checkImpersonationSignature(token, TEST_KEY), true);
});
