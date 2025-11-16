"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
// Get all grades
router.get('/', async (req, res) => {
    try {
        const grades = await (0, db_1.query)('SELECT * FROM grades WHERE is_active = TRUE ORDER BY display_order');
        res.json(grades);
    }
    catch (error) {
        console.error('Get grades error:', error);
        res.status(500).json({ error: 'Failed to fetch grades' });
    }
});
// Get grade by ID
router.get('/:id', async (req, res) => {
    try {
        const grade = await (0, db_1.queryOne)('SELECT * FROM grades WHERE id = ? AND is_active = TRUE', [req.params.id]);
        if (!grade) {
            return res.status(404).json({ error: 'Grade not found' });
        }
        res.json(grade);
    }
    catch (error) {
        console.error('Get grade error:', error);
        res.status(500).json({ error: 'Failed to fetch grade' });
    }
});
// Create new grade
router.post('/', async (req, res) => {
    try {
        const { name, display_order } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        const result = await (0, db_1.execute)('INSERT INTO grades (name, display_order) VALUES (?, ?)', [name, display_order || 0]);
        const newGrade = await (0, db_1.queryOne)('SELECT * FROM grades WHERE id = ?', [result.insertId]);
        res.status(201).json(newGrade);
    }
    catch (error) {
        console.error('Create grade error:', error);
        res.status(500).json({ error: 'Failed to create grade' });
    }
});
// Update grade
router.put('/:id', async (req, res) => {
    try {
        const { name, display_order } = req.body;
        const { id } = req.params;
        await (0, db_1.execute)('UPDATE grades SET name = ?, display_order = ? WHERE id = ?', [name, display_order, id]);
        const updatedGrade = await (0, db_1.queryOne)('SELECT * FROM grades WHERE id = ?', [id]);
        res.json(updatedGrade);
    }
    catch (error) {
        console.error('Update grade error:', error);
        res.status(500).json({ error: 'Failed to update grade' });
    }
});
// Delete grade (soft delete)
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await (0, db_1.execute)('UPDATE grades SET is_active = FALSE WHERE id = ?', [id]);
        res.json({ message: 'Grade deleted successfully' });
    }
    catch (error) {
        console.error('Delete grade error:', error);
        res.status(500).json({ error: 'Failed to delete grade' });
    }
});
exports.default = router;
