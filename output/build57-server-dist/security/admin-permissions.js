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
exports.requireSelfOrAdminPermission = exports.hasVerifiedPlatformPermission = exports.createPlatformPermissionCheck = exports.requireAdminPermission = exports.createRequireAdminPermission = void 0;
exports.isSuperAdmin = isSuperAdmin;
exports.getAdminRoleCodes = getAdminRoleCodes;
exports.getAdminPermissions = getAdminPermissions;
/**
 * `../db` is loaded lazily (and cached) so importing this module never runs
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query.
 */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
async function isSuperAdmin(userId) {
    const { query } = await loadDb();
    const rows = await query(`SELECT ur.user_id FROM admin_user_roles ur
     INNER JOIN users u ON u.id=ur.user_id AND u.is_active=1
     WHERE ur.user_id=? AND ur.role_code='super_admin' LIMIT 1`, [userId]);
    return rows.length > 0;
}
async function getAdminRoleCodes(userId) {
    const { query } = await loadDb();
    const rows = await query('SELECT role_code FROM admin_user_roles WHERE user_id=? ORDER BY role_code', [userId]);
    return rows.map(row => row.role_code);
}
async function getAdminPermissions(userId) {
    const { query } = await loadDb();
    const rows = await query(`SELECT DISTINCT rp.permission_key
     FROM admin_user_roles ur
     INNER JOIN admin_role_permissions rp ON rp.role_code = ur.role_code
     INNER JOIN users u ON u.id = ur.user_id AND u.is_active = 1
     WHERE ur.user_id = ?`, [userId]);
    return rows.map((row) => row.permission_key);
}
const defaultAdminPermissionLookup = {
    isSuperAdmin,
    getAdminPermissions,
};
/**
 * Guard factory: a principal reaches the wrapped route only when it is a
 * verified, active super_admin (admin_user_roles row against an active users
 * row) or holds the required platform permission key. A JWT role claim alone
 * never satisfies this guard: deny-by-default for every other identity,
 * including tenant admins. Lookup failures deny (503) instead of failing
 * open; a missing permission key denies with 403.
 */
const createRequireAdminPermission = (permission, lookup = defaultAdminPermissionLookup) => async (req, res, next) => {
    if (!req.user)
        return res.status(401).json({ error: 'Authentication required' });
    try {
        if (await lookup.isSuperAdmin(req.user.id))
            return next();
        const permissions = await lookup.getAdminPermissions(req.user.id);
        if (!permissions.includes(permission))
            return res.status(403).json({ error: 'Forbidden' });
        next();
    }
    catch (error) {
        console.error('Admin permission lookup failed');
        return res.status(503).json({ error: 'Admin authorization unavailable' });
    }
};
exports.createRequireAdminPermission = createRequireAdminPermission;
const requireAdminPermission = (permission) => (0, exports.createRequireAdminPermission)(permission);
exports.requireAdminPermission = requireAdminPermission;
/**
 * Inline platform-capability predicate for handlers that must authorize an
 * action without owning the response (e.g. inside a video or socket handler).
 * Same verified rule as the guard: a server-verified active super_admin or a
 * holder of the permission key. A JWT role claim alone never satisfies it.
 */
const createPlatformPermissionCheck = (permission, lookup = defaultAdminPermissionLookup) => async (userId) => {
    if (await lookup.isSuperAdmin(userId))
        return true;
    const permissions = await lookup.getAdminPermissions(userId);
    return permissions.includes(permission);
};
exports.createPlatformPermissionCheck = createPlatformPermissionCheck;
const hasVerifiedPlatformPermission = (permission, userId) => (0, exports.createPlatformPermissionCheck)(permission)(userId);
exports.hasVerifiedPlatformPermission = hasVerifiedPlatformPermission;
const requireSelfOrAdminPermission = (paramName, permission) => (req, res, next) => {
    if (!req.user)
        return res.status(401).json({ error: 'Authentication required' });
    if (String(req.user.id) === String(req.params[paramName]))
        return next();
    return (0, exports.requireAdminPermission)(permission)(req, res, next);
};
exports.requireSelfOrAdminPermission = requireSelfOrAdminPermission;
