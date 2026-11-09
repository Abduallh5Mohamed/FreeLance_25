"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProductionTargetUser = exports.createProductionImpersonationVerifier = exports.productionImpersonationTokenKey = exports.createImpersonationRouter = void 0;
const express_1 = require("express");
const admin_permissions_1 = require("../security/admin-permissions");
const impersonation_1 = require("../services/impersonation");
const sessionProjection = (row) => ({
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
const createImpersonationRouter = (deps) => {
    const router = (0, express_1.Router)();
    const now = deps.now ?? (() => new Date());
    const store = deps.store ?? (0, impersonation_1.createSqlImpersonationStore)(deps.db);
    const service = (0, impersonation_1.createImpersonationService)({
        store,
        now,
        idFactory: deps.idFactory,
        transaction: deps.transaction,
    });
    const notify = deps.notify ?? impersonation_1.noopImpersonationNotificationHook;
    const tokenKey = deps.tokenKey ?? exports.productionImpersonationTokenKey;
    const jwtSecret = () => deps.jwtSecret !== undefined ? deps.jwtSecret : (process.env.JWT_SECRET ?? null);
    const verifier = (0, impersonation_1.createImpersonationVerifier)({ store, tokenKey, now });
    const readGuard = deps.requirePlatformPermission('impersonation.read');
    const startGuard = deps.requirePlatformPermission('impersonation.start');
    const approveGuard = deps.requirePlatformPermission('impersonation.approve');
    const limiters = {
        start: (0, impersonation_1.createImpersonationRateLimiter)({ ...impersonation_1.IMPERSONATION_RATE_LIMITS.start, now }),
        approve: (0, impersonation_1.createImpersonationRateLimiter)({ ...impersonation_1.IMPERSONATION_RATE_LIMITS.approve, now }),
    };
    router.use(deps.authenticate);
    const userIdOf = (req, res) => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        return user.id;
    };
    /** An already-issued impersonation context must never control sessions. */
    const rejectChainedImpersonation = async (req, res) => {
        const header = req.headers[impersonation_1.IMPERSONATION_HEADER];
        if (header === undefined || header === null || typeof header !== 'string')
            return false;
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
    router.post('/start', startGuard, async (req, res) => {
        try {
            const starterId = userIdOf(req, res);
            if (!starterId)
                return;
            if (!limiters.start.tryConsume(`start:${starterId}`)) {
                return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
            }
            if (await rejectChainedImpersonation(req, res))
                return;
            const validated = (0, impersonation_1.validateStartInput)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
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
                max_seconds: impersonation_1.DEFAULT_IMPERSONATION_SECONDS,
            });
        }
        catch (error) {
            console.error('Impersonation start route failed:', error);
            res.status(500).json({ error: 'Failed to start impersonation session' });
        }
    });
    // ---------------------------------------------------------------------
    // Approve: a SECOND, different platform admin; issues the context token.
    // ---------------------------------------------------------------------
    router.post('/:id/approve', approveGuard, async (req, res) => {
        try {
            const approverId = userIdOf(req, res);
            if (!approverId)
                return;
            if (!limiters.approve.tryConsume(`approve:${approverId}`)) {
                return res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
            }
            if (await rejectChainedImpersonation(req, res))
                return;
            const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            if (!sessionId)
                return res.status(400).json({ error: 'A session id is required' });
            // Fail closed BEFORE the transition: an activated session we cannot
            // mint a context for is unusable and must never exist.
            const signing = await (0, impersonation_1.resolveImpersonationSigningKey)(tokenKey, { jwtSecret: jwtSecret() });
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
            const contextToken = (0, impersonation_1.signImpersonationToken)(approved.session, writeScope, signing.key, now().getTime());
            await (0, impersonation_1.notifyTenantOwnerSafely)(notify, {
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
        }
        catch (error) {
            console.error('Impersonation approve route failed:', error);
            res.status(500).json({ error: 'Failed to approve impersonation session' });
        }
    });
    // ---------------------------------------------------------------------
    // Revoke: immediate; starter/approver or an impersonation.manager.
    // ---------------------------------------------------------------------
    router.post('/:id/revoke', async (req, res) => {
        try {
            const actorId = userIdOf(req, res);
            if (!actorId)
                return;
            const sessionId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            if (!sessionId)
                return res.status(400).json({ error: 'A session id is required' });
            const manager = await deps.isImpersonationManager(actorId);
            const session = await store.findSession(sessionId);
            if (!session)
                return res.status(404).json({ error: 'Impersonation session not found' });
            const related = String(session.started_by) === String(actorId) || String(session.approved_by) === String(actorId);
            if (!manager && !related) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const revoked = await service.revoke(sessionId, actorId);
            if (!revoked.ok) {
                if (revoked.reason === 'not_revocable' || revoked.reason === 'besides_transition') {
                    return res.status(409).json({ error: 'The session can no longer be revoked' });
                }
                if (revoked.reason === 'not_found')
                    return res.status(404).json({ error: 'Impersonation session not found' });
                return res.status(500).json({ error: 'Failed to revoke impersonation session' });
            }
            await (0, impersonation_1.notifyTenantOwnerSafely)(notify, {
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
        }
        catch (error) {
            console.error('Impersonation revoke route failed:', error);
            res.status(500).json({ error: 'Failed to revoke impersonation session' });
        }
    });
    // ---------------------------------------------------------------------
    // Listing: verified read permission only, bounded.
    // ---------------------------------------------------------------------
    router.get('/sessions', readGuard, async (req, res) => {
        try {
            const actorId = userIdOf(req, res);
            if (!actorId)
                return;
            const sessions = await store.listRecentForActor(actorId, 50);
            res.json(sessions.slice(0, 100).map(sessionProjection));
        }
        catch (error) {
            console.error('Impersonation list route failed:', error);
            res.status(500).json({ error: 'Failed to list impersonation sessions' });
        }
    });
    return router;
};
exports.createImpersonationRouter = createImpersonationRouter;
/* Production wiring: real pool, real auth, real platform-permission guard,
   the sealed audit writer and server-derived target resolution. */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const productionDb = {
    query: async (sql, params) => {
        const { query } = await loadDb();
        return query(sql, params);
    },
    queryOne: async (sql, params) => {
        const { queryOne } = await loadDb();
        return queryOne(sql, params);
    },
    execute: async (sql, params) => {
        const { execute } = await loadDb();
        return execute(sql, params);
    },
};
/** Bind the impersonation data access to one pool connection/transaction. */
const connectionDb = (connection) => ({
    query: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows;
    },
    queryOne: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows[0] ?? null;
    },
    execute: async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        const header = result;
        return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
    },
});
/**
 * Dedicated impersonation signing key for production: the
 * IMPERSONATION_TOKEN_SECRET only, read at call time. The JWT secret is
 * never a fallback (a compromised session token must not mint contexts).
 */
const productionImpersonationTokenKey = async () => {
    const secret = process.env.IMPERSONATION_TOKEN_SECRET;
    return secret ? Buffer.from(secret, 'utf8') : null;
};
exports.productionImpersonationTokenKey = productionImpersonationTokenKey;
/**
 * The verifier the request-context middleware mounts: the shared SQL store
 * plus the dedicated key, re-checking the LIVE session row on every call so
 * revoke is immediate. Built lazily/cheaply; no connection is created here.
 */
const createProductionImpersonationVerifier = () => (0, impersonation_1.createImpersonationVerifier)({
    store: (0, impersonation_1.createSqlImpersonationStore)(productionDb),
    tokenKey: exports.productionImpersonationTokenKey,
    now: () => new Date(),
});
exports.createProductionImpersonationVerifier = createProductionImpersonationVerifier;
const resolveProductionTargetUser = async (targetUserId, tenantId) => {
    try {
        const row = await productionDb.queryOne(`SELECT u.id, u.role FROM users u
             WHERE u.id = ? AND u.is_active = 1 AND u.role <> 'admin'
               AND (
                 EXISTS (SELECT 1 FROM tenant_memberships m
                         WHERE m.user_id = u.id AND m.tenant_id = ? AND m.status = 'active')
                 OR EXISTS (SELECT 1 FROM students s WHERE s.user_id = u.id AND s.tenant_id = ?)
                 OR EXISTS (SELECT 1 FROM tenants t WHERE t.id = ? AND t.owner_user_id = u.id)
               )
             LIMIT 1`, [targetUserId, tenantId, tenantId, tenantId]);
        if (!row)
            return null;
        return { userId: String(row.id), tenantId, role: String(row.role ?? ''), isActive: true };
    }
    catch (error) {
        console.error('Impersonation target resolution failed:', error);
        return null;
    }
};
exports.resolveProductionTargetUser = resolveProductionTargetUser;
exports.default = (0, exports.createImpersonationRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => (0, admin_permissions_1.requireAdminPermission)(permission),
    transaction: async (work) => {
        // ONE transaction per mutation: the insert/locked guarded transition
        // and the sealed audit append commit or roll back together. Any failure
        // rolls the mutation back before the caller responds, so no phantom
        // pending session and no revoked, unaudited row can survive it.
        const { withTransaction } = await loadDb();
        const { recordSealedAuditEvent } = await Promise.resolve().then(() => __importStar(require('../services/audit-log')));
        return withTransaction(async (connection) => {
            const txDb = connectionDb(connection);
            const txStore = (0, impersonation_1.createSqlImpersonationStore)(txDb);
            return work({
                ...txStore,
                // The sealed append runs on the SAME connection, so the
                // audit-chain head lock serializes with the mutation.
                recordAudit: (input) => recordSealedAuditEvent(txDb, input),
            });
        });
    },
    resolveTargetUser: exports.resolveProductionTargetUser,
    isImpersonationManager: async (userId) => {
        const { hasVerifiedPlatformPermission } = await Promise.resolve().then(() => __importStar(require('../security/admin-permissions')));
        return hasVerifiedPlatformPermission('impersonation.manage', userId);
    },
});
