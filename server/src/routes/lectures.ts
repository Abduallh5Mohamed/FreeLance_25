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

/** A binding refusal must abort writes already made by the create unit. */
class LectureBindingRollback extends Error {
    constructor(readonly decision: Extract<VideoBindingDecision, { ok: false }>) {
        super('Lecture video binding refused');
        this.name = 'LectureBindingRollback';
    }
}

export const createLectureRouter = (deps: LectureRouterDeps): Router => {
    const router = Router();
    // `execute` is deliberately NOT taken from the pool: every write in this
    // router runs on the transaction receiver, so a mutation can never be
    // issued on the shared pool while the surrounding transaction is open.
    const { query, queryOne } = deps.db;
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

    /**
     * Exact affected-row count.
     *
     * `undefined` is neither zero nor one: it is a driver result this route
     * cannot interpret, so it is refused instead of coerced. Coercing it to 0
     * would turn a write that actually landed into a reported miss, and
     * coercing it to 1 would fabricate a transition nobody observed.
     */
    const affectedRowsOf = (
        result: { affectedRows?: unknown } | null | undefined,
        operation: string,
    ): number => {
        const value = result?.affectedRows;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            throw new Error(`lectures ${operation} did not report a usable affected-row count`);
        }
        return value;
    };

    /**
     * Batched READ-side proof of a stored `video://` reference.
     *
     * The write path proves a binding before it stores one, but a row written
     * before that contract existed — or by another lane — carries a value this
     * router never verified. Canonical SYNTAX is not authority: `video://<id>`
     * only names a candidate asset. This resolves the SAME proof the write path
     * uses (`validateVideoBinding`), from the same server rows:
     *   1. the asset must exist in `videos`;
     *   2. its tenant comes from its DECLARED authorities only —
     *      `videos.tenant_id` and/or `videos.course_id -> courses.tenant_id`;
     *      two authorities that disagree prove no tenant at all, and no
     *      authority proves nothing;
     *   3. the destination tenant is the lecture's own
     *      `course_id -> courses.tenant_id`, read from server rows;
     *   4. `destination === video` is required EXACTLY.
     *
     * Anything unproven stays `null`. The stored value is never rewritten and
     * no substitute URL is produced, so the caller sees "no playable
     * reference" rather than a different one. At most two extra reads per
     * response, whatever the row count — never one per row.
     */
    const proveLectureMediaReferences = async (
        reader: LectureDataAccess,
        rows: ReadonlyArray<Record<string, any>>,
    ): Promise<Map<string, string | null>> => {
        const proven = new Map<string, string | null>();
        const candidates: Array<{ rowId: string; videoUrl: string; videoId: string; courseId: string }> = [];
        for (const row of rows) {
            if (!row || typeof row !== 'object' || row.id == null) continue;
            const rowId = String(row.id);
            // Fail closed before any check: a row is withheld until proven.
            proven.set(rowId, null);
            if (typeof row.video_url !== 'string' || row.course_id == null) continue;
            const parsed = parseVideoReference(row.video_url);
            if (!parsed.ok) continue;
            candidates.push({
                rowId,
                videoUrl: parsed.videoUrl,
                videoId: parsed.videoId,
                courseId: String(row.course_id),
            });
        }
        if (candidates.length === 0) return proven;

        const videoIds = Array.from(new Set(candidates.map((candidate) => candidate.videoId)));
        const videos = await reader.query<{ id: string; tenant_id: string | null; course_id: string | null }>(
            `SELECT id, tenant_id, course_id FROM videos WHERE id IN (${videoIds.map(() => '?').join(',')})`,
            videoIds,
        );
        const videoById = new Map<string, { id: string; tenant_id: string | null; course_id: string | null }>(
            videos.map((video): [string, { id: string; tenant_id: string | null; course_id: string | null }] => [
                String(video.id), video,
            ]),
        );

        // Destination tenants (the lectures' courses) and the video-side course
        // tenants needed to prove the video's own two authorities agree.
        const courseIds = Array.from(new Set([
            ...candidates.map((candidate) => candidate.courseId),
            ...videos
                .map((video) => (video.course_id == null ? null : String(video.course_id)))
                .filter((id): id is string => id !== null),
        ]));
        const courses: Array<{ id: string; tenant_id: string | null }> = courseIds.length === 0
            ? []
            : await reader.query<{ id: string; tenant_id: string | null }>(
                `SELECT id, tenant_id FROM courses WHERE id IN (${courseIds.map(() => '?').join(',')})`,
                courseIds,
            );
        const courseTenantById = new Map<string, string | null>(
            courses.map((course): [string, string | null] => [
                String(course.id),
                course.tenant_id == null ? null : String(course.tenant_id),
            ]),
        );

        for (const candidate of candidates) {
            const video = videoById.get(candidate.videoId);
            if (!video) continue; // the named asset does not exist
            const directTenant = video.tenant_id == null ? null : String(video.tenant_id);
            const videoCourseTenant = video.course_id == null
                ? null
                : courseTenantById.get(String(video.course_id)) ?? null;
            // Two declared authorities that disagree prove no tenant at all.
            if (directTenant && videoCourseTenant && directTenant !== videoCourseTenant) continue;
            const videoTenant = directTenant ?? videoCourseTenant;
            if (!videoTenant) continue;
            const destinationTenant = courseTenantById.get(candidate.courseId) ?? null;
            if (!destinationTenant || destinationTenant !== videoTenant) continue;
            proven.set(candidate.rowId, candidate.videoUrl);
        }
        return proven;
    };

    /**
     * Withhold every lecture `video_url` this router has not proven. Nothing is
     * read from the row's own value when projecting, so a stored reference can
     * never be echoed by accident. Playback authorization itself stays with
     * the secure-video entitlement path — this only decides whether a
     * reference may be disclosed at all.
     */
    const projectLectureMedia = async <T extends Record<string, any>>(
        reader: LectureDataAccess,
        rows: T[],
    ): Promise<T[]> => {
        const list = Array.isArray(rows) ? rows : [];
        const proven = await proveLectureMediaReferences(reader, list);
        return list.map((row) => {
            if (!row || typeof row !== 'object') return row;
            const rowId = (row as Record<string, any>).id;
            // The stored value is overwritten, never consulted: an unproven
            // reference becomes `null` rather than being passed through.
            return {
                ...row,
                video_url: rowId == null ? null : proven.get(String(rowId)) ?? null,
            } as T;
        });
    };

    const projectLectureMediaOne = async <T extends Record<string, any>>(
        reader: LectureDataAccess,
        row: T | null,
    ): Promise<T | null> => {
        if (!row || typeof row !== 'object') return row;
        const [projected] = await projectLectureMedia(reader, [row]);
        return projected ?? row;
    };

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

            // This list selects EXPLICIT columns and deliberately carries no
            // media field, so there is nothing here to leak: a discovery
            // response names lectures, it does not hand out a reference.
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

            // The phone is used ONLY as a server-side join key to the
            // enrollment row. It is PII: it is never logged and never returned
            // to the caller.
            const userRecord = await queryOne(
                'SELECT id, phone, role FROM users WHERE id = ? AND role = "student"',
                [userId]
            );

            if (!userRecord || !userRecord.phone) {
                console.log(`[Lectures] User not found or has no phone: ${userId}`);
                return res.json([]);
            }

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
                // Neither the phone that failed to resolve nor the student's
                // name is logged: both are PII.
                console.log('[Lectures] No active approved enrollment for the resolved user');
                return res.json([]);
            }

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

            // Every row here is `l.*`, so the stored `video_url` must be
            // projected: a lecture being published is not proof that its
            // reference names a real, same-workspace asset.
            const projected = await projectLectureMedia(deps.db, lectures as Record<string, any>[]);
            console.log(`[Lectures] Student ${userId} - Found ${projected.length} lectures`);
            res.json(projected);
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

            // `l.*` carries the stored reference, so it is projected: the
            // asset must exist and its tenant must be exactly this lecture's
            // course tenant. Publication alone proves neither, so a legacy raw
            // URL or a foreign asset is withheld as `null` — never rewritten
            // and never replaced by a fallback link.
            res.json(await projectLectureMediaOne(deps.db, lecture as Record<string, any>));
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

            // The default course is RESOLVED here but CREATED inside the same
            // transaction as the lecture. A write issued on the shared pool
            // before the binding transaction can survive a failed create and
            // leave an orphan course behind; the destination course is part of
            // the binding, so it moves with it. The read stays outside because
            // the common case (the course already exists) needs no write.
            let defaultCourseTenant: string | null = null;
            if (!actualCourseId && ownerId) {
                const selectedTenant = req.user?.tenantId;
                if (!selectedTenant) {
                    return res.status(403).json({ error: 'Course not found in your workspace' });
                }
                // Keep a default course confined to the caller's selected
                // tenant and server-derived owner.
                const defaultCourse = await queryOne<{ id: string }>(
                    `SELECT id FROM courses WHERE name=? AND instructor_id=? AND tenant_id=? LIMIT 1`,
                    ['فيديوهاتي', ownerId, selectedTenant]
                );
                if (defaultCourse) {
                    actualCourseId = defaultCourse.id;
                } else {
                    defaultCourseTenant = selectedTenant;
                }
            }

            if (!actualCourseId && !defaultCourseTenant) {
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

            // Identifiers only. The video reference and the title are content,
            // and the reference is exactly the value this route is careful not
            // to disclose, so neither is logged.
            console.log('[Lectures] Creating lecture:', {
                course_id: actualCourseId ?? null,
                grade_id: grade_id ?? null,
                group_id: group_id ?? null,
                instructor_id: ownerId ?? null,
                default_course: defaultCourseTenant !== null,
            });

            const lectureId = uuidv4();
            if (!deps.transaction) throw new Error('Lecture creation requires transactional data access');
            await deps.transaction(async (tx) => {
                // The destination course is settled INSIDE this transaction: a
                // default course created here rolls back with a refused
                // binding instead of outliving it.
                let courseId = actualCourseId ? String(actualCourseId) : null;
                if (!courseId) {
                    courseId = uuidv4();
                    await tx.execute(
                        `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,is_active)
                         VALUES (?,?,?,?,?,?,TRUE)`,
                        [courseId, defaultCourseTenant, ownerId, 'فيديوهاتي', 'عام', 'فيديوهاتي خاصة بالمحاضر']
                    );
                }

                // A `video://` link is only accepted once the video is proven
                // to exist, belong to this workspace and be usable by the
                // caller, and is not already bound elsewhere.
                const binding = await validateLectureVideoBinding(tx, req, video_url, lectureId, courseId);
                if (!binding.ok) throw new LectureBindingRollback(binding);

                await tx.execute(
                `INSERT INTO lectures
                (id, course_id, grade_id, group_id, instructor_id, title, description, video_url, duration_minutes, price, display_order, is_free, is_published)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    lectureId,
                    courseId,
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
                        course_id: courseId, grade_id, group_id, instructor_id: ownerId,
                        title, description, video_url: binding.videoUrl, duration_minutes, price, display_order, is_free, is_published,
                    }),
                });
                return { kind: 'created' as const };
            });

            const newLecture = await queryOne(
                'SELECT * FROM lectures WHERE id = ?',
                [lectureId]
            );

            console.log('[Lectures] Created lecture:', newLecture?.id);
            res.status(201).json(await projectLectureMediaOne(deps.db, newLecture as Record<string, any> | null));
        } catch (error) {
            if (error instanceof LectureBindingRollback) {
                return res.status(error.decision.status).json({ error: error.decision.error, code: error.decision.code });
            }
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

                // MySQL counts rows CHANGED, not matched. A lecture already
                // sitting at its target position reports 0, so replaying an
                // identical order used to fail here with 500 even though every
                // row was correct. The set itself was validated and locked
                // above, so 0 and 1 are both success; more than one row for a
                // primary key is an anomaly and is refused.
                let applied = 0;
                for (const assignment of plan.assignments) {
                    const result = await tx.execute(
                        'UPDATE lectures SET display_order=? WHERE id=? AND course_id=? AND archived_at IS NULL',
                        [assignment.display_order, assignment.id, courseId]
                    );
                    const changed = affectedRowsOf(result, 'lecture reorder');
                    if (changed > 1) throw new Error('lecture reorder matched more than one row');
                    if (changed === 1) applied += 1;
                }
                await recordAudit(tx.execute, {
                    actorUserId: req.user?.id ?? null,
                    tenantId: tenantId ?? null,
                    action: 'lecture.reorder',
                    resourceType: 'course',
                    resourceId: courseId,
                    newValue: { ordered_ids: plan.assignments.map((a) => a.id) },
                });
                return { kind: 'updated' as const, updated: applied, plan };
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
            // Early guard only: this read decides 404/410 before a transaction
            // is opened. It deliberately does NOT inform the replacement
            // decision — a value read out here is a snapshot, so both the
            // sold-access fence and the video comparison use the row locked
            // INSIDE the transaction below.
            const existing = await queryOne<{ id: string; archived_at: Date | string | null }>(
                `SELECT l.id, l.archived_at
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
            // Canonical form is validated BEFORE the transaction: it is pure
            // input validation, it needs no database state, and keeping it here
            // preserves the existing 400-before-409 precedence. The sold-access
            // check itself is NOT done here any more — a read taken out here is
            // a snapshot that a concurrent sale can outrun. It moved inside the
            // transaction, below.
            let requestedVideoUrl: string | null = null;
            if (video_url !== undefined) {
                const videoReference = parseVideoReference(String(video_url));
                if (!videoReference.ok) {
                    return res.status(400).json({
                        error: videoReference.reason === 'not-a-reference'
                            ? 'External video links are not allowed. Upload the video to the platform.'
                            : 'Video link is not a canonical platform video reference',
                    });
                }
                requestedVideoUrl = videoReference.videoUrl;
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

                // ── Sold-access fence ───────────────────────────────────────
                // A lecture whose access has been sold must not have its video
                // replaced. The check belongs HERE, not before the transaction,
                // and the reason is not "a fresher read":
                //
                //  PRIMARY FENCE — the lecture row is already locked FOR UPDATE
                //  above and stays locked for this whole transaction. The only
                //  writer of `instructor_shared_lectures` is
                //  `POST /offers/:offerId/accept`
                //  (server/src/routes/instructor-video-requests.ts:237), and
                //  that INSERT must satisfy
                //  `FOREIGN KEY (lecture_id) REFERENCES lectures(id)`. InnoDB
                //  checks foreign-key constraints BEFORE inserting the child
                //  row, so it must take a SHARED lock on this very `lectures`
                //  row first — which this transaction holds exclusively. A share
                //  row therefore cannot be created between this check and the
                //  UPDATE below: it waits for this commit. This holds at any
                //  isolation level, and the lock order is acyclic (that writer
                //  holds nothing this transaction needs, so it simply waits).
                //
                //  WHY `FOR UPDATE` ON THE SHARES ROW TOO — the fence above
                //  stops a sale from STARTING mid-replacement; this read makes
                //  sure a sale that already COMMITTED is actually seen. A
                //  locking read returns the latest committed row, not this
                //  transaction's snapshot, so a share committed before we took
                //  the lecture lock is visible. Under REPEATABLE READ it also
                //  next-key-locks the `lecture_id` range (the FK mandates an
                //  index with `lecture_id` leftmost — the declared
                //  `uq_instructor_lecture (instructor_id, lecture_id)` does not
                //  qualify), which is additional protection, not the guarantee.
                //
                // Scope note (held, not fixed here): that sale writer commits
                // the purchase and the share in ONE transaction, so a sale that
                // begins after this commit buys the lecture in its new state.
                // What remains outside this fence is an offer accepted for a
                // video the seller replaces before that sale commits — a window
                // that lives entirely in instructor-video-requests.ts and is
                // listed as a held item in the handoff.
                const replacingVideoUrl: string | null = (
                    requestedVideoUrl !== null
                    && requestedVideoUrl !== String(current.video_url ?? '')
                ) ? requestedVideoUrl : null;
                if (replacingVideoUrl !== null) {
                    const soldAccess = await tx.query<{ id: number | string }>(
                        'SELECT id FROM instructor_shared_lectures WHERE lecture_id = ? FOR UPDATE',
                        [req.params.id],
                    );
                    if (soldAccess.length > 0) return { kind: 'sold' as const };
                }

                // Only a NEW association is validated: an update that leaves
                // video_url untouched does not re-bind and must not be blocked
                // by a legacy link that predates this check. When it does
                // change, the destination course is re-read from the lecture
                // row inside this transaction by the validator itself
                // (`resolveDestinationCourseId`), so the binding is proven
                // against the row's CURRENT course. This route never changes
                // `course_id`; a course moved by another path is therefore
                // re-proven on the next video write, not invented here.
                let storedVideoUrl: string | null = requestedVideoUrl;
                if (replacingVideoUrl !== null) {
                    const binding = await validateLectureVideoBinding(tx, req, replacingVideoUrl, req.params.id);
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

                // The row was read `FOR UPDATE` above, so it EXISTS: a count of
                // 0 means the submitted values already equal the stored ones,
                // never "not found". Only a real transition is audited, and
                // more than one row for a primary key is an anomaly.
                const changed = affectedRowsOf(update, 'lecture update');
                if (changed > 1) throw new Error('lecture update matched more than one row');
                if (changed === 1) {
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
                return { kind: 'updated' as const, changed };
            });

            if (outcome.kind === 'missing') return res.status(404).json({ error: 'Lecture not found' });
            if (outcome.kind === 'archived') return res.status(410).json({ error: 'Archived lectures cannot be changed or republished' });
            if (outcome.kind === 'sold') {
                // Same status and message as before; only the decision point
                // moved, from a pre-transaction snapshot to the fenced read.
                return res.status(409).json({ error: 'The video file cannot be replaced after access has been sold' });
            }
            if (outcome.kind === 'bindingDenied') {
                return res.status(outcome.binding.status).json({
                    error: outcome.binding.error,
                    code: outcome.binding.code,
                });
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

            // `l.*` again: the echo is projected too, so an unchanged legacy
            // reference cannot ride back out on a successful write.
            res.json(await projectLectureMediaOne(deps.db, updatedLecture as Record<string, any>));
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
                // The row is locked and un-archived above, so a 0 here means
                // the write predicate (tenant authority) did not cover it —
                // answered as not-found rather than disclosed. `undefined` is
                // refused by the helper instead of being read as 0.
                const archivedRows = affectedRowsOf(result, 'lecture archive');
                if (archivedRows === 0) return { kind: 'missing' as const };
                if (archivedRows > 1) throw new Error('lecture archive matched more than one row');
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
                        const affectedRows = header.affectedRows;
                        if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                            throw new Error('lectures transaction execute did not report a usable affected-row count');
                        }
                        return { insertId: typeof header.insertId === 'number' && Number.isSafeInteger(header.insertId) ? header.insertId : 0, affectedRows };
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
