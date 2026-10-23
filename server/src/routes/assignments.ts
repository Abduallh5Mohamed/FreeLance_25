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

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import {
    BranchAccessDeps,
    BranchMembershipRow,
    BranchRow,
    resolveBranchAccess,
} from '../security/branch-access';
import { toUtcIso, tenantLocalNow } from '../services/content-release';
import {
    AssignmentAudienceFacts,
    AssignmentCleanupReason,
    EnrollmentAudienceFacts,
    EvaluateSubmissionInput,
    ExistingSubmission,
    evaluateSubmission,
    evaluateSubmissionWindow,
    enrollmentMatchesAssignment,
    buildSubmissionStorageKey,
    deriveUploadStatus,
    normalizeId,
    validateAssignmentInput,
    validateFinalizeRequest,
    validateUploadRequest,
    validateVerifiedUpload,
    UploadStatus,
} from '../services/assignments';
import {
    UNRECORDED_CLEANUP_HANDLE,
    cleanupProofForRemoval,
    normalizeCleanupTarget,
    recordCleanupObligation,
    settleRecordedCleanup,
} from '../services/assignment-cleanup-recovery';
import type {
    AssignmentCleanupHandle,
    AssignmentCleanupObligationStore,
    AssignmentCleanupTarget,
} from '../services/assignment-cleanup-recovery';
import {
    AssignmentObjectMetadata,
    AssignmentObjectStore,
    BoundObjectVersion,
    MalwareScanner,
    MAX_SIGNATURE_PREFIX_BYTES,
    QuarantineCleanup,
    ScanTimeoutError,
    boundObjectVersion,
    createMinioAssignmentObjectStore,
    expectedContentType,
    normalizeContentType,
    parseSubmissionStorageKey,
    removeScannedObjectVersion,
    runBoundedScan,
    scanTimeoutMs,
    uploadAuthorizationTtlSeconds,
    verifyObjectSignature,
    verifySubmissionStorageKey,
} from '../services/assignment-storage';
import {
    deterministicScoreId,
    validateLinkedGradeInput,
} from '../services/gradebook';

export interface AssignmentsDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface AssignmentsDeps {
    db: AssignmentsDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /** Branch membership authority; defaults to the real pool. */
    branchAccess?: BranchAccessDeps;
    now?: () => Date;
    transaction?: <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>) => Promise<T>;
    /**
     * Server-owned private object store for submission files. Every object
     * fact (key, size, content type, signature) is read through this adapter;
     * the client never supplies one. Absent means the upload lifecycle cannot
     * be authorized and the create route fails closed with 503.
     */
    objectStore?: AssignmentObjectStore;
    /**
     * Verified malware scanner adapter. Absent means a verified upload stays
     * `pending_scan` (HTTP 202) — the route never fabricates a clean verdict.
     */
    malwareScanner?: MalwareScanner;
    /** Wall-clock bound for one scan (clamped to 1–120 s; default 30 s). */
    scanTimeoutMs?: number;
    /** Short-lived upload authorization lifetime (clamped to 60–600 s). */
    uploadUrlTtlSeconds?: number;
    /**
     * Durable cleanup obligation store. When injected, every rejection and
     * cancellation records the obligation to destroy its exact object version
     * **before** the bytes are touched, and settles it afterwards — so a crash
     * between the delete and the DB write leaves a durable row instead of a log
     * line. Absent means the cleanup stays best-effort and is reported as
     * `cleanup-unconfigured`: no queued/deleted success is ever claimed.
     *
     * The durable adapter (`assignment-cleanup-sql.ts`) declares its own
     * availability: a store that reports `unavailable` is written through by
     * nobody, and the router treats it exactly like an absent one.
     */
    cleanupObligations?: AssignmentCleanupObligationStore;
    /**
     * Declares that `assignment_submissions.object_etag` exists
     * (migration `20261023_05`). When declared, finalize records the verified
     * object version on the row, which is what lets the fenced scan store bind a
     * verdict to a version. Absent keeps today's UPDATE byte-for-byte, so the
     * column is never referenced before it exists — and a row without it is
     * never trusted (see `LEGACY_UNBOUND_ETAG_POLICY`).
     */
    objectVersionColumn?: 'declared';
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

/** mysql2 duplicate-key error (the per-version UNIQUE key lost the race). */
const isDuplicateKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
};

interface AssignmentRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    branch_scope: string;
    course_id: string | null;
    group_id: string | null;
    title: string;
    instructions: string | null;
    deadline_at: string | Date | null;
    deadline_timezone: string;
    late_policy: string;
    resubmission_policy: string;
    max_submissions: number;
    max_file_bytes: number;
    allowed_file_types: string | null;
    status: string;
    archived_at: string | Date | null;
    created_by: string | null;
    version: number;
}

interface SubmissionRow {
    id: string;
    assignment_id: string;
    tenant_id: string;
    student_enrollment_id: string;
    student_user_id: string;
    version: number;
    status: string;
    file_name: string;
    file_type: string;
    file_size_bytes: number;
    scan_status: string;
    is_late: boolean | number;
    submitted_at: string | Date;
    revoked_at: string | Date | null;
}

/** Finalize needs the private reference; read projections never select it. */
interface SubmissionStorageRow extends SubmissionRow {
    storage_key: string;
}

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}

interface EnrollmentFacts {
    id: string;
    /** Authenticated principal this enrollment belongs to. */
    userId: string;
    tenantId: string;
    branchId: string | null;
    groupId: string | null;
    /** Course of the enrollment's group (server-derived audience fact). */
    courseId: string | null;
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

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Epoch milliseconds for a persisted `submitted_at`. A MySQL DATETIME is a UTC
 * wall time without a zone (the column default is `CURRENT_TIMESTAMP` in UTC),
 * so it is parsed as UTC; a driver Date is already absolute. Unparseable
 * values yield null and the caller treats the row as still in flight.
 */
function submittedAtMs(value: string | Date | null | undefined): number | null {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }
    if (typeof value !== 'string' || value === '') return null;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
        ? `${value.replace(' ', 'T')}Z`
        : value;
    const time = Date.parse(normalized);
    return Number.isFinite(time) ? time : null;
}

/**
 * Upload authorization projected to the caller. `max_bytes_enforced` is true
 * only when the storage adapter signed a content-length range into the
 * authorization; a presigned PUT cannot bind the body length, so the response
 * says `finalize_stat_only` instead of promising a limit it cannot enforce.
 */
interface UploadAuthorizationProjection {
    method: 'PUT' | 'POST';
    url: string;
    fields?: Record<string, string>;
    expires_in_seconds: number;
    expires_at: string;
    required_headers: Record<string, string>;
    max_bytes: number;
    max_bytes_enforced: boolean;
    max_bytes_enforcement: 'signed_content_length_range' | 'finalize_stat_only';
}

