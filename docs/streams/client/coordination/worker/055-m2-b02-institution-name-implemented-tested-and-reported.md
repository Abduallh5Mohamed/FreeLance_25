# 055 — M2-B02 institution-name update implemented, tested and reported

**Task:** `client-m2-b02-institution-name-20261019-01` (approved, basis supervisor124
+ M2-B02-PROPOSAL). **Worker:** OpenCode native MCP claim
`opencode-scheduled-20261019-1653`. Native session ID unavailable to this run.
**Branch:** `codex/human-client`. **UTC:** 2026-10-19T14:56Z / Cairo 16:56.

## Scope actually changed (exactly three allowedPaths)

- `server/src/routes/tenant-self.ts` — added `PATCH /profile` owner-only name update
  (preserved the accepted M2-B01 GET/dirty work in the same file).
- `server/tests/m2-tenant-profile-update.test.ts` — new, 25 hermetic production-path tests.
- `docs/streams/server/M2-B02-CONTRACT.md` — new request/response/error/audit contract.

## Behavior (before → after)

Before: selected institution name readable via accepted `GET /profile`; no write.
After: verified `tenants.owner_user_id` (with active tenant + active user re-checked
under `FOR UPDATE` on the transaction connection) updates only `business_name`;
strict single-field payload; name UPDATE + `audit_events` insert commit together;
same-name retry is a truthful no-op; 409 on zero-row update; no-store on all own
outcomes. Instructor/role-label-only, cross-tenant, suspended, unselected and
inactive callers are denied without a write. A lost commit ack reports 500 without
claiming rollback. No schema/shared/router/backend change.

## Validation commands and results

- `npx tsx --test server/tests/m2-tenant-profile-update.test.ts` → 25/25 pass, exit 0.
- `npx tsx --test server/tests/m2-tenant-profile.test.ts` → 20/20 pass, exit 0.
- Both bundles together → 45/45 pass, exit 0.
- `npx tsc --noEmit -p server/tsconfig.json` → 0 diagnostics, exit 0 (before and after).

## Limits

Injected fixtures are not live SQL/concurrency/rollback proof; live row locking,
real HTTP, providers and integration suites were not run (out of scope per124).

## Next check

Next scheduled check (Africa/Cairo): `2026-10-19 17:03:58`, ~8 min after this report.
Task state was `Running` at report time; this is the next CHECK, not a guaranteed start.
