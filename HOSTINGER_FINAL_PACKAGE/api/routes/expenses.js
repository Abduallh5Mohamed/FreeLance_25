"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const DATABASE_NAME = process.env.DB_NAME || 'freelance';
let expensesSchemaEnsured = false;
const ensureExpensesSchema = async () => {
    if (expensesSchemaEnsured) {
        return;
    }
    await (0, db_1.execute)(`
        CREATE TABLE IF NOT EXISTS expenses (
            id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
            description VARCHAR(500) NOT NULL,
            amount DECIMAL(10, 2) NOT NULL,
            category VARCHAR(100),
            date DATE NOT NULL,
            time TIME,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_date (date),
            INDEX idx_category (category)
        ) ENGINE=InnoDB;
    `);
    expensesSchemaEnsured = true;
};
const router = (0, express_1.Router)();
// Get all expenses
router.get('/', async (req, res) => {
    try {
        await ensureExpensesSchema();
        const expenses = await (0, db_1.query)('SELECT * FROM expenses ORDER BY date DESC, time DESC');
        res.json(expenses);
    }
    catch (error) {
        console.error('Get expenses error:', error);
        res.status(500).json({ error: 'Failed to fetch expenses' });
    }
});
// Get expense by ID
router.get('/:id', async (req, res) => {
    try {
        const expense = await (0, db_1.queryOne)('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
        if (!expense) {
            return res.status(404).json({ error: 'Expense not found' });
        }
        res.json(expense);
    }
    catch (error) {
        console.error('Get expense error:', error);
        res.status(500).json({ error: 'Failed to fetch expense' });
    }
});
// Create new expense
router.post('/', async (req, res) => {
    try {
        await ensureExpensesSchema();
        const { description, amount, category, date, time } = req.body;
        if (!description || !amount || !date) {
            return res.status(400).json({ error: 'Description, amount, and date are required' });
        }
        const result = await (0, db_1.execute)(`INSERT INTO expenses (description, amount, category, date, time) 
             VALUES (?, ?, ?, ?, ?)`, [description, amount, category || null, date, time || null]);
        const newExpense = await (0, db_1.queryOne)('SELECT * FROM expenses WHERE id = ?', [result.insertId]);
        res.status(201).json(newExpense);
    }
    catch (error) {
        console.error('Create expense error:', error);
        res.status(500).json({ error: 'Failed to create expense' });
    }
});
// Update expense
router.put('/:id', async (req, res) => {
    try {
        const { description, amount, category, date, time } = req.body;
        const updates = [];
        const values = [];
        if (description !== undefined) {
            updates.push('description = ?');
            values.push(description);
        }
        if (amount !== undefined) {
            updates.push('amount = ?');
            values.push(amount);
        }
        if (category !== undefined) {
            updates.push('category = ?');
            values.push(category);
        }
        if (date !== undefined) {
            updates.push('date = ?');
            values.push(date);
        }
        if (time !== undefined) {
            updates.push('time = ?');
            values.push(time);
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        values.push(req.params.id);
        await (0, db_1.execute)(`UPDATE expenses SET ${updates.join(', ')} WHERE id = ?`, values);
        const updatedExpense = await (0, db_1.queryOne)('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
        if (!updatedExpense) {
            return res.status(404).json({ error: 'Expense not found' });
        }
        res.json(updatedExpense);
    }
    catch (error) {
        console.error('Update expense error:', error);
        res.status(500).json({ error: 'Failed to update expense' });
    }
});
// Delete expense
router.delete('/:id', async (req, res) => {
    try {
        const result = await (0, db_1.execute)('DELETE FROM expenses WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Expense not found' });
        }
        res.json({ message: 'Expense deleted successfully' });
    }
    catch (error) {
        console.error('Delete expense error:', error);
        res.status(500).json({ error: 'Failed to delete expense' });
    }
});
exports.default = router;
