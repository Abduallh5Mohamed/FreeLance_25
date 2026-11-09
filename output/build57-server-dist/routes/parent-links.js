"use strict";
/**
 * M6 P1 — parent-student verified linking routes.
 *
 * A parent (an authenticated principal; the principal model has no dedicated
 * parent role) proves control of the contact registered for a student with a
 * single-use OTP challenge. Only after that proof is a verified link row
 * created and a short-lived scoped read token issued. The token is accepted
 * only by the read-only parent-views routes.
 *
 * Authorization for revocation is deny-by-default: the link owner, an active
 * tenant staff authority, or the student whose enrollment is linked. Everyone
 * else receives 404 so link existence is never confirmed.
 *
 * This module exports `createParentLinksRouter(deps)`; it is not mounted by
 * this task. No runtime DDL.
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
exports.createParentLinksRouter = exports.createSqlOtpDeps = void 0;
const express_1 = require("express");
const identity_otp_1 = require("../security/identity-otp");
const announcements_1 = require("../services/announcements");
const parent_links_1 = require("../services/parent-links");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
const createSqlOtpDeps = (db) => ({
    insertChallenge: async (row) => {
        await db.execute(`INSERT INTO identity_otp_challenges
             (id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at,created_ip)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.id, row.contact_hash, row.purpose, row.tenant_id, row.identity_id, row.code_hash,
            row.attempts, row.max_attempts, row.resend_available_at, row.expires_at, row.consumed_at, row.submitted_at ?? null, row.created_ip]);
    },
    findChallengeById: async (id) => db.queryOne(`SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at
         FROM identity_otp_challenges WHERE id = ?`, [id]),
    findLatestActiveChallenge: async (contactHash, purpose, tenantId) => db.queryOne(`SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at
         FROM identity_otp_challenges
         WHERE contact_hash = ? AND purpose = ? AND (tenant_id <=> ?) AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP()
         ORDER BY created_at DESC LIMIT 1`, [contactHash, purpose, tenantId]),
    incrementAttempts: async (id) => {
        await db.execute('UPDATE identity_otp_challenges SET attempts = attempts + 1 WHERE id = ?', [id]);
    },
    consumeChallenge: async (id, now) => {
        const result = await db.execute('UPDATE identity_otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [now, id]);
        return Number(result.affectedRows || 0);
    },
    consumeSubmission: async (id, now) => {
        const result = await db.execute('UPDATE identity_otp_challenges SET submitted_at = ? WHERE id = ? AND consumed_at IS NOT NULL AND submitted_at IS NULL', [now, id]);
        return Number(result.affectedRows || 0);
    },
    countRecentChallenges: async (contactHash, purpose, since) => {
        const row = await db.queryOne('SELECT COUNT(*) AS total FROM identity_otp_challenges WHERE contact_hash = ? AND purpose = ? AND created_at >= ?', [contactHash, purpose, since]);
        return Number(row?.total || 0);
    },
});
exports.createSqlOtpDeps = createSqlOtpDeps;
const createParentLinksRouter = (deps) => {
    const router = (0, express_1.Router)();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(deps.authenticate);
    const buildService = () => (0, parent_links_1.createParentLinksService)({
        store: (0, parent_links_1.createSqlParentLinksStore)(deps.db),
        otp: deps.getOtpService() ?? undefined,
        getSecret: deps.getSecret,
        now: deps.now,
        execute: deps.db.execute,
        transaction: deps.transaction,
    });
    const principal = (req, res) => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        // Family links belong to a real users-table principal. A tenant staff
        // identity or support impersonation cannot become a parent by id collision.
        if (user.identitySource === 'staff' || user.billingOnly || req.impersonation || req.headers['x-impersonation'] !== undefined) {
            res.status(403).json({ error: 'A direct personal session is required' });
            return null;
        }
        return { id: user.id, role: user.role, studentEnrollmentId: user.studentEnrollmentId };
    };
    router.post('/request', async (req, res) => {
        const actor = principal(req, res);
        if (!actor)
            return;
        const parsed = (0, parent_links_1.parseLinkRequestInput)(req.body);
        if (!parsed.ok)
            return res.status(400).json({ error: parsed.error });
        const service = buildService();
        try {
            const result = await service.requestLink({
                parentId: actor.id,
                studentEnrollmentId: parsed.value.studentEnrollmentId,
                contact: parsed.value.contact,
                ip: req.ip ?? null,
            });
            if (result.kind === 'denied') {
                if (result.reason === 'invalid-contact')
                    return res.status(400).json({ error: 'A valid phone or email contact is required' });
                return res.status(404).json({ error: 'Student enrollment not found or contact is not registered' });
            }
            if (result.kind === 'already-linked') {
                return res.status(200).json({ already_linked: true, link_id: result.link.id });
            }
            return res.status(202).json({
                challenge_id: result.challengeId,
                expires_in: Math.max(0, Math.round((result.expiresAt.getTime() - Date.now()) / 1000)),
                resend_in: Math.max(0, Math.round((result.resendAvailableAt.getTime() - Date.now()) / 1000)),
            });
        }
        catch (error) {
            if (error instanceof identity_otp_1.DeliveryNotConfiguredError) {
                return res.status(503).json({ error: 'Contact verification is not available yet' });
            }
            if (error instanceof identity_otp_1.OtpThrottledError) {
                return res.status(429).json({ error: 'Please wait before requesting another code', retry_after: error.retryAfterSeconds });
            }
            console.error('Parent link request error:', error);
            return res.status(500).json({ error: 'Failed to request a parent link' });
        }
    });
    router.post('/verify', async (req, res) => {
        const actor = principal(req, res);
        if (!actor)
            return;
        const parsed = (0, parent_links_1.parseVerifyInput)(req.body);
        if (!parsed.ok)
            return res.status(400).json({ error: parsed.error });
        const service = buildService();
        try {
            const result = await service.verifyLink({
                parentId: actor.id,
                challengeId: parsed.value.challengeId,
                code: parsed.value.code,
                studentEnrollmentId: parsed.value.studentEnrollmentId,
                contact: parsed.value.contact,
            });
            if (result.kind === 'denied') {
                if (result.reason === 'invalid-input')
                    return res.status(400).json({ error: 'Verification input is invalid' });
                if (result.reason === 'verification-failed')
                    return res.status(400).json({ error: 'Verification failed' });
                return res.status(404).json({ error: 'Student enrollment not found or contact is not registered' });
            }
            return res.status(result.kind === 'linked' ? 201 : 200).json({
                link_id: result.link.id,
                token: result.token,
                expires_at: result.expiresAt.toISOString(),
                expires_in: Math.max(0, Math.round((result.expiresAt.getTime() - Date.now()) / 1000)),
            });
        }
        catch (error) {
            if (error instanceof identity_otp_1.DeliveryNotConfiguredError) {
                return res.status(503).json({ error: 'Contact verification is not available yet' });
            }
            if (error instanceof parent_links_1.ParentViewSecretUnavailableError) {
                return res.status(503).json({ error: 'Parent views are not available' });
            }
            console.error('Parent link verify error:', error);
            return res.status(500).json({ error: 'Failed to verify the parent link' });
        }
    });
    router.get('/', async (req, res) => {
        const actor = principal(req, res);
        if (!actor)
            return;
        const service = buildService();
        try {
            const links = await service.listLinks(actor.id);
            res.json(links.map((link) => ({
                id: link.id,
                tenant_id: link.tenant_id,
                student_enrollment_id: link.student_enrollment_id,
                status: link.status,
                version: link.version,
                created_at: link.created_at ?? null,
            })));
        }
        catch (error) {
            // A missing schema/store is unavailable, never an empty family.
            // Do not log driver details that can include private row parameters.
            res.status(503).json({ code: 'PARENT_LINKS_UNAVAILABLE', error: 'Parent links are temporarily unavailable' });
        }
    });
    router.post('/:id/revoke', async (req, res) => {
        const actor = principal(req, res);
        if (!actor)
            return;
        const linkId = (0, announcements_1.normalizeId)(req.params.id);
        if (!linkId)
            return res.status(404).json({ error: 'Parent link not found' });
        const service = buildService();
        try {
            const link = await service.getLinkById(linkId);
            if (!link)
                return res.status(404).json({ error: 'Parent link not found' });
            const isOwner = link.parent_user_id === actor.id;
            const isStudent = actor.role === 'student' && actor.studentEnrollmentId === link.student_enrollment_id;
            let isStaff = false;
            if (!isOwner && !isStudent) {
                const authority = await deps.loadActiveTenantAuthority(actor.id, link.tenant_id);
                isStaff = Boolean(authority && STAFF_AUTHORITIES.has(authority.authority));
            }
            if (!isOwner && !isStudent && !isStaff)
                return res.status(404).json({ error: 'Parent link not found' });
            if (link.status !== 'active')
                return res.status(409).json({ error: 'Parent link is already revoked' });
            const revoked = await service.revokeLink(link, actor.id);
            if (!revoked)
                return res.status(409).json({ error: 'Parent link changed concurrently' });
            res.json({ id: link.id, status: 'revoked' });
        }
        catch (error) {
            console.error('Parent link revoke error:', error);
            res.status(500).json({ error: 'Failed to revoke the parent link' });
        }
    });
    router.post('/:id/session', async (req, res) => {
        const actor = principal(req, res);
        if (!actor)
            return;
        const linkId = (0, announcements_1.normalizeId)(req.params.id);
        if (!linkId)
            return res.status(404).json({ error: 'Parent link not found' });
        const service = buildService();
        try {
            const owned = await service.getLinkById(linkId);
            if (!owned || owned.parent_user_id !== actor.id)
                return res.status(404).json({ error: 'Parent link not found' });
            const result = await service.issueSessionToken(owned.tenant_id, linkId, actor.id);
            if (result.kind === 'not-found')
                return res.status(404).json({ error: 'Parent link is not active' });
            res.json({
                token: result.token,
                expires_at: result.expiresAt.toISOString(),
                expires_in: Math.max(0, Math.round((result.expiresAt.getTime() - Date.now()) / 1000)),
            });
        }
        catch (error) {
            if (error instanceof parent_links_1.ParentViewSecretUnavailableError) {
                return res.status(503).json({ code: 'PARENT_SESSION_UNAVAILABLE', error: 'Parent views are not available' });
            }
            res.status(503).json({ code: 'PARENT_SESSION_UNAVAILABLE', error: 'Parent session is temporarily unavailable' });
        }
    });
    return router;
};
exports.createParentLinksRouter = createParentLinksRouter;
/* Production wiring: real pool, real auth, real tenant authority. */
const TENANT_AUTHORITY_SQL = `
    SELECT 'owner' AS authority
    FROM tenants t
    WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
    UNION ALL
    SELECT m.role_key AS authority
    FROM tenant_memberships m
    INNER JOIN tenants t ON t.id = m.tenant_id
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
      AND t.status = 'active' AND u.is_active = 1
      AND m.role_key IN ('owner','instructor')
    LIMIT 1
`;
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
const loadActiveTenantAuthority = async (userId, tenantId) => {
    const { queryOne } = await loadDb();
    return queryOne(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};
const getOtpService = () => {
    const key = process.env.OTP_HMAC_SECRET;
    if (!key || Buffer.byteLength(key, 'utf8') < 32)
        return null;
    return new identity_otp_1.IdentityOtpService((0, exports.createSqlOtpDeps)(productionDb), key, null);
};
const createConnectionStore = (conn) => {
    const rows = async (sql, params = []) => {
        const [result] = await conn.execute(sql, params);
        return result;
    };
    return (0, parent_links_1.createSqlParentLinksStore)({
        query: async (sql, params = []) => rows(sql, params),
        queryOne: async (sql, params = []) => {
            const result = await rows(sql, params);
            return (result[0] ?? null);
        },
        execute: async (sql, params = []) => {
            const [result] = await conn.execute(sql, params);
            return result;
        },
    });
};
const transaction = async (fn) => {
    const { withTransaction } = await loadDb();
    return withTransaction((conn) => {
        const store = createConnectionStore(conn);
        const txExecute = async (sql, params = []) => {
            const [result] = await conn.execute(sql, params);
            return result;
        };
        return fn(store, txExecute);
    });
};
exports.default = (0, exports.createParentLinksRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    getOtpService,
    getSecret: () => process.env.PARENT_VIEW_SECRET,
    transaction,
});
