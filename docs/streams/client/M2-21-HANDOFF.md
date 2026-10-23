# M2-21 handoff: private group announcements and audited lifecycle

Task: `client-m2-21-private-group-announcements-20261023-01`

## Goal and before/after

Before: accepted private group schedules let an instructor manage their own
group timetable metadata, but there is no bounded announcement lifecycle for
those groups.

After: an authenticated instructor can create, list, edit and retract bounded
announcements for groups they own. An announcement targets exactly one owned
group, carries a title/body and an explicit `published` or `draft` state, and
uses server timestamps. Every mutation is audited atomically. This is private
management metadata only: it sends no email/SMS/push, grants no access and does
not create attendance, sessions, enrollment or billing effects.

## Exact allowed paths

1. `server/migrations/20261023_02_group_announcements.sql`
2. `server/src/routes/groups.ts`
3. `server/tests/m2-group-announcements.test.ts`
4. `server/tests/m2-group-announcements-failures.test.ts`
5. `src/lib/api-http.ts`
6. `src/features/groups/group-announcements.ts`
7. `src/pages/Groups.tsx`
8. `src/tests/m2-group-announcements.test.ts`
9. `docs/streams/server/M2-B13-CONTRACT.md`
10. `docs/streams/client/M2-21-CONTRACTS.md`

## Required behavior

- Add one additive migration **file only**, never apply it. Store tenant,
  instructor, group, bounded title/body, state, created/updated/retracted server
  timestamps and tenant-safe bounded-list indexes. No recipient copies, delivery
  queue or provider fields.
- Extend the existing private groups router. Authority is the authenticated
  instructor plus the currently selected active tenant and an owned same-tenant
  group. Never accept tenant/instructor authority from request data.
- Provide bounded cursor list plus create/update/retract. Strict canonical
  payloads; fixed DTO; foreign/absent targets do not disclose cross-tenant
  existence. Revalidate authority and target inside each write transaction,
  write exactly one sanitized audit atomically, make truthful no-ops audit-free,
  and destroy uncertain connections.
- `draft` is private management state; `published` only makes the record visible
  through this authenticated management surface. Retraction is explicit and
  auditable. No scheduling/timezone policy, notification delivery or student
  consumption is invented in this batch.
- Extend the production adapter/controller/Groups page with bounded list,
  explicit create/edit/publish/retract and server-authoritative responses.
  Preserve principal/session/list/form/target/dispose fences, duplicate blocking
  and retained input on definite or uncertain failure.
- No OTP, account/invitation, access/role/enrollment, payment, provider/network,
  browser, live DB/service, dependency install, Git/deploy, M3 or migration
  application.

## Impact, tests and done

- Hermetic server suites cover strict DTOs, pagination, owner/tenant isolation,
  create/update/no-op/retract, audit atomicity and every cleanup/uncertain-commit
  path with DB/provider/default/dotenv isolation.
- Client production tests cover canonical transport, malformed projections,
  lifecycle actions, duplicate/stale replies, input retention and cleanup.
- Run both new server suites plus unchanged M2-19 group suites, the new client
  suite plus unchanged M2-19 client suite, and scoped types. Stop all activity
  before MCP report; report is not self-acceptance.
