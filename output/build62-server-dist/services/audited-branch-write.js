"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuditedBranchWriter = createAuditedBranchWriter;
const node_crypto_1 = require("node:crypto");
/** The transaction owner must roll back mutation and audit together, including on commit failure. */
function createAuditedBranchWriter(deps) {
    return (sql, params, input) => deps.transaction(async (tx) => {
        const result = await tx.execute(sql, params);
        if (!Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0)
            throw Error('Branch mutation outcome unavailable');
        if (result.affectedRows === 0)
            return result;
        const audit = await tx.execute(`INSERT INTO branch_audit_log
      (id,tenant_id,branch_id,actor_user_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?,?,?,?)`, [(0, node_crypto_1.randomUUID)(), input.tenantId, input.branchId, input.actorUserId, input.action, input.resourceType ?? null, input.resourceId ?? null, input.detail === undefined ? null : JSON.stringify(input.detail)]);
        if (audit.affectedRows !== 1)
            throw Error('Branch audit was not confirmed');
        return result;
    });
}
