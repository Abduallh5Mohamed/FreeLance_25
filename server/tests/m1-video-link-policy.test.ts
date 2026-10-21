import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
    createSqlVideoAccessRepository,
    evaluateVideoAccess,
    type VideoAccessLectureRow,
    type VideoAccessRepository,
    type VideoAccessScope,
} from '../src/security/video-access-policy';

/**
 * M1 video-link policy suite (hermetic, decision-level).
 *
 * Drives the REAL production policy (`evaluateVideoAccess`) through the REAL
 * SQL adapter (`createSqlVideoAccessRepository`) over a recording executor
 * that mirrors the WHERE semantics of whatever SQL the adapter emits. Nothing
 * is re-implemented: the assertions observe the policy's own decision and the
 * exact SQL text the adapter produced.
 *
 * Focus: the parent-lecture resolution used to derive teacher/student
 * authority. The defect was `WHERE video_url = CONCAT('video://', ?) LIMIT 1`
 * with no ORDER BY: with several parents the chosen parent was arbitrary, so
 * entitlement was computed from the wrong lesson. The contract is now
 * candidate resolution — exactly one parent is used, more than one is an
 * ambiguity denial (fail closed), never a first-parent pick.
 */

interface LectureFixture {
    id: string;
    instructor_id: string | null;
    grade_id: string | null;
    group_id: string | null;
    is_published: boolean | number;
    archived_at: Date | string | null;
    video_url: string;
}

interface Store {
    user: { id: string; role: string; phone: string | null; is_active: boolean | number } | null;
    video: { id: string; tenant_id: string | null; course_id: string | null; uploaded_by: string | null } | null;
    course: { instructor_id: string | null; tenant_id: string | null; is_active: boolean | number } | null;
    lectures: LectureFixture[];
    tenant: { status: string; owner_user_id: string | null } | null;
    memberships: Array<{ user_id: string; tenant_id: string; role_key: string; status: string; user_active: boolean | number }>;
}

const lectureRow = (
    id: string,
    instructorId: string | null,
    videoId: string,
): LectureFixture => ({
    id,
    instructor_id: instructorId,
    grade_id: 'grade-1',
    group_id: 'group-1',
    is_published: 1,
    archived_at: null,
    video_url: `video://${videoId}`,
});

/**
 * Recording executor. It answers the adapter's SQL by its WHERE semantics:
 *  - the aggregate parent query returns `candidate_count` and the single row
 *    only when the count is exactly one;
 *  - a bare `... LIMIT 1` parent query (the pre-fix shape) returns the first
 *    matching row, which is what MySQL would return.
 */
const makeExecutor = (store: Store) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];

    const queryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const norm = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: norm, params });

        if (norm.includes('FROM users WHERE id = ?')) return (store.user ?? null) as T | null;
        if (norm.includes('FROM videos WHERE id = ?')) return (store.video ?? null) as T | null;
        if (norm.includes('FROM courses WHERE id = ?')) return (store.course ?? null) as T | null;

        if (norm.includes('candidate_count')) {
            const videoId = String(params[0]);
            const parents = store.lectures.filter((l) => l.video_url === `video://${videoId}`);
            if (parents.length === 1) return { candidate_count: 1, ...parents[0] } as T;
            return {
                candidate_count: parents.length,
                id: null, instructor_id: null, grade_id: null, group_id: null,
                is_published: 0, archived_at: null,
            } as T;
        }

        if (norm.includes('FROM lectures') && norm.includes('CONCAT')) {
            const videoId = String(params[0]);
            const parent = store.lectures.find((l) => l.video_url === `video://${videoId}`);
            return (parent ?? null) as T | null;
        }

        if (norm.includes('UNION ALL') && norm.includes('tenant_memberships')) {
            const [tenantId, ownerUserId, memberUserId, memberTenantId] = params as string[];
            const tenant = store.tenant;
            if (!tenant || tenant.status !== 'active') return null;
            if (tenant.owner_user_id === ownerUserId) return { authority: 'owner' } as T;
            const membership = store.memberships.find((m) =>
                m.user_id === memberUserId && m.tenant_id === memberTenantId
                && m.status === 'active' && m.user_active === 1 && ['owner', 'instructor'].includes(m.role_key));
            return membership ? ({ authority: membership.role_key } as T) : null;
        }

        if (norm.includes('instructor_shared_lectures sl') || norm.includes('publications pub')) return null;
        return null;
    };

    return { queryOne, calls };
};

const repository = (store: Store): { repo: VideoAccessRepository; calls: Array<{ sql: string; params: unknown[] }> } => {
    const { queryOne, calls } = makeExecutor(store);
    const repo = createSqlVideoAccessRepository({ queryOne, hasPlatformCapability: async () => false });
    return { repo, calls };
};

const teacherMembership = (userId: string) => ({
    user_id: userId, tenant_id: 'tenant-1', role_key: 'instructor', status: 'active', user_active: 1,
});

const teacherUser = (id: string) => ({ id, role: 'instructor', phone: '0100', is_active: 1 });

const courseRow = { instructor_id: 'teacher-9', tenant_id: 'tenant-1', is_active: 1 };

const parentSqlOf = (calls: Array<{ sql: string; params: unknown[] }>): string => {
    const call = calls.find((c) => c.sql.includes('FROM lectures'));
    assert.ok(call, 'a parent-lecture read was issued');
    return call!.sql;
};

// ---------------------------------------------------------------------------
// 9 — exactly one parent is used
// ---------------------------------------------------------------------------

