# Test approve subscription request API

# First, get pending requests to get an ID
Write-Host "=== Getting pending subscription requests ===" -ForegroundColor Cyan
$requests = Invoke-RestMethod -Uri "http://localhost:3001/api/subscription-requests?status=pending" -Method Get
Write-Host "Response:" -ForegroundColor Yellow
$requests | ConvertTo-Json -Depth 10

if ($requests.Count -gt 0) {
    $requestId = $requests[0].id
    Write-Host "`n=== Approving request ID: $requestId ===" -ForegroundColor Cyan
    
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:3001/api/subscription-requests/$requestId/approve" -Method Post -ContentType "application/json"
        Write-Host "Success Response:" -ForegroundColor Green
        $response | ConvertTo-Json -Depth 10
    } catch {
        Write-Host "Error Response:" -ForegroundColor Red
        Write-Host $_.Exception.Message
        Write-Host $_.ErrorDetails.Message
    }
} else {
    Write-Host "No pending requests found" -ForegroundColor Yellow
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
