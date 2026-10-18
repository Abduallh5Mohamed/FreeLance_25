import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { recordAudit, snapshotRow } from '../security/audit';
import { BranchAccessDeps, BranchMembershipRow, BranchRow, resolveBranchAccess } from '../security/branch-access';
import {
    CERTIFICATE_STATUSES,
    CertificateStatus,
    DEFAULT_ELIGIBILITY_THRESHOLD,
    generateVerificationId,
    isEligibleForCertificate,
    isRevoked,
    publicCertificateFacts,
} from '../services/certificates';
import { ScoreEntry, calculateGrade, normalizeId } from '../services/gradebook';

export interface CertificatesDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface CertificatesDeps {
    db: CertificatesDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /**
     * Resolves branch membership authority. Injected (production supplies the
     * DB-backed resolver) so the issue path can prove a non-owner instructor's
     * relation to a course through their branch without module-level state.
     */
    branchAccess?: BranchAccessDeps;
    /**
     * Guards the public `/verify/:verificationId` endpoint. The production
     * wiring supplies the per-client-address limiter; the factory itself stays
     * free of module-level throttle state so hermetic tests can drive it.
     */
    verifyRateLimit?: RequestHandler;
    now?: () => Date;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

interface CertRow {
    id: string;
    tenant_id: string;
    student_enrollment_id: string;
    course_id: string;
    verification_id: string;
    status: string;
    final_score: number | null;
    issued_at: string | Date;
    issued_by: string | null;
    revoked_at: string | Date | null;
    revoked_by: string | null;
    revoke_reason: string | null;
    branding_logo_url: string | null;
    branding_primary_color: string | null;
    branding_secondary_color: string | null;
    branding_accent_color: string | null;
    branding_locale: string | null;
    course_name?: string | null;
    tenant_name?: string | null;
}

export const createCertificatesRouter = (deps: CertificatesDeps): Router => {
    const router = Router();
    const { db } = deps;
    const now = deps.now ?? (() => new Date());

    const branchAccess: BranchAccessDeps = deps.branchAccess ?? {
        findBranchById: async (branchId) => db.queryOne<BranchRow>('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]),
        findMembership: async (branchId, userId) => db.queryOne<BranchMembershipRow>('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]),
    };

    const resolveStaffScope = async (req: AuthRequest, res: Response): Promise<{ tenantId: string; userId: string; isOwner: boolean; branchId: string | null } | null> => {
        const user = req.user;
        if (!user) { res.status(401).json({ error: 'Authentication required' }); return null; }
        const tenantId = user.tenantId;
        if (!tenantId) { res.status(403).json({ error: 'An active tenant membership is required' }); return null; }
        const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) { res.status(403).json({ error: 'Tenant instructor authority required' }); return null; }
        return { tenantId, userId: user.id, isOwner: authority.authority === 'owner', branchId: user.branchId ?? null };
    };

    const loadCert = async (tenantId: string, id: string): Promise<CertRow | null> =>
        db.queryOne<CertRow>('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE tenant_id=? AND id=? LIMIT 1', [tenantId, id]);

    const loadBranding = async (tenantId: string): Promise<{ logo_url: string | null; primary_color: string | null; secondary_color: string | null; accent_color: string | null; locale: string | null } | null> =>
        db.queryOne('SELECT logo_url, primary_color, secondary_color, accent_color, locale FROM tenant_branding WHERE tenant_id=? LIMIT 1', [tenantId]);

    /* --------------------------------------------------------------------- */
    /* Server-side authority + eligibility                                    */
    /* --------------------------------------------------------------------- */

    interface CourseRow { id: string; tenant_id: string | null; instructor_id: string | null; }

    const authorizeBranch = async (tenantId: string, userId: string, isOwner: boolean, branchId: string | null): Promise<boolean> => {
        if (!branchId) return false;
        const decision = await resolveBranchAccess(branchAccess, { principalUserId: userId, principalTenantId: tenantId, branchId, principalIsTenantOwner: isOwner });
        return decision.kind === 'allowed';
    };

    const instructorTeachesCourse = async (tenantId: string, userId: string, courseId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            'SELECT g.id FROM `groups` g INNER JOIN courses c ON c.id = g.course_id WHERE g.course_id=? AND g.instructor_id=? AND c.tenant_id=? LIMIT 1',
            [courseId, userId, tenantId],
        );
        return Boolean(row);
    };

    /**
     * Deny-by-default issuer authority over a course: a tenant owner, the
     * course's own instructor, an instructor who owns a group mapped to the
     * course, or an instructor whose verified branch membership grants access.
     */
    const hasCourseAuthority = async (scope: { tenantId: string; userId: string; isOwner: boolean; branchId: string | null }, course: CourseRow): Promise<boolean> => {
        if (scope.isOwner) return true;
        if (course.instructor_id === scope.userId) return true;
        if (await instructorTeachesCourse(scope.tenantId, scope.userId, course.id)) return true;
        return authorizeBranch(scope.tenantId, scope.userId, scope.isOwner, scope.branchId);
    };

    interface EligibilityRow { mode: string; passing_score: number | string | null; rounding: string; categories: string | null; }
    interface EligibilityScoreRow { category_id: string | null; item_type: string | null; item_id: string | null; score: number | string; max_score: number | string; weight: number | string | null; }

    /**
     * Recompute certificate eligibility from server-owned academic records for
     * this enrollment + course: the gradebook policy/scores (calculateGrade),
     * exam attempt `passed` flags and lesson-completion counts. Body-declared
     * facts (score, threshold, counters) are never consulted.
     */
    const computeEligibility = async (tenantId: string, enrollmentId: string, courseId: string): Promise<{ eligible: boolean; finalScore: number; reasons: string[] }> => {
        const policy = await db.queryOne<EligibilityRow>('SELECT mode, passing_score, rounding, categories FROM gradebook_policies WHERE tenant_id=? AND course_id=? LIMIT 1', [tenantId, courseId]);
        const scores = await db.query<EligibilityScoreRow>('SELECT category_id, item_type, item_id, score, max_score, weight FROM gradebook_scores WHERE tenant_id=? AND student_enrollment_id=? AND course_id=?', [tenantId, enrollmentId, courseId]);
        const entries: ScoreEntry[] = scores.map((s) => ({
            categoryId: s.category_id,
            score: Number(s.score),
            maxScore: Number(s.max_score),
            weight: s.weight === null ? null : Number(s.weight),
            itemType: (s.item_type as ScoreEntry['itemType']) ?? null,
            itemId: s.item_id,
        }));
        const grade = calculateGrade(entries, {
            mode: policy?.mode === 'weighted' ? 'weighted' : 'points',
            rounding: policy?.rounding === 'half_even' || policy?.rounding === 'none' ? policy.rounding : 'half_up',
            passingScore: policy?.passing_score === null || policy?.passing_score === undefined ? null : Number(policy.passing_score),
        });
        const lessons = await db.queryOne<{ total: number | string }>('SELECT COUNT(*) AS total FROM lectures WHERE course_id=?', [courseId]);
        const completions = await db.queryOne<{ completed: number | string }>('SELECT COUNT(*) AS completed FROM lesson_completions WHERE tenant_id=? AND student_enrollment_id=? AND course_id=?', [tenantId, enrollmentId, courseId]);
        const exams = await db.queryOne<{ total: number | string; passed: number | string }>(
            `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN a.passed=1 THEN 1 ELSE 0 END),0) AS passed
             FROM exam_versioned_attempts a INNER JOIN exams e ON e.id=a.exam_id
             WHERE a.tenant_id=? AND a.student_enrollment_id=? AND e.course_id=?`,
            [tenantId, enrollmentId, courseId],
        );
        const totalLessons = Number(lessons?.total ?? 0);
        const completedLessons = Number(completions?.completed ?? 0);
        const totalExams = Number(exams?.total ?? 0);
        const passedExams = Number(exams?.passed ?? 0);
        const allExamsPassed = totalExams === 0 ? true : passedExams >= totalExams;
        const threshold = policy?.passing_score === null || policy?.passing_score === undefined ? DEFAULT_ELIGIBILITY_THRESHOLD : Number(policy.passing_score);
        const eligible = isEligibleForCertificate({ finalScore: grade.rounded, completedLessons, totalLessons, allExamsPassed, threshold });
        const reasons: string[] = [];
        if (!eligible) {
            if (grade.rounded < threshold) reasons.push('score_below_threshold');
            if (totalLessons > 0 && completedLessons < totalLessons) reasons.push('lessons_incomplete');
            if (!allExamsPassed) reasons.push('exams_not_passed');
        }
        return { eligible, finalScore: grade.rounded, reasons };
    };


    // Public verify endpoint (no auth). It is the only path reachable by an
    // anonymous caller and returns minimal facts only; the injected limiter
    // (production: per-client-address) bounds enumeration. Every path below
    // passes through deps.authenticate.
    const verifyPublicCertificate: RequestHandler = async (req: AuthRequest, res: Response) => {
        const verificationId = (req.params.verificationId ?? '').trim();
        if (!verificationId || verificationId.length > 128) { res.status(400).json({ error: 'invalid verification id' }); return; }
        // One storage read resolves the certificate together with the course and
        // tenant DISPLAY names, so the public projection never carries an
        // internal UUID (and the anonymous surface stays a single lookup).
        const row = await db.queryOne<CertRow>(
            `SELECT c.id, c.tenant_id, c.student_enrollment_id, c.course_id, c.verification_id, c.status,
                    c.final_score, c.issued_at, c.issued_by, c.revoked_at, c.revoked_by, c.revoke_reason,
                    c.branding_logo_url, c.branding_primary_color, c.branding_secondary_color,
                    c.branding_accent_color, c.branding_locale,
                    co.name AS course_name, t.business_name AS tenant_name
             FROM certificates c
             LEFT JOIN courses co ON co.id = c.course_id AND co.tenant_id = c.tenant_id
             LEFT JOIN tenants t ON t.id = c.tenant_id
             WHERE c.verification_id=? LIMIT 1`,
            [verificationId],
        );
        if (!row) { res.status(404).json({ error: 'Certificate not found' }); return; }
        const facts = publicCertificateFacts({
            verificationId: row.verification_id,
            status: row.status,
            issuedAt: row.issued_at,
            courseName: row.course_name ?? null,
            studentName: null,
            tenantName: row.tenant_name ?? null,
            finalScore: row.final_score,
            branding: {
                logoUrl: row.branding_logo_url,
                primaryColor: row.branding_primary_color,
                secondaryColor: row.branding_secondary_color,
                accentColor: row.branding_accent_color,
                locale: row.branding_locale,
            },
        });
        res.json({ certificate: facts });
    };
    const verifyHandlers: RequestHandler[] = deps.verifyRateLimit
        ? [deps.verifyRateLimit, verifyPublicCertificate]
        : [verifyPublicCertificate];
    router.get('/verify/:verificationId', ...verifyHandlers);

    router.use(deps.authenticate);

    // List
    router.get('/', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const rows = await db.query<CertRow>('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE tenant_id=? ORDER BY issued_at DESC LIMIT 500', [scope.tenantId]);
        res.json({ certificates: rows });
    });

