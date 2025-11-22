Write-Host "🔧 Manual SQL Migration Guide" -ForegroundColor Cyan
Write-Host "================================`n" -ForegroundColor Cyan

Write-Host "Follow these steps to fix the issue:`n" -ForegroundColor Yellow

Write-Host "1️⃣ Open a NEW PowerShell/Terminal window`n" -ForegroundColor Green

Write-Host "2️⃣ Connect to the server:" -ForegroundColor Green
Write-Host "   ssh root@72.62.35.177" -ForegroundColor White
Write-Host "   Password: MyPass12345@`n" -ForegroundColor Gray

Write-Host "3️⃣ Once connected, run this command:" -ForegroundColor Green
Write-Host "   mysql -u Freelance -p'MyPass12345@' Freelance`n" -ForegroundColor White

Write-Host "4️⃣ Copy and paste these SQL commands one by one:`n" -ForegroundColor Green

$sql1 = "ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;"
$sql2 = "CREATE INDEX idx_students_guardian_phone ON students(guardian_phone);"
$sql3 = "ALTER TABLE student_registration_requests ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;"
$sql4 = "CREATE INDEX idx_registration_requests_guardian_phone ON student_registration_requests(guardian_phone);"
$sql5 = "SHOW COLUMNS FROM students LIKE 'guardian_phone';"
$sql6 = "SHOW COLUMNS FROM student_registration_requests LIKE 'guardian_phone';"

Write-Host "   $sql1" -ForegroundColor White
Write-Host "   $sql2" -ForegroundColor White  
Write-Host "   $sql3" -ForegroundColor White
Write-Host "   $sql4" -ForegroundColor White
Write-Host ""
Write-Host "5️⃣ Verify the columns were created:" -ForegroundColor Green
Write-Host "   $sql5" -ForegroundColor White
Write-Host "   $sql6`n" -ForegroundColor White

Write-Host "6️⃣ Type 'exit' to leave MySQL, then 'exit' again to leave SSH`n" -ForegroundColor Green

Write-Host "================================`n" -ForegroundColor Cyan

Write-Host "📋 OR: Copy this entire block and paste in MySQL:`n" -ForegroundColor Yellow

$allSql = @"
$sql1
$sql2
$sql3
$sql4
$sql5
$sql6
"@

Write-Host $allSql -ForegroundColor Cyan

Write-Host "`n================================`n" -ForegroundColor Cyan

Write-Host "✅ After running the SQL commands above, the issue will be fixed!" -ForegroundColor Green
Write-Host "Then you can:" -ForegroundColor Yellow
Write-Host "   - Create new accounts with guardian phone ✓" -ForegroundColor White
Write-Host "   - Guardian phone will be saved correctly ✓" -ForegroundColor White
Write-Host "   - It will appear in both students pages ✓`n" -ForegroundColor White

# Save to file
$allSql | Out-File -FilePath "APPLY_THIS_SQL.sql" -Encoding UTF8
Write-Host "📄 SQL commands saved to: APPLY_THIS_SQL.sql" -ForegroundColor Green
