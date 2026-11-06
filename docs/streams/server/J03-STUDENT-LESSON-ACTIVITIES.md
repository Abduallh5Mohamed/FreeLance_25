# J03 — private student lesson activity reads (BUILD-23)

Current continuation: [BUILD-26 student quiz UI](../client/J03-STUDENT-CATALOG-QUIZ.md)
now mounts the guarded attempt journey and changes quiz list/detail candidate
status to `attempt_required`; [BUILD-28 homework UI](../client/J03-STUDENT-CATALOG-HOMEWORK.md)
now uses `submission_required` for homework candidates. Neither proves runtime
readiness or replaces current authority. The fixed fields
below remain, but their original all-unconfigured status describes BUILD-23.
Fresh proof, actual schema and browser/load acceptance are still required.

Continuation: [BUILD-24 published-header selection](J02-LESSON-QUIZ-VERSION-PIN.md)
now lets the owner explicitly pin the snapshot identity. It does not activate
student attempts or replace the remaining context/window/question-proof boundary.

Local checkpoint: **2026-11-06**. Continues
[owner preparation](J02-LESSON-ACTIVITIES-CONTRACT.md). This slice implements
actual student metadata/detail routes and UI, not assessment launch or submission.

## HTTP and fixed projections

Under `/api/student-course-access/courses/:courseId/lessons/:lessonId`:

- `GET /activities` returns `{lesson_id,activities}`. At most two items have
  exactly `{content_id,kind,title,launch_status:"unconfigured"}`.
- `GET /activities/:contentId` returns `{activity}` with exactly
  `{content_id,kind,title,instructions,deadline_at,launch_status:"unconfigured"}`.
  Only authorized homework details contain instructions (nullable, at most 20,000
  characters) and a nullable database-derived UTC deadline. Quiz details have
  both fields null. There are no questions, answers, source IDs, scores, students,
  tokens, attempts, submission histories, private file URLs or legacy links.

UUID resource paths are selectors only. All query/body identity selectors are
refused, and the existing student scope guard rejects authority override headers.
Responses are `no-store`. Invalid/foreign content is indistinguishable 404;
locked lessons retain 409 `LESSON_LOCKED`. Required absent/invalid schema returns
503 rather than an invented empty list. Both routes roll back read transactions;
neither creates enrollment, attempt, submission, audit write or completion.

`unconfigured` explicitly means starting/submitting from this catalog surface
is not implemented. It is not attempt eligibility, an open time window, a frozen
version proof or a promise that the provider/schema is ready. The deadline is
display metadata, not a submission decision. Published homework instructions may
remain readable after that deadline under the original assignment read policy.

## Shared fresh authority

`student-lesson-audience.ts` extracts the existing video reader's identity,
lesson and actual enrollment-group/branch proof. Video and activity reads now
share it. Every call verifies:

1. The principal is the exact authenticated student/user/selected tenant and
   enrollment, never staff or a tenant-owner/admin bypass.
2. Current user activation, token version and suspension, then the shared
   `proveStudentLesson` enrollment/course/publication/release/prerequisite proof.
3. Actual required read engines, one real enrollment group in that course and
   tenant, and the existing live resource-branch policy including membership and
   selected membership version. A missing/unclassified/foreign group denies.

Activity schema/source checks reuse the owner implementation's explicit columns,
InnoDB/source PK/slot uniqueness proof and bounded source/audience reader. Its
raw facts remain server-private; owner HTTP projections are unchanged. Source
publication is an additional student requirement, so drafts/withdrawn sources
are omitted and never expose detail.

Homework composes the existing `enrollmentMatchesAssignment` policy with an exact
group match when a group is present. The source remains explicitly same-course
and same-tenant; unsupported branch-wide homework still fails closed.

Quiz audience must include the enrollment's actual group when groups are linked.
Mixed branch classifications/branches deny rather than widening access. A quiz
without explicit groups is only course metadata for an already authorized course
enrollment; it still confers no attempt grant. Existing owner audience integrity
and bounds (twenty groups/source and bounded batch reads) remain enforced.

Each detail request repeats all proof and selected-reference checks. Instructions
are read only from the exact published/unarchived same-tenant/course assignment;
the actual instruction/deadline columns are checked first. Deadline conversion
uses `UNIX_TIMESTAMP` and validates the numeric instant; epoch zero is preserved.

`proveStudentCatalogActivity` returns an internal selected-reference/source proof
for future use. It does not prove frozen version, time window, remaining attempts,
upload/scanner capability or durable attempt binding. It is insufficient to start
or save any assessment by itself.

## Actual student UI

Accessible lesson rows mount a collapsed `StudentLessonActivities` panel. Opening
it explicitly reads the list; a confirmed-row button separately reads details.
Unknown IDs cannot be selected, duplicate detail reads are latched, and refresh
discards old details. No generic exam/assignment redirect or start button is used.
Instructions render as escaped plain text; deadlines use the device's displayed
timezone. The UI explicitly says that starting/submission is unavailable and
viewing does not start an attempt or complete the lesson.

Strict parsers reject source/private fields, invented launch status, duplicate
slots, mismatched detail targets, oversized instructions and invalid UTC dates.
Same-document session changes, relevant storage events, observed principal
changes, target changes and disposal abort reads/timers and retire responses.
Denied/revoked detail clears all private state; transient failures offer a retry
without inventing success. Read requests have a 20-second abort deadline, and
even a late resolved aborted response cannot restore instructions.

## Remaining launch contract

The old `/api/exams/:id/can-attempt/:studentId` and `/start/:studentId` contain
auto-enrollment and must not be reused as a harmless catalog read. Old schedule
handling also uses `start_time/end_time`, while additive schema records include
`start_dt/end_dt`; no date meaning or open-window policy is inferred here.

The existing mounted `/api/exam-versions` engine already has immutable published
snapshots and explicit attempt/autosave/submit routes. Next work must inspect and
reuse it, establish an explicit catalog source-to-published-snapshot mapping,
and bind any attempt durably to catalog context. It must preserve original
audience/window/attempt/grading rules, fresh catalog revocation and truthful
duplicate/uncertain-write recovery. Do not silently choose an arbitrary version
or equate a catalog lesson ID with an exam/assignment ID. Homework submissions
similarly need exact selected enrollment and existing upload/scan policy.

No schema application, live DB/provider, actual browser/device acceptance,
concurrency/load measurement or production launch occurred in this slice.
