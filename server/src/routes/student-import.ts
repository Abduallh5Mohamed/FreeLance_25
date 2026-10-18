/**
 * C12 student CSV import routes.
 *
 * Flow: `preview` parses/validates the uploaded CSV and reports every row
 * (valid / rejected / duplicate) without any write. `commit` performs the same
 * analysis, applies the requested duplicate-resolution policy, then imports
 * atomically. Idempotency is keyed on the CSV content hash (and an optional
 * caller `file_key`): re-submitting the same file returns the original batch
 * and writes nothing.
 *
 * Every route is staff-scoped to the verified principal's server-selected
 * tenant (owner or active instructor membership); an optional branch target is
 * validated to belong to that tenant. Imported rows are tenant-scoped, never
 * reference a foreign resource, and no password/hash column is accepted or
 * echoed. Every commit and report export is audited.
 *
 * Exports `createStudentImportRouter(deps)`; intentionally not mounted by this
 * task. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit } from '../security/audit';
import { isDuplicateEntryError } from '../services/lesson-progress';
import {
    analyzeStudentCsv,
    hashCsvContent,
    normalizeDuplicateResolution,
    planImport,
    toRejectedReportCsv,
    type RejectedImportRow,
} from '../services/student-csv-import';

export interface StudentImportDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface StudentImportDeps {
    db: StudentImportDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    transaction?: <T>(fn: (tx: StudentImportDataAccess) => Promise<T>) => Promise<T>;
    /** Optional hash seam (defaults to SHA-256 of the raw CSV). */
    hashCsv?: (text: string) => string;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
const MAX_FILE_KEY_LENGTH = 120;

interface ImportBatchRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    file_hash: string;
    file_key: string | null;
    headers: string | null;
    row_count: number;
    imported_count: number;
    updated_count: number;
    skipped_count: number;
    rejected_count: number;
    rejected_rows: string | null;
    created_at: string | Date;
}

function parseJsonArray(value: string | null): RejectedImportRow[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? (parsed as RejectedImportRow[]) : [];
    } catch {
        return [];
    }
}

function parseJsonStringArray(value: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
}

