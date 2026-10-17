import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import type { PoolConnection } from 'mysql2/promise';
import { Router, RequestHandler, Response } from 'express';
import { execute, getPool, query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getAdminPermissions, isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';
import { postServiceCreditEntry } from '../services/service-credit';
import { executeRenewalIntent } from '../services/subscription-renewal';
import { BUCKETS, getPrivateObjectUrl } from '../services/minio';

/**
 * Minimal transactional connection seam. Production binds a real mysql2
 * PoolConnection (getPool().getConnection()); hermetic tests bind a
 * fixture-backed connection so the real handler/authorization logic runs
 * without a database, network or live app startup.
 */
export interface PlatformTenantsConnection {
  beginTransaction(): Promise<void>;
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

/** Data-access seam for the platform tenants router. Production binds ../db. */
export interface PlatformTenantsDataAccess {
  query: typeof query;
  queryOne: typeof queryOne;
  execute: typeof execute;
  getConnection: () => Promise<PlatformTenantsConnection>;
}

/**
 * Injectable seams for the platform tenants router. The default export binds
 * the production SQL adapters, the real authentication middleware, the real
 * platform-capability guard, and the real service functions. Tests inject
 * isolated fixtures through this boundary instead of bypassing production
 * authorization.
 */
export interface PlatformTenantsDeps {
  db: PlatformTenantsDataAccess;
  authenticate: RequestHandler;
  requireAdminPermission: (permission: string) => RequestHandler;
  getAdminPermissions: (userId: string) => Promise<string[]>;
  isSuperAdmin: (userId: string) => Promise<boolean>;
  postServiceCreditEntry: typeof postServiceCreditEntry;
  executeRenewalIntent: typeof executeRenewalIntent;
  getPrivateObjectUrl: typeof getPrivateObjectUrl;
}

export const createPlatformTenantsRouter = (deps: PlatformTenantsDeps): Router => {
  const router = Router();
  const { query, queryOne, execute, getConnection } = deps.db;
  const { requireAdminPermission, getAdminPermissions, isSuperAdmin, postServiceCreditEntry, executeRenewalIntent, getPrivateObjectUrl } = deps;
  router.use(deps.authenticate);

const money = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text) && Number(text) > 0 ? text : null;
};

const parsePagination = (pageValue: unknown, limitValue: unknown) => {
  const pageText = pageValue ?? '1';
  const limitText = limitValue ?? '25';
  if (typeof pageText !== 'string' || !/^[1-9]\d{0,4}$/.test(pageText) ||
      typeof limitText !== 'string' || !/^[1-9]\d{0,2}$/.test(limitText)) return null;
  const page = Number(pageText);
  const limit = Number(limitText);
  if (page > 10000 || limit > 100) return null;
  return { page, limit, offset: (page - 1) * limit };
};

router.get('/plans', requireAdminPermission('subscription.read'), async (req: AuthRequest, res: Response) => {
  try {
    const rows = await query('SELECT id,code,name,duration_months,duration_days,price,currency,is_active FROM platform_plans ORDER BY duration_months,duration_days');
    const permissions = await getAdminPermissions(req.user!.id);
    const mayReadPrices = permissions.includes('finance.read') || permissions.includes('subscription.create') || permissions.includes('platform_payment.submit');
    return res.json(mayReadPrices ? rows : (rows as any[]).map(({ price: _privatePrice, ...row }) => row));
  } catch (error) {
    console.error('List platform plans error:', error);
    return res.status(500).json({ error: 'Failed to load platform plans' });
  }
});

router.post('/plans', requireAdminPermission('subscription.create'), async (req: AuthRequest, res: Response) => {
  try {
    const code = String(req.body.code ?? '').trim().toLowerCase();
    const name = String(req.body.name ?? '').trim();
    const durationMonths = Number(req.body.duration_months);
    const durationDays = Number(req.body.duration_days ?? 0);
    const price = String(req.body.price ?? '').trim();
    if (!/^[a-z0-9_-]{3,60}$/.test(code) || name.length < 3 || name.length > 255 || !Number.isInteger(durationMonths) || durationMonths < 0 || durationMonths > 36 || !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 31 || durationMonths + durationDays < 1 || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(price)) {
      return res.status(400).json({ error: 'Invalid platform plan' });
    }
    const id = randomUUID();
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'INSERT INTO platform_plans (id,code,name,duration_months,duration_days,price) VALUES (?,?,?,?,?,?)',
        [id, code, name, durationMonths, durationDays, price]
      );
      await connection.execute(
        'INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value) VALUES (?,?,?,?,?,?)',
        [randomUUID(), req.user!.id, 'platform_plan.created', 'platform_plan', id, JSON.stringify({ code, name, duration_months: durationMonths, duration_days: durationDays, price })]
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return res.status(201).json({ id });
  } catch (error) {
    console.error('Create platform plan error:', error);
    return res.status(500).json({ error: 'Failed to create platform plan' });
  }
});

router.get('/tenants', requireAdminPermission('instructor.read'), async (req: AuthRequest, res: Response) => {
  try {
    const pagination = parsePagination(req.query.page, req.query.limit);
    if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
    const { page, limit, offset } = pagination;
    const rows = await query(
      `SELECT t.id,t.business_name,t.subject_type,t.status,t.legacy_compat,t.owner_user_id,
              u.name AS owner_name,u.phone AS owner_phone,
              s.id AS subscription_id,s.status AS subscription_status,s.agreed_price,
              s.period_ends_at,s.grace_until
       FROM tenants t INNER JOIN users u ON u.id=t.owner_user_id
       LEFT JOIN tenant_subscriptions s ON s.id=(
         SELECT s2.id FROM tenant_subscriptions s2 WHERE s2.tenant_id=t.id ORDER BY s2.created_at DESC LIMIT 1)
       ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`
    );
    const permissions = await getAdminPermissions(req.user!.id);
    const mayReadPrices = permissions.includes('finance.read') || permissions.includes('platform_payment.submit');
    const visibleRows = mayReadPrices ? rows : (rows as any[]).map(({ agreed_price: _privatePrice, ...row }) => row);
    return res.json({ data: visibleRows, page, limit });
  } catch (error) {
    console.error('List tenants error:', error);
    return res.status(500).json({ error: 'Failed to load tenants' });
  }
});

router.get('/payments', requireAdminPermission('platform_payment.read'), async (req: AuthRequest, res: Response) => {
  try {
    const pagination = parsePagination(req.query.page, req.query.limit);
    if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
    const { page, limit, offset } = pagination;
    const rows = await query(
      `SELECT p.id,p.subscription_id,p.amount,p.method,p.reference_number,p.status,p.submitted_by,p.created_at,
              s.tenant_id,t.business_name
       FROM platform_payment_attempts p
       INNER JOIN tenant_subscriptions s ON s.id=p.subscription_id
       INNER JOIN tenants t ON t.id=s.tenant_id
       ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`
    );
    const permissions = await getAdminPermissions(req.user!.id);
    const mayReadPaymentDetails = permissions.includes('finance.read') || permissions.includes('platform_payment.verify');
    const visibleRows = mayReadPaymentDetails ? rows : (rows as any[]).map(({
      amount: _amount,
      method: _method,
      reference_number: _reference,
      submitted_by: _submitter,
      ...row
    }) => row);
    return res.json({ data: visibleRows, page, limit });
  } catch (error) {
    console.error('List platform payments error:', error);
    return res.status(500).json({ error: 'Failed to load platform payments' });
  }
});

// Complete operational and financial account statement for one instructor.
// Amounts and transfer references are returned only to Finance/Super Admin.
router.get('/instructors/:ownerUserId/account', requireAdminPermission('instructor.read'), async (req: AuthRequest, res: Response) => {
  try {
    const [permissions, superAdmin] = await Promise.all([
      getAdminPermissions(req.user!.id),
      isSuperAdmin(req.user!.id),
    ]);
    const has = (permission: string) => superAdmin || permissions.includes(permission);
    const account = await queryOne<any>(
      `SELECT u.id AS owner_user_id,u.name AS owner_name,u.phone AS owner_phone,u.email AS owner_email,
              u.is_active AS login_active,u.created_at AS account_created_at,
              t.id AS tenant_id,t.business_name,t.subject_type,t.status AS tenant_status,t.legacy_compat,t.created_at AS tenant_created_at,
              bp.billing_cycle_day,bp.reminder_days_before,bp.collection_status,bp.next_followup_at,bp.updated_at AS billing_updated_at
       FROM users u
       LEFT JOIN tenants t ON t.owner_user_id=u.id
       LEFT JOIN tenant_billing_profiles bp ON bp.tenant_id=t.id
       WHERE u.id=? AND u.role='instructor' LIMIT 1`,
      [req.params.ownerUserId]
    );
    if (!account) return res.status(404).json({ error: 'Instructor account not found' });

    const teaching = await queryOne<any>(
      `SELECT
        (SELECT COUNT(*) FROM students WHERE instructor_id=? AND is_active=1) AS students,
        (SELECT COUNT(*) FROM students WHERE instructor_id=? AND is_active=1 AND is_offline=0) AS online_students,
        (SELECT COUNT(*) FROM students WHERE instructor_id=? AND is_active=1 AND is_offline=1) AS offline_students,
        (SELECT COUNT(*) FROM lectures WHERE instructor_id=?) AS lectures`,
      [account.owner_user_id, account.owner_user_id, account.owner_user_id, account.owner_user_id]
    );

    const subscriptions = account.tenant_id ? await query<any>(
      `SELECT s.id,s.status,s.agreed_price,s.discount_amount,s.currency,s.starts_at,s.period_ends_at,s.grace_until,
              s.cancel_at_period_end,s.created_at,s.updated_at,pl.id AS plan_id,pl.code AS plan_code,
              pl.name AS plan_name,pl.duration_months,
              COALESCE(pay.verified_paid,0) AS verified_paid,COALESCE(pay.pending_paid,0) AS pending_paid,
              COALESCE(pay.verified_count,0) AS verified_payments,COALESCE(pay.pending_count,0) AS pending_payments,
              pay.last_verified_at
       FROM tenant_subscriptions s
       INNER JOIN platform_plans pl ON pl.id=s.plan_id
       LEFT JOIN (
         SELECT subscription_id,
                SUM(CASE WHEN status='verified' THEN amount ELSE 0 END) AS verified_paid,
                SUM(CASE WHEN status='submitted' THEN amount ELSE 0 END) AS pending_paid,
                SUM(status='verified') AS verified_count,SUM(status='submitted') AS pending_count,
                MAX(CASE WHEN status='verified' THEN reviewed_at END) AS last_verified_at
         FROM platform_payment_attempts GROUP BY subscription_id
       ) pay ON pay.subscription_id=s.id
       WHERE s.tenant_id=? ORDER BY s.created_at DESC`,
      [account.tenant_id]
    ) : [];

    const paymentRows = account.tenant_id ? await query<any>(
      `SELECT p.id,p.subscription_id,p.amount,p.currency,p.method,p.reference_number,p.status,p.created_at,
              p.reviewed_at,p.rejection_reason,pl.name AS plan_name,pl.duration_months,
              submitter.name AS submitted_by_name,reviewer.name AS reviewed_by_name
       FROM platform_payment_attempts p
       INNER JOIN tenant_subscriptions s ON s.id=p.subscription_id
       INNER JOIN platform_plans pl ON pl.id=s.plan_id
       LEFT JOIN users submitter ON submitter.id=p.submitted_by
       LEFT JOIN users reviewer ON reviewer.id=p.reviewed_by
       WHERE s.tenant_id=? ORDER BY p.created_at DESC`,
      [account.tenant_id]
    ) : [];

    const notes = account.tenant_id ? await query<any>(
      `SELECT n.id,n.note_type,n.body,n.followup_at,n.created_at,u.name AS created_by_name
       FROM tenant_account_notes n INNER JOIN users u ON u.id=n.created_by
       WHERE n.tenant_id=? ORDER BY n.created_at DESC LIMIT 100`,
      [account.tenant_id]
    ) : [];

    const audit = account.tenant_id && has('audit.read') ? await query<any>(
      `SELECT a.id,a.action,a.resource_type,a.resource_id,a.reason,a.created_at,u.name AS actor_name
       FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id
       WHERE a.tenant_id=? ORDER BY a.created_at DESC LIMIT 50`,
      [account.tenant_id]
    ) : [];

    const normalizedSubscriptions = subscriptions.map((row: any) => {
      const amountDue = Math.max(0, Number(row.agreed_price) - Number(row.discount_amount));
      const verifiedPaid = Number(row.verified_paid || 0);
      return {
        ...row,
        agreed_price: Number(row.agreed_price),
        discount_amount: Number(row.discount_amount),
        amount_due: amountDue,
        verified_paid: verifiedPaid,
        pending_paid: Number(row.pending_paid || 0),
        outstanding: Math.max(0, amountDue - verifiedPaid),
        duration_months: Number(row.duration_months),
        verified_payments: Number(row.verified_payments),
        pending_payments: Number(row.pending_payments),
      };
    });
    const billable = normalizedSubscriptions.filter((row: any) => row.status !== 'cancelled');
    const paid = billable.filter((row: any) => row.verified_payments > 0 || (row.amount_due === 0 && row.status !== 'pending'));
    const current = normalizedSubscriptions.find((row: any) => ['active','past_due','grace_period'].includes(row.status)) || normalizedSubscriptions[0] || null;
    const endAt = current?.period_ends_at ? new Date(current.period_ends_at) : null;
    const remainingDays = endAt ? Math.ceil((endAt.getTime() - Date.now()) / 86400000) : null;
    const canViewAmounts = has('finance.read');
    const canViewPaymentDetails = has('platform_payment.verify') || has('finance.read');
    const canViewInstructorDetails = has('instructor.detail.read');
    const canViewBillingProfile = has('billing_profile.manage') || canViewAmounts;
    const totalContract = billable.reduce((sum: number, row: any) => sum + row.amount_due, 0);
    const totalPaid = billable.reduce((sum: number, row: any) => sum + row.verified_paid, 0);
    const totalPending = billable.reduce((sum: number, row: any) => sum + row.pending_paid, 0);
    const totalOutstanding = billable.reduce((sum: number, row: any) => sum + row.outstanding, 0);
    const totalPaidMonths = paid.reduce((sum: number, row: any) => sum + row.duration_months, 0);

    const visibleSubscriptions = normalizedSubscriptions.map((row: any) => {
      if (canViewAmounts) return row;
      const { agreed_price, discount_amount, amount_due, verified_paid, pending_paid, outstanding, ...visible } = row;
      return visible;
    });
    const visiblePayments = paymentRows.map((row: any) => canViewPaymentDetails ? {
      ...row, amount: Number(row.amount), duration_months: Number(row.duration_months),
    } : {
      id: row.id, subscription_id: row.subscription_id, status: row.status,
      created_at: row.created_at, reviewed_at: row.reviewed_at, plan_name: row.plan_name,
      duration_months: Number(row.duration_months),
    });

    await execute(
      `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,reason)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, account.tenant_id || null, 'tenant.account_statement.viewed', 'instructor', account.owner_user_id, 'Sensitive instructor account statement accessed']
    );
    return res.json({
      generated_at: new Date().toISOString(),
      permissions: {
        can_view_amounts: canViewAmounts,
        can_view_payment_details: canViewPaymentDetails,
        can_manage_billing_profile: has('billing_profile.manage'),
        can_create_renewal: has('subscription.create'),
        can_submit_payment: has('platform_payment.submit'),
        can_verify_payment: has('platform_payment.verify'),
        can_add_note: has('task.create'),
        can_view_teaching_detail: has('instructor.detail.read'),
        can_view_audit: has('audit.read'),
      },
      instructor: {
        owner_user_id: account.owner_user_id, owner_name: account.owner_name,
        ...(canViewInstructorDetails ? { owner_phone: account.owner_phone, owner_email: account.owner_email } : {}),
        login_active: Boolean(account.login_active), account_created_at: account.account_created_at,
      },
      tenant: account.tenant_id ? {
        id: account.tenant_id, business_name: account.business_name, subject_type: account.subject_type, status: account.tenant_status,
        legacy_compat: Boolean(account.legacy_compat), created_at: account.tenant_created_at,
      } : null,
      billing_profile: account.tenant_id && canViewBillingProfile ? {
        billing_cycle_day: Number(account.billing_cycle_day || 1),
        reminder_days_before: Number(account.reminder_days_before ?? 7),
        collection_status: account.collection_status || 'good_standing',
        next_followup_at: account.next_followup_at || null,
        updated_at: account.billing_updated_at || null,
      } : null,
      teaching: canViewInstructorDetails ? {
        students: Number(teaching?.students || 0), online_students: Number(teaching?.online_students || 0),
        offline_students: Number(teaching?.offline_students || 0), lectures: Number(teaching?.lectures || 0),
      } : null,
      summary: {
        subscription_periods: normalizedSubscriptions.length,
        paid_periods: paid.length,
        paid_months: totalPaidMonths,
        current_plan: current?.plan_name || null,
        current_period_months: current?.duration_months || 0,
        current_status: current?.status || 'unsubscribed',
        current_starts_at: current?.starts_at || null,
        current_ends_at: current?.period_ends_at || null,
        next_renewal_at: current?.period_ends_at || null,
        remaining_days: remainingDays,
        remaining_months_estimate: remainingDays === null ? null : Math.max(0, Number((remainingDays / 30.4375).toFixed(1))),
        last_payment_at: paymentRows.find((row: any) => row.status === 'verified')?.reviewed_at || null,
        ...(canViewAmounts ? {
          total_contract: totalContract, total_verified_paid: totalPaid,
          total_pending: totalPending, total_outstanding: totalOutstanding,
          current_due: current?.outstanding || 0,
          normalized_monthly_price: current?.duration_months ? Number((current.amount_due / current.duration_months).toFixed(2)) : 0,
        } : {}),
      },
      subscriptions: visibleSubscriptions,
      payments: visiblePayments,
      notes: canViewInstructorDetails ? notes : [],
      audit,
      warnings: [
        ...(!account.tenant_id ? ['لا يوجد كيان منصة مرتبط بهذا الحساب القديم؛ يلزم استكمال الترحيل قبل إنشاء تجديد جديد.'] : []),
        ...(totalOutstanding > 0 && canViewAmounts ? [`يوجد رصيد مستحق قدره ${totalOutstanding.toFixed(2)} ج.م.`] : []),
        ...(remainingDays !== null && remainingDays <= 7 ? [`موعد التجديد خلال ${Math.max(0, remainingDays)} يوم.`] : []),
      ],
    });
  } catch (error) {
    console.error('Instructor account statement error:', error);
    return res.status(500).json({ error: 'Failed to load instructor account statement' });
  }
});

router.patch('/instructors/:ownerUserId/billing-profile', requireAdminPermission('billing_profile.manage'), async (req: AuthRequest, res: Response) => {
  try {
    const cycleDay = Number(req.body.billing_cycle_day);
    const reminderDays = Number(req.body.reminder_days_before);
    const collectionStatus = String(req.body.collection_status || 'good_standing');
    const allowedStatuses = ['good_standing','follow_up','overdue','disputed','exempt'];
    const followup = req.body.next_followup_at ? new Date(req.body.next_followup_at) : null;
    if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 28 || !Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > 30 || !allowedStatuses.includes(collectionStatus) || (followup && Number.isNaN(followup.getTime()))) {
      return res.status(400).json({ error: 'Invalid billing profile values' });
    }
    const tenant = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE owner_user_id=?', [req.params.ownerUserId]);
    if (!tenant) return res.status(404).json({ error: 'Instructor tenant not found' });
    const oldValue = await queryOne<any>('SELECT billing_cycle_day,reminder_days_before,collection_status,next_followup_at FROM tenant_billing_profiles WHERE tenant_id=?', [tenant.id]);
    const nextFollowup = followup ? followup.toISOString().slice(0, 19).replace('T', ' ') : null;
    await execute(
      `INSERT INTO tenant_billing_profiles (tenant_id,billing_cycle_day,reminder_days_before,collection_status,next_followup_at,updated_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE billing_cycle_day=VALUES(billing_cycle_day),reminder_days_before=VALUES(reminder_days_before),
       collection_status=VALUES(collection_status),next_followup_at=VALUES(next_followup_at),updated_by=VALUES(updated_by)`,
      [tenant.id, cycleDay, reminderDays, collectionStatus, nextFollowup, req.user!.id]
    );
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, tenant.id, 'tenant.billing_profile_updated', 'tenant_billing_profile', tenant.id,
        JSON.stringify(oldValue || null), JSON.stringify({ billing_cycle_day: cycleDay, reminder_days_before: reminderDays, collection_status: collectionStatus, next_followup_at: nextFollowup })]
    );
    return res.json({ updated: true });
  } catch (error) {
    console.error('Update billing profile error:', error);
    return res.status(500).json({ error: 'Failed to update billing profile' });
  }
});

router.post('/instructors/:ownerUserId/account-notes', requireAdminPermission('task.create'), async (req: AuthRequest, res: Response) => {
  try {
    const body = String(req.body.body || '').trim();
    const noteType = String(req.body.note_type || 'general');
    const allowedTypes = ['general','collection','renewal','dispute','support'];
    const followup = req.body.followup_at ? new Date(req.body.followup_at) : null;
    if (body.length < 3 || body.length > 2000 || !allowedTypes.includes(noteType) || (followup && Number.isNaN(followup.getTime()))) {
      return res.status(400).json({ error: 'Invalid account note' });
    }
    const tenant = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE owner_user_id=?', [req.params.ownerUserId]);
    if (!tenant) return res.status(404).json({ error: 'Instructor tenant not found' });
    const id = randomUUID();
    const followupAt = followup ? followup.toISOString().slice(0, 19).replace('T', ' ') : null;
    await execute(
      'INSERT INTO tenant_account_notes (id,tenant_id,note_type,body,followup_at,created_by) VALUES (?,?,?,?,?,?)',
      [id, tenant.id, noteType, body, followupAt, req.user!.id]
    );
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, tenant.id, 'tenant.account_note_added', 'tenant_account_note', id,
        JSON.stringify({ note_type: noteType, followup_at: followupAt })]
    );
    return res.status(201).json({ id });
  } catch (error) {
    console.error('Add account note error:', error);
    return res.status(500).json({ error: 'Failed to add account note' });
  }
});

router.post('/tenants', requireAdminPermission('instructor.create'), async (req: AuthRequest, res: Response) => {
  try {
    const businessName = String(req.body.business_name ?? '').trim();
    const subjectType = String(req.body.subject_type ?? '').trim();
    const ownerName = String(req.body.owner_name ?? '').trim();
    const email = String(req.body.owner_email ?? '').trim().toLowerCase() || null;
    const phone = String(req.body.owner_phone ?? '').trim() || null;
    const password = String(req.body.password ?? '');
    const planId = String(req.body.plan_id ?? '');
    if (businessName.length < 3 || businessName.length > 255 || subjectType.length < 1 || subjectType.length > 80 || ownerName.length < 3 || ownerName.length > 255 || !phone || password.length < 8 || password.length > 128 || (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      return res.status(400).json({ error: 'Invalid business or owner information' });
    }
    const plan = await queryOne<{ id: string; price: string }>(
      'SELECT id,price FROM platform_plans WHERE id=? AND is_active=1', [planId]
    );
    if (!plan) return res.status(404).json({ error: 'Platform plan not found' });
    const ownerId = randomUUID();
    const tenantId = randomUUID();
    const subscriptionId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO users (id,name,email,phone,password_hash,role,is_active)
         VALUES (?,?,?,?,?,'instructor',0)`,
        [ownerId, ownerName, email, phone, passwordHash]
      );
      await connection.execute(
        'INSERT INTO tenants (id,owner_user_id,business_name,subject_type,status) VALUES (?,?,?,?,?)',
        [tenantId, ownerId, businessName, subjectType, 'pending']
      );
      await connection.execute(
        'INSERT INTO tenant_memberships (id,tenant_id,user_id,role_key) VALUES (?,?,?,?)',
        [randomUUID(), tenantId, ownerId, 'owner']
      );
      await connection.execute(
        `INSERT INTO tenant_subscriptions
         (id,tenant_id,plan_id,status,agreed_price,currency,created_by)
         VALUES (?,?,?,'pending',?,'EGP',?)`,
        [subscriptionId, tenantId, planId, plan.price, req.user!.id]
      );
      await connection.execute(
        `INSERT INTO audit_events
         (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), req.user!.id, tenantId, 'tenant.onboarding_created', 'tenant', tenantId,
          JSON.stringify({ business_name: businessName, subject_type: subjectType, owner_user_id: ownerId, subscription_id: subscriptionId })]
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return res.status(201).json({ tenant_id: tenantId, owner_user_id: ownerId, subscription_id: subscriptionId, status: 'pending' });
  } catch (error) {
    console.error('Create tenant onboarding error:', error);
    return res.status(500).json({ error: 'Failed to create tenant; check duplicate owner contact details' });
  }
});

router.post('/tenants/:id/renewals', requireAdminPermission('subscription.create'), async (req: AuthRequest, res: Response) => {
  const planId = String(req.body.plan_id ?? '');
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [tenantRows] = await connection.execute(
      'SELECT id,status,legacy_compat FROM tenants WHERE id=? FOR UPDATE', [req.params.id]
    );
    const tenant = (tenantRows as Array<{ id: string; status: string; legacy_compat: number }>)[0];
    if (!tenant) { await connection.rollback(); return res.status(404).json({ error: 'Tenant not found' }); }
    if (tenant.status !== 'active' || tenant.legacy_compat) {
      await connection.rollback(); return res.status(409).json({ error: 'Tenant is not eligible for renewal' });
    }
    const [planRows] = await connection.execute(
      'SELECT id,price FROM platform_plans WHERE id=? AND is_active=1', [planId]
    );
    const plan = (planRows as Array<{ id: string; price: string }>)[0];
    if (!plan) { await connection.rollback(); return res.status(404).json({ error: 'Platform plan not found' }); }
    const [pendingRows] = await connection.execute(
      "SELECT id FROM tenant_subscriptions WHERE tenant_id=? AND status='pending' LIMIT 1", [tenant.id]
    );
    if ((pendingRows as Array<{ id: string }>).length) {
      await connection.rollback(); return res.status(409).json({ error: 'A pending renewal already exists' });
    }
    const id = randomUUID();
    await connection.execute(
      `INSERT INTO tenant_subscriptions (id,tenant_id,plan_id,status,agreed_price,currency,created_by)
       VALUES (?,?,?,'pending',?,'EGP',?)`,
      [id, tenant.id, plan.id, plan.price, req.user!.id]
    );
    await connection.execute(
      `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, tenant.id, 'tenant_subscription.renewal_requested', 'tenant_subscription', id,
        JSON.stringify({ plan_id: plan.id, agreed_price: plan.price })]
    );
    await connection.commit();
    return res.status(201).json({ subscription_id: id, status: 'pending' });
  } catch (error) {
    await connection.rollback();
    console.error('Create tenant renewal error:', error);
    return res.status(500).json({ error: 'Failed to create renewal' });
  } finally { connection.release(); }
});

router.post('/subscriptions/:id/payments', requireAdminPermission('platform_payment.submit'), async (req: AuthRequest, res: Response) => {
  try {
    const amount = money(req.body.amount);
    const method = String(req.body.method ?? '').trim();
    const reference = String(req.body.reference_number ?? '').trim();
    const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
    if (!amount || !['bank_transfer', 'instapay', 'mobile_wallet', 'cash'].includes(method) || reference.length < 3 || reference.length > 160 || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
      return res.status(400).json({ error: 'Valid amount, method, reference and Idempotency-Key are required' });
    }
    const id = randomUUID();
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [subscriptionRows] = await connection.execute(
        'SELECT id,status FROM tenant_subscriptions WHERE id=? FOR UPDATE', [req.params.id]
      );
      const subscription = (subscriptionRows as Array<{ id: string; status: string }>)[0];
      if (!subscription) { await connection.rollback(); return res.status(404).json({ error: 'Subscription not found' }); }
      const [existingRows] = await connection.execute(
        'SELECT id FROM platform_payment_attempts WHERE subscription_id=? AND idempotency_key=?',
        [req.params.id, idempotencyKey]
      );
      const existing = (existingRows as Array<{ id: string }>)[0];
      if (existing) { await connection.rollback(); return res.json({ id: existing.id, duplicate: true }); }
      if (subscription.status !== 'pending') {
        await connection.rollback(); return res.status(409).json({ error: 'Subscription is not pending' });
      }
      await connection.execute(
        `INSERT INTO platform_payment_attempts
         (id,subscription_id,amount,method,reference_number,submitted_by,idempotency_key)
         VALUES (?,?,?,?,?,?,?)`,
        [id, req.params.id, amount, method, reference, req.user!.id, idempotencyKey]
      );
      await connection.execute(
        'INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value) VALUES (?,?,?,?,?,?)',
        [randomUUID(), req.user!.id, 'platform_payment.submitted', 'platform_payment', id,
          JSON.stringify({ subscription_id: req.params.id, amount, method, reference_number: reference })]
      );
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    return res.status(201).json({ id, status: 'submitted' });
  } catch (error) {
    console.error('Submit platform payment error:', error);
    return res.status(500).json({ error: 'Failed to submit payment' });
  }
});

router.post('/payments/:id/verify', requireAdminPermission('platform_payment.verify'), async (req: AuthRequest, res: Response) => {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [paymentRows] = await connection.execute(
      `SELECT p.id,p.amount,p.status,p.submitted_by,p.subscription_id,
              s.tenant_id,s.agreed_price,s.discount_amount,s.status AS subscription_status,
              pl.duration_months,pl.duration_days,t.owner_user_id,t.status AS tenant_status
       FROM platform_payment_attempts p
       INNER JOIN tenant_subscriptions s ON s.id=p.subscription_id
       INNER JOIN platform_plans pl ON pl.id=s.plan_id
       INNER JOIN tenants t ON t.id=s.tenant_id
       WHERE p.id=? FOR UPDATE`,
      [req.params.id]
    );
    const payment = (paymentRows as Array<{
      id: string; amount: string; status: string; submitted_by: string; subscription_id: string;
      tenant_id: string; agreed_price: string; discount_amount: string;
      subscription_status: string; duration_months: number; duration_days: number; owner_user_id: string; tenant_status: string;
    }>)[0];
    if (!payment) { await connection.rollback(); return res.status(404).json({ error: 'Payment not found' }); }
    if (payment.status !== 'submitted' || payment.subscription_status !== 'pending') {
      await connection.rollback(); return res.status(409).json({ error: 'Payment or subscription already processed' });
    }
    if (payment.tenant_status !== 'pending' && payment.tenant_status !== 'active') {
      await connection.rollback(); return res.status(409).json({ error: 'Tenant is not eligible for payment verification' });
    }
    if (payment.submitted_by === req.user!.id && !(await isSuperAdmin(req.user!.id))) {
      await connection.rollback(); return res.status(403).json({ error: 'A different administrator must verify this payment' });
    }
    if (Number(payment.amount) < Number(payment.agreed_price) - Number(payment.discount_amount)) {
      await connection.rollback(); return res.status(409).json({ error: 'Verified amount is below subscription amount due' });
    }
    const isOnboarding = payment.tenant_status === 'pending';
    const [previousRows] = await connection.execute(
      `SELECT DATE_FORMAT(MAX(period_ends_at),'%Y-%m-%d %H:%i:%s') AS previous_end,
              DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS now_utc
       FROM tenant_subscriptions
       WHERE tenant_id=? AND id<>? AND status IN ('active','past_due','grace_period')`,
      [payment.tenant_id, payment.subscription_id]
    );
    const period = (previousRows as Array<{ previous_end: string | null; now_utc: string }>)[0];
    const startsAt = period.previous_end && period.previous_end > period.now_utc ? period.previous_end : period.now_utc;
    await connection.execute(
      `UPDATE platform_payment_attempts SET status='verified',reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?`,
      [req.user!.id, payment.id]
    );
    await connection.execute(
        `UPDATE tenant_subscriptions
         SET status='active',starts_at=?,period_ends_at=DATE_ADD(DATE_ADD(?, INTERVAL ? MONTH), INTERVAL ? DAY),
           approved_by=? WHERE id=?`,
        [startsAt, startsAt, payment.duration_months, payment.duration_days, req.user!.id, payment.subscription_id]
    );
    if (isOnboarding) {
      await connection.execute('UPDATE tenants SET status=? WHERE id=?', ['active', payment.tenant_id]);
      await connection.execute('UPDATE users SET is_active=1 WHERE id=?', [payment.owner_user_id]);
    } else {
      await connection.execute('UPDATE users SET is_active=1 WHERE id=?', [payment.owner_user_id]);
    }
    await connection.execute(
      `INSERT INTO audit_events
       (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, payment.tenant_id, 'platform_payment.verified', 'tenant_subscription', payment.subscription_id,
        JSON.stringify({ status: 'pending' }), JSON.stringify({ status: 'active', payment_id: payment.id, starts_at: startsAt })]
    );
    await connection.commit();
    return res.json({ status: 'active', login_enabled: isOnboarding });
  } catch (error) {
    await connection.rollback();
    console.error('Verify platform payment error:', error);
    return res.status(500).json({ error: 'Failed to verify payment' });
  } finally {
    connection.release();
  }
});

router.get('/topups', requireAdminPermission('platform_payment.read'), async (req: AuthRequest, res: Response) => {
  try {
    const pagination = parsePagination(req.query.page, req.query.limit);
    if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
    const { page, limit, offset } = pagination;
    const statusValue = req.query.status;
    const allowedStatuses = ['submitted','verified','rejected','cancelled'];
    if (statusValue !== undefined && (typeof statusValue !== 'string' || !allowedStatuses.includes(statusValue))) {
      return res.status(400).json({ error: 'Invalid top-up status' });
    }
    const status = typeof statusValue === 'string' ? statusValue : '';
    const queryValue = req.query.q;
    if (queryValue !== undefined && (typeof queryValue !== 'string' || queryValue.length > 100)) {
      return res.status(400).json({ error: 'Invalid top-up search query' });
    }
    const q = typeof queryValue === 'string' ? queryValue.trim() : '';
    const filters: string[] = [];
    const params: unknown[] = [];
    if (status) { filters.push('r.status=?'); params.push(status); }
    if (q) { filters.push('(u.name LIKE ? OR u.phone LIKE ? OR t.business_name LIKE ? OR r.reference_number LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = await query<any>(
      `SELECT r.id,r.tenant_id,r.instructor_id,r.purpose_code,r.amount,r.currency,r.method,r.reference_number,
              r.paid_at,r.notes,r.status,r.rejection_reason,r.reviewed_at,r.created_at,
              t.business_name,u.name AS instructor_name,u.phone AS instructor_phone,reviewer.name AS reviewer_name
       FROM instructor_topup_requests r INNER JOIN tenants t ON t.id=r.tenant_id
       INNER JOIN users u ON u.id=r.instructor_id LEFT JOIN users reviewer ON reviewer.id=r.reviewed_by
       ${where} ORDER BY CASE WHEN r.status='submitted' THEN 0 ELSE 1 END,r.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`, params
    );
    const permissions = await getAdminPermissions(req.user!.id);
    const sensitive = (await isSuperAdmin(req.user!.id)) || permissions.includes('finance.read') || permissions.includes('platform_payment.verify');
    const data = sensitive ? rows : rows.map(({ amount: _a, reference_number: _r, notes: _n, ...row }: any) => row);
    return res.json({ data, page, limit });
  } catch (error) { console.error('List instructor top-ups error:', error); return res.status(500).json({ error: 'Failed to load top-ups' }); }
});

router.get('/topups/:id/proof-url', requireAdminPermission('platform_payment.read'), async (req: AuthRequest, res: Response) => {
  try {
    const permissions = await getAdminPermissions(req.user!.id);
    if (!(await isSuperAdmin(req.user!.id)) && !permissions.includes('platform_payment.verify') && !permissions.includes('finance.read')) return res.status(403).json({ error: 'Forbidden' });
    const row = await queryOne<{ proof_object_key: string }>(
      'SELECT proof_object_key FROM instructor_topup_requests WHERE id=?', [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Top-up request not found' });
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,reason)
       VALUES (?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, 'instructor_topup.proof_accessed', 'instructor_topup', req.params.id, 'Sensitive payment proof accessed']
    );
    return res.json({ url: await getPrivateObjectUrl(BUCKETS.PAYMENT_PROOFS, row.proof_object_key, 300), expires_in: 300 });
  } catch (error) { console.error('Get top-up proof URL error:', error); return res.status(500).json({ error: 'Failed to open proof' }); }
});

router.post('/topups/:id/verify', requireAdminPermission('platform_payment.verify'), async (req: AuthRequest, res: Response) => {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT r.*,t.status AS tenant_status FROM instructor_topup_requests r
       INNER JOIN tenants t ON t.id=r.tenant_id WHERE r.id=? FOR UPDATE`, [req.params.id]
    );
    const topup = (rows as any[])[0];
    if (!topup) { await connection.rollback(); return res.status(404).json({ error: 'Top-up request not found' }); }
    if (topup.status !== 'submitted') { await connection.rollback(); return res.status(409).json({ error: 'Top-up request already processed' }); }
    const credit = await postServiceCreditEntry(connection as unknown as PoolConnection, {
      instructorId: topup.instructor_id, actorId: req.user!.id, type: 'credit', amount: topup.amount,
      reason: `شحن رصيد خدمات: ${topup.purpose_code === 'subscription_renewal' ? 'تجديد اشتراك شهري' : 'أخرى'}`,
      referenceType: 'instructor_topup', referenceUuid: topup.id,
    });
    await connection.execute(
      `UPDATE instructor_topup_requests SET status='verified',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),credited_transaction_id=? WHERE id=?`,
      [req.user!.id, credit.transactionId, topup.id]
    );
    let renewal: any = null;
    if (topup.purpose_code === 'subscription_renewal') {
      const [intentRows] = await connection.execute("SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' FOR UPDATE", [topup.tenant_id]);
      let intentId = (intentRows as any[])[0]?.id;
      if (!intentId) {
        const [subscriptionRows] = await connection.execute(
          `SELECT id,plan_id,agreed_price,discount_amount FROM tenant_subscriptions
           WHERE tenant_id=? AND status IN ('active','past_due','grace_period','expired')
           ORDER BY COALESCE(period_ends_at,created_at) DESC LIMIT 1 FOR UPDATE`, [topup.tenant_id]
        );
        const subscription = (subscriptionRows as any[])[0];
        if (!subscription) { await connection.rollback(); return res.status(409).json({ error: 'No renewable subscription found' }); }
        intentId = randomUUID();
        const charge = Math.max(0, Number(subscription.agreed_price) - Number(subscription.discount_amount));
        await connection.execute(
          `INSERT INTO tenant_renewal_intents
           (id,tenant_id,instructor_id,source_subscription_id,source_topup_id,target_plan_id,trigger_type,charge_amount,paid_at)
           VALUES (?,?,?,?,?,?,'topup',?,?)`,
          [intentId, topup.tenant_id, topup.instructor_id, subscription.id, topup.id, subscription.plan_id, String(charge), topup.paid_at]
        );
      }
      renewal = await executeRenewalIntent(connection as unknown as PoolConnection, intentId);
    }
    await connection.execute(
      `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, topup.tenant_id, 'instructor_topup.verified', 'instructor_topup', topup.id,
        JSON.stringify({ amount: topup.amount, purpose_code: topup.purpose_code, balance: credit.balance, renewal: renewal?.status || null })]
    );
    await connection.execute(
      `INSERT INTO notifications (id,user_id,user_type,title,message,type,link)
       VALUES (UUID(),?,'instructor','تم اعتماد الشحن',?,'payment','/instructor-subscription')`,
      [topup.instructor_id, `تم اعتماد شحن ${topup.amount} ج.م وإضافته إلى رصيد خدمات المنصة.`]
    );
    await connection.commit();
    return res.json({ status: 'verified', balance: credit.balance, renewal });
  } catch (error: any) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Top-up or renewal was already processed' });
    console.error('Verify instructor top-up error:', error); return res.status(500).json({ error: 'Failed to verify top-up' });
  } finally { connection.release(); }
});

router.post('/topups/:id/reject', requireAdminPermission('platform_payment.verify'), async (req: AuthRequest, res: Response) => {
  const reason = String(req.body.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: 'Rejection reason is required' });
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [topupRows] = await connection.execute(
      `SELECT instructor_id FROM instructor_topup_requests WHERE id=? AND status='submitted' FOR UPDATE`,
      [req.params.id]
    );
    const topup = (topupRows as any[])[0];
    if (!topup) { await connection.rollback(); return res.status(409).json({ error: 'Top-up request is not pending' }); }
    const [result] = await connection.execute(
      `UPDATE instructor_topup_requests SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),rejection_reason=?
       WHERE id=? AND status='submitted'`, [req.user!.id, reason, req.params.id]
    );
    if (!(result as any).affectedRows) { await connection.rollback(); return res.status(409).json({ error: 'Top-up request is not pending' }); }
    await connection.execute(
      `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,reason) VALUES (?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, 'instructor_topup.rejected', 'instructor_topup', req.params.id, reason]
    );
    await connection.execute(
      `INSERT INTO notifications (id,user_id,user_type,title,message,type,link)
       VALUES (UUID(),?,'instructor','تم رفض إيصال الشحن',?,'payment','/instructor-subscription')`,
      [topup.instructor_id, `لم يتم اعتماد إيصال الشحن. السبب: ${reason}`]
    );
    await connection.commit(); return res.json({ status: 'rejected' });
  } catch (error) { await connection.rollback(); console.error('Reject instructor top-up error:', error); return res.status(500).json({ error: 'Failed to reject top-up' }); }
  finally { connection.release(); }
});

  return router;
};

/**
 * Production binding: the real SQL adapters, the real authentication
 * middleware, the real platform-capability guard, and the real service
 * functions. index.ts imports this default export unchanged.
 */
export default createPlatformTenantsRouter({
  db: {
    query,
    queryOne,
    execute,
    getConnection: () => getPool().getConnection() as unknown as Promise<PlatformTenantsConnection>,
  },
  authenticate: authenticateToken,
  requireAdminPermission,
  getAdminPermissions,
  isSuperAdmin,
  postServiceCreditEntry,
  executeRenewalIntent,
  getPrivateObjectUrl,
});
