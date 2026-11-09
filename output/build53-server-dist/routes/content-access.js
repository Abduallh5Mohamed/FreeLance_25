"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeContentId = normalizeContentId;
exports.audienceMatches = audienceMatches;
exports.evaluateContentAccess = evaluateContentAccess;
exports.contentAccessDenialStatus = contentAccessDenialStatus;
exports.validateReleaseConfig = validateReleaseConfig;
exports.createContentAccessRouter = createContentAccessRouter;
/**
 * C6 scheduled drip release + C7 sequential lesson unlocking — content access
 * surface.
 *
 * Every content endpoint funnels through the SAME composed policy
 * (`evaluateContentAccess`): unpublished/archived lessons are hidden, a
 * scheduled lesson is denied before its server-time release instant, and a
 * sequential lesson stays locked until its prerequisite is completed for the
 * caller's own enrollment. Direct-URL access therefore cannot bypass a lock.
 *
 * Scoping is deny-by-default and server-derived only:
 *  - the tenant comes from the course row, never the request;
 *  - the student enrollment comes from the verified principal + server rows;
 *  - audience (grade/group) and branch are derived from those rows;
 *  - staff access is confined to their tenant and resource-derived branch.
 *
 * Mutations (completion, release configuration, release materialization) are
 * audited. The clock is injected so scheduled release is deterministic.
 *
 * No `any`, no ts-ignore, no runtime DDL.
 */
const express_1 = require("express");
const audit_1 = require("../security/audit");
const resource_branch_1 = require("../security/resource-branch");
const content_release_1 = require("../services/content-release");
const lesson_progress_1 = require("../services/lesson-progress");
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
function normalizeContentId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_LENGTH || !ID_PATTERN.test(trimmed))
        return null;
    return trimmed;
}
/** Audience match by server rows only: grade or group, general lessons open. */
function audienceMatches(lecture, enrollment) {
    if (lecture.gradeId === null && lecture.groupId === null)
        return true;
    if (lecture.gradeId !== null && lecture.gradeId === enrollment.gradeId)
        return true;
    if (lecture.groupId !== null && lecture.groupId === enrollment.groupId)
        return true;
    return false;
}
/**
 * The single content access policy. Staff (verified instructor/owner/admin in
 * the lecture's tenant, enforced by the caller) may preview unpublished
 * content; students must be enrolled, in-audience and in-branch, and the
 * release policy must have released the lesson.
 */
function evaluateContentAccess(facts) {
    if (facts.lecture.archived)
        return { allowed: false, code: 'ARCHIVED' };
    if (facts.isStaff)
        return { allowed: true, reason: 'staff' };
    if (!facts.lecture.isPublished)
        return { allowed: false, code: 'NOT_PUBLISHED' };
    const enrollment = facts.enrollment;
    if (!enrollment)
        return { allowed: false, code: 'ENROLLMENT_REQUIRED' };
    if (enrollment.tenantId !== facts.lecture.tenantId)
        return { allowed: false, code: 'TENANT_MISMATCH' };
    if (!audienceMatches(facts.lecture, enrollment))
        return { allowed: false, code: 'AUDIENCE_MISMATCH' };
    if (facts.lecture.branchAmbiguous)
        return { allowed: false, code: 'BRANCH_MISMATCH' };
    if (facts.lecture.branchId !== null && enrollment.branchId !== facts.lecture.branchId) {
        return { allowed: false, code: 'BRANCH_MISMATCH' };
    }
    const release = (0, content_release_1.evaluateLessonRelease)(facts.policy, {
        now: facts.now,
        prerequisiteCompleted: facts.prerequisiteCompleted,
    });
    if (!release.released) {
        return release.reason === 'prerequisite-required'
            ? { allowed: false, code: 'PREREQUISITE_REQUIRED' }
            : { allowed: false, code: 'NOT_YET_RELEASED' };
    }
    return { allowed: true, reason: release.reason };
}
/**
 * Status mapping for a student denial. Missing/cross-tenant/out-of-audience
 * lessons are 404 (no enumeration); a released-in-the-future or prerequisite
 * locked lesson is 403 (the lesson exists, it is simply not open yet).
 */
