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

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requireAdminPermission } from '../security/admin-permissions';
import {
    AuditLogDataAccess,
    AuditLogFilters,
    MAX_EXPORT_ROWS,
    exportAuditCsv,
    listAuditEvents,
    parseAuditFilters,
    parseAuditPagination,
    recordSealedAuditEvent,
    verifyAuditChain,
} from '../services/audit-log';

export interface AuditLogsDeps {
    db: AuditLogDataAccess;
    authenticate: RequestHandler;
    /** Verified platform-permission guard (server-owned rows only). */
    requirePlatformPermission: (permission: string) => RequestHandler;
    /** Verified `audit.read`-equivalent platform check for dual-scope endpoints. */
    isPlatformReader: (userId: string) => Promise<boolean>;
    /** Verified active tenant-owner membership for tenant-scoped reads. */
    tenantOwnerTenantId: (userId: string, tenantId: string) => Promise<boolean>;
    /** Sealed audit writer (production: the hash chain). */
    recordAudit: (dataAccess: AuditLogDataAccess, input: SealedAuditExportInput) => Promise<void>;
}

/** Re-exported for tests; same shape the sealed writer accepts. */
export type SealedAuditExportInput = Parameters<typeof recordSealedAuditEvent>[1];

interface Scope {
    platformReader: boolean;
    tenantId: string | null;
}

const resolveScope = async (
    deps: AuditLogsDeps,
    req: AuthRequest,
    res: Response,
): Promise<Scope | null> => {
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

const filterFrom = (query: Record<string, unknown>, scope: Scope): { ok: true; value: AuditLogFilters } | { ok: false; error: string } => {
    const parsed = parseAuditFilters(query);
    if (!parsed.ok) return parsed;
    const filters = parsed.value;
    if (!scope.platformReader) {
        // Tenant owners are pinned to their own tenant regardless of input.
        filters.tenantId = scope.tenantId;
    }
    return { ok: true, value: filters };
};

export const createAuditLogsRouter = (deps: AuditLogsDeps): Router => {
    const router = Router();
    const { db } = deps;
    router.use(deps.authenticate);

    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(deps, req, res);
            if (!scope) return;
            const parsed = filterFrom(req.query as Record<string, unknown>, scope);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const pagination = parseAuditPagination(req.query as Record<string, unknown>);
            if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
            const page = await listAuditEvents(db, parsed.value, pagination);
            res.json({ data: page.rows, page: page.page, limit: page.limit, total: page.total });
        } catch (error) {
            console.error('List audit events error:', error);
            res.status(500).json({ error: 'Failed to load audit events' });
        }
    });

    router.get('/export.csv', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(deps, req, res);
            if (!scope) return;
            const parsed = filterFrom(req.query as Record<string, unknown>, scope);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error });
            const result = await exportAuditCsv(db, parsed.value);
            await deps.recordAudit(db, {
                actorUserId: req.user!.id,
                tenantId: scope.platformReader ? (parsed.value.tenantId ?? null) : scope.tenantId,
                action: 'audit_log.exported',
                resourceType: 'audit_events',
                resourceId: '*',
                newValue: parsed.value.tenantId
                    ? { format: 'csv', tenant_id: parsed.value.tenantId, row_count: result.rowCount, cap: MAX_EXPORT_ROWS, truncated: result.truncated }
                    : { format: 'csv', scope: 'platform', row_count: result.rowCount, cap: MAX_EXPORT_ROWS, truncated: result.truncated },
                reason: 'Audit log CSV export',
            });
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', 'attachment; filename="audit-events.csv"');
            // Single truncation signal (plus the `truncated` field in the export
            // audit row): the export stops at MAX_EXPORT_ROWS.
            res.set('X-Results-Truncated', result.truncated ? 'true' : 'false');
            res.send(result.csv);
        } catch (error) {
            console.error('Export audit events error:', error);
            res.status(500).json({ error: 'Failed to export audit events' });
        }
    });

    router.get('/chain/verify', deps.requirePlatformPermission('audit.read'), async (_req: AuthRequest, res: Response) => {
        try {
            res.json(await verifyAuditChain(db));
        } catch (error) {
            console.error('Verify audit chain error:', error);
            res.status(500).json({ error: 'Failed to verify the audit chain' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real platform-capability guard,
   server-derived tenant ownership and the real sealed audit writer run under
   a single-connection transaction so the head-row lock serializes appends. */

/** Verified platform-reader lookup: active super_admin or `audit.read` holder. */
export const PLATFORM_READER_SQL = `SELECT u.id AS user_id FROM users u
     WHERE u.id = ? AND u.is_active = 1
       AND (
         EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.user_id = u.id AND aur.role_code = 'super_admin')
         OR EXISTS (
           SELECT 1 FROM admin_user_roles aur2
           INNER JOIN admin_role_permissions arp ON arp.role_code = aur2.role_code
           WHERE aur2.user_id = u.id AND arp.permission_key = 'audit.read'
         )
       ) LIMIT 1`;

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

type Connection = Parameters<Parameters<typeof import('../db').withTransaction>[0]>[0];

const connectionDataAccess = (connection: Connection): AuditLogDataAccess => ({
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const [rows] = await connection.query(sql, params as never);
        return rows as T[];
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const [rows] = await connection.query(sql, params as never);
        return (rows as T[])[0] ?? null;
    },
    execute: async (sql: string, params?: unknown[]) => {
        const [result] = await connection.execute(sql, params as never);
        const header = result as { insertId?: number; affectedRows?: number };
        return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
    },
});

const productionDb: AuditLogDataAccess = {
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
    transaction: async <T>(fn: (tx: AuditLogDataAccess) => Promise<T>): Promise<T> => {
        const { withTransaction } = await loadDb();
        return withTransaction((connection) => fn(connectionDataAccess(connection)));
    },
};

export default createAuditLogsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    requirePlatformPermission: (permission) => requireAdminPermission(permission),
    isPlatformReader: async (userId) => {
        const { queryOne } = await loadDb();
        const row = await queryOne<{ user_id: string }>(PLATFORM_READER_SQL, [userId]);
        return Boolean(row);
    },
    tenantOwnerTenantId: async (userId, tenantId) => {
        const { queryOne } = await loadDb();
        const row = await queryOne<{ id: string }>(
            `SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1`,
            [tenantId, userId],
        );
        return Boolean(row);
    },
    recordAudit: async (dataAccess, input) => recordSealedAuditEvent(dataAccess, input),
});
