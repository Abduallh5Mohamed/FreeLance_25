#!/bin/bash

# ============================================
# Nginx Security Setup - تطبيق إعدادات الأمان
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== تأمين Nginx ===${NC}\n"

# 1. التحقق من وجود Nginx
echo -e "${YELLOW}[1/6] التحقق من Nginx...${NC}"
if ! command -v nginx &> /dev/null; then
    echo -e "${RED}✗ Nginx غير مثبت${NC}"
    echo -e "${YELLOW}جاري التثبيت...${NC}"
    sudo apt update
    sudo apt install -y nginx
fi
echo -e "${GREEN}✓ Nginx موجود${NC}\n"

# 2. أخذ نسخة احتياطية
echo -e "${YELLOW}[2/6] أخذ نسخة احتياطية...${NC}"
BACKUP_DIR="/etc/nginx/backup_$(date +%F-%H%M%S)"
sudo mkdir -p $BACKUP_DIR
sudo cp -r /etc/nginx/conf.d $BACKUP_DIR/ 2>/dev/null || true
sudo cp -r /etc/nginx/sites-available $BACKUP_DIR/ 2>/dev/null || true
echo -e "${GREEN}✓ النسخة الاحتياطية في: $BACKUP_DIR${NC}\n"

# 3. نسخ ملفات الأمان
echo -e "${YELLOW}[3/6] تطبيق إعدادات الأمان...${NC}"

# إنشاء مجلد snippets إذا لم يكن موجوداً
sudo mkdir -p /etc/nginx/snippets
sudo mkdir -p /etc/nginx/conf.d

# نسخ ملف الأمان الرئيسي
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/nginx-security.conf" ]; then
    sudo cp "$SCRIPT_DIR/nginx-security.conf" /etc/nginx/conf.d/security.conf
    echo -e "${GREEN}✓ تم نسخ security.conf${NC}"
else
    echo -e "${RED}✗ ملف nginx-security.conf غير موجود${NC}"
fi

if [ -f "$SCRIPT_DIR/nginx-ssl-params.conf" ]; then
    sudo cp "$SCRIPT_DIR/nginx-ssl-params.conf" /etc/nginx/snippets/ssl-params.conf
    echo -e "${GREEN}✓ تم نسخ ssl-params.conf${NC}"
else
    echo -e "${RED}✗ ملف nginx-ssl-params.conf غير موجود${NC}"
fi

echo ""

# 4. إنشاء DH Parameters (يأخذ وقت)
echo -e "${YELLOW}[4/6] إنشاء DH Parameters...${NC}"
if [ ! -f /etc/nginx/dhparam.pem ]; then
    echo -e "${YELLOW}⏳ جاري الإنشاء (قد يأخذ 2-5 دقائق)...${NC}"
    sudo openssl dhparam -out /etc/nginx/dhparam.pem 2048
    echo -e "${GREEN}✓ تم إنشاء dhparam.pem${NC}"
else
    echo -e "${GREEN}✓ dhparam.pem موجود بالفعل${NC}"
fi
echo ""

# 5. اختبار الإعدادات
echo -e "${YELLOW}[5/6] اختبار إعدادات Nginx...${NC}"
if sudo nginx -t; then
    echo -e "${GREEN}✓ الإعدادات صحيحة${NC}\n"
else
    echo -e "${RED}✗ خطأ في الإعدادات! سيتم استرجاع النسخة الاحتياطية${NC}"
    sudo cp -r $BACKUP_DIR/* /etc/nginx/
    exit 1
fi

# 6. إعادة تحميل Nginx
echo -e "${YELLOW}[6/6] إعادة تحميل Nginx...${NC}"
sudo systemctl reload nginx
echo -e "${GREEN}✓ تم إعادة تحميل Nginx${NC}\n"

# طباعة الملخص
echo -e "${GREEN}==================================${NC}"
echo -e "${GREEN}✓ تم تأمين Nginx بنجاح!${NC}"
echo -e "${GREEN}==================================${NC}\n"

echo -e "${YELLOW}الإعدادات المطبقة:${NC}"
echo -e "✓ إخفاء معلومات السيرفر"
echo -e "✓ Security Headers (XSS, Clickjacking, etc.)"
echo -e "✓ Rate Limiting"
echo -e "✓ حماية من DDoS"
echo -e "✓ منع الوصول للملفات الحساسة"
echo -e "✓ حظر User Agents المشبوهة"
echo -e "✓ إعدادات SSL آمنة"
echo ""

echo -e "${YELLOW}لإضافة Rate Limiting لصفحة معينة، أضف في server block:${NC}"
echo -e "${GREEN}location /api/ {${NC}"
echo -e "${GREEN}    limit_req zone=api_limit burst=20 nodelay;${NC}"
echo -e "${GREEN}    ...${NC}"
echo -e "${GREEN}}${NC}"
echo ""

echo -e "${YELLOW}لإضافة SSL params، أضف في server block:${NC}"
echo -e "${GREEN}include snippets/ssl-params.conf;${NC}"
echo ""

echo -e "${YELLOW}اختبار Security Headers:${NC}"
echo -e "${GREEN}curl -I https://yourdomain.com${NC}"
echo ""
