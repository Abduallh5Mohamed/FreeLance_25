# 🔒 دليل تأمين السيرفر الشامل
## بعد التعرض للهاكينج - خطوات عملية للحماية الكاملة

> **تحذير مهم:** قبل تطبيق أي خطوة، تأكد من أخذ نسخة احتياطية كاملة (Snapshot) من السيرفر

---

## 📋 جدول المحتويات

1. [التطبيق السريع (Quick Start)](#quick-start)
2. [تأمين SSH](#ssh-security)
3. [Fail2Ban - حماية من Brute Force](#fail2ban)
4. [جدار الحماية UFW](#firewall)
5. [تأمين Nginx](#nginx-security)
6. [فحص الثغرات](#security-audit)
7. [التحديثات التلقائية](#auto-updates)
8. [Cloudflare (خارجي)](#cloudflare)
9. [نصائح إضافية](#extra-tips)

---

## <a id="quick-start"></a>🚀 التطبيق السريع

إذا كنت تريد تطبيق كل شيء بسرعة:

```bash
# 1. ارفع مجلد security للسيرفر
scp -r security/ user@YOUR_SERVER_IP:/home/user/

# 2. ادخل السيرفر
ssh user@YOUR_SERVER_IP

# 3. اعطي صلاحيات التنفيذ
cd ~/security
chmod +x *.sh

# 4. نفذ كل السكريبتات بالترتيب
sudo bash ssh-hardening.sh          # تأمين SSH
sudo bash fail2ban-setup.sh         # حماية Brute Force
sudo bash firewall-setup.sh         # جدار الحماية
sudo bash nginx-security-setup.sh   # تأمين Nginx
sudo bash auto-updates-setup.sh     # التحديثات التلقائية
bash security-audit.sh              # فحص الثغرات
```

---

## <a id="ssh-security"></a>🔐 1. تأمين SSH (الأولوية القصوى)

### لماذا هذه الخطوة مهمة؟
معظم الهجمات تبدأ من SSH عن طريق تجربة آلاف الباسوردات (Brute Force)

### الخطوات:

#### أ) تشغيل السكريبت الآلي:
```bash
sudo bash ssh-hardening.sh
```

السكريبت هيعمل:
- ✅ تغيير بورت SSH لرقم عشوائي
- ✅ تعطيل Root login
- ✅ إنشاء SSH Key
- ✅ تأمين الإعدادات

#### ب) احفظ المعلومات المهمة:
- **البورت الجديد** محفوظ في `~/ssh_new_port.txt`
- **المفتاح العام (Public Key)** - هيطبعه السكريبت
- **المفتاح الخاص (Private Key)** - نسخه بالأمر:
  ```bash
  cat ~/.ssh/id_rsa
  ```

#### ج) اختبر الاتصال من جهازك:
```bash
# افتح terminal جديد (لا تقفل القديم!)
ssh -p NEW_PORT user@YOUR_SERVER_IP

# أو باستخدام المفتاح الخاص
ssh -i path/to/private_key -p NEW_PORT user@YOUR_SERVER_IP
```

#### د) بعد التأكد من نجاح الاتصال، عطل Password Authentication:
```bash
sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

### ⚠️ تحذير مهم جداً:
- **لا تقفل الجلسة الحالية** قبل اختبار الاتصال من جلسة جديدة
- لو حصلت مشكلة، السيرفر أخذ backup تلقائي من الملف الأصلي

---

## <a id="fail2ban"></a>🛡️ 2. Fail2Ban - حماية من Brute Force

### ما هو Fail2Ban؟
برنامج يراقب محاولات الدخول الفاشلة ويحظر الـ IP تلقائياً

### التطبيق:
```bash
sudo bash fail2ban-setup.sh
```

### الإعدادات المطبقة:
- عدد المحاولات الفاشلة: **3**
- مدة الحظر: **1 ساعة** (أول مرة)
- يحمي: SSH, Nginx

### أوامر مفيدة:
```bash
# حالة Fail2Ban
sudo fail2ban-client status

# IPs المحظورة حالياً
sudo fail2ban-client status sshd

# إلغاء حظر IP معين
sudo fail2ban-client set sshd unbanip 1.2.3.4

# سجل الأحداث
tail -f /var/log/fail2ban.log
```

---

## <a id="firewall"></a>🚪 3. جدار الحماية UFW

### الهدف:
قفل كل البوربات ما عدا اللي تحتاجها فعلاً

### التطبيق:
```bash
sudo bash firewall-setup.sh
```

### البوربات المفتوحة:
- **80** (HTTP)
- **443** (HTTPS)
- **البورت الجديد** (SSH)

### أوامر مفيدة:
```bash
# حالة الجدار
sudo ufw status verbose

# فتح بورت جديد
sudo ufw allow 3000/tcp

# حذف قاعدة
sudo ufw status numbered
sudo ufw delete RULE_NUMBER

# تعطيل مؤقت (للصيانة)
sudo ufw disable
```

---

## <a id="nginx-security"></a>🌐 4. تأمين Nginx

### المميزات:
- Security Headers (XSS, Clickjacking)
- Rate Limiting (منع DDoS)
- إخفاء معلومات السيرفر
- حماية الملفات الحساسة

### التطبيق:
```bash
sudo bash nginx-security-setup.sh
```

### إضافات يدوية مهمة:

#### أ) إضافة Rate Limiting لصفحة API:
```nginx
# في ملف الموقع: /etc/nginx/sites-available/your-site
location /api/ {
    limit_req zone=api_limit burst=20 nodelay;
    limit_req_status 429;
    
    # باقي الإعدادات...
}
```

#### ب) إضافة SSL Parameters:
```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;
    
    # شهادة SSL
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # إعدادات الأمان
    include snippets/ssl-params.conf;
    
    # باقي الإعدادات...
}
```

#### ج) حماية صفحة تسجيل الدخول:
```nginx
location /admin/login {
    limit_req zone=login_limit burst=3 nodelay;
    limit_req_status 429;
    
    # باقي الإعدادات...
}
```

### اختبار Security Headers:
```bash
curl -I https://yourdomain.com
```

---

## <a id="security-audit"></a>🔍 5. فحص الثغرات

### متى تستخدمه؟
- بعد كل هاكينج
- مرة كل أسبوع
- بعد رفع تحديث جديد

### التشغيل:
```bash
bash security-audit.sh
```

### التقرير يفحص:
- ملفات PHP بها دوال خطيرة (eval, base64_decode)
- ملفات تم تعديلها مؤخراً
- صلاحيات 777 (خطيرة)
- عمليات (processes) مشبوهة
- Cron jobs غريبة
- Users جدد
- ملفات .env أو .sql في مجلدات عامة

### بعد الفحص:
```bash
# اقرأ التقرير
cat security_audit_*.txt

# ابحث عن دوال خطيرة
grep -r "eval\|base64_decode" /var/www --include="*.php"

# احذف الملفات المشبوهة
rm /path/to/suspicious-file.php
```

---

## <a id="auto-updates"></a>🔄 6. التحديثات التلقائية

### الهدف:
ضمان تحديث السيرفر تلقائياً لإصلاح الثغرات الأمنية

### التطبيق:
```bash
sudo bash auto-updates-setup.sh
```

### الإعدادات:
- تحديث يومي للأمان
- إعادة تشغيل تلقائية (الساعة 3 فجراً)
- تنظيف الباكجات القديمة

### إلغاء إعادة التشغيل التلقائية:
```bash
sudo nano /etc/apt/apt.conf.d/50unattended-upgrades
# غير السطر ده:
Unattended-Upgrade::Automatic-Reboot "false";
```

---

## <a id="cloudflare"></a>☁️ 7. Cloudflare (مهم جداً)

### لماذا Cloudflare؟
- يخفي IP السيرفر الحقيقي
- حماية من DDoS
- Web Application Firewall (WAF)
- تحسين السرعة

### خطوات الربط:

1. **إنشاء حساب** في [Cloudflare.com](https://cloudflare.com)
2. **إضافة موقعك** (Add Site)
3. **تغيير Nameservers** في Hostinger:
   - سجل دخول Hostinger
   - DNS/Nameservers
   - غير الـ Nameservers للي هيديهملك Cloudflare
4. **تفعيل SSL** في Cloudflare:
   - SSL/TLS → Full (strict)
5. **تفعيل WAF**:
   - Security → WAF → Managed Rules → On

### ميزات إضافية:
```
Under Attack Mode: Security → Settings → I'm Under Attack
Page Rules: Rules → Page Rules (إعادة توجيه HTTP → HTTPS)
Rate Limiting: إضافي في الخطة المدفوعة
```

---

## <a id="extra-tips"></a>💡 8. نصائح إضافية مهمة

### أ) مراجعة الكود (Code Security)

#### في Backend (Node.js):
```javascript
// ❌ خطأ - SQL Injection
const query = `SELECT * FROM users WHERE id = ${userId}`;

// ✅ صح - Prepared Statements
const query = 'SELECT * FROM users WHERE id = ?';
db.query(query, [userId]);

// ✅ Validation مع express-validator
const { body, validationResult } = require('express-validator');

app.post('/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    // باقي الكود...
});
```

#### حماية ملف .env:
```bash
# تأكد إن .env خارج public_html
ls -la /var/www/html/.env  # يجب ألا يكون موجود هنا

# الصلاحيات الصحيحة
chmod 600 /path/to/.env
chown www-data:www-data /path/to/.env
```

### ب) مراقبة النشاط:

```bash
# تثبيت أدوات المراقبة
sudo apt install htop iotop nethogs

# مراقبة العمليات
htop

# مراقبة الشبكة
sudo nethogs

# مراقبة مساحة القرص
df -h
```

### ج) نسخ احتياطية منتظمة:

```bash
# سكريبت بسيط للـ backup
#!/bin/bash
BACKUP_DIR="/backups/$(date +%F)"
mkdir -p $BACKUP_DIR

# نسخ الملفات
tar -czf $BACKUP_DIR/www-backup.tar.gz /var/www

# نسخ قاعدة البيانات
mysqldump -u root -p database_name > $BACKUP_DIR/db-backup.sql

# حذف النسخ الأقدم من 7 أيام
find /backups -mtime +7 -delete
```

### د) أدوات فحص إضافية:

```bash
# Rootkit Hunter
sudo apt install rkhunter
sudo rkhunter --update
sudo rkhunter --check

# ClamAV - فحص الفيروسات
sudo apt install clamav clamav-daemon
sudo freshclam  # تحديث قاعدة البيانات
sudo clamscan -r /var/www  # فحص المجلد

# Lynis - فحص أمني شامل
sudo apt install lynis
sudo lynis audit system
```

---

## 📊 Checklist - تأكد من كل حاجة

- [ ] SSH: تغيير البورت ✅
- [ ] SSH: تعطيل Root Login ✅
- [ ] SSH: SSH Keys فقط ✅
- [ ] Fail2Ban: مثبت ويعمل ✅
- [ ] UFW: مفعل والبوربات صحيحة ✅
- [ ] Nginx: Security Headers مطبقة ✅
- [ ] Nginx: Rate Limiting مفعل ✅
- [ ] Auto Updates: مفعل ✅
- [ ] Security Audit: تم الفحص ✅
- [ ] Cloudflare: مربوط ✅
- [ ] Code: تم مراجعة الـ SQL Queries ✅
- [ ] .env: محمي وخارج public_html ✅
- [ ] Backups: نظام نسخ احتياطي يومي ✅
- [ ] Monitoring: أدوات المراقبة مثبتة ✅

---

## 🆘 في حالة الطوارئ

### لو حصل هجوم حالياً:

```bash
# 1. حظر IP معين فوراً
sudo ufw deny from 1.2.3.4

# 2. فحص الاتصالات النشطة
sudo ss -tunap | grep ESTABLISHED

# 3. قتل عملية مشبوهة
sudo kill -9 PID

# 4. فحص آخر تغييرات في الملفات
find /var/www -mtime -1 -ls

# 5. فحص Cron Jobs
crontab -l
sudo crontab -l
```

### لو نسيت بورت SSH الجديد:
```bash
# من داخل السيرفر (console في Hostinger)
cat ~/ssh_new_port.txt
```

### لو اتقفل من SSH:
```bash
# استخدم Console من Hostinger Panel
# ارجع الملف الأصلي
sudo cp /etc/ssh/sshd_config.backup.* /etc/ssh/sshd_config
sudo systemctl restart sshd
```

---

## 📞 دعم إضافي

### Logs مهمة للتحليل:
```bash
# Auth logs
sudo tail -100 /var/log/auth.log

# Nginx Access
sudo tail -100 /var/log/nginx/access.log

# Nginx Errors
sudo tail -100 /var/log/nginx/error.log

# Fail2Ban
sudo tail -100 /var/log/fail2ban.log

# System logs
sudo journalctl -n 100
```

---

## ✅ الخلاصة

بعد تطبيق كل الخطوات دي، السيرفر بتاعك هيكون:

1. ✅ **محمي من Brute Force** (Fail2Ban)
2. ✅ **محمي من DDoS** (Cloudflare + Nginx)
3. ✅ **محمي من SQL Injection** (إذا راجعت الكود)
4. ✅ **محمي من XSS** (Security Headers)
5. ✅ **محدث تلقائياً** (Auto Updates)
6. ✅ **مراقب باستمرار** (Security Audit)

**مهم:** الأمان مش خطوة واحدة، ده عملية مستمرة. راقب السيرفر أسبوعياً واعمل فحص أمني دوري.

---

**تم إنشاء هذا الدليل في:** 23 ديسمبر 2025  
**آخر تحديث:** 23 ديسمبر 2025

**ملاحظة:** كل السكريبتات في مجلد `security/` جاهزة للاستخدام المباشر
