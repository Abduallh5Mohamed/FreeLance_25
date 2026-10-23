# M2-13 — private academic-period planning catalog: client contracts

Task: `client-m2-13-private-academic-periods-20261021-01`
Worker: `workbuddy-native-m2-13-periods-20261021`
Server contract: `docs/streams/server/M2-B07-CONTRACT.md`
Correction: `client-m2-13-canonical-name-correction-20261021-01`
(`supervisor/207-m2-13-canonical-name-correction.md`) — canonical transported name.

Status: **IMPLEMENTED, TESTED, REPORTED — NOT ACCEPTED.**

---

## 1. Files

| File | Change |
| --- | --- |
| `src/lib/api-http.ts` | ADDITIVE: `AcademicPeriod`, `AcademicPeriodPagination`, `AcademicPeriodListEnvelope`, `AcademicPeriodEnvelope`, `ACADEMIC_PERIOD_PAGE_LIMIT`, `ACADEMIC_PERIOD_PAGE_MAX`, `listMyAcademicPeriods`, `createMyAcademicPeriod`, `updateMyAcademicPeriod` |
| `src/features/tenant/academic-periods.ts` | NEW: parsers, form builders, failure classifiers, injected controller |
| `src/features/tenant/AcademicPeriodsCard.tsx` | NEW: the Arabic/RTL card |
| `src/pages/InstructorDashboard.tsx` | ADDITIVE: one import + one `<AcademicPeriodsCard />` mount |
| `src/tests/m2-academic-periods-ui.test.ts` | NEW: 104 tests |

No other frontend file is touched. The provisional M2-B06 branding card, its
mount and the accepted dashboard logic are unchanged.

## 2. Transport

```
GET   /tenants/me/academic-periods?limit=<1..100>&offset=<0..10000>&archived=<true|false>
POST  /tenants/me/academic-periods
PATCH /tenants/me/academic-periods/<uuid>
```

* No tenant selector is ever sent — not in the header, the query or the body.
* `limit`, `offset` and `archived` are always explicit, so the client never
  depends on a server default.
* The create body is exactly `{ name, starts_on, ends_on }`.
* The update body carries ONLY the fields the caller set: `undefined` means
  "do not send", so a partial save cannot silently clear an untouched value.
* The period id is encoded into the path and never into a query.
* A failed response surfaces as its message only: the status and the `code` are
  discarded by the shared request helper, and nothing is invented from them.

## 3. Response parsing

The DTO parser requires EXACTLY the seven projected keys, a UUID `id`, a `name`
that is ALREADY canonical — exactly its own trimmed form, 1..255 characters —
`starts_on`/`ends_on` that are REAL calendar dates (`YYYY-MM-DD`, years
1000..9999, no normalization of `2026-02-30`), a non-reversed range, an ACTUAL
boolean `is_archived`, and two canonical instants that round-trip exactly
through `Date#toISOString()`.

A TRANSPORTED name that carries surrounding whitespace — `"  October  "` — is
REFUSED, never trimmed into a confirmed DTO: the trimmed value would be a name
the server never confirmed, and the client does not vouch for it. Canonical
means "exactly its own trimmed form"; it is NOT a rule about internal spacing,
which is a legitimate free label.

The list parser requires exactly `{ periods, pagination }`, a pagination object
with exactly `{ limit, offset, has_more }`, `limit` in `1..100`, `offset` in
`0..10000`, a boolean `has_more`, and — checked BEFORE any row is copied — a row
array that never exceeds the declared `limit`. One malformed row fails the whole
page, so a partial page is never rendered.

The single-period envelope requires exactly `{ period }`.

### Request trimming and confirmed canonicality are two different rules

The name the USER typed is trimmed before it is sent (`buildAcademicPeriodCreate`
/ `buildAcademicPeriodPatch`), exactly as the server trims it. What the server
CONFIRMS must already be canonical and is refused otherwise. The asymmetry is
deliberate: the client owns the request it makes, and the server owns the
answer it returns.

## 4. Dates are never `Date` objects

`starts_on` / `ends_on` stay STRINGS end to end. They are never parsed into a
`Date`, never converted to or from UTC and never given a time, because a
date-only planning label must not shift by a day because of a browser time zone.
The card renders them inside a `dir="ltr"` span so they are never re-formatted
into a locale string that could imply a time or a zone.

## 5. Controller lifecycle

State: `open`, `phase`, `rows`, `pagination`, `archivedView`, `hasPreviousPage`,
`error`, `reason`, `refreshError`, `lastConfirmed`, `form`, `mutation`.

* **Explicit open.** No request is issued until `open()` is called. `open()`
  performs exactly ONE bounded read of the first page. Calling it on an already
  open panel reads nothing.
* **Bounded paging.** `nextPage()` advances by one page ONLY when the server said
  `has_more`; `previousPage()` goes back one page and is a no-op on the first
  page. There is no polling, no per-row request and no "load all pages" path.
