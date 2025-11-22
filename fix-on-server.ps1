# SSH to server and fix guardian_phone columns

Write-Host "🚀 Connecting to server and fixing guardian_phone issue..." -ForegroundColor Cyan
Write-Host ""

$sql = @"
-- Add guardian_phone columns
ALTER TABLE students ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;
ALTER TABLE student_registration_requests ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_students_guardian_phone ON students(guardian_phone);
CREATE INDEX IF NOT EXISTS idx_registration_requests_guardian_phone ON student_registration_requests(guardian_phone);

-- Show status
SELECT 'Migration completed successfully!' AS status;
SHOW COLUMNS FROM students LIKE 'guardian_phone';
SHOW COLUMNS FROM student_registration_requests LIKE 'guardian_phone';
"@

# Save SQL to file
$sql | Out-File -FilePath "temp_migration.sql" -Encoding UTF8 -NoNewline

Write-Host "📋 SQL Migration:" -ForegroundColor Yellow
Write-Host $sql -ForegroundColor Gray
Write-Host ""

Write-Host "🔗 Executing on server via SSH..." -ForegroundColor Cyan
Write-Host ""

# Create a properly formatted SQL file
$sqlContent = $sql -replace "`r`n", "`n"
$sqlContent | Out-File -FilePath "temp_migration.sql" -Encoding ASCII -NoNewline

# Upload and execute via SSH
Write-Host "📤 Uploading SQL file to server..." -ForegroundColor Yellow
scp temp_migration.sql root@72.62.35.177:/tmp/migration.sql

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ File uploaded!" -ForegroundColor Green
    Write-Host ""
    Write-Host "🔧 Executing SQL on server..." -ForegroundColor Yellow
    
    $result = ssh root@72.62.35.177 "mysql -u Freelance -p'MyPass12345@' Freelance < /tmp/migration.sql"
    
    Write-Host $result
    Write-Host ""

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Migration executed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "🔄 Now testing the fix..." -ForegroundColor Cyan
    
    # Run test
    node detailed-diagnosis.js
} else {
    Write-Host "❌ Migration failed!" -ForegroundColor Red
    Write-Host "Exit code: $LASTEXITCODE" -ForegroundColor Red
}
