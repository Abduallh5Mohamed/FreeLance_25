import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { execute, query, queryOne } from '../db';
import { setNoStoreCacheHeaders } from '../utils/cache-headers';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getAdminPermissions, isSuperAdmin, requireAdminPermission } from '../security/admin-permissions';

const router = Router();
router.use(authenticateToken);

const allowedMonths = new Set([3, 6, 12, 24]);
const reportMonths = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? '12'), 10);
  return allowedMonths.has(parsed) ? parsed : 12;
};
const number = (value: unknown) => Number(value || 0);
const percent = (numerator: number, denominator: number) => denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : null;

router.get('/video-commission', requireAdminPermission('finance.read'), async (req: AuthRequest, res: Response) => {
  const row = await queryOne<{ setting_value: string; updated_at: string }>(
    "SELECT setting_value,updated_at FROM platform_settings WHERE setting_key='video_commission_percent'"
  );
  const permissions = await getAdminPermissions(req.user!.id);
  return res.json({ percent: Number(row?.setting_value ?? 2), updated_at: row?.updated_at ?? null,
    can_manage: (await isSuperAdmin(req.user!.id)) || permissions.includes('video_commission.manage') });
});

router.put('/video-commission', requireAdminPermission('video_commission.manage'), async (req: AuthRequest, res: Response) => {
  const value = Number(req.body.percent);
  if (!Number.isFinite(value) || value < 0 || value > 100) return res.status(400).json({ error: 'Commission must be between 0 and 100' });
  const normalized = value.toFixed(2);
  await execute(`INSERT INTO platform_settings(setting_key,setting_value,updated_by)
    VALUES ('video_commission_percent',?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_by=VALUES(updated_by)`,
    [normalized, req.user!.id]);
  await execute(`INSERT INTO audit_events(id,actor_user_id,action,resource_type,resource_id,new_value,reason)
    VALUES (?,?,?,?,?,?,?)`, [randomUUID(), req.user!.id, 'video_commission.updated', 'platform_setting',
      'video_commission_percent', JSON.stringify({ percent: Number(normalized) }), 'Admin updated video sale commission']);
  return res.json({ percent: Number(normalized) });
});

