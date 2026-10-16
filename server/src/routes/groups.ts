import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { optionalAuth, AuthRequest, authenticateToken } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

interface Group {
    id: string;
    name: string;
    description?: string;
    course_id?: string;
    grade_id?: string;
    max_students?: number;
    current_students?: number;
    is_active: boolean;
    schedule_days?: string | null;
    schedule_time?: string | null;
}

export interface GroupsDataAccess {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId: number }>;
}

export interface GroupsRouterDeps {
    db: GroupsDataAccess;
    optionalAuthenticate: RequestHandler;
    authenticate: RequestHandler;
    requireTeachingWrite: RequestHandler;
    hasVerifiedPlatformCapability: (userId: string) => Promise<boolean>;
}

interface GroupScope {
    sql: string;
    params: unknown[];
}

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

const groupScopeFor = (user: NonNullable<AuthRequest['user']>): GroupScope | null => {
    if (user.role === 'instructor') {
        return { sql: 'g.instructor_id = ?', params: [user.id] };
    }
    if (user.role === 'student') {
        if (!user.groupId || !user.tenantId) return null;
        return { sql: `g.id = ? AND ${TENANT_GROUP_SCOPE}`, params: [user.groupId, user.tenantId] };
    }
    if ((user.role === 'teacher' || user.role === 'staff') && user.tenantId) {
        return { sql: TENANT_GROUP_SCOPE, params: [user.tenantId] };
    }
    return null;
};

