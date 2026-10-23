# M2-17 — client contracts for the bounded local XLSX student preview

Task: `client-m2-17-local-xlsx-student-preview-20261022-01`.
Handoff: `docs/streams/client/M2-17-HANDOFF.md`.
Builds on: accepted M2-08 (local CSV preview), M2-11 (local decisions + JSON
report), M2-14 (read-only server reconciliation), M2-15 (existing-match review)
and M2-16 (audited idempotent import commit).

The CSV path, the six-column vocabulary, the canonical `StudentCsvRow` output,
the lifecycle fences and every later step are **unchanged**. This batch widens
exactly one thing: the private import panel now also accepts an `.xlsx`
workbook, decoded locally from its **first declared worksheet**, and mapped
through the SAME canonical builder the CSV path uses. No file content leaves
the browser before the existing, explicit commit confirmation, and no new
server, DB, network, storage, logging, upload, account, enrollment, access,
payment, provider or migration behaviour exists.

## Modules

| Path | Change |
|---|---|
| `src/features/students/xlsx-preview.ts` | **new** — the bounded local XLSX decoder and the dual-format dispatch |
| `src/features/students/csv-preview.ts` | **additive** — 15 XLSX diagnostic codes, the container-neutral record builder, the optional `readBytes` seam and the name-based dispatch |
| `src/features/students/StudentImportPreview.tsx` | **additive** — the byte seam, the dual picker, 15 Arabic headlines and the first-worksheet/no-formula statement |
| `src/tests/m2-student-xlsx-preview.test.ts` | **new** — hermetic production-path suite |
| `src/tests/m2-student-csv-preview.test.ts` | **additive** — dual-picker assertions and the dispatch integration; every accepted CSV behaviour still pinned |
| `package.json`, `package-lock.json` | `fflate@0.8.2` promoted to an explicit direct dependency, one line each, with no install and no fetch |

`fflate` was already present and version-locked through the dependency tree;
promoting it changes no resolved version and touches no `node_modules`. It is
used for bounded ZIP entry inflation only.

The decoder imports the accepted column vocabulary, bounds and canonical row
builder from `csv-preview`, and `csv-preview` imports the decoder back for the
dual-format dispatch. That cycle is deliberate and safe: both sides reach for
each other's exports **only from inside function bodies**, never while
initialising, so either load order resolves.

## The decode order

The order is the contract. Every rule below is enforced in this sequence, so a
refused archive never inflates anything at all.

1. **Container.** Only `.xlsx` is accepted. Legacy `.xls`, macro `.xlsm` and
   the template variants `.xltx`/`.xltm` are refused **by name**, so they never
   reach the CSV parser and are never mistaken for a comma separated file. An
   OLE2 compound container carrying the `.xlsx` name is an encrypted workbook
   and is refused as `password-protected`.
2. **Audit before inflation.** The ZIP central directory is walked **once**
   with inflation switched OFF (the fflate filter returns `false` for every
   entry). Entry count, declared uncompressed total, compression method,
   duplicate **canonical** paths, traversal paths and every unsupported
   workbook part are decided from the declarations alone.
3. **Inflate only what is needed.** `xl/workbook.xml`,
   `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml` and the resolved first
   worksheet — nothing else.
4. **Fail closed.** Every malformed construct produces a truthful file-level
   diagnostic and no rows, never a partially accepted workbook.

## Container refusals

| Refusal | Cause |
|---|---|
| `unsupported-format` | a spreadsheet name other than `.xlsx` |
| `password-protected` | an OLE2 container, or a `workbookProtection` with `workbookPassword`/`revisionsPassword` |
| `unreadable-archive` | not a ZIP archive, or a stream that cannot be inflated |
| `too-many-zip-entries` | more than 128 entries |
| `archive-too-large` | the declared uncompressed total exceeds 4 MiB |
| `entry-too-large` | a relevant XML entry declares more than 2 MiB |
| `duplicate-zip-entry` | the same **canonical** ZIP path is declared twice — see below |
| `unsafe-zip-path` | a traversal segment, an absolute path, a drive letter or a backslash separator |
| `unsupported-compression` | a compression method other than stored (0) or deflate (8) |
| `unsupported-workbook-part` | a VBA project, an external link, a connection, a query table, a drawing, media, a chart, controls, ActiveX, pivot tables/cache, slicers, or a ListObject |
| `missing-workbook-part` | `xl/workbook.xml` is absent |
| `missing-worksheet` | no declared sheet, a sheet with no relationship id, a relationship that does not resolve, or a worksheet part that is not in the archive |
| `malformed-xml` | a relevant part that is not well formed XML |
| `formula-cell` | a `<f>` element, or a `t="str"` cached formula result |
| `unsupported-cell-type` | `t="b"` (boolean) or `t="e"` (error) |
| `too-many-shared-strings` | more than 6001 shared strings |

