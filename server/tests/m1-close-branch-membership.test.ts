import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { resolveBranchAccess, type BranchAccessDeps, type BranchRow, type BranchMembershipRow } from '../src/security/branch-access';
import { createStudentWorkspaceSelectHandler } from '../src/routes/student-enrollment';
import { AuthRequest } from '../src/middleware/auth';

/**
 * S1 closure evidence. The final reviews proved the branch-membership model
 * was absent entirely (zero `branch` occurrences across all migrations) and
 * that no route validated branch selectors. These tests drive the real
 * enforcement module and the real workspace-select issuance handler, not a
 * reimplementation: the tenant is resolved server-side from the enrollment
 * row, and the selector from the request body is only a REQUEST to be
 * validated against server-side branch/membership state.
 */

const TEST_SECRET = 'isolated-branch-membership-secret';
const previousSecret = process.env.JWT_SECRET;
const previousExpiry = process.env.JWT_EXPIRES_IN;
before(() => { process.env.JWT_SECRET = TEST_SECRET; delete process.env.JWT_EXPIRES_IN; });
after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousExpiry === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = previousExpiry;
});

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const BRANCH_A1 = 'branch-a1';
const BRANCH_A2 = 'branch-a2';
const BRANCH_B1 = 'branch-b1';
const USER_STUDENT = 'user-student-1';
const USER_OWNER_A = 'user-owner-a';

const branch = (overrides: Partial<BranchRow> & { id: string; tenant_id: string }): BranchRow => ({
    status: 'active',
    version: 0,
    ...overrides,
});

const membership = (overrides: Partial<BranchMembershipRow> & { id: string; branch_id: string; user_id: string }): BranchMembershipRow => ({
    role: 'student',
    status: 'active',
    version: 0,
    ...overrides,
});

const depsFor = (options: {
    branch?: BranchRow | null;
    membership?: BranchMembershipRow | null;
    branchError?: Error;
    membershipError?: Error;
}): BranchAccessDeps => ({
    findBranchById: async (branchId: string) => {
        if (options.branchError) throw options.branchError;
        if (!options.branch || options.branch.id !== branchId) return null;
        return options.branch;
    },
    findMembership: async (branchId: string, userId: string) => {
        if (options.membershipError) throw options.membershipError;
        if (!options.membership || options.membership.branch_id !== branchId || options.membership.user_id !== userId) return null;
        return options.membership;
    },
});

const principal = (overrides: Partial<Parameters<typeof resolveBranchAccess>[1]> = {}) => ({
    principalUserId: USER_STUDENT,
    principalTenantId: TENANT_A,
    ...overrides,
});

// ---------------------------------------------------------------------------
// Authority decisions (server-derived principal, selector is only a request)
// ---------------------------------------------------------------------------

test('S1: an absent branch selector keeps the legacy flow as no-branch-context', async () => {
    for (const value of [undefined, null, '']) {
        const decision = await resolveBranchAccess(depsFor({}), principal({ branchId: value }));
        assert.equal(decision.kind, 'no-branch-context');
    }
});

test('S1: a present-but-malformed selector is denied, never treated as context', async () => {
    for (const value of ['../etc/passwd', 'a'.repeat(200), 'branch with space', 'ünïcode']) {
        const decision = await resolveBranchAccess(depsFor({}), principal({ branchId: value }));
        assert.equal(decision.kind, 'denied');
        assert.equal(decision.kind === 'denied' && decision.reason, 'malformed-branch-id');
    }
});

test('S1: an active membership allows the requested branch', async () => {
    const decision = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }), membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT, version: 3 }) }),
        principal({ branchId: BRANCH_A1 }));
    assert.deepEqual(decision, { kind: 'allowed', branchId: BRANCH_A1, membershipRole: 'student', membershipVersion: 3 });
});

test('S1: a missing membership is denied', async () => {
    const decision = await resolveBranchAccess(depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }) }), principal({ branchId: BRANCH_A1 }));
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'membership-missing');
});

