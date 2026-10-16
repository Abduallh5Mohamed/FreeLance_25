import { Router, Request, Response, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import { authenticateToken, getJwtSecret } from '../middleware/auth';
import { resolveJwtLifetimeSeconds } from './auth';
import { rateLimit } from '../middleware/rate-limit';
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

export const STAFF_NAME_MAX_LENGTH = 100;
export const STAFF_PHONE_MIN_LENGTH = 5;
export const STAFF_PHONE_MAX_LENGTH = 20;
export const STAFF_PASSWORD_MIN_LENGTH = 8;
export const STAFF_PASSWORD_MAX_LENGTH = 128;
export const STAFF_ACCESSIBLE_PAGES_MAX = 50;
export const STAFF_PAGE_KEY_MAX_LENGTH = 64;

export const validateStaffCreate = (body: Record<string, unknown>): { ok: true; value: { name: string; phone: string; password: string; accessiblePages: string[] } } | { ok: false; error: string } => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const accessiblePagesRaw = body.accessible_pages ?? body.accessiblePages ?? [];
    if (!name || !phone || !password) {
        return { ok: false, error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' };
    }
    if (name.length > STAFF_NAME_MAX_LENGTH) {
        return { ok: false, error: 'Staff name is too long' };
    }
    if (phone.length < STAFF_PHONE_MIN_LENGTH || phone.length > STAFF_PHONE_MAX_LENGTH) {
        return { ok: false, error: 'Invalid phone number' };
    }
    if (password.length < STAFF_PASSWORD_MIN_LENGTH || password.length > STAFF_PASSWORD_MAX_LENGTH) {
        return { ok: false, error: 'Password must be 8-128 characters' };
    }
    if (!Array.isArray(accessiblePagesRaw) || accessiblePagesRaw.length > STAFF_ACCESSIBLE_PAGES_MAX) {
        return { ok: false, error: 'Invalid accessible pages' };
    }
    for (const page of accessiblePagesRaw) {
        if (typeof page !== 'string' || page.length === 0 || page.length > STAFF_PAGE_KEY_MAX_LENGTH) {
            return { ok: false, error: 'Invalid accessible pages' };
        }
    }
    return { ok: true, value: { name, phone, password, accessiblePages: accessiblePagesRaw as string[] } };
};

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
            const body = (req.body ?? {}) as Record<string, unknown>;
            const validation = validateStaffCreate(body);
            if (!validation.ok) {
                return res.status(400).json({ error: validation.error });
            }
            const { name, phone, password, accessiblePages } = validation.value;

            // Check if phone exists in staff table
            const existingStaff = await deps.queryOne(
                'SELECT id FROM staff WHERE phone = ?',
                [phone]
            );

            if (existingStaff) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف' });
            }

            // Check if phone exists in users table (admin/teacher/student)
            const existingUser = await deps.queryOne(
                'SELECT id, role FROM users WHERE phone = ?',
                [phone]
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
                    name,
                    phone,
                    passwordHash,
                    JSON.stringify(accessiblePages)
                ]
            );

            const staffId = result.insertId;

            res.status(201).json({
                id: staffId.toString(),
                name,
                phone,
                role: 'staff',
                accessible_pages: accessiblePages,
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
            const body = (req.body ?? {}) as Record<string, unknown>;
            const nameRaw = typeof body.name === 'string' ? body.name.trim() : undefined;
            const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : undefined;
            const passwordRaw = typeof body.password === 'string' ? body.password : undefined;
            const accessiblePagesRaw = body.accessible_pages;

            if (nameRaw !== undefined && (nameRaw.length === 0 || nameRaw.length > STAFF_NAME_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid staff name' });
            }
            if (phoneRaw !== undefined && (phoneRaw.length < STAFF_PHONE_MIN_LENGTH || phoneRaw.length > STAFF_PHONE_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid phone number' });
            }
            if (passwordRaw !== undefined && (passwordRaw.length < STAFF_PASSWORD_MIN_LENGTH || passwordRaw.length > STAFF_PASSWORD_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Password must be 8-128 characters' });
            }
            if (accessiblePagesRaw !== undefined) {
                if (!Array.isArray(accessiblePagesRaw) || accessiblePagesRaw.length > STAFF_ACCESSIBLE_PAGES_MAX) {
                    return res.status(400).json({ error: 'Invalid accessible pages' });
                }
                for (const page of accessiblePagesRaw) {
                    if (typeof page !== 'string' || page.length === 0 || page.length > STAFF_PAGE_KEY_MAX_LENGTH) {
                        return res.status(400).json({ error: 'Invalid accessible pages' });
                    }
                }
            }

            // Check if staff exists
            const existingStaff = await deps.queryOne<Staff>(
                'SELECT id, phone FROM staff WHERE id = ?',
                [id]
            );

            if (!existingStaff) {
                return res.status(404).json({ error: 'الموظف غير موجود' });
            }

            // Check for duplicate phone (if phone is being changed)
            if (phoneRaw && phoneRaw !== existingStaff.phone) {
                // Check in staff table
                const duplicateStaffPhone = await deps.queryOne(
                    'SELECT id FROM staff WHERE phone = ? AND id != ?',
                    [phoneRaw, id]
                );
                if (duplicateStaffPhone) {
                    return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف آخر' });
                }

                // Check in users table
                const duplicateUserPhone = await deps.queryOne(
                    'SELECT id FROM users WHERE phone = ?',
                    [phoneRaw]
                );
                if (duplicateUserPhone) {
                    return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل في النظام' });
                }
            }

            // Build update query
            const updateFields: string[] = [];
            const updateValues: unknown[] = [];

            if (nameRaw) {
                updateFields.push('name = ?');
                updateValues.push(nameRaw);
            }
            if (phoneRaw) {
                updateFields.push('phone = ?');
                updateValues.push(phoneRaw);
            }
            if (passwordRaw) {
                const passwordHash = await bcrypt.hash(passwordRaw, 10);
                updateFields.push('password_hash = ?');
                updateValues.push(passwordHash);
            }
            if (accessiblePagesRaw !== undefined) {
                updateFields.push('accessible_pages = ?');
                updateValues.push(JSON.stringify(accessiblePagesRaw));
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
    staffRouter.post('/login', rateLimit('staff-login', 12, 15 * 60_000), async (req: Request, res: Response) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
            const password = typeof body.password === 'string' ? body.password : '';

            if (!phone || !password) {
                return res.status(400).json({ error: 'Phone and password are required' });
            }
            if (phone.length > STAFF_PHONE_MAX_LENGTH || password.length > STAFF_PASSWORD_MAX_LENGTH) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const staff = await deps.queryOne<Staff>(
                `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                 FROM staff WHERE phone = ?`,
                [phone]
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
            // Bound the exposure window even though the current schema has no
            // staff token_version column for immediate password-change revocation.
            const jwtExpiry = resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN);
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
