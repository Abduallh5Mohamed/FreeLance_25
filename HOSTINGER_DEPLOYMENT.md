# دليل رفع المشروع على Hostinger بالتفصيل 🚀

## 🎯 الخطوة الأولى: اختيار الخطة المناسبة

### على موقع Hostinger:

1. **اذهب إلى**: https://www.hostinger.com
2. **اختر من القائمة**: VPS Hosting (وليس Shared Hosting)
3. **الخطط المتاحة**:

   #### ✅ الخطة الموصى بها: **KVM 2**
   - **السعر**: حوالي $5.99/شهر
   - **المواصفات**:
     - 2 vCPU Cores
     - 4 GB RAM
     - 50 GB NVMe Storage
     - 2 TB Bandwidth
   - **مناسبة لـ**: مشروع متوسط مع 100-500 مستخدم

   #### 🌟 إذا كان المشروع كبير: **KVM 4**
   - **السعر**: حوالي $8.99/شهر
   - **المواصفات**:
     - 4 vCPU Cores
     - 8 GB RAM
     - 100 GB NVMe Storage
     - 4 TB Bandwidth
   - **مناسبة لـ**: مشروع كبير مع 500+ مستخدم

   #### 💡 إذا كان المشروع صغير: **KVM 1**
   - **السعر**: حوالي $4.99/شهر
   - **المواصفات**:
     - 1 vCPU Core
     - 2 GB RAM
     - 20 GB NVMe Storage
     - 1 TB Bandwidth
   - **مناسبة لـ**: مشروع صغير أو تجريبي

4. **اضغط على**: "Add to Cart"
5. **اختر مدة الاشتراك**: 
   - 1 شهر (للتجربة)
   - 12 شهر (توفير أكثر)
   - 24 شهر (أفضل سعر)
6. **أكمل عملية الدفع**

---

## 🖥️ الخطوة الثانية: إعداد VPS

### بعد الشراء:

1. **اذهب إلى**: Hostinger Dashboard
2. **من القائمة الجانبية**: VPS
3. **اختر**: VPS الخاص بك
4. **ستجد**:
   - عنوان IP الخاص بالسيرفر
   - اسم المستخدم (عادة `root`)
   - كلمة المرور (أو زر لإعادة تعيينها)

### 🎨 اختيار نظام التشغيل:

1. **في لوحة تحكم VPS**، اضغط على "Operating System"
2. **اختر**: **Ubuntu 22.04 LTS** أو **Ubuntu 24.04 LTS** ✅ (موصى به)
3. **اضغط**: "Change OS" أو "Install"
4. **انتظر** 5-10 دقائق حتى يتم التثبيت

---

## 🔐 الخطوة الثالثة: الاتصال بالـ VPS

### الطريقة الأولى: من خلال Hostinger Browser SSH

1. **في لوحة تحكم VPS**
2. **اضغط على**: "Browser SSH" أو "Open SSH Terminal"
3. **سيفتح لك**: تيرمينال مباشر في المتصفح

### الطريقة الثانية: من جهازك (Windows)

#### أ. استخدام PowerShell:
```powershell
# افتح PowerShell
ssh root@your-vps-ip
# اكتب كلمة المرور عند الطلب
```

#### ب. استخدام PuTTY:
1. **حمّل PuTTY**: https://www.putty.org/
2. **افتح PuTTY**
3. **في Host Name**: اكتب عنوان IP
4. **Port**: 22
5. **اضغط**: "Open"
6. **اكتب**: `root`
7. **اكتب كلمة المرور**

---

## 🛠️ الخطوة الرابعة: تجهيز السيرفر (خطوة بخطوة)

### 1️⃣ تحديث النظام

```bash
# نسخ والصق هذه الأوامر واحد تلو الآخر
sudo apt update
sudo apt upgrade -y
```
**انتظر** حتى تنتهي العملية (قد تستغرق 5 دقائق)

---

### 2️⃣ تثبيت Node.js

```bash
# تثبيت Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# التحقق من التثبيت
node -v
npm -v
```
**يجب أن ترى**: `v20.x.x` و `10.x.x`

---

### 3️⃣ تثبيت Nginx

```bash
sudo apt install nginx -y
sudo systemctl start nginx
sudo systemctl enable nginx

# التحقق
sudo systemctl status nginx
```
**اضغط** `q` للخروج

