# J08 — teacher and assigned-grader workbench

BUILD-60, 9 November2026. [Server authority contract](../server/J08-TEACHER-GRADING.md).

`/manual-grading` keeps the existing pinned-question workbench. Responsibility is
the current course teacher; neither Tabweb business administration nor center
ownership grants grading. Existing route capability rules already exclude
platform administrators; backend row proof remains authoritative.

- Responsible teacher selects their own exam/version/question, saves rubric
  revisions, explicitly selects an active teaching account and a saved rubric,
  then confirms assignment/transfer or revokes it. Current authority is shown
  separately from stored assignment status after a course handover. Candidate
  selection grants no account, general teaching membership, finance or platform
  rights; eligible memberships must already exist.
- Assigned grader opens “الأسئلة المسندة لي للتصحيح”. Only live assigned questions
  and pinned criteria are listed. Each answer remains anonymous. Every criterion
  must be scored; the server computes the total. Current saved revision/points
  are displayed after refresh. Unsupported answer types never open files or a
  provider. There is no finalization/reopen control for the assignee.
- Teacher finalizes using the existing fresh whole-attempt preview and CAS.
  A separate result-management panel lists own-course final results with student
  name, score and timestamp, previews withdrawal, requires a reason and explicit
  confirmation, then returns the final to pending. Names are not added to the
  delegated answer page. Customized or unproven gradebook projections fail closed.

Strict adapters reject extra/private fields, malformed criteria/identities,
wrong totals and mismatched receipts. New work/control intents are one verified
sessionStorage record per actor with opaque IDs/kind/version only. All mounted
control panels synchronize that marker; duplicate submissions check storage
before any request. Unknown response preserves the marker and locks writes;
reload recovery uses GET only. Confirmation remains confirmation if list refresh
fails; stale data is hidden and failure reported. Cleanup failure keeps the lock.
No automatic resubmission or unlock when a receipt is absent.

Whole fetch/body deadlines are25seconds, including transports ignoring AbortSignal.
Principal/session/storage changes abort and clear private data. Scope generations
fence late reads and post-write refresh. Assigned answer display clears after60s,
background/focus, and needs a fresh explicit selection; this is not instant
offline revocation. Teacher resource authority is rechecked on every operation.

Two Chrome rounds exercised actual committed assignment/reopen/criterion-grade
writes with lost ACK, reload and receipt recovery, one POST for each tested
operation. The final round used the responsibility-bound assignment. Final
teacher approval and real SQL agree on one8.00 projection. Native platform-admin
navigation does not mount the academic workbench. This is synthetic local
evidence, not educational consistency, real devices, load or production acceptance.
