import { Router, Response } from 'express';
import { query, execute } from '../db';
import { sendSubscriptionApprovalNotification } from '../services/whatsapp-free';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';

const router = Router();
router.use(authenticateToken);

// Get all subscription requests
router.get('/', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query;

    let sql = 'SELECT * FROM subscription_requests WHERE tenant_id=?';
    const params: unknown[] = [req.user!.tenantId || ''];
    if (req.user!.role === 'admin') { sql = 'SELECT * FROM subscription_requests WHERE 1=1'; params.length = 0; }

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
router.post('/', requireRoles('student', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
  try {
    const {
      student_name,
      phone,
      guardian_phone,
      grade_id,
      grade_name,
      group_id,
      group_name,
      subscription_plan_id,
      subscription_plan_name,
      amount,
      notes,
      receipt_image_url
    } = req.body;
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Active tenant membership required' });

    if (!student_name || !phone) {
      return res.status(400).json({ error: 'Student name and phone are required' });
    }

    // Generate UUID for the new request
    const { randomUUID } = await import('crypto');
    const requestId = randomUUID();

    await execute(
      `INSERT INTO subscription_requests
       (id, tenant_id, student_name, phone, guardian_phone, grade_id, grade_name, group_id, group_name, subscription_plan_id, subscription_plan_name, amount, notes, receipt_image_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [requestId, tenantId, student_name, phone, guardian_phone || null, grade_id || null, grade_name || null, group_id || null, group_name || null, subscription_plan_id || null, subscription_plan_name || null, amount || null, notes || null, receipt_image_url || null]
    );

    res.status(201).json({
      message: 'Subscription request created successfully',
      id: requestId
    });
  } catch (error) {
    console.error('Error creating subscription request:', error);
    res.status(500).json({ error: 'Failed to create subscription request' });
  }
});

// Approve subscription request
router.post('/:id/approve', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const requests = await query(
      `SELECT * FROM subscription_requests WHERE id = ?${req.user!.role === 'admin' ? '' : ' AND tenant_id=?'}`,
      req.user!.role === 'admin' ? [id] : [id, req.user!.tenantId || '']
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
      'SELECT id FROM students WHERE phone = ? AND tenant_id = ?',
      [request.phone, request.tenant_id]
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
         (name, phone, grade_id, group_id, tenant_id, instructor_id, is_offline, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, FALSE, 'approved')`,
        [request.student_name, request.phone, validGradeId, validGroupId, request.tenant_id, req.user!.id]
      );
      studentId = (result as any).insertId;
    } else {
      studentId = (existingStudents[0] as any).id;
    }

    // Add fee record with paid_amount = amount (since they already paid)
    await execute(
      `INSERT INTO student_fees
       (tenant_id, student_id, student_name, phone, grade_id, grade_name, group_id, group_name, amount, paid_amount, status, is_offline, payment_method, notes, receipt_image_url, payment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', FALSE, 'online', ?, ?, NOW())`,
      [request.tenant_id, studentId, request.student_name, request.phone, validGradeId, request.grade_name, validGroupId, request.group_name, request.amount || 0, request.amount || 0, request.notes, request.receipt_image_url]
    );

    // Update request status
    await execute(
      `UPDATE subscription_requests SET status = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?`,
      ['approved', id, request.tenant_id]
    );

    // Send WhatsApp message to guardian if guardian_phone exists
    let whatsappSent = false;
    let whatsappLink = '';
    if (request.guardian_phone) {
      try {
        const result = await sendSubscriptionApprovalNotification(
          String(request.guardian_phone),
          String(request.student_name),
          Number(request.amount),
          String(request.grade_name || 'غير محدد'),
          String(request.group_name || 'غير محدد')
        );
        whatsappSent = result.success;
        whatsappLink = result.whatsappLink || '';

        if (result.success) {
          console.log(`✅ WhatsApp link generated for ${request.guardian_phone}`);
          console.log(`🔗 Link: ${result.whatsappLink}`);
        } else {
          console.error(`❌ Failed to generate WhatsApp link: ${result.error}`);
        }
      } catch (whatsappError) {
        console.error('Error sending WhatsApp message:', whatsappError);
        // Don't fail the approval if WhatsApp fails
      }
    }

    res.json({
      message: 'Subscription request approved successfully',
      whatsapp_sent: whatsappSent,
      whatsapp_link: whatsappLink
    });
  } catch (error) {
    console.error('Error approving subscription request:', error);
    res.status(500).json({ error: 'Failed to approve subscription request' });
  }
});

// Reject subscription request
router.post('/:id/reject', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { rejection_reason } = req.body;

    if (!rejection_reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const requests = await query(
      `SELECT * FROM subscription_requests WHERE id = ?${req.user!.role === 'admin' ? '' : ' AND tenant_id=?'}`,
      req.user!.role === 'admin' ? [id] : [id, req.user!.tenantId || '']
    ) as unknown[];

    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(404).json({ error: 'Subscription request not found' });
    }

    const request = requests[0] as Record<string, unknown>;

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    await execute(
      'UPDATE subscription_requests SET status = ?, rejection_reason = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?',
      ['rejected', rejection_reason, id, request.tenant_id]
    );

    res.json({ message: 'Subscription request rejected successfully' });
  } catch (error) {
    console.error('Error rejecting subscription request:', error);
    res.status(500).json({ error: 'Failed to reject subscription request' });
  }
});

// Delete subscription request (cleanup)
router.delete('/:id', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await execute(
      `DELETE FROM subscription_requests WHERE id = ?${req.user!.role === 'admin' ? '' : ' AND tenant_id=?'}`,
      req.user!.role === 'admin' ? [id] : [id, req.user!.tenantId || '']
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Subscription request not found' });
    }

    res.json({ message: 'Subscription request deleted successfully' });
  } catch (error) {
    console.error('Error deleting subscription request:', error);
    res.status(500).json({ error: 'Failed to delete subscription request' });
  }
});

// Bulk delete approved requests by month
router.delete('/cleanup/month', requireRoles('admin', 'instructor', 'teacher', 'staff'), async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    const result = await execute(
      `DELETE FROM subscription_requests WHERE status = ? AND MONTH(updated_at) = ? AND YEAR(updated_at) = ?${req.user!.role === 'admin' ? '' : ' AND tenant_id=?'}`,
      req.user!.role === 'admin' ? ['approved', month, year] : ['approved', month, year, req.user!.tenantId || '']
    );

    res.json({
      message: 'Approved requests cleaned up successfully',
      deletedCount: result.affectedRows
    });
  } catch (error) {
    console.error('Error cleaning up requests:', error);
    res.status(500).json({ error: 'Failed to cleanup requests' });
  }
});

export default router;
