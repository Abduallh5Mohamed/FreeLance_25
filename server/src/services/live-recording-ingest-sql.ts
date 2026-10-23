/**
 * WL-P3 — durable `RecordingIngestStore` over injected, connection-bound SQL.
 *
 * Implements the port in `live-recording-ingest.ts` against
 * `live_recording_ingests` of migration `20261022_06_live_sessions_recordings.sql`
 * (read-only ground truth, sha256 391d0230…, no DDL here, no invented column).
 *
 * SOURCE ONLY. No pool is imported, no connection is opened, no statement runs
 * at import time and there is no top-level side effect. The caller injects an
 * executor whose `transaction` hands back ONE connection; every statement of a
 * unit is issued on that connection. A missing executor or a missing sealed
 * audit writer throws AT CONSTRUCTION — there is no pooled fallback, no
 * autocommit path and no `INSERT INTO audit_events` shortcut.
 *
 * What this file is written to guarantee (and cannot prove without a database —
 * see the hand-off report):
 *  - `withTransaction` is mandatory and every mutating method runs inside it, so
 *    a caller can never write a ledger row or an audit outside a unit;
 *  - `claimPending` is ONE statement, exactly R13/§11.3. Owner and expiry are
 *    always assigned together, which is what `chk_live_ingest_lease_pair`
 *    requires and what makes an owner-without-expiry unrepresentable;
 *  - `finalizeIngest` is ONE statement. The lease is cleared in the SAME
 *    statement as the outcome, so `chk_live_ingest_terminal_release` holds for
 *    a terminal outcome and the `outcome='pending'` RELEASE form hands the row
 *    back without waiting out the lease;
 *  - the pending listing excludes rows whose lease is still live
 *    (`claim_owner IS NULL OR claim_expires_at_ms <= ?`), so another worker's
 *    in-flight row cannot consume this pass's budget. That predicate is an
 *    OPTIMISATION; `claimPending` is still run before any sink and remains the
 *    only fence;
 *  - the terminal values are `ingested`, `ignored:outside-grace` and
 *    `ignored:session-cancelled`. All fit `VARCHAR(32)` and the column has no
 *    CHECK, so no DDL is needed for the two quarantines;
 *  - affected rows are the ONLY success signal. Neither CAS ever reports
 *    success on 0 rows, and a 0-row finalize is the only evidence of a lost
 *    fence (`finalize_lost`), never a success audit;
 *  - the two unique keys are told apart: `ER_DUP_ENTRY` is resolved by the key
 *    name MySQL reports, and when the name is unreadable the row is re-read by
 *    the event key ON THE SAME CONNECTION. The answer is never guessed;
 *  - NO external call happens here. The meter and the library stay in the
 *    service, between the claim unit and the terminal unit. This adapter cannot
 *    reach either of them;
 *  - the sealed audit append runs on the unit's own connection: the object
 *    handed to the writer has NO `transaction` property, which is
 *    `recordSealedAuditEvent`'s documented "caller is already on one
 *    transactional connection" path.
 *
 * BIGINT safety: `storage_bytes` is BIGINT UNSIGNED, `occurred_at_ms` and
 * `claim_expires_at_ms` are BIGINT, and mysql2 returns them as strings by
 * default. Every value is validated as an exact integer string and
 * range-checked against `Number.MAX_SAFE_INTEGER` BEFORE conversion; an unsafe
 * value throws a bounded `RecordingIngestSqlError('unsafe_bigint')` instead of
 * being silently truncated. `duration_seconds` is INT UNSIGNED. Required mysql2
 * options for production binding: `supportBigNumbers: true`,
 * `bigNumberStrings: true`.
 *
 * MySQL changed-rows semantics (the reason the affected-row counts below are
 * meaningful): with `CLIENT_FOUND_ROWS` unset, an UPDATE reports the rows it
 * actually CHANGED, not the rows it matched. The release form writes
 * `outcome='pending'` over a row that is already `pending`, so the outcome
 * column does not change — the two claim columns do (owner/expiry → NULL), and
 * that is the ONLY reason the release is distinguishable from a lost fence.
 * For the same reason a won `claimPending` always changes the row: the owner
 * token is unique per attempt, so a matched claim can never be a no-op.
 */

import type { AuditRecordInput } from '../security/audit';
import type { AuditLogDataAccess, SealedAuditRecordInput } from './audit-log';
import {
    RECORDING_CLAIM_OWNER_MAX_LENGTH,
    type RecordingIngestRow,
    type RecordingIngestStore,
    type RecordingIngestUnit,
    type RecordingSessionRef,
} from './live-recording-ingest';
import type {
    RecordingRecoveryCheckpoint,
    RecordingRecoveryCheckpointClaim,
    RecordingRecoveryCheckpointFailure,
    RecordingRecoveryCheckpointState,
    RecordingRecoveryCursor,
    RecordingRecoveryPendingSource,
} from './live-recording-recovery';

/**
 * The checkpoint types are DEFINED in `live-recording-recovery.ts` — the port
 * module — and re-exported here so a caller that wires the store does not need
 * a second import. The definitions are single-sourced there to keep the
 * dependency one-way: this adapter imports the port, never the reverse.
 */
export type { RecordingRecoveryCheckpointFailure, RecordingRecoveryCheckpointState } from './live-recording-recovery';

/* =========================================================================
 * Injected ports
 * ========================================================================= */

/**
 * ONE connection. Structurally assignable to `AuditLogDataAccess` (`query` /
 * `queryOne` / `execute`, no `transaction`), which is exactly what the sealed
 * writer needs.
 */
export interface RecordingIngestSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    queryOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
    /**
     * `affectedRows` MUST be a number (mysql2 OkPacket). An unreadable count is
     * reported as 0, never as success: the CAS is the authority.
     */
    execute(sql: string, params?: readonly unknown[]): Promise<{ affectedRows?: number; insertId?: number }>;
}

/**
 * The transaction runner. `transaction` must BEGIN/COMMIT on one pooled
 * connection, ROLLBACK and rethrow on a throw, and hand that same connection to
 * `work`. This adapter never owns a pool and never retries.
 */
export interface RecordingIngestSqlExecutor extends RecordingIngestSqlConnection {
    transaction<T>(work: (conn: RecordingIngestSqlConnection) => Promise<T>): Promise<T>;
}

/** `recordSealedAuditEvent` is structurally this signature. */
export type RecordingSealedAuditWriter = (
    db: AuditLogDataAccess,
    input: SealedAuditRecordInput,
) => Promise<void>;

export interface RecordingIngestSqlDeps {
    executor: RecordingIngestSqlExecutor;
    /** Required. A factory without it refuses to build — never a no-op. */
    sealedAudit: RecordingSealedAuditWriter;
}

/**
 * Compile-time proof (emits nothing) that the connection port can drive the
 * sealed writer through `AuditLogDataAccess`. If the two ever drift, this file
 * stops compiling instead of silently losing the sealed append.
 */
type AssertAssignable<T extends U, U> = T;
export type IngestConnectionIsAuditDataAccess = AssertAssignable<RecordingIngestSqlConnection, AuditLogDataAccess>;

export type RecordingIngestSqlErrorCode =
    | 'invalid_deps'
    | 'invalid_input'
    | 'invalid_row'
    | 'unsafe_bigint'
    | 'invalid_outcome';

export class RecordingIngestSqlError extends Error {
    constructor(public readonly code: RecordingIngestSqlErrorCode, message: string) {
        super(message);
        this.name = 'RecordingIngestSqlError';
    }
}

/* =========================================================================
 * Columns, enums, helpers
 * ========================================================================= */

const INGEST_COLUMNS = `id, tenant_id, session_id, provider, event_id, provider_recording_id,
       duration_seconds, storage_bytes, occurred_at_ms, outcome, claim_owner, claim_expires_at_ms`;

const SESSION_COLUMNS = 'id, tenant_id, title, state, ended_at_ms, host_user_id';