function contentAccessDenialStatus(code) {
    switch (code) {
        case 'NOT_YET_RELEASED':
        case 'PREREQUISITE_REQUIRED':
            return 403;
        default:
            return 404;
    }
}
const CONTENT_ERROR_MESSAGES = {
    NOT_FOUND: 'Lesson not found',
    ARCHIVED: 'Lesson not found',
    NOT_PUBLISHED: 'Lesson not found',
    TENANT_MISMATCH: 'Lesson not found',
    ENROLLMENT_REQUIRED: 'Lesson not found',
    AUDIENCE_MISMATCH: 'Lesson not found',
    BRANCH_MISMATCH: 'Lesson not found',
    NOT_YET_RELEASED: 'Lesson is not released yet',
    PREREQUISITE_REQUIRED: 'Complete the prerequisite lesson first',
};
function deriveBranch(scope, branchId) {
    const normalized = (scope ?? '').trim().toLowerCase();
    if (normalized === 'branch') {
        return branchId ? { branchId, ambiguous: false } : { branchId: null, ambiguous: true };
    }
    return { branchId: null, ambiguous: false };
}
const LECTURE_SQL = `
    SELECT l.id, l.course_id, l.instructor_id, l.group_id, l.grade_id,
           l.title, l.description, l.video_url, l.duration_minutes, l.is_free,
           l.is_published, l.display_order, l.archived_at, c.tenant_id,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM lectures l
    INNER JOIN courses c ON c.id = l.course_id
    LEFT JOIN \`groups\` g ON g.id = l.group_id
    WHERE l.id = ?
`;
const ENROLLMENT_SQL = `
    SELECT s.id, s.tenant_id, s.instructor_id, s.group_id, s.grade_id,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM students s
    INNER JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN \`groups\` g ON g.id = s.group_id
    WHERE s.id = ? AND s.user_id = ? AND s.is_active = 1 AND s.approval_status = 'approved' AND t.status = 'active'
      AND (s.enrollment_status IS NULL OR s.enrollment_status = 'active')
      AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date <= UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date > UTC_TIMESTAMP())
    LIMIT 1
`;
const POLICY_BY_LECTURE_SQL = `
    SELECT lecture_id, course_id, tenant_id, release_mode, release_at, release_timezone,
           prerequisite_lecture_id, released_at
    FROM lesson_release_policies WHERE lecture_id = ? LIMIT 1
`;
const POLICY_BY_COURSE_SQL = `
    SELECT lecture_id, release_mode, release_at, release_timezone, prerequisite_lecture_id, released_at
    FROM lesson_release_policies WHERE course_id = ?
`;
const COURSE_LESSONS_SQL = `
    SELECT l.id, l.course_id, l.instructor_id, l.group_id, l.grade_id,
           l.title, l.description, l.video_url, l.duration_minutes, l.is_free,
           l.is_published, l.display_order, l.archived_at,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM lectures l
    INNER JOIN courses c ON c.id = l.course_id
    LEFT JOIN \`groups\` g ON g.id = l.group_id
    WHERE l.course_id = ? AND c.tenant_id = ? AND l.archived_at IS NULL
`;
const COURSE_SCOPE_SQL = `
    SELECT c.id, c.tenant_id, c.instructor_id,
           EXISTS(SELECT 1 FROM tenants t WHERE t.id = c.tenant_id AND t.owner_user_id = ? AND t.status = 'active') AS is_owner
    FROM courses c WHERE c.id = ?
`;
const RELEASE_AUTHORITY_SQL = `
    SELECT l.id, l.course_id, c.tenant_id, c.instructor_id,
           EXISTS(SELECT 1 FROM tenants t WHERE t.id = c.tenant_id AND t.owner_user_id = ? AND t.status = 'active') AS is_owner
    FROM lectures l
    INNER JOIN courses c ON c.id = l.course_id
    WHERE l.id = ?
`;
/**
 * Validate a release configuration. A scheduled mode requires a valid local
 * wall time in a valid IANA timezone (converted to an absolute UTC instant);
 * a sequential mode requires a prerequisite lesson id. Client timezone text is
 * never trusted as an instant.
 */
