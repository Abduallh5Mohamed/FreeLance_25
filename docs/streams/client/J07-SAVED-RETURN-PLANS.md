# J07 — owner save/recovery and student panel

BUILD-61 mounts the original return workbench in /teacher-workspace under responsible-teacher authority. Parent selectors lock during saving/uncertain/recovery, preserving original intent/GET semantics. New follow-up reads current saved plan/catalog completion; expired/hidden/error/session changes clear displayed data, unavailable steps expose position only, withdrawn plan never falls back. No started/finished/inferred understanding claim.

BUILD-46 verifies actual synthetic-demo MySQL/Chrome owner evidence/review/save,
student dashboard read and owner withdrawal/student refresh, including lost POST
acknowledgement followed by page reload and GET-only recovery. A visible count
summary keeps all five attendance states separate; no diagnosis is inferred.
On confirmed save plus failed marker cleanup, the receipt remains visible but
savePhase stays uncertain/locked. Failed GET must preserve that confirmed receipt;
successful matching GET plus cleanup unlocks. No intervening save/withdraw/load
can replace the marker. See [BUILD-46](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-46.md).

BUILD-38 extends the existing owner return-draft UI. After fresh explicit review,
the owner can save and make the active plan available to its authorized learner,
or withdraw the current read version. Storage-unavailable metadata disables writes.
The expected version comes from the bound read snapshot; a conflict drops approval
and requires fresh evidence. No write is inferred from merely reviewing a draft.

Each write first stores a minimal sessionStorage intent scoped to owner/course:
operation UUID, expected result version/status and optional existing plan UUID.
No token, student ID/name, attendance, estimates or plan contents are persisted
in this marker. Failed marker write prevents any request. On reopen, an unresolved
marker freezes conflicting actions and offers only GET receipt reconciliation.
Malformed/missing/server/timeout write replies preserve uncertainty. Missing or
failed status is not proof of rollback. No automatic write replay or new key.

Confirmed outcomes survive marker-cleanup failure and later refresh failure; the
UI labels the receipt historical and displays the head only as of its check time.
It never claims an old list updated or a notification delivered. If a definite
rejection cannot clean local storage, the UI conservatively retains reconciliation
state. Broken/unreadable recovery storage stops further writes until resolved.

Owner parent scope/date/paging/step changes and close handlers are frozen during
saving/uncertain/recovering, including the enclosing course dialog. Its aggregate
lock combines template and return-plan writers so either child's unlock cannot
discard the other's pending context. A beforeunload warning is best effort;
the minimal marker is what permits later read-only reconciliation. Session loss
clears private in-memory data and takes precedence over navigation retention.

`StudentReturnPlans` is mounted inside StudentDashboard after the existing page's
student proof. It reads only the current selected workspace; the principal reader
also fences same-token workspace changes. Pages replace rather than accumulate.
Session/storage/error/deadline/supersession invalidates old rows. No student plan
data is stored in browser storage.

The panel displays the current published course, version and at most three steps.
Denied steps have no title/lesson identity. Titles remain text nodes. The generic
link opens the existing `/student-content` page; it is not a source URL or access
fallback. The UI distinguishes teacher estimates and existing lesson completion
from measuring understanding or recording whole-plan start/finish.

There is no external notification, family delivery, automatic completion, durable
offline editing, content grant or model/provider. Actual schema/browser/device/
field-usefulness acceptance remains separate from local source tests.
