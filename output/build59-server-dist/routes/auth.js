"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSearchByPhoneHandler = exports.createDeleteStudentEnrollmentHandler = exports.createRegisterHandler = exports.createLoginHandler = exports.MAX_JWT_LIFETIME_SECONDS = exports.loginSessionsEnabled = exports.LoginSessionUnavailable = exports.productionLoginSessions = void 0;
exports.signLoginToken = signLoginToken;
exports.resolveJwtLifetimeSeconds = resolveJwtLifetimeSeconds;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const node_crypto_1 = require("node:crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const auth_1 = require("../middleware/auth");
const registration_policy_1 = require("../security/registration-policy");
const admin_permissions_1 = require("../security/admin-permissions");
const rate_limit_1 = require("../middleware/rate-limit");
const phone_1 = require("../security/phone");
const identity_scope_1 = require("../security/identity-scope");
const suspension_predicate_1 = require("../security/suspension-predicate");
const login_session_1 = require("../security/login-session");
const login_session_sql_1 = require("../security/login-session-sql");
/**
 * `../db` is loaded lazily (and cached) so importing this module never runs
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query; hermetic tests inject adapters through
 * createLoginHandler and never reach these defaults.
 */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const router = (0, express_1.Router)();
exports.productionLoginSessions = (0, login_session_sql_1.createLoginSessionSqlStore)({
    queryOne: (sql, values) => loadDb().then(db => db.queryOne(sql, values)),
    execute: (sql, values) => loadDb().then(db => db.execute(sql, values)),
});
/** The production login path never falls back to a sessionless token on storage failure. */
async function signLoginToken(payload, source, store) {
    const secret = (0, auth_1.getJwtSecret)();
    const lifetime = resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN);
    // Legacy injected handler fixtures may omit the session store. Production
    // explicitly supplies it; omission does not satisfy sensitive-action MFA.
    if (!store)
        return jsonwebtoken_1.default.sign(payload, secret, { expiresIn: lifetime });
    const issuedAt = Math.floor(Date.now() / 1000);
    let session;
    try {
        session = await (0, login_session_1.createLoginSessionAuthority)(store).issue({
            userId: String(payload.id), identitySource: source,
            tokenVersion: Number(payload.tv ?? 0), expiresAtMs: (issuedAt + lifetime) * 1000,
        });
    }
    catch {
        throw new LoginSessionUnavailable();
    }
    return jsonwebtoken_1.default.sign({ ...payload, sid: session.id, iat: issuedAt, exp: issuedAt + lifetime }, secret);
}
class LoginSessionUnavailable extends Error {
}
exports.LoginSessionUnavailable = LoginSessionUnavailable;
/** Rollout is explicit; enabling it requires the reviewed session schema first. */
const loginSessionsEnabled = () => process.env.AUTH_LOGIN_SESSIONS_ENABLED === 'true';
exports.loginSessionsEnabled = loginSessionsEnabled;
/** Maximum lifetime for locally issued auth tokens (7 days, in seconds). */
exports.MAX_JWT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
/**
 * Resolve the JWT lifetime from JWT_EXPIRES_IN, capped at 7 days so a
 * misconfigured environment cannot mint effectively non-expiring sessions.
 * Accepts seconds ("3600") or suffixed durations ("15m", "12h", "7d");
 * anything unparseable falls back to the 7-day default.
 */
function resolveJwtLifetimeSeconds(raw) {
    const fallback = exports.MAX_JWT_LIFETIME_SECONDS;
    if (!raw)
        return fallback;
    const match = /^(\d+)(s|m|h|d)?$/.exec(raw.trim().toLowerCase());
    if (!match)
        return fallback;
    const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
    const seconds = Number(match[1]) * (multipliers[match[2] || 's'] ?? 1);
    if (!Number.isSafeInteger(seconds) || seconds <= 0)
        return fallback;
    return Math.min(seconds, fallback);
}
/**
 * Precomputed bcrypt hash used only to equalize login timing when no stored
 * credential exists for the identifier. A missing identity then costs one
 * comparison just like a wrong password, so response timing does not reveal
 * whether the account exists.
 */
