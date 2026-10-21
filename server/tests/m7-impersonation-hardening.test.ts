/**
 * M7 O6 hardening — hermetic regression tests for the impersonation approval
 * path.
 *
 * The defect under test: the route activated the session (pending -> active)
 * and wrote the audit BEFORE checking that a dedicated signing key existed,
 * then returned 200 with `impersonation_token: null` when the key was absent.
 * A failed audit after the transition left an ACTIVE, unaudited session.
 *
 * These tests drive the REAL router and the REAL service over an injected
 * transaction seam that models row locking (serialized critical section) and
 * rollback (row snapshot restore), so a mutation that is not inside the
 * transaction is observably not rolled back. No database, no network.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { NextFunction, Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    DEFAULT_IMPERSONATION_SECONDS,
    type ImpersonationSessionRow,
    type ImpersonationStore,
    type ImpersonationTransactionRunner,
    checkImpersonationSignature,
    createImpersonationService,
    createImpersonationVerifier,
    matchImpersonationPrincipal,
    parseImpersonationToken,
    signImpersonationToken,
} from '../src/services/impersonation';
import { createImpersonationRouter } from '../src/routes/impersonation';
import type { PlatformTargetRow } from '../src/routes/impersonation';
import { makeRepository, TEST_SECRET, tokenFor } from './helpers/m2-harness';

const FIXED_NOW = 1_700_000_000_000;
const SESSION_ID = 'sess-hardening-1';
const TEST_KEY = Buffer.alloc(32, 7);
const ADMIN_A = tokenFor({ id: 'support-a', role: 'admin', tv: 0 });
const ADMIN_B = tokenFor({ id: 'support-b', role: 'admin', tv: 0 });
const ADMIN_C = tokenFor({ id: 'support-c', role: 'admin', tv: 0 });

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

interface AuditEntry {
    action: string;
    actorUserId: string | null;
    resourceId: string;
    reason: string | null;
}

interface Fixture {
    rows: Map<string, ImpersonationSessionRow>;
    audits: AuditEntry[];
    notifications: string[];
    failAudit: boolean;
    /** Simulates a writer that lost the row between the lock and the UPDATE. */
    forceTransitionMiss: boolean;
    store: ImpersonationStore;
    transaction: ImpersonationTransactionRunner;
}

const pendingRow = (overrides: Partial<ImpersonationSessionRow> = {}): ImpersonationSessionRow => ({
    id: SESSION_ID,
    started_by: 'support-a',
    approved_by: null,
    target_user_id: 'target-1',
    tenant_id: 'tenant-a',
    reason: 'support investigation for an escalated ticket',
    scope: 'read',
    status: 'pending_approval',
    requested_seconds: DEFAULT_IMPERSONATION_SECONDS,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
});

/**
 * In-memory store plus a transaction runner with the same observable
 * contract as the production seam: the critical section is serialized
 * (equivalent to the FOR UPDATE row lock) and a throw restores the row
 * snapshot (equivalent to ROLLBACK). The transaction exposes the WHOLE store
 * plus the sealed audit, exactly like the production single-connection seam.
 */
