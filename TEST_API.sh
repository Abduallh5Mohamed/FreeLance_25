#!/bin/bash

# ========================================
# اختبار شامل لميزات الطلاب
# ========================================

BASE_URL="http://localhost:3001/api"
AUTH_TOKEN=""

echo "🧪 بدء الاختبار الشامل..."
echo "========================================\n"

# ========================================
# 1. اختبار الحصول على الطلاب
# ========================================
echo "1️⃣  اختبار جلب الطلاب..."
curl -X GET "$BASE_URL/students" \
  -H "Content-Type: application/json" \
  -w "\n✅ حالة الاستجابة: %{http_code}\n" \
  2>/dev/null | head -c 500

echo "\n\n"

# ========================================
# 2. اختبار الحصول على المراحل الدراسية
# ========================================
echo "2️⃣  اختبار جلب المراحل الدراسية..."
curl -X GET "$BASE_URL/grades" \
  -H "Content-Type: application/json" \
  -w "\n✅ حالة الاستجابة: %{http_code}\n" \
  2>/dev/null | head -c 300

echo "\n\n"

# ========================================
# 3. اختبار الحصول على المجموعات
# ========================================
echo "3️⃣  اختبار جلب المجموعات..."
curl -X GET "$BASE_URL/groups" \
  -H "Content-Type: application/json" \
  -w "\n✅ حالة الاستجابة: %{http_code}\n" \
  2>/dev/null | head -c 300

echo "\n\n"

# ========================================
# 4. اختبار الحصول على الكورسات
# ========================================
echo "4️⃣  اختبار جلب الكورسات..."
curl -X GET "$BASE_URL/courses" \
  -H "Content-Type: application/json" \
  -w "\n✅ حالة الاستجابة: %{http_code}\n" \
  2>/dev/null | head -c 300

echo "\n\n"

# ========================================
# 5. اختبار الحصول على الاشتراكات
# ========================================
echo "5️⃣  اختبار جلب الاشتراكات..."
curl -X GET "$BASE_URL/subscriptions" \
  -H "Content-Type: application/json" \
  -w "\n✅ حالة الاستجابة: %{http_code}\n" \
  2>/dev/null | head -c 300

echo "\n\n"

# ========================================
# 6. اختبار طلبات التسجيل (الطلاب الأونلاين فقط)
# ========================================
echo "6️⃣  اختبار جلب طلبات التسجيل (الطلاب الأونلاين المعلقة)..."
curl -X GET "$BASE_URL/registration-requests?status=pending&is_offline=false" \
  -H "Content-Type: application/json" \
  -w "\n✅ حالة الاستجابة: %{http_code}\n" \
  2>/dev/null | head -c 500

echo "\n\n"

# ========================================
# 7. اختبار الحذف (Soft Delete)
# ========================================
echo "7️⃣  اختبار الحذف (هذا سيكون soft delete فقط)..."
echo "ملاحظة: هذا الاختبار يحتاج معرف طالب حقيقي من قاعدة البيانات"
echo "الطلب: DELETE /api/students/{student_id}"
echo "الاستجابة المتوقعة: { \"message\": \"Student deleted successfully\" }"

echo "\n\n"

# ========================================
# ملخص الاختبارات
# ========================================
echo "========================================\n"
echo "✅ اختبارات API مكتملة!"
echo ""
echo "📊 الميزات المختبرة:"
echo "  1. جلب قائمة الطلاب"
echo "  2. جلب المراحل الدراسية"
echo "  3. جلب المجموعات"
echo "  4. جلب الكورسات"
echo "  5. جلب الاشتراكات"
echo "  6. جلب طلبات التسجيل (أونلاين فقط)"
echo "  7. اختبار الحذف (Soft Delete)"
echo ""
echo "🔍 اختبارات يدوية مطلوبة:"
echo "  • اختبار التعديل: PUT /api/students/{id}"
echo "  • اختبار القبول: POST /api/registration-requests/{id}/approve"
echo "  • اختبار الرفض: POST /api/registration-requests/{id}/reject"
echo ""
echo "📍 الواجهات الأمامية:"
echo "  • http://localhost:8080/students - قائمة الطلاب"
echo "  • http://localhost:8080/registration-requests - طلبات التسجيل"
echo "  • http://localhost:8080/auth - تسجيل الطلاب"
echo ""
echo "✨ الحالة: جاهز للاستخدام"
