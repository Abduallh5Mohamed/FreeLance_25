/**
 * M7 O6 server integration — concurrency and request-context enforcement.
 *
 * Part 1 (concurrent starts): a count+insert inside ONE transaction does not
 * prevent two simultaneous starts. Two separate transaction runners, each over
 * its own store seam, interleave on a shared session table; the target users
 * row must serialize them. The fixture below models the production contract
 * exactly:
 *  - two transactions are INDEPENDENT runners (no global mutex); only the
 *    per-target users-row lock serializes them,
 *  - `lockTargetUser` blocks while another transaction holds the row
 *    (SELECT ... FOR UPDATE), and COMMIT/ROLLBACK releases it,
 *  - a throw inside a transaction restores the row snapshot (ROLLBACK).
 *
 * Part 2 (request-context enforcement): a real Express router chain mirrors
 * server/src/index.ts order (shared auth guard -> context enforcement ->
 * business routers) and is driven end-to-end for the allow/deny matrix. The
 * bearer of an impersonated request is the support ACTOR (`started_by`); the
 * actor's live platform permission is re-checked from server rows on EVERY
 * context request (withdrawal denies the next request with the business
 * handler untouched; a store failure fails closed); the effective TARGET
 * principal is resolved SERVER-SIDE (the real
 * `resolveImpersonationTargetPrincipal` over an injected repository); and
 * the signed scope must match the live session row. The matrix covers:
 * anonymous, forged actor, stolen context (target's own credentials), wrong
 * support actor, actor tenant mismatch, actor permission revoked or
 * unreadable, target deactivated/membership-revoked on the next request,
 * cross-tenant, revoked, expired, unapproved, scope/row mismatch,
 * read-mutation deny, protected GET deny and the valid-read actor positive.
 * No database, no network.
 *
 * Part 3 (production ordering): server/src/index.ts must mount the
 * enforcement immediately after the shared /api guard chain and BEFORE every
 * business router, and the opaque-token parent path must explicitly reject a
 * presented header. The order is asserted from the real source file AND the
 * assembled chain is driven end-to-end so a misordered mount cannot silently
 * let an unauthorized context reach a handler.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler } from 'express';
import {
    type ImpersonationSessionRow,
    type ImpersonationStore,
    type ImpersonationTransactionRunner,
    createImpersonationService,
    createImpersonationVerifier,
    signImpersonationToken,
} from '../src/services/impersonation';
import type { SealedAuditRecordInput } from '../src/services/audit-log';
import { createOptionalAuth, resolveImpersonationTargetPrincipal } from '../src/middleware/auth';
import type { AuthRequest } from '../src/middleware/auth';
import {
    type ActorPermissionCheck,
    type ImpersonationVerifier,
    createImpersonationContextMiddleware,
    enforceImpersonationAction,
    evaluateImpersonationRequest,
    matchesPathPrefix,
    rejectImpersonationHeader,
} from '../src/middleware/impersonation-context';
import { makeRepository, TEST_SECRET, tokenFor } from './helpers/m2-harness';
import type { RepositoryOptions, UsersFixture } from './helpers/m2-harness';

const FIXED_NOW = 1_700_000_000_000;
const TEST_KEY = Buffer.alloc(32, 5);
const SESSION_ID = 'sess-int-1';
const ADMIN_A = tokenFor({ id: 'support-a', role: 'admin', tv: 0 });
const ADMIN_B = tokenFor({ id: 'support-b', role: 'admin', tv: 0 });
const SUPPORT_I = tokenFor({ id: 'support-i', role: 'instructor', tv: 0, tenant_id: 'tenant-z' });
const TARGET_A = tokenFor({ id: 'target-1', role: 'teacher', tv: 0, tenant_id: 'tenant-a' });
const TARGET_B = tokenFor({ id: 'target-2', role: 'teacher', tv: 0, tenant_id: 'tenant-z' });

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
}

interface LockedTargetRow {
    id: string;
    /** Models the lock being held until COMMIT/ROLLBACK of the transaction. */
    release: () => void;
}

interface ConcurrencyStore extends ImpersonationStore {
    lockTargetUser: (targetUserId: string) => Promise<LockedTargetRow | null>;
}

interface ConcurrencyFixture {
    rows: Map<string, ImpersonationSessionRow>;
    audits: AuditEntry[];
    /** Deepest number of transactions inside the count phase at once. */
    maxInFlight: number;
    store: ImpersonationStore;
    transaction: ImpersonationTransactionRunner;
}

/**
 * `concurrentCounts` is the number of count queries the barrier holds before
 * releasing them TOGETHER: it models the database interleaving where two
 * `SELECT COUNT` statements are both in flight before either INSERT lands
 * (the real race a per-transaction count cannot survive). A count whose
 * partner never arrives — because the partner is blocked on the target row
 * lock — is released alone by the turn timer, so the lock owner can never
 * deadlock against its own barrier.
 */
