"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORT_CONTEXT_COLUMNS = void 0;
exports.parseLessonContextInput = parseLessonContextInput;
exports.supportContextSchema = supportContextSchema;
exports.storedLessonContext = storedLessonContext;
exports.proveLessonSupportContext = proveLessonSupportContext;
const student_lesson_access_1 = require("./student-lesson-access");
exports.SUPPORT_CONTEXT_COLUMNS = ['context_kind', 'context_tenant_id', 'context_enrollment_id', 'context_course_id', 'context_lesson_id'];
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function parseLessonContextInput(input) {
    if (input === undefined || input === null)
        return null;
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw Error('Invalid lesson context');
    const row = input;
    if (Object.keys(row).length !== 3 || row.kind !== 'catalog_lesson' || typeof row.course_id !== 'string' || !uuid.test(row.course_id) || typeof row.lesson_id !== 'string' || !uuid.test(row.lesson_id))
        throw Error('Invalid lesson context');
    return { kind: 'catalog_lesson', course_id: row.course_id.toLowerCase(), lesson_id: row.lesson_id.toLowerCase() };
}
async function supportContextSchema(connection) {
    const [rows] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_tickets' AND COLUMN_NAME IN ('context_kind','context_tenant_id','context_enrollment_id','context_course_id','context_lesson_id') LIMIT 5`);
    const found = rows.filter(row => exports.SUPPORT_CONTEXT_COLUMNS.includes(row.column_name));
    if (found.length === 0)
        return false;
    if (found.length !== 5 || new Set(found.map(row => row.column_name)).size !== 5)
        throw Error('Incomplete support context schema');
    return true;
}
async function storedLessonContext(connection, ticketId) {
    const [rows] = await connection.execute(`SELECT context_kind,context_tenant_id,context_enrollment_id,context_course_id,context_lesson_id FROM support_tickets WHERE id=? LIMIT 1`, [ticketId]);
    const row = rows[0];
    if (!row)
        throw Error('Support ticket missing');
    if (exports.SUPPORT_CONTEXT_COLUMNS.every(key => row[key] === null))
        return null;
    if (row.context_kind !== 'catalog_lesson' || ![row.context_tenant_id, row.context_enrollment_id].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,36}$/.test(value))
        || ![row.context_course_id, row.context_lesson_id].every(value => typeof value === 'string' && uuid.test(value)))
        throw Error('Invalid stored support context');
    return { kind: 'catalog_lesson', tenant_id: row.context_tenant_id, enrollment_id: row.context_enrollment_id, course_id: row.context_course_id, lesson_id: row.context_lesson_id };
}
async function proveLessonSupportContext(connection, scope, input, lock = false) {
    const names = ['students', 'tenants', 'student_courses', 'courses', 'course_units', 'course_lessons', 'course_lesson_completions'];
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('students','tenants','student_courses','courses','course_units','course_lessons','course_lesson_completions') LIMIT 7`);
    if (!names.every(name => tables.some(row => row.table_name === name && row.engine === 'InnoDB')))
        throw Error('Lesson context storage unavailable');
    const proof = await (0, student_lesson_access_1.proveStudentLesson)(connection, scope, input.course_id, input.lesson_id, lock);
    if (!proof.ok)
        return proof;
    if (![proof.enrollment.tenant_id, proof.enrollment.enrollment_id].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,36}$/.test(value)) || !uuid.test(String(proof.course.course_id)) || !uuid.test(String(proof.lesson.id)))
        throw Error('Invalid verified lesson scope');
    if (typeof proof.course.name !== 'string' || !proof.course.name.trim() || proof.course.name.length > 255 || typeof proof.lesson.title !== 'string' || !proof.lesson.title.trim() || proof.lesson.title.length > 255)
        throw Error('Invalid lesson context titles');
    return { ok: true, scope: { userId: scope.userId, tenantId: String(proof.enrollment.tenant_id), enrollmentId: String(proof.enrollment.enrollment_id) }, context: { kind: 'catalog_lesson', course_id: String(proof.course.course_id), lesson_id: String(proof.lesson.id), course_name: proof.course.name, lesson_title: proof.lesson.title } };
}
