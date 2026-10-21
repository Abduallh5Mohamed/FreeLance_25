/**
 * M4 A7/P2 (C4a-fix) — progress report publication (hermetic, no MySQL/network).
 *
 * The REAL router factory and the REAL publication service run over injected
 * seams: an in-memory published-state store with a transaction fake that
 * actually executes the callback and restores a snapshot on throw, an in-memory
 * report read model, a fake authority that encodes real course/group/branch
 * relations, the real auth middleware over an injected principal repository,
 * and a captured audit writer. No database, provider or network is contacted;
 * supplying these stores is NOT evidence that any SQL or the I2 schema works.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { NextFunction, Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import { normalizeId } from '../src/services/gradebook';
import { buildProgressReport, filterReportsByBranch, toCsv } from '../src/services/progress-reports';
import type { ProgressRecord } from '../src/services/progress-reports';
import {
    AuditWriter,
    ProgressPublicationServiceDeps,
    PublicationRecord,
    PublicationState,
    PublicationStore,
    PublicationTransaction,
    PublicationTransactionContext,
    createProgressPublicationService,
    parentProjection,
} from '../src/services/progress-publication';
import {
    PROGRESS_REPORTS_EXPORT_CAP,
    PROGRESS_REPORTS_LIST_CAP,
    ProgressReportAuthority,
    ProgressReportQueryScope,
    ProgressReportSource,
    ProgressReportSourceResult,
    ProgressReportsDeps,
    createProgressReportsRouter,
    createSqlCourseAuthority,
} from '../src/routes/progress-reports';
import {
    TEST_SECRET,
    invokeRoute,
    makeRepository,
    tokenFor,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const T0 = new Date('2026-10-20T12:00:00.000Z');
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const ENROLLMENT_A = 'enr-a';
const ENROLLMENT_B = 'enr-b';
const ENROLLMENT_C = 'enr-c';
const ENROLLMENT_X = 'enr-x';
const COURSE_1 = 'course-1';
const COURSE_2 = 'course-2';
const COURSE_X = 'course-x';
const BRANCH_1 = 'branch-1';
const BRANCH_2 = 'branch-2';
const BRANCH_X = 'branch-x';

const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: TENANT_A });
const TEACHER_A = tokenFor({ id: 'teacher-a', role: 'instructor', tv: 0, tenant_id: TENANT_A });
const TEACHER_B = tokenFor({ id: 'teacher-b', role: 'instructor', tv: 0, tenant_id: TENANT_A });
const TEACHER_C = tokenFor({ id: 'teacher-c', role: 'instructor', tv: 0, tenant_id: TENANT_A });
const TEACHER_X = tokenFor({ id: 'teacher-x', role: 'instructor', tv: 0, tenant_id: TENANT_B });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: ENROLLMENT_A, tenant_id: TENANT_A });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: ENROLLMENT_B, tenant_id: TENANT_A });

interface StaffAuthorityFixture {
    authority: string;
    tenantId: string;
}

const STAFF: Record<string, StaffAuthorityFixture> = {
    'owner-a': { authority: 'owner', tenantId: TENANT_A },
    'teacher-a': { authority: 'instructor', tenantId: TENANT_A },
    'teacher-b': { authority: 'instructor', tenantId: TENANT_A },
    'teacher-c': { authority: 'instructor', tenantId: TENANT_A },
    'teacher-x': { authority: 'instructor', tenantId: TENANT_B },
};

const repository = makeRepository(
    {
        'owner-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-c': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-x': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0 },
    },
    {
        instructorAccounts: {
            'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'teacher-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'teacher-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'teacher-c': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            'teacher-x': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: {
            'owner-a': [{ tenant_id: TENANT_A }],
            'teacher-a': [{ tenant_id: TENANT_A }],
            'teacher-b': [{ tenant_id: TENANT_A }],
            'teacher-c': [{ tenant_id: TENANT_A }],
            'teacher-x': [{ tenant_id: TENANT_B }],
            'student-a': [{ tenant_id: TENANT_A }],
            'student-b': [{ tenant_id: TENANT_A }],
        },
        enrollments: {
            'student-a': [{ id: ENROLLMENT_A, user_id: 'student-a', tenant_id: TENANT_A, instructor_id: null, group_id: 'g-a', grade_id: null }],
            'student-b': [{ id: ENROLLMENT_B, user_id: 'student-b', tenant_id: TENANT_A, instructor_id: null, group_id: 'g-b', grade_id: null }],
        },
    },
);

const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const fixture = STAFF[userId];
    return fixture && fixture.tenantId === tenantId ? { authority: fixture.authority } : null;
};

// ---------------------------------------------------------------------------
// Authority fixture: tenant → course → group → teacher → enrollment → branch
// ---------------------------------------------------------------------------

const COURSE_TENANT: Record<string, string> = {
    [COURSE_1]: TENANT_A,
    [COURSE_2]: TENANT_A,
    [COURSE_X]: TENANT_B,
};

interface GroupFixture {
    groupId: string;
    teacherId: string;
    courseId: string;
    branchId: string;
    enrollmentIds: readonly string[];
}

const GROUPS: readonly GroupFixture[] = [
    { groupId: 'g-a', teacherId: 'teacher-a', courseId: COURSE_1, branchId: BRANCH_1, enrollmentIds: [ENROLLMENT_A] },
    { groupId: 'g-b', teacherId: 'teacher-b', courseId: COURSE_1, branchId: BRANCH_1, enrollmentIds: [ENROLLMENT_B] },
    { groupId: 'g-b2', teacherId: 'teacher-b', courseId: COURSE_2, branchId: BRANCH_1, enrollmentIds: [ENROLLMENT_B] },
    { groupId: 'g-c', teacherId: 'teacher-c', courseId: COURSE_1, branchId: BRANCH_2, enrollmentIds: [ENROLLMENT_C] },
    { groupId: 'g-x', teacherId: 'teacher-x', courseId: COURSE_X, branchId: BRANCH_X, enrollmentIds: [ENROLLMENT_X] },
];

const USER_BRANCH: Record<string, string | null> = {
    'owner-a': null,
    'teacher-a': BRANCH_1,
    'teacher-b': BRANCH_1,
    'teacher-c': BRANCH_2,
    'teacher-x': BRANCH_X,
};

const createFakeAuthority = (overrides: Partial<ProgressReportAuthority> = {}): ProgressReportAuthority => ({
    canAccessCourse: async (scope, courseId) => {
        const tenantId = COURSE_TENANT[courseId];
        if (!tenantId || tenantId !== scope.tenantId) return 'not_found';
        if (scope.isOwner) return 'ok';
        return GROUPS.some((group) => group.teacherId === scope.userId && group.courseId === courseId)
            ? 'ok'
            : 'forbidden';
    },
    mayActOnEnrollment: async (scope, courseId, enrollmentId) => {
        const tenantId = COURSE_TENANT[courseId];
        if (!tenantId || tenantId !== scope.tenantId) return 'none';
        if (scope.isOwner) return 'exact';
        const group = GROUPS.find(
            (row) => row.courseId === courseId && row.enrollmentIds.includes(enrollmentId),
        );
        if (!group) return 'none';
        return group.teacherId === scope.userId ? 'exact' : 'none';
    },
    readableScope: async (scope) => {
        if (scope.isOwner) {
            return {
                courseIds: Object.keys(COURSE_TENANT).filter((courseId) => COURSE_TENANT[courseId] === scope.tenantId),
                branchId: null,
            };
        }
        const ownGroups = GROUPS.filter(
            (group) => group.teacherId === scope.userId && COURSE_TENANT[group.courseId] === scope.tenantId,
        );
        return {
            courseIds: [...new Set(ownGroups.map((group) => group.courseId))],
            branchId: USER_BRANCH[scope.userId] ?? null,
        };
    },
    ...overrides,
});

// ---------------------------------------------------------------------------
// In-memory seams
// ---------------------------------------------------------------------------

class MemoryPublicationStore implements PublicationStore {
    records = new Map<string, PublicationRecord>();
    transitions = 0;
    listCalls = 0;
    failWith: Error | null = null;
    failOnTransition: Error | null = null;
    simulateVersionConflict = false;

    private key(tenantId: string, enrollmentId: string, courseId: string): string {
        return `${tenantId}:${enrollmentId}:${courseId}`;
    }

    async findPublication(tenantId: string, enrollmentId: string, courseId: string): Promise<PublicationRecord | null> {
        if (this.failWith) throw this.failWith;
        return this.records.get(this.key(tenantId, enrollmentId, courseId)) ?? null;
    }

    async listPublications(tenantId: string, courseId?: string): Promise<PublicationRecord[]> {
        this.listCalls += 1;
        if (this.failWith) throw this.failWith;
        return [...this.records.values()].filter((row) => row.tenantId === tenantId && (courseId === undefined || row.courseId === courseId));
    }

    async transitionPublication(input: {
        tenantId: string;
        studentEnrollmentId: string;
        courseId: string;
        expectedVersion: number;
        nextState: PublicationState;
        actorUserId: string;
        now: Date;
    }): Promise<number> {
        if (this.failWith) throw this.failWith;
        this.transitions += 1;
        if (this.simulateVersionConflict) return 0;
        const key = this.key(input.tenantId, input.studentEnrollmentId, input.courseId);
        const current = this.records.get(key);
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== input.expectedVersion) return 0;
        const next: PublicationRecord = {
            tenantId: input.tenantId,
            studentEnrollmentId: input.studentEnrollmentId,
            courseId: input.courseId,
            state: input.nextState,
            publishedBy: input.nextState === 'published' ? input.actorUserId : null,
            publishedAt: input.nextState === 'published' ? input.now : null,
            version: input.expectedVersion + 1,
        };
        this.records.set(key, next);
        if (this.failOnTransition) throw this.failOnTransition;
        return 1;
    }

    seed(record: PublicationRecord): void {
        this.records.set(this.key(record.tenantId, record.studentEnrollmentId, record.courseId), record);
    }

    snapshot(): Map<string, PublicationRecord> {
        return new Map(this.records);
    }

    restore(snapshot: Map<string, PublicationRecord>): void {
        this.records = snapshot;
    }

    versionOf(tenantId: string, enrollmentId: string, courseId: string): number {
        return this.records.get(this.key(tenantId, enrollmentId, courseId))?.version ?? 0;
    }
}

class MemoryReportSource implements ProgressReportSource {
    records: ProgressRecord[] = [];
    calls: Array<{ method: string; scope?: ProgressReportQueryScope; enrollmentId?: string; courseId?: string }> = [];
    failWith: Error | null = null;
    listResult: ProgressReportSourceResult<ProgressRecord[]> | null = null;

    async listRecords(scope: ProgressReportQueryScope): Promise<ProgressRecord[]> {
        this.calls.push({ method: 'list', scope });
        if (this.failWith) throw this.failWith;
        return this.records.filter(
            (row) => scope.courseIds.includes(row.courseId)
                && (scope.branchId === null || row.branchId === scope.branchId),
        );
    }

    async listRecordsResult(scope: ProgressReportQueryScope): Promise<ProgressReportSourceResult<ProgressRecord[]>> {
        this.calls.push({ method: 'list', scope });
        if (this.listResult) return this.listResult;
        if (this.failWith) throw this.failWith;
        return {
            ok: true,
            value: this.records.filter(
                (row) => scope.courseIds.includes(row.courseId)
                    && (scope.branchId === null || row.branchId === scope.branchId),
            ),
        };
    }

    async findRecord(tenantId: string, enrollmentId: string, courseId: string): Promise<ProgressRecord | null> {
        this.calls.push({ method: 'find', enrollmentId, courseId });
        if (this.failWith) throw this.failWith;
        return this.records.find((row) => row.studentEnrollmentId === enrollmentId && row.courseId === courseId) ?? null;
    }
}

const record = (overrides: Partial<ProgressRecord> = {}): ProgressRecord => ({
    studentEnrollmentId: ENROLLMENT_A,
    courseId: COURSE_1,
    courseName: 'Math',
    branchId: BRANCH_1,
    completedLessons: 3,
    totalLessons: 10,
    examAverage: 90,
    assignmentAverage: 80,
    overall: 86,
    status: 'in_progress',
    ...overrides,
});

/**
 * Runtime-guard probe for untyped/JS callers. The narrow signature no longer
 * accepts a bare marker, so the negative test reaches the guard through a
 * deliberate untyped view instead of `any`/`ts-ignore`.
 */
