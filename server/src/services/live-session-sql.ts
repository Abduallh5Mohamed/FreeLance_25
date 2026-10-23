/**
 * WL-P2 — durable `LiveSessionStore` over injected, connection-bound SQL.
 *
 * Implements the port in `live-session-core.ts` against the four live tables of
 * migration `20261022_06_live_sessions_recordings.sql` (read-only ground truth,
 * no DDL here):
 *
 *   live_sessions, live_session_participants, live_session_callbacks,
 *   live_session_presence_intervals (via `live-presence-sql.ts`).
 *
 * SOURCE ONLY. No connection is opened, no pool is imported, no statement runs
 * at import time and there is no top-level side effect. The caller injects an
 * executor whose `transaction` hands back ONE connection; every statement of a
 * unit is issued on that connection. A missing executor or a missing sealed
 * audit writer throws AT CONSTRUCTION — there is no pooled fallback, no
 * autocommit path and no `INSERT INTO audit_events` shortcut.
 *
 * Guarantees this file is written to provide (and cannot prove without a
 * database — see the report):
 *  - one unit per mutation: `withTransaction` is mandatory and every mutating
 *    store method runs inside it, so a caller can never write outside a unit;
 *  - tenant predicate on every lookup and every write, the single exception
 *    being `findSessionByProvider(provider, providerRoomId)` — a callback
 *    carries no caller tenant, so the tenant is read FROM the row and the core
 *    treats that row as the authority;
 *  - admission locks the SESSION row (`FOR UPDATE`), then counts
 *    `COUNT(DISTINCT user_id) WHERE left_at_ms IS NULL` inside the lock, then
 *    inserts or refreshes. A rejoin refreshes the existing `UNIQUE
 *    (session_id, user_id)` row instead of taking a second seat;
 *  - CAS + affected rows are checked before success is reported:
 *    `updateSessionState` is `WHERE id = ? AND tenant_id = ? AND state = ?`,
 *    `finalizeCallback` is `WHERE id = ? AND tenant_id = ? AND outcome =
 *    'pending'`, and neither ever reports success on 0 rows;
 *  - `ended_at_ms` is written in the SAME statement as `state` and is non-NULL
 *    iff the new state is `ended` (chk_live_session_ended), so a transition
 *    away always clears it;
 *  - callback outcomes are restricted to the R23 CHECK enum before they reach
 *    the driver: 'pending' | 'applied' | 'rejected:illegal-transition' |
 *    'ignored:unknown-participant' | 'ignored:malformed' |
 *    'ignored:mapping-unavailable' | 'ignored:ordering-unavailable' |
 *    'ignored:stale-event' | 'ignored:ambiguous-event';
 *  - the sealed audit append runs on the unit's own connection: the object
 *    handed to the writer has NO `transaction` property, which is
 *    `recordSealedAuditEvent`'s documented "caller is already on one
 *    transactional connection" path.
 *
 * BIGINT safety: `starts_at_ms`, `ended_at_ms`, `joined_at_ms`, `last_seen_at_ms`
 * and `left_at_ms` are BIGINT and mysql2 returns them as strings by default.
 * Every value is validated as an exact integer string and range-checked against
 * `Number.MAX_SAFE_INTEGER` BEFORE conversion; an unsafe value throws a bounded
 * `LiveSessionSqlError` instead of being silently truncated. Required mysql2
 * options for production binding: `supportBigNumbers: true`,
 * `bigNumberStrings: true`.
 *
 * MySQL note: single-table UPDATE assignments are evaluated left to right using
 * ALREADY-UPDATED values. The participant refresh therefore assigns
 * `joined_at_ms` BEFORE `left_at_ms`, otherwise `IF(left_at_ms IS NULL, ...)`
 * would read the value this same statement just wrote.
 *
 * HELD SCHEMA — presence event cursor (R22). `live_session_participants` has no
 * column that says WHICH event last moved the row, so the cursor ports are
 * implemented here but GATED: the unit only carries `readPresenceCursor` /
 * `advancePresenceCursor` when the composition declares
 * `presenceCursor: 'declared'`, i.e. attests that
 * `server/migrations/20261023_02_live_callback_presence_contract.sql` is applied.
 * The default is `'unconfigured'`, in which case the methods are ABSENT and the
 * core fails closed with `ignored:ordering-unavailable` — ordered callbacks are
 * never enabled silently. Required schema (request only — no DDL here):
 *
 *   ALTER TABLE live_session_participants
 *     ADD COLUMN presence_event_at_ms BIGINT NULL,
 *     ADD COLUMN presence_event_id    VARCHAR(128) NULL,
 *     ADD CONSTRAINT chk_live_participant_presence_cursor
 *       CHECK ((presence_event_at_ms IS NULL) = (presence_event_id IS NULL));
 *
 * Even when declared, the columns are checked at runtime: a driver
 * `ER_BAD_FIELD_ERROR` (1054 / SQLSTATE 42S22) on either statement is rethrown
 * as the typed `schema_unavailable`, which propagates out of the unit so the
 * whole callback rolls back. A missing column is never reported as "no cursor"
 * and never as an ordering decision.
 *
 * HELD SCHEMA — callback outcomes (R23). `chk_live_callback_outcome` must admit
 * the four new terminal outcomes. The TypeScript list above is the agreed
 * contract; if the database still enforces the old CHECK, the driver raises
 * `ER_CHECK_CONSTRAINT_VIOLATED` (3819) and this adapter rethrows it as
 * `schema_unavailable` naming R23 — again with a rollback and no state change.
 * The enum is never widened at the TypeScript level without the database, and
 * never narrowed by guessing the prior CHECK shape.
 */

import type { AuditRecordInput } from '../security/audit';
import type { AuditLogDataAccess, SealedAuditRecordInput } from './audit-log';
import {
    LIVE_CALLBACK_KINDS,
    MAX_PARTICIPANTS_CEILING,
    normalizeLiveSessionState,
    normalizeParticipantRole,
    type ClosePresenceIntervalInput,
    type ClosePresenceIntervalResult,
    type AdvancePresenceCursorInput,
    type LiveCallbackRow,
    type LiveParticipantRecord,
    type LiveSessionRecord,
    type LiveSessionState,
    type LiveSessionStore,
    type LiveSessionUnit,
    type NewLiveSession,
    type OpenPresenceIntervalInput,
    type OpenPresenceIntervalResult,
    type ParticipantAdmission,
    type ParticipantAdmissionInput,
    type PresenceEventCursor,
    type PresenceIntervalRecord,
} from './live-session-core';
import { createLivePresenceSqlMethods } from './live-presence-sql';

/* =========================================================================
 * Injected ports
 * ========================================================================= */

/**
 * ONE connection. It is structurally assignable to `AuditLogDataAccess`
 * (`query` / `queryOne` / `execute`, no `transaction`), which is exactly what
 * the sealed writer needs.
 */
export interface LiveSessionSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    queryOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
    /**
     * `affectedRows` MUST be a number (mysql2 OkPacket). A driver that returns
     * a string is adapted by the caller, not guessed here: an unreadable count
     * is reported as 0, never as success.
     */
    execute(sql: string, params?: readonly unknown[]): Promise<{ affectedRows?: number; insertId?: number }>;
}

/**
 * The transaction runner. `transaction` must BEGIN/COMMIT on one pooled
 * connection, ROLLBACK and rethrow on a throw, and hand that same connection to
 * `work`. This adapter never owns a pool and never retries.
 */
export interface LiveSessionSqlExecutor extends LiveSessionSqlConnection {
    transaction<T>(work: (conn: LiveSessionSqlConnection) => Promise<T>): Promise<T>;
}

/** `recordSealedAuditEvent` is structurally this signature. */
export type SealedAuditWriter = (db: AuditLogDataAccess, input: SealedAuditRecordInput) => Promise<void>;

/**
 * Whether the composition has attested that the R22 columns exist.
 *
 * `'unconfigured'` (the default) means the unit does NOT carry the cursor ports,
 * so the core refuses participant callbacks with `ignored:ordering-unavailable`
 * and changes no state. `'declared'` is a composition-time attestation, not a
 * probe: this adapter never queries the catalog at import time, and even when
 * declared a missing column still fails closed at runtime with
 * `schema_unavailable` and a rollback.
 */
export type PresenceCursorReadiness = 'unconfigured' | 'declared';

export interface LiveSessionSqlDeps {
    executor: LiveSessionSqlExecutor;
    /** Required. A factory without it refuses to build — never a no-op. */
    sealedAudit: SealedAuditWriter;
    /**
     * Default `'unconfigured'`. Set to `'declared'` only when
     * `server/migrations/20261023_02_live_callback_presence_contract.sql` is
     * applied; ordered callbacks are never enabled without that attestation.
     */
    presenceCursor?: PresenceCursorReadiness;
}

/**
 * Compile-time proof (emits nothing) that the connection port can drive the
 * sealed writer through `AuditLogDataAccess`. If the two ever drift, this file
 * stops compiling instead of silently losing the sealed append.
 */
type AssertAssignable<T extends U, U> = T;
export type ConnectionIsAuditDataAccess = AssertAssignable<LiveSessionSqlConnection, AuditLogDataAccess>;

export type LiveSessionSqlErrorCode =
    | 'invalid_deps'
    | 'invalid_input'
    | 'invalid_row'
    | 'unsafe_bigint'
    | 'tenant_required'
    | 'invalid_outcome'
    | 'write_conflict'
    /**
     * The database does not carry the R22 columns or the R23 CHECK. Raised only
     * from a driver error code (1054/42S22, 3819) and only so the caller sees an
     * explicit capability gap instead of an opaque driver failure. It is always
     * thrown INSIDE a unit, so the transaction rolls back and nothing is
     * persisted — never a silent downgrade to unordered callbacks.
     */
    | 'schema_unavailable';

