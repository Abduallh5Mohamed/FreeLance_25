import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';

import {
    resolveResourceBranchAccess,
    type ResourceBranchDeps,
    type ResourceBranchScope,
    type ResourceBranchType,
} from '../src/security/resource-branch';
import { createGroupsRouter } from '../src/routes/groups';
import { createFilesRouter } from '../src/routes/files';
import { createAuthenticateToken } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';

/**
 * Resource-derived branch contract evidence. The tests drive the real
 * resolver and real route handlers over injected fixtures; no database,
 * environment or network service is contacted.
 */

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const BRANCH_A1 = 'branch-a1';
const BRANCH_A2 = 'branch-a2';
const BRANCH_B1 = 'branch-b1';
const USER = 'user-1';
const OWNER = 'user-owner';

const scope = (overrides: Partial<ResourceBranchScope> = {}): ResourceBranchScope => ({
    resourceType: 'group',
    resourceId: 'group-1',
    tenantId: TENANT_A,
    scope: 'branch',
    branchId: BRANCH_A1,
    ...overrides,
});

const deps = (options: {
    resource?: ResourceBranchScope | null;
    branch?: { id: string; tenant_id: string; status: string; version: number } | null;
    membership?: { branch_id: string; user_id: string; role: string; status: string; version: number } | null;
    owner?: boolean;
    platform?: boolean;
    loadError?: Error;
} = {}): ResourceBranchDeps => ({
    loadResourceScope: async (type: ResourceBranchType, id: string) => {
        if (options.loadError) throw options.loadError;
        if (options.resource === null) return null;
        return options.resource ?? scope({ resourceType: type, resourceId: id });
    },
    findBranch: async (branchId: string) => {
        if (options.branch === null) return null;
        return options.branch ?? { id: branchId, tenant_id: TENANT_A, status: 'active', version: 0 };
    },
    findMembership: async (branchId: string, userId: string) => {
        if (options.membership === null) return null;
        const row = options.membership ?? { branch_id: branchId, user_id: userId, role: 'student', status: 'active', version: 0 };
        return row.branch_id === branchId && row.user_id === userId ? row : null;
    },
    isTenantOwner: async () => Boolean(options.owner),
    hasPlatformCapability: async () => Boolean(options.platform),
});

const principal = (overrides: Record<string, unknown> = {}) => ({
    userId: USER,
    tenantId: TENANT_A,
    role: 'student',
    ...overrides,
});

// ---------------------------------------------------------------------------
// Resolver decisions
// ---------------------------------------------------------------------------
test('branch resource: an active membership is allowed without any caller selector', async () => {
    const decision = await resolveResourceBranchAccess(deps(), principal(), {
        resourceType: 'group', resourceId: 'group-1',
    });
    assert.equal(decision.kind, 'allowed');
    assert.equal(decision.kind === 'allowed' && decision.scope, 'branch');
    assert.equal(decision.kind === 'allowed' && decision.branchId, BRANCH_A1);
});

test('branch resource: deleting the selector cannot bypass the derived branch', async () => {
    // No selector at all, no membership: the resource's own branch still
    // requires authority. This is the original bypass this task closes.
    const decision = await resolveResourceBranchAccess(deps({ membership: null }), principal(), {
        resourceType: 'group', resourceId: 'group-1',
    });
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'membership-missing');
});

test('branch resource: a forged/foreign selector is denied', async () => {
    const decision = await resolveResourceBranchAccess(deps(), principal(), {
        resourceType: 'group', resourceId: 'group-1', requestedBranchId: BRANCH_A2,
    });
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'branch-context-mismatch');
});

test('branch resource: a malformed selector is denied even with a valid membership', async () => {
    const decision = await resolveResourceBranchAccess(deps(), principal(), {
        resourceType: 'group', resourceId: 'group-1', requestedBranchId: '../etc/passwd',
    });
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'malformed-branch-id');
});

test('branch resource: same-tenant cross-branch membership is denied', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ membership: { branch_id: BRANCH_A2, user_id: USER, role: 'student', status: 'active', version: 0 } }),
        principal(),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'membership-missing');
});

test('branch resource: a revoked membership denies the next request', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ membership: { branch_id: BRANCH_A1, user_id: USER, role: 'student', status: 'revoked', version: 1 } }),
        principal(),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'membership-not-active');
});

