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
exports.defaultPrincipalRepository = void 0;
/**
 * Repository boundary for identity liveness and workspace scope lookups.
 *
 * The auth middleware resolves a principal exclusively through this
 * repository, so production SQL lives in exactly one place and hermetic
 * tests can inject isolated fixtures instead of touching a database. Rows
 * are always fetched with the server-side active filters applied; a claim
 * carried by a token is only ever treated as a selector, never as authority.
 */
const suspension_predicate_1 = require("./suspension-predicate");
const login_session_sql_1 = require("./login-session-sql");
/**
 * The default SQL adapters load `../db` lazily so that importing this module
 * (directly or through the auth middleware/route factories) never executes
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query, and hermetic tests inject fixtures
 * without ever calling these defaults.
 */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const isMissingStaffTokenVersion = (error) => {
    if (!error || typeof error !== 'object')
        return false;
    const candidate = error;
    return candidate.code === 'ER_BAD_FIELD_ERROR' &&
        typeof candidate.message === 'string' && /token_version/i.test(candidate.message);
};
exports.defaultPrincipalRepository = {
    findLoginSession: async (sessionId, userId) => {
        const { queryOne, execute } = await loadDb();
        return (0, login_session_sql_1.createLoginSessionSqlStore)({ queryOne, execute }).find(sessionId, userId);
    },
    findUsersIdentity: async (id) => {
        const { queryOne } = await loadDb();
        return queryOne(`SELECT is_active, token_version, role, center_account,
                    ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active
             FROM users WHERE id=? LIMIT 1`, [id]);
    },
    findStaffIdentity: async (id) => {
        const { queryOne } = await loadDb();
        try {
            return await queryOne('SELECT is_active, token_version FROM staff WHERE id=? LIMIT 1', [id]);
        }
        catch (error) {
            if (!isMissingStaffTokenVersion(error))
                throw error;
            const legacyRow = await queryOne('SELECT is_active FROM staff WHERE id=? LIMIT 1', [id]);
            return legacyRow ? { ...legacyRow, token_version: 0 } : null;
        }
    },
    findInstructorAccount: async (userId) => {
        const { queryOne } = await loadDb();
        return queryOne(`SELECT t.status AS tenant_status, t.legacy_compat,
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
             ORDER BY t.created_at DESC LIMIT 1`, [userId, userId]);
    },
    findStudentEnrollments: async (userId) => {
        const { query } = await loadDb();
        return query(`SELECT s.id,s.user_id,s.tenant_id,s.instructor_id,s.group_id,s.grade_id
             FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
             WHERE s.user_id=? AND s.is_active=1 AND s.approval_status='approved' AND t.status='active'
               AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
               AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
               AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())`, [userId]);
    },
    findActiveTenantMemberships: async (userId) => {
        const { query } = await loadDb();
        return query(`SELECT m.tenant_id FROM tenant_memberships m
             INNER JOIN tenants t ON t.id=m.tenant_id
             WHERE m.user_id=? AND m.status='active' AND t.status='active'`, [userId]);
    },
    findBranchSession: async (branchId, userId) => {
        const { queryOne } = await loadDb();
        return queryOne(`SELECT b.id AS branch_id,
                    b.tenant_id AS branch_tenant_id,
                    b.status AS branch_status,
                    b.version AS branch_version,
                    m.status AS membership_status,
                    m.version AS membership_version,
                    m.role AS membership_role
             FROM branches b
             LEFT JOIN branch_memberships m ON m.branch_id=b.id AND m.user_id=?
             WHERE b.id=? LIMIT 1`, [userId, branchId]);
    },
    isTenantOwner: async (userId, tenantId) => {
        const { queryOne } = await loadDb();
        const row = await queryOne("SELECT id FROM tenants WHERE id=? AND owner_user_id=? AND status='active' LIMIT 1", [tenantId, userId]);
        return Boolean(row);
    },
};
