import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveResourceBranchAccess,
    createSqlResourceScopeLoader,
    principalFromAuthUser,
    type ResourceBranchDeps,
    type ResourceBranchScope,
} from '../src/security/resource-branch';

/**
 * FIX2 evidence — video parent-chain resolution.
 *
 * `loadVideo` must resolve EVERY present parent (lecture_id / material_id /
 * course_id) and prove its tenant/context. A dangling parent is ambiguous even
 * when another parent is valid; conflicting branches are ambiguous; a video
 * with no resolvable parent context is denied (no silent uploader-tenant
 * fallback). Crucially, a course is tenant-level: loadVideo never expands a
 * course through `groups.course_id`, so a course referenced by many branch
 * groups is NOT guessed into a single branch, and an explicit tenant-level
 * course keeps its legitimate tenant access.
 *
 * Drives the REAL production loader (`createSqlResourceScopeLoader` -> the real
 * `loadVideo`) and the real `resolveResourceBranchAccess` resolver. Only the
 * SQL-backed `db` is replaced by a fixture; the decision code is untouched.
 */

const TENANT_A = 'tenant-a';
const BRANCH_A1 = 'branch-a1';
const BRANCH_B1 = 'branch-b1';
const USER = 'user-1';

type Row = Record<string, unknown> | null;

interface VideoFixtures {
    video?: Row;
    lecture?: Row;
    material?: Row;
    materialLinks?: Row[];
}

const videoDb = (f: VideoFixtures) => ({
    query: async (sql: string) => {
        if (sql.includes('FROM material_groups')) return f.materialLinks ?? [];
        return [];
    },
    queryOne: async (sql: string) => {
        if (sql.includes('FROM videos')) return f.video ?? null;
        if (sql.includes('FROM lectures')) return f.lecture ?? null;
        if (sql.includes('FROM course_materials')) return f.material ?? null;
        return null;
    },
    execute: async () => ({ affectedRows: 0 }),
});

const loadVideoScope = (f: VideoFixtures): Promise<ResourceBranchScope | null> =>
    createSqlResourceScopeLoader(videoDb(f) as any)('video', 'vid');

const resolveVideo = (
    f: VideoFixtures,
    principalOverrides: Record<string, unknown> = {},
    options: { membershipBranch?: string; owner?: boolean; platform?: boolean } = {},
) => {
    const deps: ResourceBranchDeps = {
        loadResourceScope: createSqlResourceScopeLoader(videoDb(f) as any),
        findBranch: async () => ({ id: BRANCH_A1, tenant_id: TENANT_A, status: 'active', version: 0 }),
        findMembership: async (branchId: string) =>
            options.membershipBranch === branchId
                ? { branch_id: branchId, user_id: USER, role: 'student', status: 'active', version: 0 }
                : null,
        isTenantOwner: async () => Boolean(options.owner),
        hasPlatformCapability: async () => Boolean(options.platform),
    };
    const principal = principalFromAuthUser({
        id: USER, role: 'student', tenantId: TENANT_A, branchId: null, branchMembershipVersion: null,
        ...principalOverrides,
    } as any);
    return resolveResourceBranchAccess(deps, principal, { resourceType: 'video', resourceId: 'vid' });
};

const VIDEO_BASE = {
    id: 'vid', lecture_id: null, material_id: null, course_id: null,
    video_tenant_id: null, course_row_id: null, course_tenant_id: null,
};

// ---------------------------------------------------------------------------
// Loader-level parent resolution
// ---------------------------------------------------------------------------

