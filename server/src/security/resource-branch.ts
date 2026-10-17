/**
 * Resource-derived branch authorization (S1 resource contract).
 *
 * Branch authority is NEVER taken from a caller selector. It is derived from
 * the trusted resource/parent chain that the server itself wrote:
 *
 *   group            -> groups.branch_id / groups.branch_scope
 *   lecture          -> lectures.group_id -> groups
 *   material         -> material_groups -> groups (all links must agree)
 *   exam             -> exam_groups -> groups (all links must agree)
 *   premium lecture  -> premium_lectures.group_id -> groups
 *   attendance       -> attendance.group_id (or the student's group) -> groups
 *   file             -> exam question / premium receipt parent -> groups
 *   video            -> videos.lecture_id / videos.material_id -> groups,
 *                       plus videos.course_id -> courses (tenant-level proof)
 *
 * A resource is one of three explicit states:
 *
 *  - branch:  owned by exactly one branch. The caller must have a live,
 *             version-matched membership in that branch (tenant owners and
 *             verified platform operators keep their narrow explicit path),
 *             and the branch must be active and in the caller's tenant.
 *  - tenant:  explicitly tenant-level (independent instructor / tenant-wide
 *             content). Existing exact-resource permissions still decide; this
 *             module only enforces tenant equality and never invents a branch.
 *  - ambiguous: a branch-scoped row with no branch id, conflicting parent
 *             branch links, an unprovable tenant, or a legacy row whose branch
 *             intent was never recorded. Ambiguous branch ownership is denied
 *             and reported through the audited quarantine workflow; it is
 *             never widened to tenant scope and never guessed.
 *
 * Legacy groups created before the branch model carry `branch_scope =
 * 'unassigned'` (or NULL / an unknown value). Their ownership was never
 * recorded, so they are `ambiguous` and denied like any other unprovable
 * branch row. The `legacyUnclassified` marker is audit metadata only: it is
 * reported by the quarantine workflow and never grants authorization. The
 * pre-existing tenant/exact-resource permissions still decide only for rows
 * that are explicitly classified `tenant`.
 */

import { normalizeBranchId } from './branch-access';

export type ResourceBranchType =
    | 'group'
    | 'lecture'
    | 'material'
    | 'exam'
    | 'premium_lecture'
    | 'attendance'
    | 'file'
    | 'video';

export type ResourceBranchScopeKind = 'branch' | 'tenant' | 'ambiguous';

export interface ResourceBranchScope {
    resourceType: ResourceBranchType;
    resourceId: string;
    /** Tenant proven from server rows; null means the tenant cannot be proven. */
    tenantId: string | null;
    scope: ResourceBranchScopeKind;
    /** Set only when scope === 'branch'. */
    branchId: string | null;
    /** Server-derived owner (instructor/creator), when the row carries one. */
    ownerUserId?: string | null;
    /**
     * Course the parent row belongs to (video parent reconciliation only).
     * Never used as a branch source: a course is explicitly tenant-level.
     */
    courseId?: string | null;
    /** Machine-readable reason when scope === 'ambiguous'. */
    ambiguityReason?: string;
    /**
     * Audit-only marker for a legacy `unassigned`/unknown group. It is
     * reported by the quarantine workflow and never grants access; the
     * scope itself is `ambiguous` and denied.
     */
    legacyUnclassified?: boolean;
}

export interface ResourceBranchRow {
    id: string;
    tenant_id: string;
    status: string;
    version: number;
}

export interface ResourceBranchMembershipRow {
    branch_id: string;
    user_id: string;
    role: string;
    status: string;
    version: number;
}

export interface ResourceBranchDeps {
    /** Loads the trusted parent chain for one resource. Null means not found. */
    loadResourceScope(resourceType: ResourceBranchType, resourceId: string): Promise<ResourceBranchScope | null>;
    findBranch(branchId: string): Promise<ResourceBranchRow | null>;
    findMembership(branchId: string, userId: string): Promise<ResourceBranchMembershipRow | null>;
    isTenantOwner(userId: string, tenantId: string): Promise<boolean>;
    /** Verified platform capability (active super admin or seeded permission). */
    hasPlatformCapability(userId: string): Promise<boolean>;
    /**
     * Optional audit sink for denied ambiguous resources. Production binds the
     * branch audit log; pure tests may omit it.
     */
    recordAmbiguity?(scope: ResourceBranchScope, principal: ResourceBranchPrincipal): Promise<void>;
}

