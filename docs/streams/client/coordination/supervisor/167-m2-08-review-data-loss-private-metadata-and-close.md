# M2-08 requires three same-scope corrections

Review `3c90b08d-3056-41b9-95a3-a59bdf8ed787`,2026-10-19. Consume worker063,
native worker065 task reported/stopped; runtime exited0, no CLI or active owners.
Mapping: `ses_eaa383eaeffeV2vRINGv4U058y`. Do not reopen accepted164.
Codex independently ran163 tests (39 new+72 enrollment+52 branches): all pass.
Frontend tsc exits1, zero diagnostics in five scoped paths, same11 outside.
Those tests miss the following actual production defects. Not accepted.

## F1: quoted empty data records disappear

File/function: `src/features/students/csv-preview.ts`, `scanRecords/endRecord`.
Reproduce: `name\n""\nSynthetic\n` or `name\n"   "\nSynthetic\n`.
Actual: one row, no missing-name issue; endRecord drops any single trimmed-empty
cell as a blank line even when quotes made it an explicit data record.
Expected: two rows, original line2 retained with missing-name issue, line3 valid.
Fix: distinguish a genuinely blank physical record from an explicit quoted field;
skip blank lines without silently removing quoted empty/whitespace data. Preserve
ragged/quote/limit checks and physical line accounting. Regression both quoted
forms, quoted empty at EOF, ordinary blank lines and mixed quoted multiline input.

## F2: silent scope change restores private filename

File/function: same module, `selectFile` success AND catch principal-change branches.
Reproduce: start synthetic private-named file, change injected principal while
read awaits, then resolve or reject. Actual rows clear but code captures old
state.fileName and restores it after adoptPrincipalChange. Expected all old-scope
private file metadata cleared (fileName null), truthful session-changed message
may remain. Fix both completion paths; do not retain old metadata just for an
error. Preserve newer-read ownership, notification clearing, stale outcome checks
and ordinary same-principal read-error behavior. Regress success/error and retired
read/newer read cases, proving old completion cannot resurrect metadata/clear latch.

## F3: real UI cannot close a pending preview read

File/function: `src/features/students/StudentImportPreview.tsx`, close control/render.
Reproduce actual component with real controller in phase reading: file input is
disabled; close button exists only inside hasPreview (ready/empty). Actual no
reachable close action until a successful read finishes. Expected explicit enabled
close during a pending read invokes existing clear, immediately clears private
state and retires the result. Fix expose the existing labelled close control while
reading (preserve label for regression); no fake abort promise and no automatic
retries. Late read success/error must not restore preview; selecting again after
clear must work, old finally must not clear the newer busy state. No shared Button
replacement or unrelated UI rewrite. Test actual component control and real controller.

## Bounded next action

Fresh correction `client-m2-08-csv-preview-correction-20261019-01` only AFTER
verified stopped predecessor, same five paths in M2-08-HANDOFF under human152.
Preserve good parser/controller/render separation, resource bounds, zero network/
persistence, accepted enrollment code, no API/backend/identity/product-policy work.
Public independent probe is read-only:
`C:/Users/BaraaWael/TabwebClientSupervisor/167-m2-08-independent-probes.test.ts`.
Five production-path probes currently0/5: two parser, two private metadata and
actual component close callback retiring the pending read. Exact read grant only;
no TEMP/general supervisor file access. Run unchanged probe, add real regressions
in allowed suite, keep163 existing tests passing and scoped types clean with11
outside disclosed. Stop ALL activity before native report and concise worker reply.
Codex reviews stable correction independently. No acknowledgment or per-batch STOP;
direct idle CLI dispatch follows task preparation, no second owner/model rotation.
