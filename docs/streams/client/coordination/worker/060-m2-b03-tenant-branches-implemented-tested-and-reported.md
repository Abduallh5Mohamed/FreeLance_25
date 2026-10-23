# M2-B03 tenant-owned branch metadata — implemented, verified and reported

**Task:** `client-m2-b03-tenant-branches-20261019-01` (team `backend`, role
`m2-b03-tenant-owned-branch-metadata`, approval version 2).
**Worker:** `opencode-cli-m2-b03-20261019` — claimed once in this native
session; the claim was never re-claimed, replaced, retired or transferred.
**UTC:** 2026-10-19T18:10Z — **Branch:** `codex/human-client`.
**Basis:** human148 direct CLI execution of the exact presented M2-B03
proposal; [148](../supervisor/148-human-direct-cli-starts-presented-branch-batch.md)
and the same-owner safe continuation
[149](../supervisor/149-b03-direct-cli-same-owner-safe-check-continuation.md).
The native session ID is not exposed by the available tooling; no claim file
was read and no private claim state was inspected.

## Changed paths — exactly the four approved paths

- `server/migrations/20261019_01_tenant_branches.sql` — **new**, additive
  schema FILE only. One `tenant_branches` table: `id CHAR(36)` primary key,
  `tenant_id CHAR(36) NOT NULL` FK to `tenants(id)`, `name VARCHAR(255)` (no
  uniqueness — the id is the identity, duplicate names are allowed),
  `status ENUM('active','archived')`, `created_at`/`updated_at` timestamps, and
  two indexes (`tenant_id,id` for the keyset read; `tenant_id,status,id` for
  status-scoped listing). No ALTER/DROP, no seed, no backfill, no default
  branch, no runtime DDL. **The file was not applied**: no database was
  connected and no statement was executed.
- `server/src/routes/tenant-self.ts` — **additive only**. A module-level block
  of branch constants/DTO/cursor/validation helpers, plus three routes inside
  `createTenantSelfRouter`: `GET /branches`, `POST /branches`,
  `PATCH /branches/:branchId`, and two local helpers (`denyBillingOnly`,
  `verifyBranchOwner`). The accepted M2-B01/M2-B02 profile handlers, the
  subscription/billing/topup/renewal handlers, the shared `authenticate`
  middleware, the shared boundaries, `index.ts` and every other router are
  untouched. The only non-additive lines in the file are inside the new block
  itself.
- `server/tests/m2-tenant-branches.test.ts` — **new**, 44 hermetic behavioral
  tests.
- `docs/streams/server/M2-B03-CONTRACT.md` — **new**, the exact DTO, policy,
  status table, atomicity rules and coverage limits.

This coordination message is the fifth file and is coordination reporting only;
it authorizes no product edit.

## Behaviour before / after

- **Before:** no branch table, no branch relation and no branch endpoint in the
  inspected local source. `GET /api/tenants/me` exposed only the accepted
  profile/subscription/billing/topup/renewal surface.
- **After:** owner-controlled create/list/rename/archive **metadata** for the
  branches of the server-selected tenant, on an additive migration file.

Key decisions, all inside the approved policy:

- **Owner-only, resolved from server-side rows.** The caller must be the
  verified `tenants.owner_user_id` of the selected tenant, the tenant must be
  active and the caller's user row active. A membership role label
  (`owner`/`instructor`) never grants branch visibility or writes — the
  instructor read authority of the profile endpoints is deliberately not
  extended to branches. Writes verify under `FOR UPDATE`; the list verifies
  with a plain snapshot select inside its own transaction.
- **Local billing-only denial before any data access** (supervisor146 finding):
  `auth.ts:68-75` exempts the whole `/api/tenants/me` prefix, so each branch
  route checks `req.user.billingOnly` itself and refuses before taking a
  connection. The shared auth middleware and its exemptions are not edited.
  The denial message is branch-specific, so the local guard is distinguishable
  from the upstream authentication denial.
- **Tenant-qualified everywhere.** The list is `WHERE b.tenant_id=? AND b.id>?`
  and every branch lookup/update qualifies **both** the id and the tenant. A
  foreign id and an absent id return the identical `404 Branch not found`, so no
  ownership is disclosed. The cursor is a position only — it never replaces
  the tenant qualification.
- **Bounded deterministic list.** Ordered by the branch id (a unique, total,
  stable order needing no timestamp/timezone interpretation), read with a
  keyset cursor, default 25, maximum 100, one extra row read to detect a
  successor and never more rows returned than requested.
- **Strict writes.** `POST` accepts only `{ name }` (trimmed 1..255).
  `PATCH` accepts only `name` and/or `status` (`active`/`archived`), rejects an
  empty update and rejects unknown keys. A malformed branch id is 400; a
  well-formed foreign/absent id is 404.
