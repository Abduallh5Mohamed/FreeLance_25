# Resumed review: reservations unchanged; partial Barcode rendering regression

Review UTC: 2026-10-16T18:01:16Z. Branch verified: `codex/human-client`.
Read coordination README, worker/012 and supervisor/017. The explicit human
resumption in 017 keeps periodic observation/coordination enabled despite the
already disclosed original-session visibility issue. It does not resolve ownership.

## Native evidence and schedule

- Consumed worker/012: coordinator acknowledges it cannot inspect/contact the
  original-session owners; hourly pause control was not exercised. No new native
  run mapping, checkpoint, termination evidence or 429 was reported.
- Read only exact task JSON files, selecting sanitized fields. Both
  `client-m1-barcode-scope-20261016-03` / `wb-barcode-scope-03b` and
  `client-m1-edit-completion-20261016-01` / `wb-edit-completion-01a` remain claimed.
  Heartbeats remain at 16:33:14Z; neither has a checkpoint or result JSON.
  This is mailbox evidence, not native liveness or termination evidence.
- All four reserved source/test hashes equal checkpoint 016. Comparing all scoped
  hashes against stable 011 finds only BarcodeAttendance.tsx differs.
- Windows task is Ready; last run 21:00:10 Cairo, result 0; next 21:15:09.
  This queued review actually arrived. No new hourly schedule verification is
  available beyond coordinator messages; do not infer continuous worker activity.

## Source review: required correction within the existing Barcode task

The partial production controller adds scope reset/invalidation and explicit
`PaymentAvailability = 'paid' | 'unpaid' | 'unknown'` plus unavailable attendance.
These changes are not accepted or independently tested as a completed submission.

The absent-students rendering still consumes those new values as old booleans:

- BarcodeAttendance.tsx:1267 assigns the string to `hasPaid`; lines 1294-1304
  use truthiness for the badge and payment action. Both `'unpaid'` and `'unknown'`
  are truthy, so they render as paid and suppress the unpaid payment action.
- Lines 1275-1281 still branch on `_attended` without handling `_unavailable`.
  The controller's failed previous-attendance read produces `_attended: null`,
  `_unavailable: true`; this renders as confirmed nonattendance.
- Missing last-attendance data also needs to remain distinguishable from a
  verified empty successful read; do not infer historical absence from failure.

Required for the existing owner when reachable: finish BOTH table consumers using
explicit payment states and attendance availability, preserve the existing payment
policy/actions for verified paid/unpaid states, and show unknown/failed reads
honestly. Never treat unknown as paid, unpaid, or authorization for a mutation.
Add isolated production-path coverage of paid/unpaid/unknown and
present/absent/unavailable rendering decisions using the actual code consumed by
the page. Preserve all original loader/race acceptance checks in 010. This is a
finding within the already claimed task, not a replacement task or permission to
edit around its owner.

EditExam's new-question upload completion still sets current draft and toast after
await without operation-generation/target checks (around 891-905); task 011 remains
required. Its source and test are unchanged since the prior review.

## Verification limits and decision

No source/test/claim edits, replacement workers, retirement, new task or acceptance.
No live services or backend/shared changes. Tests/types were not rerun against this
unreported partial owned tree. Last stable independent evidence remains 239/239
tests and zero scoped type diagnostics with 11 preexisting outside-scope errors;
that evidence predates the partial Barcode change and is not validation of it.

WorkBuddy: acknowledge 017/018 at the next permitted hourly check. If original
owners become reachable, relay these findings through their real native session;
otherwise provide only genuine new status or termination evidence. Do not repeat
the already rejected cross-session message probe or infer termination from age.
The original-session operator path documented in 016 remains the recovery route.

Finite remaining set: completed Barcode correction including the actual consumers,
completed EditExam save/upload lifecycle correction, then stable consolidated
original-checklist verification. M1 remains incomplete. Existing narrow contract
limitations and accepted corrections remain as recorded; no M2 or scope expansion.
