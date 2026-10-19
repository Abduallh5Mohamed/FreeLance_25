# M7 O2 + O7 — feature flags and audit log / hash chain (2026-10-19)

Resumed the halfway M7 O2 (platform feature-flag editor) + O7 (audit logs)
batch, fixed the seven suite failures and re-reviewed the whole delivery
against `docs/17-full-feature-backlog.md` rows **O2** and **O7**.

## Files changed
- `server/src/services/audit-log.ts` — fixed the chain-link verification for
  the genesis row (see below).
- `server/tests/m7-audit-logs.test.ts` — corrected a fixture that re-signed a
  row it claimed was tampered; supplied active instructor identities so the
  tenant-owner scope assertions exercise the route instead of auth suspension;
  added an export-validation test.
- `server/tests/m7-feature-flags.test.ts` — added a manage-permission test
  covering every flag mutation.
- `server/bootstrap/m1/manifest.json` — registered
  `20261018_17_feature_flags_audit_chain.sql` (SHA-256
  `00d121876db54f1e3c1652f016209f3e2f2796ee890c23a361c0cf79a7ca027a`) plus the
  matching "authoring-only / needs isolated approval" unresolved note, keeping
  the existing `…_16` entry.
- `docs/streams/server/M7-O2-O7-DELIVERY.md` — this note.

Production code (`feature-flags.ts`, `platform-flags.ts`, `audit-logs.ts`) was
already correct; no behavioral change was required there beyond the chain-walk
fix.

## The seven failures and their fixes

### 1. M1 bootstrap: migration `20261018_17` was unregistered
`scripts/build-m1-bootstrap.mjs` hashes every `server/migrations/YYYYMMDD_*.sql`
and refuses to stage when the reviewed `sourceSha256` inventory differs. The
`20261018_17` file existed on disk but not in the manifest, so the generator
threw. Registered its exact SHA-256 in `sourceSha256` (the only missing entry;
inventory now matches exactly) and documented its unexecuted status.

### 2–7. Audit chain / route tests
- **`verifyAuditChain` genesis bug (production).** `recordSealedAuditEvent`
  stores `prev_entry_hash = NULL` for the first sealed row and folds the
  `CHAIN_GENESIS` seed into that row's *payload hash*. Verification instead
  compared the stored predecessor of the first row against the literal
  `CHAIN_GENESIS` string, so a valid chain always reported
  `chain-link-mismatch`. Fixed `verifyAuditChain` to expect `previousHash`
  (i.e. `null` for the head) while still re-computing every payload hash. The
  seed remains bound into the head hash, so a rewritten/deleted head is still
  detected; tamper detection is unchanged in strength.
- **Tampered-payload fixture (test).** `chainRow(i, prev, overrides)` signs the
  row *after* applying overrides, so `chainRow(2, a.entry_hash, {action:
  'announcement.update'})` produced a self-consistent row and could not be
  flagged. The test now mutates a correctly-signed row in place
  (`{...chainRow(2, a.entry_hash), action: 'announcement.update'}`), which is a
  real payload tamper; the assertion (`payload-hash-mismatch`, `row-2`) is
  unchanged.
- **Tenant-owner read/export fixtures (test).** Instructor tokens are resolved
  through `findInstructorAccount`; the fixture returned `null`, so the real auth
  middleware rejected the request with `403 TENANT_SUSPENDED` before the route
  ran. Added active instructor accounts and tenant memberships for `owner-a`
  and `staff-a`. The route now genuinely exercises tenant pinning and scoped
  export, and the non-owner `403` comes from the ownership check.

## O2 — plans and feature-flag editor
Acceptance: validation, preview, scoped targeting, version, audit, rollback,
server-side enforcement.

- `feature_flags` registry + immutable `feature_flag_versions` snapshots
  (`all` / `plan` / `tenant_list` / `percentage`); enabling, disabling or
  retargeting always publishes a new version, rollback only moves the active
  pointer (`moveActivePointer`, optimistic `WHERE active_version_id = ?`).
- Validation: key pattern, 500-char description, mode enum, plan/tenant
  reference existence, dedup, `MAX_TARGET_TENANTS = 100`, integer percentage
  `0..100`, mandatory 3–500 char audit reason on every mutation.
- Scoped targeting: `evaluateTargeting` + stable sha256 `(flagKey|tenantId)`
  rollout membership so percentage cohorts never flip.
- Preview: `previewTargetedTenants` returns a count plus bounded sample, no
  write.
- Server-side enforcement: `isRequiredFeatureEnabled(tenantId, flagKey)` is
  deny-by-default and never throws (unknown/archived/no-version/disabled/db
  failure ⇒ `false`).
- Permissions: every route requires authentication plus a verified
  `platform_flags.read` / `platform_flags.manage` permission; a JWT role claim
  is never sufficient.
- Audit: create / publish / rollback / archive write sealed audit rows inside
  the same (optional) transaction; a failing audit aborts the write.

## O7 — audit logs
Acceptance: append-only write path; filters/export with audit; tamper
detection/retention policy.

### Append-only
`audit-log.ts` exposes only INSERT (sealed) and SELECT paths; `audit-logs.ts`
issues no `UPDATE`/`DELETE`. The route test scans every executed statement on
read/chain-verify paths and fails on any `UPDATE`/`DELETE`. Sealed writes go
through `recordSealedAuditEvent`; legacy rows without `entry_hash` are counted
as `unsealed` and never break the walk.

### Tamper detection
`entry_hash = sha256(prev | id | actor | tenant | action | resource_type |
resource_id | old_value | new_value | reason)` with JSON canonicalization and
the genesis seed folded into the head hash. `verifyAuditChain` walks sealed rows
in `(created_at, id)` order, re-computes each payload hash and checks each link,
returning the first `payload-hash-mismatch` / `chain-link-mismatch` with the row
id. Bounded by `MAX_CHAIN_VERIFY_ROWS = 20000`.

### Reads / filters / export
- Configurable list/export scopes: a verified platform reader (`audit.read` or
  super admin, server-owned) may cross tenants; a verified active tenant owner
  is forcibly pinned to their own server-derived tenant; everyone else `403`.
  Chain verification is platform-only.
- `parseAuditFilters` / `parseAuditPagination` strictly bound and validate every
  filter (regex + real-calendar datetime validation, `from ≤ to`,
  `limit ≤ 100`, `page ≤ 10000`); malformed input is `400` with no read.
- CSV export neutralizes formula injection for leading `= + - @ \t \r`, escapes
  quotes/newlines, is capped at `MAX_EXPORT_ROWS = 5000`, and is itself audited
  (`audit_log.exported`, actor + applied filters + row count). Tenant-owner
  export remains scoped and audits the owner's own tenant.

### Retention
`AUDIT_RETENTION_DAYS = 365` floor, an explicit policy note that a purge is a
separately approved DBA activity run from the oldest end followed by a full
chain verification. No deletion path exists in the service.

## Migration
`20261018_17_feature_flags_audit_chain.sql` is idempotent (INFORMATION_SCHEMA
probe + `PREPARE`/`EXECUTE` per step), adds the flag tables, the audit
`entry_hash`/`prev_entry_hash` columns and the `(created_at, id)` chain-scan
index. Authoring-only: not executed and not validated on MySQL.

## Verification
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` — clean.
- Full suite run twice: `node node_modules/tsx/dist/cli.mjs --test server/tests/*.test.ts` — 1984 pass / 0 fail both times.