async function loadFinanceAnalytics(months: number, detailed: boolean) {
  const finance = await queryOne<any>(
    `SELECT
      COALESCE(SUM(CASE WHEN status='verified' AND reviewed_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00') THEN amount ELSE 0 END),0) AS revenue_month,
      COALESCE(SUM(CASE WHEN status='verified' AND reviewed_at>=DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'),INTERVAL 1 MONTH) AND reviewed_at<DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00') THEN amount ELSE 0 END),0) AS revenue_previous_month,
      COALESCE(SUM(CASE WHEN status='verified' THEN amount ELSE 0 END),0) AS revenue_total,
      COALESCE(SUM(CASE WHEN status='submitted' THEN amount ELSE 0 END),0) AS pending_amount,
      SUM(status='verified') AS verified_attempts,
      SUM(status='verified' AND reviewed_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00')) AS verified_month,
      SUM(status='submitted') AS submitted_attempts,
      SUM(status='rejected') AS rejected_attempts,
      AVG(CASE WHEN status IN ('verified','rejected') AND reviewed_at IS NOT NULL AND reviewed_at>=created_at THEN TIMESTAMPDIFF(MINUTE,created_at,reviewed_at)/60 END) AS avg_review_hours
     FROM platform_payment_attempts`
  );
  const serviceFinance = await queryOne<any>(
    `SELECT
      ((SELECT COALESCE(SUM(amount),0) FROM platform_revenue_events)+(SELECT COALESCE(SUM(amount),0) FROM platform_video_revenue)) AS renewal_revenue_total,
      ((SELECT COALESCE(SUM(amount),0) FROM platform_revenue_events WHERE recognized_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'))+(SELECT COALESCE(SUM(amount),0) FROM platform_video_revenue WHERE recognized_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'))) AS renewal_revenue_month,
      ((SELECT COALESCE(SUM(amount),0) FROM platform_revenue_events WHERE recognized_at>=DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'),INTERVAL 1 MONTH) AND recognized_at<DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'))+(SELECT COALESCE(SUM(amount),0) FROM platform_video_revenue WHERE recognized_at>=DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'),INTERVAL 1 MONTH) AND recognized_at<DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'))) AS renewal_revenue_previous_month,
      (SELECT COALESCE(SUM(amount),0) FROM instructor_topup_requests WHERE status='verified') AS topup_cash_total,
      (SELECT COALESCE(SUM(amount),0) FROM instructor_topup_requests WHERE status='submitted') AS topup_pending,
      (SELECT COUNT(*) FROM instructor_topup_requests WHERE status='verified') AS topup_verified,
      (SELECT COUNT(*) FROM instructor_topup_requests WHERE status='verified' AND reviewed_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00')) AS topup_verified_month,
      (SELECT COUNT(*) FROM instructor_topup_requests WHERE status='submitted') AS topup_submitted,
      (SELECT COUNT(*) FROM instructor_topup_requests WHERE status='rejected') AS topup_rejected,
      (SELECT AVG(TIMESTAMPDIFF(MINUTE,created_at,reviewed_at)/60) FROM instructor_topup_requests
        WHERE status IN ('verified','rejected') AND reviewed_at IS NOT NULL AND reviewed_at>=created_at) AS topup_avg_review_hours,
      (SELECT COALESCE(SUM(balance),0) FROM instructor_wallets) AS unused_service_credit`
  );
  const subscriptions = await queryOne<any>(
    `SELECT COUNT(*) AS total_subscriptions,SUM(status='active') AS active_subscriptions,
      SUM(status='pending') AS pending_subscriptions,SUM(status='past_due') AS past_due_subscriptions,
      SUM(status='grace_period') AS grace_subscriptions,SUM(status='expired') AS expired_subscriptions,
      SUM(status='active' AND period_ends_at BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY)) AS expiring_7_days,
      SUM(status='active' AND period_ends_at BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY)) AS expiring_30_days
     FROM tenant_subscriptions`
  );
  const business = await queryOne<any>(
    `SELECT COUNT(*) AS total_tenants,SUM(status='active') AS active_tenants,SUM(status='suspended') AS suspended_tenants,
      SUM(created_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00')) AS new_tenants_month,
      SUM(created_at>=DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00'),INTERVAL 1 MONTH) AND created_at<DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01 00:00:00')) AS new_tenants_previous_month
     FROM tenants WHERE status<>'archived'`
  );
  const teaching = await queryOne<any>(
    `SELECT COUNT(DISTINCT u.id) AS instructors,COUNT(DISTINCT s.id) AS students,
      SUM(s.is_offline=1) AS offline_students,SUM(s.is_offline=0) AS online_students
     FROM users u LEFT JOIN students s ON s.instructor_id=u.id AND s.is_active=1 WHERE u.role='instructor'`
  );
  const quality = await queryOne<any>(
    `SELECT
      (SELECT COUNT(*) FROM students WHERE instructor_id IS NULL) AS unassigned_students,
      (SELECT COUNT(*) FROM tenants t WHERE t.status<>'archived' AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id=t.id)) AS tenants_without_subscription,
      (SELECT COUNT(*) FROM (SELECT reference_number FROM platform_payment_attempts WHERE reference_number IS NOT NULL AND reference_number<>'' GROUP BY reference_number HAVING COUNT(*)>1) duplicates) AS duplicate_references,
      (SELECT COUNT(*) FROM platform_payment_attempts WHERE reviewed_at IS NOT NULL AND reviewed_at<created_at) AS invalid_review_timestamps`
  );

  const revenueMonth = number(finance?.revenue_month) + number(serviceFinance?.renewal_revenue_month);
  const revenuePreviousMonth = number(finance?.revenue_previous_month) + number(serviceFinance?.renewal_revenue_previous_month);
  const verifiedAttempts = number(finance?.verified_attempts) + number(serviceFinance?.topup_verified);
  const rejectedAttempts = number(finance?.rejected_attempts) + number(serviceFinance?.topup_rejected);
  const oldReviewedAttempts = number(finance?.verified_attempts) + number(finance?.rejected_attempts);
  const topupReviewedAttempts = number(serviceFinance?.topup_verified) + number(serviceFinance?.topup_rejected);
  const combinedReviewHours = oldReviewedAttempts + topupReviewedAttempts > 0
    ? ((number(finance?.avg_review_hours) * oldReviewedAttempts) + (number(serviceFinance?.topup_avg_review_hours) * topupReviewedAttempts)) / (oldReviewedAttempts + topupReviewedAttempts)
    : 0;
  const instructors = number(teaching?.instructors);
  const students = number(teaching?.students);
  const newTenantsMonth = number(business?.new_tenants_month);
  const newTenantsPrevious = number(business?.new_tenants_previous_month);

  const trend = await query<any>(
    `SELECT month_key,SUM(revenue) AS revenue,SUM(payments) AS payments,SUM(subscriptions_paid) AS subscriptions_paid
     FROM (
       SELECT DATE_FORMAT(reviewed_at,'%Y-%m') AS month_key,COALESCE(SUM(amount),0) AS revenue,COUNT(*) AS payments,
              COUNT(DISTINCT subscription_id) AS subscriptions_paid
       FROM platform_payment_attempts WHERE status='verified'
         AND reviewed_at>=DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01'),INTERVAL ${months - 1} MONTH)
       GROUP BY DATE_FORMAT(reviewed_at,'%Y-%m')
       UNION ALL
       SELECT DATE_FORMAT(recognized_at,'%Y-%m'),COALESCE(SUM(amount),0),COUNT(*),COUNT(DISTINCT subscription_id)
       FROM platform_revenue_events
       WHERE recognized_at>=DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01'),INTERVAL ${months - 1} MONTH)
       GROUP BY DATE_FORMAT(recognized_at,'%Y-%m')
     ) monthly GROUP BY month_key ORDER BY month_key`
  );
  const subscriptionBreakdown = await query<any>(
    `SELECT status AS label,COUNT(*) AS count,COALESCE(SUM(agreed_price-discount_amount),0) AS amount
     FROM tenant_subscriptions GROUP BY status ORDER BY count DESC`
  );
  const paymentMethods = await query<any>(
    `SELECT method AS label,COUNT(*) AS attempts,SUM(status='verified') AS verified,
            COALESCE(SUM(CASE WHEN status='verified' THEN amount ELSE 0 END),0) AS revenue
     FROM (
       SELECT method,status,amount FROM platform_payment_attempts
       UNION ALL SELECT method,status,amount FROM instructor_topup_requests
     ) attempts GROUP BY method ORDER BY revenue DESC`
  );
  const portfolio = await query<any>(
    `SELECT CASE WHEN student_count=0 THEN '0' WHEN student_count<=10 THEN '1-10'
                 WHEN student_count<=50 THEN '11-50' WHEN student_count<=100 THEN '51-100' ELSE '100+' END AS bucket,
            COUNT(*) AS instructors,SUM(student_count) AS students
     FROM (SELECT u.id,COUNT(s.id) AS student_count FROM users u
           LEFT JOIN students s ON s.instructor_id=u.id AND s.is_active=1
           WHERE u.role='instructor' GROUP BY u.id) portfolio
     GROUP BY bucket ORDER BY FIELD(bucket,'0','1-10','11-50','51-100','100+')`
  );
  const recent = detailed ? await query(
    `SELECT * FROM (
       SELECT p.id,t.business_name,p.amount,p.method,p.reference_number,p.reviewed_at
       FROM platform_payment_attempts p INNER JOIN tenant_subscriptions s ON s.id=p.subscription_id
       INNER JOIN tenants t ON t.id=s.tenant_id WHERE p.status='verified'
       UNION ALL
       SELECT r.id,t.business_name,r.amount,r.method,r.reference_number,r.reviewed_at
       FROM instructor_topup_requests r INNER JOIN tenants t ON t.id=r.tenant_id WHERE r.status='verified'
     ) recent_payments ORDER BY reviewed_at DESC LIMIT 100`
  ) : [];

  return {
    generated_at: new Date().toISOString(), months,
    summary: {
      revenue_month: revenueMonth, revenue_previous_month: revenuePreviousMonth,
      revenue_growth_percent: revenuePreviousMonth > 0 ? Number((((revenueMonth - revenuePreviousMonth) / revenuePreviousMonth) * 100).toFixed(1)) : null,
      revenue_total: number(finance?.revenue_total) + number(serviceFinance?.renewal_revenue_total),
      cash_collected_total: number(finance?.revenue_total) + number(serviceFinance?.topup_cash_total),
      topup_cash_collected: number(serviceFinance?.topup_cash_total),
      unused_service_credit: number(serviceFinance?.unused_service_credit),
      pending_amount: number(finance?.pending_amount) + number(serviceFinance?.topup_pending),
      verified_month: number(finance?.verified_month) + number(serviceFinance?.topup_verified_month), verified_attempts: verifiedAttempts,
      submitted_attempts: number(finance?.submitted_attempts) + number(serviceFinance?.topup_submitted), rejected_attempts: rejectedAttempts,
      payment_approval_rate: percent(verifiedAttempts, verifiedAttempts + rejectedAttempts),
      average_verified_payment: verifiedAttempts > 0 ? Number(((number(finance?.revenue_total) + number(serviceFinance?.topup_cash_total)) / verifiedAttempts).toFixed(2)) : 0,
      avg_review_hours: Number(combinedReviewHours.toFixed(1)),
      total_subscriptions: number(subscriptions?.total_subscriptions), active_subscriptions: number(subscriptions?.active_subscriptions),
      pending_subscriptions: number(subscriptions?.pending_subscriptions), past_due_subscriptions: number(subscriptions?.past_due_subscriptions),
      grace_subscriptions: number(subscriptions?.grace_subscriptions), expired_subscriptions: number(subscriptions?.expired_subscriptions),
      expiring_7_days: number(subscriptions?.expiring_7_days), expiring_30_days: number(subscriptions?.expiring_30_days),
      total_tenants: number(business?.total_tenants), active_tenants: number(business?.active_tenants), suspended_tenants: number(business?.suspended_tenants),
      new_tenants_month: newTenantsMonth,
      tenant_growth_percent: newTenantsPrevious > 0 ? Number((((newTenantsMonth - newTenantsPrevious) / newTenantsPrevious) * 100).toFixed(1)) : null,
      instructors, students, online_students: number(teaching?.online_students), offline_students: number(teaching?.offline_students),
      average_students_per_instructor: instructors > 0 ? Number((students / instructors).toFixed(1)) : 0,
      unassigned_students: number(quality?.unassigned_students), tenants_without_subscription: number(quality?.tenants_without_subscription),
      duplicate_references: number(quality?.duplicate_references), invalid_review_timestamps: number(quality?.invalid_review_timestamps),
    },
    trend: trend.map(row => ({ month_key: row.month_key, revenue: number(row.revenue), payments: number(row.payments), subscriptions_paid: number(row.subscriptions_paid) })),
    subscription_breakdown: subscriptionBreakdown.map(row => ({ label: row.label, count: number(row.count), amount: number(row.amount) })),
    payment_methods: paymentMethods.map(row => ({ label: row.label, attempts: number(row.attempts), verified: number(row.verified), revenue: number(row.revenue) })),
    instructor_portfolio: portfolio.map(row => ({ bucket: row.bucket, instructors: number(row.instructors), students: number(row.students) })),
    recent, detailed,
  };
}

