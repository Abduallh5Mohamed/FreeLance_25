Write-Host "=== Testing Direct Student Filtering ===" -ForegroundColor Cyan
Write-Host ""

# We know the student user ID from earlier
$studentUserId = "3503b1c1-1c6d-4fe8-9d55-f55bf62ec3fc"  # Baraa wael

Write-Host "Testing for student: Baraa wael ($studentUserId)" -ForegroundColor Yellow

# Test student lectures
Write-Host "1. Testing student lectures..." -ForegroundColor Yellow
try {
    $lectures = Invoke-RestMethod -Uri "http://localhost:3001/api/lectures/student/$studentUserId" -Method Get
    Write-Host "   SUCCESS: Found $($lectures.Count) lectures" -ForegroundColor Green
    
    if ($lectures.Count -gt 0) {
        foreach ($lecture in $lectures) {
            Write-Host "     - $($lecture.title)" -ForegroundColor Gray
            Write-Host "       Group: $($lecture.group_name) (ID: $($lecture.group_id))" -ForegroundColor Gray
        }
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host "   Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}

Write-Host ""

# Test student materials
Write-Host "2. Testing student materials..." -ForegroundColor Yellow
try {
    $materials = Invoke-RestMethod -Uri "http://localhost:3001/api/materials/student/$studentUserId" -Method Get
    Write-Host "   SUCCESS: Found $($materials.Count) materials" -ForegroundColor Green
    
    if ($materials.Count -gt 0) {
        foreach ($material in $materials) {
            Write-Host "     - $($material.title)" -ForegroundColor Gray
            Write-Host "       Group IDs: $($material.group_ids -join ', ')" -ForegroundColor Gray
        }
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host "   Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
