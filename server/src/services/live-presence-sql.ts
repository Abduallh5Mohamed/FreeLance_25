/**
 * WL-P5 — SQL adapter for `live_session_presence_intervals`.
 *
 * The participant row (`live_session_participants`) can hold ONE
 * `joined_at_ms`/`left_at_ms` pair, so a rejoin overwrites the earlier presence
 * period. This adapter writes the append-only interval table instead:
 *
 *   id, tenant_id, session_id, participant_id, user_id,
 *   joined_at_ms, left_at_ms, close_reason
 *
 * Facts it relies on (migration `20261022_06_live_sessions_recordings.sql`,
 * table 5, read-only ground truth — no DDL here):
 *   - `UNIQUE (session_id, user_id, joined_at_ms)` is the arbiter of "one
 *     interval per (session, user, start)";
 *   - `close_reason ENUM('leave','callback','session-ended')` and
 *     `CHECK ((left_at_ms IS NULL) = (close_reason IS NULL))` make an interval
 *     open-with-reason (or closed-without-reason) unrepresentable;
 *   - the composite FK `(tenant_id, session_id, participant_id)` into
 *     `live_session_participants (tenant_id, session_id, id)` is what ties an
 *     interval to a participant of the SAME tenant and session. There is no
 *     column linking an interval to the principal who CAUSED the open/close;
 *     the audit row carries the actor, the interval does not (see report).
 *
 * SOURCE ONLY. No connection, no pool, no query at import time, no top-level
 * side effect. Every statement runs on the caller-injected connection, which is
 * the connection of the enclosing `withTransaction` unit, so an interval opens
 * and closes in the same unit as the participant row it describes.
 *
 * Presence is participant data. Nothing here grants authority, and nothing
 * here writes school attendance.
 *
 * BIGINT safety: `joined_at_ms` / `left_at_ms` come back from mysql2 as strings
 * by default. Every value is validated as an exact integer string and range
 * checked against `Number.MAX_SAFE_INTEGER` BEFORE conversion; an unsafe value
 * throws a bounded `LivePresenceSqlError` instead of being truncated.
 */

import { PRESENCE_CLOSE_REASONS, type ClosePresenceIntervalInput, type ClosePresenceIntervalResult, type OpenPresenceIntervalInput, type OpenPresenceIntervalResult, type PresenceCloseReason, type PresenceIntervalRecord } from './live-session-core';
import type { LiveSessionSqlConnection } from './live-session-sql';

export type LivePresenceSqlErrorCode =
    | 'invalid_input'
    | 'invalid_row'
    | 'unsafe_bigint'
    | 'invalid_close_reason';

export class LivePresenceSqlError extends Error {
    constructor(public readonly code: LivePresenceSqlErrorCode, message: string) {
        super(message);
        this.name = 'LivePresenceSqlError';
    }
}

/** The three methods this adapter contributes to a `LiveSessionUnit`. */
export interface LivePresenceSqlMethods {
    openPresenceInterval(input: OpenPresenceIntervalInput): Promise<OpenPresenceIntervalResult>;
    closePresenceInterval(input: ClosePresenceIntervalInput): Promise<ClosePresenceIntervalResult>;
    listPresenceIntervals(sessionId: string, tenantId: string): Promise<PresenceIntervalRecord[]>;
}

interface PresenceIntervalRow {
    id: string;
    tenant_id: string;
    session_id: string;
    participant_id: string;
    user_id: string;
    joined_at_ms: number | string;
    left_at_ms: number | string | null;
    close_reason: string | null;
}

const PRESENCE_COLUMNS = `id, tenant_id, session_id, participant_id, user_id,
       joined_at_ms, left_at_ms, close_reason`;

const INTEGER_TEXT = /^-?\d+$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** Exact BIGINT -> number. Never `Number()` on an unchecked string. */
const readEpochMs = (value: unknown, field: string): number => {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new LivePresenceSqlError('unsafe_bigint', `${field} is outside the safe integer range`);
        }
        return value;
    }
    if (typeof value === 'string') {
        const text = value.trim();
        if (!INTEGER_TEXT.test(text)) {
            throw new LivePresenceSqlError('unsafe_bigint', `${field} is not an exact integer string`);
        }
        const parsed = BigInt(text);
        if (parsed > MAX_SAFE || parsed < MIN_SAFE) {
            throw new LivePresenceSqlError('unsafe_bigint', `${field} is outside the safe integer range`);
        }
        return Number(parsed);
    }
    throw new LivePresenceSqlError('invalid_row', `${field} is not an integer`);
};

const readNullableEpochMs = (value: unknown, field: string): number | null =>
    value === null || value === undefined ? null : readEpochMs(value, field);

/** Write-side guard: the unit only ever passes numbers, never a string. */
const requireEpochMs = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new LivePresenceSqlError('invalid_input', `${field} must be a safe integer epoch in milliseconds`);
    }
    return value;
};

const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new LivePresenceSqlError('invalid_input', `${field} is required`);
    }
    return value;
};

const normalizeCloseReason = (value: unknown): PresenceCloseReason => {
    if (typeof value !== 'string' || !(PRESENCE_CLOSE_REASONS as readonly string[]).includes(value)) {
        throw new LivePresenceSqlError('invalid_close_reason', 'close_reason is outside the ENUM');
    }
    return value as PresenceCloseReason;
};

const isDuplicateEntry = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
};

const affectedOf = (result: { affectedRows?: number }): number =>
    typeof result.affectedRows === 'number' && Number.isSafeInteger(result.affectedRows) && result.affectedRows >= 0
        ? result.affectedRows
        : 0;