    // Issue
    router.post('/', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const body = req.body ?? {};
        const enrollmentId = normalizeId(
            typeof body.student_enrollment_id === 'string' ? body.student_enrollment_id : (typeof body.enrollment_id === 'string' ? body.enrollment_id : ''),
        );
        const courseId = normalizeId(
            typeof body.course_id === 'string' ? body.course_id : (typeof body.courseId === 'string' ? body.courseId : ''),
        );
        if (!enrollmentId || !courseId) { res.status(400).json({ error: 'student_enrollment_id and course_id are required' }); return; }

        // The enrollment and course must both exist inside the caller's tenant.
        const enrollment = await db.queryOne<{ id: string }>('SELECT id FROM students WHERE id=? AND tenant_id=? LIMIT 1', [enrollmentId, scope.tenantId]);
        if (!enrollment) { res.status(404).json({ error: 'Enrollment not found' }); return; }
        const course = await db.queryOne<CourseRow>('SELECT id, tenant_id, instructor_id FROM courses WHERE id=? LIMIT 1', [courseId]);
        if (!course || course.tenant_id !== scope.tenantId) { res.status(404).json({ error: 'Course not found' }); return; }
        if (!(await hasCourseAuthority(scope, course))) { res.status(403).json({ error: 'You are not authorized to issue a certificate for this course' }); return; }

        // Eligibility is recomputed from server-owned academic records; every
        // body-declared fact (score, counters, threshold) is ignored.
        const eligibility = await computeEligibility(scope.tenantId, enrollmentId, courseId);
        if (!eligibility.eligible) { res.status(400).json({ error: 'Student is not eligible for a certificate', reasons: eligibility.reasons }); return; }

        // duplicate check
        const existing = await db.queryOne<CertRow>('SELECT id FROM certificates WHERE tenant_id=? AND student_enrollment_id=? AND course_id=? LIMIT 1', [scope.tenantId, enrollmentId, courseId]);
        if (existing) { res.status(409).json({ error: 'Certificate already issued' }); return; }
        const branding = await loadBranding(scope.tenantId);
        const verificationId = generateVerificationId(32);
        const id = randomUUID();
        try {
            await db.execute(
                'INSERT INTO certificates (id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_by, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, scope.tenantId, enrollmentId, courseId, verificationId, 'issued', eligibility.finalScore, scope.userId, branding?.logo_url ?? null, branding?.primary_color ?? null, branding?.secondary_color ?? null, branding?.accent_color ?? null, branding?.locale ?? null],
            );
            await recordAudit(db.execute.bind(db) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'certificate.issue', resourceType: 'certificate', resourceId: id, newValue: { enrollmentId, courseId, verificationId, final_score: eligibility.finalScore } });
        } catch (e) {
            res.status(500).json({ error: 'Failed to issue certificate' });
            return;
        }
        res.status(201).json({ id, verification_id: verificationId });
    });

    // Revoke
    router.post('/:id/revoke', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const id = req.params.id.trim();
        const cert = await loadCert(scope.tenantId, id);
        if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
        if (cert.status === 'revoked') { res.status(409).json({ error: 'Already revoked' }); return; }
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 255) : null;
        try {
            await db.execute('UPDATE certificates SET status=?, revoked_at=CURRENT_TIMESTAMP, revoked_by=?, revoke_reason=? WHERE tenant_id=? AND id=? AND status=?', ['revoked', scope.userId, reason, scope.tenantId, id, 'issued']);
            await recordAudit(db.execute.bind(db) as never, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'certificate.revoke', resourceType: 'certificate', resourceId: id, oldValue: snapshotRow(cert), newValue: { status: 'revoked', reason } });
        } catch (e) {
            res.status(500).json({ error: 'Failed to revoke' });
            return;
        }
        res.json({ ok: true });
    });

    // Read
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope) return;
        const cert = await loadCert(scope.tenantId, req.params.id.trim());
        if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
        res.json({ certificate: cert });
    });

    return router;
};

