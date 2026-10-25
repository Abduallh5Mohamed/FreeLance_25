/**
 * M5 G2 schedules/calendar routes.
 *
 * Authority + audience model (exact-assignment boundaries, 2026-10-19):
 *  - Staff (verified tenant owner or active instructor membership in the
 *    server-selected tenant) create recurring series and manage the concrete
 *    sessions they are entitled to. Authority is resolved from server rows
 *    only; a client-supplied tenant/branch/group is a request, never evidence.
 *  - Branch/group targets are validated to belong to the caller's tenant; a
 *    non-owner instructor may only target a group they own.
 *  - A tenant or branch membership ALONE never grants an ordinary instructor
 *    every group/session: a non-owner's row-level visibility is the live
 *    assigned-group subquery (`groups.instructor_id`, re-checked on every
 *    request, so a reassignment or revocation takes effect immediately) plus
 *    sessions they created themselves. Only the tenant owner keeps the
 *    tenant-wide owner exception. A branch/group selector on a list can only
 *    narrow, never widen, that predicate.
 *  - A recurrence whose authored local wall time does not exist in the target
 *    timezone (DST spring-forward gap) is denied with an explicit 400 BEFORE
 *    any write; it is never silently scheduled an hour earlier.
 *  - Cancel/reschedule require a reason and are audited (actor from the
 *    verified principal, time from the mutation, reason from the request) in
 *    the same transaction as the write; a failed audit aborts the mutation.
 *  - A notification hook interface is injected and invoked after commit. It is
 *    best-effort (no delivery is implemented here); a hook failure never
 *    rolls back or hides a committed schedule change.
 *  - Students only ever receive sessions inside their own audience: a tenant
 *    session for their tenant, a branch session whose branch they are proven
 *    to belong to, or a group session for their own group.
 *  - Every list feed is bounded and explicit: validated `from`/`to` UTC range
 *    filters, deterministic ordering (time column, then id), the page-size cap
 *    the contract already defines, and truncation metadata in one response
 *    header, `X-Results-Truncated: true|false`. Every list returns exactly its
 *    pre-batch top-level shape: the pre-existing bare arrays stay bare arrays.
 *    Feeds are never silently future-only; history stays reachable through
 *    explicit ranges.
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
    ValidatedSeries,
    buildTimeRangeConditions,
    buildVisibleScheduleFilter,
    deterministicSeriesId,
    expandRecurrenceDetailed,
    normalizeId,
    normalizeIdempotencyKey,
    parseTimeRangeFilter,
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

/**
 * Page-size caps already defined by the existing list contracts. Each feed
 * fetches one row past its cap so the response can expose an explicit
 * `X-Results-Truncated` header instead of silently dropping rows past the
 * limit. History stays reachable through the validated `from`/`to` range
 * filters, and each list keeps exactly its pre-batch response shape.
 */
const STUDENT_FEED_PAGE_CAP = 100;
const STAFF_SESSIONS_PAGE_CAP = 500;
const SERIES_LIST_PAGE_CAP = 200;

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
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

/** Persisted series input, projected as text for canonical comparison. */
interface SeriesReplayRow {
    id: string;
    title: string;
    audience: string;
    timezone: string;
    recurrence: string;
    branch_id: string | null;
    group_id: string | null;
    weekdays: string | null;
    day_of_month: number | string | null;
    starts_on: string;
    ends_on: string | null;
    start_time: string;
    duration_minutes: number | string;
}

/** Outcome of resolving an idempotency key against the stored series. */
type SeriesReplayOutcome =
    | { kind: 'absent' }
    | { kind: 'conflict' }
    | { kind: 'match'; body: Record<string, unknown> };

/** `weekdays` is stored as a CSV; compare as the validated sorted day set. */
const normalizeWeekdayCsv = (value: string | null): string => {
    if (value === null || value.trim() === '') return '';
    const days = value.split(',')
        .map((part) => Number(part.trim()))
        .filter((day) => Number.isInteger(day));
    return [...new Set(days)].sort((a, b) => a - b).join(',');
};

const normalizeNullableInteger = (value: number | string | null): number | null =>
    value === null ? null : Number(value);

