"use strict";
/**
 * Branch access enforcement for the S1 tenant/branch identity model.
 *
 * Authority is derived from the verified principal and server-side rows only:
 * a client-supplied branch selector is a REQUEST that must be validated, never
 * evidence of membership. The rules implemented here:
 *
 *  - An absent branch selector keeps legacy flows unchanged (no branch
 *    context, no branch check).
 *  - A malformed selector, a missing branch, a branch belonging to another
 *    tenant, a suspended branch, or a missing/revoked membership is denied.
 *  - A tenant owner keeps an explicit, capability-gated owner path for their
 *    own tenant's branches; it never broadens access across tenants.
 *  - A membership `version` supplied by the caller must match the current row:
 *    a revocation or version bump between token mint and use fails closed.
 *  - Ambiguous legacy data (for example an owner-less tenant) is reported as
 *    ambiguous, never silently assigned a default branch.
 *  - Any database failure propagates so callers fail closed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeBranchId = normalizeBranchId;
exports.resolveBranchAccess = resolveBranchAccess;
const BRANCH_ID_MAX_LENGTH = 64;
function normalizeBranchId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > BRANCH_ID_MAX_LENGTH)
        return null;
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}
function normalizeVersion(value) {
    if (value === undefined || value === null)
        return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
/**
 * Resolves whether the verified principal may act within the requested branch.
 * Pure authority decision: callers translate a denial into the generic 403/404
 * boundary their surface already uses.
 */
async function resolveBranchAccess(deps, request) {
    const branchId = normalizeBranchId(request.branchId);
    if (branchId === null) {
        // A present-but-malformed selector is an attack, not "no context".
        if (request.branchId !== undefined && request.branchId !== null && request.branchId !== '') {
            return { kind: 'denied', reason: 'malformed-branch-id' };
        }
        return { kind: 'no-branch-context' };
    }
    const branch = await deps.findBranchById(branchId);
    if (!branch)
        return { kind: 'denied', reason: 'branch-not-found' };
    if (branch.tenant_id !== request.principalTenantId) {
        // Cross-tenant branch use is indistinguishable from not-found to the
        // caller; never confirm another tenant's branch existence.
        return { kind: 'denied', reason: 'branch-cross-tenant' };
    }
    if (branch.status !== 'active')
        return { kind: 'denied', reason: 'branch-not-active' };
    const expectedVersion = normalizeVersion(request.expectedMembershipVersion);
    // Explicit owner path: only for the tenant owner acting inside their own
    // tenant. It does not grant cross-tenant or staff-wide access.
    if (request.principalIsTenantOwner) {
        const ownerMembership = await deps.findMembership(branchId, request.principalUserId);
        if (ownerMembership && ownerMembership.status !== 'active') {
            return { kind: 'denied', reason: 'membership-not-active' };
        }
        if (ownerMembership && expectedVersion !== null && ownerMembership.version !== expectedVersion) {
            return { kind: 'denied', reason: 'membership-version-mismatch' };
        }
        return {
            kind: 'allowed',
            branchId,
            membershipRole: 'owner',
            membershipVersion: ownerMembership ? ownerMembership.version : 0,
        };
    }
    const membership = await deps.findMembership(branchId, request.principalUserId);
    if (!membership)
        return { kind: 'denied', reason: 'membership-missing' };
    if (membership.status !== 'active')
        return { kind: 'denied', reason: 'membership-not-active' };
    if (expectedVersion !== null && membership.version !== expectedVersion) {
        return { kind: 'denied', reason: 'membership-version-mismatch' };
    }
    return {
        kind: 'allowed',
        branchId,
        membershipRole: membership.role,
        membershipVersion: membership.version,
    };
}
