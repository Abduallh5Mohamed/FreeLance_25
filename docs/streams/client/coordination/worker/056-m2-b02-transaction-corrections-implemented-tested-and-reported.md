# M2-B02 F1/F2 transaction corrections implemented, tested and reported

**UTC:** 2026-10-19T14:08:26Z — **Task:** `client-m2-b02-name-transaction-correction-20261019-01`
**Worker:** `opencode-scheduled-20261019-1704` — branch `codex/human-client`
**Review basis:** supervisor/128 F1/F2. Status: reported, **not accepted**.

## Native identity / claim

Claimed only this ready task through MCP. Native OpenCode session ID is unavailable
to this invocation; no mapping was invented. No other task claimed. No token or
credential appears in this report.

## Changed paths (exact three allowed)

- `server/src/routes/tenant-self.ts`
- `server/tests/m2-tenant-profile-update.test.ts`
- `docs/streams/server/M2-B02-CONTRACT.md`

No shared/router/auth/schema/service/package/config/client/Git change.

## Before -> after behavior

Before: `getConnection()` was outside `try`, so a rejected pool acquisition escaped
the handler; every `finally` released, including after a failed rollback or an
ambiguous commit, returning a possibly-open transaction/locks to the shared pool.

After (F1): acquisition is inside the protected lifecycle with an explicitly
tracked nullable connection. Acquisition failure returns the documented safe
`500 {error:'Failed to update tenant profile'}` with `Cache-Control: no-store` and
performs no cleanup because no connection exists.

After (F2): disposal is explicit. Committed success, confirmed rollback (denial,
no-op, 409, update/audit failure after a successful rollback) release exactly once.
A failed rollback, a failed `beginTransaction`, or a failed/ambiguous commit
destroys the connection exactly once and never releases it. An ambiguous commit
still never claims a rollback, success, or retry. The seam gained
`destroy(): void` (actual mysql2 `PoolConnection.destroy`), with no shared edit.
All prior authorization/SQL/no-op/audit/strict-payload/GET behavior is preserved.

## Validation actually run

- `node .\node_modules\.bin\tsx.cmd --test server/tests/m2-tenant-profile-update.test.ts`
  -> **31/31 pass**, exit 0. New coverage: acquisition failure (no cleanup),
  begin failure (destroy), lock/select failure (rollback+release), denial/no-op/409
  rollback failure (destroy, no release), commit-ack failure (destroy, no rollback),
  and exactly one release-or-destroy on success/clean paths.
- `node .\node_modules\.bin\tsx.cmd --test server/tests/m2-tenant-profile.test.ts`
  -> **20/20 pass**, exit 0 (accepted GET/profile regression).
- `node .\node_modules\typescript\bin\tsc --noEmit -p server/tsconfig.json`
  -> **0 diagnostics, exit 0** after the edits. The pre-edit baseline was exit 0
  per review128/predecessor evidence; a separate before-run was not repeated in
  this invocation.

## External artifact / limitations

The review128 external artifact `128-m2-b02-review-probes.test.ts` (and any
`*review-probes*` file) is absent from the supervisor/workspace, bridge directory
and OpenCode temp root, so the requested `--test-name-pattern=supervisor:` run could
not be executed. Equivalent production-handler regressions were added only inside
the approved test path; the absent artifact was not edited or fabricated.

Tests remain hermetic fixtures: no live MySQL, real row-level lock/concurrency,
HTTP, provider, Docker or performance proof. No 429/tool guard occurred. No
schedule, account, dependency, service or Git change was made. Codex acceptance is
still required.

## Next owner action

Codex independently re-reviews the three paths, confirms F1/F2 disposal semantics,
then accepts or issues a bounded same-scope correction.
