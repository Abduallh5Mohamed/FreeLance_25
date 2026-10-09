# M1 legacy upload migration plan

**Status: plan only. No legacy records or files were changed.** Migration must run against an isolated copy first and must not target the current production database until explicitly scheduled and approved.

## Goal and invariants

- Replace persisted `/uploads/...` URLs with IDs resolved by the authenticated, tenant-scoped file download route.
- Never infer tenant ownership from a URL, request parameter, or client-supplied tenant ID.
- Preserve the original file and old reference until the new object, metadata, and verification all succeed.
- Keep an audit record for every migrated, skipped, or quarantined reference.

## Inventory and dry run

1. On a fresh database copy, enumerate every text column and JSON field that can contain `/uploads/` references. Start with the known message, exam question, premium lecture/receipt, assignment, and lesson material tables; expand from schema search before execution.
2. Produce a report only: table, row ID, column, normalized relative path, detected tenant from the owning row chain, file existence, size, SHA-256, and duplicate-path count. Do not print student or parent data.
3. Mark a row `eligible` only when its owning resource has exactly one active tenant and the source file resolves inside the configured uploads root. Reject traversal, absolute paths, symlinks escaping the root, missing files, ambiguous tenant chains, and duplicate IDs with conflicting owners.
4. Dry-run mode must be the default. It writes a report and migration manifest to a private output directory, performs zero database writes and zero object uploads, and returns nonzero when unsafe/ambiguous records exist.
5. Require a second dry run against the same snapshot and compare row counts, total bytes, tenant counts, and checksums before enabling apply mode.

## Apply sequence

1. Copy eligible files to a private staging bucket with object keys `tenant/{tenantId}/legacy/{sha256}/{safeFilename}`. Preserve MIME type and size; do not make the bucket public.
2. Read each staged object back and compare SHA-256. Do not switch a database reference unless the checksum matches.
3. Insert `tenant_media_files` metadata with tenant, object key, original filename, MIME type, size, checksum, and migration batch ID. Use deterministic IDs/idempotency keys so rerunning a batch cannot duplicate rows.
4. In a short transaction per bounded batch, update the exact source row from the old URL to `/api/files/{mediaFileId}/download`, conditioned on the old value still matching. Record before/after reference, row owner, tenant, checksum, and batch ID in a migration ledger.
5. Run authenticated smoke checks as the owning tenant, a different tenant, and anonymous user. Only the owning tenant may receive bytes; other and anonymous requests must be denied. Compare returned bytes to the recorded checksum.
6. Keep original files immutable and inaccessible through public static hosting during a defined rollback window. After all counts and checksums reconcile, schedule deletion under a separate retention decision; do not combine deletion with reference switching.

## Rollback

- Before switching references: delete only objects and metadata tagged with the failed batch ID; original paths remain unchanged.
- After switching references: restore each old value from the migration ledger with a compare-and-set condition that the current value still points to that batch’s media ID. Do not overwrite edits made after migration.
- Keep migrated objects until the rollback is verified. Remove batch objects only after database references are restored and the rollback report reconciles.
- If any tenant attribution is ambiguous or any checksum differs, stop the batch, leave source values intact, and quarantine those rows for manual ownership review.

## Acceptance criteria

- Dry run performs zero writes and covers every `/uploads/` reference found in the schema/data inventory.
- Every applied reference maps to a private object and tenant-owned metadata row with matching checksum.
- Anonymous and wrong-tenant download attempts fail; owning-tenant download succeeds.
- Apply is idempotent, rollback is tested on a copied database, and the ledger reconciles source row count, metadata count, bytes, and checksums.
- No old `/uploads/` reference remains except explicitly quarantined/unsupported rows documented in the batch report.
