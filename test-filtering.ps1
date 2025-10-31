Write-Host "=== Testing Student Group Filtering ===" -ForegroundColor Cyan
Write-Host ""

# Get student's group info
Write-Host "1. Getting student group info..." -ForegroundColor Yellow
try {
    $students = Invoke-RestMethod -Uri "http://localhost:3001/api/users" -Method Get -ErrorAction SilentlyContinue
    $studentUser = $students | Where-Object { $_.role -eq "student" } | Select-Object -First 1
    
    if ($studentUser) {
        Write-Host "   Student User: $($studentUser.name) (ID: $($studentUser.id))" -ForegroundColor Green
        
        # Test student lectures endpoint
        Write-Host "2. Testing student lectures endpoint..." -ForegroundColor Yellow
        $studentLectures = Invoke-RestMethod -Uri "http://localhost:3001/api/lectures/student/$($studentUser.id)" -Method Get
        Write-Host "   Found $($studentLectures.Count) lectures for this student" -ForegroundColor Green
        
        if ($studentLectures.Count -gt 0) {
            Write-Host "   Lectures:" -ForegroundColor Gray
            foreach ($lecture in $studentLectures) {
                Write-Host "     - $($lecture.title) (Group: $($lecture.group_name))" -ForegroundColor Gray
            }
        }
        
        # Test student materials endpoint
        Write-Host "3. Testing student materials endpoint..." -ForegroundColor Yellow
        $studentMaterials = Invoke-RestMethod -Uri "http://localhost:3001/api/materials/student/$($studentUser.id)" -Method Get
        Write-Host "   Found $($studentMaterials.Count) materials for this student" -ForegroundColor Green
        
        if ($studentMaterials.Count -gt 0) {
            Write-Host "   Materials:" -ForegroundColor Gray
            foreach ($material in $studentMaterials) {
                Write-Host "     - $($material.title) (Group IDs: $($material.group_ids -join ', '))" -ForegroundColor Gray
            }
        }
    } else {
        Write-Host "   No student user found" -ForegroundColor Red
    }
} catch {
    Write-Host "   Failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
