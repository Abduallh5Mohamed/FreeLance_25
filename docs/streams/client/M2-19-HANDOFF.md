# M2-19 handoff: private bounded group weekly schedules

Task: `client-m2-19-private-group-weekly-schedules-20261023-01`

## Goal and before/after

Before: the existing Groups screen already edits `schedule_days` and
`schedule_time`, but the server accepts arbitrary strings/JSON shapes, silently
nulls foreign course selectors, performs unscoped updates, and cannot explicitly
clear schedule fields. The page also has no stale-session/scope or duplicate-save
fences and can turn refresh failures into misleading mutation failures.

After: the existing private group screen reads and writes one canonical bounded
weekly schedule for an owned group. Days are the existing finite keys
`sat|sun|mon|tue|wed|thu|fri`, stored in that order without duplicates; time is
canonical `HH:mm` or null; explicit null clears. The server derives authority
from the authenticated selected tenant/teaching scope, validates referenced
grade/course rows without silently changing the request, commits the group and
one sanitized audit event atomically, and returns a bounded canonical DTO.

This is timetable metadata only. It creates no sessions, attendance, messages,
notifications, enrollment, access, billing, automatic dates or timezone rules.

## Exact allowed paths

1. `server/src/routes/groups.ts`
2. `server/tests/m2-group-schedules.test.ts`
3. `server/tests/m2-group-schedules-failures.test.ts`
4. `src/lib/api.ts`
5. `src/features/groups/group-schedules.ts`
6. `src/pages/Groups.tsx`
7. `src/tests/m2-group-schedules.test.ts`
8. `docs/streams/server/M2-B11-CONTRACT.md`
9. `docs/streams/client/M2-19-CONTRACTS.md`

## Required behavior

- Preserve the existing group screen and route mount. Bound list/detail/write
  rows to the authenticated instructor scope and current server-derived tenant
  authority; a request tenant/instructor selector never grants authority.
- Accept strict canonical group create/update data. Reject malformed/foreign
  course or grade selectors rather than silently replacing them. Support
  explicit null schedule clear and distinguish omission from clear.
- Canonicalize only the seven existing weekday keys, reject duplicates/unknown
  values, cap at seven, and accept time only as real `HH:mm` or null. Do not
  invent timezone, recurrence, attendance or automatic-session semantics.
- For writes, revalidate authority and target on one connection/transaction;
  update one owned group and one bounded sanitized audit record atomically.
  Truthful no-op retries write and audit nothing. Use safe rollback/release and
  uncertain-commit destruction.
- Extract a testable client controller for independent reads, strict canonical
  parsing, explicit edit/save/cancel, duplicate blocking, retained retryable
  drafts, denied/not-found cleanup, and session/scope/form/target/dispose fences.
- Preserve unrelated group/student behavior and all accepted dirty work. No
  migration, DB/network/browser/provider/service/install/Git/deploy/OTP/M3.

## Impact, tests and done

- Hermetic production-path server suites cover bounded reads, create/update/
  clear/no-op, tenant and instructor isolation, strict selectors/schedules,
  atomic audit, rollback/release and uncertain commit with zero partial writes.
- Client tests drive the production adapter/controller for load/create/edit/
  clear, exact DTOs, malformed bodies, duplicate submit, stale principal/scope/
  target/form replies, refresh-after-confirmation and cleanup.
- Run both new server suites, safe nearby group/teaching-access suites, the new
  client suite and scoped server/frontend types. Stop all activity before the
  MCP report; a worker report is not acceptance.

