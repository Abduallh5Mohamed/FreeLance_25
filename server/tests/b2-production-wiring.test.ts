/**
 * B2-C-INTEGRATION — acceptance tests for the production wiring.
 *
 * HONEST LIMIT: these tests run the REAL routers over the REAL SQL adapters
 * over a recording, in-memory connection. The recording transaction really
 * executes the runner callback and restores the state snapshot on throw, so it
 * exercises rollback and connection identity. It is NOT a MySQL run, not a live
 * server start, and the source migrations are NOT applied. Driver options
 * (`supportBigNumbers`/`bigNumberStrings`) and the production sealed-writer
 * behaviour remain unproven until an authorized live run.
 *
 * The fake connection is never described as MySQL. It implements the exact
 * statements the adapters issue, so the router -> service -> adapter ->
 * audit chain is the production chain.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { NextFunction, RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { AuthRequest } from '../src/middleware/auth';
import {
    createInformationSchemaReadinessProbe,
    createSchoolReportingRouters,
    REPORTING_REQUIRED_COLUMNS,
    REPORTING_REQUIRED_TABLES,
    type ReportingDatabase,
    type ReportingSqlConnection,
    type SchemaReadinessProbe,
} from '../src/services/school-reporting-wiring';
import {
    createExamManualGradingSqlStore,
} from '../src/services/exam-manual-grading-sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface State {
    presentTables: Set<string>;
    presentColumns: Set<string>;
    attempts: Array<Record<string, unknown>>;
    questions: Array<Record<string, unknown>>;
    answers: Array<Record<string, unknown>>;
    revisions: Array<Record<string, unknown>>;
    publications: Array<Record<string, unknown>>;
    auditEvents: Array<Record<string, unknown>>;
    auditHead: Record<string, unknown> | null;
    tenants: Array<Record<string, unknown>>;
    memberships: Array<Record<string, unknown>>;
    courses: Array<Record<string, unknown>>;
    exams: Array<Record<string, unknown>>;
    groups: Array<Record<string, unknown>>;
    students: Array<Record<string, unknown>>;
    studentCourses: Array<Record<string, unknown>>;
    branchMemberships: Array<Record<string, unknown>>;
    branches: Array<Record<string, unknown>>;
    gradebookScores: Array<Record<string, unknown>>;
    attendanceRecords: Array<Record<string, unknown>>;
    sourceUnavailable: boolean;
    incompleteCount: boolean;
}

const baseState = (): State => ({
    presentTables: new Set(REPORTING_REQUIRED_TABLES),
    presentColumns: new Set(REPORTING_REQUIRED_COLUMNS.map((entry) => `${entry.table}.${entry.column}`)),
    attempts: [],
    questions: [],
    answers: [],
    revisions: [],
    publications: [],
    auditEvents: [],
    auditHead: null,
    tenants: [{ id: 't1', owner_user_id: 'teacher1', status: 'active' }],
    memberships: [],
    courses: [{ id: 'c1', tenant_id: 't1', instructor_id: 'teacher1', is_active: 1, name: 'Math' }],
    exams: [{ id: 'e1', course_id: 'c1' }],
    groups: [{ id: 'g1', course_id: 'c1', instructor_id: 'teacher1', branch_id: null, branch_scope: 'tenant' }],
    students: [{ id: 's1', tenant_id: 't1', group_id: 'g1', instructor_id: 'teacher1' }],
    studentCourses: [],
    branchMemberships: [],
    branches: [],
    gradebookScores: [],
    attendanceRecords: [],
    sourceUnavailable: false,
    incompleteCount: false,
});

const attemptFixture = (): Record<string, unknown> => ({
    id: 'a1',
    tenant_id: 't1',
    exam_id: 'e1',
    exam_version_id: 'v1',
    student_enrollment_id: 's1',
    student_user_id: 'student-user',
    status: 'pending_review',
    submitted_at: '2026-10-21T09:00:00.000Z',
    auto_score: '10.00',
    score: null,
    manual_required: 1,
    passing_points: '5.00',
    version: 3,
    reviewer_user_id: null,
    graded_at: null,
    passed: null,
});

interface RecordedStatement {
    readonly connId: number;
    readonly kind: 'query' | 'execute';
    readonly sql: string;
    readonly params: readonly unknown[];
}

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

class FakeReportingDb implements ReportingDatabase {
    readonly statements: RecordedStatement[] = [];
    readonly state: State;
    commits = 0;
    rollbacks = 0;
    /** Optional injected schema error for request-time classification tests. */
    failure: { code: string; fragment: string } | null = null;
    private connectionSeq = 0;

    constructor(state: State = baseState()) {
        this.state = state;
    }

    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        return this.dispatch('query', 0, sql, params) as Promise<T[]>;
    }

    async queryOne<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
        const rows = await this.query<T>(sql, params);
        return rows[0] ?? null;
    }

    readonly transaction = async <T>(fn: (conn: ReportingSqlConnection) => Promise<T>): Promise<T> => {
        const snapshot = structuredClone(this.state);
        const connId = ++this.connectionSeq;
        const conn: ReportingSqlConnection = {
            query: <R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
                this.dispatch('query', connId, sql, params) as Promise<R[]>,
            execute: async (sql: string, params: readonly unknown[] = []) => {
                const result = await this.dispatch('execute', connId, sql, params);
                return result as { affectedRows?: number | string; insertId?: number | string };
            },
        };
        try {
            const result = await fn(conn);
            this.commits += 1;
            return result;
        } catch (error) {
            this.state = snapshot;
            this.rollbacks += 1;
            throw error;
        }
    };

    writeStatements(): RecordedStatement[] {
        return this.statements.filter((statement) => statement.kind === 'execute'
            && /\b(INSERT|UPDATE|DELETE)\b/i.test(statement.sql));
    }

    auditInserts(): RecordedStatement[] {
        return this.statements.filter((statement) => statement.kind === 'execute'
            && statement.sql.includes('INSERT INTO audit_events'));
    }

    statementsFor(fragment: string): RecordedStatement[] {
        return this.statements.filter((statement) => statement.sql.includes(fragment));
    }

    private async dispatch(
        kind: 'query' | 'execute',
        connId: number,
        sqlText: string,
        params: readonly unknown[],
    ): Promise<unknown> {
        const sql = norm(sqlText);
        this.statements.push({ connId, kind, sql, params: [...params] });
        if (this.failure && sql.includes(this.failure.fragment)) {
            const error = new Error(`Injected ${this.failure.code}`) as Error & { code: string; errno: number };
            error.code = this.failure.code;
            error.errno = 0;
            throw error;
        }
        const result = this.handle(kind, sql, params);
        return result;
    }

    private handle(kind: 'query' | 'execute', sql: string, params: readonly unknown[]): unknown {
        const s = this.state;
        const execute = (affectedRows = 1, insertId = 0) => ({ affectedRows, insertId });
        const rows = (value: unknown[]) => value;
        const missing = (): never => {
            const error = new Error('Table is missing') as Error & { code: string; errno: number };
            error.code = 'ER_NO_SUCH_TABLE';
            error.errno = 1146;
            throw error;
        };

        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
            return rows([...s.presentTables].map((table) => ({ TABLE_NAME: table })));
        }
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
            return rows([...s.presentColumns].map((entry) => {
                const [table, column] = entry.split('.');
                return { TABLE_NAME: table, COLUMN_NAME: column };
            }));
        }
        if (s.sourceUnavailable && (sql.includes('FROM students s') || sql.includes('lesson_completions'))) {
            return missing();
        }

        /* --- readiness/authority reads ---------------------------------- */
        if (sql.includes("SELECT 'owner' AS authority")) {
            const [tenantId, ownerId, memberId, memberTenantId] = params.map(String);
            if (s.tenants.some((tenant) => tenant.id === tenantId
                && tenant.owner_user_id === ownerId && tenant.status === 'active')) {
                return rows([{ authority: 'owner' }]);
            }
            const membership = s.memberships.find((row) => row.user_id === memberId
                && row.tenant_id === memberTenantId && row.status === 'active');
            return membership ? rows([{ authority: membership.role_key }]) : [];
        }
        if (sql.includes('FROM exams e INNER JOIN courses c') && sql.includes('WHERE e.id = ?')) {
            const exam = s.exams.find((row) => row.id === params[0]);
            const course = exam ? s.courses.find((row) => row.id === exam.course_id) : null;
            return course ? rows([{ id: course.id, tenant_id: course.tenant_id, instructor_id: course.instructor_id }]) : [];
        }
        if (sql.includes('SELECT e.id FROM exams e INNER JOIN courses c') && sql.includes('WHERE c.tenant_id = ?')) {
            const ids = s.exams
                .filter((exam) => s.courses.some((course) => course.id === exam.course_id && course.tenant_id === params[0]))
                .map((exam) => ({ id: exam.id }));
            return rows(ids);
        }
        if (sql.includes('SELECT DISTINCT e.id FROM exams e')) {
            const ids = new Set<string>();
            for (const exam of s.exams) {
                const course = s.courses.find((row) => row.id === exam.course_id && row.tenant_id === params[0]);
                if (!course) continue;
                const group = s.groups.find((row) => row.course_id === course.id
                    && (row.instructor_id === params[1] || course.instructor_id === params[1]));
                if (course.instructor_id === params[1] || group) ids.add(String(exam.id));
            }
            return rows([...ids].map((id) => ({ id })));
        }
        if (sql.includes('SELECT g.id FROM `groups` g INNER JOIN courses c')) {
            const group = s.groups.find((row) => row.course_id === params[0] && row.instructor_id === params[1]
                && s.courses.some((course) => course.id === row.course_id && course.tenant_id === params[2]));
            return group ? rows([{ id: group.id }]) : [];
        }
        if (sql.includes("branch_scope='branch'")) {
            const group = s.groups.find((row) => row.course_id === params[0] && row.branch_id === params[1]
                && row.branch_scope === 'branch');
            return group ? rows([{ id: group.id }]) : [];
        }
        if (sql.includes('FROM branches WHERE id = ?')) {
            const branch = s.branches.find((row) => row.id === params[0]);
            return branch ? rows([branch]) : [];
        }
        if (sql.includes('FROM branch_memberships WHERE branch_id = ? AND user_id = ?')) {
            const membership = s.branchMemberships.find((row) => row.branch_id === params[0] && row.user_id === params[1]);
            return membership ? rows([membership]) : [];
        }
        if (sql.includes('SELECT id, tenant_id, instructor_id FROM courses WHERE id=?')) {
            const course = s.courses.find((row) => row.id === params[0]);
            return course ? rows([{ id: course.id, tenant_id: course.tenant_id, instructor_id: course.instructor_id }]) : [];
        }
        if (sql.includes('SELECT s.id, s.tenant_id, s.instructor_id, s.group_id')) {
            const student = s.students.find((row) => row.id === params[1] && row.tenant_id === params[2]);
            if (!student) return [];
            const group = s.groups.find((row) => row.id === student.group_id);
            const active = s.studentCourses.some((row) => row.student_id === student.id
                && row.course_id === params[0] && row.status === 'active');
            return rows([{
                id: student.id,
                tenant_id: student.tenant_id,
                instructor_id: student.instructor_id,
                group_id: student.group_id,
                group_course_id: group?.course_id ?? null,
                group_instructor_id: group?.instructor_id ?? null,
                active_course: active ? 1 : 0,
            }]);
        }
        if (sql.includes('SELECT id FROM courses WHERE tenant_id=?')) {
            return rows(s.courses.filter((row) => row.tenant_id === params[0]).map((row) => ({ id: row.id })));
        }
        if (sql.includes('SELECT DISTINCT c.id FROM courses c')) {
            const ids = s.courses.filter((course) => course.tenant_id === params[0]
                && (course.instructor_id === params[1]
                    || s.groups.some((group) => group.course_id === course.id && group.instructor_id === params[2])))
                .map((course) => ({ id: course.id }));
            return rows(ids);
        }

        /* --- progress report source ------------------------------------- */
        if (sql.includes('SELECT s.id AS student_enrollment_id')) {
            const records: Array<Record<string, unknown>> = [];
            for (const student of s.students) {
                if (student.tenant_id !== params[0]) continue;
                const group = s.groups.find((row) => row.id === student.group_id);
                for (const course of s.courses) {
                    if (course.tenant_id !== params[0]) continue;
                    records.push({
                        student_enrollment_id: student.id,
                        course_id: course.id,
                        course_name: course.name ?? 'Course',
                        branch_id: group?.branch_id ?? null,
                        total_lessons: 4,
                        completed_lessons: s.incompleteCount ? 'not-a-count' : 2,
                    });
                }
            }
            return rows(records);
        }
        if (sql.includes('FROM gradebook_scores')) {
            return rows(s.gradebookScores);
        }

        /* --- publication store ------------------------------------------ */
        if (sql.includes('FROM progress_report_publications')) {
            if (params.length >= 3) {
                const found = s.publications.find((row) => row.tenant_id === params[0]
                    && row.student_enrollment_id === params[1] && row.course_id === params[2]);
                return found ? rows([found]) : [];
            }
            const courseId = typeof params[1] === 'string' ? params[1] : null;
            return rows(s.publications.filter((row) => row.tenant_id === params[0]
                && (courseId === null || row.course_id === courseId)));
        }
        if (sql.startsWith('UPDATE progress_report_publications SET state')) {
            const [nextState, publishedBy, publishedAt, tenantId, enrollmentId, courseId, expectedVersion] = params;
            const found = s.publications.find((row) => row.tenant_id === tenantId
                && row.student_enrollment_id === enrollmentId && row.course_id === courseId
                && Number(row.version) === Number(expectedVersion));
            if (!found) return execute(0);
            found.state = nextState;
            found.published_by = publishedBy;
            found.published_at = publishedAt;
            found.version = Number(found.version) + 1;
            return execute(1);
        }
        if (sql.startsWith('INSERT INTO progress_report_publications')) {
            const [id, tenantId, enrollmentId, courseId, state, publishedBy, publishedAt] = params;
            s.publications.push({
                id,
                tenant_id: tenantId,
                student_enrollment_id: enrollmentId,
                course_id: courseId,
                state,
                published_by: publishedBy,
                published_at: publishedAt,
                version: 1,
            });
            return execute(1);
        }

        /* --- exam manual grading ---------------------------------------- */
        if (sql.startsWith('UPDATE exam_versioned_attempts SET version = version + 1')) {
            const [attemptId, tenantId, expectedStatus, expectedVersion] = params;
            const attempt = s.attempts.find((row) => row.id === attemptId && row.tenant_id === tenantId);
            if (!attempt || attempt.status !== expectedStatus || Number(attempt.version) !== Number(expectedVersion)) {
                return execute(0);
            }
            attempt.version = Number(attempt.version) + 1;
            return execute(1);
        }
        if (sql.startsWith("UPDATE exam_versioned_attempts SET status = 'graded'")) {
            const [score, passed, reviewer, gradedAt, attemptId, tenantId, expectedStatus, expectedVersion] = params;
            const attempt = s.attempts.find((row) => row.id === attemptId && row.tenant_id === tenantId);
            if (!attempt || attempt.status !== expectedStatus || Number(attempt.version) !== Number(expectedVersion)) {
                return execute(0);
            }
            attempt.status = 'graded';
            attempt.score = score;
            attempt.passed = passed;
            attempt.reviewer_user_id = reviewer;
            attempt.graded_at = gradedAt;
            attempt.version = Number(attempt.version) + 1;
            return execute(1);
        }
        if (sql.startsWith('INSERT INTO exam_manual_answer_revisions')) {
            const [id, tenantId, attemptId, questionRef, revision, awardedHundredths, reviewer, feedback, createdAt] = params;
            s.revisions.push({
                id,
                tenant_id: tenantId,
                attempt_id: attemptId,
                question_ref: questionRef,
                revision,
                awarded_hundredths: awardedHundredths,
                reviewer_user_id: reviewer,
                feedback,
                created_at: createdAt,
            });
            return execute(1);
        }
        if (sql.includes("a.status = 'pending_review'") && sql.includes('a.exam_id IN')) {
            const tenantId = String(params[0]);
            const limit = Number(params[params.length - 1]);
            const examIds = params.slice(1, -1).map(String);
            return rows(s.attempts.filter((row) => row.tenant_id === tenantId
                && row.status === 'pending_review'
                && examIds.includes(String(row.exam_id))).slice(0, limit));
        }
        if (sql.includes('FROM exam_versioned_attempts a')) {
            const attempt = s.attempts.find((row) => row.id === params[0] && row.tenant_id === params[1]);
            return attempt ? rows([attempt]) : [];
        }
        if (sql.includes('FROM exam_version_questions')) {
            return rows(s.questions.filter((row) => row.tenant_id === params[0] && row.exam_version_id === params[1]));
        }
        if (sql.includes('FROM exam_versioned_answers')) {
            return rows(s.answers.filter((row) => row.tenant_id === params[0] && row.attempt_id === params[1]));
        }
        if (sql.includes('FROM exam_manual_answer_revisions')) {
            return rows(s.revisions.filter((row) => row.tenant_id === params[0] && row.attempt_id === params[1]));
        }
        if (sql.includes('SELECT status, version FROM exam_versioned_attempts')) {
            const attempt = s.attempts.find((row) => row.id === params[0] && row.tenant_id === params[1]);
            return attempt ? rows([{ status: attempt.status, version: attempt.version }]) : [];
        }

        /* --- attendance reports ----------------------------------------- */
        if (sql.includes('FROM attendance_records ar')) {
            return rows(s.attendanceRecords);
        }
        if (sql.includes('SELECT id FROM students WHERE id = ?')) {
            return rows(s.students.filter((row) => row.id === params[0] && row.tenant_id === params[1]).map((row) => ({ id: row.id })));
        }
        if (sql.includes('SELECT id FROM `groups` WHERE id = ?')) {
            return rows(s.groups.filter((row) => row.id === params[0] && row.tenant_id === params[1]).map((row) => ({ id: row.id })));
        }
        if (sql.includes('SELECT id FROM branches WHERE id = ?')) {
            return rows(s.branches.filter((row) => row.id === params[0] && row.tenant_id === params[1]).map((row) => ({ id: row.id })));
        }

        /* --- audit ------------------------------------------------------- */
        if (sql.includes('FROM audit_chain_head') && sql.includes('FOR UPDATE')) {
            return s.auditHead ? rows([s.auditHead]) : [];
        }
        if (sql.startsWith('INSERT INTO audit_chain_head')) {
            if (!s.auditHead) {
                s.auditHead = { head_seq: params[1], head_entry_hash: params[2], head_row_id: params[3] };
            }
            return execute(1);
        }
        if (sql.startsWith('UPDATE audit_chain_head')) {
            if (s.auditHead && Number(s.auditHead.head_seq) === Number(params[4])) {
                s.auditHead.head_seq = params[0];
                s.auditHead.head_entry_hash = params[1];
                s.auditHead.head_row_id = params[2];
                return execute(1);
            }
            return execute(0);
        }
        if (sql.includes('FROM audit_events') && sql.includes('ORDER BY chain_seq DESC')) {
            const sealed = s.auditEvents.filter((row) => row.entry_hash);
            const last = sealed[sealed.length - 1];
            return last ? rows([{ id: last.id, entry_hash: last.entry_hash, chain_seq: last.chain_seq }]) : [];
        }
        if (sql.startsWith('INSERT INTO audit_events') && sql.includes('entry_hash')) {
            s.auditEvents.push({
                id: params[0],
                actor_user_id: params[1],
                tenant_id: params[2],
                action: params[3],
                resource_type: params[4],
                resource_id: params[5],
                old_value: params[6],
                new_value: params[7],
                reason: params[8],
                entry_hash: params[9],
                prev_entry_hash: params[10],
                chain_seq: params[11],
            });
            return execute(1);
        }
        if (sql.startsWith('INSERT INTO audit_events')) {
            s.auditEvents.push({
                id: params[0],
                actor_user_id: params[1],
                tenant_id: params[2],
                action: params[3],
                resource_type: params[4],
                resource_id: params[5],
                old_value: params[6],
                new_value: params[7],
                reason: params[8],
                entry_hash: null,
            });
            return execute(1);
        }

        throw new Error(`Unhandled recording SQL: ${sql}`);
    }
}

