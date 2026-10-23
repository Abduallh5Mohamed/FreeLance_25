# 080 — M2-17 local XLSX student preview: implemented, tested, reported

**Task:** `client-m2-17-local-xlsx-student-preview-20261022-01` (team `frontend`,
`approvalVersion 2`).
**Worker:** `workbuddy-native-m2-17-xlsx-preview-20261022` (WorkBuddy native
implementation worker).
**Claim:** `claimToken 9d094fadb69ec78d19b353590edca3034aa3ff71a1f353fe`,
scopeHash `ab87e3229281190265aada865e7f3200bfe090068ce101466e5f02c06811af7c`.
**Branch:** `codex/human-client`. **Status:** implemented, tested, **reported** —
this is **not acceptance**; Codex independently reviews.
**Reported at:** 2026-10-21T23:35:39Z / 2026-10-22 02:35 Cairo.

## Scope

The claim returned exactly the eight M2-17 allowedPaths and they matched before
any edit. Only those eight were touched.

| Path | Change |
|---|---|
| `package.json` | `fflate` pinned at `0.8.2` (the already-locked version) — one additive line, no install, no fetch |
| `package-lock.json` | the matching one-line dependency entry — CRLF preserved |
| `src/features/students/xlsx-preview.ts` | **new, ~1040 lines** — the bounded local `.xlsx` decoder |
| `src/features/students/csv-preview.ts` | 15 additive XLSX error codes, the `StudentCsvSourceRecord` type, `buildStudentPreviewFromRecords` (the single canonical mapper for both formats), the `readBytes` seam and the dual-format dispatch in `selectFile`; every existing fence untouched |
| `src/features/students/StudentImportPreview.tsx` | 15 Arabic diagnostic headlines, the `readBytes` seam, the dual `accept` list, the dual picker wording and the first-worksheet / no-formula / no-password statement |
| `src/tests/m2-student-xlsx-preview.test.ts` | **new — 87 tests** |
| `src/tests/m2-student-csv-preview.test.ts` | 51 → **53 tests** (panel assertions updated to the dual picker, a no-save assertion, two dispatch tests) |
| `docs/streams/client/M2-17-CONTRACTS.md` | **new** — the decode order, the container refusal table, the bounds table, cell/grid semantics, CSV equivalence, lifecycle fences, on-screen wording, privacy, limits and the residual risk |

No other route, page, feature, test, contract, shared/auth/provider/config or
package file was touched.

## What changed

**A bounded, fail-closed local workbook decoder.** `parseStudentXlsx` reads only
the **first declared worksheet** of a `.xlsx` container and turns it into the
same headers/rows/issues/duplicates the accepted CSV path produces, so an
identical workbook and CSV file yield byte-identical output through the single
mapper `buildStudentPreviewFromRecords`.

The order is: container → audit before inflation → inflate only what is needed →
fail closed. Pass one lists the ZIP entries with inflation **off**
(`unzipSync` filter returning `false`) and refuses the archive on an OLE2 header,
`.xls`/`.xlsm`/`.xltx`/`.xltm` by extension, a password-protected workbook,
any unsupported part (macros/`vbaProject.bin`, external links, drawings, media,
charts, controls, pivot/query tables, ListObjects), a duplicate, traversal,
absolute, drive-letter or backslash path, unsupported compression, or any bound
breach. Pass two inflates only `xl/workbook.xml`, its relationships, the
resolved first worksheet and `xl/sharedStrings.xml`. A refused archive
**never inflates anything** — pinned by a test whose every entry declares
4 MiB + 1 and carries un-inflatable payloads.

**Bounds:** file ≤ 1 MiB (the controller, on the declared size, before any
read), ≤ 128 ZIP entries, ≤ 4 MiB total declared uncompressed, ≤ 2 MiB per
relevant XML entry, ≤ 1001 worksheet rows including the header, ≤ 6 columns,
≤ 4096 chars per cell, ≤ 6001 shared strings.

**Cell semantics:** `t="s"` via shared strings (rich-text runs concatenated,
phonetic runs skipped), `t="inlineStr"`, `t="n"`/absent as XML lexical text (so
`007` survives only when genuinely stored as text); `t="str"` and any `<f>`
formula refuse as `formula-cell`; `t="b"`/`t="e"` refuse as
`unsupported-cell-type`; dates and styles are unsupported rather than guessed.

**The grid:** blank rows are skipped, short rows are padded with empty strings,
and wider rows stay wider so the shared builder refuses them as
`ragged-record` exactly as the CSV path does; physical XLSX row numbers populate
`rowNumber`.

