import { randomUUID } from 'crypto';
import { getPool } from '../db';
import { tryPendingRenewalForTenant } from './subscription-renewal';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

interface DueSubscription {
  id: string;
  tenant_id: string;
  status: 'active' | 'past_due' | 'grace_period';
  cancel_at_period_end: number;
  period_plus_grace_expired: number;
  owner_user_id: string;
}

async function notifyBillingOnce(connection: PoolConnection, subscriptionId: string, userId: string, eventCode: string, title: string, message: string) {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT IGNORE INTO billing_notification_events (id,subscription_id,event_code) VALUES (?,?,?)`,
    [randomUUID(), subscriptionId, eventCode]
  );
  if (result.affectedRows) {
    await connection.execute(
      `INSERT INTO notifications (id,user_id,user_type,title,message,type,link)
       VALUES (UUID(),?,'instructor',?,?,'subscription','/instructor-subscription')`,
      [userId, title, message]
    );
  }
}

export async function reconcileTenantSubscriptions(): Promise<number> {
  const connection = await getPool().getConnection();
  let acquired = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK('tenant_subscription_lifecycle',0) AS acquired");
    acquired = (lockRows as Array<{ acquired: number }>)[0]?.acquired === 1;
    if (!acquired) return 0;
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT s.id,s.tenant_id,s.status,s.cancel_at_period_end,t.owner_user_id,
              (DATE_ADD(period_ends_at,INTERVAL 4 DAY)<=UTC_TIMESTAMP()) AS period_plus_grace_expired
       FROM tenant_subscriptions s INNER JOIN tenants t ON t.id=s.tenant_id
       WHERE (s.status IN ('active','past_due') AND s.period_ends_at<=UTC_TIMESTAMP())
          OR (s.status='grace_period' AND s.grace_until<=UTC_TIMESTAMP())
       ORDER BY s.period_ends_at LIMIT 100 FOR UPDATE`
    );
    const due = rows as DueSubscription[];
    for (const item of due) {
      const renewal = item.cancel_at_period_end ? null : await tryPendingRenewalForTenant(connection, item.tenant_id);
      if (renewal?.status === 'executed') continue;
      const next = item.cancel_at_period_end ? 'cancelled'
        : item.status === 'grace_period' || item.period_plus_grace_expired ? 'expired' : 'grace_period';
      await connection.execute(
        `UPDATE tenant_subscriptions SET status=?,grace_until=CASE WHEN ?='grace_period'
         THEN DATE_ADD(period_ends_at,INTERVAL 4 DAY) ELSE grace_until END WHERE id=?`,
        [next, next, item.id]
      );
      if (next === 'grace_period') {
        await notifyBillingOnce(connection, item.id, item.owner_user_id, 'grace_started', 'بدأت مهلة التجديد', 'انتهت فترة اشتراكك وبدأت مهلة الأربعة أيام. اشحن الرصيد قبل انتهاء العد التنازلي.');
      } else if (next === 'expired') {
        await notifyBillingOnce(connection, item.id, item.owner_user_id, 'billing_only', 'تم إيقاف أدوات التدريس مؤقتًا', 'انتهت مهلة التجديد وأصبح الحساب في وضع الدفع والدعم فقط حتى إتمام التجديد.');
      }
      await connection.execute(
        `INSERT INTO audit_events
         (id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), item.tenant_id, 'tenant_subscription.lifecycle', 'tenant_subscription', item.id,
          JSON.stringify({ status: item.status }), JSON.stringify({ status: next, renewal_result: renewal?.status || 'no_intent' })]
      );
    }
    const [reminderRows] = await connection.query(
      `SELECT s.id,t.owner_user_id,COALESCE(bp.reminder_days_before,7) AS reminder_days
       FROM tenant_subscriptions s INNER JOIN tenants t ON t.id=s.tenant_id
       LEFT JOIN tenant_billing_profiles bp ON bp.tenant_id=s.tenant_id
       WHERE s.status='active' AND s.period_ends_at>UTC_TIMESTAMP()
         AND s.period_ends_at<=DATE_ADD(UTC_TIMESTAMP(),INTERVAL COALESCE(bp.reminder_days_before,7) DAY)
       LIMIT 100`
    );
    for (const reminder of reminderRows as Array<{ id: string; owner_user_id: string; reminder_days: number }>) {
      await notifyBillingOnce(connection, reminder.id, reminder.owner_user_id, `expiry_reminder_${reminder.reminder_days}`, 'اقترب موعد تجديد اشتراك المنصة', `متبقٍ ${reminder.reminder_days} أيام أو أقل على انتهاء الفترة. يمكنك شحن الرصيد وتجهيز إذن التجديد الآن دون خصم مبكر.`);
    }
    const [graceWarningRows] = await connection.query(
      `SELECT s.id,t.owner_user_id FROM tenant_subscriptions s
       INNER JOIN tenants t ON t.id=s.tenant_id
       WHERE s.status='grace_period' AND s.grace_until>UTC_TIMESTAMP()
         AND s.grace_until<=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY) LIMIT 100`
    );
    for (const warning of graceWarningRows as Array<{ id: string; owner_user_id: string }>) {
      await notifyBillingOnce(connection, warning.id, warning.owner_user_id, 'grace_last_day', 'أقل من يوم على انتهاء مهلة التجديد', 'اشحن الرصيد أو راجع إذن التجديد قبل انتهاء العد التنازلي لتجنب إيقاف أدوات التدريس مؤقتًا.');
    }
    await connection.commit();
    return due.length;
  } catch (error) {
    try { await connection.rollback(); } catch { /* transaction may not have begun */ }
    throw error;
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK('tenant_subscription_lifecycle')");
    connection.release();
  }
}
