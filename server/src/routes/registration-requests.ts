import express, { Request, Response, NextFunction } from 'express';
import { getPool } from '../db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const router = express.Router();
const pool = getPool();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ====================================
// Middleware - Authentication
// ====================================

interface AuthRequest extends Request {
    user?: {
        id: string;
        role: string;
    };
}

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// ====================================
// POST /api/registration-requests
// Create a new registration request
// ====================================

router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, phone, password, grade_id, group_id, requested_courses } = req.body;

        // Validation
        if (!name || !phone || !password) {
            return res.status(400).json({ error: 'Name, phone, and password are required' });
        }

        // Check if phone already exists in users table
        const [existingUsers] = await pool.query<RowDataPacket[]>(
            'SELECT id FROM users WHERE phone = ?',
            [phone]
        );

        if (existingUsers.length > 0) {
            return res.status(400).json({ error: 'رقم الهاتف مسجل بالفعل' });
        }

        // Check if phone already has a pending request
        const [existingRequests] = await pool.query<RowDataPacket[]>(
            'SELECT id FROM student_registration_requests WHERE phone = ? AND status = ?',
            [phone, 'pending']
        );

        if (existingRequests.length > 0) {
            return res.status(400).json({ error: 'لديك طلب تسجيل قيد المراجعة بالفعل' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Convert requested_courses array to JSON string if provided
        const coursesJson = requested_courses ? JSON.stringify(requested_courses) : null;

        // Insert registration request with UUID (without email)
        const requestId = randomUUID();
        await pool.query(
            `INSERT INTO student_registration_requests 
            (id, name, phone, password_hash, grade_id, group_id, requested_courses, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                requestId,
                name,
                phone,
                hashedPassword,
                grade_id || null,
                group_id || null,
                coursesJson,
                'pending'
            ]
        );

        res.status(201).json({
            id: requestId,
            message: 'تم إرسال طلب التسجيل بنجاح. سيتم مراجعته من قبل الإدارة.'
        });
    } catch (error) {
        console.error('Error creating registration request:', error);
        res.status(500).json({ error: 'Failed to create registration request' });
    }
});

// ====================================
// GET /api/registration-requests
// Get all registration requests (admin only)
// ====================================

router.get('/', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const { status } = req.query;

        let query = `
            SELECT 
                rr.*,
                g.name as grade_name,
                gr.name as group_name
            FROM student_registration_requests rr
            LEFT JOIN grades g ON rr.grade_id = g.id
            LEFT JOIN \`groups\` gr ON rr.group_id = gr.id
        `;

        const params: string[] = [];

        if (status && ['pending', 'approved', 'rejected'].includes(status as string)) {
            query += ' WHERE rr.status = ?';
            params.push(status as string);
        }

        query += ' ORDER BY rr.created_at DESC';

        const [requests] = await pool.query<RowDataPacket[]>(query, params);

        res.json(requests);
    } catch (error) {
        console.error('Error fetching registration requests:', error);
        res.status(500).json({ error: 'Failed to fetch registration requests' });
    }
});

// ====================================
// POST /api/registration-requests/:id/approve
// Approve a registration request (admin only)
// ====================================

router.post('/:id/approve', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    const connection = await pool.getConnection();
    
    try {
        const { id } = req.params;

        await connection.beginTransaction();

        // Get the request
        const [requests] = await connection.query<RowDataPacket[]>(
            'SELECT * FROM student_registration_requests WHERE id = ? AND status = ?',
            [id, 'pending']
        );

        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'طلب التسجيل غير موجود أو تم معالجته بالفعل' });
        }

        const request = requests[0];

        // Check if user already exists (phone only)
        const [existingUser] = await connection.query<RowDataPacket[]>(
            'SELECT id FROM users WHERE phone = ?',
            [request.phone]
        );

        if (existingUser.length > 0) {
            await connection.rollback();
            return res.status(400).json({ 
                error: 'مستخدم بهذا الهاتف موجود بالفعل' 
            });
        }

        // Create user account with UUID (without email)
        const userId = randomUUID();
        await connection.query(
            `INSERT INTO users (id, phone, password_hash, name, role, is_active, phone_verified, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [userId, request.phone, request.password_hash, request.name, 'student', true, true]
        );

        // Create student record with UUID (without email)
        const studentId = randomUUID();
        await connection.query(
            `INSERT INTO students (id, name, phone, grade_id, group_id, password_hash, approval_status, is_offline, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [studentId, request.name, request.phone, request.grade_id, request.group_id, request.password_hash, 'approved', false]
        );

        // If requested courses, create student_courses entries
        if (request.requested_courses) {
            try {
                let courseIds;
                console.log('Raw requested_courses:', request.requested_courses);
                console.log('Type:', typeof request.requested_courses);
                
                // Handle both JSON string and array
                if (typeof request.requested_courses === 'string') {
                    // Try to parse JSON string
                    try {
                        courseIds = JSON.parse(request.requested_courses);
                    } catch (parseErr) {
                        console.error('Failed to parse requested_courses as JSON:', parseErr);
                        courseIds = [];
                    }
                } else if (Array.isArray(request.requested_courses)) {
                    courseIds = request.requested_courses;
                } else {
                    console.warn('Unexpected requested_courses type, skipping');
                    courseIds = [];
                }
                
                console.log('Parsed courseIds:', courseIds);
                
                if (Array.isArray(courseIds) && courseIds.length > 0) {
                    for (const courseId of courseIds) {
                        console.log('Inserting course:', courseId);
                        await connection.query(
                            'INSERT INTO student_courses (id, student_id, course_id) VALUES (?, ?, ?)',
                            [randomUUID(), studentId, courseId]
                        );
                    }
                }
            } catch (parseError) {
                console.error('Error processing requested courses:', parseError);
                if (parseError instanceof Error) {
                    console.error('Parse error details:', parseError.message);
                }
                // Continue anyway - don't fail the whole approval
            }
        } else {
            console.log('No requested_courses to process');
        }

        // Update request status
        await connection.query(
            'UPDATE student_registration_requests SET status = ?, updated_at = NOW() WHERE id = ?',
            ['approved', id]
        );

        await connection.commit();

        res.json({
            message: 'تم قبول الطلب وإنشاء حساب الطالب بنجاح',
            user: {
                id: userId,
                name: request.name,
                phone: request.phone,
                role: 'student'
            },
            student: {
                id: studentId,
                name: request.name,
                phone: request.phone,
                grade_id: request.grade_id,
                group_id: request.group_id
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error approving registration request:', error);
        // Log detailed error information
        if (error instanceof Error) {
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
        }
        res.status(500).json({ 
            error: 'Failed to approve registration request',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    } finally {
        connection.release();
    }
});

// ====================================
// POST /api/registration-requests/:id/reject
// Reject a registration request (admin only)
// ====================================

router.post('/:id/reject', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        // Check if request exists and is pending
        const [requests] = await pool.query<RowDataPacket[]>(
            'SELECT id FROM student_registration_requests WHERE id = ? AND status = ?',
            [id, 'pending']
        );

        if (requests.length === 0) {
            return res.status(404).json({ error: 'طلب التسجيل غير موجود أو تم معالجته بالفعل' });
        }

        // Update request status
        await pool.query(
            'UPDATE student_registration_requests SET status = ?, rejection_reason = ?, updated_at = NOW() WHERE id = ?',
            ['rejected', reason || null, id]
        );

        res.json({ message: 'تم رفض الطلب بنجاح' });
    } catch (error) {
        console.error('Error rejecting registration request:', error);
        res.status(500).json({ error: 'Failed to reject registration request' });
    }
});

export default router;
