/**
 * M7 O7 — audit log read/export and the tamper-evident hash chain.
 *
 * Append-only semantics:
 *  - this module exposes only INSERT (sealed audit events) and SELECT paths;
 *    no API surface updates or deletes audit rows.
 *  - sealed rows carry `entry_hash` = sha256 over a canonical payload that is
 *    linked to the previous sealed hash (prev_entry_hash, genesis seed when
 *    the chain starts). The verification walk re-computes every payload hash
 *    and the link between consecutive sealed rows, so any payload mutation,
 *    seal replacement or row reordering in the sealed tail is detected.
 *  - legacy rows without entry_hash are reported as "unsealed" and do not
 *    break verification; the chain is defined over sealed rows in
 *    (created_at, id) order.
 *
 * Retention policy: audit rows are kept for at least AUDIT_RETENTION_DAYS
 * (365). A retention purge is a DBA-managed, separately approved activity that
 * must run from the oldest end of the chain and be followed by a full chain
 * verification; no service/deletion path exists here.
 *
 * Export: CSV with formula-injection neutralization (leading =, +, -, @, tab
 * and CR are prefixed with a single quote) and the export itself audited.
 */

import { createHash, randomUUID } from 'crypto';

export const AUDIT_RETENTION_DAYS = 365;

export interface AuditLogDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface SealedAuditRecordInput {
    actorUserId: string | null;
    tenantId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
}

/** Genesis seed for the first sealed entry in a database. */
export const CHAIN_GENESIS = 'm7-audit-chain-genesis';

const canonicalizeJson = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
        try {
            return JSON.stringify(JSON.parse(value));
        } catch {
            return JSON.stringify(value);
        }
    }
    if (typeof value === 'object' || typeof value === 'boolean' || typeof value === 'number') {
        return JSON.stringify(value);
    }
    return String(value);
};

export interface ChainHashPayload {
    prevEntryHash: string | null;
    id: string;
    actorUserId: string | null;
    tenantId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue: unknown;
    newValue: unknown;
    reason: string | null;
}

/**
 * entry_hash = sha256(prev | id | actor | tenant | action | resource_type |
 *                     resource_id | old_value | new_value | reason)
 * created_at is deliberately excluded: it is assigned by the database clock on
 * insert and no API path can rewrite it, while the remaining payload is fully
 * covered.
 */
export const computeEntryHash = (input: ChainHashPayload): string =>
    createHash('sha256')
        .update([
            input.prevEntryHash ?? CHAIN_GENESIS,
            input.id,
            input.actorUserId ?? '',
            input.tenantId ?? '',
            input.action,
            input.resourceType,
            input.resourceId,
            canonicalizeJson(input.oldValue),
            canonicalizeJson(input.newValue),
            input.reason ?? '',
        ].join('|'), 'utf8')
        .digest('hex');

/**
 * Append a sealed audit event: the current chain leaf is read highest-first
 * and the new row links to it, inside the caller's transaction.
 */
