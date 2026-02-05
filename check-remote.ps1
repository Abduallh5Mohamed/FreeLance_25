# Check and setup test data
Write-Host "Connecting to server to check database..."

# Use sshpass if available, or manual password entry
$commands = @"
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance << 'EOSQL'

-- Check current state
SELECT 'USERS' as table_name;
SELECT id, name, phone, role FROM users;

SELECT 'STUDENTS' as table_name;
SELECT id, name, phone, group_id FROM students;

SELECT 'GROUPS' as table_name;
SELECT id, name FROM \`groups\`;

SELECT 'EXAMS' as table_name;
SELECT id, title, is_active FROM exams;

SELECT 'EXAM_GROUPS' as table_name;
SELECT * FROM exam_groups;

EOSQL
"@

# Save to temp file
$commands | Out-File -FilePath ".\temp-check.sh" -Encoding UTF8

Write-Host "Script saved. Please run manually: ssh root@72.62.35.177 'bash -s' < temp-check.sh"