// Production wiring: a lazily-resolved data access so importing this module in
// tests never constructs a pool, plus the default JWT authentication middleware.
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => { dbModule ??= await import('../db'); return dbModule; };
const productionDb: CertificatesDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => { const { query } = await loadDb(); return query<T>(sql, params as never); },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => { const { queryOne } = await loadDb(); return queryOne<T>(sql, params as never); },
    execute: async (sql: string, params?: unknown[]) => { const { execute } = await loadDb(); return execute(sql, params as never); },
};
const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(`SELECT m.role_key AS authority FROM tenant_memberships m INNER JOIN tenants t ON t.id=m.tenant_id AND t.status='active' INNER JOIN users u ON u.id=m.user_id AND u.is_active=1 WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1`, [userId, tenantId]);
};
const productionBranchAccess: BranchAccessDeps = {
    findBranchById: async (branchId) => {
        const { queryOne } = await loadDb();
        return queryOne<BranchRow>('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]);
    },
    findMembership: async (branchId, userId) => {
        const { queryOne } = await loadDb();
        return queryOne<BranchMembershipRow>('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]);
    },
};
export default createCertificatesRouter({
    db: productionDb,
    authenticate: async (req, res, next) => { const { authenticateToken } = await import('../middleware/auth'); return authenticateToken(req, res, next); },
    loadActiveTenantAuthority,
    branchAccess: productionBranchAccess,
    // Only the public verify endpoint is anonymously reachable: throttle it per
    // client address to bound enumeration of verification ids.
    verifyRateLimit: rateLimit('certificates-verify', 30, 60_000),
});