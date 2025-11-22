Write-Host @"
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║         🔧 Guardian Phone Fix - Final Solution 🔧           ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

Write-Host "`n📋 Problem Summary:" -ForegroundColor Yellow
Write-Host "   - Guardian phone not showing in /offline-students page" -ForegroundColor White
Write-Host "   - Guardian phone not showing in /students page" -ForegroundColor White
Write-Host "   - Cause: Missing 'guardian_phone' columns in database`n" -ForegroundColor White

Write-Host "✅ What's been fixed:" -ForegroundColor Green
Write-Host "   ✓ Frontend code updated (Students.tsx, OfflineStudents.tsx)" -ForegroundColor White
Write-Host "   ✓ Backend code verified (working correctly)" -ForegroundColor White
Write-Host "   ✗ Database columns (needs to be added)`n" -ForegroundColor Red

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan

Write-Host "🎯 SOLUTION - Run these commands:" -ForegroundColor Yellow
Write-Host "`nOption 1: One command (recommended):`n" -ForegroundColor Green

$command = @'
ssh root@72.62.35.177 "mysql -u Freelance -p'MyPass12345@' Freelance -e \"ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone; CREATE INDEX idx_students_guardian_phone ON students(guardian_phone); ALTER TABLE student_registration_requests ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone; CREATE INDEX idx_registration_requests_guardian_phone ON student_registration_requests(guardian_phone); SELECT 'Done!' AS Status;\""
'@

Write-Host $command -ForegroundColor Cyan

Write-Host "`n`nOption 2: Step by step:`n" -ForegroundColor Green
Write-Host "   1. ssh root@72.62.35.177" -ForegroundColor White
Write-Host "   2. mysql -u Freelance -p'MyPass12345@' Freelance" -ForegroundColor White  
Write-Host "   3. Paste the SQL from FIX_GUARDIAN_PHONE.sql" -ForegroundColor White
Write-Host "   4. exit (twice)`n" -ForegroundColor White

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan

Write-Host "📄 Files created for you:" -ForegroundColor Yellow
Write-Host "   - FIX_GUARDIAN_PHONE.sql (SQL commands)" -ForegroundColor White
Write-Host "   - COMPLETE_FIX_GUIDE.md (detailed guide)" -ForegroundColor White
Write-Host "   - detailed-diagnosis.js (test script)" -ForegroundColor White
Write-Host "   - auto-fill-guardian-phones.js (auto-fill for old students)`n" -ForegroundColor White

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan

$tryNow = Read-Host "`nDo you want to try applying the fix now? (y/n)"

if ($tryNow -eq 'y' -or $tryNow -eq 'Y') {
    Write-Host "`n🚀 Attempting to apply fix...`n" -ForegroundColor Cyan
    
    try {
        $sql = Get-Content "FIX_GUARDIAN_PHONE.sql" -Raw
        $sql = $sql -replace '--.*', '' -replace "`r`n", ' ' -replace "`n", ' '
        
        Write-Host "Connecting to server and executing SQL..." -ForegroundColor Yellow
        
        $result = ssh root@72.62.35.177 "mysql -u Freelance -p'MyPass12345@' Freelance -e `"$sql`""
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "`n✅✅✅ SUCCESS! Migration applied!" -ForegroundColor Green
            Write-Host "`nResult:" -ForegroundColor Yellow
            Write-Host $result -ForegroundColor White
            
            Write-Host "`n🧪 Running diagnosis to verify..." -ForegroundColor Cyan
            node detailed-diagnosis.js
        } else {
            Write-Host "`n❌ Failed to apply. Try manual method." -ForegroundColor Red
        }
    } catch {
        Write-Host "`n❌ Error: $_" -ForegroundColor Red
        Write-Host "`nPlease use manual method (Option 2 above)" -ForegroundColor Yellow
    }
} else {
    Write-Host "`n📖 Check COMPLETE_FIX_GUIDE.md for detailed instructions!" -ForegroundColor Yellow
}

Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan
