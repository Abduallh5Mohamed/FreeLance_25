"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lessonActivitySchemaReady = lessonActivitySchemaReady;
exports.readLessonActivitySources = readLessonActivitySources;
exports.manageLessonActivities = manageLessonActivities;
const crypto_1 = require("crypto");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = () => ({ status: 503, body: { error: 'Lesson activities schema unavailable', code: 'LESSON_ACTIVITIES_UNAVAILABLE' }, commit: false });
const missing = () => ({ status: 404, body: { error: 'Lesson activity source not found' }, commit: false });
async function lessonActivitySchemaReady(connection) {
    const required = {
        course_lesson_activities: ['id', 'lesson_id', 'kind', 'assignment_id', 'exam_id'],
        assignments: ['id', 'tenant_id', 'course_id', 'title', 'status', 'archived_at', 'group_id', 'branch_id', 'branch_scope'],
        exams: ['id', 'course_id', 'title', 'is_active', 'is_published'],
        exam_groups: ['exam_id', 'group_id'],
    };
    const names = Object.keys(required);
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_activities','assignments','exams','exam_groups') LIMIT 160`);
    if (!names.every(name => required[name].every(column => columns.some(row => row.table_name === name && row.column_name === column))))
        return false;
    const tables = [...names, 'course_lessons', 'course_units', 'courses', 'tenants', 'users', 'audit_events', 'groups', 'branches'];
    const [engines] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_activities','assignments','exams','exam_groups','course_lessons','course_units','courses','tenants','users','audit_events','groups','branches') LIMIT 12`);
    if (!tables.every(name => engines.some(row => row.table_name === name && row.engine === 'InnoDB')))
        return false;
    const [indexes] = await connection.execute(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_activities','assignments','exams') AND INDEX_NAME IN ('PRIMARY','uq_lesson_activity_kind') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 12`);
    for (const [table, index, expected] of [
        ['course_lesson_activities', 'PRIMARY', ['id']], ['course_lesson_activities', 'uq_lesson_activity_kind', ['lesson_id', 'kind']],
        ['assignments', 'PRIMARY', ['id']], ['exams', 'PRIMARY', ['id']],
    ]) {
        const rows = indexes.filter(row => row.table_name === table && row.index_name === index);
        if (rows.length !== expected.length || !expected.every((column, i) => rows[i].column_name === column && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0))
            return false;
    }
    return true;
}
// A source's course is not permission to ignore its audience. Owner preparation
// proves audience integrity but does not replace the eventual student policy.
async function readLessonActivitySources(connection, kind, courseId, tenantId, selector, lock) {
    const byIds = 'ids' in selector;
    if (byIds && !selector.ids.length)
        return { items: [], cursor: null, facts: [], groups: [] };
    const values = byIds ? selector.ids : [selector.cursor];
    const table = kind === 'homework' ? 'assignments' : 'exams';
    const sourceProjection = kind === 'homework' ? 's.status,s.group_id,s.branch_id,s.branch_scope' : 's.is_published';
    const predicate = kind === 'homework' ? "AND s.tenant_id=? AND s.archived_at IS NULL AND s.status IN ('draft','published')" : 'AND s.is_active=1';
    const [found] = await connection.execute(`SELECT s.id,s.title,${sourceProjection} FROM ${table} s INNER JOIN courses c ON c.id=s.course_id AND c.tenant_id=? AND c.is_active=1
    WHERE s.course_id=? ${predicate} AND s.id ${byIds ? `IN (${values.map(() => '?').join(',')})` : '>?'} ORDER BY s.id LIMIT 26${lock ? ' FOR UPDATE' : ''}`, [tenantId, courseId, ...(kind === 'homework' ? [tenantId] : []), ...values]);
    const rows = found;
    if (rows.length > 26 || rows.some(row => typeof row.id !== 'string' || !uuid.test(row.id) || typeof row.title !== 'string' || row.title.length > 255) || new Set(rows.map(row => row.id.toLowerCase())).size !== rows.length)
        throw Error('Invalid activity source projection');
    const page = rows.slice(0, 25);
    const groupIds = kind === 'homework' ? [...new Set(page.map(row => row.group_id).filter(id => id !== null))] : [];
    let groups = [];
    if (kind === 'quiz' && page.length || groupIds.length) {
        const params = kind === 'quiz' ? page.map(row => row.id) : groupIds;
        const [loaded] = await connection.execute(`SELECT ${kind === 'quiz' ? 'eg.exam_id,' : ''}g.id,g.course_id,g.branch_scope,g.branch_id,br.id AS resolved_branch_id,br.tenant_id AS branch_tenant_id,br.status AS branch_status
      FROM ${kind === 'quiz' ? 'exam_groups eg LEFT JOIN `groups` g ON g.id=eg.group_id' : '`groups` g'} LEFT JOIN branches br ON br.id=g.branch_id
      WHERE ${kind === 'quiz' ? 'eg.exam_id' : 'g.id'} IN (${params.map(() => '?').join(',')}) ORDER BY ${kind === 'quiz' ? 'eg.exam_id,' : ''}g.id LIMIT 521${lock ? ' FOR UPDATE' : ''}`, params);
        groups = loaded;
        if (groups.length > 520)
            throw Error('Activity audience proof bound exceeded');
    }
    const groupValid = (group) => group && uuid.test(group.id) && same(group.course_id, courseId)
        && (group.branch_scope === 'tenant' && group.branch_id === null || group.branch_scope === 'branch' && uuid.test(group.branch_id) && same(group.branch_id, group.resolved_branch_id) && same(group.branch_tenant_id, tenantId) && group.branch_status === 'active');
    const items = [];
    for (const row of page) {
        let restricted = false;
        if (kind === 'homework') {
            const group = row.group_id === null ? null : groups.find(item => same(item.id, row.group_id));
            if (row.group_id !== null && (!groupValid(group) || !same(group.branch_id, row.branch_id) && !(group.branch_id === null && row.branch_id === null)))
                continue;
            if (row.branch_scope !== 'tenant' || row.branch_id !== null) {
                // Branch-targeted homework needs a group carrying the same live branch.
                if (row.branch_scope !== 'branch' || !group || group.branch_scope !== 'branch' || !same(group.branch_id, row.branch_id))
                    continue;
            }
            else if (group && group.branch_scope !== 'tenant')
                continue;
            restricted = row.group_id !== null;
        }
        else {
            const audience = groups.filter(group => same(group.exam_id, row.id));
            if (audience.length > 20 || new Set(audience.map(group => String(group.id).toLowerCase())).size !== audience.length || audience.some(group => !groupValid(group)))
                continue;
            restricted = audience.length > 0;
            if (![0, 1, false, true].includes(row.is_published))
                throw Error('Invalid exam publication');
        }
        items.push({ source_id: row.id, title: row.title, source_status: kind === 'homework' ? row.status : row.is_published ? 'published' : 'draft', audience: restricted ? 'restricted' : 'course' });
    }
    // Facts stay server-private; HTTP handlers project only `items` and cursor.
    return { items, cursor: rows.length > 25 ? page[24].id : null, facts: page, groups };
}
/** Caller must first prove/lock the owner and exact course/unit/lesson on this connection. */
async function manageLessonActivities(connection, input) {
    if (!await lessonActivitySchemaReady(connection))
        return unavailable();
    const { userId, tenantId, courseId, lessonId, kind, operation } = input;
    if (operation === 'sources') {
        const page = await readLessonActivitySources(connection, kind, courseId, tenantId, { cursor: input.cursor ?? '' }, false);
        return { status: 200, body: { sources: page.items, next_cursor: page.cursor }, commit: false };
    }
    const lock = operation === 'attach' || operation === 'detach';
    const [loaded] = await connection.execute(`SELECT id,kind,assignment_id,exam_id FROM course_lesson_activities WHERE lesson_id=? ORDER BY kind LIMIT 3${lock ? ' FOR UPDATE' : ''}`, [lessonId]);
    const bindings = loaded;
    if (bindings.length > 2 || new Set(bindings.map(row => row.kind)).size !== bindings.length || bindings.some(row => !uuid.test(row.id) || !['homework', 'quiz'].includes(row.kind)
        || row.kind === 'homework' && (!uuid.test(row.assignment_id) || row.exam_id !== null) || row.kind === 'quiz' && (!uuid.test(row.exam_id) || row.assignment_id !== null)))
        return unavailable();
    const existing = bindings.find(row => row.kind === kind);
    if (operation === 'list') {
        const activities = [];
        for (const binding of bindings) {
            const id = binding.kind === 'homework' ? binding.assignment_id : binding.exam_id;
            const page = await readLessonActivitySources(connection, binding.kind, courseId, tenantId, { ids: [id] }, false);
            const source = page.items.find(item => same(item.source_id, id));
            activities.push({ content_id: binding.id, kind: binding.kind, source_id: id, title: source?.title ?? null, source_status: source?.source_status ?? 'unavailable', audience: source?.audience ?? null });
        }
        return { status: 200, body: { activities }, commit: false };
    }
    if (operation === 'detach' && !existing)
        return { status: 200, body: { detached: false, kind }, commit: false };
    if (operation === 'detach' && !same(existing.id, input.contentId))
        return { status: 409, body: { error: 'Lesson activity changed; refresh before detaching', code: 'LESSON_ACTIVITY_CHANGED' }, commit: false };
    const sourceId = operation === 'detach' ? existing[kind === 'homework' ? 'assignment_id' : 'exam_id'] : input.sourceId;
    let source;
    if (operation === 'attach') {
        source = (await readLessonActivitySources(connection, kind, courseId, tenantId, { ids: [sourceId] }, true)).items.find(item => same(item.source_id, sourceId));
        if (!source)
            return missing();
        if (existing)
            return same(existing[kind === 'homework' ? 'assignment_id' : 'exam_id'], sourceId)
                ? { status: 200, body: { content: { content_id: existing.id, kind, ...source }, unchanged: true }, commit: false }
                : { status: 409, body: { error: 'Detach the existing activity before replacing it', code: 'LESSON_ACTIVITY_OCCUPIED' }, commit: false };
    }
    const id = existing?.id ?? (0, crypto_1.randomUUID)();
    const [changed] = operation === 'detach'
        ? await connection.execute('DELETE FROM course_lesson_activities WHERE id=? AND lesson_id=? AND kind=?', [id, lessonId, kind])
        : await connection.execute('INSERT INTO course_lesson_activities (id,lesson_id,kind,assignment_id,exam_id) VALUES (?,?,?,?,?)', [id, lessonId, kind, kind === 'homework' ? sourceId : null, kind === 'quiz' ? sourceId : null]);
    if (Number(changed.affectedRows) !== 1)
        throw Error('Activity reference write failed');
    const value = JSON.stringify({ lesson_id: lessonId, kind, source_id: sourceId });
    const [audit] = await connection.execute('INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)', [(0, crypto_1.randomUUID)(), userId, tenantId, `course_lesson_activity.${operation}`, 'course_lesson_activity', id, operation === 'detach' ? value : null, operation === 'attach' ? value : null]);
    if (Number(audit.affectedRows) !== 1)
        throw Error('Activity audit failed');
    return operation === 'detach' ? { status: 200, body: { detached: true, kind }, commit: true }
        : { status: 201, body: { content: { content_id: id, kind, ...source }, unchanged: false }, commit: true };
}
