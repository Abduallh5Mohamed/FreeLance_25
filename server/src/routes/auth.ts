import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import {
    AuthRequest,
    authenticateToken,
    getJwtSecret,
    requireRoles,
} from '../middleware/auth';
import { resolvePublicRegistrationRole } from '../security/registration-policy';
import { getAdminPermissions, getAdminRoleCodes } from '../security/admin-permissions';
import { rateLimit } from '../middleware/rate-limit';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../security/phone';
import { isIssuableIdentity } from '../security/identity-scope';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';

/**
 * `../db` is loaded lazily (and cached) so importing this module never runs
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query; hermetic tests inject adapters through
 * createLoginHandler and never reach these defaults.
 */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const router = Router();

interface User {
    id: string;
    email?: string;
    phone?: string;
    name: string;
    role: 'admin' | 'teacher' | 'student' | 'instructor' | 'staff';
    is_active: boolean;
    email_verified?: number;
    phone_verified?: number;
    created_at?: string;
    updated_at?: string;
    password_hash?: string;
    student_id?: string;
    token_version?: number;
    /** SQL-computed: true while users.suspended_until is still in the future. */
    suspension_active?: boolean | number;
}

interface JWTPayload {
    id: string;
    email: string | null;
    phone: string | null;
    role: string;
}

interface QueryResult {
    insertId: number;
    affectedRows: number;
}

// Staff interface for login
interface Staff {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    password_hash?: string;
    role: string;
    accessible_pages: string | string[];
    is_active: boolean;
}

// Login endpoint - checks both users and staff tables.
// The handler is built over injected dependencies so issuance behavior
// (including the suspension gate) can be tested against isolated fixtures
// without a database; production wiring passes the real adapters.
export interface LoginHandlerDeps {
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    comparePassword: (password: string, hash: string) => Promise<boolean>;
    loadAdminPermissions: (userId: string) => Promise<string[]>;
    loadAdminRoleCodes: (userId: string) => Promise<string[]>;
}

