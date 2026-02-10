@echo off
echo Connecting to server and creating table...
echo.

plink -batch -pw NewSecureP@ssw0rd2025! root@72.62.35.177 "cd /var/www/alqaed-api && grep DB_PASSWORD .env && source .env && mysql -u root -p\"$DB_PASSWORD\" Freelance -e 'CREATE TABLE IF NOT EXISTS message_deletions (id INT AUTO_INCREMENT PRIMARY KEY, message_id INT NOT NULL, user_id VARCHAR(36) NOT NULL, deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY unique_message_user (message_id, user_id), FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE); SHOW TABLES LIKE \"message_deletions\";' && pm2 restart alqaed-api"

echo.
echo Done! Press any key...
pause > nul
