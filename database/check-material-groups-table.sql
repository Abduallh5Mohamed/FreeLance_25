USE Freelance;

-- Check if material_groups table exists
SHOW TABLES LIKE 'material_groups';

-- Show table structure
DESCRIBE material_groups;

-- Check for any data
SELECT COUNT(*) as total_records FROM material_groups;
