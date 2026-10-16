import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute } from '../db';
import { requireAdminPermission } from '../security/admin-permissions';

export interface SubscriptionPlansDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

export interface SubscriptionPlansRouterDeps {
    db: SubscriptionPlansDataAccess;
    authenticate: RequestHandler;
    authorize: RequestHandler;
    authorizeWrite: RequestHandler;
}

/**
 * Money crosses the API as integer minor units or a decimal string with at
 * most two fraction digits; MySQL DECIMAL(10,2) does the arithmetic. Native
 * floats are accepted only when decimal-safe (finite, >= 0, <= 2dp).
 */
const DECIMAL_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
export const toDecimalMoney = (value: unknown): string | null => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return DECIMAL_RE.test(trimmed) ? trimmed : null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) return null;
        const rounded = Math.round(value * 100) / 100;
        if (Math.abs(value - rounded) > 1e-9) return null;
        return rounded.toFixed(2);
    }
    return null;
};

const toPositiveInt = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1200) return value;
    if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim())) {
        const parsed = parseInt(value.trim(), 10);
        if (parsed > 0 && parsed <= 1200) return parsed;
    }
    return null;
};

interface SubscriptionPlan {
    id: string;
    name: string;
    duration_months: number;
    price: number;
    description?: string;
    is_active: boolean;
}

export const createSubscriptionPlansRouter = (deps: SubscriptionPlansRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    router.use(deps.authenticate, deps.authorize);

    // Get all subscription plans
    router.get('/', async (_req: AuthRequest, res: Response) => {
        try {
            const plans = await query<SubscriptionPlan>(
                'SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price ASC'
            );
            res.json(plans);
        } catch (error) {
            console.error('Get subscription plans error:', error);
            res.status(500).json({ error: 'Failed to fetch subscription plans' });
        }
    });

    // Get subscription plan by ID
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const plan = await queryOne<SubscriptionPlan>(
                'SELECT * FROM subscription_plans WHERE id = ? AND is_active = TRUE',
                [req.params.id]
            );

            if (!plan) {
                return res.status(404).json({ error: 'Subscription plan not found' });
            }

            res.json(plan);
        } catch (error) {
            console.error('Get subscription plan error:', error);
            res.status(500).json({ error: 'Failed to fetch subscription plan' });
        }
    });

    // Create new subscription plan (Decimal price, integer duration)
    router.post('/', deps.authorizeWrite, async (req: AuthRequest, res: Response) => {
        try {
            const { id, name, duration_months, price, description } = req.body;

            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ error: 'Plan name is required' });
            }
            const duration = toPositiveInt(duration_months);
            if (duration === null) {
                return res.status(400).json({ error: 'duration_months must be a positive integer' });
            }
            const decimalPrice = toDecimalMoney(price);
            if (decimalPrice === null) {
                return res.status(400).json({ error: 'Price must be a non-negative decimal with at most two fraction digits' });
            }

            const planId = typeof id === 'string' && id.length >= 8 ? id : randomUUID();

            // Idempotent create: a reused client id returns the existing row
            // instead of double-inserting a duplicate plan.
            const existing = await queryOne<SubscriptionPlan>(
                'SELECT * FROM subscription_plans WHERE id = ?',
                [planId]
            );
            if (existing) return res.status(200).json(existing);

            await execute(
                `INSERT INTO subscription_plans (id, name, duration_months, price, description, is_active)
                 VALUES (?, ?, ?, ?, ?, TRUE)`,
                [planId, name.trim(), duration, decimalPrice, description || null]
            );

            const newPlan = await queryOne<SubscriptionPlan>(
                'SELECT * FROM subscription_plans WHERE id = ?',
                [planId]
            );

            res.status(201).json(newPlan);
        } catch (error) {
            console.error('Create subscription plan error:', error);
            res.status(500).json({ error: 'Failed to create subscription plan' });
        }
    });

    // Update subscription plan (guarded: missing -> 404, money revalidated)
    router.put('/:id', deps.authorizeWrite, async (req: AuthRequest, res: Response) => {
        try {
            const { name, duration_months, price, description, is_active } = req.body;

            const updates: string[] = [];
            const values: unknown[] = [];
            if (name !== undefined) {
                if (typeof name !== 'string' || !name.trim()) {
                    return res.status(400).json({ error: 'Plan name must be a non-empty string' });
                }
                updates.push('name = ?');
                values.push(name.trim());
            }
            if (duration_months !== undefined) {
                const duration = toPositiveInt(duration_months);
                if (duration === null) {
                    return res.status(400).json({ error: 'duration_months must be a positive integer' });
                }
                updates.push('duration_months = ?');
                values.push(duration);
            }
            if (price !== undefined) {
                const decimalPrice = toDecimalMoney(price);
                if (decimalPrice === null) {
                    return res.status(400).json({ error: 'Price must be a non-negative decimal with at most two fraction digits' });
                }
                updates.push('price = ?');
                values.push(decimalPrice);
            }
            if (description !== undefined) {
                updates.push('description = ?');
                values.push(description || null);
            }
            if (is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(is_active ? true : false);
            }
            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            const result = await execute(
                `UPDATE subscription_plans SET ${updates.join(', ')} WHERE id = ?`,
                [...values, req.params.id]
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Subscription plan not found' });
            }

            const updatedPlan = await queryOne<SubscriptionPlan>(
                'SELECT * FROM subscription_plans WHERE id = ?',
                [req.params.id]
            );

            res.json(updatedPlan);
        } catch (error) {
            console.error('Update subscription plan error:', error);
            res.status(500).json({ error: 'Failed to update subscription plan' });
        }
    });

    // Delete subscription plan (soft delete, guarded)
    router.delete('/:id', deps.authorizeWrite, async (req: AuthRequest, res: Response) => {
        try {
            const result = await execute(
                'UPDATE subscription_plans SET is_active = FALSE WHERE id = ? AND is_active = TRUE',
                [req.params.id]
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Subscription plan not found' });
            }

            res.json({ message: 'Subscription plan deleted successfully' });
        } catch (error) {
            console.error('Delete subscription plan error:', error);
            res.status(500).json({ error: 'Failed to delete subscription plan' });
        }
    });

    return router;
};

const productionDb: SubscriptionPlansDataAccess = { query, queryOne, execute };

export default createSubscriptionPlansRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'teacher'),
    authorizeWrite: requireAdminPermission('subscription.create'),
});
