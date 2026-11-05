/**
 * M2-23 — server-authoritative student learning path.
 *
 * Contract: docs/streams/server/M2-B15-CONTRACT.md
 * Handoff:  docs/streams/client/M2-23-HANDOFF.md
 *
 * A SEPARATE router (mounted at `/api/student-course-access` in
 * `src/index.ts`) so the private teaching catalog is never widened by this
 * batch. `routes/course-lessons.ts` keeps its own owner-only authority and its
 * own transactional connection; this module never shares a statement with it
 * and cannot reach a teacher-only column by accident.
 *
 * What it serves, for the AUTHENTICATED STUDENT only:
 *   * `GET  /courses` — one bounded page of the courses this enrollment is
 *     actually enrolled in AND that are published and active in this tenant;
 *   * `GET  /courses/:courseId` — the fixed learning path: the active units of
 *     that course and their active lessons, each with an access decision;
 *   * `POST /courses/:courseId/lessons/:lessonId/completion` — record the
 *     student's completion of one CURRENTLY ACCESSIBLE lesson, once.
 *   * `GET /courses/:courseId/lessons/:lessonId/contents` — separate private
 *     material metadata after lesson, group and branch revalidation (BUILD-04).
 *   * `GET .../contents/:contentId/file` — conditional verified PDF attachment
 *     boundary (BUILD-05); production defaults remain unconfigured.
 *
 * What it is NOT:
 *   * it is not an enrollment. Nothing here creates, approves, extends or
 *     reactivates a `students` row or a `student_courses` row, and nothing here
 *     reads a subscription, a price or a payment;
 *   * metadata projections carry no file/video URL or storage locator. The
 *     separate PDF response requires trusted source/scan/storage configuration;
 *     the material list continues to report opening unavailable by default;
 *   * it is not a client-authoritative view. Every access decision is made from
 *     the DATABASE clock and from `course_lesson_completions` rows keyed by the
 *     principal's own `student_enrollment_id`. The client cannot state which
 *     lessons are unlocked.
 *
 * Authority model (fail closed, always):
 *   * the role must be exactly `student`;
 *   * the tenant and the enrollment are taken ONLY from the verified principal
 *     (`req.user.tenantId`, `req.user.studentEnrollmentId`) — a body, query or
 *     header selector is refused before a connection is taken;
 *   * the enrollment row is re-proved against `students` on the same
 *     connection: same id, same user, same tenant, active, approved, and inside
 *     its own enrollment window;
 *   * the course must have an ACTIVE `student_courses` row for that enrollment
 *     AND be `is_active=TRUE` AND `publication_state='published'` in the same
 *     tenant;
 *   * a foreign, unpublished, unenrolled or absent course is ONE indistinguishable
 *     404 with the same body, so the endpoint cannot be used to probe another
 *     academy's catalog or a draft course.
 */
import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { getPool, query } from '../db';
import { listStudentLessonMaterials } from '../services/student-lesson-materials';
import { createMaterialFileDeliveryService, type MaterialFileDeliveryConfig } from '../services/material-file-delivery';
import { verifyStudentEnrollment, resolveStudentCourse, proveStudentLesson } from '../services/student-lesson-access';
import { supportContextSchema, proveLessonSupportContext } from '../services/support-lesson-context';
import {listStudentLessonVideos} from '../services/student-lesson-videos';

/**
 * Minimal transactional connection seam, structurally identical to the
 * course-lesson and course-unit seams. Production binds a real mysql2
 * PoolConnection; hermetic tests bind a fixture-backed connection so the real
 * handler and authorization logic runs without a database or a network.
 */
export interface StudentCourseAccessConnection {
  beginTransaction(): Promise<void>;
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  destroy(): void;
}

