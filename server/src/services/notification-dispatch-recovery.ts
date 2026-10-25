/**
 * Dispatch recovery — the bounded operator tool the worker contract (§12.3)
 * left explicitly manual.
 *
 * COMPOSITION ONLY. Every state write and every fence stays in
 * `services/notification-outbox.ts`; this module calls those primitives and
 * adds three orchestration answers without any second state machine:
 *
 *  1. `listQuarantinedOutboxRows` — a bounded, keyset-paginated enumeration of
 *     rows quarantined as ambiguous (`sending` + `provider-outcome-unknown` or
 *     `stale-claim-unconfirmed`). Enumeration NEVER mutates a row and NEVER
 *     calls an adapter: the outbox status ENUM has no `unknown` member, so the
 *     quarantine is carried by `last_error`, and only an authoritative result
 *     or an operator may resolve it.
 *  2. `runDispatchRecoveryOnce` — ONE bounded pass: a lease-bounded stale sweep
 *     (tenant-bound via `recoverStaleSendingRows`) followed by one quarantined
 *     page. The pass is never scheduled here; no timer exists in this module.
 *     The returned `nextAfterId` continuation is kept by the CALLER (the same
 *     rule the live recovery lane documents): this module persists no cursor,
 *     so a caller that discards it re-scans the first page instead.
 *  3. `reconcileQuarantinedRow` — the operator resolution itself, delegated
 *     VERBATIM to `reconcileQuarantinedOutboxRow` so fencing (the `attempts`
 *     lease), the attempt-cap refusal and the receipt stay the outbox's single
 *     implementation. There is no `provider-delivered` shortcut outside it and
 *     no way here to write `sent` without an authoritative resolution.
 *
 * TENANCY IS FAIL-CLOSED: every entry point requires an explicit tenant and
 * every query binds `tenant_id = ?` in SQL, never a post-filter. An empty
 * tenant returns an empty page, and a foreign row is reported `not-found` by
 * the delegated reconciliation — the outbox primitive already scopes that.
 *
 * NO PII LEAVES THESE FUNCTIONS: observations carry outbox id, channel, event
 * type, quarantine marker and attempt count — never a contact, a payload, a
 * body or a recipient identity (the same shape `recoverStaleSendingRows`
 * emits). Reasons are redacted by the outbox primitives before storage.
 *
 * UNPROVEN AT RUNTIME. No database, sweep, reconciliation or endpoint was
 * exercised while this file was written; it composes verified primitives and
 * bounds their inputs. Operational verification stays a separate act.
 */

import type { NotificationDataAccess } from './notification-consent';
import {
    UNKNOWN_OUTCOME_MARKER,
    STALE_SENDING_MARKER,
    reconcileQuarantinedOutboxRow as reconcileQuarantinedOutboxRowImpl,
    recoverStaleSendingRows,
    type QuarantineResolution,
    type ReconcileQuarantinedInput,
    type ReconcileResult,
    type StaleSendingRecoveryResult,
} from './notification-outbox';

export { UNKNOWN_OUTCOME_MARKER, STALE_SENDING_MARKER };
export type { QuarantineResolution, ReconcileResult, StaleSendingRecoveryResult };

/** The only markers whose presence makes a `sending` row quarantined. */
export type QuarantineMarker = typeof UNKNOWN_OUTCOME_MARKER | typeof STALE_SENDING_MARKER;

/* Backward-compatible alias for the existing outbox primitive's input shape. */
export type ReconcileQuarantinedRowInput = ReconcileQuarantinedInput;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** The two quarantine markers, in a stable order for the SQL IN list. */
const QUARANTINE_MARKERS: readonly string[] = [UNKNOWN_OUTCOME_MARKER, STALE_SENDING_MARKER];

export interface QuarantinedRowObservation {
    outboxId: string;
    tenantId: string;
    channel: string;
    eventType: string;
    /** Attempt number at the time the row was quarantined. */
    attempts: number;
    marker: QuarantineMarker;
    /** The claim instant (`updated_at`) as the store returned it. */
    updatedAt: string | Date;
}

export interface ListQuarantinedInput {
    /** Required: a quarantined row is unreachable outside its own tenant. */
    tenantId: string;
    /** Bounded page size (clamped 1..MAX_PAGE_SIZE, default DEFAULT_PAGE_SIZE). */
    limit?: number;
    /**
     * Keyset cursor: the `outboxId` of the last row of the previous page.
     * `null`/absent starts from the beginning. Rows are keyed CHAR(36) and
     * never change id, so the ordering is stable across pages.
     */
    afterId?: string | null;
}

export interface ListQuarantinedResult {
    rows: QuarantinedRowObservation[];
    /** The cursor to pass as `afterId` next time; `null` when exhausted. */
    nextAfterId: string | null;
    hasMore: boolean;
}