export interface ResourceBranchPrincipal {
    userId: string;
    /** Server-derived selected tenant from the auth middleware. */
    tenantId: string | null;
    role: string;
    /** Live branch context bound to the token, when the token was branch-scoped. */
    scopedBranchId?: string | null;
    /** Membership version minted into a branch-scoped token. */
    scopedBranchMembershipVersion?: number | null;
}

export interface ResourceBranchRequest {
    resourceType: ResourceBranchType;
    resourceId: string;
    /**
     * A caller-supplied selector. It is a request only: for a branch resource
     * it must equal the derived branch, and it is always rejected for a
     * tenant-level resource (there is no branch to select).
     */
    requestedBranchId?: unknown;
}

export type ResourceBranchDenialReason =
    | 'resource-not-found'
    | 'resource-tenant-unprovable'
    | 'resource-cross-tenant'
    | 'resource-branch-ambiguous'
    | 'malformed-branch-id'
    | 'branch-context-mismatch'
    | 'branch-not-found'
    | 'branch-cross-tenant'
    | 'branch-not-active'
    | 'membership-missing'
    | 'membership-not-active'
    | 'membership-version-mismatch'
    | 'tenant-scope-required';

export type ResourceBranchDecision =
    | {
        kind: 'allowed';
        scope: 'branch' | 'tenant';
        branchId: string | null;
        membershipRole: string | null;
        membershipVersion: number | null;
        legacyUnclassified: boolean;
    }
    | { kind: 'denied'; reason: ResourceBranchDenialReason }
    | { kind: 'ambiguous'; reason: string; scope: ResourceBranchScope };

const normalizeVersion = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const tenantOf = (scope: ResourceBranchScope): string | null =>
    typeof scope.tenantId === 'string' && scope.tenantId.length > 0 ? scope.tenantId : null;

/**
 * Resolve whether the verified principal may act on one resource. Pure
 * authority decision: handlers translate a denial into their existing generic
 * 403/404 boundary. Any dependency/database failure propagates so callers fail
 * closed.
 */
