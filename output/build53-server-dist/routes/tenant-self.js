"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTenantSelfRouter = void 0;
const crypto_1 = require("crypto");
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const db_1 = require("../db");
const auth_1 = require("../middleware/auth");
const course_units_1 = require("./course-units");
const course_lessons_1 = require("./course-lessons");
const lesson_package_templates_1 = require("./lesson-package-templates");
const lesson_preparation_1 = require("./lesson-preparation");
const group_setup_1 = require("./group-setup");
const student_offline_setup_1 = require("./student-offline-setup");
const student_account_link_1 = require("./student-account-link");
const question_grading_1 = require("./question-grading");
const season_course_reuse_1 = require("./season-course-reuse");
const season_template_import_1 = require("./season-template-import");
const course_return_plan_1 = require("./course-return-plan");
const student_return_plans_1 = require("./student-return-plans");
const tenant_branding_1 = require("./tenant-branding");
const academic_periods_1 = require("./academic-periods");
const student_import_resolution_1 = require("./student-import-resolution");
const minio_1 = require("../services/minio");
const subscription_renewal_1 = require("../services/subscription-renewal");
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const money = (value) => {
    const text = String(value ?? '').trim();
    return /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text) && Number(text) > 0 ? text : null;
};
const proofType = (file) => {
    const b = file.buffer;
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return { contentType: 'image/jpeg', ext: 'jpg' };
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return { contentType: 'image/png', ext: 'png' };
    if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP')
        return { contentType: 'image/webp', ext: 'webp' };
    if (b.length >= 5 && b.subarray(0, 5).toString() === '%PDF-')
        return { contentType: 'application/pdf', ext: 'pdf' };
    return null;
};
/**
 * M2-B03 branch metadata constants. A branch belongs to exactly one tenant and
 * carries metadata only: no assignment, enrollment, pricing or capacity data.
 */
const BRANCH_STATUSES = ['active', 'archived'];
const BRANCH_NAME_MAX = 255;
const BRANCH_PAGE_DEFAULT = 25;
const BRANCH_PAGE_MAX = 100;
/** A server-generated identity. A client-supplied value is only a selector. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A branch id is a server-generated UUID; a client-supplied id is only a selector. */
const BRANCH_ID_PATTERN = UUID_PATTERN;
/** A membership id has the same shape; the client value is only a selector. */
const MEMBERSHIP_ID_PATTERN = UUID_PATTERN;
/**
 * Explicit branch DTO. The row is never spread into the response: only the
 * five documented columns are exposed, and `tenant_id` stays server-owned.
 */
const branchDto = (row) => ({
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
});
/**
 * Opaque list cursor. It encodes a POSITION (the id of the last row of the
 * previous page) and never carries authority: the list still qualifies the
 * selected tenant, so a cursor minted for another tenant is only a position.
 */
const encodeBranchCursor = (id) => Buffer.from(String(id), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const decodeBranchCursor = (cursor) => {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 128)
        return null;
    if (!/^[A-Za-z0-9_-]+$/.test(cursor))
        return null;
    let decoded = '';
    try {
        decoded = Buffer.from(cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
    catch {
        return null;
    }
    return BRANCH_ID_PATTERN.test(decoded) ? decoded : null;
};
/** Strict page-size parsing: an integer 1..100, default 25. */
const parseBranchLimit = (raw) => {
    if (raw === undefined)
        return BRANCH_PAGE_DEFAULT;
    if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw))
        return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > BRANCH_PAGE_MAX)
        return null;
    return value;
};
/** Strict branch-name validation: a string that trims to 1..255 characters. */
const parseBranchName = (raw) => {
    if (typeof raw !== 'string')
        return null;
    const name = raw.trim();
    if (name.length < 1 || name.length > BRANCH_NAME_MAX)
        return null;
    return name;
};
// ---------------------------------------------------------------------------
// M2-B12 — private instructor branch-assignment organization metadata
//
// The record answers ONE question the verified owner could not answer before:
// which ACTIVE branch of THIS tenant an EXISTING active instructor membership
// is organized under. It is planning metadata only.
//
// Nothing below changes a role, a permission, teaching access, a course, a
// group, a student, an enrollment, a login/invitation, a price or a billing
// state: the `tenant_memberships` row keeps its `role_key` and `status`
// untouched, no other table is written, and no authorization decision anywhere
// in the application consults the recorded branch.
// ---------------------------------------------------------------------------
/** The only membership role this surface lists or writes. */
const INSTRUCTOR_ROLE_KEY = 'instructor';
/** The bounded display label of a user row, capped at the column width. */
const INSTRUCTOR_NAME_MAX = 255;
/**
 * The same strict 1..100 page-size parser the branch list uses, named for the
 * membership list so the two pages cannot drift apart silently.
 */
const parseMembershipLimit = (raw) => parseBranchLimit(raw);
/**
 * Opaque membership-list cursor. It encodes a POSITION (the id of the last row
 * of the previous page) and never carries authority: the page is still
 * qualified by the selected tenant, so a cursor minted elsewhere is only a
 * position.
 */
const encodeMembershipCursor = (id) => encodeBranchCursor(id);
const decodeMembershipCursor = (cursor) => decodeBranchCursor(cursor);
/** A bounded display label: trimmed and capped, never a raw column echo. */
const boundedDisplayName = (value) => {
    const text = String(value ?? '').trim();
    return text.length > INSTRUCTOR_NAME_MAX ? text.slice(0, INSTRUCTOR_NAME_MAX) : text;
};
/**
 * Explicit instructor-membership DTO. The row is never spread into the
 * response: exactly the five documented fields are exposed, so `tenant_id`,
 * `role_key`, `status`, `created_at` and every user column stay server-owned.
 */
const instructorMembershipDto = (row) => ({
    membership_id: String(row.membership_id),
    instructor_id: String(row.instructor_id),
    instructor_name: boundedDisplayName(row.instructor_name),
    branch_id: row.branch_id === null || row.branch_id === undefined ? null : String(row.branch_id),
    branch_name: row.branch_name === null || row.branch_name === undefined ? null : boundedDisplayName(row.branch_name),
});
/**
 * M2-B12 statements. Every one is tenant-qualified, and every write path runs
 * on ONE connection inside ONE transaction.
 *
 * `INSTRUCTOR_MEMBERSHIP_LIST_SQL` is the bounded keyset page: the selected
 * tenant, the instructor role, an ACTIVE membership and an ACTIVE user, then a
 * strict `id > cursor` position and a `LIMIT` that carries one extra row so the
 * handler can learn whether another page exists.
 *
 * `INSTRUCTOR_MEMBERSHIP_LOCK_SQL` is the write-side authority read. It is
 * qualified by the SAME four conditions and locked `FOR UPDATE`, so a foreign,
 * non-instructor, inactive or deleted membership is indistinguishable from an
 * absent one. The branch name is joined tenant-qualified purely to build the
 * audit `old_value`; it grants nothing.
 *
 * `INSTRUCTOR_BRANCH_LOCK_SQL` is the target check: the branch must EXIST, be
 * ACTIVE and belong to the SAME tenant, and it is locked too. A foreign,
 * archived or absent branch is therefore one outcome, never a cross-tenant
 * existence oracle.
 *
 * `INSTRUCTOR_MEMBERSHIP_UPDATE_SQL` writes the single nullable column and is
 * qualified by both the membership id and the selected tenant.
 *
 * `INSTRUCTOR_MEMBERSHIP_READ_SQL` is the post-write read-back: the same
 * tenant-qualified left join that can never surface a foreign branch name.
 */
const INSTRUCTOR_MEMBERSHIP_LIST_SQL = 'SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS branch_name ' +
    'FROM tenant_memberships m ' +
    'JOIN users u ON u.id=m.user_id ' +
    'LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id ' +
    "WHERE m.tenant_id=? AND m.role_key=? AND m.status='active' AND u.is_active=1 AND m.id>? " +
    'ORDER BY m.id ASC LIMIT ?';
