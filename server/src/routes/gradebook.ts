import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import { BranchAccessDeps, BranchMembershipRow, BranchRow, resolveBranchAccess } from '../security/branch-access';
import {
    CalculatedGrade,
    ScoreEntry,
    ValidatedGradebookPolicy,
    calculateGrade,
    normalizeId,
    normalizeScoreEntry,
    validateGradebookPolicy,
    validateScoreEntry,
} from '../services/gradebook';
import { neutralizeCsvCell, toCsv } from '../services/progress-reports';

export interface GradebookDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface GradebookDeps {
    db: GradebookDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    branchAccess?: BranchAccessDeps;
    now?: () => Date;
    transaction?: <T>(fn: (tx: GradebookDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface PolicyRow {
    id: string;
    tenant_id: string;
    course_id: string;
    mode: string;
    passing_score: number | null;
    rounding: string;
    categories: string | null;
}

interface ScoreRow {
    id: string;
    tenant_id: string;
    student_enrollment_id: string;
    course_id: string;
    category_id: string | null;
    item_type: string | null;
    item_id: string | null;
    score: number;
    max_score: number;
    weight: number | null;
    recorded_at: string | Date;
}

export const createGradebookRouter = (deps: GradebookDeps): Router => {
    const router = Router();
    const { db } = deps;
    const now = deps.now ?? (() => new Date());
    const runAtomic = deps.transaction ? deps.transaction : <T>(fn: (tx: GradebookDataAccess) => Promise<T>) => fn(db);

    const branchAccess: BranchAccessDeps = deps.branchAccess ?? {
        findBranchById: async (branchId) => db.queryOne<BranchRow>('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]),
        findMembership: async (branchId, userId) => db.queryOne<BranchMembershipRow>('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]),
    };

    router.use(deps.authenticate);

    const resolveStaffScope = async (req: AuthRequest, res: Response): Promise<{ tenantId: string; userId: string; isOwner: boolean; branchId: string | null } | null> => {
        const user = req.user;
        if (!user) { res.status(401).json({ error: 'Authentication required' }); return null; }
        const tenantId = user.tenantId;
        if (!tenantId) { res.status(403).json({ error: 'An active tenant membership is required' }); return null; }
        const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) { res.status(403).json({ error: 'Tenant instructor authority required' }); return null; }
        return { tenantId, userId: user.id, isOwner: authority.authority === 'owner', branchId: user.branchId ?? null };
    };

    const resolveStudent = async (req: AuthRequest, res: Response): Promise<{ tenantId: string; enrollmentId: string; userId: string } | null> => {
        const user = req.user;
        if (!user) { res.status(401).json({ error: 'Authentication required' }); return null; }
        if (user.role !== 'student') { res.status(403).json({ error: 'Student access required' }); return null; }
        if (!user.tenantId) { res.status(403).json({ error: 'An active student workspace is required' }); return null; }
        const row = await db.queryOne<{ id: string; tenant_id: string }>(
            `SELECT id, tenant_id FROM students WHERE user_id=? AND tenant_id=? AND is_active=1 AND approval_status='approved' LIMIT 1`,
            [user.id, user.tenantId],
        );
        if (!row) { res.status(404).json({ error: 'Student workspace not found' }); return null; }
        return { tenantId: row.tenant_id, enrollmentId: row.id, userId: user.id };
    };

    const loadPolicy = async (tenantId: string, courseId: string): Promise<PolicyRow | null> =>
        db.queryOne<PolicyRow>('SELECT id, tenant_id, course_id, mode, passing_score, rounding, categories FROM gradebook_policies WHERE tenant_id=? AND course_id=? LIMIT 1', [tenantId, courseId]);

    // A malformed stored JSON must never crash a read; fail closed to no
    // categories rather than leaking a 500.
    const parseCategories = (raw: string | null): unknown[] => {
        if (!raw) return [];
        try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    };

    // The weighting policy (mode, passing score, rounding and per-category
    // weights) is part of the student-visible contract, so both the staff and
    // the student surfaces project the same shape.
    const policyView = (policy: PolicyRow | null): Record<string, unknown> | null => (policy ? {
        id: policy.id,
        course_id: policy.course_id,
        mode: policy.mode,
        passing_score: policy.passing_score,
        rounding: policy.rounding,
        categories: parseCategories(policy.categories),
    } : null);

    const loadScores = async (tenantId: string, enrollmentId: string, courseId: string): Promise<ScoreRow[]> =>
        db.query<ScoreRow>('SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=? AND student_enrollment_id=? AND course_id=? ORDER BY recorded_at ASC', [tenantId, enrollmentId, courseId]);

    const computeForStudent = async (tenantId: string, enrollmentId: string, courseId: string): Promise<CalculatedGrade> => {
        const policy = await loadPolicy(tenantId, courseId);
        const scores = await loadScores(tenantId, enrollmentId, courseId);
        const entries: ScoreEntry[] = scores.map((s) => ({ categoryId: s.category_id, score: Number(s.score), maxScore: Number(s.max_score), weight: s.weight, itemType: (s.item_type as ScoreEntry['itemType']) ?? null, itemId: s.item_id }));
        return calculateGrade(entries, { mode: (policy?.mode as 'points' | 'weighted') ?? 'points', rounding: (policy?.rounding as 'half_up' | 'half_even' | 'none') ?? 'half_up', passingScore: policy?.passing_score ?? null });
    };

    // GET policy
    router.get('/policy/:courseId', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const courseId = normalizeId(req.params.courseId);
        if (!courseId) { res.status(400).json({ error: 'invalid course id' }); return; }
        const policy = await loadPolicy(scope.tenantId, courseId);
        res.json({ policy: policyView(policy) });
    });

    // PUT policy
    router.put('/policy/:courseId', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const courseId = normalizeId(req.params.courseId);
        if (!courseId) { res.status(400).json({ error: 'invalid course id' }); return; }
        const validated = validateGradebookPolicy(req.body ?? {});
        if (!validated.ok) { res.status(400).json({ error: validated.error }); return; }
        const v = validated.value;
        const existing = await loadPolicy(scope.tenantId, courseId);
        try {
            await runAtomic(async (tx) => {
                if (existing) {
                    await tx.execute('UPDATE gradebook_policies SET mode=?, passing_score=?, rounding=?, categories=?, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND course_id=?', [v.mode, v.passingScore, v.rounding, JSON.stringify(v.categories), scope.tenantId, courseId]);
                } else {
                    await tx.execute('INSERT INTO gradebook_policies (id, tenant_id, course_id, mode, passing_score, rounding, categories, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), scope.tenantId, courseId, v.mode, v.passingScore, v.rounding, JSON.stringify(v.categories), scope.userId]);
                }
                await recordAudit(tx.execute.bind(tx) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'gradebook.policy.upsert', resourceType: 'gradebook_policy', resourceId: courseId, oldValue: existing ? snapshotRow(existing) : null, newValue: v });
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to save policy' });
            return;
        }
        res.json({ ok: true });
    });

    // POST score
    router.post('/scores', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const body = req.body ?? {};
        const enrollmentId = normalizeId(body.student_enrollment_id ?? body.enrollment_id);
        const courseId = normalizeId(body.course_id ?? body.courseId);
        if (!enrollmentId || !courseId) { res.status(400).json({ error: 'student_enrollment_id and course_id are required' }); return; }
        const validated = validateScoreEntry(body);
        if (!validated.ok) { res.status(400).json({ error: validated.error }); return; }
        const v = validated.value;
        const id = randomUUID();
        try {
            await runAtomic(async (tx) => {
                await tx.execute('INSERT INTO gradebook_scores (id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, scope.tenantId, enrollmentId, courseId, v.categoryId, v.itemType, v.itemId, v.score, v.maxScore, v.weight, scope.userId]);
                await recordAudit(tx.execute.bind(tx) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'gradebook.score.create', resourceType: 'gradebook_score', resourceId: id, newValue: { enrollmentId, courseId, score: v.score, maxScore: v.maxScore } });
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to record score' });
            return;
        }
        res.status(201).json({ id });
    });

    // GET scores
    router.get('/scores', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const courseId = req.query.course_id ? normalizeId(req.query.course_id) : null;
        const enrollmentId = req.query.student_enrollment_id ? normalizeId(req.query.student_enrollment_id) : null;
        let sql = 'SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=?';
        const params: unknown[] = [scope.tenantId];
        if (courseId) { sql += ' AND course_id=?'; params.push(courseId); }
        if (enrollmentId) { sql += ' AND student_enrollment_id=?'; params.push(enrollmentId); }
        sql += ' ORDER BY recorded_at DESC LIMIT 500';
        const rows = await db.query<ScoreRow>(sql, params);
        res.json({ scores: rows });
    });

    // GET student own grade
    router.get('/me', async (req: AuthRequest, res: Response) => {
        const student = await resolveStudent(req, res);
        if (!student) return;
        const courseId = req.query.course_id ? normalizeId(req.query.course_id) : null;
        if (!courseId) { res.status(400).json({ error: 'course_id is required' }); return; }
        const grade = await computeForStudent(student.tenantId, student.enrollmentId, courseId);
        const policy = await loadPolicy(student.tenantId, courseId);
        // Students see the exact weighting policy their grade is computed from,
        // including per-category weights, not just the resulting score.
        res.json({ course_id: courseId, grade, policy: policyView(policy) });
    });

    // GET student grade (staff)
    router.get('/students/:enrollmentId', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const enrollmentId = normalizeId(req.params.enrollmentId);
        if (!enrollmentId) { res.status(400).json({ error: 'invalid enrollment id' }); return; }
        const courseId = req.query.course_id ? normalizeId(req.query.course_id) : null;
        if (!courseId) { res.status(400).json({ error: 'course_id is required' }); return; }
        const grade = await computeForStudent(scope.tenantId, enrollmentId, courseId);
        res.json({ student_enrollment_id: enrollmentId, course_id: courseId, grade });
    });

    // GET export CSV (audited)
    router.get('/export', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const courseId = req.query.course_id ? normalizeId(req.query.course_id) : null;
        if (!courseId) { res.status(400).json({ error: 'course_id is required' }); return; }
        const scores = await db.query<ScoreRow>('SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=? AND course_id=? ORDER BY student_enrollment_id ASC, recorded_at ASC', [scope.tenantId, courseId]);
        const rows = scores.map((s) => [s.student_enrollment_id, s.category_id ?? '', s.item_type ?? '', s.score, s.max_score, s.weight ?? '']);
        const csv = toCsv(['student_enrollment_id', 'category_id', 'item_type', 'score', 'max_score', 'weight'], rows);
        try {
            await recordAudit(db.execute.bind(db) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'gradebook.export', resourceType: 'gradebook', resourceId: courseId, newValue: { rows: rows.length } });
        } catch (e) {
            res.status(500).json({ error: 'Audit failed' });
            return;
        }
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', `attachment; filename="gradebook-${courseId}.csv"`);
        res.send(csv);
    });

    // progress: student own
    router.get('/progress', async (req: AuthRequest, res: Response) => {
        const student = await resolveStudent(req, res);
        if (!student) return;
        const courseId = req.query.course_id ? normalizeId(req.query.course_id) : null;
        if (!courseId) { res.status(400).json({ error: 'course_id is required' }); return; }
        const grade = await computeForStudent(student.tenantId, student.enrollmentId, courseId);
        const policy = await loadPolicy(student.tenantId, courseId);
        res.json({ student_enrollment_id: student.enrollmentId, course_id: courseId, grade, policy: policyView(policy) });
    });

    return router;
};

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => { dbModule ??= await import('../db'); return dbModule; };
const productionDb: GradebookDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => { const { query } = await loadDb(); return query<T>(sql, params as never); },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => { const { queryOne } = await loadDb(); return queryOne<T>(sql, params as never); },
    execute: async (sql: string, params?: unknown[]) => { const { execute } = await loadDb(); return execute(sql, params as never); },
};
const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(`SELECT m.role_key AS authority FROM tenant_memberships m INNER JOIN tenants t ON t.id=m.tenant_id AND t.status='active' INNER JOIN users u ON u.id=m.user_id AND u.is_active=1 WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1`, [userId, tenantId]);
};
export default createGradebookRouter({ db: productionDb, authenticate: async (req, res, next) => { const { authenticateToken } = await import('../middleware/auth'); return authenticateToken(req, res, next); }, loadActiveTenantAuthority });