const makeConcurrencyFixture = (options: { concurrentCounts: number } = { concurrentCounts: 2 }): ConcurrencyFixture => {
    const concurrentCounts = options.concurrentCounts;
    const rows = new Map<string, ImpersonationSessionRow>();
    const audits: AuditEntry[] = [];
    const knownTargets = new Set(['target-1', 'target-2']);
    const lockTails = new Map<string, Promise<void>>();

    let inFlight = 0;
    let pendingCounts = 0;
    let countWaiters: Array<() => void> = [];
    let soloTimer: ReturnType<typeof setTimeout> | null = null;
    const fixture = { rows, audits, maxInFlight: 0 } as ConcurrencyFixture;

    const flushCounts = (): void => {
        pendingCounts = 0;
        const waiting = countWaiters;
        countWaiters = [];
        if (soloTimer !== null) {
            clearTimeout(soloTimer);
            soloTimer = null;
        }
        for (const release of waiting) release();
    };

    /** Releases once `concurrentCounts` counts are pending, or alone after a turn. */
    const countBarrier = (): Promise<void> => {
        pendingCounts += 1;
        if (pendingCounts >= concurrentCounts) {
            flushCounts();
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            countWaiters.push(resolve);
            if (soloTimer === null) {
                soloTimer = setTimeout(() => flushCounts(), 0);
            }
        });
    };

    const acquireTargetLock = async (targetUserId: string): Promise<LockedTargetRow> => {
        const previous = lockTails.get(targetUserId) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // The next caller waits for the current holder AND our own gate.
        lockTails.set(targetUserId, previous.then(() => held));
        await previous;
        return { id: targetUserId, release };
    };

    const recordAudit = async (input: SealedAuditRecordInput): Promise<void> => {
        audits.push({ action: input.action, actorUserId: input.actorUserId, resourceId: input.resourceId });
    };

    const baseStore: ConcurrencyStore = {
        insertSession: async (row) => { rows.set(String(row.id), { ...row }); },
        findSession: async (sessionId) => {
            const row = rows.get(sessionId);
            return row ? { ...row } : null;
        },
        lockSession: async (sessionId) => {
            const row = rows.get(sessionId);
            return row ? { ...row } : null;
        },
        transitionToActive: async () => 0,
        transitionToRevoked: async () => 0,
        listRecentForActor: async () => [],
        countActiveForTargetUser: async (targetUserId) => {
            // The count is the in-flight query both racing transactions run
            // before either can insert.
            inFlight += 1;
            fixture.maxInFlight = Math.max(fixture.maxInFlight, inFlight);
            try {
                await countBarrier();
                return [...rows.values()].filter((row) =>
                    String(row.target_user_id) === String(targetUserId)
                    && (row.status === 'active' || row.status === 'pending_approval')).length;
            } finally {
                inFlight -= 1;
            }
        },
        lockTargetUser: async (targetUserId) => {
            if (!knownTargets.has(targetUserId)) return null;
            return acquireTargetLock(targetUserId);
        },
    };

    const transaction: ImpersonationTransactionRunner = async (work) => {
        const acquired: Array<() => void> = [];
        const saved = new Map([...rows.entries()].map(([id, row]) => [id, { ...row }]));
        const txStore: ImpersonationStore = {
            ...baseStore,
            lockTargetUser: async (targetUserId) => {
                const locked = await baseStore.lockTargetUser(targetUserId);
                if (locked) acquired.push(locked.release);
                return locked ? { id: locked.id } : null;
            },
        };
        try {
            return await work({ ...txStore, recordAudit });
        } catch (error) {
            rows.clear();
            for (const [id, row] of saved) rows.set(id, row);
            throw error;
        } finally {
            // COMMIT/ROLLBACK release every row lock the transaction took.
            for (const release of acquired) release();
        }
    };

    fixture.store = baseStore;
    fixture.transaction = transaction;
    return fixture;
};

const startInput = (targetUserId: string, scope: 'read' | 'write' = 'read') => ({
    targetUserId,
    tenantId: 'tenant-a',
    reason: 'support ticket #42 needs verification',
    scope,
    durationSeconds: 600,
});

const makeService = (fixture: ConcurrencyFixture) => {
    let counter = 0;
    return createImpersonationService({
        store: fixture.store,
        now: () => new Date(FIXED_NOW),
        idFactory: () => `sess-${(counter += 1)}`,
        transaction: fixture.transaction,
    });
};

const outcomeOf = (result: { ok: true } | { ok: false; reason: string }): string =>
    result.ok ? 'ok' : result.reason;

// ---------------------------------------------------------------------------
// Concurrent duplicate starts must serialize on the locked target row
// ---------------------------------------------------------------------------

test('two simultaneous starts for one target open exactly one session (locked target row serializes them)', async () => {
    const fixture = makeConcurrencyFixture();
    const service = makeService(fixture);

    // Two SEPARATE transactions, interleaved at every await point.
    const [first, second] = await Promise.all([
        service.start('support-a', startInput('target-1')),
        service.start('support-b', startInput('target-1')),
    ]);

    assert.deepEqual(
        [outcomeOf(first), outcomeOf(second)].sort(),
        ['ok', 'target_active_session'],
        'exactly one start may succeed; the loser must be refused inside the transaction',
    );
    assert.equal(fixture.rows.size, 1, 'exactly one session row may exist for the target');
    assert.equal(fixture.audits.length, 1, 'exactly one requested audit may be written');
    assert.equal(
        fixture.rows.get(fixture.audits[0].resourceId)?.status,
        'pending_approval',
        'the single surviving row is the one that was audited',
    );
    // The loser never reached its own count while the winner held the row
    // lock: this is row serialization, not a lucky ordering.
    assert.equal(fixture.maxInFlight, 1, 'the critical section must hold at most one transaction');
});

test('starts for different targets are NOT serialized by the target-row lock', async () => {
    const fixture = makeConcurrencyFixture();
    const service = makeService(fixture);

    const [first, second] = await Promise.all([
        service.start('support-a', startInput('target-1')),
        service.start('support-b', startInput('target-2')),
    ]);

    // Both targets are verified rows with their own locks: neither waits.
    assert.equal(outcomeOf(first), 'ok');
    assert.equal(outcomeOf(second), 'ok');
    assert.equal(fixture.rows.size, 2);
    assert.equal(fixture.audits.length, 2);
    assert.equal(fixture.maxInFlight, 2, 'independent targets must run concurrently (no global mutex)');
});

test('a start for a target whose verified row disappeared fails closed inside the transaction', async () => {
    const fixture = makeConcurrencyFixture();
    const service = makeService(fixture);

    const result = await service.start('support-a', startInput('ghost-user'));

    assert.deepEqual(result, { ok: false, reason: 'target_not_lockable' });
    assert.equal(fixture.rows.size, 0, 'nothing may be inserted for a target that cannot be locked');
    assert.equal(fixture.audits.length, 0);
});

test('an existing live session (active or pending) still blocks a later start after the lock', async () => {
    const fixture = makeConcurrencyFixture();
    const service = makeService(fixture);

    const first = await service.start('support-a', startInput('target-1'));
    assert.equal(outcomeOf(first), 'ok');

    const pending = startInput('target-1');
    const raceA = service.start('support-b', pending);
    const raceB = service.start('support-c', pending);
    const [a, b] = await Promise.all([raceA, raceB]);

    assert.deepEqual([outcomeOf(a), outcomeOf(b)].sort(), ['target_active_session', 'target_active_session']);
    assert.equal(fixture.rows.size, 1);
    assert.equal(fixture.audits.length, 1);
});

