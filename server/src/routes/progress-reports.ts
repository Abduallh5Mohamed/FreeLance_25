/**
 * M4 A7/P2 (C4a) — progress report publication routes.
 *
 * Audience + permission model (deny by default):
 *  - Staff (a verified tenant owner or an active instructor membership in the
 *    server-selected tenant) may publish/unpublish a report, list reports and
 *    export that list as CSV. `deps.authority` is the injected, server-derived
 *    contract: it returns the readable course/branch scope AND the exact
 *    (course, enrollment) relation for every row. A query selector only
 *    narrows this scope; removing or forging selectors can never widen it.
 *  - A student may read ONLY her own report (`GET /mine`); the enrollment is
 *    taken from the authenticated principal, never from the request body.
 *  - Every publish/unpublish requires an `exact` enrollment relation (unknown
 *    or missing = deny) and runs the state transition and its audit event in
 *    one REQUIRED injected transaction; an audit failure rolls the state change
 *    back. There is no autocommit fallback.
 *  - The teacher list and CSV export receive the server-derived scope from the
 *    row source, then re-check every row before projection/export, and are
 *    capped with an explicit `X-Results-Truncated: true|false` header.
 *  - The CSV cells are formula-neutralized through the existing
 *    `toCsv`/`neutralizeCsvCell` helpers (imported), and the export is audited
 *    before any data is written to the response.
 *
 * The parent-facing read is NOT part of this task: the parent HTTP route is not
 * added here and no raw-grade fallback is offered. The published-only parent
 * projection is prepared as the service function
 * `parentProjection(record, state, identity)` in
 * `services/progress-publication.ts`, which returns `null` while a report is
 * unpublished and binds a publication row to the explicit report identity.
 *
 * Store contract: `deps.store` (published state) and `deps.reportSource` (the
 * underlying lesson-progress / exam / assignment read model) are injected
 * boundaries. Supplying them in a test is NOT evidence that any SQL has been
 * run, that the I2 schema exists, or that it works. The route never queries a
 * gradebook table and writes no production wiring of its own. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
    BranchAccessDeps,
    BranchMembershipRow,
    BranchRow,
    resolveBranchAccess,
} from '../security/branch-access';
import { normalizeId } from '../services/gradebook';
import {
    buildProgressReport,
    ProgressRecord,
    toCsv,
} from '../services/progress-reports';
import {
    AuditWriter,
    PublicationRecord,
    PublicationStore,
    PublicationTransaction,
    createProgressPublicationService,
} from '../services/progress-publication';

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

/** Hard cap for the teacher list feed; the header reports truncation explicitly. */
export const PROGRESS_REPORTS_LIST_CAP = 500;
/** Hard cap for the CSV export feed; the header reports truncation explicitly. */
export const PROGRESS_REPORTS_EXPORT_CAP = 500;

export const PROGRESS_REPORT_CSV_HEADERS = [
    'student_enrollment_id',
    'course_id',
    'course_name',
    'completed_lessons',
    'total_lessons',
    'exam_average',
    'assignment_average',
    'overall',
    'status',
    'publication_state',
] as const;

/** The verified principal + server-selected tenant context handed to the authority. */
export interface CourseAuthorityScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}
export type CourseAuthorityResult = 'ok' | 'not_found' | 'forbidden';
/** Exact relation of one (course, enrollment) row to the principal. */
export type EnrollmentRelation = 'exact' | 'none' | 'unknown';

/**
 * Server-derived read scope. `courseIds` and `branchId` come from the principal
 * and its membership rows through the injected authority, never from the query
 * string alone. An absent query selector therefore cannot widen this scope.
 */
export interface ReadableReportScope {
    courseIds: readonly string[];
    /** Effective branch context (null means tenant-wide, e.g. a tenant owner). */
    branchId: string | null;
}

/**
 * The injected, server-verified authority contract. It is deliberately richer
 * than a course check: every row must carry an exact (course, enrollment)
 * relation, and every list must be constrained to a server-derived scope.
 */
