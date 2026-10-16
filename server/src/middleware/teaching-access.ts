import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

const pageForArea: Record<string, string> = {
  students: 'students', lectures: 'courses', groups: 'groups', materials: 'courses', exams: 'courses', courses: 'courses',
};

/** Membership role keys that carry verified teaching authority in a tenant. */
export const TEACHING_MEMBERSHIP_ROLE_KEYS = ['owner', 'instructor'] as const;

/**
 * Server-derived state of the caller's ACTIVE membership in the currently
 * selected tenant. Every field is read from server-side rows in one
 * statement keyed by (user, selected tenant); a client-supplied tenant is
 * never used because the selected tenant itself is resolved by the auth
 * middleware from the token's selector claim against active memberships.
 */
export interface SelectedTenantMembershipRow {
  role_key: string;
  /** users.is_active of the membership's user (0/1). */
  user_is_active: number | boolean;
  /** tenants.status of the selected tenant ('active' | 'suspended' | ...). */
  tenant_status: string;
  /** tenants.legacy_compat of the selected tenant (0/1). */
  tenant_legacy_compat: number | boolean;
  /**
   * Server-computed subscription/grace flag for the selected tenant:
   * an active/grace_period/past_due subscription that has started and whose
   * period ends no earlier than the agreed four-day grace boundary.
   */
  subscription_entitles: number | boolean;
}

/** Staff-table capability row (page permissions), scoped by staff id. */
export interface StaffPagePermissionRow {
  accessible_pages: string | string[] | null;
  is_active: number | boolean;
}

/**
 * Data seam for the teaching-entitlement decision. Production answers from
 * MySQL; hermetic tests inject isolated fixtures so no database, environment
 * or service is contacted while exercising the real middleware.
 */
export interface TeachingAccessRepository {
  /** Active membership of `userId` in exactly the tenant `tenantId`, with the
   * tenant's subscription/grace policy computed server-side in the same read. */
  loadSelectedTenantMembership(userId: string, tenantId: string): Promise<SelectedTenantMembershipRow | null>;
  /** Staff page permissions (staff-table identities), by staff id. */
  loadStaffPagePermissions(userId: string): Promise<StaffPagePermissionRow | null>;
}

/**
 * The default SQL adapters load `../db` lazily so importing this module
 * (directly or through the route factories) never executes db.ts: no dotenv
 * side effect and no pool creation at import time. Hermetic tests inject
 * fixtures and never call these defaults.
 */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
  dbModule ??= await import('../db');
  return dbModule;
};

export const defaultTeachingAccessRepository: TeachingAccessRepository = {
  loadSelectedTenantMembership: async (userId, tenantId) => {
    const { queryOne } = await loadDb();
    return queryOne<SelectedTenantMembershipRow>(
      `SELECT m.role_key,
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
       LIMIT 1`,
      [userId, tenantId]
    );
  },
  loadStaffPagePermissions: async (userId) => {
    const { queryOne } = await loadDb();
    return queryOne<StaffPagePermissionRow>(
      'SELECT accessible_pages,is_active FROM staff WHERE id=?', [userId]
    );
  },
};

export interface TeachingEntitlementView {
  /** Caller role claim (validated live by auth middleware). */
  role: string;
  /** Server-derived selected tenant; absent means no tenant was resolved. */
  selectedTenantId: string | null | undefined;
  /** Membership row for (caller, selected tenant) when one is active. */
  membership: SelectedTenantMembershipRow | null;
  /** Staff capability row, when the caller is a staff identity. */
  staffPagePermission: StaffPagePermissionRow | null;
  /** Page key the area requires (staff capability granularity). */
  requiredPage: string;
}

export type TeachingWriteDecision = 'allowed' | 'denied';

const flag = (value: number | boolean | string | null | undefined): boolean =>
  value === true || value === 1 || value === '1';

const parsePages = (value: string | string[] | null | undefined): string[] => {
  if (!value) return [];
  if (typeof value !== 'string') return Array.isArray(value) ? value : [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((page): page is string => typeof page === 'string') : [];
  } catch {
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
export const evaluateTeachingEntitlement = (view: TeachingEntitlementView): TeachingWriteDecision => {
  const { role, selectedTenantId, membership, staffPagePermission, requiredPage } = view;

  if (!selectedTenantId) return 'denied';
  if (!membership) return 'denied';
  if (!flag(membership.user_is_active)) return 'denied';
  if (membership.tenant_status !== 'active') return 'denied';
  if (!TEACHING_MEMBERSHIP_ROLE_KEYS.includes(membership.role_key as typeof TEACHING_MEMBERSHIP_ROLE_KEYS[number])) {
    return 'denied';
  }
  if (!flag(membership.tenant_legacy_compat) && !flag(membership.subscription_entitles)) return 'denied';

  if (role === 'staff') {
    if (!staffPagePermission || !flag(staffPagePermission.is_active)) return 'denied';
    if (!parsePages(staffPagePermission.accessible_pages).includes(requiredPage)) return 'denied';
  }

  return 'allowed';
};

/**
 * Build the teaching-write guard over an injected repository. Production
 * uses the default SQL repository; hermetic tests inject fixtures.
 *
 * Applies to teaching writes, not to student learning reads. Membership in
 * the selected tenant, its subscription/grace policy, and staff page
 * capabilities are all resolved from server-side rows; a client-supplied
 * tenant selector is never trusted (auth resolves the selection first).
 */
export const createRequireTeachingWrite = (
  area: keyof typeof pageForArea,
  repository: TeachingAccessRepository = defaultTeachingAccessRepository,
) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
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
      const decision = evaluateTeachingEntitlement({
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
    } catch (error) {
      console.error('Teaching entitlement check failed:', error);
      return res.status(503).json({ error: 'Teaching entitlement unavailable' });
    }
  };

/** Production wiring; route callsites keep the exact same signature. */
export const requireTeachingWrite = (area: keyof typeof pageForArea) =>
  createRequireTeachingWrite(area);
