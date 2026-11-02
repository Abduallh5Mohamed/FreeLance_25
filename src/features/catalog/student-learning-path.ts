/**
 * M2-23 — the SERVER-AUTHORITATIVE student learning path.
 *
 * This module is the production seam behind `src/pages/StudentContent.tsx`. It
 * replaces the previous localStorage-derived "student + material" selector with
 * the only identity and the only access decisions the platform actually has:
 * the authenticated student enrollment carried by the session token, and the
 * server's own projection of the released/unlocked lessons of one enrolled,
 * published course.
 *
 * It owns the WHOLE lifecycle (explicit open, one bounded course list, one
 * bounded learning path, ONE completion write at a time, runtime DTO
 * validation, stale-reply invalidation, session and disposal fences) and keeps
 * React rendering out of the decision path. The transport, the principal reader
 * and the session notifier are INJECTED, so the exact production code the page
 * runs is exercised hermetically in node:test
 * (src/tests/m2-student-learning-path.test.ts) with no DB, no network, no
 * browser and no live app.
 *
 * Contract verified from source (docs/streams/server/M2-B15-CONTRACT.md,
 * server/src/routes/student-course-access.ts):
 *  - `GET /api/student-course-access/courses` answers
 *    `{ courses: [{ course_id, name, subject, grade }], truncated }` — exactly
 *    the four documented keys per course, bounded to 100 rows;
 *  - `GET /api/student-course-access/courses/:courseId` answers
 *    `{ course: {…}, units: [{ unit_id, name, display_order, lessons: [...] }],
 *    truncated }`; each lesson is exactly the ten documented fields
 *    `{ lesson_id, title, display_order, release_at, prerequisite_lesson_id,
 *    accessible, lock_reason, completed, completed_at, description }`, ordered
 *    by `(unit.display_order, unit.id, lesson.display_order, lesson.id)`, with
 *    at most 500 lessons in total;
 *  - `POST /api/student-course-access/courses/:courseId/lessons/:lessonId/completion`
 *    takes an EMPTY object body and answers `{ completion: { lesson_id,
 *    completed_at } }` with the SERVER's instant; a retry answers the ORIGINAL
 *    instant and writes nothing;
 *  - every decision is the server's: enrollment, workspace selection,
 *    publication, release instant, prerequisite completion and lock reason. The
 *    client never sends a tenant, student or enrollment selector, never creates
 *    an enrollment, and never decides that a lesson is unlocked;
 *  - the documented refusals are 401 `Authentication required` (plus the
 *    upstream `Token expired` / `Invalid token` / `No token provided` /
 *    `Session revoked` / `Selected workspace is no longer active`), 403
 *    `Student access required`, 409 `Select an instructor workspace first`, 400
 *    `Workspace context is resolved from the authenticated session` and
 *    `Invalid completion payload`, 404 `Workspace not found` / `Course not
 *    found` / `Lesson not found`, 409 `Lesson is not accessible yet`, and 500
 *    `Failed to load courses` / `Failed to load learning path` / `Failed to
 *    record lesson completion`;
 *  - the shared transport throws the server's `error` message WITHOUT the HTTP
 *    status and WITHOUT the `code`, so ONLY the documented messages classify an
 *    outcome. No status is fabricated and a discarded `code` never becomes a
 *    permission outcome;
 *  - the accepted migration FILE is NOT applied here: a real deployment answers
 *    a truthful error and no client-side fallback data is invented.
 *
 * Honesty rules that are part of the contract:
 *  - a 2xx body that cannot be validated is NOT a success: an extra key, a
 *    missing key, a malformed id, a non-canonical instant, an impossible
 *    accessibility/lock pairing, a duplicate id or an oversized page is a
 *    MALFORMED response, and no row of it is kept;
 *  - a locked or unreleased lesson is rendered HONESTLY: it keeps its title, its
 *    position and its lock reason, and the server already withholds its private
 *    description. The page therefore never has a description to leak, and this
 *    module refuses a body that claims a description for a locked lesson;
 *  - a confirmed completion uses the validated server envelope ONLY. The
 *    matching lesson is marked completed with the SERVER's instant; whether that
 *    unlocks the NEXT lesson is re-read from the server, never inferred here;
 *  - a 500/network/malformed write outcome is UNCERTAIN: the completion may have
 *    persisted, nothing is retried automatically, and a deliberate read-only
 *    reconciliation is offered. The re-read path is the CURRENT state, never
 *    proof of the earlier write.
 *
 * Lifetimes fenced here:
 *  - session: the canonical principal is re-read at entry AND at completion of
 *    every read and write, on the success and the failure path, and a retired
 *    operation observes it BEFORE it settles any visible state. A session change
 *    clears the courses, the path, the selection and the mutation and retires
 *    everything in flight, so a silent logout can never leave the previous
 *    student's path on screen;
 *  - course: the path is bound to ONE course id. Selecting another course
 *    invalidates every in-flight reply BEFORE the new read starts, and the old
 *    path is dropped immediately, so one course's lessons can never be shown
 *    under another course's header;
 *  - request: every read and write advances its own generation. A reply commits
 *    only while its generation is still current, its principal still matches and
 *    the controller is not disposed;
 *  - write: ONE completion write at a time. The single-flight latch is taken
 *    SYNCHRONOUSLY before the first await, so a double click or a click+Enter
 *    never sends a second write, and an older `finally` can never release a
 *    newer write's latch. The latch is released as soon as the server CONFIRMS
 *    the completion — before the bounded follow-up read — so an enabled control
 *    is never a silent no-op;
 *  - dispose: disposal clears the courses, the path, the selection and the
 *    mutation, retires every in-flight reply and resolves `waitForIdle()`.
 *
 * Out of scope by construction: no new route, no migration application, no OTP,
 * no signup, no enrollment/payment/subscription creation, no lesson content
 * delivery, and no student/material selector derived from localStorage. The
 * course id is a RESOURCE id chosen from the server's own enrolled list, never a
 * tenant or student authority.
 */
