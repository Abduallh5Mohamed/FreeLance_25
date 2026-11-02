# M5 attendance-records fixtures corrected, tested and reported

Task: `audit-20261026-m5-attendance-records-fixtures-01`
(worker `opencode-m5-attendance-fixtures-20261026-01`, correction lane).
Supervisor alone decides acceptance. No Git/GitHub command was used; no live DB,
migration, provider, payment, network, package install, listener or deployment was
used. Native session ID was not available to this CLI session.

Worker timer `Tabweb-OpenCode-Worker-15min` is **Disabled**; at the end of the work
window its stale NextRunTime read `2026-10-26 12:18:58 +03:00` (Africa/Cairo), so
that is a scheduled trigger label, not a guaranteed worker start. Human152 directs
supervisor-managed CLI and Codex review; no schedule was changed or enabled.

## Changed paths

- `server/tests/m5-attendance-records.test.ts` (the only allowed path)
- Coordination report only: this file.

No production route, source, shared helper or WorkBuddy M2-23 path was edited.
`server/src/routes/attendance-records.ts` and `server/tests/helpers/m2-harness.ts`
were read only.

## Baseline and classification of the 15 failures

Supervisor baseline and this run both reproduced **27 pass / 15 fail** under the
external-I/O denial guard before edits. Every failure was stale fixture shape, not
a production defect:

1. **Twelve eligibility-related failures** (`new mark`, `identical re-mark`,
   `changed re-mark`, `duplicate-key race`, `bulk atomic`, `changed re-mark
   without reason`, `blank correction reason`, `reason kept on row`, `bulk
   reasonless correction`, `audit failure`, `stale single`, `stale bulk`): the
   test predicate looked for `FROM students s LEFT JOIN`, but the route now emits
   `SELECT s.id FROM students s ... ORDER BY s.id ASC FOR UPDATE` with the
   group/branch predicate applied directly. The fake returned no eligible rows,
   so correct requests became 403.
2. **Two correction failures** (`correction is audited with before/after`,
   `correction endpoint writes reason and correction_reason`): the stale fake
   answered only the correction lookup. The current route revalidates the
   canonical session with a locking read inside the transaction, so the empty
   fake session load produced 404. That revalidation is expected production
   behavior, not a defect.
3. **One branch denial failure**: the assertion required an obsolete unqualified
   `group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?)` on the
   session read. Current behavior reads the session by exact id/tenant under
   `FOR UPDATE`, then reads the exact assigned `groups` row under `FOR UPDATE`.
   The branch token alone still cannot widen access.

No production defect was found; production source was not changed and no
expectation was weakened to hide behavior.

## Fixture correction

- Replaced the obsolete eligibility predicate with `lockingEligibilityQuery`
  (`SELECT s.id FROM students s` + `s.id IN (` + `FOR UPDATE`).
- Added `eligibleRows`, which parses the requested student binds and returns only
  declared students, while enforcing the canonical tenant and exact
  group/branch scope bind. Fake data can no longer grant eligibility for a wrong
  tenant, group or student.
- Added `sessionRows` and `correctionRows`, which resolve a session/record only
  for the exact canonical id/tenant bind instead of matching SQL shape alone.
- Updated every affected responder, including per-student bulk lookups.
- Correction tests now supply the canonical locked session fixture required by
  the route's in-transaction revalidation.
- The branch test now supplies a foreign session created by another instructor
  and asserts: tenant-scoped `WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE`
  session read, no branch/group-subquery widening, a locked exact `groups` row
  read with `['grp-1', 'tenant-a']`, and no insert.
- Denial tests now assert the current locking eligibility SQL/group bind and/or
  no insert/update: student-not-enrolled (403), bulk ineligible (403), and the
  correction visibility denial (404, no update).
- All 42 tests remain; auth, tenant, exact-assignment, atomicity, audit,
  duplicate-key race, stale-version and denial assertions are preserved.

## Verification (exact commands / results)

Run from `D:\FreeLance_25-1\FreeLance_25-1` unless noted.

| Command | Result |
|---|---|
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m5-attendance-records.test.ts` | **42 pass / 0 fail / 0 skipped** (baseline 27/15) |
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m1-attendance-calendar.test.ts` | **18 pass / 0 fail** |
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m1-sprint-attendance-boundary.test.ts` | **29 pass / 0 fail** |
| `npm run build` in `server/` | exit 0, no diagnostics |

## Limits

- Hermetic guarded fake-database tests plus a TypeScript build only; no live
  MySQL, migration application or production acceptance is claimed.
- The required build regenerated gitignored `server/dist`; no tracked source
  outside the allowed test path was edited.
- Supervisor decides acceptance and any further correction.
- Worker timer remains disabled; Codex review cadence is supervisor-managed. The
  next check label from Windows was `2026-10-26 12:18:58 +03:00` Africa/Cairo (as
  read at 12:14:26), not a promised start.
