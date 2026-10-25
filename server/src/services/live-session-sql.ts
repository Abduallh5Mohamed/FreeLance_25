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
     * throws `unreadable_affected_rows`, because 0 is reserved for a genuine
     * miss and would otherwise be indistinguishable from a lost CAS.
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
     * A CAS statement returned without a usable `affectedRows`. It is NOT a
     * lost race: the write may have landed, so it must not be reported as
     * `conflict` / `claim-held` / `claim-lost` with no audit. Thrown inside the
     * unit, so the caller sees a failure instead of a fabricated 0.
     */
    | 'unreadable_affected_rows'
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

/**
 * The affected-row count of a CAS, or a throw.
 *
 * `undefined` is neither zero (which would drop a change that happened) nor one
 * (which would fabricate a change that did not), so an unreadable count is a
 * fault and is thrown — never coerced with `?? 0`. Coercing it reported a
 * COMMITTED state transition as `conflict` and suppressed its audit, reported a
 * won presence-cursor CAS as `ignored:stale-event`, and reported a landed
 * callback finalisation as a conflict. `0` stays a genuine miss; the caller
 * decides what a legitimate zero means.
 */
const affectedOf = (result: { affectedRows?: number }): number => {
    const affected = result?.affectedRows;
    if (typeof affected !== 'number' || !Number.isSafeInteger(affected) || affected < 0) {
        throw new LiveSessionSqlError(
            'unreadable_affected_rows',
            'the CAS statement did not report a usable affected-row count',
        );
    }
    return affected;
};

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
 * WHAT `verified` NOW MEANS — SHAPE, NOT NAMES.
 *
 * An earlier revision granted `verified` from column NAMES alone (plus the
 * presence-event collation). A `VARCHAR(64)` where the contract says
 * `VARCHAR(128)`, a nullable column that must be NOT NULL, a UNIQUE key that
 * was recreated without its second column, a CHECK that exists but is
 * `NOT ENFORCED`, or a composite FK whose tenant column was dropped all passed
 * that test. They no longer do. `verified` for an area now requires, from the
 * injected catalog:
 *
 *   - COLUMNS: every required column present, with the declared DATA_TYPE,
 *     length, charset/collation for text, signedness for integers, the declared
 *     enum vocabulary, the declared NULLability, no `EXTRA` (generated /
 *     auto-increment / on-update), and — for the R22 cursor pair — no DEFAULT;
 *   - STATISTICS: every required index present, `NON_UNIQUE` matching the
 *     declared uniqueness, no `SUB_PART` prefix, and the columns in the
 *     DECLARED ORDER (`SEQ_IN_INDEX`), because `(tenant_id, id)` and `(id,
 *     tenant_id)` are different keys for a composite tenant FK;
 *   - TABLE_CONSTRAINTS + CHECK_CONSTRAINTS: every required CHECK present, of
 *     type CHECK, `ENFORCED = 'YES'`, and still expressing the required
 *     PREDICATE — recognised structurally from `CHECK_CLAUSE` (see
 *     `checkShapeMatches`), never inferred from the constraint's name; and
 *     every CHECK the migrations DROP is still absent, because a surviving
 *     older constraint re-imposes the narrower vocabulary the replacement was
 *     introduced to widen (R23: `chk_live_callback_outcome` must be gone);
 *   - KEY_COLUMN_USAGE: every required foreign key present, with the declared
 *     referencing columns in order, the declared referenced table and columns
 *     in order, and `REFERENCED_TABLE_SCHEMA` equal to the schema this
 *     connection is actually using — that is the TENANT BOUNDARY: a child row
 *     cannot name another tenant's parent row.
 *
 * Anything the catalog cannot answer — a denied privilege, a missing
 * information_schema table, a server without `TABLE_CONSTRAINTS.ENFORCED`, an
 * unreadable `CHECK_CLAUSE`, a MariaDB that has no `utf8mb4_0900_bin` — makes
 * the affected area `unknown`. It NEVER makes it `verified`: an unmeasured fact
 * is held, not assumed.
 *
 * It is never awaited at module scope and never called from a constructor:
 * construction stays I/O-free and the caller decides when, and whether, to
 * measure. There is no `transaction` here either — verification reads the
 * catalog and is not a write unit.
 *
 * CONTRACT VERSION. Bumped from `live-schema-20261023-1` because a report now
 * means something strictly stronger than it did. Bumped again to
 * `live-schema-20261024-3` because a report now also asserts the ABSENCE of the
 * constraints the migrations replace, and because `CHECK_CLAUSE` recognition no
 * longer depends on whether MySQL happened to render the predicate with a
 * redundant outer pair of parentheses. A report produced under an older label is
 * not evidence for this claim, and an operational grant issued against the old
 * string is refused (`not-verified`) rather than re-read as if the tighter check
 * had run.
 */
export const LIVE_SCHEMA_CONTRACT_VERSION = 'live-schema-20261024-4';

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

/**
 * The expected SHAPE of one column, as the migrations declare it.
 *
 * A name proves nothing: `presence_event_id VARCHAR(64) utf8mb4_unicode_ci` has
 * the right name and the wrong identity, and `tenant_id CHAR(36) NULL` has the
 * right name and cannot carry a tenant boundary. Every requirement therefore
 * carries the type, the length, the charset/collation where the column is text,
 * the signedness where the column is numeric, and the nullability.
 */
type ExpectedColumnType =
    | { readonly kind: 'char'; readonly length: number; readonly charset: string; readonly collation: string }
    | { readonly kind: 'varchar'; readonly length: number; readonly charset: string; readonly collation: string }
    | { readonly kind: 'bigint'; readonly unsigned: boolean }
    | { readonly kind: 'int'; readonly unsigned: boolean }
    | { readonly kind: 'enum'; readonly values: readonly string[] };

interface ColumnRequirement {
    readonly column: string;
    readonly nullable: boolean;
    readonly type: ExpectedColumnType;
    /**
     * `true` ⇒ the column must declare no DEFAULT at all
     * (`information_schema.COLUMNS.COLUMN_DEFAULT IS NULL`). Used for the R22
     * cursor pair, whose migration refuses a defaulted column as drift.
     */
    readonly noDefault?: boolean;
}

interface TableColumnsRequirement {
    readonly table: string;
    readonly columns: readonly ColumnRequirement[];
}

/** One index as the migrations declare it: name, uniqueness and COLUMN ORDER. */
interface IndexRequirement {
    readonly table: string;
    readonly name: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
}

/**
 * The predicate a CHECK must still express, independent of how MySQL renders
 * `CHECK_CLAUSE` back. Recognition is structural (`checkShapeMatches`), so a
 * constraint that keeps the right NAME but loses half its predicate is
 * reported, never accepted.
 */
type CheckShape =
    | { readonly kind: 'pair'; readonly left: string; readonly right: string }
    | { readonly kind: 'equivalence'; readonly column: string; readonly value: string; readonly nonNullColumn: string }
    | { readonly kind: 'between'; readonly column: string; readonly min: string; readonly max: string }
    | { readonly kind: 'atMost'; readonly column: string; readonly max: string }
    | { readonly kind: 'nullOrAtMost'; readonly column: string; readonly max: string }
    | { readonly kind: 'membership'; readonly column: string; readonly values: readonly string[] }
    | {
        readonly kind: 'release';
        readonly column: string;
        readonly pendingValue: string;
        readonly columns: readonly string[];
    };

/** One CHECK as the migrations declare it: name plus the predicate it must hold. */
interface CheckRequirement {
    readonly table: string;
    readonly name: string;
    readonly shape: CheckShape;
}

/**
 * One foreign key, including the TENANT BOUNDARY it enforces.
 *
 * `columns` starts with `tenant_id` for every child table in this lane, and the
 * referenced columns are the parent's `(tenant_id, id)` pair — that is what
 * makes "a participant of tenant A can never point at tenant B's session" a
 * database fact instead of a convention.
 */
