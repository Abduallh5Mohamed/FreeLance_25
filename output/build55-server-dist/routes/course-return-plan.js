"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseReturnInput = parseReturnInput;
exports.createCourseReturnPlanRouter = createCourseReturnPlanRouter;
const express_1 = require("express");
const crypto_1 = require("crypto");
const student_lesson_access_1 = require("../services/student-lesson-access");
const suspension_predicate_1 = require("../security/suspension-predicate");
const saved_return_plans_1 = require("../services/saved-return-plans");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const identity = (x) => typeof x === 'string' && !!x && x.trim() === x && x.length <= 64;
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const flag = (x) => { if (![0, 1, false, true, '0', '1'].includes(x))
    throw Error('Invalid return-plan flag'); return x === 1 || x === true || x === '1'; };
const iso = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
function parseReturnInput(raw, review = false) {
    if (!exact(raw, ['enrollment_id', 'from', 'to', 'steps', ...(review ? ['review_token'] : [])]) || !identity(raw.enrollment_id) || !iso(raw.from) || !iso(raw.to)
        || Date.parse(raw.to) <= Date.parse(raw.from) || Date.parse(raw.to) - Date.parse(raw.from) > 31 * 86400000 || !Array.isArray(raw.steps) || raw.steps.length > 3 || review && !raw.steps.length)
        return null;
    if (raw.steps.some((s) => !exact(s, ['lesson_id', 'minutes']) || !uuid(s.lesson_id) || s.minutes !== null && (!Number.isInteger(s.minutes) || s.minutes < 1 || s.minutes > 180))
        || new Set(raw.steps.map((s) => s.lesson_id.toLowerCase())).size !== raw.steps.length || review && (typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token)))
        return null;
    return { enrollment_id: raw.enrollment_id, from: raw.from, to: raw.to, steps: raw.steps.map((s) => ({ lesson_id: s.lesson_id.toLowerCase(), minutes: s.minutes })), ...(review ? { review_token: raw.review_token } : {}) };
}
const TABLES = { attendance_records: ['id', 'tenant_id', 'session_id', 'student_id', 'state'], schedule_sessions: ['id', 'tenant_id', 'group_id', 'audience', 'title', 'starts_at', 'ends_at', 'status'], course_lesson_completions: ['id', 'student_enrollment_id', 'lesson_id', 'completed_at'] };
async function schema(c) {
    const [cols] = await c.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('attendance_records','schedule_sessions','course_lesson_completions') LIMIT 40`);
    if (!Object.entries(TABLES).every(([t, names]) => names.every(name => cols.some(row => row.table_name === t && row.column_name === name))))
        return false;
    const [engines] = await c.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('attendance_records','schedule_sessions','course_lesson_completions') LIMIT 3`);
    return Object.keys(TABLES).every(t => engines.some(row => row.table_name === t && row.engine === 'InnoDB'));
}
const STUDENT_SQL = `SELECT s.id AS enrollment_id,s.user_id,u.name,g.id AS group_id,g.branch_scope,g.branch_id,b.id AS resolved_branch_id,b.tenant_id AS branch_tenant_id,b.status AS branch_status
  FROM students s INNER JOIN users u ON u.id=s.user_id INNER JOIN \`groups\` g ON g.id=s.group_id INNER JOIN student_courses sc ON sc.student_id=s.id AND sc.course_id=g.course_id AND sc.status='active'
  LEFT JOIN branches b ON b.id=g.branch_id WHERE s.tenant_id=? AND g.course_id=? AND s.is_active=1 AND s.approval_status='approved'
  AND (s.enrollment_status IS NULL OR s.enrollment_status='active') AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP()) AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
  AND u.is_active=1 AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')}`;
