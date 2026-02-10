Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Creating message_deletions table" -ForegroundColor Cyan  
Write-Host "=======================================`n" -ForegroundColor Cyan

$pw = ConvertTo-SecureString "NewSecureP@ssw0rd2025!" -AsPlainText -Force
$cred = New-Object PSCredential("root", $pw)

Write-Host "Connecting to server..." -ForegroundColor Yellow
Get-SSHSession | ForEach-Object { Remove-SSHSession -SessionId $_.SessionId | Out-Null}
$session = New-SSHSession -ComputerName 72.62.35.177 -Credential $cred -AcceptKey -Force

if (!$session) {
    Write-Host "Failed to connect" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Connected`n" -ForegroundColor Green

Write-Host "Creating script on server..." -ForegroundColor Yellow

$createScript = @'
cat > /tmp/create-msg-del.js << 'EOF'
const mysql = require('mysql2/promise');
const fs = require('fs');

(async () => {
  try {
    const envText = fs.readFileSync('/var/www/alqaed-api/.env', 'utf8');
    const env = {};
    envText.split('\n').forEach(line => {
      const [key, ...values] = line.split('=');
      if (key && values.length) env[key.trim()] = values.join('=').trim();
    });
    
    console.log('Database:', env.DB_NAME);
    console.log('User:', env.DB_USER);
    
    const connection = await mysql.createConnection({
      host: env.DB_HOST || 'localhost',
      user: env.DB_USER || 'root',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || 'Freelance'
    });
    
    console.log('Connected to database');
    
    await connection.execute('DROP TABLE IF EXISTS message_deletions');
    console.log('Dropped old table');
    
    await connection.execute(`
      CREATE TABLE message_deletions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id INT NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_message_user (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    console.log('Table created');
    
    const [rows] = await connection.execute('DESCRIBE message_deletions');
    console.log('\nTable structure:');
    rows.forEach(row => console.log(`  - ${row.Field} (${row.Type})`));
    
    await connection.end();
    console.log('\nSUCCESS');
    
  } catch (error) {
    console.error('\nERROR:', error.message);
    process.exit(1);
  }
})();
EOF
'@

$result1 = Invoke-SSHCommand -SessionId $session.SessionId -Command $createScript -TimeOut 15
Write-Host "Script ready`n" -ForegroundColor Green

Write-Host "Executing script..." -ForegroundColor Yellow
$result2 = Invoke-SSHCommand -SessionId $session.SessionId -Command "node /tmp/create-msg-del.js" -TimeOut 30

Write-Host "`nResult:" -ForegroundColor Cyan
Write-Host $result2.Output

if ($result2.Output -match "SUCCESS") {
    Write-Host "`nTable created successfully!`n" -ForegroundColor Green
    
    Write-Host "Restarting PM2..." -ForegroundColor Yellow
    $result3 = Invoke-SSHCommand -SessionId $session.SessionId -Command "pm2 restart alqaed-api --update-env" -TimeOut 20
    Write-Host $result3.Output
    
    Write-Host "`n================================" -ForegroundColor Green
    Write-Host "  SUCCESS!" -ForegroundColor Green
    Write-Host "================================`n" -ForegroundColor Green
    
    Write-Host "Test the website now:" -ForegroundColor Yellow
    Write-Host "1. Open Messages page" -ForegroundColor White
    Write-Host "2. Try deleting a message" -ForegroundColor White
    Write-Host "3. Try editing a message`n" -ForegroundColor White
    
} else {
    Write-Host "`nFailed to create table" -ForegroundColor Red
}

Remove-SSHSession -SessionId $session.SessionId | Out-Null

Write-Host "Done" -ForegroundColor Cyan
pause
