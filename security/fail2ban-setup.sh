#!/bin/bash

# ============================================
# Fail2Ban Setup - حماية من Brute Force
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== تثبيت وإعداد Fail2Ban ===${NC}\n"

# 1. تثبيت Fail2Ban
echo -e "${YELLOW}[1/4] تثبيت Fail2Ban...${NC}"
sudo apt update
sudo apt install -y fail2ban

echo -e "${GREEN}✓ تم تثبيت Fail2Ban${NC}\n"

# 2. إنشاء ملف الإعدادات
echo -e "${YELLOW}[2/4] إنشاء ملف الإعدادات...${NC}"

# الحصول على البورت الجديد من الملف أو استخدام 22 كقيمة افتراضية
SSH_PORT=22
if [ -f ~/ssh_new_port.txt ]; then
    SSH_PORT=$(cat ~/ssh_new_port.txt)
fi

sudo tee /etc/fail2ban/jail.local > /dev/null <<EOF
[DEFAULT]
# مدة الحظر (بالثانية) - 1 ساعة
bantime = 3600

# وقت النافذة للمحاولات الفاشلة - 10 دقائق
findtime = 600

# عدد المحاولات الفاشلة المسموح بها
maxretry = 3

# البريد الإلكتروني (اتركه فاضي لو مش محتاج تنبيهات)
destemail = your-email@example.com
sendername = Fail2Ban
action = %(action_)s

[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 7200
findtime = 600

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 3

[nginx-noscript]
enabled = true
port = http,https
filter = nginx-noscript
logpath = /var/log/nginx/access.log
maxretry = 6

[nginx-badbots]
enabled = true
port = http,https
filter = nginx-badbots
logpath = /var/log/nginx/access.log
maxretry = 2

[nginx-noproxy]
enabled = true
port = http,https
filter = nginx-noproxy
logpath = /var/log/nginx/access.log
maxretry = 2

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10
findtime = 600
bantime = 7200
EOF

echo -e "${GREEN}✓ تم إنشاء ملف الإعدادات${NC}\n"

# 3. إنشاء فلاتر إضافية لـ Nginx
echo -e "${YELLOW}[3/4] إنشاء فلاتر Nginx...${NC}"

# فلتر nginx-noscript
sudo tee /etc/fail2ban/filter.d/nginx-noscript.conf > /dev/null <<'EOF'
[Definition]
failregex = ^<HOST> -.*GET.*(\.php|\.asp|\.exe|\.pl|\.cgi|\.scgi)
ignoreregex =
EOF

# فلتر nginx-badbots
sudo tee /etc/fail2ban/filter.d/nginx-badbots.conf > /dev/null <<'EOF'
[Definition]
badbots = EmailCollector|WebEMailExtrac|TrackBack/1\.02|sogou music spider
failregex = ^<HOST> -.*"(GET|POST).*HTTP.*"(?:%(badbots)s)"$
ignoreregex =
EOF

# فلتر nginx-noproxy
sudo tee /etc/fail2ban/filter.d/nginx-noproxy.conf > /dev/null <<'EOF'
[Definition]
failregex = ^<HOST> -.*GET http.*
ignoreregex =
EOF

# فلتر nginx-limit-req
sudo tee /etc/fail2ban/filter.d/nginx-limit-req.conf > /dev/null <<'EOF'
[Definition]
failregex = limiting requests, excess:.* by zone.*client: <HOST>
ignoreregex =
EOF

echo -e "${GREEN}✓ تم إنشاء الفلاتر${NC}\n"

# 4. تفعيل وتشغيل Fail2Ban
echo -e "${YELLOW}[4/4] تفعيل Fail2Ban...${NC}"
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban

echo -e "${GREEN}✓ تم تشغيل Fail2Ban${NC}\n"

# طباعة الملخص
echo -e "${GREEN}==================================${NC}"
echo -e "${GREEN}✓ تم تثبيت Fail2Ban بنجاح!${NC}"
echo -e "${GREEN}==================================${NC}\n"

echo -e "${YELLOW}الإعدادات الحالية:${NC}"
echo -e "- عدد المحاولات الفاشلة: ${GREEN}3${NC}"
echo -e "- مدة الحظر: ${GREEN}1 ساعة${NC}"
echo -e "- بورت SSH المحمي: ${GREEN}${SSH_PORT}${NC}"
echo ""

echo -e "${YELLOW}أوامر مفيدة:${NC}"
echo -e "- حالة Fail2Ban: ${GREEN}sudo fail2ban-client status${NC}"
echo -e "- حالة SSH jail: ${GREEN}sudo fail2ban-client status sshd${NC}"
echo -e "- IPs المحظورة: ${GREEN}sudo fail2ban-client status sshd | grep 'Banned IP'${NC}"
echo -e "- إلغاء حظر IP: ${GREEN}sudo fail2ban-client set sshd unbanip IP_ADDRESS${NC}"
echo -e "- إعادة تحميل الإعدادات: ${GREEN}sudo fail2ban-client reload${NC}"
echo ""