const INSTRUCTOR_MEMBERSHIP_LOCK_SQL = 'SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS current_branch_name ' +
    'FROM tenant_memberships m ' +
    'JOIN users u ON u.id=m.user_id ' +
    'LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id ' +
    "WHERE m.id=? AND m.tenant_id=? AND m.role_key=? AND m.status='active' AND u.is_active=1 " +
    'FOR UPDATE';
const INSTRUCTOR_BRANCH_LOCK_SQL = "SELECT b.id,b.name FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? AND b.status='active' FOR UPDATE";
const INSTRUCTOR_MEMBERSHIP_UPDATE_SQL = 'UPDATE tenant_memberships SET branch_id=? WHERE id=? AND tenant_id=?';
const INSTRUCTOR_MEMBERSHIP_READ_SQL = 'SELECT m.id AS membership_id,m.user_id AS instructor_id,u.name AS instructor_name,m.branch_id,b.name AS branch_name ' +
    'FROM tenant_memberships m ' +
    'JOIN users u ON u.id=m.user_id ' +
    'LEFT JOIN tenant_branches b ON b.id=m.branch_id AND b.tenant_id=m.tenant_id ' +
    'WHERE m.id=? AND m.tenant_id=? LIMIT 1';
const createTenantSelfRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { query, queryOne, execute, getConnection } = deps.db;
    const { loadActiveTenantAuthority, uploadBuffer, deleteFile, getPrivateObjectUrl, executeRenewalIntent: runRenewalIntent } = deps;
    router.use(deps.authenticate);
    // -------------------------------------------------------------------------
    // M2-B04 — private course-unit metadata (owner-only, additive)
    //
    // The unit router is a separate, injected module (routes/course-units.ts):
    // it owns its own strict metadata contract and receives only the existing
    // transactional connection supplier. It is mounted here, AFTER the
    // authentication middleware, so every unit route is authenticated and the
    // billing-only exemption of the /api/tenants/me prefix is handled locally
    // inside the unit module. Nothing else in this router is touched.
    // -------------------------------------------------------------------------
    router.use('/catalog', (0, course_units_1.createCourseUnitsRouter)({ getConnection }));
    // -------------------------------------------------------------------------
    // M2-B05 — private course-lesson metadata (owner-only, additive)
    //
    // The lesson router is a separate, injected module
    // (routes/course-lessons.ts): it owns its own strict metadata contract,
    // receives the existing connection supplier and optional private-file config, and is
    // mounted here, AFTER the authentication middleware and next to the unit
    // router, so every lesson route is authenticated and the billing-only
    // exemption of the /api/tenants/me prefix is handled locally inside the
    // lesson module. Nothing else in this router is touched.
    // -------------------------------------------------------------------------
    router.use('/catalog', (0, course_lessons_1.createCourseLessonsRouter)({ getConnection, materialFileIngestion: deps.materialFileIngestion }));
    // -------------------------------------------------------------------------
    // J02 — private same-course saved lesson templates (owner-only, additive)
    //
    // The template router is a separate, injected module
    // (routes/lesson-package-templates.ts): it receives only the existing
    // transactional connection supplier and is mounted next to the lesson router
    // under /catalog, so every template route is authenticated and the
    // billing-only exemption of the /api/tenants/me prefix is handled locally
    // inside the module. The existing lesson module and its reserved files are
    // untouched.
    // -------------------------------------------------------------------------
    router.use('/catalog', (0, lesson_package_templates_1.createLessonPackageTemplatesRouter)({ getConnection }));
    router.use('/catalog', (0, lesson_preparation_1.createLessonPreparationRouter)({ getConnection }));
    router.use('/catalog', (0, group_setup_1.createGroupSetupRouter)({ getConnection }));
    router.use('/catalog', (0, student_offline_setup_1.createStudentOfflineSetupRouter)({ getConnection }));
    router.use('/catalog', (0, student_account_link_1.createStudentAccountLinkOwnerRouter)({ getConnection, otpKey: () => process.env.OTP_HMAC_SECRET }));
    router.use('/catalog', (0, question_grading_1.createQuestionGradingRouter)({ getConnection }));
    router.use('/catalog', (0, season_course_reuse_1.createSeasonCourseReuseRouter)({ getConnection }));
    router.use('/catalog', (0, season_template_import_1.createSeasonTemplateImportRouter)({ getConnection }));
    router.use('/catalog', (0, course_return_plan_1.createCourseReturnPlanRouter)({ getConnection }));
    router.use('/catalog', (0, student_return_plans_1.createStudentReturnPlansRouter)({ getConnection }));
    // -------------------------------------------------------------------------
    // M2-B06 — private localized branding metadata (owner-only, additive)
    //
    // The branding router is a separate, injected module
    // (routes/tenant-branding.ts): it owns its own strict branding contract,
    // receives only the existing transactional connection supplier, and is
    // mounted here, AFTER the authentication middleware, so both branding routes
    // are authenticated and the billing-only exemption of the /api/tenants/me
    // prefix is handled locally inside the branding module. Nothing else in this
    // router is touched: the profile, subscription, billing, top-up, renewal and
    // branch handlers above/below stay byte-for-byte unchanged.
    // -------------------------------------------------------------------------
    router.use('/branding', (0, tenant_branding_1.createLocalizedTenantBrandingRouter)({ getConnection }));
    // -------------------------------------------------------------------------
    // M2-B07 — private academic-period planning catalog (owner-only, additive)
    //
    // The academic-period router is a separate, injected module
    // (routes/academic-periods.ts): it owns its own strict period contract,
    // receives only the existing transactional connection supplier, and is
    // mounted here, AFTER the authentication middleware, so all three period
    // routes are authenticated and the billing-only exemption of the
    // /api/tenants/me prefix is handled locally inside the period module.
    // Nothing else in this router is touched: the profile, subscription,
    // billing, top-up, renewal, branch and branding handlers/mounts above/below
    // stay byte-for-byte unchanged.
    // -------------------------------------------------------------------------
    router.use('/academic-periods', (0, academic_periods_1.createAcademicPeriodsRouter)({ getConnection }));
    // -------------------------------------------------------------------------
    // M2-B08 — private READ-ONLY student-import reconciliation (owner-only,
    // additive)
    //
    // The resolution router is a separate, injected module
    // (routes/student-import-resolution.ts): it owns its own strict bounded
    // reconciliation contract, receives only the existing connection supplier,
    // and is mounted here, AFTER the authentication middleware, so the route is
    // authenticated and the billing-only exemption of the /api/tenants/me prefix
    // is handled locally inside the module. Its reconciliation route performs
    // READS ONLY: no student, user, enrollment or import write, no audit event
    // and no transaction exists anywhere in it.
    //
    // M2-16 (additive, same module): the commit route beside the reconciliation
    // route is the module's only mutation. It receives the SAME pooled
    // connection supplier through the dedicated transactional seam, so the write
    // path can open a transaction while the read path structurally cannot. The
    // tenant-self connection seam already exposes exactly the transactional
    // methods the commit route needs (execute/beginTransaction/commit/rollback/
    // release/destroy), so nothing else in this router changes and no other
    // route, middleware or dependency is touched.
    // -------------------------------------------------------------------------
    router.use('/student-import', (0, student_import_resolution_1.createStudentImportResolutionRouter)({
        getConnection,
        getCommitConnection: getConnection,
    }));
    /**
     * Resolve the caller's tenant inside the server-selected workspace only.
     * Authority mirrors the server-owned tenant-authority contract used by the
     * finance and video routers: the verified owner row, or an active membership
     * with role_key owner/instructor in an active tenant by an active user,
     * keyed by the tenant the authentication middleware selected from the token
     * selector against the caller's active memberships. An arbitrary LIMIT 1
     * membership, a forged tenant id, or an unselected workspace never resolves.
     */
    async function getOwnedTenant(req, opts = {}) {
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return null;
        const authority = await loadActiveTenantAuthority(userId, tenantId);
        if (!authority)
            return null;
        // Both projections are a single statement on the already-selected tenant.
        // The default (billing/renewal) projection is kept byte-identical because
        // existing hermetic suites assert this exact statement text and live
        // outside this change's scope. The profile projection is the minimal
        // four-field read and adds the existing nullable `subject_type` column
        // without spreading the row or exposing owner/billing/contact fields.
        const columns = opts.includeSubjectType
            ? 't.id,t.business_name,t.subject_type,t.status'
            : 't.id,t.business_name,t.status,t.legacy_compat,t.owner_user_id';
        return queryOne(`SELECT ${columns}
       FROM tenants t WHERE t.id=? LIMIT 1`, [tenantId]);
    }
    /**
     * GET /api/tenants/me/profile — minimal institution identity of the tenant
     * the server selected from the caller's active memberships. Read-only and
     * selector-free: no tenant id is accepted from header/query/body, no
     * fallback to an arbitrary membership, and the response is a fixed
     * four-field DTO (never a row spread). An unselected workspace or a
     * principal without server-owned authority keeps the existing 404 outcome;
     * authentication/boundary outcomes are unchanged. `Cache-Control: no-store`
     * is set before the first await, so the 200, the own 404 and both 500 paths
     * all carry it; the upstream 401/403/409/400 answers are untouched.
     */
    router.get('/profile', async (req, res) => {
        // Cache directive is applied before the first await and before any denial,
        // so every outcome this handler can produce — 200, own 404 and both 500
        // paths — carries the same `no-store`. Setting it only on success would
        // leave the 404/500 responses cacheable by any intermediary.
        res.set('Cache-Control', 'no-store');
        try {
            const tenant = await getOwnedTenant(req, { includeSubjectType: true });
            if (!tenant)
                return res.status(404).json({ error: 'Tenant membership not found' });
            return res.json({
                tenant: {
                    id: tenant.id,
                    business_name: tenant.business_name,
                    subject_type: tenant.subject_type ?? null,
                    status: tenant.status,
                },
            });
        }
        catch (error) {
            console.error('Get tenant profile error:', error);
            return res.status(500).json({ error: 'Failed to load tenant profile' });
        }
    });
    /**
     * PATCH /api/tenants/me/profile — institution-name-only update.
     *
     * Name-only and verified-owner-only: the caller must be the tenants.owner_user_id
     * of the server-selected tenant, that tenant must be active, and the caller's
     * user row must be active — all re-verified on the transaction connection under
     * `FOR UPDATE`. An instructor/owner membership label alone never grants this
     * write. The payload is a strict single-field object; unknown, selector or
     * non-string/empty/over-255 values are rejected before any connection is taken.
     * Name and audit commit together; if the audit insert fails the name update
     * rolls back, and success is only reported after `commit()` resolves. An
     * identical retry is a truthful no-op: the same name writes and audits nothing.
     * A failed acquisition returns the same safe 500 without touching a
     * nonexistent connection. A confirmed rollback (or committed transaction)
     * releases the connection exactly once; a failed rollback or an uncertain
     * commit destroys it instead, so it can never re-enter the shared pool with an
     * open transaction. `Cache-Control: no-store` is set before the first await /
     * any denial so every outcome this handler produces carries it.
     */
    router.patch('/profile', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        const invalid = () => res.status(400).json({ error: 'Invalid profile update payload' });
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return invalid();
        const keys = Object.keys(body);
        if (keys.length !== 1 || keys[0] !== 'business_name')
            return invalid();
        const rawName = body.business_name;
        if (typeof rawName !== 'string')
            return invalid();
        const name = rawName.trim();
        if (name.length < 1 || name.length > 255)
            return invalid();
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        // The connection is tracked explicitly: a failed acquisition has nothing to
        // clean up, while an uncertain transaction must be destroyed rather than
        // returned to the shared pool.
        let connection = null;
        let transactionStarted = false;
        let commitAttempted = false;
        let disposal = 'release';
        const rollbackOrDiscard = async () => {
            try {
                await connection.rollback();
                return true;
            }
            catch (rollbackError) {
                disposal = 'destroy';
                console.error('Rollback tenant profile error (connection will be discarded):', rollbackError);
                return false;
            }
        };
        try {
            connection = await getConnection();
            await connection.beginTransaction();
            transactionStarted = true;
            // Server-owned owner authority under lock, on the transaction connection:
            // the selected tenant's actual owner_user_id and status joined to the
            // caller's own active user row. A membership role label never reaches here.
            const [rows] = await connection.execute(`SELECT t.business_name,t.subject_type,t.status AS tenant_status,t.owner_user_id,u.is_active AS caller_active
         FROM tenants t JOIN users u WHERE t.id=? AND u.id=? FOR UPDATE`, [tenantId, userId]);
            const row = rows[0];
            if (!row || row.owner_user_id !== userId || row.tenant_status !== 'active' || Number(row.caller_active) !== 1) {
                await rollbackOrDiscard();
                return res.status(404).json({ error: 'Tenant membership not found' });
            }
            const currentName = String(row.business_name);
            if (currentName === name) {
                // Truthful no-op: identical retry writes and audits nothing.
                await rollbackOrDiscard();
                return res.json({
                    tenant: { id: tenantId, business_name: currentName, subject_type: row.subject_type ?? null, status: row.tenant_status },
                });
            }
            const [updateResult] = await connection.execute('UPDATE tenants SET business_name=? WHERE id=? AND owner_user_id=?', [name, tenantId, userId]);
            if (Number(updateResult?.affectedRows) !== 1) {
                await rollbackOrDiscard();
                return res.status(409).json({ error: 'Tenant profile was modified concurrently' });
            }
            await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), userId, tenantId, 'tenant.profile_name_updated', 'tenant', tenantId,
                JSON.stringify({ business_name: currentName }), JSON.stringify({ business_name: name })]);
            commitAttempted = true;
            await connection.commit();
            return res.json({
                tenant: { id: tenantId, business_name: name, subject_type: row.subject_type ?? null, status: row.tenant_status },
            });
        }
        catch (error) {
            if (commitAttempted) {
                // The commit acknowledgement was lost: whether the write persisted is
                // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
                // never return this connection to the pool.
                disposal = 'destroy';
                console.error('Update tenant profile error after commit attempt (persistence uncertain):', error);
            }
            else if (transactionStarted) {
                console.error('Update tenant profile error:', error);
                await rollbackOrDiscard();
            }
            else {
                // The connection was obtained but `beginTransaction` failed, so the
                // server-side transaction state is not confirmed. Discard rather than
                // pooling a possibly-dirty session. Acquisition failure skips cleanup
                // entirely because no connection exists.
                disposal = 'destroy';
                console.error('Update tenant profile error before transaction start:', error);
            }
            return res.status(500).json({ error: 'Failed to update tenant profile' });
        }
        finally {
            if (connection) {
                if (disposal === 'destroy') {
                    try {
                        connection.destroy();
                    }
                    catch { /* connection already gone */ }
                }
                else {
                    try {
                        connection.release();
                    }
                    catch { /* connection already released */ }
                }
            }
        }
    });
    // -------------------------------------------------------------------------
    // M2-B03 — tenant-owned branch metadata (owner-only, additive)
    //
    // Branch metadata is a NEW surface, not an extension of the instructor
    // profile read authority: only the verified owner of the server-selected
    // tenant may list, create, rename or archive a branch of that tenant.
    // A branch row is metadata only — archiving it grants or revokes no course,
    // group, student or teacher access, and nothing here writes assignments,
    // enrollments, wallet or subscription data.
    // -------------------------------------------------------------------------
    /**
     * Local billing-only denial for the M2-B03 branch routes.
     *
     * `auth.ts` exempts the WHOLE /api/tenants/me prefix from the instructor
     * billing-only path restriction, so merely mounting a route below that
     * prefix does NOT enforce the denial. Each branch route therefore checks
     * `req.user.billingOnly` itself and refuses BEFORE any data access. The
     * shared authentication middleware, its exemptions and the existing
     * billing/support/profile handlers are left untouched.
     */
    const denyBillingOnly = (req, res) => {
        if (!req.user?.billingOnly)
            return false;
        // The message is deliberately specific to branch management so the local
        // guard is distinguishable from the upstream authentication denial.
        res.status(403).json({
            error: 'Branch management is not available while the account is limited to billing and support',
            code: 'BILLING_ONLY',
        });
        return true;
    };
    /**
     * Verify that the caller is the owner of the SELECTED tenant.
     *
     * The check is resolved from server-side rows only, on the same connection
     * that performs the branch work: the tenant's real `owner_user_id`, its
     * status and the caller's own active user row. A membership role label
     * (`owner`/`instructor`) never grants branch visibility or writes.
     *
     * `lock` selects the rows FOR UPDATE so a write cannot race an ownership
     * change. The list read uses a plain snapshot select inside its own
     * transaction, so the verification and the page read share one snapshot
     * without taking an exclusive lock on a read path.
     */
    const verifyBranchOwner = async (connection, userId, tenantId, lock) => {
        const [rows] = await connection.execute(`SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
       FROM tenants t JOIN users u ON u.id=? WHERE t.id=?${lock ? ' FOR UPDATE' : ''}`, [userId, tenantId]);
        const row = rows[0];
        if (!row || String(row.owner_user_id) !== userId || row.tenant_status !== 'active' || Number(row.caller_active) !== 1) {
            return null;
        }
        return row;
    };
    /**
     * GET /api/tenants/me/branches — owner-only bounded list of the branches of
     * the server-selected tenant.
     *
     * The list is deterministic and bounded: rows are ordered by the branch id
     * (a total, stable order that needs no timestamp/timezone interpretation)
     * and read with a keyset cursor, so no page is unbounded and no offset can
     * skip or duplicate a row under concurrent writes. The default page size is
     * 25 and the maximum is 100. The cursor is opaque and only a POSITION: it
     * never carries authority, because the page is still qualified by the
     * selected tenant. Every lookup qualifies the tenant, and a foreign tenant
     * is never readable through a minted cursor.
     */
    router.get('/branches', async (req, res) => {
        // The cache directive is applied before the first await and before any
        // denial, so every outcome this handler produces carries it.
        res.set('Cache-Control', 'no-store');
        if (denyBillingOnly(req, res))
            return;
        const limit = parseBranchLimit(req.query?.limit);
        if (limit === null)
            return res.status(400).json({ error: 'Invalid branch list limit' });
        const rawCursor = req.query?.cursor;
        // An absent cursor starts at the beginning of the tenant's branches; the
        // empty string sorts before every branch id.
        const cursorId = rawCursor === undefined ? '' : decodeBranchCursor(rawCursor);
        if (cursorId === null)
            return res.status(400).json({ error: 'Invalid branch list cursor' });
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        let connection = null;
        let transactionStarted = false;
        let disposal = 'release';
        const rollbackOrDiscard = async () => {
            try {
                await connection.rollback();
                return true;
            }
            catch (rollbackError) {
                disposal = 'destroy';
                console.error('Rollback branch list error (connection will be discarded):', rollbackError);
                return false;
            }
        };
        try {
            connection = await getConnection();
            await connection.beginTransaction();
            transactionStarted = true;
            const owner = await verifyBranchOwner(connection, userId, tenantId, false);
            if (!owner) {
                await rollbackOrDiscard();
                return res.status(403).json({ error: 'Forbidden' });
            }
            // One extra row is read to learn whether another page exists; only the
            // requested page size is ever returned.
            const [rows] = await connection.execute(`SELECT b.id,b.name,b.status,b.created_at,b.updated_at
         FROM tenant_branches b WHERE b.tenant_id=? AND b.id>? ORDER BY b.id ASC LIMIT ?`, [tenantId, cursorId, limit + 1]);
            const page = rows ?? [];
            const hasMore = page.length > limit;
            const visible = hasMore ? page.slice(0, limit) : page;
            await rollbackOrDiscard();
            return res.json({
                branches: visible.map(branchDto),
                next_cursor: hasMore && visible.length > 0 ? encodeBranchCursor(visible[visible.length - 1].id) : null,
            });
        }
        catch (error) {
            if (transactionStarted) {
                console.error('List tenant branches error:', error);
                await rollbackOrDiscard();
            }
            else {
                // The connection exists but its transaction state is not confirmed.
                // Discard rather than pooling a possibly-dirty session.
                disposal = 'destroy';
                console.error('List tenant branches error before transaction start:', error);
            }
            return res.status(500).json({ error: 'Failed to list branches' });
        }
        finally {
            if (connection) {
                if (disposal === 'destroy') {
                    try {
                        connection.destroy();
                    }
                    catch { /* connection already gone */ }
                }
                else {
                    try {
                        connection.release();
                    }
                    catch { /* connection already released */ }
                }
            }
        }
    });
    /**
     * POST /api/tenants/me/branches — create one branch in the selected tenant.
     *
     * Owner-only and strict: the payload is a single-field object `{ name }` and
     * any other key (a tenant selector, a status, a capacity) is rejected before
     * a connection is taken. The name is trimmed to 1..255 characters. The
     * branch id is server-generated and the tenant is the selected one, so a
     * client can never place a branch in another tenant. Duplicate names are
     * allowed: the id is the identity. The insert and its audit event are
     * committed together, and success is reported only after `commit()` resolves.
     * `Cache-Control: no-store` is set before the first await / any denial.
     */
    router.post('/branches', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (denyBillingOnly(req, res))
            return;
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'Invalid branch payload' });
        }
        const keys = Object.keys(body);
        if (keys.length !== 1 || keys[0] !== 'name') {
            return res.status(400).json({ error: 'Invalid branch payload' });
        }
        const name = parseBranchName(body.name);
        if (name === null)
            return res.status(400).json({ error: 'Invalid branch payload' });
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        let connection = null;
        let transactionStarted = false;
        let commitAttempted = false;
        let disposal = 'release';
        const rollbackOrDiscard = async () => {
            try {
                await connection.rollback();
                return true;
            }
            catch (rollbackError) {
                disposal = 'destroy';
                console.error('Rollback branch create error (connection will be discarded):', rollbackError);
                return false;
            }
        };
        try {
            connection = await getConnection();
            await connection.beginTransaction();
            transactionStarted = true;
            const owner = await verifyBranchOwner(connection, userId, tenantId, true);
            if (!owner) {
                await rollbackOrDiscard();
                return res.status(403).json({ error: 'Forbidden' });
            }
            const branchId = (0, crypto_1.randomUUID)();
            await connection.execute('INSERT INTO tenant_branches (id,tenant_id,name,status) VALUES (?,?,?,?)', [branchId, tenantId, name, 'active']);
            await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), userId, tenantId, 'tenant.branch_created', 'tenant_branch', branchId,
                null, JSON.stringify({ name, status: 'active' })]);
            // The row is read back inside the same transaction so the response
            // carries the exact stored timestamps instead of a guessed one.
            const [rows] = await connection.execute(`SELECT b.id,b.name,b.status,b.created_at,b.updated_at
         FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? LIMIT 1`, [branchId, tenantId]);
            const created = rows[0];
            if (!created) {
                await rollbackOrDiscard();
                return res.status(500).json({ error: 'Failed to create branch' });
            }
            commitAttempted = true;
            await connection.commit();
            return res.status(201).json({ branch: branchDto(created) });
        }
        catch (error) {
            if (commitAttempted) {
                // The commit acknowledgement was lost: whether the write persisted is
                // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
                // never return this connection to the pool.
                disposal = 'destroy';
                console.error('Create tenant branch error after commit attempt (persistence uncertain):', error);
            }
            else if (transactionStarted) {
                console.error('Create tenant branch error:', error);
                await rollbackOrDiscard();
            }
            else {
                disposal = 'destroy';
                console.error('Create tenant branch error before transaction start:', error);
            }
            return res.status(500).json({ error: 'Failed to create branch' });
        }
        finally {
            if (connection) {
                if (disposal === 'destroy') {
                    try {
                        connection.destroy();
                    }
                    catch { /* connection already gone */ }
                }
                else {
                    try {
                        connection.release();
                    }
                    catch { /* connection already released */ }
                }
            }
        }
    });
    /**
     * PATCH /api/tenants/me/branches/:branchId — rename and/or archive a branch.
     *
     * Owner-only and strict: the body may carry `name` and/or `status` only, an
     * empty update is rejected, and `status` must be exactly 'active' or
     * 'archived'. The lookup always qualifies BOTH the branch id and the
     * selected tenant, so a foreign and an absent id produce the identical
     * not-found result and no ownership is disclosed. A change to the current
     * values is a truthful no-op: no UPDATE and no audit event. The update and
     * its audit event are committed together, and success is reported only after
     * `commit()` resolves. `Cache-Control: no-store` is set before the first
     * await / any denial.
     */
    router.patch('/branches/:branchId', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (denyBillingOnly(req, res))
            return;
        const branchId = String(req.params?.branchId ?? '');
        if (!BRANCH_ID_PATTERN.test(branchId)) {
            return res.status(400).json({ error: 'Invalid branch id' });
        }
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'Invalid branch update payload' });
        }
        const keys = Object.keys(body);
        if (keys.length === 0)
            return res.status(400).json({ error: 'Invalid branch update payload' });
        for (const key of keys) {
            if (key !== 'name' && key !== 'status') {
                return res.status(400).json({ error: 'Invalid branch update payload' });
            }
        }
        let nextName = null;
        if (Object.prototype.hasOwnProperty.call(body, 'name')) {
            nextName = parseBranchName(body.name);
            if (nextName === null)
                return res.status(400).json({ error: 'Invalid branch update payload' });
        }
        let nextStatus = null;
        if (Object.prototype.hasOwnProperty.call(body, 'status')) {
            const rawStatus = body.status;
            if (typeof rawStatus !== 'string' || !BRANCH_STATUSES.includes(rawStatus)) {
                return res.status(400).json({ error: 'Invalid branch update payload' });
            }
            nextStatus = rawStatus;
        }
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        let connection = null;
        let transactionStarted = false;
        let commitAttempted = false;
        let disposal = 'release';
        const rollbackOrDiscard = async () => {
            try {
                await connection.rollback();
                return true;
            }
            catch (rollbackError) {
                disposal = 'destroy';
                console.error('Rollback branch update error (connection will be discarded):', rollbackError);
                return false;
            }
        };
        try {
            connection = await getConnection();
            await connection.beginTransaction();
            transactionStarted = true;
            const owner = await verifyBranchOwner(connection, userId, tenantId, true);
            if (!owner) {
                await rollbackOrDiscard();
                return res.status(403).json({ error: 'Forbidden' });
            }
            // Tenant-qualified and locked: a foreign id is simply not found here.
            const [rows] = await connection.execute(`SELECT b.id,b.name,b.status,b.created_at,b.updated_at
         FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? FOR UPDATE`, [branchId, tenantId]);
            const current = rows[0];
            if (!current) {
                await rollbackOrDiscard();
                return res.status(404).json({ error: 'Branch not found' });
            }
            const currentName = String(current.name);
            const currentStatus = String(current.status);
            const finalName = nextName === null ? currentName : nextName;
            const finalStatus = nextStatus === null ? currentStatus : nextStatus;
            if (finalName === currentName && finalStatus === currentStatus) {
                // Truthful no-op: an identical retry writes and audits nothing.
                await rollbackOrDiscard();
                return res.json({ branch: branchDto(current) });
            }
            const [updateResult] = await connection.execute('UPDATE tenant_branches SET name=?,status=? WHERE id=? AND tenant_id=?', [finalName, finalStatus, branchId, tenantId]);
            if (Number(updateResult?.affectedRows) !== 1) {
                await rollbackOrDiscard();
                return res.status(409).json({ error: 'Branch was modified concurrently' });
            }
            await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), userId, tenantId, 'tenant.branch_updated', 'tenant_branch', branchId,
                JSON.stringify({ name: currentName, status: currentStatus }),
                JSON.stringify({ name: finalName, status: finalStatus })]);
            const [updatedRows] = await connection.execute(`SELECT b.id,b.name,b.status,b.created_at,b.updated_at
         FROM tenant_branches b WHERE b.id=? AND b.tenant_id=? LIMIT 1`, [branchId, tenantId]);
            const updated = updatedRows[0];
            if (!updated) {
                await rollbackOrDiscard();
                return res.status(500).json({ error: 'Failed to update branch' });
            }
            commitAttempted = true;
            await connection.commit();
            return res.json({ branch: branchDto(updated) });
        }
        catch (error) {
            if (commitAttempted) {
                // The commit acknowledgement was lost: persistence is UNKNOWN. No
                // rollback is claimed, no silent retry happens, and the connection is
                // discarded instead of returning to the shared pool.
                disposal = 'destroy';
                console.error('Update tenant branch error after commit attempt (persistence uncertain):', error);
            }
            else if (transactionStarted) {
                console.error('Update tenant branch error:', error);
                await rollbackOrDiscard();
            }
            else {
                disposal = 'destroy';
                console.error('Update tenant branch error before transaction start:', error);
            }
            return res.status(500).json({ error: 'Failed to update branch' });
        }
        finally {
            if (connection) {
                if (disposal === 'destroy') {
                    try {
                        connection.destroy();
                    }
                    catch { /* connection already gone */ }
                }
                else {
                    try {
                        connection.release();
                    }
                    catch { /* connection already released */ }
                }
            }
        }
    });
    /**
     * GET /api/tenants/me/instructor-memberships — owner-only bounded list of
     * the ACTIVE instructor memberships of the server-selected tenant, each with
     * the branch the owner recorded for it (or none).
     *
     * The list is deterministic and bounded: rows are ordered by the membership
     * id (a total, stable order that needs no timestamp/timezone interpretation)
     * and read with a keyset cursor, so no page is unbounded and no offset can
     * skip or duplicate a row under concurrent writes. The default page size is
     * 25 and the maximum is 100, and one extra row is read to learn whether a
     * further page exists. The cursor is opaque and only a POSITION: the page is
     * still qualified by the selected tenant, so a cursor minted elsewhere can
     * never widen the read.
     *
     * The projection is the explicit five-field DTO. `tenant_id`, `role_key`,
     * `status` and every other user column stay server-owned, and the branch name
     * comes from a tenant-qualified left join, so a foreign branch can never
     * contribute a name.
     *
     * `Cache-Control: no-store` is set before the first await and before any
     * denial, so every outcome this handler produces carries it.
     */
    router.get('/instructor-memberships', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (denyBillingOnly(req, res))
            return;
        const limit = parseMembershipLimit(req.query?.limit);
        if (limit === null)
            return res.status(400).json({ error: 'Invalid instructor membership list limit' });
        const rawCursor = req.query?.cursor;
        // An absent cursor starts at the beginning of the tenant's memberships; the
        // empty string sorts before every membership id.
        const cursorId = rawCursor === undefined ? '' : decodeMembershipCursor(rawCursor);
        if (cursorId === null)
            return res.status(400).json({ error: 'Invalid instructor membership list cursor' });
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        let connection = null;
        let transactionStarted = false;
        let disposal = 'release';
        const rollbackOrDiscard = async () => {
            try {
                await connection.rollback();
                return true;
            }
            catch (rollbackError) {
                disposal = 'destroy';
                console.error('Rollback instructor membership list error (connection will be discarded):', rollbackError);
                return false;
            }
        };
        try {
            connection = await getConnection();
            await connection.beginTransaction();
            transactionStarted = true;
            // The owner is verified on the SAME connection that reads the page, so
            // the page and the authority share one snapshot. A read takes no
            // exclusive lock on the owner row.
            const owner = await verifyBranchOwner(connection, userId, tenantId, false);
            if (!owner) {
                await rollbackOrDiscard();
                return res.status(403).json({ error: 'Forbidden' });
            }
            const [rows] = await connection.execute(INSTRUCTOR_MEMBERSHIP_LIST_SQL, [
                tenantId, INSTRUCTOR_ROLE_KEY, cursorId, limit + 1,
            ]);
            const page = rows ?? [];
            const hasMore = page.length > limit;
            const visible = hasMore ? page.slice(0, limit) : page;
            // The read path writes nothing, so the transaction is rolled back rather
            // than committed and the connection returns to the pool clean.
            await rollbackOrDiscard();
            return res.json({
                memberships: visible.map(instructorMembershipDto),
                next_cursor: hasMore && visible.length > 0
                    ? encodeMembershipCursor(String(visible[visible.length - 1].membership_id))
                    : null,
            });
        }
        catch (error) {
            if (transactionStarted) {
                console.error('List instructor memberships error:', error);
                await rollbackOrDiscard();
            }
            else {
                // The connection exists but its transaction state is not confirmed.
                // Discard rather than pooling a possibly-dirty session.
                disposal = 'destroy';
                console.error('List instructor memberships error before transaction start:', error);
            }
            return res.status(500).json({ error: 'Failed to list instructor memberships' });
        }
        finally {
            if (connection) {
                if (disposal === 'destroy') {
                    try {
                        connection.destroy();
                    }
                    catch { /* connection already gone */ }
                }
                else {
                    try {
                        connection.release();
                    }
                    catch { /* connection already released */ }
                }
            }
        }
    });
    /**
     * PATCH /api/tenants/me/instructor-memberships/:membershipId — record ONE
     * active same-tenant branch on an existing active instructor membership, or
     * clear the record with `branch_id: null`.
     *
     * Owner-only and strict: the body is exactly `{ branch_id }`, whose value is
     * a branch UUID (assign) or `null` (clear). An unknown key, a missing key, a
     * non-string and a non-UUID string are all rejected before a connection is
     * taken, so this route can never rename, create, archive or delete a branch
     * and can never touch a second column.
     *
     * Everything the write depends on is revalidated on ONE connection inside ONE
     * transaction, each read locked `FOR UPDATE`:
     *   1. the caller is the real `owner_user_id` of the SELECTED tenant, that
     *      tenant is active and the caller's user row is active;
     *   2. the membership is the SELECTED tenant's, has the instructor role and
     *      is active, and its user row is active;
     *   3. the target branch EXISTS, is ACTIVE and belongs to the SAME tenant.
     *
     * A foreign, non-instructor, inactive or absent membership is one 404 and a
     * foreign, archived or absent branch is another, so no cross-tenant existence
     * is disclosed. The branch check runs BEFORE the no-op comparison: recording
     * an already-archived branch is not a truthful no-op.
     *
     * Re-recording the branch that is already stored is a truthful no-op: nothing
     * is written, nothing is audited and the current projection is returned. A
     * confirmed change writes the column and exactly ONE sanitized audit event in
     * the same transaction; the audit carries only `{ branch_id, branch_name }`,
     * never a role, permission, teaching-access, course, group, student,
     * enrollment or billing value, because this route changes none of them.
     *
     * `Cache-Control: no-store` is set before the first await / any denial.
     */
    router.patch('/instructor-memberships/:membershipId', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (denyBillingOnly(req, res))
            return;
        const membershipId = String(req.params?.membershipId ?? '');
        if (!MEMBERSHIP_ID_PATTERN.test(membershipId)) {
            return res.status(400).json({ error: 'Invalid membership id' });
        }
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'Invalid instructor branch assignment payload' });
        }
        const keys = Object.keys(body);
        if (keys.length !== 1 || keys[0] !== 'branch_id') {
            return res.status(400).json({ error: 'Invalid instructor branch assignment payload' });
        }
        const rawBranchId = body.branch_id;
        // `null` explicitly CLEARS the record; a UUID ASSIGNS one. The key set is
        // exact, so "omission" cannot reach this route at all — a caller that wants
        // to keep the current record simply does not call it.
        let branchId = null;
        if (rawBranchId !== null) {
            if (typeof rawBranchId !== 'string' || !MEMBERSHIP_ID_PATTERN.test(rawBranchId)) {
                return res.status(400).json({ error: 'Invalid instructor branch assignment payload' });
            }
            branchId = rawBranchId;
        }
        const userId = req.user?.id;
        const tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        // The connection is tracked explicitly: a failed acquisition has nothing to
        // clean up, while an uncertain transaction must be destroyed rather than
        // returned to the shared pool.
        let connection = null;
        let transactionStarted = false;
        let commitAttempted = false;
        let disposal = 'release';
        const rollbackOrDiscard = async () => {
            try {
                await connection.rollback();
                return true;
            }
            catch (rollbackError) {
                disposal = 'destroy';
                console.error('Rollback instructor branch assignment error (connection will be discarded):', rollbackError);
                return false;
            }
        };
        try {
            connection = await getConnection();
            await connection.beginTransaction();
            transactionStarted = true;
            // 1. Server-owned owner authority under lock, on the transaction
            //    connection: the selected tenant's real owner_user_id and status
            //    joined to the caller's own active user row. A membership role label
            //    never reaches here.
            const owner = await verifyBranchOwner(connection, userId, tenantId, true);
            if (!owner) {
                await rollbackOrDiscard();
                return res.status(403).json({ error: 'Forbidden' });
            }
            // 2. The target membership, tenant-qualified, instructor-only, ACTIVE and
            //    locked. A foreign tenant's membership, another role, an inactive
            //    membership or an inactive user is the same 404 as a missing one.
            const [membershipRows] = await connection.execute(INSTRUCTOR_MEMBERSHIP_LOCK_SQL, [
                membershipId, tenantId, INSTRUCTOR_ROLE_KEY,
            ]);
            const current = membershipRows[0];
            if (!current) {
                await rollbackOrDiscard();
                return res.status(404).json({ error: 'Instructor membership not found' });
            }
            // 3. The target branch, tenant-qualified, ACTIVE and locked. This runs
            //    BEFORE the no-op comparison so an archived or foreign branch is
            //    refused rather than silently accepted as "already recorded".
            let targetBranch = null;
            if (branchId !== null) {
                const [branchRows] = await connection.execute(INSTRUCTOR_BRANCH_LOCK_SQL, [branchId, tenantId]);
                targetBranch = branchRows[0] ?? null;
                if (!targetBranch) {
                    await rollbackOrDiscard();
                    return res.status(404).json({ error: 'Branch not found' });
                }
            }
            const currentBranchId = current.branch_id === null || current.branch_id === undefined
                ? null
                : String(current.branch_id);
            if (currentBranchId === branchId) {
                // Truthful no-op: the recorded branch already IS the requested one, so
                // nothing is written, nothing is audited and the current stored
                // projection is returned unchanged.
                await rollbackOrDiscard();
                return res.json({
                    membership: instructorMembershipDto({
                        membership_id: current.membership_id,
                        instructor_id: current.instructor_id,
                        instructor_name: current.instructor_name,
                        branch_id: currentBranchId,
                        branch_name: targetBranch ? targetBranch.name : null,
                    }),
                });
            }
            const [updateResult] = await connection.execute(INSTRUCTOR_MEMBERSHIP_UPDATE_SQL, [
                branchId, membershipId, tenantId,
            ]);
            if (Number(updateResult?.affectedRows) !== 1) {
                await rollbackOrDiscard();
                return res.status(409).json({ error: 'Instructor membership was modified concurrently' });
            }
            // Exactly ONE sanitized audit event, committed with the write. It records
            // the organization change only: no role, permission, teaching-access,
            // course, group, student, enrollment or billing value is copied here.
            await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
         VALUES (?,?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), userId, tenantId,
                branchId === null ? 'tenant.instructor_branch_cleared' : 'tenant.instructor_branch_assigned',
                'tenant_membership', membershipId,
                JSON.stringify({
                    branch_id: currentBranchId,
                    branch_name: current.current_branch_name ?? null,
                }),
                JSON.stringify({
                    branch_id: branchId,
                    branch_name: targetBranch ? String(targetBranch.name) : null,
                })]);
            // The row is read back inside the same transaction so the response is the
            // stored projection, not a locally assembled guess.
            const [readRows] = await connection.execute(INSTRUCTOR_MEMBERSHIP_READ_SQL, [membershipId, tenantId]);
            const updated = readRows[0];
            if (!updated) {
                await rollbackOrDiscard();
                return res.status(500).json({ error: 'Failed to assign instructor branch' });
            }
            commitAttempted = true;
            await connection.commit();
            return res.json({ membership: instructorMembershipDto(updated) });
        }
        catch (error) {
            if (commitAttempted) {
                // The commit acknowledgement was lost: whether the write persisted is
                // UNKNOWN. Do not claim a rollback happened, do not retry silently, and
                // never return this connection to the pool.
                disposal = 'destroy';
                console.error('Assign instructor branch error after commit attempt (persistence uncertain):', error);
            }
            else if (transactionStarted) {
                console.error('Assign instructor branch error:', error);
                await rollbackOrDiscard();
            }
            else {
                // The connection was obtained but `beginTransaction` failed, so the
                // server-side transaction state is not confirmed. Discard rather than
                // pooling a possibly-dirty session. Acquisition failure skips cleanup
                // entirely because no connection exists.
                disposal = 'destroy';
                console.error('Assign instructor branch error before transaction start:', error);
            }
            return res.status(500).json({ error: 'Failed to assign instructor branch' });
        }
        finally {
            if (connection) {
                if (disposal === 'destroy') {
                    try {
                        connection.destroy();
                    }
                    catch { /* connection already gone */ }
                }
                else {
                    try {
                        connection.release();
                    }
                    catch { /* connection already released */ }
                }
            }
        }
    });
    router.get('/subscription', async (req, res) => {
        try {
            const tenant = await getOwnedTenant(req);
            if (!tenant)
                return res.status(404).json({ error: 'Tenant membership not found' });
            const row = await queryOne(`SELECT t.id AS tenant_id,t.business_name,t.status AS tenant_status,t.legacy_compat,
              s.id AS subscription_id,s.status AS subscription_status,s.agreed_price,s.discount_amount,s.currency,
              s.starts_at,s.period_ends_at,s.grace_until,p.name AS plan_name,p.duration_months,p.duration_days,
              GREATEST(0,TIMESTAMPDIFF(DAY,UTC_TIMESTAMP(),s.period_ends_at)) AS days_remaining,
              CASE WHEN s.period_ends_at<=UTC_TIMESTAMP() AND DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)>UTC_TIMESTAMP()
                THEN GREATEST(0,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),DATE_ADD(s.period_ends_at,INTERVAL 4 DAY))) ELSE 0 END AS grace_seconds_remaining
       FROM tenants t
       LEFT JOIN tenant_subscriptions s ON s.id=(
         SELECT s2.id FROM tenant_subscriptions s2 WHERE s2.tenant_id=t.id
         ORDER BY CASE WHEN s2.status IN ('active','past_due','grace_period') THEN 0 WHEN s2.status='pending' THEN 1 ELSE 2 END,
           COALESCE(s2.period_ends_at,s2.created_at) DESC LIMIT 1)
       LEFT JOIN platform_plans p ON p.id=s.plan_id
       WHERE t.id=? LIMIT 1`, [tenant.id]);
            if (!row)
                return res.status(404).json({ error: 'Tenant membership not found' });
            return res.json(row);
        }
        catch (error) {
            console.error('Get tenant subscription error:', error);
            return res.status(500).json({ error: 'Failed to load subscription' });
        }
    });
    router.get('/billing', async (req, res) => {
        try {
            const tenant = await getOwnedTenant(req);
            if (!tenant)
                return res.status(404).json({ error: 'Tenant membership not found' });
            const [subscription, wallet, intent, topups] = await Promise.all([
                queryOne(`SELECT s.id,s.status,s.plan_id,s.agreed_price,s.discount_amount,s.currency,s.starts_at,s.period_ends_at,s.grace_until,
                p.name AS plan_name,p.duration_months,p.duration_days,
                GREATEST(0,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),s.period_ends_at)) AS period_seconds_remaining,
                CASE WHEN s.period_ends_at<=UTC_TIMESTAMP() THEN GREATEST(0,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),COALESCE(s.grace_until,DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)))) ELSE 0 END AS grace_seconds_remaining
         FROM tenant_subscriptions s INNER JOIN platform_plans p ON p.id=s.plan_id
         WHERE s.tenant_id=? ORDER BY CASE WHEN s.status IN ('active','past_due','grace_period') THEN 0 ELSE 1 END,
           COALESCE(s.period_ends_at,s.created_at) DESC LIMIT 1`, [tenant.id]),
                queryOne('SELECT balance,updated_at FROM instructor_wallets WHERE instructor_id=?', [req.user.id]),
                queryOne(`SELECT i.id,i.status,i.trigger_type,i.charge_amount,i.paid_at,i.created_at,p.name AS plan_name
         FROM tenant_renewal_intents i INNER JOIN platform_plans p ON p.id=i.target_plan_id
         WHERE i.tenant_id=? AND i.status='pending' LIMIT 1`, [tenant.id]),
                query(`SELECT id,purpose_code,amount,currency,method,reference_number,paid_at,notes,status,rejection_reason,reviewed_at,created_at
         FROM instructor_topup_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50`, [tenant.id]),
            ]);
            return res.json({
                server_now: new Date().toISOString(),
                tenant: { id: tenant.id, business_name: tenant.business_name, status: tenant.status, legacy_compat: Boolean(tenant.legacy_compat) },
                subscription: subscription ? { ...subscription, charge_amount: Math.max(0, Number(subscription.agreed_price) - Number(subscription.discount_amount)) } : null,
                wallet: { balance: String(wallet?.balance ?? '0.00'), updated_at: wallet?.updated_at || null },
                renewal_intent: intent || null, topups, billing_only: Boolean(req.user?.billingOnly),
            });
        }
        catch (error) {
            console.error('Get instructor billing center error:', error);
            return res.status(500).json({ error: 'Failed to load billing center' });
        }
    });
    router.post('/topups', upload.single('proof'), async (req, res) => {
        let objectKey = null;
        try {
            if (!req.file)
                return res.status(400).json({ error: 'Payment proof is required' });
            const detected = proofType(req.file);
            if (!detected)
                return res.status(400).json({ error: 'Proof must be JPEG, PNG, WebP or PDF' });
            const amount = money(req.body.amount);
            const purpose = String(req.body.purpose_code ?? '');
            const method = String(req.body.method ?? '');
            const reference = String(req.body.reference_number ?? '').trim();
            const notes = String(req.body.notes ?? '').trim();
            const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
            const paidAt = new Date(String(req.body.paid_at ?? ''));
            if (!amount || !['subscription_renewal', 'other'].includes(purpose) || !['bank_transfer', 'instapay', 'mobile_wallet', 'cash'].includes(method) || reference.length < 3 || reference.length > 160 || notes.length > 1000 || idempotencyKey.length < 8 || idempotencyKey.length > 120 || Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60000 || paidAt.getTime() < Date.now() - 366 * 86400000) {
                return res.status(400).json({ error: 'Invalid top-up details' });
            }
            if (purpose === 'subscription_renewal' && req.body.renewal_confirmation !== 'CONFIRM_MONTHLY_RENEWAL')
                return res.status(400).json({ error: 'Monthly renewal confirmation is required' });
            const tenant = await getOwnedTenant(req);
            if (!tenant || tenant.status !== 'active')
                return res.status(403).json({ error: 'Active tenant account required' });
            const existing = await queryOne('SELECT id,status FROM instructor_topup_requests WHERE instructor_id=? AND idempotency_key=?', [req.user.id, idempotencyKey]);
            if (existing)
                return res.json({ id: existing.id, status: existing.status, duplicate: true });
            if (purpose === 'subscription_renewal') {
                const pending = await queryOne(`SELECT id FROM instructor_topup_requests WHERE tenant_id=? AND purpose_code='subscription_renewal' AND status='submitted'
         UNION ALL SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' LIMIT 1`, [tenant.id, tenant.id]);
                if (pending)
                    return res.status(409).json({ error: 'يوجد إذن تجديد أو إثبات تجديد قيد الانتظار بالفعل' });
            }
            const id = (0, crypto_1.randomUUID)();
            const hash = (0, crypto_1.createHash)('sha256').update(req.file.buffer).digest('hex');
            objectKey = `instructor-topups/${tenant.id}/${id}.${detected.ext}`;
            await uploadBuffer(minio_1.BUCKETS.PAYMENT_PROOFS, objectKey, req.file.buffer, detected.contentType);
            await execute(`INSERT INTO instructor_topup_requests
       (id,tenant_id,instructor_id,purpose_code,amount,method,reference_number,paid_at,proof_object_key,proof_sha256,proof_content_type,notes,idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, tenant.id, req.user.id, purpose, amount, method, reference,
                paidAt.toISOString().slice(0, 19).replace('T', ' '), objectKey, hash, detected.contentType, notes || null, idempotencyKey]);
            objectKey = null;
            try {
                await execute(`INSERT INTO notifications (id,user_id,user_type,title,message,type,link)
         SELECT UUID(),u.id,'admin','إيصال شحن جديد',?,'payment','/admin/platform'
         FROM users u WHERE u.role='admin' AND u.is_active=1`, [`رفع ${tenant.business_name} إيصال شحن بقيمة ${amount} ج.م للمراجعة.`]);
            }
            catch (notificationError) {
                console.error('Create top-up admin notification error:', notificationError);
            }
            return res.status(201).json({ id, status: 'submitted' });
        }
        catch (error) {
            if (objectKey)
                try {
                    await deleteFile(minio_1.BUCKETS.PAYMENT_PROOFS, objectKey);
                }
                catch { /* best effort cleanup */ }
            if (error?.code === 'ER_DUP_ENTRY')
                return res.status(409).json({ error: 'رقم التحويل أو ملف الإثبات مستخدم في طلب سابق' });
            if (error instanceof multer_1.default.MulterError)
                return res.status(400).json({ error: 'Proof file exceeds the 8MB limit' });
            console.error('Submit instructor top-up error:', error);
            return res.status(500).json({ error: 'Failed to submit top-up' });
        }
    });
    router.get('/topups/:id/proof-url', async (req, res) => {
        try {
            const tenant = await getOwnedTenant(req);
            if (!tenant)
                return res.status(404).json({ error: 'Tenant membership not found' });
            const row = await queryOne('SELECT proof_object_key FROM instructor_topup_requests WHERE id=? AND tenant_id=? AND instructor_id=?', [req.params.id, tenant.id, req.user.id]);
            if (!row)
                return res.status(404).json({ error: 'Top-up request not found' });
            return res.json({ url: await getPrivateObjectUrl(minio_1.BUCKETS.PAYMENT_PROOFS, row.proof_object_key, 300), expires_in: 300 });
        }
        catch (error) {
            console.error('Get own proof URL error:', error);
            return res.status(500).json({ error: 'Failed to open proof' });
        }
    });
    router.post('/renewal-intents/manual', async (req, res) => {
        if (req.body?.confirmed !== true)
            return res.status(400).json({ error: 'Renewal confirmation is required' });
        const tenant = await getOwnedTenant(req);
        if (!tenant || tenant.status !== 'active')
            return res.status(403).json({ error: 'Active tenant account required' });
        const connection = await getConnection();
        try {
            await connection.beginTransaction();
            const [pendingRows] = await connection.execute("SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' FOR UPDATE", [tenant.id]);
            if (pendingRows.length) {
                await connection.rollback();
                return res.status(409).json({ error: 'A renewal intent is already pending' });
            }
            const [subscriptionRows] = await connection.execute(`SELECT id,plan_id,agreed_price,discount_amount,status FROM tenant_subscriptions
       WHERE tenant_id=? AND status IN ('active','past_due','grace_period','expired')
       ORDER BY COALESCE(period_ends_at,created_at) DESC LIMIT 1 FOR UPDATE`, [tenant.id]);
            const subscription = subscriptionRows[0];
            if (!subscription) {
                await connection.rollback();
                return res.status(409).json({ error: 'No renewable subscription found' });
            }
            const charge = Math.max(0, Number(subscription.agreed_price) - Number(subscription.discount_amount));
            const [walletRows] = await connection.execute('SELECT balance FROM instructor_wallets WHERE instructor_id=? FOR UPDATE', [req.user.id]);
            if (Number(walletRows[0]?.balance || 0) < charge) {
                await connection.rollback();
                return res.status(409).json({ error: 'رصيد الخدمات غير كافٍ للتجديد', required: charge });
            }
            const id = (0, crypto_1.randomUUID)();
            await connection.execute(`INSERT INTO tenant_renewal_intents
       (id,tenant_id,instructor_id,source_subscription_id,target_plan_id,trigger_type,charge_amount)
       VALUES (?,?,?,?,?,'manual',?)`, [id, tenant.id, req.user.id, subscription.id, subscription.plan_id, String(charge)]);
            const result = await runRenewalIntent(connection, id);
            await connection.commit();
            return res.status(201).json({ id, ...result });
        }
        catch (error) {
            await connection.rollback();
            if (error?.code === 'ER_DUP_ENTRY')
                return res.status(409).json({ error: 'A renewal intent is already pending' });
            console.error('Create manual renewal intent error:', error);
            return res.status(500).json({ error: 'Failed to request renewal' });
        }
        finally {
            connection.release();
        }
    });
    router.post('/renewal-intents/:id/cancel', async (req, res) => {
        const tenant = await getOwnedTenant(req);
        if (!tenant || tenant.status !== 'active')
            return res.status(403).json({ error: 'Active tenant account required' });
        try {
            const result = await execute(`UPDATE tenant_renewal_intents SET status='cancelled',cancelled_at=UTC_TIMESTAMP()
       WHERE id=? AND tenant_id=? AND instructor_id=? AND status='pending'`, [req.params.id, tenant.id, req.user.id]);
            if (!result.affectedRows)
                return res.status(409).json({ error: 'Renewal intent is not pending' });
            return res.json({ status: 'cancelled' });
        }
        catch (error) {
            console.error('Cancel renewal intent error:', error);
            return res.status(500).json({ error: 'Failed to cancel renewal intent' });
        }
    });
    return router;
};
exports.createTenantSelfRouter = createTenantSelfRouter;
/**
 * Production tenant-authority lookup, identical to the server-owned lookup
 * used by the finance/video routers: verified owner row, or active membership
 * role_key owner/instructor in an active tenant by an active user.
 */
const loadActiveTenantAuthority = async (userId, tenantId) => (0, db_1.queryOne)(`SELECT 'owner' AS authority
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
     LIMIT 1`, [tenantId, userId, userId, tenantId]);
/**
 * Production binding: the real SQL adapters, the real authentication
 * middleware, the real MinIO helpers, the real renewal executor, and the real
 * server-owned tenant-authority lookup. index.ts imports this default export
 * unchanged.
 */
exports.default = (0, exports.createTenantSelfRouter)({
    db: {
        query: db_1.query,
        queryOne: db_1.queryOne,
        execute: db_1.execute,
        getConnection: () => (0, db_1.getPool)().getConnection(),
    },
    authenticate: auth_1.authenticateToken,
    loadActiveTenantAuthority,
    uploadBuffer: minio_1.uploadBuffer,
    deleteFile: minio_1.deleteFile,
    getPrivateObjectUrl: minio_1.getPrivateObjectUrl,
    executeRenewalIntent: subscription_renewal_1.executeRenewalIntent,
});
