import { Router, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { RowDataPacket } from 'mysql2';
import { getPool, query, queryOne, execute } from '../db';
import { AuthRequest, authenticateToken, optionalAuth, getJwtSecret } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../security/phone';
import { createNotification } from '../utils/notifications';

const router = Router();
const pool = getPool();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicMessage = 'إذا كانت البيانات صحيحة فسيظهر الطلب للمدرس للمراجعة.';

async function instructorTenant(instructorId: string) {
    return queryOne<any>(
        `SELECT t.id,t.business_name,t.owner_user_id FROM tenants t
         WHERE t.owner_user_id=? AND t.status='active' LIMIT 1`, [instructorId]
    );
}

async function validInvite(token: string) {
    if (!/^[0-9a-f]{64}$/i.test(token)) return null;
    return queryOne<any>(
        `SELECT i.id,i.tenant_id,i.instructor_id,i.expires_at,t.business_name,t.subject_type
         FROM student_enrollment_invites i INNER JOIN tenants t ON t.id=i.tenant_id
         WHERE i.token_hash=? AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP()
           AND t.status='active' LIMIT 1`, [digest(token)]
    );
}

// Instructor creates a new opaque 30-day join link and revokes older links.
router.post('/invites/rotate', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenant = await instructorTenant(req.user.id);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute(
            'UPDATE student_enrollment_invites SET revoked_at=UTC_TIMESTAMP() WHERE instructor_id=? AND revoked_at IS NULL',
            [req.user.id]
        );
        await connection.execute(
            `INSERT INTO student_enrollment_invites (id,tenant_id,instructor_id,token_hash,expires_at)
             VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY))`,
            [id, tenant.id, req.user.id, digest(token)]
        );
        await connection.execute(
            `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
             VALUES (?,?,?,?,?,?,?)`,
            [randomUUID(), req.user.id, tenant.id, 'student.invite.rotated', 'student_enrollment_invite', id, JSON.stringify({ expires_in_days: 30 })]
        );
        await connection.commit();
        res.status(201).json({ id, token, expires_in_days: 30 });
    } catch (error) {
        await connection.rollback();
        console.error('Rotate student invite error:', error);
        res.status(500).json({ error: 'Failed to create invitation' });
    } finally { connection.release(); }
});

router.get('/invites/current', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const invite = await queryOne<any>(
        `SELECT id,expires_at,created_at FROM student_enrollment_invites
         WHERE instructor_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP()
         ORDER BY created_at DESC LIMIT 1`, [req.user.id]
    );
    res.json(invite || null);
});

// Safe public metadata. No phones, ids of users, counts, or inactive records.
router.get('/join/:token', rateLimit('student-join-view', 60, 15 * 60_000), async (req, res) => {
    const invite = await validInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    const groups = await query<any>(
        `SELECT g.id,g.name,g.grade_id,g.course_id FROM \`groups\` g
         WHERE g.instructor_id=? AND g.is_active=1 ORDER BY g.name`, [invite.instructor_id]
    );
    const gradeIds = Array.from(new Set(groups.map(g => g.grade_id).filter(Boolean)));
    const courseIds = Array.from(new Set(groups.map(g => g.course_id).filter(Boolean)));
    const grades = gradeIds.length ? await query<any>(
        `SELECT id,name FROM grades WHERE is_active=1 AND id IN (${gradeIds.map(() => '?').join(',')}) ORDER BY display_order`, gradeIds
    ) : [];
    const courses = courseIds.length ? await query<any>(
        `SELECT id,name,grade FROM courses WHERE is_active=1 AND id IN (${courseIds.map(() => '?').join(',')}) ORDER BY name`, courseIds
    ) : [];
    res.set('Cache-Control', 'no-store');
    res.json({ business_name: invite.business_name, subject_type: invite.subject_type, expires_at: invite.expires_at, grades, groups, courses });
});

