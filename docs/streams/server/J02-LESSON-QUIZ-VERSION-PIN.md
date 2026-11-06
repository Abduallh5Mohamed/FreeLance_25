# J02/J03 — explicit published quiz-version selection (BUILD-24)

Local checkpoint: **2026-11-06**. Continues
[activity preparation](J02-LESSON-ACTIVITIES-CONTRACT.md) and
[student metadata](J03-STUDENT-LESSON-ACTIVITIES.md).
This is owner preparation; student launch remains `unconfigured`.

## Why an explicit choice

An activity references an exam, while the existing versioned engine can hold
several published snapshots for it. Neither the first row nor the latest ordinal
is an authorized substitute for the teacher's intended snapshot. The owner now
chooses an exact published `exam_versions.id` for the exact quiz reference. New
publications never alter this choice and archival never silently selects a fallback.

The new file-only migration `20261106_04_course_lesson_quiz_versions.sql` stores
one `{content_id,exam_id,exam_version_id}` row per activity. Its content FK cascades
when the quiz reference is detached; exam/snapshot FKs restrict source deletion.
It never cascades into snapshots, questions or attempts. The file was **not applied**.

## Mounted owner contract

Base path:
`/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId/activities/quiz/:contentId`

| Method/path suffix | Input | Fixed response |
|---|---|---|
| `GET /version` | No body/query | `{pin:null}` or `{pin:{content_id,exam_version_id,version_number,status}}` |
| `GET /available-versions` | Optional UUID `cursor` only | `{versions:[{exam_version_id,version_number}],next_cursor}` |
| `POST /version` | Exactly `{exam_version_id:<UUID>}` | `{pin,unchanged:<boolean>}` |
| `DELETE /version/:versionId` | No body/query | `{detached:<boolean>,content_id}` |

Every response is `no-store`. Unknown body/query/identity overrides are rejected.
The exact active selected-tenant owner, active same-tenant course, exact unit,
lesson and quiz activity are proved on the transaction connection. Billing-only
access denies before connection acquisition. A homework reference is never a quiz.
Writes lock owner/parent rows and the exact activity/reference before mutation.

Actual required schema is checked, including inherited activity source schema,
new columns/engines, exact primary/unique indexes and the three matching FK delete
rules. Missing/invalid evidence returns 503 `LESSON_QUIZ_VERSIONS_UNAVAILABLE`;
having the migration file is insufficient. Real engine/FK/collation/transaction/
locking/query-plan acceptance remains unverified.

The existing bounded course/source/audience proof must find the exam in the same
course and tenant. A candidate header must have the same exam and tenant,
`status='published'`, non-null publication instant and a valid positive ordinal.
Draft, archived, foreign and missing headers cannot be pinned. A legacy exam may
still be a draft while preparing a published snapshot choice; the student's
separate outer publication and access checks remain required later.

The selector is bounded at 25+1, sorted by stable UUID cursor, with no automatic
choice. It reads header identity/ordinal only: no questions, answers, rubric,
grades, student data or attempt history. A pinned header read returns
`status:'published'` with its ordinal only while source/header proof succeeds;
otherwise it retains the saved ID with `status:'unavailable',version_number:null`.
The owner can explicitly remove such a stale choice without deleting the source.

## Writes and recovery

Pin plus sanitized audit share one transaction. Repeating the same version is a
fresh-source-proven no-op with no second audit. Selecting a different version
while pinned returns 409 `LESSON_QUIZ_VERSION_OCCUPIED`: unpin explicitly first.
Unpin names the exact displayed version, so a stale delete cannot remove a
replacement (409 `LESSON_QUIZ_VERSION_CHANGED`). Empty unpin is a no-op. Unknown
commit returns `PERSISTENCE_UNCERTAIN`, destroys the connection and never retries.

The actual owner activity editor now mounts a collapsed version editor for its
quiz reference. It has an initially empty selection, explicit paging and a pin
button, status display, confirmation before unpin and an explicit refresh. The
client validates exact DTOs and pins only a confirmed current page item. Requests
are authenticated/no-store, latched, abort-bounded and fenced by scope/target/
disposal. Confirmed save plus failed refresh is distinct; uncertain responses
block further writes until a fresh read, with no automatic resend.

## What this does not prove

This proves an explicit reference to a **published snapshot header**. It does not
validate all frozen question hashes, the current attempt window, remaining attempt
allowance, durable student context, scanner readiness or production availability.
No snapshot is published, copied, edited or removed. No student is enrolled and
no attempt, score, answer or progress ledger is created or changed. Existing
student metadata/detail DTOs remain unchanged and launch remains unconfigured.

## Required next boundary

Continuation: [BUILD-25 attempt contract](J03-CATALOG-EXAM-ATTEMPTS.md) now
implements the backend boundary below. Student attempt UI and actual schema/
concurrency/browser acceptance remain pending; header metadata is not a launch grant.

Reuse the mounted `/api/exam-versions` engine and its frozen question/timing/
grading policy. Before exposing a catalog start action, implement durable context
binding and same-transaction catalog/source/pin/version/audience proof, with
read/save/submit and revocation checks. The existing unique attempt allowance is
by exam/enrollment; adding a lesson or pin must not reset it or introduce a second
attempt engine. Exact selected enrollment must be resolved server-side, not by
an arbitrary first enrollment row.

Generic start/read/save/submit paths must be assessed for catalog-lock fallback;
a new catalog route alone does not enforce the lesson lock on old entry points.
Preexisting unbound attempts and historical grades need explicit behavior rather
than an invented backfill. Do not redirect to the old auto-enrollment exam routes,
silently pick a version, trust metadata as eligibility, or mark a lesson complete
when selecting a snapshot or starting an attempt. Homework submission stays a
separate integration with the existing private upload/scan policy.

No live DB/provider, migration application, actual browser/device acceptance,
deployment, package installation, concurrency/load measurement or spending.
