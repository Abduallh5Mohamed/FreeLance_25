# إصلاح شامل للفيديوهات

echo "🔧 جاري إصلاح مشكلة الفيديو..."
echo ""

# 1. Fix MinIO permissions
echo "1️⃣ إصلاح صلاحيات MinIO..."
chmod -R 755 /data/miniochown -R root:root /data/minio
systemctl restart minio
sleep 3
echo "✓ تم"
echo ""

# 2. Test MinIO buckets
echo "2️⃣ فحص MinIO buckets..."
curl -s http://localhost:9000/videos-original/ | head -20
echo ""

# 3. Fix nginx and reload
echo "3️⃣ إعادة تشغيل nginx..."
nginx -t && systemctl reload nginx
echo "✓ تم"
echo ""

# 4. Check one video URL
echo "4️⃣ اختبار فيديو..."
SAMPLE_FILE=$(find /data/minio/videos-original -name "*.mp4" | head -1 | xargs basename)
if [ -n "$SAMPLE_FILE" ]; then
    echo "Testing: $SAMPLE_FILE"
    curl -sI "http://localhost:9000/videos-original/$SAMPLE_FILE" | head -10
    echo ""
    
    # Test with range request
    echo "Testing range request..."
    curl -sI -H "Range: bytes=0-1000" "http://localhost:9000/videos-original/$SAMPLE_FILE" | grep -E "206|200|Content-Range"
fi

echo ""
echo "================================"
echo "✅ الإصلاحات اكتملت"
echo "================================"
echo ""
echo "الآن:"
echo "1. افتح الموقع في Incognito"
echo "2. حاول تشغيل أي فيديو"
echo "3. اضغط F12 → Console"
echo "4. شوف الأخطاء وأرسلها لي"
echo ""
