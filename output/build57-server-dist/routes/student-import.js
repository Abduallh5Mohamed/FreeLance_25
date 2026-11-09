"use strict";
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
exports.createStudentImportRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const audit_1 = require("../security/audit");
const lesson_progress_1 = require("../services/lesson-progress");
const student_csv_import_1 = require("../services/student-csv-import");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
const MAX_FILE_KEY_LENGTH = 120;
function parseJsonArray(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function parseJsonStringArray(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
    }
    catch {
        return [];
    }
}
const createStudentImportRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    const hashCsv = deps.hashCsv ?? student_csv_import_1.hashCsvContent;
    const runAtomic = deps.transaction
        ? deps.transaction
        : (fn) => fn(db);
    router.use(deps.authenticate);
    const resolveStaffScope = async (req, res) => {
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
    const branchInTenant = async (tenantId, branchId) => {
        const row = await db.queryOne('SELECT id, status FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1', [branchId, tenantId]);
        return Boolean(row && row.status === 'active');
    };
    const existingStudentLookup = (tenantId) => async ({ phone, email }) => {
        const clauses = [];
        const params = [tenantId];
        if (phone) {
            clauses.push('phone=?');
            params.push(phone.replace(/[\s()\-]/g, ''));
        }
        if (email) {
            clauses.push('email=?');
            params.push(email.toLowerCase());
        }
        if (clauses.length === 0)
            return false;
        const row = await db.queryOne(`SELECT id FROM students WHERE tenant_id=? AND (${clauses.join(' OR ')}) LIMIT 1`, params);
        return Boolean(row);
    };
    const readCommitRequest = (req, res) => {
        const body = (typeof req.body === 'object' && req.body !== null ? req.body : {});
        const csv = body['csv'];
        if (typeof csv !== 'string' || csv.trim() === '') {
            res.status(400).json({ error: 'csv is required' });
            return null;
        }
        let branchId = null;
        const rawBranch = body['branch_id'];
        if (rawBranch !== undefined && rawBranch !== null && rawBranch !== '') {
            if (typeof rawBranch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rawBranch.trim())) {
                res.status(400).json({ error: 'branch_id is invalid' });
                return null;
            }
            branchId = rawBranch.trim();
        }
        let fileKey = null;
        const rawKey = body['file_key'];
        if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
            if (typeof rawKey !== 'string' || rawKey.trim() === '' || rawKey.trim().length > MAX_FILE_KEY_LENGTH) {
                res.status(400).json({ error: 'file_key is invalid' });
                return null;
            }
            fileKey = rawKey.trim();
        }
        return { csv, branchId, fileKey, resolution: (0, student_csv_import_1.normalizeDuplicateResolution)(body['duplicate_resolution']) };
    };
    const loadExistingBatch = async (dataAccess, tenantId, request, hash) => {
        if (request.fileKey) {
            const byKey = await dataAccess.queryOne(`SELECT id,imported_count,updated_count,skipped_count,rejected_count
                 FROM student_import_batches WHERE tenant_id=? AND file_key=? LIMIT 1`, [tenantId, request.fileKey]);
            if (byKey)
                return byKey;
        }
        return dataAccess.queryOne(`SELECT id,imported_count,updated_count,skipped_count,rejected_count
             FROM student_import_batches WHERE tenant_id=? AND file_hash=? LIMIT 1`, [tenantId, hash]);
    };
    const idempotentBody = (batch) => ({
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
    router.post('/preview', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const request = readCommitRequest(req, res);
            if (!request)
                return;
            if (request.branchId && !(await branchInTenant(scope.tenantId, request.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            const analyzed = await (0, student_csv_import_1.analyzeStudentCsv)(request.csv, existingStudentLookup(scope.tenantId));
            if (!analyzed.ok)
                return res.status(400).json({ error: analyzed.error });
            const { analysis } = analyzed;
            res.json({
                headers: analysis.headers,
                valid_count: analysis.rows.length,
                rejected_count: analysis.rejected.length,
                duplicate_count: analysis.duplicates.length,
                duplicates: analysis.duplicates,
                rejected: analysis.rejected,
            });
        }
        catch (error) {
            console.error('Preview student import error:', error);
            res.status(500).json({ error: 'Failed to preview import' });
        }
    });
    // -----------------------------------------------------------------------
    // Commit (idempotent, audited)
    // -----------------------------------------------------------------------
    router.post('/commit', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const request = readCommitRequest(req, res);
            if (!request)
                return;
            if (request.branchId && !(await branchInTenant(scope.tenantId, request.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            const hash = hashCsv(request.csv);
            const existingBatch = await loadExistingBatch(db, scope.tenantId, request, hash);
            if (existingBatch)
                return res.status(200).json(idempotentBody(existingBatch));
            const analyzed = await (0, student_csv_import_1.analyzeStudentCsv)(request.csv, existingStudentLookup(scope.tenantId));
            if (!analyzed.ok)
                return res.status(400).json({ error: analyzed.error });
            const { analysis } = analyzed;
            const planned = (0, student_csv_import_1.planImport)(analysis, request.resolution);
            if (!planned.ok)
                return res.status(409).json({ error: planned.error });
            const { plan } = planned;
            const importId = (0, crypto_1.randomUUID)();
            const outcome = await runAtomic(async (tx) => {
                const raced = await loadExistingBatch(tx, scope.tenantId, request, hash);
                if (raced)
                    return idempotentBody(raced);
                try {
                    await tx.execute(`INSERT INTO student_import_batches
                           (id,tenant_id,branch_id,file_hash,file_key,status,headers,row_count,
                            imported_count,updated_count,skipped_count,rejected_count,rejected_rows,created_by)
                         VALUES (?,?,?,?,?, 'committed', ?,?,?,?,?,?,?,?)`, [
                        importId, scope.tenantId, request.branchId, hash, request.fileKey,
                        JSON.stringify(analysis.headers), analysis.rows.length + analysis.rejected.length,
                        plan.toInsert.length, plan.toUpdate.length, plan.skipped.length,
                        analysis.rejected.length, JSON.stringify(analysis.rejected), scope.userId,
                    ]);
                }
                catch (error) {
                    if ((0, lesson_progress_1.isDuplicateEntryError)(error)) {
                        const existing = await loadExistingBatch(tx, scope.tenantId, request, hash);
                        if (existing)
                            return idempotentBody(existing);
                    }
                    throw error;
                }
                for (const row of plan.toInsert) {
                    await tx.execute(`INSERT INTO students
                           (id,tenant_id,instructor_id,name,phone,email,grade,parent_phone,notes,approval_status,is_active)
                         VALUES (?,?,?,?,?,?,?,?,?, 'approved', 1)`, [
                        (0, crypto_1.randomUUID)(), scope.tenantId, scope.userId, row.name,
                        row.phone, row.email, row.grade, row.parentPhone, row.notes,
                    ]);
                }
                for (const row of plan.toUpdate) {
                    await tx.execute(`UPDATE students
                         SET name=?, grade=?, parent_phone=?, notes=?, updated_at=CURRENT_TIMESTAMP
                         WHERE tenant_id=? AND (phone=? OR email=?)`, [
                        row.name, row.grade, row.parentPhone, row.notes,
                        scope.tenantId, row.phone ? row.phone.replace(/[\\s()\\-]/g, '') : null, row.email,
                    ]);
                }
                await (0, audit_1.recordAudit)(tx.execute, {
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
            res.status(outcome.idempotent ? 200 : 201).json(outcome);
        }
        catch (error) {
            console.error('Commit student import error:', error);
            res.status(500).json({ error: 'Failed to import students' });
        }
    });
    // -----------------------------------------------------------------------
    // Batch history + rejected-row report export
    // -----------------------------------------------------------------------
    router.get('/batches', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const rows = await db.query(`SELECT id,branch_id,file_hash,file_key,status,row_count,
                        imported_count,updated_count,skipped_count,rejected_count,created_at
                 FROM student_import_batches WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`, [scope.tenantId]);
            res.json(rows);
        }
        catch (error) {
            console.error('List student imports error:', error);
            res.status(500).json({ error: 'Failed to list imports' });
        }
    });
    router.get('/batches/:id/report.csv', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const id = req.params.id;
            const batch = await db.queryOne(`SELECT id,tenant_id,file_hash,headers,rejected_rows
                 FROM student_import_batches WHERE id=? AND tenant_id=? LIMIT 1`, [id, scope.tenantId]);
            if (!batch)
                return res.status(404).json({ error: 'Import not found' });
            const headers = parseJsonStringArray(batch.headers);
            const rejected = parseJsonArray(batch.rejected_rows);
            const csv = (0, student_csv_import_1.toRejectedReportCsv)(rejected, headers);
            await (0, audit_1.recordAudit)(db.execute, {
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
        }
        catch (error) {
            console.error('Student import report error:', error);
            res.status(500).json({ error: 'Failed to build report' });
        }
    });
    return router;
};
exports.createStudentImportRouter = createStudentImportRouter;
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
};
const loadActiveTenantAuthority = async (userId, tenantId) => {
    const { queryOne } = await loadDb();
    return queryOne(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};
exports.default = (0, exports.createStudentImportRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
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
});