test('branch resource: a version bump rejects a token minted before it', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ membership: { branch_id: BRANCH_A1, user_id: USER, role: 'student', status: 'active', version: 4 } }),
        principal({ scopedBranchId: BRANCH_A1, scopedBranchMembershipVersion: 3 }),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'membership-version-mismatch');
});

test('branch resource: a token scoped to another branch is denied', async () => {
    const decision = await resolveResourceBranchAccess(
        deps(),
        principal({ scopedBranchId: BRANCH_A2, scopedBranchMembershipVersion: 0 }),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'branch-context-mismatch');
});

test('branch resource: cross-tenant access is denied', async () => {
    const decision = await resolveResourceBranchAccess(deps(), principal({ tenantId: TENANT_B }), {
        resourceType: 'group', resourceId: 'group-1',
    });
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'resource-cross-tenant');
});

test('branch resource: a suspended branch is denied for members and owners', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ branch: { id: BRANCH_A1, tenant_id: TENANT_A, status: 'suspended', version: 1 } }),
        principal({ role: 'instructor' }),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'branch-not-active');
});

test('branch resource: the tenant owner path is explicit and tenant-bound', async () => {
    const allowed = await resolveResourceBranchAccess(deps({ owner: true, membership: null }), principal({ role: 'instructor' }), {
        resourceType: 'group', resourceId: 'group-1',
    });
    assert.equal(allowed.kind, 'allowed');
    const crossTenant = await resolveResourceBranchAccess(
        deps({ owner: true, membership: null }),
        principal({ role: 'instructor', tenantId: TENANT_B }),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(crossTenant.kind, 'denied');
});

test('branch resource: a verified platform operator keeps the narrow platform path', async () => {
    const decision = await resolveResourceBranchAccess(deps({ platform: true, membership: null }), principal({ role: 'admin', tenantId: null }), {
        resourceType: 'group', resourceId: 'group-1',
    });
    assert.equal(decision.kind, 'allowed');
    assert.equal(decision.kind === 'allowed' && decision.membershipRole, 'platform');
});

test('tenant resource: an independent-instructor / tenant-level resource stays accessible', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ resource: scope({ scope: 'tenant', branchId: null }) }),
        principal({ role: 'instructor' }),
        { resourceType: 'lecture', resourceId: 'lecture-1' },
    );
    assert.equal(decision.kind, 'allowed');
    assert.equal(decision.kind === 'allowed' && decision.scope, 'tenant');
});

test('tenant resource: a branch selector is a context mismatch, not a narrowing bypass', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ resource: scope({ scope: 'tenant', branchId: null }) }),
        principal(),
        { resourceType: 'lecture', resourceId: 'lecture-1', requestedBranchId: BRANCH_A1 },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'branch-context-mismatch');
});

test('ambiguous branch ownership is denied and reported, never widened to tenant', async () => {
    let reported = 0;
    const ambiguousDeps: ResourceBranchDeps = {
        ...deps(),
        loadResourceScope: async () => scope({
            scope: 'ambiguous', branchId: null, ambiguityReason: 'branch-scope-without-branch',
        }),
        recordAmbiguity: async () => { reported += 1; },
    };
    const decision = await resolveResourceBranchAccess(ambiguousDeps, principal(), {
        resourceType: 'group', resourceId: 'group-1',
    });
    assert.equal(decision.kind, 'ambiguous');
    assert.equal(reported, 1);
});

test('an unprovable tenant is denied instead of falling back to tenant-wide', async () => {
    const decision = await resolveResourceBranchAccess(
        deps({ resource: scope({ tenantId: null }) }),
        principal(),
        { resourceType: 'group', resourceId: 'group-1' },
    );
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'resource-tenant-unprovable');
});

test('a missing resource is indistinguishable from an unauthorized one', async () => {
    const decision = await resolveResourceBranchAccess(deps({ resource: null }), principal(), {
        resourceType: 'group', resourceId: 'missing',
    });
    assert.equal(decision.kind, 'denied');
    assert.equal(decision.kind === 'denied' && decision.reason, 'resource-not-found');
});

test('database failures propagate so the handler fails closed', async () => {
    await assert.rejects(
        resolveResourceBranchAccess(deps({ loadError: new Error('isolated db unavailable') }), principal(), {
            resourceType: 'group', resourceId: 'group-1',
        }),
        /isolated db unavailable/,
    );
});

// ---------------------------------------------------------------------------
// Real groups router handlers
// ---------------------------------------------------------------------------
const passAuth: RequestHandler = (req: any, _res, next) => {
    const header = req.headers['x-test-user'];
    if (header) req.user = JSON.parse(String(header));
    next();
};