router.get('/finance', requireAdminPermission('finance.read'), async (req: AuthRequest, res: Response) => {
  try {
    const [permissions, superAdmin] = await Promise.all([
      getAdminPermissions(req.user!.id),
      isSuperAdmin(req.user!.id),
    ]);
    const has = (permission: string) => superAdmin || permissions.includes(permission);
    const data = await loadFinanceAnalytics(reportMonths(req.query.months), has('platform_payment.read'));
    return res.json({
      ...data,
      can_export: has('finance.export'),
      can_calculate: has('analytics.calculate'),
      can_export_pdf: has('analytics.export_pdf'),
    });
  } catch (error) {
    console.error('Admin finance report error:', error);
    return res.status(500).json({ error: 'Failed to load the finance report' });
  }
});

const csvCell = (value: unknown) => {
  let valueText = String(value ?? '');
  if (/^[=+\-@]/.test(valueText)) valueText = `'${valueText}`;
  return `"${valueText.replace(/"/g, '""')}"`;
};

const summaryCsvLabels: Record<string, string> = {
  revenue_month: 'إيراد هذا الشهر', revenue_previous_month: 'إيراد الشهر السابق', revenue_growth_percent: 'نمو الإيراد %',
  revenue_total: 'إجمالي الإيراد المؤكد', pending_amount: 'مبالغ قيد المراجعة', verified_month: 'دفعات مؤكدة هذا الشهر',
  cash_collected_total: 'إجمالي التحصيل النقدي المعتمد', topup_cash_collected: 'شحن رصيد الخدمات المعتمد',
  unused_service_credit: 'رصيد خدمات غير مستخدم',
  verified_attempts: 'إجمالي المحاولات المؤكدة', submitted_attempts: 'محاولات معلقة', rejected_attempts: 'محاولات مرفوضة',
  payment_approval_rate: 'نسبة قبول الدفع %', average_verified_payment: 'متوسط الدفعة المؤكدة', avg_review_hours: 'متوسط ساعات المراجعة',
  total_subscriptions: 'إجمالي فترات الاشتراك', active_subscriptions: 'اشتراكات نشطة', pending_subscriptions: 'اشتراكات معلقة',
  past_due_subscriptions: 'اشتراكات مستحقة', grace_subscriptions: 'اشتراكات داخل المهلة', expired_subscriptions: 'اشتراكات منتهية',
  expiring_7_days: 'تنتهي خلال 7 أيام', expiring_30_days: 'تنتهي خلال 30 يومًا', total_tenants: 'إجمالي حسابات النشاط',
  active_tenants: 'حسابات نشاط نشطة', suspended_tenants: 'حسابات نشاط موقوفة', new_tenants_month: 'حسابات جديدة هذا الشهر',
  tenant_growth_percent: 'نمو الحسابات %', instructors: 'عدد المدرسين', students: 'عدد الطلاب المرتبطين',
  online_students: 'طلاب أونلاين', offline_students: 'طلاب أوفلاين', average_students_per_instructor: 'متوسط الطلاب لكل مدرس',
  unassigned_students: 'طلاب غير مرتبطين', tenants_without_subscription: 'حسابات دون اشتراك', duplicate_references: 'مراجع دفع مكررة',
  invalid_review_timestamps: 'تواريخ مراجعة غير منطقية',
};

