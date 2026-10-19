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

import { Router, RequestHandler, Response } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { AuthRequest } from '../middleware/auth';
import { DeliveryNotConfiguredError, IdentityOtpService, OtpThrottledError, type IdentityOtpDeps, type OtpChallengeRow } from '../security/identity-otp';
import { normalizeId } from '../services/announcements';
import {
    createParentLinksService,
    createSqlParentLinksStore,
    parseLinkRequestInput,
    parseVerifyInput,
    ParentViewSecretUnavailableError,
    type ParentLinksService,
    type ParentLinksStore,
} from '../services/parent-links';

export interface ParentLinksDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface ParentLinksRouteDeps {
    db: ParentLinksDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    getOtpService: () => IdentityOtpService | null;
    getSecret: () => string | undefined;
    now?: () => Date;
    transaction?: <T>(fn: (store: ParentLinksStore) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

export const createSqlOtpDeps = (db: ParentLinksDataAccess): IdentityOtpDeps => ({
    insertChallenge: async (row: OtpChallengeRow) => {
        await db.execute(
            `INSERT INTO identity_otp_challenges
             (id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at,created_ip)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [row.id, row.contact_hash, row.purpose, row.tenant_id, row.identity_id, row.code_hash,
                row.attempts, row.max_attempts, row.resend_available_at, row.expires_at, row.consumed_at, row.submitted_at ?? null, row.created_ip],
        );
    },
    findChallengeById: async (id: string) => db.queryOne<OtpChallengeRow>(
        `SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at
         FROM identity_otp_challenges WHERE id = ?`,
        [id],
    ),
    findLatestActiveChallenge: async (contactHash: string, purpose: string, tenantId: string | null) => db.queryOne<OtpChallengeRow>(
        `SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at
         FROM identity_otp_challenges
         WHERE contact_hash = ? AND purpose = ? AND (tenant_id <=> ?) AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP()
         ORDER BY created_at DESC LIMIT 1`,
        [contactHash, purpose, tenantId],
    ),
    incrementAttempts: async (id: string) => {
        await db.execute('UPDATE identity_otp_challenges SET attempts = attempts + 1 WHERE id = ?', [id]);
    },
    consumeChallenge: async (id: string, now: Date) => {
        const result = await db.execute(
            'UPDATE identity_otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
            [now, id],
        );
        return Number(result.affectedRows || 0);
    },
    consumeSubmission: async (id: string, now: Date) => {
        const result = await db.execute(
            'UPDATE identity_otp_challenges SET submitted_at = ? WHERE id = ? AND consumed_at IS NOT NULL AND submitted_at IS NULL',
            [now, id],
        );
        return Number(result.affectedRows || 0);
    },
    countRecentChallenges: async (contactHash: string, purpose: string, since: Date) => {
        const row = await db.queryOne<Record<string, unknown> & { total: number }>(
            'SELECT COUNT(*) AS total FROM identity_otp_challenges WHERE contact_hash = ? AND purpose = ? AND created_at >= ?',
            [contactHash, purpose, since],
        );
        return Number(row?.total || 0);
    },
});

export const createParentLinksRouter = (deps: ParentLinksRouteDeps): Router => {
    const router = Router();
    router.use(deps.authenticate);

    const buildService = (): ParentLinksService => createParentLinksService({
        store: createSqlParentLinksStore(deps.db),
        otp: deps.getOtpService() ?? undefined,
        getSecret: deps.getSecret,
        now: deps.now,
        transaction: deps.transaction,
    });

    const principal = (req: AuthRequest, res: Response): { id: string; role: string; studentEnrollmentId?: string } | null => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        return { id: user.id, role: user.role, studentEnrollmentId: user.studentEnrollmentId };
    };

    router.post('/request', async (req: AuthRequest, res: Response) => {
        const actor = principal(req, res);
        if (!actor) return;
        const parsed = parseLinkRequestInput(req.body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        const service = buildService();
        try {
            const result = await service.requestLink({
                parentId: actor.id,
                studentEnrollmentId: parsed.value.studentEnrollmentId,
                contact: parsed.value.contact,
                ip: req.ip ?? null,
            });
            if (result.kind === 'denied') {
                if (result.reason === 'invalid-contact') return res.status(400).json({ error: 'A valid phone or email contact is required' });
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
        } catch (error) {
            if (error instanceof DeliveryNotConfiguredError) {
                return res.status(503).json({ error: 'Contact verification is not available yet' });
            }
            if (error instanceof OtpThrottledError) {
                return res.status(429).json({ error: 'Please wait before requesting another code', retry_after: error.retryAfterSeconds });
            }
            console.error('Parent link request error:', error);
            return res.status(500).json({ error: 'Failed to request a parent link' });
        }
    });

    router.post('/verify', async (req: AuthRequest, res: Response) => {
        const actor = principal(req, res);
        if (!actor) return;
        const parsed = parseVerifyInput(req.body);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
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
                if (result.reason === 'invalid-input') return res.status(400).json({ error: 'Verification input is invalid' });
                if (result.reason === 'verification-failed') return res.status(400).json({ error: 'Verification failed' });
                return res.status(404).json({ error: 'Student enrollment not found or contact is not registered' });
            }
            return res.status(result.kind === 'linked' ? 201 : 200).json({
                link_id: result.link.id,
                token: result.token,
                expires_at: result.expiresAt.toISOString(),
                expires_in: Math.max(0, Math.round((result.expiresAt.getTime() - Date.now()) / 1000)),
            });
        } catch (error) {
            if (error instanceof DeliveryNotConfiguredError) {
                return res.status(503).json({ error: 'Contact verification is not available yet' });
            }
            if (error instanceof ParentViewSecretUnavailableError) {
                return res.status(503).json({ error: 'Parent views are not available' });
            }
            console.error('Parent link verify error:', error);
            return res.status(500).json({ error: 'Failed to verify the parent link' });
        }
    });

    router.get('/', async (req: AuthRequest, res: Response) => {
        const actor = principal(req, res);
        if (!actor) return;
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
        } catch (error) {
            console.error('Parent link list error:', error);
            res.status(500).json({ error: 'Failed to list parent links' });
        }
    });

    router.post('/:id/revoke', async (req: AuthRequest, res: Response) => {
        const actor = principal(req, res);
        if (!actor) return;
        const linkId = normalizeId(req.params.id);
        if (!linkId) return res.status(404).json({ error: 'Parent link not found' });
        const service = buildService();
        try {
            const link = await service.getLinkById(linkId);
            if (!link) return res.status(404).json({ error: 'Parent link not found' });
            const isOwner = link.parent_user_id === actor.id;
            const isStudent = actor.role === 'student' && actor.studentEnrollmentId === link.student_enrollment_id;
            let isStaff = false;
            if (!isOwner && !isStudent) {
                const authority = await deps.loadActiveTenantAuthority(actor.id, link.tenant_id);
                isStaff = Boolean(authority && STAFF_AUTHORITIES.has(authority.authority));
            }
            if (!isOwner && !isStudent && !isStaff) return res.status(404).json({ error: 'Parent link not found' });
            if (link.status !== 'active') return res.status(409).json({ error: 'Parent link is already revoked' });
            const revoked = await service.revokeLink(link, actor.id);
            if (!revoked) return res.status(409).json({ error: 'Parent link changed concurrently' });
            res.json({ id: link.id, status: 'revoked' });
        } catch (error) {
            console.error('Parent link revoke error:', error);
            res.status(500).json({ error: 'Failed to revoke the parent link' });
        }
    });

    router.post('/:id/session', async (req: AuthRequest, res: Response) => {
        const actor = principal(req, res);
        if (!actor) return;
        const linkId = normalizeId(req.params.id);
        if (!linkId) return res.status(404).json({ error: 'Parent link not found' });
        const service = buildService();
        try {
            const owned = await service.getLinkById(linkId);
            if (!owned || owned.parent_user_id !== actor.id) return res.status(404).json({ error: 'Parent link not found' });
            const result = await service.issueSessionToken(owned.tenant_id, linkId, actor.id);
            if (result.kind === 'not-found') return res.status(404).json({ error: 'Parent link is not active' });
            res.json({
                token: result.token,
                expires_at: result.expiresAt.toISOString(),
                expires_in: Math.max(0, Math.round((result.expiresAt.getTime() - Date.now()) / 1000)),
            });
        } catch (error) {
            if (error instanceof ParentViewSecretUnavailableError) {
                return res.status(503).json({ error: 'Parent views are not available' });
            }
            console.error('Parent session token error:', error);
            res.status(500).json({ error: 'Failed to issue a parent session token' });
        }
    });

    return router;
};

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

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: ParentLinksDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};

const getOtpService = (): IdentityOtpService | null => {
    const key = process.env.OTP_HMAC_SECRET;
    if (!key || Buffer.byteLength(key, 'utf8') < 32) return null;
    return new IdentityOtpService(createSqlOtpDeps(productionDb), key, null);
};

const createConnectionStore = (conn: PoolConnection): ParentLinksStore => {
    const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
        const [result] = await conn.execute(sql, params as never);
        return result as T[];
    };
    return createSqlParentLinksStore({
        query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => rows<T>(sql, params),
        queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await rows<Record<string, unknown>>(sql, params);
            return (result[0] ?? null) as T | null;
        },
        execute: async (sql: string, params: unknown[] = []) => {
            const [result] = await conn.execute(sql, params as never);
            return result as { insertId?: number; affectedRows?: number };
        },
    });
};

const transaction = async <T>(fn: (store: ParentLinksStore) => Promise<T>): Promise<T> => {
    const { withTransaction } = await loadDb();
    return withTransaction((conn) => fn(createConnectionStore(conn)));
};

export default createParentLinksRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    getOtpService,
    getSecret: () => process.env.PARENT_VIEW_SECRET,
    transaction,
});
