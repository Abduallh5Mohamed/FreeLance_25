"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
// Get notifications for a user
router.get('/', async (req, res) => {
    try {
        const { user_id, user_type, is_read } = req.query;
        let sql = 'SELECT * FROM notifications WHERE 1=1';
        const params = [];
        if (user_id) {
            sql += ' AND user_id = ?';
            params.push(user_id);
        }
        if (user_type) {
            sql += ' AND user_type = ?';
            params.push(user_type);
        }
        if (is_read !== undefined) {
            sql += ' AND is_read = ?';
            params.push(is_read === 'true' ? 1 : 0);
        }
        sql += ' ORDER BY created_at DESC';
        const notifications = await (0, db_1.query)(sql, params);
        res.json(notifications);
    }
    catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});
// Mark notification as read
router.put('/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        await (0, db_1.query)('UPDATE notifications SET is_read = TRUE WHERE id = ?', [id]);
        res.json({ message: 'Notification marked as read' });
    }
    catch (error) {
        console.error('Error updating notification:', error);
        res.status(500).json({ error: 'Failed to update notification' });
    }
});
// Mark all notifications as read for a user
router.put('/read-all', async (req, res) => {
    try {
        const { user_id, user_type } = req.body;
        if (!user_id || !user_type) {
            return res.status(400).json({ error: 'user_id and user_type are required' });
        }
        await (0, db_1.query)('UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND user_type = ?', [user_id, user_type]);
        res.json({ message: 'All notifications marked as read' });
    }
    catch (error) {
        console.error('Error updating notifications:', error);
        res.status(500).json({ error: 'Failed to update notifications' });
    }
});
// Get unread count
router.get('/unread-count', async (req, res) => {
    try {
        const { user_id, user_type } = req.query;
        if (!user_id || !user_type) {
            return res.status(400).json({ error: 'user_id and user_type are required' });
        }
        const result = await (0, db_1.query)('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND user_type = ? AND is_read = FALSE', [user_id, user_type]);
        const count = Array.isArray(result) && result.length > 0 ? result[0].count : 0;
        res.json({ count });
    }
    catch (error) {
        console.error('Error fetching unread count:', error);
        res.status(500).json({ error: 'Failed to fetch unread count' });
    }
});
exports.default = router;