function validStudent(row, tenantId) {
    return identity(row.enrollment_id) && identity(row.user_id) && uuid(row.group_id) && typeof row.name === 'string' && row.name.trim() && row.name.length <= 255
        && (row.branch_scope === 'tenant' && row.branch_id === null || row.branch_scope === 'branch' && uuid(row.branch_id) && row.branch_id === row.resolved_branch_id && row.branch_tenant_id === tenantId && row.branch_status === 'active');
}
function createCourseReturnPlanRouter(deps) {
    const router = (0, express_1.Router)(), base = '/courses/:courseId/return-plan';
    const handle = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (req.user?.billingOnly)
            return res.status(403).json({ code: 'BILLING_ONLY' });
        const courseId = typeof req.params.courseId === 'string' ? req.params.courseId.toLowerCase() : '', recovery = !!req.params.operationId, roster = req.method === 'GET' && !recovery, review = req.url.split('?')[0].endsWith('/review'), saving = req.url.split('?')[0].endsWith('/save'), withdraw = req.url.split('?')[0].endsWith('/withdraw');
        const raw = req.body;
        const writeShape = saving ? exact(raw, ['enrollment_id', 'from', 'to', 'steps', 'review_token', 'operation_id', 'expected_version']) : withdraw ? exact(raw, ['enrollment_id', 'operation_id', 'expected_version']) : true;
        const writeValid = (!saving && !withdraw) || writeShape && uuid(raw.operation_id) && Number.isInteger(raw.expected_version) && raw.expected_version >= 0 && raw.expected_version < 2147483647 && identity(raw.enrollment_id);
        const body = roster || recovery || withdraw ? null : parseReturnInput(saving && writeShape ? { enrollment_id: raw.enrollment_id, from: raw.from, to: raw.to, steps: raw.steps, review_token: raw.review_token } : raw, review || saving);
        const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : '';
        if (!uuid(courseId) || ['x-tenant-id', 'x-student-id', 'x-enrollment-id', 'x-instructor-id'].some(key => req.headers[key] !== undefined)
            || !writeValid || recovery && !uuid(req.params.operationId)
            || roster && (Object.keys(req.query ?? {}).some(key => key !== 'cursor') || req.query?.cursor !== undefined && !identity(req.query.cursor) || req.body != null && (!exact(req.body, [])))
            || recovery && (Object.keys(req.query ?? {}).length || req.body != null && !exact(req.body, []))
            || !roster && !recovery && ((!withdraw && !body) || Object.keys(req.query ?? {}).length))
            return res.status(400).json({ error: 'Invalid return-plan input' });
        const userId = req.user?.id, tenantId = req.user?.tenantId;
        if (!userId || !tenantId)
            return res.status(404).json({ error: 'Workspace not found' });
        let c = null, started = false, discard = false, commitAttempted = false;
        const unavailable = () => res.status(503).json({ code: 'RETURN_PLAN_UNAVAILABLE' });
        try {
            c = await deps.getConnection();
            await c.beginTransaction();
            started = true;
            const [owners] = await c.execute('SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=? FOR UPDATE', [userId, tenantId]);
            const owner = owners[0];
            if (owners.length !== 1 || owner.owner_user_id !== userId || owner.tenant_status !== 'active' || !flag(owner.caller_active))
                return res.status(403).json({ error: 'Forbidden' });
            const [courses] = await c.execute('SELECT c.id,c.tenant_id FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=1 FOR UPDATE', [courseId, tenantId]);
            if (courses.length !== 1 || !same(courses[0].id, courseId) || courses[0].tenant_id !== tenantId)
                return res.status(404).json({ error: 'Course not found' });
            const storageReady = await (0, saved_return_plans_1.savedReturnSchema)(c);
            const operationId = (recovery ? req.params.operationId : raw?.operation_id)?.toLowerCase();
            const requestHash = saving || withdraw ? (0, crypto_1.createHash)('sha256').update(JSON.stringify({ kind: saving ? 'save' : 'withdraw', courseId: courseId.toLowerCase(), ...(saving ? body : { enrollment_id: raw.enrollment_id }), expected_version: raw.expected_version })).digest('hex') : null;
            if (recovery || saving || withdraw) {
                if (!storageReady)
                    return res.status(503).json({ code: 'RETURN_PLAN_STORAGE_UNAVAILABLE' });
                const receipt = await (0, saved_return_plans_1.readPlanOperation)(c, tenantId, operationId);
                if (receipt) {
                    if (receipt.actor_user_id !== userId || !same(receipt.course_id, courseId) || !recovery && (receipt.request_hash !== requestHash || receipt.enrollment_id !== raw.enrollment_id))
                        return res.status(409).json({ code: 'RETURN_PLAN_OPERATION_CONFLICT' });
                    return res.json({ operation: (0, saved_return_plans_1.receiptDto)(receipt, operationId) });
                }
                if (recovery)
                    return res.json({ operation: null });
            }
            if (withdraw) {
                const head = await (0, saved_return_plans_1.readPlanHead)(c, tenantId, courseId, raw.enrollment_id);
                if (!head)
                    return res.status(404).json({ error: 'Plan not found' });
                if (head.version !== raw.expected_version)
                    return res.status(409).json({ code: 'RETURN_PLAN_VERSION_CHANGED' });
                const [rows] = await c.execute("SELECT DATE_FORMAT(from_at,'%Y-%m-%dT%H:%i:%s.000Z') AS from_at,DATE_FORMAT(to_at,'%Y-%m-%dT%H:%i:%s.000Z') AS to_at FROM course_return_plan_revisions WHERE plan_id=? AND version=? LIMIT 1 FOR UPDATE", [head.id, head.version]);
                const previous = rows[0];
                if (!previous || !iso(previous.from_at) || !iso(previous.to_at))
                    throw Error('Invalid saved period');
                const receipt = await (0, saved_return_plans_1.writeSavedPlan)(c, { tenantId, userId, courseId, enrollmentId: raw.enrollment_id, operationId: operationId, hash: requestHash, head, from: previous.from_at, to: previous.to_at, steps: [], status: 'withdrawn' });
                commitAttempted = true;
                await c.commit();
                return res.status(201).json({ operation: receipt });
            }
            const [studentRows] = await c.execute(STUDENT_SQL + (roster ? ' AND s.id>? ORDER BY s.id LIMIT 26' : ' AND s.id=? ORDER BY s.id LIMIT 2'), [tenantId, courseId, roster ? cursor : body.enrollment_id]);
            const students = studentRows;
            if (students.length > (roster ? 26 : 1) || students.some(s => !validStudent(s, tenantId)) || new Set(students.map(s => s.enrollment_id)).size !== students.length)
                return unavailable();
            if (roster) {
                const rows = students.slice(0, 25);
                return res.json({ students: rows.map(s => ({ enrollment_id: s.enrollment_id, name: s.name })), next_cursor: students.length > 25 ? rows[24].enrollment_id : null });
            }
            const student = students[0];
            if (!student || student.enrollment_id !== body.enrollment_id)
                return res.status(404).json({ error: 'Student not found' });
            const head = storageReady ? await (0, saved_return_plans_1.readPlanHead)(c, tenantId, courseId, student.enrollment_id) : null;
            const persistence = storageReady ? { status: 'ready', current: head } : { status: 'unavailable', current: null };
            if (saving && (head?.version ?? 0) !== raw.expected_version)
                return res.status(409).json({ code: 'RETURN_PLAN_VERSION_CHANGED' });
            const scope = { userId: student.user_id, enrollmentId: student.enrollment_id, tenantId };
            if (!await (0, student_lesson_access_1.verifyStudentEnrollment)(c, scope.userId, scope.enrollmentId, tenantId, true) || !await (0, student_lesson_access_1.resolveStudentCourse)(c, scope.enrollmentId, courseId, tenantId, true))
                return res.status(404).json({ error: 'Course enrollment unavailable' });
            if (!await schema(c))
                return unavailable();
            const [attendanceRows] = await c.execute(`SELECT ss.id AS session_id,ss.title,DATE_FORMAT(ss.starts_at,'%Y-%m-%dT%H:%i:%s.000Z') AS starts_at,a.id AS record_id,a.state
        FROM schedule_sessions ss LEFT JOIN attendance_records a ON a.session_id=ss.id AND a.tenant_id=ss.tenant_id AND a.student_id=?
        WHERE ss.tenant_id=? AND ss.group_id=? AND ss.audience='group' AND ss.status='scheduled' AND ss.ends_at<=UTC_TIMESTAMP() AND ss.starts_at>=? AND ss.starts_at<? ORDER BY ss.starts_at,ss.id LIMIT 101`, [scope.enrollmentId, tenantId, student.group_id, body.from.slice(0, 19).replace('T', ' '), body.to.slice(0, 19).replace('T', ' ')]);
            const attendance = attendanceRows.map(row => { if (!uuid(row.session_id) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200 || !iso(row.starts_at) || row.record_id === null && row.state !== null || row.record_id !== null && (!uuid(row.record_id) || !['present', 'absent', 'late', 'excused'].includes(row.state)))
                throw Error('Invalid attendance evidence'); return { session_id: row.session_id, title: row.title, starts_at: row.starts_at, state: row.state ?? 'unrecorded' }; });
            if (attendance.length > 100 || new Set(attendance.map(row => row.session_id)).size !== attendance.length)
                return unavailable();
            const [pathRows] = await c.execute(`SELECT l.id AS lesson_id,l.title,u.id AS unit_id,
        (l.release_at IS NULL OR UNIX_TIMESTAMP(l.release_at)<=UNIX_TIMESTAMP()) AS is_released,
        (l.prerequisite_lesson_id IS NULL OR EXISTS(SELECT 1 FROM course_lesson_completions p WHERE p.student_enrollment_id=? AND p.lesson_id=l.prerequisite_lesson_id)) AS prerequisite_met,
        EXISTS(SELECT 1 FROM course_lesson_completions p WHERE p.student_enrollment_id=? AND p.lesson_id=l.id) AS completed
        FROM course_units u INNER JOIN course_lessons l ON l.unit_id=u.id WHERE u.course_id=? AND u.status='active' AND l.status='active' ORDER BY u.display_order,u.id,l.display_order,l.id LIMIT 501`, [scope.enrollmentId, scope.enrollmentId, courseId]);
            const lessons = pathRows.map(row => { if (!uuid(row.lesson_id) || !uuid(row.unit_id) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 255)
                throw Error('Invalid catalog evidence'); const released = flag(row.is_released), prerequisite = flag(row.prerequisite_met), completed = flag(row.completed); return { lesson_id: row.lesson_id, title: row.title, completed, block: !released ? 'not_released' : !prerequisite ? 'prerequisite_incomplete' : null }; });
            if (lessons.length > 500 || new Set(lessons.map(l => l.lesson_id.toLowerCase())).size !== lessons.length)
                return unavailable();
            const steps = [];
            for (const step of body.steps) {
                const lesson = lessons.find(l => same(l.lesson_id, step.lesson_id));
                if (!lesson || lesson.completed || lesson.block)
                    return res.status(409).json({ code: 'RETURN_PLAN_STEP_CHANGED' });
                const proof = await (0, student_lesson_access_1.proveStudentLesson)(c, scope, courseId, step.lesson_id, true);
                if (!proof.ok)
                    return res.status(409).json({ code: 'RETURN_PLAN_STEP_CHANGED' });
                steps.push({ lesson_id: lesson.lesson_id, title: lesson.title, minutes: step.minutes });
            }
            const context = { course_id: courseId.toLowerCase(), enrollment_id: scope.enrollmentId, from: body.from, to: body.to };
            const token = steps.length ? (0, crypto_1.createHash)('sha256').update(JSON.stringify({ userId, tenantId, context, groupId: student.group_id, attendance, steps, persistence })).digest('hex') : null;
            if ((review || saving) && body.review_token !== token)
                return res.status(409).json({ code: 'RETURN_PLAN_REVIEW_CHANGED' });
            if (saving) {
                const receipt = await (0, saved_return_plans_1.writeSavedPlan)(c, { tenantId, userId, courseId, enrollmentId: student.enrollment_id, operationId: operationId, hash: requestHash, head, from: body.from, to: body.to, steps: body.steps, status: 'active' });
                commitAttempted = true;
                await c.commit();
                return res.status(201).json({ operation: receipt });
            }
            return res.json({ context, checked_at: new Date().toISOString(), student: { name: student.name }, attendance, lessons, steps, review_token: token, reviewed: review, delivery: 'not_sent', persistence });
        }
        catch (error) {
            discard = true;
            return res.status(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_CANT_OPEN_TABLE'].includes(error?.code) ? 503 : 500).json({ code: commitAttempted ? 'PERSISTENCE_UNCERTAIN' : 'RETURN_PLAN_UNAVAILABLE' });
        }
        finally {
            if (c) {
                if (started && !commitAttempted)
                    try {
                        await c.rollback();
                    }
                    catch {
                        discard = true;
                    }
                try {
                    if (discard)
                        c.destroy();
                    else
                        c.release();
                }
                catch { }
            }
        }
    };
    router.get(base + '/students', handle);
    router.get(base + '/operations/:operationId', handle);
    router.post(base + '/preview', handle);
    router.post(base + '/review', handle);
    router.post(base + '/save', handle);
    router.post(base + '/withdraw', handle);
    return router;
}
