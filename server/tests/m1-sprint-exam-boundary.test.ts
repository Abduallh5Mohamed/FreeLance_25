import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Response } from 'express';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import { createExamRouter, ExamDataAccess } from '../src/routes/exams';
import { createExamResultsRouter } from '../src/routes/exam-results';
import { createManualGradingRouter } from '../src/routes/manual-grading';

/**
 * M1 exam / exam-results / manual-grading boundary regression suite
 * (behavioral, hermetic).
 *
 * Drives the production routers (`createExamRouter`,
 * `createExamResultsRouter`, `createManualGradingRouter`) through injected
 * seams: a fixture-backed SQL adapter, the REAL authentication middleware
 * (`createAuthenticateToken` / `createOptionalAuth`) over an injected
 * principal repository, and a stand-in for the teaching-entitlement guard.
 * No database, network, Docker, or real service is contacted; the MySQL pool
 * in src/db.ts is never created because no production query runs.
 *
 * Evidence classes, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, denied
 *    side effects such as absent INSERT/UPDATE, rows returned to the caller);
 *  - decision-boundary (SQL text + params of the executed query): scoping that
 *    production delegates to MySQL WHERE clauses is asserted as the exact SQL
 *    and bindings the real handler executed.
 *
 * Scope note: the teaching-entitlement gate itself lives in
 * middleware/teaching-access.ts, outside this task's allowedPaths. The
 * injected guard replicates only its documented authentication precondition
 * (no resolved principal -> 401); subscription/staff-page entitlement checks
 * are not exercised here and are called out as a limit.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

// The production handlers log verbosely on every request; that stdout volume
// desynchronizes the Node test-runner IPC channel, so it is silenced here
// (and restored afterwards). This does not affect any handler behavior under
// test: assertions read status codes, bodies and executed SQL, never logs.
const originalConsole = { log: console.log, error: console.error, warn: console.warn };

const originalSecret = process.env.JWT_SECRET;
before(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
});
after(() => {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants, one instructor group each, one exam each.
// ---------------------------------------------------------------------------

interface UserRow { is_active: number; token_version: number; suspension_active: number; phone: string | null; name: string }
interface GroupRow { id: string; instructor_id: string; name: string }
interface ExamRow { id: string; title: string; total_marks: number; passing_marks: number; course_id: string; duration_minutes: number; start_time: string | null; end_time: string | null; grade_id: string | null }
interface QuestionRow { id: string; exam_id: string; question_type: string; correct_answer: string | null; points: number }
interface AttemptRow { id: string; exam_id: string; student_id: string; status: string; score: number; started_at: string; answers: string | null; essay_scores: string | null }
interface EnrollmentRow { id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }

interface Fixtures {
    users: Record<string, UserRow>;
    staff: Record<string, { is_active: number }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    enrollments: Record<string, EnrollmentRow[]>;
    studentsById: Record<string, { id: string; phone: string; group_id: string; grade_id: string; name: string }>;
    studentsByPhone: Record<string, string>;
    groups: Record<string, GroupRow>;
    exams: Record<string, ExamRow>;
    examGroups: Array<{ exam_id: string; group_id: string }>;
    examQuestions: Record<string, QuestionRow[]>;
    examAttempts: Record<string, AttemptRow>; // key: `${examId}:${studentId}`
    examResults: Record<string, Record<string, unknown>>;
}

const attemptKey = (examId: string, studentId: string) => `${examId}:${studentId}`;

const makeFixtures = (): Fixtures => ({
    users: {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, phone: null, name: 'Instructor A' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, phone: null, name: 'Instructor B' },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000001', name: 'Student A' },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000002', name: 'Student B' },
        'revoked': { is_active: 0, token_version: 0, suspension_active: 0, phone: null, name: 'Revoked' },
    },
    staff: {},
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    memberships: {
        'instructor-a': [{ tenant_id: 'tenant-a' }],
        'instructor-b': [{ tenant_id: 'tenant-b' }],
    },
    enrollments: {
        'student-a': [{ id: 'enrollment-a', user_id: 'student-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a' }],
        'student-b': [{ id: 'enrollment-b', user_id: 'student-b', tenant_id: 'tenant-b', instructor_id: 'instructor-b', group_id: 'group-b', grade_id: 'grade-b' }],
    },
    studentsById: {
        'enrollment-a': { id: 'enrollment-a', phone: '0100000001', group_id: 'group-a', grade_id: 'grade-a', name: 'Student A' },
        'enrollment-b': { id: 'enrollment-b', phone: '0100000002', group_id: 'group-b', grade_id: 'grade-b', name: 'Student B' },
    },
    studentsByPhone: { '0100000001': 'enrollment-a', '0100000002': 'enrollment-b' },
    groups: {
        'group-a': { id: 'group-a', instructor_id: 'instructor-a', name: 'Group A' },
        'group-b': { id: 'group-b', instructor_id: 'instructor-b', name: 'Group B' },
    },
    exams: {
        'exam-a': { id: 'exam-a', title: 'Exam A', total_marks: 10, passing_marks: 5, course_id: 'course-a', duration_minutes: 60, start_time: null, end_time: null, grade_id: 'grade-a' },
        'exam-b': { id: 'exam-b', title: 'Exam B', total_marks: 10, passing_marks: 5, course_id: 'course-b', duration_minutes: 60, start_time: null, end_time: null, grade_id: 'grade-b' },
    },
    examGroups: [
        { exam_id: 'exam-a', group_id: 'group-a' },
        { exam_id: 'exam-b', group_id: 'group-b' },
    ],
    examQuestions: {
        'exam-a': [
            { id: 'qa1', exam_id: 'exam-a', question_type: 'multiple_choice', correct_answer: 'a', points: 5 },
            { id: 'qa2', exam_id: 'exam-a', question_type: 'essay', correct_answer: null, points: 5 },
        ],
        'exam-b': [
            { id: 'qb1', exam_id: 'exam-b', question_type: 'essay', correct_answer: null, points: 10 },
        ],
    },
    examAttempts: {
        // Attempts are keyed by enrollment (students.id), matching the
        // production submit/start/save-progress resolution. started_at is
        // anchored a few minutes before harness creation so the server-side
        // duration timer does not treat the in_progress fixture as expired.
        [attemptKey('exam-a', 'enrollment-a')]: { id: 'att-a1', exam_id: 'exam-a', student_id: 'enrollment-a', status: 'in_progress', score: 0, started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), answers: null, essay_scores: null },
        [attemptKey('exam-b', 'enrollment-b')]: { id: 'att-b1', exam_id: 'exam-b', student_id: 'enrollment-b', status: 'pending_review', score: 0, started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), answers: JSON.stringify({ essay: { qb1: 'answer' }, images: {} }), essay_scores: null },
    },
    examResults: {},
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => f.users[id] ?? null,
    findStaffIdentity: async (id) => f.staff[id] ?? null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id) => f.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the routers issue.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

const makeDb = (f: Fixtures, executed: ExecutedStatement[]) => {
    const examById = (id: unknown): ExamRow | undefined => (typeof id === 'string' ? f.exams[id] : undefined);
    const groupById = (id: unknown): GroupRow | undefined => (typeof id === 'string' ? f.groups[id] : undefined);

    const examOwnedBy = (examId: string, instructorId: string): boolean =>
        f.examGroups.some((eg) => eg.exam_id === examId && groupById(eg.group_id)?.instructor_id === instructorId);

    const respond = (sql: string, params: unknown[]): unknown[] => {
        // --- identity / phone lookups ---
        if (sql.includes('SELECT phone FROM users WHERE id')) {
            const u = typeof params[0] === 'string' ? f.users[params[0]] : undefined;
            return u?.phone ? [{ phone: u.phone }] : [];
        }
        if (sql.includes('SELECT id, phone FROM users WHERE id')) {
            const u = typeof params[0] === 'string' ? f.users[params[0]] : undefined;
            return u ? [{ id: params[0], phone: u.phone }] : [];
        }
        if (sql.includes('SELECT id FROM students WHERE phone = ?')) {
            const id = f.studentsByPhone[String(params[0])];
            return id ? [{ id }] : [];
        }
        if (sql.includes('SELECT id FROM students WHERE id = ?')) {
            const row = typeof params[0] === 'string' ? f.studentsById[params[0]] : undefined;
            return row ? [{ id: row.id }] : [];
        }
        if (sql.includes('SELECT id FROM students WHERE user_id = ?')) {
            // Teacher-side resolution of a user id to its enrollment id.
            const rows = typeof params[0] === 'string' ? f.enrollments[params[0]] : undefined;
            const direct = rows?.[0]?.id ?? (typeof params[0] === 'string' ? f.studentsById[params[0]]?.id : undefined);
            return direct ? [{ id: direct }] : [];
        }
        if (sql.includes('SELECT group_id, grade_id FROM students WHERE phone = ?')) {
            const id = f.studentsByPhone[String(params[0])];
            const row = id ? f.studentsById[id] : undefined;
            return row ? [{ group_id: row.group_id, grade_id: row.grade_id }] : [];
        }
        // --- exam lookups (specific before generic) ---
        if (sql.includes('SELECT total_marks, passing_marks, duration_minutes FROM exams')) {
            const exam = examById(params[0]);
            return exam ? [{ total_marks: exam.total_marks, passing_marks: exam.passing_marks, duration_minutes: exam.duration_minutes }] : [];
        }
        if (sql.includes('SELECT duration_minutes FROM exams')) {
            const exam = examById(params[0]);
            return exam ? [{ duration_minutes: exam.duration_minutes }] : [];
        }
        if (sql.includes('SELECT total_marks, passing_marks FROM exams')) {
            const exam = examById(params[0]);
            return exam ? [{ total_marks: exam.total_marks, passing_marks: exam.passing_marks }] : [];
        }
        if (sql.includes('SELECT passing_marks FROM exams')) {
            const exam = examById(params[0]);
            return exam ? [{ passing_marks: exam.passing_marks }] : [];
        }
        if (sql.includes('SELECT e.* FROM exams e WHERE e.id = ?')) {
            const exam = examById(params[0]);
            return exam ? [{ ...exam }] : [];
        }
        if (sql.includes('SELECT * FROM exams WHERE id = ?')) {
            const exam = examById(params[0]);
            return exam ? [{ ...exam }] : [];
        }
        // --- ownership / groups ---
        if (sql.includes('FROM exam_groups eg') && sql.includes('g.instructor_id = ?')) {
            // isExamInScope
            const [examId, instructorId] = params as [string, string];
            return examOwnedBy(examId, instructorId) ? [{ exam_id: examId }] : [];
        }
        if (sql.includes('SELECT group_id FROM exam_groups WHERE exam_id = ?')) {
            return f.examGroups.filter((eg) => eg.exam_id === params[0]).map((eg) => ({ group_id: eg.group_id }));
        }
        if (sql.includes('eg.group_id, g.name as group_name')) {
            return f.examGroups.filter((eg) => eg.exam_id === params[0])
                .map((eg) => ({ group_id: eg.group_id, group_name: groupById(eg.group_id)?.name ?? null }));
        }
        // --- questions ---
        // Production derives manual-review presence server-side via
        // question_type IN ('essay', 'short_answer'); count both kinds.
        if (sql.includes('FROM exam_questions') && sql.includes('COUNT(*)') && sql.includes("'essay'")) {
            const examId = String(params[0]);
            const cnt = (f.examQuestions[examId] || []).filter((q) => q.question_type === 'essay' || q.question_type === 'short_answer').length;
            return [{ cnt }];
        }
        if (sql.includes('SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY display_order')) {
            return (f.examQuestions[String(params[0])] || []).map((q) => ({ ...q }));
        }
        if (sql.includes('SELECT id, question_type, correct_answer, points FROM exam_questions')) {
            return (f.examQuestions[String(params[0])] || []).map((q) => ({ id: q.id, question_type: q.question_type, correct_answer: q.correct_answer, points: q.points }));
        }
        if (sql.includes('SELECT id, question_type as type, correct_answer, points FROM exam_questions')) {
            return (f.examQuestions[String(params[0])] || []).map((q) => ({ id: q.id, type: q.question_type, correct_answer: q.correct_answer, points: q.points }));
        }
        if (sql.includes('SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY id')) {
            return (f.examQuestions[String(params[0])] || []).map((q) => ({ ...q }));
        }
        // --- attempts ---
        // Attempts are keyed by enrollment (students.id). A user id and its
        // enrollment id address the same row: fall back to the mapped
        // enrollment when the raw key misses so legacy callers still resolve.
        // Production selects varying column lists (id/status, id/status/
        // started_at, *); match on the WHERE shape and return the full row so
        // every projection is satisfied.
        if (sql.includes('FROM exam_attempts') && sql.includes('exam_id = ?') && sql.includes('student_id = ?')) {
            const raw = String(params[1]);
            const attempt = f.examAttempts[attemptKey(String(params[0]), raw)]
                ?? f.examAttempts[attemptKey(String(params[0]), f.enrollments[raw]?.[0]?.id ?? '')];
            return attempt ? [{ ...attempt }] : [];
        }
        if (sql.includes('SELECT * FROM exam_attempts WHERE id = ?')) {
            const attempt = Object.values(f.examAttempts).find((a) => a.id === params[0]);
            return attempt ? [{ ...attempt }] : [];
        }
        if (sql.includes('COUNT(*) as count') && sql.includes('FROM exam_attempts')) {
            // /exams/student/:userId attempt summary
            const studentId = String(params[0]);
            const rows = Object.values(f.examAttempts).filter((a) => a.student_id === studentId);
            return rows.map((a) => ({ exam_id: a.exam_id, count: 1, has_in_progress: a.status === 'in_progress' ? 1 : 0, in_progress_started_at: null }));
        }
        // --- student exam list ---
        if (sql.includes('LEFT JOIN exam_groups eg ON e.id = eg.exam_id')) {
            const groupId = params[0];
            const ids = f.examGroups.filter((eg) => eg.group_id === groupId).map((eg) => eg.exam_id);
            return Object.values(f.exams).filter((e) => ids.includes(e.id));
        }
        // --- exam list ---
        if (sql.includes('SELECT e.* FROM exams e WHERE 1=1')) {
            return Object.values(f.exams).map((e) => ({ ...e }));
        }
        // --- exam_results / attempts joins ---
        if (sql.includes('LEFT JOIN exam_results er ON er.exam_id = e.id')) {
            // GET /exam-results/student/:studentId
            const studentId = String(params[0]);
            const attempts = Object.values(f.examAttempts).filter((a) => a.student_id === studentId);
            return attempts.map((a) => ({
                id: a.id, exam_id: a.exam_id, exam_title: f.exams[a.exam_id]?.title ?? null,
                student_id: a.student_id, score: a.score, total_marks: f.exams[a.exam_id]?.total_marks ?? 0,
                passing_marks: f.exams[a.exam_id]?.passing_marks ?? 0, status: a.status,
                submitted_at: a.started_at, graded_at: null, feedback: null, source: 'exam_attempts',
            }));
        }
        if (sql.includes('ea.score as auto_score')) {
            // GET /manual-grading/pending
            const gradeId = String(params[0]);
            const hasGroup = sql.includes('AND s.group_id = ?');
            const hasScope = sql.includes('g.instructor_id = ?');
            let cursor = 1;
            const groupFilter = hasGroup ? String(params[cursor++]) : undefined;
            const instructorScope = hasScope ? String(params[cursor++]) : undefined;
            return Object.values(f.examAttempts)
                .filter((a) => a.status === 'pending_review')
                .map((a) => {
                    // Attempts are keyed by enrollment: prefer the direct
                    // enrollment lookup, fall back to the legacy user->phone
                    // indirection for harness rows that predate the migration.
                    const direct = f.studentsById[a.student_id];
                    const sid = direct ? direct.id : (f.studentsByPhone[f.users[a.student_id]?.phone ?? ''] ?? '');
                    const student = f.studentsById[sid];
                    return { attempt: a, student };
                })
                .filter(({ student }) => !!student && student.grade_id === gradeId)
                .filter(({ student }) => (groupFilter ? student.group_id === groupFilter : true))
                .filter(({ attempt }) => (instructorScope ? examOwnedBy(attempt.exam_id, instructorScope) : true))
                .map(({ attempt, student }) => ({
                    exam_id: attempt.exam_id, student_id: attempt.student_id, auto_score: attempt.score,
                    answers: attempt.answers, submitted_at: attempt.started_at,
                    exam_title: f.exams[attempt.exam_id]?.title ?? null, total_marks: f.exams[attempt.exam_id]?.total_marks ?? 0,
                    student_name: student.name, grade_id: student.grade_id, group_id: student.group_id,
                }));
        }
        if (sql.includes('FROM exam_attempts ea') && sql.includes('INNER JOIN students s')) {
            // GET /exams/:examId/attempts
            return [];
        }
        if (sql.includes('FROM exam_results er')) {
            // GET /exam-results and GET /exam-results/:id (scoping asserted via SQL/params)
            return [];
        }
        if (sql.includes('SELECT * FROM exam_results WHERE exam_id = ? AND student_id = ?')) {
            const row = f.examResults[attemptKey(String(params[0]), String(params[1]))];
            return row ? [{ ...row }] : [];
        }
        if (sql.includes('SELECT total_marks FROM exam_results')) {
            const row = f.examResults[attemptKey(String(params[0]), String(params[1]))];
            return row ? [{ total_marks: (row as any).total_marks }] : [];
        }
        if (sql.includes('SELECT * FROM exam_results WHERE id = ')) {
            return [];
        }
        if (sql.includes('SELECT * FROM student_courses')) {
            return [];
        }
        return [];
    };

    const query: ExamDataAccess['query'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return respond(sql, params) as T[];
    };
    const queryOne: ExamDataAccess['queryOne'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute: ExamDataAccess['execute'] = async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        if (sql.startsWith('UPDATE exam_attempts')) {
            const examId = String(params[3]);
            const raw = String(params[4]);
            const attempt = f.examAttempts[attemptKey(examId, raw)]
                ?? f.examAttempts[attemptKey(examId, f.enrollments[raw]?.[0]?.id ?? '')];
            const guard = sql.includes("status = 'in_progress'") ? 'in_progress'
                : sql.includes("status = 'pending_review'") ? 'pending_review' : null;
            if (!attempt || (guard && attempt.status !== guard)) {
                return { affectedRows: 0, insertId: 0 } as never;
            }
            if (sql.includes('answers = ?')) {
                attempt.status = String(params[0]);
                attempt.score = Number(params[1]);
                attempt.answers = String(params[2]);
            } else if (sql.includes('essay_scores = ?')) {
                attempt.score = Number(params[0]);
                attempt.status = String(params[1]);
                attempt.essay_scores = String(params[2]);
            }
            return { affectedRows: 1, insertId: 0 } as never;
        }
        if (sql.startsWith('INSERT INTO exam_attempts')) {
            const [id, examId, studentId] = params as [string, string, string];
            f.examAttempts[attemptKey(examId, studentId)] = {
                id, exam_id: examId, student_id: studentId, status: 'in_progress', score: 0,
                started_at: '2026-10-16 00:00:00', answers: null, essay_scores: null,
            };
            return { affectedRows: 1, insertId: 0 } as never;
        }
        if (sql.includes('INSERT INTO exam_results') && sql.includes('marks_obtained')) {
            const [examId, studentId, score, totalMarks] = params as [string, string, number, number];
            f.examResults[attemptKey(examId, studentId)] = { exam_id: examId, student_id: studentId, marks_obtained: score, total_marks: totalMarks };
            return { affectedRows: 1, insertId: 0 } as never;
        }
        return { affectedRows: 1, insertId: 0 } as never;
    };
    return { query, queryOne, execute };
};

/**
 * Stand-in for requireTeachingWrite('exams'): replicates only its
 * authentication precondition. Entitlement checks live in teaching-access.ts
 * (outside this task's allowedPaths) and are not exercised hermetically.
 */