* **Archived view.** `setArchivedView()` is a filter of the same bounded list: it
  resets the offset and issues ONE read of that view's first page. Selecting the
  view that is already active, or switching while the panel is closed, issues no
  request.
* **Forms.** `openCreateForm()` / `openEditForm()` issue no request. The edit form
  is bound to the server-confirmed row values it was opened with.
* **Dirty subset.** `save()` sends only the fields whose effective value differs
  from the confirmed value; a whitespace-only name difference is NOT a change. A
  form with no real change issues NO request and reports that instead.
* **Merged range.** Changing one date is validated against the OTHER bound as it
  stands, exactly like the server, so the client never sends a range the server
  must reject.
* **Archive.** `setArchived(id, flag)` sends exactly `{ is_archived }`, and
  archiving a period that already has that state issues no request.
* **One request per action, synchronous latch.** A double click produces one
  write: the latch is taken before the first `await`, so the same-tick duplicate
  never reaches the transport.
* **Own visible-mutation ticket.** If a session change, a close or a disposal
  retires an in-flight write, the reply can no longer change the visible save
  state, the error, the notice, the latch or the form — and its `finally` cannot
  release a newer latch, because the guard releases only while the token still
  owns it.
* **Confirmed-write epoch.** A confirmed write advances the epoch, so a page read
  that started earlier can never overwrite the confirmed server state.
* **Form generation.** A confirmed write closes only the form that belonged to
  it. Cancelling during a write advances the generation, so the late reply
  reports the confirmed row without reopening or re-closing anything.
* **Principal observation.** The canonical principal is read on entry and again
  on both success and error, including RETIRED replies, so a silent logout or
  workspace swap cannot commit a reply that belongs to a previous session.
* **Session / close / dispose.** All three clear the private rows, the drafts and
  the notices immediately and retire everything in flight. A session change
  while the panel is open keeps it open and states the reason; disposal releases
  the session subscription.

## 6. Definite error vs unknown outcome

| Transport outcome | Client state |
| --- | --- |
| documented denial (`Forbidden`, `BILLING_ONLY`, session, suspended, no workspace) | private state cleared, phase stated |
| documented payload rejection | `idle` with the server message, draft preserved |
| `Academic period not found` | `idle` with the message, draft preserved |
| handler `500`, network failure, unrecognized message | `uncertain` — draft preserved, uncertainty stated, NOTHING retried |
| malformed 2xx on a write | `uncertain` — a body the client cannot describe is never treated as success |
| a page that carries a non-canonical name | `malformed` — no row is rendered from a page the client cannot confirm |
| a write that CONFIRMS with a non-canonical name | `uncertain` — the confirmation is refused, the draft is preserved, nothing is applied |

`reconcile()` performs an explicit read of the current page and labels itself as
a read. It never proves that the earlier save succeeded and never sets
`lastConfirmed`.

## 7. Component

Arabic / RTL, with:

* an explicit open control — no request for a viewer who never opens the card;
* one bounded list with next/previous paging and an archived-view toggle whose
  selected state is exposed through `aria-pressed`;
* a create/edit form with bound `<label htmlFor>` on every input;
* a reversible archive / restore control per row;
* `aria-live="polite"` on every feedback region;
* exactly ONE `type="submit"` control, and an explicit `type="button"` on every
  other button — so a page step, an archive or a cancel can never submit the open
  form by accident;
* a close control that is NEVER disabled, so a pending write or read can always
  be dismissed;
* wording that states the limitation: planning periods only, with no student
  registration, no access, no renewal, no payment and no automatic date
  transition.

No global locale, theme, route or direction change is made.

## 8. Verification

| Command | Result |
| --- | --- |
| `npx tsx --test src/tests/m2-academic-periods-ui.test.ts` | 113 pass / 0 fail (104 + 9 canonical-name regressions) |
| `npx tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | 330 pass / 0 fail (unchanged) |
| `npx tsx --test src/tests/m2-instructor-students.test.ts src/tests/m2-student-csv-preview.test.ts src/tests/m2-student-import-resolution.test.ts` | 173 pass / 0 fail (unchanged) |
| `npx tsx --test src/tests/m2-tenant-branding-ui.test.ts` | 89 pass / 0 fail (unchanged nearby set) |
| `npx tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/207-m2-13-canonical-name-probes.test.ts` | 2 pass / 0 fail (public immutable probe; 1 pass / 1 fail before the correction) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 scoped diagnostics; 11 pre-existing errors outside scope |

The 11 outside-scope errors are: `NotificationBell` 1, `StudentHeader_OLD_BACKUP`
2, `ExamReports` 2, `ExamResults` 1, `Fees` 2, `StudentBarcodes` 1,
`StudentDashboard` 1, `versionChecker` 1. None is in a file this batch created or
modified.

## 9. Limits

* No browser, DOM paint or real RTL layout: component behaviour is proven from
  the production element tree (markup plus the actual callbacks), not from
  pixels.
* The transport is exercised with `fetch` stubbed, so no real network, proxy or
  server latency is covered.
* No storage, clipboard or network-image use, by design.
* No performance claim.
