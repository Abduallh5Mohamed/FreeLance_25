-- =============================================================================
-- M5 G2 + G3 — Recurring schedules/calendar and manual attendance records
-- Task:    m5-server-schedules-attendance-20261018-11
-- Date:    2026-10-18
-- Scope:   G2 recurring schedule series + concrete sessions (IANA timezone,
--          tenant/branch/group audience, cancel/reschedule with actor +
--          reason), and G3 manual attendance records (present/absent/late/
--          excused) attached to a session with a per-(session, student) unique
--          key so duplicate marking is idempotent.
--
-- AUTHORING-ONLY / NOT EXECUTED. The application never runs DDL at runtime; an
-- operator applies this file on the isolated bootstrap/validation stack. Every
-- statement is guarded by an INFORMATION_SCHEMA probe and PREPARE/EXECUTE, so
-- re-running it is a no-op. No DROP, TRUNCATE, FK-disable or data rewrite.
--
-- MODEL
--   schedule_series   — a tenant-owned recurrence definition. The stored
--                       starts_at/ends_at instants on each generated session
--                       are absolute UTC, derived from (local wall time, IANA
--                       timezone); the timezone is retained for re-editing.
--   schedule_sessions — concrete occurrences. `series_id` is NULL for a
--                       one-off session. UNIQUE (series_id, starts_at) makes
--                       re-materializing the same series idempotent.
--   attendance_records— one row per (session, student). UNIQUE
--                       (session_id, student_id) is the duplicate-marking
--                       guard; a re-mark with a new state is a correction and
--                       is audited with before/after by the API layer.
--
-- TENANT/BRANCH ISOLATION
--   Every table carries tenant_id and is only ever read/written through a
--   predicate that includes it. Branch/group columns refine a tenant-owned row;
--   a NULL branch/group is a tenant-level row, never a shared row.
-- =============================================================================

SET @m5_db = DATABASE();

