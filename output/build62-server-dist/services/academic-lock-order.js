"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lockAcademicTenant = lockAcademicTenant;
/** Existing academic proofs lock tenant AND users. Always acquire the common
 * tenant row first, before actor or responsible-teacher rows, to avoid cycles
 * between a teacher read and a delegated grader in the same tenant.
 * This is transaction-local ordering, not an authority grant or global cache.
 */
async function lockAcademicTenant(db, tenantId) {
    const rows = await db.query("SELECT id AS academic_tenant_id FROM tenants WHERE id=? AND status='active' LIMIT 1 FOR UPDATE", [tenantId]);
    return Array.isArray(rows) && rows.length === 1 && rows[0].academic_tenant_id === tenantId;
}
