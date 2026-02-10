# فحص مشاكل الفيديو - Diagnostic Script

echo "🔍 تشخيص مشكلة الفيديو..."
echo "================================"
echo ""

# 1. Check MinIO is running
echo "1️⃣ فحص MinIO (مخزن الفيديو):"
systemctl status minio | grep "Active:" || echo "❌ MinIO غير مشتغل!"
echo ""

# 2. Check if videos exist
echo "2️⃣ فحص ملفات الفيديو:"
if [ -d "/home/minio-user/alqaed-media-bucket" ]; then
    VIDEO_COUNT=$(find /home/minio-user/alqaed-media-bucket -name "*.mp4" -o -name "*.m3u8" 2>/dev/null | wc -l)
    echo "✓ عدد ملفات الفيديو: $VIDEO_COUNT"
    
    # Show sample video
    echo ""
    echo "مثال على ملف فيديو:"
    find /home/minio-user/alqaed-media-bucket -name "*.mp4" 2>/dev/null | head -1 | xargs ls -lh 2>/dev/null
else
    echo "❌ مجلد الفيديوهات غير موجود!"
fi
echo ""

# 3. Check nginx config
echo "3️⃣ فحص nginx video config:"
if grep -q "proxy_force_ranges on" /etc/nginx/sites-available/alqaed; then
    echo "✓ Range requests enabled"
else
    echo "❌ Range requests NOT enabled"
fi

if grep -q "Accept-Ranges.*bytes" /etc/nginx/sites-available/alqaed; then
    echo "✓ Accept-Ranges configured"
else
    echo "❌ Accept-Ranges NOT configured"
fi
echo ""

# 4. Test direct video access
echo "4️⃣ اختبار الوصول المباشر للفيديو:"
# Find a sample video URL
SAMPLE_VIDEO=$(mysql -u root alqaed_db -sse "SELECT video_url FROM lectures WHERE video_url IS NOT NULL AND video_url != '' LIMIT 1" 2>/dev/null)

if [ -n "$SAMPLE_VIDEO" ]; then
    echo "Testing: $SAMPLE_VIDEO"
    
    # Test with range request
    RESPONSE=$(curl -s -I -H "Range: bytes=0-1000" "$SAMPLE_VIDEO" 2>/dev/null | head -20)
    
    if echo "$RESPONSE" | grep -q "206 Partial Content"; then
        echo "✅ Range requests working!"
    elif echo "$RESPONSE" | grep -q "200 OK"; then
        echo "⚠️  Server responds but NO range support"
    else
        echo "❌ Server not responding properly"
        echo "Response:"
        echo "$RESPONSE"
    fi
else
    echo "⚠️  No videos found in database"
fi

echo ""
echo "================================"
echo "5️⃣ الخطوات التالية:"
echo "================================"
echo ""
echo "افتح المتصفح → F12 → Console"
echo "افتح فيديو وشوف الأخطاء"
echo ""
echo "الأخطاء الشائعة:"
echo "  • ERR_CONNECTION_REFUSED → MinIO مش شغال"
echo "  • 403 Forbidden → مشكلة صلاحيات"
echo "  • 404 Not Found → الفيديو مش موجود"
echo "  • CORS error → مشكلة في nginx headers"
echo "  • Network error → مشكلة اتصال"
echo ""
