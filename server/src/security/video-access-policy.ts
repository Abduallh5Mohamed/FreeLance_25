/**
 * Pure video-access policy.
 *
 * Deny-by-default authorization for video playback, extracted as a PURE
 * module: it has no eager import of db, minio, notifications, dotenv, or any
 * other service, so the exact production policy AND its SQL adapters can be
 * exercised hermetically by injecting a repository of isolated reads (or a
 * recording query executor). The router builds the SQL repository
 * (createSqlVideoAccessRepository) over the pool-backed helpers it already
 * uses; tests build fixtures.
 *
 * Ownership boundary (documented, never expanded): an explicit license
 * grants exactly the buyer identified in its own row — the buying instructor
 * user for teacher-to-teacher licenses, the buying enrollment for student
 * purchases — and exactly the resource (lecture/video) named there. No
 * sibling, group, or center entitlement is inferred from a license.
 *
 * Entitlements (verified from server-side rows only, never from JWT claims):
 *  1. a verified platform capability (active super_admin or a seeded
 *     permission key) — a bare admin role claim never satisfies it;
 *  2. an ACTIVE identity (users.is_active) — a revoked user keeps nothing;
 *  3. per-resource teacher authority, each additionally requiring ACTIVE
 *     authority in the resource's tenant (active membership with
 *     role_key IN ('owner','instructor') + active tenant + active user, or
 *     the verified tenant owner), so a revoked membership or a stopped
 *     tenant never rides on an uploader/course/lecture assignment: *       a. the uploader of the video;
 *       b. the instructor owning the lecture embedding the video;
 *       c. the instructor assigned to the video's (active) course;
 *     plus the verified OWNER of the video's tenant, who keeps visibility of
 *     their own center's content (ownership — a mere teaching member
 *     without a per-resource grant stays denied);
 *     NOTE: the assignment columns are the authority — there is deliberately
 *     no users.role string gate, so a legacy role='teacher' who is genuinely
 *     assigned is honored, and a bare role claim is never enough;
 *  4. an explicit instructor license (instructor_shared_lectures), verified
 *     as one of:
 *       a. a paid perpetual purchase — the row's purchase_id joins
 *          video_purchase_transactions whose buyer_id is THIS user and
 *          whose lecture_id is THIS lecture. The originating request's
 *          later state is deliberately NOT consulted: a proven perpetual
 *          license survives any subsequent request change; or
 *       b. an approved exchange — the row's request joins
 *          instructor_video_requests whose requester_id IS the sharing /
 *          authorized instructor of that same share row (a completed
 *          request belonging to a different requester grants nothing) and
 *          whose status is 'completed' (the status the approved_free /
 *          approved_paid values were migrated to; open / awaiting_requester
 *          / cancelled_* / expired / failed_* grant nothing), AND whose
 *          fulfilled grant is exactly this lecture: the request's own
 *          lecture_id when it is set, otherwise an 'accepted' offer on
 *          that same request naming exactly this lecture (new-style
 *          requests carry lecture_id NULL and are fulfilled by the
 *          selected offer). A completed request that cannot be bound to
 *          an exact lecture (NULL lecture_id and no accepted offer) is an
 *          ambiguous legacy grant and grants nothing; no status column is
 *          fabricated — the request's real enum is used;
 *  5. a verified student enrollment selected by the SERVER (never a body
 *     value): the enrollment belongs to the caller, is active and approved,
 *     its tenant is active, and it matches the authenticated selected
 *     workspace — through one of:
 *       a. a published, non-archived lecture inside the student's own
 *          tenant scope (grade/group/instructor match);
 *       b. a share published to the student's group, where the sharing
 *          instructor's license is verified exactly as in (4);
 *       c. an EXACT purchased-lecture license — premium_lecture_access for
 *          this enrollment joined to premium_lectures whose video_url is
 *          exactly this video. The only grant that may cross tenant
 *          boundaries; revocation (row deletion) denies.
 *
 * A teaching membership in the video's tenant is NOT an entitlement: staff
 * and unassigned teachers inside the same center are denied, and a caller's
 * tenant claim is never consulted as authority — scope comes from the rows.
 *
 * Schema facts used here (no invented tables, no schema change):
 *  - instructor_shared_lectures(id, instructor_id, lecture_id, request_id,
 *    purchase_id -> video_purchase_transactions.id, is_published);
 *  - instructor_video_requests(id, requester_id, owner_id, lecture_id —
 *    NULL for new-style requests fulfilled by a selected offer, status
 *    ENUM('open','awaiting_requester','completed','cancelled_by_requester',
 *    'cancelled_by_owner','expired','failed_insufficient_balance'));
 *  - instructor_video_offers(id, request_id, lecture_id NOT NULL, status
 *    ENUM('proposed','rejected','accepted','superseded')): the fulfillment
 *    binding when the request itself carries no lecture_id;
 *  - video_purchase_transactions(buyer_id is a users.id, NOT a buyer
 *    tenant) — therefore a center-wide display of an instructor purchase
 *    cannot be proven and is deliberately not inferred (reported blocked);
 *  - premium_lecture_access(student_id -> students.id, premium_lecture_id,
 *    payment_id) is the STUDENT purchase license;
 *  - videos <-> lectures are linked by lectures.video_url =
 *    CONCAT('video://', videos.id); videos.tenant_id is nullable, so the
 *    resource tenant falls back to the course's tenant.
 */