test('S1: a branch of another tenant is denied even with a forged selector', async () => {
    const decision = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_B1, tenant_id: TENANT_B }), membership: membership({ id: 'm1', branch_id: BRANCH_B1, user_id: USER_STUDENT }) }),
        principal({ branchId: BRANCH_B1 }));
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'branch-cross-tenant');
});

test('S1: a suspended branch is denied for members and owners alike', async () => {
    const decision = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A, status: 'suspended' }), membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT }) }),
        principal({ branchId: BRANCH_A1 }));
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'branch-not-active');
});

test('S1: a revoked membership is denied', async () => {
    const decision = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }), membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT, status: 'revoked' }) }),
        principal({ branchId: BRANCH_A1 }));
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'membership-not-active');
});

test('S1: a membership version mismatch fails closed (revocation raced the mint)', async () => {
    const deps = depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }), membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT, version: 4 }) });
    const allowed = await resolveBranchAccess(deps, principal({ branchId: BRANCH_A1, expectedMembershipVersion: 4 }));
    assert.equal(allowed.kind, 'allowed');
    const denied = await resolveBranchAccess(deps, principal({ branchId: BRANCH_A1, expectedMembershipVersion: 3 }));
    assert.equal(denied.kind, 'denied');
    assert.equal(denied.kind === 'denied' && denied.reason, 'membership-version-mismatch');
});

test('S1: database failures propagate so callers fail closed', async () => {
    await assert.rejects(
        resolveBranchAccess(depsFor({ branchError: new Error('ECONNREFUSED isolated db') }), principal({ branchId: BRANCH_A1 })),
        /ECONNREFUSED/);
});

test('S1: the tenant owner keeps an explicit owner path inside their own tenant only', async () => {
    const own = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }), membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_OWNER_A, role: 'owner', version: 2 }) }),
        principal({ principalUserId: USER_OWNER_A, principalIsTenantOwner: true, branchId: BRANCH_A1 }));
    assert.deepEqual(own, { kind: 'allowed', branchId: BRANCH_A1, membershipRole: 'owner', membershipVersion: 2 });

    const foreign = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_B1, tenant_id: TENANT_B }) }),
        principal({ principalUserId: USER_OWNER_A, principalIsTenantOwner: true, branchId: BRANCH_B1 }));
    assert.equal(foreign.kind, 'denied');
    assert.equal(foreign.kind === 'denied' && foreign.reason, 'branch-cross-tenant');

    const revoked = await resolveBranchAccess(
        depsFor({ branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }), membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_OWNER_A, status: 'revoked' }) }),
        principal({ principalUserId: USER_OWNER_A, principalIsTenantOwner: true, branchId: BRANCH_A1 }));
    assert.equal(revoked.kind, 'denied');
});

// ---------------------------------------------------------------------------
// Real route wiring: workspace selection validates the selector server-side
// ---------------------------------------------------------------------------

const enrollmentRow = {
    id: 'enrollment-1',
    tenant_id: TENANT_A,
    instructor_id: 'instructor-1',
    group_id: 'group-a1',
    grade_id: null,
};

const studentUser = { id: USER_STUDENT, email: 'student@example.test', phone: '+201000000001', role: 'student', tokenVersion: 0 };

const response = () => {
    const output: { status?: number; body?: unknown } = {};
    const res = {
        status(code: number) { output.status = code; return res; },
        json(body: unknown) { output.body = body; return res; },
    } as unknown as Response;
    return { res, output };
};

