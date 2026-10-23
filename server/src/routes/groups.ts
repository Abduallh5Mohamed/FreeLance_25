import type { PoolConnection } from 'mysql2/promise';
import { getPool } from '../db';
import { Router, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { optionalAuth, instructorScopeId, AuthRequest, authenticateToken } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';
import {
    getResourceBranchDeps,
    principalFromAuthUser,
    resolveResourceBranchAccess,
    resourceBranchDenial,
    type ResourceBranchDeps,
} from '../security/resource-branch';

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
    branch_id?: string | null;
    branch_scope?: string | null;
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
    /** Resource-derived branch authority; defaults to the production SQL deps. */
    branchAccess?: ResourceBranchDeps;
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

/**
 * A row is listable only when its classification is internally consistent:
 * explicit tenant with no branch, or explicit branch with a branch id.
 * Legacy/NULL/unknown scopes and contradictory combinations are ambiguous,
 * denied for normal access, and visible only through the audited quarantine
 * report.
 */
const CLASSIFIED_GROUP_SCOPE = `((g.branch_scope = 'tenant' AND g.branch_id IS NULL)
    OR (g.branch_scope = 'branch' AND g.branch_id IS NOT NULL))`;

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

    /**
     * Resource-derived branch check for an existing group. The group's own
     * branch row is authoritative; a caller selector must match it and a
     * branch-owned group requires a live membership (or the narrow owner /
     * verified-platform path). An unclassified legacy/unknown group is
     * ambiguous and denied for every principal — the quarantine report is the
     * only listing surface, and appearing there never grants content access.
     */
    const enforceGroupBranch = async (
        req: AuthRequest,
        res: Response,
        groupId: string,
    ): Promise<boolean> => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return false;
        }
        const decision = await resolveResourceBranchAccess(
            deps.branchAccess ?? getResourceBranchDeps(),
            principalFromAuthUser(req.user),
            {
                resourceType: 'group',
                resourceId: groupId,
                requestedBranchId: (req.body ?? {}).branch_id ?? req.query?.branch_id,
            },
        );
        if (decision.kind !== 'allowed') {
            const denial = resourceBranchDenial(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };

    /**
     * SQL visibility predicate for classified groups. Branch-owned groups are
     * visible only to an active member of that branch or the tenant owner;
     * explicitly tenant-level groups are unchanged. Unclassified/ambiguous
     * rows are excluded for every list caller.
     */
    const branchVisibility = (user: NonNullable<AuthRequest['user']>): { sql: string; params: unknown[] } => {
        if (user.role === 'admin') return { sql: '', params: [] };
        const params: unknown[] = [user.id, user.tenantId, user.id];
        let sql = ` AND ${CLASSIFIED_GROUP_SCOPE}
            AND (g.branch_scope <> 'branch'
            OR EXISTS (SELECT 1 FROM branch_memberships bm
                       WHERE bm.branch_id = g.branch_id AND bm.user_id = ? AND bm.status = 'active')
            OR EXISTS (SELECT 1 FROM tenants owner_t
                       WHERE owner_t.id = ? AND owner_t.owner_user_id = ? AND owner_t.status = 'active'))`;
        if (user.branchId) {
            sql += ' AND (g.branch_scope <> \'branch\' OR g.branch_id = ?)';
            params.push(user.branchId);
        }
        return { sql, params };
    };

    /**
     * Validate an explicitly requested branch assignment before a create or
     * move. Never trusts the selector: the branch row must be active in the
     * caller's tenant, and the caller must be an active member (or the owner).
     */
    const validateBranchAssignment = async (
        user: NonNullable<AuthRequest['user']>,
        rawBranchId: unknown,
    ): Promise<{ ok: true; branchId: string } | { ok: false; status: number; error: string }> => {
        const branchId = typeof rawBranchId === 'string' ? rawBranchId.trim() : '';
        if (!branchId || !/^[A-Za-z0-9_-]+$/.test(branchId) || branchId.length > 64) {
            return { ok: false, status: 400, error: 'Invalid branch' };
        }
        const tenantId = user.tenantId;
        if (!tenantId) return { ok: false, status: 403, error: 'Workspace access required' };
        const branch = await queryOne<{ id: string; tenant_id: string; status: string }>(
            'SELECT id, tenant_id, status FROM branches WHERE id = ?',
            [branchId],
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
                [branchId, user.id],
            );
            if (!membership) return { ok: false, status: 403, error: 'Branch membership required' };
        }
        return { ok: true, branchId };
    };

    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });

            if (user.role === 'admin') {
                if (!(await deps.hasVerifiedPlatformCapability(user.id))) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
                const groups = await query<Group>(
                    `SELECT g.id, g.name, g.description, g.course_id, g.grade_id, g.max_students, g.current_students, g.is_active, g.schedule_days, g.schedule_time, g.instructor_id, g.branch_id, g.branch_scope FROM \`groups\` g WHERE g.is_active = TRUE AND ${CLASSIFIED_GROUP_SCOPE} ORDER BY g.name`,
                    []
                );
                return res.json(groups.map(row => ({ ...row, schedule_days: readDays(row.schedule_days), schedule_time: readTime(row.schedule_time) })));
            }

            const scope = groupScopeFor(user);
            if (!scope) return res.status(403).json({ error: 'Forbidden' });
            const branch = branchVisibility(user);
            const groups = await query<Group>(
                `SELECT g.id, g.name, g.description, g.course_id, g.grade_id, g.max_students, g.current_students, g.is_active, g.schedule_days, g.schedule_time, g.instructor_id, g.branch_id, g.branch_scope
                 FROM \`groups\` g
                 WHERE g.is_active = TRUE AND ${scope.sql}${branch.sql}
                 ORDER BY g.name`,
                [...scope.params, ...branch.params]
            );
            res.json(groups.map(row => ({ ...row, schedule_days: readDays(row.schedule_days), schedule_time: readTime(row.schedule_time) })));
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
            if (!(await enforceGroupBranch(req, res, req.params.id))) return;
            res.json({ ...group, schedule_days: readDays(group.schedule_days), schedule_time: readTime(group.schedule_time) });
        } catch (error) {
            console.error('Get group error:', error);
            res.status(500).json({ error: 'Failed to fetch group' });
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
            if (!(await enforceGroupBranch(req, res, req.params.id))) return;
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

/** The seven existing weekday keys, in their one canonical order. */
const GROUP_SCHEDULE_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;
type GroupScheduleDay = (typeof GROUP_SCHEDULE_DAYS)[number];
const DAY_SET: ReadonlySet<string> = new Set(GROUP_SCHEDULE_DAYS);

/** A real 24-hour wall-clock time, `HH:mm` (a TIME column may echo `HH:mm:ss`). */
const WRITE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const READ_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** A server-generated UUID. A client-supplied id is only a SELECTOR. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ALLOWED_BODY_KEYS: ReadonlySet<string> = new Set([
    'name',
    'description',
    'course_id',
    'grade_id',
    'max_students',
    'is_active',
    'schedule_days',
    'schedule_time',
    'branch_id',
    'branch_scope',
]);

/**
 * Strict write-side canonicalisation. Returns `undefined` for anything that is
 * not a valid list of unique known keys (so the caller can answer 400); an
 * empty array is a valid "no days" value.
 */
function strictDays(value: unknown): GroupScheduleDay[] | undefined {
    if (!Array.isArray(value)) return undefined;
    if (value.length > GROUP_SCHEDULE_DAYS.length) return undefined;
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'string' || !DAY_SET.has(entry)) return undefined;
        if (seen.has(entry)) return undefined;
        seen.add(entry);
    }
    return GROUP_SCHEDULE_DAYS.filter((day) => seen.has(day));
}

