#!/bin/bash

# ============================================
# Auto Updates Setup - تفعيل التحديثات التلقائية
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== إعداد التحديثات التلقائية ===${NC}\n"

# 1. تثبيت unattended-upgrades
echo -e "${YELLOW}[1/3] تثبيت unattended-upgrades...${NC}"
sudo apt update
sudo apt install -y unattended-upgrades apt-listchanges

echo -e "${GREEN}✓ تم تثبيت unattended-upgrades${NC}\n"

# 2. إعداد الإعدادات
echo -e "${YELLOW}[2/3] إعداد الإعدادات...${NC}"

# أخذ نسخة احتياطية
sudo cp /etc/apt/apt.conf.d/50unattended-upgrades /etc/apt/apt.conf.d/50unattended-upgrades.backup 2>/dev/null || true

# إنشاء ملف الإعدادات
sudo tee /etc/apt/apt.conf.d/50unattended-upgrades > /dev/null <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

Unattended-Upgrade::DevRelease "false";

// تنظيف الباكجات القديمة تلقائياً
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";

// إعادة التشغيل التلقائي إذا لزم الأمر (الساعة 3 فجراً)
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";

// تنبيهات
Unattended-Upgrade::Mail "root";
Unattended-Upgrade::MailReport "on-change";

// Logging
Unattended-Upgrade::SyslogEnable "true";
Unattended-Upgrade::SyslogFacility "daemon";
EOF

echo -e "${GREEN}✓ تم إعداد الإعدادات${NC}\n"

# 3. تفعيل التحديثات التلقائية
echo -e "${YELLOW}[3/3] تفعيل التحديثات التلقائية...${NC}"

sudo tee /etc/apt/apt.conf.d/20auto-upgrades > /dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo -e "${GREEN}✓ تم تفعيل التحديثات التلقائية${NC}\n"

# اختبار الإعدادات
echo -e "${YELLOW}اختبار الإعدادات...${NC}"
sudo unattended-upgrades --dry-run --debug

# طباعة الملخص
echo -e "\n${GREEN}==================================${NC}"
echo -e "${GREEN}✓ تم تفعيل التحديثات التلقائية!${NC}"
echo -e "${GREEN}==================================${NC}\n"

echo -e "${YELLOW}الإعدادات المطبقة:${NC}"
echo -e "✓ تحديث تلقائي يومي لتحديثات الأمان"
echo -e "✓ تنظيف الباكجات القديمة تلقائياً"
echo -e "✓ إعادة تشغيل تلقائية عند الحاجة (الساعة 3 فجراً)"
echo ""

echo -e "${YELLOW}أوامر مفيدة:${NC}"
echo -e "- تشغيل يدوي: ${GREEN}sudo unattended-upgrades${NC}"
echo -e "- اختبار: ${GREEN}sudo unattended-upgrades --dry-run${NC}"
echo -e "- السجلات: ${GREEN}cat /var/log/unattended-upgrades/unattended-upgrades.log${NC}"
echo -e "- حالة الخدمة: ${GREEN}systemctl status unattended-upgrades${NC}"
echo ""

echo -e "${YELLOW}⚠️  ملحوظة: السيرفر قد يعيد التشغيل تلقائياً الساعة 3 فجراً${NC}"
echo -e "${YELLOW}إذا أردت تغيير الوقت، عدل: /etc/apt/apt.conf.d/50unattended-upgrades${NC}"
echo ""