test('a start against the actor own user is refused before any write', async () => {
    const fixture = makeConcurrencyFixture();
    const service = makeService(fixture);

    // The bearer of a context is the actor and the effective principal is the
    // target; a self-target row would make the two indistinguishable, so the
    // service refuses it inside the transaction before the lock.
    const result = await service.start('target-1', startInput('target-1'));

    assert.deepEqual(result, { ok: false, reason: 'self_target' });
    assert.equal(fixture.rows.size, 0);
    assert.equal(fixture.audits.length, 0);
});

// ---------------------------------------------------------------------------
// Part 2: request-context enforcement through the shared auth flow
// ---------------------------------------------------------------------------

const ACTIVE_ROW = (overrides: Partial<ImpersonationSessionRow> = {}): ImpersonationSessionRow => ({
    id: SESSION_ID,
    started_by: 'support-a',
    approved_by: 'support-b',
    target_user_id: 'target-1',
    tenant_id: 'tenant-a',
    reason: 'integration verification of the context middleware',
    scope: 'read',
    status: 'active',
    requested_seconds: 600,
    expires_at: new Date(FIXED_NOW + 600_000).toISOString(),
    revoked_at: null,
    revoked_by: null,
    ...overrides,
});

const makeSessionStore = (rows: Map<string, ImpersonationSessionRow>): ImpersonationStore => ({
    insertSession: async (row) => { rows.set(String(row.id), { ...row }); },
    findSession: async (sessionId) => {
        const row = rows.get(sessionId);
        return row ? { ...row } : null;
    },
    lockSession: async (sessionId) => {
        const row = rows.get(sessionId);
        return row ? { ...row } : null;
    },
    lockTargetUser: async (targetUserId) => ({ id: targetUserId }),
    transitionToActive: async () => 0,
    transitionToRevoked: async () => 0,
    listRecentForActor: async () => [],
    countActiveForTargetUser: async () => 0,
});

const membership = (tenantId: string) => ({ tenant_id: tenantId, instructor_id: null, group_id: null, grade_id: null });

/**
 * Mutable identity fixture: the injected repository reads these objects on
 * every call, so a test can deactivate the target or drop a membership and
 * prove the NEXT request fails closed.
 */
interface AuthFixture {
    users: Record<string, UsersFixture>;
    options: RepositoryOptions;
    repository: ReturnType<typeof makeRepository>;
}

const makeAuthFixture = (): AuthFixture => {
    const users: Record<string, UsersFixture> = {
        'support-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
        'support-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
        'support-i': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'target-1': { is_active: 1, token_version: 0, suspension_active: 0, role: 'teacher' },
        'target-2': { is_active: 1, token_version: 0, suspension_active: 0, role: 'teacher' },
    };
    const options: RepositoryOptions = {
        memberships: {
            'support-i': [membership('tenant-z')],
            'target-1': [membership('tenant-a'), membership('tenant-z')],
            'target-2': [membership('tenant-z')],
        },
        instructorAccounts: {
            'support-i': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
    };
    return { users, options, repository: makeRepository(users, options) };
};

/** Minimal request for the billing-path gate inside the real resolver. */
const FAKE_RESOLVER_REQUEST = { method: 'GET', originalUrl: '/api/students' } as unknown as Request;

/**
 * Mirrors server/src/index.ts order for the /api surface: the shared
 * optionalAuth guard resolves the bearer principal from server-side rows,
 * THEN the impersonation context enforcement runs (with the REAL server-side
 * effective-principal resolver and the live actor-permission recheck),
 * THEN business routers.
 */
const buildEnforcementApp = (
    rows: Map<string, ImpersonationSessionRow>,
    fixture: AuthFixture = makeAuthFixture(),
    options: { tokenKey?: () => Buffer; actorPermission?: ActorPermissionCheck } = {},
): {
    router: Router;
    managementTouched: () => boolean;
    fixture: AuthFixture;
    businessTouched: () => number;
    permissionCalls: () => string[];
} => {
    const store = makeSessionStore(rows);
    const verifier: ImpersonationVerifier = createImpersonationVerifier({
        store,
        tokenKey: options.tokenKey ?? (() => TEST_KEY),
        now: () => new Date(FIXED_NOW),
    });

    // The live actor-permission seam: every consulted actor id is recorded
    // so tests can prove the recheck happens per context request (and only
    // then). Production binds the same seam to
    // `hasVerifiedPlatformPermission('impersonation.start', actorUserId)`.
    const permissionCalls: string[] = [];
    const actorPermission: ActorPermissionCheck = options.actorPermission
        ?? (async (actorUserId: string) => { permissionCalls.push(actorUserId); return true; });

    const router = Router();
    router.use(createOptionalAuth(fixture.repository));
    router.use(createImpersonationContextMiddleware({
        verifier,
        checkActorPermission: actorPermission,
        resolveEffectivePrincipal: async (targetUserId, tenantId) => {
            const outcome = await resolveImpersonationTargetPrincipal(
                targetUserId, tenantId, FAKE_RESOLVER_REQUEST, fixture.repository,
            );
            return outcome.ok ? outcome.user : null;
        },
    }));

    const business = Router();
    const businessHits = { count: 0 };
    business.get('/students', (req: AuthRequest, res) => {
        businessHits.count += 1;
        res.json({
            ok: true,
            impersonated: req.impersonation?.banner.impersonated ?? false,
            sessionId: req.impersonation?.sessionId ?? null,
            actorUserId: req.impersonation?.actorUserId ?? null,
            targetUserId: req.impersonation?.targetUserId ?? null,
            scope: req.impersonation?.scope ?? null,
            // The EFFECTIVE principal: the session target, resolved
            // server-side — never the authenticated support actor.
            principalId: req.user?.id ?? null,
            principalRole: req.user?.role ?? null,
            principalTenant: req.user?.tenantId ?? null,
        });
    });
    business.get('/courses/:id', (req, res) => { res.json({ ok: true, course: req.params.id }); });
    business.post('/students', (req, res) => { res.json({ ok: true, mutating: true }); });
    business.delete('/exams/:id', (req, res) => { res.json({ ok: true, deleted: req.params.id }); });
    business.post('/students/:id/password', (req, res) => { res.json({ ok: true }); });
    business.get('/audit-logs', (req, res) => { res.json({ ok: true }); });
    business.get('/auth/me', (req, res) => { res.json({ ok: true }); });
    business.get('/files/:id', (req, res) => { res.json({ ok: true }); });
    business.get('/expenses', (req, res) => { res.json({ ok: true }); });
    // Adopter-declared stable action ids (the opt-in write scope needs).
    business.post('/gradebook/:id/entries', enforceImpersonationAction(() => 'gradebook.entry_create'), (req, res) => {
        res.json({ ok: true, mutating: true });
    });
    business.get('/students/:id/security-review', enforceImpersonationAction(() => 'user.password.change'), (req, res) => {
        res.json({ ok: true });
    });
    router.use('/api', business);

    const managementTouched = { hit: false };
    const management = Router();
    management.post('/start', (req, res) => {
        managementTouched.hit = true;
        res.json({ ok: true });
    });
    router.use('/api/platform/impersonation', management);

    router.use((req, res) => { res.status(404).json({ error: 'Route not found' }); });
    return {
        router,
        managementTouched: () => managementTouched.hit,
        fixture,
        businessTouched: () => businessHits.count,
        permissionCalls: () => [...permissionCalls],
    };
};

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
    set(): CapturedResponse;
}

