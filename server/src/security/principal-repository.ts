/**
 * Repository boundary for identity liveness and workspace scope lookups.
 *
 * The auth middleware resolves a principal exclusively through this
 * repository, so production SQL lives in exactly one place and hermetic
 * tests can inject isolated fixtures instead of touching a database. Rows
 * are always fetched with the server-side active filters applied; a claim
 * carried by a token is only ever treated as a selector, never as authority.
 */
import {
    ACTIVE_SUSPENSION_PREDICATE_SQL,
} from './suspension-predicate';
import {
    StudentEnrollmentRow,
    TenantMembershipRow,
} from './identity-scope';

/**
 * The default SQL adapters load `../db` lazily so that importing this module
 * (directly or through the auth middleware/route factories) never executes
 * db.ts: no dotenv side effect and no pool creation at import time. The pool
 * is created on the first real query, and hermetic tests inject fixtures
 * without ever calling these defaults.
 */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

export interface UsersIdentityRow {
    is_active: boolean | number;
    token_version: number | null;
    /** Current database role used to validate the signed role claim. */
    role?: string;
    /** SQL-computed: true while users.suspended_until is still in the future. */
    suspension_active: boolean | number;
}

export interface StaffIdentityRow {
    is_active: boolean | number;
    token_version?: number | null;
}

export interface InstructorAccountRow {
    tenant_status: string;
    legacy_compat: number;
    allowed: number;
}

/**
 * Live branch + membership state for a branch-scoped session. Read on every
 * protected request so a branch suspension, membership revocation or version
 * bump denies the NEXT request; no cross-request cache is consulted.
 */
export interface BranchSessionRow {
    branch_id: string;
    branch_tenant_id: string;
    branch_status: string;
    branch_version: number;
    membership_status: string | null;
    membership_version: number | null;
    membership_role: string | null;
}

export interface PrincipalRepository {
    /** users-table identity for liveness/revocation checks. */
    findUsersIdentity(id: string): Promise<UsersIdentityRow | null>;
    /** Staff-table identity and its session revocation version. */
    findStaffIdentity(id: string): Promise<StaffIdentityRow | null>;
    /** Active tenant ownership/subscription state for instructor billing gating. */
    findInstructorAccount(userId: string): Promise<InstructorAccountRow | null>;
    /** Active, approved student enrollments across active tenants. */
    findStudentEnrollments(userId: string): Promise<StudentEnrollmentRow[]>;
    /** Active memberships across active tenants (non-student roles). */
    findActiveTenantMemberships(userId: string): Promise<TenantMembershipRow[]>;
    /** Live branch and membership state for a branch-scoped token. */
    findBranchSession(branchId: string, userId: string): Promise<BranchSessionRow | null>;
    /** True when the user is the active owner of exactly this tenant. */
    isTenantOwner(userId: string, tenantId: string): Promise<boolean>;
}

const isMissingStaffTokenVersion = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; message?: unknown };
    return candidate.code === 'ER_BAD_FIELD_ERROR' &&
        typeof candidate.message === 'string' && /token_version/i.test(candidate.message);
};

export const defaultPrincipalRepository: PrincipalRepository = {
    findUsersIdentity: async (id) => {
        const { queryOne } = await loadDb();
        return queryOne<UsersIdentityRow>(
            `SELECT is_active, token_version, role,
                    ${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active
             FROM users WHERE id=? LIMIT 1`,
            [id]
        );
    },

    findStaffIdentity: async (id) => {
        const { queryOne } = await loadDb();
        try {
            return await queryOne<StaffIdentityRow>(
                'SELECT is_active, token_version FROM staff WHERE id=? LIMIT 1', [id]
            );
        } catch (error) {
            if (!isMissingStaffTokenVersion(error)) throw error;
            const legacyRow = await queryOne<{ is_active: boolean | number }>(
                'SELECT is_active FROM staff WHERE id=? LIMIT 1', [id]
            );
            return legacyRow ? { ...legacyRow, token_version: 0 } : null;
        }
    },

    findInstructorAccount: async (userId) => {
        const { queryOne } = await loadDb();
        return queryOne<InstructorAccountRow>(
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
            [userId, userId]
        );
    },

    findStudentEnrollments: async (userId) => {
        const { query } = await loadDb();
        return query<StudentEnrollmentRow>(
            `SELECT s.id,s.user_id,s.tenant_id,s.instructor_id,s.group_id,s.grade_id
             FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
             WHERE s.user_id=? AND s.is_active=1 AND s.approval_status='approved' AND t.status='active'
               AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
               AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
               AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())`,
            [userId]
        );
    },

    findActiveTenantMemberships: async (userId) => {
        const { query } = await loadDb();
        return query<TenantMembershipRow>(
            `SELECT m.tenant_id FROM tenant_memberships m
             INNER JOIN tenants t ON t.id=m.tenant_id
             WHERE m.user_id=? AND m.status='active' AND t.status='active'`,
            [userId]
        );
    },

    findBranchSession: async (branchId, userId) => {
        const { queryOne } = await loadDb();
        return queryOne<BranchSessionRow>(
            `SELECT b.id AS branch_id,
                    b.tenant_id AS branch_tenant_id,
                    b.status AS branch_status,
                    b.version AS branch_version,
                    m.status AS membership_status,
                    m.version AS membership_version,
                    m.role AS membership_role
             FROM branches b
             LEFT JOIN branch_memberships m ON m.branch_id=b.id AND m.user_id=?
             WHERE b.id=? LIMIT 1`,
            [userId, branchId]
        );
    },

    isTenantOwner: async (userId, tenantId) => {
        const { queryOne } = await loadDb();
        const row = await queryOne<{ id: string }>(
            "SELECT id FROM tenants WHERE id=? AND owner_user_id=? AND status='active' LIMIT 1",
            [tenantId, userId]
        );
        return Boolean(row);
    },
};
