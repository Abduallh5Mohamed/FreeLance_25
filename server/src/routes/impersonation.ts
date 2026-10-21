/**
 * M7 O6 — impersonation session management routes.
 *
 * Audience + permission model:
 *  - Every path requires authentication; a JWT role claim alone never grants
 *    access. Start/approve/revoke-scope and listing are gated by injected
 *    VERIFIED platform-permission guards (`impersonation.start`,
 *    `impersonation.approve`, `impersonation.read`) resolved from server rows.
 *  - A session for a target user is opened with a mandatory reason and an
 *    explicit scope (read by default); approval by a SECOND, different
 *    platform admin activates it; the expiry is hard-capped at 30 minutes.
 *  - The target must be an active, tenant-resolved user and is never a
 *    platform administrator. A currently active session for the same target
 *    is refused (409) and cross-tenant/unknown targets are denied (404 into
 *    no enumeration of tenant membership).
 *  - Immediate revoke is possible for the starter, the approver or a holder
 *    of `impersonation.manage`; the issued context verifies the LIVE row, so a
 *    revoked (or expired) session stops working on the next request.
 *  - The dedicated signing key is resolved and validated BEFORE approval
 *    starts: a missing, too-short or JWT-derived key fails closed with 503 and
 *    no session is activated. Approval then performs the pending -> active
 *    transition and the sealed audit on ONE injected transaction (row lock +
 *    guarded affectedRows), so a failed audit rolls the activation back. The
 *    response always carries a minted token; there is no null-token success.
 *  - Start and revoke run on the same ONE injected transaction (insert /
 *    locked guarded transition + sealed audit), so a failed audit rolls the
 *    mutation back instead of leaving a phantom or unaudited session.
 *
 * Integration point: request-level enforcement lives in
 * `middleware/impersonation-context.ts` (`enforceImpersonationContext`),
 * mounted by `index.ts` after the shared auth guard. It verifies the
 * `x-impersonation` header, binds it to the authenticated TARGET principal
 * and enforces the read-only allowlist before any business handler; this
 * module stays the session-management surface (start/approve/revoke/list)
 * and still rejects a context itself. Adopters call
 * `evaluateImpersonationWrite` (protected actions) and
 * `requireImpersonationWriteScope` (read-only default) before their own
 * mutations. The contract is documented in
 * docs/contracts/IMPERSONATION-INTEGRATION.md.
 */

import { Router, RequestHandler, Response } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { AuthRequest } from '../middleware/auth';
import { requireAdminPermission } from '../security/admin-permissions';
import {
    DEFAULT_IMPERSONATION_SECONDS,
    IMPERSONATION_HEADER,
    IMPERSONATION_RATE_LIMITS,
    ImpersonationDb,
    ImpersonationNotificationHook,
    ImpersonationSessionRow,
    ImpersonationStore,
    ImpersonationTransactionRunner,
    createImpersonationRateLimiter,
    createImpersonationService,
    createImpersonationVerifier,
    createSqlImpersonationStore,
    noopImpersonationNotificationHook,
    notifyTenantOwnerSafely,
    resolveImpersonationSigningKey,
    signImpersonationToken,
    validateStartInput,
} from '../services/impersonation';

export interface PlatformTargetRow {
    userId: string;
    tenantId: string;
    role: string;
    isActive: boolean;
}

export interface ImpersonationRouteDeps {
    db: ImpersonationDb;
    authenticate: RequestHandler;
    requirePlatformPermission: (permission: string) => RequestHandler;
    /** Resolves the ONLY acceptable target row; null denies (404). */
    resolveTargetUser: (targetUserId: string, tenantId: string) => Promise<PlatformTargetRow | null>;
    /** A holder of `impersonation.manage` may revoke any session. */
    isImpersonationManager: (userId: string) => Promise<boolean>;
    /**
     * Dedicated impersonation signing key. Production reads
     * IMPERSONATION_TOKEN_SECRET; returning null/undefined or a key shorter
     * than 32 bytes makes approval fail closed (503).
     */
    tokenKey?: () => Buffer | null | Promise<Buffer | null>;
    /**
     * One database transaction exposing the whole store plus the sealed audit,
     * all bound to a single connection. Production wires `withTransaction`;
     * start, approve and revoke run inside it, so each mutation and its audit
     * commit or roll back together. There is no non-transactional path.
     */
    transaction: ImpersonationTransactionRunner;
    /** Compared against the signing key so the JWT secret is never reused. */
    jwtSecret?: string | null;
    notify?: ImpersonationNotificationHook;
    now?: () => Date;
    idFactory?: () => string;
    store?: ImpersonationStore;
}