const runSelect = async (options: {
    branchId?: unknown;
    branch?: BranchRow | null;
    membership?: BranchMembershipRow | null;
    branchError?: Error;
    enrollmentFailure?: Error;
} = {}) => {
    const handler = createStudentWorkspaceSelectHandler({
        queryOne: async <T>(sql: string): Promise<T | null> => {
            if (options.enrollmentFailure) throw options.enrollmentFailure;
            if (sql.includes('FROM students')) return enrollmentRow as T;
            if (sql.includes('FROM `groups`')) {
                return { branch_id: BRANCH_A1, branch_scope: 'branch' } as T;
            }
            throw new Error(`unexpected query: ${sql}`);
        },
        branchAccess: {
            findBranchById: async (branchId: string) => {
                if (options.branchError) throw options.branchError;
                if (!options.branch || options.branch.id !== branchId) return null;
                return options.branch;
            },
            findMembership: async (branchId: string, userId: string) => {
                if (options.branchError) throw options.branchError;
                if (!options.membership || options.membership.branch_id !== branchId || options.membership.user_id !== userId) return null;
                return options.membership;
            },
        },
    });
    const { res, output } = response();
    let thrown: Error | null = null;
    try {
        await handler(
            { params: { enrollmentId: 'enrollment-1' }, body: options.branchId === undefined ? {} : { branch_id: options.branchId }, user: studentUser } as unknown as AuthRequest,
            res,
        );
    } catch (error) { thrown = error as Error; }
    return { output, thrown };
};

test('S1 route: workspace selection without a branch selector is unchanged', async () => {
    const { output } = await runSelect();
    assert.equal(output.status, undefined);
    const decoded = jwt.verify((output.body as { token: string }).token, TEST_SECRET) as { tenant_id: string };
    assert.equal(decoded.tenant_id, TENANT_A);
});

test('S1 route: a valid active membership mints the scoped workspace token', async () => {
    const { output } = await runSelect({
        branchId: BRANCH_A1,
        branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }),
        membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT }),
    });
    assert.equal(output.status, undefined);
    assert.ok((output.body as { token: string }).token);
});

test('S1 route: the branch selector and membership version are bound into the token', async () => {
    const { output } = await runSelect({
        branchId: BRANCH_A1,
        branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }),
        membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT, version: 4 }),
    });
    const decoded = jwt.verify((output.body as { token: string }).token, TEST_SECRET) as {
        branch_id?: string; branch_membership_version?: number;
    };
    assert.equal(decoded.branch_id, BRANCH_A1);
    assert.equal(decoded.branch_membership_version, 4);
});

test('S1 route: a selector for a branch the enrollment group does not own is denied', async () => {
    // The membership check itself succeeds for BRANCH_A2, but the enrollment's
    // group is branch A1; the selector must match the resource branch.
    const { output } = await runSelect({
        branchId: BRANCH_A2,
        branch: branch({ id: BRANCH_A2, tenant_id: TENANT_A }),
        membership: membership({ id: 'm2', branch_id: BRANCH_A2, user_id: USER_STUDENT }),
    });
    assert.equal(output.status, 403);
    assert.deepEqual(output.body, { error: 'Workspace not available' });
});

test('S1 route: a forged cross-tenant selector is denied with the generic response', async () => {
    const { output } = await runSelect({
        branchId: BRANCH_B1,
        branch: branch({ id: BRANCH_B1, tenant_id: TENANT_B }),
        membership: membership({ id: 'm1', branch_id: BRANCH_B1, user_id: USER_STUDENT }),
    });
    assert.equal(output.status, 403);
    assert.deepEqual(output.body, { error: 'Workspace not available' });
});

test('S1 route: a revoked membership denies the same way', async () => {
    const { output } = await runSelect({
        branchId: BRANCH_A1,
        branch: branch({ id: BRANCH_A1, tenant_id: TENANT_A }),
        membership: membership({ id: 'm1', branch_id: BRANCH_A1, user_id: USER_STUDENT, status: 'revoked' }),
    });
    assert.equal(output.status, 403);
});

test('S1 route: a lookup failure fails closed and mints no token', async () => {
    const { output, thrown } = await runSelect({ branchId: BRANCH_A1, branchError: new Error('isolated db unavailable') });
    assert.ok(thrown, 'database failures must propagate instead of minting');
    assert.equal(output.body, undefined);
});
