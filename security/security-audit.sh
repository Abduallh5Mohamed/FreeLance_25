#!/bin/bash

# ============================================
# Security Audit Script - فحص الثغرات والملفات المشبوهة
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REPORT_FILE="security_audit_$(date +%F-%H%M%S).txt"

echo -e "${GREEN}=== فحص أمني شامل للسيرفر ===${NC}\n"
echo "Security Audit Report - $(date)" > $REPORT_FILE
echo "========================================" >> $REPORT_FILE
echo "" >> $REPORT_FILE

# 1. البحث عن Backdoors وملفات PHP المشبوهة
echo -e "${YELLOW}[1/8] البحث عن Backdoors وWeb Shells...${NC}"
echo "1. Backdoors and Web Shells Search" >> $REPORT_FILE
echo "-----------------------------------" >> $REPORT_FILE

# البحث عن دوال PHP الخطيرة
echo "الدوال الخطيرة المستخدمة:" >> $REPORT_FILE
if [ -d /var/www ]; then
    grep -r -n -i "eval\|base64_decode\|gzinflate\|str_rot13\|system\|exec\|shell_exec\|passthru\|proc_open" /var/www --include="*.php" 2>/dev/null | head -50 >> $REPORT_FILE || echo "لم يتم العثور على دوال خطيرة" >> $REPORT_FILE
fi
echo "" >> $REPORT_FILE

# البحث عن ملفات تم تعديلها مؤخراً
echo -e "${YELLOW}[2/8] البحث عن ملفات تم تعديلها في آخر 7 أيام...${NC}"
echo "2. Recently Modified Files (Last 7 days)" >> $REPORT_FILE
echo "----------------------------------------" >> $REPORT_FILE
if [ -d /var/www ]; then
    find /var/www -type f -mtime -7 -ls 2>/dev/null | head -30 >> $REPORT_FILE || echo "لم يتم العثور على ملفات" >> $REPORT_FILE
fi
echo "" >> $REPORT_FILE

# 3. البحث عن ملفات ذات صلاحيات مشبوهة
echo -e "${YELLOW}[3/8] البحث عن ملفات بصلاحيات 777...${NC}"
echo "3. Files with 777 Permissions" >> $REPORT_FILE
echo "-----------------------------" >> $REPORT_FILE
if [ -d /var/www ]; then
    find /var/www -type f -perm 0777 2>/dev/null | head -20 >> $REPORT_FILE || echo "لم يتم العثور على ملفات" >> $REPORT_FILE
fi
echo "" >> $REPORT_FILE

# 4. فحص العمليات الجارية
echo -e "${YELLOW}[4/8] فحص العمليات المشبوهة...${NC}"
echo "4. Suspicious Processes" >> $REPORT_FILE
echo "----------------------" >> $REPORT_FILE
ps aux | grep -E "nc|ncat|perl|python.*socket|bash.*dev.*tcp" | grep -v grep >> $REPORT_FILE || echo "لم يتم العثور على عمليات مشبوهة" >> $REPORT_FILE
echo "" >> $REPORT_FILE

# 5. فحص Cron Jobs
echo -e "${YELLOW}[5/8] فحص Cron Jobs...${NC}"
echo "5. Cron Jobs" >> $REPORT_FILE
echo "------------" >> $REPORT_FILE
for user in $(cut -f1 -d: /etc/passwd); do
    crontab -u $user -l 2>/dev/null | grep -v "^#" >> $REPORT_FILE || true
done
echo "" >> $REPORT_FILE

# 6. فحص الاتصالات النشطة
echo -e "${YELLOW}[6/8] فحص الاتصالات النشطة...${NC}"
echo "6. Active Network Connections" >> $REPORT_FILE
echo "-----------------------------" >> $REPORT_FILE
ss -tunap | grep ESTABLISHED >> $REPORT_FILE || echo "لا توجد اتصالات" >> $REPORT_FILE
echo "" >> $REPORT_FILE

# 7. فحص آخر تسجيلات الدخول
echo -e "${YELLOW}[7/8] فحص آخر محاولات الدخول...${NC}"
echo "7. Recent Login Attempts" >> $REPORT_FILE
echo "------------------------" >> $REPORT_FILE
last -20 >> $REPORT_FILE
echo "" >> $REPORT_FILE

