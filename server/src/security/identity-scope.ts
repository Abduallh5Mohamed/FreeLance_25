/**
 * Identity liveness and workspace scope rules shared by the auth middleware
 * and the login/issuance routes.
 *
 * These helpers are pure so the multi-space authorization rules can be
 * behaviorally tested without a database: callers pass rows that were already
 * fetched with server-side active-membership filters applied, and a claim
 * carried by a token is only ever treated as a selector, never as authority.
 */

export interface UserIdentityState {
    is_active: boolean | number;
    token_version: number | null;
    /** Current role from `users`; JWT roles are accepted only when it matches. */
    role?: string;
    /**
     * Server-computed flag: true while a time-bound suspension
     * (`users.suspended_until`) is still in effect. The comparison against
     * UTC_TIMESTAMP() happens in SQL so the flag carries no clock or
     * timezone ambiguity into these rules. Tables without a suspension
     * column (e.g. `staff`) omit the field, which means "not suspended".
     */
    suspension_active?: boolean | number | null;
}

/** Issuance gate: an account may receive a token only while it is active. */
export function isIssuableIdentity(identity: { is_active: boolean | number; suspension_active?: boolean | number | null } | null | undefined): boolean {
    if (!identity || !identity.is_active) return false;
    if (identity.suspension_active === undefined || identity.suspension_active === null) return true;
    return !identity.suspension_active;
}

/**
 * Session liveness for identities stored in the `users` table: the account
 * must be active, not under an active time-bound suspension, and the token's
 * version must still match the server-side `token_version`, so password
 * changes and revocations invalidate every outstanding token.
 */
export function isUsersIdentityLive(
    state: UserIdentityState | null | undefined,
    claimedTokenVersion: number | null | undefined,
    claimedRole?: string,
): boolean {
    if (!isIssuableIdentity(state)) return false;
    // The SQL repository always selects role. Optionality only preserves older
    // injected repositories; when present, a stale role claim revokes the token.
    if (state!.role !== undefined && claimedRole !== undefined && state!.role !== claimedRole) return false;
    const current = Number(state!.token_version || 0);
    return Number(claimedTokenVersion || 0) === current;
}

/**
 * Session liveness for identities stored in the `staff` table. The staff table
 * has no `token_version` or suspension columns (adding them would require a
 * migration), so revocation is expressed by flipping `is_active`; absence of
 * the row means the identity no longer exists. Password changes on staff
 * accounts therefore cannot revoke outstanding sessions; that gap stays
 * blocked until an authorized schema design lands.
 */
export function isStaffIdentityLive(
    state: { is_active: boolean | number } | null | undefined,
): boolean {
    return isIssuableIdentity(state);
}

export interface TenantMembershipRow {
    tenant_id: string;
}

export interface StudentEnrollmentRow {
    id: string;
    user_id: string;
    tenant_id: string;
    instructor_id: string | null;
    group_id: string | null;
    grade_id: string | null;
}

export interface StudentScopeClaims {
    student_enrollment_id?: string | null;
    tenant_id?: string | null;
    instructor_id?: string | null;
    group_id?: string | null;
    grade_id?: string | null;
}

export interface StudentWorkspaceScope {
    tenantId: string;
    studentEnrollmentId: string;
    instructorId: string | null;
    groupId: string | null;
    gradeId: string | null;
}

const isPresent = (value: string | null | undefined): value is string =>
    typeof value === 'string' && value.length > 0;

/**
 * Resolve a single active tenant scope from server-fetched membership rows.
 * - No active membership, or multiple memberships without a matching
 *   selector -> null: the principal is authenticated but receives no data
 *   access (deny-by-default).
 * - A supplied claim that does not match any active membership -> null: the
 * claim is never echoed back as authority.
 */
export function selectActiveTenantScope<T extends TenantMembershipRow>(
    rows: readonly T[],
    claimedTenantId?: string | null,
): string | null {
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
export function selectStudentWorkspaceScope(
    rows: readonly StudentEnrollmentRow[],
    claims: StudentScopeClaims,
): StudentWorkspaceScope | null {
    if (!isPresent(claims.student_enrollment_id)) return null;
    const enrollment = rows.find((row) => row.id === claims.student_enrollment_id);
    if (!enrollment) return null;
    return {
        tenantId: enrollment.tenant_id,
        studentEnrollmentId: enrollment.id,
        instructorId: enrollment.instructor_id,
        groupId: enrollment.group_id,
        gradeId: enrollment.grade_id,
    };
}
