import { randomUUID } from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { postServiceCreditEntry } from './service-credit';

export type RenewalExecution = {
    status: 'not_due' | 'insufficient_balance' | 'executed' | 'already_processed';
    subscriptionId?: string;
    balance?: string;
    required?: string;
};

export async function executeRenewalIntent(connection: PoolConnection, intentId: string): Promise<RenewalExecution> {
    const [rows] = await connection.execute(
        `SELECT i.id,i.tenant_id,i.instructor_id,i.source_subscription_id,i.target_plan_id,
                i.charge_amount,i.paid_at,i.status,i.trigger_type,
                s.status AS subscription_status,s.period_ends_at,s.agreed_price,s.discount_amount,
                (s.period_ends_at<=UTC_TIMESTAMP()) AS is_due,
                GREATEST(s.period_ends_at,COALESCE(i.paid_at,UTC_TIMESTAMP())) AS renewal_starts_at,
                p.duration_months,p.duration_days,t.status AS tenant_status
         FROM tenant_renewal_intents i
         INNER JOIN tenant_subscriptions s ON s.id=i.source_subscription_id
         INNER JOIN platform_plans p ON p.id=i.target_plan_id
         INNER JOIN tenants t ON t.id=i.tenant_id
         WHERE i.id=? FOR UPDATE`, [intentId]
    );
    const intent = (rows as any[])[0];
    if (!intent || intent.status !== 'pending') return { status: 'already_processed' };
    if (intent.tenant_status !== 'active') return { status: 'not_due' };

    if (!Number(intent.is_due)) return { status: 'not_due' };

    await connection.execute('INSERT IGNORE INTO instructor_wallets (instructor_id,balance) VALUES (?,0)', [intent.instructor_id]);
    const [walletRows] = await connection.execute('SELECT balance FROM instructor_wallets WHERE instructor_id=? FOR UPDATE', [intent.instructor_id]);
    const balance = String((walletRows as any[])[0]?.balance ?? '0');
    if (Number(balance) < Number(intent.charge_amount)) {
        return { status: 'insufficient_balance', balance, required: String(intent.charge_amount) };
    }

    const nextSubscriptionId = randomUUID();
    const debit = await postServiceCreditEntry(connection, {
        instructorId: intent.instructor_id,
        actorId: intent.instructor_id,
        type: 'debit',
        amount: String(intent.charge_amount),
        reason: 'تجديد اشتراك المنصة تلقائيًا',
        referenceType: 'subscription_renewal',
        referenceUuid: intent.id,
    });
    await connection.execute(
        `INSERT INTO tenant_subscriptions
         (id,tenant_id,plan_id,status,agreed_price,discount_amount,currency,starts_at,period_ends_at,
          created_by,renewed_from_subscription_id,renewal_intent_id)
         VALUES (?,?,?,'active',?,0,'EGP',?,DATE_ADD(DATE_ADD(?,INTERVAL ? MONTH),INTERVAL ? DAY),?,?,?)`,
        [nextSubscriptionId, intent.tenant_id, intent.target_plan_id, intent.charge_amount,
            intent.renewal_starts_at, intent.renewal_starts_at, Number(intent.duration_months), Number(intent.duration_days),
            intent.instructor_id, intent.source_subscription_id, intent.id]
    );
    await connection.execute(
        `UPDATE tenant_subscriptions SET status='completed',grace_until=NULL WHERE id=?`,
        [intent.source_subscription_id]
    );
    await connection.execute(
        `UPDATE tenant_renewal_intents SET status='executed',executed_subscription_id=?,executed_at=UTC_TIMESTAMP() WHERE id=?`,
        [nextSubscriptionId, intent.id]
    );
    await connection.execute(
        `INSERT INTO platform_revenue_events
         (id,tenant_id,subscription_id,wallet_transaction_id,event_type,amount,recognized_at)
         VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())`,
        [randomUUID(), intent.tenant_id, nextSubscriptionId, debit.transactionId, 'subscription_renewal', intent.charge_amount]
    );
    await connection.execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value,reason)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), intent.instructor_id, intent.tenant_id, 'tenant_subscription.auto_renewed',
            'tenant_subscription', nextSubscriptionId,
            JSON.stringify({ previous_subscription_id: intent.source_subscription_id, amount: intent.charge_amount, starts_at: intent.renewal_starts_at }),
            intent.trigger_type === 'topup' ? 'Approved renewal top-up intent' : 'Instructor manual renewal intent']
    );
    await connection.execute(
        `INSERT INTO notifications (id,user_id,user_type,title,message,type,link)
         VALUES (UUID(),?,'instructor','تم تجديد اشتراك المنصة',?,'subscription','/instructor-subscription')`,
        [intent.instructor_id, `تم خصم ${intent.charge_amount} ج.م من رصيد الخدمات وبدأت فترة الاشتراك الجديدة.`]
    );
    return { status: 'executed', subscriptionId: nextSubscriptionId, balance: debit.balance };
}

export async function tryPendingRenewalForTenant(connection: PoolConnection, tenantId: string): Promise<RenewalExecution | null> {
    const [rows] = await connection.execute(
        `SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' LIMIT 1 FOR UPDATE`,
        [tenantId]
    );
    const intent = (rows as any[])[0];
    return intent ? executeRenewalIntent(connection, intent.id) : null;
}
