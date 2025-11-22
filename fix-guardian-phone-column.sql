-- Fix guardian_phone column in MySQL database

-- Check and add guardian_phone to students table if not exists
SELECT 'Checking students table...' as step;

-- Add column if it doesn't exist
SET @dbname = DATABASE();
SET @tablename = 'students';
SET @columnname = 'guardian_phone';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = @columnname
  ) > 0,
  'SELECT ''Column guardian_phone already exists in students'' AS INFO;',
  'ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;'
));

PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Check and add guardian_phone to student_registration_requests table
SELECT 'Checking student_registration_requests table...' as step;

SET @tablename = 'student_registration_requests';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = @columnname
  ) > 0,
  'SELECT ''Column guardian_phone already exists in student_registration_requests'' AS INFO;',
  'ALTER TABLE student_registration_requests ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;'
));

PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

SELECT '✅ Migration completed!' as status;