/** `DATE` may render as `YYYY-MM-DD` or a full timestamp; keep the date part. */
const normalizeCalendarDate = (value: string | null): string | null =>
    value === null || value === '' ? null : value.slice(0, 10);

/** `TIME` renders as `HH:MM:SS`; the recurrence is authored as `HH:MM`. */
const normalizeClockTime = (value: string): string => value.slice(0, 5);

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
     * A live branch membership. Authoring a schedule for a branch is a write on
     * that branch, so a tenant-wide instructor membership alone is not enough:
     * the caller must be an active member of the branch inside this tenant.
     */
    const branchMembership = async (scope: StaffScope, branchId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            `SELECT bm.id FROM branch_memberships bm
             INNER JOIN branches b ON b.id = bm.branch_id AND b.tenant_id = ?
             WHERE bm.branch_id = ? AND bm.user_id = ? AND bm.status = 'active' LIMIT 1`,
            [scope.tenantId, branchId, scope.userId],
        );
        return Boolean(row);
    };

    /** mysql2 duplicate-key error (a replayed idempotent creation). */
    const isDuplicateKeyError = (error: unknown): boolean => {
        if (typeof error !== 'object' || error === null) return false;
        const code = (error as { code?: unknown }).code;
        const errno = (error as { errno?: unknown }).errno;
        return code === 'ER_DUP_ENTRY' || errno === 1062;
    };

    /**
     * The persisted series row behind an idempotency key, projected as text so
     * DATE/TIME/INT columns compare canonically regardless of driver types.
     */
    const loadSeriesReplayRow = async (tenantId: string, seriesId: string): Promise<SeriesReplayRow | null> =>
        db.queryOne<SeriesReplayRow>(
            `SELECT id, title, audience, timezone, recurrence,
                    CAST(branch_id AS CHAR) AS branch_id, CAST(group_id AS CHAR) AS group_id,
                    weekdays, day_of_month,
                    CAST(starts_on AS CHAR) AS starts_on, CAST(ends_on AS CHAR) AS ends_on,
                    CAST(start_time AS CHAR) AS start_time, duration_minutes
             FROM schedule_series WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [seriesId, tenantId],
        );

    /**
     * True when the persisted series is the one the incoming payload would
     * have created. `Idempotency-Key` is scoped to (tenant, author, key), but a
     * key is caller-chosen: reusing it for a different title, group, time,
     * timezone or recurrence must be a conflict, never a silent replay of the
     * old success. Every field that was validated and written is compared.
     */
    const seriesReplayMatches = (row: SeriesReplayRow, value: ValidatedSeries): boolean => {
        const sameNullable = (left: string | null, right: string | null): boolean =>
            (left === null || left === '') ? (right === null || right === '') : left === right;
        return row.title === value.title
            && row.audience === value.audience
            && sameNullable(row.branch_id, value.branchId)
            && sameNullable(row.group_id, value.groupId)
            && row.timezone === value.timezone
            && row.recurrence === value.recurrence
            && normalizeWeekdayCsv(row.weekdays) === value.weekdays.join(',')
            && normalizeNullableInteger(row.day_of_month) === value.dayOfMonth
            && normalizeCalendarDate(row.starts_on) === value.startsOn
            && normalizeCalendarDate(row.ends_on) === value.endsOn
            && normalizeClockTime(row.start_time) === value.startTime
            && Number(row.duration_minutes) === value.durationMinutes;
    };

    /**
     * Resolve an idempotency key to one of three outcomes: no series yet
     * (`absent`), an identical creation (`match`, replayable 201 body), or a
     * different payload under the same key (`conflict`, answered 409).
     */
    const loadSeriesReplay = async (
        tenantId: string,
        seriesId: string,
        value: ValidatedSeries,
    ): Promise<SeriesReplayOutcome> => {
        const row = await loadSeriesReplayRow(tenantId, seriesId);
        if (!row) return { kind: 'absent' };
        if (!seriesReplayMatches(row, value)) return { kind: 'conflict' };
        const count = await db.queryOne<{ n: number | string }>(
            'SELECT COUNT(*) AS n FROM schedule_sessions WHERE series_id = ? AND tenant_id = ?',
            [seriesId, tenantId],
        );
        return {
            kind: 'match',
            body: {
                id: row.id,
                status: 'active',
                audience: row.audience,
                timezone: row.timezone,
                recurrence: row.recurrence,
                sessions: Number(count?.n ?? 0),
            },
        };
    };

    /** A reused key whose payload differs is a conflict, never a replay. */
    const sendIdempotencyConflict = (res: Response): void => {
        res.status(409).json({
            error: 'Idempotency-Key was already used for a different schedule',
            code: 'idempotency_key_reused',
        });
    };

    /**
     * Row-level session visibility under the exact-assignment policy. The
     * owner sees every session in the tenant; a non-owner only sees sessions
     * for a group they are verifiably assigned to (the subquery is evaluated
     * live on every request, so a group reassignment or revoked assignment
     * takes effect immediately) or a session they themselves created. A
     * tenant or branch membership alone is never a grant. Deny by default.
     */
    const buildSessionVisibility = (scope: StaffScope, alias: string): { sql: string; params: unknown[] } => {
        if (scope.isOwner) return { sql: '1=1', params: [] };
        const ownedGroups = `${alias}.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?)`;
        return {
            sql: `(${ownedGroups} OR ${alias}.created_by = ?)`,
            params: [scope.userId, scope.userId],
        };
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
            const range = parseTimeRangeFilter(req.query);
            if (!range.ok) return res.status(400).json({ error: range.error });
            const visibility = buildSessionVisibility(scope, 'schedule_series');
            const timeRange = buildTimeRangeConditions('starts_on', range.value);
            const rows = await db.query(
                `SELECT id, tenant_id, branch_id, group_id, title, audience, timezone, recurrence,
                        weekdays, day_of_month, starts_on, ends_on, start_time, duration_minutes, status, created_at
                 FROM schedule_series
                 WHERE tenant_id = ? AND ${visibility.sql}${timeRange.sql}
                 ORDER BY starts_on DESC, id DESC
                 LIMIT ${SERIES_LIST_PAGE_CAP + 1}`,
                [scope.tenantId, ...visibility.params, ...timeRange.params],
            );
            const truncated = rows.length > SERIES_LIST_PAGE_CAP;
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.json(truncated ? rows.slice(0, SERIES_LIST_PAGE_CAP) : rows);
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
            if (value.audience === 'branch' && !scope.isOwner
                && !(await branchMembership(scope, value.branchId as string))) {
                return res.status(403).json({ error: 'Branch membership required' });
            }
            if (value.audience === 'group' && !(await groupInTenant(scope, value.groupId as string))) {
                return res.status(403).json({ error: 'Group is outside this tenant' });
            }

            const expansion = expandRecurrenceDetailed({
                kind: value.recurrence,
                weekdays: value.weekdays,
                dayOfMonth: value.dayOfMonth,
                startsOn: value.startsOn,
                endsOn: value.endsOn,
                startTime: value.startTime,
                durationMinutes: value.durationMinutes,
                timezone: value.timezone,
            }, maxOccurrences);
            if (expansion.nonexistentDates.length > 0) {
                // A DST spring-forward gap: that local time never happens in
                // the timezone. Deny before any write instead of silently
                // scheduling the shifted earlier instant.
                return res.status(400).json({
                    error: `start_time ${value.startTime} does not exist in ${value.timezone} on ${expansion.nonexistentDates[0]}; choose another time or timezone`,
                });
            }
            const occurrences = expansion.occurrences;
            if (occurrences.length === 0) {
                return res.status(400).json({ error: 'The recurrence produces no sessions' });
            }

            /*
             * Idempotent creation. A caller that retries (timeout, retry loop,
             * double click) sends the same `Idempotency-Key`; the series id is
             * derived from (tenant, author, key), so the retry resolves to the
             * series the first attempt already created and returns the same
             * creation body instead of materializing a second series and a
             * second set of sessions. Without a key the historical behaviour is
             * unchanged (a fresh series per request).
             */
            const headerKey = req.headers?.['idempotency-key'];
            const rawKey = (Array.isArray(headerKey) ? headerKey[0] : headerKey)
                ?? (typeof (req.body as Record<string, unknown> | undefined)?.['idempotency_key'] === 'string'
                    ? (req.body as Record<string, unknown>)['idempotency_key']
                    : undefined);
            let idempotencyKey: string | null = null;
            if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
                idempotencyKey = normalizeIdempotencyKey(rawKey);
                if (!idempotencyKey) return res.status(400).json({ error: 'Invalid Idempotency-Key' });
            }
            const replayId = idempotencyKey
                ? deterministicSeriesId({ tenantId: scope.tenantId, userId: scope.userId, idempotencyKey })
                : null;
            if (replayId) {
                const replay = await loadSeriesReplay(scope.tenantId, replayId, value);
                if (replay.kind === 'conflict') return sendIdempotencyConflict(res);
                if (replay.kind === 'match') return res.status(201).json(replay.body);
            }

            const seriesId = replayId ?? randomUUID();
            const occurrencesWithIds = occurrences.map((occurrence) => ({ id: randomUUID(), ...occurrence }));

            try {
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
                            idempotent: replayId !== null,
                        },
                    });
                });
            } catch (error) {
                // A concurrent retry with the same key won the primary key.
                // Re-read the row and answer from its actual payload: an
                // identical creation replays, a different one conflicts. The
                // losing request must never report success for a payload the
                // stored series does not hold.
                if (replayId && isDuplicateKeyError(error)) {
                    const replay = await loadSeriesReplay(scope.tenantId, replayId, value);
                    if (replay.kind === 'conflict') return sendIdempotencyConflict(res);
                    if (replay.kind === 'match') return res.status(201).json(replay.body);
                }
                throw error;
            }

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
            const range = parseTimeRangeFilter(req.query);
            if (!range.ok) return res.status(400).json({ error: range.error });
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
            const timeRange = buildTimeRangeConditions('starts_at', range.value);
            sql += `${timeRange.sql} ORDER BY starts_at ASC, id ASC LIMIT ${STAFF_SESSIONS_PAGE_CAP + 1}`;
            params.push(...timeRange.params);
            const rows = await db.query(sql, params);
            const truncated = rows.length > STAFF_SESSIONS_PAGE_CAP;
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.json(truncated ? rows.slice(0, STAFF_SESSIONS_PAGE_CAP) : rows);
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
                if (updated.affectedRows === 0) return false;
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
                if (updated.affectedRows === 0) return false;
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
            const range = parseTimeRangeFilter(req.query);
            if (!range.ok) return res.status(400).json({ error: range.error });
            const filter = buildVisibleScheduleFilter(resolved.viewer);
            const timeRange = buildTimeRangeConditions('starts_at', range.value);
            const rows = await db.query(
                `SELECT id, series_id, title, audience, branch_id, group_id, timezone, starts_at, ends_at, status
                 FROM schedule_sessions
                 WHERE tenant_id=? AND status='scheduled' AND ${filter.sql}${timeRange.sql}
                 ORDER BY starts_at ASC, id ASC
                 LIMIT ${STUDENT_FEED_PAGE_CAP + 1}`,
                [resolved.tenantId, ...filter.params, ...timeRange.params],
            );
            const truncated = rows.length > STUDENT_FEED_PAGE_CAP;
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.json(truncated ? rows.slice(0, STUDENT_FEED_PAGE_CAP) : rows);
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

/**
 * Production atomic seam: series materialization, cancel and reschedule each
 * write several rows (series/sessions + audit + notification bookkeeping)
 * under an optimistic version guard; they must commit or roll back together.
 */
const productionTransaction = async <T>(fn: (tx: SchedulesDataAccess) => Promise<T>): Promise<T> => {
    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> => {
            const [rows] = await connection.query(sql, params as never);
            return rows as unknown as R[];
        },
        queryOne: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | null> => {
            const [rows] = await connection.query(sql, params as never);
            return (rows as unknown as R[])[0] ?? null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            const [result] = await connection.execute(sql, params as never);
            const header = result as { insertId?: number; affectedRows?: number };
            const affectedRows = header.affectedRows;
            if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                throw new Error('schedule transaction execute did not report a usable affected-row count');
            }
            return { insertId: typeof header.insertId === 'number' && Number.isSafeInteger(header.insertId) ? header.insertId : 0, affectedRows };
        },
    }));
};

export default createSchedulesRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    transaction: productionTransaction,
});
