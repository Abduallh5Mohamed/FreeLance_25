/**
 * M5 G2 schedules/calendar routes.
 *
 * Authority + audience model:
 *  - Staff (verified tenant owner or active instructor membership in the
 *    server-selected tenant) create recurring series and manage the concrete
 *    sessions they are entitled to. Authority is resolved from server rows
 *    only; a client-supplied tenant/branch/group is a request, never evidence.
 *  - Branch/group targets are validated to belong to the caller's tenant; a
 *    non-owner instructor may only target a group they own.
 *  - Cancel/reschedule require a reason and are audited (actor from the
 *    verified principal, time from the mutation, reason from the request) in
 *    the same transaction as the write; a failed audit aborts the mutation.
 *  - A notification hook interface is injected and invoked after commit. It is
 *    best-effort (no delivery is implemented here); a hook failure never
 *    rolls back or hides a committed schedule change.
 *  - Students only ever receive sessions inside their own audience: a tenant
 *    session for their tenant, a branch session whose branch they are proven
 *    to belong to, or a group session for their own group.
 *
 * Exports `createSchedulesRouter(deps)` and a production default-wired router.
 * Mounting happens in a later task. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import {
    AudienceViewer,
    ScheduleAudience,
    buildVisibleScheduleFilter,
    expandRecurrence,
    normalizeId,
    sessionDurationMinutes,
    toMysqlUtc,
    validateCancelInput,
    validateRescheduleInput,
    validateSeriesInput,
} from '../services/schedules';

export interface SchedulesDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

/** Post-commit notification hook. No delivery is implemented in this module. */
export interface ScheduleChangeEvent {
    type: 'series.created' | 'session.cancelled' | 'session.rescheduled';
    tenantId: string;
    audience: ScheduleAudience;
    branchId: string | null;
    groupId: string | null;
    sessionIds: string[];
    actorUserId: string;
    reason: string | null;
    occurredAt: string;
}

export interface ScheduleNotifier {
    notify(event: ScheduleChangeEvent): Promise<void>;
}

export const NOOP_SCHEDULE_NOTIFIER: ScheduleNotifier = { notify: async () => undefined };

