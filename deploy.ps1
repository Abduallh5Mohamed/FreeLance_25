# ═══════════════════════════════════════════════════════════════
# Deployment Script for Al-Qaed Educational Platform (Windows)
# ═══════════════════════════════════════════════════════════════

Write-Host "🚀 Starting deployment process..." -ForegroundColor Cyan
Write-Host ""

# Step 1: Install dependencies
Write-Host "📦 Step 1/5: Installing dependencies..." -ForegroundColor Blue
Set-Location server
npm install  # سيشغل seed تلقائياً بعد التثبيت (postinstall)
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Dependencies installed" -ForegroundColor Green
Write-Host ""

# Step 2: Run database seeds
Write-Host "🌱 Step 2/5: Running database seeds..." -ForegroundColor Blue
npm run seed
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Seed failed, but continuing..." -ForegroundColor Yellow
} else {
    Write-Host "✅ Database seeded" -ForegroundColor Green
}
Write-Host ""

# Step 3: Build the project
Write-Host "🔨 Step 3/5: Building project..." -ForegroundColor Blue
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Project built successfully" -ForegroundColor Green
Write-Host ""

# Step 4: Check if .env exists
Write-Host "⚙️  Step 4/5: Checking environment configuration..." -ForegroundColor Blue
if (-not (Test-Path .env)) {
    Write-Host "⚠️  .env file not found. Creating from .env.example..." -ForegroundColor Yellow
    Copy-Item ..\.env.example .env
    Write-Host "⚠️  Please update .env with your production credentials!" -ForegroundColor Yellow
} else {
    Write-Host "✅ .env file exists" -ForegroundColor Green
}
Write-Host ""

# Step 5: Display completion message
Write-Host "📋 Step 5/5: Deployment summary" -ForegroundColor Blue
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "✅ Deployment completed successfully!" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "Admin User Credentials:" -ForegroundColor White
Write-Host "📱 Phone: 01024083057" -ForegroundColor White
Write-Host "🔑 Password: Mtd#mora55" -ForegroundColor White
Write-Host "👤 Role: admin" -ForegroundColor White
Write-Host ""
Write-Host "To start the server:" -ForegroundColor White
Write-Host "  PS> npm start" -ForegroundColor Gray
Write-Host ""
Write-Host "To run in development mode:" -ForegroundColor White
Write-Host "  PS> npm run dev" -ForegroundColor Gray
Write-Host ""
Write-Host "⚠️  IMPORTANT: Change the admin password after first login!" -ForegroundColor Yellow
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
