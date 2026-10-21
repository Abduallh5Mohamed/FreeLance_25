# Schedule / attendance exact-assignment + DST boundaries — 2026-10-20

Task: `server-schedule-attendance-boundaries-20261019-01` (backend, worker
`wb-schedule-attendance-w2-20261019-01`). Not production/phase acceptance; the
final combined root+server-cwd suite, source typecheck and diff check belong to
the coordinator turn after all writers stop.

## Scope closed in this task

1. Exact-assignment session visibility for non-owner instructors in the
   schedules and attendance surfaces.
2. Nonexistent (DST spring-forward gap) local wall time handling in the shared
   `content-release` conversion, including the schedules and lesson-release
   callers, with rejection BEFORE writes.
3. Attendance correction reason requirement through the mark/bulk paths.
4. Series-create idempotency: schema inspected, additive proposal only.

Preserved unchanged: 24h session maximum, UTC server clock, cancel/reschedule
optimistic `status='scheduled' AND version=?` locking + audit, DST fall-back
overlap resolution to the first instant, owner exception, assigned-group
subquery evaluated live, created-by ownership, student feeds, notification hook
contract (fakes only; no real provider calls).

## Baseline verified before edits

- `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/m5-schedules.test.ts server/tests/m5-attendance-records.test.ts server/tests/m2-content-release.test.ts` → 135 pass / 0 fail.
- `cd server && node node_modules/typescript/bin/tsc --noEmit` → exit 0.

## Defects reproduced BEFORE the fix (each by a failing test first)

Focused run after adding tests, before fixes: **152 tests, 138 pass, 14 fail**:

| Failing test (before) | Defect |
|---|---|
| m2-content-release: `wall time -> instant: a nonexistent spring-forward wall time is denied (roundtrip), not shifted an hour earlier` | `localWallTimeToInstant` resolved 2026-03-08 02:30 America/New_York to `06:30Z` (= 01:30 EST), silently an hour earlier than the authored time |
| m2-content-release: `validateReleaseConfig: a scheduled release inside the DST gap is denied before any write` | a scheduled lesson release could be configured with a nonexistent local time |
| m2-content-release: `release config: a scheduled release inside the DST gap is 400 before any write` | same defect through the real `PUT /releases/:lectureId` route |
| m5-schedules: `DST contract is stable: … gap yields no occurrence, overlap exactly one` | gap date produced one silently-shifted occurrence |
| m5-schedules: `expandRecurrenceDetailed reports every nonexistent DST-gap date instead of shifting it` | no signal existed to reject a gap-hitting recurrence before writes |
| m5-schedules: `schedules: series create denies a recurrence whose wall time does not exist (DST gap) with 400 and no writes` | series create materialized the shifted instant and wrote series + sessions |
| m5-schedules: `schedules: reschedule into a nonexistent local time is 400 with no write` | reschedule accepted a nonexistent local time |
| m5-schedules: `schedules: a verified branch membership alone does not widen a non-owner list …` | non-owner visibility SQL contained `OR schedule_sessions.branch_id = ?` bound to the caller's verified branch membership |
| m5-schedules: `schedules: the exact-assignment load for cancel/reschedule carries no branch-membership grant` | same branch-membership OR-clause in the session-load predicate for cancel/reschedule |
| m5-attendance-records: `attendance: a verified branch membership alone does not widen the staff session load` | same defect in the attendance session-load predicate |
| m5-attendance-records: `attendance: a changed re-mark without a reason is 400 with no writes and no audit` | `POST /sessions/:id/records` accepted a changed state with no reason and wrote `reason=NULL, correction_reason=NULL` |
| m5-attendance-records: `attendance: a blank or whitespace-only reason on a correction is 400 with no writes` | blank/whitespace reason normalized to null and was accepted on a changed state |
| m5-attendance-records: `attendance: a bulk batch containing a reasonless correction is rejected 400 with no writes` | bulk accepted a reasonless correction |

## Changes (all inside allowedPaths)

### `server/src/services/content-release.ts`
`localWallTimeToInstant` now detects a nonexistent wall time by roundtrip: the
resolved instant is formatted back into the zone and must equal the authored
fields; otherwise it returns `null` (explicit denial). Valid times, the
UTC fallback for invalid zones, fractional historical offsets, and the
fall-back overlap policy (first/EDT instant) are preserved — all existing
callers already deny explicitly on `null` (content-access release validation,
schedules validation, announcements, assignments), so the gap is denied BEFORE
any write everywhere the helper is used.

### `server/src/services/schedules.ts`
Added `expandRecurrenceDetailed(rule, limit)` returning
`{ occurrences, nonexistentDates }`; `expandRecurrence` remains the
occurrences-only wrapper (unchanged signature). A DST-gap date is reported in
`nonexistentDates` and emits no occurrence. `resolveOccurrence` keeps the
storable-year-range skip separate from the gap classification.

### `server/src/routes/schedules.ts`
- `POST /series` uses `expandRecurrenceDetailed` and returns an explicit 400
  (naming the offending date/time) BEFORE any write when the recurrence hits a
  nonexistent local wall time.
