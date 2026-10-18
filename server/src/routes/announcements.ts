/**
 * C11 schedules + announcements routes.
 *
 * Audience + permission model:
 *  - Staff (verified tenant owner or active instructor membership in the
 *    server-selected tenant) may list/create/edit/retract announcements and
 *    list/create/edit/cancel schedules. Authority is resolved from server rows
 *    only; a client-supplied tenant/branch is never evidence of membership.
 *  - A branch/group target is validated to belong to the caller's tenant before
 *    any write. Cross-tenant/unprovable targets are denied.
 *  - Every create/edit/retract/cancel is audited (before/after) in the same
 *    transaction as the mutation, so a failed audit aborts the write.
 *  - Students only ever receive rows inside their own audience: a tenant row
 *    for their tenant, a branch row whose branch they are proven to belong to,
 *    or a group row for their own group. Rows outside that audience are
 *    filtered in SQL and never loaded.
 *
 * This module exports `createAnnouncementsRouter(deps)`; it is intentionally
 * not mounted anywhere by this task. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import {
    AudienceViewer,
    buildVisibleAnnouncementFilter,
    buildVisibleScheduleFilter,
    normalizeId,
    toMysqlUtc,
    validateAnnouncementInput,
    validateScheduleInput,
} from '../services/announcements';

export interface AnnouncementsDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface AnnouncementsDeps {
    db: AnnouncementsDataAccess;
    authenticate: RequestHandler;
    /** Server-owned active authority of the principal inside the selected tenant. */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /** Optional atomic seam; production supplies a pooled transaction. */
    transaction?: <T>(fn: (tx: AnnouncementsDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface AnnouncementRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    title: string;
    body: string;
    audience: string;
    status: string;
    published_at: string | Date | null;
    retracted_at?: string | Date | null;
    version: number;
}

interface ScheduleRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    group_id: string | null;
    title: string;
    audience: string;
    timezone: string;
    starts_at: string | Date;
    ends_at: string | Date;
    status: string;
    version: number;
}

