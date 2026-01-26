# Start MinIO Server
Write-Host "🚀 Starting MinIO Server..." -ForegroundColor Cyan

# Check if MinIO is already running
$minioProcess = Get-Process -Name "minio" -ErrorAction SilentlyContinue

if ($minioProcess) {
    Write-Host "⚠️  MinIO is already running (PID: $($minioProcess.Id))" -ForegroundColor Yellow
    Write-Host "✅ MinIO ready at http://127.0.0.1:9000" -ForegroundColor Green
    exit 0
}

# Check if MinIO executable exists
if (!(Test-Path "D:\minio\minio.exe")) {
    Write-Host "❌ MinIO executable not found at D:\minio\minio.exe" -ForegroundColor Red
    Write-Host "Please install MinIO first" -ForegroundColor Yellow
    exit 1
}

# Check if data directory exists
if (!(Test-Path "D:\MinIO\data")) {
    Write-Host "❌ Data directory not found at D:\MinIO\data" -ForegroundColor Red
    Write-Host "Creating data directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path "D:\MinIO\data" -Force | Out-Null
}

# Set environment variables and start MinIO
$env:MINIO_ROOT_USER = "minioadmin"
$env:MINIO_ROOT_PASSWORD = "minioadmin123"

Set-Location "D:\minio"

# Start MinIO in background
Start-Process -FilePath ".\minio.exe" `
    -ArgumentList "server", "D:\MinIO\data", "--console-address", ":9001" `
    -WindowStyle Hidden

# Wait for MinIO to start
Start-Sleep -Seconds 3

# Verify MinIO is running
$minioProcess = Get-Process -Name "minio" -ErrorAction SilentlyContinue

if ($minioProcess) {
    Write-Host "✅ MinIO started successfully!" -ForegroundColor Green
    Write-Host "   API: http://127.0.0.1:9000" -ForegroundColor Cyan
    Write-Host "   Console: http://127.0.0.1:9001" -ForegroundColor Cyan
    Write-Host "   User: minioadmin" -ForegroundColor Gray
    Write-Host "   Pass: minioadmin123" -ForegroundColor Gray
} else {
    Write-Host "❌ Failed to start MinIO" -ForegroundColor Red
    exit 1
}
