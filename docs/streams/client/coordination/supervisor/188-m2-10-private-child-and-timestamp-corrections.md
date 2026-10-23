# M2-10 rejected: render-time private child gate and real ISO validation

2026-10-21, review c455ebd1-332e-410a-8667-369f79665139 under human180.
WorkBuddy070 and sanitized MCP reported/stopped, no active claim. Native WorkBuddy
claim workbuddy-native-m2-10-lesson-ui-20261021 is real; prior187 delivery wait is
resolved by the actual claim/submission, not by app-process inference.

Independent fresh325 tests pass (68 new+254 prior+unchanged public179 three).
Frontend tsc11 known OUTSIDE diagnostics, ZERO scoped. Source reviewed including
parent child mount, actual forms/adapters/controller/parsers, request/data/cleanup
bounds and own-write-ticket lifetime. No measured latency/scalability claim.

Independent actual production probe188:2/6 pass,4 fail. Public immutable file:
C:/Users/BaraaWael/TabwebClientSupervisor/188-m2-10-independent-probes.test.ts
No browser/HTTP/DB/default-adapter import. Hooked actual parent React tree before
passive effects; actual exported production DTO parser, no copied render logic.

1. CourseUnitManager.tsx child mount: `lessonUnitId ? <CourseLessonManager>` only
   checks selection. On an open parent receiving phase=denied/unauthorized/etc,
   or ready/empty page no longer containing selected row, state still carries
   old selection for this render. Child is present BEFORE useEffect clears it;
   expected no private child in that render. Actual count1 vs expected0. Parent
   transient loading retaining selected row is valid and must preserve child.
   FIX: render-time derived guard for permitted parent state AND selected row
   availability, plus existing effect/state cleanup. Do not depend on passive
   effect for private UI gating. Key immutable bindings; no accepted unit logic
   rewrite. Regress denied/no-workspace/unauthorized/missing/malformed and settled
   removal before effects, valid ready/loading controls, no stale remount.
2. course-lessons.ts parseCourseLesson: timestamps checked by shape regex only.
   `2026-99-99T88:77:66.000Z` and `2026-02-30T00:00:00.000Z` accepted as valid DTO.
   Expected malformed/no confirmation; valid canonical control passes. FIX shape
   plus finite real Date and EXACT toISOString round-trip for both timestamps;
   refuse invalid/normalized overflow, no fallback date. Regress list/write/reorder
   malformed envelope: never treat invalid2xx as confirmed write or retry.

OpenCode same-six-path correction client-m2-10-private-lifecycle-correction-20261021-01.
Stopped predecessor verified. Preserve all good component/controller/adapters,
strict bound-unit/PATCH/batch identity set,25-row/selection limits, generation/
epoch/principal/form/own-ticket fences, one write and bounded follow-up read.
Only necessary component/parser/tests/contract edits; no backend/shared transport/
new access policy. Public188 exact read grant only, never modify probe. Run new
regressions+unchanged325 tests/public179, unchanged188 six probes and frontend tsc;
report11 outside honestly. Stop all edits/checks before MCP report/unique worker
reply. No self-acceptance/TEMP/lint/defaultDB/dotenv/network/services/installs/Git.

Next WorkBuddy NEW local C12 duplicate-resolution/rejected-report task uses SIX
student-import paths disjoint from these six lesson paths. No new account/phone/
enrollment/financial policy or import writes. No per-batch STOP/worker timer.
