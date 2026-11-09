"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStudentLessonVideos = listStudentLessonVideos;
exports.proveStudentCatalogVideo = proveStudentCatalogVideo;
const student_lesson_audience_1 = require("./student-lesson-audience");
const lesson_videos_1 = require("./lesson-videos");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const yes = (value) => value === 1 || value === true || value === '1';
const missing = () => ({ ok: false, status: 404, body: { error: 'Lesson video not found' }, commit: false });
const unavailable = () => ({ ok: false, status: 503, body: { error: 'Lesson video proof unavailable', code: 'CATALOG_VIDEO_UNAVAILABLE' }, commit: false });
/** Fresh request proof; no token, provider, locator, persistence or legacy fallback. */
async function authorizedVideos(connection, scope, courseId, lessonId, principal) {
    const audience = await (0, student_lesson_audience_1.proveStudentLessonAudience)(connection, scope, courseId, lessonId, principal, { missingError: 'Lesson video not found', unavailableCode: 'CATALOG_VIDEO_UNAVAILABLE' });
    if (!audience.ok)
        return audience;
    const { user, lessonProof: lesson } = audience;
    if (await (0, lesson_videos_1.lessonVideoSchema)(connection) !== 'ready')
        return unavailable();
    const [rows] = await connection.execute(`SELECT b.id AS content_id,b.video_id,b.display_order,v.id AS source_id,v.title,v.status,v.is_encrypted,v.hls_key,v.original_key
    FROM course_lesson_videos b LEFT JOIN videos v ON v.id=b.video_id AND v.course_id=? AND v.tenant_id=?
      AND v.status='ready' AND v.lecture_id IS NULL AND v.material_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM lectures l WHERE l.video_url=CONCAT('video://',v.id))
      AND NOT EXISTS (SELECT 1 FROM course_materials m WHERE m.material_type='video' AND m.file_url=CONCAT('video://',v.id))
    WHERE b.lesson_id=? ORDER BY b.display_order,b.id LIMIT 21`, [courseId, scope.tenantId, lessonId]);
    const bindings = rows, materials = await (0, lesson_videos_1.lessonMaterialPositions)(connection, lessonId);
    if (bindings.length + materials.length > 20 || bindings.some(row => typeof row.content_id !== 'string' || !uuid.test(row.content_id) || typeof row.video_id !== 'string' || !uuid.test(row.video_id) || !Number.isInteger(row.display_order) || row.display_order < 0 || row.display_order > 2147483647)
        || new Set(bindings.map(row => row.content_id.toLowerCase())).size !== bindings.length || new Set(bindings.map(row => row.video_id.toLowerCase())).size !== bindings.length
        || new Set([...bindings, ...materials].map(row => row.display_order)).size !== bindings.length + materials.length)
        return unavailable();
    const videos = [];
    for (const row of bindings) {
        if (!row.source_id)
            continue;
        if (!same(row.video_id, row.source_id) || typeof row.title !== 'string' || row.title.length > 255 || row.status !== 'ready')
            return unavailable();
        // Processing alone is insufficient even for advertising a future candidate.
        if (!yes(row.is_encrypted) || typeof row.hls_key !== 'string' || !row.hls_key || typeof row.original_key !== 'string' || !row.original_key || row.hls_key === row.original_key)
            continue;
        videos.push({ content_id: row.content_id, video_id: row.source_id, title: row.title, display_order: row.display_order });
    }
    return { ok: true, scope: { userId: String(user.id), tenantId: String(lesson.enrollment.tenant_id), enrollmentId: String(lesson.enrollment.enrollment_id) }, courseId: String(lesson.course.course_id), lessonId: String(lesson.lesson.id), videos };
}
async function listStudentLessonVideos(connection, scope, courseId, lessonId, principal) {
    const proof = await authorizedVideos(connection, scope, courseId, lessonId, principal);
    if (!proof.ok)
        return proof;
    return { status: 200, body: { lesson_id: proof.lessonId, videos: proof.videos.map(row => ({ content_id: row.content_id, title: row.title, display_order: row.display_order, playback_status: 'session_required' })) }, commit: false };
}
/** Issuance/delivery call this afresh AND must prove their own session. */
async function proveStudentCatalogVideo(connection, scope, courseId, lessonId, contentId, principal) {
    if (!uuid.test(contentId))
        return missing();
    const proof = await authorizedVideos(connection, scope, courseId, lessonId, principal);
    if (!proof.ok)
        return proof;
    const video = proof.videos.find(row => same(row.content_id, contentId));
    return video ? { ok: true, scope: proof.scope, courseId: proof.courseId, lessonId: proof.lessonId, video } : missing();
}
