# M2-17 handoff: bounded local XLSX student preview

Task: `client-m2-17-local-xlsx-student-preview-20261022-01`

## Goal and before/after

Before: the accepted student-import flow supports bounded local CSV only. XLSX
remains a recorded C12 gap, so instructors must convert spreadsheets outside the
product.

After: the same private import panel accepts `.csv` or `.xlsx`. XLSX is decoded
locally from the first worksheet, mapped through the same six-column vocabulary
and produces the same canonical preview rows used by decisions, reconciliation,
review and commit. No file content leaves the browser before the existing,
explicit commit confirmation.

## Exact allowed paths

1. `package.json`
2. `package-lock.json`
3. `src/features/students/xlsx-preview.ts`
4. `src/features/students/csv-preview.ts`
5. `src/features/students/StudentImportPreview.tsx`
6. `src/tests/m2-student-xlsx-preview.test.ts`
7. `src/tests/m2-student-csv-preview.test.ts`
8. `docs/streams/client/M2-17-CONTRACTS.md`

These paths are disjoint from the active OpenCode M2-16 correction.

## Required behavior

- Promote the already-present locked `fflate` package to an explicit direct
  dependency without installing or fetching anything. Use it only for bounded
  ZIP entry inflation.
- Accept `.xlsx` only; reject legacy `.xls`, `.xlsm`, password-protected,
  malformed ZIP/XML, formulas, macros, external links, drawings/media and any
  unsupported workbook construct with a truthful file-level error.
- Read exactly the workbook's first declared worksheet. Do not guess a sheet,
  merge sheets, execute formulas or use cached formula results.
- Enforce bounds before/until inflation: compressed file <= 1 MiB, total ZIP
  entries <= 128, total declared uncompressed bytes <= 4 MiB, each relevant XML
  entry <= 2 MiB, worksheet rows <= 1001 including header, columns <= 6, cell
  text <= 4096 chars and shared strings <= 6001. Refuse duplicate ZIP paths,
  traversal paths and unsupported compression.
- Parse workbook relationships, shared strings and inline strings deterministically.
  Preserve text exactly before the accepted trim/canonical row mapping; numeric
  cells become their XML lexical text so leading zeros are preserved only when
  the workbook stored them as text. Dates/styles are unsupported rather than
  guessed.
- The header vocabulary, required `name`, duplicate candidates, missing-name
  issues, pagination and canonical `StudentCsvRow` output remain identical to
  CSV. Physical XLSX row numbers populate `rowNumber`.
- File reads remain injected and local. Preserve session/principal fencing,
  latest-selection ownership, close/reset/new-file cleanup, and retirement of
  decisions/reconciliation/review/commit results when a new spreadsheet starts.
- No server, DB, network, browser automation, storage, logging, upload, account,
  enrollment, access, payment, provider or migration behavior.

## Tests and completion

- New hermetic production-path XLSX tests build tiny ZIP fixtures in memory and
  cover shared/inline strings, Arabic, sparse rows, headers, duplicates, first
  worksheet selection and every refusal/bound/lifecycle rule above.
- Existing CSV tests remain green and gain integration assertions for the dual
  picker without weakening CSV behavior.
- Run the new XLSX suite, unchanged CSV and downstream student-import client
  suites, and scoped frontend types. Report exact counts and known unrelated
  diagnostics honestly.
- Stop all edits/checks before the MCP report. Worker report is not acceptance.

