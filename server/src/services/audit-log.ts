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
 *  - the chain total order is the monotonic `chain_seq` assigned by the
 *    sealed writer under a single-row head lock (audit_chain_head, SELECT ...
 *    FOR UPDATE), so the leaf read and the verification walk share one order
 *    even when two sealed rows land in the same TIMESTAMP second (id is a
 *    random UUID and must never decide chain order). Legacy rows sealed
 *    before the sequence existed keep chain_seq = 0 and stay ordered by
 *    (created_at, id) exactly as they were written.
 *  - the anchored head row (head_seq, head_entry_hash, head_row_id) is
 *    advanced on every append; verification compares it to the current leaf
 *    so deleting the newest rows (tail truncation) is detected.
 *  - legacy rows without entry_hash are reported as "unsealed" and do not
 *    break verification; the chain is defined over sealed rows.
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
    /**
     * Optional serialized-transaction seam. When present, the sealed append
     * runs inside it so the head-row lock is held across leaf resolution,
     * insert and head advance; without it the caller must already run the
     * append on one transactional connection.
     */
    transaction?: <T>(fn: (tx: AuditLogDataAccess) => Promise<T>) => Promise<T>;
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

/** Singleton row id of the anchored chain head (audit_chain_head). */
export const CHAIN_HEAD_ROW_ID = 'audit-chain-head';

export interface AuditChainHeadRow {
    head_seq: number | string | null;
    head_entry_hash: string | null;
    head_row_id: string | null;
}

const LOCKED_HEAD_SELECT =
    'SELECT head_seq, head_entry_hash, head_row_id FROM audit_chain_head WHERE id = ? FOR UPDATE';

const headSeqOf = (row: AuditChainHeadRow | undefined): number => {
    const parsed = Number(row?.head_seq ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/** Bootstrap sequence for the head seed derived from the current legacy leaf. */
const seedSeqOf = (leaf: { chain_seq: number | string | null } | undefined): number => {
    const parsed = Number(leaf?.chain_seq ?? 0);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

/**
 * MySQL's JSON column normalizes objects on store: keys are ordered by byte
 * length, then bytewise. The writer hashes the insertion-order string while
 * verification re-reads the normalized, already-parsed value, so both sides
 * must hash the same normalized form or an untouched chain fails.
 */
const compareMysqlJsonKeys = (a: string, b: string): number => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length - right.length || Buffer.compare(left, right);
};

const normalizeJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (value !== null && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort(compareMysqlJsonKeys)) {
            out[key] = normalizeJson(source[key]);
        }
        return out;
    }
    return value;
};

const canonicalizeJson = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let parsed: unknown = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return JSON.stringify(value);
        }
    }
    // A JSON null is stored and read back exactly like SQL NULL.
    if (parsed === null) return '';
    if (typeof parsed === 'object' || typeof parsed === 'boolean' || typeof parsed === 'number' || typeof parsed === 'string') {
        return JSON.stringify(normalizeJson(parsed));
    }
    return String(parsed);
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
 * The actual append: runs on one transactional connection. The single-row
 * head lock (SELECT ... FOR UPDATE) serializes transactional appenders, and
 * the head row itself pins the previous hash, so two writers can never read
 * the same leaf and fork the chain, and two sealed rows written in the same
 * second still get distinct, increasing chain_seq values.
 */
const MAX_SEQ_RESERVE_ATTEMPTS = 8;