const invokeUntypedProjection = parentProjection as unknown as (
    record: ProgressRecord,
    state: unknown,
    identity?: { tenantId: string; studentEnrollmentId: string; courseId: string },
) => Record<string, unknown> | null;

/** Both teachers' students sit in the same tenant, branch and course. */
const seedAllRecords = (source: MemoryReportSource): void => {
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1, branchId: BRANCH_1 }));
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_B, courseId: COURSE_1, branchId: BRANCH_1 }));
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_C, courseId: COURSE_1, branchId: BRANCH_2 }));
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_B, courseId: COURSE_2, branchId: BRANCH_1, courseName: 'Physics' }));
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_X, courseId: COURSE_X, branchId: BRANCH_X, courseName: 'Foreign' }));
};

interface HarnessOptions {
    authority?: ProgressReportAuthority;
    audit?: AuditWriter;
}

interface Harness {
    router: Router;
    store: MemoryPublicationStore;
    source: MemoryReportSource;
    auditCalls: Array<Parameters<AuditWriter>[0]>;
}

const build = (options: HarnessOptions = {}): Harness => {
    const store = new MemoryPublicationStore();
    const source = new MemoryReportSource();
    const auditCalls: Array<Parameters<AuditWriter>[0]> = [];
    const audit: AuditWriter = options.audit ?? (async (input) => { auditCalls.push(input); });
    const authority = options.authority ?? createFakeAuthority();
    const transaction: PublicationTransaction = async <T>(
        fn: (ctx: PublicationTransactionContext) => Promise<T>,
    ): Promise<T> => {
        const snapshot = store.snapshot();
        try {
            return await fn({ store, audit });
        } catch (error) {
            store.restore(snapshot);
            throw error;
        }
    };
    const router = createProgressReportsRouter({
        authenticate: createAuthenticateToken(repository),
        loadActiveTenantAuthority,
        authority,
        reportSource: source,
        store,
        audit,
        now: () => new Date(T0),
        transaction,
    });
    return { router, store, source, auditCalls };
};

