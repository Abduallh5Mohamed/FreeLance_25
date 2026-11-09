# J04 — follow-up queue UI

BUILD-54 continuation (2026-11-08): relevant schema/indexes applied only to the isolated synthetic demo after snapshot; older unapplied statements below describe earlier checkpoints. Native generic-ticket HTTP/browser verification and rollback-only SQL transfer/revocation/paging/failure evidence: [report](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-54.md). Assignment snapshot/candidate reads share a bounded 25s deadline (including pagination); timeout releases busy state and fences late results. A confirmed write remains confirmed if its refresh times out. Existing audit is atomic but unsealed; no center-staff, lesson-context, SLA, production or load acceptance. Online linking remains deferred.

BUILD-41 adds a collapsed section in the actual Support page under its existing
platform-support UI hint. Closed section mounts no reader and sends no requests.
Opening uses the current session to read the server-authorized follow-up page.
The UI hint is not authority: server grants are rechecked independently.

Operator selects mine/unassigned, support-waiting (including new)/user-waiting,
and minimum last-update interval (any, 24h, 3d, 7d). Labels say last ticket
update, not breached SLA, waiting-for-reply age or automated reminder. Source
does not include private-note or assignment activity. It displays the server
clock reference, per-row elapsed full hours and canonical time in Cairo.

Strict parser reuses the existing fixed ticket projection and validates the
envelope, selected filters, states, reference/cutoff, oldest-first timestamps,
duplicate IDs and bounded cursor/page. No private extra fields are accepted.
Transport sends canonical same-origin authenticated no-store GET, filters and
optional cursor only. Nothing is persisted or sent to an external channel.

Controller holds only one 25-row page; next replaces rather than accumulating
an unlimited inbox. Refresh resets the time reference. Cursor filtering is
server-owned; changing filters discards previous rows/cursor and aborts/fences
the prior request. Same-tick duplicate reads are suppressed. A 25-second
deadline clears current work; late results cannot revive it.

Read failure clears the previous page. Invalid/expired next-page context asks
for refresh rather than presenting stale data. Next page must retain reference
time and not overlap the current page. This is not a snapshot of all ticket
changes; other operators' work requires refresh.

Current Support page feeds the established counted assignment activity gate
and local create/reply/status busy states. While active, rows and actions are
suspended. Settlement triggers a new first-page read; this does not confirm an
unknown write or replace existing immutable receipt recovery. Other operators'
activity is not subscribed to. No automatic provider/timer worker is added.

Only a current displayed row can invoke the existing `openTicket` callback,
which reauthorizes detail. The queue creates no assignment-based access grant.
Session/identity/scope/storage events and disposal fence reads and row actions.
Unsubscribing closes the reader; no private state or cursor is written to storage.

Tests cover controller/transport behavior and actual list hooks/callbacks.
Mount and parent activity wiring are additionally asserted from source; there
was no actual browser/device or real backend acceptance run. See
[server contract](../server/J04-SUPPORT-FOLLOWUP.md) and BUILD-41 evidence.
