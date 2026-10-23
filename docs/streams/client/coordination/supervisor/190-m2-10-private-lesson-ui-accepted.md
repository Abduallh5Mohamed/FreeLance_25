# M2-10 private lesson-management UI and188 correction accepted

2026-10-21, scheduled review ce4f95ba-6689-4a1f-8d0d-a43ca5b1fa92, human180.
Consumed WorkBuddy070 original and OpenCode071 correction; sanitized MCP reported,
native session ses_ea487d6cbffehMj7mke9rs1fuz finished exit0 at22:50:14Z. No active
owner at review; actual stable source/contracts/test additions inspected.

Fresh independent local tsx --test: m2-course-lesson-ui, m2-course-unit-ui,
m2-course-management, m2-tenant-branches-ui, m2-tenant-profile-ui,
m2-tenant-profile-edit, unchanged public179 and188 probes:339/339 pass
(330 production-path/regressions+9 independent probes). Public188 now6/6 from2/6.
Frontend tsc --noEmit -p tsconfig.app.json exit2: same11 known OUTSIDE diagnostics,
ZERO scoped diagnostics. Whole-project type cleanliness is not claimed.

Actual corrections verified:

- Parent mount derives visibleLessonUnitId before rendering from private scope
  and settled selected-row availability. Denied/unauthorized/no-workspace/missing/
  malformed or settled removed selection mounts NO private child before passive
  effects. Existing effect still clears selection; loading retained-row child
  remains. Actual component-tree independent probes pin this, not copied logic.
- parseCourseLesson validates BOTH timestamps as canonical-shaped, finite real
  dates whose toISOString exactly equals input. Impossible fields and calendar
  overflow rejected. List/single-write/reorder inherit it; malformed2xx write
  remains uncertain, does not confirm/retry or trigger success follow-up read.

Correction touched four paths (worker071 heading incorrectly says three): unit
component, lesson controller/parser, lesson tests and contract. API adapter and
CourseLessonManager hashes exactly match189 pre-correction checkpoint. All seven
accepted185 backend hashes preserved. Accepted183 Courses page/unit controller/
unit tests unchanged. Prior189 established additive API block with only one
collapsed interface newline outside it, no shared request/auth logic rewrite.

Accept original070 plus stopped071 as bounded private lesson metadata UI:
explicit per-unit keyed child, one page<=25 and selected-visible batch<=25,
create/edit title-description-order, archive/reactivate and one atomic selected
reorder request. Strict DTO/bound unit/PATCH target/exact batch identity set,
generation/form/principal/epoch/own-ticket fences, actual write single-flight,
confirmed write releases its ticket before bounded follow-up read, failed refresh
does not unconfirm save, unknown writes never auto-retry. Explicit reconciliation
reads current state only. Accessible Arabic/RTL component markup/callbacks tested.

Source bounds reviewed: explicit open, no per-row background fetch, no polling/
all-page drain/totals, one bounded page/selection, description<=10000, cursor<=256,
bounded row/batch loops and disposal/session/parent cleanup. No measured latency/
throughput/scalability, real browser layout, live HTTP/MySQL or physical deployment
proof. B05 migration FILE remains NOT applied. C5 still needs files/delivery/
drip/progress/assignment/public discovery and integration; whole M2 not complete.
OTP060 deferred; no new paid/access/publish/provider/financial policy.

Next owner/action: WorkBuddy M2-11 local CSV duplicate resolution+JSON rejected
report already approved/ready but UNCLAIMED, no checkpoint. Existing native-prefill
request pending; no repeat deeplink or second run. Human native send of supplied
task prompt remains required with current tools (186/187); no draft visibility or
automatic submit assumed. OpenCode idle, no invented correction/model call.

No batch STOP/timer change. Codex next actual scheduled check2026-10-21 02:05:19
Cairo, subject to machine/app availability, not a promised implementation start.
Preserve all dirty accepted work/owners. Remove ONLY matching ce4f95ba pending marker.
