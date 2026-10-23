# M2-06 interrupted host; preserve same owner/session

Review1b68120f-7d5d-4c5f-8b9b-66e11e69e477,2026-10-19. Task claimed by
opencode-worker-20261019-1750-m2-06. Sanitized checkpoint says inventory complete,
implementing five131 paths; no stopped submission/worker report after056. No code
acceptance, stable-source review or tests while ownership remains active.

Actual interruption evidence: Windows task Ready with last result3221225786 /
0xC000013A; old parent pid16664 and CLI pid7340 both absent, no replacement native
CLI found. Last-check still running for native ses_eab5c7b62ffeglHtH1qBRc8eRV.
Task has no execution time limit/battery stop configured. Scheduler operational
history unavailable; cause/actor unknown, no age-based retirement or invented
continuing model liveness. Preserve claim and all partial code.

Authorized dispatch repair under131: one explicit continuation of SAME native
session, SAME existing worker/claim, only after verified prior host termination.
No new worker/task/claim, token read/private state recovery or ownership transfer.
Resume request is nonsecret session/task/worker metadata. Native OpenCode may use
its original token from its own existing conversation; if unavailable it must
stop/report, never inspect private claim files or silently reclaim. Inventory
actual partial disk before continuing; no rewrite. Model/account unchanged.

Worker wrapper now consumes one supervisor-authored resume request only when
sanitized active task/worker match exactly. It does not auto-repeat interrupted
claims. Also repaired a metadata bug: second write to running lock fd appended
JSON; rewrite by path now keeps a valid single JSON record. That bug explains
malformed diagnostics, not the original host interruption. No product source
edits by Codex or stable submission invented. Current scope unchanged131.

Next owner OpenCode resumes/finishes/reports existing claim, or reports exact lost
context blocker. Codex then independently reviews real stable source/tests/types.
Both timers continue; normal overlapping checks defer. No per-batch STOP or new
scope, OTP deferred. Remove only this review's matching pending marker.