import {
  type StudentCompletion,
  type StudentCompletionEnvelope,
  type StudentCourseListEnvelope,
  type StudentCourseSummary,
  type StudentLearningPathEnvelope,
  type StudentLesson,
  type StudentLessonLockReason,
  type StudentUnit,
} from '../../lib/api-http';
import { createCourseOperationGuard, createTicketSource } from './course-management';

/**
 * The canonical session reader the courses page already uses. Re-exported so
 * the student page imports ONE principal boundary: there is exactly one
 * localStorage lifetime in the app.
 */
export { readCourseSessionPrincipal } from './course-management';
export type { CourseSessionStorage } from './course-management';

// ---------------------------------------------------------------------------
// Bounds — the server's own limits, restated so a reply is validated BEFORE any
// row of it is traversed, copied or held
// ---------------------------------------------------------------------------

/** The server's bounded course list. */
export const STUDENT_COURSE_LIST_MAX = 100;

/** The server's bounded learning path, in lessons. */
export const STUDENT_PATH_MAX_LESSONS = 500;

/** The server's bounded lesson description. */
export const STUDENT_LESSON_DESCRIPTION_MAX = 600;

/** A lesson title and a course/unit name are trimmed labels of 1..255. */
export const STUDENT_LABEL_MAX = 255;

/** `display_order` is a nonnegative signed 32-bit integer. */
export const STUDENT_DISPLAY_ORDER_MAX = 2147483647;

// ---------------------------------------------------------------------------
// Wording — local only; the server never sends any of these strings
// ---------------------------------------------------------------------------

/** A body that is not the documented envelope. Never a success. */
export const STUDENT_PATH_MALFORMED_MESSAGE = 'استجابة غير صالحة من الخادم';

/** The session is gone: the private path is cleared. */
export const STUDENT_PATH_UNAUTHORIZED_MESSAGE =
  'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض مسار التعلّم.';

/** The authenticated principal is not a student. */
export const STUDENT_PATH_FORBIDDEN_MESSAGE =
  'مسار التعلّم متاح لحساب تلميذ مسجَّل فقط؛ الخادم هو المرجع.';

/** No authorized workspace is selected for this account. */
export const STUDENT_PATH_NO_WORKSPACE_MESSAGE =
  'اختر مساحة عمل المدرّس أولًا؛ مسار التعلّم يُقرأ داخل مساحة عمل مصرّح بها.';

/** The course is not enrolled, not published or not active. */
export const STUDENT_PATH_MISSING_COURSE_MESSAGE =
  'هذا الكورس غير متاح في مسارك: قد لا تكون مسجّلًا فيه أو لم يُنشر بعد.';

/** A retryable read failure. No permission loss was proven. */
export const STUDENT_PATH_ERROR_MESSAGE = 'تعذّر تحميل مسار التعلّم. أعد المحاولة.';

/** A selector was supplied: the workspace is resolved from the session only. */
export const STUDENT_PATH_SELECTOR_REFUSED_MESSAGE =
  'سياق مساحة العمل يُحدَّد من الجلسة المصادَق عليها فقط، ولا يُرسل من الصفحة.';

/** A completion was requested for a lesson that is not in the shown path. */
export const STUDENT_PATH_UNKNOWN_LESSON_MESSAGE =
  'هذا الدرس ليس ضمن المسار المعروض؛ أعد تحميل المسار.';

/** The server confirmed the completion with its own instant. */
export const STUDENT_COMPLETION_CONFIRMED_MESSAGE =
  'تم تسجيل إتمام الدرس بتوقيت الخادم. ما يفتحه هذا الإتمام يُقرأ من الخادم.';

/** The server refused because the lesson is not accessible yet. */
export const STUDENT_COMPLETION_LOCKED_MESSAGE =
  'لا يمكن إتمام هذا الدرس قبل إتاحته واستيفاء الدرس السابق.';

