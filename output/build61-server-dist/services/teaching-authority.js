"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeachingAuthorityDenied = void 0;
exports.proveTeachingIdentity = proveTeachingIdentity;
exports.proveTeachingCourse = proveTeachingCourse;
const suspension_predicate_1 = require("../security/suspension-predicate");
class TeachingAuthorityDenied extends Error {
    constructor(status = 403) {
        super('COURSE_TEACHER_REQUIRED');
        this.status = status;
    }
}
exports.TeachingAuthorityDenied = TeachingAuthorityDenied;
/** A workspace selector/ownership alone never grants academic responsibility. */
async function proveTeachingIdentity(c, req) {
    const actor = req.user;
    if (!actor || !actor.tenantId || !['teacher', 'instructor'].includes(actor.role)
        || actor.identitySource === 'staff' || actor.billingOnly || req.impersonation
        || req.headers['x-impersonation'] !== undefined)
        throw new TeachingAuthorityDenied();
    const [rows] = await c.execute(`SELECT u.id AS teaching_user_id FROM users u
    JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.role_key IN ('owner','instructor')
    JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
    WHERE u.id=? AND u.role IN ('teacher','instructor') AND u.center_account=0
    AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=u.id)
    AND u.is_active=1 AND u.token_version=? AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')}
    LIMIT 1 FOR UPDATE`, [actor.tenantId, actor.id, actor.tokenVersion ?? 0]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].teaching_user_id !== actor.id)
        throw new TeachingAuthorityDenied();
}
async function proveTeachingCourse(c, req, courseId) {
    const [rows] = await c.execute(`SELECT c.id AS teaching_course_id FROM courses c
    WHERE c.id=? AND c.tenant_id=? AND c.instructor_id=? AND c.is_active=1 LIMIT 1 FOR UPDATE`, [courseId, req.user.tenantId, req.user.id]);
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].teaching_course_id !== 'string'
        || rows[0].teaching_course_id.toLowerCase() !== courseId.toLowerCase())
        throw new TeachingAuthorityDenied(404);
}