**الآن جرب**: افتح المتصفح واكتب `http://your-vps-ip`
**يجب أن ترى**: صفحة "Welcome to nginx!"

---

### 4️⃣ تثبيت PM2

```bash
sudo npm install -g pm2 serve

# التحقق
pm2 -v
```

---

### 5️⃣ تثبيت MySQL (إذا كنت تستخدم قاعدة بيانات)

```bash
sudo apt install mysql-server -y

# تأمين MySQL
sudo mysql_secure_installation
```

**سيسألك أسئلة**:
- Set root password? **Y** → اختر كلمة مرور قوية
- Remove anonymous users? **Y**
- Disallow root login remotely? **Y**
- Remove test database? **Y**
- Reload privilege tables? **Y**

**إنشاء قاعدة البيانات**:
```bash
sudo mysql -u root -p
```

داخل MySQL:
```sql
CREATE DATABASE alqaed_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'alqaed_user'@'localhost' IDENTIFIED BY 'كلمة_مرور_قوية';
GRANT ALL PRIVILEGES ON alqaed_platform.* TO 'alqaed_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

---

### 6️⃣ إنشاء مجلد المشروع

```bash
# إنشاء المجلد
sudo mkdir -p /var/www/alqaed-platform

# منح الأذونات
sudo chown -R $USER:$USER /var/www/alqaed-platform
```

---

## 📤 الخطوة الخامسة: رفع المشروع

### الطريقة الأولى: استخدام Git (الأفضل ✅)

#### على السيرفر:
```bash
cd /var/www/alqaed-platform

# إذا كان المشروع على GitHub
git clone https://github.com/Abduallh5Mohamed/FreeLance_25.git .

# أو إذا كان خاص
git clone https://<your-token>@github.com/Abduallh5Mohamed/FreeLance_25.git .
```

#### إنشاء Token من GitHub:
1. اذهب إلى: https://github.com/settings/tokens
2. اضغط "Generate new token (classic)"
3. اختر Scopes: `repo`
4. انسخ الـ Token

---

### الطريقة الثانية: استخدام FileZilla (الأسهل 👍)

#### على جهازك:
1. **حمّل FileZilla**: https://filezilla-project.org/
2. **افتح FileZilla**
3. **املأ الحقول**:
   - **Host**: `sftp://your-vps-ip`
   - **Username**: `root`
   - **Password**: كلمة مرور VPS
   - **Port**: `22`
4. **اضغط**: "Quickconnect"
5. **في الجانب الأيمن** (Remote site): اذهب إلى `/var/www/alqaed-platform`
6. **في الجانب الأيسر** (Local site): اذهب إلى مجلد مشروعك
7. **اختر جميع الملفات** → **اضغط زر الفأرة الأيمن** → **Upload**

**انتظر** حتى ينتهي الرفع (قد يستغرق 10-20 دقيقة حسب سرعة النت)

---

### الطريقة الثالثة: استخدام SCP من PowerShell

#### على جهازك (PowerShell):
```powershell
cd "C:\Users\abdua\OneDrive\سطح المكتب\FreeLance_25"

# رفع جميع الملفات
scp -r * root@your-vps-ip:/var/www/alqaed-platform/
```

---

## ⚙️ الخطوة السادسة: بناء وتشغيل المشروع

### على السيرفر:

```bash
cd /var/www/alqaed-platform

# تثبيت المكتبات
npm install
```
**انتظر** 5-10 دقائق

```bash
# بناء المشروع
npm run build
```
**انتظر** 2-5 دقائق

```bash
# تشغيل المشروع بـ PM2
pm2 start ecosystem.config.js

# حفظ العملية
pm2 save

# تشغيل PM2 تلقائياً عند إعادة التشغيل
pm2 startup
```

**انسخ الأمر** الذي يظهر لك والصقه في التيرمينال

```bash
# التحقق من أن التطبيق يعمل
pm2 list
pm2 logs
```

---

## 🌐 الخطوة السابعة: إعداد Nginx

### 1. إنشاء ملف التكوين:

```bash
sudo nano /etc/nginx/sites-available/alqaed
```

### 2. الصق هذا التكوين:

