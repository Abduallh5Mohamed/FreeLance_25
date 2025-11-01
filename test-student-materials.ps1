# Quick Test - Student Materials API

Write-Host "=== Testing Student Materials API ===" -ForegroundColor Cyan

$userId = "41890744-e1f1-4236-8918-d09a2358c2e0"
$studentId = "d48eccb5-bf30-49c7-9dd3-271eb80d67b4"

Write-Host "`nTest 1: API with user_id..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/materials/student/$userId" -Method Get
    Write-Host "SUCCESS! Materials count: $($response.Count)" -ForegroundColor Green
    $response | ForEach-Object {
        Write-Host "   - $($_.title) ($($_.material_type))" -ForegroundColor White
    }
} catch {
    Write-Host "FAILED: $_" -ForegroundColor Red
}

Write-Host "`nTest 2: API with student_id..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/materials/student/$studentId" -Method Get
    Write-Host "SUCCESS! Materials count: $($response.Count)" -ForegroundColor Green
} catch {
    Write-Host "FAILED: $_" -ForegroundColor Red
}

Write-Host "`n=== Test Complete ===" -ForegroundColor Cyan
Write-Host "Next Steps:" -ForegroundColor White
Write-Host "1. Start Backend: npm run dev (in server folder)" -ForegroundColor White
Write-Host "2. Start Frontend: npm run dev" -ForegroundColor White
Write-Host "3. Login with phone: 01029290728" -ForegroundColor White
Write-Host "4. Open Student Content page" -ForegroundColor White
Write-Host "5. You should see 4 materials!" -ForegroundColor Green
