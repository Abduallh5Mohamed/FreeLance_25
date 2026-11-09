"use strict";
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
exports.createCertificatesRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const rate_limit_1 = require("../middleware/rate-limit");
const audit_1 = require("../security/audit");
const branch_access_1 = require("../security/branch-access");
const certificates_1 = require("../services/certificates");
const gradebook_1 = require("../services/gradebook");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
const createCertificatesRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    const now = deps.now ?? (() => new Date());
    const runAtomic = deps.transaction
        ? deps.transaction
        : (fn) => fn(db);
    const branchAccess = deps.branchAccess ?? {
        findBranchById: async (branchId) => db.queryOne('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]),
        findMembership: async (branchId, userId) => db.queryOne('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]),
    };
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
        return { tenantId, userId: user.id, isOwner: authority.authority === 'owner', branchId: user.branchId ?? null };
    };
    const loadCert = async (tenantId, id) => db.queryOne('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE tenant_id=? AND id=? LIMIT 1', [tenantId, id]);
    const loadBranding = async (tenantId) => db.queryOne('SELECT logo_url, primary_color, secondary_color, accent_color, locale FROM tenant_branding WHERE tenant_id=? LIMIT 1', [tenantId]);
    const authorizeBranch = async (tenantId, userId, isOwner, branchId) => {
        if (!branchId)
            return false;
        const decision = await (0, branch_access_1.resolveBranchAccess)(branchAccess, { principalUserId: userId, principalTenantId: tenantId, branchId, principalIsTenantOwner: isOwner });
        return decision.kind === 'allowed';
    };
    const instructorTeachesCourse = async (tenantId, userId, courseId) => {
        const row = await db.queryOne('SELECT g.id FROM `groups` g INNER JOIN courses c ON c.id = g.course_id WHERE g.course_id=? AND g.instructor_id=? AND c.tenant_id=? LIMIT 1', [courseId, userId, tenantId]);
        return Boolean(row);
    };
    /**
     * A branch membership is not by itself a relation to a course: the course
     * must have a group inside the caller's branch, otherwise a branch-scoped
     * instructor would be able to issue/revoke certificates for every course in
     * the tenant.
     */
    const courseHasGroupInBranch = async (tenantId, courseId, branchId) => {
        const row = await db.queryOne(`SELECT g.id FROM \`groups\` g INNER JOIN courses c ON c.id = g.course_id
             WHERE g.course_id=? AND g.branch_id=? AND g.branch_scope='branch' AND c.tenant_id=? LIMIT 1`, [courseId, branchId, tenantId]);
        return Boolean(row);
    };
    /**
     * Deny-by-default issuer authority over a course: a tenant owner, the
     * course's own instructor, an instructor who owns a group mapped to the
     * course, or an instructor whose verified branch membership covers a group
     * of this course.
     */
    const hasCourseAuthority = async (scope, course) => {
        if (scope.isOwner)
            return true;
        if (course.instructor_id === scope.userId)
            return true;
        if (await instructorTeachesCourse(scope.tenantId, scope.userId, course.id))
            return true;
        if (!scope.branchId)
            return false;
        if (!(await authorizeBranch(scope.tenantId, scope.userId, scope.isOwner, scope.branchId)))
            return false;
        return courseHasGroupInBranch(scope.tenantId, course.id, scope.branchId);
    };
    /**
     * Recompute certificate eligibility from server-owned academic records for
     * this enrollment + course: the gradebook policy/scores (calculateGrade),
     * exam attempt `passed` flags and lesson-completion counts. Body-declared
     * facts (score, threshold, counters) are never consulted.
     */
    const computeEligibility = async (tenantId, enrollmentId, courseId) => {
        const policy = await db.queryOne('SELECT mode, passing_score, rounding, categories FROM gradebook_policies WHERE tenant_id=? AND course_id=? LIMIT 1', [tenantId, courseId]);
        const scores = await db.query('SELECT category_id, item_type, item_id, score, max_score, weight FROM gradebook_scores WHERE tenant_id=? AND student_enrollment_id=? AND course_id=?', [tenantId, enrollmentId, courseId]);
        const entries = scores.map((s) => ({
            categoryId: s.category_id,
            score: Number(s.score),
            maxScore: Number(s.max_score),
            weight: s.weight === null ? null : Number(s.weight),
            itemType: s.item_type ?? null,
            itemId: s.item_id,
        }));
        const grade = (0, gradebook_1.calculateGrade)(entries, {
            mode: policy?.mode === 'weighted' ? 'weighted' : 'points',
            rounding: policy?.rounding === 'half_even' || policy?.rounding === 'none' ? policy.rounding : 'half_up',
            passingScore: policy?.passing_score === null || policy?.passing_score === undefined ? null : Number(policy.passing_score),
        });
        const lessons = await db.queryOne('SELECT COUNT(*) AS total FROM lectures WHERE course_id=?', [courseId]);
        const completions = await db.queryOne('SELECT COUNT(*) AS completed FROM lesson_completions WHERE tenant_id=? AND student_enrollment_id=? AND course_id=?', [tenantId, enrollmentId, courseId]);
        const exams = await db.queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN a.passed=1 THEN 1 ELSE 0 END),0) AS passed
             FROM exam_versioned_attempts a INNER JOIN exams e ON e.id=a.exam_id
             WHERE a.tenant_id=? AND a.student_enrollment_id=? AND e.course_id=?`, [tenantId, enrollmentId, courseId]);
        const totalLessons = Number(lessons?.total ?? 0);
        const completedLessons = Number(completions?.completed ?? 0);
        const totalExams = Number(exams?.total ?? 0);
        const passedExams = Number(exams?.passed ?? 0);
        const allExamsPassed = totalExams === 0 ? true : passedExams >= totalExams;
        const threshold = policy?.passing_score === null || policy?.passing_score === undefined ? certificates_1.DEFAULT_ELIGIBILITY_THRESHOLD : Number(policy.passing_score);
        const eligible = (0, certificates_1.isEligibleForCertificate)({ finalScore: grade.rounded, completedLessons, totalLessons, allExamsPassed, threshold });
        const reasons = [];
        if (!eligible) {
            if (grade.rounded < threshold)
                reasons.push('score_below_threshold');
            if (totalLessons > 0 && completedLessons < totalLessons)
                reasons.push('lessons_incomplete');
            if (!allExamsPassed)
                reasons.push('exams_not_passed');
        }
        return { eligible, finalScore: grade.rounded, reasons };
    };
    // Public verify endpoint (no auth). It is the only path reachable by an
    // anonymous caller and returns minimal facts only; the injected limiter
    // (production: per-client-address) bounds enumeration. Every path below
    // passes through deps.authenticate.
    const verifyPublicCertificate = async (req, res) => {
        const verificationId = (req.params.verificationId ?? '').trim();
        if (!verificationId || verificationId.length > 128) {
            res.status(400).json({ error: 'invalid verification id' });
            return;
        }
        // One storage read resolves the certificate together with the course and
        // tenant DISPLAY names, so the public projection never carries an
        // internal UUID (and the anonymous surface stays a single lookup).
        const row = await db.queryOne(`SELECT c.id, c.tenant_id, c.student_enrollment_id, c.course_id, c.verification_id, c.status,
                    c.final_score, c.issued_at, c.issued_by, c.revoked_at, c.revoked_by, c.revoke_reason,
                    c.branding_logo_url, c.branding_primary_color, c.branding_secondary_color,
                    c.branding_accent_color, c.branding_locale,
                    co.name AS course_name, t.business_name AS tenant_name
             FROM certificates c
             LEFT JOIN courses co ON co.id = c.course_id AND co.tenant_id = c.tenant_id
             LEFT JOIN tenants t ON t.id = c.tenant_id
             WHERE c.verification_id=? LIMIT 1`, [verificationId]);
        if (!row) {
            res.status(404).json({ error: 'Certificate not found' });
            return;
        }
        const facts = (0, certificates_1.publicCertificateFacts)({
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
    const verifyHandlers = deps.verifyRateLimit
        ? [deps.verifyRateLimit, verifyPublicCertificate]
        : [verifyPublicCertificate];
    router.get('/verify/:verificationId', ...verifyHandlers);
    router.use(deps.authenticate);
    // List
    router.get('/', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const rows = await db.query('SELECT id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_at, issued_by, revoked_at, revoked_by, revoke_reason, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale FROM certificates WHERE tenant_id=? ORDER BY issued_at DESC LIMIT 500', [scope.tenantId]);
        res.json({ certificates: rows });
    });
    // Issue
    router.post('/', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const body = req.body ?? {};
        const enrollmentId = (0, gradebook_1.normalizeId)(typeof body.student_enrollment_id === 'string' ? body.student_enrollment_id : (typeof body.enrollment_id === 'string' ? body.enrollment_id : ''));
        const courseId = (0, gradebook_1.normalizeId)(typeof body.course_id === 'string' ? body.course_id : (typeof body.courseId === 'string' ? body.courseId : ''));
        if (!enrollmentId || !courseId) {
            res.status(400).json({ error: 'student_enrollment_id and course_id are required' });
            return;
        }
        // The enrollment and course must both exist inside the caller's tenant.
        const enrollment = await db.queryOne('SELECT id FROM students WHERE id=? AND tenant_id=? LIMIT 1', [enrollmentId, scope.tenantId]);
        if (!enrollment) {
            res.status(404).json({ error: 'Enrollment not found' });
            return;
        }
        const course = await db.queryOne('SELECT id, tenant_id, instructor_id FROM courses WHERE id=? LIMIT 1', [courseId]);
        if (!course || course.tenant_id !== scope.tenantId) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }
        if (!(await hasCourseAuthority(scope, course))) {
            res.status(403).json({ error: 'You are not authorized to issue a certificate for this course' });
            return;
        }
        // Eligibility is recomputed from server-owned academic records; every
        // body-declared fact (score, counters, threshold) is ignored.
        const eligibility = await computeEligibility(scope.tenantId, enrollmentId, courseId);
        if (!eligibility.eligible) {
            res.status(400).json({ error: 'Student is not eligible for a certificate', reasons: eligibility.reasons });
            return;
        }
        // duplicate check
        const existing = await db.queryOne('SELECT id FROM certificates WHERE tenant_id=? AND student_enrollment_id=? AND course_id=? LIMIT 1', [scope.tenantId, enrollmentId, courseId]);
        if (existing) {
            res.status(409).json({ error: 'Certificate already issued' });
            return;
        }
        const branding = await loadBranding(scope.tenantId);
        const verificationId = (0, certificates_1.generateVerificationId)(32);
        const id = (0, crypto_1.randomUUID)();
        try {
            await runAtomic(async (tx) => {
                await tx.execute('INSERT INTO certificates (id, tenant_id, student_enrollment_id, course_id, verification_id, status, final_score, issued_by, branding_logo_url, branding_primary_color, branding_secondary_color, branding_accent_color, branding_locale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, scope.tenantId, enrollmentId, courseId, verificationId, 'issued', eligibility.finalScore, scope.userId, branding?.logo_url ?? null, branding?.primary_color ?? null, branding?.secondary_color ?? null, branding?.accent_color ?? null, branding?.locale ?? null]);
                await (0, audit_1.recordAudit)(tx.execute, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'certificate.issue', resourceType: 'certificate', resourceId: id, newValue: { enrollmentId, courseId, verificationId, final_score: eligibility.finalScore } });
            });
        }
        catch (e) {
            res.status(500).json({ error: 'Failed to issue certificate' });
            return;
        }
        res.status(201).json({ id, verification_id: verificationId });
    });
    // Revoke
    router.post('/:id/revoke', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const id = req.params.id.trim();
        const cert = await loadCert(scope.tenantId, id);
        if (!cert) {
            res.status(404).json({ error: 'Certificate not found' });
            return;
        }
        // Revocation carries the same course authority as issuance: the tenant
        // owner may recover administratively, otherwise the caller must be
        // related to this certificate's course. A tenant instructor with no
        // relation to the course is denied (no tenant-wide revocation right).
        const course = await db.queryOne('SELECT id, tenant_id, instructor_id FROM courses WHERE id=? LIMIT 1', [cert.course_id]);
        if (!course || course.tenant_id !== scope.tenantId) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }
        if (!(await hasCourseAuthority(scope, course))) {
            res.status(403).json({ error: 'You are not authorized to revoke a certificate for this course' });
            return;
        }
        if (cert.status === 'revoked') {
            res.status(409).json({ error: 'Already revoked' });
            return;
        }
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 255) : null;
        try {
            await runAtomic(async (tx) => {
                await tx.execute('UPDATE certificates SET status=?, revoked_at=CURRENT_TIMESTAMP, revoked_by=?, revoke_reason=? WHERE tenant_id=? AND id=? AND status=?', ['revoked', scope.userId, reason, scope.tenantId, id, 'issued']);
                await (0, audit_1.recordAudit)(tx.execute, { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'certificate.revoke', resourceType: 'certificate', resourceId: id, oldValue: (0, audit_1.snapshotRow)(cert), newValue: { status: 'revoked', reason } });
            });
        }
        catch (e) {
            res.status(500).json({ error: 'Failed to revoke' });
            return;
        }
        res.json({ ok: true });
    });
    // Read
    router.get('/:id', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const cert = await loadCert(scope.tenantId, req.params.id.trim());
        if (!cert) {
            res.status(404).json({ error: 'Certificate not found' });
            return;
        }
        res.json({ certificate: cert });
    });
    return router;
};
exports.createCertificatesRouter = createCertificatesRouter;
// Production wiring: a lazily-resolved data access so importing this module in
// tests never constructs a pool, plus the default JWT authentication middleware.
let dbModule = null;
const loadDb = async () => { dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db')))); return dbModule; };
const productionDb = {
    query: async (sql, params) => { const { query } = await loadDb(); return query(sql, params); },
    queryOne: async (sql, params) => { const { queryOne } = await loadDb(); return queryOne(sql, params); },
    execute: async (sql, params) => { const { execute } = await loadDb(); return execute(sql, params); },
};
const loadActiveTenantAuthority = async (userId, tenantId) => {
    const { queryOne } = await loadDb();
    return queryOne(`SELECT m.role_key AS authority FROM tenant_memberships m INNER JOIN tenants t ON t.id=m.tenant_id AND t.status='active' INNER JOIN users u ON u.id=m.user_id AND u.is_active=1 WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1`, [userId, tenantId]);
};
const productionBranchAccess = {
    findBranchById: async (branchId) => {
        const { queryOne } = await loadDb();
        return queryOne('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]);
    },
    findMembership: async (branchId, userId) => {
        const { queryOne } = await loadDb();
        return queryOne('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]);
    },
};
/**
 * Production atomic seam: an issued/revoked certificate row and its audit
 * event are written on one pooled connection, so a failed audit rolls the
 * status change back instead of leaving an unaudited certificate mutation.
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
            return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
        },
    }));
};
exports.default = (0, exports.createCertificatesRouter)({
    db: productionDb,
    authenticate: async (req, res, next) => { const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth'))); return authenticateToken(req, res, next); },
    loadActiveTenantAuthority,
    branchAccess: productionBranchAccess,
    transaction: productionTransaction,
    // Only the public verify endpoint is anonymously reachable: throttle it per
    // client address to bound enumeration of verification ids.
    verifyRateLimit: (0, rate_limit_1.rateLimit)('certificates-verify', 30, 60000),
});
