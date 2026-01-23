#!/bin/bash

# ============================================
# UFW Firewall Setup - جدار حماية قوي
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== إعداد جدار الحماية UFW ===${NC}\n"

# 1. تثبيت UFW
echo -e "${YELLOW}[1/5] تثبيت UFW...${NC}"
sudo apt update
sudo apt install -y ufw

echo -e "${GREEN}✓ تم تثبيت UFW${NC}\n"

# 2. إعداد القواعد الافتراضية
echo -e "${YELLOW}[2/5] إعداد القواعد الافتراضية...${NC}"
sudo ufw default deny incoming
sudo ufw default allow outgoing

echo -e "${GREEN}✓ تم إعداد القواعد الافتراضية${NC}\n"

# 3. فتح البوربات الضرورية
echo -e "${YELLOW}[3/5] فتح البوربات الضرورية...${NC}"

# HTTP & HTTPS
sudo ufw allow 80/tcp comment 'Allow HTTP'
sudo ufw allow 443/tcp comment 'Allow HTTPS'
echo -e "${GREEN}✓ تم فتح بورت 80 (HTTP) و 443 (HTTPS)${NC}"

# SSH - الحصول على البورت الجديد
SSH_PORT=22
if [ -f ~/ssh_new_port.txt ]; then
    SSH_PORT=$(cat ~/ssh_new_port.txt)
fi

# ⚠️ تحذير قبل فتح بورت SSH الجديد
echo -e "${RED}⚠️  سيتم فتح بورت SSH: ${SSH_PORT}${NC}"
echo -e "${YELLOW}تأكد إنك حفظت البورت ده عشان تقدر تدخل السيرفر${NC}"
read -p "اضغط Enter للمتابعة..."

sudo ufw allow ${SSH_PORT}/tcp comment 'Allow SSH'
echo -e "${GREEN}✓ تم فتح بورت SSH: ${SSH_PORT}${NC}\n"

# 4. تفعيل الحماية من DDoS
echo -e "${YELLOW}[4/5] تفعيل الحماية من DDoS...${NC}"

# تحديد معدل الاتصالات لمنع DDoS
sudo ufw limit ${SSH_PORT}/tcp comment 'Rate limit SSH'

echo -e "${GREEN}✓ تم تفعيل Rate Limiting على SSH${NC}\n"

# 5. تفعيل الجدار الناري
echo -e "${YELLOW}[5/5] تفعيل UFW...${NC}"
echo -e "${RED}⚠️  سيتم تفعيل الجدار الناري الآن${NC}"
echo -e "${YELLOW}تأكد من البوربات المفتوحة:${NC}"
sudo ufw show added
echo ""
read -p "اضغط Enter لتفعيل الجدار الناري..."

echo "y" | sudo ufw enable

echo -e "${GREEN}✓ تم تفعيل UFW${NC}\n"

# طباعة الملخص
echo -e "${GREEN}==================================${NC}"
echo -e "${GREEN}✓ تم إعداد الجدار الناري بنجاح!${NC}"
echo -e "${GREEN}==================================${NC}\n"

echo -e "${YELLOW}البوربات المفتوحة:${NC}"
sudo ufw status numbered

echo ""
echo -e "${YELLOW}أوامر مفيدة:${NC}"
echo -e "- حالة الجدار: ${GREEN}sudo ufw status verbose${NC}"
echo -e "- فتح بورت جديد: ${GREEN}sudo ufw allow PORT_NUMBER/tcp${NC}"
echo -e "- حذف قاعدة: ${GREEN}sudo ufw delete RULE_NUMBER${NC}"
echo -e "- تعطيل الجدار: ${GREEN}sudo ufw disable${NC}"
echo -e "- إعادة تحميل: ${GREEN}sudo ufw reload${NC}"
echo ""

# حفظ قائمة البوربات
echo -e "${YELLOW}قائمة البوربات المفتوحة محفوظة في: ~/ufw_ports.txt${NC}"
sudo ufw status numbered > ~/ufw_ports.txt
