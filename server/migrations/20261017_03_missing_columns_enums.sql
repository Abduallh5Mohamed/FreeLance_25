-- Add columns used by server routes but absent from the legacy baseline.
-- Every DDL operation is guarded so this file can be safely re-run.
-- This migration is authored only; do not execute it as part of code validation.

-- exams.grade_id
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'grade_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE exams ADD COLUMN grade_id CHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- exams.start_dt
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'start_dt');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE exams ADD COLUMN start_dt DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- exams.end_dt
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'end_dt');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE exams ADD COLUMN end_dt DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND INDEX_NAME = 'idx_exams_grade');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE exams ADD INDEX idx_exams_grade (grade_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND CONSTRAINT_NAME = 'fk_exams_grade');
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE exams ADD CONSTRAINT fk_exams_grade FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- online_meetings fields; existing links are copied from the legacy column.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_meetings' AND COLUMN_NAME = 'meeting_link');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE online_meetings ADD COLUMN meeting_link VARCHAR(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE online_meetings
SET meeting_link = meeting_url
WHERE meeting_link IS NULL;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_meetings' AND COLUMN_NAME = 'meeting_type');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE online_meetings ADD COLUMN meeting_type VARCHAR(32) NOT NULL DEFAULT ''zoom''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_meetings' AND COLUMN_NAME = 'grade_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE online_meetings ADD COLUMN grade_id CHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_meetings' AND INDEX_NAME = 'idx_online_meetings_created_by');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE online_meetings ADD INDEX idx_online_meetings_created_by (created_by)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_meetings' AND INDEX_NAME = 'idx_online_meetings_grade_group');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE online_meetings ADD INDEX idx_online_meetings_grade_group (grade_id, group_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'online_meetings' AND CONSTRAINT_NAME = 'fk_online_meetings_grade');
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE online_meetings ADD CONSTRAINT fk_online_meetings_grade FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Video encryption metadata used by secure-video and processing routes.
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'is_encrypted');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE videos ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos' AND COLUMN_NAME = 'encryption_key');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE videos ADD COLUMN encryption_key CHAR(32) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Widen only the known baseline enum; custom enum definitions are left intact.
SET @status_type = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_attempts' AND COLUMN_NAME = 'status');
SET @status_has_required_values = @status_type IS NOT NULL
  AND @status_type LIKE 'enum(%'
  AND LOCATE('''in_progress''', @status_type) > 0
  AND LOCATE('''completed''', @status_type) > 0
  AND LOCATE('''abandoned''', @status_type) > 0
  AND LOCATE('''passed''', @status_type) > 0
  AND LOCATE('''failed''', @status_type) > 0
  AND LOCATE('''pending_review''', @status_type) > 0;
SET @sql = CASE
  WHEN @status_has_required_values THEN 'SELECT 1'
  WHEN @status_type = 'enum(''in_progress'',''completed'',''abandoned'')' THEN
    'ALTER TABLE exam_attempts MODIFY COLUMN status ENUM(''in_progress'',''completed'',''abandoned'',''passed'',''failed'',''pending_review'') NULL DEFAULT ''in_progress'''
  ELSE 'SELECT m1_schema_review_required_for_exam_attempts_status_enum'
END;
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_attempts' AND COLUMN_NAME = 'essay_scores');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE exam_attempts ADD COLUMN essay_scores JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Phone-based student lookups are used by lectures and exam routes.
SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND INDEX_NAME = 'idx_students_phone');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE students ADD INDEX idx_students_phone (phone)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND INDEX_NAME = 'idx_students_tenant_phone');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE students ADD INDEX idx_students_tenant_phone (tenant_id, phone)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