/** Read seams plus an optional, explicitly configured private PDF delivery boundary. */
export interface StudentCourseAccessDeps {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  getConnection: () => Promise<StudentCourseAccessConnection>;
  /** Unconfigured by default; no storage/scanner evidence is invented. */
  materialFileDelivery?: MaterialFileDeliveryConfig;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A student is enrolled in a bounded number of courses. The list is capped so a
 * pathological enrollment cannot turn one request into an unbounded scan, and
 * `truncated` says so honestly instead of silently dropping rows.
 */
const COURSE_LIST_MAX = 100;
/**
 * A learning path is bounded too. A course larger than this is reported as
 * truncated rather than answered with a partial path that pretends to be
 * complete.
 */
const PATH_MAX_LESSONS = 500;
/** The bounded description projection. Mirrors the accepted public catalog. */
const DESCRIPTION_MAX = 600;

const EPOCH_SECONDS_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Render a stored instant as UTC ISO-8601 from its Unix EPOCH SECONDS.
 *
 * The mysql2 pool is configured with `timezone: '+02:00'`, which makes the
 * driver INTERPRET the wall time it receives on the client side. Projecting the
 * stored instant as epoch seconds removes that interpretation entirely: the
 * serialized value is the stored instant itself.
 *
 * A missing, malformed, non-positive or unrepresentable epoch is REFUSED: no
 * 1970 instant, no "now" and no null date is ever fabricated.
 */
const toUtcTimestamp = (epochSeconds: unknown): string | null => {
  let epoch: number;
  if (typeof epochSeconds === 'number') {
    epoch = epochSeconds;
  } else if (typeof epochSeconds === 'string') {
    const trimmed = epochSeconds.trim();
    if (!EPOCH_SECONDS_PATTERN.test(trimmed)) return null;
    epoch = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const instant = new Date(epoch * 1000);
  if (Number.isNaN(instant.getTime())) return null;
  return instant.toISOString();
};

/** `null` means "no schedule"; `undefined` means "unreadable, fail the request". */
const optionalInstant = (epochSeconds: unknown): string | null | undefined => {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  return toUtcTimestamp(epochSeconds) ?? undefined;
};

/**
 * MySQL returns `1`/`0` for a boolean expression, but a driver or a fixture may
 * hand back `true`/`false` or a string. Accept exactly the truthful forms and
 * treat anything else as NOT released / NOT met, which fails closed.
 */
const isTrue = (value: unknown): boolean =>
  value === 1 || value === true || value === '1';

type LockReason = 'not_released' | 'prerequisite_incomplete';

interface LessonView {
  lesson_id: string;
  title: string;
  display_order: number;
  release_at: string | null;
  prerequisite_lesson_id: string | null;
  accessible: boolean;
  lock_reason: LockReason | null;
  completed: boolean;
  completed_at: string | null;
  /**
   * The lesson description is exposed ONLY when the lesson is accessible. A
   * locked or unreleased lesson answers `null` here, so the private wording of
   * a lesson the student may not read yet never reaches the client — not even
   * as a "hidden" field.
   */
  description: string | null;
}

interface UnitView {
  unit_id: string;
  name: string;
  display_order: number;
  lessons: LessonView[];
}

const courseHeader = (row: any) => ({
  course_id: String(row.course_id),
  name: String(row.name),
  subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
  grade: row.grade === null || row.grade === undefined ? null : String(row.grade),
});

export const createStudentCourseAccessRouter = (deps: StudentCourseAccessDeps): Router => {
  const router = Router();
  const { getConnection, query: readQuery } = deps;
  const deliverMaterialFile = createMaterialFileDeliveryService({ getConnection, config: deps.materialFileDelivery });

  /**
   * The student authority proof.
   *
   * Returns the principal's own enrollment row, or null. The predicate is
   * deliberately the SAME shape the authentication repository uses, so a
   * principal that was valid when the token was issued but has since been
   * revoked, un-approved, suspended, or pushed outside its enrollment window
   * stops resolving here as well.
   */
  const verifyEnrollment = verifyStudentEnrollment;

  /**
   * The course authority proof.
   *
   * Three independent facts, all required, all read from rows:
   *   1. this enrollment holds an ACTIVE `student_courses` row for the course;
   *   2. the course is active and PUBLISHED in the principal's own tenant;
   *   3. the tenant resolved by the enrollment proof is the one that owns it.
   *
   * Any failure is the caller's ONE 404 — a foreign course, a draft course, a
   * course of another academy and a course that does not exist are the same
   * answer.
   */
  const resolveCourse = resolveStudentCourse;

  /**
   * Reject a client-supplied authority selector.
   *
   * The student boundary middleware already refuses most of these, but this
   * router also refuses them itself: a request that names a tenant, a student,
   * an enrollment or a workspace is a request that is trying to choose its own
   * authority, and it is answered before a connection is taken.
   */
  const suppliedSelector = (req: AuthRequest): string | null => {
    const keys = ['tenant_id', 'tenantId', 'tenant', 'student_id', 'studentId', 'student_enrollment_id', 'studentEnrollmentId', 'enrollment_id', 'instructor_id', 'group_id'];
    for (const key of keys) {
      if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && Object.prototype.hasOwnProperty.call(req.body, key)) {
        return key;
      }
      if (req.query && Object.prototype.hasOwnProperty.call(req.query, key)) return key;
    }
    const headerNames = ['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'];
    for (const header of headerNames) {
      const value = req.headers?.[header];
      if (value !== undefined && String(value) !== '') return header;
    }
    return null;
  };

  interface TxResult {
    status: number;
    body: any;
    /** True only when the work must be committed; reads, denials and no-ops roll back. */
    commit: boolean;
  }

  /**
   * Run one request's statements on ONE connection inside ONE transaction, and
   * dispose of that connection exactly once.
   *
   * Commit failure is UNCERTAIN: the acknowledgement was lost, so whether the
   * write persisted is unknown. It is never reported as success, never retried
   * blindly, and the physical connection is destroyed instead of being returned
   * to the pool where a later request could inherit an unknown transaction
   * state.
   */
  const runInTransaction = async (
    label: string,
    res: Response,
    work: (connection: StudentCourseAccessConnection) => Promise<TxResult>
  ): Promise<any> => {
    let connection: StudentCourseAccessConnection | null = null;
    let transactionStarted = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
      if (!connection) return;
      try {
        await connection.rollback();
      } catch (rollbackError) {
        disposal = 'destroy';
        console.error(`${label} rollback error:`, rollbackError);
      }
    };

    try {
      connection = await getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      if (!result.commit) {
        await rollbackOrDiscard();
        return res.status(result.status).json(result.body);
      }
      commitAttempted = true;
      await connection.commit();
      return res.status(result.status).json(result.body);
    } catch (error) {
      if (commitAttempted) {
        disposal = 'destroy';
        console.error(`${label} error after commit attempt (persistence uncertain):`, error);
      } else if (transactionStarted) {
        console.error(`${label} error:`, error);
        await rollbackOrDiscard();
      } else {
        disposal = 'destroy';
        console.error(`${label} error before transaction start:`, error);
      }
      return res.status(500).json({ error: label });
    } finally {
      if (connection) {
        if (disposal === 'destroy') {
          try { connection.destroy(); } catch { /* connection already gone */ }
        } else {
          try { connection.release(); } catch { /* connection already released */ }
        }
      }
    }
  };

