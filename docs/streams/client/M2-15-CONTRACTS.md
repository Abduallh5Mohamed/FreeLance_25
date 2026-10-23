# M2-15 — client contracts for explicit existing-match review and the combined report

Task: `client-m2-15-existing-match-review-report-20261021-01`.
Handoff: `docs/streams/client/M2-15-HANDOFF.md`.
Builds on: accepted M2-08 (local CSV preview), accepted M2-11 (local decisions +
JSON report), accepted M2-14 (read-only server reconciliation).

M2-08, M2-11 and M2-14 behaviour is **unchanged**. This batch connects the
M2-14 warning to the M2-11 decisions and to the M2-11 report. It still performs
no import, no server write, no overwrite, no merge, no identity link and no
enrollment.

## Modules

| Path | Change |
|---|---|
| `src/features/students/import-resolution.ts` | **additive** review model + five controller methods |
| `src/features/students/import-report.ts` | **additive** `existing-value-match` reason + `matched_fields`; version `1 → 2` |
| `src/features/students/StudentImportPreview.tsx` | **additive** review counts block + three per-row review controls |
| `src/features/students/server-resolution.ts` | **unchanged** (read and relied on, not modified) |

No api-http, backend, router, schema, migration, auth, shared, package or config
file is touched by this batch.

## Review states

```ts
export type ServerMatchReviewState = 'pending' | 'kept' | 'excluded';
export const SERVER_MATCH_REVIEW_STATES = ['pending', 'kept', 'excluded'] as const;
```

| State | Meaning |
|---|---|
| `pending` | the value exists in the tenant; the row is still `included`; nothing decided |
| `kept` | the user explicitly kept the row included |
| `excluded` | the user explicitly excluded the row **because of** the match |

The three are mutually exclusive and their counts always sum to the size of the
current review set.

## Seeding

`seedServerMatches(state, result)` is the **only** way a review appears, and it
accepts only the **current confirmed** M2-14 result:

- a row becomes a review item only when the result names at least one field for
  it **and** the row exists in this model **and** its status is `included`; a
  result for an unknown row, a `pending` row, an `excluded` row or an `invalid`
  row is ignored rather than invented;
- the whole previous set is **replaced atomically** — there is no merge of two
  answers;
- seeding **never changes a decision**: a matched row keeps `included` and gains
  `review: 'pending'`. An automatic exclusion is exactly what the handoff
  forbids;
- re-seeding the **same** result object is a **no-op** (`serverMatchSource ===
  result`), so a re-render cannot reset a keep/exclude the user already made.

`clearServerMatches(state)` retires every review and forgets the source. It is
idempotent: an already-empty set is returned unchanged, so a caller may run it on
every non-confirmed transition without churning the revision.

## Fencing

| Fence | Rule |
|---|---|
| Generation | Every seed takes `serverMatchGeneration + 1`; every entry records it |
| Stale read | `currentServerMatchReview` returns `null` for an entry whose generation is not the current one, so a superseded reconciliation can never paint a warning or reach a report |
| Source identity | `serverMatchSource` holds the exact confirmed result object; the same object re-seeds nothing |
| Retirement | A plain CSV decision, a reset, a clear, a new file, a close, a principal change, a session event and a disposal all retire the set |

`include()` and `exclude()` run `clearServerMatches(state)` **before** applying
the plain decision, so a within-file decision can never coexist with a review set
that was computed against a different inclusion set.

## Transitions

| From | Action | To | Decision side |
|---|---|---|---|
| `pending` | `keepServerMatch` | `kept` | unchanged (`included`) |
| `pending` | `excludeServerMatch` | `excluded` | `included → excluded` |
| `kept` | `undoServerMatch` | `pending` | unchanged |
| `excluded` | `undoServerMatch` | `pending` | `excluded → included` |

`keepServerMatch` requires the row to be `included`, so the model can never hold
the contradictory pair `review: 'kept'` + `status: 'excluded'`.
`excludeServerMatch` requires the row to be `included`; it is the **only** path
that turns a match into a decision, and it is always explicit.

### Undo safety

`undoServerMatch` re-includes a row without running the conflict check, and that
is provably safe: **while a review set exists**, the only decision changes
available are `keepServerMatch` (no decision change) and `excludeServerMatch`
(removal). Every plain decision retires the whole set first, so no other row can
have been included since the row was excluded. The re-included row therefore
collides with exactly the set it belonged to before, and cannot create a new
within-file conflict.

## Report — version 2

`IMPORT_REPORT_VERSION` is now `2`. A v1 consumer must not silently read a v2
document, because both the row shape and the reason vocabulary grew.

`ImportReportRow` gains:

```ts
readonly matched_fields: readonly string[];   // exact field NAMES, or []
```

`reasonsOf(row, review)` appends the documented reason **`existing-value-match`**
when the row is `excluded` and its current review is `excluded`.

Rules that are preserved from M2-11 and restated here:

- only **non-included** rows are carried, so an included row's private values can
  never be exported by accident;
- rows are ordered by physical line and object keys are written in a fixed
  order, so the same decisions always produce byte-identical output;
- `matched_fields` carries **names only** — never a stored value, a record id, a
  person name or a count of existing records;
- `matched_fields` is populated **only** for a row excluded by its match, and
  only from a review of the **current** generation; a stale or superseded
  reconciliation contributes nothing;
- the size gate runs on the **serialized** text before any `Blob` or object URL
  exists;
- one click produces at most one `Blob`, one object URL and one link; the link is
  removed in a structured `finally` and the URL is revoked at most once, on the
  next tick, on every failure, on replacement, on every retirement and on
  disposal;
- formula-looking and markup-looking text stays inert JSON data.

`matched_fields` order is the **documented response order**
`email, phone, barcode` — not the accepted parser's `phone, email, barcode`
duplicate-column order. The two are the same set in a different order and are
never aliased.

## UI contract

The review layer renders only when the decision seam exists, a preview is open
and the current review set is non-empty.

- **Separation.** The server existing-value review is its own block (indigo) with
  its own heading and its own counts, visually and semantically distinct from the
  local within-file conflict block (slate). A within-file duplicate is a property
  of this file; a server match is a value that already exists in the
  organisation. Neither is an import outcome.
- **Counts.** `قيد مراجعة التطابق` / `أُبقي مُدرجًا` / `مستبعَد بسبب التطابق`, with
  the statement that the three are mutually exclusive and sum to the set size.
- **Per-row controls.** `إبقاء مُدرجًا`, `استبعاد بسبب التطابق`, `تراجع` — each an
  explicit `type="button"`, each acting on the **physical** row number, so a
  decision taken on page 1 is the same decision on page 9. They are a separate
  group from the plain `إدراج` / `استبعاد`, so the two questions are never
  confused.
- **Wording.** The read-only / no-import / no-access notice of M2-11 and M2-14 is
  preserved; the review block states that no student is created and no record is
  modified.
- **No automatic action.** Seeding, keeping, excluding, undoing, paging, resetting
  and closing issue no request and trigger no download.
- **Availability.** Close and reset stay available throughout, including while a
  reconciliation is in flight.

## Bounds

- the review map is keyed by physical row number and holds at most one entry per
  included row of the accepted 1000-record bound: one bounded map lookup per
  rendered row, no all-pairs scan and no all-row DOM;
- the counts are recomputed in one pass over the map, never per row;
- the report is derived from at most 1000 rows and is refused above 16 MiB of
  serialized text before any browser resource is allocated.

## Not proven here

Real browser download behaviour, DOM paint, RTL layout, an import commit (none
exists in this batch), any platform uniqueness claim, and any existing-record
identity (never requested, never returned, never stored).
