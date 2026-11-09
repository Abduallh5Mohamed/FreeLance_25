# J05 — selected group/window learning evidence

BUILD-48 adds explicit clipboard export of teacher-selected tags only: current
group/window/read time, eligible attempt count and per-tag answer counts. No
question text/IDs, answers, source IDs or learner identity. No copy for insufficient
data or no accepted tags. UI/controller single-flight, 10-second deadline and
principal/epoch/disposal fences prevent stale success; selection/window/refresh
clear its proof. Clipboard denial is not success; a write already delivered to
the OS clipboard cannot be revoked by the controller. No automatic persistence
or sending. Actual synthetic Chrome tests cover copy projection, changed window,
insufficient data and source withdrawal. See
[BUILD-48](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-48.md).

The keyed `LessonLearningEvidence` panel is mounted beside the existing source
preparation panel after choosing a lesson. Uses only the canonical authenticated
no-store reader. The group picker is one page of 25 and has first/next controls;
only a loaded group can be queried. Both day inputs explicitly use UTC midnight,
with the end day excluded. A 31-day maximum is checked independently of HTML.

Loading/page/cohort/window changes remove the previous data and local use/dismiss
decisions; superseded requests are aborted. Read errors do not retain stale
statistics. There is a 25-second deadline and session/storage/silent-principal
fencing on results/errors; child invalidation also hides the outer chosen-lesson
picker. Closing/unmounting retires the request. No result/storage survives reload.

The UI names these suggestions **question tags**, explains the minimum five final
attempts, >=40% non-fully-correct rule, ranking, overlapping denominators, excluded
manual/pending data and current-membership/current-pin boundaries. It distinguishes
insufficient evidence from available evidence with no suggestion.

Each suggestion opens inline authorized question previews from the timestamped
read. First five previews and 1000-character stem maximum are disclosed. Opening
that details element is not a fresh authorization/read; the user can explicitly
reload the same cohort/window. No answer keys, learner names or raw answers are
available. Titles/tags/stems are text nodes and remain escaped.

Use/dismiss choices are explicitly memory-only, clear on new evidence/context,
and do not persist grading changes, notifications or learning plans. Recurring
support questions, manually graded-answer evidence, validated pedagogical concept
mapping, assigned-staff scope and field usefulness remain separate work.
