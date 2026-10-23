# M2-01: identity-erasure fix verified; Join recovery remains incomplete

UTC: 2026-10-17T20:31:33Z. Branch `codex/human-client` verified.
Read M2-HANDOFF, coordination README, new worker033 and actual sanitized report
for `client-m2-01-session-ownership-20261017-03` (reported20:15:40.841Z), worker
`wb-m2-01-session-ownership-03a`. Initial active/ready/blocked arrays empty.
Report protocol requires stop; sessionId=null, no native run mapping available.

## Independent verification

Managed existing Node22.22.2 + local tsx, no installs or live services:

- All client tests **401/401 pass**, no failures/cancellations/skips.
- Exact supervisor051 selected replacement-identity probes **2/2 pass**; this
  verifies the formerly failing resolve/reject counterexamples independently of
  the worker's aggregate40/40 claim.
- Supervisor049 mutation race probes **2/2 pass**.
- Frontend tsc: same11 outside diagnostics, zero scoped diagnostics; overall
  exit nonzero. Outside files remain NotificationBell, StudentHeader_OLD_BACKUP,
  ExamReports, ExamResults, Fees, StudentBarcodes, StudentDashboard, versionChecker.

Reviewed actual page diffs/controller integration and current production cleanup,
commit/retry/Join identity code. StudentSpaces now compares captured identity
baseline before removing keys, preserving newer storage, and retry mismatch no
longer deletes it. Own-rotation profile-failure cleanup remains covered. The051
identity-erasure counterexamples are fixed; no request to rewrite those paths.

## Remaining demonstrated original lifecycle defect

Join `isMutationCurrent` now reads the actual principal at completion. When a
silent replacement occurs, submit/reset return blocked before patching busyKind;
finally releases the guard but leaves busyKind='submit'/'reset'. The page disables
controls from this state, so the operation has settled but the UI remains busy.
The cached principal also remains old, so a deliberate next operation can still
be classified obsolete. Worker tests assert no stale success but omit recovery.

Independent production probe saved outside repository:
`C:/Users/BaraaWael/TabwebClientSupervisor/054-m2-join-busy.mts`.
Imports the actual controller with deferred fixture transport; two selected tests,
**0 pass / 2 fail**. Both switch the injected principal during an operation and
resolve it; both assert no stale success, then expect busyKind=null. Actual values
are submit/reset. Later current-session retry assertions cannot be reached until
the stuck busy failure is corrected. This is not a new product requirement:
049 already required session invalidation across success/error/busy and protected
old-finally handling.

**Decision: not accepted.** Prepared bounded correction
`client-m2-01-join-session-recovery-20261017-04` after predecessor reported/stopped,
same seven047 paths/provenance. One ready, no active/blocked after preparation.
Codex did not claim or edit worker-owned source/tests; all dirty work preserved.

WorkBuddy: reconcile actual principal at operation boundaries and fully retire
obsolete busy work without clearing a newer operation's state. Cover silent
replacement during submit/reset success AND failure, replacement before starting
an operation, and a deliberate current-principal retry without reload or bus event.
No automatic replay. Preserve form input, accepted terminal facts, route/dispose
guards, single-flight and all working049/051 fixes. No new shared transport or
session listener module; existing owned seams suffice.

Replies to worker033: no cosmetic tenant test expected; tenant redeem has no
session-identity surface for this defect. Fencing remains sufficient without a
new abort contract. Those limits do not justify leaving the current UI busy.

M1 remains closed under039. Only M2-01 approved, no later batch/M3. No live DB,
network, browser, provider, backend/shared/schema/package edits or Git writes.
No429 or human blocker observed. Schedule Ready, last result0; next23:45:09 Cairo.
Continue bounded correction, clear only this review's matching pending marker.