function validateReleaseConfig(body) {
    const record = (typeof body === 'object' && body !== null ? body : {});
    const mode = (0, content_release_1.normalizeReleaseMode)(record['release_mode']);
    if (!mode)
        return { ok: false, error: 'release_mode must be immediate, scheduled or sequential' };
    const timeZoneRaw = typeof record['release_time_zone'] === 'string' ? record['release_time_zone'].trim() : 'UTC';
    if (!(0, content_release_1.isValidTimeZone)(timeZoneRaw)) {
        return { ok: false, error: 'release_time_zone must be a valid IANA timezone' };
    }
    let releaseAtUtc = null;
    if (mode === 'scheduled') {
        const instant = (0, content_release_1.localWallTimeToInstant)(record['release_at'], timeZoneRaw);
        if (!instant)
            return { ok: false, error: 'release_at must be a valid local date-time' };
        releaseAtUtc = instant.toISOString();
    }
    let prerequisiteLectureId = null;
    if (mode === 'sequential') {
        prerequisiteLectureId = normalizeContentId(record['prerequisite_lecture_id']);
        if (!prerequisiteLectureId) {
            return { ok: false, error: 'prerequisite_lecture_id is required for sequential release' };
        }
    }
    return {
        ok: true,
        value: { releaseMode: mode, releaseAtUtc, releaseTimeZone: timeZoneRaw, prerequisiteLectureId },
    };
}
/** Format an ISO instant as a MySQL UTC DATETIME literal. */
function toMysqlUtc(instant) {
    return instant.toISOString().slice(0, 19).replace('T', ' ');
}
/* ------------------------------------------------------------------------- */
/* Router factory                                                           */
/* ------------------------------------------------------------------------- */
function createContentAccessRouter(deps) {
    const router = (0, express_1.Router)();
    const db = deps.db;
    const now = deps.now ?? (() => new Date());
    const progress = (0, lesson_progress_1.createLessonProgressService)(db);
    const runAtomic = deps.transaction
        ? deps.transaction
        : (fn) => fn(db);
    router.use(deps.authenticate);
    const loadLecture = async (lectureId) => db.queryOne(LECTURE_SQL, [lectureId]);
    const loadEnrollment = async (enrollmentId, userId) => db.queryOne(ENROLLMENT_SQL, [enrollmentId, userId]);
    const loadPolicyRow = async (lectureId) => db.queryOne(POLICY_BY_LECTURE_SQL, [lectureId]);
    const lectureFacts = (lecture) => {
        const branch = deriveBranch(lecture.group_branch_scope, lecture.group_branch_id);
        return {
            tenantId: lecture.tenant_id,
            instructorId: lecture.instructor_id,
            groupId: lecture.group_id,
            gradeId: lecture.grade_id,
            branchId: branch.branchId,
            branchAmbiguous: branch.ambiguous,
            isPublished: Boolean(lecture.is_published),
            archived: lecture.archived_at !== null && lecture.archived_at !== undefined,
            displayOrder: Number(lecture.display_order ?? 0),
        };
    };
    const enrollmentFacts = (enrollment) => {
        const branch = deriveBranch(enrollment.group_branch_scope, enrollment.group_branch_id);
        return {
            id: enrollment.id,
            tenantId: enrollment.tenant_id,
            instructorId: enrollment.instructor_id,
            groupId: enrollment.group_id,
            gradeId: enrollment.grade_id,
            branchId: branch.branchId,
        };
    };
    /**
     * Resolve a student's access to one lecture through the composed policy.
     * The enrollment is re-selected with its active/approved/date filters so a
     * stale selected workspace cannot be smuggled in.
     */
    const resolveStudentAccess = async (principal, lecture) => {
        const enrollmentId = principal.studentEnrollmentId;
        const enrollment = enrollmentId ? await loadEnrollment(enrollmentId, principal.id) : null;
        const policyRow = await loadPolicyRow(lecture.id);
        const policy = (0, content_release_1.buildLessonReleasePolicy)(lecture, policyRow);
        let prerequisiteCompleted = false;
        if (policy.releaseMode === 'sequential' && policy.prerequisiteLectureId && enrollment) {
            prerequisiteCompleted = await progress.isCompleted(enrollment.id, policy.prerequisiteLectureId);
        }
        const decision = evaluateContentAccess({
            isStaff: false,
            lecture: lectureFacts(lecture),
            enrollment: enrollment ? enrollmentFacts(enrollment) : null,
            policy,
            prerequisiteCompleted,
            now: now(),
        });
        if (decision.allowed)
            return { allowed: true, enrollment: enrollment };
        return {
            allowed: false,
            status: contentAccessDenialStatus(decision.code),
            code: decision.code,
            error: CONTENT_ERROR_MESSAGES[decision.code],
        };
    };
    /**
     * Staff are confined to their server-selected tenant and, for
     * branch-owned lectures, to a resource-derived branch their principal may
     * actually use. A public/admin path never invents a tenant.
     */
    const enforceStaffScope = async (req, res, lecture) => {
        const principal = req.user;
        if (principal.role !== 'admin') {
            if (!principal.tenantId || lecture.tenant_id === null || lecture.tenant_id !== principal.tenantId) {
                res.status(404).json({ error: 'Lesson not found' });
                return false;
            }
        }
        const decision = await (0, resource_branch_1.resolveResourceBranchAccess)(deps.branchAccess ?? (0, resource_branch_1.getResourceBranchDeps)(), (0, resource_branch_1.principalFromAuthUser)(principal), { resourceType: 'lecture', resourceId: lecture.id, requestedBranchId: req.query?.branch_id });
        if (decision.kind !== 'allowed') {
            const denial = (0, resource_branch_1.resourceBranchDenial)(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };
    const projectLesson = (lecture) => ({
        id: lecture.id,
        course_id: lecture.course_id,
        title: lecture.title,
        description: lecture.description,
        video_url: lecture.video_url,
        duration_minutes: lecture.duration_minutes,
        is_free: Boolean(lecture.is_free),
        is_published: Boolean(lecture.is_published),
        display_order: lecture.display_order,
        grade_id: lecture.grade_id,
        group_id: lecture.group_id,
    });
    /* --------------------------------------------------------------------- */
    /* GET /lessons/:id — direct access (C6/C7 bypass prevention)             */
    /* --------------------------------------------------------------------- */
    router.get('/lessons/:id', async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            const lectureId = normalizeContentId(req.params.id);
            if (!lectureId)
                return res.status(404).json({ error: 'Lesson not found' });
            const lecture = await loadLecture(lectureId);
            if (!lecture)
                return res.status(404).json({ error: 'Lesson not found' });
            if (principal.role === 'student') {
                const outcome = await resolveStudentAccess(principal, lecture);
                if (!outcome.allowed) {
                    return res.status(outcome.status).json({ error: outcome.error, code: outcome.code });
                }
                return res.json(projectLesson(lecture));
            }
            if (!(await enforceStaffScope(req, res, { id: lecture.id, tenant_id: lecture.tenant_id })))
                return;
            return res.json(projectLesson(lecture));
        }
        catch (error) {
            console.error('Content lesson access error:', error);
            res.status(500).json({ error: 'Failed to load lesson' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /courses/:courseId/lessons — scoped list with lock state           */
    /* --------------------------------------------------------------------- */
    router.get('/courses/:courseId/lessons', async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            const courseId = normalizeContentId(req.params.courseId);
            if (!courseId)
                return res.status(404).json({ error: 'Course not found' });
            if (principal.role === 'student') {
                const enrollmentId = principal.studentEnrollmentId;
                const enrollment = enrollmentId ? await loadEnrollment(enrollmentId, principal.id) : null;
                if (!enrollment)
                    return res.status(404).json({ error: 'Course not found' });
                const course = await db.queryOne(COURSE_SCOPE_SQL, [principal.id, courseId]);
                if (!course || course.tenant_id !== enrollment.tenant_id) {
                    return res.status(404).json({ error: 'Course not found' });
                }
                const completed = new Set(await progress.completedLectureIds(enrollment.id, courseId));
                const policyRows = await db.query(POLICY_BY_COURSE_SQL, [courseId]);
                const policyByLecture = new Map(policyRows.map((row) => [row.lecture_id, row]));
                const rows = await db.query(`${COURSE_LESSONS_SQL} AND l.is_published = TRUE ORDER BY l.display_order ASC, l.created_at ASC LIMIT 500`, [courseId, enrollment.tenant_id]);
                const enrollmentFactsValue = enrollmentFacts(enrollment);
                const lessons = [];
                for (const lecture of rows) {
                    const factRow = policyByLecture.get(lecture.id);
                    const policy = (0, content_release_1.buildLessonReleasePolicy)(lecture, factRow ? {
                        lecture_id: factRow.lecture_id,
                        course_id: courseId,
                        tenant_id: enrollment.tenant_id,
                        release_mode: factRow.release_mode,
                        release_at: factRow.release_at,
                        release_timezone: factRow.release_timezone,
                        prerequisite_lecture_id: factRow.prerequisite_lecture_id,
                        released_at: factRow.released_at,
                    } : null);
                    const prerequisiteCompleted = policy.prerequisiteLectureId !== null
                        && completed.has(policy.prerequisiteLectureId);
                    const decision = evaluateContentAccess({
                        isStaff: false,
                        lecture: lectureFacts(lecture),
                        enrollment: enrollmentFactsValue,
                        policy,
                        prerequisiteCompleted,
                        now: now(),
                    });
                    if (decision.allowed) {
                        lessons.push({ ...projectLesson(lecture), locked: false });
                        continue;
                    }
                    if (decision.code === 'NOT_YET_RELEASED' || decision.code === 'PREREQUISITE_REQUIRED') {
                        lessons.push({ ...projectLesson(lecture), locked: true, lock_reason: decision.code });
                    }
                    // Out-of-audience / unpublished / branch / archived lessons
                    // are omitted entirely (no metadata enumeration).
                }
                return res.json(lessons);
            }
            const course = await db.queryOne(COURSE_SCOPE_SQL, [principal.id, courseId]);
            if (!course)
                return res.status(404).json({ error: 'Course not found' });
            if (!(await enforceStaffScope(req, res, { id: courseId, tenant_id: course.tenant_id })))
                return;
            const rows = await db.query(`${COURSE_LESSONS_SQL} ORDER BY l.display_order ASC, l.created_at ASC LIMIT 500`, [courseId, course.tenant_id]);
            return res.json(rows.map((lecture) => ({ ...projectLesson(lecture), locked: false })));
        }
        catch (error) {
            console.error('Content course lessons error:', error);
            res.status(500).json({ error: 'Failed to load course lessons' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /lessons/:id/complete — C7 completion record (idempotent)         */
    /* --------------------------------------------------------------------- */
    router.post('/lessons/:id/complete', async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (principal.role !== 'student')
                return res.status(403).json({ error: 'Student access required' });
            const lectureId = normalizeContentId(req.params.id);
            if (!lectureId)
                return res.status(404).json({ error: 'Lesson not found' });
            const lecture = await loadLecture(lectureId);
            if (!lecture)
                return res.status(404).json({ error: 'Lesson not found' });
            const outcome = await resolveStudentAccess(principal, lecture);
            if (!outcome.allowed) {
                return res.status(outcome.status).json({ error: outcome.error, code: outcome.code });
            }
            const result = await runAtomic(async (tx) => {
                const txProgress = (0, lesson_progress_1.createLessonProgressService)(tx);
                const recorded = await txProgress.recordCompletion({
                    tenantId: lecture.tenant_id,
                    studentEnrollmentId: outcome.enrollment.id,
                    courseId: lecture.course_id,
                    lectureId: lecture.id,
                    source: 'student',
                });
                if (recorded.created) {
                    await (0, audit_1.recordAudit)(tx.execute, {
                        actorUserId: principal.id,
                        tenantId: lecture.tenant_id,
                        action: 'lesson.completion',
                        resourceType: 'lecture',
                        resourceId: lecture.id,
                        newValue: (0, audit_1.snapshotRow)({
                            student_enrollment_id: outcome.enrollment.id,
                            course_id: lecture.course_id,
                        }),
                    });
                }
                return recorded;
            });
            res.json({ status: 'completed', created: result.created });
        }
        catch (error) {
            console.error('Lesson completion error:', error);
            res.status(500).json({ error: 'Failed to record lesson completion' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* PUT /releases/:lectureId — configure C6/C7 release policy               */
    /* --------------------------------------------------------------------- */
    router.put('/releases/:lectureId', async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (principal.role === 'student')
                return res.status(403).json({ error: 'Release configuration access required' });
            const lectureId = normalizeContentId(req.params.lectureId);
            if (!lectureId)
                return res.status(404).json({ error: 'Lesson not found' });
            const authority = await db.queryOne(RELEASE_AUTHORITY_SQL, [principal.id, lectureId]);
            if (!authority)
                return res.status(404).json({ error: 'Lesson not found' });
            const isOwner = Boolean(authority.is_owner) || authority.instructor_id === principal.id || principal.role === 'admin';
            if (!isOwner)
                return res.status(403).json({ error: 'Release configuration access required' });
            if (!(await enforceStaffScope(req, res, { id: authority.id, tenant_id: authority.tenant_id })))
                return;
            const validated = validateReleaseConfig(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            if (validated.value.prerequisiteLectureId !== null && validated.value.prerequisiteLectureId === lectureId) {
                return res.status(400).json({ error: 'A lesson cannot be its own prerequisite' });
            }
            if (validated.value.prerequisiteLectureId !== null) {
                const prerequisite = await db.queryOne(`SELECT l.id, l.course_id, c.tenant_id
                     FROM lectures l
                     INNER JOIN courses c ON c.id = l.course_id
                     WHERE l.id = ? LIMIT 1`, [validated.value.prerequisiteLectureId]);
                if (!prerequisite ||
                    prerequisite.tenant_id !== authority.tenant_id ||
                    prerequisite.course_id !== authority.course_id) {
                    return res.status(400).json({ error: 'prerequisite_lecture_id must belong to the same tenant and course' });
                }
            }
            const releasedAt = validated.value.releaseMode === 'scheduled' ? null : (0, content_release_1.toUtcIso)(new Date());
            const result = await runAtomic(async (tx) => {
                await tx.execute(`INSERT INTO lesson_release_policies
                       (lecture_id, tenant_id, course_id, release_mode, release_at, release_timezone, prerequisite_lecture_id, released_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       release_mode = VALUES(release_mode),
                       release_at = VALUES(release_at),
                       release_timezone = VALUES(release_timezone),
                       prerequisite_lecture_id = VALUES(prerequisite_lecture_id),
                       released_at = CASE WHEN VALUES(release_mode) = 'scheduled' THEN NULL ELSE UTC_TIMESTAMP() END,
                       version = version + 1`, [
                    lectureId,
                    authority.tenant_id,
                    authority.course_id,
                    validated.value.releaseMode,
                    validated.value.releaseAtUtc === null ? null : validated.value.releaseAtUtc.slice(0, 19).replace('T', ' '),
                    validated.value.releaseTimeZone,
                    validated.value.prerequisiteLectureId,
                    releasedAt === null ? null : releasedAt.slice(0, 19).replace('T', ' '),
                ]);
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: principal.id,
                    tenantId: authority.tenant_id,
                    action: 'content.release.configured',
                    resourceType: 'lecture',
                    resourceId: lectureId,
                    newValue: (0, audit_1.snapshotRow)({
                        release_mode: validated.value.releaseMode,
                        release_at_utc: validated.value.releaseAtUtc,
                        release_time_zone: validated.value.releaseTimeZone,
                        prerequisite_lecture_id: validated.value.prerequisiteLectureId,
                    }),
                });
                return { ok: true };
            });
            res.json({
                status: 'configured',
                lecture_id: lectureId,
                release_mode: validated.value.releaseMode,
                release_at_utc: validated.value.releaseAtUtc,
                release_time_zone: validated.value.releaseTimeZone,
                prerequisite_lecture_id: validated.value.prerequisiteLectureId,
                audited: result.ok,
            });
        }
        catch (error) {
            console.error('Configure release error:', error);
            res.status(500).json({ error: 'Failed to configure release' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /courses/:courseId/releases/run — materialize due releases        */
    /* --------------------------------------------------------------------- */
    router.post('/courses/:courseId/releases/run', async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (principal.role === 'student')
                return res.status(403).json({ error: 'Release runner access required' });
            const courseId = normalizeContentId(req.params.courseId);
            if (!courseId)
                return res.status(404).json({ error: 'Course not found' });
            const course = await db.queryOne(COURSE_SCOPE_SQL, [principal.id, courseId]);
            if (!course)
                return res.status(404).json({ error: 'Course not found' });
            const authorized = Boolean(course.is_owner) || course.instructor_id === principal.id || principal.role === 'admin';
            if (!authorized)
                return res.status(403).json({ error: 'Release runner access required' });
            if (!(await enforceStaffScope(req, res, { id: courseId, tenant_id: course.tenant_id })))
                return;
            const nowMysql = toMysqlUtc(now());
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(`UPDATE lesson_release_policies p
                     INNER JOIN lectures l ON l.id = p.lecture_id
                     INNER JOIN courses c ON c.id = l.course_id
                     SET p.released_at = UTC_TIMESTAMP(), p.version = p.version + 1
                     WHERE p.course_id = ? AND c.tenant_id = ?
                       AND p.release_mode = 'scheduled' AND p.released_at IS NULL
                       AND p.release_at IS NOT NULL AND p.release_at <= ?`, [courseId, course.tenant_id, nowMysql]);
                const released = updated.affectedRows ?? 0;
                if (released > 0) {
                    await (0, audit_1.recordAudit)(tx.execute, {
                        actorUserId: principal.id,
                        tenantId: course.tenant_id,
                        action: 'content.release.run',
                        resourceType: 'course',
                        resourceId: courseId,
                        newValue: (0, audit_1.snapshotRow)({ released }),
                    });
                }
                return { released };
            });
            res.json({ released: result.released });
        }
        catch (error) {
            console.error('Release runner error:', error);
            res.status(500).json({ error: 'Failed to run scheduled releases' });
        }
    });
    return router;
}
/** Production wiring: real pool, real auth, real resource-branch deps. */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
exports.default = createContentAccessRouter({
    db: {
        query: async (sql, params) => {
            const { query } = await loadDb();
            return query(sql, params);
        },
        queryOne: async (sql, params) => {
            const { queryOne } = await loadDb();
            return queryOne(sql, params);
        },
        execute: async (sql, params) => {
            const { execute } = await loadDb();
            return execute(sql, params);
        },
    },
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
});
