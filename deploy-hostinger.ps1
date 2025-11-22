# Hostinger VPS Deployment Script
# Usage: .\deploy-hostinger.ps1

$VPS_IP = "72.62.35.177"
$VPS_USER = "root"
$PROJECT_DIR = "/var/www/alqaed-platform"

Write-Host "Starting deployment to Hostinger VPS..." -ForegroundColor Green
Write-Host ""

# Step 1: Check if dist folder exists
if (-Not (Test-Path "dist")) {
    Write-Host "dist folder not found. Building project..." -ForegroundColor Red
    Write-Host "Running: npm run build" -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build failed" -ForegroundColor Red
        exit 1
    }
}

Write-Host "dist folder ready" -ForegroundColor Green
Write-Host ""

# Step 2: Setup server
Write-Host "Setting up server (you will be prompted for password)..." -ForegroundColor Cyan
$setupCommands = "sudo apt update && sudo apt install -y nginx ufw && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable && sudo mkdir -p $PROJECT_DIR && echo 'Server setup complete'"

ssh ${VPS_USER}@${VPS_IP} $setupCommands

if ($LASTEXITCODE -ne 0) {
    Write-Host "Server setup failed" -ForegroundColor Red
    exit 1
}

Write-Host "Server setup successful" -ForegroundColor Green
Write-Host ""

# Step 3: Upload dist folder
Write-Host "Uploading project files..." -ForegroundColor Cyan
scp -r dist ${VPS_USER}@${VPS_IP}:${PROJECT_DIR}/

if ($LASTEXITCODE -ne 0) {
    Write-Host "File upload failed" -ForegroundColor Red
    exit 1
}

Write-Host "Files uploaded successfully" -ForegroundColor Green
Write-Host ""

# Step 4: Upload and configure Nginx
Write-Host "Configuring Nginx..." -ForegroundColor Cyan
scp alqaed.nginx.conf ${VPS_USER}@${VPS_IP}:/tmp/alqaed

$nginxCommands = "sudo mv /tmp/alqaed /etc/nginx/sites-available/alqaed && sudo ln -sf /etc/nginx/sites-available/alqaed /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl restart nginx && echo 'Nginx configured successfully'"

ssh ${VPS_USER}@${VPS_IP} $nginxCommands

if ($LASTEXITCODE -ne 0) {
    Write-Host "Nginx configuration failed" -ForegroundColor Red
    exit 1
}

Write-Host "Nginx configured successfully" -ForegroundColor Green
Write-Host ""

# Success
Write-Host "Deployment completed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Access your website at:" -ForegroundColor Cyan
Write-Host "   http://${VPS_IP}" -ForegroundColor Yellow
Write-Host ""
Write-Host "To check server status:" -ForegroundColor Cyan
Write-Host "   ssh ${VPS_USER}@${VPS_IP}" -ForegroundColor Yellow
Write-Host "   sudo systemctl status nginx" -ForegroundColor Yellow
Write-Host ""
