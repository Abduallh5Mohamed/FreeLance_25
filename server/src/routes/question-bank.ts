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

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import {
    QuestionKind,
    QUESTION_EXPORT_FORMAT_VERSION,
    ValidatedQuestion,
    buildQuestionVisibilityFilter,
    isVersionLocked,
    normalizeId,
    validateQuestionImportPayload,
    validateQuestionInput,
} from '../services/question-bank';

export interface QuestionBankDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface QuestionBankDeps {
    db: QuestionBankDataAccess;
    authenticate: RequestHandler;
    /** Server-owned active authority of the principal inside the selected tenant. */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /** Optional atomic seam; production supplies a pooled transaction. */
    transaction?: <T>(fn: (tx: QuestionBankDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface QuestionRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    branch_scope: string;
    question_type: string;
    question_text: string;
    options: string | null;
    correct_answers: string | null;
    points: number | string;
    explanation: string | null;
    tags: string | null;
    current_version: number;
    archived_at: string | Date | null;
    version: number;
}

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}

function parseJsonArray(value: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
}

const QUESTION_COLUMNS =
    'id,tenant_id,branch_id,branch_scope,question_type,question_text,options,correct_answers,points,explanation,tags,current_version,archived_at,version';

export const createQuestionBankRouter = (deps: QuestionBankDeps): Router => {
    const router = Router();
    const { db } = deps;
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: QuestionBankDataAccess) => Promise<T>): Promise<T> => fn(db);

    router.use(deps.authenticate);

    const resolveStaffScope = async (req: AuthRequest, res: Response): Promise<StaffScope | null> => {
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

    const branchInTenant = async (tenantId: string, branchId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; status: string }>(
            'SELECT id, status FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1',
            [branchId, tenantId],
        );
        return Boolean(row && row.status === 'active');
    };

    /**
     * Non-owner branch authority: a branch-scoped question requires the caller
     * to hold a live membership in that branch. A tenant owner keeps their
     * narrow owner path inside their own tenant.
     */
    const authorizeBranchResource = async (scope: StaffScope, branchId: string): Promise<boolean> => {
        if (scope.isOwner) return true;
        const membership = await db.queryOne<{ status: string }>(
            `SELECT status FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1`,
            [branchId, scope.userId],
        );
        return Boolean(membership && membership.status === 'active');
    };

    const loadQuestionForStaff = async (scope: StaffScope, questionId: string): Promise<QuestionRow | null> => {
        const visibility = buildQuestionVisibilityFilter({
            tenantId: scope.tenantId,
            branchId: scope.branchId,
            isOwner: scope.isOwner,
        });
        return db.queryOne<QuestionRow>(
            `SELECT ${QUESTION_COLUMNS} FROM question_bank_questions
             WHERE id = ? AND tenant_id = ? AND ${visibility.sql} LIMIT 1`,
            [questionId, scope.tenantId, ...visibility.params],
        );
    };

    const projectQuestion = (row: QuestionRow) => ({
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

    const insertVersion = async (
        tx: QuestionBankDataAccess,
        scope: StaffScope,
        questionId: string,
        version: number,
        value: ValidatedQuestion,
    ): Promise<void> => {
        await tx.execute(
            `INSERT INTO question_bank_versions
               (id,question_id,tenant_id,version,question_type,question_text,options,correct_answers,points,explanation,tags,created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                randomUUID(), questionId, scope.tenantId, version, value.questionType, value.questionText,
                JSON.stringify(value.options), JSON.stringify(value.correctAnswers), value.points,
                value.explanation, JSON.stringify(value.tags), scope.userId,
            ],
        );
    };

    const insertQuestion = async (
        tx: QuestionBankDataAccess,
        scope: StaffScope,
        questionId: string,
        value: ValidatedQuestion,
    ): Promise<void> => {
        await tx.execute(
            `INSERT INTO question_bank_questions
               (id,tenant_id,branch_id,branch_scope,question_type,question_text,options,correct_answers,points,explanation,tags,current_version,created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                questionId, scope.tenantId, value.branchId, value.branchScope, value.questionType, value.questionText,
                JSON.stringify(value.options), JSON.stringify(value.correctAnswers), value.points,
                value.explanation, JSON.stringify(value.tags), 1, scope.userId,
            ],
        );
        await insertVersion(tx, scope, questionId, 1, value);
    };

    // -----------------------------------------------------------------------
    // GET /questions — staff list (tenant, branch-visible)
    // -----------------------------------------------------------------------
    router.get('/questions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const visibility = buildQuestionVisibilityFilter({
                tenantId: scope.tenantId,
                branchId: scope.branchId,
                isOwner: scope.isOwner,
            });
            const params: unknown[] = [scope.tenantId, ...visibility.params];
            let sql = `SELECT ${QUESTION_COLUMNS} FROM question_bank_questions
                       WHERE tenant_id = ? AND ${visibility.sql}`;
            const rawType = req.query.question_type;
            if (rawType !== undefined && rawType !== '') {
                const kind = typeof rawType === 'string' && rawType ? rawType : null;
                if (!kind) return res.status(400).json({ error: 'Invalid question_type filter' });
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
            if (req.query.include_archived !== 'true') sql += ' AND archived_at IS NULL';
            sql += ' ORDER BY updated_at DESC LIMIT 200';
            res.json((await db.query<QuestionRow>(sql, params)).map(projectQuestion));
        } catch (error) {
            console.error('List question bank error:', error);
            res.status(500).json({ error: 'Failed to list questions' });
        }
    });

    // -----------------------------------------------------------------------
    // POST /questions — create (audited)
    // -----------------------------------------------------------------------
    router.post('/questions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const validated = validateQuestionInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            if (validated.value.branchId && !(await branchInTenant(scope.tenantId, validated.value.branchId))) {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
            if (validated.value.branchId && !(await authorizeBranchResource(scope, validated.value.branchId))) {
                return res.status(403).json({ error: 'Branch membership required' });
            }
            const id = randomUUID();
            await runAtomic(async (tx) => {
                await insertQuestion(tx, scope, id, validated.value);
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.question.create',
                    resourceType: 'question',
                    resourceId: id,
                    newValue: snapshotRow({
                        question_type: validated.value.questionType,
                        branch_scope: validated.value.branchScope,
                        branch_id: validated.value.branchId,
                        tags: validated.value.tags,
                    }),
                });
            });
            res.status(201).json({ id, current_version: 1, question_type: validated.value.questionType });
        } catch (error) {
            console.error('Create question bank question error:', error);
            res.status(500).json({ error: 'Failed to create question' });
        }
    });

    // -----------------------------------------------------------------------
    // GET /questions/:id — staff read with version chain
    // -----------------------------------------------------------------------
    router.get('/questions/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const questionId = normalizeId(req.params.id);
            if (!questionId) return res.status(404).json({ error: 'Question not found' });
            const question = await loadQuestionForStaff(scope, questionId);
            if (!question) return res.status(404).json({ error: 'Question not found' });
            const versions = await db.query<{ version: number; created_at: string | Date }>(
                `SELECT version, created_at FROM question_bank_versions
                 WHERE question_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`,
                [questionId, scope.tenantId],
            );
            res.json({ ...projectQuestion(question), versions });
        } catch (error) {
            console.error('Read question bank question error:', error);
            res.status(500).json({ error: 'Failed to load question' });
        }
    });

    // -----------------------------------------------------------------------
    // GET /questions/:id/versions — staff version history
    // -----------------------------------------------------------------------
    router.get('/questions/:id/versions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const questionId = normalizeId(req.params.id);
            if (!questionId) return res.status(404).json({ error: 'Question not found' });
            if (!(await loadQuestionForStaff(scope, questionId))) {
                return res.status(404).json({ error: 'Question not found' });
            }
            res.json(await db.query(
                `SELECT version, question_type, question_text, points, created_at FROM question_bank_versions
                 WHERE question_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`,
                [questionId, scope.tenantId],
            ));
        } catch (error) {
            console.error('List question bank versions error:', error);
            res.status(500).json({ error: 'Failed to list versions' });
        }
    });

    // -----------------------------------------------------------------------
    // PATCH /questions/:id — append a new version (one used by a published
    // exam is immutable and refused)
    // -----------------------------------------------------------------------
    router.patch('/questions/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const questionId = normalizeId(req.params.id);
            if (!questionId) return res.status(404).json({ error: 'Question not found' });
            const existing = await loadQuestionForStaff(scope, questionId);
            if (!existing) return res.status(404).json({ error: 'Question not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'An archived question cannot be edited' });
            }
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            const merged: Record<string, unknown> = {
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
            const validated = validateQuestionInput(merged);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
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
                const usages = await tx.query<{ exam_published: boolean | number }>(
                    `SELECT exam_published FROM question_bank_version_usages
                     WHERE question_id = ? AND tenant_id = ? AND version = ? FOR UPDATE`,
                    [questionId, scope.tenantId, existing.current_version],
                );
                if (isVersionLocked(usages.map((usage) => ({ examPublished: Boolean(usage.exam_published) })))) {
                    return { kind: 'locked' as const };
                }
                const updated = await tx.execute(
                    `UPDATE question_bank_questions
                     SET question_type=?, question_text=?, options=?, correct_answers=?, points=?, explanation=?,
                         tags=?, branch_scope=?, branch_id=?, current_version=?, version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND current_version=? AND archived_at IS NULL`,
                    [
                        validated.value.questionType, validated.value.questionText, JSON.stringify(validated.value.options),
                        JSON.stringify(validated.value.correctAnswers), validated.value.points, validated.value.explanation,
                        JSON.stringify(validated.value.tags), validated.value.branchScope, validated.value.branchId,
                        nextVersion, questionId, scope.tenantId, existing.current_version,
                    ],
                );
                if ((updated.affectedRows ?? 0) === 0) return { kind: 'conflict' as const };
                await insertVersion(tx, scope, questionId, nextVersion, validated.value);
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.question.version',
                    resourceType: 'question',
                    resourceId: questionId,
                    oldValue: snapshotRow({ current_version: existing.current_version }),
                    newValue: snapshotRow({ current_version: nextVersion }),
                });
                return { kind: 'ok' as const };
            });
            if (result.kind === 'locked') {
                return res.status(409).json({ error: 'This version is used by a published exam and is immutable' });
            }
            if (result.kind === 'conflict') {
                return res.status(409).json({ error: 'Question changed concurrently' });
            }
            res.json({ id: questionId, current_version: nextVersion });
        } catch (error) {
            console.error('Update question bank question error:', error);
            res.status(500).json({ error: 'Failed to update question' });
        }
    });

    // -----------------------------------------------------------------------
    // POST /questions/:id/archive — soft archive (audited)
    // -----------------------------------------------------------------------
    router.post('/questions/:id/archive', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const questionId = normalizeId(req.params.id);
            if (!questionId) return res.status(404).json({ error: 'Question not found' });
            const existing = await loadQuestionForStaff(scope, questionId);
            if (!existing) return res.status(404).json({ error: 'Question not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'Question is already archived' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE question_bank_questions
                     SET archived_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND archived_at IS NULL`,
                    [questionId, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.question.archive',
                    resourceType: 'question',
                    resourceId: questionId,
                    oldValue: snapshotRow({ archived: false }),
                    newValue: snapshotRow({ archived: true }),
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Question changed concurrently' });
            res.json({ id: questionId, archived: true });
        } catch (error) {
            console.error('Archive question bank question error:', error);
            res.status(500).json({ error: 'Failed to archive question' });
        }
    });

    // -----------------------------------------------------------------------
    // GET /export — tenant-scoped, branch-visible export (audited)
    // -----------------------------------------------------------------------
    router.get('/export', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const visibility = buildQuestionVisibilityFilter({
                tenantId: scope.tenantId,
                branchId: scope.branchId,
                isOwner: scope.isOwner,
            });
            const rows = await db.query<QuestionRow>(
                `SELECT ${QUESTION_COLUMNS} FROM question_bank_questions
                 WHERE tenant_id = ? AND ${visibility.sql} ORDER BY updated_at DESC LIMIT 500`,
                [scope.tenantId, ...visibility.params],
            );
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
            await recordAudit(db.execute, {
                actorUserId: scope.userId,
                tenantId: scope.tenantId,
                action: 'question_bank.export',
                resourceType: 'question_bank',
                resourceId: scope.tenantId,
                newValue: snapshotRow({ count: entries.length }),
            });
            res.json({ format_version: QUESTION_EXPORT_FORMAT_VERSION, questions: entries });
        } catch (error) {
            console.error('Export question bank error:', error);
            res.status(500).json({ error: 'Failed to export questions' });
        }
    });

    // -----------------------------------------------------------------------
    // POST /import — tenant-forced, validated, audited
    // -----------------------------------------------------------------------
    router.post('/import', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const validated = validateQuestionImportPayload(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            for (const question of validated.value) {
                if (question.branchId && !(await branchInTenant(scope.tenantId, question.branchId))) {
                    return res.status(403).json({ error: 'Branch is outside this tenant' });
                }
                if (question.branchId && !(await authorizeBranchResource(scope, question.branchId))) {
                    return res.status(403).json({ error: 'Branch membership required' });
                }
            }
            const ids: string[] = [];
            await runAtomic(async (tx) => {
                for (const question of validated.value) {
                    const id = randomUUID();
                    await insertQuestion(tx, scope, id, question);
                    ids.push(id);
                }
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'question_bank.import',
                    resourceType: 'question_bank',
                    resourceId: scope.tenantId,
                    newValue: snapshotRow({ imported: ids.length }),
                });
            });
            res.status(201).json({ imported: ids.length, ids });
        } catch (error) {
            console.error('Import question bank error:', error);
            res.status(500).json({ error: 'Failed to import questions' });
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

const productionDb: QuestionBankDataAccess = {
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

export default createQuestionBankRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
});
