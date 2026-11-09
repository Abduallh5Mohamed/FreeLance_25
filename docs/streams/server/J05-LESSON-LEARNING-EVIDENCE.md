# J05 — final automatic-answer tag evidence

BUILD-48 validates the existing read-only service on actual isolated demo MySQL:
exact pin/context/group/window, automatic/manual exclusion, 5-attempt 80%/40%
tag evidence, insufficient cohort, invalid ledger, immutable version tags and
native pin withdrawal. Exact QB head/version table sections, pin table and JSON
context column were applied only to demo after private snapshot. Stored attempts/
snapshots are explicit fixtures with seven disabled-login identities, not proof
of student exam creation/execution/grading. Lesson remains future-released;
no student delivery/access acceptance or provider activation. Current evidence:
[BUILD-48](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-48.md).

BUILD-36 adds two GET endpoints beside the existing preparation read, under its
same live active owner/course/exact lesson/unit authority and read-only transaction:

- `.../preparation/groups`: current course groups, at most 25, `cursor` UUID
  keyset pagination. Group branch integrity must be tenant-wide or an active
  branch of the same tenant. Invalid/oversized rows fail closed.
- `.../preparation/learning?group_id=...&from=...&to=...`: exact selectors,
  canonical UTC second instants, start inclusive/end exclusive, 0 < duration <=31
  days. No student, tenant or branch authority selector is accepted.

This is **tag evidence**, not a pedagogical concept diagnosis. Tags come only
from the immutable `question_bank_versions` row matched by the pinned snapshot
question's source_version_id, tenant, question_id and question_version. No join
to the mutable question head and no tag inference from question text. Absent
provenance/tags is unmapped, never a fictional concept. Snapshot stems are
projected as at most 1000 characters; no keys/answers/options/explanations leave.

The current lesson quiz and its explicit published version are re-proved through
existing readers. The selected group must be within the current exam audience.
Only that version's catalog-context attempts for the exact course/lesson/content,
tenant and enrollment/user identity are eligible. Membership means the student's
current stored group, not membership at submission time or a claim of active
attendance. Neither legacy/general attempts nor old pinned versions are pooled.

Eligible attempts must be `graded`, with submitted_at in [from,to). In-progress,
expired and pending_review are excluded. All essay/manual questions are excluded.
Each final eligible attempt must have exactly one automatic-answer ledger row
for every included automatic snapshot question, matching type and version, with
manual_review false and a valid boolean is_correct. Missing/duplicate/invalid
rows fail the read rather than entering as zero or a partial denominator. Positive
question points and valid bounded snapshot positions/types are required.

Bounds: 200 snapshot questions (query 201), 100 final attempts (query 101), 20,000
automatic answers (query 20,001). Exceeding any bound yields 503 incomplete, never
a truncated statistical sample. Missing catalog JSON/tag JSON/required columns,
transactional engines or dependent source schemas fails closed. Existing actual
indexes/query plans and lock/isolation cost still need real DB validation; no
new index or migration was applied or fabricated.

The deterministic suggestion rule is a local product heuristic: at least 5 final
attempts and at least 40% not-fully-correct answer flags for a tag. Rank by that
fraction, then non-correct count, then tag name; output at most two. A partial
credit answer may have is_correct false, so this is not a wrong-answer-only rate.
Each question contributes to each of its normalized immutable tags; tag response
totals may overlap. Denominators count answers, not unique students. No effectiveness
or clinical/ability conclusion is inferred from these thresholds.

Each suggestion contains aggregate counts and the first five pinned-question
previews by position, with their counts. question_count and all totals use the
full bounded cohort, not only those five previews. No learner identifiers, raw
answers, contact fields or unpublished family report is emitted. Owner access
does not introduce staff assignment grants. No writes/audits/messages/providers.

`insufficient` is explicit for fewer than five attempts, no mapped automatic tags,
no quiz or no current published pin. `available` with an empty suggestion list
only means no tag crossed the rule; it is not mastery. The response includes
exact course/lesson/group/window, checked_at, group name and rule version.