export interface ProgressReportAuthority {
    canAccessCourse(scope: CourseAuthorityScope, courseId: string): Promise<CourseAuthorityResult>;
    /**
     * Returns `exact` only when the principal may act on this enrollment for
     * this course. `none` is a proven non-relation; `unknown` means ambiguity
     * and is treated as a denial by callers.
     */
    mayActOnEnrollment(
        scope: CourseAuthorityScope,
        courseId: string,
        studentEnrollmentId: string,
    ): Promise<EnrollmentRelation>;
    /** Courses/branch the principal may read, derived server-side. */
    readableScope(scope: CourseAuthorityScope): Promise<ReadableReportScope>;
}

/** The row-source query; the source receives the already-authorized scope. */
export interface ProgressReportQueryScope {
    tenantId: string;
    courseIds: readonly string[];
    branchId: string | null;
}

/** Why the read model cannot produce a complete result (never an empty report). */
export type ProgressReportSourceUnavailableCode = 'unavailable' | 'incomplete';

/**
 * Typed source failure. `unavailable` means the backing source cannot be read
 * (for example a missing table); `incomplete` means the source answered but
 * its answer was capped or otherwise invalid, so computing a report from it
 * would silently present a truncated result as complete. Both must become HTTP
 * 503, never 200 with an empty/partial report and never a success audit.
 */
export class ProgressReportSourceUnavailableError extends Error {
    constructor(
        public readonly code: ProgressReportSourceUnavailableCode,
        public readonly detail: string,
    ) {
        super(`progress report source is unavailable: ${detail}`);
        this.name = 'ProgressReportSourceUnavailableError';
    }
}

export type ProgressReportSourceResult<T> =
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly code: ProgressReportSourceUnavailableCode;
        readonly detail: string;
    };

/**
 * The injected read model for the underlying report facts (never gradebook).
 *
 * The typed result methods are the preferred contract: they let the source
 * report `unavailable`/`incomplete` without throwing. They are optional only so
 * older injected sources keep compiling; when absent the route falls back to
 * `listRecords` and still recognises the typed
 * `ProgressReportSourceUnavailableError`. Untyped errors are never converted to
 * an empty report.
 */
export interface ProgressReportSource {
    listRecords(scope: ProgressReportQueryScope): Promise<ProgressRecord[]>;
    findRecord(tenantId: string, studentEnrollmentId: string, courseId: string): Promise<ProgressRecord | null>;
    listRecordsResult?(scope: ProgressReportQueryScope): Promise<ProgressReportSourceResult<ProgressRecord[]>>;
    findRecordResult?(
        tenantId: string,
        studentEnrollmentId: string,
        courseId: string,
    ): Promise<ProgressReportSourceResult<ProgressRecord | null>>;
}

export interface ProgressReportsDeps {
    authenticate: RequestHandler;
    /** Server-owned active authority of the principal inside the selected tenant. */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /** Server-verified authority contract (copy-injected). */
    authority: ProgressReportAuthority;
    /** Injected read model for lesson progress + exam/assignment aggregates. */
    reportSource: ProgressReportSource;
    /** Injected published-state store (I2 owns the SQL schema). */
    store: PublicationStore;
    /** Audit writer; production binds `recordAudit` to the transaction executor. */
    audit: AuditWriter;
    now?: () => Date;
    /** Required same-transaction seam; there is no autocommit fallback. */
    transaction: PublicationTransaction;
}

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
    branchId: string | null;
}

interface StudentScope {
    tenantId: string;
    enrollmentId: string;
    userId: string;
}

interface CourseAuthorityDb {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
}

interface CourseRow {
    id: string;
    tenant_id: string | null;
    instructor_id: string | null;
}

interface EnrollmentRow {
    id: string;
    tenant_id: string | null;
    instructor_id: string | null;
    group_id: string | null;
    group_course_id: string | null;
    group_instructor_id: string | null;
    active_course: number;
}

/**
 * Production implementation of the injected `deps.authority`. Reads only
 * existing tables (courses/groups/branches/branch_memberships/student_courses);
 * it performs no write and is not wired by this task. The exact-relation query
 * is a conservative proof: an enrollment is related only through its group or
 * an active `student_courses` row, and ambiguity stays a denial.
 *
 * Branch membership is a CONSTRAINT, never an assignment. A verified branch may
 * narrow what an already-authorized principal reads (the route filters rows by
 * the derived branch), but it never grants another teacher's group, course or
 * student. Access comes only from tenant ownership, `courses.instructor_id`,
 * `groups.instructor_id` for the student's own group, or the student's direct
 * `students.instructor_id`, with the enrollment linked to the course through
 * `group.course_id` or an active `student_courses` row.
 *
 * This is supplied so the integration owner can bind the contract; it is NOT
 * evidence that the SQL or the schema works (no migration was run here).
 */