/** Render an absolute UTC instant back into a local wall time for re-editing. */
function toLocalWallTime(isoUtc: string, timeZone: string): string {
    const wall = tenantLocalNow(new Date(isoUtc), timeZone);
    return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)} ${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(wall.second)}`;
}

const ASSIGNMENT_COLUMNS =
    'id,tenant_id,branch_id,branch_scope,course_id,group_id,title,instructions,deadline_at,deadline_timezone,' +
    'late_policy,resubmission_policy,max_submissions,max_file_bytes,allowed_file_types,status,archived_at,created_by,version';

export const createAssignmentsRouter = (deps: AssignmentsDeps): Router => {
    const router = Router();
    const { db } = deps;
    const now = deps.now ?? ((): Date => new Date());
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>): Promise<T> => fn(db);
    const objectStore = deps.objectStore;
    const malwareScanner = deps.malwareScanner;
    const scanWindowMs = scanTimeoutMs(deps.scanTimeoutMs);
    const uploadTtlSeconds = uploadAuthorizationTtlSeconds(deps.uploadUrlTtlSeconds);

    const branchAccess: BranchAccessDeps = deps.branchAccess ?? {
        findBranchById: async (branchId) => db.queryOne<BranchRow>(
            'SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1',
            [branchId],
        ),
        findMembership: async (branchId, userId) => db.queryOne<BranchMembershipRow>(
            'SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1',
            [branchId, userId],
        ),
    };

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
            branch_id: string | null; branch_scope: string | null; course_id: string | null;
        }>(
            `SELECT s.id, s.tenant_id, s.group_id, grp.branch_id, grp.branch_scope, grp.course_id
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
        const branchId = row.branch_scope === 'branch' ? row.branch_id : null;
        return {
            id: row.id, userId: user.id, tenantId: row.tenant_id, branchId,
            groupId: row.group_id, courseId: row.course_id ?? null,
        };
    };

    /* --------------------------------------------------------------------- */
    /* Authority helpers                                                      */
    /* --------------------------------------------------------------------- */

    const authorizeBranch = async (scope: StaffScope, branchId: string): Promise<boolean> => {
        const decision = await resolveBranchAccess(branchAccess, {
            principalUserId: scope.userId,
            principalTenantId: scope.tenantId,
            branchId,
            principalIsTenantOwner: scope.isOwner,
        });
        return decision.kind === 'allowed';
    };

    const courseInTenant = async (tenantId: string, courseId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; tenant_id: string | null }>(
            'SELECT id, tenant_id FROM courses WHERE id = ? LIMIT 1',
            [courseId],
        );
        return Boolean(row && row.tenant_id === tenantId);
    };

    const groupInTenant = async (scope: StaffScope, groupId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string; instructor_id: string | null; tenant_id: string | null }>(
            `SELECT g.id, g.instructor_id, c.tenant_id
             FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
             WHERE g.id = ? LIMIT 1`,
            [groupId],
        );
        if (!row || row.tenant_id !== scope.tenantId) return false;
        return scope.isOwner || row.instructor_id === scope.userId;
    };

    /**
     * Row-level staff visibility. A tenant owner sees every assignment in the
     * tenant. A non-owner sees tenant-level assignments (restricted to groups
     * they own) plus their own branch's assignments. Deny by default.
     */
    const buildStaffVisibility = (scope: StaffScope): { sql: string; params: unknown[] } => {
        if (scope.isOwner) return { sql: '1=1', params: [] };
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

    const loadAssignmentForStaff = async (scope: StaffScope, assignmentId: string): Promise<AssignmentRow | null> => {
        const visibility = buildStaffVisibility(scope);
        return db.queryOne<AssignmentRow>(
            `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments
             WHERE id = ? AND tenant_id = ? AND ${visibility.sql} LIMIT 1`,
            [assignmentId, scope.tenantId, ...visibility.params],
        );
    };

    const loadAssignmentForEnrollment = async (tenantId: string, assignmentId: string): Promise<AssignmentRow | null> =>
        db.queryOne<AssignmentRow>(
            `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [assignmentId, tenantId],
        );

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
    const authorizeAssignmentGrading = async (scope: StaffScope, assignment: AssignmentRow): Promise<boolean> => {
        if (scope.isOwner) return true;
        if (assignment.created_by !== null && assignment.created_by === scope.userId) return true;
        const groupScoped = assignment.group_id !== null;
        if (assignment.group_id) {
            const group = await db.queryOne<{ instructor_id: string | null; tenant_id: string | null }>(
                `SELECT g.instructor_id, c.tenant_id
                 FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
                 WHERE g.id = ? LIMIT 1`,
                [assignment.group_id],
            );
            if (group && group.tenant_id === scope.tenantId && group.instructor_id === scope.userId) return true;
        }
        if (assignment.course_id) {
            const course = await db.queryOne<{ instructor_id: string | null; tenant_id: string | null }>(
                'SELECT id, instructor_id, tenant_id FROM courses WHERE id = ? LIMIT 1',
                [assignment.course_id],
            );
            if (course && course.tenant_id === scope.tenantId) {
                if (course.instructor_id === scope.userId) return true;
                if (!groupScoped) {
                    const taught = await db.queryOne<{ id: string }>(
                        `SELECT g.id FROM \`groups\` g INNER JOIN courses c ON c.id = g.course_id
                         WHERE g.course_id = ? AND g.instructor_id = ? AND c.tenant_id = ? LIMIT 1`,
                        [assignment.course_id, scope.userId, scope.tenantId],
                    );
                    if (taught) return true;
                }
            }
        }
        return false;
    };

    /** True when the enrollment belongs to a group (or active course link) of this course. */
    const enrollmentInCourse = async (tenantId: string, enrollmentId: string, courseId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            `SELECT s.id FROM students s
               LEFT JOIN \`groups\` g ON g.id = s.group_id
               LEFT JOIN student_courses sc ON sc.student_id = s.id AND sc.course_id = ? AND sc.status='active'
              WHERE s.id=? AND s.tenant_id=? AND (g.course_id = ? OR sc.course_id IS NOT NULL) LIMIT 1`,
            [courseId, enrollmentId, tenantId, courseId],
        );
        return Boolean(row);
    };

    const SUBMISSION_COLUMNS =
        'id,assignment_id,tenant_id,student_enrollment_id,student_user_id,version,status,' +
        'file_name,file_type,file_size_bytes,scan_status,is_late,submitted_at,revoked_at';

    /**
     * Staff listing: tenant + assignment scoped, bounded to the newest 200 rows.
     * Staff read the whole cohort, so this is a deliberate page cap; no student
     * version or limit decision is ever made from it.
     */
    const loadSubmissions = async (tenantId: string, assignmentId: string): Promise<SubmissionRow[]> =>
        db.query<SubmissionRow>(
            `SELECT ${SUBMISSION_COLUMNS}
             FROM assignment_submissions WHERE assignment_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`,
            [assignmentId, tenantId],
        );

    /**
     * The caller's own history, filtered in SQL by the verified enrollment id.
     * Unbounded on purpose: the next version and the resubmission/limit gates
     * must be computed from the complete history. A tenant-wide window would
     * hide a student's older versions behind other students' newer rows once
     * an assignment passes 200 submissions. The per-(assignment, enrollment,
     * version) UNIQUE key still owns the append race.
     */
    const loadEnrollmentSubmissions = async (
        tenantId: string,
        assignmentId: string,
        enrollmentId: string,
    ): Promise<SubmissionRow[]> =>
        db.query<SubmissionRow>(
            `SELECT ${SUBMISSION_COLUMNS}
             FROM assignment_submissions
             WHERE assignment_id = ? AND tenant_id = ? AND student_enrollment_id = ?
             ORDER BY version DESC`,
            [assignmentId, tenantId, enrollmentId],
        );

    /** The caller's own submission version, including its private key. */
    const loadOwnSubmission = async (
        tenantId: string,
        assignmentId: string,
        enrollmentId: string,
        submissionId: string,
    ): Promise<SubmissionStorageRow | null> =>
        db.queryOne<SubmissionStorageRow>(
            `SELECT ${SUBMISSION_COLUMNS},storage_key
             FROM assignment_submissions
             WHERE id = ? AND assignment_id = ? AND tenant_id = ? AND student_enrollment_id = ?
             LIMIT 1`,
            [submissionId, assignmentId, tenantId, enrollmentId],
        );

    /**
     * The policy view of the caller's own history. The verified size and the
     * submission instant decide whether an unverified row is still in flight
     * or abandoned (see `evaluateSubmission`).
     */
    const toExistingSubmissions = (rows: SubmissionRow[]): ExistingSubmission[] => rows.map((row) => ({
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
    const buildUploadAuthorization = async (
        storageKey: string,
        extension: string,
        maxBytes: number,
    ): Promise<UploadAuthorizationProjection | null> => {
        if (!objectStore) return null;
        const contentType = expectedContentType(extension);
        if (!contentType) return null;
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
    const buildCleanupTarget = (
        storageKey: string,
        version: BoundObjectVersion,
        facts: { tenantId: string; assignmentId: string; enrollmentId: string; submissionId: string },
        reason: AssignmentCleanupReason,
    ): AssignmentCleanupTarget | null => normalizeCleanupTarget({
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
     * Write the obligation ahead of the delete.
     *
     * With a `tx` the insert joins the caller's unit of work and a failure
     * **propagates**, so a rejection or cancellation rolls back rather than
     * committing a state change whose cleanup was never recorded. Without one it
     * runs in its own transaction and a failure is reported instead of thrown;
     * the caller must then delete nothing.
     */
    const recordCleanup = async (
        target: AssignmentCleanupTarget | null,
        tx?: AssignmentsDataAccess,
    ): Promise<AssignmentCleanupHandle> => {
        if (tx) {
            // The same transaction, on the same connection: the adapter's
            // idempotent insert **and** the read-back that classifies it both run
            // here, so the obligation cannot commit apart from the decision.
            return recordCleanupObligation(deps.cleanupObligations, target, {
                // Wrapped, not extracted: `query`/`execute` are interface
                // properties, and an implementation that reads `this` would
                // break the moment the method is passed unbound.
                query: (sql, params) => tx.query(sql, params),
                execute: (sql, params) => tx.execute(sql, params),
            });
        }
        try {
            const handle = await runAtomic(
                async (unit) => recordCleanupObligation(deps.cleanupObligations, target, {
                    query: (sql, params) => unit.query(sql, params),
                    execute: (sql, params) => unit.execute(sql, params),
                }),
            );
            return handle;
        } catch (error) {
            console.error(
                `Assignment cleanup obligation could not be recorded for submission ${target?.submissionId ?? 'unknown'}:`,
                error,
            );
            return { id: null, claimVersion: null, recording: 'record_failed' };
        }
    };

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
    const performVersionCleanup = async (
        target: AssignmentCleanupTarget,
        handle: AssignmentCleanupHandle,
    ): Promise<QuarantineCleanup> => {
        if (!objectStore) return 'unsupported';
        const cleanup = await removeScannedObjectVersion(
            objectStore,
            { objectKey: target.storageKey, etag: target.etag, sizeBytes: target.sizeBytes },
            (error) => console.error(
                `Assignment cleanup failed for submission ${target.submissionId}:`,
                error,
            ),
        );
        const proof = cleanupProofForRemoval(cleanup);
        if (proof !== null && handle.recording !== 'unconfigured') {
            const settled = await settleRecordedCleanup(deps.cleanupObligations, handle, proof, now().getTime());
            if (!settled) {
                // The row stays pending and the coordinator replays it. Nothing
                // about the response changes, and no success is claimed here.
                console.error(
                    `Assignment cleanup obligation not settled for submission ${target.submissionId};`
                    + ' it stays pending for the recovery pass',
                );
            }
        }
        if (cleanup === 'unsupported' || cleanup === 'failed') {
            console.error(
                `Assignment rejection cleanup pending for submission ${target.submissionId}:`
                + ' the storage adapter cannot delete by exact object version',
            );
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
    const removeRejectedObject = async (
        target: AssignmentCleanupTarget | null,
        submissionId: string,
    ): Promise<QuarantineCleanup | 'not_attempted'> => {
        if (!objectStore) return 'unsupported';
        if (!target) {
            console.error(
                `Assignment rejection cleanup pending for submission ${submissionId}:`
                + ' the verified object version is not bound to this submission',
            );
            return 'not_attempted';
        }
        const handle = await recordCleanup(target);
        // `record_failed`: the write did not land. `store_invalid_row`: it landed
        // but cannot be read, so we cannot say whether this version is already
        // owed. Both mean the write-ahead property is unavailable, and the only
        // honest answer is to issue no delete.
        if (handle.recording === 'record_failed' || handle.recording === 'store_invalid_row') {
            return 'not_attempted';
        }
        if (handle.recording === 'conflict') {
            // A different version of this submission already owes cleanup; that
            // obligation is still pending and this call must not claim the new
            // version was queued. The coordinator owns the older one.
            console.error(
                `Assignment rejection cleanup deferred for submission ${submissionId}:`
                + ' a different version of this submission already owes cleanup',
            );
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
    const quarantineRejectedObject = async (
        target: AssignmentCleanupTarget | null,
        handle: AssignmentCleanupHandle,
        submissionId: string,
    ): Promise<QuarantineCleanup> => {
        if (!objectStore) return 'unsupported';
        if (!target) {
            console.error(
                `Assignment quarantine cleanup pending for submission ${submissionId}:`
                + ' the scanned object version is not bound to this submission',
            );
            return 'unsupported';
        }
        const cleanup = await performVersionCleanup(target, handle);
        if (cleanup === 'unsupported') {
            console.error(
                `Assignment quarantine cleanup pending for submission ${submissionId}:`
                + ' the storage adapter cannot delete by exact object version',
            );
        }
        return cleanup;
    };

    /* --------------------------------------------------------------------- */
    /* Projections (private storage_key is never exposed)                     */
    /* --------------------------------------------------------------------- */

    const projectAssignment = (row: AssignmentRow) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        branch_scope: row.branch_scope,
        course_id: row.course_id,
        group_id: row.group_id,
        title: row.title,
        instructions: row.instructions,
        deadline_at: toUtcIso(row.deadline_at),
        deadline_timezone: row.deadline_timezone,
        late_policy: row.late_policy,
        resubmission_policy: row.resubmission_policy,
        max_submissions: Number(row.max_submissions),
        max_file_bytes: Number(row.max_file_bytes),
        allowed_file_types: parseJsonArray(row.allowed_file_types),
        status: row.status,
        archived: row.archived_at !== null && row.archived_at !== undefined,
    });

    const projectSubmission = (row: SubmissionRow) => ({
        id: row.id,
        assignment_id: row.assignment_id,
        student_enrollment_id: row.student_enrollment_id,
        version: Number(row.version),
        status: row.status,
        file_name: row.file_name,
        file_type: row.file_type,
        file_size_bytes: Number(row.file_size_bytes),
        upload_status: deriveUploadStatus(Number(row.file_size_bytes), row.scan_status),
        scan_status: row.scan_status,
        is_late: Boolean(row.is_late),
        submitted_at: toUtcIso(row.submitted_at),
        revoked_at: toUtcIso(row.revoked_at),
    });

    /** Finalize response: persisted state only, never an object key or URL. */
    const finalizeProjection = (row: SubmissionRow) => ({
        id: row.id,
        version: Number(row.version),
        upload_status: deriveUploadStatus(Number(row.file_size_bytes), row.scan_status),
        scan_status: row.scan_status,
        file_size_bytes: Number(row.file_size_bytes),
        status: row.status,
    });

    const assignmentAudience = (row: AssignmentRow): AssignmentAudienceFacts => ({
        tenantId: row.tenant_id,
        branchScope: row.branch_scope,
        branchId: row.branch_id,
        groupId: row.group_id,
        courseId: row.course_id ?? null,
    });

    const submissionInput = (row: AssignmentRow): EvaluateSubmissionInput => ({
        status: row.status,
        archived: row.archived_at !== null && row.archived_at !== undefined,
        deadlineUtc: toUtcIso(row.deadline_at),
        latePolicy: row.late_policy,
        resubmissionPolicy: row.resubmission_policy,
        maxSubmissions: Number(row.max_submissions),
    });

    const enrollmentAudience = (enrollment: EnrollmentFacts): EnrollmentAudienceFacts => ({
        tenantId: enrollment.tenantId,
        branchId: enrollment.branchId,
        groupId: enrollment.groupId,
        courseId: enrollment.courseId,
    });

    /* --------------------------------------------------------------------- */
    /* GET / — staff list                                                     */
    /* --------------------------------------------------------------------- */
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const visibility = buildStaffVisibility(scope);
            const params: unknown[] = [scope.tenantId, ...visibility.params];
            let sql = `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments WHERE tenant_id = ? AND ${visibility.sql}`;
            if (req.query.include_archived !== 'true') sql += ' AND archived_at IS NULL';
            sql += ' ORDER BY created_at DESC LIMIT 200';
            res.json((await db.query<AssignmentRow>(sql, params)).map(projectAssignment));
        } catch (error) {
            console.error('List assignments error:', error);
            res.status(500).json({ error: 'Failed to list assignments' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST / — staff create (audited)                                        */
    /* --------------------------------------------------------------------- */
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const validated = validateAssignmentInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
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
            const id = randomUUID();
            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO assignments
                       (id,tenant_id,branch_id,branch_scope,course_id,group_id,title,instructions,deadline_at,deadline_timezone,
                        late_policy,resubmission_policy,max_submissions,max_file_bytes,allowed_file_types,status,created_by)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?)`,
                    [
                        id, scope.tenantId, value.branchId, value.branchScope, value.courseId, value.groupId, value.title,
                        value.instructions, value.deadlineUtc === null ? null : value.deadlineUtc.slice(0, 19).replace('T', ' '),
                        value.deadlineTimeZone, value.latePolicy, value.resubmissionPolicy, value.maxSubmissions,
                        value.maxFileBytes, JSON.stringify(value.allowedFileTypes), scope.userId,
                    ],
                );
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.create',
                    resourceType: 'assignment',
                    resourceId: id,
                    newValue: snapshotRow({
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
        } catch (error) {
            console.error('Create assignment error:', error);
            res.status(500).json({ error: 'Failed to create assignment' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /student — enrolled student list                                   */
    /* --------------------------------------------------------------------- */
    router.get('/student', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const rows = await db.query<AssignmentRow>(
                `SELECT ${ASSIGNMENT_COLUMNS} FROM assignments
                 WHERE tenant_id = ? AND status = 'published' AND archived_at IS NULL
                 ORDER BY created_at DESC LIMIT 200`,
                [enrollment.tenantId],
            );
            const audience = enrollmentAudience(enrollment);
            res.json(rows.filter((row) => enrollmentMatchesAssignment(assignmentAudience(row), audience)).map(projectAssignment));
        } catch (error) {
            console.error('Student assignments error:', error);
            res.status(500).json({ error: 'Failed to load assignments' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions — enrolled student submit (audited).             */
    /* Creates the append-only version and a short-lived private upload      */
    /* authorization. No object fact is accepted from the client.            */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
            if (!enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const limits = {
                maxFileBytes: Number(assignment.max_file_bytes),
                allowedFileTypes: parseJsonArray(assignment.allowed_file_types),
            };
            const upload = validateUploadRequest(req.body, limits);
            if (!upload.ok) return res.status(400).json({ error: upload.error });
            if (!objectStore) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            if (!expectedContentType(upload.value.extension)) {
                return res.status(400).json({
                    error: 'file type cannot be verified for a secure upload',
                    code: 'unsupported_file_type',
                });
            }

            const existing = toExistingSubmissions(
                await loadEnrollmentSubmissions(enrollment.tenantId, assignmentId, enrollment.id),
            );
            const decision = evaluateSubmission(submissionInput(assignment), existing, now());
            if (!decision.allowed) {
                return res.status(403).json({ error: 'Submission is not allowed', code: decision.reason });
            }

            const submissionId = randomUUID();
            const storageKey = buildSubmissionStorageKey({
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
            let authorization: Awaited<ReturnType<typeof buildUploadAuthorization>>;
            try {
                authorization = await buildUploadAuthorization(storageKey, upload.value.extension, limits.maxFileBytes);
            } catch (error) {
                console.error('Assignment upload authorization error:', error);
                return res.status(502).json({ error: 'Failed to authorize the upload', code: 'storage_unavailable' });
            }
            if (!authorization) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }

            const status = decision.late ? 'late' : 'submitted';
            try {
                await runAtomic(async (tx) => {
                    await tx.execute(
                        `INSERT INTO assignment_submissions
                           (id,tenant_id,assignment_id,student_enrollment_id,student_user_id,version,status,
                            file_name,file_type,file_size_bytes,storage_key,scan_status,is_late)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
                        [
                            submissionId, enrollment.tenantId, assignmentId, enrollment.id, enrollment.userId,
                            decision.nextVersion, status, upload.value.fileName, upload.value.fileType,
                            0, storageKey, decision.late ? 1 : 0,
                        ],
                    );
                    await recordAudit(tx.execute, {
                        actorUserId: enrollment.userId,
                        tenantId: enrollment.tenantId,
                        action: 'assignment.submission.create',
                        resourceType: 'assignment_submission',
                        resourceId: submissionId,
                        newValue: snapshotRow({
                            assignment_id: assignmentId,
                            version: decision.nextVersion,
                            file_name: upload.value.fileName,
                            file_size_bytes: 0,
                            upload_status: 'pending_upload',
                            late: decision.late,
                        }),
                    });
                });
            } catch (error) {
                if (!isDuplicateKeyError(error)) throw error;
                // The per-(assignment,enrollment)-version UNIQUE key decided the
                // race; re-evaluate from committed state for a precise policy
                // answer instead of a raw 500.
                const raced = toExistingSubmissions(
                    await loadEnrollmentSubmissions(enrollment.tenantId, assignmentId, enrollment.id),
                );
                const denial = evaluateSubmission(submissionInput(assignment), raced, now());
                if (!denial.allowed) {
                    return res.status(403).json({ error: 'Submission is not allowed', code: denial.reason });
                }
                return res.status(409).json({ error: 'Submission changed concurrently, please retry' });
            }
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
        } catch (error) {
            console.error('Create assignment submission error:', error);
            res.status(500).json({ error: 'Failed to submit assignment' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/upload-authorization              */
    /* Re-issues a short-lived private URL for a still-pending own version.  */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/upload-authorization', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const assignmentId = normalizeId(req.params.id);
            const submissionId = normalizeId(req.params.submissionId);
            if (!assignmentId || !submissionId) return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
            if (!enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const row = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
            if (!row) return res.status(404).json({ error: 'Submission not found' });
            if (row.status === 'revoked') {
                return res.status(409).json({ error: 'Submission is revoked', code: 'submission_revoked' });
            }
            if (Number(row.file_size_bytes) > 0) {
                return res.status(409).json({ error: 'Submission is already finalized', code: 'already_finalized' });
            }
            const window = evaluateSubmissionWindow(submissionInput(assignment), now());
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
            const parsed = parseSubmissionStorageKey(row.storage_key);
            const expected = {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: parsed?.fileExtension ?? '',
            };
            if (!parsed || !verifySubmissionStorageKey(row.storage_key, expected)) {
                console.error(`Assignment storage binding mismatch for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'Stored object reference does not match this submission',
                    code: 'storage_binding_mismatch',
                });
            }
            let authorization: Awaited<ReturnType<typeof buildUploadAuthorization>>;
            try {
                authorization = await buildUploadAuthorization(
                    row.storage_key, parsed.fileExtension, Number(assignment.max_file_bytes),
                );
            } catch (error) {
                console.error('Assignment upload authorization error:', error);
                return res.status(502).json({ error: 'Failed to authorize the upload', code: 'storage_unavailable' });
            }
            if (!authorization) {
                return res.status(503).json({
                    error: 'Private upload storage is not configured',
                    code: 'upload_unavailable',
                });
            }
            res.json({
                id: submissionId,
                assignment_id: assignmentId,
                version: Number(row.version),
                upload_status: 'pending_upload',
                scan_status: 'pending',
                upload: authorization,
            });
        } catch (error) {
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
    router.post('/:id/submissions/:submissionId/cancel', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const assignmentId = normalizeId(req.params.id);
            const submissionId = normalizeId(req.params.submissionId);
            if (!assignmentId || !submissionId) return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
            if (!enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const row = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
            if (!row) return res.status(404).json({ error: 'Submission not found' });
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
            const parsed = parseSubmissionStorageKey(row.storage_key);
            const expected = {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: parsed?.fileExtension ?? '',
            };
            if (!parsed || !verifySubmissionStorageKey(row.storage_key, expected)) {
                console.error(`Assignment storage binding mismatch for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'Stored object reference does not match this submission',
                    code: 'storage_binding_mismatch',
                });
            }

            // The abandoned upload's version is proven **before** the revocation
            // transaction, so the cleanup obligation can be recorded in the same
            // unit of work as the revocation and its audit event. The stat is a
            // read; the delete still happens after commit and still names this
            // exact version, so an upload that lands in between survives — the
            // store refuses a mismatched version instead of deleting it.
            let cancelVersion: BoundObjectVersion | null = null;
            if (objectStore) {
                let cancelMetadata: AssignmentObjectMetadata | null = null;
                try {
                    cancelMetadata = await objectStore.statObject(row.storage_key);
                } catch (error) {
                    console.error(`Assignment cancel stat failed for submission ${submissionId}:`, error);
                }
                cancelVersion = boundObjectVersion(cancelMetadata);
                if (cancelMetadata !== null && cancelVersion === null) {
                    console.error(
                        `Assignment cancel cleanup pending for submission ${submissionId}:`
                        + ' the storage adapter cannot bind the abandoned upload to a version',
                    );
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
            let cancelHandle: AssignmentCleanupHandle = UNRECORDED_CLEANUP_HANDLE;
            try {
                cancelled = await runAtomic(async (tx) => {
                    const updated = await tx.execute(
                        `UPDATE assignment_submissions
                         SET status='revoked', revoked_at=UTC_TIMESTAMP(), revoked_by=?,
                             revoke_reason='cancelled_by_student'
                         WHERE id=? AND assignment_id=? AND tenant_id=? AND student_enrollment_id=?
                           AND status<>'revoked' AND file_size_bytes=0`,
                        [enrollment.userId, submissionId, assignmentId, enrollment.tenantId, enrollment.id],
                    );
                    if ((updated.affectedRows ?? 0) === 0) return false;
                    await recordAudit(tx.execute, {
                        actorUserId: enrollment.userId,
                        tenantId: enrollment.tenantId,
                        action: 'assignment.submission.cancel',
                        resourceType: 'assignment_submission',
                        resourceId: submissionId,
                        oldValue: snapshotRow({ status: row.status, file_size_bytes: 0 }),
                        newValue: snapshotRow({ status: 'revoked', reason: 'cancelled_by_student' }),
                    });
                    // Same unit: a cancellation whose cleanup was never recorded
                    // must not commit. Throws into the transaction on failure.
                    cancelHandle = await recordCleanup(cancelTarget, tx);
                    return true;
                });
            } catch (error) {
                console.error(`Assignment cancel write failed for submission ${submissionId}:`, error);
                return res.status(500).json({ error: 'Failed to cancel the submission' });
            }
            if (!cancelled) {
                const current = await loadOwnSubmission(
                    enrollment.tenantId, assignmentId, enrollment.id, submissionId,
                );
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
                console.error(
                    `Assignment cancel cleanup pending for submission ${submissionId}:`
                    + ' no exact object version could be proven for the abandoned upload',
                );
            } else if (cancelHandle.recording === 'conflict') {
                console.error(
                    `Assignment cancel cleanup deferred for submission ${submissionId}:`
                    + ' a different version of this submission already owes cleanup',
                );
            } else {
                await performVersionCleanup(cancelTarget, cancelHandle);
            }
            res.json({ id: submissionId, status: 'revoked', cancelled: true });
        } catch (error) {
            console.error('Cancel assignment submission error:', error);
            res.status(500).json({ error: 'Failed to cancel the submission' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/finalize                          */
    /* Server-verifies the stored object, scans it and records the result    */
    /* atomically. The request body carries no object facts.                 */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/finalize', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const assignmentId = normalizeId(req.params.id);
            const submissionId = normalizeId(req.params.submissionId);
            if (!assignmentId || !submissionId) return res.status(404).json({ error: 'Submission not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
            if (!enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const row = await loadOwnSubmission(enrollment.tenantId, assignmentId, enrollment.id, submissionId);
            if (!row) return res.status(404).json({ error: 'Submission not found' });
            if (row.status === 'revoked') {
                return res.status(409).json({ error: 'Submission is revoked', code: 'submission_revoked' });
            }

            // Idempotent retry: a verified object is never re-stat'ed or
            // re-audited, and a later assignment edit cannot revoke it.
            if (Number(row.file_size_bytes) > 0) {
                return res.status(200).json(finalizeProjection(row));
            }

            const finalizeInput = validateFinalizeRequest(req.body);
            if (!finalizeInput.ok) {
                return res.status(400).json({ error: finalizeInput.error, code: 'untrusted_finalize_fields' });
            }
            const window = evaluateSubmissionWindow(submissionInput(assignment), now());
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

            const parsed = parseSubmissionStorageKey(row.storage_key);
            const expected = {
                tenantId: enrollment.tenantId,
                assignmentId,
                enrollmentId: enrollment.id,
                submissionId,
                fileExtension: parsed?.fileExtension ?? '',
            };
            if (!parsed || !verifySubmissionStorageKey(row.storage_key, expected)) {
                console.error(`Assignment storage binding mismatch for submission ${submissionId}`);
                return res.status(409).json({
                    error: 'Stored object reference does not match this submission',
                    code: 'storage_binding_mismatch',
                });
            }
            const extension = parsed.fileExtension;
            const expectedType = expectedContentType(extension);
            if (!expectedType) {
                return res.status(422).json({
                    error: 'This file type cannot be verified',
                    code: 'unsupported_file_type',
                });
            }

            let metadata: Awaited<ReturnType<AssignmentObjectStore['statObject']>>;
            try {
                metadata = await objectStore.statObject(row.storage_key);
            } catch (error) {
                console.error(`Assignment object stat failed for submission ${submissionId}:`, error);
                return res.status(502).json({ error: 'Storage is unavailable', code: 'storage_unavailable' });
            }
            if (!metadata) {
                return res.status(404).json({ error: 'Uploaded object was not found', code: 'object_not_found' });
            }
            // Readiness must be bound to one immutable object version. An
            // adapter that reports no ETag cannot prove which bytes were
            // verified, so nothing is recorded and nothing is removed.
            const verifiedVersion = boundObjectVersion(metadata);
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
            const rejectionTarget = (reason: AssignmentCleanupReason): AssignmentCleanupTarget | null =>
                buildCleanupTarget(row.storage_key, verifiedVersion, {
                    tenantId: enrollment.tenantId,
                    assignmentId,
                    enrollmentId: enrollment.id,
                    submissionId,
                }, reason);
            if (Number.isInteger(metadata.sizeBytes) && metadata.sizeBytes > limits.maxFileBytes) {
                await removeRejectedObject(rejectionTarget('admission_oversize'), submissionId);
                return res.status(413).json({
                    error: 'Uploaded file exceeds the assignment size limit',
                    code: 'file_size_out_of_bounds',
                });
            }
            const verifiedSize = validateVerifiedUpload(metadata.sizeBytes, limits);
            if (!verifiedSize.ok) {
                await removeRejectedObject(rejectionTarget('admission_size_out_of_bounds'), submissionId);
                return res.status(400).json({ error: verifiedSize.error, code: 'file_size_out_of_bounds' });
            }

            const storedType = normalizeContentType(metadata.contentType);
            if (storedType !== expectedType) {
                await removeRejectedObject(rejectionTarget('admission_content_type_mismatch'), submissionId);
                return res.status(422).json({
                    error: 'Stored content type does not match the declared file type',
                    code: 'content_type_mismatch',
                });
            }

            let prefix: Buffer;
            try {
                prefix = await objectStore.readPrefix(row.storage_key, MAX_SIGNATURE_PREFIX_BYTES);
            } catch (error) {
                console.error(`Assignment object prefix read failed for submission ${submissionId}:`, error);
                return res.status(502).json({ error: 'Storage is unavailable', code: 'storage_unavailable' });
            }
            const signature = verifyObjectSignature(extension, prefix);
            if (!signature.ok) {
                await removeRejectedObject(rejectionTarget('admission_signature_mismatch'), submissionId);
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
            let uploadStatus: UploadStatus = 'pending_scan';
            let responseStatus = 202;
            if (malwareScanner) {
                let verdict: Awaited<ReturnType<MalwareScanner['scan']>>;
                try {
                    verdict = await runBoundedScan(
                        malwareScanner,
                        {
                            objectKey: row.storage_key,
                            sizeBytes: verifiedSize.value,
                            contentType: storedType,
                            extension,
                            etag: metadata.etag,
                        },
                        scanWindowMs,
                    );
                } catch (error) {
                    const detail = error instanceof ScanTimeoutError ? error.message : error;
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
                } else {
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
            let current: Awaited<ReturnType<AssignmentObjectStore['statObject']>>;
            try {
                current = await objectStore.statObject(row.storage_key);
            } catch (error) {
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
            const quarantineHandle: { handle: AssignmentCleanupHandle } = { handle: UNRECORDED_CLEANUP_HANDLE };

            let recorded = false;
            try {
                recorded = await runAtomic(async (tx) => {
                    // The verified object version is recorded with the verdict when
                    // the column is declared. Without it the row has no version
                    // binding, and the fenced scan store deliberately refuses to
                    // trust such a row rather than infer one.
                    const persistEtag = deps.objectVersionColumn === 'declared';
                    const result = await tx.execute(
                        `UPDATE assignment_submissions
                         SET file_size_bytes=?, scan_status=?${persistEtag ? ', object_etag=?' : ''}
                         WHERE id=? AND assignment_id=? AND tenant_id=? AND student_enrollment_id=?
                           AND file_size_bytes=0 AND scan_status='pending' AND status<>'revoked'`,
                        persistEtag
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
                            ],
                    );
                    if ((result.affectedRows ?? 0) === 0) return false;
                    await recordAudit(tx.execute, {
                        actorUserId: enrollment.userId,
                        tenantId: enrollment.tenantId,
                        action: 'assignment.submission.finalize',
                        resourceType: 'assignment_submission',
                        resourceId: submissionId,
                        oldValue: snapshotRow({ file_size_bytes: 0, scan_status: 'pending' }),
                        newValue: snapshotRow({
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
            } catch (error) {
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

            const finalizedRow: SubmissionRow = {
                ...row,
                file_size_bytes: verifiedSize.value,
                scan_status: nextScanStatus,
            };
            if (uploadStatus === 'quarantined') {
                await quarantineRejectedObject(infectedTarget, quarantineHandle.handle, submissionId);
                return res.status(422).json({
                    error: 'Uploaded file failed the malware scan',
                    code: 'scan_infected',
                    ...finalizeProjection(finalizedRow),
                });
            }
            res.status(responseStatus).json(finalizeProjection(finalizedRow));
        } catch (error) {
            console.error('Finalize assignment submission error:', error);
            res.status(500).json({ error: 'Failed to finalize the submission' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /:id/submissions/mine — student's own versions                     */
    /* --------------------------------------------------------------------- */
    router.get('/:id/submissions/mine', async (req: AuthRequest, res: Response) => {
        try {
            const enrollment = await resolveEnrollment(req, res);
            if (!enrollment) return;
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });
            const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
            if (!enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const rows = await loadEnrollmentSubmissions(enrollment.tenantId, assignmentId, enrollment.id);
            res.json(rows.map(projectSubmission));
        } catch (error) {
            console.error('Student submissions error:', error);
            res.status(500).json({ error: 'Failed to load submissions' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /:id/submissions — staff list                                      */
    /* --------------------------------------------------------------------- */
    router.get('/:id/submissions', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });
            if (!(await loadAssignmentForStaff(scope, assignmentId))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            res.json((await loadSubmissions(scope.tenantId, assignmentId)).map(projectSubmission));
        } catch (error) {
            console.error('List assignment submissions error:', error);
            res.status(500).json({ error: 'Failed to list submissions' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /:id/submissions/:submissionId/revoke — staff revoke (audited)    */
    /* --------------------------------------------------------------------- */
    router.post('/:id/submissions/:submissionId/revoke', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignmentId = normalizeId(req.params.id);
            const submissionId = normalizeId(req.params.submissionId);
            if (!assignmentId || !submissionId) return res.status(404).json({ error: 'Submission not found' });
            if (!(await loadAssignmentForStaff(scope, assignmentId))) {
                return res.status(404).json({ error: 'Assignment not found' });
            }
            const existing = await db.queryOne<SubmissionRow>(
                `SELECT id,status FROM assignment_submissions
                 WHERE id = ? AND assignment_id = ? AND tenant_id = ? LIMIT 1`,
                [submissionId, assignmentId, scope.tenantId],
            );
            if (!existing) return res.status(404).json({ error: 'Submission not found' });
            if (existing.status === 'revoked') return res.status(409).json({ error: 'Submission is already revoked' });
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            const reason = typeof body['reason'] === 'string' ? body['reason'].trim().slice(0, 255) : null;
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE assignment_submissions
                     SET status='revoked', revoked_at=UTC_TIMESTAMP(), revoked_by=?, revoke_reason=?
                     WHERE id=? AND assignment_id=? AND tenant_id=? AND status<>'revoked'`,
                    [scope.userId, reason, submissionId, assignmentId, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.submission.revoke',
                    resourceType: 'assignment_submission',
                    resourceId: submissionId,
                    oldValue: snapshotRow({ status: existing.status }),
                    newValue: snapshotRow({ status: 'revoked', reason }),
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Submission changed concurrently' });
            res.json({ id: submissionId, status: 'revoked' });
        } catch (error) {
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
    router.post('/:id/submissions/:submissionId/grade', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignmentId = normalizeId(req.params.id);
            const submissionId = normalizeId(req.params.submissionId);
            if (!assignmentId || !submissionId) return res.status(404).json({ error: 'Submission not found' });

            const assignment = await loadAssignmentForEnrollment(scope.tenantId, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
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

            const submission = await db.queryOne<SubmissionRow>(
                `SELECT ${SUBMISSION_COLUMNS}
                 FROM assignment_submissions
                 WHERE id = ? AND assignment_id = ? AND tenant_id = ? LIMIT 1`,
                [submissionId, assignmentId, scope.tenantId],
            );
            if (!submission) return res.status(404).json({ error: 'Submission not found' });
            if (submission.status === 'revoked') {
                return res.status(409).json({ error: 'A revoked submission cannot be graded', code: 'submission_revoked' });
            }
            if (Number(submission.file_size_bytes) <= 0 || submission.scan_status !== 'clean') {
                return res.status(409).json({
                    error: 'Only a verified, clean submission can be graded',
                    code: 'submission_not_gradeable',
                });
            }

            const enrollment = await db.queryOne<{
                id: string; tenant_id: string; user_id: string; group_id: string | null;
                branch_id: string | null; branch_scope: string | null; course_id: string | null;
            }>(
                `SELECT s.id, s.tenant_id, s.user_id, s.group_id, grp.branch_id, grp.branch_scope, grp.course_id
                 FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
                 WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`,
                [submission.student_enrollment_id, scope.tenantId],
            );
            if (!enrollment) return res.status(404).json({ error: 'Student enrollment not found' });
            // The submission row is server-written, but the pair is re-proven
            // here so a drifted or hand-edited row can never move a grade onto
            // another student.
            if (enrollment.user_id !== submission.student_user_id) {
                return res.status(409).json({
                    error: 'Submission student identity does not match the enrollment',
                    code: 'submission_student_mismatch',
                });
            }
            const enrollmentFacts: EnrollmentAudienceFacts = {
                tenantId: enrollment.tenant_id,
                branchId: enrollment.branch_scope === 'branch' ? enrollment.branch_id : null,
                groupId: enrollment.group_id,
                courseId: enrollment.course_id ?? null,
            };
            if (!enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentFacts)) {
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

            const validated = validateLinkedGradeInput(req.body ?? {});
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const grade = validated.value;

            const scoreId = deterministicScoreId({
                tenantId: scope.tenantId,
                enrollmentId: enrollment.id,
                courseId,
                itemType: 'assignment',
                itemId: assignmentId,
            });
            if (!scoreId) return res.status(400).json({ error: 'invalid grade identity' });

            let outcome: 'created' | 'unchanged' | 'corrected' = 'created';
            const applied = await runAtomic(async (tx) => {
                const existing = await tx.queryOne<{ id: string; score: number; max_score: number; weight: number | null }>(
                    'SELECT id, score, max_score, weight FROM gradebook_scores WHERE id=? AND tenant_id=? FOR UPDATE',
                    [scoreId, scope.tenantId],
                );
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
                    const updated = await tx.execute(
                        'UPDATE gradebook_scores SET score=?, max_score=?, weight=?, recorded_by=?, recorded_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=?',
                        [grade.score, grade.maxScore, grade.weight, scope.userId, scoreId, scope.tenantId],
                    );
                    if ((updated.affectedRows ?? 0) === 0) {
                        outcome = 'unchanged';
                        return true;
                    }
                    outcome = 'corrected';
                    await recordAudit(tx.execute, {
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
                await tx.execute(
                    'INSERT INTO gradebook_scores (id, tenant_id, student_enrollment_id, course_id, category_id, item_type, item_id, score, max_score, weight, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [scoreId, scope.tenantId, enrollment.id, courseId, null, 'assignment', assignmentId,
                        grade.score, grade.maxScore, grade.weight, scope.userId],
                );
                await recordAudit(tx.execute, {
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
            if (!applied) return res.status(409).json({ error: 'Grade changed concurrently' });

            // The outcome is set inside the transaction closure, which the
            // compiler cannot track; the declared union is the contract.
            const finalOutcome = outcome as 'created' | 'unchanged' | 'corrected';
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
        } catch (error) {
            console.error('Grade assignment submission error:', error);
            res.status(500).json({ error: 'Failed to grade submission' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /:id — staff or enrolled-student read                              */
    /* --------------------------------------------------------------------- */
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });

            if (user.role === 'student') {
                const enrollment = await resolveEnrollment(req, res);
                if (!enrollment) return;
                const assignment = await loadAssignmentForEnrollment(enrollment.tenantId, assignmentId);
                if (!assignment || assignment.status !== 'published'
                    || !enrollmentMatchesAssignment(assignmentAudience(assignment), enrollmentAudience(enrollment))) {
                    return res.status(404).json({ error: 'Assignment not found' });
                }
                return res.json(projectAssignment(assignment));
            }

            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignment = await loadAssignmentForStaff(scope, assignmentId);
            if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
            return res.json(projectAssignment(assignment));
        } catch (error) {
            console.error('Read assignment error:', error);
            res.status(500).json({ error: 'Failed to load assignment' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* PATCH /:id — staff update (optimistic version, audited)                */
    /* --------------------------------------------------------------------- */
    router.patch('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });
            const existing = await loadAssignmentForStaff(scope, assignmentId);
            if (!existing) return res.status(404).json({ error: 'Assignment not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'An archived assignment cannot be edited' });
            }
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            const mergedTimeZone = typeof body['deadline_timezone'] === 'string' ? body['deadline_timezone'] : existing.deadline_timezone;
            let mergedDeadline: unknown = null;
            if (body['deadline'] !== undefined) {
                mergedDeadline = body['deadline'];
            } else if (existing.deadline_at !== null && existing.deadline_at !== undefined) {
                const persisted = toUtcIso(existing.deadline_at);
                mergedDeadline = persisted === null ? null : toLocalWallTime(persisted, mergedTimeZone);
            }
            const merged: Record<string, unknown> = {
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
            const validated = validateAssignmentInput(merged);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
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
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE assignments
                     SET branch_id=?, branch_scope=?, course_id=?, group_id=?, title=?, instructions=?, deadline_at=?,
                         deadline_timezone=?, late_policy=?, resubmission_policy=?, max_submissions=?, max_file_bytes=?,
                         allowed_file_types=?, version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND version=? AND archived_at IS NULL`,
                    [
                        value.branchId, value.branchScope, value.courseId, value.groupId, value.title, value.instructions,
                        value.deadlineUtc === null ? null : value.deadlineUtc.slice(0, 19).replace('T', ' '),
                        value.deadlineTimeZone, value.latePolicy, value.resubmissionPolicy, value.maxSubmissions,
                        value.maxFileBytes, JSON.stringify(value.allowedFileTypes), assignmentId, scope.tenantId, existing.version,
                    ],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.update',
                    resourceType: 'assignment',
                    resourceId: assignmentId,
                    oldValue: snapshotRow({ title: existing.title }),
                    newValue: snapshotRow({ title: value.title, deadline_at: value.deadlineUtc }),
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Assignment changed concurrently' });
            res.json({ id: assignmentId, deadline_at: value.deadlineUtc });
        } catch (error) {
            console.error('Update assignment error:', error);
            res.status(500).json({ error: 'Failed to update assignment' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /:id/publish — staff publish (audited)                            */
    /* --------------------------------------------------------------------- */
    router.post('/:id/publish', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });
            const existing = await loadAssignmentForStaff(scope, assignmentId);
            if (!existing) return res.status(404).json({ error: 'Assignment not found' });
            if (existing.status === 'published') return res.status(409).json({ error: 'Assignment is already published' });
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE assignments SET status='published', version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND status<>'published' AND archived_at IS NULL`,
                    [assignmentId, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.publish',
                    resourceType: 'assignment',
                    resourceId: assignmentId,
                    oldValue: snapshotRow({ status: existing.status }),
                    newValue: snapshotRow({ status: 'published' }),
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Assignment changed concurrently' });
            res.json({ id: assignmentId, status: 'published' });
        } catch (error) {
            console.error('Publish assignment error:', error);
            res.status(500).json({ error: 'Failed to publish assignment' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /:id/archive — staff soft archive (audited)                       */
    /* --------------------------------------------------------------------- */
    router.post('/:id/archive', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const assignmentId = normalizeId(req.params.id);
            if (!assignmentId) return res.status(404).json({ error: 'Assignment not found' });
            const existing = await loadAssignmentForStaff(scope, assignmentId);
            if (!existing) return res.status(404).json({ error: 'Assignment not found' });
            if (existing.archived_at !== null && existing.archived_at !== undefined) {
                return res.status(409).json({ error: 'Assignment is already archived' });
            }
            const result = await runAtomic(async (tx) => {
                const updated = await tx.execute(
                    `UPDATE assignments SET archived_at=UTC_TIMESTAMP(), version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND archived_at IS NULL`,
                    [assignmentId, scope.tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) return false;
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'assignment.archive',
                    resourceType: 'assignment',
                    resourceId: assignmentId,
                    oldValue: snapshotRow({ archived: false }),
                    newValue: snapshotRow({ archived: true }),
                });
                return true;
            });
            if (!result) return res.status(409).json({ error: 'Assignment changed concurrently' });
            res.json({ id: assignmentId, archived: true });
        } catch (error) {
            console.error('Archive assignment error:', error);
            res.status(500).json({ error: 'Failed to archive assignment' });
        }
    });

    return router;
};

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

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: AssignmentsDataAccess = {
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

const productionBranchAccess: BranchAccessDeps = {
    findBranchById: async (branchId) => {
        const { queryOne } = await loadDb();
        return queryOne<BranchRow>(
            'SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1',
            [branchId],
        );
    },
    findMembership: async (branchId, userId) => {
        const { queryOne } = await loadDb();
        return queryOne<BranchMembershipRow>(
            'SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1',
            [branchId, userId],
        );
    },
};

/**
 * Production object-metadata adapter over the existing private MinIO client.
 * The adapter is lazy: constructing it neither connects nor reads credentials;
 * the first upload call does. The bucket is `MINIO_BUCKET_ASSIGNMENTS`
 * (default `assignment-submissions`) and must be provisioned private.
 */
const productionObjectStore = createMinioAssignmentObjectStore();

/**
 * No trusted malware scanner is integrated in this scope. A verified upload
 * therefore stays `pending_scan` (HTTP 202) and `clean` is unreachable. This is
 * deliberate fail-closed behavior; wiring a scanner is a separate decision.
 */
const productionMalwareScanner: MalwareScanner | undefined = undefined;

/**
 * Production atomic seam. A submission row and its audit event (and the
 * staff-side edit/publish/revoke/archive writes) must commit or roll back
 * together, so a failed audit can never leave an unaudited submission behind.
 */
const productionTransaction = async <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>): Promise<T> => {    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> => {
            const [rows] = await connection.query(sql, params as never);
            return rows as unknown as R[];
        },
        queryOne: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | null> => {
            const [rows] = await connection.query(sql, params as never);
            return (rows as unknown as R[])[0] ?? null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            const [result] = await connection.execute(sql, params as never);
            const header = result as { insertId?: number; affectedRows?: number };
            return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
        },
    }));
};

export default createAssignmentsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
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
