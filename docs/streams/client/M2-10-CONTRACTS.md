# M2-10 — private lesson-management UI: actual behaviour, checks and limits

Task `client-m2-10-lesson-management-ui-20261021-01` (WorkBuddy NEW native lane),
corrected by `client-m2-10-private-lifecycle-correction-20261021-01` (OpenCode,
supervisor/188 + /189): the render-time private-child gate and the real
canonical-instant validation.
Consumes the ACCEPTED backend contract 185 (`server/src/routes/course-lessons.ts`,
`docs/streams/server/M2-B05-CONTRACT.md`) and the accepted 183 unit UI. This
document describes what the CLIENT batch actually does and what it does not
prove. It is not an acceptance record: independent review is still required.

## Changed paths (the exact six)

| Path | Change |
| --- | --- |
| `src/lib/api-http.ts` | Additive lesson DTO + four adapters only. Shared request/auth/error/session and every existing adapter untouched. |
| `src/features/catalog/course-lessons.ts` | New injected production controller (validation, lifecycle, request/selection/epoch rules). |
| `src/features/catalog/CourseLessonManager.tsx` | New accessible Arabic/RTL lesson panel. |
| `src/features/catalog/CourseUnitManager.tsx` | Additive per-row lesson selection + keyed child mount. Accepted 183 unit controls and lifetimes unchanged. |
| `src/tests/m2-course-lesson-ui.test.ts` | New isolated production-path suite (76 tests). |
| `docs/streams/client/M2-10-CONTRACTS.md` | This file. |

No `Courses.tsx`, backend, schema, router, shared-helper, package, config,
provider or player change. The accepted migration file is still FILE-only and
was **not** applied.

## Transport (additive adapters)

Path family: `/tenants/me/catalog/courses/:courseId/units/:unitId/lessons`.

- `listCourseLessons(courseId, unitId, { limit = 25, cursor })` → `GET`.
  `limit` is always sent; `cursor` is sent only when present and is
  percent-encoded by `URLSearchParams`. No tenant selector in the header, the
  query or the body.
- `createCourseLesson(courseId, unitId, { title, description?, display_order? })`
  → `POST`. Only the given keys are serialized: a create without a description
  sends no `description` key at all.
- `updateCourseLesson(courseId, unitId, lessonId, subset)` → `PATCH`. Only the
  keys present in the subset are sent, so a status-only archive carries no
  title and a retitle carries no status. `description: null` is serialized as
  `null`, never as `""`.
- `reorderCourseLessons(courseId, unitId, items)` → `POST .../reorder`. The body
  is ONLY `{ items: [{ id, display_order }] }`.

The shared `request` keeps discarding the HTTP status and the `code`, so the
controller classifies only documented transported `error` messages.

## DTO and envelope validation

The lesson DTO is exactly eight keys:
`id`, `unit_id`, `title`, `description`, `display_order`, `status`,
`created_at`, `updated_at`.

Refused as malformed (never fabricated, never coerced):

- a non-object / array / `null` body, or any extra or missing key;
- an `id` that is not a UUID;
- a `unit_id` that is not EXACTLY the unit this controller is bound to;
- a `title` that is not a trimmed 1..255 string;
- a `description` that is neither `null` nor a string of at most 10000
  characters;
- a `display_order` that is not an integer in `0..2147483647`;
- a `status` other than `active` / `archived`;
- a timestamp that is not the canonical `YYYY-MM-DDTHH:MM:SS.sssZ` instant, or
  that has the right shape but is NOT a real instant: the value is parsed as a
  real date and must round-trip EXACTLY back to the same canonical string, so an
  impossible value (`2026-99-99T88:77:66.000Z`, `2026-13-01T00:00:00.000Z`,
  `2026-10-21T23:60:00.000Z`) and a calendar overflow
  (`2026-02-30T00:00:00.000Z`, which would normalize to `2026-03-02`) are both
  refused. There is no fallback date and no coerced value.

Envelopes:

- list: exactly `{ lessons, next_cursor }`. The **response** page bound is
  enforced here — more than 25 rows is malformed and is rejected BEFORE any row
  is traversed or copied. `next_cursor` must be `null` or a 1..256-character
  string.
