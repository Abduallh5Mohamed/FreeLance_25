"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileQuarantinedRow = exports.runDispatchRecoveryOnce = exports.listQuarantinedOutboxRows = exports.STALE_SENDING_MARKER = exports.UNKNOWN_OUTCOME_MARKER = void 0;
const notification_outbox_1 = require("./notification-outbox");
Object.defineProperty(exports, "UNKNOWN_OUTCOME_MARKER", { enumerable: true, get: function () { return notification_outbox_1.UNKNOWN_OUTCOME_MARKER; } });
Object.defineProperty(exports, "STALE_SENDING_MARKER", { enumerable: true, get: function () { return notification_outbox_1.STALE_SENDING_MARKER; } });
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** The two quarantine markers, in a stable order for the SQL IN list. */
const QUARANTINE_MARKERS = [notification_outbox_1.UNKNOWN_OUTCOME_MARKER, notification_outbox_1.STALE_SENDING_MARKER];
const clampPageSize = (raw) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1
    ? Math.min(raw, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
/**
 * One bounded keyset page of quarantined rows. A page larger than the bound is
 * never fetched: the query asks for `bound + 1` rows and trims, so `hasMore`
 * and `nextAfterId` are derived without a second query.
 */
const listQuarantinedOutboxRows = async (db, input) => {
    const empty = { rows: [], nextAfterId: null, hasMore: false };
    if (typeof input.tenantId !== 'string' || input.tenantId.length === 0)
        return empty;
    const bound = clampPageSize(input.limit);
    const cursor = typeof input.afterId === 'string' && input.afterId.length > 0 ? input.afterId : null;
    const rows = await db.query(`SELECT id, tenant_id, channel, event_type, attempts, last_error, updated_at
         FROM notification_outbox
         WHERE status = 'sending'
           AND last_error IN (${QUARANTINE_MARKERS.map(() => '?').join(', ')})
           AND tenant_id = ?${cursor === null ? '' : ' AND id > ?'}
         ORDER BY id ASC
         LIMIT ${bound + 1}`, cursor === null
        ? [...QUARANTINE_MARKERS, input.tenantId]
        : [...QUARANTINE_MARKERS, input.tenantId, cursor]);
    const hasMore = rows.length > bound;
    const page = hasMore ? rows.slice(0, bound) : rows;
    const observations = [];
    for (const row of page) {
        // The marker predicate filtered the query, but the type says
        // `string | null`; anything unexpected is skipped rather than
        // reported with a marker it does not actually carry.
        if (row.last_error !== notification_outbox_1.UNKNOWN_OUTCOME_MARKER && row.last_error !== notification_outbox_1.STALE_SENDING_MARKER)
            continue;
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
exports.listQuarantinedOutboxRows = listQuarantinedOutboxRows;
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
const runDispatchRecoveryOnce = async (db, input) => {
    if (typeof input.tenantId !== 'string' || input.tenantId.length === 0) {
        return {
            stale: { scanned: 0, flagged: [], alreadyFlagged: 0 },
            quarantined: { rows: [], nextAfterId: null, hasMore: false },
        };
    }
    const stale = await (0, notification_outbox_1.recoverStaleSendingRows)(db, {
        olderThanMs: input.leaseMs,
        limit: input.limit,
        tenantId: input.tenantId,
        now: input.now,
        log: input.log,
    });
    const quarantined = await (0, exports.listQuarantinedOutboxRows)(db, {
        tenantId: input.tenantId,
        limit: input.limit,
        afterId: input.afterId,
    });
    return { stale, quarantined };
};
exports.runDispatchRecoveryOnce = runDispatchRecoveryOnce;
/**
 * The operator resolution, delegated verbatim to the outbox primitive so the
 * fencing, the attempt-cap refusal, the receipts and the redaction stay that
 * module's single implementation. This alias exists so a recovery surface
 * (an operations route or the runtime factory) can depend on this module alone
 * without re-implementing — or bypassing — a state write.
 */
exports.reconcileQuarantinedRow = notification_outbox_1.reconcileQuarantinedOutboxRow;
