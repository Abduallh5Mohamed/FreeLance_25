"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
// Get all lectures (published by default)
router.get('/', async (req, res) => {
    try {
        const { course_id, group_id } = req.query;
        let sql = `
            SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject,
                g.name as group_name
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN \`groups\` g ON l.group_id = g.id
            WHERE l.is_published = TRUE
        `;
        const params = [];
        if (course_id && typeof course_id === 'string') {
            sql += ' AND l.course_id = ?';
            params.push(course_id);
        }
        if (group_id && typeof group_id === 'string') {
            sql += ' AND (l.group_id = ? OR l.group_id IS NULL)';
            params.push(group_id);
        }
        sql += ' ORDER BY l.display_order ASC, l.created_at DESC';
        const lectures = await (0, db_1.query)(sql, params);
        console.log(`[Lectures] GET / - Found ${lectures?.length || 0} lectures`);
        res.json(lectures);
    }
    catch (error) {
        console.error('Get lectures error:', error);
        res.status(500).json({ error: 'Failed to fetch lectures' });
    }
});
// Get lectures for a specific student based on their group
router.get('/student/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        // Find student's group_id (similar to materials endpoint)
        let student = await (0, db_1.queryOne)('SELECT id, group_id FROM students WHERE id = ? AND is_active = TRUE', [userId]);
        // If not found by id, try to find by user_id from users table
        if (!student) {
            const userRecord = await (0, db_1.queryOne)('SELECT student_id FROM users WHERE id = ? AND role = "student"', [userId]);
            if (userRecord && userRecord.student_id) {
                student = await (0, db_1.queryOne)('SELECT id, group_id FROM students WHERE id = ? AND is_active = TRUE', [userRecord.student_id]);
            }
        }
        if (!student) {
            console.log(`Student not found for user/student id: ${userId}`);
            return res.json([]);
        }
        if (!student.group_id) {
            console.log(`Student ${userId} has no group assigned`);
            return res.json([]);
        }
        // Get lectures assigned to the student's specific group
        let sql = `
            SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject,
                g.name as group_name
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN \`groups\` g ON l.group_id = g.id
            WHERE l.is_published = TRUE
                AND l.group_id = ?
            ORDER BY l.display_order ASC, l.created_at DESC
        `;
        const lectures = await (0, db_1.query)(sql, [student.group_id]);
        console.log(`[Lectures] Student ${userId} in group ${student.group_id} - Found ${lectures?.length || 0} lectures`);
        res.json(lectures);
    }
    catch (error) {
        console.error('Get student lectures error:', error);
        res.status(500).json({ error: 'Failed to fetch student lectures' });
    }
});
// Get lecture by ID
router.get('/:id', async (req, res) => {
    try {
        const lecture = await (0, db_1.queryOne)(`SELECT 
                l.*,
                c.name as course_name,
                c.subject as course_subject,
                g.name as group_name
            FROM lectures l
            LEFT JOIN courses c ON l.course_id = c.id
            LEFT JOIN \`groups\` g ON l.group_id = g.id
            WHERE l.id = ?`, [req.params.id]);
        if (!lecture) {
            return res.status(404).json({ error: 'Lecture not found' });
        }
        res.json(lecture);
    }
    catch (error) {
        console.error('Get lecture error:', error);
        res.status(500).json({ error: 'Failed to fetch lecture' });
    }
});
// Create new lecture
router.post('/', async (req, res) => {
    try {
        const { course_id, group_id, title, description, video_url, duration_minutes, display_order = 0, is_free = false, is_published = true } = req.body;
        if (!course_id || !title || !video_url) {
            return res.status(400).json({
                error: 'Course ID, title, and video_url are required'
            });
        }
        console.log('[Lectures] Creating lecture:', { course_id, group_id, title, video_url });
        const result = await (0, db_1.execute)(`INSERT INTO lectures 
            (course_id, group_id, title, description, video_url, duration_minutes, display_order, is_free, is_published) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            course_id,
            group_id || null,
            title,
            description || null,
            video_url,
            duration_minutes || null,
            display_order,
            is_free,
            is_published
        ]);
        const newLecture = await (0, db_1.queryOne)('SELECT * FROM lectures WHERE id = ?', [result.insertId]);
        console.log('[Lectures] Created lecture:', newLecture?.id);
        res.status(201).json(newLecture);
    }
    catch (error) {
        console.error('Create lecture error:', error);
        res.status(500).json({ error: 'Failed to create lecture' });
    }
});
// Update lecture
router.put('/:id', async (req, res) => {
    try {
        const { title, description, video_url, duration_minutes, display_order, is_free, is_published } = req.body;
        const result = await (0, db_1.execute)(`UPDATE lectures 
             SET title = COALESCE(?, title),
                 description = COALESCE(?, description),
                 video_url = COALESCE(?, video_url),
                 duration_minutes = COALESCE(?, duration_minutes),
                 display_order = COALESCE(?, display_order),
                 is_free = COALESCE(?, is_free),
                 is_published = COALESCE(?, is_published),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`, [
            title ?? null,
            description ?? null,
            video_url ?? null,
            duration_minutes ?? null,
            display_order ?? null,
            is_free ?? null,
            is_published ?? null,
            req.params.id
        ]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Lecture not found' });
        }
        const updatedLecture = await (0, db_1.queryOne)('SELECT * FROM lectures WHERE id = ?', [req.params.id]);
        res.json(updatedLecture);
    }
    catch (error) {
        console.error('Update lecture error:', error);
        res.status(500).json({ error: 'Failed to update lecture' });
    }
});
// Delete lecture (soft delete by unpublishing)
router.delete('/:id', async (req, res) => {
    try {
        const result = await (0, db_1.execute)('UPDATE lectures SET is_published = FALSE WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Lecture not found' });
        }
        console.log('[Lectures] Deleted lecture:', req.params.id);
        res.json({ message: 'Lecture deleted successfully' });
    }
    catch (error) {
        console.error('Delete lecture error:', error);
        res.status(500).json({ error: 'Failed to delete lecture' });
    }
});
exports.default = router;
