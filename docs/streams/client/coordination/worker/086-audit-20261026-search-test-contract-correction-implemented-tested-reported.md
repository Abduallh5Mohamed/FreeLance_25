# m8-search test-contract correction implemented, tested and reported

Task: `audit-20261026-search-test-contract-correction-01`
(worker `opencode-audit-search-test-contract-20261026`, correction lane).
Supervisor alone decides acceptance. No Git/GitHub command was used; no live DB,
migration, provider, payment, network, package install or deployment was used.
Native session ID and model ID were not available to this CLI session.

## Changed paths (exact, within allowedPaths)

- `server/tests/m8-search.test.ts`
- Coordination report only: this file.

No production search code, route code, helper or active WorkBuddy M2-23 path was
touched. `server/src/services/search.ts` and `server/src/routes/search.ts` were
read only.

## Behavior before → after

The guarded baseline reproduced the three reported obsolete expectations:
35 pass / 3 fail. Each was corrected to assert the current production contract
without relaxing SQL binding or student branch authority:

1. `LIKE metacharacters and hostile input stay escaped bound parameters`
   - Before: raw hostile text (`"'; DROP TABLE courses; --"`) was passed directly
     to `buildStaffSearchQuery`, which correctly rejects a query that
     `normalizeSearchText` would change (`TypeError`).
   - After: `escapeLikeToken` is tested directly on raw `%`, `_` and `!`; the
     hostile query is normalized before entering the builder, and the test still
     asserts token-by-token bound parameters, `?`-count equality and zero
     interpolation. A separate `assert.throws` proves a direct non-normalized
     builder call is refused.
2. `W1: the production student resolver returns users.id ...`
   - Before: asserted `sql.includes('SELECT s.user_id')`, which fails against the
     current `SELECT DISTINCT s.user_id, ...` ambiguity-denying projection.
   - After: asserts the full `SELECT DISTINCT s.user_id, s.tenant_id,
     grp.branch_id, grp.branch_scope` projection and that `s.id` is never
     projected as the identity. The users.id-not-students.id boundary is intact.
3. `W1: branch restriction ... forged branch`
   - Before: expected a forged student `branch_id` to be ignored with 200.
   - After: the earlier no-selector request still proves the server-derived
     `br-1` binding and filters other-branch/draft rows. The forged selector now
     asserts exact `400 { error: 'branch_id is not a client selector for student
     search' }` and that `dataAccess.executed.length` did not grow, proving no
     extra viewer resolution or candidate read occurs.

## Verification (exact commands / results)

| Command | Result |
|---|---|
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m8-search.test.ts` | 38 pass / 0 fail (baseline was 35 pass / 3 fail) |
| `npm --prefix server run build` | exit 0, no diagnostics |
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m8-stabilization-mounting.test.ts` | 2 pass / 0 fail |

An optional combined mounting check
(`m8-stabilization-mounting.test.ts` + `m2-m3-mounting.test.ts`) produced
20 pass / 2 fail in `m2-m3-mounting.test.ts` (a `/api/public` mount collision and
an `/api/tenant/branding` anonymous 404). That file is outside this task's
allowedPaths and imports no search module; the failures are pre-existing/outside
this test-only change. The search-specific mounting suite passes.

## Limits

- Hermetic guarded tests and a TypeScript build only; no live MySQL, migration
  application or production acceptance is claimed.
- The required build regenerated `server/dist` build output; no tracked source
  outside `server/tests/m8-search.test.ts` was edited.
- Supervisor decides acceptance.