router.post('/join/:token/requests', rateLimit('student-join-submit', 8, 60 * 60_000), optionalAuth, async (req: AuthRequest, res: Response) => {
    const invite = await validInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    const studentName = String(req.body.student_name || '').trim();
    const guardianName = String(req.body.guardian_name || '').trim();
    const phone = normalizeEgyptianPhone(req.body.phone);
    const guardianPhone = normalizeEgyptianPhone(req.body.guardian_phone);
    const password = String(req.body.password || '');
    const gradeId = String(req.body.grade_id || '');
    const groupId = String(req.body.group_id || '');
    const requestedCourses = Array.isArray(req.body.requested_courses)
        ? Array.from(new Set(req.body.requested_courses.map(String))).slice(0, 50) : [];
    if (!studentName || !guardianName || !phone || !guardianPhone || !gradeId || !groupId) {
        return res.status(400).json({ error: 'All student, guardian, grade and group fields are required' });
    }
    if (!req.user && (password.length < 10 || password.length > 128)) {
        return res.status(400).json({ error: 'Password must be between 10 and 128 characters' });
    }
    if (req.user?.role === 'student' && normalizeEgyptianPhone(req.user.phone) !== phone) {
        return res.status(400).json({ error: 'Use the phone number of the signed-in student account' });
    }
    const group = await queryOne<any>(
        'SELECT id,grade_id,course_id FROM `groups` WHERE id=? AND instructor_id=? AND is_active=1',
        [groupId, invite.instructor_id]
    );
    if (!group || String(group.grade_id || '') !== gradeId) return res.status(400).json({ error: 'Invalid grade or group' });

    const candidates = phoneLookupCandidates(phone);
    const placeholders = candidates.map(() => '?').join(',');
    const existing = candidates.length ? await queryOne<any>(
        `SELECT id,phone FROM users WHERE role='student' AND phone IN (${placeholders}) LIMIT 1`, candidates
    ) : null;
    if (existing && req.user?.id !== existing.id) {
        // Deliberately do not reveal that the supplied phone already exists.
        return res.status(202).json({ message: publicMessage });
    }
    const userId = existing?.id || (req.user?.role === 'student' ? req.user.id : null);
    if (req.user && req.user.role !== 'student') return res.status(403).json({ error: 'Only students can join an instructor' });
    if (userId) {
        const already = await queryOne('SELECT id FROM students WHERE tenant_id=? AND user_id=? AND is_active=1', [invite.tenant_id, userId]);
        if (already) return res.status(202).json({ message: publicMessage });
    }
    const pending = await queryOne(
        `SELECT id FROM student_enrollment_requests WHERE tenant_id=? AND phone=? AND status='pending'`,
        [invite.tenant_id, phone]
    );
    if (pending) return res.status(202).json({ message: publicMessage });
    const passwordHash = userId ? null : await bcrypt.hash(password, 12);
    await execute(
        `INSERT INTO student_enrollment_requests
         (id,tenant_id,instructor_id,invite_id,user_id,student_name,phone,guardian_name,guardian_phone,password_hash,grade_id,group_id,requested_courses)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), invite.tenant_id, invite.instructor_id, invite.id, userId, studentName, phone, guardianName,
            guardianPhone, passwordHash, gradeId, groupId, JSON.stringify(requestedCourses)]
    );
    await createNotification({
        user_id: invite.instructor_id,
        user_type: 'instructor',
        title: 'طلب تسجيل طالب جديد',
        message: `أرسل ${studentName} طلب انضمام وينتظر موافقتك.`,
        type: 'general',
        link: '/instructor-students',
    });
    res.status(202).json({ message: publicMessage });
});

router.get('/requests', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const rows = await query<any>(
        `SELECT r.id,r.student_name,r.phone,r.guardian_name,r.guardian_phone,r.grade_id,r.group_id,
                r.requested_courses,r.status,r.rejection_reason,r.created_at,g.name grade_name,grp.name group_name
         FROM student_enrollment_requests r
         INNER JOIN grades g ON g.id=r.grade_id INNER JOIN \`groups\` grp ON grp.id=r.group_id
         WHERE r.instructor_id=? ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 250`, [req.user.id]
    );
    res.json(rows);
});

