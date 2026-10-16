import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import {
    authenticateToken,
    optionalAuth,
    AuthRequest,
} from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

/**
 * Grade catalog router.
 *
 * `grades` is a global catalog (it carries no tenant column) that the teaching
 * UI manages next to `groups`, so:
 *  - reads require an authenticated principal — the catalog is no longer
 *    reachable anonymously;
 *  - writes require the teaching-write entitlement of the selected tenant, the
 *    same server-derived gate the groups router uses (client role claims,
 *    including a bare `admin` claim, never satisfy it);
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

/**
 * Injectable seams for the grades router. The default export binds the
 * production SQL adapters, the real authentication middleware, and the real
 * teaching-write guard. Tests inject fixtures through this boundary instead
 * of bypassing production authorization.
 */
export interface GradesRouterDeps {
    db: GradesDataAccess;
    authenticate: RequestHandler;
    optionalAuthenticate: RequestHandler;
    /** Teaching-write guard for the page that owns the grade catalog. */
    requireGroupWrite: RequestHandler;
}

/** `grades.name` is VARCHAR(255). */
const MAX_NAME_LENGTH = 255;

/** INT range of `grades.display_order`. */
const MIN_DISPLAY_ORDER = -2147483648;
const MAX_DISPLAY_ORDER = 2147483647;

interface GradeRow {
    id: string;
    name: string;
    display_order: number;
    /** tinyint(1) as returned by the driver (0/1); fixtures may use booleans. */
    is_active: number | boolean;
    created_at: Date;
    updated_at: Date;
}

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

let dbModule: DbModule | null = null;
const loadDb = async (): Promise<DbModule> => {
    dbModule ??= await import('../db');
    return dbModule;
};

export const createGradesRouter = (deps: GradesRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    router.use(deps.optionalAuthenticate);

    // Get all grades
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const grades = await query<GradeRow>(
                'SELECT * FROM grades WHERE is_active = TRUE ORDER BY display_order'
            );
            res.json(grades);
        } catch (error) {
            console.error('Get grades error:', error);
            res.status(500).json({ error: 'Failed to fetch grades' });
        }
    });

    // Get grade by ID
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const grade = await queryOne<GradeRow>(
                'SELECT * FROM grades WHERE id = ? AND is_active = TRUE',
                [req.params.id]
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
    router.post('/', deps.requireGroupWrite, async (req: AuthRequest, res: Response) => {
        try {
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
            await execute(
                'INSERT INTO grades (id, name, display_order) VALUES (?, ?, ?)',
                [newId, nameValue, displayOrder]
            );

            const newGrade = await queryOne<GradeRow>(
                'SELECT * FROM grades WHERE id = ?',
                [newId]
            );

            res.status(201).json(newGrade);
        } catch (error) {
            console.error('Create grade error:', error);
            res.status(500).json({ error: 'Failed to create grade' });
        }
    });

    // Update grade
    router.put('/:id', deps.requireGroupWrite, async (req: AuthRequest, res: Response) => {
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

            // Only an active row is addressable: a soft-deleted grade stays
            // deleted instead of being resurrected through an update.
            const existing = await queryOne<GradeRow>(
                'SELECT * FROM grades WHERE id = ? AND is_active = TRUE',
                [req.params.id]
            );
            if (!existing) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            const result = await execute(
                'UPDATE grades SET name = ?, display_order = ? WHERE id = ?',
                [nameValue, displayOrder ?? existing.display_order, req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            const updatedGrade = await queryOne<GradeRow>(
                'SELECT * FROM grades WHERE id = ?',
                [req.params.id]
            );

            res.json(updatedGrade);
        } catch (error) {
            console.error('Update grade error:', error);
            res.status(500).json({ error: 'Failed to update grade' });
        }
    });

    // Delete grade (soft delete)
    router.delete('/:id', deps.requireGroupWrite, async (req: AuthRequest, res: Response) => {
        try {
            // Only an active row is addressable, so deleting twice is a 404
            // instead of a silent success.
            const existing = await queryOne<GradeRow>(
                'SELECT * FROM grades WHERE id = ? AND is_active = TRUE',
                [req.params.id]
            );
            if (!existing) {
                return res.status(404).json({ error: 'Grade not found' });
            }

            await execute(
                'UPDATE grades SET is_active = FALSE WHERE id = ?',
                [req.params.id]
            );

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
    requireGroupWrite: requireTeachingWrite('groups'),
});
