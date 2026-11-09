"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTenantExportOwnership = exports.createTenantExportRuntime = exports.createTenantExportRouter = void 0;
const express_1 = require("express");
const promises_1 = require("fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const audit_1 = require("../security/audit");
const admin_permissions_1 = require("../security/admin-permissions");
const announcements_1 = require("../services/announcements");
const tenant_export_1 = require("../services/tenant-export");
const tenant_export_schema_1 = require("../services/tenant-export-schema");
const serviceDeps = (deps) => ({
    db: deps.db,
    storage: deps.storage,
    secret: deps.secret,
    // `recordAudit` invokes the executor as a bare function, so passing
    // `db.execute` directly would drop the receiver for any access object whose
    // `execute` reads `this` (a class-based adapter, for instance). The arrow
    // keeps the call bound to the object the caller supplied.
    audit: (input, db = deps.db) => (0, audit_1.recordAudit)((sql, params) => db.execute(sql, params), input),
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
const EXPORT_FAILURE_RESPONSES = {
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
const logExportFailure = (label, error) => {
    console.error(label, (0, tenant_export_1.classifyExportFailure)(error));
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
const bindAbort = (res) => {
    const controller = new AbortController();
    const onClose = () => {
        if (!res.writableEnded)
            controller.abort();
    };
    res.on('close', onClose);
    return {
        signal: controller.signal,
        release: () => {
            res.off('close', onClose);
        },
    };
};
const resolvePlatformScope = async (deps, req, res) => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    const platform = await deps.hasPlatformPermission(user.id, tenant_export_1.EXPORT_PLATFORM_PERMISSION);
    if (platform) {
        const requested = (typeof req.body === 'object' && req.body !== null
            ? req.body.tenant_id
            : undefined) ?? req.query.tenant_id;
        if (typeof requested !== 'string') {
            res.status(400).json({ error: 'tenant_id is required' });
            return null;
        }
        const tenantId = (0, announcements_1.normalizeId)(requested);
        if (!tenantId) {
            res.status(400).json({ error: 'Invalid tenant_id' });
            return null;
        }
        const tenant = await deps.db.queryOne('SELECT id, status FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
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
const canReadJob = async (deps, req, tenantId) => {
    const user = req.user;
    if (!user)
        return false;
    if (await deps.hasPlatformPermission(user.id, tenant_export_1.EXPORT_PLATFORM_PERMISSION))
        return true;
    return tenantId === user.tenantId && (await deps.tenantOwnerTenantId(user.id, tenantId));
};
const createTenantExportRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    router.use(deps.authenticate);
    // Export payloads and job metadata are personal data: no shared or browser
    // cache may retain them, on any status code.
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    router.get('/', async (req, res) => {
        try {
            const scope = await resolvePlatformScope(deps, req, res);
            if (!scope)
                return;
            const jobs = await db.query(`SELECT id, tenant_id, status, file_size, expires_at, created_at, completed_at, error
                 FROM tenant_data_exports
                 WHERE tenant_id = ?
                 ORDER BY created_at DESC LIMIT 50`, [scope.tenantId]);
            res.json(jobs);
        }
        catch (error) {
            logExportFailure('List tenant exports error:', error);
            res.status(500).json({ error: 'Failed to list tenant exports' });
        }
    });
    router.post('/', async (req, res) => {
        const abort = bindAbort(res);
        try {
            const scope = await resolvePlatformScope(deps, req, res);
            if (!scope)
                return;
            const user = req.user;
            const reason = typeof req.body?.['reason'] === 'string'
                ? String(req.body.reason).slice(0, 200)
                : undefined;
            const requested = await (0, tenant_export_1.requestTenantExport)(serviceDeps(deps), {
                tenantId: scope.tenantId,
                actorUserId: user.id,
                reason,
            });
            if (!requested.ok)
                return res.status(requested.status).json({ error: requested.error });
            const manifest = await (0, tenant_export_1.processTenantExport)({ ...serviceDeps(deps), signal: abort.signal }, requested.job.id);
            res.status(201).json({ id: requested.job.id, status: 'completed', manifest });
        }
        catch (error) {
            logExportFailure('Create tenant export error:', error);
            if (res.headersSent)
                return;
            const failure = EXPORT_FAILURE_RESPONSES[(0, tenant_export_1.classifyExportFailure)(error)];
            res.status(failure.status).json({ error: failure.error });
        }
        finally {
            abort.release();
        }
    });
    router.get('/:id', async (req, res) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const id = (0, announcements_1.normalizeId)(req.params.id);
            if (!id)
                return res.status(404).json({ error: 'Export not found' });
            const job = await db.queryOne(`SELECT id, tenant_id, status, file_size, manifest, expires_at, created_at, completed_at, error
                 FROM tenant_data_exports WHERE id = ? LIMIT 1`, [id]);
            if (!job)
                return res.status(404).json({ error: 'Export not found' });
            if (!(await canReadJob(deps, req, job.tenant_id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            res.json(job);
        }
        catch (error) {
            logExportFailure('Get tenant export error:', error);
            res.status(500).json({ error: 'Failed to load the tenant export' });
        }
    });
    router.post('/:id/download-token', async (req, res) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const id = (0, announcements_1.normalizeId)(req.params.id);
            if (!id)
                return res.status(404).json({ error: 'Export not found' });
            const job = await db.queryOne('SELECT id, tenant_id, status FROM tenant_data_exports WHERE id = ? LIMIT 1', [id]);
            if (!job)
                return res.status(404).json({ error: 'Export not found' });
            if (!(await canReadJob(deps, req, job.tenant_id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const issued = await (0, tenant_export_1.issueExportDownloadToken)(serviceDeps(deps), {
                tenantId: job.tenant_id,
                exportId: id,
                actorUserId: user.id,
            });
            if (!issued.ok)
                return res.status(issued.status).json({ error: issued.error });
            res.json({ token: issued.token, expires_at: issued.expiresAt });
        }
        catch (error) {
            logExportFailure('Issue tenant export download token error:', error);
            res.status(500).json({ error: 'Failed to issue the download token' });
        }
    });
    router.get('/:id/download', async (req, res) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const id = (0, announcements_1.normalizeId)(req.params.id);
            if (!id)
                return res.status(404).json({ error: 'Export not found' });
            const token = typeof req.query.token === 'string' ? req.query.token : null;
            if (!token)
                return res.status(400).json({ error: 'A download token is required' });
            const job = await db.queryOne('SELECT id, tenant_id, status FROM tenant_data_exports WHERE id = ? LIMIT 1', [id]);
            if (!job)
                return res.status(404).json({ error: 'Export not found' });
            if (!(await canReadJob(deps, req, job.tenant_id))) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const result = await (0, tenant_export_1.downloadTenantExport)(serviceDeps(deps), {
                token,
                tenantId: job.tenant_id,
                exportId: id,
                actorUserId: user.id,
            });
            if (!result.ok)
                return res.status(result.status).json({ error: result.error });
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="tenant-${job.tenant_id}-export.json"`);
            res.send(result.body);
        }
        catch (error) {
            logExportFailure('Download tenant export error:', error);
            res.status(500).json({ error: 'Failed to download the tenant export' });
        }
    });
    return router;
};
exports.createTenantExportRouter = createTenantExportRouter;
/* Production wiring: real pool, real auth, real platform-capability guard,
   server-derived tenant ownership, the real secret from the environment and
   a path-traversal-safe local object storage (swap for S3 in deployment by
   providing another TenantExportStorage implementation). */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
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
    transaction: async (fn) => {
        const { withTransaction } = await loadDb();
        return withTransaction(async (connection) => {
            const tx = {
                query: async (sql, params) => {
                    const [rows] = await connection.execute(sql, params);
                    return rows;
                },
                queryOne: async (sql, params) => {
                    const [rows] = await connection.execute(sql, params);
                    const list = rows;
                    return list.length > 0 ? list[0] : null;
                },
                execute: async (sql, params) => {
                    const [result] = await connection.execute(sql, params);
                    return result;
                },
            };
            return fn(tx);
        });
    },
};
class LocalTenantExportStorage {
    constructor(root) {
        this.root = node_path_1.default.resolve(root);
    }
    resolveKey(key) {
        const resolved = node_path_1.default.resolve(this.root, key);
        if (resolved !== this.root && !resolved.startsWith(this.root + node_path_1.default.sep)) {
            throw new Error('The export storage key escapes the storage root');
        }
        return resolved;
    }
    async write(key, body) {
        const target = this.resolveKey(key);
        await (0, promises_1.mkdir)(node_path_1.default.dirname(target), { recursive: true });
        await (0, promises_1.writeFile)(target, body, 'utf8');
    }
    async read(key) {
        return (0, promises_1.readFile)(this.resolveKey(key), 'utf8');
    }
}
const hasPlatformPermission = async (userId, permission) => {
    const { queryOne } = await loadDb();
    const row = await queryOne(`SELECT u.id AS user_id FROM users u
         WHERE u.id = ? AND u.is_active = 1
           AND (
             EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id = u.id AND aur.role_code = 'super_admin')
             OR EXISTS (
               SELECT 1 FROM admin_user_roles aur2
               INNER JOIN admin_role_permissions arp ON arp.role_code = aur2.role_code
               WHERE aur2.user_id = u.id AND arp.permission_key = ?
             )
           ) LIMIT 1`, [userId, permission]);
    return Boolean(row);
};
const tenantOwnerTenantId = async (userId, tenantId) => {
    const { queryOne } = await loadDb();
    const row = await queryOne(`SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1`, [tenantId, userId]);
    return Boolean(row);
};
/**
 * Resolve ownership activation without trusting caller-shaped metadata.
 * The real SQL adapter exists in the service, but activation needs trusted
 * catalog evidence bound to this database seam, including column/constraint
 * shape and enforcement. No such verifier is implemented here, so every
 * metadata-only composition remains explicitly unavailable. No I/O occurs.
 */
const resolveOwnership = (db, report) => {
    const valid = () => (0, tenant_export_schema_1.isTenantExportSchemaReportFor)(report, db, Date.now());
    if (!valid())
        return { port: null, reason: 'trusted, fresh database-bound ownership catalog proof is absent' };
    const executor = Object.assign((sql, params = []) => db.execute(sql, params), { query: (sql, params = []) => db.query(sql, params) });
    const adapter = (0, tenant_export_1.createSqlExportOwnershipPort)(executor);
    const guard = () => { if (!valid())
        throw new tenant_export_1.ExportOwnershipCapabilityError(); };
    const port = {
        describe: () => { guard(); return adapter.describe(); },
        claim: (run, input) => { guard(); return adapter.claim(run, input); },
        failureStatement: input => { guard(); return adapter.failureStatement(input); },
        releaseStatement: input => { guard(); return adapter.releaseStatement(input); },
    };
    if (adapter.renew)
        port.renew = input => { guard(); return adapter.renew(input); };
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
const createTenantExportRuntime = (options) => {
    const ownership = resolveOwnership(options.db, options.ownershipVerification);
    return {
        router: (0, exports.createTenantExportRouter)({ ...options, ownership: ownership.port ?? undefined }),
        ownership: ownership.port,
        ownershipRequiredColumns: [...tenant_export_1.EXPORT_OWNERSHIP_REQUIRED_COLUMNS],
        ownershipOwnedPredicate: tenant_export_1.EXPORT_OWNERSHIP_OWNED_PREDICATE,
        ownershipInactiveReason: ownership.reason,
    };
};
exports.createTenantExportRuntime = createTenantExportRuntime;
/** Production stays unavailable until an explicit catalog check succeeds.
 * Verification is never performed during import or construction. Reports expire
 * after fifteen minutes; explicit re-verification is required, with no timer.
 */
const productionOptions = {
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => (0, admin_permissions_1.requireAdminPermission)(permission),
    hasPlatformPermission,
    tenantOwnerTenantId,
    storage: new LocalTenantExportStorage(process.env.TENANT_EXPORT_STORAGE_DIR ?? 'storage/tenant-exports'),
    secret: process.env.TENANT_EXPORT_SECRET,
    ownership: undefined,
};
const initializeTenantExportOwnership = async () => {
    productionOptions.ownership = undefined;
    const report = await (0, tenant_export_schema_1.verifyTenantExportOwnershipSchema)(productionDb);
    productionOptions.ownership = resolveOwnership(productionDb, report).port ?? undefined;
    return report;
};
exports.initializeTenantExportOwnership = initializeTenantExportOwnership;
exports.default = (0, exports.createTenantExportRouter)(productionOptions);