/** `null` clears; a real `HH:mm` sets; anything else is `undefined` (invalid). */
function strictTime(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    return WRITE_TIME_PATTERN.test(value) ? value : undefined;
}

/**
 * Lenient read-side canonicalisation. A legacy row may hold a JSON string, an
 * array, unknown keys or duplicates; the projection only ever emits the seven
 * known keys in canonical order (bounded, never throws).
 */
function readDays(value: unknown): GroupScheduleDay[] {
    let parsed: unknown = value;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { return []; }
    }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    for (const entry of parsed) {
        if (typeof entry === 'string' && DAY_SET.has(entry)) seen.add(entry);
    }
    return GROUP_SCHEDULE_DAYS.filter((day) => seen.has(day));
}

/** A TIME column may arrive as `HH:mm:ss`; the projection always emits `HH:mm`. */
function readTime(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = READ_TIME_PATTERN.exec(value);
    if (!match) return null;
    return `${match[1]}:${match[2]}`;
}

/** The bounded canonical projection. Exactly these ten fields, nothing else. */
const groupDto = (row: any) => ({
    id: String(row.id),
    name: String(row.name),
    description: row.description === undefined ? null : row.description,
    course_id: row.course_id === undefined ? null : row.course_id,
    grade_id: row.grade_id === undefined ? null : row.grade_id,
    max_students: Number(row.max_students ?? 0),
    current_students: Number(row.current_students ?? 0),
    is_active: row.is_active === 1 || row.is_active === true,
    schedule_days: readDays(row.schedule_days),
    schedule_time: readTime(row.schedule_time),
});

// ---------------------------------------------------------------------------
// Body parsing (strict; omission ≠ clear)
// ---------------------------------------------------------------------------

interface GroupPatch {
    name?: string;
    description?: string | null;
    course_id?: string | null;
    grade_id?: string | null;
    max_students?: number;
    is_active?: boolean;
    schedule_days?: GroupScheduleDay[];
    schedule_time?: string | null;
}

type ParseResult = { ok: true; values: GroupPatch } | { ok: false; error: string };

/**
 * Parses the strict canonical body. Only an ABSENT key is "keep"; a present
 * `null` on a clearable field is an explicit clear. `requireName` is used by
 * create (name mandatory); update allows an absent name.
 */
