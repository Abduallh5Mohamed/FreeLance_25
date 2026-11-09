"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAudit = recordAudit;
exports.snapshotRow = snapshotRow;
const crypto_1 = require("crypto");
/**
 * Append-only mutation audit. Captures actor, tenant and before/after so every
 * protected write (create/update/archive/revoke) is reconstructable. The insert
 * is best-effort relative to the business transaction: callers decide whether a
 * failed audit should abort the mutation, but the audit row itself is never
 * suppressed for "successful" writes.
 */
async function recordAudit(execute, input) {
    await execute(`INSERT INTO audit_events
         (id, actor_user_id, tenant_id, action, resource_type, resource_id, old_value, new_value, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        (0, crypto_1.randomUUID)(),
        input.actorUserId,
        input.tenantId,
        input.action,
        input.resourceType,
        input.resourceId,
        input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
        input.newValue === undefined ? null : JSON.stringify(input.newValue),
        input.reason ?? null,
    ]);
}
/** Normalize a row into a JSON-safe object, dropping undefined/function noise. */
function snapshotRow(row) {
    if (row === null || row === undefined)
        return row;
    if (typeof row !== 'object')
        return row;
    return JSON.parse(JSON.stringify(row));
}
