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
exports.createStaffRouter = exports.validateStaffCreate = exports.STAFF_PAGE_KEY_MAX_LENGTH = exports.STAFF_ACCESSIBLE_PAGES_MAX = exports.STAFF_PASSWORD_MAX_LENGTH = exports.STAFF_PASSWORD_MIN_LENGTH = exports.STAFF_PHONE_MAX_LENGTH = exports.STAFF_PHONE_MIN_LENGTH = exports.STAFF_NAME_MAX_LENGTH = void 0;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const node_crypto_1 = require("node:crypto");
const auth_1 = require("../middleware/auth");
const auth_2 = require("./auth");
const rate_limit_1 = require("../middleware/rate-limit");
const admin_permissions_1 = require("../security/admin-permissions");
exports.STAFF_NAME_MAX_LENGTH = 100;
exports.STAFF_PHONE_MIN_LENGTH = 5;
exports.STAFF_PHONE_MAX_LENGTH = 20;
exports.STAFF_PASSWORD_MIN_LENGTH = 8;
exports.STAFF_PASSWORD_MAX_LENGTH = 128;
exports.STAFF_ACCESSIBLE_PAGES_MAX = 50;
exports.STAFF_PAGE_KEY_MAX_LENGTH = 64;
const isMissingStaffTokenVersion = (error) => {
    if (!error || typeof error !== 'object')
        return false;
    const candidate = error;
    return candidate.code === 'ER_BAD_FIELD_ERROR' &&
        typeof candidate.message === 'string' && /token_version/i.test(candidate.message);
};
const validateStaffCreate = (body) => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const accessiblePagesRaw = body.accessible_pages ?? body.accessiblePages ?? [];
    if (!name || !phone || !password) {
        return { ok: false, error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' };
    }
    if (name.length > exports.STAFF_NAME_MAX_LENGTH) {
        return { ok: false, error: 'Staff name is too long' };
    }
    if (phone.length < exports.STAFF_PHONE_MIN_LENGTH || phone.length > exports.STAFF_PHONE_MAX_LENGTH) {
        return { ok: false, error: 'Invalid phone number' };
    }
    if (password.length < exports.STAFF_PASSWORD_MIN_LENGTH || password.length > exports.STAFF_PASSWORD_MAX_LENGTH) {
        return { ok: false, error: 'Password must be 8-128 characters' };
    }
    if (!Array.isArray(accessiblePagesRaw) || accessiblePagesRaw.length > exports.STAFF_ACCESSIBLE_PAGES_MAX) {
        return { ok: false, error: 'Invalid accessible pages' };
    }
    for (const page of accessiblePagesRaw) {
        if (typeof page !== 'string' || page.length === 0 || page.length > exports.STAFF_PAGE_KEY_MAX_LENGTH) {
            return { ok: false, error: 'Invalid accessible pages' };
        }
    }
    return { ok: true, value: { name, phone, password, accessiblePages: accessiblePagesRaw } };
};
exports.validateStaffCreate = validateStaffCreate;
const createStaffRouter = (deps) => {
    const staffRouter = (0, express_1.Router)();
    // Get all staff members
    staffRouter.get('/', deps.authenticate, deps.authorizeAdmin, async (req, res) => {
        try {
            const staffList = await deps.query(`SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at
                 FROM staff WHERE is_active = 1 ORDER BY created_at DESC`);
            // Parse accessible_pages from JSON string to array
            const parsedStaff = staffList.map(s => ({
                ...s,
                accessible_pages: typeof s.accessible_pages === 'string'
                    ? JSON.parse(s.accessible_pages)
                    : (s.accessible_pages || [])
            }));
            res.json(parsedStaff);
        }
        catch (error) {
            console.error('Error fetching staff:');
            res.status(500).json({ error: 'Failed to fetch staff' });
        }
    });
    // Get single staff member
    staffRouter.get('/:id', deps.authenticate, deps.authorizeAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const staff = await deps.queryOne(`SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at
                 FROM staff WHERE id = ?`, [id]);
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
        }
        catch (error) {
            console.error('Error fetching staff:');
            res.status(500).json({ error: 'Failed to fetch staff' });
        }
    });
    // Create new staff member
    staffRouter.post('/', deps.authenticate, deps.authorizeAdmin, async (req, res) => {
        try {
            const body = (req.body ?? {});
            const validation = (0, exports.validateStaffCreate)(body);
            if (!validation.ok) {
                return res.status(400).json({ error: validation.error });
            }
            const { name, phone, password, accessiblePages } = validation.value;
            // Check if phone exists in staff table
            const existingStaff = await deps.queryOne('SELECT id FROM staff WHERE phone = ?', [phone]);
            if (existingStaff) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف' });
            }
            // Check if phone exists in users table (admin/teacher/student)
            const existingUser = await deps.queryOne('SELECT id, role FROM users WHERE phone = ?', [phone]);
            if (existingUser) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل في النظام' });
            }
            // Hash password
            const passwordHash = await bcryptjs_1.default.hash(password, 10);
            // CHAR(36) identity: MySQL insertId is not the generated UUID.
            const staffId = (0, node_crypto_1.randomUUID)();
            const result = await deps.execute(`INSERT INTO staff (id, name, phone, password_hash, role, accessible_pages, is_active)
                 VALUES (?, ?, ?, ?, 'staff', ?, 1)`, [
                staffId,
                name,
                phone,
                passwordHash,
                JSON.stringify(accessiblePages)
            ]);
            if (result.affectedRows !== 1)
                throw new Error('Staff creation was not confirmed');
            res.status(201).json({
                id: staffId,
                name,
                phone,
                role: 'staff',
                accessible_pages: accessiblePages,
                is_active: true,
                message: 'تم إنشاء الموظف بنجاح'
            });
        }
        catch (error) {
            console.error('Error creating staff:');
            res.status(500).json({ error: 'Failed to create staff' });
        }
    });
    // Update staff member
    staffRouter.put('/:id', deps.authenticate, deps.authorizeAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const body = (req.body ?? {});
            const nameRaw = typeof body.name === 'string' ? body.name.trim() : undefined;
            const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : undefined;
            const passwordRaw = typeof body.password === 'string' ? body.password : undefined;
            const accessiblePagesRaw = body.accessible_pages;
            if (nameRaw !== undefined && (nameRaw.length === 0 || nameRaw.length > exports.STAFF_NAME_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid staff name' });
            }
            if (phoneRaw !== undefined && (phoneRaw.length < exports.STAFF_PHONE_MIN_LENGTH || phoneRaw.length > exports.STAFF_PHONE_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid phone number' });
            }
            if (passwordRaw !== undefined && (passwordRaw.length < exports.STAFF_PASSWORD_MIN_LENGTH || passwordRaw.length > exports.STAFF_PASSWORD_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Password must be 8-128 characters' });
            }
            if (accessiblePagesRaw !== undefined) {
                if (!Array.isArray(accessiblePagesRaw) || accessiblePagesRaw.length > exports.STAFF_ACCESSIBLE_PAGES_MAX) {
                    return res.status(400).json({ error: 'Invalid accessible pages' });
                }
                for (const page of accessiblePagesRaw) {
                    if (typeof page !== 'string' || page.length === 0 || page.length > exports.STAFF_PAGE_KEY_MAX_LENGTH) {
                        return res.status(400).json({ error: 'Invalid accessible pages' });
                    }
                }
            }
            if (!deps.transaction)
                return res.status(503).json({ error: 'Identity transaction unavailable' });
            const passwordHash = passwordRaw ? await bcryptjs_1.default.hash(passwordRaw, 10) : null;
            const outcome = await deps.transaction(async (tx) => {
                const staff = await tx.queryOne('SELECT id, phone FROM staff WHERE id=? FOR UPDATE', [id]);
                if (!staff)
                    return { status: 404, body: { error: 'الموظف غير موجود' } };
                const promoted = await tx.queryOne('SELECT id FROM users WHERE id=? FOR UPDATE', [id]);
                if (promoted)
                    return { status: 409, body: {
                            error: 'عدّل هذا الحساب من إدارة حسابات المسؤولين.', code: 'ADMIN_ACCOUNT_MANAGEMENT_REQUIRED',
                        } };
                if (phoneRaw && phoneRaw !== staff.phone) {
                    const duplicate = await tx.queryOne('SELECT id FROM staff WHERE phone=? AND id<>? LIMIT 1', [phoneRaw, id]);
                    const userDuplicate = await tx.queryOne('SELECT id FROM users WHERE phone=? LIMIT 1', [phoneRaw]);
                    if (duplicate || userDuplicate)
                        return { status: 409, body: { error: 'رقم الهاتف مستخدم بالفعل' } };
                }
                const fields = [];
                const values = [];
                if (nameRaw !== undefined) {
                    fields.push('name=?');
                    values.push(nameRaw);
                }
                if (phoneRaw !== undefined) {
                    fields.push('phone=?');
                    values.push(phoneRaw);
                }
                if (passwordHash) {
                    fields.push('password_hash=?');
                    values.push(passwordHash);
                }
                if (accessiblePagesRaw !== undefined) {
                    fields.push('accessible_pages=?');
                    values.push(JSON.stringify(accessiblePagesRaw));
                }
                if (!fields.length)
                    return { status: 400, body: { error: 'No fields to update' } };
                if (passwordHash || phoneRaw !== undefined || accessiblePagesRaw !== undefined)
                    fields.push('token_version=COALESCE(token_version,0)+1');
                fields.push('updated_at=NOW()');
                values.push(id);
                await tx.execute('UPDATE staff SET ' + fields.join(', ') + ' WHERE id=?', values);
                const updated = await tx.queryOne('SELECT id,name,email,phone,role,accessible_pages,is_active,created_at,updated_at FROM staff WHERE id=?', [id]);
                if (!updated)
                    throw new Error('Identity disappeared during update');
                let pages = updated.accessible_pages;
                if (typeof pages === 'string') {
                    try {
                        pages = JSON.parse(pages);
                    }
                    catch {
                        pages = [];
                    }
                }
                return { status: 200, body: { ...updated, accessible_pages: Array.isArray(pages) ? pages.filter(page => typeof page === 'string') : [], message: 'تم تحديث بيانات الموظف بنجاح' } };
            });
            return res.status(outcome.status).json(outcome.body);
        }
        catch (error) {
            if (isMissingStaffTokenVersion(error))
                return res.status(503).json({ error: 'Session revocation schema unavailable', code: 'SESSION_REVOCATION_UNAVAILABLE' });
            return res.status(500).json({ error: 'Failed to update staff' });
        }
    });
    // Staff deactivation cannot leave a promoted users login silently active.
    staffRouter.delete('/:id', deps.authenticate, deps.authorizeAdmin, async (req, res) => {
        try {
            if (!deps.transaction)
                return res.status(503).json({ error: 'Identity transaction unavailable' });
            const outcome = await deps.transaction(async (tx) => {
                const staff = await tx.queryOne('SELECT id FROM staff WHERE id=? FOR UPDATE', [req.params.id]);
                if (!staff)
                    return { status: 404, body: { error: 'Staff not found' } };
                const promoted = await tx.queryOne('SELECT id FROM users WHERE id=? FOR UPDATE', [staff.id]);
                if (promoted)
                    return { status: 409, body: { error: 'عطّل هذا الحساب من إدارة حسابات المسؤولين.', code: 'ADMIN_ACCOUNT_MANAGEMENT_REQUIRED' } };
                const changed = await tx.execute('UPDATE staff SET is_active=0, token_version=COALESCE(token_version,0)+1, updated_at=NOW() WHERE id=?', [staff.id]);
                if (changed.affectedRows !== 1)
                    throw new Error('Identity deactivation was not confirmed');
                return { status: 200, body: { message: 'تم حذف الموظف بنجاح' } };
            });
            return res.status(outcome.status).json(outcome.body);
        }
        catch (error) {
            if (isMissingStaffTokenVersion(error))
                return res.status(503).json({ error: 'Session revocation schema unavailable', code: 'SESSION_REVOCATION_UNAVAILABLE' });
            return res.status(500).json({ error: 'Failed to delete staff' });
        }
    });
    // Staff login endpoint (public: authentication happens here)
    staffRouter.post('/login', (0, rate_limit_1.rateLimit)('staff-login', 12, 15 * 60000), async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        try {
            const body = (req.body ?? {});
            const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
            const password = typeof body.password === 'string' ? body.password : '';
            if (!phone || !password) {
                return res.status(400).json({ error: 'Phone and password are required' });
            }
            if (phone.length > exports.STAFF_PHONE_MAX_LENGTH || password.length > exports.STAFF_PASSWORD_MAX_LENGTH) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            let staff;
            try {
                staff = await deps.queryOne(`SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active, token_version
                     FROM staff WHERE phone = ?`, [phone]);
            }
            catch (error) {
                if (!isMissingStaffTokenVersion(error))
                    throw error;
                staff = await deps.queryOne(`SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active
                     FROM staff WHERE phone = ?`, [phone]);
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
            const promoted = await deps.queryOne('SELECT id FROM users WHERE id = ? LIMIT 1', [staff.id]);
            if (promoted)
                return res.status(409).json({
                    error: 'استخدم صفحة تسجيل الدخول الرئيسية لهذا الحساب.', code: 'UNIFIED_LOGIN_REQUIRED',
                });
            // Parse accessible_pages
            const accessiblePages = typeof staff.accessible_pages === 'string'
                ? JSON.parse(staff.accessible_pages)
                : (staff.accessible_pages || []);
            // Generate JWT token
            const token = await (0, auth_2.signLoginToken)({
                id: staff.id,
                phone: staff.phone,
                role: 'staff',
                tv: Number(staff.token_version || 0),
                accessible_pages: accessiblePages
            }, 'staff', deps.sessionStore);
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
        }
        catch (error) {
            if (error instanceof auth_2.LoginSessionUnavailable) {
                res.set('Cache-Control', 'no-store');
                return res.status(503).json({ error: 'Session service unavailable' });
            }
            console.error('Staff login error:');
            res.status(500).json({ error: 'Authentication failed' });
        }
    });
    return staffRouter;
};
exports.createStaffRouter = createStaffRouter;
/**
 * `../db` is loaded lazily (and cached) so importing this module never runs
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query; hermetic tests inject adapters through
 * createStaffRouter and never reach these defaults.
 */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
exports.default = (0, exports.createStaffRouter)({
    sessionStore: (0, auth_2.loginSessionsEnabled)() ? auth_2.productionLoginSessions : undefined,
    transaction: async (fn) => {
        const connection = await (await loadDb()).getPool().getConnection();
        try {
            await connection.beginTransaction();
            const result = await fn({
                queryOne: async (sql, params) => {
                    const [rows] = await connection.execute(sql, params);
                    return rows[0] ?? null;
                },
                execute: async (sql, params) => {
                    const [result] = await connection.execute(sql, params);
                    return result;
                },
            });
            await connection.commit();
            return result;
        }
        catch (error) {
            try {
                await connection.rollback();
            }
            catch { /* Preserve the original failure. */ }
            throw error;
        }
        finally {
            connection.release();
        }
    },
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    execute: (sql, params) => loadDb().then((db) => db.execute(sql, params)),
    comparePassword: (password, hash) => bcryptjs_1.default.compare(password, hash),
    authenticate: auth_1.authenticateToken,
    // Verified platform-admin check: a bare admin role claim is not enough.
    authorizeAdmin: (0, admin_permissions_1.requireAdminPermission)('staff.manage'),
});
