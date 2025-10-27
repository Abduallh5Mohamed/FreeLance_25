# سكريبت PowerShell للبحث عن استخدامات Supabase في المشروع

Write-Host "🔍 البحث عن استخدامات Supabase في المشروع..." -ForegroundColor Cyan
Write-Host ""

# البحث عن جميع الملفات التي تستورد Supabase
Write-Host "📁 الملفات التي تستورد Supabase:" -ForegroundColor Yellow
Write-Host "=" * 60

$supabaseFiles = Get-ChildItem -Path src -Include *.tsx, *.ts -Recurse | 
Select-String -Pattern "from.*supabase|import.*supabase" | 
Select-Object -ExpandProperty Path -Unique

if ($supabaseFiles) {
    $supabaseFiles | ForEach-Object {
        Write-Host "  ✓ $_" -ForegroundColor Green
    }
    Write-Host ""
    Write-Host "إجمالي الملفات: $($supabaseFiles.Count)" -ForegroundColor Cyan
}
else {
    Write-Host "  لم يتم العثور على ملفات" -ForegroundColor Red
}

Write-Host ""
Write-Host "=" * 60
Write-Host ""

# البحث عن استخدامات محددة
Write-Host "🔎 استخدامات محددة:" -ForegroundColor Yellow
Write-Host ""

# Auth usage
Write-Host "1️⃣  استخدامات supabase.auth:" -ForegroundColor Magenta
$authUsage = Get-ChildItem -Path src -Include *.tsx, *.ts -Recurse | 
Select-String -Pattern "supabase\.auth" | 
Select-Object Path, LineNumber, Line

if ($authUsage) {
    $authUsage | ForEach-Object {
        $file = Split-Path $_.Path -Leaf
        Write-Host "   📄 $file (السطر $($_.LineNumber))" -ForegroundColor White
        Write-Host "      $($_.Line.Trim())" -ForegroundColor Gray
        Write-Host ""
    }
}
else {
    Write-Host "   لم يتم العثور على استخدامات" -ForegroundColor Gray
}

# .from() usage
Write-Host "2️⃣  استخدامات supabase.from():" -ForegroundColor Magenta
$fromUsage = Get-ChildItem -Path src -Include *.tsx, *.ts -Recurse | 
Select-String -Pattern "supabase\.from\(" | 
Select-Object Path, LineNumber, Line

if ($fromUsage) {
    $fromUsage | ForEach-Object {
        $file = Split-Path $_.Path -Leaf
        Write-Host "   📄 $file (السطر $($_.LineNumber))" -ForegroundColor White
        Write-Host "      $($_.Line.Trim())" -ForegroundColor Gray
        Write-Host ""
    }
}
else {
    Write-Host "   لم يتم العثور على استخدامات" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=" * 60
Write-Host ""

# إحصائيات
Write-Host "📊 إحصائيات الاستخدام:" -ForegroundColor Yellow
$totalAuth = ($authUsage | Measure-Object).Count
$totalFrom = ($fromUsage | Measure-Object).Count
$totalFiles = ($supabaseFiles | Measure-Object).Count

Write-Host "  • عدد الملفات المستخدمة: $totalFiles" -ForegroundColor Cyan
Write-Host "  • استخدامات supabase.auth: $totalAuth" -ForegroundColor Cyan
Write-Host "  • استخدامات supabase.from(): $totalFrom" -ForegroundColor Cyan
Write-Host "  • إجمالي الاستخدامات: $($totalAuth + $totalFrom)" -ForegroundColor Cyan

Write-Host ""
Write-Host "=" * 60
Write-Host ""

# الخطوات التالية
Write-Host "📝 الخطوات التالية:" -ForegroundColor Green
Write-Host "  1. راجع الملفات المذكورة أعلاه" -ForegroundColor White
Write-Host "  2. استبدل استخدامات supabase.auth بـ functions من @/lib/api" -ForegroundColor White
Write-Host "  3. استبدل استخدامات supabase.from() بـ استدعاءات db أو API functions" -ForegroundColor White
Write-Host "  4. راجع database/QUICK_MIGRATION_GUIDE.md للتفاصيل" -ForegroundColor White
Write-Host ""

# حفظ النتائج في ملف
$outputFile = "supabase-usage-report.txt"
"تقرير استخدامات Supabase في المشروع" | Out-File $outputFile
"=" * 60 | Out-File $outputFile -Append
"تاريخ: $(Get-Date)" | Out-File $outputFile -Append
"" | Out-File $outputFile -Append
"الملفات المستخدمة:" | Out-File $outputFile -Append
$supabaseFiles | Out-File $outputFile -Append
"" | Out-File $outputFile -Append
"استخدامات supabase.auth:" | Out-File $outputFile -Append
$authUsage | Out-File $outputFile -Append
"" | Out-File $outputFile -Append
"استخدامات supabase.from():" | Out-File $outputFile -Append
$fromUsage | Out-File $outputFile -Append

Write-Host "💾 تم حفظ التقرير في: $outputFile" -ForegroundColor Green
Write-Host ""