test('policy: a single parent lecture is resolved and authorizes its own instructor', async () => {
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [lectureRow('lecture-a', 'teacher-1', 'video-1')],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-1')],
    };
    const { repo, calls } = repository(store);
    const scope: VideoAccessScope = { tenantId: 'tenant-1' };

    assert.equal(await evaluateVideoAccess('teacher-1', 'video-1', scope, repo), true);

    const parentSql = parentSqlOf(calls);
    assert.ok(parentSql.includes('candidate_count'), 'the parent read resolves candidates');
    assert.ok(!/\bLIMIT\b/i.test(parentSql), 'the parent read no longer truncates candidates');
});

test('policy: the single-parent read is emitted without a bare LIMIT 1', async () => {
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [lectureRow('lecture-a', 'teacher-1', 'video-1')],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-1')],
    };
    const { repo, calls } = repository(store);
    await repo.loadParentLecture?.('video-1');
    const parentSql = parentSqlOf(calls);
    assert.match(parentSql, /COUNT\(\*\)/);
    assert.doesNotMatch(parentSql, /LIMIT/i);
});

// ---------------------------------------------------------------------------
// 10 — two parents: ambiguity denied, never a first-parent pick
// ---------------------------------------------------------------------------

test('policy: two parents of the same video_url deny, even for the first parent instructor', async () => {
    // 'lecture-a' sorts first and names teacher-1 as its instructor, so a
    // first-parent selection would grant. Ambiguity must deny instead.
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [
            lectureRow('lecture-a', 'teacher-1', 'video-1'),
            lectureRow('lecture-b', 'teacher-2', 'video-1'),
        ],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-1')],
    };
    const { repo } = repository(store);
    const scope: VideoAccessScope = { tenantId: 'tenant-1' };

    assert.equal(await evaluateVideoAccess('teacher-1', 'video-1', scope, repo), false,
        'an ambiguous parent must not authorize through an arbitrary parent');
});

test('policy: the ambiguous parent read reports the candidate count and is not truncated', async () => {
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [
            lectureRow('lecture-a', 'teacher-1', 'video-1'),
            lectureRow('lecture-b', 'teacher-2', 'video-1'),
        ],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-1')],
    };
    const { repo, calls } = repository(store);
    const resolution = await repo.loadParentLecture?.('video-1');
    assert.deepEqual(resolution, { kind: 'ambiguous', candidateCount: 2 });
    const parentSql = parentSqlOf(calls);
    assert.ok(!/\bLIMIT\b/i.test(parentSql));
});

// ---------------------------------------------------------------------------
// No parent is not the same as an ambiguous parent
// ---------------------------------------------------------------------------

test('policy: no parent denies the lecture-derived path but keeps the uploader grant', async () => {
    const store: Store = {
        user: teacherUser('uploader-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'uploader-1' },
        course: courseRow,
        lectures: [],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('uploader-1')],
    };
    const { repo, calls } = repository(store);
    assert.equal(await evaluateVideoAccess('uploader-1', 'video-1', { tenantId: 'tenant-1' }, repo), true);
    assert.deepEqual(await repo.loadParentLecture?.('video-1'), { kind: 'none' });
    assert.ok(parentSqlOf(calls).includes('candidate_count'));
});

test('policy: a teacher who owns neither parent nor video is denied', async () => {
    const store: Store = {
        user: teacherUser('teacher-3'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [lectureRow('lecture-a', 'teacher-1', 'video-1')],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-3')],
    };
    const { repo } = repository(store);
    assert.equal(await evaluateVideoAccess('teacher-3', 'video-1', { tenantId: 'tenant-1' }, repo), false);
});

// ---------------------------------------------------------------------------
// The single-row compatibility seam stays fail-closed on ambiguity
// ---------------------------------------------------------------------------

test('policy: the single-row parent seam returns null when the resolution is ambiguous', async () => {
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [
            lectureRow('lecture-a', 'teacher-1', 'video-1'),
            lectureRow('lecture-b', 'teacher-2', 'video-1'),
        ],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-1')],
    };
    const { repo } = repository(store);
    assert.equal(await repo.loadLecture('video-1'), null);
});

test('policy: the single-row parent seam still returns the unique parent', async () => {
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [lectureRow('lecture-a', 'teacher-1', 'video-1')],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [teacherMembership('teacher-1')],
    };
    const { repo } = repository(store);
    const row: VideoAccessLectureRow | null = await repo.loadLecture('video-1');
    assert.equal(row?.id, 'lecture-a');
});

// ---------------------------------------------------------------------------
// The purchased-license read is an existence proof, made deterministic
// ---------------------------------------------------------------------------

test('policy: the purchased-license read is ordered (no unordered first-row pick)', async () => {
    const store: Store = {
        user: teacherUser('teacher-1'),
        video: { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'someone-else' },
        course: courseRow,
        lectures: [],
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [],
    };
    const { repo, calls } = repository(store);
    await repo.loadStudentPurchase('enr-1', 'video-1');
    const purchaseCall = calls.find((c) => c.sql.includes('premium_lecture_access'));
    assert.ok(purchaseCall, 'purchased-license read issued');
    assert.match(purchaseCall!.sql, /ORDER BY/i);
});

// ---------------------------------------------------------------------------
// Static regression: the pre-fix first-parent read must not come back
// ---------------------------------------------------------------------------

test('policy source: no parent lookup keeps an unordered CONCAT video_url LIMIT 1', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'security', 'video-access-policy.ts'), 'utf8');
    assert.doesNotMatch(source, /video_url\s*=\s*CONCAT\('video:\/\/',\s*\?\)\s*LIMIT\s+1/i);
});
