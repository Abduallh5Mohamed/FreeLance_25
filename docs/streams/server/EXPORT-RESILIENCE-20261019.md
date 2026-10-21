# Tenant export resilience — 2026-10-19

Task: `server-tenant-export-resilience-20261019-01` (branch `codex/workbuddy-server`).
Files: `server/src/services/tenant-export.ts`, `server/src/routes/tenant-export.ts`,
`server/tests/m8-tenant-export.test.ts`, this document.

This note records the failure paths that were reviewed, what changed, and the
limits that remain. It is not a claim of a full backup product and not evidence
of live database or storage verification.

## 1. Request admission and audit-failure recovery

Before: `requestTenantExport` inserted a `pending` row and then wrote its audit
row as a separate statement. A failed audit left a committed `pending` job that
blocked every later request for the tenant (the UNIQUE active lock) while the
caller received an error. The successful insert and the audit were not atomic.

After:

- When the injected `TenantExportDataAccess` exposes `transaction`, the INSERT
  and the `tenant_export.requested` audit run inside that transaction. The
  production connection wires it to `db.withTransaction` (one pooled
  connection, `beginTransaction` / `commit` / `rollback`). An audit failure
  rolls the job row back, so no active row and no success survive.
- Without a transaction seam (hermetic callers), a failed audit is followed by
  a guarded recovery write:
  `UPDATE ... SET status = 'failed', error = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'`.
  The original error is rethrown; the caller never receives `ok: true`.
- If even the recovery write fails, the thrown message includes both failures
  so the stuck row is visible to operations rather than silently swallowed.
- The pre-checks (`pending` job, cooldown) remain explicit reads. They are
  advisory; the UNIQUE key is the authority.

## 2. Unique active-tenant INSERT race

The generated `active_tenant_lock` column plus `UNIQUE KEY
uq_tenant_data_exports_active` (migration `20261018_23`) makes two concurrent
INSERTs impossible. Before, the loser's driver error escaped as a 500.

After: `ER_DUP_ENTRY` / errno `1062` from the INSERT is mapped to
`409 An export for this tenant is already in progress`, with no success audit
and no row created by the loser. Other database errors still propagate (500),
so an outage is not disguised as a conflict.

## 3. Download token rotation, binding and expiry

Before: the token hash was written with `WHERE id = ?` (no tenant or status
binding) and verification never consulted the stored hash, so re-issuing a
token did not rotate anything and the hash column was decorative. The download
route also accepted a token whose signed export id differed from the id in the
URL, as long as both belonged to the same tenant.

After:

- Rotation: `UPDATE tenant_data_exports SET token_hash = ? WHERE id = ? AND
  tenant_id = ? AND status = 'completed'`. Zero affected rows returns
  `409 The export is no longer available`. With a transaction seam the hash
  update and the `tenant_export.download_issued` audit commit together.
- Verification requires `sha256(token)` to equal the persisted `token_hash`
  using a constant-time comparison. Re-issuing a token invalidates the previous
  one. A job without a persisted hash cannot be downloaded with an externally
  signed token.
- Binding: `downloadTenantExport` now receives the requested `exportId` and
  rejects with 403 (audited as `tenant_export.download_denied`) when the signed
  identity differs, even inside the same tenant.
- Expiry is checked twice: the token `x` claim and the job `expires_at`
  download window (24 h). Both fail closed with 410.

## 4. Missing objects

`downloadTenantExport` returns `410 The export file is no longer available`
when `storage_key` is absent or the storage read throws, and audits the denial.
The job row is left intact: a transient storage outage must not destroy the
record, and a later read can still succeed. Token issuance does not probe the
object (the storage interface has no `exists`), so a token can be issued for a
job whose object has already been removed; the download then fails closed.

## 5. Completion and failure transitions

- Table loads and storage writes are unchanged. On a load/storage error the
  job is marked `failed` with a tenant-bound guarded update, then
  `tenant_export.failed` is audited; the original error is rethrown.
- The completion update is guarded by `id`, `tenant_id` and
  `status = 'pending'`. When a transaction seam exists it runs with the
  `tenant_export.completed` audit; otherwise the audit follows the committed
  update.
- If the completion audit fails after this call's transition succeeded, the job
  is demoted to `failed` (`status IN ('pending','completed')`, exact id and
  tenant) so an unaudited export is never downloadable. If that demotion also
  fails, both errors are surfaced. Bytes already written remain in storage as
  orphans; there is no cleanup job.

## 6. Completeness, memory and size limits

Included tables (`EXPORT_TABLE_PLAN`, 17): `courses`, `lectures`,
`announcements`, `schedules`, `groups`, `branches`, `branch_memberships`,
`grades`, `students`, `student_courses`, `course_materials`, `exams`,
`exam_questions`, `question_bank_questions`, `question_bank_versions`,
`assignments`, `assignment_submissions`.

Every statement pins `tenant_id` (directly or through a tenant-owned parent)
before loading rows. `students.password_hash` and `users` are never selected.

This is **not a full tenant backup**:

- Many tenant-scoped tables are outside the plan, including attendance,
  certificates, gradebook, lesson discussions/completions, payments,
  subscriptions/wallets, notifications/outbox, video assets/entitlements,
  moderation, imports and audit rows. Adding them is a product decision and a
  new approval, not a silent change here.
- Each table is read in its own statement with no shared transaction or
  consistent snapshot. Rows written between two table reads can be missed or
  duplicated relative to each other. The manifest checksums prove the bytes
  that were written, not cross-table consistency.
- Every table is materialised in memory as an array and then as one JSONL
  string; the storage interface accepts a whole `string`. There is no row cap,
  byte cap, streaming or backpressure. A very large tenant can exhaust the
  process heap. A bounded/streamed writer needs an interface change.
- `processTenantExport` runs inline in the `POST /` request. Long exports hold
  the HTTP request open; there is no queue, worker, retry or resumability.
- Objects are written but never deleted; the manifest is the only index. The
  local storage adapter is path-traversal safe but has no encryption at rest,
  retention or S3 lifecycle policy in this scope.

The manifest's `excluded` list now also states that the extract is not a full
backup and not a point-in-time snapshot.

## 7. Residual risks / not verified here

- Migration `20261018_23_search_export.sql` was only read. No SQL, database,
  Docker or live storage was executed in this task.
- The transaction seam is wired but not exercised against MySQL in tests; the
  hermetic tests use an injected seam that records commit/rollback.
- Two concurrent `processTenantExport` calls for the same id are not claimed
  exclusively (the schema has no `processing` state). Both can write the same
  object keys; the guarded completion lets only one become `completed`, but the
  stored manifest object may be the loser's. The route normally prevents this
  via the active-job lock; direct callers must not process a job twice.
- A request-audit failure without a transaction leaves the recovery dependent
  on one further write; if that write fails too, the row remains `pending` and
  is reported, not hidden.
- The default router is not mounted by this task; mounting is owned elsewhere.

## 8. Verification

Focused:

```
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs \
  --import tsx --test server/tests/m8-tenant-export.test.ts
```

30 tests, 30 pass. New coverage: request audit failure with and without a
transaction seam, duplicate-key race to 409, completion audit failure demotion,
token rotation, rotation bound to tenant/job, token-update conflict, signed-id
vs requested-id mismatch, route-level audit failure and route-level cross-export
token replay. The existing owner allow, platform allow, tenant isolation,
cooldown, missing-object and tenant-pinned table-load tests are unchanged.
