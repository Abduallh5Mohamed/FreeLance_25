import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute, getPool } from '../db';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

export interface ImportsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
    withTransaction: <T>(
        work: (tx: Pick<ImportsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
    ) => Promise<T>;
}

export interface ImportsRouterDeps {
    db: ImportsDataAccess;
    authenticate: RequestHandler;
    authorize: RequestHandler;
    hasVerifiedPlatformFinanceAccess?: (userId: string) => Promise<boolean>;
    loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
}

/**
 * Money crosses the API as integer minor units or a decimal string with at
 * most two fraction digits; MySQL DECIMAL(10,2) does the arithmetic.
 */
const DECIMAL_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
export const toDecimalMoney = (value: unknown): string | null => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return DECIMAL_RE.test(trimmed) ? trimmed : null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) return null;
        const rounded = Math.round(value * 100) / 100;
        if (Math.abs(value - rounded) > 1e-9) return null;
        return rounded.toFixed(2);
    }
    return null;
};

const toPositiveInt = (value: unknown, fallback: number): number | null => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000000) return value;
    if (typeof value === 'string' && /^\d{1,7}$/.test(value.trim())) {
        const parsed = parseInt(value.trim(), 10);
        if (parsed > 0 && parsed <= 1000000) return parsed;
    }
    return null;
};

interface Import {
    id: string;
    supplier_name: string;
    supplier_phone: string;
    import_date: string;
    payment_method: string;
    total_amount: number;
    paid_amount: number;
    remaining_amount: number;
    notes: string;
    created_at: string;
    updated_at: string;
}

interface ImportItem {
    id: string;
    import_id: string;
    item_code: string;
    item_name: string;
    quantity: number;
    unit_price: number;
    total_price: number;
}

