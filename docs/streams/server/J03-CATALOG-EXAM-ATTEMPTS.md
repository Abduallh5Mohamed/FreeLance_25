# J02/J03 — durable catalog exam attempts (BUILD-25)

BUILD-55 continuation (2026-11-08): actual isolated-demo MySQL/HTTP/Chrome journey and lost-ACK/reload recovery now verified; older schema/browser-pending statements below are historical for this demo only. UTC DATETIME values are selected as text before ISO conversion; catalog start uses whole seconds to match persistence. Quiz operation deadline releases stalled transports even when they ignore AbortSignal, with no automatic write replay and confirmed submit preserved on failed refresh. Question answer keys/private binding stay hidden; essay remains pending and no lesson completion is inferred. Publication usage schema applied to demo after snapshot; activation also created assignment_submissions, disclosed in [report](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-55.md). Backend157/frontend2271/types/build pass; providers, production/load/mobile/real expiry/two-commit races are not accepted.

BUILD-25 implements the backend boundary. [BUILD-26 student UI](../client/J03-STUDENT-CATALOG-QUIZ.md)
now mounts explicit start/resume/save/submit and changes quiz candidate metadata
to `launch_status: attempt_required`; homework stays unconfigured. This is not
schema/eligibility/readiness acceptance. The existing exam-version engine remains
the only timing/grading engine.

## Entry and recovery

Authenticated selected-student endpoints, under `/api/exam-versions`:

`GET|POST /catalog/courses/:courseId/lessons/:lessonId/activities/:contentId/attempt`

UUID path selectors only; no query, nonempty body or identity override headers.
The server derives user, tenant, exact selected enrollment, exam and published
version from current authority and the owner's saved pin. It does not enroll
students or choose a newer/fallback version. All versioned-exam responses use
`Cache-Control: no-store`, including failures.

POST locks the course/enrollment and proves current identity, suspension/token
version, approved enrollment, course/lesson publication, release/prerequisites,
actual group/branch membership, source audience and exact published pin on the
write connection. It validates the complete frozen snapshot using the existing
snapshot builder, timing bounds and grading policy before the original engine
start decision. Questions are bounded to 200. Schema readiness includes actual
JSON column, inherited pin FKs/indexes, InnoDB and attempt/answer/grading indexes.

The original attempt INSERT includes private `catalog_context` JSON: user,
tenant, enrollment, course, lesson, content, exam, version and snapshot
fingerprint. Attempt creation and existing atomic audit share one transaction.
The fingerprint covers ordered question IDs/positions/content hashes, timing,
point totals and scoring policy. It detects an internally valid replacement as
well as invalid stored content. Neither private context nor answer keys are
returned to the student.

POST returns 201 `{attempt:{id,status,started_at,deadline_at},unchanged:false}`.
An identical existing binding returns 200 with `unchanged:true`, including its
terminal state. It does not create another attempt, reset its deadline, or audit
a duplicate creation. The original unique exam/enrollment allowance applies
across lessons and versions. A different context is 409
`CATALOG_ATTEMPT_DIFFERENT_CONTEXT`; an existing unbound attempt is 409
`CATALOG_ATTEMPT_UNBOUND`. There is no automatic historical backfill.

GET returns the same compact existing attempt or `{attempt:null}`. It is pure
recovery: no creation, expiry or grading. Unknown creation/commit outcome returns
503 `PERSISTENCE_UNCERTAIN`; use GET before any deliberate retry. Missing schema
or transaction support returns 503 `CATALOG_ATTEMPT_UNAVAILABLE` before mutation.
Recovery requires current access; withdrawal can therefore prevent recovery.

## Read, save and submit

Use the existing `/attempts/:attemptId`, `/autosave` and `/submit` routes after
obtaining the attempt ID. Exact selected enrollment is resolved server-side.
The durable marker is enforced on each student read/write; removing a pin does
not turn a bound attempt into a legacy attempt. Read checks surround acquisition
of questions and the student's saved draft. Write checks run again inside the
existing transaction using locking current reads before answers, grades or audit.
Question/timing/scoring replacement or withdrawn access denies further use.

Catalog GET adds `answers`, containing only the student's saved responses,
bounded to 200 entries / 128 KiB. It never includes `correct_answers`. Stored
JSON responses are selected as text before parsing, including scalar answers;
this avoids re-parsing mysql2's already decoded scalar as JSON. Saved responses
are not evidence that an unsent edit reached the server.

Existing deadlines, autosave throttle, submission/grading, manual-review and
idempotency rules remain in force. Unknown autosave/submit outcome returns 503
`PERSISTENCE_UNCERTAIN`: inspect server state before retry; do not display a
confirmed failure or automatically replay. Terminal repeated submission remains
the engine's 409. Error before work returns temporary-unavailability or explicit
access denial. No lesson completion is inferred from any exam action.

The context binds identity/enrollment, not one login incarnation. The same user
can resume after login subject to fresh authentication and all current proofs;
an outdated token version or suspended identity fails the proof.

## Legacy and historical policy

Generic versioned start denies every version of an exam with a catalog pin,
before and inside its transaction. Student legacy exam resource paths also deny
bound exams, including percent-encoded selectors; no fallback to old automatic
enrollment/question/start/save/submit/review routes. Published metadata listings
and authorized staff/history retain their original policies. Old unbound
versioned attempts cannot be used by students while their exam is pinned.

For exams with no pin and no stored context, legacy behavior remains compatible
when the additive context column is absent. Partial/wrong-type schema fails
closed. There is no down-migration or context-erasure recovery contract.

Server expiry and authorized staff regrading may settle saved work after lesson
withdrawal, but must still prove the stored snapshot fingerprint. An archived or
changed snapshot blocks settlement and needs an explicit repair/review decision;
it does not silently grade against a replacement. Staff grade history is not
student question/attempt authority.

## Acceptance and next work

`20261106_05_catalog_exam_attempt_context.sql` is an unapplied additive file,
not live readiness. Transaction fixtures model serial execution and lost commit
acknowledgements; they do not verify real MySQL isolation, deadlocks, JSON/FK
behavior or query plans. Repeated bounded snapshot proofs have a cost: actual
load/query/resource acceptance remains required. No browser/provider acceptance.

Student UI for explicit start/resume, server deadline, draft editing, autosave,
submit and uncertain-write recovery is now implemented locally in BUILD-26.
Actual browser/schema/load acceptance remains open. Next: homework upload/scan/
submission as a separate integration. Catalog and old progress records stay separate.
