"use strict";
/**
 * M4 A5 — assignments and private file-submission routes.
 *
 * Authority and scope are server-derived only:
 *  - staff authority is a verified owner/instructor membership in the
 *    principal's selected tenant; a branch target additionally requires a live
 *    branch membership (the tenant owner keeps a narrow owner path);
 *  - a group target must belong to the tenant and be owned by the instructor
 *    (or the caller is the tenant owner);
 *  - a student submission requires an active, approved, in-window enrollment
 *    whose tenant, branch and group match the assignment (deny by default);
 *  - every read/write carries `tenant_id = <principal tenant>`.
 *
 * Upload identity and object facts are server-owned on every value. The
 * private `storage_key` is generated here (`tenants/{tenantId}/assignments/
 * {assignmentId}/{enrollmentId}/{submissionId}.ext`), a client-supplied key
 * (or any client size/scan claim) is rejected/ignored, and the authoritative
 * metadata comes from an injected server-side object store. The lifecycle is:
 *
 *   POST   /:id/submissions                       create row + short-lived upload URL
 *   POST   /:id/submissions/:sid/upload-authorization  re-issue an expired URL
 *   POST   /:id/submissions/:sid/finalize         verify object + scan, atomically
 *
 * A freshly created row is `pending_upload` (size 0, scan pending). Finalize
 * verifies the key binding, size, stored content type and a bounded magic-byte
 * prefix, then records the verified size. Without a verified scanner the row
 * ends in `pending_scan` — uploaded is never treated as clean. The key is
 * never projected by any read endpoint. Submissions are append-only versions;
 * a teacher revocation invalidates a version and re-opens the slot.
 * Duplicate-key races on the per-version UNIQUE key are re-evaluated and
 * answered as a policy denial, not a 500.
 *
 * Durable cleanup (2026-10-23). Every rejection, cancel and infected verdict
 * removes **exactly the object version the server verified**, never
 * `removeObject(storage_key)`: the key is mutable, and a key delete would
 * destroy a concurrent re-upload no verifier ever looked at. When a durable
 * obligation store is injected (`cleanupObligations`), the obligation to destroy
 * that version is written **before** the bytes are touched and in the same unit
 * of work as the state change (the quarantine verdict, the cancellation), then
 * settled after the external delete. Without that store the cleanup stays
 * best-effort and is reported as `cleanup-unconfigured`; no queued/deleted
 * success is ever claimed. See
 * `docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md`.
 *
 * Exports `createAssignmentsRouter(deps)` and a default-wired router instance
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
exports.createAssignmentsRuntime = exports.createAssignmentsRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const catalog_homework_access_1 = require("../services/catalog-homework-access");
const audit_1 = require("../security/audit");
const branch_access_1 = require("../security/branch-access");
const content_release_1 = require("../services/content-release");
const assignments_1 = require("../services/assignments");
const assignment_cleanup_recovery_1 = require("../services/assignment-cleanup-recovery");
const assignment_recovery_factory_1 = require("../services/assignment-recovery-factory");
const assignment_storage_1 = require("../services/assignment-storage");
const gradebook_1 = require("../services/gradebook");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
/** mysql2 duplicate-key error (the per-version UNIQUE key lost the race). */
const isDuplicateKeyError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    const errno = error.errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
};
/**
 * A driver answer a single-row guard can act on.
 *
 * `affectedRows` is optional in `AssignmentsDataAccess`, and `undefined === 0`
 * is false — so a seam that reported no count used to fall through every guard
 * below as a *successful* write: a cancellation would commit without its
 * revocation, a finalize would be treated as recorded, a grade as corrected.
 * `undefined` is neither zero nor one. The production transaction seam already
 * throws here; keeping the check local to the guards means an injected seam
 * cannot weaken it. A genuine `0` still fails closed at each call site.
 */
const affectedRowsOf = (result) => {
    const reported = result?.affectedRows;
    if (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) {
        throw new Error('assignments write did not report a usable affected-row count;'
            + ' a single-row write cannot be confirmed without it');
    }
    return reported;
};
function parseJsonArray(value) {
    if (!value)
        return [];
    try {
        // mysql2 decodes native JSON columns; old text columns return JSON text.
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
    }
    catch {
        return [];
    }
}
const pad2 = (value) => String(value).padStart(2, '0');
/**
 * Epoch milliseconds for a persisted `submitted_at`. A MySQL DATETIME is a UTC
 * wall time without a zone (the column default is `CURRENT_TIMESTAMP` in UTC),
 * so it is parsed as UTC; a driver Date is already absolute. Unparseable
 * values yield null and the caller treats the row as still in flight.
 */