const requireUser: RequestHandler = (req: any, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    next();
};

const listen = async (app: express.Express): Promise<{ server: Server; base: string }> => {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { server, base: `http://127.0.0.1:${port}` };
};

const groupRow = {
    id: 'group-1', name: 'Group', description: null, course_id: 'course-1', grade_id: null,
    max_students: 30, current_students: 0, is_active: 1, schedule_days: null, schedule_time: null,
    instructor_id: USER, branch_id: BRANCH_A1, branch_scope: 'branch',
};

const buildGroupsApp = (options: {
    membership?: { status: string; version: number } | null;
    group?: typeof groupRow;
    branch?: { tenant_id: string; status: string; version: number } | null;
} = {}) => {
    const app = express();
    app.use(express.json());
    const db = {
        query: async () => [options.group ?? groupRow],
        queryOne: async (sql: string) => {
            if (sql.includes('FROM `groups`') && sql.includes('g.id = ?')) return options.group ?? groupRow;
            if (sql.includes('FROM `groups`')) return options.group ?? groupRow;
            if (sql.includes('FROM branches')) {
                return options.branch === undefined
                    ? { id: BRANCH_A1, tenant_id: TENANT_A, status: 'active' }
                    : options.branch;
            }
            if (sql.includes('FROM tenants')) return { id: TENANT_A, owner_user_id: OWNER };
            if (sql.includes('FROM branch_memberships')) {
                return options.membership === null ? null : { id: 'm1', ...(options.membership ?? { status: 'active', version: 0 }) };
            }
            return null;
        },
        execute: async () => ({ affectedRows: 1, insertId: 0 }),
    };
    const branchAccess: ResourceBranchDeps = {
        loadResourceScope: async () => options.group === undefined
            ? scope({ resourceType: 'group', resourceId: 'group-1' })
            : scope({
                resourceType: 'group', resourceId: 'group-1',
                branchId: options.group.branch_id, scope: options.group.branch_scope === 'branch' ? 'branch' : 'tenant',
            }),
        findBranch: async () => options.branch === null
            ? null
            : { id: BRANCH_A1, tenant_id: (options.branch?.tenant_id ?? TENANT_A), status: (options.branch?.status ?? 'active'), version: 0 },
        findMembership: async () => options.membership === null
            ? null
            : { branch_id: BRANCH_A1, user_id: USER, role: 'instructor', status: options.membership?.status ?? 'active', version: options.membership?.version ?? 0 },
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    };
    app.use('/groups', createGroupsRouter({
        db: db as any,
        optionalAuthenticate: passAuth,
        authenticate: requireUser,
        requireTeachingWrite: (_req, _res, next) => next(),
        hasVerifiedPlatformCapability: async () => false,
        branchAccess,
    }));
    return app;
};

const asUser = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    id: USER, email: null, phone: null, role: 'instructor', tenantId: TENANT_A, ...overrides,
});

