import assert from 'node:assert/strict';
import { listStudentLessonActivities, readStudentLessonActivity, proveStudentCatalogActivity } from '../../src/services/student-lesson-activities';
import { createStudentCourseAccessRouter } from '../../src/routes/student-course-access';
import { makeReq, runChain } from './m2-course-lessons-harness';
export const id = (n: number) => `f3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const scope = { userId: 'student', tenantId: 'tenant', enrollmentId: 'enrollment' };
export const principal = { id: 'student', role: 'student', identitySource: 'users' as const, tenantId: 'tenant', studentEnrollmentId: 'enrollment', tokenVersion: 0 };
export function fixture() {
    const s = { active: true, suspended: false, version: 0, enrolled: true, course: true, lesson: true, released: true, prerequisite: true, schema: true, detailSchema: true, indexes: true, engine: 'InnoDB', acquired: 0,
        instructions: 'تعليمات الواجب التجريبية' as any, deadline: 0 as any, groupCount: 1, events: [] as string[], calls: [] as string[],
        group: { id: id(8), course_id: id(1), tenant_id: 'tenant', branch_id: null as string | null, branch_scope: 'tenant', instructor_id: 'teacher', resolved_branch_id: null as string | null, branch_tenant_id: 'tenant', branch_status: 'active', branch_version: 1, member_user_id: 'student', member_status: 'active', member_role: 'student', member_version: 1 },
        bindings: [{ id: id(3), kind: 'homework', assignment_id: id(4), exam_id: null }, { id: id(5), kind: 'quiz', assignment_id: null, exam_id: id(6) }] as any[],
        assignments: [{ id: id(4), title: 'واجب منشور', tenant_id: 'tenant', course_id: id(1), status: 'published', archived_at: null, group_id: null, branch_id: null, branch_scope: 'tenant' }] as any[],
        exams: [{ id: id(6), title: 'كويز منشور', tenant_id: 'tenant', course_id: id(1), is_active: 1, is_published: 1 }] as any[], audiences: [] as any[] };
    const connection = {
        beginTransaction: async () => { s.events.push('begin'); }, rollback: async () => { s.events.push('rollback'); }, commit: async () => { throw Error('Read must never commit'); }, release: () => { s.events.push('release'); }, destroy: () => { s.events.push('destroy'); },
        execute: async (sql: string, params: any[] = []): Promise<[
            any,
            any
        ]> => {
            const q = sql.replace(/\s+/g, ' ').trim();
            s.calls.push(q);
            assert.ok(!/^(INSERT|UPDATE|DELETE)/.test(q), 'metadata/detail/proof may not mutate');
            if (q.startsWith('SELECT id,is_active'))
                return [[{ id: 'student', is_active: s.active ? 1 : 0, token_version: s.version, suspension_active: s.suspended ? 1 : 0 }], []];
            if (q.includes('FROM students s INNER JOIN tenants'))
                return [s.enrolled ? [{ enrollment_id: scope.enrollmentId, tenant_id: scope.tenantId }] : [], []];
            if (q.startsWith('SELECT sc.id'))
                return [s.course ? [{ student_course_id: 'link' }] : [], []];
            if (q.startsWith('SELECT c.id AS course_id'))
                return [s.course && params[0] === id(1) && params[1] === 'tenant' ? [{ course_id: id(1) }] : [], []];
            if (q.startsWith('SELECT l.id,l.prerequisite_lesson_id'))
                return [s.lesson && params[1] === id(2) ? [{ id: id(2), is_released: s.released ? 1 : 0, is_prerequisite_met: s.prerequisite ? 1 : 0 }] : [], []];
            if (q.includes('information_schema.COLUMNS')) {
                if (q.includes("TABLE_NAME='assignments'"))
                    return [s.detailSchema ? ['instructions', 'deadline_at'].map(column_name => ({ column_name })) : [], []];
                return [s.schema ? Object.entries({ course_lesson_activities: ['id', 'lesson_id', 'kind', 'assignment_id', 'exam_id'], assignments: ['id', 'tenant_id', 'course_id', 'title', 'status', 'archived_at', 'group_id', 'branch_id', 'branch_scope'], exams: ['id', 'course_id', 'title', 'is_active', 'is_published'], exam_groups: ['exam_id', 'group_id'] }).flatMap(([table_name, columns]) => columns.map(column_name => ({ table_name, column_name }))) : [], []];
            }
            if (q.includes('information_schema.TABLES'))
                return [['course_lesson_activities', 'assignments', 'exams', 'exam_groups', 'course_lessons', 'course_units', 'courses', 'tenants', 'users', 'audit_events', 'students', 'student_courses', 'course_lesson_completions', 'groups', 'branches', 'branch_memberships'].map(table_name => ({ table_name, engine: s.engine })), []];
            if (q.includes('information_schema.STATISTICS'))
                return [s.indexes ? ['course_lesson_activities', 'assignments', 'exams'].flatMap(table_name => [{ table_name, index_name: 'PRIMARY', column_name: 'id', seq_in_index: 1, non_unique: 0 }, ...(table_name === 'course_lesson_activities' ? ['lesson_id', 'kind'].map((column_name, i) => ({ table_name, index_name: 'uq_lesson_activity_kind', column_name, seq_in_index: i + 1, non_unique: 0 })) : [])]) : [], []];
            if (q.startsWith('SELECT g.id,g.course_id') && q.includes('FROM students s')) {
                assert.deepEqual(params, ['student', 'enrollment', 'student', 'tenant', id(1), 'tenant']);
                return [Array.from({ length: s.groupCount }, () => s.group), []];
            }
            if (q.startsWith('SELECT id,kind,assignment_id')) {
                assert.deepEqual(params, [id(2)]);
                assert.match(q, /LIMIT 3(?: FOR UPDATE)?$/);
                return [s.bindings.slice(0, 3), []];
            }
            if (q.startsWith('SELECT s.id,s.title')) {
                const homework = q.includes('FROM assignments s'), ids = params.slice(homework ? 3 : 2);
                return [(homework ? s.assignments : s.exams).filter(row => row.tenant_id === params[0] && row.course_id === params[1] && ids.includes(row.id)
                        && (homework ? row.archived_at === null && ['draft', 'published'].includes(row.status) : row.is_active === 1)), []];
            }
            if (q.includes('FROM exam_groups eg LEFT JOIN'))
                return [s.audiences.filter(row => params.includes(row.exam_id)).slice(0, 521), []];
            if (q.includes('FROM `groups` g LEFT JOIN'))
                return [s.audiences.filter(row => params.includes(row.id)).slice(0, 521), []];
            if (q.startsWith('SELECT id,instructions')) {
                assert.deepEqual(params, [id(4), 'tenant', id(1)]);
                return [[{ id: id(4), instructions: s.instructions, deadline_epoch: s.deadline }], []];
            }
            throw Error('Unexpected synthetic SQL ' + q);
        },
    };
    const router = createStudentCourseAccessRouter({ query: async () => [], getConnection: async () => { s.acquired++; return connection; } });
    const request = (suffix = '', query: any = {}, actor: any = principal) => { const req: any = makeReq({ method: 'GET', pathName: `/courses/${id(1)}/lessons/${id(2)}/activities${suffix}`, query }); req.user = actor; return runChain([router], req); };
    return { s, connection, request, list: () => listStudentLessonActivities(connection, scope, id(1), id(2), principal), detail: (contentId = id(3)) => readStudentLessonActivity(connection, scope, id(1), id(2), contentId, principal), proof: () => proveStudentCatalogActivity(connection, scope, id(1), id(2), id(3), principal) };
}
