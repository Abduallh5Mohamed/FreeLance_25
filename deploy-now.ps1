# Quick Deploy Script
# Run with: .\deploy-now.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Quick Deploy to elka2d.cloud" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nPlease run these commands manually:" -ForegroundColor Yellow
Write-Host ""
Write-Host "# 1. Upload frontend:" -ForegroundColor Green
Write-Host 'scp -r dist/* root@72.62.35.177:/var/www/alqaed/' -ForegroundColor White
Write-Host ""
Write-Host "# 2. Upload backend:" -ForegroundColor Green
Write-Host 'scp -r server/dist/* root@72.62.35.177:/var/www/alqaed-api/' -ForegroundColor White
Write-Host 'scp server/package.json root@72.62.35.177:/var/www/alqaed-api/' -ForegroundColor White
Write-Host ""
Write-Host "# 3. Restart backend on server:" -ForegroundColor Green
Write-Host 'ssh root@72.62.35.177 "pm2 restart alqaed-api"' -ForegroundColor White
Write-Host ""
Write-Host "Password: 4{JX=BXKPy[K!q]K" -ForegroundColor Gray
