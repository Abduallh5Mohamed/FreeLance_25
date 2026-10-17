import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { Router, Request, Response } from 'express';
import { getPool } from '../db';
import type { ResultSetHeader } from 'mysql2';
import { rateLimit } from '../middleware/rate-limit';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';

const router = Router();

export const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const INVITATION_PASSWORD_MIN_LENGTH = 12;
export const INVITATION_PASSWORD_MAX_LENGTH = 128;

export type InvitationRedeemResult = 'redeemed' | 'invalid' | 'suspended';

export interface InvitationRedeemDeps {
    hashPassword: (password: string) => Promise<string>;
    consumeInvitation: (tokenHash: string, passwordHash: string) => Promise<InvitationRedeemResult>;
}

interface InvitationRow {
    id: string;
    user_id: string;
    tenant_id: string;
    suspension_active: boolean | number;
}

/**
 * Production adapter: single-use invitation consumption inside one
 * transaction. The invitation row is locked, must be unused, unexpired, and
 * belong to an active tenant; a user under an active time-bound suspension
 * is rejected instead of reactivated. Setting the password bumps
 * token_version so any outstanding sessions are revoked.
 */
export const consumeInvitationTransaction = async (
    tokenHash: string,
    passwordHash: string,
): Promise<InvitationRedeemResult> => {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
            `SELECT i.id,i.user_id,i.tenant_id,
                    ${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active
             FROM tenant_invitations i
             INNER JOIN tenants t ON t.id=i.tenant_id AND t.status='active'
             INNER JOIN users u ON u.id=i.user_id
             WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>UTC_TIMESTAMP()
             FOR UPDATE`,
            [tokenHash]
        );
        const invitation = (rows as InvitationRow[])[0];
        if (!invitation) { await connection.rollback(); return 'invalid'; }
        if (invitation.suspension_active) { await connection.rollback(); return 'suspended'; }
        const [userUpdate] = await connection.execute<ResultSetHeader>(
            'UPDATE users SET password_hash=?,is_active=1,token_version=COALESCE(token_version,0)+1 WHERE id=?',
            [passwordHash, invitation.user_id]
        );
        if (userUpdate.affectedRows !== 1) {
            await connection.rollback();
            return 'invalid';
        }
        const [invitationUpdate] = await connection.execute<ResultSetHeader>(
            `UPDATE tenant_invitations SET used_at=UTC_TIMESTAMP()
             WHERE id=? AND tenant_id=? AND user_id=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP()`,
            [invitation.id, invitation.tenant_id, invitation.user_id]
        );
        if (invitationUpdate.affectedRows !== 1) {
            await connection.rollback();
            return 'invalid';
        }
        await connection.commit();
        return 'redeemed';
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

export const createRedeemHandler = (deps: InvitationRedeemDeps) =>
    async (req: Request, res: Response) => {
        const body = typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
            ? req.body as Record<string, unknown>
            : {};
        const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
        const password = typeof body['password'] === 'string' ? body['password'] : '';
        if (!INVITATION_TOKEN_PATTERN.test(token) ||
            password.length < INVITATION_PASSWORD_MIN_LENGTH ||
            password.length > INVITATION_PASSWORD_MAX_LENGTH) {
            return res.status(400).json({ error: 'Valid invitation token and password of at least 12 characters are required' });
        }
        const tokenHash = createHash('sha256').update(token).digest('hex');
        try {
            const passwordHash = await deps.hashPassword(password);
            const result = await deps.consumeInvitation(tokenHash, passwordHash);
            if (result === 'invalid') {
                return res.status(404).json({ error: 'Invitation invalid or expired' });
            }
            if (result === 'suspended') {
                return res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
            }
            return res.json({ success: true });
        } catch (error) {
            console.error('Redeem tenant invitation error:', error);
            return res.status(500).json({ error: 'Failed to redeem invitation' });
        }
    };

router.post('/redeem', rateLimit('tenant-invitation-redeem', 10, 15 * 60_000), createRedeemHandler({
    hashPassword: (password) => bcrypt.hash(password, 12),
    consumeInvitation: consumeInvitationTransaction,
}));

export default router;