const teachingWriteStandIn: RequestHandler = (req, res, next) => {
    if (!(req as AuthRequest).user) {
        (res as Response).status(401).json({ error: 'Authentication required' });
        return;
    }
    next();
};

const makeHarness = (fixtures: Fixtures = makeFixtures()) => {
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed);
    const repository = makeRepository(fixtures);
    const authDeps = {
        db,
        optionalAuthenticate: createOptionalAuth(repository) as RequestHandler,
        authenticate: createAuthenticateToken(repository) as RequestHandler,
    };
    return {
        examRouter: createExamRouter({ ...authDeps, requireTeachingWriteAccess: teachingWriteStandIn }),
        resultsRouter: createExamResultsRouter(authDeps),
        gradingRouter: createManualGradingRouter(authDeps),
        executed,
        fixtures,
    };
};

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
    query?: Record<string, unknown>;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invoke = async (router: unknown, request: RouteRequest): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        // Express defaults an unset status to 200; mirror that so `res.json`
        // success paths are observable in assertions.
        json(payload: unknown) { response.body = payload; response.statusCode ??= 200; return response; },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0 });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enrollment-b' });
const REVOKED = tokenFor({ id: 'revoked', role: 'instructor', tv: 0 });

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
    }
};

// ---------------------------------------------------------------------------
// Anonymous / revoked principals (behavioral)
// ---------------------------------------------------------------------------