export async function resolveResourceBranchAccess(
    deps: ResourceBranchDeps,
    principal: ResourceBranchPrincipal,
    request: ResourceBranchRequest,
): Promise<ResourceBranchDecision> {
    const scope = await deps.loadResourceScope(request.resourceType, request.resourceId);
    if (!scope) return { kind: 'denied', reason: 'resource-not-found' };

    if (scope.scope === 'ambiguous') {
        if (deps.recordAmbiguity) await deps.recordAmbiguity(scope, principal);
        return {
            kind: 'ambiguous',
            reason: scope.ambiguityReason || 'ambiguous-branch-ownership',
            scope,
        };
    }

    const resourceTenantId = tenantOf(scope);

    // A caller selector is never authority. For a branch resource it must name
    // the derived branch; for a tenant resource there is no branch to select.
    const requested = request.requestedBranchId;
    const hasRequested = requested !== undefined && requested !== null && requested !== '';
    const requestedBranchId = hasRequested ? normalizeBranchId(requested) : null;
    if (hasRequested && requestedBranchId === null) {
        return { kind: 'denied', reason: 'malformed-branch-id' };
    }

    if (scope.scope === 'tenant') {
        if (hasRequested) {
            // Selecting a branch on an explicitly tenant-level resource is a
            // context mismatch, never a way to narrow or widen authority.
            return { kind: 'denied', reason: 'branch-context-mismatch' };
        }
        // "Tenant-level" is only a decision when the tenant itself is proven
        // from a server row. An unprovable tenant is denied, never widened.
        if (!resourceTenantId) {
            return { kind: 'denied', reason: 'resource-tenant-unprovable' };
        }
        // Tenant equality for a tenant-level resource is enforced by the
        // resource route's existing exact-resource predicate (the same
        // predicate that already scopes every list/read/write). This module
        // never invents a branch for it and never widens it.
        return {
            kind: 'allowed',
            scope: 'tenant',
            branchId: null,
            membershipRole: null,
            membershipVersion: null,
            legacyUnclassified: Boolean(scope.legacyUnclassified),
        };
    }

    // scope === 'branch'
    if (!resourceTenantId) {
        if (deps.recordAmbiguity) await deps.recordAmbiguity(scope, principal);
        return { kind: 'denied', reason: 'resource-tenant-unprovable' };
    }

    const platform = await deps.hasPlatformCapability(principal.userId);
    const tenantMatches = principal.tenantId !== null && principal.tenantId === resourceTenantId;
    if (!tenantMatches && !platform) {
        // A cross-tenant branch resource is indistinguishable from a missing one.
        return { kind: 'denied', reason: 'resource-cross-tenant' };
    }

    if (!scope.branchId) {
        if (deps.recordAmbiguity) await deps.recordAmbiguity(scope, principal);
        return { kind: 'ambiguous', reason: 'branch-scope-without-branch', scope };
    }

    if (hasRequested && requestedBranchId !== scope.branchId) {
        return { kind: 'denied', reason: 'branch-context-mismatch' };
    }

    if (principal.scopedBranchId) {
        const scoped = normalizeBranchId(principal.scopedBranchId);
        if (scoped === null || scoped !== scope.branchId) {
            return { kind: 'denied', reason: 'branch-context-mismatch' };
        }
    }

    const branch = await deps.findBranch(scope.branchId);
    if (!branch) return { kind: 'denied', reason: 'branch-not-found' };
    if (branch.tenant_id !== resourceTenantId) return { kind: 'denied', reason: 'branch-cross-tenant' };
    if (branch.status !== 'active') return { kind: 'denied', reason: 'branch-not-active' };

    const expectedVersion = principal.scopedBranchId
        ? normalizeVersion(principal.scopedBranchMembershipVersion)
        : null;

    if (platform) {
        return {
            kind: 'allowed',
            scope: 'branch',
            branchId: scope.branchId,
            membershipRole: 'platform',
            membershipVersion: branch.version,
            legacyUnclassified: false,
        };
    }

    const isOwner = await deps.isTenantOwner(principal.userId, resourceTenantId);
    const membership = await deps.findMembership(scope.branchId, principal.userId);

    if (isOwner) {
        // Narrow owner path: only inside the owner's own tenant, and a
        // revoked/version-mismatched membership still denies.
        if (membership && membership.status !== 'active') {
            return { kind: 'denied', reason: 'membership-not-active' };
        }
        if (membership && expectedVersion !== null && membership.version !== expectedVersion) {
            return { kind: 'denied', reason: 'membership-version-mismatch' };
        }
        return {
            kind: 'allowed',
            scope: 'branch',
            branchId: scope.branchId,
            membershipRole: 'owner',
            membershipVersion: membership ? membership.version : branch.version,
            legacyUnclassified: false,
        };
    }

    if (!membership) return { kind: 'denied', reason: 'membership-missing' };
    if (membership.status !== 'active') return { kind: 'denied', reason: 'membership-not-active' };
    if (expectedVersion !== null && membership.version !== expectedVersion) {
        return { kind: 'denied', reason: 'membership-version-mismatch' };
    }

    return {
        kind: 'allowed',
        scope: 'branch',
        branchId: scope.branchId,
        membershipRole: membership.role,
        membershipVersion: membership.version,
        legacyUnclassified: false,
    };
}

/**
 * Translate a decision into the generic response shape used by the resource
 * routes. Missing / cross-tenant / membership denials are 404 so the caller
 * cannot enumerate resources; ambiguous and context mismatches are 403.
 */
export function resourceBranchDenial(
    decision: Exclude<ResourceBranchDecision, { kind: 'allowed' }>,
): { status: number; body: { error: string; code?: string } } {
    if (decision.kind === 'ambiguous') {
        return {
            status: 403,
            body: { error: 'Resource branch context is ambiguous', code: 'BRANCH_CONTEXT_AMBIGUOUS' },
        };
    }
    switch (decision.reason) {
        case 'resource-branch-ambiguous':
        case 'resource-tenant-unprovable':
        case 'malformed-branch-id':
        case 'branch-context-mismatch':
            return {
                status: 403,
                body: { error: 'Forbidden', code: 'BRANCH_CONTEXT_DENIED' },
            };
        case 'branch-not-active':
        case 'membership-not-active':
        case 'membership-version-mismatch':
            return {
                status: 403,
                body: { error: 'Forbidden', code: 'BRANCH_ACCESS_REVOKED' },
            };
        default:
            return { status: 404, body: { error: 'Resource not found' } };
    }
}