router.get('/finance/export', requireAdminPermission('finance.export'), async (req: AuthRequest, res: Response) => {
  try {
    const permissions = await getAdminPermissions(req.user!.id);
    const data = await loadFinanceAnalytics(reportMonths(req.query.months), permissions.includes('platform_payment.read'));
    const rows: unknown[][] = [
      ['تقرير تحليلات المنصة'], ['وقت الإنشاء UTC', data.generated_at], ['الفترة بالشهور', data.months], [],
      ['المؤشر', 'القيمة'], ...Object.entries(data.summary).map(([key, value]) => [summaryCsvLabels[key] || key, value]), [],
      ['الاتجاه الشهري'], ['الشهر', 'الإيراد المؤكد', 'عدد الدفعات', 'اشتراكات مدفوعة'],
      ...data.trend.map(row => [row.month_key, row.revenue, row.payments, row.subscriptions_paid]), [],
      ['حالات الاشتراك'], ['الحالة', 'العدد', 'القيمة المتعاقد عليها'],
      ...data.subscription_breakdown.map(row => [row.label, row.count, row.amount]), [],
      ['وسائل الدفع'], ['الوسيلة', 'المحاولات', 'المؤكد', 'الإيراد'],
      ...data.payment_methods.map(row => [row.label, row.attempts, row.verified, row.revenue]), [],
      ['توزيع أحجام المدرسين'], ['نطاق عدد الطلاب', 'عدد المدرسين', 'عدد الطلاب'],
      ...data.instructor_portfolio.map(row => [row.bucket, row.instructors, row.students]), [],
      ['تعريفات أساسية'], ['المؤشر', 'طريقة الحساب'],
      ['إيراد المنصة', 'دفعات الاشتراك المباشرة القديمة، وتجديدات الرصيد عند الخصم؛ لا يشمل الرصيد غير المستخدم أو أموال الطلاب'],
      ['التحصيل النقدي', 'دفعات الاشتراك المباشرة وشحنات الرصيد المعتمدة بتاريخ اعتمادها'],
      ['رصيد الخدمات القائم', 'إجمالي أرصدة المدرسين التي لم تُستهلك بعد؛ التزام خدمات وليس إيراد اشتراك محققًا'],
      ['نسبة قبول الدفع', 'المؤكد ÷ (المؤكد + المرفوض)؛ المحاولات المعلقة مستبعدة'],
      ['القيمة المتعاقد عليها', 'سعر فترات الاشتراك بعد الخصم؛ لا تعني بالضرورة إيرادًا محققًا'],
      ['متوسط الطلاب لكل مدرس', 'الطلاب النشطون المرتبطون ÷ جميع حسابات المدرسين'],
      ['نمو الحسابات', 'الحسابات المنشأة هذا الشهر مقارنة بالشهر السابق'],
    ];
    if (data.detailed) {
      rows.push([], ['تفاصيل الدفعات - متاحة للمالية فقط'], ['النشاط', 'المبلغ', 'الوسيلة', 'المرجع', 'تاريخ التحقق']);
      for (const item of data.recent as any[]) rows.push([item.business_name, item.amount, item.method, item.reference_number, item.reviewed_at]);
    }
    const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, 'finance_report.exported', 'finance_report', 'aggregate', JSON.stringify({ months: data.months, detailed: data.detailed }), 'CSV analytics export']
    );
    setNoStoreCacheHeaders(res);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="platform-analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error('Admin finance export error:', error);
    return res.status(500).json({ error: 'Failed to export the finance report' });
  }
});

