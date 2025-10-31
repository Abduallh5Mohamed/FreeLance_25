Write-Host "=== Testing Teacher Lecture Creation ===" -ForegroundColor Cyan
Write-Host ""

# Get real course ID
Write-Host "1. Getting real course ID..." -ForegroundColor Yellow
try {
    $courses = Invoke-RestMethod -Uri "http://localhost:3001/api/courses" -Method Get
    $courseId = $courses[0].id
    Write-Host "   Using course: $($courses[0].name) (ID: $courseId)" -ForegroundColor Green
} catch {
    Write-Host "   Failed to get courses: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

# Get real group ID
Write-Host "2. Getting real group ID..." -ForegroundColor Yellow
try {
    $groups = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    $groupId = $groups[0].id
    Write-Host "   Using group: $($groups[0].name) (ID: $groupId)" -ForegroundColor Green
} catch {
    Write-Host "   Failed to get groups: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

# Create lecture
Write-Host "3. Creating lecture..." -ForegroundColor Yellow
$lecture = @{
    course_id = $courseId
    group_id = $groupId
    title = "Test Teacher Lecture $(Get-Date -Format 'HH:mm:ss')"
    description = "Test lecture for specific group"
    video_url = "https://drive.google.com/file/d/test456/view"
    duration_minutes = 45
    is_free = $false
    is_published = $true
} | ConvertTo-Json

Write-Host "   Request Body:" -ForegroundColor Gray
Write-Host $lecture

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/lectures" -Method Post -Body $lecture -ContentType "application/json"
    Write-Host "   SUCCESS: Lecture created!" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 3
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host "   Error Details:" -ForegroundColor Yellow
        $_.ErrorDetails.Message
    }
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
