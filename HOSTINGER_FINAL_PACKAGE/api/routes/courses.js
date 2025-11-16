"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
// Get all courses
router.get('/', async (req, res) => {
    try {
        const courses = await (0, db_1.query)('SELECT * FROM courses WHERE is_active = TRUE ORDER BY name');
        res.json(courses);
    }
    catch (error) {
        console.error('Get courses error:', error);
        res.status(500).json({ error: 'Failed to fetch courses' });
    }
});
// Get course by ID
router.get('/:id', async (req, res) => {
    try {
        const course = await (0, db_1.queryOne)('SELECT * FROM courses WHERE id = ? AND is_active = TRUE', [req.params.id]);
        if (!course) {
            return res.status(404).json({ error: 'Course not found' });
        }
        res.json(course);
    }
    catch (error) {
        console.error('Get course error:', error);
        res.status(500).json({ error: 'Failed to fetch course' });
    }
});
// Create new course
router.post('/', async (req, res) => {
    try {
        const { name, subject, description, grade, price = 0 } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Course name is required' });
        }
        const result = await (0, db_1.execute)('INSERT INTO courses (name, subject, description, grade, price) VALUES (?, ?, ?, ?, ?)', [name, subject || null, description || null, grade || null, price]);
        const newCourse = await (0, db_1.queryOne)('SELECT * FROM courses WHERE id = ?', [result.insertId]);
        res.status(201).json(newCourse);
    }
    catch (error) {
        console.error('Create course error:', error);
        res.status(500).json({ error: 'Failed to create course' });
    }
});
// Update course
router.put('/:id', async (req, res) => {
    try {
        const { name, subject, description, grade, price } = req.body;
        const { id } = req.params;
        await (0, db_1.execute)('UPDATE courses SET name = ?, subject = ?, description = ?, grade = ?, price = ? WHERE id = ?', [name, subject || null, description || null, grade || null, price || 0, id]);
        const updatedCourse = await (0, db_1.queryOne)('SELECT * FROM courses WHERE id = ?', [id]);
        res.json(updatedCourse);
    }
    catch (error) {
        console.error('Update course error:', error);
        res.status(500).json({ error: 'Failed to update course' });
    }
});
// Delete course
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await (0, db_1.execute)('UPDATE courses SET is_active = FALSE WHERE id = ?', [id]);
        res.json({ message: 'Course deleted successfully' });
    }
    catch (error) {
        console.error('Delete course error:', error);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});
exports.default = router;
