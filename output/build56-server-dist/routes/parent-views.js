"use strict";
/**
 * M6 P2 — read-only parent views.
 *
 * Every route is authenticated exclusively by a scoped parent view token (an
 * HMAC token over the dedicated PARENT_VIEW_SECRET). The token is bound to one
 * link id + tenant + enrollment + parent, and the verifier re-checks the link
 * and token revocation/expiry on EVERY request, so revoking a link or token
 * denies the next request immediately.
 *
 * These routes only ever expose the single linked child and published
 * aggregates: lesson-progress counts, attendance records and a grades summary.
 * They never mutate state, never select other children, and never return
 * contact details, addresses, notes, answer keys or any other student's data.
 * Every query is scoped by the token's tenant + enrollment.
 *
 * Mounted under /api/parent in the existing composition root. BUILD-39 adds
 * a separately guarded bounded family-summary read without using the legacy
 * grades aggregate. No runtime DDL.
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
exports.createParentViewsRouter = exports.createParentViewAuth = void 0;
exports.createSqlParentViewsStore = createSqlParentViewsStore;
const express_1 = require("express");
const family_summary_1 = require("./family-summary");
const parent_links_1 = require("../services/parent-links");
const DEFAULT_ATTENDANCE_LIMIT = 100;
const MAX_ATTENDANCE_LIMIT = 200;
const parseAttendanceLimit = (raw) => {
    if (raw === undefined)
        return DEFAULT_ATTENDANCE_LIMIT;
    const value = Array.isArray(raw) ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < 1)
        return null;
    return Math.min(value, MAX_ATTENDANCE_LIMIT);
};
const createParentViewAuth = (verifier) => async (req, res, next) => {
    try {
        const header = req.headers.authorization;
        const match = header ? /^Bearer\s+([^\s]+)$/i.exec(header) : null;
        if (!match)
            return res.status(401).json({ error: 'Authentication required' });
        const result = await verifier.verify(match[1]);
        if (!result.ok) {
            if (result.reason === 'secret-unavailable')
                return res.status(503).json({ error: 'Parent views are not available' });
            if (result.reason === 'expired')
                return res.status(401).json({ error: 'Parent view token expired' });
            if (result.reason === 'revoked-link' || result.reason === 'revoked-token') {
                return res.status(401).json({ error: 'Parent link is no longer active' });
            }
            return res.status(401).json({ error: 'Invalid parent view token' });
        }
        req.parentView = {
            linkId: result.claims.link_id,
            tenantId: result.claims.tenant_id,
            studentEnrollmentId: result.claims.student_enrollment_id,
            parentUserId: result.claims.parent_user_id,
        };
        next();
    }
    catch (error) {
        console.error('Parent view auth error:', error);
        res.status(500).json({ error: 'Failed to authenticate the parent view' });
    }
};
exports.createParentViewAuth = createParentViewAuth;
const createParentViewsRouter = (deps) => {
    const router = (0, express_1.Router)();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    if (deps.familyDb)
        router.use('/family-summary', (0, family_summary_1.createFamilySummaryRouter)({ db: deps.familyDb, verifier: deps.verifier, now: deps.now }));
    router.use((0, exports.createParentViewAuth)(deps.verifier));
    const scope = (req) => req.parentView ?? null;
    router.get('/child', async (req, res) => {
        const view = scope(req);
        if (!view)
            return res.status(401).json({ error: 'Authentication required' });
        try {
            const child = await deps.store.findChildSummary(view.tenantId, view.studentEnrollmentId);
            if (!child)
                return res.status(404).json({ error: 'Child not found' });
            res.json(child);
        }
        catch (error) {
            console.error('Parent child view error:', error);
            res.status(500).json({ error: 'Failed to load the child summary' });
        }
    });
    router.get('/lesson-progress', async (req, res) => {
        const view = scope(req);
        if (!view)
            return res.status(401).json({ error: 'Authentication required' });
        try {
            res.json(await deps.store.lessonProgressSummary(view.tenantId, view.studentEnrollmentId));
        }
        catch (error) {
            console.error('Parent lesson progress error:', error);
            res.status(500).json({ error: 'Failed to load lesson progress' });
        }
    });
    router.get('/attendance', async (req, res) => {
        const view = scope(req);
        if (!view)
            return res.status(401).json({ error: 'Authentication required' });
        const limit = parseAttendanceLimit(req.query.limit);
        if (limit === null)
            return res.status(400).json({ error: 'limit must be a positive integer' });
        try {
            res.json(await deps.store.attendanceRecords(view.tenantId, view.studentEnrollmentId, limit));
        }
        catch (error) {
            console.error('Parent attendance view error:', error);
            res.status(500).json({ error: 'Failed to load attendance records' });
        }
    });
    router.get('/grades', async (req, res) => {
        const view = scope(req);
        if (!view)
            return res.status(401).json({ error: 'Authentication required' });
        // The legacy aggregate has no family-publication decision per source.
        // A recorded score is not permission to publish it to the family.
        // Keep the authenticated URL, but do not query or expose its scores.
        return res.status(503).json({ code: 'PARENT_GRADE_PUBLICATION_UNCONFIGURED', error: 'Published family grades are not configured' });
    });
    return router;
};
exports.createParentViewsRouter = createParentViewsRouter;
function createSqlParentViewsStore(db) {
    const toIso = (value) => {
        if (value === null || value === undefined)
            return null;
        const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value) || 0);
    /**
     * The liveness contract `isStudentEnrollmentActive` applies when a parent
     * link is created, re-applied at READ time.
     *
     * A parent token is bound to a LINK, and `createParentViewVerifier`
     * re-checks that link and the token on every request — but nothing
     * re-checked the STUDENT. A link minted while the child was active kept
     * disclosing grades, attendance and progress after the enrollment was
     * deactivated, rejected, or past its end date, until the token expired.
     * Every other read path in this lane re-checks current eligibility on the
     * request (attendance-records, video access), so this is that same rule,
     * not a new one. The predicates mirror `isStudentEnrollmentActive` in
     * `services/parent-links.ts` exactly; the alias is a code literal, never
     * input.
     */
    const liveEnrollmentSql = (alias) => `
              ${alias}.is_active = TRUE
          AND (${alias}.approval_status IS NULL OR ${alias}.approval_status = 'approved')
          AND (${alias}.enrollment_status IS NULL OR ${alias}.enrollment_status = 'active')
          AND (${alias}.enrollment_start_date IS NULL OR ${alias}.enrollment_start_date <= UTC_TIMESTAMP())
          AND (${alias}.enrollment_end_date IS NULL OR ${alias}.enrollment_end_date > UTC_TIMESTAMP())`;
    return {
        findChildSummary: async (tenantId, enrollmentId) => db.queryOne(`SELECT s.id AS enrollment_id, s.name, g.name AS grade, grp.name AS \`group\`,
                    s.term, s.enrollment_status, s.created_at AS enrolled_at
             FROM students s
             LEFT JOIN grades g ON g.id = s.grade_id
             LEFT JOIN \`groups\` grp ON grp.id = s.group_id
             WHERE s.id = ? AND s.tenant_id = ?
               AND ${liveEnrollmentSql('s')} LIMIT 1`, [enrollmentId, tenantId]),
        lessonProgressSummary: async (tenantId, enrollmentId) => {
            const rows = await db.query(`SELECT c.id AS course_id, c.name AS course_name,
                        (SELECT COUNT(*) FROM lectures l
                          WHERE l.course_id = c.id AND l.is_published = 1 AND l.archived_at IS NULL) AS total_lessons,
                        (SELECT COUNT(*) FROM lesson_completions lc
                          JOIN lectures l2 ON l2.id = lc.lecture_id
                          WHERE lc.student_enrollment_id = ? AND lc.course_id = c.id
                            AND l2.is_published = 1 AND l2.archived_at IS NULL) AS completed_lessons
                 FROM courses c
                 WHERE c.tenant_id = ? AND c.is_active = 1
                   AND EXISTS (SELECT 1 FROM student_courses sc WHERE sc.student_id = ? AND sc.course_id = c.id)
                   AND EXISTS (SELECT 1 FROM students ls WHERE ls.id = ? AND ls.tenant_id = ?
                               AND ${liveEnrollmentSql('ls')})
                 ORDER BY c.name`, [enrollmentId, tenantId, enrollmentId, enrollmentId, tenantId]);
            const courses = rows.map((row) => ({
                course_id: String(row.course_id),
                course_name: String(row.course_name),
                completed_lessons: toNumber(row.completed_lessons),
                total_lessons: toNumber(row.total_lessons),
            }));
            return {
                courses,
                totals: {
                    completed_lessons: courses.reduce((sum, course) => sum + course.completed_lessons, 0),
                    total_lessons: courses.reduce((sum, course) => sum + course.total_lessons, 0),
                },
            };
        },
        attendanceRecords: async (tenantId, enrollmentId, limit) => {
            // Keep the interpolated LIMIT bounded at this exported store boundary; it is a
            // number in the SQL text. The router sanitises it, but this adapter
            // is exported: a second caller must not be able to inject through it,
            // so the clamp lives here too and a non-integer falls back instead of
            // reaching the statement.
            const boundedLimit = Number.isInteger(limit)
                ? Math.min(Math.max(limit, 1), MAX_ATTENDANCE_LIMIT)
                : DEFAULT_ATTENDANCE_LIMIT;
            return db.query(`SELECT a.session_id, ss.title, ss.starts_at, a.state, a.marked_at
                 FROM attendance_records a
                 JOIN schedule_sessions ss ON ss.id = a.session_id
                 WHERE a.tenant_id = ? AND a.student_id = ?
                   AND EXISTS (SELECT 1 FROM students ls WHERE ls.id = ? AND ls.tenant_id = ?
                               AND ${liveEnrollmentSql('ls')})
                 ORDER BY ss.starts_at DESC LIMIT ${boundedLimit}`, [tenantId, enrollmentId, enrollmentId, tenantId]);
        },
        gradeSummary: async (tenantId, enrollmentId) => {
            const rows = await db.query(`SELECT c.id AS course_id, c.name AS course_name,
                        SUM(gs.score) AS total_score, SUM(gs.max_score) AS total_max,
                        COUNT(*) AS items, MAX(gs.recorded_at) AS last_recorded_at
                 FROM gradebook_scores gs
                 JOIN courses c ON c.id = gs.course_id AND c.tenant_id = ?
                 WHERE gs.tenant_id = ? AND gs.student_enrollment_id = ?
                   AND EXISTS (SELECT 1 FROM students ls WHERE ls.id = ? AND ls.tenant_id = ?
                               AND ${liveEnrollmentSql('ls')})
                 GROUP BY c.id, c.name
                 ORDER BY c.name`, [tenantId, tenantId, enrollmentId, enrollmentId, tenantId]);
            return {
                courses: rows.map((row) => ({
                    course_id: String(row.course_id),
                    course_name: String(row.course_name),
                    total_score: toNumber(row.total_score),
                    total_max: toNumber(row.total_max),
                    items: toNumber(row.items),
                    last_recorded_at: toIso(row.last_recorded_at),
                })),
            };
        },
    };
}
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
exports.default = (0, exports.createParentViewsRouter)({
    familyDb: productionDb,
    store: createSqlParentViewsStore(productionDb),
    verifier: (0, parent_links_1.createParentViewVerifier)({
        store: (0, parent_links_1.createSqlParentLinksStore)(productionDb),
        getSecret: () => process.env.PARENT_VIEW_SECRET,
    }),
});
