# Hostinger Deployment Build Script
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Building Project for Hostinger" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Clean old builds
Write-Host "1. Cleaning old builds..." -ForegroundColor Yellow
if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }
if (Test-Path "hostinger-upload") { Remove-Item -Recurse -Force "hostinger-upload" }
if (Test-Path "server\dist") { Remove-Item -Recurse -Force "server\dist" }
if (Test-Path "hostinger-package.zip") { Remove-Item -Force "hostinger-package.zip" }

# Build Frontend
Write-Host "2. Building Frontend..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Frontend build failed!" -ForegroundColor Red
    exit 1
}

# Build Backend
Write-Host "3. Building Backend..." -ForegroundColor Yellow
Set-Location server
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Backend build failed!" -ForegroundColor Red
    Set-Location ..
    exit 1
}
Set-Location ..

# Create upload structure
Write-Host "4. Creating upload package..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "hostinger-upload\public_html" | Out-Null
New-Item -ItemType Directory -Force -Path "hostinger-upload\api" | Out-Null
New-Item -ItemType Directory -Force -Path "hostinger-upload\database" | Out-Null

# Copy Frontend
Write-Host "5. Copying Frontend..." -ForegroundColor Yellow
Copy-Item -Recurse -Force "dist\*" "hostinger-upload\public_html\"

# Copy Backend
Write-Host "6. Copying Backend..." -ForegroundColor Yellow
Copy-Item -Recurse -Force "server\dist\*" "hostinger-upload\api\"
Copy-Item -Force "server\package.json" "hostinger-upload\api\"
if (Test-Path "server\package-lock.json") {
    Copy-Item -Force "server\package-lock.json" "hostinger-upload\api\"
}

# Copy Database files
Write-Host "7. Copying Database files..." -ForegroundColor Yellow
if (Test-Path "database\mysql-schema.sql") {
    Copy-Item -Force "database\mysql-schema.sql" "hostinger-upload\database\"
}
if (Test-Path "server\insert-arabic-data.sql") {
    Copy-Item -Force "server\insert-arabic-data.sql" "hostinger-upload\database\"
}
if (Test-Path "server\insert-grades-groups.sql") {
    Copy-Item -Force "server\insert-grades-groups.sql" "hostinger-upload\database\"
}
if (Test-Path "server\add-admin-user.sql") {
    Copy-Item -Force "server\add-admin-user.sql" "hostinger-upload\database\"
}

# Create .htaccess
Write-Host "8. Creating .htaccess..." -ForegroundColor Yellow
@"
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteCond %{REQUEST_FILENAME} !-l
  RewriteRule . /index.html [L]
</IfModule>
"@ | Out-File -FilePath "hostinger-upload\public_html\.htaccess" -Encoding UTF8

# Create .env template
Write-Host "9. Creating .env template..." -ForegroundColor Yellow
@"
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_hostinger_db_user
DB_PASSWORD=your_hostinger_db_password
DB_NAME=your_hostinger_db_name

NODE_ENV=production
PORT=3000

JWT_SECRET=change_this_to_random_string
JWT_EXPIRES_IN=7d

SESSION_SECRET=change_this_to_random_string
"@ | Out-File -FilePath "hostinger-upload\api\.env" -Encoding UTF8

# Create deployment instructions
Write-Host "10. Creating instructions..." -ForegroundColor Yellow
@"
HOSTINGER DEPLOYMENT INSTRUCTIONS
==================================

1. Upload Files:
   - Upload public_html/* to your public_html folder
   - Upload api/* to a folder named 'api' in root
   - Keep database folder for later use

2. Setup MySQL Database:
   - Create new MySQL database in Hostinger
   - Import database/mysql-schema.sql
   - Import other SQL files if present

3. Configure .env:
   - Edit api/.env with your database credentials
   - Change JWT_SECRET and SESSION_SECRET

4. Install Dependencies via SSH:
   cd ~/api
   npm install --production

5. Start Application:
   - Use Node.js Selector in Hostinger
   - Or use PM2: pm2 start index.js

Default Login:
Phone: 01024083057
Password: Mtd#mora55

CHANGE PASSWORD AFTER FIRST LOGIN!
"@ | Out-File -FilePath "hostinger-upload\README.txt" -Encoding UTF8

# Update package.json for production
Write-Host "11. Preparing production package.json..." -ForegroundColor Yellow
$pkgContent = Get-Content "hostinger-upload\api\package.json" -Raw | ConvertFrom-Json
$pkgContent.scripts = @{ start = "node index.js" }
$pkgContent.devDependencies = @{}
$pkgContent | ConvertTo-Json -Depth 10 | Out-File "hostinger-upload\api\package.json" -Encoding UTF8

# Create ZIP
Write-Host "12. Creating ZIP archive..." -ForegroundColor Yellow
try {
    Compress-Archive -Path "hostinger-upload\*" -DestinationPath "hostinger-package.zip" -Force
    Write-Host "ZIP Created: hostinger-package.zip" -ForegroundColor Green
}
catch {
    Write-Host "ZIP creation skipped" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Green
Write-Host "Build Completed Successfully!" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Green
Write-Host ""
Write-Host "Package Location: hostinger-upload\" -ForegroundColor Cyan
Write-Host "ZIP Archive: hostinger-package.zip" -ForegroundColor Cyan
Write-Host "Instructions: hostinger-upload\README.txt" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "1. Upload to Hostinger" -ForegroundColor White
Write-Host "2. Setup database" -ForegroundColor White
Write-Host "3. Configure .env" -ForegroundColor White
Write-Host "4. Run: npm install --production" -ForegroundColor White
Write-Host "5. Start the app" -ForegroundColor White
Write-Host ""
