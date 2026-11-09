"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GradingAuthorityDenied = void 0;
exports.proveGradingIdentity = proveGradingIdentity;
exports.proveGradingCourse = proveGradingCourse;
exports.proveGradingAttempt = proveGradingAttempt;
const suspension_predicate_1 = require("../security/suspension-predicate");
class GradingAuthorityDenied extends Error {
    constructor(status = 403) {
        super('GRADING_TEACHER_REQUIRED');
        this.status = status;
    }
}
exports.GradingAuthorityDenied = GradingAuthorityDenied;
/** Membership makes a workspace usable. It never grants responsibility for its courses. */
async function proveGradingIdentity(db, actor, lock = true) {
    if (!actor.tenantId || !['teacher', 'instructor'].includes(actor.role) || actor.identitySource === 'staff' || actor.billingOnly)
        throw new GradingAuthorityDenied();
    const rows = await db.query(`SELECT u.id AS grading_user_id FROM users u JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.role_key IN ('owner','instructor') JOIN tenants t ON t.id=m.tenant_id AND t.status='active' WHERE u.id=? AND u.role IN ('teacher','instructor') AND u.center_account=0 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=u.id) AND u.is_active=1 AND u.token_version=? AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')} LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [actor.tenantId, actor.id, actor.tokenVersion ?? 0]);
    if (rows.length !== 1 || rows[0].grading_user_id !== actor.id)
        throw new GradingAuthorityDenied();
    return actor.tenantId;
}
async function proveGradingCourse(db, actor, courseId) {
    const rows = await db.query('SELECT c.id AS grading_course_id FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.instructor_id=? AND c.is_active=1 LIMIT 1 FOR UPDATE', [courseId, actor.tenantId, actor.id]);
    if (rows.length !== 1)
        throw new GradingAuthorityDenied(404);
}
async function proveGradingAttempt(db, actor, attemptId) {
    const rows = await db.query('SELECT c.id AS grading_course_id FROM exam_versioned_attempts a JOIN exams e ON e.id=a.exam_id JOIN courses c ON c.id=e.course_id AND c.tenant_id=a.tenant_id WHERE a.id=? AND a.tenant_id=? AND c.instructor_id=? AND c.is_active=1 LIMIT 1 FOR UPDATE', [attemptId, actor.tenantId, actor.id]);
    if (rows.length !== 1)
        throw new GradingAuthorityDenied(404);
}