```nginx
server {
    listen 80;
    server_name your-vps-ip;  # أو your-domain.com إذا كان لديك دومين

    root /var/www/alqaed-platform/dist;
    index index.html;

    # الصفحة الرئيسية
    location / {
        try_files $uri $uri/ /index.html;
    }

    # ملفات الأصول
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # الضغط
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript 
               application/x-javascript application/xml+rss 
               application/javascript application/json image/svg+xml;

    # الأمان
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # حجم الملفات المرفوعة
    client_max_body_size 50M;
}
```

### 3. احفظ الملف:
- اضغط: `Ctrl + X`
- اكتب: `Y`
- اضغط: `Enter`

### 4. تفعيل الموقع:

```bash
# إنشاء رابط رمزي
sudo ln -s /etc/nginx/sites-available/alqaed /etc/nginx/sites-enabled/

# حذف الموقع الافتراضي
sudo rm /etc/nginx/sites-enabled/default

# اختبار التكوين
sudo nginx -t
```

**يجب أن ترى**: `syntax is ok` و `test is successful`

```bash
# إعادة تشغيل Nginx
sudo systemctl restart nginx
```

---

## 🔒 الخطوة الثامنة: إعداد Firewall

```bash
# السماح بالمنافذ المطلوبة
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS (للمستقبل)

# تفعيل Firewall
sudo ufw enable

# التحقق
sudo ufw status
```

---

## ✅ الخطوة التاسعة: اختبار الموقع

### افتح المتصفح واذهب إلى:
```
http://your-vps-ip
```

**يجب أن ترى**: موقعك يعمل! 🎉

---

## 🌍 الخطوة العاشرة: ربط دومين (اختياري)

### إذا كان لديك دومين:

#### 1. في Hostinger DNS:
- اذهب إلى: Domains → DNS Records
- أضف Record جديد:
  - **Type**: A
  - **Name**: @
  - **Points to**: عنوان IP الخاص بـ VPS
  - **TTL**: 14400
- أضف Record آخر:
  - **Type**: A
  - **Name**: www
  - **Points to**: عنوان IP الخاص بـ VPS
  - **TTL**: 14400

#### 2. عدّل ملف Nginx:
```bash
sudo nano /etc/nginx/sites-available/alqaed
```

غيّر السطر:
```nginx
server_name your-vps-ip;
```

إلى:
```nginx
server_name your-domain.com www.your-domain.com;
```

احفظ وأعد تشغيل Nginx:
```bash
sudo systemctl restart nginx
```

#### 3. انتظر 10-30 دقيقة حتى ينتشر DNS

---

## 🔐 الخطوة الحادية عشر: إعداد SSL (HTTPS)

### بعد ربط الدومين:

```bash
# تثبيت Certbot
sudo apt install certbot python3-certbot-nginx -y

# الحصول على شهادة SSL
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

**سيسألك**:
- Email: اكتب بريدك الإلكتروني
- Terms: اكتب `Y`
- Share email: اكتب `N`
- Redirect HTTP to HTTPS: اكتب `2` (Yes)

**الآن موقعك يعمل بـ HTTPS!** 🔒

---

## 🔄 تحديث المشروع لاحقاً

### الطريقة السريعة:

#### على جهازك:
```powershell
# بناء المشروع
npm run build

# رفع فقط مجلد dist
scp -r dist root@your-vps-ip:/var/www/alqaed-platform/
```

#### على السيرفر:
```bash
pm2 restart all
```

### الطريقة باستخدام Git:

#### على السيرفر:
```bash
cd /var/www/alqaed-platform
git pull origin main
npm install
npm run build
pm2 restart all
```

---

## 📊 مراقبة الموقع

### أوامر مفيدة:

```bash
# عرض حالة التطبيق
pm2 list

# عرض السجلات
pm2 logs

# مراقبة الأداء
pm2 monit

# إعادة تشغيل
pm2 restart all

# إيقاف
pm2 stop all

# حذف
pm2 delete all
```

```bash
# حالة Nginx
sudo systemctl status nginx

# سجلات Nginx
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log

# إعادة تشغيل Nginx
sudo systemctl restart nginx
```

```bash
# استخدام الموارد
htop  # اضغط q للخروج

# مساحة القرص
df -h

# الذاكرة
free -h
```

---

## 🆘 حل المشاكل الشائعة

### المشكلة 1: الموقع لا يفتح

```bash
# تحقق من PM2
pm2 list
pm2 logs

