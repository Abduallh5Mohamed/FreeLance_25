# M2-14 — client contracts for read-only server reconciliation

Task: `client-m2-14-student-import-server-reconciliation-20261021-01`.
Handoff: `docs/streams/client/M2-14-HANDOFF.md`.
Server contract: `docs/streams/server/M2-B08-CONTRACT.md`.

Accepted M2-08 (local CSV preview) and M2-11 (local duplicate decisions + JSON
report) are **unchanged**. This batch adds one optional, explicitly-clicked,
read-only step.

## Modules

| Path | Role |
|---|---|
| `src/features/students/server-resolution.ts` | DTOs, request builder, strict response parser, controller/lifecycle |
| `src/lib/api-http.ts` | **additive** DTOs + `resolveStudentImportRows` adapter only |
| `src/features/students/StudentImportPreview.tsx` | **additive** reconciliation block, per-row warnings, clear wiring |

## Request building

`buildServerResolutionRequest(rows)` takes the **current decision model** and:

- keeps **only** rows whose status is `included`;
- drops `pending` (undecided), `excluded` and `invalid` rows entirely;
- sends exactly `{ row_number, email, phone, barcode }` — never `name`,
  `guardian_phone`, `grade`, `rowIndex` or any issue/duplicate metadata;
- preserves the **physical** row number (the line the record starts on), not the
  display index, so a quoted multi-line cell cannot re-target a decision;
- copies the three values **unchanged** (no trim, no casefold, no normalization);
- refuses locally with `no-included-rows` or `too-many-rows` rather than sending a
  request the server would reject.

## Response parsing

`parseServerResolutionResponse(raw, expectedRowNumbers)` accepts an answer only when:

- the envelope has exactly `rows` and `summary`;
- there is exactly one entry per submitted row, **in the submitted order**, and
  each `row_number` equals the expected one at that index;
- each entry has exactly `row_number` and `matched_fields`;
- `matched_fields` is a subsequence of `email, phone, barcode` with no duplicate
  and no reordering;
- `summary` has exactly `checked`, `matched`, `clear`, all non-negative integers,
  with `checked === rows.length`, `matched ===` the count of non-empty rows and
  `clear === checked - matched`.

Anything else is `malformed`. A malformed 2xx is **never** partially trusted and
**never** repaired.

## Controller lifecycle

`createServerResolutionController({ resolve, readPrincipal, subscribeSession })`

| Rule | Behaviour |
|---|---|
| Explicit only | A file selection, a decision, a reset or a page change **never** triggers a request; only `resolve()` / `retry()` do |
| Single flight | At most one request in flight; a second click returns `busy` and starts nothing |
| Ticket fence | Every attempt takes a monotonic ticket; only the **current** ticket may publish |
| Own latch | A reply releases the busy latch only if it still owns it, so a retired reply cannot release a **newer** latch |
| Reversed order | A retired success/error settling before or after a newer one changes nothing |
| Principal | Observed before the request and after it settles; a change returns `scope-changed` and drops the answer |
| Session | A session event clears the results and retires the pending reply |
| Clear | `clear()` drops results, retires the reply, forgets the retry set |
| Dispose | Drops everything, unsubscribes, publishes nothing afterwards |
| Retry | Explicit, and re-sends **the same** rows; with no remembered set it refuses |
| Failure | `failed` carries **no** result — never presented as "these rows do not exist" |
| No trace | No storage write and no console call anywhere in the module |

Outcome reasons: `no-included-rows`, `too-many-rows`, `busy`, `scope-changed`,
`superseded`, `failed`, `malformed`, `unavailable`.

## UI contract

The reconciliation block renders **only** when the seam exists and a preview is
open, and states on screen:

- it is **read-only**, creates no student, modifies no record and grants no access;
- a match means "this value already exists in your institution" and is **not** an
  identity proof, an import success or an approval to overwrite;
- only the included rows' email/phone/barcode are sent, with no name, guardian
  phone or grade.

Controls: the reconcile control is a `type="button"`, disabled when nothing is
included or while a request is in flight; a failure offers an explicit
`إعادة المحاولة` retry; the close control stays **enabled** while a request is in
flight. Counts render as `تم الفحص` / `موجود مسبقًا` / `غير موجود`, and per-row
warnings name the matched fields only.

Every change that invalidates the answer clears it: a decision, a reset, a file
change, a close, a refused file, a principal/session change and disposal.

## Not in this contract

No import commit, no account/user creation, no password or OTP, no enrollment, no
group/branch/course assignment, no XLSX, no migration, no notification, no billing
or financial rule, and no change to the shared `request`/auth/error/session
contract.
