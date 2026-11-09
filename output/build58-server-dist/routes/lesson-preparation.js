"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLessonPreparationRouter = createLessonPreparationRouter;
const express_1 = require("express");
const lesson_package_reuse_1 = require("../services/lesson-package-reuse");
const lesson_quiz_versions_1 = require("../services/lesson-quiz-versions");
const lesson_package_timing_1 = require("../services/lesson-package-timing");
const lesson_learning_evidence_1 = require("../services/lesson-learning-evidence");
const uuid = (value) => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = () => ({ status: 503, body: { code: 'LESSON_PREPARATION_UNAVAILABLE', error: 'Preparation evidence is unavailable' } });
/** Read-only owner preparation. No student analytics, delivery or grant implied. */
function createLessonPreparationRouter(deps) {
    const router = (0, express_1.Router)();
    const path = '/courses/:courseId/units/:unitId/lessons/:lessonId/preparation';
    router.get([path, path + '/groups', path + '/learning'], async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (req.user?.billingOnly)
            return res.status(403).json({ code: 'BILLING_ONLY', error: 'Forbidden' });
        const { courseId, unitId, lessonId } = req.params;
        const learning = req.url.split('?')[0].endsWith('/learning'), groups = req.url.split('?')[0].endsWith('/groups');
        const window = learning ? (0, lesson_learning_evidence_1.parseLearningWindow)(req.query) : null;
        const groupCursor = typeof req.query?.cursor === 'string' ? req.query.cursor : '';
        const validQuery = learning ? window !== null : groups ? Object.keys(req.query ?? {}).every(key => key === 'cursor') && (req.query?.cursor === undefined || uuid(req.query.cursor)) : Object.keys(req.query ?? {}).length === 0;
        if (![courseId, unitId, lessonId].every(uuid) || !validQuery
            || ['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'].some(key => req.headers[key] !== undefined)
            || req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
            return res.status(400).json({ error: 'Invalid preparation selectors' });
        const userId = req.user?.id, tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Tenant membership not found' });
        let connection = null, started = false, discard = false;
        try {
            connection = await deps.getConnection();
            await connection.beginTransaction();
            started = true;
            // Same owner/course lock protocol as package preparation; JWT selectors
            // never replace the current active owner relationship.
            const [owners] = await connection.execute('SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE', [userId, tenantId]);
            const owner = owners[0];
            if (owners.length !== 1 || owner.owner_user_id !== userId || owner.tenant_status !== 'active' || Number(owner.caller_active) !== 1)
                return res.status(403).json({ error: 'Forbidden' });
            const [courses] = await connection.execute('SELECT c.id,c.tenant_id FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=1 FOR UPDATE', [courseId, tenantId]);
            if (courses.length !== 1 || !same(courses[0].id, courseId) || courses[0].tenant_id !== tenantId)
                return res.status(404).json({ error: 'Course not found' });
            const [parents] = await connection.execute(`SELECT l.id,l.unit_id,l.title,l.status,UNIX_TIMESTAMP(l.release_at) AS release_at_epoch,u.status AS unit_status
        FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id WHERE l.id=? AND l.unit_id=? AND u.course_id=? LIMIT 2 FOR UPDATE`, [lessonId, unitId, courseId]);
            const lesson = parents[0];
            if (parents.length !== 1 || !same(lesson.id, lessonId) || !same(lesson.unit_id, unitId))
                return res.status(404).json({ error: 'Lesson not found' });
            if (!['active', 'archived'].includes(lesson.status) || !['active', 'archived'].includes(lesson.unit_status)
                || typeof lesson.title !== 'string' || !lesson.title.trim() || lesson.title.length > 255 || lesson.release_at_epoch === undefined)
                throw Error('Invalid preparation lesson');
            const release = (0, lesson_package_timing_1.renderReleaseInstant)(lesson.release_at_epoch);
            if (release === undefined)
                throw Error('Invalid preparation release');
            if (!await (0, lesson_package_reuse_1.lessonPackageReferenceSchema)(connection)) {
                const response = unavailable();
                return res.status(response.status).json(response.body);
            }
            if (groups || learning) {
                const response = groups ? await (0, lesson_learning_evidence_1.listPreparationGroups)(connection, courseId, tenantId, groupCursor) : await (0, lesson_learning_evidence_1.readLessonLearning)(connection, { userId, tenantId, courseId, lessonId, window: window });
                return res.status(response.status).json(response.body);
            }
            const bindings = await (0, lesson_package_reuse_1.readLessonPackageBindings)(connection, lessonId);
            const items = [];
            for (const binding of bindings) {
                const source = await (0, lesson_package_reuse_1.readLessonPackageSource)(connection, binding, courseId, tenantId);
                let quizVersion = null;
                if (source && binding.kind === 'quiz') {
                    const version = await (0, lesson_quiz_versions_1.manageLessonQuizVersion)(connection, { userId, tenantId, courseId, lessonId, contentId: binding.id, operation: 'read' });
                    if (version.status !== 200) {
                        const response = unavailable();
                        return res.status(response.status).json(response.body);
                    }
                    quizVersion = version.body.pin?.status ?? 'missing';
                    if (!['published', 'missing', 'unavailable'].includes(quizVersion))
                        throw Error('Invalid preparation quiz version');
                }
                const issue = !source ? 'source_unavailable' : binding.kind === 'quiz' && quizVersion !== 'published' ? 'quiz_version_required'
                    : source.state === 'draft' ? 'draft_source' : source.audience === 'restricted' ? 'restricted_audience' : null;
                items.push({ binding_id: binding.id, kind: binding.kind, title: source?.title ?? null, display_order: binding.display_order,
                    source_state: source?.state ?? 'unavailable', audience: source?.audience ?? null, quiz_version: quizVersion, issue });
            }
            items.sort((a, b) => lesson_package_reuse_1.packageKinds.indexOf(a.kind) - lesson_package_reuse_1.packageKinds.indexOf(b.kind) || a.binding_id.localeCompare(b.binding_id));
            // No raw source facts, bodies, group/student identifiers or URLs leave here.
            return res.json({ context: { course_id: courseId.toLowerCase(), unit_id: unitId.toLowerCase(), lesson_id: lessonId.toLowerCase() },
                checked_at: new Date().toISOString(), lesson: { title: lesson.title, status: lesson.status, unit_status: lesson.unit_status, release_at: release },
                rule_version: 'preparation-v1', items, learning_evidence: 'insufficient' });
        }
        catch (error) {
            discard = true;
            if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_CANT_OPEN_TABLE', 'ER_UNKNOWN_TABLE'].includes(error?.code)) {
                const response = unavailable();
                return res.status(response.status).json(response.body);
            }
            return res.status(500).json({ error: 'Could not verify preparation evidence' });
        }
        finally {
            if (connection) {
                // Read-only transaction, always rollback. A failed cleanup must never
                // recycle an open transaction, even when the response was already sent.
                if (started) {
                    try {
                        await connection.rollback();
                    }
                    catch {
                        discard = true;
                    }
                }
                try {
                    if (discard)
                        connection.destroy();
                    else
                        connection.release();
                }
                catch { /* discarded/closed */ }
            }
        }
    });
    return router;
}
