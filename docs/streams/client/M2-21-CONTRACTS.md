# M2-21 — client contracts: private group announcements

Task: `client-m2-21-private-group-announcements-20261023-01`
Server contract: `docs/streams/server/M2-B13-CONTRACT.md`
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. Modules touched

| Path | Role |
| --- | --- |
| `src/lib/api-http.ts` | Canonical transport: the four new adapters, their DTO types and the strict parsers (additive only; `request` and every existing adapter are unchanged) |
| `src/features/groups/group-announcements.ts` | The testable controller: the panel's state, parsers, classifiers, bounded page lifecycle, single-flight writes and every lifetime fence |
| `src/pages/Groups.tsx` | Mounts the panel inside the accepted M2-19 group screen. Owns no request and no decision |
| `src/tests/m2-group-announcements.test.ts` | Production-path tests for both the transport seam and the controller seam |

## 2. Transport

```ts
listGroupAnnouncements(groupId, { limit?, cursor? })
  -> GET  /api/groups/:groupId/announcements?limit=25[&cursor=…]

createGroupAnnouncement(groupId, { title, body, state? })
  -> POST /api/groups/:groupId/announcements

updateGroupAnnouncement(groupId, announcementId, patch)
  -> PUT  /api/groups/:groupId/announcements/:announcementId

retractGroupAnnouncement(groupId, announcementId)
  -> POST /api/groups/:groupId/announcements/:announcementId/retract   body: {}
```

- The default page size is `GROUP_ANNOUNCEMENT_PAGE_LIMIT = 25`, the server's
  own default; `GROUP_ANNOUNCEMENT_PAGE_MAX = 100` is the server ceiling. No
  client code drains all pages automatically — a next page is only ever asked
  for with the cursor the server itself minted.
- **No client tenant or instructor selector exists** in header, query or body.
  The server selects the tenant and re-verifies the caller's membership, the
  owned same-tenant group and the announcement inside the transaction that
  writes.
- The path ids are **resource selectors**, never authority.
- The write bodies are strict. Create sends `title` and `body` (plus `state`
  only when the instructor chose one). Update sends exactly the keys it was
  given — the panel always sends both `title` and `body`, so an accidental
  omission can never silently keep a stale value. Retract sends `{}`.
- `state` is only ever `draft` or `published`. `retracted` is unreachable from
  the client, so a retraction can never be forged by writing a state.
- The transport throws the server's `error` message **without** the HTTP status
  and **without** the `code`. Callers therefore classify only documented
  messages and never fabricate a status.
- Unlike the legacy `createGroup`/`updateGroup`/`deleteGroup` helpers in the same
  file (which swallow an error into `null`/`false`), these adapters never
  swallow: a failure is always a thrown documented message.

## 3. DTO validation

The server's projection is exactly eight fields, and anything else is a
malformed response — never a fabricated announcement:

```ts
interface GroupAnnouncement {
  id: string;                 // non-empty
  group_id: string;           // non-empty
  title: string;              // non-blank
  body: string;               // non-blank, stored exactly as sent
  state: 'draft' | 'published' | 'retracted';
  created_at: string | null;  // SERVER stamp, opaque to the client
  updated_at: string | null;
  retracted_at: string | null;
}
```

`parseGroupAnnouncement` refuses: a non-object, an array, a `null`, an extra key
(`tenant_id`, `instructor_id`, …), a missing field, a blank `id`/`group_id`/
`title`/`body`, an unknown `state`, and a non-string-or-null stamp.

The list envelope must be **exactly** `{ announcements, next_cursor }`:
`parseGroupAnnouncementList` refuses an extra key (`total`, …), a missing
`next_cursor`, a non-array `announcements` and any malformed row inside it. A
malformed row fails the WHOLE page, so a partially adopted list is impossible.

The stamps are treated as opaque server labels. This batch applies **no**
timezone conversion, no publish-at/expiry interpretation and no client-side
ordering by time.

## 4. Failure classification (documented messages only)

Reads (`classifyGroupAnnouncementReadFailure`):

| Message | Phase | Reason |
| --- | --- | --- |
| `Token expired`, `Invalid token`, `No token provided`, `Session revoked`, `Selected workspace is no longer active` | `unauthorized` | `session` |
| `Instructor account is administratively suspended` | `denied` | `suspended` |
| `Teaching access is not active for the selected tenant`, `Forbidden` | `denied` | `denied` |
| `Tenant membership not found` | `no-workspace` | `no-workspace` |
| `Group not found` | `error` | `missing` |
| `Invalid announcement list limit`, `Invalid announcement list cursor`, the four payload messages | `error` | `invalid` |
| `Failed to list announcements` | `error` | `server` |
| anything else | `error` | `unknown` |

