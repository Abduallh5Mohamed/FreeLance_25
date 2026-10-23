# M2-B04: private owner-managed course-unit metadata

Human152 delegates bounded remaining M2 preparation/dispatch; backlog17/C5 requires
course/unit/lesson create/edit/reorder/archive. Product19 keeps institution assets
tenant-owned. Reuse accepted151 verified tenant-owner metadata authority; do not
invent instructor assignment, student entitlement, publishing or financial rules.
Task `client-m2-b04-course-unit-metadata-20261019-01`, backend, write.

Before: Courses/materials exist, no unit hierarchy contract in inspected course
routes. After: verified institution owner can list/create/rename/reorder/archive
private unit metadata under an active course of the SERVER-selected institution.
No student/public consumption, lessons/material moves, uploads/providers, drip,
progress, enrollment or checkout effects. Archived unit is metadata only; it does
not alter existing course/material access. No migration application or live rollout.

## Exact five allowedPaths

- `server/src/routes/course-units.ts`: new injected router, dedicated implementation.
- `server/src/routes/tenant-self.ts`: additive import/mount ONLY after existing
  authenticate; preserve all accepted handlers/default wiring byte-for-byte.
- `server/migrations/20261019_02_course_units.sql`: new additive table FILE only.
- `server/tests/m2-course-units.test.ts`: positively isolated real route/composition tests.
- `docs/streams/server/M2-B04-CONTRACT.md`: actual API/schema-file/checks/limitations.

No index/auth/middleware/shared/API/client/other-schema/package/config changes.
No install/npx/live HTTP listener/DB/network/provider/browser/service/Git/deploy.
Unique worker coordination report allowed separately. Preserve accepted dirty work.

## Contract, authority and representation

Mount new factory under existing authenticated tenant-self `/catalog`; expose:
GET/POST `/api/tenants/me/catalog/courses/:courseId/units` and
PATCH `/api/tenants/me/catalog/courses/:courseId/units/:unitId`.
Factory accepts injected transactional connection supplier, no eager default DB/
provider modules. Existing tenant-self mount supplies its existing getConnection;
new module imports AuthRequest as TYPE only and no default adapters.

No new role/capability: verified `tenants.owner_user_id` equals caller; selected
tenant active and user active, rechecked on same transaction connection with
owner row lock, matching accepted151 semantics. Membership label/global teacher/
admin is insufficient. Missing selection fails closed; no arbitrary tenant fallback.
Explicitly reject req.user.billingOnly before acquiring connection, as151 does
because tenant-self has an upstream billing exemption. Existing auth/boundary
precedence remains; no public or student route. Determine owner before looking up
course existence; then require active course id AND selected tenant on the same
connection. Null/foreign/inactive course indistinguishable404. Every unit lookup/
write includes course id, derives tenant via course; no body/header/query selector.
Lock course for writes to avoid concurrent archive/ownership-change scope races.

UUID ids, strict object keys/types; POST `{name, display_order?}` with trimmed
name1..255 and default display_order0. PATCH nonempty subset `{name,display_order,
status}`; status active/archived, order integer0..2147483647, no coercion. Unknown
keys (tenant/course/owner selectors, publication/paid fields) invalid. Names may
duplicate; numeric order may tie, stable id tie-breaker. PATCH order moves that
unit's metadata position without mass renumbering or a new ordering-policy claim.
No DELETE/move-to-course/assignment endpoint. No-op PATCH returns canonical DTO
without extra audit/update. Concurrent same-unit writes serialize under row lock;
no fabricated idempotency or optimistic-version promise.

New table `course_units`: UUID id PK, course_id FK to existing courses(id), name,
display_order nonnegative signed-INT range, status active/archived, created_at/
updated_at. Index(course_id,display_order,id). Derive tenant by course join: do NOT
duplicate tenant_id with inconsistent independent FKs or ALTER existing courses.
No destructive SQL, backfill, migration execution, lessons/materials schema.
Explicit fixed DTO `{id,course_id,name,display_order,status,created_at,updated_at}`;
no row spread/tenant/owner/contact/billing fields. UTC timestamp serialization
documented and tested; preserve server truth, no fake/fallback DTO.

GET bounded keyset order(display_order,id), default25/max100 and limit+1 query;
opaque validated canonical cursor contains only order/id, max256 chars. Validate
shape/range/length/cursor before connection acquisition. Scope every page to the
current selected tenant/course, no totals/all-page drain/offset. Return
`{units,next_cursor}`. Include private archived metadata for owner; no publish claim.
All own outcomes set no-store before await, upstream outcomes unchanged.

## Transactions/audit and verification

Create/update and audit_events in same connection/transaction, existing audit
column conventions. Audit excludes secrets/full students; fixed old/new metadata,
actor/derived tenant/course/unit references. Return confirmed success only after
commit; rollback on failure, destroy uncertain commit/failed begin/failed rollback
connections rather than pool reuse. Release exactly once on safe paths; never
release plus destroy. GET consistent guarded scope, close read transaction safely.
Document acquisition/read/write/audit/commit/cleanup failure statuses; no auto write
retry/idempotent-create claim. No change to existing profile/branches behavior.

Inspect safe existing151 tests/import sentinels first. New suite must intercept
DB/MinIO/default renewal/dotenv BEFORE any app module import, assert forbidden
module bodies/cache/default adapters not used. Exercise real factory PLUS real
tenant-self mount and auth/boundary order with injected leaf repositories; no
handler copies, text-only SQL substitutes or listener/socket. Do not import whole
server index. Existing real auth/boundary factories use isolated fixtures; no
dummy production environment or service-client fallback.

Tests: valid create/read/rename/order/archive/reactivate/noop, body/id/cursor/limit
bounds, foreign/null/inactive course/unit isolation, owner-vs-membership/nonowner/
student/admin/unauth/missing selection/billing-only, active user/tenant, selected
scope switch, route mount, fixed DTO/no-store, stable keyset ties/request/row bounds,
atomic audit/order/row locks, every connection failure cleanup including uncertain
commit. Fake DB assertions must cover actual parameters and authorization/transaction
order, not just return canned success. Migration FILE invariants inspect read-only.
Live MySQL concurrency/query plans/FKs/runtime rollout remain unproven.

Run new hermetic suite + unchanged `server/tests/m2-tenant-profile.test.ts`,
`m2-tenant-profile-update.test.ts`, `m2-tenant-branches.test.ts` (positively isolated
95 tests), server tsc `--noEmit -p server/tsconfig.json`. No legacy auth-boundary/
m1-expanded-tenant-admin suites/default DB/dotenv, optional lint/TEMP diagnostics,
source reconstruction or source-disable probes. Report actual commands/results,
performance only bounded query/rows/cleanup evidence, not unmeasured latency.
Checkpoint real milestones; stop ALL edits/checks before native MCP stopped report
and concise worker Markdown. Codex independently reviews code/contracts/types/tests
and sends same-scope corrections as needed. No timer change/self-acceptance.

Completion is private owner unit metadata API + migration FILE acceptance only;
no full C5/M2 closure, runtime migration, teacher assignment or new product policy.
