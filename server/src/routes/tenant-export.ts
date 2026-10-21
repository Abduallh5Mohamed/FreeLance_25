/**
 * M8 Q6 — per-tenant data export routes.
 *
 * Audience + permission model (deny by default):
 *  - Every path requires authentication.
 *  - An export is started only by the verified tenant OWNER of the
 *    server-derived tenant, or by a verified platform actor holding the
 *    `tenant_export.request` permission (server-owned rows only; a JWT role
 *    claim is never evidence). A platform actor must name the target tenant;
 *    an owner is pinned to their own tenant and can never export another
 *    tenant's data.
 *  - The whole surface fails closed with 503 unless TENANT_EXPORT_SECRET
 *    holds at least 32 bytes (enforced in the service; every denial is
 *    audited).
 *  - One active export per tenant plus a post-completion cooldown (service
 *    level, backed by the database UNIQUE key on the generated
 *    active_tenant_lock column).
 *  - Downloads require the signed, expiring HMAC token bound to the export
 *    id AND the tenant id; the authenticated caller must additionally be
 *    the tenant owner or hold the platform permission. Every request,
 *    completion, failure, token issuance and download is audited.
 *  - Export bytes are written only through the injected storage interface.
 *
 * This module exports `createTenantExportRouter(deps)`; it is intentionally
 * not mounted anywhere by this task. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { AuthRequest } from '../middleware/auth';
import { recordAudit } from '../security/audit';
import { requireAdminPermission } from '../security/admin-permissions';
import { normalizeId } from '../services/announcements';
import {
    EXPORT_PLATFORM_PERMISSION,
    TenantExportDataAccess,
    TenantExportDeps,
    TenantExportStorage,
    downloadTenantExport,
    issueExportDownloadToken,
    processTenantExport,
    requestTenantExport,
} from '../services/tenant-export';

export interface TenantExportRouteDeps {
    db: TenantExportDataAccess;
    authenticate: RequestHandler;
    /** Verified platform-permission guard (server-owned rows only). */
    requirePlatformPermission: (permission: string) => RequestHandler;
    /** Verified platform-permission check for dual-scope endpoints. */
    hasPlatformPermission: (userId: string, permission: string) => Promise<boolean>;
    /** Verified active tenant-owner membership for tenant-scoped actions. */
    tenantOwnerTenantId: (userId: string, tenantId: string) => Promise<boolean>;
    storage: TenantExportStorage;
    /** TENANT_EXPORT_SECRET; the surface fails closed (503) below 32 bytes. */
    secret: string | undefined;
}

const serviceDeps = (deps: TenantExportRouteDeps): TenantExportDeps => ({
    db: deps.db,
    storage: deps.storage,
    secret: deps.secret,
    audit: (input, db = deps.db) => recordAudit(db.execute, input),
});

interface ExportJobSummaryRow {
    id: string;
    tenant_id: string;
    status: string;
    file_size: number | string | null;
    manifest: unknown;
    expires_at: string | null;
    created_at: string;
    completed_at: string | null;
    error: string | null;
}

const resolvePlatformScope = async (
    deps: TenantExportRouteDeps,
    req: AuthRequest,
    res: Response,
): Promise<{ platform: boolean; tenantId: string | null } | null> => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    const platform = await deps.hasPlatformPermission(user.id, EXPORT_PLATFORM_PERMISSION);
    if (platform) {
        const requested = (typeof req.body === 'object' && req.body !== null
            ? (req.body as Record<string, unknown>).tenant_id
            : undefined) ?? req.query.tenant_id;
        if (typeof requested !== 'string') {
            res.status(400).json({ error: 'tenant_id is required' });
            return null;
        }
        const tenantId = normalizeId(requested);
        if (!tenantId) {
            res.status(400).json({ error: 'Invalid tenant_id' });
            return null;
        }
        const tenant = await deps.db.queryOne<{ id: string; status: string }>(
            'SELECT id, status FROM tenants WHERE id = ? LIMIT 1',
            [tenantId],
        );
        if (!tenant || tenant.status !== 'active') {
            res.status(404).json({ error: 'Tenant not found' });
            return null;
        }
        return { platform: true, tenantId };
    }
    const tenantId = user.tenantId;
    if (!tenantId) {
        res.status(403).json({ error: 'An active tenant workspace is required' });
        return null;
    }
    if (!(await deps.tenantOwnerTenantId(user.id, tenantId))) {
        res.status(403).json({ error: 'Tenant owner authority required' });
        return null;
    }
    return { platform: false, tenantId };
};

