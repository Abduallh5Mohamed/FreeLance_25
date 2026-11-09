"use strict";
/**
 * M4 A1 — reusable, tenant-owned question bank routes.
 *
 * Authority and scope are server-derived only:
 *  - the tenant is the principal's verified selected tenant; a client-supplied
 *    tenant is never evidence of membership (and is rejected upstream by the
 *    `/api` guard chain);
 *  - a branch target must exist, be active and belong to that tenant, and a
 *    non-owner instructor must hold a live membership in it;
 *  - every read/write carries `tenant_id = <principal tenant>` so reuse can
 *    never leak across tenants, and a branch question is hidden from a staff
 *    member who is not owner and not in that branch.
 *
 * Content is append-only: each edit writes a new immutable version. A version
 * referenced by a published exam is locked, so an in-place edit is refused.
 * Archive is a soft flag; import/export are tenant-scoped and audited.
 *
 * Exports `createQuestionBankRouter(deps)` and a default-wired router instance
 * (real pool/auth/authority) so a later mounting task can `app.use` it. This
 * module never mounts itself and never runs DDL.
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
exports.createQuestionBankRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const audit_1 = require("../security/audit");
const question_bank_1 = require("../services/question-bank");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
function parseJsonArray(value) {
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
const QUESTION_COLUMNS = 'id,tenant_id,branch_id,branch_scope,question_type,question_text,options,correct_answers,points,explanation,tags,current_version,archived_at,version';
const createQuestionBankRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
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
        return {
            tenantId,
            userId: user.id,
            isOwner: authority.authority === 'owner',
            branchId: user.branchId ?? null,
        };
    };
    const branchInTenant = async (tenantId, branchId) => {
        const row = await db.queryOne('SELECT id, status FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1', [branchId, tenantId]);
        return Boolean(row && row.status === 'active');
    };
    /**
     * Non-owner branch authority: a branch-scoped question requires the caller
     * to hold a live membership in that branch. A tenant owner keeps their
     * narrow owner path inside their own tenant.
     */
    const authorizeBranchResource = async (scope, branchId) => {
        if (scope.isOwner)
            return true;
        const membership = await db.queryOne(`SELECT status FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1`, [branchId, scope.userId]);
        return Boolean(membership && membership.status === 'active');
    };
    const loadQuestionForStaff = async (scope, questionId) => {
        const visibility = (0, question_bank_1.buildQuestionVisibilityFilter)({
            tenantId: scope.tenantId,
            branchId: scope.branchId,
            isOwner: scope.isOwner,
        });
        return db.queryOne(`SELECT ${QUESTION_COLUMNS} FROM question_bank_questions
             WHERE id = ? AND tenant_id = ? AND ${visibility.sql} LIMIT 1`, [questionId, scope.tenantId, ...visibility.params]);
    };
    const projectQuestion = (row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        branch_scope: row.branch_scope,
        question_type: row.question_type,
        question_text: row.question_text,
        options: parseJsonArray(row.options),
        correct_answers: parseJsonArray(row.correct_answers),
        points: Number(row.points),
        explanation: row.explanation,
        tags: parseJsonArray(row.tags),
        current_version: Number(row.current_version),
        archived: row.archived_at !== null && row.archived_at !== undefined,
    });
    const insertVersion = async (tx, scope, questionId, version, value) => {
        await tx.execute(`INSERT INTO question_bank_versions
               (id,question_id,tenant_id,version,question_type,question_text,options,correct_answers,points,explanation,tags,created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
            (0, crypto_1.randomUUID)(), questionId, scope.tenantId, version, value.questionType, value.questionText,
            JSON.stringify(value.options), JSON.stringify(value.correctAnswers), value.points,
            value.explanation, JSON.stringify(value.tags), scope.userId,
        ]);
    };
    const insertQuestion = async (tx, scope, questionId, value) => {
        await tx.execute(`INSERT INTO question_bank_questions
               (id,tenant_id,branch_id,branch_scope,question_type,question_text,options,correct_answers,points,explanation,tags,current_version,created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            questionId, scope.tenantId, value.branchId, value.branchScope, value.questionType, value.questionText,
            JSON.stringify(value.options), JSON.stringify(value.correctAnswers), value.points,
            value.explanation, JSON.stringify(value.tags), 1, scope.userId,
        ]);
        await insertVersion(tx, scope, questionId, 1, value);
    };
    // -----------------------------------------------------------------------
    // GET /questions — staff list (tenant, branch-visible)
    // -----------------------------------------------------------------------
    router.get('/questions', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const visibility = (0, question_bank_1.buildQuestionVisibilityFilter)({
                tenantId: scope.tenantId,
                branchId: scope.branchId,
                isOwner: scope.isOwner,
            });
            const params = [scope.tenantId, ...visibility.params];
            let sql = `SELECT ${QUESTION_COLUMNS} FROM question_bank_questions
                       WHERE tenant_id = ? AND ${visibility.sql}`;
            const rawType = req.query.question_type;
            if (rawType !== undefined && rawType !== '') {
                const kind = typeof rawType === 'string' && rawType ? rawType : null;
                if (!kind)
                    return res.status(400).json({ error: 'Invalid question_type filter' });
                sql += ' AND question_type = ?';
                params.push(kind);
            }
            const rawTag = req.query.tag;
            if (rawTag !== undefined && rawTag !== '') {
                if (typeof rawTag !== 'string' || rawTag.trim() === '' || rawTag.length > 64) {
                    return res.status(400).json({ error: 'Invalid tag filter' });
                }
                sql += ' AND JSON_CONTAINS(tags, JSON_QUOTE(?))';
                params.push(rawTag.trim().toLowerCase());
            }
            if (req.query.include_archived !== 'true')
                sql += ' AND archived_at IS NULL';
            sql += ' ORDER BY updated_at DESC LIMIT 200';
            res.json((await db.query(sql, params)).map(projectQuestion));
        }
        catch (error) {
            console.error('List question bank error:', error);
            res.status(500).json({ error: 'Failed to list questions' });
        }
    });
    // -----------------------------------------------------------------------
    // POST /questions — create (audited)
    // -----------------------------------------------------------------------
    router.post('/questions', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const validated = (0, question_bank_1.validateQuestionInput)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            if (validated.value.branchId && !(await branchInTenant(scope.tenantId, validated.value.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            if (validated.value.branchId && !(await authorizeBranchResource(scope, validated.value.branchId))) {
                return res.status(403).json({ error: 'Branch membership required' });
            }
            const id = (0, crypto_1.randomUUID)();
            await runAtomic(async (tx) => {
                await insertQuestion(tx, scope, id, validated.value);
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.question.create',
                    resourceType: 'question',
                    resourceId: id,
                    newValue: (0, audit_1.snapshotRow)({
                        question_type: validated.value.questionType,
                        branch_scope: validated.value.branchScope,
                        branch_id: validated.value.branchId,
                        tags: validated.value.tags,
                    }),
                });
            });
            res.status(201).json({ id, current_version: 1, question_type: validated.value.questionType });
        }
        catch (error) {
            console.error('Create question bank question error:', error);
            res.status(500).json({ error: 'Failed to create question' });
        }
    });
    // -----------------------------------------------------------------------
    // GET /questions/:id — staff read with version chain
    // -----------------------------------------------------------------------
    router.get('/questions/:id', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const questionId = (0, question_bank_1.normalizeId)(req.params.id);
            if (!questionId)
                return res.status(404).json({ error: 'Question not found' });
            const question = await loadQuestionForStaff(scope, questionId);
            if (!question)
                return res.status(404).json({ error: 'Question not found' });
            const versions = await db.query(`SELECT version, created_at FROM question_bank_versions
                 WHERE question_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`, [questionId, scope.tenantId]);
            res.json({ ...projectQuestion(question), versions });
        }
        catch (error) {
            console.error('Read question bank question error:', error);
            res.status(500).json({ error: 'Failed to load question' });
        }
    });
    // -----------------------------------------------------------------------
    // GET /questions/:id/versions — staff version history
    // -----------------------------------------------------------------------
    router.get('/questions/:id/versions', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const questionId = (0, question_bank_1.normalizeId)(req.params.id);
            if (!questionId)
                return res.status(404).json({ error: 'Question not found' });
            if (!(await loadQuestionForStaff(scope, questionId))) {
                return res.status(404).json({ error: 'Question not found' });
            }
            res.json(await db.query(`SELECT version, question_type, question_text, points, created_at FROM question_bank_versions
                 WHERE question_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`, [questionId, scope.tenantId]));
        }
        catch (error) {
            console.error('List question bank versions error:', error);
            res.status(500).json({ error: 'Failed to list versions' });
        }
    });
    // -----------------------------------------------------------------------
    // PATCH /questions/:id — append a new version (one used by a published
    // exam is immutable and refused)
    // -----------------------------------------------------------------------
    router.patch('/questions/:id', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const questionId = (0, question_bank_1.normalizeId)(req.params.id);
            if (!questionId)
                return res.status(404).json({ error: 'Question not found' });
            const existing = await loadQuestionForStaff(scope, questionId);
            if (!existing)
                return res.status(404).json({ error: 'Question not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'An archived question cannot be edited' });
            }
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {});
            const merged = {
                question_text: body['question_text'] ?? existing.question_text,
                question_type: body['question_type'] ?? existing.question_type,
                options: body['options'] ?? parseJsonArray(existing.options),
                correct_answers: body['correct_answers'] ?? parseJsonArray(existing.correct_answers),
                points: body['points'] ?? existing.points,
                explanation: body['explanation'] ?? existing.explanation,
                tags: body['tags'] ?? parseJsonArray(existing.tags),
                branch_scope: body['branch_scope'] ?? existing.branch_scope,
                branch_id: body['branch_id'] ?? existing.branch_id,
            };
            const validated = (0, question_bank_1.validateQuestionInput)(merged);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            if (validated.value.branchId && !(await branchInTenant(scope.tenantId, validated.value.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            if (validated.value.branchId && !(await authorizeBranchResource(scope, validated.value.branchId))) {
                return res.status(403).json({ error: 'Branch membership required' });
            }
            const nextVersion = Number(existing.current_version) + 1;
            const result = await runAtomic(async (tx) => {
                // Version-lock usage check inside the same atomic section as the
                // append. SELECT ... FOR UPDATE takes gap/row locks on that
                // (tenant, question, version) range so a concurrent exam publish
                // that would begin referencing the current version serializes
                // here instead of slipping between check and append (TOCTOU).
                const usages = await tx.query(`SELECT exam_published FROM question_bank_version_usages
                     WHERE question_id = ? AND tenant_id = ? AND version = ? FOR UPDATE`, [questionId, scope.tenantId, existing.current_version]);
                if ((0, question_bank_1.isVersionLocked)(usages.map((usage) => ({ examPublished: Boolean(usage.exam_published) })))) {
                    return { kind: 'locked' };
                }
                const updated = await tx.execute(`UPDATE question_bank_questions
                     SET question_type=?, question_text=?, options=?, correct_answers=?, points=?, explanation=?,
                         tags=?, branch_scope=?, branch_id=?, current_version=?, version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND current_version=? AND archived_at IS NULL`, [
                    validated.value.questionType, validated.value.questionText, JSON.stringify(validated.value.options),
                    JSON.stringify(validated.value.correctAnswers), validated.value.points, validated.value.explanation,
                    JSON.stringify(validated.value.tags), validated.value.branchScope, validated.value.branchId,
                    nextVersion, questionId, scope.tenantId, existing.current_version,
                ]);
                if (updated.affectedRows === 0)
                    return { kind: 'conflict' };
                await insertVersion(tx, scope, questionId, nextVersion, validated.value);
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.question.version',
                    resourceType: 'question',
                    resourceId: questionId,
                    oldValue: (0, audit_1.snapshotRow)({ current_version: existing.current_version }),
                    newValue: (0, audit_1.snapshotRow)({ current_version: nextVersion }),
                });
                return { kind: 'ok' };
            });
            if (result.kind === 'locked') {
                return res.status(409).json({ error: 'This version is used by a published exam and is immutable' });
            }
            if (result.kind === 'conflict') {
                return res.status(409).json({ error: 'Question changed concurrently' });
            }
            res.json({ id: questionId, current_version: nextVersion });
        }
        catch (error) {
            console.error('Update question bank question error:', error);
            res.status(500).json({ error: 'Failed to update question' });
        }
    });
    // -----------------------------------------------------------------------
    // POST /questions/:id/archive — soft archive (audited)
    // -----------------------------------------------------------------------
    router.post('/questions/:id/archive', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const questionId = (0, question_bank_1.normalizeId)(req.params.id);
            if (!questionId)
                return res.status(404).json({ error: 'Question not found' });
            const existing = await loadQuestionForStaff(scope, questionId);
            if (!existing)
                return res.status(404).json({ error: 'Question not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'Question is already archived' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(`UPDATE question_bank_questions
                     SET archived_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND archived_at IS NULL`, [questionId, scope.tenantId]);
                if (updated.affectedRows === 0)
                    return false;
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.question.archive',
                    resourceType: 'question',
                    resourceId: questionId,
                    oldValue: (0, audit_1.snapshotRow)({ archived: false }),
                    newValue: (0, audit_1.snapshotRow)({ archived: true }),
                });
                return true;
            });
            if (!result)
                return res.status(409).json({ error: 'Question changed concurrently' });
            res.json({ id: questionId, archived: true });
        }
        catch (error) {
            console.error('Archive question bank question error:', error);
            res.status(500).json({ error: 'Failed to archive question' });
        }
    });
    // -----------------------------------------------------------------------
    // GET /export — tenant-scoped, branch-visible export (audited)
    // -----------------------------------------------------------------------
    router.get('/export', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const visibility = (0, question_bank_1.buildQuestionVisibilityFilter)({
                tenantId: scope.tenantId,
                branchId: scope.branchId,
                isOwner: scope.isOwner,
            });
            const rows = await db.query(`SELECT ${QUESTION_COLUMNS} FROM question_bank_questions
                 WHERE tenant_id = ? AND ${visibility.sql} ORDER BY updated_at DESC LIMIT 500`, [scope.tenantId, ...visibility.params]);
            const entries = rows.map((row) => ({
                id: row.id,
                question_type: row.question_type,
                question_text: row.question_text,
                options: parseJsonArray(row.options),
                correct_answers: parseJsonArray(row.correct_answers),
                points: Number(row.points),
                explanation: row.explanation,
                tags: parseJsonArray(row.tags),
                branch_scope: row.branch_scope,
                branch_id: row.branch_id,
                current_version: Number(row.current_version),
                archived: row.archived_at !== null && row.archived_at !== undefined,
            }));
            await (0, audit_1.recordAudit)(db.execute, {
                actorUserId: scope.userId,
                tenantId: scope.tenantId,
                action: 'question_bank.export',
                resourceType: 'question_bank',
                resourceId: scope.tenantId,
                newValue: (0, audit_1.snapshotRow)({ count: entries.length }),
            });
            res.json({ format_version: question_bank_1.QUESTION_EXPORT_FORMAT_VERSION, questions: entries });
        }
        catch (error) {
            console.error('Export question bank error:', error);
            res.status(500).json({ error: 'Failed to export questions' });
        }
    });
    // -----------------------------------------------------------------------
    // POST /import — tenant-forced, validated, audited
    // -----------------------------------------------------------------------
    router.post('/import', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const validated = (0, question_bank_1.validateQuestionImportPayload)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            for (const question of validated.value) {
                if (question.branchId && !(await branchInTenant(scope.tenantId, question.branchId))) {
                    return res.status(403).json({ error: 'Branch is outside this tenant' });
                }
                if (question.branchId && !(await authorizeBranchResource(scope, question.branchId))) {
                    return res.status(403).json({ error: 'Branch membership required' });
                }
            }
            const ids = [];
            await runAtomic(async (tx) => {
                for (const question of validated.value) {
                    const id = (0, crypto_1.randomUUID)();
                    await insertQuestion(tx, scope, id, question);
                    ids.push(id);
                }
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.import',
                    resourceType: 'question_bank',
                    resourceId: scope.tenantId,
                    newValue: (0, audit_1.snapshotRow)({ imported: ids.length }),
                });
            });
            res.status(201).json({ imported: ids.length, ids });
        }
        catch (error) {
            console.error('Import question bank error:', error);
            res.status(500).json({ error: 'Failed to import questions' });
        }
    });
    return router;
};
exports.createQuestionBankRouter = createQuestionBankRouter;
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
/**
 * Production atomic seam. Every multi-statement write (head row + version row
 * + audit, and the version-lock read that must serialize against a concurrent
 * exam publish) is composed through this one pooled connection: a failure
 * rolls the whole block back, and `SELECT ... FOR UPDATE` holds its lock for
 * the duration instead of being released at statement end in autocommit.
 */
const productionTransaction = async (fn) => {
    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
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
            const affectedRows = header.affectedRows;
            if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                throw new Error('question-bank transaction execute did not report a usable affected-row count');
            }
            return { insertId: typeof header.insertId === 'number' && Number.isSafeInteger(header.insertId) ? header.insertId : 0, affectedRows };
        },
    }));
};
exports.default = (0, exports.createQuestionBankRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    transaction: productionTransaction,
});
