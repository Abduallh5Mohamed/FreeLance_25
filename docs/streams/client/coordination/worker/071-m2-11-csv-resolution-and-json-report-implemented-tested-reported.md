# M2-11 local CSV duplicate decisions + JSON rejected-row report — reported

Task `client-m2-11-csv-resolution-report-20261021-01` · worker
`workbuddy-native-m2-11-csv-resolution-20261021` · branch `codex/human-client`.
Status **reported** (not accepted). Independent Codex review required.

## Changed paths — six allowed, five written, one deliberately untouched

1. `src/features/students/import-resolution.ts` — NEW decision/conflict model +
   lifecycle seam.
2. `src/features/students/import-report.ts` — NEW JSON report + resource
   lifecycle.
3. `src/features/students/StudentImportPreview.tsx` — additive decision layer.
4. `src/tests/m2-student-import-resolution.test.ts` — NEW 43-test suite.
5. `docs/streams/client/M2-11-CONTRACTS.md` — NEW.
6. `src/features/students/csv-preview.ts` — **NOT modified**. The accepted
   parser/controller already expose the stable physical `rowNumber`, `issues`
   and `duplicates` the model needs, so "additive integration only if
   necessary" was not triggered. Verified unchanged on disk.

No `InstructorStudents.tsx`, import API, lesson path, backend, schema, auth,
shared helper, package, config, provider or player change. No storage,
clipboard or network write.

## Commands and outcomes

| Command | Outcome |
| --- | --- |
| `npx tsx --test src/tests/m2-student-import-resolution.test.ts` | 43 tests, **43 pass**, 0 fail |
| `npx tsx --test` with the unchanged accepted `m2-student-csv-preview` + `m2-instructor-students` | 166 tests, **166 pass**, 0 fail |
| `npx tsc --noEmit -p tsconfig.app.json` | the known **11** diagnostics, all outside these paths; **zero** scoped |

## Decisions and conflicts

Four mutually exclusive statuses that always sum to `total`: `invalid` (a row
issue — never includable), `pending` (issue-free with a within-file candidate),
`included` (issue-free, candidate-free), `excluded` (user decision).

A duplicate never resolves itself. Conflicts use the accepted EXACT trimmed
nonempty `phone`/`email`/`barcode` keys, are whole-file and indexed, and a
refusal names the field, the exact value and the ACTUAL included row numbers
while preserving earlier decisions. An overlapping chain across two fields
resolves only by explicit exclusion.

## Report

Versioned deterministic JSON of EXACTLY the non-included rows with physical line
numbers, verbatim permitted field text and documented reasons. 16 MiB cap on the
serialized text **before** any Blob; one Blob/URL/link per click, link removed
immediately, URL revoked on the next tick, on failure, on replacement and on
dispose — revoked at most once. Generic constant filename.

## Design points worth review

- The decision layer renders only when the model seam is mounted, so the
  accepted 170 preview is byte-for-byte unchanged when it is not.
- `csv-preview.ts` was left alone on purpose; the model derives everything from
  the accepted projection.
- `in` narrowing is used instead of a boolean discriminant because this project
  compiles with `strict: false`, where `ok: true | false` widens to `boolean`.
- Ref and seam access is capability-checked (`clear`/`include`/`download` are
  functions), so a partially initialized seam can never be called.

## Limits (not claimed)

No real browser download, DOM paint, RTL layout, HTTP or DB. No import, commit,
account, OTP, enrollment, financial, idempotency or audit behaviour exists in
this batch. No platform uniqueness claim. No CSV/XLSX export, no
storage/network/clipboard write. No performance measurement — structures are
bounded but no latency claim is made. The 16 MiB cap is an engineering bound,
not a measured browser limit.

Done is the complete local duplicate review plus the JSON rejected-row report
only — not XLSX, not a server import, not whole C12, not M2. A worker report is
not acceptance.