**Well-formedness is a refusal, not a reinterpretation.** While writing the
malformed-XML tests a real gap surfaced: the scanner was a flat token stream, so
mis-nested XML (e.g. `<row><c><v>1</v></row>`) silently dropped content and could
still parse successfully. The scanner now keeps an open-element stack and
`parseStudentXlsx` maps `MalformedXml` to `malformed-xml`. Pinned by seven tests.

## Verification

| Command | Result |
|---|---|
| `npx tsx --test src/tests/m2-student-xlsx-preview.test.ts` | **87 pass / 0 fail** |
| `npx tsx --test src/tests/m2-student-csv-preview.test.ts` | **53 pass / 0 fail** |
| the five student-import client suites together (`m2-student-import-commit`, `m2-student-import-resolution`, `m2-student-import-server-resolution`, xlsx, csv) | **390 pass / 0 fail** |
| `npx tsc --noEmit -p tsconfig.app.json` | **12 pre-existing unrelated diagnostics, 0 in this batch's files** (NotificationBell, StudentHeader_OLD_BACKUP, ExamReports ×2, ExamResults, Fees ×2, StudentBarcodes, StudentDashboard, versionChecker — identical to the pre-batch baseline) |

Coverage added by the XLSX suite: format detection and dispatch; container
refusals (OLE2, non-ZIP, password-protected/revisions/locked workbookProtection,
unsupported parts, duplicate/traversal/absolute/drive/backslash paths, method
99, corrupt deflate, audit-inflates-nothing, 128/129 entries, 4 MiB total,
entry-too-large); cell semantics (shared strings incl. Arabic, entities and
`xml:space`, rich text, phonetic runs, inline strings, numeric lexical text,
comments/CDATA/PIs, formula/`str`/`b`/`e` refusals); the grid (blank rows, gaps,
padding, ragged, rows/cells without references, repeated references); worksheet
selection (first declared, absent second sheet, absolute target); the canonical
mapping (unknown/duplicate/empty/missing-name headers, 6 vs 7 columns, any
order, duplicates, empty file, CSV/XLSX byte-identical equivalence); missing and
malformed parts (missing workbook part, no sheet/no id/unresolved
relationship/absent worksheet/no rels at all, chartsheet, unclosed/unterminated/
mis-nested/stray tags, unknown entity, invalid UTF-8, malformed workbook/rels
parts, bad shared-string index); bounds (file bound equivalence, 1001/1002 rows,
6001/6002 shared strings, 4096/4097 chars); 17 controller lifecycle tests (byte
seam, missing seam, non-bytes, size fence, newer-supersedes-older, older
failure, busy latch, close/dispose/session retirement, silent principal change
on success and failure, refused workbook with no partial preview, `.xls`
refused without a text read, CSV-then-workbook in one controller, 25-per-page
paging with worksheet row numbers surviving, and the network/persistence
guard); and 7 component tests (dual picker wording/accept/first-worksheet
statement/no save control, diagnostics with no table, parsed rows and paging,
markup escaped as text, the real close control retiring a pending byte read,
the close control rendered exactly once).

The fixtures build workbooks with `fflate` `zipSync` and, where `zipSync` cannot
express the declaration, with a raw local-file-header ZIP writer. Two fixture
bugs were found and fixed while writing the tests (a missing `<si>` wrapper and
a missing `workbook` override) rather than weakening any assertion; the harnesses
of the accepted CSV suite were reused verbatim so the component tests stay
comparable.

## Constraints honoured

No DB, network, browser, service, install, migration, deploy, Git write or
branch switch. All edits and checks stopped before the MCP report. Scope
discipline confirmed: among tracked files only `package.json` (+1) and
`package-lock.json` (+1) are modified by this batch; every other dirty tracked
file (`src/lib/api-http.ts`, `server/src/routes/tenant-self.ts`,
`src/pages/*.tsx`, `docs/streams/client/M2-HANDOFF.md`, the coordination README,
the memory log) is pre-existing unrelated work and was preserved untouched. No
schedule change, no self-acceptance, no next task claimed.

## Limits

* Dates and number formats are refused rather than guessed: a workbook whose
  values are stored as numbers/dates yields empty names and a `missing-name`
  issue rather than a wrong import.
* Residual risk documented in `M2-17-CONTRACTS.md`: bounds are read from ZIP
  declarations, so a lying archive can make the decoder read **less** than
  claimed but never more, and a truncated part fails closed.
* Not exercised and not claimed: live Excel semantics, real OOXML edge cases
  beyond the scanner, a browser, a listener, a socket or an app startup.
* No account, login, enrollment, access or existing-record identity is created,
  requested, returned or stored; the decode is read-only and local.

## Open questions for the reviewer

None. The task specification was complete and every documented refusal has a
failing-first test behind it.

No self-acceptance, no next task, no schedule change.
