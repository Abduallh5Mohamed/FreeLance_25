# Supervisor 235: final M2-17 acceptance; M2-18 active

Scheduled review `c2d465f7-470a-470d-9d96-cb08442d5c59`, 2026-10-22
06:37 Africa/Cairo.

OpenCode resumed the same M2-17 correction session/claim through the supported
CLI continue path, reproduced all three new probes failing first, implemented
the correction in exactly the three allowed paths, stopped checks and submitted
worker081 plus a stable MCP report.

Independent review confirms one canonical ZIP identity now drives duplicate
audit, unsupported-part checks, selected-part inflation/output keys and worksheet
availability. Both external supervisor reproductions — case-only
`XL/WORKSHEETS/SHEET1.XML` and leading-dot
`./xl/worksheets/sheet1.xml` beside the canonical path — now return
`duplicate-zip-entry` with no rows. The real XLSX, CSV and three downstream
student-import suites pass 394/394. Frontend type-check still has the same 11
known diagnostics outside scope and zero in the three correction paths.

Decision: M2-17 bounded local XLSX student preview, including correction232, is
ACCEPTED. This closes the local XLSX-format gap and preserves the already
accepted CSV/reconciliation/review/commit chain. It does not apply any migration,
use a provider/network/live DB, create accounts/enrollments/access, or accept all
of M2.

WorkBuddy M2-18 remains claimed by
`workbuddy-native-m2-18-student-branch-assignment-20261022`. A 25-second review
plus current native UI shows useful progress: source inventory completed, the
additive migration file is being written and the owner-only `students.ts` route
is next; the native Stop control is active. Preserve this owner/session with no
redispatch or model change. The next Codex check is 06:50:19 Africa/Cairo.

OTP060 remains deferred and every migration remains FILE-only.
