import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import {
    AuthRequest,
    authenticateToken,
    getJwtSecret,
    requireRoles,
} from '../middleware/auth';
import {
    resolvePublicRegistrationRole,
    validatePublicRegistrationInput,
} from '../security/registration-policy';
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

/** Maximum lifetime for locally issued auth tokens (7 days, in seconds). */
export const MAX_JWT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * Resolve the JWT lifetime from JWT_EXPIRES_IN, capped at 7 days so a
 * misconfigured environment cannot mint effectively non-expiring sessions.
 * Accepts seconds ("3600") or suffixed durations ("15m", "12h", "7d");
 * anything unparseable falls back to the 7-day default.
 */
export function resolveJwtLifetimeSeconds(raw: string | undefined): number {
    const fallback = MAX_JWT_LIFETIME_SECONDS;
    if (!raw) return fallback;
    const match = /^(\d+)(s|m|h|d)?$/.exec(raw.trim().toLowerCase());
    if (!match) return fallback;
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    const seconds = Number(match[1]) * (multipliers[match[2] || 's'] ?? 1);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return fallback;
    return Math.min(seconds, fallback);
}

/**
 * Precomputed bcrypt hash used only to equalize login timing when no stored
 * credential exists for the identifier. A missing identity then costs one
 * comparison just like a wrong password, so response timing does not reveal
 * whether the account exists.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$vGfr4/IEfyDXElhFZsbRXuF7FuiF./Z6SuVTLjJGdcfQy4cmvbMma';

/**
 * Parse accessible_pages defensively: a malformed legacy row yields no extra
 * pages instead of crashing login with a 500.
 */
