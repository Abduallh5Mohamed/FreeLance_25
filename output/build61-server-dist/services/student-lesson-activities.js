"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStudentLessonActivities = listStudentLessonActivities;
exports.proveStudentCatalogActivity = proveStudentCatalogActivity;
exports.readStudentLessonActivity = readStudentLessonActivity;
const student_lesson_audience_1 = require("./student-lesson-audience");
const lesson_activities_1 = require("./lesson-activities");
const assignments_1 = require("./assignments");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = () => ({ ok: false, status: 503, body: { error: 'Lesson activities unavailable', code: 'LESSON_ACTIVITIES_UNAVAILABLE' }, commit: false });
const missing = () => ({ ok: false, status: 404, body: { error: 'Lesson activity not found' }, commit: false });
async function authorizedActivities(connection, scope, courseId, lessonId, principal, lock = false) {
    const audience = await (0, student_lesson_audience_1.proveStudentLessonAudience)(connection, scope, courseId, lessonId, principal, { lock });
    if (!audience.ok)
        return audience;
    if (!await (0, lesson_activities_1.lessonActivitySchemaReady)(connection))
        return unavailable();
    const [loaded] = await connection.execute(`SELECT id,kind,assignment_id,exam_id FROM course_lesson_activities WHERE lesson_id=? ORDER BY kind LIMIT 3${lock ? ' FOR UPDATE' : ''}`, [lessonId]);
    const bindings = loaded;
    if (bindings.length > 2 || new Set(bindings.map(row => row.kind)).size !== bindings.length || new Set(bindings.map(row => String(row.id).toLowerCase())).size !== bindings.length
        || bindings.some(row => typeof row.id !== 'string' || !uuid.test(row.id) || !['homework', 'quiz'].includes(row.kind)
            || row.kind === 'homework' && (typeof row.assignment_id !== 'string' || !uuid.test(row.assignment_id) || row.exam_id !== null)
            || row.kind === 'quiz' && (typeof row.exam_id !== 'string' || !uuid.test(row.exam_id) || row.assignment_id !== null)))
        return unavailable();
    const activities = [], group = audience.group;
    for (const binding of bindings) {
        const sourceId = binding.kind === 'homework' ? binding.assignment_id : binding.exam_id;
        const page = await (0, lesson_activities_1.readLessonActivitySources)(connection, binding.kind, courseId, scope.tenantId, { ids: [sourceId] }, lock);
        const source = page.items.find(row => same(row.source_id, sourceId));
        if (!source || source.source_status !== 'published')
            continue;
        if (binding.kind === 'homework') {
            const facts = page.facts.find(row => same(row.id, sourceId));
            if (!facts || !(0, assignments_1.enrollmentMatchesAssignment)({ tenantId: scope.tenantId, courseId, groupId: facts.group_id, branchId: facts.branch_id, branchScope: facts.branch_scope }, { tenantId: scope.tenantId, courseId, groupId: group.id, branchId: group.branch_scope === 'branch' ? group.branch_id : null })
                || facts.group_id !== null && !same(facts.group_id, group.id))
                continue;
        }
        else {
            const groups = page.groups.filter(row => same(row.exam_id, sourceId));
            // Preserve the existing exam rule that conflicting parent branches deny.
            const branches = new Set(groups.map(row => row.branch_scope === 'tenant' ? 'tenant' : String(row.branch_id).toLowerCase()));
            if (branches.size > 1 || groups.length && !groups.some(row => same(row.id, group.id)))
                continue;
        }
        activities.push({ content_id: binding.id, kind: binding.kind, source_id: source.source_id, title: source.title });
    }
    return { ok: true, scope, courseId, lessonId, activities };
}
/** Metadata only: no attempt eligibility, legacy redirect, enrollment or completion. */
async function listStudentLessonActivities(connection, scope, courseId, lessonId, principal) {
    const proof = await authorizedActivities(connection, scope, courseId, lessonId, principal);
    if (!proof.ok)
        return proof;
    return { status: 200, body: { lesson_id: lessonId, activities: proof.activities.map(row => ({ content_id: row.content_id, kind: row.kind, title: row.title, launch_status: row.kind === 'quiz' ? 'attempt_required' : 'submission_required' })) }, commit: false };
}
/** A fresh selected-reference proof, server-private and insufficient to start an attempt. */
async function proveStudentCatalogActivity(connection, scope, courseId, lessonId, contentId, principal, lock = false) {
    if (!uuid.test(contentId))
        return missing();
    const proof = await authorizedActivities(connection, scope, courseId, lessonId, principal, lock);
    if (!proof.ok)
        return proof;
    const activity = proof.activities.find(row => same(row.content_id, contentId));
    return activity ? { ok: true, scope: proof.scope, courseId, lessonId, activity } : missing();
}
async function readStudentLessonActivity(connection, scope, courseId, lessonId, contentId, principal) {
    const proof = await proveStudentCatalogActivity(connection, scope, courseId, lessonId, contentId, principal);
    if (!proof.ok)
        return proof;
    const { activity } = proof;
    let instructions = null, deadline = null;
    if (activity.kind === 'homework') {
        const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignments' AND COLUMN_NAME IN ('instructions','deadline_at') LIMIT 2`);
        if (!['instructions', 'deadline_at'].every(name => columns.some(row => row.column_name === name)))
            return unavailable();
        const [rows] = await connection.execute(`SELECT id,instructions,UNIX_TIMESTAMP(deadline_at) AS deadline_epoch FROM assignments WHERE id=? AND tenant_id=? AND course_id=? AND status='published' AND archived_at IS NULL LIMIT 1`, [activity.source_id, scope.tenantId, courseId]);
        const row = rows[0];
        if (!row || !same(row.id, activity.source_id))
            return missing();
        if (row.instructions !== null && (typeof row.instructions !== 'string' || row.instructions.length > assignments_1.MAX_INSTRUCTIONS_LENGTH))
            return unavailable();
        instructions = row.instructions;
        if (row.deadline_epoch !== null) {
            if (!['number', 'string'].includes(typeof row.deadline_epoch) || typeof row.deadline_epoch === 'string' && !row.deadline_epoch.trim() || !Number.isFinite(Number(row.deadline_epoch)))
                return unavailable();
            const instant = new Date(Number(row.deadline_epoch) * 1000);
            if (!Number.isFinite(instant.getTime()))
                return unavailable();
            deadline = instant.toISOString();
        }
    }
    return { status: 200, body: { activity: { content_id: activity.content_id, kind: activity.kind, title: activity.title, instructions, deadline_at: deadline, launch_status: activity.kind === 'quiz' ? 'attempt_required' : 'submission_required' } }, commit: false };
}
