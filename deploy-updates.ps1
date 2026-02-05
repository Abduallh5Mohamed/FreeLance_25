# Deploy script
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploying updates to elka2d.cloud" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Build frontend
Write-Host "`n1. Building frontend..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Frontend build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "`n2. Building backend..." -ForegroundColor Yellow
Push-Location server
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Backend build failed!" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

Write-Host "`n3. Deploying to server..." -ForegroundColor Yellow
Write-Host "You will be prompted for the SSH password." -ForegroundColor Gray

# Deploy frontend
Write-Host "Uploading frontend files..."
scp -r dist/* root@72.62.35.177:/var/www/alqaed/

# Deploy backend
Write-Host "Uploading backend files..."
scp -r server/dist/* root@72.62.35.177:/var/www/alqaed-api/
scp server/package.json root@72.62.35.177:/var/www/alqaed-api/

# Restart services
Write-Host "`n4. Restarting services..."
ssh root@72.62.35.177 "cd /var/www/alqaed-api && npm install --production && pm2 restart alqaed-api"

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Deployment complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