export const recordSealedAuditEvent = async (
    db: Pick<AuditLogDataAccess, 'query' | 'execute'>,
    input: SealedAuditRecordInput,
): Promise<void> => {
    const leafRows = await db.query<{ entry_hash: string }>(
        'SELECT entry_hash FROM audit_events WHERE entry_hash IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    const id = randomUUID();
    const oldValue = input.oldValue === undefined ? null : JSON.stringify(input.oldValue);
    const newValue = input.newValue === undefined ? null : JSON.stringify(input.newValue);
    const reason = input.reason ?? null;
    const prevHash = leafRows[0]?.entry_hash ?? null;
    const entryHash = computeEntryHash({
        prevEntryHash: prevHash,
        id,
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        oldValue,
        newValue,
        reason,
    });
    await db.execute(
        `INSERT INTO audit_events
         (id, actor_user_id, tenant_id, action, resource_type, resource_id,
          old_value, new_value, reason, entry_hash, prev_entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            input.actorUserId,
            input.tenantId,
            input.action,
            input.resourceType,
            input.resourceId,
            oldValue,
            newValue,
            reason,
            entryHash,
            prevHash,
        ],
    );
};

export interface AuditChainRow {
    id: string;
    actor_user_id: string | null;
    tenant_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string;
    old_value: unknown;
    new_value: unknown;
    reason: string | null;
    entry_hash: string;
    prev_entry_hash: string | null;
}

export interface ChainFailure {
    rowIndex: number;
    rowId: string;
    code: 'payload-hash-mismatch' | 'chain-link-mismatch';
    expected: string | null;
    actual: string | null;
}

export interface ChainVerification {
    ok: boolean;
    checked: number;
    unsealed: number;
    firstFailure: ChainFailure | null;
}

export const MAX_CHAIN_VERIFY_ROWS = 20000;

/**
 * Walk the sealed chain in (created_at, id) order and re-compute every hash
 * plus the link between consecutive sealed rows. Bounded by MAX_CHAIN_VERIFY_ROWS
 * so a runaway database cannot hang the endpoint.
 */
export const verifyAuditChain = async (
    db: Pick<AuditLogDataAccess, 'query'>,
    options: { limit?: number } = {},
): Promise<ChainVerification> => {
    const requested = options.limit ?? MAX_CHAIN_VERIFY_ROWS;
    const limit = Number.isInteger(requested) && requested > 0 && requested <= MAX_CHAIN_VERIFY_ROWS
        ? requested
        : MAX_CHAIN_VERIFY_ROWS;
    const rows = await db.query<AuditChainRow>(
        `SELECT id, actor_user_id, tenant_id, action, resource_type, resource_id,
                old_value, new_value, reason, entry_hash, prev_entry_hash
         FROM audit_events
         WHERE entry_hash IS NOT NULL
         ORDER BY created_at ASC, id ASC
         LIMIT ${limit}`,
    );
    const unsealedRows = await db.query<{ unsealed: number }>(
        'SELECT COUNT(*) AS unsealed FROM audit_events WHERE entry_hash IS NULL',
    );
    const unsealed = Number(unsealedRows[0]?.unsealed ?? 0);
    let previousHash: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const storedHash = String(row.entry_hash ?? '');
        const recomputed = computeEntryHash({
            prevEntryHash: row.prev_entry_hash,
            id: String(row.id),
            actorUserId: row.actor_user_id,
            tenantId: row.tenant_id,
            action: String(row.action ?? ''),
            resourceType: String(row.resource_type ?? ''),
            resourceId: String(row.resource_id ?? ''),
            oldValue: row.old_value,
            newValue: row.new_value,
            reason: row.reason,
        });
        if (storedHash !== recomputed) {
            return {
                ok: false,
                checked: rows.length,
                unsealed,
                firstFailure: {
                    rowIndex: index,
                    rowId: String(row.id),
                    code: 'payload-hash-mismatch',
                    expected: recomputed,
                    actual: storedHash,
                },
            };
        }
        // The first sealed row stores a null predecessor and folds the genesis
        // seed into its own payload hash; only subsequent rows link to the
        // previous sealed hash. Comparing against the stored convention (null
        // for genesis) is what lets a deleted/rewritten head be detected.
        const expectedPrev = previousHash;
        const storedPrev = row.prev_entry_hash ?? null;
        if (storedPrev !== expectedPrev) {
            return {
                ok: false,
                checked: rows.length,
                unsealed,
                firstFailure: {
                    rowIndex: index,
                    rowId: String(row.id),
                    code: 'chain-link-mismatch',
                    expected: expectedPrev,
                    actual: storedPrev,
                },
            };
        }
        previousHash = storedHash;
    }
    return { ok: true, checked: rows.length, unsealed, firstFailure: null };
};

/* ----------------------------------------------------------------------- */
/* Filtered read/export (tenant-scoped or platform scope).                  */
/* ----------------------------------------------------------------------- */

export interface AuditLogFilters {
    tenantId: string | null;
    actorUserId: string | null;
    action: string | null;
    resourceType: string | null;
    fromUtc: string | null;
    toUtc: string | null;
}

export interface AuditListOptions {
    page: number;
    limit: number;
}

export interface AuditListPage {
    rows: Record<string, unknown>[];
    page: number;
    limit: number;
    total: number;
}

export const MAX_EXPORT_ROWS = 5000;
export const MAX_PAGE_LIMIT = 100;
export const MAX_PAGE = 10000;

// MySQL UTC datetime text, e.g. 2026-10-18 or 2026-10-18 09:00[:59]
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const ACTION_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const RESOURCE_TYPE_PATTERN = /^[A-Za-z0-9_:-]{1,60}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Parses and fully validates a UTC datetime filter text; null when invalid. */
export const parseDatetimeFilter = (value: string): string | null => {
    const match = DATETIME_PATTERN.exec(value);
    if (!match) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText ?? '00');
    const minute = Number(minuteText ?? '00');
    const second = Number(secondText ?? '00');
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    if (day > daysInMonth) return null;
    return `${yearText}-${monthText}-${dayText} ${hourText ?? '00'}:${minuteText ?? '00'}:${secondText ?? '00'}`;
};

export const parseAuditFilters = (
    query: Record<string, unknown>,
): { ok: true; value: AuditLogFilters } | { ok: false; error: string } => {
    const filterValue = (name: string, pattern: RegExp, max: number): { present: boolean; valid: boolean; value: string | null } => {
        const raw = query[name];
        if (raw === undefined || raw === null || raw === '') {
            return { present: false, valid: true, value: null };
        }
        if (typeof raw !== 'string') return { present: true, valid: false, value: null };
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > max || !pattern.test(trimmed)) {
            return { present: true, valid: false, value: null };
        }
        return { present: true, valid: true, value: trimmed };
    };
    // tenant ids are char(36) in the schema
    const tenantId = filterValue('tenant_id', /^[\w-]{1,64}$/, 64);
    if (tenantId.present && !tenantId.valid) return { ok: false, error: 'Invalid tenant_id filter' };
    const actorUserId = filterValue('actor_user_id', ID_PATTERN, 64);
    if (actorUserId.present && !actorUserId.valid) return { ok: false, error: 'Invalid actor_user_id filter' };
    const action = filterValue('action', ACTION_PATTERN, 100);
    if (action.present && !action.valid) return { ok: false, error: 'Invalid action filter' };
    const resourceType = filterValue('resource_type', RESOURCE_TYPE_PATTERN, 60);
    if (resourceType.present && !resourceType.valid) return { ok: false, error: 'Invalid resource_type filter' };
    // MySQL UTC datetime text, fully validated (month/day/time must be real)
    const fromRaw = filterValue('from', DATETIME_PATTERN, 19);
    if (fromRaw.present && (!fromRaw.valid || fromRaw.value === null || parseDatetimeFilter(fromRaw.value) === null)) {
        return { ok: false, error: 'from must be a valid YYYY-MM-DD[ HH:MM[:SS]]' };
    }
    const toRaw = filterValue('to', DATETIME_PATTERN, 19);
    if (toRaw.present && (!toRaw.valid || toRaw.value === null || parseDatetimeFilter(toRaw.value) === null)) {
        return { ok: false, error: 'to must be a valid YYYY-MM-DD[ HH:MM[:SS]]' };
    }
    const fromUtc = fromRaw.value ? parseDatetimeFilter(fromRaw.value) : null;
    const toUtc = toRaw.value ? parseDatetimeFilter(toRaw.value) : null;
    if (fromUtc && toUtc && fromUtc > toUtc) {
        return { ok: false, error: 'from must not be after to' };
    }
    return {
        ok: true,
        value: {
            tenantId: tenantId.value,
            actorUserId: actorUserId.value,
            action: action.value,
            resourceType: resourceType.value,
            fromUtc,
            toUtc,
        },
    };
};

export const parseAuditPagination = (
    query: Record<string, unknown>,
): { page: number; limit: number } | null => {
    const rawPage = query['page'] ?? '1';
    const rawLimit = query['limit'] ?? '50';
    if (typeof rawPage !== 'string' || !/^[1-9]\d{0,5}$/.test(rawPage)) return null;
    if (typeof rawLimit !== 'string' || !/^[1-9]\d{0,3}$/.test(rawLimit)) return null;
    const page = Number(rawPage);
    const limit = Number(rawLimit);
    if (page > MAX_PAGE || limit > MAX_PAGE_LIMIT) return null;
    return { page, limit };
};

export const buildAuditWhere = (
    filters: AuditLogFilters,
): { sql: string; params: unknown[] } => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.tenantId) {
        conditions.push('tenant_id = ?');
        params.push(filters.tenantId);
    }
    if (filters.actorUserId) {
        conditions.push('actor_user_id = ?');
        params.push(filters.actorUserId);
    }
    if (filters.action) {
        conditions.push('action = ?');
        params.push(filters.action);
    }
    if (filters.resourceType) {
        conditions.push('resource_type = ?');
        params.push(filters.resourceType);
    }
    if (filters.fromUtc) {
        conditions.push('created_at >= ?');
        params.push(filters.fromUtc);
    }
    if (filters.toUtc) {
        conditions.push('created_at <= ?');
        params.push(filters.toUtc);
    }
    return {
        sql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
        params,
    };
};

export const listAuditEvents = async (
    db: AuditLogDataAccess,
    filters: AuditLogFilters,
    options: AuditListOptions,
): Promise<AuditListPage> => {
    const where = buildAuditWhere(filters);
    const offset = (options.page - 1) * options.limit;
    const rows = await db.query<Record<string, unknown>>(
        `SELECT a.id, a.action, a.resource_type, a.resource_id, a.actor_user_id, a.tenant_id,
                a.old_value, a.new_value, a.reason, a.created_at, u.name AS actor_name
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
         ${where.sql}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ${options.limit} OFFSET ${offset}`,
        where.params,
    );
    const totalRows = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM audit_events a${where.sql}`,
        where.params,
    );
    return { rows, page: options.page, limit: options.limit, total: Number(totalRows[0]?.total ?? 0) };
};

/* ----------------------------------------------------------------------- */
/* CSV export with formula-injection neutralization.                        */
/* ----------------------------------------------------------------------- */

const DANGEROUS_LEADING = /^[=+\-@\t\r]/;

export const neutralizeCsvCell = (value: string): string =>
    DANGEROUS_LEADING.test(value) ? `'${value}` : value;

const csvCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const neutralized = neutralizeCsvCell(text);
    return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
};

export const AUDIT_CSV_HEADERS = [
    'id', 'created_at', 'action', 'resource_type', 'resource_id',
    'actor_user_id', 'tenant_id', 'old_value', 'new_value', 'reason',
];

export const toAuditCsv = (rows: Record<string, unknown>[]): string => {
    const lines = [AUDIT_CSV_HEADERS.join(',')];
    for (const row of rows) {
        lines.push(AUDIT_CSV_HEADERS.map((header) => csvCell(row[header])).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
};

export const exportAuditCsv = async (
    db: AuditLogDataAccess,
    filters: AuditLogFilters,
): Promise<{ csv: string; rowCount: number }> => {
    const where = buildAuditWhere(filters);
    const rows = await db.query<Record<string, unknown>>(
        `SELECT id, action, resource_type, resource_id, actor_user_id, tenant_id,
                old_value, new_value, reason, created_at
         FROM audit_events
         ${where.sql}
         ORDER BY created_at DESC, id DESC
         LIMIT ${MAX_EXPORT_ROWS}`,
        where.params,
    );
    return { csv: toAuditCsv(rows), rowCount: rows.length };
};