const request = async (
    router: Router,
    options: { method: string; url: string; token?: string; impersonation?: string },
): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
        set() { return response; },
    };
    const req = {
        method: options.method,
        url: options.url,
        originalUrl: options.url,
        headers: {
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(options.impersonation !== undefined ? { 'x-impersonation': options.impersonation } : {}),
        },
        body: {},
        query: {},
    } as never;
    await (router as unknown as (r: never, s: never, n: NextFunction) => void)(req, response, () => undefined);
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const bodyOf = (response: CapturedResponse): { code?: string; reason?: string; protection?: string; error?: string } & Record<string, unknown> =>
    (response.body ?? {}) as { code?: string; reason?: string; protection?: string; error?: string } & Record<string, unknown>;

const withActiveRow = (overrides: Partial<ImpersonationSessionRow> = {}): { rows: Map<string, ImpersonationSessionRow>; token: string } => {
    const rows = new Map<string, ImpersonationSessionRow>();
    const row = ACTIVE_ROW(overrides);
    rows.set(SESSION_ID, row);
    return { rows, token: signImpersonationToken(row, row.scope === 'write', TEST_KEY, FIXED_NOW) };
};

test('a request presenting x-impersonation without authentication is denied 401, not downgraded', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);
    const response = await request(app.router, { method: 'GET', url: '/api/students', impersonation: token });
    assert.equal(response.statusCode, 401);
    assert.equal(bodyOf(response).code, 'IMPERSONATION_UNAUTHENTICATED');
});

test('a forged actor (wrong signing key) is rejected without leaking session existence', async () => {
    const { rows } = withActiveRow();
    const app = buildEnforcementApp(rows);
    const forged = signImpersonationToken(ACTIVE_ROW(), false, Buffer.alloc(32, 9), FIXED_NOW);
    const response = await request(app.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: forged });
    assert.equal(response.statusCode, 403);
    // Signature fails before any row read: the denial does not reveal whether
    // the session id exists.
    assert.equal(bodyOf(response).code, 'IMPERSONATION_INVALID');
    assert.equal(bodyOf(response).reason, 'signature');
});

test('a valid context presented with the target credentials is a stolen context and denied', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    // The TARGET user's own token presenting the actor's context: support
    // impersonation never authenticates the target, so this is refused.
    const stolen = await request(app.router, { method: 'GET', url: '/api/students', token: TARGET_A, impersonation: token });
    assert.equal(stolen.statusCode, 403);
    assert.equal(bodyOf(stolen).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(stolen).reason, 'actor_mismatch');

    // A different target's credentials are refused the same way: the bearer
    // must be the session's own support actor, never any target user.
    const otherTarget = await request(app.router, { method: 'GET', url: '/api/students', token: TARGET_B, impersonation: token });
    assert.equal(otherTarget.statusCode, 403);
    assert.equal(bodyOf(otherTarget).reason, 'actor_mismatch');
});

test('a valid context replayed by a DIFFERENT support actor is denied', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    // support-b was not the actor who started the session: even a verified
    // platform principal cannot ride someone else's context.
    const otherActor = await request(app.router, { method: 'GET', url: '/api/students', token: ADMIN_B, impersonation: token });
    assert.equal(otherActor.statusCode, 403);
    assert.equal(bodyOf(otherActor).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(otherActor).reason, 'actor_mismatch');
});

test('an actor whose own tenant scope differs from the session tenant is denied', async () => {
    // support-i started (and is bound to) a session in tenant-a, but the
    // authenticated principal's live membership resolves to tenant-z.
    const { rows, token } = withActiveRow({ started_by: 'support-i' });
    const app = buildEnforcementApp(rows);
    const response = await request(app.router, { method: 'GET', url: '/api/students', token: SUPPORT_I, impersonation: token });
    assert.equal(response.statusCode, 403);
    assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(response).reason, 'tenant_mismatch');
});

test('a target that is not an active member of the session tenant is denied', async () => {
    // target-1 is a member of tenant-a and tenant-z only; the session claims
    // tenant-q, so the server-side effective-principal resolution fails.
    const { rows, token } = withActiveRow({ tenant_id: 'tenant-q' });
    const app = buildEnforcementApp(rows);
    const response = await request(app.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(response.statusCode, 403);
    assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(response).reason, 'tenant_mismatch');
});

