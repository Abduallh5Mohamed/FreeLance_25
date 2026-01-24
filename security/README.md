# Security Files - ملفات تأمين السيرفر

هذا المجلد يحتوي على كل السكريبتات اللازمة لتأمين السيرفر بعد التعرض للهاكينج.

## 📁 محتويات المجلد

### 🚀 التطبيق السريع (الكل مرة واحدة)
- **`master-setup.sh`** - سكريبت شامل يطبق كل شيء تلقائياً

### 🔐 سكريبتات التأمين الفردية
1. **`ssh-hardening.sh`** - تأمين SSH (تغيير البورت + SSH Keys)
2. **`fail2ban-setup.sh`** - حماية من Brute Force
3. **`firewall-setup.sh`** - إعداد جدار الحماية UFW
4. **`nginx-security-setup.sh`** - تطبيق إعدادات أمان Nginx
5. **`auto-updates-setup.sh`** - تفعيل التحديثات التلقائية
6. **`security-audit.sh`** - فحص الثغرات والملفات المشبوهة

### ⚙️ ملفات الإعدادات
- **`nginx-security.conf`** - إعدادات أمان Nginx (Headers + Rate Limiting)
- **`nginx-ssl-params.conf`** - إعدادات SSL آمنة

## 🎯 طريقة الاستخدام

### الطريقة الأولى: تطبيق كل شيء مرة واحدة (موصى بها)

```bash
# 1. ارفع المجلد للسيرفر
scp -r security/ user@YOUR_SERVER_IP:/home/user/

# 2. ادخل السيرفر
ssh user@YOUR_SERVER_IP

# 3. اعطي صلاحيات التنفيذ
cd ~/security
chmod +x *.sh

# 4. شغل السكريبت الشامل
sudo bash master-setup.sh
```

### الطريقة الثانية: تطبيق كل سكريبت على حدة

```bash
cd ~/security
chmod +x *.sh

# بالترتيب:
sudo bash ssh-hardening.sh          # 1. تأمين SSH
sudo bash fail2ban-setup.sh         # 2. Fail2Ban
sudo bash firewall-setup.sh         # 3. UFW
sudo bash nginx-security-setup.sh   # 4. Nginx
sudo bash auto-updates-setup.sh     # 5. Auto Updates
bash security-audit.sh              # 6. فحص الثغرات
```

## ⚠️ تحذيرات مهمة

1. **خذ Snapshot** من السيرفر قبل تطبيق أي شيء
2. **لا تقفل جلسة SSH** قبل اختبار الاتصال بالبورت الجديد
3. **احفظ البورت الجديد** والمفتاح الخاص في مكان آمن
4. **اربط موقعك بـ Cloudflare** لحماية إضافية

## 📖 الدليل الشامل

لمزيد من التفاصيل، اقرأ:
- **`../SECURITY_GUIDE_COMPLETE.md`** - دليل شامل بكل التفاصيل

## 🆘 في حالة الطوارئ

### لو نسيت بورت SSH:
```bash
# من console في Hostinger
cat ~/ssh_new_port.txt
```

### لو اتقفلت من SSH:
```bash
# من console في Hostinger
sudo cp /etc/ssh/sshd_config.backup.* /etc/ssh/sshd_config
sudo systemctl restart sshd
```

### لو حصل مشكلة في Nginx:
```bash
sudo nginx -t  # اختبار الإعدادات
sudo cp /etc/nginx/backup_*/conf.d/* /etc/nginx/conf.d/
sudo systemctl restart nginx
```

## ✅ Checklist بعد التطبيق

- [ ] تم تغيير بورت SSH
- [ ] تم حفظ المفتاح الخاص
- [ ] تم اختبار الاتصال من جلسة جديدة
- [ ] Fail2Ban يعمل (`sudo fail2ban-client status`)
- [ ] UFW مفعل (`sudo ufw status`)
- [ ] Nginx security headers تعمل (`curl -I https://domain.com`)
- [ ] تم قراءة تقرير الأمان
- [ ] تم ربط Cloudflare

## 📞 أوامر مفيدة

```bash
# حالة الخدمات
sudo systemctl status sshd
sudo systemctl status fail2ban
sudo systemctl status nginx
sudo ufw status

# Logs
sudo tail -f /var/log/auth.log
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/fail2ban.log

# فحص IPs المحظورة
sudo fail2ban-client status sshd

# فحص الاتصالات النشطة
sudo ss -tunap | grep ESTABLISHED
```

---

**آخر تحديث:** 23 ديسمبر 2025
