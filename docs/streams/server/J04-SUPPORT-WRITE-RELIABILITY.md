# J04 — durable support attempts and atomic writes, BUILD-11

Local implementation, 2026-11-05. Extends [support detail and reply pages](J04-SUPPORT-DETAIL-BOUNDARY.md). The existing global platform-support inbox remains requester-owned with verified platform `support.read` administration. This does not grant a tenant teacher/staff access to other requesters' tickets or implement assignment routing.

BUILD-12 adds [optional verified lesson references](J04-LESSON-SUPPORT-CONTEXT.md) to creation, with source proof and binding in the same transaction. Its new columns are unapplied and generic support remains independent of them. The acknowledgement envelopes and opaque attempt-key contract below are retained.

## HTTP contract

Authenticated mount: `/api/support-tickets`. All responses retain `Cache-Control: no-store`.

| Method/path | Input | Success |
|---|---|---|
| `POST /` | Existing category/subject/description; required UUID `Idempotency-Key` | 201 `{ticket,unchanged:false}`; identical replay 200 `{ticket,unchanged:true}` |
| `POST /:id/replies` | Existing reply body; required UUID `Idempotency-Key` | 201 `{reply,ticket_id,ticket_status,unchanged:false}`; identical replay 200 with `unchanged:true` |
| `GET /attempts/create/:requestId` | UUID key, no query selectors | 200 create acknowledgement for this actor's confirmed request |
| `GET /attempts/reply/:requestId` | UUID key, no query selectors | 200 reply acknowledgement after rechecking that actor's access to the ticket |
| `PATCH /:id/status` | Existing allowed status | 200 `{success:true,status,unchanged}`; same current status is a no-op |

These write response envelopes replace the previous flat POST responses. The canonical client and actual Support page are updated together. Older callers omitting the required key receive 400; there is no non-idempotent fallback write. A client-supplied user/tenant selector never supplies authority.

Ticket acknowledgements expose exactly `id,ticket_number,user_id,category,subject,description,status,priority,created_at,updated_at`. Reply DTO remains exactly `id,body,created_at,sender_id,sender_name,sender_role`. Reply acknowledgement includes the server's actual current ticket status and exact ticket ID. The client validates the target and payload; it no longer infers the post-write status from a local admin label.

## Persistence and authority

The service requires actual InnoDB tables for `users`, both support tables, `audit_events`, `admin_user_roles` and `admin_role_permissions`, plus singleton `id` primary keys on users/support/audit tables. Catalog queries are bounded. Required column reads/writes fail closed if absent. Existing schema definitions are files, not evidence of an applied production schema. No new migration is needed for this design and none was applied.

Each transaction locks the active users row, rechecks token version and the shared SQL suspension predicate, then uses the stored canonical user ID. Staff-only identities are denied: the existing support/audit schema requires a users-table identity, and no staff-to-user mapping is invented. Login-session/workspace checks still run through the existing authentication middleware; the transaction does not invent a replacement authentication stack.

Writes for a given actor serialize on that users row. Ticket reply/status operations additionally lock the ticket and resolve super-admin/support permission grants through the same connection with a 100+1 bound and locks. Missing authority produces 404 for foreign tickets; unavailable or overflowing proof fails closed. An active user's signed role label alone never grants support administration.

Resource identity is a stable UUIDv8 derived from the first 128 bits of SHA-256 over the JSON tuple `['tabweb-support-v1', canonicalActorId, operation, lowercaseRequestUuid]`, with version/variant bits set. The namespace/algorithm is part of the replay contract. Operation separates create/reply; actor separates users. The key is a selector, not a credential. The existing resource primary key is the durable deduplication anchor. Persisted canonical strings are compared exactly in JavaScript, without relying on database text collation. Reuse with changed text, sender or reply target is 409 with no new write.

Creation, reply insertion, the reply's ticket-status change and their sanitized audit share one transaction. Audit records contain state/IDs only, never ticket text, reply text, contacts or secrets. Status PATCH also shares audit and detects no-op before updating timestamps. An unchanged reply status may truthfully report zero changed rows within the locked transaction; it is not confused with a missing ticket.

An identical reply replay rechecks access and returns its original reply without reopening a now-closed ticket or repeating audit/status changes. A fresh reply to a closed ticket remains 409. A rejected COMMIT is reported as 503 `PERSISTENCE_UNCERTAIN`; its connection is destroyed, with no automatic retry or compensation. Other SQL/audit failures roll back, return a sanitized failure and preserve the key for explicit retry.

## Reconciliation and browser behavior

Attempt GETs are read-only transactions. A missing confirmed row returns 404 `SUPPORT_ATTEMPT_NOT_FOUND`; that does **not** prove an earlier request will never commit. The client retains the same key. A confirmed GET returns the existing resource and clears the pending browser key without another POST. Reconciliation itself does not change ticket status or create an audit event.

The browser stores only the random UUID in `sessionStorage`, under the current account plus operation and reply target. Private form text stays in memory. Session storage survives reload in that tab; closing/clearing the tab storage removes this local recovery handle. Duplicate UI clicks are blocked, unknown outcomes freeze the current payload, and a recovered key can be checked before any resend. After reload the user may re-enter the original text under that retained key; a different persisted payload cannot silently create another record. Storage failure before sending prevents POST. Cleanup failure after an acknowledged save remains confirmed success and blocks starting a fresh attempt until local cleanup can be reconciled.

Requests have a 60-second browser wait deadline and lifecycle cancellation. A browser timeout/abort does not undo a database commit and never rotates the key. Session/identity changes and lost ticket authority fence late confirmations and clear private views; missing-attempt 404 is distinguished from lost ticket access. Confirmed replies already present in a refreshed conversation are not appended twice.

## Limits and remaining gates

Deduplication persists while the immutable support resource remains stored. A future hard-delete, body-edit or retention policy needs a tombstone/replay contract before implementation; this slice adds none. No server delete endpoint was introduced. Keys do not prevent a user intentionally creating two different requests with two different UUIDs. Concurrent retries can still wait on existing database locks; production query plans, lock wait policy and load were not measured.

No live database/schema/provider was contacted. Runtime mounting is real in code, but actual schema/constraints and driver concurrency remain production acceptance gates. Classification, scoped assignment/transfer, private support notes, response-time policy and staff identity mapping remain open. Billing-category support messages never mutate balances or trigger payments.
