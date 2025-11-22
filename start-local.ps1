# PowerShell script to start backend and frontend locally

# Start backend
Write-Host "Starting backend..." -ForegroundColor Green
Start-Process -NoNewWindow -FilePath "powershell" -ArgumentList "-NoProfile -Command cd ./server; $env:SKIP_DB_ON_START='true'; npm install; npm run dev"

# Start frontend
Write-Host "Starting frontend..." -ForegroundColor Green
Start-Process -NoNewWindow -FilePath "powershell" -ArgumentList "-NoProfile -Command cd ./; npm install; npm run dev"

Write-Host "Both backend and frontend are starting..." -ForegroundColor Yellow