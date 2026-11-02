/**
 * M2-23 — server-authoritative student learning path (hermetic, behavioral).
 *
 * Contract under test:
 *   GET  /api/student-course-access/courses
 *   GET  /api/student-course-access/courses/:courseId
 *   POST /api/student-course-access/courses/:courseId/lessons/:lessonId/completion
 *
 * The suite loads the REAL `src/routes/student-course-access.ts` factory and the
 * REAL `optionalAuth` / tenant-authority / student-workspace middlewares, with
 * only the `../src/db` leaf replaced by a fixture-backed seam. No database,
 * network, provider, dotenv file or listener is used, and no migration is
 * applied.
 *
 * What is pinned:
 *   * student-only authority, derived exclusively from the verified principal;
 *   * the selected active approved workspace requirement;
 *   * the exact active `student_courses` requirement;
 *   * the active + published + same-tenant course requirement;
 *   * one indistinguishable 404 for foreign / unpublished / unenrolled / absent;
 *   * fixed bounded projections with the private description redacted from a
 *     locked or unreleased lesson;
 *   * the DATABASE clock as the only release authority (an exact boundary is
 *     exercised: `release_at == now` is released, `now + 1s` is not);
 *   * prerequisite unlocking through `course_lesson_completions` keyed by the
 *     principal's OWN `student_enrollment_id`;
 *   * idempotent completion that preserves the original server instant;
 *   * duplicate completion serialization, uncertain-commit disposal and the
 *     `no-store` header on every outcome.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';

const TEST_SECRET = 'm2-23-hermetic-jwt-secret-not-a-real-key';

// ---------------------------------------------------------------------------
// Import interception: only the leaf data module is replaced
// ---------------------------------------------------------------------------

const normalize = (id: string) => path.resolve(id).toLowerCase();
const originalLoad = (Module as any)._load;
const interceptionLog: string[] = [];

const dbPath = normalize(path.join(__dirname, '../src/db'));

/** Any call into the real data layer is a hermetic violation, not a fallback. */
const dbSentinel = {
    query: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.query'); },
    queryOne: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.queryOne'); },
    execute: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.execute'); },
    getPool: (): never => { throw new Error('HERMETIC_VIOLATION:db.getPool'); },
    testConnection: async (): Promise<never> => { throw new Error('HERMETIC_VIOLATION:db.testConnection'); },
};

(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (parent && typeof parent.filename === 'string') {
        try {
            const resolved = Module.createRequire(parent.filename).resolve(request);
            if (normalize(resolved) === dbPath || normalize(resolved) === `${dbPath}.ts`) {
                interceptionLog.push('db');
                return dbSentinel;
            }
        } catch {
            /* not resolvable: fall through to the real loader */
        }
    }
    return originalLoad.apply(this, [request, parent, isMain]);
};

const authModule = require(path.join(__dirname, '../src/middleware/auth'));
const tenantBoundary = require(path.join(__dirname, '../src/middleware/tenant-authority-boundary'));
const studentBoundary = require(path.join(__dirname, '../src/middleware/student-workspace-boundary'));
const accessModule = require(path.join(__dirname, '../src/routes/student-course-access'));

(Module as any)._load = originalLoad;

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = TEST_SECRET;

after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    assert.equal((Module as any)._load, originalLoad, 'the loader hook must be restored');
    assert.deepEqual(interceptionLog, ['db'], 'exactly one leaf module is intercepted');
});

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const STUDENT_USER = 'student-user-1';
const OTHER_STUDENT_USER = 'student-user-2';
const ENROLLMENT_1 = 'f1000000-0000-4000-8000-000000000001';
const ENROLLMENT_2 = 'f1000000-0000-4000-8000-000000000002';
const ENROLLMENT_OTHER = 'f1000000-0000-4000-8000-0000000000ff';
const INSTRUCTOR = 'instructor-1';

const COURSE_A1 = 'a1000000-0000-4000-8000-000000000001';
const COURSE_A2 = 'a1000000-0000-4000-8000-000000000002';
const COURSE_B1 = 'b1000000-0000-4000-8000-000000000001';
const COURSE_DRAFT = 'd1000000-0000-4000-8000-000000000001';
const COURSE_ARCHIVED = 'd2000000-0000-4000-8000-000000000001';
const ABSENT_COURSE = 'd9000000-0000-4000-8000-000000000000';

const UNIT_1 = 'e1000000-0000-4000-8000-000000000001';
const UNIT_2 = 'e1000000-0000-4000-8000-000000000002';
const UNIT_ARCHIVED = 'e1000000-0000-4000-8000-000000000003';
const UNIT_OTHER_COURSE = 'e1000000-0000-4000-8000-000000000004';

const LESSON_1 = 'c1000000-0000-4000-8000-000000000001';
const LESSON_2 = 'c1000000-0000-4000-8000-000000000002';
const LESSON_3 = 'c1000000-0000-4000-8000-000000000003';
const LESSON_ARCHIVED = 'c1000000-0000-4000-8000-000000000004';
const LESSON_UNRELEASED = 'c1000000-0000-4000-8000-000000000005';
const LESSON_GATED = 'c1000000-0000-4000-8000-000000000006';
const LESSON_OTHER_COURSE = 'c1000000-0000-4000-8000-000000000007';
const ABSENT_LESSON = 'c9000000-0000-4000-8000-000000000000';

/** 2026-11-01T09:00:00Z */
const NOW_EPOCH = Math.floor(Date.UTC(2026, 10, 1, 9, 0, 0) / 1000);
const NOW_ISO = new Date(NOW_EPOCH * 1000).toISOString();

interface EnrollmentRow {
    id: string;
    user_id: string;
    tenant_id: string;
    is_active: number;
    approval_status: string;
    enrollment_status: string | null;
    enrollment_start_date: Date | null;
    enrollment_end_date: Date | null;
}

interface StudentCourseRow { id: string; student_id: string; course_id: string; status: string }
interface CourseRow {
    id: string; tenant_id: string; name: string; subject: string | null; grade: string | null;
    is_active: number; publication_state: string;
}
interface UnitRow { id: string; course_id: string; name: string; display_order: number; status: string }
interface LessonRow {
    id: string; unit_id: string; title: string; description: string | null;
    display_order: number; status: string; release_at: Date | null; prerequisite_lesson_id: string | null;
}
interface CompletionRow { id: string; student_enrollment_id: string; lesson_id: string; completed_at: Date }