test('anonymous exam list is denied 401 before any data access', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous answer-key route (/exams/:id/questions) is denied 401 before any data access', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/exam-a/questions' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous exam-results list is denied 401 before any data access', async () => {
    const { resultsRouter, executed } = makeHarness();
    const response = await invoke(resultsRouter, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous manual-grading pending list is denied 401 before any data access', async () => {
    const { gradingRouter, executed } = makeHarness();
    const response = await invoke(gradingRouter, { method: 'GET', url: '/pending', query: { grade_id: 'grade-b' } });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('anonymous manual-grading submit is denied 401 with no grading side effect', async () => {
    const { gradingRouter, executed } = makeHarness();
    const response = await invoke(gradingRouter, {
        method: 'POST', url: '/submit',
        body: { exam_id: 'exam-b', student_id: 'student-b', essay_scores: { qb1: 10 }, total_score: 10 },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('a revoked identity is rejected 401 (session liveness), not downgraded to anonymous', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/', token: REVOKED });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

// ---------------------------------------------------------------------------
// Teacher ownership / tenant boundary (behavioral + decision-boundary)
// ---------------------------------------------------------------------------

test('a student cannot read the teacher exam listing (403, no data access)', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('a student cannot read the answer key via /exams/:id/questions (403)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/exam-a/questions', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
});

test('an instructor cannot read another instructor exam by id (404, indistinguishable)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/exam-a', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 404);
});

test('an owning instructor reads its own exam questions (200)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/exam-a/questions', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body));
});

test('an instructor cannot read another instructor exam results (404)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/exam-a/results', token: INSTRUCTOR_B });
    assert.equal(response.statusCode, 404);
});

