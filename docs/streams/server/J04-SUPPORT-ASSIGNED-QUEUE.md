# J04 — self-assigned platform-support queue (BUILD-16)

Local implementation checkpoint: 2026-11-05. Extends [assignment and transfer](J04-SUPPORT-ASSIGNMENT.md). This is an organizational view for existing verified platform support; it does not introduce assignment-based access rights, a teacher inbox or tenant staff identities.

## Server contract

`GET /api/support-tickets/assigned?after=<ticket ID>` is mounted on the actual authenticated support router before `/:id`. All responses are `no-store`. Only an optional single bounded ASCII ID `after` is accepted; actor, tenant, recipient, sort, status and other query selectors are refused. The cursor is a plain ordering selector, not a ticket lookup or access credential.

The shared transaction rechecks the active canonical users-table identity, token version, suspension and bounded locked super-admin/support.read permission proof. Missing grant returns 404 before queue data access; staff-only accounts remain unsupported. SQL pins `t.assigned_to=?` to the **stored canonical actor ID**, never a client user selector. Every page repeats authority. Empty membership returns an empty page, not a denial.

Fixed response: `{tickets,next_cursor}`. Each ticket projects exactly `id,ticket_number,category,subject,status,priority,created_at,updated_at`. No description, requester identity/contact, assignee ID, note, receipt, answer or lesson context is included. Timestamps come from database Unix epochs and are serialized as canonical UTC instants; invalid stored rows fail closed.

Pages contain at most 25 tickets, with a 26-row lookahead and `ORDER BY t.id ASC`; next cursor is the last returned ID when a lookahead exists. All statuses, including resolved/closed, are included and shown as such. This is stable ID browsing, not priority or age ordering. The anchor need not still be assigned or exist: `id > after` does not reveal another actor's anchor and continues after a transfer. Newly assigned rows behind the cursor require a refresh; there is no immutable snapshot or real-time guarantee.

## Required schema

Existing assignment/counter/receipt readiness checks still apply. The queue additionally proves the actual exact `(assigned_to,id)` index `idx_support_assignee_id`, with bounded catalog reads and no inferred readiness from a migration file. Missing proof returns 503 `SUPPORT_ASSIGNED_UNAVAILABLE` before reading queue rows. The additive file `server/migrations/20261105_05_support_assigned_queue.sql` is **unapplied**; it creates only that index. Existing ordinary support and other assignment surfaces are not gated by this new queue-only index check.

No migration was applied or actual MySQL query plan/load measured. A bounded returned page is not proof of bounded database work. Index presence is a prerequisite, not a performance benchmark.

## Actual UI and lifecycle

The actual Support page offers a collapsed **الطلبات المسندة لي** section under the existing admin UI hint. It sends no assigned-queue requests while collapsed; requester UI makes no such requests. Opening reads a fresh first page. Explicit refresh clears old rows; failed refresh never presents them as current. Explicit next-page loading is single-flight, rejects overlap, retains cursor on ordinary failure and never writes. The list has bounded vertical scrolling and adapts to mobile/desktop.

Only a currently displayed row in the current session may trigger the existing detail controller, which repeats ordinary server ticket authorization. Assignment grants no detail authority. Session/identity/disposal changes fence late responses and row actions; denial or missing schema clears the queue. No queue data is added to browser storage.

Actual assignment write/retry/recovery actions notify the page before starting and after settling. A counted activity gate clears/aborts an open queue immediately and disables its row actions while any local assignment action is active. On settlement a fresh first-page read replaces it, so local transfer/unassignment does not leave obsolete ownership shown. This read does not claim an unknown write is confirmed; existing attempt uncertainty and immutable receipt recovery remain separate. Even a timed-out request can commit later; explicit refresh is available and no polling guarantee is made. Other operators' changes require refresh.

The general platform queue remains available with its prior authority and behavior. Self-assigned browsing is an additional view, not a restriction of platform support's existing global rights. Merely viewing assignment state does not mutate or automatically reassign tickets.

## Evidence and remaining work

[BUILD-16 evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-16.md) records scoped tests and synthetic actual-page browser proof. Real schema/index/locking/production acceptance remains pending. Response-time policy, tenant staff mapping and other support context kinds remain separate contracts. Next business implementation moves to J02/J03 lesson package/video binding; no deadline threshold or notification provider is invented.
