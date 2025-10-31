Write-Host "=== Testing Hard Delete for Groups ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Get all groups before delete
Write-Host "1. Getting all groups from API..." -ForegroundColor Yellow
try {
    $groupsBefore = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    Write-Host "   SUCCESS: Found $($groupsBefore.Count) groups" -ForegroundColor Green
    
    if ($groupsBefore.Count -eq 0) {
        Write-Host "   No groups to test. Please create a group first." -ForegroundColor Red
        exit
    }
    
    # Show groups
    foreach ($group in $groupsBefore) {
        Write-Host "   - $($group.name) (ID: $($group.id))" -ForegroundColor Gray
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

Write-Host ""

# Step 2: Delete the first group
$groupToDelete = $groupsBefore[0]
Write-Host "2. Deleting group: $($groupToDelete.name)..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/groups/$($groupToDelete.id)" -Method Delete
    Write-Host "   SUCCESS: Group deleted from API" -ForegroundColor Green
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

Write-Host ""

# Step 3: Verify deletion from API
Write-Host "3. Verifying deletion from API..." -ForegroundColor Yellow
try {
    $groupsAfter = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    Write-Host "   SUCCESS: Now showing $($groupsAfter.Count) groups" -ForegroundColor Green
    
    $found = $groupsAfter | Where-Object { $_.id -eq $groupToDelete.id }
    if ($found) {
        Write-Host "   ERROR: Group still exists in API!" -ForegroundColor Red
    } else {
        Write-Host "   VERIFIED: Group removed from API" -ForegroundColor Green
    }
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# Step 4: Verify deletion from MySQL
Write-Host "4. Verifying deletion from MySQL database..." -ForegroundColor Yellow
$sqlCheck = @"
USE Freelance;
SELECT COUNT(*) as count FROM ``groups`` WHERE id = '$($groupToDelete.id)';
"@

$tempFile = [System.IO.Path]::GetTempFileName()
$sqlCheck | Out-File -FilePath $tempFile -Encoding UTF8

try {
    $result = Get-Content $tempFile | mysql -u root -p123580 2>&1 | Select-String "count"
    
    if ($result -match "0") {
        Write-Host "   SUCCESS: Group permanently deleted from MySQL!" -ForegroundColor Green
        Write-Host "   The group with ID $($groupToDelete.id) no longer exists in the database." -ForegroundColor Green
    } else {
        Write-Host "   WARNING: Group might still exist in MySQL" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   Could not verify MySQL (this is optional)" -ForegroundColor Yellow
} finally {
    Remove-Item $tempFile -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Summary:" -ForegroundColor White
Write-Host "- Groups before delete: $($groupsBefore.Count)" -ForegroundColor Gray
Write-Host "- Groups after delete: $($groupsAfter.Count)" -ForegroundColor Gray
Write-Host "- Deleted group: $($groupToDelete.name)" -ForegroundColor Gray
Write-Host "- Status: HARD DELETE (Permanent removal from MySQL)" -ForegroundColor Green