const mapInterval = (row: PresenceIntervalRow): PresenceIntervalRecord => {
    const reason = row.close_reason === null ? null : normalizeCloseReason(row.close_reason);
    const leftAtMs = readNullableEpochMs(row.left_at_ms, 'live_session_presence_intervals.left_at_ms');
    // Mirrors chk_presence_left_reason: open iff no reason. A row that breaks
    // the invariant is refused, never repaired or guessed.
    if ((leftAtMs === null) !== (reason === null)) {
        throw new LivePresenceSqlError(
            'invalid_row',
            'live_session_presence_intervals row breaks the open/close_reason invariant',
        );
    }
    return {
        id: row.id,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        participantId: row.participant_id,
        userId: row.user_id,
        joinedAtMs: readEpochMs(row.joined_at_ms, 'live_session_presence_intervals.joined_at_ms'),
        leftAtMs,
        closeReason: reason,
    };
};

/**
 * Build the three presence methods bound to ONE connection. The caller owns
 * the transaction: this factory never opens one and never resolves a pool.
 */
export const createLivePresenceSqlMethods = (conn: LiveSessionSqlConnection): LivePresenceSqlMethods => ({
    /**
     * Append a NEW interval. History is never overwritten.
     *
     * If an interval for (session, user) is already open, nothing is written:
     * a repeated join while still present is the same presence period. The
     * read+insert pair is serialised by the session row lock the admission unit
     * already holds, so it cannot interleave with another join of this session.
     *
     * A duplicate on `(session_id, user_id, joined_at_ms)` — two opens in the
     * same millisecond — is handled as "already recorded", never as a crash.
     * If that colliding row is already CLOSED the new period cannot be stored:
     * the unique key has no room for a second interval with the same start.
     * The result says so (`opened: false, alreadyOpen: false`) instead of
     * pretending the interval was written.
     */
    openPresenceInterval: async (input) => {
        const tenantId = requireText(input.tenantId, 'tenantId');
        const sessionId = requireText(input.sessionId, 'sessionId');
        const participantId = requireText(input.participantId, 'participantId');
        const userId = requireText(input.userId, 'userId');
        const id = requireText(input.id, 'id');
        const joinedAtMs = requireEpochMs(input.joinedAtMs, 'joinedAtMs');

        const open = await conn.queryOne<{ id: string }>(
            `SELECT id FROM live_session_presence_intervals
              WHERE session_id = ? AND user_id = ? AND tenant_id = ?
                AND left_at_ms IS NULL
              ORDER BY joined_at_ms DESC
              LIMIT 1`,
            [sessionId, userId, tenantId],
        );
        if (open) return { opened: false, intervalId: open.id, alreadyOpen: true };

        try {
            await conn.execute(
                `INSERT INTO live_session_presence_intervals
                     (id, tenant_id, session_id, participant_id, user_id,
                      joined_at_ms, left_at_ms, close_reason)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
                [id, tenantId, sessionId, participantId, userId, joinedAtMs],
            );
        } catch (error) {
            if (!isDuplicateEntry(error)) throw error;
            const existing = await conn.queryOne<{ id: string; left_at_ms: number | string | null }>(
                `SELECT id, left_at_ms FROM live_session_presence_intervals
                  WHERE session_id = ? AND user_id = ? AND joined_at_ms = ? AND tenant_id = ?
                  LIMIT 1`,
                [sessionId, userId, joinedAtMs, tenantId],
            );
            return {
                opened: false,
                intervalId: existing?.id ?? null,
                alreadyOpen: existing ? existing.left_at_ms === null : false,
            };
        }
        return { opened: true, intervalId: id, alreadyOpen: false };
    },

    /**
     * Close the open interval of (session, user) exactly once.
     *
     * The predicate `left_at_ms IS NULL` makes a second close a no-op, and
     * `joined_at_ms <= ?` refuses a close that would precede its open (a clock
     * anomaly leaves the interval open rather than writing a reversed span).
     * `ORDER BY joined_at_ms DESC LIMIT 1` bounds the write to one row, so
     * `affectedRows` is 0 or 1 and the caller can decide whether to audit.
     *
     * 0 rows therefore means "nothing was closed" — already closed, or the
     * guard refused — and the caller must not record a close.
     */
    closePresenceInterval: async (input) => {
        const tenantId = requireText(input.tenantId, 'tenantId');
        const sessionId = requireText(input.sessionId, 'sessionId');
        const userId = requireText(input.userId, 'userId');
        const leftAtMs = requireEpochMs(input.leftAtMs, 'leftAtMs');
        const reason = normalizeCloseReason(input.reason);

        const result = await conn.execute(
            `UPDATE live_session_presence_intervals
                SET left_at_ms = ?, close_reason = ?
              WHERE session_id = ? AND user_id = ? AND tenant_id = ?
                AND left_at_ms IS NULL
                AND joined_at_ms <= ?
              ORDER BY joined_at_ms DESC
              LIMIT 1`,
            [leftAtMs, reason, sessionId, userId, tenantId, leftAtMs],
        );
        const affectedRows = affectedOf(result);
        return { closed: affectedRows > 0, affectedRows };
    },

    /** Tenant-scoped read of the whole history, oldest interval first. */
    listPresenceIntervals: async (sessionId, tenantId) => {
        const safeSession = requireText(sessionId, 'sessionId');
        const safeTenant = requireText(tenantId, 'tenantId');
        const rows = await conn.query<PresenceIntervalRow>(
            `SELECT ${PRESENCE_COLUMNS}
               FROM live_session_presence_intervals
              WHERE session_id = ? AND tenant_id = ?
              ORDER BY user_id ASC, joined_at_ms ASC`,
            [safeSession, safeTenant],
        );
        return rows.map(mapInterval);
    },
});
