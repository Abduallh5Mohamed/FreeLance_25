import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import {
    authenticateToken,
    optionalAuth,
    AuthRequest,
} from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { requireAdminPermission } from '../security/admin-permissions';

/**
 * Grade catalog router.
 *
 * `grades` is PER-TENANT: a row whose `tenant_id` is set belongs to exactly
 * one tenant and is managed by that tenant's teaching-write entitlement. A row
 * whose `tenant_id` IS NULL is a legacy SHARED catalog row: every
 * authenticated principal may read it, and only the server-verified platform
 * permission `grade.manage` may write it.
 *
 * Therefore:
 *  - reads require an authenticated principal — the catalog is no longer
 *    reachable anonymously;
 *  - reads return `(tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE`,
 *    so a tenant never sees another tenant's grades while legacy shared rows
 *    stay a read-only catalog;
 *  - a tenant write binds `tenant_id` from the server-derived selected tenant.
 *    It is NEVER taken from the request body, and every existing-row predicate
 *    carries `tenant_id = ?`, so a cross-tenant update/delete is a 404 with no
 *    mutation;
 *  - a tenant write is authorized by the teaching-write entitlement of the
 *    selected tenant, exactly like the groups router; a JWT role claim alone
 *    never satisfies it;
 *  - a legacy shared row (`tenant_id IS NULL`) is addressed only through an
 *    explicit `scope: 'shared'` request and then only by the server-verified
 *    platform permission `grade.manage`;
 *  - the row addressed by `:id` must exist and be active, so a soft-deleted
 *    grade can neither be edited nor resurrected through this router;
 *  - name / display_order inputs are validated against the `grades` columns
 *    before a statement runs, so a bad value is a 4xx rather than a driver
 *    error.
 *
 * Grade semantics (ordering, activation, meaning) are unchanged.
 */

/**
 * Data-access seam for the grades router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 *
 * The shape is referenced by `typeof import` only, so importing this module
 * never executes db.ts: no dotenv side effect and no pool creation.
 */
type DbModule = typeof import('../db');

export interface GradesDataAccess {
    query: DbModule['query'];
    queryOne: DbModule['queryOne'];
    execute: DbModule['execute'];
}

/** One `grades` row as the driver returns it. */
interface GradeRow {
    id: string;
    /** null marks a legacy shared catalog row. */
    tenant_id?: string | null;
    name: string;
    display_order: number;
    /** tinyint(1) as returned by the driver (0/1); fixtures may use booleans. */
    is_active: number | boolean;
    created_at: Date;
    updated_at: Date;
}

/**
 * Injectable seams for the grades router. The default export binds the
 * production SQL adapters, the real authentication middleware, the real
 * teaching-write guard (tenant rows) and the real platform-permission guard
 * (shared rows). Tests inject the real guard factories through this boundary
 * instead of bypassing production authorization.
 */
export interface GradesRouterDeps {
    db: GradesDataAccess;
    authenticate: RequestHandler;
    optionalAuthenticate: RequestHandler;
    /** Teaching-write guard for the page that owns the grade catalog. */
    requireTenantWrite: RequestHandler;
    /** Platform permission guard for legacy shared (NULL tenant) rows. */
    authorizePlatformWrite: RequestHandler;
}

/** `grades.name` is VARCHAR(255). */
const MAX_NAME_LENGTH = 255;

/** INT range of `grades.display_order`. */
const MIN_DISPLAY_ORDER = -2147483648;
const MAX_DISPLAY_ORDER = 2147483647;

/** A catalog name: a non-blank string, trimmed. */
const readGradeName = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
};

const isDisplayOrder = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_DISPLAY_ORDER && value <= MAX_DISPLAY_ORDER;

/** Read a 0/1 (or boolean) flag the way the driver returns it. */
const flag = (value: number | boolean | null | undefined): boolean =>
    value === true || value === 1;

/**
 * The only client-supplied selector a write accepts: `scope: 'shared'`
 * addresses a legacy shared row. Everything else is tenant-scoped, and the
 * tenant itself is never read from the body.
 *
 * An explicit opt-in keeps tenancy deny-by-default — a caller that never asks
 * for the shared catalog can only ever reach its own tenant's rows — and it
 * also lets the router pick the authorization branch BEFORE any read, so an
 * unauthorized write never touches the storage layer.
 */
const GRADE_SHARED_SCOPE = 'shared';

const wantsSharedRow = (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false;
    const scope = (body as Record<string, unknown>).scope;
    return scope === GRADE_SHARED_SCOPE;
};

/**
 * A captured guard response. The router replays it verbatim so a denial keeps
 * the guard's own status and message (401 / 403 / 503) instead of the router
 * inventing one.
 */
interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
}

/**
 * Run a real authorization guard and return its decision.
 *
 * The guard is invoked with a capturing response: if it denies, it writes into
 * the capture instead of the socket and never calls next, so the router can
 * replay the guard's exact status and body. A guard that allows simply calls
 * next and nothing was written.
 */
const runGuard = async (
    guard: RequestHandler,
    req: AuthRequest,
): Promise<{ allowed: boolean; response: CapturedResponse }> => {
    const captured: CapturedResponse = {};
    const capture = {
        status(code: number) { captured.statusCode = code; return capture; },
        json(payload: unknown) { captured.body = payload; return capture; },
    };
    let allowed = false;
    await guard(req, capture as unknown as Response, () => { allowed = true; });
    return { allowed, response: captured };
};

/**
 * Authorize one grade write against the row it targets:
 *  - a shared (NULL tenant) row needs the verified platform permission;
 *  - a tenant row needs the teaching-write entitlement of the selected tenant.
 * A row that belongs to another tenant is never authorized here (the handler
 * treats it as not found).
 */
const authorizeGradeWrite = async (
    deps: GradesRouterDeps,
    req: AuthRequest,
    shared: boolean,
): Promise<{ allowed: boolean; response: CapturedResponse }> =>
    runGuard(shared ? deps.authorizePlatformWrite : deps.requireTenantWrite, req);

/** Replay a captured denial on the real response. */
const replayDenial = (res: Response, response: CapturedResponse): void => {
    res.status(response.statusCode ?? 403).json(
        response.body ?? { error: 'Forbidden' },
    );
};

let dbModule: DbModule | null = null;
const loadDb = async (): Promise<DbModule> => {
    dbModule ??= await import('../db');
    return dbModule;
};

