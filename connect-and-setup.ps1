# ============================================
# Connect to Server and Run Setup
# الاتصال بالسيرفر وتشغيل التأمين
# ============================================

$SERVER_IP = "72.62.35.177"

Write-Host "================================" -ForegroundColor Green
Write-Host "  الاتصال بالسيرفر وتشغيل Setup" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""

# طلب اسم المستخدم
$USERNAME = Read-Host "أدخل اسم المستخدم (مثلاً: root أو ubuntu)"

# طلب البورت
$PORT = Read-Host "أدخل بورت SSH (اضغط Enter للاستخدام 22)"
if ([string]::IsNullOrWhiteSpace($PORT)) {
    $PORT = "22"
}

Write-Host ""
Write-Host "الاتصال بـ: ${USERNAME}@${SERVER_IP}:${PORT}" -ForegroundColor Yellow
Write-Host ""

# الأوامر التي سيتم تنفيذها
$commands = @"
cd ~/security && \
chmod +x *.sh && \
echo '✓ تم اعطاء صلاحيات التنفيذ' && \
echo '' && \
echo 'هل تريد تشغيل master-setup.sh (تطبيق كل شيء مرة واحدة)؟' && \
echo 'اكتب: sudo bash master-setup.sh' && \
echo '' && \
echo 'أو شغل كل سكريبت على حدة:' && \
echo '  sudo bash ssh-hardening.sh' && \
echo '  sudo bash fail2ban-setup.sh' && \
echo '  sudo bash firewall-setup.sh' && \
echo '  sudo bash nginx-security-setup.sh' && \
echo '  sudo bash auto-updates-setup.sh' && \
echo '  bash security-audit.sh' && \
bash
"@

# الاتصال
ssh -p $PORT "${USERNAME}@${SERVER_IP}" $commands