/** The completion may or may not have persisted. Nothing is retried. */
export const STUDENT_COMPLETION_UNCERTAIN_MESSAGE =
  'لم يتم تأكيد تسجيل الإتمام. قد يكون محفوظًا على الخادم؛ أعد قراءة المسار للمطابقة. لن تُعاد المحاولة تلقائيًا.';

/** The deliberate read-only reconciliation after an uncertain write. */
export const STUDENT_COMPLETION_RECONCILED_MESSAGE =
  'تم عرض المسار الحالي من الخادم. هذا لا يؤكد نجاح محاولة الإتمام السابقة.';

/** Lock wording. The REASON is the server's; these only phrase it. */
export const STUDENT_LOCK_NOT_RELEASED_MESSAGE = 'لم يُتح بعد.';
export const STUDENT_LOCK_PREREQUISITE_MESSAGE = 'أكمل الدرس السابق أولًا.';

// ---------------------------------------------------------------------------
// Strict DTO parsing — exactly the documented keys, nothing inferred
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The canonical instant the server emits: `Date#toISOString()` of the projected
 * epoch — exactly `YYYY-MM-DDTHH:MM:SS.sssZ`. Any other shape (a local wall
 * time, an offset, a date-only value, a bare epoch) is not the documented
 * projection, so it is a malformed response rather than a date to interpret.
 */
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A canonical instant must ALSO be a REAL instant. The shape alone would accept
 * impossible and calendar-overflow values, and the server never emits them, so
 * the value must round-trip EXACTLY back to the same string. There is no
 * fallback date and no coerced value.
 */
const isCanonicalInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !CANONICAL_ISO_PATTERN.test(value)) return false;
  const instant = new Date(value);
  const time = instant.getTime();
  if (!Number.isFinite(time)) return false;
  return instant.toISOString() === value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The exact key set, sorted. An extra or a missing key is a malformed body. */
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) return false;
  }
  return true;
};

const canonicalId = (value: unknown): string | null => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
};

const label = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  if (value.length < 1 || value.length > STUDENT_LABEL_MAX) return null;
  if (value.trim().length === 0) return null;
  return value;
};

const optionalLabel = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  const parsed = label(value);
  return parsed === null ? undefined : parsed;
};

const displayOrder = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > STUDENT_DISPLAY_ORDER_MAX) return null;
  return value;
};

const LOCK_REASONS: ReadonlySet<string> = new Set(['not_released', 'prerequisite_incomplete']);

const COURSE_KEYS = ['course_id', 'grade', 'name', 'subject'] as const;
const LESSON_KEYS = [
  'accessible',
  'completed',
  'completed_at',
  'description',
  'display_order',
  'lesson_id',
  'lock_reason',
  'prerequisite_lesson_id',
  'release_at',
  'title',
] as const;
const UNIT_KEYS = ['display_order', 'lessons', 'name', 'unit_id'] as const;
const COURSE_LIST_KEYS = ['courses', 'truncated'] as const;
const PATH_KEYS = ['course', 'truncated', 'units'] as const;
const COMPLETION_ENVELOPE_KEYS = ['completion'] as const;
const COMPLETION_KEYS = ['completed_at', 'lesson_id'] as const;

/** One enrolled, published, active course. Exactly four keys. */
export function parseStudentCourseSummary(raw: unknown): StudentCourseSummary | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, COURSE_KEYS)) return null;
  const courseId = canonicalId(raw.course_id);
  const name = label(raw.name);
  const subject = optionalLabel(raw.subject);
  const grade = optionalLabel(raw.grade);
  if (courseId === null || name === null) return null;
  if (subject === undefined || grade === undefined) return null;
  return { course_id: courseId, name, subject, grade };
}

/**
 * One lesson of the path. Exactly ten keys, and the accessibility triple must be
 * internally consistent:
 *  - `accessible` is a real boolean;
 *  - an accessible lesson carries NO lock reason, and a locked one carries
 *    exactly one documented reason;
 *  - a locked lesson carries NO description, because the server withholds it —
 *    a body that leaks one is malformed and is refused whole;
 *  - `completed` and `completed_at` agree.
 */