/**
 * The only outcomes this service writes.
 *
 * `pending` is the transient/release value; `ingested` is the success terminal
 * value; the two `ignored:*` values are the quarantines the ingest service
 * writes when it can PROVE inside a fenced unit that a pending row can never
 * become ingestible (`ignored:outside-grace`, `ignored:session-cancelled`).
 *
 * No DDL is required for those two: `outcome` is `VARCHAR(32)` with no CHECK
 * (migration 06 comment: "pending is transient; terminal values are written by
 * the adapter"). The longest is 25 characters. `chk_live_ingest_terminal_release`
 * is satisfied because `finalizeIngest` clears `claim_owner` and
 * `claim_expires_at_ms` in the SAME statement that writes the terminal value.
 * The adapter is the thing that keeps a typo from becoming a terminal-looking
 * state.
 */
const INGEST_OUTCOMES = [
    'pending',
    'ingested',
    'ignored:outside-grace',
    'ignored:session-cancelled',
] as const;
type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

const SESSION_STATES = ['scheduled', 'live', 'ended', 'cancelled'] as const;
type SessionState = (typeof SESSION_STATES)[number];

/** The two unique keys `uq_ingest_event` / `uq_ingest_recording`, by name. */
const UNIQUE_KEY_EVENT = 'uq_ingest_event';
const UNIQUE_KEY_RECORDING = 'uq_ingest_recording';

/** Defence in depth: the listing is never asked for an unbounded page. */
const MAX_PENDING_PAGE = 500;

const INTEGER_TEXT = /^-?\d+$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

interface RecordingIngestDbRow {
    id: string;
    tenant_id: string;
    session_id: string;
    provider: string;
    event_id: string;
    provider_recording_id: string;
    duration_seconds: number | string;
    storage_bytes: number | string;
    occurred_at_ms: number | string;
    outcome: string;
    claim_owner: string | null;
    claim_expires_at_ms: number | string | null;
}

interface RecordingSessionDbRow {
    id: string;
    tenant_id: string;
    title: string;
    state: string;
    ended_at_ms: number | string | null;
    host_user_id: string | null;
}

/** Exact integer -> number. Never `Number()` on an unchecked string. */
const readSafeInteger = (value: unknown, field: string): number => {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new RecordingIngestSqlError('unsafe_bigint', `${field} is outside the safe integer range`);
        }
        return value;
    }
    if (typeof value === 'string') {
        const text = value.trim();
        if (!INTEGER_TEXT.test(text)) {
            throw new RecordingIngestSqlError('unsafe_bigint', `${field} is not an exact integer string`);
        }
        const parsed = BigInt(text);
        if (parsed > MAX_SAFE || parsed < MIN_SAFE) {
            throw new RecordingIngestSqlError('unsafe_bigint', `${field} is outside the safe integer range`);
        }
        return Number(parsed);
    }
    throw new RecordingIngestSqlError('invalid_row', `${field} is not an integer`);
};

const readNullableInteger = (value: unknown, field: string): number | null =>
    value === null || value === undefined ? null : readSafeInteger(value, field);

/** UNSIGNED column read: negative is a corrupt row, not a small number. */
const readUnsignedInteger = (value: unknown, field: string): number => {
    const parsed = readSafeInteger(value, field);
    if (parsed < 0) {
        throw new RecordingIngestSqlError('invalid_row', `${field} is UNSIGNED but the row holds ${parsed}`);
    }
    return parsed;
};

/** Write-side guard: the unit only ever passes numbers, never a string. */
const requireEpochMs = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new RecordingIngestSqlError('invalid_input', `${field} must be a safe integer epoch in milliseconds`);
    }
    return value;
};

const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new RecordingIngestSqlError('invalid_input', `${field} is required`);
    }
    return value;
};

/** Read-side counterpart: a missing column value is a corrupt row, not bad input. */
const readText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new RecordingIngestSqlError('invalid_row', `${field} is missing`);
    }
    return value;
};

const requireOwner = (value: unknown): string => {
    const owner = requireText(value, 'claimOwner');
    if (owner.length > RECORDING_CLAIM_OWNER_MAX_LENGTH) {
        throw new RecordingIngestSqlError(
            'invalid_input',
            `claimOwner exceeds the ${RECORDING_CLAIM_OWNER_MAX_LENGTH}-char column bound`,
        );
    }
    return owner;
};

const requireOutcome = (value: unknown): IngestOutcome => {
    if (typeof value !== 'string' || !(INGEST_OUTCOMES as readonly string[]).includes(value)) {
        throw new RecordingIngestSqlError(
            'invalid_outcome',
            `outcome "${String(value)}" is not one this service writes (${INGEST_OUTCOMES.join(' | ')})`,
        );
    }
    return value as IngestOutcome;
};

const affectedOf = (result: { affectedRows?: number }): number =>
    typeof result.affectedRows === 'number' && Number.isSafeInteger(result.affectedRows) && result.affectedRows >= 0
        ? result.affectedRows
        : 0;

const isDuplicateEntry = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
};

/**
 * Which unique key a 1062 named, or null when the driver did not say.
 * MySQL 5.7 writes `for key 'uq_ingest_event'`; 8.0.19+ writes
 * `for key 'live_recording_ingests.uq_ingest_event'`. Both contain the key
 * name, which is what this matches — never the value inside the quotes, which
 * is caller data.
 */
const duplicateKeyName = (error: unknown): string | null => {
    if (!error || typeof error !== 'object') return null;
    const message = (error as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    if (message.includes(UNIQUE_KEY_EVENT)) return UNIQUE_KEY_EVENT;
    if (message.includes(UNIQUE_KEY_RECORDING)) return UNIQUE_KEY_RECORDING;
    return null;
};

const mapIngestRow = (row: RecordingIngestDbRow): RecordingIngestRow => {
    const outcome = readText(row.outcome, 'live_recording_ingests.outcome');
    const claimOwner = row.claim_owner === null || row.claim_owner === undefined
        ? null
        : readText(row.claim_owner, 'live_recording_ingests.claim_owner');
    const claimExpiresAtMs = readNullableInteger(
        row.claim_expires_at_ms,
        'live_recording_ingests.claim_expires_at_ms',
    );
    // Mirrors chk_live_ingest_lease_pair: an owner without expiry (or the
    // reverse) is unrepresentable in the table, so a row that shows it is
    // corrupt and must not be turned into a claimable row here.
    if ((claimOwner === null) !== (claimExpiresAtMs === null)) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            'live_recording_ingests row breaks chk_live_ingest_lease_pair',
        );
    }
    if (claimOwner !== null && claimOwner.length > RECORDING_CLAIM_OWNER_MAX_LENGTH) {
        throw new RecordingIngestSqlError('invalid_row', 'live_recording_ingests.claim_owner exceeds its column bound');
    }
    // Mirrors chk_live_ingest_terminal_release: a terminal row holds no lease.
    if (outcome !== 'pending' && claimOwner !== null) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            'live_recording_ingests row breaks chk_live_ingest_terminal_release',
        );
    }
    return {
        id: readText(row.id, 'live_recording_ingests.id'),
        tenantId: readText(row.tenant_id, 'live_recording_ingests.tenant_id'),
        sessionId: readText(row.session_id, 'live_recording_ingests.session_id'),
        provider: readText(row.provider, 'live_recording_ingests.provider'),
        eventId: readText(row.event_id, 'live_recording_ingests.event_id'),
        providerRecordingId: readText(row.provider_recording_id, 'live_recording_ingests.provider_recording_id'),
        durationSeconds: readUnsignedInteger(row.duration_seconds, 'live_recording_ingests.duration_seconds'),
        storageBytes: readUnsignedInteger(row.storage_bytes, 'live_recording_ingests.storage_bytes'),
        occurredAtMs: readSafeInteger(row.occurred_at_ms, 'live_recording_ingests.occurred_at_ms'),
        outcome,
        claimOwner,
        claimExpiresAtMs,
    };
};