router.post('/requests/:id/approve', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT * FROM student_enrollment_requests WHERE id=? AND instructor_id=? AND status='pending' FOR UPDATE`,
            [req.params.id, req.user.id]
        );
        const request = rows[0];
        if (!request) { await connection.rollback(); return res.status(404).json({ error: 'Pending request not found' }); }
        const gradeId = String(req.body.grade_id || request.grade_id);
        const groupId = String(req.body.group_id || request.group_id);
        const [groups] = await connection.execute<RowDataPacket[]>(
            'SELECT id,grade_id FROM `groups` WHERE id=? AND instructor_id=? AND is_active=1', [groupId, req.user.id]
        );
        if (!groups[0] || String(groups[0].grade_id || '') !== gradeId) {
            await connection.rollback(); return res.status(400).json({ error: 'Invalid grade or group' });
        }
        let userId = request.user_id as string | null;
        if (!userId) {
            const candidates = phoneLookupCandidates(request.phone);
            const [users] = await connection.execute<RowDataPacket[]>(
                `SELECT id FROM users WHERE role='student' AND phone IN (${candidates.map(() => '?').join(',')}) LIMIT 1 FOR UPDATE`, candidates
            );
            if (users[0]) userId = users[0].id;
            else {
                userId = randomUUID();
                await connection.execute(
                    `INSERT INTO users (id,phone,password_hash,name,role,is_active,phone_verified) VALUES (?,?,?,?, 'student',1,0)`,
                    [userId, request.phone, request.password_hash, request.student_name]
                );
            }
        }
        const [existing] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1 FOR UPDATE', [request.tenant_id, userId]
        );
        if (existing[0]) { await connection.rollback(); return res.status(409).json({ error: 'Student already belongs to this instructor' }); }
        const studentId = randomUUID();
        const barcode = `STU${randomBytes(12).toString('hex')}`.toUpperCase().slice(0, 25);
        await connection.execute(
            `INSERT INTO students
             (id,user_id,tenant_id,instructor_id,name,phone,guardian_name,guardian_phone,grade_id,group_id,barcode,password_hash,approval_status,is_offline,is_active)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'approved',0,1)`,
            [studentId, userId, request.tenant_id, req.user.id, request.student_name, request.phone, request.guardian_name,
                request.guardian_phone, gradeId, groupId, barcode, request.password_hash]
        );
        const requested = Array.isArray(req.body.requested_courses) ? req.body.requested_courses :
            (typeof request.requested_courses === 'string' ? JSON.parse(request.requested_courses || '[]') : request.requested_courses || []);
        for (const courseId of Array.from(new Set(requested.map(String))).slice(0, 50)) {
            const [validCourse] = await connection.execute<RowDataPacket[]>(
                `SELECT c.id FROM courses c INNER JOIN \`groups\` g ON g.course_id=c.id
                 WHERE c.id=? AND c.is_active=1 AND g.instructor_id=? AND g.is_active=1 LIMIT 1`,
                [courseId, req.user.id]
            );
            if (validCourse[0]) await connection.execute(
                'INSERT IGNORE INTO student_courses (id,student_id,course_id) VALUES (?,?,?)', [randomUUID(), studentId, courseId]
            );
        }
        await connection.execute(
            `UPDATE student_enrollment_requests SET status='approved',user_id=?,password_hash=NULL,grade_id=?,group_id=?,decided_by=?,decided_at=UTC_TIMESTAMP() WHERE id=?`,
            [userId, gradeId, groupId, req.user.id, request.id]
        );
        await connection.execute(
            `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
             VALUES (?,?,?,?,?,?,?)`,
            [randomUUID(), req.user.id, request.tenant_id, 'student.enrollment.approved', 'student', studentId, JSON.stringify({ user_id: userId, group_id: groupId })]
        );
        await connection.commit();
        res.json({ status: 'approved', student_enrollment_id: studentId });
    } catch (error) {
        await connection.rollback();
        console.error('Approve enrollment error:', error);
        res.status(500).json({ error: 'Failed to approve enrollment' });
    } finally { connection.release(); }
});

router.post('/requests/:id/reject', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Rejection reason is required' });
    const result = await execute(
        `UPDATE student_enrollment_requests SET status='rejected',rejection_reason=?,password_hash=NULL,
         decided_by=?,decided_at=UTC_TIMESTAMP() WHERE id=? AND instructor_id=? AND status='pending'`,
        [reason, req.user.id, req.params.id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Pending request not found' });
    const rejected = await queryOne<any>('SELECT tenant_id FROM student_enrollment_requests WHERE id=?', [req.params.id]);
    if (rejected) await execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), req.user.id, rejected.tenant_id, 'student.enrollment.rejected', 'student_enrollment_request', req.params.id, JSON.stringify({ reason })]
    );
    res.json({ status: 'rejected' });
});

router.get('/spaces', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'student') return res.status(403).json({ error: 'Student access required' });
    const spaces = await query<any>(
        `SELECT s.id student_enrollment_id,s.tenant_id,t.business_name,s.grade_id,s.group_id,
                g.name grade_name,grp.name group_name
         FROM students s INNER JOIN tenants t ON t.id=s.tenant_id AND t.status='active'
         LEFT JOIN grades g ON g.id=s.grade_id LEFT JOIN \`groups\` grp ON grp.id=s.group_id
         WHERE s.user_id=? AND s.is_active=1 AND s.approval_status='approved' ORDER BY t.business_name`, [req.user.id]
    );
    res.json(spaces);
});

router.post('/spaces/:enrollmentId/select', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'student') return res.status(403).json({ error: 'Student access required' });
    const enrollment = await queryOne<any>(
        `SELECT s.id,s.tenant_id,s.instructor_id,s.group_id,s.grade_id FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
         WHERE s.id=? AND s.user_id=? AND s.is_active=1 AND s.approval_status='approved' AND t.status='active'`,
        [req.params.enrollmentId, req.user.id]
    );
    if (!enrollment) return res.status(404).json({ error: 'Student workspace not found' });
    const token = jwt.sign({ id: req.user.id, email: req.user.email, phone: req.user.phone, role: 'student',
        tenant_id: enrollment.tenant_id, student_enrollment_id: enrollment.id, instructor_id: enrollment.instructor_id,
        group_id: enrollment.group_id, grade_id: enrollment.grade_id,
        tv: Number(req.user.tokenVersion || 0),
        type: 'student_scoped' }, getJwtSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as jwt.SignOptions);
    res.json({ token, tenant_id: enrollment.tenant_id, student_enrollment_id: enrollment.id });
});

// Privacy-preserving reset request, routed by the instructor's invite token.
router.post('/join/:token/password-reset', rateLimit('student-password-reset', 5, 60 * 60_000), async (req, res) => {
    const invite = await validInvite(req.params.token);
    const phone = normalizeEgyptianPhone(req.body.phone);
    if (invite && phone) {
        const candidates = phoneLookupCandidates(phone);
        const enrollment = await queryOne<any>(
            `SELECT s.id,s.user_id FROM students s WHERE s.tenant_id=? AND s.phone IN (${candidates.map(() => '?').join(',')})
             AND s.is_active=1 LIMIT 1`, [invite.tenant_id, ...candidates]
        );
        if (enrollment) {
            const pending = await queryOne('SELECT id FROM student_password_reset_requests WHERE tenant_id=? AND user_id=? AND status=\'pending\'', [invite.tenant_id, enrollment.user_id]);
            if (!pending) await execute(
                `INSERT INTO student_password_reset_requests (id,tenant_id,user_id,student_enrollment_id) VALUES (?,?,?,?)`,
                [randomUUID(), invite.tenant_id, enrollment.user_id, enrollment.id]
            );
        }
    }
    res.status(202).json({ message: 'إذا كان الحساب موجودًا فسيصل طلب الاسترجاع إلى المدرس.' });
});

