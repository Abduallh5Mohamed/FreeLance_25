# J08 — Question workbench UI, BUILD-42

`ManualGrading.tsx` mounts a collapsed `QuestionGrading` panel alongside its
existing legacy grading screen. Opening the panel does not fetch private data.
The explicit read action starts exam → published version → essay question →
ten anonymous answers. Pages replace the current page; they are not an export.

The owner chooses an answer, reads the pinned question/maximum/explanation,
enters a full decimal score and optional feedback, and saves one revision.
Ctrl/Cmd+Enter is a shortcut for the same validated save. No automatic advance,
auto-zero or inferred rubric. Unsupported answer payloads cannot be graded by
this panel. React renders answer/question text as text, not injected HTML.

The separate attempt review action reads completeness/total and a fresh opaque
token. Finalization needs that complete preview and an explicit confirmation.
Question save does not finalize an attempt; finalization does not publish a
family report. Gradebook linkage is displayed only when confirmed in receipt.

`question-grading.ts` uses authenticated relative no-store API calls, strict DTO
projections/target checks and scope/principal/epoch/deadline fences. Session or
identity changes erase the displayed answer and private draft. Loading disables
row actions; unknown writes block navigation and further writes.

Before sending a POST, sessionStorage records only an operation UUID, attempt
UUID, optional question UUID, kind and expected result version, keyed by account.
No scores, feedback, answer text, auth/review tokens or names are persisted.
Storage refusal prevents a write. Reload restores an uncertain state and only
GET recovery is offered. Timeout, invalid/missing/mismatched receipt and unknown
failure do not create a second operation automatically.

A confirmed receipt is historical evidence. The old answer page is hidden and
an explicit refresh is needed for current data. Refresh or marker cleanup
failure does not relabel confirmed saving as failure. Cleanup failure blocks
further writes until reopening and reconciling the stored operation. A corrupt
marker/storage failure remains blocked; no unsafe automatic cleanup is offered.

Local tests exercise the actual panel hooks/callbacks and canonical transport,
including one lost POST followed by GET recovery and hiding data on session
change. They are not real browser/device/accessibility or MySQL acceptance.
Grader assignment, rubric and post-final reopening remain unfinished J08 work.