const mapSessionRow = (row: RecordingSessionDbRow): RecordingSessionRef => {
    if (!(SESSION_STATES as readonly string[]).includes(row.state)) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            `live_sessions.state "${String(row.state)}" is not a known state`,
        );
    }
    // CHAR(36) discipline, same as the ledger's owner bound: a non-string,
    // empty or oversized id means "no owner" — never truncated, never a
    // sentinel, never the tenant id. The service re-normalises; this keeps the
    // descriptor from carrying something `video_assets.owner_user_id` cannot
    // store.
    const hostUserId = typeof row.host_user_id === 'string'
        && row.host_user_id.length > 0
        && row.host_user_id.length <= 36
        ? row.host_user_id
        : null;
    return {
        id: readText(row.id, 'live_sessions.id'),
        tenantId: readText(row.tenant_id, 'live_sessions.tenant_id'),
        title: typeof row.title === 'string' ? row.title : '',
        state: row.state as SessionState,
        endedAtMs: readNullableInteger(row.ended_at_ms, 'live_sessions.ended_at_ms'),
        hostUserId,
    };
};

/* =========================================================================
 * Reads
 * ========================================================================= */

const findIngestRow = async (
    conn: RecordingIngestSqlConnection,
    tenantId: string,
    provider: string,
    eventId: string,
): Promise<RecordingIngestRow | null> => {
    const row = await conn.queryOne<RecordingIngestDbRow>(
        `SELECT ${INGEST_COLUMNS} FROM live_recording_ingests
          WHERE tenant_id = ? AND provider = ? AND event_id = ?
          LIMIT 1`,
        [tenantId, provider, eventId],
    );
    return row ? mapIngestRow(row) : null;
};

/**
 * Tenant-scoped session read by id. The recovery entry point needs it because a
 * persisted ledger row carries `session_id`, not the provider room id: a resume
 * has no callback payload to resolve a room from, so the session is re-read by
 * the key the row already proved.
 */
const findSessionByIdRow = async (
    conn: RecordingIngestSqlConnection,
    tenantId: string,
    sessionId: string,
): Promise<RecordingSessionRef | null> => {
    const row = await conn.queryOne<RecordingSessionDbRow>(
        `SELECT ${SESSION_COLUMNS} FROM live_sessions
          WHERE id = ? AND tenant_id = ?
          LIMIT 1`,
        [sessionId, tenantId],
    );
    return row ? mapSessionRow(row) : null;
};

/**
 * The ONLY tenant-less read, by design: a provider callback carries no caller
 * tenant. `uq_live_session_room (provider, provider_room_id)` makes the pair
 * unique, and the tenant used afterwards comes from the returned row — never
 * from the callback payload.
 */
const findSessionByProviderRoomRow = async (
    conn: RecordingIngestSqlConnection,
    provider: string,
    providerRoomId: string,
): Promise<RecordingSessionRef | null> => {
    if (typeof provider !== 'string' || provider.length === 0
        || typeof providerRoomId !== 'string' || providerRoomId.length === 0) {
        return null;
    }
    const row = await conn.queryOne<RecordingSessionDbRow>(
        `SELECT ${SESSION_COLUMNS} FROM live_sessions
          WHERE provider = ? AND provider_room_id = ?
          LIMIT 1`,
        [provider, providerRoomId],
    );
    return row ? mapSessionRow(row) : null;
};

/**
 * Keyset page over the repair set. `(occurred_at_ms, id)` is immutable and
 * totally ordered (`id` is the primary key and breaks ties), so a page asks for
 * rows STRICTLY AFTER the last key it saw and never for an offset.
 *
 * Two predicates, two different jobs:
 *
 *  - `outcome = 'pending'` — the repair set;
 *  - `(claim_owner IS NULL OR claim_expires_at_ms <= ?)` — a row another worker
 *    is CURRENTLY holding is not this pass's work and must not be counted
 *    against the batch cap. Without it, a batch of live leases consumes the
 *    whole budget on every pass and later rows are never reached.
 *
 * That second predicate is an OPTIMISATION, NEVER THE FENCE. It is evaluated
 * once, on a snapshot, and the lease can change immediately afterwards; the
 * only thing that makes an attempt the owner is the `claimPending` CAS, which
 * still runs before any sink. A row this filter lets through and the CAS then
 * loses is reported `claim-held` and the marker is not touched.
 *
 * R21 / index: the predicate does NOT change the access path.
 * `idx_live_ingest_pending (outcome, occurred_at_ms, id)` still supplies the
 * range and the order; the two lease columns are checked as a residual filter
 * on the rows the index already narrowed, and `LIMIT` bounds that work. No new
 * column, no new index, no DDL is required or proposed here.
 *
 * `LIMIT ?` goes through `query` (text protocol) rather than `execute`: the
 * bound is a clamped integer, and the text protocol is the one that reliably
 * interpolates a numeric LIMIT. No caller value reaches the statement as SQL.
 */
const listPendingIngestRows = async (
    conn: RecordingIngestSqlConnection,
    input: { after: { occurredAtMs: number; id: string } | null; limit: number; nowMs: number },
): Promise<RecordingIngestRow[]> => {
    const limit = Math.min(
        MAX_PENDING_PAGE,
        Math.max(1, Number.isSafeInteger(input.limit) ? input.limit : 1),
    );
    const nowMs = requireEpochMs(input.nowMs, 'nowMs');
    const after = input.after;
    if (after === null) {
        const rows = await conn.query<RecordingIngestDbRow>(
            `SELECT ${INGEST_COLUMNS} FROM live_recording_ingests
              WHERE outcome = 'pending'
                AND (claim_owner IS NULL OR claim_expires_at_ms <= ?)
              ORDER BY occurred_at_ms ASC, id ASC
              LIMIT ?`,
            [nowMs, limit],
        );
        return rows.map(mapIngestRow);
    }
    const occurredAtMs = requireEpochMs(after.occurredAtMs, 'after.occurredAtMs');
    const id = requireText(after.id, 'after.id');
    const rows = await conn.query<RecordingIngestDbRow>(
        `SELECT ${INGEST_COLUMNS} FROM live_recording_ingests
          WHERE outcome = 'pending'
            AND (claim_owner IS NULL OR claim_expires_at_ms <= ?)
            AND (occurred_at_ms > ? OR (occurred_at_ms = ? AND id > ?))
          ORDER BY occurred_at_ms ASC, id ASC
          LIMIT ?`,
        [nowMs, occurredAtMs, occurredAtMs, id, limit],
    );
    return rows.map(mapIngestRow);
};

/* =========================================================================
 * Writes — one statement per CAS, affected rows only
 * ========================================================================= */

/**
 * R13 claim. ONE statement; owner and expiry are assigned together, so
 * `chk_live_ingest_lease_pair` can never see half a lease. The predicate's
 * NULL behaviour is deliberate: an owner with a NULL expiry makes
 * `claim_expires_at_ms <= ?` NULL, so such a row is unclaimable — which is why
 * the pair is always written together.
 *
 * 1 = this attempt owns the row and may run the external calls; 0 = it does
 * not and must not.
 */
const claimPendingRow = async (
    conn: RecordingIngestSqlConnection,
    input: { id: string; owner: string; nowMs: number; leaseUntilMs: number },
): Promise<number> => {
    const id = requireText(input.id, 'id');
    const owner = requireOwner(input.owner);
    const nowMs = requireEpochMs(input.nowMs, 'nowMs');
    const leaseUntilMs = requireEpochMs(input.leaseUntilMs, 'leaseUntilMs');
    if (leaseUntilMs <= nowMs) {
        throw new RecordingIngestSqlError('invalid_input', 'leaseUntilMs must be later than nowMs');
    }
    const result = await conn.execute(
        `UPDATE live_recording_ingests
            SET claim_owner = ?, claim_expires_at_ms = ?
          WHERE id = ? AND outcome = 'pending'
            AND (claim_owner IS NULL OR claim_expires_at_ms <= ?)`,
        [owner, leaseUntilMs, id, nowMs],
    );
    return affectedOf(result);
};

