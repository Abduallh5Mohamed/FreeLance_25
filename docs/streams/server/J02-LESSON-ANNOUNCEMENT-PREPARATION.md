# J02 — lesson announcement reference and owner preview (BUILD-29)

Local owner preparation and actual UI only. No student publication, delivery,
notification/outbox, schedule, provider or live schema acceptance.

Continuation: [BUILD-30 reviewed publication/student read](J03-LESSON-ANNOUNCEMENT-PUBLICATION.md)
now adds explicit catalog publication and guarded student panels. The preparation
DTO's unconfigured visibility means preparation alone grants nothing; the separate
publication state decides student visibility. Real schema/browser acceptance and
external delivery remain unconfigured. The original BUILD-29 scope below is kept.
Existing source contract: [private group announcements](M2-B13-CONTRACT.md).

## Source choice and meaning

The repository has both C11 tenant/branch announcements and private group
announcements. A lesson reference here uses `group_announcements`, whose group
must resolve to the exact active course and server-selected tenant. It never
converts a tenant-wide announcement into a lesson-only audience or copies one
into a second announcement engine. The original group title/body/state are not
created, edited, published or retracted by these endpoints.

One lesson has at most one reference. Several lessons may reuse a source.
Source `draft`/`published` are the existing **private management states**;
`published` does not mean visible to students, sent or read. `retracted`, foreign
or unprovable sources cannot be newly attached. Existing unavailable sources
remain visible as unavailable reference headers and can be detached.

The additive `20261106_07_course_lesson_announcements.sql` is an unapplied file:
reference PK, unique lesson slot, lesson and source FKs with cascade deletion.
Cascades preserve existing lesson/group/source deletion behavior. No source row,
existing table or live data is changed. Actual probes check bounded required
columns, InnoDB, identity/slot indexes and the two FK target/delete contracts.
They do not establish real FK/collation/query-plan/locking acceptance.

## Actual owner HTTP and UI

Base: `/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId/announcement`.

| Method/path relative to base | Input | Result |
|---|---|---|
| GET root | Empty | `{announcement:null|reference}` |
| GET `/available-sources` | Optional UUID `cursor` only | 25 source headers + `next_cursor` from bounded 26-row keyset page |
| POST root | Exactly `{source_id:UUID}` | `{announcement:reference,unchanged:boolean}` |
| DELETE `/:contentId` | Empty | `{detached:boolean}` |
| GET `/:contentId/preview` | Empty | Private text and potential audience/gate snapshot |

Every response is no-store. UUIDs are selectors only; identity override headers,
extra query/body fields and billing-only requests deny before acquisition.
Live selected-tenant owner/user, exact course/unit/lesson are proved on the same
connection. Writes lock parents/source/slot; insert/delete and `recordAudit`
share that transaction with confirmed affected-row counts. Same-source attach
and absent detach are truthful no-ops without another audit. Replacement first
requires explicit detach. Stale detach/preview ID is 409; it cannot affect the
replacement reference. A lost commit acknowledgement returns
`PERSISTENCE_UNCERTAIN`; use GET before another decision, never blind replay.

Reference fields are exactly `content_id,source_id,title,source_state,group_id,
group_name,student_visibility`. Unavailable references have null title/group
fields; student_visibility is always unconfigured. Source pages carry only
`source_id,title,source_state,group_id,group_name`, never body or recipients.
Invalid/inactive branch sources are withheld; raw page position still advances
the cursor, including an empty eligible page. Corrupt source text/identity fails
closed rather than returning a fabricated header.

`CourseLessonManager` now mounts the initially collapsed
`LessonAnnouncementManager`. The owner can select, attach, inspect the preview
and confirm detachment. Strict parsers, one-flight writes, 20-second timeout,
scope/session/disposal fences, storage events and actual callback tests protect
the flow. Unknown writes freeze mutations until explicit current-state reload;
no replay, automatic refresh-as-success or original-success inference from
historical/current state. Source pages retained by a controller are capped at
200; per-request discovery stays bounded. Body/title render escaped.

## What audience preview proves

The fixed preview adds `body,candidate_enrollments,course_published,lesson_active,
lesson_released,prerequisite_required,previewed_at,delivery_status` to the source
header plus content ID and unconfigured student visibility. The timestamp comes
from the database clock. It returns no names, user/enrollment IDs, contact data,
notification counts, access token, publication capability or delivery receipt.

Candidate count means **enrollment rows**, not unique people or confirmed
recipients. The bounded SQL includes actual source group + tenant, active and
approved in-window enrollments, active unsuspended users, active course link and
live student branch membership for a branch group. Group branch classification
and same-tenant live branch are proved before the query. At most 501 IDs are
read privately; over 500 fails closed with
`LESSON_ANNOUNCEMENT_PREVIEW_TOO_LARGE`, never a partial or estimated count.

Course publication, lesson/unit archival, release and existence of prerequisite
are displayed separately. Individual prerequisite completion, authenticated
session/token status and future access are **not** counted as proven. A count
of zero does not authorize a wider audience. The snapshot can change immediately
after reading and is not a frozen publish approval.

## Remaining publication boundary

BUILD-29 itself adds no publish/send button or student read; explicit publication
and student reading are now implemented locally in BUILD-30 above.
The next coherent step must define explicit catalog-reference publication and
fresh student reads, independently of the source's private management state.
It must bind reviewed text/source revision and group/lesson scope, reject stale
preview/content, and honor current enrollment, branch, release/prerequisite,
source withdrawal and session authority. Original group-source edits must not
silently change what students were approved to see. Publishing a broad C11 row
or emitting notifications is not a shortcut. Real delivery remains a separate
contract/authorization.

Evidence: 15 new real-router/synthetic-SQL tests and 13 frontend parser/controller/
actual-effect/SSR tests, included in the broader BUILD-29 run. No real MySQL,
browser, device, providers, migrations, load or resource performance acceptance.