export class LiveSessionSqlError extends Error {
    constructor(public readonly code: LiveSessionSqlErrorCode, message: string) {
        super(message);
        this.name = 'LiveSessionSqlError';
    }
}

/* =========================================================================
 * Bounds, enums, helpers
 * ========================================================================= */

const SESSION_COLUMNS = `id, tenant_id, host_user_id, title, state, provider, provider_room_id,
       starts_at_ms, ended_at_ms, max_participants, created_at_ms`;

const PARTICIPANT_COLUMNS = `id, tenant_id, session_id, user_id, role, ticket_fingerprint,
       joined_at_ms, last_seen_at_ms, left_at_ms`;

/**
 * Exactly the R23 `chk_live_callback_outcome` enum on
 * `live_session_callbacks.outcome`. The four `ignored:*` values the L2/L3
 * corrections introduced are part of the agreed contract; a database that still
 * enforces the old CHECK raises 3819, which `finalizeCallbackRow` maps to the
 * typed `schema_unavailable` (rollback, no state change) instead of letting a
 * driver error surface as an unexplained failure. Narrowing this list again
 * would move the refusal back into TypeScript and hide the schema gap.
 */
const CALLBACK_OUTCOMES = [
    'pending',
    'applied',
    'rejected:illegal-transition',
    'ignored:unknown-participant',
    'ignored:malformed',
    'ignored:mapping-unavailable',
    'ignored:ordering-unavailable',
    'ignored:stale-event',
    'ignored:ambiguous-event',
] as const;

type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number];

const TERMINAL_OUTCOMES: readonly CallbackOutcome[] = CALLBACK_OUTCOMES.filter(
    (outcome): outcome is Exclude<CallbackOutcome, 'pending'> => outcome !== 'pending',
);

const INTEGER_TEXT = /^-?\d+$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

interface LiveSessionRow {
    id: string;
    tenant_id: string;
    host_user_id: string;
    title: string;
    state: string;
    provider: string | null;
    provider_room_id: string | null;
    starts_at_ms: number | string;
    ended_at_ms: number | string | null;
    max_participants: number | string;
    created_at_ms: number | string;
}

interface LiveParticipantRow {
    id: string;
    tenant_id: string;
    session_id: string;
    user_id: string;
    role: string;
    ticket_fingerprint: string;
    joined_at_ms: number | string;
    last_seen_at_ms: number | string;
    left_at_ms: number | string | null;
}

/** Exact integer -> number. Never `Number()` on an unchecked string. */
const readSafeInteger = (value: unknown, field: string): number => {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new LiveSessionSqlError('unsafe_bigint', `${field} is outside the safe integer range`);
        }
        return value;
    }
    if (typeof value === 'string') {
        const text = value.trim();
        if (!INTEGER_TEXT.test(text)) {
            throw new LiveSessionSqlError('unsafe_bigint', `${field} is not an exact integer string`);
        }
        const parsed = BigInt(text);
        if (parsed > MAX_SAFE || parsed < MIN_SAFE) {
            throw new LiveSessionSqlError('unsafe_bigint', `${field} is outside the safe integer range`);
        }
        return Number(parsed);
    }
    throw new LiveSessionSqlError('invalid_row', `${field} is not an integer`);
};

const readNullableInteger = (value: unknown, field: string): number | null =>
    value === null || value === undefined ? null : readSafeInteger(value, field);

const readBoundedInteger = (value: unknown, field: string, min: number, max: number): number => {
    const parsed = readSafeInteger(value, field);
    if (parsed < min || parsed > max) {
        throw new LiveSessionSqlError('invalid_row', `${field} is outside [${min}, ${max}]`);
    }
    return parsed;
};

/** Write-side guard: the unit only ever passes numbers, never a string. */
const requireEpochMs = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new LiveSessionSqlError('invalid_input', `${field} must be a safe integer epoch in milliseconds`);
    }
    return value;
};

const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new LiveSessionSqlError('invalid_input', `${field} is required`);
    }
    return value;
};

/** `CHAR(36)` bound shared by the id columns this adapter reads. */
const MAX_CHAR36_ID_LENGTH = 36;

/**
 * Read a `CHAR(36)` id without ever truncating it. A value that cannot be
 * represented in the column — not a string, empty after trimming, or longer
 * than 36 — becomes `null`; a truncated id would name a DIFFERENT row or
 * principal, which is worse than admitting the row is unusable.
 */
const readChar36Id = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_CHAR36_ID_LENGTH ? trimmed : null;
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
 * The R22 columns are absent. 1054 = ER_BAD_FIELD_ERROR, SQLSTATE 42S22.
 * Deliberately narrow: any other driver error is rethrown untouched, so a
 * connection fault is never mislabelled as a missing migration.
 */
const isMissingColumn = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    const sqlState = (error as { sqlState?: unknown }).sqlState;
    return code === 'ER_BAD_FIELD_ERROR' || errno === 1054 || sqlState === '42S22';
};

/** The R23 CHECK is absent. 3819 = ER_CHECK_CONSTRAINT_VIOLATED. */
const isCheckConstraintViolation = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_CHECK_CONSTRAINT_VIOLATED' || errno === 3819;
};

/**
 * `presence_event_id` is `VARCHAR(128)` and the cursor identity is BYTE-EXACT:
 * the value is never trimmed, lower-cased or re-encoded. A trimmed event id
 * names a different event, which would silently reorder presence. The bound is
 * the column width, and an over-long id is refused rather than truncated.
 *
 * The DB-side half of this guarantee is measured by
 * `classifyPresenceEventIdIdentity`: the column must be `utf8mb4_0900_bin`
 * (NO PAD) for the stored bytes to stay distinct, so `'evt-1'` and `'evt-1 '`
 * remain two identities. Trimming or normalising here would defeat that — the
 * value sent to the database would no longer be the value the caller supplied.
 */
const MAX_PRESENCE_EVENT_ID_LENGTH = 128;

const requirePresenceEventId = (
    value: unknown,
    field: string,
    code: LiveSessionSqlErrorCode = 'invalid_input',
): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new LiveSessionSqlError(code, `${field} is required`);
    }
    if (value.length > MAX_PRESENCE_EVENT_ID_LENGTH) {
        throw new LiveSessionSqlError(
            code,
            `${field} exceeds VARCHAR(${MAX_PRESENCE_EVENT_ID_LENGTH}); refusing to truncate an event identity`,
        );
    }
    return value;
};

const normalizeOutcome = (value: unknown, options: { allowPending: boolean }): CallbackOutcome => {
    const allowed: readonly string[] = options.allowPending ? CALLBACK_OUTCOMES : TERMINAL_OUTCOMES;
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new LiveSessionSqlError('invalid_outcome', `callback outcome "${String(value)}" is outside the CHECK enum`);
    }
    return value as CallbackOutcome;
};

const mapSession = (row: LiveSessionRow): LiveSessionRecord => {
    const state = normalizeLiveSessionState(row.state);
    if (!state) {
        throw new LiveSessionSqlError('invalid_row', `live_sessions.state "${String(row.state)}" is not a known state`);
    }
    const endedAtMs = readNullableInteger(row.ended_at_ms, 'live_sessions.ended_at_ms');
    // Mirrors chk_live_session_ended: ended_at_ms is non-NULL iff state='ended'.
    if ((state === 'ended') !== (endedAtMs !== null)) {
        throw new LiveSessionSqlError('invalid_row', 'live_sessions row breaks the state/ended_at_ms invariant');
    }
    return {
        id: row.id,
        tenantId: row.tenant_id,
        // Host travels with every session read: the recording ingest needs it
        // as the `video_assets.owner_user_id` candidate, and a value the
        // column cannot hold is reported as null rather than truncated.
        hostUserId: readChar36Id(row.host_user_id),
        title: row.title,
        state,
        provider: row.provider,
        providerRoomId: row.provider_room_id,
        startsAtMs: readSafeInteger(row.starts_at_ms, 'live_sessions.starts_at_ms'),
        endedAtMs,
        // Mirrors chk_live_session_max_participants (1..5000).
        maxParticipants: readBoundedInteger(
            row.max_participants,
            'live_sessions.max_participants',
            1,
            MAX_PARTICIPANTS_CEILING,
        ),
        createdAtMs: readSafeInteger(row.created_at_ms, 'live_sessions.created_at_ms'),
    };
};

const mapParticipant = (row: LiveParticipantRow): LiveParticipantRecord => {
    const role = normalizeParticipantRole(row.role);
    if (!role) {
        throw new LiveSessionSqlError('invalid_row', `live_session_participants.role "${String(row.role)}" is not a known role`);
    }
    return {
        id: row.id,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        userId: row.user_id,
        role,
        ticketFingerprint: row.ticket_fingerprint,
        joinedAtMs: readSafeInteger(row.joined_at_ms, 'live_session_participants.joined_at_ms'),
        lastSeenAtMs: readSafeInteger(row.last_seen_at_ms, 'live_session_participants.last_seen_at_ms'),
        leftAtMs: readNullableInteger(row.left_at_ms, 'live_session_participants.left_at_ms'),
    };
};

/* =========================================================================
 * live_sessions
 * ========================================================================= */

