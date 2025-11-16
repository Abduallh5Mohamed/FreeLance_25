# دليل رفع المشروع على VPS

## المتطلبات الأساسية

### على جهازك المحلي:
- Git مثبت
- Node.js و npm مثبتان

### على الـ VPS:
- Ubuntu 20.04 أو أحدث (أو أي Linux distribution)
- Node.js 18+ و npm
- Nginx
- PM2
- MySQL (إذا كنت تستخدم قاعدة بيانات)

---

## خطوات التثبيت على VPS

### 1. الاتصال بالـ VPS

```bash
ssh root@your-vps-ip
# أو
ssh username@your-vps-ip
```

### 2. تحديث النظام

```bash
sudo apt update
sudo apt upgrade -y
```

### 3. تثبيت Node.js و npm

```bash
# تثبيت Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# التحقق من التثبيت
node -v
npm -v
```

### 4. تثبيت PM2 (Process Manager)

```bash
sudo npm install -g pm2
```

### 5. تثبيت Nginx

```bash
sudo apt install nginx -y
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 6. تثبيت MySQL (إذا لزم الأمر)

```bash
sudo apt install mysql-server -y
sudo mysql_secure_installation

# إنشاء قاعدة البيانات
sudo mysql -u root -p
```

في MySQL:
```sql
CREATE DATABASE alqaed_platform;
CREATE USER 'alqaed_user'@'localhost' IDENTIFIED BY 'your_strong_password';
GRANT ALL PRIVILEGES ON alqaed_platform.* TO 'alqaed_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 7. رفع المشروع إلى VPS

#### الطريقة الأولى: استخدام Git (الأفضل)

على VPS:
```bash
cd /var/www
sudo mkdir alqaed-platform
sudo chown -R $USER:$USER alqaed-platform
cd alqaed-platform

# استنساخ المشروع من GitHub
git clone https://github.com/your-username/your-repo.git .
# أو إذا كان المشروع خاص
git clone https://<token>@github.com/your-username/your-repo.git .
```

#### الطريقة الثانية: استخدام SCP (نقل الملفات مباشرة)

على جهازك المحلي:
```bash
# من داخل مجلد المشروع
cd "c:\Users\abdua\OneDrive\سطح المكتب\FreeLance_25"

# بناء المشروع أولاً
npm run build

# رفع المشروع بالكامل
scp -r . username@your-vps-ip:/var/www/alqaed-platform/
```

#### الطريقة الثالثة: استخدام FileZilla أو WinSCP

1. افتح FileZilla
2. اتصل بالـ VPS (Host: your-vps-ip, Username: your-username, Password: your-password)
3. انسخ جميع ملفات المشروع إلى `/var/www/alqaed-platform/`

### 8. تثبيت المكتبات وبناء المشروع

```bash
cd /var/www/alqaed-platform

# تثبيت المكتبات
npm install

# تثبيت serve لتشغيل البناء النهائي
npm install -g serve

# بناء المشروع للإنتاج
npm run build
```

### 9. إعداد ملف البيئة

```bash
nano .env.production
```

أضف المتغيرات التالية:
```
VITE_API_URL=http://your-vps-ip
NODE_ENV=production
```

### 10. تشغيل المشروع باستخدام PM2

```bash
# تشغيل التطبيق
pm2 start ecosystem.config.js

# حفظ قائمة العمليات
pm2 save

# تشغيل PM2 تلقائياً عند بدء التشغيل
pm2 startup
# انسخ والصق الأمر الذي يظهر لك
```

### 11. إعداد Nginx كـ Reverse Proxy

```bash
sudo nano /etc/nginx/sites-available/alqaed-platform
```

أضف التكوين التالي:
```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;  # أو استخدم your-vps-ip

    root /var/www/alqaed-platform/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # إعدادات الأصول الثابتة
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # إعدادات الضغط
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/xml+rss application/javascript application/json;
}
```

تفعيل الموقع:
```bash
sudo ln -s /etc/nginx/sites-available/alqaed-platform /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 12. إعداد Firewall

```bash
# السماح بـ HTTP و HTTPS و SSH
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 13. إعداد SSL (HTTPS) - اختياري لكن مهم

```bash
# تثبيت Certbot
sudo apt install certbot python3-certbot-nginx -y

# الحصول على شهادة SSL
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# سيتم تجديد الشهادة تلقائياً
```

---

## أوامر مفيدة لإدارة المشروع

### PM2 Commands
```bash
pm2 list                 # عرض جميع العمليات
pm2 logs                 # عرض السجلات
pm2 restart all          # إعادة تشغيل جميع التطبيقات
pm2 stop all             # إيقاف جميع التطبيقات
pm2 delete all           # حذف جميع التطبيقات
pm2 monit                # مراقبة الأداء
```

