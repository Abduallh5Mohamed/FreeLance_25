import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { Router, Request, Response } from 'express';
import { getPool } from '../db';

const router = Router();

router.post('/redeem', async (req: Request, res: Response) => {
  const token = String(req.body.token ?? '').trim();
  const password = String(req.body.password ?? '');
  if (!/^[0-9a-f]{64}$/.test(token) || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Valid invitation token and password of at least 12 characters are required' });
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const passwordHash = await bcrypt.hash(password, 12);
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT i.id,i.user_id,i.tenant_id FROM tenant_invitations i
       INNER JOIN tenants t ON t.id=i.tenant_id AND t.status='active'
       WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>UTC_TIMESTAMP()
       FOR UPDATE`,
      [tokenHash]
    );
    const invitation = (rows as Array<{ id: string; user_id: string; tenant_id: string }>)[0];
    if (!invitation) { await connection.rollback(); return res.status(404).json({ error: 'Invitation invalid or expired' }); }
    await connection.execute('UPDATE users SET password_hash=?,is_active=1 WHERE id=?', [passwordHash, invitation.user_id]);
    await connection.execute('UPDATE tenant_invitations SET used_at=UTC_TIMESTAMP() WHERE id=?', [invitation.id]);
    await connection.commit();
    return res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error('Redeem tenant invitation error:', error);
    return res.status(500).json({ error: 'Failed to redeem invitation' });
  } finally {
    connection.release();
  }
});

export default router;
