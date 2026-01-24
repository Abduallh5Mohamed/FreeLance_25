#!/bin/bash

# ============================================
# Master Security Setup - تطبيق كل شيء مرة واحدة
# ============================================
# ⚠️ تحذير: هذا السكريبت سيطبق كل إعدادات الأمان
# تأكد من أخذ Snapshot للسيرفر قبل التشغيل

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

clear

echo -e "${BLUE}"
cat << "EOF"
╔═══════════════════════════════════════════════╗
║   🔒 Master Security Setup                   ║
║   تأمين السيرفر الشامل - كل شيء مرة واحدة  ║
╚═══════════════════════════════════════════════╝
EOF
echo -e "${NC}\n"

echo -e "${RED}⚠️  تحذير مهم:${NC}"
echo -e "هذا السكريبت سيطبق كل إعدادات الأمان التالية:"
echo -e "  1. تأمين SSH (تغيير البورت وإنشاء Keys)"
echo -e "  2. Fail2Ban (حماية من Brute Force)"
echo -e "  3. UFW Firewall (جدار الحماية)"
echo -e "  4. Nginx Security (Security Headers + Rate Limiting)"
echo -e "  5. Auto Updates (التحديثات التلقائية)"
echo -e "  6. Security Audit (فحص الثغرات)\n"

echo -e "${YELLOW}هل أخذت Snapshot (نسخة احتياطية) من السيرفر؟${NC}"
read -p "اكتب 'yes' للمتابعة: " confirm

if [ "$confirm" != "yes" ]; then
    echo -e "${RED}إلغاء العملية. خذ Snapshot أولاً!${NC}"
    exit 1
fi

echo -e "\n${GREEN}بدء التطبيق...${NC}\n"
sleep 2

# ========== 1. SSH Hardening ==========
echo -e "${BLUE}▶ [1/6] تأمين SSH...${NC}"
if [ -f "./ssh-hardening.sh" ]; then
    bash ./ssh-hardening.sh
    echo -e "${GREEN}✓ تم تأمين SSH${NC}\n"
else
    echo -e "${RED}✗ ملف ssh-hardening.sh غير موجود${NC}\n"
fi
sleep 2

# ========== 2. Fail2Ban ==========
echo -e "${BLUE}▶ [2/6] تثبيت Fail2Ban...${NC}"
if [ -f "./fail2ban-setup.sh" ]; then
    bash ./fail2ban-setup.sh
    echo -e "${GREEN}✓ تم تثبيت Fail2Ban${NC}\n"
else
    echo -e "${RED}✗ ملف fail2ban-setup.sh غير موجود${NC}\n"
fi
sleep 2

# ========== 3. UFW Firewall ==========
echo -e "${BLUE}▶ [3/6] إعداد جدار الحماية...${NC}"
if [ -f "./firewall-setup.sh" ]; then
    bash ./firewall-setup.sh
    echo -e "${GREEN}✓ تم إعداد UFW${NC}\n"
else
    echo -e "${RED}✗ ملف firewall-setup.sh غير موجود${NC}\n"
fi
sleep 2

# ========== 4. Nginx Security ==========
echo -e "${BLUE}▶ [4/6] تأمين Nginx...${NC}"
if [ -f "./nginx-security-setup.sh" ]; then
    bash ./nginx-security-setup.sh
    echo -e "${GREEN}✓ تم تأمين Nginx${NC}\n"
else
    echo -e "${RED}✗ ملف nginx-security-setup.sh غير موجود${NC}\n"
fi
sleep 2

# ========== 5. Auto Updates ==========
echo -e "${BLUE}▶ [5/6] إعداد التحديثات التلقائية...${NC}"
if [ -f "./auto-updates-setup.sh" ]; then
    bash ./auto-updates-setup.sh
    echo -e "${GREEN}✓ تم إعداد التحديثات التلقائية${NC}\n"
else
    echo -e "${RED}✗ ملف auto-updates-setup.sh غير موجود${NC}\n"
fi
sleep 2

# ========== 6. Security Audit ==========
echo -e "${BLUE}▶ [6/6] فحص الثغرات...${NC}"
if [ -f "./security-audit.sh" ]; then
    bash ./security-audit.sh
    echo -e "${GREEN}✓ تم فحص الثغرات${NC}\n"
else
    echo -e "${RED}✗ ملف security-audit.sh غير موجود${NC}\n"
fi

# ========== الملخص النهائي ==========
clear
echo -e "${GREEN}"
cat << "EOF"
╔═══════════════════════════════════════════════╗
║   ✅ اكتمل التأمين بنجاح!                   ║
╚═══════════════════════════════════════════════╝
EOF
echo -e "${NC}\n"

echo -e "${YELLOW}═══════════════════════════════════════${NC}"
echo -e "${GREEN}✓ تم تطبيق كل إعدادات الأمان بنجاح!${NC}"
echo -e "${YELLOW}═══════════════════════════════════════${NC}\n"

echo -e "${BLUE}المعلومات المهمة:${NC}\n"

