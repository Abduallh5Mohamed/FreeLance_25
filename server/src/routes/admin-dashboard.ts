import { Router, Response } from 'express';
import { query, queryOne } from '../db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getAdminPermissions, isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';

const router = Router();
router.use(authenticateToken);

type Metric = { key: string; label: string; value: number | string; href?: string; tone?: string };
type QueueItem = { id: string; title: string; detail?: string; status?: string; created_at?: string; href: string };

const roleMeta: Record<string, { title: string; description: string }> = {
  super_admin: { title: 'مركز قيادة المنصة', description: 'صورة شاملة عن التشغيل والاشتراكات والمال والدعم والأمان.' },
  operations_admin: { title: 'مساحة عمل العمليات', description: 'تهيئة المدرسين، حالات الاشتراك، والمهام التشغيلية التي تحتاج متابعة.' },
  billing_admin: { title: 'مساحة عمل المالية', description: 'دفعات اشتراكات المنصة، الإيراد، التجديدات والاستثناءات المالية.' },
  support_admin: { title: 'مساحة عمل الدعم', description: 'تذاكر المستخدمين والحالات المصعّدة والمهام المرتبطة بالدعم.' },
  security_admin: { title: 'مساحة عمل الأمان', description: 'أحداث التدقيق والحوادث والمهام الأمنية فقط.' },
  analyst: { title: 'مركز التحليلات الإدارية', description: 'اتجاهات ورسوم وحسابات مخصصة وسيناريوهات What-if، مع تقارير CSV وPDF آمنة دون بيانات شخصية.' },
};

