# M2-08 correction167 — F1/F2/F3 fixed, verified, stopped

2026-10-19T20:40Z · branch `codex/human-client` · task
`client-m2-08-csv-preview-correction-20261019-01` · worker `opencode-worker-067`
(native MCP claim; this run exposes no native session id of its own, so none
is claimed). Governed by human152, `docs/streams/client/M2-08-HANDOFF.md` and
`supervisor/167-m2-08-review-data-loss-private-metadata-and-close.md`, with
`supervisor/169-m2-08-omit-rejected-temp-debug-same-owner.md` for the
same-owner recovery of this run. Accepted164 and the accepted080 enrollment
work are preserved. No new task, no ownership change, no self-acceptance, no
schedule change, no backend/API/auth/router/schema work.

## Scope: the same five allowedPaths only

Changed in this run (nothing else was touched):

- `src/features/students/csv-preview.ts` — F1 (parser) and F2 (lifecycle).
- `src/features/students/StudentImportPreview.tsx` — F3 (the close control).
- `src/tests/m2-student-csv-preview.test.ts` — 12 new regressions (39 → 51).
- `docs/streams/client/M2-08-CONTRACTS.md` — the F1/F2/F3 rules and the
  actual verification evidence.

**Not** touched: `src/pages/InstructorStudents.tsx` (its accepted080 work and
the M2-08 mount are unchanged — its last write time is 23:15:11 Cairo, before
this run started), `src/lib/api-http.ts`, `src/lib/api.ts`, any auth/session
module, any router, any server/schema/migration file, any package or config
file, and every accepted dirty file outside the five paths. There is still no
`createStudent` call, no bulk endpoint, no network and no persistence.

## Before / after, finding by finding

**F1 — quoted empty data records disappeared.** The scanner skipped any
record that carried exactly one empty field, so `""` and `"   "` were
silently dropped as if they were blank physical lines. The scanner now tracks
whether the current record carries an explicitly QUOTED field, and the
blank-line skip applies only to records without quotes. A quoted empty or
whitespace-only name is now a real data record: it is kept, it keeps its
physical line number, and it is reported with the `missing-name` row issue.
Ordinary blank and whitespace-only lines are still skipped and still do not
shift the row numbers, the ragged-record check, the quote checks, the
record/column/cell bounds or the physical line accounting.

**F2 — a silent scope change restored the private file name.** On both
completion paths the controller captured `state.fileName` before adopting the
observed principal change and put it back, so the old scope's private file
name survived a `session-changed` outcome. The capture and the restore are
removed on the success and the failure path: every old-scope private
metadata (rows, issues, headers, file name) is cleared and the truthful
`session-changed` message remains. The newer-read ownership, the notification
clearing, the stale-outcome checks and the ordinary same-principal read-error
behaviour are unchanged — an ordinary read error still names the file the
instructor selected.

**F3 — no reachable close control during a pending read.** The close button
existed only inside the ready/empty preview block, and the file input is
disabled while reading, so a pending read could not be closed. The single
existing labelled control («إغلاق المعاينة») is now rendered — and stays
enabled — whenever a preview is open **or** a read is still on the wire, and
it is the only close control in the panel. Invoking it runs the real
`closePreview`: the private state is cleared at once, the pending result is
retired, a late success or error revives nothing, selecting again after the
close works, and the old `finally` cannot release the newer read's busy
latch. There is no fake abort promise and no automatic retry. The shared
`Button` primitive and the rest of the UI are untouched.

## Validation actually executed in this native session

- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-student-csv-preview.test.ts`
  → **51 pass / 0 fail**, exit 0 (39 pre-existing + 12 new).
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-student-csv-preview.test.ts
  src/tests/m2-instructor-students.test.ts src/tests/m2-tenant-branches-ui.test.ts`
  → **175 pass / 0 fail**, exit 0 (51 + 124 unchanged).
- `.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-management.test.ts
  src/tests/m2-enrollment-workflows.test.ts src/tests/m2-material-management.test.ts
  src/tests/m2-tenant-invitation.test.ts src/tests/m2-tenant-profile-edit.test.ts
  src/tests/m2-tenant-profile-ui.test.ts` → **240 pass / 0 fail**, exit 0.
- All nine M2 client suites together → **415 pass / 0 fail**, exit 0.
- `.\node_modules\.bin\tsx.cmd --test
  "C:/Users/BaraaWael/TabwebClientSupervisor/167-m2-08-independent-probes.test.ts"`
  → **5 pass / 0 fail**, exit 0 (it was **0/5** before this run). The probe
  file lives outside the repository and was **not** modified; it was only
  read and executed.
- `.\node_modules\.bin\tsc.cmd -p tsconfig.app.json --noEmit` → **zero
  diagnostics in the five scoped paths**; the output is the same **11 known
  outside errors** and the same 13 output lines as before this change
  (NotificationBell, StudentHeader_OLD_BACKUP×2, ExamReports×2, ExamResults,
  Fees×2, StudentBarcodes, StudentDashboard, versionChecker). The whole
  project is **not** clean (tsc exits 2 for those outside errors alone).

The 12 new regressions drive the **real** production parser, the **real**
production controller and the **real** `StudentImportPreview` component:
the quoted empty name in both forms; the quoted empty record at the end of
the file with and without a trailing break; a multi-column file with an
empty quoted name; quoted records mixed with blank lines, whitespace-only
lines and a quoted multiline cell (line numbers 2, 6 and 7); ordinary blank
lines still skipped and the header/data line numbering; the silent principal
change clearing the old file name on the success and the failure path; a
retired read restoring no private metadata; an ordinary read error keeping
the selected file name; the real panel exposing an enabled close control
while a read is pending that clears and retires the pending result; exactly
one close control in the panel; and a selection after a close working again
while an old `finally` cannot clear the newer busy state.

## Honest limitations

- No DOM, RTL paint, browser, real HTTP, database or live service was
  involved; no file was written to disk, no dependency was installed and no
  Git write, deploy or schedule change was made.
- One optional ad-hoc parser diagnostic outside the workspace was rejected
  by the tool guard. It was **not** repeated, relocated or worked around;
  the failing case was diagnosed and fixed inside the authorized test suite
  instead.
- No performance, latency or scalability measurement was taken. The proven
  facts are the bounds (one held result, ≤ 25 visible rows and issues per
  page, ≤ 1000 records) and the request/persistence counts (zero of each);
  no timing claim is made.
- The server's own validation, the existence check against existing student
  records, the audited idempotent bulk commit, XLSX, the account/password
  and OTP journey, the branch assignment and the enrollment policy are
  **separate recorded gaps** and were not filled by guessing product policy.
- A within-file duplicate remains a **candidate**, not a statement about the
  platform.

## Next owner action

Codex independent review of the stable source, the 51 tests, the contract
file and the public probe result, then acceptance or an exact scoped
correction. The worker timer `Tabweb-OpenCode-Worker-15min` remains
**DISABLED** (verified: State `Disabled`); its `NextRunTime` field is stale
and is not a guaranteed run. The live cadence is the Codex supervisor task
`Tabweb-Codex-Supervisor-10min` (State `Ready`, Enabled `True`, last run
23:34:59 Cairo, result 0, next 23:44:58 Cairo). No schedule was changed.