Directory entries are recognised and skipped: they are not files, so they are
neither counted nor audited as content.

**Well-formedness is enforced, not assumed.** The decoder's XML scanner keeps
the stack of open elements, so a closing tag that matches nothing, a stray
closing tag, an element left open at the end of a part, an unterminated tag or
comment, an unknown entity reference and a part that is not valid UTF-8 are all
`malformed-xml`. A flat token stream would silently reinterpret a mis-nested
part as a different structure, which is exactly the guess this decoder refuses
to make.

## One canonical ZIP identity

A ZIP entry has exactly **one** canonical identity, and the same identity is
used for duplicate detection, for unsupported-part refusal and for selecting the
parts that get inflated. The canonical form replaces `\` with `/`, strips every
leading `./` and lower-cases the name:

| Declared entry | Canonical identity |
|---|---|
| `xl/worksheets/sheet1.xml` | `xl/worksheets/sheet1.xml` |
| `XL/WORKSHEETS/SHEET1.XML` | `xl/worksheets/sheet1.xml` |
| `./xl/worksheets/sheet1.xml` | `xl/worksheets/sheet1.xml` |
| `./XL/Worksheets/Sheet1.XML` | `xl/worksheets/sheet1.xml` |

That matters because Excel resolves part names case-insensitively and a writer
may prefix a name with `./`. If the duplicate audit compared raw names while the
inflation pass compared canonical names, an archive declaring both
`xl/worksheets/sheet1.xml` (the real sheet) and `XL/WORKSHEETS/SHEET1.XML` (a
different sheet) would pass the audit and the second entry would silently
overwrite the first in the canonical output map — the preview would show rows
the workbook's first part never contained.

The audit therefore refuses any second declared entry whose **canonical** path
was already seen, as `duplicate-zip-entry`, **before** anything is inflated. The
inflation pass selects and keys its output by the same canonical path, and
re-checks that no two selected entries share one, so the overwrite is impossible
even if the audit were later refactored.

A workbook that legitimately spells its part in another case, or with a leading
`./`, and declares it only once is **not** a duplicate: the canonical identity is
also the selection identity, so that single entry still resolves and is read
normally.

## Bounds

Every bound is an implementation limit, not a business entitlement. Each is
enforced **before or while** the corresponding work is done, so an over-limit
workbook is rejected outright instead of producing a misleading partial
preview.

| Bound | Value | Enforced |
|---|---|---|
| Selected file size | 1 MiB | on the DECLARED size, before the file is read at all (the same check the CSV path makes) |
| ZIP entries | 128 | during the audit, before any inflation |
| Declared uncompressed total | 4 MiB | during the audit, before any inflation |
| One relevant XML entry | 2 MiB | during the inflation pass, before the part is decoded |
| Worksheet rows, **including the header** | 1001 | while the sheet is scanned; a declared row number above the bound is refused too |
| Columns | 6 | on the header record's width |
| Cell text | 4096 characters | on the decoded value |
| Shared strings | 6001 | as the table is read |

The row bound counts physical worksheet rows, blank rows included, so a
workbook with 1001 rows of which most are blank is refused exactly as a dense
one is. A cell bound is measured on the **decoded** text, after entities are
resolved, so an encoded payload cannot smuggle a longer value past it.

## What a cell means

| Cell | Meaning |
|---|---|
| `t="s"` | the shared string at that index; a non-integer or out-of-range index is `malformed-xml` |
| `t="inlineStr"` | the inline string's runs, concatenated verbatim; an empty `<is>` is a real empty value |
| `t="n"` or no type | the XML **lexical** text of `<v>`, exactly as the workbook wrote it |
| `t="str"` | **refused** — a cached formula result |
| a `<f>` element | **refused** — formulas are never executed and never guessed |
| `t="b"`, `t="e"` | **refused** — a boolean or an error is not a student value |

A numeric cell keeps its lexical text, so `007` survives **only** when the
workbook really stored it as text; a stored number is surfaced as the digits the
file carries. Dates and styles are unsupported rather than guessed: a date is
an ordinary number in the file and, without interpreting `styles.xml`, the
decoder cannot know, so it surfaces the raw number instead of inventing a
calendar date.

Shared strings are decoded deterministically: the text of a shared string is
the concatenation of its runs in document order, a phonetic run (`<rPh>`) is a
pronunciation hint and its text is skipped, and `xml:space="preserve"` is
honoured. Comments, CDATA sections and processing instructions are tolerated;
CDATA content is taken verbatim, so entities inside it stay literal.

## The grid

- the **first declared** `<sheet>` in document order wins. No sheet is guessed,
  none are merged, and the active tab is irrelevant, so a second sheet is never
  read — not even to validate it;
- a blank row (no cells at all) is skipped, exactly as a blank CSV line is, so
  it never shifts the row numbers of the records that follow it;
- a cell with no reference takes the next free column of its row, and a
  repeated reference in one row is not counted twice;
- the physical worksheet row number populates `rowNumber`, so it always points
  at a real row of the workbook the instructor opened. A row without a
  reference is numbered by its position;
- a data record **narrower** than the header is padded with empty strings — an
  absent trailing cell is an empty cell, not a ragged record;
- a data record **wider** than the header keeps its width, so the canonical
  builder refuses it as a `ragged-record`, exactly as the CSV path does.

## Equivalence with the CSV path

`buildStudentPreviewFromRecords` is the single canonical mapper for both
formats. It receives container-neutral records (`{ line, fields }`) and
produces the identical `headers`, `rows`, `issues` and `duplicates`. A workbook
and a CSV file with the same content therefore produce byte-identical output,
and the accepted rules carry over unchanged: the header vocabulary and its
order, the required `name`, the case-sensitive column names with only
whitespace trimmed, an unknown/empty/duplicate/`name`-less header refusal, the
missing-name row issue, the exact within-file duplicate candidates with row
references, and the 25-rows-per-page pagination.

## Lifecycle fences

The controller keeps every accepted fence. The only addition is the byte seam.

| Fence | Rule |
|---|---|
| Declared size | checked BEFORE the read starts, for both formats |
| Byte seam | a spreadsheet is read through the injected `readBytes`; a CSV file is still read through `readFile` |
| Missing seam | a spreadsheet selected without `readBytes` is a truthful `read-failed` — the container is never mis-decoded as text to paper over the wiring |
| Non-bytes | a seam that resolves with something other than a `Uint8Array` is a truthful `read-failed` |
| Latest selection | a newer selection supersedes an older one; a retired reply never revives data and never releases a newer read's busy latch |
| Principal | a silent principal change is observed BEFORE any visible state is settled, on the success and the failure path alike, and the old scope's private file name is cleared |
| Session / `clear()` / `dispose()` | each clears the private rows and retires the pending read; `dispose()` unsubscribes |
| Reversed order | a retired reply cannot publish, cannot restore a dropped result and cannot release a newer latch |

## What the panel states on screen

- the picker is labelled for a CSV file **or** an XLSX workbook, and its
  `accept` list names both;
- the panel still states that it is a **local preview only**, that no student is
  saved by reading a file, that no record is created or modified automatically
  and that no real import happens on its own;
- a dedicated paragraph states that **only the first declared worksheet** is
  read, with no sheet merging, no formula execution and no use of cached
  formula results, and that dates and styles are unsupported;
- the same paragraph states that a password-protected workbook, and a workbook
  containing a macro, a drawing, media or an external link, is refused as a
  whole;
- every refusal renders its own truthful Arabic headline and no table, so a
  refused workbook never looks like a partial preview.

## Privacy and side effects

- no `localStorage`, `sessionStorage`, cookie, IndexedDB, `console` or log write
  happens at any point, and the decoder issues no request: the workbook is
  decoded in memory and the preview rows live only in the controller;
- the byte seam is the only new wiring, and it is injected, so the hermetic
  suites install failing `fetch`, `localStorage`, `sessionStorage` and
  `indexedDB` globals and both the CSV and the XLSX previews stay green;
- no server route, schema, migration, provider, account, enrollment, access or
  payment behaviour is added, and the audited commit remains the only way
  anything leaves the browser.

## Not proven here

Real browser transport, DOM paint, RTL layout, real HTTP, a live DB and
end-to-end server validation. A workbook is decoded, never re-saved, so the
original file is never rewritten. Platform-wide uniqueness, any
existing-record identity and any date/style interpretation are explicitly out
of scope: the server remains authoritative and no import commit exists for a
workbook beyond the audited one M2-16 already gates.

## Residual risk

The container bounds are read from the ZIP **declarations**, which is what
makes "refuse before inflating" possible. A crafted archive whose declared
sizes lie about the bytes that follow them can therefore make the decoder
allocate or read **less** than the file claims — it can never make it read more
than the declared bound, because every allocation and every inflation is
capped by those same declarations. The residual exposure is a truncated or
empty part, which fails closed as `malformed-xml` or `unreadable-archive`
rather than as a wrong student value. Closing it fully would require trusting
the declarations, which is the opposite of the rule this decoder is built on.
