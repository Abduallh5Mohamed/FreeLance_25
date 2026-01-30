# Start MinIO Server
Write-Host "🚀 Starting MinIO Server..." -ForegroundColor Cyan

# Define MinIO paths
$minioDir = "D:\MinIO"
$minioExe = "$minioDir\minio.exe"
$minioData = "$minioDir\data"

# Check if MinIO is already running
$minioProcess = Get-Process -Name "minio" -ErrorAction SilentlyContinue

if ($minioProcess) {
    Write-Host "⚠️  MinIO is already running (PID: $($minioProcess.Id))" -ForegroundColor Yellow
    Write-Host "✅ MinIO ready at http://127.0.0.1:9000" -ForegroundColor Green
    exit 0
}

# Check if MinIO executable exists
if (!(Test-Path $minioExe)) {
    Write-Host "❌ MinIO executable not found at $minioExe" -ForegroundColor Red
    Write-Host "🔧 Installing MinIO..." -ForegroundColor Cyan
    
    # Create directory
    New-Item -ItemType Directory -Path $minioDir -Force | Out-Null
    
    # Download MinIO
    $minioUrl = "https://dl.min.io/server/minio/release/windows-amd64/minio.exe"
    Write-Host "📥 Downloading MinIO from $minioUrl" -ForegroundColor Yellow
    
    try {
        Invoke-WebRequest -Uri $minioUrl -OutFile $minioExe
        Write-Host "✅ MinIO downloaded successfully!" -ForegroundColor Green
    } catch {
        Write-Host "❌ Failed to download MinIO: $_" -ForegroundColor Red
        exit 1
    }
}

# Check if data directory exists
if (!(Test-Path $minioData)) {
    Write-Host "❌ Data directory not found at $minioData" -ForegroundColor Red
    Write-Host "Creating data directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $minioData -Force | Out-Null
}

# Set environment variables and start MinIO
$env:MINIO_ROOT_USER = "minioadmin"
$env:MINIO_ROOT_PASSWORD = "minioadmin123"

Set-Location $minioDir

# Start MinIO in background
Start-Process -FilePath $minioExe `
    -ArgumentList "server", $minioData, "--console-address", ":9001" `
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
