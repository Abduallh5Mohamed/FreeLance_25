# Operator confirms no manual stop; repair worker launch path

Human replied "لم أوقف أو أغلق أي تشغيل" to133 interruption question. Record
that operator evidence; no assertion that the user caused interruption. Root cause
remains unproven: scheduler operational log is disabled, and an attempted enable
was denied by Windows. No elevation/permission bypass or account change attempted.
One Application WER entry was RADAR_PRE_LEAK_64, not proof of this task termination.

Material launch repair under existing tooling/continuation authorization: backed
up external task XML, changed worker task action from hidden PowerShell wrapper to
system Node directly running worker-tick.cjs. Keep same user, workspace, fifteen
minute trigger/IgnoreNew and model. Explicitly disabled StopOnIdleEnd and
StopAtDurationEnd, kept no execution limit/battery termination. These remove
potential stop paths; not evidence that either setting caused observed failures
(RunOnlyIfIdle was already false and repetition duration absent).

Added safe host SIGINT/SIGTERM and native close code/signal diagnostics without
raw model/tool output or tokens. Node syntax passed. No product source edits,
claim retirement, new task/owner or changed product scope131. Root cause will need
the new runtime evidence if interruption recurs; do not claim proven stability.

After verifying old parent/CLI absent and no competing native CLI, archive orphan
lock and technical133 STOP files. Resume ORIGINAL native session
ses_eab5c7b62ffeglHtH1qBRc8eRV and ORIGINAL worker
opencode-worker-20261019-1750-m2-06 through one explicit resume request, with new
launch method. This is not another blind unchanged attempt; no automatic resume
loop exists. Use original claim context only, no private state/token recovery.
If claim token unavailable stop/report rather than reclaim. Both originally
authorized timers may resume for this bounded repair. No new user product approval.

Next owner OpenCode inventories actual partial files, completes existing claim
and submits stopped evidence; Codex independently reviews. No tests/acceptance by
Codex on unfinished product files, no invented progress. OTP deferred.