/** Video row fields the policy needs. */
export interface VideoAccessVideoRow {
    id: string;
    tenant_id: string | null;
    course_id: string | null;
    uploaded_by: string | null;
}

/** Lecture row fields the policy needs. */
export interface VideoAccessLectureRow {
    id: string;
    instructor_id: string | null;
    grade_id: string | null;
    group_id: string | null;
    /** MySQL returns 0/1; both are accepted through truthiness. */
    is_published: boolean | number;
    /** Archived lectures are not naturally visible (real column). */
    archived_at: Date | string | null;
}

/** Course row fields the policy needs. */
export interface VideoAccessCourseRow {
    instructor_id: string | null;
    tenant_id: string | null;
    is_active: boolean | number;
}

/** Verified student-enrollment row fields the policy needs. */
export interface VideoAccessStudentRow {
    id: string;
    tenant_id: string | null;
    /** Status of the enrollment's tenant, read in the same query. */
    tenant_status: string | null;
    grade_id: string | null;
    group_id: string | null;
    instructor_id: string | null;
}

/**
 * Authenticated, server-selected scope for the caller. Produced by the auth
 * middleware from server-side rows; a request body value is never accepted.
 */
export interface VideoAccessScope {
    tenantId?: string;
    studentEnrollmentId?: string;
}

/** Which verified license proves an instructor share. */
export type InstructorLicenseKind = 'purchase' | 'exchange';

/**
 * Reads required by the policy. Production wires them over SQL; hermetic
 * tests inject isolated fixtures and drive THIS function, not a replica.
 */
export interface VideoAccessRepository {
    loadUser: (userId: string) => Promise<{ id: string; role: string; phone: string | null; is_active: boolean | number } | null>;
    loadVideo: (videoId: string) => Promise<VideoAccessVideoRow | null>;
    /** Verified platform capability (active super_admin or seeded key). */
    hasPlatformCapability: (userId: string) => Promise<boolean>;
    /** Lecture embedding this video (video_url = CONCAT('video://', id)). */
    loadLecture: (videoId: string) => Promise<VideoAccessLectureRow | null>;
    /** Course the video belongs to (may be null). */
    loadCourse: (courseId: string) => Promise<VideoAccessCourseRow | null>;
    /**
     * ACTIVE authority of the caller inside a tenant: active membership with
     * role_key IN ('owner','instructor') in an active tenant by an active
     * user, or the verified owner of that active tenant. Expired membership
     * and stopped tenants return null.
     */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /**
     * Explicit instructor license for a lecture: a paid perpetual purchase
     * naming this buyer and this lecture, or an approved (completed)
     * exchange whose request belongs to this instructor and grants exactly
     * this lecture. A bare share row is never enough.
     */
    loadInstructorShare: (userId: string, lectureId: string) => Promise<{ id: string; license_kind: InstructorLicenseKind } | null>;
    /** Verified enrollment row of the calling student (active tenant joined). */
    loadStudent: (studentEnrollmentId: string, userId: string) => Promise<VideoAccessStudentRow | null>;
    /** Share publication whose sharing instructor's license is verified (4). */
    loadSharedPublication: (lectureId: string, instructorId: string, groupId: string) => Promise<{ id: string } | null>;
    /**
     * EXACT student purchase license: a premium_lecture_access row for this
     * enrollment whose premium lecture embeds exactly this video.
     */
    loadStudentPurchase: (studentEnrollmentId: string, videoId: string) => Promise<{ id: string } | null>;
};

