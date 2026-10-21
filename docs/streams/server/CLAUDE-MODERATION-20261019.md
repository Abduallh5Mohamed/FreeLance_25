# Claude moderation correctness audit - 2026-10-19

Task: claude-moderation-correctness-20261019-01 (exclusive files: routes/services moderation, m7-moderation.test.ts).

## Source hashes (sha256)
| File | Baseline | Current |
|---|---|---|
| server/src/routes/moderation.ts | 4780ced6...db49f | fe1c9fa4...5d17 |
| server/src/services/moderation.ts | 6e615b40...c7098 | 07b5eb9c...f708f |
| server/tests/m7-moderation.test.ts | cbea59ba...8b7d5 | ef7ca86a...a371e |

## Commands
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m7-moderation.test.ts`
  - baseline: 26 pass / 0 fail
  - after adding 6 reproduction tests (before fixes): 26 pass / 6 fail (all six new tests failed)
  - current: 32 pass / 0 fail
- tsc over server: no moderation-file diagnostics observed (other writers' errors not triaged).

## Defects proven (failing test first) and fixed
1. Appeal-decision allowed the case reporter to resolve the appeal (decision path blocked reporter; appeal path did not). Added reporter check -> 403.
2. Assign allowed the reporter / content author to be assigned (or self-assign) as reviewer, producing a case only a platform moderator could decide. Now 403 (self) / 400 (other).
3. assignCase had no optimistic guard: two concurrent assigns silently overwrote each other. `assignCase(..., expectedReviewerUserId)` adds `assigned_reviewer_user_id <=> ?`; 0 rows -> 409.
4. SQL recordDecision / setStatus had no state guard (only id+tenant): concurrent decisions both succeeded and the history unique-key collision surfaced as 500. Now `status IN ('open','in_review')` for decisions, `= 'appealed'` for appeal decisions, `= 'decided'` for filing an appeal; ER_DUP_ENTRY mapped to 409 on assign/decision/appeal-decision.
5. Content action (hide/delete/restore) was applied on a separate connection, so a failed history/audit write rolled back the case but not the content. `ApplyContentActionInput.db` now carries the transaction data access; production gateway uses it.

## Verified no defect
Duplicate report (unique key + ER_DUP_ENTRY -> 409), single-appeal (insert affected-rows + unique), tenant/cross-tenant 404, platform vs tenant authority from verified callbacks (not JWT role), notification failures are best-effort, pagination cap (<=100, invalid -> 400), evidence stores hash only, all mutations audited in the transaction, history append-only.

## Remaining / limits
- Real SQL behaviour (row locks, `<=>`) is asserted by statement text only; no DB was run.
- Evidence snapshot is not tenant-filtered in the production gateway (report row is trusted); not changed (no proven forgeable path).
- Whole-suite and typecheck run deferred to coordinator.