/** Build a principal from the authenticated middleware user. */
export function principalFromAuthUser(user: {
    id: string;
    role: string;
    tenantId?: string | null;
    branchId?: string | null;
    branchMembershipVersion?: number | null;
}): ResourceBranchPrincipal {
    return {
        userId: user.id,
        role: user.role,
        tenantId: user.tenantId ?? null,
        scopedBranchId: user.branchId ?? null,
        scopedBranchMembershipVersion: user.branchMembershipVersion ?? null,
    };
}

/* ------------------------------------------------------------------------- */
/* Production SQL loaders                                                     */
/* ------------------------------------------------------------------------- */

export interface ResourceBranchDb {
    query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
}

interface GroupScopeRow {
    id: string;
    branch_id: string | null;
    branch_scope: string | null;
    instructor_id: string | null;
    tenant_id: string | null;
}

const mapGroupScope = (
    resourceType: ResourceBranchType,
    row: GroupScopeRow,
): ResourceBranchScope => {
    const base = {
        resourceType,
        resourceId: row.id,
        tenantId: row.tenant_id ?? null,
        ownerUserId: row.instructor_id ?? null,
    };
    const scope = (row.branch_scope || '').trim().toLowerCase();
    if (scope === 'branch') {
        if (!row.branch_id) {
            return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'branch-scope-without-branch' };
        }
        return { ...base, scope: 'branch', branchId: row.branch_id };
    }
    if (scope === 'tenant') {
        if (row.branch_id) {
            return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'tenant-scope-with-branch' };
        }
        if (!row.tenant_id) {
            return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'tenant-scope-unprovable' };
        }
        return { ...base, scope: 'tenant', branchId: null };
    }
    if (row.branch_id) {
        return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'unassigned-scope-with-branch' };
    }
    // Legacy / NULL / unknown classification: ownership was never recorded,
    // so it is ambiguous and denied. `legacyUnclassified` is audit-only and
    // never participates in the decision.
    return {
        ...base,
        scope: 'ambiguous',
        branchId: null,
        ambiguityReason: scope === 'unassigned' || scope === '' ? 'legacy-unclassified' : 'unknown-branch-scope',
        legacyUnclassified: true,
    };
};

const GROUP_TENANT_SQL = `
    SELECT g.id, g.branch_id, g.branch_scope, g.instructor_id,
           COALESCE(
             c.tenant_id,
             CASE WHEN c.id IS NULL THEN (
               SELECT t.id FROM tenants t
               WHERE t.owner_user_id = g.instructor_id AND t.status = 'active'
               ORDER BY t.created_at LIMIT 1
             ) END
           ) AS tenant_id
    FROM \`groups\` g
    LEFT JOIN courses c ON c.id = g.course_id
    WHERE g.id = ?
`;

const LECTURE_SQL = `
    SELECT l.id, l.group_id, l.course_id, l.instructor_id, c.tenant_id,
           g.branch_id, g.branch_scope, g.course_id AS group_course_id
    FROM lectures l
    INNER JOIN courses c ON c.id = l.course_id
    LEFT JOIN \`groups\` g ON g.id = l.group_id
    WHERE l.id = ?
`;

const MATERIAL_SQL = `
    SELECT cm.id, cm.course_id, c.tenant_id
    FROM course_materials cm
    LEFT JOIN courses c ON c.id = cm.course_id
    WHERE cm.id = ?
`;

const MATERIAL_LINKS_SQL = `
    SELECT mg.group_id, g.id AS resolved_group_id, g.branch_id, g.branch_scope,
           g.instructor_id, g.course_id AS group_course_id, c.tenant_id
    FROM material_groups mg
    LEFT JOIN \`groups\` g ON g.id = mg.group_id
    LEFT JOIN courses c ON c.id = g.course_id
    WHERE mg.material_id = ?
`;

const EXAM_SQL = `
    SELECT e.id, e.course_id, c.tenant_id
    FROM exams e
    LEFT JOIN courses c ON c.id = e.course_id
    WHERE e.id = ?
`;

