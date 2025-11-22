# دليل النشر السريع على VPS

## خطوات سريعة (10 دقائق)

### 1️⃣ على جهازك المحلي

افتح PowerShell واكتب:

```powershell
# الانتقال إلى مجلد المشروع
cd "C:\Users\abdua\OneDrive\سطح المكتب\FreeLance_25"

# بناء المشروع
npm run build

# رفع المشروع بالكامل (استبدل القيم)
scp -r . username@your-vps-ip:/var/www/alqaed-platform/
```

### 2️⃣ على الـ VPS

اتصل بالـ VPS:
```bash
ssh username@your-vps-ip
```

ثم نفذ الأوامر التالية:

```bash
# تثبيت المتطلبات (مرة واحدة فقط)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pm2 serve

# الانتقال إلى مجلد المشروع
cd /var/www/alqaed-platform

# تشغيل التطبيق
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 3️⃣ إعداد Nginx

```bash
sudo nano /etc/nginx/sites-available/alqaed
```

الصق هذا التكوين:
```nginx
server {
    listen 80;
    server_name _;
    
    root /var/www/alqaed-platform/dist;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

احفظ الملف (Ctrl+X, Y, Enter)، ثم:

```bash
sudo ln -s /etc/nginx/sites-available/alqaed /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# فتح المنافذ
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw enable
```

### 4️⃣ الوصول إلى الموقع

افتح المتصفح واذهب إلى:
```
http://your-vps-ip
```

---

## تحديث المشروع لاحقاً

على جهازك المحلي:
```powershell
npm run build
scp -r dist username@your-vps-ip:/var/www/alqaed-platform/
```

على VPS:
```bash
pm2 restart all
```

---

## استكشاف الأخطاء

إذا لم يعمل الموقع:

```bash
# تحقق من PM2
pm2 list
pm2 logs

# تحقق من Nginx
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log

# تحقق من الأذونات
sudo chown -R www-data:www-data /var/www/alqaed-platform/dist
sudo chmod -R 755 /var/www/alqaed-platform/dist
```

---

## ملاحظات مهمة ⚠️

1. **استبدل `your-vps-ip` بعنوان IP الفعلي**
2. **استبدل `username` باسم المستخدم الفعلي**
3. **تأكد من فتح البورتات 22 و 80 في لوحة تحكم VPS**

---

**بالتوفيق! 🚀**
