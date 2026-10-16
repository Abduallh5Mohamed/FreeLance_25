import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { execute, query, queryOne, getPool } from '../db';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the payment-requests router. Production binds ../db;
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface PaymentRequestsDataAccess {
  query: typeof query;
  queryOne: typeof queryOne;
  execute: typeof execute;
  /**
   * Run `work` inside a single database transaction. Every statement issued
   * through the adapter handed to `work` runs on the transaction connection,
   * so the approve flow's fee/revenue/status writes commit or roll back
   * together (no partial financial write, no duplicate state transition).
   * Production binds the pool; hermetic tests inject an isolated adapter.
   */
  withTransaction: <T>(
    work: (tx: Pick<PaymentRequestsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Injectable seams for the payment-requests router. The default export binds
 * the production SQL adapters, the real authentication middleware, the real
 * role gate, and the server-owned platform-finance and tenant-authority
 * lookups. Tests inject fixtures through this boundary instead of bypassing
 * production authorization.
 */
export interface PaymentRequestsRouterDeps {
  db: PaymentRequestsDataAccess;
  authenticate: RequestHandler;
  authorize: RequestHandler;
  /**
   * Server-verified platform finance-read capability (active super_admin or a
   * seeded platform permission key), resolved against admin_user_roles. A JWT
   * role claim never satisfies this predicate. Production binds the real
   * SQL-backed check; hermetic tests inject isolated fixtures through this
   * same boundary so the production guard runs without a database.
   */
  hasVerifiedPlatformFinanceAccess?: (userId: string) => Promise<boolean>;
  /**
   * Active authority of a principal inside one tenant: the verified owner
   * row, or an active membership with role_key IN ('owner','instructor') in
   * an active tenant by an active user. Mirrors the server-owned authority
   * lookup used by fees.ts / video-access-policy / videos.ts / teaching-access
   * so no new authority vocabulary is invented. Production binds the
   * SQL-backed lookup; hermetic tests inject isolated fixtures through this
   * boundary.
   */
  loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
}

export const createPaymentRequestsRouter = (deps: PaymentRequestsRouterDeps): Router => {
  const router = Router();
  const { query, queryOne, execute, withTransaction } = deps.db;
  router.use(deps.authenticate, deps.authorize);

  // -------------------------------------------------------------------------
  // Server-owned authority model (mirrors fees.ts). A JWT role claim never
  // grants platform or tenant authority; every grant is resolved from
  // server-side rows only. The bare `admin` role label confers nothing.
  // -------------------------------------------------------------------------

  const hasVerifiedPlatformFinanceAccess = deps.hasVerifiedPlatformFinanceAccess
    ?? ((userId: string) => hasVerifiedPlatformPermission('finance.read', userId));

  const loadActiveTenantAuthority = deps.loadActiveTenantAuthority
    ?? (async (userId: string, tenantId: string) => queryOne<{ authority: string }>(
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
    ));

  interface PaymentScope {
    platform: boolean;
    authority: 'owner' | 'instructor' | null;
    userId: string;
    tenantId: string | null;
  }

  /**
   * Verify the platform finance-read capability before any data access. A
   * lookup failure denies with 503 instead of failing open onto a role claim.
   */
  const verifyPlatformFinanceAccess = async (
    req: AuthRequest,
    res: Response,
  ): Promise<boolean | null> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    try {
      return await hasVerifiedPlatformFinanceAccess(user.id);
    } catch (error) {
      console.error('Finance permission lookup failed:', error);
      res.status(503).json({ error: 'Finance permissions unavailable' });
      return null;
    }
  };

  /**
   * Resolve read authority. A verified platform operator (super_admin or a
   * holder of finance.read) reads across tenants; the verified tenant owner
   * or assigned instructor reads the whole tenant. Everyone else — including
   * a bare admin role label, an active membership that is not owner/instructor
   * (e.g. teacher/staff), or a principal with no active workspace — is denied
   * before any query runs.
   */
  const resolveReadScope = async (
    req: AuthRequest,
    res: Response,
  ): Promise<PaymentScope | null> => {
    const platform = await verifyPlatformFinanceAccess(req, res);
    if (platform === null) return null;
    const user = req.user as NonNullable<AuthRequest['user']>;
    if (platform) return { platform: true, authority: null, userId: user.id, tenantId: null };
    const tenantId = user.tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'Workspace access required' });
      return null;
    }
    let authorityRow: { authority: string } | null;
    try {
      authorityRow = await loadActiveTenantAuthority(user.id, tenantId);
    } catch (error) {
      console.error('Tenant authority lookup failed:', error);
      res.status(503).json({ error: 'Tenant authority unavailable' });
      return null;
    }
    if (!authorityRow || (authorityRow.authority !== 'owner' && authorityRow.authority !== 'instructor')) {
      res.status(403).json({ error: 'Payment requests require owner or assigned-instructor authority' });
      return null;
    }
    return { platform: false, authority: authorityRow.authority, userId: user.id, tenantId };
  };

  /**
   * Writes need an active tenant authority: the verified platform capability
   * grants reads only, so a platform principal without a tenant membership is
   * denied before any mutation (unchanged fail-closed write contract).
   */
  const resolveWriteScope = async (
    req: AuthRequest,
    res: Response,
  ): Promise<PaymentScope | null> => {
    const scope = await resolveReadScope(req, res);
    if (!scope) return null;
    if (scope.platform) {
      res.status(403).json({ error: 'Active tenant membership required' });
      return null;
    }
    return scope;
  };

  /** Read clause derived from the resolved scope. Platform reads are global. */
  const readClause = (scope: PaymentScope): { sql: string; params: unknown[] } => {
    if (scope.platform) return { sql: '', params: [] };
    return { sql: ' AND pr.tenant_id=?', params: [scope.tenantId as string] };
  };

  router.get('/', async (req: AuthRequest, res: Response) => {
    try {
      const scope = await resolveReadScope(req, res);
      if (!scope) return;
      const { status, student_id } = req.query;
      const clause = readClause(scope);
      let sql = `SELECT pr.*,s.name AS student_name,s.phone AS student_phone,g.name AS grade_name,gr.name AS group_name
      FROM payment_requests pr LEFT JOIN students s ON pr.student_id=s.id AND s.tenant_id=pr.tenant_id
      LEFT JOIN grades g ON pr.grade_id=g.id LEFT JOIN \`groups\` gr ON pr.group_id=gr.id
      WHERE 1=1${clause.sql}`;
      const params: unknown[] = [...clause.params];
      if (status) { sql += ' AND pr.status=?'; params.push(status); }
      if (student_id) { sql += ' AND pr.student_id=?'; params.push(student_id); }
      sql += ' ORDER BY pr.created_at DESC';
      res.json(await query(sql, params));
    } catch (error) {
      console.error('Get payment requests error:', error);
      res.status(500).json({ error: 'Failed to fetch payment requests' });
    }
  });

  router.post('/', async (req: AuthRequest, res: Response) => {
    try {
      const scope = await resolveWriteScope(req, res);
      if (!scope) return;
      const tenantId = scope.tenantId as string;
      const { student_id, grade_id, group_id, amount, payment_method = 'cash', receipt_image, notes } = req.body;
      if (!student_id || !grade_id || !group_id || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'Missing or invalid payment fields' });
      }
      const student = await queryOne<any>('SELECT id,user_id,name,phone,email,grade_id,group_id FROM students WHERE id=? AND tenant_id=? AND is_active=1', [student_id, tenantId]);
      if (!student) return res.status(404).json({ error: 'Student not found in your tenant' });
      const grade = await queryOne<any>('SELECT id,name FROM grades WHERE id=?', [grade_id]);
      const group = await queryOne<any>(
        `SELECT g.id,g.name FROM \`groups\` g
       INNER JOIN tenant_memberships m ON m.user_id=g.instructor_id AND m.tenant_id=? AND m.status='active'
       INNER JOIN tenants t ON t.id=m.tenant_id
       WHERE g.id=? AND t.status='active'`, [tenantId, group_id]
      );
      if (!grade || !group || String(student.grade_id) !== String(grade_id) || String(student.group_id) !== String(group_id)) {
        return res.status(404).json({ error: 'Student, grade, or group is outside the authenticated tenant' });
      }
      const id = randomUUID();
      await execute(
        `INSERT INTO payment_requests (id,tenant_id,student_id,student_name,phone,email,grade_id,grade_name,group_id,group_name,amount,payment_method,receipt_image_url,notes,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [id, tenantId, student.id, student.name, student.phone, student.email, grade.id, grade.name, group.id, group.name, Number(amount), payment_method, receipt_image || null, notes || null]
      );
      // Notify the PROVEN tenant owner of this request's tenant — never an
      // arbitrary global admin. The recipient relationship is server-verified
      // (tenants.owner_user_id); if it cannot be proven we send nothing rather
      // than leak the request across tenants to an unrelated recipient.
      const owner = await queryOne<any>(
        'SELECT owner_user_id FROM tenants WHERE id=? AND status=?',
        [tenantId, 'active'],
      );
      if (owner?.owner_user_id) {
        await execute(
          `INSERT INTO notifications (user_id,user_type,title,message,type) VALUES (?,'owner','طلب دفع جديد','تم استلام طلب دفع جديد من الطالب','payment_request')`,
          [owner.owner_user_id]
        );
      }
      res.status(201).json({ message: 'Payment request created successfully', id });
    } catch (error) {
      console.error('Create payment request error:', error);
      res.status(500).json({ error: 'Failed to create payment request' });
    }
  });

  router.post('/:id/approve', async (req: AuthRequest, res: Response) => {
    try {
      const scope = await resolveWriteScope(req, res);
      if (!scope) return;
      const tenantId = scope.tenantId as string;
      // One transaction: the fee row, the revenue row, the status transition,
      // and the student notification commit together. The row is locked with
      // FOR UPDATE so two concurrent approvals serialize on it; the second
      // observes status='approved' and is rejected instead of double-posting.
      const outcome = await withTransaction(async (tx) => {
        const request = await tx.queryOne<any>(
          `SELECT * FROM payment_requests WHERE id=? AND tenant_id=? FOR UPDATE`,
          [req.params.id, tenantId]
        );
        if (!request) return { status: 404, body: { error: 'Payment request not found' } };
        if (request.status !== 'pending') return { status: 400, body: { error: 'Request already processed' } };
        const enrollment = await tx.queryOne<any>(
          'SELECT id,user_id,name,phone,guardian_phone,barcode FROM students WHERE id=? AND tenant_id=? AND is_active=1',
          [request.student_id, tenantId]
        );
        if (!enrollment) return { status: 409, body: { error: 'Student enrollment is no longer active' } };
        // Guarded flip FIRST: exactly one caller can move the request out of
        // 'pending'. If another transaction already won, this affects zero rows
        // and the handler returns before writing any fee/revenue row, so the
        // transaction commits nothing. A later write failure throws and rolls
        // the flip back together with the fee and revenue rows.
        const transition = await tx.execute(
          `UPDATE payment_requests SET status='approved',updated_at=NOW() WHERE id=? AND tenant_id=? AND status='pending'`,
          [request.id, tenantId]
        );
        if (transition.affectedRows === 0) return { status: 400, body: { error: 'Request already processed' } };
        await tx.execute(
          `INSERT INTO student_fees (tenant_id,student_id,student_name,phone,guardian_phone,grade_id,grade_name,group_id,group_name,amount,paid_amount,status,payment_method,is_offline,payment_date,payment_year,payment_month,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'paid',?,FALSE,CURDATE(),YEAR(CURDATE()),MONTH(CURDATE()),?)`,
          [request.tenant_id, request.student_id, enrollment.name, enrollment.phone, enrollment.guardian_phone, request.grade_id, request.grade_name, request.group_id, request.group_name, request.amount, request.amount, request.payment_method, request.notes || 'تم الدفع عبر النظام أونلاين']
        );
        await tx.execute(
          `INSERT INTO revenues (tenant_id,amount,source,description,date) VALUES (?,?,'student_fees','مصروفات طالب - دفع أونلاين',CURDATE())`,
          [request.tenant_id, request.amount]
        );
        if (enrollment.user_id) await tx.execute(
          `INSERT INTO notifications (user_id,user_type,title,message,type) VALUES (?,'student','تم قبول طلب الدفع','تم قبول طلب الدفع الخاص بك وإضافة المصروفات','payment_approved')`, [enrollment.user_id]
        );
        return { status: 200, body: { message: 'Payment request approved successfully' } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      console.error('Approve payment request error:', error);
      res.status(500).json({ error: 'Failed to approve payment request' });
    }
  });

  router.post('/:id/reject', async (req: AuthRequest, res: Response) => {
    try {
      const scope = await resolveWriteScope(req, res);
      if (!scope) return;
      const tenantId = scope.tenantId as string;
      const { rejection_reason } = req.body;
      if (!rejection_reason) return res.status(400).json({ error: 'Rejection reason is required' });
      const request = await queryOne<any>(`SELECT * FROM payment_requests WHERE id=? AND tenant_id=?`, [req.params.id, tenantId]);
      if (!request) return res.status(404).json({ error: 'Payment request not found' });
      if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
      const transition = await execute(`UPDATE payment_requests SET status='rejected',rejection_reason=?,updated_at=NOW() WHERE id=? AND tenant_id=? AND status='pending'`, [rejection_reason, request.id, tenantId]);
      // A concurrent rejection already consumed the transition: do not send a
      // second notification for a request this call did not reject.
      if (transition.affectedRows === 0) return res.status(400).json({ error: 'Request already processed' });
      const enrollment = await queryOne<any>('SELECT user_id FROM students WHERE id=? AND tenant_id=?', [request.student_id, tenantId]);
      if (enrollment?.user_id) await execute(
        `INSERT INTO notifications (user_id,user_type,title,message,type) VALUES (?,'student','تم رفض طلب الدفع',?,'payment_rejected')`,
        [enrollment.user_id, `تم رفض طلب الدفع. السبب: ${rejection_reason}`]
      );
      res.json({ message: 'Payment request rejected successfully' });
    } catch (error) {
      console.error('Reject payment request error:', error);
      res.status(500).json({ error: 'Failed to reject payment request' });
    }
  });

  router.get('/stats/summary', async (req: AuthRequest, res: Response) => {
    try {
      const scope = await resolveReadScope(req, res);
      if (!scope) return;
      const clause = scope.platform ? '' : ' AND tenant_id=?';
      const params = scope.platform ? [] : [scope.tenantId as string];
      const rows = await query(
        `SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='approved') AS approved,SUM(status='rejected') AS rejected,
       SUM(CASE WHEN status='approved' THEN amount ELSE 0 END) AS total_approved_amount FROM payment_requests WHERE 1=1${clause}`,
        params
      );
      res.json(rows[0] || {});
    } catch (error) {
      console.error('Payment request stats error:', error);
      res.status(500).json({ error: 'Failed to fetch statistics' });
    }
  });

  return router;
};

/**
 * Production transaction adapter: a dedicated pooled connection whose
 * statements share one BEGIN/COMMIT/ROLLBACK. Mirrors the transaction
 * facility already used by services/service-credit.ts.
 */
const withTransaction: PaymentRequestsDataAccess['withTransaction'] = async (work) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const tx = {
      query: async <T = any>(sql: string, params?: any[]): Promise<T[]> => {
        const [rows] = await connection.execute(sql, params);
        return rows as T[];
      },
      queryOne: async <T = any>(sql: string, params?: any[]): Promise<T | null> => {
        const [rows] = await connection.execute(sql, params);
        const list = rows as T[];
        return list.length > 0 ? list[0] : null;
      },
      execute: async (sql: string, params?: any[]) => {
        const [result] = await connection.execute(sql, params);
        return result as any;
      },
    };
    const result = await work(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const productionDb: PaymentRequestsDataAccess = { query, queryOne, execute, withTransaction };

export default createPaymentRequestsRouter({
  db: productionDb,
  authenticate: authenticateToken,
  authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
});
