import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

interface Expense {
    id: string;
    description: string;
    amount: number;
    category: string;
    date: string;
    time: string;
    created_at: string;
    updated_at: string;
}

// Get all expenses
router.get('/', async (req: Request, res: Response) => {
    try {
        const expenses = await query<Expense>('SELECT * FROM expenses ORDER BY date DESC, time DESC');
        res.json(expenses);
    } catch (error) {
        console.error('Get expenses error:', error);
        res.status(500).json({ error: 'Failed to fetch expenses' });
    }
});

// Get expense by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const expense = await queryOne<Expense>(
            'SELECT * FROM expenses WHERE id = ?',
            [req.params.id]
        );

        if (!expense) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        res.json(expense);
    } catch (error) {
        console.error('Get expense error:', error);
        res.status(500).json({ error: 'Failed to fetch expense' });
    }
});

// Create new expense
router.post('/', async (req: Request, res: Response) => {
    try {
        const { description, amount, category, date, time } = req.body;

        if (!description || !amount || !date) {
            return res.status(400).json({ error: 'Description, amount, and date are required' });
        }

        const result = await execute(
            `INSERT INTO expenses (description, amount, category, date, time)
             VALUES (?, ?, ?, ?, ?)`,
            [description, amount, category || null, date, time || null]
        );

        const newExpense = await queryOne<Expense>(
            'SELECT * FROM expenses WHERE id = ?',
            [result.insertId]
        );

        res.status(201).json(newExpense);
    } catch (error) {
        console.error('Create expense error:', error);
        res.status(500).json({ error: 'Failed to create expense' });
    }
});

// Update expense
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { description, amount, category, date, time } = req.body;

        const updates: string[] = [];
        const values: any[] = [];

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

        await execute(
            `UPDATE expenses SET ${updates.join(', ')} WHERE id = ?`,
            values
        );

        const updatedExpense = await queryOne<Expense>(
            'SELECT * FROM expenses WHERE id = ?',
            [req.params.id]
        );

        if (!updatedExpense) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        res.json(updatedExpense);
    } catch (error) {
        console.error('Update expense error:', error);
        res.status(500).json({ error: 'Failed to update expense' });
    }
});

// Delete expense
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await execute(
            'DELETE FROM expenses WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Expense not found' });
        }

        res.json({ message: 'Expense deleted successfully' });
    } catch (error) {
        console.error('Delete expense error:', error);
        res.status(500).json({ error: 'Failed to delete expense' });
    }
});

export default router;