export const createSqlCourseAuthority = (db: CourseAuthorityDb): ProgressReportAuthority => {
    const branchAccess: BranchAccessDeps = {
        findBranchById: async (branchId) => db.queryOne<BranchRow>(
            'SELECT id, tenant_id, status, version FROM branches WHERE id = ? LIMIT 1',
            [branchId],
        ),
        findMembership: async (branchId, userId) => db.queryOne<BranchMembershipRow>(
            'SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ? LIMIT 1',
            [branchId, userId],
        ),
    };
    const instructorTeachesCourse = async (tenantId: string, userId: string, courseId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            'SELECT g.id FROM `groups` g INNER JOIN courses c ON c.id = g.course_id WHERE g.course_id=? AND g.instructor_id=? AND c.tenant_id=? LIMIT 1',
            [courseId, userId, tenantId],
        );
        return Boolean(row);
    };
    const verifiedBranch = async (scope: CourseAuthorityScope): Promise<string | null> => {
        if (!scope.branchId) return null;
        const decision = await resolveBranchAccess(branchAccess, {
            principalUserId: scope.userId,
            principalTenantId: scope.tenantId,
            branchId: scope.branchId,
            principalIsTenantOwner: scope.isOwner,
        });
        return decision.kind === 'allowed' ? decision.branchId : null;
    };
    const canAccessCourse = async (scope: CourseAuthorityScope, courseId: string): Promise<CourseAuthorityResult> => {
        const course = await db.queryOne<CourseRow>('SELECT id, tenant_id, instructor_id FROM courses WHERE id=? LIMIT 1', [courseId]);
        if (!course || course.tenant_id !== scope.tenantId) return 'not_found';
        if (scope.isOwner) return 'ok';
        if (course.instructor_id === scope.userId) return 'ok';
        if (await instructorTeachesCourse(scope.tenantId, scope.userId, courseId)) return 'ok';
        return 'forbidden';
    };
    const mayActOnEnrollment = async (
        scope: CourseAuthorityScope,
        courseId: string,
        studentEnrollmentId: string,
    ): Promise<EnrollmentRelation> => {
        const course = await db.queryOne<CourseRow>('SELECT id, tenant_id, instructor_id FROM courses WHERE id=? LIMIT 1', [courseId]);
        if (!course || course.tenant_id !== scope.tenantId) return 'none';
        const enrollment = await db.queryOne<EnrollmentRow>(
            `SELECT s.id, s.tenant_id, s.instructor_id, s.group_id,
                    g.course_id AS group_course_id, g.instructor_id AS group_instructor_id,
                    CASE WHEN sc.id IS NULL THEN 0 ELSE 1 END AS active_course
               FROM students s
               LEFT JOIN \`groups\` g ON g.id = s.group_id
               LEFT JOIN student_courses sc ON sc.student_id = s.id AND sc.course_id = ? AND sc.status = 'active'
              WHERE s.id=? AND s.tenant_id=? LIMIT 1`,
            [courseId, studentEnrollmentId, scope.tenantId],
        );
        if (!enrollment) return 'none';
        const linkedToCourse = enrollment.group_course_id === courseId || Number(enrollment.active_course) === 1;
        if (!linkedToCourse) return 'none';
        if (scope.isOwner) return 'exact';
        if (course.instructor_id === scope.userId) return 'exact';
        if (enrollment.instructor_id === scope.userId) return 'exact';
        if (enrollment.group_instructor_id === scope.userId) return 'exact';
        return 'none';
    };
    const readableScope = async (scope: CourseAuthorityScope): Promise<ReadableReportScope> => {
        if (scope.isOwner) {
            const rows = await db.query<{ id: string }>('SELECT id FROM courses WHERE tenant_id=?', [scope.tenantId]);
            return { courseIds: rows.map((row) => row.id), branchId: null };
        }
        const branchId = await verifiedBranch(scope);
        const rows = await db.query<{ id: string }>(
            `SELECT DISTINCT c.id FROM courses c
               LEFT JOIN \`groups\` g ON g.course_id = c.id
              WHERE c.tenant_id=? AND (c.instructor_id=? OR g.instructor_id=?)`,
            [scope.tenantId, scope.userId, scope.userId],
        );
        return { courseIds: rows.map((row) => row.id), branchId };
    };
    return { canAccessCourse, mayActOnEnrollment, readableScope };
};