/* ------------------------------------------------------------------------- */
/* Minimal response/request harness (no listener)                            */
/* ------------------------------------------------------------------------- */

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    text?: string;
    headers: Record<string, string>;
    settled: boolean;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
    set(header: string, value: string): CapturedResponse;
    send(payload: unknown): CapturedResponse;
    end(): CapturedResponse;
}

const invoke = async (
    router: Router,
    request: { method: string; url: string; body?: unknown; query?: Record<string, string> },
): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        headers: {},
        settled: false,
        status(code: number) {
            response.statusCode = code;
            return response;
        },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            response.settled = true;
            return response;
        },
        set(header: string, value: string) {
            response.headers[header.toLowerCase()] = value;
            return response;
        },
        send(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            if (typeof payload === 'string') response.text = payload;
            else response.body = payload;
            response.settled = true;
            return response;
        },
        end() {
            response.settled = true;
            return response;
        },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    const routerFn = router as unknown as (r: unknown, s: unknown, n: NextFunction) => void;
    routerFn(req, response, () => {
        response.settled = true;
    });
    const deadline = Date.now() + 5000;
    while (!response.settled && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const authAs = (user: Omit<NonNullable<AuthRequest['user']>, 'email' | 'phone'>): RequestHandler =>
    (req, _res, next) => {
        (req as AuthRequest).user = { email: null, phone: null, ...user };
        next();
    };

const rejectingAuth: RequestHandler = (_req, res, _next) => {
    res.status(401).json({ error: 'Authentication required' });
};

const readyProbe: SchemaReadinessProbe = { check: async () => ({ ready: true, missing: [] }) };

const build = (
    db: FakeReportingDb,
    options: { authenticate?: RequestHandler; probe?: SchemaReadinessProbe; auditSink?: (conn: ReportingSqlConnection, input: import('../src/security/audit').AuditRecordInput) => Promise<void> } = {},
) => createSchoolReportingRouters({
    db,
    authenticate: options.authenticate ?? authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1' }),
    schemaProbe: options.probe ?? readyProbe,
    sealedAuditSink: options.auditSink,
    now: () => new Date('2026-10-21T10:00:00.000Z'),
    readinessTtlMs: 60_000,
});

const appFor = (mountPath: string, router: Router): Router => {
    const app = createRouter();
    app.use(mountPath, router);
    return app;
};

const seedGradeFlow = (): FakeReportingDb => {
    const state = baseState();
    state.attempts = [attemptFixture()];
    state.questions = [{
        ref: 'q1',
        tenant_id: 't1',
        exam_version_id: 'v1',
        position: 1,
        question_type: 'essay',
        points: 10,
    }];
    state.answers = [{
        question_ref: 'q1',
        tenant_id: 't1',
        attempt_id: 'a1',
        question_type: 'essay',
        response: 'answer',
        awarded_points: null,
        is_correct: null,
        manual_review: 1,
    }];
    return new FakeReportingDb(state);
};

/* ------------------------------------------------------------------------- */
/* Tests                                                                     */
/* ------------------------------------------------------------------------- */

test('wiring: missing transaction runner or audit writer is rejected before any write', () => {
    const db = new FakeReportingDb();
    assert.throws(() => createSchoolReportingRouters({
        db: { query: db.query.bind(db), queryOne: db.queryOne.bind(db) } as unknown as ReportingDatabase,
        authenticate: rejectingAuth,
        schemaProbe: readyProbe,
    }), /transaction runner/);
    assert.throws(() => createSchoolReportingRouters({
        db,
        authenticate: rejectingAuth,
        sealedAuditSink: null as unknown as (conn: ReportingSqlConnection, input: import('../src/security/audit').AuditRecordInput) => Promise<void>,
    }), /sealed audit writer/);
    assert.equal(db.statements.length, 0);

    assert.throws(() => createExamManualGradingSqlStore({
        transaction: db.transaction,
    } as unknown as Parameters<typeof createExamManualGradingSqlStore>[0]), /sealed connection-bound audit writer/);
    assert.throws(() => createExamManualGradingSqlStore({
        audit: async () => undefined,
    } as unknown as Parameters<typeof createExamManualGradingSqlStore>[0]), /connection-bound transaction runner/);
    assert.equal(db.statements.length, 0);
});

test('readiness probe: not evaluated at construction, cached for the short TTL', async () => {
    let clock = 1000;
    let tableReads = 0;
    const readAccess = {
        query: async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
            if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
                tableReads += 1;
                return REPORTING_REQUIRED_TABLES.map((table) => ({ TABLE_NAME: table })) as unknown as T[];
            }
            return REPORTING_REQUIRED_COLUMNS.map((entry) => ({
                TABLE_NAME: entry.table,
                COLUMN_NAME: entry.column,
            })) as unknown as T[];
        },
        queryOne: async <T = Record<string, unknown>>(): Promise<T | null> => null,
    };
    const probe = createInformationSchemaReadinessProbe(readAccess, { ttlMs: 5000, now: () => clock });
    assert.equal(tableReads, 0);
    assert.equal((await probe.check()).ready, true);
    assert.equal(tableReads, 1);
    clock += 1000;
    assert.equal((await probe.check()).ready, true);
    assert.equal(tableReads, 1);
    clock += 6000;
    assert.equal((await probe.check()).ready, true);
    assert.equal(tableReads, 2);
});

