"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPublicIdentityRouter = void 0;
exports.parsePublicPagination = parsePublicPagination;
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const defaultDeps = { query: db_1.query, queryOne: db_1.queryOne };
/** Bounded pagination for public listings. Never throws; hard-caps at 100. */
function parsePublicPagination(input) {
    const rec = (typeof input === 'object' && input !== null ? input : {});
    const num = (v) => {
        if (typeof v === 'number' && Number.isInteger(v))
            return v;
        if (typeof v === 'string' && v.trim() !== '' && Number.isInteger(Number(v)))
            return Number(v);
        return null;
    };
    let limit = num(rec['limit']) ?? 24;
    if (limit < 1)
        limit = 1;
    if (limit > 100)
        limit = 100;
    const page = num(rec['page']);
    const rawOffset = num(rec['offset']);
    let offset = page !== null && page >= 1 ? (page - 1) * limit : rawOffset ?? 0;
    if (offset < 0)
        offset = 0;
    if (offset > 100000)
        offset = 100000;
    return { limit, offset };
}
/**
 * C1/C4 public identity pages.
 *
 * Every projection here is deliberately narrow: only non-private fields are
 * SELECTed (no phone/email/finance/secrets/staff flags), the tenant/teacher is
 * server-resolved (never caller authority), and no unpublished file/video
 * keys/URLs/session tokens are ever returned. Drafts/archived resources are
 * hidden by the explicit `publication_state` + `is_active` + active-tenant
 * gates.
 *
 * SCOPE: this router owns the public teacher/center page ONLY. Published-course
 * discovery (`GET /courses`) is owned EXCLUSIVELY by
 * `src/routes/public-catalog.ts` (M2-22 contract: `{ courses, next_cursor }`).
 * The legacy discovery handler that used to live here answered an Array with an
 * `is_active`-only filter and leaked drafts; it was removed rather than
 * re-gated, so exactly ONE endpoint serves public course discovery and the
 * mount order in `src/index.ts` can never resurrect it.
 */
const createPublicIdentityRouter = (deps = defaultDeps) => {
    const router = (0, express_1.Router)();
    router.use(auth_1.optionalAuth);
    // Teacher/center public page. The teacher id is their public user uuid; the
    // center name comes from their active owned tenant. Only EXPLICITLY
    // PUBLISHED courses are returned, via the same publication + archive +
    // active-tenant gate the M2-22 public catalog applies: `is_active` alone
    // leaked drafts, so publication is required here too.
    router.get('/teachers/:id', async (req, res) => {
        // Publication can be withdrawn at any time, so a cached teacher page
        // could serve a course the owner has since unpublished. The page is
        // therefore never cached: every outcome (including 404 / 500) carries
        // `no-store`, matching the M2-22 public catalog surface.
        res.set('Cache-Control', 'no-store');
        try {
            const teacherId = String(req.params.id || '');
            if (!/^[0-9a-fA-F-]{36}$/.test(teacherId))
                return res.status(404).json({ error: 'Not found' });
            const teacher = await deps.queryOne(`SELECT u.id, u.name FROM users u WHERE u.id=? AND u.is_active=1 AND u.role IN ('instructor','teacher') LIMIT 1`, [teacherId]);
            if (!teacher)
                return res.status(404).json({ error: 'Not found' });
            const tenant = await deps.queryOne(`SELECT t.id, t.business_name FROM tenants t WHERE t.owner_user_id=? AND t.status='active' LIMIT 1`, [teacherId]);
            const courses = await deps.query(`SELECT c.id,c.name,c.subject,c.description,c.grade,c.price
                 FROM courses c INNER JOIN tenants ct ON ct.id=c.tenant_id
                 WHERE c.is_active=1 AND c.publication_state='published' AND ct.status='active' AND (c.instructor_id=? OR ct.owner_user_id=?)
                 ORDER BY c.name LIMIT 100`, [teacherId, teacherId]);
            res.json({
                id: teacher.id,
                name: teacher.name,
                center: tenant ? { id: tenant.id, business_name: tenant.business_name } : null,
                published_courses: courses,
            });
        }
        catch {
            return res.status(500).json({ error: 'Failed to load teacher page' });
        }
    });
    // NOTE: `GET /courses` used to be handled here. That handler answered an
    // Array with an `is_active`-only filter (leaking drafts) and it was mounted
    // BEFORE the M2-22 catalog router, so it shadowed the canonical
    // `{ courses, next_cursor }` contract. Published-course discovery now lives
    // exclusively in `src/routes/public-catalog.ts`; this router deliberately
    // registers NO course-list route, so the two surfaces can never collide
    // again regardless of mount order.
    return router;
};
exports.createPublicIdentityRouter = createPublicIdentityRouter;
const router = (0, exports.createPublicIdentityRouter)();
exports.default = router;