# تحقق من Nginx
sudo systemctl status nginx
sudo nginx -t

# تحقق من Firewall
sudo ufw status
```

### المشكلة 2: خطأ 502 Bad Gateway

```bash
# أعد تشغيل كل شيء
pm2 restart all
sudo systemctl restart nginx
```

### المشكلة 3: نفاد الذاكرة

```bash
# أعد تشغيل PM2
pm2 restart all

# أو زد حجم الذاكرة في ecosystem.config.js:
max_memory_restart: '2G'
```

### المشكلة 4: أخطاء في الأذونات

```bash
sudo chown -R www-data:www-data /var/www/alqaed-platform/dist
sudo chmod -R 755 /var/www/alqaed-platform/dist
```

---

## 💾 النسخ الاحتياطي

### إنشاء نسخة احتياطية:

```bash
# إنشاء مجلد النسخ الاحتياطية
sudo mkdir -p /var/backups/alqaed

# نسخ الملفات
sudo tar -czf /var/backups/alqaed/backup-$(date +%Y%m%d).tar.gz /var/www/alqaed-platform

# نسخ قاعدة البيانات (إذا كانت موجودة)
mysqldump -u alqaed_user -p alqaed_platform > /var/backups/alqaed/db-$(date +%Y%m%d).sql
```

### استعادة النسخة الاحتياطية:

```bash
# استعادة الملفات
sudo tar -xzf /var/backups/alqaed/backup-20250116.tar.gz -C /

# استعادة قاعدة البيانات
mysql -u alqaed_user -p alqaed_platform < /var/backups/alqaed/db-20250116.sql
```

---

## 📝 ملخص الأوامر الأساسية

### في جهازك (Windows PowerShell):
```powershell
# الاتصال بالسيرفر
ssh root@your-vps-ip

# رفع الملفات
scp -r dist root@your-vps-ip:/var/www/alqaed-platform/

# نقل ملف
scp file.txt root@your-vps-ip:/var/www/
```

### على السيرفر:
```bash
# إدارة PM2
pm2 list          # عرض التطبيقات
pm2 logs          # عرض السجلات
pm2 restart all   # إعادة التشغيل

# إدارة Nginx
sudo systemctl restart nginx    # إعادة التشغيل
sudo nginx -t                   # اختبار التكوين

# إدارة الملفات
cd /var/www/alqaed-platform    # الانتقال للمجلد
ls -la                         # عرض الملفات
nano file.txt                  # تعديل ملف

# إدارة النظام
sudo reboot                    # إعادة تشغيل السيرفر
sudo apt update                # تحديث الحزم
```

---

## ✅ قائمة التحقق النهائية

- [ ] شراء VPS من Hostinger
- [ ] اختيار Ubuntu 22.04 LTS
- [ ] الاتصال بالسيرفر
- [ ] تثبيت Node.js
- [ ] تثبيت Nginx
- [ ] تثبيت PM2
- [ ] تثبيت MySQL (إذا لزم الأمر)
- [ ] رفع المشروع
- [ ] بناء المشروع (`npm run build`)
- [ ] تشغيل المشروع بـ PM2
- [ ] إعداد Nginx
- [ ] إعداد Firewall
- [ ] اختبار الموقع
- [ ] ربط الدومين (اختياري)
- [ ] إعداد SSL (اختياري)
- [ ] إعداد النسخ الاحتياطي

---

## 📞 الدعم

### موارد مفيدة:
- **Hostinger Help**: https://www.hostinger.com/tutorials
- **Nginx Docs**: https://nginx.org/en/docs/
- **PM2 Docs**: https://pm2.keymetrics.io/docs/

### إذا واجهت مشكلة:
1. تحقق من السجلات: `pm2 logs` و `sudo tail -f /var/log/nginx/error.log`
2. تأكد من أن جميع الخدمات تعمل: `pm2 list` و `sudo systemctl status nginx`
3. تحقق من الـ Firewall: `sudo ufw status`

---

## 🎉 تهانينا!

موقعك الآن يعمل على Hostinger VPS بنجاح! 🚀

**الوصول إلى الموقع:**
- HTTP: `http://your-vps-ip`
- HTTPS: `https://your-domain.com` (بعد إعداد SSL)

**بالتوفيق! 💪**