export const createGradesRouter = (deps: GradesRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    router.use(deps.optionalAuthenticate);

    /** The server-derived tenant of the authenticated principal. */
    const selectedTenant = (req: AuthRequest): string | null =>
        req.user?.tenantId ?? null;

    // Get all grades: own tenant plus the legacy shared catalog
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        const tenantId = selectedTenant(req);
        try {
            const grades = await query<GradeRow>(
                'SELECT * FROM grades WHERE (tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE ORDER BY display_order',
                [tenantId]
            );
            res.json(grades);
        } catch (error) {
            console.error('Get grades error:', error);
            res.status(500).json({ error: 'Failed to fetch grades' });
        }
    });

    // Get grade by ID
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        const tenantId = selectedTenant(req);
        try {
            const grade = await queryOne<GradeRow>(
                'SELECT * FROM grades WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) AND is_active = TRUE',
                [req.params.id, tenantId]
            );

            if (!grade) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            res.json(grade);
        } catch (error) {
            console.error('Get grade error:', error);
            res.status(500).json({ error: 'Failed to fetch grade' });
        }
    });

    // Create new grade
    router.post('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        const tenantId = selectedTenant(req);
        try {
            const sharedTarget = wantsSharedRow(req.body);
            // A shared create carries no tenant; a tenant create needs one,
            // otherwise no tenant_id could be bound at all.
            if (!sharedTarget && tenantId === null) {
                return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
            }
            // A create targets the caller's own tenant, so tenant authority is
            // what applies; the row's tenant_id is bound server-side.
            const decision = await authorizeGradeWrite(deps, req, sharedTarget);
            if (!decision.allowed) {
                replayDenial(res, decision.response);
                return;
            }

            const { name, display_order } = req.body ?? {};

            const nameValue = readGradeName(name);
            if (nameValue === undefined) {
                return res.status(400).json({ error: 'Name is required' });
            }
            if (nameValue.length > MAX_NAME_LENGTH) {
                return res.status(400).json({ error: 'Name is too long' });
            }

            let displayOrder = 0;
            if (display_order !== undefined && display_order !== null) {
                if (!isDisplayOrder(display_order)) {
                    return res.status(400).json({ error: 'Invalid display_order' });
                }
                displayOrder = display_order;
            }

            // grades.id is CHAR(36) with a UUID default, so a driver insert id
            // cannot identify the created row; the id is generated server-side
            // and the row is read back through it (same as the groups router).
            const newId = randomUUID();
            const boundTenant = sharedTarget ? null : tenantId;
            await execute(
                'INSERT INTO grades (id, tenant_id, name, display_order) VALUES (?, ?, ?, ?)',
                [newId, boundTenant, nameValue, displayOrder]
            );

            const newGrade = sharedTarget
                ? await queryOne<GradeRow>('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL', [newId])
                : await queryOne<GradeRow>('SELECT * FROM grades WHERE id = ? AND tenant_id = ?', [newId, tenantId]);

            res.status(201).json(newGrade);
        } catch (error) {
            console.error('Create grade error:', error);
            res.status(500).json({ error: 'Failed to create grade' });
        }
    });

    // Update grade
    router.put('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        const tenantId = selectedTenant(req);
        try {
            const { name, display_order } = req.body ?? {};

            const nameValue = readGradeName(name);
            if (nameValue === undefined) {
                return res.status(400).json({ error: 'Name is required' });
            }
            if (nameValue.length > MAX_NAME_LENGTH) {
                return res.status(400).json({ error: 'Name is too long' });
            }

            let displayOrder: number | null = null;
            if (display_order !== undefined && display_order !== null) {
                if (!isDisplayOrder(display_order)) {
                    return res.status(400).json({ error: 'Invalid display_order' });
                }
                displayOrder = display_order;
            }

            const sharedRow = wantsSharedRow(req.body);
            const decision = await authorizeGradeWrite(deps, req, sharedRow);
            if (!decision.allowed) {
                replayDenial(res, decision.response);
                return;
            }

            // Only an active row is addressable: a soft-deleted grade stays
            // deleted instead of being resurrected through an update. The
            // predicate carries the scope itself, so a grade of another tenant
            // is indistinguishable from a missing one.
            const existing = await (sharedRow
                ? queryOne<GradeRow>(
                    'SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL AND is_active = TRUE',
                    [req.params.id]
                )
                : queryOne<GradeRow>(
                    'SELECT * FROM grades WHERE id = ? AND tenant_id = ? AND is_active = TRUE',
                    [req.params.id, tenantId]
                ));
            if (!existing) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            const result = sharedRow
                ? await execute(
                    'UPDATE grades SET name = ?, display_order = ? WHERE id = ? AND tenant_id IS NULL',
                    [nameValue, displayOrder ?? existing.display_order, req.params.id]
                )
                : await execute(
                    'UPDATE grades SET name = ?, display_order = ? WHERE id = ? AND tenant_id = ?',
                    [nameValue, displayOrder ?? existing.display_order, req.params.id, tenantId]
                );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            const updatedGrade = sharedRow
                ? await queryOne<GradeRow>('SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL', [req.params.id])
                : await queryOne<GradeRow>('SELECT * FROM grades WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);

            res.json(updatedGrade);
        } catch (error) {
            console.error('Update grade error:', error);
            res.status(500).json({ error: 'Failed to update grade' });
        }
    });

    // Delete grade (soft delete)
    router.delete('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        const tenantId = selectedTenant(req);
        try {
            const sharedRow = wantsSharedRow(req.body);
            const decision = await authorizeGradeWrite(deps, req, sharedRow);
            if (!decision.allowed) {
                replayDenial(res, decision.response);
                return;
            }

            // Only an active row is addressable, so deleting twice is a 404
            // instead of a silent success. The predicate carries the scope, so
            // another tenant's grade is indistinguishable from a missing one.
            const existing = await (sharedRow
                ? queryOne<GradeRow>(
                    'SELECT * FROM grades WHERE id = ? AND tenant_id IS NULL AND is_active = TRUE',
                    [req.params.id]
                )
                : queryOne<GradeRow>(
                    'SELECT * FROM grades WHERE id = ? AND tenant_id = ? AND is_active = TRUE',
                    [req.params.id, tenantId]
                ));
            if (!existing) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            await (sharedRow
                ? execute(
                    'UPDATE grades SET is_active = FALSE WHERE id = ? AND tenant_id IS NULL',
                    [req.params.id]
                )
                : execute(
                    'UPDATE grades SET is_active = FALSE WHERE id = ? AND tenant_id = ?',
                    [req.params.id, tenantId]
                ));

            res.json({ message: 'Grade deleted successfully' });
        } catch (error) {
            console.error('Delete grade error:', error);
            res.status(500).json({ error: 'Failed to delete grade' });
        }
    });

    return router;
};

export default createGradesRouter({
    db: {
        query: async <T>(sql: string, params?: unknown[]) => (await loadDb()).query<T>(sql, params),
        queryOne: async <T>(sql: string, params?: unknown[]) => (await loadDb()).queryOne<T>(sql, params),
        execute: async (sql: string, params?: unknown[]) => (await loadDb()).execute(sql, params),
    },
    authenticate: authenticateToken,
    optionalAuthenticate: optionalAuth,
    requireTenantWrite: requireTeachingWrite('groups'),
    authorizePlatformWrite: requireAdminPermission('grade.manage'),
});
