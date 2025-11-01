import { Router, Request, Response } from 'express';
import { query, execute } from '../db';

const router = Router();

// Ensure revenues table exists
const ensureRevenuesTable = async () => {
  await execute(`
    CREATE TABLE IF NOT EXISTS revenues (
      id INT PRIMARY KEY AUTO_INCREMENT,
      amount DECIMAL(10, 2) NOT NULL,
      source VARCHAR(255) NOT NULL,
      description TEXT,
      date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_date (date),
      INDEX idx_source (source)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
};

// Get all revenues
router.get('/', async (req: Request, res: Response) => {
  try {
    await ensureRevenuesTable();
    
    const { start_date, end_date, source } = req.query;
    
    let sql = 'SELECT * FROM revenues WHERE 1=1';
    const params: unknown[] = [];
    
    if (start_date) {
      sql += ' AND date >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      sql += ' AND date <= ?';
      params.push(end_date);
    }
    
    if (source) {
      sql += ' AND source = ?';
      params.push(source);
    }
    
    sql += ' ORDER BY date DESC';
    
    const revenues = await query(sql, params);
    res.json(revenues);
  } catch (error) {
    console.error('Error fetching revenues:', error);
    res.status(500).json({ error: 'Failed to fetch revenues' });
  }
});

// Create new revenue
router.post('/', async (req: Request, res: Response) => {
  try {
    await ensureRevenuesTable();
    
    const { amount, source, description, date } = req.body;
    
    if (!amount || !source || !date) {
      return res.status(400).json({ error: 'Amount, source, and date are required' });
    }
    
    const result = await query(
      'INSERT INTO revenues (amount, source, description, date) VALUES (?, ?, ?, ?)',
      [amount, source, description || null, date]
    );
    
    res.status(201).json({ 
      message: 'Revenue created successfully',
      id: (result as unknown as { insertId: number }).insertId 
    });
  } catch (error) {
    console.error('Error creating revenue:', error);
    res.status(500).json({ error: 'Failed to create revenue' });
  }
});

// Get revenue statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    await ensureRevenuesTable();
    
    const stats = await query(`
      SELECT 
        SUM(amount) as total_revenue,
        COUNT(*) as total_count,
        source,
        DATE_FORMAT(date, '%Y-%m') as month
      FROM revenues
      GROUP BY source, month
      ORDER BY month DESC, source
    `) as unknown[];
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching revenue stats:', error);
    res.status(500).json({ error: 'Failed to fetch revenue statistics' });
  }
});

export default router;