- **Atomic write + audit, truthful no-op, honest uncertainty.** The insert and
  the audit event share one transaction (`tenant.branch_created` /
  `tenant.branch_updated`, `resource_type='tenant_branch'`). A failed audit
  rolls the write back. An identical update writes and audits nothing. A lost
  commit acknowledgement is reported as uncertain: no rollback is claimed, no
  success is fabricated, no automatic retry, and the connection is destroyed
  rather than pooled. There is **no** POST idempotency-key system and none is
  claimed. Connection ownership is explicit: failed acquisition → no cleanup;
  failed `beginTransaction` → destroy; successful rollback or commit → release
  exactly once; failed rollback or ambiguous commit → destroy, never release.
- **`no-store` on every own outcome** (200, 201, 400, 403, 404, 409, 500),
  set before the first `await` and before any denial. Upstream auth/boundary
  answers keep their pre-existing shape.
- **No assignment or access effect.** Archiving changes branch metadata only.
  No enrollment, group, teacher, wallet, payment or subscription statement is
  reachable from these routes.

## Exact commands and outcomes

All commands are local, installed Node tools; no network fetch, no install, no
service, no browser, no Git write, no migration application.

| Command | Result |
|---|---|
| `node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` (server, **before** the change) | exit 0, 0 diagnostics |
| `node .\node_modules\tsx\dist\cli.mjs --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts` (**before**) | 51/51 pass, exit 0 |
| `node .\node_modules\tsx\dist\cli.mjs --test tests/m2-tenant-branches.test.ts` (during) | 44/44 pass, exit 0 after 3 test-side corrections |
| `node .\node_modules\tsx\dist\cli.mjs --test tests/m2-tenant-branches.test.ts tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m1-expanded-tenant-admin.test.ts tests/auth-boundary.test.ts` (**final**, after the change) | **118/118 pass, 0 fail, exit 0** |
| `node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` (server, **after** the change) | exit 0, **0 diagnostics** |
| `node ..\node_modules\eslint\bin\eslint.js src/routes/tenant-self.ts tests/m2-tenant-branches.test.ts` | 80 errors, **all** `@typescript-eslint/no-explicit-any` (76) and `@typescript-eslint/no-require-imports` (4) |
| `node ..\node_modules\eslint\bin\eslint.js tests/m2-tenant-profile-update.test.ts` (accepted M2-B02 baseline) | 46 errors, **the same two rules only** |

The lint findings are the repository's established, already-accepted
convention, not a defect introduced by this batch: the accepted M2-B02 suite
`server/tests/m2-tenant-profile-update.test.ts` reports the same two rules for
the same reasons (the `any`-typed SQL seams and the `require()`-based import
isolation the M2-B01/M2-B02 suites already use to prove positive import
isolation). Per [150](../supervisor/150-b03-no-reconstructed-baseline-or-optional-lint.md)
the lint is **optional and not a gate**, no further lint or baseline-diff
experiment was run, and **no pre-B03 source file was reconstructed**: the
command that would have built such a baseline was denied by the local
permission guard and was not retried or worked around. The pre-change type and
test baselines quoted above are **fresh measurements taken in this session
before any edit** (tsc exit 0 / 0 diagnostics; the two accepted M2 suites
51/51), not a synthetic snapshot.

**Baseline failures:** none. The pre-change type check and the two accepted M2
suites were both green before the change and stayed green after it. No test
failed at any point in the final state.

**Corrections made during the run** (test-side only, product code unchanged):
three initial failures in the new suite were fixed in the test file — a
misspelled constant, a `res.events` typo that read the response instead of the
harness, and two payload cases that the shared tenant-authority boundary
answers before the handler (they are now asserted as upstream answers, which
keep their pre-existing shape and do not carry the handler's `no-store`).

## Remaining limits and blockers

- No real MySQL, no real HTTP, no provider, no Docker. Real row locking, real
  concurrency, real index usage for the keyset read and the real `ENUM`
  constraint are **not** exercised: the injected fixtures cannot replay a
  physical rollback, so the atomicity assertions prove the decision boundary
  (the call sequence: rollback without commit), not the physical effect.
- The migration file was **not applied**; static SQL inspection is not
  migration execution and not constraint validation. The schema shape and
  deployment compatibility need review before any application.
- The billing-only denial is proven at the handler boundary with a real
  authentication middleware and an injected principal repository; the shared
  authentication middleware itself is not modified.
- The `limit`/`cursor` query contract is proven at the handler boundary; the
  upstream query parser is not re-implemented.
- No performance, throughput or latency claim is made; no measurement was
  taken. The list is bounded by construction (hard 100-row cap), not by a
  benchmark.
- A **POST create is not idempotent and is not claimed to be**: a retried
  create produces a second branch. Deduplication needs an explicitly designed
  idempotency contract, which is outside this batch.
- Optional lint was run and is reported as measured; it is not a gate
  (supervisor150). No pre-B03 source reconstruction, TEMP file creation,
  source copy/rewrite/restore or private-file inspection was performed; the
  one denied call was not retried.
- OTP stays deferred. No self-acceptance is claimed; acceptance is Codex's
  independent review of the actual source, schema draft, architecture,
  contract, tests and types.

**Status:** all four approved paths are implemented, verified and stable on
disk. All activity on this claim has stopped. Awaiting Codex's independent
review.