export const createImportsRouter = (deps: ImportsRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute, withTransaction } = deps.db;
    router.use(deps.authenticate, deps.authorize);

    const hasVerifiedPlatformFinanceAccess = deps.hasVerifiedPlatformFinanceAccess
        ?? ((userId: string) => hasVerifiedPlatformPermission('finance.read', userId));

    const loadActiveTenantAuthority = deps.loadActiveTenantAuthority
        ?? (async (userId: string, tenantId: string) => queryOne<{ authority: string }>(
            `SELECT 'owner' AS authority
             FROM tenants t
             WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
             UNION ALL
             SELECT m.role_key AS authority
             FROM tenant_memberships m
             INNER JOIN tenants t ON t.id = m.tenant_id
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
               AND t.status = 'active' AND u.is_active = 1
               AND m.role_key IN ('owner','instructor')
             LIMIT 1`,
            [tenantId, userId, userId, tenantId],
        ));

    interface Scope {
        platform: boolean;
        userId: string;
        tenantId: string | null;
    }

    const resolveScope = async (req: AuthRequest, res: Response): Promise<Scope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        let platform = false;
        try {
            platform = await hasVerifiedPlatformFinanceAccess(user.id);
        } catch (error) {
            console.error('Finance permission lookup failed:', error);
            res.status(503).json({ error: 'Finance permissions unavailable' });
            return null;
        }
        if (platform) return { platform: true, userId: user.id, tenantId: null };
        const tenantId = user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'Workspace access required' });
            return null;
        }
        let authorityRow: { authority: string } | null;
        try {
            authorityRow = await loadActiveTenantAuthority(user.id, tenantId);
        } catch (error) {
            console.error('Tenant authority lookup failed:', error);
            res.status(503).json({ error: 'Tenant authority unavailable' });
            return null;
        }
        if (!authorityRow || authorityRow.authority !== 'owner') {
            res.status(403).json({ error: 'Import records require tenant owner authority' });
            return null;
        }
        return { platform: false, userId: user.id, tenantId };
    };

    const resolveWriteScope = async (req: AuthRequest, res: Response): Promise<Scope | null> => {
        const scope = await resolveScope(req, res);
        if (!scope) return null;
        if (scope.platform) {
            res.status(403).json({ error: 'Active tenant membership required' });
            return null;
        }
        return scope;
    };

    const scopeClause = (scope: Scope): { sql: string; params: unknown[] } =>
        scope.platform ? { sql: '', params: [] } : { sql: ' AND tenant_id = ?', params: [scope.tenantId as string] };

    // Get all imports with their items (tenant-scoped)
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const clause = scopeClause(scope);

            const imports = await query<Import>(`SELECT * FROM imports WHERE 1=1${clause.sql} ORDER BY created_at DESC`, clause.params);

            // Fetch items for each import (items inherit the import's tenancy:
            // the import id itself was resolved inside the tenant predicate).
            const importsWithItems = await Promise.all(
                (imports as Import[]).map(async (imp) => {
                    const items = await query<ImportItem>(
                        'SELECT * FROM import_items WHERE import_id = ?',
                        [imp.id]
                    );
                    return { ...imp, items };
                })
            );

            res.json(importsWithItems);
        } catch (error) {
            console.error('Get imports error:', error);
            res.status(500).json({ error: 'Failed to fetch imports' });
        }
    });

    // Get import by ID (tenant-scoped)
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const clause = scopeClause(scope);
            const importData = await queryOne<Import>(
                `SELECT * FROM imports WHERE id = ?${clause.sql}`,
                [req.params.id, ...clause.params]
            );

            if (!importData) {
                return res.status(404).json({ error: 'Import not found' });
            }

            const items = await query<ImportItem>(
                'SELECT * FROM import_items WHERE import_id = ?',
                [req.params.id]
            );

            res.json({ ...importData, items });
        } catch (error) {
            console.error('Get import error:', error);
            res.status(500).json({ error: 'Failed to fetch import' });
        }
    });

    // Create new import (tenant-scoped, Decimal money, atomic items)
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;

            const { id, supplier_name, supplier_phone, import_date, payment_method, total_amount, paid_amount, notes, items } = req.body;

            if (!supplier_name || !import_date) {
                return res.status(400).json({ error: 'Supplier name and import date are required' });
            }
            if (total_amount !== undefined && total_amount !== null && toDecimalMoney(total_amount) === null) {
                return res.status(400).json({ error: 'total_amount must be a non-negative decimal with at most two fraction digits' });
            }
            if (paid_amount !== undefined && paid_amount !== null && toDecimalMoney(paid_amount) === null) {
                return res.status(400).json({ error: 'paid_amount must be a non-negative decimal with at most two fraction digits' });
            }

            const validatedItems: Array<{ item_code: string | null; item_name: string; quantity: number; unit_price: string }> = [];
            if (items !== undefined && items !== null) {
                if (!Array.isArray(items)) {
                    return res.status(400).json({ error: 'items must be an array' });
                }
                for (const item of items) {
                    if (!item || !item.item_name) continue;
                    const quantity = toPositiveInt(item.quantity ?? 1, 1);
                    const unitPrice = toDecimalMoney(item.unit_price ?? 0);
                    if (quantity === null || unitPrice === null) {
                        return res.status(400).json({ error: 'Each item needs a positive integer quantity and a non-negative decimal unit_price' });
                    }
                    validatedItems.push({ item_code: item.item_code || null, item_name: String(item.item_name), quantity, unit_price: unitPrice });
                }
            }

            const importId = typeof id === 'string' && id.length >= 8 ? id : randomUUID();

            // One transaction: the import row and all item rows commit
            // together (no orphan header on item failure). A reused client id
            // returns the existing tenant row instead of double-inserting.
            const created = await withTransaction(async (tx) => {
                const existing = await tx.queryOne<Import>(
                    'SELECT * FROM imports WHERE id = ? AND tenant_id = ?',
                    [importId, tenantId]
                );
                if (existing) {
                    const existingItems = await tx.query<ImportItem>(
                        'SELECT * FROM import_items WHERE import_id = ?',
                        [importId]
                    );
                    return { idempotent: true as const, row: existing, items: existingItems };
                }
                await tx.execute(
                    `INSERT INTO imports (id, tenant_id, supplier_name, supplier_phone, import_date, payment_method, total_amount, paid_amount, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [importId, tenantId, supplier_name, supplier_phone || null, import_date, payment_method || 'cash', toDecimalMoney(total_amount ?? 0) ?? '0.00', toDecimalMoney(paid_amount ?? 0) ?? '0.00', notes || null]
                );
                for (const item of validatedItems) {
                    await tx.execute(
                        `INSERT INTO import_items (id, import_id, item_code, item_name, quantity, unit_price)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [randomUUID(), importId, item.item_code, item.item_name, item.quantity, item.unit_price]
                    );
                }
                const row = await tx.queryOne<Import>(
                    'SELECT * FROM imports WHERE id = ? AND tenant_id = ?',
                    [importId, tenantId]
                );
                const createdItems = await tx.query<ImportItem>(
                    'SELECT * FROM import_items WHERE import_id = ?',
                    [importId]
                );
                return { idempotent: false as const, row, items: createdItems };
            });

            res.status(created.idempotent ? 200 : 201).json({ ...created.row, items: created.items });
        } catch (error) {
            console.error('Create import error:', error);
            res.status(500).json({ error: 'Failed to create import' });
        }
    });

    // Update import (tenant-scoped, money revalidated)
    router.put('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const clause = scopeClause(scope);
            const { supplier_name, supplier_phone, import_date, payment_method, total_amount, paid_amount, notes } = req.body;

            const updates: string[] = [];
            const values: unknown[] = [];

            if (supplier_name !== undefined) {
                updates.push('supplier_name = ?');
                values.push(supplier_name);
            }
            if (supplier_phone !== undefined) {
                updates.push('supplier_phone = ?');
                values.push(supplier_phone);
            }
            if (import_date !== undefined) {
                updates.push('import_date = ?');
                values.push(import_date);
            }
            if (payment_method !== undefined) {
                updates.push('payment_method = ?');
                values.push(payment_method);
            }
            if (total_amount !== undefined) {
                const decimal = toDecimalMoney(total_amount);
                if (decimal === null) return res.status(400).json({ error: 'total_amount must be a non-negative decimal with at most two fraction digits' });
                updates.push('total_amount = ?');
                values.push(decimal);
            }
            if (paid_amount !== undefined) {
                const decimal = toDecimalMoney(paid_amount);
                if (decimal === null) return res.status(400).json({ error: 'paid_amount must be a non-negative decimal with at most two fraction digits' });
                updates.push('paid_amount = ?');
                values.push(decimal);
            }
            if (notes !== undefined) {
                updates.push('notes = ?');
                values.push(notes);
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            const result = await execute(
                `UPDATE imports SET ${updates.join(', ')} WHERE id = ?${clause.sql}`,
                [...values, req.params.id, ...clause.params]
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Import not found' });
            }

            const updatedImport = await queryOne<Import>(
                `SELECT * FROM imports WHERE id = ?${clause.sql}`,
                [req.params.id, ...clause.params]
            );

            if (!updatedImport) {
                return res.status(404).json({ error: 'Import not found' });
            }

            const items = await query<ImportItem>(
                'SELECT * FROM import_items WHERE import_id = ?',
                [req.params.id]
            );

            res.json({ ...updatedImport, items });
        } catch (error) {
            console.error('Update import error:', error);
            res.status(500).json({ error: 'Failed to update import' });
        }
    });

    // Delete import (tenant-scoped)
    router.delete('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const clause = scopeClause(scope);
            const result = await execute(
                `DELETE FROM imports WHERE id = ?${clause.sql}`,
                [req.params.id, ...clause.params]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Import not found' });
            }

            res.json({ message: 'Import deleted successfully' });
        } catch (error) {
            console.error('Delete import error:', error);
            res.status(500).json({ error: 'Failed to delete import' });
        }
    });

    return router;
};

const withTransaction: ImportsDataAccess['withTransaction'] = async (work) => {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const tx = {
            query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
                const [rows] = await connection.execute(sql, params);
                return rows as T[];
            },
            queryOne: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | null> => {
                const [rows] = await connection.execute(sql, params);
                const list = rows as T[];
                return list.length > 0 ? list[0] : null;
            },
            execute: async (sql: string, params?: unknown[]) => {
                const [result] = await connection.execute(sql, params);
                return result as never;
            },
        };
        const result = await work(tx);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

const productionDb: ImportsDataAccess = { query, queryOne, execute, withTransaction };

export default createImportsRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
});
