import { randomUUID } from 'node:crypto';
export interface BranchAuditInput { tenantId: string | null; branchId: string | null; actorUserId: string; action: string; resourceType?: string | null; resourceId?: string | null; detail?: unknown }
export interface BranchWriteTx { execute(sql: string, params: unknown[]): Promise<{ affectedRows?: number; insertId?: number }> }
/** The transaction owner must roll back mutation and audit together, including on commit failure. */
export function createAuditedBranchWriter(deps: { transaction<T>(work: (tx: BranchWriteTx) => Promise<T>): Promise<T> }) {
  return (sql: string, params: unknown[], input: BranchAuditInput) => deps.transaction(async tx => {
    const result = await tx.execute(sql, params);
    if (!Number.isSafeInteger(result.affectedRows) || result.affectedRows! < 0) throw Error('Branch mutation outcome unavailable');
    if (result.affectedRows === 0) return result;
    const audit = await tx.execute(`INSERT INTO branch_audit_log
      (id,tenant_id,branch_id,actor_user_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?,?,?,?)`,
    [randomUUID(), input.tenantId, input.branchId, input.actorUserId, input.action, input.resourceType ?? null, input.resourceId ?? null, input.detail === undefined ? null : JSON.stringify(input.detail)]);
    if (audit.affectedRows !== 1) throw Error('Branch audit was not confirmed');
    return result;
  });
}
