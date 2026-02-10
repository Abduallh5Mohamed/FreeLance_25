@echo off
echo === تنفيذ SQL على السيرفر ===
echo.

echo 1. رفع ملف SQL...
pscp -pw NewSecureP@ssw0rd2025! d:\FreeLance_25-1\FreeLance_25-1\msg-del.sql root@72.62.35.177:/tmp/
if %errorlevel% neq 0 (
    echo خطأ في الرفع
    pause
    exit /b 1
)
echo تم الرفع بنجاح!
echo.

echo 2. تنفيذ SQL...
plink -pw NewSecureP@ssw0rd2025! root@72.62.35.177 "cd /var/www/alqaed-api && source .env && mysql -u root -p'$DB_PASSWORD' Freelance < /tmp/msg-del.sql && echo SUCCESS"
echo.

echo 3. إعادة تشغيل PM2...
plink -pw NewSecureP@ssw0rd2025! root@72.62.35.177 "pm2 restart alqaed-api"
echo.

echo تم!
pause