// ---------------------------------------------------------------------------
// REAL createSqlCourseAuthority over a recording, in-memory SQL seam.
// The seam records every SQL text + binding and answers with real relation
// semantics. It is NOT a MySQL execution and proves nothing about the schema.
// ---------------------------------------------------------------------------

interface DbCourse {
    id: string;
    tenant_id: string;
    instructor_id: string | null;
}

interface DbGroup {
    id: string;
    course_id: string;
    instructor_id: string;
    branch_id: string;
    branch_scope: string;
}

interface DbStudent {
    id: string;
    tenant_id: string;
    instructor_id: string | null;
    group_id: string | null;
}

interface DbStudentCourse {
    id: string;
    student_id: string;
    course_id: string;
    status: string;
}

interface DbBranch {
    id: string;
    tenant_id: string;
    status: string;
    version: number;
}

interface DbBranchMembership {
    id: string;
    branch_id: string;
    user_id: string;
    role: string;
    status: string;
    version: number;
}

interface RecordedAuthorityStatement {
    sql: string;
    params: unknown[];
    kind: 'query' | 'queryOne';
}

class RecordingAuthorityDb {
    readonly courses: DbCourse[] = [
        { id: COURSE_1, tenant_id: TENANT_A, instructor_id: null },
        { id: COURSE_2, tenant_id: TENANT_A, instructor_id: null },
    ];
    readonly groups: DbGroup[] = [
        { id: 'g-a', course_id: COURSE_1, instructor_id: 'teacher-a', branch_id: BRANCH_1, branch_scope: 'branch' },
        { id: 'g-b', course_id: COURSE_1, instructor_id: 'teacher-b', branch_id: BRANCH_1, branch_scope: 'branch' },
        { id: 'g-b2', course_id: COURSE_2, instructor_id: 'teacher-b', branch_id: BRANCH_1, branch_scope: 'branch' },
    ];
    readonly students: DbStudent[] = [
        { id: ENROLLMENT_A, tenant_id: TENANT_A, instructor_id: null, group_id: 'g-a' },
        { id: ENROLLMENT_B, tenant_id: TENANT_A, instructor_id: null, group_id: 'g-b' },
    ];
    readonly studentCourses: DbStudentCourse[] = [
        { id: 'sc-b-2', student_id: ENROLLMENT_B, course_id: COURSE_2, status: 'active' },
    ];
    readonly branches: DbBranch[] = [
        { id: BRANCH_1, tenant_id: TENANT_A, status: 'active', version: 1 },
    ];
    readonly branchMemberships: DbBranchMembership[] = [
        { id: 'bm-a', branch_id: BRANCH_1, user_id: 'teacher-a', role: 'instructor', status: 'active', version: 0 },
        { id: 'bm-b', branch_id: BRANCH_1, user_id: 'teacher-b', role: 'instructor', status: 'active', version: 0 },
        { id: 'bm-c', branch_id: BRANCH_1, user_id: 'teacher-c', role: 'instructor', status: 'active', version: 0 },
    ];
    readonly statements: RecordedAuthorityStatement[] = [];

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        this.statements.push({ sql, params: [...params], kind: 'query' });
        return this.rows(sql, params) as T[];
    }

    async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
        this.statements.push({ sql, params: [...params], kind: 'queryOne' });
        return (this.rows(sql, params)[0] ?? null) as T | null;
    }

    private rows(sql: string, params: unknown[]): unknown[] {
        const text = sql.replace(/\s+/g, ' ').trim();
        const p = params.map((value) => String(value));
        if (text.includes('FROM branches')) {
            return this.branches.filter((branch) => branch.id === p[0]);
        }
        if (text.includes('FROM branch_memberships')) {
            return this.branchMemberships.filter(
                (membership) => membership.branch_id === p[0] && membership.user_id === p[1],
            );
        }
        if (text.includes('INNER JOIN courses')) {
            const [courseId, actorId, tenantId] = p;
            const course = this.courses.find((row) => row.id === courseId && row.tenant_id === tenantId);
            if (!course) return [];
            if (text.includes('g.branch_id=?')) {
                return this.groups
                    .filter((group) => group.course_id === courseId && group.branch_id === actorId && group.branch_scope === 'branch')
                    .map((group) => ({ id: group.id }))
                    .slice(0, 1);
            }
            return this.groups
                .filter((group) => group.course_id === courseId && group.instructor_id === actorId)
                .map((group) => ({ id: group.id }))
                .slice(0, 1);
        }
        if (text.includes('FROM students s')) {
            const [courseId, studentId, tenantId] = p;
            const student = this.students.find((row) => row.id === studentId && row.tenant_id === tenantId);
            if (!student) return [];
            const group = student.group_id
                ? this.groups.find((row) => row.id === student.group_id) ?? null
                : null;
            const activeCourse = this.studentCourses.find(
                (row) => row.student_id === student.id && row.course_id === courseId && row.status === 'active',
            );
            return [{
                id: student.id,
                tenant_id: student.tenant_id,
                instructor_id: student.instructor_id,
                group_id: student.group_id,
                group_course_id: group?.course_id ?? null,
                group_instructor_id: group?.instructor_id ?? null,
                group_branch_id: group?.branch_id ?? null,
                group_branch_scope: group?.branch_scope ?? null,
                active_course: activeCourse ? 1 : 0,
            }];
        }
        if (text.includes('FROM courses WHERE id=?')) {
            return this.courses.filter((course) => course.id === p[0]);
        }
        if (text.includes('FROM courses WHERE tenant_id=?')) {
            return this.courses.filter((course) => course.tenant_id === p[0]);
        }
        if (text.includes('SELECT DISTINCT c.id FROM courses c')) {
            const [tenantId, actorId] = p;
            const ids = this.courses
                .filter((course) => course.tenant_id === tenantId && (
                    course.instructor_id === actorId
                    || this.groups.some((group) => group.course_id === course.id && group.instructor_id === actorId)
                ))
                .map((course) => course.id);
            return [...new Set(ids)].map((id) => ({ id }));
        }
        return [];
    }
}

