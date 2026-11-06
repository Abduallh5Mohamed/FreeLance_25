# J02/J03 — student catalog quiz UI (BUILD-26)

Local implementation; real schema/database/browser/load acceptance remains open.
Backend authority: [durable attempts](../server/J03-CATALOG-EXAM-ATTEMPTS.md).

## Mounted journey

`StudentContent` already mounts `StudentLessonActivities` only for accessible
lessons. Its authorized quiz detail now mounts `StudentCatalogQuiz`, keyed by
course/lesson/content. Opening it performs catalog GET recovery, followed by the
guarded attempt GET only when an existing attempt is returned. It never POSTs
on mount. The explicit start button explains that the timer starts and the
exam/enrollment attempt allowance does not reset.

Quiz list/detail metadata now use `launch_status: attempt_required`. This is a
candidate for fresh server proof, not an eligibility/readiness guarantee. A pin,
valid snapshot, actual schema and current authority remain mandatory on the
attempt endpoints. Homework was `unconfigured` in BUILD-26;
[BUILD-28 homework UI](J03-STUDENT-CATALOG-HOMEWORK.md) now uses the separate
`submission_required` candidate with actual upload gates still closed. Old quiz `unconfigured`
responses are understood without mounting the launch UI. Unknown status values
and a homework quiz-launch status fail strict parsing.

The canonical transport carries the bearer in headers, uses no-store and accepts
only catalog selectors for start/recovery. It sends no tenant, enrollment, source
exam or version selectors. Existing guarded attempt endpoints handle reading,
autosave and submit. There is no legacy exam redirect, auto-enrollment, copied
grading engine, upload/provider activation or automatic lesson completion.

## Answers, timing and writes

Strict fixed DTO parsers reject answer keys/private extra fields, wrong attempt
IDs, malformed UTC dates, duplicate questions/positions, unknown question kinds,
oversized/invalid answers and unsupported references. At most 200 questions and
128 KiB of canonical answers are accepted. Questions render as escaped text;
single choice, multiple choice, true/false and essay use their existing engine
answer representations. Null is an explicit answer clear, never an omitted
autosave key. Essays are capped at 10,000 characters. No student answer is stored
in localStorage/sessionStorage or logged by this flow.

The server-recorded deadline is displayed in device timezone. Device clock or
UI state does not grant or extend server time. No automatic final submission or
fabricated local grade. Pending manual review has its own label and never shows
a final grade. Expired/graded states disable editing and cannot start anew.

Edits trigger a two-second debounce to the existing autosave endpoint. Explicit
save is also available. Writes are single flight; editing/submission is disabled
during a request. The payload is copied before sending, and a strict matching
acknowledgement is required before saying saved. Final submission needs a checked
review confirmation and a separate button. A confirmed start/submit followed by
a failed read remains a confirmed write with unavailable details.

## Uncertainty and session lifecycle

Unknown write outcome, timeout, transport failure or malformed acknowledgement
stops writes and automatic replay. The student can explicitly inspect server
state using catalog recovery. If the same in-progress attempt has unsaved local
edits, they remain dirty beside the freshly read server baseline; recovery does
not rearm autosave. The student deliberately saves those edits or chooses server
answers. If the server is terminal, saved answers/status replace the local edit
view. A known attempt cannot become a fresh-start offer from an inconsistent
null response. Explicit server unavailability has a separate message.

Timeout is 20 seconds; aborting transport does not prove rollback. Late replies
are fenced by controller generation, current principal/session incarnation and
disposal. Auth/workspace events and cross-tab storage changes clear private
questions/drafts and retire the controller. Revoked access does the same. The
component is disposed on target change/unmount. There is no automatic write on
reopening or reloading; recovery reads persisted server answers only.

Unsaved edits remain in memory. The UI warns that closing details discards them,
and beforeunload warns for dirty/busy/uncertain state. This does not promise
durable offline edits or a comprehensive SPA navigation blocker. Other tabs can
still race the existing answer ledger: this slice does not add per-answer
revision/CAS or a new multi-device conflict policy. Read-only recovery can touch
the original attempt GET expiry behavior; catalog recovery itself is pure GET.

## Evidence and limits

22 new parser/controller/transport/actual-TSX tests plus 12 activity tests pass.
The TSX tests execute actual effects and answer/save/submit callbacks with
synthetic fetch and hook/SSR fixtures. They verify initial read-only recovery,
canonical writes, escaped input types and session cleanup; they are not a real
browser run. No new browser package was installed. Backend catalog/proof and
original exam engine suites remain required after the metadata contract change.
Real schema, MySQL isolation, browser/device, timing under load and performance
acceptance remain separate. Existing large Vite chunk warning remains.

Homework context and conditional student UI are now implemented locally in
BUILD-27/28; actual schema/storage/browser acceptance stays open. Next package
work is the announcement/audience boundary. Do not repurpose an assignment or lecture ID as a catalog
lesson ID. Other J00–J10 journeys stay in the execution queue.
