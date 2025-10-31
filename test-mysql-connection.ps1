Write-Host "=== Testing MySQL API Connection ===" -ForegroundColor Cyan
Write-Host ""

# Test Grades API
Write-Host "1. Testing Grades API..." -ForegroundColor Yellow
try {
    $grades = Invoke-RestMethod -Uri "http://localhost:3001/api/grades" -Method Get
    Write-Host "   SUCCESS: Retrieved $($grades.Count) grades from MySQL" -ForegroundColor Green
    Write-Host "   Grades:" -ForegroundColor White
    foreach ($grade in $grades) {
        Write-Host "   - $($grade.name) (ID: $($grade.id))" -ForegroundColor Gray
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# Test Groups API
Write-Host "2. Testing Groups API..." -ForegroundColor Yellow
try {
    $groups = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    Write-Host "   SUCCESS: Retrieved $($groups.Count) groups from MySQL" -ForegroundColor Green
    Write-Host "   Groups:" -ForegroundColor White
    foreach ($group in $groups) {
        $gradeInfo = if ($group.grade_id) { "(Grade ID: $($group.grade_id))" } else { "(No Grade)" }
        Write-Host "   - $($group.name) $gradeInfo" -ForegroundColor Gray
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# Test relationship
Write-Host "3. Testing Grade-Group Relationship..." -ForegroundColor Yellow
try {
    $grades = Invoke-RestMethod -Uri "http://localhost:3001/api/grades" -Method Get
    $groups = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    
    $gradeMap = @{}
    foreach ($grade in $grades) {
        $gradeMap[$grade.id] = $grade.name
    }
    
    $groupsByGrade = @{}
    foreach ($group in $groups) {
        $gradeName = if ($group.grade_id -and $gradeMap.ContainsKey($group.grade_id)) {
            $gradeMap[$group.grade_id]
        } else {
            "No Grade Assigned"
        }
        
        if (-not $groupsByGrade.ContainsKey($gradeName)) {
            $groupsByGrade[$gradeName] = @()
        }
        $groupsByGrade[$gradeName] += $group.name
    }
    
    Write-Host "   SUCCESS: Relationship verified" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Groups organized by Grade:" -ForegroundColor White
    foreach ($gradeName in $groupsByGrade.Keys | Sort-Object) {
        Write-Host "   $gradeName" -ForegroundColor Cyan
        foreach ($groupName in $groupsByGrade[$gradeName]) {
            Write-Host "     - $groupName" -ForegroundColor Gray
        }
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