router.get('/', requireAdminPermission('admin.dashboard.read'), async (req: AuthRequest, res: Response) => {
  try {
    const permissions = await getAdminPermissions(req.user!.id);
    const superAdmin = await isSuperAdmin(req.user!.id);
    const roleRows = await query<{ role_code: string }>(
      'SELECT role_code FROM admin_user_roles WHERE user_id=? ORDER BY role_code', [req.user!.id]
    );
    const roles = roleRows.map(row => row.role_code);
    const primaryRole = roles.includes('super_admin') ? 'super_admin' : (roles[0] || 'operations_admin');
    const meta = roleMeta[primaryRole] || { title: 'مساحة عمل الإدارة', description: 'الأدوات والبيانات المسموح بها لدورك.' };
    const metrics: Metric[] = [];
    const queues: Array<{ key: string; title: string; href: string; items: QueueItem[] }> = [];

    if (permissions.includes('instructor.read')) {
      const counts = await queryOne<{ total: number; active: number; suspended: number; students: number }>(
        `SELECT COUNT(DISTINCT u.id) AS total,
                COUNT(DISTINCT CASE WHEN u.is_active=1 AND t.status='active' THEN u.id END) AS active,
                COUNT(DISTINCT CASE WHEN u.is_active<>1 OR t.status='suspended' THEN u.id END) AS suspended,
                COUNT(DISTINCT s.id) AS students
         FROM users u LEFT JOIN tenants t ON t.owner_user_id=u.id
         LEFT JOIN students s ON s.instructor_id=u.id AND s.is_active=1
         WHERE u.role='instructor'`
      );
      metrics.push(
        { key: 'instructors', label: 'إجمالي المدرسين', value: Number(counts?.total || 0), href: '/admin/instructors', tone: 'indigo' },
        { key: 'active_instructors', label: 'مدرسون نشطون', value: Number(counts?.active || 0), href: '/admin/instructors', tone: 'emerald' },
        { key: 'suspended_instructors', label: 'حسابات موقوفة', value: Number(counts?.suspended || 0), href: '/admin/instructors', tone: 'rose' },
        { key: 'assigned_students', label: 'طلاب مرتبطون بمدرس', value: Number(counts?.students || 0), tone: 'blue' },
      );
    }

    if (permissions.includes('subscription.read')) {
      const subscriptions = await queryOne<{ pending: number; grace: number; expiring: number }>(
        `SELECT SUM(status='pending') AS pending,SUM(status='grace_period') AS grace,
                SUM(status='active' AND period_ends_at BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY)) AS expiring
         FROM tenant_subscriptions`
      );
      metrics.push(
        { key: 'pending_subscriptions', label: 'اشتراكات معلّقة', value: Number(subscriptions?.pending || 0), href: '/admin/platform', tone: 'amber' },
        { key: 'expiring_subscriptions', label: 'تنتهي خلال 7 أيام', value: Number(subscriptions?.expiring || 0), href: '/admin/platform', tone: 'orange' },
        { key: 'grace_subscriptions', label: 'داخل مهلة 4 أيام', value: Number(subscriptions?.grace || 0), href: '/admin/platform', tone: 'rose' },
      );
    }

    if (permissions.includes('platform_payment.read')) {
      const paymentCount = await queryOne<{ pending: number }>(
        "SELECT COUNT(*) AS pending FROM platform_payment_attempts WHERE status='submitted'"
      );
      metrics.push({ key: 'pending_platform_payments', label: 'دفعات تحتاج مراجعة', value: Number(paymentCount?.pending || 0), href: '/admin/platform', tone: 'amber' });
      if (primaryRole !== 'analyst') {
        const includeMoney = permissions.includes('finance.read');
        const paymentRows = await query<{ id: string; business_name: string; amount: string; status: string; created_at: string }>(
          `SELECT p.id,t.business_name,p.amount,p.status,p.created_at FROM platform_payment_attempts p
           INNER JOIN tenant_subscriptions s ON s.id=p.subscription_id INNER JOIN tenants t ON t.id=s.tenant_id
           WHERE p.status='submitted' ORDER BY p.created_at DESC LIMIT 5`
        );
        queues.push({ key: 'payments', title: 'دفعات بانتظار المراجعة', href: '/admin/platform', items: paymentRows.map(row => ({
          id: row.id, title: row.business_name, detail: includeMoney ? `${row.amount} ج.م` : 'تفاصيل المبلغ متاحة للمالية فقط',
          status: row.status, created_at: row.created_at, href: '/admin/platform',
        })) });
      }
    }

    if (permissions.includes('finance.read')) {
      const revenue = await queryOne<{ month_revenue: string; verified_count: number }>(
        `SELECT COALESCE(SUM(amount),0) AS month_revenue,COUNT(*) AS verified_count
         FROM platform_payment_attempts WHERE status='verified'
           AND reviewed_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00')`
      );
      metrics.push(
        { key: 'platform_revenue_month', label: 'إيراد المنصة هذا الشهر', value: `${Number(revenue?.month_revenue || 0).toLocaleString('ar-EG')} ج.م`, tone: 'emerald' },
        { key: 'verified_payments_month', label: 'دفعات مؤكدة هذا الشهر', value: Number(revenue?.verified_count || 0), tone: 'blue' },
      );
    }

    if (permissions.includes('support.read')) {
      const tickets = await queryOne<{ open_count: number; urgent: number }>(
        `SELECT SUM(status NOT IN ('resolved','closed')) AS open_count,
                SUM(priority='urgent' AND status NOT IN ('resolved','closed')) AS urgent FROM support_tickets`
      );
      metrics.push(
        { key: 'open_support', label: 'تذاكر دعم مفتوحة', value: Number(tickets?.open_count || 0), href: '/support', tone: 'blue' },
        { key: 'urgent_support', label: 'تذاكر عاجلة', value: Number(tickets?.urgent || 0), href: '/support', tone: 'rose' },
      );
      const ticketRows = await query<{ id: string; ticket_number: string; subject: string; priority: string; created_at: string }>(
        `SELECT id,ticket_number,subject,priority,created_at FROM support_tickets
         WHERE status NOT IN ('resolved','closed')
         ORDER BY FIELD(priority,'urgent','high','normal','low'),updated_at DESC LIMIT 5`
      );
      queues.push({ key: 'support', title: 'أولوية الدعم', href: '/support', items: ticketRows.map(row => ({
        id: row.id, title: row.subject, detail: row.ticket_number, status: row.priority, created_at: row.created_at, href: '/support',
      })) });
    }

    if (permissions.includes('task.read')) {
      const scopeClause = superAdmin
        ? '1=1'
        : `(w.created_by=? OR w.assigned_admin_id=? OR EXISTS
           (SELECT 1 FROM admin_team_memberships tm WHERE tm.team_id=w.assigned_team_id AND tm.user_id=?))`;
      const scopeParams = superAdmin ? [] : [req.user!.id, req.user!.id, req.user!.id];
      const taskCounts = await queryOne<{ open_count: number; overdue: number }>(
        `SELECT SUM(w.status NOT IN ('resolved','closed','cancelled')) AS open_count,
                SUM(w.due_at<UTC_TIMESTAMP() AND w.status NOT IN ('resolved','closed','cancelled')) AS overdue
         FROM admin_work_items w WHERE ${scopeClause}`, scopeParams
      );
      metrics.push(
        { key: 'open_tasks', label: 'مهام ظاهرة لك', value: Number(taskCounts?.open_count || 0), href: '/admin/operations', tone: 'indigo' },
        { key: 'overdue_tasks', label: 'مهام متأخرة', value: Number(taskCounts?.overdue || 0), href: '/admin/operations', tone: 'rose' },
      );
      const taskRows = await query<{ id: string; title: string; status: string; priority: string; created_at: string }>(
        `SELECT w.id,w.title,w.status,w.priority,w.created_at FROM admin_work_items w
         WHERE ${scopeClause} AND w.status NOT IN ('resolved','closed','cancelled')
         ORDER BY (w.due_at IS NOT NULL AND w.due_at<UTC_TIMESTAMP()) DESC,
                  FIELD(w.priority,'critical','urgent','high','normal','low'),w.updated_at DESC LIMIT 5`, scopeParams
      );
      queues.push({ key: 'tasks', title: 'مهامي ومهام فريقي', href: '/admin/operations', items: taskRows.map(row => ({
        id: row.id, title: row.title, detail: row.priority, status: row.status, created_at: row.created_at, href: '/admin/operations',
      })) });
    }

    if (permissions.includes('approval.read')) {
      const approvals = await queryOne<{ pending: number }>("SELECT COUNT(*) AS pending FROM admin_approval_requests WHERE status='pending'");
      metrics.push({ key: 'pending_approvals', label: 'موافقات معلّقة', value: Number(approvals?.pending || 0), href: '/admin/approvals', tone: 'amber' });
    }

    if (permissions.includes('admin_roles.manage')) {
      const admins = await queryOne<{ active_count: number }>(
        `SELECT COUNT(DISTINCT ar.user_id) AS active_count FROM admin_user_roles ar
         INNER JOIN users u ON u.id=ar.user_id AND u.is_active=1`
      );
      metrics.push({ key: 'admin_members', label: 'حسابات الإدارة النشطة', value: Number(admins?.active_count || 0), href: '/admin/team', tone: 'violet' });
    }

    if (permissions.includes('audit.read')) {
      const audit = await queryOne<{ events: number }>('SELECT COUNT(*) AS events FROM audit_events WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 24 HOUR)');
      metrics.push({ key: 'audit_events', label: 'أحداث تدقيق خلال 24 ساعة', value: Number(audit?.events || 0), tone: 'slate' });
      const events = await query<{ id: string; action: string; resource_type: string; created_at: string }>(
        'SELECT id,action,resource_type,created_at FROM audit_events ORDER BY created_at DESC LIMIT 5'
      );
      queues.push({ key: 'audit', title: 'أحدث أحداث التدقيق', href: '/admin', items: events.map(row => ({
        id: row.id, title: row.action, detail: row.resource_type, created_at: row.created_at, href: '/admin',
      })) });
    }

    return res.json({ roles, primary_role: primaryRole, title: meta.title, description: meta.description, permissions, metrics, queues });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    return res.status(500).json({ error: 'Failed to load the permitted admin dashboard' });
  }
});

export default router;
