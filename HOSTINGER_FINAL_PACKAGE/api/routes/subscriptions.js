"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
// Get all subscriptions
router.get('/', async (req, res) => {
    try {
        const subscriptions = await (0, db_1.query)('SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY price');
        res.json(subscriptions);
    }
    catch (error) {
        console.error('Get subscriptions error:', error);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});
// Get subscription by ID
router.get('/:id', async (req, res) => {
    try {
        const subscription = await (0, db_1.queryOne)('SELECT * FROM subscription_plans WHERE id = ? AND is_active = TRUE', [req.params.id]);
        if (!subscription) {
            return res.status(404).json({ error: 'Subscription not found' });
        }
        res.json(subscription);
    }
    catch (error) {
        console.error('Get subscription error:', error);
        res.status(500).json({ error: 'Failed to fetch subscription' });
    }
});
// Create new subscription
router.post('/', async (req, res) => {
    try {
        const { name, duration_months, price, description } = req.body;
        if (!name || !duration_months || !price) {
            return res.status(400).json({ error: 'Name, duration, and price are required' });
        }
        const result = await (0, db_1.execute)('INSERT INTO subscription_plans (name, duration_months, price, description, is_active) VALUES (?, ?, ?, ?, TRUE)', [name, parseInt(duration_months), parseFloat(price), description || null]);
        const newSubscription = await (0, db_1.queryOne)('SELECT * FROM subscription_plans WHERE id = ?', [result.insertId]);
        res.status(201).json(newSubscription);
    }
    catch (error) {
        console.error('Create subscription error:', error);
        res.status(500).json({ error: 'Failed to create subscription' });
    }
});
// Update subscription
router.put('/:id', async (req, res) => {
    try {
        const { name, duration_months, price, description, is_active } = req.body;
        await (0, db_1.execute)(`UPDATE subscription_plans 
             SET name = ?, duration_months = ?, price = ?, description = ?, is_active = ?
             WHERE id = ?`, [name, parseInt(duration_months), parseFloat(price), description || null, is_active !== undefined ? is_active : true, req.params.id]);
        const updatedSubscription = await (0, db_1.queryOne)('SELECT * FROM subscription_plans WHERE id = ?', [req.params.id]);
        res.json(updatedSubscription);
    }
    catch (error) {
        console.error('Update subscription error:', error);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});
// Delete subscription (soft delete)
router.delete('/:id', async (req, res) => {
    try {
        await (0, db_1.execute)('UPDATE subscription_plans SET is_active = FALSE WHERE id = ?', [req.params.id]);
        res.json({ message: 'Subscription deleted successfully' });
    }
    catch (error) {
        console.error('Delete subscription error:', error);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
});
exports.default = router;