const sessionProjection = (row: ImpersonationSessionRow): Record<string, unknown> => ({
    id: row.id,
    started_by: row.started_by,
    approved_by: row.approved_by,
    target_user_id: row.target_user_id,
    tenant_id: row.tenant_id,
    reason: row.reason,
    scope: row.scope,
    status: row.status,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    created_at: row.created_at ?? null,
});

export const createImpersonationRouter = (deps: ImpersonationRouteDeps): Router => {
    const router = Router();
    const now = deps.now ?? (() => new Date());
    const store = deps.store ?? createSqlImpersonationStore(deps.db);
    const service = createImpersonationService({
        store,
        now,
        idFactory: deps.idFactory,
        transaction: deps.transaction,
    });
    const notify = deps.notify ?? noopImpersonationNotificationHook;
    const tokenKey = deps.tokenKey ?? productionImpersonationTokenKey;
    const jwtSecret = (): string | null =>
        deps.jwtSecret !== undefined ? deps.jwtSecret : (process.env.JWT_SECRET ?? null);
    const verifier = createImpersonationVerifier({ store, tokenKey, now });
    const readGuard = deps.requirePlatformPermission('impersonation.read');
    const startGuard = deps.requirePlatformPermission('impersonation.start');
    const approveGuard = deps.requirePlatformPermission('impersonation.approve');
    const limiters = {
        start: createImpersonationRateLimiter({ ...IMPERSONATION_RATE_LIMITS.start, now }),
        approve: createImpersonationRateLimiter({ ...IMPERSONATION_RATE_LIMITS.approve, now }),
    };

    router.use(deps.authenticate);

    const userIdOf = (req: AuthRequest, res: Response): string | null => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        return user.id;
    };

    /** An already-issued impersonation context must never control sessions. */
    const rejectChainedImpersonation = async (req: AuthRequest, res: Response): Promise<boolean> => {
        const header = req.headers[IMPERSONATION_HEADER];
        if (header === undefined || header === null || typeof header !== 'string') return false;
        const verdict = await verifier(header);
        if (verdict.ok) {
            res.status(403).json({ error: 'Impersonation contexts cannot start or manage impersonation sessions' });
            return true;
        }
        return false;
    };

    // ---------------------------------------------------------------------
    // Start: pending request with mandatory reason, explicit scope, <=30min.
    // ---------------------------------------------------------------------
    router.post('/start', startGuard, async (req: AuthRequest, res: Response) => {
        try {
            const starterId = userIdOf(req, res);
            if (!starterId) return;
            if (!limiters.start.tryConsume(`start:${starterId}`)) {
                return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
            }
            if (await rejectChainedImpersonation(req, res)) return;
            const validated = validateStartInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            if (validated.value.targetUserId === starterId) {
                return res.status(400).json({ error: 'A support actor cannot impersonate their own user' });
            }
            const target = await deps.resolveTargetUser(validated.value.targetUserId, validated.value.tenantId);
            if (!target || !target.isActive) {
                return res.status(404).json({ error: 'Target user not found in the tenant' });
            }
            if (String(target.role).trim().toLowerCase() === 'admin') {
                return res.status(403).json({ error: 'Platform administrators cannot be impersonated' });
            }
            const started = await service.start(starterId, validated.value);
            if (!started.ok) {
                if (started.reason === 'target_active_session') {
                    return res.status(409).json({ error: 'An impersonation session already exists for this user' });
                }
                return res.status(500).json({ error: 'Failed to start impersonation session' });
            }
            res.status(201).json({
                ...sessionProjection(started.session),
                status: 'pending_approval',
                approval_required: true,
                max_seconds: DEFAULT_IMPERSONATION_SECONDS,
            });
        } catch (error) {
            console.error('Impersonation start route failed:', error);
            res.status(500).json({ error: 'Failed to start impersonation session' });
        }
    });

    // ---------------------------------------------------------------------
    // Approve: a SECOND, different platform admin; issues the context token.
    // ---------------------------------------------------------------------
    router.post('/:id/approve', approveGuard, async (req: AuthRequest, res: Response) => {
        try {
            const approverId = userIdOf(req, res);
            if (!approverId) return;
            if (!limiters.approve.tryConsume(`approve:${approverId}`)) {
                return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
            }
            if (await rejectChainedImpersonation(req, res)) return;
            const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            if (!sessionId) return res.status(400).json({ error: 'A session id is required' });
            // Fail closed BEFORE the transition: an activated session we cannot
            // mint a context for is unusable and must never exist.
            const signing = await resolveImpersonationSigningKey(tokenKey, { jwtSecret: jwtSecret() });
            if (!signing.ok) {
                return res.status(503).json({
                    error: 'Impersonation signing is not configured',
                    code: 'SIGNING_UNAVAILABLE',
                });
            }
            const approved = await service.approve(sessionId, approverId);
            if (!approved.ok) {
                switch (approved.reason) {
                    case 'not_found':
                        return res.status(404).json({ error: 'Impersonation session not found' });
                    case 'self_approval':
                        return res.status(403).json({ error: 'The requesting admin cannot approve their own session' });
                    case 'not_pending':
                        return res.status(409).json({ error: 'The session is not awaiting approval' });
                    default:
                        if (approved.reason === 'besides_transition') {
                            return res.status(409).json({ error: 'The session changed concurrently' });
                        }
                        return res.status(500).json({ error: 'Failed to approve impersonation session' });
                }
            }
            const writeScope = approved.session.scope === 'write';
            const contextToken = signImpersonationToken(approved.session, writeScope, signing.key, now().getTime());
            await notifyTenantOwnerSafely(notify, {
                kind: 'session_started',
                sessionId: approved.session.id,
                tenantId: approved.session.tenant_id,
                actorUserId: approved.session.started_by,
                approverUserId: approverId,
                targetUserId: approved.session.target_user_id,
                scope: writeScope ? 'write' : 'read',
                expiresAt: approved.expiresAt.toISOString(),
            });
            res.json({
                ...sessionProjection(approved.session),
                status: 'active',
                expires_at: approved.expiresAt.toISOString(),
                impersonation_token: contextToken,
            });
        } catch (error) {
            console.error('Impersonation approve route failed:', error);
            res.status(500).json({ error: 'Failed to approve impersonation session' });
        }
    });

    // ---------------------------------------------------------------------
    // Revoke: immediate; starter/approver or an impersonation.manager.
    // ---------------------------------------------------------------------
    router.post('/:id/revoke', async (req: AuthRequest, res: Response) => {
        try {
            const actorId = userIdOf(req, res);
            if (!actorId) return;
            const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            if (!sessionId) return res.status(400).json({ error: 'A session id is required' });
            const manager = await deps.isImpersonationManager(actorId);
            const session = await store.findSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Impersonation session not found' });
            const related = String(session.started_by) === String(actorId) || String(session.approved_by) === String(actorId);
            if (!manager && !related) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const revoked = await service.revoke(sessionId, actorId);
            if (!revoked.ok) {
                if (revoked.reason === 'not_revocable' || revoked.reason === 'besides_transition') {
                    return res.status(409).json({ error: 'The session can no longer be revoked' });
                }
                if (revoked.reason === 'not_found') return res.status(404).json({ error: 'Impersonation session not found' });
                return res.status(500).json({ error: 'Failed to revoke impersonation session' });
            }
            await notifyTenantOwnerSafely(notify, {
                kind: 'session_ended',
                sessionId: revoked.session.id,
                tenantId: revoked.session.tenant_id,
                actorUserId: revoked.session.started_by,
                approverUserId: revoked.session.approved_by,
                targetUserId: revoked.session.target_user_id,
                scope: revoked.session.scope === 'write' ? 'write' : 'read',
                expiresAt: null,
            });
            res.json(sessionProjection(revoked.session));
        } catch (error) {
            console.error('Impersonation revoke route failed:', error);
            res.status(500).json({ error: 'Failed to revoke impersonation session' });
        }
    });

    // ---------------------------------------------------------------------
    // Listing: verified read permission only, bounded.
    // ---------------------------------------------------------------------
    router.get('/sessions', readGuard, async (req: AuthRequest, res: Response) => {
        try {
            const actorId = userIdOf(req, res);
            if (!actorId) return;
            const sessions = await store.listRecentForActor(actorId, 50);
            res.json(sessions.slice(0, 100).map(sessionProjection));
        } catch (error) {
            console.error('Impersonation list route failed:', error);
            res.status(500).json({ error: 'Failed to list impersonation sessions' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real platform-permission guard,
   the sealed audit writer and server-derived target resolution. */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: ImpersonationDb = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never) as Promise<T[]>;
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never) as Promise<T | null>;
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

/** Bind the impersonation data access to one pool connection/transaction. */
const connectionDb = (connection: PoolConnection): ImpersonationDb => ({
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const [rows] = await connection.query(sql, params as never);
        return rows as T[];
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const [rows] = await connection.query(sql, params as never);
        return (rows as T[])[0] ?? null;
    },
    execute: async (sql: string, params?: unknown[]) => {
        const [result] = await connection.execute(sql, params as never);
        const header = result as { insertId?: number; affectedRows?: number };
        return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
    },
});

/**
 * Dedicated impersonation signing key for production: the
 * IMPERSONATION_TOKEN_SECRET only, read at call time. The JWT secret is
 * never a fallback (a compromised session token must not mint contexts).
 */
export const productionImpersonationTokenKey: NonNullable<ImpersonationRouteDeps['tokenKey']> = async () => {
    const secret = process.env.IMPERSONATION_TOKEN_SECRET;
    return secret ? Buffer.from(secret, 'utf8') : null;
};

/**
 * The verifier the request-context middleware mounts: the shared SQL store
 * plus the dedicated key, re-checking the LIVE session row on every call so
 * revoke is immediate. Built lazily/cheaply; no connection is created here.
 */
export const createProductionImpersonationVerifier = () =>
    createImpersonationVerifier({
        store: createSqlImpersonationStore(productionDb),
        tokenKey: productionImpersonationTokenKey,
        now: () => new Date(),
    });

export const resolveProductionTargetUser = async (
    targetUserId: string,
    tenantId: string,
): Promise<{ userId: string; tenantId: string; role: string; isActive: boolean } | null> => {
    try {
        const row = await productionDb.queryOne<{ id: string; role: string }>(
            `SELECT u.id, u.role FROM users u
             WHERE u.id = ? AND u.is_active = 1 AND u.role <> 'admin'
               AND (
                 EXISTS (SELECT 1 FROM tenant_memberships m
                         WHERE m.user_id = u.id AND m.tenant_id = ? AND m.status = 'active')
                 OR EXISTS (SELECT 1 FROM students s WHERE s.user_id = u.id AND s.tenant_id = ?)
                 OR EXISTS (SELECT 1 FROM tenants t WHERE t.id = ? AND t.owner_user_id = u.id)
               )
             LIMIT 1`,
            [targetUserId, tenantId, tenantId, tenantId],
        );
        if (!row) return null;
        return { userId: String(row.id), tenantId, role: String(row.role ?? ''), isActive: true };
    } catch (error) {
        console.error('Impersonation target resolution failed:', error);
        return null;
    }
};

export default createImpersonationRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => requireAdminPermission(permission),
    transaction: async (work) => {
        // ONE transaction per mutation: the insert/locked guarded transition
        // and the sealed audit append commit or roll back together. Any failure
        // rolls the mutation back before the caller responds, so no phantom
        // pending session and no revoked, unaudited row can survive it.
        const { withTransaction } = await loadDb();
        const { recordSealedAuditEvent } = await import('../services/audit-log');
        return withTransaction(async (connection) => {
            const txDb = connectionDb(connection);
            const txStore = createSqlImpersonationStore(txDb);
            return work({
                ...txStore,
                // The sealed append runs on the SAME connection, so the
                // audit-chain head lock serializes with the mutation.
                recordAudit: (input) => recordSealedAuditEvent(txDb, input),
            });
        });
    },
    resolveTargetUser: resolveProductionTargetUser,
    isImpersonationManager: async (userId) => {
        const { hasVerifiedPlatformPermission } = await import('../security/admin-permissions');
        return hasVerifiedPlatformPermission('impersonation.manage', userId);
    },
});