const analyticsMetrics = new Set([
  'revenue_month', 'revenue_previous_month', 'revenue_total', 'cash_collected_total', 'topup_cash_collected',
  'unused_service_credit', 'pending_amount', 'verified_month',
  'verified_attempts', 'submitted_attempts', 'rejected_attempts', 'payment_approval_rate',
  'average_verified_payment', 'avg_review_hours', 'total_subscriptions', 'active_subscriptions',
  'pending_subscriptions', 'past_due_subscriptions', 'grace_subscriptions', 'expired_subscriptions',
  'expiring_7_days', 'expiring_30_days', 'total_tenants', 'active_tenants', 'suspended_tenants',
  'new_tenants_month', 'instructors', 'students', 'online_students', 'offline_students',
  'average_students_per_instructor', 'unassigned_students', 'tenants_without_subscription', 'duplicate_references', 'invalid_review_timestamps',
]);
const calculationOperators = new Set(['add', 'subtract', 'multiply', 'divide', 'percent_of', 'growth']);
const calculationFormats = new Set(['number', 'money', 'percent']);

router.get('/finance/calculations', requireAdminPermission('analytics.calculate'), async (req: AuthRequest, res: Response) => {
  try {
    return res.json(await query(
      `SELECT id,name,left_metric,operator,right_metric,constant_value,result_format,created_at
       FROM analyst_calculations WHERE user_id=? ORDER BY created_at DESC`, [req.user!.id]
    ));
  } catch (error) {
    console.error('List analyst calculations error:', error);
    return res.status(500).json({ error: 'Failed to load saved calculations' });
  }
});

