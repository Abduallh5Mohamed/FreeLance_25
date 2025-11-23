"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const crypto_1 = require("crypto");
const router = (0, express_1.Router)();
// Get all groups
router.get('/', async (req, res) => {
    try {
        const groups = await (0, db_1.query)('SELECT * FROM `groups` WHERE is_active = TRUE ORDER BY name');
        res.json(groups);
    }
    catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});
// Get group by ID
router.get('/:id', async (req, res) => {
    try {
        const group = await (0, db_1.queryOne)('SELECT * FROM `groups` WHERE id = ? AND is_active = TRUE', [req.params.id]);
        if (!group) {
            return res.status(404).json({ error: 'Group not found' });
        }
        res.json(group);
    }
    catch (error) {
        console.error('Get group error:', error);
        res.status(500).json({ error: 'Failed to fetch group' });
    }
});
// Create new group
router.post('/', async (req, res) => {
    try {
        const { name, description, max_students, is_active = true, grade_id } = req.body;
        let course_id = (req.body && req.body.course_id) ?? null;
        if (!name) {
            return res.status(400).json({ error: 'Group name is required' });
        }
        // Normalize incoming course_id: accept empty string or undefined as null
        if (course_id === '' || course_id === undefined) {
            course_id = null;
        }
        else {
            // verify course exists; if not, null it to avoid FK failure
            const courseExists = await (0, db_1.queryOne)('SELECT id FROM courses WHERE id = ?', [course_id]);
            if (!courseExists) {
                console.warn(`Create group: provided course_id ${course_id} not found, setting to NULL`);
                course_id = null;
            }
        }
        // Handle grade_id
        let finalGradeId = grade_id || null;
        if (finalGradeId === '' || finalGradeId === undefined) {
            finalGradeId = null;
        }
        const groupId = (0, crypto_1.randomUUID)();
        await (0, db_1.execute)('INSERT INTO `groups` (id, name, description, course_id, grade_id, max_students, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)', [groupId, name, description || null, course_id, finalGradeId, max_students || 30, is_active]);
        const newGroup = await (0, db_1.queryOne)('SELECT * FROM `groups` WHERE id = ?', [groupId]);
        res.status(201).json(newGroup);
    }
    catch (error) {
        console.error('Create group error:', error);
        res.status(500).json({ error: 'Failed to create group' });
    }
});
// Update group
router.put('/:id', async (req, res) => {
    try {
        const { name, description, max_students, is_active, grade_id } = req.body;
        let course_id = (req.body && req.body.course_id) ?? null;
        // Normalize course_id: treat empty string or undefined as null
        if (course_id === '' || course_id === undefined) {
            course_id = null;
        }
        else {
            // If provided, ensure the referenced course actually exists. If not, set to null to avoid FK errors.
            const courseExists = await (0, db_1.queryOne)('SELECT id FROM courses WHERE id = ?', [course_id]);
            if (!courseExists) {
                console.warn(`Update group: provided course_id ${course_id} not found, setting to NULL`);
                course_id = null;
            }
        }
        // Handle grade_id
        let finalGradeId = grade_id;
        if (finalGradeId === '' || finalGradeId === undefined) {
            finalGradeId = null;
        }
        const result = await (0, db_1.execute)(`UPDATE \`groups\` 
             SET name = COALESCE(?, name),
                 description = COALESCE(?, description),
                 course_id = COALESCE(?, course_id),
                 grade_id = COALESCE(?, grade_id),
                 max_students = COALESCE(?, max_students),
                 is_active = COALESCE(?, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`, [
            name ?? null,
            description ?? null,
            course_id ?? null,
            finalGradeId ?? null,
            max_students ?? null,
            is_active ?? null,
            req.params.id
        ]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }
        const updatedGroup = await (0, db_1.queryOne)('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
        res.json(updatedGroup);
    }
    catch (error) {
        console.error('Update group error:', error);
        res.status(500).json({ error: 'Failed to update group' });
    }
});
// Delete group (hard delete - permanent deletion from database)
router.delete('/:id', async (req, res) => {
    try {
        const result = await (0, db_1.execute)('DELETE FROM `groups` WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }
        res.json({ message: 'Group deleted successfully' });
    }
    catch (error) {
        console.error('Delete group error:', error);
        res.status(500).json({ error: 'Failed to delete group' });
    }
});
exports.default = router;