router.get('/password-resets', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenant = await instructorTenant(req.user.id);
    const rows = tenant ? await query<any>(
        `SELECT r.id,r.status,r.created_at,s.name,s.phone FROM student_password_reset_requests r
         INNER JOIN students s ON s.id=r.student_enrollment_id WHERE r.tenant_id=? ORDER BY r.created_at DESC LIMIT 100`, [tenant.id]
    ) : [];
    res.json(rows);
});

router.post('/password-resets/:id/approve', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenant = await instructorTenant(req.user.id);
    if (!tenant) return res.status(404).json({ error: 'Workspace not found' });
    const rawToken = randomBytes(32).toString('hex');
    const result = await execute(
        `UPDATE student_password_reset_requests SET status='approved',reset_token_hash=?,reset_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE),
         decided_by=?,decided_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=? AND status='pending'`,
        [digest(rawToken), req.user.id, req.params.id, tenant.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Pending reset request not found' });
    await execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), req.user.id, tenant.id, 'student.password_reset.approved', 'student_password_reset_request', req.params.id, JSON.stringify({ expires_in_minutes: 15 })]
    );
    res.json({ reset_token: rawToken, expires_in_minutes: 15 });
});

router.post('/password-resets/complete', rateLimit('student-password-complete', 8, 60 * 60_000), async (req, res) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (!/^[0-9a-f]{64}$/i.test(token) || password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Invalid reset data' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT id,user_id FROM student_password_reset_requests WHERE reset_token_hash=? AND status='approved'
             AND reset_expires_at>UTC_TIMESTAMP() FOR UPDATE`, [digest(token)]
        );
        if (!rows[0]) { await connection.rollback(); return res.status(400).json({ error: 'Reset code is invalid or expired' }); }
        const hash = await bcrypt.hash(password, 12);
        await connection.execute('UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=?', [hash, rows[0].user_id]);
        await connection.execute(`UPDATE student_password_reset_requests SET status='used',reset_token_hash=NULL,used_at=UTC_TIMESTAMP() WHERE id=?`, [rows[0].id]);
        await connection.commit();
        res.json({ success: true });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Failed to reset password' });
    } finally { connection.release(); }
});

// Platform-support review queue for legacy rows that could not be linked safely.
router.get('/backfill-reviews', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Platform admin access required' });
    const rows = await query<any>(
        `SELECT r.id,r.student_id,r.reason,r.status,r.created_at,s.name,s.phone,s.user_id,s.tenant_id,s.instructor_id,s.group_id
         FROM student_enrollment_backfill_reviews r INNER JOIN students s ON s.id=r.student_id
         WHERE r.status='pending' ORDER BY r.created_at LIMIT 250`
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
});

router.post('/backfill-reviews/:id/resolve', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Platform admin access required' });
    return res.status(410).json({ error: 'Legacy identity assignment is disabled until a server-side adjudication workflow is available' });
});

export async function cleanupEnrollmentPrivacyData(): Promise<void> {
    await execute(`UPDATE student_enrollment_requests SET status='expired',password_hash=NULL
                   WHERE status='pending' AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)`);
    await execute(`DELETE FROM student_enrollment_requests WHERE status IN ('rejected','expired')
                   AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)`);
    await execute(`UPDATE student_password_reset_requests SET status='expired',reset_token_hash=NULL
                   WHERE status IN ('pending','approved') AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)`);
}

export default router;