router.post('/finance/calculations', requireAdminPermission('analytics.calculate'), async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body.name ?? '').trim();
    const leftMetric = String(req.body.left_metric ?? '');
    const operator = String(req.body.operator ?? '');
    const rightMetric = String(req.body.right_metric ?? '') || null;
    const rawConstant = req.body.constant_value;
    const constantValue = rawConstant === '' || rawConstant == null ? null : Number(rawConstant);
    const resultFormat = String(req.body.result_format ?? 'number');
    if (name.length < 3 || name.length > 100 || !analyticsMetrics.has(leftMetric) || !calculationOperators.has(operator) ||
        (rightMetric && !analyticsMetrics.has(rightMetric)) || (!rightMetric && (constantValue == null || !Number.isFinite(constantValue))) ||
        !calculationFormats.has(resultFormat) || (constantValue != null && Math.abs(constantValue) > 1_000_000_000_000)) {
      return res.status(400).json({ error: 'Invalid analytical calculation' });
    }
    const id = randomUUID();
    await execute(
      `INSERT INTO analyst_calculations (id,user_id,name,left_metric,operator,right_metric,constant_value,result_format)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.user!.id, name, leftMetric, operator, rightMetric, constantValue, resultFormat]
    );
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, 'analytics.calculation.created', 'analyst_calculation', id,
        JSON.stringify({ name, left_metric: leftMetric, operator, right_metric: rightMetric, constant_value: constantValue, result_format: resultFormat }),
        'Analyst-created post-query calculation']
    );
    return res.status(201).json({ id });
  } catch (error) {
    console.error('Create analyst calculation error:', error);
    return res.status(500).json({ error: 'Failed to save calculation' });
  }
});

router.delete('/finance/calculations/:id', requireAdminPermission('analytics.calculate'), async (req: AuthRequest, res: Response) => {
  try {
    const calculation = await queryOne<{ id: string; name: string }>('SELECT id,name FROM analyst_calculations WHERE id=? AND user_id=?', [req.params.id, req.user!.id]);
    if (!calculation) return res.status(404).json({ error: 'Calculation not found' });
    await execute('DELETE FROM analyst_calculations WHERE id=? AND user_id=?', [calculation.id, req.user!.id]);
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,old_value,reason)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, 'analytics.calculation.deleted', 'analyst_calculation', calculation.id,
        JSON.stringify({ name: calculation.name }), 'Deleted by calculation owner']
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Delete analyst calculation error:', error);
    return res.status(500).json({ error: 'Failed to delete calculation' });
  }
});

router.post('/finance/pdf-export-event', requireAdminPermission('analytics.export_pdf'), async (req: AuthRequest, res: Response) => {
  try {
    const months = reportMonths(req.body.months);
    const calculationCount = Math.min(100, Math.max(0, Number(req.body.calculation_count) || 0));
    await execute(
      `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,new_value,reason)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), req.user!.id, 'analytics_report.pdf_exported', 'analytics_report', 'aggregate',
        JSON.stringify({ months, calculation_count: calculationCount }), 'Client-rendered A4 PDF export completed']
    );
    return res.status(201).json({ recorded: true });
  } catch (error) {
    console.error('Record analyst PDF export error:', error);
    return res.status(500).json({ error: 'Failed to record PDF export' });
  }
});

