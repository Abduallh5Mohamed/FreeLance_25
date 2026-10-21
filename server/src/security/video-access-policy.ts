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
 *
 * Association contract (write time + resolution):
 *  - The link carries NO uniqueness constraint (no unique index on
 *    lectures.video_url, and course_materials.file_url is a separate table),
 *    so several parents may name one video.
 *  - Resolution therefore reads CANDIDATES: exactly one parent is used, more
 *    than one is an ambiguity denial. There is no ORDER BY tie-break and no
 *    "first parent" rule — choosing one would compute teacher/student
 *    authority from an arbitrary lesson. A bare `LIMIT 1` without ORDER BY is
 *    not allowed on a parent lookup.
 *  - Writes validate the reference first (`validateVideoBinding`): the video
 *    must exist, belong to the writer's tenant and be authorized by this same
 *    policy; a second parent is refused with 409 rather than silently created.
 *  - The single-parent rule is an ambiguity rule, not a product rule about
 *    multi-lesson videos: the schema cannot disambiguate a second parent, so
 *    the write refuses it. A unique constraint or a binding table (I2) is what
 *    would let the platform support more than one parent safely.
 *
 * Tenant equality (write time, non-negotiable):
 *  - The DESTINATION tenant is proven from server rows, never from the body:
 *    the lecture/material's own `course_id` is read inside the write
 *    transaction and its `courses.tenant_id` is the destination tenant. On
 *    create the caller passes the server-derived course id; on update the
 *    validator reads the row's current course, so a course move re-proves the
 *    binding even when `video_url` is unchanged.
 *  - The VIDEO tenant is proven from its declared authorities only:
 *    `videos.tenant_id` and/or `videos.course_id -> courses.tenant_id`. Two
 *    authorities that disagree are a conflict (deny); no authority at all is
 *    unproven (deny). The actor's tenant is never used as proof.
 *  - `destinationTenant === videoTenant` is required EXACTLY, for every actor.
 *    A verified platform capability satisfies actor authority; it never
 *    relaxes tenant equality. A missing ACTOR tenant may be legitimate
 *    platform authority — a missing destination or video tenant never is.
 *
 * Reference canonical form (write time):
 *  - One rule: `video://` followed by a non-empty id containing no whitespace.
 *    Leading/trailing/internal whitespace and an empty id are rejected with
 *    400 before any mutation; the id is never silently trimmed. Opaque id
 *    formats are preserved — no UUID-only rule is imposed.
 *  - Accepted writes persist the canonical string `video://<id>`, which is
 *    exactly what the conflict probe and `CONCAT('video://', ?)` resolution
 *    compare against, so a stored binding is always visible to both.
 *  - Values stored before this rule (e.g. `video:// x `) are a documented
 *    legacy gap: they are not rewritten here and remain invisible to the exact
 *    conflict probe; a later write of the canonical form will not see them.
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

/**
 * Resolution of the lecture that embeds a video (`lectures.video_url =
 * CONCAT('video://', videos.id)`).
 *
 * The association carries no uniqueness contract, so more than one lecture can
 * name the same video. Picking one of them (a bare `LIMIT 1` without ORDER BY,
 * or any other "first parent" rule) would compute teacher/student authority
 * from an arbitrary lesson. The policy therefore resolves candidates and
 * refuses to decide when the parent is ambiguous: `ambiguous` is a denial, not
 * a choice.
 */
