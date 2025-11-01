import { Router, Request, Response } from 'express';
import { query } from '../db';

const router = Router();

// Get all payment requests (with filters)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, student_id } = req.query;
    
    let sql = `
      SELECT 
        pr.*,
        s.name as student_name,
        s.phone as student_phone,
        g.name as grade_name,
        gr.name as group_name
      FROM payment_requests pr
      LEFT JOIN students s ON pr.student_id = s.id
      LEFT JOIN grades g ON pr.grade_id = g.id
      LEFT JOIN \`groups\` gr ON pr.group_id = gr.id
      WHERE 1=1
    `;
    
    const params: unknown[] = [];
    
    if (status) {
      sql += ' AND pr.status = ?';
      params.push(status);
    }
    
    if (student_id) {
      sql += ' AND pr.student_id = ?';
      params.push(student_id);
    }
    
    sql += ' ORDER BY pr.created_at DESC';
    
    const requests = await query(sql, params);
    res.json(requests);
  } catch (error) {
    console.error('Error fetching payment requests:', error);
    res.status(500).json({ error: 'Failed to fetch payment requests' });
  }
});

// Create new payment request
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      student_id,
      grade_id,
      group_id,
      amount,
      payment_method = 'cash',
      receipt_image,
      notes
    } = req.body;

    if (!student_id || !grade_id || !group_id || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get student details
    const students = await query(
      'SELECT name, phone, email FROM students WHERE id = ?',
      [student_id]
    ) as unknown[];

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = students[0] as { name: string; phone: string; email: string };

    // Get grade and group names
    const grades = await query(
      'SELECT name FROM grades WHERE id = ?',
      [grade_id]
    ) as unknown[];

    const groups = await query(
      'SELECT name FROM `groups` WHERE id = ?',
      [group_id]
    ) as unknown[];

    const gradeName = Array.isArray(grades) && grades.length > 0 ? (grades[0] as { name: string }).name : '';
    const groupName = Array.isArray(groups) && groups.length > 0 ? (groups[0] as { name: string }).name : '';

    const result = await query(
      `INSERT INTO payment_requests 
       (student_id, student_name, phone, email, grade_id, grade_name, group_id, group_name, amount, payment_method, receipt_image_url, notes, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [student_id, student.name, student.phone, student.email, grade_id, gradeName, group_id, groupName, amount, payment_method, receipt_image || null, notes || null]
    );

    // Create notification for admin
    await query(
      `INSERT INTO notifications 
       (user_id, user_type, title, message, type) 
       VALUES (1, 'admin', 'طلب دفع جديد', 'تم استلام طلب دفع جديد من الطالب', 'payment_request')`,
      []
    );

    res.status(201).json({ 
      message: 'Payment request created successfully',
      id: (result as unknown as { insertId: number }).insertId 
    });
  } catch (error) {
    console.error('Error creating payment request:', error);
    res.status(500).json({ error: 'Failed to create payment request' });
  }
});

// Approve payment request
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get request details
    const requests = await query(
      'SELECT * FROM payment_requests WHERE id = ?',
      [id]
    ) as unknown[];
    
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    
    const request = requests[0] as Record<string, unknown>;
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    // Update request status
    await query(
      'UPDATE payment_requests SET status = ?, updated_at = NOW() WHERE id = ?',
      ['approved', id]
    );

    // Add to student_fees
    await query(
      `INSERT INTO student_fees 
       (student_id, grade_id, group_id, amount, payment_date, payment_method, notes) 
       VALUES (?, ?, ?, ?, NOW(), ?, 'تم الدفع عبر النظام أونلاين')`,
      [request.student_id, request.grade_id, request.group_id, request.amount, request.payment_method]
    );

    // Add to revenues
    await query(
      `INSERT INTO revenues 
       (amount, source, description, date) 
       VALUES (?, 'student_fees', 'مصروفات طالب - دفع أونلاين', NOW())`,
      [request.amount]
    );

    // Create notification for student
    await query(
      `INSERT INTO notifications 
       (user_id, user_type, title, message, type) 
       VALUES (?, 'student', 'تم قبول طلب الدفع', 'تم قبول طلب الدفع الخاص بك وإضافة المصروفات', 'payment_approved')`,
      [request.student_id]
    );

    res.json({ message: 'Payment request approved successfully' });
  } catch (error) {
    console.error('Error approving payment request:', error);
    res.status(500).json({ error: 'Failed to approve payment request' });
  }
});

// Reject payment request
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rejection_reason } = req.body;
    
    if (!rejection_reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }
    
    // Get request details
    const requests = await query(
      'SELECT * FROM payment_requests WHERE id = ?',
      [id]
    ) as unknown[];
    
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    
    const request = requests[0] as Record<string, unknown>;
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    // Update request status
    await query(
      'UPDATE payment_requests SET status = ?, rejection_reason = ?, updated_at = NOW() WHERE id = ?',
      ['rejected', rejection_reason, id]
    );

    // Create notification for student
    await query(
      `INSERT INTO notifications 
       (user_id, user_type, title, message, type) 
       VALUES (?, 'student', 'تم رفض طلب الدفع', ?, 'payment_rejected')`,
      [request.student_id, `تم رفض طلب الدفع. السبب: ${rejection_reason}`]
    );

    res.json({ message: 'Payment request rejected successfully' });
  } catch (error) {
    console.error('Error rejecting payment request:', error);
    res.status(500).json({ error: 'Failed to reject payment request' });
  }
});

// Get statistics
router.get('/stats/summary', async (req: Request, res: Response) => {
  try {
    const stats = await query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as total_approved_amount
      FROM payment_requests
    `) as unknown[];
    
    res.json(Array.isArray(stats) ? stats[0] : {});
  } catch (error) {
    console.error('Error fetching payment stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

export default router;
