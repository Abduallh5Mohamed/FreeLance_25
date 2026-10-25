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
 *  - The export runs inside the request, so the response lifecycle is also the
 *    cancellation signal: a client that disconnects aborts the run, which
 *    settles the job as `failed`/`aborted` and never records a completion.
 *  - Failures are answered from a closed code table — 503 for a missing data
 *    source or storage, 409 for a cancelled, in-flight or already-settled run,
 *    500 otherwise — and the raw driver error is neither returned nor logged.
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
    createSqlExportOwnershipPort,
    ExportOwnershipCapabilityError,
    EXPORT_OWNERSHIP_OWNED_PREDICATE,
    EXPORT_OWNERSHIP_REQUIRED_COLUMNS,
    EXPORT_PLATFORM_PERMISSION,
    TenantExportDataAccess,
    TenantExportDeps,
    TenantExportStorage,
    classifyExportFailure,
    downloadTenantExport,
    issueExportDownloadToken,
    processTenantExport,
    requestTenantExport,
} from '../services/tenant-export';
import { verifyTenantExportOwnershipSchema, isTenantExportSchemaReportFor } from '../services/tenant-export-schema';
import type { TenantExportSchemaReport } from '../services/tenant-export-schema';
import type { ExportFailureCode, ExportOwnershipPort } from '../services/tenant-export';

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
    /**
     * Durable execution ownership port. The service requires it and fails closed
     * without it, so this is the seam through which a deployment supplies real
     * fencing. See `EXPORT_OWNERSHIP_OWNED_PREDICATE` in the service for the
     * exact contract the port must declare and enforce.
     */
    ownership?: ExportOwnershipPort;
}

const serviceDeps = (deps: TenantExportRouteDeps): TenantExportDeps => ({
    db: deps.db,
    storage: deps.storage,
    secret: deps.secret,
    // `recordAudit` invokes the executor as a bare function, so passing
    // `db.execute` directly would drop the receiver for any access object whose
    // `execute` reads `this` (a class-based adapter, for instance). The arrow
    // keeps the call bound to the object the caller supplied.
    audit: (input, db = deps.db) => recordAudit((sql, params) => db.execute(sql, params), input),
    // Durable execution ownership is forwarded from the route dependency. The
    // service REQUIRES it and fails closed without it; it is a route-level
    // decision what to inject, and this router never invents one.
    ownership: deps.ownership,
});

/**
 * HTTP answer per closed failure code. A missing table or column is reported as
 * a generic "source unavailable" (503), never as an empty export and never with
 * the failing statement attached: the code is the whole diagnostic the client
 * is entitled to, and the operator gets it from the job row and the audit trail.
 */
const EXPORT_FAILURE_RESPONSES: Record<ExportFailureCode, { status: number; error: string }> = {
    aborted: { status: 409, error: 'The export was cancelled' },
    export_in_progress: { status: 409, error: 'The export is already being processed' },
    'transaction-capability-absent': { status: 503, error: 'The tenant export service is not configured' },
    'ownership_capability_absent': { status: 503, error: 'The tenant export service is not configured' },
    ownership_lost: { status: 409, error: 'The export is already being processed' },
    source_unavailable: { status: 503, error: 'The export data source is unavailable' },
    read_failed: { status: 500, error: 'Failed to create the tenant export' },
    storage_write_failed: { status: 503, error: 'The export storage is unavailable' },
    audit_failed: { status: 500, error: 'Failed to create the tenant export' },
    completion_conflict: { status: 409, error: 'The export was completed by another attempt' },
    // Unknown, not failed: the job row may be either pending or completed, so
    // the caller is told the request did not settle and must read the job back
    // rather than being handed a fabricated failure.
    completion_unknown: { status: 500, error: 'Failed to create the tenant export' },
};

/**
 * Log the closed failure code, never the raw error.
 *
 * A MySQL driver error carries `sql`, `sqlMessage` and the bound parameters of
 * the failing statement, so logging the object writes the export tenant and the
 * generated statement into the server log.
 */
const logExportFailure = (label: string, error: unknown): void => {
    console.error(label, classifyExportFailure(error));
};

/**
 * Bind an abort signal to the response lifecycle.
 *
 * A client that disconnects mid-export must not leave the server reading and
 * writing a whole-tenant artifact for a response nobody will receive. The
 * service checks the signal before every page and before writing the manifest,
 * so an aborted run settles as `failed`/`aborted` and never audits a success.
 *
 * `close` also fires on a normal finish, so it only aborts when the response
 * never ended. The caller releases the listener in `finally`.
 */
