# J04 — private platform-support notes (BUILD-13)

BUILD-54 continuation (2026-11-08): relevant schema/indexes applied only to the isolated synthetic demo after snapshot; older unapplied statements below describe earlier checkpoints. Native generic-ticket HTTP/browser verification and rollback-only SQL transfer/revocation/paging/failure evidence: [report](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-54.md). Assignment snapshot/candidate reads share a bounded 25s deadline (including pagination); timeout releases busy state and fences late results. A confirmed write remains confirmed if its refresh times out. Existing audit is atomic but unsealed; no center-staff, lesson-context, SLA, production or load acceptance. Online linking remains deferred.

Local implementation checkpoint: 2026-11-05. Continues [lesson context](J04-LESSON-SUPPORT-CONTEXT.md) and [write reliability](J04-SUPPORT-WRITE-RELIABILITY.md). This is an internal platform-support surface, not tenant teacher assignment.

Follow-up: [BUILD-14 assignment backend](J04-SUPPORT-ASSIGNMENT.md) implements platform-support claim/transfer/recovery locally with an unapplied migration; the actual assignment UI and tenant staff mapping remain open.

## API and authority

- `GET /api/support-tickets/:id/private-notes?before=<note UUID>` returns exactly `{notes,next_cursor}`; no other query selectors. Latest 100 notes, chronological within each page, with a same-ticket `(created_at,id)` keyset anchor and a 101-row lookahead.
- `POST /api/support-tickets/:id/private-notes` requires a UUID `Idempotency-Key` and exactly `{body}`: trimmed nonempty string, at most 10,000 characters. Returns `{note,unchanged}` with 201 on insertion or 200 on identical replay.
- `GET /api/support-tickets/:id/private-notes/attempts/:requestId` reconciles only this actor's note attempt on this ticket. No query selectors, mutation or audit insertion.

All responses are `no-store`. Notes project only `id,ticket_id,author_id,author_name,body,created_at`; timestamps are canonical UTC instants derived from database Unix epochs. Malformed stored records fail closed. No contact, workspace, role, storage or provider fields are returned.

Every operation uses the existing authenticated support transaction: active canonical users-table identity, token-version/suspension checks, ticket lock and current bounded, locked platform permission proof. Ticket ownership or a signed role label alone is insufficient. Only verified super-admin or `support.read` authority qualifies. Denial is 404 before selecting private note bodies. Staff-only identities have no invented users-table mapping. The browser's admin hint only controls presentation.

## Isolation and persistence

Private notes live in a separate `support_ticket_private_notes` table, never the requester-visible reply table. Ordinary ticket detail, replies, requester lists and public attempt reconciliation do not query this table. Adding a note changes neither ticket status nor its public `updated_at`, and does not send a message or reopen a closed ticket. There is no edit, delete or promote-to-public endpoint.

The additive file `server/migrations/20261105_03_support_private_notes.sql` is **unapplied**. Runtime verifies actual InnoDB table presence, the five required columns, singleton ID primary key and exact `(ticket_id,created_at,id)` paging index. Missing proof returns 503 `SUPPORT_NOTES_UNAVAILABLE`; ordinary support is unaffected. The file's presence is not schema acceptance.

Resource identity uses the existing stable actor/operation/key hash with the separate `note` operation. Lookup binds note ID **and authorized ticket ID**. Same-key exact body replay returns the original note; changed body/target conflicts without another write. Insert and sanitized audit share one transaction; audit contains IDs only. Unknown COMMIT destroys the connection and returns `PERSISTENCE_UNCERTAIN`, with no blind retry. Read-only reconciliation can recover a committed note. Missing-attempt 404 is not proof an earlier operation cannot still commit.

## Actual UI behavior

The real Support page offers a collapsed internal-notes panel for its existing admin UI audience. Opening the panel performs the first private read; requesters never request private notes through this UI. An amber panel explicitly distinguishes internal notes from the public reply editor.

The controller fences ticket, principal/session and disposal changes; denial clears displayed notes. Session storage holds only an opaque UUID under account/operation/ticket, never note text or credentials. Reload recovery uses GET without another POST. Unknown outcomes retain the same key and freeze the payload. Existing 60-second browser deadlines do not cancel a possible database commit.

A confirmed save followed by a failed list refresh remains a confirmed save, with a separate refresh error and cleared stale rows. Manual refresh can restore the list without repeating the write. Older pages are explicit, bounded and single-flight. Session revocation is checked on subsequent operations; no continuous real-time revocation guarantee is claimed.

## Acceptance limits

Scoped synthetic SQL, actual router and browser evidence is recorded in [BUILD-13](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-13.md). No live MySQL/schema, query plan, lock-wait/load acceptance or production readiness is claimed. No migration, provider, delivery, deployment or package installation was performed. Future hard deletion/retention needs a durable replay/tombstone policy. Scoped assignment/transfer, tenant staff identity and response-time policy remain separate J04 work.