const SQL_BRANCH_MEMBERS = new Set(['teacher-a', 'teacher-b', 'teacher-c']);

const sqlRepository = {
    ...repository,
    findBranchSession: async (branchId: string, userId: string) => {
        if (branchId !== BRANCH_1 || !SQL_BRANCH_MEMBERS.has(userId)) return null;
        return {
            branch_id: BRANCH_1,
            branch_tenant_id: TENANT_A,
            branch_status: 'active',
            branch_version: 1,
            membership_status: 'active',
            membership_version: 0,
            membership_role: 'instructor',
        };
    },
    isTenantOwner: async (userId: string, tenantId: string) => userId === 'owner-a' && tenantId === TENANT_A,
};

const branchToken = (userId: string): string => tokenFor({
    id: userId,
    role: 'instructor',
    tv: 0,
    tenant_id: TENANT_A,
    branch_id: BRANCH_1,
    branch_membership_version: 0,
});

const SQL_TEACHER_A = branchToken('teacher-a');
const SQL_TEACHER_B = branchToken('teacher-b');
const SQL_TEACHER_C = branchToken('teacher-c');
const SQL_OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: TENANT_A });

interface SqlHarness {
    router: Router;
    db: RecordingAuthorityDb;
    store: MemoryPublicationStore;
    source: MemoryReportSource;
    auditCalls: Array<Parameters<AuditWriter>[0]>;
}

const buildSql = (): SqlHarness => {
    const db = new RecordingAuthorityDb();
    const store = new MemoryPublicationStore();
    const source = new MemoryReportSource();
    const auditCalls: Array<Parameters<AuditWriter>[0]> = [];
    const audit: AuditWriter = async (input) => { auditCalls.push(input); };
    const transaction: PublicationTransaction = async <T>(
        fn: (ctx: PublicationTransactionContext) => Promise<T>,
    ): Promise<T> => {
        const snapshot = store.snapshot();
        try {
            return await fn({ store, audit });
        } catch (error) {
            store.restore(snapshot);
            throw error;
        }
    };
    const router = createProgressReportsRouter({
        authenticate: createAuthenticateToken(sqlRepository),
        loadActiveTenantAuthority,
        authority: createSqlCourseAuthority(db),
        reportSource: source,
        store,
        audit,
        now: () => new Date(T0),
        transaction,
    });
    return { router, db, store, source, auditCalls };
};

const seedSqlRecords = (source: MemoryReportSource): void => {
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1, branchId: BRANCH_1 }));
    source.records.push(record({ studentEnrollmentId: ENROLLMENT_B, courseId: COURSE_1, branchId: BRANCH_1, courseName: 'Physics' }));
};

/** Like the shared harness, but supports `res.send` for the CSV export route. */
interface PlainResponse {
    statusCode?: number;
    body?: unknown;
    headers?: Record<string, string>;
    status(code: number): PlainResponse;
    json(payload: unknown): PlainResponse;
    set(header: string, value: string): PlainResponse;
    send(payload: unknown): PlainResponse;
}

async function invokePlain(
    router: Router,
    request: { method: string; url: string; token?: string | null; body?: unknown; query?: Record<string, string> },
): Promise<PlainResponse> {
    const headers: Record<string, string> = {};
    const response: PlainResponse = {
        statusCode: undefined,
        body: undefined,
        headers: undefined,
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
        set(header: string, value: string) { headers[header.toLowerCase()] = value; response.headers = headers; return response; },
        send(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
    };
    const req: unknown = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 2000;
    while (response.statusCode === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
}

interface ListedReport {
    student_enrollment_id: string;
    course_id: string;
    publication: { state: string; version: number };
}

const reportsOf = (body: unknown): ListedReport[] => {
    const parsed = body as { reports?: unknown };
    assert.ok(Array.isArray(parsed.reports), 'expected a reports array');
    return parsed.reports as ListedReport[];
};

const publish = (h: Harness, token: string, enrollmentId = ENROLLMENT_A, courseId = COURSE_1) =>
    invokeRoute(h.router, { method: 'POST', url: '/publish', token, body: { student_enrollment_id: enrollmentId, course_id: courseId } });
const unpublish = (h: Harness, token: string, enrollmentId = ENROLLMENT_A, courseId = COURSE_1) =>
    invokeRoute(h.router, { method: 'POST', url: '/unpublish', token, body: { student_enrollment_id: enrollmentId, course_id: courseId } });

const listReports = (h: Harness, token: string, query: Record<string, string> = {}) =>
    invokeRoute(h.router, { method: 'GET', url: '/', token, query });

// ---------------------------------------------------------------------------
// Authentication / authority boundary
// ---------------------------------------------------------------------------

test('anonymous requests are denied before any store or source call', async () => {
    const h = build();
    const res = await invokeRoute(h.router, { method: 'POST', url: '/publish', body: { student_enrollment_id: ENROLLMENT_A, course_id: COURSE_1 } });
    assert.equal(res.statusCode, 401);
    assert.equal(h.source.calls.length, 0);
    assert.equal(h.store.transitions, 0);
});

test('a student cannot reach the teacher list', async () => {
    const h = build();
    const res = await listReports(h, STUDENT_A);
    assert.equal(res.statusCode, 403);
    assert.equal(h.source.calls.length, 0);
});

test('a teacher of another course is denied and performs no write', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await publish(h, TEACHER_A, ENROLLMENT_B, COURSE_2);
    assert.equal(res.statusCode, 403);
    assert.equal(h.store.transitions, 0);
    assert.equal(h.auditCalls.length, 0);
});

test('a cross-tenant course is a 404', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await publish(h, TEACHER_A, ENROLLMENT_X, COURSE_X);
    assert.equal(res.statusCode, 404);
    assert.equal(h.store.transitions, 0);
});

