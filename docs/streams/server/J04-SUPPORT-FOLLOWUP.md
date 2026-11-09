# J04 — support follow-up by last ticket update

BUILD-54 continuation (2026-11-08): relevant schema/indexes applied only to the isolated synthetic demo after snapshot; older unapplied statements below describe earlier checkpoints. Native generic-ticket HTTP/browser verification and rollback-only SQL transfer/revocation/paging/failure evidence: [report](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-54.md). Assignment snapshot/candidate reads share a bounded 25s deadline (including pagination); timeout releases busy state and fences late results. A confirmed write remains confirmed if its refresh times out. Existing audit is atomic but unsealed; no center-staff, lesson-context, SLA, production or load acceptance. Online linking remains deferred.

BUILD-41, 7 November 2026. Extends the existing verified platform-support
assignment/queue boundary; no tenant staff mapping, automatic assignment,
notification, timer worker, response-time promise or SLA is introduced.

## Actual route and authority

`GET /api/support-tickets/follow-up` is registered on the existing authenticated
router before the ticket-ID routes. Existing no-store middleware precedes auth.
The new handler rejects billing-only/impersonation and body/authority selectors.
`createSupportWriteService.followup` runs inside the existing transaction seam,
rechecking canonical users-table identity, current token version, activity,
suspension and bounded locked platform support.read/super-admin grants.
Role labels, client actor/tenant/assignee fields and ticket ownership alone
grant no queue authority. Old staff identity is unsupported.

Read work returns `write:false`: rollback, never commit, ticket update or audit.
Ordinary failed reads roll back and can release a clean connection. Failed
cleanup destroys it. Existing shared uncertainty/receipt behavior for writes
is untouched. Every page rechecks authority.

## Filters, source and ordering

Only exact optional `scope=mine|unassigned`,
`status=needs_support|waiting_on_user`, `min_hours=0|24|72|168` and `after`.
Defaults are mine, needs_support, 24 hours. These are operator-selected
**last-update filters**, not overdue status, promised response time or elapsed
time since last customer/support reply.

Mine pins `assigned_to` to the server-canonical actor ID. Unassigned explicitly
uses SQL NULL. No arbitrary third-party-assignee selector. Needs-support
includes open and waiting_on_support; user-waiting is separate. Resolved/closed
are outside these filters, while the original assigned/general queues remain.

Source is `support_tickets.updated_at`, not MAX(reply time). Existing assignment
writes deliberately preserve it, and private notes do not update it. Reply/
status writes can update it. The UI states this distinction; no inference that
an old timestamp means no employee work or a breached response obligation.

Order is native SQL `updated_at ASC,id ASC`. Each exact assignee/status/time
range reads at most 26 via the new index; the two support statuses are combined
with UNION ALL and a bounded outer merge, limit 26. This avoids a global
status-union sort before limiting each range; actual EXPLAIN/load/lock cost
remains unverified. At most 25 fixed DTOs leave the server.

Fixed envelope `{tickets,next_cursor,as_of,filters}`. Ticket projection stays
the existing eight fields: id, ticket_number, category, subject, status,
priority, created_at, updated_at. No assignee/requester/contact IDs,
description, private notes, replies, receipts or lesson context. Validate all
lookahead rows, legal states, dates/order and uniqueness before returning.

## Cursor and schema

First page obtains absolute server time with `UNIX_TIMESTAMP()`; cursor freezes
that reference for up to 30 minutes. Timestamp comparisons round-trip native
seconds through `FROM_UNIXTIME`, avoiding a browser clock or assuming a session
timezone when converting UTC text. The opaque base64url cursor contains only
version, exact filters, reference time, last updated epoch and ticket ID.
Changing filters rejects the cursor, as do malformed, future or expired
references. It is a position selector, not an authority credential or anchor
lookup. Transferred/deleted anchors need not exist to continue.

Cursor freezes the clock reference, **not the tickets**. Concurrent replies,
status/assignment changes can remove/move rows; newly eligible rows behind the
cursor require refresh. No immutable history or real-time guarantee.

Existing assignment/readiness gates apply. Additional bounded catalog proof:
created_at/updated_at must actually be second-precision TIMESTAMPs, and exact
`idx_support_followup(assigned_to,status,updated_at,id)` must exist. Unsupported
precision fails closed rather than truncating keyset positions. Additive file
`server/migrations/20261107_02_support_followup.sql` is **unapplied**. Missing
proof returns 503 SUPPORT_FOLLOWUP_UNAVAILABLE before queue scanning; old
queues are not gated by this new index. No runtime DDL.

400 invalid input/expired cursor, 404 no verified support authority, 401 revoked
identity, 403 unsupported identity/direct session, 503 schema/source/cleanup
failure. Shared read failures can use SUPPORT_WRITE_UNAVAILABLE because the
existing service owns transaction cleanup; UI treats it as an unavailable read,
never a request to repeat a mutation.

See [client contract](../client/J04-SUPPORT-FOLLOWUP.md) and
[BUILD-41](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-41.md).
This is local source/test evidence, not actual schema, SQL execution, production
permission/isolation/performance/browser or service-policy acceptance.
