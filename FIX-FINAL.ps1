$pw = ConvertTo-SecureString "NewSecureP@ssw0rd2025!" -AsPlainText -Force
$cred = New-Object PSCredential("root", $pw)

Get-SSHSession | Remove-SSHSession 2>$null | Out-Null

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Creating message_deletions" -ForegroundColor Cyan
Write-Host "==================================`n" -ForegroundColor Cyan

Write-Host "Connecting..." -ForegroundColor Yellow
$s = New-SSHSession -ComputerName 72.62.35.177 -Credential $cred -AcceptKey -Force -WarningAction SilentlyContinue

if (!$s) {
    Write-Host "Connection failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Connected!`n" -ForegroundColor Green

$dbUser = "root"
$dbPass = "123580"
$dbName = "Freelance"

Write-Host "Creating table (DB: $dbName, User: $dbUser)..." -ForegroundColor Yellow

# Use single quotes for the whole command, double quotes for SQL
$cmd = "mysql -u $dbUser -p'$dbPass' $dbName -e `"CREATE TABLE IF NOT EXISTS message_deletions (id INT AUTO_INCREMENT PRIMARY KEY,message_id INT NOT NULL,user_id VARCHAR(36) NOT NULL,deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY unique_message_user(message_id,user_id),FOREIGN KEY(message_id)REFERENCES messages(id)ON DELETE CASCADE);`" 2>&1"

$result = Invoke-SSHCommand -SessionId $s.SessionId -Command $cmd -TimeOut 30

Write-Host "Result: $($result.Output)" -ForegroundColor Gray
Write-Host ""

# Verify
Write-Host "Verifying..." -ForegroundColor Yellow
$verify = "mysql -u $dbUser -p'$dbPass' $dbName -e `"SHOW TABLES LIKE 'message_deletions';`" 2>&1"
$verifyResult = Invoke-SSHCommand -SessionId $s.SessionId -Command $verify -TimeOut 15

Write-Host $verifyResult.Output
Write-Host ""

if ($verifyResult.Output -match "message_deletions" -or $result.Output -notmatch "ERROR") {
    Write-Host "SUCCESS! Table exists.`n" -ForegroundColor Green
    
    Write-Host "Restarting PM2..." -ForegroundColor Yellow
    $pm2 = Invoke-SSHCommand -SessionId $s.SessionId -Command "pm2 restart alqaed-api" -TimeOut 20
    
    if ($pm2.Output -match "online") {
        Write-Host "PM2 restarted successfully`n" -ForegroundColor Green
        
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "        SUCCESS! ✓✓✓" -ForegroundColor Green
        Write-Host "========================================`n" -ForegroundColor Green
        
        Write-Host "Test now:" -ForegroundColor Yellow
        Write-Host "  1. Open Messages" -ForegroundColor White
        Write-Host "  2. Delete message - will delete for you only" -ForegroundColor White
        Write-Host "  3. Edit message - will update for both users" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host $pm2.Output
    }
} else {
    Write-Host "Failed! Error:" -ForegroundColor Red
    Write-Host $result.Output
}

Remove-SSHSession -SessionId $s.SessionId | Out-Null
Write-Host "Done" -ForegroundColor Cyan