interface State {
    tenants: Array<{ id: string; status: string }>;
    enrollments: EnrollmentRow[];
    studentCourses: StudentCourseRow[];
    courses: CourseRow[];
    units: UnitRow[];
    lessons: LessonRow[];
    completions: CompletionRow[];
    nowEpoch: number;
    completionClock: number;
    failInsert: boolean;
    failCompletionRead: boolean;
    failCommit: boolean;
    failRollback: boolean;
    failAcquire: boolean;
    malformedCompletionEpoch: boolean;
    /** Extra synthetic lessons appended to the path (bounded-page test). */
    extraLessons: number;
    /**
     * M2-23 batch 5: the SQL session time zone the fixture emulates, in seconds
     * east of UTC. `0` is a UTC session; any other value emulates a server whose
     * `@@session.time_zone` is NOT UTC, which is the state this application
     * actually runs in because it never pins one.
     */
    sessionOffsetSeconds: number;
}

const stamp = (epoch: number) => new Date(epoch * 1000);

function makeState(): State {
    return {
        tenants: [{ id: TENANT_A, status: 'active' }, { id: TENANT_B, status: 'active' }],
        enrollments: [
            {
                id: ENROLLMENT_1, user_id: STUDENT_USER, tenant_id: TENANT_A, is_active: 1,
                approval_status: 'approved', enrollment_status: 'active',
                enrollment_start_date: null, enrollment_end_date: null,
            },
            {
                id: ENROLLMENT_2, user_id: STUDENT_USER, tenant_id: TENANT_B, is_active: 1,
                approval_status: 'approved', enrollment_status: 'active',
                enrollment_start_date: null, enrollment_end_date: null,
            },
            {
                id: ENROLLMENT_OTHER, user_id: OTHER_STUDENT_USER, tenant_id: TENANT_A, is_active: 1,
                approval_status: 'approved', enrollment_status: 'active',
                enrollment_start_date: null, enrollment_end_date: null,
            },
        ],
        studentCourses: [
            { id: 'sc-1', student_id: ENROLLMENT_1, course_id: COURSE_A1, status: 'active' },
            { id: 'sc-2', student_id: ENROLLMENT_1, course_id: COURSE_A2, status: 'active' },
            { id: 'sc-3', student_id: ENROLLMENT_1, course_id: COURSE_DRAFT, status: 'active' },
            { id: 'sc-4', student_id: ENROLLMENT_1, course_id: COURSE_ARCHIVED, status: 'active' },
            { id: 'sc-5', student_id: ENROLLMENT_OTHER, course_id: COURSE_B1, status: 'active' },
        ],
        courses: [
            { id: COURSE_A1, tenant_id: TENANT_A, name: 'Algebra', subject: 'Math', grade: 'G7', is_active: 1, publication_state: 'published' },
            { id: COURSE_A2, tenant_id: TENANT_A, name: 'Geometry', subject: 'Math', grade: 'G8', is_active: 1, publication_state: 'published' },
            { id: COURSE_B1, tenant_id: TENANT_B, name: 'Physics', subject: 'Science', grade: 'G9', is_active: 1, publication_state: 'published' },
            { id: COURSE_DRAFT, tenant_id: TENANT_A, name: 'Draft course', subject: 'Math', grade: 'G7', is_active: 1, publication_state: 'draft' },
            { id: COURSE_ARCHIVED, tenant_id: TENANT_A, name: 'Archived course', subject: 'Math', grade: 'G7', is_active: 0, publication_state: 'published' },
        ],
        units: [
            { id: UNIT_1, course_id: COURSE_A1, name: 'Unit one', display_order: 0, status: 'active' },
            { id: UNIT_2, course_id: COURSE_A1, name: 'Unit two', display_order: 1, status: 'active' },
            { id: UNIT_ARCHIVED, course_id: COURSE_A1, name: 'Unit archived', display_order: 2, status: 'archived' },
            { id: UNIT_OTHER_COURSE, course_id: COURSE_A2, name: 'Unit of A2', display_order: 0, status: 'active' },
        ],
        lessons: [
            { id: LESSON_1, unit_id: UNIT_1, title: 'First', description: 'Private first lesson text', display_order: 0, status: 'active', release_at: null, prerequisite_lesson_id: null },
            { id: LESSON_2, unit_id: UNIT_1, title: 'Second', description: 'Private second lesson text', display_order: 1, status: 'active', release_at: null, prerequisite_lesson_id: LESSON_1 },
            { id: LESSON_3, unit_id: UNIT_2, title: 'Third', description: 'Private third lesson text', display_order: 0, status: 'active', release_at: null, prerequisite_lesson_id: null },
            { id: LESSON_ARCHIVED, unit_id: UNIT_1, title: 'Archived', description: 'Private archived text', display_order: 2, status: 'archived', release_at: null, prerequisite_lesson_id: null },
            { id: LESSON_UNRELEASED, unit_id: UNIT_2, title: 'Scheduled', description: 'Private scheduled text', display_order: 1, status: 'active', release_at: stamp(NOW_EPOCH + 3600), prerequisite_lesson_id: null },
            { id: LESSON_GATED, unit_id: UNIT_2, title: 'Gated', description: 'Private gated text', display_order: 2, status: 'active', release_at: null, prerequisite_lesson_id: LESSON_1 },
            { id: LESSON_OTHER_COURSE, unit_id: UNIT_OTHER_COURSE, title: 'Other course', description: 'Private other text', display_order: 0, status: 'active', release_at: null, prerequisite_lesson_id: null },
        ],
        completions: [],
        nowEpoch: NOW_EPOCH,
        completionClock: 0,
        failInsert: false,
        failCompletionRead: false,
        failCommit: false,
        failRollback: false,
        failAcquire: false,
        malformedCompletionEpoch: false,
        extraLessons: 0,
        sessionOffsetSeconds: 0,
    };
}

// ---------------------------------------------------------------------------
// Statement dispatch
// ---------------------------------------------------------------------------

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const epochOf = (value: Date | null): number | null =>
    value === null ? null : Math.floor(value.getTime() / 1000);

/**
 * The two comparison semantics MySQL can apply to `release_at`, and how this
 * fixture decides which one the handler asked for.
 *
 * `release_at` is a `TIMESTAMP`. Comparing it with a `DATETIME` such as
 * `UTC_TIMESTAMP()` makes MySQL convert the stored instant to the SESSION time
 * zone before comparing, so the answer depends on `@@session.time_zone` — and
 * nothing in this application sets it (the mysql2 pool's `timezone:'+02:00'` is a
 * CLIENT-side decoder option, not a `SET SESSION time_zone`). Comparing
 * `UNIX_TIMESTAMP(release_at)` with the no-argument `UNIX_TIMESTAMP()` compares
 * two absolute epochs, so the answer is the same on every session offset.
 *
 * The fixture emulates WHICHEVER form the issued statement actually uses, so a
 * regression back to the session-dependent form is observable here instead of
 * being masked by an epoch comparison the fixture performs on its own. A third
 * form is refused loudly rather than guessed at.
 */
const EPOCH_RELEASE_COMPARISON = 'UNIX_TIMESTAMP(l.release_at)<=UNIX_TIMESTAMP()';
const SESSION_RELEASE_COMPARISON = 'l.release_at<=UTC_TIMESTAMP()';