function parsePatch(body: unknown, requireName: boolean): ParseResult {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Invalid group payload' };
    }
    const obj = body as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
        if (!ALLOWED_BODY_KEYS.has(key)) return { ok: false, error: 'Invalid group payload' };
    }

    const values: GroupPatch = {};

    if ('name' in obj) {
        if (typeof obj.name !== 'string' || obj.name.trim() === '' || obj.name.trim().length > 255) {
            return { ok: false, error: 'Group name is required' };
        }
        values.name = obj.name.trim();
    } else if (requireName) {
        return { ok: false, error: 'Group name is required' };
    }

    if ('description' in obj) {
        if (obj.description === null) values.description = null;
        else if (typeof obj.description === 'string' && obj.description.length <= 2000) values.description = obj.description;
        else return { ok: false, error: 'Invalid group payload' };
    }

    if ('course_id' in obj) {
        if (obj.course_id === null) values.course_id = null;
        else if (typeof obj.course_id === 'string' && UUID_PATTERN.test(obj.course_id)) values.course_id = obj.course_id;
        else return { ok: false, error: 'Invalid course selector' };
    }

    if ('grade_id' in obj) {
        if (obj.grade_id === null) values.grade_id = null;
        else if (typeof obj.grade_id === 'string' && UUID_PATTERN.test(obj.grade_id)) values.grade_id = obj.grade_id;
        else return { ok: false, error: 'Invalid grade selector' };
    }

    if ('max_students' in obj) {
        const value = obj.max_students;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
            return { ok: false, error: 'Invalid max students' };
        }
        values.max_students = value;
    }

    if ('is_active' in obj) {
        if (typeof obj.is_active !== 'boolean') return { ok: false, error: 'Invalid group payload' };
        values.is_active = obj.is_active;
    }

    if ('schedule_days' in obj) {
        if (obj.schedule_days === null) values.schedule_days = [];
        else {
            const days = strictDays(obj.schedule_days);
            if (days === undefined) return { ok: false, error: 'Invalid schedule days' };
            values.schedule_days = days;
        }
    }

    if ('schedule_time' in obj) {
        const time = strictTime(obj.schedule_time);
        if (time === undefined) return { ok: false, error: 'Invalid schedule time' };
        values.schedule_time = time;
    }

    return { ok: true, values };
}

// ---------------------------------------------------------------------------
// Scoping helpers (server-derived; a client selector never grants authority)
// ---------------------------------------------------------------------------

/**
 * Builds the read predicate from the SERVER-derived instructor scope and the
 * server-selected tenant. An instructor sees only their own groups; any other
 * teaching principal sees only groups whose instructor has an ACTIVE membership
 * in the selected tenant.
 *
 * A server-resolved tenant is mandatory: without one there is no tenant
 * boundary, so callers must refuse before invoking this helper. The tenant
 * predicate is therefore always present and can never be dropped in favour of
 * an instructor-only read of another tenant's rows.
 */
function scopePredicate(scopeId: string | null, tenantId: string): { where: string; params: any[] } {
    const conditions: string[] = [
        'g.is_active = TRUE',
        "g.instructor_id IN (SELECT user_id FROM tenant_memberships WHERE tenant_id=? AND status='active')",
    ];
    const params: any[] = [tenantId];
    if (scopeId) {
        conditions.push('g.instructor_id = ?');
        params.push(scopeId);
    }
    return { where: conditions.join(' AND '), params };
}

const GROUP_COLUMNS =
    'g.id,g.name,g.description,g.course_id,g.grade_id,g.max_students,g.current_students,g.is_active,g.schedule_days,g.schedule_time';

// ---------------------------------------------------------------------------
const MEMBER_LOCK_SELECT =
    "SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status " +
    'FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id ' +
    "WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1 FOR UPDATE";

/**
 * Locks the target group under BOTH the selected tenant (through the owning
 * instructor's active membership) and, when the caller has an instructor
 * scope, the caller's own scope. A group outside either boundary is
 * indistinguishable from a missing one.
 */
const groupLockSelect = (scoped: boolean): string =>
    `SELECT ${GROUP_COLUMNS} FROM \`groups\` g ` +
    'JOIN tenant_memberships tm ON tm.user_id=g.instructor_id AND tm.tenant_id=? AND tm.status=\'active\' ' +
    `WHERE g.id=?${scoped ? ' AND g.instructor_id=?' : ''} AND g.is_active=TRUE FOR UPDATE`;

const GROUP_UPDATE_SQL =
    'UPDATE `groups` SET name=?,description=?,course_id=?,grade_id=?,max_students=?,is_active=?,schedule_days=?,schedule_time=?,updated_at=CURRENT_TIMESTAMP WHERE id=?';

const GROUP_INSERT_SQL =
    'INSERT INTO `groups` (id,name,description,course_id,grade_id,instructor_id,max_students,is_active,schedule_days,schedule_time,branch_id,branch_scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';

const AUDIT_SQL =
    'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

interface MembershipRow { role_key: string; caller_active: number | boolean; tenant_status: string }