export function parseStudentLesson(raw: unknown): StudentLesson | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, LESSON_KEYS)) return null;
  const lessonId = canonicalId(raw.lesson_id);
  const title = label(raw.title);
  const order = displayOrder(raw.display_order);
  if (lessonId === null || title === null || order === null) return null;
  if (typeof raw.accessible !== 'boolean' || typeof raw.completed !== 'boolean') return null;
  if (raw.release_at !== null && !isCanonicalInstant(raw.release_at)) return null;
  if (raw.completed_at !== null && !isCanonicalInstant(raw.completed_at)) return null;
  if (raw.description !== null) {
    if (typeof raw.description !== 'string') return null;
    if (raw.description.length > STUDENT_LESSON_DESCRIPTION_MAX) return null;
  }
  let prerequisiteLessonId: string | null = null;
  if (raw.prerequisite_lesson_id !== null) {
    prerequisiteLessonId = canonicalId(raw.prerequisite_lesson_id);
    if (prerequisiteLessonId === null) return null;
    // A lesson can never gate itself: the server refuses that edge, so a body
    // claiming it is not the documented projection.
    if (prerequisiteLessonId === lessonId) return null;
  }
  let lockReason: StudentLessonLockReason | null = null;
  if (raw.lock_reason !== null) {
    if (typeof raw.lock_reason !== 'string' || !LOCK_REASONS.has(raw.lock_reason)) return null;
    lockReason = raw.lock_reason as StudentLessonLockReason;
  }
  if (raw.accessible && lockReason !== null) return null;
  if (!raw.accessible && lockReason === null) return null;
  if (!raw.accessible && raw.description !== null) return null;
  if (raw.completed && raw.completed_at === null) return null;
  if (!raw.completed && raw.completed_at !== null) return null;
  return {
    lesson_id: lessonId,
    title,
    display_order: order,
    release_at: raw.release_at === null ? null : (raw.release_at as string),
    prerequisite_lesson_id: prerequisiteLessonId,
    accessible: raw.accessible,
    lock_reason: lockReason,
    completed: raw.completed,
    completed_at: raw.completed_at === null ? null : (raw.completed_at as string),
    description: raw.description === null ? null : (raw.description as string),
  };
}

/** One active unit of the path with its bounded lessons. Exactly four keys. */
export function parseStudentUnit(raw: unknown): StudentUnit | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, UNIT_KEYS)) return null;
  const unitId = canonicalId(raw.unit_id);
  const name = label(raw.name);
  const order = displayOrder(raw.display_order);
  if (unitId === null || name === null || order === null) return null;
  if (!Array.isArray(raw.lessons)) return null;
  const lessons: StudentLesson[] = [];
  for (const entry of raw.lessons) {
    const lesson = parseStudentLesson(entry);
    if (lesson === null) return null;
    lessons.push(lesson);
  }
  return { unit_id: unitId, name, display_order: order, lessons };
}

/** The bounded course list envelope. An oversized list is malformed, not held. */
export function parseStudentCourseListEnvelope(raw: unknown): StudentCourseListEnvelope | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, COURSE_LIST_KEYS)) return null;
  if (typeof raw.truncated !== 'boolean') return null;
  if (!Array.isArray(raw.courses)) return null;
  if (raw.courses.length > STUDENT_COURSE_LIST_MAX) return null;
  const courses: StudentCourseSummary[] = [];
  const seen = new Set<string>();
  for (const entry of raw.courses) {
    const course = parseStudentCourseSummary(entry);
    if (course === null) return null;
    if (seen.has(course.course_id)) return null;
    seen.add(course.course_id);
    courses.push(course);
  }
  return { courses, truncated: raw.truncated };
}

/**
 * The bounded learning path envelope. The lesson count is checked BEFORE any
 * row is copied, so an oversized path is never held in memory; a duplicate unit
 * or lesson id is malformed, because the server emits each row exactly once.
 */
export function parseStudentLearningPathEnvelope(
  raw: unknown,
): StudentLearningPathEnvelope | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, PATH_KEYS)) return null;
  if (typeof raw.truncated !== 'boolean') return null;
  const course = parseStudentCourseSummary(raw.course);
  if (course === null) return null;
  if (!Array.isArray(raw.units)) return null;
  const units: StudentUnit[] = [];
  const unitIds = new Set<string>();
  const lessonIds = new Set<string>();
  let lessonCount = 0;
  for (const entry of raw.units) {
    const unit = parseStudentUnit(entry);
    if (unit === null) return null;
    if (unitIds.has(unit.unit_id)) return null;
    unitIds.add(unit.unit_id);
    lessonCount += unit.lessons.length;
    if (lessonCount > STUDENT_PATH_MAX_LESSONS) return null;
    for (const lesson of unit.lessons) {
      if (lessonIds.has(lesson.lesson_id)) return null;
      lessonIds.add(lesson.lesson_id);
    }
    units.push(unit);
  }
  return { course, units, truncated: raw.truncated };
}

/**
 * The completion envelope, validated against the REQUESTED lesson: a body that
 * answers another lesson is not a success. `completed_at` must be the server's
 * canonical instant — the client never supplies one.
 */
export function parseStudentCompletionEnvelope(
  raw: unknown,
  expectedLessonId: string,
): StudentCompletion | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, COMPLETION_ENVELOPE_KEYS)) return null;
  const completion = raw.completion;
  if (!isPlainObject(completion) || !hasExactKeys(completion, COMPLETION_KEYS)) return null;
  const lessonId = canonicalId(completion.lesson_id);
  if (lessonId === null) return null;
  if (lessonId !== expectedLessonId.toLowerCase()) return null;
  if (!isCanonicalInstant(completion.completed_at)) return null;
  return { lesson_id: lessonId, completed_at: completion.completed_at };
}

