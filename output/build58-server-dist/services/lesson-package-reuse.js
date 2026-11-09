"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.packageKinds = void 0;
exports.parsePackageReuseBody = parsePackageReuseBody;
exports.lessonPackageReferenceSchema = lessonPackageReferenceSchema;
exports.validatePackageBindings = validatePackageBindings;
exports.readLessonPackageBindings = readLessonPackageBindings;
exports.readLessonPackageSource = readLessonPackageSource;
exports.planLessonPackageFinalState = planLessonPackageFinalState;
exports.insertLessonPackageReference = insertLessonPackageReference;
exports.manageLessonPackageReuse = manageLessonPackageReuse;
const crypto_1 = require("crypto");
const lesson_videos_1 = require("./lesson-videos");
const lesson_activities_1 = require("./lesson-activities");
const lesson_announcements_1 = require("./lesson-announcements");
const audit_1 = require("../security/audit");
exports.packageKinds = ['material', 'video', 'homework', 'quiz', 'announcement'];
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const hash = (x) => (0, crypto_1.createHash)('sha256').update(JSON.stringify(x)).digest('hex');
const result = (status, body, commit = false) => ({ status, body, commit });
const unavailable = () => result(503, { error: 'Lesson package reuse schema unavailable', code: 'PACKAGE_REUSE_UNAVAILABLE' });
const exact = (x, fields) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === fields.slice().sort().join(',');
function parsePackageReuseBody(body, apply) {
    if (!exact(body, ['source_lesson_id', 'selections', ...(apply ? ['review_token', 'operation_id'] : [])]) || !uuid(body.source_lesson_id)
        || !Array.isArray(body.selections) || !body.selections.length || body.selections.length > 23
        || apply && (!uuid(body.operation_id) || typeof body.review_token !== 'string' || !/^[a-f\d]{64}$/.test(body.review_token)))
        return null;
    const selections = [];
    for (const row of body.selections) {
        if (!exact(row, ['kind', 'source_id']) || !exports.packageKinds.includes(row.kind) || !uuid(row.source_id))
            return null;
        selections.push({ kind: row.kind, source_id: row.source_id.toLowerCase() });
    }
    if (new Set(selections.map(row => `${row.kind}/${row.source_id}`)).size !== selections.length
        || selections.filter(row => ['material', 'video'].includes(row.kind)).length > 20
        || ['homework', 'quiz', 'announcement'].some(kind => selections.filter(row => row.kind === kind).length > 1))
        return null;
    selections.sort((a, b) => exports.packageKinds.indexOf(a.kind) - exports.packageKinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
    return { source_lesson_id: body.source_lesson_id.toLowerCase(), selections,
        ...(apply ? { review_token: body.review_token, operation_id: body.operation_id.toLowerCase() } : {}) };
}
const receiptColumns = ['tenant_id', 'operation_id', 'actor_user_id', 'course_id', 'lesson_id', 'request_hash', 'created_count', 'existing_count'];
async function lessonPackageReferenceSchema(connection) {
    return await (0, lesson_videos_1.lessonVideoSchema)(connection) === 'ready' && await (0, lesson_activities_1.lessonActivitySchemaReady)(connection) && await (0, lesson_announcements_1.lessonAnnouncementSchema)(connection);
}
async function schema(connection) {
    const required = {
        course_lesson_package_operations: receiptColumns,
        course_lesson_contents: ['id', 'lesson_id', 'material_id', 'display_order'],
    };
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type,CHARACTER_MAXIMUM_LENGTH AS max_length,IS_NULLABLE AS is_nullable,COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_package_operations','course_lesson_contents') LIMIT 32`);
    if (!Object.entries(required).every(([table, cols]) => cols.every(col => columns.some(row => row.table_name === table && row.column_name === col))))
        return false;
    for (const name of receiptColumns) {
        const row = columns.find(row => row.table_name === 'course_lesson_package_operations' && row.column_name === name);
        const numeric = name.endsWith('_count'), variable = ['tenant_id', 'actor_user_id'].includes(name);
        if (row.is_nullable !== 'NO' || row.data_type !== (numeric ? 'int' : variable ? 'varchar' : 'char')
            || !numeric && (Number(row.max_length) !== (variable || name === 'request_hash' ? 64 : 36) || row.collation_name !== 'utf8mb4_bin'))
            return false;
    }
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_package_operations','course_lesson_contents') LIMIT 2`);
    if (!Object.keys(required).every(table => tables.some(row => row.table_name === table && row.engine === 'InnoDB')))
        return false;
    const [indexes] = await connection.execute(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_package_operations','course_lesson_contents') AND INDEX_NAME IN ('PRIMARY','uq_lesson_contents_source','uq_lesson_contents_order') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 12`);
    for (const [table, name, cols] of [
        ['course_lesson_package_operations', 'PRIMARY', ['tenant_id', 'operation_id']], ['course_lesson_contents', 'PRIMARY', ['id']],
        ['course_lesson_contents', 'uq_lesson_contents_source', ['lesson_id', 'material_id']], ['course_lesson_contents', 'uq_lesson_contents_order', ['lesson_id', 'display_order']],
    ]) {
        const rows = indexes.filter(row => row.table_name === table && row.index_name === name);
        if (rows.length !== cols.length || !cols.every((col, i) => rows[i].column_name === col && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0))
            return false;
    }
    return await lessonPackageReferenceSchema(connection);
}
const mediaKinds = ['material', 'video'];
const singletonKinds = ['homework', 'quiz', 'announcement'];
/** Reject malformed/corrupt binding sets before any read/plan/write. */
function validatePackageBindings(rows, label = 'package') {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 23)
        throw Error(`Invalid ${label} binding count`);
    for (const row of rows) {
        if (!row || !exports.packageKinds.includes(row.kind) || !uuid(row.id) || !uuid(row.source_id))
            throw Error(`Invalid ${label} binding identity`);
        if (mediaKinds.includes(row.kind)) {
            if (typeof row.display_order !== 'number' || !Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647)
                throw Error(`Invalid ${label} media position`);
        }
        else if (row.display_order !== null)
            throw Error(`Invalid ${label} singleton position`);
    }
    const media = rows.filter(row => row.display_order !== null);
    if (media.length > 20 || new Set(media.map(row => row.display_order)).size !== media.length
        || new Set(rows.map(row => `${row.kind}/${row.source_id.toLowerCase()}`)).size !== rows.length
        || singletonKinds.some(kind => rows.filter(row => row.kind === kind).length > 1))
        throw Error(`Corrupt ${label} binding set`);
}
async function readLessonPackageBindings(connection, lessonId) {
    const rows = [];
    for (const [kind, table, column, limit] of [
        ['material', 'course_lesson_contents', 'material_id', 21], ['video', 'course_lesson_videos', 'video_id', 21],
        ['announcement', 'course_lesson_announcements', 'announcement_id', 2],
    ]) {
        const [loaded] = await connection.execute(`SELECT id,${column} AS source_id,${kind === 'announcement' ? 'NULL' : 'display_order'} AS display_order FROM ${table} WHERE lesson_id=? ORDER BY id LIMIT ${limit} FOR UPDATE`, [lessonId]);
        if (loaded.length >= limit)
            throw Error('Package binding bound exceeded');
        for (const row of loaded)
            rows.push({ kind, id: row.id, source_id: row.source_id, display_order: row.display_order });
    }
    const [activities] = await connection.execute(`SELECT id,kind,assignment_id,exam_id FROM course_lesson_activities WHERE lesson_id=? ORDER BY kind LIMIT 3 FOR UPDATE`, [lessonId]);
    if (activities.length > 2)
        throw Error('Package activity bound exceeded');
    for (const row of activities) {
        if (!['homework', 'quiz'].includes(row.kind) || (row.kind === 'homework' ? row.exam_id !== null : row.assignment_id !== null))
            throw Error('Invalid package activity');
        rows.push({ kind: row.kind, id: row.id, source_id: row.kind === 'homework' ? row.assignment_id : row.exam_id, display_order: null });
    }
    if (rows.some(row => !uuid(row.id) || !uuid(row.source_id) || (['material', 'video'].includes(row.kind)
        ? typeof row.display_order !== 'number' || !Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647 : row.display_order !== null)))
        throw Error('Invalid package bindings');
    const media = rows.filter(row => row.display_order !== null);
    if (media.length > 20 || new Set(media.map(row => row.display_order)).size !== media.length
        || new Set(rows.map(row => `${row.kind}/${row.source_id.toLowerCase()}`)).size !== rows.length
        || ['homework', 'quiz', 'announcement'].some(kind => rows.filter(row => row.kind === kind).length > 1))
        throw Error('Corrupt package final state');
    return rows;
}
async function readLessonPackageSource(connection, row, courseId, tenantId) {
    if (row.kind === 'material') {
        const [loaded] = await connection.execute(`SELECT id,title,material_type,is_published FROM course_materials WHERE id=? AND course_id=? LIMIT 1 FOR UPDATE`, [row.source_id, courseId]);
        const value = loaded[0];
        if (!value)
            return null;
        if (!uuid(value.id) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 255 || !['pdf', 'video', 'presentation', 'link', 'other'].includes(value.material_type) || ![0, 1, false, true].includes(value.is_published))
            throw Error('Invalid material source');
        return { title: value.title, audience: 'course', state: value.is_published ? 'published' : 'draft', facts: value };
    }
    if (row.kind === 'video') {
        const value = await (0, lesson_videos_1.eligibleLessonVideo)(connection, row.source_id, courseId, tenantId);
        return value ? { title: value.title, audience: 'course', state: 'ready', facts: value } : null;
    }
    if (row.kind === 'announcement') {
        const value = (await (0, lesson_announcements_1.readLessonAnnouncementSources)(connection, courseId, tenantId, { id: row.source_id }, true)).items[0];
        return value ? { title: value.title, audience: 'restricted', state: value.state, facts: value } : null;
    }
    const page = await (0, lesson_activities_1.readLessonActivitySources)(connection, row.kind, courseId, tenantId, { ids: [row.source_id] }, true);
    const value = page.items.find(item => same(item.source_id, row.source_id));
    return value ? { title: value.title, audience: value.audience, state: value.source_status, facts: { source: page.facts, groups: page.groups } } : null;
}
/**
 * One bounded final-state planner shared by direct reuse and saved templates.
 * It validates the desired bindings, reads the destination's current bindings,
 * re-proves every source under live authority and reports exact conflicts.
 * It performs NO writes.
 */
async function planLessonPackageFinalState(connection, input) {
    validatePackageBindings(input.desired, 'desired');
    const to = await readLessonPackageBindings(connection, input.lessonId);
    const planned = [], facts = [], items = [];
    for (const binding of input.desired) {
        const value = await readLessonPackageSource(connection, binding, input.courseId, input.tenantId);
        const existing = to.find(row => row.kind === binding.kind && same(row.source_id, binding.source_id));
        let conflict = !value ? 'source_unavailable' : null;
        if (!conflict) {
            if (binding.display_order !== null) {
                if (existing && existing.display_order !== binding.display_order)
                    conflict = 'different_position';
                if (to.some(row => row.display_order === binding.display_order && row !== existing))
                    conflict = 'position_occupied';
            }
            else if (to.some(row => row.kind === binding.kind && row !== existing))
                conflict = 'slot_occupied';
            planned.push({ binding, existing: !!existing });
        }
        facts.push(value?.facts ?? null);
        items.push({ kind: binding.kind, source_id: binding.source_id, title: value?.title ?? null, display_order: binding.display_order,
            audience: value?.audience ?? null, source_state: value?.state ?? null, outcome: conflict ? 'conflict' : existing ? 'present' : 'add', conflict });
    }
    let projected = to.filter(row => row.display_order !== null).length
        + planned.filter(row => !row.existing && row.binding.display_order !== null).length;
    if (projected > 20) {
        for (const item of items)
            if (item.outcome === 'add' && item.display_order !== null) {
                item.outcome = 'conflict';
                item.conflict = 'capacity';
            }
    }
    return { planned, items, facts, projected, to, canApply: items.every(item => item.outcome !== 'conflict') };
}
/** One shared reference write path used by both direct reuse and saved templates. */
async function insertLessonPackageReference(connection, lessonId, row) {
    const newId = (0, crypto_1.randomUUID)();
    let sql, params;
    if (row.kind === 'material' || row.kind === 'video') {
        const table = row.kind === 'material' ? 'course_lesson_contents' : 'course_lesson_videos', column = row.kind === 'material' ? 'material_id' : 'video_id';
        sql = `INSERT INTO ${table} (id,lesson_id,${column},display_order) VALUES (?,?,?,?)`;
        params = [newId, lessonId, row.source_id, row.display_order];
    }
    else if (row.kind === 'announcement') {
        sql = 'INSERT INTO course_lesson_announcements (id,lesson_id,announcement_id) VALUES (?,?,?)';
        params = [newId, lessonId, row.source_id];
    }
    else {
        sql = 'INSERT INTO course_lesson_activities (id,lesson_id,kind,assignment_id,exam_id) VALUES (?,?,?,?,?)';
        params = [newId, lessonId, row.kind, row.kind === 'homework' ? row.source_id : null, row.kind === 'quiz' ? row.source_id : null];
    }
    const [changed] = await connection.execute(sql, params);
    if (Number(changed.affectedRows) !== 1)
        throw Error('Package reference write not confirmed');
    return newId;
}
async function manageLessonPackageReuse(connection, input) {
    if (!await schema(connection))
        return unavailable();
    const { userId, tenantId, courseId, lessonId, operation } = input;
    const body = input.body;
    const operationId = operation === 'status' ? input.operationId : body?.operation_id;
    const requestHash = body ? hash({ courseId: courseId.toLowerCase(), lessonId: lessonId.toLowerCase(), body: { source_lesson_id: body.source_lesson_id, selections: body.selections, review_token: body.review_token } }) : null;
    if (operationId) {
        const [loaded] = await connection.execute(`SELECT actor_user_id,course_id,lesson_id,request_hash,created_count,existing_count FROM course_lesson_package_operations WHERE tenant_id=? AND operation_id=? LIMIT 1 FOR UPDATE`, [tenantId, operationId]);
        const receipt = loaded[0];
        if (receipt) {
            if (receipt.actor_user_id !== userId || !same(receipt.course_id, courseId) || !same(receipt.lesson_id, lessonId) || operation === 'apply' && receipt.request_hash !== requestHash)
                return result(409, { error: 'Operation identity already used', code: 'PACKAGE_OPERATION_CONFLICT' });
            if (typeof receipt.request_hash !== 'string' || !/^[a-f\d]{64}$/.test(receipt.request_hash)
                || ![receipt.created_count, receipt.existing_count].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 23)
                || receipt.created_count + receipt.existing_count < 1 || receipt.created_count + receipt.existing_count > 23)
                throw Error('Invalid package receipt');
            const summary = { operation_id: operationId, created: receipt.created_count, existing: receipt.existing_count };
            return result(200, operation === 'status' ? { operation: summary } : { ...summary, replayed: true });
        }
        if (operation === 'status')
            return result(200, { operation: null });
    }
    if (!body || same(body.source_lesson_id, lessonId))
        return result(400, { error: 'Choose a different source lesson' });
    // Course/owner and destination parents have already been locked by the caller.
    // Source unit is derived here, never accepted as course/tenant authority.
    const [lessons] = await connection.execute(`SELECT l.id,l.unit_id,l.status,u.status AS unit_status FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id WHERE l.id IN (?,?) AND u.course_id=? ORDER BY l.id LIMIT 3 FOR UPDATE`, [body.source_lesson_id, lessonId, courseId]);
    if (lessons.length !== 2 || ![body.source_lesson_id, lessonId].every(id => lessons.some(row => same(row.id, id))))
        return result(404, { error: 'Package lesson not found' });
    if (lessons.some(row => row.status !== 'active' || row.unit_status !== 'active'))
        return result(409, { error: 'Package lessons must be active', code: 'PACKAGE_LESSON_INACTIVE' });
    const from = await readLessonPackageBindings(connection, body.source_lesson_id);
    const desired = [];
    for (const selection of body.selections) {
        const binding = from.find(row => row.kind === selection.kind && same(row.source_id, selection.source_id));
        if (binding)
            desired.push(binding);
    }
    // The planner re-proves every selected source under live authority and owns
    // the shared position/count/singleton policy. Direct reuse and templates use
    // the exact same final-state logic.
    const plan = await planLessonPackageFinalState(connection, { courseId, tenantId, lessonId, desired });
    const { planned, projected, to } = plan;
    const items = [...plan.items], facts = [...plan.facts];
    for (const selection of body.selections) {
        if (from.some(row => row.kind === selection.kind && same(row.source_id, selection.source_id)))
            continue;
        facts.push(null);
        items.push({ kind: selection.kind, source_id: selection.source_id, title: null, display_order: null,
            audience: null, source_state: null, outcome: 'conflict', conflict: 'source_unavailable' });
    }
    const canApply = items.every(item => item.outcome !== 'conflict');
    const token = hash({ userId, tenantId, courseId: courseId.toLowerCase(), lessonId: lessonId.toLowerCase(), sourceId: body.source_lesson_id, selections: body.selections, lessons, from, to, facts, items });
    if (operation === 'review')
        return result(200, { review_token: token, can_apply: canApply, items, projected_media_count: projected });
    if (body.review_token !== token)
        return result(409, { error: 'Package review changed; review again', code: 'PACKAGE_REVIEW_CHANGED' });
    if (!canApply)
        return result(409, { error: 'Package references conflict', code: 'PACKAGE_REUSE_CONFLICT' });
    let created = 0;
    for (const entry of planned) {
        if (entry.existing)
            continue;
        await insertLessonPackageReference(connection, lessonId, entry.binding);
        created++;
    }
    const existing = planned.length - created;
    await (0, audit_1.recordAudit)(async (sql, params) => {
        const [audit] = await connection.execute(sql, params);
        if (Number(audit.affectedRows) !== 1)
            throw Error('Package reuse audit not confirmed');
        return audit;
    }, { actorUserId: userId, tenantId, action: 'course_lesson_package.reuse', resourceType: 'course_lesson', resourceId: lessonId,
        newValue: (0, audit_1.snapshotRow)({ operation_id: operationId, source_lesson_id: body.source_lesson_id, selections: body.selections, created, existing }) });
    const [receipt] = await connection.execute(`INSERT INTO course_lesson_package_operations (tenant_id,operation_id,actor_user_id,course_id,lesson_id,request_hash,created_count,existing_count) VALUES (?,?,?,?,?,?,?,?)`, [tenantId, operationId, userId, courseId, lessonId, requestHash, created, existing]);
    if (Number(receipt.affectedRows) !== 1)
        throw Error('Package receipt write not confirmed');
    return result(201, { operation_id: operationId, created, existing, replayed: false }, true);
}