test('an instructor cannot write a grade onto another instructor exam (404, no INSERT)', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, {
        method: 'POST', url: '/exam-a/results', token: INSTRUCTOR_B,
        body: { student_id: 'student-a', score: 10, total_marks: 10 },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('manual-grading pending list is scoped to the owning instructor (decision-boundary)', async () => {
    const { gradingRouter, executed } = makeHarness();
    const response = await invoke(gradingRouter, { method: 'GET', url: '/pending', token: INSTRUCTOR_B, query: { grade_id: 'grade-b' } });
    assert.equal(response.statusCode, 200);
    const scoped = executed.find((e) => e.sql.includes('ea.score as auto_score'));
    assert.ok(scoped, 'pending query was executed');
    assert.ok(scoped!.sql.includes('g.instructor_id = ?'), 'pending query carries an instructor scope clause');
    assert.ok(scoped!.params.includes('instructor-b'), 'pending query binds the caller instructor id');
});

test('an instructor cannot grade an exam it does not own (404, no grading side effect)', async () => {
    const { gradingRouter, executed } = makeHarness();
    const response = await invoke(gradingRouter, {
        method: 'POST', url: '/submit', token: INSTRUCTOR_A,
        body: { exam_id: 'exam-b', student_id: 'student-b', essay_scores: { qb1: 10 }, total_score: 10 },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

// ---------------------------------------------------------------------------
// Student own-attempt access (behavioral)
// ---------------------------------------------------------------------------

test('student A cannot enumerate student B exams (403)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/student/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
});

test('student A reads its own exam list (200)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
});

test('student A cannot start an attempt for student B (403, no attempt created)', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, { method: 'POST', url: '/exam-a/start/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('student A cannot submit an attempt for student B (403, no write)', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, {
        method: 'POST', url: '/exam-a/submit/student-b', token: STUDENT_A, body: { answers: {} },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('student A cannot read student B results (403)', async () => {
    const { resultsRouter } = makeHarness();
    const response = await invoke(resultsRouter, { method: 'GET', url: '/student/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
});

test('student A reads its own results (200)', async () => {
    const { resultsRouter } = makeHarness();
    const response = await invoke(resultsRouter, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
});

test('student A cannot read the exam review of student B (403)', async () => {
    const { examRouter } = makeHarness();
    const response = await invoke(examRouter, { method: 'GET', url: '/exam-a/review/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
});

// ---------------------------------------------------------------------------
// State integrity: submission / grading transitions (behavioral)
// ---------------------------------------------------------------------------

test('submit is refused 409 when no attempt was started', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, {
        method: 'POST', url: '/exam-b/submit/student-a', token: STUDENT_A, body: { answers: {} },
    });
    assert.equal(response.statusCode, 409);
    assertNoWrite(executed);
});

test('submit derives essay presence server-side and routes to pending_review even when the client lies', async () => {
    const { examRouter, executed } = makeHarness();
    const response = await invoke(examRouter, {
        method: 'POST', url: '/exam-a/submit/student-a', token: STUDENT_A,
        body: { answers: { qa1: 0 }, hasEssayQuestions: false },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as any).status, 'pending_review');
    // The grading transition was applied exactly once, guarded on in_progress.
    const updates = executed.filter((e) => /UPDATE exam_attempts/i.test(e.sql));
    assert.equal(updates.length, 1);
    assert.ok(updates[0].sql.includes("status = 'in_progress'"));
});

test('a duplicate submit of an already-submitted attempt is refused 409 (no re-grade)', async () => {
    const { examRouter } = makeHarness();
    const first = await invoke(examRouter, {
        method: 'POST', url: '/exam-a/submit/student-a', token: STUDENT_A,
        body: { answers: { qa1: 0 } },
    });
    assert.equal(first.statusCode, 200);
    const second = await invoke(examRouter, {
        method: 'POST', url: '/exam-a/submit/student-a', token: STUDENT_A,
        body: { answers: { qa1: 0 } },
    });
    assert.equal(second.statusCode, 409);
});

test('manual grading transitions a pending_review attempt once (200), then refuses re-grading (409)', async () => {
    const { gradingRouter } = makeHarness();
    const first = await invoke(gradingRouter, {
        method: 'POST', url: '/submit', token: INSTRUCTOR_B,
        body: { exam_id: 'exam-b', student_id: 'student-b', essay_scores: { qb1: 8 }, total_score: 8 },
    });
    assert.equal(first.statusCode, 200);
    assert.equal((first.body as any).status, 'passed');

    const second = await invoke(gradingRouter, {
        method: 'POST', url: '/submit', token: INSTRUCTOR_B,
        body: { exam_id: 'exam-b', student_id: 'student-b', essay_scores: { qb1: 9 }, total_score: 9 },
    });
    assert.equal(second.statusCode, 409);
});

test('a student cannot grade through the manual-grading submit endpoint (403)', async () => {
    const { gradingRouter, executed } = makeHarness();
    const response = await invoke(gradingRouter, {
        method: 'POST', url: '/submit', token: STUDENT_B,
        body: { exam_id: 'exam-b', student_id: 'student-b', essay_scores: { qb1: 10 }, total_score: 10 },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});
