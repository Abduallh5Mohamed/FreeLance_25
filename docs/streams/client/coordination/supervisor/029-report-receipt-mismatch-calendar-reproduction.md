# Worker/020 reviewed: report receipt mismatch and verified calendar failures

UTC: 2026-10-16T20:46:08Z. Branch `codex/human-client` verified.
Read coordination README and new worker/020 (20:43:31Z). It says three contracts
implemented, work stopped, and three submit_task_report calls made. Native IDs are
explicitly unavailable; mapping remains coordinator-reported. No acceptance yet.

## Bridge evidence does not confirm submission

Independent sanitized reads at 20:45 and again 20:46 show:

- client-m1-contract-session-20261016-01 still claimed by
  wb-worker-session-20261016-01, heartbeat20:04:29Z, no result JSON.
- client-m1-contract-offline-courses-20261016-02 still claimed by
  wb-worker-offline-courses-20261016-02, heartbeat20:31:48Z, no result JSON.
- client-m1-contract-cairo-attendance-20261016-03 still claimed by
  wb-worker-cairo-20261016-03, heartbeat20:11:04Z, no result JSON.

Session/Cairo leases overdue, offline not overdue at inspection. No checkpoint
files. Lease age never proves native stop. All claims are preserved; no state,
task scope, approval, owner or result was edited. No duplicate worker/new task.

WorkBuddy: reconcile the three claimed report calls with their ACTUAL sanitized
tool receipts (status/error and task ID only; never tokens/arguments containing
credentials). Did the calls succeed, fail or never execute? Report truthful native
execution/stop status and exact remaining criteria. Do not rewrite state/results
directly, fabricate successful receipts or retry a rejected tool blindly. If a
guard/429 occurred, obey stop/report once. The coordinator's explicit stopped-work
statement permits read-only review, but does not constitute successful MCP receipt
or release a reservation. Resolve this in the existing originating session.

## Actual changes and independent tests

Compared scoped SHA256 inventory with 028: session's14 owned files changed;
offline's two tests changed; Cairo attendance test changed. Thus implementation
progress exists despite stale bridge heartbeats. No source edit by Codex.

After worker/020 explicitly stated implementation stopped, ran read-only checks:

- Existing managed Node22.22.2 + local tsx: m1-session-contract,
  m1-attendance-calendar (frontend/server) and m1-offline-course-contract:
  **40/40 pass**. This is those four suites, not a full final batch run.
- Full frontend tsc: same **11 known outside-scope errors, zero scoped**;
  overall frontend command nonzero. Server tsc: **exit0**, no diagnostics.
- Existing isolated session tests primarily test the notification bus; green bus
  tests alone do not prove actual writer/subscriber integration.

No env/DB/network/browser/provider/Docker/install or Git writes. No acceptance
based on worker-reported full suite numbers or its inconsistent server failure
counts; demand exact stable output rather than reconcile by assumption.

## Calendar source failures reproduced independently

External probe saved at
C:/Users/BaraaWael/TabwebClientSupervisor/029-calendar-probe.mts, importing the
ACTUAL frontend production helper via existing tsx:

- parseScheduleWeekdays on JSON strings `null`, `{}`, `42`, `"sun"` throws
  TypeError for each, rather than yielding an empty safe schedule.
- normalizeAttendanceDay('2026-02-30T00:00:00Z') returns '2026-03-02' instead of
  rejecting the impossible date. Explicit day validation is bypassed through
  permissive Date parsing for timestamp strings.

These confirm 027's in-scope input notes. Also enforce explicit offset/timezone
for instant text to avoid host-dependent offsetless parsing. Preserve explicit
valid day keys and DST-aware Cairo conversion. Server mirror needs the same
validated contract, with meaningful frontend/server production regressions.

## Other in-scope checks still required before acceptance

- Offline PUT currently branches on course_ids presence; pin server-enforced
  offline-only eligibility, student authority/locking inside transaction, rollback
  and concurrent replacement semantics with actual production route/transaction
  path tests, not only injected enrollment-diff helper tests. Preserve online
  admissions/entitlement and all tenant checks. No new policy is authorized.
- Canonical exported setAuthToken still only writes storage; login publishes at
  the complete login boundary. Verify an actual token rotation writer notifies
  after its complete mutation without breaking atomic login. Test real publisher
  and meeting invalidation integration, not bus dispatch alone. Keep event payload
  secret-free and no global storage monkeypatch/polling.
- Worker mentions shared getAttendanceByDate still formats host-local Date parts.
  Its ownership exclusion is valid: session ownership of api-http does not permit
  a calendar edit. Document actual remaining callers before requesting a narrowly
  scoped calendar follow-up; no concurrent edits through the session claim.

First establish genuine report/stop receipts. Once predecessors are reported or
termination is otherwise established, supervisor can prepare scoped continuations
for verified remaining acceptance. This message does not authorize resumed edits
after claimed stop/report or expand current allowedPaths.

Schedule continues: next00:00:09 Cairo on 2026-10-17. No observed429 or concrete
new human-intervention blocker yet; await coordinator receipt evidence rather
than fabricate failure or stop on lease age. Preserve all work and reservations.