  /**
   * The common principal gate.
   *
   * Returns `{ userId, tenantId, enrollmentId }` when the request is a student
   * request that already carries a selected workspace, or sends the denial and
   * returns null.
   */
  const requireStudentScope = (
    req: AuthRequest,
    res: Response
  ): { userId: string; tenantId: string; enrollmentId: string } | null => {
    const principal = req.user;
    if (!principal) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    if (principal.role !== 'student') {
      res.status(403).json({ error: 'Student access required' });
      return null;
    }
    if (!principal.tenantId || !principal.studentEnrollmentId) {
      res.status(409).json({ error: 'Select an instructor workspace first', code: 'STUDENT_SPACE_REQUIRED' });
      return null;
    }
    return {
      userId: String(principal.id),
      tenantId: String(principal.tenantId),
      enrollmentId: String(principal.studentEnrollmentId),
    };
  };

  // -------------------------------------------------------------------------
  // GET /courses — the courses this enrollment may open
  // -------------------------------------------------------------------------
  router.get('/courses', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const selector = suppliedSelector(req);
    if (selector !== null) {
      return res.status(400).json({ error: 'Workspace context is resolved from the authenticated session' });
    }
    const scope = requireStudentScope(req, res);
    if (!scope) return;

    // The enrollment proof runs on the pool for this read: it is a single
    // bounded statement and the list itself is independently filtered by the
    // same tenant and enrollment, so a revoked enrollment still yields nothing.
    try {
      const [enrollment] = await readQuery<any>(
        `SELECT s.id AS enrollment_id,s.tenant_id
         FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
         WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.is_active=1
           AND s.approval_status='approved' AND t.status='active'
           AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
           AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
           AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
         LIMIT 1`,
        [scope.enrollmentId, scope.userId, scope.tenantId]
      );
      if (!enrollment) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      const rows = await readQuery<any>(
        `SELECT c.id AS course_id,c.name,c.subject,c.grade
         FROM student_courses sc
         INNER JOIN courses c ON c.id=sc.course_id
         WHERE sc.student_id=? AND sc.status='active'
           AND c.tenant_id=? AND c.is_active=TRUE AND c.publication_state='published'
         ORDER BY c.name ASC,c.id ASC
         LIMIT ?`,
        [scope.enrollmentId, scope.tenantId, COURSE_LIST_MAX + 1]
      );
      const page = rows ?? [];
      const truncated = page.length > COURSE_LIST_MAX;
      const visible = truncated ? page.slice(0, COURSE_LIST_MAX) : page;
      return res.status(200).json({
        courses: visible.map(courseHeader),
        truncated,
      });
    } catch (error) {
      console.error('List student courses error:', error);
      return res.status(500).json({ error: 'Failed to load courses' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /courses/:courseId — the fixed learning path
  // -------------------------------------------------------------------------
  router.get('/courses/:courseId', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const selector = suppliedSelector(req);
    if (selector !== null) {
      return res.status(400).json({ error: 'Workspace context is resolved from the authenticated session' });
    }
    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(404).json({ error: 'Course not found' });
    }
    const scope = requireStudentScope(req, res);
    if (!scope) return;

    return runInTransaction('Failed to load learning path', res, async (connection) => {
      const enrollment = await verifyEnrollment(connection, scope.userId, scope.enrollmentId, scope.tenantId);
      if (!enrollment) return { status: 404, body: { error: 'Course not found' }, commit: false };

      const course = await resolveCourse(connection, scope.enrollmentId, courseId, scope.tenantId);
      if (!course) return { status: 404, body: { error: 'Course not found' }, commit: false };

      // ONE bounded statement: every active unit of the course with its active
      // lessons, each already carrying the DATABASE's own access decision.
      //
      // `is_released` compares two EPOCH values, never a TIMESTAMP column against
      // a UTC wall clock. `release_at` is a TIMESTAMP, and MySQL converts a
      // TIMESTAMP to the SESSION time zone before comparing it with a DATETIME, so
      // `release_at <= UTC_TIMESTAMP()` would only be correct on a session whose
      // `time_zone` happens to be UTC — and nothing in this application sets it
      // (the mysql2 pool's `timezone:'+02:00'` is a CLIENT-side decoder option, not
      // a `SET SESSION time_zone`). `UNIX_TIMESTAMP(col)` and the no-argument
      // `UNIX_TIMESTAMP()` both yield absolute epoch seconds, so the decision is
      // the same on every session offset and across a DST transition.
      //
      // The instant still comes from the DATABASE clock, not from the application
      // process and never from the client, so a skewed client clock cannot open a
      // scheduled lesson early.
      //
      // The completion join is on the PRINCIPAL'S OWN enrollment id, so a
      // completion belonging to another student — or to the same human at
      // another academy — can never unlock anything here.
      const [rows] = await connection.execute(
        `SELECT u.id AS unit_id,u.name AS unit_name,u.display_order AS unit_display_order,
                l.id AS lesson_id,l.title,l.display_order AS lesson_display_order,
                SUBSTRING(l.description,1,${DESCRIPTION_MAX}) AS lesson_description,
                UNIX_TIMESTAMP(l.release_at) AS release_at_epoch,
                l.prerequisite_lesson_id,
                (l.release_at IS NULL OR UNIX_TIMESTAMP(l.release_at)<=UNIX_TIMESTAMP()) AS is_released,
                (l.prerequisite_lesson_id IS NULL OR EXISTS (
                    SELECT 1 FROM course_lesson_completions clc
                    WHERE clc.lesson_id=l.prerequisite_lesson_id
                      AND clc.student_enrollment_id=?
                )) AS is_prerequisite_met,
                UNIX_TIMESTAMP(clc2.completed_at) AS completed_at_epoch
         FROM course_units u
         INNER JOIN course_lessons l ON l.unit_id=u.id
         LEFT JOIN course_lesson_completions clc2
           ON clc2.lesson_id=l.id AND clc2.student_enrollment_id=?
         WHERE u.course_id=? AND u.status='active' AND l.status='active'
         ORDER BY u.display_order ASC,u.id ASC,l.display_order ASC,l.id ASC
         LIMIT ?`,
        [scope.enrollmentId, scope.enrollmentId, courseId, PATH_MAX_LESSONS + 1]
      );

      const all = (rows as any[]) ?? [];
      const truncated = all.length > PATH_MAX_LESSONS;
      const visible = truncated ? all.slice(0, PATH_MAX_LESSONS) : all;

      const units: UnitView[] = [];
      let current: UnitView | null = null;
      for (const row of visible) {
        const releaseAt = optionalInstant(row.release_at_epoch);
        if (releaseAt === undefined) {
          console.error('Load learning path error: unreadable lesson release projection');
          return { status: 500, body: { error: 'Failed to load learning path' }, commit: false };
        }
        const completedAt = optionalInstant(row.completed_at_epoch);
        if (completedAt === undefined) {
          console.error('Load learning path error: unreadable completion projection');
          return { status: 500, body: { error: 'Failed to load learning path' }, commit: false };
        }

        // Release is checked FIRST: an unreleased lesson is withheld whatever
        // its prerequisite says, and the reason names the nearer blocker.
        let lockReason: LockReason | null = null;
        if (!isTrue(row.is_released)) lockReason = 'not_released';
        else if (!isTrue(row.is_prerequisite_met)) lockReason = 'prerequisite_incomplete';
        const accessible = lockReason === null;

        const unitId = String(row.unit_id);
        if (!current || current.unit_id !== unitId) {
          current = {
            unit_id: unitId,
            name: String(row.unit_name),
            display_order: Number(row.unit_display_order),
            lessons: [],
          };
          units.push(current);
        }

        current.lessons.push({
          lesson_id: String(row.lesson_id),
          title: String(row.title),
          display_order: Number(row.lesson_display_order),
          release_at: releaseAt,
          prerequisite_lesson_id:
            row.prerequisite_lesson_id === null || row.prerequisite_lesson_id === undefined
              ? null
              : String(row.prerequisite_lesson_id),
          accessible,
          lock_reason: lockReason,
          completed: completedAt !== null,
          completed_at: completedAt,
          // The description is withheld from a locked lesson in the DTO itself,
          // so it is absent from the serialized body rather than merely hidden
          // by the renderer.
          description: accessible && row.lesson_description !== null && row.lesson_description !== undefined
            ? String(row.lesson_description)
            : null,
        });
      }

      return {
        status: 200,
        body: { course: courseHeader(course), units, truncated },
        commit: false,
      };
    });
  });

  // -------------------------------------------------------------------------
  // POST /courses/:courseId/lessons/:lessonId/completion
  // -------------------------------------------------------------------------
  router.post('/courses/:courseId/lessons/:lessonId/completion', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const selector = suppliedSelector(req);
    if (selector !== null) {
      return res.status(400).json({ error: 'Workspace context is resolved from the authenticated session' });
    }
    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) {
      return res.status(404).json({ error: 'Course not found' });
    }
    const lessonId = String(req.params?.lessonId ?? '');
    if (!UUID_PATTERN.test(lessonId)) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    // The body is strictly EMPTY: completion is a fact with no attributes, so a
    // payload that carries anything is a payload that is trying to state
    // authority or an instant. It is refused before a connection is taken.
    const body = req.body;
    if (body !== undefined && body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Invalid completion payload' });
      }
      if (Object.keys(body).length > 0) {
        return res.status(400).json({ error: 'Invalid completion payload' });
      }
    }
    const scope = requireStudentScope(req, res);
    if (!scope) return;

    return runInTransaction('Failed to record lesson completion', res, async (connection) => {
      const enrollment = await verifyEnrollment(connection, scope.userId, scope.enrollmentId, scope.tenantId);
      if (!enrollment) return { status: 404, body: { error: 'Course not found' }, commit: false };

      const course = await resolveCourse(connection, scope.enrollmentId, courseId, scope.tenantId);
      if (!course) return { status: 404, body: { error: 'Course not found' }, commit: false };

      // The lesson must be an ACTIVE lesson of an ACTIVE unit of THIS course,
      // and it is locked for the write so a concurrent archive or reorder
      // cannot race the eligibility decision.
      //
      // `is_released` is the same EPOCH comparison as the path read, for the same
      // reason: a TIMESTAMP compared with `UTC_TIMESTAMP()` depends on the SQL
      // session time zone, which this application never pins.
      const [lessonRows] = await connection.execute(
        `SELECT l.id,l.status,UNIX_TIMESTAMP(l.release_at) AS release_at_epoch,
                l.prerequisite_lesson_id,
                (l.release_at IS NULL OR UNIX_TIMESTAMP(l.release_at)<=UNIX_TIMESTAMP()) AS is_released
         FROM course_lessons l
         INNER JOIN course_units u ON u.id=l.unit_id AND u.course_id=? AND u.status='active'
         WHERE l.id=? AND l.status='active'
         LIMIT 1
         FOR UPDATE`,
        [courseId, lessonId]
      );
      const lesson = ((lessonRows as any[]) ?? [])[0];
      // A lesson of another course, an archived lesson and an absent lesson are
      // the same answer.
      if (!lesson) return { status: 404, body: { error: 'Lesson not found' }, commit: false };

      if (!isTrue(lesson.is_released)) {
        return {
          status: 409,
          body: { error: 'Lesson is not accessible yet', code: 'LESSON_LOCKED', reason: 'not_released' },
          commit: false,
        };
      }

      const prerequisiteId =
        lesson.prerequisite_lesson_id === null || lesson.prerequisite_lesson_id === undefined
          ? null
          : String(lesson.prerequisite_lesson_id);
      if (prerequisiteId !== null) {
        const [prerequisiteRows] = await connection.execute(
          `SELECT id FROM course_lesson_completions
           WHERE student_enrollment_id=? AND lesson_id=? LIMIT 1`,
          [scope.enrollmentId, prerequisiteId]
        );
        if (!(((prerequisiteRows as any[]) ?? [])[0])) {
          return {
            status: 409,
            body: { error: 'Lesson is not accessible yet', code: 'LESSON_LOCKED', reason: 'prerequisite_incomplete' },
            commit: false,
          };
        }
      }

      // An existing completion is returned AS STORED. `FOR UPDATE` on the
      // unique key takes the row (or a gap) lock, so a concurrent second
      // completion serializes here instead of racing the insert.
      const [existingRows] = await connection.execute(
        `SELECT id,UNIX_TIMESTAMP(completed_at) AS completed_at_epoch
         FROM course_lesson_completions
         WHERE student_enrollment_id=? AND lesson_id=? LIMIT 1
         FOR UPDATE`,
        [scope.enrollmentId, lessonId]
      );
      const existing = ((existingRows as any[]) ?? [])[0];
      if (existing) {
        const completedAt = optionalInstant(existing.completed_at_epoch);
        if (completedAt === undefined) {
          console.error('Record lesson completion error: unreadable stored completion instant');
          return { status: 500, body: { error: 'Failed to record lesson completion' }, commit: false };
        }
        // Truthful no-op: nothing is written, nothing is audited, and the
        // ORIGINAL instant is returned unchanged.
        return { status: 200, body: { completion: { lesson_id: lessonId, completed_at: completedAt } }, commit: false };
      }

      // `completed_at` is deliberately NOT supplied: the column default
      // `CURRENT_TIMESTAMP` is the DATABASE clock, which is the only authority
      // this batch accepts for a completion instant.
      const completionId = randomUUID();
      await connection.execute(
        `INSERT INTO course_lesson_completions (id,student_enrollment_id,lesson_id) VALUES (?,?,?)`,
        [completionId, scope.enrollmentId, lessonId]
      );
      const [readRows] = await connection.execute(
        `SELECT id,UNIX_TIMESTAMP(completed_at) AS completed_at_epoch
         FROM course_lesson_completions WHERE id=? LIMIT 1`,
        [completionId]
      );
      const stored = ((readRows as any[]) ?? [])[0];
      if (!stored) {
        return { status: 500, body: { error: 'Failed to record lesson completion' }, commit: false };
      }
      const completedAt = optionalInstant(stored.completed_at_epoch);
      if (completedAt === undefined) {
        console.error('Record lesson completion error: unreadable stored completion instant');
        return { status: 500, body: { error: 'Failed to record lesson completion' }, commit: false };
      }
      return { status: 200, body: { completion: { lesson_id: lessonId, completed_at: completedAt } }, commit: true };
    });
  });

  // Shared authority for metadata and the two fresh file-delivery snapshots.
  const readAccessibleLessonContents = async (connection: StudentCourseAccessConnection,
    scope: { userId: string; tenantId: string; enrollmentId: string }, courseId: string, lessonId: string,
    principal: NonNullable<AuthRequest['user']>, includeReadiness = true): Promise<TxResult> => {
      const proof = await proveStudentLesson(connection, scope, courseId, lessonId);
      if (!proof.ok) return proof;
      return listStudentLessonMaterials(connection, scope, courseId, String(proof.lesson.id), principal, includeReadiness ? deps.materialFileDelivery : undefined);
  };

  router.get('/courses/:courseId/lessons/:lessonId/support-context', async (req:AuthRequest,res:Response) => {
    res.set('Cache-Control','no-store');
    if(suppliedSelector(req)!==null||Object.keys(req.query??{}).length||req.body&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))return res.status(400).json({error:'Invalid lesson support context request'});
    const scope=requireStudentScope(req,res);if(!scope)return;
    const {courseId,lessonId}=req.params;
    if(!UUID_PATTERN.test(courseId)||!UUID_PATTERN.test(lessonId))return res.status(404).json({error:'Lesson not found'});
    return runInTransaction('Failed to load lesson support context',res,async connection=>{
      if(!await supportContextSchema(connection))return {status:503,body:{error:'Lesson support context unavailable',code:'SUPPORT_CONTEXT_UNAVAILABLE'},commit:false};
      const proof=await proveLessonSupportContext(connection,scope,{kind:'catalog_lesson',course_id:courseId,lesson_id:lessonId});
      return proof.ok?{status:200,body:{context:proof.context},commit:false}:proof;
    });
  });

  router.get('/courses/:courseId/lessons/:lessonId/videos',async(req:AuthRequest,res:Response)=>{
    res.set('Cache-Control','no-store');
    if(suppliedSelector(req)!==null||Object.keys(req.query??{}).length||req.body&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))return res.status(400).json({error:'Invalid lesson videos request'});
    const scope=requireStudentScope(req,res);if(!scope)return;
    const {courseId,lessonId}=req.params;if(!UUID_PATTERN.test(courseId)||!UUID_PATTERN.test(lessonId))return res.status(404).json({error:'Lesson not found'});
    return runInTransaction('Failed to load lesson videos',res,connection=>listStudentLessonVideos(connection,scope,courseId,lessonId,req.user!));
  });

  // J02/J03: explicit lesson expansion; never widens the strict learning-path DTO.
  const contentsPath = '/courses/:courseId/lessons/:lessonId/contents';
  for (const file of [false, true]) router.get(contentsPath + (file ? '/:contentId/file' : ''), async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (suppliedSelector(req) !== null || Object.keys(req.query ?? {}).length
      || req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
      return res.status(400).json({ error: 'Invalid lesson contents request' });
    }
    const scope = requireStudentScope(req, res); if (!scope) return;
    const { courseId, lessonId, contentId } = req.params;
    if (!UUID_PATTERN.test(courseId) || !UUID_PATTERN.test(lessonId) || file && !UUID_PATTERN.test(contentId)) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    if (!file) return runInTransaction('Failed to load lesson contents', res,
      connection => readAccessibleLessonContents(connection, scope, courseId, lessonId, req.user!));
    if (req.headers.range || req.headers['if-range']) return res.status(416).json({ error: 'Partial material downloads are unsupported' });
    const abort = new AbortController();
    const cancel = () => abort.abort();
    req.once?.('aborted', cancel); res.once?.('close', cancel);
    try {
      const result = await deliverMaterialFile({ courseId, lessonId, contentId, tenantId: scope.tenantId, signal: abort.signal,
        authorize: connection => readAccessibleLessonContents(connection, scope, courseId, lessonId, req.user!, false) });
      if (abort.signal.aborted || res.destroyed) { if (result.ok) result.release(); return; }
      if (!result.ok) return res.status(result.status).json(result.body);
      // Retain the bounded memory/response lease until HTTP finishes or closes.
      res.once('finish', result.release); res.once('close', result.release);
      try {
        res.set('Content-Type', 'application/pdf'); res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', 'sandbox');
        res.set('Content-Disposition', `attachment; filename="lesson-material-${result.fileId}.pdf"`);
        res.set('Content-Length', String(result.bytes.length));
        // Native end avoids Express.send's automatic ETag/conditional 304 path.
        res.removeHeader('ETag'); res.removeHeader('Last-Modified');
        return res.status(200).end(result.bytes);
      } catch {
        result.release();
        if (!res.headersSent) {
          res.removeHeader('Content-Length'); res.removeHeader('Content-Disposition'); res.removeHeader('Content-Type');
          return res.status(503).json({ error: 'Private material file delivery unavailable', code: 'MATERIAL_FILE_UNAVAILABLE' });
        }
        res.destroy();
      }
    } finally { req.removeListener?.('aborted', cancel); res.removeListener?.('close', cancel); }
  });

  return router;
};

export default createStudentCourseAccessRouter({
  query,
  getConnection: async () => getPool().getConnection(),
});
