#!/bin/bash

# ============================================
# SSH Hardening Script - تأمين SSH بالكامل
# ============================================
# يجب تشغيله بصلاحيات root على السيرفر
# sudo bash ssh-hardening.sh

set -e

# ألوان للطباعة
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== بدء تأمين SSH ===${NC}\n"

# 1. أخذ نسخة احتياطية من ملف SSH
echo -e "${YELLOW}[1/6] أخذ نسخة احتياطية من sshd_config...${NC}"
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup.$(date +%F-%H%M%S)
echo -e "${GREEN}✓ تم حفظ النسخة الاحتياطية${NC}\n"

# 2. تغيير بورت SSH (اختر رقم عشوائي بين 10000-65000)
NEW_SSH_PORT=$(shuf -i 10000-65000 -n 1)
echo -e "${YELLOW}[2/6] تغيير بورت SSH...${NC}"
echo -e "${GREEN}البورت الجديد: ${NEW_SSH_PORT}${NC}"
sudo sed -i "s/^#Port 22/Port ${NEW_SSH_PORT}/" /etc/ssh/sshd_config
sudo sed -i "s/^Port 22/Port ${NEW_SSH_PORT}/" /etc/ssh/sshd_config

# حفظ البورت في ملف للرجوع إليه
echo "${NEW_SSH_PORT}" > ~/ssh_new_port.txt
echo -e "${RED}⚠️  احفظ البورت ده في مكان آمن: ${NEW_SSH_PORT}${NC}\n"

# 3. تعطيل تسجيل الدخول بالباسورد (بعد إعداد SSH Keys)
echo -e "${YELLOW}[3/6] تأمين إعدادات SSH...${NC}"

# تعطيل Root Login
sudo sed -i 's/^#PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config

# تعطيل Empty Passwords
sudo sed -i 's/^#PermitEmptyPasswords no/PermitEmptyPasswords no/' /etc/ssh/sshd_config
sudo sed -i 's/^PermitEmptyPasswords yes/PermitEmptyPasswords no/' /etc/ssh/sshd_config

# تفعيل Public Key Authentication
sudo sed -i 's/^#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# تعطيل Password Authentication (هيتشغل بعد إضافة SSH Key)
# ⚠️ لا تفعل هذا السطر إلا بعد التأكد من إضافة SSH Key
# sudo sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
# sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config

# تقليل وقت الجلسة الخاملة
echo "ClientAliveInterval 300" | sudo tee -a /etc/ssh/sshd_config > /dev/null
echo "ClientAliveCountMax 2" | sudo tee -a /etc/ssh/sshd_config > /dev/null

echo -e "${GREEN}✓ تم تأمين الإعدادات${NC}\n"

# 4. إنشاء SSH Key للمستخدم الحالي
echo -e "${YELLOW}[4/6] إنشاء SSH Key...${NC}"
CURRENT_USER=$(whoami)

if [ ! -f ~/.ssh/id_rsa ]; then
    ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N "" -C "server-secure-key"
    echo -e "${GREEN}✓ تم إنشاء SSH Key${NC}"
else
    echo -e "${GREEN}✓ SSH Key موجود بالفعل${NC}"
fi

# التأكد من وجود مجلد .ssh بالصلاحيات الصحيحة
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

echo -e "${GREEN}المفتاح العام (Public Key):${NC}"
cat ~/.ssh/id_rsa.pub
echo ""
echo -e "${YELLOW}⚠️  انسخ المفتاح العام ده واحفظه في جهازك${NC}\n"

# 5. اختبار صحة الإعدادات
echo -e "${YELLOW}[5/6] اختبار صحة إعدادات SSH...${NC}"
if sudo sshd -t; then
    echo -e "${GREEN}✓ الإعدادات صحيحة${NC}\n"
else
    echo -e "${RED}✗ خطأ في الإعدادات! سيتم استرجاع النسخة الاحتياطية${NC}"
    sudo cp /etc/ssh/sshd_config.backup.* /etc/ssh/sshd_config
    exit 1
fi

# 6. إعادة تشغيل SSH
echo -e "${YELLOW}[6/6] إعادة تشغيل خدمة SSH...${NC}"
sudo systemctl restart sshd

echo -e "${GREEN}✓ تم إعادة تشغيل SSH بنجاح${NC}\n"

# طباعة الخطوات التالية
echo -e "${GREEN}==================================${NC}"
echo -e "${GREEN}✓ تم تأمين SSH بنجاح!${NC}"
echo -e "${GREEN}==================================${NC}\n"

echo -e "${YELLOW}الخطوات التالية المهمة:${NC}"
echo -e "1. البورت الجديد: ${GREEN}${NEW_SSH_PORT}${NC} (محفوظ في ~/ssh_new_port.txt)"
echo -e "2. استخدم الأمر ده للاتصال من جهازك:"
echo -e "   ${GREEN}ssh -p ${NEW_SSH_PORT} ${CURRENT_USER}@YOUR_SERVER_IP${NC}"
echo -e ""
echo -e "3. انسخ المفتاح الخاص (Private Key) لجهازك:"
echo -e "   ${GREEN}cat ~/.ssh/id_rsa${NC}"
echo -e ""
echo -e "4. في جهازك، احفظ المفتاح في ملف واستخدمه:"
echo -e "   ${GREEN}ssh -i path/to/private_key -p ${NEW_SSH_PORT} ${CURRENT_USER}@YOUR_SERVER_IP${NC}"
echo -e ""
echo -e "${RED}⚠️  ملحوظة مهمة جداً:${NC}"
echo -e "   - لا تقفل الجلسة الحالية قبل اختبار الاتصال من جلسة جديدة"
echo -e "   - لو حصل مشكلة، ارجع الملف الأصلي من:"
echo -e "     ${GREEN}sudo cp /etc/ssh/sshd_config.backup.* /etc/ssh/sshd_config${NC}"
echo -e ""
echo -e "${YELLOW}⚡ بعد التأكد من نجاح الاتصال، فعل تعطيل Password Authentication:${NC}"
echo -e "   ${GREEN}sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config${NC}"
echo -e "   ${GREEN}sudo systemctl restart sshd${NC}"
echo ""
