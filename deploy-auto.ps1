# Automated Hostinger VPS Deployment
# Password included for automation

$VPS_IP = "72.62.35.177"
$VPS_USER = "root"
$VPS_PASSWORD = "2K6NMwJaLNEOZAGK#v/f"
$PROJECT_DIR = "/var/www/alqaed-platform"

Write-Host "Starting automated deployment..." -ForegroundColor Green
Write-Host ""

# Install sshpass equivalent for Windows (using plink if available, otherwise manual)
# For automation, we'll use ssh with password in command

# Step 1: Ensure dist exists
if (-Not (Test-Path "dist")) {
    Write-Host "Building project..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build failed" -ForegroundColor Red
        exit 1
    }
}

Write-Host "dist folder ready" -ForegroundColor Green
Write-Host ""

# Step 2: Setup server with password
Write-Host "Setting up server..." -ForegroundColor Cyan

# Create expect-like script for automation
$setupScript = @"
sudo apt update
sudo apt install -y nginx ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp  
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo mkdir -p $PROJECT_DIR
echo 'Setup complete'
"@

# Write script to temp file
$setupScript | Out-File -FilePath ".\setup-server.sh" -Encoding UTF8

# Upload and execute setup script
Write-Host "Uploading setup script..." -ForegroundColor Yellow
$env:SSHPASS = $VPS_PASSWORD
scp -o StrictHostKeyChecking=no setup-server.sh ${VPS_USER}@${VPS_IP}:/tmp/setup-server.sh
ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_IP} "bash /tmp/setup-server.sh"

if ($LASTEXITCODE -ne 0) {
    Write-Host "Server setup failed - trying manual commands..." -ForegroundColor Yellow
    # Fallback: try direct commands
    ssh ${VPS_USER}@${VPS_IP} "sudo apt update && sudo apt install -y nginx ufw && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable && sudo mkdir -p $PROJECT_DIR"
}

Write-Host "Server configured" -ForegroundColor Green
Write-Host ""

# Step 3: Upload dist
Write-Host "Uploading website files..." -ForegroundColor Cyan
scp -r -o StrictHostKeyChecking=no dist ${VPS_USER}@${VPS_IP}:${PROJECT_DIR}/

if ($LASTEXITCODE -ne 0) {
    Write-Host "Upload failed" -ForegroundColor Red
    exit 1
}

Write-Host "Files uploaded" -ForegroundColor Green
Write-Host ""

# Step 4: Configure Nginx
Write-Host "Configuring Nginx..." -ForegroundColor Cyan
scp -o StrictHostKeyChecking=no alqaed.nginx.conf ${VPS_USER}@${VPS_IP}:/tmp/alqaed

ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_IP} "sudo mv /tmp/alqaed /etc/nginx/sites-available/alqaed && sudo ln -sf /etc/nginx/sites-available/alqaed /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl restart nginx"

if ($LASTEXITCODE -ne 0) {
    Write-Host "Nginx configuration failed" -ForegroundColor Red
    exit 1
}

Write-Host "Nginx configured" -ForegroundColor Green
Write-Host ""

# Cleanup
Remove-Item -Path ".\setup-server.sh" -ErrorAction SilentlyContinue

# Success
Write-Host "========================================" -ForegroundColor Green
Write-Host "Deployment completed successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Your website is now live at:" -ForegroundColor Cyan
Write-Host "   http://${VPS_IP}" -ForegroundColor Yellow
Write-Host ""
Write-Host "Open this link in your browser to view your site!" -ForegroundColor Green
Write-Host ""
