# J02 — reviewed lesson reference reuse — BUILD-32

## Mounted interface and authority

Owner routes under `/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId/package-reuse`:

- `POST /review`: exact body `{source_lesson_id,selections}`.
- `POST /`: exact body `{source_lesson_id,selections,review_token,operation_id}`.
- `GET /operations/:operationId`: no query/body, receipt lookup only.

Each selection is exactly `{kind,source_id}`. Kind is `material`, `video`,
`homework`, `quiz` or `announcement`. IDs are UUIDs. At most 23 unique selections,
20 mixed media references and one of each activity/announcement kind. Selection
order and UUID case are canonicalized. No tenant/student/enrollment/instructor
overrides, caller positions, target source URLs, publication or progress inputs.
All responses from the handlers, including failures, use `Cache-Control: no-store`.

Billing-only denial and structural checks precede connection acquisition.
Identity and selected tenant come from the existing server principal; actual
tenant ownership/live caller, active same-tenant course and exact destination
unit/lesson are re-proved on the transaction connection. Every operation,
including review and receipt lookup, locks the same owner/course/destination
parents. A found ID or selector is never authorization.

Source unit is derived from source lesson inside the same verified course.
Source and destination must differ and both lessons/units must be active for a
new review/apply. Cross-course/foreign/missing source is not found. The backend
supports cross-unit sources. BUILD-33's
[source picker](../client/J02-CROSS-UNIT-PACKAGE-SOURCES.md) now selects from
bounded unit/lesson pages in the actual UI; the original BUILD-32 same-unit
UI limitation is superseded.

## Current review and final-state validation

Actual schema checks require the existing material/video/activity/announcement
tables and source engines/indexes via the existing domain helpers. Material
reference unique source/order indexes and the operation receipt primary key are
checked too. Receipt columns require exact non-null types, lengths and binary
collation; receipt storage must be InnoDB. Missing/invalid schema returns 503
`PACKAGE_REUSE_UNAVAILABLE`; a migration file alone is not readiness.

Bounded locked reads load both lessons' references. Mixed positions must be
valid/unique and at most 20; singleton slots and source identities must be valid.
Corrupt existing references fail closed. Selected sources must still be bound
to the selected source lesson. Materials are exact same-course sources; videos
reuse `eligibleLessonVideo`, including tenant/course, ready state and legacy
pointer exclusion. Homework/quiz reuse `readLessonActivitySources` for current
course/tenant/group/branch classification; announcement uses the existing
same-course classified group source reader. Unselected source eligibility is
not inferred or broadened by this operation.

Review returns only `{review_token,can_apply,items,projected_media_count}`.
Each item projects selected kind/source, title, position, source state, course
or restricted audience, proposed outcome (`add`, `present`, `conflict`) and a
conflict code. No object locator, source body, group/student identities or private
authority facts are returned. Restricted means the source's own groups remain
in force; this is not an exact student audience count or an audience override.
The UI instructs the owner to inspect source group settings independently.

The optimistic SHA-256 token binds actor/tenant/course/destination, selected
source lesson/references, both locked binding sets, lesson/unit state and current
selected source facts/audience proof. Apply re-reads/re-proves under locks and
rejects changed review with 409 `PACKAGE_REVIEW_CHANGED` before writes. Token is
not an access capability or proof of a human reading the preview. Unchanged
facts after an intervening edit are not a version-history guarantee.

Different source occupying an activity/announcement slot, occupied mixed
position, same reference at another position, unavailable source, or final
combined media count above 20 is a conflict. Nothing is replaced, moved or
partially applied. The original positions are reused; position remapping and
automatic conflict repair are outside this contract.

## Atomic writes and durable idempotency

Apply inserts new reference IDs only; exact already-present references are
retained. All selected inserts, `course_lesson_package.reuse` through the shared
audit helper with checked affected rows, and the operation receipt commit in
one transaction. Any source/ref/audit/receipt failure rolls back the unit.
No provider or file I/O occurs. Even an all-present new request records one
audited operation/receipt with zero created references; exact replay adds neither
audit nor reference/receipt rows.

`20261106_09_course_lesson_package_operations.sql` is an **unapplied file**.
Its `(tenant_id,operation_id)` primary key is a durable receipt. Actor, course,
destination and canonical request hash bind a retry to its original input and
review. A matching replay returns historical created/existing counts with
`replayed:true`, after current owner/target authority and schema checks. A reused
operation ID with another payload/actor/context returns 409
`PACKAGE_OPERATION_CONFLICT`. Source may have changed since a confirmed operation;
replay does not create references again or assert their present availability.

Receipt rows intentionally do not cascade with mutable source references; no
content, student records or provider payloads are stored. Receipt retention and
maintenance need a separate operational policy; no cleanup is activated here.
Lookup is exact by primary key, never a history scan. Deleting/inactivating the
target/course can prevent recovery because current authority still applies.

Lost commit acknowledgement destroys the physical connection and returns 500
`PERSISTENCE_UNCERTAIN`, with no claimed rollback or silent retry. The client
retains the same operation ID and uses GET status. A receipt confirms a historical
save; `operation:null` is not cancellation proof or permission to retry, because
another in-flight request may not yet have reached the parent locks.

## Actual UI and lifecycle

`LessonPackagePreview` mounts `LessonPackageReuse` beneath its advisory comparison.
The user chooses references, requests current server review, checks an explicit
approval, then confirms apply. The client cannot derive permission to copy from
BUILD-31's separate reads. Exact DTO and selected-source parsers prevent mixed
or stale projections from being presented as a reviewed operation.

Busy/uncertain states block new applies and reviews. Selection changes discard
approval. Session/principal/scope/unmount changes and 25-second deadlines fence
late replies. Network/5xx/malformed apply responses remain uncertain; receipt
GET failure or a missing receipt preserves that state. Definite 4xx apply failure
requires a new review. Confirmed save is shown separately from list freshness:
existing managers/comparison must be refreshed, and the UI says so.

Pending operation context is memory-only. Closing, navigating or reloading can
lose the UI recovery locator; the displayed operation ID is not a secret. Closing
does not undo server work, as explicitly stated in the UI. The server receipt
persists when its schema is applied. Cross-reload pending-operation restoration
and a receipt history/recovery screen are not implemented.

No quiz-version pin, catalog announcement publication, source publication,
schedule/prerequisite, file, consent/session, student attempt/submission/grade,
progress ledger, permission, enrollment or exam/enrollment attempt allowance is
copied/reset. A reused quiz needs explicit destination version selection; a
reused announcement needs explicit destination publication review. Dynamic source
audience and all student gates remain authoritative on their original routes.

Tests run actual Express handlers and UI callbacks with synthetic SQL/HTTP;
the fixture mutex is not MySQL isolation evidence. Schema application, real
concurrency/deadlocks, source writers, query plans/metadata cost, resource/latency
limits, browser/device and provider acceptance are still required. New queries
are bounded, but no throughput or task-time improvement has been measured.
