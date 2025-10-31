Write-Host "=== Testing Material Creation with Real Data ===" -ForegroundColor Cyan
Write-Host ""

# First, get a real course ID
Write-Host "1. Getting real course ID..." -ForegroundColor Yellow
try {
    $courses = Invoke-RestMethod -Uri "http://localhost:3001/api/courses" -Method Get
    if ($courses.Count -eq 0) {
        Write-Host "   No courses found!" -ForegroundColor Red
        exit
    }
    $courseId = $courses[0].id
    Write-Host "   Using course: $($courses[0].name) (ID: $courseId)" -ForegroundColor Green
} catch {
    Write-Host "   Failed to get courses: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

Write-Host ""

# Get real groups
Write-Host "2. Getting real group IDs..." -ForegroundColor Yellow
try {
    $groups = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    if ($groups.Count -eq 0) {
        Write-Host "   No groups found!" -ForegroundColor Red
        $groupIds = @()
    } else {
        $groupIds = @($groups[0].id)
        Write-Host "   Using group: $($groups[0].name) (ID: $($groups[0].id))" -ForegroundColor Green
    }
} catch {
    Write-Host "   Failed to get groups: $($_.Exception.Message)" -ForegroundColor Red
    $groupIds = @()
}

Write-Host ""

# Create material
Write-Host "3. Creating material..." -ForegroundColor Yellow
$material = @{
    course_id = $courseId
    title = "Test Video $(Get-Date -Format 'HH:mm:ss')"
    description = "Test Description"
    material_type = "video"
    file_url = "https://drive.google.com/file/d/test123/view"
    duration_minutes = 30
    is_free = $false
    is_published = $true
    group_ids = $groupIds
} | ConvertTo-Json

Write-Host "   Request Body:" -ForegroundColor Gray
Write-Host $material

Write-Host ""

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/materials" -Method Post -Body $material -ContentType "application/json"
    Write-Host "   SUCCESS: Material created!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host "   Error Details:" -ForegroundColor Yellow
        $_.ErrorDetails.Message
    }
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