const releasedDecision = (
    sql: string,
    releaseAt: Date | null,
    nowEpoch: number,
    sessionOffsetSeconds: number,
): number => {
    if (releaseAt === null) return 1;
    const stored = epochOf(releaseAt)!;
    if (sql.includes(EPOCH_RELEASE_COMPARISON)) {
        // Absolute epochs on both sides: independent of the session zone.
        return stored <= nowEpoch ? 1 : 0;
    }
    if (sql.includes(SESSION_RELEASE_COMPARISON)) {
        // MySQL renders the TIMESTAMP in the session zone and compares that wall
        // clock with the UTC wall clock.
        return stored + sessionOffsetSeconds <= nowEpoch ? 1 : 0;
    }
    throw new Error(`the release decision used a comparison this fixture does not emulate: ${sql}`);
};

interface Call { sql: string; params: any[] }

function buildHarness(state: State) {
    const calls: Call[] = [];
    const events: string[] = [];
    let connectionCount = 0;
    let releaseCount = 0;
    let destroyCount = 0;
    let commitCount = 0;
    let rollbackCount = 0;
    let snapshot: { lessons: LessonRow[]; completions: CompletionRow[] } | null = null;

    const enrollmentProjection = (row: EnrollmentRow) => {
        const tenant = state.tenants.find(t => t.id === row.tenant_id);
        const inWindow =
            (row.enrollment_start_date === null || epochOf(row.enrollment_start_date)! <= state.nowEpoch) &&
            (row.enrollment_end_date === null || epochOf(row.enrollment_end_date)! > state.nowEpoch);
        const live =
            row.is_active === 1 && row.approval_status === 'approved' &&
            (row.enrollment_status === null || row.enrollment_status === 'active') &&
            tenant?.status === 'active' && inWindow;
        return live ? { enrollment_id: row.id, tenant_id: row.tenant_id } : null;
    };

    const pathRows = (courseId: string) => {
        const rows: any[] = [];
        const units = state.units
            .filter(u => u.course_id === courseId && u.status === 'active')
            .sort((x, y) => (x.display_order - y.display_order) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
        const extras: LessonRow[] = [];
        for (let index = 0; index < state.extraLessons; index += 1) {
            extras.push({
                id: `ab${String(index).padStart(6, '0')}-0000-4000-8000-000000000000`,
                unit_id: UNIT_1, title: `Extra ${index}`, description: 'extra', display_order: 100 + index,
                status: 'active', release_at: null, prerequisite_lesson_id: null,
            });
        }
        const allLessons = [...state.lessons, ...extras];
        for (const unit of units) {
            const lessons = allLessons
                .filter(l => l.unit_id === unit.id && l.status === 'active')
                .sort((x, y) => (x.display_order - y.display_order) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
            for (const lesson of lessons) {
                rows.push({ unit, lesson });
            }
        }
        return rows;
    };

    const dispatch = (sql: string, params: any[]): [any, any] => {
        const n = squash(sql);
        calls.push({ sql, params });

        // --- enrollment proof (used by every route) ---
        if (n.includes('FROM students s INNER JOIN tenants t')) {
            events.push('enrollment');
            const [enrollmentId, userId, tenantId] = params;
            const row = state.enrollments.find(
                e => e.id === enrollmentId && e.user_id === userId && e.tenant_id === tenantId
            );
            if (!row) return [[], []];
            const projected = enrollmentProjection(row);
            return [projected ? [projected] : [], []];
        }

        // --- the enrolled-course list (GET /courses) ---
        if (n.includes('FROM student_courses sc') && n.includes('INNER JOIN courses c')) {
            events.push('course_list');
            const [enrollmentId, tenantId, limit] = params;
            const rows = state.studentCourses
                .filter(sc => sc.student_id === enrollmentId && sc.status === 'active')
                .map(sc => state.courses.find(c => c.id === sc.course_id))
                .filter((course): course is CourseRow => Boolean(course))
                .filter(c => c.tenant_id === tenantId && c.is_active === 1 && c.publication_state === 'published')
                .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.id < y.id ? -1 : 1))
                .slice(0, Number(limit))
                .map(c => ({ course_id: c.id, name: c.name, subject: c.subject, grade: c.grade }));
            return [rows, []];
        }

        // --- the exact active student_courses row ---
        if (n.includes('FROM student_courses sc WHERE sc.student_id=?')) {
            events.push('student_course');
            const [enrollmentId, courseId] = params;
            const row = state.studentCourses.find(
                sc => sc.student_id === enrollmentId && sc.course_id === courseId && sc.status === 'active'
            );
            return [row ? [{ student_course_id: row.id }] : [], []];
        }

        // --- the published, active, same-tenant course ---
        if (n.includes('FROM courses c') && n.includes("publication_state='published'")) {
            events.push('course');
            const [courseId, tenantId] = params;
            const course = state.courses.find(
                c => c.id === courseId && c.tenant_id === tenantId &&
                    c.is_active === 1 && c.publication_state === 'published'
            );
            return [course
                ? [{ course_id: course.id, name: course.name, subject: course.subject, grade: course.grade }]
                : [], []];
        }

        // --- the learning path ---
        if (n.includes('FROM course_units u') && n.includes('INNER JOIN course_lessons l')) {
            events.push('path');
            const [enrollmentId, joinEnrollmentId, courseId, limit] = params;
            if (enrollmentId !== joinEnrollmentId) {
                throw new Error('the path statement bound two DIFFERENT enrollment ids');
            }
            const rows = pathRows(String(courseId)).map(({ unit, lesson }) => {
                const completed = state.completions.find(
                    c => c.lesson_id === lesson.id && c.student_enrollment_id === enrollmentId
                );
                const prerequisiteMet = lesson.prerequisite_lesson_id === null || state.completions.some(
                    c => c.lesson_id === lesson.prerequisite_lesson_id && c.student_enrollment_id === enrollmentId
                );
                return {
                    unit_id: unit.id,
                    unit_name: unit.name,
                    unit_display_order: unit.display_order,
                    lesson_id: lesson.id,
                    title: lesson.title,
                    lesson_display_order: lesson.display_order,
                    lesson_description: lesson.description,
                    release_at_epoch: epochOf(lesson.release_at),
                    prerequisite_lesson_id: lesson.prerequisite_lesson_id,
                    is_released: releasedDecision(
                        n, lesson.release_at, state.nowEpoch, state.sessionOffsetSeconds,
                    ),
                    is_prerequisite_met: prerequisiteMet ? 1 : 0,
                    completed_at_epoch: state.malformedCompletionEpoch
                        ? 'not-an-epoch'
                        : completed === undefined ? null : epochOf(completed.completed_at),
                };
            });
            return [rows.slice(0, Number(limit)), []];
        }

        // --- the completion eligibility lock ---
        if (n.includes('FROM course_lessons l') && n.includes('INNER JOIN course_units u') && n.includes('FOR UPDATE')) {
            events.push('lesson_lock');
            const [courseId, lessonId] = params;
            const lesson = state.lessons.find(l => l.id === lessonId && l.status === 'active');
            if (!lesson) return [[], []];
            const unit = state.units.find(u => u.id === lesson.unit_id && u.course_id === courseId && u.status === 'active');
            if (!unit) return [[], []];
            return [[{
                id: lesson.id,
                status: lesson.status,
                release_at_epoch: epochOf(lesson.release_at),
                prerequisite_lesson_id: lesson.prerequisite_lesson_id,
                is_released: releasedDecision(
                    n, lesson.release_at, state.nowEpoch, state.sessionOffsetSeconds,
                ),
            }], []];
        }

        // --- prerequisite completion proof ---
        if (n.includes('FROM course_lesson_completions') && n.includes('student_enrollment_id=? AND lesson_id=?') && !n.includes('FOR UPDATE')) {
            events.push('prerequisite_completion');
            const [enrollmentId, lessonId] = params;
            const row = state.completions.find(
                c => c.student_enrollment_id === enrollmentId && c.lesson_id === lessonId
            );
            return [row ? [{ id: row.id }] : [], []];
        }

        // --- existing completion (locked) ---
        if (n.includes('FROM course_lesson_completions') && n.includes('student_enrollment_id=? AND lesson_id=?') && n.includes('FOR UPDATE')) {
            events.push('existing_completion');
            const [enrollmentId, lessonId] = params;
            const row = state.completions.find(
                c => c.student_enrollment_id === enrollmentId && c.lesson_id === lessonId
            );
            return [row
                ? [{ id: row.id, completed_at_epoch: epochOf(row.completed_at) }]
                : [], []];
        }

        // --- insert ---
        if (n.startsWith('INSERT INTO course_lesson_completions')) {
            events.push('insert_completion');
            if (state.failInsert) throw new Error('ER_DUP_ENTRY: insert on internal table failed');
            const [id, enrollmentId, lessonId] = params;
            state.completionClock += 1;
            // The DATABASE clock: the fixture stamps from its own `nowEpoch`,
            // never from a value the caller supplied.
            const completedAt = stamp(state.nowEpoch + state.completionClock);
            state.completions.push({
                id: String(id), student_enrollment_id: String(enrollmentId),
                lesson_id: String(lessonId), completed_at: completedAt,
            });
            return [{ affectedRows: 1 }, []];
        }

        // --- read back the inserted completion ---
        if (n.includes('FROM course_lesson_completions WHERE id=?')) {
            events.push('completion_read');
            if (state.failCompletionRead) return [[], []];
            const row = state.completions.find(c => c.id === String(params[0]));
            return [row
                ? [{
                    id: row.id,
                    completed_at_epoch: state.malformedCompletionEpoch
                        ? 'not-an-epoch'
                        : epochOf(row.completed_at),
                }]
                : [], []];
        }

        throw new Error(`Unhandled student-course-access SQL in hermetic fixture: ${n}`);
    };

    const makeConnection = () => {
        connectionCount += 1;
        return {
            beginTransaction: async () => {
                events.push('begin');
                snapshot = {
                    lessons: state.lessons.map(row => ({ ...row })),
                    completions: state.completions.map(row => ({ ...row })),
                };
            },
            execute: async (sql: string, params: any[] = []) => dispatch(sql, params),
            commit: async () => {
                events.push('commit');
                if (state.failCommit) throw new Error('commit acknowledgement lost');
                commitCount += 1;
                snapshot = null;
            },
            rollback: async () => {
                events.push('rollback');
                rollbackCount += 1;
                if (state.failRollback) throw new Error('rollback failed');
                if (snapshot) {
                    state.lessons = snapshot.lessons.map(row => ({ ...row }));
                    state.completions = snapshot.completions.map(row => ({ ...row }));
                    snapshot = null;
                }
            },
            release: () => { events.push('release'); releaseCount += 1; },
            destroy: () => { events.push('destroy'); destroyCount += 1; },
        };
    };

    const repository = {
        findUsersIdentity: async (id: string) => {
            const known = [STUDENT_USER, OTHER_STUDENT_USER, INSTRUCTOR];
            return known.includes(id) ? { is_active: 1, token_version: 0, suspension_active: 0 } : null;
        },
        findStaffIdentity: async () => null,
        findInstructorAccount: async () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 }),
        findStudentEnrollments: async (userId: string) =>
            state.enrollments
                .filter(e => e.user_id === userId && enrollmentProjection(e) !== null)
                .map(e => ({
                    id: e.id, user_id: e.user_id, tenant_id: e.tenant_id,
                    instructor_id: INSTRUCTOR, group_id: null, grade_id: null,
                })),
        findActiveTenantMemberships: async () => [],
    };

    const router = accessModule.createStudentCourseAccessRouter({
        query: async (sql: string, params: any[] = []) => dispatch(sql, params)[0],
        getConnection: async () => {
            if (state.failAcquire) throw new Error('pool connection unavailable');
            return makeConnection();
        },
    });

    const chain: RequestHandler[] = [
        authModule.createOptionalAuth(repository),
        tenantBoundary.enforceTenantAuthorityBoundary,
        studentBoundary.enforceStudentWorkspaceBoundary,
        router,
    ];

    return {
        chain, calls, events, state,
        connectionCount: () => connectionCount,
        releaseCount: () => releaseCount,
        destroyCount: () => destroyCount,
        commitCount: () => commitCount,
        rollbackCount: () => rollbackCount,
    };
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

