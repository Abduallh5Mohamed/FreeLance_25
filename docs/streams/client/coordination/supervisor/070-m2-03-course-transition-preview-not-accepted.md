# M2-03 source/architecture review: course transitions and preview incomplete

UTC2026-10-18T17:47:27Z / Cairo20:47:27. Branch codex/human-client verified.
Read handoff, remaining inventory, README,068 and worker039 plus actual sanitized
report for client-m2-03-material-management-20261018-01, worker
wb-m2-03-material-management-01a, reported17:35:43.993Z. Stopped under report
protocol; no active/ready/blocked tasks before correction. SessionId=null, no
native run mapping available; do not invent continuing execution.

## Independent verification and architecture review

Installed managed Node22.22.2/local tsx: all13 client files **499/499 pass**, no
fail/skip/cancel. Full frontend tsc: **zero scoped errors**, same **11 outside**
diagnostics, command nonzero. Accepted055 seven hashes and067 four hashes all
unchanged. No live services/network/DB/browser, installs or Git writes.

Read actual page/controller integration, lifetimes, URL/duration decisions,
refresh handling, tests and contract note. Injected production seam and reuse of
accepted catalog guards/session reader are sensible boundaries; no need for a
new framework or shared-module edit. UI still owns preview data outside the
lifetime fences, and declared busy/refresh behavior is not consistently enforced.
Test totals and worker claims do not resolve these concrete gaps.

## Verified failures

Outside repository: C:/Users/BaraaWael/TabwebClientSupervisor/070-material-lifecycle.mts.
Imports actual production controller; injected fixture transport only.
**Two selected tests,0 pass,2 fail**:

1. Start deferred createA, select courseB, deliberately submitB. selectCourse
   clears busyKind but does not retire writeGuard, so B receives duplicate/no
   request until obsolete A settles. UI appears ready but new scope remains
   locked by retired scope. Release only the obsolete ownership on transition;
   old finally must still never free a newer operation's ticket/busy state.
2. Create confirmed by server, refresh returns malformed non-array body.
   runMaterialsLoad unconditionally sets phase=error/materials=[] and omits
   refreshError in that branch. Expected last confirmed rows plus separate
   refresh error; actual rows empty. Treat malformed refresh as refresh failure,
   preserving confirmed data and preventing blind write retry.

Additional **source-confirmed** page defect: playingVideo URL/title state is set
on Play and cleared only by VideoPlayer.onClose. Neither selected-course change
nor session subscription clears it. The old preview stays mounted after course
switch/empty selection/logout, even though the controller cleared its list.
Fence actual preview lifetime with course/session/data invalidation; test the
production state/decision used by the page, not a copied helper. No player/provider
implementation or new M3 feature required. No rendered browser exploit claimed.

**Decision: not accepted.** Prepared bounded correction
client-m2-03-course-transition-preview-20261018-02 only after predecessor reported
and stopped; same four068 paths/provenance. Dispatch one ready, no active/blocked.
Codex did not claim or edit worker-owned source/tests. Preserve working behavior,
grade/group data, exact canonical session and previous accepted files. Cover new
scope success/failure, old-finally vs pending newer work, A→B→A/empty, malformed
refresh/current retry, and preview clearing on course/session/logout invalidation.

## Replies to worker039 and schedule

Real upload/provider surface is not approved. Keep truthful external-video refusal;
do not invent video IDs or bypass. Internal video:// reference may only be an
already supplied value; this batch does not claim an operational upload flow.
410 conversion is source-confirmed; documented nonvideo behavior remains.
Track068 contract gaps on the client side pending developer1 evidence; the client
worker is not expected to deliver server contracts. They are narrow future
blockers, not a STOP while this correction can proceed. Source/component plus
actual production-seam evidence is sufficient within the no-DOM-harness limit;
no package/install blocker requested, no runtime RTL/a11y assurance claimed.

M1/039, M2-01/055, M2-02/067 stay closed. OTP deferred060. No429/new human blocker.
Supervisor timer Ready, last result0, next21:00:09 Cairo, STOP absent. No later
batch or scope. Clear only own pending marker2026-10-18T17:45:11.5013942Z.
