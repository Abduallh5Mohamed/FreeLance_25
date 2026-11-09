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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGradesRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const auth_1 = require("../middleware/auth");
const teaching_access_1 = require("../middleware/teaching-access");
const admin_permissions_1 = require("../security/admin-permissions");
/** `grades.name` is VARCHAR(255). */
const MAX_NAME_LENGTH = 255;
/** INT range of `grades.display_order`. */
const MIN_DISPLAY_ORDER = -2147483648;
const MAX_DISPLAY_ORDER = 2147483647;
/** A catalog name: a non-blank string, trimmed. */
const readGradeName = (value) => {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
};
const isDisplayOrder = (value) => typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_DISPLAY_ORDER && value <= MAX_DISPLAY_ORDER;
/** Read a 0/1 (or boolean) flag the way the driver returns it. */
const flag = (value) => value === true || value === 1;
/**
 * The only client-supplied selector a write accepts: `scope: 'shared'`
 * addresses a legacy shared row. Everything else is tenant-scoped, and the
 * tenant itself is never read from the body.
 *
 * An explicit opt-in keeps tenancy deny-by-default — a caller that never asks
 * for the shared catalog can only ever reach its own tenant's rows — and it
 * also lets the router pick the authorization branch BEFORE any read, so an
 * unauthorized write never touches the storage layer.
 */
const GRADE_SHARED_SCOPE = 'shared';
const wantsSharedRow = (body) => {
    if (!body || typeof body !== 'object')
        return false;
    const scope = body.scope;
    return scope === GRADE_SHARED_SCOPE;
};
/**
 * Run a real authorization guard and return its decision.
 *
 * The guard is invoked with a capturing response: if it denies, it writes into
 * the capture instead of the socket and never calls next, so the router can
 * replay the guard's exact status and body. A guard that allows simply calls
 * next and nothing was written.
 */
const runGuard = async (guard, req) => {
    const captured = {};
    const capture = {
        status(code) { captured.statusCode = code; return capture; },
        json(payload) { captured.body = payload; return capture; },
    };
    let allowed = false;
    await guard(req, capture, () => { allowed = true; });
    return { allowed, response: captured };
};
/**
 * Authorize one grade write against the row it targets:
 *  - a shared (NULL tenant) row needs the verified platform permission;
 *  - a tenant row needs the teaching-write entitlement of the selected tenant.
 * A row that belongs to another tenant is never authorized here (the handler
 * treats it as not found).
 */
