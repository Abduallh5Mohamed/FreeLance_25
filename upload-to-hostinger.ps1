# سكريبت رفع الملفات إلى Hostinger
# تأكد من تعديل بيانات الاتصال أدناه

# ========================
# بيانات الاتصال
# ========================
$HOSTINGER_IP = "91.98.133.193"  # أو اسم النطاق
$HOSTINGER_USER = "root"  # أو اسم المستخدم من Hostinger
$HOSTINGER_PATH = "/public_html"  # المسار على Hostinger

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   رفع الملفات إلى Hostinger" -ForegroundColor Yellow
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# التأكد من وجود المجلد
if (-not (Test-Path "a:\FreeLance_25-1\hostinger-upload\public_html")) {
    Write-Host "❌ مجلد public_html غير موجود!" -ForegroundColor Red
    exit 1
}

Write-Host "📦 جاري رفع الملفات..." -ForegroundColor Green
Write-Host ""

# رفع الملفات عبر SCP
Write-Host "🚀 استخدم الأمر التالي لرفع الملفات:" -ForegroundColor Yellow
Write-Host ""
Write-Host "scp -r a:\FreeLance_25-1\hostinger-upload\public_html\* $HOSTINGER_USER@${HOSTINGER_IP}:$HOSTINGER_PATH/" -ForegroundColor Cyan
Write-Host ""

# أو استخدم FTP
Write-Host "💡 أو استخدم FileZilla:" -ForegroundColor Yellow
Write-Host "   1. افتح FileZilla" -ForegroundColor White
Write-Host "   2. Host: $HOSTINGER_IP" -ForegroundColor White
Write-Host "   3. Username: $HOSTINGER_USER" -ForegroundColor White
Write-Host "   4. Password: كلمة المرور من Hostinger" -ForegroundColor White
Write-Host "   5. Port: 21 (FTP) أو 22 (SFTP)" -ForegroundColor White
Write-Host "   6. ارفع محتويات: a:\FreeLance_25-1\hostinger-upload\public_html\" -ForegroundColor White
Write-Host "   7. إلى: $HOSTINGER_PATH" -ForegroundColor White
Write-Host ""

Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# سؤال المستخدم
$answer = Read-Host "هل تريد محاولة الرفع الآن عبر SCP؟ (y/n)"

if ($answer -eq "y" -or $answer -eq "Y") {
    Write-Host ""
    Write-Host "🔐 أدخل كلمة المرور عند الطلب..." -ForegroundColor Yellow
    Write-Host ""
    
    & scp -r "a:\FreeLance_25-1\hostinger-upload\public_html\*" "${HOSTINGER_USER}@${HOSTINGER_IP}:${HOSTINGER_PATH}/"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✅ تم رفع الملفات بنجاح!" -ForegroundColor Green
        Write-Host ""
        Write-Host "🌐 افتح الموقع الآن: https://alqaed.net" -ForegroundColor Cyan
    } else {
        Write-Host ""
        Write-Host "❌ فشل الرفع! استخدم FileZilla بدلاً من ذلك" -ForegroundColor Red
    }
} else {
    Write-Host ""
    Write-Host "👍 حسناً، استخدم FileZilla لرفع الملفات يدوياً" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
