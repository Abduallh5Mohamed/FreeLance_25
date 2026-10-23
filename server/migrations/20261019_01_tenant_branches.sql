-- M2-B03 — tenant-owned branch metadata foundation.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-B03 batch
-- (task client-m2-b03-tenant-branches-20261019-01): no database was connected,
-- no statement was executed, no seed/backfill ran, and no runtime DDL exists
-- in the application. Applying it is a separate, explicitly authorized
-- integration gate (see docs/streams/server/M2-B03-CONTRACT.md).
--
-- Additive only: one new table. No ALTER/DROP/TRUNCATE on an existing table,
-- no data backfill, no default branch, no index rebuild on another table.
--
-- Policy encoded by this table (contract: docs/streams/server/M2-B03-CONTRACT.md):
--   * exactly one tenant per branch — tenant_id is immutable and NOT NULL;
--   * name is a trimmed free label of 1..255 characters and is deliberately NOT
--     unique: the branch id (UUID) is the identity, so duplicate names are
--     allowed and no uniqueness rule is inferred;
--   * status is only 'active' or 'archived'. Archiving changes branch metadata
--     only; it grants or revokes no course, group, student or teacher access;
--   * no hard deletion, no cross-tenant move and no default-branch backfill are
--     provided here. A branch row carries no assignment, enrollment, pricing,
--     capacity or contact data.
--
-- Indexes:
--   idx_tenant_branches_page    -> the bounded keyset list read
--                                   (WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?)
--   idx_tenant_branches_status  -> status-scoped listing (active/archived)

CREATE TABLE IF NOT EXISTS tenant_branches (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  INDEX idx_tenant_branches_page (tenant_id,id),
  INDEX idx_tenant_branches_status (tenant_id,status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