const makeFixture = (): Fixture => {
    const rows = new Map<string, ImpersonationSessionRow>();
    const audits: AuditEntry[] = [];
    const notifications: string[] = [];
    let chain: Promise<void> = Promise.resolve();

    const fixture = {
        rows,
        audits,
        notifications,
        failAudit: false,
        forceTransitionMiss: false,
    } as Fixture;

    const snapshot = (): Map<string, ImpersonationSessionRow> =>
        new Map([...rows.entries()].map(([id, row]) => [id, { ...row }]));
    const restore = (saved: Map<string, ImpersonationSessionRow>): void => {
        rows.clear();
        for (const [id, row] of saved) rows.set(id, row);
    };

    const store: ImpersonationStore = {
        insertSession: async (row) => { rows.set(String(row.id), { ...row }); },
        findSession: async (sessionId) => {
            const row = rows.get(sessionId);
            return row ? { ...row } : null;
        },
        lockSession: async (sessionId) => {
            const row = rows.get(sessionId);
            return row ? { ...row } : null;
        },
        // The fixture's transaction serializes the critical section (the
        // hardening suite models FOR UPDATE through that runner), so the
        // target-row lock resolves once the current transaction settles.
        lockTargetUser: async (targetUserId) => ({ id: targetUserId }),
        transitionToActive: async (sessionId, approverId, expiresAt) => {
            if (fixture.forceTransitionMiss) return 0;
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
                .slice(0, Math.max(1, Math.min(100, Number(limit) || 50))),
        countActiveForTargetUser: async (targetUserId) =>
            [...rows.values()].filter((row) => String(row.target_user_id) === String(targetUserId)
                && (row.status === 'active' || row.status === 'pending_approval')).length,
    };

    const transaction: ImpersonationTransactionRunner = async (work) => {
        const previous = chain;
        let release: () => void = () => undefined;
        chain = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        const saved = snapshot();
        try {
            return await work({
                ...store,
                recordAudit: async (input) => {
                    if (fixture.failAudit) throw new Error('audit sink down');
                    audits.push({
                        action: input.action,
                        actorUserId: input.actorUserId,
                        resourceId: input.resourceId,
                        reason: input.reason ?? null,
                    });
                },
            });
        } catch (error) {
            restore(saved);
            throw error;
        } finally {
            release();
        }
    };

    fixture.store = store;
    fixture.transaction = transaction;
    return fixture;
};

interface RouterOptions {
    tokenKey?: () => Buffer | null | Promise<Buffer | null>;
    failAudit?: boolean;
    /** Overrides target resolution to model exact-tenant boundaries. */
    target?: (targetUserId: string, tenantId: string) => Promise<PlatformTargetRow | null>;
}

const buildRouter = (fixture: Fixture, options: RouterOptions = {}): Router => {
    fixture.failAudit = options.failAudit ?? false;
    return createImpersonationRouter({
        db: {
            query: async (): Promise<unknown[]> => [],
            queryOne: async (): Promise<unknown | null> => null,
            execute: async (): Promise<{ affectedRows: number }> => ({ affectedRows: 1 }),
        },
        store: fixture.store,
        authenticate: createAuthenticateToken(makeRepository({
            'support-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'support-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'support-c': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
        })),
        requirePlatformPermission: () => async (req, res, next) => {
            if (!(req as { user?: { id?: string } }).user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            next();
        },
        resolveTargetUser: options.target ?? (async (targetUserId) => ({
            userId: targetUserId, tenantId: 'tenant-a', role: 'instructor', isActive: true,
        })),
        isImpersonationManager: async () => false,
        tokenKey: options.tokenKey ?? (() => TEST_KEY),
        transaction: fixture.transaction,
        notify: async (event) => { fixture.notifications.push(event.kind); },
        now: () => new Date(FIXED_NOW),
        idFactory: () => SESSION_ID,
    });
};

const invoke = async (
    router: Router,
    request: { method: string; url: string; token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ statusCode?: number; body?: unknown }> => {
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

// ---------------------------------------------------------------------------
// Fail-closed signing prerequisites
// ---------------------------------------------------------------------------

test('approve fails closed when the signing key is missing: no activation, audit or token', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow());
    const router = buildRouter(fixture, { tokenKey: () => null });
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 503);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
    assert.equal(fixture.rows.get(SESSION_ID)?.approved_by, null);
    assert.equal(fixture.audits.length, 0);
    assert.equal(fixture.notifications.length, 0);
    assert.equal((response.body as { impersonation_token?: unknown }).impersonation_token, undefined);
});

test('approve fails closed when the signing key is too short', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow());
    const router = buildRouter(fixture, { tokenKey: () => Buffer.from('too-short') });
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 503);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
    assert.equal(fixture.audits.length, 0);
});

test('approve fails closed when the signing key is not dedicated (reuses the JWT secret)', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow());
    const router = buildRouter(fixture, { tokenKey: () => Buffer.from(TEST_SECRET, 'utf8') });
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 503);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
    assert.equal(fixture.audits.length, 0);
});

