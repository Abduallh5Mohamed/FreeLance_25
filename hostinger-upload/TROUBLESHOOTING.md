# 🔧 Troubleshooting Guide - حل المشاكل

## 🔍 كيف تشخص المشكلة؟

### خطوات التشخيص الأولية:
1. **افتح Developer Console** (F12 في المتصفح)
2. **شوف tab Console** - هل فيه أخطاء حمراء؟
3. **شوف tab Network** - هل الـ API requests تنجح؟
4. **شوف PM2 logs**: `pm2 logs api`

---

## 🚨 المشاكل الشائعة والحلول

### 1. الموقع لا يفتح نهائياً

#### الأعراض:
- "This site can't be reached"
- "DNS_PROBE_FINISHED_NXDOMAIN"
- الموقع يستمر في التحميل ولا يفتح

#### الحل:
```bash
# تحقق من DNS Settings
1. لوحة تحكم Hostinger → DNS/Name Servers
2. تأكد من:
   A Record → يشير لـ IP صحيح
   CNAME www → يشير للدومين الرئيسي

# انتظر DNS Propagation (حتى 48 ساعة)
# تحقق من: https://dnschecker.org

# امسح DNS Cache على جهازك
# Windows:
ipconfig /flushdns

# Mac:
sudo dscacheutil -flushcache
```

---

### 2. الموقع يفتح لكن صفحة بيضاء

#### الأعراض:
- صفحة بيضاء فاضية
- لا توجد رسائل خطأ ظاهرة

#### التشخيص:
```javascript
// افتح Console (F12)
// ابحث عن أخطاء مثل:

// "Failed to load resource"
// "Uncaught SyntaxError"
// "Cannot GET /"
```

#### الحل:
```bash
# 1. تحقق من file permissions
cd ~/public_html
chmod 644 *.html
chmod 644 *.js
chmod 644 *.css
chmod 755 assets

# 2. تحقق من .htaccess
cat .htaccess
# يجب أن يحتوي على:
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>

# 3. امسح Browser Cache
# Ctrl+Shift+Delete في المتصفح
```

---

### 3. API لا يستجيب (Error 500)

#### الأعراض:
- "Internal Server Error"
- API requests تفشل
- Cannot connect to database

#### التشخيص:
```bash
# شوف PM2 logs
pm2 logs api

# أو شغّل API مباشرة لترى الأخطاء
cd ~/api
node index.js

# تحقق من أن API شغال
pm2 status
# يجب أن يكون status: online
```

#### الحلول:

**أ) API مش شغال:**
```bash
pm2 restart api
pm2 status

# لو فشل:
pm2 delete api
pm2 start index.js --name api
pm2 save
```

**ب) خطأ في الاتصال بقاعدة البيانات:**
```bash
# راجع ملف .env
cd ~/api
cat .env

# تأكد من:
DB_HOST=localhost          # مش IP
DB_PORT=3306
DB_USER=u123456_user       # الاسم الكامل
DB_PASSWORD=correct_pass
DB_NAME=u123456_dbname     # الاسم الكامل

# اختبر الاتصال من MySQL
mysql -h localhost -u u123456_user -p u123456_dbname
# أدخل Password
# لو نجحت تدخل، الاتصال صحيح
```

**ج) مشكلة في المكتبات:**
```bash
cd ~/api
rm -rf node_modules
npm install --production

pm2 restart api
```

---

### 4. تسجيل الدخول لا يعمل

#### الأعراض:
- "Invalid credentials"
- "User not found"
- Login button لا يستجيب

#### الحل:

**أ) تحقق من وجود المستخدم:**
```sql
-- من phpMyAdmin
SELECT * FROM users WHERE phone = '01024083057';
-- يجب أن يظهر user
```

**ب) أعد إنشاء Admin:**
```sql
-- حذف القديم
DELETE FROM users WHERE phone = '01024083057';

-- إنشاء جديد
INSERT INTO users (phone, password, name, role) 
VALUES (
  '01024083057',
  '$2a$10$rK8qDLFPPJxGxVKxGxVKxOxGxVKxGxVKxGxVKxGxVKxGxVKxGxVKx',
  'Admin',
  'teacher'
);

-- كلمة المرور: Mtd#mora55
```

**ج) تحقق من JWT:**
```javascript
// في Console (F12)
localStorage.getItem('token')
// لو null → مشكلة في Login API
// لو موجود → مشكلة في التحقق من Token
```

---

### 5. الصور لا تظهر

#### الأعراض:
- Broken image icons
- 404 errors للصور
- الـ layout مكسور

#### الحل:
```bash
# 1. تحقق من مسارات الصور
cd ~/public_html/assets
ls -la
# تأكد من وجود الصور

# 2. صحح permissions
chmod 755 assets
chmod 644 assets/*.png
chmod 644 assets/*.jpg

# 3. تحقق من الـ paths في الكود
# يجب أن تبدأ بـ /assets/ وليس ./assets/
```

---

### 6. React Router لا يعمل

#### الأعراض:
- Refresh (F5) يعطي 404
- Direct URL access لا يعمل
- Back button يكسر الموقع

#### الحل:
```bash
# تحقق من .htaccess
cd ~/public_html
cat .htaccess

# يجب أن يحتوي على:
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteCond %{REQUEST_FILENAME} !-l
  RewriteRule . /index.html [L]
</IfModule>

# لو مش موجود، أنشئه:
nano .htaccess
# الصق الكود أعلاه
# Ctrl+X, Y, Enter
```

---

### 7. CORS Errors

