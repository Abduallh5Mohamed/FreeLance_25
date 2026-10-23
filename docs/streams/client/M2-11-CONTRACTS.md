# M2-11 — local CSV duplicate decisions and JSON rejected-row report

Task `client-m2-11-csv-resolution-report-20261021-01` (WorkBuddy NEW native lane,
human180/152 delegation) plus the accepted correction
`client-m2-11-privacy-resource-index-correction-20261021-01` (OpenCode, human180
+ supervisor194/195). Consumes the ACCEPTED 170 preview (`csv-preview.ts`,
`M2-08-CONTRACTS.md`) unchanged in its parser contract and adds the missing
local step: explicit include/exclude/pending decisions over the WHOLE bounded
file, plus a user-triggered JSON report of the rows that are not included.

This document describes what the batch actually does and what it does not prove.
It is not an acceptance record: independent review is still required.

## Changed paths (the exact six)

| Path | Change |
| --- | --- |
| `src/features/students/StudentImportPreview.tsx` | Additive decision layer: per-row status + include/exclude, counts, reset, report download. Every accepted 170 control, label, paging and cleanup behaviour preserved. Correction194: the report callback takes a FRESH guarded canonical-principal snapshot before any materialization, and a replaced file / reset / close / lost session retires the outstanding report URL at once. |
| `src/features/students/import-resolution.ts` | NEW bounded decision/conflict model + lifecycle seam. Correction194: one included-row index per calculation with bounded exact-key lookups, and a `revalidateScope()` seam that adopts a silent principal change. |
| `src/features/students/import-report.ts` | NEW JSON report materialization + resource lifecycle seam. Correction194: cleanup in a structured `finally` (link removed exactly once, URL revoked at most once) and a `retire()` that releases the outstanding URL without disposing the seam. |
| `src/tests/m2-student-import-resolution.test.ts` | NEW isolated production-path suite (50 tests: 43 original + 7 correction regressions). |
| `docs/streams/client/M2-11-CONTRACTS.md` | This file. |
| `src/features/students/csv-preview.ts` | **NOT modified.** The accepted parser/controller already expose everything the decision model needs (stable physical `rowNumber`, `issues`, `duplicates`), so the handoff's "additive integration only if necessary" was not triggered. The correction194 lifecycle integration was NOT necessary either: the accepted controller already clears its private rows on a close, a refusal and a session change, and the decision seam exposes the same canonical principal observation. |

No `InstructorStudents.tsx`, import API, lesson path, backend, schema, auth,
shared helper, package, config, provider or player change. Nothing was written
to storage, clipboard or the network.

## Decisions

Four mutually exclusive statuses. `included + excluded + pending + invalid`
always equals `total`.

| Status | How a row gets it | Includable |
| --- | --- | --- |
| `invalid` | the accepted parser reported at least one row issue (a missing required `name`) | never |
| `pending` | issue-free, but it carries a within-file duplicate candidate | only explicitly |
| `included` | issue-free and it carries no candidate — it collides with nothing in this file | yes (default) |
| `excluded` | the user excluded an issue-free row | yes, re-includable |

A duplicate candidate NEVER resolves itself: there is no first-wins, no merge,
no deletion and no automatic resolution.

The initial set is conflict-free by construction: a row with no candidate shares
no exact nonempty key with any other row, so the default inclusions cannot
collide.

## Conflict semantics

- Keys: `phone`, `email`, `barcode` — the accepted duplicate columns.
- Comparison: EXACT after the parser's surrounding-whitespace trim. Case,
  leading zeros and `+` are preserved (`007` ≠ `7`, `A@B.c` ≠ `a@b.c`).
- A blank value never matches another blank value.
- Only rows that are CURRENTLY `included` can block an inclusion, and a row
  never conflicts with itself.
- The scan is WHOLE-FILE and INDEXED. One calculation builds ONE index of the
  included rows, keyed by the exact nonempty field/value, and every row is then
  a bounded key lookup. A duplicate group's member list is never traversed, so
  a group of 1000 pending rows no longer costs one group walk per row.
