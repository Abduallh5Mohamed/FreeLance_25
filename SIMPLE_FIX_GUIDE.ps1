Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "                    Guardian Phone Fix - Complete Solution                   " -ForegroundColor Yellow
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Problem:" -ForegroundColor Red
Write-Host "  Guardian phone number not appearing in students pages" -ForegroundColor White
Write-Host ""

Write-Host "Root Cause:" -ForegroundColor Yellow  
Write-Host "  Missing 'guardian_phone' columns in MySQL database" -ForegroundColor White
Write-Host ""

Write-Host "What's Done:" -ForegroundColor Green
Write-Host "  [OK] Frontend pages updated" -ForegroundColor White
Write-Host "  [OK] Backend API ready" -ForegroundColor White
Write-Host "  [  ] Database columns (needs manual fix)" -ForegroundColor Red
Write-Host ""

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "                            HOW TO FIX (5 minutes)                           " -ForegroundColor Yellow
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Step 1: Open NEW terminal/PowerShell window" -ForegroundColor Green
Write-Host ""

Write-Host "Step 2: Connect to server" -ForegroundColor Green
Write-Host "  ssh root@72.62.35.177" -ForegroundColor Cyan
Write-Host "  (Password: MyPass12345@)" -ForegroundColor Gray
Write-Host ""

Write-Host "Step 3: Run MySQL command" -ForegroundColor Green
Write-Host "  mysql -u Freelance -pMyPass12345@ Freelance" -ForegroundColor Cyan
Write-Host ""

Write-Host "Step 4: Copy & paste this SQL:" -ForegroundColor Green
Write-Host ""
Write-Host "ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;" -ForegroundColor Yellow
Write-Host "CREATE INDEX idx_students_guardian_phone ON students(guardian_phone);" -ForegroundColor Yellow
Write-Host "ALTER TABLE student_registration_requests ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;" -ForegroundColor Yellow
Write-Host "CREATE INDEX idx_registration_requests_guardian_phone ON student_registration_requests(guardian_phone);" -ForegroundColor Yellow
Write-Host "SHOW COLUMNS FROM students LIKE 'guardian_phone';" -ForegroundColor Yellow
Write-Host ""

Write-Host "Step 5: Type 'exit' twice to logout" -ForegroundColor Green
Write-Host ""

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "After fixing, you can:" -ForegroundColor Green
Write-Host "  - Create new accounts with guardian phone" -ForegroundColor White
Write-Host "  - Edit existing students to add guardian phone" -ForegroundColor White
Write-Host "  - See guardian phone in both /students and /offline-students pages" -ForegroundColor White
Write-Host ""

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Files created:" -ForegroundColor Yellow
Write-Host "  - FIX_GUARDIAN_PHONE.sql (SQL file)" -ForegroundColor White
Write-Host "  - COMPLETE_FIX_GUIDE.md (detailed guide)" -ForegroundColor White
Write-Host "  - detailed-diagnosis.js (test if fixed)" -ForegroundColor White
Write-Host ""

Write-Host "Need help? Check COMPLETE_FIX_GUIDE.md for detailed instructions!" -ForegroundColor Green
Write-Host ""
