import { Router, RequestHandler, Response } from 'express';
import { optionalAuth, AuthRequest } from '../middleware/auth';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';

/**
 * Platform capability key for cross-tenant meeting administration.
 * Verified against the migrations: admin_role_permissions seeds no
 * meetings.* key, so the verified-active-super_admin check is the effective
 * policy today; deny-by-default for every other identity.
 */
const MEETINGS_PLATFORM_PERMISSION = 'meetings.manage';

/**
 * Roles that schedule and manage meetings (legacy teacher dashboard and the
 * instructor workspace). Their boundary is precise creator ownership:
 * created_by is always the server-derived principal id.
 */
const MEETING_MANAGER_ROLES = new Set(['instructor', 'teacher']);

/**
 * Data-access seam for the meetings router. Production binds ../db (lazily);
 * hermetic tests inject isolated fixtures through the same boundary so the
 * real authorization logic runs without a database.
 */
export interface MeetingsDataAccess {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId: number }>;
}

/**
 * Injectable seams for the meetings router. The default export binds the
 * production SQL adapters, the real optional-auth middleware, and the
 * server-verified platform capability check. Tests inject fixtures through
 * this boundary instead of bypassing production authorization.
 */
export interface MeetingsRouterDeps {
    db: MeetingsDataAccess;
    optionalAuthenticate: RequestHandler;
    /**
     * Verified platform capability resolved server-side (active super_admin or
     * a seeded permission key). It never consults a JWT role claim, so an
     * arbitrary admin-role token cannot read or mutate other tenants'
     * meetings.
     */
    hasVerifiedPlatformCapability: (userId: string) => Promise<boolean>;
}

interface MeetingRow {
    id: string;
    title: string;
    description: string | null;
    meeting_link: string;
    meeting_type: string;
    meeting_password: string | null;
    grade_id: string | null;
    group_id: string | null;
    scheduled_at: string;
    duration_minutes: number;
    is_active: number;
    created_by: string | null;
    group_name?: string | null;
    created_by_name?: string | null;
    grade_name?: string | null;
}

const MEETING_LIST_BASE = `
            SELECT
                m.*,
                gr.name as group_name,
                u.name as created_by_name
            FROM online_meetings m
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            LEFT JOIN users u ON m.created_by = u.id`;

const MEETING_BY_ID = `
            SELECT
                m.*,
                gr.name as group_name,
                u.name as created_by_name
            FROM online_meetings m
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            LEFT JOIN users u ON m.created_by = u.id
            WHERE m.id = ?`;

const MEETING_BY_ID_WITH_GRADE = `
            SELECT
                m.*,
                g.name as grade_name,
                gr.name as group_name
            FROM online_meetings m
            LEFT JOIN grades g ON m.grade_id = g.id
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            WHERE m.id = ?`;

const TENANT_GROUP_SCOPE = `EXISTS (
    SELECT 1
    FROM tenants t
    WHERE t.id = ?
      AND t.status = 'active'
      AND (g.instructor_id = t.owner_user_id OR g.instructor_id IS NULL)
      AND (g.course_id IS NULL OR EXISTS (
          SELECT 1 FROM courses c WHERE c.id = g.course_id AND c.tenant_id = t.id
      ))
      AND (g.instructor_id IS NOT NULL OR g.course_id IS NOT NULL)
)`;

/**
 * A join link is opened directly by the student UI (`window.open`), so only
 * http(s) URLs are accepted; `javascript:`/`data:` payloads are rejected
 * before any write.
 */
const parseHttpUrl = (value: unknown): URL | null => {
    if (typeof value !== 'string') return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
};

export const MEETING_TITLE_MAX_LENGTH = 200;
export const MEETING_DESCRIPTION_MAX_LENGTH = 5000;
export const MEETING_PASSWORD_MAX_LENGTH = 256;
export const MEETING_TYPE_MAX_LENGTH = 32;

const parseScheduledAt = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    if (value.length > 64) return null;
    if (Number.isNaN(Date.parse(value))) return null;
    return value;
};

const parseDuration = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') return 60;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
};