Writes (`classifyGroupAnnouncementWriteFailure`): `unauthorized`, `denied`,
`missing` (with `missingTarget: 'group' | 'announcement'`), `invalid`,
`conflict` (`Announcement is retracted`, `Announcement was modified
concurrently`) and `uncertain` (the handler `500` and every unrecognized or
network failure after the request was sent).

`isGroupAnnouncementAuthorizationLoss` is true for `session`, `suspended`,
`denied` and `no-workspace` only. A retryable `500`, a network error and an
unrecognized message are NOT an authorization loss and never discard a draft.

## 5. Controller surface

```ts
createGroupAnnouncementController(api: GroupAnnouncementApi)
  .getState() / .subscribe(listener)
  .select(groupId | null)      // names the group and reads page 1
  .refresh()                   // re-reads page 1
  .loadMore()                  // reads the NEXT page, only with a server cursor
  .openCreate() / .openEdit(id) / .setField(patch) / .cancel()
  .save()                      // create or update, from the form
  .publish(id)                 // explicit draft -> published
  .retract(id)                 // explicit, terminal
  .waitForIdle() / .dispose()
```

`save`, `publish` and `retract` return an explicit outcome — `confirmed`,
`rejected`, `uncertain`, `blocked`, `invalid`, `unchanged`, `idle` — so the page
never infers a result from state.

## 6. Lifetimes fenced

- **Selection.** The panel always names the group whose announcements it holds.
  `select` advances a selection generation, clears the rows, the cursor, the
  form and the draft, and retires any in-flight reply for the previous group, so
  a late reply can never be shown under the new heading.
- **Read.** Every page read takes a single-flight latch BEFORE the first await
  and advances a generation, so a double-clicked refresh never sends a second
  request and a superseded reply never commits. `loadMore` is refused while a
  read is in flight and only runs when the server minted a cursor.
- **Append.** A next page appends only to the page it was issued for. A failed
  or malformed append **keeps** the page already held and the cursor, so the
  read can be retried without losing what the instructor is looking at.
- **Write.** Every mutation advances its own generation and takes ONE shared
  single-flight latch BEFORE the first await, so a double-clicked save, a click
  plus Enter, or a publish racing a retract never sends a second write.
- **Form.** Opening, cancelling or invalidating a form advances the form
  generation, so a late reply never rewrites or closes a newer form.
- **Target.** A reply carrying another announcement's id — or another group's id
  — is NOT a success for this write; it settles as `uncertain`.
- **Authorization.** A definite loss clears the held rows, the form and the draft
  and retires every in-flight operation. A `404 Announcement not found` removes
  exactly that row and closes a form bound to it; a `404 Group not found` clears
  the whole panel. A retryable failure keeps the draft.
- **Session.** The canonical principal is re-read at entry AND at completion of
  every read and write, on the success and the failure path, and a RETIRED
  operation observes it BEFORE it settles any visible state. A session event
  clears the private state and drops in-flight replies.
- **Dispose.** Nothing commits after the page is gone, and every entry point is
  inert.

## 7. Honesty rules

- A 2xx body that cannot be validated is NOT a success.
- A `500`/network/malformed write outcome is **uncertain**: the write may have
  persisted, nothing is retried automatically and the draft is preserved with a
  warning.
- A confirmed success uses the validated server DTO only. No refresh is issued
  after a write, so a confirmed write costs exactly one request.
- An action the current state already satisfies sends **nothing** and claims
  nothing: publishing a published announcement, retracting a retracted one and
  saving an unchanged edit all return `unchanged` with no request on the wire.
- A retracted announcement is never opened for edit (retraction is terminal).

## 8. Scope boundary

Private management surface only. The panel sends no email, SMS or push,
schedules no delivery (no publish-at, expiry, delivery window or timezone
policy), notifies no recipient, and creates no session, attendance, enrollment,
access, role or billing effect. Nothing it renders is exposed to a student
principal.

`src/pages/Groups.tsx` keeps the accepted M2-19 group screen untouched and adds
only the announcement entry point and dialog; the M2-19 controller, its form and
its dialogs are unchanged.

## 9. Test coverage (hermetic, production-path)

`src/tests/m2-group-announcements.test.ts` — 48 tests over the real
`src/lib/api-http.ts` adapters (driven through a stubbed
`fetch`/`localStorage`/`window`) and the real controller (driven with an
injected fake transport, principal reader and session notifier). No DB, no
network, no browser, no live services, no install.

**Not claimed:** DOM rendering, RTL paint, real HTTP, real DB, live services and
end-to-end authorization (the server remains authoritative).
