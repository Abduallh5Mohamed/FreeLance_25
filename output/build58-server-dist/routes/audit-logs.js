"use strict";
/**
 * M7 O7 — audit log read/export routes.
 *
 * Audience + permission model:
 *  - Every path requires authentication.
 *  - A verified platform reader (server-owned `audit.read` permission or a
 *    super admin — never a JWT role claim) may query, verify the chain and
 *    export the whole platform with any filter.
 *  - A verified tenant owner (active tenants.owner_user_id row) may read and
 *    export ONLY rows of their own tenant: the tenant filter is forced to the
 *    server-derived tenant, never taken from the request.
 *  - Everyone else is denied (403). Chain verification is platform-only.
 *  - Export is audited with the actor, applied filters and row count in the
 *    same sealed chain; export cells are formula-neutralized.
 *  - Reads are read-only: no handler issues UPDATE or DELETE against
 *    audit_events (append-only semantics). The sealed append itself advances
 *    the audit_chain_head anchor row (a separate table) under a locked
 *    transaction, which is what serializes concurrent appends.
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
exports.PLATFORM_READER_SQL = exports.createAuditLogsRouter = void 0;
const express_1 = require("express");
const admin_permissions_1 = require("../security/admin-permissions");
const audit_log_1 = require("../services/audit-log");
const resolveScope = async (deps, req, res) => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    if (await deps.isPlatformReader(user.id)) {
        return { platformReader: true, tenantId: null };
    }
    const tenantId = user.tenantId;
    if (tenantId && (await deps.tenantOwnerTenantId(user.id, tenantId))) {
        return { platformReader: false, tenantId };
    }
    res.status(403).json({ error: 'Forbidden' });
    return null;
};
const filterFrom = (query, scope) => {
    const parsed = (0, audit_log_1.parseAuditFilters)(query);
    if (!parsed.ok)
        return parsed;
    const filters = parsed.value;
    if (!scope.platformReader) {
        // Tenant owners are pinned to their own tenant regardless of input.
        filters.tenantId = scope.tenantId;
    }
    return { ok: true, value: filters };
};
const createAuditLogsRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    router.use(deps.authenticate);
    router.get('/', async (req, res) => {
        try {
            const scope = await resolveScope(deps, req, res);
            if (!scope)
                return;
            const parsed = filterFrom(req.query, scope);
            if (!parsed.ok)
                return res.status(400).json({ error: parsed.error });
            const pagination = (0, audit_log_1.parseAuditPagination)(req.query);
            if (!pagination)
                return res.status(400).json({ error: 'Invalid pagination' });
            const page = await (0, audit_log_1.listAuditEvents)(db, parsed.value, pagination);
            res.json({ data: page.rows, page: page.page, limit: page.limit, total: page.total });
        }
        catch (error) {
            console.error('List audit events error:', error);
            res.status(500).json({ error: 'Failed to load audit events' });
        }
    });
    router.get('/export.csv', async (req, res) => {
        try {
            const scope = await resolveScope(deps, req, res);
            if (!scope)
                return;
            const parsed = filterFrom(req.query, scope);
            if (!parsed.ok)
                return res.status(400).json({ error: parsed.error });
            const result = await (0, audit_log_1.exportAuditCsv)(db, parsed.value);
            await deps.recordAudit(db, {
                actorUserId: req.user.id,
                tenantId: scope.platformReader ? (parsed.value.tenantId ?? null) : scope.tenantId,
                action: 'audit_log.exported',
                resourceType: 'audit_events',
                resourceId: '*',
                newValue: parsed.value.tenantId
                    ? { format: 'csv', tenant_id: parsed.value.tenantId, row_count: result.rowCount, cap: audit_log_1.MAX_EXPORT_ROWS, truncated: result.truncated }
                    : { format: 'csv', scope: 'platform', row_count: result.rowCount, cap: audit_log_1.MAX_EXPORT_ROWS, truncated: result.truncated },
                reason: 'Audit log CSV export',
            });
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', 'attachment; filename="audit-events.csv"');
            // Single truncation signal (plus the `truncated` field in the export
            // audit row): the export stops at MAX_EXPORT_ROWS.
            res.set('X-Results-Truncated', result.truncated ? 'true' : 'false');
            res.send(result.csv);
        }
        catch (error) {
            console.error('Export audit events error:', error);
            res.status(500).json({ error: 'Failed to export audit events' });
        }
    });
    router.get('/chain/verify', deps.requirePlatformPermission('audit.read'), async (_req, res) => {
        try {
            res.json(await (0, audit_log_1.verifyAuditChain)(db));
        }
        catch (error) {
            console.error('Verify audit chain error:', error);
            res.status(500).json({ error: 'Failed to verify the audit chain' });
        }
    });
    return router;
};
exports.createAuditLogsRouter = createAuditLogsRouter;
/* Production wiring: real pool, real auth, real platform-capability guard,
   server-derived tenant ownership and the real sealed audit writer run under
   a single-connection transaction so the head-row lock serializes appends. */
/** Verified platform-reader lookup: active super_admin or `audit.read` holder. */
exports.PLATFORM_READER_SQL = `SELECT u.id AS user_id FROM users u
     WHERE u.id = ? AND u.is_active = 1
       AND (
         EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id = u.id AND aur.role_code = 'super_admin')
         OR EXISTS (
           SELECT 1 FROM admin_user_roles aur2
           INNER JOIN admin_role_permissions arp ON arp.role_code = aur2.role_code
           WHERE aur2.user_id = u.id AND arp.permission_key = 'audit.read'
         )
       ) LIMIT 1`;
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const connectionDataAccess = (connection) => ({
    query: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows;
    },
    queryOne: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows[0] ?? null;
    },
    execute: async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        const header = result;
        return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
    },
});
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
        return withTransaction((connection) => fn(connectionDataAccess(connection)));
    },
};
exports.default = (0, exports.createAuditLogsRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => (0, admin_permissions_1.requireAdminPermission)(permission),
    isPlatformReader: async (userId) => {
        const { queryOne } = await loadDb();
        const row = await queryOne(exports.PLATFORM_READER_SQL, [userId]);
        return Boolean(row);
    },
    tenantOwnerTenantId: async (userId, tenantId) => {
        const { queryOne } = await loadDb();
        const row = await queryOne(`SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1`, [tenantId, userId]);
        return Boolean(row);
    },
    recordAudit: async (dataAccess, input) => (0, audit_log_1.recordSealedAuditEvent)(dataAccess, input),
});
