# J01 — owner group setup review

BUILD-50 adds `students.offline`: active enrollments whose stored is_offline flag
is true. Missing-account count now includes only active ONLINE enrollments;
offline deliberately needs no login. Invalid offline flags fail the whole read.
Assignment/capacity/schedule counts stay separate; all authority/read bounds remain.
The strict client/server DTO must be released together. Actual synthetic demo
group/offline creation with explicit course, online creation/login without course
grant, import/replay and browser navigation/CSV commit passed. Only import-batch
storage was applied additionally to demo; no source DB/provider changes.
See [BUILD-50](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-50.md).
Import-to-enrollment/account conversion is not authorized by that evidence.

BUILD-40, 7 November 2026. A read journey joining existing group, roster,
account, assignment and concrete-schedule facts. It creates no account,
enrollment, membership, access grant, attendance or payment and does not change
the existing import or group write engines.

## Mounted route and authority

`tenant-self.ts` mounts `createGroupSetupRouter({getConnection})` under catalog,
after the existing authentication chain. Actual URL:
`GET /api/tenants/me/catalog/groups/:groupId/setup`.

Only a direct current users-table principal who is the live active tenant owner
may read. Billing-only, old staff identities and impersonation are denied.
Selected tenant in the credential is a selector: current active tenant/owner,
active user and shared suspension predicate are proved from SQL before and
after collecting facts. Nonowner gets 403; foreign or absent group gets 404.
Query/body and authority headers cannot select student/teacher/tenant. Resource
queries derive course ownership from the group's same-tenant course.

Response is private/no-store. All SQL is SELECT with bound parameters and
explicit columns. The adapter uses a connection in ordinary read mode without
new transactions, write locks or commits. Errors discard it; ordinary exits
release it, with destroy on release failure. There is no claim of an atomic
snapshot: group changes or owner loss detected at the final proof discard the
collected facts with 409. A change after proof is the usual completed-read
boundary, not real-time invalidation.

## Fixed evidence

- Group name, owned course name, separate group/course active flags and branch
  validity; unknown/invalid branch classification becomes a review issue.
- Assigned teacher name only if current active users-table identity and owner
  or active instructor/owner membership of this exact tenant. Otherwise an
  explicit unavailable/not-assigned state with null name, no foreign identity.
- Up to 500 student records **in this group and tenant**. Count actual rows,
  not `groups.current_students`. Enrollment liveness, users-table active and
  unsuspended account, and active same-course assignment are separate stages.
  Missing account/assignment counts only concern currently live enrollments;
  inactive rows are counted separately. Counts prove neither content access
  nor financial standing. No student names/contacts/IDs leave this route.
- Read 501 student rows; >500, duplicate IDs or malformed facts fail the whole
  review with 503, rather than returning partial totals.
- Concrete schedule is optional evidence. Prove required existing columns
  and a `(tenant_id,group_id,starts_at)` index prefix before reading it. Missing
  metadata/index returns `unavailable` with empty payload, not known zero
  sessions. Actual source read failure rejects the review. This is not a
  production schema/readiness or query-performance assertion.
- Query only noncancelled current-group sessions starting within the next
  seven days, UTC. Read 21; >20 or duplicate/malformed rows rejects the whole
  review. Weekly schedule text on a group is not a generated concrete session.
  Branch/tenant-wide events are outside this specific count.

`issues` is an ordered deterministic list: group/course/branch, teacher,
empty roster or all-inactive enrollment, missing account, missing course
assignment, zero/over capacity, unavailable schedule or no upcoming sessions.
`next_action` is the first issue or `practice_handover` if none. `readiness` is
always **review_only**. Zero capacity is a review issue, not invented unlimited
capacity. A checklist without issues is not live acceptance or a permission to
publish, deliver, charge or claim measured time savings.

## Limits and acceptance

Existing schema only; no new migration or application. Core missing columns
fail the query closed. Actual source engines/indexes/isolation/query plans,
scan cost and load are not verified by scripted SQL tests or row caps. No
tenant-wide roster or new automatic writes were added. Existing legacy group
cards and their cached counts are not replaced by this review.

403/404 authority failures, 400 invalid selectors, 409 changed context,
503 unavailable/overflow/malformed evidence, all no-store and sanitized.

See [client contract](../client/J01-GROUP-SETUP.md) and
[BUILD-40](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-40.md).
J01 still needs complete account/role/setup/import integration and actual
independent-user practice with measured results; this contract is not that
entire journey's acceptance.