test('groups handler: an active branch membership reads the group', async () => {
    const app = buildGroupsApp();
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/groups/group-1`, { headers: { 'x-test-user': asUser() } });
        assert.equal(response.status, 200);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('groups handler: omitting the selector does not bypass a branch-owned group', async () => {
    const app = buildGroupsApp({ membership: null });
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/groups/group-1`, { headers: { 'x-test-user': asUser() } });
        assert.equal(response.status, 404);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('groups handler: a revoked membership denies the next request', async () => {
    const app = buildGroupsApp({ membership: { status: 'revoked', version: 2 } });
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/groups/group-1`, { headers: { 'x-test-user': asUser() } });
        assert.equal(response.status, 403);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('groups handler: a token minted before a version bump is denied on the next request', async () => {
    const app = buildGroupsApp({ membership: { status: 'active', version: 5 } });
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/groups/group-1`, {
            headers: { 'x-test-user': asUser({ branchId: BRANCH_A1, branchMembershipVersion: 4 }) },
        });
        assert.equal(response.status, 403);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('groups handler: a foreign selector is denied', async () => {
    const app = buildGroupsApp();
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/groups/group-1`, {
            method: 'PUT',
            headers: { 'x-test-user': asUser(), 'content-type': 'application/json' },
            body: JSON.stringify({ branch_id: BRANCH_A2 }),
        });
        assert.equal(response.status, 403);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

// ---------------------------------------------------------------------------
// Real files download handler
// ---------------------------------------------------------------------------
test('files handler: a branch-owned parent requires a live branch membership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-file-branch-'));
    writeFileSync(join(dir, 'proof.bin'), 'synthetic');
    const app = express();
    app.use((req: any, _res, next) => { req.user = JSON.parse(String(req.headers['x-test-user'])); next(); });
    const branchAccess = (member: boolean): ResourceBranchDeps => ({
        loadResourceScope: async () => scope({ resourceType: 'file', resourceId: 'file-1' }),
        findBranch: async () => ({ id: BRANCH_A1, tenant_id: TENANT_A, status: 'active', version: 0 }),
        findMembership: async () => member
            ? { branch_id: BRANCH_A1, user_id: USER, role: 'student', status: 'active', version: 0 }
            : null,
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    });
    const db = {
        queryOne: async () => ({
            storage_path: join(dir, 'proof.bin'), mime_type: 'application/pdf', original_name: 'proof.pdf',
        }),
    };
    app.use('/files', createFilesRouter({
        db: db as any,
        authenticate: (req, _res, next) => next(),
        storageRoot: dir,
        branchAccess: branchAccess(false),
    }));
    const { server, base } = await listen(app);
    try {
        const denied = await fetch(`${base}/files/file-1/download`, { headers: { 'x-test-user': asUser() } });
        assert.equal(denied.status, 404);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Auth middleware: branch claims are re-read live on every request
// ---------------------------------------------------------------------------
const branchRepository = (options: {
    branchStatus?: string;
    branchTenant?: string;
    membershipStatus?: string | null;
    membershipVersion?: number | null;
    owner?: boolean;
} = {}): PrincipalRepository => ({
    findUsersIdentity: async () => ({ is_active: 1, token_version: 0, role: 'student', suspension_active: 0 }),
    findStaffIdentity: async () => null,
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [{
        id: 'enrollment-1', user_id: USER, tenant_id: TENANT_A, instructor_id: 'instructor-1', group_id: 'group-1', grade_id: null,
    }],
    findActiveTenantMemberships: async () => [{ tenant_id: TENANT_A }],
    findBranchSession: async (branchId: string) => ({
        branch_id: branchId,
        branch_tenant_id: options.branchTenant ?? TENANT_A,
        branch_status: options.branchStatus ?? 'active',
        branch_version: 0,
        membership_status: options.membershipStatus === undefined ? 'active' : options.membershipStatus,
        membership_version: options.membershipVersion === undefined ? 3 : options.membershipVersion,
        membership_role: 'student',
    }),
    isTenantOwner: async () => Boolean(options.owner),
});

const authApp = (repository: PrincipalRepository) => {
    const app = express();
    app.get('/protected', createAuthenticateToken(repository), (req: any, res) => {
        res.json({ branchId: req.user.branchId ?? null, version: req.user.branchMembershipVersion ?? null });
    });
    return app;
};

const signedBranchToken = (claims: Record<string, unknown> = {}) => jwt.sign({
    id: USER, role: 'student', tenant_id: TENANT_A, student_enrollment_id: 'enrollment-1',
    branch_id: BRANCH_A1, branch_membership_version: 3, tv: 0, ...claims,
}, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '1h' });

test('auth middleware: a live branch session is attached to the principal', async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'branch-contract-test-secret';
    const app = authApp(branchRepository());
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${signedBranchToken()}` } });
        assert.equal(response.status, 200);
        const body = await response.json() as { branchId: string; version: number };
        assert.equal(body.branchId, BRANCH_A1);
        assert.equal(body.version, 3);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
    }
});

test('auth middleware: a revoked membership denies the next request with the same token', async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'branch-contract-test-secret';
    const app = authApp(branchRepository({ membershipStatus: 'revoked' }));
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${signedBranchToken()}` } });
        assert.equal(response.status, 401);
        assert.equal((await response.json() as { code?: string }).code, 'BRANCH_REVOKED');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
    }
});

test('auth middleware: a version bump denies the next request with the same token', async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'branch-contract-test-secret';
    const app = authApp(branchRepository({ membershipVersion: 4 }));
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${signedBranchToken()}` } });
        assert.equal(response.status, 401);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
    }
});

test('auth middleware: a suspended branch denies the next request with the same token', async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'branch-contract-test-secret';
    const app = authApp(branchRepository({ branchStatus: 'suspended' }));
    const { server, base } = await listen(app);
    try {
        const response = await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${signedBranchToken()}` } });
        assert.equal(response.status, 401);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
    }
});