const isTeachingMember = (row: MembershipRow | undefined): boolean =>
    !!row &&
    (row.role_key === 'owner' || row.role_key === 'instructor') &&
    Number(row.caller_active) === 1 &&
    row.tenant_status === 'active';


router.post('/', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });

    let branchId: string | null = null;
    let branchScope = 'tenant';
    const requestedBranchId = req.body?.branch_id;
    if (requestedBranchId !== undefined && requestedBranchId !== null && requestedBranchId !== '') {
        const branch = await validateBranchAssignment(req.user!, requestedBranchId);
        if (!branch.ok) return res.status(branch.status).json({ error: branch.error });
        branchId = branch.branchId;
        branchScope = 'branch';
    } else if (req.body?.branch_scope === 'branch') {
        return res.status(400).json({ error: 'A branch is required for a branch-scoped group' });
    }
    const parsed = parsePatch(req.body, true);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const values = parsed.values;

    try {
        // Reject a foreign/missing course selector instead of silently nulling it.
        if (values.course_id) {
            const course = await queryOne<any>('SELECT id FROM courses WHERE id=? AND tenant_id=? AND is_active=TRUE', [values.course_id, tenantId]);
            if (!course) return res.status(400).json({ error: 'Invalid course selector' });
        }
        // Grades are a global vocabulary; only existence is verifiable.
        if (values.grade_id) {
            const grade = await queryOne<any>('SELECT id FROM grades WHERE id=?', [values.grade_id]);
            if (!grade) return res.status(400).json({ error: 'Invalid grade selector' });
        }
    } catch (error) {
        console.error('Create group selector check error:', error);
        return res.status(500).json({ error: 'Failed to save group' });
    }

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        // Authority revalidation inside the transaction, on the same connection.
        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        const newId = randomUUID();
        const days = values.schedule_days ?? [];
        const time = values.schedule_time ?? null;
        const maxStudents = values.max_students ?? 30;
        const isActive = values.is_active === false ? 0 : 1;

        await connection.execute(GROUP_INSERT_SQL, [
            newId,
            values.name,
            values.description ?? null,
            values.course_id ?? null,
            values.grade_id ?? null,
            callerId,
            maxStudents,
            isActive,
            JSON.stringify(days),
            time,
            branchId,
            branchScope,
        ]);

        await connection.execute(AUDIT_SQL, [
            randomUUID(), callerId, tenantId, 'group.created', 'group', newId,
            null,
            JSON.stringify({ schedule_days: days, schedule_time: time }),
        ]);

        commitAttempted = true;
        await connection.commit();

        return res.status(201).json(groupDto({
            id: newId,
            name: values.name,
            description: values.description ?? null,
            course_id: values.course_id ?? null,
            grade_id: values.grade_id ?? null,
            max_students: maxStudents,
            current_students: 0,
            is_active: isActive,
            schedule_days: days,
            schedule_time: time,
        }));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Create group error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Create group error:', error);
        } else {
            disposal = 'destroy';
            console.error('Create group error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to save group' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
    }
});