test('a foreign enrollment yields 404 before any write', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await publish(h, TEACHER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(res.statusCode, 404);
    assert.equal(h.store.transitions, 0);
    assert.equal(h.auditCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Publish / unpublish semantics
// ---------------------------------------------------------------------------

test('publish is idempotent: the second publish writes nothing and bumps no version', async () => {
    const h = build();
    h.source.records.push(record());
    const first = await publish(h, TEACHER_A);
    assert.equal(first.statusCode, 200);
    assert.equal((first.body as { state: string }).state, 'published');
    const second = await publish(h, TEACHER_A);
    assert.equal(second.statusCode, 200);
    assert.equal((second.body as { state: string }).state, 'published');
    assert.equal(h.store.transitions, 1, 'the second publish must not write');
    assert.equal(h.store.versionOf(TENANT_A, ENROLLMENT_A, COURSE_1), 1);
    assert.equal(h.auditCalls.length, 1, 'only the real transition is audited');
});

test('a version race returns 409 with no write and no audit', async () => {
    const h = build();
    h.source.records.push(record());
    h.store.simulateVersionConflict = true;
    const res = await publish(h, TEACHER_A);
    assert.equal(res.statusCode, 409);
    assert.equal(h.store.versionOf(TENANT_A, ENROLLMENT_A, COURSE_1), 0, 'no write');
    assert.equal(h.auditCalls.length, 0, 'a rejected transition must not be audited');
});

test('unpublish is idempotent and returns the parent projection to null', async () => {
    const h = build();
    const facts = record();
    h.source.records.push(facts);
    const identity = { tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1 };
    assert.equal(parentProjection(facts, null, identity), null, 'no publication row projects nothing');
    await publish(h, TEACHER_A);
    const published = await h.store.findPublication(TENANT_A, ENROLLMENT_A, COURSE_1);
    assert.ok(published);
    assert.equal(parentProjection(facts, published, identity)?.overall, 86);
    const res = await unpublish(h, TEACHER_A);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { state: string }).state, 'draft');
    const after = await h.store.findPublication(TENANT_A, ENROLLMENT_A, COURSE_1);
    assert.equal(after?.state, 'draft');
    assert.equal(parentProjection(facts, after, identity), null, 'the parent projection is null again');
    const again = await unpublish(h, TEACHER_A);
    assert.equal(again.statusCode, 200);
    assert.equal(h.store.transitions, 2, 'the second unpublish is a no-op');
});

test('publish/unpublish cycles bump the version monotonically', async () => {
    const h = build();
    h.source.records.push(record());
    await publish(h, TEACHER_A);
    await unpublish(h, TEACHER_A);
    await publish(h, TEACHER_A);
    assert.equal(h.store.versionOf(TENANT_A, ENROLLMENT_A, COURSE_1), 3);
});

// ---------------------------------------------------------------------------
// Parent projection contract
// ---------------------------------------------------------------------------

test('published projection contains exactly the explicit field list and no internal ids', () => {
    const publication: PublicationRecord = {
        tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1,
        state: 'published', publishedBy: 'teacher-a', publishedAt: T0, version: 1,
    };
    const identity = { tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1 };
    const projected = parentProjection(record(), publication, identity);
    assert.ok(projected);
    assert.deepEqual(
        Object.keys(projected).sort(),
        ['completed_lessons', 'course_id', 'course_name', 'overall', 'status', 'total_lessons'],
    );
    assert.ok(!('student_enrollment_id' in projected));
    assert.ok(!('exam_average' in projected));
    assert.ok(!('assignment_average' in projected));
    assert.equal(projected.overall, 86);
});

test('draft data never leaks through the parent projection (serialized object)', () => {
    assert.equal(JSON.stringify(invokeUntypedProjection(record(), 'draft')), 'null', 'the scalar draft marker is not a publication proof');
    assert.equal(JSON.stringify(parentProjection(record(), null)), 'null');
    const draft: PublicationRecord = {
        tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1,
        state: 'draft', publishedBy: null, publishedAt: null, version: 0,
    };
    const identity = { tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1 };
    assert.equal(JSON.stringify(parentProjection(record(), draft, identity)), 'null');
});

test('a publication row for another report key can never unlock the projection', () => {
    const publication: PublicationRecord = {
        tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1,
        state: 'published', publishedBy: 'teacher-a', publishedAt: T0, version: 1,
    };
    const facts = record();
    const identity = { tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1 };
    assert.ok(parentProjection(facts, publication, identity));
    assert.equal(invokeUntypedProjection(facts, 'published'), null, 'a scalar published marker alone is rejected');
    assert.equal(invokeUntypedProjection(facts, 'published', identity), null, 'a scalar marker is rejected even with an identity');
    assert.equal(parentProjection(facts, publication), null, 'identity is required for a publication row');
    assert.equal(parentProjection(facts, { ...publication, state: 'draft' }, identity), null, 'a draft row never projects');
    assert.equal(parentProjection(facts, publication, { ...identity, tenantId: TENANT_B }), null, 'identity tenant mismatch');
    assert.equal(parentProjection(facts, publication, { ...identity, studentEnrollmentId: ENROLLMENT_B }), null, 'identity enrollment mismatch');
    assert.equal(parentProjection(facts, publication, { ...identity, courseId: COURSE_2 }), null, 'identity course mismatch');
    assert.equal(parentProjection(record({ studentEnrollmentId: ENROLLMENT_B }), publication, identity), null, 'record enrollment mismatch');
    assert.equal(parentProjection(record({ courseId: COURSE_2 }), publication, identity), null, 'record course mismatch');
    assert.equal(
        parentProjection(facts, { ...publication, tenantId: TENANT_B }, identity),
        null,
        'publication tenant mismatch',
    );
    assert.equal(
        parentProjection(facts, { ...publication, studentEnrollmentId: ENROLLMENT_B }, identity),
        null,
        'publication enrollment mismatch',
    );
    assert.equal(
        parentProjection(facts, { ...publication, courseId: COURSE_2 }, identity),
        null,
        'publication course mismatch',
    );
});

// ---------------------------------------------------------------------------
// Teacher list: per-row authority, branches, forged selectors
// ---------------------------------------------------------------------------

test('a student sees only their own report', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await invokeRoute(h.router, { method: 'GET', url: `/mine?course_id=${COURSE_1}`, token: STUDENT_A, query: { course_id: COURSE_1 } });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { student_enrollment_id: string }).student_enrollment_id, ENROLLMENT_A);
    assert.deepEqual(h.source.calls.at(-1), { method: 'find', enrollmentId: ENROLLMENT_A, courseId: COURSE_1 });
});