// ---------------------------------------------------------------------------
// Atomic approval + audit
// ---------------------------------------------------------------------------

test('a failed audit rolls the activation back instead of leaving an active unaudited session', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow());
    const router = buildRouter(fixture, { failAudit: true });
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 500);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
    assert.equal(fixture.rows.get(SESSION_ID)?.approved_by, null);
    assert.equal((response.body as { impersonation_token?: unknown }).impersonation_token, undefined);
    assert.equal(fixture.notifications.length, 0);
});

test('a signing provider that throws is treated as missing, not as success', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow());
    const router = buildRouter(fixture, {
        tokenKey: () => { throw new Error('secret store unavailable'); },
    });
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 503);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
    assert.equal(fixture.audits.length, 0);
});

// ---------------------------------------------------------------------------
// Race: simultaneous approval grants exactly once
// ---------------------------------------------------------------------------

test('simultaneous approvals grant exactly one activation, audit and token', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow({ requested_seconds: 300 }));
    const router = buildRouter(fixture);
    const [first, second] = await Promise.all([
        invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B }),
        invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_C }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(statuses, [200, 409]);
    const row = fixture.rows.get(SESSION_ID);
    assert.equal(row?.status, 'active');
    assert.ok(row?.approved_by === 'support-b' || row?.approved_by === 'support-c');
    const approvals = fixture.audits.filter((entry) => entry.action === 'impersonation.session_approved');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.resourceId, SESSION_ID);
    const tokens = [first, second]
        .map((response) => (response.body as { impersonation_token?: unknown }).impersonation_token)
        .filter((token): token is string => typeof token === 'string');
    assert.equal(tokens.length, 1);
    assert.equal(fixture.notifications.length, 1);
});

test('a guarded UPDATE that affects no row is a conflict: no audit, no token, no activation', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow());
    fixture.forceTransitionMiss = true;
    const router = buildRouter(fixture);
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 409);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');
    assert.equal(fixture.audits.length, 0);
    assert.equal(fixture.notifications.length, 0);
    assert.equal((response.body as { impersonation_token?: unknown }).impersonation_token, undefined);
});

// ---------------------------------------------------------------------------
// Valid approval: token binding
// ---------------------------------------------------------------------------

test('a valid approval activates once and mints a token bound to actor, target and session', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, pendingRow({ scope: 'write', requested_seconds: 600 }));
    const router = buildRouter(fixture);
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(response.statusCode, 200);
    const body = response.body as { status?: string; expires_at?: string; impersonation_token?: unknown };
    assert.equal(body.status, 'active');
    assert.equal(typeof body.impersonation_token, 'string');
    const token = body.impersonation_token as string;
    assert.ok(token.length > 0);

    const context = parseImpersonationToken(token);
    assert.ok(context);
    assert.equal(context?.sessionId, SESSION_ID);
    assert.equal(context?.actorUserId, 'support-a');
    assert.equal(context?.targetUserId, 'target-1');
    assert.equal(context?.tenantId, 'tenant-a');
    assert.equal(context?.scope, 'write');
    assert.equal(context?.banner.impersonated, true);
    assert.equal(checkImpersonationSignature(token, TEST_KEY), true);

    assert.equal(new Date(body.expires_at ?? '').getTime() - FIXED_NOW, 600_000);
    const approvals = fixture.audits.filter((entry) => entry.action === 'impersonation.session_approved');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.actorUserId, 'support-b');
    assert.deepEqual(fixture.notifications, ['session_started']);

    const verifier = createImpersonationVerifier({
        store: fixture.store,
        tokenKey: () => TEST_KEY,
        now: () => new Date(FIXED_NOW),
    });
    const verdict = await verifier(token);
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.deepEqual(verdict.context, context);
});

// ---------------------------------------------------------------------------
// Verified context: expiry, revoke, row mismatch, foreign principal
// ---------------------------------------------------------------------------