// Update group (omission keeps, null clears, truthful no-op)
router.put('/:id', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const groupId = String(req.params?.id ?? '');
    if (!UUID_PATTERN.test(groupId)) return res.status(404).json({ error: 'Group not found' });

    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
    const scopeId = instructorScopeId(req);

    if (!(await enforceGroupBranch(req, res, groupId))) return;
    // Branch movement has no implicit path through a schedule update.
    if ('branch_id' in (req.body ?? {}) || 'branch_scope' in (req.body ?? {})) {
        return res.status(400).json({ error: 'Branch changes require a dedicated authority workflow' });
    }
    const parsed = parsePatch(req.body, false);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const patch = parsed.values;

    try {
        if (patch.course_id) {
            const course = await queryOne<any>('SELECT id FROM courses WHERE id=? AND tenant_id=? AND is_active=TRUE', [patch.course_id, tenantId]);
            if (!course) return res.status(400).json({ error: 'Invalid course selector' });
        }
        if (patch.grade_id) {
            const grade = await queryOne<any>('SELECT id FROM grades WHERE id=?', [patch.grade_id]);
            if (!grade) return res.status(400).json({ error: 'Invalid grade selector' });
        }
    } catch (error) {
        console.error('Update group selector check error:', error);
        return res.status(500).json({ error: 'Failed to save group' });
    }

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        // Lock the target group, scoped to the caller's tenant via its instructor
        // membership and to the caller's own instructor scope: a foreign group is
        // indistinguishable from a missing one.
        const lockSql = groupLockSelect(scopeId !== null);
        const lockParams = scopeId !== null ? [tenantId, groupId, scopeId] : [tenantId, groupId];
        const [groupRows] = await connection.execute<any[]>(lockSql, lockParams);
        const current = (groupRows as any[])[0];
        if (!current) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Group not found' });
        }

        const currentDays = readDays(current.schedule_days);
        const currentTime = readTime(current.schedule_time);
        const currentActive = current.is_active === 1 || current.is_active === true;
        const currentMax = Number(current.max_students ?? 30);

        const next = {
            name: patch.name !== undefined ? patch.name : String(current.name),
            description: patch.description !== undefined ? patch.description : (current.description ?? null),
            course_id: patch.course_id !== undefined ? patch.course_id : (current.course_id ?? null),
            grade_id: patch.grade_id !== undefined ? patch.grade_id : (current.grade_id ?? null),
            max_students: patch.max_students !== undefined ? patch.max_students : currentMax,
            is_active: patch.is_active !== undefined ? patch.is_active : currentActive,
            schedule_days: patch.schedule_days !== undefined ? patch.schedule_days : currentDays,
            schedule_time: patch.schedule_time !== undefined ? patch.schedule_time : currentTime,
        };

        const scheduleChanged =
            JSON.stringify(next.schedule_days) !== JSON.stringify(currentDays) ||
            next.schedule_time !== currentTime;

        const changed =
            next.name !== String(current.name) ||
            (next.description ?? null) !== (current.description ?? null) ||
            (next.course_id ?? null) !== (current.course_id ?? null) ||
            (next.grade_id ?? null) !== (current.grade_id ?? null) ||
            next.max_students !== currentMax ||
            next.is_active !== currentActive ||
            scheduleChanged;

        if (!changed) {
            // Truthful no-op: write nothing, audit nothing.
            await rollbackOrDiscard();
            return res.json(groupDto(current));
        }

        const [updateResult] = await connection.execute<any[]>(GROUP_UPDATE_SQL, [
            next.name,
            next.description,
            next.course_id,
            next.grade_id,
            next.max_students,
            next.is_active ? 1 : 0,
            JSON.stringify(next.schedule_days),
            next.schedule_time,
            groupId,
        ]);
        if (Number((updateResult as any)?.affectedRows) !== 1) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Group not found' });
        }

        await connection.execute(AUDIT_SQL, [
            randomUUID(), callerId, tenantId,
            scheduleChanged ? 'group.schedule_updated' : 'group.updated',
            'group', groupId,
            JSON.stringify({ schedule_days: currentDays, schedule_time: currentTime }),
            JSON.stringify({ schedule_days: next.schedule_days, schedule_time: next.schedule_time }),
        ]);

        commitAttempted = true;
        await connection.commit();

        return res.json(groupDto({
            id: groupId,
            name: next.name,
            description: next.description,
            course_id: next.course_id,
            grade_id: next.grade_id,
            max_students: next.max_students,
            current_students: Number(current.current_students ?? 0),
            is_active: next.is_active ? 1 : 0,
            schedule_days: next.schedule_days,
            schedule_time: next.schedule_time,
        }));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Update group error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Update group error:', error);
        } else {
            disposal = 'destroy';
            console.error('Update group error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to save group' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
    }
});



    router.use('/:groupId/announcements', deps.authenticate, async (req: AuthRequest, res: Response, next) => {
        try {
            if (!(await enforceGroupBranch(req, res, req.params.groupId))) return;
            next();
        } catch { res.status(503).json({ error: 'Group authority unavailable' }); }
    });

// M2-21 — private group announcements (audited management lifecycle)
//
// A PRIVATE management surface for the groups an instructor already owns: a
// bounded title and body, an explicit `draft` / `published` / `retracted` state
// and SERVER timestamps. `published` makes a record visible through THIS
// authenticated management surface only — nothing in this batch exposes it to a
// student principal.
//
// It sends nothing (no email, SMS or push), schedules nothing (no publish-at,
// expiry, delivery window or timezone policy), and creates no session,
// attendance, enrollment, access, role or billing effect. Authority is the
// authenticated caller plus the server-selected active tenant plus an owned
// same-tenant group; no tenant or instructor authority is ever read from request
// data.
// ---------------------------------------------------------------------------

const ANNOUNCEMENT_TITLE_MAX = 255;
const ANNOUNCEMENT_BODY_MAX = 4000;
const ANNOUNCEMENT_PAGE_DEFAULT = 25;
const ANNOUNCEMENT_PAGE_MAX = 100;

/** The only two states a CLIENT may ask for. `retracted` is server-only. */
const WRITABLE_ANNOUNCEMENT_STATES: ReadonlySet<string> = new Set(['draft', 'published']);

const ANNOUNCEMENT_ALLOWED_KEYS: ReadonlySet<string> = new Set(['title', 'body', 'state']);

const ANNOUNCEMENT_COLUMNS =
    'a.id,a.group_id,a.title,a.body,a.state,a.created_at,a.updated_at,a.retracted_at';

/**
 * Renders a stored SERVER timestamp for the projection.
 *
 * The value is exactly what the driver returned for the stored server value (a
 * `Date` becomes its ISO instant). This batch applies NO timezone conversion,
 * no publish-at/expiry policy and no ordering interpretation: the client treats
 * the value as an opaque server label.
 */
const announcementStamp = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
};

/**
 * The fixed EIGHT-field projection. `tenant_id`, `instructor_id` and every other
 * column stay server-owned and are never spread into a response.
 */