interface ForeignKeyRequirement {
    readonly table: string;
    readonly name: string;
    readonly columns: readonly string[];
    readonly referencedTable: string;
    readonly referencedColumns: readonly string[];
}

/** One area's full expected shape. */
interface AreaSpec {
    readonly tables: readonly string[];
    readonly columns: readonly TableColumnsRequirement[];
    readonly indexes: readonly IndexRequirement[];
    readonly checks: readonly CheckRequirement[];
    /**
     * Constraints a LATER migration removes. Their presence is a proven
     * mismatch, not a tolerated extra: a surviving older CHECK is still
     * enforced, and a narrower vocabulary that the replacement widened would
     * reject the values this lane writes. Asserted by ABSENCE so a half-applied
     * migration cannot report `verified`.
     */
    readonly forbiddenChecks: readonly { readonly table: string; readonly name: string }[];
    readonly foreignKeys: readonly ForeignKeyRequirement[];
    /** Facts this area asserts by ABSENCE, recorded so nothing stays silent. */
    readonly notes: readonly string[];
}

const LIVE_SCHEMA_TABLES = [
    'live_sessions',
    'live_session_presence_intervals',
    'live_session_participants',
    'live_session_callbacks',
    'live_recording_ingests',
    'live_recovery_checkpoints',
] as const;

/* ---------- expected shape, transcribed from the migrations ---------- */

/**
 * The live tables are `utf8mb4 / utf8mb4_unicode_ci` (20261022_06). The two
 * byte-exact identities — the R22 cursor and the R24 checkpoint keys — are
 * `utf8mb4_0900_bin`, and that difference is the whole point of F2: under a PAD
 * collation `'evt-1'` and `'evt-1 '` are one identity.
 */
const TABLE_CHARSET = 'utf8mb4' as const;
const TABLE_COLLATION = 'utf8mb4_unicode_ci' as const;

const charColumn = (column: string, length: number, nullable = false): ColumnRequirement => ({
    column,
    nullable,
    type: { kind: 'char', length, charset: TABLE_CHARSET, collation: TABLE_COLLATION },
});

const varcharColumn = (
    column: string,
    length: number,
    options?: { readonly nullable?: boolean; readonly collation?: string; readonly noDefault?: boolean },
): ColumnRequirement => ({
    column,
    nullable: options?.nullable === true,
    type: {
        kind: 'varchar',
        length,
        charset: TABLE_CHARSET,
        collation: options?.collation ?? TABLE_COLLATION,
    },
    ...(options?.noDefault === true ? { noDefault: true } : {}),
});

const bigintColumn = (
    column: string,
    options?: { readonly nullable?: boolean; readonly unsigned?: boolean; readonly noDefault?: boolean },
): ColumnRequirement => ({
    column,
    nullable: options?.nullable === true,
    type: { kind: 'bigint', unsigned: options?.unsigned === true },
    ...(options?.noDefault === true ? { noDefault: true } : {}),
});

const intColumn = (
    column: string,
    options?: { readonly nullable?: boolean; readonly unsigned?: boolean },
): ColumnRequirement => ({
    column,
    nullable: options?.nullable === true,
    type: { kind: 'int', unsigned: options?.unsigned === true },
});

const enumColumn = (column: string, values: readonly string[], nullable = false): ColumnRequirement => ({
    column,
    nullable,
    type: { kind: 'enum', values },
});

/** The R23 vocabulary, exactly as `20261023_02` installs it. */
const LIVE_CALLBACK_OUTCOMES: readonly string[] = [
    'pending',
    'applied',
    'rejected:illegal-transition',
    'ignored:unknown-participant',
    'ignored:malformed',
    'ignored:mapping-unavailable',
    'ignored:ordering-unavailable',
    'ignored:stale-event',
    'ignored:ambiguous-event',
];

/**
 * `live_sessions` + `live_session_participants` + `live_session_callbacks`,
 * with the columns, keys, CHECKs and tenant FKs of 20261022_06 (plus the R23
 * outcome CHECK of 20261023_02).
 *
 * The R22 cursor columns are deliberately NOT required here: this area must be
 * verifiable on a database where 20261023_02 has not been applied, and a
 * session can be created, found and transitioned without an ordering cursor.
 */
const SESSION_LIFECYCLE_SPEC: AreaSpec = {
    tables: ['live_sessions', 'live_session_participants', 'live_session_callbacks'],
    columns: [
        {
            table: 'live_sessions',
            columns: [
                charColumn('id', 36),
                charColumn('tenant_id', 36),
                charColumn('host_user_id', 36),
                varcharColumn('title', 200),
                enumColumn('state', ['scheduled', 'live', 'ended', 'cancelled']),
                varcharColumn('provider', 128, { nullable: true }),
                varcharColumn('provider_room_id', 128, { nullable: true }),
                bigintColumn('starts_at_ms'),
                bigintColumn('ended_at_ms', { nullable: true }),
                intColumn('max_participants', { unsigned: true }),
                bigintColumn('created_at_ms'),
            ],
        },
        {
            table: 'live_session_participants',
            columns: [
                charColumn('id', 36),
                charColumn('tenant_id', 36),
                charColumn('session_id', 36),
                charColumn('user_id', 36),
                enumColumn('role', ['host', 'cohost', 'participant']),
                charColumn('ticket_fingerprint', 64),
                bigintColumn('joined_at_ms'),
                bigintColumn('last_seen_at_ms'),
                bigintColumn('left_at_ms', { nullable: true }),
            ],
        },
        {
            table: 'live_session_callbacks',
            columns: [
                charColumn('id', 36),
                charColumn('tenant_id', 36),
                charColumn('session_id', 36),
                varcharColumn('provider', 128),
                varcharColumn('event_id', 128),
                varcharColumn('kind', 32),
                bigintColumn('occurred_at_ms'),
                varcharColumn('outcome', 48),
            ],
        },
    ],
    indexes: [
        { table: 'live_sessions', name: 'PRIMARY', unique: true, columns: ['id'] },
        {
            table: 'live_sessions',
            name: 'uq_live_session_id_tenant',
            unique: true,
            columns: ['tenant_id', 'id'],
        },
        {
            table: 'live_sessions',
            name: 'uq_live_session_room',
            unique: true,
            columns: ['provider', 'provider_room_id'],
        },
        {
            table: 'live_sessions',
            name: 'idx_live_sessions_tenant',
            unique: false,
            columns: ['tenant_id', 'state', 'starts_at_ms'],
        },
        { table: 'live_session_participants', name: 'PRIMARY', unique: true, columns: ['id'] },
        {
            table: 'live_session_participants',
            name: 'uq_live_participant',
            unique: true,
            columns: ['session_id', 'user_id'],
        },
        {
            table: 'live_session_participants',
            name: 'uq_live_participant_tenant',
            unique: true,
            columns: ['tenant_id', 'session_id', 'id'],
        },
        {
            table: 'live_session_participants',
            name: 'idx_live_participant_active',
            unique: false,
            columns: ['session_id', 'left_at_ms'],
        },
        { table: 'live_session_callbacks', name: 'PRIMARY', unique: true, columns: ['id'] },
        {
            table: 'live_session_callbacks',
            name: 'uq_live_callback',
            unique: true,
            columns: ['tenant_id', 'provider', 'event_id'],
        },
        {
            table: 'live_session_callbacks',
            name: 'idx_live_callback_session',
            unique: false,
            columns: ['tenant_id', 'session_id'],
        },
    ],
    checks: [
        {
            table: 'live_sessions',
            name: 'chk_live_session_ended',
            shape: { kind: 'equivalence', column: 'state', value: 'ended', nonNullColumn: 'ended_at_ms' },
        },
        {
            table: 'live_sessions',
            name: 'chk_live_session_max_participants',
            shape: { kind: 'between', column: 'max_participants', min: '1', max: '5000' },
        },
        {
            table: 'live_session_callbacks',
            name: 'chk_live_callback_outcome_v2',
            shape: { kind: 'membership', column: 'outcome', values: LIVE_CALLBACK_OUTCOMES },
        },
    ],
    /**
     * R23 REPLACES this CHECK (`20261023_02`, line 328 / 387: `DROP CHECK
     * chk_live_callback_outcome`), and the migration's own final guard treats
     * `@c6_oc_old_end = 1` as drift (line 421). It must therefore be GONE: while
     * it exists it is still enforced and still admits only the five original
     * values, so the four `ignored:*` outcomes this adapter writes would raise
     * 3819 at runtime. Its absence is a required fact, not a nicety.
     */
    forbiddenChecks: [
        { table: 'live_session_callbacks', name: 'chk_live_callback_outcome' },
    ],
    foreignKeys: [
        {
            table: 'live_sessions',
            name: 'fk_live_session_tenant',
            columns: ['tenant_id'],
            referencedTable: 'tenants',
            referencedColumns: ['id'],
        },
        {
            table: 'live_session_participants',
            name: 'fk_live_participant_tenant',
            columns: ['tenant_id'],
            referencedTable: 'tenants',
            referencedColumns: ['id'],
        },
        {
            table: 'live_session_participants',
            name: 'fk_live_participant_session',
            columns: ['tenant_id', 'session_id'],
            referencedTable: 'live_sessions',
            referencedColumns: ['tenant_id', 'id'],
        },
        {
            table: 'live_session_callbacks',
            name: 'fk_live_callback_tenant',
            columns: ['tenant_id'],
            referencedTable: 'tenants',
            referencedColumns: ['id'],
        },
        {
            table: 'live_session_callbacks',
            name: 'fk_live_callback_session',
            columns: ['tenant_id', 'session_id'],
            referencedTable: 'live_sessions',
            referencedColumns: ['tenant_id', 'id'],
        },
    ],
    notes: [],
};

