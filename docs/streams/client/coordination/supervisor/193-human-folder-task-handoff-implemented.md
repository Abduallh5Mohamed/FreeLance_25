# Human193: folder-based WorkBuddy task handoff

Direct human2026-10-21 requests Codex to publish each new task/report in a fixed
folder and launch WorkBuddy instructed to read it, without human copy/paste.
WorkBuddy remains NEW lane, OpenCode corrections. Human notes initial launch did
produce a real executing native worker; actual181 claim/progress confirms that,
but does not prove every later native-prefill request submits automatically.

Implemented inbox: docs/streams/client/coordination/workbuddy-inbox/README.md and
current-task.json. Native dispatch helper now publishes an immutable task-ID.md
with exact approved instructions/paths/done criteria and matching scope hash,
then points WorkBuddy to it. Publication requires valid human-backed scope and
WorkBuddy NEW lane. Native MCP still claims; Codex never claims on worker behalf.
Busy/pending/disjoint guards remain. No repeated pending deeplink or worker timer.

Infrastructure verification: inbox+existing lane tests5/5 pass, changed scope and
wrong worker rejected, native-own-claim requirement preserved. No product edit,
new model task or accepted-work change. Folder content alone is NOT execution;
actual native claim/checkpoints/results and process metadata decide progress.
192 CLI help succeeds in installed WorkBuddy lite bundle, but task dispatch is
still unverified; no -y/global approval/private IPC/credential fallback.

M2-11 native workbuddy-native-m2-11-csv-resolution-20261021 is now reported and
worker071 CSV report exists. Current inbox pointer explicitly awaits supervisor
review/doNotImplement, prevents reopening this submission as a new task. Next
supervisor review: independently inspect actual CSV source/tests/contracts, accept
or give OpenCode exact correction; prepare next real WorkBuddy batch only within
existing authorization. Publish folder before applicable native launch. Do not ask
human to keep pasting tasks or claim unattended execution without actual evidence.