test('two teachers in the same branch and course cannot see each other\'s groups', async () => {
    const h = build();
    seedAllRecords(h.source);
    const a = await listReports(h, TEACHER_A);
    const b = await listReports(h, TEACHER_B, { course_id: COURSE_1 });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.deepEqual(reportsOf(a.body).map((row) => row.student_enrollment_id), [ENROLLMENT_A]);
    assert.deepEqual(reportsOf(b.body).map((row) => row.student_enrollment_id), [ENROLLMENT_B]);
});

test('removing the course selector does not widen a teacher to the whole tenant', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await listReports(h, TEACHER_A);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(reportsOf(res.body).map((row) => row.student_enrollment_id), [ENROLLMENT_A]);
    const lastCall = h.source.calls.at(-1);
    assert.deepEqual(lastCall?.scope, { tenantId: TENANT_A, courseIds: [COURSE_1], branchId: BRANCH_1 });
});

test('two branches are isolated even on the same course', async () => {
    const h = build();
    seedAllRecords(h.source);
    const a = await listReports(h, TEACHER_A);
    const c = await listReports(h, TEACHER_C);
    assert.deepEqual(reportsOf(a.body).map((row) => row.student_enrollment_id), [ENROLLMENT_A]);
    assert.deepEqual(reportsOf(c.body).map((row) => row.student_enrollment_id), [ENROLLMENT_C]);
});

test('a forged course selector is denied', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await listReports(h, TEACHER_A, { course_id: COURSE_2 });
    assert.equal(res.statusCode, 403);
});

test('a forged branch selector is denied', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await listReports(h, TEACHER_A, { branch_id: BRANCH_2 });
    assert.equal(res.statusCode, 403);
});

test('a teacher cannot publish another teacher\'s student in the same branch', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await publish(h, TEACHER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(res.statusCode, 404);
    assert.equal(h.store.transitions, 0, 'no state write');
    assert.equal(h.auditCalls.length, 0, 'no success audit row');
});