interface Result { status: number; body: any; headers: Record<string, string> }

const sign = (id: string, role: string, extra: Record<string, unknown> = {}) =>
    jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m' });

const studentToken = (enrollmentId: string = ENROLLMENT_1, tenantId: string = TENANT_A) =>
    sign(STUDENT_USER, 'student', { student_enrollment_id: enrollmentId, tenant_id: tenantId });

function makeReq(opts: {
    token?: string | null;
    method?: string;
    pathName: string;
    query?: any;
    body?: any;
    headers?: Record<string, string>;
}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
    return {
        method: opts.method ?? 'GET',
        url: opts.pathName,
        // The router is exercised directly (not through `app.use`), so `path`
        // is router-relative while `originalUrl` keeps the production mount, so
        // the shared boundary middlewares see the path they would see in
        // production.
        originalUrl: `/api/student-course-access${opts.pathName}`,
        path: opts.pathName,
        headers,
        query: opts.query ?? {},
        body: opts.body,
        params: {},
        header(name: string) { return headers[name.toLowerCase()]; },
    };
}

function runChain(chain: RequestHandler[], req: any): Promise<Result> {
    return new Promise((resolve, reject) => {
        let index = 0;
        let settled = false;
        const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };
        const headers: Record<string, string> = {};
        const res: any = {
            statusCode: 200,
            status(code: number) { res.statusCode = code; return res; },
            set(name: string, value: string) { headers[name] = value; return res; },
            setHeader(name: string, value: string) { headers[name] = value; return res; },
            json(payload: any) { finish({ status: res.statusCode, body: payload, headers }); return res; },
            send(payload: any) { finish({ status: res.statusCode, body: payload, headers }); return res; },
            end() { finish({ status: res.statusCode, body: undefined, headers }); return res; },
        };
        const next = (error?: any) => {
            if (error) { if (!settled) { settled = true; reject(error); } return; }
            const middleware = chain[index++];
            if (!middleware) { finish({ status: 0, body: undefined, headers }); return; }
            try {
                const outcome = (middleware as any)(req, res, next);
                if (outcome && typeof outcome.then === 'function') outcome.catch(next);
            } catch (caught) {
                next(caught);
            }
        };
        next();
    });
}