const insertSessionRow = async (conn: LiveSessionSqlConnection, row: NewLiveSession): Promise<void> => {
    const startsAtMs = requireEpochMs(row.startsAtMs, 'startsAtMs');
    const createdAtMs = requireEpochMs(row.createdAtMs, 'createdAtMs');
    if (!Number.isSafeInteger(row.maxParticipants)
        || row.maxParticipants < 1
        || row.maxParticipants > MAX_PARTICIPANTS_CEILING) {
        throw new LiveSessionSqlError(
            'invalid_input',
            `maxParticipants must be within [1, ${MAX_PARTICIPANTS_CEILING}] (chk_live_session_max_participants)`,
        );
    }
    // state='scheduled' with ended_at_ms NULL satisfies chk_live_session_ended.
    // The unique key (provider, provider_room_id) and the tenant FK are the
    // database's job: a violation throws and the whole unit rolls back.
    await conn.execute(
        `INSERT INTO live_sessions
             (id, tenant_id, host_user_id, title, state, provider, provider_room_id,
              starts_at_ms, ended_at_ms, max_participants, created_at_ms)
         VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, NULL, ?, ?)`,
        [
            row.id,
            row.tenantId,
            row.hostUserId,
            row.title,
            row.provider,
            row.providerRoomId,
            startsAtMs,
            row.maxParticipants,
            createdAtMs,
        ],
    );
};

/** Tenant-scoped read: a cross-tenant id resolves to null, never to a row. */
const findSessionRow = async (
    conn: LiveSessionSqlConnection,
    id: string,
    tenantId: string,
): Promise<LiveSessionRecord | null> => {
    const row = await conn.queryOne<LiveSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM live_sessions WHERE id = ? AND tenant_id = ? LIMIT 1`,
        [id, tenantId],
    );
    return row ? mapSession(row) : null;
};

/**
 * The ONLY tenant-less read, by design: a provider callback carries no caller
 * tenant. `uq_live_session_room (provider, provider_room_id)` makes the pair
 * unique, and the tenant used afterwards comes from the returned row — never
 * from the callback payload.
 */
const findSessionByProviderRow = async (
    conn: LiveSessionSqlConnection,
    provider: string,
    providerRoomId: string,
): Promise<LiveSessionRecord | null> => {
    if (typeof provider !== 'string' || provider.length === 0
        || typeof providerRoomId !== 'string' || providerRoomId.length === 0) {
        return null;
    }
    const row = await conn.queryOne<LiveSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM live_sessions
          WHERE provider = ? AND provider_room_id = ?
          LIMIT 1`,
        [provider, providerRoomId],
    );
    return row ? mapSession(row) : null;
};

/**
 * CAS on the current state. `ended_at_ms` is written in the same statement:
 * non-NULL exactly when the next state is `ended`, NULL for every transition
 * away (chk_live_session_ended). Returns affected rows; 0 means the state moved
 * and the caller must not report success.
 */
const updateSessionStateRow = async (
    conn: LiveSessionSqlConnection,
    id: string,
    tenantId: string,
    expectedState: LiveSessionState,
    nextState: LiveSessionState,
    endedAtMs: number | null,
): Promise<number> => {
    const expected = normalizeLiveSessionState(expectedState);
    const next = normalizeLiveSessionState(nextState);
    if (!expected || !next) {
        throw new LiveSessionSqlError('invalid_input', 'session state is outside the ENUM');
    }
    if (next === 'ended' && endedAtMs === null) {
        throw new LiveSessionSqlError('invalid_input', 'a transition to ended requires endedAtMs');
    }
    const endedValue = next === 'ended' ? requireEpochMs(endedAtMs, 'endedAtMs') : null;
    const result = await conn.execute(
        `UPDATE live_sessions
            SET state = ?, ended_at_ms = ?
          WHERE id = ? AND tenant_id = ? AND state = ?`,
        [next, endedValue, id, tenantId, expected],
    );
    return affectedOf(result);
};

/* =========================================================================
 * live_session_participants
 * ========================================================================= */

const countActiveUsers = async (
    conn: LiveSessionSqlConnection,
    sessionId: string,
    tenantId: string,
): Promise<number> => {
    const rows = await conn.query<{ active_count: number | string }>(
        `SELECT COUNT(DISTINCT user_id) AS active_count
           FROM live_session_participants
          WHERE session_id = ? AND tenant_id = ? AND left_at_ms IS NULL`,
        [sessionId, tenantId],
    );
    return readBoundedInteger(rows[0]?.active_count ?? 0, 'active_count', 0, Number.MAX_SAFE_INTEGER);
};

interface ParticipantPresenceRow {
    id: string;
    left_at_ms: number | string | null;
}

const findParticipantRow = async (
    conn: LiveSessionSqlConnection,
    sessionId: string,
    userId: string,
    tenantId: string,
): Promise<ParticipantPresenceRow | null> => {
    // Deliberately NOT a locking read: the caller holds the SESSION row lock,
    // which already serialises every participant write of this session
    // (contract §3 lock order: session row first, then its participant rows).
    const rows = await conn.query<ParticipantPresenceRow>(
        `SELECT id, left_at_ms FROM live_session_participants
          WHERE session_id = ? AND user_id = ? AND tenant_id = ?
          LIMIT 1`,
        [sessionId, userId, tenantId],
    );
    return rows[0] ?? null;
};

/**
 * Refresh an existing participant row.
 *
 * `joined_at_ms` keeps its original value while the row is active and takes the
 * new join time when the row had already left — a rejoin starts a new interval.
 * The SET order is deliberate: MySQL evaluates assignments left to right using
 * updated values, so `left_at_ms` must be assigned AFTER the `IF` that reads it.
 */
const refreshParticipantRow = async (
    conn: LiveSessionSqlConnection,
    input: {
        sessionId: string;
        userId: string;
        tenantId: string;
        role: string;
        ticketFingerprint: string;
        lastSeenAtMs: number;
        joinedAtMs: number;
        leftAtMs: number | null;
    },
): Promise<number> => {
    const result = await conn.execute(
        `UPDATE live_session_participants
            SET role = ?,
                ticket_fingerprint = ?,
                last_seen_at_ms = ?,
                joined_at_ms = IF(left_at_ms IS NULL, joined_at_ms, ?),
                left_at_ms = ?
          WHERE session_id = ? AND user_id = ? AND tenant_id = ?`,
        [
            input.role,
            input.ticketFingerprint,
            input.lastSeenAtMs,
            input.joinedAtMs,
            input.leftAtMs,
            input.sessionId,
            input.userId,
            input.tenantId,
        ],
    );
    return affectedOf(result);
};

