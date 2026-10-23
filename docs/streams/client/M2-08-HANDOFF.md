# M2-08: local CSV student preview, no import writes

Human152 delegated bounded remaining M2 work; backlog17/C12 explicitly requires
parser, preview, duplicate resolution and rejected-row report. Existing Student
DTO and students POST accept name/email/phone/guardian_phone/grade/barcode.
This slice prepares local input only; it does not settle server bulk/idempotency,
student identity, account/password/OTP, branch assignment or enrollment policy.
Task `client-m2-08-student-csv-preview-20261019-01`, frontend, write.

Before: InstructorStudents has accepted080 enrollment controls, no student CSV
preview. After: explicit Arabic/RTL local preview panel, isolated from all existing
reads/actions, shows structurally parsed rows, row-level issues and within-file
duplicate candidates. Clearly label preview-only: nothing saved, server validity/
existing-record duplicates not checked, XLSX/import commit not available yet.
No createStudent/bulk API calls or production mocks. Never present preview as
successful import, verified phone, approved enrollment or whole C12 completion.

## Exact five allowedPaths

- `src/pages/InstructorStudents.tsx`: import/mount dedicated preview component only;
  preserve080 enrollment implementation and other dirty work.
- `src/features/students/StudentImportPreview.tsx`: dedicated accessible UI.
- `src/features/students/csv-preview.ts`: injected parser/preview lifecycle seam.
- `src/tests/m2-student-csv-preview.test.ts`: hermetic real production-path tests.
- `docs/streams/client/M2-08-CONTRACTS.md`: actual format, checks and honest limits.

No shared/API/auth/router/backend/schema/migration/package/config/provider changes.
No network/storage/clipboard/export/provider/DB/browser/install/Git/deploy. Unique
worker coordination report is allowed separately; no other product source paths.

## Concrete behavior and engineering limits

CSV only, UTF-8 text, optional BOM; comma separator, CRLF/LF, quoted commas/newlines
and doubled quotes. Fail closed with truthful diagnostics on malformed quoting,
duplicate/unknown headers, missing required name header, ragged records or unsupported
format. Exact English headers: required `name`; optional `email`, `phone`,
`guardian_phone`, `grade`, `barcode`. Header whitespace may trim; no guessed mappings.
Reject password, role, tenant/group/course/branch IDs, approval/status or other
columns. Never coerce numbers: preserve leading zeros and + in phone/barcode.
Trim surrounding field whitespace for preview; missing/blank name is a row issue.
Other field values are unverified text, not server-valid email/phone/identity claims.
Do not invent stricter identity normalization or auto-link accounts.

Resource limits are explicit implementation bounds, not business entitlements:
1 MiB UTF-8 input,1000 data records,6 columns,4096 characters per cell. Check File.size
before reading and actual encoded text bound at parser entry; enforce row/cell
limits while parsing, no unbounded split/regex backtracking/all-pairs duplicates.
Abort over-limit input with no misleading successful partial preview. Keep at most
one bounded result; render25 rows/issues per page, no all-row DOM expansion.

Flag nonempty EXACT trimmed phone/email/barcode collisions within the file as
duplicate CANDIDATES with row references; no merging/deletion/auto-resolution or
claim of global uniqueness. Exclude blank values from matching. Display original
row numbers including quoted multiline handling consistently/documented. Treat
all strings as text (React escaping), no raw HTML/eval/formula execution. Errors
must not log private contents; fixtures synthetic only. Structural errors and
duplicate warnings clearly distinguished; malformed file never says ready.

Explicit file selection/open, labels and feedback; file picker accepts CSV but
validate chosen format rather than trusting accept alone. Closing/unmount/session
change clears preview/private rows and retires pending File.text results. Replacing
a file invalidates earlier success/error/finally; stale principal changes observed
before settlement, no old reply revives data or clears a newer busy latch. Reuse
canonical principal/session notifier read-only; no parallel auth state or editing
accepted controllers. Use injected async read seam for meaningful lifecycle tests.
No persistence (localStorage/sessionStorage/IndexedDB) of CSV contents.

## Validation and done

Read existing080 page/controller, Student DTO/current POST semantics and accepted
session lifetime helpers before edits. Preserve all accepted work. Real parser
tests: BOM/Arabic/quoted commas/newlines/quotes/CRLF/blank lines, malformed quote,
headers/ragged/empty-name, phone zeros, exact duplicate candidates, bounds at and
beyond limits. Real controller tests: reversed file success/error, close/dispose,
session event and silent principal change, newer busy latch; verify zero transport
calls/persistence and bounded visible pages. Actual component rendering checks for
labels/preview-only warnings/buttons if feasible without browser or copied logic.
Use production modules directly, no text-only substitute or source copies.

Run new suite plus unchanged `src/tests/m2-instructor-students.test.ts` and
`src/tests/m2-tenant-branches-ui.test.ts`, frontend tsc (known11 outside errors
separated). Positively isolate all tests; no legacy unsafe server suites/default
DB/provider/dotenv. No optional lint/TEMP baseline/source-disable probes. Report
exact commands/results/limits, no unmeasured performance. Native MCP checkpoints
at real milestones, stop ALL edits/checks before report and worker Markdown.
Codex independently reviews stable source/tests/architecture and accepts or sends
precise bounded corrections. OpenCode old timer stays disabled; no timer changes.

Completion is usable local preview and rejected-row visibility only. Backend
idempotent/audited commit, existing-record deduplication, XLSX and enrollment/OTP
remain separate recorded gaps; do not fill them by guessing product policy.
