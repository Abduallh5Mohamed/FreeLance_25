# EditExam follow-up: operation authority must be captured, not inferred later

UTC: 2026-10-16T19:31:51Z. Branch verified `codex/human-client`.
Read coordination README and new worker/018 plus sanitized actual result for
`client-m1-edit-target-lifecycle-20261016-01`. Worker `wb-edit-target-lifecycle-01a`
reported/stopped; dispatch active=[], ready=[], blocked=[] before this review's
new task. No fabricated native IDs; coordinator reports no native mapping available.

## Independent verification

Existing managed Node22.22.2 + tsx, all seven `src/tests/*.test.ts`: **304/304 pass**.
Full tsc exits nonzero with the same **11 outside-scope errors, zero scoped**.
No source/test edits by supervisor, live-service claims, installs or Git writes.

Read actual operation tracker, state/token types, lifetime boundary handlers,
delete handler and upload commit sinks. Source shows draft/editor lifetime
generations and completion ordering for both failure and success now present.
List deletion uses the save single-flight guard. Preserve those corrections.

Worker accurately disclosed that the old external draft reproduction omitted the
new generation fields. Refreshed external harness with actual production fields
and boundary increments; do not accept missing-field fail-closed as proof of
real lifecycle behavior. Both original counterexamples now pass meaningfully.

Added a third isolated test to the same OUTSIDE-repository reproduction:
`C:/Users/BaraaWael/TabwebClientSupervisor/edit-lifecycle-review.mts`:

1. Start editor upload for q1, editFormGeneration=0.
2. Close editor: editingQuestionId=null, editFormGeneration advances.
3. Resolve the old upload.

Expected superseded/no commit. Actual **committed**. Refreshed external run:
**3 tests, 2 pass, 1 fail**, calling the actual exported production lifecycle with
deferred transport and sinks. No production logic duplicated in reproduction.

## Root cause and decision

`isEditExamOperationCurrent` returns true for ANY question target whenever the
CURRENT editingQuestionId is null. Thus an operation that started as editor
save/upload becomes list authority after the editor closes, bypassing the form
generation entirely. Upload commit may still toast; save may reload stale editor
completion. The existing null-safe image setter does not fence those other sinks.

This is the explicit 023 requirement to separate list-delete authority from edit
identity; the implementation inferred authority from completion-time UI instead
of capturing operation kind at start. NOT accepted.

Prepared new approved continuation `client-m1-edit-operation-kind-20261016-01`
after predecessor reported/stopped. Same two allowedPaths ONLY: EditExam.tsx and
m1-expanded-exam-authoring-ui.test.ts. Ready via sanitized dispatch; Codex did not
claim/start a worker. Other claims and accepted corrections unchanged.

WorkBuddy: pass immutable explicit operation kind/authority from actual handlers,
prefer distinct list-delete/edit/new/details types. Editor operations always
require captured target AND form lifetime, even with no editor currently open.
List deletion must still allow proper server outcome/reload without any editor.
Never reclassify an in-flight operation based on current UI. Add success/failure
deferred production tests after editor close/reopen/switch plus normal allow and
list-delete tests, using real lifetime generations. Preserve ordering, single-flight,
route ABA, draft generations, failed-input retention and canonical auth. No
global weakening of guards or unrelated refactor; no backend/shared/router/package/
config edits, billing/calendar policy changes, new features or M2.

Finite next step: this operation-authority correction, then consolidated stable
original-checklist verification. Existing 304 green tests alone do not close this
reproduced gap. No artificial duration, invented new work or self-acceptance.
No 429 or new human-intervention blocker; user-authorized schedule continues.
