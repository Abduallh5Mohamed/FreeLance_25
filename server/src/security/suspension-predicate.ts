/**
 * Single source of truth for the active time-bound suspension rule.
 *
 * The `users` table carries `suspended_until` (DATETIME NULL). A suspension
 * is active only while that timestamp is still in the future; NULL, a past
 * value, or a value equal to "now" mean the account is NOT suspended.
 *
 * Production SQL evaluates the rule in the database (against
 * UTC_TIMESTAMP()) so every decision uses one clock; the pure mirror below
 * defines the identical semantics for hermetic tests. The regression suite
 * asserts the shipped SQL text and the semantics table (NULL/past/equal/
 * future) together, so the two directions cannot drift apart again.
 */

/**
 * SQL fragment shared by every identity query: true only while
 * `users.suspended_until` is still in the future. NULL/past/equal -> false.
 * Always interpolate this constant; never re-type the predicate inline.
 */
export const ACTIVE_SUSPENSION_PREDICATE_SQL =
    '(suspended_until IS NOT NULL AND suspended_until > UTC_TIMESTAMP())';

/**
 * Pure mirror of ACTIVE_SUSPENSION_PREDICATE_SQL semantics:
 * - null / undefined -> not suspended (no suspension row value);
 * - timestamp <= now (past or exactly equal) -> not suspended;
 * - timestamp > now -> suspended.
 *
 * An unparseable value fails closed (treated as an active suspension) rather
 * than silently granting access; the DATETIME column stores either NULL or a
 * valid timestamp, so this branch never triggers with real rows.
 */
export function isTimeBoundSuspensionActive(
    suspendedUntil: Date | string | number | null | undefined,
    now: Date,
): boolean {
    if (suspendedUntil === null || suspendedUntil === undefined) return false;
    const until = suspendedUntil instanceof Date ? suspendedUntil : new Date(suspendedUntil);
    if (Number.isNaN(until.getTime())) return true;
    return until.getTime() > now.getTime();
}
