# Claude attendance correctness - 2026-10-19

Task: claude-attendance-correctness-20261019-01 (not production/phase acceptance).

## Source hashes (sha256)
| File | Baseline | Current |
|---|---|---|
| server/src/routes/attendance-records.ts | 535751ec...07394 | 87a4fb08...a82c |
| server/src/services/attendance-records.ts | 81a05879...01e2 | unchanged |
| server/tests/m5-attendance-records.test.ts | ed2f5c04...7b2b3 | ddbeb8fb...182ab |

## Verified no-defect
- States, validation (reason length, bulk size/dup), cancelled-session 409, tenant + visibility-scoped session load, eligibility SQL (tenant, active, approved, enrollment window, group/branch), bulk eligibility all-or-nothing (403, no write), /me own rows only: all as designed and tested.
- First-mark duplicate-key race (review-m4-m5 finding 11): already fixed (FOR UPDATE re-read, returns winner as unchanged, no audit) and proven by existing test.
- Correct endpoint version guard already returned 409.

## Defect found and fixed
Stale-version correction through POST /sessions/:id/records and /records/bulk threw a generic Error when the version guard UPDATE affected 0 rows, giving 500. Now an AttendanceConflictError (thrown inside the atomic section, so the transaction rolls back, no audit) maps to 409.
Tests added (failed 500 before, pass after): single mark and bulk stale-version -> 409, no attendance.correct audit.

## Commands
- node node_modules/tsx/dist/cli.mjs --test tests/m5-attendance-records.test.ts (server cwd): before fix 26 pass / 2 fail; after 28 pass / 0 fail.
- node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json: exit 0, no output.

## Observations, not changed (policy, not proven defects)
- Branch-wide visibility lets any instructor with a branchId mark any session in that branch (same predicate as schedules); not narrowed to exact group instructor.
- Re-mark with changed state accepts an empty reason (correct endpoint requires one); it also overwrites `reason`.
- Race loser requesting a different state than the winner gets 200 idempotent with the winner's state (honest, but not applied).
- Eligibility check runs before the transaction (no lock); revocation in that window not guarded.