export const createAnnouncementsRouter = (deps: AnnouncementsDeps): Router => {
    const router = Router();
    const { db } = deps;
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: AnnouncementsDataAccess) => Promise<T>): Promise<T> => fn(db);

    router.use(deps.authenticate);

    const resolveStaffScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<{ tenantId: string; userId: string } | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        const tenantId = user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'An active tenant membership is required' });
            return null;
        }
        const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) {
            res.status(403).json({ error: 'Tenant instructor authority required' });
            return null;
        }
        return { tenantId, userId: user.id };
    };

    const branchInTenant = async (tenantId: string, branchId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; status: string }>(
            'SELECT id, status FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1',
            [branchId, tenantId],
        );
        return Boolean(row && row.status === 'active');
    };

    const groupInTenant = async (tenantId: string, groupId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            `SELECT g.id FROM \`groups\` g
             LEFT JOIN courses c ON c.id = g.course_id
             WHERE g.id = ? AND (c.tenant_id = ?
               OR EXISTS (SELECT 1 FROM tenants t WHERE t.id = ? AND t.owner_user_id = g.instructor_id))
             LIMIT 1`,
            [groupId, tenantId, tenantId],
        );
        return Boolean(row);
    };

    // -----------------------------------------------------------------------
    // Announcements
    // -----------------------------------------------------------------------
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const rawBranch = req.query.branch_id;
            const branchFilter = rawBranch === undefined ? null : normalizeId(rawBranch);
            if (rawBranch !== undefined && branchFilter === null) {
                return res.status(400).json({ error: 'Invalid branch_id filter' });
            }
            const params: unknown[] = [scope.tenantId];
            let sql = `SELECT id,title,body,audience,branch_id,status,published_at,retracted_at,created_at
                       FROM announcements WHERE tenant_id=?`;
            if (branchFilter) {
                sql += ' AND branch_id=?';
                params.push(branchFilter);
            }
            sql += ' ORDER BY published_at DESC LIMIT 200';
            res.json(await db.query(sql, params));
        } catch (error) {
            console.error('List announcements error:', error);
            res.status(500).json({ error: 'Failed to list announcements' });
        }
    });

    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const validated = validateAnnouncementInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;
            if (value.audience === 'branch' && !(await branchInTenant(scope.tenantId, value.branchId as string))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            const id = randomUUID();
            const publishedAt = value.publishAt ? toMysqlUtc(value.publishAt) : null;
            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO announcements
                       (id,tenant_id,branch_id,title,body,audience,status,created_by,published_at)
                     VALUES (?,?,?,?,?,?, 'published', ?, COALESCE(?, UTC_TIMESTAMP()))`,
                    [id, scope.tenantId, value.branchId, value.title, value.body, value.audience, scope.userId, publishedAt],
                );
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'announcement.create',
                    resourceType: 'announcement',
                    resourceId: id,
                    newValue: {
                        title: value.title,
                        audience: value.audience,
                        branch_id: value.branchId,
                        publish_at: publishedAt,
                    },
                });
            });
            res.status(201).json({
                id,
                tenant_id: scope.tenantId,
                audience: value.audience,
                branch_id: value.branchId,
                status: 'published',
                publish_at: publishedAt,
            });
        } catch (error) {
            console.error('Create announcement error:', error);
            res.status(500).json({ error: 'Failed to create announcement' });
        }
    });

    router.patch('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Announcement not found' });
            const existing = await db.queryOne<AnnouncementRow>(
                `SELECT id,tenant_id,branch_id,title,body,audience,status,published_at,version
                 FROM announcements WHERE id=? AND tenant_id=? LIMIT 1`,
                [id, scope.tenantId],
            );
            if (!existing) return res.status(404).json({ error: 'Announcement not found' });
            if (existing.status === 'retracted') {
                return res.status(409).json({ error: 'A retracted announcement cannot be edited' });
            }
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            const merged = {
                title: body['title'] ?? existing.title,
                body: body['body'] ?? existing.body,
                audience: body['audience'] ?? existing.audience,
                branch_id: body['branch_id'] ?? existing.branch_id,
            };
            const validated = validateAnnouncementInput(merged);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;
            if (value.audience === 'branch' && !(await branchInTenant(scope.tenantId, value.branchId as string))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE announcements
                     SET title=?, body=?, audience=?, branch_id=?, version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND version=?`,
                    [value.title, value.body, value.audience, value.branchId, id, scope.tenantId, existing.version],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'announcement.update',
                    resourceType: 'announcement',
                    resourceId: id,
                    oldValue: snapshotRow(existing),
                    newValue: {
                        title: value.title,
                        audience: value.audience,
                        branch_id: value.branchId,
                    },
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Announcement changed concurrently' });
            res.json({ id, audience: value.audience, branch_id: value.branchId, status: existing.status });
        } catch (error) {
            console.error('Update announcement error:', error);
            res.status(500).json({ error: 'Failed to update announcement' });
        }
    });

    router.post('/:id/retract', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Announcement not found' });
            const existing = await db.queryOne<AnnouncementRow>(
                `SELECT id,tenant_id,branch_id,title,audience,status,published_at,version
                 FROM announcements WHERE id=? AND tenant_id=? LIMIT 1`,
                [id, scope.tenantId],
            );
            if (!existing) return res.status(404).json({ error: 'Announcement not found' });
            if (existing.status === 'retracted') {
                return res.status(409).json({ error: 'Announcement is already retracted' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE announcements
                     SET status='retracted', retracted_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND status='published'`,
                    [id, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'announcement.retract',
                    resourceType: 'announcement',
                    resourceId: id,
                    oldValue: snapshotRow(existing),
                    newValue: { status: 'retracted' },
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Announcement changed concurrently' });
            res.json({ id, status: 'retracted' });
        } catch (error) {
            console.error('Retract announcement error:', error);
            res.status(500).json({ error: 'Failed to retract announcement' });
        }
    });

    // -----------------------------------------------------------------------
    // Schedules
    // -----------------------------------------------------------------------
    router.get('/schedules', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            res.json(await db.query(
                `SELECT id,title,audience,branch_id,group_id,timezone,starts_at,ends_at,status,created_at
                 FROM schedules WHERE tenant_id=? ORDER BY starts_at DESC LIMIT 200`,
                [scope.tenantId],
            ));
        } catch (error) {
            console.error('List schedules error:', error);
            res.status(500).json({ error: 'Failed to list schedules' });
        }
    });

    router.post('/schedules', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const validated = validateScheduleInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;
            if (value.audience === 'branch' && !(await branchInTenant(scope.tenantId, value.branchId as string))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            if (value.audience === 'group' && !(await groupInTenant(scope.tenantId, value.groupId as string))) {
                return res.status(403).json({ error: 'Group is outside this tenant' });
            }
            const id = randomUUID();
            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO schedules
                       (id,tenant_id,branch_id,group_id,title,audience,timezone,starts_at,ends_at,status,created_by)
                     VALUES (?,?,?,?,?,?,?,?,?, 'scheduled', ?)`,
                    [
                        id, scope.tenantId, value.branchId, value.groupId, value.title,
                        value.audience, value.timezone, toMysqlUtc(value.startsAt), toMysqlUtc(value.endsAt), scope.userId,
                    ],
                );
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'schedule.create',
                    resourceType: 'schedule',
                    resourceId: id,
                    newValue: {
                        title: value.title,
                        audience: value.audience,
                        branch_id: value.branchId,
                        group_id: value.groupId,
                        timezone: value.timezone,
                        starts_at: toMysqlUtc(value.startsAt),
                        ends_at: toMysqlUtc(value.endsAt),
                    },
                });
            });
            res.status(201).json({ id, status: 'scheduled', audience: value.audience, timezone: value.timezone });
        } catch (error) {
            console.error('Create schedule error:', error);
            res.status(500).json({ error: 'Failed to create schedule' });
        }
    });

    router.patch('/schedules/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Schedule not found' });
            const existing = await db.queryOne<ScheduleRow>(
                `SELECT id,tenant_id,branch_id,group_id,title,audience,timezone,starts_at,ends_at,status,version
                 FROM schedules WHERE id=? AND tenant_id=? LIMIT 1`,
                [id, scope.tenantId],
            );
            if (!existing) return res.status(404).json({ error: 'Schedule not found' });
            if (existing.status === 'cancelled') {
                return res.status(409).json({ error: 'A cancelled schedule cannot be edited' });
            }
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            const merged = {
                title: body['title'] ?? existing.title,
                audience: body['audience'] ?? existing.audience,
                branch_id: body['branch_id'] ?? existing.branch_id,
                group_id: body['group_id'] ?? existing.group_id,
                timezone: body['timezone'] ?? existing.timezone,
                starts_at: body['starts_at'] ?? existing.starts_at,
                ends_at: body['ends_at'] ?? existing.ends_at,
            };
            const validated = validateScheduleInput(merged);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;
            if (value.audience === 'branch' && !(await branchInTenant(scope.tenantId, value.branchId as string))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            if (value.audience === 'group' && !(await groupInTenant(scope.tenantId, value.groupId as string))) {
                return res.status(403).json({ error: 'Group is outside this tenant' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE schedules
                     SET title=?, audience=?, branch_id=?, group_id=?, timezone=?, starts_at=?, ends_at=?,
                         version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND version=?`,
                    [
                        value.title, value.audience, value.branchId, value.groupId, value.timezone,
                        toMysqlUtc(value.startsAt), toMysqlUtc(value.endsAt), id, scope.tenantId, existing.version,
                    ],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'schedule.update',
                    resourceType: 'schedule',
                    resourceId: id,
                    oldValue: snapshotRow(existing),
                    newValue: {
                        title: value.title,
                        audience: value.audience,
                        branch_id: value.branchId,
                        group_id: value.groupId,
                        starts_at: toMysqlUtc(value.startsAt),
                        ends_at: toMysqlUtc(value.endsAt),
                    },
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Schedule changed concurrently' });
            res.json({ id, status: existing.status, audience: value.audience });
        } catch (error) {
            console.error('Update schedule error:', error);
            res.status(500).json({ error: 'Failed to update schedule' });
        }
    });

    router.post('/schedules/:id/cancel', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Schedule not found' });
            const existing = await db.queryOne<ScheduleRow>(
                `SELECT id,tenant_id,title,audience,status,starts_at,version
                 FROM schedules WHERE id=? AND tenant_id=? LIMIT 1`,
                [id, scope.tenantId],
            );
            if (!existing) return res.status(404).json({ error: 'Schedule not found' });
            if (existing.status === 'cancelled') {
                return res.status(409).json({ error: 'Schedule is already cancelled' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE schedules
                     SET status='cancelled', cancelled_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND status='scheduled'`,
                    [id, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'schedule.cancel',
                    resourceType: 'schedule',
                    resourceId: id,
                    oldValue: snapshotRow(existing),
                    newValue: { status: 'cancelled' },
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Schedule changed concurrently' });
            res.json({ id, status: 'cancelled' });
        } catch (error) {
            console.error('Cancel schedule error:', error);
            res.status(500).json({ error: 'Failed to cancel schedule' });
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
            const filter = buildVisibleAnnouncementFilter(resolved.viewer);
            const rows = await db.query(
                `SELECT id,title,body,audience,branch_id,published_at
                 FROM announcements
                 WHERE tenant_id=? AND status='published' AND ${filter.sql}
                 ORDER BY published_at DESC LIMIT 100`,
                [resolved.tenantId, ...filter.params],
            );
            res.json(rows);
        } catch (error) {
            console.error('Student announcements error:', error);
            res.status(500).json({ error: 'Failed to load announcements' });
        }
    });

    router.get('/schedules/student', async (req: AuthRequest, res: Response) => {
        try {
            const resolved = await resolveStudentViewer(req, res);
            if (!resolved) return;
            const filter = buildVisibleScheduleFilter(resolved.viewer);
            const rows = await db.query(
                `SELECT id,title,audience,branch_id,group_id,timezone,starts_at,ends_at,status
                 FROM schedules
                 WHERE tenant_id=? AND status='scheduled' AND ${filter.sql}
                 ORDER BY starts_at ASC LIMIT 100`,
                [resolved.tenantId, ...filter.params],
            );
            res.json(rows);
        } catch (error) {
            console.error('Student schedules error:', error);
            res.status(500).json({ error: 'Failed to load schedules' });
        }
    });

    return router;
};
