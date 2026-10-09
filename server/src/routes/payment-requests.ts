import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { execute, query, queryOne } from '../db';

const router = Router();
router.use(authenticateToken, requireRoles('admin', 'instructor', 'teacher', 'staff'));
const tenantSql = (req: AuthRequest, alias = '') => req.user?.role === 'admin' ? '' : ` AND ${alias}tenant_id=?`;
const tenantArgs = (req: AuthRequest) => req.user?.role === 'admin' ? [] : [req.user?.tenantId || ''];

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, student_id } = req.query;
    let sql = `SELECT pr.*,s.name AS student_name,s.phone AS student_phone,g.name AS grade_name,gr.name AS group_name
      FROM payment_requests pr LEFT JOIN students s ON pr.student_id=s.id AND s.tenant_id=pr.tenant_id
      LEFT JOIN grades g ON pr.grade_id=g.id LEFT JOIN \`groups\` gr ON pr.group_id=gr.id
      WHERE 1=1${tenantSql(req, 'pr.')}`;
    const params: unknown[] = tenantArgs(req);
    if (status) { sql += ' AND pr.status=?'; params.push(status); }
    if (student_id) { sql += ' AND pr.student_id=?'; params.push(student_id); }
    sql += ' ORDER BY pr.created_at DESC';
    res.json(await query(sql, params));
  } catch (error) {
    console.error('Get payment requests error:', error);
    res.status(500).json({ error: 'Failed to fetch payment requests' });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user?.tenantId;
    const { student_id, grade_id, group_id, amount, payment_method = 'cash', receipt_image, notes } = req.body;
    if (!tenantId) return res.status(403).json({ error: 'Active tenant membership required' });
    if (!student_id || !grade_id || !group_id || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Missing or invalid payment fields' });
    }
    const student = await queryOne<any>('SELECT id,user_id,name,phone,email,grade_id,group_id FROM students WHERE id=? AND tenant_id=? AND is_active=1', [student_id, tenantId]);
    if (!student) return res.status(404).json({ error: 'Student not found in your tenant' });
    const grade = await queryOne<any>('SELECT id,name FROM grades WHERE id=?', [grade_id]);
    const group = await queryOne<any>(
      `SELECT g.id,g.name FROM \`groups\` g
       INNER JOIN tenant_memberships m ON m.user_id=g.instructor_id AND m.tenant_id=? AND m.status='active'
       INNER JOIN tenants t ON t.id=m.tenant_id
       WHERE g.id=? AND t.status='active'`, [tenantId, group_id]
    );
    if (!grade || !group || String(student.grade_id) !== String(grade_id) || String(student.group_id) !== String(group_id)) {
      return res.status(404).json({ error: 'Student, grade, or group is outside the authenticated tenant' });
    }
    const id = randomUUID();
    await execute(
      `INSERT INTO payment_requests (id,tenant_id,student_id,student_name,phone,email,grade_id,grade_name,group_id,group_name,amount,payment_method,receipt_image_url,notes,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [id, tenantId, student.id, student.name, student.phone, student.email, grade.id, grade.name, group.id, group.name, Number(amount), payment_method, receipt_image || null, notes || null]
    );
    const admin = await queryOne<any>("SELECT id FROM users WHERE role='admin' AND is_active=1 ORDER BY created_at LIMIT 1");
    if (admin) await execute(
      `INSERT INTO notifications (user_id,user_type,title,message,type) VALUES (?,'admin','طلب دفع جديد','تم استلام طلب دفع جديد من الطالب','payment_request')`, [admin.id]
    );
    res.status(201).json({ message: 'Payment request created successfully', id });
  } catch (error) {
    console.error('Create payment request error:', error);
    res.status(500).json({ error: 'Failed to create payment request' });
  }
});

async function getOwnedRequest(req: AuthRequest, id: string) {
  return queryOne<any>(`SELECT * FROM payment_requests WHERE id=?${tenantSql(req)}`, [id, ...tenantArgs(req)]);
}

router.post('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const request = await getOwnedRequest(req, req.params.id);
    if (!request) return res.status(404).json({ error: 'Payment request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
    const enrollment = await queryOne<any>(
      'SELECT id,user_id,name,phone,guardian_phone,barcode FROM students WHERE id=? AND tenant_id=? AND is_active=1',
      [request.student_id, request.tenant_id]
    );
    if (!enrollment) return res.status(409).json({ error: 'Student enrollment is no longer active' });
    await execute(
      `INSERT INTO student_fees (tenant_id,student_id,student_name,phone,guardian_phone,grade_id,grade_name,group_id,group_name,amount,paid_amount,status,payment_method,is_offline,payment_date,payment_year,payment_month,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'paid',?,FALSE,CURDATE(),YEAR(CURDATE()),MONTH(CURDATE()),?)`,
      [request.tenant_id, request.student_id, enrollment.name, enrollment.phone, enrollment.guardian_phone, request.grade_id, request.grade_name, request.group_id, request.group_name, request.amount, request.amount, request.payment_method, request.notes || 'تم الدفع عبر النظام أونلاين']
    );
    await execute(
      `INSERT INTO revenues (tenant_id,amount,source,description,date) VALUES (?,?,'student_fees','مصروفات طالب - دفع أونلاين',CURDATE())`,
      [request.tenant_id, request.amount]
    );
    await execute(`UPDATE payment_requests SET status='approved',updated_at=NOW() WHERE id=? AND tenant_id=? AND status='pending'`, [request.id, request.tenant_id]);
    if (enrollment.user_id) await execute(
      `INSERT INTO notifications (user_id,user_type,title,message,type) VALUES (?,'student','تم قبول طلب الدفع','تم قبول طلب الدفع الخاص بك وإضافة المصروفات','payment_approved')`, [enrollment.user_id]
    );
    res.json({ message: 'Payment request approved successfully' });
  } catch (error) {
    console.error('Approve payment request error:', error);
    res.status(500).json({ error: 'Failed to approve payment request' });
  }
});

router.post('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { rejection_reason } = req.body;
    if (!rejection_reason) return res.status(400).json({ error: 'Rejection reason is required' });
    const request = await getOwnedRequest(req, req.params.id);
    if (!request) return res.status(404).json({ error: 'Payment request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
    await execute(`UPDATE payment_requests SET status='rejected',rejection_reason=?,updated_at=NOW() WHERE id=? AND tenant_id=? AND status='pending'`, [rejection_reason, request.id, request.tenant_id]);
    const enrollment = await queryOne<any>('SELECT user_id FROM students WHERE id=? AND tenant_id=?', [request.student_id, request.tenant_id]);
    if (enrollment?.user_id) await execute(
      `INSERT INTO notifications (user_id,user_type,title,message,type) VALUES (?,'student','تم رفض طلب الدفع',?,'payment_rejected')`,
      [enrollment.user_id, `تم رفض طلب الدفع. السبب: ${rejection_reason}`]
    );
    res.json({ message: 'Payment request rejected successfully' });
  } catch (error) {
    console.error('Reject payment request error:', error);
    res.status(500).json({ error: 'Failed to reject payment request' });
  }
});

router.get('/stats/summary', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await query(
      `SELECT COUNT(*) AS total,SUM(status='pending') AS pending,SUM(status='approved') AS approved,SUM(status='rejected') AS rejected,
       SUM(CASE WHEN status='approved' THEN amount ELSE 0 END) AS total_approved_amount FROM payment_requests WHERE 1=1${tenantSql(req)}`,
      tenantArgs(req)
    );
    res.json(rows[0] || {});
  } catch (error) {
    console.error('Payment request stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

export default router;
