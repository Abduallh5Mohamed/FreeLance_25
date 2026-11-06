import type { AuthRequest } from '../middleware/auth';
import type { StudentCourseAccessConnection } from '../routes/student-course-access';
import { proveStudentLesson, type StudentLessonScope } from './student-lesson-access';
import { createSqlResourceScopeLoader, principalFromAuthUser, resolveResourceBranchAccess } from '../security/resource-branch';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const yes = (value: unknown) => value === 1 || value === true || value === '1';
/** Shared fresh identity, lesson and actual enrollment-group/branch proof. No source grant. */
export async function proveStudentLessonAudience(connection: StudentCourseAccessConnection, scope: StudentLessonScope, courseId: string, lessonId: string, principal: NonNullable<AuthRequest['user']>, labels: {
    missingError?: string;
    unavailableCode?: string;
    lock?: boolean;
} = {}) {
    const missing = () => ({ ok: false as const, status: 404, body: { error: labels.missingError ?? 'Lesson not found' }, commit: false as const });
    const unavailable = () => ({ ok: false as const, status: 503, body: { error: 'Lesson audience proof unavailable', code: labels.unavailableCode ?? 'LESSON_ACTIVITIES_UNAVAILABLE' }, commit: false as const });
    if (principal.role !== 'student' || principal.identitySource === 'staff' || principal.id !== scope.userId || principal.tenantId !== scope.tenantId || principal.studentEnrollmentId !== scope.enrollmentId)
        return missing();
    const [users] = await connection.execute(`SELECT id,is_active,token_version,${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1${labels.lock?' FOR UPDATE':''}`, [scope.userId]);
    const user = (users as any[])[0];
    if (!user || !yes(user.is_active) || Number(user.suspension_active) !== 0 || Number(user.token_version ?? 0) !== Number(principal.tokenVersion ?? 0) || !same(user.id, scope.userId))
        return missing();
    const lesson = await proveStudentLesson(connection, scope, courseId, lessonId, labels.lock??false);
    if (!lesson.ok)
        return lesson;
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('students','student_courses','course_lesson_completions','groups','branches','branch_memberships') LIMIT 6`);
    if (!['students', 'student_courses', 'course_lesson_completions', 'groups', 'branches', 'branch_memberships'].every(name => (tables as any[]).some(row => row.table_name === name && row.engine === 'InnoDB')))
        return unavailable();
    // The enrollment's actual group is an additional audience/branch guard.
    // A student's branch is not inferred from every group of the course.
    const [groups] = await connection.execute(`SELECT g.id,g.course_id,c.tenant_id,g.branch_id,g.branch_scope,g.instructor_id,
    br.id AS resolved_branch_id,br.tenant_id AS branch_tenant_id,br.status AS branch_status,br.version AS branch_version,
    bm.user_id AS member_user_id,bm.status AS member_status,bm.role AS member_role,bm.version AS member_version
    FROM students s INNER JOIN \`groups\` g ON g.id=s.group_id INNER JOIN courses c ON c.id=g.course_id
    LEFT JOIN branches br ON br.id=g.branch_id LEFT JOIN branch_memberships bm ON bm.branch_id=br.id AND bm.user_id=?
    WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND g.course_id=? AND c.tenant_id=? LIMIT 2${labels.lock?' FOR UPDATE':''}`, [scope.userId, scope.enrollmentId, scope.userId, scope.tenantId, courseId, scope.tenantId]);
    if ((groups as any[]).length !== 1)
        return missing();
    const group = (groups as any[])[0];
    if (!uuid.test(String(group.id)) || !same(group.course_id, courseId) || !same(group.tenant_id, scope.tenantId))
        return missing();
    const loader = createSqlResourceScopeLoader({ queryOne: async <T>() => ({ id: group.id, tenant_id: group.tenant_id, branch_id: group.branch_id, branch_scope: group.branch_scope, instructor_id: group.instructor_id }) as T, query: async <T>() => [] as T[] });
    const branch = await resolveResourceBranchAccess({ loadResourceScope: loader,
        findBranch: async (id) => same(id, group.resolved_branch_id) ? { id: group.resolved_branch_id, tenant_id: group.branch_tenant_id, status: group.branch_status, version: Number(group.branch_version) } : null,
        findMembership: async (id, userId) => same(id, group.resolved_branch_id) && same(userId, group.member_user_id) ? { branch_id: group.resolved_branch_id, user_id: group.member_user_id, status: group.member_status, role: group.member_role, version: Number(group.member_version) } : null,
        isTenantOwner: async () => false, hasPlatformCapability: async () => false,
    }, principalFromAuthUser(principal), { resourceType: 'group', resourceId: group.id });
    if (branch.kind !== 'allowed')
        return missing();
    return { ok: true as const, user, lessonProof: lesson, group };
}
