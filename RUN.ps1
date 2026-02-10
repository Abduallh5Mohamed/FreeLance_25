$pw = ConvertTo-SecureString "NewSecureP@ssw0rd2025!" -AsPlainText -Force
$cred = New-Object PSCredential("root", $pw)
Get-SSHSession | Remove-SSHSession 2>$null | Out-Null
Write-Host "Connecting..." -ForegroundColor Yellow
$s = New-SSHSession -ComputerName 72.62.35.177 -Credential $cred -AcceptKey -Force -WarningAction SilentlyContinue
if (!$s) { Write-Host "Failed" -ForegroundColor Red; exit 1 }
Write-Host "Connected" -ForegroundColor Green
Write-Host "Creating table..." -ForegroundColor Yellow
$createCmd = 'mysql -u root -p''123580'' Freelance -e "CREATE TABLE IF NOT EXISTS message_deletions (id INT AUTO_INCREMENT PRIMARY KEY, message_id INT NOT NULL, user_id VARCHAR(36) NOT NULL, deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY unique_message_user (message_id, user_id), FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE);" 2>&1'
$r1 = Invoke-SSHCommand -SessionId $s.SessionId -Command $createCmd -TimeOut 30
Write-Host $r1.Output
Write-Host "Verifying..." -ForegroundColor Yellow
$verifyCmd = 'mysql -u root -p''123580'' Freelance -e "SHOW TABLES LIKE ''message_deletions'';" 2>&1'
$r2 = Invoke-SSHCommand -SessionId $s.SessionId -Command $verifyCmd -TimeOut 15
Write-Host $r2.Output
if ($r2.Output -match "message_deletions") {
    Write-Host "SUCCESS" -ForegroundColor Green
    Write-Host "Restarting PM2..." -ForegroundColor Yellow
    $r3 = Invoke-SSHCommand -SessionId $s.SessionId -Command "pm2 restart alqaed-api" -TimeOut 20
    Write-Host $r3.Output
    if ($r3.Output -match "online") {
        Write-Host "COMPLETE - Test website" -ForegroundColor Green
    }
} else {
    Write-Host "FAILED" -ForegroundColor Red
}
Remove-SSHSession -SessionId $s.SessionId | Out-Null
