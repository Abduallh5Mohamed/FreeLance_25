"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRedeemHandler = exports.consumeInvitationTransaction = exports.INVITATION_PASSWORD_MAX_LENGTH = exports.INVITATION_PASSWORD_MIN_LENGTH = exports.INVITATION_TOKEN_PATTERN = void 0;
const crypto_1 = require("crypto");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const express_1 = require("express");
const db_1 = require("../db");
const rate_limit_1 = require("../middleware/rate-limit");
const suspension_predicate_1 = require("../security/suspension-predicate");
const router = (0, express_1.Router)();
exports.INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
exports.INVITATION_PASSWORD_MIN_LENGTH = 12;
exports.INVITATION_PASSWORD_MAX_LENGTH = 128;
/**
 * Production adapter: single-use invitation consumption inside one
 * transaction. The invitation row is locked, must be unused, unexpired, and
 * belong to an active tenant; a user under an active time-bound suspension
 * is rejected instead of reactivated. Setting the password bumps
 * token_version so any outstanding sessions are revoked.
 */
const consumeInvitationTransaction = async (tokenHash, passwordHash) => {
    const connection = await (0, db_1.getPool)().getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(`SELECT i.id,i.user_id,i.tenant_id,
                    ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active
             FROM tenant_invitations i
             INNER JOIN tenants t ON t.id=i.tenant_id AND t.status='active'
             INNER JOIN users u ON u.id=i.user_id
             WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>UTC_TIMESTAMP()
             FOR UPDATE`, [tokenHash]);
        const invitation = rows[0];
        if (!invitation) {
            await connection.rollback();
            return 'invalid';
        }
        if (invitation.suspension_active) {
            await connection.rollback();
            return 'suspended';
        }
        const [userUpdate] = await connection.execute('UPDATE users SET password_hash=?,is_active=1,token_version=COALESCE(token_version,0)+1 WHERE id=?', [passwordHash, invitation.user_id]);
        if (userUpdate.affectedRows !== 1) {
            await connection.rollback();
            return 'invalid';
        }
        const [invitationUpdate] = await connection.execute(`UPDATE tenant_invitations SET used_at=UTC_TIMESTAMP()
             WHERE id=? AND tenant_id=? AND user_id=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP()`, [invitation.id, invitation.tenant_id, invitation.user_id]);
        if (invitationUpdate.affectedRows !== 1) {
            await connection.rollback();
            return 'invalid';
        }
        await connection.commit();
        return 'redeemed';
    }
    catch (error) {
        await connection.rollback();
        throw error;
    }
    finally {
        connection.release();
    }
};
exports.consumeInvitationTransaction = consumeInvitationTransaction;
const createRedeemHandler = (deps) => async (req, res) => {
    const body = typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
        ? req.body
        : {};
    const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    if (!exports.INVITATION_TOKEN_PATTERN.test(token) ||
        password.length < exports.INVITATION_PASSWORD_MIN_LENGTH ||
        password.length > exports.INVITATION_PASSWORD_MAX_LENGTH) {
        return res.status(400).json({ error: 'Valid invitation token and password of at least 12 characters are required' });
    }
    const tokenHash = (0, crypto_1.createHash)('sha256').update(token).digest('hex');
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
    }
    catch (error) {
        console.error('Redeem tenant invitation error:', error);
        return res.status(500).json({ error: 'Failed to redeem invitation' });
    }
};
exports.createRedeemHandler = createRedeemHandler;
router.post('/redeem', (0, rate_limit_1.rateLimit)('tenant-invitation-redeem', 10, 15 * 60000), (0, exports.createRedeemHandler)({
    hashPassword: (password) => bcryptjs_1.default.hash(password, 12),
    consumeInvitation: exports.consumeInvitationTransaction,
}));
exports.default = router;
