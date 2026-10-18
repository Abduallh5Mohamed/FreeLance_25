# M5 G2+G3 — recurring schedules/calendar and manual attendance records (2026-10-18)

## Files changed
- `server/src/services/schedules.ts` — pure G2 domain policy: recurrence
  normalization (`weekly`/`monthly`), a bounded, clock-free recurrence expander
  (`expandRecurrence`) that converts each local wall time to the DST-correct
  absolute UTC instant and clamps a monthly day-of-month to the month end,
  create/cancel/reschedule payload validation, and (re-exported) deny-by-default
  schedule audience visibility from the C11 contract.
- `server/src/routes/schedules.ts` — router factory `createSchedulesRouter(deps)`
  plus a production default-wired instance. Series creation materializes
  sessions; cancel/reschedule are audited with actor/time/reason; an injected
  notification hook is invoked after commit.
- `server/src/services/attendance-records.ts` — pure G3 policy: state
  normalization (`present`/`absent`/`late`/`excused`), single/bulk/correction
  payload validation (bulk rejects duplicate students, corrections require a
  reason), and the deny-by-default `isStudentEligibleForSession` decision.
- `server/src/routes/attendance-records.ts` — router factory
  `createAttendanceRecordsRouter(deps)` plus a production default-wired
  instance. Idempotent marking, audited corrections, atomic bulk marking, and a
  student self-view.
- `server/migrations/20261018_11_schedules_attendance_records.sql` — idempotent
  schema file (authoring-only, never executed at runtime).
- `server/tests/m5-schedules.test.ts` — 26 pure + router tests.
- `server/tests/m5-attendance-records.test.ts` — 25 pure + router tests.
- `server/bootstrap/m1/manifest.json` — added the new migration's SHA-256 (see
  disclosure below).
- `docs/streams/server/M5-G2-G3-DELIVERY.md` — this note.

## Behavior

### G2 — schedules/calendar
- **Recurrence is pure and tested.** `expandRecurrence` accepts `weekly`
  (ISO weekdays 0..6) or `monthly` (`day_of_month` 1..31) between an inclusive
  `starts_on` and an optional inclusive `ends_on`, bounded by a hard cap. It is
  deterministic and returns `[]` for any invalid rule (fail closed).
- **DST and month-end edge cases.** Each occurrence is authored as a local wall
  time in an IANA timezone and converted with `localWallTimeToInstant`, so a
  weekly 09:00 `America/New_York` series shifts from `14:00Z` (EST) to `13:00Z`
  (EDT) across the 2026-03-08 change while keeping the same local time. A
  monthly day 31 lands on 2026-02-28 (Feb has no 31st), 2026-04-30, etc.
- **Audience is tenant/branch/group and deny-by-default.** A branch target must
  be an active branch of the caller's tenant; a group target must belong to the
  tenant and (for a non-owner) be owned by the caller. Students only receive
  sessions inside their own audience (tenant, proven branch, or proven group),
  filtered in SQL so out-of-audience rows are never loaded.
- **Cancel/reschedule are audited (actor + time + reason).** Both require a
  reason (`400` without it); the audit row is written in the same transaction as
  the `version`-guarded update, so a failed audit aborts the change.
- **Session access is row-scoped.** A non-owner may only act on a session in a
  group they own, a branch they belong to, or a session they created; the load
  is a single tenant-scoped query with that predicate, so a foreign session is
  `404`.
- **Notification hook (injected, no delivery).** `ScheduleNotifier.notify(event)`
  is called after commit for `series.created`/`session.cancelled`/
  `session.rescheduled`. It is best-effort: a hook failure is logged and never
  rolls back or hides a committed change. Production defaults to a no-op.

### G3 — manual attendance
- **Four states**, actor/time/reason recorded (`marked_by`/`marked_at`/`reason`).
- **Duplicate marking is idempotent.** `UNIQUE (session_id, student_id)` is the
  DB backstop; an identical re-mark is a `200` no-op and a changed state is an
  audited correction with before/after. Marking a cancelled session is `409`.
- **Only enrolled students of that session.** One SQL predicate enforces tenant,
  active/approved enrollment, and the session's group/branch scope; any other id
  is `403` and nothing is written. Eligibility is also a pure deny-by-default
  decision with direct unit coverage.
- **Teachers only their tenant/branch/groups.** The session is loaded under the
  non-owner visibility predicate (owned group, member branch, or created-by), so
  a cross-tenant or foreign session is `404`.