test('a revoked session stops working on the very next request', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    const first = await request(app.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(first.statusCode, 200);
    assert.equal(bodyOf(first).impersonated, true);

    const row = rows.get(SESSION_ID) as ImpersonationSessionRow;
    row.status = 'revoked';
    row.revoked_at = new Date(FIXED_NOW + 1_000).toISOString();
    row.revoked_by = 'support-b';

    const second = await request(app.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(second.statusCode, 403);
    assert.equal(bodyOf(second).code, 'IMPERSONATION_INVALID');
    assert.equal(bodyOf(second).reason, 'not_active');
});

test('an expired or unapproved session can never serve a request', async () => {
    const expired = withActiveRow({ expires_at: new Date(FIXED_NOW - 1_000).toISOString() });
    const expiredResponse = await request(buildEnforcementApp(expired.rows).router, {
        method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: expired.token,
    });
    assert.equal(expiredResponse.statusCode, 403);
    assert.equal(bodyOf(expiredResponse).reason, 'expired');

    const unapproved = withActiveRow({ status: 'pending_approval', approved_by: null });
    const unapprovedResponse = await request(buildEnforcementApp(unapproved.rows).router, {
        method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: unapproved.token,
    });
    assert.equal(unapprovedResponse.statusCode, 403);
    assert.equal(bodyOf(unapprovedResponse).code, 'IMPERSONATION_INVALID');
    assert.equal(bodyOf(unapprovedResponse).reason, 'not_active');
});

test('a read context cannot mutate: protected actions blocked, then the read-only scope, then no write opt-in', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    // Protected action classification outranks the scope evaluation.
    const deleted = await request(app.router, { method: 'DELETE', url: '/api/exams/exam-1', token: ADMIN_A, impersonation: token });
    assert.equal(deleted.statusCode, 403);
    assert.equal(bodyOf(deleted).code, 'IMPERSONATION_BLOCKED');
    assert.equal(bodyOf(deleted).protection, 'data_delete');

    const password = await request(app.router, { method: 'POST', url: '/api/students/target-1/password', token: ADMIN_A, impersonation: token });
    assert.equal(password.statusCode, 403);
    assert.equal(bodyOf(password).protection, 'password_change');

    // Non-protected mutation under read scope: blocked as read_only.
    const created = await request(app.router, { method: 'POST', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(created.statusCode, 403);
    assert.equal(bodyOf(created).code, 'IMPERSONATION_BLOCKED');
    assert.equal(bodyOf(created).protection, 'read_only');

    // Write scope: the action gate passes but no route opted in, so the
    // initial integration stays read-only and the mutation is refused.
    const write = withActiveRow({ scope: 'write' });
    const writeApp = buildEnforcementApp(write.rows);
    const writeCreate = await request(writeApp.router, { method: 'POST', url: '/api/students', token: ADMIN_A, impersonation: write.token });
    assert.equal(writeCreate.statusCode, 403);
    assert.equal(bodyOf(writeCreate).code, 'IMPERSONATION_SCOPE');
    assert.equal(bodyOf(writeCreate).reason, 'mutation_not_enabled');
});

test('protected GET surfaces are always denied, and benign reads outside the allowlist are denied too', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    for (const url of ['/api/audit-logs', '/api/auth/me', '/api/files/private-1']) {
        const response = await request(app.router, { method: 'GET', url, token: ADMIN_A, impersonation: token });
        assert.equal(response.statusCode, 403, url);
        assert.equal(bodyOf(response).code, 'IMPERSONATION_SCOPE', url);
        assert.equal(bodyOf(response).reason, 'path_denied', url);
    }

    // A benign but unlisted read surface is denied by default.
    const unlisted = await request(app.router, { method: 'GET', url: '/api/expenses', token: ADMIN_A, impersonation: token });
    assert.equal(unlisted.statusCode, 403);
    assert.equal(bodyOf(unlisted).reason, 'path_not_allowed');
});

test('a valid read context serves allowlisted reads with the actor/effective-principal distinction', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    // The bearer is the support ACTOR; the served principal is the TARGET.
    const students = await request(app.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(students.statusCode, 200);
    const body = bodyOf(students);
    assert.equal(body.impersonated, true);
    assert.equal(body.sessionId, SESSION_ID);
    // The support ACTOR and the effective TARGET principal stay distinct.
    assert.equal(body.actorUserId, 'support-a');
    assert.equal(body.targetUserId, 'target-1');
    assert.equal(body.scope, 'read');
    // The effective principal is the session TARGET resolved server-side
    // (id, role and tenant all come from the target's own live rows) — never
    // the authenticated support actor.
    assert.equal(body.principalId, 'target-1');
    assert.equal(body.principalRole, 'teacher');
    assert.equal(body.principalTenant, 'tenant-a');

    const childPath = await request(app.router, { method: 'GET', url: '/api/courses/course-9', token: ADMIN_A, impersonation: token });
    assert.equal(childPath.statusCode, 200);
});

test('a target deactivated or unsubscribed after the session started fails closed on the next request', async () => {
    const { rows, token } = withActiveRow();
    const { router, fixture } = buildEnforcementApp(rows);

    const first = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(first.statusCode, 200);

    // The target account is deactivated: the server-side resolution of the
    // effective principal now fails, so the NEXT request is denied even
    // though the session row itself is untouched.
    fixture.users['target-1'].is_active = 0;
    const second = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(second.statusCode, 403);
    assert.equal(bodyOf(second).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(second).reason, 'target_identity_unavailable');

    // Reactivated but no longer a member of the session tenant: denied too.
    fixture.users['target-1'].is_active = 1;
    fixture.options.memberships!['target-1'] = [membership('tenant-z')];
    const third = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(third.statusCode, 403);
    assert.equal(bodyOf(third).reason, 'tenant_mismatch');
});

test('the actor must STILL hold the verified platform permission on every context request', async () => {
    const { rows, token } = withActiveRow();
    let permitted = true;
    const calls: string[] = [];
    const { router, businessTouched } = buildEnforcementApp(rows, undefined, {
        actorPermission: async (actorUserId: string) => { calls.push(actorUserId); return permitted; },
    });

    // True actor positive: the live recheck passes and the allowlisted read
    // is served with the actor/effective-principal distinction intact.
    const first = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(first.statusCode, 200);
    assert.equal(bodyOf(first).impersonated, true);
    assert.equal(bodyOf(first).principalId, 'target-1');
    assert.deepEqual(calls, ['support-a'], 'the live recheck must consult the authenticated actor id');
    assert.equal(businessTouched(), 1);

    // The starter actor's verified platform permission is removed while the
    // actor's user row, token version, the target identity and the session
    // row all stay live and unchanged: the NEXT request is denied and the
    // business handler never runs.
    permitted = false;
    const second = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(second.statusCode, 403);
    assert.equal(bodyOf(second).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(second).reason, 'actor_permission_revoked');
    assert.equal(businessTouched(), 1, 'the business handler must be untouched after the denial');
    assert.deepEqual(calls, ['support-a', 'support-a'], 'every context request re-reads the live permission');

    // Restoring the permission revives the context: the denial was a live
    // recheck, not a one-shot invalidation.
    permitted = true;
    const third = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(third.statusCode, 200);
    assert.equal(businessTouched(), 2);
});

test('a store failure while rechecking the actor permission fails closed', async () => {
    const { rows, token } = withActiveRow();
    const { router, businessTouched } = buildEnforcementApp(rows, undefined, {
        actorPermission: async () => { throw new Error('admin_role_permissions unavailable'); },
    });

    const response = await request(router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: token });
    assert.equal(response.statusCode, 403);
    assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(response).reason, 'actor_permission_unavailable');
    assert.equal(businessTouched(), 0, 'the business handler must never run when the permission store fails');
});

