Write-Host "Checking server process..." -ForegroundColor Cyan

$process = Get-Process | Where-Object { $_.ProcessName -like "*node*" -and $_.MainWindowTitle -like "*tsx*" }

if ($process) {
    Write-Host "Server is running (PID: $($process.Id))" -ForegroundColor Green
} else {
    Write-Host "Server not found" -ForegroundColor Red
}

Write-Host ""
Write-Host "Testing API..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3001/api/courses" -Method Get
    Write-Host "API is responding: $($response.Count) courses found" -ForegroundColor Green
} catch {
    Write-Host "API not responding: $($_.Exception.Message)" -ForegroundColor Red
}
