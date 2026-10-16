import { Router, Request, Response, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import { authenticateToken, getJwtSecret } from '../middleware/auth';
import { requireAdminPermission } from '../security/admin-permissions';

interface Staff {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    password_hash?: string;
    role: string;
    accessible_pages: string[];
    is_active: boolean;
    created_at?: string;
    updated_at?: string;
}

/**
 * Dependencies of the staff router. Injection keeps production wiring in one
 * place (the default export below) and lets hermetic tests drive the real
 * routes with isolated adapters instead of a database.
 *
 * Access policy: every CRUD operation requires an authenticated, verified
 * platform admin. The guard is `requireAdminPermission('staff.manage')`: it
 * passes only for a super_admin assignment verified server-side through
 * `admin_user_roles` joined against an active users row, or for a verified
 * admin holding the permission key. A JWT `admin` role claim minted at login
 * is never sufficient on its own, and tenant admins hold no platform
 * assignment, so both are denied (403). The seeded
 * admin_role_permissions table contains no `staff.*` key (verified against
 * the schema on 2026-10-13), so today the super_admin check is the effective
 * policy; no permission insert or migration is added in this batch. Lookup
 * failures deny with 503 instead of failing open.
 */
export interface StaffRouterDeps {
    query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    execute: (sql: string, params?: any[]) => Promise<{ insertId: number; affectedRows: number }>;
    comparePassword: (password: string, hash: string) => Promise<boolean>;
    authenticate: RequestHandler;
    authorizeAdmin: RequestHandler;
}

export const createStaffRouter = (deps: StaffRouterDeps) => {
    const staffRouter = Router();

    // Get all staff members
    staffRouter.get('/', deps.authenticate, deps.authorizeAdmin, async (req: Request, res: Response) => {
        try {
            const staffList = await deps.query<Staff>(
                `SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at
                 FROM staff WHERE is_active = 1 ORDER BY created_at DESC`
            );

            // Parse accessible_pages from JSON string to array
            const parsedStaff = staffList.map(s => ({
                ...s,
                accessible_pages: typeof s.accessible_pages === 'string'
                    ? JSON.parse(s.accessible_pages)
                    : (s.accessible_pages || [])
            }));

            res.json(parsedStaff);
        } catch (error) {
            console.error('Error fetching staff:', error);
            res.status(500).json({ error: 'Failed to fetch staff' });
        }
    });

    // Get single staff member
    staffRouter.get('/:id', deps.authenticate, deps.authorizeAdmin, async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const staff = await deps.queryOne<Staff>(
                `SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at
                 FROM staff WHERE id = ?`,
                [id]
            );

            if (!staff) {
                return res.status(404).json({ error: 'Staff not found' });
            }

            // Parse accessible_pages
            const parsedStaff = {
                ...staff,
                accessible_pages: typeof staff.accessible_pages === 'string'
                    ? JSON.parse(staff.accessible_pages)
                    : (staff.accessible_pages || [])
            };

            res.json(parsedStaff);
        } catch (error) {
            console.error('Error fetching staff:', error);
            res.status(500).json({ error: 'Failed to fetch staff' });
        }
    });

    // Create new staff member
    staffRouter.post('/', deps.authenticate, deps.authorizeAdmin, async (req: Request, res: Response) => {
        try {
            const { name, phone, password, accessible_pages = [] } = req.body;

            if (!name || !phone || !password) {
                return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' });
            }

            // Check if phone exists in staff table
            const existingStaff = await deps.queryOne(
                'SELECT id FROM staff WHERE phone = ?',
                [phone.trim()]
            );

            if (existingStaff) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف' });
            }

            // Check if phone exists in users table (admin/teacher/student)
            const existingUser = await deps.queryOne(
                'SELECT id, role FROM users WHERE phone = ?',
                [phone.trim()]
            );

            if (existingUser) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل في النظام' });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);

            // Insert new staff
            const result = await deps.execute(
                `INSERT INTO staff (name, phone, password_hash, role, accessible_pages, is_active)
                 VALUES (?, ?, ?, 'staff', ?, 1)`,
                [
                    name.trim(),
                    phone.trim(),
                    passwordHash,
                    JSON.stringify(accessible_pages)
                ]
            );

            const staffId = result.insertId;

            res.status(201).json({
                id: staffId.toString(),
                name: name.trim(),
                phone: phone.trim(),
                role: 'staff',
                accessible_pages,
                is_active: true,
                message: 'تم إنشاء الموظف بنجاح'
            });
        } catch (error) {
            console.error('Error creating staff:', error);
            res.status(500).json({ error: 'Failed to create staff' });
        }
    });

    // Update staff member
    staffRouter.put('/:id', deps.authenticate, deps.authorizeAdmin, async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const { name, phone, password, accessible_pages } = req.body;

            // Check if staff exists
            const existingStaff = await deps.queryOne<Staff>(
                'SELECT id, phone FROM staff WHERE id = ?',
                [id]
            );

            if (!existingStaff) {
                return res.status(404).json({ error: 'الموظف غير موجود' });
            }

            // Check for duplicate phone (if phone is being changed)
            if (phone && phone.trim() !== existingStaff.phone) {
                // Check in staff table
                const duplicateStaffPhone = await deps.queryOne(
                    'SELECT id FROM staff WHERE phone = ? AND id != ?',
                    [phone.trim(), id]
                );
                if (duplicateStaffPhone) {
                    return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف آخر' });
                }

                // Check in users table
                const duplicateUserPhone = await deps.queryOne(
                    'SELECT id FROM users WHERE phone = ?',
                    [phone.trim()]
                );
                if (duplicateUserPhone) {
                    return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل في النظام' });
                }
            }

            // Build update query
            const updateFields: string[] = [];
            const updateValues: any[] = [];

            if (name) {
                updateFields.push('name = ?');
                updateValues.push(name.trim());
            }
            if (phone) {
                updateFields.push('phone = ?');
                updateValues.push(phone.trim());
            }
            if (password) {
                const passwordHash = await bcrypt.hash(password, 10);
                updateFields.push('password_hash = ?');
                updateValues.push(passwordHash);
            }
            if (accessible_pages !== undefined) {
                updateFields.push('accessible_pages = ?');
                updateValues.push(JSON.stringify(accessible_pages));
            }

            if (updateFields.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            updateFields.push('updated_at = NOW()');
            updateValues.push(id);

            await deps.execute(
                `UPDATE staff SET ${updateFields.join(', ')} WHERE id = ?`,
                updateValues
            );

            // Fetch updated staff
            const updatedStaff = await deps.queryOne<Staff>(
                `SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at
                 FROM staff WHERE id = ?`,
                [id]
            );

            const parsedStaff = {
                ...updatedStaff,
                accessible_pages: typeof updatedStaff?.accessible_pages === 'string'
                    ? JSON.parse(updatedStaff?.accessible_pages)
                    : (updatedStaff?.accessible_pages || [])
            };

            res.json({
                ...parsedStaff,
                message: 'تم تحديث بيانات الموظف بنجاح'
            });
        } catch (error) {
            console.error('Error updating staff:', error);
            res.status(500).json({ error: 'Failed to update staff' });
        }
    });

    // Delete staff member (soft delete)
    staffRouter.delete('/:id', deps.authenticate, deps.authorizeAdmin, async (req: Request, res: Response) => {
        try {
            const { id } = req.params;

            const existingStaff = await deps.queryOne(
                'SELECT id FROM staff WHERE id = ?',
                [id]
            );

            if (!existingStaff) {
                return res.status(404).json({ error: 'Staff not found' });
            }

            await deps.execute(
                'UPDATE staff SET is_active = 0, updated_at = NOW() WHERE id = ?',
                [id]
            );

            res.json({ message: 'تم حذف الموظف بنجاح' });
        } catch (error) {
            console.error('Error deleting staff:', error);
            res.status(500).json({ error: 'Failed to delete staff' });
        }
    });

    // Staff login endpoint (public: authentication happens here)
    staffRouter.post('/login', async (req: Request, res: Response) => {
        try {
            const { phone, password } = req.body;

            if (!phone || !password) {
                return res.status(400).json({ error: 'Phone and password are required' });
            }

            const staff = await deps.queryOne<Staff>(
                `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                 FROM staff WHERE phone = ?`,
                [phone.trim()]
            );

            if (!staff || !staff.password_hash) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const isValidPassword = await deps.comparePassword(password, staff.password_hash);

            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Suspension is validated before any token is issued. The staff
            // table has no suspension column; is_active is the only signal.
            if (!staff.is_active) {
                return res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
            }

            // Parse accessible_pages
            const accessiblePages = typeof staff.accessible_pages === 'string'
                ? JSON.parse(staff.accessible_pages)
                : (staff.accessible_pages || []);

            // Generate JWT token
            const jwtSecret: Secret = getJwtSecret();
            const jwtExpiry = process.env.JWT_EXPIRES_IN || '7d';
            const token = jwt.sign(
                {
                    id: staff.id,
                    phone: staff.phone,
                    role: 'staff',
                    accessible_pages: accessiblePages
                },
                jwtSecret,
                { expiresIn: jwtExpiry } as jwt.SignOptions
            );

            res.json({
                user: {
                    id: staff.id,
                    name: staff.name,
                    email: staff.email,
                    phone: staff.phone,
                    role: 'staff',
                    accessible_pages: accessiblePages,
                    is_active: staff.is_active
                },
                token
            });
        } catch (error) {
            console.error('Staff login error:', error);
            res.status(500).json({ error: 'Authentication failed' });
        }
    });

    return staffRouter;
};

/**
 * `../db` is loaded lazily (and cached) so importing this module never runs
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query; hermetic tests inject adapters through
 * createStaffRouter and never reach these defaults.
 */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

export default createStaffRouter({
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    execute: (sql, params) => loadDb().then((db) => db.execute(sql, params)),
    comparePassword: (password, hash) => bcrypt.compare(password, hash),
    authenticate: authenticateToken,
    // Verified platform-admin check: a bare admin role claim is not enough.
    authorizeAdmin: requireAdminPermission('staff.manage'),
});
