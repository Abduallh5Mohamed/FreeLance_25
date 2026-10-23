# 205: OpenCode same-session recovery verified; both lanes continue

During review204, OpenCode had made a real checkpoint on correction202 then its
native host/child disappeared without a report. Runtime verification found zero
OpenCode executable processes, absent hostPID12360 and childPID14632 reused by
svchost. The old running.json was therefore stale process metadata, not a busy
worker. Task/claim/session were preserved; no retirement or second owner.

Routine recovery201/138 repaired the infrastructure guard: a stale lock is
archived only when no OpenCode executable exists and its age exceeds two minutes;
same-owner recovery additionally accepts exact task/worker/session verified
process-disappearance evidence. Mismatch, live process, unverified termination,
wrong owner/session and ordinary active work remain fail-closed. Three recovery
tests pass. No model/account/permission/source/product change.

OpenCode resumed SAME session ses_ea437171fffenxSMWiUBqlyBbD, SAME worker
opencode-m2-12-canonical-dto-correction-20261021 and same claim. New native host
PID21400 owns actual opencode.exe PID2180. It continues202 exact3 paths.

WorkBuddy task M2-13 remains separately claimed by
workbuddy-native-m2-13-periods-20261021. Both are disjoint and active; preserve
owners, do not redispatch. Codex next check remains17:50:19 Africa/Cairo subject
to machine/app availability.
