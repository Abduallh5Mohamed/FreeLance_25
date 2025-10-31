Write-Host "=== Testing Groups API Connection ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "Testing: GET /api/groups" -ForegroundColor Yellow
try {
    $groups = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    Write-Host "SUCCESS: Retrieved $($groups.Count) groups from MySQL" -ForegroundColor Green
    Write-Host ""
    
    if ($groups.Count -eq 0) {
        Write-Host "WARNING: No groups found in database!" -ForegroundColor Yellow
        Write-Host "Please add groups first at: http://localhost:8080/groups" -ForegroundColor Yellow
    } else {
        Write-Host "Groups found:" -ForegroundColor White
        foreach ($group in $groups) {
            $gradeInfo = if ($group.grade_id) { "Grade ID: $($group.grade_id)" } else { "No Grade" }
            Write-Host "  - $($group.name)" -ForegroundColor Cyan
            Write-Host "    ID: $($group.id)" -ForegroundColor Gray
            Write-Host "    $gradeInfo" -ForegroundColor Gray
            Write-Host "    Active: $($group.is_active)" -ForegroundColor Gray
            Write-Host ""
        }
    }
    
    # Show JSON
    Write-Host "Full JSON Response:" -ForegroundColor White
    $groups | ConvertTo-Json -Depth 5
    
} catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Possible issues:" -ForegroundColor Yellow
    Write-Host "1. Backend server not running on port 3001" -ForegroundColor Gray
    Write-Host "2. MySQL database connection issue" -ForegroundColor Gray
    Write-Host "3. No groups table in database" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
