# Engineering rules and invariants

These rules capture recurring contracts in current source. Read the exact route
and tests before implementation; this is a compact guardrail, not a substitute.

## Authentication and multi-tenancy

- Authenticate with the shared middleware; do not decode tokens independently
  in a feature route.
- Treat JWT tenant/workspace fields as requested selectors. The server resolves
  current identity, membership, enrollment and branch authority from live rows.
- Bind every resource query and mutation to its tenant/workspace owner. A found
  ID alone is never authority.
- For private cross-tenant/foreign IDs, prefer indistinguishable not-found
  behavior where the existing contract requires it.
- Platform-admin capability and impersonation are separate from ordinary tenant
  membership. Use the established guards and verified impersonation context.

## SQL and transactions

- Parameterize all values. Only interpolate constants or already-validated
  bounded integers (for example a parsed `LIMIT`).
- Use explicit column projections and canonical DTO conversion.
- Mutations plus audit records that form one operation must share one database
  transaction/connection.
- Roll back on callback or commit failure. Treat commit failure as uncertain;
  do not report success or blindly retry. Destroy connections with unknown
  transaction state.
- Detect truthful no-ops before writing when the feature contract requires
  idempotency.
- Bound lists and recovery passes using limits/keyset cursors; never add an
  unbounded tenant-wide scan to a request path.

## Migrations and schema evidence

- Migrations are additive files under `server/migrations/`.
- Creating/editing a migration file does not authorize applying it.
- A runtime that requires new columns/tables should verify the actual catalog
  and fail closed when absent. Do not convert file presence into readiness.
- Never run root-level migration, cleanup or deployment scripts merely because
  their names sound relevant; many are historical and destructive.

## Auditing and privacy

- Use the domain's sealed/atomic audit seam. Do not silently replace it with a
  no-op or ad-hoc INSERT.
- Audit sanitized IDs and state transitions; do not persist secrets, tokens,
  raw provider payloads or unnecessary student/contact data.
- Keep list and export projections fixed. Avoid row spreads into API responses.
- Contact information must be purpose-scoped; “any phone/email on file” is not
  valid notification authority.

## Files and object storage

- Enforce tenant ownership, size/type limits and normalized keys before storage.
- Private object storage is not a malware verdict. Without a trusted scanner,
  uploads remain pending/fail closed.
- Cleanup that cannot prove exact object version/ETag must not claim guaranteed
  deletion. Durable obligations and recovery need real schema and bounded jobs.
- Prevent path traversal for local export/temp storage.

## Financial operations

- Display balances, debt and analytics are not authority to charge, release or
  refund money.
- Provider calls, ledger mutation, settlement and audit require explicit
  idempotency and reconciliation contracts.
- Never invent a provider, price, commission, payout policy or success result.
- Do not wire the financial factories into production with placeholder audits or
  an unverified schema.

## Notifications and live providers

- Provider callbacks require real signature verification and trusted identity
  mapping before parsing/applying events.
- Missing adapters, contacts, secrets, schema reports or provider mapping mean
  unconfigured—not simulated success.
- Workers/recovery loops are bounded and lifecycle-owned by the composition
  root: start after readiness; stop new work, drain and release on shutdown.
- Factories such as `createNotificationRuntime` and `createLiveRuntime` are not
  production features until constructed and mounted with real dependencies.

## Frontend contracts

- Parse external/API data into strict canonical DTOs in adapters.
- Do not let pages infer authorization or access from hidden buttons or local
  selectors; the backend is authoritative.
- Controllers must fence stale async responses by principal, session, target
  and lifecycle/disposal.
- Prevent duplicate submissions and make retry semantics visible.
- Preserve Arabic/RTL behavior and existing role navigation unless the task
  explicitly changes it.

