import { Router, Request, Response } from 'express';
import { query, execute } from '../db';

const router = Router();

// Get all subscription requests
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    
    let sql = 'SELECT * FROM subscription_requests WHERE 1=1';
    const params: unknown[] = [];
    
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY created_at DESC';
    
    const requests = await query(sql, params);
    res.json(requests);
  } catch (error) {
    console.error('Error fetching subscription requests:', error);
    res.status(500).json({ error: 'Failed to fetch subscription requests' });
  }
});

// Create new subscription request
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      student_name,
      phone,
      grade_id,
      grade_name,
      group_id,
      group_name,
      amount,
      notes,
      receipt_image_url
    } = req.body;

    if (!student_name || !phone) {
      return res.status(400).json({ error: 'Student name and phone are required' });
    }

    await execute(
      `INSERT INTO subscription_requests 
       (student_name, phone, grade_id, grade_name, group_id, group_name, amount, notes, receipt_image_url, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [student_name, phone, grade_id || null, grade_name || null, group_id || null, group_name || null, amount || null, notes || null, receipt_image_url || null]
    );

    res.status(201).json({ message: 'Subscription request created successfully' });
  } catch (error) {
    console.error('Error creating subscription request:', error);
    res.status(500).json({ error: 'Failed to create subscription request' });
  }
});

// Approve subscription request
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const requests = await query(
      'SELECT * FROM subscription_requests WHERE id = ?',
      [id]
    ) as unknown[];
    
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(404).json({ error: 'Subscription request not found' });
    }
    
    const request = requests[0] as Record<string, unknown>;
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    // Check if student already exists
    const existingStudents = await query(
      'SELECT id FROM students WHERE phone = ?',
      [request.phone]
    ) as unknown[];

    // Validate grade_id and group_id before inserting
    let validGradeId = null;
    let validGroupId = null;

    if (request.grade_id) {
      const gradeCheck = await query(
        'SELECT id FROM grades WHERE id = ?',
        [request.grade_id]
      ) as unknown[];
      if (Array.isArray(gradeCheck) && gradeCheck.length > 0) {
        validGradeId = request.grade_id;
      }
    }

    if (request.group_id) {
      const groupCheck = await query(
        'SELECT id FROM `groups` WHERE id = ?',
        [request.group_id]
      ) as unknown[];
      if (Array.isArray(groupCheck) && groupCheck.length > 0) {
        validGroupId = request.group_id;
      }
    }

    let studentId;
    if (!Array.isArray(existingStudents) || existingStudents.length === 0) {
      // Add student to students table (online)
      const result = await execute(
        `INSERT INTO students 
         (name, phone, grade_id, group_id, is_offline, approval_status) 
         VALUES (?, ?, ?, ?, FALSE, 'approved')`,
        [request.student_name, request.phone, validGradeId, validGroupId]
      );
      studentId = (result as any).insertId;
    } else {
      studentId = (existingStudents[0] as any).id;
    }

    // Add fee record with paid_amount = amount (since they already paid)
    await execute(
      `INSERT INTO student_fees 
       (student_name, phone, grade_id, grade_name, group_id, group_name, amount, paid_amount, status, is_offline, payment_method, notes, receipt_image_url, payment_date) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', FALSE, 'online', ?, ?, NOW())`,
      [request.student_name, request.phone, validGradeId, request.grade_name, validGroupId, request.group_name, request.amount || 0, request.amount || 0, request.notes, request.receipt_image_url]
    );

    // Update request status
    await execute(
      'UPDATE subscription_requests SET status = ?, updated_at = NOW() WHERE id = ?',
      ['approved', id]
    );

    res.json({ message: 'Subscription request approved successfully' });
  } catch (error) {
    console.error('Error approving subscription request:', error);
    res.status(500).json({ error: 'Failed to approve subscription request' });
  }
});

// Reject subscription request
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rejection_reason } = req.body;
    
    if (!rejection_reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }
    
    const requests = await query(
      'SELECT * FROM subscription_requests WHERE id = ?',
      [id]
    ) as unknown[];
    
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(404).json({ error: 'Subscription request not found' });
    }
    
    const request = requests[0] as Record<string, unknown>;
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    await execute(
      'UPDATE subscription_requests SET status = ?, rejection_reason = ?, updated_at = NOW() WHERE id = ?',
      ['rejected', rejection_reason, id]
    );

    res.json({ message: 'Subscription request rejected successfully' });
  } catch (error) {
    console.error('Error rejecting subscription request:', error);
    res.status(500).json({ error: 'Failed to reject subscription request' });
  }
});

export default router;