test('a context whose signed scope disagrees with the live session row is denied', async () => {
    // Signed as a WRITE context while the live row is read: the live row is
    // authoritative and the context is refused before any handler runs.
    const { rows } = withActiveRow({ scope: 'read' });
    const readRow = rows.get(SESSION_ID) as ImpersonationSessionRow;
    const writeFlagged = signImpersonationToken(readRow, true, TEST_KEY, FIXED_NOW);
    const readApp = buildEnforcementApp(rows);
    const reversed = await request(readApp.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: writeFlagged });
    assert.equal(reversed.statusCode, 403);
    assert.equal(bodyOf(reversed).code, 'IMPERSONATION_INVALID');
    assert.equal(bodyOf(reversed).reason, 'row_mismatch');
    assert.equal(readApp.businessTouched(), 0);

    // The opposite direction (read-flagged token over a write row) is
    // refused the same way.
    const write = withActiveRow({ scope: 'write' });
    const writeRow = write.rows.get(SESSION_ID) as ImpersonationSessionRow;
    const readFlagged = signImpersonationToken(writeRow, false, TEST_KEY, FIXED_NOW);
    const writeApp = buildEnforcementApp(write.rows);
    const mismatch = await request(writeApp.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: readFlagged });
    assert.equal(mismatch.statusCode, 403);
    assert.equal(bodyOf(mismatch).reason, 'row_mismatch');
    assert.equal(writeApp.businessTouched(), 0);

    // A consistent write context still passes every gate (positive control).
    const consistent = signImpersonationToken(writeRow, true, TEST_KEY, FIXED_NOW);
    const ok = await request(writeApp.router, { method: 'GET', url: '/api/students', token: ADMIN_A, impersonation: consistent });
    assert.equal(ok.statusCode, 200);
    assert.equal(bodyOf(ok).scope, 'write');
});

test('ordinary non-impersonated requests never consult the actor permission recheck', async () => {
    const { rows, token } = withActiveRow();
    const { router } = buildEnforcementApp(rows, undefined, {
        actorPermission: async () => { throw new Error('must not be consulted'); },
    });

    // No header -> the request is ordinary: the live permission recheck is
    // never part of its path, with or without a bearer.
    const authenticated = await request(router, { method: 'GET', url: '/api/students', token: TARGET_A });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(bodyOf(authenticated).impersonated, false);

    const anonymous = await request(router, { method: 'GET', url: '/api/students' });
    assert.equal(anonymous.statusCode, 200);
    assert.equal(bodyOf(anonymous).impersonated, false);
    void token;
});

test('ordinary non-impersonated requests are unchanged with or without a bearer', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    const authenticated = await request(app.router, { method: 'GET', url: '/api/students', token: TARGET_A });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(bodyOf(authenticated).impersonated, false);
    assert.equal(bodyOf(authenticated).principalId, 'target-1');

    // The enforcement adds no authentication requirement of its own.
    const anonymous = await request(app.router, { method: 'GET', url: '/api/students' });
    assert.equal(anonymous.statusCode, 200);
    assert.equal(bodyOf(anonymous).impersonated, false);

    // A malformed (non-string) header is an assertion of impersonation and is
    // refused rather than ignored.
    const duplicated = await request(app.router, {
        method: 'GET', url: '/api/students', token: TARGET_A,
        impersonation: ['a', 'b'] as unknown as string,
    });
    assert.equal(duplicated.statusCode, 403);
    assert.equal(bodyOf(duplicated).reason, 'malformed');
    void token;
});

test('a verified context can never manage impersonation sessions', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);
    const response = await request(app.router, {
        method: 'POST', url: '/api/platform/impersonation/start', token: ADMIN_A, impersonation: token,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(response).reason, 'management_namespace');
    // The management handler was never reached.
    assert.equal(app.managementTouched(), false);
});

test('route-adopted action ids gate their own mutations without touching ordinary requests', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);

    // A protected action id is blocked even on a safe GET route.
    const blocked = await request(app.router, {
        method: 'GET', url: '/api/students/target-1/security-review', token: ADMIN_A, impersonation: token,
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(bodyOf(blocked).code, 'IMPERSONATION_BLOCKED');
    assert.equal(bodyOf(blocked).protection, 'password_change');

    // Write scope with a non-protected adopted action passes the route gate
    // (the request-level gate still refuses the actual mutation).
    const write = withActiveRow({ scope: 'write' });
    const writeApp = buildEnforcementApp(write.rows);
    const writeResponse = await request(writeApp.router, {
        method: 'POST', url: '/api/gradebook/gb-1/entries', token: ADMIN_A, impersonation: write.token,
    });
    assert.equal(writeResponse.statusCode, 403);
    assert.equal(bodyOf(writeResponse).code, 'IMPERSONATION_SCOPE');

    // Without a context the same route is an ordinary request.
    const ordinary = await request(writeApp.router, { method: 'POST', url: '/api/gradebook/gb-1/entries', token: TARGET_A });
    assert.equal(ordinary.statusCode, 200);
});