router.get('/security', requireAdminPermission('security.read'), async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = 50;
    const summary = await queryOne<{ events_24h: number; admin_changes_24h: number; financial_changes_24h: number }>(
      `SELECT COUNT(*) AS events_24h,
        SUM(action LIKE 'admin_member.%' OR action LIKE 'admin_role.%') AS admin_changes_24h,
        SUM(action LIKE 'platform_payment.%' OR action LIKE 'service_credit.%') AS financial_changes_24h
       FROM audit_events WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 24 HOUR)`
    );
    const events = await query(
      `SELECT a.id,a.action,a.resource_type,a.resource_id,a.reason,a.request_id,a.created_at,
              u.name AS actor_name,t.business_name
       FROM audit_events a
       LEFT JOIN users u ON u.id=a.actor_user_id
       LEFT JOIN tenants t ON t.id=a.tenant_id
       ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`
    );
    return res.json({
      summary: {
        events_24h: number(summary?.events_24h),
        admin_changes_24h: number(summary?.admin_changes_24h),
        financial_changes_24h: number(summary?.financial_changes_24h),
      }, events, page, limit,
    });
  } catch (error) {
    console.error('Admin security feed error:', error);
    return res.status(500).json({ error: 'Failed to load the security feed' });
  }
});

export default router;