/**
 * The R22 cursor pair and its paired-NULL CHECK, from `20261023_02`.
 *
 * Both columns are nullable BY CONTRACT (existing rows stay NULL/NULL — no
 * backfill), and the migration refuses a DEFAULT on either, so a defaulted
 * column is reported as drift rather than accepted as "equivalent".
 */
const PRESENCE_ORDERING_SPEC: AreaSpec = {
    tables: ['live_session_participants', 'live_session_presence_intervals'],
    columns: [
        { table: 'live_session_presence_intervals', columns: [
            charColumn('id', 36), charColumn('tenant_id', 36),
            charColumn('session_id', 36), charColumn('participant_id', 36),
            charColumn('user_id', 36), bigintColumn('joined_at_ms'),
            bigintColumn('left_at_ms', { nullable: true }),
            enumColumn('close_reason', ['leave', 'callback', 'session-ended'], true),
        ] },
        {
            table: 'live_session_participants',
            columns: [
                bigintColumn('presence_event_at_ms', { nullable: true, noDefault: true }),
                varcharColumn('presence_event_id', 128, {
                    nullable: true,
                    collation: PRESENCE_EVENT_ID_COLLATION,
                    noDefault: true,
                }),
            ],
        },
    ],
    indexes: [
        { table: 'live_session_presence_intervals', name: 'PRIMARY', unique: true, columns: ['id'] },
        { table: 'live_session_presence_intervals', name: 'uq_presence_interval', unique: true, columns: ['session_id', 'user_id', 'joined_at_ms'] },
        { table: 'live_session_presence_intervals', name: 'idx_presence_open', unique: false, columns: ['session_id', 'user_id', 'left_at_ms'] },
        { table: 'live_session_presence_intervals', name: 'idx_presence_participant', unique: false, columns: ['tenant_id', 'session_id', 'participant_id'] },
    ],
    checks: [
        { table: 'live_session_presence_intervals', name: 'chk_presence_left_reason', shape: { kind: 'pair', left: 'left_at_ms', right: 'close_reason' } },
        {
            table: 'live_session_participants',
            name: 'chk_live_participant_cursor_pair',
            shape: { kind: 'pair', left: 'presence_event_at_ms', right: 'presence_event_id' },
        },
    ],
    forbiddenChecks: [],
    foreignKeys: [
        { table: 'live_session_presence_intervals', name: 'fk_presence_tenant', columns: ['tenant_id'], referencedTable: 'tenants', referencedColumns: ['id'] },
        { table: 'live_session_presence_intervals', name: 'fk_presence_participant', columns: ['tenant_id', 'session_id', 'participant_id'], referencedTable: 'live_session_participants', referencedColumns: ['tenant_id', 'session_id', 'id'] },
    ],
    notes: [],
};

/**
 * The identity contract of `presence_event_id`: VARCHAR(128), utf8mb4, and a
 * collation that is both BINARY and NO PAD.
 *
 * The column shape is proven from COLUMNS; the pad attribute is a server-level
 * fact read from COLLATIONS. Neither is inferred from the collation's NAME.
 */
const PRESENCE_EVENT_IDENTITY_SPEC: AreaSpec = {
    tables: ['live_session_participants'],
    columns: [
        {
            table: 'live_session_participants',
            columns: [
                varcharColumn('presence_event_id', 128, {
                    nullable: true,
                    collation: PRESENCE_EVENT_ID_COLLATION,
                    noDefault: true,
                }),
            ],
        },
    ],
    indexes: [],
    checks: [],
    forbiddenChecks: [],
    foreignKeys: [],
    notes: [],
};

/**
 * `live_recording_ingests`, from 20261022_06: the R12 fencing lease, the R14
 * pending index, both dedupe keys and both tenant-bound foreign keys.
 */
const INGEST_LEDGER_SPEC: AreaSpec = {
    tables: ['live_recording_ingests'],
    columns: [
        {
            table: 'live_recording_ingests',
            columns: [
                charColumn('id', 36),
                charColumn('tenant_id', 36),
                charColumn('session_id', 36),
                varcharColumn('provider', 128),
                varcharColumn('event_id', 128),
                varcharColumn('provider_recording_id', 128),
                intColumn('duration_seconds', { unsigned: true }),
                bigintColumn('storage_bytes', { unsigned: true }),
                bigintColumn('occurred_at_ms'),
                varcharColumn('outcome', 32),
                varcharColumn('claim_owner', 64, { nullable: true }),
                bigintColumn('claim_expires_at_ms', { nullable: true }),
            ],
        },
    ],
    indexes: [
        { table: 'live_recording_ingests', name: 'PRIMARY', unique: true, columns: ['id'] },
        {
            table: 'live_recording_ingests',
            name: 'uq_ingest_event',
            unique: true,
            columns: ['tenant_id', 'provider', 'event_id'],
        },
        {
            table: 'live_recording_ingests',
            name: 'uq_ingest_recording',
            unique: true,
            columns: ['tenant_id', 'provider', 'provider_recording_id'],
        },
        {
            table: 'live_recording_ingests',
            name: 'idx_live_ingest_pending',
            unique: false,
            columns: ['outcome', 'claim_expires_at_ms'],
        },
        {
            table: 'live_recording_ingests',
            name: 'idx_live_ingest_session',
            unique: false,
            columns: ['tenant_id', 'session_id'],
        },
    ],
    checks: [
        {
            table: 'live_recording_ingests',
            name: 'chk_live_ingest_lease_pair',
            shape: { kind: 'pair', left: 'claim_owner', right: 'claim_expires_at_ms' },
        },
        {
            table: 'live_recording_ingests',
            name: 'chk_live_ingest_terminal_release',
            shape: {
                kind: 'release',
                column: 'outcome',
                pendingValue: 'pending',
                columns: ['claim_owner', 'claim_expires_at_ms'],
            },
        },
    ],
    forbiddenChecks: [],
    foreignKeys: [
        {
            table: 'live_recording_ingests',
            name: 'fk_live_ingest_tenant',
            columns: ['tenant_id'],
            referencedTable: 'tenants',
            referencedColumns: ['id'],
        },
        {
            table: 'live_recording_ingests',
            name: 'fk_live_ingest_session',
            columns: ['tenant_id', 'session_id'],
            referencedTable: 'live_sessions',
            referencedColumns: ['tenant_id', 'id'],
        },
    ],
    notes: [],
};

