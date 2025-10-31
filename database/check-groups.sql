USE Freelance;
SELECT COUNT(*) as total_groups FROM `groups`;
SELECT COUNT(*) as active_groups FROM `groups` WHERE is_active = TRUE;
SELECT id, name, grade_id, is_active FROM `groups` LIMIT 10;
