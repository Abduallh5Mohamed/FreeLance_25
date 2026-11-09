"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPlatformFlagsRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const admin_permissions_1 = require("../security/admin-permissions");
const sensitive_action_mfa_production_1 = require("../security/sensitive-action-mfa-production");
const async_route_boundary_1 = require("../security/async-route-boundary");
const feature_flags_1 = require("../services/feature-flags");
const audit_log_1 = require("../services/audit-log");
const asTargeting = (result, res) => {
    if (result.ok)
        return result.value;
    res.status(400).json({ error: result.error });
    return null;
};
const createPlatformFlagsRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    const runAtomic = deps.transaction
        ? deps.transaction
        : (fn) => fn(db);
    const writeAudit = deps.recordAudit;
    const readGuard = deps.requirePlatformPermission('platform_flags.read');
    const manageGuard = deps.requirePlatformPermission('platform_flags.manage');
    const sensitiveAction = deps.sensitiveAction
        ? (0, async_route_boundary_1.asyncRouteBoundary)(deps.sensitiveAction)
        : (_req, _res, next) => next();
    router.use(deps.authenticate);
    const loadFlagById = (id) => db.queryOne('SELECT id, flag_key, description, is_archived, active_version_id FROM feature_flags WHERE id=? LIMIT 1', [id]);
    /**
     * Optimistic active-pointer move: matched against the pointer read just
     * before, so a concurrent publish/rollback is a 409 instead of a silent
     * overwrite.
     */
    const moveActivePointer = async (tx, flagId, nextVersionId, previousActive) => {
        const sql = previousActive === null
            ? 'UPDATE feature_flags SET active_version_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND active_version_id IS NULL'
            : 'UPDATE feature_flags SET active_version_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND active_version_id=?';
        return tx.execute(sql, previousActive === null ? [nextVersionId, flagId] : [nextVersionId, flagId, previousActive]);
    };
    // ---------------------------------------------------------------------
    // Registry read
    // ---------------------------------------------------------------------
    router.get('/', readGuard, async (_req, res) => {
        try {
            const rows = await db.query(`SELECT f.id, f.flag_key, f.description, f.is_archived, f.created_at,
                        v.version_no, v.targeting_mode, v.plan_id, v.percentage,
                        v.tenant_ids, v.enabled
                 FROM feature_flags f
                 LEFT JOIN feature_flag_versions v ON v.id = f.active_version_id
                 ORDER BY f.flag_key ASC
                 LIMIT 500`);
            res.json(rows);
        }
        catch (error) {
            console.error('List feature flags error:', error);
            res.status(500).json({ error: 'Failed to list feature flags' });
        }
    });
    // ---------------------------------------------------------------------
    // Create a flag (starts with no active version => enforced false)
    // ---------------------------------------------------------------------
    router.post('/', manageGuard, sensitiveAction, async (req, res) => {
        try {
            const user = req.user;
            if (!user)
                return res.status(401).json({ error: 'Authentication required' });
            const validated = (0, feature_flags_1.validateFlagCreateInput)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const { flagKey, description } = validated.value;
            const existing = await db.queryOne('SELECT id FROM feature_flags WHERE flag_key=? LIMIT 1', [flagKey]);
            if (existing)
                return res.status(409).json({ error: 'A flag with this key already exists' });
            const id = (0, crypto_1.randomUUID)();
            await runAtomic(async (tx) => {
                await tx.execute(`INSERT INTO feature_flags (id, flag_key, description, created_by)
                     VALUES (?, ?, ?, ?)`, [id, flagKey, description, user.id]);
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
        }
        catch (error) {
            console.error('Create feature flag error:', error);
            res.status(500).json({ error: 'Failed to create feature flag' });
        }
    });
    // ---------------------------------------------------------------------
    // Publish a new targeting version
    // ---------------------------------------------------------------------
    router.post('/:id/versions', manageGuard, sensitiveAction, async (req, res) => {
        try {
            const user = req.user;
            if (!user)
                return res.status(401).json({ error: 'Authentication required' });
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag)
                return res.status(404).json({ error: 'Feature flag not found' });
            if (Number(flag.is_archived) === 1) {
                return res.status(409).json({ error: 'An archived flag cannot be retargeted' });
            }
            const spec = asTargeting((0, feature_flags_1.validateTargetingInput)(req.body), res);
            if (!spec)
                return;
            const reason = (0, feature_flags_1.validateAuditReason)(req.body?.reason);
            if (!reason.ok)
                return res.status(400).json({ error: reason.error });
            if (spec.mode === 'plan') {
                const plan = await db.queryOne('SELECT id FROM platform_plans WHERE id=? AND is_active=1 LIMIT 1', [spec.planId]);
                if (!plan)
                    return res.status(400).json({ error: 'Unknown or inactive plan_id' });
            }
            if (spec.mode === 'tenant_list') {
                const placeholders = spec.tenantIds.map(() => '?').join(',');
                const countRows = await db.query(`SELECT COUNT(*) AS found FROM tenants WHERE id IN (${placeholders})`, spec.tenantIds);
                if (Number(countRows[0]?.found ?? 0) !== spec.tenantIds.length) {
                    return res.status(400).json({ error: 'tenant_ids contains an unknown tenant' });
                }
            }
            const versionId = (0, crypto_1.randomUUID)();
            const result = await runAtomic(async (tx) => {
                const maxRows = await tx.query(`SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
                     FROM feature_flag_versions WHERE flag_id = ?`, [flag.id]);
                const versionNo = Number(maxRows[0]?.next_no ?? 1);
                await tx.execute(`INSERT INTO feature_flag_versions
                     (id, flag_id, version_no, targeting_mode, plan_id, percentage, tenant_ids, enabled, created_by, reason)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    versionId, flag.id, versionNo, spec.mode, spec.planId, spec.percentage,
                    spec.tenantIds.length ? JSON.stringify(spec.tenantIds) : null,
                    spec.enabled ? 1 : 0, user.id, reason.value,
                ]);
                const previousActive = flag.active_version_id;
                const updated = await moveActivePointer(tx, flag.id, versionId, previousActive);
                if ((updated.affectedRows ?? 0) === 0)
                    return null;
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
        }
        catch (error) {
            console.error('Publish feature flag version error:', error);
            res.status(500).json({ error: 'Failed to publish feature flag version' });
        }
    });
    // ---------------------------------------------------------------------
    // Rollback the active pointer to an existing version
    // ---------------------------------------------------------------------
    router.post('/:id/rollback', manageGuard, sensitiveAction, async (req, res) => {
        try {
            const user = req.user;
            if (!user)
                return res.status(401).json({ error: 'Authentication required' });
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag)
                return res.status(404).json({ error: 'Feature flag not found' });
            if (Number(flag.is_archived) === 1) {
                return res.status(409).json({ error: 'An archived flag cannot be rolled back' });
            }
            const target = (0, feature_flags_1.validateRollbackInput)(req.body);
            if (!target.ok)
                return res.status(400).json({ error: target.error });
            const reason = (0, feature_flags_1.validateAuditReason)(req.body?.reason);
            if (!reason.ok)
                return res.status(400).json({ error: reason.error });
            const targetRows = await db.query(`SELECT id, version_no, targeting_mode, plan_id, percentage, tenant_ids, enabled, created_at, reason
                 FROM feature_flag_versions WHERE flag_id = ? AND version_no = ? LIMIT 1`, [flag.id, target.value.versionNo]);
            const targetVersion = targetRows[0];
            if (!targetVersion)
                return res.status(404).json({ error: 'Target version not found' });
            if (targetVersion.id === flag.active_version_id) {
                return res.status(409).json({ error: 'Target version is already active' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await moveActivePointer(tx, flag.id, targetVersion.id, flag.active_version_id);
                if ((updated.affectedRows ?? 0) === 0)
                    return false;
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
        }
        catch (error) {
            console.error('Rollback feature flag error:', error);
            res.status(500).json({ error: 'Failed to roll back feature flag' });
        }
    });
    // ---------------------------------------------------------------------
    // Archive a flag (enforcement resolves false for archived flags)
    // ---------------------------------------------------------------------
    router.post('/:id/archive', manageGuard, sensitiveAction, async (req, res) => {
        try {
            const user = req.user;
            if (!user)
                return res.status(401).json({ error: 'Authentication required' });
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag)
                return res.status(404).json({ error: 'Feature flag not found' });
            if (Number(flag.is_archived) === 1) {
                return res.status(409).json({ error: 'Feature flag is already archived' });
            }
            const reason = (0, feature_flags_1.validateAuditReason)(req.body?.reason);
            if (!reason.ok)
                return res.status(400).json({ error: reason.error });
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute('UPDATE feature_flags SET is_archived=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND is_archived=0', [flag.id]);
                if ((updated.affectedRows ?? 0) === 0)
                    return false;
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
        }
        catch (error) {
            console.error('Archive feature flag error:', error);
            res.status(500).json({ error: 'Failed to archive feature flag' });
        }
    });
    // ---------------------------------------------------------------------
    // Version history
    // ---------------------------------------------------------------------
    router.get('/:id/versions', readGuard, async (req, res) => {
        try {
            const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
            const flag = id ? await loadFlagById(id) : null;
            if (!flag)
                return res.status(404).json({ error: 'Feature flag not found' });
            const rows = await db.query(`SELECT id, version_no, targeting_mode, plan_id, percentage, tenant_ids, enabled, created_at, reason
                 FROM feature_flag_versions WHERE flag_id = ?
                 ORDER BY version_no DESC LIMIT 100`, [flag.id]);
            res.json(rows);
        }
        catch (error) {
            console.error('List feature flag versions error:', error);
            res.status(500).json({ error: 'Failed to list feature flag versions' });
        }
    });
    // ---------------------------------------------------------------------
    // Preview affected tenants for a would-be version (no write)
    // ---------------------------------------------------------------------
    router.post('/preview', readGuard, async (req, res) => {
        try {
            const spec = asTargeting((0, feature_flags_1.validateTargetingInput)(req.body), res);
            if (!spec)
                return;
            const flagKey = typeof req.body?.flag_key === 'string' ? req.body.flag_key.trim().toLowerCase() : '';
            const preview = await (0, feature_flags_1.previewTargetedTenants)(db, spec, {
                flagKey: flagKey || 'preview',
                sampleLimit: 100,
            });
            res.json({
                targeting_mode: spec.mode,
                total: preview.total,
                sample: preview.sample,
            });
        }
        catch (error) {
            console.error('Preview feature flag targeting error:', error);
            res.status(500).json({ error: 'Failed to preview feature flag targeting' });
        }
    });
    // ---------------------------------------------------------------------
    // Server-side enforcement surface (admin visibility of the same helper
    // other modules call): GET /effective/:flagKey?tenant_id=...
    // ---------------------------------------------------------------------
    router.get('/effective/:flagKey', readGuard, async (req, res) => {
        try {
            const flagKey = typeof req.params.flagKey === 'string' ? req.params.flagKey.trim().toLowerCase() : '';
            const tenantId = typeof req.query.tenant_id === 'string' ? req.query.tenant_id.trim() : '';
            if (!flagKey || !tenantId)
                return res.status(400).json({ error: 'tenant_id is required' });
            const enabled = await (0, feature_flags_1.evaluateRequiredFeature)(db, tenantId, flagKey);
            res.json({ flag_key: flagKey, tenant_id: tenantId, enabled });
        }
        catch (error) {
            console.error('Evaluate feature flag error:', error);
            res.status(500).json({ error: 'Failed to evaluate feature flag' });
        }
    });
    return router;
};
exports.createPlatformFlagsRouter = createPlatformFlagsRouter;
/* Production wiring: real pool, real auth, real platform-capability guard,
   real sealed audit writer. */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    const { query, queryOne, execute } = dbModule;
    return {
        query: (sql, params) => query(sql, params),
        queryOne: (sql, params) => queryOne(sql, params),
        execute: (sql, params) => execute(sql, params),
    };
};
const productionDb = {
    query: async (sql, params) => {
        const { query } = await loadDb();
        return query(sql, params);
    },
    queryOne: async (sql, params) => {
        const { queryOne } = await loadDb();
        return queryOne(sql, params);
    },
    execute: async (sql, params) => {
        const { execute } = await loadDb();
        return execute(sql, params);
    },
};
exports.default = (0, exports.createPlatformFlagsRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => (0, admin_permissions_1.requireAdminPermission)(permission),
    sensitiveAction: process.env.AUTH_LOGIN_SESSIONS_ENABLED === 'true'
        ? (0, sensitive_action_mfa_production_1.createProductionSensitiveActionMfa)({ permission: 'platform_flags.manage' })
        : undefined,
    recordAudit: async (dataAccess, input) => (0, audit_log_1.recordSealedAuditEvent)(dataAccess, input),
});