const insertParticipantRow = async (
    conn: LiveSessionSqlConnection,
    input: {
        id: string;
        tenantId: string;
        sessionId: string;
        userId: string;
        role: string;
        ticketFingerprint: string;
        joinedAtMs: number;
        lastSeenAtMs: number;
        leftAtMs: number | null;
    },
): Promise<void> => {
    await conn.execute(
        `INSERT INTO live_session_participants
             (id, tenant_id, session_id, user_id, role, ticket_fingerprint,
              joined_at_ms, last_seen_at_ms, left_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            input.id,
            input.tenantId,
            input.sessionId,
            input.userId,
            input.role,
            input.ticketFingerprint,
            input.joinedAtMs,
            input.lastSeenAtMs,
            input.leftAtMs,
        ],
    );
};

/**
 * Serialised capacity admission.
 *
 *  1. lock the SESSION row (not the participants);
 *  2. count DISTINCT active user ids AFTER the lock;
 *  3. decide; refresh the existing `UNIQUE (session_id, user_id)` row or insert.
 *
 * A rejoin therefore never consumes a second seat: the same row is refreshed
 * and `created` is false. `activeCount` is the number of DISTINCT active users
 * after the decision — never rows, never joins.
 */
const admitParticipantRow = async (
    conn: LiveSessionSqlConnection,
    input: ParticipantAdmissionInput,
): Promise<ParticipantAdmission> => {
    const tenantId = requireText(input.tenantId, 'tenantId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const userId = requireText(input.userId, 'userId');
    const role = normalizeParticipantRole(input.role);
    if (!role) throw new LiveSessionSqlError('invalid_input', 'participant role is outside the ENUM');
    const atMs = requireEpochMs(input.atMs, 'atMs');

    const sessions = await conn.query<{ id: string; state: string; max_participants: number | string }>(
        `SELECT id, state, max_participants FROM live_sessions
          WHERE id = ? AND tenant_id = ?
          FOR UPDATE`,
        [sessionId, tenantId],
    );
    const session = sessions[0];
    if (!session) {
        return { admitted: false, reason: 'session-not-found', activeCount: 0, maxParticipants: 0 };
    }
    // `live` is the only admissible state: the core refuses scheduled/ended/
    // cancelled before calling, and this adapter must not admit into a state
    // the core would then have to undo.
    if (normalizeLiveSessionState(session.state) !== 'live') {
        return { admitted: false, reason: 'session-not-found', activeCount: 0, maxParticipants: 0 };
    }
    const maxParticipants = readBoundedInteger(
        session.max_participants,
        'live_sessions.max_participants',
        1,
        MAX_PARTICIPANTS_CEILING,
    );

    const activeCount = await countActiveUsers(conn, sessionId, tenantId);
    const existing = await findParticipantRow(conn, sessionId, userId, tenantId);

    if (existing) {
        const wasActive = existing.left_at_ms === null;
        if (!wasActive && activeCount >= maxParticipants) {
            return { admitted: false, reason: 'session-full', activeCount, maxParticipants };
        }
        const affected = await refreshParticipantRow(conn, {
            sessionId,
            userId,
            tenantId,
            role,
            ticketFingerprint: requireText(input.ticketFingerprint, 'ticketFingerprint'),
            lastSeenAtMs: atMs,
            joinedAtMs: atMs,
            leftAtMs: null,
        });
        if (affected === 0) {
            // 0 changed rows is a legitimate no-op (an active row refreshed in
            // the same millisecond). It is only a failure if the row is gone,
            // which the session lock makes impossible — verify rather than
            // assume, and never report an admission that wrote nothing.
            const still = await findParticipantRow(conn, sessionId, userId, tenantId);
            if (!still) {
                throw new LiveSessionSqlError('write_conflict', 'participant row disappeared during admission');
            }
        }
        return {
            admitted: true,
            created: false,
            participantId: existing.id,
            activeCount: wasActive ? activeCount : activeCount + 1,
            maxParticipants,
        };
    }

    if (activeCount >= maxParticipants) {
        return { admitted: false, reason: 'session-full', activeCount, maxParticipants };
    }

    const participantId = requireText(input.id, 'id');
    const ticketFingerprint = requireText(input.ticketFingerprint, 'ticketFingerprint');
    try {
        await insertParticipantRow(conn, {
            id: participantId,
            tenantId,
            sessionId,
            userId,
            role,
            ticketFingerprint,
            joinedAtMs: atMs,
            lastSeenAtMs: atMs,
            leftAtMs: null,
        });
    } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
        // Contract §4: a concurrent INSERT loses on uq_live_participant. The
        // session lock should make this unreachable, but if it happens the row
        // exists — re-read, refresh once, and recompute the count honestly.
        const raced = await findParticipantRow(conn, sessionId, userId, tenantId);
        if (!raced) {
            throw new LiveSessionSqlError('write_conflict', 'duplicate participant key but no row to refresh');
        }
        const affected = await refreshParticipantRow(conn, {
            sessionId,
            userId,
            tenantId,
            role,
            ticketFingerprint,
            lastSeenAtMs: atMs,
            joinedAtMs: atMs,
            leftAtMs: null,
        });
        if (affected === 0) {
            const still = await findParticipantRow(conn, sessionId, userId, tenantId);
            if (!still) {
                throw new LiveSessionSqlError('write_conflict', 'participant row disappeared after a duplicate key');
            }
        }
        return {
            admitted: true,
            created: false,
            participantId: raced.id,
            activeCount: await countActiveUsers(conn, sessionId, tenantId),
            maxParticipants,
        };
    }

    return {
        admitted: true,
        created: true,
        participantId,
        activeCount: activeCount + 1,
        maxParticipants,
    };
};

const upsertParticipantRow = async (
    conn: LiveSessionSqlConnection,
    row: LiveParticipantRecord,
): Promise<{ created: boolean }> => {
    const role = normalizeParticipantRole(row.role);
    if (!role) throw new LiveSessionSqlError('invalid_input', 'participant role is outside the ENUM');
    const joinedAtMs = requireEpochMs(row.joinedAtMs, 'joinedAtMs');
    const lastSeenAtMs = requireEpochMs(row.lastSeenAtMs, 'lastSeenAtMs');
    const leftAtMs = row.leftAtMs === null ? null : requireEpochMs(row.leftAtMs, 'leftAtMs');

    const affected = await refreshParticipantRow(conn, {
        sessionId: row.sessionId,
        userId: row.userId,
        tenantId: row.tenantId,
        role,
        ticketFingerprint: row.ticketFingerprint,
        lastSeenAtMs,
        joinedAtMs,
        leftAtMs,
    });
    if (affected > 0) return { created: false };

    // 0 changed rows may mean "row already in that shape" — do not INSERT over
    // it. Only a missing row is an insert.
    const existing = await findParticipantRow(conn, row.sessionId, row.userId, row.tenantId);
    if (existing) return { created: false };

    try {
        await insertParticipantRow(conn, {
            id: row.id,
            tenantId: row.tenantId,
            sessionId: row.sessionId,
            userId: row.userId,
            role,
            ticketFingerprint: row.ticketFingerprint,
            joinedAtMs,
            lastSeenAtMs,
            leftAtMs,
        });
    } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
        const raced = await findParticipantRow(conn, row.sessionId, row.userId, row.tenantId);
        if (!raced) throw new LiveSessionSqlError('write_conflict', 'duplicate participant key but no row to refresh');
        await refreshParticipantRow(conn, {
            sessionId: row.sessionId,
            userId: row.userId,
            tenantId: row.tenantId,
            role,
            ticketFingerprint: row.ticketFingerprint,
            lastSeenAtMs,
            joinedAtMs,
            leftAtMs,
        });
        return { created: false };
    }
    return { created: true };
};

/**
 * Idempotent leave: `left_at_ms IS NULL` makes a second leave a 0-row no-op,
 * and `GREATEST` keeps `last_seen_at_ms` monotonic. The tenant predicate is
 * mandatory; a caller that omits it is refused rather than writing unscoped.
 *
 * The session row is taken FOR UPDATE first, in the contract's lock order
 * (session row, then its participant rows), so a leave cannot interleave with
 * an admission count of the same session. A missing session is a 0-row no-op.
 */
const markParticipantLeftRow = async (
    conn: LiveSessionSqlConnection,
    sessionId: string,
    userId: string,
    leftAtMs: number,
    tenantId?: string,
): Promise<number> => {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new LiveSessionSqlError('tenant_required', 'markParticipantLeft requires the tenant of the session');
    }
    const left = requireEpochMs(leftAtMs, 'leftAtMs');
    const locked = await conn.query<{ id: string }>(
        `SELECT id FROM live_sessions WHERE id = ? AND tenant_id = ? FOR UPDATE`,
        [sessionId, tenantId],
    );
    if (locked.length === 0) return 0;
    const result = await conn.execute(
        `UPDATE live_session_participants
            SET left_at_ms = ?, last_seen_at_ms = GREATEST(last_seen_at_ms, ?)
          WHERE session_id = ? AND user_id = ? AND tenant_id = ?
            AND left_at_ms IS NULL`,
        [left, left, sessionId, userId, tenantId],
    );
    return affectedOf(result);
};

const listParticipantRows = async (
    conn: LiveSessionSqlConnection,
    sessionId: string,
    tenantId: string,
): Promise<LiveParticipantRecord[]> => {
    const rows = await conn.query<LiveParticipantRow>(
        `SELECT ${PARTICIPANT_COLUMNS} FROM live_session_participants
          WHERE session_id = ? AND tenant_id = ?
          ORDER BY joined_at_ms ASC, user_id ASC`,
        [sessionId, tenantId],
    );
    return rows.map(mapParticipant);
};

/* =========================================================================
 * live_session_callbacks
 * ========================================================================= */

/**
 * Claim the event: the unique key `(tenant_id, provider, event_id)` is the
 * arbiter. `false` means the event was already recorded (pending or terminal),
 * which the core reports as `duplicate`. Only `pending` may be inserted here —
 * a terminal outcome is reached through `finalizeCallback`, never at claim time.
 */
const insertCallbackRow = async (conn: LiveSessionSqlConnection, row: LiveCallbackRow): Promise<boolean> => {
    const outcome = normalizeOutcome(row.outcome, { allowPending: true });
    if (outcome !== 'pending') {
        throw new LiveSessionSqlError('invalid_outcome', 'a callback marker is claimed as pending only');
    }
    if (!(LIVE_CALLBACK_KINDS as readonly string[]).includes(row.kind)) {
        throw new LiveSessionSqlError('invalid_input', `callback kind "${String(row.kind)}" is not known`);
    }
    const occurredAtMs = requireEpochMs(row.occurredAtMs, 'occurredAtMs');
    try {
        await conn.execute(
            `INSERT INTO live_session_callbacks
                 (id, tenant_id, session_id, provider, event_id, kind, occurred_at_ms, outcome)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [row.id, row.tenantId, row.sessionId, row.provider, row.eventId, row.kind, occurredAtMs],
        );
    } catch (error) {
        if (isDuplicateEntry(error)) return false;
        throw error;
    }
    return true;
};

/**
 * Guarded CAS from `pending` to a terminal outcome. 0 rows means the marker is
 * already terminal (or does not exist) — the caller must treat that as a
 * conflict, never as success.
 */
const finalizeCallbackRow = async (
    conn: LiveSessionSqlConnection,
    id: string,
    outcome: string,
    tenantId?: string,
): Promise<number> => {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new LiveSessionSqlError('tenant_required', 'finalizeCallback requires the tenant of the session');
    }
    const terminal = normalizeOutcome(outcome, { allowPending: false });
    let result: { affectedRows?: number };
    try {
        result = await conn.execute(
            `UPDATE live_session_callbacks
                SET outcome = ?
              WHERE id = ? AND tenant_id = ? AND outcome = 'pending'`,
            [terminal, id, tenantId],
        );
    } catch (error) {
        // Only the R23 values can violate the CHECK, so this is the schema gap
        // and not a bad outcome: the unit rolls back and nothing is persisted.
        if (isCheckConstraintViolation(error)) {
            throw new LiveSessionSqlError(
                'schema_unavailable',
                `chk_live_callback_outcome does not admit "${terminal}" (R23): apply `
                + '20261023_02_live_callback_presence_contract.sql before enabling ordered callbacks',
            );
        }
        throw error;
    }
    return affectedOf(result);
};

/* =========================================================================
 * Presence event cursor (R22) — same connection, same row, checked CAS
 * ========================================================================= */

/**
 * Read the per-participant presence cursor from the participant row.
 *
 * The cursor lives ON `live_session_participants`, so this read is scoped by
 * `(tenant_id, session_id, id)` and runs on the unit's connection — the same one
 * that will write the callback marker, the participant row, the interval and the
 * sealed audit. There is no second connection and no nested transaction.
 *
 * A `NULL` pair is the documented "no cursor yet" state (existing rows begin
 * NULL; historical event times are never fabricated). A HALF-set pair is an
 * integrity fault, not a cursor: `chk_live_participant_presence_cursor` forbids
 * it, and if it is seen anyway the read refuses instead of guessing which half
 * to believe.
 *
 * A participant row that cannot be found is also refused: the core resolved this
 * participant from the same unit, so a missing row means the participant was
 * removed concurrently. Returning `null` would read as "no cursor" and let the
 * callback refresh a participant that no longer exists.
 */
