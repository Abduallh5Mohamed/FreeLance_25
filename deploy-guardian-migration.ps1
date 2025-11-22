# Deploy guardian_phone migration to server

Write-Host "🚀 Deploying guardian_phone migration..." -ForegroundColor Cyan
Write-Host ""

# SQL content
$sql = @"
-- Add guardian_phone column to students and student_registration_requests tables

ALTER TABLE students 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

CREATE INDEX IF NOT EXISTS idx_students_guardian_phone 
ON students(guardian_phone);

ALTER TABLE student_registration_requests 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;

CREATE INDEX IF NOT EXISTS idx_registration_requests_guardian_phone 
ON student_registration_requests(guardian_phone);

SELECT 'Migration completed!' AS status;
"@

# Save to temp file
$tempFile = "temp_guardian_migration.sql"
$sql | Out-File -FilePath $tempFile -Encoding UTF8

Write-Host "✅ Migration SQL created" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Migration content:" -ForegroundColor Yellow
Write-Host $sql
Write-Host ""
Write-Host "==========================================`n" -ForegroundColor Cyan

# Instructions for manual execution
Write-Host "📌 To apply this migration on the server:" -ForegroundColor Yellow
Write-Host ""
Write-Host "Option 1 - Via SSH:" -ForegroundColor Cyan
Write-Host "  1. Copy the SQL above"
Write-Host "  2. SSH into server: ssh root@72.62.35.177"
Write-Host "  3. Run: mysql -u Freelance -p'MyPass12345@' Freelance"
Write-Host "  4. Paste and execute the SQL"
Write-Host ""
Write-Host "Option 2 - Using mysql client:" -ForegroundColor Cyan  
Write-Host "  mysql -h 72.62.35.177 -u Freelance -p'MyPass12345@' Freelance < $tempFile"
Write-Host ""
Write-Host "Option 3 - Via phpMyAdmin or similar tool" -ForegroundColor Cyan
Write-Host ""

# Try to execute via mysql if available
Write-Host "🔍 Checking for mysql client..." -ForegroundColor Cyan
$mysqlPath = Get-Command mysql -ErrorAction SilentlyContinue

if ($mysqlPath) {
    Write-Host "✅ MySQL client found!" -ForegroundColor Green
    Write-Host ""
    $confirm = Read-Host "Do you want to execute the migration now? (y/n)"
    
    if ($confirm -eq 'y') {
        Write-Host ""
        Write-Host "🚀 Executing migration..." -ForegroundColor Cyan
        Get-Content $tempFile | mysql -h 72.62.35.177 -u Freelance -p"MyPass12345@" Freelance
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Migration executed successfully!" -ForegroundColor Green
        }
        else {
            Write-Host "❌ Migration failed. Please try manual execution." -ForegroundColor Red
        }
    }
}
else {
    Write-Host "⚠ MySQL client not found in PATH" -ForegroundColor Yellow
    Write-Host "Please use one of the manual options above" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==========================================`n" -ForegroundColor Cyan