- The scan is never limited to adjacent rows or to the visible page, so an
  overlapping chain (line 2 ↔ line 3 on phone, line 3 ↔ line 4 on email)
  resolves correctly and only by an explicit exclusion.
- A conflicting inclusion is REFUSED: the refusal names the field, the exact
  value and the ACTUAL included row numbers, and the previous decisions are
  preserved untouched.
- An excluded row may be re-included only when no included row collides with it.

There is NO new business uniqueness policy here. A decision is local
preparation: the fields remain unverified, and the server may later reject the
same values.

## Bounds and identity

- At most one bounded decision set is held, for the current file instance.
- Rows are bounded by the accepted parser (1000 records); the model fails
  CLOSED (empty, unloaded) on an over-bound array or a repeated physical row
  identity, because a repeated identity would let two records share one decision.
- A decision is keyed by the stable PHYSICAL row number, never by the display
  index, so paging cannot re-target it.
- 25 rows per page in the UI; the decision layer is whole-file regardless.

## Report

JSON only. There is no CSV/XLSX writer in this batch, and no cell is ever handed
to a spreadsheet engine.

Documented structure (fixed key order, rows ascending by physical line):

```json
{
  "report": "student-import-rejected-rows",
  "version": 1,
  "scope": "local-preview",
  "counts": { "total": 4, "included": 1, "excluded": 0, "pending": 2, "invalid": 1 },
  "rows": [
    {
      "rowNumber": 2,
      "status": "pending",
      "name": "...", "email": "...", "phone": "...",
      "guardian_phone": "...", "grade": "...", "barcode": "...",
      "reasons": ["duplicate-candidate-pending"],
      "candidates": [{ "field": "phone", "value": "...", "rowNumbers": [2, 3] }]
    }
  ]
}
```

- EXACTLY the non-included rows (`invalid`, `excluded`, `pending`). An included
  row's values are never exported.
- Field text is the permitted text from the parsed file, copied verbatim: no
  conversion, no re-validation, no normalization.
- Documented reasons: `missing-name` (invalid), `duplicate-candidate-pending`
  (pending), `excluded-by-user` and optionally `duplicate-candidate` (excluded).
- Values are serialized by `JSON.stringify`, so a formula-looking value such as
  `=cmd|'/C calc'!A0` and a markup-looking value stay inert string data. Nothing
  is evaluated and no HTML is ever produced.
- The filename is the constant `student-import-rejected-rows.json`: it carries
  no original file name, no identity and no student value.
- Allocated only on an EXPLICIT click, from the CURRENT live decision set —
  never from a cached document, and never after a principal/file change.

### Size gate

The output cap is **16 MiB** of UTF-8, measured on the SERIALIZED text with a
non-allocating byte counter and enforced BEFORE any `Blob` or object URL exists.
It is derived from the accepted 1 MiB input bound: JSON escaping can multiply a
value (a control character becomes six characters), so 16 MiB leaves room for a
bounded 1000-record file while still refusing an absurd document. An over-cap
report returns `too-large`, creates no Blob, no URL and no link, and says so.

### Resource lifecycle

One click produces at most ONE `Blob`, ONE object URL and ONE link.

- the cleanup runs in a STRUCTURED `finally`, so the created link is removed
  EXACTLY ONCE whether the creation, the configuration, the click or the
  scheduling failed;
- the URL is revoked AT MOST ONCE, and only while it is still the live one;
- the URL is revoked on the next scheduled tick (so the browser can start the
  download), on every failure, on replacement by a newer click, and on disposal;
- `retire()` releases the outstanding URL IMMEDIATELY and does NOT dispose the
  seam: a later valid click may still produce a new report. The panel calls it
  on a replaced file, a reset, a close, a lost principal and a lost session;
- `dispose()` revokes whatever is still live and refuses further reports.

An all-included file disables the report control and, if invoked anyway, returns
`empty` — never a fabricated success and never an empty-but-successful document.

### The guarded export