const readPresenceCursorRow = async (
    conn: LiveSessionSqlConnection,
    tenantId: string,
    sessionId: string,
    participantId: string,
): Promise<PresenceEventCursor | null> => {
    const tenant = requireText(tenantId, 'tenantId');
    const session = requireText(sessionId, 'sessionId');
    const participant = requireText(participantId, 'participantId');
    let row: { presence_event_at_ms: number | string | null; presence_event_id: string | null } | null = null;
    try {
        row = await conn.queryOne<{ presence_event_at_ms: number | string | null; presence_event_id: string | null }>(
            `SELECT presence_event_at_ms, presence_event_id
               FROM live_session_participants
              WHERE tenant_id = ? AND session_id = ? AND id = ?`,
            [tenant, session, participant],
        );
    } catch (error) {
        if (isMissingColumn(error)) {
            throw new LiveSessionSqlError(
                'schema_unavailable',
                'live_session_participants is missing the R22 presence cursor columns '
                + '(presence_event_at_ms / presence_event_id): apply '
                + '20261023_02_live_callback_presence_contract.sql',
            );
        }
        throw error;
    }
    if (!row) {
        throw new LiveSessionSqlError(
            'invalid_row',
            `no live_session_participants row for "${participant}" in session "${session}"`,
        );
    }
    const eventAtMs = readNullableInteger(
        row.presence_event_at_ms,
        'live_session_participants.presence_event_at_ms',
    );
    const eventIdRaw = row.presence_event_id;
    const eventIdAbsent = eventIdRaw === null || eventIdRaw === undefined;
    if (eventAtMs === null && eventIdAbsent) return null;
    if (eventAtMs === null || eventIdAbsent) {
        throw new LiveSessionSqlError(
            'invalid_row',
            'presence cursor is half-set (one of presence_event_at_ms / presence_event_id is NULL); '
            + 'chk_live_participant_presence_cursor forbids this',
        );
    }
    return {
        eventAtMs,
        // Byte-exact: never trimmed or normalised. A different byte string is a
        // different event identity.
        eventId: requirePresenceEventId(
            eventIdRaw,
            'live_session_participants.presence_event_id',
            'invalid_row',
        ),
    };
};

/**
 * ONE compare-and-set on the participant row. Returns affected rows: 1 means
 * THIS event won and may change state; 0 means the stored cursor is no longer
 * the value the caller read, so the event is stale and must not be applied.
 *
 * `expected: null` means "there is no cursor yet", which matches only a stored
 * NULL pair. Both branches are in the WHERE clause, which MySQL evaluates
 * against the ORIGINAL row values before `SET` runs, so the two assignments
 * cannot influence the predicate they are guarded by.
 *
 * Changed-rows semantics: an advance whose `next` equals the stored pair
 * matches the predicate but changes nothing, so `affectedRows` is 0 and the
 * caller reports it as lost. That is intended — the core refuses equal instants
 * as `ambiguous-event` before ever reaching the CAS, so a no-op advance is never
 * requested, and a 0 is never read as success.
 */