const appendSealedAuditEvent = async (
    db: Pick<AuditLogDataAccess, 'query' | 'execute'>,
    input: SealedAuditRecordInput,
): Promise<void> => {
    const id = randomUUID();
    const oldValue = input.oldValue === undefined ? null : JSON.stringify(input.oldValue);
    const newValue = input.newValue === undefined ? null : JSON.stringify(input.newValue);
    const reason = input.reason ?? null;
    for (let attempt = 0; attempt < MAX_SEQ_RESERVE_ATTEMPTS; attempt += 1) {
        let headRows = await db.query<AuditChainHeadRow>(LOCKED_HEAD_SELECT, [CHAIN_HEAD_ROW_ID]);
        let head = headRows[0];
        if (!head) {
            // Legacy bootstrap: seed the anchored head from the current leaf
            // using the exact (chain_seq, created_at, id) order the
            // verification walk uses. Concurrent first appends compute
            // identical seed values from the same immutable legacy leaf; the
            // ON-DUPLICATE no-op makes the losing INSERT harmless and the
            // loser re-locks onto the winner's row.
            const leafRows = await db.query<{ id: string; entry_hash: string; chain_seq: number | string | null }>(
                `SELECT id, entry_hash, chain_seq FROM audit_events
                 WHERE entry_hash IS NOT NULL
                 ORDER BY chain_seq DESC, created_at DESC, id DESC
                 LIMIT 1`,
            );
            const leaf = leafRows[0];
            const seedSeq = seedSeqOf(leaf);
            await db.execute(
                `INSERT INTO audit_chain_head (id, head_seq, head_entry_hash, head_row_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE head_seq = audit_chain_head.head_seq`,
                [CHAIN_HEAD_ROW_ID, seedSeq, leaf?.entry_hash ?? null, leaf?.id ?? null],
            );
            headRows = await db.query<AuditChainHeadRow>(LOCKED_HEAD_SELECT, [CHAIN_HEAD_ROW_ID]);
            head = headRows[0];
            if (!head) throw new Error('The anchored audit chain head is unavailable');
        }
        const headSeq = headSeqOf(head);
        const prevHash = head.head_entry_hash ?? null;
        const nextSeq = headSeq + 1;
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
        // Reserve the next sequence atomically: the optimistic CAS on the
        // head row keeps non-transactional callers (each statement releases
        // the FOR UPDATE lock) from forking the chain; a lost race re-reads
        // the advanced head and retries.
        const reserved = await db.execute(
            `UPDATE audit_chain_head
             SET head_seq = ?, head_entry_hash = ?, head_row_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND head_seq = ?`,
            [nextSeq, entryHash, id, CHAIN_HEAD_ROW_ID, headSeq],
        );
        if ((reserved.affectedRows ?? 0) === 0) continue;
        try {
            await db.execute(
                `INSERT INTO audit_events
                 (id, actor_user_id, tenant_id, action, resource_type, resource_id,
                  old_value, new_value, reason, entry_hash, prev_entry_hash, chain_seq)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                    nextSeq,
                ],
            );
        } catch (error) {
            // Best-effort compensated rollback of the reservation so the head
            // never anchors a row that was never inserted; inside a real
            // transaction the caller's rollback undoes both statements.
            try {
                await db.execute(
                    `UPDATE audit_chain_head
                     SET head_seq = ?, head_entry_hash = ?, head_row_id = ?
                     WHERE id = ? AND head_seq = ?`,
                    [headSeq, prevHash, head.head_row_id ?? null, CHAIN_HEAD_ROW_ID, nextSeq],
                );
            } catch {
                /* the head-restore is advisory; the row INSERT failure is rethrown */
            }
            throw error;
        }
        return;
    }
    throw new Error('The audit chain head is contended; append abandoned');
};

/**
 * Append a sealed audit event linked to the anchored head. When the data
 * access exposes a transaction seam the append runs inside it (head lock held
 * across read + insert + head advance); otherwise the caller must already be
 * running on a single transactional connection.
 */
export const recordSealedAuditEvent = async (
    db: AuditLogDataAccess,
    input: SealedAuditRecordInput,
): Promise<void> => {
    if (db.transaction) {
        await db.transaction((tx) => appendSealedAuditEvent(tx, input));
        return;
    }
    await appendSealedAuditEvent(db, input);
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
    chain_seq: number | string | null;
}

export interface ChainFailure {
    rowIndex: number;
    rowId: string;
    code: 'payload-hash-mismatch' | 'chain-link-mismatch' | 'chain-sequence-gap' | 'head-anchor-mismatch';
    expected: string | null;
    actual: string | null;
}

export interface ChainHeadAnchor {
    headSeq: number;
    headEntryHash: string | null;
    leafSeq: number | null;
    leafEntryHash: string | null;
    ok: boolean;
}

export interface ChainVerification {
    ok: boolean;
    checked: number;
    unsealed: number;
    firstFailure: ChainFailure | null;
    /** True when sealed rows beyond the scan cap were not walked. */
    truncated: boolean;
    /** Null when no anchored head row exists (legacy chain; truncation undetectable). */
    headAnchor: ChainHeadAnchor | null;
}

export const MAX_CHAIN_VERIFY_ROWS = 20000;

/**
 * Walk the sealed chain in the shared (chain_seq, created_at, id) total order
 * — the same order the append leaf read uses — re-computing every hash plus
 * the link between consecutive sealed rows, and finally compare the anchored
 * head row to the current leaf so deleting the newest rows (tail truncation)
 * is detected. Bounded by MAX_CHAIN_VERIFY_ROWS so a runaway database cannot
 * hang the endpoint.
 */
export const verifyAuditChain = async (
    db: Pick<AuditLogDataAccess, 'query'>,
    options: { limit?: number } = {},
): Promise<ChainVerification> => {
    const requested = options.limit ?? MAX_CHAIN_VERIFY_ROWS;
    const limit = Number.isInteger(requested) && requested > 0 && requested <= MAX_CHAIN_VERIFY_ROWS
        ? requested
        : MAX_CHAIN_VERIFY_ROWS;
    const fetched = await db.query<AuditChainRow>(
        `SELECT id, actor_user_id, tenant_id, action, resource_type, resource_id,
                old_value, new_value, reason, entry_hash, prev_entry_hash, chain_seq
         FROM audit_events
         WHERE entry_hash IS NOT NULL
         ORDER BY chain_seq ASC, created_at ASC, id ASC
         LIMIT ${limit + 1}`,
    );
    const truncated = fetched.length > limit;
    const rows = truncated ? fetched.slice(0, limit) : fetched;
    const unsealedRows = await db.query<{ unsealed: number }>(
        'SELECT COUNT(*) AS unsealed FROM audit_events WHERE entry_hash IS NULL',
    );
    const unsealed = Number(unsealedRows[0]?.unsealed ?? 0);
    const asSeq = (value: number | string | null | undefined): number | null => {
        const parsed = Number(value ?? 0);
        return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
    };
    const readAnchorPair = async () => {
        const headRows = await db.query<AuditChainHeadRow>(
            'SELECT head_seq, head_entry_hash, head_row_id FROM audit_chain_head WHERE id = ?',
            [CHAIN_HEAD_ROW_ID],
        );
        const leafRows = await db.query<{ id: string; entry_hash: string; chain_seq: number | string | null }>(
            `SELECT id, entry_hash, chain_seq FROM audit_events
             WHERE entry_hash IS NOT NULL
             ORDER BY chain_seq DESC, created_at DESC, id DESC
             LIMIT 1`,
        );
        const pairHead = headRows[0] ?? null;
        const pairLeaf = leafRows[0] ?? null;
        const consistent = pairHead
            ? (pairLeaf
                ? asSeq(pairLeaf.chain_seq) === headSeqOf(pairHead) && (pairLeaf.entry_hash ?? null) === (pairHead.head_entry_hash ?? null)
                : headSeqOf(pairHead) === 0 && (pairHead.head_entry_hash ?? null) === null)
            : true;
        return { head: pairHead, leaf: pairLeaf, consistent };
    };
    // The head and the leaf are two separate reads; a sealed append landing
    // between them is a transient disagreement, not tampering. Only a
    // mismatch that survives re-reading is reported.
    let anchorPair = await readAnchorPair();
    for (let retry = 0; retry < 2 && !anchorPair.consistent; retry += 1) {
        anchorPair = await readAnchorPair();
    }
    const { head, leaf } = anchorPair;
    let previousHash: string | null = null;
    let previousSeq: number | null = null;
    let walkFailure: ChainFailure | null = null;
    for (let index = 0; index < rows.length && walkFailure === null; index += 1) {
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
            walkFailure = {
                rowIndex: index,
                rowId: String(row.id),
                code: 'payload-hash-mismatch',
                expected: recomputed,
                actual: storedHash,
            };
            break;
        }
        // The first sealed row stores a null predecessor and folds the genesis
        // seed into its own payload hash; only subsequent rows link to the
        // previous sealed hash. Comparing against the stored convention (null
        // for genesis) is what lets a deleted/rewritten head be detected.
        const expectedPrev = previousHash;
        const storedPrev = row.prev_entry_hash ?? null;
        if (storedPrev !== expectedPrev) {
            walkFailure = {
                rowIndex: index,
                rowId: String(row.id),
                code: 'chain-link-mismatch',
                expected: expectedPrev,
                actual: storedPrev,
            };
            break;
        }
        // Rows appended after the sequence existed must carry a strictly
        // increasing chain_seq; a hole means a sealed row was removed from
        // the middle of the chain. Legacy rows (seq 0) predate the sequence.
        const seq = asSeq(row.chain_seq);
        if (seq !== null && seq > 0) {
            if (previousSeq !== null && seq !== previousSeq + 1) {
                walkFailure = {
                    rowIndex: index,
                    rowId: String(row.id),
                    code: 'chain-sequence-gap',
                    expected: String(previousSeq + 1),
                    actual: String(seq),
                };
                break;
            }
            previousSeq = seq;
        }
        previousHash = storedHash;
    }
    let headAnchor: ChainHeadAnchor | null = null;
    let anchorFailure: ChainFailure | null = null;
    if (head) {
        const headSeq = headSeqOf(head);
        const headHash = head.head_entry_hash ?? null;
        const leafSeq = leaf ? asSeq(leaf.chain_seq) : null;
        const leafHash = leaf?.entry_hash ?? null;
        const anchorOk = leaf
            ? leafSeq === headSeq && leafHash === headHash
            : headSeq === 0 && headHash === null;
        headAnchor = {
            headSeq,
            headEntryHash: headHash,
            leafSeq,
            leafEntryHash: leafHash ?? null,
            ok: anchorOk,
        };
        if (!anchorOk) {
            anchorFailure = {
                // Not a per-row defect: the anchored head and the live leaf
                // disagree, i.e. the sealed tail was truncated or rewritten.
                rowIndex: -1,
                rowId: String(head.head_row_id ?? CHAIN_HEAD_ROW_ID),
                code: 'head-anchor-mismatch',
                expected: headHash,
                actual: leafHash ?? null,
            };
        }
    }
    const firstFailure = walkFailure ?? anchorFailure;
    return { ok: firstFailure === null, checked: rows.length, unsealed, firstFailure, truncated, headAnchor };
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
): Promise<{ csv: string; rowCount: number; truncated: boolean }> => {
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
    return { csv: toAuditCsv(rows), rowCount: rows.length, truncated: rows.length >= MAX_EXPORT_ROWS };
};