const announcementDto = (row: any) => ({
    id: String(row.id),
    group_id: String(row.group_id),
    title: String(row.title),
    body: String(row.body),
    state: String(row.state),
    created_at: announcementStamp(row.created_at),
    updated_at: announcementStamp(row.updated_at),
    retracted_at: announcementStamp(row.retracted_at),
});

/** Opaque page position. It encodes a POSITION (the last id), never authority. */
const encodeAnnouncementCursor = (id: string): string =>
    Buffer.from(id, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const decodeAnnouncementCursor = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
    try {
        const id = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return UUID_PATTERN.test(id) ? id : null;
    } catch {
        return null;
    }
};

/** The bounded page size: 1..100, default 25. Anything else is a 400. */
const parseAnnouncementLimit = (raw: unknown): number | null => {
    if (raw === undefined) return ANNOUNCEMENT_PAGE_DEFAULT;
    if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
    const limit = Number(raw);
    if (limit < 1 || limit > ANNOUNCEMENT_PAGE_MAX) return null;
    return limit;
};

interface AnnouncementValues {
    title?: string;
    body?: string;
    state?: 'draft' | 'published';
}

type AnnouncementParse =
    | { ok: true; values: AnnouncementValues }
    | { ok: false; error: string };

/**
 * Strict canonical payload: EXACTLY `title`, `body` and `state`, nothing else.
 *
 * `requireContent` is used by create (title and body mandatory); update accepts
 * any subset, so an absent key means "keep" and an empty object is a truthful
 * no-op rather than a silent rewrite.
 *
 * A title is trimmed to 1..255. A body must be non-blank and at most 4000
 * characters, and is stored EXACTLY as sent (only the emptiness test trims). A
 * state is only ever `draft` or `published`: `retracted` is reachable solely
 * through the explicit retract action, so a client can never forge a retraction
 * timestamp by writing a state.
 */
function parseAnnouncementBody(body: unknown, requireContent: boolean): AnnouncementParse {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Invalid announcement payload' };
    }
    const obj = body as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
        if (!ANNOUNCEMENT_ALLOWED_KEYS.has(key)) {
            return { ok: false, error: 'Invalid announcement payload' };
        }
    }

    const values: AnnouncementValues = {};

    if ('title' in obj) {
        if (typeof obj.title !== 'string') return { ok: false, error: 'Invalid announcement title' };
        const title = obj.title.trim();
        if (title.length < 1 || title.length > ANNOUNCEMENT_TITLE_MAX) {
            return { ok: false, error: 'Invalid announcement title' };
        }
        values.title = title;
    } else if (requireContent) {
        return { ok: false, error: 'Invalid announcement title' };
    }

    if ('body' in obj) {
        if (typeof obj.body !== 'string') return { ok: false, error: 'Invalid announcement body' };
        if (obj.body.trim().length < 1 || obj.body.length > ANNOUNCEMENT_BODY_MAX) {
            return { ok: false, error: 'Invalid announcement body' };
        }
        values.body = obj.body;
    } else if (requireContent) {
        return { ok: false, error: 'Invalid announcement body' };
    }

    if ('state' in obj) {
        if (typeof obj.state !== 'string' || !WRITABLE_ANNOUNCEMENT_STATES.has(obj.state)) {
            return { ok: false, error: 'Invalid announcement state' };
        }
        values.state = obj.state as 'draft' | 'published';
    }

    return { ok: true, values };
}

const ANNOUNCEMENT_LIST_SQL =
    `SELECT ${ANNOUNCEMENT_COLUMNS} FROM group_announcements a ` +
    'WHERE a.group_id=? AND a.tenant_id=? AND a.id>? ORDER BY a.id ASC LIMIT ?';

const ANNOUNCEMENT_LOCK_SELECT =
    `SELECT ${ANNOUNCEMENT_COLUMNS} FROM group_announcements a ` +
    'WHERE a.id=? AND a.group_id=? AND a.tenant_id=? FOR UPDATE';

const ANNOUNCEMENT_INSERT_SQL =
    'INSERT INTO group_announcements (id,tenant_id,instructor_id,group_id,title,body,state) VALUES (?,?,?,?,?,?,?)';

const ANNOUNCEMENT_UPDATE_SQL =
    'UPDATE group_announcements SET title=?,body=?,state=?,retracted_at=?,updated_at=CURRENT_TIMESTAMP ' +
    'WHERE id=? AND group_id=? AND tenant_id=?';

const ANNOUNCEMENT_RETRACT_SQL =
    "UPDATE group_announcements SET state='retracted',retracted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP " +
    "WHERE id=? AND group_id=? AND tenant_id=? AND state<>'retracted'";

const ANNOUNCEMENT_READ_SQL =
    `SELECT ${ANNOUNCEMENT_COLUMNS} FROM group_announcements a ` +
    'WHERE a.id=? AND a.group_id=? AND a.tenant_id=? LIMIT 1';

