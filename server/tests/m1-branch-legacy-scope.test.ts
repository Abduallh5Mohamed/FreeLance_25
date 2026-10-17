import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';

import {
    resolveResourceBranchAccess,
    createSqlResourceScopeLoader,
    principalFromAuthUser,
    type ResourceBranchDeps,
} from '../src/security/resource-branch';
import { createGroupsRouter } from '../src/routes/groups';

/**
 * FIX1 evidence — legacy scope fallback must become ambiguous/deny.
 *
 * A legacy group whose `branch_scope` is 'unassigned' / NULL / an unknown
 * value was previously widened to tenant scope, granting access without an
 * explicit classification. The corrected `mapGroupScope` returns an
 * `ambiguous` scope (audit-only `legacyUnclassified` flag, never an
 * authorization), and the resolver denies it for every principal — including
 * the tenant owner. Only a row explicitly classified `tenant` keeps tenant
 * access. No course->group guessing, no owner bypass, no silent fallback.
 *
 * These tests drive the REAL production loader (`createSqlResourceScopeLoader`)
 * and the REAL groups router handler; no stub resolver is substituted.
 */

const TENANT_A = 'tenant-a';
const BRANCH_A1 = 'branch-a1';
const USER = 'user-1';
const OWNER = 'owner-1';

const groupRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'group-legacy', name: 'Group', description: null, course_id: 'course-1', grade_id: null,
    max_students: 30, current_students: 0, is_active: 1, schedule_days: null, schedule_time: null,
    instructor_id: OWNER, branch_id: null, branch_scope: 'unassigned', tenant_id: TENANT_A, ...overrides,
});

const groupDb = (row: Record<string, unknown>) => ({
    query: async () => [],
    queryOne: async (sql: string) => (sql.includes('FROM `groups`') ? row : null),
    execute: async () => ({ affectedRows: 0 }),
});

const resolveWithDb = (
    row: Record<string, unknown>,
    principalOverrides: Record<string, unknown> = {},
    options: { owner?: boolean; membership?: boolean; platform?: boolean } = {},
) => {
    const deps: ResourceBranchDeps = {
        loadResourceScope: createSqlResourceScopeLoader(groupDb(row) as any),
        findBranch: async () => ({ id: BRANCH_A1, tenant_id: TENANT_A, status: 'active', version: 0 }),
        findMembership: async () =>
            options.membership
                ? { branch_id: BRANCH_A1, user_id: USER, role: 'student', status: 'active', version: 0 }
                : null,
        isTenantOwner: async () => Boolean(options.owner),
        hasPlatformCapability: async () => Boolean(options.platform),
    };
    const principal = principalFromAuthUser({
        id: USER, role: 'instructor', tenantId: TENANT_A, branchId: null, branchMembershipVersion: null,
        ...principalOverrides,
    } as any);
    return resolveResourceBranchAccess(deps, principal, { resourceType: 'group', resourceId: 'group-legacy' });
};

test('FIX1: legacy unassigned group resolves to ambiguous, never tenant', async () => {
    const decision = await resolveWithDb(groupRow({ branch_scope: 'unassigned' }));
    assert.equal(decision.kind, 'ambiguous');
    if (decision.kind === 'ambiguous') {
        assert.equal(decision.scope.legacyUnclassified, true);
        assert.equal(decision.scope.scope, 'ambiguous');
    }
});

test('FIX1: NULL branch_scope is ambiguous (no tenant fallback)', async () => {
    const decision = await resolveWithDb(groupRow({ branch_scope: null }));
    assert.equal(decision.kind, 'ambiguous');
});

test('FIX1: unknown branch_scope value is ambiguous, not widened', async () => {
    const decision = await resolveWithDb(groupRow({ branch_scope: 'legacy-thing' }));
    assert.equal(decision.kind, 'ambiguous');
});

test('FIX1: explicit tenant-classified group stays allowed (positive control)', async () => {
    const decision = await resolveWithDb(groupRow({ branch_scope: 'tenant', branch_id: null, instructor_id: OWNER }));
    assert.equal(decision.kind, 'allowed');
    if (decision.kind === 'allowed') assert.equal(decision.scope, 'tenant');
});

test('FIX1: tenant owner gets NO bypass to serve unclassified legacy contents', async () => {
    const decision = await resolveWithDb(groupRow({ branch_scope: 'unassigned' }), {}, { owner: true });
    // The ambiguous scope is never widened for an owner; access stays denied.
    assert.equal(decision.kind, 'ambiguous');
});

test('FIX1: verified platform operator cannot widen ambiguous legacy to tenant', async () => {
    const decision = await resolveWithDb(
        groupRow({ branch_scope: 'unassigned' }),
        { role: 'admin', tenantId: null },
        { platform: true },
    );
    assert.equal(decision.kind, 'ambiguous');
});

