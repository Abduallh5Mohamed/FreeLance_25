# M2-11: local CSV duplicate review and rejected-row report

Human180/152 bounded larger NEW C12 batch, WorkBuddy native IDE. Existing170 local
CSV preview parses/flags rows but cannot resolve within-file candidate collisions
or download a rejected/excluded-row report. After: explicit local row inclusion/
exclusion decisions, deterministic conflict visibility across the whole bounded
file and a user-triggered local JSON rejected/excluded-row report. No persistence,
server duplicate claims, import commit/accounts/OTP/enrollment/financial effects.
Task client-m2-11-csv-resolution-report-20261021-01. Six exact paths:

- src/features/students/StudentImportPreview.tsx: extend existing accessible RTL
  preview,25-row paging, explicit decisions/counts/reset/report download. Preserve
  existing170 principal/file/pending-read cleanup, bounds/labels and enrollment
  independence; no InstructorStudents.tsx edits.
- src/features/students/csv-preview.ts: additive lifecycle integration only if
  necessary. Preserve parser/physical row numbers/validation/duplicate definition
  and all accepted170 behavior. No new fields/mapping/identity normalization.
- src/features/students/import-resolution.ts: new bounded pure decision/conflict
  model and state lifecycle seam, accepts existing parsed result, synthetic tests.
- src/features/students/import-report.ts: new explicit JSON report materialization/
  resource-lifecycle seam, no import API/CSV formula execution/browser service.
- src/tests/m2-student-import-resolution.test.ts: real production model/component
  callbacks/report stubs/lifecycle/bounds; do not copy parser/render decisions.
- docs/streams/client/M2-11-CONTRACTS.md: actual decisions/report/checks/limits.

OpenCode concurrently owns six M2-10 lesson paths; NEVER edit them/api-http/backend/
schema/auth/shared helpers/package/config/providers/player. Unique worker report
allowed separately. Preserve all accepted dirty work; migration FILE unchanged.

## Existing contract and deterministic local decisions

Read M2-08-HANDOFF/CONTRACTS and accepted170/167, actual csv-preview.ts. Keep UTF8
CSV1MiB/1000records/6columns/4096chars per cell, exact English input columns name,
email,phone,guardian_phone,grade,barcode, required name. Keep existing exact TRIMMED
nonempty email/phone/barcode candidate equality (case/leading zeros/+ preserved);
no identity merging/casefold/phone validity/account linking or server lookup.

Structural parse failure yields no usable report/candidate set. Row issues keep
row non-includable with reasons. Duplicate candidates require EXPLICIT user choice;
initially include only issue-free NONduplicate rows, leave all duplicate candidates
pending (not silently first-wins). User may include/exclude an issue-free candidate;
included rows must not collide on ANY of the three exact nonempty keys. Conflicting
include is refused with actual row references, previous decisions preserved. Resolve
overlapping candidate chains correctly, not just adjacent rows or visible page.
Allow excluded duplicates to be re-included only when all conflicts removed; no
automatic merging/deletion/resolution. No new business uniqueness policy: this is
local preparation only, fields remain unverified and server may later reject them.
Show pending/included/excluded/invalid counts with truthful mutually exclusive
definitions; no claim of successful import or existing-record uniqueness.

Store at most one bounded decision map/result for current file instance. Display
25rows/page; decisions across pages still obey whole-file conflict detection.
Use indexed exact-key lookups (bounded maps/sets), no unbounded all-pairs or all-row
DOM. Key decisions by stable source row identity, not display index. New file,
replacement, reset, close, session/principal change, parse/read error or disposal
clears all decisions/report metadata; stale async outcomes cannot restore them.
No localStorage/sessionStorage/IndexedDB/clipboard/network or background request.

## Explicit local rejected/excluded report

JSON only (not CSV/XLSX/spreadsheet): never evaluate formulas or insert raw HTML.
Versioned documented structure includes original source row number, exact permitted
field text, status invalid/excluded/pending and reasons/candidate row references.
Only non-included records; no included private rows accidentally exported. Do not
invent validation or convert fields; JSON escaping, deterministic field/row order.
Report/counts are local preview decisions, not server import results or audit.
Generic download filename without original filename/identity/student data. No
automatic download; explicit button labels contain privacy notice that report
contains local file data. No additional permission dialog or export approval loop.

Build payload only on explicit click from CURRENT valid snapshot; no stale cached
report after principal/file change. Enforce bounded output size before Blob/object
URL, show truthful failure, never successful partial report. Document resource cap
chosen from input1MiB bound (e.g.16MiB including JSON escaping/issue references).
Exactly one temporary object URL/link per click; remove link and revoke URL on
success/failure/dispose/replacement, no URL/state leak. Test with injected synthetic
Blob/URL/anchor boundaries; no real browser/download/network. If all rows included,
show no rejected/excluded/pending rows and disable report or produce honest empty
report consistently/documented, never a fabricated import success.

## Required tests and done

Drive actual production parser/model/report/component callbacks with synthetic
data: conflict chains across fields/pages, exact trim equality/blank exclusions,
leading zeros/case preserved, invalid rows cannot include, explicit pending choices,
conflict refusal/undo/reset/replacement/principal/pending-read races, report exact
non-included set/row numbers/reasons, JSON escaping/formula-looking text inert,
size limit before Blob, all allocation/click/failure/revoke paths and cleanup.
No implementation-mirroring expected decisions or source-regex-only assertions.
Run new suite+unchanged accepted170 CSV suite+unchanged080 InstructorStudents safe
enrollment suite (resolve actual names) and frontend tsc; no scoped diagnostics,
honestly disclose known11 outside. No default server/dotenv/DB/providers/npx fetch,
TEMP reconstruction/lint/debug/network/browser/services/install/Git/deploy.

Before native MCP report stop ALL edits/checks, concise unique worker Markdown
actual commands/outcomes/limits/changed paths/before-after. No self-acceptance,
worker timer/own tasks/claim on behalf of others. Codex independently reviews
source/architecture/contract/test/request/data/cleanup bounds. Done is complete
local duplicate review+JSON rejected report, NOT XLSX/server import/idempotency/
audit/whole C12/M2. No scope approval re-request under existing180 delegation.
