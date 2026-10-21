-- =============================================================================
-- M8 Q3 tenant-safe search index plan + Q6 per-tenant data export ledger
-- Task:    m8-q3-q6-search-export-20261018-23
-- Date:    2026-10-18
--
-- PROVENANCE
--   Q3 search candidate loads run with the tenant/visibility/publication/
--   enrollment gates evaluated in SQL BEFORE ranking (see
--   server/src/services/search.ts). The indexes below keep those gated loads
--   indexed on large catalogs. courses is already covered by
--   idx_courses_tenant_active (tenant_id, is_active) from
--   20260927_course_tenant_ownership_and_instructor_subject.sql; no duplicate
--   index is created for it.
--
--   Q6 per-tenant data export (see server/src/services/tenant-export.ts)
--   persists one job row per export with a completeness manifest (per-table
--   row counts, byte sizes and SHA-256 checksums). The VIRTUAL generated
--   column active_tenant_lock is the tenant id while the job is 'pending' and
--   NULL otherwise; the UNIQUE key on it makes "at most one active export per
--   tenant" a database-level invariant that concurrent inserts cannot violate
--   (a second concurrent INSERT fails the duplicate-key check instead of
--   failing open).
--
-- PREFLOW / IDEMPOTENCY
--   Every statement is idempotent (CREATE TABLE IF NOT EXISTS /
--   INFORMATION_SCHEMA-guarded ADD INDEX), so re-running this file is a no-op.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION is OUT OF SCOPE for this
--    batch and must be performed by a separately scoped isolated bootstrap +
--    live verification step.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Q3 search index plan
-- ---------------------------------------------------------------------------

-- lectures candidate load: INNER JOIN courses c ON c.id = l.course_id
-- WHERE c.tenant_id = ? AND c.is_active = 1 AND l.is_published = 1
-- AND l.archived_at IS NULL. Driving the join from lectures with the
-- visibility columns in the index avoids a filesort over the whole catalog.
SET @m8_lectures_search_idx = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures'
      AND INDEX_NAME = 'idx_lectures_search_course_pub'
);
SET @m8_lectures_search_ddl = IF(
    @m8_lectures_search_idx = 0,
    'ALTER TABLE lectures ADD INDEX idx_lectures_search_course_pub (course_id, is_published, archived_at)',
    'SELECT 1'
);
PREPARE m8_lectures_search_stmt FROM @m8_lectures_search_ddl;
EXECUTE m8_lectures_search_stmt;
DEALLOCATE PREPARE m8_lectures_search_stmt;

-- announcements candidate load (student and staff): tenant pin + status +
-- audience + branch refinement.
SET @m8_announcements_search_idx = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements'
      AND INDEX_NAME = 'idx_announcements_search'
);
SET @m8_announcements_search_ddl = IF(
    @m8_announcements_search_idx = 0,
    'ALTER TABLE announcements ADD INDEX idx_announcements_search (tenant_id, status, audience, branch_id)',
    'SELECT 1'
);
PREPARE m8_announcements_search_stmt FROM @m8_announcements_search_ddl;
EXECUTE m8_announcements_search_stmt;
DEALLOCATE PREPARE m8_announcements_search_stmt;

-- question_bank_questions candidate load (staff owner): tenant pin + branch
-- refinement + archived gate. Complements idx_qb_questions_branch
-- (tenant_id, branch_id) and idx_qb_questions_tenant_archived
-- (tenant_id, archived_at) with the exact composite the search SQL filters on.
SET @m8_qb_questions_search_idx = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'question_bank_questions'
      AND INDEX_NAME = 'idx_qb_questions_search'
);
SET @m8_qb_questions_search_ddl = IF(
    @m8_qb_questions_search_idx = 0,
    'ALTER TABLE question_bank_questions ADD INDEX idx_qb_questions_search (tenant_id, branch_id, archived_at)',
    'SELECT 1'
);
PREPARE m8_qb_questions_search_stmt FROM @m8_qb_questions_search_ddl;
EXECUTE m8_qb_questions_search_stmt;
DEALLOCATE PREPARE m8_qb_questions_search_stmt;

-- ---------------------------------------------------------------------------
-- Q6 tenant_data_exports job ledger
-- ---------------------------------------------------------------------------
-- status lifecycle: pending -> completed | failed. requested_by is the
-- verified principal that started the export (tenant owner or platform
-- actor); storage_key points at the export manifest object; manifest JSON
-- carries the per-table completeness record (table, rows, bytes, checksum);
-- token_hash stores only the SHA-256 of the last issued download token
-- (the token itself is never persisted); expires_at bounds the download
-- window; error keeps a short failure reason for the operations view.
CREATE TABLE IF NOT EXISTS tenant_data_exports (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
    requested_by CHAR(36) NULL,
    storage_key VARCHAR(255) NULL,
    file_size BIGINT NULL,
    manifest JSON NULL,
    token_hash CHAR(64) NULL,
    expires_at TIMESTAMP NULL,
    error VARCHAR(1000) NULL,
    active_tenant_lock CHAR(36)
        GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN tenant_id ELSE NULL END) VIRTUAL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_tenant_data_exports_active (active_tenant_lock),
    KEY idx_tenant_data_exports_tenant_created (tenant_id, created_at),
    KEY idx_tenant_data_exports_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT 'M8 Q6 per-tenant data export jobs with completeness manifest';