const bindAbort = (res: Response): { signal: AbortSignal; release: () => void } => {
    const controller = new AbortController();
    const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    return {
        signal: controller.signal,
        release: () => {
            res.off('close', onClose);
        },
    };
};

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
    // Export payloads and job metadata are personal data: no shared or browser
    // cache may retain them, on any status code.
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

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
            logExportFailure('List tenant exports error:', error);
            res.status(500).json({ error: 'Failed to list tenant exports' });
        }
    });

    router.post('/', async (req: AuthRequest, res: Response) => {
        const abort = bindAbort(res);
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
            const manifest = await processTenantExport(
                { ...serviceDeps(deps), signal: abort.signal },
                requested.job.id,
            );
            res.status(201).json({ id: requested.job.id, status: 'completed', manifest });
        } catch (error) {
            logExportFailure('Create tenant export error:', error);
            if (res.headersSent) return;
            const failure = EXPORT_FAILURE_RESPONSES[classifyExportFailure(error)];
            res.status(failure.status).json({ error: failure.error });
        } finally {
            abort.release();
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
            logExportFailure('Get tenant export error:', error);
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
            logExportFailure('Issue tenant export download token error:', error);
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
            logExportFailure('Download tenant export error:', error);
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

/**
 * What a startup check must produce before the real ownership port may be
 * activated.
 *
 * Deliberately NOT a boolean. The caller reports the COLUMN NAMES it actually
 * read from `information_schema.COLUMNS` for `tenant_data_exports`, and this
 * module cross-checks them against `EXPORT_OWNERSHIP_REQUIRED_COLUMNS`. A
 * caller-shaped report alone leaves the surface at its audited 503
 * instead of wiring a port whose every claim would fail.
 *
 * It is still an ATTESTATION, not proof: nothing here re-reads the catalog,
 * because this module performs no I/O at import or construction. What it buys
 * is that a wrong attestation is checkable and refuses loudly.
 *
 * The attestation covers the COLUMNS only. The same migration also creates four
 * named CHECK constraints — `chk_tenant_export_owner_pair`,
 * `chk_tenant_export_owner_epoch`, `chk_tenant_export_owner_lease` and
 * `chk_tenant_export_owner_claim` — and a startup that intends to activate this
 * port must confirm those too; the adapter cannot see them, so they are named
 * here rather than pretended to be checked.
 */
export interface TenantExportOwnershipSchemaAttestation {
    /** The migration this attestation covers. Only the ownership migration is accepted. */
    readonly migration: '20261024_05';
    /** Column names read from `information_schema.COLUMNS` for `tenant_data_exports`. */
    readonly columns: readonly string[];
    /** When that read happened (ms since epoch). */
    readonly checkedAtMs: number;
}

export interface TenantExportRuntimeOptions extends TenantExportRouteDeps {
    /**
     * Absent or `null` ⇒ the runtime keeps the service's audited 503
     * (`ownership_capability_absent`). There is no "assume it is applied" path.
     */
    /** Metadata only; cannot activate ownership without trusted catalog proof. */
    ownershipSchema?: TenantExportOwnershipSchemaAttestation | null;
    ownershipVerification?: TenantExportSchemaReport | null;
}

export interface TenantExportRuntime {
    readonly router: Router;
    /** `null` when ownership is inactive; the service then refuses with an audited 503. */
    readonly ownership: ExportOwnershipPort | null;
    /** The exact column set a startup check must cover. */
    readonly ownershipRequiredColumns: readonly string[];
    /** The four-term fence every owned transition carries. */
    readonly ownershipOwnedPredicate: string;
    /** Why ownership is inactive, or `null` when it is wired. */
    readonly ownershipInactiveReason: string | null;
}

/**
 * Resolve ownership activation without trusting caller-shaped metadata.
 * The real SQL adapter exists in the service, but activation needs trusted
 * catalog evidence bound to this database seam, including column/constraint
 * shape and enforcement. No such verifier is implemented here, so every
 * metadata-only composition remains explicitly unavailable. No I/O occurs.
 */
const resolveOwnership = (
    db: TenantExportDataAccess,
    report: TenantExportSchemaReport | null | undefined,
): { port: ExportOwnershipPort | null; reason: string | null } => {
    const valid = () => isTenantExportSchemaReportFor(report, db, Date.now());
    if (!valid()) return { port: null, reason: 'trusted, fresh database-bound ownership catalog proof is absent' };
    const executor = Object.assign(
        (sql: string, params: unknown[] = []) => db.execute(sql, params),
        { query: <T>(sql: string, params: unknown[] = []) => db.query<T>(sql, params) },
    );
    const adapter = createSqlExportOwnershipPort(executor);
    const guard = () => { if (!valid()) throw new ExportOwnershipCapabilityError(); };
    const port: ExportOwnershipPort = {
        describe: () => { guard(); return adapter.describe(); },
        claim: (run, input) => { guard(); return adapter.claim(run, input); },
        failureStatement: input => { guard(); return adapter.failureStatement(input); },
        releaseStatement: input => { guard(); return adapter.releaseStatement(input); },
    };
    if (adapter.renew) port.renew = input => { guard(); return adapter.renew!(input); };
    return { port: Object.freeze(port), reason: null };
};

/**
 * ONE explicit composition entry for the tenant-export surface.
 *
 * The route, the service and the ownership adapter are composed here from a
 * single dependency set, so a deployment cannot wire a router whose service has
 * no fencing port, or a port over a different data-access seam than the one the
 * service reads through. Everything the surface needs to be honest about its
 * own state is returned alongside the router: the exact column set a startup
 * check must cover, the fence predicate, and the reason ownership is inactive
 * when it is.
 *
 * Construction is inert: no query, no connection, no timer, no listener, and no
 * job is started or scheduled.
 */
export const createTenantExportRuntime = (options: TenantExportRuntimeOptions): TenantExportRuntime => {
    const ownership = resolveOwnership(options.db, options.ownershipVerification);
    return {
        router: createTenantExportRouter({ ...options, ownership: ownership.port ?? undefined }),
        ownership: ownership.port,
        ownershipRequiredColumns: [...EXPORT_OWNERSHIP_REQUIRED_COLUMNS],
        ownershipOwnedPredicate: EXPORT_OWNERSHIP_OWNED_PREDICATE,
        ownershipInactiveReason: ownership.reason,
    };
};

/** Production stays unavailable until an explicit catalog check succeeds.
 * Verification is never performed during import or construction. Reports expire
 * after fifteen minutes; explicit re-verification is required, with no timer.
 */
const productionOptions: TenantExportRouteDeps = {
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
    ownership: undefined,
};
export const initializeTenantExportOwnership = async (): Promise<TenantExportSchemaReport> => {
    productionOptions.ownership = undefined;
    const report = await verifyTenantExportOwnershipSchema(productionDb);
    productionOptions.ownership = resolveOwnership(productionDb, report).port ?? undefined;
    return report;
};
export default createTenantExportRouter(productionOptions);
