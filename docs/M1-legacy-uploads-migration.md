# M1 Legacy `/uploads` References — Migration PLAN (NOT EXECUTED)

> **Status: plan document only.** No transfer, copy, rename, or inspection of
> real files has been performed, and none may be performed from this document
> alone. Every step below requires its own human approval and its own
> reversible, audited execution run. This plan intentionally contains no
> credentials, connection strings, or real tenant identifiers.

## 1. Background and goal

The hardened edge (`nginx-hardened-v4.conf`) denies the public `/uploads/`
prefix with `location ^~ /uploads/ { deny all; return 404; }`, and MinIO
buckets carry no anonymous policy (`minio-policy.json` has an empty
`Statement` list). Private uploads are therefore only reachable through the
authenticated backend route `GET /api/files/:fileId/download`
(`server/src/routes/files.ts`), which:

1. requires an authenticated principal with a server-derived `tenantId`;
2. loads the file by `id` **and** `tenant_id` together
   (`tenant_media_files WHERE id=? AND tenant_id=?`), so a foreign tenant id
   is indistinguishable from a missing file (404);
3. resolves `storage_path` and refuses to serve anything outside the uploads
   root (path-traversal guard).

Legacy rows written before that contract still store public-style URLs such
as `/uploads/<subdir>/<file>` (known writers: `server/src/routes/exams.ts`
→ `uploads/questions`, `server/src/routes/messages.ts` →
`uploads/messages`, `server/src/routes/premium-lectures.ts` →
`uploads/receipts`, plus historical material/lecture `file_url` columns).
Those strings are now dead public paths: the edge returns 404 for them, so
readers must be re-pointed at the authenticated download route.

**Goal:** every persisted reference to `/uploads/...` resolves to an
authenticated, tenant-scoped `tenant_media_files` row served by
`/api/files/:fileId/download`, with an idempotent, reversible mapping and a
fail-closed rule for rows whose tenant owner cannot be proven.

## 2. Non-goals / guardrails

- No file is moved, copied, renamed, or opened by this plan's authoring.
- No schema migration is included here; the DDL in §5 is a proposal that
  needs its own reviewed migration file.
- The `/uploads/` edge denial, the private MinIO policy, and the
  authenticated video contract are **not** weakened at any phase.
- No public object URL is reintroduced at any phase.
- Real tenant identifiers, hostnames, and credentials stay out of this
  document and out of every dry-run output; outputs are aggregate counts and
  per-tenant rollups only.

## 3. Phase 0 — Inventory rules (read-only)

Inventory is a set of read-only `SELECT` queries run per environment with
approval. For each candidate column (URL/text columns listed below), count
rows matching the legacy pattern. Candidate columns (verify against the live
schema before running; the list is derived from route usage, not from a live
inspection):

| Table | Column | Legacy writer |
| --- | --- | --- |
| `student_fees` | `receipt_image_url` | premium-lectures receipts |
| `tenant_media_files` | `storage_path` (control rows) | files route |
| messages tables | image URL columns | `routes/messages.ts` |
| exam/question tables | asset URL columns | `routes/exams.ts` |
| `course_materials` | `file_url` | historical material uploads |
| lecture tables | asset URL columns | historical uploads |

Inventory rule shape (parameterized; `?` is the tenant under inspection when
the owning table carries `tenant_id`, otherwise the owner is derived per §4):

```sql
-- count per table/column, per tenant when tenant-scoped
SELECT COUNT(*) AS legacy_refs
FROM <table>
WHERE <column> LIKE '/uploads/%';
```

Classification rules applied to every matched row:

- **Mappable:** the referenced path exists under the uploads root *and* the
  owning row proves exactly one tenant owner (row-level `tenant_id`, or a
  single-tenant parent chain such as group → course → tenant).
- **Orphan (fail closed):** no provable tenant owner. Orphan rows are **not**
  migrated and **not** deleted; they are reported for human decision.
- **Missing file:** the referenced path does not exist under the uploads
  root. Treated as orphan for migration purposes; reported, never guessed.

## 4. Ownership derivation (deny-by-default)

A legacy row is migratable only when its tenant owner is provable from
server-side data, using one of:

1. a `tenant_id` column on the owning row itself; or
2. a unique parent chain (`student_fees.tenant_id` direct; message/exam rows
   via their conversation/exam owner; `course_materials` via
   `courses.tenant_id`; group-scoped rows via `groups → courses → tenant`).

If a row resolves to zero or to multiple candidate tenants, it is orphan and
fails closed. Ownership is never taken from the URL string, from a client
parameter, or from a filename convention.

## 5. Proposed mapping table (needs its own reviewed migration)

```sql
CREATE TABLE IF NOT EXISTS legacy_uploads_mapping (
  source_path VARCHAR(500) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  target_file_id CHAR(36) NOT NULL,
  source_table VARCHAR(100) NOT NULL,
  source_column VARCHAR(100) NOT NULL,
  source_row_id CHAR(36) NOT NULL,
  checksum CHAR(64) NULL,
  migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_table, source_column, source_row_id, source_path),
  UNIQUE KEY uq_source_path (source_path),
  INDEX idx_target_file (target_file_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Idempotency: the primary key and `uq_source_path` make re-runs safe —
`INSERT ... ON DUPLICATE KEY UPDATE` never creates a second mapping for the
same source, and a mismatched re-insert is a validation error (§7), not a
silent overwrite. Mapping is per (table, column, row, path) so the same file
referenced by two rows yields one file id and two reversible pointers.

Target rows live in the existing `tenant_media_files` table (already the
contract used by `/api/files/:fileId/download`); `target_file_id` references
it. No new storage location is invented.

## 6. Dry-run (read-only; no writes, no file access)

The dry-run is the only "run" authorized before approval, and it is strictly
read-only:

```text
Input : tenant scope (or "all"), read-only DB role.

