/**
 * M7 O2 — platform feature-flag editor routes.
 *
 * Audience + permission model:
 *  - Every path requires authentication and a verified platform permission
 *    (`platform_flags.read` for reads/preview, `platform_flags.manage` for
 *    create/publish/rollback/archive). A JWT role claim alone never grants
 *    access; the guard resolves server-owned admin rows only.
 *  - Every mutation publishes an immutable version, requires an audit reason
 *    and is audited (actor, reason, before/after) in the same transaction, so
 *    a failed audit aborts the write.
 *  - Targeting plan ids and tenant-list ids are validated against server rows
 *    before a version may be published; unknown references are rejected.
 *  - Enforcement for other modules is the service helper
 *    `isRequiredFeatureEnabled(tenantId, flagKey)` (deny-by-default).
 *
 * This module exports `createPlatformFlagsRouter(deps)` and a production
 * default-wired router instance at the bottom.
 */

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { requireAdminPermission } from '../security/admin-permissions';
import { createProductionSensitiveActionMfa } from '../security/sensitive-action-mfa-production';
import { asyncRouteBoundary } from '../security/async-route-boundary';
import {
    FeatureFlagsDataAccess,
    TargetingSpec,
    ValidateResult,
    evaluateRequiredFeature,
    previewTargetedTenants,
    validateAuditReason,
    validateFlagCreateInput,
    validateRollbackInput,
    validateTargetingInput,
} from '../services/feature-flags';
import { SealedAuditRecordInput, recordSealedAuditEvent } from '../services/audit-log';

export interface PlatformFlagsDeps {
    sensitiveAction?: RequestHandler;
    db: FeatureFlagsDataAccess;
    authenticate: RequestHandler;
    /** Verified platform permission guard (server-owned rows only). */
    requirePlatformPermission: (permission: string) => RequestHandler;
    /** Sealed audit writer; runs with the transaction data access. */
    recordAudit: (tx: FeatureFlagsDataAccess, input: SealedAuditRecordInput) => Promise<void>;
    /** Optional atomic seam; production supplies a pooled transaction. */
    transaction?: <T>(fn: (tx: FeatureFlagsDataAccess) => Promise<T>) => Promise<T>;
}

interface FlagRow {
    id: string;
    flag_key: string;
    description: string | null;
    is_archived: number | boolean;
    active_version_id: string | null;
}

interface VersionSummary {
    id: string;
    version_no: number;
    targeting_mode: string;
    plan_id: string | null;
    percentage: number | null;
    tenant_ids: unknown;
    enabled: number | boolean;
    created_at: string | Date;
    reason: string | null;
}

const asTargeting = (result: ValidateResult<TargetingSpec>, res: Response): TargetingSpec | null => {
    if (result.ok) return result.value;
    res.status(400).json({ error: result.error });
    return null;
};

