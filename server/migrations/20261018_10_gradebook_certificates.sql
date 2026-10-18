-- =============================================================================
-- M4 A6 + A7 + A8 — Gradebook, student progress/reports, certificates
-- Task:    m4-server-gradebook-certificates-20261018-10
-- Date:    2026-10-18
-- =============================================================================

SET @m4_db = DATABASE();

-- gradebook_policies: per-course grading policy (points or weighted), visible to students.
SET @has_gp = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'gradebook_policies');
SET @sql_gp = IF(@has_gp = 0,
    "CREATE TABLE gradebook_policies (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        course_id CHAR(36) NOT NULL,
        mode ENUM('points','weighted') NOT NULL DEFAULT 'points',
        passing_score DECIMAL(6,2) NULL,
        rounding ENUM('half_up','half_even','none') NOT NULL DEFAULT 'half_up',
        categories JSON NULL,
        created_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_gradebook_policy (tenant_id, course_id),
        KEY idx_gradebook_policy_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A6 per-course grading policy'",
    'SELECT 1');
PREPARE stmt_gp FROM @sql_gp;
EXECUTE stmt_gp;
DEALLOCATE PREPARE stmt_gp;

-- gradebook_scores: stored scores a calculated grade is recomputed from.
SET @has_gs = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'gradebook_scores');
SET @sql_gs = IF(@has_gs = 0,
    "CREATE TABLE gradebook_scores (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        course_id CHAR(36) NOT NULL,
        category_id VARCHAR(64) NULL,
        item_type VARCHAR(32) NULL,
        item_id CHAR(36) NULL,
        score DECIMAL(12,4) NOT NULL,
        max_score DECIMAL(12,4) NOT NULL,
        weight DECIMAL(8,4) NULL,
        recorded_by CHAR(36) NULL,
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_gradebook_scores_student (tenant_id, student_enrollment_id, course_id),
        KEY idx_gradebook_scores_course (tenant_id, course_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A6 stored scores for recomputation'",
    'SELECT 1');
PREPARE stmt_gs FROM @sql_gs;
EXECUTE stmt_gs;
DEALLOCATE PREPARE stmt_gs;

-- certificates: server-issued, immutable once issued, revocable.
SET @has_cert = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m4_db AND TABLE_NAME = 'certificates');
SET @sql_cert = IF(@has_cert = 0,
    "CREATE TABLE certificates (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        course_id CHAR(36) NOT NULL,
        verification_id VARCHAR(64) NOT NULL,
        status ENUM('issued','revoked') NOT NULL DEFAULT 'issued',
        final_score DECIMAL(6,2) NULL,
        issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        issued_by CHAR(36) NULL,
        revoked_at TIMESTAMP NULL,
        revoked_by CHAR(36) NULL,
        revoke_reason VARCHAR(255) NULL,
        branding_logo_url VARCHAR(2048) NULL,
        branding_primary_color VARCHAR(16) NULL,
        branding_secondary_color VARCHAR(16) NULL,
        branding_accent_color VARCHAR(16) NULL,
        branding_locale VARCHAR(8) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cert_verification (verification_id),
        UNIQUE KEY uq_cert_student_course (tenant_id, student_enrollment_id, course_id),
        KEY idx_cert_tenant (tenant_id),
        KEY idx_cert_student (student_enrollment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M4 A8 server-issued certificates'",
    'SELECT 1');
PREPARE stmt_cert FROM @sql_cert;
EXECUTE stmt_cert;
DEALLOCATE PREPARE stmt_cert;