export interface SchedulesDeps {
    db: SchedulesDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    notifications?: ScheduleNotifier;
    now?: () => Date;
    maxOccurrences?: number;
    transaction?: <T>(fn: (tx: SchedulesDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}

interface SeriesRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    group_id: string | null;
    title: string;
    audience: string;
    timezone: string;
    recurrence: string;
    weekdays: string | null;
    day_of_month: number | null;
    starts_on: string | Date;
    ends_on: string | Date | null;
    start_time: string | Date;
    duration_minutes: number;
    status: string;
    version: number;
}

interface SessionRow {
    id: string;
    series_id: string | null;
    tenant_id: string;
    branch_id: string | null;
    group_id: string | null;
    title: string;
    audience: string;
    timezone: string;
    starts_at: string | Date;
    ends_at: string | Date;
    status: string;
    created_by: string | null;
    version: number;
}

export const createSchedulesRouter = (deps: SchedulesDeps): Router => {
    const router = Router();
    const { db } = deps;
    const notifier = deps.notifications ?? NOOP_SCHEDULE_NOTIFIER;
    const now = deps.now ?? (() => new Date());
    const maxOccurrences = deps.maxOccurrences ?? 366;
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: SchedulesDataAccess) => Promise<T>): Promise<T> => fn(db);

    router.use(deps.authenticate);

    const resolveStaffScope = async (req: AuthRequest, res: Response): Promise<StaffScope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (!user.tenantId) {
            res.status(403).json({ error: 'An active tenant membership is required' });
            return null;
        }
        const authority = await deps.loadActiveTenantAuthority(user.id, user.tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) {
            res.status(403).json({ error: 'Tenant instructor authority required' });
            return null;
        }
        return {
            tenantId: user.tenantId,
            userId: user.id,
            isOwner: authority.authority === 'owner',
            branchId: user.branchId ?? null,
        };
    };

    const branchInTenant = async (scope: StaffScope, branchId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; status: string; tenant_id: string }>(
            'SELECT id, status, tenant_id FROM branches WHERE id = ? LIMIT 1',
            [branchId],
        );
        return Boolean(row && row.tenant_id === scope.tenantId && row.status === 'active');
    };

    const groupInTenant = async (scope: StaffScope, groupId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; instructor_id: string | null; tenant_id: string | null }>(
            `SELECT g.id, g.instructor_id, c.tenant_id
             FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
             WHERE g.id = ? LIMIT 1`,
            [groupId],
        );
        if (!row || row.tenant_id !== scope.tenantId) return false;
        return scope.isOwner || row.instructor_id === scope.userId;
    };

    /**
     * Row-level session visibility. The owner sees every session in the tenant;
     * a non-owner only sees sessions for a group they own, a branch they are
     * entitled to, or a session they themselves created. Deny by default.
     */
    const buildSessionVisibility = (scope: StaffScope, alias: string): { sql: string; params: unknown[] } => {
        if (scope.isOwner) return { sql: '1=1', params: [] };
        const ownedGroups = `${alias}.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?)`;
        const params: unknown[] = [scope.userId];
        let sql = `(${ownedGroups} OR ${alias}.created_by = ?`;
        params.push(scope.userId);
        if (scope.branchId) {
            sql += ` OR ${alias}.branch_id = ?`;
            params.push(scope.branchId);
        }
        sql += ')';
        return { sql, params };
    };

    const loadStaffSession = async (scope: StaffScope, sessionId: string): Promise<SessionRow | null> => {
        const visibility = buildSessionVisibility(scope, 'schedule_sessions');
        return db.queryOne<SessionRow>(
            `SELECT id, series_id, tenant_id, branch_id, group_id, title, audience, timezone,
                    starts_at, ends_at, status, created_by, version
             FROM schedule_sessions
             WHERE id = ? AND tenant_id = ? AND ${visibility.sql} LIMIT 1`,
            [sessionId, scope.tenantId, ...visibility.params],
        );
    };

    const notifySafely = async (event: ScheduleChangeEvent): Promise<void> => {
        try {
            await notifier.notify(event);
        } catch (error) {
            console.error('Schedule notification hook failed:', error);
        }
    };

    // -----------------------------------------------------------------------
    // Series
    // -----------------------------------------------------------------------
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const visibility = buildSessionVisibility(scope, 'schedule_series');
            res.json(await db.query(
                `SELECT id, tenant_id, branch_id, group_id, title, audience, timezone, recurrence,
                        weekdays, day_of_month, starts_on, ends_on, start_time, duration_minutes, status, created_at
                 FROM schedule_series
                 WHERE tenant_id = ? AND ${visibility.sql}
                 ORDER BY starts_on DESC LIMIT 200`,
                [scope.tenantId, ...visibility.params],
            ));
        } catch (error) {
            console.error('List schedule series error:', error);
            res.status(500).json({ error: 'Failed to list schedule series' });
        }
    });

    router.post('/series', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const validated = validateSeriesInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;

            if (value.audience === 'branch' && !(await branchInTenant(scope, value.branchId as string))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            if (value.audience === 'group' && !(await groupInTenant(scope, value.groupId as string))) {
                return res.status(403).json({ error: 'Group is outside this tenant' });
            }

            const occurrences = expandRecurrence({
                kind: value.recurrence,
                weekdays: value.weekdays,
                dayOfMonth: value.dayOfMonth,
                startsOn: value.startsOn,
                endsOn: value.endsOn,
                startTime: value.startTime,
                durationMinutes: value.durationMinutes,
                timezone: value.timezone,
            }, maxOccurrences);
            if (occurrences.length === 0) {
                return res.status(400).json({ error: 'The recurrence produces no sessions' });
            }

            const seriesId = randomUUID();
            const occurrencesWithIds = occurrences.map((occurrence) => ({ id: randomUUID(), ...occurrence }));

            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO schedule_series
                       (id, tenant_id, branch_id, group_id, title, audience, timezone, recurrence, weekdays,
                        day_of_month, starts_on, ends_on, start_time, duration_minutes, status, created_by)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)`,
                    [
                        seriesId, scope.tenantId, value.branchId, value.groupId, value.title, value.audience,
                        value.timezone, value.recurrence, value.weekdays.join(','), value.dayOfMonth,
                        value.startsOn, value.endsOn, value.startTime, value.durationMinutes, scope.userId,
                    ],
                );
                for (const occurrence of occurrencesWithIds) {
                    await tx.execute(
                        `INSERT IGNORE INTO schedule_sessions
                           (id, series_id, tenant_id, branch_id, group_id, title, audience, timezone,
                            starts_at, ends_at, status, created_by)
                         VALUES (?,?,?,?,?,?,?,?,?,?, 'scheduled', ?)`,
                        [
                            occurrence.id, seriesId, scope.tenantId, value.branchId, value.groupId, value.title,
                            value.audience, value.timezone, toMysqlUtc(occurrence.startsAt), toMysqlUtc(occurrence.endsAt), scope.userId,
                        ],
                    );
                }
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'schedule.series.create',
                    resourceType: 'schedule_series',
                    resourceId: seriesId,
                    newValue: {
                        title: value.title,
                        audience: value.audience,
                        branch_id: value.branchId,
                        group_id: value.groupId,
                        timezone: value.timezone,
                        recurrence: value.recurrence,
                        sessions: occurrencesWithIds.length,
                    },
                });
            });

            await notifySafely({
                type: 'series.created',
                tenantId: scope.tenantId,
                audience: value.audience,
                branchId: value.branchId,
                groupId: value.groupId,
                sessionIds: occurrencesWithIds.map((occurrence) => occurrence.id),
                actorUserId: scope.userId,
                reason: null,
                occurredAt: now().toISOString(),
            });

            res.status(201).json({
                id: seriesId,
                status: 'active',
                audience: value.audience,
                timezone: value.timezone,
                recurrence: value.recurrence,
                sessions: occurrencesWithIds.length,
            });
        } catch (error) {
            console.error('Create schedule series error:', error);
            res.status(500).json({ error: 'Failed to create schedule series' });
        }
    });

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------
    router.get('/sessions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const visibility = buildSessionVisibility(scope, 'schedule_sessions');
            const params: unknown[] = [scope.tenantId, ...visibility.params];
            let sql = `SELECT id, series_id, tenant_id, branch_id, group_id, title, audience, timezone,
                              starts_at, ends_at, status, cancel_reason, cancelled_at, rescheduled_from
                       FROM schedule_sessions
                       WHERE tenant_id = ? AND ${visibility.sql}`;
            const rawGroup = req.query.group_id;
            if (rawGroup !== undefined) {
                const groupId = normalizeId(rawGroup);
                if (!groupId) return res.status(400).json({ error: 'Invalid group_id filter' });
                sql += ' AND group_id = ?';
                params.push(groupId);
            }
            sql += ' ORDER BY starts_at ASC LIMIT 500';
            res.json(await db.query(sql, params));
        } catch (error) {
            console.error('List schedule sessions error:', error);
            res.status(500).json({ error: 'Failed to list schedule sessions' });
        }
    });

    router.post('/sessions/:id/cancel', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Session not found' });
            const validated = validateCancelInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            const existing = await loadStaffSession(scope, id);
            if (!existing) return res.status(404).json({ error: 'Session not found' });
            if (existing.status === 'cancelled') {
                return res.status(409).json({ error: 'Session is already cancelled' });
            }

            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE schedule_sessions
                     SET status='cancelled', cancel_reason=?, cancelled_by=?, cancelled_at=UTC_TIMESTAMP(),
                         version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND status='scheduled' AND version=?`,
                    [validated.value.reason, scope.userId, id, scope.tenantId, existing.version],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'schedule.session.cancel',
                    resourceType: 'schedule_session',
                    resourceId: id,
                    reason: validated.value.reason,
                    oldValue: snapshotRow(existing),
                    newValue: { status: 'cancelled', reason: validated.value.reason },
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Session changed concurrently' });

            await notifySafely({
                type: 'session.cancelled',
                tenantId: scope.tenantId,
                audience: existing.audience as ScheduleAudience,
                branchId: existing.branch_id,
                groupId: existing.group_id,
                sessionIds: [id],
                actorUserId: scope.userId,
                reason: validated.value.reason,
                occurredAt: now().toISOString(),
            });

            res.json({ id, status: 'cancelled', reason: validated.value.reason });
        } catch (error) {
            console.error('Cancel schedule session error:', error);
            res.status(500).json({ error: 'Failed to cancel schedule session' });
        }
    });

    router.post('/sessions/:id/reschedule', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Session not found' });

            const existing = await loadStaffSession(scope, id);
            if (!existing) return res.status(404).json({ error: 'Session not found' });
            if (existing.status === 'cancelled') {
                return res.status(409).json({ error: 'A cancelled session cannot be rescheduled' });
            }
            const duration = sessionDurationMinutes(existing.starts_at, existing.ends_at);
            if (duration === null) return res.status(500).json({ error: 'Session window is invalid' });

            const validated = validateRescheduleInput(req.body, {
                timezone: existing.timezone,
                durationMinutes: duration,
            });
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;

            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE schedule_sessions
                     SET starts_at=?, ends_at=?, rescheduled_from=starts_at, reschedule_reason=?,
                         rescheduled_by=?, rescheduled_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND status='scheduled' AND version=?`,
                    [
                        toMysqlUtc(value.startsAt), toMysqlUtc(value.endsAt), value.reason,
                        scope.userId, id, scope.tenantId, existing.version,
                    ],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'schedule.session.reschedule',
                    resourceType: 'schedule_session',
                    resourceId: id,
                    reason: value.reason,
                    oldValue: snapshotRow(existing),
                    newValue: {
                        starts_at: toMysqlUtc(value.startsAt),
                        ends_at: toMysqlUtc(value.endsAt),
                        reason: value.reason,
                    },
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Session changed concurrently' });

            await notifySafely({
                type: 'session.rescheduled',
                tenantId: scope.tenantId,
                audience: existing.audience as ScheduleAudience,
                branchId: existing.branch_id,
                groupId: existing.group_id,
                sessionIds: [id],
                actorUserId: scope.userId,
                reason: value.reason,
                occurredAt: now().toISOString(),
            });

            res.json({ id, status: existing.status, starts_at: value.startsAt, ends_at: value.endsAt });
        } catch (error) {
            console.error('Reschedule schedule session error:', error);
            res.status(500).json({ error: 'Failed to reschedule schedule session' });
        }
    });

    // -----------------------------------------------------------------------
    // Student-facing: only the caller's own audience is ever loaded.
    // -----------------------------------------------------------------------
    const resolveStudentViewer = async (
        req: AuthRequest,
        res: Response,
    ): Promise<{ viewer: AudienceViewer; tenantId: string } | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (user.role !== 'student') {
            res.status(403).json({ error: 'Student access required' });
            return null;
        }
        if (!user.tenantId) {
            res.status(403).json({ error: 'An active student workspace is required' });
            return null;
        }
        const row = await db.queryOne<{
            id: string; tenant_id: string; group_id: string | null;
            branch_id: string | null; branch_scope: string | null;
        }>(
            `SELECT s.id, s.tenant_id, s.group_id, grp.branch_id, grp.branch_scope
             FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
             WHERE s.user_id=? AND s.tenant_id=? AND s.is_active=1 AND s.approval_status='approved'
               AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
               AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
               AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
             LIMIT 1`,
            [user.id, user.tenantId],
        );
        if (!row) {
            res.status(404).json({ error: 'Student workspace not found' });
            return null;
        }
        const branchId = row.branch_scope === 'branch' ? row.branch_id : null;
        return {
            tenantId: row.tenant_id,
            viewer: { tenantId: row.tenant_id, branchId, groupId: row.group_id },
        };
    };

    router.get('/student', async (req: AuthRequest, res: Response) => {
        try {
            const resolved = await resolveStudentViewer(req, res);
            if (!resolved) return;
            const filter = buildVisibleScheduleFilter(resolved.viewer);
            const rows = await db.query(
                `SELECT id, series_id, title, audience, branch_id, group_id, timezone, starts_at, ends_at, status
                 FROM schedule_sessions
                 WHERE tenant_id=? AND status='scheduled' AND ${filter.sql}
                 ORDER BY starts_at ASC LIMIT 100`,
                [resolved.tenantId, ...filter.params],
            );
            res.json(rows);
        } catch (error) {
            console.error('Student schedule sessions error:', error);
            res.status(500).json({ error: 'Failed to load schedule sessions' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real tenant authority. */

const TENANT_AUTHORITY_SQL = `
    SELECT 'owner' AS authority
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
    LIMIT 1
`;

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: SchedulesDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};

export default createSchedulesRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
});
