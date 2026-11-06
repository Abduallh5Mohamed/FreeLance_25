# J02/J03 — reviewed lesson announcement publication (BUILD-30)

Local owner/student backend and UI implementation, not live acceptance.
Continues [owner preparation](J02-LESSON-ANNOUNCEMENT-PREPARATION.md). No source
authoring/state change, notification, outbox, provider, grade or completion effect.

## Separate authority and stored review

Private group-source `published` is a prerequisite, not a student grant. An
active published course and active lesson/unit are required for explicit catalog
publication. Release time and prerequisite may still lock students: publishing
does not open them. Owner authority and exact course/unit/lesson/reference are
proved on the original transaction connection, with locking current reads for
mutation. UUID/hash body values are selectors/staleness data, never authority.

File-only `20261106_08_lesson_announcement_publications.sql` adds one publication
per reference: PK id, unique content_id, group_id, binary SHA-256 source
fingerprint and server published_at. Reference FK cascades, preserving existing
detach/source/group deletion behavior. Actual readiness checks the preparation
schema, publication columns/engine/index/FK and source updated_at availability.
No file was applied; actual SQL/FK/collation/locking acceptance remains open.

The source fingerprint covers exact bounded title/body, source and group identity,
private state, database source revision, and branch classification/ID. Owner
review returns a hash of that fingerprint, current reference/publication identity
and displayed preview facts (group/count/course/lesson flags), excluding only the
clock display. The token is an optimistic staleness check, not proof a human read
the text, a signed capability, an immutable recipient list or an expiry lease.

## Owner HTTP

Base is the existing owner lesson announcement path plus `/:contentId`.

| Method/path | Input | Result |
|---|---|---|
| GET `/publication` | Empty | `{publication:null|{id,content_id,status,published_at}}` |
| GET `/publication-preview` | Empty | `{preview,review_token,can_publish,publication}` |
| POST `/publication` | Exactly `{review_token:<64 lowercase hex>}` | Confirmed publication plus `unchanged` |
| DELETE `/publication/:publicationId` | Empty | `{withdrawn:boolean}` |

Existing strict UUID/extra query/identity-header/billing denial applies. All
responses, including errors, are no-store. Review reuses the bounded preparation
preview; >500 candidates still fails closed. Publish recomputes review on the
write connection. A changed source, revision, reference, displayed audience count
or gate/publication state is 409 `ANNOUNCEMENT_REVIEW_CHANGED` with no mutation.
Same reviewed current publication is a truthful no-op without another audit.

Replacing changed reviewed content creates a new publication ID atomically;
stale withdrawal cannot delete it. Removing an absent publication is a no-op.
Publication replacement/withdrawal plus existing `recordAudit` share one
transaction with checked affected-row counts. Audit contains sanitized IDs and
fingerprint, not announcement body or student identities. Unknown commit is
`PERSISTENCE_UNCERTAIN`, never confirmed success or automatic replay.

The real owner panel renders a fresh review, explicit checked approval and
separate confirm action, current publication status and explicit withdrawal.
Unknown write freezes mutations until a successful current-state read; a failed
recovery read does not unlock writing. Stale review discards approval. Confirmed
writes do not depend on a follow-up refresh to be described as successful.

The original preparation DTO's `student_visibility:unconfigured` still means
**that preparation/preview alone grants nothing**. The separate publication DTO
is authoritative for catalog publication state. `source_changed` means the saved
publication no longer matches the current source; it is not a new student grant.

## Student reads and source withdrawal

`GET /api/student-course-access/courses/:courseId/lessons/:lessonId/announcement`
accepts only the resource path, with no body/query/identity overrides. It derives
the exact selected enrollment and proves fresh live user/token/suspension,
approved in-window enrollment, course publication/link, lesson/unit state,
release/prerequisite and actual group/branch membership using the shared audience
proof. Locking current reads protect this new private read boundary.

A matching current publication, exact source group and unchanged reviewed source
fingerprint are required. Private source publication alone, another group, missing
publication or changed/retracted/detached source returns no announcement. Missing
schema returns unavailability, not a fabricated empty result. Final audience
proof occurs before the text projection. No arbitrary source IDs, enrolled-user
selectors, generic group/tenant reader fallback, recipients or storage locators.

Fixed response: `{lesson_id,announcement:null|{content_id,publication_id,title,
body,published_at}}`. Student UI is mounted under accessible lessons, initially
collapsed; opening/reloading makes only this private GET. Text is escaped, time
is shown in device timezone, and no read receipt/completion is written. Source
edit/revision change hides the announcement on the next read until another
explicit review/publication. No automatic re-publication or source mutation.

The approved policy is a **dynamic group audience**, not a frozen list. Future
legitimate members can read the same reviewed text subject to all current gates;
revoked members cannot. Preview count is potential enrollments, not individual
prerequisite/authentication proof. Member replacement with the same count is not
a different group policy. Current lesson rules are always authoritative; the
review token does not freeze curriculum or enrollment authority.

## Lifecycle, evidence and remaining gates

Owner/student controllers fence principal/session, workspace events, target,
timeouts and disposal. Student also detects silent workspace/ABA changes. Reads
clear old student text before acquisition; retired replies cannot restore it.
No auto-poll or push revocation is introduced: already displayed/delivered text
is not erased by a database change; the next explicit read rechecks it.

23 new backend tests execute actual owner/student routers and original shared
proof. 14 new frontend tests exercise parsers, transport/controllers, actual owner
review/publish and student mount callbacks, and escaped SSR output. Transactions,
source revisions and provider-free reads are synthetic; no browser or real DB.

No migration application, live data/provider, deployment, installation or spending.
Actual schema, isolation/deadlocks/phantoms, concurrent source changes, query/load/
resource performance, browser/device behavior and large-bundle acceptance remain
open. Current-read intent and fixture serialization do not prove real isolation.
No external delivery is activated. Catalog/legacy progress stay separate.

Next local package work: template/reuse preview within the same course, explicit
reference/audience conflicts and no copying publication, attempts or progress.
