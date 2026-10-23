# 082 — M2-19 unresolved selected-tenant read correction: implemented, tested, reported

**Task:** `client-m2-19-unresolved-tenant-read-correction-20261023-01` (team
`integration`, `approvalVersion 2`, `taskKind correction`,
`implementationWorker opencode`).
**Worker:** `opencode-native-m2-19-unresolved-tenant-read-20261023` (OpenCode native
direct CLI, supervisor-managed under human152/180). Claim token retained privately.
**Branch:** `codex/human-client`. **Status:** implemented, tested, **reported** — this
is **not acceptance**; Codex independently reviews.
**Reported at:** 2026-10-23 16:00 Cairo (13:00Z).

## Scope

The claim returned exactly three allowedPaths and only those were touched:

| Path | Change |
|---|---|
| `server/src/routes/groups.ts` | `scopePredicate` now requires a server-resolved tenant and always keeps the tenant predicate; `GET /` and `GET /:id` refuse an unresolved selection before any query |
| `server/tests/m2-group-schedules.test.ts` | the misleading “unresolvable tenant selector” expectation is replaced by a list+detail 404 regression with zero-SQL/no-value assertions |
| `docs/streams/server/M2-B11-CONTRACT.md` | read authorization, the 404 outcome row and the no-tenant paragraph now state the required refusal |

No other route, page, feature, test, contract, middleware, schema, migration or config
file was touched. Preexisting dirty work, including the rest of the WorkBuddy M2-19
implementation, was preserved untouched.

## The defect (supervisor 258)

With a token selecting tenant B while instructor A has no active membership in B, auth
leaves `req.user.tenantId` undefined. `scopePredicate(A, undefined)` dropped the tenant
predicate and filtered only by `g.instructor_id = A`, so both private reads returned
instructor A's tenant-A groups (`200 [GROUP_A1, GROUP_A2]`) instead of refusing. The
primary suite encoded that wrong result.

## Fix

- `scopePredicate(scopeId, tenantId: string)` always emits
  `g.instructor_id IN (SELECT user_id FROM tenant_memberships WHERE tenant_id=? AND status='active')`
  and still adds `g.instructor_id = ?` for an instructor scope. There is no
  instructor-only branch left to fall back to.
- `GET /` and `GET /:id` read the server-derived `req.user.tenantId` first and answer
  `404 { "error": "Tenant membership not found" }` before building a predicate or issuing
  any statement. `Cache-Control: no-store` is still set before the denial.
- `DELETE` keeps its `requireTeachingWrite('groups')` denial for an unresolved tenant and
  now refuses defensively before calling the tenant-required helper.
- Resolved-selection behavior is unchanged: active tenant membership plus instructor
  scope, canonical schedule projection, transaction/audit/connection rules, client
  behavior and every other M2-19 contract are untouched.

**Before:** unresolved selected tenant → list `200 [GROUP_A1, GROUP_A2]`, detail
`200 GROUP_A1`.
**After:** the same requests → both `404 {"error":"Tenant membership not found"}` with
zero SQL statements and zero connections; no stored value from either tenant is
disclosed.

## Verification

| Command | Result |
|---|---|
| `npx tsx --test tests/m2-group-schedules.test.ts tests/m2-group-schedules-failures.test.ts` (in `server/`) | **51 pass / 0 fail** |
| `npx tsx --test src/tests/m2-group-schedules.test.ts` (nearby client suite) | **44 pass / 0 fail** |
| `npx tsc --noEmit` (in `server/`) | **exit 0, no output** |

The new regression drives both reads through the real auth/router/guard composition and
asserts status, exact body, `no-store`, an empty SQL-call log and `connectionCount() = 0`;
it also re-asserts that the unresolved write is still a `403` and the stored row is
unchanged. The existing isolation test still proves a resolved instructor never sees
another instructor or another tenant.

## Constraints honoured

No install, network, DB, browser, provider, service, Git write, deploy, schedule change,
account change or OTP. No edits outside the three allowed paths (the only extra write is
this mandated worker report). All work stopped before the MCP report. No
self-acceptance, no next task claimed, no claim retired by me.

## Limits

- The checks are hermetic; live MySQL row locking, HTTP transport, browser behavior and
  real concurrency are not exercised or claimed.
- The primary suite replaces one wrong expectation with a corrected regression, so its
  total remains 51; the behavioral coverage is list+detail+write, not two extra tests.
- Worker timer `Tabweb-OpenCode-Worker-15min` is **Disabled** (last run 2026-10-19
  20:48:59 Cairo; stored NextRunTime 2026-10-23 16:03:58 is not an active trigger and
  did not fire). No next check is scheduled by that task; Codex review cadence under
  human152 is 15 minutes and no schedule was changed.
