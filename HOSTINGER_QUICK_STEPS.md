# خطوات سريعة: رفع المشروع على Hostinger ⚡

## 📋 قبل ما تبدأ - جهز ده:

✅ حساب على Hostinger  
✅ VPS مشترك فيه  
✅ عنوان IP الخاص بالـ VPS  
✅ كلمة مرور root  

---

## 🎯 الخطوات (30 دقيقة)

### 1️⃣ شراء VPS من Hostinger (5 دقائق)

1. روح https://www.hostinger.com
2. اختار **VPS Hosting**
3. اختار خطة **KVM 2** (موصى بها): $5.99/شهر
4. اكمل الدفع
5. روح **Dashboard** → **VPS**
6. اختار **Operating System** → **Ubuntu 22.04 LTS**
7. انتظر 5 دقائق للتثبيت

---

### 2️⃣ اتصل بالسيرفر (2 دقيقة)

**الطريقة الأسهل: من Hostinger**
- اضغط **Browser SSH** في لوحة تحكم VPS

**أو من جهازك:**
```powershell
ssh root@your-vps-ip
```

---

### 3️⃣ ثبت البرامج المطلوبة (10 دقائق)

**انسخ والصق كل أمر بترتيب:**

```bash
# تحديث النظام
sudo apt update && sudo apt upgrade -y

# تثبيت Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# تثبيت Nginx و PM2
sudo apt install nginx -y
sudo npm install -g pm2 serve

# إنشاء مجلد المشروع
sudo mkdir -p /var/www/alqaed-platform
sudo chown -R $USER:$USER /var/www/alqaed-platform
```

---

### 4️⃣ ارفع المشروع (5 دقائق)

**الطريقة الأسهل: FileZilla**

1. حمل FileZilla: https://filezilla-project.org/
2. افتحه واملأ:
   - Host: `sftp://your-vps-ip`
   - Username: `root`
   - Password: كلمة مرور VPS
   - Port: `22`
3. اضغط **Quickconnect**
4. من اليمين روح: `/var/www/alqaed-platform`
5. من اليسار اختار مجلد مشروعك
6. اختار كل الملفات → Upload

---

### 5️⃣ شغل المشروع (5 دقائق)

```bash
# روح للمجلد
cd /var/www/alqaed-platform

# ثبت المكتبات
npm install

# ابني المشروع
npm run build

# شغله بـ PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# انسخ الأمر اللي يظهر والصقه
```

---

### 6️⃣ اعمل إعدادات Nginx (3 دقائق)

```bash
# انشئ ملف التكوين
sudo nano /etc/nginx/sites-available/alqaed
```

**الصق ده:**
```nginx
server {
    listen 80;
    server_name _;
    root /var/www/alqaed-platform/dist;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public";
    }
}
```

**احفظ:** Ctrl+X ثم Y ثم Enter

**فعّل الموقع:**
```bash
sudo ln -s /etc/nginx/sites-available/alqaed /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

---

### 7️⃣ افتح المنافذ (1 دقيقة)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## ✅ خلصنا! 🎉

**افتح المتصفح وروح:**
```
http://your-vps-ip
```

---

## 🔄 لو عايز تحدث المشروع بعدين:

**على جهازك:**
```powershell
npm run build
scp -r dist root@your-vps-ip:/var/www/alqaed-platform/
```

**على السيرفر:**
```bash
pm2 restart all
```

---

## 🆘 لو حصل مشكلة:

```bash
# شوف التطبيق شغال ولا لأ
pm2 list
pm2 logs

# شوف Nginx شغال ولا لأ
sudo systemctl status nginx

# لو مش شغال أعد تشغيل كل حاجة
pm2 restart all
sudo systemctl restart nginx
```

---

## 💡 ملاحظات مهمة:

⚠️ **استبدل** `your-vps-ip` بعنوان IP الفعلي  
⚠️ **لازم** تكون مثبت Node.js على جهازك عشان تبني المشروع  
⚠️ **خلي** FileZilla مفتوح عشان سهل ترفع التحديثات

---

**بالتوفيق! 💪🚀**