// Bounded announcement list for ONE owned group.
router.get('/:groupId/announcements', deps.authenticate, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const groupId = String(req.params?.groupId ?? '');
    if (!UUID_PATTERN.test(groupId)) return res.status(404).json({ error: 'Group not found' });

    const limit = parseAnnouncementLimit(req.query?.limit);
    if (limit === null) return res.status(400).json({ error: 'Invalid announcement list limit' });
    const rawCursor = req.query?.cursor;
    const cursorId = rawCursor === undefined ? '' : decodeAnnouncementCursor(rawCursor);
    if (cursorId === null) return res.status(400).json({ error: 'Invalid announcement list cursor' });

    const tenantId = req.user?.tenantId;
    if (!tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    try {
        // The group is resolved under the SAME scope + tenant predicate the group
        // reads use, so a foreign, inactive or absent group is one 404 and never
        // discloses whether an announcement of another tenant exists.
        const predicate = scopePredicate(instructorScopeId(req), tenantId);
        const group = await queryOne<any>(
            `SELECT g.id FROM \`groups\` g WHERE g.id=? AND ${predicate.where} LIMIT 1`,
            [groupId, ...predicate.params]
        );
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const rows = await query<any>(ANNOUNCEMENT_LIST_SQL, [groupId, tenantId, cursorId, limit + 1]);
        const page = rows ?? [];
        const hasMore = page.length > limit;
        const visible = hasMore ? page.slice(0, limit) : page;
        return res.json({
            announcements: visible.map(announcementDto),
            next_cursor: hasMore && visible.length > 0
                ? encodeAnnouncementCursor(String(visible[visible.length - 1].id))
                : null,
        });
    } catch (error) {
        console.error('List group announcements error:', error);
        return res.status(500).json({ error: 'Failed to list announcements' });
    }
});

// Create ONE announcement on an owned group.
router.post('/:groupId/announcements', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const groupId = String(req.params?.groupId ?? '');
    if (!UUID_PATTERN.test(groupId)) return res.status(404).json({ error: 'Group not found' });

    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });

    const parsed = parseAnnouncementBody(req.body, true);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const values = parsed.values;
    const scopeId = instructorScopeId(req);

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        // Authority revalidation inside the transaction, on the same connection.
        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        // The target group is locked under the selected tenant AND the caller's
        // own instructor scope: a foreign group is indistinguishable from a
        // missing one.
        const lockSql = groupLockSelect(scopeId !== null);
        const lockParams = scopeId !== null ? [tenantId, groupId, scopeId] : [tenantId, groupId];
        const [groupRows] = await connection.execute<any[]>(lockSql, lockParams);
        if (!(groupRows as any[])[0]) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Group not found' });
        }

        const announcementId = randomUUID();
        const state = values.state ?? 'draft';
        await connection.execute(ANNOUNCEMENT_INSERT_SQL, [
            announcementId, tenantId, callerId, groupId, values.title, values.body, state,
        ]);

        // Exactly ONE sanitized audit event, committed with the write. The title
        // and body are deliberately NEVER copied into the audit: the event
        // records WHO created WHICH announcement in WHICH group and state, not
        // the private content.
        await connection.execute(AUDIT_SQL, [
            randomUUID(), callerId, tenantId, 'group.announcement_created', 'group_announcement', announcementId,
            null,
            JSON.stringify({ group_id: groupId, state }),
        ]);

        // The row is read back inside the same transaction so the response is
        // the stored projection, including the SERVER timestamps.
        const [readRows] = await connection.execute<any[]>(ANNOUNCEMENT_READ_SQL, [announcementId, groupId, tenantId]);
        const created = (readRows as any[])[0];
        if (!created) {
            await rollbackOrDiscard();
            return res.status(500).json({ error: 'Failed to save announcement' });
        }

        commitAttempted = true;
        await connection.commit();
        return res.status(201).json(announcementDto(created));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Create announcement error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Create announcement error:', error);
        } else {
            disposal = 'destroy';
            console.error('Create announcement error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to save announcement' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
    }
});

