import { randomUUID } from 'crypto';

/** Minimal contract satisfied by the route-level `execute` injection. */
export interface AuditExecutor {
    (sql: string, params?: unknown[]): Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface AuditRecordInput {
    actorUserId: string | null;
    tenantId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
}

/**
 * Append-only mutation audit. Captures actor, tenant and before/after so every
 * protected write (create/update/archive/revoke) is reconstructable. The insert
 * is best-effort relative to the business transaction: callers decide whether a
 * failed audit should abort the mutation, but the audit row itself is never
 * suppressed for "successful" writes.
 */
export async function recordAudit(execute: AuditExecutor, input: AuditRecordInput): Promise<void> {
    await execute(
        `INSERT INTO audit_events
         (id, actor_user_id, tenant_id, action, resource_type, resource_id, old_value, new_value, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            randomUUID(),
            input.actorUserId,
            input.tenantId,
            input.action,
            input.resourceType,
            input.resourceId,
            input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
            input.newValue === undefined ? null : JSON.stringify(input.newValue),
            input.reason ?? null,
        ],
    );
}

/** Normalize a row into a JSON-safe object, dropping undefined/function noise. */
export function snapshotRow(row: unknown): unknown {
    if (row === null || row === undefined) return row;
    if (typeof row !== 'object') return row;
    return JSON.parse(JSON.stringify(row));
}
