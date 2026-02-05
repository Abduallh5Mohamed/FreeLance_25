# Script to deploy updates with uploads fix

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Deploying to elka2d.cloud" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Check SSH connectivity first
Write-Host "`nAttempting to connect to server..." -ForegroundColor Yellow

# Instructions for manual deployment
Write-Host @"

Manual deployment steps:
========================

1. Build the frontend (already done):
   npm run build

2. Upload frontend files:
   scp -r dist/* root@72.62.35.177:/var/www/alqaed/

3. Connect to server and check/fix nginx for uploads:
   ssh root@72.62.35.177

4. On server, ensure uploads are accessible by adding this to nginx config:
   location /uploads/ {
       alias /var/www/alqaed-api/uploads/;
       expires 30d;
       add_header Cache-Control "public, max-age=2592000";
   }

5. Reload nginx:
   nginx -t && systemctl reload nginx

"@ -ForegroundColor Gray