-- -----------------------------------------------------------------------------
-- schedule_series: recurring definition (weekly by weekday, or monthly by
-- day-of-month with month-end clamping applied when the API expands it).
-- -----------------------------------------------------------------------------
SET @has_series = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m5_db AND TABLE_NAME = 'schedule_series');
SET @sql_series = IF(@has_series = 0,
    "CREATE TABLE schedule_series (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NULL COMMENT 'Set only when audience=branch',
        group_id CHAR(36) NULL COMMENT 'Set only when audience=group',
        title VARCHAR(200) NOT NULL,
        audience ENUM('tenant','branch','group') NOT NULL DEFAULT 'tenant',
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC' COMMENT 'IANA timezone the recurrence was authored in',
        recurrence ENUM('weekly','monthly') NOT NULL,
        weekdays VARCHAR(20) NULL COMMENT 'CSV of ISO days 0=Sun..6=Sat for weekly',
        day_of_month TINYINT NULL COMMENT '1..31 for monthly; clamped to month end when expanding',
        starts_on DATE NOT NULL,
        ends_on DATE NULL COMMENT 'Inclusive last date; NULL means open-ended up to the expansion horizon',
        start_time TIME NOT NULL COMMENT 'Local wall time in `timezone`',
        duration_minutes INT NOT NULL,
        status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
        created_by CHAR(36) NULL,
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_schedule_series_tenant (tenant_id, status),
        KEY idx_schedule_series_branch (tenant_id, branch_id),
        KEY idx_schedule_series_group (tenant_id, group_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M5 G2 tenant-owned recurring schedule definition'",
    'SELECT 1');
PREPARE stmt_series FROM @sql_series;
EXECUTE stmt_series;
DEALLOCATE PREPARE stmt_series;

-- -----------------------------------------------------------------------------
-- schedule_sessions: concrete UTC occurrences. UNIQUE (series_id, starts_at)
-- makes generation idempotent; series_id is NULL for a one-off session.
-- -----------------------------------------------------------------------------
SET @has_sessions = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m5_db AND TABLE_NAME = 'schedule_sessions');
SET @sql_sessions = IF(@has_sessions = 0,
    "CREATE TABLE schedule_sessions (
        id CHAR(36) NOT NULL,
        series_id CHAR(36) NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NULL,
        group_id CHAR(36) NULL,
        title VARCHAR(200) NOT NULL,
        audience ENUM('tenant','branch','group') NOT NULL DEFAULT 'tenant',
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        starts_at DATETIME NOT NULL COMMENT 'Absolute UTC instant',
        ends_at DATETIME NOT NULL COMMENT 'Absolute UTC instant',
        status ENUM('scheduled','cancelled') NOT NULL DEFAULT 'scheduled',
        cancel_reason VARCHAR(255) NULL,
        cancelled_by CHAR(36) NULL,
        cancelled_at DATETIME NULL,
        rescheduled_from DATETIME NULL COMMENT 'Previous UTC start, kept for audit',
        reschedule_reason VARCHAR(255) NULL,
        rescheduled_by CHAR(36) NULL,
        rescheduled_at DATETIME NULL,
        created_by CHAR(36) NULL,
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_schedule_session_series_start (series_id, starts_at),
        KEY idx_schedule_sessions_tenant_start (tenant_id, starts_at),
        KEY idx_schedule_sessions_tenant_group (tenant_id, group_id, starts_at),
        KEY idx_schedule_sessions_tenant_branch (tenant_id, branch_id, starts_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M5 G2 concrete UTC schedule occurrences'",
    'SELECT 1');
PREPARE stmt_sessions FROM @sql_sessions;
EXECUTE stmt_sessions;
DEALLOCATE PREPARE stmt_sessions;

-- -----------------------------------------------------------------------------
-- attendance_records: one row per (session, student). The unique key is the
-- duplicate-marking guard; the API treats a re-mark with a changed state as an
-- audit-recorded correction (before/after).
-- -----------------------------------------------------------------------------
SET @has_attendance = (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = @m5_db AND TABLE_NAME = 'attendance_records');
SET @sql_attendance = IF(@has_attendance = 0,
    "CREATE TABLE attendance_records (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        session_id CHAR(36) NOT NULL,
        group_id CHAR(36) NULL,
        student_id CHAR(36) NOT NULL,
        state ENUM('present','absent','late','excused') NOT NULL,
        reason VARCHAR(255) NULL,
        marked_by CHAR(36) NULL,
        marked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        corrected_at DATETIME NULL,
        corrected_by CHAR(36) NULL,
        correction_reason VARCHAR(255) NULL,
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_attendance_student_session (session_id, student_id),
        KEY idx_attendance_tenant_session (tenant_id, session_id),
        KEY idx_attendance_tenant_student (tenant_id, student_id),
        KEY idx_attendance_state (session_id, state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'M5 G3 manual attendance records; UNIQUE(session, student) is the idempotency guard'",
    'SELECT 1');
PREPARE stmt_attendance FROM @sql_attendance;
EXECUTE stmt_attendance;
DEALLOCATE PREPARE stmt_attendance;

-- -----------------------------------------------------------------------------
-- Foreign keys are added separately and guarded by name so a partial re-run
-- (for example an interrupted first attempt) converges without error.
-- -----------------------------------------------------------------------------
SET @fk_series_tenant = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m5_db AND TABLE_NAME = 'schedule_series'
      AND CONSTRAINT_NAME = 'fk_schedule_series_tenant' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_series_tenant = IF(@fk_series_tenant = 0,
    "ALTER TABLE schedule_series ADD CONSTRAINT fk_schedule_series_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_series_tenant FROM @sql_fk_series_tenant;
EXECUTE stmt_fk_series_tenant;
DEALLOCATE PREPARE stmt_fk_series_tenant;

SET @fk_sessions_series = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m5_db AND TABLE_NAME = 'schedule_sessions'
      AND CONSTRAINT_NAME = 'fk_schedule_sessions_series' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_sessions_series = IF(@fk_sessions_series = 0,
    "ALTER TABLE schedule_sessions ADD CONSTRAINT fk_schedule_sessions_series FOREIGN KEY (series_id) REFERENCES schedule_series(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_sessions_series FROM @sql_fk_sessions_series;
EXECUTE stmt_fk_sessions_series;
DEALLOCATE PREPARE stmt_fk_sessions_series;

SET @fk_attendance_session = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m5_db AND TABLE_NAME = 'attendance_records'
      AND CONSTRAINT_NAME = 'fk_attendance_session' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_attendance_session = IF(@fk_attendance_session = 0,
    "ALTER TABLE attendance_records ADD CONSTRAINT fk_attendance_session FOREIGN KEY (session_id) REFERENCES schedule_sessions(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_attendance_session FROM @sql_fk_attendance_session;
EXECUTE stmt_fk_attendance_session;
DEALLOCATE PREPARE stmt_fk_attendance_session;

SET @fk_attendance_student = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @m5_db AND TABLE_NAME = 'attendance_records'
      AND CONSTRAINT_NAME = 'fk_attendance_student' AND CONSTRAINT_TYPE = 'FOREIGN KEY');
SET @sql_fk_attendance_student = IF(@fk_attendance_student = 0,
    "ALTER TABLE attendance_records ADD CONSTRAINT fk_attendance_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE",
    'SELECT 1');
PREPARE stmt_fk_attendance_student FROM @sql_fk_attendance_student;
EXECUTE stmt_fk_attendance_student;
DEALLOCATE PREPARE stmt_fk_attendance_student;
