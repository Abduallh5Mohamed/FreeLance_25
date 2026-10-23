# M2-22 — client contracts: publication and published-course discovery

Task: `client-m2-22-published-course-discovery-20261023-01`
Server contract: `docs/streams/server/M2-B14-CONTRACT.md`
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. Modules touched

| Path | Role |
| --- | --- |
| `src/lib/api-http.ts` | Canonical transport: the publication adapters, the discovery adapters, their DTO types and the strict parsers (additive only; `request` and every existing adapter are unchanged) |
| `src/features/catalog/public-course-discovery.ts` | NEW — the testable public page controller: bounded page, server-cursor next page, debounced/bounded search, exact detail read and every lifetime fence |
| `src/features/catalog/course-management.ts` | The accepted M2-02 seam, extended with exactly one capability: explicit publish / unpublish. Every pre-existing behaviour is untouched |
| `src/pages/Courses.tsx` | Adds the publication control and state line to the accepted private screen, and a link to `/discover` |
| `src/pages/PublicCourseDiscovery.tsx` | NEW — the anonymous `/discover` page. Owns no request and no decision |
| `src/App.tsx` | ONE public route: `/discover`, mounted WITHOUT `AuthGuard` |
| `src/tests/m2-public-course-discovery.test.ts` | NEW — production-path tests for the public controller and the shared parsers |
| `src/tests/m2-course-management.test.ts` | Extended with the M2-22 publication block (the 61 pre-existing tests are unchanged and still pass) |

## 2. Transport

```ts
publishCourse(courseId)              -> PUT /api/courses/:id/publication   { publication_state: "published" }
unpublishCourse(courseId)            -> PUT /api/courses/:id/publication   { publication_state: "draft" }

listPublicCourses({ limit?, cursor?, search? })
                                     -> GET /api/public/courses?limit=24[&cursor=…][&q=…]
getPublicCourse(courseId)            -> GET /api/public/courses/:courseId
```

- The publication body is **exactly** `{ publication_state }`. There is no client
  tenant or instructor selector in any header, query or body; the server selects
  the tenant and re-verifies the caller's membership and the target course inside
  the transaction that writes.
- The path ids are **resource selectors**, never authority.
- The discovery request sends `limit` = `PUBLIC_COURSE_PAGE_LIMIT` (24, the
  server default), the opaque `cursor` only when one was minted, and `q` only
  when the term is non-blank. A blank term is sent as **no filter at all**, not as
  an empty `q`.
- `PUBLIC_COURSE_PAGE_MAX = 60` and `PUBLIC_COURSE_SEARCH_MAX = 100` mirror the
  server bounds. No client code drains all pages automatically.
- The transport throws the server's `error` message **without** the HTTP status
  and **without** the `code`. Callers therefore classify only documented messages
  and never fabricate a status.

## 3. Strict parsers

| Parser | Accepts | Rejects |
| --- | --- | --- |
| `parseCoursePublication(body)` | a non-null object whose key set is EXACTLY `{course_id, publication_state, published_at}`, with a non-empty `course_id`, a state in `{draft, published}` and a string-or-null stamp | an extra or missing key, an unknown state, a non-string stamp |
| `parsePublicCourse(body)` | a non-null object whose key set is EXACTLY the ten projected fields, with non-empty `course_id`/`name`/`tenant_id`/`business_name`, string-or-null optional text, and `accent_color` that is `null` or canonical `#RRGGBB` uppercase | any other shape |
| `parsePublicCourseList(body)` | exactly `{ courses, next_cursor }` | a third key, a non-array `courses`, a non-string/non-null cursor |
| `parsePublicCourseEnvelope(body)` | exactly `{ course }` with a valid course | any other shape |

A non-canonical accent is **rejected**, not rendered: the server already
downgrades such a value to `null`, so receiving one means the contract broke.

`COURSE_PUBLICATION_MALFORMED_MESSAGE` and `PUBLIC_COURSE_MALFORMED_MESSAGE` are
raised instead of returning a fabricated record. A 2xx body that does not match
the projection is **never** a success.

## 4. Publication in the private seam

`course-management.ts` gains exactly one capability. Nothing else changes: the
list, the options, the create/edit form, the archive dialog and every existing
fence behave exactly as before.

```ts
controller.publish(courseId)     -> 'published' | 'unchanged' | 'duplicate'
                                  | 'blocked' | 'unavailable' | 'failed' | 'uncertain'
controller.unpublish(courseId)   -> 'unpublished' | …same set
controller.publicationState(id)  -> 'draft' | 'published' | null
```

- **The server response is authoritative.** Only a validated record for THIS
  course reporting the REQUESTED state confirms the action. A record for another
  course, a record reporting a different state, or an unparseable body is
  `uncertain` — no state is claimed.
- **A truthful no-op sends NOTHING.** If the requested state is already the
  confirmed one, the action reports `unchanged` without a request.
- **A duplicate click never sends a second write.** The publication action reuses
  the SAME single write latch as create / update / archive, acquired before the
  first await.