const EXAM_LINKS_SQL = `
    SELECT eg.group_id, g.id AS resolved_group_id, g.branch_id, g.branch_scope,
           g.instructor_id, g.course_id AS group_course_id, c.tenant_id
    FROM exam_groups eg
    LEFT JOIN \`groups\` g ON g.id = eg.group_id
    LEFT JOIN courses c ON c.id = g.course_id
    WHERE eg.exam_id = ?
`;

const PREMIUM_SQL = `
    SELECT pl.id, pl.group_id, g.branch_id, g.branch_scope, g.instructor_id,
           COALESCE(c.tenant_id, (
             SELECT t.id FROM tenants t
             WHERE t.owner_user_id = g.instructor_id AND t.status = 'active'
             ORDER BY t.created_at LIMIT 1
           )) AS tenant_id
    FROM premium_lectures pl
    LEFT JOIN \`groups\` g ON g.id = pl.group_id
    LEFT JOIN courses c ON c.id = g.course_id
    WHERE pl.id = ?
`;

const ATTENDANCE_SQL = `
    SELECT a.id, a.group_id, a.course_id, s.tenant_id AS student_tenant_id,
           g.branch_id, g.branch_scope, g.instructor_id,
           c.tenant_id AS course_tenant_id
    FROM attendance a
    LEFT JOIN students s ON s.id = a.student_id
    LEFT JOIN \`groups\` g ON g.id = COALESCE(a.group_id, s.group_id)
    LEFT JOIN courses c ON c.id = a.course_id
    WHERE a.id = ?
`;

const FILE_SQL = `
    SELECT f.id, f.tenant_id
    FROM tenant_media_files f
    WHERE f.id = ?
`;

const FILE_BRANCH_LINKS_SQL = `
    SELECT x.group_id, g.id AS resolved_group_id, g.branch_id, g.branch_scope,
           g.instructor_id, g.course_id AS group_course_id, c.tenant_id
    FROM (
        SELECT eg.group_id
        FROM exam_questions q
        INNER JOIN exam_groups eg ON eg.exam_id = q.exam_id
        WHERE q.question_image = CONCAT('/api/files/', ?, '/download')
        UNION
        SELECT pl.group_id
        FROM premium_lecture_payments p
        INNER JOIN premium_lectures pl ON pl.id = p.premium_lecture_id
        WHERE p.receipt_image_url = CONCAT('/api/files/', ?, '/download')
    ) x
    LEFT JOIN \`groups\` g ON g.id = x.group_id
    LEFT JOIN courses c ON c.id = g.course_id
`;

const VIDEO_SQL = `
    SELECT v.id, v.lecture_id, v.material_id, v.course_id,
           v.tenant_id AS video_tenant_id,
           c.id AS course_row_id, c.tenant_id AS course_tenant_id
    FROM videos v
    LEFT JOIN courses c ON c.id = v.course_id
    WHERE v.id = ?
`;

/**
 * Reconcile zero, one, or many parent links to one branch scope. Conflicting
 * branch links are ambiguous, never resolved by picking one. A link whose
 * group belongs to a different course than the parent row is incompatible
 * provenance and is ambiguous too.
 */