Output (aggregates and per-tenant rollups only; no tenant ids in shared
reports, no file contents, no credentials):

  per (table, column):
    legacy_refs            = rows matching '/uploads/%'
    provable_owner         = rows with exactly one derived tenant
    orphan_fail_closed     = rows with zero/ambiguous owner   -> excluded
    missing_file           = referenced path absent on disk   -> excluded
    already_mapped         = rows already present in legacy_uploads_mapping
  per tenant:
    mappable_total, orphan_total, missing_total
  verdict:
    READY   when mappable_total > 0 and every mappable row has
            exactly one provable owner and one existing file
    BLOCKED otherwise, with the offending (table, column) groups listed
```

The dry-run performs no `INSERT`/`UPDATE`/`DELETE`, creates no mapping rows,
and opens no file. "Missing file" detection uses existence metadata only
(stat), never content.

## 7. Execution sketch (only after human approval, per tenant)

Per tenant, in one reviewed transaction per batch:

1. `BEGIN`;
2. ensure the `tenant_media_files` target row exists for each distinct
   `source_path` (derive `mime_type`/`original_name` from existing metadata;
   fail the batch when unprovable — never guess);
3. `INSERT ... ON DUPLICATE KEY UPDATE` the mapping row (idempotent);
4. rewrite the source reference from `/uploads/<path>` to
   `/api/files/<target_file_id>/download` (relative path only — no absolute
   or public object URL);
5. `COMMIT` per batch; batches are small and restartable.

Execution constraints: no bulk unbounded statement, no cross-tenant batch,
retry only on deadlock with the same idempotent statement, and every batch
logged as (table, column, rows affected, mapping ids) without content.

## 8. Validation (post-execution, read-only)

- **Coverage:** `SELECT COUNT(*) FROM <table> WHERE <column> LIKE '/uploads/%'`
  is 0 for every migrated (table, column, tenant) group; any remainder is a
  blocker, not a warning.
- **Referential integrity:** every `target_file_id` in
  `legacy_uploads_mapping` resolves to an existing `tenant_media_files` row
  in the same tenant; every rewritten URL matches
  `^/api/files/[0-9a-f-]{36}/download$`.
- **Tenant isolation:** for each rewritten row, the owning row's tenant
  equals the mapping's tenant (join check); zero mismatches tolerated.
- **Download smoke test (authenticated, tenant-scoped):** for a sampled set
  per tenant, `GET /api/files/<id>/download` with that tenant's session
  returns the file; the same request with a foreign tenant's session
  returns 404; an anonymous request returns 401.
- **Idempotency:** re-running the dry-run after execution reports
  `legacy_refs = 0` and `already_mapped = mapped_total` for the group.

## 9. Phased cutover

1. **Phase A — map only (no read switch):** populate
   `legacy_uploads_mapping` and `tenant_media_files` targets; readers still
   receive legacy strings. Reversible by deleting mapping rows.
2. **Phase B — shadow reads:** readers resolve the mapping first and fall
   back to the legacy string only when the file is confirmed present; log
   both paths' hit rates. No data is deleted.
3. **Phase C — authenticated reads switch:** readers resolve exclusively via
   `/api/files/<id>/download`; any unresolved reference renders an explicit
   "file unavailable" state, never a public URL and never a silent success.
4. **Phase D — writer freeze:** new uploads go only through
   `tenant_media_files`; legacy writers under `uploads/` are disabled per
   route after their readers are switched.
5. **Phase E — retention:** legacy files are kept read-only for an agreed
   window; deletion is a separate, separately approved operation.

Each phase ends at a review gate; phase order is not skippable, and phases
may stop after any step.

## 10. Rollback

- Mapping rows are additive: deleting the batch's
  `legacy_uploads_mapping` rows restores the previous state.
- Reference rewrites are reversible by re-writing
  `/api/files/<id>/download` back to the stored `source_path` from the
  mapping row (before Phase E deletes anything).
- No file is moved or deleted before Phase E, so rollback never depends on
  file restoration.
- Rollback is per tenant and per (table, column) group; a partial rollback
  is valid and expected to be tested in a rehearsal environment first.

## 11. Explicit limits of this plan

- No live database, MinIO, Docker, or network service was contacted while
  writing this plan; table/column candidates are inferred from route usage in
  this repository and must be re-verified against the live schema before any
  inventory query runs.
- File existence and checksums are described operationally; no real file was
  stat'ed, hashed, or opened.
- Multi-tenant chains (message/exam/lecture assets) need their exact parent
  columns confirmed during Phase 0 before execution; ambiguous chains fail
  closed per §4.
- This plan does not authorize itself: every phase requires explicit human
  approval and its own reviewed, reversible run.