export const createPlatformFlagsRouter = (deps: PlatformFlagsDeps): Router => {
    const router = Router();
    const { db } = deps;
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: FeatureFlagsDataAccess) => Promise<T>): Promise<T> => fn(db);
    const writeAudit = deps.recordAudit;
    const readGuard = deps.requirePlatformPermission('platform_flags.read');
    const manageGuard = deps.requirePlatformPermission('platform_flags.manage');
    const sensitiveAction: RequestHandler = deps.sensitiveAction
        ? asyncRouteBoundary(deps.sensitiveAction)
        : (_req, _res, next) => next();
    router.use(deps.authenticate);

    const loadFlagById = (id: string) =>
        db.queryOne<FlagRow>(
            'SELECT id, flag_key, description, is_archived, active_version_id FROM feature_flags WHERE id=? LIMIT 1',
            [id],
        );

    /**
     * Optimistic active-pointer move: matched against the pointer read just
     * before, so a concurrent publish/rollback is a 409 instead of a silent
     * overwrite.
     */
    const moveActivePointer = async (
        tx: FeatureFlagsDataAccess,
        flagId: string,
        nextVersionId: string,
        previousActive: string | null,
    ) => {
        const sql = previousActive === null
            ? 'UPDATE feature_flags SET active_version_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND active_version_id IS NULL'
            : 'UPDATE feature_flags SET active_version_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND active_version_id=?';
        return tx.execute(
            sql,
            previousActive === null ? [nextVersionId, flagId] : [nextVersionId, flagId, previousActive],
        );
    };

    // ---------------------------------------------------------------------
    // Registry read
    // ---------------------------------------------------------------------
    router.get('/', readGuard, async (_req: AuthRequest, res: Response) => {
        try {
            const rows = await db.query(
                `SELECT f.id, f.flag_key, f.description, f.is_archived, f.created_at,
                        v.version_no, v.targeting_mode, v.plan_id, v.percentage,
                        v.tenant_ids, v.enabled
                 FROM feature_flags f
                 LEFT JOIN feature_flag_versions v ON v.id = f.active_version_id
                 ORDER BY f.flag_key ASC
                 LIMIT 500`,
            );
            res.json(rows);
        } catch (error) {
            console.error('List feature flags error:', error);
            res.status(500).json({ error: 'Failed to list feature flags' });
        }
    });

    // ---------------------------------------------------------------------
    // Create a flag (starts with no active version => enforced false)
    // ---------------------------------------------------------------------
    router.post('/', manageGuard, sensitiveAction, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const validated = validateFlagCreateInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const { flagKey, description } = validated.value;
            const existing = await db.queryOne<{ id: string }>(
                'SELECT id FROM feature_flags WHERE flag_key=? LIMIT 1',
                [flagKey],
            );
            if (existing) return res.status(409).json({ error: 'A flag with this key already exists' });
            const id = randomUUID();
            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO feature_flags (id, flag_key, description, created_by)
                     VALUES (?, ?, ?, ?)`,
                    [id, flagKey, description, user.id],
                );
                await writeAudit(tx, {
                    actorUserId: user.id,
                    tenantId: null,
                    action: 'platform_flag.created',
                    resourceType: 'feature_flag',
                    resourceId: id,
                    newValue: { flag_key: flagKey, description },
                    reason: 'Created platform feature flag',
                });
            });
            res.status(201).json({ id, flag_key: flagKey, active_version_id: null });
        } catch (error) {
            console.error('Create feature flag error:', error);
            res.status(500).json({ error: 'Failed to create feature flag' });
        }
    });

    // ---------------------------------------------------------------------
    // Publish a new targeting version
    // ---------------------------------------------------------------------
    router.post('/:id/versions', manageGuard, sensitiveAction, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag) return res.status(404).json({ error: 'Feature flag not found' });
            if (Number(flag.is_archived) === 1) {
                return res.status(409).json({ error: 'An archived flag cannot be retargeted' });
            }
            const spec = asTargeting(validateTargetingInput(req.body), res);
            if (!spec) return;
            const reason = validateAuditReason(req.body?.reason);
            if (!reason.ok) return res.status(400).json({ error: reason.error });
            if (spec.mode === 'plan') {
                const plan = await db.queryOne<{ id: string }>(
                    'SELECT id FROM platform_plans WHERE id=? AND is_active=1 LIMIT 1',
                    [spec.planId],
                );
                if (!plan) return res.status(400).json({ error: 'Unknown or inactive plan_id' });
            }
            if (spec.mode === 'tenant_list') {
                const placeholders = spec.tenantIds.map(() => '?').join(',');
                const countRows = await db.query<{ found: number }>(
                    `SELECT COUNT(*) AS found FROM tenants WHERE id IN (${placeholders})`,
                    spec.tenantIds,
                );
                if (Number(countRows[0]?.found ?? 0) !== spec.tenantIds.length) {
                    return res.status(400).json({ error: 'tenant_ids contains an unknown tenant' });
                }
            }
            const versionId = randomUUID();
            const result = await runAtomic(async (tx) => {
                const maxRows = await tx.query<{ next_no: number }>(
                    `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
                     FROM feature_flag_versions WHERE flag_id = ?`,
                    [flag.id],
                );
                const versionNo = Number(maxRows[0]?.next_no ?? 1);
                await tx.execute(
                    `INSERT INTO feature_flag_versions
                     (id, flag_id, version_no, targeting_mode, plan_id, percentage, tenant_ids, enabled, created_by, reason)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        versionId, flag.id, versionNo, spec.mode, spec.planId, spec.percentage,
                        spec.tenantIds.length ? JSON.stringify(spec.tenantIds) : null,
                        spec.enabled ? 1 : 0, user.id, reason.value,
                    ],
                );
                const previousActive = flag.active_version_id;
                const updated = await moveActivePointer(tx, flag.id, versionId, previousActive);
                if ((updated.affectedRows ?? 0) === 0) return null;
                await writeAudit(tx, {
                    actorUserId: user.id,
                    tenantId: null,
                    action: 'platform_flag.version_published',
                    resourceType: 'feature_flag',
                    resourceId: flag.id,
                    oldValue: previousActive ? { active_version_id: previousActive } : null,
                    newValue: {
                        version_id: versionId,
                        version_no: versionNo,
                        targeting_mode: spec.mode,
                        plan_id: spec.planId,
                        percentage: spec.percentage,
                        tenant_ids: spec.tenantIds.length,
                        enabled: spec.enabled,
                    },
                    reason: reason.value,
                });
                return { versionId, versionNo };
            });
            if (!result) {
                return res.status(409).json({ error: 'Feature flag changed concurrently' });
            }
            res.status(201).json({ id: result.versionId, version_no: result.versionNo, flag_id: flag.id });
        } catch (error) {
            console.error('Publish feature flag version error:', error);
            res.status(500).json({ error: 'Failed to publish feature flag version' });
        }
    });

    // ---------------------------------------------------------------------
    // Rollback the active pointer to an existing version
    // ---------------------------------------------------------------------
    router.post('/:id/rollback', manageGuard, sensitiveAction, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag) return res.status(404).json({ error: 'Feature flag not found' });
            if (Number(flag.is_archived) === 1) {
                return res.status(409).json({ error: 'An archived flag cannot be rolled back' });
            }
            const target = validateRollbackInput(req.body);
            if (!target.ok) return res.status(400).json({ error: target.error });
            const reason = validateAuditReason(req.body?.reason);
            if (!reason.ok) return res.status(400).json({ error: reason.error });
            const targetRows = await db.query<VersionSummary>(
                `SELECT id, version_no, targeting_mode, plan_id, percentage, tenant_ids, enabled, created_at, reason
                 FROM feature_flag_versions WHERE flag_id = ? AND version_no = ? LIMIT 1`,
                [flag.id, target.value.versionNo],
            );
            const targetVersion = targetRows[0];
            if (!targetVersion) return res.status(404).json({ error: 'Target version not found' });
            if (targetVersion.id === flag.active_version_id) {
                return res.status(409).json({ error: 'Target version is already active' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await moveActivePointer(tx, flag.id, targetVersion.id, flag.active_version_id);
                if ((updated.affectedRows ?? 0) === 0) return false;
                await writeAudit(tx, {
                    actorUserId: user.id,
                    tenantId: null,
                    action: 'platform_flag.rolled_back',
                    resourceType: 'feature_flag',
                    resourceId: flag.id,
                    oldValue: flag.active_version_id ? { active_version_id: flag.active_version_id } : null,
                    newValue: { active_version_id: targetVersion.id, version_no: targetVersion.version_no },
                    reason: reason.value,
                });
                return true;
            });
            if (!result) {
                return res.status(409).json({ error: 'Feature flag changed concurrently' });
            }
            res.json({ id: flag.id, active_version_id: targetVersion.id, version_no: targetVersion.version_no });
        } catch (error) {
            console.error('Rollback feature flag error:', error);
            res.status(500).json({ error: 'Failed to roll back feature flag' });
        }
    });

    // ---------------------------------------------------------------------
    // Archive a flag (enforcement resolves false for archived flags)
    // ---------------------------------------------------------------------
    router.post('/:id/archive', manageGuard, sensitiveAction, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag) return res.status(404).json({ error: 'Feature flag not found' });
            if (Number(flag.is_archived) === 1) {
                return res.status(409).json({ error: 'Feature flag is already archived' });
            }
            const reason = validateAuditReason(req.body?.reason);
            if (!reason.ok) return res.status(400).json({ error: reason.error });
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    'UPDATE feature_flags SET is_archived=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND is_archived=0',
                    [flag.id],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await writeAudit(tx, {
                    actorUserId: user.id,
                    tenantId: null,
                    action: 'platform_flag.archived',
                    resourceType: 'feature_flag',
                    resourceId: flag.id,
                    oldValue: { is_archived: 0 },
                    newValue: { is_archived: 1 },
                    reason: reason.value,
                });
                return true;
            });
            if (!result) {
                return res.status(409).json({ error: 'Feature flag changed concurrently' });
            }
            res.json({ id: flag.id, is_archived: 1 });
        } catch (error) {
            console.error('Archive feature flag error:', error);
            res.status(500).json({ error: 'Failed to archive feature flag' });
        }
    });

    // ---------------------------------------------------------------------
    // Version history
    // ---------------------------------------------------------------------
    router.get('/:id/versions', readGuard, async (req: AuthRequest, res: Response) => {
        try {
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag) return res.status(404).json({ error: 'Feature flag not found' });
            const rows = await db.query<VersionSummary>(
                `SELECT id, version_no, targeting_mode, plan_id, percentage, tenant_ids, enabled, created_at, reason
                 FROM feature_flag_versions WHERE flag_id = ?
                 ORDER BY version_no DESC LIMIT 100`,
                [flag.id],
            );
            res.json(rows);
        } catch (error) {
            console.error('List feature flag versions error:', error);
            res.status(500).json({ error: 'Failed to list feature flag versions' });
        }
    });

    // ---------------------------------------------------------------------
    // Preview affected tenants for a would-be version (no write)
    // ---------------------------------------------------------------------
    router.post('/preview', readGuard, async (req: AuthRequest, res: Response) => {
        try {
            const spec = asTargeting(validateTargetingInput(req.body), res);
            if (!spec) return;
            const flagKey = typeof req.body?.flag_key === 'string' ? req.body.flag_key.trim().toLowerCase() : '';
            const preview = await previewTargetedTenants(db, spec, {
                flagKey: flagKey || 'preview',
                sampleLimit: 100,
            });
            res.json({
                targeting_mode: spec.mode,
                total: preview.total,
                sample: preview.sample,
            });
        } catch (error) {
            console.error('Preview feature flag targeting error:', error);
            res.status(500).json({ error: 'Failed to preview feature flag targeting' });
        }
    });

    // ---------------------------------------------------------------------
    // Server-side enforcement surface (admin visibility of the same helper
    // other modules call): GET /effective/:flagKey?tenant_id=...
    // ---------------------------------------------------------------------
    router.get('/effective/:flagKey', readGuard, async (req: AuthRequest, res: Response) => {
        try {
            const flagKey = typeof req.params.flagKey === 'string' ? req.params.flagKey.trim().toLowerCase() : '';
            const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id.trim() : '';
            if (!flagKey || !tenantId) return res.status(400).json({ error: 'tenant_id is required' });
            const enabled = await evaluateRequiredFeature(db, tenantId, flagKey);
            res.json({ flag_key: flagKey, tenant_id: tenantId, enabled });
        } catch (error) {
            console.error('Evaluate feature flag error:', error);
            res.status(500).json({ error: 'Failed to evaluate feature flag' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real platform-capability guard,
   real sealed audit writer. */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<FeatureFlagsDataAccess> => {
    dbModule ??= await import('../db');
    const { query, queryOne, execute } = dbModule;
    return {
        query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            query<T>(sql, params as never) as Promise<T[]>,
        queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            queryOne<T>(sql, params as never) as Promise<T | null>,
        execute: (sql: string, params?: unknown[]) => execute(sql, params as never),
    };
};

const productionDb: FeatureFlagsDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never) as Promise<T[]>;
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never) as Promise<T | null>;
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

export default createPlatformFlagsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => requireAdminPermission(permission),
    sensitiveAction: process.env.AUTH_LOGIN_SESSIONS_ENABLED === 'true'
        ? createProductionSensitiveActionMfa({ permission: 'platform_flags.manage' })
        : undefined,
    recordAudit: async (dataAccess, input) => recordSealedAuditEvent(dataAccess, input),
});