/**
 * A pre-migration database may lack staff.token_version (added by
 * migrations/20261017_05_staff_token_version.sql). That specific "unknown
 * column" failure is the only case that falls back to a legacy SELECT; every
 * other database failure propagates so login fails closed.
 */
const isMissingStaffTokenVersion = (error) => {
    if (!error || typeof error !== 'object')
        return false;
    const candidate = error;
    return candidate.code === 'ER_BAD_FIELD_ERROR' &&
        typeof candidate.message === 'string' && /token_version/i.test(candidate.message);
};
const DUMMY_PASSWORD_HASH = '$2b$10$vGfr4/IEfyDXElhFZsbRXuF7FuiF./Z6SuVTLjJGdcfQy4cmvbMma';
/**
 * Parse accessible_pages defensively: a malformed legacy row yields no extra
 * pages instead of crashing login with a 500.
 */
function parseAccessiblePages(value) {
    if (Array.isArray(value)) {
        return value.filter((entry) => typeof entry === 'string');
    }
    if (typeof value !== 'string')
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((entry) => typeof entry === 'string')
            : [];
    }
    catch {
        return [];
    }
}
const createLoginHandler = (deps) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    try {
        // Prefer phone-based login; fall back to email for backwards compatibility
        const { phone, email, password } = req.body;
        if ((!phone && !email) || !password) {
            return res.status(400).json({ error: 'Phone (or email) and password are required' });
        }
        const normalizedPhone = phone ? (0, phone_1.normalizeEgyptianPhone)(phone) : null;
        const identifier = phone ? (normalizedPhone || phone.trim()) : (email || '').toLowerCase().trim();
        const candidates = phone ? (0, phone_1.phoneLookupCandidates)(phone) : [];
        const where = phone && candidates.length ? `phone IN (${candidates.map(() => '?').join(',')})` : (phone ? 'phone = ?' : 'email = ?');
        // First, check in users table. token_version and the server-computed
        // suspension flag are selected so a fresh login cannot mint a token
        // that the revocation check rejects and cannot bypass an active
        // time-bound suspension. The predicate is shared verbatim with the
        // request-time identity lookup so issuance and liveness agree.
        const user = await deps.queryOne(`SELECT id, email, phone, name, role, student_id, is_active, email_verified, phone_verified, created_at, updated_at, password_hash, token_version,
                        ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active
                 FROM users WHERE ${where}`, phone && candidates.length ? candidates : [identifier]);
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
                if (!(0, identity_scope_1.isIssuableIdentity)(user)) {
                    return res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
                }
                let billingOnly = false;
                if (user.role === 'instructor') {
                    const access = await deps.queryOne(`SELECT t.status AS tenant_status, t.legacy_compat,
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
                             ORDER BY t.created_at DESC LIMIT 1`, [user.id, user.id]);
                    if (!access || access.tenant_status !== 'active') {
                        return res.status(403).json({ error: 'Instructor account is administratively suspended', code: 'TENANT_SUSPENDED' });
                    }
                    billingOnly = !Boolean(access.legacy_compat || access.allowed);
                }
                // Generate JWT token
                const token = await signLoginToken({ id: user.id, email: user.email || null, phone: user.phone || null, role: user.role,
                    tv: Number(user.token_version || 0) }, 'users', deps.sessionStore);
                let adminPermissions = [];
                let adminRoles = [];
                try {
                    adminPermissions = await deps.loadAdminPermissions(user.id);
                }
                catch { /* migration not installed yet */ }
                try {
                    adminRoles = await deps.loadAdminRoleCodes(user.id);
                }
                catch { /* migration not installed yet */ }
                let legacyPages = [];
                if (user.role === 'staff') {
                    const staffProfile = await deps.queryOne('SELECT accessible_pages FROM staff WHERE id = ?', [user.id]);
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
        const staffCandidates = phone ? (0, phone_1.phoneLookupCandidates)(phone) : [];
        const staffWhere = staffCandidates.length
            ? `phone IN (${staffCandidates.map(() => '?').join(',')})`
            : 'phone = ?';
        // The staff lookup loads the server-side token_version so this
        // path mints the same revocation version as /api/staff/login; the
        // legacy fallback covers a pre-migration column and treats a
        // missing version as 0, matching the request-time repository.
        // Any other database failure propagates (fail closed).
        let staff;
        try {
            staff = await deps.queryOne(`SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active, token_version
                     FROM staff WHERE ${staffWhere}`, staffCandidates.length ? staffCandidates : [identifier]);
        }
        catch (error) {
            if (!isMissingStaffTokenVersion(error))
                throw error;
            staff = await deps.queryOne(`SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                     FROM staff WHERE ${staffWhere}`, staffCandidates.length ? staffCandidates : [identifier]);
        }
        if (staff && staff.password_hash) {
            const isValidPassword = await deps.comparePassword(password, staff.password_hash);
            if (isValidPassword) {
                // Suspension is validated before any token is issued.
                if (!(0, identity_scope_1.isIssuableIdentity)(staff)) {
                    return res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
                }
                // Parse accessible_pages
                const accessiblePages = parseAccessiblePages(staff.accessible_pages);
                // Generate JWT token. tv carries the live staff
                // token_version so /api/auth/login sessions are revoked
                // by the same version bump as /api/staff/login sessions.
                const token = await signLoginToken({
                    id: staff.id,
                    phone: staff.phone,
                    role: 'staff',
                    tv: Number(staff.token_version || 0),
                    accessible_pages: accessiblePages
                }, 'staff', deps.sessionStore);
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
    }
    catch (error) {
        if (error instanceof LoginSessionUnavailable) {
            res.set('Cache-Control', 'no-store');
            return res.status(503).json({ error: 'Session service unavailable' });
        }
        console.error('Login error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};
exports.createLoginHandler = createLoginHandler;
router.post('/login', (0, rate_limit_1.rateLimit)('auth-login', 12, 15 * 60000), (0, exports.createLoginHandler)({
    sessionStore: (0, exports.loginSessionsEnabled)() ? exports.productionLoginSessions : undefined,
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    comparePassword: (password, hash) => bcryptjs_1.default.compare(password, hash),
    loadAdminPermissions: admin_permissions_1.getAdminPermissions,
    loadAdminRoleCodes: admin_permissions_1.getAdminRoleCodes,
}));
router.post('/logout', auth_1.authenticateToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = req.user;
    if (!user?.sessionId) {
        // A sessionless legacy token cannot be individually revoked. Do not
        // pretend deleting a browser token revokes it at the server.
        return res.status(409).json({ error: 'A session-bound login is required', code: 'SESSION_REQUIRED' });
    }
    try {
        await (0, login_session_1.createLoginSessionAuthority)(exports.productionLoginSessions).revoke(user.sessionId, user.id);
        return res.status(204).end();
    }
    catch {
        return res.status(503).json({ error: 'Session service unavailable' });
    }
});
const createRegisterHandler = (deps) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    try {
        const { phone, email, password, name, role: requestedRole } = req.body ?? {};
        const role = (0, registration_policy_1.resolvePublicRegistrationRole)(requestedRole);
        const validated = (0, registration_policy_1.validatePublicRegistrationInput)({ phone, email, password, name });
        if (!validated.ok) {
            return res.status(400).json({ error: validated.error });
        }
        // Normalized existence checks: every stored format variant of the
        // phone is probed so one number cannot register twice, and a
        // taken email cannot be reused either. The rejection is
        // deliberately field-neutral to slow account enumeration.
        if (validated.phone) {
            const candidates = (0, phone_1.phoneLookupCandidates)(validated.phone);
            const existingByPhone = await deps.queryOne(`SELECT id FROM users WHERE phone IN (${candidates.map(() => '?').join(',')})`, candidates);
            if (existingByPhone) {
                return res.status(409).json({ error: 'An account with these details already exists' });
            }
        }
        if (validated.email) {
            const existingByEmail = await deps.queryOne('SELECT id FROM users WHERE email = ?', [validated.email]);
            if (existingByEmail) {
                return res.status(409).json({ error: 'An account with these details already exists' });
            }
        }
        const passwordHash = await deps.hashPassword(password);
        const userId = (0, node_crypto_1.randomUUID)();
        await deps.query(`INSERT INTO users (id, email, phone, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)`, [userId, validated.email, validated.phone, passwordHash, validated.name, role]);
        // Generate JWT token
        const token = await signLoginToken({ id: userId, email: validated.email, phone: validated.phone, role, tv: 0 }, 'users', deps.sessionStore);
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
    }
    catch (error) {
        if (error instanceof LoginSessionUnavailable) {
            res.set('Cache-Control', 'no-store');
            return res.status(503).json({ error: 'Account created; sign in when the session service is available', code: 'SESSION_UNAVAILABLE' });
        }
        console.error('Registration error:', error);
        return res.status(500).json({ error: 'Registration failed' });
    }
};
exports.createRegisterHandler = createRegisterHandler;
router.post('/register', (0, rate_limit_1.rateLimit)('auth-register', 10, 15 * 60000), (0, exports.createRegisterHandler)({
    sessionStore: (0, exports.loginSessionsEnabled)() ? exports.productionLoginSessions : undefined,
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    hashPassword: (password) => bcryptjs_1.default.hash(password, 10),
}));
// Get current user (requires token)
router.get('/me', auth_1.authenticateToken, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
        const { queryOne } = await loadDb();
        // The authenticated source is authoritative even if IDs collide across tables.
        if (req.user?.identitySource === 'staff') {
            const staff = await queryOne('SELECT id, name, email, phone, role, is_active, accessible_pages FROM staff WHERE id = ? AND is_active = 1', [req.user.id]);
            if (!staff)
                return res.status(401).json({ error: 'Identity unavailable' });
            return res.json({ user: { ...staff, role: 'staff', accessible_pages: parseAccessiblePages(staff.accessible_pages) } });
        }
        const user = await queryOne('SELECT id, email, name, role, is_active FROM users WHERE id = ? AND is_active = TRUE', [req.user?.id]);
        if (!user)
            return res.status(401).json({ error: 'Identity unavailable' });
        const staffProfile = user.role === 'staff'
            ? await queryOne('SELECT accessible_pages FROM staff WHERE id = ? AND is_active = 1', [user.id])
            : null;
        let adminPermissions = [];
        let adminRoles = [];
        try {
            adminPermissions = await (0, admin_permissions_1.getAdminPermissions)(user.id);
        }
        catch { /* no elevated capabilities */ }
        try {
            adminRoles = await (0, admin_permissions_1.getAdminRoleCodes)(user.id);
        }
        catch { /* no elevated capabilities */ }
        return res.json({ user: { ...user, ...(user.role === 'staff' ? { accessible_pages: parseAccessiblePages(staffProfile?.accessible_pages) } : {}), billing_only: Boolean(req.user?.billingOnly), admin_member: adminPermissions.length > 0, admin_permissions: adminPermissions, admin_roles: adminRoles } });
    }
    catch {
        return res.status(503).json({ error: 'Identity service unavailable', code: 'IDENTITY_UNAVAILABLE' });
    }
});
const createDeleteStudentEnrollmentHandler = (deps) => async (req, res) => {
    try {
        const user = req.user;
        const studentId = req.params.studentId;
        if (!studentId)
            return res.status(400).json({ error: 'Student ID is required' });
        if (!user)
            return res.status(401).json({ error: 'Authentication required' });
        let platformWide = false;
        if (user.role === 'admin') {
            try {
                platformWide = await deps.isPlatformAdmin(user.id);
            }
            catch {
                return res.status(503).json({ error: 'Platform authorization unavailable' });
            }
        }
        const tenantId = platformWide ? undefined : user.tenantId;
        if (!tenantId && !platformWide) {
            return res.status(403).json({ error: 'Tenant scope required' });
        }
        const student = await deps.queryOne(tenantId
            ? 'SELECT id, tenant_id FROM students WHERE id = ? AND tenant_id = ?'
            : 'SELECT id, tenant_id FROM students WHERE id = ?', tenantId ? [studentId, tenantId] : [studentId]);
        if (!student)
            return res.status(404).json({ error: 'Student not found' });
        // A student row is a tenant enrollment; the users row is a global
        // identity and is deliberately never deleted by this operation.
        await deps.execute('DELETE FROM student_courses WHERE student_id = ?', [studentId]);
        const result = await deps.execute(tenantId
            ? 'DELETE FROM students WHERE id = ? AND tenant_id = ?'
            : 'DELETE FROM students WHERE id = ?', tenantId ? [studentId, tenantId] : [studentId]);
        if (result.affectedRows === 0)
            return res.status(404).json({ error: 'Student not found' });
        return res.json({
            message: 'Student enrollment deleted; global user account preserved',
            userDeleted: false,
            studentDeleted: true,
            enrollmentDeleted: true,
        });
    }
    catch (error) {
        console.error('Delete student enrollment error:', error);
        return res.status(500).json({ error: 'Failed to delete student enrollment' });
    }
};
exports.createDeleteStudentEnrollmentHandler = createDeleteStudentEnrollmentHandler;
const createSearchByPhoneHandler = (deps) => async (req, res) => {
    try {
        const user = req.user;
        const phone = req.params.phone;
        if (!phone)
            return res.status(400).json({ error: 'Phone number is required' });
        if (!user)
            return res.status(401).json({ error: 'Authentication required' });
        let platformWide = false;
        if (!user.tenantId && user.role === 'admin') {
            try {
                platformWide = await deps.isPlatformAdmin(user.id);
            }
            catch {
                return res.status(503).json({ error: 'Platform authorization unavailable' });
            }
        }
        if (!user.tenantId && !platformWide) {
            return res.status(403).json({ error: 'Tenant scope required' });
        }
        const candidates = (0, phone_1.phoneLookupCandidates)(phone);
        const phonePredicate = candidates.length
            ? `u.phone IN (${candidates.map(() => '?').join(',')})`
            : 'u.phone = ?';
        const tenantPredicate = platformWide ? '' : 'AND s.tenant_id = ?';
        const params = candidates.length ? [...candidates] : [phone.trim()];
        if (!platformWide)
            params.push(user.tenantId);
        const users = await deps.query(`SELECT DISTINCT u.id, u.phone, u.name, u.role, u.is_active
                 FROM users u
                 WHERE ${phonePredicate}
                   AND u.is_active = TRUE
                   AND u.role = 'student'
                   AND EXISTS (
                     SELECT 1 FROM students s
                     INNER JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
                     WHERE s.user_id = u.id
                       AND s.is_active = 1
                       AND s.approval_status = 'approved'
                       ${tenantPredicate}
                   )
                 LIMIT 2`, params);
        if (users.length === 0)
            return res.status(404).json({ error: 'User not found' });
        if (users.length > 1)
            return res.status(409).json({ error: 'Multiple students match this phone number' });
        return res.json(users[0]);
    }
    catch (error) {
        console.error('Search user by phone error:', error);
        return res.status(500).json({ error: 'Failed to search user' });
    }
};
exports.createSearchByPhoneHandler = createSearchByPhoneHandler;
const deleteStudentEnrollmentHandler = (0, exports.createDeleteStudentEnrollmentHandler)({
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    execute: (sql, params) => loadDb().then((db) => db.execute(sql, params)),
    isPlatformAdmin: admin_permissions_1.isSuperAdmin,
});
router.delete('/users/student/:studentId', auth_1.authenticateToken, (0, auth_1.requireRoles)('admin', 'teacher'), deleteStudentEnrollmentHandler);
const searchByPhoneHandler = (0, exports.createSearchByPhoneHandler)({
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    isPlatformAdmin: admin_permissions_1.isSuperAdmin,
});
// Phone lookup is limited to active student enrollments in the caller's tenant.
// Only a server-verified platform admin may use the unscoped variant.
router.get('/search-by-phone/:phone', auth_1.authenticateToken, (0, auth_1.requireRoles)('admin', 'teacher', 'staff'), (0, rate_limit_1.rateLimit)('auth-search-phone', 60, 60000), searchByPhoneHandler);
exports.default = router;
