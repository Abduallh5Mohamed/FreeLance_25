"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyStudentEnrollment = verifyStudentEnrollment;
exports.resolveStudentCourse = resolveStudentCourse;
exports.proveStudentLesson = proveStudentLesson;
const isTrue = (value) => value === 1 || value === true || value === '1';
async function verifyStudentEnrollment(connection, userId, enrollmentId, tenantId, lock = false) {
    const [rows] = await connection.execute(`SELECT s.id AS enrollment_id,s.tenant_id
       FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
       WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.is_active=1
         AND s.approval_status='approved' AND t.status='active'
         AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
         AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
         AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
       LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [enrollmentId, userId, tenantId]);
    return rows[0] ?? null;
}
async function resolveStudentCourse(connection, enrollmentId, courseId, tenantId, lock = false) {
    const [enrolled] = await connection.execute(`SELECT sc.id AS student_course_id FROM student_courses sc
       WHERE sc.student_id=? AND sc.course_id=? AND sc.status='active' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [enrollmentId, courseId]);
    if (!enrolled[0])
        return null;
    const [courses] = await connection.execute(`SELECT c.id AS course_id,c.name,c.subject,c.grade FROM courses c
       WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE AND c.publication_state='published' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [courseId, tenantId]);
    return courses[0] ?? null;
}
/** Shared with the real student material read; no provider or file projection. */
async function proveStudentLesson(connection, scope, courseId, lessonId, lock = false) {
    const missing = (error) => ({ ok: false, status: 404, body: { error }, commit: false });
    const enrollment = await verifyStudentEnrollment(connection, scope.userId, scope.enrollmentId, scope.tenantId, lock);
    if (!enrollment)
        return missing('Course not found');
    const course = await resolveStudentCourse(connection, scope.enrollmentId, courseId, scope.tenantId, lock);
    if (!course)
        return missing('Course not found');
    const [lessons] = await connection.execute(`SELECT l.id,l.prerequisite_lesson_id,l.title,
                (l.release_at IS NULL OR UNIX_TIMESTAMP(l.release_at)<=UNIX_TIMESTAMP()) AS is_released,
                (l.prerequisite_lesson_id IS NULL OR EXISTS (
                  SELECT 1 FROM course_lesson_completions clc
                  WHERE clc.lesson_id=l.prerequisite_lesson_id AND clc.student_enrollment_id=?
                )) AS is_prerequisite_met
         FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id
         WHERE l.id=? AND u.course_id=? AND l.status='active' AND u.status='active' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [scope.enrollmentId, lessonId, courseId]);
    const lesson = lessons[0];
    if (!lesson)
        return missing('Lesson not found');
    if (!isTrue(lesson.is_released) || !isTrue(lesson.is_prerequisite_met))
        return { ok: false, status: 409, body: { error: 'Lesson is not accessible yet', code: 'LESSON_LOCKED', reason: !isTrue(lesson.is_released) ? 'not_released' : 'prerequisite_incomplete' }, commit: false };
    return { ok: true, course, lesson, enrollment };
}