### Nginx Commands
```bash
sudo nginx -t                    # اختبار التكوين
sudo systemctl restart nginx     # إعادة تشغيل Nginx
sudo systemctl status nginx      # حالة Nginx
sudo systemctl reload nginx      # إعادة تحميل التكوين
```

### تحديث المشروع
```bash
cd /var/www/alqaed-platform
git pull origin main             # سحب آخر التحديثات
npm install                      # تثبيت المكتبات الجديدة
npm run build                    # بناء المشروع
pm2 restart all                  # إعادة تشغيل التطبيق
```

---

## استكشاف الأخطاء وحلها

### 1. لا يمكن الوصول إلى الموقع
```bash
# تحقق من Nginx
sudo systemctl status nginx
sudo nginx -t

# تحقق من PM2
pm2 list
pm2 logs

# تحقق من الـ Firewall
sudo ufw status
```

### 2. خطأ 502 Bad Gateway
```bash
# تحقق من أن التطبيق يعمل
pm2 list
pm2 restart all

# تحقق من البورت
netstat -tulpn | grep 8080
```

### 3. مشاكل في الأذونات
```bash
sudo chown -R www-data:www-data /var/www/alqaed-platform/dist
sudo chmod -R 755 /var/www/alqaed-platform/dist
```

### 4. عرض السجلات
```bash
# سجلات PM2
pm2 logs

# سجلات Nginx
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

---

## تحسينات الأداء

### 1. تفعيل الضغط في Nginx
تم إضافته في ملف التكوين أعلاه

### 2. تفعيل التخزين المؤقت
```nginx
# في ملف nginx
location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2)$ {
    expires 365d;
    add_header Cache-Control "public, no-transform";
}
```

### 3. تحسين MySQL (إذا كنت تستخدمه)
```bash
sudo nano /etc/mysql/mysql.conf.d/mysqld.cnf
```

أضف:
```
[mysqld]
max_connections = 200
innodb_buffer_pool_size = 512M
```

---

## النسخ الاحتياطي

### نسخة احتياطية تلقائية يومية:

```bash
# إنشاء سكريبت النسخ الاحتياطي
sudo nano /usr/local/bin/backup-alqaed.sh
```

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/alqaed"
DATE=$(date +%Y%m%d_%H%M%S)

# إنشاء مجلد النسخ الاحتياطي
mkdir -p $BACKUP_DIR

# نسخ الملفات
tar -czf $BACKUP_DIR/files_$DATE.tar.gz /var/www/alqaed-platform

# نسخ قاعدة البيانات (إذا كانت موجودة)
mysqldump -u alqaed_user -p'your_password' alqaed_platform > $BACKUP_DIR/db_$DATE.sql

# حذف النسخ الاحتياطية الأقدم من 7 أيام
find $BACKUP_DIR -type f -mtime +7 -delete

echo "Backup completed: $DATE"
```

```bash
sudo chmod +x /usr/local/bin/backup-alqaed.sh

# إضافة مهمة cron
sudo crontab -e
```

أضف السطر التالي:
```
0 2 * * * /usr/local/bin/backup-alqaed.sh
```

---

## الوصول إلى الموقع

بعد اكتمال الإعداد، يمكنك الوصول إلى موقعك عبر:
- `http://your-vps-ip`
- أو `http://your-domain.com` (إذا كنت قد ربطت دومين)
- أو `https://your-domain.com` (إذا قمت بإعداد SSL)

---

## ملاحظات مهمة

1. **استبدل القيم التالية بقيمك الخاصة:**
   - `your-vps-ip`: عنوان IP الخاص بالـ VPS
   - `your-domain.com`: اسم النطاق الخاص بك
   - `your-username`: اسم المستخدم الخاص بك
   - `your_strong_password`: كلمة مرور قوية

2. **الأمان:**
   - غيّر كلمات المرور الافتراضية
   - استخدم SSH Keys بدلاً من كلمات المرور
   - فعّل Firewall
   - حدّث النظام بانتظام

3. **المراقبة:**
   - راقب استخدام الموارد (CPU, RAM, Disk)
   - راقب السجلات بانتظام
   - أعد النسخ الاحتياطية بانتظام

---

## الدعم والمساعدة

إذا واجهت أي مشاكل:
1. تحقق من السجلات: `pm2 logs` و `sudo tail -f /var/log/nginx/error.log`
2. تحقق من أن جميع الخدمات تعمل: `pm2 list` و `sudo systemctl status nginx`
3. تحقق من الاتصال بالإنترنت والـ Firewall

---

**بالتوفيق! 🚀**