const silence = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.error = original;
    }
};

// Router-relative paths: the production mount prefix is
// `/api/student-course-access` (see `originalUrl` above).
const coursesPath = '/courses';
const pathOf = (courseId: string) => `/courses/${courseId}`;
const completionOf = (courseId: string, lessonId: string) =>
    `/courses/${courseId}/lessons/${lessonId}/completion`;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test('mount: the router exposes exactly the three documented routes', () => {
    const state = makeState();
    const harness = buildHarness(state);
    const router = harness.chain[harness.chain.length - 1] as any;
    const routes = router.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
    assert.deepEqual(routes.sort(), [
        'GET /courses',
        'GET /courses/:courseId',
        'POST /courses/:courseId/lessons/:lessonId/completion',
    ]);
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

test('authority: an anonymous caller is refused before any statement', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ pathName: coursesPath }));
    assert.equal(res.status, 401);
    assert.deepEqual(harness.calls, [], 'no statement is issued for an anonymous caller');
});

test('authority: a non-student principal is refused', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: sign(INSTRUCTOR, 'instructor', { tenant_id: TENANT_A }),
        pathName: coursesPath,
    }));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Student access required');
    assert.deepEqual(harness.calls, []);
});

test('authority: a student with no selected workspace gets the existing 409 contract', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: sign(STUDENT_USER, 'student'),
        pathName: coursesPath,
    }));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'STUDENT_SPACE_REQUIRED');
    assert.deepEqual(harness.calls, []);
});

test('authority: a client-supplied tenant selector is refused', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        pathName: coursesPath,
        query: { tenant_id: TENANT_B },
    }));
    assert.equal(res.status, 400);
    assert.deepEqual(harness.calls, [], 'a selector never reaches a statement');
});

test('authority: another student\'s enrollment id is refused at the boundary', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        pathName: coursesPath,
        query: { student_id: ENROLLMENT_OTHER },
    }));
    assert.equal(res.status, 403);
    assert.deepEqual(harness.calls, []);
});

test('authority: naming even your OWN student id is refused — the principal is the only selector', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        pathName: coursesPath,
        query: { student_id: ENROLLMENT_1 },
    }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Workspace context is resolved from the authenticated session');
    assert.deepEqual(harness.calls, []);
});

test('authority: an enrollment that stopped being active is revoked before the router runs', async () => {
    const state = makeState();
    state.enrollments[0].is_active = 0;
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    // The shared principal resolver fails closed when the selected workspace no
    // longer resolves, so the request never reaches a course statement.
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'WORKSPACE_REVOKED');
    assert.deepEqual(harness.calls, []);
});

test('authority: an enrollment outside its own date window is revoked before the router runs', async () => {
    const state = makeState();
    state.enrollments[0].enrollment_end_date = stamp(NOW_EPOCH - 1);
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'WORKSPACE_REVOKED');
    assert.deepEqual(harness.calls, []);
});

// ---------------------------------------------------------------------------
// GET /courses
// ---------------------------------------------------------------------------

test('list: only enrolled, published, active courses of the selected tenant appear', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: coursesPath }));

    assert.equal(res.status, 200);
    const ids = res.body.courses.map((course: any) => course.course_id);
    assert.deepEqual(ids.sort(), [COURSE_A1, COURSE_A2].sort(), 'the draft and archived courses are absent');
    assert.equal(res.body.truncated, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    // The projection is fixed: no price, no tenant, no instructor.
    for (const course of res.body.courses) {
        assert.deepEqual(Object.keys(course).sort(), ['course_id', 'grade', 'name', 'subject']);
    }
});

test('list: the query is bounded to one row more than the page maximum', async () => {
    const harness = buildHarness(makeState());
    await runChain(harness.chain, makeReq({ token: studentToken(), pathName: coursesPath }));
    const listCall = harness.calls.find(c => squash(c.sql).includes('FROM student_courses sc') && squash(c.sql).includes('INNER JOIN courses c'));
    assert.ok(listCall);
    assert.equal(listCall!.params[2], 101, '100 + 1 sentinel row');
    assert.match(squash(listCall!.sql), /LIMIT \?$/);
});

test('list: a truncated page says so instead of silently dropping rows', async () => {
    const state = makeState();
    for (let index = 0; index < 120; index += 1) {
        const id = `a${String(index).padStart(7, '0')}-0000-4000-8000-000000000000`;
        state.courses.push({
            id, tenant_id: TENANT_A, name: `Course ${String(index).padStart(3, '0')}`,
            subject: 'Math', grade: 'G7', is_active: 1, publication_state: 'published',
        });
        state.studentCourses.push({ id: `sc-x${index}`, student_id: ENROLLMENT_1, course_id: id, status: 'active' });
    }
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: coursesPath }));
    assert.equal(res.status, 200);
    assert.equal(res.body.courses.length, 100);
    assert.equal(res.body.truncated, true);
});

// ---------------------------------------------------------------------------
// GET /courses/:courseId — the learning path
// ---------------------------------------------------------------------------

test('path: units and lessons are listed in deterministic order with a fixed projection', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));

    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body.course, { course_id: COURSE_A1, name: 'Algebra', subject: 'Math', grade: 'G7' });
    assert.deepEqual(res.body.units.map((unit: any) => unit.unit_id), [UNIT_1, UNIT_2]);
    assert.deepEqual(
        res.body.units[0].lessons.map((lesson: any) => lesson.lesson_id),
        [LESSON_1, LESSON_2],
        'the archived lesson and the archived unit are excluded',
    );
    assert.equal(res.body.truncated, false);

    const first = res.body.units[0].lessons[0];
    assert.deepEqual(Object.keys(first).sort(), [
        'accessible', 'completed', 'completed_at', 'description', 'display_order',
        'lesson_id', 'lock_reason', 'prerequisite_lesson_id', 'release_at', 'title',
    ]);
});

