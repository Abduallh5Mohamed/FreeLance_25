"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.proveStudentLessonAudience = proveStudentLessonAudience;
const student_lesson_access_1 = require("./student-lesson-access");
const resource_branch_1 = require("../security/resource-branch");
const suspension_predicate_1 = require("../security/suspension-predicate");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const yes = (value) => value === 1 || value === true || value === '1';
/** Shared fresh identity, lesson and actual enrollment-group/branch proof. No source grant. */
async function proveStudentLessonAudience(connection, scope, courseId, lessonId, principal, labels = {}) {
    const missing = () => ({ ok: false, status: 404, body: { error: labels.missingError ?? 'Lesson not found' }, commit: false });
    const unavailable = () => ({ ok: false, status: 503, body: { error: 'Lesson audience proof unavailable', code: labels.unavailableCode ?? 'LESSON_ACTIVITIES_UNAVAILABLE' }, commit: false });
    if (principal.role !== 'student' || principal.identitySource === 'staff' || principal.id !== scope.userId || principal.tenantId !== scope.tenantId || principal.studentEnrollmentId !== scope.enrollmentId)
        return missing();
    const [users] = await connection.execute(`SELECT id,is_active,token_version,${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1${labels.lock ? ' FOR UPDATE' : ''}`, [scope.userId]);
    const user = users[0];
    if (!user || !yes(user.is_active) || Number(user.suspension_active) !== 0 || Number(user.token_version ?? 0) !== Number(principal.tokenVersion ?? 0) || !same(user.id, scope.userId))
        return missing();
    const lesson = await (0, student_lesson_access_1.proveStudentLesson)(connection, scope, courseId, lessonId, labels.lock ?? false);
    if (!lesson.ok)
        return lesson;
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('students','student_courses','course_lesson_completions','groups','branches','branch_memberships') LIMIT 6`);
    if (!['students', 'student_courses', 'course_lesson_completions', 'groups', 'branches', 'branch_memberships'].every(name => tables.some(row => row.table_name === name && row.engine === 'InnoDB')))
        return unavailable();
    // The enrollment's actual group is an additional audience/branch guard.
    // A student's branch is not inferred from every group of the course.
    const [groups] = await connection.execute(`SELECT g.id,g.course_id,c.tenant_id,g.branch_id,g.branch_scope,g.instructor_id,
    br.id AS resolved_branch_id,br.tenant_id AS branch_tenant_id,br.status AS branch_status,br.version AS branch_version,
    bm.user_id AS member_user_id,bm.status AS member_status,bm.role AS member_role,bm.version AS member_version
    FROM students s INNER JOIN \`groups\` g ON g.id=s.group_id INNER JOIN courses c ON c.id=g.course_id
    LEFT JOIN branches br ON br.id=g.branch_id LEFT JOIN branch_memberships bm ON bm.branch_id=br.id AND bm.user_id=?
    WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND g.course_id=? AND c.tenant_id=? LIMIT 2${labels.lock ? ' FOR UPDATE' : ''}`, [scope.userId, scope.enrollmentId, scope.userId, scope.tenantId, courseId, scope.tenantId]);
    if (groups.length !== 1)
        return missing();
    const group = groups[0];
    if (!uuid.test(String(group.id)) || !same(group.course_id, courseId) || !same(group.tenant_id, scope.tenantId))
        return missing();
    const loader = (0, resource_branch_1.createSqlResourceScopeLoader)({ queryOne: async () => ({ id: group.id, tenant_id: group.tenant_id, branch_id: group.branch_id, branch_scope: group.branch_scope, instructor_id: group.instructor_id }), query: async () => [] });
    const branch = await (0, resource_branch_1.resolveResourceBranchAccess)({ loadResourceScope: loader,
        findBranch: async (id) => same(id, group.resolved_branch_id) ? { id: group.resolved_branch_id, tenant_id: group.branch_tenant_id, status: group.branch_status, version: Number(group.branch_version) } : null,
        findMembership: async (id, userId) => same(id, group.resolved_branch_id) && same(userId, group.member_user_id) ? { branch_id: group.resolved_branch_id, user_id: group.member_user_id, status: group.member_status, role: group.member_role, version: Number(group.member_version) } : null,
        isTenantOwner: async () => false, hasPlatformCapability: async () => false,
    }, (0, resource_branch_1.principalFromAuthUser)(principal), { resourceType: 'group', resourceId: group.id });
    if (branch.kind !== 'allowed')
        return missing();
    return { ok: true, user, lessonProof: lesson, group };
}
