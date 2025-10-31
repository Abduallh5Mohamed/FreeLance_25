USE Freelance;

SELECT 'Active Groups:' as info;
SELECT id, name, is_active FROM `groups` WHERE is_active = TRUE;

SELECT 'Deleted Groups (Soft Delete):' as info;
SELECT id, name, is_active, updated_at FROM `groups` WHERE is_active = FALSE;

SELECT 'All Groups:' as info;
SELECT id, name, is_active FROM `groups`;
