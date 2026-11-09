"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.announcementPublicationSchema = announcementPublicationSchema;
exports.manageAnnouncementPublication = manageAnnouncementPublication;
exports.readStudentLessonAnnouncement = readStudentLessonAnnouncement;
const crypto_1 = require("crypto");
const lesson_announcements_1 = require("./lesson-announcements");
const student_lesson_audience_1 = require("./student-lesson-audience");
const audit_1 = require("../security/audit");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const hash = (x) => (0, crypto_1.createHash)('sha256').update(JSON.stringify(x)).digest('hex');
const digest = (x) => typeof x === 'string' && /^[a-f\d]{64}$/.test(x);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const unavailable = () => ({ status: 503, body: { error: 'Lesson announcement publication unavailable', code: 'LESSON_ANNOUNCEMENT_PUBLICATION_UNAVAILABLE' }, commit: false });
const conflict = () => ({ status: 409, body: { error: 'Announcement or audience review changed; preview again', code: 'ANNOUNCEMENT_REVIEW_CHANGED' }, commit: false });
async function announcementPublicationSchema(connection) {
    if (!await (0, lesson_announcements_1.lessonAnnouncementSchema)(connection))
        return false;
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type,CHARACTER_MAXIMUM_LENGTH AS max_length,COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='course_lesson_announcement_publications' AND COLUMN_NAME IN ('id','content_id','group_id','source_fingerprint','published_at')) OR (TABLE_NAME='group_announcements' AND COLUMN_NAME='updated_at')) LIMIT 6`);
    const rows = columns;
    if (!['id', 'content_id', 'group_id', 'source_fingerprint', 'published_at'].every(col => rows.some(r => r.table_name === 'course_lesson_announcement_publications' && r.column_name === col)) || !rows.some(r => r.table_name === 'group_announcements' && r.column_name === 'updated_at') || !rows.some(r => r.column_name === 'source_fingerprint' && r.data_type === 'char' && Number(r.max_length) === 64 && r.collation_name === 'ascii_bin'))
        return false;
    const [engine] = await connection.execute(`SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_announcement_publications' LIMIT 1`);
    if (engine[0]?.engine !== 'InnoDB')
        return false;
    const [indexes] = await connection.execute(`SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_announcement_publications' AND INDEX_NAME IN ('PRIMARY','uq_lesson_announcement_publication') ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 3`);
    for (const [name, col] of [['PRIMARY', 'id'], ['uq_lesson_announcement_publication', 'content_id']]) {
        const found = indexes.filter(r => r.index_name === name);
        if (found.length !== 1 || found[0].column_name !== col || Number(found[0].seq_in_index) !== 1 || Number(found[0].non_unique) !== 0)
            return false;
    }
    const [fks] = await connection.execute(`SELECT k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='course_lesson_announcement_publications' AND k.REFERENCED_TABLE_SCHEMA=DATABASE() LIMIT 2`);
    return fks.length === 1 && fks[0].column_name === 'content_id' && fks[0].referenced_table === 'course_lesson_announcements' && fks[0].referenced_column === 'id' && fks[0].delete_rule === 'CASCADE';
}
async function binding(connection, lessonId, lock) {
    const [rows] = await connection.execute(`SELECT id,announcement_id FROM course_lesson_announcements WHERE lesson_id=? LIMIT 2${lock ? ' FOR UPDATE' : ''}`, [lessonId]);
    if (rows.length > 1)
        throw Error('Invalid announcement reference');
    const row = rows[0];
    if (row && (!uuid(row.id) || !uuid(row.announcement_id)))
        throw Error('Invalid announcement reference');
    return row;
}
async function publication(connection, contentId, lock) {
    const [rows] = await connection.execute(`SELECT id,content_id,group_id,source_fingerprint,UNIX_TIMESTAMP(published_at) AS published_epoch FROM course_lesson_announcement_publications WHERE content_id=? LIMIT 2${lock ? ' FOR UPDATE' : ''}`, [contentId]);
    if (rows.length > 1)
        throw Error('Invalid announcement publication');
    const row = rows[0];
    if (row && (!uuid(row.id) || row.content_id !== contentId || !uuid(row.group_id) || !digest(row.source_fingerprint) || !['number', 'string'].includes(typeof row.published_epoch) || !Number.isFinite(Number(row.published_epoch))))
        throw Error('Invalid announcement publication');
    return row;
}
async function source(connection, courseId, tenantId, sourceId, lock) {
    const row = (await (0, lesson_announcements_1.readLessonAnnouncementSources)(connection, courseId, tenantId, { id: sourceId }, lock)).items.find(r => r && same(r.id, sourceId));
    if (!row)
        return null;
    const [revision] = await connection.execute(`SELECT DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') AS source_revision FROM group_announcements WHERE id=? AND tenant_id=? AND group_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [sourceId, tenantId, row.group_id]);
    const stamp = revision[0]?.source_revision;
    if (typeof stamp !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/.test(stamp))
        throw Error('Invalid announcement revision');
    return { row, fingerprint: hash([sourceId.toLowerCase(), row.group_id.toLowerCase(), row.title, row.body, row.state, stamp, row.branch_scope, row.branch_id]) };
}
const project = (row, current) => row ? { id: row.id, content_id: row.content_id, status: current ? 'published' : 'source_changed', published_at: new Date(Number(row.published_epoch) * 1000).toISOString() } : null;
/** Caller proves owner/course/unit/lesson and locks parents for mutations. */
async function manageAnnouncementPublication(connection, input) {
    if (!await announcementPublicationSchema(connection))
        return unavailable();
    const lock = input.operation === 'publish' || input.operation === 'withdraw', ref = await binding(connection, input.lessonId, lock);
    if (!ref || !same(ref.id, input.contentId))
        return conflict();
    const saved = await publication(connection, ref.id, lock);
    const currentSource = input.operation === 'withdraw' ? null : await source(connection, input.courseId, input.tenantId, ref.announcement_id, lock);
    const valid = Boolean(saved && currentSource?.row.state === 'published' && same(saved.group_id, currentSource.row.group_id) && saved.source_fingerprint === currentSource.fingerprint);
    if (input.operation === 'read')
        return { status: 200, body: { publication: project(saved, valid) }, commit: false };
    let freshToken;
    if (input.operation === 'review' || input.operation === 'publish') {
        const result = await (0, lesson_announcements_1.manageLessonAnnouncement)(connection, { ...input, operation: 'preview', reviewLock: lock });
        if (result.status !== 200)
            return result;
        const preview = result.body.preview;
        if (!currentSource)
            return conflict();
        const { previewed_at, ...facts } = preview;
        freshToken = hash([1, input.tenantId, input.courseId.toLowerCase(), input.lessonId.toLowerCase(), ref.id.toLowerCase(), currentSource.fingerprint, saved?.id ?? null, facts]);
        const canPublish = preview.source_state === 'published' && preview.course_published && preview.lesson_active;
        if (input.operation === 'review')
            return { status: 200, body: { preview, review_token: freshToken, can_publish: canPublish, publication: project(saved, valid) }, commit: false };
        if (!canPublish || input.reviewToken !== freshToken)
            return conflict();
        if (valid)
            return { status: 200, body: { publication: project(saved, true), unchanged: true }, commit: false };
    }
    if (input.operation === 'withdraw' && (!saved || !same(saved.id, input.publicationId)))
        return saved ? conflict() : { status: 200, body: { withdrawn: false }, commit: false };
    if (saved) {
        const [deleted] = await connection.execute('DELETE FROM course_lesson_announcement_publications WHERE id=? AND content_id=?', [saved.id, ref.id]);
        if (Number(deleted.affectedRows) !== 1)
            throw Error('Publication changed');
    }
    const newId = input.operation === 'publish' ? (0, crypto_1.randomUUID)() : null;
    if (newId) {
        const [inserted] = await connection.execute('INSERT INTO course_lesson_announcement_publications (id,content_id,group_id,source_fingerprint) VALUES (?,?,?,?)', [newId, ref.id, currentSource.row.group_id, currentSource.fingerprint]);
        if (Number(inserted.affectedRows) !== 1)
            throw Error('Publication not confirmed');
    }
    await (0, audit_1.recordAudit)(async (sql, p) => {
        const [result] = await connection.execute(sql, p);
        if (Number(result.affectedRows) !== 1)
            throw Error('Publication audit failed');
        return result;
    }, { actorUserId: input.userId, tenantId: input.tenantId, action: `course_lesson_announcement.${input.operation}`, resourceType: 'course_lesson_announcement', resourceId: ref.id, oldValue: saved ? { publication_id: saved.id } : null, newValue: newId ? { publication_id: newId, group_id: currentSource.row.group_id, source_fingerprint: currentSource.fingerprint } : null });
    if (!newId)
        return { status: 200, body: { withdrawn: true }, commit: true };
    const persisted = await publication(connection, ref.id, true);
    if (!persisted || persisted.id !== newId)
        throw Error('Publication receipt missing');
    return { status: 201, body: { publication: project(persisted, true), unchanged: false }, commit: true };
}
async function readStudentLessonAnnouncement(connection, scope, courseId, lessonId, principal) {
    const proof = await (0, student_lesson_audience_1.proveStudentLessonAudience)(connection, scope, courseId, lessonId, principal, { lock: true });
    if (!proof.ok)
        return proof;
    if (!await announcementPublicationSchema(connection))
        return unavailable();
    const empty = () => ({ status: 200, body: { lesson_id: lessonId, announcement: null }, commit: false });
    const ref = await binding(connection, lessonId, true);
    if (!ref)
        return empty();
    const saved = await publication(connection, ref.id, true);
    if (!saved || !same(saved.group_id, proof.group.id))
        return empty();
    const current = await source(connection, courseId, scope.tenantId, ref.announcement_id, true);
    if (!current || current.row.state !== 'published' || !same(current.row.group_id, proof.group.id) || saved.source_fingerprint !== current.fingerprint)
        return empty();
    const finalProof = await (0, student_lesson_audience_1.proveStudentLessonAudience)(connection, scope, courseId, lessonId, principal, { lock: true });
    if (!finalProof.ok)
        return finalProof;
    if (!same(finalProof.group.id, proof.group.id))
        return empty();
    return { status: 200, body: { lesson_id: lessonId, announcement: { content_id: ref.id, publication_id: saved.id, title: current.row.title, body: current.row.body, published_at: project(saved, true).published_at } }, commit: false };
}