/**
 * Build the meetings router over injected dependencies.
 *
 * Authorization model (deny-by-default, server-derived only):
 * - anonymous: 401 on every endpoint;
 * - instructor/teacher (meeting managers): meetings they created
 *   (`created_by` is always the authenticated id, never a body value);
 * - student: self-service workspace routes only, scoped to the
 *   server-derived enrollment's group/grade;
 * - platform admin: cross-tenant access only with a verified platform
 *   capability (never a bare JWT role claim).
 */
export const createMeetingsRouter = (deps: MeetingsRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    router.use(deps.optionalAuthenticate);

    const isMeetingManager = (user: NonNullable<AuthRequest['user']>): boolean =>
        MEETING_MANAGER_ROLES.has(user.role);

    const isLiveStudentWorkspace = (user: NonNullable<AuthRequest['user']>): boolean =>
        user.role === 'student'
        && typeof user.studentEnrollmentId === 'string' && user.studentEnrollmentId.length > 0
        && typeof user.tenantId === 'string' && user.tenantId.length > 0
        && typeof user.instructorId === 'string' && user.instructorId.length > 0;

    /**
     * A meeting targets the student's workspace when it is specific to the
     * student's group, or grade-wide (group_id NULL) for the student's grade.
     * A group-specific meeting never leaks to the rest of the grade, and a
     * grade-wide meeting of another grade never leaks across grades.
     */
    const isMeetingForStudentWorkspace = (
        meeting: { group_id: string | null; grade_id: string | null; created_by: string | null },
        user: NonNullable<AuthRequest['user']>,
    ): boolean => {
        if (String(meeting.created_by) !== String(user.instructorId)) return false;
        if (meeting.group_id != null) {
            return user.groupId != null && String(meeting.group_id) === String(user.groupId);
        }
        return meeting.grade_id != null
            && user.gradeId != null
            && String(meeting.grade_id) === String(user.gradeId);
    };

    // Get all meetings (for admin/teacher)
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            if (isMeetingManager(user)) {
                // Instructors/teachers only see meetings they created
                const meetings = await query<MeetingRow>(
                    `${MEETING_LIST_BASE}
            WHERE m.created_by = ?
            ORDER BY m.scheduled_at DESC`,
                    [user.id]
                );
                return res.json(meetings);
            }
            if (await deps.hasVerifiedPlatformCapability(user.id)) {
                const meetings = await query<MeetingRow>(
                    `${MEETING_LIST_BASE}
            ORDER BY m.scheduled_at DESC`,
                    []
                );
                return res.json(meetings);
            }
            return res.status(403).json({ error: 'Forbidden' });
        } catch (error) {
            console.error('Error fetching meetings:', error);
            res.status(500).json({ error: 'Failed to fetch meetings' });
        }
    });

    // Get meetings for a specific student (self-service, based on their selected workspace)
    router.get('/student/:studentId', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            const { studentId } = req.params;

            // Self-service only: the caller must be the student themself with
            // a live, server-derived workspace selection. The path id is never
            // trusted as authority.
            if (!isLiveStudentWorkspace(user) || String(user.id) !== String(studentId)) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }

            // Server-derived scope (never the path param): the student's
            // selected enrollment group/grade. A meeting is visible when it
            // targets the student's group, or is grade-wide for the student's
            // grade; meetings of other grades are never visible.
            const meetings = await query<MeetingRow>(`
            SELECT
                m.*,
                gr.name as group_name,
                u.name as created_by_name
            FROM online_meetings m
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            LEFT JOIN users u ON m.created_by = u.id
            WHERE m.is_active = 1
            AND (m.group_id = ? OR (m.group_id IS NULL AND m.grade_id = ?))
            AND m.created_by = ?
            AND m.scheduled_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            ORDER BY m.scheduled_at ASC
        `, [user.groupId, user.gradeId, user.instructorId]);

            res.json(meetings);
        } catch (error) {
            console.error('Error fetching student meetings:', error);
            res.status(500).json({ error: 'Failed to fetch meetings' });
        }
    });

    // Get single meeting
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            const { id } = req.params;

            let meeting: MeetingRow | null;
            if (isMeetingManager(user)) {
                meeting = await queryOne<MeetingRow>(`${MEETING_BY_ID} AND m.created_by = ?`, [id, user.id]);
                if (meeting && String(meeting.created_by) !== String(user.id)) meeting = null;
            } else if (user.role === 'student') {
                if (!isLiveStudentWorkspace(user)) {
                    return res.status(403).json({ error: 'Student workspace access required' });
                }
                meeting = await queryOne<MeetingRow>(`${MEETING_BY_ID} AND m.created_by = ?`, [id, user.instructorId]);
                if (meeting && !isMeetingForStudentWorkspace(meeting, user)) {
                    return res.status(404).json({ error: 'Meeting not found' });
                }
            } else {
                if (!(await deps.hasVerifiedPlatformCapability(user.id))) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
                meeting = await queryOne<MeetingRow>(MEETING_BY_ID, [id]);
            }

            if (!meeting) {
                return res.status(404).json({ error: 'Meeting not found' });
            }

            res.json(meeting);
        } catch (error) {
            console.error('Error fetching meeting:', error);
            res.status(500).json({ error: 'Failed to fetch meeting' });
        }
    });

    // Create meeting
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            if (!isMeetingManager(user) && !(await deps.hasVerifiedPlatformCapability(user.id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const body = (req.body ?? {}) as Record<string, unknown>;
            const {
                title,
                description,
                meeting_link,
                meeting_type = 'zoom',
                meeting_password,
                grade_id,
                group_id,
                scheduled_at,
                duration_minutes = 60,
            } = body;

            // created_by is always the server-derived principal id; a body
            // value is never trusted (spoofed creator closed).
            const ownerId = user.id;

            if (!title || !meeting_link || !grade_id || !scheduled_at) {
                return res.status(400).json({
                    error: 'Missing required fields: title, meeting_link, grade_id, scheduled_at'
                });
            }
            if (typeof title !== 'string' || title.trim().length === 0 || title.length > MEETING_TITLE_MAX_LENGTH) {
                return res.status(400).json({ error: 'Invalid meeting title' });
            }
            if (typeof description === 'string' && description.length > MEETING_DESCRIPTION_MAX_LENGTH) {
                return res.status(400).json({ error: 'Invalid meeting description' });
            }
            if (typeof grade_id !== 'string' || grade_id.trim().length === 0 || grade_id.length > 64) {
                return res.status(400).json({ error: 'Invalid grade_id' });
            }
            if (group_id !== undefined && group_id !== null && (typeof group_id !== 'string' || group_id.length > 64)) {
                return res.status(400).json({ error: 'Invalid group_id' });
            }
            if (typeof meeting_type !== 'string' || meeting_type.trim().length === 0 || meeting_type.length > MEETING_TYPE_MAX_LENGTH) {
                return res.status(400).json({ error: 'Invalid meeting type' });
            }
            if (meeting_password !== undefined && meeting_password !== null && (typeof meeting_password !== 'string' || meeting_password.length > MEETING_PASSWORD_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid meeting password' });
            }
            if (!parseHttpUrl(meeting_link)) {
                return res.status(400).json({ error: 'Invalid meeting link' });
            }
            if (!parseScheduledAt(scheduled_at)) {
                return res.status(400).json({ error: 'Invalid scheduled_at' });
            }
            const duration = parseDuration(duration_minutes);
            if (duration === null) {
                return res.status(400).json({ error: 'Invalid duration_minutes' });
            }

            if (group_id && user.role === 'instructor') {
                const grp = await queryOne('SELECT id FROM `groups` WHERE id = ? AND instructor_id = ?', [group_id, user.id]);
                if (!grp) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
            } else if (group_id && user.role === 'teacher') {
                if (!user.tenantId) return res.status(403).json({ error: 'Forbidden' });
                const grp = await queryOne(
                    `SELECT g.id FROM \`groups\` g WHERE g.id = ? AND ${TENANT_GROUP_SCOPE}`,
                    [group_id, user.tenantId]
                );
                if (!grp) return res.status(403).json({ error: 'Forbidden' });
            }

            // Generate UUID
            const uuidResult = await queryOne<{ uuid: string }>('SELECT UUID() as uuid');
            const id = uuidResult?.uuid;
            if (!id) {
                return res.status(500).json({ error: 'Failed to create meeting' });
            }

            await execute(`
            INSERT INTO online_meetings
            (id, title, description, meeting_link, meeting_type, meeting_password, grade_id, group_id, scheduled_at, duration_minutes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, title, description ?? null, meeting_link, meeting_type, meeting_password ?? null, grade_id, group_id ?? null, scheduled_at, duration, ownerId]);

            const meeting = await queryOne<MeetingRow>(MEETING_BY_ID_WITH_GRADE, [id]);

            res.status(201).json(meeting);
        } catch (error) {
            console.error('Error creating meeting:', error);
            res.status(500).json({ error: 'Failed to create meeting' });
        }
    });

    // Update meeting
    router.put('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            const { id } = req.params;

            const manager = isMeetingManager(user);
            if (!manager && !(await deps.hasVerifiedPlatformCapability(user.id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const existing = await queryOne<{ created_by: string | null }>(
                manager
                    ? 'SELECT created_by FROM online_meetings WHERE id = ? AND created_by = ?'
                    : 'SELECT created_by FROM online_meetings WHERE id = ?',
                manager ? [id, user.id] : [id]
            );
            if (!existing || (manager && String(existing.created_by) !== String(user.id))) {
                return res.status(404).json({ error: 'Meeting not found' });
            }

            const body = (req.body ?? {}) as Record<string, unknown>;
            const {
                title,
                description,
                meeting_link,
                meeting_type,
                meeting_password,
                grade_id,
                group_id,
                scheduled_at,
                duration_minutes,
                is_active,
            } = body;

            if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0 || title.length > MEETING_TITLE_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid meeting title' });
            }
            if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > MEETING_DESCRIPTION_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid meeting description' });
            }
            if (meeting_link !== undefined && !parseHttpUrl(meeting_link)) {
                return res.status(400).json({ error: 'Invalid meeting link' });
            }
            if (meeting_type !== undefined && (typeof meeting_type !== 'string' || meeting_type.trim().length === 0 || meeting_type.length > MEETING_TYPE_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid meeting type' });
            }
            if (grade_id !== undefined && (typeof grade_id !== 'string' || grade_id.trim().length === 0 || grade_id.length > 64)) {
                return res.status(400).json({ error: 'Invalid grade_id' });
            }
            if (group_id !== undefined && group_id !== null && (typeof group_id !== 'string' || group_id.length > 64)) {
                return res.status(400).json({ error: 'Invalid group_id' });
            }
            if (meeting_password !== undefined && meeting_password !== null && (typeof meeting_password !== 'string' || meeting_password.length > MEETING_PASSWORD_MAX_LENGTH)) {
                return res.status(400).json({ error: 'Invalid meeting password' });
            }
            if (scheduled_at !== undefined && !parseScheduledAt(scheduled_at)) {
                return res.status(400).json({ error: 'Invalid scheduled_at' });
            }
            if (duration_minutes !== undefined && parseDuration(duration_minutes) === null) {
                return res.status(400).json({ error: 'Invalid duration_minutes' });
            }
            if (is_active !== undefined && typeof is_active !== 'boolean' && is_active !== 0 && is_active !== 1) {
                return res.status(400).json({ error: 'Invalid is_active' });
            }
            const duration = duration_minutes === undefined ? undefined : parseDuration(duration_minutes);

            if (group_id && user.role === 'instructor') {
                const grp = await queryOne('SELECT id FROM `groups` WHERE id = ? AND instructor_id = ?', [group_id, user.id]);
                if (!grp) return res.status(403).json({ error: 'Forbidden' });
            } else if (group_id && user.role === 'teacher') {
                if (!user.tenantId) return res.status(403).json({ error: 'Forbidden' });
                const grp = await queryOne(
                    `SELECT g.id FROM \`groups\` g WHERE g.id = ? AND ${TENANT_GROUP_SCOPE}`,
                    [group_id, user.tenantId]
                );
                if (!grp) return res.status(403).json({ error: 'Forbidden' });
            }

            await execute(`
            UPDATE online_meetings SET
                title = COALESCE(?, title),
                description = COALESCE(?, description),
                meeting_link = COALESCE(?, meeting_link),
                meeting_type = COALESCE(?, meeting_type),
                meeting_password = ?,
                grade_id = COALESCE(?, grade_id),
                group_id = ?,
                scheduled_at = COALESCE(?, scheduled_at),
                duration_minutes = COALESCE(?, duration_minutes),
                is_active = COALESCE(?, is_active)
            WHERE id = ? ${manager ? 'AND created_by = ?' : ''}
        `, [title, description, meeting_link, meeting_type, meeting_password, grade_id, group_id, scheduled_at, duration, is_active, id, ...(manager ? [user.id] : [])]);

            const meeting = await queryOne<MeetingRow>(
                `${MEETING_BY_ID_WITH_GRADE}${manager ? ' AND created_by = ?' : ''}`,
                manager ? [id, user.id] : [id]
            );

            res.json(meeting);
        } catch (error) {
            console.error('Error updating meeting:', error);
            res.status(500).json({ error: 'Failed to update meeting' });
        }
    });

    // Delete meeting
    router.delete('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            const { id } = req.params;

            const manager = isMeetingManager(user);
            if (!manager && !(await deps.hasVerifiedPlatformCapability(user.id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const existing = await queryOne<{ created_by: string | null }>(
                manager
                    ? 'SELECT created_by FROM online_meetings WHERE id = ? AND created_by = ?'
                    : 'SELECT created_by FROM online_meetings WHERE id = ?',
                manager ? [id, user.id] : [id]
            );
            if (!existing || (manager && String(existing.created_by) !== String(user.id))) {
                return res.status(404).json({ error: 'Meeting not found' });
            }

            const result = await execute(
                `DELETE FROM online_meetings WHERE id = ? ${manager ? 'AND created_by = ?' : ''}`,
                manager ? [id, user.id] : [id]
            );
            if (result.affectedRows === 0) return res.status(404).json({ error: 'Meeting not found' });
            res.json({ message: 'Meeting deleted successfully' });
        } catch (error) {
            console.error('Error deleting meeting:', error);
            res.status(500).json({ error: 'Failed to delete meeting' });
        }
    });

    // Get groups by grade (for filtering)
    router.get('/groups-by-grade/:gradeId', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            const { gradeId } = req.params;
            if (user.role === 'instructor') {
                const groups = await query('SELECT id, name FROM `groups` WHERE grade_id = ? AND instructor_id = ? ORDER BY name', [gradeId, user.id]);
                return res.json(groups);
            }
            if (await deps.hasVerifiedPlatformCapability(user.id)) {
                const groups = await query('SELECT id, name FROM `groups` WHERE grade_id = ? ORDER BY name', [gradeId]);
                return res.json(groups);
            }
            return res.status(403).json({ error: 'Forbidden' });
        } catch (error) {
            console.error('Error fetching groups:', error);
            res.status(500).json({ error: 'Failed to fetch groups' });
        }
    });

    return router;
};

// `../db` is loaded lazily (and cached) so importing this module never runs
// db.ts: no dotenv side effect and no pool creation at import time.
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

/** Verified platform capability: active super_admin or a seeded permission key. */
const productionPlatformCapability = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes(MEETINGS_PLATFORM_PERMISSION);
};

/** Production wiring: real pool, live auth middleware, verified capability check. */
export default createMeetingsRouter({
    db: {
        query: <T = unknown>(sql: string, params?: unknown[]) => loadDb().then((db) => db.query<T>(sql, params)),
        queryOne: <T = unknown>(sql: string, params?: unknown[]) => loadDb().then((db) => db.queryOne<T>(sql, params)),
        execute: (sql: string, params?: unknown[]) => loadDb().then((db) => db.execute(sql, params)),
    },
    optionalAuthenticate: optionalAuth,
    hasVerifiedPlatformCapability: productionPlatformCapability,
});
