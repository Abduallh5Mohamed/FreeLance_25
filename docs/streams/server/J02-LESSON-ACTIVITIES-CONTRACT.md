# J02 — explicit lesson homework/quiz preparation (BUILD-22)

Continuation: [BUILD-23 student reads](J03-STUDENT-LESSON-ACTIVITIES.md) now supplies
private published metadata and bounded homework details with actual student UI.
The no-student-endpoint statement below describes this historical preparation
slice only; starting/submitting an assessment remains explicitly unconfigured.

Local checkpoint: **2026-11-06**. This is owner preparation in the existing
catalog lesson manager, not student launch, publication or attempt authority.

## Model and scope

The first bounded version has one `homework` slot pointing at an existing
`assignments.id` and one `quiz` slot pointing at an existing `exams.id`. Quiz is
a preparation role for the existing exam engine, not a new assessment engine or
an inferred short-exam type. Several catalog lessons may explicitly reuse a source.

Slots live in `course_lesson_activities`, independently of the twenty ordered
material/video references. There is no new mixed display position and no change
to their limit/order contracts. This version deliberately supports one source per
kind; it does not add replacement-in-place, notifications, copying questions,
publishing, deadlines, grades, submissions or completion.

The migration `20261106_03_course_lesson_activities.sql` is **file only**. It has
a primary ID, unique `(lesson_id,kind)`, typed assignment/exam foreign keys and a
matching-source CHECK. Actual readiness probes required columns, InnoDB tables,
source primary keys and the slot uniqueness index. Real FK/CHECK/collation/query
plan/locking acceptance is not established by those probes or tests.

## Mounted owner HTTP

Under `/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId`:

| Method/path | Body/query | Result |
|---|---|---|
| `GET /activities` | None | Up to two fixed activity projections |
| `GET /activities/:kind/available-sources` | Optional UUID `cursor` only | At most 25 eligible source projections, `next_cursor` |
| `POST /activities/:kind` | Exactly `{source_id:<UUID>}` | Confirmed content and `unchanged` |
| `DELETE /activities/:kind/:contentId` | None | `{detached:<boolean>,kind}` |

Kinds are exactly `homework` and `quiz`. UUID path/source selectors identify
resources, never authority. Extra body/query identity selectors and the explicit
tenant/student/enrollment/instructor override headers are rejected. All responses
are `no-store`. Billing-only callers are denied before connection acquisition.

The actual active selected-tenant owner/user row, exact active tenant course,
unit and lesson are proved on the same transaction connection. A role or
membership label is not an owner bypass. Writes lock these parents before slot
reads; missing actual schema is 503 `LESSON_ACTIVITIES_UNAVAILABLE`, not a fake
empty list. Foreign/missing source IDs are indistinguishable 404s.

## Source and audience proof

Homework requires explicit same-course/same-tenant `assignments` metadata,
unarchived and draft/published; closed assignments cannot be newly bound. A
group-targeted assignment must resolve to the same course and classified branch
facts. Tenant groups require no branch ID; branch groups require a live branch
in the same tenant. A branch-targeted assignment must match that group's branch.
**Branch-wide assignments without a group are not supported in this slice**;
they fail closed until an explicit independent branch proof is supplied.

Quiz requires an active exam whose course resolves to the exact tenant. Every
exam-group row must resolve to a group in that course with classified/live branch
facts; missing, foreign, unclassified, duplicate or more than twenty groups deny
the candidate. Source/audience reads are batched, bounded and use explicit DTO
projections, not question/answer or submission reads. The selector takes 25+1
source candidates and at most 521 audience rows (overflow fails closed).

Source projection is exactly `{source_id,title,source_status,audience}`.
Status is `draft|published`; audience is `course|restricted`. `course` means no
explicit group restriction was found in this preparation proof, not a student
access grant. A draft may be prepared without being published. No group/contact,
instructions, question/answer, source storage or student data is returned.

List projection additionally has `content_id,kind`; an unavailable/withdrawn or
foreign source has `title:null,source_status:unavailable,audience:null`. Its stored
source ID remains visible only to the authorized owner so it can be detached.

## Writes and recovery

Attach inserts one reference and one sanitized audit on the same transaction.
Repeating the same source in the same slot is a fresh-source-proven no-op with
no audit. A different source conflicts (409 `LESSON_ACTIVITY_OCCUPIED`); the owner
must explicitly detach. The pinned content ID prevents an old delete from removing
a replacement (409 `LESSON_ACTIVITY_CHANGED`). Already-empty detach is a no-op.
The original assessment, publication, submissions and historical attempts are
never modified by these routes. Insert/audit errors roll back; unknown commit
returns `PERSISTENCE_UNCERTAIN` and destroys the connection without retry.

Owner UI is collapsed initially. Each slot has private source selection,
explicit paging, status/audience copy, confirmation before detach, duplicate-write
latching and session/target/disposal fences. Confirmed save plus failed refresh
is reported separately. Uncertain/malformed responses block writes until an
explicit read; no mutation is automatically resent. Scope change clears private
state and aborts work/timers. The confirmed-read UI is not a durable write receipt.

## Next boundary

No student catalog activity endpoint or launch button is supplied. Existing
assignment/exam endpoints keep their own behavior and access policy; attaching
does not retrofit catalog lesson locks into them. The current legacy exam
`can-attempt` and `start` paths contain auto-enrollment writes in
`routes/exams.ts`; a catalog launch must not redirect into those paths and call
that a read-only authorized preview. Next work needs shared fresh catalog plus
original assessment audience/window/attempt/version authority, explicit launch
semantics and no auto-enrollment or completion side effects on reads.

Actual SQL isolation/FK/index/engine/collation and concurrency against unrelated
legacy source writers remain unverified. Synthetic tests model serialized parent
writes; they do not prove all legacy authoring routes take compatible locks.
No migration application, provider, live data, deployment or package installation.