/** Build the groups router over injected authentication, authorization and SQL adapters. */
export const createGroupsRouter = (deps: GroupsRouterDeps): Router => {
    const { query, queryOne, execute } = deps.db;
    const router = Router();
    router.use(deps.optionalAuthenticate);

    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });

            if (user.role === 'admin') {
                if (!(await deps.hasVerifiedPlatformCapability(user.id))) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
                const groups = await query<Group>(
                    'SELECT g.id, g.name, g.description, g.course_id, g.grade_id, g.max_students, g.current_students, g.is_active, g.schedule_days, g.schedule_time, g.instructor_id FROM `groups` g WHERE g.is_active = TRUE ORDER BY g.name',
                    []
                );
                return res.json(groups);
            }

            const scope = groupScopeFor(user);
            if (!scope) return res.status(403).json({ error: 'Forbidden' });
            const groups = await query<Group>(
                `SELECT g.id, g.name, g.description, g.course_id, g.grade_id, g.max_students, g.current_students, g.is_active, g.schedule_days, g.schedule_time, g.instructor_id
                 FROM \`groups\` g
                 WHERE g.is_active = TRUE AND ${scope.sql}
                 ORDER BY g.name`,
                scope.params
            );
            res.json(groups);
        } catch (error) {
            console.error('Get groups error:', error);
            res.status(500).json({ error: 'Failed to fetch groups' });
        }
    });

    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });

            let group: Group | null;
            if (user.role === 'admin') {
                if (!(await deps.hasVerifiedPlatformCapability(user.id))) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
                group = await queryOne<Group>(
                    'SELECT * FROM `groups` g WHERE g.id = ? AND g.is_active = TRUE',
                    [req.params.id]
                );
            } else {
                const scope = groupScopeFor(user);
                if (!scope) return res.status(403).json({ error: 'Forbidden' });
                group = await queryOne<Group>(
                    `SELECT * FROM \`groups\` g WHERE g.id = ? AND g.is_active = TRUE AND ${scope.sql}`,
                    [req.params.id, ...scope.params]
                );
            }

            if (!group) return res.status(404).json({ error: 'Group not found' });
            res.json(group);
        } catch (error) {
            console.error('Get group error:', error);
            res.status(500).json({ error: 'Failed to fetch group' });
        }
    });

    router.post('/', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user || !['instructor', 'teacher', 'staff'].includes(user.role)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const { name, description, max_students, is_active = true, grade_id } = req.body;
            let course_id = (req.body && req.body.course_id) ?? null;
            let schedule_days = (req.body && (req.body.schedule_days ?? null)) as unknown;
            const schedule_time = (req.body && (req.body.schedule_time ?? null)) as string | null;

            if (!name) {
                return res.status(400).json({ error: 'Group name is required' });
            }

            const tenantId = user.tenantId;
            if (!tenantId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });

            let ownerId = user.id;
            if (user.role !== 'instructor') {
                const tenant = await queryOne<{ owner_user_id: string }>(
                    "SELECT owner_user_id FROM tenants WHERE id = ? AND status = 'active'",
                    [tenantId]
                );
                if (!tenant) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
                ownerId = tenant.owner_user_id;
            }

            if (course_id === '' || course_id === undefined) {
                course_id = null;
            } else {
                const courseExists = await queryOne(
                    'SELECT id FROM courses WHERE id = ? AND tenant_id = ?',
                    [course_id, tenantId]
                );
                if (!courseExists) {
                    console.warn(`Create group: provided course_id ${course_id} not found in selected tenant, setting to NULL`);
                    course_id = null;
                }
            }

            let finalGradeId = grade_id || null;
            if (finalGradeId === '' || finalGradeId === undefined) {
                finalGradeId = null;
            }

            if (Array.isArray(schedule_days)) {
                schedule_days = JSON.stringify(schedule_days);
            } else if (typeof schedule_days === 'string') {
                try {
                    const parsed = JSON.parse(schedule_days);
                    schedule_days = Array.isArray(parsed) ? JSON.stringify(parsed) : JSON.stringify([schedule_days]);
                } catch {
                    schedule_days = JSON.stringify([schedule_days]);
                }
            } else if (schedule_days == null) {
                schedule_days = null;
            }

            const newId = randomUUID();
            await execute(
                'INSERT INTO `groups` (id, name, description, course_id, grade_id, instructor_id, max_students, is_active, schedule_days, schedule_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [newId, name, description || null, course_id, finalGradeId, ownerId, max_students || 30, is_active, schedule_days, schedule_time ?? null]
            );

            const scope = groupScopeFor(user);
            if (!scope) return res.status(403).json({ error: 'Forbidden' });
            const newGroup = await queryOne<Group>(
                `SELECT * FROM \`groups\` g WHERE g.id = ? AND ${scope.sql}`,
                [newId, ...scope.params]
            );

            res.status(201).json(newGroup);
        } catch (error) {
            console.error('Create group error:', error);
            res.status(500).json({ error: 'Failed to create group' });
        }
    });

    router.put('/:id', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user || !['instructor', 'teacher', 'staff'].includes(user.role)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const scope = groupScopeFor(user);
            if (!scope) return res.status(403).json({ error: 'Forbidden' });
            const existing = await queryOne<{ id: string }>(
                `SELECT g.id FROM \`groups\` g WHERE g.id = ? AND ${scope.sql}`,
                [req.params.id, ...scope.params]
            );
            if (!existing) return res.status(404).json({ error: 'Group not found' });

            const { name, description, max_students, is_active, grade_id } = req.body;
            let course_id = (req.body && req.body.course_id) ?? null;
            let schedule_days = (req.body && (req.body.schedule_days ?? null)) as unknown;
            const schedule_time = (req.body && (req.body.schedule_time ?? null)) as string | null;
            const tenantId = user.tenantId;
            if (!tenantId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });

            if (course_id === '' || course_id === undefined) {
                course_id = null;
            } else {
                const courseExists = await queryOne(
                    'SELECT id FROM courses WHERE id = ? AND tenant_id = ?',
                    [course_id, tenantId]
                );
                if (!courseExists) {
                    console.warn(`Update group: provided course_id ${course_id} not found in selected tenant, setting to NULL`);
                    course_id = null;
                }
            }

            let finalGradeId = grade_id;
            if (finalGradeId === '' || finalGradeId === undefined) {
                finalGradeId = null;
            }

            if (Array.isArray(schedule_days)) {
                schedule_days = JSON.stringify(schedule_days);
            } else if (typeof schedule_days === 'string') {
                try {
                    const parsed = JSON.parse(schedule_days);
                    schedule_days = Array.isArray(parsed) ? JSON.stringify(parsed) : JSON.stringify([schedule_days]);
                } catch {
                    schedule_days = JSON.stringify([schedule_days]);
                }
            } else if (schedule_days === undefined) {
                schedule_days = null;
            }

            const result = await execute(
                `UPDATE \`groups\` g
                 SET name = COALESCE(?, name),
                     description = COALESCE(?, description),
                     course_id = COALESCE(?, course_id),
                     grade_id = COALESCE(?, grade_id),
                     max_students = COALESCE(?, max_students),
                     is_active = COALESCE(?, is_active),
                     schedule_days = COALESCE(?, schedule_days),
                     schedule_time = COALESCE(?, schedule_time),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE g.id = ? AND ${scope.sql}`,
                [
                    name ?? null,
                    description ?? null,
                    course_id ?? null,
                    finalGradeId ?? null,
                    max_students ?? null,
                    is_active ?? null,
                    schedule_days ?? null,
                    schedule_time ?? null,
                    req.params.id,
                    ...scope.params,
                ]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Group not found' });
            }

            const updatedGroup = await queryOne<Group>(
                `SELECT * FROM \`groups\` g WHERE g.id = ? AND ${scope.sql}`,
                [req.params.id, ...scope.params]
            );
            res.json(updatedGroup);
        } catch (error) {
            console.error('Update group error:', error);
            res.status(500).json({ error: 'Failed to update group' });
        }
    });

    router.delete('/:id', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user || !['instructor', 'teacher', 'staff'].includes(user.role)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const scope = groupScopeFor(user);
            if (!scope) return res.status(403).json({ error: 'Forbidden' });
            const result = await execute(
                `DELETE g FROM \`groups\` g WHERE g.id = ? AND ${scope.sql}`,
                [req.params.id, ...scope.params]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Group not found' });
            }

            res.json({ message: 'Group deleted successfully' });
        } catch (error) {
            console.error('Delete group error:', error);
            res.status(500).json({ error: 'Failed to delete group' });
        }
    });

    return router;
};

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

export default createGroupsRouter({
    db: {
        query: <T = unknown>(sql: string, params?: unknown[]) => loadDb().then((db) => db.query<T>(sql, params)),
        queryOne: <T = unknown>(sql: string, params?: unknown[]) => loadDb().then((db) => db.queryOne<T>(sql, params)),
        execute: (sql: string, params?: unknown[]) => loadDb().then((db) => db.execute(sql, params)),
    },
    optionalAuthenticate: optionalAuth,
    authenticate: authenticateToken,
    requireTeachingWrite: requireTeachingWrite('groups'),
    hasVerifiedPlatformCapability: (userId) => hasVerifiedPlatformPermission('groups.manage', userId),
});