/**
 * Decide video access. Deny-by-default: every grant below is verified from
 * server-side rows, and an unverifiable identity, video, scope, or license
 * denies.
 */
export const evaluateVideoAccess = async (
    userId: string,
    videoId: string,
    scope: VideoAccessScope,
    repository: VideoAccessRepository,
): Promise<boolean> => {
    const user = await repository.loadUser(userId);
    if (!user) return false;

    // Platform-wide playback is granted only by a VERIFIED capability; a bare
    // admin role claim never satisfies it.
    if (await repository.hasPlatformCapability(userId)) return true;

    // A revoked/inactive identity keeps no entitlement anywhere.
    if (!user.is_active) return false;

    const video = await repository.loadVideo(videoId);
    if (!video) return false;

    let course: VideoAccessCourseRow | null = null;
    if (video.course_id) course = await repository.loadCourse(video.course_id);

    // Tenant scope of the resource: the video's tenant, else its course's.
    // An unscoped legacy row grants no ownership path (deny-by-default).
    const resourceTenantId = video.tenant_id ?? course?.tenant_id ?? null;
    // ACTIVE authority in the resource's tenant: the verified tenant owner,
    // or an active teaching membership (role_key owner/instructor) in an
    // active tenant by an active user. Expired membership and stopped
    // tenants yield null; the authority KIND separates center ownership
    // from a mere membership.
    const resourceAuthority = resourceTenantId
        ? await repository.loadActiveTenantAuthority(userId, resourceTenantId)
        : null;

    const lecture = await repository.loadLecture(videoId);

    // Per-resource teacher authority (uploader / own lesson / assigned
    // course), each gated by that live authority so a revoked membership or
    // a stopped tenant cannot ride on the assignment.
    if (video.uploaded_by && String(video.uploaded_by) === String(userId) && resourceAuthority) {
        return true;
    }
    if (lecture?.instructor_id && String(lecture.instructor_id) === String(userId) && resourceAuthority) {
        return true;
    }
    if (course?.is_active && course.instructor_id
        && String(course.instructor_id) === String(userId)
        && course.tenant_id
        && await repository.loadActiveTenantAuthority(userId, course.tenant_id)) {
        return true;
    }

    // The verified OWNER of the video's tenant keeps visibility of their own
    // center's content — ownership, not membership: a mere teaching member
    // without a per-resource grant stays denied.
    if (resourceAuthority?.authority === 'owner') {
        return true;
    }

    // Explicit instructor license (verified purchase or approved exchange).
    if (lecture && (await repository.loadInstructorShare(userId, lecture.id))) {
        return true;
    }

    // Viewer path requires the server-selected enrollment and workspace.
    if (!scope.studentEnrollmentId || !scope.tenantId) return false;
    const student = await repository.loadStudent(scope.studentEnrollmentId, userId);
    if (!student) return false;
    // The loaded row must BE the authenticated selection, in that selected,
    // ACTIVE tenant — no choosing another owned enrollment.
    if (String(student.id) !== String(scope.studentEnrollmentId)) return false;
    if (String(student.tenant_id) !== String(scope.tenantId)) return false;
    if (String(student.tenant_status) !== 'active') return false;

    // A published, non-archived lecture inside the student's own tenant
    // scope (an unscoped lecture is not broadcast to every student).
    if (lecture && video.tenant_id && String(student.tenant_id) === String(video.tenant_id)
        && lecture.is_published && lecture.archived_at == null
        && (lecture.instructor_id == null || String(lecture.instructor_id) === String(student.instructor_id))
        && ((lecture.grade_id != null && String(lecture.grade_id) === String(student.grade_id))
            || (lecture.group_id != null && String(lecture.group_id) === String(student.group_id)))) {
        return true;
    }

    // A share published to the student's group (tenant-agnostic: the
    // verified license plus the publication is the explicit grant).
    if (lecture && (await repository.loadSharedPublication(
        lecture.id, String(student.instructor_id), String(student.group_id),
    ))) {
        return true;
    }

    // An EXACT purchased-lecture license: this enrollment bought exactly
    // this video. The only cross-tenant grant; revocation (row deletion)
    // denies, and it never widens to the rest of the seller's tenant.
    return !!(await repository.loadStudentPurchase(scope.studentEnrollmentId, videoId));
};