test('FIX2: video with a branch-owned lecture parent resolves to branch scope', async () => {
    const scope = await loadVideoScope({
        video: { ...VIDEO_BASE, lecture_id: 'L1', course_id: 'C1', course_row_id: 'C1', course_tenant_id: TENANT_A },
        lecture: {
            id: 'L1', group_id: 'G1', course_id: 'C1', instructor_id: 'instr', tenant_id: TENANT_A,
            branch_id: BRANCH_A1, branch_scope: 'branch', group_course_id: 'C1',
        },
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'branch');
    assert.equal(scope!.branchId, BRANCH_A1);
    assert.equal(scope!.tenantId, TENANT_A);
});

test('FIX2: course-only (tenant-level) video resolves to tenant scope (positive control)', async () => {
    const scope = await loadVideoScope({
        video: { ...VIDEO_BASE, course_id: 'C1', course_row_id: 'C1', course_tenant_id: TENANT_A },
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'tenant');
    assert.equal(scope!.branchId, null);
    assert.equal(scope!.tenantId, TENANT_A);
});

test('FIX2: conflicting lecture-branch and material-branch parents are ambiguous', async () => {
    const scope = await loadVideoScope({
        video: { ...VIDEO_BASE, lecture_id: 'L1', material_id: 'M1' },
        lecture: {
            id: 'L1', group_id: 'G1', course_id: 'C1', instructor_id: 'instr', tenant_id: TENANT_A,
            branch_id: BRANCH_A1, branch_scope: 'branch', group_course_id: 'C1',
        },
        material: { id: 'M1', course_id: 'C1', tenant_id: TENANT_A },
        materialLinks: [
            { group_id: 'G2', resolved_group_id: 'G2', branch_id: BRANCH_B1, branch_scope: 'branch',
              instructor_id: 'instr', group_course_id: null, tenant_id: TENANT_A },
        ],
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'ambiguous');
    assert.equal(scope!.ambiguityReason, 'conflicting-branch-links');
});

test('FIX2: a dangling lecture parent is ambiguous even when course is valid', async () => {
    const scope = await loadVideoScope({
        video: {
            ...VIDEO_BASE, lecture_id: 'LX', course_id: 'C1', course_row_id: 'C1', course_tenant_id: TENANT_A,
        },
        lecture: null,
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'ambiguous');
    assert.equal(scope!.ambiguityReason, 'dangling-lecture-parent');
});

test('FIX2: a supplied course reference with no matching courses row is denied', async () => {
    const scope = await loadVideoScope({
        video: { ...VIDEO_BASE, course_id: 'CX', course_row_id: null, course_tenant_id: null },
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'ambiguous');
    assert.equal(scope!.ambiguityReason, 'dangling-course-parent');
});

test('FIX2: a video with no resolvable parent context is denied (no uploader-tenant fallback)', async () => {
    const scope = await loadVideoScope({
        video: { ...VIDEO_BASE, video_tenant_id: TENANT_A },
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'ambiguous');
    assert.equal(scope!.ambiguityReason, 'video-without-context');
});

test('FIX2: a tenant-level course shared by many branch groups is NOT guessed into a branch', async () => {
    // The course is explicitly tenant-level; loadVideo must not expand it
    // through groups.course_id. The resulting scope stays tenant (not branch),
    // so a plain tenant member (no branch membership) is allowed.
    const scope = await loadVideoScope({
        video: { ...VIDEO_BASE, course_id: 'C2', course_row_id: 'C2', course_tenant_id: TENANT_A },
    });
    assert.ok(scope);
    assert.equal(scope!.scope, 'tenant');
    assert.equal(scope!.branchId, null);
});

test('FIX2: a DB failure during parent resolution propagates (fail-closed)', async () => {
    const failingDb = {
        query: async () => { throw new Error('isolated db unavailable'); },
        queryOne: async () => { throw new Error('isolated db unavailable'); },
        execute: async () => { throw new Error('isolated db unavailable'); },
    };
    await assert.rejects(
        createSqlResourceScopeLoader(failingDb as any)('video', 'vid'),
        /isolated db unavailable/,
    );
});

// ---------------------------------------------------------------------------
// Resolver-level: membership / cross-branch / tenant decisions on real loader
// ---------------------------------------------------------------------------

test('FIX2 resolver: a member of the lecture branch is allowed', async () => {
    const decision = await resolveVideo(
        {
            video: { ...VIDEO_BASE, lecture_id: 'L1', course_id: 'C1', course_row_id: 'C1', course_tenant_id: TENANT_A },
            lecture: {
                id: 'L1', group_id: 'G1', course_id: 'C1', instructor_id: 'instr', tenant_id: TENANT_A,
                branch_id: BRANCH_A1, branch_scope: 'branch', group_course_id: 'C1',
            },
        },
        {},
        { membershipBranch: BRANCH_A1 },
    );
    assert.equal(decision.kind, 'allowed');
    if (decision.kind === 'allowed') assert.equal(decision.scope, 'branch');
});

test('FIX2 resolver: a member of a DIFFERENT branch is denied (no cross-branch access)', async () => {
    const decision = await resolveVideo(
        {
            video: { ...VIDEO_BASE, lecture_id: 'L1', course_id: 'C1', course_row_id: 'C1', course_tenant_id: TENANT_A },
            lecture: {
                id: 'L1', group_id: 'G1', course_id: 'C1', instructor_id: 'instr', tenant_id: TENANT_A,
                branch_id: BRANCH_A1, branch_scope: 'branch', group_course_id: 'C1',
            },
        },
        {},
        { membershipBranch: BRANCH_B1 },
    );
    assert.equal(decision.kind, 'denied');
    if (decision.kind === 'denied') assert.equal(decision.reason, 'membership-missing');
});

test('FIX2 resolver: explicit tenant-level course video allows a plain tenant member (not branch-guessed)', async () => {
    const decision = await resolveVideo(
        { video: { ...VIDEO_BASE, course_id: 'C2', course_row_id: 'C2', course_tenant_id: TENANT_A } },
        {},
        { /* no branch membership at all */ },
    );
    assert.equal(decision.kind, 'allowed');
    if (decision.kind === 'allowed') assert.equal(decision.scope, 'tenant');
});

test('FIX2 resolver: conflicting parents deny even a branch member', async () => {
    const decision = await resolveVideo(
        {
            video: { ...VIDEO_BASE, lecture_id: 'L1', material_id: 'M1' },
            lecture: {
                id: 'L1', group_id: 'G1', course_id: 'C1', instructor_id: 'instr', tenant_id: TENANT_A,
                branch_id: BRANCH_A1, branch_scope: 'branch', group_course_id: 'C1',
            },
            material: { id: 'M1', course_id: 'C1', tenant_id: TENANT_A },
            materialLinks: [
                { group_id: 'G2', resolved_group_id: 'G2', branch_id: BRANCH_B1, branch_scope: 'branch',
                  instructor_id: 'instr', group_course_id: null, tenant_id: null },
            ],
        },
        {},
        { membershipBranch: BRANCH_A1 },
    );
    assert.equal(decision.kind, 'ambiguous');
});