# البورت الجديد
if [ -f ~/ssh_new_port.txt ]; then
    SSH_PORT=$(cat ~/ssh_new_port.txt)
    echo -e "🔑 ${YELLOW}بورت SSH الجديد:${NC} ${GREEN}${SSH_PORT}${NC}"
    echo -e "   للاتصال: ${GREEN}ssh -p ${SSH_PORT} $(whoami)@YOUR_SERVER_IP${NC}\n"
else
    echo -e "${RED}⚠️  لم يتم العثور على بورت SSH الجديد${NC}\n"
fi

# الملفات المهمة
echo -e "📁 ${YELLOW}الملفات المهمة:${NC}"
echo -e "   - بورت SSH: ${GREEN}~/ssh_new_port.txt${NC}"
echo -e "   - المفتاح الخاص: ${GREEN}~/.ssh/id_rsa${NC}"
echo -e "   - المفتاح العام: ${GREEN}~/.ssh/id_rsa.pub${NC}"
echo -e "   - تقرير الأمان: ${GREEN}security_audit_*.txt${NC}\n"

# الخدمات
echo -e "🔧 ${YELLOW}حالة الخدمات:${NC}"
echo -e "   - SSH: ${GREEN}$(systemctl is-active sshd)${NC}"
echo -e "   - Fail2Ban: ${GREEN}$(systemctl is-active fail2ban)${NC}"
echo -e "   - UFW: ${GREEN}$(systemctl is-active ufw)${NC}"
echo -e "   - Nginx: ${GREEN}$(systemctl is-active nginx)${NC}\n"

# الخطوات التالية
echo -e "${YELLOW}═══════════════════════════════════════${NC}"
echo -e "${RED}⚠️  خطوات مهمة جداً - لا تتجاهلها:${NC}"
echo -e "${YELLOW}═══════════════════════════════════════${NC}\n"

echo -e "${YELLOW}1. اختبر الاتصال من terminal جديد:${NC}"
if [ -f ~/ssh_new_port.txt ]; then
    echo -e "   ${GREEN}ssh -p ${SSH_PORT} $(whoami)@YOUR_SERVER_IP${NC}\n"
fi

echo -e "${YELLOW}2. احفظ المفتاح الخاص في جهازك:${NC}"
echo -e "   ${GREEN}cat ~/.ssh/id_rsa${NC}"
echo -e "   انسخه واحفظه في ملف على جهازك\n"

echo -e "${YELLOW}3. بعد التأكد من الاتصال، فعل تعطيل Password:${NC}"
echo -e "   ${GREEN}sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config${NC}"
echo -e "   ${GREEN}sudo systemctl restart sshd${NC}\n"

echo -e "${YELLOW}4. اربط موقعك بـ Cloudflare:${NC}"
echo -e "   - سجل في https://cloudflare.com"
echo -e "   - أضف موقعك وغير الـ Nameservers\n"

echo -e "${YELLOW}5. اقرأ تقرير الأمان:${NC}"
echo -e "   ${GREEN}cat security_audit_*.txt${NC}\n"

echo -e "${YELLOW}6. اعمل فحص دوري كل أسبوع:${NC}"
echo -e "   ${GREEN}bash security-audit.sh${NC}\n"

# الأوامر المفيدة
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}أوامر مفيدة:${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}\n"

echo -e "• حالة Fail2Ban: ${GREEN}sudo fail2ban-client status${NC}"
echo -e "• حالة UFW: ${GREEN}sudo ufw status${NC}"
echo -e "• IPs المحظورة: ${GREEN}sudo fail2ban-client status sshd${NC}"
echo -e "• فحص Nginx: ${GREEN}sudo nginx -t${NC}"
echo -e "• Logs: ${GREEN}sudo tail -f /var/log/auth.log${NC}\n"

echo -e "${GREEN}✅ السيرفر الآن محمي بشكل جيد!${NC}"
echo -e "${YELLOW}استمر في المراقبة والفحص الدوري${NC}\n"

# حفظ الملخص
SUMMARY_FILE="security_setup_summary_$(date +%F-%H%M%S).txt"
{
    echo "Security Setup Summary"
    echo "======================"
    echo "Date: $(date)"
    echo ""
    echo "SSH Port: $(cat ~/ssh_new_port.txt 2>/dev/null || echo 'N/A')"
    echo "User: $(whoami)"
    echo ""
    echo "Services Status:"
    echo "- SSH: $(systemctl is-active sshd)"
    echo "- Fail2Ban: $(systemctl is-active fail2ban)"
    echo "- UFW: $(systemctl is-active ufw)"
    echo "- Nginx: $(systemctl is-active nginx)"
    echo ""
    echo "Important Files:"
    echo "- SSH Port: ~/ssh_new_port.txt"
    echo "- Private Key: ~/.ssh/id_rsa"
    echo "- Public Key: ~/.ssh/id_rsa.pub"
    echo ""
} > $SUMMARY_FILE

echo -e "${GREEN}الملخص محفوظ في: ${SUMMARY_FILE}${NC}\n"