test('anonymous callers get 401 on every reporting surface with zero datastore access', async () => {
    const db = new FakeReportingDb();
    const routers = build(db, { authenticate: rejectingAuth });
    for (const [mountPath, router] of [
        ['/api/exam-manual-grading', routers.examManualGrading],
        ['/api/progress-reports', routers.progressReports],
        ['/api/attendance-reports', routers.attendanceReports],
    ] as const) {
        const response = await invoke(appFor(mountPath, router), { method: 'GET', url: mountPath });
        assert.equal(response.statusCode, 401, mountPath);
        assert.equal(response.body && (response.body as { error?: string }).error, 'Authentication required');
    }
    assert.equal(db.statements.length, 0);
});

test('readiness: a missing required table answers 503 before any data read, write or audit', async () => {
    const db = new FakeReportingDb();
    db.state.presentTables.delete('exam_manual_answer_revisions');
    const routers = createSchoolReportingRouters({
        db,
        authenticate: authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1' }),
        now: () => new Date('2026-10-21T10:00:00.000Z'),
    });
    const response = await invoke(appFor('/api/exam-manual-grading', routers.examManualGrading), {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/answers/q1/grade',
        body: { points: 5 },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Reporting is temporarily unavailable' });
    assert.equal(db.writeStatements().length, 0);
    assert.equal(db.statements.filter((s) => !s.sql.includes('INFORMATION_SCHEMA')).length, 0);
    assert.equal(db.state.auditEvents.length, 0);
});

test('readiness: a probe failure answers 503 with no datastore access', async () => {
    const db = new FakeReportingDb();
    const routers = build(db, {
        probe: { check: async () => { throw new Error('probe failed'); } },
    });
    const response = await invoke(appFor('/api/progress-reports', routers.progressReports), {
        method: 'GET',
        url: '/api/progress-reports',
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Reporting is temporarily unavailable' });
    assert.equal(db.statements.length, 0);
});

test('readiness: construction and import issue no INFORMATION_SCHEMA or data query', () => {
    const db = new FakeReportingDb();
    createSchoolReportingRouters({
        db,
        authenticate: rejectingAuth,
        now: () => new Date('2026-10-21T10:00:00.000Z'),
        readinessTtlMs: 60_000,
    });
    assert.equal(db.statements.length, 0);
    assert.equal(db.commits, 0);
});

test('readiness: tables present but a required column missing answers 503 before data/write/audit', async () => {
    const db = new FakeReportingDb();
    db.state.presentColumns.delete('exam_versioned_attempts.reviewer_user_id');
    const routers = createSchoolReportingRouters({
        db,
        authenticate: authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1' }),
        now: () => new Date('2026-10-21T10:00:00.000Z'),
        readinessTtlMs: 60_000,
    });
    const response = await invoke(appFor('/api/exam-manual-grading', routers.examManualGrading), {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/answers/q1/grade',
        body: { points: 5 },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Reporting is temporarily unavailable' });
    assert.equal(db.writeStatements().length, 0);
    assert.equal(db.statements.filter((statement) => !statement.sql.includes('INFORMATION_SCHEMA')).length, 0);
    assert.equal(db.state.auditEvents.length, 0);
});

test('readiness: all required tables and columns present lets the real request flow', async () => {
    const db = new FakeReportingDb();
    const routers = createSchoolReportingRouters({
        db,
        authenticate: authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1' }),
        now: () => new Date('2026-10-21T10:00:00.000Z'),
        readinessTtlMs: 60_000,
    });
    const response = await invoke(appFor('/api/progress-reports', routers.progressReports), {
        method: 'GET',
        url: '/api/progress-reports',
        query: { course_id: 'c1' },
    });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.ok(db.statements.some((statement) => statement.sql.includes('INFORMATION_SCHEMA.COLUMNS')));
});

test('request-time schema errors: known codes become a generic 503, unknown codes stay a generic 500', async () => {
    for (const [code, expectedStatus] of [
        ['ER_NO_SUCH_TABLE', 503],
        ['ER_BAD_FIELD_ERROR', 503],
        ['ER_BAD_TABLE_ERROR', 503],
        ['ER_LOCK_WAIT_TIMEOUT', 500],
    ] as const) {
        const db = new FakeReportingDb();
        db.failure = { code, fragment: 'FROM attendance_records' };
        const routers = build(db);
        const response = await invoke(appFor('/api/attendance-reports', routers.attendanceReports), {
            method: 'GET',
            url: '/api/attendance-reports/summary',
            query: { from: '2026-05-01', to: '2026-05-31' },
        });
        assert.equal(response.statusCode, expectedStatus, code);
        if (expectedStatus === 503) {
            assert.deepEqual(response.body, { error: 'Reporting is temporarily unavailable' }, code);
        } else {
            assert.deepEqual(response.body, { error: 'Failed to build attendance report' }, code);
        }
        assert.equal(db.writeStatements().length, 0, code);
        assert.equal(db.state.auditEvents.length, 0, code);
    }
});

test('owner answer grade: real router + adapter writes exactly one sealed audit on the transaction connection', async () => {
    const db = seedGradeFlow();
    const routers = build(db);
    const response = await invoke(appFor('/api/exam-manual-grading', routers.examManualGrading), {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/answers/q1/grade',
        body: { points: 5 },
    });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(db.state.revisions.length, 1);
    assert.equal(db.state.auditEvents.length, 1);
    assert.equal(db.state.auditEvents[0].action, 'exam_manual_grade.answer');
    assert.equal(Number(db.state.attempts[0].version), 4);

    const mutation = db.statementsFor('UPDATE exam_versioned_attempts SET version = version + 1');
    const audit = db.auditInserts();
    assert.equal(mutation.length, 1);
    assert.equal(audit.length, 1);
    assert.equal(mutation[0].connId, audit[0].connId);
    assert.notEqual(mutation[0].connId, 0);
});

test('unrelated teacher is denied on manual grading and nothing is written', async () => {
    const db = seedGradeFlow();
    db.state.tenants = [{ id: 't1', owner_user_id: 'owner-x', status: 'active' }];
    db.state.courses = [{ id: 'c1', tenant_id: 't1', instructor_id: 'other-teacher', is_active: 1, name: 'Math' }];
    const routers = build(db, { authenticate: authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1' }) });
    const response = await invoke(appFor('/api/exam-manual-grading', routers.examManualGrading), {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/answers/q1/grade',
        body: { points: 5 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(db.writeStatements().length, 0);
    assert.equal(db.state.auditEvents.length, 0);
});

test('manual grading authority: a verified branch member with no teaching assignment is never granted by branch membership', async () => {
    const db = seedGradeFlow();
    db.state.tenants = [{ id: 't1', owner_user_id: 'owner-x', status: 'active' }];
    db.state.memberships = [{ user_id: 'teacher1', tenant_id: 't1', status: 'active', role_key: 'instructor' }];
    db.state.courses = [{ id: 'c1', tenant_id: 't1', instructor_id: 'other-teacher', is_active: 1, name: 'Math' }];
    db.state.groups = [{
        id: 'g1',
        course_id: 'c1',
        instructor_id: 'other-teacher',
        branch_id: 'b1',
        branch_scope: 'branch',
    }];
    db.state.branches = [{ id: 'b1', tenant_id: 't1', status: 'active', version: 1 }];
    db.state.branchMemberships = [{
        id: 'bm1',
        branch_id: 'b1',
        user_id: 'teacher1',
        role: 'instructor',
        status: 'active',
        version: 1,
    }];
    const routers = build(db, {
        authenticate: authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1', branchId: 'b1' }),
    });
    const app = appFor('/api/exam-manual-grading', routers.examManualGrading);

    const pending = await invoke(app, { method: 'GET', url: '/api/exam-manual-grading/pending' });
    assert.equal(pending.statusCode, 200);
    assert.equal((pending.body as { count: number }).count, 0, 'pending list reveals nothing');

    const detail = await invoke(app, { method: 'GET', url: '/api/exam-manual-grading/attempts/a1' });
    assert.equal(detail.statusCode, 403);

    const grade = await invoke(app, {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/answers/q1/grade',
        body: { points: 5 },
    });
    assert.equal(grade.statusCode, 403);

    const finalize = await invoke(app, {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/finalize',
    });
    assert.equal(finalize.statusCode, 403);

    assert.equal(db.writeStatements().length, 0, 'no grading/finalize write');
    assert.equal(db.state.auditEvents.length, 0, 'no audit');
    assert.equal(db.statements.some((statement) => statement.sql.includes('branch_memberships')), false);
    assert.equal(db.statements.some((statement) => statement.sql.includes("branch_scope='branch'")), false);
});

const seedAuthorityState = (kind: 'owner' | 'course' | 'group'): FakeReportingDb => {
    const db = seedGradeFlow();
    db.state.tenants = [{ id: 't1', owner_user_id: kind === 'owner' ? 'teacher1' : 'owner-x', status: 'active' }];
    db.state.memberships = kind === 'owner'
        ? []
        : [{ user_id: 'teacher1', tenant_id: 't1', status: 'active', role_key: 'instructor' }];
    db.state.courses = [{
        id: 'c1',
        tenant_id: 't1',
        instructor_id: kind === 'course' ? 'teacher1' : 'other-teacher',
        is_active: 1,
        name: 'Math',
    }];
    db.state.groups = kind === 'group'
        // The caller teaches a DIFFERENT group of the same course.
        ? [
            { id: 'g1', course_id: 'c1', instructor_id: 'other-teacher', branch_id: null, branch_scope: 'tenant' },
            { id: 'g2', course_id: 'c1', instructor_id: 'teacher1', branch_id: null, branch_scope: 'tenant' },
        ]
        : [{ id: 'g1', course_id: 'c1', instructor_id: 'other-teacher', branch_id: null, branch_scope: 'tenant' }];
    db.state.revisions = [{
        id: 'r1',
        tenant_id: 't1',
        attempt_id: 'a1',
        question_ref: 'q1',
        revision: 1,
        awarded_hundredths: 500,
        reviewer_user_id: 'teacher1',
        feedback: null,
        created_at: '2026-10-21T09:30:00.000Z',
    }];
    return db;
};

test('manual grading authority: owner, course instructor and group instructor stay positive for read, grade and finalize', async () => {
    for (const kind of ['owner', 'course', 'group'] as const) {
        const db = seedAuthorityState(kind);
        const routers = build(db, {
            authenticate: authAs({ id: 'teacher1', role: 'teacher', tenantId: 't1' }),
        });
        const app = appFor('/api/exam-manual-grading', routers.examManualGrading);

        const pending = await invoke(app, { method: 'GET', url: '/api/exam-manual-grading/pending' });
        assert.equal(pending.statusCode, 200, kind);
        assert.equal((pending.body as { count: number }).count, 1, `${kind}: pending queue`);

        const detail = await invoke(app, { method: 'GET', url: '/api/exam-manual-grading/attempts/a1' });
        assert.equal(detail.statusCode, 200, `${kind}: attempt detail`);

        const grade = await invoke(app, {
            method: 'POST',
            url: '/api/exam-manual-grading/attempts/a1/answers/q1/grade',
            body: { points: 5 },
        });
        assert.equal(grade.statusCode, 200, `${kind}: grade`);

        const finalize = await invoke(app, {
            method: 'POST',
            url: '/api/exam-manual-grading/attempts/a1/finalize',
        });
        assert.equal(finalize.statusCode, 200, `${kind}: finalize`);
        assert.equal(db.state.auditEvents.length, 2, `${kind}: one audit per mutation`);
    }
});

test('audit failure on finalize rolls the state change back and returns a generic error', async () => {
    const db = seedGradeFlow();
    db.state.revisions = [{
        id: 'r1',
        tenant_id: 't1',
        attempt_id: 'a1',
        question_ref: 'q1',
        revision: 1,
        awarded_hundredths: 500,
        reviewer_user_id: 'teacher1',
        feedback: null,
        created_at: '2026-10-21T09:30:00.000Z',
    }];
    db.state.auditHead = {
        head_seq: 4,
        head_entry_hash: 'head-hash',
        head_row_id: 'head-row',
    };
    const routers = build(db, {
        auditSink: async () => { throw new Error('audit down'); },
    });
    const response = await invoke(appFor('/api/exam-manual-grading', routers.examManualGrading), {
        method: 'POST',
        url: '/api/exam-manual-grading/attempts/a1/finalize',
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'Failed to finalize attempt' });
    assert.equal(db.state.attempts[0].status, 'pending_review');
    assert.equal(Number(db.state.attempts[0].version), 3);
    assert.equal(db.state.auditEvents.length, 0);
    assert.equal(db.rollbacks, 1);
});

test('publish and unpublish each write exactly one sealed audit on the same connection', async () => {
    const db = new FakeReportingDb();
    const routers = build(db);
    const app = appFor('/api/progress-reports', routers.progressReports);

    const published = await invoke(app, {
        method: 'POST',
        url: '/api/progress-reports/publish',
        body: { student_enrollment_id: 's1', course_id: 'c1' },
    });
    assert.equal(published.statusCode, 200, JSON.stringify(published.body));
    assert.equal(db.state.publications.length, 1);
    assert.equal(db.state.auditEvents.length, 1);
    assert.equal(db.state.auditEvents[0].action, 'progress_report.publish');

    const unpublished = await invoke(app, {
        method: 'POST',
        url: '/api/progress-reports/unpublish',
        body: { student_enrollment_id: 's1', course_id: 'c1' },
    });
    assert.equal(unpublished.statusCode, 200, JSON.stringify(unpublished.body));
    assert.equal(db.state.publications[0].state, 'draft');
    assert.equal(db.state.auditEvents.length, 2);
    assert.equal(db.state.auditEvents[1].action, 'progress_report.unpublish');

    const publicationWrites = db.statements.filter((statement) => statement.kind === 'execute'
        && /INSERT INTO progress_report_publications|UPDATE progress_report_publications/.test(statement.sql));
    const audits = db.auditInserts();
    // Publish tries the CAS first (0 rows) then inserts; unpublish updates.
    assert.equal(publicationWrites.length, 3);
    assert.equal(audits.length, 2);
    const writeConnections = new Set(publicationWrites.map((statement) => statement.connId));
    for (const audit of audits) {
        assert.notEqual(audit.connId, 0);
        assert.ok(writeConnections.has(audit.connId), 'audit row must share the transition connection');
    }
    assert.equal(db.state.auditEvents.length, 2);
});

test('progress export writes exactly one sealed audit on the transaction connection', async () => {
    const db = new FakeReportingDb();
    const routers = build(db);
    const response = await invoke(appFor('/api/progress-reports', routers.progressReports), {
        method: 'GET',
        url: '/api/progress-reports/export.csv',
        query: { course_id: 'c1' },
    });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.ok(response.text?.startsWith('student_enrollment_id,course_id'));
    assert.equal(db.state.auditEvents.length, 1);
    assert.equal(db.state.auditEvents[0].action, 'progress_report.export');
    const audits = db.auditInserts();
    assert.equal(audits.length, 1);
    assert.notEqual(audits[0].connId, 0);
});

test('attendance export writes exactly one sealed audit on one transaction connection before the CSV', async () => {
    const db = new FakeReportingDb();
    const routers = build(db);
    const response = await invoke(appFor('/api/attendance-reports', routers.attendanceReports), {
        method: 'GET',
        url: '/api/attendance-reports/export.csv',
        query: { from: '2026-05-01', to: '2026-05-31' },
    });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.ok(response.text?.startsWith('student_id,group_id'));
    assert.equal(db.state.auditEvents.length, 1);
    assert.equal(db.state.auditEvents[0].action, 'attendance_report.export');
    const audits = db.auditInserts();
    assert.equal(audits.length, 1, 'exactly one sealed audit INSERT');
    assert.ok(audits[0].sql.includes('entry_hash'));
    const sealStatements = db.statements.filter((statement) =>
        statement.sql.includes('audit_chain_head') || statement.sql.includes('INSERT INTO audit_events'));
    assert.ok(sealStatements.length >= 2);
    const sealConnections = new Set(sealStatements.map((statement) => statement.connId));
    assert.equal(sealConnections.size, 1);
    assert.equal(sealConnections.has(0), false, 'sealed append is not on the pooled read connection');
    assert.equal(db.statements.some((statement) => statement.sql.startsWith('INSERT INTO audit_events')
        && !statement.sql.includes('entry_hash')), false, 'no plain audit INSERT');
});

test('attendance export audit failure returns a generic error with no CSV bytes, no audit and a rollback', async () => {
    const db = new FakeReportingDb();
    const routers = build(db, {
        auditSink: async () => { throw new Error('audit down'); },
    });
    const response = await invoke(appFor('/api/attendance-reports', routers.attendanceReports), {
        method: 'GET',
        url: '/api/attendance-reports/export.csv',
        query: { from: '2026-05-01', to: '2026-05-31' },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'Failed to export attendance report' });
    assert.equal(response.text, undefined);
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(db.state.auditEvents.length, 0);
    assert.ok(db.rollbacks >= 1);
});

test('unavailable source makes the list return 503 with no data and no audit', async () => {
    const db = new FakeReportingDb();
    db.state.sourceUnavailable = true;
    const routers = build(db);
    const response = await invoke(appFor('/api/progress-reports', routers.progressReports), {
        method: 'GET',
        url: '/api/progress-reports',
        query: { course_id: 'c1' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Progress reports are temporarily unavailable' });
    assert.equal(db.state.auditEvents.length, 0);
    assert.equal(db.writeStatements().length, 0);
});

test('incomplete source makes the CSV export return 503 with no CSV bytes and no audit', async () => {
    const db = new FakeReportingDb();
    db.state.incompleteCount = true;
    const routers = build(db);
    const response = await invoke(appFor('/api/progress-reports', routers.progressReports), {
        method: 'GET',
        url: '/api/progress-reports/export.csv',
        query: { course_id: 'c1' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'Progress reports are temporarily unavailable' });
    assert.equal(response.text, undefined);
    assert.equal(response.headers['content-type'], undefined);
    assert.equal(db.state.auditEvents.length, 0);
    assert.equal(db.writeStatements().length, 0);
});

test('manifest: B2-C migration hashes equal the on-disk source hashes', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'server/bootstrap/m1/manifest.json'), 'utf8')) as {
        sourceSha256: Record<string, string>;
    };
    for (const name of ['20261021_01_exam_manual_publication.sql', '20261021_02_internal_financial_ledger.sql']) {
        const disk = createHash('sha256').update(readFileSync(path.join(repoRoot, 'server/migrations', name))).digest('hex');
        assert.equal(manifest.sourceSha256[name], disk, name);
    }
});

test('index: each reporting path is mounted once behind the guard chain with the CORS expose header', () => {
    const source = readFileSync(path.join(repoRoot, 'server/src/index.ts'), 'utf8');
    const guard = source.indexOf("app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary)");
    const terminal404 = source.indexOf('// 404 handler');
    assert.ok(guard > 0);
    assert.ok(terminal404 > guard);

    const mounts = [
        ["app.use('/api/exam-manual-grading', schoolReportingRouters.examManualGrading)", '/api/exam-manual-grading'],
        ["app.use('/api/progress-reports', schoolReportingRouters.progressReports)", '/api/progress-reports'],
        ["app.use('/api/attendance-reports', schoolReportingRouters.attendanceReports)", '/api/attendance-reports'],
    ] as const;
    for (const [statement, mountPath] of mounts) {
        assert.equal(source.split(statement).length - 1, 1, `${mountPath} must be mounted once`);
        const at = source.indexOf(statement);
        assert.ok(at > guard, `${mountPath} must follow the /api guard chain`);
        assert.ok(at < terminal404, `${mountPath} must precede the 404 handler`);
    }
    assert.equal(source.split('createSchoolReportingRouters({').length - 1, 1);
    assert.doesNotMatch(source, /app\.use\(['"]\/api\/certificates/);
    assert.match(source, /intentionally NOT mounted/);

    const corsBlock = source.slice(source.indexOf('app.use(cors({'), source.indexOf('}));', source.indexOf('app.use(cors({')));
    assert.match(corsBlock, /exposedHeaders:\s*\['X-Results-Truncated'\]/);
    assert.match(corsBlock, /credentials:\s*true/);
    assert.match(corsBlock, /origin:\s*\(origin, callback\)/);
    assert.match(corsBlock, /isAllowedCorsOrigin\(origin, process\.env\.CORS_ORIGIN, process\.env\.VERCEL_URL\)/);
});

test('index: the new mount paths collide with no existing /api mount (segment-aware)', () => {
    const source = readFileSync(path.join(repoRoot, 'server/src/index.ts'), 'utf8');
    const mountRe = /app\.use\(\s*'(\/api[^']*)'\s*,\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/g;
    const paths: string[] = [];
    for (const match of source.matchAll(mountRe)) paths.push(match[1]);
    const segments = (value: string): string[] => value.split('/').filter(Boolean);
    const isPrefix = (a: string[], b: string[]): boolean =>
        a.length < b.length && a.every((segment, index) => segment === b[index]);
    for (const mountPath of ['/api/exam-manual-grading', '/api/progress-reports', '/api/attendance-reports']) {
        assert.ok(paths.includes(mountPath), `${mountPath} parsed as a mount`);
        for (const other of paths) {
            if (other === mountPath) continue;
            const left = segments(mountPath);
            const right = segments(other);
            assert.ok(!isPrefix(left, right), `${mountPath} would shadow ${other}`);
            assert.ok(!isPrefix(right, left), `${other} would shadow ${mountPath}`);
        }
    }
    assert.equal(paths.filter((value) => value === '/api/exam-manual-grading').length, 1);
    assert.equal(paths.filter((value) => value === '/api/progress-reports').length, 1);
    assert.equal(paths.filter((value) => value === '/api/attendance-reports').length, 1);
});