/**
 * R13 guarded transition. ONE statement; the lease is cleared in the same
 * statement as the outcome.
 *
 *  - terminal outcome (`ingested`, `ignored:outside-grace`,
 *    `ignored:session-cancelled`): `chk_live_ingest_terminal_release` requires
 *    the cleared lease, and the outcome column changes, so affected rows = 1
 *    exactly when this attempt performed the transition;
 *  - `outcome: 'pending'` is the RELEASE form: the outcome column keeps its
 *    value, and the two claim columns change owner/expiry → NULL. Under
 *    MySQL's changed-rows semantics that lease clear is the ONLY reason a
 *    release reports 1. A 0 therefore always means the fence was lost (or the
 *    row was never ours), and the caller must not write a success audit.
 */
const finalizeIngestRow = async (
    conn: RecordingIngestSqlConnection,
    input: { id: string; outcome: string; expect: { owner: string } },
): Promise<number> => {
    const id = requireText(input.id, 'id');
    const outcome = requireOutcome(input.outcome);
    const owner = requireOwner(input.expect?.owner);
    const result = await conn.execute(
        `UPDATE live_recording_ingests
            SET outcome = ?, claim_owner = NULL, claim_expires_at_ms = NULL
          WHERE id = ? AND outcome = 'pending' AND claim_owner = ?`,
        [outcome, id, owner],
    );
    return affectedOf(result);
};

/**
 * The unique-key insert is the CAS for a first delivery, so the inserter owns
 * the row: owner and expiry are written together with the marker, or neither is.
 *
 * A duplicate is resolved, not guessed:
 *  1. the key name MySQL reports decides when it is readable;
 *  2. otherwise the row is re-read by the EVENT key on this same connection —
 *     a found row means `event-replay`, its absence means the other unique key
 *     (`recording-exists`) is what refused the insert.
 *
 * The re-read is valid inside the same unit because InnoDB rolls back the
 * failed statement, not the transaction, and because this connection holds the
 * only writer's view of the keys it just collided with.
 *
 * A collision on the PRIMARY KEY (`id`, a generated UUID) is neither of the two
 * dedupe keys and this port cannot name it. Step 2 then finds no event row and
 * reports `recording-exists`; the service refuses the write either way, so the
 * mislabel costs a wrong reason in an audit, never a lost or duplicated row.
 */