const clampPageSize = (raw: unknown): number =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1
        ? Math.min(raw, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

/**
 * One bounded keyset page of quarantined rows. A page larger than the bound is
 * never fetched: the query asks for `bound + 1` rows and trims, so `hasMore`
 * and `nextAfterId` are derived without a second query.
 */
export const listQuarantinedOutboxRows = async (
    db: NotificationDataAccess,
    input: ListQuarantinedInput,
): Promise<ListQuarantinedResult> => {
    const empty: ListQuarantinedResult = { rows: [], nextAfterId: null, hasMore: false };
    if (typeof input.tenantId !== 'string' || input.tenantId.length === 0) return empty;
    const bound = clampPageSize(input.limit);
    const cursor = typeof input.afterId === 'string' && input.afterId.length > 0 ? input.afterId : null;
    const rows = await db.query<{
        id: string;
        tenant_id: string;
        channel: string;
        event_type: string;
        attempts: number;
        last_error: string | null;
        updated_at: string | Date;
    }>(
        `SELECT id, tenant_id, channel, event_type, attempts, last_error, updated_at
         FROM notification_outbox
         WHERE status = 'sending'
           AND last_error IN (${QUARANTINE_MARKERS.map(() => '?').join(', ')})
           AND tenant_id = ?${cursor === null ? '' : ' AND id > ?'}
         ORDER BY id ASC
         LIMIT ${bound + 1}`,
        cursor === null
            ? [...QUARANTINE_MARKERS, input.tenantId]
            : [...QUARANTINE_MARKERS, input.tenantId, cursor],
    );
    const hasMore = rows.length > bound;
    const page = hasMore ? rows.slice(0, bound) : rows;
    const observations: QuarantinedRowObservation[] = [];
    for (const row of page) {
        // The marker predicate filtered the query, but the type says
        // `string | null`; anything unexpected is skipped rather than
        // reported with a marker it does not actually carry.
        if (row.last_error !== UNKNOWN_OUTCOME_MARKER && row.last_error !== STALE_SENDING_MARKER) continue;
        observations.push({
            outboxId: row.id,
            tenantId: row.tenant_id,
            channel: row.channel,
            eventType: row.event_type,
            attempts: row.attempts,
            marker: row.last_error,
            updatedAt: row.updated_at,
        });
    }
    const nextAfterId = hasMore && page.length > 0 ? page[page.length - 1].id : null;
    return { rows: observations, nextAfterId, hasMore };
};

export interface DispatchRecoveryOptions {
    tenantId: string;
    /** Forwarded to the stale sweep (clamped 60s..24h by the outbox module). */
    leaseMs?: number;
    /** Page bound for the sweep and for the returned quarantined page. */
    limit?: number;
    /** Keyset continuation for the quarantined page, from the previous report. */
    afterId?: string | null;
    now?: () => Date;
    /** Injected sink for sweep observations; carries no contact or body. */
    log?: (entry: unknown) => void;
}

export interface DispatchRecoveryReport {
    /**
     * What the stale sweep did: rows scanned, rows flagged this pass and rows
     * a concurrent sweep had already flagged. Carries no receipt and no send.
     */
    stale: StaleSendingRecoveryResult;
    /** One bounded keyset page of currently quarantined rows. */
    quarantined: ListQuarantinedResult;
}

/**
 * ONE bounded recovery pass. Explicit call only: this module registers no
 * timer, no listener and no scheduler, and it never re-sends. The sweep may
 * flag abandoned claims; the page is read-only enumeration; resolution is a
 * separate, explicit operator decision via `reconcileQuarantinedRow`.
 *
 * THE CALLER OWNS PERSISTING `quarantined.nextAfterId`: this module keeps no
 * cursor between invocations, so a page boundary is crossed only when the
 * caller feeds `afterId` forward.
 */
export const runDispatchRecoveryOnce = async (
    db: NotificationDataAccess,
    input: DispatchRecoveryOptions,
): Promise<DispatchRecoveryReport> => {
    if (typeof input.tenantId !== 'string' || input.tenantId.length === 0) {
        return {
            stale: { scanned: 0, flagged: [], alreadyFlagged: 0 },
            quarantined: { rows: [], nextAfterId: null, hasMore: false },
        };
    }
    const stale = await recoverStaleSendingRows(db, {
        olderThanMs: input.leaseMs,
        limit: input.limit,
        tenantId: input.tenantId,
        now: input.now,
        log: input.log,
    });
    const quarantined = await listQuarantinedOutboxRows(db, {
        tenantId: input.tenantId,
        limit: input.limit,
        afterId: input.afterId,
    });
    return { stale, quarantined };
};

/**
 * The operator resolution, delegated verbatim to the outbox primitive so the
 * fencing, the attempt-cap refusal, the receipts and the redaction stay that
 * module's single implementation. This alias exists so a recovery surface
 * (an operations route or the runtime factory) can depend on this module alone
 * without re-implementing — or bypassing — a state write.
 */
export const reconcileQuarantinedRow: typeof reconcileQuarantinedOutboxRowImpl =
    reconcileQuarantinedOutboxRowImpl;