const reconcileLinks = (
    resourceType: ResourceBranchType,
    resourceId: string,
    fallbackTenantId: string | null,
    links: Array<{
        group_id: string | null;
        resolved_group_id: string | null;
        branch_id: string | null;
        branch_scope: string | null;
        instructor_id: string | null;
        group_course_id?: string | null;
        tenant_id: string | null;
    }>,
    expectedCourseId: string | null = null,
): ResourceBranchScope => {
    const base = { resourceType, resourceId, ownerUserId: null as string | null, courseId: expectedCourseId };
    if (links.length === 0) {
        // No parent link at all: tenant-level only when the parent row itself
        // proves its tenant. Otherwise ownership is unprovable and denied.
        if (!fallbackTenantId) {
            return { ...base, tenantId: null, scope: 'ambiguous', branchId: null, ambiguityReason: 'tenant-unprovable' };
        }
        return { ...base, tenantId: fallbackTenantId, scope: 'tenant', branchId: null };
    }

    const branches = new Set<string>();
    for (const link of links) {
        if (!link.resolved_group_id) {
            return { ...base, tenantId: fallbackTenantId, scope: 'ambiguous', branchId: null, ambiguityReason: 'missing-parent-group' };
        }
        if (expectedCourseId && link.group_course_id && link.group_course_id !== expectedCourseId) {
            return { ...base, tenantId: fallbackTenantId, scope: 'ambiguous', branchId: null, ambiguityReason: 'group-course-mismatch' };
        }
        const mapped = mapGroupScope(resourceType, {
            id: link.resolved_group_id,
            branch_id: link.branch_id,
            branch_scope: link.branch_scope,
            instructor_id: link.instructor_id,
            tenant_id: link.tenant_id ?? fallbackTenantId,
        });
        if (mapped.scope === 'ambiguous') {
            return { ...base, tenantId: mapped.tenantId, scope: 'ambiguous', branchId: null, ambiguityReason: mapped.ambiguityReason };
        }
        if (mapped.scope === 'branch' && mapped.branchId) branches.add(mapped.branchId);
        if (!base.ownerUserId && mapped.ownerUserId) base.ownerUserId = mapped.ownerUserId;
    }

    if (branches.size > 1) {
        return { ...base, tenantId: fallbackTenantId, scope: 'ambiguous', branchId: null, ambiguityReason: 'conflicting-branch-links' };
    }
    if (branches.size === 1) {
        return { ...base, tenantId: fallbackTenantId, scope: 'branch', branchId: [...branches][0] };
    }
    return { ...base, tenantId: fallbackTenantId, scope: 'tenant', branchId: null };
};

/**
 * Production resource-scope loaders. All trusted relations are read from
 * server-written columns; no request field participates in the decision.
 */
