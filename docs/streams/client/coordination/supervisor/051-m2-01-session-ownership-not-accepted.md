# M2-01 correction reviewed: replacement session identity is still removed

UTC: 2026-10-17T19:47:53Z. Branch `codex/human-client` verified.
Consumed worker032 and actual sanitized result/checkpoint for
`client-m2-01-mutation-lifecycle-20261017-02`, worker
`wb-m2-01-mutation-lifecycle-02a`. State reported at19:41:17.662Z;
report protocol requires stop. Initial dispatch active=[], ready=[], blocked=[].
No native session/run mapping available; worker ID is not a native run ID.

Independent checks on the reported source: all client tests **395/395 pass**;
supervisor049 production race probes **2/2 pass**, confirming those fixes.
Frontend tsc still reports11 outside diagnostics, zero scoped diagnostics;
overall type check is nonzero. No live/browser/DB/network validation.

## Remaining verified defect — not accepted

In `workflows.ts`, StudentSpaces `discardStoredIdentity()` removes both identity
keys unconditionally. After rotationA, let its profile read wait; replace the
session with B and persist B's identity. Both a late successful A profile and a
late failed A profile remove B's `currentStudent` and `currentStudentSpace`.
The successful branch detects token mismatch but still deletes the newer owner.
The failure branch does not test token ownership before cleanup. Retry mismatch
branches also call the same unconditional cleanup and require the same audit.

Independent reproduction outside the repository:
`C:/Users/BaraaWael/TabwebClientSupervisor/051-m2-session-ownership.mts`.
Uses the actual production controller with deferred transport and injected memory
storage, no duplicated orchestration. Two selected tests, **0 pass / 2 fail**:
resolve and reject both produce undefined instead of the replacement identity.
Existing token-mismatch tests miss this because they do not preserve a new owner's
valid identity. This is a concrete acceptance failure, not a request for new policy.

Prepared `client-m2-01-session-ownership-20261017-03` only after predecessor
reported/stopped. Same seven047 paths and human approval provenance. One ready,
no active/blocked tasks after preparation. Codex did not claim or edit production
source/tests. Preserve all correct existing fixes and dirty M1 work.

WorkBuddy: fence every storage cleanup/write and retry by actual session ownership;
obsolete operations must not erase B, navigate, or expose old pending actions as
current. Preserve genuine own-rotation profile-failure cleanup and profile-only
retry. Cover success/error, retry before/after await, logout, replaced identity
and reversed completion. No restoring an old token or shared API/session edits.

## Replies to worker032 questions

- Already completed server-accepted submitted/resetSent facts may remain across
  identity change; pending work must be invalidated. Clear on route change as now.
- Fencing obsolete activation is sufficient; no invented abort transport required.
- Join's cached identity comparison only changes through the session bus. A silent
  storage/session replacement can therefore escape it. Use the existing injected
  reader at completion and/or relevant storage events inside owned pages; test the
  actual boundary. An outside shared listener is not required to fix owned code.
- No per-keystroke form generation requested. Fence route/session incarnations,
  retain input on current failure, and prevent stale completion from changing the
  current target. No extra framework or unrelated refactor.

M1 remains closed under039. Only M2-01 remains authorized, not the whole M2 or a
later batch. Schedule continues: this bounded correction can proceed without a
human blocker; no429 observed. Hourly WorkBuddy check remains expected, not proof
of a running worker. Clear only this review's matching pending marker.
