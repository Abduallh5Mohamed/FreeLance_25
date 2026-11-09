# J08 — teacher reference rubric snapshots

Updated BUILD-60,9 November2026: authority is the responsible course teacher, not institution ownership. The owner clarified the business/academic separation and authorized implementation. Full assignment/reopen contract: [J08-TEACHER-GRADING](J08-TEACHER-GRADING.md). BUILD-59 describes the initial rubric-only checkpoint, not current authority.

## Existing authority and runtime

Mounted via tenant-self at `/api/tenants/me/catalog/grading`:

- GET `/questions/:questionRef/rubric`: latest immutable rubric or null.
- POST `/questions/:questionRef/rubric`: operation_id, expected_revision,
  complete criteria; creates a new immutable revision, never updates an old one.
- GET `/rubric-operations/:operationId`: actor-owned historical receipt or null.

Only the live responsible course teacher may use these surfaces. Canonical auth
and token_version proof, active tenant/user, direct users-table identity and
server-derived tenant, active teaching membership and courses.instructor_id responsibility apply. Institution ownership is not a grant. Impersonation, billing-only, old staff namespace,
identity headers/queries and foreign questions are denied. Platform admin role
does not confer institution ownership. Center employees receive no new rights.

The selected question must be an essay in a published snapshot and active owned
course. No mutable exam head/latest-question fallback. Current teacher/question
locks and actual InnoDB/JSON/unique-index checks precede writes. New schema is
additive `20261108_02_grading_rubrics.sql`; two CREATE statements were applied
ONLY to the previously authorized isolated synthetic demo after a private
snapshot. No source/production database change.

## Meaning of a rubric

Between1 and20 criteria with unique stable keys, nonempty descriptions <=200
characters and strictly positive weights. Exact integer hundredths must sum to
the pinned question's points. Invalid partial strings, exponent/non-finite values,
negative values, extra precision and client authority fields are refused.

The scoring helper requires every criterion exactly once and computes a sum
server-side, bounded per criterion. BUILD-60 wires it into the original revision
engine only for explicitly assigned questions with pinned rubric provenance. Saving reference criteria does not grade an answer, certify educational
quality, assign a grader, replace old reviews or modify the exam version. The responsible teacher retains explicit manual-review authority; there is no claim that old grades
were awarded using this new rubric. Assignments pin a chosen rubric
revision rather than silently using the latest one.

## Atomicity and recovery

The teacher identity lock serializes competing rubric revisions. Same operation/actor/normalized
intent replays the original receipt before revision conflict checking; changed
intent or stale revision409. New snapshot, sealed audit chain event/head and
operation receipt commit on one connection. Audit contains IDs/revisions only,
never criteria/answers/feedback. Actual audit/receipt SQL fault tests prove
rollback of all three and of the sealed head; uncertain commit is not success.
Connections with uncertain transaction cleanup are destroyed.

All responses no-store/Vary Authorization. Receipt IDs are validated against the
request. GET recovery does not repeat a write; missing receipt is not proof of
absence. Commit-uncertainty/racing durable commits/load remain unverified.

## UI and boundaries

`GradingRubricEditor` is mounted in the existing question workbench on
`/manual-grading`, when its current question page is available. It clearly calls
the rubric a saved reference revision. A verified sessionStorage marker contains
only operation/question UUIDs and expected next revision, no criteria or answers.
Unknown result blocks another rubric save, survives reload and uses explicit GET
recovery. Confirmed save and subsequent current-state refresh are separate.
Storage cleanup failure preserves uncertainty; no automatic resend or elapsed-time
unlock. Session/principal change hides the criteria and answers. A shared bounded
request helper covers fetch/body parsing and uncooperative cancellation for both
center and rubric clients, without importing center feature code into grading.

Native auth/MySQL/Chrome evidence: keyed creation/replay/stale/foreign denial,
real commit/lost-ACK/reload recovery with one POST, SQL rollback and equality of
all prior question/attempt/manual-revision/gradebook rows to the private snapshot.
The BUILD-59 rubric-only tests did not assign graders or reopen results. BUILD-60 separately verifies teacher assignment, revision and reopening; saving rubric metadata alone still changes no old grade or family publication. No provider was activated. Human rubric quality/consistency, production/device/load remain open; assignment/reopen authority is now governed
by the BUILD-60 teacher contract. Strategy22 J08 requires a separate revision contract preserving old/new
results; the current gradebook projects by exam/enrollment/course rather than
carrying an attempt-source field. BUILD-60 proves the canonical receipt,
unique-attempt and unchanged gradebook source before reopening; unknown or
customized projections are refused rather than blindly removing a score row.