function submittedAtMs(value) {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }
    if (typeof value !== 'string' || value === '')
        return null;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
        ? `${value.replace(' ', 'T')}Z`
        : value;
    const time = Date.parse(normalized);
    return Number.isFinite(time) ? time : null;
}
/** Render an absolute UTC instant back into a local wall time for re-editing. */
function toLocalWallTime(isoUtc, timeZone) {
    const wall = (0, content_release_1.tenantLocalNow)(new Date(isoUtc), timeZone);
    return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)} ${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(wall.second)}`;
}
const ASSIGNMENT_COLUMNS = 'id,tenant_id,branch_id,branch_scope,course_id,group_id,title,instructions,deadline_at,deadline_timezone,' +
    'late_policy,resubmission_policy,max_submissions,max_file_bytes,allowed_file_types,status,archived_at,created_by,version';
const createAssignmentsRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { db } = deps;
    const now = deps.now ?? (() => new Date());
    const catalogRequests = new WeakMap();
    const guardCatalog = async (res, source = db, lock = false) => {
        const request = catalogRequests.get(res);
        if (!request)
            return;
        const fresh = await deps.catalog.resolve(source, request.principal, request.context, lock);
        if (!(0, catalog_homework_access_1.sameHomeworkContext)(fresh, request.context))
            throw new catalog_homework_access_1.CatalogHomeworkDenied();
        if (request.submissionId)
            await deps.catalog.checkSubmission(source, fresh, request.submissionId, lock);
    };
    const catalogFailure = (res, error) => {
        const request = catalogRequests.get(res);
        if (!request)
            return false;
        if (error instanceof catalog_homework_access_1.CatalogHomeworkDenied)
            res.status(403).json({ error: 'Catalog homework access required or withdrawn', code: 'CATALOG_HOMEWORK_DENIED' });
        else
            res.status(503).json({ error: 'Inspect the current submission before retry', code: request.writing ? 'PERSISTENCE_UNCERTAIN' : 'CATALOG_HOMEWORK_UNAVAILABLE' });
        return true;
    };
    /**
     * The unit-of-work seam, verbatim — never a pass-through to `db`.
     *
     * Running a mutation on the shared pool commits the row, its audit event
     * and (where owed) its cleanup obligation as independent statements, so a
     * failed audit or an unrecorded obligation would survive the state change.
     * There is therefore no autocommit fallback; a path that needs the seam
     * admits on it first (`admitAtomic`) and fails closed when it is absent.
     */
    // Keep the injected method receiver: class-based seams may use this.
    const runAtomic = typeof deps.transaction === 'function'
        ? (fn) => deps.transaction(fn)
        : undefined;
    /**
     * Transaction-capability admission.
     *
     * Every mutating path below writes its row, its audit event and any cleanup
     * obligation as one unit. Without an injected seam there is no unit, so the
     * seam is a precondition rather than an assumption: it is checked before the
     * first write, delete or storage/scanner call of each such path, and its
     * absence answers 503 having touched nothing — never late, after a side
     * effect has already landed.
     */
    const admitAtomic = (res) => {
        if (runAtomic)
            return async (work) => runAtomic(async (tx) => {
                await guardCatalog(res, tx, true);
                const request = catalogRequests.get(res);
                if (request)
                    request.writing = true;
                return work(tx);
            });
        res.status(503).json({
            error: 'Atomic writes are not configured',
            code: 'transaction_unavailable',
        });
        return null;
    };
    const objectStore = deps.objectStore;
    const malwareScanner = deps.malwareScanner;
    const scanWindowMs = (0, assignment_storage_1.scanTimeoutMs)(deps.scanTimeoutMs);
    const uploadTtlSeconds = (0, assignment_storage_1.uploadAuthorizationTtlSeconds)(deps.uploadUrlTtlSeconds);
    const branchAccess = deps.branchAccess ?? {
        findBranchById: async (branchId) => db.queryOne('SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1', [branchId]),
        findMembership: async (branchId, userId) => db.queryOne('SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1', [branchId, userId]),
    };
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(deps.authenticate);
    // Resolve catalog selectors server-side, then reuse the original submission
    // engine. The private binding never comes from a body or identity header.
    router.use(async (req, res, next) => {
        if (!String(req.url).startsWith('/catalog/')) {
            if (!deps.catalog || req.user?.role !== 'student')
                return next();
            try {
                const segment = String(req.url).split('?')[0].split('/').filter(Boolean)[0];
                const assignmentId = segment ? decodeURIComponent(segment) : '';
                if (assignmentId && assignmentId !== 'student' && await deps.catalog.hasBindings(db, assignmentId))
                    return res.status(403).json({ error: 'Catalog homework context required', code: 'CATALOG_HOMEWORK_DENIED' });
                return next();
            }
            catch {
                return res.status(503).json({ error: 'Homework authority unavailable', code: 'CATALOG_HOMEWORK_UNAVAILABLE' });
            }
        }
        try {
            if (!deps.catalog || !runAtomic)
                return res.status(503).json({ error: 'Catalog homework unavailable', code: 'CATALOG_HOMEWORK_UNAVAILABLE' });
            const path = String(req.url).split('?')[0];
            const match = /^\/catalog\/courses\/([^/]+)\/lessons\/([^/]+)\/activities\/([^/]+)\/(submission-policy|requests\/[^/]+|submissions(?:\/mine|\/[^/]+\/(?:upload-authorization|finalize|cancel))?)$/.exec(path);
            if (!match)
                return res.status(404).json({ error: 'Catalog homework route not found' });
            const selectors = { courseId: decodeURIComponent(match[1]), lessonId: decodeURIComponent(match[2]), contentId: decodeURIComponent(match[3]) };
            if (!Object.values(selectors).every(catalog_homework_access_1.homeworkUuid) || Object.keys(req.query ?? {}).length || ['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'].some(k => req.headers[k] !== undefined))
                return res.status(400).json({ error: 'Invalid catalog homework selectors' });
            const user = req.user;
            if (!user || user.role !== 'student' || !user.studentEnrollmentId)
                return res.status(403).json({ error: 'Selected student workspace required' });
            const suffix = match[4], creating = req.method === 'POST' && suffix === 'submissions';
            if (!(req.method === 'GET' && (suffix === 'submission-policy' || suffix === 'submissions/mine' || suffix.startsWith('requests/')) || req.method === 'POST' && (creating || /^submissions\/[^/]+\/(upload-authorization|finalize|cancel)$/.test(suffix))))
                return res.status(405).json({ error: 'Unsupported homework operation' });
            const body = req.body ?? {};
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== (creating ? 'file_name,file_type' : ''))
                return res.status(400).json({ error: 'Invalid catalog homework body' });
            const requestKey = creating ? req.headers['idempotency-key'] : suffix.startsWith('requests/') ? decodeURIComponent(suffix.slice(9)) : undefined;
            if ((creating || suffix.startsWith('requests/')) && !(0, catalog_homework_access_1.homeworkUuid)(requestKey))
                return res.status(400).json({ error: 'A UUID request key is required' });
            const context = await deps.catalog.resolve(db, user, selectors);
            const sid = /^submissions\/([^/]+)\//.exec(suffix)?.[1];
            if (sid && !(0, catalog_homework_access_1.homeworkUuid)(sid))
                return res.status(400).json({ error: 'Invalid submission selector' });
            catalogRequests.set(res, { context, principal: user, submissionId: sid, requestKey: requestKey, writing: false });
            const json = res.json.bind(res);
            res.json = ((payload) => {
                const fields = ['id', 'version', 'status', 'file_name', 'file_type', 'file_size_bytes', 'upload_status', 'scan_status', 'is_late', 'submitted_at', 'revoked_at', 'upload', 'cancelled', 'quarantine_cleanup', 'error', 'code', 'submission', 'unchanged', 'content_id', 'deadline_at', 'late_policy', 'resubmission_policy', 'max_submissions', 'max_file_bytes', 'allowed_file_types', 'accepting', 'reason', 'upload_configured'];
                const project = (row) => row && typeof row === 'object' && !Array.isArray(row)
                    ? Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(row, key)).map(key => [key, row[key]])) : row;
                return json(Array.isArray(payload) ? payload.map(project) : project(payload));
            });
            if (sid)
                await deps.catalog.checkSubmission(db, context, sid);
            if (requestKey) {
                const old = await db.queryOne(`SELECT id,version,status,file_name,file_type,file_size_bytes,scan_status,catalog_context FROM assignment_submissions WHERE tenant_id=? AND student_enrollment_id=? AND catalog_request_key=? LIMIT 1`, [context.tenantId, context.enrollmentId, requestKey]);
                if (old) {
                    if (!(0, catalog_homework_access_1.sameHomeworkContext)(old.catalog_context, context) || creating && (old.file_name !== body.file_name?.trim?.() || old.file_type !== body.file_type?.trim?.()))
                        return res.status(409).json({ error: 'Request key belongs to different homework or file', code: 'CATALOG_REQUEST_CONFLICT' });
                    await guardCatalog(res);
                    return res.json({ submission: { id: old.id, version: Number(old.version), status: old.status, file_name: old.file_name, file_type: old.file_type, file_size_bytes: Number(old.file_size_bytes), upload_status: (0, assignments_1.deriveUploadStatus)(Number(old.file_size_bytes), old.scan_status), scan_status: old.scan_status }, unchanged: true });
                }
                if (req.method === 'GET') {
                    await guardCatalog(res);
                    return res.json({ submission: null });
                }
            }
            if (suffix === 'submission-policy') {
                const row = await loadAssignmentForEnrollment(context.tenantId, context.assignmentId);
                if (!row)
                    throw new catalog_homework_access_1.CatalogHomeworkDenied();
                const rows = await loadEnrollmentSubmissions(context.tenantId, context.assignmentId, context.enrollmentId);
                const decision = (0, assignments_1.evaluateSubmission)(submissionInput(row), toExistingSubmissions(rows), now());
                await guardCatalog(res);
                return res.json({ content_id: context.contentId, deadline_at: (0, content_release_1.toUtcIso)(row.deadline_at), late_policy: row.late_policy, resubmission_policy: row.resubmission_policy, max_submissions: Number(row.max_submissions), max_file_bytes: Number(row.max_file_bytes), allowed_file_types: parseJsonArray(row.allowed_file_types), accepting: decision.allowed, reason: decision.allowed ? null : decision.reason, upload_configured: Boolean(objectStore && (0, assignment_storage_1.supportsExactVersionRemoval)(objectStore) && deps.objectVersionColumn === 'declared' && deps.cleanupObligations?.availability?.mode === 'durable') });
            }
            if (req.method === 'POST' && (!objectStore || !(0, assignment_storage_1.supportsExactVersionRemoval)(objectStore) || deps.objectVersionColumn !== 'declared' || deps.cleanupObligations?.availability?.mode !== 'durable'))
                return res.status(503).json({ error: 'Catalog private upload dependencies unavailable', code: 'CATALOG_HOMEWORK_UNAVAILABLE' });
            req.url = `/${context.assignmentId}/${suffix}`;
            return next();
        }
        catch (error) {
            if (catalogFailure(res, error))
                return;
            return res.status(error instanceof catalog_homework_access_1.CatalogHomeworkDenied ? 403 : 503).json({ error: 'Catalog homework unavailable', code: error instanceof catalog_homework_access_1.CatalogHomeworkDenied ? 'CATALOG_HOMEWORK_DENIED' : 'CATALOG_HOMEWORK_UNAVAILABLE' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* Scope resolvers                                                        */
    /* --------------------------------------------------------------------- */
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
    const resolveEnrollment = async (req, res) => {
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
        const row = await db.queryOne(`SELECT s.id, s.tenant_id, s.group_id, grp.branch_id, grp.branch_scope, grp.course_id
             FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
             WHERE s.user_id=? AND s.tenant_id=? ${deps.catalog ? 'AND s.id=?' : ''} AND s.is_active=1 AND s.approval_status='approved'
               AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
               AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
               AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
             LIMIT 1`, [user.id, user.tenantId, ...(deps.catalog ? [user.studentEnrollmentId ?? ''] : [])]);
        if (!row || deps.catalog && row.id !== user.studentEnrollmentId) {
            res.status(404).json({ error: 'Student workspace not found' });
            return null;
        }
        const branchId = row.branch_scope === 'branch' ? row.branch_id : null;
        return {
            id: row.id, userId: user.id, tenantId: row.tenant_id, branchId,
            groupId: row.group_id, courseId: row.course_id ?? null,
        };
    };
    /* --------------------------------------------------------------------- */
    /* Authority helpers                                                      */
    /* --------------------------------------------------------------------- */
    const authorizeBranch = async (scope, branchId) => {
        const decision = await (0, branch_access_1.resolveBranchAccess)(branchAccess, {
            principalUserId: scope.userId,
            principalTenantId: scope.tenantId,
            branchId,
            principalIsTenantOwner: scope.isOwner,
        });
        return decision.kind === 'allowed';
    };
    const courseInTenant = async (tenantId, courseId) => {
        const row = await db.queryOne('SELECT id, tenant_id FROM courses WHERE id = ? LIMIT 1', [courseId]);
        return Boolean(row && row.tenant_id === tenantId);
    };
    const groupInTenant = async (scope, groupId) => {
        const row = await db.queryOne(`SELECT g.id, g.instructor_id, c.tenant_id
             FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
             WHERE g.id = ? LIMIT 1`, [groupId]);
        if (!row || row.tenant_id !== scope.tenantId)
            return false;
        return scope.isOwner || row.instructor_id === scope.userId;
    };
    /**
     * Row-level staff visibility. A tenant owner sees every assignment in the
     * tenant. A non-owner sees tenant-level assignments (restricted to groups
     * they own) plus their own branch's assignments. Deny by default.
     */
    const buildStaffVisibility = (scope) => {
        if (scope.isOwner)
            return { sql: '1=1', params: [] };
        const ownedGroups = 'group_id IN (SELECT id FROM `groups` WHERE instructor_id = ?)';
        if (scope.branchId) {
            return {
                sql: `((branch_scope='tenant' AND (group_id IS NULL OR ${ownedGroups})) OR (branch_scope='branch' AND branch_id=?))`,
                params: [scope.userId, scope.branchId],
            };
        }
        return {
            sql: `(branch_scope='tenant' AND (group_id IS NULL OR ${ownedGroups}))`,
            params: [scope.userId],
        };
    };
    const loadAssignmentForStaff = async (scope, assignmentId) => {
        const visibility = buildStaffVisibility(scope);
        return db.queryOne(`SELECT ${ASSIGNMENT_COLUMNS} FROM assignments
             WHERE id = ? AND tenant_id = ? AND ${visibility.sql} LIMIT 1`, [assignmentId, scope.tenantId, ...visibility.params]);
    };
    const loadAssignmentForEnrollment = async (tenantId, assignmentId) => db.queryOne(`SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE id = ? AND tenant_id = ? LIMIT 1`, [assignmentId, tenantId]);
    /**
     * Assigned-teacher authority over **grading** one assignment.
     *
     * This is deliberately stricter than row visibility: a tenant-wide
     * assignment is visible to every instructor in the tenant, but only the
     * tenant owner, the assignment's author, the instructor of its group, or
     * the instructor of its course may put a grade on a student.
     *
     * A **group-scoped** assignment belongs to exactly one group. A teacher of
     * a *different* group is not its assigned teacher even when both groups
     * share the course or the branch, so the course-level "teaches a group in
     * this course" widening is applied only to course-wide assignments.
     *
     * Verified branch membership is never authority on its own: a membership
     * is a placement in an org unit, not an assignment to a cohort's work.
     * Likewise a role label, a tenant membership or a client-supplied id is
     * never authority. Deny by default.
     */
    const authorizeAssignmentGrading = async (scope, assignment) => {
        if (scope.isOwner)
            return true;
        if (assignment.created_by !== null && assignment.created_by === scope.userId)
            return true;
        const groupScoped = assignment.group_id !== null;
        if (assignment.group_id) {
            const group = await db.queryOne(`SELECT g.instructor_id, c.tenant_id
                 FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
                 WHERE g.id = ? LIMIT 1`, [assignment.group_id]);
            if (group && group.tenant_id === scope.tenantId && group.instructor_id === scope.userId)
                return true;
        }
        if (assignment.course_id) {
            const course = await db.queryOne('SELECT id, instructor_id, tenant_id FROM courses WHERE id = ? LIMIT 1', [assignment.course_id]);
            if (course && course.tenant_id === scope.tenantId) {
                if (course.instructor_id === scope.userId)
                    return true;
                if (!groupScoped) {
                    const taught = await db.queryOne(`SELECT g.id FROM \`groups\` g INNER JOIN courses c ON c.id = g.course_id
                         WHERE g.course_id = ? AND g.instructor_id = ? AND c.tenant_id = ? LIMIT 1`, [assignment.course_id, scope.userId, scope.tenantId]);
                    if (taught)
                        return true;
                }
            }
        }
        return false;
    };
    /** True when the enrollment belongs to a group (or active course link) of this course. */
    const enrollmentInCourse = async (tenantId, enrollmentId, courseId) => {
        const row = await db.queryOne(`SELECT s.id FROM students s
               LEFT JOIN \`groups\` g ON g.id = s.group_id
               LEFT JOIN student_courses sc ON sc.student_id = s.id AND sc.course_id = ? AND sc.status='active'
              WHERE s.id=? AND s.tenant_id=? AND (g.course_id = ? OR sc.course_id IS NOT NULL) LIMIT 1`, [courseId, enrollmentId, tenantId, courseId]);
        return Boolean(row);
    };
    const SUBMISSION_COLUMNS = 'id,assignment_id,tenant_id,student_enrollment_id,student_user_id,version,status,' +
        'file_name,file_type,file_size_bytes,scan_status,is_late,submitted_at,revoked_at';
    /**
     * Staff listing: tenant + assignment scoped, bounded to the newest 200 rows.
     * Staff read the whole cohort, so this is a deliberate page cap; no student
     * version or limit decision is ever made from it.
     */
    const loadSubmissions = async (tenantId, assignmentId) => db.query(`SELECT ${SUBMISSION_COLUMNS}
             FROM assignment_submissions WHERE assignment_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`, [assignmentId, tenantId]);
    /**
     * The caller's own history, filtered in SQL by the verified enrollment id.
     * Unbounded on purpose: the next version and the resubmission/limit gates
     * must be computed from the complete history. A tenant-wide window would
     * hide a student's older versions behind other students' newer rows once
     * an assignment passes 200 submissions. The per-(assignment, enrollment,
     * version) UNIQUE key still owns the append race.
     */
    const loadEnrollmentSubmissions = async (tenantId, assignmentId, enrollmentId) => {
        const rows = await db.query(`SELECT ${SUBMISSION_COLUMNS}
             FROM assignment_submissions
             WHERE assignment_id = ? AND tenant_id = ? AND student_enrollment_id = ?
             ORDER BY version DESC${deps.catalog ? ' LIMIT 1001' : ''}`, [assignmentId, tenantId, enrollmentId]);
        if (deps.catalog && rows.length > 1000)
            throw Error('Homework history exceeds admission bound');
        return rows;
    };
    /** The caller's own submission version, including its private key. */
    const loadOwnSubmission = async (tenantId, assignmentId, enrollmentId, submissionId) => db.queryOne(`SELECT ${SUBMISSION_COLUMNS},storage_key
             FROM assignment_submissions
             WHERE id = ? AND assignment_id = ? AND tenant_id = ? AND student_enrollment_id = ?
             LIMIT 1`, [submissionId, assignmentId, tenantId, enrollmentId]);
    /**
     * The policy view of the caller's own history. The verified size and the
     * submission instant decide whether an unverified row is still in flight
     * or abandoned (see `evaluateSubmission`).
     */
    const toExistingSubmissions = (rows) => rows.map((row) => ({
        version: Number(row.version),
        status: row.status,
        fileSizeBytes: Number(row.file_size_bytes),
        submittedAtMs: submittedAtMs(row.submitted_at),
    }));
    /**
     * Short-lived private upload authorization. The key is already the
     * server-generated one; the adapter only signs it. When the adapter can
     * sign a content-length range the store itself refuses an oversize body;
     * otherwise the response reports that the cap is only verified after the
     * upload. Any storage error is a hard failure (no fake target, no row
     * state change).
     */
    const buildUploadAuthorization = async (storageKey, extension, maxBytes) => {
        if (!objectStore)
            return null;
        const contentType = (0, assignment_storage_1.expectedContentType)(extension);
        if (!contentType)
            return null;
        const expiresAt = new Date(now().getTime() + uploadTtlSeconds * 1000).toISOString();
        if (objectStore.createUploadAuthorization) {
            const signed = await objectStore.createUploadAuthorization({
                objectKey: storageKey,
                contentType,
                expiresInSeconds: uploadTtlSeconds,
                maxBytes,
            });
            const post = signed.method === 'POST';
            return {
                method: signed.method,
                url: signed.url,
                ...(post ? { fields: signed.fields ?? {} } : {}),
                expires_in_seconds: uploadTtlSeconds,
                expires_at: expiresAt,
                required_headers: post ? {} : { 'Content-Type': contentType },
                max_bytes: maxBytes,
                max_bytes_enforced: signed.maxBytesEnforced,
                max_bytes_enforcement: signed.maxBytesEnforced
                    ? 'signed_content_length_range'
                    : 'finalize_stat_only',
            };
        }
        const url = await objectStore.createUploadUrl({
            objectKey: storageKey,
            contentType,
            expiresInSeconds: uploadTtlSeconds,
        });
        return {
            method: 'PUT',
            url,
            expires_in_seconds: uploadTtlSeconds,
            expires_at: expiresAt,
            required_headers: { 'Content-Type': contentType },
            max_bytes: maxBytes,
            max_bytes_enforced: false,
            max_bytes_enforcement: 'finalize_stat_only',
        };
    };
    /**
     * Build the durable identity of one object version. Returns null when the
     * key does not bind to these identifiers, so an unbound target is never
     * recorded and never deleted.
     */
    const buildCleanupTarget = (storageKey, version, facts, reason) => (0, assignment_cleanup_recovery_1.normalizeCleanupTarget)({
        tenantId: facts.tenantId,
        assignmentId: facts.assignmentId,
        enrollmentId: facts.enrollmentId,
        submissionId: facts.submissionId,
        storageKey,
        etag: version.etag,
        sizeBytes: version.sizeBytes,
        reason,
    });
    /**
     * Write the obligation ahead of the delete, on the caller's unit of work.
     *
     * The insert joins the caller's transaction and a failure **propagates**, so
     * a rejection or cancellation rolls back rather than committing a state
     * change whose cleanup was never recorded. There is no standalone variant:
     * an obligation written outside a transaction would be an autocommit write,
     * so a caller with no transaction of its own runs this through the admitted
     * seam.
     */
    const recordCleanup = async (target, tx) => 
    // The same transaction, on the same connection: the adapter's
    // idempotent insert **and** the read-back that classifies it both run
    // here, so the obligation cannot commit apart from the decision.
    (0, assignment_cleanup_recovery_1.recordCleanupObligation)(deps.cleanupObligations, target, {
        // Wrapped, not extracted: `query`/`execute` are interface
        // properties, and an implementation that reads `this` would
        // break the moment the method is passed unbound.
        query: (sql, params) => tx.query(sql, params),
        execute: (sql, params) => tx.execute(sql, params),
    });
    /**
     * Delete **exactly** the recorded version, then settle the obligation.
     *
     * The delete is the capability-gated exact-version seam — never
     * `removeObject(storage_key)`, which would destroy whatever sits at the key
     * when it runs, including a concurrent re-upload no verifier ever looked at.
     * External deletion and the DB completion are two stages on purpose: if the
     * process dies between them the row stays `pending` and the recovery
     * coordinator replays it, learning from the store that the target is already
     * gone.
     */
    const performVersionCleanup = async (target, handle) => {
        // A configured store must have confirmed its write-ahead row. Only
        // the separately documented absent-store legacy path is unconfigured.
        if (handle.recording !== 'recorded' && handle.recording !== 'existing'
            && handle.recording !== 'unconfigured')
            return 'unsupported';
        if (!objectStore)
            return 'unsupported';
        const cleanup = await (0, assignment_storage_1.removeScannedObjectVersion)(objectStore, { objectKey: target.storageKey, etag: target.etag, sizeBytes: target.sizeBytes }, (error) => console.error(`Assignment cleanup failed for submission ${target.submissionId}:`, error));
        const proof = (0, assignment_cleanup_recovery_1.cleanupProofForRemoval)(cleanup);
        if (proof !== null && handle.recording !== 'unconfigured') {
            const settled = await (0, assignment_cleanup_recovery_1.settleRecordedCleanup)(deps.cleanupObligations, handle, proof, now().getTime());
            if (!settled) {
                // The row stays pending and the coordinator replays it. Nothing
                // about the response changes, and no success is claimed here.
                console.error(`Assignment cleanup obligation not settled for submission ${target.submissionId};`
                    + ' it stays pending for the recovery pass');
            }
        }
        if (cleanup === 'unsupported' || cleanup === 'failed') {
            console.error(`Assignment rejection cleanup pending for submission ${target.submissionId}:`
                + ' the storage adapter cannot delete by exact object version');
        }
        return cleanup;
    };
    /**
     * Full orchestration for a rejection that owns its own unit of work: record,
     * delete, settle. `not_attempted` means no delete was issued — either no
     * exact version could be bound, the obligation could not be recorded (so the
     * write-ahead property would be lost), or another version of this submission
     * still owes cleanup.
     */
    const removeRejectedObject = async (target, submissionId, atomic) => {
        if (!objectStore)
            return 'unsupported';
        if (!target) {
            console.error(`Assignment rejection cleanup pending for submission ${submissionId}:`
                + ' the verified object version is not bound to this submission');
            return 'not_attempted';
        }
        let handle;
        try {
            // Its own unit of work, on a real transaction connection: the
            // obligation is written ahead of the delete and never as an
            // autocommit statement on the shared pool.
            handle = await atomic(async (unit) => recordCleanup(target, unit));
        }
        catch (error) {
            console.error(`Assignment cleanup obligation could not be recorded for submission ${submissionId}:`, error);
            return 'not_attempted';
        }
        // `record_failed`: the write did not land. `store_invalid_row`: it landed
        // but cannot be read, so we cannot say whether this version is already
        // owed. Both mean the write-ahead property is unavailable, and the only
        // honest answer is to issue no delete.
        if (handle.recording === 'record_failed' || handle.recording === 'store_invalid_row' || handle.recording === 'store_unavailable') {
            return 'not_attempted';
        }
        if (handle.recording === 'conflict') {
            // A different version of this submission already owes cleanup; that
            // obligation is still pending and this call must not claim the new
            // version was queued. The coordinator owns the older one.
            console.error(`Assignment rejection cleanup deferred for submission ${submissionId}:`
                + ' a different version of this submission already owes cleanup');
            return 'not_attempted';
        }
        return performVersionCleanup(target, handle);
    };
    /**
     * Quarantine cleanup for an `infected` verdict: destroy **exactly** the
     * object version the scan rejected, never "whatever is at the key now".
     *
     * The obligation was already recorded inside the verdict transaction, so this
     * only performs the external stage and settles it. A mutable-key delete here
     * would be a correctness bug: between the final re-stat and the delete the
     * key can be rewritten by a concurrent upload, and the delete would destroy
     * bytes no scanner ever looked at.
     */
    const quarantineRejectedObject = async (target, handle, submissionId) => {
        if (!objectStore)
            return 'unsupported';
        if (!target) {
            console.error(`Assignment quarantine cleanup pending for submission ${submissionId}:`
                + ' the scanned object version is not bound to this submission');
            return 'unsupported';
        }
        const cleanup = await performVersionCleanup(target, handle);
        if (cleanup === 'unsupported') {
            console.error(`Assignment quarantine cleanup pending for submission ${submissionId}:`
                + ' the storage adapter cannot delete by exact object version');
        }
        return cleanup;
    };
    /* --------------------------------------------------------------------- */
    /* Projections (private storage_key is never exposed)                     */
    /* --------------------------------------------------------------------- */
    const projectAssignment = (row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        branch_scope: row.branch_scope,
        course_id: row.course_id,
        group_id: row.group_id,
        title: row.title,
        instructions: row.instructions,
        deadline_at: (0, content_release_1.toUtcIso)(row.deadline_at),
        deadline_timezone: row.deadline_timezone,
        late_policy: row.late_policy,
        resubmission_policy: row.resubmission_policy,
        max_submissions: Number(row.max_submissions),
        max_file_bytes: Number(row.max_file_bytes),
        allowed_file_types: parseJsonArray(row.allowed_file_types),
        status: row.status,
        archived: row.archived_at !== null && row.archived_at !== undefined,
    });
    const projectSubmission = (row) => ({
        id: row.id,
        assignment_id: row.assignment_id,
        student_enrollment_id: row.student_enrollment_id,
        version: Number(row.version),
        status: row.status,
        file_name: row.file_name,
        file_type: row.file_type,
        file_size_bytes: Number(row.file_size_bytes),
        upload_status: (0, assignments_1.deriveUploadStatus)(Number(row.file_size_bytes), row.scan_status),
        scan_status: row.scan_status,
        is_late: Boolean(row.is_late),
        submitted_at: (0, content_release_1.toUtcIso)(row.submitted_at),
        revoked_at: (0, content_release_1.toUtcIso)(row.revoked_at),
    });
    /** Finalize response: persisted state only, never an object key or URL. */
    const finalizeProjection = (row) => ({
        id: row.id,
        version: Number(row.version),
        upload_status: (0, assignments_1.deriveUploadStatus)(Number(row.file_size_bytes), row.scan_status),
        scan_status: row.scan_status,
        file_size_bytes: Number(row.file_size_bytes),
        status: row.status,
    });
    const assignmentAudience = (row) => ({
        tenantId: row.tenant_id,
        branchScope: row.branch_scope,
        branchId: row.branch_id,
        groupId: row.group_id,
        courseId: row.course_id ?? null,
    });
    const submissionInput = (row) => ({
        status: row.status,
        archived: row.archived_at !== null && row.archived_at !== undefined,
        deadlineUtc: (0, content_release_1.toUtcIso)(row.deadline_at),
        latePolicy: row.late_policy,
        resubmissionPolicy: row.resubmission_policy,
        maxSubmissions: Number(row.max_submissions),
    });
    const enrollmentAudience = (enrollment) => ({
        tenantId: enrollment.tenantId,
        branchId: enrollment.branchId,
        groupId: enrollment.groupId,
        courseId: enrollment.courseId,
    });
    /* --------------------------------------------------------------------- */
    /* GET / — staff list                                                     */
    /* --------------------------------------------------------------------- */
    router.get('/', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const visibility = buildStaffVisibility(scope);
            const params = [scope.tenantId, ...visibility.params];
            let sql = `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE tenant_id = ? AND ${visibility.sql}`;
            if (req.query.include_archived !== 'true')
                sql += ' AND archived_at IS NULL';
            sql += ' ORDER BY created_at DESC LIMIT 200';
            res.json((await db.query(sql, params)).map(projectAssignment));
        }
        catch (error) {
            console.error('List assignments error:', error);
            res.status(500).json({ error: 'Failed to list assignments' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST / — staff create (audited)                                        */
    /* --------------------------------------------------------------------- */
    router.post('/', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const validated = (0, assignments_1.validateAssignmentInput)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const value = validated.value;
            if (value.branchId && !(await authorizeBranch(scope, value.branchId))) {
                return res.status(403).json({ error: 'Branch membership required' });
            }
            if (value.courseId && !(await courseInTenant(scope.tenantId, value.courseId))) {
                return res.status(403).json({ error: 'Course is outside this tenant' });
            }
            if (value.groupId && !(await groupInTenant(scope, value.groupId))) {
                return res.status(403).json({ error: 'Group is outside this tenant' });
            }
            // Admission before the first write: the row and its audit event
            // commit together or not at all.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            const id = (0, crypto_1.randomUUID)();
            await atomic(async (tx) => {
                await tx.execute(`INSERT INTO assignments
                       (id,tenant_id,branch_id,branch_scope,course_id,group_id,title,instructions,deadline_at,deadline_timezone,
                        late_policy,resubmission_policy,max_submissions,max_file_bytes,allowed_file_types,status,created_by)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?)`, [
                    id, scope.tenantId, value.branchId, value.branchScope, value.courseId, value.groupId, value.title,
                    value.instructions, value.deadlineUtc === null ? null : value.deadlineUtc.slice(0, 19).replace('T', ' '),
                    value.deadlineTimeZone, value.latePolicy, value.resubmissionPolicy, value.maxSubmissions,
                    value.maxFileBytes, JSON.stringify(value.allowedFileTypes), scope.userId,
                ]);
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.create',
                    resourceType: 'assignment',
                    resourceId: id,
                    newValue: (0, audit_1.snapshotRow)({
                        branch_scope: value.branchScope,
                        branch_id: value.branchId,
                        course_id: value.courseId,
                        group_id: value.groupId,
                        late_policy: value.latePolicy,
                        resubmission_policy: value.resubmissionPolicy,
                    }),
                });
            });
            res.status(201).json({ id, status: 'draft', deadline_at: value.deadlineUtc });
        }
        catch (error) {
            console.error('Create assignment error:', error);
            res.status(500).json({ error: 'Failed to create assignment' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /student — enrolled student list                                   */
    /* --------------------------------------------------------------------- */
    router.get('/student', async (req, res) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment)
                return;
            const rows = await db.query(`SELECT ${ASSIGNMENT_COLUMNS} FROM assignments
                 WHERE tenant_id = ? AND status = 'published' AND archived_at IS NULL
                 ORDER BY created_at DESC LIMIT 200`, [enrollment.tenantId]);
            const audience = enrollmentAudience(enrollment);
            res.json(rows.filter((row) => (0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(row), audience)).map(projectAssignment));
        }
        catch (error) {
            console.error('Student assignments error:', error);
            res.status(500).json({ error: 'Failed to load assignments' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions — enrolled student submit (audited).             */
    /* Creates the append-only version and a short-lived private upload      */
    /* authorization. No object fact is accepted from the client.            */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions', async (req, res) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const limits = {
                maxFileBytes: Number(assignment.max_file_bytes),
                allowedFileTypes: parseJsonArray(assignment.allowed_file_types),
            };
            const upload = (0, assignments_1.validateUploadRequest)(req.body, limits);
            if (!upload.ok)
                return res.status(400).json({ error: upload.error });
            if (!objectStore) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            if (!(0, assignment_storage_1.expectedContentType)(upload.value.extension)) {
                return res.status(400).json({
                    error: 'file type cannot be verified for a secure upload',
                    code: 'unsupported_file_type',
                });
            }
            const existing = toExistingSubmissions(await loadEnrollmentSubmissions(enrollment.tenantId, assignmentId, enrollment.id));
            let decision = (0, assignments_1.evaluateSubmission)(submissionInput(assignment), existing, now());
            if (!decision.allowed) {
                return res.status(403).json({ error: 'Submission is not allowed', code: decision.reason });
            }
            // Admission before the upload is authorized and before the version
            // row is written: the row and its audit event are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            const submissionId = (0, crypto_1.randomUUID)();
            const storageKey = (0, assignments_1.buildSubmissionStorageKey)({
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: upload.value.extension,
            });
            if (storageKey === null) {
                return res.status(500).json({ error: 'Failed to generate the private upload target' });
            }
            // Signing is local (no bytes move); a storage-side failure means the
            // client must not receive a target and no row is written.
            let authorization;
            try {
                authorization = await buildUploadAuthorization(storageKey, upload.value.extension, limits.maxFileBytes);
            }
            catch (error) {
                console.error('Assignment upload authorization error:', error);
                return res.status(502).json({ error: 'Failed to authorize the upload', code: 'storage_unavailable' });
            }
            if (!authorization) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            let status = decision.late ? 'late' : 'submitted';
            try {
                await atomic(async (tx) => {
                    const catalog = catalogRequests.get(res);
                    if (catalog) {
                        const current = await tx.queryOne(`SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE id=? AND tenant_id=? LIMIT 1 FOR UPDATE`, [assignmentId, enrollment.tenantId]);
                        const policy = (row) => JSON.stringify([submissionInput(row), assignmentAudience(row), Number(row.max_file_bytes), parseJsonArray(row.allowed_file_types)]);
                        if (!current || policy(current) !== policy(assignment))
                            throw new catalog_homework_access_1.CatalogHomeworkDenied();
                        const rows = await tx.query(`SELECT ${SUBMISSION_COLUMNS} FROM assignment_submissions WHERE assignment_id=? AND tenant_id=? AND student_enrollment_id=? ORDER BY version DESC LIMIT 1001 FOR UPDATE`, [assignmentId, enrollment.tenantId, enrollment.id]);
                        if (rows.length > 1000)
                            throw Error('Homework history exceeds admission bound');
                        decision = (0, assignments_1.evaluateSubmission)(submissionInput(current), toExistingSubmissions(rows), now());
                        if (!decision.allowed)
                            throw new catalog_homework_access_1.CatalogHomeworkDenied();
                        status = decision.late ? 'late' : 'submitted';
                    }
                    if (!decision.allowed)
                        throw new catalog_homework_access_1.CatalogHomeworkDenied();
                    const inserted = await tx.execute(`INSERT INTO assignment_submissions
                           (id,tenant_id,assignment_id,student_enrollment_id,student_user_id,version,status,
                            file_name,file_type,file_size_bytes,storage_key,scan_status,is_late${catalog ? ',catalog_context,catalog_request_key' : ''})
                         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?${catalog ? ',?,?' : ''})`, [
                        submissionId, enrollment.tenantId, assignmentId, enrollment.id, enrollment.userId,
                        decision.nextVersion, status, upload.value.fileName, upload.value.fileType,
                        0, storageKey, decision.late ? 1 : 0, ...(catalog ? [JSON.stringify(catalog.context), catalog.requestKey] : []),
                    ]);
                    if (catalog && inserted.affectedRows !== 1)
                        throw Error('Submission insert not confirmed');
                    await (0, audit_1.recordAudit)(tx.execute, {
                        actorUserId: enrollment.userId,
                        tenantId: enrollment.tenantId,
                        action: 'assignment.submission.create',
                        resourceType: 'assignment_submission',
                        resourceId: submissionId,
                        newValue: (0, audit_1.snapshotRow)({
                            assignment_id: assignmentId,
                            version: decision.nextVersion,
                            file_name: upload.value.fileName,
                            file_size_bytes: 0,
                            upload_status: 'pending_upload',
                            late: decision.late,
                        }),
                    });
                });
            }
            catch (error) {
                if (!isDuplicateKeyError(error))
                    throw error;
                // The per-(assignment,enrollment)-version UNIQUE key decided the
                // race; re-evaluate from committed state for a precise policy
                // answer instead of a raw 500.
                const raced = toExistingSubmissions(await loadEnrollmentSubmissions(enrollment.tenantId, assignmentId, enrollment.id));
                const denial = (0, assignments_1.evaluateSubmission)(submissionInput(assignment), raced, now());
                if (!denial.allowed) {
                    return res.status(403).json({ error: 'Submission is not allowed', code: denial.reason });
                }
                return res.status(409).json({ error: 'Submission changed concurrently, please retry' });
            }
            await guardCatalog(res);
            res.status(201).json({
                id: submissionId,
                assignment_id: assignmentId,
                version: decision.nextVersion,
                status,
                is_late: decision.late,
                file_size_bytes: 0,
                upload_status: 'pending_upload',
                scan_status: 'pending',
                upload: authorization,
            });
        }
        catch (error) {
            if (catalogFailure(res, error))
                return;
            console.error('Create assignment submission error:', error);
            res.status(500).json({ error: 'Failed to submit assignment' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/upload-authorization              */
    /* Re-issues a short-lived private URL for a still-pending own version.  */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/upload-authorization', async (req, res) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            const submissionId = (0, assignments_1.normalizeId)(req.params.submissionId);
            if (!assignmentId || !submissionId)
                return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const row = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
            if (!row)
                return res.status(404).json({ error: 'Submission not found' });
            if (row.status === 'revoked') {
                return res.status(409).json({ error: 'Submission is revoked', code: 'submission_revoked' });
            }
            if (Number(row.file_size_bytes) > 0) {
                return res.status(409).json({ error: 'Submission is already finalized', code: 'already_finalized' });
            }
            const window = (0, assignments_1.evaluateSubmissionWindow)(submissionInput(assignment), now());
            if (!window.open) {
                return res.status(403).json({
                    error: 'Submission is not open',
                    code: window.reason === 'deadline_passed' ? 'DEADLINE_PASSED' : 'NOT_OPEN',
                });
            }
            if (!objectStore) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            const parsed = (0, assignment_storage_1.parseSubmissionStorageKey)(row.storage_key);
            const expected = {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: parsed?.fileExtension ?? '',
            };
            if (!parsed || !(0, assignment_storage_1.verifySubmissionStorageKey)(row.storage_key, expected)) {
                console.error(`Assignment storage binding mismatch for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'Stored object reference does not match this submission',
                    code: 'storage_binding_mismatch',
                });
            }
            let authorization;
            try {
                authorization = await buildUploadAuthorization(row.storage_key, parsed.fileExtension, Number(assignment.max_file_bytes));
            }
            catch (error) {
                console.error('Assignment upload authorization error:', error);
                return res.status(502).json({ error: 'Failed to authorize the upload', code: 'storage_unavailable' });
            }
            if (!authorization) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            await guardCatalog(res);
            res.json({
                id: submissionId,
                assignment_id: assignmentId,
                version: Number(row.version),
                upload_status: 'pending_upload',
                scan_status: 'pending',
                upload: authorization,
            });
        }
        catch (error) {
            if (catalogFailure(res, error))
                return;
            console.error('Assignment upload authorization error:', error);
            res.status(500).json({ error: 'Failed to authorize the upload' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/cancel                            */
    /* Student cancels an unverified own version. A cancelled (revoked)      */
    /* version holds no content and no longer counts toward the attempt      */
    /* budget, so the student can legitimately submit again.                 */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/cancel', async (req, res) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            const submissionId = (0, assignments_1.normalizeId)(req.params.submissionId);
            if (!assignmentId || !submissionId)
                return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const row = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
            if (!row)
                return res.status(404).json({ error: 'Submission not found' });
            if (row.status === 'revoked') {
                // Idempotent: the slot is already free.
                return res.json({ id: submissionId, status: 'revoked', cancelled: false });
            }
            if (Number(row.file_size_bytes) > 0) {
                return res.status(409).json({
                    error: 'A verified upload can only be revoked by staff',
                    code: 'already_finalized',
                });
            }
            const parsed = (0, assignment_storage_1.parseSubmissionStorageKey)(row.storage_key);
            const expected = {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: parsed?.fileExtension ?? '',
            };
            if (!parsed || !(0, assignment_storage_1.verifySubmissionStorageKey)(row.storage_key, expected)) {
                console.error(`Assignment storage binding mismatch for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'Stored object reference does not match this submission',
                    code: 'storage_binding_mismatch',
                });
            }
            // Admission before the object is stat'ed and before the revocation
            // is written: the revocation, its audit event and the cleanup
            // obligation for the abandoned version are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            // The abandoned upload's version is proven **before** the revocation
            // transaction, so the cleanup obligation can be recorded in the same
            // unit of work as the revocation and its audit event. The stat is a
            // read; the delete still happens after commit and still names this
            // exact version, so an upload that lands in between survives — the
            // store refuses a mismatched version instead of deleting it.
            let cancelVersion = null;
            if (objectStore) {
                let cancelMetadata = null;
                try {
                    cancelMetadata = await objectStore.statObject(row.storage_key);
                }
                catch (error) {
                    console.error(`Assignment cancel stat failed for submission ${submissionId}:`, error);
                }
                cancelVersion = (0, assignment_storage_1.boundObjectVersion)(cancelMetadata);
                if (cancelMetadata !== null && cancelVersion === null) {
                    console.error(`Assignment cancel cleanup pending for submission ${submissionId}:`
                        + ' the storage adapter cannot bind the abandoned upload to a version');
                }
            }
            const cancelTarget = cancelVersion === null
                ? null
                : buildCleanupTarget(row.storage_key, cancelVersion, {
                    tenantId: enrollment.tenantId,
                    assignmentId,
                    enrollmentId: enrollment.id,
                    submissionId,
                }, 'cancelled_upload');
            let cancelled = false;
            let cancelHandle = assignment_cleanup_recovery_1.UNRECORDED_CLEANUP_HANDLE;
            try {
                cancelled = await atomic(async (tx) => {
                    const updated = await tx.execute(`UPDATE assignment_submissions
                         SET status='revoked', revoked_at=UTC_TIMESTAMP(), revoked_by=?,
                             revoke_reason='cancelled_by_student'
                         WHERE id=? AND assignment_id=? AND tenant_id=? AND student_enrollment_id=?
                           AND status<>'revoked' AND file_size_bytes=0`, [enrollment.userId, submissionId, assignmentId, enrollment.tenantId, enrollment.id]);
                    // Exactly one row: the revocation CAS names a single row by
                    // id, so `0` is a genuine miss and an unreported count is a
                    // driver-contract error, not a success.
                    if (affectedRowsOf(updated) !== 1)
                        return false;
                    await (0, audit_1.recordAudit)(tx.execute, {
                        actorUserId: enrollment.userId,
                        tenantId: enrollment.tenantId,
                        action: 'assignment.submission.cancel',
                        resourceType: 'assignment_submission',
                        resourceId: submissionId,
                        oldValue: (0, audit_1.snapshotRow)({ status: row.status, file_size_bytes: 0 }),
                        newValue: (0, audit_1.snapshotRow)({ status: 'revoked', reason: 'cancelled_by_student' }),
                    });
                    // Same unit: a cancellation whose cleanup was never recorded
                    // must not commit. Throws into the transaction on failure.
                    cancelHandle = await recordCleanup(cancelTarget, tx);
                    return true;
                });
            }
            catch (error) {
                if (catalogFailure(res, error))
                    return;
                console.error(`Assignment cancel write failed for submission ${submissionId}:`, error);
                return res.status(500).json({ error: 'Failed to cancel the submission' });
            }
            if (!cancelled) {
                const current = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
                if (current?.status === 'revoked') {
                    return res.json({ id: submissionId, status: 'revoked', cancelled: false });
                }
                if (current && Number(current.file_size_bytes) > 0) {
                    return res.status(409).json({
                        error: 'A verified upload can only be revoked by staff',
                        code: 'already_finalized',
                    });
                }
                return res.status(409).json({
                    error: 'Submission changed concurrently, please retry',
                    code: 'cancel_conflict',
                });
            }
            // The row never became readable; the abandoned bytes are removed
            // best-effort and a cleanup failure never hides the cancellation.
            // The removal is bound to the exact version proven above, so a
            // concurrent re-upload survives; a version that cannot be proven
            // leaves the bytes in place and the cleanup pending.
            if (cancelTarget === null) {
                console.error(`Assignment cancel cleanup pending for submission ${submissionId}:`
                    + ' no exact object version could be proven for the abandoned upload');
            }
            else if (cancelHandle.recording === 'conflict') {
                console.error(`Assignment cancel cleanup deferred for submission ${submissionId}:`
                    + ' a different version of this submission already owes cleanup');
            }
            else {
                await performVersionCleanup(cancelTarget, cancelHandle);
            }
            await guardCatalog(res);
            res.json({ id: submissionId, status: 'revoked', cancelled: true });
        }
        catch (error) {
            if (catalogFailure(res, error))
                return;
            console.error('Cancel assignment submission error:', error);
            res.status(500).json({ error: 'Failed to cancel the submission' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/finalize                          */
    /* Server-verifies the stored object, scans it and records the result    */
    /* atomically. The request body carries no object facts.                 */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/finalize', async (req, res) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            const submissionId = (0, assignments_1.normalizeId)(req.params.submissionId);
            if (!assignmentId || !submissionId)
                return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const row = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
            if (!row)
                return res.status(404).json({ error: 'Submission not found' });
            if (row.status === 'revoked') {
                return res.status(409).json({ error: 'Submission is revoked', code: 'submission_revoked' });
            }
            // Idempotent retry: a verified object is never re-stat'ed or
            // re-audited, and a later assignment edit cannot revoke it.
            if (Number(row.file_size_bytes) > 0) {
                await guardCatalog(res);
                return res.status(200).json(finalizeProjection(row));
            }
            const finalizeInput = (0, assignments_1.validateFinalizeRequest)(req.body);
            if (!finalizeInput.ok) {
                return res.status(400).json({ error: finalizeInput.error, code: 'untrusted_finalize_fields' });
            }
            const window = (0, assignments_1.evaluateSubmissionWindow)(submissionInput(assignment), now());
            if (!window.open) {
                return res.status(403).json({
                    error: 'Submission is not open for finalization',
                    code: window.reason === 'deadline_passed' ? 'DEADLINE_PASSED' : 'NOT_OPEN',
                });
            }
            if (!objectStore) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            const parsed = (0, assignment_storage_1.parseSubmissionStorageKey)(row.storage_key);
            const expected = {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: parsed?.fileExtension ?? '',
            };
            if (!parsed || !(0, assignment_storage_1.verifySubmissionStorageKey)(row.storage_key, expected)) {
                console.error(`Assignment storage binding mismatch for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'Stored object reference does not match this submission',
                    code: 'storage_binding_mismatch',
                });
            }
            const extension = parsed.fileExtension;
            const expectedType = (0, assignment_storage_1.expectedContentType)(extension);
            if (!expectedType) {
                return res.status(422).json({
                    error: 'This file type cannot be verified',
                    code: 'unsupported_file_type',
                });
            }
            // Admission before the first storage call: every rejection below
            // can delete bytes and owes a recorded obligation, and the verdict
            // below writes the row, its audit event and its obligation as one
            // unit. Without the seam nothing is read, deleted or written.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            let metadata;
            try {
                metadata = await objectStore.statObject(row.storage_key);
            }
            catch (error) {
                console.error(`Assignment object stat failed for submission ${submissionId}:`, error);
                return res.status(502).json({ error: 'Storage is unavailable', code: 'storage_unavailable' });
            }
            if (!metadata) {
                return res.status(404).json({ error: 'Uploaded object was not found', code: 'object_not_found' });
            }
            // Readiness must be bound to one immutable object version. An
            // adapter that reports no ETag cannot prove which bytes were
            // verified, so nothing is recorded and nothing is removed.
            const verifiedVersion = (0, assignment_storage_1.boundObjectVersion)(metadata);
            if (verifiedVersion === null) {
                console.error(`Assignment storage adapter reported no object version for submission ${submissionId}`);
                return res.status(503).json({
                    error: 'The storage adapter cannot bind this object to a version',
                    code: 'object_version_unbound',
                });
            }
            const limits = {
                maxFileBytes: Number(assignment.max_file_bytes),
                allowedFileTypes: parseJsonArray(assignment.allowed_file_types),
            };
            // Every admission denial below removes exactly this version, and each
            // one records its obligation first (when a durable store is wired).
            const rejectionTarget = (reason) => buildCleanupTarget(row.storage_key, verifiedVersion, {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
            }, reason);
            if (Number.isInteger(metadata.sizeBytes) && metadata.sizeBytes > limits.maxFileBytes) {
                await removeRejectedObject(rejectionTarget('admission_oversize'), submissionId, atomic);
                return res.status(413).json({
                    error: 'Uploaded file exceeds the assignment size limit',
                    code: 'file_size_out_of_bounds',
                });
            }
            const verifiedSize = (0, assignments_1.validateVerifiedUpload)(metadata.sizeBytes, limits);
            if (!verifiedSize.ok) {
                await removeRejectedObject(rejectionTarget('admission_size_out_of_bounds'), submissionId, atomic);
                return res.status(400).json({ error: verifiedSize.error, code: 'file_size_out_of_bounds' });
            }
            const storedType = (0, assignment_storage_1.normalizeContentType)(metadata.contentType);
            if (storedType !== expectedType) {
                await removeRejectedObject(rejectionTarget('admission_content_type_mismatch'), submissionId, atomic);
                return res.status(422).json({
                    error: 'Stored content type does not match the declared file type',
                    code: 'content_type_mismatch',
                });
            }
            let prefix;
            try {
                prefix = await objectStore.readPrefix(row.storage_key, assignment_storage_1.MAX_SIGNATURE_PREFIX_BYTES);
            }
            catch (error) {
                console.error(`Assignment object prefix read failed for submission ${submissionId}:`, error);
                return res.status(502).json({ error: 'Storage is unavailable', code: 'storage_unavailable' });
            }
            const signature = (0, assignment_storage_1.verifyObjectSignature)(extension, prefix);
            if (!signature.ok) {
                await removeRejectedObject(rejectionTarget('admission_signature_mismatch'), submissionId, atomic);
                return res.status(422).json({
                    error: 'Uploaded content does not match its file type',
                    code: signature.reason === 'unsupported_type' ? 'unsupported_file_type' : 'signature_mismatch',
                });
            }
            // Uploaded is not clean. An absent scanner leaves the row in
            // pending_scan; a scanner that cannot answer is retryable and does
            // not touch the row; only an explicit clean verdict is recorded.
            // The scan runs under a hard wall-clock bound, and its input
            // carries the ETag the server stat'ed, so a verdict is only ever
            // produced for (and re-checked against) that exact object version.
            let nextScanStatus = 'pending';
            let uploadStatus = 'pending_scan';
            let responseStatus = 202;
            if (malwareScanner) {
                let verdict;
                try {
                    verdict = await (0, assignment_storage_1.runBoundedScan)(malwareScanner, {
                        objectKey: row.storage_key,
                        sizeBytes: verifiedSize.value,
                        contentType: storedType,
                        extension,
                        etag: metadata.etag,
                    }, scanWindowMs);
                }
                catch (error) {
                    const detail = error instanceof assignment_storage_1.ScanTimeoutError ? error.message : error;
                    console.error(`Assignment malware scan failed for submission ${submissionId}:`, detail);
                    return res.status(502).json({ error: 'Malware scan is unavailable', code: 'scan_unavailable' });
                }
                if (verdict.verdict === 'failed') {
                    return res.status(502).json({ error: 'Malware scan is unavailable', code: 'scan_unavailable' });
                }
                if (verdict.verdict === 'infected') {
                    nextScanStatus = 'infected';
                    uploadStatus = 'quarantined';
                    responseStatus = 422;
                }
                else {
                    nextScanStatus = 'clean';
                    uploadStatus = 'finalized';
                    responseStatus = 200;
                }
            }
            // A verdict is only meaningful for the exact object version it was
            // produced from. Between stat/read/scan/finalize the caller could
            // have replaced the object at the same key, so re-stat and require
            // the same ETag and size before anything is recorded: a clean
            // verdict must never authorize a different later object. Fail
            // closed — the row stays pending and the caller may re-finalize.
            let current;
            try {
                current = await objectStore.statObject(row.storage_key);
            }
            catch (error) {
                console.error(`Assignment object re-stat failed for submission ${submissionId}:`, error);
                return res.status(502).json({ error: 'Storage is unavailable', code: 'storage_unavailable' });
            }
            if (!current) {
                return res.status(404).json({ error: 'Uploaded object was not found', code: 'object_not_found' });
            }
            if (current.etag !== metadata.etag || current.sizeBytes !== metadata.sizeBytes) {
                console.error(`Assignment object was replaced during finalize for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'The uploaded object changed during verification, please retry',
                    code: 'object_replaced',
                });
            }
            // The infected branch records its cleanup obligation in the SAME
            // transaction as the verdict write and its audit event: either the
            // row is quarantined and the obligation is durable, or neither
            // happened. The external delete stays outside the transaction (an
            // object store cannot join it), and the two stages are settled
            // separately below.
            const infectedTarget = nextScanStatus === 'infected'
                ? buildCleanupTarget(row.storage_key, verifiedVersion, {
                    tenantId: enrollment.tenantId,
                    assignmentId,
                    enrollmentId: enrollment.id,
                    submissionId,
                }, 'scan_infected')
                : null;
            const quarantineHandle = { handle: assignment_cleanup_recovery_1.UNRECORDED_CLEANUP_HANDLE };
            let recorded = false;
            try {
                recorded = await atomic(async (tx) => {
                    if (catalogRequests.has(res)) {
                        const current = await tx.queryOne(`SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE id=? AND tenant_id=? LIMIT 1 FOR UPDATE`, [assignmentId, enrollment.tenantId]);
                        const policy = (source) => JSON.stringify([submissionInput(source), assignmentAudience(source), Number(source.max_file_bytes), parseJsonArray(source.allowed_file_types)]);
                        if (!current || policy(current) !== policy(assignment) || !(0, assignments_1.evaluateSubmissionWindow)(submissionInput(current), now()).open)
                            throw new catalog_homework_access_1.CatalogHomeworkDenied();
                    }
                    // The verified object version is recorded with the verdict when
                    // the column is declared. Without it the row has no version
                    // binding, and the fenced scan store deliberately refuses to
                    // trust such a row rather than infer one.
                    const persistEtag = deps.objectVersionColumn === 'declared';
                    const result = await tx.execute(`UPDATE assignment_submissions
                         SET file_size_bytes=?, scan_status=?${persistEtag ? ', object_etag=?' : ''}
                         WHERE id=? AND assignment_id=? AND tenant_id=? AND student_enrollment_id=?
                           AND file_size_bytes=0 AND scan_status='pending' AND status<>'revoked'`, persistEtag
                        ? [
                            verifiedSize.value,
                            nextScanStatus,
                            verifiedVersion.etag,
                            submissionId,
                            assignmentId,
                            enrollment.tenantId,
                            enrollment.id,
                        ]
                        : [
                            verifiedSize.value,
                            nextScanStatus,
                            submissionId,
                            assignmentId,
                            enrollment.tenantId,
                            enrollment.id,
                        ]);
                    // The verdict CAS names one row by id: `0` is a genuine
                    // concurrent write, and an unreported count is a
                    // driver-contract error rather than a recorded verdict.
                    if (affectedRowsOf(result) !== 1)
                        return false;
                    await (0, audit_1.recordAudit)(tx.execute, {
                        actorUserId: enrollment.userId,
                        tenantId: enrollment.tenantId,
                        action: 'assignment.submission.finalize',
                        resourceType: 'assignment_submission',
                        resourceId: submissionId,
                        oldValue: (0, audit_1.snapshotRow)({ file_size_bytes: 0, scan_status: 'pending' }),
                        newValue: (0, audit_1.snapshotRow)({
                            file_size_bytes: verifiedSize.value,
                            scan_status: nextScanStatus,
                            upload_status: uploadStatus,
                            late: Boolean(row.is_late),
                        }),
                    });
                    if (infectedTarget) {
                        // Throws into the caller's unit of work on purpose: a
                        // quarantine whose cleanup was never recorded must not
                        // commit, or the bytes would be owed by nobody.
                        quarantineHandle.handle = await recordCleanup(infectedTarget, tx);
                    }
                    return true;
                });
            }
            catch (error) {
                if (catalogFailure(res, error))
                    return;
                console.error(`Assignment finalize write failed for submission ${submissionId}:`, error);
                return res.status(500).json({ error: 'Failed to finalize the submission' });
            }
            if (!recorded) {
                const current = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
                // Idempotent only when the committed winner recorded exactly
                // the outcome this attempt computed: the same verified size
                // *and* the same verdict. A winner that recorded a different
                // verdict (say `infected` while this attempt scanned `clean`)
                // is a conflict — answering 200 would report this attempt as
                // having produced a state it never produced.
                const sameOutcome = current !== null
                    && Number(current.file_size_bytes) === verifiedSize.value
                    && current.scan_status === nextScanStatus;
                if (current && sameOutcome) {
                    await guardCatalog(res);
                    return res.status(200).json(finalizeProjection(current));
                }
                // A revoke that landed between the read and the write owns the
                // row now; a revoked version must never be reported as ready.
                if (current?.status === 'revoked') {
                    return res.status(409).json({ error: 'Submission is revoked', code: 'submission_revoked' });
                }
                return res.status(409).json({
                    error: 'Submission changed concurrently, please retry',
                    code: 'finalize_conflict',
                });
            }
            const finalizedRow = {
                ...row,
                file_size_bytes: verifiedSize.value,
                scan_status: nextScanStatus,
            };
            await guardCatalog(res);
            if (uploadStatus === 'quarantined') {
                await quarantineRejectedObject(infectedTarget, quarantineHandle.handle, submissionId);
                return res.status(422).json({
                    error: 'Uploaded file failed the malware scan',
                    code: 'scan_infected',
                    ...finalizeProjection(finalizedRow),
                });
            }
            res.status(responseStatus).json(finalizeProjection(finalizedRow));
        }
        catch (error) {
            if (catalogFailure(res, error))
                return;
            console.error('Finalize assignment submission error:', error);
            res.status(500).json({ error: 'Failed to finalize the submission' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /:id/submissions/mine — student's own versions                     */
    /* --------------------------------------------------------------------- */
    router.get('/:id/submissions/mine', async (req, res) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const catalog = catalogRequests.get(res);
            let rows = await loadEnrollmentSubmissions(enrollment.tenantId, assignmentId, enrollment.id);
            if (catalog) {
                const markers = await db.query(`SELECT id,catalog_context FROM assignment_submissions WHERE assignment_id=? AND tenant_id=? AND student_enrollment_id=? ORDER BY version DESC LIMIT 1001`, [assignmentId, enrollment.tenantId, enrollment.id]);
                if (markers.length > 1000)
                    throw Error('Homework history exceeds read bound');
                const ids = new Set(markers.filter(row => row.catalog_context !== null && (0, catalog_homework_access_1.sameHomeworkContext)(row.catalog_context, catalog.context)).map(row => row.id));
                rows = rows.filter(row => ids.has(row.id));
                await guardCatalog(res);
            }
            res.json(rows.map(projectSubmission));
        }
        catch (error) {
            if (catalogFailure(res, error))
                return;
            console.error('Student submissions error:', error);
            res.status(500).json({ error: 'Failed to load submissions' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /:id/submissions — staff list                                      */
    /* --------------------------------------------------------------------- */
    router.get('/:id/submissions', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(await loadAssignmentForStaff(scope, assignmentId))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            res.json((await loadSubmissions(scope.tenantId, assignmentId)).map(projectSubmission));
        }
        catch (error) {
            console.error('List assignment submissions error:', error);
            res.status(500).json({ error: 'Failed to list submissions' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/revoke — staff revoke (audited)    */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/revoke', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            const submissionId = (0, assignments_1.normalizeId)(req.params.submissionId);
            if (!assignmentId || !submissionId)
                return res.status(404).json({ error: 'Submission not found' });
            if (!(await loadAssignmentForStaff(scope, assignmentId))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const existing = await db.queryOne(`SELECT id,status FROM assignment_submissions
                 WHERE id = ? AND assignment_id = ? AND tenant_id = ? LIMIT 1`, [submissionId, assignmentId, scope.tenantId]);
            if (!existing)
                return res.status(404).json({ error: 'Submission not found' });
            if (existing.status === 'revoked')
                return res.status(409).json({ error: 'Submission is already revoked' });
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {});
            const reason = typeof body['reason'] === 'string' ? body['reason'].trim().slice(0, 255) : null;
            // Admission before the first write: the revocation and its audit
            // event are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            const result = await atomic(async (tx) => {
                const updated = await tx.execute(`UPDATE assignment_submissions
                     SET status='revoked', revoked_at=UTC_TIMESTAMP(), revoked_by=?, revoke_reason=?
                     WHERE id=? AND assignment_id=? AND tenant_id=? AND status<>'revoked'`, [scope.userId, reason, submissionId, assignmentId, scope.tenantId]);
                if (affectedRowsOf(updated) !== 1)
                    return false;
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.submission.revoke',
                    resourceType: 'assignment_submission',
                    resourceId: submissionId,
                    oldValue: (0, audit_1.snapshotRow)({ status: existing.status }),
                    newValue: (0, audit_1.snapshotRow)({ status: 'revoked', reason }),
                });
                return true;
            });
            if (!result)
                return res.status(409).json({ error: 'Submission changed concurrently' });
            res.json({ id: submissionId, status: 'revoked' });
        }
        catch (error) {
            console.error('Revoke assignment submission error:', error);
            res.status(500).json({ error: 'Failed to revoke submission' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/grade — correction → gradebook      */
    /* --------------------------------------------------------------------- */
    /*
     * Correcting one submission writes exactly one course gradebook row for the
     * intended student, atomically with its audit event:
     *
     *  - authority is the assigned teacher (`authorizeAssignmentGrading`), never
     *    the caller's tenant role alone;
     *  - the student identity is proven server-side: the submission's
     *    `student_enrollment_id` must resolve to an enrollment in this tenant
     *    whose `user_id` is the one recorded on the submission, that matches the
     *    assignment audience, and that is enrolled in the assignment's course.
     *    No name, phone or client-supplied student id is ever matched;
     *  - only a verified, clean submission is gradeable. A revoked row, an
     *    unfinished upload and a quarantined scan are refused: a grade can never
     *    exist for bytes nobody verified;
     *  - the gradebook row id is deterministic over
     *    (tenant, enrollment, course, 'assignment', assignment id), so a
     *    repeated identical request is a no-op replay and a different award
     *    corrects the same row (with the previous value in the audit record).
     */
    router.post('/:id/submissions/:submissionId/grade', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            const submissionId = (0, assignments_1.normalizeId)(req.params.submissionId);
            if (!assignmentId || !submissionId)
                return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(scope.tenantId, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            if (!(await authorizeAssignmentGrading(scope, assignment))) {
                return res.status(403).json({ error: 'You are not the assigned teacher for this assignment' });
            }
            if (!assignment.course_id) {
                return res.status(409).json({
                    error: 'Assignment is not linked to a course gradebook',
                    code: 'assignment_not_course_scoped',
                });
            }
            const courseId = assignment.course_id;
            const submission = await db.queryOne(`SELECT ${SUBMISSION_COLUMNS}
                 FROM assignment_submissions
                 WHERE id = ? AND assignment_id = ? AND tenant_id = ? LIMIT 1`, [submissionId, assignmentId, scope.tenantId]);
            if (!submission)
                return res.status(404).json({ error: 'Submission not found' });
            if (submission.status === 'revoked') {
                return res.status(409).json({ error: 'A revoked submission cannot be graded', code: 'submission_revoked' });
            }
            if (Number(submission.file_size_bytes) <= 0 || submission.scan_status !== 'clean') {
                return res.status(409).json({
                    error: 'Only a verified, clean submission can be graded',
                    code: 'submission_not_gradeable',
                });
            }
            const enrollment = await db.queryOne(`SELECT s.id, s.tenant_id, s.user_id, s.group_id, grp.branch_id, grp.branch_scope, grp.course_id
                 FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
                 WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`, [submission.student_enrollment_id, scope.tenantId]);
            if (!enrollment)
                return res.status(404).json({ error: 'Student enrollment not found' });
            // The submission row is server-written, but the pair is re-proven
            // here so a drifted or hand-edited row can never move a grade onto
            // another student.
            if (enrollment.user_id !== submission.student_user_id) {
                return res.status(409).json({
                    error: 'Submission student identity does not match the enrollment',
                    code: 'submission_student_mismatch',
                });
            }
            const enrollmentFacts = {
                tenantId: enrollment.tenant_id,
                branchId: enrollment.branch_scope === 'branch' ? enrollment.branch_id : null,
                groupId: enrollment.group_id,
                courseId: enrollment.course_id ?? null,
            };
            if (!(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentFacts)) {
                return res.status(403).json({ error: 'Student is outside the assignment audience' });
            }
            // The audience helper checks a branch first for a branch-scoped row,
            // so the exact assignment/student pair is re-proven here: a
            // group-scoped assignment may only ever be graded for a student of
            // that same group, never for a peer group in the same branch.
            if (assignment.group_id !== null && enrollment.group_id !== assignment.group_id) {
                return res.status(403).json({ error: 'Student is not in the assignment group' });
            }
            if (!(await enrollmentInCourse(scope.tenantId, enrollment.id, courseId))) {
                return res.status(409).json({
                    error: 'Student is not enrolled in this course',
                    code: 'student_not_in_course',
                });
            }
            const validated = (0, gradebook_1.validateLinkedGradeInput)(req.body ?? {});
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const grade = validated.value;
            const scoreId = (0, gradebook_1.deterministicScoreId)({
                tenantId: scope.tenantId,
                enrollmentId: enrollment.id,
                courseId,
                itemType: 'assignment',
                itemId: assignmentId,
            });
            if (!scoreId)
                return res.status(400).json({ error: 'invalid grade identity' });
            // Admission before the gradebook row is read FOR UPDATE and written:
            // the score and its audit event are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            let outcome = 'created';
            const applied = await atomic(async (tx) => {
                const existing = await tx.queryOne('SELECT id, score, max_score, weight FROM gradebook_scores WHERE id=? AND tenant_id=? FOR UPDATE', [scoreId, scope.tenantId]);
                if (existing) {
                    const before = {
                        score: Number(existing.score),
                        max_score: Number(existing.max_score),
                        weight: existing.weight === null ? null : Number(existing.weight),
                    };
                    const sameWeight = (before.weight === null && grade.weight === null)
                        || (before.weight !== null && grade.weight !== null && before.weight === grade.weight);
                    if (before.score === grade.score && before.max_score === grade.maxScore && sameWeight) {
                        outcome = 'unchanged';
                        return true;
                    }
                    const updated = await tx.execute('UPDATE gradebook_scores SET score=?, max_score=?, weight=?, recorded_by=?, recorded_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?', [grade.score, grade.maxScore, grade.weight, scope.userId, scoreId, scope.tenantId]);
                    if (affectedRowsOf(updated) === 0) {
                        outcome = 'unchanged';
                        return true;
                    }
                    outcome = 'corrected';
                    await (0, audit_1.recordAudit)(tx.execute, {
                        actorUserId: scope.userId,
                        tenantId: scope.tenantId,
                        action: 'assignment.submission.grade.correct',
                        resourceType: 'gradebook_score',
                        resourceId: scoreId,
                        oldValue: before,
                        newValue: {
                            assignment_id: assignmentId,
                            submission_id: submissionId,
                            course_id: courseId,
                            student_enrollment_id: enrollment.id,
                            item_type: 'assignment',
                            score: grade.score,
                            max_score: grade.maxScore,
                        },
                    });
                    return true;
                }
                await tx.execute('INSERT INTO gradebook_scores (id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [scoreId, scope.tenantId, enrollment.id, courseId, null, 'assignment', assignmentId,
                    grade.score, grade.maxScore, grade.weight, scope.userId]);
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.submission.grade',
                    resourceType: 'gradebook_score',
                    resourceId: scoreId,
                    newValue: {
                        assignment_id: assignmentId,
                        submission_id: submissionId,
                        course_id: courseId,
                        student_enrollment_id: enrollment.id,
                        item_type: 'assignment',
                        score: grade.score,
                        max_score: grade.maxScore,
                    },
                });
                return true;
            });
            if (!applied)
                return res.status(409).json({ error: 'Grade changed concurrently' });
            // The outcome is set inside the transaction closure, which the
            // compiler cannot track; the declared union is the contract.
            const finalOutcome = outcome;
            res.status(finalOutcome === 'created' ? 201 : 200).json({
                id: scoreId,
                submission_id: submissionId,
                assignment_id: assignmentId,
                course_id: courseId,
                student_enrollment_id: enrollment.id,
                score: grade.score,
                max_score: grade.maxScore,
                idempotent: finalOutcome === 'unchanged',
                corrected: finalOutcome === 'corrected',
            });
        }
        catch (error) {
            console.error('Grade assignment submission error:', error);
            res.status(500).json({ error: 'Failed to grade submission' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /:id — staff or enrolled-student read                              */
    /* --------------------------------------------------------------------- */
    router.get('/:id', async (req, res) => {
        try {
            const user = req.user;
            if (!user)
                return res.status(401).json({ error: 'Authentication required' });
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            if (user.role === 'student') {
                const enrollment = await resolveEnrollment(req, res);
                if (!enrollment)
                    return;
                const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
                if (!assignment || assignment.status !== 'published'
                    || !(0, assignments_1.enrollmentMatchesAssignment)(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                    return res.status(404).json({ error: 'Assignment not found' });
                }
                return res.json(projectAssignment(assignment));
            }
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignment = await loadAssignmentForStaff(scope, assignmentId);
            if (!assignment)
                return res.status(404).json({ error: 'Assignment not found' });
            return res.json(projectAssignment(assignment));
        }
        catch (error) {
            console.error('Read assignment error:', error);
            res.status(500).json({ error: 'Failed to load assignment' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* PATCH /:id — staff update (optimistic version, audited)                */
    /* --------------------------------------------------------------------- */
    router.patch('/:id', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            const existing = await loadAssignmentForStaff(scope, assignmentId);
            if (!existing)
                return res.status(404).json({ error: 'Assignment not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'An archived assignment cannot be edited' });
            }
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {});
            const mergedTimeZone = typeof body['deadline_timezone'] === 'string' ? body['deadline_timezone'] : existing.deadline_timezone;
            let mergedDeadline = null;
            if (body['deadline'] !== undefined) {
                mergedDeadline = body['deadline'];
            }
            else if (existing.deadline_at !== null && existing.deadline_at !== undefined) {
                const persisted = (0, content_release_1.toUtcIso)(existing.deadline_at);
                mergedDeadline = persisted === null ? null : toLocalWallTime(persisted, mergedTimeZone);
            }
            const merged = {
                title: body['title'] ?? existing.title,
                instructions: body['instructions'] ?? existing.instructions,
                course_id: body['course_id'] ?? existing.course_id,
                group_id: body['group_id'] ?? existing.group_id,
                branch_scope: body['branch_scope'] ?? existing.branch_scope,
                branch_id: body['branch_id'] ?? existing.branch_id,
                deadline: mergedDeadline,
                deadline_timezone: mergedTimeZone,
                late_policy: body['late_policy'] ?? existing.late_policy,
                resubmission_policy: body['resubmission_policy'] ?? existing.resubmission_policy,
                max_submissions: body['max_submissions'] ?? existing.max_submissions,
                max_file_bytes: body['max_file_bytes'] ?? existing.max_file_bytes,
                allowed_file_types: body['allowed_file_types'] ?? parseJsonArray(existing.allowed_file_types),
            };
            const validated = (0, assignments_1.validateAssignmentInput)(merged);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const value = validated.value;
            if (value.branchId && !(await authorizeBranch(scope, value.branchId))) {
                return res.status(403).json({ error: 'Branch membership required' });
            }
            if (value.courseId && !(await courseInTenant(scope.tenantId, value.courseId))) {
                return res.status(403).json({ error: 'Course is outside this tenant' });
            }
            if (value.groupId && !(await groupInTenant(scope, value.groupId))) {
                return res.status(403).json({ error: 'Group is outside this tenant' });
            }
            // Admission before the first write: the versioned update and its
            // audit event are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            const result = await atomic(async (tx) => {
                const updated = await tx.execute(`UPDATE assignments
                     SET branch_id=?, branch_scope=?, course_id=?, group_id=?, title=?, instructions=?, deadline_at=?,
                         deadline_timezone=?, late_policy=?, resubmission_policy=?, max_submissions=?, max_file_bytes=?,
                         allowed_file_types=?, version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND version=? AND archived_at IS NULL`, [
                    value.branchId, value.branchScope, value.courseId, value.groupId, value.title, value.instructions,
                    value.deadlineUtc === null ? null : value.deadlineUtc.slice(0, 19).replace('T', ' '),
                    value.deadlineTimeZone, value.latePolicy, value.resubmissionPolicy, value.maxSubmissions,
                    value.maxFileBytes, JSON.stringify(value.allowedFileTypes), assignmentId, scope.tenantId, existing.version,
                ]);
                if (affectedRowsOf(updated) !== 1)
                    return false;
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.update',
                    resourceType: 'assignment',
                    resourceId: assignmentId,
                    oldValue: (0, audit_1.snapshotRow)({ title: existing.title }),
                    newValue: (0, audit_1.snapshotRow)({ title: value.title, deadline_at: value.deadlineUtc }),
                });
                return true;
            });
            if (!result)
                return res.status(409).json({ error: 'Assignment changed concurrently' });
            res.json({ id: assignmentId, deadline_at: value.deadlineUtc });
        }
        catch (error) {
            console.error('Update assignment error:', error);
            res.status(500).json({ error: 'Failed to update assignment' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/publish — staff publish (audited)                            */
    /* --------------------------------------------------------------------- */
    router.post('/:id/publish', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            const existing = await loadAssignmentForStaff(scope, assignmentId);
            if (!existing)
                return res.status(404).json({ error: 'Assignment not found' });
            if (existing.status === 'published')
                return res.status(409).json({ error: 'Assignment is already published' });
            // Admission before the first write: the status change and its audit
            // event are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            const result = await atomic(async (tx) => {
                const updated = await tx.execute(`UPDATE assignments SET status='published', version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND status<>'published' AND archived_at IS NULL`, [assignmentId, scope.tenantId]);
                if (affectedRowsOf(updated) !== 1)
                    return false;
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.publish',
                    resourceType: 'assignment',
                    resourceId: assignmentId,
                    oldValue: (0, audit_1.snapshotRow)({ status: existing.status }),
                    newValue: (0, audit_1.snapshotRow)({ status: 'published' }),
                });
                return true;
            });
            if (!result)
                return res.status(409).json({ error: 'Assignment changed concurrently' });
            res.json({ id: assignmentId, status: 'published' });
        }
        catch (error) {
            console.error('Publish assignment error:', error);
            res.status(500).json({ error: 'Failed to publish assignment' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /:id/archive — staff soft archive (audited)                       */
    /* --------------------------------------------------------------------- */
    router.post('/:id/archive', async (req, res) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope)
                return;
            const assignmentId = (0, assignments_1.normalizeId)(req.params.id);
            if (!assignmentId)
                return res.status(404).json({ error: 'Assignment not found' });
            const existing = await loadAssignmentForStaff(scope, assignmentId);
            if (!existing)
                return res.status(404).json({ error: 'Assignment not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'Assignment is already archived' });
            }
            // Admission before the first write: the archive stamp and its audit
            // event are one unit.
            const atomic = admitAtomic(res);
            if (!atomic)
                return;
            const result = await atomic(async (tx) => {
                const updated = await tx.execute(`UPDATE assignments SET archived_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND archived_at IS NULL`, [assignmentId, scope.tenantId]);
                if (affectedRowsOf(updated) !== 1)
                    return false;
                await (0, audit_1.recordAudit)(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.archive',
                    resourceType: 'assignment',
                    resourceId: assignmentId,
                    oldValue: (0, audit_1.snapshotRow)({ archived: false }),
                    newValue: (0, audit_1.snapshotRow)({ archived: true }),
                });
                return true;
            });
            if (!result)
                return res.status(409).json({ error: 'Assignment changed concurrently' });
            res.json({ id: assignmentId, archived: true });
        }
        catch (error) {
            console.error('Archive assignment error:', error);
            res.status(500).json({ error: 'Failed to archive assignment' });
        }
    });
    return router;
};
exports.createAssignmentsRouter = createAssignmentsRouter;
/* Production wiring: real pool, real auth, real tenant authority, real branch deps. */
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
 * Production object-metadata adapter over the existing private MinIO client.
 * The adapter is lazy: constructing it neither connects nor reads credentials;
 * the first upload call does. The bucket is `MINIO_BUCKET_ASSIGNMENTS`
 * (default `assignment-submissions`) and must be provisioned private.
 */
const productionObjectStore = (0, assignment_storage_1.createMinioAssignmentObjectStore)();
/**
 * No trusted malware scanner is integrated in this scope. A verified upload
 * therefore stays `pending_scan` (HTTP 202) and `clean` is unreachable. This is
 * deliberate fail-closed behavior; wiring a scanner is a separate decision.
 */
const productionMalwareScanner = undefined;
/**
 * Production atomic seam. A submission row and its audit event (and the
 * staff-side edit/publish/revoke/archive writes) must commit or roll back
 * together, so a failed audit can never leave an unaudited submission behind.
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
                throw new Error('assignments transaction execute did not report a usable affected-row count');
            }
            return { insertId: typeof header.insertId === 'number' && Number.isSafeInteger(header.insertId) ? header.insertId : 0, affectedRows };
        },
    }));
};
const createAssignmentsRuntime = (options) => {
    // Capture the port identities once for BOTH consumers. Caller mutation of
    // the options object must not redirect route writes away from recovery.
    const deps = Object.freeze({ ...options });
    return Object.freeze({
        router: (0, exports.createAssignmentsRouter)(deps),
        recovery: (0, assignment_recovery_factory_1.createAssignmentRecoveryRuntime)({
            // Same instances, derived once. The two name differences are the whole
            // reason this function exists.
            objectStore: deps.objectStore,
            cleanupStore: deps.cleanupObligations,
            scanner: deps.malwareScanner,
            scanStore: deps.scanStore,
            listing: deps.listing,
            submissionLookup: deps.submissionLookup,
            now: deps.now,
            newOwnerId: deps.recoveryOwnerId,
            bounds: deps.recoveryBounds,
            onError: deps.recoveryOnError,
        }),
    });
};
exports.createAssignmentsRuntime = createAssignmentsRuntime;
exports.default = (0, exports.createAssignmentsRouter)({
    catalog: (0, catalog_homework_access_1.createCatalogHomeworkAuthority)(),
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    branchAccess: productionBranchAccess,
    objectStore: productionObjectStore,
    malwareScanner: productionMalwareScanner,
    transaction: productionTransaction,
    /*
     * `cleanupObligations` is deliberately NOT wired: `assignment_submissions`
     * has no obligation table yet (the exact DDL is a Claude-owned migration —
     * `20261023_05_assignment_cleanup_scan_fencing.sql`, contract in
     * `docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md` §10). The
     * durable adapter exists (`createSqlAssignmentCleanupStore`) but declares
     * itself `unavailable` until that schema and the ETag collation verdict are
     * present, so injecting it today would change nothing. An in-process queue
     * here would make every cleanup look durable while losing it on restart, so
     * the honest production state is `cleanup-unconfigured`: rejections and
     * cancels still destroy the exact version best-effort, and a cleanup that
     * cannot be proven is reported pending rather than claimed.
     *
     * `objectVersionColumn` is likewise unwired: without it the finalize UPDATE
     * is exactly the historical statement, and no row is given an ETag it cannot
     * prove.
     */
});