#### الأعراض:
```
Access to XMLHttpRequest blocked by CORS policy
No 'Access-Control-Allow-Origin' header
```

#### الحل:
```javascript
// في server/src/index.ts (أو index.js)
// تأكد من وجود:

import cors from 'cors';

app.use(cors({
  origin: [
    'https://yourdomain.com',
    'http://localhost:8080'  // للتطوير
  ],
  credentials: true
}));
```

---

### 8. استهلاك الموارد (High CPU/RAM)

#### الأعراض:
- الموقع بطيء جداً
- "Service Unavailable"
- Hostinger يرسل تنبيهات

#### التشخيص:
```bash
# شوف استهلاك PM2
pm2 monit

# شوف استهلاك CPU
top

# شوف الذاكرة
free -m

# شوف Disk Usage
df -h

# شوف Inodes
df -i
```

#### الحل:
```bash
# 1. أعد تشغيل API
pm2 restart api

# 2. نظف logs القديمة
pm2 flush

# 3. نظف قاعدة البيانات
# من phpMyAdmin - احذف سجلات قديمة

# 4. نظف ملفات مؤقتة
cd ~
find . -name "*.log" -mtime +30 -delete
find . -name "*.tmp" -delete

# 5. لو Inodes ممتلئة:
# احذف node_modules القديمة
# احذف .git folders
```

---

### 9. SSL Certificate مشاكل

#### الأعراض:
- "Not Secure" في المتصفح
- "Certificate Error"
- HTTPS لا يعمل

#### الحل:
```bash
# 1. من لوحة تحكم Hostinger
Websites → SSL → Free SSL
اختر: Let's Encrypt
Install

# 2. فعّل Force HTTPS
Websites → Advanced → Force HTTPS → ON

# 3. انتظر 15 دقيقة

# 4. امسح browser cache وجرّب مرة أخرى
```

---

### 10. Database Connection Lost

#### الأعراض:
```
Error: Connection lost
ER_CON_COUNT_ERROR
Too many connections
```

#### الحل:
```bash
# 1. تحقق من عدد الاتصالات
# من phpMyAdmin:
SHOW PROCESSLIST;

# 2. أغلق اتصالات معلقة
KILL <process_id>;

# 3. في كود API، تأكد من:
// استخدام connection pooling
const pool = mysql.createPool({
  connectionLimit: 10,  // ليس أكثر من 75
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

// أغلق connections بعد الاستخدام
connection.end();
```

---

## 🛠 أدوات التشخيص المفيدة

### 1. Online Tools:
```
DNS Check: https://dnschecker.org
SSL Check: https://www.ssllabs.com/ssltest/
Website Speed: https://pagespeed.web.dev
Uptime Monitor: https://uptimerobot.com
```

### 2. Terminal Commands:
```bash
# تحقق من الاتصال بالسيرفر
ping yourdomain.com

# تحقق من SSL
openssl s_client -connect yourdomain.com:443

# تحقق من HTTP response
curl -I https://yourdomain.com

# تحقق من API
curl https://yourdomain.com/api/health
```

### 3. Browser DevTools:
```
F12 → Console: أخطاء JavaScript
F12 → Network: أخطاء requests
F12 → Application: localStorage & cookies
F12 → Performance: بطء التحميل
```

---

## 📋 Quick Fixes Checklist

عند أي مشكلة، جرّب هذه أولاً:

```bash
# 1. أعد تشغيل API
pm2 restart api

# 2. امسح browser cache
Ctrl+Shift+Delete

# 3. تحقق من logs
pm2 logs api

# 4. تحقق من .env
cat ~/api/.env

# 5. تحقق من database connection
mysql -h localhost -u user -p dbname

# 6. تحقق من file permissions
ls -la ~/public_html

# 7. تحقق من disk space
df -h

# 8. تحقق من inodes
df -i

# 9. تحقق من PM2 status
pm2 status

# 10. راجع Hostinger logs
من لوحة التحكم → Advanced → Error Logs
```

---

## 🆘 متى تطلب المساعدة؟

اطلب مساعدة Hostinger Support إذا:

- [ ] جربت كل الحلول ولم تنجح
- [ ] المشكلة في السيرفر نفسه (not responding)
- [ ] مشاكل DNS أو SSL
- [ ] تحتاج زيادة الموارد (CPU, RAM, etc.)
- [ ] مشاكل في Database Server

### قبل الاتصال بالدعم، جهّز:
1. وصف دقيق للمشكلة
2. Screenshots من الأخطاء
3. PM2 logs: `pm2 logs api --lines 100`
4. Error logs من Hostinger panel
5. الخطوات التي جربتها

---

## 💾 نسخة احتياطية قبل أي إصلاح

```bash
# Always backup before making changes!

# 1. Backup Database
mysqldump -u user -p dbname > backup_$(date +%Y%m%d).sql

# 2. Backup Files
cd ~
tar -czf backup_$(date +%Y%m%d).tar.gz api/ public_html/

# 3. Backup .env
cp api/.env api/.env.backup
```

---

## 🎯 Prevention Tips

منع المشاكل قبل حدوثها:

1. **Monitoring**: فعّل uptime monitoring
2. **Backups**: نسخ احتياطية أسبوعية
3. **Updates**: حدّث dependencies بانتظام
4. **Logs**: راجع logs يومياً
5. **Testing**: اختبر قبل أي تحديث
6. **Staging**: استخدم بيئة تجريبية

---

**Remember**: معظم المشاكل حلها بسيط - فقط ابحث في الـ logs! 🔍