test('path: an accessible lesson exposes its description', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    const first = res.body.units[0].lessons[0];
    assert.equal(first.accessible, true);
    assert.equal(first.lock_reason, null);
    assert.equal(first.description, 'Private first lesson text');
    assert.equal(first.release_at, null);
});

test('path: an unreleased lesson is locked, names the reason and hides the description', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    const scheduled = res.body.units[1].lessons.find((lesson: any) => lesson.lesson_id === LESSON_UNRELEASED);

    assert.equal(scheduled.accessible, false);
    assert.equal(scheduled.lock_reason, 'not_released');
    assert.equal(scheduled.description, null, 'the private wording never reaches the client');
    assert.equal(scheduled.release_at, new Date((NOW_EPOCH + 3600) * 1000).toISOString());
    assert.equal(JSON.stringify(res.body).includes('Private scheduled text'), false);
});

test('path: a lesson whose prerequisite is incomplete is locked with its own reason', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));

    const second = res.body.units[0].lessons.find((lesson: any) => lesson.lesson_id === LESSON_2);
    assert.equal(second.accessible, false);
    assert.equal(second.lock_reason, 'prerequisite_incomplete');
    assert.equal(second.description, null);

    const gated = res.body.units[1].lessons.find((lesson: any) => lesson.lesson_id === LESSON_GATED);
    assert.equal(gated.accessible, false);
    assert.equal(gated.lock_reason, 'prerequisite_incomplete');
});

test('path: a completed prerequisite unlocks the dependent lesson', async () => {
    const state = makeState();
    state.completions.push({
        id: 'c-1', student_enrollment_id: ENROLLMENT_1, lesson_id: LESSON_1,
        completed_at: stamp(NOW_EPOCH - 600),
    });
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));

    const second = res.body.units[0].lessons.find((lesson: any) => lesson.lesson_id === LESSON_2);
    assert.equal(second.accessible, true);
    assert.equal(second.lock_reason, null);
    assert.equal(second.description, 'Private second lesson text');
});

test('path: ANOTHER enrollment\'s completion never unlocks this one', async () => {
    const state = makeState();
    // The same human, enrolled at the OTHER academy, completed an identically
    // named lesson id. It must not leak across the enrollment boundary.
    state.completions.push({
        id: 'c-2', student_enrollment_id: ENROLLMENT_OTHER, lesson_id: LESSON_1,
        completed_at: stamp(NOW_EPOCH - 600),
    });
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));

    const second = res.body.units[0].lessons.find((lesson: any) => lesson.lesson_id === LESSON_2);
    assert.equal(second.accessible, false);
    assert.equal(second.lock_reason, 'prerequisite_incomplete');
});

test('path: a completed lesson reports its stored completion instant', async () => {
    const state = makeState();
    state.completions.push({
        id: 'c-3', student_enrollment_id: ENROLLMENT_1, lesson_id: LESSON_1,
        completed_at: stamp(NOW_EPOCH - 600),
    });
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));

    const first = res.body.units[0].lessons.find((lesson: any) => lesson.lesson_id === LESSON_1);
    assert.equal(first.completed, true);
    assert.equal(first.completed_at, new Date((NOW_EPOCH - 600) * 1000).toISOString());
});

test('path: the release boundary is the DATABASE clock — equal is released, one second later is not', async () => {
    const atBoundary = makeState();
    atBoundary.lessons.find(l => l.id === LESSON_3)!.release_at = stamp(NOW_EPOCH);
    const released = await runChain(
        buildHarness(atBoundary).chain,
        makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }),
    );
    const lesson = released.body.units[1].lessons.find((entry: any) => entry.lesson_id === LESSON_3);
    assert.equal(lesson.accessible, true, 'release_at == now is released');

    const justAfter = makeState();
    justAfter.lessons.find(l => l.id === LESSON_3)!.release_at = stamp(NOW_EPOCH + 1);
    const locked = await runChain(
        buildHarness(justAfter).chain,
        makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }),
    );
    const lockedLesson = locked.body.units[1].lessons.find((entry: any) => entry.lesson_id === LESSON_3);
    assert.equal(lockedLesson.accessible, false, 'release_at == now + 1s is not released');
    assert.equal(lockedLesson.lock_reason, 'not_released');
});

// ---------------------------------------------------------------------------
// M2-23 batch 5 — the release decision must not depend on the SQL session zone
// (audit F)
// ---------------------------------------------------------------------------
//
// `release_at` is a TIMESTAMP. Comparing it with `UTC_TIMESTAMP()` makes MySQL
// render the stored instant in the SESSION zone first, so the answer would only be
// correct on a UTC session — and this application never pins one. The fixture
// emulates whichever comparison the issued statement uses, so these tests fail if
// the handler regresses to the session-dependent form.

/** A UTC session, +02:00, -05:00 and +05:30 (a half-hour offset). */
const SESSION_OFFSETS = [0, 2 * 3600, -5 * 3600, 5 * 3600 + 1800];

const lessonOf = (body: any, lessonId: string) =>
    body.units.flatMap((unit: any) => unit.lessons).find((entry: any) => entry.lesson_id === lessonId);

test('time: before, at and after the instant give the same answer under every session offset', async () => {
    for (const offset of SESSION_OFFSETS) {
        const state = makeState();
        state.sessionOffsetSeconds = offset;
        const lesson = (id: string) => state.lessons.find(l => l.id === id)!;
        lesson(LESSON_1).release_at = stamp(NOW_EPOCH - 1);
        lesson(LESSON_3).release_at = stamp(NOW_EPOCH);
        lesson(LESSON_UNRELEASED).release_at = stamp(NOW_EPOCH + 1);

        const res = await runChain(buildHarness(state).chain, makeReq({
            token: studentToken(), pathName: pathOf(COURSE_A1),
        }));
        assert.equal(res.status, 200, `offset ${offset}`);

        assert.equal(lessonOf(res.body, LESSON_1).accessible, true, `offset ${offset}: one second BEFORE is released`);
        assert.equal(lessonOf(res.body, LESSON_3).accessible, true, `offset ${offset}: AT the instant is released`);
        assert.equal(lessonOf(res.body, LESSON_UNRELEASED).accessible, false, `offset ${offset}: one second AFTER is locked`);
        assert.equal(lessonOf(res.body, LESSON_UNRELEASED).lock_reason, 'not_released');
        assert.equal(lessonOf(res.body, LESSON_UNRELEASED).description, null, 'a locked lesson carries no description');
    }
});