// ---------------------------------------------------------------------------
// Failure classification — documented transported messages only
// ---------------------------------------------------------------------------

const SESSION_INVALID_MESSAGES: ReadonlySet<string> = new Set([
  'Token expired',
  'Invalid token',
  'No token provided',
  'Session revoked',
  'Selected workspace is no longer active',
  'Authentication required',
]);

const FORBIDDEN_MESSAGE = 'Student access required';
const NO_WORKSPACE_MESSAGES: ReadonlySet<string> = new Set([
  'Select an instructor workspace first',
  'Workspace not found',
]);
const SELECTOR_REFUSED_MESSAGE = 'Workspace context is resolved from the authenticated session';
const MISSING_COURSE_MESSAGE = 'Course not found';
const LOCKED_MESSAGE = 'Lesson is not accessible yet';

/** The transport throws the server's `error` string and nothing else. */
const messageOf = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type StudentCourseListPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'malformed'
  | 'error'
  | 'unauthorized'
  | 'forbidden'
  | 'no-workspace';

export type StudentLearningPathPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'malformed'
  | 'error'
  | 'unauthorized'
  | 'forbidden'
  | 'no-workspace'
  | 'missing-course';

export interface StudentCompletionMutationState {
  status: 'idle' | 'saving' | 'saved' | 'failed' | 'uncertain';
  /** The lesson the last attempt addressed. */
  lessonId: string | null;
  error: string | null;
  notice: string | null;
}

export interface StudentLearningPathState {
  /** True once the user explicitly opened the path. No request happens before. */
  open: boolean;
  /** The bounded enrolled/published course list. */
  courses: StudentCourseSummary[];
  coursesPhase: StudentCourseListPhase;
  coursesError: string | null;
  coursesTruncated: boolean;
  /** The course whose path is shown, or null when none is selected. */
  courseId: string | null;
  /** The bounded learning path of `courseId`. */
  course: StudentCourseSummary | null;
  units: StudentUnit[];
  truncated: boolean;
  phase: StudentLearningPathPhase;
  error: string | null;
  /**
   * A failed follow-up read AFTER a confirmed completion. It never turns the
   * confirmed completion into a failure: the completion and the path survive and
   * only this note reports the failed refresh.
   */
  refreshError: string | null;
  /** The last server-confirmed completion (its instant is the server's). */
  lastCompletion: StudentCompletion | null;
  mutation: StudentCompletionMutationState;
}

const idleMutation = (): StudentCompletionMutationState => ({
  status: 'idle',
  lessonId: null,
  error: null,
  notice: null,
});

