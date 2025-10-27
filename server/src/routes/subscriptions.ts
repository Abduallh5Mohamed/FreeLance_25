import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Subscription {
    id: string;
    name: string;
    duration_months: number;
    price: number;
    description?: string;
    is_active: boolean;
}

// Get all subscriptions
router.get('/', async (req: Request, res: Response) => {
    try {
        const subscriptions = await query<Subscription>(
            'SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price'
        );
        res.json(subscriptions);
    } catch (error) {
        console.error('Get subscriptions error:', error);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

// Get subscription by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const subscription = await queryOne<Subscription>(
            'SELECT * FROM subscription_plans WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );

        if (!subscription) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json(subscription);
    } catch (error) {
        console.error('Get subscription error:', error);
        res.status(500).json({ error: 'Failed to fetch subscription' });
    }
});

// Create new subscription
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, duration_months, price, description } = req.body;

        if (!name || !duration_months || !price) {
            return res.status(400).json({ error: 'Name, duration, and price are required' });
        }

        const result = await execute(
            'INSERT INTO subscription_plans (name, duration_months, price, description, is_active) VALUES (?, ?, ?, ?, TRUE)',
            [name, parseInt(duration_months), parseFloat(price), description || null]
        );

        const newSubscription = await queryOne<Subscription>(
            'SELECT * FROM subscription_plans WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newSubscription);
    } catch (error) {
        console.error('Create subscription error:', error);
        res.status(500).json({ error: 'Failed to create subscription' });
    }
});

// Update subscription
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { name, duration_months, price, description, is_active } = req.body;

        await execute(
            `UPDATE subscription_plans 
             SET name = ?, duration_months = ?, price = ?, description = ?, is_active = ?
             WHERE id = ?`,
            [name, parseInt(duration_months), parseFloat(price), description || null, is_active !== undefined ? is_active : true, req.params.id]
        );

        const updatedSubscription = await queryOne<Subscription>(
            'SELECT * FROM subscription_plans WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedSubscription);
    } catch (error) {
        console.error('Update subscription error:', error);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

// Delete subscription (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        await execute(
            'UPDATE subscription_plans SET is_active = FALSE WHERE id = ?',
            [req.params.id]
        );

        res.json({ message: 'Subscription deleted successfully' });
    } catch (error) {
        console.error('Delete subscription error:', error);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
});

export default router;
