# Separate worker lifetime from scheduled launcher

Reviewe06f5e46-3dd2-44e0-a7dd-bb3ca26f1c2f,2026-10-19. Correction still claimed
by opencode-worker-058, no stopped report/checkpoint or file changes since137.
Native23756/host26536 absent; last-check remains running and no native-close/host
signal diagnostic was written. Later scheduled lock skip exits0, not healthy work.
No new quota/tool rejection found in recent sanitized session metadata. Preserve
claim/source; no stable review/tests/acceptance or replacement worker.

Human138 authorizes bounded autonomous runtime repair. Direct long-running task
action134 did not prove stability. Existing desktop local endpoint found but
health request returned401; no credential files/auth bypass attempted. Instead,
change task to a short hidden local launcher using documented Win32_Process.Create,
separating worker from scheduler/console job lifetime. Process uses same current
user and working directory, no elevation/new account/service/provider/listener.
Hidden detached/breakaway process flags avoid inheriting the scheduler/provider
job lifetime. Root terminating actor is still unknown; this is a materially
different hosting path, not a claim to have proven the original cause.
https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process

Launcher preserves STOP/lock/native-process ownership; it never clears a lock or
reclaims a task. Worker retains its existing exclusive lock, exact validated resume
request, safe diagnostics, approved model, claim and permission138. After verified
old host/CLI termination, archive orphan lock and continue SAME native
ses_eab38a35fffeQZr5bVWUx2zP7g/SAME owner058 once on the changed host path.
No automatic resume loop or model/account/permission workaround, no product edits.

Next owner OpenCode completes136 fixes then native checkpoint/stopped report.
Codex independent review follows. Both timers continue normal coordination; no
arbitrary extra code tasks, no per-batch stop, OTP deferred. If the hosting change
fails, preserve exact Windows result/ownership rather than fabricate liveness.
Remove only this review's matching marker.
