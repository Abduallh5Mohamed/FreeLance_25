import type { ResourceBranchDeps, ResourceBranchType } from '../../src/security/resource-branch';

/**
 * Legacy-fixture branch seam for pre-existing hermetic route suites.
 *
 * Those suites model the tenant model that predates branch ownership: every
 * fixture resource is explicitly tenant-level. This helper returns a
 * tenant-level scope for the resource's fixture tenant so the real handlers
 * still run their existing tenant/exact-resource predicates; it never grants
 * branch authority and is not used by the new branch-contract tests.
 */
export const tenantScopeBranchDeps = (
    tenantOf: (type: ResourceBranchType, id: string) => string | null,
): ResourceBranchDeps => ({
    loadResourceScope: async (type, id) => {
        const tenantId = tenantOf(type, id);
        if (!tenantId) return null;
        return { resourceType: type, resourceId: id, tenantId, scope: 'tenant', branchId: null };
    },
    findBranch: async () => null,
    findMembership: async () => null,
    isTenantOwner: async () => false,
    hasPlatformCapability: async () => false,
});