const activeRow = (overrides: Partial<ImpersonationSessionRow> = {}): ImpersonationSessionRow => pendingRow({
    status: 'active',
    approved_by: 'support-b',
    expires_at: new Date(FIXED_NOW + 600_000).toISOString(),
    ...overrides,
});

const makeVerifier = (store: ImpersonationStore) => createImpersonationVerifier({
    store,
    tokenKey: () => TEST_KEY,
    now: () => new Date(FIXED_NOW),
});

test('the verifier rejects an expired session even with a valid signature', async () => {
    const fixture = makeFixture();
    const expired = activeRow({ expires_at: new Date(FIXED_NOW - 1000).toISOString() });
    fixture.rows.set(SESSION_ID, expired);
    const token = signImpersonationToken(expired, false, TEST_KEY, FIXED_NOW);
    assert.equal(checkImpersonationSignature(token, TEST_KEY), true);
    assert.deepEqual(await makeVerifier(fixture.store)(token), { ok: false, reason: 'expired' });
});

test('the verifier rejects a revoked session immediately (live row check)', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow({ status: 'revoked', revoked_at: new Date(FIXED_NOW).toISOString(), revoked_by: 'support-b' }));
    const token = signImpersonationToken(activeRow(), false, TEST_KEY, FIXED_NOW);
    assert.deepEqual(await makeVerifier(fixture.store)(token), { ok: false, reason: 'not_active' });
});

test('the verifier rejects a token whose actor/target/tenant no longer matches the row', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow());
    const foreignRow = activeRow({ target_user_id: 'target-2' });
    const token = signImpersonationToken(foreignRow, false, TEST_KEY, FIXED_NOW);
    assert.deepEqual(await makeVerifier(fixture.store)(token), { ok: false, reason: 'row_mismatch' });

    const tenantToken = signImpersonationToken(activeRow({ tenant_id: 'tenant-z' }), false, TEST_KEY, FIXED_NOW);
    assert.deepEqual(await makeVerifier(fixture.store)(tenantToken), { ok: false, reason: 'row_mismatch' });
});

test('the verifier rejects a token whose signed scope disagrees with the live row', async () => {
    const fixture = makeFixture();
    // A WRITE-flagged context over a live READ row: the row is authoritative,
    // so the context is refused instead of granting the wider scope.
    fixture.rows.set(SESSION_ID, activeRow({ scope: 'read' }));
    const writeFlagged = signImpersonationToken(activeRow({ scope: 'read' }), true, TEST_KEY, FIXED_NOW);
    assert.deepEqual(await makeVerifier(fixture.store)(writeFlagged), { ok: false, reason: 'row_mismatch' });

    // A READ-flagged token over a live WRITE row is refused the same way.
    fixture.rows.set(SESSION_ID, activeRow({ scope: 'write' }));
    const readFlagged = signImpersonationToken(activeRow({ scope: 'write' }), false, TEST_KEY, FIXED_NOW);
    assert.deepEqual(await makeVerifier(fixture.store)(readFlagged), { ok: false, reason: 'row_mismatch' });

    // A consistent write context still verifies (positive control).
    fixture.rows.set(SESSION_ID, activeRow({ scope: 'write' }));
    const writeToken = signImpersonationToken(activeRow({ scope: 'write' }), true, TEST_KEY, FIXED_NOW);
    const verdict = await makeVerifier(fixture.store)(writeToken);
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.context.scope, 'write');
});

