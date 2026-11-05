# J04 — platform-support assignment and transfer (BUILD-14)

Current follow-up: [BUILD-16 self-assigned queue](J04-SUPPORT-ASSIGNED-QUEUE.md) implements the private paged view and actual UI locally with an unapplied index. Historical assigned-queue pending statements below are superseded by that contract; staff mapping and response-time policy remain open.

Local backend checkpoint, 2026-11-05. Continues [private notes](J04-SUPPORT-PRIVATE-NOTES.md). This slice implements the real mounted backend contract; the assignee picker and actual Support-page workflow are still pending. No tenant teacher/staff authority or automatic routing is introduced.

## BUILD-15 continuation — recipient discovery and actual UI

The actual Support page now integrates a collapsed assignment panel with claim, recipient selection, transfer, unassignment and explicit refresh/recovery. The backend-only/UI-pending statements elsewhere in this document preserve BUILD-14 history; this section supersedes them for the listed local functionality. [Current evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-15.md).

`GET /api/support-tickets/:id/assignment/candidates?after=<user ID>` is authenticated, no-store and ticket/platform-support authorized through the existing transaction. Only optional single `after` is accepted, with bounded ASCII ID syntax. Fixed response `{candidates:[{id,name}],next_cursor}` uses ID-ordered keyset pages of 25, SQL LIMIT 26 lookahead, active/non-suspended users and current super-admin/support.read EXISTS predicates. No phone/contact/role/workspace DTO fields or duplicates from multiple roles. A cursor is a selector, not authority. Listing is discovery; POST repeats bounded live locked recipient proof. Actual query-plan/scan cost remains unmeasured.

The UI reads only on explicit panel opening; requester views make no private assignment requests. Read and write responses are fenced by ticket, identity/session and disposal. Candidate paging is explicit/single-flight and rejects overlaps. Stored browser data is only an account/operation/ticket-scoped random UUID; the selected target/version stays in memory. Unknown outcomes block new decisions; exact same-key retry is available only for the retained in-memory payload. Reload recovery uses GET and then a separate current-state read, never applying a historical receipt as current state. Missing receipt retains uncertainty; no unsafe reset or reconstructed retry payload is provided.

Confirmed persistence and failed fresh-state refresh are separate messages; obsolete state is cleared. Exact server 409 STALE/TICKET_CLOSED/ASSIGNEE_UNAVAILABLE responses may clear the rejected attempt after successful local key cleanup, followed by fresh data before another explicit decision. Other conflicts/network failures retain the key. Failed cleanup blocks new decisions. Server-reported closure blocks new decisions for that panel lifetime even when the parent ticket snapshot was open. Ordinary support attempts do not opt into this new rejection handling.

No new migration or real provider activation was added. The existing unapplied counter/receipt migration and platform-only authority limits remain. Assigned queue, tenant staff mapping and response-time policy are still open.

## Authority and state

Every operation authenticates normally, then uses the existing support transaction to lock and recheck the canonical active users-table principal, token version, suspension and ticket. Verified super-admin or platform `support.read` authority is required; requester ownership and JWT role labels are insufficient. Denied callers receive 404 before assignment state or receipts are read. Unknown/overflowing proof fails closed.

Recipients must be current active, unsuspended users with the same bounded, locked support permission proof. The server resolves their canonical stored ID; selectors never grant authority. Null means unassign. No contact, role, tenant, workspace, provider or lesson metadata is exposed. Assignment does not grant recipient rights: later support actions still need their ordinary live permission proof.

The existing `support_tickets.assigned_to` is the authoritative assignment field. New `assignment_version` starts at zero, including previously assigned rows. A changed assignment increments it; a genuine no-op does not. There is no competing shadow assignment table. Status, public `updated_at`, replies and delivery remain unchanged.

## Mounted HTTP contract

All paths use the existing authenticated support router and declare `Cache-Control: no-store`; no query selectors are accepted.

