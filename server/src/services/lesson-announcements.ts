import { randomUUID } from 'crypto';
import type { CourseLessonConnection } from '../routes/course-lessons';
import { recordAudit, snapshotRow } from '../security/audit';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unavailable = (code = 'LESSON_ANNOUNCEMENT_UNAVAILABLE') => ({ status: 503, body: { error: 'Lesson announcement preparation unavailable', code }, commit: false });
const missing = () => ({ status: 404, body: { error: 'Lesson announcement source not found' }, commit: false });
export async function lessonAnnouncementSchema(connection: CourseLessonConnection) {
    const required: Record<string, string[]> = { course_lesson_announcements: ['id', 'lesson_id', 'announcement_id'], group_announcements: ['id', 'tenant_id', 'group_id', 'title', 'body', 'state'], groups: ['id', 'name', 'course_id', 'branch_id', 'branch_scope'], branches: ['id', 'tenant_id', 'status'], students: ['id', 'user_id', 'tenant_id', 'group_id', 'is_active', 'approval_status', 'enrollment_status', 'enrollment_start_date', 'enrollment_end_date'], users: ['id', 'is_active', 'suspended_until'], student_courses: ['student_id', 'course_id', 'status'], branch_memberships: ['branch_id', 'user_id', 'status', 'role'] };
    const columnNames = [...new Set(Object.values(required).flat())];
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_announcements','group_announcements','groups','branches','students','users','student_courses','branch_memberships') AND COLUMN_NAME IN (${columnNames.map(() => '?').join(',')}) LIMIT 256`, columnNames);
    if (!Object.entries(required).every(([table, cols]) => cols.every(col => (columns as any[]).some(r => r.table_name === table && r.column_name === col))))
        return false;
    const names = [...Object.keys(required), 'courses', 'course_units', 'course_lessons', 'tenants', 'audit_events'];
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_announcements','group_announcements','groups','branches','students','users','student_courses','branch_memberships','courses','course_units','course_lessons','tenants','audit_events') LIMIT 13`);
    if (!names.every(name => (tables as any[]).some(r => r.table_name === name && r.engine === 'InnoDB')))
        return false;
    const [indexes] = await connection.execute(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_announcements','group_announcements','groups','students') AND INDEX_NAME IN ('PRIMARY','uq_lesson_announcement') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 6`);
    for (const [table, index, column] of [['course_lesson_announcements', 'PRIMARY', 'id'], ['course_lesson_announcements', 'uq_lesson_announcement', 'lesson_id'], ['group_announcements', 'PRIMARY', 'id'], ['groups', 'PRIMARY', 'id'], ['students', 'PRIMARY', 'id']]) {
        const rows = (indexes as any[]).filter(r => r.table_name === table && r.index_name === index);
        if (rows.length !== 1 || rows[0].column_name !== column || Number(rows[0].seq_in_index) !== 1 || Number(rows[0].non_unique) !== 0)
            return false;
    }
    const [fks] = await connection.execute(`SELECT k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='course_lesson_announcements' AND k.REFERENCED_TABLE_NAME IS NOT NULL LIMIT 3`);
    return (fks as any[]).length === 2 && [['lesson_id', 'course_lessons'], ['announcement_id', 'group_announcements']].every(([col, table]) => (fks as any[]).some(r => r.column_name === col && r.referenced_table === table && r.referenced_column === 'id' && r.delete_rule === 'CASCADE'));
}
function source(row: any, courseId: string, tenantId: string) {
    if (!uuid(row.id) || !uuid(row.group_id) || !same(row.course_id, courseId) || row.tenant_id !== tenantId || !['draft', 'published'].includes(row.state) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 255 || typeof row.body !== 'string' || !row.body.trim() || row.body.length > 4000 || typeof row.group_name !== 'string' || row.group_name.length > 255)
        throw Error('Invalid announcement source');
    if (row.branch_scope === 'tenant') {
        if (row.branch_id !== null)
            throw Error('Invalid group branch');
    }
    else if (row.branch_scope !== 'branch' || !uuid(row.branch_id) || !same(row.branch_id, row.resolved_branch_id ?? '') || row.branch_tenant_id !== tenantId || row.branch_status !== 'active')
        return null;
    return row;
}
export async function readLessonAnnouncementSources(connection: CourseLessonConnection, courseId: string, tenantId: string, selector: {
    id?: string;
    cursor?: string;
}, lock: boolean) {
    const [rows] = await connection.execute(`SELECT a.id,a.group_id,a.title,CASE WHEN CHAR_LENGTH(a.body)<=4000 THEN a.body ELSE NULL END AS body,a.state,a.tenant_id,g.name AS group_name,g.course_id,g.branch_id,g.branch_scope,br.id AS resolved_branch_id,br.tenant_id AS branch_tenant_id,br.status AS branch_status
    FROM group_announcements a INNER JOIN \`groups\` g ON g.id=a.group_id INNER JOIN courses c ON c.id=g.course_id
    LEFT JOIN branches br ON br.id=g.branch_id WHERE a.tenant_id=? AND c.tenant_id=? AND g.course_id=? AND c.is_active=1 AND a.state IN ('draft','published') AND a.id${selector.id ? '=?' : '>?'} ORDER BY a.id LIMIT 26${lock ? ' FOR UPDATE' : ''}`, [tenantId, tenantId, courseId, selector.id ?? selector.cursor ?? '']);
    if ((rows as any[]).length > 26)
        throw Error('Announcement page exceeds bound');
    const validated = (rows as any[]).map(row => source(row, courseId, tenantId));
    return { items: validated.slice(0, 25).filter(Boolean), cursor: (rows as any[]).length > 25 ? (rows as any[])[24].id as string : null };
}
/** Caller proves owner/course/unit/lesson on this same transaction connection. */
export async function manageLessonAnnouncement(connection: CourseLessonConnection, input: {
    userId: string;
    tenantId: string;
    courseId: string;
    lessonId: string;
    operation: 'read' | 'sources' | 'attach' | 'detach' | 'preview';
    sourceId?: string;
    contentId?: string;
    cursor?: string;
    reviewLock?: boolean;
}) {
    if (!await lessonAnnouncementSchema(connection))
        return unavailable();
    const { userId, tenantId, courseId, lessonId, operation } = input;
    const header = (r: any) => ({ source_id: r.id, title: r.title, source_state: r.state, group_id: r.group_id, group_name: r.group_name });
    if (operation === 'sources') {
        const rows = await readLessonAnnouncementSources(connection, courseId, tenantId, { cursor: input.cursor }, false);
        return { status: 200, body: { sources: rows.items.map(header), next_cursor: rows.cursor }, commit: false };
    }
    const lock = operation === 'attach' || operation === 'detach' || input.reviewLock === true;
    const [bindings] = await connection.execute(`SELECT id,announcement_id FROM course_lesson_announcements WHERE lesson_id=? LIMIT 2${lock ? ' FOR UPDATE' : ''}`, [lessonId]);
    if ((bindings as any[]).length > 1)
        return unavailable();
    const existing = (bindings as any[])[0];
    if (existing && (!uuid(existing.id) || !uuid(existing.announcement_id)))
        return unavailable();
    const get = async (id: string) => (await readLessonAnnouncementSources(connection, courseId, tenantId, { id }, lock)).items.find(r => r && same(r.id, id));
    const dto = (id: string, sourceId: string, row: any) => ({ content_id: id, source_id: sourceId, title: row?.title ?? null, source_state: row?.state ?? 'unavailable', group_id: row?.group_id ?? null, group_name: row?.group_name ?? null, student_visibility: 'unconfigured' });
    if (operation === 'read')
        return { status: 200, body: { announcement: existing ? dto(existing.id, existing.announcement_id, await get(existing.announcement_id)) : null }, commit: false };
    if (operation === 'detach' && !existing)
        return { status: 200, body: { detached: false }, commit: false };
    if ((operation === 'detach' || operation === 'preview') && (!existing || !same(existing.id, input.contentId!)))
        return { status: 409, body: { error: 'Announcement reference changed; refresh first', code: 'LESSON_ANNOUNCEMENT_CHANGED' }, commit: false };
    if (operation === 'preview') {
        const row = await get(existing.announcement_id);
        if (!row)
            return missing();
        const [lessonRows] = await connection.execute(`SELECT c.publication_state,l.status AS lesson_status,u.status AS unit_status,(l.release_at IS NULL OR UNIX_TIMESTAMP(l.release_at)<=UNIX_TIMESTAMP()) AS released,l.prerequisite_lesson_id,UNIX_TIMESTAMP() AS previewed_at_epoch FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id INNER JOIN courses c ON c.id=u.course_id WHERE l.id=? AND u.course_id=? AND c.tenant_id=? LIMIT 1${lock?' FOR UPDATE':''}`, [lessonId, courseId, tenantId]);
        const lesson = (lessonRows as any[])[0];
        if (!lesson || !['draft', 'published', 'archived'].includes(lesson.publication_state) || !['active', 'archived'].includes(lesson.lesson_status) || !['active', 'archived'].includes(lesson.unit_status) || ![0, 1, false, true, '0', '1'].includes(lesson.released) || lesson.prerequisite_lesson_id !== null && !uuid(lesson.prerequisite_lesson_id) || !Number.isFinite(Number(lesson.previewed_at_epoch)))
            return unavailable();
        const [candidates] = await connection.execute(`SELECT s.id FROM students s INNER JOIN users ON users.id=s.user_id WHERE s.tenant_id=? AND s.group_id=? AND s.is_active=1 AND s.approval_status='approved' AND users.is_active=1 AND NOT ${ACTIVE_SUSPENSION_PREDICATE_SQL}
      AND (s.enrollment_status IS NULL OR s.enrollment_status='active') AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP()) AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
      AND EXISTS (SELECT 1 FROM student_courses sc WHERE sc.student_id=s.id AND sc.course_id=? AND sc.status='active')
      AND (?='tenant' OR EXISTS (SELECT 1 FROM branch_memberships bm WHERE bm.branch_id=? AND bm.user_id=s.user_id AND bm.status='active' AND bm.role='student')) ORDER BY s.id LIMIT 501${lock?' FOR UPDATE':''}`, [tenantId, row.group_id, courseId, row.branch_scope, row.branch_id]);
        if ((candidates as any[]).length > 500)
            return unavailable('LESSON_ANNOUNCEMENT_PREVIEW_TOO_LARGE');
        if ((candidates as any[]).some(r => typeof r.id !== 'string' || !r.id || r.id.length > 64) || new Set((candidates as any[]).map(r => r.id)).size !== (candidates as any[]).length)
            return unavailable();
        const at = new Date(Number(lesson.previewed_at_epoch) * 1000);
        if (!Number.isFinite(at.getTime()))
            return unavailable();
        return { status: 200, body: { preview: { content_id: existing.id, ...header(row), body: row.body, candidate_enrollments: (candidates as any[]).length, course_published: lesson.publication_state === 'published', lesson_active: lesson.lesson_status === 'active' && lesson.unit_status === 'active', lesson_released: lesson.released === 1 || lesson.released === true || lesson.released === '1', prerequisite_required: lesson.prerequisite_lesson_id !== null, previewed_at: at.toISOString(), student_visibility: 'unconfigured', delivery_status: 'unconfigured' } }, commit: false };
    }
    const row = operation === 'attach' ? await get(input.sourceId!) : null;
    if (operation === 'attach') {
        if (!row)
            return missing();
        if (existing)
            return same(existing.announcement_id, input.sourceId!) ? { status: 200, body: { announcement: dto(existing.id, existing.announcement_id, row), unchanged: true }, commit: false } : { status: 409, body: { error: 'Detach the existing announcement before replacing it', code: 'LESSON_ANNOUNCEMENT_OCCUPIED' }, commit: false };
    }
    const id = existing?.id ?? randomUUID(), sourceId = existing?.announcement_id ?? input.sourceId!;
    const [changed] = operation === 'attach' ? await connection.execute('INSERT INTO course_lesson_announcements (id,lesson_id,announcement_id) VALUES (?,?,?)', [id, lessonId, sourceId]) : await connection.execute('DELETE FROM course_lesson_announcements WHERE id=? AND lesson_id=?', [id, lessonId]);
    if (Number(changed.affectedRows) !== 1)
        throw Error('Announcement reference write not confirmed');
    await recordAudit(async (sql, params) => { const [result] = await connection.execute(sql, params); if (Number(result.affectedRows) !== 1)
        throw Error('Announcement reference audit not confirmed'); return result as {
        affectedRows: number;
    }; }, { actorUserId: userId, tenantId, action: `course_lesson_announcement.${operation}`, resourceType: 'course_lesson_announcement', resourceId: id, ...(operation === 'attach' ? { newValue: snapshotRow({ lesson_id: lessonId, announcement_id: sourceId }) } : { oldValue: snapshotRow({ lesson_id: lessonId, announcement_id: sourceId }) }) });
    return operation === 'attach' ? { status: 201, body: { announcement: dto(id, sourceId, row), unchanged: false }, commit: true } : { status: 200, body: { detached: true }, commit: true };
}
