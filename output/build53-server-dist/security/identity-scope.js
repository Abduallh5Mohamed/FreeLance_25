"use strict";
/**
 * Identity liveness and workspace scope rules shared by the auth middleware
 * and the login/issuance routes.
 *
 * These helpers are pure so the multi-space authorization rules can be
 * behaviorally tested without a database: callers pass rows that were already
 * fetched with server-side active-membership filters applied, and a claim
 * carried by a token is only ever treated as a selector, never as authority.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIssuableIdentity = isIssuableIdentity;
exports.isUsersIdentityLive = isUsersIdentityLive;
exports.isStaffIdentityLive = isStaffIdentityLive;
exports.selectActiveTenantScope = selectActiveTenantScope;
exports.selectStudentWorkspaceScope = selectStudentWorkspaceScope;
/** Issuance gate: an account may receive a token only while it is active. */
function isIssuableIdentity(identity) {
    if (!identity || (identity.is_active !== true && identity.is_active !== 1))
        return false;
    if (identity.suspension_active === undefined || identity.suspension_active === null)
        return true;
    return identity.suspension_active === false || identity.suspension_active === 0;
}
/** Null/missing versions represent the explicit legacy version zero only. */
const identityVersion = (value) => {
    if (value === null || value === undefined)
        return 0;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value)))
        return null;
    const version = Number(value);
    return Number.isSafeInteger(version) && version >= 0 ? version : null;
};
/**
 * Session liveness for identities stored in the `users` table: the account
 * must be active, not under an active time-bound suspension, and the token's
 * version must still match the server-side `token_version`, so password
 * changes and revocations invalidate every outstanding token.
 */
function isUsersIdentityLive(state, claimedTokenVersion, claimedRole) {
    if (!isIssuableIdentity(state))
        return false;
    // The SQL repository always selects role. Optionality only preserves older
    // injected repositories; when present, a stale role claim revokes the token.
    if (state.role !== undefined && claimedRole !== undefined && state.role !== claimedRole)
        return false;
    const current = identityVersion(state.token_version);
    const claimed = identityVersion(claimedTokenVersion);
    return current !== null && claimed !== null && claimed === current;
}
/**
 * Session liveness for staff identities. A missing version represents a
 * pre-migration database/token and is treated as zero for compatibility.
 */
function isStaffIdentityLive(state, claimedTokenVersion = 0) {
    if (!isIssuableIdentity(state))
        return false;
    const current = identityVersion(state.token_version);
    const claimed = identityVersion(claimedTokenVersion);
    return current !== null && claimed !== null && claimed === current;
}
const isPresent = (value) => typeof value === 'string' && value.length > 0;
/**
 * Resolve a single active tenant scope from server-fetched membership rows.
 * - No active membership, or multiple memberships without a matching
 *   selector -> null: the principal is authenticated but receives no data
 *   access (deny-by-default).
 * - A supplied claim that does not match any active membership -> null: the
 * claim is never echoed back as authority.
 */
function selectActiveTenantScope(rows, claimedTenantId) {
    if (isPresent(claimedTenantId)) {
        return rows.some((row) => row.tenant_id === claimedTenantId) ? claimedTenantId : null;
    }
    return rows.length === 1 ? rows[0].tenant_id : null;
}
/**
 * Resolve the student workspace the principal selected. The selected
 * enrollment id must name one of the caller's active, approved enrollments
 * that was just fetched server-side; every scope field is copied from that
 * row, so forged tenant/instructor/group/grade claims cannot widen the
 * workspace. Returns null when no selection was made (authenticated, but no
 * workspace) or when the selected enrollment no longer exists.
 */
function selectStudentWorkspaceScope(rows, claims) {
    if (!isPresent(claims.student_enrollment_id))
        return null;
    const enrollment = rows.find((row) => row.id === claims.student_enrollment_id);
    if (!enrollment)
        return null;
    return {
        tenantId: enrollment.tenant_id,
        studentEnrollmentId: enrollment.id,
        instructorId: enrollment.instructor_id,
        groupId: enrollment.group_id,
        gradeId: enrollment.grade_id,
    };
}