test('time: the completion endpoint applies the same offset-independent release rule', async () => {
    for (const offset of SESSION_OFFSETS) {
        const released = makeState();
        released.sessionOffsetSeconds = offset;
        released.lessons.find(l => l.id === LESSON_3)!.release_at = stamp(NOW_EPOCH);
        const ok = await runChain(buildHarness(released).chain, makeReq({
            token: studentToken(), method: 'POST',
            pathName: completionOf(COURSE_A1, LESSON_3), body: {},
        }));
        assert.equal(ok.status, 200, `offset ${offset}: AT the instant is completable`);

        const locked = makeState();
        locked.sessionOffsetSeconds = offset;
        locked.lessons.find(l => l.id === LESSON_3)!.release_at = stamp(NOW_EPOCH + 1);
        const no = await runChain(buildHarness(locked).chain, makeReq({
            token: studentToken(), method: 'POST',
            pathName: completionOf(COURSE_A1, LESSON_3), body: {},
        }));
        assert.equal(no.status, 409, `offset ${offset}: one second AFTER is locked`);
        assert.equal(no.body.reason, 'not_released');
    }
});

test('time: every release decision compares two epochs, never a TIMESTAMP against a UTC wall clock', async () => {
    const harness = buildHarness(makeState());
    await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    await runChain(harness.chain, makeReq({
        token: studentToken(), method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_3), body: {},
    }));

    const decisions = harness.calls.map(call => squash(call.sql)).filter(sql => sql.includes('is_released'));
    assert.equal(decisions.length >= 2, true, 'the path read AND the completion lock both decide release');
    for (const sql of decisions) {
        assert.equal(sql.includes(EPOCH_RELEASE_COMPARISON), true, `an epoch comparison is required: ${sql}`);
        assert.equal(
            sql.includes(SESSION_RELEASE_COMPARISON),
            false,
            `the session-dependent form must never appear: ${sql}`,
        );
    }
});

test('path: a course of another tenant is the same 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_B1) }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Course not found');
});

test('path: an unpublished course is the same 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_DRAFT) }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Course not found');
});

test('path: an archived course is the same 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_ARCHIVED) }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Course not found');
});

test('path: a course the enrollment does not hold is the same 404', async () => {
    const state = makeState();
    // A published, active course of the right tenant that this enrollment never joined.
    state.courses.push({
        id: 'a9000000-0000-4000-8000-000000000001', tenant_id: TENANT_A, name: 'Unjoined',
        subject: 'Math', grade: 'G7', is_active: 1, publication_state: 'published',
    });
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        pathName: pathOf('a9000000-0000-4000-8000-000000000001'),
    }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Course not found');
});

test('path: an absent course and a malformed id are the same 404', async () => {
    const absent = await runChain(
        buildHarness(makeState()).chain,
        makeReq({ token: studentToken(), pathName: pathOf(ABSENT_COURSE) }),
    );
    assert.equal(absent.status, 404);

    const harness = buildHarness(makeState());
    const malformed = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf('not-a-uuid') }));
    assert.equal(malformed.status, 404);
    assert.equal(malformed.body.error, 'Course not found');
    assert.deepEqual(harness.calls, [], 'a malformed id is refused before any statement');
});

test('path: the path statement is bounded and binds the principal\'s own enrollment twice', async () => {
    const harness = buildHarness(makeState());
    await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    const pathCall = harness.calls.find(c => squash(c.sql).includes('FROM course_units u') && squash(c.sql).includes('INNER JOIN course_lessons l'));
    assert.ok(pathCall);
    assert.equal(pathCall!.params[0], ENROLLMENT_1, 'the prerequisite EXISTS binds the principal enrollment');
    assert.equal(pathCall!.params[1], ENROLLMENT_1, 'the completion join binds the same enrollment');
    assert.equal(pathCall!.params[2], COURSE_A1);
    assert.equal(pathCall!.params[3], 501, '500 + 1 sentinel row');
    assert.match(squash(pathCall!.sql), /LIMIT \?$/);
    assert.match(squash(pathCall!.sql), /u\.status='active'/);
    assert.match(squash(pathCall!.sql), /l\.status='active'/);
});

test('path: a path larger than the bound is reported as truncated', async () => {
    const state = makeState();
    state.extraLessons = 520;
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    assert.equal(res.status, 200);
    assert.equal(res.body.truncated, true);
    const total = res.body.units.reduce((sum: number, unit: any) => sum + unit.lessons.length, 0);
    assert.equal(total, 500);
});

test('path: an unreadable stored completion instant fails the read instead of inventing a date', async () => {
    const state = makeState();
    state.completions.push({
        id: 'c-4', student_enrollment_id: ENROLLMENT_1, lesson_id: LESSON_1,
        completed_at: stamp(NOW_EPOCH - 600),
    });
    state.malformedCompletionEpoch = true;
    const harness = buildHarness(state);
    const res = await silence(() =>
        runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) })));
    assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// POST completion
// ---------------------------------------------------------------------------

test('completion: an accessible lesson is recorded once with the SERVER instant', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    }));

    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(Object.keys(res.body.completion).sort(), ['completed_at', 'lesson_id']);
    assert.equal(res.body.completion.lesson_id, LESSON_1);
    assert.equal(res.body.completion.completed_at, new Date((NOW_EPOCH + 1) * 1000).toISOString());
    assert.equal(harness.commitCount(), 1);
    assert.equal(harness.state.completions.length, 1);
    assert.equal(harness.state.completions[0].student_enrollment_id, ENROLLMENT_1);
});

test('completion: a retry returns the ORIGINAL instant, inserts nothing and commits nothing', async () => {
    const state = makeState();
    state.completions.push({
        id: 'c-5', student_enrollment_id: ENROLLMENT_1, lesson_id: LESSON_1,
        completed_at: stamp(NOW_EPOCH - 3600),
    });
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    }));

    assert.equal(res.status, 200);
    assert.equal(res.body.completion.completed_at, new Date((NOW_EPOCH - 3600) * 1000).toISOString());
    assert.equal(harness.events.includes('insert_completion'), false, 'no second row');
    assert.equal(harness.commitCount(), 0, 'a retry is a truthful no-op');
    assert.equal(state.completions.length, 1);
});

test('completion: the body must be empty — any attribute is refused before a connection', async () => {
    for (const body of [{ completed_at: NOW_ISO }, { lesson_id: LESSON_1 }, { student_id: ENROLLMENT_1 }, { tenant_id: TENANT_A }, []]) {
        const harness = buildHarness(makeState());
        const res = await runChain(harness.chain, makeReq({
            token: studentToken(),
            method: 'POST',
            pathName: completionOf(COURSE_A1, LESSON_1),
            body,
        }));
        assert.ok(res.status === 400 || res.status === 403, `body ${JSON.stringify(body)} must be refused`);
        assert.equal(harness.connectionCount(), 0);
    }
});

