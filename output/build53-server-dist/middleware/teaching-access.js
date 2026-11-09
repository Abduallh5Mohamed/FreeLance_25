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
exports.requireTeachingWrite = exports.createRequireTeachingWrite = exports.evaluateTeachingEntitlement = exports.defaultTeachingAccessRepository = exports.TEACHING_MEMBERSHIP_ROLE_KEYS = void 0;
const pageForArea = {
    students: 'students', lectures: 'courses', groups: 'groups', materials: 'courses', exams: 'courses', courses: 'courses',
};
/** Membership role keys that carry verified teaching authority in a tenant. */
exports.TEACHING_MEMBERSHIP_ROLE_KEYS = ['owner', 'instructor'];
/**
 * The default SQL adapters load `../db` lazily so importing this module
 * (directly or through the route factories) never executes db.ts: no dotenv
 * side effect and no pool creation at import time. Hermetic tests inject
 * fixtures and never call these defaults.
 */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
exports.defaultTeachingAccessRepository = {
    loadSelectedTenantMembership: async (userId, tenantId) => {
        const { queryOne } = await loadDb();
        return queryOne(`SELECT m.role_key,
              u.is_active AS user_is_active,
              t.status AS tenant_status,
              t.legacy_compat AS tenant_legacy_compat,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id=t.id
                    AND s.status IN ('active','grace_period','past_due')
                    AND s.starts_at<=UTC_TIMESTAMP()
                    AND DATE_ADD(s.period_ends_at, INTERVAL 4 DAY)>UTC_TIMESTAMP()
                ) THEN 1 ELSE 0 END AS subscription_entitles
       FROM tenant_memberships m
       INNER JOIN tenants t ON t.id=m.tenant_id
       INNER JOIN users u ON u.id=m.user_id
       WHERE m.user_id=? AND m.tenant_id=? AND m.status='active'
       LIMIT 1`, [userId, tenantId]);
    },
    loadStaffPagePermissions: async (userId) => {
        const { queryOne } = await loadDb();
        return queryOne('SELECT accessible_pages,is_active FROM staff WHERE id=?', [userId]);
    },
};
const flag = (value) => value === true || value === 1 || value === '1';
const parsePages = (value) => {
    if (!value)
        return [];
    if (typeof value !== 'string')
        return Array.isArray(value) ? value : [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((page) => typeof page === 'string') : [];
    }
    catch {
        return [];
    }
};
/**
 * Teaching-write entitlement, decided only against the selected tenant
 * (deny-by-default):
 *  1. a tenant must be selected — an absent, forged, or revoked selection
 *         carries no authority and never falls back to another membership;
 *  2. the caller must hold an ACTIVE membership in that tenant with a
 *         teaching role_key, while the user, the tenant, and the membership
 *         itself are active — a bare global teacher/staff/instructor role
 *         claim never satisfies this;
 *  3. the tenant must be entitled: legacy compatibility or an active
 *         subscription within the agreed four-day grace boundary, both
 *         computed server-side (unchanged billing semantics);
 *  4. staff identities additionally need the area's page permission — page
 *         permission alone never grants access to a tenant.
 */
const evaluateTeachingEntitlement = (view) => {
    const { role, selectedTenantId, membership, staffPagePermission, requiredPage } = view;
    if (!selectedTenantId)
        return 'denied';
    if (!membership)
        return 'denied';
    if (!flag(membership.user_is_active))
        return 'denied';
    if (membership.tenant_status !== 'active')
        return 'denied';
    if (!exports.TEACHING_MEMBERSHIP_ROLE_KEYS.includes(membership.role_key)) {
        return 'denied';
    }
    if (!flag(membership.tenant_legacy_compat) && !flag(membership.subscription_entitles))
        return 'denied';
    if (role === 'staff') {
        if (!staffPagePermission || !flag(staffPagePermission.is_active))
            return 'denied';
        if (!parsePages(staffPagePermission.accessible_pages).includes(requiredPage))
            return 'denied';
    }
    return 'allowed';
};
exports.evaluateTeachingEntitlement = evaluateTeachingEntitlement;
/**
 * Build the teaching-write guard over an injected repository. Production
 * uses the default SQL repository; hermetic tests inject fixtures.
 *
 * Applies to teaching writes, not to student learning reads. Membership in
 * the selected tenant, its subscription/grace policy, and staff page
 * capabilities are all resolved from server-side rows; a client-supplied
 * tenant selector is never trusted (auth resolves the selection first).
 */
const createRequireTeachingWrite = (area, repository = exports.defaultTeachingAccessRepository) => async (req, res, next) => {
    if (!req.user)
        return res.status(401).json({ error: 'Authentication required' });
    try {
        // A billed-out instructor carries no teaching entitlement even before
        // any read runs (fail closed rather than relying on route ordering).
        if (req.user.billingOnly) {
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }
        const selectedTenantId = req.user.tenantId;
        // Both reads are pure lookups keyed by the server-derived selection;
        // the decision below consumes exactly the rows returned, so no
        // check-then-use window can widen authority between reads.
        const membership = selectedTenantId
            ? await repository.loadSelectedTenantMembership(req.user.id, selectedTenantId)
            : null;
        const staffPagePermission = req.user.role === 'staff'
            ? await repository.loadStaffPagePermissions(req.user.id)
            : null;
        const decision = (0, exports.evaluateTeachingEntitlement)({
            role: req.user.role,
            selectedTenantId,
            membership,
            staffPagePermission,
            requiredPage: pageForArea[area],
        });
        if (decision === 'denied') {
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }
        next();
    }
    catch (error) {
        console.error('Teaching entitlement check failed:', error);
        return res.status(503).json({ error: 'Teaching entitlement unavailable' });
    }
};
exports.createRequireTeachingWrite = createRequireTeachingWrite;
/** Production wiring; route callsites keep the exact same signature. */
const requireTeachingWrite = (area) => (0, exports.createRequireTeachingWrite)(area);
exports.requireTeachingWrite = requireTeachingWrite;
