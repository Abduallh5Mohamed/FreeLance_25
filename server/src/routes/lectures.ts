import { Router, Response, RequestHandler } from 'express';
import { query, queryOne, execute, getPool } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { optionalAuth, instructorScopeId, authenticateToken, AuthRequest } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import {
    getResourceBranchDeps,
    principalFromAuthUser,
    resolveResourceBranchAccess,
    resourceBranchDenial,
    type ResourceBranchDeps,
} from '../security/resource-branch';
import { recordAudit, snapshotRow } from '../security/audit';
import { validateVideoBinding, parseVideoReference, type VideoBindingDecision } from '../security/video-access-policy';
import { getAdminPermissions, isSuperAdmin } from '../security/admin-permissions';

interface Lecture {
    id: string;
    course_id: string;
    grade_id?: string;
    group_id?: string;
    title: string;
    description?: string;
    video_url: string;
    duration_minutes?: number;
    price?: number;
    display_order?: number;
    is_free: boolean;
    is_published: boolean;
    created_at?: Date;
    updated_at?: Date;
    course_name?: string;
    course_subject?: string;
    grade_name?: string;
    group_name?: string;
}

/**
 * Data seam for the lecture CRUD/list/publish handlers. Production answers
 * from MySQL through ../db; hermetic tests inject isolated fixtures so no
 * database, environment or service is contacted while exercising the real
 * handlers.
 */
export interface LectureDataAccess {
    query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    execute: (sql: string, params?: any[]) => Promise<{ insertId: number; affectedRows: number }>;
}

export interface LectureRouterDeps {
    db: LectureDataAccess;
    optionalAuthenticate: RequestHandler;
    authenticate: RequestHandler;
    requireTeachingWriteAccess: RequestHandler;
    /** Resource-derived branch authority; defaults to the production SQL deps. */
    branchAccess?: ResourceBranchDeps;
    /**
     * Run `fn` inside a single DB transaction. Production wires this to a real
     * pool connection; hermetic tests inject a no-op that just invokes `fn`
     * with the same injected data access so reorder/atomic writes stay testable
     * without a live database.
     */
    transaction?: <T>(fn: (tx: LectureDataAccess) => Promise<T>) => Promise<T>;
    /**
     * Verified platform capability (active super_admin or a seeded permission
     * key). Defaults to deny so an injected harness never grants a
     * platform-wide path by omission.
     */
    hasVerifiedPlatformCapability?: (userId: string) => Promise<boolean>;
}

/**
 * Build the lectures router over injected dependencies. Production wiring
 * (default export) passes the real pool, the real optional/strict auth
 * middleware and the real teaching-entitlement guard; hermetic tests pass
 * the same middleware over injected fixture repositories.
 */
/**
 * Pure reorder planner: validates an ordered list of lecture ids against the
 * set that currently exists in the caller's course. Rejects duplicates, ids that
 * are not part of the course (conflicting/forged), and lists that omit a current
 * lecture (stale/partial). Returns 1-based display_order assignments. No I/O, so
 * it is fully unit-testable independent of a database.
 */
export type LectureReorderPlan =
    | { ok: true; assignments: { id: string; display_order: number }[] }
    | { ok: false; status: number; error: string };

export function planLectureReorder(
    existing: ReadonlyArray<{ id: string }>,
    orderedIds: unknown,
): LectureReorderPlan {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return { ok: false, status: 400, error: 'An ordered list of lecture ids is required' };
    }
    const existingIds = new Set(existing.map((row) => row.id));
    const seen = new Set<string>();
    for (const rawId of orderedIds) {
        if (typeof rawId !== 'string' || rawId.length === 0) {
            return { ok: false, status: 400, error: 'Each lecture id must be a non-empty string' };
        }
        if (seen.has(rawId)) {
            return { ok: false, status: 409, error: 'Duplicate lecture id in reorder list' };
        }
        seen.add(rawId);
        if (!existingIds.has(rawId)) {
            return { ok: false, status: 409, error: 'Lecture id is not part of this course' };
        }
    }
    if (seen.size !== existingIds.size) {
        return { ok: false, status: 409, error: 'Reorder list must include every lecture in the course' };
    }
    return {
        ok: true,
        assignments: orderedIds.map((id, index) => ({ id, display_order: index + 1 })),
    };
}