// Edit ONE announcement (title/body) and/or change its draft/published state.
router.put('/:groupId/announcements/:announcementId', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const groupId = String(req.params?.groupId ?? '');
    if (!UUID_PATTERN.test(groupId)) return res.status(404).json({ error: 'Group not found' });
    const announcementId = String(req.params?.announcementId ?? '');
    if (!UUID_PATTERN.test(announcementId)) return res.status(404).json({ error: 'Announcement not found' });

    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });

    const parsed = parseAnnouncementBody(req.body, false);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const patch = parsed.values;
    const scopeId = instructorScopeId(req);

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        const lockSql = groupLockSelect(scopeId !== null);
        const lockParams = scopeId !== null ? [tenantId, groupId, scopeId] : [tenantId, groupId];
        const [groupRows] = await connection.execute<any[]>(lockSql, lockParams);
        if (!(groupRows as any[])[0]) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Group not found' });
        }

        // The announcement is qualified by BOTH its group and the selected
        // tenant: an announcement of another group or tenant is one 404.
        const [announcementRows] = await connection.execute<any[]>(ANNOUNCEMENT_LOCK_SELECT, [
            announcementId, groupId, tenantId,
        ]);
        const current = (announcementRows as any[])[0];
        if (!current) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Announcement not found' });
        }

        const currentState = String(current.state);
        if (currentState === 'retracted') {
            // Retraction is terminal: a retracted announcement is never edited
            // and never re-published, so its retracted_at stays truthful.
            await rollbackOrDiscard();
            return res.status(409).json({ error: 'Announcement is retracted' });
        }

        const next = {
            title: patch.title !== undefined ? patch.title : String(current.title),
            body: patch.body !== undefined ? patch.body : String(current.body),
            state: patch.state !== undefined ? patch.state : currentState,
        };

        const changed =
            next.title !== String(current.title) ||
            next.body !== String(current.body) ||
            next.state !== currentState;

        if (!changed) {
            // Truthful no-op: write nothing, audit nothing, answer with the
            // current stored projection.
            await rollbackOrDiscard();
            return res.json(announcementDto(current));
        }

        const [updateResult] = await connection.execute<any[]>(ANNOUNCEMENT_UPDATE_SQL, [
            next.title, next.body, next.state, null, announcementId, groupId, tenantId,
        ]);
        if (Number((updateResult as any)?.affectedRows) !== 1) {
            await rollbackOrDiscard();
            return res.status(409).json({ error: 'Announcement was modified concurrently' });
        }

        // A draft -> published transition is its own audited action; every other
        // confirmed change is an edit. Both carry the state only.
        const publishing = currentState !== 'published' && next.state === 'published';
        await connection.execute(AUDIT_SQL, [
            randomUUID(), callerId, tenantId,
            publishing ? 'group.announcement_published' : 'group.announcement_updated',
            'group_announcement', announcementId,
            JSON.stringify({ state: currentState }),
            JSON.stringify({ state: next.state }),
        ]);

        const [readRows] = await connection.execute<any[]>(ANNOUNCEMENT_READ_SQL, [announcementId, groupId, tenantId]);
        const updated = (readRows as any[])[0];
        if (!updated) {
            await rollbackOrDiscard();
            return res.status(500).json({ error: 'Failed to save announcement' });
        }

        commitAttempted = true;
        await connection.commit();
        return res.json(announcementDto(updated));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Update announcement error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Update announcement error:', error);
        } else {
            disposal = 'destroy';
            console.error('Update announcement error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to save announcement' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
    }
});

// Retract ONE announcement (explicit, terminal, audited).
router.post('/:groupId/announcements/:announcementId/retract', deps.requireTeachingWrite, async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const groupId = String(req.params?.groupId ?? '');
    if (!UUID_PATTERN.test(groupId)) return res.status(404).json({ error: 'Group not found' });
    const announcementId = String(req.params?.announcementId ?? '');
    if (!UUID_PATTERN.test(announcementId)) return res.status(404).json({ error: 'Announcement not found' });

    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });

    const scopeId = instructorScopeId(req);

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        const lockSql = groupLockSelect(scopeId !== null);
        const lockParams = scopeId !== null ? [tenantId, groupId, scopeId] : [tenantId, groupId];
        const [groupRows] = await connection.execute<any[]>(lockSql, lockParams);
        if (!(groupRows as any[])[0]) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Group not found' });
        }

        const [announcementRows] = await connection.execute<any[]>(ANNOUNCEMENT_LOCK_SELECT, [
            announcementId, groupId, tenantId,
        ]);
        const current = (announcementRows as any[])[0];
        if (!current) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Announcement not found' });
        }

        if (String(current.state) === 'retracted') {
            // Truthful no-op: already retracted, so no second retraction is
            // recorded and the original retracted_at is preserved.
            await rollbackOrDiscard();
            return res.json(announcementDto(current));
        }

        const [retractResult] = await connection.execute<any[]>(ANNOUNCEMENT_RETRACT_SQL, [
            announcementId, groupId, tenantId,
        ]);
        if (Number((retractResult as any)?.affectedRows) !== 1) {
            await rollbackOrDiscard();
            return res.status(409).json({ error: 'Announcement was modified concurrently' });
        }

        await connection.execute(AUDIT_SQL, [
            randomUUID(), callerId, tenantId, 'group.announcement_retracted', 'group_announcement', announcementId,
            JSON.stringify({ state: String(current.state) }),
            JSON.stringify({ state: 'retracted' }),
        ]);

        const [readRows] = await connection.execute<any[]>(ANNOUNCEMENT_READ_SQL, [announcementId, groupId, tenantId]);
        const retracted = (readRows as any[])[0];
        if (!retracted) {
            await rollbackOrDiscard();
            return res.status(500).json({ error: 'Failed to save announcement' });
        }

        commitAttempted = true;
        await connection.commit();
        return res.json(announcementDto(retracted));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Retract announcement error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Retract announcement error:', error);
        } else {
            disposal = 'destroy';
            console.error('Retract announcement error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to save announcement' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
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
