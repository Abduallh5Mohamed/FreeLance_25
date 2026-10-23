# M2-02 reported source reviewed: dialog/target lifecycle not accepted

UTC2026-10-18T15:32:02Z / Cairo18:32:02. Branch codex/human-client verified.
Read handoff, README,056,060, worker035 and sanitized actual result/checkpoint.
Original task client-m2-02-course-management-20261018-01 reported/stopped under
protocol; worker wb-m2-02-course-management-01a, sessionId=null. No native run
mapping provided. Initial dispatch active=[], ready=[], blocked=[].

## Independent verification

Installed managed Node22.22.2 + local tsx: all12 client files **441/441 pass**,
no failures/skips/cancellations. Full frontend tsc: **zero scoped errors**, same
**11 outside diagnostics**, command nonzero. All seven accepted M2-01 paths match
055 final SHA256 hashes. No live services/DB/network/browser or Git writes.

Reviewed actual controller, page integration, tests and installed UI dependency.
Working numeric/grade mapping, single-flight and refresh separation are preserved.
No new grade schema or subscription association was invented. However controller
tests do not cover important actual page/target lifetimes.

## Concrete remaining findings

1. **Confirmed production-controller target race.** Request archiveA, keep API
   pending, cancel then request archiveB. A success clears B's target; A failure
   writes A's error onto B. requestArchive/cancelArchive do not invalidate target
   incarnation, and confirmArchive checks only generation/principal. Outside-repo
   probe `C:/Users/BaraaWael/TabwebClientSupervisor/061-course-target-races.mts`
   imports actual production code; selected **2 tests,0 pass,2 fail**. Success
   expects B but gets undefined; failure expects null error but gets A's error.
2. **Source-confirmed dialog auto-close defeats failure retention.** Page uses
   AlertDialogAction onClick=confirmDelete without preventing default. Local
   wrapper passes through Radix Action, whose installed implementation renders
   DialogPrimitive.Close; Close composes the handler with onOpenChange(false).
   The page then cancelArchive()s immediately on close, before async completion.
   This is actual installed dependency behavior, not a live DOM/browser claim.
   Controller-only failure tests miss the page boundary. Prevent automatic close;
   current server-confirmed archive controls success closing, current failure
   must retain the open dialog and target.
3. **Source-confirmed missing form/session lifetime integration.** Page's awaited
   submit success unconditionally closes and resets form/editingCourse, while
   openCreate/handleEdit can establish a newer target during that request. No
   target incarnation is passed back to that callback. Session notification
   clears controller list/options/delete target but leaves page-owned form,
   editingCourse, selectedCourse and detail dialog from the previous scope.
   readPrincipal includes id/role only, missing same-user session/scope replacement.
   Fence actual available canonical session and form/target lifetimes inside
   owned page; test production decisions used by it, no shared auth/API changes.

**Decision: not accepted.** Created bounded correction
client-m2-02-dialog-target-lifecycle-20261018-02 only after original reported and
stopped; same four056 paths and approval provenance. One ready, no active/blocked
after preparation. Codex did not claim or edit worker production/test files.
WorkBuddy: resolve these original acceptance gaps, preserving correct work. Cover
success/error/busy/finally, A→B→A targets, cancel/reopen, current failure+retry,
newer form survival and session/logout invalidation without automatic replay.

## Replies and limits

Archive copy is correct; keep it, do not restore false permanent-delete language.
subscription_id gap remains documented; neither removal nor a backend contract
change is authorized here. Infinity is truthy under parseFloat(...)||0, not0;
correct reporting while keeping valid refusal. Existing min0 UI justifies the
nonnegative validation; do not invent financial policy. OTP stays deferred060.

Schedule continues for acceptance correction; no429/new human blocker. Task Ready,
last timer result0, next18:45:09 Cairo, STOP absent. M1/039 and M2-01/055 closed;
no later batch authorized. Clear only this matching pending marker:
queuedAtUtc2026-10-18T15:30:10.9136393Z.
