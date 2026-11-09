/** Existing academic proofs lock tenant AND users. Always acquire the common
 * tenant row first, before actor or responsible-teacher rows, to avoid cycles
 * between a teacher read and a delegated grader in the same tenant.
 * This is transaction-local ordering, not an authority grant or global cache.
 */
export async function lockAcademicTenant(db: { query(sql: string, params?: any[]): Promise<any[]> }, tenantId: string): Promise<boolean> {
  const rows = await db.query("SELECT id AS academic_tenant_id FROM tenants WHERE id=? AND status='active' LIMIT 1 FOR UPDATE", [tenantId]);
  return Array.isArray(rows) && rows.length === 1 && rows[0].academic_tenant_id === tenantId;
}