test('a teacher cannot unpublish another teacher\'s published student', async () => {
    const h = build();
    seedAllRecords(h.source);
    h.store.seed({
        tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_B, courseId: COURSE_1,
        state: 'published', publishedBy: 'teacher-b', publishedAt: T0, version: 1,
    });
    const res = await unpublish(h, TEACHER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(res.statusCode, 404);
    const after = await h.store.findPublication(TENANT_A, ENROLLMENT_B, COURSE_1);
    assert.equal(after?.state, 'published', 'the published state is untouched');
    assert.equal(after?.version, 1, 'no version bump');
    assert.equal(h.auditCalls.length, 0, 'no success audit row');
});

test('the owner is positive across the tenant but never cross-tenant', async () => {
    const h = build();
    seedAllRecords(h.source);
    const list = await listReports(h, OWNER_A);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
        reportsOf(list.body).map((row) => row.student_enrollment_id).sort(),
        [ENROLLMENT_A, ENROLLMENT_B, ENROLLMENT_B, ENROLLMENT_C],
    );
    const publishOther = await publish(h, OWNER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(publishOther.statusCode, 200);
    const crossTenant = await publish(h, OWNER_A, ENROLLMENT_X, COURSE_X);
    assert.equal(crossTenant.statusCode, 404);
    assert.equal(h.store.versionOf(TENANT_A, ENROLLMENT_B, COURSE_1), 1);
});

// ---------------------------------------------------------------------------
// REAL SQL authority: branch membership is a constraint, never an assignment
// ---------------------------------------------------------------------------

test('SQL authority: teacherA cannot list teacherB\'s student in the same branch, with or without selectors', async () => {
    const h = buildSql();
    seedSqlRecords(h.source);
    const omitted = await listReports(h, SQL_TEACHER_A);
    assert.equal(omitted.statusCode, 200);
    assert.deepEqual(reportsOf(omitted.body).map((row) => row.student_enrollment_id), [ENROLLMENT_A]);
    const branchOnly = await listReports(h, SQL_TEACHER_A, { branch_id: BRANCH_1 });
    assert.equal(branchOnly.statusCode, 200);
    assert.deepEqual(reportsOf(branchOnly.body).map((row) => row.student_enrollment_id), [ENROLLMENT_A]);
    const forgedCourse = await listReports(h, SQL_TEACHER_A, { course_id: COURSE_2 });
    assert.equal(forgedCourse.statusCode, 403);
    const other = await listReports(h, SQL_TEACHER_B);
    assert.equal(other.statusCode, 200);
    assert.deepEqual(reportsOf(other.body).map((row) => row.student_enrollment_id), [ENROLLMENT_B]);
});

test('SQL authority: teacherA cannot export teacherB\'s student', async () => {
    const h = buildSql();
    seedSqlRecords(h.source);
    const res = await invokePlain(h.router, {
        method: 'GET',
        url: `/export.csv?course_id=${COURSE_1}`,
        token: SQL_TEACHER_A,
        query: { course_id: COURSE_1 },
    });
    assert.equal(res.statusCode, 200);
    const csv = res.body as string;
    assert.ok(csv.includes(ENROLLMENT_A));
    assert.equal(csv.includes(ENROLLMENT_B), false, 'another teacher\'s student in the same branch must not be exported');
    assert.equal(h.auditCalls.filter((entry) => entry.action === 'progress_report.export').length, 1);
});

test('SQL authority: branch membership alone grants no rows and no publish', async () => {
    const h = buildSql();
    seedSqlRecords(h.source);
    const list = await listReports(h, SQL_TEACHER_C);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(reportsOf(list.body), [], 'branch membership alone sees nothing');
    const res = await publish(h, SQL_TEACHER_C, ENROLLMENT_A, COURSE_1);
    assert.equal(res.statusCode, 403);
    assert.equal(h.store.transitions, 0);
    assert.equal(h.auditCalls.length, 0);
});

test('SQL authority: teacherA cannot publish or unpublish teacherB\'s student without a write or success audit', async () => {
    const h = buildSql();
    seedSqlRecords(h.source);
    const pub = await publish(h, SQL_TEACHER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(pub.statusCode, 404);
    assert.equal(h.store.transitions, 0, 'no state write');
    assert.equal(h.auditCalls.length, 0, 'no success audit row');
    h.store.seed({
        tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_B, courseId: COURSE_1,
        state: 'published', publishedBy: 'teacher-b', publishedAt: T0, version: 1,
    });
    const unpub = await unpublish(h, SQL_TEACHER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(unpub.statusCode, 404);
    const after = await h.store.findPublication(TENANT_A, ENROLLMENT_B, COURSE_1);
    assert.equal(after?.state, 'published');
    assert.equal(after?.version, 1);
    assert.equal(h.store.transitions, 0, 'no state write');
    assert.equal(h.auditCalls.length, 0, 'no success audit row');
    const forgedCourse = await publish(h, SQL_TEACHER_A, ENROLLMENT_B, COURSE_2);
    assert.equal(forgedCourse.statusCode, 403);
    assert.equal(h.store.transitions, 0);
});

test('SQL authority: the owner and the explicitly assigned teachers remain positive', async () => {
    const h = buildSql();
    seedSqlRecords(h.source);
    const byB = await publish(h, SQL_TEACHER_B, ENROLLMENT_B, COURSE_1);
    assert.equal(byB.statusCode, 200);
    const byA = await publish(h, SQL_TEACHER_A, ENROLLMENT_A, COURSE_1);
    assert.equal(byA.statusCode, 200);
    assert.equal(h.store.transitions, 2);
    const ownerList = await listReports(h, SQL_OWNER_A);
    assert.equal(ownerList.statusCode, 200);
    const ownerIds = reportsOf(ownerList.body).map((row) => row.student_enrollment_id).sort();
    assert.deepEqual(ownerIds, [ENROLLMENT_A, ENROLLMENT_B]);
    const ownerUnpublish = await unpublish(h, SQL_OWNER_A, ENROLLMENT_B, COURSE_1);
    assert.equal(ownerUnpublish.statusCode, 200);
    assert.equal(h.store.transitions, 3);
});

test('SQL authority: recorded SQL text contains no membership-only branch grant', async () => {
    const h = buildSql();
    seedSqlRecords(h.source);
    await listReports(h, SQL_TEACHER_A);
    await publish(h, SQL_TEACHER_A, ENROLLMENT_B, COURSE_1);
    const normalized = h.db.statements.map((statement) => statement.sql).join('\n').replace(/\s+/g, ' ');
    assert.ok(/FROM branch_memberships/i.test(normalized), 'branch membership is still verified');
    assert.equal(/g\.branch_id\s*=\s*\?/i.test(normalized), false, 'no group-branch grant in any recorded SQL');
    assert.equal(/OR\s*\(\s*g\.branch_id/i.test(normalized), false, 'no membership-only OR branch grant');
});

// ---------------------------------------------------------------------------
// Export: per-row authority, audited, neutralized, capped
// ---------------------------------------------------------------------------

test('the CSV export carries only rows the teacher may act on', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await invokePlain(h.router, { method: 'GET', url: `/export.csv?course_id=${COURSE_1}`, token: TEACHER_B, query: { course_id: COURSE_1 } });
    assert.equal(res.statusCode, 200);
    const csv = res.body as string;
    assert.ok(csv.includes(ENROLLMENT_B));
    assert.equal(csv.includes(ENROLLMENT_A), false, 'another group in the same branch is excluded');
    assert.equal(csv.includes(ENROLLMENT_C), false, 'another branch is excluded');
    const audit = h.auditCalls.find((entry) => entry.action === 'progress_report.export');
    assert.ok(audit, 'the export must be audited');
    assert.equal((audit!.newValue as { row_count: number }).row_count, 1);
});

test('a forged export course is denied and sends no CSV', async () => {
    const h = build();
    seedAllRecords(h.source);
    const res = await invokePlain(h.router, { method: 'GET', url: `/export.csv?course_id=${COURSE_2}`, token: TEACHER_A, query: { course_id: COURSE_2 } });
    assert.equal(res.statusCode, 403);
    assert.equal(typeof res.body === 'string' && res.body.startsWith('student_enrollment_id'), false);
    assert.equal(h.auditCalls.some((entry) => entry.action === 'progress_report.export'), false);
});

test('the CSV export is audited, neutralized and capped', async () => {
    const h = build();
    const rows: ProgressRecord[] = [];
    for (let i = 0; i < PROGRESS_REPORTS_EXPORT_CAP + 1; i += 1) {
        rows.push(record({ studentEnrollmentId: `enr-${i}`, courseName: i === 0 ? '=cmd|calc' : 'Math' }));
    }
    h.source.records = rows;
    const res = await invokePlain(h.router, { method: 'GET', url: `/export.csv?course_id=${COURSE_1}`, token: OWNER_A, query: { course_id: COURSE_1 } });
    assert.equal(res.statusCode, 200);
    assert.ok((res.body as string).includes("'=cmd|calc"), 'a formula payload must be neutralized');
    assert.equal(res.headers?.['x-results-truncated'], 'true');
    assert.equal((res.body as string).split('\r\n').length, PROGRESS_REPORTS_EXPORT_CAP + 1);
    const audit = h.auditCalls.find((entry) => entry.action === 'progress_report.export');
    assert.ok(audit, 'the export must be audited');
    assert.equal((audit!.newValue as { row_count: number }).row_count, PROGRESS_REPORTS_EXPORT_CAP);
    assert.equal((audit!.newValue as { truncated: boolean }).truncated, true);
});

test('an unavailable source makes the list return 503 with a generic body and no records', async () => {
    const h = build();
    h.source.listResult = { ok: false, code: 'unavailable', detail: 'ER_NO_SUCH_TABLE' };
    const res = await listReports(h, TEACHER_A);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Progress reports are temporarily unavailable' });
    assert.equal(h.store.listCalls, 0, 'no publication read after an unavailable source');
});

test('an incomplete source makes the CSV export return 503 with no CSV bytes and no export audit', async () => {
    const h = build();
    h.source.listResult = { ok: false, code: 'incomplete', detail: 'score rows exceeded cap' };
    const res = await invokePlain(h.router, {
        method: 'GET',
        url: `/export.csv?course_id=${COURSE_1}`,
        token: TEACHER_A,
        query: { course_id: COURSE_1 },
    });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Progress reports are temporarily unavailable' });
    assert.equal(typeof res.body === 'string', false, 'no CSV may reach the response');
    assert.equal(h.auditCalls.length, 0, 'no export audit row and no success audit for an unavailable source');
});

test('an untyped source error stays a generic 500, never an empty report or a success', async () => {
    const h = build();
    h.source.failWith = new Error('unexpected driver failure');
    const res = await listReports(h, TEACHER_A);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Failed to list progress reports' });
    assert.equal(h.auditCalls.length, 0);
});

test('an authorized but empty source still returns 200 with an empty report list', async () => {
    const h = build();
    const res = await listReports(h, TEACHER_A);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(reportsOf(res.body), []);
    assert.equal(res.headers?.['x-results-truncated'], 'false');
});

test('an export audit failure returns 500 and sends no CSV', async () => {
    const h = build({ audit: async () => { throw new Error('audit down'); } });
    h.source.records.push(record());
    const res = await invokePlain(h.router, { method: 'GET', url: `/export.csv?course_id=${COURSE_1}`, token: TEACHER_A, query: { course_id: COURSE_1 } });
    assert.equal(res.statusCode, 500);
    assert.equal((res.body as { error: string }).error, 'Failed to export progress reports');
    assert.equal(typeof res.body === 'string' && res.body.startsWith('student_enrollment_id'), false, 'no CSV may reach the response');
});

// ---------------------------------------------------------------------------
// Atomicity: the transaction is required and really rolls back
// ---------------------------------------------------------------------------

test('an audit failure rolls the state change back (real callback execution)', async () => {
    const h = build({ audit: async () => { throw new Error('audit down'); } });
    h.source.records.push(record());
    const res = await publish(h, TEACHER_A);
    assert.equal(res.statusCode, 500);
    assert.equal(h.store.versionOf(TENANT_A, ENROLLMENT_A, COURSE_1), 0, 'the transition was rolled back');
    assert.equal((await h.store.findPublication(TENANT_A, ENROLLMENT_A, COURSE_1)), null, 'the original state is restored');
});

test('a store failure after the write leaves no audit row and rolls back', async () => {
    const h = build();
    h.source.records.push(record());
    h.store.failOnTransition = new Error('store down');
    const res = await publish(h, TEACHER_A);
    assert.equal(res.statusCode, 500);
    assert.equal(h.store.transitions, 1, 'the callback really executed the transition');
    assert.equal(h.store.versionOf(TENANT_A, ENROLLMENT_A, COURSE_1), 0, 'the write was undone');
    assert.equal(h.auditCalls.length, 0, 'the audit must not run after a failed store write');
});

test('an incomplete configuration is rejected before any write', async () => {
    const store = new MemoryPublicationStore();
    const audit: AuditWriter = async () => {};
    assert.throws(
        () => createProgressPublicationService({ store, audit } as unknown as ProgressPublicationServiceDeps),
        /store, audit and transaction/,
    );
    const source = new MemoryReportSource();
    const authority = createFakeAuthority();
    assert.throws(
        () => createProgressReportsRouter({
            authenticate: createAuthenticateToken(repository),
            loadActiveTenantAuthority,
            authority,
            reportSource: source,
            store,
            audit,
        } as unknown as ProgressReportsDeps),
        /store, audit and transaction/,
    );
    assert.equal(store.transitions, 0);
});

test('a store failure surfaces as a generic 500 without leaking details', async () => {
    const h = build();
    h.source.records.push(record());
    h.store.failWith = new Error('simulated outage');
    const res = await publish(h, TEACHER_A);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.stringify(res.body).includes('simulated outage'), false);
    assert.equal(h.auditCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Reused pure helpers stay intact
// ---------------------------------------------------------------------------

test('normalizeId accepts a well-formed id and rejects a malformed one', () => {
    assert.equal(normalizeId('course-1'), 'course-1');
    assert.equal(normalizeId('bad id!'), null);
});

test('filterReportsByBranch narrows only when a branch scope is supplied', () => {
    const rows = [record({ studentEnrollmentId: 'a', branchId: BRANCH_1 }), record({ studentEnrollmentId: 'b', branchId: BRANCH_2 })];
    assert.equal(filterReportsByBranch(rows, BRANCH_1).length, 1);
    assert.equal(filterReportsByBranch(rows, null).length, 2);
});

test('buildProgressReport and toCsv keep their existing contracts', () => {
    const report = buildProgressReport(record());
    assert.equal(report.overall, 86);
    assert.equal(toCsv(['a'], [['=1,2']]), "a\r\n\"'=1,2\"");
});

test('the service factory is usable directly with an injected store and transaction', async () => {
    const store = new MemoryPublicationStore();
    const calls: string[] = [];
    const transaction: PublicationTransaction = async <T>(fn: (ctx: PublicationTransactionContext) => Promise<T>): Promise<T> => {
        const snapshot = store.snapshot();
        try {
            return await fn({ store, audit: async (input) => { calls.push(input.action); } });
        } catch (error) {
            store.restore(snapshot);
            throw error;
        }
    };
    const service = createProgressPublicationService({
        store,
        audit: async (input) => { calls.push(input.action); },
        now: () => new Date(T0),
        transaction,
    });
    const outcome = await service.publish({ tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1, actorUserId: 'teacher-a' });
    assert.equal(outcome.kind, 'published');
    assert.deepEqual(calls, ['progress_report.publish']);
    assert.equal((await service.getState({ tenantId: TENANT_A, studentEnrollmentId: ENROLLMENT_A, courseId: COURSE_1 })).state, 'published');
    assert.equal(PROGRESS_REPORTS_LIST_CAP, 500);
});