const insertIngestRow = async (
    conn: RecordingIngestSqlConnection,
    row: RecordingIngestRow,
): Promise<{ inserted: boolean; reason: 'event-replay' | 'recording-exists' | null }> => {
    const id = requireText(row.id, 'id');
    const tenantId = requireText(row.tenantId, 'tenantId');
    const sessionId = requireText(row.sessionId, 'sessionId');
    const provider = requireText(row.provider, 'provider');
    const eventId = requireText(row.eventId, 'eventId');
    const providerRecordingId = requireText(row.providerRecordingId, 'providerRecordingId');
    if (row.outcome !== 'pending') {
        throw new RecordingIngestSqlError('invalid_outcome', 'a fresh ledger row is inserted as pending only');
    }
    const durationSeconds = row.durationSeconds;
    const storageBytes = row.storageBytes;
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
        throw new RecordingIngestSqlError('invalid_input', 'durationSeconds must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(storageBytes) || storageBytes < 0) {
        throw new RecordingIngestSqlError('invalid_input', 'storageBytes must be a non-negative safe integer');
    }
    const occurredAtMs = requireEpochMs(row.occurredAtMs, 'occurredAtMs');
    const claimOwner = row.claimOwner === null ? null : requireOwner(row.claimOwner);
    const claimExpiresAtMs = row.claimExpiresAtMs === null
        ? null
        : requireEpochMs(row.claimExpiresAtMs, 'claimExpiresAtMs');
    // Both, or neither — the CHECK is the enforcement, this is the early refusal.
    if ((claimOwner === null) !== (claimExpiresAtMs === null)) {
        throw new RecordingIngestSqlError(
            'invalid_input',
            'claimOwner and claimExpiresAtMs must be written together (chk_live_ingest_lease_pair)',
        );
    }

    try {
        await conn.execute(
            `INSERT INTO live_recording_ingests
                 (id, tenant_id, session_id, provider, event_id, provider_recording_id,
                  duration_seconds, storage_bytes, occurred_at_ms, outcome,
                  claim_owner, claim_expires_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                id,
                tenantId,
                sessionId,
                provider,
                eventId,
                providerRecordingId,
                durationSeconds,
                storageBytes,
                occurredAtMs,
                claimOwner,
                claimExpiresAtMs,
            ],
        );
    } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
        const key = duplicateKeyName(error);
        if (key === UNIQUE_KEY_RECORDING) return { inserted: false, reason: 'recording-exists' };
        if (key === UNIQUE_KEY_EVENT) return { inserted: false, reason: 'event-replay' };
        // The driver did not name the key. Ask the row instead of guessing.
        const existing = await findIngestRow(conn, tenantId, provider, eventId);
        return { inserted: false, reason: existing ? 'event-replay' : 'recording-exists' };
    }
    return { inserted: true, reason: null };
};

/* =========================================================================
 * Sealed audit — same connection, no nested transaction
 * ========================================================================= */

/**
 * The object handed to the sealed writer deliberately has NO `transaction`
 * property. `recordSealedAuditEvent` then takes its documented path for a
 * caller that is ALREADY on one transactional connection, so the chain-head
 * lock, the leaf read and the append all run on this unit's connection. Giving
 * it a transaction seam would open a second connection and split the unit.
 */
const recordSealedAudit = async (
    conn: RecordingIngestSqlConnection,
    sealedAudit: RecordingSealedAuditWriter,
    input: AuditRecordInput,
): Promise<void> => {
    const auditConnection: AuditLogDataAccess = {
        query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => conn.query<T>(sql, params),
        queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => conn.queryOne<T>(sql, params),
        execute: (sql: string, params?: unknown[]) => conn.execute(sql, params),
    };
    await sealedAudit(auditConnection, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        oldValue: input.oldValue,
        newValue: input.newValue,
        reason: input.reason,
    });
};

/* =========================================================================
 * Unit + store
 * ========================================================================= */

/** A unit that also carries the methods this adapter always provides. */
export interface RecordingIngestSqlUnit extends RecordingIngestUnit {
    claimPending(input: { id: string; owner: string; nowMs: number; leaseUntilMs: number }): Promise<number>;
    findSessionById(tenantId: string, sessionId: string): Promise<RecordingSessionRef | null>;
}

export interface RecordingIngestSqlStore extends RecordingIngestStore {
    /** Mandatory, unlike the optional port member. */
    withTransaction<T>(work: (unit: RecordingIngestUnit) => Promise<T>): Promise<T>;
    claimPending(input: { id: string; owner: string; nowMs: number; leaseUntilMs: number }): Promise<number>;
    findSessionById(tenantId: string, sessionId: string): Promise<RecordingSessionRef | null>;
    /** Keyset listing over the claimable `outcome='pending'` set. `nowMs` is
     *  the pass clock: a row whose lease is still live is excluded, because it
     *  is another worker's work and must not consume this pass's budget. The
     *  exclusion is an optimisation — the CAS in `claimPending` is the fence. */
    listPendingIngests(input: {
        after: { occurredAtMs: number; id: string } | null;
        limit: number;
        nowMs: number;
    }): Promise<RecordingIngestRow[]>;
}

/**
 * Compile-time proof (emits nothing) that this store can drive the bounded
 * recovery pass: `runRecordingRecoveryOnce` accepts any
 * `RecordingRecoveryPendingSource`, and the keyset listing above is one. If the
 * two ever drift, this file stops compiling instead of the sweep silently
 * reading a different order.
 */
export type IngestStoreIsRecoverySource = AssertAssignable<RecordingIngestSqlStore, RecordingRecoveryPendingSource>;

/**
 * Bind every unit method to ONE connection. The caller owns the transaction;
 * this function never opens one and never calls a sink.
 */
export const createRecordingIngestSqlUnit = (
    conn: RecordingIngestSqlConnection,
    sealedAudit: RecordingSealedAuditWriter,
): RecordingIngestSqlUnit => ({
    findSessionByProviderRoom: (provider, providerRoomId) => findSessionByProviderRoomRow(conn, provider, providerRoomId),
    findSessionById: (tenantId, sessionId) => findSessionByIdRow(conn, tenantId, sessionId),
    findIngest: (tenantId, provider, eventId) => findIngestRow(conn, tenantId, provider, eventId),
    insertIngest: (row) => insertIngestRow(conn, row),
    claimPending: (input) => claimPendingRow(conn, input),
    finalizeIngest: (input) => finalizeIngestRow(conn, input),
    recordAudit: (input) => recordSealedAudit(conn, sealedAudit, input),
});

class RecordingIngestSqlStoreImpl implements RecordingIngestSqlStore {
    constructor(private readonly deps: RecordingIngestSqlDeps) {
        if (!deps || !deps.executor || typeof deps.executor !== 'object') {
            throw new RecordingIngestSqlError(
                'invalid_deps',
                'createRecordingIngestSqlStore requires a connection-bound executor',
            );
        }
        const { executor, sealedAudit } = deps;
        if (typeof executor.query !== 'function'
            || typeof executor.queryOne !== 'function'
            || typeof executor.execute !== 'function'
            || typeof executor.transaction !== 'function') {
            throw new RecordingIngestSqlError(
                'invalid_deps',
                'the executor must provide query, queryOne, execute and transaction on ONE connection',
            );
        }
        // Required, never a no-op and never a plain audit_events INSERT.
        if (typeof sealedAudit !== 'function') {
            throw new RecordingIngestSqlError(
                'invalid_deps',
                'createRecordingIngestSqlStore requires a sealed audit writer; there is no fallback',
            );
        }
    }

    private withSqlUnit<T>(work: (unit: RecordingIngestSqlUnit) => Promise<T>): Promise<T> {
        return this.deps.executor.transaction((conn) => work(createRecordingIngestSqlUnit(conn, this.deps.sealedAudit)));
    }

    withTransaction<T>(work: (unit: RecordingIngestUnit) => Promise<T>): Promise<T> {
        return this.withSqlUnit(work);
    }

    /* Reads run as one statement (contract §2: read paths take no unit).
     * Writes always run inside one, even when called on the store rather than
     * through a unit, so no statement is ever autocommitted. */

    findSessionByProviderRoom(provider: string, providerRoomId: string): Promise<RecordingSessionRef | null> {
        return findSessionByProviderRoomRow(this.deps.executor, provider, providerRoomId);
    }

    findSessionById(tenantId: string, sessionId: string): Promise<RecordingSessionRef | null> {
        return findSessionByIdRow(this.deps.executor, tenantId, sessionId);
    }

    findIngest(tenantId: string, provider: string, eventId: string): Promise<RecordingIngestRow | null> {
        return findIngestRow(this.deps.executor, tenantId, provider, eventId);
    }

    insertIngest(row: RecordingIngestRow): Promise<{ inserted: boolean; reason: 'event-replay' | 'recording-exists' | null }> {
        return this.withSqlUnit((unit) => unit.insertIngest(row));
    }

    claimPending(input: { id: string; owner: string; nowMs: number; leaseUntilMs: number }): Promise<number> {
        return this.withSqlUnit((unit) => unit.claimPending(input));
    }

    finalizeIngest(input: { id: string; outcome: string; expect: { owner: string } }): Promise<number> {
        return this.withSqlUnit((unit) => unit.finalizeIngest(input));
    }

    recordAudit(input: AuditRecordInput): Promise<void> {
        return this.withSqlUnit((unit) => unit.recordAudit(input));
    }

    listPendingIngests(input: {
        after: { occurredAtMs: number; id: string } | null;
        limit: number;
        nowMs: number;
    }): Promise<RecordingIngestRow[]> {
        return listPendingIngestRows(this.deps.executor, input);
    }
}

/**
 * Build the durable store. Throws before any statement when the executor or the
 * sealed audit writer is missing; the adapter never owns a pool and never
 * writes an audit outside the chain.
 */
export const createRecordingIngestSqlStore = (deps: RecordingIngestSqlDeps): RecordingIngestSqlStore =>
    new RecordingIngestSqlStoreImpl(deps);

/* =========================================================================
 * R24 recovery checkpoint — one durable cursor for the one global scan
 * ========================================================================= */

/**
 * The purpose is SERVER-OWNED, and that is the point of the row: one fixed key
 * means one global scan over `live_recording_ingests`. If a caller could choose
 * the key, two callers would walk the same workset as two independent scans,
 * each with its own cursor, and a durable continuation would stop meaning
 * anything. It is a module constant, never a parameter, and the factory below
 * refuses a construction-time override.
 *
 * The row targets the REQUESTED migration
 * `20261023_04_live_recovery_checkpoint.sql`, which is not in this repository.
 * No DDL is added here and no column is invented: while the table or one of its
 * columns is missing, every method degrades to `checkpoint-absent` /
 * `schema-unavailable` instead of throwing, so the pass can run before the
 * migration lands and report the reason.
 *
 * `row_version` is the fencing token. Every claim, advance, completeSweep and
 * release increments it and must present the value it last saw, so a worker
 * that lost the row cannot write through a stale read. `updated_at_ms` is
 * written by every mutation. Owner and expiry are written together or not at
 * all, and the cursor pair is both or neither — the two CHECK constraints of
 * the table, mirrored on read as `invalid_row`.
 *
 * Changed-rows semantics (see the header of this file): every statement below
 * changes `row_version`, so an UPDATE that matched a row always CHANGED it.
 * Affected rows = 1 means the CAS won; 0 means it lost. No statement here can
 * win by matching a row and writing identical values.
 *
 * Every write runs inside `executor.transaction`. This adapter never
 * autocommits a checkpoint mutation, and the 0-affected classification re-reads
 * the row on the SAME connection inside the SAME unit.
 */
export const RECOVERY_CHECKPOINT_PURPOSE = 'recording-recovery-global';
/** `owner VARCHAR(128)`. */
export const CHECKPOINT_OWNER_MAX_LENGTH = 128;
/** `cursor_id VARCHAR(64)`; the ingest id is a UUID, the column is wider. */
export const CHECKPOINT_CURSOR_ID_MAX_LENGTH = 64;
export const CHECKPOINT_DEFAULT_LEASE_MS = 60_000;
export const CHECKPOINT_LEASE_MS_CEILING = 5 * 60_000;

/**
 * The durable state of the one scan. `cursor: null` is the full-sweep reset.
 * `rowVersion` fences every later claim/advance/release; `sweepGeneration`
 * counts completed sweeps and is what a completed sweep increments.
 */
export interface RecordingRecoveryCheckpointSnapshot {
    state: RecordingRecoveryCheckpointState;
    updatedAtMs: number;
    /** `lease_expires_at_ms > nowMs` for a row that currently has an owner. */
    leaseActive: boolean;
}

export interface RecordingRecoveryCheckpointStore extends RecordingRecoveryCheckpoint {
    /** The fixed server-owned key; identical for every instance. */
    readonly purpose: typeof RECOVERY_CHECKPOINT_PURPOSE;
    /**
     * Diagnostics only: one SELECT, no write. A missing table or column reads as
     * `null` — this method has no failure channel and does not throw for those
     * two driver codes.
     */
    read(nowMs: number): Promise<RecordingRecoveryCheckpointSnapshot | null>;
}

const CHECKPOINT_COLUMNS = `purpose, cursor_occurred_at_ms, cursor_id, owner,
       lease_expires_at_ms, row_version, sweep_generation, updated_at_ms`;

interface RecordingRecoveryCheckpointDbRow {
    purpose: string;
    cursor_occurred_at_ms: number | string | null;
    cursor_id: string | null;
    owner: string | null;
    lease_expires_at_ms: number | string | null;
    row_version: number | string;
    sweep_generation: number | string;
    updated_at_ms: number | string;
}

const requireCheckpointOwner = (value: unknown): string => {
    const owner = requireText(value, 'owner');
    if (owner.length > CHECKPOINT_OWNER_MAX_LENGTH) {
        throw new RecordingIngestSqlError(
            'invalid_input',
            `owner exceeds the ${CHECKPOINT_OWNER_MAX_LENGTH}-char column bound`,
        );
    }
    return owner;
};

/**
 * Owner and expiry are always written together, so an expiry is derived from
 * the caller's clock plus the lease and never taken from the caller. A lease
 * longer than the ceiling, a non-positive lease or an expiry outside the safe
 * integer range is refused before any statement runs.
 */
const checkpointLeaseExpiry = (nowMs: number, leaseMs: unknown): number => {
    if (typeof leaseMs !== 'number' || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new RecordingIngestSqlError('invalid_input', 'leaseMs must be a positive safe integer');
    }
    if (leaseMs > CHECKPOINT_LEASE_MS_CEILING) {
        throw new RecordingIngestSqlError(
            'invalid_input',
            `leaseMs exceeds the ${CHECKPOINT_LEASE_MS_CEILING} ms ceiling`,
        );
    }
    const expiresAtMs = nowMs + leaseMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
        throw new RecordingIngestSqlError('invalid_input', 'nowMs + leaseMs is outside the safe integer range');
    }
    return expiresAtMs;
};

/** `row_version >= 1`, `sweep_generation >= 0` — the table's own lower bounds. */
const requireCheckpointCounter = (value: unknown, field: string, min: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new RecordingIngestSqlError('invalid_input', `${field} must be a safe integer >= ${min}`);
    }
    return value;
};

const requireCheckpointCursor = (value: unknown, field: string): RecordingRecoveryCursor => {
    if (!value || typeof value !== 'object') {
        throw new RecordingIngestSqlError('invalid_input', `${field} must be a cursor object`);
    }
    const cursor = value as { occurredAtMs?: unknown; id?: unknown };
    const occurredAtMs = requireEpochMs(cursor.occurredAtMs, `${field}.occurredAtMs`);
    const id = requireText(cursor.id, `${field}.id`);
    if (id.length > CHECKPOINT_CURSOR_ID_MAX_LENGTH) {
        throw new RecordingIngestSqlError(
            'invalid_input',
            `${field}.id exceeds the ${CHECKPOINT_CURSOR_ID_MAX_LENGTH}-char column bound`,
        );
    }
    return { occurredAtMs, id };
};

/** Byte-exact `id`, numeric `occurredAtMs`; both `null` compares equal. */
const sameCheckpointCursor = (a: RecordingRecoveryCursor | null, b: RecordingRecoveryCursor | null): boolean => {
    if (a === null || b === null) return a === b;
    return a.occurredAtMs === b.occurredAtMs && a.id === b.id;
};

/**
 * Read one row and validate it against the table's CHECK constraints. A
 * half-set cursor or a half-set lease is `invalid_row`, never a silently
 * repaired value, and an unsafe BIGINT is `unsafe_bigint`, never truncated.
 */
const mapCheckpointRow = (row: RecordingRecoveryCheckpointDbRow): RecordingRecoveryCheckpointState => {
    const cursorOccurredAtMs = readNullableInteger(
        row.cursor_occurred_at_ms,
        'live_recovery_checkpoints.cursor_occurred_at_ms',
    );
    const cursorId = row.cursor_id === null || row.cursor_id === undefined
        ? null
        : readText(row.cursor_id, 'live_recovery_checkpoints.cursor_id');
    if ((cursorOccurredAtMs === null) !== (cursorId === null)) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            'live_recovery_checkpoints row holds half a cursor (cursor_occurred_at_ms / cursor_id)',
        );
    }
    if (cursorId !== null && cursorId.length > CHECKPOINT_CURSOR_ID_MAX_LENGTH) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            'live_recovery_checkpoints.cursor_id exceeds its column bound',
        );
    }
    const cursor: RecordingRecoveryCursor | null = cursorId === null || cursorOccurredAtMs === null
        ? null
        : { occurredAtMs: cursorOccurredAtMs, id: cursorId };
    const owner = row.owner === null || row.owner === undefined
        ? null
        : readText(row.owner, 'live_recovery_checkpoints.owner');
    const leaseExpiresAtMs = readNullableInteger(
        row.lease_expires_at_ms,
        'live_recovery_checkpoints.lease_expires_at_ms',
    );
    if ((owner === null) !== (leaseExpiresAtMs === null)) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            'live_recovery_checkpoints row holds half a lease (owner / lease_expires_at_ms)',
        );
    }
    if (owner !== null && owner.length > CHECKPOINT_OWNER_MAX_LENGTH) {
        throw new RecordingIngestSqlError(
            'invalid_row',
            'live_recovery_checkpoints.owner exceeds its column bound',
        );
    }
    const rowVersion = readUnsignedInteger(row.row_version, 'live_recovery_checkpoints.row_version');
    if (rowVersion < 1) {
        throw new RecordingIngestSqlError('invalid_row', 'live_recovery_checkpoints.row_version is below 1');
    }
    return {
        cursor,
        owner,
        leaseExpiresAtMs,
        rowVersion,
        sweepGeneration: readUnsignedInteger(
            row.sweep_generation,
            'live_recovery_checkpoints.sweep_generation',
        ),
    };
};

const readCheckpointRow = async (
    conn: RecordingIngestSqlConnection,
): Promise<RecordingRecoveryCheckpointDbRow | null> => {
    const row = await conn.queryOne<RecordingRecoveryCheckpointDbRow>(
        `SELECT ${CHECKPOINT_COLUMNS} FROM live_recovery_checkpoints
          WHERE purpose = ?
          LIMIT 1`,
        [RECOVERY_CHECKPOINT_PURPOSE],
    );
    return row ?? null;
};

/**
 * The classification of a 0-affected CAS. It is derived from a RE-READ of the
 * row on the same connection, in this fixed order, and never from the driver's
 * message: the message is prose that changes between server versions, the row
 * is the state the next pass will act on.
 *
 * A corrupt row throws `invalid_row` / `unsafe_bigint` from the mapper rather
 * than being reported as one of these reasons — a row this adapter cannot read
 * is a defect, not a lost race.
 */
const classifyCheckpointFailure = (
    state: RecordingRecoveryCheckpointState | null,
    expect: {
        owner: string;
        rowVersion: number;
        sweepGeneration?: number;
        previousCursor?: RecordingRecoveryCursor | null;
    },
    nowMs: number,
): RecordingRecoveryCheckpointFailure => {
    if (state === null) return 'row-missing';
    if (state.owner !== expect.owner) return 'stale-owner';
    if (state.rowVersion !== expect.rowVersion) return 'stale-version';
    if (expect.sweepGeneration !== undefined && state.sweepGeneration !== expect.sweepGeneration) {
        return 'stale-generation';
    }
    if (expect.previousCursor !== undefined && !sameCheckpointCursor(state.cursor, expect.previousCursor)) {
        return 'cursor-mismatch';
    }
    if (state.leaseExpiresAtMs !== null && state.leaseExpiresAtMs <= nowMs) return 'lease-expired';
    return 'unknown';
};

/** Claim has no expected version, so it only has to explain why it lost. */
const classifyClaimFailure = (
    state: RecordingRecoveryCheckpointState | null,
    owner: string,
    nowMs: number,
): RecordingRecoveryCheckpointFailure => {
    if (state === null) return 'row-missing';
    if (state.owner !== owner) return 'stale-owner';
    if (state.leaseExpiresAtMs !== null && state.leaseExpiresAtMs <= nowMs) return 'lease-expired';
    return 'unknown';
};

const isMissingTable = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    const sqlState = (error as { sqlState?: unknown }).sqlState;
    return errno === 1146 || code === 'ER_NO_SUCH_TABLE' || sqlState === '42S02';
};

const isMissingColumn = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    const sqlState = (error as { sqlState?: unknown }).sqlState;
    return errno === 1054 || code === 'ER_BAD_FIELD_ERROR' || sqlState === '42S22';
};

/**
 * Create the single row if it is absent and never touch an existing one: the
 * `ON DUPLICATE KEY UPDATE purpose = purpose` assignment is a no-op on purpose.
 * The lease CAS that follows is the only thing that can take the row, and it
 * takes it only when no owner holds a live lease.
 *
 * The re-read is inside the same unit as the CAS, so `claimed: true` is only
 * returned when the row this transaction can see names THIS owner — a 1-row
 * update that the same unit cannot confirm is not a claim.
 *
 * Only `checkpoint-absent` and `schema-unavailable` are caught. Every other
 * driver error is rethrown untouched: a broken connection is not a lost race.
 */
const claimCheckpoint = async (
    executor: RecordingIngestSqlExecutor,
    input: { owner: string; nowMs: number; leaseMs: number },
): Promise<RecordingRecoveryCheckpointClaim> => {
    const owner = requireCheckpointOwner(input.owner);
    const nowMs = requireEpochMs(input.nowMs, 'nowMs');
    const leaseExpiresAtMs = checkpointLeaseExpiry(nowMs, input.leaseMs);
    try {
        return await executor.transaction(async (conn) => {
            await conn.execute(
                `INSERT INTO live_recovery_checkpoints
                     (purpose, cursor_occurred_at_ms, cursor_id, owner, lease_expires_at_ms,
                      row_version, sweep_generation, updated_at_ms)
                 VALUES (?, NULL, NULL, ?, ?, 1, 0, ?)
                 ON DUPLICATE KEY UPDATE purpose = purpose`,
                [RECOVERY_CHECKPOINT_PURPOSE, owner, leaseExpiresAtMs, nowMs],
            );
            const update = await conn.execute(
                `UPDATE live_recovery_checkpoints
                    SET owner = ?, lease_expires_at_ms = ?, row_version = row_version + 1, updated_at_ms = ?
                  WHERE purpose = ?
                    AND (owner IS NULL OR lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)`,
                [owner, leaseExpiresAtMs, nowMs, RECOVERY_CHECKPOINT_PURPOSE, nowMs],
            );
            const row = await readCheckpointRow(conn);
            const state = row === null ? null : mapCheckpointRow(row);
            if (affectedOf(update) === 0 || state === null || state.owner !== owner) {
                return { claimed: false, state, reason: classifyClaimFailure(state, owner, nowMs) };
            }
            return { claimed: true, state, reason: null };
        });
    } catch (error) {
        if (isMissingTable(error)) return { claimed: false, state: null, reason: 'checkpoint-absent' };
        if (isMissingColumn(error)) return { claimed: false, state: null, reason: 'schema-unavailable' };
        throw error;
    }
};

/**
 * Advance the cursor by one inspected page. ONE statement; the expected owner,
 * row version, sweep generation and PREVIOUS cursor are all in the WHERE, and
 * the lease must still be live at `nowMs`. A cursor that moved for any reason
 * (another worker, a reset) therefore fails the match instead of being
 * overwritten.
 *
 * The previous-cursor clause is a NULL probe plus an equality because a first
 * page has no previous key: a NULL bind makes `? IS NULL` true and only the
 * "row has no cursor" arm can match; a non-NULL bind makes it false so the
 * equality arm decides.
 *
 * `row_version` changes on every win, so affected rows = 1 exactly when this
 * statement won (changed-rows semantics, see the file header). On 0 the row is
 * re-read on the same connection and classified.
 *
 * A missing table or column is returned as a reason with `advanced: false`
 * rather than thrown: the pass must stop and report, not fail.
 */
const advanceCheckpoint = async (
    executor: RecordingIngestSqlExecutor,
    input: {
        owner: string;
        expectedRowVersion: number;
        expectedGeneration: number;
        previousCursor: RecordingRecoveryCursor | null;
        nextCursor: RecordingRecoveryCursor;
        nowMs: number;
        leaseMs: number;
    },
): Promise<{ advanced: boolean; rowVersion: number | null; reason: RecordingRecoveryCheckpointFailure | null }> => {
    const owner = requireCheckpointOwner(input.owner);
    const nowMs = requireEpochMs(input.nowMs, 'nowMs');
    const leaseExpiresAtMs = checkpointLeaseExpiry(nowMs, input.leaseMs);
    const expectedRowVersion = requireCheckpointCounter(input.expectedRowVersion, 'expectedRowVersion', 1);
    const expectedGeneration = requireCheckpointCounter(input.expectedGeneration, 'expectedGeneration', 0);
    const previousCursor = input.previousCursor === null
        ? null
        : requireCheckpointCursor(input.previousCursor, 'previousCursor');
    const nextCursor = requireCheckpointCursor(input.nextCursor, 'nextCursor');
    const previousOccurredAtMs = previousCursor === null ? null : previousCursor.occurredAtMs;
    const previousId = previousCursor === null ? null : previousCursor.id;
    try {
        return await executor.transaction(async (conn) => {
            const update = await conn.execute(
                `UPDATE live_recovery_checkpoints
                    SET cursor_occurred_at_ms = ?, cursor_id = ?, row_version = row_version + 1,
                        lease_expires_at_ms = ?, updated_at_ms = ?
                  WHERE purpose = ?
                    AND owner = ?
                    AND row_version = ?
                    AND sweep_generation = ?
                    AND lease_expires_at_ms > ?
                    AND ((? IS NULL AND cursor_occurred_at_ms IS NULL AND cursor_id IS NULL)
                         OR (cursor_occurred_at_ms = ? AND cursor_id = ?))`,
                [
                    nextCursor.occurredAtMs,
                    nextCursor.id,
                    leaseExpiresAtMs,
                    nowMs,
                    RECOVERY_CHECKPOINT_PURPOSE,
                    owner,
                    expectedRowVersion,
                    expectedGeneration,
                    nowMs,
                    previousOccurredAtMs,
                    previousOccurredAtMs,
                    previousId,
                ],
            );
            const row = await readCheckpointRow(conn);
            const state = row === null ? null : mapCheckpointRow(row);
            if (affectedOf(update) === 0) {
                return {
                    advanced: false,
                    rowVersion: null,
                    reason: classifyCheckpointFailure(
                        state,
                        { owner, rowVersion: expectedRowVersion, sweepGeneration: expectedGeneration, previousCursor },
                        nowMs,
                    ),
                };
            }
            if (state === null) {
                return { advanced: false, rowVersion: null, reason: 'row-missing' };
            }
            return { advanced: true, rowVersion: state.rowVersion, reason: null };
        });
    } catch (error) {
        if (isMissingTable(error)) return { advanced: false, rowVersion: null, reason: 'checkpoint-absent' };
        if (isMissingColumn(error)) return { advanced: false, rowVersion: null, reason: 'schema-unavailable' };
        throw error;
    }
};

/**
 * Close one full sweep: clear the cursor and increment `sweep_generation` in
 * the SAME CAS. The expected owner, version, generation and previous cursor
 * are the values the page's advance would have used, so a reset can never land
 * on top of another worker's progress or on a cursor that moved since this pass
 * read it.
 */
const completeSweepCheckpoint = async (
    executor: RecordingIngestSqlExecutor,
    input: {
        owner: string;
        expectedRowVersion: number;
        expectedGeneration: number;
        previousCursor: RecordingRecoveryCursor | null;
        nowMs: number;
        leaseMs: number;
    },
): Promise<{
    completed: boolean;
    rowVersion: number | null;
    sweepGeneration: number | null;
    reason: RecordingRecoveryCheckpointFailure | null;
}> => {
    const owner = requireCheckpointOwner(input.owner);
    const nowMs = requireEpochMs(input.nowMs, 'nowMs');
    const leaseExpiresAtMs = checkpointLeaseExpiry(nowMs, input.leaseMs);
    const expectedRowVersion = requireCheckpointCounter(input.expectedRowVersion, 'expectedRowVersion', 1);
    const expectedGeneration = requireCheckpointCounter(input.expectedGeneration, 'expectedGeneration', 0);
    const previousCursor = input.previousCursor === null
        ? null
        : requireCheckpointCursor(input.previousCursor, 'previousCursor');
    const previousOccurredAtMs = previousCursor === null ? null : previousCursor.occurredAtMs;
    const previousId = previousCursor === null ? null : previousCursor.id;
    try {
        return await executor.transaction(async (conn) => {
            const update = await conn.execute(
                `UPDATE live_recovery_checkpoints
                    SET cursor_occurred_at_ms = NULL, cursor_id = NULL,
                        sweep_generation = sweep_generation + 1, row_version = row_version + 1,
                        lease_expires_at_ms = ?, updated_at_ms = ?
                  WHERE purpose = ?
                    AND owner = ?
                    AND row_version = ?
                    AND sweep_generation = ?
                    AND lease_expires_at_ms > ?
                    AND ((? IS NULL AND cursor_occurred_at_ms IS NULL AND cursor_id IS NULL)
                         OR (cursor_occurred_at_ms = ? AND cursor_id = ?))`,
                [
                    leaseExpiresAtMs,
                    nowMs,
                    RECOVERY_CHECKPOINT_PURPOSE,
                    owner,
                    expectedRowVersion,
                    expectedGeneration,
                    nowMs,
                    previousOccurredAtMs,
                    previousOccurredAtMs,
                    previousId,
                ],
            );
            const row = await readCheckpointRow(conn);
            const state = row === null ? null : mapCheckpointRow(row);
            if (affectedOf(update) === 0) {
                return {
                    completed: false,
                    rowVersion: null,
                    sweepGeneration: null,
                    reason: classifyCheckpointFailure(
                        state,
                        { owner, rowVersion: expectedRowVersion, sweepGeneration: expectedGeneration, previousCursor },
                        nowMs,
                    ),
                };
            }
            if (state === null) {
                return { completed: false, rowVersion: null, sweepGeneration: null, reason: 'row-missing' };
            }
            return {
                completed: true,
                rowVersion: state.rowVersion,
                sweepGeneration: state.sweepGeneration,
                reason: null,
            };
        });
    } catch (error) {
        if (isMissingTable(error)) {
            return { completed: false, rowVersion: null, sweepGeneration: null, reason: 'checkpoint-absent' };
        }
        if (isMissingColumn(error)) {
            return { completed: false, rowVersion: null, sweepGeneration: null, reason: 'schema-unavailable' };
        }
        throw error;
    }
};

/**
 * Hand the row back. Owner and expiry are cleared together and `row_version`
 * increments, so a release is a real state change and reports 1 exactly when
 * it happened.
 *
 * An expired lease or a foreign owner simply matches 0 rows: this is a
 * release, not a renewal, and it must never extend a lease it no longer holds.
 * 0 is classified like every other CAS — by the re-read — and `released: false`
 * is the correct answer there, not an error.
 */
const releaseCheckpoint = async (
    executor: RecordingIngestSqlExecutor,
    input: { owner: string; expectedRowVersion: number; nowMs: number },
): Promise<{ released: boolean; reason: RecordingRecoveryCheckpointFailure | null }> => {
    const owner = requireCheckpointOwner(input.owner);
    const nowMs = requireEpochMs(input.nowMs, 'nowMs');
    const expectedRowVersion = requireCheckpointCounter(input.expectedRowVersion, 'expectedRowVersion', 1);
    try {
        return await executor.transaction(async (conn) => {
            const update = await conn.execute(
                `UPDATE live_recovery_checkpoints
                    SET owner = NULL, lease_expires_at_ms = NULL, row_version = row_version + 1, updated_at_ms = ?
                  WHERE purpose = ? AND owner = ? AND row_version = ? AND lease_expires_at_ms > ?`,
                [nowMs, RECOVERY_CHECKPOINT_PURPOSE, owner, expectedRowVersion, nowMs],
            );
            if (affectedOf(update) === 1) return { released: true, reason: null };
            const row = await readCheckpointRow(conn);
            const state = row === null ? null : mapCheckpointRow(row);
            return {
                released: false,
                reason: classifyCheckpointFailure(state, { owner, rowVersion: expectedRowVersion }, nowMs),
            };
        });
    } catch (error) {
        if (isMissingTable(error)) return { released: false, reason: 'checkpoint-absent' };
        if (isMissingColumn(error)) return { released: false, reason: 'schema-unavailable' };
        throw error;
    }
};

/** Diagnostics: one SELECT, no unit, no write. */
const readCheckpoint = async (
    executor: RecordingIngestSqlExecutor,
    nowMs: number,
): Promise<RecordingRecoveryCheckpointSnapshot | null> => {
    const atMs = requireEpochMs(nowMs, 'nowMs');
    try {
        const row = await readCheckpointRow(executor);
        if (row === null) return null;
        const state = mapCheckpointRow(row);
        return {
            state,
            updatedAtMs: readSafeInteger(row.updated_at_ms, 'live_recovery_checkpoints.updated_at_ms'),
            leaseActive: state.owner !== null
                && state.leaseExpiresAtMs !== null
                && state.leaseExpiresAtMs > atMs,
        };
    } catch (error) {
        if (isMissingTable(error) || isMissingColumn(error)) return null;
        throw error;
    }
};

class RecordingCheckpointSqlStoreImpl implements RecordingRecoveryCheckpointStore {
    readonly purpose: typeof RECOVERY_CHECKPOINT_PURPOSE = RECOVERY_CHECKPOINT_PURPOSE;

    constructor(private readonly deps: { executor: RecordingIngestSqlExecutor }) {
        if (!deps || typeof deps !== 'object' || !deps.executor || typeof deps.executor !== 'object') {
            throw new RecordingIngestSqlError(
                'invalid_deps',
                'createRecordingCheckpointSqlStore requires a connection-bound executor',
            );
        }
        const { executor } = deps;
        if (typeof executor.query !== 'function'
            || typeof executor.queryOne !== 'function'
            || typeof executor.execute !== 'function'
            || typeof executor.transaction !== 'function') {
            throw new RecordingIngestSqlError(
                'invalid_deps',
                'the executor must provide query, queryOne, execute and transaction on ONE connection',
            );
        }
        // A caller-supplied purpose would create a second independent scan of
        // the same workset, which is exactly what the fixed key prevents.
        if ('purpose' in deps) {
            throw new RecordingIngestSqlError(
                'invalid_deps',
                'the checkpoint purpose is server-owned and cannot be overridden at construction',
            );
        }
    }

    claim(input: { owner: string; nowMs: number; leaseMs: number }): Promise<RecordingRecoveryCheckpointClaim> {
        return claimCheckpoint(this.deps.executor, input);
    }

    advance(input: {
        owner: string;
        expectedRowVersion: number;
        expectedGeneration: number;
        previousCursor: RecordingRecoveryCursor | null;
        nextCursor: RecordingRecoveryCursor;
        nowMs: number;
        leaseMs: number;
    }): Promise<{ advanced: boolean; rowVersion: number | null; reason: RecordingRecoveryCheckpointFailure | null }> {
        return advanceCheckpoint(this.deps.executor, input);
    }

    completeSweep(input: {
        owner: string;
        expectedRowVersion: number;
        expectedGeneration: number;
        previousCursor: RecordingRecoveryCursor | null;
        nowMs: number;
        leaseMs: number;
    }): Promise<{
        completed: boolean;
        rowVersion: number | null;
        sweepGeneration: number | null;
        reason: RecordingRecoveryCheckpointFailure | null;
    }> {
        return completeSweepCheckpoint(this.deps.executor, input);
    }

    release(input: {
        owner: string;
        expectedRowVersion: number;
        nowMs: number;
    }): Promise<{ released: boolean; reason: RecordingRecoveryCheckpointFailure | null }> {
        return releaseCheckpoint(this.deps.executor, input);
    }

    read(nowMs: number): Promise<RecordingRecoveryCheckpointSnapshot | null> {
        return readCheckpoint(this.deps.executor, nowMs);
    }
}

/**
 * Build the checkpoint store. It takes an executor and nothing else: there is
 * no purpose parameter to pass and no fallback executor to fall back to.
 */
export const createRecordingCheckpointSqlStore = (deps: {
    executor: RecordingIngestSqlExecutor;
}): RecordingRecoveryCheckpointStore => new RecordingCheckpointSqlStoreImpl(deps);

