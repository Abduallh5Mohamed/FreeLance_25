"use strict";
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
exports.resolveResourceBranchAccess = resolveResourceBranchAccess;
exports.resourceBranchDenial = resourceBranchDenial;
exports.principalFromAuthUser = principalFromAuthUser;
exports.createSqlResourceScopeLoader = createSqlResourceScopeLoader;
exports.getResourceBranchDeps = getResourceBranchDeps;
const branch_access_1 = require("./branch-access");
const normalizeVersion = (value) => {
    if (value === undefined || value === null)
        return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};
const tenantOf = (scope) => typeof scope.tenantId === 'string' && scope.tenantId.length > 0 ? scope.tenantId : null;
/**
 * Resolve whether the verified principal may act on one resource. Pure
 * authority decision: handlers translate a denial into their existing generic
 * 403/404 boundary. Any dependency/database failure propagates so callers fail
 * closed.
 */
async function resolveResourceBranchAccess(deps, principal, request) {
    const scope = await deps.loadResourceScope(request.resourceType, request.resourceId);
    if (!scope)
        return { kind: 'denied', reason: 'resource-not-found' };
    if (scope.scope === 'ambiguous') {
        if (deps.recordAmbiguity)
            await deps.recordAmbiguity(scope, principal);
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
    const requestedBranchId = hasRequested ? (0, branch_access_1.normalizeBranchId)(requested) : null;
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
        if (deps.recordAmbiguity)
            await deps.recordAmbiguity(scope, principal);
        return { kind: 'denied', reason: 'resource-tenant-unprovable' };
    }
    const platform = await deps.hasPlatformCapability(principal.userId);
    const tenantMatches = principal.tenantId !== null && principal.tenantId === resourceTenantId;
    if (!tenantMatches && !platform) {
        // A cross-tenant branch resource is indistinguishable from a missing one.
        return { kind: 'denied', reason: 'resource-cross-tenant' };
    }
    if (!scope.branchId) {
        if (deps.recordAmbiguity)
            await deps.recordAmbiguity(scope, principal);
        return { kind: 'ambiguous', reason: 'branch-scope-without-branch', scope };
    }
    if (hasRequested && requestedBranchId !== scope.branchId) {
        return { kind: 'denied', reason: 'branch-context-mismatch' };
    }
    if (principal.scopedBranchId) {
        const scoped = (0, branch_access_1.normalizeBranchId)(principal.scopedBranchId);
        if (scoped === null || scoped !== scope.branchId) {
            return { kind: 'denied', reason: 'branch-context-mismatch' };
        }
    }
    const branch = await deps.findBranch(scope.branchId);
    if (!branch)
        return { kind: 'denied', reason: 'branch-not-found' };
    if (branch.tenant_id !== resourceTenantId)
        return { kind: 'denied', reason: 'branch-cross-tenant' };
    if (branch.status !== 'active')
        return { kind: 'denied', reason: 'branch-not-active' };
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
    if (!membership)
        return { kind: 'denied', reason: 'membership-missing' };
    if (membership.status !== 'active')
        return { kind: 'denied', reason: 'membership-not-active' };
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
function resourceBranchDenial(decision) {
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
function principalFromAuthUser(user) {
    return {
        userId: user.id,
        role: user.role,
        tenantId: user.tenantId ?? null,
        scopedBranchId: user.branchId ?? null,
        scopedBranchMembershipVersion: user.branchMembershipVersion ?? null,
    };
}
const mapGroupScope = (resourceType, row) => {
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
const reconcileLinks = (resourceType, resourceId, fallbackTenantId, links, expectedCourseId = null) => {
    const base = { resourceType, resourceId, ownerUserId: null, courseId: expectedCourseId };
    if (links.length === 0) {
        // No parent link at all: tenant-level only when the parent row itself
        // proves its tenant. Otherwise ownership is unprovable and denied.
        if (!fallbackTenantId) {
            return { ...base, tenantId: null, scope: 'ambiguous', branchId: null, ambiguityReason: 'tenant-unprovable' };
        }
        return { ...base, tenantId: fallbackTenantId, scope: 'tenant', branchId: null };
    }
    const branches = new Set();
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
        if (mapped.scope === 'branch' && mapped.branchId)
            branches.add(mapped.branchId);
        if (!base.ownerUserId && mapped.ownerUserId)
            base.ownerUserId = mapped.ownerUserId;
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
function createSqlResourceScopeLoader(db) {
    const loadGroup = async (id) => {
        const row = await db.queryOne(GROUP_TENANT_SQL, [id]);
        return row ? mapGroupScope('group', row) : null;
    };
    const loadLecture = async (id) => {
        const row = await db.queryOne(LECTURE_SQL, [id]);
        if (!row)
            return null;
        const base = {
            resourceType: 'lecture', resourceId: row.id, tenantId: row.tenant_id,
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
    const loadMaterial = async (id) => {
        const row = await db.queryOne(MATERIAL_SQL, [id]);
        if (!row)
            return null;
        const links = await db.query(MATERIAL_LINKS_SQL, [id]);
        return reconcileLinks('material', row.id, row.tenant_id, links, row.course_id ?? null);
    };
    const loadExam = async (id) => {
        const row = await db.queryOne(EXAM_SQL, [id]);
        if (!row)
            return null;
        const links = await db.query(EXAM_LINKS_SQL, [id]);
        return reconcileLinks('exam', row.id, row.tenant_id, links, row.course_id ?? null);
    };
    const loadPremium = async (id) => {
        const row = await db.queryOne(PREMIUM_SQL, [id]);
        if (!row)
            return null;
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
    const loadAttendance = async (id) => {
        const row = await db.queryOne(ATTENDANCE_SQL, [id]);
        if (!row)
            return null;
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
    const loadFile = async (id) => {
        const row = await db.queryOne(FILE_SQL, [id]);
        if (!row)
            return null;
        const links = await db.query(FILE_BRANCH_LINKS_SQL, [id, id]);
        return reconcileLinks('file', row.id, row.tenant_id, links);
    };
    const loadVideo = async (id) => {
        const row = await db.queryOne(VIDEO_SQL, [id]);
        if (!row)
            return null;
        const base = { resourceType: 'video', resourceId: row.id, ownerUserId: null };
        const ambiguous = (reason, tenantId = row.course_tenant_id ?? row.video_tenant_id ?? null) => ({ ...base, tenantId, scope: 'ambiguous', branchId: null, ambiguityReason: reason });
        const tenants = new Set();
        const branches = new Set();
        const courseIds = new Set();
        let resolvedParents = 0;
        // The course is an explicit TENANT-LEVEL parent. It is validated
        // against the server courses row but never expanded through
        // `groups.course_id` (a course is shared by many branch groups, so
        // that relation cannot prove a single branch).
        if (row.course_id) {
            if (!row.course_row_id)
                return ambiguous('dangling-course-parent');
            if (!row.course_tenant_id)
                return ambiguous('course-tenant-unprovable');
            tenants.add(row.course_tenant_id);
            courseIds.add(row.course_id);
            resolvedParents += 1;
        }
        // Every PRESENT parent must resolve. A dangling parent is ambiguous
        // even when another parent is valid: there is no dangling-FK fallback.
        if (row.lecture_id) {
            const lecture = await loadLecture(row.lecture_id);
            if (!lecture)
                return ambiguous('dangling-lecture-parent');
            if (lecture.scope === 'ambiguous') {
                return ambiguous(lecture.ambiguityReason || 'lecture-parent-ambiguous', lecture.tenantId);
            }
            if (!lecture.tenantId)
                return ambiguous('lecture-tenant-unprovable');
            tenants.add(lecture.tenantId);
            if (lecture.courseId)
                courseIds.add(lecture.courseId);
            if (lecture.scope === 'branch') {
                if (!lecture.branchId)
                    return ambiguous('lecture-branch-unprovable');
                branches.add(lecture.branchId);
            }
            resolvedParents += 1;
        }
        if (row.material_id) {
            const material = await loadMaterial(row.material_id);
            if (!material)
                return ambiguous('dangling-material-parent');
            if (material.scope === 'ambiguous') {
                return ambiguous(material.ambiguityReason || 'material-parent-ambiguous', material.tenantId);
            }
            if (!material.tenantId)
                return ambiguous('material-tenant-unprovable');
            tenants.add(material.tenantId);
            if (material.courseId)
                courseIds.add(material.courseId);
            if (material.scope === 'branch') {
                if (!material.branchId)
                    return ambiguous('material-branch-unprovable');
                branches.add(material.branchId);
            }
            resolvedParents += 1;
        }
        // The upload tenant is provenance too: it must agree with every
        // parent, otherwise the row is inconsistent and denied.
        if (row.video_tenant_id)
            tenants.add(row.video_tenant_id);
        if (courseIds.size > 1)
            return ambiguous('conflicting-course-provenance');
        if (tenants.size > 1)
            return ambiguous('conflicting-parent-tenant');
        if (branches.size > 1)
            return ambiguous('conflicting-branch-links');
        // No lecture/material/course context at all: there is no server
        // relation proving a tenant-level audience, so this is denied rather
        // than widened to the uploader's tenant.
        if (resolvedParents === 0)
            return ambiguous('video-without-context');
        const tenantId = [...tenants][0] ?? null;
        if (branches.size === 1) {
            return { ...base, tenantId, scope: 'branch', branchId: [...branches][0] };
        }
        if (!tenantId)
            return ambiguous('video-tenant-unprovable');
        // Only explicit tenant-level parents (course and/or group-less
        // lecture/material) resolved: the exact-resource policy still decides.
        return { ...base, tenantId, scope: 'tenant', branchId: null };
    };
    return async (resourceType, resourceId) => {
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
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
let cachedDeps = null;
function getResourceBranchDeps() {
    if (cachedDeps)
        return cachedDeps;
    cachedDeps = {
        loadResourceScope: async (type, id) => {
            const { query, queryOne } = await loadDb();
            return createSqlResourceScopeLoader({ query, queryOne })(type, id);
        },
        findBranch: async (branchId) => {
            const { queryOne } = await loadDb();
            return queryOne('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]);
        },
        findMembership: async (branchId, userId) => {
            const { queryOne } = await loadDb();
            return queryOne('SELECT branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]);
        },
        isTenantOwner: async (userId, tenantId) => {
            const { queryOne } = await loadDb();
            const row = await queryOne("SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1", [tenantId, userId]);
            return Boolean(row);
        },
        hasPlatformCapability: async (userId) => {
            const { isSuperAdmin, getAdminPermissions } = await Promise.resolve().then(() => __importStar(require('./admin-permissions')));
            if (await isSuperAdmin(userId))
                return true;
            return (await getAdminPermissions(userId)).includes('security.manage');
        },
        recordAmbiguity: async (scope, principal) => {
            const { queryOne, execute } = await loadDb();
            const { randomUUID } = await Promise.resolve().then(() => __importStar(require('crypto')));
            // Audit only; no data is moved or assigned.
            await execute(`INSERT INTO branch_audit_log
                   (id, tenant_id, branch_id, actor_user_id, action, resource_type, resource_id, detail)
                 VALUES (?, ?, ?, ?, 'quarantine.detected', ?, ?, ?)`, [
                randomUUID(),
                scope.tenantId,
                scope.branchId,
                principal.userId,
                scope.resourceType,
                scope.resourceId,
                JSON.stringify({ reason: scope.ambiguityReason || 'ambiguous', scope: scope.scope }),
            ]);
        },
    };
    return cachedDeps;
}
