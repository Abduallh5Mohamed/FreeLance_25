import { createHash, randomUUID } from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { Router, RequestHandler, Response } from 'express';
import multer from 'multer';
import { execute, getPool, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { BUCKETS, deleteFile, getPrivateObjectUrl, uploadBuffer } from '../services/minio';
import { executeRenewalIntent } from '../services/subscription-renewal';

/**
 * Minimal transactional connection seam. Production binds a real mysql2
 * PoolConnection (getPool().getConnection()); hermetic tests bind a
 * fixture-backed connection so the real handler/authorization logic runs
 * without a database, network or live app startup.
 */
export interface TenantSelfConnection {
  beginTransaction(): Promise<void>;
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

/** Data-access seam for the tenant self-service router. Production binds ../db. */
export interface TenantSelfDataAccess {
  query: typeof query;
  queryOne: typeof queryOne;
  execute: typeof execute;
  getConnection: () => Promise<TenantSelfConnection>;
}

/**
 * Injectable seams for the tenant self-service router (/api/tenants/me). The
 * default export binds the production SQL adapters, the real authentication
 * middleware, the real MinIO helpers, the real renewal executor, and the real
 * server-owned tenant-authority lookup. Tests inject isolated fixtures through
 * this boundary instead of bypassing production authorization.
 */
export interface TenantSelfDeps {
  db: TenantSelfDataAccess;
  authenticate: RequestHandler;
  /**
   * Active authority of a principal inside the SELECTED tenant, resolved from
   * server-side rows only: the verified owner row, or an active membership
   * with role_key owner/instructor in an active tenant by an active user.
   * Mirrors the server-owned authority lookup used by the finance and video
   * routers (no new authority vocabulary). A bare tenant-role or membership
   * claim never satisfies this.
   */
  loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
  uploadBuffer: typeof uploadBuffer;
  deleteFile: typeof deleteFile;
  getPrivateObjectUrl: typeof getPrivateObjectUrl;
  executeRenewalIntent: typeof executeRenewalIntent;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const money = (value: unknown) => {
  const text = String(value ?? '').trim();
  return /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text) && Number(text) > 0 ? text : null;
};
const proofType = (file: Express.Multer.File) => {
  const b = file.buffer;
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { contentType: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { contentType: 'image/webp', ext: 'webp' };
  if (b.length >= 5 && b.subarray(0, 5).toString() === '%PDF-') return { contentType: 'application/pdf', ext: 'pdf' };
  return null;
};

export const createTenantSelfRouter = (deps: TenantSelfDeps): Router => {
  const router = Router();
  const { query, queryOne, execute, getConnection } = deps.db;
  const { loadActiveTenantAuthority, uploadBuffer, deleteFile, getPrivateObjectUrl, executeRenewalIntent: runRenewalIntent } = deps;
  router.use(deps.authenticate);

  /**
   * Resolve the caller's tenant inside the server-selected workspace only.
   * Authority mirrors the server-owned tenant-authority contract used by the
   * finance and video routers: the verified owner row, or an active membership
   * with role_key owner/instructor in an active tenant by an active user,
   * keyed by the tenant the authentication middleware selected from the token
   * selector against the caller's active memberships. An arbitrary LIMIT 1
   * membership, a forged tenant id, or an unselected workspace never resolves.
   */
  async function getOwnedTenant(req: AuthRequest) {
    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return null;
    const authority = await loadActiveTenantAuthority(userId, tenantId);
    if (!authority) return null;
    return queryOne<any>(
      `SELECT t.id,t.business_name,t.status,t.legacy_compat,t.owner_user_id
       FROM tenants t WHERE t.id=? LIMIT 1`,
      [tenantId]
    );
  }

router.get('/subscription', async (req: AuthRequest, res: Response) => {
  try {
    const tenant = await getOwnedTenant(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant membership not found' });
    const row = await queryOne(
      `SELECT t.id AS tenant_id,t.business_name,t.status AS tenant_status,t.legacy_compat,
              s.id AS subscription_id,s.status AS subscription_status,s.agreed_price,s.discount_amount,s.currency,
              s.starts_at,s.period_ends_at,s.grace_until,p.name AS plan_name,p.duration_months,p.duration_days,
              GREATEST(0,TIMESTAMPDIFF(DAY,UTC_TIMESTAMP(),s.period_ends_at)) AS days_remaining,
              CASE WHEN s.period_ends_at<=UTC_TIMESTAMP() AND DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)>UTC_TIMESTAMP()
                THEN GREATEST(0,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),DATE_ADD(s.period_ends_at,INTERVAL 4 DAY))) ELSE 0 END AS grace_seconds_remaining
       FROM tenants t
       LEFT JOIN tenant_subscriptions s ON s.id=(
         SELECT s2.id FROM tenant_subscriptions s2 WHERE s2.tenant_id=t.id
         ORDER BY CASE WHEN s2.status IN ('active','past_due','grace_period') THEN 0 WHEN s2.status='pending' THEN 1 ELSE 2 END,
           COALESCE(s2.period_ends_at,s2.created_at) DESC LIMIT 1)
       LEFT JOIN platform_plans p ON p.id=s.plan_id
       WHERE t.id=? LIMIT 1`, [tenant.id]
    );
    if (!row) return res.status(404).json({ error: 'Tenant membership not found' });
    return res.json(row);
  } catch (error) { console.error('Get tenant subscription error:', error); return res.status(500).json({ error: 'Failed to load subscription' }); }
});

router.get('/billing', async (req: AuthRequest, res: Response) => {
  try {
    const tenant = await getOwnedTenant(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant membership not found' });
    const [subscription, wallet, intent, topups] = await Promise.all([
      queryOne<any>(
        `SELECT s.id,s.status,s.plan_id,s.agreed_price,s.discount_amount,s.currency,s.starts_at,s.period_ends_at,s.grace_until,
                p.name AS plan_name,p.duration_months,p.duration_days,
                GREATEST(0,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),s.period_ends_at)) AS period_seconds_remaining,
                CASE WHEN s.period_ends_at<=UTC_TIMESTAMP() THEN GREATEST(0,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),COALESCE(s.grace_until,DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)))) ELSE 0 END AS grace_seconds_remaining
         FROM tenant_subscriptions s INNER JOIN platform_plans p ON p.id=s.plan_id
         WHERE s.tenant_id=? ORDER BY CASE WHEN s.status IN ('active','past_due','grace_period') THEN 0 ELSE 1 END,
           COALESCE(s.period_ends_at,s.created_at) DESC LIMIT 1`, [tenant.id]),
      queryOne<any>('SELECT balance,updated_at FROM instructor_wallets WHERE instructor_id=?', [req.user!.id]),
      queryOne<any>(
        `SELECT i.id,i.status,i.trigger_type,i.charge_amount,i.paid_at,i.created_at,p.name AS plan_name
         FROM tenant_renewal_intents i INNER JOIN platform_plans p ON p.id=i.target_plan_id
         WHERE i.tenant_id=? AND i.status='pending' LIMIT 1`, [tenant.id]),
      query<any>(
        `SELECT id,purpose_code,amount,currency,method,reference_number,paid_at,notes,status,rejection_reason,reviewed_at,created_at
         FROM instructor_topup_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50`, [tenant.id]),
    ]);
    return res.json({
      server_now: new Date().toISOString(),
      tenant: { id: tenant.id, business_name: tenant.business_name, status: tenant.status, legacy_compat: Boolean(tenant.legacy_compat) },
      subscription: subscription ? { ...subscription, charge_amount: Math.max(0, Number(subscription.agreed_price) - Number(subscription.discount_amount)) } : null,
      wallet: { balance: String(wallet?.balance ?? '0.00'), updated_at: wallet?.updated_at || null },
      renewal_intent: intent || null, topups, billing_only: Boolean(req.user?.billingOnly),
    });
  } catch (error) { console.error('Get instructor billing center error:', error); return res.status(500).json({ error: 'Failed to load billing center' }); }
});

router.post('/topups', upload.single('proof'), async (req: AuthRequest, res: Response) => {
  let objectKey: string | null = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Payment proof is required' });
    const detected = proofType(req.file);
    if (!detected) return res.status(400).json({ error: 'Proof must be JPEG, PNG, WebP or PDF' });
    const amount = money(req.body.amount);
    const purpose = String(req.body.purpose_code ?? '');
    const method = String(req.body.method ?? '');
    const reference = String(req.body.reference_number ?? '').trim();
    const notes = String(req.body.notes ?? '').trim();
    const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
    const paidAt = new Date(String(req.body.paid_at ?? ''));
    if (!amount || !['subscription_renewal','other'].includes(purpose) || !['bank_transfer','instapay','mobile_wallet','cash'].includes(method) || reference.length < 3 || reference.length > 160 || notes.length > 1000 || idempotencyKey.length < 8 || idempotencyKey.length > 120 || Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60_000 || paidAt.getTime() < Date.now() - 366 * 86400_000) {
      return res.status(400).json({ error: 'Invalid top-up details' });
    }
    if (purpose === 'subscription_renewal' && req.body.renewal_confirmation !== 'CONFIRM_MONTHLY_RENEWAL') return res.status(400).json({ error: 'Monthly renewal confirmation is required' });
    const tenant = await getOwnedTenant(req);
    if (!tenant || tenant.status !== 'active') return res.status(403).json({ error: 'Active tenant account required' });
    const existing = await queryOne<any>('SELECT id,status FROM instructor_topup_requests WHERE instructor_id=? AND idempotency_key=?', [req.user!.id, idempotencyKey]);
    if (existing) return res.json({ id: existing.id, status: existing.status, duplicate: true });
    if (purpose === 'subscription_renewal') {
      const pending = await queryOne<any>(
        `SELECT id FROM instructor_topup_requests WHERE tenant_id=? AND purpose_code='subscription_renewal' AND status='submitted'
         UNION ALL SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' LIMIT 1`, [tenant.id, tenant.id]
      );
      if (pending) return res.status(409).json({ error: 'يوجد إذن تجديد أو إثبات تجديد قيد الانتظار بالفعل' });
    }
    const id = randomUUID();
    const hash = createHash('sha256').update(req.file.buffer).digest('hex');
    objectKey = `instructor-topups/${tenant.id}/${id}.${detected.ext}`;
    await uploadBuffer(BUCKETS.PAYMENT_PROOFS, objectKey, req.file.buffer, detected.contentType);
    await execute(
      `INSERT INTO instructor_topup_requests
       (id,tenant_id,instructor_id,purpose_code,amount,method,reference_number,paid_at,proof_object_key,proof_sha256,proof_content_type,notes,idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenant.id, req.user!.id, purpose, amount, method, reference,
        paidAt.toISOString().slice(0, 19).replace('T', ' '), objectKey, hash, detected.contentType, notes || null, idempotencyKey]
    );
    objectKey = null;
    try {
      await execute(
        `INSERT INTO notifications (id,user_id,user_type,title,message,type,link)
         SELECT UUID(),u.id,'admin','إيصال شحن جديد',?,'payment','/admin/platform'
         FROM users u WHERE u.role='admin' AND u.is_active=1`,
        [`رفع ${tenant.business_name} إيصال شحن بقيمة ${amount} ج.م للمراجعة.`]
      );
    } catch (notificationError) { console.error('Create top-up admin notification error:', notificationError); }
    return res.status(201).json({ id, status: 'submitted' });
  } catch (error: any) {
    if (objectKey) try { await deleteFile(BUCKETS.PAYMENT_PROOFS, objectKey); } catch { /* best effort cleanup */ }
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'رقم التحويل أو ملف الإثبات مستخدم في طلب سابق' });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Proof file exceeds the 8MB limit' });
    console.error('Submit instructor top-up error:', error); return res.status(500).json({ error: 'Failed to submit top-up' });
  }
});

router.get('/topups/:id/proof-url', async (req: AuthRequest, res: Response) => {
  try {
    const row = await queryOne<any>('SELECT proof_object_key FROM instructor_topup_requests WHERE id=? AND instructor_id=?', [req.params.id, req.user!.id]);
    if (!row) return res.status(404).json({ error: 'Top-up request not found' });
    return res.json({ url: await getPrivateObjectUrl(BUCKETS.PAYMENT_PROOFS, row.proof_object_key, 300), expires_in: 300 });
  } catch (error) { console.error('Get own proof URL error:', error); return res.status(500).json({ error: 'Failed to open proof' }); }
});

router.post('/renewal-intents/manual', async (req: AuthRequest, res: Response) => {
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Renewal confirmation is required' });
  const tenant = await getOwnedTenant(req);
  if (!tenant || tenant.status !== 'active') return res.status(403).json({ error: 'Active tenant account required' });
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [pendingRows] = await connection.execute("SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' FOR UPDATE", [tenant.id]);
    if ((pendingRows as any[]).length) { await connection.rollback(); return res.status(409).json({ error: 'A renewal intent is already pending' }); }
    const [subscriptionRows] = await connection.execute(
      `SELECT id,plan_id,agreed_price,discount_amount,status FROM tenant_subscriptions
       WHERE tenant_id=? AND status IN ('active','past_due','grace_period','expired')
       ORDER BY COALESCE(period_ends_at,created_at) DESC LIMIT 1 FOR UPDATE`, [tenant.id]
    );
    const subscription = (subscriptionRows as any[])[0];
    if (!subscription) { await connection.rollback(); return res.status(409).json({ error: 'No renewable subscription found' }); }
    const charge = Math.max(0, Number(subscription.agreed_price) - Number(subscription.discount_amount));
    const [walletRows] = await connection.execute('SELECT balance FROM instructor_wallets WHERE instructor_id=? FOR UPDATE', [req.user!.id]);
    if (Number((walletRows as any[])[0]?.balance || 0) < charge) {
      await connection.rollback(); return res.status(409).json({ error: 'رصيد الخدمات غير كافٍ للتجديد', required: charge });
    }
    const id = randomUUID();
    await connection.execute(
      `INSERT INTO tenant_renewal_intents
       (id,tenant_id,instructor_id,source_subscription_id,target_plan_id,trigger_type,charge_amount)
       VALUES (?,?,?,?,?,'manual',?)`,
      [id, tenant.id, req.user!.id, subscription.id, subscription.plan_id, String(charge)]
    );
    const result = await runRenewalIntent(connection as unknown as PoolConnection, id);
    await connection.commit();
    return res.status(201).json({ id, ...result });
  } catch (error: any) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A renewal intent is already pending' });
    console.error('Create manual renewal intent error:', error); return res.status(500).json({ error: 'Failed to request renewal' });
  } finally { connection.release(); }
});

router.post('/renewal-intents/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const result = await execute(
      `UPDATE tenant_renewal_intents SET status='cancelled',cancelled_at=UTC_TIMESTAMP()
       WHERE id=? AND instructor_id=? AND status='pending'`, [req.params.id, req.user!.id]
    );
    if (!(result as any).affectedRows) return res.status(409).json({ error: 'Renewal intent is not pending' });
    return res.json({ status: 'cancelled' });
  } catch (error) { console.error('Cancel renewal intent error:', error); return res.status(500).json({ error: 'Failed to cancel renewal intent' }); }
});

  return router;
};

/**
 * Production tenant-authority lookup, identical to the server-owned lookup
 * used by the finance/video routers: verified owner row, or active membership
 * role_key owner/instructor in an active tenant by an active user.
 */
const loadActiveTenantAuthority = async (userId: string, tenantId: string) =>
  queryOne<{ authority: string }>(
    `SELECT 'owner' AS authority
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
     LIMIT 1`,
    [tenantId, userId, userId, tenantId],
  );

/**
 * Production binding: the real SQL adapters, the real authentication
 * middleware, the real MinIO helpers, the real renewal executor, and the real
 * server-owned tenant-authority lookup. index.ts imports this default export
 * unchanged.
 */
export default createTenantSelfRouter({
  db: {
    query,
    queryOne,
    execute,
    getConnection: () => getPool().getConnection() as unknown as Promise<TenantSelfConnection>,
  },
  authenticate: authenticateToken,
  loadActiveTenantAuthority,
  uploadBuffer,
  deleteFile,
  getPrivateObjectUrl,
  executeRenewalIntent,
});
