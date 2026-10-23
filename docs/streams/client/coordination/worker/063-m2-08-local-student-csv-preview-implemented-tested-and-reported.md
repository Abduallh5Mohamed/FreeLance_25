# M2-08 local student CSV preview — implemented, verified, stopped

2026-10-19T20:25Z · branch `codex/human-client` · task
`client-m2-08-student-csv-preview-20261019-01` · worker `opencode-worker-065`
(native MCP claim; no native session id is exposed to this run, so none is
claimed). Governed by human152 and `docs/streams/client/M2-08-HANDOFF.md`,
with `supervisor/164-m2-07-branch-ui-independent-acceptance.md` as the
accepted baseline to preserve. No new task, no ownership change, no
self-acceptance, no schedule change, no backend/API/auth/router/schema work.

## Scope: the five approved paths only

Changed in this run (nothing else was touched):

- `src/features/students/csv-preview.ts` (new) — the bounded strict parser
  and the injected preview lifecycle.
- `src/features/students/StudentImportPreview.tsx` (new) — the dedicated
  accessible RTL panel.
- `src/pages/InstructorStudents.tsx` — the import and the mount only
  (594 → 601 lines: one import line plus a five-line JSX block with its
  comment). The accepted 080 enrollment implementation and every other dirty
  file are preserved.
- `src/tests/m2-student-csv-preview.test.ts` (new) — 39 hermetic
  production-path tests.
- `docs/streams/client/M2-08-CONTRACTS.md` (new) — the actual format, the
  checks and the honest limits.

Not touched: `src/lib/api-http.ts`, `src/lib/api.ts`, any auth/session
module, any router, any server/schema/migration file, any package or config
file, and every accepted dirty file outside the five paths. There is **no**
`createStudent` call, no bulk endpoint, no network and no persistence in this
slice.

## What was built

**A local, read-only preview of the instructor's own CSV file.** The panel
parses the file in the browser, shows the structurally parsed rows, the
row-level problems and the exact within-file duplicate candidates, and states
on screen that nothing is saved, that no server validity or existing-record
duplicate was checked, and that XLSX and the import commit do not exist yet.

- `parseStudentCsv(text)` is a pure, bounded parser. It fails **closed**: a
  malformed quoting, an unknown or duplicate header, a missing `name` header,
  a ragged record, an unsupported format or any exceeded limit refuses the
  **whole file** with a truthful diagnostic and no partial preview. The only
  row-level issue is a missing name.
- Values are never coerced: `007` stays `007`, `+201001` stays `+201001`,
  `1e5` stays `1e5`. The comparison for duplicate candidates is exact and
  case sensitive after trimming; a blank value never matches.
- The row number is the physical line the record starts on, so a record whose
  quoted cell spans several lines always points at a real line of the file.
- The bounds (1 MiB, 1000 records, 6 columns, 4096 characters per cell) are
  enforced while scanning: the declared `File.size` is checked **before** the
  file is read, the encoded UTF-8 length is checked at the parser entry, and
  the record/column/cell limits abort the scan instead of building an
  unbounded structure. There is no regex backtracking and no all-pairs
  duplicate comparison (the grouping is a `Map`, linear in the row count).
- The lifecycle is an injected controller: `readFile` (async read seam),
  `readPrincipal` (the canonical, read-only principal reader) and
  `subscribeSession` (the canonical, read-only session notifier). A newer
  selection supersedes an older one; a retired reply never revives data and
  never releases a newer read's busy latch; a close, a dispose and a session
  event clear the private rows and retire the pending read; a silent
  principal change is observed **before** any visible state is settled, on
  the success and the failure path alike.
- At most 25 rows and 25 issues are visible per page, so the DOM never grows
  with the file.

## Before / after

Before: the instructor students page had the accepted 080 enrollment
controls and no student CSV preview at all; there was no local parser, no
structural diagnostics for a local file, and no rejected-row or duplicate
visibility of any kind.

After: a dedicated panel on the same page reads a chosen local CSV, refuses a
structurally wrong file with a named reason, and otherwise shows the parsed
rows, the rows with a missing name and the exact within-file duplicate
candidates with their row references — all of it explicitly labelled as a
local preview that saves nothing and validates nothing against the server.

