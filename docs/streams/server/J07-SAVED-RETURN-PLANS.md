# J07 — versioned saved return plans and private student reads

BUILD-61 changes academic authority to current responsible course teacher; old owner wording below is historical. New no-store GET /courses/:courseId/return-plan/follow-up/:enrollmentId returns current head only, fresh catalog completion for available steps, and hides unavailable step identity. No inferred started/finished state or completion writes. See J05-J07-TEACHING-WORKSPACE.md.

Implemented/tested locally in BUILD-38. BUILD-46 applied
`20261107_01_course_return_plans.sql` and exact session/attendance prerequisites
ONLY to the isolated synthetic demo after a private snapshot. Actual MySQL/HTTP
and desktop Chrome cover save races, receipt/reload recovery, student reads,
changed release/prerequisite, course withdrawal and owner withdrawal even after
enrollment deactivation. Missing/incompatible storage elsewhere still fails closed.
See [BUILD-46](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-46.md)
for exact sections, commands, query plans and limits. Not production/load/mobile/
educational-effectiveness acceptance. Existing domain audit is not newly sealed.

## Owner operations

The existing owner course-return router still proves active caller/tenant owner
and the exact active course. UUID course IDs are canonicalized before binary
storage, avoiding separate scopes for case variants. The former preview/review
DTO adds `persistence:{status:'ready'|'unavailable',current:null|{id,version,status}}`.
Draft evidence remains usable if storage is absent; saving does not.

- POST `/courses/:courseId/return-plan/save`: the reviewed draft input plus
  `operation_id` UUID and `expected_version` (0 for no current plan). It recomputes
  the current review digest and shared eligibility checks. The digest now binds
  the current persistence header as well as the evidence/steps. A stale header or
  changed evidence fails before writes.
- POST `.../withdraw`: exact `{enrollment_id,operation_id,expected_version}`.
  Owner/course authority and current head are checked without requiring that the
  learner remain active; revocation must not depend on expired enrollment. It
  appends a withdrawn revision with no steps, retaining earlier revisions.
- GET `.../operations/:operationId`: read-only historical receipt recovery under
  the current same actor/course authority. Missing returns `{operation:null}` and
  is not cancellation proof. Expired learner enrollment does not prevent owner
  reconciliation of an already performed operation.

Save/withdraw responses and status results are `{operation:{operation_id,plan_id,
version,status}}`. A confirmed historical receipt is not the current plan head or
notification delivery. Changed payload/kind/version/review token, actor or course
cannot replay the operation. Matching replay returns the original outcome even
after later versions, without new writes. There is no blind retry with a new key.

One head per binary `(tenant_id,course_id,enrollment_id)`, immutable revisions and
independent operation receipts are committed with shared domain audit on one
transaction/connection. Head updates CAS on the expected version. Unknown commit
destroys the connection and reports PERSISTENCE_UNCERTAIN without rollback/claim
of failure or success. Earlier write/audit/receipt failures roll back all state.

Revisions store only teacher identity, version/status, UTC evidence window and
up to three `{lesson_id,minutes}` references. No copied attendance, names, question
keys, content/URLs or student response data. A receipt stores scope, request hash
and outcome metadata, independent of mutable head lifetime. Storage validates
actual types/lengths/nullability, binary identifiers/hashes, JSON/enums, InnoDB,
unique identity/CAS indexes, student paging index and revision-to-head FK.

## Student read

GET `/api/tenants/me/catalog/my-return-plans` is mounted after canonical auth.
Only the actual student principal's current selected tenant/enrollment is used;
staff impersonation and client authority headers are denied. Active user,
suspension, current token version and live enrollment are re-proved. Optional
cursor is a resource UUID, never student/tenant authority.

At most five current active heads per page, queried with one extra. Current
published-course association is required. Every saved step reuses the actual
student lesson audience policy (identity, lesson release, prerequisite, enrollment
group and live branch membership). A denied step becomes exactly
`{position,available:false}`: no hidden lesson ID/title/estimate. Schema/policy
unavailability rejects the page rather than turning an error into permission.

Available steps contain current title, lesson ID, teacher estimate and an own
catalog-completion flag. They are not grants to media/activities; original entry
points re-prove delivery eligibility. No version fallback after withdrawal, no
legacy completion backfill, no grade/attendance/teacher/window/receipt data in the
student projection. Read-only transactions use the normal student read policy
without introducing owner/read head-lock inversions. Actual DB isolation remains
an external acceptance item.

Paging is over five saved heads before visibility filtering, so an empty visible
page may still have a next cursor. The new `(tenant_id,enrollment_id,status,id)`
index supports that read; actual query plans/load/lock behavior are not measured.
Student reads never mutate plan start/completion, lessons, subscriptions or grades.