test('the pure evaluation mirrors the middleware matrix and the prefix boundary', async () => {
    const { rows, token } = withActiveRow();
    const store = makeSessionStore(rows);
    const verifier: ImpersonationVerifier = createImpersonationVerifier({
        store, tokenKey: () => TEST_KEY, now: () => new Date(FIXED_NOW),
    });
    const actorPrincipal = { userId: 'support-a', tenantId: null };
    const resolveEffectivePrincipal = async (targetUserId: string, tenantId: string) => (
        targetUserId === 'target-1' && tenantId === 'tenant-a'
            ? { id: 'target-1', email: null, phone: null, role: 'teacher', tenantId: 'tenant-a' }
            : null
    );

    const absent = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: undefined, method: 'GET', path: '/api/students',
    });
    assert.deepEqual(absent, { ok: true, context: null });

    const ok = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: token, method: 'GET', path: '/api/students',
        resolveEffectivePrincipal, checkActorPermission: async () => true,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.context?.sessionId, SESSION_ID);
        assert.equal(ok.context?.actorUserId, 'support-a');
        assert.equal(ok.effectivePrincipal?.id, 'target-1');
        assert.equal(ok.effectivePrincipal?.tenantId, 'tenant-a');
    }

    // The live actor-permission recheck is part of the contract: without the
    // seam (or with a false verdict / a throwing store) a presented context
    // can never be served.
    const noPermissionSeam = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: token, method: 'GET', path: '/api/students',
        resolveEffectivePrincipal,
    });
    assert.equal(noPermissionSeam.ok, false);
    if (!noPermissionSeam.ok) assert.equal(noPermissionSeam.reason, 'actor_permission_unavailable');

    const revokedPermission = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: token, method: 'GET', path: '/api/students',
        resolveEffectivePrincipal, checkActorPermission: async () => false,
    });
    assert.equal(revokedPermission.ok, false);
    if (!revokedPermission.ok) assert.equal(revokedPermission.reason, 'actor_permission_revoked');

    const failingStore = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: token, method: 'GET', path: '/api/students',
        resolveEffectivePrincipal,
        checkActorPermission: async () => { throw new Error('admin_user_roles unavailable'); },
    });
    assert.equal(failingStore.ok, false);
    if (!failingStore.ok) assert.equal(failingStore.reason, 'actor_permission_unavailable');

    // Without the server-side resolver seam a presented context can never
    // be served (the live actor-permission recheck passes first).
    const noResolver = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: token, method: 'GET', path: '/api/students',
        checkActorPermission: async () => true,
    });
    assert.equal(noResolver.ok, false);
    if (!noResolver.ok) assert.equal(noResolver.reason, 'target_identity_unavailable');

    // A target identity that no longer resolves denies the request (the
    // live actor-permission recheck passes first).
    const deadTarget = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, header: token, method: 'GET', path: '/api/students',
        resolveEffectivePrincipal: async () => null,
        checkActorPermission: async () => true,
    });
    assert.equal(deadTarget.ok, false);
    if (!deadTarget.ok) assert.equal(deadTarget.reason, 'target_identity_unavailable');

    const unknownSession = await evaluateImpersonationRequest({
        verifier, principal: actorPrincipal, resolveEffectivePrincipal,
        header: signImpersonationToken(ACTIVE_ROW({ id: 'sess-missing' }), false, TEST_KEY, FIXED_NOW),
        method: 'GET', path: '/api/students',
    });
    assert.equal(unknownSession.ok, false);
    if (!unknownSession.ok) assert.equal(unknownSession.reason, 'not_active');

    // Segment-boundary prefix matching: a sibling surface that merely starts
    // with the same letters is not covered by the prefix.
    assert.equal(matchesPathPrefix('/api/attendance', '/api/attendance'), true);
    assert.equal(matchesPathPrefix('/api/attendance/session-1', '/api/attendance'), true);
    assert.equal(matchesPathPrefix('/api/attendance-records', '/api/attendance'), false);
});

test('the target cannot ride the actor context with target credentials, and a foreign actor cannot either', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);
    for (const bearer of [TARGET_A, TARGET_B, ADMIN_B]) {
        const response = await request(app.router, { method: 'GET', url: '/api/students', token: bearer, impersonation: token });
        assert.equal(response.statusCode, 403, bearer);
        assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED');
        assert.equal(bodyOf(response).reason, 'actor_mismatch');
    }
});

test('the default action id derives from method and path for protected classification', async () => {
    const { rows, token } = withActiveRow();
    const app = buildEnforcementApp(rows);
    // DELETE through an allowlisted prefix must classify as data_delete.
    const response = await request(app.router, { method: 'DELETE', url: '/api/students/target-1', token: ADMIN_A, impersonation: token });
    assert.equal(response.statusCode, 403);
    assert.equal(bodyOf(response).protection, 'data_delete');
});

// ---------------------------------------------------------------------------
// Part 3: production ordering (server/src/index.ts)
// ---------------------------------------------------------------------------

const indexSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

const GUARD_MOUNT = "app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary)";
const ENFORCEMENT_MOUNT = 'app.use(enforceImpersonationContext)';
const PARENT_REJECT_MOUNT = "app.use('/api/parent', (req: Request, res: Response, next: NextFunction) => rejectImpersonationHeader(req, res, next))";
const PARENT_VIEWS_MOUNT = "app.use('/api/parent', parentViewsRoutes)";
const MANAGEMENT_MOUNT = "app.use('/api/platform/impersonation', impersonationRoutes)";
/**
 * Business routers that were mounted BEFORE the enforcement despite its
 * comment (the defect this task corrects): a presented context reached their
 * handlers without ever being verified.
 */
const EARLIER_BUSINESS_MOUNTS = [
    "app.use('/api/parent-links', parentLinksRoutes)",
    "app.use('/api/notification-consent', notificationConsentRoutes)",
    "app.use('/api/lesson-discussions', lessonDiscussionsRoutes)",
    "app.use('/api/search', searchRoutes)",
    "app.use('/api/tenant-exports', tenantExportRoutes)",
    "app.use('/api/platform/mfa', platformMfaRoutes)",
];

test('index.ts mounts the enforcement after the shared guard and BEFORE every business router', () => {
    const guard = indexSource.indexOf(GUARD_MOUNT);
    assert.ok(guard > 0, 'the shared /api guard chain must exist');
    const enforcement = indexSource.indexOf(ENFORCEMENT_MOUNT);
    assert.ok(enforcement > guard, 'the enforcement must follow the shared guard chain');
    assert.equal(indexSource.split(ENFORCEMENT_MOUNT).length - 1, 1, 'the enforcement mounts exactly once');
    for (const mount of EARLIER_BUSINESS_MOUNTS) {
        const at = indexSource.indexOf(mount);
        assert.ok(at > 0, `${mount} must exist`);
        assert.ok(at > enforcement, `${mount} must mount AFTER the enforcement`);
    }
    // The management surface stays behind the enforcement too.
    const management = indexSource.indexOf(MANAGEMENT_MOUNT);
    assert.ok(management > enforcement, 'management must stay after the enforcement');
});