## Validation actually executed in this native session

- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-student-csv-preview.test.ts`
  → **39 pass / 0 fail**, exit 0.
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-student-csv-preview.test.ts
  src/tests/m2-instructor-students.test.ts src/tests/m2-tenant-branches-ui.test.ts`
  → **163 pass / 0 fail**, exit 0 (39 new + 124 unchanged).
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts
  src/tests/m2-enrollment-workflows.test.ts src/tests/m2-material-management.test.ts
  src/tests/m2-tenant-invitation.test.ts src/tests/m2-tenant-profile-edit.test.ts
  src/tests/m2-tenant-profile-ui.test.ts` → **240 pass / 0 fail**, exit 0 (the
  other, unmodified M2 client suites).
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **zero
  diagnostics in the five scoped paths**; the output is the same 11 known
  outside errors and the same 13 output lines as before this change
  (NotificationBell, StudentHeader_OLD_BACKUP×2, ExamReports×2, ExamResults,
  Fees×2, StudentBarcodes, StudentDashboard, versionChecker). The whole
  project is **not** clean.

The 39 new tests drive the **real** production parser, the **real**
production controller and the **real** `StudentImportPreview` component
rendered by the React server renderer: BOM/Arabic/quoted commas/quoted
newlines/doubled quotes/CRLF/LF/blank lines; three shapes of malformed
quoting; an unknown column (named in the diagnostic), a duplicate column, a
missing `name` column, case-sensitive headers, a ragged record (with its
line); a missing name as a row issue; no numeric coercion; exact within-file
duplicate candidates with row references, blanks excluded and case
sensitive; 1000 records accepted and 1001 refused; 6 columns accepted and 7
refused; a 4096-character cell accepted and 4097 refused; a file over 1 MiB
refused at the parser entry; an empty file, a binary container and an
undecodable file refused; the size checked **before** the read (the read seam
is never called); a newer selection superseding an older success and an older
failure; an older reply not clearing a newer read's busy latch; a close, a
dispose and a session event dropping the pending read; a silent principal
change on the success and the failure path; a failed read reported
truthfully; a refused file never showing a partial preview; 25 rows and 25
issues per page; zero network calls and zero persistence against failing
`fetch`/`localStorage`/`sessionStorage`/`indexedDB` guards; and the rendered
panel (the preview-only warning, the labelled file input, the diagnostic, the
table, the duplicate note, the paging, and a value rendered as escaped text).

## Honest limitations

- No DOM, RTL paint, browser, real HTTP, database or live service was
  involved; no file was written to disk and no dependency was installed.
- No performance, latency or scalability measurement was taken. The proven
  facts are the bounds (one held result, ≤ 25 visible rows and issues per
  page, ≤ 1000 records) and the request/persistence counts (zero of each);
  no timing claim is made.
- The server's own validation, the existence check against existing student
  records, the audited idempotent bulk commit, XLSX, the account/password
  and OTP journey, the branch assignment and the enrollment policy are
  **separate recorded gaps** and were not filled by guessing product policy.
- A within-file duplicate is a **candidate**, not a statement that a record
  exists or does not exist in the platform.
- The header vocabulary is exact and case sensitive by design: `Name` is an
  unknown column, not a guessed mapping. This is documented in
  `M2-08-CONTRACTS.md` so the reviewer can check the decision against the
  handoff rather than infer it.
- The `ok === false` comparison style in the union narrowing follows the
  pattern already used by the accepted `material-management.ts`; the negated
  `!parsed.ok` form does not narrow under this `tsconfig` and was corrected
  before the final type run.

## Next owner action

Codex independent review of the stable source, the tests and the contract
file, then acceptance or an exact scoped correction. The worker timer
`Tabweb-OpenCode-Worker-15min` remains **DISABLED** per human152 (verified:
State `Disabled`, Enabled `False`); its stale `NextRunTime` field is not a
guaranteed run. The live cadence is the Codex supervisor task
`Tabweb-Codex-Supervisor-10min` (State `Ready`, Enabled `True`, last run
23:14:59 Cairo, result 0, next 23:24:58 Cairo).