export const createLectureRouter = (deps: LectureRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    const optionalAuthenticate = deps.optionalAuthenticate;
    const authenticateToken = deps.authenticate;
    const requireTeachingWriteAccess = deps.requireTeachingWriteAccess;
    const hasPlatformCapability = deps.hasVerifiedPlatformCapability ?? (async () => false);

    /**
     * Write-time check of a `video://` association. Runs on the transaction
     * reader so the video row is read `FOR UPDATE` and the conflict probe sees
     * the same snapshot as the write; the referenced video must exist, belong
     * to the caller's server-selected tenant, be authorized by the existing
     * playback policy, and live in the SAME tenant as the destination course.
     * `targetCourseId` is the server-derived course for a create; on update it
     * is omitted so the destination is re-read from the lecture row.
     */
    const validateLectureVideoBinding = (
        tx: LectureDataAccess,
        req: AuthRequest,
        videoUrl: unknown,
        lectureId: string,
        targetCourseId?: string | null,
    ): Promise<VideoBindingDecision> => validateVideoBinding({
        reader: tx,
        videoUrl: String(videoUrl),
        actorUserId: req.user?.id ?? '',
        actorTenantId: req.user?.tenantId,
        actorStudentEnrollmentId: req.user?.studentEnrollmentId,
        selfId: lectureId,
        target: 'lecture',
        targetCourseId,
        hasPlatformCapability,
    });
    const getMutationScope = (req: AuthRequest) => {
        const instructorId = instructorScopeId(req);
        if (instructorId) {
            return {
                readPredicate: 'l.instructor_id = ?',
                writePredicate: 'instructor_id = ?',
                value: instructorId,
            };
        }
        const tenantId = req.user?.tenantId;
        if (tenantId) {
            return {
                readPredicate: 'c.tenant_id = ?',
                writePredicate: 'EXISTS (SELECT 1 FROM courses scoped_course WHERE scoped_course.id = lectures.course_id AND scoped_course.tenant_id = ?)',
                value: tenantId,
            };
        }
        return null;
    };

    /**
     * Resource-derived branch check for an existing lecture. The branch comes
     * from lectures.group_id -> groups; a group-less lecture is explicitly
     * tenant-level (its course tenant is enforced by the existing scope).
     */
    const enforceLectureBranch = async (
        req: AuthRequest,
        res: Response,
        lectureId: string,
        requestedBranchId?: unknown,
    ): Promise<boolean> => {
        // Public marketplace reads are anonymous by design; there is no
        // principal to bind to a branch. Authenticated reads are enforced.
        if (!req.user) return true;
        const decision = await resolveResourceBranchAccess(
            deps.branchAccess ?? getResourceBranchDeps(),
            principalFromAuthUser(req.user),
            { resourceType: 'lecture', resourceId: lectureId, requestedBranchId },
        );
        if (decision.kind !== 'allowed') {
            const denial = resourceBranchDenial(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };

    /**
     * A lecture may only be created into a group whose branch the caller may
     * actually use. No selector is accepted as authority.
     */
    const validateLectureGroupBranch = async (
        user: NonNullable<AuthRequest['user']>,
        groupId: unknown,
    ): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
        if (groupId === undefined || groupId === null || groupId === '') return { ok: true };
        if (typeof groupId !== 'string') return { ok: false, status: 400, error: 'Invalid group' };
        const group = await queryOne<{
            id: string; branch_id: string | null; branch_scope: string | null;
        }>('SELECT id, branch_id, branch_scope FROM `groups` WHERE id = ?', [groupId]);
        if (!group) return { ok: false, status: 404, error: 'Group not found' };
        if (group.branch_scope !== 'branch') return { ok: true };
        if (!group.branch_id) return { ok: false, status: 403, error: 'Branch context is ambiguous' };
        const tenantId = user.tenantId;
        if (!tenantId) return { ok: false, status: 403, error: 'Workspace access required' };
        const branch = await queryOne<{ tenant_id: string; status: string }>(
            'SELECT tenant_id, status FROM branches WHERE id = ?', [group.branch_id],
        );
        if (!branch || branch.tenant_id !== tenantId || branch.status !== 'active') {
            return { ok: false, status: 403, error: 'Branch is outside your teaching scope' };
        }
        const owner = await queryOne<{ id: string }>(
            "SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'",
            [tenantId, user.id],
        );
        if (!owner) {
            const membership = await queryOne<{ id: string }>(
                "SELECT id FROM branch_memberships WHERE branch_id = ? AND user_id = ? AND status = 'active'",
                [group.branch_id, user.id],
            );
            if (!membership) return { ok: false, status: 403, error: 'Branch membership required' };
        }
        return { ok: true };
    };

    router.use(optionalAuthenticate);

    // Get all lectures (published by default)
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const { course_id, group_id, grade_id } = req.query;
            const scopeId = instructorScopeId(req);
            const tenantId = req.user?.tenantId;
            if (req.user && !scopeId && !tenantId) {
                return res.json([]);
            }

            let sql = `
                SELECT
                    l.id,
                    l.course_id,
                    l.grade_id,
                    l.group_id,
                    l.title,
                    l.description,
                    l.duration_minutes,
                    l.price,
                    l.is_free,
                    l.is_published,
                    l.display_order,
                    c.name as course_name,
                    c.subject as course_subject,
                    gr.name as grade_name,
                    g.name as group_name
                FROM lectures l
                LEFT JOIN courses c ON l.course_id = c.id
                LEFT JOIN grades gr ON l.grade_id = gr.id
                LEFT JOIN \`groups\` g ON l.group_id = g.id
                WHERE l.is_published = TRUE
            `;
            const params: any[] = [];

            // Instructors see their own lectures; other authenticated callers
            // are confined to their server-selected tenant. Anonymous discovery
            // remains published-only for the public marketplace.
            if (scopeId) {
                sql += ' AND l.instructor_id = ?';
                params.push(scopeId);
            } else if (tenantId) {
                sql += ' AND c.tenant_id = ?';
                params.push(tenantId);
            }

            if (course_id && typeof course_id === 'string') {
                sql += ' AND l.course_id = ?';
                params.push(course_id);
            }

            if (grade_id && typeof grade_id === 'string') {
                sql += ' AND l.grade_id = ?';
                params.push(grade_id);
            }

            if (group_id && typeof group_id === 'string') {
                sql += ' AND (l.group_id = ? OR l.group_id IS NULL)';
                params.push(group_id);
            }

            // Branch-owned lectures are visible only to a live member of the
            // derived branch or the tenant owner; group-less lectures stay
            // tenant-level under the existing course-tenant scope.
            if (req.user && req.user.role !== 'admin') {
                sql += ` AND (l.group_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM \`groups\` bg
                    WHERE bg.id = l.group_id AND bg.branch_scope = 'branch'
                      AND NOT EXISTS (
                        SELECT 1 FROM branch_memberships bm
                        WHERE bm.branch_id = bg.branch_id AND bm.user_id = ? AND bm.status = 'active'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tenants owner_t
                        WHERE owner_t.id = ? AND owner_t.owner_user_id = ? AND owner_t.status = 'active'
                      )
                ))`;
                params.push(req.user.id, req.user.tenantId ?? null, req.user.id);
                if (req.user.branchId) {
                    sql += ` AND (l.group_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM \`groups\` bg2
                        WHERE bg2.id = l.group_id AND bg2.branch_scope = 'branch' AND bg2.branch_id <> ?
                    ))`;
                    params.push(req.user.branchId);
                }
            }

            sql += ' ORDER BY l.display_order ASC, l.created_at DESC';

            const lectures = await query(sql, params);
            console.log(`[Lectures] GET / - Found ${lectures?.length || 0} lectures`);
            res.json(lectures);
        } catch (error) {
            console.error('Get lectures error:', error);
            res.status(500).json({ error: 'Failed to fetch lectures' });
        }
    });

    // Get lectures for a specific student based on their group
    router.get('/student/:userId', async (req: AuthRequest, res: Response) => {
        try {
            const { userId } = req.params;

            // A student may only read its own workspace, addressed either by
            // its users id or its server-selected enrollment id. Anonymous
            // callers, instructors and other students are denied before any
            // data access, so the route cannot be used to enumerate another
            // workspace by a forged path id.
            const principal = req.user;
            if (!principal) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            const addressesSelf =
                principal.role === 'student' &&
                (userId === principal.id ||
                    (!!principal.studentEnrollmentId && userId === principal.studentEnrollmentId));
            if (!addressesSelf) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }

            console.log(`[Lectures] Looking up student for userId: ${userId}`);

            // First, get user info to find their phone
            const userRecord = await queryOne(
                'SELECT id, phone, role FROM users WHERE id = ? AND role = "student"',
                [userId]
            );

            if (!userRecord || !userRecord.phone) {
                console.log(`[Lectures] User not found or has no phone: ${userId}`);
                return res.json([]);
            }

            console.log(`[Lectures] Found user with phone: ${userRecord.phone}`);

            // Find student by phone (students table has phone directly). Defense in
            // depth: only an approved, currently-active enrollment (not revoked or
            // past its end date) may read protected lecture content, independent of
            // any stale JWT the caller may still carry.
            const student = await queryOne(
                `SELECT id, name, phone, group_id, grade_id, instructor_id
                 FROM students
                 WHERE phone = ? AND is_active = TRUE
                   AND approval_status = 'approved'
                   AND (enrollment_status IS NULL OR enrollment_status = 'active')
                   AND (enrollment_end_date IS NULL OR enrollment_end_date > UTC_TIMESTAMP())`,
                [userRecord.phone]
            );

            if (!student) {
                console.log(`[Lectures] Student not found for phone: ${userRecord.phone}`);
                return res.json([]);
            }

            console.log(`[Lectures] Found student: ${student.name} (grade: ${student.grade_id}, group: ${student.group_id})`);

            // Get lectures for student's grade and group
            let sql = `
                SELECT
                    l.*,
                    c.name as course_name,
                    c.subject as course_subject,
                    gr.name as grade_name,
                    g.name as group_name
                FROM lectures l
                LEFT JOIN courses c ON l.course_id = c.id
                LEFT JOIN grades gr ON l.grade_id = gr.id
                LEFT JOIN \`groups\` g ON l.group_id = g.id
                WHERE 1=1
            `;

            const params: any[] = [];
            const conditions: string[] = [];

            // Filter by grade if student has one
            if (student.grade_id) {
                conditions.push('l.grade_id = ?');
                params.push(student.grade_id);
            }

            // Filter by group if student has one
            if (student.group_id) {
                conditions.push('l.group_id = ?');
                params.push(student.group_id);
            }

            const audienceSql = conditions.length > 0 ? '(' + conditions.join(' OR ') + ')' : 'TRUE';
            const audienceParams = [...params];
            params.length = 0;
            sql += ` AND (
              (l.is_published=TRUE AND (l.instructor_id IS NULL OR l.instructor_id=?) AND ${audienceSql})
              OR EXISTS (
                SELECT 1 FROM instructor_shared_lectures sl
                INNER JOIN instructor_shared_lecture_publications pub ON pub.shared_lecture_id=sl.id
                WHERE sl.lecture_id=l.id AND sl.instructor_id=? AND sl.is_published=1 AND pub.group_id=?
              )
            )`;
            params.push(student.instructor_id || null, ...audienceParams, student.instructor_id || null, student.group_id || '');

            sql += ' ORDER BY l.display_order ASC, l.created_at DESC';

            const lectures = await query(sql, params);

            console.log(`[Lectures] Student ${userId} (grade: ${student.grade_id}, group: ${student.group_id}) - Found ${lectures?.length || 0} lectures`);
            res.json(lectures);
        } catch (error) {
            console.error('Get student lectures error:', error);
            res.status(500).json({ error: 'Failed to fetch student lectures' });
        }
    });

    // Get lecture by ID
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const tenantId = req.user?.tenantId;
            if (req.user && !scopeId && !tenantId) {
                return res.status(404).json({ error: 'Lecture not found' });
            }

            const visibilityPredicate = scopeId
                ? 'l.instructor_id = ?'
                : req.user
                    ? 'c.tenant_id = ? AND l.is_published = TRUE'
                    : 'l.is_published = TRUE';
            const params: string[] = [req.params.id];
            if (scopeId) params.push(scopeId);
            else if (req.user && tenantId) params.push(tenantId);

            const lecture = await queryOne(
                `SELECT
                    l.*,
                    c.name as course_name,
                    c.subject as course_subject,
                    gr.name as grade_name,
                    g.name as group_name
                FROM lectures l
                INNER JOIN courses c ON l.course_id = c.id
                LEFT JOIN grades gr ON l.grade_id = gr.id
                LEFT JOIN \`groups\` g ON l.group_id = g.id
                WHERE l.id = ? AND ${visibilityPredicate}`,
                params
            );

            if (!lecture) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            // Drafts are visible only to their server-verified owning instructor;
            // non-instructors and anonymous callers are filtered in SQL.
            const isOwner = scopeId !== null && lecture.instructor_id === scopeId;
            if (!lecture.is_published && !isOwner) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            if (!(await enforceLectureBranch(req, res, req.params.id, req.query?.branch_id))) return;

            res.json(lecture);
        } catch (error) {
            console.error('Get lecture error:', error);
            res.status(500).json({ error: 'Failed to fetch lecture' });
        }
    });

    // Create new lecture
    router.post('/', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const {
                course_id,
                grade_id,
                group_id,
                instructor_id,
                title,
                description,
                video_url,
                duration_minutes,
                price,
                display_order = 0,
                is_free = false,
                is_published = true
            } = req.body;

            // The owner comes from the authenticated principal, never a
            // caller-supplied instructor_id (the legacy platform-admin path
            // remains unchanged).
            const ownerId = scopeId || (req.user?.role === 'admin' ? instructor_id || null : req.user?.id || null);

            if (!title || !video_url) {
                return res.status(400).json({
                    error: 'Title and video_url are required'
                });
            }

            // One canonical reference rule for every write path: `video://`
            // followed by a non-empty id with no whitespace. A non-canonical
            // value is refused here, before any write (including the default
            // course), and is never stored raw.
            const videoReference = parseVideoReference(String(video_url));
            if (!videoReference.ok) {
                return res.status(400).json({
                    error: videoReference.reason === 'not-a-reference'
                        ? 'External video links are not allowed. Upload the video to the platform.'
                        : 'Video link is not a canonical platform video reference',
                });
            }
            if (scopeId && (!Number.isFinite(Number(price)) || Number(price) <= 0)) {
                return res.status(400).json({ error: 'Instructor videos must have a positive price' });
            }

            // If no course_id provided, create a default course for the instructor
            let actualCourseId = course_id;

            // Tenant members may only bind a lecture to a course in their
            // server-selected workspace. The legacy platform-admin path stays
            // platform-wide; ordinary role claims never supply the tenant.
            if (req.user?.role !== 'admin' && actualCourseId) {
                const selectedTenant = req.user?.tenantId;
                if (!selectedTenant) {
                    return res.status(403).json({ error: 'Course not found in your workspace' });
                }
                const owned = await queryOne<{ id: string }>(
                    'SELECT id FROM courses WHERE id = ? AND tenant_id = ?',
                    [actualCourseId, selectedTenant]
                );
                if (!owned) {
                    return res.status(403).json({ error: 'Course not found in your workspace' });
                }
            }

            if (!actualCourseId && ownerId) {
                const selectedTenant = req.user?.tenantId;
                if (!selectedTenant) {
                    return res.status(403).json({ error: 'Course not found in your workspace' });
                }
                // Keep a default course confined to the caller's selected
                // tenant and server-derived owner.
                let defaultCourse = await queryOne(
                    `SELECT id FROM courses WHERE name=? AND instructor_id=? AND tenant_id=? LIMIT 1`,
                    ['فيديوهاتي', ownerId, selectedTenant]
                );
                if (!defaultCourse) {
                    const courseId = uuidv4();
                    await execute(
                        `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,is_active)
                         VALUES (?,?,?,?,?,?,TRUE)`,
                        [courseId, selectedTenant, ownerId, 'فيديوهاتي', 'عام', 'فيديوهاتي خاصة بالمحاضر']
                    );
                    actualCourseId = courseId;
                } else {
                    actualCourseId = defaultCourse.id;
                }
            }

            if (!actualCourseId) {
                return res.status(400).json({
                    error: 'Course ID is required'
                });
            }

            // A lecture's branch is derived from its group; a caller cannot
            // assign an unauthorized branch and a bare selector is not
            // authority.
            const groupBranchValidation = await validateLectureGroupBranch(req.user!, group_id);
            if (!groupBranchValidation.ok) {
                return res.status(groupBranchValidation.status).json({ error: groupBranchValidation.error });
            }
            if (req.body.branch_id !== undefined && req.body.branch_id !== null && req.body.branch_id !== ''
                && !group_id) {
                return res.status(403).json({ error: 'Branch is derived from the lecture group' });
            }

            console.log('[Lectures] Creating lecture:', { course_id: actualCourseId, grade_id, group_id, instructor_id: ownerId, title, video_url });

            const lectureId = uuidv4();
            if (!deps.transaction) throw new Error('Lecture creation requires transactional data access');
            const outcome = await deps.transaction(async (tx) => {
                // A `video://` link is only accepted once the video is proven
                // to exist, belong to this workspace and be usable by the
                // caller, and is not already bound elsewhere.
                const binding = await validateLectureVideoBinding(tx, req, video_url, lectureId, actualCourseId);
                if (!binding.ok) return { kind: 'denied' as const, binding };

                await tx.execute(
                `INSERT INTO lectures
                (id, course_id, grade_id, group_id, instructor_id, title, description, video_url, duration_minutes, price, display_order, is_free, is_published)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    lectureId,
                    actualCourseId,
                    grade_id || null,
                    group_id || null,
                    ownerId,
                    title,
                    description || null,
                    binding.videoUrl,
                    duration_minutes || null,
                    scopeId ? Number(price) : (price ?? null),
                    display_order,
                    is_free,
                    is_published
                ]
                );

                await recordAudit(tx.execute, {
                    actorUserId: req.user?.id ?? null,
                    tenantId: req.user?.tenantId ?? null,
                    action: 'lecture.create',
                    resourceType: 'lecture',
                    resourceId: lectureId,
                    newValue: snapshotRow({
                        course_id: actualCourseId, grade_id, group_id, instructor_id: ownerId,
                        title, description, video_url, duration_minutes, price, display_order, is_free, is_published,
                    }),
                });
                return { kind: 'created' as const };
            });

            if (outcome.kind === 'denied') {
                return res.status(outcome.binding.status).json({
                    error: outcome.binding.error,
                    code: outcome.binding.code,
                });
            }

            const newLecture = await queryOne(
                'SELECT * FROM lectures WHERE id = ?',
                [lectureId]
            );

            console.log('[Lectures] Created lecture:', newLecture?.id);
            res.status(201).json(newLecture);
        } catch (error) {
            console.error('Create lecture error:', error);
            res.status(500).json({ error: 'Failed to create lecture' });
        }
    });

    // Reorder lectures within a course. Registered before PUT /:id so the static
    // segment is not captured by the :id param route.
    router.put('/reorder', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const tenantId = req.user?.tenantId;
            const courseId = typeof req.body?.course_id === 'string' ? req.body.course_id : '';
            const orderedIds = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids : [];
            if (!courseId) return res.status(400).json({ error: 'course_id is required' });

            // Course and lecture set must be read under the same transaction as
            // writes. Otherwise a concurrent create/archive can make the list
            // stale after validation and leave a partial order behind.
            if (!deps.transaction) throw new Error('Lecture reorder requires transactional data access');
            const outcome = await deps.transaction(async (tx) => {
                const course = await tx.queryOne<{ id: string }>(
                    scopeId
                        ? 'SELECT id FROM courses WHERE id=? AND instructor_id=? FOR UPDATE'
                        : 'SELECT id FROM courses WHERE id=? AND tenant_id=? FOR UPDATE',
                    scopeId ? [courseId, scopeId] : [courseId, tenantId ?? '']
                );
                if (!course) return { kind: 'missing' as const };

                const existing = await tx.query<{ id: string }>(
                    scopeId
                        ? 'SELECT id FROM lectures WHERE course_id=? AND instructor_id=? AND archived_at IS NULL ORDER BY id FOR UPDATE'
                        : 'SELECT id FROM lectures WHERE course_id=? AND EXISTS (SELECT 1 FROM courses c WHERE c.id=lectures.course_id AND c.tenant_id=?) AND archived_at IS NULL ORDER BY id FOR UPDATE',
                    scopeId ? [courseId, scopeId] : [courseId, tenantId ?? '']
                );
                const plan = planLectureReorder(existing, orderedIds);
                if (!plan.ok) return { kind: 'conflict' as const, plan };

                // A reorder is a course-level mutation. Every included lecture
                // must independently resolve to an authorized tenant/branch;
                // tenant membership alone cannot reorder another branch's rows.
                for (const { id } of existing) {
                    if (!(await enforceLectureBranch(req, res, id))) {
                        return { kind: 'denied' as const };
                    }
                }

                let count = 0;
                for (const assignment of plan.assignments) {
                    const result = await tx.execute(
                        'UPDATE lectures SET display_order=? WHERE id=? AND course_id=? AND archived_at IS NULL',
                        [assignment.display_order, assignment.id, courseId]
                    );
                    if (result.affectedRows) count += 1;
                }
                if (count !== plan.assignments.length) {
                    throw new Error('Lecture set changed while applying reorder');
                }
                await recordAudit(tx.execute, {
                    actorUserId: req.user?.id ?? null,
                    tenantId: tenantId ?? null,
                    action: 'lecture.reorder',
                    resourceType: 'course',
                    resourceId: courseId,
                    newValue: { ordered_ids: plan.assignments.map((a) => a.id) },
                });
                return { kind: 'updated' as const, updated: count, plan };
            });

            if (outcome.kind === 'missing') return res.status(404).json({ error: 'Course not found in your workspace' });
            if (outcome.kind === 'conflict') return res.status(outcome.plan.status).json({ error: outcome.plan.error });
            if (outcome.kind === 'denied') return;

            res.json({ ok: true, updated: outcome.updated });
        } catch (error) {
            console.error('Reorder lectures error:', error);
            res.status(500).json({ error: 'Failed to reorder lectures' });
        }
    });

    // Update lecture
    router.put('/:id', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const mutationScope = getMutationScope(req);
            if (!mutationScope) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            const existing = await queryOne<{
                id: string; instructor_id: string | null; video_url: string; archived_at: Date | string | null;
            }>(
                `SELECT l.id, l.instructor_id, l.video_url, l.archived_at
                 FROM lectures l
                 INNER JOIN courses c ON c.id = l.course_id
                 WHERE l.id = ? AND ${mutationScope.readPredicate}`,
                [req.params.id, mutationScope.value]
            );
            if (!existing) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            if (existing.archived_at) {
                return res.status(410).json({ error: 'Archived lectures cannot be changed or republished' });
            }
            if (!(await enforceLectureBranch(req, res, req.params.id, req.body?.branch_id))) return;
            const {
                title,
                description,
                video_url,
                duration_minutes,
                price,
                display_order,
                is_free,
                is_published
            } = req.body;

            if (scopeId && price !== undefined && (!Number.isFinite(Number(price)) || Number(price) <= 0)) {
                return res.status(400).json({ error: 'Video price must be greater than zero' });
            }
            if (video_url !== undefined) {
                const videoReference = parseVideoReference(String(video_url));
                if (!videoReference.ok) {
                    return res.status(400).json({
                        error: videoReference.reason === 'not-a-reference'
                            ? 'External video links are not allowed. Upload the video to the platform.'
                            : 'Video link is not a canonical platform video reference',
                    });
                }
                const licensed = await queryOne('SELECT id FROM instructor_shared_lectures WHERE lecture_id=? LIMIT 1', [req.params.id]);
                if (licensed && existing.video_url !== video_url) {
                    return res.status(409).json({ error: 'The video file cannot be replaced after access has been sold' });
                }
            }

            if (!deps.transaction) throw new Error('Lecture update requires transactional data access');
            const outcome = await deps.transaction(async (tx) => {
                const current = await tx.queryOne<{
                    id: string; instructor_id: string | null; video_url: string; archived_at: Date | string | null;
                }>(
                    `SELECT l.id, l.instructor_id, l.video_url, l.archived_at
                     FROM lectures l
                     INNER JOIN courses c ON c.id = l.course_id
                     WHERE l.id = ? AND ${mutationScope.readPredicate} FOR UPDATE`,
                    [req.params.id, mutationScope.value]
                );
                if (!current) return { kind: 'missing' as const };
                if (current.archived_at) return { kind: 'archived' as const };

                // Only a NEW association is validated: an update that leaves
                // video_url untouched does not re-bind and must not be blocked
                // by a legacy link that predates this check. When it does
                // change, the destination course is re-read from the lecture
                // row inside this transaction, so a moved course re-proves the
                // tenant binding.
                let storedVideoUrl = video_url;
                if (video_url !== undefined && String(video_url) !== String(current.video_url ?? '')) {
                    const binding = await validateLectureVideoBinding(tx, req, video_url, req.params.id);
                    if (!binding.ok) return { kind: 'bindingDenied' as const, binding };
                    storedVideoUrl = binding.videoUrl;
                }

                const update = await tx.execute(
                    `UPDATE lectures
                 SET title = COALESCE(?, title),
                     description = COALESCE(?, description),
                     video_url = COALESCE(?, video_url),
                     duration_minutes = COALESCE(?, duration_minutes),
                     price = COALESCE(?, price),
                     display_order = COALESCE(?, display_order),
                     is_free = COALESCE(?, is_free),
                     is_published = COALESCE(?, is_published),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND ${mutationScope.writePredicate}`,
                [
                    title ?? null,
                    description ?? null,
                    storedVideoUrl ?? null,
                    duration_minutes ?? null,
                    price ?? null,
                    display_order ?? null,
                    is_free ?? null,
                    is_published ?? null,
                    req.params.id,
                    mutationScope.value
                    ]
                );

                if (update.affectedRows > 0) {
                    await recordAudit(tx.execute, {
                        actorUserId: req.user?.id ?? null,
                        tenantId: req.user?.tenantId ?? null,
                        action: 'lecture.update',
                        resourceType: 'lecture',
                        resourceId: req.params.id,
                        oldValue: snapshotRow(current),
                        newValue: snapshotRow({
                            title, description, video_url: storedVideoUrl, duration_minutes, price, display_order, is_free, is_published,
                        }),
                    });
                }
                return { kind: 'updated' as const, affectedRows: update.affectedRows };
            });

            if (outcome.kind === 'missing') return res.status(404).json({ error: 'Lecture not found' });
            if (outcome.kind === 'archived') return res.status(410).json({ error: 'Archived lectures cannot be changed or republished' });
            if (outcome.kind === 'bindingDenied') {
                return res.status(outcome.binding.status).json({
                    error: outcome.binding.error,
                    code: outcome.binding.code,
                });
            }
            if (outcome.affectedRows === 0) return res.status(404).json({ error: 'Lecture not found' });

            const updatedLecture = await queryOne(
                `SELECT l.*
                 FROM lectures l
                 INNER JOIN courses c ON c.id = l.course_id
                 WHERE l.id = ? AND ${mutationScope.readPredicate}`,
                [req.params.id, mutationScope.value]
            );
            if (!updatedLecture) {
                return res.status(404).json({ error: 'Lecture not found' });
            }

            res.json(updatedLecture);
        } catch (error) {
            console.error('Update lecture error:', error);
            res.status(500).json({ error: 'Failed to update lecture' });
        }
    });

    // Delete lecture (soft delete by unpublishing)
    router.delete('/:id', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const mutationScope = getMutationScope(req);
            if (!mutationScope) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            if (!deps.transaction) throw new Error('Lecture archive requires transactional data access');
            const outcome = await deps.transaction(async (tx) => {
                const existing = await tx.queryOne<{ id: string; archived_at: Date | string | null }>(
                    `SELECT l.id, l.archived_at
                     FROM lectures l
                     INNER JOIN courses c ON c.id = l.course_id
                     WHERE l.id = ? AND ${mutationScope.readPredicate} FOR UPDATE`,
                    [req.params.id, mutationScope.value]
                );
                if (!existing) return { kind: 'missing' as const };
                if (existing.archived_at) return { kind: 'archived' as const };
                if (!(await enforceLectureBranch(req, res, req.params.id))) return { kind: 'denied' as const };
                const result = await tx.execute(
                    `UPDATE lectures SET is_published = FALSE, archived_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND ${mutationScope.writePredicate} AND archived_at IS NULL`,
                    [req.params.id, mutationScope.value]
                );
                if (result.affectedRows === 0) return { kind: 'missing' as const };
                await recordAudit(tx.execute, {
                    actorUserId: req.user?.id ?? null,
                    tenantId: req.user?.tenantId ?? null,
                    action: 'lecture.archive',
                    resourceType: 'lecture',
                    resourceId: req.params.id,
                    oldValue: snapshotRow(existing),
                    newValue: { is_published: false, archived: true },
                });
                return { kind: 'archived' as const, changed: true };
            });

            if (outcome.kind === 'missing') return res.status(404).json({ error: 'Lecture not found' });
            if (outcome.kind === 'denied') return;
            if (!('changed' in outcome)) return res.status(410).json({ error: 'Lecture is already archived' });
            console.log('[Lectures] Deleted lecture:', req.params.id);
            res.json({ message: 'Lecture deleted successfully' });
        } catch (error) {
            console.error('Delete lecture error:', error);
            res.status(500).json({ error: 'Failed to delete lecture' });
        }
    });

    // Reorder lectures within a course atomically. The caller supplies the full
    // ordered id list; the planner rejects duplicates/conflicts/stale partials so
    // the write is all-or-nothing (no partial success).
    return router;
};

/** Production wiring: real pool, real auth and entitlement middleware. */
export default createLectureRouter({
    db: { query, queryOne, execute },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
    requireTeachingWriteAccess: requireTeachingWrite('lectures'),
    /** Verified platform capability, resolved server-side; never a role claim. */
    hasVerifiedPlatformCapability: async (userId: string): Promise<boolean> => {
        if (await isSuperAdmin(userId)) return true;
        return (await getAdminPermissions(userId)).includes('security.manage');
    },
    transaction: async <T>(fn: (tx: LectureDataAccess) => Promise<T>): Promise<T> => {
        const pool = getPool();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const txDb: LectureDataAccess = {
                query: <T = any>(sql: string, params?: unknown[]): Promise<T[]> =>
                    (connection.query as unknown as (s: string, p?: unknown[]) => Promise<[unknown[], unknown]>)(
                        sql, params,
                    ).then((res) => res[0] as T[]),
                queryOne: async <T = any>(sql: string, params?: unknown[]): Promise<T | null> => {
                    const [rows] = await (connection.query as unknown as (s: string, p?: unknown[]) => Promise<[unknown[], unknown]>)(
                        sql, params,
                    );
                    return ((rows as unknown[])[0] as T) ?? null;
                },
                execute: (sql: string, params?: unknown[]) =>
                    (connection.execute as unknown as (s: string, p?: unknown[]) => Promise<[unknown, unknown]>)(
                        sql, params,
                    ).then((res) => {
                        const header = res[0] as { insertId?: number; affectedRows?: number };
                        return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
                    }),
            };
            const result = await fn(txDb);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    },
});