export const createStudentImportRouter = (deps: StudentImportDeps): Router => {
    const router = Router();
    const { db } = deps;
    const hashCsv = deps.hashCsv ?? hashCsvContent;
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: StudentImportDataAccess) => Promise<T>): Promise<T> => fn(db);

    router.use(deps.authenticate);

    const resolveStaffScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<{ tenantId: string; userId: string } | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        const tenantId = user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'An active tenant membership is required' });
            return null;
        }
        const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) {
            res.status(403).json({ error: 'Tenant instructor authority required' });
            return null;
        }
        return { tenantId, userId: user.id };
    };

    const branchInTenant = async (tenantId: string, branchId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; status: string }>(
            'SELECT id, status FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1',
            [branchId, tenantId],
        );
        return Boolean(row && row.status === 'active');
    };

    const existingStudentLookup = (tenantId: string) =>
        async ({ phone, email }: { phone: string | null; email: string | null }): Promise<boolean> => {
            const clauses: string[] = [];
            const params: unknown[] = [tenantId];
            if (phone) {
                clauses.push('phone=?');
                params.push(phone.replace(/[\s()\-]/g, ''));
            }
            if (email) {
                clauses.push('email=?');
                params.push(email.toLowerCase());
            }
            if (clauses.length === 0) return false;
            const row = await db.queryOne<{ id: string }>(
                `SELECT id FROM students WHERE tenant_id=? AND (${clauses.join(' OR ')}) LIMIT 1`,
                params,
            );
            return Boolean(row);
        };

    interface CommitRequest {
        csv: string;
        branchId: string | null;
        fileKey: string | null;
        resolution: ReturnType<typeof normalizeDuplicateResolution>;
    }

    const readCommitRequest = (req: AuthRequest, res: Response): CommitRequest | null => {
        const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
        const csv = body['csv'];
        if (typeof csv !== 'string' || csv.trim() === '') {
            res.status(400).json({ error: 'csv is required' });
            return null;
        }
        let branchId: string | null = null;
        const rawBranch = body['branch_id'];
        if (rawBranch !== undefined && rawBranch !== null && rawBranch !== '') {
            if (typeof rawBranch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rawBranch.trim())) {
                res.status(400).json({ error: 'branch_id is invalid' });
                return null;
            }
            branchId = rawBranch.trim();
        }
        let fileKey: string | null = null;
        const rawKey = body['file_key'];
        if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
            if (typeof rawKey !== 'string' || rawKey.trim() === '' || rawKey.trim().length > MAX_FILE_KEY_LENGTH) {
                res.status(400).json({ error: 'file_key is invalid' });
                return null;
            }
            fileKey = rawKey.trim();
        }
        return { csv, branchId, fileKey, resolution: normalizeDuplicateResolution(body['duplicate_resolution']) };
    };

    const loadExistingBatch = async (
        dataAccess: StudentImportDataAccess,
        tenantId: string,
        request: CommitRequest,
        hash: string,
    ) => {
        if (request.fileKey) {
            const byKey = await dataAccess.queryOne<ImportBatchRow>(
                `SELECT id,imported_count,updated_count,skipped_count,rejected_count
                 FROM student_import_batches WHERE tenant_id=? AND file_key=? LIMIT 1`,
                [tenantId, request.fileKey],
            );
            if (byKey) return byKey;
        }
        return dataAccess.queryOne<ImportBatchRow>(
            `SELECT id,imported_count,updated_count,skipped_count,rejected_count
             FROM student_import_batches WHERE tenant_id=? AND file_hash=? LIMIT 1`,
            [tenantId, hash],
        );
    };

    const idempotentBody = (batch: ImportBatchRow) => ({
        import_id: batch.id,
        idempotent: true,
        imported_count: batch.imported_count,
        updated_count: batch.updated_count,
        skipped_count: batch.skipped_count,
        rejected_count: batch.rejected_count,
    });

    // -----------------------------------------------------------------------
    // Preview (no writes)
    // -----------------------------------------------------------------------
    router.post('/preview', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const request = readCommitRequest(req, res);
            if (!request) return;
            if (request.branchId && !(await branchInTenant(scope.tenantId, request.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            const analyzed = await analyzeStudentCsv(request.csv, existingStudentLookup(scope.tenantId));
            if (!analyzed.ok) return res.status(400).json({ error: analyzed.error });
            const { analysis } = analyzed;
            res.json({
                headers: analysis.headers,
                valid_count: analysis.rows.length,
                rejected_count: analysis.rejected.length,
                duplicate_count: analysis.duplicates.length,
                duplicates: analysis.duplicates,
                rejected: analysis.rejected,
            });
        } catch (error) {
            console.error('Preview student import error:', error);
            res.status(500).json({ error: 'Failed to preview import' });
        }
    });

    // -----------------------------------------------------------------------
    // Commit (idempotent, audited)
    // -----------------------------------------------------------------------
    router.post('/commit', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const request = readCommitRequest(req, res);
            if (!request) return;
            if (request.branchId && !(await branchInTenant(scope.tenantId, request.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            const hash = hashCsv(request.csv);
            const existingBatch = await loadExistingBatch(db, scope.tenantId, request, hash);
            if (existingBatch) return res.status(200).json(idempotentBody(existingBatch));

            const analyzed = await analyzeStudentCsv(request.csv, existingStudentLookup(scope.tenantId));
            if (!analyzed.ok) return res.status(400).json({ error: analyzed.error });
            const { analysis } = analyzed;
            const planned = planImport(analysis, request.resolution);
            if (!planned.ok) return res.status(409).json({ error: planned.error });
            const { plan } = planned;

            const importId = randomUUID();
            const outcome = await runAtomic(async (tx) => {
                const raced = await loadExistingBatch(tx, scope.tenantId, request, hash);
                if (raced) return idempotentBody(raced);

                try {
                    await tx.execute(
                        `INSERT INTO student_import_batches
                           (id,tenant_id,branch_id,file_hash,file_key,status,headers,row_count,
                            imported_count,updated_count,skipped_count,rejected_count,rejected_rows,created_by)
                         VALUES (?,?,?,?,?, 'committed', ?,?,?,?,?,?,?,?)`,
                        [
                            importId, scope.tenantId, request.branchId, hash, request.fileKey,
                            JSON.stringify(analysis.headers), analysis.rows.length + analysis.rejected.length,
                            plan.toInsert.length, plan.toUpdate.length, plan.skipped.length,
                            analysis.rejected.length, JSON.stringify(analysis.rejected), scope.userId,
                        ],
                    );
                } catch (error) {
                    if (isDuplicateEntryError(error)) {
                        const existing = await loadExistingBatch(tx, scope.tenantId, request, hash);
                        if (existing) return idempotentBody(existing);
                    }
                    throw error;
                }

                for (const row of plan.toInsert) {
                    await tx.execute(
                        `INSERT INTO students
                           (id,tenant_id,instructor_id,name,phone,email,grade,parent_phone,notes,approval_status,is_active)
                         VALUES (?,?,?,?,?,?,?,?,?, 'approved', 1)`,
                        [
                            randomUUID(), scope.tenantId, scope.userId, row.name,
                            row.phone, row.email, row.grade, row.parentPhone, row.notes,
                        ],
                    );
                }
                for (const row of plan.toUpdate) {
                    await tx.execute(
                        `UPDATE students
                         SET name=?, grade=?, parent_phone=?, notes=?, updated_at=CURRENT_TIMESTAMP
                         WHERE tenant_id=? AND (phone=? OR email=?)`,
                        [
                            row.name, row.grade, row.parentPhone, row.notes,
                            scope.tenantId, row.phone ? row.phone.replace(/[\\s()\\-]/g, '') : null, row.email,
                        ],
                    );
                }
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'student_import.commit',
                    resourceType: 'student_import_batch',
                    resourceId: importId,
                    newValue: {
                        branch_id: request.branchId,
                        file_hash: hash,
                        file_key: request.fileKey,
                        imported_count: plan.toInsert.length,
                        updated_count: plan.toUpdate.length,
                        skipped_count: plan.skipped.length,
                        rejected_count: analysis.rejected.length,
                        duplicate_resolution: request.resolution,
                    },
                });
                return {
                    import_id: importId,
                    idempotent: false,
                    imported_count: plan.toInsert.length,
                    updated_count: plan.toUpdate.length,
                    skipped_count: plan.skipped.length,
                    rejected_count: analysis.rejected.length,
                };
            });
            res.status(201).json(outcome);
        } catch (error) {
            console.error('Commit student import error:', error);
            res.status(500).json({ error: 'Failed to import students' });
        }
    });

    // -----------------------------------------------------------------------
    // Batch history + rejected-row report export
    // -----------------------------------------------------------------------
    router.get('/batches', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const rows = await db.query(
                `SELECT id,branch_id,file_hash,file_key,status,row_count,
                        imported_count,updated_count,skipped_count,rejected_count,created_at
                 FROM student_import_batches WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`,
                [scope.tenantId],
            );
            res.json(rows);
        } catch (error) {
            console.error('List student imports error:', error);
            res.status(500).json({ error: 'Failed to list imports' });
        }
    });

    router.get('/batches/:id/report.csv', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const id = req.params.id;
            const batch = await db.queryOne<ImportBatchRow>(
                `SELECT id,tenant_id,file_hash,headers,rejected_rows
                 FROM student_import_batches WHERE id=? AND tenant_id=? LIMIT 1`,
                [id, scope.tenantId],
            );
            if (!batch) return res.status(404).json({ error: 'Import not found' });
            const headers = parseJsonStringArray(batch.headers);
            const rejected = parseJsonArray(batch.rejected_rows);
            const csv = toRejectedReportCsv(rejected, headers);
            await recordAudit(db.execute, {
                actorUserId: scope.userId,
                tenantId: scope.tenantId,
                action: 'student_import.report_exported',
                resourceType: 'student_import_batch',
                resourceId: batch.id,
                newValue: { rejected_count: rejected.length },
            });
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="import-${batch.id}-rejected.csv"`);
            res.send(csv);
        } catch (error) {
            console.error('Student import report error:', error);
            res.status(500).json({ error: 'Failed to build report' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real tenant authority. */

const TENANT_AUTHORITY_SQL = `
    SELECT 'owner' AS authority
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
    LIMIT 1
`;

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: StudentImportDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};

export default createStudentImportRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    transaction: async <T>(fn: (tx: StudentImportDataAccess) => Promise<T>) => {
        const { withTransaction } = await loadDb();
        return withTransaction(async (connection) => {
            const tx: StudentImportDataAccess = {
                query: async <U = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                    const [rows] = await connection.execute(sql, params as never);
                    return rows as U[];
                },
                queryOne: async <U = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                    const [rows] = await connection.execute(sql, params as never);
                    const list = rows as U[];
                    return list.length > 0 ? list[0] : null;
                },
                execute: async (sql: string, params?: unknown[]) => {
                    const [result] = await connection.execute(sql, params as never);
                    return result as { insertId?: number; affectedRows?: number };
                },
            };
            return fn(tx);
        });
    },
});