| Method/path | Response or input |
|---|---|
| `GET /api/support-tickets/:id/assignment` | Exactly `{assignment:{ticket_id,assigned_to,version},assignee:{id,name}|null}` |
| `POST /api/support-tickets/:id/assignment` | Required UUID `Idempotency-Key`; exactly `{assigned_to:string|null,expected_version:number}` |
| `GET /api/support-tickets/:id/assignment/attempts/:requestId` | Actor/ticket-scoped immutable receipt, exactly `{assignment:{ticket_id,assigned_to,version},changed,unchanged:true}` |

Fresh POST returns 201 with that receipt shape and `unchanged:false`; identical replay returns 200 with `unchanged:true`. `changed` reports whether this recorded decision changed assignment; it is distinct from replay. A no-op records a receipt/audit atomically, without changing the assignment counter or public ticket timestamp. String recipient selectors are bounded ASCII IDs of 1–36 characters. Versions must be JSON safe integers from 0 through 2,147,483,646; reads accept the resulting final version through 2,147,483,647 and fail closed on corrupt persisted values.

Current-state GET returns `assignee:null` if the stored recipient is no longer eligible. The stored ID remains visible to authorized platform support as assignment history/state; no stale recipient name is returned. This is not automatic unassignment. Ordinary requester detail/list and general write acknowledgements retain their existing projections.

## Concurrency, replay and audit

POST locks the ticket, verifies actual schema, and checks the actor/`assign`/UUID immutable receipt first. Existing create/reply/note identity namespaces are unchanged. Identical replay is read-only even if a later transfer or closure occurred; changed payload/version or cross-ticket reuse conflicts.

For a fresh attempt, a mismatch with `expected_version` returns 409 `SUPPORT_ASSIGNMENT_STALE` without any assignment/receipt/audit write. Fresh decisions on closed tickets return 409 `SUPPORT_TICKET_CLOSED`. An ineligible target returns 409 `SUPPORT_ASSIGNEE_UNAVAILABLE`. Live target user/grants are checked under locks before a write. The update additionally pins the version in its WHERE clause.

Assignment update, immutable receipt and sanitized audit share one transaction. Audit includes old/new assignment IDs/versions and attempt ID, never names, ticket text, contacts or credentials. Any failure rolls all three back. Unknown COMMIT returns `PERSISTENCE_UNCERTAIN` and destroys the connection; no automatic retry or compensating transfer is performed.

Recovery GET proves current caller authority again and reads only that actor's same-ticket receipt. Missing receipt is 404 `SUPPORT_ATTEMPT_NOT_FOUND`, which does not prove an earlier attempt cannot still commit. Receipt state is **historical confirmation**, not current assignment: a UI must fetch current-state GET separately after confirmation and must not overwrite a newer assignment with an old receipt. Unknown outcomes retain the same key; an explicit new decision follows fresh state after a definitive rejection. No frontend recovery behavior is claimed in this backend-only slice.

## Schema and operational gates

`server/migrations/20261105_04_support_assignment.sql` is an **unapplied file**: additive counter plus InnoDB `support_assignment_attempts` with singleton ID PK and a ticket foreign key. Receipt recipient IDs intentionally survive recipient deletion and have no mutable recipient-name snapshot. Existing assignee column is reused; no backfill invents staff identities.

The runtime probes actual receipt InnoDB/table/required columns/PK and both ticket assignment columns in addition to the existing support/users/audit/permission transactional gates. Missing proof returns 503 `SUPPORT_ASSIGNMENT_UNAVAILABLE` before assignment reads/writes, without stopping ordinary support. No real schema was queried, altered or accepted.

Version protection applies to writes through this contract. Existing foreign-key `ON DELETE SET NULL` and any future administrative/legacy writer need an explicit counter/invalidation policy before operational use. Immutable receipts require a replay/tombstone policy before hard deletion or retention. Real MySQL FK/check behavior, query plans, permission-lock races, deadlock/lock-wait policy and load remain acceptance gates. Actor/ticket/recipient locking can deadlock under competing actors; caught transaction failure rolls back and requires conservative same-key handling, not a claim of lock-free operation.

No provider, notification, package install, live data or deployment was used. Remaining work: actual assignee selection/claim/transfer UI, bounded eligible recipient discovery, private assigned queue, scoped staff identity mapping and response-time policy. [Evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-14.md).