The report is built from a FRESH guarded snapshot of the canonical principal,
taken BEFORE any report materialization. If the principal changed since the
decisions were loaded — a silent logout that produced no session event — the
action is REFUSED: the preview, the decisions, the report metadata and the
pending selection are all dropped, and NOTHING is allocated. No Blob, no object
URL and no link exist for a former scope's rows, and no stale report or message
is shown afterwards. The canonical reader is the shared one (`csv-preview.ts`
re-exports `readInstructorSessionPrincipal`); no second session state exists.

## Component

`StudentImportPreview` gains, additively, a decision panel above the table:

- four mutually exclusive count badges plus the total;
- `إعادة ضبط القرارات` (reset) and the report control whose LABEL carries the
  privacy notice that the report contains local file data;
- a `الحالة` column with the status badge and the blocking row numbers;
- a `القرار` column with `إدراج` / `استبعاد`, or `غير قابل للإدراج` for an invalid
  row;
- an `aria-live` region for the refusal and the report outcome.

Every new control is `type="button"`. The decision layer renders ONLY when the
model seam is actually mounted, so a panel without a live model shows the
accepted 170 preview unchanged rather than offering a control that cannot record
anything.

Lifecycle: a new file, a replacement, a close, a session/principal change, a
parse/read error and a disposal all drop the decisions and the report metadata,
and the outstanding report URL is retired at once on a replacement, a reset, a
close, a lost principal and a lost session. A monotonic selection token makes a
stale read unable to seed a newer file's decision set, and a scope mismatch
never leaves a stale decision set that a later read could revive.

## Checks run

| Check | Result |
| --- | --- |
| `node_modules/.bin/tsx --test src/tests/m2-student-import-resolution.test.ts` | 50 tests, 50 pass, 0 fail (43 original M2-11 + 7 correction194 regressions) |
| `node_modules/.bin/tsx --test src/tests/m2-student-import-resolution.test.ts src/tests/m2-student-csv-preview.test.ts src/tests/m2-instructor-students.test.ts` | 173 tests, 173 pass, 0 fail = 50 NEW + 123 UNCHANGED (the 123 are the accepted 170 CSV preview suite and the accepted 080 enrollment suite, both unmodified) |
| `node_modules/.bin/tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/194-m2-11-independent-probes.test.ts` | the public 194 probe, unmodified: 3 tests, 3 pass, 0 fail (it was 0/3 before this correction) |
| `node_modules/.bin/tsc --noEmit -p tsconfig.app.json` | exactly the known 11 pre-existing diagnostics outside these paths; ZERO scoped |

The arithmetic is explicit on purpose: the earlier report labelled the UNCHANGED
baseline as "166". The correct split is 43 original new + 123 unchanged = 166
before this correction, and 50 new + 123 unchanged = 173 after it.

The suite drives the REAL parser, the REAL model, the REAL report seam and the
REAL component callbacks. The browser boundary is injected: a synthetic
`Blob`/object-URL/anchor recorder, so no real download, browser, network or
storage is involved. The correction regressions additionally drive the REAL
mount effect of the REAL component against the REAL session notifier, with a
synthetic `document`/`URL` boundary.

## Limits (not proven here)

- No real browser download, no DOM paint, no RTL layout, no real HTTP, no DB.
- No import exists in this batch: no commit, no account creation, no OTP, no
  enrollment, no financial effect, and no idempotency or audit claim.
- No platform uniqueness claim: the model knows nothing about existing records.
- No CSV/XLSX export and no clipboard/storage/network write.
- NO LATENCY MEASUREMENT. The conflict lookup is bounded by an OPERATION
  COUNT: with 1000 pending rows sharing one candidate group the lookup reads
  ZERO group members (it was one group walk per row before), and the suite
  asserts that bound. That is a measured operation count, not a browser or
  latency benchmark, and no throughput claim is made.
- The 16 MiB cap is a documented engineering bound, not a measured browser
  limit.
- The component's own mount effect is exercised through a small `useState`/
  `useRef` store, not through a browser DOM: the session-notifier wiring is
  proven, the paint is not.

## Done means

Complete LOCAL duplicate review plus the JSON rejected-row report only. Not
XLSX, not a server import, not idempotency, not an audit trail, not whole C12
and not M2.