const authorizeGradeWrite = async (deps, req, shared) => runGuard(shared ? deps.authorizePlatformWrite : deps.requireTenantWrite, req);
/** Replay a captured denial on the real response. */
const replayDenial = (res, response) => {
    res.status(response.statusCode ?? 403).json(response.body ?? { error: 'Forbidden' });
};
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const createGradesRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { query, queryOne, execute } = deps.db;
    router.use(deps.optionalAuthenticate);
    /** The server-derived tenant of the authenticated principal. */
    const selectedTenant = (req) => req.user?.tenantId ?? null;
    // Get all grades: own tenant plus the legacy shared catalog
    router.get('/', deps.authenticate, async (req, res) => {
        const tenantId = selectedTenant(req);
        try {
            const grades = await query('SELECT * FROM grades WHERE (tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE ORDER BY display_order', [tenantId]);
            res.json(grades);
        }
        catch (error) {
            console.error('Get grades error:', error);
            res.status(500).json({ error: 'Failed to fetch grades' });
        }
    });
    // Get grade by ID
    router.get('/:id', deps.authenticate, async (req, res) => {
        const tenantId = selectedTenant(req);
        try {
            const grade = await queryOne('SELECT * FROM grades WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE', [req.params.id, tenantId]);
            if (!grade) {
                return res.status(404).json({ error: 'Grade not found' });
            }
            res.json(grade);
        }
        catch (error) {
            console.error('Get grade error:', error);
            res.status(500).json({ error: 'Failed to fetch grade' });
        }
    });
    // Create new grade
    router.post('/', deps.authenticate, async (req, res) => {
        const tenantId = selectedTenant(req);
        try {
            const sharedTarget = wantsSharedRow(req.body);
            // A shared create carries no tenant; a tenant create needs one,
            // otherwise no tenant_id could be bound at all.
            if (!sharedTarget && tenantId === null) {
                return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
            }
            // A create targets the caller's own tenant, so tenant authority is
            // what applies; the row's tenant_id is bound server-side.
            const decision = await authorizeGradeWrite(deps, req, sharedTarget);
            if (!decision.allowed) {
                replayDenial(res, decision.response);
                return;
            }
            const { name, display_order } = req.body ?? {};
            const nameValue = readGradeName(name);
            if (nameValue === undefined) {
                return res.status(400).json({ error: 'Name is required' });
            }
            if (nameValue.length > MAX_NAME_LENGTH) {
                return res.status(400).json({ error: 'Name is too long' });
            }
            let displayOrder = 0;
            if (display_order !== undefined && display_order !== null) {
                if (!isDisplayOrder(display_order)) {
                    return res.status(400).json({ error: 'Invalid display_order' });
                }
                displayOrder = display_order;
            }
            // grades.id is CHAR(36) with a UUID default, so a driver insert id
            // cannot identify the created row; the id is generated server-side
            // and the row is read back through it (same as the groups router).
            const newId = (0, crypto_1.randomUUID)();
            const boundTenant = sharedTarget ? null : tenantId;
            await execute('INSERT INTO grades (id, tenant_id, name, display_order) VALUES (?, ?, ?, ?)', [newId, boundTenant, nameValue, displayOrder]);
            const newGrade = sharedTarget
                ? await queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL', [newId])
                : await queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id = ?', [newId, tenantId]);
            res.status(201).json(newGrade);
        }
        catch (error) {
            console.error('Create grade error:', error);
            res.status(500).json({ error: 'Failed to create grade' });
        }
    });
    // Update grade
    router.put('/:id', deps.authenticate, async (req, res) => {
        const tenantId = selectedTenant(req);
        try {
            const { name, display_order } = req.body ?? {};
            const nameValue = readGradeName(name);
            if (nameValue === undefined) {
                return res.status(400).json({ error: 'Name is required' });
            }
            if (nameValue.length > MAX_NAME_LENGTH) {
                return res.status(400).json({ error: 'Name is too long' });
            }
            let displayOrder = null;
            if (display_order !== undefined && display_order !== null) {
                if (!isDisplayOrder(display_order)) {
                    return res.status(400).json({ error: 'Invalid display_order' });
                }
                displayOrder = display_order;
            }
            const sharedRow = wantsSharedRow(req.body);
            const decision = await authorizeGradeWrite(deps, req, sharedRow);
            if (!decision.allowed) {
                replayDenial(res, decision.response);
                return;
            }
            // Only an active row is addressable: a soft-deleted grade stays
            // deleted instead of being resurrected through an update. The
            // predicate carries the scope itself, so a grade of another tenant
            // is indistinguishable from a missing one.
            const existing = await (sharedRow
                ? queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL AND is_active = TRUE', [req.params.id])
                : queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id = ? AND is_active = TRUE', [req.params.id, tenantId]));
            if (!existing) {
                return res.status(404).json({ error: 'Grade not found' });
            }
            const result = sharedRow
                ? await execute('UPDATE grades SET name = ?, display_order = ? WHERE id = ? AND tenant_id IS NULL', [nameValue, displayOrder ?? existing.display_order, req.params.id])
                : await execute('UPDATE grades SET name = ?, display_order = ? WHERE id = ? AND tenant_id = ?', [nameValue, displayOrder ?? existing.display_order, req.params.id, tenantId]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Grade not found' });
            }
            const updatedGrade = sharedRow
                ? await queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL', [req.params.id])
                : await queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
            res.json(updatedGrade);
        }
        catch (error) {
            console.error('Update grade error:', error);
            res.status(500).json({ error: 'Failed to update grade' });
        }
    });
    // Delete grade (soft delete)
    router.delete('/:id', deps.authenticate, async (req, res) => {
        const tenantId = selectedTenant(req);
        try {
            const sharedRow = wantsSharedRow(req.body);
            const decision = await authorizeGradeWrite(deps, req, sharedRow);
            if (!decision.allowed) {
                replayDenial(res, decision.response);
                return;
            }
            // Only an active row is addressable, so deleting twice is a 404
            // instead of a silent success. The predicate carries the scope, so
            // another tenant's grade is indistinguishable from a missing one.
            const existing = await (sharedRow
                ? queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL AND is_active = TRUE', [req.params.id])
                : queryOne('SELECT * FROM grades WHERE id = ? AND tenant_id = ? AND is_active = TRUE', [req.params.id, tenantId]));
            if (!existing) {
                return res.status(404).json({ error: 'Grade not found' });
            }
            await (sharedRow
                ? execute('UPDATE grades SET is_active = FALSE WHERE id = ? AND tenant_id IS NULL', [req.params.id])
                : execute('UPDATE grades SET is_active = FALSE WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]));
            res.json({ message: 'Grade deleted successfully' });
        }
        catch (error) {
            console.error('Delete grade error:', error);
            res.status(500).json({ error: 'Failed to delete grade' });
        }
    });
    return router;
};
exports.createGradesRouter = createGradesRouter;
exports.default = (0, exports.createGradesRouter)({
    db: {
        query: async (sql, params) => (await loadDb()).query(sql, params),
        queryOne: async (sql, params) => (await loadDb()).queryOne(sql, params),
        execute: async (sql, params) => (await loadDb()).execute(sql, params),
    },
    authenticate: auth_1.authenticateToken,
    optionalAuthenticate: auth_1.optionalAuth,
    requireTenantWrite: (0, teaching_access_1.requireTeachingWrite)('groups'),
    authorizePlatformWrite: (0, admin_permissions_1.requireAdminPermission)('grade.manage'),
});
