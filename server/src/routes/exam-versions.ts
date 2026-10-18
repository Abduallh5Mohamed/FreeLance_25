/**
 * M4 A2 + A3 — versioned exam snapshots and deterministic grading routes.
 *
 * Authority and scope are server-derived only:
 *  - a staff caller is a verified owner/instructor of the principal's selected
 *    tenant and the exam must belong to that tenant (`exams -> courses`);
 *  - a student attempt requires a live, approved enrollment whose tenant matches
 *    the exam and whose group/branch matches one of the exam's targets
 *    (deny-by-default; a tenant-wide exam matches any enrollment in the tenant);
 *  - every read/write carries `tenant_id = <principal tenant>`.
 *
 * A2: creating a version copies pinned question-bank versions into the frozen
 * snapshot; publishing sets the snapshot immutable and records the usage
 * provenance that locks those question-bank versions. Starting an attempt binds
 * the student to that exact `exam_version_id`; the server clock mints the
 * deadline and rejects a start before `opens_at` / at `closes_at`.
 *
 * A3: a submit grades from the snapshot only, writes the per-question award
 * ledger plus an idempotency ledger row keyed by the deterministic fingerprint,
 * and routes essay answers to `pending_review`. A regrade re-applies only when
 * the fingerprint changed, and is audited either way.
 *
 * Exports `createExamVersionsRouter(deps)` and a default-wired router instance
 * (real pool/auth/authority) so a later mounting task can `app.use` it. This
 * module never mounts itself and never runs DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import { tenantLocalNow, toUtcIso } from '../services/content-release';
import {
    DEFAULT_SCORING_POLICY,
    GradingQuestion,
    ScoringPolicy,
    computeGradingFingerprint,
    formatHundredths,
    gradeAttempt,
    normalizeAnswerMap,
    normalizeScoringPolicy,
    shouldApplyRegrade,
    toHundredths,
} from '../services/exam-grading';
import {
    ExamAudienceTarget,
    SnapshotQuestionSource,
    SnapshotTiming,
    buildSnapshotEntries,
    enrollmentMatchesExam,
    evaluateAttemptPhase,
    evaluateAttemptStart,
    evaluateManualSubmit,
    normalizeId,
    validateExamVersionInput,
} from '../services/exam-snapshots';
import { QuestionKind } from '../services/question-bank';

export interface ExamVersionsDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface ExamVersionsDeps {
    db: ExamVersionsDataAccess;
    authenticate: RequestHandler;
    /** Server-owned active authority of the principal inside the selected tenant. */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    now?: () => Date;
    /** Optional atomic seam; production supplies a pooled transaction. */
    transaction?: <T>(fn: (tx: ExamVersionsDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface ExamVersionRow {
    id: string;
    exam_id: string;
    tenant_id: string;
    version: number;
    status: string;
    duration_seconds: number;
    opens_at: string | Date | null;
    closes_at: string | Date | null;
    grace_seconds: number;
    total_points: number | string;
    passing_points: number | string;
    scoring_policy: unknown;
    published_at: string | Date | null;
}

interface ExamVersionQuestionRow {
    id: string;
    exam_version_id: string;
    tenant_id: string;
    position: number;
    question_id: string | null;
    question_version: number | null;
    source_version_id: string | null;
    question_type: string;
    question_text: string;
    options: string | null;
    correct_answers: string | null;
    points: number | string;
    explanation: string | null;
    content_hash: string | null;
}

interface AttemptRow {
    id: string;
    tenant_id: string;
    exam_id: string;
    exam_version_id: string;
    student_enrollment_id: string;
    student_user_id: string;
    status: string;
    started_at: string | Date;
    deadline_at: string | Date;
    submitted_at: string | Date | null;
    auto_submitted: boolean | number;
    auto_score: number | string | null;
    score: number | string | null;
    manual_required: boolean | number;
    grading_fingerprint: string | null;
    graded_at: string | Date | null;
    passed: boolean | number | null;
}

interface AnswerRow {
    id: string;
    question_ref: string;
    question_type: string;
    response: unknown;
    awarded_points: number | string | null;
    is_correct: boolean | number | null;
    manual_review: boolean | number;
}

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}

interface EnrollmentFacts {
    id: string;
    userId: string;
    tenantId: string;
    branchId: string | null;
    groupId: string | null;
}

interface QuestionBankVersionRow {
    source_version_id: string;
    question_id: string;
    version: number;
    question_type: string;
    question_text: string;
    options: string | null;
    correct_answers: string | null;
    points: number | string;
    explanation: string | null;
}

const VERSION_COLUMNS =
    'id,exam_id,tenant_id,version,status,duration_seconds,opens_at,closes_at,grace_seconds,' +
    'total_points,passing_points,scoring_policy,published_at';

const QUESTION_COLUMNS =
    'id,exam_version_id,tenant_id,position,question_id,question_version,source_version_id,' +
    'question_type,question_text,options,correct_answers,points,explanation,content_hash';

const ATTEMPT_COLUMNS =
    'id,tenant_id,exam_id,exam_version_id,student_enrollment_id,student_user_id,status,started_at,' +
    'deadline_at,submitted_at,auto_submitted,auto_score,score,manual_required,grading_fingerprint,graded_at,passed';

function parseJson(value: unknown): unknown {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function parseJsonArray(value: unknown): string[] {
    const parsed = parseJson(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Render an instant as a MySQL DATETIME literal in UTC (`YYYY-MM-DD HH:MM:SS`). */
function toDbUtc(value: string | Date): string {
    const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return iso.slice(0, 19).replace('T', ' ');
}

export const createExamVersionsRouter = (deps: ExamVersionsDeps): Router => {
    const router = Router();
    const { db } = deps;
    const now = deps.now ?? ((): Date => new Date());
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: ExamVersionsDataAccess) => Promise<T>): Promise<T> => fn(db);

    router.use(deps.authenticate);

    /* --------------------------------------------------------------------- */
    /* Scope resolvers                                                        */
    /* --------------------------------------------------------------------- */

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
        return { tenantId, userId: user.id, isOwner: authority.authority === 'owner', branchId: user.branchId ?? null };
    };

    const resolveEnrollment = async (req: AuthRequest, res: Response): Promise<EnrollmentFacts | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (user.role !== 'student') {
            res.status(403).json({ error: 'Student access required' });
            return null;
        }
        if (!user.tenantId) {
            res.status(403).json({ error: 'An active student workspace is required' });
            return null;
        }
        const row = await db.queryOne<{
            id: string; tenant_id: string; group_id: string | null;
            branch_id: string | null; branch_scope: string | null;
        }>(
            `SELECT s.id, s.tenant_id, s.group_id, grp.branch_id, grp.branch_scope
             FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
             WHERE s.user_id=? AND s.tenant_id=? AND s.is_active=1 AND s.approval_status='approved'
               AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
               AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
               AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
             LIMIT 1`,
            [user.id, user.tenantId],
        );
        if (!row) {
            res.status(404).json({ error: 'Student workspace not found' });
            return null;
        }
        return {
            id: row.id,
            userId: user.id,
            tenantId: row.tenant_id,
            branchId: row.branch_scope === 'branch' ? row.branch_id : null,
            groupId: row.group_id,
        };
    };

    /* --------------------------------------------------------------------- */
    /* Loading helpers                                                        */
    /* --------------------------------------------------------------------- */

    const examInTenant = async (tenantId: string, examId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            `SELECT e.id FROM exams e INNER JOIN courses c ON c.id = e.course_id
             WHERE e.id = ? AND c.tenant_id = ? LIMIT 1`,
            [examId, tenantId],
        );
        return Boolean(row);
    };

    const loadVersion = async (tenantId: string, examId: string, versionId: string): Promise<ExamVersionRow | null> =>
        db.queryOne<ExamVersionRow>(
            `SELECT ${VERSION_COLUMNS} FROM exam_versions
             WHERE id = ? AND exam_id = ? AND tenant_id = ? LIMIT 1`,
            [versionId, examId, tenantId],
        );

    const loadVersionWithQuestions = async (tenantId: string, versionId: string): Promise<ExamVersionQuestionRow[]> =>
        db.query<ExamVersionQuestionRow>(
            `SELECT ${QUESTION_COLUMNS} FROM exam_version_questions
             WHERE exam_version_id = ? AND tenant_id = ? ORDER BY position LIMIT 200`,
            [versionId, tenantId],
        );

    const loadAttempt = async (tenantId: string, attemptId: string): Promise<AttemptRow | null> =>
        db.queryOne<AttemptRow>(
            `SELECT ${ATTEMPT_COLUMNS} FROM exam_versioned_attempts
             WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [attemptId, tenantId],
        );

    const loadExamTargets = async (examId: string): Promise<ExamAudienceTarget[]> => {
        const rows = await db.query<{ group_id: string | null; branch_id: string | null; branch_scope: string | null }>(
            `SELECT eg.group_id, g.branch_id, g.branch_scope
             FROM exam_groups eg INNER JOIN \`groups\` g ON g.id = eg.group_id
             WHERE eg.exam_id = ?`,
            [examId],
        );
        return rows.map((row) => ({
            groupId: row.group_id,
            branchId: row.branch_id,
            branchScope: row.branch_scope ?? 'tenant',
        }));
    };

    const timingOf = (row: ExamVersionRow): SnapshotTiming => ({
        durationSeconds: Number(row.duration_seconds),
        opensAtUtc: toUtcIso(row.opens_at),
        closesAtUtc: toUtcIso(row.closes_at),
        graceSeconds: Number(row.grace_seconds),
    });

    const scoringOf = (row: ExamVersionRow): ScoringPolicy =>
        normalizeScoringPolicy(parseJson(row.scoring_policy)) ?? { ...DEFAULT_SCORING_POLICY };

    const gradingQuestionsOf = (rows: ExamVersionQuestionRow[]): GradingQuestion[] => rows.map((row) => ({
        ref: row.id,
        position: Number(row.position),
        questionType: row.question_type,
        points: Number(row.points),
        correctAnswers: parseJsonArray(row.correct_answers),
    }));

    /* --------------------------------------------------------------------- */
    /* Projections                                                            */
    /* --------------------------------------------------------------------- */

    const projectVersion = (row: ExamVersionRow) => ({
        id: row.id,
        exam_id: row.exam_id,
        tenant_id: row.tenant_id,
        version: Number(row.version),
        status: row.status,
        duration_seconds: Number(row.duration_seconds),
        opens_at: toUtcIso(row.opens_at),
        closes_at: toUtcIso(row.closes_at),
        grace_seconds: Number(row.grace_seconds),
        total_points: Number(row.total_points),
        passing_points: Number(row.passing_points),
        scoring: scoringOf(row),
        published_at: toUtcIso(row.published_at),
    });

    const projectQuestion = (row: ExamVersionQuestionRow, revealAnswerKey: boolean) => ({
        id: row.id,
        position: Number(row.position),
        question_type: row.question_type,
        question_text: row.question_text,
        options: parseJsonArray(row.options),
        points: Number(row.points),
        ...(revealAnswerKey ? { correct_answers: parseJsonArray(row.correct_answers) } : {}),
    });

    const projectAttempt = (row: AttemptRow) => ({
        id: row.id,
        exam_id: row.exam_id,
        exam_version_id: row.exam_version_id,
        student_enrollment_id: row.student_enrollment_id,
        status: row.status,
        started_at: toUtcIso(row.started_at),
        deadline_at: toUtcIso(row.deadline_at),
        submitted_at: toUtcIso(row.submitted_at),
        auto_submitted: Boolean(row.auto_submitted),
        auto_score: row.auto_score === null ? null : Number(row.auto_score),
        score: row.score === null ? null : Number(row.score),
        manual_required: Boolean(row.manual_required),
        graded_at: toUtcIso(row.graded_at),
        passed: row.passed === null ? null : Boolean(row.passed),
    });

    /* --------------------------------------------------------------------- */
    /* POST /exams/:examId/versions — create a draft snapshot (audited)       */
    /* --------------------------------------------------------------------- */
    router.post('/exams/:examId/versions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const examId = normalizeId(req.params.examId);
            if (!examId) return res.status(404).json({ error: 'Exam not found' });
            if (!(await examInTenant(scope.tenantId, examId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }

            const validated = validateExamVersionInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;

            const sources: { source: SnapshotQuestionSource; position: number; sourceVersionId: string }[] = [];
            for (const pin of value.questions) {
                const row = await db.queryOne<QuestionBankVersionRow>(
                    `SELECT id AS source_version_id, question_id, version, question_type, question_text,
                            options, correct_answers, points, explanation
                     FROM question_bank_versions
                     WHERE tenant_id = ? AND question_id = ? AND version = ? LIMIT 1`,
                    [scope.tenantId, pin.questionId, pin.version],
                );
                if (!row) {
                    return res.status(400).json({ error: `question ${pin.questionId} version ${pin.version} was not found` });
                }
                sources.push({
                    position: pin.position,
                    sourceVersionId: row.source_version_id,
                    source: {
                        questionId: row.question_id,
                        version: Number(row.version),
                        questionType: row.question_type as QuestionKind,
                        questionText: row.question_text,
                        options: parseJsonArray(row.options),
                        correctAnswers: parseJsonArray(row.correct_answers),
                        points: Number(row.points),
                        explanation: row.explanation,
                    },
                });
            }

            const snapshot = buildSnapshotEntries(sources);
            if (!snapshot.ok) return res.status(400).json({ error: snapshot.error });

            const totalPoints = snapshot.value.reduce((sum, entry) => sum + entry.points, 0);
            const maxRow = await db.queryOne<{ next_version: number | string }>(
                `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM exam_versions
                 WHERE exam_id = ? AND tenant_id = ?`,
                [examId, scope.tenantId],
            );
            const nextVersion = Number(maxRow?.next_version ?? 1);
            const versionId = randomUUID();

            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO exam_versions
                       (id,exam_id,tenant_id,version,status,duration_seconds,opens_at,closes_at,grace_seconds,
                        total_points,passing_points,scoring_policy,created_by)
                     VALUES (?,?,?,?, 'draft', ?,?,?,?, ?,?, ?, ?)`,
                    [
                        versionId, examId, scope.tenantId, nextVersion, value.durationSeconds,
                        value.opensAtUtc === null ? null : toDbUtc(value.opensAtUtc),
                        value.closesAtUtc === null ? null : toDbUtc(value.closesAtUtc),
                        value.graceSeconds, totalPoints, value.passingPoints,
                        JSON.stringify(value.scoring), scope.userId,
                    ],
                );
                for (const [index, entry] of snapshot.value.entries()) {
                    await tx.execute(
                        `INSERT INTO exam_version_questions
                           (id,exam_version_id,tenant_id,position,question_id,question_version,source_version_id,
                            question_type,question_text,options,correct_answers,points,explanation,content_hash)
                         VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?, ?)`,
                        [
                            randomUUID(), versionId, scope.tenantId, entry.position, entry.questionId, entry.version,
                            sources[index].sourceVersionId,
                            entry.questionType, entry.questionText, JSON.stringify(entry.options),
                            JSON.stringify(entry.correctAnswers), entry.points, entry.explanation, entry.contentHash,
                        ],
                    );
                }
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'exam_version.create',
                    resourceType: 'exam_version',
                    resourceId: versionId,
                    newValue: snapshotRow({
                        exam_id: examId,
                        version: nextVersion,
                        questions: snapshot.value.length,
                        total_points: totalPoints,
                        duration_seconds: value.durationSeconds,
                    }),
                });
            });

            res.status(201).json({
                id: versionId,
                exam_id: examId,
                version: nextVersion,
                status: 'draft',
                total_points: totalPoints,
            });
        } catch (error) {
            console.error('Create exam version error:', error);
            res.status(500).json({ error: 'Failed to create exam version' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /exams/:examId/versions — staff list                               */
    /* --------------------------------------------------------------------- */
    router.get('/exams/:examId/versions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const examId = normalizeId(req.params.examId);
            if (!examId) return res.status(404).json({ error: 'Exam not found' });
            if (!(await examInTenant(scope.tenantId, examId))) {
                return res.status(404).json({ error: 'Exam not found' });
            }
            const rows = await db.query<ExamVersionRow>(
                `SELECT ${VERSION_COLUMNS} FROM exam_versions
                 WHERE exam_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 100`,
                [examId, scope.tenantId],
            );
            res.json(rows.map(projectVersion));
        } catch (error) {
            console.error('List exam versions error:', error);
            res.status(500).json({ error: 'Failed to list exam versions' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /exams/:examId/versions/:versionId — staff detail (answer key)     */
    /* --------------------------------------------------------------------- */
    router.get('/exams/:examId/versions/:versionId', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const examId = normalizeId(req.params.examId);
            const versionId = normalizeId(req.params.versionId);
            if (!examId || !versionId) return res.status(404).json({ error: 'Exam version not found' });
            if (!(await examInTenant(scope.tenantId, examId))) {
                return res.status(404).json({ error: 'Exam version not found' });
            }
            const version = await loadVersion(scope.tenantId, examId, versionId);
            if (!version) return res.status(404).json({ error: 'Exam version not found' });
            const questions = await loadVersionWithQuestions(scope.tenantId, versionId);
            res.json({
                ...projectVersion(version),
                questions: questions.map((row) => projectQuestion(row, true)),
            });
        } catch (error) {
            console.error('Read exam version error:', error);
            res.status(500).json({ error: 'Failed to load exam version' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /exams/:examId/versions/:versionId/publish — freeze (audited)     */
    /* --------------------------------------------------------------------- */
    router.post('/exams/:examId/versions/:versionId/publish', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const examId = normalizeId(req.params.examId);
            const versionId = normalizeId(req.params.versionId);
            if (!examId || !versionId) return res.status(404).json({ error: 'Exam version not found' });
            if (!(await examInTenant(scope.tenantId, examId))) {
                return res.status(404).json({ error: 'Exam version not found' });
            }
            const version = await loadVersion(scope.tenantId, examId, versionId);
            if (!version) return res.status(404).json({ error: 'Exam version not found' });
            if (version.status === 'published') {
                return res.status(409).json({ error: 'Exam version is already published' });
            }
            if (version.status === 'archived') {
                return res.status(409).json({ error: 'An archived exam version cannot be published' });
            }

            const questions = await loadVersionWithQuestions(scope.tenantId, versionId);
            const published = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE exam_versions SET status='published', published_at=UTC_TIMESTAMP()
                     WHERE id=? AND exam_id=? AND tenant_id=? AND status='draft'`,
                    [versionId, examId, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                for (const row of questions) {
                    if (!row.source_version_id || !row.question_id) continue;
                    await tx.execute(
                        `INSERT IGNORE INTO question_bank_version_usages
                           (id,question_id,version_id,tenant_id,version,exam_id,exam_published)
                         VALUES (?,?,?,?,?,?,1)`,
                        [randomUUID(), row.question_id, row.source_version_id, scope.tenantId, Number(row.question_version ?? 0), examId],
                    );
                }
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'exam_version.publish',
                    resourceType: 'exam_version',
                    resourceId: versionId,
                    oldValue: snapshotRow({ status: version.status }),
                    newValue: snapshotRow({ status: 'published', questions: questions.length }),
                });
                return true;
            });
            if (!published) return res.status(409).json({ error: 'Exam version changed concurrently' });
            res.json({ id: versionId, status: 'published' });
        } catch (error) {
            console.error('Publish exam version error:', error);
            res.status(500).json({ error: 'Failed to publish exam version' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /exams/:examId/versions/:versionId/attempts — start (audited)     */
    /* --------------------------------------------------------------------- */
    router.post('/exams/:examId/versions/:versionId/attempts', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const examId = normalizeId(req.params.examId);
            const versionId = normalizeId(req.params.versionId);
            if (!examId || !versionId) return res.status(404).json({ error: 'Exam version not found' });
            if (!(await examInTenant(enrollment.tenantId, examId))) {
                return res.status(404).json({ error: 'Exam version not found' });
            }
            const version = await loadVersion(enrollment.tenantId, examId, versionId);
            if (!version) return res.status(404).json({ error: 'Exam version not found' });

            const targets = await loadExamTargets(examId);
            if (!enrollmentMatchesExam(
                { tenantId: version.tenant_id, targets },
                { tenantId: enrollment.tenantId, groupId: enrollment.groupId, branchId: enrollment.branchId },
            )) {
                return res.status(404).json({ error: 'Exam version not found' });
            }

            const existing = await db.queryOne<{ id: string }>(
                `SELECT id FROM exam_versioned_attempts
                 WHERE exam_id = ? AND student_enrollment_id = ? AND tenant_id = ? LIMIT 1`,
                [examId, enrollment.id, enrollment.tenantId],
            );
            const decision = evaluateAttemptStart(timingOf(version), version.status, Boolean(existing), now());
            if (!decision.allowed) {
                const status = decision.reason === 'already_attempted' ? 409 : 403;
                return res.status(status).json({ error: 'Attempt is not allowed', code: decision.reason });
            }

            const attemptId = randomUUID();
            const startedAt = now();
            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO exam_versioned_attempts
                       (id,tenant_id,exam_id,exam_version_id,student_enrollment_id,student_user_id,status,
                        started_at,deadline_at,auto_submitted)
                     VALUES (?,?,?,?,?,?, 'in_progress', ?,?, 0)`,
                    [
                        attemptId, enrollment.tenantId, examId, versionId, enrollment.id, enrollment.userId,
                        toDbUtc(startedAt), toDbUtc(decision.deadlineUtc),
                    ],
                );
                await recordAudit(tx.execute, {
                    actorUserId: enrollment.id,
                    tenantId: enrollment.tenantId,
                    action: 'exam_attempt.start',
                    resourceType: 'exam_attempt',
                    resourceId: attemptId,
                    newValue: snapshotRow({ exam_id: examId, exam_version_id: versionId, deadline_at: decision.deadlineUtc }),
                });
            });

            res.status(201).json({
                id: attemptId,
                exam_id: examId,
                exam_version_id: versionId,
                status: 'in_progress',
                started_at: startedAt.toISOString(),
                deadline_at: decision.deadlineUtc,
                remaining_seconds: decision.remainingSeconds,
            });
        } catch (error) {
            console.error('Start exam attempt error:', error);
            res.status(500).json({ error: 'Failed to start exam attempt' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /attempts/:attemptId — owner student or tenant staff               */
    /* --------------------------------------------------------------------- */
    router.get('/attempts/:attemptId', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const attemptId = normalizeId(req.params.attemptId);
            if (!attemptId) return res.status(404).json({ error: 'Attempt not found' });

            if (user.role === 'student') {
                const enrollment = await resolveEnrollment(req, res);
                if (!enrollment) return;
                const attempt = await loadAttempt(enrollment.tenantId, attemptId);
                if (!attempt || attempt.student_enrollment_id !== enrollment.id) {
                    return res.status(404).json({ error: 'Attempt not found' });
                }
                const questions = await loadVersionWithQuestions(enrollment.tenantId, attempt.exam_version_id);
                return res.json({
                    ...projectAttempt(attempt),
                    questions: questions.map((row) => projectQuestion(row, false)),
                });
            }

            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const attempt = await loadAttempt(scope.tenantId, attemptId);
            if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
            const questions = await loadVersionWithQuestions(scope.tenantId, attempt.exam_version_id);
            return res.json({
                ...projectAttempt(attempt),
                questions: questions.map((row) => projectQuestion(row, true)),
            });
        } catch (error) {
            console.error('Read exam attempt error:', error);
            res.status(500).json({ error: 'Failed to load attempt' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /attempts/:attemptId/submit — owner student, auto-grade (audited) */
    /* --------------------------------------------------------------------- */
    router.post('/attempts/:attemptId/submit', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const attemptId = normalizeId(req.params.attemptId);
            if (!attemptId) return res.status(404).json({ error: 'Attempt not found' });
            const attempt = await loadAttempt(enrollment.tenantId, attemptId);
            if (!attempt || attempt.student_enrollment_id !== enrollment.id) {
                return res.status(404).json({ error: 'Attempt not found' });
            }
            if (attempt.status !== 'in_progress') {
                return res.status(409).json({ error: 'This attempt has already been submitted' });
            }
            const version = await loadVersion(enrollment.tenantId, attempt.exam_id, attempt.exam_version_id);
            if (!version) return res.status(404).json({ error: 'Exam version not found' });

            const phase = evaluateAttemptPhase(timingOf(version), toUtcIso(attempt.started_at) ?? new Date().toISOString(), now());
            const decision = evaluateManualSubmit(phase);
            if (!decision.allowed) {
                return res.status(403).json({ error: 'Submission is not allowed', code: decision.reason });
            }

            const questionRows = await loadVersionWithQuestions(enrollment.tenantId, attempt.exam_version_id);
            const answerMap = normalizeAnswerMap((typeof req.body === 'object' && req.body !== null ? req.body : {})['answers']);
            const refs = new Set(questionRows.map((row) => row.id));
            if (Object.keys(answerMap).some((key) => !refs.has(key))) {
                return res.status(400).json({ error: 'Answers reference an unknown question' });
            }

            const policy = scoringOf(version);
            const gradingQuestions = gradingQuestionsOf(questionRows);
            const grade = gradeAttempt(gradingQuestions, answerMap, policy);
            const fingerprint = computeGradingFingerprint({
                versionId: attempt.exam_version_id,
                policy,
                questions: gradingQuestions,
                answers: answerMap,
            });
            const passingHundredths = toHundredths(version.passing_points) ?? 0;
            const status = grade.manualRequired ? 'pending_review' : 'graded';
            const passed = grade.manualRequired ? null : grade.autoScoreHundredths >= passingHundredths;
            const awarded = formatHundredths(grade.autoScoreHundredths);

            const applied = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE exam_versioned_attempts
                     SET status=?, auto_score=?, score=?, manual_required=?, grading_fingerprint=?,
                         submitted_at=UTC_TIMESTAMP(), graded_at=?, passed=?, version=version+1
                     WHERE id=? AND tenant_id=? AND status='in_progress'`,
                    [
                        status, awarded, grade.manualRequired ? null : awarded,
                        grade.manualRequired ? 1 : 0, fingerprint,
                        grade.manualRequired ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
                        passed === null ? null : (passed ? 1 : 0),
                        attemptId, enrollment.tenantId,
                    ],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                for (const question of grade.questions) {
                    await tx.execute(
                        `INSERT INTO exam_versioned_answers
                           (id,tenant_id,attempt_id,exam_version_id,question_ref,question_type,response,
                            awarded_points,is_correct,manual_review)
                         VALUES (?,?,?,?,?,?,?,?,?,?)
                         ON DUPLICATE KEY UPDATE response=VALUES(response), awarded_points=VALUES(awarded_points),
                            is_correct=VALUES(is_correct), manual_review=VALUES(manual_review)`,
                        [
                            randomUUID(), enrollment.tenantId, attemptId, attempt.exam_version_id, question.ref,
                            questionRows.find((row) => row.id === question.ref)?.question_type ?? 'essay',
                            JSON.stringify(answerMap[question.ref] ?? null),
                            question.awardedHundredths === null ? null : formatHundredths(question.awardedHundredths),
                            question.isCorrect === null ? null : (question.isCorrect ? 1 : 0),
                            question.autoGraded ? 0 : 1,
                        ],
                    );
                }
                await tx.execute(
                    `INSERT IGNORE INTO exam_grading_runs
                       (id,tenant_id,attempt_id,exam_version_id,idempotency_key,auto_score,manual_required,applied,created_by)
                     VALUES (?,?,?,?,?,?,?,1,?)`,
                    [
                        randomUUID(), enrollment.tenantId, attemptId, attempt.exam_version_id, fingerprint,
                        awarded, grade.manualRequired ? 1 : 0, enrollment.id,
                    ],
                );
                await recordAudit(tx.execute, {
                    actorUserId: enrollment.id,
                    tenantId: enrollment.tenantId,
                    action: 'exam_attempt.submit',
                    resourceType: 'exam_attempt',
                    resourceId: attemptId,
                    newValue: snapshotRow({
                        status,
                        auto_score: awarded,
                        manual_required: grade.manualRequired,
                        fingerprint,
                    }),
                });
                return true;
            });
            if (!applied) return res.status(409).json({ error: 'This attempt has already been submitted' });

            res.json({
                attempt_id: attemptId,
                status,
                auto_score: Number(awarded),
                manual_required: grade.manualRequired,
                late: decision.late,
            });
        } catch (error) {
            console.error('Submit exam attempt error:', error);
            res.status(500).json({ error: 'Failed to submit attempt' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /attempts/:attemptId/regrade — tenant staff, idempotent (audited) */
    /* --------------------------------------------------------------------- */
    router.post('/attempts/:attemptId/regrade', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const attemptId = normalizeId(req.params.attemptId);
            if (!attemptId) return res.status(404).json({ error: 'Attempt not found' });
            const attempt = await loadAttempt(scope.tenantId, attemptId);
            if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
            if (attempt.status === 'in_progress') {
                return res.status(409).json({ error: 'An in-progress attempt cannot be regraded' });
            }
            const version = await loadVersion(scope.tenantId, attempt.exam_id, attempt.exam_version_id);
            if (!version) return res.status(404).json({ error: 'Exam version not found' });

            const questionRows = await loadVersionWithQuestions(scope.tenantId, attempt.exam_version_id);
            const stored = await db.query<AnswerRow>(
                `SELECT id,question_ref,question_type,response,awarded_points,is_correct,manual_review
                 FROM exam_versioned_answers WHERE attempt_id = ? AND tenant_id = ?`,
                [attemptId, scope.tenantId],
            );
            const answerMap: Record<string, unknown> = {};
            for (const row of stored) answerMap[row.question_ref] = parseJson(row.response);

            const policy = scoringOf(version);
            const gradingQuestions = gradingQuestionsOf(questionRows);
            const grade = gradeAttempt(gradingQuestions, answerMap, policy);
            const fingerprint = computeGradingFingerprint({
                versionId: attempt.exam_version_id,
                policy,
                questions: gradingQuestions,
                answers: answerMap,
            });
            const awarded = formatHundredths(grade.autoScoreHundredths);
            const passingHundredths = toHundredths(version.passing_points) ?? 0;
            const status = grade.manualRequired ? 'pending_review' : 'graded';
            const passed = grade.manualRequired ? null : grade.autoScoreHundredths >= passingHundredths;

            if (!shouldApplyRegrade(attempt.grading_fingerprint, fingerprint)) {
                await recordAudit(db.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'exam_attempt.regrade',
                    resourceType: 'exam_attempt',
                    resourceId: attemptId,
                    newValue: snapshotRow({ applied: false, fingerprint, auto_score: awarded }),
                });
                return res.json({ attempt_id: attemptId, applied: false, auto_score: Number(awarded), status: attempt.status });
            }

            const appliedResult = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE exam_versioned_attempts
                     SET status=?, auto_score=?, score=?, manual_required=?, grading_fingerprint=?,
                         graded_at=?, passed=?, version=version+1
                     WHERE id=? AND tenant_id=?`,
                    [
                        status, awarded, grade.manualRequired ? null : awarded, grade.manualRequired ? 1 : 0,
                        fingerprint, new Date().toISOString().slice(0, 19).replace('T', ' '),
                        passed === null ? null : (passed ? 1 : 0), attemptId, scope.tenantId,
                    ],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                for (const question of grade.questions) {
                    await tx.execute(
                        `UPDATE exam_versioned_answers
                         SET awarded_points=?, is_correct=?, manual_review=?
                         WHERE attempt_id=? AND tenant_id=? AND question_ref=?`,
                        [
                            question.awardedHundredths === null ? null : formatHundredths(question.awardedHundredths),
                            question.isCorrect === null ? null : (question.isCorrect ? 1 : 0),
                            question.autoGraded ? 0 : 1, attemptId, scope.tenantId, question.ref,
                        ],
                    );
                }
                await tx.execute(
                    `INSERT IGNORE INTO exam_grading_runs
                       (id,tenant_id,attempt_id,exam_version_id,idempotency_key,auto_score,manual_required,applied,created_by)
                     VALUES (?,?,?,?,?,?,?,1,?)`,
                    [
                        randomUUID(), scope.tenantId, attemptId, attempt.exam_version_id, fingerprint,
                        awarded, grade.manualRequired ? 1 : 0, scope.userId,
                    ],
                );
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'exam_attempt.regrade',
                    resourceType: 'exam_attempt',
                    resourceId: attemptId,
                    oldValue: snapshotRow({ fingerprint: attempt.grading_fingerprint, score: attempt.score }),
                    newValue: snapshotRow({ applied: true, fingerprint, auto_score: awarded, status }),
                });
                return true;
            });
            if (!appliedResult) return res.status(409).json({ error: 'Attempt changed concurrently' });
            res.json({ attempt_id: attemptId, applied: true, auto_score: Number(awarded), status });
        } catch (error) {
            console.error('Regrade exam attempt error:', error);
            res.status(500).json({ error: 'Failed to regrade attempt' });
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

const productionDb: ExamVersionsDataAccess = {
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

export default createExamVersionsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
});
