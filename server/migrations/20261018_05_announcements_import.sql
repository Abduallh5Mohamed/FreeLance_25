-- ============================================================
-- C11 announcements + schedules, C12 student CSV import ledger
-- (2026-10-18)
-- ============================================================
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime;
-- an operator applies this file on the isolated bootstrap/validation stack.
-- Every step is idempotent (CREATE TABLE IF NOT EXISTS / INFORMATION_SCHEMA
-- guards), so re-running it is a no-op.
--
-- Model:
--   announcements.audience  'tenant' | 'branch'
--   schedules.audience      'tenant' | 'branch' | 'group'
--   A branch/group audience is only meaningful with the matching id set; the
--   API denies a target outside the caller's tenant. Time is stored as an
--   absolute UTC DATETIME; the authored IANA timezone is retained for
--   re-editing.
--   student_import_batches is the idempotency + audit ledger for C12: the same
--   (tenant_id, file_hash) or (tenant_id, file_key) is imported once. It never
--   stores a password or password hash, and rejected rows are kept for the
--   operator-facing report only.
-- ============================================================

-- ---------------------------------------------------------------------------
-- announcements: tenant/branch-audience announcements with edit/retract.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  audience VARCHAR(16) NOT NULL DEFAULT 'tenant',
  status VARCHAR(16) NOT NULL DEFAULT 'published',
  created_by CHAR(36) NULL,
  published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retracted_at DATETIME NULL,
  version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_announcements_tenant_status (tenant_id, status, published_at),
  KEY idx_announcements_tenant_branch (tenant_id, branch_id, status),
  CONSTRAINT fk_announcements_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_announcements_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_announcements_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- schedules: tenant/branch/group-audience schedules stored as UTC instants.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NULL,
  group_id CHAR(36) NULL,
  title VARCHAR(200) NOT NULL,
  audience VARCHAR(16) NOT NULL DEFAULT 'tenant',
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'scheduled',
  created_by CHAR(36) NULL,
  cancelled_at DATETIME NULL,
  version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_schedules_tenant_start (tenant_id, starts_at),
  KEY idx_schedules_tenant_branch (tenant_id, branch_id, status),
  KEY idx_schedules_tenant_group (tenant_id, group_id, status),
  CONSTRAINT fk_schedules_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_schedules_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_schedules_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL,
  CONSTRAINT fk_schedules_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- student_import_batches: C12 idempotency + rejected-row ledger.
--   file_hash is the SHA-256 of the uploaded CSV; file_key is an optional
--   caller-supplied idempotency key. Both are unique per tenant. No credential
--   column exists on this table (no password / password hash is ever stored).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_import_batches (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NULL,
  file_hash CHAR(64) NOT NULL,
  file_key VARCHAR(120) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'committed',
  headers JSON NULL,
  row_count INT NOT NULL DEFAULT 0,
  imported_count INT NOT NULL DEFAULT 0,
  updated_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  rejected_rows JSON NULL,
  created_by CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_import_tenant_hash (tenant_id, file_hash),
  UNIQUE KEY uq_import_tenant_key (tenant_id, file_key),
  KEY idx_import_tenant_created (tenant_id, created_at),
  CONSTRAINT fk_import_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_import_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
  CONSTRAINT fk_import_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Index on students(tenant_id, instructor_id) keeps the import duplicate
-- lookup and tenant scoping cheap on large enrollments. Guarded by name.
-- ---------------------------------------------------------------------------
SET @import_student_owner_idx = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND INDEX_NAME = 'idx_students_tenant_instructor'
);
SET @import_student_owner_sql = IF(
  @import_student_owner_idx = 0,
  'ALTER TABLE students ADD INDEX idx_students_tenant_instructor (tenant_id, instructor_id)',
  'SELECT 1'
);
PREPARE import_student_owner_stmt FROM @import_student_owner_sql;
EXECUTE import_student_owner_stmt;
DEALLOCATE PREPARE import_student_owner_stmt;