test('index.ts mounts the opaque parent path with an explicit impersonation rejection', () => {
    const parentReject = indexSource.indexOf(PARENT_REJECT_MOUNT);
    const parentViews = indexSource.indexOf(PARENT_VIEWS_MOUNT);
    assert.ok(parentReject > 0, 'the parent path must reject a presented impersonation header explicitly');
    assert.ok(parentViews > 0, 'the parent views router must be mounted');
    // The rejection runs before the views router on the same mount.
    assert.ok(parentReject < parentViews, 'the rejection must precede the parent views router');
    // The parent path stays BEFORE the shared JWT guard (opaque tokens), so it
    // can never verify a context itself.
    assert.ok(parentViews < indexSource.indexOf(GUARD_MOUNT), 'the parent path stays before the shared guard');
});

/**
 * Assembles the chain in the production order (extracted from index.ts) with
 * the REAL guard + enforcement + parent rejection and stand-in business
 * routers, and drives it end-to-end. An unauthorized context on ANY surface —
 * including the ones previously mounted before the enforcement — can never
 * reach a handler.
 */
const buildAssembledChain = (
    rows: Map<string, ImpersonationSessionRow>,
    options: { actorPermission?: ActorPermissionCheck } = {},
): { router: Router; reached: string[] } => {
    const fixture = makeAuthFixture();
    const store = makeSessionStore(rows);
    const verifier: ImpersonationVerifier = createImpersonationVerifier({
        store, tokenKey: () => TEST_KEY, now: () => new Date(FIXED_NOW),
    });
    const reached: string[] = [];
    const standIn = (name: string): RequestHandler => (_req, res) => {
        reached.push(name);
        res.json({ ok: true, surface: name });
    };

    const app = Router();
    // Production order (see index.ts): the opaque parent path with its
    // explicit rejection, then the shared guard, then the enforcement, then
    // every business router. The live actor-permission recheck is part of
    // the enforcement exactly as production wires it.
    app.use('/api/parent', rejectImpersonationHeader);
    app.use('/api/parent', standIn('parent'));
    app.use('/api', createOptionalAuth(fixture.repository));
    app.use(createImpersonationContextMiddleware({
        verifier,
        checkActorPermission: options.actorPermission ?? (async () => true),
        resolveEffectivePrincipal: async (targetUserId, tenantId) => {
            const outcome = await resolveImpersonationTargetPrincipal(
                targetUserId, tenantId, FAKE_RESOLVER_REQUEST, fixture.repository,
            );
            return outcome.ok ? outcome.user : null;
        },
    }));
    app.use('/api/platform/impersonation', standIn('management'));
    for (const [path, name] of [
        ['/api/parent-links', 'parent-links'],
        ['/api/notification-consent', 'notification-consent'],
        ['/api/lesson-discussions', 'lesson-discussions'],
        ['/api/search', 'search'],
        ['/api/tenant-exports', 'tenant-exports'],
        ['/api/platform/mfa', 'platform-mfa'],
    ] as const) {
        app.use(path, standIn(name));
    }
    return { router: app, reached };
};

test('an unauthorized context cannot reach the handler of any previously-earlier route', async () => {
    const { rows, token } = withActiveRow();
    const forged = signImpersonationToken(ACTIVE_ROW(), false, Buffer.alloc(32, 9), FIXED_NOW);
    const paths = ['/api/parent-links', '/api/notification-consent', '/api/lesson-discussions', '/api/search', '/api/tenant-exports', '/api/platform/mfa'];

    for (const path of paths) {
        // Forged signature: denied before any handler runs.
        const badSignature = buildAssembledChain(rows);
        const deniedSignature = await request(badSignature.router, { method: 'GET', url: path, token: ADMIN_A, impersonation: forged });
        assert.equal(deniedSignature.statusCode, 403, path);
        assert.equal(bodyOf(deniedSignature).reason, 'signature', path);
        assert.deepEqual(badSignature.reached, [], `${path} handler must not run for a forged context`);

        // Wrong actor (the target's own credentials): denied before any handler.
        const wrongActor = buildAssembledChain(rows);
        const deniedActor = await request(wrongActor.router, { method: 'GET', url: path, token: TARGET_A, impersonation: token });
        assert.equal(deniedActor.statusCode, 403, path);
        assert.equal(bodyOf(deniedActor).reason, 'actor_mismatch', path);
        assert.deepEqual(wrongActor.reached, [], `${path} handler must not run for a wrong-actor context`);
    }
});

test('a cryptographically valid context whose actor lost the platform permission cannot reach any handler', async () => {
    const { rows, token } = withActiveRow();
    const paths = ['/api/parent-links', '/api/notification-consent', '/api/lesson-discussions', '/api/search', '/api/tenant-exports', '/api/platform/mfa', '/api/students'];

    for (const path of paths) {
        const app = buildAssembledChain(rows, { actorPermission: async () => false });
        const response = await request(app.router, { method: 'GET', url: path, token: ADMIN_A, impersonation: token });
        assert.equal(response.statusCode, 403, path);
        assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED', path);
        assert.equal(bodyOf(response).reason, 'actor_permission_revoked', path);
        assert.deepEqual(app.reached, [], `${path} handler must not run once the actor permission is withdrawn`);
    }
});

test('the assembled production chain still serves ordinary requests on every surface', async () => {
    const { rows } = withActiveRow();
    const app = buildAssembledChain(rows);

    // Ordinary (no header) requests reach their handlers exactly as before.
    for (const path of ['/api/parent-links', '/api/notification-consent', '/api/lesson-discussions', '/api/search', '/api/tenant-exports', '/api/platform/mfa']) {
        const response = await request(app.router, { method: 'GET', url: path, token: ADMIN_A });
        assert.equal(response.statusCode, 200, path);
    }
    // The opaque parent path is served without a JWT and without a header.
    const parent = await request(app.router, { method: 'GET', url: '/api/parent/children' });
    assert.equal(parent.statusCode, 200);
    assert.deepEqual(app.reached, ['parent-links', 'notification-consent', 'lesson-discussions', 'search', 'tenant-exports', 'platform-mfa', 'parent']);
});

test('the opaque parent path explicitly refuses a presented impersonation header', async () => {
    const { rows, token } = withActiveRow();
    const app = buildAssembledChain(rows);

    const response = await request(app.router, { method: 'GET', url: '/api/parent/children', token: ADMIN_A, impersonation: token });
    assert.equal(response.statusCode, 403);
    assert.equal(bodyOf(response).code, 'IMPERSONATION_DENIED');
    assert.equal(bodyOf(response).reason, 'parent_path');
    // The parent handler was never reached.
    assert.deepEqual(app.reached, []);
});