- **A reply observed after a session change never commits.** The same generation
  and principal boundary as the existing writes applies.
- **`null` is "unknown", never "draft".** The private list row carries
  `publication_state` only once the M2-22 migration is applied. A row without the
  column is unknown, a confirmed state is never downgraded to unknown by a list
  that simply does not report one, and an entry whose course is no longer listed
  is pruned.
- **A vanished course is dropped.** A 404 drops the row, its confirmed state and
  any delete dialog aimed at it.
- **`unavailable`** means this deployment does not wire the route at all: nothing
  is sent and no state is invented.

### Failure classification

| Outcome | When | What the page does |
| --- | --- | --- |
| `published` / `unpublished` | a validated record for this course in the requested state | shows the confirmed state, one request total, no refresh |
| `unchanged` | the requested state is already confirmed | nothing is sent; a notice says so |
| `duplicate` | a write is already on the wire | nothing |
| `blocked` | disposed, or retired by a session change | nothing |
| `unavailable` | the seam is not wired | nothing is sent; a notice says so |
| `failed` | 404 `Course not found` / `Course not found in your workspace`, 403 `Forbidden` / `Teaching access is not active for the selected tenant`, 403 `An active tenant membership is required` | the server message; a 404 also drops the row |
| `uncertain` | 500, network, malformed body, a record for another course, or a record in another state | the server message; **no** state claimed, **no** automatic retry |

## 5. The public page controller

```ts
controller.load() / refresh()      -> 'ready' | 'empty' | 'blocked' | 'failed'
controller.loadMore()              -> 'ready' | 'empty' | 'blocked' | 'failed'
controller.setSearch(value)        -> void   (records the value, schedules ONE debounced read)
controller.applySearch()           -> 'ready' | 'empty' | 'blocked' | 'invalid' | 'failed'
controller.openDetail(courseId)    -> 'ready' | 'unavailable' | 'blocked' | 'failed' | 'idle'
controller.closeDetail()           -> void
```

Lifetimes fenced:

- **list** — every read advances a generation and takes a single-flight latch
  BEFORE the first await. A duplicate fired in the same tick is refused *before*
  the search generation advances, so the read that already owns the latch still
  commits its own reply. A next page is only issued when the server minted a
  cursor, appends to the page it was issued for, and never runs while another
  read is in flight.
- **search** — the typed value is retained immediately; the READ is debounced
  (`PUBLIC_COURSE_SEARCH_DEBOUNCE_MS = 300`) and bounded. Each keystroke advances
  the search generation, so a debounced read that fires after a newer keystroke
  is **dropped** instead of committing a page for an obsolete term. Several
  keystrokes coalesce into one request. A term longer than
  `PUBLIC_COURSE_SEARCH_MAX` is refused **locally**, with no request.
- **target** — a detail reply carrying another course's id is not a success for
  the course on screen; closing the panel retires the read, so a late reply
  cannot reopen it.
- **session** — the canonical principal is re-read at entry AND at completion of
  every read, on the success and the failure path. A change retires every
  in-flight operation but **keeps** the held page: the published catalogue is
  public data that is byte-identical for every principal, so nothing held becomes
  foreign, and no automatic re-read is issued. An interrupted read settles to
  what is actually held rather than leaving the page stuck on "loading".
- **dispose** — nothing commits afterwards, and the pending debounce is
  cancelled.

Honesty rules:

- a 2xx body that cannot be validated is a **failed** read, never a partially
  adopted page and never an empty catalogue;
- a failed next page never discards the page already on screen;
- `unpublished`, foreign and absent are **one** `unavailable` answer — the page
  says the course is unavailable and never guesses which of the three it was;
- the page renders the validated server rows only. No local filtering, sorting or
  page-count arithmetic is invented to hide what the server did not send.

## 6. The `/discover` page

Public: mounted without `AuthGuard`, requires no session, consults no principal.
It renders the ten-field projection and nothing else — no price, no instructor,
no lesson or material, no contact detail, no enrollment, no subscribe and no
payment. Discovering a course is not access to it.

States: loading, idle, empty (with or without a term), error with a retry, and
ready with a bounded "load more". Every state has an accessible role
(`status` / `alert`) and the search input has a label and a described-by hint.

## 7. Tests

| Suite | Result |
| --- | --- |
| `src/tests/m2-public-course-discovery.test.ts` | **34/34** |
| `src/tests/m2-course-management.test.ts` | **78/78** (61 pre-existing + 17 M2-22) |

Both suites drive the REAL production modules with injected transports, a manual
timer for the debounce and an injected principal reader. No DB, no network, no
browser, no live service, no real `localStorage`, no dependency install.

## 8. Limits

- The migration is a **file only**. Until it is applied, the publication route
  answers a 500 and the private list carries no `publication_state`; the page
  therefore shows "publication state unknown" and reports the server's own
  message. It never guesses `draft`.
- The page is a catalogue. There is no enrollment, no access, no lesson delivery,
  no price and no checkout — by construction, not by omission.
- No pagination prefetch: the next page is read only when the user asks for it.