- single: exactly `{ lesson }`.
- reorder: exactly `{ lessons }`, and the returned rows must be the EXACT
  requested identity set — same count, no duplicate id (case-insensitive), no
  unrequested id, no missing id, every row a valid DTO of the bound unit. A
  batch of more than 25 requested ids is refused.

## Read lifecycle

- No request happens before the user explicitly opens the panel. `refresh()`
  before `open()` is a no-op, and opening a form requires a settled page.
- `open()` issues exactly ONE bounded 25-row read. Paging is `nextPage()` (the
  server cursor) and `firstPage()` (cursor dropped). The page is REPLACED, never
  appended, and no totals or background draining exist.
- The cursor is a POSITION, not a snapshot: a reorder between two reads can show
  a row twice or hide one. The panel says so (`COURSE_LESSON_PAGING_NOTICE`).
- Every read carries a page generation and the `confirmedWriteEpoch` it started
  with. A read whose generation was superseded, or whose epoch is stale, settles
  its own loading phase and never commits.
- The canonical principal is observed at entry AND at completion, on the success
  and the failure path. A principal change is adopted BEFORE any visible state
  is settled, and a retired reply observes it before it settles anything.
- A session event, `close()` and `dispose()` clear the rows, the selection, the
  drafts and the confirmation, and retire every in-flight reply. A late reply
  can never restore stale private content.

Denials are distinguished by documented message only:

| Message | Phase | Reason |
| --- | --- | --- |
| `Token expired` / `Invalid token` / `No token provided` / `Session revoked` / `Selected workspace is no longer active` | `unauthorized` | `session` |
| `Instructor account is administratively suspended` | `denied` | `suspended` |
| `Course lesson management is not available while the account is limited to billing and support` | `denied` | `billing-only` |
| `Forbidden` | `denied` | `not-owner` |
| `Tenant membership not found` | `no-workspace` | `no-workspace` |
| `Course not found` | `missing-course` | `missing-course` |
| `Course unit not found` | `missing-unit` | `missing-unit` |

An unrecognized message stays a retryable read `error` with its own text; it is
never turned into a permission outcome. The local role, profile and tenant status
are NEVER used to infer the capability — the server stays authoritative.

## Write lifecycle

- ONE write flight: the latch is acquired synchronously before the first await,
  so a second click/Enter never reaches the transport.
- The mutation's OWN latch ticket is released at most once, either immediately
  after the server confirms the write — BEFORE the bounded follow-up read is
  awaited — or in the `finally` of a failed/denied/uncertain write. Because the
  ticket source is monotonic, an older `finally` can never free a NEWER
  mutation's latch. Consequence (the 179/183 finding): an enabled control is
  never a silent no-op after a confirmed save.
- A confirmed create and a confirmed reorder each trigger AT MOST ONE bounded
  first-page read. A confirmed position change re-reads the page so the
  canonical order is shown. A failed follow-up read sets `refreshError` and
  NEVER turns the confirmed save into a failed save.
- `edit` sends only the changed subset. An unchanged editor sends nothing and
  says so. A description is sent only when the user changed it; an explicit
  "clear" sends `null`; an empty string stays an empty string.
- `status` is a separate explicit archive/reactivate action. A status write for
  the status the row already has is not sent.
- A PATCH answered with a well-formed DTO for ANOTHER lesson id is NOT a success
  for this write: nothing is committed and the write stays uncertain.
- Uncertain (handler 500, network/transport failure, malformed 2xx, foreign
  identity): `mutation.status === 'uncertain'`, the draft is preserved, no
  automatic retry is ever sent, and the only offered action is an explicit
  read reconciliation. That read reports the CURRENT state and explicitly does
  not claim the previous write succeeded (`COURSE_LESSON_RECONCILED_MESSAGE`).
- Denied/conflict/invalid/missing: the server did not write. The rows, the
  selection and the draft are preserved and the user may retry explicitly.

## Atomic reorder

- Only a row of the CURRENT page can be selected (`toggleSelection` ignores any
  other id), and at most 25 unique ids (the client bound; the server's 100 is
  backend-only and never used to widen it).
- `openReorderForm()` builds the drafts from the visible page order. An empty
  selection opens no form and issues no request.
