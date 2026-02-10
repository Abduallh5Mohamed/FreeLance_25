$pw = ConvertTo-SecureString "NewSecureP@ssw0rd2025!" -AsPlainText -Force
$cred = New-Object PSCredential("root", $pw)

Get-SSHSession | Remove-SSHSession 2>$null | Out-Null

Write-Host "Connecting to server..." -ForegroundColor Yellow
$s = New-SSHSession -ComputerName 72.62.35.177 -Credential $cred -AcceptKey -Force -WarningAction SilentlyContinue

if ($s) {
    Write-Host "Connected!`n" -ForegroundColor Green
    
    Write-Host "Creating table..." -ForegroundColor Yellow
    
    $cmd = 'cd /var/www/alqaed-api && source .env && mysql -u $DB_USER -p"$DB_PASSWORD" $DB_NAME -e "CREATE TABLE IF NOT EXISTS message_deletions (id INT AUTO_INCREMENT PRIMARY KEY,message_id INT NOT NULL,user_id VARCHAR(36) NOT NULL,deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY unique_message_user(message_id,user_id),FOREIGN KEY(message_id)REFERENCES messages(id)ON DELETE CASCADE);SHOW TABLES LIKE ''message_deletions'';"'
    
    $result = Invoke-SSHCommand -SessionId $s.SessionId -Command $cmd -TimeOut 30
    
    Write-Host $result.Output
    Write-Host ""
    
    if ($result.Output -match "message_deletions") {
        Write-Host "SUCCESS - Table created!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Restarting PM2..." -ForegroundColor Yellow
        $pm2 = Invoke-SSHCommand -SessionId $s.SessionId -Command "pm2 restart alqaed-api" -TimeOut 20
        Write-Host $pm2.Output
        Write-Host ""
        Write-Host "=============================" -ForegroundColor Green
        Write-Host "  DONE! Test the website" -ForegroundColor Green
        Write-Host "=============================" -ForegroundColor Green
    } else {
        Write-Host "Failed to create table" -ForegroundColor Red
    }
    
    Remove-SSHSession -SessionId $s.SessionId | Out-Null
} else {
    Write-Host "Connection failed!" -ForegroundColor Red
}