/**
 * R24 — `live_recovery_checkpoints`, from `20261024_04`.
 *
 * `purpose` is the ONLY key and the row is addressed by it alone, so the table
 * carries no `tenant_id` and no foreign key BY DESIGN. That absence is asserted
 * in `notes` rather than left implicit: a reviewer looking for a tenant boundary
 * here must find a statement that there is none, not silence.
 */
const RECOVERY_CHECKPOINT_SPEC: AreaSpec = {
    tables: ['live_recovery_checkpoints'],
    columns: [
        {
            table: 'live_recovery_checkpoints',
            columns: [
                varcharColumn('purpose', 64, { collation: PRESENCE_EVENT_ID_COLLATION }),
                bigintColumn('cursor_occurred_at_ms', { nullable: true }),
                varcharColumn('cursor_id', 64, { nullable: true, collation: PRESENCE_EVENT_ID_COLLATION }),
                varcharColumn('owner', 128, { nullable: true, collation: PRESENCE_EVENT_ID_COLLATION }),
                bigintColumn('lease_expires_at_ms', { nullable: true }),
                bigintColumn('row_version', { unsigned: true }),
                bigintColumn('sweep_generation', { unsigned: true }),
                bigintColumn('updated_at_ms'),
            ],
        },
    ],
    indexes: [
        { table: 'live_recovery_checkpoints', name: 'PRIMARY', unique: true, columns: ['purpose'] },
    ],
    checks: [
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_cursor_pair',
            shape: { kind: 'pair', left: 'cursor_occurred_at_ms', right: 'cursor_id' },
        },
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_lease_pair',
            shape: { kind: 'pair', left: 'owner', right: 'lease_expires_at_ms' },
        },
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_cursor_ms',
            shape: { kind: 'nullOrAtMost', column: 'cursor_occurred_at_ms', max: '9007199254740991' },
        },
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_lease_ms',
            shape: { kind: 'nullOrAtMost', column: 'lease_expires_at_ms', max: '9007199254740991' },
        },
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_version',
            shape: { kind: 'between', column: 'row_version', min: '1', max: '9007199254740991' },
        },
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_generation',
            shape: { kind: 'between', column: 'sweep_generation', min: '0', max: '9007199254740991' },
        },
        {
            table: 'live_recovery_checkpoints',
            name: 'chk_live_recovery_changed_ms',
            shape: { kind: 'atMost', column: 'updated_at_ms', max: '9007199254740991' },
        },
    ],
    forbiddenChecks: [],
    foreignKeys: [],
    notes: [
        'live_recovery_checkpoints has no tenant_id and no foreign key BY DESIGN: '
            + 'one row is the one global sweep and every statement addresses it by purpose alone',
    ],
};

/** Cap on names quoted in one reason, so a reason stays a fact and not a dump. */
const MAX_MISSING_NAMES = 8;

const LIVE_SCHEMA_LIMITS: readonly string[] = [
    'A CHECK is recognised from CHECK_CLAUSE after a fixed normalisation (lower-case, backticks and '
        + 'space/tab/CR/LF removed, charset introducers removed, one REDUNDANT outer parenthesis pair removed, '
        + 'inner grouping PRESERVED). A rendering MySQL changes beyond that set is reported as absent WITH the '
        + 'normalised clause quoted, never accepted: fail closed, and diagnosable. It is not a check that the '
        + 'row data satisfies the predicate.',
    'CHECK recognition accepts the predicate the migration declares, not an equivalent rewrite: `BETWEEN 1 AND 5000` '
        + 'is not matched against `>= 1 AND <= 5000`, and a renamed constraint is reported absent. The operator '
        + 'reconciles the object rather than the verifier guessing equivalence.',
    'Foreign keys are matched by the NAME the migrations declare. An equivalent FK under a different name is '
        + 'reported absent; the operator reconciles the name rather than the verifier guessing equivalence.',
    'ENFORCED requires MySQL 8.0.16+ and CHECK_CLAUSE requires CHECK_CONSTRAINTS; on a server that lacks '
        + 'either, the affected areas are unknown and no CHECK is claimed.',
    'Byte preservation of presence_event_id follows from the binary, NO PAD collation contract; '
        + 'this verifier reads that contract from metadata but does not measure stored bytes.',
    'This is a snapshot at checkedAtMs: nothing prevents DDL from running after it, '
        + 'so freshness is the responsibility of the caller or the factory, not a claim of this report.',
    'A catalog read that fails (privilege, connection, missing information_schema table) yields '
        + 'unknown rather than absent; the area reason names the failure. The same holds when DATABASE() is '
        + 'unreadable: every schema-scoped read then returns no rows, which is not evidence of absence.',
    'The verifier reads metadata only: it writes no probe row and therefore cannot prove that the driver '
        + 'maps BIGINT exactly (supportBigNumbers/bigNumberStrings is a caller obligation).',
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

/* ---------- catalog reads ---------- */

/**
 * The result of ONE catalog read.
 *
 * `ok: false` is not an empty result: it means the fact was NOT MEASURED, and
 * every area that needs it becomes `unknown`. Collapsing a failed read into
 * "nothing found" would turn a denied privilege into `absent`, and collapsing it
 * into an empty map would turn it into `verified` — both are the defect this
 * correction removes.
 */
type CatalogRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

interface CatalogColumn {
    readonly dataType: string;
    readonly columnType: string;
    readonly unsigned: boolean;
    readonly nullable: boolean;
    readonly charLength: number | null;
    readonly charset: string | null;
    readonly collation: string | null;
    readonly hasDefault: boolean;
    readonly extra: string;
}

interface CatalogIndex {
    /**
     * `true` UNIQUE, `false` not unique, `null` when `NON_UNIQUE` could not be
     * read. Tri-state on purpose: an unreadable flag is not proof that a
     * required UNIQUE key lost its uniqueness, and coercing it to `false`
     * reported a valid deployment as `absent`.
     */
    readonly unique: boolean | null;
    readonly prefixed: boolean;
    readonly columns: readonly string[];
}

interface CatalogConstraint {
    readonly type: string;
    /** `null` when ENFORCED could not be read — held, not assumed either way. */
    readonly enforced: boolean | null;
}

interface CatalogForeignKey {
    readonly columns: readonly string[];
    readonly referencedSchema: string | null;
    readonly referencedTable: string | null;
    readonly referencedColumns: readonly (string | null)[];
}

interface CatalogSnapshot {
    readonly database: CatalogRead<string>;
    readonly serverVersion: string | null;
    readonly tables: CatalogRead<ReadonlySet<string>>;
    readonly columns: CatalogRead<ReadonlyMap<string, ReadonlyMap<string, CatalogColumn>>>;
    readonly indexes: CatalogRead<ReadonlyMap<string, CatalogIndex>>;
    readonly constraints: CatalogRead<ReadonlyMap<string, CatalogConstraint>>;
    readonly checkClauses: CatalogRead<ReadonlyMap<string, string | null>>;
    readonly foreignKeys: CatalogRead<ReadonlyMap<string, CatalogForeignKey>>;
    readonly padAttribute: CatalogRead<string>;
}

const readCatalog = async <T>(work: () => Promise<T>): Promise<CatalogRead<T>> => {
    try {
        return { ok: true, value: await work() };
    } catch (error) {
        return { ok: false, reason: describeCatalogError(error) };
    }
};

const readCatalogInt = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
};

const catalogKey = (table: string, name: string): string => `${table}\u0000${name}`;