const initialState: StudentLearningPathState = {
  open: false,
  courses: [],
  coursesPhase: 'idle',
  coursesError: null,
  coursesTruncated: false,
  courseId: null,
  course: null,
  units: [],
  truncated: false,
  phase: 'idle',
  error: null,
  refreshError: null,
  lastCompletion: null,
  mutation: idleMutation(),
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface StudentLearningPathApi {
  listCourses: () => Promise<StudentCourseListEnvelope>;
  getPath: (courseId: string) => Promise<StudentLearningPathEnvelope>;
  completeLesson: (courseId: string, lessonId: string) => Promise<StudentCompletionEnvelope>;
  readPrincipal?: () => string | null;
  subscribeSession?: (listener: () => void) => () => void;
}

export interface StudentLearningPathController {
  getState(): StudentLearningPathState;
  subscribe(listener: (state: StudentLearningPathState) => void): () => void;
  /** Explicit open: the bounded course list, then the first course's path. */
  open(): Promise<void>;
  /** A deliberate re-read of the course list (never a write). */
  refreshCourses(): Promise<void>;
  /** Selects one course of the list and reads ITS path. */
  selectCourse(courseId: string): Promise<void>;
  /** A deliberate re-read of the CURRENT course path (never a write). */
  refreshPath(): Promise<void>;
  /** Marks ONE lesson complete. Single-flight; the server decides eligibility. */
  completeLesson(lessonId: string): Promise<void>;
  /** Deliberate read-only reconciliation after an uncertain write. */
  reconcile(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

type ReadOutcome = 'ok' | 'stale' | 'failed';

export function createStudentLearningPathController(
  api: StudentLearningPathApi,
): StudentLearningPathController {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(state: StudentLearningPathState) => void>();
  const pending = new Set<Promise<unknown>>();
  const tickets = createTicketSource();
  /** One bounded list read at a time (a deliberate course change bypasses it). */
  const readGuard = createCourseOperationGuard(tickets);
  /** ONE completion write at a time. */
  const writeGuard = createCourseOperationGuard(tickets);
  let readGeneration = 0;
  let writeGeneration = 0;
  let mutationOwner = 0;
  let unsubscribeSession: (() => void) | null = null;

  const patch = (changes: Partial<StudentLearningPathState>): void => {
    state = { ...state, ...changes };
    for (const listener of [...listeners]) listener(state);
  };

  const patchMutation = (changes: Partial<StudentCompletionMutationState>): void => {
    patch({ mutation: { ...state.mutation, ...changes } });
  };

  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** Drops every private trace of the student path. */
  const clearedState = (): Partial<StudentLearningPathState> => ({
    courses: [],
    coursesPhase: 'idle',
    coursesError: null,
    coursesTruncated: false,
    courseId: null,
    course: null,
    units: [],
    truncated: false,
    phase: 'idle',
    error: null,
    refreshError: null,
    lastCompletion: null,
    mutation: idleMutation(),
  });

  /** Retires every in-flight reply: nothing older may commit after this. */
  const retire = (): void => {
    readGeneration += 1;
    writeGeneration += 1;
    mutationOwner = 0;
    readGuard.release();
    writeGuard.release();
  };

  const handleSessionChange = (): void => {
    if (disposed) return;
    const principal = readPrincipal();
    if (principal === observedPrincipal) return;
    observedPrincipal = principal;
    retire();
    patch(clearedState());
  };

  if (api.subscribeSession) unsubscribeSession = api.subscribeSession(handleSessionChange);

  /** A reply commits only while it is still the current read for this principal. */
  const isStaleRead = (generation: number, principal: string | null): boolean =>
    disposed || generation !== readGeneration || readPrincipal() !== principal;

  const isStaleWrite = (generation: number, principal: string | null): boolean =>
    disposed || generation !== writeGeneration || readPrincipal() !== principal;

  /** Classifies a READ failure into a phase plus the honest wording. */
  const readFailure = (message: string): { phase: StudentLearningPathPhase; error: string } => {
    if (SESSION_INVALID_MESSAGES.has(message)) {
      return { phase: 'unauthorized', error: STUDENT_PATH_UNAUTHORIZED_MESSAGE };
    }
    if (message === FORBIDDEN_MESSAGE) {
      return { phase: 'forbidden', error: STUDENT_PATH_FORBIDDEN_MESSAGE };
    }
    if (NO_WORKSPACE_MESSAGES.has(message)) {
      return { phase: 'no-workspace', error: STUDENT_PATH_NO_WORKSPACE_MESSAGE };
    }
    if (message === SELECTOR_REFUSED_MESSAGE) {
      // The page never sends a selector; a refusal here means the session lost
      // its workspace, so it is reported as such and no row is kept.
      return { phase: 'no-workspace', error: STUDENT_PATH_NO_WORKSPACE_MESSAGE };
    }
    if (message === MISSING_COURSE_MESSAGE) {
      return { phase: 'missing-course', error: STUDENT_PATH_MISSING_COURSE_MESSAGE };
    }
    return { phase: 'error', error: STUDENT_PATH_ERROR_MESSAGE };
  };

  /** A definite scope/permission loss clears the private state entirely. */
  const applyReadFailure = (message: string): void => {
    const failure = readFailure(message);
    if (failure.phase === 'unauthorized' || failure.phase === 'forbidden') {
      patch({ ...clearedState(), coursesPhase: failure.phase, coursesError: failure.error });
      return;
    }
    // The bounded course LIST never answers a missing course, so a
    // `missing-course` classification is reported as a plain failure here.
    const coursesPhase: StudentCourseListPhase =
      failure.phase === 'missing-course' ? 'error' : failure.phase;
    patch({ coursesPhase, coursesError: failure.error });
  };

  const loadCourses = async (
    generation: number,
    principal: string | null,
  ): Promise<ReadOutcome> => {
    patch({ coursesPhase: 'loading', coursesError: null });
    try {
      const raw = await api.listCourses();
      if (isStaleRead(generation, principal)) return 'stale';
      const envelope = parseStudentCourseListEnvelope(raw);
      if (envelope === null) {
        patch({ coursesPhase: 'malformed', coursesError: STUDENT_PATH_MALFORMED_MESSAGE });
        return 'failed';
      }
      patch({
        courses: envelope.courses,
        coursesTruncated: envelope.truncated,
        coursesPhase: envelope.courses.length === 0 ? 'empty' : 'ready',
        coursesError: null,
      });
      return 'ok';
    } catch (error) {
      if (isStaleRead(generation, principal)) return 'stale';
      applyReadFailure(messageOf(error));
      return 'failed';
    }
  };

  const loadPath = async (
    courseId: string,
    generation: number,
    principal: string | null,
  ): Promise<ReadOutcome> => {
    patch({ phase: 'loading', error: null });
    try {
      const raw = await api.getPath(courseId);
      if (isStaleRead(generation, principal)) return 'stale';
      // A reply for ANOTHER course is not a success: the path is bound to the
      // course the user selected.
      const envelope = parseStudentLearningPathEnvelope(raw);
      if (envelope === null) {
        patch({
          phase: 'malformed',
          error: STUDENT_PATH_MALFORMED_MESSAGE,
          course: null,
          units: [],
          truncated: false,
        });
        return 'failed';
      }
      if (envelope.course.course_id !== courseId.toLowerCase()) {
        patch({
          phase: 'malformed',
          error: STUDENT_PATH_MALFORMED_MESSAGE,
          course: null,
          units: [],
          truncated: false,
        });
        return 'failed';
      }
      const lessonCount = envelope.units.reduce((total, unit) => total + unit.lessons.length, 0);
      patch({
        course: envelope.course,
        units: envelope.units,
        truncated: envelope.truncated,
        phase: lessonCount === 0 ? 'empty' : 'ready',
        error: null,
      });
      return 'ok';
    } catch (error) {
      if (isStaleRead(generation, principal)) return 'stale';
      const failure = readFailure(messageOf(error));
      patch({
        phase: failure.phase,
        error: failure.error,
        course: null,
        units: [],
        truncated: false,
      });
      return 'failed';
    }
  };

  /** Starts a read that bypasses the single-flight latch (a target change). */
  const startRead = (work: () => Promise<unknown>): Promise<void> => {
    const operation = (async () => {
      try {
        await work();
      } finally {
        pending.delete(operation);
      }
    })();
    pending.add(operation);
    return operation.then(() => undefined);
  };

  /**
   * A guarded read: the single-flight latch is taken SYNCHRONOUSLY (before the
   * first await) so a double click never issues a second bounded read, and the
   * operation is tracked so `waitForIdle()` really waits for it.
   */
  const runGuarded = (work: () => Promise<unknown>): Promise<void> => {
    if (!readGuard.acquire()) return Promise.resolve();
    const token = readGuard.holder();
    return startRead(async () => {
      try {
        await work();
      } finally {
        readGuard.release(token);
      }
    });
  };

  const findLesson = (lessonId: string): StudentLesson | null => {
    for (const unit of state.units) {
      for (const lesson of unit.lessons) {
        if (lesson.lesson_id === lessonId) return lesson;
      }
    }
    return null;
  };

  /**
   * Marks ONE lesson completed with the SERVER's instant.
   *
   * This never unlocks anything: `accessible` and `lock_reason` stay exactly as
   * the server projected them, and the dependent lesson becomes accessible only
   * when a subsequent server read says so.
   */
  const applyCompletion = (completion: StudentCompletion): void => {
    const units = state.units.map((unit) => ({
      ...unit,
      lessons: unit.lessons.map((lesson) =>
        lesson.lesson_id === completion.lesson_id
          ? { ...lesson, completed: true, completed_at: completion.completed_at }
          : lesson,
      ),
    }));
    patch({ units, lastCompletion: completion });
  };

  return {
    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    open: async () => {
      if (disposed) return;
      if (!state.open) patch({ open: true });
      await runGuarded(async () => {
        const generation = ++readGeneration;
        const principal = readPrincipal();
        const listed = await loadCourses(generation, principal);
        if (listed !== 'ok') return;
        // The first course of the server's own list is the default selection;
        // an empty list leaves nothing to read.
        const next = state.courses[0];
        if (!next) {
          patch({ courseId: null, course: null, units: [], truncated: false, phase: 'idle' });
          return;
        }
        patch({ courseId: next.course_id, course: null, units: [], truncated: false });
        await loadPath(next.course_id, generation, principal);
      });
    },

    refreshCourses: async () => {
      if (disposed) return;
      await runGuarded(async () => {
        const generation = ++readGeneration;
        const principal = readPrincipal();
        const listed = await loadCourses(generation, principal);
        if (listed !== 'ok') return;
        const current = state.courseId;
        const stillListed = current !== null && state.courses.some((c) => c.course_id === current);
        const next = stillListed ? current : (state.courses[0]?.course_id ?? null);
        if (next === null) {
          patch({ courseId: null, course: null, units: [], truncated: false, phase: 'idle' });
          return;
        }
        if (next !== current) patch({ courseId: next, course: null, units: [], truncated: false });
        await loadPath(next, generation, principal);
      });
    },

    selectCourse: async (courseId) => {
      if (disposed) return;
      const target = canonicalId(courseId);
      if (target === null) return;
      // A target change invalidates EVERY in-flight reply first, so one course's
      // lessons can never land under another course's header.
      readGeneration += 1;
      const generation = readGeneration;
      const principal = readPrincipal();
      patch({
        courseId: target,
        course: null,
        units: [],
        truncated: false,
        phase: 'loading',
        error: null,
        refreshError: null,
        lastCompletion: null,
      });
      await startRead(() => loadPath(target, generation, principal));
    },

    refreshPath: async () => {
      if (disposed) return;
      const courseId = state.courseId;
      if (courseId === null) return;
      await runGuarded(async () => {
        const generation = ++readGeneration;
        await loadPath(courseId, generation, readPrincipal());
      });
    },

    completeLesson: async (lessonId) => {
      if (disposed) return;
      const target = canonicalId(lessonId);
      if (target === null) return;
      const courseId = state.courseId;
      if (courseId === null) return;
      // The lesson must be part of the path the student is actually looking at.
      if (findLesson(target) === null) {
        patchMutation({
          status: 'failed',
          lessonId: target,
          error: STUDENT_PATH_UNKNOWN_LESSON_MESSAGE,
          notice: null,
        });
        return;
      }
      // Synchronous single-flight: a double click or a click+Enter is refused
      // BEFORE the first await, so exactly one write can ever leave the page.
      if (!writeGuard.acquire()) return;
      const token = writeGuard.holder();
      const owner = ++mutationOwner;
      const generation = ++writeGeneration;
      const principal = readPrincipal();
      patchMutation({ status: 'saving', lessonId: target, error: null, notice: null });

      const operation = (async () => {
        try {
          const raw = await api.completeLesson(courseId, target);
          if (isStaleWrite(generation, principal)) return;
          const completion = parseStudentCompletionEnvelope(raw, target);
          if (completion === null) {
            patchMutation({
              status: 'failed',
              lessonId: target,
              error: STUDENT_PATH_MALFORMED_MESSAGE,
              notice: null,
            });
            return;
          }
          applyCompletion(completion);
          patchMutation({
            status: 'saved',
            lessonId: target,
            error: null,
            notice: STUDENT_COMPLETION_CONFIRMED_MESSAGE,
          });
          // The write is CONFIRMED, so the latch is released BEFORE the bounded
          // follow-up read: an enabled control is never a silent no-op.
          if (mutationOwner === owner) writeGuard.release(token);
          const followUp = ++readGeneration;
          const outcome = await loadPath(courseId, followUp, principal);
          if (outcome === 'failed') {
            patch({ refreshError: STUDENT_PATH_ERROR_MESSAGE });
          }
        } catch (error) {
          if (isStaleWrite(generation, principal)) return;
          const message = messageOf(error);
          if (message === LOCKED_MESSAGE) {
            patchMutation({
              status: 'failed',
              lessonId: target,
              error: STUDENT_COMPLETION_LOCKED_MESSAGE,
              notice: null,
            });
            return;
          }
          if (SESSION_INVALID_MESSAGES.has(message)) {
            patch({ ...clearedState(), coursesPhase: 'unauthorized' });
            patchMutation({
              status: 'failed',
              lessonId: target,
              error: STUDENT_PATH_UNAUTHORIZED_MESSAGE,
              notice: null,
            });
            return;
          }
          if (message === FORBIDDEN_MESSAGE) {
            patch({ ...clearedState(), coursesPhase: 'forbidden' });
            patchMutation({
              status: 'failed',
              lessonId: target,
              error: STUDENT_PATH_FORBIDDEN_MESSAGE,
              notice: null,
            });
            return;
          }
          if (NO_WORKSPACE_MESSAGES.has(message) || message === SELECTOR_REFUSED_MESSAGE) {
            patch({ ...clearedState(), coursesPhase: 'no-workspace' });
            patchMutation({
              status: 'failed',
              lessonId: target,
              error: STUDENT_PATH_NO_WORKSPACE_MESSAGE,
              notice: null,
            });
            return;
          }
          if (message === MISSING_COURSE_MESSAGE) {
            patch({ course: null, units: [], truncated: false, phase: 'missing-course' });
            patchMutation({
              status: 'failed',
              lessonId: target,
              error: STUDENT_PATH_MISSING_COURSE_MESSAGE,
              notice: null,
            });
            return;
          }
          // Everything else — a 500, a network failure, an unreadable body — is
          // UNCERTAIN: the completion may have persisted. Nothing is retried.
          patchMutation({
            status: 'uncertain',
            lessonId: target,
            error: STUDENT_COMPLETION_UNCERTAIN_MESSAGE,
            notice: null,
          });
        } finally {
          if (mutationOwner === owner) writeGuard.release(token);
          pending.delete(operation);
        }
      })();
      pending.add(operation);
      return operation.then(() => undefined);
    },

    reconcile: async () => {
      if (disposed) return;
      const courseId = state.courseId;
      if (courseId === null) return;
      await runGuarded(async () => {
        const outcome = await loadPath(courseId, ++readGeneration, readPrincipal());
        if (outcome === 'ok') {
          patchMutation({
            status: 'idle',
            error: null,
            notice: STUDENT_COMPLETION_RECONCILED_MESSAGE,
          });
        }
      });
    },

    waitForIdle: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      retire();
      if (unsubscribeSession) {
        unsubscribeSession();
        unsubscribeSession = null;
      }
      state = { ...initialState };
      listeners.clear();
    },
  };
}