export type VideoAccessParentResolution =
    | { kind: 'none' }
    | { kind: 'single'; lecture: VideoAccessLectureRow }
    | { kind: 'ambiguous'; candidateCount: number };


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
    /**
     * Lecture embedding this video (video_url = CONCAT('video://', id)).
     *
     * Legacy single-row seam: it cannot express ambiguity, so the policy uses
     * it only when `loadParentLecture` is absent (injected single-row
     * fixtures). The production adapter derives it from the ambiguity-aware
     * resolution below and returns null when the parent is ambiguous.
     */
    loadLecture: (videoId: string) => Promise<VideoAccessLectureRow | null>;
    /**
     * Ambiguity-aware parent resolution used by the policy whenever the
     * repository provides it. `ambiguous` denies; it never selects a parent.
     */
    loadParentLecture?: (videoId: string) => Promise<VideoAccessParentResolution>;
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
 * Resolve the lecture that embeds this video. The ambiguity-aware seam is used
 * whenever the repository provides it; the single-row seam is only a
 * compatibility path for injected fixtures and is documented as such.
 */
const resolveParentLecture = async (
    videoId: string,
    repository: VideoAccessRepository,
): Promise<VideoAccessParentResolution> => {
    if (repository.loadParentLecture) return repository.loadParentLecture(videoId);
    const lecture = await repository.loadLecture(videoId);
    return lecture ? { kind: 'single', lecture } : { kind: 'none' };
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

    const parent = await resolveParentLecture(videoId, repository);
    // An ambiguous parent means no lesson-derived authority can be proven: the
    // chosen parent would be arbitrary, so the whole evaluation denies instead
    // of authorizing from the wrong lesson.
    if (parent.kind === 'ambiguous') return false;
    const parentLecture = parent.kind === 'single' ? parent.lecture : null;

    // Per-resource teacher authority (uploader / own lesson / assigned
    // course), each gated by that live authority so a revoked membership or
    // a stopped tenant cannot ride on the assignment.
    if (video.uploaded_by && String(video.uploaded_by) === String(userId) && resourceAuthority) {
        return true;
    }
    if (parentLecture?.instructor_id && String(parentLecture.instructor_id) === String(userId) && resourceAuthority) {
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
    if (parentLecture && (await repository.loadInstructorShare(userId, parentLecture.id))) {
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
    if (parentLecture && video.tenant_id && String(student.tenant_id) === String(video.tenant_id)
        && parentLecture.is_published && parentLecture.archived_at == null
        && (parentLecture.instructor_id == null || String(parentLecture.instructor_id) === String(student.instructor_id))
        && ((parentLecture.grade_id != null && String(parentLecture.grade_id) === String(student.grade_id))
            || (parentLecture.group_id != null && String(parentLecture.group_id) === String(student.group_id)))) {
        return true;
    }

    // A share published to the student's group (tenant-agnostic: the
    // verified license plus the publication is the explicit grant).
    if (parentLecture && (await repository.loadSharedPublication(
        parentLecture.id, String(student.instructor_id), String(student.group_id),
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

/** Row shape of the aggregate parent read (count + at most one joined row). */
interface VideoAccessParentRow {
    candidate_count: number | string | null;
    id: string | null;
    instructor_id: string | null;
    grade_id: string | null;
    group_id: string | null;
    is_published: boolean | number | null;
    archived_at: Date | string | null;
}

const toLectureRow = (row: VideoAccessParentRow): VideoAccessLectureRow => ({
    id: String(row.id),
    instructor_id: row.instructor_id,
    grade_id: row.grade_id,
    group_id: row.group_id,
    is_published: row.is_published ?? 0,
    archived_at: row.archived_at,
});

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
}): VideoAccessRepository => {
    // Candidate resolution of the parent lecture. The aggregate is read in the
    // same statement as the row, and the row is only joined when the count is
    // exactly one, so the statement returns at most one row by construction —
    // no ORDER BY, LIMIT or "first parent" rule is involved. `COUNT(*) = 0`
    // (no parent) and `COUNT(*) > 1` (ambiguous) both come back as a row with
    // a null lecture id, which is mapped to `none` / `ambiguous`.
    const loadParentLecture = async (videoId: string): Promise<VideoAccessParentResolution> => {
        const row = await deps.queryOne<VideoAccessParentRow>(
            `SELECT
                 candidates.candidate_count AS candidate_count,
                 l.id AS id,
                 l.instructor_id AS instructor_id,
                 l.grade_id AS grade_id,
                 l.group_id AS group_id,
                 l.is_published AS is_published,
                 l.archived_at AS archived_at
             FROM (SELECT COUNT(*) AS candidate_count FROM lectures
                   WHERE video_url = CONCAT('video://', ?)) AS candidates
             LEFT JOIN lectures l
                    ON l.video_url = CONCAT('video://', ?)
                   AND candidates.candidate_count = 1`,
            [videoId, videoId],
        );
        if (!row) return { kind: 'none' };
        const count = Number(row.candidate_count);
        if (!Number.isFinite(count)) {
            // A result without the aggregate column cannot prove uniqueness.
            // Only the single-row fixture seam behaves this way; it is treated
            // as exactly one candidate, never as permission to pick among many.
            return row.id ? { kind: 'single', lecture: toLectureRow(row) } : { kind: 'none' };
        }
        if (count === 0) return { kind: 'none' };
        if (count > 1) return { kind: 'ambiguous', candidateCount: count };
        if (!row.id) return { kind: 'none' };
        return { kind: 'single', lecture: toLectureRow(row) };
    };

    return {
    loadUser: (userId) => deps.queryOne<{ id: string; role: string; phone: string | null; is_active: boolean | number }>(
        'SELECT id, role, phone, is_active FROM users WHERE id = ?',
        [userId],
    ),
    loadVideo: (videoId) => deps.queryOne<VideoAccessVideoRow>(
        'SELECT id, tenant_id, course_id, uploaded_by FROM videos WHERE id = ?',
        [videoId],
    ),
    hasPlatformCapability: (userId) => deps.hasPlatformCapability(userId),
    loadParentLecture,
    // Single-row seam derived from the same resolution: it returns the unique
    // parent and null when the parent is ambiguous (fail closed), so no caller
    // can obtain an arbitrary parent through it.
    loadLecture: async (videoId) => {
        const resolution = await loadParentLecture(videoId);
        return resolution.kind === 'single' ? resolution.lecture : null;
    },
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
    // This is an EXISTENCE proof, not a parent-authority resolution: every
    // matching row satisfies the same predicate (this enrollment bought a
    // premium lecture embedding this video), and no field of the chosen row is
    // used for authorization. The read is still ordered so it is deterministic
    // rather than an unordered first-row pick.
    loadStudentPurchase: (studentEnrollmentId, videoId) => deps.queryOne<{ id: string }>(
        `SELECT pla.id FROM premium_lecture_access pla
         INNER JOIN premium_lectures pl ON pl.id = pla.premium_lecture_id
         WHERE pla.student_id = ? AND pl.video_url = CONCAT('video://', ?)
         ORDER BY pla.id ASC
         LIMIT 1`,
        [studentEnrollmentId, videoId],
    ),
    };
};

// ---------------------------------------------------------------------------
// Write-time `video://` binding
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes for a rejected `video://` association write.
 *
 * Status mapping is fixed and must stay stable for clients:
 *  - `VIDEO_NOT_FOUND`              404  the video row does not exist;
 *  - `VIDEO_FOREIGN_TENANT`         403  the video is not in the writer's
 *                                        server-selected tenant;
 *  - `VIDEO_UNAUTHORIZED`           403  the actor has no verified grant on
 *                                        the video (the playback policy says no);
 *  - `VIDEO_ALREADY_BOUND`          409  the video is already linked to another
 *                                        lecture or material;
 *  - `VIDEO_BINDING_UNVERIFIABLE`   503  the check could not be performed (read
 *                                        error / store unavailable) — fail closed;
 *  - `VIDEO_LINK_INVALID`           400  the value is not a canonical
 *                                        `video://<id>` reference;
 *  - `VIDEO_TENANT_CONFLICT`        409  the video's own tenant and its
 *                                        course's tenant disagree — the resource
 *                                        tenant cannot be decided;
 *  - `VIDEO_TENANT_UNPROVEN`        403  no server row proves the video's tenant
 *                                        or the destination resource's tenant;
 *  - `VIDEO_TARGET_TENANT_MISMATCH` 403  the destination resource tenant is not
 *                                        exactly the video tenant. Applies to
 *                                        every actor, including a verified
 *                                        platform operator.
 */
export const VIDEO_BINDING_CODES = {
    NOT_FOUND: 'VIDEO_NOT_FOUND',
    FOREIGN_TENANT: 'VIDEO_FOREIGN_TENANT',
    UNAUTHORIZED: 'VIDEO_UNAUTHORIZED',
    ALREADY_BOUND: 'VIDEO_ALREADY_BOUND',
    UNVERIFIABLE: 'VIDEO_BINDING_UNVERIFIABLE',
    INVALID_LINK: 'VIDEO_LINK_INVALID',
    TENANT_CONFLICT: 'VIDEO_TENANT_CONFLICT',
    TENANT_UNPROVEN: 'VIDEO_TENANT_UNPROVEN',
    TARGET_TENANT_MISMATCH: 'VIDEO_TARGET_TENANT_MISMATCH',
} as const;

export type VideoBindingCode = (typeof VIDEO_BINDING_CODES)[keyof typeof VIDEO_BINDING_CODES];

export type VideoBindingDecision =
    | { ok: true; videoId: string; videoUrl: string }
    | { ok: false; status: number; code: VideoBindingCode; error: string };

/** Read seam used by the binding check (a transaction-scoped reader in production). */
export interface VideoBindingReader {
    queryOne: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
}

export interface VideoBindingRequest {
    /** Transaction-scoped reader: the checks and the write share one transaction. */
    reader: VideoBindingReader;
    /** The `video://<id>` value being written. */
    videoUrl: string;
    /** Authenticated actor; the tenant is the server-selected one, never a body value. */
    actorUserId: string;
    actorTenantId?: string;
    actorStudentEnrollmentId?: string;
    /** Id of the row being created/updated; excluded from the conflict probe. */
    selfId: string;
    /** Which table receives the association. */
    target: 'lecture' | 'material';
    /**
     * Course the resource will belong to AFTER this write, as derived by the
     * route from server state (create paths). Update paths omit it: the
     * validator then reads the target row's own `course_id` inside the
     * transaction, so a course move is re-proven rather than assumed.
     */
    targetCourseId?: string | null;
    /** Verified platform capability (active super_admin or seeded key). */
    hasPlatformCapability: (userId: string) => Promise<boolean>;
}

const VIDEO_REFERENCE_PREFIX = 'video://';

/**
 * Parse a `video://` reference. ONE canonical rule for every write path:
 * the prefix, then a non-empty id with no whitespace anywhere. The id is never
 * trimmed — a value that would need trimming is not canonical and must be
 * rejected by the caller instead of being stored raw. Opaque id formats are
 * preserved (no UUID-only rule).
 */
export type VideoReferenceParse =
    | { ok: true; videoId: string; videoUrl: string }
    | { ok: false; reason: 'not-a-reference' | 'non-canonical' };

export const parseVideoReference = (value: string): VideoReferenceParse => {
    if (!value.startsWith(VIDEO_REFERENCE_PREFIX)) {
        return { ok: false, reason: 'not-a-reference' };
    }
    const videoId = value.slice(VIDEO_REFERENCE_PREFIX.length);
    if (videoId.length === 0 || /\s/.test(videoId)) {
        return { ok: false, reason: 'non-canonical' };
    }
    return { ok: true, videoId, videoUrl: `${VIDEO_REFERENCE_PREFIX}${videoId}` };
};

const bindingDenial = (
    status: number,
    code: VideoBindingCode,
    error: string,
): VideoBindingDecision => ({ ok: false, status, code, error });

/**
 * Any OTHER row that already carries this video reference. The association is
 * single-parent in this codebase's write contract, and the playback policy
 * resolves a video to one lecture, so a second parent is rejected instead of
 * being silently created (see the W5 note: this is an ambiguity rule, not a
 * product rule about multi-lesson videos).
 */
const findConflictingBinding = async (
    request: VideoBindingRequest,
    videoUrl: string,
): Promise<{ id: string } | null> => {
    const lectureSql = request.target === 'lecture'
        ? 'SELECT id FROM lectures WHERE video_url = ? AND id <> ? ORDER BY id ASC LIMIT 1'
        : 'SELECT id FROM lectures WHERE video_url = ? ORDER BY id ASC LIMIT 1';
    const lecture = await request.reader.queryOne<{ id: string }>(
        lectureSql,
        request.target === 'lecture' ? [videoUrl, request.selfId] : [videoUrl],
    );
    if (lecture) return lecture;

    const materialSql = request.target === 'material'
        ? 'SELECT id FROM course_materials WHERE file_url = ? AND id <> ? ORDER BY id ASC LIMIT 1'
        : 'SELECT id FROM course_materials WHERE file_url = ? ORDER BY id ASC LIMIT 1';
    return request.reader.queryOne<{ id: string }>(
        materialSql,
        request.target === 'material' ? [videoUrl, request.selfId] : [videoUrl],
    );
};

/**
 * Course the destination resource belongs to after the write. Create paths
 * pass the server-derived course id; update paths omit it and the row's own
 * `course_id` is read inside the transaction (never the request body). The row
 * is locked so the destination cannot move between proof and write.
 */
const resolveDestinationCourseId = async (request: VideoBindingRequest): Promise<string | null> => {
    if (request.targetCourseId != null && String(request.targetCourseId).length > 0) {
        return String(request.targetCourseId);
    }
    const table = request.target === 'lecture' ? 'lectures' : 'course_materials';
    const row = await request.reader.queryOne<{ course_id: string | null }>(
        `SELECT course_id FROM ${table} WHERE id = ? FOR UPDATE`,
        [request.selfId],
    );
    return row?.course_id == null || String(row.course_id).length === 0 ? null : String(row.course_id);
};

/**
 * Validate a `video://` association write. The reference must be canonical; the
 * referenced video must exist, its tenant must be provable from its own
 * declared authorities, and the DESTINATION resource's tenant — read from
 * server rows inside the same transaction — must equal it exactly, for every
 * actor (a verified platform capability authorizes the actor, it never relaxes
 * tenant equality). The video must also be usable by the actor according to
 * the SAME playback policy that guards viewing (`evaluateVideoAccess`), and a
 * conflicting binding is refused explicitly. Any failure to perform the check
 * refuses the write.
 *
 * The caller must run this inside the same transaction as the write, with the
 * video row read `FOR UPDATE`, so concurrent bindings of one video serialize.
 */
export const validateVideoBinding = async (request: VideoBindingRequest): Promise<VideoBindingDecision> => {
    const reference = parseVideoReference(request.videoUrl);
    if (!reference.ok) {
        return bindingDenial(400, VIDEO_BINDING_CODES.INVALID_LINK, 'Video link is not a platform video reference');
    }
    const videoId = reference.videoId;

    try {
        const video = await request.reader.queryOne<{
            id: string; tenant_id: string | null; course_id: string | null; uploaded_by: string | null;
        }>(
            'SELECT id, tenant_id, course_id, uploaded_by FROM videos WHERE id = ? FOR UPDATE',
            [videoId],
        );
        if (!video) {
            return bindingDenial(404, VIDEO_BINDING_CODES.NOT_FOUND, 'Video not found');
        }

        // The video's tenant comes from its DECLARED authorities only: its own
        // tenant_id and/or its course's tenant. Two authorities that disagree
        // are a conflict; no authority at all is unproven. The actor's tenant
        // is never substituted for either.
        const directVideoTenant = video.tenant_id == null ? null : String(video.tenant_id);
        let courseVideoTenant: string | null = null;
        if (video.course_id) {
            const videoCourse = await request.reader.queryOne<{ tenant_id: string | null }>(
                'SELECT tenant_id FROM courses WHERE id = ?',
                [video.course_id],
            );
            courseVideoTenant = videoCourse?.tenant_id == null ? null : String(videoCourse.tenant_id);
        }
        if (directVideoTenant && courseVideoTenant && directVideoTenant !== courseVideoTenant) {
            return bindingDenial(
                409,
                VIDEO_BINDING_CODES.TENANT_CONFLICT,
                'Video workspace could not be decided: its tenant and course tenant disagree',
            );
        }
        const videoTenantId = directVideoTenant ?? courseVideoTenant;
        if (!videoTenantId) {
            return bindingDenial(403, VIDEO_BINDING_CODES.TENANT_UNPROVEN, 'Video workspace could not be verified');
        }

        // Actor authority to write in the video's workspace. A missing actor
        // tenant is only legitimate for a verified platform capability.
        const platformWide = await request.hasPlatformCapability(request.actorUserId);
        if (!platformWide
            && (!request.actorTenantId || String(request.actorTenantId) !== videoTenantId)) {
            return bindingDenial(403, VIDEO_BINDING_CODES.FOREIGN_TENANT, 'Video belongs to another workspace');
        }

        // The DESTINATION tenant is proven from server rows, inside this
        // transaction — never from the client body and never from the actor.
        const destinationCourseId = await resolveDestinationCourseId(request);
        if (!destinationCourseId) {
            return bindingDenial(
                403,
                VIDEO_BINDING_CODES.TENANT_UNPROVEN,
                'Destination workspace could not be verified',
            );
        }
        const destinationCourse = await request.reader.queryOne<{ tenant_id: string | null }>(
            'SELECT tenant_id FROM courses WHERE id = ?',
            [destinationCourseId],
        );
        const destinationTenantId = destinationCourse?.tenant_id == null
            ? null
            : String(destinationCourse.tenant_id);
        if (!destinationTenantId) {
            return bindingDenial(
                403,
                VIDEO_BINDING_CODES.TENANT_UNPROVEN,
                'Destination workspace could not be verified',
            );
        }

        // Exact equality, for everyone. A platform operator keeps the power to
        // act; it never turns a tenant-A video into a tenant-B resource.
        if (destinationTenantId !== videoTenantId) {
            return bindingDenial(
                403,
                VIDEO_BINDING_CODES.TARGET_TENANT_MISMATCH,
                'Video and destination lesson or material belong to different workspaces',
            );
        }

        // Actor authority comes from the existing playback policy, over the
        // same transaction-scoped reads.
        const repository = createSqlVideoAccessRepository({
            queryOne: request.reader.queryOne,
            hasPlatformCapability: request.hasPlatformCapability,
        });
        const authorized = await evaluateVideoAccess(
            request.actorUserId,
            videoId,
            { tenantId: request.actorTenantId, studentEnrollmentId: request.actorStudentEnrollmentId },
            repository,
        );
        if (!authorized) {
            return bindingDenial(403, VIDEO_BINDING_CODES.UNAUTHORIZED, 'You are not authorized to use this video');
        }

        const conflict = await findConflictingBinding(request, reference.videoUrl);
        if (conflict) {
            return bindingDenial(
                409,
                VIDEO_BINDING_CODES.ALREADY_BOUND,
                'This video is already linked to another lesson or material',
            );
        }

        // The canonical string is what the routes persist, so a stored binding
        // is always visible to the exact conflict probe and to resolution.
        return { ok: true, videoId, videoUrl: reference.videoUrl };
    } catch {
        // Fail closed: a link that could not be verified is never accepted.
        return bindingDenial(503, VIDEO_BINDING_CODES.UNVERIFIABLE, 'Video binding could not be verified');
    }
};
