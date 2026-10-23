import { Router, Request, Response, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { authenticateToken } from '../middleware/auth';
import { signLoginToken, productionLoginSessions, loginSessionsEnabled, LoginSessionUnavailable } from './auth';
import type { LoginSessionStore } from '../security/login-session';
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
    token_version?: number | null;
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
export interface StaffMutationConnection {
    queryOne: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId: number; affectedRows: number }>;
}

export interface StaffRouterDeps {
    /** Required for identity edits: shares the staff -> users lock order with promotion. */
    transaction?: <T>(fn: (tx: StaffMutationConnection) => Promise<T>) => Promise<T>;
    sessionStore?: LoginSessionStore;
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

const isMissingStaffTokenVersion = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; message?: unknown };
    return candidate.code === 'ER_BAD_FIELD_ERROR' &&
        typeof candidate.message === 'string' && /token_version/i.test(candidate.message);
};

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
            console.error('Error fetching staff:');
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
            console.error('Error fetching staff:');
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

            // CHAR(36) identity: MySQL insertId is not the generated UUID.
            const staffId = randomUUID();
            const result = await deps.execute(
                `INSERT INTO staff (id, name, phone, password_hash, role, accessible_pages, is_active)
                 VALUES (?, ?, ?, ?, 'staff', ?, 1)`,
                [
                    staffId,
                    name,
                    phone,
                    passwordHash,
                    JSON.stringify(accessiblePages)
                ]
            );

            if (result.affectedRows !== 1) throw new Error('Staff creation was not confirmed');

            res.status(201).json({
                id: staffId,
                name,
                phone,
                role: 'staff',
                accessible_pages: accessiblePages,
                is_active: true,
                message: 'تم إنشاء الموظف بنجاح'
            });
        } catch (error) {
            console.error('Error creating staff:');
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

            if (!deps.transaction) return res.status(503).json({ error: 'Identity transaction unavailable' });
            const passwordHash = passwordRaw ? await bcrypt.hash(passwordRaw, 10) : null;
            const outcome = await deps.transaction(async (tx): Promise<{ status: number; body: unknown }> => {
                const staff = await tx.queryOne<Staff>('SELECT id, phone FROM staff WHERE id=? FOR UPDATE', [id]);
                if (!staff) return { status: 404, body: { error: 'الموظف غير موجود' } };
                const promoted = await tx.queryOne<{ id: string }>('SELECT id FROM users WHERE id=? FOR UPDATE', [id]);
                if (promoted) return { status: 409, body: {
                    error: 'عدّل هذا الحساب من إدارة حسابات المسؤولين.', code: 'ADMIN_ACCOUNT_MANAGEMENT_REQUIRED',
                } };
                if (phoneRaw && phoneRaw !== staff.phone) {
                    const duplicate = await tx.queryOne<{ id: string }>('SELECT id FROM staff WHERE phone=? AND id<>? LIMIT 1', [phoneRaw, id]);
                    const userDuplicate = await tx.queryOne<{ id: string }>('SELECT id FROM users WHERE phone=? LIMIT 1', [phoneRaw]);
                    if (duplicate || userDuplicate) return { status: 409, body: { error: 'رقم الهاتف مستخدم بالفعل' } };
                }
                const fields: string[] = [];
                const values: unknown[] = [];
                if (nameRaw !== undefined) { fields.push('name=?'); values.push(nameRaw); }
                if (phoneRaw !== undefined) { fields.push('phone=?'); values.push(phoneRaw); }
                if (passwordHash) { fields.push('password_hash=?'); values.push(passwordHash); }
                if (accessiblePagesRaw !== undefined) { fields.push('accessible_pages=?'); values.push(JSON.stringify(accessiblePagesRaw)); }
                if (!fields.length) return { status: 400, body: { error: 'No fields to update' } };
                if (passwordHash || phoneRaw !== undefined || accessiblePagesRaw !== undefined) fields.push('token_version=COALESCE(token_version,0)+1');
                fields.push('updated_at=NOW()');
                values.push(id);
                await tx.execute('UPDATE staff SET ' + fields.join(', ') + ' WHERE id=?', values);
                const updated = await tx.queryOne<Staff>('SELECT id,name,email,phone,role,accessible_pages,is_active,created_at,updated_at FROM staff WHERE id=?', [id]);
                if (!updated) throw new Error('Identity disappeared during update');
                let pages: unknown = updated.accessible_pages;
                if (typeof pages === 'string') { try { pages = JSON.parse(pages); } catch { pages = []; } }
                return { status: 200, body: { ...updated, accessible_pages: Array.isArray(pages) ? pages.filter(page => typeof page === 'string') : [], message: 'تم تحديث بيانات الموظف بنجاح' } };
            });
            return res.status(outcome.status).json(outcome.body);
        } catch (error) {
            if (isMissingStaffTokenVersion(error)) return res.status(503).json({ error: 'Session revocation schema unavailable', code: 'SESSION_REVOCATION_UNAVAILABLE' });
            return res.status(500).json({ error: 'Failed to update staff' });
        }
    });

    // Staff deactivation cannot leave a promoted users login silently active.
    staffRouter.delete('/:id', deps.authenticate, deps.authorizeAdmin, async (req: Request, res: Response) => {
        try {
            if (!deps.transaction) return res.status(503).json({ error: 'Identity transaction unavailable' });
            const outcome = await deps.transaction(async (tx): Promise<{ status: number; body: unknown }> => {
                const staff = await tx.queryOne<{ id: string }>('SELECT id FROM staff WHERE id=? FOR UPDATE', [req.params.id]);
                if (!staff) return { status: 404, body: { error: 'Staff not found' } };
                const promoted = await tx.queryOne<{ id: string }>('SELECT id FROM users WHERE id=? FOR UPDATE', [staff.id]);
                if (promoted) return { status: 409, body: { error: 'عطّل هذا الحساب من إدارة حسابات المسؤولين.', code: 'ADMIN_ACCOUNT_MANAGEMENT_REQUIRED' } };
                const changed = await tx.execute('UPDATE staff SET is_active=0, token_version=COALESCE(token_version,0)+1, updated_at=NOW() WHERE id=?', [staff.id]);
                if (changed.affectedRows !== 1) throw new Error('Identity deactivation was not confirmed');
                return { status: 200, body: { message: 'تم حذف الموظف بنجاح' } };
            });
            return res.status(outcome.status).json(outcome.body);
        } catch (error) {
            if (isMissingStaffTokenVersion(error)) return res.status(503).json({ error: 'Session revocation schema unavailable', code: 'SESSION_REVOCATION_UNAVAILABLE' });
            return res.status(500).json({ error: 'Failed to delete staff' });
        }
    });

    // Staff login endpoint (public: authentication happens here)
    staffRouter.post('/login', rateLimit('staff-login', 12, 15 * 60_000), async (req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
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

            let staff: Staff | null;
            try {
                staff = await deps.queryOne<Staff>(
                    `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active, token_version
                     FROM staff WHERE phone = ?`, [phone]
                );
            } catch (error) {
                if (!isMissingStaffTokenVersion(error)) throw error;
                staff = await deps.queryOne<Staff>(
                    `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                     FROM staff WHERE phone = ?`, [phone]
                );
            }

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

            // Promoted identities use users-table credentials and revocation versions.
            // They must enter through the shared login instead of a staff-source token.
            const promoted = await deps.queryOne<{ id: string }>('SELECT id FROM users WHERE id = ? LIMIT 1', [staff.id]);
            if (promoted) return res.status(409).json({
                error: 'استخدم صفحة تسجيل الدخول الرئيسية لهذا الحساب.', code: 'UNIFIED_LOGIN_REQUIRED',
            });

            // Parse accessible_pages
            const accessiblePages = typeof staff.accessible_pages === 'string'
                ? JSON.parse(staff.accessible_pages)
                : (staff.accessible_pages || []);

            // Generate JWT token
            const token = await signLoginToken(
                {
                    id: staff.id,
                    phone: staff.phone,
                    role: 'staff',
                    tv: Number(staff.token_version || 0),
                    accessible_pages: accessiblePages
                },
                'staff', deps.sessionStore,
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
            if (error instanceof LoginSessionUnavailable) {
                res.set('Cache-Control', 'no-store');
                return res.status(503).json({ error: 'Session service unavailable' });
            }
            console.error('Staff login error:');
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
    sessionStore: loginSessionsEnabled() ? productionLoginSessions : undefined,
    transaction: async <T>(fn: (tx: StaffMutationConnection) => Promise<T>): Promise<T> => {
        const connection = await (await loadDb()).getPool().getConnection();
        try {
            await connection.beginTransaction();
            const result = await fn({
                queryOne: async <Row>(sql: string, params?: unknown[]) => {
                    const [rows] = await connection.execute(sql, params);
                    return (rows as Row[])[0] ?? null;
                },
                execute: async (sql, params) => {
                    const [result] = await connection.execute(sql, params);
                    return result as unknown as { insertId: number; affectedRows: number };
                },
            });
            await connection.commit();
            return result;
        } catch (error) {
            try { await connection.rollback(); } catch { /* Preserve the original failure. */ }
            throw error;
        } finally { connection.release(); }
    },
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    execute: (sql, params) => loadDb().then((db) => db.execute(sql, params)),
    comparePassword: (password, hash) => bcrypt.compare(password, hash),
    authenticate: authenticateToken,
    // Verified platform-admin check: a bare admin role claim is not enough.
    authorizeAdmin: requireAdminPermission('staff.manage'),
});