export const createProgressReportsRouter = (deps: ProgressReportsDeps): Router => {
    const router = Router();
    const now = deps.now ?? (() => new Date());
    const service = createProgressPublicationService({
        store: deps.store,
        audit: deps.audit,
        now,
        transaction: deps.transaction,
    });
    const uniqueCourseIds = (courseIds: readonly string[]): string[] =>
        [...new Set(courseIds.filter((id) => typeof id === 'string' && id.length > 0))];

    router.use(deps.authenticate);

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
        return {
            tenantId,
            userId: user.id,
            isOwner: authority.authority === 'owner',
            branchId: user.branchId ?? null,
        };
    };

    const resolveStudentScope = async (req: AuthRequest, res: Response): Promise<StudentScope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (user.role !== 'student') {
            res.status(403).json({ error: 'Student access required' });
            return null;
        }
        if (!user.tenantId || !user.studentEnrollmentId) {
            res.status(404).json({ error: 'Student workspace not found' });
            return null;
        }
        return { tenantId: user.tenantId, enrollmentId: user.studentEnrollmentId, userId: user.id };
    };

    const denyCourse = (res: Response, result: CourseAuthorityResult): void => {
        if (result === 'not_found') res.status(404).json({ error: 'Course not found' });
        else res.status(403).json({ error: 'You are not authorized for this course' });
    };

    /** Merge the read-model records with their published state (draft default). */
    const mergeRows = (
        records: readonly ProgressRecord[],
        publications: readonly PublicationRecord[],
    ): Array<Record<string, unknown>> => {
        const byKey = new Map(publications.map((p) => [`${p.studentEnrollmentId}:${p.courseId}`, p]));
        return records.map((record) => {
            const publication = byKey.get(`${record.studentEnrollmentId}:${record.courseId}`) ?? null;
            return {
                ...buildProgressReport(record),
                publication: {
                    state: publication?.state ?? 'draft',
                    published_by: publication?.publishedBy ?? null,
                    published_at: publication?.publishedAt ? publication.publishedAt.toISOString() : null,
                    version: publication?.version ?? 0,
                },
            };
        });
    };

    const parseReportFilters = (
        req: AuthRequest,
        res: Response,
    ): { courseId: string | null; branchId: string | null } | null => {
        const courseId = req.query.course_id === undefined ? null : normalizeId(req.query.course_id);
        if (req.query.course_id !== undefined && courseId === null) {
            res.status(400).json({ error: 'Invalid course_id filter' });
            return null;
        }
        let branchId: string | null = null;
        if (req.query.branch_id !== undefined) {
            branchId = normalizeId(req.query.branch_id);
            if (branchId === null) {
                res.status(400).json({ error: 'Invalid branch_id filter' });
                return null;
            }
        }
        return { courseId, branchId };
    };

    /**
     * Resolve the server-derived readable scope. A query selector is a request
     * that narrows the scope only; it can never add a course or branch that the
     * principal/membership does not already own.
     */
    const authorizeReadScope = async (
        scope: StaffScope,
        filters: { courseId: string | null; branchId: string | null },
        res: Response,
    ): Promise<ProgressReportQueryScope | null> => {
        const readable = await deps.authority.readableScope(scope);
        const allowedCourses = uniqueCourseIds(readable.courseIds);
        let courseIds: readonly string[];
        if (filters.courseId) {
            const auth = await deps.authority.canAccessCourse(scope, filters.courseId);
            if (auth !== 'ok') {
                denyCourse(res, auth);
                return null;
            }
            if (!allowedCourses.includes(filters.courseId)) {
                res.status(403).json({ error: 'You are not authorized for this course' });
                return null;
            }
            courseIds = [filters.courseId];
        } else {
            courseIds = allowedCourses;
        }
        let branchId = readable.branchId;
        if (filters.branchId) {
            if (readable.branchId !== null && readable.branchId !== filters.branchId) {
                res.status(403).json({ error: 'You are not authorized for this branch' });
                return null;
            }
            branchId = filters.branchId;
        }
        return { tenantId: scope.tenantId, courseIds, branchId };
    };

    /**
     * The authoritative row pipeline. The source receives the server-derived
     * scope, and every returned row is then checked for the exact
     * (course, enrollment) relation BEFORE any projection, export or
     * publication state is merged. Unknown/ambiguous relations are dropped.
     */
    const readSourceRecords = async (
        queryScope: ProgressReportQueryScope,
    ): Promise<ProgressReportSourceResult<ProgressRecord[]>> => {
        try {
            if (typeof deps.reportSource.listRecordsResult === 'function') {
                return await deps.reportSource.listRecordsResult(queryScope);
            }
            return { ok: true, value: await deps.reportSource.listRecords(queryScope) };
        } catch (error) {
            if (error instanceof ProgressReportSourceUnavailableError) {
                return { ok: false, code: error.code, detail: error.detail };
            }
            throw error;
        }
    };

    const readAuthorizedRecords = async (
        scope: StaffScope,
        queryScope: ProgressReportQueryScope,
    ): Promise<ProgressReportSourceResult<ProgressRecord[]>> => {
        if (queryScope.courseIds.length === 0) return { ok: true, value: [] };
        const sourceResult = await readSourceRecords(queryScope);
        if (!sourceResult.ok) return sourceResult;
        const authorized: ProgressRecord[] = [];
        for (const row of sourceResult.value) {
            if (!queryScope.courseIds.includes(row.courseId)) continue;
            if (queryScope.branchId !== null && row.branchId !== queryScope.branchId) continue;
            const relation = await deps.authority.mayActOnEnrollment(scope, row.courseId, row.studentEnrollmentId);
            if (relation !== 'exact') continue;
            authorized.push(row);
        }
        return { ok: true, value: authorized };
    };

    /** One generic body for both typed source failures; never leaks SQL detail. */
    const sourceUnavailable = (res: Response): void => {
        res.status(503).json({ error: 'Progress reports are temporarily unavailable' });
    };

    const outcomeResponse = (
        res: Response,
        outcome: Awaited<ReturnType<typeof service.publish>>,
    ): void => {
        if (outcome.kind === 'conflict') {
            res.status(409).json({ error: 'The report changed concurrently' });
            return;
        }
        res.json({
            student_enrollment_id: outcome.record.studentEnrollmentId,
            course_id: outcome.record.courseId,
            state: outcome.record.state,
            published_by: outcome.record.publishedBy,
            published_at: outcome.record.publishedAt ? outcome.record.publishedAt.toISOString() : null,
            version: outcome.record.version,
        });
    };

    // -------------------------------------------------------------------------
    // Teacher: publish / unpublish (audited, same-transaction, version-guarded,
    // idempotent).
    // -------------------------------------------------------------------------
    const mutationHandler = (next: 'published' | 'draft') => async (req: AuthRequest, res: Response): Promise<void> => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
            const enrollmentId = normalizeId(body['student_enrollment_id'] ?? body['enrollment_id']);
            const courseId = normalizeId(body['course_id'] ?? body['courseId']);
            if (!enrollmentId || !courseId) {
                res.status(400).json({ error: 'student_enrollment_id and course_id are required' });
                return;
            }
            const auth = await deps.authority.canAccessCourse(scope, courseId);
            if (auth !== 'ok') {
                denyCourse(res, auth);
                return;
            }
            const relation = await deps.authority.mayActOnEnrollment(scope, courseId, enrollmentId);
            if (relation === 'none') {
                res.status(404).json({ error: 'Report not found' });
                return;
            }
            if (relation !== 'exact') {
                res.status(403).json({ error: 'You are not authorized for this enrollment' });
                return;
            }
            const report = await deps.reportSource.findRecord(scope.tenantId, enrollmentId, courseId);
            if (!report) {
                res.status(404).json({ error: 'Report not found' });
                return;
            }
            const outcome = next === 'published'
                ? await service.publish({ tenantId: scope.tenantId, studentEnrollmentId: enrollmentId, courseId, actorUserId: scope.userId })
                : await service.unpublish({ tenantId: scope.tenantId, studentEnrollmentId: enrollmentId, courseId, actorUserId: scope.userId });
            outcomeResponse(res, outcome);
        } catch (error) {
            console.error('Progress report publication error:', error);
            res.status(500).json({ error: 'Failed to update the report publication' });
        }
    };

    router.post('/publish', mutationHandler('published'));
    router.post('/unpublish', mutationHandler('draft'));

    // -------------------------------------------------------------------------
    // Teacher: filtered list by tenant / course / branch.
    // -------------------------------------------------------------------------
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const filters = parseReportFilters(req, res);
            if (!filters) return;
            const queryScope = await authorizeReadScope(scope, filters, res);
            if (!queryScope) return;
            const visible = await readAuthorizedRecords(scope, queryScope);
            if (!visible.ok) {
                sourceUnavailable(res);
                return;
            }
            const publications = await deps.store.listPublications(scope.tenantId, filters.courseId ?? undefined);
            const rows = mergeRows(visible.value, publications);
            const truncated = rows.length > PROGRESS_REPORTS_LIST_CAP;
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.json({ reports: truncated ? rows.slice(0, PROGRESS_REPORTS_LIST_CAP) : rows });
        } catch (error) {
            console.error('Progress report list error:', error);
            res.status(500).json({ error: 'Failed to list progress reports' });
        }
    });

    // -------------------------------------------------------------------------
    // Teacher: audited, neutralized, capped CSV export.
    // -------------------------------------------------------------------------
    router.get('/export.csv', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const filters = parseReportFilters(req, res);
            if (!filters) return;
            if (!filters.courseId) {
                res.status(400).json({ error: 'course_id is required' });
                return;
            }
            const queryScope = await authorizeReadScope(scope, filters, res);
            if (!queryScope) return;
            const visible = await readAuthorizedRecords(scope, queryScope);
            if (!visible.ok) {
                // No CSV bytes and no export audit row on an incomplete source.
                sourceUnavailable(res);
                return;
            }
            const publications = await deps.store.listPublications(scope.tenantId, filters.courseId);
            const rows = mergeRows(visible.value, publications);
            const truncated = rows.length > PROGRESS_REPORTS_EXPORT_CAP;
            const capped = truncated ? rows.slice(0, PROGRESS_REPORTS_EXPORT_CAP) : rows;
            const csv = toCsv(
                PROGRESS_REPORT_CSV_HEADERS,
                capped.map((row) => [
                    row['student_enrollment_id'],
                    row['course_id'],
                    row['course_name'],
                    row['completed_lessons'],
                    row['total_lessons'],
                    row['exam_average'],
                    row['assignment_average'],
                    row['overall'],
                    row['status'],
                    (row['publication'] as { state: string }).state,
                ]),
            );
            await deps.audit({
                actorUserId: scope.userId,
                tenantId: scope.tenantId,
                action: 'progress_report.export',
                resourceType: 'progress_report',
                resourceId: filters.courseId,
                newValue: {
                    course_id: filters.courseId,
                    branch_id: filters.branchId,
                    row_count: capped.length,
                    truncated,
                },
            });
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', 'inline; filename="progress-reports.csv"');
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.status(200).send(csv);
        } catch (error) {
            console.error('Progress report export error:', error);
            res.status(500).json({ error: 'Failed to export progress reports' });
        }
    });

    // -------------------------------------------------------------------------
    // Student: own report only (own enrollment from the authenticated principal).
    // -------------------------------------------------------------------------
    router.get('/mine', async (req: AuthRequest, res: Response) => {
        try {
            const student = await resolveStudentScope(req, res);
            if (!student) return;
            const courseId = req.query.course_id === undefined ? null : normalizeId(req.query.course_id);
            if (!courseId) {
                res.status(400).json({ error: 'course_id is required' });
                return;
            }
            const report = await deps.reportSource.findRecord(student.tenantId, student.enrollmentId, courseId);
            if (!report) {
                res.status(404).json({ error: 'Report not found' });
                return;
            }
            res.json(buildProgressReport(report));
        } catch (error) {
            console.error('Student progress report error:', error);
            res.status(500).json({ error: 'Failed to load the progress report' });
        }
    });

    return router;
};
