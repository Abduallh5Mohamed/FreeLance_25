#!/bin/bash

echo "🔍 Checking Notifications System..."
echo "===================================="
echo ""

# 1. Check if message tables exist
echo "1️⃣ Checking database tables..."
mysql -u root alqaed_db -e "SHOW TABLES LIKE '%message%';" 2>/dev/null || echo "❌ Database error"
echo ""

# 2. Check conversations table
echo "2️⃣ Checking conversations table..."
mysql -u root alqaed_db -e "SELECT COUNT(*) as total_conversations FROM conversations;" 2>/dev/null
echo ""

# 3. Check unread counts
echo "3️⃣ Checking unread message counts..."
mysql -u root alqaed_db -e "
SELECT 
    user_id,
    (SELECT name FROM users WHERE id = user_id) as user_name,
    (SELECT role FROM users WHERE id = user_id) as role,
    SUM(unread) as total_unread
FROM (
    SELECT user1_id as user_id, unread_count_user1 as unread FROM conversations WHERE unread_count_user1 > 0
    UNION ALL
    SELECT user2_id as user_id, unread_count_user2 as unread FROM conversations WHERE unread_count_user2 > 0
) as combined
GROUP BY user_id
ORDER BY total_unread DESC
LIMIT 10;
" 2>/dev/null
echo ""

# 4. Check messages table
echo "4️⃣ Checking messages..."
mysql -u root alqaed_db -e "
SELECT 
    COUNT(*) as total_messages,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL 1 DAY THEN 1 END) as last_24h
FROM messages;
" 2>/dev/null
echo ""

# 5. Check message_status table
echo "5️⃣ Checking message statuses..."
mysql -u root alqaed_db -e "
SELECT 
    COUNT(*) as total_status,
    SUM(is_read = 0) as unread_count,
    SUM(is_read = 1) as read_count
FROM message_status;
" 2>/dev/null
echo ""

# 6. Test API endpoint
echo "6️⃣ Testing API endpoint..."
echo "Testing: http://localhost:3001/api/messages/unread-total"
curl -s http://localhost:3001/health 2>/dev/null | head -5 || echo "❌ Backend not responding"
echo ""

# 7. Check backend process
echo "7️⃣ Checking backend process..."
ps aux | grep -E "node.*server|pm2" | grep -v grep | head -3
echo ""

echo "===================================="
echo "✅ Diagnostic Complete"
echo "===================================="
echo ""
echo "Next steps:"
echo "1. Check console errors in browser (F12)"
echo "2. Look for CORS or 401/403 errors"
echo "3. Verify authToken in localStorage"
echo ""
