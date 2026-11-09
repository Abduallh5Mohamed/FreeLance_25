"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lessonQuizVersionSchemaReady = lessonQuizVersionSchemaReady;
exports.manageLessonQuizVersion = manageLessonQuizVersion;
const crypto_1 = require("crypto");
const lesson_activities_1 = require("./lesson-activities");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = () => ({ status: 503, body: { error: 'Lesson quiz versions unavailable', code: 'LESSON_QUIZ_VERSIONS_UNAVAILABLE' }, commit: false });
const missing = () => ({ status: 404, body: { error: 'Lesson quiz version not found' }, commit: false });
/** Header preparation readiness, not question/hash/window or attempt readiness. */
async function lessonQuizVersionSchemaReady(connection) {
    if (!await (0, lesson_activities_1.lessonActivitySchemaReady)(connection))
        return false;
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_quiz_versions','exam_versions') LIMIT 40`);
    if (!Object.entries({ course_lesson_quiz_versions: ['content_id', 'exam_id', 'exam_version_id'], exam_versions: ['id', 'exam_id', 'tenant_id', 'version', 'status', 'published_at'] })
        .every(([table, required]) => required.every(column => columns.some(row => row.table_name === table && row.column_name === column))))
        return false;
    const [engines] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_quiz_versions','exam_versions') LIMIT 2`);
    if (!['course_lesson_quiz_versions', 'exam_versions'].every(name => engines.some(row => row.table_name === name && row.engine === 'InnoDB')))
        return false;
    const [indexes] = await connection.execute(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_quiz_versions','exam_versions') AND INDEX_NAME IN ('PRIMARY','uq_exam_version') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 8`);
    for (const [table, index, expected] of [['course_lesson_quiz_versions', 'PRIMARY', ['content_id']], ['exam_versions', 'PRIMARY', ['id']], ['exam_versions', 'uq_exam_version', ['exam_id', 'version']]]) {
        const rows = indexes.filter(row => row.table_name === table && row.index_name === index);
        if (rows.length !== expected.length || !expected.every((column, i) => rows[i].column_name === column && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0))
            return false;
    }
    const [foreignKeys] = await connection.execute(`SELECT k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.DELETE_RULE AS delete_rule
    FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='course_lesson_quiz_versions' AND k.REFERENCED_TABLE_NAME IS NOT NULL LIMIT 4`);
    const keys = foreignKeys;
    if (keys.length !== 3 || ![['content_id', 'course_lesson_activities', 'CASCADE'], ['exam_id', 'exams', 'RESTRICT'], ['exam_version_id', 'exam_versions', 'RESTRICT']]
        .every(([column, table, rule]) => keys.some(row => row.column_name === column && row.referenced_table === table && row.referenced_column === 'id' && row.delete_rule === rule)))
        return false;
    return true;
}
const versionDto = (row) => {
    const number = typeof row.version === 'number' ? row.version : typeof row.version === 'string' && /^[1-9]\d*$/.test(row.version) ? Number(row.version) : NaN;
    if (typeof row.id !== 'string' || !uuid.test(row.id) || !Number.isSafeInteger(number) || number < 1 || number > 2147483647)
        throw Error('Invalid snapshot header projection');
    return { exam_version_id: row.id, version_number: number };
};
/** Caller already proves/locks actual tenant owner and exact parent lesson. */
async function manageLessonQuizVersion(connection, input) {
    if (!await lessonQuizVersionSchemaReady(connection))
        return unavailable();
    const { userId, tenantId, courseId, lessonId, contentId, operation } = input, lock = operation === 'pin' || operation === 'unpin';
    const [activities] = await connection.execute(`SELECT id,exam_id FROM course_lesson_activities WHERE id=? AND lesson_id=? AND kind='quiz' AND assignment_id IS NULL LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [contentId, lessonId]);
    const activity = activities[0];
    if (!activity || !same(activity.id, contentId) || typeof activity.exam_id !== 'string' || !uuid.test(activity.exam_id))
        return missing();
    const [stored] = await connection.execute(`SELECT content_id,exam_id,exam_version_id FROM course_lesson_quiz_versions WHERE content_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [contentId]);
    const pin = stored[0];
    if (pin && (!same(pin.content_id, contentId) || !same(pin.exam_id, activity.exam_id) || typeof pin.exam_version_id !== 'string' || !uuid.test(pin.exam_version_id)))
        return unavailable();
    if (operation === 'unpin') {
        if (!pin)
            return { status: 200, body: { detached: false, content_id: contentId }, commit: false };
        if (!same(pin.exam_version_id, input.versionId))
            return { status: 409, body: { error: 'Pinned version changed; refresh first', code: 'LESSON_QUIZ_VERSION_CHANGED' }, commit: false };
    }
    const source = operation === 'unpin' ? null : (await (0, lesson_activities_1.readLessonActivitySources)(connection, 'quiz', courseId, tenantId, { ids: [activity.exam_id] }, lock)).items[0];
    if (operation === 'sources') {
        if (!source || !same(source.source_id, activity.exam_id))
            return missing();
        const [rows] = await connection.execute(`SELECT id,version FROM exam_versions WHERE exam_id=? AND tenant_id=? AND status='published' AND published_at IS NOT NULL AND id>? ORDER BY id LIMIT 26`, [activity.exam_id, tenantId, input.cursor ?? '']);
        const items = rows.slice(0, 25).map(versionDto);
        if (new Set(items.map(row => row.exam_version_id.toLowerCase())).size !== items.length)
            return unavailable();
        return { status: 200, body: { versions: items, next_cursor: rows.length > 25 ? items[24].exam_version_id : null }, commit: false };
    }
    let selected = null;
    if (operation !== 'unpin' && (operation === 'pin' || pin) && source && same(source.source_id, activity.exam_id)) {
        const [headers] = await connection.execute(`SELECT id,version FROM exam_versions WHERE id=? AND exam_id=? AND tenant_id=? AND status='published' AND published_at IS NOT NULL LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [operation === 'pin' ? input.versionId : pin.exam_version_id, activity.exam_id, tenantId]);
        if (headers[0])
            selected = versionDto(headers[0]);
    }
    if (operation === 'read')
        return { status: 200, body: { pin: pin ? { content_id: contentId, exam_version_id: pin.exam_version_id, version_number: selected?.version_number ?? null, status: selected ? 'published' : 'unavailable' } : null }, commit: false };
    const dto = selected ? { content_id: contentId, ...selected, status: 'published' } : null;
    if (operation === 'pin') {
        if (!selected || !same(selected.exam_version_id, input.versionId))
            return missing();
        if (pin)
            return same(pin.exam_version_id, selected.exam_version_id)
                ? { status: 200, body: { pin: dto, unchanged: true }, commit: false }
                : { status: 409, body: { error: 'Unpin before selecting another version', code: 'LESSON_QUIZ_VERSION_OCCUPIED' }, commit: false };
    }
    const versionId = operation === 'pin' ? selected.exam_version_id : pin.exam_version_id;
    const [changed] = operation === 'pin'
        ? await connection.execute('INSERT INTO course_lesson_quiz_versions (content_id,exam_id,exam_version_id) VALUES (?,?,?)', [contentId, activity.exam_id, versionId])
        : await connection.execute('DELETE FROM course_lesson_quiz_versions WHERE content_id=? AND exam_id=? AND exam_version_id=?', [contentId, activity.exam_id, versionId]);
    if (Number(changed.affectedRows) !== 1)
        throw Error('Quiz version binding write failed');
    const value = JSON.stringify({ lesson_id: lessonId, exam_id: activity.exam_id, exam_version_id: versionId });
    const [audit] = await connection.execute('INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)', [(0, crypto_1.randomUUID)(), userId, tenantId, `course_lesson_quiz_version.${operation}`, 'course_lesson_activity', contentId, operation === 'unpin' ? value : null, operation === 'pin' ? value : null]);
    if (Number(audit.affectedRows) !== 1)
        throw Error('Quiz version binding audit failed');
    return operation === 'pin' ? { status: 201, body: { pin: dto, unchanged: false }, commit: true } : { status: 200, body: { detached: true, content_id: contentId }, commit: true };
}
