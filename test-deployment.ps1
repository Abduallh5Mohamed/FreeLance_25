Write-Host "==================================="
Write-Host "  Deployment Verification Test"
Write-Host "==================================="
Write-Host ""

$server = "root@72.62.35.177"

Write-Host "1. Checking nginx status..." -ForegroundColor Yellow
ssh $server 'systemctl is-active nginx'
Write-Host ""

Write-Host "2. Checking file exists on server..." -ForegroundColor Yellow
ssh $server 'ls -lh /var/www/alqaed/dist/assets/index-1770300823502.js'
Write-Host ""

Write-Host "3. Checking live site version..." -ForegroundColor Yellow
ssh $server 'curl -s https://elka2d.cloud/index.html | grep -o "index-[0-9]*\.js"'
Write-Host ""

Write-Host "4. Checking version checker in code..." -ForegroundColor Yellow
ssh $server 'curl -s https://elka2d.cloud/assets/index-1770300823502.js 2>/dev/null | grep -q "startVersionCheck" && echo "Found" || echo "Not Found"'
Write-Host ""

Write-Host "5. Checking video streaming..." -ForegroundColor Yellow
ssh $server 'curl -s -I -H "Range: bytes=0-1023" "https://elka2d.cloud/storage/videos-original/originals/9c6743d8-6ba7-4e06-ba74-f501c4a931c9.mp4" | grep -E "HTTP|206"'
Write-Host ""

Write-Host "==================================="
Write-Host "Verification Complete!"
Write-Host "==================================="