- `submitReorder()` validates EVERY position (and re-checks that every id is
  still a visible row, with no duplicate) BEFORE a single byte is sent. A batch
  that changes nothing is not sent at all.
- ONE request carries the whole selection; there is no per-row update loop, no
  blanket renumbering and no cross-page or cross-unit ordering.
- The returned identity set is validated before applying. `lastReorder` reports
  `selected` (rows the server returned) and `changed` (rows whose position
  actually differs from the pre-batch page) truthfully.

## Component behaviour

`CourseLessonManager` renders only; it owns no request, cursor or decision.

- Arabic/RTL: `dir="rtl"`, an `aria-label` naming the unit, `<label htmlFor>` for
  every input, and `aria-live="polite"` feedback regions.
- The selection toggle is a real button with `aria-pressed`.
- Exactly ONE `type="submit"` per open form; every other button is explicitly
  `type="button"`, so an archive, a cancel or a paging button can never submit
  the form.
- The close control is NEVER disabled: a slow request can always be abandoned.
- A control is disabled only while a mutation is ACTUALLY in flight or while a
  form is open. A definite failure keeps its message without latching the row
  disabled. Reads stay available while a write is in flight (separate flight).
- The position is labelled as a DISPLAY position inside the unit; archiving is
  labelled as metadata-only. Neither changes student access.

`CourseUnitManager` gains, additively:

- a per-row "دروس الوحدة" toggle with `aria-expanded`;
- a `<CourseLessonManager key={unit.id} …>` mounted ONLY for the explicitly
  selected row, inside the open panel, receiving the immutable `courseId` and the
  selected `unit.id`;
- a lifetime effect that clears the selection when the panel is closed, when the
  private scope is lost (`unauthorized`, `denied`, `no-workspace`,
  `missing-course`, `malformed`) or when a SETTLED page no longer holds the
  selected row. A transient `loading` phase is not a settled page and never tears
  the child down.
- a RENDER-TIME gate (supervisor/188) that mounts the child ONLY while the parent
  scope is permitted AND the settled page still holds the selected row. The gate
  mirrors the lifetime effect EXACTLY, so the private lesson panel is never
  painted for one frame in a denied / unauthorized / no-workspace /
  missing-course / malformed parent, nor for a row that already left the settled
  page. The private UI is never gated by a passive effect alone, and a permitted
  parent that still holds the row (including a transient `loading` that retains
  it) keeps the child mounted.

The accepted 183 unit controller, its controls and its lifetimes are unchanged.

## Checks run

| Check | Result |
| --- | --- |
| `npx tsx --test src/tests/m2-course-lesson-ui.test.ts` | 76 tests, 76 pass, 0 fail |
| `npx tsx --test` on the unchanged M2-09 / course / branch / profile suites | 254 tests, 254 pass, 0 fail |
| `npx tsx --test` on the unchanged public 179 probe | 3 tests, 3 pass, 0 fail |
| `npx tsx --test` on the unchanged public 188 probe | 6 tests, 6 pass, 0 fail |
| `npx tsc --noEmit -p tsconfig.app.json` | the known 11 pre-existing diagnostics outside these paths; ZERO new diagnostics |

The suite drives the REAL adapters through the REAL `request` with a stubbed
`fetch`/`localStorage`/`window`, the REAL controller with an injected fake
transport and session sink, and the REAL components through
`react-dom/server` — including the REAL callbacks of the rendered element tree,
so an enabled-but-dead control is observable rather than inferred from source.

## Limits (not proven here)

- No DOM paint, no real RTL layout, no browser, no real HTTP, no DB, no live
  service, no dependency install.
- Server-side authorization is NOT exercised end to end: the server remains the
  only authority, and this batch only reports what it says.
- The accepted migration is FILE-only and was not applied, so NO runtime lesson
  rollout is claimed.
- Paging is position-based: a concurrent reorder between two reads can duplicate
  or hide a row. The panel states this instead of claiming a stable snapshot.
- No lesson content, assets, uploads, publication, student/teacher assignment,
  access policy, OTP or financial surface exists in this batch.
- Performance was not measured; the page is bounded at 25 rows and there is no
  per-row background fetch, but no timing claim is made.

## Done means

Private lesson-management UI only. Not full C5, not M2, not a rollout.