test('completion: an unreleased lesson is refused 409 and records nothing', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_UNRELEASED),
        body: {},
    }));

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'LESSON_LOCKED');
    assert.equal(res.body.reason, 'not_released');
    assert.equal(harness.commitCount(), 0);
    assert.deepEqual(harness.state.completions, []);
});

test('completion: an incomplete prerequisite is refused 409 and records nothing', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_2),
        body: {},
    }));

    assert.equal(res.status, 409);
    assert.equal(res.body.reason, 'prerequisite_incomplete');
    assert.deepEqual(harness.state.completions, []);
});

test('completion: once the prerequisite is complete the dependent lesson can be completed', async () => {
    const state = makeState();
    state.completions.push({
        id: 'c-6', student_enrollment_id: ENROLLMENT_1, lesson_id: LESSON_1,
        completed_at: stamp(NOW_EPOCH - 60),
    });
    const harness = buildHarness(state);
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_2),
        body: {},
    }));
    assert.equal(res.status, 200);
    assert.equal(state.completions.length, 2);
});

test('completion: a lesson of another course is the same 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_OTHER_COURSE),
        body: {},
    }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Lesson not found');
    assert.deepEqual(harness.state.completions, []);
});

test('completion: an archived lesson is the same 404', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_ARCHIVED),
        body: {},
    }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Lesson not found');
});

test('completion: an unenrolled course is the same 404 as an absent lesson', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_B1, LESSON_1),
        body: {},
    }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Course not found');
});

test('completion: an absent lesson id is a 404 before any statement', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, 'not-a-uuid'),
        body: {},
    }));
    assert.equal(res.status, 404);
    assert.deepEqual(harness.calls, []);
});

test('completion: the completion insert never supplies a client instant', async () => {
    const harness = buildHarness(makeState());
    await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    }));
    const insert = harness.calls.find(c => squash(c.sql).startsWith('INSERT INTO course_lesson_completions'));
    assert.ok(insert);
    assert.equal(insert!.params.length, 3, 'id, enrollment and lesson only — the instant is the column default');
    assert.equal(insert!.params[1], ENROLLMENT_1);
    assert.equal(insert!.params[2], LESSON_1);
});

test('completion: a lost commit acknowledgement is uncertain — 500 and the connection is destroyed', async () => {
    const state = makeState();
    state.failCommit = true;
    const harness = buildHarness(state);
    const res = await silence(() => runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    })));

    assert.equal(res.status, 500);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
});

test('completion: a failed rollback destroys the connection and never releases it', async () => {
    const state = makeState();
    state.failInsert = true;
    state.failRollback = true;
    const harness = buildHarness(state);
    const res = await silence(() => runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    })));

    assert.equal(res.status, 500);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.releaseCount(), 0);
});

test('completion: a failed insert rolls back and records nothing', async () => {
    const state = makeState();
    state.failInsert = true;
    const harness = buildHarness(state);
    const res = await silence(() => runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    })));

    assert.equal(res.status, 500);
    assert.equal(harness.commitCount(), 0);
    assert.deepEqual(state.completions, []);
    assert.equal(harness.releaseCount(), 1);
});

test('completion: an unreadable stored completion instant fails instead of fabricating one', async () => {
    const state = makeState();
    state.malformedCompletionEpoch = true;
    const harness = buildHarness(state);
    const res = await silence(() => runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    })));
    assert.equal(res.status, 500);
    assert.equal(harness.commitCount(), 0);
});

test('completion: a failed acquisition performs no cleanup at all', async () => {
    const state = makeState();
    state.failAcquire = true;
    const harness = buildHarness(state);
    const res = await silence(() => runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    })));
    assert.equal(res.status, 500);
    assert.equal(harness.releaseCount(), 0);
    assert.equal(harness.destroyCount(), 0);
});

test('completion: the connection is disposed exactly once on every outcome', async () => {
    const cases: Array<{ label: string; mutate: (state: State) => void }> = [
        { label: 'created', mutate: () => {} },
        {
            label: 'existing',
            mutate: (state) => {
                state.completions.push({
                    id: 'c-7', student_enrollment_id: ENROLLMENT_1, lesson_id: LESSON_1,
                    completed_at: stamp(NOW_EPOCH - 60),
                });
            },
        },
        { label: 'locked', mutate: (state) => { state.lessons.find(l => l.id === LESSON_1)!.release_at = stamp(NOW_EPOCH + 60); } },
        { label: 'failed insert', mutate: (state) => { state.failInsert = true; } },
        { label: 'uncertain commit', mutate: (state) => { state.failCommit = true; } },
    ];
    for (const entry of cases) {
        const state = makeState();
        entry.mutate(state);
        const harness = buildHarness(state);
        await silence(() => runChain(harness.chain, makeReq({
            token: studentToken(),
            method: 'POST',
            pathName: completionOf(COURSE_A1, LESSON_1),
            body: {},
        })));
        assert.equal(
            harness.releaseCount() + harness.destroyCount(),
            1,
            `${entry.label}: exactly one disposal`,
        );
    }
});

// ---------------------------------------------------------------------------
// Projection hygiene
// ---------------------------------------------------------------------------

test('projection: no tenant, price, contact or content locator is ever exposed', async () => {
    // Deliberately NO seeded completion, so the gated lessons stay locked and
    // their private wording must be absent from every response.
    const harness = buildHarness(makeState());

    const list = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: coursesPath }));
    const pathResult = await runChain(harness.chain, makeReq({ token: studentToken(), pathName: pathOf(COURSE_A1) }));
    const completion = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_1),
        body: {},
    }));

    for (const body of [list.body, pathResult.body, completion.body]) {
        const keys = JSON.stringify(Object.keys(body));
        const serialized = JSON.stringify(body);
        for (const forbiddenKey of ['tenant_id', 'student_id', 'instructor_id', 'price', 'email', 'phone', 'subscription', 'file_url', 'video_url', 'material']) {
            assert.equal(keys.includes(forbiddenKey), false, `no "${forbiddenKey}" key`);
            assert.equal(serialized.includes(`"${forbiddenKey}"`), false, `no "${forbiddenKey}" field`);
        }
    }
    // A locked lesson's private wording never appears anywhere in the body.
    assert.equal(JSON.stringify(pathResult.body).includes('Private gated text'), false);
    assert.equal(JSON.stringify(pathResult.body).includes('Private second lesson text'), false);
});

test('projection: a locked lesson is never readable through the completion endpoint either', async () => {
    const harness = buildHarness(makeState());
    const res = await runChain(harness.chain, makeReq({
        token: studentToken(),
        method: 'POST',
        pathName: completionOf(COURSE_A1, LESSON_GATED),
        body: {},
    }));
    assert.equal(res.status, 409);
    assert.equal(JSON.stringify(res.body).includes('Private gated text'), false);
    assert.equal(JSON.stringify(res.body).includes('description'), false);
});
