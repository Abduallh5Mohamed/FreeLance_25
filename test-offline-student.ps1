Write-Host "=== Testing Offline Student Creation ===" -ForegroundColor Cyan
Write-Host ""

# Get a real group ID
Write-Host "1. Getting group ID..." -ForegroundColor Yellow
try {
    $groups = Invoke-RestMethod -Uri "http://localhost:3001/api/groups" -Method Get
    $groupId = $groups[0].id
    $gradeId = $groups[0].grade_id
    Write-Host "   Using group: $($groups[0].name) (ID: $groupId)" -ForegroundColor Green
} catch {
    Write-Host "   Failed to get groups: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

# Create offline student
Write-Host "2. Creating offline student..." -ForegroundColor Yellow
$student = @{
    name = "Test Offline Student $(Get-Date -Format 'HH:mm:ss')"
    email = "offline$(Get-Random)@test.com"
    phone = "0100000$(Get-Random -Minimum 1000 -Maximum 9999)"
    grade = "Grade 1"
    grade_id = $gradeId
    group_id = $groupId
    password = "test123"
    is_offline = $true
    approval_status = "approved"
} | ConvertTo-Json

Write-Host "   Request Body:" -ForegroundColor Gray
Write-Host $student

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/students" -Method Post -Body $student -ContentType "application/json"
    Write-Host "   SUCCESS: Student created!" -ForegroundColor Green
    Write-Host "   Student ID: $($response.id)" -ForegroundColor Green
    Write-Host "   Name: $($response.name)" -ForegroundColor Green
    Write-Host "   Email: $($response.email)" -ForegroundColor Green
    Write-Host "   Group ID: $($response.group_id)" -ForegroundColor Green
} catch {
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails) {
        Write-Host "   Error Details:" -ForegroundColor Yellow
        $_.ErrorDetails.Message
    }
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