const advancePresenceCursorRow = async (
    conn: LiveSessionSqlConnection,
    input: AdvancePresenceCursorInput,
): Promise<number> => {
    if (!input || typeof input !== 'object') {
        throw new LiveSessionSqlError('invalid_input', 'advancePresenceCursor requires an input object');
    }
    const tenant = requireText(input.tenantId, 'tenantId');
    const session = requireText(input.sessionId, 'sessionId');
    const participant = requireText(input.participantId, 'participantId');
    const nextAtMs = requireEpochMs(input.next?.eventAtMs, 'next.eventAtMs');
    const nextId = requirePresenceEventId(input.next?.eventId, 'next.eventId');
    const expected = input.expected ?? null;
    const expectedAtMs = expected === null ? null : requireEpochMs(expected.eventAtMs, 'expected.eventAtMs');
    const expectedId = expected === null ? null : requirePresenceEventId(expected.eventId, 'expected.eventId');
    let result: { affectedRows?: number };
    try {
        result = await conn.execute(
            `UPDATE live_session_participants
                SET presence_event_at_ms = ?, presence_event_id = ?
              WHERE tenant_id = ? AND session_id = ? AND id = ?
                AND ((? IS NULL AND presence_event_at_ms IS NULL AND presence_event_id IS NULL)
                     OR (presence_event_at_ms = ? AND presence_event_id = ?))`,
            [nextAtMs, nextId, tenant, session, participant, expectedAtMs, expectedAtMs, expectedId],
        );
    } catch (error) {
        if (isMissingColumn(error)) {
            throw new LiveSessionSqlError(
                'schema_unavailable',
                'live_session_participants is missing the R22 presence cursor columns '
                + '(presence_event_at_ms / presence_event_id): apply '
                + '20261023_02_live_callback_presence_contract.sql',
            );
        }
        throw error;
    }
    return affectedOf(result);
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
    conn: LiveSessionSqlConnection,
    sealedAudit: SealedAuditWriter,
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
 * Presence event identity (F2) — pure classifier over catalog metadata
 * ========================================================================= */

/**
 * `presence_event_id` is `VARCHAR(128)` and its identity must be BYTE-EXACT.
 *
 * Under a PAD SPACE collation MySQL compares `'evt-1'` and `'evt-1 '` as equal,
 * so two different provider events satisfy the same cursor predicate and one of
 * them is silently treated as a replay of the other. The contract is therefore a
 * binary collation that is also NO PAD.
 *
 * Both facts are read from catalog METADATA. Neither is inferred from the shape
 * of the collation name, and an unreadable server version is reported as
 * `unknown` — never as `compatible`.
 */
export const PRESENCE_EVENT_ID_CHARSET = 'utf8mb4' as const;

/**
 * The one accepted collation. It is chosen for the binary comparison AND the
 * NO PAD attribute, not for the `_bin` suffix: `utf8mb4_bin` is PAD SPACE and
 * would still collapse a trailing space.
 */
export const PRESENCE_EVENT_ID_COLLATION = 'utf8mb4_0900_bin' as const;

/** The exact `information_schema.COLLATIONS.PAD_ATTRIBUTE` text that is required. */
export const PRESENCE_EVENT_ID_PAD_ATTRIBUTE = 'NO PAD' as const;

export type PresenceEventIdIdentityVerdict = 'compatible' | 'incompatible' | 'unknown';

/** MySQL 8 is the first release that ships the `utf8mb4_0900_*` collations. */
const MINIMUM_SERVER_MAJOR_FOR_0900_COLLATIONS = 8;

const MAX_VERSION_TEXT_IN_REASON = 48;

const boundedText = (value: string, limit: number): string =>
    value.length <= limit ? value : `${value.slice(0, limit)}…`;

const describeCatalogValue = (value: string | null): string =>
    value === null ? 'unreadable' : `"${value}"`;

const parseServerMajorVersion = (serverVersion: string): number | null => {
    const match = /^(\d+)\.(\d+)/.exec(serverVersion);
    if (!match) return null;
    const major = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(major) ? major : null;
};

/**
 * Classify the identity contract from four MEASURED facts and nothing else.
 *
 * Rules are evaluated in order and the first that applies wins, so a server
 * whose collation catalogue is unknown can never come out `compatible`.
 *
 * The collation comparison is EXACT string equality against
 * `utf8mb4_0900_bin`. `endsWith('_bin')`, `includes('bin')`, lower-casing and
 * trimming are all forbidden here: `utf8mb4_bin` and `utf8mb4_0900_as_cs` are
 * different collations with different pad semantics, and any normalised
 * comparison would accept them. The catalog value is a fixed ASCII token, so
 * there is nothing to normalise — only something to get wrong.
 *
 * The pad attribute is likewise exact and case-sensitive on the catalog value.
 * `'PAD SPACE'` is a named failure with the collapsing example in the reason,
 * not an unknown: the value was read and it is the wrong one.
 */
export function classifyPresenceEventIdIdentity(input: {
    serverVersion: string | null;
    columnCharset: string | null;
    columnCollation: string | null;
    collationPadAttribute: string | null;
}): { verdict: PresenceEventIdIdentityVerdict; reason: string | null } {
    if (!input || typeof input !== 'object') {
        return { verdict: 'unknown', reason: 'identity input is missing; nothing was measured' };
    }
    const serverVersion = typeof input.serverVersion === 'string' ? input.serverVersion.trim() : '';
    if (serverVersion.length === 0) {
        return {
            verdict: 'unknown',
            reason: 'SELECT VERSION() produced no text; the collation contract cannot be checked',
        };
    }
    if (/mariadb/i.test(serverVersion)) {
        return {
            verdict: 'unknown',
            reason: `server reports "${boundedText(serverVersion, MAX_VERSION_TEXT_IN_REASON)}" (MariaDB); `
                + 'utf8mb4_0900_bin is a MySQL 8 collation and does not exist there',
        };
    }
    const major = parseServerMajorVersion(serverVersion);
    if (major === null) {
        return {
            verdict: 'unknown',
            reason: `server version "${boundedText(serverVersion, MAX_VERSION_TEXT_IN_REASON)}" `
                + 'has no parseable major version',
        };
    }
    if (major < MINIMUM_SERVER_MAJOR_FOR_0900_COLLATIONS) {
        return {
            verdict: 'unknown',
            reason: `server major version ${major} predates utf8mb4_0900_bin`,
        };
    }
    if (input.columnCharset !== PRESENCE_EVENT_ID_CHARSET) {
        return {
            verdict: 'incompatible',
            reason: 'live_session_participants.presence_event_id has CHARACTER_SET_NAME '
                + `${describeCatalogValue(input.columnCharset)}, not "utf8mb4"`,
        };
    }
    if (input.columnCollation !== PRESENCE_EVENT_ID_COLLATION) {
        return {
            verdict: 'incompatible',
            reason: 'live_session_participants.presence_event_id has COLLATION_NAME '
                + `${describeCatalogValue(input.columnCollation)}, not "utf8mb4_0900_bin"`,
        };
    }
    if (input.collationPadAttribute !== PRESENCE_EVENT_ID_PAD_ATTRIBUTE) {
        return {
            verdict: 'incompatible',
            reason: `collation ${PRESENCE_EVENT_ID_COLLATION} reports PAD_ATTRIBUTE `
                + `${describeCatalogValue(input.collationPadAttribute)}; under PAD SPACE `
                + "'evt-1' and 'evt-1 ' compare equal and collapse into one cursor identity",
        };
    }
    return { verdict: 'compatible', reason: null };
}

/* =========================================================================
 * Schema verification (F1) — explicit catalog read, identity-bound report
 * ========================================================================= */

/**
 * Readiness is a MEASUREMENT, not a declaration.
 *
 * `presenceCursor: 'declared'` is a caller attestation and says nothing about
 * the database; "the functions exist" says only that this module was built.
 * `verifyLiveSchema` reads `information_schema` on the injected connection and
 * reports, per area, what was found and what could not be established.
 *
 * It is never awaited at module scope and never called from a constructor:
 * construction stays I/O-free and the caller decides when, and whether, to
 * measure. There is no `transaction` here either — verification reads the
 * catalog and is not a write unit.
 */
export const LIVE_SCHEMA_CONTRACT_VERSION = 'live-schema-20261023-1';

/**
 * The five independent claims a live-session deployment makes about its schema.
 * Each is verified on its own so one missing migration does not mask the state
 * of the other four.
 */
export const LIVE_SCHEMA_AREAS = [
    'sessionLifecycle',
    'presenceOrdering',
    'presenceEventIdentity',
    'ingestLedger',
    'recoveryCheckpoint',
] as const;

export type LiveSchemaArea = (typeof LIVE_SCHEMA_AREAS)[number];

export type LiveSchemaAreaStatus = 'verified' | 'absent' | 'unknown';

export interface LiveSchemaAreaResult {
    readonly status: LiveSchemaAreaStatus;
    /** Non-null exactly when status !== 'verified'. A short fact, never a driver dump. */
    readonly reason: string | null;
    /** The exact column/table names this area was checked against. */
    readonly checked: readonly string[];
}

export interface LiveSchemaReport {
    readonly contractVersion: typeof LIVE_SCHEMA_CONTRACT_VERSION;
    readonly checkedAtMs: number;
    /** Raw `SELECT VERSION()` text, never parsed down to a number here. */
    readonly serverVersion: string;
    readonly areas: Readonly<Record<LiveSchemaArea, LiveSchemaAreaResult>>;
    /** What this verifier could NOT establish, stated as a limit, not a pass. */
    readonly limits: readonly string[];
}

/**
 * Every report this module produced, by object identity.
 *
 * A structurally identical object literal is NOT a report: `isLiveSchemaReport`
 * consults this WeakSet, so only the object `verifyLiveSchema` returned passes.
 * That is the difference between evidence and a shape a caller can fabricate.
 */
const issuedReports = new WeakSet<object>();

/**
 * Reports per executor OBJECT, again by identity.
 *
 * Binding to the executor object — not to a string field such as a pool name —
 * is what makes the binding real: a wrapper executor around the same pool is a
 * DIFFERENT object, so it does not inherit a verification performed against
 * another connection. Verification is a property of the object measured, and a
 * caller cannot obtain it by copying fields into a look-alike.
 *
 * Verification is a startup-scale operation, so the per-executor set is small;
 * the executor key is weak, so the entry disappears with the executor.
 */
const reportsByExecutor = new WeakMap<object, Set<LiveSchemaReport>>();

interface TableColumnRequirement {
    readonly table: string;
    readonly columns: readonly string[];
}

interface CatalogColumnInfo {
    readonly charset: string | null;
    readonly collation: string | null;
}

const splitColumnList = (list: string): readonly string[] =>
    list.split(',').map((name) => name.trim()).filter((name) => name.length > 0);

const LIVE_SCHEMA_TABLES = [
    'live_sessions',
    'live_session_participants',
    'live_session_callbacks',
    'live_recording_ingests',
    'live_recovery_checkpoints',
] as const;

/**
 * The session-side columns this lane actually writes or reads, taken from the
 * statement text above (`SESSION_COLUMNS`, `PARTICIPANT_COLUMNS`, and the
 * callback INSERT). A wider list recalled from memory would report a gap that
 * does not exist; a narrower one would report `verified` for a table this lane
 * cannot write.
 */
const SESSION_LIFECYCLE_REQUIREMENTS: readonly TableColumnRequirement[] = [
    { table: 'live_sessions', columns: splitColumnList(SESSION_COLUMNS) },
    { table: 'live_session_participants', columns: splitColumnList(PARTICIPANT_COLUMNS) },
    {
        table: 'live_session_callbacks',
        columns: ['id', 'tenant_id', 'session_id', 'provider', 'event_id', 'kind', 'occurred_at_ms', 'outcome'],
    },
];

/** The R22 cursor pair, from the header comment and `readPresenceCursorRow`. */
const PRESENCE_ORDERING_COLUMNS: readonly string[] = ['presence_event_at_ms', 'presence_event_id'];

/**
 * Mirrors `INGEST_COLUMNS` in `live-recording-ingest-sql.ts`; that module does
 * not export it and this file takes no new import. The ledger is read here, not
 * written: the area only asserts that the table can carry what the ingest lane
 * persists.
 */
const INGEST_LEDGER_COLUMNS: readonly string[] = [
    'id',
    'tenant_id',
    'session_id',
    'provider',
    'event_id',
    'provider_recording_id',
    'duration_seconds',
    'storage_bytes',
    'occurred_at_ms',
    'outcome',
    'claim_owner',
    'claim_expires_at_ms',
];

/**
 * R24, the agreed checkpoint contract. The migration does not exist yet, so an
 * absent table is the expected result and is reported as `absent` rather than
 * as a failure of this verifier.
 */
const RECOVERY_CHECKPOINT_COLUMNS: readonly string[] = [
    'purpose',
    'cursor_occurred_at_ms',
    'cursor_id',
    'owner',
    'lease_expires_at_ms',
    'row_version',
    'sweep_generation',
    'updated_at_ms',
];

const RECOVERY_CHECKPOINT_TABLE = 'live_recovery_checkpoints';

/** Cap on names quoted in one reason, so a reason stays a fact and not a dump. */
const MAX_MISSING_NAMES = 8;

const LIVE_SCHEMA_LIMITS: readonly string[] = [
    'A CHECK constraint admitted-value list is not readable portably from information_schema, '
        + 'so R23 is proven only by a rejected write mapped to schema_unavailable, not by this report.',
    'Byte preservation of presence_event_id follows from the binary, NO PAD collation contract; '
        + 'this verifier reads that contract from metadata but does not measure stored bytes.',
    'This is a snapshot at checkedAtMs: nothing prevents DDL from running after it, '
        + 'so freshness is the responsibility of the caller or the factory, not a claim of this report.',
    'A catalog read that fails (privilege, connection, or a server without PAD_ATTRIBUTE) yields '
        + 'unknown rather than absent; the area reason names the failure.',
];

const readCatalogText = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

/** A short, single-line fact. Never the whole driver object. */
const describeCatalogError = (error: unknown): string => {
    if (!error || typeof error !== 'object') return 'catalog query failed';
    const code = readCatalogText((error as { code?: unknown }).code);
    const rawMessage = readCatalogText((error as { message?: unknown }).message);
    const message = rawMessage === null
        ? 'catalog query failed'
        : rawMessage.replace(/\s+/g, ' ').trim();
    const bounded = message.length > 140 ? `${message.slice(0, 140)}…` : message;
    return code === null ? bounded : `${code}: ${bounded}`;
};

const summarizeNames = (names: readonly string[]): string =>
    names.length <= MAX_MISSING_NAMES
        ? names.join(', ')
        : `${names.slice(0, MAX_MISSING_NAMES).join(', ')} … (+${names.length - MAX_MISSING_NAMES} more)`;

const buildColumnIndex = (
    rows: readonly Record<string, unknown>[],
): Map<string, Map<string, CatalogColumnInfo>> => {
    const index = new Map<string, Map<string, CatalogColumnInfo>>();
    for (const row of rows) {
        const table = readCatalogText(row.TABLE_NAME);
        const column = readCatalogText(row.COLUMN_NAME);
        if (table === null || column === null) continue;
        let tableColumns = index.get(table);
        if (!tableColumns) {
            tableColumns = new Map<string, CatalogColumnInfo>();
            index.set(table, tableColumns);
        }
        tableColumns.set(column, {
            charset: readCatalogText(row.CHARACTER_SET_NAME),
            collation: readCatalogText(row.COLLATION_NAME),
        });
    }
    return index;
};

const missingForRequirements = (
    index: ReadonlyMap<string, ReadonlyMap<string, CatalogColumnInfo>>,
    requirements: readonly TableColumnRequirement[],
): string[] => {
    const missing: string[] = [];
    for (const requirement of requirements) {
        const present = index.get(requirement.table);
        for (const column of requirement.columns) {
            if (!present || !present.has(column)) missing.push(`${requirement.table}.${column}`);
        }
    }
    return missing;
};

const verifiedArea = (checked: readonly string[]): LiveSchemaAreaResult => ({
    status: 'verified',
    reason: null,
    checked,
});

const absentArea = (reason: string, checked: readonly string[]): LiveSchemaAreaResult => ({
    status: 'absent',
    reason,
    checked,
});

const unknownArea = (reason: string, checked: readonly string[]): LiveSchemaAreaResult => ({
    status: 'unknown',
    reason,
    checked,
});

/**
 * Measure the schema on the injected connection and return a report that is
 * bound to THIS executor object.
 *
 * Read-only: `query` / `queryOne` against `information_schema` only, no
 * `transaction`, no DDL, no statement at import time. Every table name is a
 * bound parameter; the only interpolated text is the placeholder list generated
 * from the constant table tuple, never from caller data.
 *
 * A missing table, a missing column or a denied privilege NEVER throws: the
 * affected area becomes `absent` or `unknown` with a short reason. Only an
 * executor that cannot be queried at all throws, as `invalid_deps`.
 */
export async function verifyLiveSchema(
    executor: LiveSessionSqlConnection,
    options?: { now?: () => number },
): Promise<LiveSchemaReport> {
    if (!executor || typeof executor !== 'object'
        || typeof executor.query !== 'function'
        || typeof executor.queryOne !== 'function') {
        throw new LiveSessionSqlError(
            'invalid_deps',
            'verifyLiveSchema requires an executor exposing query and queryOne on one connection',
        );
    }
    const readNow = options && typeof options.now === 'function' ? options.now : Date.now;
    const measuredAt = readNow();
    const checkedAtMs = typeof measuredAt === 'number' && Number.isFinite(measuredAt)
        ? measuredAt
        : Date.now();

    let serverVersion = '';
    let versionFailure: string | null = null;
    try {
        const row = await executor.queryOne<Record<string, unknown>>('SELECT VERSION() AS version');
        const text = row === null ? null : readCatalogText(row.version);
        if (text === null) versionFailure = 'SELECT VERSION() returned no readable text';
        else serverVersion = text;
    } catch (error) {
        versionFailure = describeCatalogError(error);
    }

    const placeholders = LIVE_SCHEMA_TABLES.map(() => '?').join(', ');

    let columnIndex: Map<string, Map<string, CatalogColumnInfo>> | null = null;
    let columnsFailure: string | null = null;
    try {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
            [...LIVE_SCHEMA_TABLES],
        );
        columnIndex = buildColumnIndex(rows);
    } catch (error) {
        columnsFailure = describeCatalogError(error);
    }

    let presentTables: Set<string> | null = null;
    let tablesFailure: string | null = null;
    try {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
            [...LIVE_SCHEMA_TABLES],
        );
        const found = new Set<string>();
        for (const row of rows) {
            const name = readCatalogText(row.TABLE_NAME);
            if (name !== null) found.add(name);
        }
        presentTables = found;
    } catch (error) {
        tablesFailure = describeCatalogError(error);
    }

    let padAttribute: string | null = null;
    let collationFailure: string | null = null;
    try {
        const row = await executor.queryOne<Record<string, unknown>>(
            `SELECT COLLATION_NAME, CHARACTER_SET_NAME, PAD_ATTRIBUTE
               FROM information_schema.COLLATIONS
              WHERE COLLATION_NAME = ?`,
            [PRESENCE_EVENT_ID_COLLATION],
        );
        if (row === null) {
            collationFailure = `${PRESENCE_EVENT_ID_COLLATION} is not in information_schema.COLLATIONS`;
        } else {
            padAttribute = readCatalogText(row.PAD_ATTRIBUTE);
            if (padAttribute === null) {
                collationFailure = `${PRESENCE_EVENT_ID_COLLATION} has no readable PAD_ATTRIBUTE`;
            }
        }
    } catch (error) {
        collationFailure = describeCatalogError(error);
    }

    const lifecycleChecked = SESSION_LIFECYCLE_REQUIREMENTS.flatMap((requirement) =>
        requirement.columns.map((column) => `${requirement.table}.${column}`));

    let sessionLifecycle: LiveSchemaAreaResult;
    if (columnIndex === null) {
        sessionLifecycle = unknownArea(
            `catalog read failed (${columnsFailure ?? 'unknown'})`,
            lifecycleChecked,
        );
    } else {
        const missing = missingForRequirements(columnIndex, SESSION_LIFECYCLE_REQUIREMENTS);
        sessionLifecycle = missing.length === 0
            ? verifiedArea(lifecycleChecked)
            : absentArea(
                `${missing.length} required column(s) absent: ${summarizeNames(missing)}`,
                lifecycleChecked,
            );
    }

    const orderingChecked = PRESENCE_ORDERING_COLUMNS.map(
        (column) => `live_session_participants.${column}`,
    );

    let presenceOrdering: LiveSchemaAreaResult;
    if (columnIndex === null) {
        presenceOrdering = unknownArea(
            `catalog read failed (${columnsFailure ?? 'unknown'})`,
            orderingChecked,
        );
    } else {
        const missing = missingForRequirements(columnIndex, [{
            table: 'live_session_participants',
            columns: PRESENCE_ORDERING_COLUMNS,
        }]);
        presenceOrdering = missing.length === 0
            ? verifiedArea(orderingChecked)
            : absentArea(
                `${summarizeNames(missing)} absent; apply 20261023_02_live_callback_presence_contract.sql`,
                orderingChecked,
            );
    }

    const identityChecked = [
        'live_session_participants.presence_event_id',
        `information_schema.COLLATIONS.${PRESENCE_EVENT_ID_COLLATION}`,
    ];

    let presenceEventIdentity: LiveSchemaAreaResult;
    if (columnIndex === null) {
        presenceEventIdentity = unknownArea(
            `catalog read failed (${columnsFailure ?? 'unknown'})`,
            identityChecked,
        );
    } else if (collationFailure !== null) {
        presenceEventIdentity = unknownArea(
            `collation metadata unreadable (${collationFailure})`,
            identityChecked,
        );
    } else {
        const column = columnIndex.get('live_session_participants')?.get('presence_event_id') ?? null;
        const verdict = classifyPresenceEventIdIdentity({
            serverVersion: versionFailure === null ? serverVersion : null,
            columnCharset: column === null ? null : column.charset,
            columnCollation: column === null ? null : column.collation,
            collationPadAttribute: padAttribute,
        });
        const reason = verdict.reason ?? 'presence_event_id identity is not compatible';
        if (verdict.verdict === 'compatible') {
            presenceEventIdentity = verifiedArea(identityChecked);
        } else if (verdict.verdict === 'incompatible') {
            presenceEventIdentity = absentArea(reason, identityChecked);
        } else {
            presenceEventIdentity = unknownArea(reason, identityChecked);
        }
    }

    const ingestChecked = INGEST_LEDGER_COLUMNS.map(
        (column) => `live_recording_ingests.${column}`,
    );

    let ingestLedger: LiveSchemaAreaResult;
    if (columnIndex === null) {
        ingestLedger = unknownArea(
            `catalog read failed (${columnsFailure ?? 'unknown'})`,
            ingestChecked,
        );
    } else {
        const missing = missingForRequirements(columnIndex, [{
            table: 'live_recording_ingests',
            columns: INGEST_LEDGER_COLUMNS,
        }]);
        ingestLedger = missing.length === 0
            ? verifiedArea(ingestChecked)
            : absentArea(
                `${missing.length} ledger column(s) absent: ${summarizeNames(missing)}`,
                ingestChecked,
            );
    }

    const recoveryChecked = [
        RECOVERY_CHECKPOINT_TABLE,
        ...RECOVERY_CHECKPOINT_COLUMNS.map((column) => `${RECOVERY_CHECKPOINT_TABLE}.${column}`),
    ];

    let recoveryCheckpoint: LiveSchemaAreaResult;
    if (presentTables === null || columnIndex === null) {
        const failure = presentTables === null ? tablesFailure : columnsFailure;
        recoveryCheckpoint = unknownArea(
            `catalog read failed (${failure ?? 'unknown'})`,
            recoveryChecked,
        );
    } else if (!presentTables.has(RECOVERY_CHECKPOINT_TABLE)) {
        recoveryCheckpoint = absentArea(
            `${RECOVERY_CHECKPOINT_TABLE} is absent; apply 20261023_04_live_recovery_checkpoint.sql`,
            recoveryChecked,
        );
    } else {
        const missing = missingForRequirements(columnIndex, [{
            table: RECOVERY_CHECKPOINT_TABLE,
            columns: RECOVERY_CHECKPOINT_COLUMNS,
        }]);
        recoveryCheckpoint = missing.length === 0
            ? verifiedArea(recoveryChecked)
            : absentArea(
                `${RECOVERY_CHECKPOINT_TABLE} is present but ${missing.length} column(s) are absent: `
                + summarizeNames(missing),
                recoveryChecked,
            );
    }

    const areas: Record<LiveSchemaArea, LiveSchemaAreaResult> = {
        sessionLifecycle,
        presenceOrdering,
        presenceEventIdentity,
        ingestLedger,
        recoveryCheckpoint,
    };

    const report: LiveSchemaReport = {
        contractVersion: LIVE_SCHEMA_CONTRACT_VERSION,
        checkedAtMs,
        serverVersion,
        areas,
        limits: LIVE_SCHEMA_LIMITS,
    };

    issuedReports.add(report);
    const existing = reportsByExecutor.get(executor);
    if (existing) existing.add(report);
    else reportsByExecutor.set(executor, new Set<LiveSchemaReport>([report]));

    return report;
}