- Non-owner `buildSessionVisibility` is now exactly: owner → tenant-wide;
  otherwise the live `groups.instructor_id` assigned-group subquery OR
  `created_by`. The branch-membership OR-clause is removed: a verified tenant
  or branch membership ALONE never grants an ordinary instructor every
  group/session. The subquery is evaluated per request, so a group
  reassignment or revoked assignment takes effect immediately. A branch/group
  selector on the list only AND-narrows. `StaffScope.branchId` removed (no
  longer read anywhere).
- Header comment rewritten to document the exact-assignment model.

### `server/src/routes/attendance-records.ts`
- Same visibility correction (removed branch-membership OR-clause).
- `applyMark` now throws `AttendanceValidationError` (→ 400) BEFORE any write
  when an existing record's state would change and no meaningful reason was
  supplied (undefined/empty/whitespace normalize to none). An exact-same mark
  stays an idempotent no-op without a reason. Bulk rejects the whole batch.
  The dedicated `/records/:id/correct` endpoint already required a reason;
  blank/whitespace denial and before/after audit are regression-tested.
- Header comment rewritten.

### Tests (`m5-schedules`, `m5-attendance-records`, `m2-content-release`)
17 new/updated tests (allow/deny/failure/positive-control), including: branch
membership does not widen list or session-load SQL (both surfaces), cross-branch
selector only narrows, series-create gap → 400 with no writes, reschedule gap →
400 and adjacent valid time → 200, roundtrip gap denial + valid conversion +
overlap first-instant, release-config gap denial at unit and route level with
no write, reasonless/whitespace correction → 400 with no writes and no audit,
valid correction retains the reason on the row, bulk reasonless rejection.
The pre-existing `DST contract is stable` assertion that a gap date yields one
(occurrence) was corrected to the authorized policy: the gap date yields none.

## Evidence

- Focused guarded hermetic suite (repo root cwd): **152 tests, 152 pass, 0 fail**
  (135 baseline + 17 new; before the fixes 138 pass / 14 fail).
- Sibling suites consuming the shared helper: `m2-announcements` + `m4-assignments`: **64/64 pass**.
- Full guarded hermetic suite (repo root cwd, extra evidence): **2285 tests, 2285 pass, 0 fail**.
- Source typecheck: exit **0** (session baseline and final state). One
  transient observation mid-session: `tsc --noEmit` briefly exited 2 with 5
  errors, all inside the untracked
  `server/src/middleware/impersonation-context.ts` while the concurrent
  impersonation-hardening actor was mid-write (mtime 2026-10-20 00:16); that
  file stabilized seconds later and the final run is exit 0 with no error
  referencing any file edited here.

## Series-create idempotency — proposal only (no SQL/migration written)

Inspection of `server/migrations/20261018_11_schedules_attendance_records.sql`:
`schedule_series` has PRIMARY KEY `id` (server-generated `randomUUID()`) and
secondary keys `idx_schedule_series_tenant/branch/group`; the only UNIQUE key
is on `schedule_sessions (series_id, starts_at)`, which dedupes re-materializing
one series id — it cannot dedupe a repeated `POST /series` (a second identical
payload creates a second series with a fresh id). No safe existing
constraint/seam exists, and no in-memory or request-timestamp dedupe was added.
Additive proposal for a follow-up scope (requires migration + API approval):

1. Schema: `ALTER TABLE schedule_series ADD COLUMN client_request_key VARCHAR(64) NULL AFTER id, ADD UNIQUE KEY uq_schedule_series_tenant_creator_key (tenant_id, created_by, client_request_key);` (nullable so existing rows and non-idempotent callers are unaffected; unique scope includes tenant + creator so two tenants can reuse the same client key).
2. API: accept an idempotency key on `POST /series` from the `Idempotency-Key` header or a `client_request_key` body field (same validation as `normalizeId` plus length ≤ 64), store it with the series.
3. Duplicate handling: on `ER_DUP_ENTRY` (errno 1062) against the new unique key, load the existing series under the caller's tenant + `created_by` and return it idempotently (200 with the same series id/session count, no second audit, no notification), mirroring the existing attendance duplicate-key race pattern (`FOR UPDATE` re-read, winner row authoritative). When no key is supplied, behaviour is exactly as today.

## Residual questions for Codex (not fabricated into code)

1. Branch-manager / teacher-wide policy: is a branch-bound non-owner instructor
   supposed to manage ALL sessions of their branch (the removed OR-clause)?
   The docs do not state such a capability explicitly (G1: "teacher only sees
   assigned groups"; B3/S10: no capability ⇒ no cross-teacher visibility), so
   the exact-assignment policy was enforced. If a branch-manager capability is
   desired it needs an explicit product decision AND a server-verified
   capability seam (a row-granted capability, never a string role); none exists
   in the current schema, so nothing was invented.
2. Non-owner series creation targeting `tenant` audience and any active
   `branch` audience remains as-is (unchanged by this task; documented as a
   policy decision in `CLAUDE-SCHEDULES-20261019.md`).
3. Adopt the series idempotency proposal above (schema + API) in a follow-up
   approved scope.

## Limits

- No DB, no SQL execution, no network/services, no Docker, no provider calls,
  no secrets/env edits, no dependency installs, no git writes. Hermetic fakes
  only; notifications are injected fakes.
- A long bounded `ends_on` still silently truncates at the occurrence cap
  (route 366 / hard 2000) — unchanged pre-existing policy question.
- `INSERT IGNORE INTO schedule_sessions` masking remains unchanged (unique
  conflict impossible with fresh ids and bounded years).