/** mysql2-style row reader used by the SQL repository adapter. */
type RowReader = <T = any>(sql: string, params?: any[]) => Promise<T | null>;

/**
 * Verified instructor-license predicate, shared by the share read and the
 * publication read so both depend on the SAME proof:
 *  - a paid perpetual purchase whose video_purchase_transactions row names
 *    THIS buyer (p.buyer_id) and THIS lecture (p.lecture_id) — the request's
 *    later state is irrelevant, so a proven perpetual license survives it; or
 *  - an approved exchange whose instructor_video_requests row:
 *      . belongs to the authorized instructor of the share itself
 *        (r.requester_id = sl.instructor_id) — a completed request raised by
 *        a different requester grants nothing;
 *      . is 'completed' (the value approved_free/approved_paid were migrated
 *        to; open / awaiting_requester / cancelled_* / expired / failed_*
 *        grant nothing);
 *      . grants exactly THIS lecture, with the two branches mutually
 *        exclusive: the request's own lecture_id when it is set (an
 *        accepted offer on a request that carries its own non-null
 *        lecture cannot substitute it), otherwise — only while
 *        lecture_id IS NULL — an 'accepted' offer on that same request
 *        naming exactly this lecture (requests for new videos carry
 *        lecture_id NULL and are fulfilled by the selected offer). A
 *        completed request with a NULL lecture_id and no accepted offer
 *        is an ambiguous legacy grant and grants nothing.
 * No status column is fabricated; the request's real enum is used. The
 * requester/lecture bindings reference the share row's own columns, so this
 * predicate stays parameter-free and identical for both callers.
 */
const VERIFIED_INSTRUCTOR_LICENSE_SQL = `
    (
      (sl.purchase_id IS NOT NULL AND p.id IS NOT NULL
         AND p.buyer_id = ? AND p.lecture_id = ?)
      OR
      (sl.purchase_id IS NULL AND r.id IS NOT NULL AND r.status = 'completed'
         AND r.requester_id = sl.instructor_id
         AND (
           (r.lecture_id IS NOT NULL AND r.lecture_id = sl.lecture_id)
           OR (r.lecture_id IS NULL AND EXISTS (
             SELECT 1 FROM instructor_video_offers o
             WHERE o.request_id = r.id AND o.status = 'accepted'
               AND o.lecture_id = sl.lecture_id
           ))
         ))
    )`;

/**
 * Build the production SQL repository over the pool-backed helpers the
 * caller already holds. The policy module itself stays pure — the SQL lives
 * behind this factory so tests inject a recording executor instead.
 */