- **Bulk marking is atomic.** The whole batch runs in one transaction and is
  audited per record; a duplicate student in the payload is rejected (`400`), an
  ineligible student rejects the whole batch (`403`), and any audit failure
  writes nothing (`500`).
- **Student self-view** (`GET /me`) returns only the caller's own records.

## Endpoints
Schedules (staff: owner or active instructor):
- `GET /` — list series in the caller's visibility.
- `POST /series` — validate + expand + materialize sessions (`201`, audited, notified).
- `GET /sessions` — list sessions (optional `group_id` filter).
- `POST /sessions/:id/cancel` — cancel with reason (`200`, audited, notified).
- `POST /sessions/:id/reschedule` — reschedule with reason (`200`, audited, notified).
Student (own audience):
- `GET /student` — scheduled sessions inside the caller's audience.

Attendance (staff: owner or active instructor):
- `GET /sessions/:sessionId/records` — records for one session.
- `POST /sessions/:sessionId/records` — single mark (`201` created, `200` idempotent/corrected).
- `POST /sessions/:sessionId/records/bulk` — atomic bulk mark (`200`).
- `POST /records/:recordId/correct` — audited correction (`200`).
Student (own records):
- `GET /me` — the caller's own attendance history.

## Schema (file only, not executed)
- `schedule_series` — tenant-owned recurrence definition; `timezone`,
  `recurrence`, `weekdays`, `day_of_month`, `starts_on`/`ends_on`,
  `start_time`, `duration_minutes`, `status`.
- `schedule_sessions` — concrete UTC occurrences; `UNIQUE (series_id, starts_at)`
  makes re-materialization idempotent; cancel/reschedule columns
  (`cancel_reason`/`cancelled_by`/`cancelled_at`, `rescheduled_from`/
  `reschedule_reason`/`rescheduled_by`/`rescheduled_at`), `version`.
- `attendance_records` — `state` ENUM, `reason`, `marked_by`/`marked_at`,
  `corrected_at`/`corrected_by`/`correction_reason`, `version`; the duplicate
  guard is `UNIQUE (session_id, student_id)`.
- Idempotent via `INFORMATION_SCHEMA` probes + `PREPARE`/`EXECUTE`; FKs added
  under separate name-guarded steps so an interrupted run converges.

## Tests
- Focused: `m5-schedules` 26/26, `m5-attendance-records` 25/25.
- Full suite: `node node_modules/tsx/dist/cli.mjs --test server/tests/*.test.ts`
  runs green (`# pass 1738 / # fail 0`), net +51 over the pre-task count.
- Typecheck: `tsc --noEmit -p server/tsconfig.json` clean.
- Coverage: pure recurrence (weekly, DST, month-end clamp, invalid rules, cap),
  audience visibility, payload validation, plus per-handler allow + deny
  (401 anonymous, 403 non-staff/cross-tenant/foreign target/ineligible student,
  400 invalid payload, 404 unknown/out-of-scope, 409 cancelled/same-state,
  500 audit failure), and notifier-invocation assertions.

## Open questions / follow-ups
- **Disclosed manifest edit.** `server/tests/m1-bootstrap-plan.test.ts` requires
  every migration's source hash in `server/bootstrap/m1/manifest.json`. Adding
  `20261018_11_schedules_attendance_records.sql` required one entry outside the
  task's file allow-list:
  `"20261018_11_schedules_attendance_records.sql": "c78aee467765666c8180aafd044b8f6900ec3e2602ffa8bcd73ad14d896acc0b"`.
  The bootstrap-plan test passes (2/2).
- **Routers are intentionally unmounted.** Both modules export a factory and a
  production default-wired router; no `server/src/index.ts` mount was added by
  this task (mounting is a later step). Default exports are wired instances, not
  factories.
- **Known unrelated full-suite flake.** On some concurrent runs the Node test
  runner reports `notify-preferences.test.ts` as
  `ERR_TEST_FAILURE: Unable to deserialize cloned data due to invalid or
  unsupported version` (a runner IPC error, not a test assertion). Every green
  run of the full suite passes all 1738 tests; the flake is not in M5 code.
- **Standalone (non-recurring) sessions and automatic G4 attendance are out of
  scope** for this batch; `schedule_sessions.series_id` is nullable so a future
  one-off session flow needs no schema change.