export function createSqlResourceScopeLoader(db: ResourceBranchDb) {
    const loadGroup = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<GroupScopeRow>(GROUP_TENANT_SQL, [id]);
        return row ? mapGroupScope('group', row) : null;
    };

    const loadLecture = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{
            id: string; group_id: string | null; course_id: string | null; instructor_id: string | null;
            tenant_id: string | null; branch_id: string | null; branch_scope: string | null;
            group_course_id: string | null;
        }>(LECTURE_SQL, [id]);
        if (!row) return null;
        const base = {
            resourceType: 'lecture' as const, resourceId: row.id, tenantId: row.tenant_id,
            ownerUserId: row.instructor_id, courseId: row.course_id ?? null,
        };
        if (!row.group_id) {
            if (!row.tenant_id) {
                return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'lecture-tenant-unprovable' };
            }
            return { ...base, scope: 'tenant', branchId: null };
        }
        if (row.group_course_id && row.course_id && row.group_course_id !== row.course_id) {
            return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'group-course-mismatch' };
        }
        if (!row.branch_scope) {
            return { ...base, scope: 'ambiguous', branchId: null, ambiguityReason: 'missing-parent-group' };
        }
        const mapped = mapGroupScope('lecture', {
            id: row.id, branch_id: row.branch_id, branch_scope: row.branch_scope,
            instructor_id: row.instructor_id, tenant_id: row.tenant_id,
        });
        return { ...mapped, resourceId: row.id, ownerUserId: row.instructor_id, courseId: row.course_id ?? null };
    };

    const loadMaterial = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{ id: string; course_id: string | null; tenant_id: string | null }>(MATERIAL_SQL, [id]);
        if (!row) return null;
        const links = await db.query<any>(MATERIAL_LINKS_SQL, [id]);
        return reconcileLinks('material', row.id, row.tenant_id, links, row.course_id ?? null);
    };

    const loadExam = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{ id: string; course_id: string | null; tenant_id: string | null }>(EXAM_SQL, [id]);
        if (!row) return null;
        const links = await db.query<any>(EXAM_LINKS_SQL, [id]);
        return reconcileLinks('exam', row.id, row.tenant_id, links, row.course_id ?? null);
    };

    const loadPremium = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{
            id: string; group_id: string | null; branch_id: string | null;
            branch_scope: string | null; instructor_id: string | null; tenant_id: string | null;
        }>(PREMIUM_SQL, [id]);
        if (!row) return null;
        if (!row.group_id) {
            return {
                resourceType: 'premium_lecture', resourceId: row.id, tenantId: row.tenant_id,
                scope: 'ambiguous', branchId: null, ownerUserId: row.instructor_id,
                ambiguityReason: 'premium-lecture-without-group',
            };
        }
        const mapped = mapGroupScope('premium_lecture', {
            id: row.id, branch_id: row.branch_id, branch_scope: row.branch_scope,
            instructor_id: row.instructor_id, tenant_id: row.tenant_id,
        });
        return { ...mapped, resourceId: row.id, ownerUserId: row.instructor_id };
    };

    const loadAttendance = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{
            id: string; group_id: string | null; course_id: string | null;
            student_tenant_id: string | null; branch_id: string | null;
            branch_scope: string | null; instructor_id: string | null;
            course_tenant_id: string | null;
        }>(ATTENDANCE_SQL, [id]);
        if (!row) return null;
        const tenantId = row.course_tenant_id ?? row.student_tenant_id ?? null;
        if (!row.group_id) {
            if (!tenantId) {
                return {
                    resourceType: 'attendance', resourceId: row.id, tenantId: null,
                    scope: 'ambiguous', branchId: null, ownerUserId: row.instructor_id,
                    ambiguityReason: 'attendance-tenant-unprovable',
                };
            }
            return {
                resourceType: 'attendance', resourceId: row.id, tenantId,
                scope: 'tenant', branchId: null, ownerUserId: row.instructor_id,
            };
        }
        const mapped = mapGroupScope('attendance', {
            id: row.id, branch_id: row.branch_id, branch_scope: row.branch_scope,
            instructor_id: row.instructor_id, tenant_id: tenantId,
        });
        return { ...mapped, resourceId: row.id, ownerUserId: row.instructor_id };
    };

    const loadFile = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{ id: string; tenant_id: string | null }>(FILE_SQL, [id]);
        if (!row) return null;
        const links = await db.query<any>(FILE_BRANCH_LINKS_SQL, [id, id]);
        return reconcileLinks('file', row.id, row.tenant_id, links);
    };

    const loadVideo = async (id: string): Promise<ResourceBranchScope | null> => {
        const row = await db.queryOne<{
            id: string; lecture_id: string | null; material_id: string | null;
            course_id: string | null; video_tenant_id: string | null;
            course_row_id: string | null; course_tenant_id: string | null;
        }>(VIDEO_SQL, [id]);
        if (!row) return null;

        const base = { resourceType: 'video' as const, resourceId: row.id, ownerUserId: null as string | null };
        const ambiguous = (
            reason: string,
            tenantId: string | null = row.course_tenant_id ?? row.video_tenant_id ?? null,
        ): ResourceBranchScope => ({ ...base, tenantId, scope: 'ambiguous', branchId: null, ambiguityReason: reason });

        const tenants = new Set<string>();
        const branches = new Set<string>();
        const courseIds = new Set<string>();
        let resolvedParents = 0;

        // The course is an explicit TENANT-LEVEL parent. It is validated
        // against the server courses row but never expanded through
        // `groups.course_id` (a course is shared by many branch groups, so
        // that relation cannot prove a single branch).
        if (row.course_id) {
            if (!row.course_row_id) return ambiguous('dangling-course-parent');
            if (!row.course_tenant_id) return ambiguous('course-tenant-unprovable');
            tenants.add(row.course_tenant_id);
            courseIds.add(row.course_id);
            resolvedParents += 1;
        }

        // Every PRESENT parent must resolve. A dangling parent is ambiguous
        // even when another parent is valid: there is no dangling-FK fallback.
        if (row.lecture_id) {
            const lecture = await loadLecture(row.lecture_id);
            if (!lecture) return ambiguous('dangling-lecture-parent');
            if (lecture.scope === 'ambiguous') {
                return ambiguous(lecture.ambiguityReason || 'lecture-parent-ambiguous', lecture.tenantId);
            }
            if (!lecture.tenantId) return ambiguous('lecture-tenant-unprovable');
            tenants.add(lecture.tenantId);
            if (lecture.courseId) courseIds.add(lecture.courseId);
            if (lecture.scope === 'branch') {
                if (!lecture.branchId) return ambiguous('lecture-branch-unprovable');
                branches.add(lecture.branchId);
            }
            resolvedParents += 1;
        }

        if (row.material_id) {
            const material = await loadMaterial(row.material_id);
            if (!material) return ambiguous('dangling-material-parent');
            if (material.scope === 'ambiguous') {
                return ambiguous(material.ambiguityReason || 'material-parent-ambiguous', material.tenantId);
            }
            if (!material.tenantId) return ambiguous('material-tenant-unprovable');
            tenants.add(material.tenantId);
            if (material.courseId) courseIds.add(material.courseId);
            if (material.scope === 'branch') {
                if (!material.branchId) return ambiguous('material-branch-unprovable');
                branches.add(material.branchId);
            }
            resolvedParents += 1;
        }

        // The upload tenant is provenance too: it must agree with every
        // parent, otherwise the row is inconsistent and denied.
        if (row.video_tenant_id) tenants.add(row.video_tenant_id);

        if (courseIds.size > 1) return ambiguous('conflicting-course-provenance');
        if (tenants.size > 1) return ambiguous('conflicting-parent-tenant');
        if (branches.size > 1) return ambiguous('conflicting-branch-links');

        // No lecture/material/course context at all: there is no server
        // relation proving a tenant-level audience, so this is denied rather
        // than widened to the uploader's tenant.
        if (resolvedParents === 0) return ambiguous('video-without-context');

        const tenantId = [...tenants][0] ?? null;
        if (branches.size === 1) {
            return { ...base, tenantId, scope: 'branch', branchId: [...branches][0] };
        }
        if (!tenantId) return ambiguous('video-tenant-unprovable');
        // Only explicit tenant-level parents (course and/or group-less
        // lecture/material) resolved: the exact-resource policy still decides.
        return { ...base, tenantId, scope: 'tenant', branchId: null };
    };

    return async (resourceType: ResourceBranchType, resourceId: string): Promise<ResourceBranchScope | null> => {
        switch (resourceType) {
            case 'group': return loadGroup(resourceId);
            case 'lecture': return loadLecture(resourceId);
            case 'material': return loadMaterial(resourceId);
            case 'exam': return loadExam(resourceId);
            case 'premium_lecture': return loadPremium(resourceId);
            case 'attendance': return loadAttendance(resourceId);
            case 'file': return loadFile(resourceId);
            case 'video': return loadVideo(resourceId);
            default: return null;
        }
    };
}

