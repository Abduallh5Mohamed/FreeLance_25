/**
 * M1 video route boundary regressions (hermetic: no DB, no network, no real
 * env keys, no Docker).
 *
 * Exercises the three live authorization decisions in
 * server/src/routes/videos.ts against the REAL production decision code,
 * with adapters injected at the seams the routes themselves use:
 *  - canManageCourse        -> GET /course/:courseId (course list = management data)
 *  - canViewVideo           -> GET /:videoId (metadata, via evaluateVideoAccess)
 *  - canViewVideoAnalytics  -> GET /:videoId/analytics (management data)
 *
 * Required scenarios: anonymous, revoked teacher, same-center other teacher,
 * tenant B student, right-tenant teacher, exact licensed buyer, and
 * analytics viewer denial.
 *
 * Test limits (explicit):
 *  - Hermetic only: fixtures are injected adapters; no MySQL, MinIO, Docker,
 *    network, or real env key is touched. The MinIO dummies below exist only
 *    so the route module's import-time client construction succeeds; both
 *    the MinIO client and the MySQL pool are lazy and never connect.
 *  - The HTTP layer is not exercised: an anonymous caller is answered by
 *    authenticateToken (401) before any decision runs, so anonymity is
 *    modeled at the boundary as an unresolvable principal — which the policy
 *    denies. No supertest/express round-trip is claimed.
 *  - The SQL adapter section drives the REAL createSqlVideoAccessRepository
 *    over a recording executor that MIRRORS the emitted SQL's WHERE
 *    semantics; it proves the predicates/joins, not a MySQL engine. The full
 *    policy SQL matrix (licenses, publications, offers) is covered in
 *    m1-media-socket-regressions.test.ts.
 *  - Route wiring (which predicate each live route calls) is asserted by
 *    source scan, because handlers bind the pool-backed readers at import
 *    time and cannot be driven hermetically over HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthRequest } from '../src/middleware/auth';
import type { CourseManagementPolicyReader } from '../src/routes/videos';
import type {
    VideoAccessRepository,
    VideoAccessScope,
} from '../src/security/video-access-policy';

process.env.MINIO_ACCESS_KEY ??= 'test-access-key';
process.env.MINIO_SECRET_KEY ??= 'test-secret-key';

const {
    canManageCourse,
    canViewVideo,
    canViewVideoAnalytics,
} = require('../src/routes/videos') as typeof import('../src/routes/videos');
const {
    evaluateVideoAccess,
    createSqlVideoAccessRepository,
} = require('../src/security/video-access-policy') as typeof import('../src/security/video-access-policy');

type Principal = NonNullable<AuthRequest['user']>;

const principal = (over: Partial<Principal> & { id: string }): Principal => ({
    id: over.id,
    email: null,
    phone: null,
    role: 'instructor',
    ...over,
});

// ---------------------------------------------------------------------------
// Injected adapters for the route-level decisions
// ---------------------------------------------------------------------------

const managementReader = (fixtures: {
    course?: { tenant_id: string | null; instructor_id: string | null } | null;
    authority?: { authority: string } | null;
    platformCapability?: boolean;
}): CourseManagementPolicyReader => ({
    loadCourse: async () => fixtures.course ?? null,
    loadActiveTenantAuthority: async () => fixtures.authority ?? null,
    hasPlatformCapability: async () => fixtures.platformCapability ?? false,
});

const accessRepository = (fixtures: {
    user?: { id: string; role: string; phone: string | null; is_active: boolean | number } | null;
    video?: { id: string; tenant_id: string | null; course_id: string | null; uploaded_by: string | null } | null;
    course?: { instructor_id: string | null; tenant_id: string | null; is_active: boolean | number } | null;
    lecture?: {
        id: string; instructor_id: string | null; grade_id: string | null; group_id: string | null;
        is_published: boolean | number; archived_at: Date | string | null;
    } | null;
    authority?: { authority: string } | null;
    share?: { id: string; license_kind: 'purchase' | 'exchange' } | null;
    student?: {
        id: string; tenant_id: string | null; tenant_status: string | null;
        grade_id: string | null; group_id: string | null; instructor_id: string | null;
    } | null;
    publication?: { id: string } | null;
    purchase?: { id: string } | null;
    platformCapability?: boolean;
}): VideoAccessRepository => ({
    loadUser: async () => fixtures.user ?? null,
    loadVideo: async () => fixtures.video ?? null,
    hasPlatformCapability: async () => fixtures.platformCapability ?? false,
    loadLecture: async () => fixtures.lecture ?? null,
    loadCourse: async () => fixtures.course ?? null,
    loadActiveTenantAuthority: async () => fixtures.authority ?? null,
    loadInstructorShare: async () => fixtures.share ?? null,
    loadStudent: async () => fixtures.student ?? null,
    loadSharedPublication: async () => fixtures.publication ?? null,
    loadStudentPurchase: async () => fixtures.purchase ?? null,
});

// Shared fixture rows: a ready video in tenant-1's course, owned by teacher-1
// through the lecture and the course assignment.
const videoRow = { id: 'video-1', tenant_id: 'tenant-1', course_id: 'course-1', uploaded_by: 'uploader-1' };
const courseRow = { instructor_id: 'teacher-1', tenant_id: 'tenant-1', is_active: true };
const lectureRow = {
    id: 'lecture-1', instructor_id: 'teacher-1', grade_id: 'grade-1', group_id: 'group-1',
    is_published: true, archived_at: null,
};
const teacherOne = { id: 'teacher-1', role: 'instructor', phone: '0100', is_active: 1 };

// ---------------------------------------------------------------------------
// GET /:videoId — metadata via the production access policy
// ---------------------------------------------------------------------------

test('metadata: anonymous (unresolvable identity) is denied', async () => {
    // authenticateToken answers 401 before any decision; the boundary models
    // an unresolvable principal, which the policy denies.
    const allowed = await canViewVideo(principal({ id: 'ghost-1' }), 'video-1',
        accessRepository({ user: null }));
    assert.equal(allowed, false);
});

test('metadata: revoked teacher keeps nothing despite uploader + lecture + course assignment', async () => {
    const allowed = await canViewVideo(principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'video-1',
        accessRepository({
            user: { ...teacherOne, is_active: 0 },
            video: { ...videoRow, uploaded_by: 'teacher-1' },
            course: courseRow,
            lecture: lectureRow,
            authority: { authority: 'instructor' },
        }));
    assert.equal(allowed, false);
});

test('metadata: same-center different teacher (active membership, no ownership) is denied', async () => {
    // A teaching membership in the video's tenant is not an entitlement.
    const allowed = await canViewVideo(principal({ id: 'teacher-2', tenantId: 'tenant-1' }), 'video-1',
        accessRepository({
            user: { id: 'teacher-2', role: 'instructor', phone: null, is_active: 1 },
            video: videoRow,
            course: courseRow,
            lecture: lectureRow,
            authority: { authority: 'instructor' },
        }));
    assert.equal(allowed, false);
});

test('metadata: uploader id alone (no live tenant authority) is denied', async () => {
    const allowed = await canViewVideo(principal({ id: 'uploader-1' }), 'video-1',
        accessRepository({
            user: { id: 'uploader-1', role: 'instructor', phone: null, is_active: 1 },
            video: videoRow,
        }));
    assert.equal(allowed, false);
});

test('metadata: stale course assignment without active authority is denied', async () => {
    const allowed = await canViewVideo(principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'video-1',
        accessRepository({
            user: teacherOne,
            video: videoRow,
            course: courseRow,
            lecture: lectureRow,
            authority: null, // membership revoked or tenant stopped
        }));
    assert.equal(allowed, false);
});

test('metadata: tenant B student viewing tenant A content is denied', async () => {
    const allowed = await canViewVideo(
        principal({ id: 'student-b', role: 'student', tenantId: 'tenant-2', studentEnrollmentId: 'enr-b' }),
        'video-1',
        accessRepository({
            user: { id: 'student-b', role: 'student', phone: '0100', is_active: 1 },
            video: videoRow,
            course: courseRow,
            lecture: lectureRow,
            authority: null,
            student: {
                id: 'enr-b', tenant_id: 'tenant-2', tenant_status: 'active',
                grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-9',
            },
        }));
    assert.equal(allowed, false);
});

test('metadata: right-tenant assigned teacher is allowed', async () => {
    const allowed = await canViewVideo(principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'video-1',
        accessRepository({
            user: teacherOne,
            video: videoRow,
            course: courseRow,
            lecture: lectureRow,
            authority: { authority: 'instructor' },
        }));
    assert.equal(allowed, true);
});

test('metadata: exact purchased cross-tenant license grants only that video metadata', async () => {
    const buyer = principal({ id: 'student-b', role: 'student', tenantId: 'tenant-2', studentEnrollmentId: 'enr-b' });
    const repo = accessRepository({
        user: { id: 'student-b', role: 'student', phone: '0100', is_active: 1 },
        video: videoRow,
        course: courseRow,
        lecture: lectureRow,
        authority: null,
        student: {
            id: 'enr-b', tenant_id: 'tenant-2', tenant_status: 'active',
            grade_id: null, group_id: null, instructor_id: null,
        },
        purchase: { id: 'pla-1' },
    });
    assert.equal(await canViewVideo(buyer, 'video-1', repo), true);
    // The license never widens to another video of the same seller.
    assert.equal(await canViewVideo(buyer, 'video-2', {
        ...repo,
        loadStudentPurchase: async () => null,
    }), false);
});

test('metadata: a phone match is not an enrollment (scope comes from server rows)', async () => {
    // A students row sharing the caller's phone exists in the tenant, but no
    // enrollment is selected server-side: the policy never reads phone.
    const allowed = await canViewVideo(principal({ id: 'teacher-1', phone: '0100' }), 'video-1',
        accessRepository({
            user: teacherOne,
            video: videoRow,
            course: courseRow,
            lecture: lectureRow,
            authority: null,
            student: {
                id: 'enr-1', tenant_id: 'tenant-1', tenant_status: 'active',
                grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-1',
            },
        }));
    assert.equal(allowed, false);
});

test('metadata: bare instructor_shared_lectures row without a verified license is denied', async () => {
    // loadInstructorShare returns null exactly when the SQL verification
    // (paid perpetual purchase naming this buyer+lecture, or a completed
    // exchange bound to this instructor and exactly this lecture) fails.
    const allowed = await canViewVideo(principal({ id: 'buyer-instructor', tenantId: 'tenant-2' }), 'video-1',
        accessRepository({
            user: { id: 'buyer-instructor', role: 'instructor', phone: null, is_active: 1 },
            video: videoRow,
            lecture: lectureRow,
            share: null,
        }));
    assert.equal(allowed, false);
});

test('metadata: verified instructor license (approved exchange) grants metadata', async () => {
    const allowed = await canViewVideo(principal({ id: 'buyer-instructor', tenantId: 'tenant-2' }), 'video-1',
        accessRepository({
            user: { id: 'buyer-instructor', role: 'instructor', phone: null, is_active: 1 },
            video: videoRow,
            lecture: lectureRow,
            share: { id: 'share-1', license_kind: 'exchange' },
        }));
    assert.equal(allowed, true);
});

test('metadata: verified platform capability is granted without any tenant scope', async () => {
    const allowed = await canViewVideo(principal({ id: 'admin-1', role: 'admin' }), 'video-1',
        accessRepository({
            user: { id: 'admin-1', role: 'admin', phone: null, is_active: 1 },
            platformCapability: true,
        }));
    assert.equal(allowed, true);
});

// ---------------------------------------------------------------------------
// GET /course/:courseId — course management (canManageCourse)
// ---------------------------------------------------------------------------

test('course list: right-tenant assigned teacher is allowed', async () => {
    const allowed = await canManageCourse(
        principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'course-1',
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: { authority: 'instructor' },
        }));
    assert.equal(allowed, true);
});

test('course list: verified tenant owner manages without a per-course assignment', async () => {
    const allowed = await canManageCourse(
        principal({ id: 'owner-1', tenantId: 'tenant-1' }), 'course-1',
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: { authority: 'owner' },
        }));
    assert.equal(allowed, true);
});

test('course list: same-center other teacher (active membership, no ownership) is denied', async () => {
    const allowed = await canManageCourse(
        principal({ id: 'teacher-2', tenantId: 'tenant-1' }), 'course-1',
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: { authority: 'instructor' },
        }));
    assert.equal(allowed, false);
});

test('course list: stale assignment without live authority is denied', async () => {
    const allowed = await canManageCourse(
        principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'course-1',
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: null,
        }));
    assert.equal(allowed, false);
});

test('course list: selected workspace must be the course tenant', async () => {
    const reader = managementReader({
        course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
        authority: { authority: 'instructor' },
    });
    // Authority exists in tenant-1, but the server-derived selection is tenant-2.
    assert.equal(await canManageCourse(principal({ id: 'teacher-1', tenantId: 'tenant-2' }), 'course-1', reader), false);
    // No workspace selected at all (ambiguous memberships) denies too.
    assert.equal(await canManageCourse(principal({ id: 'teacher-1' }), 'course-1', reader), false);
});

test('course list: verified platform capability needs no course or workspace', async () => {
    const allowed = await canManageCourse(principal({ id: 'admin-1', role: 'admin' }), 'course-x',
        managementReader({ course: null, platformCapability: true }));
    assert.equal(allowed, true);
});

test('course list: missing course or course without a tenant is denied', async () => {
    assert.equal(await canManageCourse(principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'course-x',
        managementReader({ course: null, authority: { authority: 'instructor' } })), false);
    assert.equal(await canManageCourse(principal({ id: 'teacher-1', tenantId: 'tenant-1' }), 'course-1',
        managementReader({ course: { tenant_id: null, instructor_id: 'teacher-1' }, authority: { authority: 'instructor' } })), false);
});

// ---------------------------------------------------------------------------
// GET /:videoId/analytics — management data (canViewVideoAnalytics)
// ---------------------------------------------------------------------------

test('analytics: active course manager is allowed', async () => {
    const allowed = await canViewVideoAnalytics(
        principal({ id: 'teacher-1', tenantId: 'tenant-1' }), { course_id: 'course-1' },
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: { authority: 'instructor' },
        }));
    assert.equal(allowed, true);
});

test('analytics: in-tenant student viewer is denied despite watching the content', async () => {
    // The published-lecture grant proves viewing, never management.
    const repo = accessRepository({
        user: { id: 'student-1', role: 'student', phone: '0100', is_active: 1 },
        video: videoRow,
        course: courseRow,
        lecture: lectureRow,
        authority: null,
        student: {
            id: 'enr-1', tenant_id: 'tenant-1', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-1',
        },
    });
    const viewer = principal({ id: 'student-1', role: 'student', tenantId: 'tenant-1', studentEnrollmentId: 'enr-1' });
    assert.equal(await canViewVideo(viewer, 'video-1', repo), true); // may watch
    assert.equal(await canViewVideoAnalytics(viewer, { course_id: 'course-1' },
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: null,
        })), false); // never manages
});

test('analytics: exact licensed buyer sees metadata but never analytics', async () => {
    const buyer = principal({ id: 'student-b', role: 'student', tenantId: 'tenant-2', studentEnrollmentId: 'enr-b' });
    const repo = accessRepository({
        user: { id: 'student-b', role: 'student', phone: '0100', is_active: 1 },
        video: videoRow,
        course: courseRow,
        lecture: lectureRow,
        authority: null,
        student: {
            id: 'enr-b', tenant_id: 'tenant-2', tenant_status: 'active',
            grade_id: null, group_id: null, instructor_id: null,
        },
        purchase: { id: 'pla-1' },
    });
    assert.equal(await canViewVideo(buyer, 'video-1', repo), true);
    assert.equal(await canViewVideoAnalytics(buyer, { course_id: 'course-1' },
        managementReader({
            course: { tenant_id: 'tenant-1', instructor_id: 'teacher-1' },
            authority: null,
        })), false);
});

test('analytics: verified platform capability is separate from course scope', async () => {
    const allowed = await canViewVideoAnalytics(principal({ id: 'admin-1', role: 'admin' }), { course_id: null },
        managementReader({ platformCapability: true }));
    assert.equal(allowed, true);
});

test('analytics: video without a course has no management surface (fail closed)', async () => {
    const allowed = await canViewVideoAnalytics(principal({ id: 'teacher-1', tenantId: 'tenant-1' }), { course_id: null },
        managementReader({ platformCapability: false }));
    assert.equal(allowed, false);
});

// ---------------------------------------------------------------------------
// SQL adapter: the REAL createSqlVideoAccessRepository over a recording
// executor mirroring the emitted SQL's WHERE semantics
// ---------------------------------------------------------------------------

interface SqlStore {
    user?: { id: string; role: string; phone: string | null; is_active: boolean | number } | null;
    video?: { id: string; tenant_id: string | null; course_id: string | null; uploaded_by: string | null } | null;
    course?: { instructor_id: string | null; tenant_id: string | null; is_active: boolean | number } | null;
    lecture?: {
        id: string; instructor_id: string | null; grade_id: string | null; group_id: string | null;
        is_published: boolean | number; archived_at: Date | string | null;
    } | null;
    tenant?: { status: string; owner_user_id: string | null } | null;
    memberships?: Array<{ user_id: string; tenant_id: string; role_key: string; status: string; user_active: boolean | number }>;
    student?: {
        id: string; user_id: string; tenant_id: string | null; tenant_status: string;
        grade_id: string | null; group_id: string | null; instructor_id: string | null;
    } | null;
    purchases?: Array<{ student_id: string; video_url: string }>;
}

const makeSqlExecutor = (store: SqlStore) => {
    const calls: string[] = [];
    const queryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const norm = sql.replace(/\s+/g, ' ').trim();
        calls.push(norm);
        if (/FROM users WHERE id = \?$/.test(norm)) return (store.user ?? null) as T | null;
        if (/FROM videos WHERE id = \?$/.test(norm)) return (store.video ?? null) as T | null;
        if (/FROM courses WHERE id = \?$/.test(norm)) return (store.course ?? null) as T | null;
        if (/FROM lectures/.test(norm)) return (store.lecture ?? null) as T | null;
        // Active tenant authority: params [tenantId, ownerUserId, memberUserId, memberTenantId]
        if (/UNION ALL/.test(norm) && /tenant_memberships/.test(norm)) {
            const [tenantId, ownerUserId, memberUserId, memberTenantId] = params as string[];
            const tenant = store.tenant;
            if (!tenant || tenant.status !== 'active') return null;
            if (tenant.owner_user_id === ownerUserId) return { authority: 'owner' } as T;
            const membership = (store.memberships ?? []).find((m) =>
                m.user_id === memberUserId && m.tenant_id === memberTenantId
                && m.status === 'active' && m.user_active === 1 && ['owner', 'instructor'].includes(m.role_key));
            return membership ? { authority: membership.role_key } as T : null;
        }
        if (/FROM students s/.test(norm)) {
            const [studentEnrollmentId, userId] = params as string[];
            const student = store.student;
            return (student && student.id === studentEnrollmentId && student.user_id === userId ? student : null) as T | null;
        }
        if (/premium_lecture_access/.test(norm)) {
            const [studentId, videoId] = params as string[];
            const hit = (store.purchases ?? []).find((p) => p.student_id === studentId && p.video_url === `video://${videoId}`);
            return (hit ? { id: 'pla-1' } : null) as T | null;
        }
        if (/instructor_shared_lectures sl/.test(norm) || /publications pub/.test(norm)) return null;
        return null;
    };
    return { queryOne, calls };
};

const sqlRepository = (store: SqlStore): VideoAccessRepository =>
    createSqlVideoAccessRepository({
        queryOne: makeSqlExecutor(store).queryOne,
        hasPlatformCapability: async () => false,
    });

const teacherMembership = [{ user_id: 'teacher-1', tenant_id: 'tenant-1', role_key: 'instructor', status: 'active', user_active: 1 }];

test('sql adapter: right-tenant assigned teacher is allowed through the real SQL repository', async () => {
    const repo = sqlRepository({
        user: teacherOne,
        video: videoRow,
        course: courseRow,
        lecture: lectureRow,
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: teacherMembership,
    });
    const scope: VideoAccessScope = { tenantId: 'tenant-1' };
    assert.equal(await evaluateVideoAccess('teacher-1', 'video-1', scope, repo), true);
});

test('sql adapter: revoked identity is denied by the users read itself', async () => {
    const repo = sqlRepository({
        user: { ...teacherOne, is_active: 0 },
        video: { ...videoRow, uploaded_by: 'teacher-1' },
        course: courseRow,
        lecture: lectureRow,
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: teacherMembership,
    });
    assert.equal(await evaluateVideoAccess('teacher-1', 'video-1', { tenantId: 'tenant-1' }, repo), false);
});

test('sql adapter: tenant B student without a license is denied', async () => {
    const repo = sqlRepository({
        user: { id: 'student-b', role: 'student', phone: '0100', is_active: 1 },
        video: videoRow,
        course: courseRow,
        lecture: lectureRow,
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [],
        student: {
            id: 'enr-b', user_id: 'student-b', tenant_id: 'tenant-2', tenant_status: 'active',
            grade_id: 'grade-1', group_id: 'group-1', instructor_id: 'teacher-9',
        },
        purchases: [],
    });
    const scope: VideoAccessScope = { tenantId: 'tenant-2', studentEnrollmentId: 'enr-b' };
    assert.equal(await evaluateVideoAccess('student-b', 'video-1', scope, repo), false);
});

test('sql adapter: exact purchased license is the only cross-tenant grant', async () => {
    const repo = sqlRepository({
        user: { id: 'student-b', role: 'student', phone: '0100', is_active: 1 },
        video: videoRow,
        course: courseRow,
        lecture: lectureRow,
        tenant: { status: 'active', owner_user_id: 'owner-1' },
        memberships: [],
        student: {
            id: 'enr-b', user_id: 'student-b', tenant_id: 'tenant-2', tenant_status: 'active',
            grade_id: null, group_id: null, instructor_id: null,
        },
        purchases: [{ student_id: 'enr-b', video_url: 'video://video-1' }],
    });
    const scope: VideoAccessScope = { tenantId: 'tenant-2', studentEnrollmentId: 'enr-b' };
    assert.equal(await evaluateVideoAccess('student-b', 'video-1', scope, repo), true);
    // Exact means exact: another video of the same seller stays denied.
    assert.equal(await evaluateVideoAccess('student-b', 'video-2', scope, repo), false);
});

// ---------------------------------------------------------------------------
// Static wiring regressions (the shipped route text must keep delegating)
// ---------------------------------------------------------------------------

const videos = readFileSync(join(__dirname, '..', 'src', 'routes', 'videos.ts'), 'utf8');

test('wiring: GET /course/:courseId authorizes through canManageCourse with the principal', () => {
    assert.match(videos, /router\.get\('\/course\/:courseId', authenticateToken/);
    assert.match(videos, /canManageCourse\(req\.user!, courseId\)/);
});

test('wiring: GET /:videoId authorizes through the production access policy', () => {
    assert.match(videos, /router\.get\('\/:videoId', authenticateToken/);
    assert.match(videos, /canViewVideo\(req\.user!, videoId\)/);
    // The scope is the server-derived selection, never a request value.
    assert.match(videos, /tenantId: user\.tenantId/);
    assert.match(videos, /studentEnrollmentId: user\.studentEnrollmentId/);
    // The legacy phone/role-based viewer check must not gate metadata.
    const metadataHandler = videos.slice(
        videos.indexOf("router.get('/:videoId'"),
        videos.indexOf("router.delete('/:videoId'"),
    );
    assert.doesNotMatch(metadataHandler, /checkVideoAccess\(/);
});

test('wiring: GET /:videoId/analytics is management data via canViewVideoAnalytics', () => {
    assert.match(videos, /router\.get\('\/:videoId\/analytics', authenticateToken/);
    assert.match(videos, /canViewVideoAnalytics\(req\.user!, video\)/);
    const analyticsHandler = videos.slice(videos.indexOf("router.get('/:videoId/analytics'"));
    assert.doesNotMatch(analyticsHandler, /canViewVideo\(/);
});

test('wiring: legacy 410 direct stream/key/refresh routes stay disabled', () => {
    assert.match(videos, /router\.get\('\/key\/:videoId', authenticateToken[\s\S]*?return res\.status\(410\)/);
    assert.match(videos, /router\.get\('\/stream\/:videoId', authenticateToken[\s\S]*?return res\.status\(410\)/);
    assert.match(videos, /router\.post\('\/stream\/:videoId\/refresh', authenticateToken[\s\S]*?return res\.status\(410\)/);
});

test('wiring: upload endpoints keep the verified upload policy (untouched by this step)', () => {
    assert.match(videos, /evaluateCourseUploadPolicy\(req\.user!, course_id, courseUploadPolicyReader\)/);
});

test('wiring: no role-claim gate authorizes video routes', () => {
    assert.doesNotMatch(videos, /requireRoles/);
});

test('wiring: route order keeps the specific routes ahead of the :videoId parameter route', () => {
    const courseRoute = videos.indexOf("router.get('/course/:courseId'");
    const videoRoute = videos.indexOf("router.get('/:videoId'");
    const analyticsRoute = videos.indexOf("router.get('/:videoId/analytics'");
    assert.ok(courseRoute > 0 && courseRoute < videoRoute);
    assert.ok(analyticsRoute > videoRoute);
});
