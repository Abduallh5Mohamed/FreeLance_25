-- M2-21 — private group announcements (audited management lifecycle).
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-21 batch
-- (task client-m2-21-private-group-announcements-20261023-01): no database was
-- connected, no statement was executed, no seed/backfill ran and no runtime DDL
-- exists in the application. Applying it is a separate, explicitly authorized
-- integration gate (see docs/streams/server/M2-B13-CONTRACT.md).
--
-- Additive only: ONE new table. No ALTER/DROP/TRUNCATE on an existing table, no
-- data backfill, no index rebuild elsewhere, no runtime migration.
--
-- What this table IS (contract: docs/streams/server/M2-B13-CONTRACT.md):
--   * PRIVATE management metadata for the existing private groups surface: a
--     bounded title and body, an explicit lifecycle state, and server
--     timestamps. An announcement targets exactly ONE group of the SAME tenant;
--   * owned by the tenant that owns the group. The route qualifies EVERY read
--     and write by the server-selected tenant AND the caller's instructor
--     scope, so a group of another tenant can never contribute a row here. The
--     `tenant_id` column is a redundant integrity stamp for the audit and the
--     tenant-led index; it carries no authority of its own;
--   * `state` is exactly 'draft' | 'published' | 'retracted'. `draft` is private
--     management state, `published` makes the record visible through THIS
--     authenticated management surface only, and `retracted` is a terminal,
--     explicit, audited state;
--   * `created_at` / `updated_at` / `retracted_at` are SERVER timestamps. No
--     timezone conversion, scheduling policy, publish-at, expiry or delivery
--     window is encoded here.
--
-- What this table deliberately is NOT:
--   * it is NOT a delivery mechanism. There is no recipient table, no
--     recipient copy, no read receipt, no delivery queue, no outbox, no
--     attempt/retry column, no provider/message id and no email/SMS/push field.
--     This batch sends nothing;
--   * it is NOT an access, enrollment, role, permission, attendance, session,
--     pricing or billing artifact. Publishing or retracting grants and revokes
--     nothing, and no authorization decision anywhere consults this table;
--   * it is NOT a student-facing feed. Nothing in this batch exposes a
--     `published` announcement to a student principal;
--   * it is NOT a history. The row holds the CURRENT title/body/state; the
--     audit event the route writes inside the same transaction is the record of
--     each change.
--
-- Parent tables and shape:
--   * `groups` (migrations/20260920_00_legacy_baseline.sql, plus the
--     `instructor_id` column added by
--     migrations/20260928_runtime_schema_replacement.sql): InnoDB,
--     utf8mb4 / utf8mb4_unicode_ci, CHAR(36) id;
--   * `tenants` (migrations/20260921_saas_foundation.sql): InnoDB, utf8mb4 /
--     utf8mb4_unicode_ci, CHAR(36) id.
--   The engine and collation match both parents without rebuilding either.
--
-- Foreign keys:
--   * `tenant_id` -> `tenants(id)`, no ON DELETE clause: a tenant carrying
--     announcements is refused rather than silently orphaning rows;
--   * `group_id` -> `groups(id)` ON DELETE **CASCADE**. This is deliberate and
--     is the one non-obvious choice in this file: the ACCEPTED
--     `DELETE /api/groups/:id` handler performs a hard delete of the group row.
--     Without CASCADE, adding this table would make an existing accepted
--     deletion start failing on a foreign-key error — a regression in a surface
--     this batch must not change. An announcement whose target group no longer
--     exists has no target, so cascading the private metadata with it is the
--     coherent behavior. No application path hard-deletes a single
--     announcement; retraction is the lifecycle end.
--   * `instructor_id` is an immutable AUTHOR stamp (who created the record). It
--     is deliberately NOT a foreign key and carries NO authority: every write
--     revalidates the real caller, the selected tenant and the owned group, and
--     nothing reads this column to decide access.
--
-- Indexes:
--   idx_group_announcements_page  -> the bounded keyset page
--                                    (WHERE tenant_id=? AND group_id=?
--                                    AND id>? ORDER BY id LIMIT ?), tenant-led
--                                    so the tenant qualification is the indexed
--                                    path and also satisfies the tenant FK;
--   idx_group_announcements_group -> the `group_id` foreign key's required
--                                    index (a composite index whose leftmost
--                                    column is tenant_id does NOT satisfy it).

CREATE TABLE IF NOT EXISTS group_announcements (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  instructor_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  state ENUM('draft','published','retracted') NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  retracted_at TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  INDEX idx_group_announcements_page (tenant_id, group_id, id),
  INDEX idx_group_announcements_group (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
