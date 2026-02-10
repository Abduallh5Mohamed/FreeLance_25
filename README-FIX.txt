===========================================
إصلاح مشكلة Messages - ثلاث طرق
===========================================

الطريقة 1 - CMD (الأسرع):
-------------------------------------------
1. افتح CMD 
2. نفذ: fix-with-ssh.bat
3. أدخل Password: NewSecureP@ssw0rd2025!

الطريقة 2 - SSH مباشر (موصى به):
-------------------------------------------
1. افتح terminal جديد
2. نفذ:
   ssh root@72.62.35.177
   
3. Password: NewSecureP@ssw0rd2025!

4. بعدين نفذ على السيرفر:
   cd /var/www/alqaed-api
   source .env
   mysql -u $DB_USER -p"$DB_PASSWORD" $DB_NAME << 'EOF'
   DROP TABLE IF EXISTS message_deletions;
   CREATE TABLE message_deletions (
     id INT AUTO_INCREMENT PRIMARY KEY,
     message_id INT NOT NULL,
     user_id VARCHAR(36) NOT NULL,
     deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY unique_message_user (message_id, user_id),
     FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
   DESCRIBE message_deletions;
   EOF
   
5. إعادة تشغيل:
   pm2 restart alqaed-api

الطريقة 3 - PowerShell (قد تستغرق وقتاً):
-------------------------------------------
.\FIX-MESSAGES.ps1

===========================================
بعد التنفيذ:
-------------------------------------------
1. افتح الموقع
2. جرب Messages
3. حذف رسالة → تحذف من عندك فقط
4. تعديل رسالة → تتعدل للطرفين
===========================================
