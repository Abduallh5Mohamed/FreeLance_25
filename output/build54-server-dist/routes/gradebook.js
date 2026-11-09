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
exports.createGradebookRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const audit_1 = require("../security/audit");
const branch_access_1 = require("../security/branch-access");
const gradebook_1 = require("../services/gradebook");
const progress_reports_1 = require("../services/progress-reports");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
/** mysql2 duplicate-key error: a linked-score row already exists (idempotent). */
const isDuplicateKeyError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    const errno = error.errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
};
const createGradebookRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    const now = deps.now ?? (() => new Date());
    const runAtomic = deps.transaction ? deps.transaction : (fn) => fn(db);
    const branchAccess = deps.branchAccess ?? {
        findBranchById: async (branchId) => db.queryOne('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]),
        findMembership: async (branchId, userId) => db.queryOne('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]),
    };
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
        return { tenantId, userId: user.id, isOwner: authority.authority === 'owner', branchId: user.branchId ?? null };
    };
    const resolveStudent = async (req, res) => {
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
        // The FULL enrollment window, not just `is_active` + `approval_status`:
        // `attendance-records.ts` and `schedules.ts` both enforce
        // `enrollment_status` and the start/end dates, and those columns exist.
        // A student whose enrollment was withdrawn or whose window has passed
        // used to keep reading `GET /gradebook/me` and `/gradebook/progress`.
        const row = await db.queryOne(`SELECT id, tenant_id FROM students
             WHERE user_id=? AND tenant_id=? AND is_active=1 AND approval_status='approved'
               AND (enrollment_status IS NULL OR enrollment_status='active')
               AND (enrollment_start_date IS NULL OR enrollment_start_date<=UTC_TIMESTAMP())
               AND (enrollment_end_date IS NULL OR enrollment_end_date>UTC_TIMESTAMP())
             LIMIT 1`, [user.id, user.tenantId]);
        if (!row) {
            res.status(404).json({ error: 'Student workspace not found' });
            return null;
        }
        return { tenantId: row.tenant_id, enrollmentId: row.id, userId: user.id };
    };
    const loadPolicy = async (tenantId, courseId) => db.queryOne('SELECT id, tenant_id, course_id, mode, passing_score, rounding, categories FROM gradebook_policies WHERE tenant_id=? AND course_id=? LIMIT 1', [tenantId, courseId]);
    // A malformed stored JSON must never crash a read; fail closed to no
    // categories rather than leaking a 500.
    const parseCategories = (raw) => {
        if (!raw)
            return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    };
    // The weighting policy (mode, passing score, rounding and per-category
    // weights) is part of the student-visible contract, so both the staff and
    // the student surfaces project the same shape.
    const policyView = (policy) => (policy ? {
        id: policy.id,
        course_id: policy.course_id,
        mode: policy.mode,
        passing_score: policy.passing_score,
        rounding: policy.rounding,
        categories: parseCategories(policy.categories),
    } : null);
    const loadScores = async (tenantId, enrollmentId, courseId) => db.query('SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=? AND student_enrollment_id=? AND course_id=? ORDER BY recorded_at ASC', [tenantId, enrollmentId, courseId]);
    // Stored category weights are re-validated before use; malformed policy JSON
    // fails closed to the legacy entry-weighted calculation instead of a 500.
    const storedCategories = (policy) => {
        if (!policy)
            return [];
        const validated = (0, gradebook_1.validateGradebookPolicy)({
            mode: policy.mode,
            rounding: policy.rounding,
            passing_score: policy.passing_score,
            categories: parseCategories(policy.categories),
        });
        return validated.ok ? validated.value.categories : [];
    };
    const gradeFromScores = (scores, policy) => {
        const entries = scores.map((s) => ({ categoryId: s.category_id, score: Number(s.score), maxScore: Number(s.max_score), weight: s.weight, itemType: s.item_type ?? null, itemId: s.item_id }));
        return (0, gradebook_1.calculateGrade)(entries, { mode: policy?.mode ?? 'points', rounding: policy?.rounding ?? 'half_up', passingScore: policy?.passing_score ?? null, categories: storedCategories(policy) });
    };
    const computeForStudent = async (tenantId, enrollmentId, courseId) => {
        const policy = await loadPolicy(tenantId, courseId);
        const scores = await loadScores(tenantId, enrollmentId, courseId);
        return gradeFromScores(scores, policy);
    };
    const authorizeBranch = async (scope, branchId) => {
        const decision = await (0, branch_access_1.resolveBranchAccess)(branchAccess, {
            principalUserId: scope.userId,
            principalTenantId: scope.tenantId,
            branchId,
            principalIsTenantOwner: scope.isOwner,
        });
        return decision.kind === 'allowed';
    };
    const instructorTeachesCourse = async (tenantId, userId, courseId) => {
        const row = await db.queryOne('SELECT g.id FROM `groups` g INNER JOIN courses c ON c.id = g.course_id WHERE g.course_id=? AND g.instructor_id=? AND c.tenant_id=? LIMIT 1', [courseId, userId, tenantId]);
        return Boolean(row);
    };
    /**
     * A branch membership is not by itself a relation to a course. The course
     * must have a group inside the caller's branch; otherwise a branch-scoped
     * instructor would reach every course in the tenant.
     */
    const courseHasGroupInBranch = async (tenantId, courseId, branchId) => {
        const row = await db.queryOne(`SELECT g.id FROM \`groups\` g INNER JOIN courses c ON c.id = g.course_id
             WHERE g.course_id=? AND g.branch_id=? AND g.branch_scope='branch' AND c.tenant_id=? LIMIT 1`, [courseId, branchId, tenantId]);
        return Boolean(row);
    };
    /**
     * Deny-by-default instructor authority over a course: the tenant owner, the
     * course's own instructor, an instructor who owns a group mapped to the
     * course, or an instructor whose verified branch membership covers a group
     * of this course. Returns not-found (course absent/foreign) separately from
     * forbidden.
     */
    const authorizeCourse = async (scope, courseId) => {
        const course = await db.queryOne('SELECT id, tenant_id, instructor_id FROM courses WHERE id=? LIMIT 1', [courseId]);
        if (!course || course.tenant_id !== scope.tenantId)
            return 'not_found';
        if (scope.isOwner)
            return 'ok';
        if (course.instructor_id === scope.userId)
            return 'ok';
        if (await instructorTeachesCourse(scope.tenantId, scope.userId, courseId))
            return 'ok';
        if (scope.branchId
            && await authorizeBranch(scope, scope.branchId)
            && await courseHasGroupInBranch(scope.tenantId, courseId, scope.branchId))
            return 'ok';
        return 'forbidden';
    };
    const denyCourse = (res, result) => {
        if (result === 'not_found')
            res.status(404).json({ error: 'Course not found' });
        else
            res.status(403).json({ error: 'You are not authorized for this course' });
    };
    const enrollmentInTenant = async (tenantId, enrollmentId) => {
        const row = await db.queryOne('SELECT id FROM students WHERE id=? AND tenant_id=? LIMIT 1', [enrollmentId, tenantId]);
        return Boolean(row);
    };
    /** True when the enrollment belongs to a group (or active course link) of this course. */
    const enrollmentInCourse = async (tenantId, enrollmentId, courseId) => {
        const row = await db.queryOne(`SELECT s.id FROM students s
               LEFT JOIN \`groups\` g ON g.id = s.group_id
               LEFT JOIN student_courses sc ON sc.student_id = s.id AND sc.course_id = ? AND sc.status='active'
              WHERE s.id=? AND s.tenant_id=? AND (g.course_id = ? OR sc.course_id IS NOT NULL) LIMIT 1`, [courseId, enrollmentId, tenantId, courseId]);
        return Boolean(row);
    };
    // GET policy
    router.get('/policy/:courseId', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const courseId = (0, gradebook_1.normalizeId)(req.params.courseId);
        if (!courseId) {
            res.status(400).json({ error: 'invalid course id' });
            return;
        }
        const auth = await authorizeCourse(scope, courseId);
        if (auth !== 'ok') {
            denyCourse(res, auth);
            return;
        }
        const policy = await loadPolicy(scope.tenantId, courseId);
        res.json({ policy: policyView(policy) });
    });
    // PUT policy
    router.put('/policy/:courseId', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const courseId = (0, gradebook_1.normalizeId)(req.params.courseId);
        if (!courseId) {
            res.status(400).json({ error: 'invalid course id' });
            return;
        }
        const auth = await authorizeCourse(scope, courseId);
        if (auth !== 'ok') {
            denyCourse(res, auth);
            return;
        }
        const validated = (0, gradebook_1.validateGradebookPolicy)(req.body ?? {});
        if (!validated.ok) {
            res.status(400).json({ error: validated.error });
            return;
        }
        const v = validated.value;
        const existing = await loadPolicy(scope.tenantId, courseId);
        try {
            await runAtomic(async (tx) => {
                if (existing) {
                    const updated = await tx.execute('UPDATE gradebook_policies SET mode=?, passing_score=?, rounding=?, categories=?, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=? AND course_id=?', [v.mode, v.passingScore, v.rounding, JSON.stringify(v.categories), scope.tenantId, courseId]);
                    // Exactly one row must move. The policy row can disappear
                    // between `loadPolicy` and this UPDATE; without the check the
                    // route audited an upsert and answered `{ok:true}` for a
                    // change that never landed. `undefined` is neither zero nor
                    // one, so it is refused rather than coerced.
                    if (typeof updated.affectedRows !== 'number' || !Number.isSafeInteger(updated.affectedRows) || updated.affectedRows !== 1) {
                        throw new Error('gradebook policy update did not report exactly one affected row');
                    }
                }
                else {
                    await tx.execute('INSERT INTO gradebook_policies (id, tenant_id, course_id, mode, passing_score, rounding, categories, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [(0, crypto_1.randomUUID)(), scope.tenantId, courseId, v.mode, v.passingScore, v.rounding, JSON.stringify(v.categories), scope.userId]);
                }
                await (0, audit_1.recordAudit)(tx.execute.bind(tx), { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'gradebook.policy.upsert', resourceType: 'gradebook_policy', resourceId: courseId, oldValue: existing ? (0, audit_1.snapshotRow)(existing) : null, newValue: v });
            });
        }
        catch (e) {
            res.status(500).json({ error: 'Failed to save policy' });
            return;
        }
        res.json({ ok: true });
    });
    // POST score
    router.post('/scores', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const body = req.body ?? {};
        const enrollmentId = (0, gradebook_1.normalizeId)(body.student_enrollment_id ?? body.enrollment_id);
        const courseId = (0, gradebook_1.normalizeId)(body.course_id ?? body.courseId);
        if (!enrollmentId || !courseId) {
            res.status(400).json({ error: 'student_enrollment_id and course_id are required' });
            return;
        }
        const auth = await authorizeCourse(scope, courseId);
        if (auth !== 'ok') {
            denyCourse(res, auth);
            return;
        }
        if (!(await enrollmentInTenant(scope.tenantId, enrollmentId))) {
            res.status(404).json({ error: 'Enrollment not found' });
            return;
        }
        if (!(await enrollmentInCourse(scope.tenantId, enrollmentId, courseId))) {
            res.status(400).json({ error: 'Enrollment does not belong to this course' });
            return;
        }
        const validated = (0, gradebook_1.validateScoreEntry)(body);
        if (!validated.ok) {
            res.status(400).json({ error: validated.error });
            return;
        }
        const v = validated.value;
        /*
         * A source-linked grade (an assignment submission or a finalized exam
         * attempt) is addressed by a deterministic row id over the exact
         * (tenant, enrollment, course, item type, item) tuple. The same source
         * item therefore always targets the same primary key, so a repeated
         * request can never append a duplicate grade: it is either an exact
         * replay (no write at all) or a correction of the existing row. A free
         * `manual`/`lesson` entry keeps the historical append behaviour,
         * because two manual scores are legitimately two rows.
         */
        const linkedType = (0, gradebook_1.normalizeLinkedScoreItemType)(v.itemType);
        if (linkedType && !v.itemId) {
            res.status(400).json({ error: 'item_id is required for a linked score' });
            return;
        }
        const linkedId = linkedType && v.itemId
            ? (0, gradebook_1.deterministicScoreId)({
                tenantId: scope.tenantId,
                enrollmentId,
                courseId,
                itemType: linkedType,
                itemId: v.itemId,
            })
            : null;
        if (linkedType && linkedId === null) {
            res.status(400).json({ error: 'invalid item_id for a linked score' });
            return;
        }
        const id = linkedId ?? (0, crypto_1.randomUUID)();
        let outcome = 'created';
        try {
            await runAtomic(async (tx) => {
                if (linkedId) {
                    const existing = await tx.queryOne('SELECT id, score, max_score, weight FROM gradebook_scores WHERE id=? AND tenant_id=? FOR UPDATE', [linkedId, scope.tenantId]);
                    if (existing) {
                        const before = {
                            score: Number(existing.score),
                            max_score: Number(existing.max_score),
                            weight: existing.weight === null ? null : Number(existing.weight),
                        };
                        const sameWeight = (before.weight === null && v.weight === null)
                            || (before.weight !== null && v.weight !== null && before.weight === v.weight);
                        if (before.score === v.score && before.max_score === v.maxScore && sameWeight) {
                            outcome = 'unchanged';
                            return;
                        }
                        const updated = await tx.execute('UPDATE gradebook_scores SET score=?, max_score=?, weight=?, recorded_by=?, recorded_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?', [v.score, v.maxScore, v.weight, scope.userId, linkedId, scope.tenantId]);
                        // A usable count is required: `undefined` is neither zero
                        // nor one, and coercing it to 0 reported a concurrent
                        // change for a broken storage layer.
                        if (typeof updated.affectedRows !== 'number' || !Number.isSafeInteger(updated.affectedRows)) {
                            throw new Error('gradebook score update did not report a usable affected-row count');
                        }
                        if (updated.affectedRows === 0) {
                            outcome = 'unchanged';
                            return;
                        }
                        outcome = 'corrected';
                        await (0, audit_1.recordAudit)(tx.execute.bind(tx), {
                            actorUserId: scope.userId,
                            tenantId: scope.tenantId,
                            action: 'gradebook.score.correct',
                            resourceType: 'gradebook_score',
                            resourceId: linkedId,
                            oldValue: before,
                            newValue: {
                                enrollmentId, courseId, itemType: linkedType, itemId: v.itemId,
                                score: v.score, maxScore: v.maxScore, weight: v.weight,
                            },
                        });
                        return;
                    }
                }
                await tx.execute('INSERT INTO gradebook_scores (id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, scope.tenantId, enrollmentId, courseId, v.categoryId, v.itemType, v.itemId, v.score, v.maxScore, v.weight, scope.userId]);
                await (0, audit_1.recordAudit)(tx.execute.bind(tx), { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'gradebook.score.create', resourceType: 'gradebook_score', resourceId: id, newValue: { enrollmentId, courseId, score: v.score, maxScore: v.maxScore } });
            });
        }
        catch (e) {
            // A concurrent first write of the same linked item lost the primary
            // key race. The grade already exists, so this request is a replay.
            if (linkedId && isDuplicateKeyError(e)) {
                res.status(200).json({ id, idempotent: true });
                return;
            }
            res.status(500).json({ error: 'Failed to record score' });
            return;
        }
        // The outcome is set inside the transaction closure, which the compiler
        // cannot track; the declared union is the contract.
        const finalOutcome = outcome;
        if (finalOutcome === 'unchanged') {
            res.status(200).json({ id, idempotent: true });
            return;
        }
        if (finalOutcome === 'corrected') {
            res.status(201).json({ id, corrected: true });
            return;
        }
        res.status(201).json({ id });
    });
    // GET scores
    router.get('/scores', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const courseId = req.query.course_id ? (0, gradebook_1.normalizeId)(req.query.course_id) : null;
        const enrollmentId = req.query.student_enrollment_id ? (0, gradebook_1.normalizeId)(req.query.student_enrollment_id) : null;
        if (courseId) {
            const auth = await authorizeCourse(scope, courseId);
            if (auth !== 'ok') {
                denyCourse(res, auth);
                return;
            }
        }
        else if (!scope.isOwner) {
            // A non-owner may only list scores for courses they teach (directly
            // or through a group they own); never every course in the tenant.
            const taught = 'course_id IN (SELECT id FROM courses WHERE tenant_id=? AND instructor_id=?) '
                + 'OR course_id IN (SELECT g.course_id FROM `groups` g INNER JOIN courses c ON c.id=g.course_id WHERE g.instructor_id=? AND c.tenant_id=? AND g.course_id IS NOT NULL)';
            let sql = `SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=? AND (${taught})`;
            const params = [scope.tenantId, scope.tenantId, scope.userId, scope.userId, scope.tenantId];
            if (enrollmentId) {
                sql += ' AND student_enrollment_id=?';
                params.push(enrollmentId);
            }
            sql += ' ORDER BY recorded_at DESC LIMIT 500';
            const rows = await db.query(sql, params);
            res.json({ scores: rows });
            return;
        }
        let sql = 'SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=?';
        const params = [scope.tenantId];
        if (courseId) {
            sql += ' AND course_id=?';
            params.push(courseId);
        }
        if (enrollmentId) {
            sql += ' AND student_enrollment_id=?';
            params.push(enrollmentId);
        }
        sql += ' ORDER BY recorded_at DESC LIMIT 500';
        const rows = await db.query(sql, params);
        res.json({ scores: rows });
    });
    // GET student own grade
    router.get('/me', async (req, res) => {
        const student = await resolveStudent(req, res);
        if (!student)
            return;
        const courseId = req.query.course_id ? (0, gradebook_1.normalizeId)(req.query.course_id) : null;
        if (!courseId) {
            res.status(400).json({ error: 'course_id is required' });
            return;
        }
        if (!(await enrollmentInCourse(student.tenantId, student.enrollmentId, courseId))) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }
        const grade = await computeForStudent(student.tenantId, student.enrollmentId, courseId);
        const policy = await loadPolicy(student.tenantId, courseId);
        // Students see the exact weighting policy their grade is computed from,
        // including per-category weights, not just the resulting score.
        res.json({ course_id: courseId, grade, policy: policyView(policy) });
    });
    // GET student grade (staff)
    router.get('/students/:enrollmentId', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const enrollmentId = (0, gradebook_1.normalizeId)(req.params.enrollmentId);
        if (!enrollmentId) {
            res.status(400).json({ error: 'invalid enrollment id' });
            return;
        }
        const courseId = req.query.course_id ? (0, gradebook_1.normalizeId)(req.query.course_id) : null;
        if (!courseId) {
            res.status(400).json({ error: 'course_id is required' });
            return;
        }
        const auth = await authorizeCourse(scope, courseId);
        if (auth !== 'ok') {
            denyCourse(res, auth);
            return;
        }
        if (!(await enrollmentInTenant(scope.tenantId, enrollmentId))) {
            res.status(404).json({ error: 'Enrollment not found' });
            return;
        }
        if (!(await enrollmentInCourse(scope.tenantId, enrollmentId, courseId))) {
            res.status(404).json({ error: 'Enrollment not found' });
            return;
        }
        const grade = await computeForStudent(scope.tenantId, enrollmentId, courseId);
        res.json({ student_enrollment_id: enrollmentId, course_id: courseId, grade });
    });
    // GET export CSV (audited)
    router.get('/export', async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return;
        const courseId = req.query.course_id ? (0, gradebook_1.normalizeId)(req.query.course_id) : null;
        if (!courseId) {
            res.status(400).json({ error: 'course_id is required' });
            return;
        }
        const auth = await authorizeCourse(scope, courseId);
        if (auth !== 'ok') {
            denyCourse(res, auth);
            return;
        }
        const policy = await loadPolicy(scope.tenantId, courseId);
        // Bounded read with overflow detection. Like every sibling feed in this
        // chain (500 staff / 200 student records, 5000 report rows, 500
        // question-bank export) this caps the working set. But unlike a plain
        // `LIMIT 5000` — which silently truncates a large course and then
        // computes FALSE partial grades over the truncated set — we read one row
        // past the cap and refuse the export when the cap is exceeded. A
        // partial-score CSV must never be produced: it would understate or
        // misstate every affected enrollment's grade. This route implements
        // neither date/category filtering nor paginated export, so the only
        // honest response is to refuse; the message must not advertise those
        // unimplemented options.
        const MAX_EXPORT_ROWS = 5000;
        const scores = await db.query('SELECT id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_at FROM gradebook_scores WHERE tenant_id=? AND course_id=? ORDER BY student_enrollment_id ASC, recorded_at ASC LIMIT 5001', [scope.tenantId, courseId]);
        if (scores.length > MAX_EXPORT_ROWS) {
            // The +1 probe confirms there are more rows than the cap allows.
            // Refuse rather than emit a partial-grade CSV.
            return res.status(400).json({
                error: 'gradebook_export_overflow',
                message: `This course exceeds the supported gradebook export size; no CSV was generated.`,
            });
        }
        const scoresByEnrollment = new Map();
        for (const score of scores) {
            const bucket = scoresByEnrollment.get(score.student_enrollment_id);
            if (bucket)
                bucket.push(score);
            else
                scoresByEnrollment.set(score.student_enrollment_id, [score]);
        }
        const grades = new Map();
        for (const [enrollmentId, enrollmentScores] of scoresByEnrollment)
            grades.set(enrollmentId, gradeFromScores(enrollmentScores, policy));
        const rows = scores.map((s) => {
            const grade = grades.get(s.student_enrollment_id);
            return [s.student_enrollment_id, s.category_id ?? '', s.item_type ?? '', s.score, s.max_score, s.weight ?? '', grade?.percent ?? '', grade?.rounded ?? '', grade?.passed ?? ''];
        });
        const csv = (0, progress_reports_1.toCsv)(['student_enrollment_id', 'category_id', 'item_type', 'score', 'max_score', 'weight', 'calculated_percent', 'calculated_rounded', 'calculated_passed'], rows);
        try {
            await (0, audit_1.recordAudit)(db.execute.bind(db), { actorUserId: scope.userId, tenantId: scope.tenantId, action: 'gradebook.export', resourceType: 'gradebook', resourceId: courseId, newValue: { rows: rows.length } });
        }
        catch (e) {
            res.status(500).json({ error: 'Audit failed' });
            return;
        }
        res.set('Content-Type', 'text/csv');
        res.set('Content-Disposition', `attachment; filename="gradebook-${courseId}.csv"`);
        res.send(csv);
    });
    // progress: student own
    router.get('/progress', async (req, res) => {
        const student = await resolveStudent(req, res);
        if (!student)
            return;
        const courseId = req.query.course_id ? (0, gradebook_1.normalizeId)(req.query.course_id) : null;
        if (!courseId) {
            res.status(400).json({ error: 'course_id is required' });
            return;
        }
        if (!(await enrollmentInCourse(student.tenantId, student.enrollmentId, courseId))) {
            res.status(404).json({ error: 'Course not found' });
            return;
        }
        const grade = await computeForStudent(student.tenantId, student.enrollmentId, courseId);
        const policy = await loadPolicy(student.tenantId, courseId);
        res.json({ student_enrollment_id: student.enrollmentId, course_id: courseId, grade, policy: policyView(policy) });
    });
    return router;
};
exports.createGradebookRouter = createGradebookRouter;
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
/**
 * Production atomic seam: a policy/score write and its audit event commit
 * together, so a failed audit never leaves an unaudited gradebook mutation.
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
            // No `?? 0`: an absent count is an error the caller must see, not a
            // definite zero that reads as "nothing changed".
            return {
                insertId: typeof header.insertId === 'number' ? header.insertId : undefined,
                affectedRows: typeof header.affectedRows === 'number' ? header.affectedRows : undefined,
            };
        },
    }));
};
exports.default = (0, exports.createGradebookRouter)({ db: productionDb, authenticate: async (req, res, next) => { const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth'))); return authenticateToken(req, res, next); }, loadActiveTenantAuthority, transaction: productionTransaction });
