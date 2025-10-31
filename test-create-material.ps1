Write-Host "=== Testing Create Material API ===" -ForegroundColor Cyan
Write-Host ""

# Test data
$testMaterial = @{
    course_id = "test-course-id"
    title = "Test Video"
    description = "Test Description"
    material_type = "video"
    file_url = "https://drive.google.com/file/d/test123/view"
    duration_minutes = 30
    is_free = $false
    is_published = $true
    grade_id = "cd4cd109-b2ff-11f0-9695-0a002700000f"
    group_ids = @("77c84874-b666-11f0-b501-0a002700000f")
} | ConvertTo-Json

Write-Host "Sending POST request to create material..." -ForegroundColor Yellow
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/materials" -Method Post -Body $testMaterial -ContentType "application/json" -ErrorAction Stop
    
    Write-Host "SUCCESS: Material created!" -ForegroundColor Green
    Write-Host ""
    $response | ConvertTo-Json -Depth 5
    
} catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Response:" -ForegroundColor Yellow
    $_.Exception.Response
    
    if ($_.ErrorDetails) {
        Write-Host ""
        Write-Host "Error Details:" -ForegroundColor Yellow
        $_.ErrorDetails.Message
    }
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
