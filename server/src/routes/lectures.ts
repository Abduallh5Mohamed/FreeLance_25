import { Router, Response, RequestHandler } from 'express';
import { query, queryOne, execute } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { optionalAuth, instructorScopeId, authenticateToken, AuthRequest } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

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
}

/**
 * Build the lectures router over injected dependencies. Production wiring
 * (default export) passes the real pool, the real optional/strict auth
 * middleware and the real teaching-entitlement guard; hermetic tests pass
 * the same middleware over injected fixture repositories.
 */
export const createLectureRouter = (deps: LectureRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    const optionalAuthenticate = deps.optionalAuthenticate;
    const authenticateToken = deps.authenticate;
    const requireTeachingWriteAccess = deps.requireTeachingWriteAccess;
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

            // Find student by phone (students table has phone directly)
            const student = await queryOne(
                'SELECT id, name, phone, group_id, grade_id, instructor_id FROM students WHERE phone = ? AND is_active = TRUE',
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

            if (!String(video_url).startsWith('video://')) {
                return res.status(400).json({ error: 'External video links are not allowed. Upload the video to the platform.' });
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

            console.log('[Lectures] Creating lecture:', { course_id: actualCourseId, grade_id, group_id, instructor_id: ownerId, title, video_url });

            const lectureId = uuidv4();
            const result = await execute(
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
                    video_url,
                    duration_minutes || null,
                    scopeId ? Number(price) : (price ?? null),
                    display_order,
                    is_free,
                    is_published
                ]
            );

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

    // Update lecture
    router.put('/:id', requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const mutationScope = getMutationScope(req);
            if (!mutationScope) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            const existing = await queryOne<{ id: string; instructor_id: string | null; video_url: string }>(
                `SELECT l.id, l.instructor_id, l.video_url
                 FROM lectures l
                 INNER JOIN courses c ON c.id = l.course_id
                 WHERE l.id = ? AND ${mutationScope.readPredicate}`,
                [req.params.id, mutationScope.value]
            );
            if (!existing) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
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
            if (video_url !== undefined && !String(video_url).startsWith('video://')) {
                return res.status(400).json({ error: 'External video links are not allowed. Upload the video to the platform.' });
            }
            if (video_url !== undefined) {
                const licensed = await queryOne('SELECT id FROM instructor_shared_lectures WHERE lecture_id=? LIMIT 1', [req.params.id]);
                if (licensed && existing.video_url !== video_url) {
                    return res.status(409).json({ error: 'The video file cannot be replaced after access has been sold' });
                }
            }

            const result = await execute(
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
                    video_url ?? null,
                    duration_minutes ?? null,
                    price ?? null,
                    display_order ?? null,
                    is_free ?? null,
                    is_published ?? null,
                    req.params.id,
                    mutationScope.value
                ]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Lecture not found' });
            }

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
            const existing = await queryOne<{ id: string }>(
                `SELECT l.id
                 FROM lectures l
                 INNER JOIN courses c ON c.id = l.course_id
                 WHERE l.id = ? AND ${mutationScope.readPredicate}`,
                [req.params.id, mutationScope.value]
            );
            if (!existing) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            const result = await execute(
                `UPDATE lectures SET is_published = FALSE, archived_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND ${mutationScope.writePredicate}`,
                [req.params.id, mutationScope.value]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Lecture not found' });
            }

            console.log('[Lectures] Deleted lecture:', req.params.id);
            res.json({ message: 'Lecture deleted successfully' });
        } catch (error) {
            console.error('Delete lecture error:', error);
            res.status(500).json({ error: 'Failed to delete lecture' });
        }
    });

    return router;
};

/** Production wiring: real pool, real auth and entitlement middleware. */
export default createLectureRouter({
    db: { query, queryOne, execute },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
    requireTeachingWriteAccess: requireTeachingWrite('lectures'),
});