const canReadJob = async (
    deps: TenantExportRouteDeps,
    req: AuthRequest,
    tenantId: string,
): Promise<boolean> => {
    const user = req.user;
    if (!user) return false;
    if (await deps.hasPlatformPermission(user.id, EXPORT_PLATFORM_PERMISSION)) return true;
    return tenantId === user.tenantId && (await deps.tenantOwnerTenantId(user.id, tenantId));
};

export const createTenantExportRouter = (deps: TenantExportRouteDeps): Router => {
    const router = Router();
    const { db } = deps;
    router.use(deps.authenticate);

    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolvePlatformScope(deps, req, res);
            if (!scope) return;
            const jobs = await db.query(
                `SELECT id, tenant_id, status, file_size, expires_at, created_at, completed_at, error
                 FROM tenant_data_exports
                 WHERE tenant_id = ?
                 ORDER BY created_at DESC LIMIT 50`,
                [scope.tenantId as string],
            );
            res.json(jobs);
        } catch (error) {
            console.error('List tenant exports error:', error);
            res.status(500).json({ error: 'Failed to list tenant exports' });
        }
    });

    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolvePlatformScope(deps, req, res);
            if (!scope) return;
            const user = req.user!;
            const reason = typeof (req.body as Record<string, unknown> | null)?.['reason'] === 'string'
                ? String((req.body as Record<string, unknown>).reason).slice(0, 200)
                : undefined;
            const requested = await requestTenantExport(serviceDeps(deps), {
                tenantId: scope.tenantId as string,
                actorUserId: user.id,
                reason,
            });
            if (!requested.ok) return res.status(requested.status).json({ error: requested.error });
            const manifest = await processTenantExport(serviceDeps(deps), requested.job.id);
            res.status(201).json({ id: requested.job.id, status: 'completed', manifest });
        } catch (error) {
            console.error('Create tenant export error:', error);
            res.status(500).json({ error: 'Failed to create the tenant export' });
        }
    });

    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Export not found' });
            const job = await db.queryOne<ExportJobSummaryRow>(
                `SELECT id, tenant_id, status, file_size, manifest, expires_at, created_at, completed_at, error
                 FROM tenant_data_exports WHERE id = ? LIMIT 1`,
                [id],
            );
            if (!job) return res.status(404).json({ error: 'Export not found' });
            if (!(await canReadJob(deps, req, job.tenant_id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            res.json(job);
        } catch (error) {
            console.error('Get tenant export error:', error);
            res.status(500).json({ error: 'Failed to load the tenant export' });
        }
    });

    router.post('/:id/download-token', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Export not found' });
            const job = await db.queryOne<{ id: string; tenant_id: string; status: string }>(
                'SELECT id, tenant_id, status FROM tenant_data_exports WHERE id = ? LIMIT 1',
                [id],
            );
            if (!job) return res.status(404).json({ error: 'Export not found' });
            if (!(await canReadJob(deps, req, job.tenant_id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const issued = await issueExportDownloadToken(serviceDeps(deps), {
                tenantId: job.tenant_id,
                exportId: id,
                actorUserId: user.id,
            });
            if (!issued.ok) return res.status(issued.status).json({ error: issued.error });
            res.json({ token: issued.token, expires_at: issued.expiresAt });
        } catch (error) {
            console.error('Issue tenant export download token error:', error);
            res.status(500).json({ error: 'Failed to issue the download token' });
        }
    });

    router.get('/:id/download', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const id = normalizeId(req.params.id);
            if (!id) return res.status(404).json({ error: 'Export not found' });
            const token = typeof req.query.token === 'string' ? req.query.token : null;
            if (!token) return res.status(400).json({ error: 'A download token is required' });
            const job = await db.queryOne<{ id: string; tenant_id: string; status: string }>(
                'SELECT id, tenant_id, status FROM tenant_data_exports WHERE id = ? LIMIT 1',
                [id],
            );
            if (!job) return res.status(404).json({ error: 'Export not found' });
            if (!(await canReadJob(deps, req, job.tenant_id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const result = await downloadTenantExport(serviceDeps(deps), {
                token,
                tenantId: job.tenant_id,
                exportId: id,
                actorUserId: user.id,
            });
            if (!result.ok) return res.status(result.status).json({ error: result.error });
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="tenant-${job.tenant_id}-export.json"`);
            res.send(result.body);
        } catch (error) {
            console.error('Download tenant export error:', error);
            res.status(500).json({ error: 'Failed to download the tenant export' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real platform-capability guard,
   server-derived tenant ownership, the real secret from the environment and
   a path-traversal-safe local object storage (swap for S3 in deployment by
   providing another TenantExportStorage implementation). */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: TenantExportDataAccess = {
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
    transaction: async <T>(fn: (tx: TenantExportDataAccess) => Promise<T>): Promise<T> => {
        const { withTransaction } = await loadDb();
        return withTransaction(async (connection) => {
            const tx: TenantExportDataAccess = {
                query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                    const [rows] = await connection.execute(sql, params as never);
                    return rows as unknown as R[];
                },
                queryOne: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                    const [rows] = await connection.execute(sql, params as never);
                    const list = rows as unknown as R[];
                    return list.length > 0 ? list[0] : null;
                },
                execute: async (sql: string, params?: unknown[]) => {
                    const [result] = await connection.execute(sql, params as never);
                    return result as unknown as { insertId?: number; affectedRows?: number };
                },
            };
            return fn(tx);
        });
    },
};

class LocalTenantExportStorage implements TenantExportStorage {
    private readonly root: string;
    constructor(root: string) {
        this.root = path.resolve(root);
    }
    private resolveKey(key: string): string {
        const resolved = path.resolve(this.root, key);
        if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
            throw new Error('The export storage key escapes the storage root');
        }
        return resolved;
    }
    async write(key: string, body: string): Promise<void> {
        const target = this.resolveKey(key);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, body, 'utf8');
    }
    async read(key: string): Promise<string> {
        return readFile(this.resolveKey(key), 'utf8');
    }
}

const hasPlatformPermission = async (userId: string, permission: string): Promise<boolean> => {
    const { queryOne } = await loadDb();
    const row = await queryOne<{ user_id: string }>(
        `SELECT u.id AS user_id FROM users u
         WHERE u.id = ? AND u.is_active = 1
           AND (
             EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id = u.id AND aur.role_code = 'super_admin')
             OR EXISTS (
               SELECT 1 FROM admin_user_roles aur2
               INNER JOIN admin_role_permissions arp ON arp.role_code = aur2.role_code
               WHERE aur2.user_id = u.id AND arp.permission_key = ?
             )
           ) LIMIT 1`,
        [userId, permission],
    );
    return Boolean(row);
};

const tenantOwnerTenantId = async (userId: string, tenantId: string): Promise<boolean> => {
    const { queryOne } = await loadDb();
    const row = await queryOne<{ id: string }>(
        `SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1`,
        [tenantId, userId],
    );
    return Boolean(row);
};

export default createTenantExportRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => requireAdminPermission(permission),
    hasPlatformPermission,
    tenantOwnerTenantId,
    storage: new LocalTenantExportStorage(process.env.TENANT_EXPORT_STORAGE_DIR ?? 'storage/tenant-exports'),
    secret: process.env.TENANT_EXPORT_SECRET,
});