/** True only for a report this module produced. */
export function isLiveSchemaReport(value: unknown): value is LiveSchemaReport {
    return typeof value === 'object' && value !== null && issuedReports.has(value);
}

/** True only for a report this module produced FOR THIS EXECUTOR OBJECT. */
export function isLiveSchemaReportFor(value: unknown, executor: unknown): boolean {
    if (!isLiveSchemaReport(value)) return false;
    if (typeof executor !== 'object' || executor === null) return false;
    const issued = reportsByExecutor.get(executor);
    return issued !== undefined && issued.has(value);
}

/* =========================================================================
 * Unit + store
 * ========================================================================= */

/** A unit that also carries the presence methods this adapter always provides. */
export interface LiveSessionSqlUnit extends LiveSessionUnit {
    openPresenceInterval(input: OpenPresenceIntervalInput): Promise<OpenPresenceIntervalResult>;
    closePresenceInterval(input: ClosePresenceIntervalInput): Promise<ClosePresenceIntervalResult>;
    listPresenceIntervals(sessionId: string, tenantId: string): Promise<PresenceIntervalRecord[]>;
}

export interface LiveSessionSqlStore extends LiveSessionStore {
    /** Mandatory, unlike the optional port member. */
    withTransaction<T>(work: (unit: LiveSessionUnit) => Promise<T>): Promise<T>;
    openPresenceInterval(input: OpenPresenceIntervalInput): Promise<OpenPresenceIntervalResult>;
    closePresenceInterval(input: ClosePresenceIntervalInput): Promise<ClosePresenceIntervalResult>;
    listPresenceIntervals(sessionId: string, tenantId: string): Promise<PresenceIntervalRecord[]>;
    /**
     * What this store will actually do, not what was requested: `'declared'`
     * only when the constructor was given that attestation, so a composition can
     * read readiness off the built store instead of trusting its own input.
     */
    readonly presenceCursor: PresenceCursorReadiness;
}

