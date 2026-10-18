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
 * Upload metadata is private: only an opaque `storage_key` is stored and it is
 * NEVER projected back to any caller (no public URL). `scan_status` starts
 * `pending` and is server-owned. Submissions are append-only versions; a
 * teacher revocation invalidates a version and re-opens the slot.
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
    EnrollmentAudienceFacts,
    EvaluateSubmissionInput,
    evaluateSubmission,
    enrollmentMatchesAssignment,
    normalizeId,
    validateAssignmentInput,
    validateUploadMetadata,
} from '../services/assignments';

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
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

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

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}

interface EnrollmentFacts {
    id: string;
    tenantId: string;
    branchId: string | null;
    groupId: string | null;
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

/** Render an absolute UTC instant back into a local wall time for re-editing. */
function toLocalWallTime(isoUtc: string, timeZone: string): string {
    const wall = tenantLocalNow(new Date(isoUtc), timeZone);
    return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)} ${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(wall.second)}`;
}

const ASSIGNMENT_COLUMNS =
    'id,tenant_id,branch_id,branch_scope,course_id,group_id,title,instructions,deadline_at,deadline_timezone,' +
    'late_policy,resubmission_policy,max_submissions,max_file_bytes,allowed_file_types,status,archived_at,version';

export const createAssignmentsRouter = (deps: AssignmentsDeps): Router => {
    const router = Router();
    const { db } = deps;
    const now = deps.now ?? ((): Date => new Date());
    const runAtomic = deps.transaction
        ? deps.transaction
        : <T>(fn: (tx: AssignmentsDataAccess) => Promise<T>): Promise<T> => fn(db);

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
        const branchId = row.branch_scope === 'branch' ? row.branch_id : null;
        return { id: row.id, tenantId: row.tenant_id, branchId, groupId: row.group_id };
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

    const loadSubmissions = async (tenantId: string, assignmentId: string): Promise<SubmissionRow[]> =>
        db.query<SubmissionRow>(
            `SELECT id,assignment_id,tenant_id,student_enrollment_id,student_user_id,version,status,
                    file_name,file_type,file_size_bytes,scan_status,is_late,submitted_at,revoked_at
             FROM assignment_submissions WHERE assignment_id = ? AND tenant_id = ? ORDER BY version DESC LIMIT 200`,
            [assignmentId, tenantId],
        );

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
        scan_status: row.scan_status,
        is_late: Boolean(row.is_late),
        submitted_at: toUtcIso(row.submitted_at),
        revoked_at: toUtcIso(row.revoked_at),
    });

    const assignmentAudience = (row: AssignmentRow): AssignmentAudienceFacts => ({
        tenantId: row.tenant_id,
        branchScope: row.branch_scope,
        branchId: row.branch_id,
        groupId: row.group_id,
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
    /* POST /:id/submissions — enrolled student submit (audited)              */
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
            const upload = validateUploadMetadata(req.body, {
                maxFileBytes: Number(assignment.max_file_bytes),
                allowedFileTypes: parseJsonArray(assignment.allowed_file_types),
            });
            if (!upload.ok) return res.status(400).json({ error: upload.error });

            const existing = (await loadSubmissions(enrollment.tenantId, assignmentId))
                .filter((row) => row.student_enrollment_id === enrollment.id)
                .map((row) => ({ version: Number(row.version), status: row.status }));
            const decision = evaluateSubmission(submissionInput(assignment), existing, now());
            if (!decision.allowed) {
                return res.status(403).json({ error: 'Submission is not allowed', code: decision.reason });
            }

            const submissionId = randomUUID();
            const status = decision.late ? 'late' : 'submitted';
            await runAtomic(async (tx) => {
                await tx.execute(
                    `INSERT INTO assignment_submissions
                       (id,tenant_id,assignment_id,student_enrollment_id,student_user_id,version,status,
                        file_name,file_type,file_size_bytes,storage_key,scan_status,is_late)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
                    [
                        submissionId, enrollment.tenantId, assignmentId, enrollment.id, enrollment.id, decision.nextVersion,
                        status, upload.value.fileName, upload.value.fileType, upload.value.fileSizeBytes,
                        upload.value.storageKey, decision.late ? 1 : 0,
                    ],
                );
                await recordAudit(tx.execute, {
                    actorUserId: enrollment.id,
                    tenantId: enrollment.tenantId,
                    action: 'assignment.submission.create',
                    resourceType: 'assignment_submission',
                    resourceId: submissionId,
                    newValue: snapshotRow({
                        assignment_id: assignmentId,
                        version: decision.nextVersion,
                        file_name: upload.value.fileName,
                        file_size_bytes: upload.value.fileSizeBytes,
                        late: decision.late,
                    }),
                });
            });
            res.status(201).json({
                id: submissionId,
                assignment_id: assignmentId,
                version: decision.nextVersion,
                status,
                is_late: decision.late,
                scan_status: 'pending',
            });
        } catch (error) {
            console.error('Create assignment submission error:', error);
            res.status(500).json({ error: 'Failed to submit assignment' });
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
            const rows = (await loadSubmissions(enrollment.tenantId, assignmentId))
                .filter((row) => row.student_enrollment_id === enrollment.id);
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

export default createAssignmentsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    branchAccess: productionBranchAccess,
});