/** `enum('a','b')` → `['a', 'b']`; anything else → `[]`. */
const parseEnumValues = (columnType: string): readonly string[] => {
    const match = /^enum\((.*)\)$/i.exec(columnType.trim());
    if (match === null) return [];
    return match[1]
        .split(',')
        .map((part) => part.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'"));
};

const buildColumnIndex = (
    rows: readonly Record<string, unknown>[],
): Map<string, Map<string, CatalogColumn>> => {
    const index = new Map<string, Map<string, CatalogColumn>>();
    for (const row of rows) {
        const table = readCatalogText(row.TABLE_NAME);
        const column = readCatalogText(row.COLUMN_NAME);
        const dataType = readCatalogText(row.DATA_TYPE);
        if (table === null || column === null || dataType === null) continue;
        let tableColumns = index.get(table);
        if (!tableColumns) {
            tableColumns = new Map<string, CatalogColumn>();
            index.set(table, tableColumns);
        }
        const columnType = readCatalogText(row.COLUMN_TYPE) ?? '';
        tableColumns.set(column, {
            dataType: dataType.toLowerCase(),
            columnType,
            unsigned: /\bunsigned\b/i.test(columnType),
            nullable: readCatalogText(row.IS_NULLABLE) === 'YES',
            charLength: readCatalogInt(row.CHARACTER_MAXIMUM_LENGTH),
            charset: readCatalogText(row.CHARACTER_SET_NAME),
            collation: readCatalogText(row.COLLATION_NAME),
            hasDefault: row.COLUMN_DEFAULT !== null && row.COLUMN_DEFAULT !== undefined,
            extra: (readCatalogText(row.EXTRA) ?? '').toLowerCase(),
        });
    }
    return index;
};

/**
 * One row per INDEX COLUMN, so the columns are ordered by `SEQ_IN_INDEX` and
 * the index is unique only when EVERY row says `NON_UNIQUE = 0`.
 */
const buildIndexIndex = (
    rows: readonly Record<string, unknown>[],
): Map<string, CatalogIndex> => {
    const collected = new Map<
        string,
        { unique: boolean | null; prefixed: boolean; parts: { position: number; column: string }[] }
    >();
    for (const row of rows) {
        const table = readCatalogText(row.TABLE_NAME);
        const name = readCatalogText(row.INDEX_NAME);
        const column = readCatalogText(row.COLUMN_NAME);
        const position = readCatalogInt(row.SEQ_IN_INDEX);
        if (table === null || name === null || column === null || position === null) continue;
        const key = catalogKey(table, name);
        let entry = collected.get(key);
        if (!entry) {
            entry = { unique: true, prefixed: false, parts: [] };
            collected.set(key, entry);
        }
        const nonUnique = readCatalogInt(row.NON_UNIQUE);
        if (nonUnique === null) entry.unique = null;
        else if (nonUnique !== 0) entry.unique = false;
        // A prefix index (`provider(20)`) does not carry the full value, so it
        // cannot back an equality/join key even when its name is right.
        if (row.SUB_PART !== null && row.SUB_PART !== undefined) entry.prefixed = true;
        entry.parts.push({ position, column });
    }
    const index = new Map<string, CatalogIndex>();
    for (const [key, entry] of collected) {
        index.set(key, {
            unique: entry.unique,
            prefixed: entry.prefixed,
            columns: entry.parts.slice().sort((a, b) => a.position - b.position).map((part) => part.column),
        });
    }
    return index;
};

const buildConstraintIndex = (
    rows: readonly Record<string, unknown>[],
): Map<string, CatalogConstraint> => {
    const index = new Map<string, CatalogConstraint>();
    for (const row of rows) {
        const table = readCatalogText(row.TABLE_NAME);
        const name = readCatalogText(row.CONSTRAINT_NAME);
        const type = readCatalogText(row.CONSTRAINT_TYPE);
        if (table === null || name === null || type === null) continue;
        const enforcedText = readCatalogText(row.ENFORCED);
        index.set(catalogKey(table, name), {
            type: type.toUpperCase(),
            enforced: enforcedText === null ? null : enforcedText === 'YES',
        });
    }
    return index;
};

const buildForeignKeyIndex = (
    rows: readonly Record<string, unknown>[],
): Map<string, CatalogForeignKey> => {
    const collected = new Map<string, {
        parts: { position: number; column: string; referencedColumn: string | null }[];
        referencedSchema: string | null;
        referencedTable: string | null;
    }>();
    for (const row of rows) {
        const table = readCatalogText(row.TABLE_NAME);
        const name = readCatalogText(row.CONSTRAINT_NAME);
        const column = readCatalogText(row.COLUMN_NAME);
        const position = readCatalogInt(row.ORDINAL_POSITION);
        if (table === null || name === null || column === null || position === null) continue;
        const key = catalogKey(table, name);
        let entry = collected.get(key);
        if (!entry) {
            entry = { parts: [], referencedSchema: null, referencedTable: null };
            collected.set(key, entry);
        }
        entry.referencedSchema = readCatalogText(row.REFERENCED_TABLE_SCHEMA);
        entry.referencedTable = readCatalogText(row.REFERENCED_TABLE_NAME);
        entry.parts.push({
            position,
            column,
            referencedColumn: readCatalogText(row.REFERENCED_COLUMN_NAME),
        });
    }
    const index = new Map<string, CatalogForeignKey>();
    for (const [key, entry] of collected) {
        const ordered = entry.parts.slice().sort((a, b) => a.position - b.position);
        index.set(key, {
            columns: ordered.map((part) => part.column),
            referencedSchema: entry.referencedSchema,
            referencedTable: entry.referencedTable,
            referencedColumns: ordered.map((part) => part.referencedColumn),
        });
    }
    return index;
};

/* ---------- CHECK_CLAUSE recognition ---------- */

/**
 * The normalisation the migrations themselves use: lower-case, drop backticks
 * and space/tab/CR/LF, and drop charset introducers. Parentheses are PRESERVED —
 * stripping them would make `(a OR b) AND c` indistinguishable from
 * `a OR (b AND c)`, and those are different constraints.
 */
const normalizeCheckClause = (value: string): string =>
    value
        .toLowerCase()
        .split('`').join('')
        .split(' ').join('')
        .split('\t').join('')
        .split('\n').join('')
        .split('\r').join('')
        .replace(/_utf8mb4|_utf8mb3|_utf8|_binary/g, '');

/** Remove redundant OUTER parentheses only (a balanced pair spanning the text). */
const stripOuterParens = (value: string): string => {
    let text = value;
    for (;;) {
        if (text.length < 2 || !text.startsWith('(') || !text.endsWith(')')) return text;
        let depth = 0;
        let spans = true;
        for (let position = 0; position < text.length; position += 1) {
            if (text[position] === '(') depth += 1;
            else if (text[position] === ')') {
                depth -= 1;
                if (depth === 0 && position < text.length - 1) {
                    spans = false;
                    break;
                }
            }
        }
        if (!spans || depth !== 0) return text;
        text = text.slice(1, -1);
    }
};

/**
 * Split on the SINGLE top-level `=`. Returns `null` when the clause has no such
 * operator or more than one, so an `=` nested inside a sub-expression cannot be
 * mistaken for the top-level equivalence.
 */
const splitTopLevelEquals = (value: string): readonly [string, string] | null => {
    let depth = 0;
    let found = -1;
    for (let position = 0; position < value.length; position += 1) {
        const character = value[position];
        if (character === '(') depth += 1;
        else if (character === ')') depth -= 1;
        else if (character === '=' && depth === 0) {
            const before = value[position - 1];
            const after = value[position + 1];
            if (before === '<' || before === '>' || before === '!' || before === '=' || after === '=') continue;
            if (found !== -1) return null;
            found = position;
        }
    }
    if (found === -1) return null;
    return [value.slice(0, found), value.slice(found + 1)];
};

const andVariants = (left: string, right: string): readonly string[] => {
    const variants = new Set<string>();
    for (const l of [left, `(${left})`]) {
        for (const r of [right, `(${right})`]) {
            variants.add(`${l}and${r}`);
            variants.add(`(${l}and${r})`);
        }
    }
    return [...variants];
};

const orVariants = (left: string, right: string): readonly string[] => {
    const variants = new Set<string>();
    for (const l of [left, `(${left})`]) {
        for (const r of [right, `(${right})`]) {
            variants.add(`${l}or${r}`);
            variants.add(`(${l}or${r})`);
        }
    }
    return [...variants];
};

/**
 * Does this (normalised) clause still express the required predicate?
 *
 * Recognition is STRUCTURAL: the atoms must be the declared columns and
 * literals, in the declared grouping. A constraint that keeps its name and
 * loses a conjunct does not match, and a clause whose rendering falls outside
 * the accepted set is reported (with the clause quoted) rather than accepted.
 *
 * OUTER PARENTHESES ARE REMOVED FIRST, ONCE, FOR EVERY SHAPE. MySQL stores the
 * CHECK expression as written, so `CHECK (a BETWEEN 1 AND 5)` comes back as
 * `(a between 1 and 5)` while `CHECK ((a IS NULL) = (b IS NULL))` comes back as
 * `((a is null) = (b is null))`. Without this step the two flat shapes
 * (`between`, `atMost`, `nullOrAtMost`, `membership`) never matched the
 * parenthesised rendering and a perfectly valid deployment was reported
 * `absent` — a false negative, which is the same class of defect as a false
 * `verified`. Only a REDUNDANT outer pair is stripped (`stripOuterParens`
 * requires the pair to span the whole text), so `(a OR b) AND c` keeps its
 * grouping and no predicate is weakened.
 */
const checkShapeMatches = (rawClause: string, shape: CheckShape): boolean => {
    const clause = stripOuterParens(rawClause);
    switch (shape.kind) {
        case 'pair': {
            const sides = splitTopLevelEquals(clause);
            if (sides === null) return false;
            const left = `${shape.left}isnull`;
            const right = `${shape.right}isnull`;
            const first = stripOuterParens(sides[0]);
            const second = stripOuterParens(sides[1]);
            return (first === left && second === right) || (first === right && second === left);
        }
        case 'equivalence': {
            const sides = splitTopLevelEquals(clause);
            if (sides === null) return false;
            const value = `${shape.column}='${shape.value}'`;
            const nonNull = `${shape.nonNullColumn}isnotnull`;
            const first = stripOuterParens(sides[0]);
            const second = stripOuterParens(sides[1]);
            return (first === value && second === nonNull) || (first === nonNull && second === value);
        }
        case 'between': {
            const match = /^([a-z0-9_]+)between(-?\d+)and(-?\d+)$/.exec(clause);
            return match !== null
                && match[1] === shape.column
                && match[2] === shape.min
                && match[3] === shape.max;
        }
        case 'atMost': {
            const match = /^([a-z0-9_]+)<=(\d+)$/.exec(clause);
            return match !== null && match[1] === shape.column && match[2] === shape.max;
        }
        case 'nullOrAtMost': {
            const variants = orVariants(`${shape.column}isnull`, `${shape.column}<=${shape.max}`);
            return variants.includes(clause);
        }
        case 'membership': {
            const match = /^([a-z0-9_]+)in\((.*)\)$/.exec(clause);
            if (match === null || match[1] !== shape.column) return false;
            const values = match[2]
                .split(',')
                .map((part) => part.trim().replace(/^'/, '').replace(/'$/, ''));
            if (values.length !== shape.values.length) return false;
            return shape.values.every((value) => values.includes(value));
        }
        case 'release': {
            const [first, second] = shape.columns;
            if (first === undefined || second === undefined) return false;
            const accepted = new Set<string>();
            for (const group of andVariants(`${first}isnull`, `${second}isnull`)) {
                for (const combined of orVariants(`${shape.column}='${shape.pendingValue}'`, group)) {
                    accepted.add(combined);
                }
            }
            return accepted.has(clause);
        }
        default:
            return false;
    }
};

/* ---------- shape comparison ---------- */

const describeExpectedType = (type: ExpectedColumnType): string => {
    switch (type.kind) {
        case 'char':
            return `char(${type.length}) ${type.charset}/${type.collation}`;
        case 'varchar':
            return `varchar(${type.length}) ${type.charset}/${type.collation}`;
        case 'bigint':
            return type.unsigned ? 'bigint unsigned' : 'bigint';
        case 'int':
            return type.unsigned ? 'int unsigned' : 'int';
        case 'enum':
            return `enum(${type.values.join('|')})`;
        default:
            return 'unknown';
    }
};

const describeActualColumn = (column: CatalogColumn): string =>
    `${column.dataType}${column.charLength === null ? '' : `(${column.charLength})`}`
    + `${column.charset === null ? '' : ` ${column.charset}`}`
    + `${column.collation === null ? '' : `/${column.collation}`}`
    + `${column.unsigned ? ' unsigned' : ''}`
    + `${column.nullable ? ' NULL' : ' NOT NULL'}`;

/** `null` when the column is the declared shape, else a short fact saying why not. */
const columnMismatch = (expected: ColumnRequirement, actual: CatalogColumn): string | null => {
    const type = expected.type;
    let typeOk = false;
    switch (type.kind) {
        case 'char':
        case 'varchar':
            typeOk = actual.dataType === type.kind
                && actual.charLength === type.length
                && actual.charset === type.charset
                && actual.collation === type.collation;
            break;
        case 'bigint':
        case 'int':
            typeOk = actual.dataType === type.kind && actual.unsigned === type.unsigned;
            break;
        case 'enum': {
            const values = parseEnumValues(actual.columnType);
            typeOk = actual.dataType === 'enum'
                && values.length === type.values.length
                && type.values.every((value) => values.includes(value));
            break;
        }
        default:
            typeOk = false;
    }
    if (!typeOk) {
        return `expected ${describeExpectedType(type)}, found ${describeActualColumn(actual)}`;
    }
    if (actual.nullable !== expected.nullable) {
        return `expected ${expected.nullable ? 'NULL' : 'NOT NULL'}, found ${actual.nullable ? 'NULL' : 'NOT NULL'}`;
    }
    if (actual.extra.length > 0) {
        return `expected a plain stored column, found EXTRA "${actual.extra}"`;
    }
    if (expected.noDefault === true && actual.hasDefault) {
        return 'expected no DEFAULT, found one';
    }
    return null;
};

/* ---------- per-area evaluation ---------- */

interface AreaEvaluationSink {
    checked(entry: string): void;
    fail(detail: string): void;
    unproven(detail: string): void;
}

const boundedReason = (value: string, limit = 320): string =>
    value.length <= limit ? value : `${value.slice(0, limit)}…`;

/**
 * Evaluate one area against a measured snapshot.
 *
 * The ORDER of the three buckets is the whole safety property:
 *
 *   1. a PROVEN mismatch (a successful read showed a wrong or missing fact) ⇒
 *      `absent`, even if some other read failed;
 *   2. otherwise, any fact that could not be measured ⇒ `unknown` — never
 *      `verified`;
 *   3. only when every required fact was read and matched ⇒ `verified`.
 *
 * "PROVEN" is load-bearing. `absent` is reserved for a fact that was READ and
 * found different: a row that came back with the wrong type, a missing row in a
 * result set that was scoped to a KNOWN schema. A read that failed, an empty
 * result set from an unscoped query (`DATABASE()` unreadable), a denied
 * privilege, a missing `information_schema` table or an unsupported flavour are
 * all `unknown` — see `failAbsent` below. Reporting `absent` there would be a
 * false negative on a valid deployment, which is exactly as damaging as a false
 * `verified`.
 */
const evaluateArea = (
    snapshot: CatalogSnapshot,
    spec: AreaSpec,
    extra?: (sink: AreaEvaluationSink) => void,
): LiveSchemaAreaResult => {
    const checked: string[] = [];
    const failures: string[] = [];
    const unproven: string[] = [];
    const sink: AreaEvaluationSink = {
        checked: (entry) => { checked.push(entry); },
        fail: (detail) => { failures.push(detail); },
        unproven: (detail) => { unproven.push(detail); },
    };
    const absentTables = new Set<string>();

    /**
     * EVERY schema-scoped read in `verifyLiveSchema` filters on
     * `TABLE_SCHEMA = DATABASE()`. When that name is unreadable (no schema
     * selected, `DATABASE()` NULL, or the read denied) those queries do not
     * fail — they return NO ROWS, and "no rows" is indistinguishable from
     * "the object does not exist". Concluding `absent` there would report a
     * perfectly valid deployment as broken because of a connection setting, so
     * an absence may only be declared when the schema name WAS read. Everything
     * else stays `unknown`, which is the honest answer: nothing was measured.
     */
    const schemaKnown = snapshot.database.ok;
    if (!schemaKnown) {
        sink.unproven(`current schema name (${snapshot.database.reason}); every catalog read is scoped to `
            + 'DATABASE(), so absence cannot be proven');
    }
    const failAbsent = (detail: string): void => {
        if (schemaKnown) sink.fail(detail);
        else sink.unproven(detail);
    };

    for (const table of spec.tables) sink.checked(table);
    if (snapshot.tables.ok) {
        for (const table of spec.tables) {
            if (!snapshot.tables.value.has(table)) {
                absentTables.add(table);
                failAbsent(`${table} is absent`);
            }
        }
    } else {
        sink.unproven(`table presence (${snapshot.tables.reason})`);
    }

    if (!snapshot.columns.ok) sink.unproven(`column shape (${snapshot.columns.reason})`);
    for (const requirement of spec.columns) {
        if (absentTables.has(requirement.table)) continue;
        for (const expected of requirement.columns) {
            sink.checked(`${requirement.table}.${expected.column} `
                + `${describeExpectedType(expected.type)} ${expected.nullable ? 'NULL' : 'NOT NULL'}`);
            if (!snapshot.columns.ok) continue;
            const actual = snapshot.columns.value.get(requirement.table)?.get(expected.column);
            if (actual === undefined) {
                failAbsent(`${requirement.table}.${expected.column} is absent`);
                continue;
            }
            const mismatch = columnMismatch(expected, actual);
            if (mismatch !== null) sink.fail(`${requirement.table}.${expected.column} ${mismatch}`);
        }
    }

    if (!snapshot.indexes.ok) sink.unproven(`index shape (${snapshot.indexes.reason})`);
    for (const requirement of spec.indexes) {
        if (absentTables.has(requirement.table)) continue;
        sink.checked(`${requirement.table}.${requirement.name} `
            + `${requirement.unique ? 'UNIQUE' : 'KEY'}(${requirement.columns.join(',')})`);
        if (!snapshot.indexes.ok) continue;
        const actual = snapshot.indexes.value.get(catalogKey(requirement.table, requirement.name));
        if (actual === undefined) {
            failAbsent(`index ${requirement.table}.${requirement.name} is absent`);
            continue;
        }
        if (actual.unique === null) {
            sink.unproven(`index ${requirement.table}.${requirement.name} uniqueness (NON_UNIQUE is unreadable)`);
        } else if (actual.unique !== requirement.unique) {
            sink.fail(`index ${requirement.table}.${requirement.name} is `
                + `${actual.unique ? 'UNIQUE' : 'NOT UNIQUE'}, expected ${requirement.unique ? 'UNIQUE' : 'NOT UNIQUE'}`);
        }
        if (actual.prefixed) {
            sink.fail(`index ${requirement.table}.${requirement.name} indexes a column PREFIX (SUB_PART), `
                + 'so the full value is not what the key holds');
        }
        if (actual.columns.length !== requirement.columns.length
            || requirement.columns.some((column, position) => actual.columns[position] !== column)) {
            sink.fail(`index ${requirement.table}.${requirement.name} covers (${actual.columns.join(',')}), `
                + `expected (${requirement.columns.join(',')}) in that order`);
        }
    }

    if (!snapshot.constraints.ok) sink.unproven(`constraint presence (${snapshot.constraints.reason})`);
    if (!snapshot.checkClauses.ok) sink.unproven(`CHECK_CLAUSE text (${snapshot.checkClauses.reason})`);
    for (const requirement of spec.checks) {
        if (absentTables.has(requirement.table)) continue;
        sink.checked(`${requirement.table}.${requirement.name} CHECK ENFORCED`);
        if (!snapshot.constraints.ok) continue;
        const constraint = snapshot.constraints.value.get(catalogKey(requirement.table, requirement.name));
        if (constraint === undefined || constraint.type !== 'CHECK') {
            failAbsent(`CHECK ${requirement.table}.${requirement.name} is absent`);
            continue;
        }
        if (constraint.enforced === null) {
            sink.unproven(`ENFORCED for ${requirement.table}.${requirement.name} is unreadable`);
            continue;
        }
        if (!constraint.enforced) {
            sink.fail(`CHECK ${requirement.table}.${requirement.name} exists but is NOT ENFORCED`);
            continue;
        }
        if (!snapshot.checkClauses.ok) continue;
        const clause = snapshot.checkClauses.value.get(catalogKey(requirement.table, requirement.name));
        if (clause === null || clause === undefined) {
            sink.unproven(`CHECK_CLAUSE for ${requirement.table}.${requirement.name} is unreadable`);
            continue;
        }
        if (!checkShapeMatches(clause, requirement.shape)) {
            sink.fail(`CHECK ${requirement.table}.${requirement.name} no longer expresses the required `
                + `predicate (normalised clause "${boundedText(clause, 140)}")`);
        }
    }

    /**
     * Constraints a later migration DROPS. Presence is a proven mismatch: the
     * older CHECK is still enforced and still narrower than the vocabulary the
     * replacement admits, so a write this lane makes would be rejected at
     * runtime while the report said `verified`.
     */
    for (const forbidden of spec.forbiddenChecks) {
        if (absentTables.has(forbidden.table)) continue;
        sink.checked(`${forbidden.table}.${forbidden.name} CHECK ABSENT`);
        if (!snapshot.constraints.ok) continue;
        const constraint = snapshot.constraints.value.get(catalogKey(forbidden.table, forbidden.name));
        if (constraint === undefined) continue;
        if (constraint.type !== 'CHECK') {
            sink.fail(`${forbidden.table}.${forbidden.name} exists as a ${constraint.type}, expected no such `
                + 'constraint at all');
            continue;
        }
        sink.fail(`CHECK ${forbidden.table}.${forbidden.name} is still present; the migration that replaces it `
            + 'drops it, and while it exists it still rejects the wider vocabulary');
    }

    if (!snapshot.foreignKeys.ok) sink.unproven(`foreign keys (${snapshot.foreignKeys.reason})`);
    for (const requirement of spec.foreignKeys) {
        if (absentTables.has(requirement.table)) continue;
        sink.checked(`${requirement.table}.${requirement.name} `
            + `FK(${requirement.columns.join(',')})->${requirement.referencedTable}`
            + `(${requirement.referencedColumns.join(',')})`);
        if (!snapshot.foreignKeys.ok) continue;
        const actual = snapshot.foreignKeys.value.get(catalogKey(requirement.table, requirement.name));
        if (actual === undefined) {
            failAbsent(`FOREIGN KEY ${requirement.table}.${requirement.name} is absent`);
            continue;
        }
        // The tenant boundary is `referencedSchema === DATABASE()`. Without a
        // schema name that comparison is not evaluable, so it is skipped and the
        // area is already `unknown` — never silently treated as a match.
        if (snapshot.database.ok && actual.referencedSchema !== snapshot.database.value) {
            sink.fail(`FOREIGN KEY ${requirement.table}.${requirement.name} references schema `
                + `${describeCatalogValue(actual.referencedSchema)}, not this schema — the tenant boundary `
                + 'would point at another database');
        }
        if (actual.referencedTable !== requirement.referencedTable) {
            sink.fail(`FOREIGN KEY ${requirement.table}.${requirement.name} references `
                + `${describeCatalogValue(actual.referencedTable)}, expected "${requirement.referencedTable}"`);
        }
        if (actual.columns.length !== requirement.columns.length
            || requirement.columns.some((column, position) => actual.columns[position] !== column)) {
            sink.fail(`FOREIGN KEY ${requirement.table}.${requirement.name} covers (${actual.columns.join(',')}), `
                + `expected (${requirement.columns.join(',')}) in that order`);
        }
        if (actual.referencedColumns.length !== requirement.referencedColumns.length
            || requirement.referencedColumns.some(
                (column, position) => actual.referencedColumns[position] !== column,
            )) {
            sink.fail(`FOREIGN KEY ${requirement.table}.${requirement.name} references (`
                + `${actual.referencedColumns.map((column) => column ?? 'unreadable').join(',')}), `
                + `expected (${requirement.referencedColumns.join(',')}) in that order`);
        }
    }

    for (const note of spec.notes) sink.checked(note);
    if (extra) extra(sink);

    if (failures.length > 0) {
        return absentArea(
            boundedReason(`${failures.length} declared shape fact(s) not met: ${summarizeNames(failures)}`),
            checked,
        );
    }
    if (unproven.length > 0) {
        return unknownArea(
            boundedReason(`not proven from the catalog: ${summarizeNames(unproven)}`),
            checked,
        );
    }
    return verifiedArea(checked);
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

    const placeholders = LIVE_SCHEMA_TABLES.map(() => '?').join(', ');
    const boundTables = [...LIVE_SCHEMA_TABLES];

    // One SELECT each, against information_schema on the injected connection.
    // Sequential on purpose: the executor is ONE connection, and a caller-
    // supplied runner is not required to queue concurrent statements.
    const serverVersionRead = await readCatalog(async () => {
        const row = await executor.queryOne<Record<string, unknown>>('SELECT VERSION() AS version');
        const text = row === null ? null : readCatalogText(row.version);
        if (text === null) throw new Error('SELECT VERSION() returned no readable text');
        return text;
    });

    const database = await readCatalog(async () => {
        const row = await executor.queryOne<Record<string, unknown>>('SELECT DATABASE() AS db');
        const name = row === null ? null : readCatalogText(row.db);
        if (name === null) throw new Error('SELECT DATABASE() returned no schema name');
        return name;
    });

    const tables = await readCatalog(async () => {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
            boundTables,
        );
        const found = new Set<string>();
        for (const row of rows) {
            const name = readCatalogText(row.TABLE_NAME);
            if (name !== null) found.add(name);
        }
        return found;
    });

    const columns = await readCatalog(async () => {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
                    CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME,
                    COLUMN_DEFAULT, EXTRA
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
            boundTables,
        );
        return buildColumnIndex(rows);
    });

    const indexes = await readCatalog(async () => {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
            boundTables,
        );
        return buildIndexIndex(rows);
    });

    const constraints = await readCatalog(async () => {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE, ENFORCED
               FROM information_schema.TABLE_CONSTRAINTS
              WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
            boundTables,
        );
        return buildConstraintIndex(rows);
    });

    // CHECK_CLAUSE lives in CHECK_CONSTRAINTS, which has no TABLE_NAME: it is
    // joined to TABLE_CONSTRAINTS so a clause can never be attributed to the
    // wrong table.
    const checkClauses = await readCatalog(async () => {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT tc.TABLE_NAME AS TABLE_NAME, tc.CONSTRAINT_NAME AS CONSTRAINT_NAME,
                    cc.CHECK_CLAUSE AS CHECK_CLAUSE
               FROM information_schema.TABLE_CONSTRAINTS tc
               JOIN information_schema.CHECK_CONSTRAINTS cc
                 ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
                AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
              WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
                AND tc.TABLE_NAME IN (${placeholders})
                AND tc.CONSTRAINT_TYPE = 'CHECK'`,
            boundTables,
        );
        const clauses = new Map<string, string | null>();
        for (const row of rows) {
            const table = readCatalogText(row.TABLE_NAME);
            const name = readCatalogText(row.CONSTRAINT_NAME);
            if (table === null || name === null) continue;
            const clause = readCatalogText(row.CHECK_CLAUSE);
            clauses.set(catalogKey(table, name), clause === null ? null : normalizeCheckClause(clause));
        }
        return clauses;
    });

    const foreignKeys = await readCatalog(async () => {
        const rows = await executor.query<Record<string, unknown>>(
            `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION,
                    REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
               FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME IN (${placeholders})
                AND REFERENCED_TABLE_NAME IS NOT NULL`,
            boundTables,
        );
        return buildForeignKeyIndex(rows);
    });

    const padAttribute = await readCatalog(async () => {
        const row = await executor.queryOne<Record<string, unknown>>(
            `SELECT COLLATION_NAME, CHARACTER_SET_NAME, PAD_ATTRIBUTE
               FROM information_schema.COLLATIONS
              WHERE COLLATION_NAME = ?`,
            [PRESENCE_EVENT_ID_COLLATION],
        );
        if (row === null) {
            throw new Error(`${PRESENCE_EVENT_ID_COLLATION} is not in information_schema.COLLATIONS`);
        }
        const pad = readCatalogText(row.PAD_ATTRIBUTE);
        if (pad === null) throw new Error(`${PRESENCE_EVENT_ID_COLLATION} has no readable PAD_ATTRIBUTE`);
        return pad;
    });

    const serverVersion = serverVersionRead.ok ? serverVersionRead.value : '';
    const snapshot: CatalogSnapshot = {
        database,
        serverVersion: serverVersionRead.ok ? serverVersionRead.value : null,
        tables,
        columns,
        indexes,
        constraints,
        checkClauses,
        foreignKeys,
        padAttribute,
    };

    const sessionLifecycle = evaluateArea(snapshot, SESSION_LIFECYCLE_SPEC);
    const presenceOrdering = evaluateArea(snapshot, PRESENCE_ORDERING_SPEC);

    /**
     * Identity is TWO facts, and both must hold: the column's own shape
     * (type, length, charset/collation, nullability — proven from COLUMNS by the
     * spec) and the server's PAD attribute for that collation (proven from
     * COLLATIONS). The classifier needs both; neither is inferred from the
     * collation's name, and an unreadable server version is `unknown`.
     */
    const presenceEventIdentity = evaluateArea(snapshot, PRESENCE_EVENT_IDENTITY_SPEC, (sink) => {
        sink.checked(`information_schema.COLLATIONS.${PRESENCE_EVENT_ID_COLLATION} PAD_ATTRIBUTE`);
        if (!snapshot.padAttribute.ok) {
            sink.unproven(`collation pad attribute (${snapshot.padAttribute.reason})`);
            return;
        }
        if (!snapshot.columns.ok) return; // already recorded against column shape
        const column = snapshot.columns.value.get('live_session_participants')?.get('presence_event_id');
        if (column === undefined) return; // already recorded as absent
        const verdict = classifyPresenceEventIdIdentity({
            serverVersion: snapshot.serverVersion,
            columnCharset: column.charset,
            columnCollation: column.collation,
            collationPadAttribute: snapshot.padAttribute.value,
        });
        if (verdict.verdict === 'compatible') return;
        if (verdict.verdict === 'incompatible') {
            sink.fail(verdict.reason ?? 'presence_event_id identity is incompatible');
            return;
        }
        sink.unproven(verdict.reason ?? 'presence_event_id identity could not be classified');
    });

    const ingestLedger = evaluateArea(snapshot, INGEST_LEDGER_SPEC);
    const recoveryCheckpoint = evaluateArea(snapshot, RECOVERY_CHECKPOINT_SPEC);

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