test('a valid token only binds to its own support actor (never the target, never a foreign actor)', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow());
    const token = signImpersonationToken(activeRow(), false, TEST_KEY, FIXED_NOW);
    const verdict = await makeVerifier(fixture.store)(token);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;

    // The bearer must be the separately authenticated support ACTOR.
    assert.deepEqual(
        matchImpersonationPrincipal(verdict.context, { userId: 'support-a', tenantId: 'tenant-a' }),
        { ok: true },
    );
    // The TARGET's own credentials are a stolen context: support
    // impersonation never authenticates the target.
    assert.deepEqual(
        matchImpersonationPrincipal(verdict.context, { userId: 'target-1', tenantId: 'tenant-a' }),
        { ok: false, reason: 'actor_mismatch' },
    );
    // A different support actor cannot ride someone else's context.
    assert.deepEqual(
        matchImpersonationPrincipal(verdict.context, { userId: 'support-b', tenantId: 'tenant-a' }),
        { ok: false, reason: 'actor_mismatch' },
    );
    // The actor's own tenant scope must match the session tenant.
    assert.deepEqual(
        matchImpersonationPrincipal(verdict.context, { userId: 'support-a', tenantId: 'tenant-z' }),
        { ok: false, reason: 'tenant_mismatch' },
    );
    assert.deepEqual(
        matchImpersonationPrincipal(verdict.context, null),
        { ok: false, reason: 'unauthenticated' },
    );
});

test('the verifier fails closed when the signing key is unavailable or invalid', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow());
    const token = signImpersonationToken(activeRow(), false, TEST_KEY, FIXED_NOW);
    const missing = createImpersonationVerifier({
        store: fixture.store, tokenKey: () => null, now: () => new Date(FIXED_NOW),
    });
    assert.deepEqual(await missing(token), { ok: false, reason: 'store_error' });
    const invalid = createImpersonationVerifier({
        store: fixture.store, tokenKey: () => Buffer.from('short'), now: () => new Date(FIXED_NOW),
    });
    assert.deepEqual(await invalid(token), { ok: false, reason: 'signature' });
});

// ---------------------------------------------------------------------------
// R2 follow-up: start/revoke audit atomicity, races and boundary controls
// (server-impersonation-audit-followup-20261019-01)
// ---------------------------------------------------------------------------

const START_BODY = {
    target_user_id: 'target-1',
    tenant_id: 'tenant-a',
    reason: 'support ticket #42 needs verification',
    scope: 'read',
    duration_seconds: 600,
};

test('a support actor cannot start a session against their own user (route and service deny)', async () => {
    const fixture = makeFixture();
    const router = buildRouter(fixture);

    // Route level: refused before any target resolution or write.
    const routeResponse = await invoke(router, {
        method: 'POST', url: '/start', token: ADMIN_A,
        body: { ...START_BODY, target_user_id: 'support-a' },
    });
    assert.equal(routeResponse.statusCode, 400);
    assert.equal(fixture.rows.size, 0);
    assert.equal(fixture.audits.length, 0);

    // Service level (defense in depth if the route guard is ever bypassed):
    // refused inside the transaction, before the target-row lock.
    const service = createImpersonationService({
        store: fixture.store,
        now: () => new Date(FIXED_NOW),
        idFactory: () => SESSION_ID,
        transaction: fixture.transaction,
    });
    const serviceResult = await service.start('support-a', {
        targetUserId: 'support-a',
        tenantId: 'tenant-a',
        reason: START_BODY.reason,
        scope: 'read',
        durationSeconds: 600,
    });
    assert.deepEqual(serviceResult, { ok: false, reason: 'self_target' });
    assert.equal(fixture.rows.size, 0);
    assert.equal(fixture.audits.length, 0);
});

test('a failed audit rolls the start back instead of leaving a phantom pending session', async () => {
    const fixture = makeFixture();
    const router = buildRouter(fixture, { failAudit: true });
    const response = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(response.statusCode, 500);
    // The insert rolled back with the failed audit: no phantom request exists.
    assert.equal(fixture.rows.size, 0);
    assert.equal(fixture.audits.length, 0);
    assert.equal(fixture.notifications.length, 0);
});

test('a failed audit rolls the revoke back instead of leaving a revoked, unaudited row', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow());
    const router = buildRouter(fixture, { failAudit: true });
    const response = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_A });
    assert.equal(response.statusCode, 500);
    // Atomic rollback: the session is still active and nothing claims a
    // revocation that did not happen. The caller may retry.
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'active');
    assert.equal(fixture.rows.get(SESSION_ID)?.revoked_by, null);
    assert.equal(fixture.rows.get(SESSION_ID)?.revoked_at, null);
    assert.equal(fixture.audits.length, 0);
    assert.equal(fixture.notifications.length, 0);
});