export const createSqlVideoAccessRepository = (deps: {
    queryOne: RowReader;
    hasPlatformCapability: (userId: string) => Promise<boolean>;
}): VideoAccessRepository => ({
    loadUser: (userId) => deps.queryOne<{ id: string; role: string; phone: string | null; is_active: boolean | number }>(
        'SELECT id, role, phone, is_active FROM users WHERE id = ?',
        [userId],
    ),
    loadVideo: (videoId) => deps.queryOne<VideoAccessVideoRow>(
        'SELECT id, tenant_id, course_id, uploaded_by FROM videos WHERE id = ?',
        [videoId],
    ),
    hasPlatformCapability: (userId) => deps.hasPlatformCapability(userId),
    loadLecture: (videoId) => deps.queryOne<VideoAccessLectureRow>(
        `SELECT id, instructor_id, grade_id, group_id, is_published, archived_at FROM lectures
         WHERE video_url = CONCAT('video://', ?) LIMIT 1`,
        [videoId],
    ),
    loadCourse: (courseId) => deps.queryOne<VideoAccessCourseRow>(
        'SELECT instructor_id, tenant_id, is_active FROM courses WHERE id = ?',
        [courseId],
    ),
    // Active authority inside the tenant: verified owner row, or an active
    // teaching membership in an active tenant by an active user.
    loadActiveTenantAuthority: (userId, tenantId) => deps.queryOne<{ authority: string }>(
        `SELECT 'owner' AS authority
         FROM tenants t
         WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
         UNION ALL
         SELECT m.role_key AS authority
         FROM tenant_memberships m
         INNER JOIN tenants t ON t.id = m.tenant_id
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
           AND t.status = 'active' AND u.is_active = 1
           AND m.role_key IN ('owner','instructor')
         LIMIT 1`,
        [tenantId, userId, userId, tenantId],
    ),
    // Explicit instructor license: exact buyer/lecture/purchase or an
    // approved exchange bound to this instructor and this exact lecture.
    loadInstructorShare: (userId, lectureId) => deps.queryOne<{ id: string; license_kind: InstructorLicenseKind }>(
        `SELECT sl.id,
                CASE WHEN sl.purchase_id IS NULL THEN 'exchange' ELSE 'purchase' END AS license_kind
         FROM instructor_shared_lectures sl
         LEFT JOIN instructor_video_requests r ON r.id = sl.request_id
         LEFT JOIN video_purchase_transactions p ON p.id = sl.purchase_id
         WHERE sl.instructor_id = ? AND sl.lecture_id = ?
           AND ${VERIFIED_INSTRUCTOR_LICENSE_SQL}
         LIMIT 1`,
        [userId, lectureId, userId, lectureId],
    ),
    // Verified enrollment of the caller in an ACTIVE tenant.
    loadStudent: (studentEnrollmentId, userId) => deps.queryOne<VideoAccessStudentRow>(
        `SELECT s.id, s.tenant_id, s.grade_id, s.group_id, s.instructor_id, t.status AS tenant_status
         FROM students s
         INNER JOIN tenants t ON t.id = s.tenant_id
         WHERE s.id = ? AND s.user_id = ? AND s.is_active = TRUE AND s.approval_status = 'approved'`,
        [studentEnrollmentId, userId],
    ),
    // Publication of a shared lecture, gated by the SAME verified license
    // predicate (shared constant): the publishing instructor's completed
    // request must belong to them and name exactly the published lecture.
    loadSharedPublication: (lectureId, instructorId, groupId) => deps.queryOne<{ id: string }>(
        `SELECT pub.id
         FROM instructor_shared_lectures sl
         JOIN instructor_shared_lecture_publications pub ON pub.shared_lecture_id = sl.id
         LEFT JOIN instructor_video_requests r ON r.id = sl.request_id
         LEFT JOIN video_purchase_transactions p ON p.id = sl.purchase_id
         WHERE sl.lecture_id = ? AND sl.instructor_id = ? AND sl.is_published = 1 AND pub.group_id = ?
           AND ${VERIFIED_INSTRUCTOR_LICENSE_SQL}
         LIMIT 1`,
        [lectureId, instructorId, groupId, instructorId, lectureId],
    ),
    // Exact student purchase license: this enrollment + exactly this video.
    loadStudentPurchase: (studentEnrollmentId, videoId) => deps.queryOne<{ id: string }>(
        `SELECT pla.id FROM premium_lecture_access pla
         INNER JOIN premium_lectures pl ON pl.id = pla.premium_lecture_id
         WHERE pla.student_id = ? AND pl.video_url = CONCAT('video://', ?) LIMIT 1`,
        [studentEnrollmentId, videoId],
    ),
});