export const createLoginHandler = (deps: LoginHandlerDeps) =>
    async (req: Request, res: Response) => {
        try {
            // Prefer phone-based login; fall back to email for backwards compatibility
            const { phone, email, password } = req.body;

            if ((!phone && !email) || !password) {
                return res.status(400).json({ error: 'Phone (or email) and password are required' });
            }

            const normalizedPhone = phone ? normalizeEgyptianPhone(phone) : null;
            const identifier = phone ? (normalizedPhone || phone.trim()) : (email || '').toLowerCase().trim();
            const candidates = phone ? phoneLookupCandidates(phone) : [];
            const where = phone && candidates.length ? `phone IN (${candidates.map(() => '?').join(',')})` : (phone ? 'phone = ?' : 'email = ?');

            // First, check in users table. token_version and the server-computed
            // suspension flag are selected so a fresh login cannot mint a token
            // that the revocation check rejects and cannot bypass an active
            // time-bound suspension. The predicate is shared verbatim with the
            // request-time identity lookup so issuance and liveness agree.
            const user = await deps.queryOne<User>(
                `SELECT id, email, phone, name, role, student_id, is_active, email_verified, phone_verified, created_at, updated_at, password_hash, token_version,
                        ${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active
                 FROM users WHERE ${where}`,
                phone && candidates.length ? candidates : [identifier]
            );

            // If user found in users table
            if (user && user.password_hash) {
                const isValidPassword = await deps.comparePassword(password, user.password_hash);

                if (isValidPassword) {
                    // Suspension is validated before any token is issued.
                    if (!isIssuableIdentity(user)) {
                        return res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
                    }
                    let billingOnly = false;
                    if (user.role === 'instructor') {
                        const access = await deps.queryOne<{ tenant_status: string; legacy_compat: number; allowed: number }>(
                            `SELECT t.status AS tenant_status, t.legacy_compat,
                                    EXISTS(
                                      SELECT 1 FROM tenant_subscriptions s
                                      WHERE s.tenant_id=t.id AND (
                                        (s.status IN ('active','past_due') AND (
                                          s.period_ends_at>UTC_TIMESTAMP() OR DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)>UTC_TIMESTAMP()
                                        )) OR
                                        (s.status='grace_period' AND s.grace_until>UTC_TIMESTAMP())
                                      )
                                    ) AS allowed
                             FROM tenants t
                             INNER JOIN tenant_memberships m ON m.tenant_id=t.id AND m.user_id=? AND m.status='active'
                             WHERE t.owner_user_id=?
                             ORDER BY t.created_at DESC LIMIT 1`,
                            [user.id, user.id]
                        );
                        if (!access || access.tenant_status !== 'active') {
                            return res.status(403).json({ error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' });
                        }
                        billingOnly = !Boolean(access.legacy_compat || access.allowed);
                    }
                    // Generate JWT token
                    const jwtSecret: Secret = getJwtSecret();
                    const jwtExpiry = process.env.JWT_EXPIRES_IN || '7d';
                    const token = jwt.sign(
                        { id: user.id, email: user.email || null, phone: user.phone || null, role: user.role,
                            tv: Number(user.token_version || 0) },
                        jwtSecret,
                        { expiresIn: jwtExpiry } as jwt.SignOptions
                    );

                    let adminPermissions: string[] = [];
                    let adminRoles: string[] = [];
                    try { adminPermissions = await deps.loadAdminPermissions(user.id); } catch { /* migration not installed yet */ }
                    try { adminRoles = await deps.loadAdminRoleCodes(user.id); } catch { /* migration not installed yet */ }
                    let legacyPages: string[] = [];
                    if (user.role === 'staff') {
                        const staffProfile = await deps.queryOne<{ accessible_pages: string | string[] }>(
                            'SELECT accessible_pages FROM staff WHERE id = ?', [user.id]
                        );
                        if (staffProfile) {
                            legacyPages = typeof staffProfile.accessible_pages === 'string'
                                ? JSON.parse(staffProfile.accessible_pages) : (staffProfile.accessible_pages || []);
                        }
                    }
                    // Remove password hash from response
                    const { password_hash, suspension_active, ...userWithoutPassword } = user;

                    return res.json({
                        user: { ...userWithoutPassword, accessible_pages: legacyPages, billing_only: billingOnly,
                            admin_member: adminPermissions.length > 0, admin_permissions: adminPermissions, admin_roles: adminRoles },
                        token,
                    });
                }
            }

            // If not found in users or password invalid, check staff table
            const staff = await deps.queryOne<Staff>(
                `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                 FROM staff WHERE phone = ?`,
                [identifier]
            );

            if (staff && staff.password_hash) {
                const isValidPassword = await deps.comparePassword(password, staff.password_hash);

                if (isValidPassword) {
                    // Suspension is validated before any token is issued.
                    if (!isIssuableIdentity(staff)) {
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

                    return res.json({
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
                }
            }

            // Neither user nor staff found/matched
            return res.status(401).json({ error: 'Invalid credentials' });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'Authentication failed' });
        }
    };

router.post('/login', rateLimit('auth-login', 12, 15 * 60_000), createLoginHandler({
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    comparePassword: (password, hash) => bcrypt.compare(password, hash),
    loadAdminPermissions: getAdminPermissions,
    loadAdminRoleCodes: getAdminRoleCodes,
}));

// Register endpoint
router.post('/register', async (req: Request, res: Response) => {
    try {
        const { query, queryOne } = await loadDb();
        // Register with phone (preferred). For backward compatibility email may still be used.
        const { phone, email, password, name, role: requestedRole } = req.body;
        const role = resolvePublicRegistrationRole(requestedRole);

        if ((!phone && !email) || !password || !name) {
            return res.status(400).json({ error: 'Phone (or email), password, and name are required' });
        }

        const identifier = phone ? phone.trim() : (email || '').toLowerCase().trim();
        const where = phone ? 'phone' : 'email';

        // Check if user already exists by phone or email
        const existingUser = await queryOne(
            `SELECT id FROM users WHERE ${where} = ?`,
            [identifier]
        );

        if (existingUser) {
            return res.status(409).json({ error: 'User already exists' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Insert new user
        const result = await query(
            `INSERT INTO users (email, phone, password_hash, name, role) VALUES (?, ?, ?, ?, ?)`,
            [email ? email.toLowerCase().trim() : null, phone ? phone.trim() : null, passwordHash, name, role]
        );

        const userId = (result as unknown as QueryResult).insertId;

        // Generate JWT token
        const jwtSecret: Secret = getJwtSecret();
        const jwtExpiry = process.env.JWT_EXPIRES_IN || '7d';
        const token = jwt.sign(
            { id: userId, email: email || null, phone: phone || null, role, tv: 0 },
            jwtSecret,
            { expiresIn: jwtExpiry } as jwt.SignOptions
        );

        const user = {
            id: userId.toString(),
            email: email ? email.toLowerCase().trim() : null,
            phone: phone ? phone.trim() : null,
            name,
            role,
            is_active: true,
        };

        res.status(201).json({
            user,
            token,
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Get current user (requires token)
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { queryOne } = await loadDb();
        const user = await queryOne<User>(
            'SELECT id, email, name, role, is_active FROM users WHERE id = ? AND is_active = TRUE',
            [req.user?.id]
        );

        if (!user) {
            // Staff-table identities live outside the users table; return their
            // own identity so /auth/me works for every authenticated principal.
            if (req.user?.role === 'staff' && req.user.identitySource === 'staff') {
                const staff = await queryOne<Staff>(
                    'SELECT id, name, email, phone, role, is_active, accessible_pages FROM staff WHERE id = ? AND is_active = 1',
                    [req.user.id]
                );
                if (staff) {
                    const accessiblePages = typeof staff.accessible_pages === 'string'
                        ? JSON.parse(staff.accessible_pages)
                        : (staff.accessible_pages || []);
                    return res.json({ user: { ...staff, accessible_pages: accessiblePages } });
                }
            }
            return res.status(404).json({ error: 'User not found' });
        }

        let adminPermissions: string[] = [];
        let adminRoles: string[] = [];
        try { adminPermissions = await getAdminPermissions(user.id); } catch { /* migration not installed yet */ }
        try { adminRoles = await getAdminRoleCodes(user.id); } catch { /* migration not installed yet */ }
        res.json({ user: { ...user, billing_only: Boolean(req.user?.billingOnly), admin_member: adminPermissions.length > 0, admin_permissions: adminPermissions, admin_roles: adminRoles } });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
});

// Delete user by student_id (for admins to delete student user accounts)
// This will delete BOTH from users table AND students table (complete removal)
router.delete('/users/student/:studentId', authenticateToken, requireRoles('admin', 'teacher'), async (req: Request, res: Response) => {
    try {
        const { query, queryOne } = await loadDb();
        const { studentId } = req.params;

        if (!studentId) {
            return res.status(400).json({ error: 'Student ID is required' });
        }

        // First, get student info to find associated user by phone/email
        const student = await queryOne<{ phone?: string; email?: string }>(
            'SELECT phone, email FROM students WHERE id = ?',
            [studentId]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Delete user by phone (users table doesn't have student_id)
        let result = await query(
            'DELETE FROM users WHERE phone = ? AND role = "student"',
            [student.phone]
        );

        let affectedRows = (result as unknown as QueryResult).affectedRows;

        // If no rows deleted and student has email, try deleting by email
        if (affectedRows === 0 && student.email) {
            result = await query(
                'DELETE FROM users WHERE email = ? AND role = "student"',
                [student.email]
            );
            affectedRows = (result as unknown as QueryResult).affectedRows;
        }

        // If still no rows deleted and student has email, try deleting by email
        if (affectedRows === 0 && student.email) {
            result = await query(
                'DELETE FROM users WHERE email = ? AND role = "student"',
                [student.email]
            );
            affectedRows = (result as unknown as QueryResult).affectedRows;
        }

        // Now delete from students table (and related records via CASCADE)
        await query(
            'DELETE FROM student_courses WHERE student_id = ?',
            [studentId]
        );

        await query(
            'DELETE FROM students WHERE id = ?',
            [studentId]
        );

        res.json({
            message: 'Student and user account deleted completely',
            userDeleted: affectedRows > 0,
            studentDeleted: true
        });
    } catch (error) {
        console.error('Delete user and student error:', error);
        res.status(500).json({ error: 'Failed to delete user and student' });
    }
});

// Search user by phone
router.get('/search-by-phone/:phone', authenticateToken, async (req: Request, res: Response) => {
    try {
        const { queryOne } = await loadDb();
        const { phone } = req.params;

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        const user = await queryOne<User>(
            `SELECT id, phone, name, role, is_active 
             FROM users 
             WHERE phone = ? AND is_active = TRUE`,
            [phone.trim()]
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Don't return sensitive data
        const { password_hash, ...userData } = user as any;

        res.json(userData);
    } catch (error) {
        console.error('Search user by phone error:', error);
        res.status(500).json({ error: 'Failed to search user' });
    }
});

export default router;