test('simultaneous revokes revoke exactly once with exactly one audit', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow());
    const router = buildRouter(fixture);
    const [first, second] = await Promise.all([
        invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_A }),
        invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_B }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'revoked');
    const revocations = fixture.audits.filter((entry) => entry.action === 'impersonation.session_revoked');
    assert.equal(revocations.length, 1);
    assert.equal(fixture.notifications.length, 1);
});

test('a start retried for a target with a live session is refused inside the transaction', async () => {
    const fixture = makeFixture();
    const router = buildRouter(fixture);
    const first = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(first.statusCode, 201);
    const [retryA, retryB] = await Promise.all([
        invoke(router, { method: 'POST', url: '/start', token: ADMIN_B, body: START_BODY }),
        invoke(router, { method: 'POST', url: '/start', token: ADMIN_C, body: START_BODY }),
    ]);
    const statuses = [retryA.statusCode, retryB.statusCode].sort();
    assert.deepEqual(statuses, [409, 409]);
    assert.equal(fixture.rows.size, 1);
    assert.equal(fixture.audits.filter((entry) => entry.action === 'impersonation.session_requested').length, 1);
});

test('exact tenant boundary: a foreign-tenant target resolves to nothing and an unrelated actor cannot revoke', async () => {
    const fixture = makeFixture();
    fixture.rows.set(SESSION_ID, activeRow());
    const router = buildRouter(fixture, {
        target: async (targetUserId, tenantId) =>
            (tenantId === 'tenant-a'
                ? { userId: targetUserId, tenantId: 'tenant-a', role: 'instructor', isActive: true }
                : null) satisfies PlatformTargetRow | null,
    });
    const foreignTenant = await invoke(router, {
        method: 'POST', url: '/start', token: ADMIN_A,
        body: { ...START_BODY, tenant_id: 'tenant-z' },
    });
    assert.equal(foreignTenant.statusCode, 404);
    // Nothing was written: only the pre-seeded session row remains, untouched.
    assert.equal(fixture.rows.size, 1);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'active');
    assert.equal(fixture.rows.get(SESSION_ID)?.started_by, 'support-a');
    assert.equal(fixture.audits.filter((entry) => entry.action === 'impersonation.session_requested').length, 0);

    // ADMIN_C is neither the starter nor the approver and holds no manage
    // permission: the exact-actor boundary denies the revoke.
    const unrelated = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_C });
    assert.equal(unrelated.statusCode, 403);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'active');
    assert.equal(fixture.audits.filter((entry) => entry.action === 'impersonation.session_revoked').length, 0);

    // The starter (exact actor) still revokes their own session.
    const starter = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_A });
    assert.equal(starter.statusCode, 200);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'revoked');
    assert.equal(fixture.audits.filter((entry) => entry.action === 'impersonation.session_revoked').length, 1);
});

test('valid control: start, approve and revoke each commit their mutation and audit atomically', async () => {
    const fixture = makeFixture();
    const router = buildRouter(fixture);
    const started = await invoke(router, { method: 'POST', url: '/start', token: ADMIN_A, body: START_BODY });
    assert.equal(started.statusCode, 201);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'pending_approval');

    const approved = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/approve`, token: ADMIN_B });
    assert.equal(approved.statusCode, 200);
    assert.equal(typeof (approved.body as { impersonation_token?: unknown }).impersonation_token, 'string');
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'active');

    const revoked = await invoke(router, { method: 'POST', url: `/${SESSION_ID}/revoke`, token: ADMIN_A });
    assert.equal(revoked.statusCode, 200);
    assert.equal(fixture.rows.get(SESSION_ID)?.status, 'revoked');

    assert.deepEqual(
        fixture.audits.map((entry) => entry.action),
        ['impersonation.session_requested', 'impersonation.session_approved', 'impersonation.session_revoked'],
    );
    assert.deepEqual(fixture.notifications, ['session_started', 'session_ended']);
});
