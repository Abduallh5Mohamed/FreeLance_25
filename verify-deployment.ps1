# Deployment Verification Script
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  التحقق من نشر الفيديو السريع" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

$server = "root@72.62.35.177"

Write-Host "1. فحص حالة nginx..." -ForegroundColor Yellow
$nginxStatus = ssh $server 'systemctl is-active nginx'
if ($nginxStatus -eq "active") {
    Write-Host "   ✅ nginx يعمل" -ForegroundColor Green
} else {
    Write-Host "   ❌ nginx لا يعمل!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "2. فحص ملف index-1770300823502.js على السيرفر..." -ForegroundColor Yellow
$fileCheck = ssh $server 'ls -lh /var/www/alqaed/dist/assets/index-1770300823502.js 2>/dev/null'
if ($fileCheck) {
    Write-Host "   ✅ الملف موجود على السيرفر" -ForegroundColor Green
    Write-Host "   $fileCheck" -ForegroundColor Gray
} else {
    Write-Host "   ❌ الملف غير موجود!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "3. فحص الموقع المباشر يرجع النسخة الصحيحة..." -ForegroundColor Yellow
$liveVersion = ssh $server 'curl -s https://elka2d.cloud/index.html | grep -o "index-[0-9]*\.js"'
if ($liveVersion -eq "index-1770300823502.js") {
    Write-Host "   ✅ الموقع المباشر يرجع: $liveVersion" -ForegroundColor Green
} else {
    Write-Host "   ❌ الموقع يرجع نسخة خاطئة: $liveVersion" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "4. فحص الملف يحتوي على Version Checker..." -ForegroundColor Yellow
$versionCheckerCount = ssh $server 'bash -c "curl -s https://elka2d.cloud/assets/index-1770300823502.js | grep -c startVersionCheck || echo 0"'
if ([int]$versionCheckerCount -gt 0) {
    Write-Host "   ✅ Version Checker موجود في الكود (وجد $versionCheckerCount مرة)" -ForegroundColor Green
} else {
    Write-Host "   ❌ Version Checker غير موجود!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "5. فحص الفيديو يدعم Progressive Streaming..." -ForegroundColor Yellow
$videoHeaders = ssh $server 'curl -s -I -H "Range: bytes=0-1023" "https://elka2d.cloud/storage/videos-original/originals/9c6743d8-6ba7-4e06-ba74-f501c4a931c9.mp4" | grep -E "(HTTP|206|accept-ranges)"'
if ($videoHeaders -match "206" -and $videoHeaders -match "accept-ranges") {
    Write-Host "   ✅ الفيديو يدعم Range Requests (HTTP 206)" -ForegroundColor Green
    Write-Host "   $($videoHeaders -split "`n" | Select-Object -First 2)" -ForegroundColor Gray
} else {
    Write-Host "   ❌ الفيديو لا يدعم Range Requests!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "  ✅ كل الفحوصات نجحت!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "الآن:" -ForegroundColor Yellow
Write-Host "1. افتح الموقع: https://elka2d.cloud" -ForegroundColor White
Write-Host "2. اضغط Ctrl+Shift+F5 لمسح الكاش" -ForegroundColor White
Write-Host "3. جرب تشغيل أي فيديو" -ForegroundColor White
Write-Host "4. يجب أن يبدأ خلال 1-2 ثانية فقط!" -ForegroundColor White
Write-Host ""
Write-Host "ملحوظة: Version Checker سيشتغل تلقائياً بعد 60 ثانية" -ForegroundColor Cyan
Write-Host "         ويعمل Reload تلقائي للمستخدمين القدامى" -ForegroundColor Cyan