/**
 * Production deps. The db module is loaded lazily so importing this module
 * never creates a pool or reads environment configuration.
 */
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

let cachedDeps: ResourceBranchDeps | null = null;

export function getResourceBranchDeps(): ResourceBranchDeps {
    if (cachedDeps) return cachedDeps;
    cachedDeps = {
        loadResourceScope: async (type, id) => {
            const { query, queryOne } = await loadDb();
            return createSqlResourceScopeLoader({ query, queryOne })(type, id);
        },
        findBranch: async (branchId) => {
            const { queryOne } = await loadDb();
            return queryOne<ResourceBranchRow>(
                'SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1',
                [branchId],
            );
        },
        findMembership: async (branchId, userId) => {
            const { queryOne } = await loadDb();
            return queryOne<ResourceBranchMembershipRow>(
                'SELECT branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1',
                [branchId, userId],
            );
        },
        isTenantOwner: async (userId, tenantId) => {
            const { queryOne } = await loadDb();
            const row = await queryOne<{ id: string }>(
                "SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1",
                [tenantId, userId],
            );
            return Boolean(row);
        },
        hasPlatformCapability: async (userId) => {
            const { isSuperAdmin, getAdminPermissions } = await import('./admin-permissions');
            if (await isSuperAdmin(userId)) return true;
            return (await getAdminPermissions(userId)).includes('security.manage');
        },
        recordAmbiguity: async (scope, principal) => {
            const { queryOne, execute } = await loadDb();
            const { randomUUID } = await import('crypto');
            // Audit only; no data is moved or assigned.
            await execute(
                `INSERT INTO branch_audit_log
                   (id, tenant_id, branch_id, actor_user_id, action, resource_type, resource_id, detail)
                 VALUES (?, ?, ?, ?, 'quarantine.detected', ?, ?, ?)`,
                [
                    randomUUID(),
                    scope.tenantId,
                    scope.branchId,
                    principal.userId,
                    scope.resourceType,
                    scope.resourceId,
                    JSON.stringify({ reason: scope.ambiguityReason || 'ambiguous', scope: scope.scope }),
                ],
            );
        },
    };
    return cachedDeps;
}