test('FIX1: a DB failure propagates so the handler fails closed', async () => {
    const failingDb = {
        query: async () => { throw new Error('isolated db unavailable'); },
        queryOne: async () => { throw new Error('isolated db unavailable'); },
        execute: async () => { throw new Error('isolated db unavailable'); },
    };
    const deps: ResourceBranchDeps = {
        loadResourceScope: createSqlResourceScopeLoader(failingDb as any),
        findBranch: async () => null,
        findMembership: async () => null,
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    };
    await assert.rejects(
        resolveResourceBranchAccess(
            deps,
            principalFromAuthUser({ id: USER, role: 'instructor', tenantId: TENANT_A } as any),
            { resourceType: 'group', resourceId: 'group-legacy' },
        ),
        /isolated db unavailable/,
    );
});

// ---------------------------------------------------------------------------
// Real groups router handler (production branch enforcement)
// ---------------------------------------------------------------------------

const passAuth: RequestHandler = (req: any, _res, next) => {
    if (req.headers['x-test-user']) req.user = JSON.parse(String(req.headers['x-test-user']));
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

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

const asUser = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ id: USER, email: null, phone: null, role: 'instructor', tenantId: TENANT_A, ...overrides });

const buildGroupsApp = (group: Record<string, unknown>, branchAccess: ResourceBranchDeps) => {
    const app = express();
    app.use(express.json());
    const db = {
        query: async () => [group],
        queryOne: async (sql: string) => {
            if (sql.includes('FROM `groups`')) return group;
            if (sql.includes('FROM branches')) return { id: BRANCH_A1, tenant_id: TENANT_A, status: 'active' };
            if (sql.includes('FROM tenants')) return { id: TENANT_A, owner_user_id: OWNER, status: 'active' };
            if (sql.includes('FROM branch_memberships')) {
                return { id: 'm1', branch_id: BRANCH_A1, user_id: USER, role: 'instructor', status: 'active', version: 0 };
            }
            return null;
        },
        execute: async () => ({ affectedRows: 1, insertId: 0 }),
    };
    app.use('/groups', createGroupsRouter({
        db: db as any,
        optionalAuthenticate: passAuth,
        authenticate: requireUser,
        requireTeachingWrite: (_req: any, _res: any, next: any) => next(),
        hasVerifiedPlatformCapability: async () => false,
        branchAccess,
    }));
    return app;
};

test('FIX1 handler: legacy unassigned group read is denied (403, no tenant fallback)', async () => {
    const branchAccess: ResourceBranchDeps = {
        loadResourceScope: async () => ({
            resourceType: 'group', resourceId: 'group-legacy', tenantId: TENANT_A,
            scope: 'ambiguous', branchId: null, legacyUnclassified: true, ambiguityReason: 'legacy-unclassified',
        }),
        findBranch: async () => ({ id: BRANCH_A1, tenant_id: TENANT_A, status: 'active', version: 0 }),
        findMembership: async () => null,
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    };
    const app = buildGroupsApp(groupRow({ branch_scope: 'unassigned' }), branchAccess);
    const { server, base } = await listen(app);
    try {
        const res = await fetch(`${base}/groups/group-legacy`, { headers: { 'x-test-user': asUser() } });
        assert.equal(res.status, 403);
    } finally { await close(server); }
});

test('FIX1 handler: explicit tenant group read is allowed (200 positive control)', async () => {
    const branchAccess: ResourceBranchDeps = {
        loadResourceScope: async () => ({
            resourceType: 'group', resourceId: 'group-legacy', tenantId: TENANT_A,
            scope: 'tenant', branchId: null,
        }),
        findBranch: async () => null,
        findMembership: async () => null,
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    };
    const app = buildGroupsApp(groupRow({ branch_scope: 'tenant' }), branchAccess);
    const { server, base } = await listen(app);
    try {
        const res = await fetch(`${base}/groups/group-legacy`, { headers: { 'x-test-user': asUser() } });
        assert.equal(res.status, 200);
    } finally { await close(server); }
});

test('FIX1 handler: tenant owner reading an unclassified group is still denied (403)', async () => {
    const branchAccess: ResourceBranchDeps = {
        loadResourceScope: async () => ({
            resourceType: 'group', resourceId: 'group-legacy', tenantId: TENANT_A,
            scope: 'ambiguous', branchId: null, legacyUnclassified: true, ambiguityReason: 'legacy-unclassified',
        }),
        findBranch: async () => ({ id: BRANCH_A1, tenant_id: TENANT_A, status: 'active', version: 0 }),
        findMembership: async () => null,
        isTenantOwner: async () => true,
        hasPlatformCapability: async () => false,
    };
    const app = buildGroupsApp(groupRow({ branch_scope: 'unassigned' }), branchAccess);
    const { server, base } = await listen(app);
    try {
        const res = await fetch(`${base}/groups/group-legacy`, {
            headers: { 'x-test-user': asUser({ id: OWNER, role: 'instructor' }) },
        });
        // Owner of the tenant does NOT get a bypass to read unclassified contents.
        assert.equal(res.status, 403);
    } finally { await close(server); }
});
