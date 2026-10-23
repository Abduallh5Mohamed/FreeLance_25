# 081 — M2-17 canonical ZIP identity correction: implemented, tested, reported

**Task:** `client-m2-17-canonical-zip-path-correction-20261022-01` (team `frontend`,
`approvalVersion 2`, `taskKind correction`, `implementationWorker opencode`).
**Worker:** `opencode-7868-m2-17-canonical-zip-20261022` (OpenCode native direct CLI,
supervisor-managed under human152/180). Claim token retained privately, not written here.
**Branch:** `codex/human-client`. **Status:** implemented, tested, **reported** — this is
**not acceptance**; Codex independently reviews.
**Reported at:** 2026-10-22T03:34Z / 2026-10-22 06:34 Cairo.

## Scope

The claim returned exactly three allowedPaths and they matched before any edit. Only
those three were touched:

| Path | Change |
|---|---|
| `src/features/students/xlsx-preview.ts` | the decoder's ZIP path identity is now canonical in the duplicate audit as well as in part selection/inflation |
| `src/tests/m2-student-xlsx-preview.test.ts` | 87 → **91 tests**: both exact collision regressions, a pre-inflation regression and a no-false-positive guard |
| `docs/streams/client/M2-17-CONTRACTS.md` | the decode order, the duplicate refusal row and a new "One canonical ZIP identity" section |

No other route, page, feature, test, contract, shared/auth/provider/config or package
file was touched. The pre-existing dirty tracked files (14, including
`src/lib/api-http.ts`, `server/src/routes/tenant-self.ts`, `src/pages/*.tsx`, the memory
log, `package.json`/`package-lock.json`, `M2-HANDOFF.md` and the coordination README)
were preserved untouched.

## The defect (supervisor 232)

`auditZipEntries` recorded duplicate paths by their **raw** ZIP names while
`inflateParts` later canonicalised names by lower-casing and stripping leading `./`.
An archive declaring both `xl/worksheets/sheet1.xml` and `XL/WORKSHEETS/SHEET1.XML`
(or `./xl/worksheets/sheet1.xml`) therefore passed the duplicate audit, and the second
entry silently replaced the first in the normalised output map: the parse returned
`ok: true` and the first row's value changed.

I reproduced it failing-first in the real production seam before touching the decoder:
the two collision tests parsed successfully (`expected the workbook to be refused`) and
the pre-inflation probe returned `unreadable-archive` instead of `duplicate-zip-entry`,
proving the colliding part really was being inflated.

## The fix — one canonical identity everywhere

`normalizeZipPath` is now `canonicalZipPath` with a contract-level doc comment, and it
is the single identity used by **every** ZIP decision:

1. **duplicate detection** (`auditZipEntries`) — the seen-path set is keyed by the
   canonical path, so a case-only or leading-`./` spelling of a declared part is the
   same part and is refused as `duplicate-zip-entry`;
2. **unsupported-part refusal** — unchanged behaviour, now explicitly the same identity;
3. **part availability** (`resolveWorksheetPart`) and **inflation selection / output
   keys** (`inflateParts`) — unchanged behaviour, now explicitly the same identity, plus
   a backstop that refuses two *selected* entries sharing one canonical path so no
   output key can ever be overwritten even if the audit were refactored later.

Enforcement order is unchanged: entry count → unsafe/traversal path → unsupported part
→ unsupported compression → canonical duplicate → declared totals. Because the audit
still returns `false` from the fflate filter for every entry, a canonical collision is
refused with **nothing inflated**. Traversal, absolute/drive/backslash refusal,
unsupported parts, compression and every resource bound are untouched.

**Before:** `xl/worksheets/sheet1.xml` + `XL/WORKSHEETS/SHEET1.XML` → `ok: true`, first
row silently replaced by the second entry's value.
**After:** the same archive → `ok: false`, `duplicate-zip-entry`, zero rows. A workbook
that declares the part **once** in another case or with a leading `./` still parses
normally, because the canonical identity is also the selection identity.

## Verification

| Command | Result |
|---|---|
| `npx tsx --test src/tests/m2-student-xlsx-preview.test.ts` | **91 pass / 0 fail** (was 87; the 4 new tests) |
| `npx tsx --test` on the five student suites together: xlsx, `m2-student-csv-preview`, `m2-student-import-commit`, `m2-student-import-resolution`, `m2-student-import-server-resolution` | **394 pass / 0 fail** (was 390) |
| `npx tsc --noEmit -p tsconfig.app.json` | **11 diagnostics, all pre-existing and outside the batch** (NotificationBell 1, StudentHeader_OLD_BACKUP 2, ExamReports 2, ExamResults 1, Fees 2, StudentBarcodes 1, StudentDashboard 1, versionChecker 1); **0 in the three allowed paths** — identical to the supervisor 232 baseline |

The four added behaviours:

* a **case-only** canonical collision (`XL/WORKSHEETS/SHEET1.XML`) is refused as
  `duplicate-zip-entry` — the competing sheet's `Mallory` value never becomes a row;
* a **leading-dot** canonical collision (`./xl/worksheets/sheet1.xml`) is refused the
  same way;
* the collision is refused **before any part is inflated**: the real worksheet carries a
  deflate stream that cannot be inflated, so an inspecting audit would have reported
  `unreadable-archive`; the actual result is `duplicate-zip-entry`;
* a **single** legitimate spelling (`XL/WORKSHEETS/SHEET1.XML` or
  `./xl/worksheets/sheet1.xml`, declared once) still parses and yields `Ali`, so the
  canonical identity introduces no false duplicate.

## Constraints honoured

No install, network, DB, browser, provider, service, Git write, deploy, schedule change,
account change or OTP. No edits outside the three allowed paths (the only extra write is
this mandated worker report). All edits and checks stopped before the MCP report. No
self-acceptance, no next task claimed, no claim retired by me.

## Limits

* The canonical form is exactly backslash→slash, strip leading `./`, lower-case. An
  interior `./` segment (e.g. `xl/./worksheets/sheet1.xml`) is deliberately **not**
  collapsed; such a part is not found and fails closed as `missing-worksheet` rather
  than being guessed at.
* Directory entries remain outside the duplicate audit exactly as before; they are
  skipped as non-content.
* The backstop in `inflateParts` is unreachable while the audit runs first; it exists to
  keep the no-overwrite invariant local to the inflation pass.
* Not exercised: the ZIP spec's full path grammar, real Excel writers beyond the
  fixtures, browser transport, live services. The decoder remains read-only and local.

No self-acceptance, no next task, no schedule change.