# فحص محاولات الدخول الفاشلة
echo "Failed Login Attempts:" >> $REPORT_FILE
lastb -20 >> $REPORT_FILE 2>/dev/null || echo "لا توجد محاولات فاشلة" >> $REPORT_FILE
echo "" >> $REPORT_FILE

# 8. فحص Users المشبوهين
echo -e "${YELLOW}[8/8] فحص Users...${NC}"
echo "8. System Users Check" >> $REPORT_FILE
echo "---------------------" >> $REPORT_FILE
echo "Users with UID 0 (should only be root):" >> $REPORT_FILE
awk -F: '($3 == "0") {print}' /etc/passwd >> $REPORT_FILE
echo "" >> $REPORT_FILE

echo "Users with shell access:" >> $REPORT_FILE
grep -v "nologin\|false" /etc/passwd >> $REPORT_FILE
echo "" >> $REPORT_FILE

# ========== إضافات مهمة ==========

# فحص ملفات .env
echo -e "${YELLOW}فحص إضافي: ملفات .env في مكان عام...${NC}"
echo "9. Public .env Files (CRITICAL)" >> $REPORT_FILE
echo "-------------------------------" >> $REPORT_FILE
if [ -d /var/www ]; then
    find /var/www -name ".env" -type f 2>/dev/null >> $REPORT_FILE || echo "لم يتم العثور على ملفات .env" >> $REPORT_FILE
fi
echo "" >> $REPORT_FILE

# فحص ملفات SQL dumps
echo -e "${YELLOW}فحص إضافي: ملفات SQL في مكان عام...${NC}"
echo "10. Public SQL Files" >> $REPORT_FILE
echo "-------------------" >> $REPORT_FILE
if [ -d /var/www ]; then
    find /var/www -name "*.sql" -type f 2>/dev/null | head -10 >> $REPORT_FILE || echo "لم يتم العثور على ملفات SQL" >> $REPORT_FILE
fi
echo "" >> $REPORT_FILE

# طباعة الملخص
echo -e "\n${GREEN}==================================${NC}"
echo -e "${GREEN}✓ اكتمل الفحص الأمني!${NC}"
echo -e "${GREEN}==================================${NC}\n"

echo -e "${YELLOW}التقرير محفوظ في: ${GREEN}$REPORT_FILE${NC}"
echo -e "${YELLOW}اقرأ التقرير بعناية وابحث عن أي نشاط مشبوه${NC}\n"

echo -e "${YELLOW}أوامر مفيدة للفحص اليدوي:${NC}"
echo -e "- فحص logs الويب: ${GREEN}tail -100 /var/log/nginx/access.log${NC}"
echo -e "- فحص logs الأخطاء: ${GREEN}tail -100 /var/log/nginx/error.log${NC}"
echo -e "- فحص auth logs: ${GREEN}tail -100 /var/log/auth.log${NC}"
echo -e "- فحص syslog: ${GREEN}tail -100 /var/log/syslog${NC}"
echo ""

# فحص وجود rkhunter
if ! command -v rkhunter &> /dev/null; then
    echo -e "${YELLOW}💡 نصيحة: ثبت rkhunter لفحص أعمق:${NC}"
    echo -e "   ${GREEN}sudo apt install rkhunter${NC}"
    echo -e "   ${GREEN}sudo rkhunter --check${NC}"
    echo ""
fi

# فحص وجود ClamAV
if ! command -v clamscan &> /dev/null; then
    echo -e "${YELLOW}💡 نصيحة: ثبت ClamAV لفحص الفيروسات:${NC}"
    echo -e "   ${GREEN}sudo apt install clamav clamav-daemon${NC}"
    echo -e "   ${GREEN}sudo freshclam${NC}"
    echo -e "   ${GREEN}sudo clamscan -r /var/www${NC}"
    echo ""
fi

echo -e "${RED}⚠️  راجع التقرير وابحث عن:${NC}"
echo -e "   - دوال PHP خطيرة (eval, base64_decode)"
echo -e "   - ملفات تم تعديلها مؤخراً في أماكن غير متوقعة"
echo -e "   - عمليات (processes) غير معروفة"
echo -e "   - cron jobs مشبوهة"
echo -e "   - users جدد لم تنشئهم"
echo -e "   - ملفات .env أو .sql في مجلدات عامة"
echo ""
