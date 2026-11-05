-- BUILD-05: additive FILE ONLY; not applied. No backfill or trusted scan fabricated.
-- Verify parent engine/charset/collation and actual constraints before authorized application.
-- No client API may set clean evidence or select an arbitrary storage key/version.
CREATE TABLE IF NOT EXISTS course_material_files (
  id CHAR(36) PRIMARY KEY,
  material_id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  object_version VARBINARY(255) NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  scan_status ENUM('pending','clean','rejected') NOT NULL DEFAULT 'pending',
  scanned_object_version VARBINARY(255) NULL,
  scanned_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  scan_engine VARCHAR(128) NULL,
  scan_policy_version VARCHAR(128) NULL,
  scanned_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_material_files_material FOREIGN KEY (material_id) REFERENCES course_materials(id),
  CONSTRAINT fk_material_files_course FOREIGN KEY (course_id) REFERENCES courses(id),
  CONSTRAINT fk_material_files_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_material_files_size CHECK (size_bytes >= 5 AND size_bytes <= 10485760),
  UNIQUE KEY uq_material_files_material (material_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