function parseAccessiblePages(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === 'string');
    }
    if (typeof value !== 'string') return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === 'string')
            : [];
    } catch {
        return [];
    }
}

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
            if (!user || !user.password_hash) {
                // No local credential for this identifier (missing identity or
                // invitation-pending account without a password yet): spend
                // one comparison so timing does not reveal which case it is.
                await deps.comparePassword(password, DUMMY_PASSWORD_HASH);
            }
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
                    const token = jwt.sign(
                        { id: user.id, email: user.email || null, phone: user.phone || null, role: user.role,
                            tv: Number(user.token_version || 0) },
                        jwtSecret,
                        { expiresIn: resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN) } as jwt.SignOptions
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
                            legacyPages = parseAccessiblePages(staffProfile.accessible_pages);
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

            // If not found in users or password invalid, check staff table.
            // Staff phones are matched over the same normalized format
            // variants as users so one number cannot hold two identities.
            const staffCandidates = phone ? phoneLookupCandidates(phone) : [];
            const staffWhere = staffCandidates.length
                ? `phone IN (${staffCandidates.map(() => '?').join(',')})`
                : 'phone = ?';
            const staff = await deps.queryOne<Staff>(
                `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                 FROM staff WHERE ${staffWhere}`,
                staffCandidates.length ? staffCandidates : [identifier]
            );

            if (staff && staff.password_hash) {
                const isValidPassword = await deps.comparePassword(password, staff.password_hash);

                if (isValidPassword) {
                    // Suspension is validated before any token is issued.
                    if (!isIssuableIdentity(staff)) {
                        return res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
                    }
                    // Parse accessible_pages
                    const accessiblePages = parseAccessiblePages(staff.accessible_pages);

                    // Generate JWT token
                    const jwtSecret: Secret = getJwtSecret();
                    const token = jwt.sign(
                        {
                            id: staff.id,
                            phone: staff.phone,
                            role: 'staff',
                            accessible_pages: accessiblePages
                        },
                        jwtSecret,
                        { expiresIn: resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN) } as jwt.SignOptions
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

// Register endpoint - public self-registration for student identities only.
// Built over injected dependencies (same pattern as createLoginHandler) so
// validation and rejection behavior is hermetically testable; production
// wiring passes the real adapters below.
export interface RegisterHandlerDeps {
    queryOne: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
    query: (sql: string, params?: unknown[]) => Promise<{ insertId: number; affectedRows: number }>;
    hashPassword: (password: string) => Promise<string>;
}

export const createRegisterHandler = (deps: RegisterHandlerDeps) =>
    async (req: Request, res: Response) => {
        try {
            const { phone, email, password, name, role: requestedRole } = req.body ?? {};
            const role = resolvePublicRegistrationRole(requestedRole);

            const validated = validatePublicRegistrationInput({ phone, email, password, name });
            if (!validated.ok) {
                return res.status(400).json({ error: validated.error });
            }

            // Normalized existence checks: every stored format variant of the
            // phone is probed so one number cannot register twice, and a
            // taken email cannot be reused either. The rejection is
            // deliberately field-neutral to slow account enumeration.
            if (validated.phone) {
                const candidates = phoneLookupCandidates(validated.phone);
                const existingByPhone = await deps.queryOne(
                    `SELECT id FROM users WHERE phone IN (${candidates.map(() => '?').join(',')})`,
                    candidates
                );
                if (existingByPhone) {
                    return res.status(409).json({ error: 'An account with these details already exists' });
                }
            }
            if (validated.email) {
                const existingByEmail = await deps.queryOne(
                    'SELECT id FROM users WHERE email = ?',
                    [validated.email]
                );
                if (existingByEmail) {
                    return res.status(409).json({ error: 'An account with these details already exists' });
                }
            }

            const passwordHash = await deps.hashPassword(password);

            const result = await deps.query(
                `INSERT INTO users (email, phone, password_hash, name, role) VALUES (?, ?, ?, ?, ?)`,
                [validated.email, validated.phone, passwordHash, validated.name, role]
            );

            const userId = result.insertId;

            // Generate JWT token
            const jwtSecret: Secret = getJwtSecret();
            const token = jwt.sign(
                { id: userId, email: validated.email, phone: validated.phone, role, tv: 0 },
                jwtSecret,
                { expiresIn: resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN) } as jwt.SignOptions
            );

            const user = {
                id: userId.toString(),
                email: validated.email,
                phone: validated.phone,
                name: validated.name,
                role,
                is_active: true,
            };

            return res.status(201).json({
                user,
                token,
            });
        } catch (error) {
            console.error('Registration error:', error);
            return res.status(500).json({ error: 'Registration failed' });
        }
    };

router.post('/register', rateLimit('auth-register', 10, 15 * 60_000), createRegisterHandler({
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    query: (sql, params) =>
        loadDb().then((db) => db.query(sql, params) as unknown as Promise<{ insertId: number; affectedRows: number }>),
    hashPassword: (password) => bcrypt.hash(password, 10),
}));

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
                    return res.json({ user: { ...staff, accessible_pages: parseAccessiblePages(staff.accessible_pages) } });
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
router.delete('/users/student/:studentId', authenticateToken, requireRoles('admin', 'teacher'), async (req: AuthRequest, res: Response) => {
    try {
        const { query, queryOne } = await loadDb();
        const { studentId } = req.params;

        if (!studentId) {
            return res.status(400).json({ error: 'Student ID is required' });
        }

        // First, get student info to find associated user by phone/email
        const student = await queryOne<{ phone?: string; email?: string; tenant_id?: string | null }>(
            'SELECT phone, email, tenant_id FROM students WHERE id = ?',
            [studentId]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Deny-by-default tenant binding: a teacher acts only inside their
        // resolved workspace, so a cross-tenant id fails as 404 instead of
        // revealing (or deleting) another tenant's student. Platform admins
        // keep global reach; legacy rows without a tenant fail closed.
        if (req.user?.role !== 'admin') {
            const scopeTenantId = req.user?.tenantId;
            if (!scopeTenantId || student.tenant_id !== scopeTenantId) {
                return res.status(404).json({ error: 'Student not found' });
            }
        }

        // Delete user by every normalized variant of the phone (users table doesn't have student_id)
        const userPhoneCandidates = student.phone ? phoneLookupCandidates(student.phone) : [];
        let result = await query(
            userPhoneCandidates.length
                ? `DELETE FROM users WHERE phone IN (${userPhoneCandidates.map(() => '?').join(',')}) AND role = "student"`
                : 'DELETE FROM users WHERE phone = ? AND role = "student"',
            userPhoneCandidates.length ? userPhoneCandidates : [student.phone]
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

// Search user by phone (staff operation: teachers/admins only, rate-limited)
router.get('/search-by-phone/:phone', authenticateToken, requireRoles('admin', 'teacher', 'staff'), rateLimit('auth-search-phone', 60, 60_000), async (req: Request, res: Response) => {
    try {
        const { queryOne } = await loadDb();
        const { phone } = req.params;

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        const candidates = phoneLookupCandidates(phone);
        const user = await queryOne<User>(
            `SELECT id, phone, name, role, is_active
             FROM users
             WHERE ${candidates.length ? `phone IN (${candidates.map(() => '?').join(',')})` : 'phone = ?'} AND is_active = TRUE`,
            candidates.length ? candidates : [phone.trim()]
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Don't return sensitive data
        const { password_hash: _passwordHash, ...userData } = user;

        res.json(userData);
    } catch (error) {
        console.error('Search user by phone error:', error);
        res.status(500).json({ error: 'Failed to search user' });
    }
});

export default router;
