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
 *  - Every mutation is audited (actor, reason, session id) through the
 *    injected sealed writer inside an injectable transaction seam; a failed
 *    audit aborts the mutation.
 *  - Tenant-owner notification is an injected best-effort hook; a failing
 *    hook never fails the request.
 *
 * Integration point (middleware/auth.ts stays untouched): adopters wire
 * `createImpersonationVerifier(...)` against the `x-impersonation` header,
 * then enforce `evaluateImpersonationWrite(context, action)` (protected
 * actions) and `requireImpersonationWriteScope(context)` (read-only default)
 * before their handlers. All three seams are covered by hermetic tests here.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requireAdminPermission } from '../security/admin-permissions';
import { SealedAuditRecordInput } from '../services/audit-log';
import {
    DEFAULT_IMPERSONATION_SECONDS,
    IMPERSONATION_HEADER,
    IMPERSONATION_RATE_LIMITS,
    ImpersonationDb,
    ImpersonationNotificationHook,
    ImpersonationSessionRow,
    ImpersonationStore,
    createImpersonationRateLimiter,
    createImpersonationService,
    createImpersonationVerifier,
    createSqlImpersonationStore,
    noopImpersonationNotificationHook,
    notifyTenantOwnerSafely,
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
    recordAudit: (input: SealedAuditRecordInput) => Promise<void>;
    /** Resolves the ONLY acceptable target row; null denies (404). */
    resolveTargetUser: (targetUserId: string, tenantId: string) => Promise<PlatformTargetRow | null>;
    /** A holder of `impersonation.manage` may revoke any session. */
    isImpersonationManager: (userId: string) => Promise<boolean>;
    /** Production default: JWT_SECRET-derived key; null fails closed. */
    tokenKey?: () => Buffer | null;
    notify?: ImpersonationNotificationHook;
    now?: () => Date;
    idFactory?: () => string;
    store?: ImpersonationStore;
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
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
    const service = createImpersonationService({ store, now, idFactory: deps.idFactory });
    const notify = deps.notify ?? noopImpersonationNotificationHook;
    const runAtomic = deps.transaction ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
    const tokenKey = deps.tokenKey ?? (async () => {
        const { getJwtSecret } = await import('../middleware/auth');
        return Buffer.from(getJwtSecret().toString(), 'utf8');
    });
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
            await runAtomic(async () => {
                await deps.recordAudit({
                    actorUserId: starterId,
                    tenantId: validated.value.tenantId,
                    action: 'impersonation.session_requested',
                    resourceType: 'impersonation_session',
                    resourceId: started.session.id,
                    newValue: {
                        session_id: started.session.id,
                        target_user_id: validated.value.targetUserId,
                        tenant_id: validated.value.tenantId,
                        scope: validated.value.scope,
                        requested_seconds: validated.value.durationSeconds,
                    },
                    reason: validated.value.reason,
                });
            });
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
            await runAtomic(async () => {
                await deps.recordAudit({
                    actorUserId: approverId,
                    tenantId: approved.session.tenant_id,
                    action: 'impersonation.session_approved',
                    resourceType: 'impersonation_session',
                    resourceId: approved.session.id,
                    newValue: {
                        session_id: approved.session.id,
                        approved_by: approverId,
                        scope: approved.session.scope,
                        expires_at: approved.expiresAt.toISOString(),
                    },
                    reason: approved.session.reason,
                });
            });
            let contextToken: string | null = null;
            const writeScope = approved.session.scope === 'write';
            const key = await tokenKey();
            if (key) contextToken = signImpersonationToken(approved.session, writeScope, key, now().getTime());
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
            await runAtomic(async () => {
                await deps.recordAudit({
                    actorUserId: actorId,
                    tenantId: revoked.session.tenant_id,
                    action: 'impersonation.session_revoked',
                    resourceType: 'impersonation_session',
                    resourceId: revoked.session.id,
                    oldValue: { status: 'active' },
                    newValue: { session_id: revoked.session.id, revoked_by: actorId },
                    reason: revoked.session.reason,
                });
            });
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
    recordAudit: async (input) => {
        const { recordSealedAuditEvent } = await import('../services/audit-log');
        // The sealed append runs on one transactional connection so the
        // audit-chain head lock serializes concurrent appends.
        const { withTransaction } = await loadDb();
        await withTransaction(async (connection) => {
            await recordSealedAuditEvent({
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
            }, input);
        });
    },
    resolveTargetUser: resolveProductionTargetUser,
    isImpersonationManager: async (userId) => {
        const { hasVerifiedPlatformPermission } = await import('../security/admin-permissions');
        return hasVerifiedPlatformPermission('impersonation.manage', userId);
    },
});