/**
 * Bind every unit method to ONE connection. The caller owns the transaction;
 * this function never opens one.
 *
 * The cursor methods are attached CONDITIONALLY and close over `conn`, so they
 * are never handed out detached from the connection they belong to (an unbound
 * method would run on whatever connection the caller happened to hold). When the
 * composition has not declared R22, the properties are absent — the core's
 * fail-closed signal — rather than present and throwing.
 */
export const createLiveSessionSqlUnit = (
    conn: LiveSessionSqlConnection,
    sealedAudit: SealedAuditWriter,
    options: { presenceCursor?: PresenceCursorReadiness } = {},
): LiveSessionSqlUnit => {
    const unit: LiveSessionSqlUnit = {
        insertSession: (row) => insertSessionRow(conn, row),
        findSession: (id, tenantId) => findSessionRow(conn, id, tenantId),
        findSessionByProvider: (provider, providerRoomId) => findSessionByProviderRow(conn, provider, providerRoomId),
        updateSessionState: (id, tenantId, expectedState, nextState, endedAtMs) =>
            updateSessionStateRow(conn, id, tenantId, expectedState, nextState, endedAtMs),
        admitParticipant: (input) => admitParticipantRow(conn, input),
        upsertParticipant: (row) => upsertParticipantRow(conn, row),
        markParticipantLeft: (sessionId, userId, leftAtMs, tenantId) =>
            markParticipantLeftRow(conn, sessionId, userId, leftAtMs, tenantId),
        listParticipants: (sessionId, tenantId) => listParticipantRows(conn, sessionId, tenantId),
        insertCallback: (row) => insertCallbackRow(conn, row),
        finalizeCallback: (id, outcome, tenantId) => finalizeCallbackRow(conn, id, outcome, tenantId),
        recordAudit: (input) => recordSealedAudit(conn, sealedAudit, input),
        ...createLivePresenceSqlMethods(conn),
    };
    if (options.presenceCursor !== 'declared') return unit;
    return {
        ...unit,
        readPresenceCursor: (tenantId, sessionId, participantId) =>
            readPresenceCursorRow(conn, tenantId, sessionId, participantId),
        advancePresenceCursor: (input) => advancePresenceCursorRow(conn, input),
    };
};

class LiveSessionSqlStoreImpl implements LiveSessionSqlStore {
    readonly presenceCursor: PresenceCursorReadiness;

    constructor(private readonly deps: LiveSessionSqlDeps) {
        if (!deps || !deps.executor || typeof deps.executor !== 'object') {
            throw new LiveSessionSqlError(
                'invalid_deps',
                'createLiveSessionSqlStore requires a connection-bound executor',
            );
        }
        const { executor, sealedAudit } = deps;
        if (typeof executor.query !== 'function'
            || typeof executor.queryOne !== 'function'
            || typeof executor.execute !== 'function'
            || typeof executor.transaction !== 'function') {
            throw new LiveSessionSqlError(
                'invalid_deps',
                'the executor must provide query, queryOne, execute and transaction on ONE connection',
            );
        }
        // Required, never a no-op and never a plain audit_events INSERT.
        if (typeof sealedAudit !== 'function') {
            throw new LiveSessionSqlError(
                'invalid_deps',
                'createLiveSessionSqlStore requires a sealed audit writer; there is no fallback',
            );
        }
        // Anything other than the exact attestation is "not declared": a truthy
        // or misspelled value must not enable ordered callbacks.
        this.presenceCursor = deps.presenceCursor === 'declared' ? 'declared' : 'unconfigured';
    }

    private withSqlUnit<T>(work: (unit: LiveSessionSqlUnit) => Promise<T>): Promise<T> {
        return this.deps.executor.transaction((conn) => work(createLiveSessionSqlUnit(
            conn,
            this.deps.sealedAudit,
            { presenceCursor: this.presenceCursor },
        )));
    }

    withTransaction<T>(work: (unit: LiveSessionUnit) => Promise<T>): Promise<T> {
        return this.withSqlUnit(work);
    }

    /* Reads run as a single tenant-scoped statement (contract §2: read paths
     * take no unit). Writes always run inside one, even when called on the
     * store rather than through a unit, so no statement is ever autocommitted. */

    insertSession(row: NewLiveSession): Promise<void> {
        return this.withSqlUnit((unit) => unit.insertSession(row));
    }

    findSession(id: string, tenantId: string): Promise<LiveSessionRecord | null> {
        return findSessionRow(this.deps.executor, id, tenantId);
    }

    findSessionByProvider(provider: string, providerRoomId: string): Promise<LiveSessionRecord | null> {
        return findSessionByProviderRow(this.deps.executor, provider, providerRoomId);
    }

    updateSessionState(
        id: string,
        tenantId: string,
        expectedState: LiveSessionState,
        nextState: LiveSessionState,
        endedAtMs: number | null,
    ): Promise<number> {
        return this.withSqlUnit((unit) => unit.updateSessionState(id, tenantId, expectedState, nextState, endedAtMs));
    }

    admitParticipant(input: ParticipantAdmissionInput): Promise<ParticipantAdmission> {
        return this.withSqlUnit((unit) => unit.admitParticipant(input));
    }

    upsertParticipant(row: LiveParticipantRecord): Promise<{ created: boolean }> {
        return this.withSqlUnit((unit) => unit.upsertParticipant(row));
    }

    markParticipantLeft(sessionId: string, userId: string, leftAtMs: number, tenantId?: string): Promise<number> {
        return this.withSqlUnit((unit) => unit.markParticipantLeft(sessionId, userId, leftAtMs, tenantId));
    }

    listParticipants(sessionId: string, tenantId: string): Promise<LiveParticipantRecord[]> {
        return listParticipantRows(this.deps.executor, sessionId, tenantId);
    }

    insertCallback(row: LiveCallbackRow): Promise<boolean> {
        return this.withSqlUnit((unit) => unit.insertCallback(row));
    }

    finalizeCallback(id: string, outcome: string, tenantId?: string): Promise<number> {
        return this.withSqlUnit((unit) => unit.finalizeCallback(id, outcome, tenantId));
    }

    recordAudit(input: AuditRecordInput): Promise<void> {
        return this.withSqlUnit((unit) => unit.recordAudit(input));
    }

    openPresenceInterval(input: OpenPresenceIntervalInput): Promise<OpenPresenceIntervalResult> {
        return this.withSqlUnit((unit) => unit.openPresenceInterval(input));
    }

    closePresenceInterval(input: ClosePresenceIntervalInput): Promise<ClosePresenceIntervalResult> {
        return this.withSqlUnit((unit) => unit.closePresenceInterval(input));
    }

    listPresenceIntervals(sessionId: string, tenantId: string): Promise<PresenceIntervalRecord[]> {
        return createLivePresenceSqlMethods(this.deps.executor).listPresenceIntervals(sessionId, tenantId);
    }

    /* Store-level cursor access opens ONE unit, like every other write here, and
     * binds the method to the unit that owns the connection — the port member is
     * never extracted and called detached. The core drives these through
     * `withTransaction`; these exist so the capability is truthful at both
     * levels instead of being advertised and absent. */

    readPresenceCursor(
        tenantId: string,
        sessionId: string,
        participantId: string,
    ): Promise<PresenceEventCursor | null> {
        return this.withSqlUnit((unit) => {
            const read = unit.readPresenceCursor;
            if (typeof read !== 'function') {
                throw new LiveSessionSqlError(
                    'schema_unavailable',
                    'the presence cursor is not declared on this store (R22); ordered callbacks stay disabled',
                );
            }
            return read.call(unit, tenantId, sessionId, participantId);
        });
    }

    advancePresenceCursor(input: AdvancePresenceCursorInput): Promise<number> {
        return this.withSqlUnit((unit) => {
            const advance = unit.advancePresenceCursor;
            if (typeof advance !== 'function') {
                throw new LiveSessionSqlError(
                    'schema_unavailable',
                    'the presence cursor is not declared on this store (R22); ordered callbacks stay disabled',
                );
            }
            return advance.call(unit, input);
        });
    }
}

/**
 * Build the durable store. Throws before any statement when the executor or the
 * sealed audit writer is missing; the adapter never owns a pool and never
 * writes an audit outside the chain.
 */
export const createLiveSessionSqlStore = (deps: LiveSessionSqlDeps): LiveSessionSqlStore =>
    new LiveSessionSqlStoreImpl(deps);
