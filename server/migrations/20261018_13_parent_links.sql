-- =============================================================================
-- M6 P1/P2 — parent-student verified links and scoped read-view tokens
-- Task:    m6-server-parent-links-views-20261018-13
-- Date:    2026-10-18
-- Scope:   P1 verified linking + P2 read-only parent views.
--
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime; an
-- operator applies this file on the isolated bootstrap/validation stack. Every
-- statement is guarded by an INFORMATION_SCHEMA probe and PREPARE/EXECUTE, so
-- re-running it is a no-op. No DROP, TRUNCATE, FK-disable or data rewrite.
--
-- MODEL
--   parent_links        — one verified link between an authenticated parent
--                         identity and one student enrollment. Created only
--                         after a single-use OTP proof (contact hash stored,
--                         never the contact). UNIQUE(tenant, enrollment, parent)
--                         makes a duplicate link idempotent.
--   parent_view_tokens  — a short-lived, revocable scoped read token. The HMAC
--                         token is bound to (link, tenant, enrollment, parent);
--                         this row is the revocation/expiry record checked by
--                         the read-only parent views on every request.
--
-- ISOLATION
--   Every table carries tenant_id and is only read/written through a predicate
--   that includes it. parent_view_tokens.link_id cascades with its link.
-- =============================================================================

SET @m6_db = DATABASE();

-- -----------------------------------------------------------------------------
-- parent_links
-- -----------------------------------------------------------------------------
SET @has_parent_links = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_db AND TABLE_NAME = 'parent_links');
SET @sql_parent_links = IF(@has_parent_links = 0,
    "CREATE TABLE parent_links (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        parent_user_id CHAR(36) NOT NULL,
        contact_hash CHAR(64) NOT NULL COMMENT 'HMAC of the verified contact; never the contact itself',
        status ENUM('active','revoked') NOT NULL DEFAULT 'active',
        version INT NOT NULL DEFAULT 0,
        revoked_at TIMESTAMP NULL,
        revoked_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_parent_link (tenant_id, student_enrollment_id, parent_user_id),
        KEY idx_parent_link_parent (tenant_id, parent_user_id, status),
        KEY idx_parent_link_student (tenant_id, student_enrollment_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P1 verified parent-student link'",
    'SELECT 1');
PREPARE stmt_parent_links FROM @sql_parent_links;
EXECUTE stmt_parent_links;
DEALLOCATE PREPARE stmt_parent_links;

-- -----------------------------------------------------------------------------
-- parent_view_tokens
-- -----------------------------------------------------------------------------
SET @has_parent_view_tokens = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m6_db AND TABLE_NAME = 'parent_view_tokens');
SET @sql_parent_view_tokens = IF(@has_parent_view_tokens = 0,
    "CREATE TABLE parent_view_tokens (
        jti CHAR(36) NOT NULL,
        link_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        parent_user_id CHAR(36) NOT NULL,
        issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP NULL,
        revoked_reason VARCHAR(200) NULL,
        PRIMARY KEY (jti),
        KEY idx_parent_view_token_link (link_id),
        KEY idx_parent_view_token_expiry (expires_at, revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M6 P2 revocable scoped parent read-view token'",
    'SELECT 1');
PREPARE stmt_parent_view_tokens FROM @sql_parent_view_tokens;
EXECUTE stmt_parent_view_tokens;
DEALLOCATE PREPARE stmt_parent_view_tokens;

-- -----------------------------------------------------------------------------
-- Foreign keys, added separately and guarded by name so a partial re-run
-- (for example an interrupted first attempt) converges without error.
-- -----------------------------------------------------------------------------
SET @fk_parent_links_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_db AND TABLE_NAME = 'parent_links'
      AND CONSTRAINT_NAME = 'fk_parent_links_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_parent_links_tenant = IF(@fk_parent_links_tenant = 0,
    "ALTER TABLE parent_links ADD CONSTRAINT fk_parent_links_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_parent_links_tenant FROM @sql_fk_parent_links_tenant;
EXECUTE stmt_fk_parent_links_tenant;
DEALLOCATE PREPARE stmt_fk_parent_links_tenant;

SET @fk_parent_links_student = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_db AND TABLE_NAME = 'parent_links'
      AND CONSTRAINT_NAME = 'fk_parent_links_student' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_parent_links_student = IF(@fk_parent_links_student = 0,
    "ALTER TABLE parent_links ADD CONSTRAINT fk_parent_links_student FOREIGN KEY (student_enrollment_id) REFERENCES students(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_parent_links_student FROM @sql_fk_parent_links_student;
EXECUTE stmt_fk_parent_links_student;
DEALLOCATE PREPARE stmt_fk_parent_links_student;

SET @fk_parent_links_parent = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_db AND TABLE_NAME = 'parent_links'
      AND CONSTRAINT_NAME = 'fk_parent_links_parent' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_parent_links_parent = IF(@fk_parent_links_parent = 0,
    "ALTER TABLE parent_links ADD CONSTRAINT fk_parent_links_parent FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_parent_links_parent FROM @sql_fk_parent_links_parent;
EXECUTE stmt_fk_parent_links_parent;
DEALLOCATE PREPARE stmt_fk_parent_links_parent;

SET @fk_parent_view_token_link = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m6_db AND TABLE_NAME = 'parent_view_tokens'
      AND CONSTRAINT_NAME = 'fk_parent_view_token_link' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_parent_view_token_link = IF(@fk_parent_view_token_link = 0,
    "ALTER TABLE parent_view_tokens ADD CONSTRAINT fk_parent_view_token_link FOREIGN KEY (link_id) REFERENCES parent_links(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_parent_view_token_link FROM @sql_fk_parent_view_token_link;
EXECUTE stmt_fk_parent_view_token_link;
DEALLOCATE PREPARE stmt_fk_parent_view_token_link;
