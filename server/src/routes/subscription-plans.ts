import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface SubscriptionPlan {
    id: string;
    name: string;
    duration_months: number;
    price: number;
    description?: string;
    is_active: boolean;
}

// Get all subscription plans
router.get('/', async (req: Request, res: Response) => {
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
router.get('/:id', async (req: Request, res: Response) => {
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

// Create new subscription plan
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, duration_months, price, description } = req.body;

        if (!name || !duration_months || !price) {
            return res.status(400).json({ error: 'Name, duration_months, and price are required' });
        }

        const result = await execute(
            `INSERT INTO subscription_plans (name, duration_months, price, description, is_active)
             VALUES (?, ?, ?, ?, TRUE)`,
            [name, parseInt(duration_months), parseFloat(price), description || null]
        );

        const newPlan = await queryOne<SubscriptionPlan>(
            'SELECT * FROM subscription_plans ORDER BY created_at DESC LIMIT 1'
        );

        res.status(201).json(newPlan);
    } catch (error) {
        console.error('Create subscription plan error:', error);
        res.status(500).json({ error: 'Failed to create subscription plan' });
    }
});

// Update subscription plan
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { name, duration_months, price, description, is_active } = req.body;

        await execute(
            `UPDATE subscription_plans 
             SET name = ?, duration_months = ?, price = ?, description = ?, is_active = ?
             WHERE id = ?`,
            [name, parseInt(duration_months), parseFloat(price), description, is_active !== undefined ? is_active : true, req.params.id]
        );

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

// Delete subscription plan (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        await execute(
            'UPDATE subscription_plans SET is_active = FALSE WHERE id = ?',
            [req.params.id]
        );

        res.json({ message: 'Subscription plan deleted successfully' });
    } catch (error) {
        console.error('Delete subscription plan error:', error);
        res.status(500).json({ error: 'Failed to delete subscription plan' });
    }
});

export default router;
