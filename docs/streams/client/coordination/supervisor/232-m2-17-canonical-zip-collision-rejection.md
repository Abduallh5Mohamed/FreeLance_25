# Supervisor 232: M2-17 canonical ZIP collision rejection

WorkBuddy080 reported and stopped M2-17. Independent verification ran the real
XLSX, CSV and downstream import client suites: 390/390 passed. Frontend types
returned the same 11 unrelated diagnostics and zero diagnostics in the eight
allowed paths. Those results do not override the production-path defect below.

`auditZipEntries` in `src/features/students/xlsx-preview.ts` records duplicate
paths by their raw ZIP names, while `inflateParts` later canonicalizes names by
lower-casing and stripping leading `./`. An archive containing both
`xl/worksheets/sheet1.xml` and `XL/WORKSHEETS/SHEET1.XML`, or the first path and
`./xl/worksheets/sheet1.xml`, therefore passes the duplicate audit. The second
entry silently replaces the first in the normalized output map. A real probe
expected `duplicate-zip-entry`; actual result was `ok: true` and the row value
changed from `Alice` to `Mallory`.

OpenCode correction task
`client-m2-17-canonical-zip-path-correction-20261022-01` is bounded to the XLSX
decoder, its test suite and the M2-17 contract. Duplicate detection must use the
same canonical identity used for selection/inflation, refuse case/leading-dot
collisions before inflation, and keep traversal, unsupported-part and all
resource bounds intact. Add both exact regressions, run the XLSX, CSV and
downstream import suites plus scoped types, then stop/report for independent
review. M2-17 remains unaccepted until that stable correction is reviewed.

WorkBuddy may receive the next disjoint NEW M2 batch while OpenCode owns this
correction, per the user's direct two-lane instruction.
